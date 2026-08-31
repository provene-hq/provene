/**
 * Installing the hook.
 *
 * RFC 0001 section 13 and Threat Model T-4: hook WIRING goes in user-level
 * settings, outside the repository and so outside an agent's write scope. A
 * prompt-injected agent can edit anything in the working tree, including a
 * project-level hook configuration -- which would let it switch off its own
 * receipt emission.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const RECORD_COMMAND = "provene record --stdin";
export const EMIT_COMMAND = "provene emit --stdin";

export interface HookHandler { type: string; command: string; timeout?: number }
export interface MatcherGroup { matcher?: string; hooks: HookHandler[] }
export type Settings = Record<string, unknown> & { hooks?: Record<string, MatcherGroup[]> };

export function userSettingsPath(): string {
  return join(process.env["CLAUDE_HOME"] ?? join(homedir(), ".claude"), "settings.json");
}

export function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Settings;
  } catch (err) {
    throw new Error(`${path} is not valid JSON; refusing to overwrite it (${String(err)})`);
  }
}

/**
 * Adds our two hooks without disturbing anything already there.
 *
 * Idempotent: a group already carrying our command is left alone. We never
 * replace the hooks array, because someone else's tooling is probably in it.
 */
export function withProveneHooks(settings: Settings): { next: Settings; added: string[] } {
  const next: Settings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const hooks = next.hooks as Record<string, MatcherGroup[]>;
  const added: string[] = [];

  const install = (event: string, matcher: string, command: string, timeout: number): void => {
    const groups = Array.isArray(hooks[event]) ? [...hooks[event]!] : [];
    const present = groups.some((g) => g.hooks?.some((h) => h.command === command));
    if (present) return;
    groups.push({ matcher, hooks: [{ type: "command", command, timeout }] });
    hooks[event] = groups;
    added.push(`${event} → ${command}`);
  };

  // Append-only, no crypto, no git, no network. Kept fast because it fires on
  // every matching tool call.
  install("PostToolUse", "Edit|Write|MultiEdit|NotebookEdit|Bash", RECORD_COMMAND, 5);
  // Also on failure: the event name is how we learn a command's outcome without
  // parsing tool output, which is what lets a test command become verification
  // evidence rather than just a recorded invocation.
  install("PostToolUseFailure", "Bash", RECORD_COMMAND, 5);

  // SessionEnd, not Stop. A Stop hook can block with exit code 2 and force the
  // session to continue; SessionEnd structurally cannot. The emitter must never
  // be able to interrupt the developer's work.
  install("SessionEnd", "", EMIT_COMMAND, 30);

  return { next, added };
}

export function writeSettings(path: string, settings: Settings): string | undefined {
  mkdirSync(join(path, ".."), { recursive: true });
  let backup: string | undefined;
  if (existsSync(path)) {
    backup = `${path}.provene-backup`;
    copyFileSync(path, backup);
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return backup;
}

export function proveneHooksInstalled(settings: Settings): { record: boolean; emit: boolean } {
  const all = Object.values(settings.hooks ?? {}).flat();
  const commands = all.flatMap((g) => (g.hooks ?? []).map((h) => h.command));
  const events = Object.entries(settings.hooks ?? {})
    .filter(([, groups]) => groups.some((g) => (g.hooks ?? []).some((h) => h.command === RECORD_COMMAND)))
    .map(([e]) => e);
  return {
    record: commands.includes(RECORD_COMMAND) && events.includes("PostToolUseFailure"),
    emit: commands.includes(EMIT_COMMAND),
  };
}
