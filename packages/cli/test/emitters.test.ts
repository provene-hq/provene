/**
 * The vendor-neutral emitter interface.
 *
 * The receipt format was agent-agnostic from v0.1 -- `agent.vendor`,
 * `toolVersion` and `modelSource` have been in RFC 0001 §6.1 the whole time --
 * but the CLI could not set any of them, and `record`'s generic path could not
 * carry a command's exit code. Since a verification run is derived from that
 * exit code, an agent integrating any way other than the Claude Code adapter
 * could never produce test evidence: the one thing the format exists to carry.
 *
 * These tests are written as a third-party emitter would drive the tool, using
 * nothing an agent other than Claude Code lacks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildT0, checkStatement } from "../src/receipt.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

function scratch(): { repo: string; home: string; git: (...a: string[]) => string } {
  // The journal must live outside the repository, so these are siblings.
  const root = mkdtempSync(join(tmpdir(), "provene-emitter-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(repo); mkdirSync(home);
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("init", "-q", ".");
  git("config", "user.email", "a@b.c"); git("config", "user.name", "t");
  return { repo, home, git };
}

const run = (repo: string, home: string, argv: string[]) =>
  spawnSync(process.execPath, [CLI, ...argv],
    { cwd: repo, encoding: "utf8", env: { ...process.env, PROVENE_HOME: home } });

test("an agent that is not Claude Code can produce a complete receipt", () => {
  const { repo, home, git } = scratch();
  try {
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
    git("add", "-A"); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");

    // Everything below uses only flags. No hook payload, no Claude Code.
    run(repo, home, ["record", "--session", "g1", "--kind", "edit", "--path", "src/b.ts"]);
    run(repo, home, ["record", "--session", "g1", "--kind", "command",
                     "--argv", "npm test", "--exit", "1", "--duration-ms", "4200"]);
    writeFileSync(join(repo, "src/b.ts"), "export const b = 2;\n");

    const r = run(repo, home, ["emit", "--session", "g1", "--base", base,
      "--tool", "gemini-cli", "--vendor", "google", "--tool-version", "1.2.0",
      "--model", "gemini-2.5-pro", "--model-source", "configured"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stderr, "");

    const files = readdirSync(join(repo, ".provene"));
    assert.equal(files.length, 1);
    const pred = (JSON.parse(readFileSync(join(repo, ".provene", files[0]!), "utf8")) as any).predicate;

    assert.deepEqual(pred.agent, {
      tool: "gemini-cli", vendor: "google", toolVersion: "1.2.0",
      model: "gemini-2.5-pro", modelSource: "configured",
    });

    // The part that was impossible: an outcome, and therefore a run.
    assert.equal(pred.commands[0].exitCode, 1);
    assert.equal(pred.commands[0].durationMs, 4200);
    assert.equal(pred.verification.runs[0].result, "FAILED");
    assert.equal(pred.verification.runs[0].observedBy, "local");

    // Redaction holds on this path exactly as it does on the hook path.
    assert.equal(pred.commands[0].argv0, "npm");
    assert.match(pred.commands[0].argvDigest, /^hmac-sha256:[0-9a-f]{64}$/);
  } finally { rmSync(join(repo, ".."), { recursive: true, force: true }); }
});

test("a passing run and a failing run are distinguished on the generic path", () => {
  const { repo, home, git } = scratch();
  try {
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    git("add", "-A"); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");

    for (const [session, exit, expected] of [["ok", "0", "PASSED"], ["bad", "1", "FAILED"]] as const) {
      run(repo, home, ["record", "--session", session, "--kind", "command",
                       "--argv", "npm test", "--exit", exit]);
      const r = run(repo, home, ["emit", "--session", session, "--base", base, "--tool", "some-agent"]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const f = readdirSync(join(repo, ".provene")).sort().at(-1)!;
      const pred = (JSON.parse(readFileSync(join(repo, ".provene", f), "utf8")) as any).predicate;
      assert.equal(pred.verification.runs[0].result, expected);
      rmSync(join(repo, ".provene"), { recursive: true, force: true });
    }
  } finally { rmSync(join(repo, ".."), { recursive: true, force: true }); }
});

test("an emitter that says nothing about the model has no model recorded", () => {
  // RFC 0001 §6.1: modelSource is required alongside model, and an emitter
  // that does not know must not guess. Claude Code's payload carries no model,
  // so this is the normal case, not the edge case.
  const { repo, home, git } = scratch();
  try {
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    git("add", "-A"); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    run(repo, home, ["record", "--session", "s", "--kind", "edit", "--path", "a.ts"]);
    run(repo, home, ["emit", "--session", "s", "--base", base, "--tool", "mystery-agent"]);
    const f = readdirSync(join(repo, ".provene"))[0]!;
    const pred = (JSON.parse(readFileSync(join(repo, ".provene", f), "utf8")) as any).predicate;
    assert.equal(pred.agent.tool, "mystery-agent");
    assert.equal("model" in pred.agent, false);
    assert.equal("modelSource" in pred.agent, false);
  } finally { rmSync(join(repo, ".."), { recursive: true, force: true }); }
});

test("a non-integer exit code is refused rather than silently dropped", () => {
  const { repo, home, git } = scratch();
  try {
    writeFileSync(join(repo, "a.ts"), "x\n");
    git("add", "-A"); git("commit", "-qm", "base");
    const r = run(repo, home, ["record", "--session", "s", "--kind", "command",
                               "--argv", "npm test", "--exit", "probably-fine"]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /--exit must be an integer/);
  } finally { rmSync(join(repo, ".."), { recursive: true, force: true }); }
});

/**
 * A session is not a repository.
 *
 * The journal is keyed by session, and one agent session is free to work in
 * several projects. Every command it ran anywhere was being written into
 * whichever repository `emit` happened to run in, so a suite that passed in one
 * project could appear as verification evidence for a change in another. Found
 * in a real journal: a provene session's commands sat alongside edits to an
 * unrelated analysis directory on another drive.
 */
test("a command run in another repository is not evidence about this one", () => {
  const dir = mkdtempSync(join(tmpdir(), "provene-scope-"));
  try {
    const repo = join(dir, "here");
    const other = join(dir, "elsewhere");
    mkdirSync(repo, { recursive: true });
    mkdirSync(other, { recursive: true });
    const git = (...a: string[]): void => { execFileSync("git", a, { cwd: repo, stdio: "ignore" }); };
    git("init", "-q", ".");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(repo, "b.ts"), "export const b = 1;\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "init");
    // Both change. Only one of them was edited by the agent IN THIS REPOSITORY.
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n", "utf8");
    writeFileSync(join(repo, "b.ts"), "export const b = 2;\n", "utf8");

    const home = join(dir, "home");
    const env = { ...process.env, PROVENE_HOME: home };
    const record = (argv: string[]): void => {
      const r = spawnSync(process.execPath, [CLI, "record", "--session", "s", ...argv],
        { cwd: repo, encoding: "utf8", env });
      assert.equal(r.status, 0, r.stdout);
    };
    // Here, elsewhere, and one from an emitter that does not pass --cwd.
    record(["--kind", "command", "--argv", "npm test", "--exit", "0", "--cwd", repo]);
    record(["--kind", "command", "--argv", "pytest", "--exit", "0", "--cwd", other]);
    record(["--kind", "command", "--argv", "cargo test", "--exit", "0"]);
    // Two relative edits. `b.ts` exists in both projects and changed in this
    // one, so an unresolved relative path would silently attribute the other
    // project's edit to this repository's file -- the same six characters,
    // a different file.
    record(["--kind", "edit", "--path", "a.ts", "--cwd", repo]);
    record(["--kind", "edit", "--path", "b.ts", "--cwd", other]);

    const e = spawnSync(process.execPath, [CLI, "emit", "--session", "s", "--tool", "t"],
      { cwd: repo, encoding: "utf8", env });
    assert.equal(e.status, 0, e.stdout);
    const file = join(repo, ".provene", readdirSync(join(repo, ".provene"))[0]!);
    const pred = (JSON.parse(readFileSync(file, "utf8")) as { predicate: Record<string, unknown> }).predicate;
    const shapes = (pred["commands"] as Array<{ shape?: string }>).map((c) => c.shape);

    assert.ok(shapes.includes("npm test"), "the command run here was dropped");
    assert.ok(!shapes.includes("pytest"), "a command run elsewhere became evidence about this change");
    // Unknown is not guilty: an emitter that passes no --cwd is silent, not
    // wrong, and dropping its evidence would break every existing journal.
    assert.ok(shapes.includes("cargo test"), "a command with no recorded directory was dropped");

    const runs = pred["verification"] as { runs: Array<{ tool: string }> };
    assert.deepEqual(runs.runs.map((r) => r.tool).sort(), ["cargo", "npm"]);

    // Both files changed; only a.ts was edited here. b.ts was edited in the
    // other project and must not be claimed by this receipt.
    assert.match(e.stdout, /1 of 2 changed path\(s\) attributed/, e.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * RFC 0001 §6.4.1 — attribution is not the changeset.
 *
 * Through v0.1.9 the specification said `file` granularity "asserts only that
 * the agent touched the file" while also requiring `changes.files` to be
 * exactly the set the change digest was computed over. Both cannot hold: the
 * digest binds a changeset, which includes whatever the developer wrote in the
 * same working tree. So every receipt asserted the agent had touched files it
 * had never seen, and `check` reported a count taken from `changes.files` —
 * always equal to the number of changed paths, by construction.
 */
test("a receipt distinguishes what changed from what the agent touched", () => {
  const dir = mkdtempSync(join(tmpdir(), "provene-attrib-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]): void => { execFileSync("git", a, { cwd: repo, stdio: "ignore" }); };
    git("init", "-q", ".");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    for (const f of ["agent.ts", "human.ts"]) writeFileSync(join(repo, f), "const x = 1;\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "init");
    // Both files change. Only one of them was touched by the agent; the other
    // is the developer's own work, sitting in the same working tree.
    for (const f of ["agent.ts", "human.ts"]) writeFileSync(join(repo, f), "const x = 2;\n", "utf8");

    const env = { ...process.env, PROVENE_HOME: join(dir, "home") };
    const r0 = spawnSync(process.execPath, [CLI, "record", "--session", "s",
      "--kind", "edit", "--path", "agent.ts", "--cwd", repo], { cwd: repo, encoding: "utf8", env });
    assert.equal(r0.status, 0, r0.stdout);

    const e = spawnSync(process.execPath, [CLI, "emit", "--session", "s", "--tool", "t"],
      { cwd: repo, encoding: "utf8", env });
    assert.equal(e.status, 0, e.stdout);

    const file = join(repo, ".provene", readdirSync(join(repo, ".provene"))[0]!);
    const pred = (JSON.parse(readFileSync(file, "utf8")) as
      { predicate: { changes: { files: Array<{ path: string; attributedTo?: string }> } } }).predicate;

    // The changeset is still both files, and still binds the digest.
    assert.deepEqual(pred.changes.files.map((f) => f.path).sort(), ["agent.ts", "human.ts"]);
    // The attribution claim is only the one that was observed.
    const attributed = pred.changes.files.filter((f) => f.attributedTo === "agent").map((f) => f.path);
    assert.deepEqual(attributed, ["agent.ts"]);
    // Absent means UNOBSERVED, not human-authored: there is no field saying so.
    const human = pred.changes.files.find((f) => f.path === "human.ts")!;
    assert.equal(human.attributedTo, undefined);
    assert.equal(JSON.stringify(human).includes("human"), true);
    assert.equal(/"attributedTo"\s*:\s*"(?!agent)/.test(JSON.stringify(pred)), false);

    // And `check` counts the field rather than the changeset. It reads
    // committed state only (RFC 0001 section 9), so the work and its receipt
    // are committed first -- which is how a reviewer meets them anyway.
    git("add", "-A");
    git("commit", "-qm", "work");
    const c = spawnSync(process.execPath, [CLI, "check", "--base", "HEAD~1"],
      { cwd: repo, encoding: "utf8", env });
    assert.match(c.stdout, /2 changed path\(s\); 1 carry agent attribution/, c.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** The two rules of §6.4.1 that a verifier enforces. */
test("a receipt cannot attribute lines to an agent while disowning the file", () => {
  const base = {
    subjectName: "s@main", entries: [], parent: "0".repeat(40),
    agent: { tool: "t" }, emitter: { name: "provene", version: "0" },
    commands: [], runs: [], attributedPaths: [],
  };
  const ok = buildT0(base as never);
  const pred = ok.predicate as Record<string, any>;

  pred["changes"].granularity = "hunk";
  pred["changes"].files = [{ path: "a.ts", status: "M", preBlob: "-", postBlob: "-",
    attributed: [{ digest: "sha256:00", lines: 1 }] }];
  const spansOnly = checkStatement(ok, undefined);
  assert.ok(spansOnly.problems.some((p) => /attributed spans but is not attributedTo/.test(p)),
    spansOnly.problems.join("; "));

  pred["changes"].files = [{ path: "a.ts", status: "M", preBlob: "-", postBlob: "-",
    attributedTo: "human" }];
  const wrongValue = checkStatement(ok, undefined);
  assert.ok(wrongValue.problems.some((p) => /attributedTo must be "agent"/.test(p)),
    wrongValue.problems.join("; "));
});
