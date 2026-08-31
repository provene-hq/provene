/**
 * `provene check` — what a reviewer actually needs.
 *
 * Not a summary of what was verified. A pointer to what was not: the changed
 * lines with no test behind them, annotated where the reviewer is already
 * looking.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  changedLines, parseLcov, evidenceFor, instrumentedExtensions,
  type FileEvidence,
} from "./coverage.ts";
import { checkStatement, type Statement, type Assurance } from "./receipt.ts";
import { matches } from "./glob.ts";

export interface ReceiptSummary {
  readonly file: string;
  /** Introduced by this change. Only these may fail the check. */
  readonly inRange: boolean;
  readonly assurance: Assurance;
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export interface CheckResult {
  readonly receipts: readonly ReceiptSummary[];
  readonly evidence: readonly FileEvidence[];
  readonly changedPaths: readonly string[];
  readonly agentAttributedPaths: readonly string[];
  readonly nonAgentPaths: readonly string[];
  readonly hasCoverage: boolean;
}

/** Receipt files added or modified between two commits. */
export function receiptsInRange(root: string, base: string, head: string): Set<string> {
  try {
    const raw = execFileSync("git", [
      "-c", "core.quotePath=false", "diff", "--name-only", "-z", base, head, "--", ".provene/",
    ], { encoding: "utf8", cwd: root, maxBuffer: 16 * 1024 * 1024 });
    return new Set(raw.split("\0").filter((f) => f !== "").map((f) => f.replace(/^\.provene\//, "")));
  } catch {
    return new Set();
  }
}

export function loadReceipts(root: string): Array<{ file: string; statement: Statement }> {
  const dir = join(root, ".provene");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".statement.json") || f.endsWith(".dsse.json"))
    .sort()
    .map((f) => {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      const statement = (parsed["payload"] !== undefined && parsed["_statement_for_readability_only"] !== undefined
        ? parsed["_statement_for_readability_only"]
        : parsed) as Statement;
      return { file: f, statement };
    });
}

export function runCheck(opts: {
  root: string;
  base: string;
  head?: string;
  lcovPath?: string;
  exclude?: readonly string[];
}): CheckResult {
  const head = opts.head ?? "HEAD";
  const all = loadReceipts(opts.root);

  const inRange = receiptsInRange(opts.root, opts.base, head);

  const receipts = all.map(({ file, statement }) => {
    // The filename declares the encoding (RFC 0001 8): only a .dsse.json is a
    // signed envelope. Passed in rather than read from the document, because a
    // document's claim about its own trustworthiness is not evidence.
    const r = checkStatement(statement, undefined, file.endsWith(".dsse.json"));
    return { file, inRange: inRange.has(file), assurance: r.assurance, ok: r.ok, problems: r.problems };
  });

  const changed = changedLines(opts.base, head, opts.root);
  const filtered = new Map(
    [...changed].filter(([p]) => !p.startsWith(".provene/")
      && !(opts.exclude ?? []).some((g) => matches(g, p))),
  );
  const changedPaths = [...filtered.keys()].sort();

  // Only receipts THIS change introduced may attribute anything in it. Every
  // receipt ever committed lives in .provene/, so reading all of them reported
  // a file an agent touched months ago as agent-authored in a pull request a
  // human wrote by hand.
  const attributed = new Set<string>();
  for (const { file, statement } of all) {
    if (!inRange.has(file)) continue;
    const files = ((statement.predicate as Record<string, any>)["changes"]?.files ?? []) as Array<{ path: string }>;
    for (const f of files) attributed.add(f.path);
  }

  const hasCoverage = opts.lcovPath !== undefined && existsSync(opts.lcovPath);
  const coverage = hasCoverage ? parseLcov(readFileSync(opts.lcovPath!, "utf8")) : new Map();

  return {
    receipts,
    evidence: hasCoverage ? evidenceFor(filtered, coverage, instrumentedExtensions(coverage)) : [],
    changedPaths,
    agentAttributedPaths: changedPaths.filter((p) => attributed.has(p)),
    nonAgentPaths: changedPaths.filter((p) => !attributed.has(p)),
    hasCoverage,
  };
}

/**
 * GitHub workflow-command annotations.
 *
 * Deliberately not the Checks API: workflow commands need no token, no octokit
 * and no network call. GitHub caps how many it renders per step, so the files
 * with the most missing evidence are annotated first and the rest are counted
 * in the summary rather than dropped silently.
 */
export function annotations(result: CheckResult, limit = 10): string[] {
  const out: string[] = [];

  // Files nothing tests come first: a reviewer can skim uncovered lines, but a
  // file with no test at all is where the risk actually is.
  for (const f of result.evidence) {
    if (out.length >= limit) break;
    if (f.kind !== "untested") continue;
    out.push(`::warning file=${f.path},line=1::no test in this run loads ${f.path}; ` +
             `${f.changed} changed line(s) have no evidence`);
  }

  const ranked = result.evidence
    .filter((e): e is Extract<FileEvidence, { kind: "instrumented" }> =>
      e.kind === "instrumented" && e.uncoveredRanges.length > 0)
    .sort((a, b) => (b.changed - b.covered) - (a.changed - a.covered));

  for (const f of ranked) {
    if (out.length >= limit) break;
    const range = f.uncoveredRanges[0]!;
    const span = range.start === range.end ? `line ${range.start}` : `lines ${range.start}-${range.end}`;
    out.push(`::warning file=${f.path},line=${range.start},endLine=${range.end}::` +
             `${f.changed - f.covered} of ${f.changed} changed lines have no test evidence (from ${span})`);
  }
  return out;
}

const describeAssurance = (a: Assurance): string =>
  a.kind === "signed" ? a.tier
  : a.declared === "T0" || a.declared === "unknown" ? "T0"
  : `T0 (unsigned; the document claims ${a.declared})`;

export function summary(result: CheckResult): string[] {
  const lines: string[] = [];
  const good = result.receipts.filter((r) => r.ok).length;

  if (result.receipts.length === 0) {
    lines.push("No receipts found. Nothing was evaluated.");
  } else {
    const tiers = result.receipts.map((r) => describeAssurance(r.assurance)).join(", ");
    lines.push(`${good}/${result.receipts.length} receipt(s) well formed (${tiers})`);
  }
  for (const r of result.receipts.filter((x) => !x.ok)) {
    lines.push(`  ${r.file} FAILED${r.inRange ? "" : " (pre-existing, not from this change)"}`);
    for (const p of r.problems) lines.push(`    - ${p}`);
  }

  lines.push(`${result.changedPaths.length} changed path(s); ` +
             `${result.agentAttributedPaths.length} carry agent attribution from this change`);

  if (!result.hasCoverage) {
    lines.push("No coverage report supplied, so no line-level evidence could be established.");
    lines.push("  Pass --coverage <lcov.info> to see which changed lines a test actually executed.");
    return lines;
  }

  const instrumented = result.evidence.filter(
    (e): e is Extract<FileEvidence, { kind: "instrumented" }> => e.kind === "instrumented");
  const totalChanged = instrumented.reduce((n, e) => n + e.changed, 0);
  const totalCovered = instrumented.reduce((n, e) => n + e.covered, 0);
  lines.push(`${totalCovered}/${totalChanged} executable changed lines executed by the test run`);

  const untested = result.evidence.filter((e) => e.kind === "untested");
  if (untested.length > 0) {
    lines.push(`${untested.length} changed source file(s) that no test in this run loads:`);
    for (const f of untested.slice(0, 5)) lines.push(`  ${f.path} (${f.changed} changed lines)`);
  }

  const worst = [...instrumented]
    .filter((e) => e.covered < e.changed)
    .sort((a, b) => (b.changed - b.covered) - (a.changed - a.covered))
    .slice(0, 8);
  for (const f of worst) {
    lines.push(`  ${f.path}: ${f.changed - f.covered} of ${f.changed} executable changed lines unverified`);
  }

  const ambiguous = result.evidence.filter(
    (e): e is Extract<FileEvidence, { kind: "ambiguous" }> => e.kind === "ambiguous");
  for (const f of ambiguous) {
    lines.push(`  ${f.path}: coverage is ambiguous (${f.candidates.length} entries match); reporting none`);
  }

  const other = result.evidence.filter((e) => e.kind === "not-instrumentable" || e.kind === "declaration").length;
  if (other > 0) {
    lines.push(`${other} changed path(s) with nothing executable to cover (config, data, declarations)`);
  }
  return lines;
}
