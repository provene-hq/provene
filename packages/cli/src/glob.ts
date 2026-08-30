/**
 * RFC 0002 section 5.5 — the normative glob subset.
 *
 * Deliberately not a library. A pattern that means one thing in the CLI and
 * another in the hosted policy engine is a security bug rather than an
 * inconvenience, so the subset is small enough to specify exactly and is pinned
 * by conformance fixtures.
 *
 * Patterns are anchored at the repository root. This differs from .gitignore,
 * where a pattern containing no separator matches at any depth: `*.md` here
 * matches README.md and not docs/guide.md. Use `**\/*.md` for any depth.
 */
const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached !== undefined) return cached;

  let out = "^";
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith("**/", i)) {
      out += "(?:[^/]+/)*"; // zero or more whole segments, including none
      i += 3;
    } else if (pattern.startsWith("/**", i) && i + 3 === pattern.length) {
      out += "/.+"; // `dir/**` matches the contents of dir, not dir itself
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else if (pattern[i] === "?") {
      out += "[^/]";
      i += 1;
    } else if (pattern[i] === "[") {
      const close = pattern.indexOf("]", i);
      if (close === -1) throw new Error(`unterminated character class in pattern: ${pattern}`);
      out += `[${pattern.slice(i + 1, close)}]`;
      i = close + 1;
    } else {
      out += pattern[i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  const re = new RegExp(out + "$");
  cache.set(pattern, re);
  return re;
}

export function matches(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

export function matchesAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => matches(p, path));
}
