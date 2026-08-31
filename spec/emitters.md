# Writing an emitter

*How to make any coding agent produce Provene receipts. No fork, no schema change, no code in this repository.*

The receipt format has never been specific to one agent. `agent.vendor`, `agent.tool`, `agent.toolVersion` and `agent.model` are in [RFC 0001 §6.1](rfc/0001-receipt-schema.md) and have been since v0.1. What *was* specific was the wiring: Claude Code exposes lifecycle hooks, so `provene init` could install them in one command, and nothing else could.

This document is the contract for everything else.

## What an emitter has to do

Two things, and nothing more.

**1. Report events as they happen.** Every time the agent edits a file or runs a command, append to the session journal:

```sh
provene record --session <id> --kind edit    --path src/auth.ts
provene record --session <id> --kind command --argv "npm test" --exit 0 --duration-ms 4200
```

`--session` is any stable string for the life of one agent session. It must not contain a path separator; anything unusual is replaced with a hash of itself rather than rejected, so a strange id costs you nothing.

`record` never fails. It exits 0 whatever happens, because an emitter that can break the agent it observes will be uninstalled within a day.

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

## Three shapes of integration

**An agent with a hook system.** Wire two hooks: one on tool completion calling `provene record`, one on session end calling `provene emit`. This is what Claude Code does, and `provene init` writes it for you. Nothing about it is Claude-specific except the payload shape that `record --stdin` parses.

**An editor extension.** Subscribe to file-save and terminal-exit events, shell out to `provene record`. Emit when the window closes or the agent session ends.

**A wrapper.** If the agent has no hooks but runs commands through a shell you control, wrap that shell.

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

**Claude Code** and **Gemini CLI** both have their hooks written for them. Everything else uses the flag interface above.

The two are worth comparing, because the differences are where an integration built by assumption goes wrong. All three of these are silent failures if the shapes are assumed to match:

| | Claude Code | Gemini CLI |
|---|---|---|
| settings | `~/.claude/settings.json` | `~/.gemini/settings.json` |
| tool events | `PostToolUse` **and** `PostToolUseFailure` | `AfterTool` only |
| how an outcome is known | which event fired | `tool_response.error` |
| edit tools | `Write`, `Edit`, `MultiEdit` | `write_file`, `replace` |
| shell tool | `Bash` | `run_shell_command` |
| hook timeout unit | seconds | **milliseconds** |
| may a hook print? | yes | **no** — stdout is parsed as JSON |

The timeout one is the quietest: reusing Claude's `5` in a Gemini config gives every hook five *milliseconds* before it is killed.

**On reading tool output.** This project's rule since round 5 has been to take a command's outcome from the event name and never from parsing tool output, because Claude's `tool_response` is an undocumented shape that changes. Gemini has no failure event, so that rule cannot apply — but neither does the reason for it. Gemini's reference *specifies* `tool_response` as `{ llmContent, returnDisplay, error? }` and calls it a stable API. Reading a documented field is a different act from sniffing an undocumented one. Where the documented field is absent, no outcome is claimed at all rather than a pass being assumed.

**On naming the agent.** `--agent` is written into the hook command by `init`, never inferred at run time. Both agents send `session_id`, `cwd`, `hook_event_name`, `tool_name` and `tool_input`, so the payloads are not distinguishable by shape. A guess would be right most of the time, and a receipt naming the wrong agent is worse than one naming none.

## Agents not yet wired

Cursor, Codex, and Google Antigravity have no adapter. Antigravity documents a hooks system (`PreToolUse`, `PostToolUse`, `Stop` in `.agents/hooks.json`), and two things need answering before an adapter is worth writing: whether `PostToolUse` carries the `toolCall` that names the file or command, or only `stepIdx` and `error`; and whether hooks fire in the IDE at all, since there are open reports that they do not.

Both are five minutes of experiment for someone with it installed, and neither is answerable by reading. If you have one of these agents, that experiment is the most useful contribution this project can take right now — more than the adapter itself, which is an afternoon once the contract is known.
