"""Does this repository's own tooling do what it says?

Four rounds of review found defects of one shape: the project is careful about
input it receives and credulous about output it produces. It validated hook
payloads and `gh` exit codes, and assumed its own npm script ran the tests it
claimed, its own action manifest was loadable, and its own conformance runners
needed no install.

Each check below corresponds to a defect that actually shipped:

  npm test              ran 1 test file of 9, so a contributor's green suite
                        had never loaded the git, coverage, hook, journal,
                        verifier-fault or claims tests.
  lint_action.py        imported PyYAML while sitting in a directory whose
                        README promises standard library only.
  action.yml            carried an expression in an input description, which
                        stopped the whole action loading.
  the documented flow   was never executed end to end by anything in CI.

Standard library only, and it runs from the repository root.
"""
import ast, json, re, subprocess, sys, tempfile, os, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{'' if ok else '  -- ' + detail}")
    if not ok:
        FAILURES.append(f"{name}: {detail}")


def run(cmd: list[str], cwd: pathlib.Path | None = None, **kw):
    return subprocess.run(cmd, cwd=str(cwd or ROOT), capture_output=True, text=True, **kw)


def npm_test_runs_the_whole_suite() -> None:
    """`npm test` at the root must run every suite, not a convenient subset."""
    r = run(["npm", "test"], shell=(os.name == "nt"))
    counted = re.search(r"^# tests (\d+)$", r.stdout, re.M)
    files = sorted((ROOT / "packages" / "cli" / "test").glob("*.test.ts"))
    check("npm test reports a test count", counted is not None, r.stdout[-400:])
    if counted is None:
        return
    total = int(counted.group(1))
    # A floor tied to the number of suites, not a magic number that rots: every
    # suite here has more than five tests, so anything below this means files
    # are being skipped rather than that someone deleted a case.
    floor = 5 * len(files)
    check(f"npm test runs the whole suite ({total} tests, {len(files)} files)",
          total >= floor, f"{total} tests is below {floor}; a suite is not being loaded")


def conformance_runners_need_no_install() -> None:
    """`spec/conformance/README.md` promises standard library only."""
    allowed_third_party = {"validate_receipts.py": {"jsonschema"}}
    stdlib_ok = True
    for path in sorted((ROOT / "spec" / "conformance" / "runner").glob("*.py")):
        # Parsed, not pattern-matched. A regex over import lines read only the
        # first module on each, so `import sys, re, yaml` looked like `sys` --
        # and the check written to catch a third-party import missed the exact
        # third-party import that prompted it. Found by mutating this file.
        imported = set()
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                imported.add(node.module.split(".")[0])
        third_party = imported - set(sys.stdlib_module_names) - {"__future__"}
        permitted = allowed_third_party.get(path.name, set())
        unexpected = third_party - permitted
        if unexpected:
            stdlib_ok = False
            check(f"{path.name} imports only the standard library", False,
                  f"imports {', '.join(sorted(unexpected))}")
    if stdlib_ok:
        check("conformance runners import only the standard library", True)


def the_action_manifest_loads() -> None:
    r = run([sys.executable, "spec/conformance/runner/lint_action.py", "action.yml"])
    check("action manifest lint passes", r.returncode == 0, r.stdout.strip())


def the_documented_flow_works() -> None:
    """init → record → emit → verify, exactly as the README describes it."""
    cli = str(ROOT / "packages" / "cli" / "src" / "cli.ts")
    with tempfile.TemporaryDirectory() as work:
        repo, home = pathlib.Path(work) / "repo", pathlib.Path(work) / "home"
        repo.mkdir(); home.mkdir()
        env = {**os.environ, "PROVENE_HOME": str(home)}
        git = lambda *a: subprocess.run(["git", *a], cwd=str(repo), capture_output=True, text=True)
        git("init", "-q", ".")
        git("config", "user.email", "a@b.c"); git("config", "user.name", "t")
        (repo / "a.ts").write_text("export const a = 1;\n", encoding="utf-8")
        git("add", "-A"); git("commit", "-qm", "base")
        base = git("rev-parse", "HEAD").stdout.strip()
        (repo / "a.ts").write_text("export const a = 2;\n", encoding="utf-8")

        payload = json.dumps({"session_id": "selftest", "cwd": str(repo),
                              "hook_event_name": "PostToolUse", "tool_name": "Edit",
                              "tool_input": {"file_path": "a.ts"}})
        rec = subprocess.run(["node", cli, "record", "--stdin"], cwd=str(repo), env=env,
                             input=payload, capture_output=True, text=True)
        check("record accepts a hook payload", rec.returncode == 0, rec.stderr[-300:])

        emit = subprocess.run(["node", cli, "emit", "--session", "selftest", "--base", base],
                              cwd=str(repo), env=env, capture_output=True, text=True)
        written = re.search(r"wrote (\S+)", emit.stdout)
        check("emit writes a receipt", written is not None, emit.stdout + emit.stderr[-300:])
        if written is None:
            return
        receipt = repo / written.group(1)
        check("the receipt exists on disk", receipt.exists(), str(receipt))

        ver = subprocess.run(["node", cli, "verify", str(receipt)],
                             cwd=str(repo), env=env, capture_output=True, text=True)
        check("verify accepts what emit produced", ver.returncode == 0, ver.stdout)
        check("an unsigned receipt is reported as T0", "T0" in ver.stdout, ver.stdout)


def main() -> int:
    print("Does this repository's own tooling do what it says?\n")
    for step in (npm_test_runs_the_whole_suite, conformance_runners_need_no_install,
                 the_action_manifest_loads, the_documented_flow_works):
        step()
    print()
    if FAILURES:
        print(f"self-test: {len(FAILURES)} failure(s)")
        return 1
    print("self-test: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
