/**
 * Path comparison for paths this process did not create.
 *
 * Every path here arrives from outside: a hook payload, an agent's own log, a
 * `--cwd` passed by a third-party emitter. They come in two separator
 * conventions, in either case on Windows, and with `.` and `..` segments left
 * unresolved -- and they are compared against a repository root to decide
 * whether a file or a command belongs to this change.
 *
 * Getting that comparison wrong is not cosmetic. `/repo/../elsewhere/a.ts`
 * begins with `/repo/`, so a prefix test on the raw string answers "inside this
 * repository" for a file that is not in it, and the receipt then attributes
 * someone else's file to this change. Normalising separators is not enough;
 * the segments have to be resolved.
 */

/** Separators unified, `.` dropped, `..` resolved, trailing separator removed. */
export function normalizePath(p: string): string {
  const unified = p.replace(/\\/g, "/");
  // What counts as a root, and what only looks like one.
  //
  //   //server/share   UNC. The host and share ARE the root; treating the
  //                    leading slashes as a plain root turns
  //                    \\server\share into /server/share and loses the host.
  //   C:/              a drive root.
  //   /                the current drive's root.
  //
  // `C:foo` is NOT a root. It is relative to the working directory ON drive C,
  // which this process does not know, so resolving it to `C:/foo` invents an
  // absolute path -- and then compares it against a repository root as though
  // it were fact. It is left relative, and a caller that needs a rooted path
  // rejects it rather than guessing which directory it meant.
  const rootMatch = /^(\/\/[^/]+\/[^/]+|\/|[A-Za-z]:\/)/.exec(unified);
  const root = rootMatch === null ? "" : rootMatch[0];
  const out: string[] = [];
  for (const seg of unified.slice(root.length).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      // Above a known root, `..` is discarded. On a relative path there is no
      // root to protect, so it is kept -- dropping it would silently turn
      // `../other/a.ts` into `other/a.ts` and place it inside the repository.
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (root === "") out.push("..");
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  if (root === "") return joined;
  const r = root.endsWith("/") ? root : `${root}/`;
  return joined === "" ? r.replace(/\/$/, "") : `${r}${joined}`;
}

/** Whether `path` is `root` or lies beneath it, after both are normalized. */
export function isWithin(path: string, root: string, caseInsensitive: boolean): boolean {
  let a = normalizePath(path);
  let b = normalizePath(root);
  if (caseInsensitive) { a = a.toLowerCase(); b = b.toLowerCase(); }
  return a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`);
}
