/**
 * Runs the spec conformance suite against this implementation.
 *
 * The fixtures in spec/conformance are the specification. This file does not
 * assert anything of its own; it asserts what they say.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalPayload, changeDigest, type ChangeEntry } from "../src/changedigest.ts";
import { matches } from "../src/glob.ts";
import { locateSpan, type AttributedSpan } from "../src/attribution.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE = join(HERE, "..", "..", "..", "spec", "conformance");

const load = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
const family = (name: string): string[] =>
  readdirSync(join(SUITE, name)).filter((f) => f.endsWith(".json")).sort();

test("changedigest", async (t) => {
  for (const f of family("changedigest")) {
    const fx = load(join(SUITE, "changedigest", f));
    await t.test(fx.id, () => {
      const entries = fx.input.entries as ChangeEntry[];
      const excluded = fx.input.excludedPrefixes as string[];
      assert.equal(canonicalPayload(entries, excluded), fx.expect.canonicalPayload);
      assert.equal(changeDigest(entries, excluded), fx.expect.changeDigest);
    });
  }
});

test("changedigest is order independent", () => {
  const fx = load(join(SUITE, "changedigest", "002-ordering.json"));
  const entries = fx.input.entries as ChangeEntry[];
  const reversed = entries.slice().reverse();
  assert.equal(changeDigest(reversed, fx.input.excludedPrefixes), fx.expect.changeDigest);
});

test("glob", async (t) => {
  const fx = load(join(SUITE, "glob", "cases.json"));
  for (const c of fx.cases as Array<{ pattern: string; path: string; match: boolean }>) {
    await t.test(`${c.pattern} ~ ${c.path}`, () => {
      assert.equal(matches(c.pattern, c.path), c.match);
    });
  }
});

test("attribution", async (t) => {
  for (const f of family("attribution")) {
    const fx = load(join(SUITE, "attribution", f));
    await t.test(fx.id, () => {
      const span = fx.input.attributed as AttributedSpan;
      assert.equal(locateSpan(span, fx.input.fileLines as string[]), fx.expect.located);
    });
  }
});
