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
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeManifest, parseGhOutput, checkAggregate, ghVerify, meansNoAttestation } from "../src/attestation.ts";
import { changeDigest, type ChangeEntry } from "../src/changedigest.ts";
import { AGGREGATE_PREDICATE_TYPE } from "../src/promote.ts";
import { STATEMENT_TYPE } from "../src/receipt.ts";

const entry = (path: string, status: ChangeEntry["status"] = "M"): ChangeEntry => ({
  status, path, preBlob: "a".repeat(40), postBlob: "b".repeat(40),
});
const scratch = (): string => mkdtempSync(join(tmpdir(), "provene-test-"));
const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
// The stub verifiers below are shell scripts, which Node cannot exec on Windows.
const onWindows = process.platform === "win32";

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

test("absence of an attestation is not a failed signature", { skip: onWindows }, () => {
  const dir = scratch();
  // Stand-ins for what gh actually printed the first time this was run against
  // a repository nothing had signed: an HTTP 404 from the attestations
  // endpoint. Reported as a signature failure, it says the evidence is bad
  // when the truth is that there is none.
  for (const stderr of [
    "Error: HTTP 404: Not Found (https://api.github.com/repos/o/n/attestations/sha256:aa)",
    "✗ no attestations found",
    "no attestations were found for subject",
  ]) {
    const bin = join(dir, `gh-${Buffer.from(stderr).toString("hex").slice(0, 8)}.sh`);
    writeFileSync(bin, `#!/bin/sh\necho ${JSON.stringify(stderr)} >&2\nexit 1\n`, { mode: 0o755 });
    const r = ghVerify({ manifestPath: "x", repo: "o/n", predicateType: AGGREGATE_PREDICATE_TYPE, bin });
    assert.equal(r.verified, false);
    assert.equal(r.ran, true);
    assert.equal(r.noAttestation, true, `not detected as absence: ${stderr}`);
  }
});

test("a real verification failure is not mistaken for absence", { skip: onWindows }, () => {
  const dir = scratch();
  for (const stderr of [
    "✗ verification failed: certificate identity mismatch",
    "Error: HTTP 403: Forbidden",
    "signature verification failed",
  ]) {
    const bin = join(dir, `bad-${Buffer.from(stderr).toString("hex").slice(0, 8)}.sh`);
    writeFileSync(bin, `#!/bin/sh\necho ${JSON.stringify(stderr)} >&2\nexit 1\n`, { mode: 0o755 });
    const r = ghVerify({ manifestPath: "x", repo: "o/n", predicateType: AGGREGATE_PREDICATE_TYPE, bin });
    assert.equal(r.verified, false);
    assert.equal(r.noAttestation, false, `wrongly treated as absence: ${stderr}`);
  }
});

test("the absence/failure distinction itself, on every platform", () => {
  // Absence. The first string is what gh actually printed the first time this
  // was run against a repository nothing had ever signed.
  for (const stderr of [
    "Error: HTTP 404: Not Found (https://api.github.com/repos/o/n/attestations/sha256:aa)",
    "\u2717 no attestations found",
    "no attestations were found for subject",
    "No attestation found",
  ]) assert.equal(meansNoAttestation(stderr), true, `absence not detected: ${stderr}`);

  // A real failure. Treating any of these as absence would tell someone their
  // evidence is merely missing when it is present and bad.
  for (const stderr of [
    "\u2717 verification failed: certificate identity mismatch",
    "Error: HTTP 403: Forbidden",
    "signature verification failed",
    "Error: HTTP 4040: Not A Real Status",
    "the attestation found does not match the expected predicate type",
  ]) assert.equal(meansNoAttestation(stderr), false, `wrongly read as absence: ${stderr}`);
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
