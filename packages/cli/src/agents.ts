/**
 * The agents Provene can wire itself into.
 *
 * The receipt format was never agent-specific; the wiring was. Every agent that
 * supports hooks does the same three things — tells you a file changed, tells
 * you a command ran, tells you the session ended — and disagrees about all the
 * details: what the events are called, where settings live, what the tools are
 * named, what units a timeout is in, and whether your hook is allowed to print.
 *
 * One table, so adding a third agent is data rather than a new code path, and
 * so the differences are visible side by side instead of buried in branches.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { JournalEntry } from "./journal.ts";
import { claudeEntries, geminiEntries, type HookPayload } from "./hookinput.ts";

export interface HookSpec {
  readonly event: string;
  readonly matcher: string;
  /** "record" appends to the journal; "emit" writes the receipt. */
  readonly command: "record" | "emit";
  readonly timeout: number;
}

export interface AgentAdapter {
  /** Recorded as `agent.tool` in the receipt. */
  readonly id: string;
  readonly vendor: string;
  readonly label: string;
  /** Where user-level hook configuration lives. */
  settingsPath(): string;
  readonly hooks: readonly HookSpec[];
  /**
   * Milliseconds or seconds? Claude Code reads a hook timeout as seconds and
   * Gemini CLI as milliseconds, so the same number means two very different
   * things. Reusing Claude's `5` in a Gemini config would give every hook five
   * milliseconds to run and then kill it.
   */
  readonly timeoutUnit: "s" | "ms";
  /**
   * Whether a hook may print to stdout.
   *
   * Gemini CLI parses a hook's stdout as JSON and documents that anything else
   * is an error ("Silence is Mandatory"). `provene emit` normally prints where
   * it wrote the receipt, which on that agent is not a nice message but a
   * protocol violation.
   */
  readonly stdoutMustBeSilent: boolean;
  parse(payload: HookPayload): JournalEntry[];
}

const CLAUDE: AgentAdapter = {
  id: "claude-code",
  vendor: "anthropic",
  label: "Claude Code",
  settingsPath: () => join(process.env["CLAUDE_HOME"] ?? join(homedir(), ".claude"), "settings.json"),
  timeoutUnit: "s",
  stdoutMustBeSilent: false,
  hooks: [
    { event: "PostToolUse", matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash", command: "record", timeout: 5 },
    // The failure event is how a command's outcome is learned without parsing
    // tool output, which is what lets a test become verification evidence.
    { event: "PostToolUseFailure", matcher: "Bash", command: "record", timeout: 5 },
    // SessionEnd, not Stop: a Stop hook can block and force a session to
    // continue, and the emitter must never be able to interrupt the developer.
    { event: "SessionEnd", matcher: "", command: "emit", timeout: 30 },
  ],
  parse: claudeEntries,
};

const GEMINI: AgentAdapter = {
  id: "gemini-cli",
  vendor: "google",
  label: "Gemini CLI",
  settingsPath: () => join(process.env["GEMINI_HOME"] ?? join(homedir(), ".gemini"), "settings.json"),
  timeoutUnit: "ms",
  stdoutMustBeSilent: true,
  hooks: [
    // Gemini has no AfterToolFailure. One event covers both outcomes and the
    // failure is in the payload -- see geminiEntries for why reading it here is
    // sound where reading Claude's tool_response was not.
    { event: "AfterTool", matcher: "write_file|replace|run_shell_command", command: "record", timeout: 5000 },
    { event: "SessionEnd", matcher: "", command: "emit", timeout: 30000 },
  ],
  parse: geminiEntries,
};

export const AGENTS: Readonly<Record<string, AgentAdapter>> = { "claude-code": CLAUDE, "gemini-cli": GEMINI };

/** Accepts the short names a person would actually type. */
const ALIASES: Readonly<Record<string, string>> = {
  claude: "claude-code", "claude-code": "claude-code",
  gemini: "gemini-cli", "gemini-cli": "gemini-cli",
};

export function resolveAgent(name: string | undefined): AgentAdapter | undefined {
  if (name === undefined || name === "") return AGENTS["claude-code"];
  const id = ALIASES[name.toLowerCase()];
  return id === undefined ? undefined : AGENTS[id];
}

export const agentNames = (): string[] => [...new Set(Object.values(ALIASES))];
