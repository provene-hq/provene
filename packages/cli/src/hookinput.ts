/**
 * Agent hook payloads.
 *
 * Hooks receive JSON on stdin. We read only the fields we need and ignore the
 * rest: the payload shape is owned by a tool that ships breaking changes often,
 * so the adapter is deliberately thin and tolerant.
 *
 * https://code.claude.com/docs/en/hooks
 */
import { readFileSync } from "node:fs";
import type { JournalEntry } from "./journal.ts";

export interface HookPayload {
  readonly session_id?: string;
  readonly cwd?: string;
  readonly hook_event_name?: string;
  readonly tool_name?: string;
  readonly tool_input?: Record<string, unknown>;
  readonly tool_response?: unknown;
  readonly exit_reason?: string;
}

/** Both agents put the session id in the same place, which is luck, not design. */
export const sessionIdOf = (p: HookPayload): string | undefined =>
  typeof p.session_id === "string" && p.session_id !== "" ? p.session_id : undefined;

/** Tools whose use means the agent produced file content. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Update"]);

export function readStdin(): string {
  try {
    // fd 0, synchronously: a hook is a short-lived process and must not await.
    // `require` does not exist in ESM, so this is a real import.
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function parsePayload(raw: string): HookPayload | undefined {
  if (raw.trim() === "") return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === "object" && v !== null ? (v as HookPayload) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Maps one hook payload to journal entries.
 *
 * Returns an empty array rather than throwing on anything unexpected. A hook
 * that fails loudly costs the developer their session; a hook that records
 * nothing costs one receipt, and the absence is detectable.
 */
export function claudeEntries(p: HookPayload): JournalEntry[] {
  const at = new Date().toISOString();
  const tool = p.tool_name ?? "";
  const input = p.tool_input ?? {};
  // Both agents send it, and it is what scopes a session's evidence to a
  // repository. See JournalEntry.cwd.
  const where = typeof p.cwd === "string" && p.cwd !== "" ? { cwd: p.cwd } : {};

  if (EDIT_TOOLS.has(tool)) {
    const path = typeof input["file_path"] === "string" ? input["file_path"]
               : typeof input["notebook_path"] === "string" ? input["notebook_path"]
               : undefined;
    return path === undefined ? [] : [{ at, kind: "edit", path, ...where }];
  }

  if (tool === "Bash") {
    const command = input["command"];
    if (typeof command !== "string" || command.trim() === "") return [];
    // The event name carries the outcome, so we never parse tool output to find
    // it: PostToolUse fires on success, PostToolUseFailure on failure. That is a
    // documented contract, unlike the shape of tool_response.
    const failed = p.hook_event_name === "PostToolUseFailure";
    // The event name is the contract, but if the payload visibly contradicts it
    // we record no outcome at all rather than assert a passing test. When two
    // signals disagree the honest answer is silence, not the more convenient
    // of the two.
    const response = typeof p.tool_response === "string" ? p.tool_response : "";
    const contradicted = !failed && /\bexit(?: code)? [1-9]\d*\b|\berror\b/i.test(response);
    if (contradicted) return [{ at, kind: "command", argv: command.split(/\s+/), ...where }];
    // The journal holds the raw command; it lives outside the repository and is
    // never committed. Redaction happens when the receipt is built (RFC 0001 10).
    return [{ at, kind: "command", argv: command.split(/\s+/), exitCode: failed ? 1 : 0, ...where }];
  }

  return [];
}

/**
 * Gemini CLI hook payloads.
 *
 * https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md
 *
 * Three differences from Claude Code, each of which would have been a silent
 * bug if the shapes had been assumed to match.
 *
 * **There is no failure event.** Claude Code fires `PostToolUseFailure`, and
 * this project's rule since round 5 has been to take a command's outcome from
 * the event name and never from parsing tool output. Gemini has only
 * `AfterTool`, so that rule cannot apply — but the reason behind it does not
 * either. The rule existed because Claude's `tool_response` is an undocumented
 * shape that changes; Gemini's reference specifies `tool_response` as
 * `{ llmContent, returnDisplay, error? }` and calls it part of a stable API.
 * Reading a documented field is not the same act as sniffing an undocumented
 * one, and the difference is worth stating rather than quietly doing both.
 *
 * **The tools have different names and different arguments.** `write_file` and
 * `replace` both take `file_path`; `run_shell_command` takes `command`.
 *
 * **A hook may not print.** Enforced by the caller, not here.
 */
const GEMINI_EDIT_TOOLS = new Set(["write_file", "replace"]);

export function geminiEntries(p: HookPayload): JournalEntry[] {
  const at = new Date().toISOString();
  const tool = p.tool_name ?? "";
  const input = p.tool_input ?? {};
  const where = typeof p.cwd === "string" && p.cwd !== "" ? { cwd: p.cwd } : {};

  if (GEMINI_EDIT_TOOLS.has(tool)) {
    const path = input["file_path"];
    return typeof path === "string" && path !== "" ? [{ at, kind: "edit", path, ...where }] : [];
  }

  if (tool === "run_shell_command") {
    const command = input["command"];
    if (typeof command !== "string" || command.trim() === "") return [];

    // A background command has not finished, so its absent error means nothing
    // yet. Recording it as a pass would turn "we did not wait" into "it worked".
    if (input["is_background"] === true) {
      return [{ at, kind: "command", argv: command.trim().split(/\s+/), ...where }];
    }

    const response = p.tool_response;
    if (typeof response !== "object" || response === null) {
      // The documented field is missing, so the documented reading does not
      // apply. Record that the command ran and claim nothing about its outcome.
      return [{ at, kind: "command", argv: command.trim().split(/\s+/), ...where }];
    }
    const error = (response as Record<string, unknown>)["error"];
    const failed = error !== undefined && error !== null && error !== "";
    return [{ at, kind: "command", argv: command.trim().split(/\s+/), exitCode: failed ? 1 : 0, ...where }];
  }

  return [];
}
