/**
 * Emits receipts across the shapes a real repository produces, so that the
 * schema can be checked against emitter OUTPUT rather than against hand-written
 * examples that were written to pass.
 *
 * Covers: additions, modifications, deletions, renames, copies, type changes to
 * a symlink, untracked files, unicode and spaced paths, a command that is only
 * environment assignments, and a passing and a failing test run.
 *
 *   node scripts/emit-samples.ts <output-dir>
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, unlinkSync, copyFileSync, readdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outDir = process.argv[2] ?? join(process.cwd(), "sample-receipts");
mkdirSync(outDir, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), "provene-samples-"));
const journalHome = mkdtempSync(join(tmpdir(), "provene-journal-"));
const git = (...a: string[]): string =>
  execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const cli = (...a: string[]): string =>
  execFileSync(process.execPath, [join(import.meta.dirname, "..", "src", "cli.ts"), ...a],
    { cwd: dir, encoding: "utf8", env: { ...process.env, PROVENE_HOME: journalHome } });

/** Outside the repository, always: the journal holds unredacted commands. */
const hook = (payload: Record<string, unknown>): void => {
  execFileSync(process.execPath, [join(import.meta.dirname, "..", "src", "cli.ts"), "record", "--stdin"],
    { cwd: dir, encoding: "utf8", input: JSON.stringify(payload),
      env: { ...process.env, PROVENE_HOME: journalHome } });
};

try {
  git("init", "-q", ".");
  git("config", "user.email", "a@b.c");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "true");

  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/keep.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src/rename-me.ts"), "export const b = 2;\n");
  writeFileSync(join(dir, "src/delete-me.ts"), "export const c = 3;\n");
  writeFileSync(join(dir, "src/become-link.ts"), "export const d = 4;\n");
  git("add", "-A"); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").trim();

  // every status letter git can produce, plus awkward paths
  writeFileSync(join(dir, "src/keep.ts"), "export const a = 11;\r\n");          // M, CRLF
  git("mv", "src/rename-me.ts", "src/renamed.ts");                              // R
  git("rm", "-q", "src/delete-me.ts");                                          // D
  copyFileSync(join(dir, "src/keep.ts"), join(dir, "src/copied.ts"));           // C candidate
  unlinkSync(join(dir, "src/become-link.ts"));
  symlinkSync("keep.ts", join(dir, "src/become-link.ts"));                       // T
  writeFileSync(join(dir, "src/with space.ts"), "export const e = 5;\n");        // untracked, space
  writeFileSync(join(dir, "src/café-日本-🙂.ts"), "export const f = 6;\n");      // untracked, unicode
  git("add", "-A");

  // Driven through the real hook interface, so the samples exercise the code
  // path that actually runs in a session -- including how a run's outcome is
  // derived from the event name.
  const session = "samples";
  const ev = (name: string, tool: string, input: Record<string, unknown>) =>
    ({ session_id: session, cwd: dir, hook_event_name: name, tool_name: tool, tool_input: input });
  hook(ev("PostToolUse", "Edit", { file_path: "src/keep.ts" }));
  hook(ev("PostToolUse", "Bash", { command: "npm test" }));                       // -> PASSED
  hook(ev("PostToolUseFailure", "Bash", { command: "pytest" }));                  // -> FAILED
  hook(ev("PostToolUse", "Bash", { command: "AUTH_TOKEN=ghp_secret npm test" }));  // secret must not survive
  hook(ev("PostToolUse", "Bash", { command: "A=1" }));                            // no command to name
  cli("emit", "--session", session, "--base", base, "--tool", "claude-code",
      "--model", "claude-opus-5", "--subject", "samples@main",
      "--task", "https://example.invalid/issues/1");

  const produced = readdirSync(join(dir, ".provene"));
  for (const f of produced) cpSync(join(dir, ".provene", f), join(outDir, f));
  console.log(`emitted ${produced.length} receipt(s) covering ` +
              `A/M/D/R/C/T, CRLF, spaces, unicode and assignment-only commands -> ${outDir}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(journalHome, { recursive: true, force: true });
}
