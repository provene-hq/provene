# Provene conformance suite

**These fixtures are the specification.** Where the prose in `spec/rfc/` and a fixture disagree, the fixture wins and the prose is a bug. Where the reference implementation and a fixture disagree, the implementation is a bug. A second implementation in another language is conformant when it passes this suite, and not before.

## Running

```
python3 spec/conformance/runner/run.py            # everything
python3 spec/conformance/runner/run.py glob       # one family
```

Standard library only, no install. `runner/run.py` implements the normative semantics directly and is written for reading, not for speed.

`runner/generate.py` regenerates the computed fixtures — change digests, span digests. Re-running it must reproduce the committed files byte for byte; if it does not, either the generator or the spec changed, and the diff is the thing to review.

## Families

| Family | Tests | Spec |
|---|---|---|
| `changedigest/` | canonical payload construction and SHA-256 over blob identities | RFC 0001 §4.1 |
| `glob/` | the normative pattern subset | RFC 0002 §5.5 |
| `attribution/` | content-anchored span location | RFC 0001 §6.3 |
| `policy-eval/` | governing rule selection, modes, predicates | RFC 0002 §5, §7 |
| `policy-lint/` | L1–L7 | RFC 0002 §12 |

## Fixtures worth reading before implementing

- **`changedigest/003-exclusion`** — adding the receipt file must not change the digest the receipt is named after. This is how the self-reference problem is resolved, and the fixture asserts the digest equals `001-basic` exactly.
- **`changedigest/006-utf16-trap`** — sorting is by UTF-8 bytes. JavaScript's default sort compares UTF-16 code units and orders these two paths the other way. An implementation can pass everything else and still be wrong on any repository with emoji or CJK extension characters in a path.
- **`changedigest/007-empty`** — a commit that only adds receipts is legal and digests the empty string. Do not special-case it into an error.
- **`attribution/003-edit-inside`** — an edit inside an attributed span voids the attribution. This is correct: the text is no longer what the agent produced, and "approximately attributed" is not a thing this format offers.
- **`policy-eval/003-conditional-neutral`** — `conditional` mode with no receipts is **neutral**, never pass. An implementation that reports green here asserts that a policy passed when none ran.
- **`policy-eval/006-replayed-evidence`** — genuine, valid, CI-signed test evidence that must still be rejected, because it was gathered against a different base. Nothing is wrong with the signature.
- **`policy-eval/008-when-not-met`** — a rule whose `when` is unmet still *governs* the path; it does not fall through to a later rule. Governance is decided by `paths` alone, applicability by `when`. This is the most likely place for two implementations to diverge silently.
- **`policy-lint/L1-shadowed-by-prefix`** — L1 is deliberately conservative. It catches the three decidable cases and no more, and the spec says so rather than implying completeness.

## Provenance of a correction

`policy-eval/004` originally expected a single finding. Running the suite produced two, which was correct behaviour the RFC had not specified. RFC 0002 §5.4 now requires every failing predicate to be reported, because an evaluator that stops at the first failure sends a developer through one CI round trip per problem. The suite found an underspecification in the prose, which is what it is for.
