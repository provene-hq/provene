/**
 * Turning "the suite ran" into "these changed lines have evidence behind them".
 *
 * A passing test suite says nothing about any particular file. The reviewer's
 * question is narrower and much more useful: of the lines this pull request
 * changed, which ones did a test actually execute? That needs line-level
 * coverage, so lcov is a first-class input rather than an afterthought.
 */
import { execFileSync } from "node:child_process";

/**
 * path -> set of line numbers the diff added or modified.
 *
 * `head` defaults to the committed state rather than the working tree. The unit
 * of review for a pull request is what was committed; in CI the working tree
 * also contains whatever the build did to it, so diffing against it reports
 * build output as part of the author's change. Observed on this repository's
 * own first pull request, where `npm install` rewrote a tracked
 * package-lock.json and `check` counted it as a changed path.
 */
export function changedLines(base: string, head = "HEAD", cwd?: string): Map<string, Set<number>> {
  const raw = execFileSync("git", ["diff", "-U0", "--no-color", "--no-ext-diff", base, head], {
    encoding: "utf8", cwd: cwd ?? process.cwd(), maxBuffer: 64 * 1024 * 1024,
  });
  const out = new Map<string, Set<number>>();
  let path: string | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      path = p === "/dev/null" ? undefined : p.replace(/^b\//, "");
      if (path !== undefined && !out.has(path)) out.set(path, new Set());
      continue;
    }
    if (path === undefined || !line.startsWith("@@")) continue;
    // @@ -old,count +new,count @@
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m === null) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    const set = out.get(path)!;
    for (let i = 0; i < count; i++) set.add(start + i);
  }
  return out;
}

/** path -> (line -> execution count), from an lcov.info report. */
export function parseLcov(text: string): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  let file: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      file = normalise(line.slice(3));
      if (!out.has(file)) out.set(file, new Map());
    } else if (line.startsWith("DA:") && file !== undefined) {
      const [n, count] = line.slice(3).split(",");
      if (n !== undefined && count !== undefined) {
        out.get(file)!.set(Number(n), Number(count));
      }
    } else if (line === "end_of_record") {
      file = undefined;
    }
  }
  return out;
}

/** lcov paths are often absolute or ./-prefixed; receipts use repo-relative. */
function normalise(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export interface FileEvidence {
  readonly path: string;
  /**
   * False when the test run produced no coverage data for this file at all.
   * "Not instrumented" and "instrumented but untested" are different claims:
   * a package.json is the former, and reporting it as untested code would put
   * warnings on files no test could ever execute.
   */
  readonly instrumented: boolean;
  readonly changed: number;
  readonly covered: number;
  /** Contiguous ranges of changed-but-unexecuted lines, for annotation. */
  readonly uncoveredRanges: Array<{ start: number; end: number }>;
}

export function evidenceFor(
  changed: Map<string, Set<number>>,
  coverage: Map<string, Map<number, number>>,
): FileEvidence[] {
  // Paths have to be matched in BOTH directions. lcov written from a package
  // subdirectory is shorter than the repo-relative diff path
  // (src/x.ts vs packages/cli/src/x.ts); lcov written with absolute paths is
  // longer. Testing only one direction silently matches nothing, which reads
  // as "no line was executed" rather than as the configuration error it is.
  const lookup = (p: string): Map<number, number> | undefined => {
    const direct = coverage.get(p);
    if (direct !== undefined) return direct;
    for (const [k, v] of coverage) {
      if (p.endsWith(`/${k}`) || k.endsWith(`/${p}`)) return v;
    }
    return undefined;
  };

  const out: FileEvidence[] = [];
  for (const [path, lines] of changed) {
    if (lines.size === 0) continue;
    const cov = lookup(path);
    // Only lines lcov reports on are executable. A closing brace, a blank line
    // or a type declaration has no DA entry, and counting those as "unverified"
    // would put a warning on every brace in the diff -- which is how an
    // annotation becomes noise the reviewer learns to scroll past.
    const sorted = [...lines]
      .filter((n) => cov === undefined || cov.has(n))
      .sort((a, b) => a - b);
    const uncovered = sorted.filter((n) => (cov?.get(n) ?? 0) === 0);

    const ranges: Array<{ start: number; end: number }> = [];
    for (const n of uncovered) {
      const last = ranges[ranges.length - 1];
      if (last !== undefined && n === last.end + 1) last.end = n;
      else ranges.push({ start: n, end: n });
    }
    out.push({
      path,
      instrumented: cov !== undefined,
      changed: sorted.length,
      covered: sorted.length - uncovered.length,
      uncoveredRanges: cov === undefined ? [] : ranges,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
