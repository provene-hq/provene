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
