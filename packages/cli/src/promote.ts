/**
 * Building the T2 aggregate that CI signs.
 *
 * RFC 0001 section 9: on a pull request or a squash merge the constituent
 * commits — and therefore their change digests — do not survive, so CI emits an
 * aggregate covering the whole range. CI is the only party present when the
 * merge result comes into existence, and it has no stake in the merge.
 *
 * This module builds the predicate. It does not sign: signing is done by the
 * workflow through GitHub's attestation action, which holds the OIDC identity
 * and selects the Sigstore instance by repository visibility. Keeping the
 * crypto out of here is what lets the CLI stay dependency-free.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { changeDigest } from "./changedigest.ts";
import { diffEntries } from "./git.ts";
import { loadReceipts, receiptsInRange } from "./check.ts";
import type { Statement } from "./receipt.ts";

export const AGGREGATE_PREDICATE_TYPE =
  "https://provene.dev/attestation/code-change-aggregate/v0.1";

export interface PromoteInput {
  readonly root: string;
  readonly base: string;
  readonly head: string;
  readonly emitterVersion: string;
  readonly attester: { identity: string; issuer?: string };
  /** GitHub picks the Sigstore instance from repository visibility; we do not. */
  readonly publishesToLog: boolean;
  readonly merge?: { kind: "squash" | "rebase" | "merge" | "pull-request"; pullRequest?: string; targetRef?: string };
  readonly runs?: ReadonlyArray<{
    id: string; kind: "test" | "lint" | "typecheck" | "build" | "check";
    tool?: string; result: "PASSED" | "WARNED" | "FAILED"; url?: string;
  }>;
  readonly unverifiedPaths?: readonly string[];
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Commits in base..head, so coverage can state how much of the range carries receipts. */
function commitsInRange(root: string, base: string, head: string): string[] {
  try {
    return execFileSync("git", ["rev-list", `${base}..${head}`], {
      encoding: "utf8", cwd: root, maxBuffer: 32 * 1024 * 1024,
    }).split("\n").filter((l) => l !== "");
  } catch {
    return [];
  }
}

export function buildAggregate(input: PromoteInput): { predicate: Record<string, unknown>; subjectDigest: string } {
  const entries = diffEntries(input.base, input.root);
  const subjectDigest = changeDigest(entries);

  // Only receipts this range introduced. A receipt from earlier history
  // describes different work and must not be carried forward as if it covered
  // these changes.
  const inRange = receiptsInRange(input.root, input.base, input.head);
  const constituents = loadReceipts(input.root)
    .filter(({ file }) => inRange.has(file))
    .map(({ file, statement }) => {
      const raw = readFileSync(join(input.root, ".provene", file), "utf8");
      const pred = (statement.predicate ?? {}) as Record<string, any>;
      return {
        receiptDigest: `sha256:${sha256(raw)}`,
        changeDigest: String(pred["binding"]?.changeDigest ?? ""),
        tier: (pred["attestation"]?.tier ?? "T0") as string,
        ...(pred["binding"]?.parent !== undefined ? { commit: String(pred["binding"].parent) } : {}),
      };
    })
    .filter((c) => /^[0-9a-f]{64}$/.test(c.changeDigest));

  const commits = commitsInRange(input.root, input.base, input.head);

  const predicate: Record<string, unknown> = {
    provene: "0.1",
    attestation: {
      tier: "T2",
      attester: input.attester,
      // Recorded as its own kind because the signer did not choose the
      // instance: GitHub selects public-good Sigstore for public repositories
      // and its private instance otherwise. Claiming either specifically would
      // tell a verifier something we do not know.
      trustRoot: { kind: "sigstore-github" },
      transparencyLog: { published: input.publishesToLog },
    },
    emitter: { name: "provene", version: input.emitterVersion },
    ...(input.merge !== undefined ? { merge: input.merge } : {}),
    binding: {
      changeDigest: subjectDigest,
      algorithm: "provene-changeset-v1",
      parent: input.base,
      excluded: [".provene/**"],
    },
    constituents,
    coverage: {
      // Emitted even when incomplete: a missing aggregate is indistinguishable
      // from a crashed job, while complete:false is a signed statement of
      // exactly how much was covered.
      complete: constituents.length > 0 && constituents.length >= commits.length,
      constituentsFound: constituents.length,
      commitsInRange: commits.length,
    },
    verification: {
      runs: (input.runs ?? []).map((r) => ({
        ...r,
        baseCommit: input.base,
        // An aggregate is signed by CI, so everything it carries was observed
        // by CI. A locally observed run cannot be promoted by restating it.
        observedBy: "ci" as const,
      })),
      unverifiedPaths: [...(input.unverifiedPaths ?? [])],
    },
    humanReview: { observed: false },
  };

  return { predicate, subjectDigest };
}
