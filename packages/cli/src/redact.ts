/**
 * RFC 0001 sections 6.5 and 10 — the redaction contract.
 *
 * Allowlist, never denylist. Argument vectors carry credentials routinely
 * (`curl -H "Authorization: Bearer $TOKEN"`), and a denylist in a trust product
 * fails silently and permanently.
 */
import { createHash, createHmac } from "node:crypto";

/** Command forms whose full text is safe to record. Everything else keeps argv0 only. */
export const DEFAULT_ALLOWLIST: readonly string[] = [
  "npm test", "npm run test", "npm run build", "npm run lint", "npm ci",
  "pnpm test", "pnpm build", "pnpm lint",
  "yarn test", "yarn build",
  "pytest", "python -m pytest",
  "cargo test", "cargo build", "cargo clippy",
  "go test ./...", "go build ./...",
  "tsc --noEmit", "npx tsc --noEmit",
  "make test", "make lint", "make build",
];
export const ALLOWLIST_ID = "provene-default-v1";

/**
 * Allowlist entries that are test invocations. Only these become verification
 * runs: we know exactly what they mean, and guessing from a command's shape is
 * how a build script gets recorded as a passing test suite.
 */
export const TEST_SHAPES = new Set<string>([
  "npm test", "npm run test", "pnpm test", "yarn test",
  "pytest", "python -m pytest",
  "cargo test", "go test ./...", "make test",
]);

export function deriveSalt(rootCommit: string): Buffer {
  return createHash("sha256").update(`provene-salt-v1:${rootCommit}`, "utf8").digest();
}

export function keyedDigest(salt: Buffer, text: string): string {
  return `hmac-sha256:${createHmac("sha256", salt).update(text, "utf8").digest("hex")}`;
}

export interface RedactedCommand {
  readonly argv0: string;
  readonly shape?: string;
  readonly argvDigest: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly observedBy: "local" | "ci";
}

/**
 * `AUTH_TOKEN=ghp_xxx npm test` is one command with a leading assignment, and a
 * naive split puts the secret in argv[0] -- which is the one field recorded in
 * clear. POSIX simple-command syntax allows any number of these before the
 * command name.
 */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function commandName(argv: readonly string[]): string {
  for (const word of argv) {
    if (!ASSIGNMENT.test(word)) return word;
  }
  return ""; // the whole command was assignments; nothing safe to name
}

export function redactCommand(
  argv: readonly string[],
  salt: Buffer,
  opts: { exitCode?: number; durationMs?: number; observedBy: "local" | "ci";
          allowlist?: readonly string[] },
): RedactedCommand {
  const full = argv.join(" ");
  const allowlist = opts.allowlist ?? DEFAULT_ALLOWLIST;
  const shape = allowlist.find((a) => a === full);
  const argv0 = commandName(argv);
  return {
    // Belt and braces: nothing containing "=" is ever recorded in clear, even
    // if commandName is defeated by a shape POSIX permits and we did not model.
    argv0: argv0.includes("=") ? "" : argv0,
    // NOTE: an empty argv0 means there was no command to name (the line was
    // only assignments). Such entries are dropped by the caller rather than
    // recorded -- the schema requires a non-empty argv0, and "a command with
    // no name" is not a thing worth putting in a receipt.
    ...(shape !== undefined ? { shape } : {}),
    argvDigest: keyedDigest(salt, full),
    ...(opts.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
    ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
    observedBy: opts.observedBy,
  };
}
