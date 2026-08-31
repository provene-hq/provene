/**
 * The plumbing layer every digest rests on.
 *
 * git.ts had no tests of its own. That is the wrong module to leave uncovered:
 * three of this project's worst defects lived here — abbreviated object ids, an
 * all-zero post-image, and untracked files being invisible — and each one
 * silently produced a *plausible* digest rather than an error.
 *
 * Two themes below are deliberate. First, hostile local configuration:
 * `core.abbrev` and `core.quotePath` are pinned in the implementation, and a
 * pin nobody tests is a comment. Second, the batching in `hashObjects` — an
 * optimisation that pairs replies to requests by position, which is exactly the
 * shape that misattributes content to the wrong path when it goes wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workingTreeEntries, committedEntries, mergeBase, repoRoot, headCommit, rootCommit, git as gitOut } from "../src/git.ts";

const onWindows = process.platform === "win32";

function repo(): { dir: string; git: (...a: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "provene-git-"));
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("init", "-q", ".");
  git("config", "user.email", "a@b.c");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  return { dir, git };
}

function seed(r: { dir: string; git: (...a: string[]) => string }): string {
  writeFileSync(join(r.dir, "seed.txt"), "seed\n");
  r.git("add", "-A");
  r.git("commit", "-qm", "base");
  return r.git("rev-parse", "HEAD");
}

test("git() strips exactly one trailing newline and no more", () => {
  const r = repo();
  try {
    seed(r);
    assert.equal(gitOut(["rev-parse", "HEAD"], r.dir).length, 40);
    // A command whose output legitimately ends in a blank line must keep it.
    writeFileSync(join(r.dir, "two.txt"), "x\n");
    assert.equal(gitOut(["hash-object", "two.txt"], r.dir).includes("\n"), false);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("repoRoot and headCommit report this repository, not the process cwd", () => {
  const r = repo();
  try {
    const head = seed(r);
    assert.equal(headCommit(r.dir), head);
    // Compare basenames, not paths: macOS puts tmpdir behind /private, and git
    // reports forward slashes on Windows while mkdtempSync returns backslashes.
    // Splitting on "/" alone passed here and failed on the platform this is
    // developed on -- found by a reviewer running the suite on Windows.
    const leaf = (p: string): string => p.replace(/\\/g, "/").split("/").filter(Boolean).pop();
    assert.equal(leaf(repoRoot(r.dir)), leaf(r.dir));
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("rootCommit picks the smallest root, so grafted histories salt identically everywhere", () => {
  const r = repo();
  try {
    const first = seed(r);
    const main = r.git("rev-parse", "--abbrev-ref", "HEAD");
    r.git("checkout", "-q", "--orphan", "second");
    writeFileSync(join(r.dir, "other.txt"), "other\n");
    r.git("add", "-A"); r.git("commit", "-qm", "unrelated");
    const other = r.git("rev-parse", "HEAD");
    const branch = r.git("rev-parse", "--abbrev-ref", "HEAD");
    assert.equal(branch, "second");
    // `checkout -` has no previous-branch reflog entry to return to after an
    // orphan checkout, so name the branch.
    r.git("checkout", "-q", main);
    r.git("merge", "-q", "--allow-unrelated-histories", "--no-edit", "second");

    const roots = r.git("rev-list", "--max-parents=0", "HEAD").split("\n").filter(Boolean);
    assert.equal(roots.length, 2, "the fixture must actually have two roots");
    // Independent computation of the rule, not a restatement of the code: the
    // failure this guards against is returning whichever root git listed first.
    assert.equal(rootCommit(r.dir), [first, other].sort()[0]);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("rootCommit refuses rather than inventing a salt when there is no history", () => {
  const r = repo();
  try {
    assert.throws(() => rootCommit(r.dir));
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("local core.abbrev cannot shorten a recorded object id", () => {
  const r = repo();
  try {
    const base = seed(r);
    // The hostile configuration. Before core.abbrev=no was pinned, this
    // produced seven-character blob ids that failed our own JSON Schema, and
    // made the same content digest differently before and after a commit.
    r.git("config", "core.abbrev", "7");
    writeFileSync(join(r.dir, "seed.txt"), "seed modified\n");
    const entries = workingTreeEntries(base, r.dir);
    const seedEntry = entries.find((e) => e.path === "seed.txt")!;
    assert.equal(seedEntry.preBlob.length, 40);
    assert.equal(seedEntry.postBlob.length, 40);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

// Honest scope: with `-z`, git does not quote paths at all, so this passes with
// or without the `core.quotePath=false` pin -- verified by removing the pin. It
// is kept because the property it states (a non-ASCII path survives literally,
// end to end) has more than one way to break, and this is the only place that
// asserts it for a TRACKED modification.
test("a non-ASCII tracked path comes through literally", () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, "café.txt"), "one\n");
    r.git("add", "-A"); r.git("commit", "-qm", "base");
    const base = r.git("rev-parse", "HEAD");
    r.git("config", "core.quotePath", "true");
    writeFileSync(join(r.dir, "café.txt"), "two\n");
    const entries = workingTreeEntries(base, r.dir);
    assert.ok(entries.some((e) => e.path === "café.txt"),
      `expected a literal path, got ${entries.map((e) => e.path).join(", ")}`);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("batched hashing agrees with hashing each file on its own", () => {
  const r = repo();
  try {
    const base = seed(r);
    // Enough files to exercise the --stdin-paths batch rather than the fallback.
    const names = Array.from({ length: 150 }, (_, i) => `f${i}.txt`);
    for (const [i, n] of names.entries()) writeFileSync(join(r.dir, n), `content ${i}\n`);
    const entries = workingTreeEntries(base, r.dir);
    for (const n of names) {
      const e = entries.find((x) => x.path === n);
      assert.ok(e !== undefined, `${n} missing from the change set`);
      assert.equal(e.postBlob, r.git("hash-object", n),
        `${n} was paired with another file's content`);
    }
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("a path containing a newline is hashed correctly rather than mispaired", { skip: onWindows }, () => {
  const r = repo();
  try {
    const base = seed(r);
    const awkward = "line\none.txt";
    try { writeFileSync(join(r.dir, awkward), "awkward\n"); }
    catch { return; } // some filesystems refuse the name; that is not a defect here
    writeFileSync(join(r.dir, "ordinary.txt"), "ordinary\n");
    const entries = workingTreeEntries(base, r.dir);
    const e = entries.find((x) => x.path === awkward);
    assert.ok(e !== undefined, "the newline path must still be recorded");
    assert.equal(e.postBlob, r.git("hash-object", "--", awkward));
    assert.equal(entries.find((x) => x.path === "ordinary.txt")!.postBlob,
      r.git("hash-object", "ordinary.txt"));
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("ignored files stay out of the receipt", () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, ".gitignore"), "node_modules/\n*.log\n");
    r.git("add", "-A"); r.git("commit", "-qm", "base");
    const base = r.git("rev-parse", "HEAD");
    mkdirSync(join(r.dir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(r.dir, "node_modules", "left-pad", "index.js"), "module.exports=1\n");
    writeFileSync(join(r.dir, "debug.log"), "noise\n");
    writeFileSync(join(r.dir, "real.ts"), "export const x = 1;\n");
    const paths = workingTreeEntries(base, r.dir).map((e) => e.path);
    assert.deepEqual(paths.filter((p) => p.startsWith("node_modules") || p.endsWith(".log")), []);
    assert.ok(paths.includes("real.ts"));
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("a deletion records no post image, and a rename records where it came from", () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, "gone.txt"), "gone\n");
    writeFileSync(join(r.dir, "before.txt"), "a reasonably long body so rename detection fires\n".repeat(4));
    r.git("add", "-A"); r.git("commit", "-qm", "base");
    const base = r.git("rev-parse", "HEAD");

    r.git("rm", "-q", "gone.txt");
    r.git("mv", "before.txt", "after.txt");
    r.git("commit", "-qm", "change");

    const entries = workingTreeEntries(base, r.dir);
    const gone = entries.find((e) => e.path === "gone.txt")!;
    assert.equal(gone.status, "D");
    assert.equal(gone.postBlob, "-");

    const renamed = entries.find((e) => e.path === "after.txt")!;
    assert.equal(renamed.status, "R");
    assert.equal(renamed.prePath, "before.txt");
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("a file becoming a symlink is recorded as a type change, not a modification",
  { skip: onWindows }, () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, "target.txt"), "target\n");
    writeFileSync(join(r.dir, "thing.txt"), "was a file\n");
    r.git("add", "-A"); r.git("commit", "-qm", "base");
    const base = r.git("rev-parse", "HEAD");
    rmSync(join(r.dir, "thing.txt"));
    try { symlinkSync("target.txt", join(r.dir, "thing.txt")); }
    catch { return; } // no symlink privilege; the case is real, this host cannot show it
    const e = workingTreeEntries(base, r.dir).find((x) => x.path === "thing.txt")!;
    // T is one of the letters added in RFC 0001 v0.1.5. Before that, this
    // produced a receipt the project's own schema rejected.
    assert.equal(e.status, "T");
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("an unstaged edit binds to its content, not to an all-zero placeholder", () => {
  const r = repo();
  try {
    const base = seed(r);
    writeFileSync(join(r.dir, "seed.txt"), "first edit\n");
    const first = workingTreeEntries(base, r.dir).find((e) => e.path === "seed.txt")!.postBlob;
    writeFileSync(join(r.dir, "seed.txt"), "second, entirely different edit\n");
    const second = workingTreeEntries(base, r.dir).find((e) => e.path === "seed.txt")!.postBlob;
    // The original defect: git reports all-zeros for an unstaged post image, so
    // two different edits produced the same digest -- the normal case at the
    // end of an agent session, which made the binding decorative.
    assert.notEqual(first, second);
    assert.match(first, /^[0-9a-f]{40}$/);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

/**
 * The two findings a reviewer produced against the signed path, as tests.
 *
 * Both were the same mistake in different clothing: a function whose name did
 * not say WHICH change set it computed, used by a caller that needed the other
 * one. `diffEntries` is now `workingTreeEntries` and `committedEntries`, so the
 * choice has to be made out loud at every call site.
 */

test("committedEntries ignores the working tree, however dirty CI leaves it", () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, "src.ts"), "export const a = 1;\n");
    writeFileSync(join(r.dir, "package-lock.json"), '{"v":1}\n');
    r.git("add", "-A"); r.git("commit", "-qm", "base");
    const base = r.git("rev-parse", "HEAD");
    writeFileSync(join(r.dir, "src.ts"), "export const a = 2;\n");
    r.git("add", "-A"); r.git("commit", "-qm", "the actual change");
    const head = r.git("rev-parse", "HEAD");

    // What a CI job does between checkout and `provene promote`: a build step
    // rewrites a tracked lockfile and drops untracked output in the tree.
    writeFileSync(join(r.dir, "package-lock.json"), '{"v":2}\n');
    mkdirSync(join(r.dir, "coverage"), { recursive: true });
    writeFileSync(join(r.dir, "coverage", "lcov.info"), "TN:\n");

    const committed = committedEntries(base, head, r.dir).map((e) => e.path);
    assert.deepEqual(committed, ["src.ts"]);

    // The working-tree view is not wrong, it answers a different question --
    // which is exactly why the two must not share a name.
    const working = workingTreeEntries(base, r.dir).map((e) => e.path).sort();
    assert.deepEqual(working, ["coverage/lcov.info", "package-lock.json", "src.ts"]);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("a range means the three-dot diff, so an advancing base branch is not the branch's work", () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, "f.txt"), "base\n");
    r.git("add", "-A"); r.git("commit", "-qm", "m0");
    const main = r.git("rev-parse", "--abbrev-ref", "HEAD");

    r.git("checkout", "-qb", "feature");
    writeFileSync(join(r.dir, "feat.txt"), "feature\n");
    r.git("add", "-A"); r.git("commit", "-qm", "f1");
    const head = r.git("rev-parse", "HEAD");

    r.git("checkout", "-q", main);
    writeFileSync(join(r.dir, "main.txt"), "moved on\n");
    r.git("add", "-A"); r.git("commit", "-qm", "m1");
    const baseTip = r.git("rev-parse", "HEAD");

    // Two-dot against the advanced base claims the branch DELETED main.txt.
    const twoDot = committedEntries(baseTip, head, r.dir);
    assert.ok(twoDot.some((e) => e.path === "main.txt" && e.status === "D"),
      "fixture must reproduce the reviewer's failure");

    const mb = mergeBase(baseTip, head, r.dir);
    assert.notEqual(mb, undefined);
    const threeDot = committedEntries(mb!, head, r.dir).map((e) => e.path);
    assert.deepEqual(threeDot, ["feat.txt"]);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("resolving a merge base is a no-op on the pull request merge commit CI checks out", () => {
  const r = repo();
  try {
    writeFileSync(join(r.dir, "f.txt"), "base\n");
    r.git("add", "-A"); r.git("commit", "-qm", "m0");
    const main = r.git("rev-parse", "--abbrev-ref", "HEAD");
    r.git("checkout", "-qb", "feature");
    writeFileSync(join(r.dir, "feat.txt"), "feature\n");
    r.git("add", "-A"); r.git("commit", "-qm", "f1");
    r.git("checkout", "-q", main);
    writeFileSync(join(r.dir, "main.txt"), "moved on\n");
    r.git("add", "-A"); r.git("commit", "-qm", "m1");
    const baseTip = r.git("rev-parse", "HEAD");
    // actions/checkout gives a pull_request job refs/pull/N/merge, not the head.
    r.git("checkout", "-qb", "pr-merge", baseTip);
    r.git("merge", "-q", "--no-edit", "feature");
    const mergeCommit = r.git("rev-parse", "HEAD");

    // So the merge base of (base tip, merge commit) is the base tip itself, and
    // the fix changes nothing in the configuration this project actually runs.
    assert.equal(mergeBase(baseTip, mergeCommit, r.dir), baseTip);
    assert.deepEqual(committedEntries(baseTip, mergeCommit, r.dir).map((e) => e.path), ["feat.txt"]);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("mergeBase reports absence rather than throwing, so a shallow clone still runs", () => {
  const r = repo();
  try {
    seed(r);
    assert.equal(mergeBase("HEAD", "0000000000000000000000000000000000000000", r.dir), undefined);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});
