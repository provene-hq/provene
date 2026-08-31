"""An action manifest may hold no expression outside `runs:`.

GitHub evaluates every ${{ }} in a manifest when it loads the action, including
inside an input's `description`, where contexts like `steps` do not exist yet.
One worked example in a description took the whole action offline: the run
failed with "Unrecognized named-value: 'steps'" before a single step executed.

Standard library only, like everything else in this directory. The first
version of this file imported PyYAML, so the check written to keep the action
loadable could not itself run without an install -- which is the same shape of
mistake it exists to catch, in the tool that catches it.
"""
import sys, re

# Enough of the manifest's shape without a YAML parser: `runs:` at column zero
# ends the top-level input and metadata section, and a step's id is the only
# thing we need from the steps themselves.
TOP_LEVEL_RUNS = re.compile(r"^runs:")
STEP_ID = re.compile(r"^\s+id:\s*['\"]?([A-Za-z0-9_-]+)['\"]?\s*$")
STEP_REF = re.compile(r"steps\.([A-Za-z0-9_-]+)\.")
EXPRESSION = re.compile(r"\$\{\{")


def lint(path: str) -> list[str]:
    problems: list[str] = []
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().split("\n")

    in_runs = False
    declared: set[str] = set()
    for number, line in enumerate(lines, 1):
        if TOP_LEVEL_RUNS.match(line):
            in_runs = True
        if not in_runs and EXPRESSION.search(line):
            problems.append(
                f"{path}:{number}: expression outside runs:, which GitHub evaluates "
                f"at manifest load time -- {line.strip()}"
            )
        if in_runs:
            found = STEP_ID.match(line)
            if found:
                declared.add(found.group(1))

    for referenced in sorted(set(STEP_REF.findall("\n".join(lines)))):
        if referenced not in declared:
            problems.append(f"{path}: references steps.{referenced}, which no step declares")
    return problems


def main(argv: list[str]) -> int:
    problems = [p for path in argv for p in lint(path)]
    for p in problems:
        print(p)
    print("action manifest lint: " + ("FAILED" if problems else "ok"))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
