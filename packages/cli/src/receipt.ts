/** RFC 0001 — building and checking the receipt Statement. */
import { createHash } from "node:crypto";
import { changeDigest, type ChangeEntry, DEFAULT_EXCLUDED_PREFIXES } from "./changedigest.ts";
import type { RedactedCommand } from "./redact.ts";

export const PREDICATE_TYPE = "https://provene.dev/attestation/code-change/v0.1";
export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";

export type Tier = "T0" | "T1" | "T2" | "T3";

export interface Statement {
  readonly _type: string;
  readonly subject: ReadonlyArray<{ name: string; digest: Record<string, string> }>;
  readonly predicateType: string;
  readonly predicate: Record<string, unknown>;
}

export interface VerificationRun {
  readonly id: string;
  readonly kind: "test";
  readonly tool: string;
  readonly result: "PASSED" | "FAILED";
  readonly observedBy: "local";
}

export interface BuildInput {
  readonly subjectName: string;
  readonly entries: readonly ChangeEntry[];
  readonly parent: string;
  readonly agent: { vendor?: string; tool: string; toolVersion?: string;
                    model?: string; modelSource?: "reported" | "configured" };
  readonly task?: { ref?: string; sessionRef?: string; digest?: string };
  readonly session?: { id: string; startedAt: string; endedAt: string; toolCalls: number };
  readonly emitter: { name: string; version: string };
  readonly commands: readonly RedactedCommand[];
  readonly runs: readonly VerificationRun[];
  readonly attributedPaths: readonly string[];
}

/** A T0 receipt: unsigned, and therefore a bare Statement rather than a DSSE envelope. */
export function buildT0(input: BuildInput): Statement {
  const digest = changeDigest(input.entries);
  const attributed = new Set(input.attributedPaths);
  const changed = input.entries.filter(
    (e) => !DEFAULT_EXCLUDED_PREFIXES.some((p) => e.path.startsWith(p)),
  );
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: input.subjectName, digest: { sha256: digest } }],
    predicateType: PREDICATE_TYPE,
    predicate: {
      provene: "0.1",
      attestation: {
        tier: "T0",
        trustRoot: { kind: "none" },
        transparencyLog: { published: false },
      },
      agent: input.agent,
      emitter: input.emitter,
      ...(input.task !== undefined
        ? { task: { ...input.task, ...(input.task.digest !== undefined
            ? { digestScope: "repo", keySource: "root-commit" } : {}) } }
        : {}),
      ...(input.session !== undefined ? { session: input.session } : {}),
      binding: {
        changeDigest: digest,
        algorithm: "provene-changeset-v1",
        parent: input.parent,
        excluded: [...DEFAULT_EXCLUDED_PREFIXES],
      },
      changes: {
        // RFC 0001 6.4: `file` is the only granularity a v0.1 emitter must produce.
        // Unlisted paths are UNOBSERVED, never human-authored.
        granularity: "file",
        // RFC 0001 6.4.1. `changes.files` is the CHANGESET -- everything that
        // differs between two tree states, the developer's own edits included.
        // `attributedTo` is the separate, weaker claim: the emitter saw this
        // session touch this path. Absent means unobserved, never human.
        //
        // This was computed from the journal and then thrown away for nine
        // revisions, while `check` reported an attribution count taken from
        // `changes.files` -- a number equal to the changed-path count by
        // construction, which is what a metric looks like when it measures
        // nothing.
        files: changed.map((e) => ({
          path: e.path,
          status: e.status,
          ...(e.prePath !== undefined ? { prePath: e.prePath } : {}),
          preBlob: e.preBlob,
          postBlob: e.postBlob,
          ...(attributed.has(e.path) ? { attributedTo: "agent" as const } : {}),
          verifiedBy: [] as string[],
        })),
      },
      commands: input.commands,
      verification: {
        runs: input.runs,
        // RFC 0001 6.6: paths that no verification RUN covers. A T0 receipt has
        // no runs, so every changed path is unverified -- which is the true claim.
        unverifiedPaths: changed.map((e) => e.path),
      },
      humanReview: { observed: false },
    },
  };
}

export function receiptFileName(statement: Statement, signed: boolean): string {
  const digest = statement.subject[0]?.digest["sha256"] ?? "";
  return `.provene/${digest}.${signed ? "dsse" : "statement"}.json`;
}

export function canonicalJson(statement: Statement): string {
  return JSON.stringify(statement, null, 2) + "\n";
}

export function statementDigest(serialized: string): string {
  return `sha256:${createHash("sha256").update(serialized, "utf8").digest("hex")}`;
}

/**
 * What a receipt's tier is actually worth.
 *
 * A union rather than a `Tier` plus a boolean, because the two situations are
 * not the same fact at different confidences: a signed T2 is verified evidence,
 * and an unsigned document saying "T2" is an assertion by whoever wrote the
 * file. Collapsing them into one field is what let a fork's pull request be
 * reported as CI-attested.
 */
/**
 * Does this document actually carry a signature?
 *
 * RFC 0001 §8 makes the FILENAME declare the encoding, which is right: a
 * document's claim about its own trustworthiness is not evidence. But nothing
 * checked that a file named `.dsse.json` contained an envelope, so renaming an
 * unsigned T0 statement to `forged.dsse.json` and editing one field made
 * `verify` report `T2`, exit 0, and suppress the self-attestation warning.
 *
 * The filename still decides which question is asked. This decides whether the
 * document can answer it.
 */
export function isDsseEnvelope(doc: unknown): boolean {
  const d = doc as Record<string, unknown> | null;
  if (d === null || typeof d !== "object") return false;
  return typeof d["payload"] === "string"
    && typeof d["payloadType"] === "string"
    && Array.isArray(d["signatures"])
    && d["signatures"].length > 0;
}

export type Assurance =
  | { readonly kind: "signed"; readonly tier: Tier }
  | { readonly kind: "unsigned"; readonly declared: Tier | "unknown" };

export interface CheckResult {
  readonly ok: boolean;
  readonly assurance: Assurance;
  readonly problems: string[];
  readonly rebased: boolean;
}

/**
 * Integrity, not sufficiency. `verify` reports the tier and passes any sound
 * receipt; whether that tier is admissible is a question for `policy check`.
 */
export function checkStatement(
  statement: unknown,
  actual: { entries: readonly ChangeEntry[]; parent: string } | undefined,
  /**
   * Whether the receipt arrived inside a signed envelope. Nothing signs yet, so
   * this is false everywhere today -- which is exactly why it must be passed
   * rather than inferred from the document. A receipt declaring "tier": "T2"
   * about itself is a claim, not evidence, and reporting it as T2 would present
   * a forged trust claim as verified.
   */
  signed = false,
): CheckResult {
  const problems: string[] = [];
  let rebased = false;
  const s = statement as Partial<Statement> | null;

  if (s === null || typeof s !== "object") {
    return { ok: false, assurance: { kind: "unsigned", declared: "unknown" }, problems: ["not an object"], rebased };
  }
  if (s._type !== STATEMENT_TYPE) problems.push(`_type must be ${STATEMENT_TYPE}`);
  if (s.predicateType !== PREDICATE_TYPE) problems.push(`predicateType must be ${PREDICATE_TYPE}`);

  const pred = (s.predicate ?? {}) as Record<string, any>;
  const declaredTier: Tier | "unknown" = pred["attestation"]?.tier ?? "unknown";

  // An unsigned receipt is T0 whatever it says about itself (RFC 0001 3, 7).
  const assurance: Assurance = signed
    ? { kind: "signed", tier: declaredTier === "unknown" ? "T0" : declaredTier }
    : { kind: "unsigned", declared: declaredTier };
  if (!signed && declaredTier !== "T0" && declaredTier !== "unknown") {
    problems.push(
      `unsigned receipt declares tier ${declaredTier}; an unsigned statement can only be T0`,
    );
  }
  if (pred["provene"] !== "0.1") problems.push("predicate.provene must be \"0.1\"");
  if (pred["changes"]?.granularity === "file") {
    const withSpans = (pred["changes"].files ?? []).filter((f: any) => f.attributed !== undefined);
    if (withSpans.length > 0) problems.push("granularity is 'file' but attributed spans are present");
  }

  // RFC 0001 6.4.1. Two rules, both about a receipt not being able to say two
  // things at once: the only permitted value is "agent", and a file carrying
  // attributed spans is by definition one the emitter observed the agent edit,
  // so it cannot decline to attribute the file those lines are in.
  for (const f of (pred["changes"]?.files ?? []) as Array<Record<string, unknown>>) {
    if (f["attributedTo"] !== undefined && f["attributedTo"] !== "agent") {
      problems.push(`${String(f["path"])}: attributedTo must be "agent", got ${JSON.stringify(f["attributedTo"])}`);
    }
    if (Array.isArray(f["attributed"]) && f["attributed"].length > 0 && f["attributedTo"] !== "agent") {
      problems.push(`${String(f["path"])}: has attributed spans but is not attributedTo the agent`);
    }
  }

  const claimed = s.subject?.[0]?.digest["sha256"];
  const binding = pred["binding"]?.changeDigest;
  if (claimed === undefined) problems.push("subject digest missing");
  else if (binding !== claimed) problems.push("binding.changeDigest does not equal the subject digest");

  // RFC 0001 6.4: changes.files MUST be exactly the entries the digest was taken
  // over, and a verifier must confirm it. Without this check the human-readable
  // half of the receipt is unbound from the signed half: an attacker can rewrite
  // the recorded blob ids, paths or statuses and the receipt still verifies
  // against the working tree. Found by tampering with a real receipt, not by review.
  // Checked unconditionally. Guarding on a non-empty file list let a receipt
  // with `"files": []` and any subject digest skip verification entirely --
  // absence treated as "nothing to check" rather than as a claim of its own.
  const declaredFiles = (pred["changes"]?.files ?? []) as Array<Record<string, string>>;
  if (claimed !== undefined) {
    const declared: ChangeEntry[] = declaredFiles.map((f) => ({
      status: f["status"] as ChangeEntry["status"],
      path: f["path"] ?? "",
      ...(f["prePath"] !== undefined ? { prePath: f["prePath"] } : {}),
      preBlob: f["preBlob"] ?? "",
      postBlob: f["postBlob"] ?? "",
    }));
    if (changeDigest(declared) !== claimed) {
      problems.push("changes.files do not reproduce the subject digest — the recorded file list is not bound to the signature");
    }
  }

  if (actual !== undefined && claimed !== undefined) {
    const recomputed = changeDigest(actual.entries);
    if (recomputed !== claimed) {
      problems.push(`change digest mismatch: receipt ${claimed.slice(0, 12)}, working tree ${recomputed.slice(0, 12)}`);
    } else if (pred["binding"]?.parent !== actual.parent) {
      // RFC 0001 4.2: advisory. Equal content with a different parent is a rebase.
      rebased = true;
    }
  }
  return { ok: problems.length === 0, assurance, problems, rebased };
}
