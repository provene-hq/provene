/**
 * Path comparison, which decides what a receipt is allowed to claim.
 *
 * Both helpers normalised separators and never resolved segments, so
 * `/repo/../elsewhere/a.ts` begins with `/repo/` and a prefix test answered
 * "inside this repository" for a file that is not in it. That defeats the
 * repository scoping added in 0.7.0 in exactly the case it exists for: an agent
 * session that worked in more than one project.
 *
 * Found by reading the diff rather than by a failing test, which is why the
 * traversal cases below are written first and the ordinary ones after.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePath, realPath, isWithin } from "../src/paths.ts";
import { withinRepo, antigravityEntries } from "../src/antigravity.ts";

test("a path cannot escape the repository and still be counted as inside it", () => {
  for (const escape of [
    "/repo/../elsewhere/a.ts",
    "/repo/sub/../../elsewhere/a.ts",
    "/repo/./../elsewhere/a.ts",
    "/repo/a/b/../../../elsewhere.ts",
  ]) {
    assert.equal(isWithin(escape, "/repo", false), false, escape);
    assert.equal(withinRepo(escape, "/repo", false), false, escape);
  }
  // Windows spelling, mixed case, mixed separators — the real shape of a
  // transcript path on the machine this was found on.
  assert.equal(withinRepo("e:\\provene\\..\\QTD\\secret.md", "E:/provene", true), false);
});

test("a path that stays inside is still inside, however it is spelled", () => {
  for (const inside of [
    "/repo/a.ts", "/repo/./a.ts", "/repo/sub/../a.ts", "/repo/sub/deep/../../a.ts",
  ]) {
    assert.equal(isWithin(inside, "/repo", false), true, inside);
  }
  assert.equal(isWithin("/repo", "/repo", false), true);
  assert.equal(isWithin("/repo/", "/repo", false), true);
  // A neighbour whose name merely starts the same way is not inside.
  assert.equal(isWithin("/repository/a.ts", "/repo", false), false);
  assert.equal(isWithin("/repo-2/a.ts", "/repo", false), false);
});

test("`..` never climbs above a root, and never disappears from a relative path", () => {
  // Above the root there is nothing to climb to, so it is discarded.
  assert.equal(normalizePath("/../../etc/passwd"), "/etc/passwd");
  assert.equal(normalizePath("C:/../Windows"), "C:/Windows");
  // With no root, dropping it would turn "somewhere else" into "in here".
  assert.equal(normalizePath("../other/a.ts"), "../other/a.ts");
  assert.equal(normalizePath("../../other/a.ts"), "../../other/a.ts");
  assert.equal(normalizePath("sub/../a.ts"), "a.ts");
  assert.equal(normalizePath("./a.ts"), "a.ts");
  assert.equal(normalizePath("a//b///c.ts"), "a/b/c.ts");
  assert.equal(normalizePath("/repo/"), "/repo");
});

test("a transcript cannot attribute a file outside the repository by writing `..`", () => {
  const enc = (v: unknown): string => JSON.stringify(v);
  const step = (name: string, args: Record<string, unknown>): Record<string, unknown> => ({
    type: "PLANNER_RESPONSE", created_at: "2026-08-31T00:00:00Z",
    tool_calls: [{ name, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, enc(v)])) }],
  });
  const entries = antigravityEntries([
    step("replace_file_content", { TargetFile: "E:\\provene\\..\\QTD\\notes.md" }),
    step("run_command", { CommandLine: "npm test", Cwd: "E:\\provene\\..\\QTD" }),
    step("replace_file_content", { TargetFile: "E:\\provene\\src\\a.ts" }),
  ] as never, { repoRoot: "E:/provene", caseInsensitive: true });
  assert.deepEqual(entries.map((e) => [e.kind, e.path ?? e.argv?.join(" ")]),
    [["edit", "E:\\provene\\src\\a.ts"]]);
});

test("a drive-relative path is not silently promoted to a drive root", () => {
  // `C:foo` is relative to the working directory ON drive C, which this
  // process does not know. Resolving it to `C:/foo` invents an absolute path
  // and then compares it against a repository root as though it were fact.
  assert.equal(normalizePath("C:foo"), "C:foo");
  assert.equal(isWithin("C:foo", "C:/repo", false), false);
  assert.equal(isWithin("C:foo", "C:/foo", false), false);
  // A real drive root still is one.
  assert.equal(isWithin("C:/repo/a.ts", "C:/repo", false), true);
  assert.equal(normalizePath("E:/"), "E:");
});

test("a UNC path keeps its host and share", () => {
  // \\server\share normalised to /server/share loses the host entirely and
  // collides with a local path of the same spelling.
  assert.equal(normalizePath("\\\\server\\share\\repo\\a.ts"), "//server/share/repo/a.ts");
  assert.equal(isWithin("\\\\server\\share\\repo\\a.ts", "\\\\server\\share\\repo", false), true);
  assert.equal(isWithin("\\\\other\\share\\repo\\a.ts", "\\\\server\\share\\repo", false), false);
  // The share root is a root: `..` may not climb out of it into another share.
  assert.equal(normalizePath("//server/share/../../elsewhere/a.ts"), "//server/share/elsewhere/a.ts");
  assert.equal(isWithin("//server/share/../../other/x", "//server/share/repo", false), false);
});

/**
 * Two spellings of one directory.
 *
 * This is the bug CI found on two platforms at once while every local run was
 * green. macOS `os.tmpdir()` says `/var/folders/…` and
 * `git rev-parse --show-toplevel` says `/private/var/folders/…`; Windows hands
 * out `C:\Users\RUNNER~1` where git returns the long name. A lexical prefix
 * test calls that "somewhere else", so every command recorded with one spelling
 * is dropped as out-of-scope and the receipt ends up with no verification
 * evidence — silently, in the safe-looking direction.
 *
 * Reproduced here with a symlink, which is the same shape as the macOS `/var`
 * case and is testable on any platform that will make one.
 */
test("a symlinked path and its target are the same repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "provene-real-"));
  try {
    const target = join(dir, "target");
    const link = join(dir, "link");
    mkdirSync(join(target, "src"), { recursive: true });
    try {
      symlinkSync(target, link, "junction");
    } catch {
      return; // No permission to create one (ordinary on Windows). Nothing to test.
    }

    // Lexically these share no prefix at all.
    assert.notEqual(normalizePath(link), normalizePath(target));

    // The filesystem disagrees, and the filesystem is right.
    assert.equal(realPath(link), realPath(target));
    assert.equal(isWithin(join(link, "src"), target, false), true,
      "a command recorded through the symlink was ruled out of the repository");
    assert.equal(isWithin(join(target, "src"), link, false), true);

    // A path that does not exist still resolves through its nearest real
    // ancestor: a file the agent deleted must not become unattributable.
    assert.equal(isWithin(join(link, "src", "gone.ts"), target, false), true);
    assert.equal(isWithin(join(link, "src", "deep", "gone.ts"), target, false), true);

    // And a genuine outsider is still outside.
    assert.equal(isWithin(join(dir, "elsewhere", "a.ts"), target, false), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
