#!/usr/bin/env node
/** provene — portable, signed evidence receipts for AI-generated code changes. */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workingTreeEntries, committedEntries, mergeBase, repoRoot, headCommit, rootCommit, git } from "./git.ts";
import { append, read, journalDir, recordError, markEmitted, orphanedSessions, journalInsideRepo } from "./journal.ts";
import { deriveSalt, keyedDigest, redactCommand, ALLOWLIST_ID, TEST_SHAPES } from "./redact.ts";
import { buildT0, canonicalJson, checkStatement, receiptFileName, type Statement } from "./receipt.ts";
import { changeDigest, canonicalPayload } from "./changedigest.ts";
import { runCheck, annotations, summary } from "./check.ts";
import { buildAggregate, AGGREGATE_PREDICATE_TYPE } from "./promote.ts";
import { writeManifest, ghVerify, checkAggregate, decideVerification } from "./attestation.ts";
import { readStdin, parsePayload, toJournalEntries } from "./hookinput.ts";
import {
  userSettingsPath, readSettings, withProveneHooks, writeSettings,
  proveneHooksInstalled, RECORD_COMMAND, EMIT_COMMAND,
} from "./settings.ts";
import { createRequire } from "node:module";

// Read the real version rather than restating it. A hardcoded constant drifts
// from package.json the moment either is bumped, and a provenance tool that
// misreports its own version has no business recording anyone else's.
// Resolves to the package root from both dist/cli.js and src/cli.ts.
const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
const out = (s: string): void => { process.stdout.write(s + "\n"); };

function cmdEmit(args: Record<string, string | boolean>): number {
  let sessionId = String(args["session"] ?? process.env["PROVENE_SESSION_ID"] ?? "");
  let hookCwd: string | undefined;
  let hookTool: string | undefined;
  if (args["stdin"] === true) {
    const payload = parsePayload(readStdin());
    if (payload?.session_id !== undefined) sessionId = payload.session_id;
    if (payload?.cwd !== undefined) hookCwd = payload.cwd;
    // The payload arrived through a Claude Code hook, so the agent is known even
    // though the payload never names it. Without this every hook-emitted receipt
    // would record agent.tool as "unknown", which is the one thing a receipt
    // exists to say.
    if (payload?.hook_event_name !== undefined) hookTool = "claude-code";
  }
  if (sessionId === "") { out("provene emit: --session is required"); return 2; }
  try {
    if (hookCwd !== undefined) process.chdir(hookCwd);
    const root = repoRoot();
    if (journalInsideRepo(root)) {
      out(`provene: refusing to emit — the journal is inside this repository (${journalDir()}).`);
      out("  It holds unredacted commands, including any secrets passed on a command line,");
      out("  and emitting would record it as a changed file. Set PROVENE_HOME outside the repo.");
      return 1;
    }
    // Resolve to a commit id. A receipt that records "HEAD" as its parent
    // records nothing: HEAD moves, and the binding must name a fixed commit.
    const base = git(["rev-parse", String(args["base"] ?? "HEAD")], root);
    const entries = workingTreeEntries(base, root);
    if (entries.length === 0) { out("provene: no changes to attest"); return 0; }

    const salt = deriveSalt(rootCommit());
    const journal = read(sessionId);
    const commands = journal
      .filter((e) => e.kind === "command" && e.argv !== undefined)
      .map((e) => redactCommand(e.argv!, salt, {
        ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
        ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
        observedBy: "local",
      }))
      // A line that was only environment assignments named no command. The
      // schema requires a non-empty argv0 and there is nothing to record.
      .filter((c) => c.argv0 !== "");
    // A test command the hook observed becomes a verification run -- observed
    // LOCALLY, which under our own tiering satisfies no policy (RFC 0002 7.3
    // requires observedBy: ci). Recording it anyway is the difference between a
    // receipt that says what it saw and one that says nothing at all.
    const runs = commands.flatMap((c, i) =>
      c.shape !== undefined && TEST_SHAPES.has(c.shape) && c.exitCode !== undefined
        ? [{
            id: `local-${i}`,
            kind: "test" as const,
            tool: c.argv0,
            result: (c.exitCode === 0 ? "PASSED" : "FAILED") as "PASSED" | "FAILED",
            observedBy: "local" as const,
          }]
        : []);

    const attributedPaths = [...new Set(
      journal.filter((e) => e.kind === "edit" && e.path !== undefined).map((e) => e.path!),
    )];
    const task = args["task"] !== undefined
      ? { ref: String(args["task"]), digest: keyedDigest(salt, String(args["task"])) }
      : undefined;

    const statement = buildT0({
      subjectName: `${args["subject"] ?? "workspace"}`,
      entries, parent: base,
      agent: {
        tool: String(args["tool"] ?? hookTool ?? "unknown"),
        // The hook payload does not carry the model, and we do not guess:
        // modelSource is only meaningful when a model is actually recorded.
        ...(args["model"] !== undefined
          ? { model: String(args["model"]), modelSource: "reported" as const }
          : {}),
      },
      ...(task !== undefined ? { task } : {}),
      emitter: { name: "provene", version: VERSION },
      session: { id: sessionId, startedAt: journal[0]?.at ?? new Date().toISOString(),
                 endedAt: new Date().toISOString(), toolCalls: journal.length },
      commands, runs, attributedPaths,
    });
    (statement.predicate as Record<string, unknown>)["redaction"] =
      { pathsExcluded: false, allowlistId: ALLOWLIST_ID };

    const rel = receiptFileName(statement, false);
    mkdirSync(join(root, ".provene"), { recursive: true });
    writeFileSync(join(root, rel), canonicalJson(statement), "utf8");
    markEmitted(sessionId, changeDigest(entries));
    out(`provene: wrote ${rel}`);
    out(`  tier T0 (unsigned) · ${entries.length} paths · change ${changeDigest(entries).slice(0, 12)}`);
    const unverified = (statement.predicate as any).verification.unverifiedPaths as string[];
    if (runs.length > 0) {
      const passed = runs.filter((r) => r.result === "PASSED").length;
      out(`  ${runs.length} local test run(s) observed, ${passed} passed ` +
          `(observedBy: local — satisfies no policy on its own)`);
    }
    if (unverified.length > 0) out(`  ${unverified.length} path(s) with no verification evidence`);
    return 0;
  } catch (err) {
    // Fail closed toward evidence, open toward the developer.
    recordError(sessionId, err instanceof Error ? err.message : String(err));
    out(`provene: could not emit a receipt (${err instanceof Error ? err.message : err}).`);
    out("provene: no receipt was written; a wrong receipt is worse than none. Run `provene doctor`.");
    return 0;
  }
}

function cmdVerify(args: Record<string, string | boolean>): number {
  const file = String(args["_0"] ?? "");
  if (file === "") { out("usage: provene verify <receipt.json> [--against <commit>]"); return 2; }
  const statement = JSON.parse(readFileSync(file, "utf8")) as Statement;
  // Resolve the ref before comparing: binding.parent holds a commit id, so
  // comparing it against the literal string "HEAD" reported every receipt as
  // rebased.
  const against = args["against"] !== undefined
    ? (() => {
        const ref = String(args["against"]);
        const sha = git(["rev-parse", ref]);
        return { entries: workingTreeEntries(sha), parent: sha };
      })()
    : undefined;
  // The filename declares the encoding (RFC 0001 8), so verify must consult it
  // too -- otherwise a signed receipt would be reported as unsigned here while
  // `check` reported it correctly.
  const r = checkStatement(statement, against, file.endsWith(".dsse.json"));
  if (r.ok) {
    const a = r.assurance;
    const shown = a.kind === "signed" ? a.tier
      : a.declared === "T0" || a.declared === "unknown" ? "T0"
      : `T0 (unsigned; the document claims ${a.declared})`;
    out(`provene: receipt is well formed · ${shown}`);
    if (r.rebased) out("  note: change content matches but the parent differs — rebased");
    if (a.kind === "unsigned" || a.tier === "T0" || a.tier === "T1") {
      out("  this receipt is a self-attestation and satisfies no policy on its own");
    }
    return 0;
  }
  out("provene: receipt failed verification");
  for (const p of r.problems) out(`  - ${p}`);
  return 1;
}

/**
 * What a range means.
 *
 * `base..head` is resolved to `merge-base(base, head)..head` — the three-dot
 * diff, which is what a reviewer sees on the pull request page. A two-dot diff
 * against a base branch that has moved on reports the base branch's own newer
 * commits as deletions performed by the branch under review, and would sign a
 * digest saying so.
 *
 * Where git cannot compute a merge base — a shallow clone is the usual reason,
 * and this action fetches the base with --depth=1 — the given base is used and
 * the caller is told, because silently signing the two-dot answer is how a
 * verifier ends up unable to reproduce a digest and unable to say why.
 */
function resolveRange(root: string, baseRef: string, headRef: string):
  { base: string; head: string; fellBack: boolean } {
  const head = git(["rev-parse", headRef], root);
  const given = git(["rev-parse", baseRef], root);
  const mb = mergeBase(given, head, root);
  return { base: mb ?? given, head, fellBack: mb === undefined };
}

const rangeNote = (r: { fellBack: boolean }): string[] =>
  r.fellBack
    ? ["  note: no merge base could be computed (a shallow clone cannot), so this is a",
       "        two-dot diff against the base you gave. If the base branch has advanced,",
       "        its own commits will appear here as changes."]
    : [];

function cmdCheck(args: Record<string, string | boolean>): number {
  let root: string;
  try { root = repoRoot(); } catch { out("provene check: not inside a git repository"); return 2; }

  const baseRef = String(args["base"] ?? "HEAD");
  let range: { base: string; head: string; fellBack: boolean };
  try { range = resolveRange(root, baseRef, String(args["head"] ?? "HEAD")); }
  catch { out(`provene check: cannot resolve ${baseRef}`); return 2; }
  const base = range.base;

  const result = runCheck({
    root, base, head: range.head,
    ...(args["coverage"] !== undefined ? { lcovPath: String(args["coverage"]) } : {}),
    ...(args["exclude"] !== undefined ? { exclude: String(args["exclude"]).split(",") } : {}),
  });

  if (args["format"] === "json") {
    out(JSON.stringify(result, null, 2));
  } else {
    for (const line of summary(result)) out(line);
    for (const line of rangeNote(range)) out(line);
  }

  if (args["annotate"] === "github") {
    for (const a of annotations(result)) out(a);
  }

  // A malformed receipt always fails: a forgeable receipt is worse than none
  // (RFC 0002 section 9, receipt-integrity). Missing evidence is reported, not
  // failed -- that judgement belongs to a policy, which is a separate command.
  // Only receipts THIS change introduced can fail the check. A malformed
  // receipt committed months ago is worth reporting -- and is reported, in the
  // summary -- but failing every future pull request over it would break CI
  // permanently for work that did not touch it.
  const broken = result.receipts.filter((r) => !r.ok && r.inRange).length;
  const historical = result.receipts.filter((r) => !r.ok && !r.inRange).length;
  if (historical > 0) {
    out(`\n${historical} pre-existing receipt(s) fail verification; not caused by this change.`);
  }
  if (broken > 0) { out(`\n${broken} receipt(s) introduced by this change failed verification.`); return 1; }
  return 0;
}

function cmdPromote(args: Record<string, string | boolean>): number {
  let root: string;
  try { root = repoRoot(); } catch { out("provene promote: not inside a git repository"); return 2; }

  const range = resolveRange(root, String(args["base"] ?? "HEAD"), String(args["head"] ?? "HEAD"));
  const base = range.base;
  const head = range.head;

  const identity = String(args["attester"] ?? process.env["GITHUB_WORKFLOW_REF"] ?? "");
  if (identity === "") {
    out("provene promote: --attester is required (the CI identity that will sign this)");
    return 2;
  }

  const result = args["coverage"] !== undefined
    ? runCheck({ root, base, head, lcovPath: String(args["coverage"]) })
    : undefined;
  const unverified = result?.evidence
    .filter((e) => e.kind === "untested" || (e.kind === "instrumented" && e.covered < e.changed))
    .map((e) => e.path) ?? [];

  const runs = args["test-result"] !== undefined
    ? [{
        id: "ci-test",
        kind: "test" as const,
        ...(args["test-tool"] !== undefined ? { tool: String(args["test-tool"]) } : {}),
        result: String(args["test-result"]).toUpperCase() as "PASSED" | "WARNED" | "FAILED",
        ...(args["run-url"] !== undefined ? { url: String(args["run-url"]) } : {}),
      }]
    : [];

  const outPath = args["out"] !== undefined ? String(args["out"]) : undefined;

  const { predicate, subjectDigest } = buildAggregate({
    root, base, head,
    emitterVersion: VERSION,
    attester: {
      identity,
      ...(args["issuer"] !== undefined ? { issuer: String(args["issuer"]) } : {}),
    },
    // Only a public repository publishes to the public transparency log; a
    // private one must not, because the log carries the signer's identity.
    publishesToLog: args["public"] === true || args["public"] === "true",
    ...(args["pull-request"] !== undefined
      ? { merge: { kind: "pull-request" as const, pullRequest: String(args["pull-request"]),
                   ...(args["target-ref"] !== undefined ? { targetRef: String(args["target-ref"]) } : {}) } }
      : {}),
    runs, unverifiedPaths: unverified,
  });

  // The canonical pre-image of the change digest, written as a file so that
  // stock Sigstore tooling can address the attestation at all: `gh attestation
  // verify` takes an artefact and hashes it, and our subject is a change set
  // rather than any file in the tree. sha256(manifest) IS the subject digest.
  const manifestPath = args["manifest"] !== undefined
    ? String(args["manifest"])
    : outPath !== undefined ? `${outPath}.changeset` : undefined;
  if (manifestPath !== undefined) writeManifest(manifestPath, committedEntries(base, head, root));

  const body = JSON.stringify(predicate, null, 2) + "\n";
  if (outPath !== undefined) {
    writeFileSync(outPath, body, "utf8");
    out(`provene: wrote aggregate predicate to ${outPath}`);
    out(`  predicate-type ${AGGREGATE_PREDICATE_TYPE}`);
    out(`  subject-digest sha256:${subjectDigest}`);
    for (const line of rangeNote(range)) out(line);
    if (manifestPath !== undefined) out(`  changeset manifest ${manifestPath} (sha256 = the subject digest)`);
    const c = (predicate as any).coverage;
    out(`  ${c.constituentsFound} constituent receipt(s) over ${c.commitsInRange} commit(s)` +
        `${c.complete ? "" : " — coverage incomplete, recorded as such"}`);
    // Consumed by the workflow, which passes them to the signing action.
    const ghOut = process.env["GITHUB_OUTPUT"];
    if (ghOut !== undefined) {
      writeFileSync(ghOut,
        `predicate-type=${AGGREGATE_PREDICATE_TYPE}\nsubject-digest=sha256:${subjectDigest}\n` +
        `predicate-path=${outPath}\nmanifest-path=${manifestPath ?? ""}\n`,
        { flag: "a" });
    }
  } else {
    process.stdout.write(body);
  }
  return 0;
}

function cmdManifest(args: Record<string, string | boolean>): number {
  let root: string;
  try { root = repoRoot(); } catch { out("provene manifest: not inside a git repository"); return 2; }
  const range = resolveRange(root, String(args["base"] ?? "HEAD"), String(args["head"] ?? "HEAD"));
  // Committed state only. The manifest exists so a third party can reproduce
  // what was signed from a checkout; uncommitted work is by definition not in
  // any checkout they can obtain.
  const entries = committedEntries(range.base, range.head, root);
  const digest = changeDigest(entries);
  const outPath = args["out"] !== undefined ? String(args["out"]) : undefined;
  if (outPath === undefined) {
    // No trailing newline on stdout either: the bytes are the point.
    process.stdout.write(canonicalPayload(entries));
    return 0;
  }
  writeManifest(outPath, entries);
  out(`provene: wrote ${outPath}`);
  out(`  sha256 ${digest}`);
  out("  this is the change digest — the same bytes any checkout of this range reproduces");
  for (const line of rangeNote(range)) out(line);
  return 0;
}

/**
 * Verify the signed T2 aggregate covering a range.
 *
 * Provene does not check signatures. `gh attestation verify` does, and its exit
 * code is the trust boundary; what happens here afterwards is the half gh
 * cannot do — deciding whether the thing that was signed is the work in front
 * of you.
 */
function cmdVerifyAggregate(args: Record<string, string | boolean>): number {
  let root: string;
  try { root = repoRoot(); } catch { out("provene verify-aggregate: not inside a git repository"); return 2; }

  const repo = String(args["repo"] ?? process.env["GITHUB_REPOSITORY"] ?? "");
  if (repo === "") {
    out("provene verify-aggregate: --repo <owner/name> is required");
    out("  the attestation lives in that repository's store, not in the working tree");
    return 2;
  }

  let range: { base: string; head: string; fellBack: boolean };
  try { range = resolveRange(root, String(args["base"] ?? "HEAD"), String(args["head"] ?? "HEAD")); }
  catch { out(`provene verify-aggregate: cannot resolve ${String(args["base"] ?? "HEAD")}`); return 2; }
  const base = range.base;

  const entries = committedEntries(base, range.head, root);
  const subjectDigest = changeDigest(entries);
  const manifestPath = join(mkdtempSync(join(tmpdir(), "provene-")), "changeset");
  writeManifest(manifestPath, entries);

  const gh = ghVerify({
    manifestPath, repo,
    predicateType: AGGREGATE_PREDICATE_TYPE,
    ...(args["bundle"] !== undefined ? { bundlePath: String(args["bundle"]) } : {}),
    ...(args["cert-identity"] !== undefined ? { certIdentity: String(args["cert-identity"]) } : {}),
    ...(args["signer-workflow"] !== undefined ? { signerWorkflow: String(args["signer-workflow"]) } : {}),
    cwd: root,
  });

  const commits = (() => {
    try { return git(["rev-list", `${base}..${range.head}`], root).split("\n").filter((l) => l !== "").length; }
    catch { return undefined; }
  })();

  const checks = gh.statements.map((statement) => checkAggregate(statement, {
    subjectDigest, base,
    signerIdentities: gh.signers,
    ...(commits !== undefined ? { commitsInRange: commits } : {}),
  }));

  // The verdict is computed as data, in one place, before anything is printed.
  // Deciding inline while printing is what produced a branch whose text said
  // "the predicate's own claims were NOT checked" above a `return 0`.
  const outcome = decideVerification(gh, checks);

  switch (outcome.kind) {
    case "no-verifier":
      out("provene: could not verify — no verifier available");
      out(`  ${gh.message}`);
      break;

    case "no-attestation":
      // Absence of evidence, not evidence of forgery.
      out(`provene: no attestation covers this change set (sha256:${subjectDigest.slice(0, 12)})`);
      out("  nothing has been signed for it, or this repository's attestations are not visible to you.");
      out("  A private repository on a free plan cannot store one at all: GitHub's attestation");
      out("  store is free for public repositories and a paid feature otherwise.");
      break;

    case "signature-invalid":
      out("provene: the signature did not verify");
      for (const line of gh.message.split("\n")) if (line.trim() !== "") out(`  ${line.trim()}`);
      out(`  change digest here: sha256:${subjectDigest}`);
      break;

    case "unreadable":
      out("provene: could not verify — the verifier accepted the signature and this");
      out("  version could not read back what was signed, so nothing has been checked");
      out("  against your repository. With --bundle the verifier does not compare the");
      out("  subject digest at all, so a valid signature over an unrelated change set");
      out("  reaches exactly this branch. Treated as unchecked, not as a pass.");
      break;

    case "not-this-change":
      out("provene: the signature is valid, but what it signed is not this change");
      for (const c of checks) for (const p of c.problems) out(`  - ${p}`);
      break;

    case "verified":
      for (const c of checks) {
        out(`provene: verified ${c.tier} aggregate · sha256:${subjectDigest.slice(0, 12)} · ${repo}`);
        for (const id of gh.identities) out(`  signer ${id}`);
        for (const n of c.notes) out(`  note: ${n}`);
      }
      // gh accepts an attestation signed by ANY workflow in the repository.
      // A repository that runs an experimental or pull-request-triggered
      // workflow with id-token: write therefore has more signers than its
      // maintainers usually think, and the identity above is the only thing
      // distinguishing them.
      if (args["signer-workflow"] === undefined && args["cert-identity"] === undefined) {
        out("  warning: any workflow in this repository was accepted as a signer.");
        out("           Pass --signer-workflow to require a specific one.");
      }
      break;
  }
  for (const line of rangeNote(range)) out(line);
  return outcome.code;
}

function cmdDoctor(): number {
  // Three states, not two. A checkup that reports FAIL for a normal condition
  // is a checkup people stop running -- the same reason a merge gate with a
  // high false-positive rate gets switched off.
  type Status = "ok" | "warn" | "fail";
  const checks: Array<[Status, string, string]> = [];
  let root = "";

  try {
    root = repoRoot();
    checks.push(["ok", "git repository", root]);
  } catch {
    checks.push(["fail", "git repository", "not inside a git repository"]);
  }

  try {
    checks.push(["ok", "root commit reachable", rootCommit().slice(0, 12)]);
  } catch {
    checks.push(["fail", "root commit reachable", "no root commit — commit something first"]);
  }

  // The journal is created on first use, so absence is normal on a fresh
  // install. What actually matters is whether we can write there when the
  // time comes.
  const jdir = journalDir();
  if (root !== "" && journalInsideRepo(root)) {
    checks.push(["fail", "journal directory",
      `${jdir} is inside this repository; it holds unredacted commands and must not be committed`]);
  } else if (existsSync(jdir)) {
    try {
      const probe = join(jdir, ".provene-write-probe");
      writeFileSync(probe, "", "utf8");
      rmSync(probe);
      checks.push(["ok", "journal directory", jdir]);
    } catch {
      checks.push(["fail", "journal directory", `${jdir} exists but is not writable`]);
    }
  } else {
    try {
      mkdirSync(jdir, { recursive: true });
      rmSync(jdir, { recursive: true });
      checks.push(["ok", "journal directory", `${jdir} (created on first session)`]);
    } catch {
      checks.push(["fail", "journal directory", `cannot create ${jdir}`]);
    }
  }

  // Cosmetic: without it receipts still work, they just clutter review.
  const attrs = root !== "" ? join(root, ".gitattributes") : "";
  const hasAttrs = attrs !== "" && existsSync(attrs) && readFileSync(attrs, "utf8").includes(".provene/");
  checks.push(hasAttrs
    ? ["ok", ".gitattributes stanza", "receipts collapse in review"]
    : ["warn", ".gitattributes stanza", "add: .provene/** linguist-generated=true -diff"]);

  // Is the hook actually wired up? doctor exists to answer this: a repository
  // that believes it has coverage and does not is the worst outcome available.
  const sPath = userSettingsPath();
  try {
    const installed = proveneHooksInstalled(readSettings(sPath));
    if (installed.record && installed.emit) {
      checks.push(["ok", "hooks installed", sPath]);
    } else if (!installed.record && !installed.emit) {
      checks.push(["warn", "hooks installed", `not found in ${sPath} — run \`provene init\``]);
    } else {
      checks.push(["fail", "hooks installed",
        `only ${installed.record ? "PostToolUse" : "SessionEnd"} is wired — receipts will be incomplete`]);
    }
  } catch (err) {
    checks.push(["fail", "hooks installed", err instanceof Error ? err.message : String(err)]);
  }

  // A journal with no emitted-marker beside it is a session that ended without
  // producing a receipt. Recoverable, but only if someone is told.
  const orphans = orphanedSessions();
  if (orphans.length > 0) {
    const shown = orphans.slice(0, 3).join(", ");
    checks.push(["warn", "unemitted sessions",
      `${orphans.length} journal(s) never produced a receipt: ${shown}${orphans.length > 3 ? ", …" : ""}`]);
  }

  try {
    checks.push(["ok", "git version", git(["--version"])]);
  } catch { /* the repository check already covers a missing git */ }

  const mark = { ok: "  ok  ", warn: " warn ", fail: " FAIL " } as const;
  for (const [status, name, detail] of checks) {
    out(`${mark[status]} ${name.padEnd(26)} ${detail}`);
  }

  const failed = checks.filter(([s]) => s === "fail").length;
  const warned = checks.filter(([s]) => s === "warn").length;
  if (failed > 0) out(`\n${failed} check(s) failed.`);
  else if (warned > 0) out(`\nReady. ${warned} advisory item(s) above.`);
  else out("\nReady.");
  return failed > 0 ? 1 : 0;
}

function cmdRecord(args: Record<string, string | boolean>): number {
  // What PostToolUse calls, on every matching tool use. Append only: no crypto,
  // no git, no network. It must be cheap and it must never fail a session.
  try {
    if (args["stdin"] === true) {
      const payload = parsePayload(readStdin());
      if (payload === undefined) return 0;
      const sessionId = payload.session_id;
      if (sessionId === undefined || sessionId === "") return 0;
      for (const entry of toJournalEntries(payload)) append(sessionId, entry);
      return 0;
    }

    const sessionId = String(args["session"] ?? process.env["PROVENE_SESSION_ID"] ?? "");
    if (sessionId === "") return 0;
    const kind = String(args["kind"] ?? "note") as "edit" | "command" | "test" | "note";
    append(sessionId, {
      at: new Date().toISOString(), kind,
      ...(args["path"] !== undefined ? { path: String(args["path"]) } : {}),
      ...(args["argv"] !== undefined ? { argv: String(args["argv"]).split(" ") } : {}),
    });
  } catch (err) {
    recordError(String(args["session"] ?? "unknown"), err instanceof Error ? err.message : String(err));
  }
  return 0; // never fails a session
}

function cmdInit(args: Record<string, string | boolean>): number {
  const path = args["settings"] !== undefined ? String(args["settings"]) : userSettingsPath();
  const dryRun = args["dry-run"] === true;

  let current;
  try {
    current = readSettings(path);
  } catch (err) {
    out(`provene init: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const { next, added } = withProveneHooks(current);
  if (added.length === 0) {
    out(`provene: hooks already installed in ${path}`);
    out("  nothing to do");
    return 0;
  }

  if (dryRun) {
    out(`provene init --dry-run · would edit ${path}`);
    for (const a of added) out(`  + ${a}`);
    out("\nResulting hooks block:");
    out(JSON.stringify({ hooks: next.hooks }, null, 2));
    return 0;
  }

  const backup = writeSettings(path, next);
  out(`provene: hooks installed in ${path}`);
  for (const a of added) out(`  + ${a}`);
  if (backup !== undefined) out(`  previous settings backed up to ${backup}`);
  out("");
  out("  PostToolUse appends to a session journal outside this repository.");
  out("  SessionEnd writes the receipt. SessionEnd is used rather than Stop");
  out("  because a Stop hook can block and force the session to continue.");
  out("");
  out("  Start a new Claude Code session for this to take effect, then run");
  out("  `provene doctor` to confirm the hook actually fired.");
  return 0;
}

function parse(argv: readonly string[]): Record<string, string | boolean> {
  const o: Record<string, string | boolean> = {};
  let positional = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      // --flag=value as well as --flag value. Without this, `--base=main`
      // parsed as a flag literally named "base=main", so --base was undefined
      // and check silently diffed HEAD against itself and passed.
      const eq = a.indexOf("=");
      if (eq > 2) { o[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { o[a.slice(2)] = next; i++; }
      else o[a.slice(2)] = true;
    } else { o[`_${positional++}`] = a; }
  }
  return o;
}

// Entry point: dispatch on the subcommand, exit with its status so hooks and CI
// can branch on the code rather than parse the output.
const [, , command, ...rest] = process.argv;
const args = parse(rest);
let code = 0;
switch (command) {
  case "emit": code = cmdEmit(args); break;
  case "verify": code = cmdVerify(args); break;
  case "check": code = cmdCheck(args); break;
  case "promote": code = cmdPromote(args); break;
  case "manifest": code = cmdManifest(args); break;
  case "verify-aggregate": code = cmdVerifyAggregate(args); break;
  case "doctor": code = cmdDoctor(); break;
  case "record": code = cmdRecord(args); break;
  case "init": code = cmdInit(args); break;
  case "--version": case "version": out(VERSION); break;
  default:
    out("provene — evidence receipts for AI-generated code changes\n");
    out("  provene init [--dry-run] [--settings <path>]           install the Claude Code hooks");
    out("  provene record --stdin | --session <id> ...            append to the session journal");
    out("  provene emit   --session <id> [--base <commit>]        write a T0 receipt");
    out("  provene verify <receipt> [--against <commit>]          check integrity, report tier");
    out("  provene check  --base <ref> [--coverage <lcov.info>]   what a reviewer needs to look at");
    out("  provene promote --base <ref> --attester <id> --out <f>  build the T2 aggregate for CI to sign");
    out("  provene manifest --base <ref> [--out <f>]              the bytes the change digest is taken over");
    out("  provene verify-aggregate --repo <owner/name> --base <ref>  verify the signed T2 aggregate");
    out("  provene doctor                                         check the local setup");
    code = command === undefined ? 0 : 2;
}
process.exit(code);
