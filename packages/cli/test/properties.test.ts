/**
 * Property tests over generated inputs.
 *
 * Three rounds of specification review missed nine defects that running the
 * code found in an afternoon. The common thread was transient state no design
 * document contains: CRLF working trees, paths with spaces, renames, empty
 * change sets, files git has never seen. These generate that state instead of
 * hoping an example covers it.
 *
 * No dependency: a seeded xorshift is enough randomness to find shape bugs, and
 * a fixed seed means a failure is reproducible rather than a rumour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeDigest, canonicalPayload, type ChangeEntry } from "../src/changedigest.ts";
import { workingTreeEntries } from "../src/git.ts";

function rng(seed: number): () => number {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  };
}

const NAMES = [
  "a.ts", "b.ts", "src/deep/c.ts", "with space.ts", "café.ts", "日本語.ts",
  "emoji-🙂.ts", "Ａ.md", "\u{20000}.md", "UPPER.TS", "dot.d.ts",
];

function randomEntries(r: () => number, n: number): ChangeEntry[] {
  const out: ChangeEntry[] = [];
  const used = new Set<string>();
  for (let i = 0; i < n; i++) {
    const path = NAMES[Math.floor(r() * NAMES.length)]! + (used.size ? `.${i}` : "");
    if (used.has(path)) continue;
    used.add(path);
    const roll = r();
    const oid = (k: number): string => k.toString(16).padStart(40, "0");
    if (roll < 0.25) out.push({ status: "A", path, preBlob: "-", postBlob: oid(i + 1) });
    else if (roll < 0.5) out.push({ status: "D", path, preBlob: oid(i + 100), postBlob: "-" });
    else if (roll < 0.75) out.push({ status: "M", path, preBlob: oid(i + 200), postBlob: oid(i + 300) });
    else out.push({ status: "R", path, prePath: `old-${path}`, preBlob: oid(i + 400), postBlob: oid(i + 400) });
  }
  return out;
}

test("digest is independent of input order", () => {
  const r = rng(20260831);
  for (let i = 0; i < 200; i++) {
    const entries = randomEntries(r, 1 + Math.floor(r() * 8));
    const shuffled = [...entries].sort(() => r() - 0.5);
    assert.equal(changeDigest(shuffled), changeDigest(entries),
      `order changed the digest for: ${entries.map((e) => e.path).join(", ")}`);
  }
});

test("any change to any recorded field changes the digest", () => {
  const r = rng(7);
  for (let i = 0; i < 200; i++) {
    const entries = randomEntries(r, 1 + Math.floor(r() * 5));
    const base = changeDigest(entries);
    const victim = Math.floor(r() * entries.length);
    for (const field of ["path", "preBlob", "postBlob", "status"] as const) {
      const mutated = entries.map((e, k) => k !== victim ? e : { ...e, [field]: field === "status" ? "M" : `${e[field]}x` });
      if (JSON.stringify(mutated) === JSON.stringify(entries)) continue;
      assert.notEqual(changeDigest(mutated as ChangeEntry[]), base,
        `mutating ${field} left the digest unchanged`);
    }
  }
});

test("receipts under .provene/ never affect the digest they are named after", () => {
  const r = rng(99);
  for (let i = 0; i < 100; i++) {
    const entries = randomEntries(r, 1 + Math.floor(r() * 6));
    const digest = changeDigest(entries);
    const withReceipt: ChangeEntry[] = [...entries,
      { status: "A", path: `.provene/${digest}.statement.json`, preBlob: "-", postBlob: "a".repeat(40) }];
    assert.equal(changeDigest(withReceipt), digest, "self-reference leaked into the digest");
  }
});

test("the canonical payload never contains a bare CR or a trailing newline", () => {
  const r = rng(31337);
  for (let i = 0; i < 100; i++) {
    const payload = canonicalPayload(randomEntries(r, 1 + Math.floor(r() * 6)));
    assert.ok(!payload.includes("\r"), "carriage return reached the signed payload");
    assert.ok(!payload.endsWith("\n"), "trailing newline reached the signed payload");
  }
});

// --- against real git, where the transient state actually lives ---

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "provene-prop-"));
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q", ".");
  git("config", "user.email", "a@b.c");
  git("config", "user.name", "t");
  return dir;
}

test("working-tree blobs match what git would commit, including CRLF and odd paths", () => {
  const dir = repo();
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    git("config", "core.autocrlf", "true");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "seed.txt"), "seed\n");
    git("add", "-A"); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").trim();

    const paths = ["crlf.txt", "with space.txt", "café.txt", "sub/nested.txt"];
    writeFileSync(join(dir, paths[0]!), "one\r\ntwo\r\n");
    for (const p of paths.slice(1)) writeFileSync(join(dir, p), `content of ${p}\n`);
    writeFileSync(join(dir, "seed.txt"), "seed modified\r\n");

    const entries = workingTreeEntries(base, dir);
    assert.ok(entries.length >= paths.length, "untracked files must be included");

    // Every recorded post blob must equal what git itself would store.
    for (const e of entries) {
      if (e.postBlob === "-") continue;
      const expected = execFileSync("git", ["hash-object", "--", e.path],
        { cwd: dir, encoding: "utf8" }).trim();
      assert.equal(e.postBlob, expected, `blob mismatch for ${e.path}`);
    }

    // And the digest must survive the round trip through an actual commit.
    const before = changeDigest(entries);
    git("add", "-A"); git("commit", "-qm", "work");
    const after = changeDigest(workingTreeEntries(base, dir));
    assert.equal(after, before, "digest changed when the same content was committed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every recorded object id satisfies the schema's own pattern", () => {
  // The schema requires 40 or 64 hex characters, or "-". git diff --raw
  // abbreviates to seven by default, which silently produced schema-invalid
  // receipts for every tracked modification.
  const OID = /^([0-9a-f]{40}|[0-9a-f]{64}|-)$/;
  const dir = repo();
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    writeFileSync(join(dir, "tracked.txt"), "one\n");
    git("add", "-A"); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "tracked.txt"), "two\n");   // modified, tracked
    writeFileSync(join(dir, "fresh.txt"), "new\n");     // untracked
    git("add", "tracked.txt");                           // staged, so diff has a real oid

    for (const e of workingTreeEntries(base, dir)) {
      assert.match(e.preBlob, OID, `preBlob for ${e.path} is not a full object id`);
      assert.match(e.postBlob, OID, `postBlob for ${e.path} is not a full object id`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
