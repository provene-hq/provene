/**
 * Antigravity: reading a session out of its transcript, because there is
 * nothing else to read it from.
 *
 * Every other agent Provene supports is wired with hooks. Antigravity has no
 * hook that fires, no CLI, and no MCP surface -- five experiments run against
 * 2.11.0.0 came back negative on all three. What it does have is a transcript
 * it writes for itself:
 *
 *   ~/.gemini/antigravity/brain/<session>/.system_generated/logs/transcript.jsonl
 *
 * That file is a log, not a protocol. Nobody promised it to us, its shape has
 * already changed once inside our own sample (May's steps carry `CODE_ACTION`
 * results, August's carry `GENERIC`), and it is written for a UI to replay
 * rather than for a third party to parse. Everything below is therefore built
 * to lose evidence quietly when the format moves, and never to invent any.
 *
 * ## What is read, and what is not
 *
 * The transcript contains the developer's prompts in plaintext, the model's
 * private reasoning, the full text of every file written, and the complete
 * stdout of every command. RFC 0001 section 10 forbids recording any of it, and
 * the journal this feeds is UNREDACTED by design, so a careless reader here
 * writes prompts and source code to disk outside the repository.
 *
 * The reader is an allowlist of four fields:
 *
 *   run_command            -> args.CommandLine, args.Cwd
 *   replace_file_content   -> args.TargetFile
 *   write_to_file          -> args.TargetFile
 *
 * `content`, `thinking`, `CodeContent`, `ReplacementContent`, `TargetContent`,
 * `Instruction`, `Description`, `toolSummary` and every result body are never
 * copied into a journal entry. The one thing read from a result is a single
 * integer matched by a regular expression.
 */
import { readFileSync } from "node:fs";
import type { JournalEntry } from "./journal.ts";
import { isWithin } from "./paths.ts";

/** One line of the transcript. Every field optional: this is a log we do not own. */
interface Step {
  readonly type?: unknown;
  readonly created_at?: unknown;
  readonly content?: unknown;
  readonly tool_calls?: unknown;
}

interface ToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/**
 * Argument values are JSON documents inside a JSON document.
 *
 * `"CommandLine": "\"node --test\""` and `"WaitMsBeforeAsync": "5000"` -- the
 * value is a string whose contents are themselves JSON, so a path arrives as
 * `"\"e:\\\\provene\\\\README.md\""` and needs parsing twice.
 *
 * If the inner parse fails the raw string is used instead. A future build that
 * stops double-encoding would otherwise silently record nothing at all, and a
 * path is a path either way. If the parse SUCCEEDS but yields something that is
 * not a string -- a number, null -- nothing is returned: that is a shape we do
 * not recognise, and a guess about it would end up in a receipt.
 */
export function decodeArg(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return raw === "" ? undefined : raw;
  }
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The outcome of a command, if the transcript states one.
 *
 * Antigravity records an exit status as English prose in the step that follows
 * the call -- "The command exited with code 0." -- and there is no identifier
 * tying that step back to the call it describes. The pairing is positional and
 * nothing enforces it, so this fails closed in every direction: a missing next
 * step, a next step with no such sentence, or a call sharing its step with
 * another call all yield no outcome rather than a guess.
 *
 * Losing an outcome costs one verification run. Inventing one puts "the tests
 * passed" into a signed artifact on no evidence, which is the only failure this
 * format cannot survive.
 */
const EXIT_PROSE = /^The command exited with code (-?\d+)\.$/m;

/**
 * A backgrounded command has not finished. The transcript says so in place of
 * an exit code, and the exit code arrives later in a task log we do not read.
 * Matching this explicitly means a backgrounded test run is recorded as having
 * run and not as having passed -- the same rule as Gemini's `is_background`.
 */
const BACKGROUNDED = /^Tool is running as a background task\b/m;

export function outcomeOf(next: Step | undefined): number | undefined {
  if (next === undefined || typeof next.content !== "string") return undefined;
  if (BACKGROUNDED.test(next.content)) return undefined;
  const m = EXIT_PROSE.exec(next.content);
  if (m === null) return undefined;
  const code = Number(m[1]);
  return Number.isInteger(code) ? code : undefined;
}

const EDIT_TOOLS = new Set(["replace_file_content", "write_to_file"]);

function toolCallsOf(step: Step): ToolCall[] {
  if (!Array.isArray(step.tool_calls)) return [];
  const calls: ToolCall[] = [];
  for (const raw of step.tool_calls) {
    if (typeof raw !== "object" || raw === null) continue;
    const { name, args } = raw as { name?: unknown; args?: unknown };
    if (typeof name !== "string" || name === "") continue;
    calls.push({ name, args: typeof args === "object" && args !== null ? args as Record<string, unknown> : {} });
  }
  return calls;
}

/** `created_at` when it is a usable timestamp, otherwise now. */
function timeOf(step: Step): string {
  if (typeof step.created_at === "string") {
    const t = Date.parse(step.created_at);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

/** Parses the file, skipping lines that are not JSON objects rather than throwing. */
export function readTranscript(path: string): Step[] {
  const steps: Step[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (typeof v === "object" && v !== null && !Array.isArray(v)) steps.push(v as Step);
    } catch {
      // A truncated final line is normal in a log still being written.
    }
  }
  return steps;
}

export interface TranscriptOptions {
  /**
   * Absolute repository root. Edits outside it are dropped.
   *
   * Antigravity writes into its own brain directory with the same
   * `write_to_file` tool it uses on your code -- plans, notes, its own
   * scratch. Without this filter those become attributed paths in a receipt
   * about your repository, and the receipt names files the change never
   * touched. Omit it only when you want everything, which no caller does.
   */
  readonly repoRoot?: string;
  /** Windows paths differ in case and separator from anything git reports. */
  readonly caseInsensitive?: boolean;
}

/**
 * A transcript names files with whatever the model wrote, which includes `..`.
 * Resolving segments is the whole job here -- see paths.ts.
 */
export const withinRepo = (path: string, root: string, caseInsensitive: boolean): boolean =>
  isWithin(path, root, caseInsensitive);

/**
 * Maps a whole transcript to journal entries.
 *
 * Ordering is the file's own ordering. `step_index` is present and monotonic in
 * every sample, but it is not relied on: the pairing rule above is positional,
 * so re-sorting by a field the writer controls would change which result
 * belongs to which call.
 */
export function antigravityEntries(steps: readonly Step[], options: TranscriptOptions = {}): JournalEntry[] {
  const { repoRoot, caseInsensitive = process.platform === "win32" } = options;
  const entries: JournalEntry[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const calls = toolCallsOf(step);
    // Two calls in one step share one following result. Which result belongs to
    // which is not recoverable, so neither gets an outcome. Rare -- five steps
    // in ten real sessions -- and the alternative is attributing an exit code
    // to the wrong command.
    const ambiguous = calls.length > 1;
    const at = timeOf(step);

    for (const call of calls) {
      if (EDIT_TOOLS.has(call.name)) {
        const path = decodeArg(call.args["TargetFile"]);
        if (path === undefined) continue;
        if (repoRoot !== undefined && !withinRepo(path, repoRoot, caseInsensitive)) continue;
        entries.push({ at, kind: "edit", path });
        continue;
      }

      if (call.name === "run_command") {
        const command = decodeArg(call.args["CommandLine"]);
        if (command === undefined || command.trim() === "") continue;

        // Where the command ran decides whether it is evidence about THIS
        // repository. An Antigravity session is not scoped to one project, and
        // an exit code from `npm test` in someone else's checkout becomes a
        // PASSED verification run on this change if nobody checks. Known and
        // elsewhere: drop it. Unknown: record that it ran and claim no outcome,
        // because the observation is cheap to keep and the claim is not.
        const cwd = decodeArg(call.args["Cwd"]);
        const known = cwd !== undefined;
        if (repoRoot !== undefined && known && !withinRepo(cwd, repoRoot, caseInsensitive)) continue;
        const scoped = repoRoot === undefined || known;

        // The journal holds the raw command; redaction happens when the receipt
        // is built (RFC 0001 section 10), which is why the journal must live
        // outside every repository.
        const argv = command.trim().split(/\s+/);
        const exitCode = ambiguous || !scoped ? undefined : outcomeOf(steps[i + 1]);
        entries.push({ at, kind: "command", argv,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}) });
      }
    }
  }

  return entries;
}
