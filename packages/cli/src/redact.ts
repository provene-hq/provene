/**
 * RFC 0001 sections 6.4 and 10 — the redaction contract.
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

export function redactCommand(
  argv: readonly string[],
  salt: Buffer,
  opts: { exitCode?: number; durationMs?: number; observedBy: "local" | "ci";
          allowlist?: readonly string[] },
): RedactedCommand {
  const full = argv.join(" ");
  const allowlist = opts.allowlist ?? DEFAULT_ALLOWLIST;
  const shape = allowlist.find((a) => a === full);
  return {
    argv0: argv[0] ?? "",
    ...(shape !== undefined ? { shape } : {}),
    argvDigest: keyedDigest(salt, full),
    ...(opts.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
    ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
    observedBy: opts.observedBy,
  };
}
