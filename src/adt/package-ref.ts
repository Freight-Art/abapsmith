/**
 * `<adtcore:packageRef adtcore:name="ZLOCAL" …/>` — the one place the server
 * states which package an object is in. Regex-scraped, not parsed (same
 * approach as `src/adt/connection.ts`'s `ato/settings` scrape). Since the
 * answer feeds the safety gate, this returns NOTHING rather than something
 * plausible: comments are stripped first (a commented-out packageRef must
 * not win); any namespace prefix is accepted on the element but ONLY
 * `adtcore:name`/bare `name` on the attribute (a prefix-agnostic match could
 * pick up a decoy like `vfs:name="junk"`); and EVERY occurrence is
 * collected, not just the first, since a nested `<adtcore:objectReference>`
 * for a different object can carry its own packageRef earlier in the
 * document — disagreement returns `undefined` so the caller fails closed.
 *
 * Moved out of `src/adt/write.ts` so `src/adt/write-verify.ts`'s
 * `packageRefName` — which feeds the same package allowlist, but for the
 * `VIEW/DV`/`TRAN/T` bridge DELETE path that has no `resolveObject` route to
 * lean on — uses this hardened parser instead of standing up a second,
 * weaker one beside it. `write.ts` still owns `assertPayloadMatchesTarget`
 * and `resolveWriteTarget`'s container/package resolution, both unchanged,
 * now importing from here.
 */
export const XML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const PACKAGE_REF_TAG_RE = /<(?:[A-Za-z_][\w.-]*:)?packageRef\b([^>]*)>/gi;
const PACKAGE_REF_NAME_RE = /(?:^|\s)(?:adtcore:)?name\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

export function parsePackageRef(xml: string): string | undefined {
  const doc = xml.replace(XML_COMMENT_RE, "");
  let first: string | undefined;
  const seen = new Set<string>();
  // A fresh regex object per call would be tidier, but `lastIndex = 0` on a
  // module-level /g literal is the same thing without the per-call allocation —
  // and the reset is mandatory: a `/g` regex resumes where it last stopped.
  PACKAGE_REF_TAG_RE.lastIndex = 0;
  for (let tag = PACKAGE_REF_TAG_RE.exec(doc); tag; tag = PACKAGE_REF_TAG_RE.exec(doc)) {
    const attr = PACKAGE_REF_NAME_RE.exec(tag[1] ?? "");
    const value = (attr?.[1] ?? attr?.[2] ?? "").trim();
    // A packageRef with no usable name says nothing; it is not a disagreement.
    if (!value) continue;
    // Package names are case-insensitive on the server (the caller uppercases
    // what it gets back), so "ZLOCAL" and "zlocal" agree rather than conflict.
    seen.add(value.toUpperCase());
    first ??= value;
  }
  return seen.size === 1 ? first : undefined;
}
