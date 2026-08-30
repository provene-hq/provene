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

export interface BuildInput {
  readonly subjectName: string;
  readonly entries: readonly ChangeEntry[];
  readonly parent: string;
  readonly agent: { vendor?: string; tool: string; toolVersion?: string;
                    model?: string; modelSource: "reported" | "configured" };
  readonly task?: { ref?: string; sessionRef?: string; digest?: string };
  readonly session?: { id: string; startedAt: string; endedAt: string; toolCalls: number };
  readonly commands: readonly RedactedCommand[];
  readonly attributedPaths: readonly string[];
}

/** A T0 receipt: unsigned, and therefore a bare Statement rather than a DSSE envelope. */
export function buildT0(input: BuildInput): Statement {
  const digest = changeDigest(input.entries);
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
        // RFC 0001 6.3: `file` is the only granularity a v0.1 emitter must produce.
        // Unlisted paths are UNOBSERVED, never human-authored.
        granularity: "file",
        files: changed.map((e) => ({
          path: e.path,
          status: e.status,
          ...(e.prePath !== undefined ? { prePath: e.prePath } : {}),
          preBlob: e.preBlob,
          postBlob: e.postBlob,
          verifiedBy: [] as string[],
        })),
      },
      commands: input.commands,
      verification: {
        runs: [],
        // RFC 0001 6.5: paths that no verification RUN covers. A T0 receipt has
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

export interface CheckResult {
  readonly ok: boolean;
  readonly tier: Tier | "unknown";
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
): CheckResult {
  const problems: string[] = [];
  let rebased = false;
  const s = statement as Partial<Statement> | null;

  if (s === null || typeof s !== "object") return { ok: false, tier: "unknown", problems: ["not an object"], rebased };
  if (s._type !== STATEMENT_TYPE) problems.push(`_type must be ${STATEMENT_TYPE}`);
  if (s.predicateType !== PREDICATE_TYPE) problems.push(`predicateType must be ${PREDICATE_TYPE}`);

  const pred = (s.predicate ?? {}) as Record<string, any>;
  const tier: Tier | "unknown" = pred["attestation"]?.tier ?? "unknown";
  if (pred["provene"] !== "0.1") problems.push("predicate.provene must be \"0.1\"");
  if (pred["changes"]?.granularity === "file") {
    const withSpans = (pred["changes"].files ?? []).filter((f: any) => f.attributed !== undefined);
    if (withSpans.length > 0) problems.push("granularity is 'file' but attributed spans are present");
  }

  const claimed = s.subject?.[0]?.digest["sha256"];
  const binding = pred["binding"]?.changeDigest;
  if (claimed === undefined) problems.push("subject digest missing");
  else if (binding !== claimed) problems.push("binding.changeDigest does not equal the subject digest");

  // RFC 0001 6.3: changes.files MUST be exactly the entries the digest was taken
  // over, and a verifier must confirm it. Without this check the human-readable
  // half of the receipt is unbound from the signed half: an attacker can rewrite
  // the recorded blob ids, paths or statuses and the receipt still verifies
  // against the working tree. Found by tampering with a real receipt, not by review.
  const declaredFiles = (pred["changes"]?.files ?? []) as Array<Record<string, string>>;
  if (claimed !== undefined && declaredFiles.length > 0) {
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
  return { ok: problems.length === 0, tier, problems, rebased };
}
