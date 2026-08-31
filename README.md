# Provene

Portable, cryptographically signed evidence receipts for AI-generated code changes.

When a coding agent finishes a session, Provene records what happened — which agent and model, from what task, which files changed, which commands ran, which tests executed and what they returned — as a small artifact attached to the commit. A GitHub Action verifies those receipts on pull requests, annotates the changed lines no test executed, and signs a CI-attested aggregate over the whole range.

GitHub records this for Copilot, inside GitHub. GitLab records it for Duo, inside GitLab. If your team runs Claude Code, Cursor and Codex side by side, nothing records it across all three.

**Status: pre-alpha.** The specification is drafted. The reference CLI emits T0 receipts from Claude Code hooks, verifies them, builds the T2 aggregate, and verifies a signed one. The GitHub Action runs the whole path and signs through GitHub's attestation store. The policy engine specified in RFC 0002 is deliberately not built yet — the grammar has a conformance suite and no implementation, so the specification cannot quietly become "whatever the code does".

## What a receipt does and does not prove

This is the part most tools get wrong, so it is stated first.

A receipt generated on your machine is a **self-attestation by the person who wants the change merged**. Sigstore proves *who signed*, never that the contents are true. Provene deliberately does not sit in the model's inference path — that is what makes it deterministic and cheap to run — and the price of that choice is stated rather than hidden:

| Tier | Attester | Good for |
|---|---|---|
| T0 | local hook, unsigned | local visibility; satisfies no policy |
| T1 | local hook, developer identity | attribution among cooperating parties |
| T2 | CI, on a runner you do not control | verification evidence, independently observed |
| T3 | execution environment or agent vendor | authorship (reserved; nothing produces this yet) |

- **Forged authorship** — someone writing code by hand and claiming an agent did it — is not preventable, and is an explicit non-goal.
- **Forged test evidence** is prevented, because CI re-observes the run and signs it with an identity that has no stake in the merge.
- **Concealment** — hiding that an agent was involved — is resisted only under `enrolled` policy mode. Under the default mode it is not. Any claim otherwise has to name the mode.

See [`spec/rfc/0001-receipt-schema.md`](spec/rfc/0001-receipt-schema.md) and [the threat model](spec/threat-model.md).

## Verifying a signed aggregate

Provene does not implement signature verification and will not. `gh attestation verify` does that half, and its exit code — not any parsing of its output — is the trust boundary.

```sh
provene verify-aggregate --repo owner/name --base <base-commit>
```

This recomputes the change set from your checkout, hands it to `gh`, and then checks the half `gh` cannot: that the signature covers the work in front of you. It reports three outcomes — verified, failed, and *could not check*. The third covers a missing verifier and, equally, a verifier whose answer this version cannot read back: `gh` accepting a signature it could not describe to us is not a pass, and with `--bundle` it never compared the subject digest at all.

Stock tooling works too, because `provene manifest` writes the exact bytes the change digest is taken over, so `sha256(manifest)` *is* the subject digest (RFC 0001 §4.1.1):

**Regenerate the manifest; never verify one you were sent.** Verifying a supplied manifest proves that *that file* was attested, not that your repository matches it. `provene verify-aggregate` always regenerates, which is why it is the safer of the two paths.

```sh
provene manifest --base <base-commit> --out changeset
gh attestation verify changeset --repo owner/name \
  --predicate-type https://provene.dev/attestation/code-change-aggregate/v0.1
```

Signing uses GitHub's attestation store, which is free for public repositories and a paid feature for private ones. Where the platform will not store an attestation, the Action fails loudly rather than reporting an unsigned receipt as signed.

## Layout

```
spec/rfc/          RFC 0001 (receipt schema), RFC 0002 (policy grammar)
spec/schema/       JSON Schema for receipts and policies
spec/examples/     worked receipts and policies
spec/conformance/  the fixtures — these, not the prose, are the specification
spec/threat-model.md   what breaks this, and what it does not defend against
packages/cli/      reference implementation (TypeScript, no runtime dependencies)
action.yml         the GitHub Action: check, annotate, promote, sign
```

## Running it

```sh
node --test 'packages/cli/test/*.test.ts'          # 86 tests
python3 spec/conformance/runner/run.py             # 50 fixtures against reference semantics
python3 spec/conformance/runner/validate_receipts.py   # emitted receipts against the schemas
```

Requires Node 22.6 or newer: the sources run directly, with no build step and no bundler.

## Contributing

Schema changes go through an RFC. A change that alters what a receipt means without a corresponding fixture will not be merged — the fixtures are how a second implementation in another language stays honest.

## Licence

Apache-2.0.
