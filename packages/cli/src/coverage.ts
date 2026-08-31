/**
 * Turning "the suite ran" into "these changed lines have evidence behind them".
 *
 * A passing suite says nothing about any particular file. The reviewer's
 * question is narrower: of the lines this change touched, which did a test
 * actually execute? That needs line-level coverage, so lcov is a first-class
 * input rather than an afterthought.
 */
import { execFileSync } from "node:child_process";

/**
 * path -> set of line numbers the diff added or modified.
 *
 * `head` defaults to the committed state rather than the working tree. The unit
 * of review for a pull request is what was committed; in CI the working tree
 * also holds whatever the build did to it.
 *
 * core.quotePath and the diff prefixes are pinned so that parsing does not
 * depend on the user's git configuration: quoting breaks path matching, and a
 * user with diff.noprefix set would have a real top-level `b/` eaten.
 */
export function changedLines(base: string, head = "HEAD", cwd?: string): Map<string, Set<number>> {
  const raw = execFileSync("git", [
    "-c", "core.quotePath=false", "diff", "-U0", "--no-color", "--no-ext-diff",
    "--src-prefix=a/", "--dst-prefix=b/", base, head,
  ], { encoding: "utf8", cwd: cwd ?? process.cwd(), maxBuffer: 64 * 1024 * 1024 });

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
      file = line.slice(3).replace(/\\/g, "/").replace(/^\.\//, "");
      if (!out.has(file)) out.set(file, new Map());
    } else if (line.startsWith("DA:") && file !== undefined) {
      const [n, count] = line.slice(3).split(",");
      if (n !== undefined && count !== undefined) out.get(file)!.set(Number(n), Number(count));
    } else if (line === "end_of_record") {
      file = undefined;
    }
  }
  return out;
}

/**
 * Declaration and type-only files contain no executable statements, so they can
 * never appear in a coverage report. Warning that "no test loads this" about a
 * file no test could ever execute is how thirty real warnings get ignored.
 */
/**
 * Only `.d.ts` is structurally incapable of containing executable code. A file
 * merely NAMED types.ts routinely holds runtime validators and type guards, and
 * treating it as a declaration silently suppressed warnings about hundreds of
 * untested lines -- a false negative, which is worse here than a false positive
 * because nobody notices the warning that never appeared.
 *
 * Everything else reaches the "declaration" state only when the coverage report
 * itself confirms no executable line changed.
 */
const TYPE_ONLY = /\.d\.ts$/;

/**
 * The state of one changed file with respect to test evidence.
 *
 * A discriminated union rather than flags, because the previous shape --
 * `instrumented: boolean` -- collapsed four genuinely different situations into
 * two, and every collapse produced confident wrong output: a closing brace read
 * as untested code, a package.json read as untested code, a declaration file
 * warned about forever, and an ambiguous coverage match silently attributing one
 * file's tests to another. The illegal states are now unrepresentable.
 */
export type FileEvidence =
  | {
      readonly kind: "instrumented";
      readonly path: string;
      /** Executable changed lines only. Non-executable lines are not counted. */
      readonly changed: number;
      readonly covered: number;
      readonly uncoveredRanges: ReadonlyArray<{ start: number; end: number }>;
    }
  | {
      /** Of a kind this run instruments, but absent from the report: nothing loads it. */
      readonly kind: "untested";
      readonly path: string;
      readonly changed: number;
    }
  | {
      /** Type-only: no executable statements exist to cover. */
      readonly kind: "declaration";
      readonly path: string;
      readonly changed: number;
    }
  | {
      /** Not a kind this run instruments at all: config, data, docs. */
      readonly kind: "not-instrumentable";
      readonly path: string;
      readonly changed: number;
    }
  | {
      /**
       * Several coverage entries match this path and none is clearly right.
       * Reported rather than guessed: attaching one file's coverage to another
       * is worse than admitting we cannot tell.
       */
      readonly kind: "ambiguous";
      readonly path: string;
      readonly changed: number;
      readonly candidates: readonly string[];
    };

const extensionOf = (p: string): string => {
  const i = p.lastIndexOf(".");
  return i === -1 ? "" : p.slice(i);
};

/**
 * Resolves one repo-relative path against the coverage report's own paths.
 *
 * Matching must work in both directions: a report written from a package
 * subdirectory is shorter than the repo-relative path, an absolute one is
 * longer. Where more than one entry matches, the longest wins only if it is
 * strictly longer than the rest -- otherwise the result is ambiguous, which in
 * a monorepo with two `src/utils.ts` is the difference between no evidence and
 * wrong evidence.
 */
function resolveCoverage(
  path: string,
  coverage: ReadonlyMap<string, Map<number, number>>,
): { kind: "found"; lines: Map<number, number> } | { kind: "none" } | { kind: "ambiguous"; candidates: string[] } {
  const direct = coverage.get(path);
  if (direct !== undefined) return { kind: "found", lines: direct };

  const matches = [...coverage.keys()].filter(
    (k) => path.endsWith(`/${k}`) || k.endsWith(`/${path}`),
  );
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "found", lines: coverage.get(matches[0]!)! };

  // More than one entry matches, so we cannot tell which file this is. Ranking
  // by path length was tried and is wrong: length is a proxy for correctness
  // only when the candidates are absolute and relative forms of the SAME file,
  // and that case is already handled by the exact match above. For two genuinely
  // different files it picks one at random and attributes the wrong test
  // results to the wrong code.
  return { kind: "ambiguous", candidates: [...matches].sort() };
}

export function evidenceFor(
  changed: ReadonlyMap<string, Set<number>>,
  coverage: ReadonlyMap<string, Map<number, number>>,
  instrumentedExtensions: ReadonlySet<string>,
): FileEvidence[] {
  const out: FileEvidence[] = [];

  for (const [path, lines] of changed) {
    if (lines.size === 0) continue;
    const resolved = resolveCoverage(path, coverage);

    if (resolved.kind === "ambiguous") {
      out.push({ kind: "ambiguous", path, changed: lines.size, candidates: resolved.candidates });
      continue;
    }

    if (resolved.kind === "none") {
      const kind = TYPE_ONLY.test(path) ? "declaration"
        : instrumentedExtensions.has(extensionOf(path)) ? "untested"
        : "not-instrumentable";
      out.push({ kind, path, changed: lines.size });
      continue;
    }

    // Only lines the report mentions are executable. A closing brace or a blank
    // line has no DA entry and is not evidence of anything.
    const executable = [...lines].filter((n) => resolved.lines.has(n)).sort((a, b) => a - b);
    if (executable.length === 0) {
      out.push({ kind: "declaration", path, changed: lines.size });
      continue;
    }
    const uncovered = executable.filter((n) => resolved.lines.get(n) === 0);

    const ranges: Array<{ start: number; end: number }> = [];
    for (const n of uncovered) {
      const last = ranges[ranges.length - 1];
      if (last !== undefined && n === last.end + 1) last.end = n;
      else ranges.push({ start: n, end: n });
    }
    out.push({
      kind: "instrumented",
      path,
      changed: executable.length,
      covered: executable.length - uncovered.length,
      uncoveredRanges: ranges,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function instrumentedExtensions(coverage: ReadonlyMap<string, unknown>): Set<string> {
  return new Set([...coverage.keys()].map(extensionOf));
}
