/**
 * The schemas served at provene.dev are the schemas in this repository.
 *
 * Every receipt names `https://provene.dev/attestation/code-change/v0.1` as its
 * predicate type, and each schema claims a `provene.dev/schema/...` URL as its
 * canonical `$id`. Those identifiers are immutable in artifacts already
 * published, so what the site serves is not documentation about the format —
 * it IS the format, to anyone whose validator resolves an `$id`.
 *
 * Which makes drift between `spec/schema/` and `docs/schema/` a correctness
 * bug rather than a tidiness one: a stranger validating against the published
 * copy would be checking a different document from the one this repository
 * tests against, and neither of us would know.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..", "..");

/** canonical source -> the path it is served from. */
const SERVED: ReadonlyArray<readonly [string, string]> = [
  ["spec/schema/provene-receipt-v0.1.schema.json", "docs/schema/receipt/v0.1.json"],
  ["spec/schema/provene-aggregate-v0.1.schema.json", "docs/schema/aggregate/v0.1.json"],
  ["spec/schema/provene-policy-v1.schema.json", "docs/schema/policy/v1.json"],
];

test("every schema is served byte-for-byte as it is specified", () => {
  for (const [src, served] of SERVED) {
    const a = readFileSync(join(root, src));
    const b = readFileSync(join(root, served));
    assert.ok(a.equals(b),
      `${served} differs from ${src} — run \`npm run site:sync\`. A validator ` +
      `resolving the published $id would check a different document.`);
  }
});

test("each schema is served at the URL its own $id claims", () => {
  for (const [src, served] of SERVED) {
    const id = (JSON.parse(readFileSync(join(root, src), "utf8")) as { $schema?: string; $id?: string })["$id"];
    assert.ok(typeof id === "string" && id.startsWith("https://provene.dev/"), `${src} has no provene.dev $id`);
    const path = new URL(id).pathname.replace(/^\//, "");
    assert.equal(`docs/${path}`, served,
      `${src} claims ${id}, which would be served from docs/${path}, not ${served}`);
  }
});

test("every provene.dev URL the repository publishes has a page behind it", () => {
  // A predicate type that 404s is a bad look for a trust product, and the
  // failure mode is silent: nothing in the toolchain fetches these, only people.
  const pages = [
    "docs/index.html",
    "docs/attestation/code-change/v0.1/index.html",
    "docs/attestation/code-change-aggregate/v0.1/index.html",
  ];
  for (const p of pages) assert.ok(existsSync(join(root, p)), `${p} is missing`);

  // And the predicate types the code actually emits are among them.
  const receipt = readFileSync(join(import.meta.dirname, "..", "src", "receipt.ts"), "utf8");
  const promote = readFileSync(join(import.meta.dirname, "..", "src", "promote.ts"), "utf8");
  for (const url of [...receipt.matchAll(/https:\/\/provene\.dev\/[^"'`\s]+/g)]
    .concat([...promote.matchAll(/https:\/\/provene\.dev\/[^"'`\s]+/g)])
    .map((m) => m[0])) {
    const path = new URL(url).pathname.replace(/^\//, "");
    const page = join(root, "docs", path, "index.html");
    const file = join(root, "docs", path);
    assert.ok(existsSync(page) || existsSync(file), `${url} is emitted but nothing is served at it`);
  }
});

/**
 * The apex is the identifier; `www` is a convenience.
 *
 * Receipts name `https://provene.dev/attestation/...`. If both hostnames serve
 * the same pages with nothing saying which is authoritative, the URL that ends
 * up indexed, linked and quoted may not be the one baked into every artifact
 * this project has published. A canonical link costs one line and settles it.
 */
test("each page declares the apex URL as canonical", () => {
  for (const [page, url] of [
    ["docs/index.html", "https://provene.dev/"],
    ["docs/attestation/code-change/v0.1/index.html", "https://provene.dev/attestation/code-change/v0.1"],
    ["docs/attestation/code-change-aggregate/v0.1/index.html",
     "https://provene.dev/attestation/code-change-aggregate/v0.1"],
  ] as const) {
    const html = readFileSync(join(root, page), "utf8");
    assert.match(html, new RegExp(`<link rel="canonical" href="${url.replace(/[/.]/g, "\\$&")}">`),
      `${page} does not name ${url} as canonical`);
    assert.doesNotMatch(html, /https:\/\/www\.provene\.dev/, `${page} links to www rather than the apex`);
  }
});
