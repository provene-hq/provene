/** Git plumbing. Porcelain output is for humans and changes between versions. */
import { execFileSync } from "node:child_process";
import type { ChangeEntry, ChangeStatus } from "./changedigest.ts";

export function git(args: readonly string[], cwd?: string): string {
  return execFileSync("git", args as string[], {
    encoding: "utf8",
    cwd: cwd ?? process.cwd(),
    maxBuffer: 64 * 1024 * 1024,
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
function untrackedEntries(cwd?: string): ChangeEntry[] {
  const listed = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
    cwd: cwd ?? process.cwd(),
    maxBuffer: 64 * 1024 * 1024,
  });
  return listed
    .split("\0")
    .filter((f) => f !== "")
    .map((path) => ({
      status: "A" as const,
      path,
      preBlob: "-",
      postBlob: execFileSync("git", ["hash-object", "--", path], {
        encoding: "utf8",
        cwd: cwd ?? process.cwd(),
      }).trim(),
    }));
}

/**
 * Parses `git diff --raw -z`, whose records are
 *   :<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0
 * with renames and copies carrying a second NUL-separated path.
 */
export function diffEntries(base: string, cwd?: string): ChangeEntry[] {
  const raw = execFileSync("git", ["diff", "--raw", "-M", "-z", base], {
    encoding: "utf8",
    cwd: cwd ?? process.cwd(),
    maxBuffer: 64 * 1024 * 1024,
  });
  const fields = raw.split("\0");
  const out: ChangeEntry[] = [];

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

    const isRenameOrCopy = letter === "R" || (letter as string) === "C";
    const first = fields[i + 1] ?? "";
    const second = isRenameOrCopy ? (fields[i + 2] ?? "") : undefined;
    i += isRenameOrCopy ? 3 : 2;

    const nullOid = /^0+$/;
    out.push({
      status: letter === "R" ? "R" : letter,
      path: second ?? first,
      ...(letter === "R" ? { prePath: first } : {}),
      preBlob: nullOid.test(preBlob) ? "-" : preBlob,
      postBlob: nullOid.test(postBlob) ? "-" : postBlob,
    });
  }
  return [...out, ...untrackedEntries(cwd)];
}
