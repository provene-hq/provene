#!/usr/bin/env python3
"""Reference runner for the Provene conformance suite. Standard library only.

This implements the normative semantics of RFC 0001 section 4.1 and 6.3 and RFC 0002
sections 5, 7 and 12, and executes every fixture against them. It is a specification
aid, not the product: it is deliberately slow, unoptimised and readable.

    python3 runner/run.py            # run everything
    python3 runner/run.py glob       # run one family
"""
import hashlib, json, io, re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
H = lambda s: hashlib.sha256(s.encode("utf-8")).hexdigest()

# ---------------------------------------------- RFC 0001 section 4.1
def change_digest(entries, excluded):
    kept = [e for e in entries if not any(e["path"].startswith(p) for p in excluded)]
    kept.sort(key=lambda e: e["path"].encode("utf-8"))          # UTF-8 BYTES, not UTF-16 units
    lines = []
    for e in kept:
        line = f"{e['status']} {e['path']} {e['preBlob']} {e['postBlob']}"
        if e["status"] == "R":
            line += f" <-{e['prePath']}"
        lines.append(line)
    payload = "\n".join(lines)
    return payload, H(payload)

# ---------------------------------------------- RFC 0002 section 5.5 glob subset
def glob_to_regex(pat):
    out, i, n = ["^"], 0, len(pat)
    while i < n:
        c = pat[i]
        if pat.startswith("**/", i):
            out.append("(?:[^/]+/)*"); i += 3
        elif pat.startswith("/**", i) and i + 3 == n:
            out.append("/.+"); i += 3
        elif pat.startswith("**", i):
            out.append(".*"); i += 2
        elif c == "*":
            out.append("[^/]*"); i += 1
        elif c == "?":
            out.append("[^/]"); i += 1
        elif c == "[":
            j = pat.index("]", i)
            out.append("[" + pat[i+1:j] + "]"); i = j + 1
        else:
            out.append(re.escape(c)); i += 1
    return re.compile("".join(out) + "$")

def matches(pat, path):
    return glob_to_regex(pat).match(path) is not None

# ---------------------------------------------- RFC 0001 section 6.3 attribution
def locate(attributed, lines):
    want, k = attributed["digest"].split(":", 1)[1], attributed["lines"]
    hits = []
    for i in range(0, len(lines) - k + 1):
        if H("\n".join(lines[i:i+k])) == want:
            hits.append(i)
    if not hits:
        return False
    if len(hits) == 1:
        return True
    for i in hits:                                   # anchors disambiguate duplicates only
        before = H(lines[i-1]) if i > 0 else None
        after = H(lines[i+k]) if i + k < len(lines) else None
        ab, aa = attributed.get("anchorBefore"), attributed.get("anchorAfter")
        if (ab is None or (before and ab.split(":",1)[1] == before)) and \
           (aa is None or (after and aa.split(":",1)[1] == after)):
            return True
    return False

# ---------------------------------------------- RFC 0002 sections 5 and 7
def governing_rule(policy, path):
    for r in policy["rules"]:
        if any(matches(p, path) for p in r["paths"]):
            return r
    return None

def evaluate(policy, changed, receipts, pr):
    if policy["mode"] == "conditional" and not receipts:
        return "neutral", []
    findings = []
    for path in changed:
        rule = governing_rule(policy, path)
        if rule is None or rule["action"] == "allow":
            continue
        when = rule.get("when", {})
        if "agentAttributed" in when:
            attributed = any(path in r.get("agentAttributed", []) for r in receipts)
            if attributed != when["agentAttributed"]:
                continue                             # governs, but does not apply
        req = rule.get("require", {})
        cover = [r for r in receipts if path in r.get("paths", [])]
        def fail(pred): findings.append({"rule": rule["id"], "path": path, "predicate": pred})
        TIERS = ["T0", "T1", "T2", "T3"]
        if "receipt" in req:
            spec = req["receipt"]
            if not cover:
                fail("receipt")
            elif isinstance(spec, dict) and "minTier" in spec:
                if max(TIERS.index(r["tier"]) for r in cover) < TIERS.index(spec["minTier"]):
                    fail("receipt.minTier")
        if isinstance(req.get("tests"), dict):
            spec, runs = req["tests"], [run for r in cover
                                        for run in r.get("runs", [])
                                        if run["kind"] == "test" and path in run.get("covers", [])]
            if not runs:
                fail("tests")
            else:
                if "result" in spec and not any(x["result"] == spec["result"] for x in runs):
                    fail("tests.result")
                if "observedBy" in spec and not any(x["observedBy"] == spec["observedBy"] for x in runs):
                    fail("tests.observedBy")
                if spec.get("baseIsMergeBase") and not any(x.get("baseCommit") == pr["mergeBase"] for x in runs):
                    fail("tests.baseIsMergeBase")
        if req.get("humanApproval") and not pr.get("humanApproved"):
            fail("humanApproval")
    outcome = "block" if findings else "pass"
    return outcome, findings

# ---------------------------------------------- RFC 0002 section 12 lint
def lint(policy):
    codes, rules = [], policy["rules"]
    seen_ids, seen_pats, catchall = set(), [], False
    for idx, r in enumerate(rules):
        if r["id"] in seen_ids: codes.append("L4")
        seen_ids.add(r["id"])
        pats = set(r["paths"])
        # L1 conservative: identical set, a ** predecessor, or a directory-prefix ancestor
        shadowed = pats in seen_pats or catchall or any(
            all(any(p.startswith(q[:-2]) for q in prev if q.endswith("/**")) for p in pats)
            for prev in seen_pats if prev)
        if idx and shadowed: codes.append("L1")
        if catchall: codes.append("L2")
        if "**" in pats and not r.get("when"): catchall = True
        seen_pats.append(pats)
        if r["action"] == "block" and (not r.get("remedy") or not r.get("message")): codes.append("L3")
        if r["action"] == "warn" and not r.get("message"): codes.append("L3")
        t = r.get("require", {}).get("tests")
        if isinstance(t, dict) and "result" in t and t.get("observedBy") != "ci": codes.append("L6")
        for p in r["paths"]:
            if "/" not in p and "**" not in p: codes.append("L7")
    if policy.get("exemptions") and policy["mode"] != "required-with-exemptions": codes.append("L5")
    if policy.get("enrollment") and policy["mode"] != "enrolled": codes.append("L5")
    return sorted(set(codes))

# ---------------------------------------------- harness
def load(p): return json.load(io.open(p, encoding="utf-8"))
results = []
def check(name, ok, detail=""):
    results.append((name, ok, detail))

only = sys.argv[1] if len(sys.argv) > 1 else None
def want(fam): return only is None or only == fam

if want("changedigest"):
    for f in sorted((ROOT/"changedigest").glob("*.json")):
        d = load(f); payload, dig = change_digest(d["input"]["entries"], d["input"]["excludedPrefixes"])
        check(f"changedigest/{d['id']}",
              payload == d["expect"]["canonicalPayload"] and dig == d["expect"]["changeDigest"],
              "" if dig == d["expect"]["changeDigest"] else f"got {dig[:12]} want {d['expect']['changeDigest'][:12]}")

if want("glob"):
    d = load(ROOT/"glob"/"cases.json")
    for c in d["cases"]:
        got = matches(c["pattern"], c["path"])
        check(f"glob/{c['pattern']} ~ {c['path']}", got == c["match"], f"got {got}")

if want("attribution"):
    for f in sorted((ROOT/"attribution").glob("*.json")):
        d = load(f); got = locate(d["input"]["attributed"], d["input"]["fileLines"])
        check(f"attribution/{d['id']}", got == d["expect"]["located"], f"got {got}")

if want("policy-eval"):
    for f in sorted((ROOT/"policy-eval").glob("*.json")):
        d = load(f); i = d["input"]
        outcome, findings = evaluate(i["policy"], i["changedPaths"], i.get("receipts", []),
                                     i.get("pullRequest", {}))
        if "governing" in d["expect"]:
            got = {p: (governing_rule(i["policy"], p) or {}).get("id") for p in i["changedPaths"]}
            check(f"policy-eval/{d['id']}", got == d["expect"]["governing"], f"got {got}")
        else:
            ok = outcome == d["expect"]["outcome"] and \
                 [(x["rule"], x["path"], x["predicate"]) for x in findings] == \
                 [(x["rule"], x["path"], x["predicate"]) for x in d["expect"]["findings"]]
            check(f"policy-eval/{d['id']}", ok, f"got {outcome} {findings}")

if want("policy-lint"):
    for f in sorted((ROOT/"policy-lint").glob("*.json")):
        d = load(f); got = lint(d["input"]["policy"])
        check(f"policy-lint/{d['id']}", got == sorted(set(d["expect"]["codes"])), f"got {got}")

passed = sum(1 for _, ok, _ in results if ok)
for name, ok, detail in results:
    if not ok: print(f"  FAIL  {name}  {detail}")
print(f"\n{passed}/{len(results)} conformance checks passed")
sys.exit(0 if passed == len(results) else 1)
