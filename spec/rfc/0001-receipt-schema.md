# RFC 0001 — Provene Receipt Schema v0.1

| | |
|---|---|
| **Status** | Draft |
| **Version** | 0.1.3 |
| **Predicate type** | `https://provene.dev/attestation/code-change/v0.1` |
| **Date** | 2026-08-30 |
| **Supersedes** | — |
| **Depends on** | Threat Model v0.1 (assurance tiers, redaction contract) |

---

## Abstract

This document specifies the Provene **code-change receipt**: a portable, signed record of what an AI coding agent did in one session and what verification was observed to run on the result. A receipt is an [in-toto Statement](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md) carrying a Provene predicate, wrapped in a DSSE envelope, bound to a set of changes by content digest, and attached to the repository in-tree.

The schema is deliberately small. It records observations and their provenance; it makes no quality judgments, performs no inference, and asserts nothing it cannot attribute to an identified observer.

---

## 1. Conformance language

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are to be interpreted as described in RFC 2119.

An implementation is **conformant** if it produces receipts that validate against `provene-receipt-v0.1.schema.json`, satisfies every MUST in this document, and reproduces the byte-exact statements in the conformance fixture suite (§12).

## 2. Scope and non-scope

A receipt records:

- which agent tool and model produced a change, as reported by the tool;
- a reference to the originating task, and a keyed digest of it;
- which files and which regions of those files the agent produced;
- which commands ran, which tests executed, and what results were observed;
- who attested to all of the above, and at what assurance tier.

A receipt does **not** assert that an agent authored a change (see Threat Model §4, T-1), that code is correct, secure, or well-designed, or that unattributed regions of a diff were written by a human. **Absence of attribution means unobserved, never human.** This distinction is normative and implementations MUST NOT present it otherwise.

## 3. Envelope

A **signed** receipt (tier `T1` and above) MUST be serialized as a [DSSE](https://github.com/secure-systems-lab/dsse) envelope with `payloadType` `application/vnd.in-toto+json`, whose payload is an in-toto Statement v1. A `T0` receipt is unsigned and MUST be serialized as the bare Statement — a DSSE envelope with an empty signature list is malformed, and an unsigned receipt should not masquerade as a signed one. Promotion (§5) wraps the equivalent Statement in an envelope; it does not sign the T0 file in place.

The Statement:

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [ { "name": "...", "digest": { "sha256": "..." } } ],
  "predicateType": "https://provene.dev/attestation/code-change/v0.1",
  "predicate": { }
}
```

**Rationale.** DSSE supplies the signing envelope and its canonicalization, so this specification defines no serialization rules of its own; existing supply-chain tooling can route and verify the envelope without understanding the predicate. Statement `subject` accepts git-native digest algorithms — `gitCommit`, `gitTree`, `gitBlob`, `gitTag` are standard in the in-toto DigestSet spec — so nothing about git semantics is contorted to fit.

## 4. Binding: what a receipt covers

### 4.1 The change digest

A receipt is bound to a **change set**, not to a commit. This is forced by construction: the receipt is written before the commit exists, and (per §8) the receipt file is itself part of the commit.

The change digest is computed as follows. Implementations MUST follow it exactly.

1. Compute the set of paths that differ between the pre-session tree and the post-session tree.
2. **Exclude every path matching `.provene/**`.**
3. For each remaining path, form the line `<status> <path> <preBlob> <postBlob>` where `status` is one of `A`, `M`, `D`, `R`; `path` is the repository-relative path, byte-exact; and `preBlob`/`postBlob` are the git blob object IDs, or the literal `-` where the side does not exist. For a rename, `path` is the post-image path and a second field `<-<prePath>` is appended.
4. Sort the lines by `path` as raw bytes, ascending. Join with `\n` (no trailing newline). Encode UTF-8.
5. `changeDigest` = lowercase hex SHA-256 of those bytes.

**Rationale.** The digest is over *blob identities*, never over a rendered diff. Diff rendering depends on algorithm, context width, whitespace flags and renaming heuristics — all of which change between git versions and configurations, and none of which may be allowed to alter a signature. Blob IDs are stable, cheap to obtain from plumbing, and independently recomputable by any verifier.

The Statement subject MUST be a single entry: `{"name": "<repo-relative change name>", "digest": {"sha256": "<changeDigest>"}}`.

### 4.2 Verifying the binding against a commit

To verify a receipt against commit `C`, a verifier MUST recompute the change digest from the diff of `C` against its **first parent**, applying the same exclusion, and compare it to the subject digest. Equality is REQUIRED for the receipt to be considered bound to `C`.

The predicate records `binding.parent` as the git commit ID of the pre-session tree's commit. A verifier SHOULD compare it and MUST NOT fail on mismatch alone: a rebase preserves the change content while replacing the parent. A mismatch with an equal change digest MUST be reported as `rebased`, not as a verification failure. A mismatch in the change digest is always a failure.

### 4.3 What this deliberately does not survive

A change digest does not survive a squash, a rebase that resolves conflicts, or an amend that alters content — in each case the diff genuinely changed, and the receipt genuinely no longer describes it. §9 specifies the aggregate receipt that carries evidence across those boundaries.

## 5. The attestation block

```json
"attestation": {
  "tier": "T2",
  "attester": {
    "identity": "repo:acme/api:ref:refs/heads/main",
    "issuer": "https://token.actions.githubusercontent.com"
  },
  "trustRoot": { "kind": "sigstore-public" },
  "transparencyLog": { "published": true, "logIndex": 84029135 },
  "promotedFrom": {
    "tier": "T0",
    "receiptDigest": "sha256:9f2c…"
  }
}
```

**`tier`** is REQUIRED and MUST be one of:

| Tier | Attester | Signature | Admissible as |
|---|---|---|---|
| `T0` | local hook | none | local visibility only; MUST NOT satisfy any policy |
| `T1` | local hook | developer identity | attribution among cooperating parties |
| `T2` | CI on a runner the developer does not control | workload identity | independently observed verification evidence |
| `T3` | execution environment or agent vendor | environment identity | authorship (reserved; no producer exists) |

`T3` is specified but unpopulated. It exists so that the field does not require a breaking change when agent execution moves into environments the developer does not control.

**`promotedFrom`** records that this receipt was derived from a lower-tier receipt, referencing it by digest. Promotion is how the intended default flow works: the local hook emits `T0` (unsigned, §7), and the GitHub Action re-observes what it can, signs with the CI workload identity, and emits a `T2` receipt whose `promotedFrom.receiptDigest` names the local one. A promoted receipt MUST NOT restate a claim it did not itself observe at its own tier — claims carried forward from the lower-tier receipt retain the `observedBy` of their original observer (§6.4).

**`trustRoot.kind`** MUST be one of `sigstore-public`, `sigstore-private` (with `url`), `ssh`, or `x509` (with `url`). A verifier MUST determine acceptable trust roots from its own configuration and MUST NOT accept a trust root on the authority of the receipt that names it.

**`transparencyLog.published`** is REQUIRED. See §11.

## 6. The predicate body

### 6.1 Agent

```json
"agent": {
  "vendor": "anthropic",
  "tool": "claude-code",
  "toolVersion": "2.4.1",
  "model": "claude-opus-5",
  "modelSource": "reported"
}
```

`modelSource` MUST be `reported` (the tool supplied it) or `configured` (read from local configuration). A model identifier that the emitter inferred MUST NOT be recorded.

### 6.2 Emitter

```json
"emitter": { "name": "provene", "version": "0.0.2" }
```

REQUIRED. The software that produced this receipt, as distinct from the agent whose work it describes.

**Rationale.** Emitters have bugs, and some of those bugs change what a receipt *means* rather than making it malformed. A receipt whose `unverifiedPaths` was computed from attribution instead of verification (the defect that renamed that field in v0.1.2) validates against the schema and is silently wrong. Without an emitter version there is no way to find the affected receipts afterwards, and a corpus of evidence you cannot audit for known defects is not evidence. Implementations MUST NOT infer or hardcode this value; it is read from the emitter's own package metadata.

### 6.3 Task

```json
"task": {
  "ref": "https://github.com/acme/api/issues/412",
  "sessionRef": "claude-code://session/01J8…",
  "digest": "hmac-sha256:4a91…",
  "digestScope": "repo",
  "keySource": "root-commit"
}
```

`ref` is the primary evidence field: a URI into a system the developer does not control, where the task or session record actually lives.

`digest` is an HMAC over the task text, scoped per repository. Producers MUST NOT emit an unsalted digest: task text is low-entropy, so an unsalted digest is both guessable by dictionary and correlatable across organizations.

`keySource` is REQUIRED wherever `digest` is present, and MUST be one of:

- **`root-commit`** (default) — the salt is derived from the repository's root commit. Where `git rev-list --max-parents=0 HEAD` yields more than one root, as it does for grafted or merged histories, implementations MUST use the **lexicographically smallest** object ID, so that derivation is deterministic across clones.
- **`configured`** — a secret supplied out of band.

**This distinction is normative because the two carry different guarantees, and the spec must not blur them.** A root-commit-derived value is a **salt, not a key**: it is public to anyone with the repository. It provides *cross-tenant unlinkability* — the same task text in two organizations yields different digests — and it provides **no confidentiality against anyone who can read the repository**, who can mount an offline dictionary attack against low-entropy task text. That trade is acceptable by default because a repository reader is inside the trust boundary and `task.ref` already points them at the task record; it is not acceptable to describe it as a key. Deployments needing confidentiality MUST use `configured`.

Forks share a root commit and therefore produce linkable digests. This is intended.

The digest is a linkage commitment, not evidence. It permits a holder of the plaintext to confirm a match; it proves nothing on its own, and implementations MUST NOT present it as proof of anything.

Plaintext task or prompt text MUST NOT appear in a receipt.

### 6.4 Changes and attribution

```json
"changes": {
  "granularity": "hunk",
  "files": [
    {
      "path": "src/auth/session.ts",
      "status": "M",
      "preBlob": "3f1c…", "postBlob": "a07e…",
      "attributed": [
        {
          "digest": "sha256:c41d…",
          "lines": 18,
          "anchorBefore": "sha256:7b09…",
          "anchorAfter": "sha256:e6f2…"
        }
      ],
      "verifiedBy": ["run-1"]
    }
  ]
}
```

`granularity` is REQUIRED and MUST be `hunk` or `file`.

- **`file`** — asserts only that the agent touched the file. `attributed` MUST be omitted. **This is the only granularity a v0.1 emitter is REQUIRED to produce.**
- **`hunk`** — OPTIONAL. `attributed` lists **content-anchored spans**: `digest` is the SHA-256 of the span text, `lines` its length, and `anchorBefore`/`anchorAfter` the digests of the immediately preceding and following lines (omitted at file boundaries).

Emitters MUST fall back to `file` rather than guess. Policies MAY require `hunk`.

**Rationale for content anchoring.** Spans are located by content, not by position. Inserting a line above an attributed span does not invalidate it; editing the text *inside* the span does invalidate it, which is correct — the text is no longer what the agent produced. Positional line ranges have neither property: any edit anywhere above them silently shifts every subsequent range, so a positional record is wrong far more often than it is detectably wrong. Content anchoring requires hashing text and nothing else — no parsing, no language awareness, no syntax tree.

**Rationale for attribution at all.** Path-scoped policy is incorrect on mixed-authorship files without it: a rule requiring human review under `src/crypto/**` is wrong if it fires because an agent fixed a typo elsewhere in a 2,000-line file, and wrong again if it misses an agent edit inside a mostly-human one. Coarse attribution is a false-positive engine in exactly the paths where policy matters most, and a gate with a high false-positive rate is a gate that gets switched off.

Regions not listed in `attributed` are **unobserved**. They MUST NOT be described as human-authored.

**`changes.files` MUST be exactly the set of entries the change digest was computed over, and a verifier MUST confirm this by recomputing the digest from `changes.files` alone.** Without that check the readable half of a receipt is unbound from the signed half: an attacker can rewrite recorded blob IDs, paths or statuses, and the receipt still verifies against the working tree because the subject digest is recomputed from the tree rather than from what the receipt says. This was found by tampering with a receipt produced by the reference implementation, which reported it as well formed.

### 6.5 Commands

```json
"commands": [
  {
    "argv0": "npm",
    "shape": "npm test",
    "argvDigest": "hmac-sha256:1d77…",
    "exitCode": 0,
    "durationMs": 12040,
    "observedBy": "ci"
  }
]
```

`shape` is present only when the full command matched an entry in the emitter's allowlist of known-safe command forms, and is then the allowlist entry, not the observed text. Where no entry matched, `shape` MUST be omitted and only `argv0` and `argvDigest` recorded.

Full argument vectors MUST NOT be recorded. This is an allowlist, not a denylist, because argument vectors carry credentials routinely (`curl -H "Authorization: Bearer $TOKEN"`) and a denylist in a trust product fails silently and permanently.

`observedBy` MUST be `local` or `ci` and identifies who watched the command run, independent of who signed the receipt.

### 6.6 Verification

Field names follow the [in-toto Test Result predicate v0.1](https://github.com/in-toto/attestation/blob/main/spec/predicates/test-result.md) where they overlap, so that receipts remain legible to tooling already in that ecosystem.

```json
"verification": {
  "runs": [
    {
      "id": "run-1",
      "kind": "test",
      "tool": "vitest",
      "result": "PASSED",
      "counts": { "passed": 47, "failed": 0, "skipped": 2 },
      "failedTests": [],
      "url": "https://github.com/acme/api/actions/runs/1934…",
      "baseCommit": "9c2d1a77f0b6e4358d1f2a9c7e0b4d63a815ff20",
      "observedBy": "ci"
    }
  ],
  "unverifiedPaths": ["src/legacy/report.ts"]
}
```

`result` MUST be `PASSED`, `WARNED`, or `FAILED`.

Raw standard output or standard error MUST NOT be recorded, at any tier. Counts, test identifiers, and a URL to the run are sufficient to support a policy decision and do not carry the payload that stdout does.

`baseCommit` records the commit the run was executed against. It is REQUIRED on any run whose `result` a policy may rely on.

**Rationale.** Because binding is by change content (§4), a receipt travels with its diff — which is correct for authorship claims and dangerous for verification claims. An identical change cherry-picked onto a different branch carries a genuinely valid receipt attesting to a test run that happened against a *different base*, where the same change might fail. `baseCommit` makes that detectable without reintroducing the rebase brittleness that content binding exists to avoid: a policy can require that a run's `baseCommit` equal the pull request's merge base, and stale evidence then fails on a policy predicate rather than on a signature.

`unverifiedPaths` lists changed paths that no run in this receipt covers.

**On the name.** This field was `unattributedPaths` through v0.1.1. It is about *verification* coverage, not attribution, and the two are separate concerns here — a path can be agent-attributed and well tested, or unattributed and untested. Writing the emitter made the collision plain: the implementation computed the field from the attribution journal, matching the old name rather than the specified meaning, and passed every schema check while doing so. Renamed in v0.1.2. This field is the reviewer-facing product: it is what the PR annotation is generated from.

### 6.7 Human review

```json
"humanReview": { "observed": false }
```

Reserved. A receipt MUST NOT claim human review it did not observe; in v0.1 no producer observes it, so `observed` is always `false`.

## 7. Signing and tiers

The default emission flow is:

1. The session-end hook emits a **T0** receipt: unsigned, complete, written in-tree.
2. The GitHub Action re-observes what CI can observe — the diff, the test runs, the checks — signs the resulting statement with the CI workload identity, and emits a **T2** receipt naming the T0 receipt in `promotedFrom`.

Local receipts are unsigned by default because Sigstore keyless signing requires an OIDC identity, which on a workstation means an interactive browser flow that cannot fire inside a session-end hook without interrupting every session. An ephemeral local key would prove that a key signed, not who holds it, which is not materially better than `T0` for any audit purpose while adding key management the product does not otherwise need.

`T1` is specified for emitters that have a durable, externally verifiable developer identity available without interaction. It is not the default.

## 8. Attachment

A receipt MUST be written in-tree under `.provene/`, with a filename that declares its encoding:

- `.provene/<changeDigest>.statement.json` — a bare in-toto Statement (unsigned, `T0`).
- `.provene/<changeDigest>.dsse.json` — a DSSE envelope (`T1` and above).

Both are retained when a receipt is promoted: the promotion chain is auditable only if the receipt named by `promotedFrom.receiptDigest` still exists, so promotion MUST NOT rewrite or delete its source.

**Rationale.** The encoding is in the filename so that no consumer ever has to attempt one parse and fall back to another. The alternative — a uniform DSSE envelope carrying a placeholder signature for unsigned receipts — is rejected: strict verifiers would raise cryptographic errors rather than policy errors, and a product whose proposition is that its artifacts are not fabricated must not ship artifacts containing fabricated signatures.

- Content-addressed names mean concurrent branches only ever add files, so receipts never produce merge conflicts.
- In-tree files propagate on clone, fetch, and push with no refspec configuration anywhere — including `actions/checkout`, which does not fetch notes.
- In-tree receipt content survives a squash merge; out-of-tree attachments do not.

Repositories SHOULD ship a `.gitattributes` stanza so that receipts do not add noise to review:

```
.provene/** linguist-generated=true -diff
```

Implementations MAY additionally write a git note under `refs/notes/provene` for tooling that prefers it. Notes MUST NOT be the sole attachment: they require refspec configuration on every clone, are silently rewritable, and are destroyed by squash merges.

## 9. Aggregate receipts

Predicate type: `https://provene.dev/attestation/code-change-aggregate/v0.1`.

When a pull request is squashed or rebase-merged, the constituent commits — and therefore their change digests — cease to exist on the target branch. The Action MUST emit an aggregate receipt at merge time whose subject is the change digest of the merge result, and whose predicate lists each constituent receipt by digest along with the change digest it covered.

An aggregate receipt is always `T2` or higher: CI is the only party present at the moment the merge commit comes into existence, and it has no stake in the merge.

Constituent per-commit receipts remain in `.provene/` after a squash, so per-commit granularity is preserved as file content even though the commits are gone.

## 10. Redaction contract (normative)

A conformant emitter MUST NOT record: prompt or task plaintext; full argument vectors; raw stdout or stderr; environment variable values; file contents; or the contents of any file matched by the repository's configured exclusion patterns.

A conformant emitter MUST record `argvDigest` as a keyed HMAC, never a bare hash.

An emitter SHOULD allow configuration of path exclusion, and MUST record in the receipt that exclusion was in effect (`redaction.pathsExcluded: true`) so that a verifier can distinguish an empty change set from a redacted one.

## 11. Transparency log publication

`attestation.transparencyLog.published` is REQUIRED, and its value MUST reflect a deliberate configuration decision rather than a default of the signing library.

Sigstore's public Fulcio embeds the signer's OIDC identity — for a developer, their email address — in the certificate, and that certificate is published to the Rekor transparency log. Sigstore documents that this occurs even where the email is not otherwise public on the issuing service. For a private repository this publishes the identities of contributors, their organization's domain, and the timing of their activity, independent of the code itself remaining opaque.

Therefore:

- Public repositories SHOULD default to `sigstore-public` with `published: true`. The transparency log is a feature there.
- Private repositories MUST NOT default to publishing. The default configuration MUST produce a signed, verifiable receipt with `published: false`.
- Deployments requiring both privacy and transparency SHOULD use a private Fulcio/Rekor instance, recorded as `trustRoot.kind: "sigstore-private"`.

## 12. Versioning, extensibility, conformance

- Breaking changes bump the predicate type URI. The schema is versioned independently of the CLI.
- Verifiers MUST ignore predicate fields they do not recognize. Producers MUST NOT rely on a verifier preserving unknown fields.
- `predicate.provene` carries the schema version and MUST be present.
- Conformance fixtures live in `spec/conformance/`, organised by family: `changedigest/`, `glob/`, `attribution/`, `policy-eval/`, `policy-lint/`. Each case carries its input, the expected output, and the section it tests. **The fixtures, not this prose and not the reference implementation, are the definition of correct behavior.** A second implementation in another language is expected to be validated against them, and `spec/conformance/runner/run.py` — standard library only — executes the whole suite.
- Fixture `changedigest/006-utf16-trap` deserves specific attention from any JavaScript or TypeScript implementation: §4.1 sorts by UTF-8 bytes, and `Array.prototype.sort()` compares UTF-16 code units, which orders astral characters differently. An implementation can pass every other fixture and still produce wrong digests on any repository containing emoji or CJK extension characters in a path.

## 13. Security considerations

See Threat Model v0.1 for the full analysis. In summary: a `T0`/`T1` receipt is a self-attestation by the party who wants the change merged, and forged authorship is not preventable at those tiers. `T2` receipts carry verification evidence observed by a party with no stake in the merge, which is what makes forged test evidence useless against a policy that requires them. Absence of a receipt is detectable and is the intended defense against concealment.

Hook configuration is within an agent's write scope when stored in the working tree; emitters SHOULD install hook wiring in user-level configuration.

**Concealment resistance is a property of the deployed policy mode, not of this format.** A gate that activates only when a receipt is present has no false positives and no defense against a disabled hook; a gate that requires a receipt on every commit defends against a disabled hook and misfires on dependabot, web-UI edits, reverts and fork merges. Implementations MUST NOT describe receipts as preventing concealment without naming the policy mode assumed. See RFC 0002 and Threat Model v0.2, T-3.

**Hook failure.** An emitter MUST NOT block, delay, or crash an agent session under any error condition, and MUST NOT emit a partial or inferred receipt to paper over a failure: no receipt is a recoverable state, a wrong receipt is not. Failures MUST be recorded in a durable local error journal outside the repository and surfaced at session end. That journal is a local self-report and is advisory only — it cannot be signed evidence of its own failure.

## 14. Open questions

Marked for external review; none block a reference implementation.

1. **Attribution re-mapping in practice.** Whether content-anchored `hunk` granularity is achievable often enough to be worth emitting once a developer has edited agent output before committing, or whether `file` remains the common case. Resolved by measurement during dogfooding, not by argument.
2. **Receipt retention.** `.provene/` grows without bound at roughly 5 KB per session. Pruning is an explicit maintenance operation in v0.1, but pruning a receipt named by a `promotedFrom` chain leaves the chain unverifiable. Whether that is acceptable, or whether aggregates should inline enough of their constituents to survive pruning, is open.
3. **Policy grammar.** Not specified here. It is the paid surface and belongs in RFC 0002, which must also specify the three gate modes (`conditional`, `required-with-exemptions`, `enrolled`) that determine whether a deployment resists concealment at all.

## Changelog

- **0.1.3** (2026-08-30) — added the required `emitter` field. Found when the CLI reported a hardcoded version that had drifted from its package metadata: a receipt named the agent that did the work but nothing about the software that wrote the receipt, so receipts produced by a defective emitter could not be identified afterwards. Sections renumbered from 6.2.
- **0.1.2** (2026-08-30) — reference implementation. `unattributedPaths` renamed `unverifiedPaths`: the old name invited implementations to compute it from attribution rather than from verification runs, and one did. Added the normative requirement that `changes.files` reproduce the subject digest, after a tampered receipt verified clean.
- **0.1.1** (2026-08-30) — round-3 review. Content-anchored attribution replaces line ranges; `file` is the only required granularity. `verification.runs[].baseCommit` added against cross-branch replay of verification evidence. Filenames declare encoding (`.statement.json` / `.dsse.json`). Task digest salt derived from the root commit, described as a salt rather than a key, with `keySource` recorded. Hook-failure semantics and the policy-mode scoping of concealment resistance added to §13.
- **0.1.0** (2026-08-30) — initial draft.
