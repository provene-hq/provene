#!/usr/bin/env node
/** provene — portable, signed evidence receipts for AI-generated code changes. */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { diffEntries, repoRoot, headCommit, rootCommit, git } from "./git.ts";
import { append, read, journalDir, recordError, markEmitted, orphanedSessions } from "./journal.ts";
import { deriveSalt, keyedDigest, redactCommand, ALLOWLIST_ID } from "./redact.ts";
import { buildT0, canonicalJson, checkStatement, receiptFileName, type Statement } from "./receipt.ts";
import { changeDigest } from "./changedigest.ts";
import { runCheck, annotations, summary } from "./check.ts";
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
    // Resolve to a commit id. A receipt that records "HEAD" as its parent
    // records nothing: HEAD moves, and the binding must name a fixed commit.
    const base = git(["rev-parse", String(args["base"] ?? "HEAD")], root);
    const entries = diffEntries(base, root);
    if (entries.length === 0) { out("provene: no changes to attest"); return 0; }

    const salt = deriveSalt(rootCommit());
    const journal = read(sessionId);
    const commands = journal
      .filter((e) => e.kind === "command" && e.argv !== undefined)
      .map((e) => redactCommand(e.argv!, salt, {
        ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
        ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
        observedBy: "local",
      }));
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
      commands, attributedPaths,
    });
    (statement.predicate as Record<string, unknown>)["redaction"] =
      { pathsExcluded: false, allowlistId: ALLOWLIST_ID };

    const rel = receiptFileName(statement, false);
    mkdirSync(join(root, ".provene"), { recursive: true });
    writeFileSync(join(root, rel), canonicalJson(statement), "utf8");
    markEmitted(sessionId, changeDigest(entries));
    out(`provene: wrote ${rel}`);
    out(`  tier T0 (unsigned) · ${entries.length} paths · change ${changeDigest(entries).slice(0, 12)}`);
    const unattributed = (statement.predicate as any).verification.unverifiedPaths as string[];
    if (unattributed.length > 0) out(`  ${unattributed.length} path(s) with no verification evidence`);
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
        return { entries: diffEntries(sha), parent: sha };
      })()
    : undefined;
  const r = checkStatement(statement, against);
  if (r.ok) {
    out(`provene: receipt is well formed · tier ${r.tier}`);
    if (r.rebased) out("  note: change content matches but the parent differs — rebased");
    if (r.tier === "T0" || r.tier === "T1") {
      out("  this receipt is a self-attestation and satisfies no policy on its own");
    }
    return 0;
  }
  out("provene: receipt failed verification");
  for (const p of r.problems) out(`  - ${p}`);
  return 1;
}

function cmdCheck(args: Record<string, string | boolean>): number {
  let root: string;
  try { root = repoRoot(); } catch { out("provene check: not inside a git repository"); return 2; }

  const baseRef = String(args["base"] ?? "HEAD");
  let base: string;
  try { base = git(["rev-parse", baseRef], root); }
  catch { out(`provene check: cannot resolve ${baseRef}`); return 2; }

  const result = runCheck({
    root, base,
    ...(args["coverage"] !== undefined ? { lcovPath: String(args["coverage"]) } : {}),
  });

  if (args["format"] === "json") {
    out(JSON.stringify(result, null, 2));
  } else {
    for (const line of summary(result)) out(line);
  }

  if (args["annotate"] === "github") {
    for (const a of annotations(result)) out(a);
  }

  // A malformed receipt always fails: a forgeable receipt is worse than none
  // (RFC 0002 section 9, receipt-integrity). Missing evidence is reported, not
  // failed -- that judgement belongs to a policy, which is a separate command.
  const broken = result.receipts.filter((r) => !r.ok).length;
  if (broken > 0) { out(`\n${broken} receipt(s) failed verification.`); return 1; }
  return 0;
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
  if (existsSync(jdir)) {
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
    out("  provene doctor                                         check the local setup");
    code = command === undefined ? 0 : 2;
}
process.exit(code);
