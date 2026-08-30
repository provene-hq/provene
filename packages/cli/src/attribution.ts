/**
 * RFC 0001 section 6.3 — content-anchored attribution.
 *
 * Spans are located by content, not position. Inserting a line above an
 * attributed span does not invalidate it; editing text inside the span does,
 * which is correct — the text is no longer what the agent produced, and
 * "approximately attributed" is not something this format offers.
 */
import { createHash } from "node:crypto";

export interface AttributedSpan {
  /** "sha256:<hex>" over the span text, lines joined with \n. */
  readonly digest: string;
  readonly lines: number;
  readonly anchorBefore?: string;
  readonly anchorAfter?: string;
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const hex = (ref: string): string => ref.slice(ref.indexOf(":") + 1);

export function spanDigest(lines: readonly string[]): string {
  return `sha256:${sha256(lines.join("\n"))}`;
}

export function buildSpan(
  fileLines: readonly string[],
  start: number,
  count: number,
): AttributedSpan {
  const span = fileLines.slice(start, start + count);
  const before = start > 0 ? fileLines[start - 1] : undefined;
  const after = start + count < fileLines.length ? fileLines[start + count] : undefined;
  return {
    digest: spanDigest(span),
    lines: count,
    ...(before !== undefined ? { anchorBefore: `sha256:${sha256(before)}` } : {}),
    ...(after !== undefined ? { anchorAfter: `sha256:${sha256(after)}` } : {}),
  };
}

/**
 * Anchors disambiguate between identical occurrences. They are not part of the
 * claim, so a unique content match is located even when its neighbours changed.
 */
export function locateSpan(span: AttributedSpan, fileLines: readonly string[]): boolean {
  const want = hex(span.digest);
  const hits: number[] = [];
  for (let i = 0; i + span.lines <= fileLines.length; i++) {
    if (sha256(fileLines.slice(i, i + span.lines).join("\n")) === want) hits.push(i);
  }
  if (hits.length === 0) return false;
  if (hits.length === 1) return true;

  return hits.some((i) => {
    const before = i > 0 ? sha256(fileLines[i - 1]!) : undefined;
    const afterIdx = i + span.lines;
    const after = afterIdx < fileLines.length ? sha256(fileLines[afterIdx]!) : undefined;
    const okBefore = span.anchorBefore === undefined || hex(span.anchorBefore) === before;
    const okAfter = span.anchorAfter === undefined || hex(span.anchorAfter) === after;
    return okBefore && okAfter;
  });
}
