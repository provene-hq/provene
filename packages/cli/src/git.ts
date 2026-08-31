/** Git plumbing. Porcelain output is for humans and changes between versions. */
import { execFileSync } from "node:child_process";
import type { ChangeEntry, ChangeStatus } from "./changedigest.ts";

/**
 * Run git and return its stdout.
 *
 * `stderr: "pipe"` is not tidiness. Without it git's stderr is inherited and
 * printed straight at the user, so `provene doctor` in a repository with no
 * commits -- a brand new repository, the first command a new user runs --
 * opened with a raw `fatal: ambiguous argument 'HEAD'` above its own perfectly
 * clear "no root commit — commit something first". The first thing this tool
 * ever showed a new user looked like a crash.
 *
 * Every failure this module can produce is one a caller already handles and
 * reports in its own words. Captured here, git's text stays available on the
 * thrown error and is shown to nobody by default.
 *
 * Found by installing the published package on a clean machine and following
 * the README, which is not something any test in this repository can do.
 */
export function git(args: readonly string[], cwd?: string): string {
  return execFileSync("git", args as string[], {
    encoding: "utf8",
    cwd: cwd ?? process.cwd(),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/\n$/, "");
}

export function repoRoot(cwd?: string): string {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

export function headCommit(cwd?: string): string {
  return git(["rev-parse", "HEAD"], cwd);
}

/**
 * RFC 0001 section 6.2 — the salt is derived from the root commit, and where a
 * repository has several (grafted or merged histories) the lexicographically
 * smallest is used so that derivation is deterministic across clones.
 */
export function rootCommit(cwd?: string): string {
  const roots = git(["rev-list", "--max-parents=0", "HEAD"], cwd).split("\n").filter(Boolean);
  if (roots.length === 0) throw new Error("repository has no root commit");
  return roots.slice().sort()[0]!;
}

/**
 * Untracked files.
 *
 * `git diff --raw` compares the tracked working tree against a commit and says
 * nothing about files git has never seen. An agent that creates a new file --
 * which is much of what agents do -- would otherwise produce a receipt that does
 * not mention it at all. Found by end-to-end testing, not by review.
 */
const isNullOid = (oid: string): boolean => /^0+$/.test(oid);

/**
 * The blob ids the working-tree contents WOULD have. Writes nothing to the
 * object store.
 *
 * Batched through --stdin-paths rather than one process per file: a session
 * that touches two hundred files was spawning two hundred git processes, and
 * process creation dominates on Windows in particular. --stdin-paths cannot
 * express a path containing a newline, so those few fall back to one call each
 * rather than being silently misattributed.
 */
function hashObjects(paths: readonly string[], cwd?: string): Map<string, string> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;

  const awkward = paths.filter((p) => p.includes("\n"));
  const batchable = paths.filter((p) => !p.includes("\n"));

  if (batchable.length > 0) {
    try {
      const stdout = execFileSync("git", ["hash-object", "--stdin-paths"], {
        encoding: "utf8",
        cwd: cwd ?? process.cwd(),
        input: batchable.join("\n") + "\n",
        maxBuffer: 64 * 1024 * 1024,
      });
      const oids = stdout.split("\n").filter((l) => l !== "");
      // A short reply means git skipped something; pairing by position would
      // then attach the wrong content to the wrong path, which is worse than
      // recording nothing at all.
      if (oids.length === batchable.length) {
        batchable.forEach((p, i) => out.set(p, oids[i]!));
      }
    } catch { /* fall through to per-file below */ }
  }

  for (const p of [...awkward, ...batchable.filter((p) => !out.has(p))]) {
    try {
      out.set(p, execFileSync("git", ["hash-object", "--", p], {
        encoding: "utf8", cwd: cwd ?? process.cwd(),
      }).trim());
    } catch {
      out.set(p, "-"); // the file is gone; the status letter already says so
    }
  }
  return out;
}

function untrackedEntries(cwd?: string): ChangeEntry[] {
  const listed = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
    cwd: cwd ?? process.cwd(),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const paths = listed.split("\0").filter((f) => f !== "");
  const oids = hashObjects(paths, cwd);
  return paths.map((path) => ({
    status: "A" as const,
    path,
    preBlob: "-",
    postBlob: oids.get(path) ?? "-",
  }));
}

/**
 * Parses `git diff --raw -z`, whose records are
 *   :<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0
 * with renames and copies carrying a second NUL-separated path.
 */
/**
 * The merge base of two commits, or undefined where git cannot compute one.
 *
 * A range in this tool means what a reviewer is looking at on the pull request
 * page, which is the THREE-dot diff: `base...head`, equivalently
 * `merge-base(base, head)..head`. A two-dot diff against a base branch that has
 * moved on reports the base branch's own newer commits as deletions performed
 * by the branch under review.
 *
 * Undefined rather than throwing: a shallow clone legitimately cannot compute
 * this, and refusing to run there would be worse than the two-dot answer, which
 * is what the caller falls back to — loudly.
 */
export function mergeBase(a: string, b: string, cwd?: string): string | undefined {
  try { return git(["merge-base", a, b], cwd); } catch { return undefined; }
}

/**
 * The change set between a commit and the WORKING TREE, including files git has
 * never seen.
 *
 * This is the right question at the end of an agent session: the receipt is
 * written before the commit exists, so uncommitted edits and new files are
 * exactly what it must bind to.
 *
 * It is the WRONG question for anything covering a committed range — see
 * `committedEntries`. The name `diffEntries` did not say which, and a reviewer
 * found the consequence: `promote` used it in CI, where a build step had
 * already dirtied the tree, so the signed digest covered `coverage/lcov.info`
 * and an npm-rewritten lockfile alongside the one file the pull request
 * actually changed. No checkout of that commit can ever reproduce it, so the
 * signature was guaranteed to fail verification forever.
 */
export function workingTreeEntries(base: string, cwd?: string): ChangeEntry[] {
  // -z already defeats path quoting for --raw, but core.quotePath is pinned so
  // behaviour does not depend on the user's configuration.
  // core.abbrev=no is essential, not cosmetic. `git diff --raw` ABBREVIATES
  // object ids by default -- seven characters -- so a tracked modification was
  // recorded with a truncated blob while an untracked file, hashed directly,
  // got the full forty. The same content therefore produced different digests
  // before and after being committed, and the abbreviated form does not even
  // satisfy this project's own JSON Schema. Found by a property test asserting
  // that committing unchanged content leaves the digest alone.
  // Preferred over --abbrev=40, which would be wrong in a SHA-256 repository.
  const raw = execFileSync("git", [
    "-c", "core.quotePath=false", "-c", "core.abbrev=no",
    "diff", "--raw", "-M", "-z", base,
  ], {
    encoding: "utf8",
    cwd: cwd ?? process.cwd(),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { pending, needHashing } = parseRaw(raw);
  const hashed = hashObjects(needHashing, cwd);
  const out: ChangeEntry[] = pending.map((e) => ({
    ...e,
    postBlob: e.postBlob !== "" ? e.postBlob : (e.status === "D" ? "-" : hashed.get(e.path) ?? "-"),
  }));
  return [...out, ...untrackedEntries(cwd)];
}

/**
 * Splits `git diff --raw -z` into records.
 *
 * `postBlob` is left as "" where git reported all-zeros, meaning "no blob
 * object exists for this side yet". Only the working-tree caller can resolve
 * that, by hashing the file; between two commits it cannot occur.
 */
function parseRaw(raw: string): {
  pending: Array<ChangeEntry & { postBlob: string }>;
  needHashing: string[];
} {
  const fields = raw.split("\0");
  const pending: Array<ChangeEntry & { postBlob: string }> = [];
  const needHashing: string[] = [];

  let i = 0;
  while (i < fields.length) {
    const meta = fields[i];
    if (meta === undefined || meta === "") break;
    const parts = meta.slice(1).split(" ");
    const preBlob = parts[2] ?? "";
    const postBlob = parts[3] ?? "";
    const statusField = parts[4] ?? "";
    const letter = statusField[0] as ChangeStatus | undefined;
    if (letter === undefined) break;

    const isRenameOrCopy = letter === "R" || letter === "C";
    const first = fields[i + 1] ?? "";
    const second = isRenameOrCopy ? (fields[i + 2] ?? "") : undefined;
    i += isRenameOrCopy ? 3 : 2;

    const path = second ?? first;
    if (isNullOid(postBlob) && letter !== "D") needHashing.push(path);
    pending.push({
      status: letter,
      path,
      ...(isRenameOrCopy ? { prePath: first } : {}),
      preBlob: isNullOid(preBlob) ? "-" : preBlob,
      // A working-tree modification has no blob object yet, so git reports
      // all-zeros for the post image. Hashing the file gives the digest real
      // content to bind to -- without this, two entirely different unstaged
      // edits to the same path produce the SAME change digest, which is the
      // normal case at session end and makes the binding decorative.
      postBlob: isNullOid(postBlob) ? "" : postBlob, // resolved by the caller
    });
  }
  return { pending, needHashing };
}

/**
 * The change set between two COMMITS.
 *
 * Nothing here touches the working tree: both sides are committed objects, so
 * every blob id is real and there is nothing to hash and no untracked file to
 * consider. This is what any later verifier can reproduce from a checkout,
 * which is the only kind of change set worth signing.
 */
export function committedEntries(base: string, head: string, cwd?: string): ChangeEntry[] {
  const raw = execFileSync("git", [
    "-c", "core.quotePath=false", "-c", "core.abbrev=no",
    "diff", "--raw", "-M", "-z", base, head,
  ], { encoding: "utf8", cwd: cwd ?? process.cwd(), maxBuffer: 64 * 1024 * 1024,
       stdio: ["ignore", "pipe", "pipe"] });
  const { pending } = parseRaw(raw);
  // A deletion has no post image; nothing else between two commits can lack a
  // blob object, so an empty postBlob here would be a parse failure rather than
  // something to paper over with a hash of a working-tree file.
  return pending.map((e) => {
    if (e.postBlob === "" && e.status !== "D") {
      throw new Error(`git reported no post-image blob for ${e.path} between two commits`);
    }
    return { ...e, postBlob: e.status === "D" ? "-" : e.postBlob };
  });
}
