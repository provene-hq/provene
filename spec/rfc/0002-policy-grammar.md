# RFC 0002 — Provene Policy Grammar v1

| | |
|---|---|
| **Status** | Draft |
| **Version** | 1.0.1-draft |
| **File** | `.provene/policy.yml` |
| **Date** | 2026-08-30 |
| **Depends on** | RFC 0001 v0.1.1 (receipt schema), Threat Model v0.2 (gate modes, T-3, T-4) |

---

## Abstract

This document specifies the policy file that turns receipts into a merge gate. It defines how rules are matched and evaluated, what can be required, how the three gate modes behave, what the failure output must contain, and which authoring mistakes an implementation is required to reject.

The policy engine is the paid product. This grammar is nevertheless specified in the open, and the local evaluator is free, because a policy nobody can read or run locally is a policy nobody will adopt.

---

## 1. Conformance language

MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT and MAY are as in RFC 2119.

## 2. Scope

A policy answers one question: **given this pull request and the receipts attached to it, may it merge?**

A policy does not judge code, invoke a model, or express anything about correctness. Every predicate in §7 resolves against fields defined in RFC 0001, and every one of them is decidable from the receipts and the pull request alone.

## 3. File, versioning, and strictness

The policy lives at `.provene/policy.yml`, checked into the repository it governs.

```yaml
version: 1
mode: conditional
defaults:
  minTier: T2
  attributionGranularity: file
rules: []
```

`version` is REQUIRED and MUST be `1`. Future grammars increment it and MAY coexist in the same repository under different filenames.

**Unknown keys MUST cause the policy to fail to load.** This is the opposite of the rule for receipts, where verifiers must ignore unrecognized fields (RFC 0001 §12), and the asymmetry is deliberate. An unrecognized field in a *receipt* is forward compatibility. An unrecognized key in a *policy* is almost always a typo, and a security control that silently ignores the requirement you misspelled is worse than no control at all: it reports green while enforcing nothing. Implementations MUST NOT offer a lenient mode.

A policy that fails to load MUST fail the check, never skip it.

## 4. Gate modes

`mode` is REQUIRED. It determines when the rules are consulted at all, and it is the single field that decides whether a deployment resists concealment (Threat Model v0.2, T-3).

### 4.1 `conditional` (default)

Rules are evaluated only if the pull request carries at least one receipt. A pull request with no receipts produces a **neutral** check — not a passing one.

Implementations MUST report this outcome as neutral, with text stating that no receipts were found and no policy was evaluated. Reporting green would assert that a policy passed when none ran, which is the same class of falsehood the whole product exists to prevent.

Zero false positives. **No defense against concealment**: a developer who disables the hook produces a pull request this mode does not inspect.

### 4.2 `required-with-exemptions`

Every commit in the pull request MUST be covered by a receipt, unless it matches a declared exemption (§8.1).

The aggregate receipt records `exemptedCommits` and the rule that exempted each. Exemptions are therefore reviewed like any other configuration change and their growth is visible in evidence, rather than accumulating as an undocumented habit until the gate means nothing.

### 4.3 `enrolled`

A receipt is REQUIRED for every commit whose author appears on the enrollment roster (§8.2), and is not required otherwise.

This is the only mode that closes concealment: an enrolled developer who disables their hook produces receiptless commits that the gate blocks, while a first-time contributor is never punished for not having installed anything.

## 5. Evaluation model

### 5.1 Governing rule

For each path changed in the pull request, the **governing rule** is the first rule in document order whose `paths` patterns match that path. The set of paths a rule governs is its **governed set**.

A rule with an empty governed set is not evaluated.

### 5.2 First match wins — and why, given that git disagrees

`.gitignore`, `.gitattributes` and `CODEOWNERS` are all **last**-match-wins, so this specification contradicts the convention its users have in their fingers. The choice is deliberate.

Under last-match-wins, a broad pattern at the bottom of the file silently relaxes every specific rule above it, and the failure is invisible: the policy still loads, still runs, and quietly stops enforcing the thing it was written for. Under first-match-wins the equivalent mistake is a broad pattern at the *top*, which shadows everything below it — and that is statically detectable, so §12 requires implementations to reject it at lint time rather than discover it in production.

The trade is between a dangerous mistake that cannot be caught and an annoying mistake that must be. Implementations MUST document the ordering prominently, and `provene policy check --explain` MUST print the governing rule for every changed path so that the ordering is never a matter of inference.

### 5.3 Requirement scope

A requirement is either **path-scoped** — evaluated against each path in the governed set — or **pull-request-scoped**, evaluated once when the governed set is non-empty. §7 states the scope of each.

### 5.4 Outcome

Each evaluated rule yields `block`, `warn`, or `allow`. The check fails if any rule yields `block`. `allow` short-circuits: a path governed by an `allow` rule is subject to no further requirements.

**Every failing predicate MUST be reported, not the first.** An evaluator that stops at the first failure sends a developer through one CI round trip per problem, which is a reliable way to have the gate removed. This requirement exists because the conformance suite exposed its absence: fixture `policy-eval/004` produces two findings on one path, and an implementation that short-circuits passes every other fixture.

### 5.5 Glob subset (normative)

Patterns use exactly this subset. Implementations MUST NOT accept more, because a pattern that means one thing in the local CLI and another in the hosted engine is a security bug rather than an inconvenience.

| Construct | Meaning |
|---|---|
| `*` | zero or more characters, **not** crossing `/` |
| `**` | zero or more whole path segments |
| `**/` | zero or more leading segments, including none — `**/*.md` matches `README.md` |
| `?` | exactly one character, not `/` |
| `[abc]` | one character from the set |

Braces, extglob, and negation are **not** part of v1. Negation interacts badly with first-match-wins; `allow` rules cover the need.

**Patterns are anchored at the repository root.** This differs from `.gitignore`, where a pattern containing no separator matches at any depth: `*.md` here matches `README.md` and not `docs/guide.md`. Use `**/*.md` for any depth. §12 L7 warns on patterns likely to be affected by this difference, because it is the one place where a `.gitignore` reflex produces a policy that loads, runs, and quietly governs a smaller set of files than its author intended.

Matching is against full repository-relative paths using `/` separators on every platform.

## 6. Rule syntax

```yaml
rules:
  - id: crypto-needs-human
    paths: ["src/crypto/**", "src/auth/keys/**"]
    when:
      agentAttributed: true
    require:
      humanApproval: true
      receipt: { minTier: T2 }
    action: block
    message: "Agent-authored changes under src/crypto/ require a human approver."
    remedy: "Request review from @acme/security and re-run this check."
```

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Unique within the file. Appears in output; MUST be stable across edits. |
| `paths` | yes | Glob patterns, `**` supported. Matched against repository-relative paths. |
| `when` | no | Conditions gating whether the rule applies at all (§7.1). |
| `require` | yes unless `action: allow` | Predicates that must hold (§7.2–7.4). |
| `action` | yes | `block`, `warn`, or `allow`. |
| `message` | yes for `block`/`warn` | What is wrong, in the reviewer's language. |
| `remedy` | yes for `block` | What to do about it. |

`remedy` is REQUIRED on blocking rules and §12 requires the linter to enforce it. A gate that fails without naming the remedy is the reason people disable gates.

## 7. Predicates

### 7.1 `when` — applicability

| Predicate | Scope | Meaning |
|---|---|---|
| `agentAttributed: true\|false` | path | Whether a receipt attributes this path to an agent. Under `attributionGranularity: file` this means the agent touched the file; under `hunk` it means an attributed span falls in it. |
| `agent.tool: [names]` | PR | Applies only when the receipt names one of these tools. |
| `agent.model: [ids]` | PR | Applies only for these models. |
| `changedLines: { min, max }` | path | Size gate. |

### 7.2 `require` — receipt predicates

| Predicate | Scope | Meaning |
|---|---|---|
| `receipt: true` | path | Some receipt covers this path. |
| `receipt.minTier: T0\|T1\|T2\|T3` | path | Covering receipt is at least this tier. |
| `receipt.attributionGranularity: file\|hunk` | path | Fails when the emitter fell back (RFC 0001 §6.3) — makes coarse attribution visible instead of silently permitted. |

### 7.3 `require` — verification predicates

| Predicate | Scope | Meaning |
|---|---|---|
| `tests: false` | path | Explicitly not required. |
| `tests.result: PASSED\|WARNED` | path | A run of `kind: test` covering this path reached this result. |
| `tests.observedBy: ci\|local` | path | Who observed the run. **`ci` is the meaningful setting**: a locally observed run is a claim by the party who wants the merge. |
| `tests.baseIsMergeBase: true` | path | The run's `baseCommit` equals the pull request's merge base. Defeats replay of evidence gathered against a different base (Threat Model v0.2, T-11). SHOULD be set wherever `tests.result` is required. |
| `checks: [kinds]` | path | Requires runs of these kinds (`lint`, `typecheck`, `build`). |
| `unverifiedPaths.max: N` | PR | At most N changed paths uncovered by any run. |

### 7.4 `require` — review and provenance predicates

| Predicate | Scope | Meaning |
|---|---|---|
| `humanApproval: true` | PR | At least one approving review from a user who is not an author of the change. |
| `agent.allowed: [tools]` | PR | Only these agent tools may appear in receipts. |
| `model.allowed: [ids]` | PR | Only these models. |
| `trustRoot.allowed: [kinds]` | PR | Acceptable trust roots. A verifier MUST take this from policy, never from the receipt (Threat Model v0.2, T-9). |

## 8. Exemptions and enrollment

### 8.1 Exemptions (`required-with-exemptions` only)

```yaml
exemptions:
  - id: dependabot
    reason: "Automated dependency bumps carry no agent session."
    author: "dependabot[bot]"
  - id: web-ui
    reason: "Commits authored in the GitHub web editor cannot run a local hook."
    committer: "web-flow"
  - id: reverts
    reason: "Reverts reintroduce reviewed content."
    messageMatches: "^Revert \""
```

`reason` is REQUIRED, in prose, and appears in the check output. Every exemption applied MUST be recorded in the aggregate receipt with its `id`. Declaring exemptions under any other mode is a lint error (§12, L5).

### 8.2 Enrollment (`enrolled` only)

```yaml
enrollment:
  source: file
  path: .provene/enrolled.yml
```

`source: file` reads a roster from the repository. `source: api` (v1, hosted) reads it from the org. The roster is the signal that a receipt was *expected*, which is what makes absence meaningful.

## 9. Implicit rules

Two rules are always in effect and MUST be evaluated before the `rules` list.

**`policy-self-protection`** — changes to `.provene/policy.yml`, `.provene/enrolled.yml`, or hook configuration under version control require human approval. Agents have write access to the working tree (Threat Model v0.2, T-4), so a policy that does not protect itself can be edited by the thing it constrains. MAY be disabled explicitly with `implicit: { policySelfProtection: false }`; doing so MUST emit a warning in the check output.

**`receipt-integrity`** — every receipt present MUST validate against RFC 0001, its signature MUST verify where the tier implies one, and its binding MUST match the commit it is attached to. An invalid receipt always blocks, in every mode, and is never merely a warning. A forgeable receipt is worse than no receipt.

## 10. Org policy precedence (v1, hosted)

Where an organization policy exists, it is evaluated **after** the repository policy, and may only **tighten** the outcome: it can turn `allow` into `warn` or `block` and can add requirements, and it can never relax a repository rule. Repository owners cannot weaken an org control by editing a file they control.

The check output MUST attribute each finding to its source (`repo` or `org`) so that a developer can tell which document to go and argue with.

## 11. Output contract

Human-readable output MUST include, for each finding: the rule `id` and its source, the paths that triggered it, the `message`, and for blocks the `remedy`.

Machine-readable output MUST be emitted as GitHub check annotations anchored to the specific lines that triggered each finding where line information is available, and to the file otherwise. **Annotations are the product's free surface.** The value to a reviewer is not a summary of what was verified but a pointer to what was not — attention routed to where evidence is missing, on the diff, where they are already looking.

`provene policy check --explain` MUST print, for every changed path, the governing rule and the outcome, including paths that matched no rule.

## 12. Linting

`provene policy lint` MUST reject a policy exhibiting any of:

| | Condition |
|---|---|
| **L1** | A rule that can never govern a path because an earlier rule already claims all of them. General glob subsumption is not worth deciding, so this check is deliberately **conservative** and fires on three decidable cases: an identical pattern set, any rule preceded by an unconditional `**` rule, and a pattern whose directory prefix is already claimed by an earlier `dir/**`. It will not catch every shadowing, and implementations MUST NOT claim that it does. |
| **L2** | Any rule following an unconditional `paths: ["**"]` rule. |
| **L3** | A `block` rule with no `remedy`, or a `block`/`warn` rule with no `message`. |
| **L4** | Duplicate `id` values. |
| **L5** | A section that is inert under the declared mode — `exemptions` outside `required-with-exemptions`, `enrollment` outside `enrolled`. |
| **L6** | `tests.result` required without `tests.observedBy: ci` — locally observed test evidence is a self-attestation, and a policy that accepts it is not enforcing what its author believes. |
| **L7** | *Warning, not error.* A pattern containing neither `/` nor `**`, which under §5.5 matches only at the repository root. Legitimate, but `.gitignore` habits make it likely the author meant `**/`. |

L1 through L6 are errors; L7 is a warning. L6 is an error rather than a warning because it is the single most likely way to write a policy that appears to enforce test evidence and does not.

Every code above has a fixture in `spec/conformance/policy-lint/`, including a `clean` case that must produce no findings.

## 13. Examples

### 13.1 Minimum viable, for a team just starting

```yaml
version: 1
mode: conditional
defaults: { minTier: T2, attributionGranularity: file }
rules:
  - id: agent-changes-need-ci-tests
    paths: ["**"]
    when: { agentAttributed: true }
    require:
      receipt: { minTier: T2 }
      tests: { result: PASSED, observedBy: ci, baseIsMergeBase: true }
    action: block
    message: "Agent-authored changes must carry CI-observed test evidence."
    remedy: "Push a commit so CI runs the test suite, or add tests covering the changed files."
```

### 13.2 Path-scoped, the shape most teams converge on

```yaml
version: 1
mode: required-with-exemptions
defaults: { minTier: T2, attributionGranularity: hunk }

exemptions:
  - id: dependabot
    reason: "Automated dependency bumps carry no agent session."
    author: "dependabot[bot]"

rules:
  - id: docs-are-relaxed
    paths: ["docs/**", "**/*.md"]
    action: allow

  - id: crypto-needs-human
    paths: ["src/crypto/**"]
    when: { agentAttributed: true }
    require:
      humanApproval: true
      receipt: { minTier: T2, attributionGranularity: hunk }
    action: block
    message: "Agent-authored changes under src/crypto/ require a human approver."
    remedy: "Request review from @acme/security, then re-run this check."

  - id: everything-else
    paths: ["**"]
    require:
      receipt: { minTier: T2 }
      tests: { result: PASSED, observedBy: ci, baseIsMergeBase: true }
      unverifiedPaths: { max: 2 }
    action: block
    message: "Changes must carry CI-observed test evidence."
    remedy: "Add tests covering the changed files, or move them under an exempt path."
```

Note the ordering: `docs-are-relaxed` must precede `everything-else`, or the catch-all governs `docs/` first. `--explain` shows this; L1 and L2 catch the pathological forms of it.

### 13.3 Concealment-resistant

```yaml
version: 1
mode: enrolled
enrollment: { source: file, path: .provene/enrolled.yml }
defaults: { minTier: T2, attributionGranularity: hunk }
rules:
  - id: enrolled-authors-must-emit
    paths: ["**"]
    require:
      receipt: { minTier: T2 }
      tests: { result: PASSED, observedBy: ci, baseIsMergeBase: true }
    action: block
    message: "Commits from enrolled developers must carry receipts."
    remedy: "Run `provene doctor` to check your hook, then amend and push."
```

## 14. Security considerations

The policy file is inside the agent's write scope; §9 `policy-self-protection` is the mitigation, and disabling it should be treated as a material change.

`conditional` mode has no concealment defense (§4.1) and implementations MUST NOT describe a repository using it as protected against concealment.

A policy is only as trustworthy as the tier it demands. `tests.observedBy: local` accepted at `minTier: T1` is a gate that asks the party who wants the merge whether the merge is acceptable. L6 rejects the most common form of this at lint time; the rest is documentation.

## 15. Open questions

1. ~~Glob dialect.~~ **Resolved in v1.0.1** — §5.5 defines a normative subset with fixtures rather than deferring to a library.
2. **Negated patterns** (`!docs/generated/**`) interact badly with first-match-wins and are omitted from v1. Whether `allow` rules cover the need in practice is a question for dogfooding.
3. **Monorepo scale.** Per-path evaluation across a 50,000-file change is fine; per-path *reporting* is not. The output contract needs a summarization rule before the first monorepo customer, not after.

## Changelog

- **1.0.1-draft** (2026-08-30) — glob subset made normative (§5.5), closing open question 1. All failing predicates must be reported (§5.4), found by conformance fixture `policy-eval/004`. L1 narrowed to a conservative decidable check; L7 added.
- **1.0.0-draft** (2026-08-30) — initial draft, from decisions settled in review round 3.
