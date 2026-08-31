/**
 * Hook protocol dispatch.
 *
 * The adapter sits on a contract owned by a tool that ships breaking changes
 * monthly, and it is the one place where a wrong assumption is silent: a
 * mishandled payload produces no journal entry, and a missing journal entry
 * looks exactly like a session where nothing happened.
 *
 * Every event the CLI can receive is exercised here, including the ones it must
 * deliberately ignore.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePayload, toJournalEntries, type HookPayload } from "../src/hookinput.ts";
import { withProveneHooks, proveneHooksInstalled, RECORD_COMMAND, EMIT_COMMAND } from "../src/settings.ts";

const ev = (name: string, tool?: string, input?: Record<string, unknown>, extra: Record<string, unknown> = {}): HookPayload =>
  ({ session_id: "s", cwd: "/tmp/x", hook_event_name: name,
     ...(tool !== undefined ? { tool_name: tool } : {}),
     ...(input !== undefined ? { tool_input: input } : {}), ...extra });

test("edit tools yield exactly one edit entry, whichever path field they use", () => {
  for (const [tool, input, expected] of [
    ["Edit", { file_path: "a.ts" }, "a.ts"],
    ["Write", { file_path: "b.ts" }, "b.ts"],
    ["MultiEdit", { file_path: "c.ts" }, "c.ts"],
    ["NotebookEdit", { notebook_path: "d.ipynb" }, "d.ipynb"],
  ] as const) {
    const entries = toJournalEntries(ev("PostToolUse", tool, input as Record<string, unknown>));
    assert.equal(entries.length, 1, tool);
    assert.equal(entries[0]!.kind, "edit");
    assert.equal(entries[0]!.path, expected);
  }
});

test("PostToolUse means the command succeeded; PostToolUseFailure means it failed", () => {
  const ok = toJournalEntries(ev("PostToolUse", "Bash", { command: "npm test" }));
  assert.equal(ok[0]!.exitCode, 0);
  const bad = toJournalEntries(ev("PostToolUseFailure", "Bash", { command: "npm test" }));
  assert.notEqual(bad[0]!.exitCode, 0);
});

test("a payload contradicting its own event records no outcome at all", () => {
  // Success event, failure-shaped response. Recording PASSED here would put a
  // false green in a receipt; recording nothing loses only a data point.
  for (const response of ["exit code 1", "exit 2: boom", "Error: connection refused"]) {
    const e = toJournalEntries(ev("PostToolUse", "Bash", { command: "npm test" }, { tool_response: response }));
    assert.equal(e.length, 1);
    assert.equal(e[0]!.exitCode, undefined, `contradicted by: ${response}`);
  }
  // ...but an ordinary successful response still counts as success.
  const clean = toJournalEntries(ev("PostToolUse", "Bash", { command: "npm test" }, { tool_response: "47 passing" }));
  assert.equal(clean[0]!.exitCode, 0);
});

test("tools and events we do not model are ignored, never guessed at", () => {
  for (const p of [
    ev("PostToolUse", "Read", { file_path: "x.ts" }),
    ev("PostToolUse", "Grep", { pattern: "x" }),
    ev("SessionStart"),
    ev("UserPromptSubmit"),
    ev("Notification"),
    ev("PreCompact"),
    ev("PostToolUse", "Bash", { command: "   " }),
    ev("PostToolUse", "Bash", {}),
    ev("PostToolUse", "Edit", {}),
  ]) {
    assert.deepEqual(toJournalEntries(p), [], `${p.hook_event_name} ${p.tool_name ?? ""}`);
  }
});

test("malformed stdin never throws", () => {
  for (const raw of ["", "   ", "not json", "[]", "null", '{"session_id":', "0"]) {
    assert.doesNotThrow(() => {
      const p = parsePayload(raw);
      if (p !== undefined) toJournalEntries(p);
    }, `input: ${raw}`);
  }
});

test("installation registers both the success and failure channels", () => {
  // Deriving a command's outcome from the event name only works if we are
  // subscribed to both. Subscribing to one would silently record every failing
  // test run as a success, or drop it entirely.
  const { next } = withProveneHooks({});
  const events = Object.keys(next.hooks ?? {});
  assert.ok(events.includes("PostToolUse"), "success channel");
  assert.ok(events.includes("PostToolUseFailure"), "failure channel");
  assert.ok(events.includes("SessionEnd"), "emit channel");
  assert.ok(!events.includes("Stop"), "Stop can block a session and must not be used");

  const installed = proveneHooksInstalled(next);
  assert.equal(installed.record, true);
  assert.equal(installed.emit, true);
});

test("installing is idempotent and never disturbs existing hooks", () => {
  const existing = { model: "opus", hooks: {
    PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "someone-elses-linter" }] }],
  } };
  const first = withProveneHooks(existing);
  const second = withProveneHooks(first.next);
  assert.equal(second.added.length, 0, "second run must be a no-op");
  const commands = Object.values(second.next.hooks ?? {}).flat()
    .flatMap((g) => (g.hooks ?? []).map((h) => h.command));
  assert.ok(commands.includes("someone-elses-linter"), "existing hook survived");
  assert.ok(commands.includes(RECORD_COMMAND) && commands.includes(EMIT_COMMAND));
  assert.equal((second.next as Record<string, unknown>)["model"], "opus", "unrelated keys survived");
});
