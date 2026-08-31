/**
 * RFC 0001 section 4.1 — the change digest.
 *
 * A receipt binds to a change set rather than a commit, because the receipt is
 * written before the commit exists and is itself part of it. The digest is taken
 * over git blob identities, never over a rendered diff: diff rendering depends on
 * algorithm, context width, whitespace flags and rename heuristics, and none of
 * those may be allowed to move a signature.
 */
import { createHash } from "node:crypto";

/**
 * Status letters `git diff --raw` can emit for a tracked change.
 *
 * A added, M modified, D deleted, R renamed, C copied, T type changed (a file
 * becoming a symlink or a submodule, or the reverse). C and T were missing, so
 * a repository using symlinks or submodules produced a receipt whose status
 * letter its own JSON Schema rejects.
 */
export type ChangeStatus = "A" | "M" | "D" | "R" | "C" | "T";

export interface ChangeEntry {
  readonly status: ChangeStatus;
  /** Repository-relative path; the post-image path for renames. */
  readonly path: string;
  /** Pre-image path. Required when status is "R". */
  readonly prePath?: string;
  /** Git blob object ID, or "-" where that side does not exist. */
  readonly preBlob: string;
  readonly postBlob: string;
}

export const DEFAULT_EXCLUDED_PREFIXES: readonly string[] = [".provene/"];

function line(e: ChangeEntry): string {
  const base = `${e.status} ${e.path} ${e.preBlob} ${e.postBlob}`;
  if (e.status !== "R" && e.status !== "C") return base;
  if (e.prePath === undefined) {
    throw new Error(`${e.status} entry for ${e.path} is missing prePath (RFC 0001 section 4.1)`);
  }
  return `${base} <-${e.prePath}`;
}

/**
 * Sorts by the path's raw UTF-8 bytes.
 *
 * This is NOT `a.path.localeCompare(b.path)`, and it is NOT `a.path < b.path`.
 * JavaScript compares strings by UTF-16 code unit, and astral characters are
 * surrogate pairs beginning 0xD800-0xDBFF, which compare BELOW U+E000-U+FFFF.
 * A path containing an emoji or a CJK extension character therefore sorts to a
 * different position under the two orders, producing a different digest and so a
 * signature that no conformant verifier will accept.
 *
 * See conformance fixture changedigest/006-utf16-trap.
 */
function byUtf8Bytes(a: ChangeEntry, b: ChangeEntry): number {
  return Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8"));
}

export function canonicalPayload(
  entries: readonly ChangeEntry[],
  excludedPrefixes: readonly string[] = DEFAULT_EXCLUDED_PREFIXES,
): string {
  const kept = entries
    .filter((e) => !excludedPrefixes.some((p) => e.path.startsWith(p)))
    .slice()
    .sort(byUtf8Bytes);
  return kept.map(line).join("\n");
}

export function changeDigest(
  entries: readonly ChangeEntry[],
  excludedPrefixes: readonly string[] = DEFAULT_EXCLUDED_PREFIXES,
): string {
  const payload = canonicalPayload(entries, excludedPrefixes);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
