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
  /**
   * How this agent is observed.
   *
   * `hooks` is the real integration: the agent tells us what it did, as it does
   * it, through a contract it publishes. `transcript` is the fallback for an
   * agent that offers no such contract -- we read a log it writes for itself,
   * afterwards, and take what we can prove from it. The two are not
   * interchangeable and the receipts they produce are not equally good, which
   * is why the difference is a field rather than a branch somewhere private.
   */
  readonly wiring: "hooks" | "transcript";
  /** Where user-level hook configuration lives. Hook-wired agents only. */
  settingsPath?(): string;
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
  parse?(payload: HookPayload): JournalEntry[];
}

const CLAUDE: AgentAdapter = {
  id: "claude-code",
  vendor: "anthropic",
  label: "Claude Code",
  wiring: "hooks",
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
  wiring: "hooks",
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

/**
 * Antigravity, which cannot be wired at all.
 *
 * Five things were tried against 2.11.0.0 and all five came back negative: the
 * documented `hooks.json` is read but never fired; there is no CLI (`agy`,
 * `antigravity`, `antigravity-cli` are all absent, and the installation
 * contains five executables, none of them a command-line entry point);
 * `mcp_config.json` is zero bytes; the plugins are content packs, not lifecycle
 * hooks. What it does do is edit files in the real repository -- confirmed by
 * `git status` after a run -- so the changes are there to attest even though
 * nothing announces them.
 *
 * So this adapter has no hooks and no settings file, and `provene init` refuses
 * rather than writing a configuration that would sit there looking installed.
 * Sessions are imported afterwards from the transcript with `provene import`.
 */
const ANTIGRAVITY: AgentAdapter = {
  id: "antigravity",
  vendor: "google",
  label: "Antigravity",
  wiring: "transcript",
  timeoutUnit: "ms",
  stdoutMustBeSilent: false,
  hooks: [],
};

export const AGENTS: Readonly<Record<string, AgentAdapter>> = {
  "claude-code": CLAUDE, "gemini-cli": GEMINI, antigravity: ANTIGRAVITY,
};

/** Accepts the short names a person would actually type. */
const ALIASES: Readonly<Record<string, string>> = {
  claude: "claude-code", "claude-code": "claude-code",
  gemini: "gemini-cli", "gemini-cli": "gemini-cli",
  antigravity: "antigravity", agy: "antigravity",
};

export function resolveAgent(name: string | undefined): AgentAdapter | undefined {
  if (name === undefined || name === "") return AGENTS["claude-code"];
  const id = ALIASES[name.toLowerCase()];
  return id === undefined ? undefined : AGENTS[id];
}

export const agentNames = (): string[] => [...new Set(Object.values(ALIASES))];

/**
 * The agents `init` can actually wire.
 *
 * `init` used to advertise every agent Provene knows, which included one it
 * cannot install anything for. A list that offers a choice the next command
 * refuses is how a tool teaches people not to trust its output.
 */
export const hookAgents = (): string[] =>
  agentNames().filter((id) => AGENTS[id]?.wiring === "hooks");
