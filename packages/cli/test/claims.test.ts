/**
 * Things a receipt must not be able to say.
 *
 * Each case below was true of this codebase until an audit of the README found
 * it. They share a shape: the tool accepted a claim from somewhere it should
 * not have trusted, and then put that claim somewhere that made it look
 * checked — a signed predicate, or a tier report.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDsseEnvelope, buildT0 } from "../src/receipt.ts";

test("a document is only a signed envelope if it looks like one", () => {
  // The hole: `verify forged.dsse.json` reported T2, exit 0, on a file that was
  // a renamed unsigned statement with one field edited. The filename decides
  // WHICH question is asked (RFC 0001 §8); it cannot answer it.
  const statement = buildT0({
    subjectName: "x@main",
    entries: [{ status: "A", path: "a.ts", preBlob: "-", postBlob: "b".repeat(40) }],
    parent: "c".repeat(40),
    agent: { tool: "claude-code" },
    emitter: { name: "provene", version: "0.0.0" },
    commands: [], runs: [], attributedPaths: [],
  });
  assert.equal(isDsseEnvelope(statement), false, "a bare Statement is not an envelope");

  for (const notAnEnvelope of [
    null, undefined, 42, "string", [],
    {},
    { payload: "e30=" },                                     // no type, no signatures
    { payload: "e30=", payloadType: "application/x" },       // no signatures
    { payload: "e30=", payloadType: "application/x", signatures: [] },  // empty
    { payloadType: "application/x", signatures: [{ sig: "a" }] },       // no payload
    { payload: 42, payloadType: "application/x", signatures: [{ sig: "a" }] },
  ]) {
    assert.equal(isDsseEnvelope(notAnEnvelope), false, `accepted: ${JSON.stringify(notAnEnvelope)}`);
  }

  assert.equal(isDsseEnvelope({
    payload: "e30=",
    payloadType: "application/vnd.in-toto+json",
    signatures: [{ sig: "MEUCIQ..." }],
  }), true);
});

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

/** A repository with one committed change, ready for `promote`. */
function repoWithAChange(): string {
  const dir = mkdtempSync(join(tmpdir(), "provene-claims-"));
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("init", "-q", ".");
  git("config", "user.email", "a@b.c");
  git("config", "user.name", "t");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
  git("add", "-A"); git("commit", "-qm", "base");
  writeFileSync(join(dir, "src/a.ts"), "export const a = 2;\n");
  git("add", "-A"); git("commit", "-qm", "change");
  return dir;
}

const promote = (dir: string, extra: string[]) => {
  const out = join(dir, "agg.json");
  try {
    execFileSync(process.execPath,
      [CLI, "promote", "--base", "HEAD~1", "--attester", "ci", "--out", out, ...extra],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return { failed: true, output: String((e as { stdout?: string }).stdout ?? "") };
  }
  return { failed: false, predicate: JSON.parse(readFileSync(out, "utf8")) as Record<string, any> };
};

test("a test result CI did not observe cannot be invented at the command line", () => {
  const dir = repoWithAChange();
  try {
    // `--test-result "definitely-passed"` was uppercased and written into the
    // predicate verbatim, then signed. A signed receipt is the last place an
    // unvalidated string from a workflow file belongs.
    for (const bad of ["definitely-passed", "green", "ok", "", "PASSED "]) {
      const r = promote(dir, ["--test-result", bad]);
      assert.equal(r.failed, true, `accepted ${JSON.stringify(bad)}`);
    }
    for (const good of ["PASSED", "passed", "WARNED", "FAILED"]) {
      const r = promote(dir, ["--test-result", good]);
      assert.equal(r.failed, false, `rejected ${good}`);
      assert.equal(r.predicate!["verification"].runs[0].result, good.toUpperCase());
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("with no coverage report, every changed path is unverified", () => {
  const dir = repoWithAChange();
  try {
    // This produced `unverifiedPaths: []` next to a PASSED run, which reads as
    // "every changed path was covered" -- and got signed. RFC 0001 §6.6: the
    // field lists changed paths no run covers, and with no evidence at all
    // that is all of them.
    const r = promote(dir, ["--test-result", "PASSED"]);
    assert.equal(r.failed, false);
    assert.deepEqual(r.predicate!["verification"].unverifiedPaths, ["src/a.ts"]);
    assert.equal(r.predicate!["verification"].runs[0].result, "PASSED");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a merge commit CI generated is not counted against coverage", () => {
  // Found by the first real signature this project produced, not by review.
  // CI is handed refs/pull/N/merge, a commit that exists in nobody's checkout,
  // so counting it made the signed aggregate claim one more commit than any
  // verifier could find: "signed over 2 commit(s); this range has 1", on a
  // branch holding exactly one commit. It would have fired on every
  // verification forever.
  const dir = mkdtempSync(join(tmpdir(), "provene-merge-"));
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    git("init", "-q", ".");
    git("config", "user.email", "a@b.c"); git("config", "user.name", "t");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    git("add", "-A"); git("commit", "-qm", "base");
    const main = git("rev-parse", "--abbrev-ref", "HEAD");

    git("checkout", "-qb", "feature");
    writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
    git("add", "-A"); git("commit", "-qm", "the author's one commit");

    git("checkout", "-q", main);
    writeFileSync(join(dir, "c.ts"), "export const c = 3;\n");
    git("add", "-A"); git("commit", "-qm", "main moved on");
    const baseTip = git("rev-parse", "HEAD");

    // What actions/checkout hands a pull_request job.
    git("checkout", "-qb", "pr-merge", baseTip);
    git("merge", "-q", "--no-ff", "--no-edit", "feature");
    const mergeCommit = git("rev-parse", "HEAD");

    const out = join(dir, "agg.json");
    execFileSync(process.execPath,
      [CLI, "promote", "--base", baseTip, "--head", mergeCommit, "--attester", "ci", "--out", out],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const predicate = JSON.parse(readFileSync(out, "utf8")) as Record<string, any>;

    // One commit: the one a person wrote. Not two.
    assert.equal(predicate["coverage"].commitsInRange, 1,
      "the pull-request merge commit must not be counted");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
