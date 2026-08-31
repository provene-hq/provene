# proveneio

Evidence receipts for AI-generated code changes. Portable across agents, verifiable by anyone.

> Published as `proveneio`; the command it installs is `provene`. npm's similarity filter blocks the unscoped name against the unrelated package `projen`.

When a coding agent finishes a session, this records what happened as a small JSON file committed alongside the change: which agent and model, which files it touched, which commands ran, and what they returned.

```console
$ npm install -g proveneio
$ provene init      # adds the hooks to ~/.claude/settings.json
$ provene doctor    # confirms they are wired up
```

`init` merges into your existing Claude Code settings and backs up the previous file. It installs three hooks: `PostToolUse` and `PostToolUseFailure` append to a journal outside your repository, and `SessionEnd` reads it once and writes the receipt. The failure hook is what distinguishes a test run that failed from one that passed, since the outcome comes from which event fired rather than from parsing output.

It uses `SessionEnd` rather than `Stop` because a `Stop` hook can refuse to let a session finish, and a provenance tool has no business interrupting your work.

After that, work normally. A receipt appears in `.provene/` in your working tree when a session ends, unstaged. Nothing commits it for you: stage and commit it with the change it describes, the same way you would a test.

Two things catch people in the first hour, and both look like the tool is broken. `git commit -am` will not pick up a receipt, because `-a` stages modified tracked files and a new receipt is neither — use `git add -A`. And hooks are read when Claude Code starts, so if it was already running when you ran `provene init`, restart it.

It names the agent. It records the model only if something told the CLI what it was, because no hook payload carries it and the emitter will not guess.

## Commands

| | |
|---|---|
| `provene init` | install the Claude Code hooks |
| `provene doctor` | check the local setup, and say what is merely advisory |
| `provene emit` | write a receipt for a session |
| `provene verify <receipt>` | check one receipt's integrity and report its tier. A `.dsse.json` name must be backed by a real envelope, but this does not check the signature — `verify-aggregate` does that |
| `provene check --base <ref>` | what a reviewer needs: changed lines with no test behind them |
| `provene promote` | build the aggregate receipt CI signs |
| `provene manifest` | the exact bytes the change digest is taken over |
| `provene verify-aggregate` | verify a signed aggregate against this checkout |
| `provene record` | append to the session journal. Called by the hooks, not by you |
| `provene import` | read a session from an agent's own transcript, for an agent that fires no hooks. Antigravity is the one that needs it |

`provene check` is the one worth running by hand:

```console
$ provene check --base origin/main --coverage lcov.info
1/1 receipt(s) well formed (T0)
3 changed path(s); 3 carry agent attribution from this change
4/9 executable changed lines executed by the test run
  src/cart.ts: 3 of 3 executable changed lines unverified
  src/discount.ts: 2 of 4 executable changed lines unverified
```

Add `--annotate github` in CI and those become annotations on the diff.

## What a receipt proves, and what it does not

A receipt written on your laptop is a statement by the person who wants the change merged. Signing proves who signed it. It never proves the contents are true.

| Tier | Who attests | What it is good for |
|---|---|---|
| T0 | your machine, unsigned | local visibility; satisfies no policy |
| T1 | your machine, your identity | attribution among people who already trust each other. Specified; no emitter produces it |
| T2 | CI, on a runner you do not control | verification evidence, independently observed |

Forged authorship is not preventable and is an explicit non-goal: no format can distinguish typing from generating. Forged test evidence is prevented at T2, because CI runs the tests itself and signs the result with an identity the author does not hold.

## Verifying a signature

This does not implement signature verification and will not. Certificate chains, transparency-log inclusion proofs and signed timestamps belong to tools that exist. `gh attestation verify` does that half, and its exit code is the trust boundary.

```console
$ provene verify-aggregate --repo owner/name --base origin/main \
    --signer-workflow owner/name/.github/workflows/ci.yml
```

This recomputes the change set from your checkout, hands it to `gh`, and then checks the half `gh` cannot: that the signature covers the work in front of you, and not some other commit.

| | |
|---|---|
| **verified** | exit 0 |
| **failed** | exit 1. Bad signature, wrong change set, or nothing signed for this range |
| **could not check** | exit 3. No verifier installed, or an answer this version could not read back |

Without `--signer-workflow`, `gh` accepts a signature from any workflow in the repository, which is more signers than most maintainers expect. The command says so whenever it consulted a signature and you omitted the flag.

Stock tooling works too. `provene manifest` writes the exact bytes the change digest is taken over, so `sha256(manifest)` is the subject digest and any Sigstore verifier can find the attestation. Regenerate that manifest; never verify one you were sent, which proves only that the file you were sent was attested.

## Status

Pre-alpha. The receipt format is at v0.1 and will change. Claude Code is the only agent wired up today; the format is not specific to it.

Running from source needs Node 22.18 or newer, where a `.ts` file runs without a flag. This published package is compiled and has no such requirement.

Signing uses GitHub's attestation store, free for public repositories and a paid feature for private ones. The policy engine in RFC 0002 is specified and unimplemented, on purpose.

Specification, threat model and conformance suite: **https://github.com/provene-hq/provene**

Apache-2.0.
