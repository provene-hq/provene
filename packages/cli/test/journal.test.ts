/**
 * The journal's filename boundary.
 *
 * A session id arrives inside a hook payload — JSON this process did not write
 * — and was interpolated straight into a path. The journal holds UNREDACTED
 * commands, so the consequence was writing an agent's raw argv, credentials
 * included, anywhere on the filesystem the process could reach.
 *
 * The second test is the one that matters least in theory and most in
 * practice: the sanitised name has to be a filename on the platform the tool
 * runs on. The first attempt at this fix used a colon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { safeSessionId, journalPath, append, read, journalDir } from "../src/journal.ts";

const TRAVERSAL = [
  "../../../pwned",
  "../evil",
  "..",
  ".",
  "a/b",
  "a\\b",
  "/etc/passwd",
  "C:\\Windows\\System32\\evil",
  "\\\\server\\share\\evil",
  "foo\u0000bar",
  "sess/../../../../../../tmp/x",
  "x".repeat(500),
];

test("no session id can name a file outside the journal's sessions directory", () => {
  const home = mkdtempSync(join(tmpdir(), "provene-journal-"));
  process.env["PROVENE_HOME"] = home;
  try {
    const sessions = resolve(join(journalDir(), "sessions"));
    for (const id of [...TRAVERSAL, "ordinary-123"]) {
      const p = resolve(journalPath(id));
      assert.ok(p.startsWith(sessions + sep),
        `${JSON.stringify(id)} escaped the journal directory: ${p}`);
      // and lands directly in it, not in a subdirectory it invented
      assert.equal(p.slice(sessions.length + 1).includes(sep), false,
        `${JSON.stringify(id)} created a nested path: ${p}`);
    }
  } finally { delete process.env["PROVENE_HOME"]; }
});

test("a sanitised id is a legal filename on every platform, Windows included", () => {
  // < > : " | ? * and the separators are illegal on Windows; a colon in
  // particular names an NTFS alternate data stream rather than failing loudly.
  for (const id of TRAVERSAL) {
    const safe = safeSessionId(id);
    assert.doesNotMatch(safe, /[<>:"|?*\\/\u0000-\u001f]/, `illegal in a Windows filename: ${safe}`);
    assert.ok(safe.length > 0 && safe.length <= 128);
  }
});

test("a legitimate id is left exactly as it is", () => {
  for (const id of ["abc123", "a-b_c.d", "01234567-89ab-cdef-0123-456789abcdef"]) {
    assert.equal(safeSessionId(id), id);
  }
});

test("the same rejected id always lands in the same journal, so a session stays whole", () => {
  assert.equal(safeSessionId("../../../pwned"), safeSessionId("../../../pwned"));
  assert.notEqual(safeSessionId("../../../pwned"), safeSessionId("../../../other"));
});

test("a rejected id still records, rather than costing the developer their session", () => {
  const home = mkdtempSync(join(tmpdir(), "provene-journal-"));
  process.env["PROVENE_HOME"] = home;
  try {
    append("../../../pwned", { at: new Date().toISOString(), kind: "note" });
    const written = readdirSync(join(home, "sessions"));
    assert.equal(written.length, 1);
    assert.equal(read("../../../pwned").length, 1);
    assert.equal(existsSync(resolve(home, "..", "..", "..", "pwned.jsonl")), false);
  } finally { delete process.env["PROVENE_HOME"]; }
});
