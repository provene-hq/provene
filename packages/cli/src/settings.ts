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
import type { AgentAdapter } from "./agents.ts";

export const RECORD_COMMAND = "provene record --stdin";
export const EMIT_COMMAND = "provene emit --stdin";

/**
 * The command a hook runs, for a given agent.
 *
 * `--agent` is written into the command rather than sniffed from the payload at
 * run time. Two agents both send `session_id` and `tool_name`, so a guess would
 * usually be right and occasionally, silently, wrong -- and a receipt that
 * names the wrong agent is worse than one that names none.
 *
 * `--quiet` where the agent parses our stdout: Gemini CLI reads a hook's stdout
 * as JSON and treats anything else as an error, so `emit` printing where it
 * wrote the receipt is a protocol violation there, not a courtesy.
 */
export function hookCommand(agent: AgentAdapter, kind: "record" | "emit"): string {
  const base = kind === "record" ? RECORD_COMMAND : EMIT_COMMAND;
  const parts = [base];
  if (agent.id !== "claude-code") parts.push(`--agent ${agent.id}`);
  if (agent.stdoutMustBeSilent) parts.push("--quiet");
  return parts.join(" ");
}

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
export function withProveneHooks(settings: Settings, agent: AgentAdapter): { next: Settings; added: string[] } {
  const next: Settings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const hooks = next.hooks as Record<string, MatcherGroup[]>;
  const added: string[] = [];

  for (const spec of agent.hooks) {
    const command = hookCommand(agent, spec.command);
    const groups = Array.isArray(hooks[spec.event]) ? [...hooks[spec.event]!] : [];
    // Idempotent, and append-only: someone else's tooling is probably in here.
    if (groups.some((g) => g.hooks?.some((h) => h.command === command))) continue;
    groups.push({
      ...(spec.matcher !== "" ? { matcher: spec.matcher } : { matcher: "" }),
      hooks: [{ type: "command", command, timeout: spec.timeout }],
    });
    hooks[spec.event] = groups;
    added.push(`${spec.event} → ${command}`);
  }

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

export function proveneHooksInstalled(settings: Settings, agent: AgentAdapter): { record: boolean; emit: boolean } {
  const installed = new Set<string>();
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const g of groups ?? []) {
      for (const h of g.hooks ?? []) installed.add(`${event}\u0000${h.command}`);
    }
  }
  const has = (spec: { event: string; command: "record" | "emit" }): boolean =>
    installed.has(`${spec.event}\u0000${hookCommand(agent, spec.command)}`);

  // Every hook the adapter declares must be present. On Claude Code that
  // includes PostToolUseFailure, which is the only source of a non-zero exit
  // code and therefore of a FAILED test; reporting "installed" without it would
  // mean receipts that can only ever say a test passed.
  return {
    record: agent.hooks.filter((h) => h.command === "record").every(has),
    emit: agent.hooks.filter((h) => h.command === "emit").every(has),
  };
}
