#!/usr/bin/env python3
"""Validates real emitted receipts against the published JSON Schema.

The schema existed from the first day and nothing ever checked emitter output
against it, so two defects shipped that the schema itself forbade: object ids
abbreviated to seven characters, and an empty argv0 where minLength is 1. A
specification nothing executes is a document, not a constraint.

Deliberately uses the reference jsonschema implementation rather than a
hand-written checker: writing our own validator to test our own schema would
reproduce the exact failure mode this harness exists to catch.

    python3 validate_receipts.py <dir> [<dir> ...]
"""
import json, pathlib, sys

try:
    from jsonschema import Draft202012Validator
except ImportError:
    print("validate_receipts: jsonschema not installed; run `pip install jsonschema`", file=sys.stderr)
    sys.exit(2)

ROOT = pathlib.Path(__file__).resolve().parents[2]

# One schema per predicate type. A document is validated against the schema for
# the type it declares -- never against whichever schema happens to be loaded,
# which would report an aggregate receipt as a malformed code-change receipt.
SCHEMAS = {
    "https://provene.dev/attestation/code-change/v0.1":
        ROOT / "schema" / "provene-receipt-v0.1.schema.json",
    "https://provene.dev/attestation/code-change-aggregate/v0.1":
        ROOT / "schema" / "provene-aggregate-v0.1.schema.json",
}


def statement_of(doc):
    """A receipt is a bare Statement or a DSSE envelope; both carry a Statement."""
    if "predicate" in doc:
        return doc
    inner = doc.get("_statement_for_readability_only")
    return inner if isinstance(inner, dict) else None


def main(dirs):
    validators = {}
    for ptype, path in SCHEMAS.items():
        schema = json.loads(path.read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(schema)
        validators[ptype] = Draft202012Validator(schema)

    files = [p for d in dirs for p in sorted(pathlib.Path(d).rglob("*.json"))]
    if not files:
        print("validate_receipts: no receipts found; nothing was checked", file=sys.stderr)
        return 2

    failures, unschemad, checked = 0, [], 0
    for path in files:
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"  INVALID JSON  {path}: {e}")
            failures += 1
            continue
        statement = statement_of(doc)
        if statement is None:
            print(f"  NOT A RECEIPT {path}")
            failures += 1
            continue

        ptype = statement.get("predicateType", "")
        validator = validators.get(ptype)
        if validator is None:
            # Reported, never skipped silently: a predicate type with no schema
            # is a specification gap, and the point of this harness is that gaps
            # stay visible rather than passing by default.
            unschemad.append((path.name, ptype))
            continue

        checked += 1
        errors = sorted(validator.iter_errors(statement["predicate"]), key=lambda e: list(e.path))
        if errors:
            failures += 1
            print(f"  FAIL {path.name}")
            for e in errors[:5]:
                print(f"       at {list(e.path) or '<root>'}: {e.message[:150]}")

    print(f"\n{checked - failures}/{checked} receipt(s) satisfy the schema for their predicate type")
    for name, ptype in unschemad:
        print(f"  NO SCHEMA for {ptype or '(missing predicateType)'} — {name}")
    if unschemad:
        print(f"  {len(unschemad)} document(s) could not be checked because no schema exists for their type.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or [str(ROOT / "examples")]))
