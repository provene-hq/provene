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
import { normalizePath, isWithin } from "../src/paths.ts";
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
