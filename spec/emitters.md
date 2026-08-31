# Writing an emitter

*How to make any coding agent produce Provene receipts. No fork, no schema change, no code in this repository.*

The receipt format has never been specific to one agent. `agent.vendor`, `agent.tool`, `agent.toolVersion` and `agent.model` are in [RFC 0001 §6.1](rfc/0001-receipt-schema.md) and have been since v0.1. What *was* specific was the wiring: Claude Code exposes lifecycle hooks, so `provene init` could install them in one command, and nothing else could.

This document is the contract for everything else.

## What an emitter has to do

Two things, and nothing more.

**1. Report events as they happen.** Every time the agent edits a file or runs a command, append to the session journal:

```sh
provene record --session <id> --kind edit    --path src/auth.ts --cwd /repo
provene record --session <id> --kind command --argv "npm test" --exit 0 --duration-ms 4200 --cwd /repo
```

`--session` is any stable string for the life of one agent session. It must not contain a path separator; anything unusual is replaced with a hash of itself rather than rejected, so a strange id costs you nothing.

`record` never fails. It exits 0 whatever happens, because an emitter that can break the agent it observes will be uninstalled within a day.

**Pass `--cwd`.** A journal belongs to a session, not to a repository, and a session is free to work in more than one. Without it, a test suite that passed in one project can turn up as verification evidence for a change in another, and `src/a.ts` in two checkouts is the same six characters and a different file. `emit` drops anything whose recorded directory is outside the repository it is emitting for. It is optional and treated as unknown-not-guilty when absent, so an emitter that omits it still works exactly as before — but "still works" here means "still over-claims".

**2. Emit once, at the end.**

```sh
provene emit --session <id> --base <commit-before-the-session> \
  --tool gemini-cli --vendor google --tool-version 1.2.0
```

That writes `.provene/<digest>.statement.json` into the working tree. Commit it with the change it describes.

That is the whole interface.

## The fields that matter, and the rule about guessing

| Flag | Goes to | Say it when |
|---|---|---|
| `--tool` | `agent.tool` | Always. The client that ran the session: `gemini-cli`, `cursor`, `codex`, `aider` |
| `--vendor` | `agent.vendor` | You know it: `google`, `openai`, `anthropic` |
| `--tool-version` | `agent.toolVersion` | You can read your own version |
| `--model` | `agent.model` | The runtime told you, or your config names it |
| `--model-source` | `agent.modelSource` | `reported` if the runtime told you, `configured` if you read it from settings |
| `--cwd` | scoping, not a receipt field | Always, on every `record`. See above |

**Do not guess the model.** `modelSource` exists so a reader can tell how the identifier was obtained, and an emitter that infers one from a version string or a default has made the field worthless for everybody. Recording no model is a correct receipt. Claude Code's own hook payload carries no model, so this is the normal case rather than the exception.

The same rule covers everything else here: **record what you observed, omit what you did not.** An absent field means UNOBSERVED, never "no". A receipt that quietly fills gaps is worse than one with holes in it, because the holes are honest.

## Verification evidence

A command's **exit code** is what turns an observation into evidence. Without `--exit`, a receipt records that `npm test` ran and says nothing about whether it worked, and no verification run appears.

Whether a run counts is decided by the command's *shape*, matched whole against a fixed allowlist (`npm test`, `pytest`, `go test ./...`, and a few dozen more in `redact.ts`). `npm test` is recognised; `npm test -- --watch` is not. That is a deliberate floor, not a parser: a tool that guesses which commands are tests will eventually record a deploy as one.

Everything an emitter reports is `observedBy: local`, which **satisfies no policy on its own**. It is a self-attestation by the party who wants the change merged. CI re-observing the run is what makes it evidence (RFC 0001 §7).

## What is never recorded

Do not pass these, and do not add them:

- prompt or task plaintext
- full argument vectors — `--argv` is redacted to a command name plus a keyed digest
- raw stdout or stderr
- environment variable values
- file contents

The journal holds unredacted commands and **must live outside every repository**, which is why `emit` refuses when `PROVENE_HOME` is inside one. Redaction happens when the receipt is built, not when the journal is written, so the hook can stay fast and dumb.

## Four shapes of integration

**An agent with a hook system.** Wire two hooks: one on tool completion calling `provene record`, one on session end calling `provene emit`. This is what Claude Code does, and `provene init` writes it for you. Nothing about it is Claude-specific except the payload shape that `record --stdin` parses.

**An editor extension.** Subscribe to file-save and terminal-exit events, shell out to `provene record`. Emit when the window closes or the agent session ends.

**A wrapper.** If the agent has no hooks but runs commands through a shell you control, wrap that shell.

**A transcript.** If the agent tells you nothing while it works but writes a log for itself afterwards, read the log. This is the last resort and it is a genuinely weaker integration, not merely a less convenient one — see [Reading a transcript](#reading-a-transcript) below. Antigravity is the worked example.

**A browser chat you copy and paste from.** Not addressable, and an explicit non-goal. Nothing can distinguish typing from pasting without observing the client, and Provene does not claim to.

## Proving your emitter works

```sh
provene verify .provene/<digest>.statement.json
python3 spec/conformance/runner/validate_receipts.py .provene
```

The first checks integrity and reports the tier. The second checks your output against the JSON Schema, which is the thing to run in your own CI — a receipt this repository's schema rejects is a bug in your emitter, and it will be found by a stranger's verifier if you do not find it first.

`packages/cli/test/emitters.test.ts` drives this whole interface as a third-party emitter would, using nothing an agent other than Claude Code lacks. It is the executable version of this page.

## Which agents are wired automatically

```sh
provene init                    # Claude Code
provene init --agent gemini     # Gemini CLI
```

**Claude Code** and **Gemini CLI** both have their hooks written for them. **Antigravity** cannot be wired at all and is imported afterwards instead; `provene init --agent antigravity` refuses and says so. Everything else uses the flag interface above.

The two are worth comparing, because the differences are where an integration built by assumption goes wrong. All three of these are silent failures if the shapes are assumed to match:

| | Claude Code | Gemini CLI | Antigravity |
|---|---|---|---|
| how it is observed | hooks | hooks | transcript, afterwards |
| settings | `~/.claude/settings.json` | `~/.gemini/settings.json` | none — `init` refuses |
| tool events | `PostToolUse` **and** `PostToolUseFailure` | `AfterTool` only | none fire |
| how an outcome is known | which event fired | `tool_response.error` | prose in the next step |
| edit tools | `Write`, `Edit`, `MultiEdit` | `write_file`, `replace` | `replace_file_content`, `write_to_file` |
| shell tool | `Bash` | `run_shell_command` | `run_command` |
| hook timeout unit | seconds | **milliseconds** | n/a |
| may a hook print? | yes | **no** — stdout is parsed as JSON | n/a |
| when the receipt is written | session end, automatically | session end, automatically | **by hand** |

The timeout one is the quietest: reusing Claude's `5` in a Gemini config gives every hook five *milliseconds* before it is killed.

**On reading tool output.** This project's rule since round 5 has been to take a command's outcome from the event name and never from parsing tool output, because Claude's `tool_response` is an undocumented shape that changes. Gemini has no failure event, so that rule cannot apply — but neither does the reason for it. Gemini's reference *specifies* `tool_response` as `{ llmContent, returnDisplay, error? }` and calls it a stable API. Reading a documented field is a different act from sniffing an undocumented one. Where the documented field is absent, no outcome is claimed at all rather than a pass being assumed.

**On naming the agent.** `--agent` is written into the hook command by `init`, never inferred at run time. Both agents send `session_id`, `cwd`, `hook_event_name`, `tool_name` and `tool_input`, so the payloads are not distinguishable by shape. A guess would be right most of the time, and a receipt naming the wrong agent is worse than one naming none.

## Reading a transcript

Some agents cannot be wired. Google Antigravity is the case this section was written from, and the shape of the problem generalises.

### What was actually tried

Five experiments against Antigravity 2.11.0.0, run on a machine with it installed. Every one came back negative except the last:

| | Result |
|---|---|
| Does the documented `.agents/hooks.json` fire? | No. The file is found and read; no hook ever runs. |
| Is there a CLI? | No. `agy`, `antigravity`, `antigravity-cli` are all absent, and the installation directory contains five executables, none of them a command-line entry point. |
| Is there an MCP surface? | No. `mcp_config.json` is zero bytes; the plugins are content packs, not lifecycle hooks. |
| Does it edit real repository files? | **Yes.** `git status` after a session shows the modified files, made with `replace_file_content`. |

So there is a change worth attesting and nothing that announces it. What there is instead is a log the agent writes for its own replay:

```
~/.gemini/antigravity/brain/<session>/.system_generated/logs/transcript.jsonl
```

```sh
provene import --agent antigravity                       # list the sessions it can see
provene import --agent antigravity --session <id>        # read one into the journal
provene emit   --session <id> --tool antigravity --vendor google
```

`import` writes only to the journal and stops. Emitting stays a separate command so that a transcript can never take a shortcut past redaction: whatever is imported goes through exactly the same `emit` every other agent uses.

### Why a transcript is a weaker integration

A hook is a contract. The agent tells you what it did, while it does it, through an interface it published and will not break casually. A transcript is none of those things, and an emitter built on one has to be written as though the ground will move — because it already has. Of ten real transcripts on one developer's machine, the oldest used a different step type for command results than the newest, three months apart.

Four rules follow, and all four cost evidence rather than manufacture it:

**The outcome comes from one sentence, or not at all.** An exit status appears as `The command exited with code 0.` in the step *after* the call, in English, with nothing linking the two but their order in the file. Where that sentence is absent — an older format, a newer one, a backgrounded command whose result arrives somewhere else — no outcome is recorded. A command with no exit code becomes no verification run, which is the true claim.

**Ambiguity is not resolved, it is dropped.** A step can hold two tool calls and be followed by one result. Which result belongs to which is not recoverable from the file, so neither call gets an outcome.

**Only this repository's files count.** Antigravity writes its own notes with the same `write_to_file` it uses on your code, and an Antigravity session is not scoped to one project. Paths outside the repository root are discarded, and a command whose working directory is elsewhere is discarded with them. A command whose working directory is unknown is recorded as having run, with no outcome — the observation is cheap to keep and the claim is not.

**Emission is manual, so the receipt says how much of the change it accounts for.** A hook closes a session at the moment it ends. Nobody closes an Antigravity session, so the working tree at import time may hold a great deal the agent never touched. `emit` reports how many of the changed paths the journal actually attributes to the session, so over-claiming is visible at the point it happens rather than in review.

### The redaction hazard

A transcript is not a hook payload. It contains the developer's prompts in plaintext, the model's private reasoning, the full text of every file written, and the complete stdout of every command — all of which [RFC 0001 §10](rfc/0001-receipt-schema.md) forbids recording, and the journal it feeds is unredacted by design. A careless reader here writes prompts and source code to disk outside the repository.

The reader is therefore an allowlist of four fields and nothing else:

| Tool | Read |
|---|---|
| `run_command` | `args.CommandLine`, `args.Cwd` |
| `replace_file_content` | `args.TargetFile` |
| `write_to_file` | `args.TargetFile` |

`content`, `thinking`, `CodeContent`, `ReplacementContent`, `TargetContent`, `Instruction`, `Description`, `toolSummary` and every result body are never copied. The single thing read from a result is one integer matched by a regular expression. If you write a transcript emitter for another agent, start from an allowlist too — a denylist over a log format you do not own will leak the first time the log gains a field.

One more trap, which is specific but likely to recur: every argument *value* in an Antigravity transcript is itself a JSON document. `"CommandLine": "\"npm test\""`. Parse twice.

## Agents not yet wired

Cursor and Codex have no adapter. If you use one, the most useful contribution is not the adapter — it is the five experiments above, run against your agent and written down. Which lifecycle events exist, whether they fire, what the payload names its fields, and whether the outcome of a command is recoverable without parsing output. None of it is answerable by reading documentation; all of it is an afternoon with the tool installed. The adapter is easy once the contract is known, and unwritable until it is.
