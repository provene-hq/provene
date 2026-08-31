#!/usr/bin/env node
/** provene — portable, signed evidence receipts for AI-generated code changes. */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir, homedir } from "node:os";
import { workingTreeEntries, committedEntries, mergeBase, repoRoot, headCommit, rootCommit, git } from "./git.ts";
import { append, read, journalDir, journalPath, resetSession, recordError, markEmitted, orphanedSessions, journalInsideRepo, type JournalEntry } from "./journal.ts";
import { deriveSalt, keyedDigest, redactCommand, ALLOWLIST_ID, TEST_SHAPES } from "./redact.ts";
import { buildT0, canonicalJson, checkStatement, isDsseEnvelope, receiptFileName, type Statement } from "./receipt.ts";
import { changeDigest, canonicalPayload } from "./changedigest.ts";
import { runCheck, annotations, summary } from "./check.ts";
import { buildAggregate, AGGREGATE_PREDICATE_TYPE } from "./promote.ts";
import { writeManifest, ghVerify, checkAggregate, decideVerification } from "./attestation.ts";
import { readStdin, parsePayload, sessionIdOf } from "./hookinput.ts";
import { resolveAgent, agentNames, hookAgents, type AgentAdapter } from "./agents.ts";
import { readTranscript, antigravityEntries } from "./antigravity.ts";
import { normalizePath, isWithin } from "./paths.ts";
import {
  userSettingsPath, readSettings, withProveneHooks, writeSettings,
  proveneHooksInstalled, hookCommand,
} from "./settings.ts";
import { createRequire } from "node:module";

// Read the real version rather than restating it. A hardcoded constant drifts
// from package.json the moment either is bumped, and a provenance tool that
// misreports its own version has no business recording anyone else's.
// Resolves to the package root from both dist/cli.js and src/cli.ts.
const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
const out = (s: string): void => { process.stdout.write(s + "\n"); };

/**
 * Which agent are we speaking for?
 *
 * Explicit, never sniffed. Two agents both send `session_id` and `tool_name`,
 * so guessing would usually be right and occasionally silently wrong, and a
 * receipt naming the wrong agent is worse than one naming none.
 */
function agentOrExplain(
  command: string,
  args: Record<string, string | boolean>,
  quiet = false,
): AgentAdapter | undefined {
  const asked = args["agent"] === undefined ? undefined : String(args["agent"]);
  const agent = resolveAgent(asked);
  if (agent === undefined) {
    // On a hook that parses our stdout, even an error message is a protocol
    // violation. It goes to the error journal instead, where doctor finds it.
    if (quiet) {
      recordError("unknown", `emit: unknown agent ${String(asked)}`);
      return undefined;
    }
    out(`provene ${command}: unknown agent ${asked}`);
    out(`  known: ${agentNames().join(", ")}`);
    out("  any other agent integrates through the flags in spec/emitters.md");
  }
  return agent;
}

/** A path made absolute against the directory it was recorded in, where both are known. */
function absoluteish(cwd: string | undefined, path: string): string {
  const rooted = /^([A-Za-z]:[\\/]|[\\/])/.test(path);
  if (rooted || cwd === undefined || cwd === "") return path;
  return normalizePath(`${cwd}/${path}`);
}

/**
 * A journal path expressed the way git expresses it, or nothing.
 *
 * Hooks report absolute paths, in the platform's own spelling: `E:\\provene\\a.ts`
 * on Windows against git's `a.ts`. Comparing the two without this returns zero
 * matches every time and looks exactly like an agent that edited nothing.
 */
function repoRelative(root: string, path: string): string | undefined {
  const ci = process.platform === "win32";
  const a = normalizePath(path);
  const b = normalizePath(root);
  if (!isWithin(a, b, ci)) {
    // Somewhere else entirely, or still relative because no directory was
    // recorded. A rooted path outside this repository is not part of the
    // change and is dropped; a relative one is passed through, since git
    // speaks the same relative language and the caller may still match it.
    return /^(\/|[A-Za-z]:)/.test(a) ? undefined : a;
  }
  return a.length === b.length ? "" : a.slice(b.length + 1);
}

function cmdEmit(args: Record<string, string | boolean>): number {
  // Gemini CLI parses a hook's stdout as JSON and documents anything else as an
  // error. Saying where the receipt went is a courtesy on one agent and a
  // protocol violation on another, so the adapter decides, not this function.
  //
  // Silence is decided FIRST, before anything in this function can print. It
  // was not, and only the success path honoured it: a Gemini session that
  // ended with nothing to attest -- the ordinary case for a session that only
  // read files -- printed "no changes to attest" into a channel documented as
  // JSON-only, and the agent surfaced it to the developer as a system message.
  // Found by running a real Gemini session, not by reading this file; the test
  // that existed asserted the hook command CARRIES --quiet, never that --quiet
  // silences every path through it.
  let sessionId = String(args["session"] ?? process.env["PROVENE_SESSION_ID"] ?? "");
  const explicitQuiet = args["quiet"] === true;
  const agent = agentOrExplain("emit", args, explicitQuiet);
  if (agent === undefined) return 2;
  const quiet = explicitQuiet || (args["stdin"] === true && agent.stdoutMustBeSilent);
  // Silenced, not discarded. A diagnosis nobody can see is how a hook fails for
  // a week without anyone noticing, so under silence every line goes to the
  // error journal, which is exactly where `provene doctor` looks.
  const say = (line: string): void => {
    if (quiet) recordError(sessionId === "" ? "unknown" : sessionId, line);
    else out(line);
  };

  let hookCwd: string | undefined;
  let hookTool: string | undefined;
  let hookVendor: string | undefined;
  if (args["stdin"] === true) {
    const payload = parsePayload(readStdin());
    const fromHook = sessionIdOf(payload ?? {});
    if (fromHook !== undefined) sessionId = fromHook;
    if (payload?.cwd !== undefined) hookCwd = payload.cwd;
    // The payload arrived through a hook we installed, so the agent is known
    // even though no payload names it. Without this every hook-emitted receipt
    // would record agent.tool as "unknown", which is the one thing a receipt
    // exists to say.
    if (payload?.hook_event_name !== undefined) {
      hookTool = agent.id;
      hookVendor = agent.vendor;
    }
  }
  if (sessionId === "") { say("provene emit: --session is required"); return 2; }
  try {
    if (hookCwd !== undefined) process.chdir(hookCwd);
    const root = repoRoot();
    if (journalInsideRepo(root)) {
      say(`provene: refusing to emit — the journal is inside this repository (${journalDir()}).`);
      say("  It holds unredacted commands, including any secrets passed on a command line,");
      say("  and emitting would record it as a changed file. Set PROVENE_HOME outside the repo.");
      return 1;
    }
    // Resolve to a commit id. A receipt that records "HEAD" as its parent
    // records nothing: HEAD moves, and the binding must name a fixed commit.
    const base = git(["rev-parse", String(args["base"] ?? "HEAD")], root);
    const entries = workingTreeEntries(base, root);
    if (entries.length === 0) { say("provene: no changes to attest"); return 0; }

    const salt = deriveSalt(rootCommit());
    const journal = read(sessionId);

    /**
     * Did this happen here?
     *
     * A journal belongs to a session, not to a repository, and a session may
     * work in several. Every command in the journal was being recorded into
     * whichever repository `emit` happened to run in -- so a suite that passed
     * in one project could appear as verification evidence for a change in
     * another. Found in a real journal that held a provene session's commands
     * alongside edits to an unrelated analysis directory.
     */
    const here = (e: { cwd?: string }): boolean =>
      e.cwd === undefined || repoRelative(root, e.cwd) !== undefined;

    /**
     * And what an unrecorded directory is worth.
     *
     * This kept the exit code when no directory was recorded, on the grounds
     * that journals predating the field and emitters that omit `--cwd` are
     * silent rather than wrong. A reviewer pointed out what silence buys: an
     * emitter that omits it, running `npm test` in another checkout where it
     * passes, produces a receipt asserting a passing test run on THIS change.
     * That is the one claim this format exists to make trustworthy, so it is
     * not available on an assumption.
     *
     * Dropping the command outright would have thrown away real observations
     * from every existing journal, so neither pole is taken: the command is
     * recorded, the OUTCOME is not. It ran; we cannot say it ran here; so
     * nothing derives a verification run from it. This is the same rule the
     * transcript reader already applies to a command whose directory the log
     * does not state.
     */
    const scoped = (e: JournalEntry): JournalEntry => {
      if (e.kind !== "command" || e.cwd !== undefined || e.exitCode === undefined) return e;
      const { exitCode: _dropped, ...rest } = e;
      return rest;
    };

    const commands = journal
      .filter(here)
      .map(scoped)
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
      journal
        .filter(here)
        .filter((e) => e.kind === "edit" && e.path !== undefined)
        // A relative path is relative to where the agent was. `src/a.ts` in one
        // project and `src/a.ts` in another are the same six characters and
        // different files, so it is resolved against the recorded directory
        // before being tested against this repository.
        .map((e) => repoRelative(root, absoluteish(e.cwd, e.path!)))
        .filter((p): p is string => p !== undefined && p !== ""),
    )];
    const task = args["task"] !== undefined
      ? { ref: String(args["task"]), digest: keyedDigest(salt, String(args["task"])) }
      : undefined;

    const statement = buildT0({
      subjectName: `${args["subject"] ?? "workspace"}`,
      entries, parent: base,
      agent: {
        tool: String(args["tool"] ?? hookTool ?? "unknown"),
        // RFC 0001 §6.1 has carried these since v0.1 and nothing could set
        // them, so every receipt named a tool and no vendor -- fine while one
        // agent existed, useless the moment a repository has receipts from two.
        ...(args["vendor"] !== undefined ? { vendor: String(args["vendor"]) }
            : hookVendor !== undefined ? { vendor: hookVendor } : {}),
        ...(args["tool-version"] !== undefined ? { toolVersion: String(args["tool-version"]) } : {}),
        // The hook payload does not carry the model, and we do not guess:
        // modelSource is only meaningful when a model is actually recorded.
        // An emitter that read the model from its own configuration says
        // `configured`; one told by the runtime says `reported`. Guessing is
        // the third option and it is not offered.
        ...(args["model"] !== undefined
          ? {
              model: String(args["model"]),
              modelSource: (args["model-source"] === "configured" ? "configured" : "reported") as
                "reported" | "configured",
            }
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
    say(`provene: wrote ${rel}`);
    say(`  tier T0 (unsigned) · ${entries.length} paths · change ${changeDigest(entries).slice(0, 12)}`);
    const unverified = (statement.predicate as any).verification.unverifiedPaths as string[];
    if (runs.length > 0) {
      const passed = runs.filter((r) => r.result === "PASSED").length;
      say(`  ${runs.length} local test run(s) observed, ${passed} passed ` +
          `(observedBy: local — satisfies no policy on its own)`);
    }
    if (unverified.length > 0) say(`  ${unverified.length} path(s) with no verification evidence`);
    // How much of this change the session actually accounts for.
    //
    // `changes.files` is the whole diff, and it always was -- the receipt binds
    // a changeset, not an authorship claim. But the journal knows which of
    // those files the agent touched, and until now that was computed and then
    // dropped on the floor. It matters most for an agent whose session is
    // imported by hand rather than closed by a hook, because the working tree
    // can hold a great deal the agent never saw.
    //
    // Reported, not recorded: putting it in the receipt means a new field, and
    // RFC 0001 section 6.4 is changed by RFC, not by an emitter that felt like
    // saying more.
    const changedPaths = new Set(entries.map((e) => e.path));
    const covered = attributedPaths.filter((p) => changedPaths.has(p)).length;
    if (attributedPaths.length > 0 && covered < entries.length) {
      say(`  ${covered} of ${entries.length} changed path(s) attributed to this session by the journal`);
    }
    return 0;
  } catch (err) {
    // Fail closed toward evidence, open toward the developer.
    recordError(sessionId, err instanceof Error ? err.message : String(err));
    say(`provene: could not emit a receipt (${err instanceof Error ? err.message : err}).`);
    say("provene: no receipt was written; a wrong receipt is worse than none. Run `provene doctor`.");
    return 0;
  }
}

function cmdVerify(args: Record<string, string | boolean>): number {
  const file = String(args["_0"] ?? "");
  if (file === "") { out("usage: provene verify <receipt.json> [--against <commit>]"); return 2; }
  // A missing or malformed file is a thing a person does, not an exception.
  // This threw ENOENT with a Node stack trace at anyone who mistyped a path.
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    out(`provene verify: cannot read ${file}`);
    out(e.code === "ENOENT"
      ? "  no such file. Receipts live in .provene/ and end .statement.json or .dsse.json"
      : `  ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  // A `.dsse.json` name asserts a signed envelope. If the file is not one, the
  // name is wrong and the receipt is malformed -- not quietly downgraded to
  // unsigned, which would let a forged name pass as an honest mistake.
  if (file.endsWith(".dsse.json") && !isDsseEnvelope(raw)) {
    out("provene: receipt failed verification");
    out("  - named .dsse.json but is not a DSSE envelope (no payload/payloadType/signatures)");
    out("  - the filename declares the encoding (RFC 0001 §8); this file contradicts its own name");
    return 1;
  }
  const statement = (raw["payload"] !== undefined && raw["_statement_for_readability_only"] !== undefined
    ? raw["_statement_for_readability_only"]
    : raw) as Statement;
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

/**
 * Resolve a range, or explain why not.
 *
 * `check` and `verify-aggregate` wrapped `resolveRange` in a try/catch and
 * `manifest` and `promote` did not, so in a repository with no commits the
 * first two said "cannot resolve HEAD" and the second two threw a Node stack
 * trace at the user. Four call sites, two behaviours, no reason for the
 * difference. Now there is one function and no choice.
 */
function resolveRangeOrExplain(
  command: string, root: string, args: Record<string, string | boolean>,
): { base: string; head: string; fellBack: boolean } | undefined {
  const baseRef = String(args["base"] ?? "HEAD");
  try {
    return resolveRange(root, baseRef, String(args["head"] ?? "HEAD"));
  } catch {
    out(`provene ${command}: cannot resolve ${baseRef}`);
    out("  a repository with no commits has nothing to diff; commit something first");
    return undefined;
  }
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

  const range = resolveRangeOrExplain("check", root, args);
  if (range === undefined) return 2;
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

  const range = resolveRangeOrExplain("promote", root, args);
  if (range === undefined) return 2;
  const base = range.base;
  const head = range.head;

  const identity = String(args["attester"] ?? process.env["GITHUB_WORKFLOW_REF"] ?? "");
  if (identity === "") {
    out("provene promote: --attester is required (the CI identity that will sign this)");
    return 2;
  }

  // With no coverage report, NOTHING is known to have been executed, so every
  // changed path is unverified. This used to produce `unverifiedPaths: []`,
  // which reads as "every path is covered" -- and got signed alongside a
  // PASSED run. RFC 0001 section 6.6: the field lists changed paths no run in
  // this receipt covers, and with no evidence that is all of them.
  const result = args["coverage"] !== undefined
    ? runCheck({ root, base, head, lcovPath: String(args["coverage"]) })
    : undefined;
  const unverified = result === undefined
    ? runCheck({ root, base, head }).changedPaths
    : result.evidence
        .filter((e) => e.kind === "untested" || (e.kind === "instrumented" && e.covered < e.changed))
        .map((e) => e.path);

  // RFC 0001 section 6.6 fixes this enum. It was written into the predicate
  // unchecked, so `--test-result "definitely-passed"` was recorded verbatim and
  // then SIGNED -- a signed receipt is the last place an unvalidated string
  // from a workflow file belongs.
  const RESULTS = ["PASSED", "WARNED", "FAILED"] as const;
  type CiRun = { id: string; kind: "test"; tool?: string; result: "PASSED" | "WARNED" | "FAILED"; url?: string };
  let runs: CiRun[] = [];
  if (args["test-result"] !== undefined) {
    const result = String(args["test-result"]).toUpperCase();
    if (!(RESULTS as readonly string[]).includes(result)) {
      out(`provene promote: --test-result must be one of ${RESULTS.join(", ")}, got ${String(args["test-result"])}`);
      return 2;
    }
    runs = [{
      id: "ci-test",
      kind: "test" as const,
      ...(args["test-tool"] !== undefined ? { tool: String(args["test-tool"]) } : {}),
      result: result as "PASSED" | "WARNED" | "FAILED",
      ...(args["run-url"] !== undefined ? { url: String(args["run-url"]) } : {}),
    }];
  }

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
  const range = resolveRangeOrExplain("manifest", root, args);
  if (range === undefined) return 2;
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

  const range = resolveRangeOrExplain("verify-aggregate", root, args);
  if (range === undefined) return 2;
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
    // --no-merges, matching what `promote` counted. Without it the verifier and
    // the signer disagree by exactly the pull-request merge commit, which CI
    // has and no checkout does.
    try { return git(["rev-list", "--no-merges", `${base}..${range.head}`], root).split("\n").filter((l) => l !== "").length; }
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
      break;
  }
  // gh accepts an attestation signed by ANY workflow in the repository, so a
  // repository that also runs an experimental or pull-request-triggered
  // workflow with id-token: write has more signers than its maintainers think.
  // Printed for every outcome that consulted a signature, not only success:
  // confining it to the passing branch meant the one person who most needed to
  // widen their constraint -- someone staring at a failure -- never saw it.
  if (outcome.kind !== "no-verifier" && outcome.kind !== "no-attestation"
      && args["signer-workflow"] === undefined && args["cert-identity"] === undefined) {
    out("  note: any workflow in this repository was accepted as a signer.");
    out("        Pass --signer-workflow owner/name/.github/workflows/<file> to pin one.");
  }
  for (const line of rangeNote(range)) out(line);
  return outcome.code;
}

function cmdDoctor(args: Record<string, string | boolean>): number {
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
  // `init --settings <path>` writes here, so `doctor` has to look here too.
  // It did not, so the documented way to install into a non-default location
  // was followed by a checkup that reported the hooks missing.
  const agent = resolveAgent(args["agent"] === undefined ? undefined : String(args["agent"]))
    ?? resolveAgent(undefined)!;
  const sPath = args["settings"] !== undefined ? String(args["settings"])
              : agent.settingsPath !== undefined ? agent.settingsPath() : "";
  if (sPath === "") {
    checks.push(["warn", `hooks installed (${agent.label})`,
      "this agent fires no hooks — sessions are imported with `provene import`"]);
  } else try {
    const installed = proveneHooksInstalled(readSettings(sPath), agent);
    if (installed.record && installed.emit) {
      checks.push(["ok", `hooks installed (${agent.label})`, sPath]);
    } else if (!installed.record && !installed.emit) {
      checks.push(["warn", `hooks installed (${agent.label})`,
        `not found in ${sPath} — run \`provene init${agent.id === "claude-code" ? "" : ` --agent ${agent.id}`}\``]);
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
      // Never returns non-zero on this path, whatever the payload. Gemini CLI
      // reads exit code 2 from a hook as "block this tool", so a validation
      // failure in the recorder would stop the agent doing its work -- an
      // observer that can veto what it observes is not an observer.
      const agent = resolveAgent(args["agent"] === undefined ? undefined : String(args["agent"]));
      if (agent === undefined) return 0;
      const payload = parsePayload(readStdin());
      if (payload === undefined) return 0;
      const sessionId = sessionIdOf(payload);
      if (sessionId === undefined) return 0;
      // A transcript-wired agent has no hook payload to parse. Nothing to do,
      // and saying so through an exit code would block the tool.
      if (agent.parse === undefined) return 0;
      for (const entry of agent.parse(payload)) append(sessionId, entry);
      return 0;
    }

    // The vendor-neutral path. `--stdin` above is an adapter for one agent's
    // payload shape; this is the interface every other emitter uses, and it was
    // second class: it could record that a command ran and not whether it
    // worked. Since a verification run is derived from the exit code, an agent
    // integrating this way could never produce test evidence at all -- the
    // whole point of the format -- while the Claude Code adapter could.
    const sessionId = String(args["session"] ?? process.env["PROVENE_SESSION_ID"] ?? "");
    if (sessionId === "") return 0;
    const kind = String(args["kind"] ?? "note") as "edit" | "command" | "test" | "note";
    const exitCode = args["exit"] !== undefined ? Number(args["exit"]) : undefined;
    if (exitCode !== undefined && !Number.isInteger(exitCode)) {
      out(`provene record: --exit must be an integer, got ${String(args["exit"])}`);
      return 2;
    }
    const durationMs = args["duration-ms"] !== undefined ? Number(args["duration-ms"]) : undefined;
    append(sessionId, {
      at: new Date().toISOString(), kind,
      ...(args["path"] !== undefined ? { path: String(args["path"]) } : {}),
      // Optional, and worth supplying: it is what keeps a session that worked
      // in two repositories from reporting one's test run as the other's.
      ...(args["cwd"] !== undefined ? { cwd: String(args["cwd"]) } : {}),
      // Split on whitespace, not a single space, so `npm  test` and a tab do
      // not produce empty argv entries that reach the redactor.
      ...(args["argv"] !== undefined ? { argv: String(args["argv"]).trim().split(/\s+/) } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs } : {}),
    });
  } catch (err) {
    recordError(String(args["session"] ?? "unknown"), err instanceof Error ? err.message : String(err));
  }
  return 0; // never fails a session
}

function cmdInit(args: Record<string, string | boolean>): number {
  const agent = agentOrExplain("init", args);
  if (agent === undefined) return 2;
  // There is nothing to install for an agent that fires no hooks. Writing a
  // configuration anyway would leave a file that looks like working coverage
  // and produces no receipts, which is the failure this tool exists to prevent
  // in other people's repositories.
  if (agent.wiring !== "hooks" || agent.settingsPath === undefined) {
    out(`provene init: ${agent.label} has no hooks to install.`);
    out("  It fires no lifecycle event, ships no CLI and exposes no MCP surface,");
    out("  so nothing can observe a session while it happens. What it does leave");
    out("  is a transcript, and a session is imported from that afterwards:");
    out("");
    out(`    provene import --agent ${agent.id} --session <session-id>`);
    out(`    provene emit   --session <session-id>`);
    out("");
    out("  Run `provene import --agent " + agent.id + "` with no session to list the ones it can see.");
    return 2;
  }
  const path = args["settings"] !== undefined ? String(args["settings"]) : agent.settingsPath();
  const dryRun = args["dry-run"] === true;

  let current;
  try {
    current = readSettings(path);
  } catch (err) {
    out(`provene init: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const { next, added } = withProveneHooks(current, agent);
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
  const recordEvents = agent.hooks.filter((h) => h.command === "record").map((h) => h.event);
  const verb = recordEvents.length > 1 ? "append" : "appends";
  out(`  ${recordEvents.join(" and ")} ${verb} to a session journal outside this repository.`);
  out("  SessionEnd writes the receipt. SessionEnd is used rather than a blocking");
  out("  event because the emitter must never be able to interrupt your work.");
  out("");
  out(`  If ${agent.label} is running now, restart it: hooks are read when it starts,`);
  out("  so a session already open will not fire them and no receipt will appear.");
  out(`  Then run \`provene doctor${agent.id === "claude-code" ? "" : ` --agent ${agent.id}`}\` to confirm the hook fired.`);
  out("");
  out("  Receipts are written to .provene/ UNSTAGED. `git commit -am` will not");
  out("  pick one up, because -a stages modified tracked files and a new receipt");
  out("  is neither. Use `git add -A` or `git add .provene/`.");
  return 0;
}

/**
 * Where Antigravity keeps the sessions it has written.
 *
 * `PROVENE_TRANSCRIPT_ROOT` overrides it, which is how the tests point at a
 * fixture without a home directory full of real work.
 */
function transcriptRoot(): string {
  const override = process.env["PROVENE_TRANSCRIPT_ROOT"];
  if (override !== undefined && override !== "") return override;
  return join(process.env["GEMINI_HOME"] ?? join(homedir(), ".gemini"), "antigravity", "brain");
}

const transcriptFor = (sessionId: string): string =>
  join(transcriptRoot(), sessionId, ".system_generated", "logs", "transcript.jsonl");

/** The `<session>` segment of a transcript path, when the path has that shape. */
function sessionFromPath(path: string): string | undefined {
  const parts = resolvePath(path).split(/[\\/]/);
  const i = parts.lastIndexOf(".system_generated");
  return i > 0 ? parts[i - 1] : undefined;
}

function listSessions(): number {
  const root = transcriptRoot();
  let ids: string[];
  try {
    ids = readdirSync(root).filter((d) => existsSync(transcriptFor(d)));
  } catch {
    out(`provene import: no transcripts under ${root}`);
    out("  Set GEMINI_HOME if Antigravity keeps its sessions elsewhere.");
    return 1;
  }
  if (ids.length === 0) { out(`provene import: no transcripts under ${root}`); return 1; }
  out(`Sessions under ${root}:`);
  for (const id of ids) out(`  ${id}`);
  out("\n  provene import --agent antigravity --session <id>");
  return 0;
}

/**
 * Reads a completed session out of an agent's own log.
 *
 * This is the weaker half of the emitter contract and it is worth being plain
 * about why. A hook is told what happened as it happens, by the agent, through
 * a published interface. A transcript is a log we were never promised, read
 * after the fact, whose result steps are matched to their calls by position
 * because nothing links them. Everything ambiguous is dropped rather than
 * guessed, so the receipt this produces claims less than a hooked agent's --
 * which is the correct outcome, not a defect to be tuned away.
 *
 * It writes to the journal and stops there. Emitting stays a separate command
 * so that a transcript can never take a shortcut past redaction: whatever this
 * imports goes through exactly the same `emit` every other agent uses.
 */
function cmdImport(args: Record<string, string | boolean>): number {
  const agent = agentOrExplain("import", args);
  if (agent === undefined) return 2;
  if (agent.wiring !== "transcript") {
    out(`provene import: ${agent.label} is wired with hooks, so there is nothing to import.`);
    out(`  Run \`provene init --agent ${agent.id}\` and its sessions record themselves.`);
    return 2;
  }

  const explicit = args["transcript"] !== undefined ? String(args["transcript"]) : undefined;
  const asked = args["session"] !== undefined ? String(args["session"]) : undefined;
  if (explicit === undefined && asked === undefined) return listSessions();

  const path = explicit ?? transcriptFor(asked!);
  const sessionId = asked ?? sessionFromPath(path);
  if (sessionId === undefined || sessionId === "") {
    out("provene import: could not tell which session this transcript belongs to.");
    out("  Pass --session <id> as well as --transcript.");
    return 2;
  }
  if (!existsSync(path)) {
    out(`provene import: no transcript at ${path}`);
    out("  Run `provene import --agent antigravity` to list the sessions it can see.");
    return 1;
  }

  let root: string;
  try {
    root = repoRoot();
  } catch {
    out("provene import: not inside a git repository.");
    out("  Run this from the repository the session edited; imports are scoped to it.");
    return 1;
  }
  // The same refusal `emit` makes, for the same reason and one step earlier:
  // what gets appended below is unredacted, including any credential the agent
  // passed on a command line.
  if (journalInsideRepo(root)) {
    out(`provene import: refusing — the journal is inside this repository (${journalDir()}).`);
    out("  It holds unredacted commands. Set PROVENE_HOME outside the repo.");
    return 1;
  }

  const existing = read(sessionId);
  const replace = args["replace"] === true;
  if (existing.length > 0 && !replace) {
    out(`provene import: session ${sessionId} already has ${existing.length} journal entries.`);
    out(`  ${journalPath(sessionId)}`);
    out("  Importing again would record every command twice, and a duplicated test");
    out("  run reads as two passes. Re-run with --replace to discard and re-import.");
    return 1;
  }

  let entries;
  try {
    entries = antigravityEntries(readTranscript(path), { repoRoot: root });
  } catch (err) {
    out(`provene import: could not read ${path} (${err instanceof Error ? err.message : String(err)})`);
    return 1;
  }

  const edits = entries.filter((e) => e.kind === "edit");
  const commands = entries.filter((e) => e.kind === "command");
  const withOutcome = commands.filter((e) => e.exitCode !== undefined);
  const paths = [...new Set(edits.map((e) => e.path!))];

  if (args["dry-run"] === true) {
    out(`provene import --dry-run · ${path}`);
  } else {
    if (replace) resetSession(sessionId);
    for (const entry of entries) append(sessionId, entry);
    out(`provene: imported session ${sessionId}`);
  }
  out(`  ${paths.length} file(s) edited, ${commands.length} command(s), ` +
      `${withOutcome.length} with a recorded exit code`);
  for (const p of paths.slice(0, 10)) out(`    ${p}`);
  if (paths.length > 10) out(`    … and ${paths.length - 10} more`);
  if (withOutcome.length < commands.length) {
    out(`  ${commands.length - withOutcome.length} command(s) have no outcome: backgrounded, or the`);
    out("  transcript did not state one. Those cannot become verification runs.");
  }
  if (entries.length === 0) {
    out("  Nothing was recorded. Either the session edited no files in this repository,");
    out("  or the transcript format has changed — nothing is guessed when it does.");
  }
  if (args["dry-run"] !== true) {
    out("");
    out(`  Next: provene emit --session ${sessionId} --tool ${agent.id} --vendor ${agent.vendor}`);
  }
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

function usage(): void {
  out("provene — evidence receipts for AI-generated code changes\n");
  out("  provene init [--agent <name>] [--dry-run]              install an agent's hooks");
  out("                                                         agents: " + hookAgents().join(", "));
  out("  provene import --agent antigravity --session <id>      import a session that fired no hooks");
  out("  provene record --stdin                                 append a Claude Code hook payload");
  out("  provene record --session <id> --kind <k> [--path <p>]  append from any other agent");
  out("                 [--argv <cmd>] [--exit <n>] [--cwd <dir>]");
  out("  provene emit   --session <id> [--base <commit>]        write a T0 receipt");
  out("                 [--tool <t>] [--vendor <v>] [--model <m>]");
  out("  provene verify <receipt> [--against <commit>]          check integrity, report tier");
  out("  provene check  --base <ref> [--coverage <lcov.info>]   what a reviewer needs to look at");
  out("  provene promote --base <ref> --attester <id> --out <f>  build the T2 aggregate for CI to sign");
  out("  provene manifest --base <ref> [--out <f>]              the bytes the change digest is taken over");
  out("  provene verify-aggregate --repo <owner/name> --base <ref>  verify the signed T2 aggregate");
  out("  provene doctor [--settings <path>]                     check the local setup");
}


/**
 * The flags each command understands.
 *
 * `parse` accepts any `--word`, and every command reads only the keys it knows,
 * so anything else was silently discarded. `provene init --agent gemini` on a
 * build that predates `--agent` therefore installed CLAUDE hooks, into Claude's
 * settings file, and said so in an output the user had just asked not to get.
 * A typo does the same thing on a current build: `--agnet gemini` still
 * installs Claude.
 *
 * That is the failure this project keeps finding in itself -- a request the
 * tool cannot honour, quietly reinterpreted as one it can. A stale binary
 * cannot be fixed from here, but it stops being silent from this version on,
 * and `--version` is the first thing the error tells you to check.
 */
const FLAGS: Readonly<Record<string, readonly string[]>> = {
  init: ["agent", "settings", "dry-run"],
  import: ["agent", "session", "transcript", "replace", "dry-run"],
  doctor: ["agent", "settings"],
  record: ["stdin", "agent", "session", "kind", "path", "argv", "cwd", "exit", "duration-ms"],
  emit: ["stdin", "agent", "quiet", "session", "base", "subject", "task",
         "tool", "vendor", "tool-version", "model", "model-source"],
  verify: ["against", "base", "head"],
  check: ["base", "head", "coverage", "exclude", "annotate", "format"],
  promote: ["base", "head", "attester", "issuer", "coverage", "out", "manifest",
            "public", "pull-request", "run-url", "target-ref", "test-result", "test-tool"],
  manifest: ["base", "head", "out"],
  "verify-aggregate": ["base", "head", "repo", "bundle", "cert-identity", "signer-workflow"],
};

/** Edit distance, capped: enough to say "did you mean" without a dependency. */
function near(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length]![b.length]!;
}

function rejectUnknownFlags(command: string, args: Record<string, string | boolean>): boolean {
  const accepted = FLAGS[command];
  if (accepted === undefined) return true;
  // Positionals are stored as _0, _1 and are not flags.
  const given = Object.keys(args).filter((k) => !/^_\d+$/.test(k));
  const unknown = given.filter((k) => !accepted.includes(k));
  if (unknown.length === 0) return true;

  for (const flag of unknown) {
    const suggestion = accepted.find((a) => near(a, flag) <= 2);
    out(`provene ${command}: unknown option --${flag}` +
        (suggestion !== undefined ? `, did you mean --${suggestion}?` : ""));
  }
  out(`  ${command} accepts: ${accepted.map((a) => `--${a}`).join(", ")}`);
  out("  If you expected this option to exist, check `provene --version`;");
  out("  an older build ignores options it does not know instead of saying so.");
  return false;
}

// Entry point: dispatch on the subcommand, exit with its status so hooks and CI
// can branch on the code rather than parse the output.
const [, , command, ...rest] = process.argv;
const args = parse(rest);
let code = 0;
// Before anything runs: a flag we do not understand must never be discarded.
if (command !== undefined && FLAGS[command] !== undefined && !rejectUnknownFlags(command, args)) {
  process.exit(2);
}
switch (command) {
  case "emit": code = cmdEmit(args); break;
  case "verify": code = cmdVerify(args); break;
  case "check": code = cmdCheck(args); break;
  case "promote": code = cmdPromote(args); break;
  case "manifest": code = cmdManifest(args); break;
  case "verify-aggregate": code = cmdVerifyAggregate(args); break;
  case "doctor": code = cmdDoctor(args); break;
  case "record": code = cmdRecord(args); break;
  case "init": code = cmdInit(args); break;
  case "import": code = cmdImport(args); break;
  case "--version": case "version": out(VERSION); break;
  // Asking for help is not a usage error. `provene --help` exited 2, so any
  // script or Makefile that ran it as a sanity check saw a failure.
  case "--help": case "-h": case "help": usage(); break;
  default:
    usage();
    code = command === undefined ? 0 : 2;
}
process.exit(code);
