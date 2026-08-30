# Provene

Portable, cryptographically signed evidence receipts for AI-generated code changes.

When a coding agent finishes a session, Provene records what happened — which agent and model, from what task, which files changed, which commands ran, which tests executed and what they returned — as a small signed artifact attached to the commit. A GitHub Action verifies receipts on pull requests and annotates the diff. A policy engine can require evidence before a merge.

GitHub records this for Copilot, inside GitHub. GitLab records it for Duo, inside GitLab. If your team runs Claude Code, Cursor and Codex side by side, nothing records it at all.

**Status: pre-alpha.** The specification is drafted and the reference CLI emits and verifies T0 receipts. Signing, promotion, the Action and the policy engine are not built yet.

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

See [`spec/rfc/0001-receipt-schema.md`](spec/rfc/0001-receipt-schema.md) and the threat model.

## Layout

```
spec/rfc/          RFC 0001 (receipt schema), RFC 0002 (policy grammar)
spec/schema/       JSON Schema for receipts and policies
spec/examples/     worked receipts and policies
spec/conformance/  the fixtures — these, not the prose, are the specification
packages/cli/      reference implementation (TypeScript, no runtime dependencies)
```

## Running it

```sh
node --test 'packages/cli/test/*.test.ts'   # implementation against the fixtures
python3 spec/conformance/runner/run.py      # the suite against reference semantics
```

## Contributing

Schema changes go through an RFC. A change that alters what a receipt means without a corresponding fixture will not be merged — the fixtures are how a second implementation in another language stays honest.

## Licence

Apache-2.0.
