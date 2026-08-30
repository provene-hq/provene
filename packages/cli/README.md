# provene

Portable, cryptographically signed evidence receipts for AI-generated code changes.

When a coding agent finishes a session, this CLI records what happened — which agent and model, from what task, which files changed, which commands ran, which tests executed and what they returned — as a signed artifact attached to the commit.

**Pre-alpha.** `record`, `emit`, `verify` and `doctor` work. Signing, CI promotion, the GitHub Action and the policy engine are not built yet.

```sh
npm i -g provene
provene doctor
```

## What a receipt does and does not prove

A receipt generated on your machine is a **self-attestation by the person who wants the change merged**. Sigstore proves *who signed*, never that the contents are true. Provene deliberately does not sit in the model's inference path — that is what makes it deterministic and cheap — and the price is stated rather than hidden:

| Tier | Attester | Good for |
|---|---|---|
| T0 | local hook, unsigned | local visibility; satisfies no policy |
| T1 | local hook, developer identity | attribution among cooperating parties |
| T2 | CI, on a runner you do not control | verification evidence, independently observed |

Forged authorship is not preventable and is an explicit non-goal. Forged test evidence is prevented, because CI re-observes the run and signs it with an identity that has no stake in the merge.

Full specification, threat model and conformance suite: **https://github.com/provene-hq/provene**

Apache-2.0.
