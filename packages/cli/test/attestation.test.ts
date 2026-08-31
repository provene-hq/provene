/**
 * Verifying what CI signed.
 *
 * The two properties under test are the two halves of the design. First: the
 * changeset manifest's sha256 IS the change digest, because that identity is
 * the only reason stock Sigstore tooling can address a Provene attestation at
 * all. Second: nothing in this codebase may report an attestation as verified
 * unless an actual verifier said so — the tier model died once already to a
 * document being trusted about its own tier, and a verifier that answers from
 * the payload would be the same bug wearing a signature.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeManifest, parseGhOutput, checkAggregate, ghVerify } from "../src/attestation.ts";
import { changeDigest, type ChangeEntry } from "../src/changedigest.ts";
import { AGGREGATE_PREDICATE_TYPE } from "../src/promote.ts";
import { STATEMENT_TYPE } from "../src/receipt.ts";

const entry = (path: string, status: ChangeEntry["status"] = "M"): ChangeEntry => ({
  status, path, preBlob: "a".repeat(40), postBlob: "b".repeat(40),
});
const scratch = (): string => mkdtempSync(join(tmpdir(), "provene-test-"));
const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

test("the manifest's sha256 is the change digest", () => {
  for (const entries of [
    [entry("src/a.ts"), entry("src/b.ts")],
    // An astral character (a surrogate pair) alongside one from U+E000, which
    // a UTF-16 sort orders ABOVE it and a byte sort orders below.
    [entry("src/\u{1F600}.ts"), entry("src/\uE000.ts"), entry("a.ts", "A")],
    // Excluded paths must not reach the manifest, exactly as they do not reach
    // the digest -- otherwise the file and the signature describe different sets.
    [entry("src/a.ts"), entry(".provene/x.json", "A")],
    [],
  ] as ChangeEntry[][]) {
    const file = join(scratch(), "changeset");
    writeManifest(file, entries);
    assert.equal(sha256(readFileSync(file)), changeDigest(entries));
  }
});

test("the manifest carries no trailing newline", () => {
  const file = join(scratch(), "changeset");
  writeManifest(file, [entry("src/a.ts")]);
  const bytes = readFileSync(file);
  assert.notEqual(bytes[bytes.length - 1], 0x0a);
});

test("a missing verifier is reported as unchecked, never as verified or failed", () => {
  const r = ghVerify({
    manifestPath: "/nonexistent", repo: "o/r",
    predicateType: AGGREGATE_PREDICATE_TYPE,
    bin: "definitely-not-a-real-binary-provene-test",
  });
  assert.equal(r.verified, false);
  assert.equal(r.ran, false);
  assert.match(r.message, /not installed/);
});

const statement = (over: Record<string, unknown> = {}, pred: Record<string, unknown> = {}) => ({
  _type: STATEMENT_TYPE,
  subject: [{ name: "o/r@main", digest: { sha256: "c".repeat(64) } }],
  predicateType: AGGREGATE_PREDICATE_TYPE,
  predicate: {
    provene: "0.1",
    attestation: { tier: "T2", trustRoot: { kind: "sigstore-github" } },
    binding: { changeDigest: "c".repeat(64), parent: "d".repeat(40) },
    constituents: [],
    coverage: { complete: true, constituentsFound: 1, commitsInRange: 1 },
    verification: { runs: [], unverifiedPaths: [] },
    ...pred,
  },
  ...over,
});

test("a sound aggregate over this change set passes", () => {
  const r = checkAggregate(statement(), { subjectDigest: "c".repeat(64), base: "d".repeat(40) });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.tier, "T2");
});

test("a signature over a different change set is rejected", () => {
  const r = checkAggregate(statement(), { subjectDigest: "e".repeat(64) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /covers different work/);
});

test("a signed aggregate may not declare a self-attested tier", () => {
  for (const tier of ["T0", "T1", undefined]) {
    const r = checkAggregate(
      statement({}, { attestation: tier === undefined ? {} : { tier } }),
      { subjectDigest: "c".repeat(64) },
    );
    assert.equal(r.ok, false);
    assert.match(r.problems.join(" "), /must declare tier T2 or T3/);
  }
});

test("a locally observed run cannot be promoted by appearing in a signed aggregate", () => {
  const r = checkAggregate(
    statement({}, { verification: { runs: [{ id: "t", observedBy: "local" }], unverifiedPaths: [] } }),
    { subjectDigest: "c".repeat(64) },
  );
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /only runs CI observed/);
});

test("a signature over a different base is rejected", () => {
  const r = checkAggregate(statement(), { subjectDigest: "c".repeat(64), base: "f".repeat(40) });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /the range given starts at/);
});

test("the wrong predicate type is rejected even when everything else lines up", () => {
  const r = checkAggregate(
    statement({ predicateType: "https://slsa.dev/provenance/v1" }),
    { subjectDigest: "c".repeat(64) },
  );
  assert.equal(r.ok, false);
});

test("incomplete coverage is a note, not a failure", () => {
  const r = checkAggregate(
    statement({}, { coverage: { complete: false, constituentsFound: 0, commitsInRange: 7 } }),
    { subjectDigest: "c".repeat(64), commitsInRange: 7 },
  );
  assert.equal(r.ok, true);
  assert.match(r.notes.join(" "), /coverage incomplete/);
});

test("a range that has grown since signing is noted, not silently accepted as covering it", () => {
  const r = checkAggregate(statement(), { subjectDigest: "c".repeat(64), commitsInRange: 4 });
  assert.match(r.notes.join(" "), /signed over 1 commit\(s\); this range has 4/);
});

test("gh output parses to statements and signer identities", () => {
  const { statements, identities } = parseGhOutput(JSON.stringify([{
    attestation: { bundle: {} },
    verificationResult: {
      statement: statement(),
      signature: { certificate: {
        subjectAlternativeName: "https://github.com/o/r/.github/workflows/ci.yml@refs/heads/main",
        sourceRepositoryURI: "https://github.com/o/r",
      } },
    },
  }]));
  assert.equal(statements.length, 1);
  assert.equal(identities.length, 2);
});

test("unparseable verifier output costs detail, not soundness", () => {
  for (const junk of ["", "not json", "{}", "[{}]", "[null]"]) {
    const { statements, identities } = parseGhOutput(junk);
    assert.deepEqual(statements, []);
    assert.deepEqual(identities, []);
  }
});
