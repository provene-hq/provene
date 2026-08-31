/**
 * The session journal.
 *
 * PostToolUse appends here and does nothing else: no crypto, no network, no git.
 * Session end reads it once. This is why the hook does not become agent latency,
 * and it is why a crashed session still leaves a readable record.
 *
 * The journal lives outside the repository. It holds unredacted observations and
 * must never be committed; the receipt built from it is the redacted artifact.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface JournalEntry {
  readonly at: string;
  readonly kind: "edit" | "command" | "test" | "note";
  readonly path?: string;
  readonly argv?: readonly string[];
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly detail?: Record<string, unknown>;
}

export function journalDir(): string {
  return process.env["PROVENE_HOME"] ?? join(homedir(), ".provene");
}

export function journalPath(sessionId: string): string {
  return join(journalDir(), "sessions", `${sessionId}.jsonl`);
}

export function append(sessionId: string, entry: JournalEntry): void {
  const p = journalPath(sessionId);
  mkdirSync(join(journalDir(), "sessions"), { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + "\n", "utf8");
}

export function read(sessionId: string): JournalEntry[] {
  const p = journalPath(sessionId);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as JournalEntry);
}

/**
 * A journal is only orphaned if nothing came of it.
 *
 * emit writes a marker beside the journal naming the receipt it produced. A
 * journal without one is a session that ended without emitting -- a crash, a
 * killed terminal, a SessionEnd hook that never ran -- and is recoverable with
 * `provene emit --session <id>`. Without the marker, doctor would nag about
 * every journal forever, which is how a checkup earns being ignored.
 */
export function markEmitted(sessionId: string, changeDigest: string): void {
  try {
    const p = join(journalDir(), "sessions", `${sessionId}.emitted`);
    appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), changeDigest }) + "\n", "utf8");
  } catch { /* advisory only; never fails an emit */ }
}

export function orphanedSessions(): string[] {
  try {
    const dir = join(journalDir(), "sessions");
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir);
    const emitted = new Set(files.filter((f) => f.endsWith(".emitted")).map((f) => f.slice(0, -8)));
    return files
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -6))
      .filter((id) => !emitted.has(id));
  } catch {
    return [];
  }
}

/**
 * RFC 0001 section 13 — fail open toward the developer's work, fail closed
 * toward evidence. Errors are recorded and surfaced; they never propagate into
 * the agent session, and they never produce a partial receipt.
 */
export function recordError(sessionId: string, message: string): void {
  try {
    mkdirSync(journalDir(), { recursive: true });
    appendFileSync(
      join(journalDir(), "errors.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), sessionId, message }) + "\n",
      "utf8",
    );
  } catch {
    /* the error journal failing must not fail anything else */
  }
}
