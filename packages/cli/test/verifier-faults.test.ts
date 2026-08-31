/**
 * Fault injection against the verifier boundary.
 *
 * The harness a reviewer asked for, after finding that `verify-aggregate`
 * printed "the predicate's own claims were NOT checked" and then returned exit
 * code 0 — telling a CI gate the opposite of what it told a human.
 *
 * The class it exists to catch is **degraded-state permissiveness**: code
 * written to avoid crashing on an external tool's unexpected output, which
 * quietly settles on success as its fallback. Every state below is one an
 * external verifier can really leave us in. The single assertion that matters
 * is that exactly one of them is allowed to exit 0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideVerification, checkAggregate, parseGhOutput, type GhResult } from "../src/attestation.ts";
import { AGGREGATE_PREDICATE_TYPE } from "../src/promote.ts";
import { STATEMENT_TYPE } from "../src/receipt.ts";

const DIGEST = "c".repeat(64);

const sound = () => ({
  _type: STATEMENT_TYPE,
  subject: [{ name: "o/r@main", digest: { sha256: DIGEST } }],
  predicateType: AGGREGATE_PREDICATE_TYPE,
  predicate: {
    provene: "0.1",
    attestation: { tier: "T2" },
    binding: { changeDigest: DIGEST },
    constituents: [],
    coverage: { complete: true, constituentsFound: 1, commitsInRange: 1 },
    verification: { runs: [], unverifiedPaths: [] },
  },
});

/** What ghVerify would return for a given raw verifier result. */
const gh = (over: Partial<GhResult>): GhResult => ({
  verified: false, ran: true, noAttestation: false,
  statements: [], identities: [], signers: [], message: "", ...over,
});

const decide = (g: GhResult) =>
  decideVerification(g, g.statements.map((s) => checkAggregate(s, { subjectDigest: DIGEST })));

test("every degraded verifier state exits non-zero", () => {
  const degraded: Array<[string, GhResult]> = [
    ["verifier not installed", gh({ ran: false, message: "not installed" })],
    ["verifier rejected the signature", gh({ message: "verification failed" })],
    ["nothing signed for this digest", gh({ noAttestation: true, message: "HTTP 404" })],
    ["rate limited", gh({ message: "HTTP 429: too many requests" })],

    // The five the reviewer named. Each is gh EXITING ZERO with output this
    // version cannot turn into a statement -- the exact shape that failed open.
    ["exit 0, empty array", gh({ verified: true, ...parseGhOutput("[]") })],
    ["exit 0, corrupt json", gh({ verified: true, ...parseGhOutput("{ invalid") })],
    ["exit 0, empty result object", gh({ verified: true, ...parseGhOutput('[{"verificationResult":{}}]') })],
    ["exit 0, null entry", gh({ verified: true, ...parseGhOutput("[null]") })],
    ["exit 0, not an array", gh({ verified: true, ...parseGhOutput('{"verificationResult":{}}') })],
    ["exit 0, html error page", gh({ verified: true, ...parseGhOutput("<html>502</html>") })],

    // Parseable, but not about us.
    ["exit 0, someone else's predicate type", gh({
      verified: true,
      statements: [{ ...sound(), predicateType: "https://slsa.dev/provenance/v1" }],
    })],
    ["exit 0, a different change set", gh({
      verified: true,
      statements: [{ ...sound(), subject: [{ name: "x", digest: { sha256: "d".repeat(64) } }] }],
    })],
    ["exit 0, self-attested tier inside a signed envelope", gh({
      verified: true,
      statements: [{ ...sound(), predicate: { ...sound().predicate, attestation: { tier: "T0" } } }],
    })],
    ["exit 0, one good statement and one bad", gh({
      verified: true,
      statements: [sound(), { ...sound(), predicate: { ...sound().predicate, provene: "9.9" } }],
    })],
  ];

  for (const [name, g] of degraded) {
    const outcome = decide(g);
    assert.notEqual(outcome.code, 0, `${name} was reported as a pass (kind: ${outcome.kind})`);
  }
});

test("the one state that may exit zero", () => {
  const outcome = decide(gh({ verified: true, statements: [sound()] }));
  assert.equal(outcome.kind, "verified");
  assert.equal(outcome.code, 0);
});

test("an unreadable statement is 'could not check', not 'failed'", () => {
  // The distinction the whole command is built on. gh accepted the signature;
  // we simply cannot say what it covers. Reporting that as a failed signature
  // would be as false as reporting it as a pass.
  const outcome = decide(gh({ verified: true, statements: [] }));
  assert.equal(outcome.kind, "unreadable");
  assert.equal(outcome.code, 3);
});

test("every outcome kind is reachable, so none is dead code hiding a collapse", () => {
  const seen = new Set([
    decide(gh({ ran: false })).kind,
    decide(gh({ noAttestation: true })).kind,
    decide(gh({ message: "bad" })).kind,
    decide(gh({ verified: true })).kind,
    decide(gh({ verified: true, statements: [{ ...sound(), predicateType: "other" }] })).kind,
    decide(gh({ verified: true, statements: [sound()] })).kind,
  ]);
  assert.deepEqual([...seen].sort(), [
    "no-attestation", "no-verifier", "not-this-change",
    "signature-invalid", "unreadable", "verified",
  ]);
});

test("a signed aggregate naming an attester the certificate contradicts is rejected", () => {
  const withAttester = (identity: string) => ({
    ...sound(),
    predicate: {
      ...sound().predicate,
      attestation: { tier: "T2", attester: { identity } },
    },
  });
  const cert = ["https://github.com/o/r/.github/workflows/release.yml@refs/heads/main"];

  const honest = checkAggregate(withAttester("o/r/.github/workflows/release.yml@refs/heads/main"),
    { subjectDigest: DIGEST, signerIdentities: cert });
  assert.deepEqual(honest.problems, []);

  // Signed by release.yml, claiming to be provene.yml.
  const borrowed = checkAggregate(withAttester("o/r/.github/workflows/provene.yml@refs/heads/main"),
    { subjectDigest: DIGEST, signerIdentities: cert });
  assert.equal(borrowed.ok, false);
  assert.match(borrowed.problems.join(" "), /names .* as attester, but the certificate/);

  // No certificate detail to compare against: a note, never a silent pass.
  const unchecked = checkAggregate(withAttester("o/r/.github/workflows/provene.yml@refs/heads/main"),
    { subjectDigest: DIGEST });
  assert.equal(unchecked.ok, true);
  assert.match(unchecked.notes.join(" "), /could not be checked against the certificate/);
});

test("the repository URI is not a signer identity", () => {
  // A list built for display was reused as a security boundary:
  // `sourceRepositoryURI` sat alongside the workflow SAN, so an aggregate
  // declaring the bare repository as its attester matched, and any workflow in
  // that repository could attest under a name they all share.
  const raw = JSON.stringify([{
    verificationResult: {
      statement: sound(),
      signature: { certificate: {
        subjectAlternativeName: "https://github.com/o/r/.github/workflows/untrusted-pr.yml@refs/heads/main",
        sourceRepositoryURI: "https://github.com/o/r",
      } },
    },
  }]);
  const { identities, signers } = parseGhOutput(raw);
  assert.equal(identities.length, 2, "the repository URI is still worth showing a human");
  assert.deepEqual(signers, ["https://github.com/o/r/.github/workflows/untrusted-pr.yml@refs/heads/main"]);

  const claimsTheRepo = {
    ...sound(),
    predicate: {
      ...sound().predicate,
      attestation: { tier: "T2", trustRoot: { kind: "sigstore-github" }, attester: { identity: "o/r" } },
    },
  };
  const r = checkAggregate(claimsTheRepo, { subjectDigest: DIGEST, signerIdentities: signers });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /does not name a workflow/);

  // And the same document passed the display list, which is the defect.
  const viaDisplayList = checkAggregate(claimsTheRepo, { subjectDigest: DIGEST, signerIdentities: identities });
  assert.match(viaDisplayList.problems.join(" "), /does not name a workflow/,
    "the workflow-shape rule must hold even if a caller passes the wrong list");
});
