/**
 * Antigravity, read from its transcript.
 *
 * The steps below are hand-written, and say so, because a fabricated log
 * presented as a captured one has already cost this project a day. Their shape
 * was taken from ten real transcripts on a machine running 2.11.0.0 -- the
 * field names, the double-encoded argument values, the exit code stated as
 * English prose in the following step, the background-task notice that replaces
 * it, and the older May-format result step that states no code at all.
 *
 * The parser was then run over those ten real files (2,116 steps, 226 tool
 * calls) and its counts compared against an independent count taken straight
 * from the raw JSON. They matched on every session, including the one written
 * in the older format, where it correctly recorded 28 edits and claimed zero
 * command outcomes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { antigravityEntries, decodeArg, outcomeOf, withinRepo } from "../src/antigravity.ts";
import { AGENTS, resolveAgent } from "../src/agents.ts";

/** Antigravity JSON-encodes every argument value inside the JSON step. */
const enc = (v: unknown): string => JSON.stringify(v);

const call = (name: string, args: Record<string, unknown>): Record<string, unknown> => ({
  type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE",
  created_at: "2026-08-30T18:09:02Z",
  tool_calls: [{ name, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, enc(v)])) }],
});

const result = (content: string): Record<string, unknown> => ({
  type: "GENERIC", source: "MODEL", status: "DONE",
  created_at: "2026-08-30T18:09:11Z", content,
});

const exited = (code: number): Record<string, unknown> =>
  result(`Created At: 2026-08-30T18:09:02-07:00\nCompleted At: 2026-08-30T18:09:11-07:00\n\n` +
         `The command exited with code ${code}.\nOutput:\nsome output we must never record\n`);

const ran = (cmd: string, cwd = "E:\\provene"): Record<string, unknown> =>
  call("run_command", { CommandLine: cmd, Cwd: cwd, WaitMsBeforeAsync: "5000" });

test("an argument value is JSON inside JSON, and a path survives both layers", () => {
  // The literal bytes in the file for TargetFile are "\"e:\\\\provene\\\\a.ts\"".
  assert.equal(decodeArg(enc("e:\\provene\\a.ts")), "e:\\provene\\a.ts");
  // A build that stopped double-encoding must not silently record nothing.
  assert.equal(decodeArg("e:\\provene\\a.ts"), "e:\\provene\\a.ts");
  // Parses, but is not a string. That is a shape we do not know; no guess.
  assert.equal(decodeArg("5000"), undefined);
  assert.equal(decodeArg("null"), undefined);
  assert.equal(decodeArg(42), undefined);
  assert.equal(decodeArg(""), undefined);
});

test("an outcome comes only from the sentence that states one", () => {
  assert.equal(outcomeOf(exited(0) as never), 0);
  assert.equal(outcomeOf(exited(1) as never), 1);
  assert.equal(outcomeOf(exited(-1) as never), -1);
  // No following step at all.
  assert.equal(outcomeOf(undefined), undefined);
  // The May format: a result step that states no exit code. Real, and the
  // reason this fails closed -- the format has already changed once.
  assert.equal(outcomeOf(result("Completed At: 2026-05-20T04:04:28Z") as never), undefined);
  // Output that merely mentions an exit code is not the transcript stating one.
  assert.equal(outcomeOf(result("Output:\nThe command exited with code 0. (from a log we cat'd)") as never),
               undefined);
});

test("a backgrounded command ran but did not finish, so it has no outcome", () => {
  const steps = [
    ran("npm test"),
    result("Created At: 2026-08-30T22:26:35-07:00\n" +
           "Tool is running as a background task with task id: s/task-168\n" +
           "Task Description: npm test\n"),
  ];
  const [cmd] = antigravityEntries(steps as never, { repoRoot: "E:/provene", caseInsensitive: true });
  assert.equal(cmd!.kind, "command");
  // Recorded as having run. NOT recorded as having passed: the exit code
  // arrives later in a task log this reader does not open.
  assert.equal(cmd!.exitCode, undefined);
});

test("two calls in one step share one result, so neither claims an outcome", () => {
  const step = {
    type: "PLANNER_RESPONSE", source: "MODEL", created_at: "2026-08-30T18:09:02Z",
    tool_calls: [
      { name: "run_command", args: { CommandLine: enc("npm test"), Cwd: enc("E:\\provene") } },
      { name: "run_command", args: { CommandLine: enc("npm run lint"), Cwd: enc("E:\\provene") } },
    ],
  };
  const entries = antigravityEntries([step, exited(0)] as never, { repoRoot: "E:/provene", caseInsensitive: true });
  assert.equal(entries.length, 2);
  // Nothing links a result to the call it describes. Attributing "exited 0" to
  // whichever came first would be a coin toss recorded as evidence.
  for (const e of entries) assert.equal(e.exitCode, undefined);
});

test("only the repository's own files are attributed to the change", () => {
  const steps = [
    call("replace_file_content", {
      TargetFile: "E:\\provene\\README.md",
      TargetContent: "secret prior text", ReplacementContent: "secret new text",
      Instruction: "the prompt in prose",
    }),
    // Antigravity writes its own notes with the same tool. Those are not part
    // of anyone's change, and without this filter they name files in a receipt
    // about a repository they are not in.
    call("write_to_file", {
      TargetFile: "C:\\Users\\dev\\.gemini\\antigravity\\brain\\s\\plan.md",
      CodeContent: "a whole file of content",
    }),
  ];
  const entries = antigravityEntries(steps as never, { repoRoot: "E:/provene", caseInsensitive: true });
  assert.deepEqual(entries.map((e) => [e.kind, e.path]), [["edit", "E:\\provene\\README.md"]]);
});

test("a drive letter's case does not decide whether a file is in your repository", () => {
  // The transcript writes `e:\provene`; git and the shell write `E:\provene`.
  assert.equal(withinRepo("e:\\provene\\a.ts", "E:/provene", true), true);
  assert.equal(withinRepo("E:\\provene\\a.ts", "E:/provene", true), true);
  assert.equal(withinRepo("e:\\provene-other\\a.ts", "E:/provene", true), false);
  assert.equal(withinRepo("e:\\provene", "E:/provene", true), true);
  // On a case-sensitive filesystem the two really are different directories.
  assert.equal(withinRepo("/repo/a.ts", "/Repo", false), false);
});

test("a command run somewhere else is not evidence about this repository", () => {
  const elsewhere = antigravityEntries([ran("npm test", "C:\\other"), exited(0)] as never,
    { repoRoot: "E:/provene", caseInsensitive: true });
  assert.deepEqual(elsewhere, []);

  // Cwd missing: it ran, but we cannot say it ran here, so no outcome is kept.
  const unknown = antigravityEntries(
    [call("run_command", { CommandLine: "npm test" }), exited(0)] as never,
    { repoRoot: "E:/provene", caseInsensitive: true });
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0]!.exitCode, undefined);
});

test("nothing from the prompt, the reasoning or the file content reaches the journal", () => {
  const steps = [
    { type: "USER_INPUT", source: "USER_EXPLICIT", created_at: "2026-08-30T18:00:00Z",
      content: "PROMPT: please refactor the billing module" },
    { type: "PLANNER_RESPONSE", source: "MODEL", created_at: "2026-08-30T18:00:01Z",
      thinking: "THINKING: the user probably means...",
      tool_calls: [{ name: "write_to_file", args: {
        TargetFile: enc("E:\\provene\\src\\a.ts"),
        CodeContent: enc("SOURCE: export const secret = 1;"),
        Description: enc("DESCRIPTION: writing the file"),
        toolSummary: enc("SUMMARY: write a.ts"),
      } }] },
    ran("npm test"),
    exited(0),
  ];
  const entries = antigravityEntries(steps as never, { repoRoot: "E:/provene", caseInsensitive: true });
  const serialized = JSON.stringify(entries);
  for (const forbidden of ["PROMPT:", "THINKING:", "SOURCE:", "DESCRIPTION:", "SUMMARY:",
                           "some output we must never record"]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} reached the journal`);
  }
  // What it does keep: the path, the command, the exit code. Nothing else.
  assert.deepEqual(entries.map((e) => e.kind), ["edit", "command"]);
  assert.equal(entries[0]!.path, "E:\\provene\\src\\a.ts");
  assert.deepEqual(entries[1]!.argv, ["npm", "test"]);
  assert.equal(entries[1]!.exitCode, 0);
});

test("a step this reader does not understand costs evidence and never invents any", () => {
  // Read-only tools, task bookkeeping, and web search are not changes.
  for (const name of ["view_file", "find_by_name", "list_dir", "grep_search", "search_web", "manage_task"]) {
    assert.deepEqual(antigravityEntries([call(name, { AbsolutePath: "E:\\provene\\a.ts" })] as never,
      { repoRoot: "E:/provene", caseInsensitive: true }), [], name);
  }
  // Malformed lines, missing args, and an empty transcript all yield nothing.
  assert.deepEqual(antigravityEntries([] as never), []);
  assert.deepEqual(antigravityEntries([{ type: "GENERIC" }, { tool_calls: "not an array" }] as never), []);
  assert.deepEqual(antigravityEntries([{ tool_calls: [{ args: {} }, null, 7] }] as never), []);
  assert.deepEqual(antigravityEntries([call("run_command", { Cwd: "E:\\provene" })] as never,
    { repoRoot: "E:/provene", caseInsensitive: true }), []);
});

test("the timestamp is the transcript's, so an imported session is not dated by its import", () => {
  const [e] = antigravityEntries([call("replace_file_content", { TargetFile: "E:\\provene\\a.ts" })] as never,
    { repoRoot: "E:/provene", caseInsensitive: true });
  assert.equal(e!.at, "2026-08-30T18:09:02.000Z");
});

test("Antigravity is offered as an agent but never as one that can be wired", () => {
  const agy = resolveAgent("antigravity")!;
  assert.equal(agy, AGENTS["antigravity"]);
  assert.equal(resolveAgent("agy"), agy);
  assert.equal(agy.wiring, "transcript");
  // No hooks and no settings file. `init` reads these to decide it must refuse:
  // installing a configuration that never fires is worse than installing none,
  // because the repository then believes it has coverage.
  assert.deepEqual(agy.hooks, []);
  assert.equal(agy.settingsPath, undefined);
  assert.equal(agy.parse, undefined);
  // The hook-wired agents still are.
  for (const id of ["claude-code", "gemini-cli"]) {
    assert.equal(AGENTS[id]!.wiring, "hooks");
    assert.ok(AGENTS[id]!.hooks.length > 0);
  }
});

/**
 * Who is allowed to state that a command succeeded.
 *
 * The pairing is positional, so whatever step follows a call is read for an
 * outcome. Two sources must never be read: the person typing, and the command's
 * own output. Otherwise a sentence in a chat message, or a line in a build log
 * someone `cat`s, becomes a signed assertion that the tests passed — which is
 * the single claim this format exists to make trustworthy.
 *
 * Raised in review. Across 602 tool-call/next-step pairs in ten real
 * transcripts a user step never once followed a tool call, so this is not an
 * observed attack; it is a cheap thing to forbid, which is a different and
 * better reason to forbid it.
 */
test("the developer does not get to state a command's exit status", () => {
  const typed = {
    type: "USER_INPUT", source: "USER_EXPLICIT", created_at: "2026-08-30T18:09:11Z",
    content: "The command exited with code 0.",
  };
  assert.equal(outcomeOf(typed as never), undefined);
  // Same text, from the model's result step, is the real thing.
  assert.equal(outcomeOf({ type: "GENERIC", source: "MODEL",
    content: "Created At: x\nThe command exited with code 0.\n" } as never), 0);

  const steps = [
    { type: "PLANNER_RESPONSE", source: "MODEL", created_at: "2026-08-30T18:09:02Z",
      tool_calls: [{ name: "run_command", args: {
        CommandLine: JSON.stringify("npm test"), Cwd: JSON.stringify("E:\\provene") } }] },
    typed,
  ];
  const [cmd] = antigravityEntries(steps as never, { repoRoot: "E:/provene", caseInsensitive: true });
  assert.equal(cmd!.exitCode, undefined, "a typed sentence became an exit code");
});

test("a command does not get to state its own exit status by printing one", () => {
  // `cat build.log` where the log contains the sentence. The header is the
  // transcript speaking; everything after `Output:` is the command speaking.
  const printed = {
    type: "GENERIC", source: "MODEL",
    content: "Created At: x\nCompleted At: y\n\nThe command exited with code 1.\n" +
             "Output:\nThe command exited with code 0.\n",
  };
  assert.equal(outcomeOf(printed as never), 1, "read the output instead of the header");

  const onlyInOutput = {
    type: "GENERIC", source: "MODEL",
    content: "Created At: x\nOutput:\nThe command exited with code 0.\n",
  };
  assert.equal(outcomeOf(onlyInOutput as never), undefined);
});

/**
 * The three ways an argument value can be read, pinned.
 *
 * Raised in review as a risk that valid commands are dropped or altered. The
 * behaviour is deliberate and each branch fails in the safe direction, but it
 * is a tradeoff rather than an obvious right answer, so it is pinned here where
 * changing it has to be a decision.
 *
 * The two failure cases the review describes both require Antigravity to STOP
 * double-encoding, which is a format change — and on a format change, dropping
 * evidence is the outcome this reader is built to have.
 */
test("decodeArg: decoded, dropped, or taken raw — and never invented", () => {
  // What every real transcript contains: a JSON string inside a JSON string.
  assert.equal(decodeArg(JSON.stringify("npm test")), "npm test");
  assert.equal(decodeArg(JSON.stringify("e:\\provene\\a.ts")), "e:\\provene\\a.ts");

  // Valid JSON that is not a string. A shape we do not recognise, so nothing is
  // returned: the command is recorded as absent rather than as a guess.
  assert.equal(decodeArg('{"foo":"bar"}'), undefined);
  assert.equal(decodeArg("[1,2]"), undefined);
  assert.equal(decodeArg("123"), undefined);
  assert.equal(decodeArg("null"), undefined);

  // Not JSON at all — which is what a single-encoded path or command looks
  // like. Taken as written, because a build that stopped double-encoding must
  // not silently record nothing.
  assert.equal(decodeArg("e:\\provene\\a.ts"), "e:\\provene\\a.ts");
  assert.equal(decodeArg("npm test"), "npm test");
  assert.equal(decodeArg("echo {not: json}"), "echo {not: json}");

  // Nothing here ever produces a value that was not present in the input.
  for (const raw of ['"npm test"', "{}", "0", "", "npm test"]) {
    const v = decodeArg(raw);
    if (v !== undefined) assert.ok(raw.includes(v) || v === JSON.parse(raw), raw);
  }
});
