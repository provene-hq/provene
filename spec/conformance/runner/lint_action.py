"""An action manifest may not contain an expression outside `runs:`.

GitHub evaluates every ${{ }} in the manifest when it loads the action,
including inside an input's description, where contexts like `steps` do not
exist. One example in a description took the whole action offline.
"""
import sys, re, yaml
fail = 0
for path in sys.argv[1:]:
    lines = open(path, encoding="utf-8").read().split("\n")
    in_runs = False
    for i, line in enumerate(lines, 1):
        if re.match(r"^runs:", line):
            in_runs = True
        if not in_runs and "${{" in line:
            print(f"{path}:{i}: expression outside runs: {line.strip()}")
            fail = 1
    # every step that uses steps.<id> must reference an id that exists
    doc = yaml.safe_load(open(path, encoding="utf-8"))
    steps = (doc.get("runs") or {}).get("steps") or []
    ids = {s.get("id") for s in steps if s.get("id")}
    for ref in set(re.findall(r"steps\.([A-Za-z0-9_-]+)\.", open(path, encoding="utf-8").read())):
        if ref not in ids:
            print(f"{path}: references steps.{ref} which no step declares")
            fail = 1
print("action manifest lint: " + ("FAILED" if fail else "ok"))
sys.exit(fail)
