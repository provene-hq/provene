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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export interface JournalEntry {
  readonly at: string;
  readonly kind: "edit" | "command" | "test" | "note";
  readonly path?: string;
  /**
   * Where the agent was when this happened.
   *
   * A journal belongs to a SESSION, not to a repository, and a session is free
   * to work in more than one. Without this, `emit` in repository A recorded
   * every command the session ran anywhere -- including a test suite that
   * passed in repository B, as evidence about A. Optional because journals
   * written before this field existed, and third-party emitters that do not
   * supply it, must keep working: absent means unknown, and unknown is not
   * filtered. Known-and-elsewhere is.
   */
  readonly cwd?: string;
  readonly argv?: readonly string[];
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly detail?: Record<string, unknown>;
}

export function journalDir(): string {
  return process.env["PROVENE_HOME"] ?? join(homedir(), ".provene");
}

/**
 * The journal holds UNREDACTED commands -- raw argv, including any credentials
 * an agent passed on a command line. Redaction happens when the receipt is
 * built, not when the journal is written, precisely so the hook stays fast and
 * dumb. That is only safe while the journal lives outside every repository.
 *
 * If it does not, `emit` records the journal itself as a changed file and the
 * secrets it holds are committed. Found when a test harness pointed
 * PROVENE_HOME inside a repository and the receipt listed the journal.
 */
export function journalInsideRepo(repoRoot: string): boolean {
  const dir = resolve(journalDir());
  const root = resolve(repoRoot);
  return dir === root || dir.startsWith(root + sep);
}

/**
 * Session ids that are safe to put in a filename.
 *
 * A session id arrives from a hook payload — JSON this process did not write —
 * and was interpolated straight into a path. `session_id: "../../../pwned"`
 * therefore appended to `/home/pwned.jsonl`, and what it appended was the
 * journal's UNREDACTED contents: raw argv, including any credential an agent
 * passed on a command line. Demonstrated end to end before this fix, not
 * argued: one `provene record --stdin` wrote `echo AUTH=supersecret` outside
 * the journal directory entirely.
 *
 * Separators are excluded by the character class, so traversal is not
 * expressible rather than being stripped after the fact.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Rejected ids are not dropped and not passed through: they are replaced by a
 * deterministic name derived from the id itself.
 *
 * Dropping would lose a session's evidence to a malformed id — and this hook
 * must never cost a developer their work. Passing through is the vulnerability.
 * Hashing keeps the session recordable and keeps repeated hooks in the same
 * session landing in the same file.
 *
 * The name is deliberately dull: letters, digits and a hyphen. The first
 * version of this used a colon as the separator, which is illegal in a Windows
 * filename and would have thrown on the platform this project is developed on
 * — turning a security fix into a crash in the hot path of every hook, for
 * exactly the reason the reviewer's other finding names.
 *
 * A real session id of the form `unsafe-<32 hex>` would collide. That is
 * accepted: it requires guessing 128 bits, and the alternative shapes cost
 * either Windows compatibility or visibility to `doctor`.
 */
export function safeSessionId(raw: string): string {
  if (SAFE_SESSION_ID.test(raw)) return raw;
  return `unsafe-${createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32)}`;
}

export function journalPath(sessionId: string): string {
  return join(journalDir(), "sessions", `${safeSessionId(sessionId)}.jsonl`);
}

/**
 * Empties a session's journal.
 *
 * Only `import` uses this. A transcript can be imported twice -- the file does
 * not go away when you read it -- and appending the second read to the first
 * would double every command in the receipt, turning one passing test run into
 * two. Truncating is destructive, so it is never implicit: `import` refuses a
 * non-empty journal and names this flag rather than choosing for you.
 */
export function resetSession(sessionId: string): void {
  const p = journalPath(sessionId);
  if (existsSync(p)) writeFileSync(p, "", "utf8");
  // The emitted marker goes with it. Left behind, it says a receipt was
  // produced for evidence that has since been replaced, so `doctor` stays quiet
  // about a session holding newly imported work that was never emitted -- the
  // checkup silently stops covering the case it exists for.
  const marker = join(journalDir(), "sessions", `${safeSessionId(sessionId)}.emitted`);
  if (existsSync(marker)) rmSync(marker, { force: true });
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
    const p = join(journalDir(), "sessions", `${safeSessionId(sessionId)}.emitted`);
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
