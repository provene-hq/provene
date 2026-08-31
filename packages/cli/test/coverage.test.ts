/**
 * The classifier that decides whether an annotation is signal or noise.
 *
 * Every state below was a bug before it was a case: counting braces as
 * untested, warning about package.json, warning about declaration files
 * forever, matching lcov paths in one direction only, and silently attaching
 * one file's coverage to another in a monorepo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLcov, evidenceFor, instrumentedExtensions } from "../src/coverage.ts";

const LCOV = `TN:
SF:src/math.ts
DA:1,4
DA:2,0
DA:3,0
end_of_record
`;
const cov = (): Map<string, Map<number, number>> => parseLcov(LCOV);
const exts = (): Set<string> => instrumentedExtensions(cov());
const only = (changed: Map<string, Set<number>>, c = cov(), e = exts()) => evidenceFor(changed, c, e)[0]!;

test("parses lcov into per-line execution counts", () => {
  const c = cov();
  assert.deepEqual([...c.keys()], ["src/math.ts"]);
  assert.equal(c.get("src/math.ts")!.get(1), 4);
  assert.equal(c.get("src/math.ts")!.get(2), 0);
});

test("lines absent from lcov are not executable and are not counted", () => {
  // Line 9 is a closing brace: no DA entry. Counting it as unverified would
  // put a warning on every brace in the diff.
  const f = only(new Map([["src/math.ts", new Set([1, 2, 9])]]));
  assert.equal(f.kind, "instrumented");
  if (f.kind !== "instrumented") return;
  assert.equal(f.changed, 2, "only executable changed lines are counted");
  assert.equal(f.covered, 1);
  assert.deepEqual(f.uncoveredRanges, [{ start: 2, end: 2 }]);
});

test("matches lcov paths shorter than the repo-relative path", () => {
  const f = only(new Map([["packages/cli/src/math.ts", new Set([1, 2])]]));
  assert.equal(f.kind, "instrumented", "suffix match must work in this direction");
});

test("matches lcov paths longer than the repo-relative path", () => {
  const abs = parseLcov("SF:/home/runner/work/repo/src/math.ts\nDA:1,4\nend_of_record\n");
  const f = only(new Map([["src/math.ts", new Set([1])]]), abs, instrumentedExtensions(abs));
  assert.equal(f.kind, "instrumented", "absolute lcov paths must match too");
});

test("an equally-good match in two packages is ambiguous, never guessed", () => {
  // A monorepo with two src/utils.ts. Attaching one file's coverage to the
  // other is worse than reporting nothing.
  const c = parseLcov(
    "SF:apps/api/src/utils.ts\nDA:1,5\nend_of_record\n" +
    "SF:packages/common/src/utils.ts\nDA:1,0\nend_of_record\n");
  const f = only(new Map([["src/utils.ts", new Set([1])]]), c, instrumentedExtensions(c));
  assert.equal(f.kind, "ambiguous");
  if (f.kind !== "ambiguous") return;
  assert.equal(f.candidates.length, 2);
});

test("a file of an instrumented kind with no coverage entry is untested", () => {
  const f = only(new Map([["src/other.ts", new Set([1])]]));
  assert.equal(f.kind, "untested", "this is the loudest signal there is");
});

test("a file of a kind the run never instruments is not evidence of anything", () => {
  const f = only(new Map([["package.json", new Set([3])]]));
  assert.equal(f.kind, "not-instrumentable");
});

test("declaration files can never be covered and are never warned about", () => {
  for (const p of ["src/types.ts", "src/api.d.ts", "types.ts"]) {
    assert.equal(only(new Map([[p, new Set([1])]])).kind, "declaration", p);
  }
});

test("an instrumented file whose changed lines are all non-executable is a declaration", () => {
  const f = only(new Map([["src/math.ts", new Set([50, 51])]]));
  assert.equal(f.kind, "declaration", "no executable line changed, so nothing is untested");
});

test("contiguous uncovered lines collapse into one range", () => {
  const c = parseLcov("SF:a.ts\nDA:1,0\nDA:2,0\nDA:3,0\nDA:5,0\nend_of_record\n");
  const f = only(new Map([["a.ts", new Set([1, 2, 3, 5])]]), c, instrumentedExtensions(c));
  assert.equal(f.kind, "instrumented");
  if (f.kind !== "instrumented") return;
  assert.deepEqual(f.uncoveredRanges, [{ start: 1, end: 3 }, { start: 5, end: 5 }]);
});
