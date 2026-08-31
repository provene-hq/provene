# Provene

Evidence receipts for AI-generated code changes. Portable across agents, verifiable by anyone.

Your team runs Claude Code, Cursor and Codex. Six months from now a reviewer asks which parts of a service were written by an agent, from what task, and what was actually run against them before merge. GitHub can answer that for Copilot, inside GitHub. GitLab can answer it for Duo, inside GitLab. Across three vendors and a self-hosted runner, nobody can answer it at all.

Provene records the answer at the moment it is still true, as a small JSON file committed alongside the change.

## See it work

A developer asks an agent to add discount codes to a shopping cart. The agent writes `src/discount.ts`, adds a test for it, and edits `src/cart.ts`. Then it runs the test suite.

When the session ends, the `SessionEnd` hook writes the receipt:

```console
provene: wrote .provene/25bae63b8d80....statement.json
  tier T0 (unsigned) · 3 paths · change 25bae63b8d80
  1 local test run(s) observed, 1 passed (observedBy: local — satisfies no policy on its own)
  3 path(s) with no verification evidence
```

Inside, the parts a reviewer cares about:

The `model` line below appears because this session was told which model to record. Nothing in a Claude Code hook payload carries it, and the emitter will not guess, so a receipt written by the hooks alone names the tool and stops there.

```json
"agent":   { "tool": "claude-code", "model": "claude-opus-5", "modelSource": "reported" },
"binding": { "changeDigest": "25bae63b8d80…", "parent": "019f30beb192", "excluded": [".provene/"] },
"changes": { "granularity": "file", "files": [
  { "path": "src/cart.ts",           "status": "M", "preBlob": "8ef74ef3…", "postBlob": "292588ba…" },
  { "path": "src/discount.ts",       "status": "A", "preBlob": "-",         "postBlob": "2457fcb3…" },
  { "path": "test/discount.test.ts", "status": "A", "preBlob": "-",         "postBlob": "fb34ac21…" }
]},
"commands": [
  { "argv0": "npm", "shape": "npm test", "exitCode": 0, "observedBy": "local",
    "argvDigest": "hmac-sha256:e9ea9a22…" }
]
```

No prompt text, no argument vector, no file contents. A command is recorded three ways: its name (`npm`), a *shape* if the whole command line matches a fixed allowlist (`npm test`), and an HMAC of the real argument vector keyed to the repository. Two receipts can be compared for whether the same command ran, without either one revealing it.

The allowlist matches whole command lines exactly, so `npm test` is recognised and `npm test -- --watch` is not. That is a deliberate floor rather than a parser: a tool that guesses which commands are tests will eventually record a deploy as one.

The HMAC is keyed from the repository's root commit, which anyone with the repository can read. It hides a command from a stranger holding only the receipt. It does not hide one from someone who can clone the repo and guess, and short command lines are easy to guess. Treat it as making receipts comparable, not as encryption.

Now the same change on a pull request, with a coverage report:

```console
$ provene check --base origin/main --coverage lcov.info
1/1 receipt(s) well formed (T0)
3 changed path(s); 3 carry agent attribution from this change
4/9 executable changed lines executed by the test run
  src/cart.ts: 3 of 3 executable changed lines unverified
  src/discount.ts: 2 of 4 executable changed lines unverified
```

Those two lines are the point of the tool. Here is `src/cart.ts`:

```ts
 7  export function total(items: Item[], code: string): number {
 8    const shipping = subtotal(items) > 5000 ? 0 : 499;
 9    return subtotal(items) + shipping;
10  }
```

The agent added a `total` that takes a discount code and never applies it. The tests it wrote pass. The suite is green. Nothing executed those three lines, and the receipt says an agent wrote them.

On a pull request the same run annotates the diff, so a reviewer sees it where they are already looking:

```
::warning file=src/cart.ts,line=7,endLine=9::3 of 3 changed lines have no test evidence (from lines 7-9)
::warning file=src/discount.ts,line=3,endLine=4::2 of 4 changed lines have no test evidence (from lines 3-4)
```

## Install

```console
$ npm install -g proveneio
$ provene init      # adds the hooks to ~/.claude/settings.json
$ provene doctor    # confirms they are wired up
  ok   git repository             /home/you/shop
  ok   root commit reachable      019f30beb192
  ok   journal directory          /home/you/.provene
 warn  .gitattributes stanza      add: .provene/** linguist-generated=true -diff
  ok   hooks installed            ~/.claude/settings.json
  ok   git version                git version 2.34.1

Ready. 1 advisory item(s) above.
```

`init` merges into your existing Claude Code settings and backs up the previous file. It installs three hooks: `PostToolUse` and `PostToolUseFailure` append to a journal outside your repository, and `SessionEnd` reads it once and writes the receipt. The failure hook is not optional decoration. It is the only thing that distinguishes a test run that failed from one that passed, because the outcome comes from which event fired rather than from parsing what a tool printed.

It uses `SessionEnd` rather than `Stop` because a `Stop` hook can refuse to let a session finish, and a provenance tool has no business interrupting your work.

One more thing worth knowing before you read a receipt: the agent's *model* is recorded only if something tells the CLI what it was. No Claude Code hook payload carries it, and the emitter will not guess, so a receipt written by the hooks alone names the tool and leaves the model out.

The receipt lands in `.provene/` in your working tree, unstaged. Nothing commits it for you: stage and commit it with the change it describes, the same way you would a test. Committing it is what binds the evidence to the history, and a receipt left uncommitted is a receipt nobody will ever see.

Claude Code is the only agent wired up today. The receipt format is not specific to it, and adding a second emitter is a hook script, not a fork.

## What a receipt proves, and what it does not

A receipt written on your laptop is a statement by the person who wants the change merged. Signing proves who signed it. It never proves the contents are true. Provene stays out of the model's inference path, which is what makes it deterministic and free to run, and the cost of that choice is worth stating plainly rather than burying:

| Tier | Who attests | What it is good for |
|---|---|---|
| T0 | your machine, unsigned | local visibility; satisfies no policy |
| T1 | your machine, your identity | attribution among people who already trust each other. Specified; no emitter produces it |
| T2 | CI, on a runner you do not control | verification evidence, independently observed |
| T3 | the execution environment or the agent vendor | authorship. Reserved; nothing produces it yet |

Three claims people expect a tool like this to make, and where each one actually stands:

**Forged authorship.** Someone writes code by hand and says an agent did it. Not preventable, and an explicit non-goal. No receipt format can distinguish typing from generating.

**Forged test evidence.** Someone claims tests passed when they did not. Prevented at T2, because CI runs the tests itself and signs the result with an identity the author does not hold.

**Concealment.** Someone disables the hook and merges silently. This is the one people assume is covered and it is not. Resistance requires `enrolled` policy mode, where a repository knows which contributors are enrolled and requires a receipt from them — and the policy engine that would enforce it is specified and unbuilt, so nothing today can require a receipt from anyone. Under the default mode it would not be resisted even once it exists. Any claim otherwise has to name the mode.

The [threat model](spec/threat-model.md) works through the rest.

## On a pull request

```yaml
permissions:
  contents: read
  id-token: write        # to mint the OIDC token Sigstore signs against
  attestations: write    # to store the result

steps:
  - uses: actions/checkout@v4
    with: { fetch-depth: 0 }
  - id: test
    run: npm test -- --coverage
  # Pin a commit rather than a branch. The action normally runs the CLI bundled
  # at that ref with no install step, so the SHA pins the code that runs. A
  # runner whose Node cannot execute TypeScript falls back to installing from
  # npm, and on that path the SHA pins a version number rather than the bytes.
  - uses: provene-hq/provene@<commit-sha>
    with:
      coverage: coverage/lcov.info
      test-result: ${{ steps.test.outcome == 'success' && 'PASSED' || 'FAILED' }}
      sign: ${{ !github.event.repository.private }}
```

The action verifies the receipts on the branch, annotates the changed lines nothing executed, and then builds one aggregate receipt covering the whole range and asks GitHub to sign it. The aggregate exists because a squash merge destroys the commits the individual receipts were bound to.

`test-result` is passed in rather than guessed. The action does not run your tests and will not report an outcome it did not observe; leave it out and the signed receipt records no test evidence, which is the honest answer.

Signing uses GitHub's attestation store. That is free for public repositories and a paid feature for private ones. Where the platform refuses to store an attestation the action fails loudly, because believing you hold a signed receipt when nothing was signed is worse than a red check.

## Verifying a signature

Provene does not implement signature verification and will not. Certificate chains, transparency-log inclusion proofs and signed timestamps belong to tools that exist. `gh attestation verify` does that half, and its exit code is the trust boundary.

```console
$ provene verify-aggregate --repo owner/name --base origin/main \
    --signer-workflow owner/name/.github/workflows/ci.yml
```

This recomputes the change set from your checkout, hands it to `gh`, and then checks the half `gh` cannot: that the signature covers the work in front of you, and not some other commit. It reports three outcomes, and never renders one as another:

| | |
|---|---|
| **verified** | exit 0 |
| **failed** | exit 1. The signature is bad, or covers a different change set, or nothing is signed for this range at all |
| **could not check** | exit 3. No verifier installed, or a verifier whose answer this version could not read back |

Without `--signer-workflow`, `gh` accepts a signature from *any* workflow in the repository, which is more signers than most maintainers expect. The command says so when you omit it.

Stock tooling works too. `provene manifest` writes the exact bytes the change digest is taken over, so `sha256(manifest)` is the subject digest and any Sigstore verifier can find the attestation:

```console
$ provene manifest --base origin/main --out changeset
$ gh attestation verify changeset --repo owner/name \
    --predicate-type https://provene.dev/attestation/code-change-aggregate/v0.1 \
    --signer-workflow owner/name/.github/workflows/ci.yml
```

Regenerate that manifest; never verify one you were sent. Verifying a supplied file proves that file was attested. It says nothing about your repository.

## Status

Pre-alpha. The format is specified and has a conformance suite. The CLI emits, verifies, promotes and checks. The action runs the whole path and asks GitHub to sign the result.

The signing path has now been run for real. Pull request #2 produced a signed T2 aggregate in GitHub's attestation store on 31 August 2026, and `provene verify-aggregate` confirmed it against a local checkout, pinned to the signing workflow:

```console
provene: verified T2 aggregate · sha256:2b3229b7027d · provene-hq/provene
  signer https://github.com/provene-hq/provene/.github/workflows/provene.yml@refs/pull/2/merge
```

That run also found a defect five rounds of review had not: the aggregate counted the pull-request merge commit GitHub creates, which exists in no checkout, so it claimed one more commit than any verifier could find. Fixed, and the thing worth taking from it is that a signing path can be reviewed to exhaustion and still be wrong in a way only running it reveals.

The policy engine in [RFC 0002](spec/rfc/0002-policy-grammar.md) is specified with 38 conformance checks and no implementation, on purpose: writing the evaluator first is how a specification quietly becomes "whatever the code does". Attribution is file-level; the format describes content-anchored spans and no emitter produces them yet.

Nothing here is stable. `proveneio` is published on npm and the action is usable, but the receipt format is at v0.1 and will change, and there are no tagged releases of the action yet.

## Repository

```
spec/rfc/0001-receipt-schema.md    the receipt format
spec/rfc/0002-policy-grammar.md    the policy language (unimplemented)
spec/threat-model.md               adversaries, tiers, what this does not defend against
spec/conformance/                  fixtures. These, and not the prose, are the specification
spec/schema/                       JSON Schema for receipts and aggregates
packages/cli/                      reference implementation. TypeScript, no runtime dependencies
action.yml                         the GitHub Action
```

```console
$ npm test              # 107 tests
$ npm run conformance   # 50 checks over 30 fixtures
$ npm run schema        # emitter output against the schemas
$ npm run typecheck
$ npm run lint:action   # an action manifest may hold no expression outside runs:
```

Node 22.18 or newer, which is where running a `.ts` file without a flag became the default. On 22.6 through 22.17 the sources need `--experimental-strip-types`. The published npm package is compiled and has no such requirement.

## Contributing

Changes to what a receipt *means* go through an RFC and arrive with a conformance fixture. The fixtures are how a second implementation in another language stays honest, so a semantic change without one will not be merged.

Bugs, emitters for other agents, and a second implementation are all welcome. If you find a way to make a receipt say something untrue, that is the most useful issue you can file.

## Licence

Apache-2.0.
