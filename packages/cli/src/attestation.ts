/**
 * Verifying a signed T2 aggregate.
 *
 * Two separate facts have to hold before a signed aggregate means anything,
 * and they are established by two different parties.
 *
 *   1. "This envelope was signed by an identity GitHub vouches for, and the
 *      signature covers subject digest X."
 *      That is cryptography — certificate chains, transparency-log inclusion
 *      proofs, signed timestamps — and this project does not implement
 *      cryptography. It delegates to `gh attestation verify`, the reference
 *      verifier for the store the attestation actually lives in.
 *
 *   2. "Subject digest X is the change set between these two commits of THIS
 *      repository."
 *      Only Provene can establish that, because X is a Provene change digest
 *      and nothing else in the ecosystem knows how to recompute it.
 *
 * The trust decision rests on gh's EXIT CODE and on the constraints handed to
 * it (--repo, --predicate-type, and --cert-identity / --signer-workflow when
 * the caller supplies them). It never rests on this file's parsing of gh's
 * JSON. If that output shape changes, the worst outcome is that we report less
 * detail about an attestation gh has already verified — not that we accept one
 * gh rejected. Parsing is for reporting; the exit code is the boundary.
 *
 * Addressing an attestation at all requires a subtlety. `gh attestation verify`
 * takes a FILE and hashes it; our subject digest is a digest over a change set,
 * not over any file that exists in the tree. So `provene manifest` writes the
 * change set's canonical pre-image — the exact bytes the digest is taken over
 * (RFC 0001 section 4.1) — to a file. sha256 of that file IS the subject
 * digest, by construction, which makes a Provene attestation verifiable with
 * stock Sigstore tooling and not only with our own code.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { canonicalPayload, type ChangeEntry } from "./changedigest.ts";
import type { Statement, Tier } from "./receipt.ts";
import { AGGREGATE_PREDICATE_TYPE } from "./promote.ts";
import { STATEMENT_TYPE } from "./receipt.ts";

/**
 * Writes the change set's canonical pre-image.
 *
 * Written as raw bytes with no trailing newline: the digest is taken over
 * exactly these bytes, so anything a text editor might helpfully add would
 * change the file's sha256 and unaddress the attestation. An empty change set
 * legitimately produces an empty file.
 */
export function writeManifest(path: string, entries: readonly ChangeEntry[]): void {
  writeFileSync(path, Buffer.from(canonicalPayload(entries), "utf8"));
}

export interface GhResult {
  /** True only when gh exited zero. Nothing else in this module may set it. */
  readonly verified: boolean;
  readonly ran: boolean;
  /**
   * The verifier ran and found nothing to check.
   *
   * "No attestation covers this change set" and "an attestation covers it and
   * is bad" are different facts about the world, and only the second is a
   * signature failure. Reporting absence as a failed signature tells someone
   * their evidence is forged when the truth is that they have none — which is
   * the same multi-state-into-binary collapse this project has now made four
   * times, caught here in live output rather than by review.
   *
   * A 404 also covers "you cannot see this repository's attestations", so the
   * message says both rather than guessing which.
   */
  readonly noAttestation: boolean;
  readonly message: string;
  /** Best effort, for reporting only. Empty is not a failure. */
  readonly statements: readonly Statement[];
  readonly identities: readonly string[];
}

export interface GhVerifyOptions {
  readonly manifestPath: string;
  /** owner/name. gh requires one of --repo or --owner; we always pass --repo. */
  readonly repo: string;
  readonly predicateType: string;
  /** Offline verification against a downloaded bundle instead of the API. */
  readonly bundlePath?: string;
  /** Constraints gh itself enforces. Passing them is what makes them binding. */
  readonly certIdentity?: string;
  readonly signerWorkflow?: string;
  readonly cwd?: string;
  /**
   * The verifier executable. Present so tests can prove the missing-verifier
   * path without depending on whether the machine running them has gh
   * installed. Deliberately NOT read from the environment: a verifier you can
   * redirect with a variable is not a verifier.
   */
  readonly bin?: string;
}

/**
 * gh's `--format json` emits an array with one entry per verified attestation;
 * each entry has an `attestation` object and a `verificationResult` object, and
 * the parsed in-toto statement sits at `verificationResult.statement`.
 *
 * Every field read here is optional on purpose. A shape change must cost us
 * detail, never soundness.
 */
export function parseGhOutput(stdout: string): { statements: Statement[]; identities: string[] } {
  const statements: Statement[] = [];
  const identities: string[] = [];
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return { statements, identities }; }
  if (!Array.isArray(parsed)) return { statements, identities };
  for (const entry of parsed) {
    const result = (entry as any)?.verificationResult;
    const statement = result?.statement;
    if (statement !== undefined && statement !== null && typeof statement === "object") {
      statements.push(statement as Statement);
    }
    const cert = result?.signature?.certificate;
    for (const field of ["subjectAlternativeName", "buildSignerURI", "sourceRepositoryURI"]) {
      const v = cert?.[field];
      if (typeof v === "string" && v !== "" && !identities.includes(v)) identities.push(v);
    }
  }
  return { statements, identities };
}

/**
 * Does this verifier failure mean "nothing is signed" rather than "the
 * signature is bad"?
 *
 * Exported and pure so the distinction can be tested on every platform. The
 * stub-binary tests that prove the wiring cannot run on Windows, and this is
 * the judgement worth pinning, not the plumbing around it.
 */
export function meansNoAttestation(stderr: string): boolean {
  return /HTTP 404\b/.test(stderr) || /no attestations? (was |were )?found/i.test(stderr);
}

export function ghVerify(opts: GhVerifyOptions): GhResult {
  const argv = [
    "attestation", "verify", opts.manifestPath,
    "--repo", opts.repo,
    "--predicate-type", opts.predicateType,
    "--format", "json",
  ];
  if (opts.bundlePath !== undefined) argv.push("--bundle", opts.bundlePath);
  if (opts.certIdentity !== undefined) argv.push("--cert-identity", opts.certIdentity);
  if (opts.signerWorkflow !== undefined) argv.push("--signer-workflow", opts.signerWorkflow);

  let stdout = "";
  try {
    stdout = execFileSync(opts.bin ?? "gh", argv, {
      encoding: "utf8",
      cwd: opts.cwd ?? process.cwd(),
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number; stderr?: Buffer | string };
    // Not found is a different answer from "rejected", and conflating them is
    // how a tool ends up reporting an unverified attestation as fine because
    // the verifier was missing.
    if (e.code === "ENOENT") {
      return {
        verified: false, ran: false, noAttestation: false, statements: [], identities: [],
        message: "the GitHub CLI (gh) is not installed, so the signature could not be checked. " +
                 "Provene does not implement signature verification itself; install gh " +
                 "(https://cli.github.com) and run `gh auth login`.",
      };
    }
    const stderr = e.stderr === undefined ? "" : String(e.stderr).trim();
    return {
      verified: false, ran: true, statements: [], identities: [],
      noAttestation: meansNoAttestation(stderr),
      message: stderr === "" ? `gh attestation verify exited ${e.status ?? "non-zero"}` : stderr,
    };
  }
  const { statements, identities } = parseGhOutput(stdout);
  return { verified: true, ran: true, noAttestation: false, statements, identities, message: "" };
}

export interface AggregateCheck {
  readonly ok: boolean;
  readonly tier: Tier | "unknown";
  readonly problems: string[];
  readonly notes: string[];
}

/**
 * What only Provene can check: that the verified statement is about this
 * repository's change set, and that its internal claims are consistent.
 *
 * `subjectDigest` must be recomputed locally by the caller, never taken from
 * the statement — the point of the comparison is that two independent
 * computations agree.
 *
 * gh looks attestations up BY the artefact's digest, so in the normal path the
 * digest comparison below is expected to be redundant. It is done anyway, and
 * costs nothing: the alternative is that this tool's central claim rests on an
 * assumption about another tool's matching semantics, which is not a thing to
 * assume in a provenance tool.
 */
export function checkAggregate(
  statement: unknown,
  actual: {
    readonly subjectDigest: string;
    readonly base?: string;
    readonly commitsInRange?: number;
    /**
     * Identities from the certificate the verifier checked. Supplied so the
     * predicate's claim about who attested it can be held against who actually
     * signed it — a workflow that signs an aggregate naming a different
     * workflow as attester is describing an event that did not happen.
     */
    readonly signerIdentities?: readonly string[];
  },
): AggregateCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  const s = statement as Partial<Statement> | null;
  if (s === null || typeof s !== "object") {
    return { ok: false, tier: "unknown", problems: ["gh returned no parseable statement"], notes };
  }
  if (s._type !== STATEMENT_TYPE) problems.push(`_type must be ${STATEMENT_TYPE}`);
  if (s.predicateType !== AGGREGATE_PREDICATE_TYPE) {
    problems.push(`predicateType must be ${AGGREGATE_PREDICATE_TYPE}, got ${String(s.predicateType)}`);
  }

  const pred = (s.predicate ?? {}) as Record<string, any>;
  const tier: Tier | "unknown" = pred["attestation"]?.tier ?? "unknown";
  // A signed envelope establishes only that SOMETHING was signed. An aggregate
  // is a CI artefact by definition, so one declaring T0 or T1 inside a
  // CI-signed envelope is describing an event that cannot have happened.
  if (tier !== "T2" && tier !== "T3") {
    problems.push(`a signed aggregate must declare tier T2 or T3, not ${String(tier)}`);
  }
  if (pred["provene"] !== "0.1") problems.push('predicate.provene must be "0.1"');

  const subject = s.subject?.[0]?.digest["sha256"];
  if (subject === undefined) problems.push("subject digest missing");
  else if (subject !== actual.subjectDigest) {
    problems.push(
      `the signed subject digest ${subject.slice(0, 12)} is not the change set here ` +
      `(${actual.subjectDigest.slice(0, 12)}) — the signature covers different work`,
    );
  }
  const binding = pred["binding"]?.changeDigest;
  if (binding !== subject) problems.push("binding.changeDigest does not equal the subject digest");

  if (actual.base !== undefined && pred["binding"]?.parent !== undefined
      && String(pred["binding"].parent) !== actual.base) {
    problems.push(
      `signed against parent ${String(pred["binding"].parent).slice(0, 12)}, ` +
      `but the range given starts at ${actual.base.slice(0, 12)}`,
    );
  }

  // Restating a locally observed run inside a CI-signed aggregate is exactly
  // the promotion-by-assertion the tier model exists to prevent.
  for (const run of (pred["verification"]?.runs ?? []) as Array<Record<string, unknown>>) {
    if (run["observedBy"] !== "ci") {
      problems.push(`verification run ${String(run["id"])} claims observedBy ${String(run["observedBy"])}; ` +
                    "an aggregate carries only runs CI observed");
    }
  }

  for (const c of (pred["constituents"] ?? []) as Array<Record<string, unknown>>) {
    if (!/^[0-9a-f]{64}$/.test(String(c["changeDigest"] ?? ""))) {
      problems.push("a constituent carries a malformed change digest");
      break;
    }
  }

  // Who the predicate says attested it, against who the certificate says signed
  // it. Both are inside the signature, so a mismatch is not forgery from
  // outside -- it is a workflow signing a document that names another workflow,
  // which is either a bug in an emitter or an attempt to borrow a trusted
  // workflow's name inside a repository the attacker can already run jobs in.
  const declaredAttester = pred["attestation"]?.attester?.identity;
  const ids = actual.signerIdentities ?? [];
  if (typeof declaredAttester === "string" && declaredAttester !== "" && ids.length > 0) {
    const bare = (v: string): string => v.replace(/^https?:\/\/[^/]+\//, "");
    if (!ids.some((id) => bare(id) === bare(declaredAttester))) {
      problems.push(
        `the predicate names ${declaredAttester} as attester, but the certificate ` +
        `identifies ${ids.join(", ")}`,
      );
    }
  } else if (typeof declaredAttester === "string" && declaredAttester !== "") {
    notes.push(`attester ${declaredAttester} could not be checked against the certificate`);
  }

  const coverage = pred["coverage"] ?? {};
  if (coverage["complete"] === false) {
    notes.push(`coverage incomplete: ${coverage["constituentsFound"] ?? 0} constituent receipt(s) ` +
               `over ${coverage["commitsInRange"] ?? 0} commit(s) — this aggregate is signed, ` +
               "but does not claim every commit in the range carries a receipt");
  }
  if (actual.commitsInRange !== undefined && coverage["commitsInRange"] !== undefined
      && Number(coverage["commitsInRange"]) !== actual.commitsInRange) {
    notes.push(`the aggregate was signed over ${coverage["commitsInRange"]} commit(s); ` +
               `this range has ${actual.commitsInRange}`);
  }

  return { ok: problems.length === 0, tier, problems, notes };
}

/**
 * The verification verdict, as data.
 *
 * This exists because the decision — not the parsing, not the shelling out —
 * is where this command failed open. `verify-aggregate` printed "the
 * predicate's own claims were NOT checked" and then returned 0, so a CI gate
 * reading the exit code was told the opposite of what the text said. The code
 * contradicted its own comment, which is what a decision buried inside a
 * print-and-return function makes easy.
 *
 * Every degraded state a verifier can leave us in has to name itself here, and
 * `code` is derived from the kind rather than chosen at each call site.
 */
export type VerifyOutcome =
  /** The verifier is not installed. Nothing was checked. */
  | { readonly kind: "no-verifier"; readonly code: 3 }
  /** The verifier ran; nothing is signed for this change set. */
  | { readonly kind: "no-attestation"; readonly code: 1 }
  /** The verifier rejected the signature. */
  | { readonly kind: "signature-invalid"; readonly code: 1 }
  /**
   * The verifier accepted the signature and we could not read back what was
   * signed. NOT a pass: in `--bundle` mode the verifier does not match the
   * subject digest at all, so without a readable statement nothing has bound
   * the signature to this change set. Exit 3, the same "could not check" a
   * missing verifier gets, because that is exactly what it is.
   */
  | { readonly kind: "unreadable"; readonly code: 3 }
  /** Signature valid, but what it signed is not the work in front of you. */
  | { readonly kind: "not-this-change"; readonly code: 1 }
  | { readonly kind: "verified"; readonly code: 0 };

export function decideVerification(
  gh: Pick<GhResult, "verified" | "ran" | "noAttestation" | "statements">,
  /** One per statement gh returned, in order. */
  checks: readonly AggregateCheck[],
): VerifyOutcome {
  if (!gh.verified) {
    if (!gh.ran) return { kind: "no-verifier", code: 3 };
    if (gh.noAttestation) return { kind: "no-attestation", code: 1 };
    return { kind: "signature-invalid", code: 1 };
  }
  // gh exited zero and we have nothing to inspect. Fail closed.
  if (gh.statements.length === 0 || checks.length === 0) return { kind: "unreadable", code: 3 };
  if (checks.some((c) => !c.ok)) return { kind: "not-this-change", code: 1 };
  return { kind: "verified", code: 0 };
}
