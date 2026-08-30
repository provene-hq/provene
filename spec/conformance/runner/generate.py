#!/usr/bin/env python3
"""Generates the Provene conformance fixtures with real, computed expected values.

Stdlib only. Re-running this MUST reproduce the committed fixtures byte for byte;
if it does not, either the generator or the spec changed and the diff is the review.
"""
import hashlib, json, io, os, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]

def sha256_hex(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()

# ---------------------------------------------------------------- change digest
def change_line(e):
    line = f"{e['status']} {e['path']} {e['preBlob']} {e['postBlob']}"
    if e["status"] == "R":
        line += f" <-{e['prePath']}"
    return line

def change_digest(entries, excluded=(".provene/",)):
    kept = [e for e in entries if not any(e["path"].startswith(p) for p in excluded)]
    # sort by path as RAW UTF-8 BYTES, ascending
    kept.sort(key=lambda e: e["path"].encode("utf-8"))
    payload = "\n".join(change_line(e) for e in kept)
    return payload, sha256_hex(payload.encode("utf-8"))

def cd_case(cid, desc, entries, note=None):
    payload, digest = change_digest(entries)
    doc = {
        "id": cid, "rfc": "0001", "section": "4.1",
        "description": desc,
        "input": {"entries": entries, "excludedPrefixes": [".provene/"]},
        "expect": {
            "canonicalPayload": payload,
            "canonicalPayloadUtf8Length": len(payload.encode("utf-8")),
            "changeDigest": digest,
        },
    }
    if note:
        doc["note"] = note
    write(ROOT / "changedigest" / f"{cid}.json", doc)

def write(path, doc):
    path.parent.mkdir(parents=True, exist_ok=True)
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")

B = lambda n: f"{n:040x}"

cd_case("001-basic", "One modification and one addition.", [
    {"status": "M", "path": "src/auth/session.ts", "preBlob": B(0x3f1c), "postBlob": B(0xa07e)},
    {"status": "A", "path": "src/auth/session.test.ts", "preBlob": "-", "postBlob": B(0x17dd)},
])

cd_case("002-ordering", "Entries supplied out of order must sort by path before digesting.", [
    {"status": "M", "path": "z.ts", "preBlob": B(3), "postBlob": B(4)},
    {"status": "M", "path": "a.ts", "preBlob": B(1), "postBlob": B(2)},
    {"status": "M", "path": "m/n.ts", "preBlob": B(5), "postBlob": B(6)},
], note="Input order must not affect the digest.")

cd_case("003-exclusion", "Receipt files under .provene/ are excluded; the digest equals 001-basic.", [
    {"status": "M", "path": "src/auth/session.ts", "preBlob": B(0x3f1c), "postBlob": B(0xa07e)},
    {"status": "A", "path": "src/auth/session.test.ts", "preBlob": "-", "postBlob": B(0x17dd)},
    {"status": "A", "path": ".provene/b71f4c9a.statement.json", "preBlob": "-", "postBlob": B(0xdead)},
], note="Self-reference is resolved by exclusion: adding the receipt must not change the digest it is named after.")

cd_case("004-rename", "Renames append the pre-image path as a trailing field.", [
    {"status": "R", "path": "src/auth/session.ts", "prePath": "src/session.ts",
     "preBlob": B(0x3f1c), "postBlob": B(0x3f1c)},
])

cd_case("005-delete", "Deletions carry '-' as the post blob.", [
    {"status": "D", "path": "src/legacy/old.ts", "preBlob": B(0x9911), "postBlob": "-"},
])

cd_case("006-utf16-trap",
  "Sorting is by UTF-8 bytes, which equals code point order. A naive JavaScript "
  "Array.prototype.sort() compares UTF-16 code units and orders these two paths the "
  "OPPOSITE way, because astral characters are surrogate pairs beginning 0xD800-0xDBFF, "
  "which compare below U+FF21.",
  [
    {"status": "A", "path": "docs/Ａ.md", "preBlob": "-", "postBlob": B(0x1111)},
    {"status": "A", "path": "docs/\U00020000.md", "preBlob": "-", "postBlob": B(0x2222)},
  ],
  note="Correct order: U+FF21 (65313) before U+20000 (131072). UTF-16 code-unit order "
       "yields the reverse. An implementation that passes every other fixture and fails "
       "this one has a real bug that will surface on a repository containing emoji or "
       "CJK extension characters in a path.")

cd_case("007-empty", "A change set that is entirely excluded digests the empty string.", [
    {"status": "A", "path": ".provene/aaaa.statement.json", "preBlob": "-", "postBlob": B(1)},
], note="The empty payload is the SHA-256 of zero bytes. An implementation must not "
        "special-case this to an error: a commit that only adds receipts is legal.")

# ------------------------------------------------------------------------ glob
GLOB_CASES = [
    ("**",                 "a.ts",                  True),
    ("**",                 "src/deep/a.ts",         True),
    ("*.md",               "README.md",             True),
    ("*.md",               "docs/guide.md",         False),
    ("**/*.md",            "README.md",             True),
    ("**/*.md",            "docs/guide.md",         True),
    ("**/*.md",            "docs/a/b/guide.md",     True),
    ("src/**",             "src/a.ts",              True),
    ("src/**",             "src/a/b/c.ts",          True),
    ("src/**",             "src",                   False),
    ("src/**",             "srcx/a.ts",             False),
    ("src/*.ts",           "src/a.ts",              True),
    ("src/*.ts",           "src/a/b.ts",            False),
    ("src/crypto/**",      "src/crypto/aes.ts",     True),
    ("src/crypto/**",      "src/cryptox/aes.ts",    False),
    ("src/?.ts",           "src/a.ts",              True),
    ("src/?.ts",           "src/ab.ts",             False),
    ("src/[abc].ts",       "src/b.ts",              True),
    ("src/[abc].ts",       "src/d.ts",              False),
    ("a/**/b.ts",          "a/b.ts",                True),
    ("a/**/b.ts",          "a/x/y/b.ts",            True),
]
write(ROOT / "glob" / "cases.json", {
    "id": "glob-subset", "rfc": "0002", "section": "5.5",
    "description": "The normative glob subset. Patterns are anchored at the repository "
                   "root, unlike .gitignore, where a pattern containing no separator "
                   "matches at any depth. Use **/ for any depth.",
    "cases": [{"pattern": p, "path": s, "match": m} for p, s, m in GLOB_CASES],
})

# ----------------------------------------------------------------- attribution
def line_digests(text):
    return [sha256_hex(l.encode("utf-8")) for l in text.split("\n")]

def make_attr_case(cid, desc, span_lines, pre_context, post_context, mutate, expect_located, note=None):
    span_text = "\n".join(span_lines)
    attributed = {
        "digest": "sha256:" + sha256_hex(span_text.encode("utf-8")),
        "lines": len(span_lines),
        "anchorBefore": "sha256:" + sha256_hex(pre_context.encode("utf-8")) if pre_context is not None else None,
        "anchorAfter": "sha256:" + sha256_hex(post_context.encode("utf-8")) if post_context is not None else None,
    }
    attributed = {k: v for k, v in attributed.items() if v is not None}
    original = ([pre_context] if pre_context is not None else []) + span_lines + \
               ([post_context] if post_context is not None else [])
    write(ROOT / "attribution" / f"{cid}.json", {
        "id": cid, "rfc": "0001", "section": "6.3",
        "description": desc,
        "input": {"attributed": attributed, "fileLines": mutate(list(original))},
        "expect": {"located": expect_located},
        **({"note": note} if note else {}),
    })

make_attr_case("001-exact", "The span is present unchanged.",
    ["export function verify(t) {", "  return check(t);", "}"],
    "// auth helpers", "// end", lambda ls: ls, True)

make_attr_case("002-insert-above",
    "Twelve lines inserted above the span. Positional ranges would break; content anchoring does not.",
    ["export function verify(t) {", "  return check(t);", "}"],
    "// auth helpers", "// end",
    lambda ls: [f"// header {i}" for i in range(12)] + ls, True,
    note="This is the case that motivated replacing line ranges in RFC 0001 v0.1.1.")

make_attr_case("003-edit-inside",
    "A line inside the span was edited. The span MUST NOT be located.",
    ["export function verify(t) {", "  return check(t);", "}"],
    "// auth helpers", "// end",
    lambda ls: [l.replace("check(t)", "check(t, {legacy: true})") for l in ls], False,
    note="Correct behaviour: the text is no longer what the agent produced, so the "
         "attribution is void rather than approximately true.")

make_attr_case("004-anchor-changed",
    "The span is intact but the line before it changed. The span is still located; "
    "anchors disambiguate duplicates, they are not part of the claim.",
    ["export function verify(t) {", "  return check(t);", "}"],
    "// auth helpers", "// end",
    lambda ls: ["// AUTH HELPERS (renamed)"] + ls[1:], True)

make_attr_case("005-duplicate-span",
    "The same span text appears twice; anchors select the attributed occurrence.",
    ["  return check(t);"],
    "function a() {", "}",
    lambda ls: ls + ["function b() {", "  return check(t);", "}"], True)

print("fixtures generated")
