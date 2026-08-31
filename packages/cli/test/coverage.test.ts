/**
 * The check pipeline told us cli.ts and git.ts have no test loading them.
 * These cover the part with real logic: lcov parsing, path reconciliation, and
 * the two distinctions that decide whether an annotation is signal or noise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLcov, evidenceFor } from "../src/coverage.ts";

const LCOV = `TN:
SF:src/math.ts
DA:1,4
DA:2,0
DA:3,0
end_of_record
`;

test("parses lcov into per-line execution counts", () => {
  const cov = parseLcov(LCOV);
  assert.deepEqual([...cov.keys()], ["src/math.ts"]);
  assert.equal(cov.get("src/math.ts")!.get(1), 4);
  assert.equal(cov.get("src/math.ts")!.get(2), 0);
});

test("lines absent from lcov are not executable and are not counted", () => {
  // Line 9 is a closing brace: no DA entry. Counting it as unverified would
  // put a warning on every brace in the diff.
  const changed = new Map([["src/math.ts", new Set([1, 2, 9])]]);
  const [file] = evidenceFor(changed, parseLcov(LCOV));
  assert.equal(file!.changed, 2, "only executable changed lines are counted");
  assert.equal(file!.covered, 1);
  assert.deepEqual(file!.uncoveredRanges, [{ start: 2, end: 2 }]);
});

test("matches lcov paths that are shorter than the repo-relative path", () => {
  // lcov written from a package subdirectory: src/math.ts vs packages/cli/src/math.ts
  const changed = new Map([["packages/cli/src/math.ts", new Set([1, 2])]]);
  const [file] = evidenceFor(changed, parseLcov(LCOV));
  assert.equal(file!.instrumented, true, "suffix match must work in this direction");
  assert.equal(file!.covered, 1);
});

test("matches lcov paths that are longer than the repo-relative path", () => {
  const abs = parseLcov("SF:/home/runner/work/repo/src/math.ts\nDA:1,4\nend_of_record\n");
  const changed = new Map([["src/math.ts", new Set([1])]]);
  const [file] = evidenceFor(changed, abs);
  assert.equal(file!.instrumented, true, "absolute lcov paths must match too");
  assert.equal(file!.covered, 1);
});

test("a file with no coverage entry is marked uninstrumented, not untested", () => {
  const changed = new Map([["package.json", new Set([3])]]);
  const [file] = evidenceFor(changed, parseLcov(LCOV));
  assert.equal(file!.instrumented, false);
  assert.deepEqual(file!.uncoveredRanges, [], "must not produce line annotations");
});

test("contiguous uncovered lines collapse into one range", () => {
  const cov = parseLcov("SF:a.ts\nDA:1,0\nDA:2,0\nDA:3,0\nDA:5,0\nend_of_record\n");
  const changed = new Map([["a.ts", new Set([1, 2, 3, 5])]]);
  const [file] = evidenceFor(changed, cov);
  assert.deepEqual(file!.uncoveredRanges, [{ start: 1, end: 3 }, { start: 5, end: 5 }]);
});
