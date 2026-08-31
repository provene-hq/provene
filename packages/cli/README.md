# proveneio

*Published as `proveneio`; the command it installs is `provene`. The unscoped name `provene` is blocked by npm's similarity filter against the unrelated package `projen`.*

Portable, cryptographically signed evidence receipts for AI-generated code changes.

When a coding agent finishes a session, this CLI records what happened — which agent and model, from what task, which files changed, which commands ran, which tests executed and what they returned — as a signed artifact attached to the commit.

**Pre-alpha.** `init`, `record`, `emit`, `verify`, `check`, `promote`, `manifest`, `verify-aggregate` and `doctor` work. The GitHub Action verifies receipts, annotates changed lines with no test behind them, builds a T2 aggregate and signs it.

Signing uses GitHub's attestation store, which is free for public repositories and a paid feature for private ones. The policy engine specified in RFC 0002 is not built.

```sh
npm i -g proveneio
provene init      # installs the Claude Code hooks (user-level)
provene doctor    # confirms they are actually wired up
```

`init` writes to `~/.claude/settings.json`, merging with whatever is already there and backing up the previous file. `PostToolUse` appends to a session journal outside your repository; `SessionEnd` writes the receipt. `SessionEnd` rather than `Stop`, because a `Stop` hook can block and force a session to continue — the emitter must never be able to interrupt your work.

## What a receipt does and does not prove

A receipt generated on your machine is a **self-attestation by the person who wants the change merged**. Sigstore proves *who signed*, never that the contents are true. Provene deliberately does not sit in the model's inference path — that is what makes it deterministic and cheap — and the price is stated rather than hidden:

| Tier | Attester | Good for |
|---|---|---|
| T0 | local hook, unsigned | local visibility; satisfies no policy |
| T1 | local hook, developer identity | attribution among cooperating parties |
| T2 | CI, on a runner you do not control | verification evidence, independently observed |

Forged authorship is not preventable and is an explicit non-goal. Forged test evidence is prevented, because CI re-observes the run and signs it with an identity that has no stake in the merge.

## Verifying a signed aggregate

Provene does not implement signature verification, and will not: certificate chains, transparency-log inclusion proofs and signed timestamps are not a thing to reimplement in a side project. `gh attestation verify` does that half, and its exit code is the trust boundary.

```sh
provene verify-aggregate --repo owner/name --base <base-commit>
```

That recomputes the change set from your checkout, hands the result to `gh`, and then checks the half `gh` cannot: that the change set the signature covers is the work in front of you, and that the predicate's own claims are consistent. It reports three outcomes, not two — verified, failed, and *could not check*. The third covers a missing verifier and, equally, a verifier whose answer this version cannot read back: `gh` accepting a signature it could not describe to us is not a pass, and with `--bundle` it never compared the subject digest at all. Pass `--signer-workflow` to require a specific signer; without it, any workflow in the repository is accepted, and the command says so.

With stock tooling only, no Provene verifier involved:

```sh
provene manifest --base <base-commit> --out changeset
gh attestation verify changeset --repo owner/name \
  --predicate-type https://provene.dev/attestation/code-change-aggregate/v0.1
```

`provene manifest` writes the exact bytes the change digest is taken over, so `sha256(changeset)` *is* the subject digest (RFC 0001 §4.1.1). That is what makes a Provene attestation addressable by tools that know nothing about Provene.

**Regenerate the manifest; never verify one you were sent.** Verifying a supplied manifest proves that *that file* was attested, not that your repository matches it. `provene verify-aggregate` always regenerates, which is why it is the safer of the two paths.

Full specification, threat model and conformance suite: **https://github.com/provene-hq/provene**

Apache-2.0.
