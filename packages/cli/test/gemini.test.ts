/**
 * Gemini CLI.
 *
 * Every payload below is shaped from Google's published hook reference, not
 * from what a Claude Code payload happens to look like:
 * https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md
 *
 * Three of its rules differ from Claude Code's in ways that are silent when
 * assumed rather than read, and each has a test here:
 *
 *   - there is no failure event, so an outcome comes from `tool_response.error`
 *   - a hook's stdout is parsed as JSON, so `emit` may not print
 *   - a hook timeout is in milliseconds, so Claude's `5` would be 5ms
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { geminiEntries, claudeEntries, type HookPayload } from "../src/hookinput.ts";
import { AGENTS, resolveAgent } from "../src/agents.ts";
import { withProveneHooks, proveneHooksInstalled, hookCommand } from "../src/settings.ts";

const GEMINI = AGENTS["gemini-cli"]!;
const CLAUDE = AGENTS["claude-code"]!;

const afterTool = (tool: string, input: Record<string, unknown>, response?: unknown): HookPayload => ({
  session_id: "g-1", cwd: "/repo", hook_event_name: "AfterTool",
  tool_name: tool, tool_input: input,
  ...(response !== undefined ? { tool_response: response } : {}),
});

test("Gemini's file tools are recognised by their real names and arguments", () => {
  // write_file(file_path, content) and replace(file_path, old_string, new_string).
  for (const tool of ["write_file", "replace"]) {
    const e = geminiEntries(afterTool(tool, { file_path: "src/a.ts", content: "x" }));
    assert.deepEqual(e.map((x) => [x.kind, x.path]), [["edit", "src/a.ts"]], tool);
  }
  // read_file changes nothing, so it is not an edit.
  assert.deepEqual(geminiEntries(afterTool("read_file", { file_path: "src/a.ts" })), []);
  // Claude's names are not Gemini's, and must not be silently accepted here.
  for (const tool of ["Write", "Edit", "Bash"]) {
    assert.deepEqual(geminiEntries(afterTool(tool, { file_path: "src/a.ts", command: "npm test" })), [], tool);
  }
});

test("an outcome comes from tool_response.error, because Gemini has no failure event", () => {
  // Claude Code fires PostToolUseFailure and this project's rule is to take the
  // outcome from the event name, never from parsing tool output. Gemini has one
  // event, and specifies tool_response as {llmContent, returnDisplay, error?}
  // in a stable API. Reading a documented field is a different act from
  // sniffing an undocumented one.
  const ok = geminiEntries(afterTool("run_shell_command", { command: "npm test" },
    { llmContent: "47 passing", returnDisplay: "ok" }));
  assert.equal(ok[0]!.exitCode, 0);

  for (const error of [{ message: "exit 1" }, "boom", 1]) {
    const bad = geminiEntries(afterTool("run_shell_command", { command: "npm test" },
      { llmContent: "", returnDisplay: "", error }));
    assert.equal(bad[0]!.exitCode, 1, `error: ${JSON.stringify(error)}`);
  }
});

test("no outcome is claimed where the documented field is absent", () => {
  // The reading depends on the contract being honoured. Where it is not, the
  // command is recorded and nothing is asserted about whether it worked --
  // which yields no verification run rather than a false pass.
  for (const response of [undefined, "a string", null, 42]) {
    const e = geminiEntries(afterTool("run_shell_command", { command: "npm test" }, response));
    assert.equal(e.length, 1);
    assert.equal("exitCode" in e[0]!, false, `response: ${JSON.stringify(response)}`);
  }
});

test("a background command is recorded without an outcome", () => {
  // is_background means the process was detached, so an absent error means the
  // CLI did not wait -- not that the command succeeded.
  const e = geminiEntries(afterTool("run_shell_command",
    { command: "npm run dev", is_background: true }, { llmContent: "started" }));
  assert.equal(e.length, 1);
  assert.equal("exitCode" in e[0]!, false);
});

test("the hooks are written in Gemini's schema, with Gemini's units", () => {
  const { next } = withProveneHooks({}, GEMINI);
  const hooks = next.hooks!;
  assert.deepEqual(Object.keys(hooks).sort(), ["AfterTool", "SessionEnd"]);
  assert.equal(hooks["AfterTool"]![0]!.matcher, "write_file|replace|run_shell_command");

  // Milliseconds, not seconds. Claude Code reads this field as seconds and
  // Gemini as milliseconds, so reusing Claude's 5 would give every hook five
  // milliseconds before it was killed.
  assert.equal(hooks["AfterTool"]![0]!.hooks[0]!.timeout, 5000);
  assert.equal(hooks["SessionEnd"]![0]!.hooks[0]!.timeout, 30000);
  assert.equal(CLAUDE.hooks[0]!.timeout, 5);
  assert.notEqual(GEMINI.timeoutUnit, CLAUDE.timeoutUnit);

  assert.equal(proveneHooksInstalled(next, GEMINI).record, true);
  assert.equal(proveneHooksInstalled(next, GEMINI).emit, true);
  // A Gemini config does not satisfy Claude's requirements, and vice versa.
  assert.equal(proveneHooksInstalled(next, CLAUDE).record, false);
});

test("the hook command carries --quiet where the agent parses our stdout", () => {
  // "Silence is Mandatory": Gemini parses a hook's stdout as JSON and treats
  // anything else as an error, so `emit` announcing where it wrote the receipt
  // is a protocol violation there rather than a courtesy.
  assert.match(hookCommand(GEMINI, "emit"), /--quiet/);
  assert.match(hookCommand(GEMINI, "record"), /--agent gemini-cli/);
  assert.doesNotMatch(hookCommand(CLAUDE, "emit"), /--quiet/);
  assert.doesNotMatch(hookCommand(CLAUDE, "emit"), /--agent/);
  assert.equal(GEMINI.stdoutMustBeSilent, true);
});

test("the agent is named explicitly and never inferred from the payload", () => {
  // The two payloads are indistinguishable by shape: both carry session_id,
  // cwd, hook_event_name, tool_name and tool_input. A guess would be right
  // most of the time, and a receipt naming the wrong agent is worse than one
  // naming none.
  const ambiguous = afterTool("run_shell_command", { command: "npm test" });
  assert.notDeepEqual(geminiEntries(ambiguous), claudeEntries(ambiguous));

  assert.equal(resolveAgent("gemini")!.id, "gemini-cli");
  assert.equal(resolveAgent("gemini-cli")!.id, "gemini-cli");
  assert.equal(resolveAgent("claude")!.id, "claude-code");
  assert.equal(resolveAgent(undefined)!.id, "claude-code");
  assert.equal(resolveAgent("cursor"), undefined, "an agent we have not built must not resolve");
  assert.equal(resolveAgent("gpt"), undefined);
});

test("each agent's settings live where that agent looks for them", () => {
  assert.match(GEMINI.settingsPath(), /[/\\]\.gemini[/\\]settings\.json$/);
  assert.match(CLAUDE.settingsPath(), /[/\\]\.claude[/\\]settings\.json$/);
});
