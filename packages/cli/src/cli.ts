#!/usr/bin/env node
/** provene — portable, signed evidence receipts for AI-generated code changes. */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { diffEntries, repoRoot, headCommit, rootCommit, git } from "./git.ts";
import { append, read, journalDir, recordError } from "./journal.ts";
import { deriveSalt, keyedDigest, redactCommand, ALLOWLIST_ID } from "./redact.ts";
import { buildT0, canonicalJson, checkStatement, receiptFileName, type Statement } from "./receipt.ts";
import { changeDigest } from "./changedigest.ts";

const VERSION = "0.0.0-dev";
const out = (s: string): void => { process.stdout.write(s + "\n"); };

function cmdEmit(args: Record<string, string | boolean>): number {
  const sessionId = String(args["session"] ?? process.env["PROVENE_SESSION_ID"] ?? "");
  if (sessionId === "") { out("provene emit: --session is required"); return 2; }
  try {
    const root = repoRoot();
    const base = String(args["base"] ?? headCommit());
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
        tool: String(args["tool"] ?? "unknown"),
        ...(args["model"] !== undefined ? { model: String(args["model"]) } : {}),
        modelSource: "reported",
      },
      ...(task !== undefined ? { task } : {}),
      session: { id: sessionId, startedAt: journal[0]?.at ?? new Date().toISOString(),
                 endedAt: new Date().toISOString(), toolCalls: journal.length },
      commands, attributedPaths,
    });
    (statement.predicate as Record<string, unknown>)["redaction"] =
      { pathsExcluded: false, allowlistId: ALLOWLIST_ID };

    const rel = receiptFileName(statement, false);
    mkdirSync(join(root, ".provene"), { recursive: true });
    writeFileSync(join(root, rel), canonicalJson(statement), "utf8");
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
  const against = args["against"] !== undefined
    ? { entries: diffEntries(String(args["against"])), parent: String(args["against"]) }
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
  // What a PostToolUse hook calls. Append only: no crypto, no git, no network.
  const sessionId = String(args["session"] ?? process.env["PROVENE_SESSION_ID"] ?? "");
  if (sessionId === "") return 0;
  try {
    const kind = String(args["kind"] ?? "note") as "edit" | "command" | "test" | "note";
    append(sessionId, {
      at: new Date().toISOString(), kind,
      ...(args["path"] !== undefined ? { path: String(args["path"]) } : {}),
      ...(args["argv"] !== undefined ? { argv: String(args["argv"]).split(" ") } : {}),
    });
  } catch (err) {
    recordError(sessionId, err instanceof Error ? err.message : String(err));
  }
  return 0; // never fails a session
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

const [, , command, ...rest] = process.argv;
const args = parse(rest);
let code = 0;
switch (command) {
  case "emit": code = cmdEmit(args); break;
  case "verify": code = cmdVerify(args); break;
  case "doctor": code = cmdDoctor(); break;
  case "record": code = cmdRecord(args); break;
  case "--version": case "version": out(VERSION); break;
  default:
    out("provene — evidence receipts for AI-generated code changes\n");
    out("  provene record --session <id> --kind edit --path <p>   append to the session journal");
    out("  provene emit   --session <id> [--base <commit>]        write a T0 receipt");
    out("  provene verify <receipt> [--against <commit>]          check integrity, report tier");
    out("  provene doctor                                         check the local setup");
    code = command === undefined ? 0 : 2;
}
process.exit(code);
