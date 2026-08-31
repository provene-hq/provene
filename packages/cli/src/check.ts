/**
 * `provene check` — what a reviewer actually needs.
 *
 * Not a summary of what was verified. A pointer to what was not: the changed
 * lines with no test behind them, annotated where the reviewer is already
 * looking. A reviewer drowning in agent-authored diffs does not need another
 * green badge; they need to know which twenty lines out of four hundred are
 * the ones nobody checked.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { changedLines, parseLcov, evidenceFor, type FileEvidence } from "./coverage.ts";
import { checkStatement, type Statement, type Tier } from "./receipt.ts";
import { diffEntries } from "./git.ts";

export interface ReceiptSummary {
  readonly file: string;
  readonly tier: Tier | "unknown";
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export interface CheckResult {
  readonly receipts: readonly ReceiptSummary[];
  readonly evidence: readonly FileEvidence[];
  readonly changedPaths: readonly string[];
  readonly attributedPaths: readonly string[];
  readonly unattributedPaths: readonly string[];
  readonly hasCoverage: boolean;
  /** File extensions the coverage report instruments, from the report itself. */
  readonly instrumentedExtensions: readonly string[];
}

const extension = (p: string): string => {
  const i = p.lastIndexOf(".");
  return i === -1 ? "" : p.slice(i);
};

export function loadReceipts(root: string): Array<{ file: string; statement: Statement }> {
  const dir = join(root, ".provene");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".statement.json") || f.endsWith(".dsse.json"))
    .sort()
    .map((f) => {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      // A DSSE envelope carries the statement in its payload; unsigned receipts
      // are the bare statement. The filename says which, per RFC 0001 section 8.
      const statement = (parsed["payload"] !== undefined && parsed["_statement_for_readability_only"] !== undefined
        ? parsed["_statement_for_readability_only"]
        : parsed) as Statement;
      return { file: f, statement };
    });
}

export function runCheck(opts: {
  root: string;
  base: string;
  lcovPath?: string;
}): CheckResult {
  const receipts = loadReceipts(opts.root).map(({ file, statement }) => {
    const r = checkStatement(statement, undefined);
    return { file, tier: r.tier, ok: r.ok, problems: r.problems };
  });

  const changed = changedLines(opts.base, opts.root);
  const changedPaths = [...changed.keys()].filter((p) => !p.startsWith(".provene/")).sort();

  // Which changed paths does any receipt claim the agent touched?
  const attributed = new Set<string>();
  for (const { statement } of loadReceipts(opts.root)) {
    const files = ((statement.predicate as Record<string, any>)["changes"]?.files ?? []) as Array<{ path: string }>;
    for (const f of files) attributed.add(f.path);
  }

  const hasCoverage = opts.lcovPath !== undefined && existsSync(opts.lcovPath);
  const coverage = hasCoverage ? parseLcov(readFileSync(opts.lcovPath!, "utf8")) : new Map();
  const filtered = new Map([...changed].filter(([p]) => !p.startsWith(".provene/")));

  return {
    receipts,
    instrumentedExtensions: [...new Set([...coverage.keys()].map(extension))],
    evidence: hasCoverage ? evidenceFor(filtered, coverage) : [],
    changedPaths,
    attributedPaths: changedPaths.filter((p) => attributed.has(p)),
    unattributedPaths: changedPaths.filter((p) => !attributed.has(p)),
    hasCoverage,
  };
}

/**
 * GitHub workflow-command annotations.
 *
 * Deliberately not the Checks API: workflow commands need no token, no octokit
 * and no network call, which keeps the whole thing dependency-free. GitHub caps
 * how many it will render per step, so the noisiest files are annotated first
 * and the rest are counted in the summary rather than dropped silently.
 */
/**
 * A file the run instruments files *like* but did not instrument at all is the
 * loudest signal available: no test so much as loads it. A file of a kind the
 * run never instruments -- a package.json, a YAML config -- is not evidence of
 * anything and must not be annotated, or the warnings become noise.
 */
export function untestedSourceFiles(result: CheckResult): FileEvidence[] {
  // Derived from the coverage REPORT, not from the changed files. Deriving it
  // from the changed set is empty precisely when it matters most: when every
  // changed file is one nothing tests.
  const instrumented = new Set(result.instrumentedExtensions);
  return result.evidence.filter(
    (e) => !e.instrumented && instrumented.has(extension(e.path)),
  );
}

export function annotations(result: CheckResult, limit = 10): string[] {
  const out: string[] = [];

  // Files nothing tests come first: a reviewer can skim uncovered lines, but a
  // file with no test at all is where the risk actually is.
  for (const file of untestedSourceFiles(result)) {
    if (out.length >= limit) break;
    out.push(
      `::warning file=${file.path},line=1::` +
      `no test in this run loads ${file.path}; ${file.changed} changed line(s) have no evidence`,
    );
  }

  const ranked = [...result.evidence]
    .filter((e) => e.instrumented && e.uncoveredRanges.length > 0)
    .sort((a, b) => (b.changed - b.covered) - (a.changed - a.covered));

  for (const file of ranked) {
    if (out.length >= limit) break;
    const range = file.uncoveredRanges[0]!;
    const uncovered = file.changed - file.covered;
    const span = range.start === range.end ? `line ${range.start}` : `lines ${range.start}-${range.end}`;
    out.push(
      `::warning file=${file.path},line=${range.start},endLine=${range.end}::` +
      `${uncovered} of ${file.changed} changed lines have no test evidence (from ${span})`,
    );
  }
  return out;
}

export function summary(result: CheckResult): string[] {
  const lines: string[] = [];
  const good = result.receipts.filter((r) => r.ok).length;
  const bad = result.receipts.filter((r) => !r.ok);

  if (result.receipts.length === 0) {
    lines.push("No receipts found. Nothing was evaluated.");
  } else {
    const tiers = result.receipts.map((r) => r.tier).join(", ");
    lines.push(`${good}/${result.receipts.length} receipt(s) well formed (tiers: ${tiers})`);
  }
  for (const r of bad) {
    lines.push(`  ${r.file} FAILED`);
    for (const p of r.problems) lines.push(`    - ${p}`);
  }

  lines.push(`${result.changedPaths.length} changed path(s); ` +
             `${result.attributedPaths.length} carry agent attribution`);

  if (!result.hasCoverage) {
    lines.push("No coverage report supplied, so no line-level evidence could be established.");
    lines.push("  Pass --coverage <lcov.info> to see which changed lines a test actually executed.");
    return lines;
  }

  const instrumented = result.evidence.filter((e) => e.instrumented);
  const notInstrumented = result.evidence.filter((e) => !e.instrumented);
  const totalChanged = instrumented.reduce((n, e) => n + e.changed, 0);
  const totalCovered = instrumented.reduce((n, e) => n + e.covered, 0);
  lines.push(`${totalCovered}/${totalChanged} changed lines executed by the test run`);
  const untested = untestedSourceFiles(result);
  if (untested.length > 0) {
    lines.push(`${untested.length} changed source file(s) that no test in this run loads:`);
    for (const f of untested.slice(0, 5)) lines.push(`  ${f.path} (${f.changed} changed lines)`);
  }
  const other = notInstrumented.length - untested.length;
  if (other > 0) lines.push(`${other} other changed path(s) the run does not instrument (config, data, docs)`);
  const worst = [...instrumented]
    .filter((e) => e.covered < e.changed)
    .sort((a, b) => (b.changed - b.covered) - (a.changed - a.covered))
    .slice(0, 8);
  for (const f of worst) {
    lines.push(`  ${f.path}: ${f.changed - f.covered} of ${f.changed} changed lines unverified`);
  }
  return lines;
}
