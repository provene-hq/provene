/**
 * Claude Code hook payloads.
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
export function toJournalEntries(p: HookPayload): JournalEntry[] {
  const at = new Date().toISOString();
  const tool = p.tool_name ?? "";
  const input = p.tool_input ?? {};

  if (EDIT_TOOLS.has(tool)) {
    const path = typeof input["file_path"] === "string" ? input["file_path"]
               : typeof input["notebook_path"] === "string" ? input["notebook_path"]
               : undefined;
    return path === undefined ? [] : [{ at, kind: "edit", path }];
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
    if (contradicted) return [{ at, kind: "command", argv: command.split(/\s+/) }];
    // The journal holds the raw command; it lives outside the repository and is
    // never committed. Redaction happens when the receipt is built (RFC 0001 10).
    return [{ at, kind: "command", argv: command.split(/\s+/), exitCode: failed ? 1 : 0 }];
  }

  return [];
}
