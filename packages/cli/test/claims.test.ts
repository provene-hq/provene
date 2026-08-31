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
import { execFileSync, spawnSync } from "node:child_process";
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

test("the first command a new user runs does not look like a crash", () => {
  // `provene doctor` in a repository with no commits printed a raw
  // `fatal: ambiguous argument 'HEAD'` from git above its own perfectly clear
  // "no root commit — commit something first". The first thing this tool ever
  // showed a new user looked like it had broken.
  //
  // Found by installing the published package on a machine that had never seen
  // this repository and following the README, which no test in here can do.
  // This is the closest a test can get: nothing may reach stderr that this
  // tool did not choose to say.
  const dir = mkdtempSync(join(tmpdir(), "provene-firstrun-"));
  try {
    execFileSync("git", ["init", "-q", "."], { cwd: dir, stdio: "ignore" });
    const r = spawnSync(process.execPath, [CLI, "doctor"], {
      cwd: dir, encoding: "utf8",
      env: { ...process.env, PROVENE_HOME: join(dir, "home") },
    });
    assert.equal(r.stderr, "", `leaked to stderr:\n${r.stderr}`);
    // and it still says the useful thing, in its own words
    assert.match(r.stdout, /no root commit/);
    assert.doesNotMatch(r.stdout, /fatal:/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no command leaks a subprocess's error text to stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "provene-stderr-"));
  try {
    execFileSync("git", ["init", "-q", "."], { cwd: dir, stdio: "ignore" });
    const env = { ...process.env, PROVENE_HOME: join(dir, "home") };
    // Every command, in a repository where most of them cannot succeed.
    for (const argv of [
      ["doctor"],
      ["check", "--base", "HEAD"],
      ["manifest", "--base", "HEAD"],
      ["verify", "no-such-file.statement.json"],
      ["promote", "--base", "HEAD", "--attester", "x", "--out", join(dir, "a.json")],
      ["emit", "--session", "nothing"],
    ]) {
      const r = spawnSync(process.execPath, [CLI, ...argv], { cwd: dir, encoding: "utf8", env });
      assert.equal(r.stderr, "", `${argv[0]} leaked to stderr:\n${r.stderr}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("asking for help is not a usage error", () => {
  // `provene --help` exited 2, so a Makefile or CI step running it as a sanity
  // check saw a failure. Reported by someone installing the published package
  // who had no reason to know what the exit code meant.
  for (const argv of [["--help"], ["-h"], ["help"], []]) {
    const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8" });
    assert.equal(r.status, 0, `${argv[0] ?? "<no args>"} exited ${r.status}`);
    assert.match(r.stdout, /evidence receipts/);
    assert.equal(r.stderr, "");
  }
  // An actual mistake still is one.
  const bad = spawnSync(process.execPath, [CLI, "nonsense"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
});

test("init warns about the two things that make it look broken", () => {
  const dir = mkdtempSync(join(tmpdir(), "provene-init-"));
  try {
    const settings = join(dir, "settings.json");
    writeFileSync(settings, "{}");
    const r = spawnSync(process.execPath, [CLI, "init", "--settings", settings], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // Hooks are read at startup: a session already open writes nothing, and
    // the user concludes the tool does not work.
    assert.match(r.stdout, /restart it/);
    // -a stages modified tracked files; a new receipt is neither.
    assert.match(r.stdout, /git commit -am/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an option the tool does not understand is never silently discarded", () => {
  // Found in the wild: `provene init --agent gemini` on a build predating
  // --agent installed CLAUDE hooks into Claude's settings file and reported
  // success. The parser accepts any --word and each command reads only the keys
  // it knows, so a request the tool could not honour became one it could.
  const cases: Array<[string[], RegExp]> = [
    [["init", "--agnet", "gemini"], /unknown option --agnet, did you mean --agent\?/],
    [["init", "--agent-vendor", "google"], /unknown option --agent-vendor/],
    [["emit", "--sesion", "x"], /did you mean --session\?/],
    [["check", "--covrage", "l.info"], /did you mean --coverage\?/],
    [["promote", "--totally-made-up"], /unknown option --totally-made-up/],
    [["verify-aggregate", "--repo", "o/n", "--signer_workflow", "x"], /unknown option --signer_workflow/],
  ];
  for (const [argv, expected] of cases) {
    const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8" });
    assert.equal(r.status, 2, `${argv.join(" ")} exited ${r.status}`);
    assert.match(r.stdout, expected);
    assert.match(r.stdout, /check `provene --version`/);
    assert.equal(r.stderr, "");
  }
});

test("every flag the action and the docs actually pass is accepted", () => {
  // The rejection above is only safe if the accepted list is complete. These
  // are the invocations action.yml and both READMEs tell people to run; a flag
  // missing from the table would turn a working command into an error.
  const known: Array<string[]> = [
    ["check", "--base", "HEAD", "--head", "HEAD", "--coverage", "l.info",
     "--exclude", "a,b", "--annotate", "github", "--format", "json"],
    ["promote", "--base", "HEAD", "--head", "HEAD", "--attester", "x", "--issuer", "y",
     "--coverage", "l.info", "--out", "o.json", "--manifest", "m", "--public",
     "--pull-request", "u", "--run-url", "u", "--target-ref", "r",
     "--test-result", "PASSED", "--test-tool", "vitest"],
    ["manifest", "--base", "HEAD", "--head", "HEAD", "--out", "m"],
    ["verify-aggregate", "--repo", "o/n", "--base", "HEAD", "--head", "HEAD",
     "--bundle", "b.json", "--cert-identity", "i", "--signer-workflow", "w"],
    ["emit", "--session", "s", "--base", "HEAD", "--tool", "t", "--vendor", "v",
     "--tool-version", "1", "--model", "m", "--model-source", "reported",
     "--subject", "s@main", "--task", "u", "--quiet"],
    ["record", "--session", "s", "--kind", "command", "--argv", "npm test",
     "--exit", "0", "--duration-ms", "1", "--agent", "gemini"],
    ["init", "--agent", "gemini", "--settings", "s.json", "--dry-run"],
    ["doctor", "--agent", "gemini", "--settings", "s.json"],
  ];
  for (const argv of known) {
    const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8" });
    assert.doesNotMatch(r.stdout, /unknown option/, `${argv[0]}: ${r.stdout}`);
  }
});
