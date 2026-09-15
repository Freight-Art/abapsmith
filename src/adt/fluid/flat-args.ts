/**
 * Flattens a nested `args` object into the flat `path -> scalar` shape the
 * classic-bridge ABAP reader `scan()` (`./builtin/classic/abap-core.ts`)
 * actually understands. `scan()` is a single-pass, character-at-a-time JSON
 * reader over the canonical top-level object: it reads a scalar string, a
 * bare scalar (number/boolean), or an array of STRINGS (flattened by
 * `scan()` itself into `key/0`, `key/1`, ...). It never recurses into an
 * object and never parses an array of objects. A manifest whose ABAP body
 * is written against `scan()` sets `FluidManifest.flatArgs`, and the
 * dispatcher (`./dispatch.ts`) runs caller args through `flattenScanArgs`
 * before serialising — this module is that transform, kept separate from
 * `scan()`'s own consumers so it can be unit-tested without any ABAP text.
 *
 * Rules, one call frame at a time (`flattenOne` recurses per property):
 *
 *  - Not a plain object at the top: returned unchanged (nothing to flatten).
 *  - A scalar property (string/number/boolean/null): copied through as-is.
 *  - An array whose elements are ALL strings, including the empty array:
 *    copied through as-is. `scan()` already flattens a string array into
 *    `key/0`, `key/1`, ... rows on its own, and `n()`'s wildcard-count
 *    branch already counts those rows — re-flattening this shape here would
 *    change nothing `scan()` reads but WOULD change the wire bytes (and so
 *    the content-addressed invoker name) of every existing classic call
 *    that already relies on this shape (`abap-view.ts`/`abap-index.ts`'s
 *    `fields`), for no benefit.
 *  - Any other array: `scan()` cannot parse an array of objects at all
 *    (every per-element property would silently read back empty), so it is
 *    replaced by a bare `key: v.length` row (a plain number, read as a bare
 *    scalar by `s()`/`b()` and as an exact count by `n()`) plus, for every
 *    element, that element flattened again under the path prefix `key/i`.
 *  - A plain object: replaced by its own properties flattened under the
 *    path prefix `key`. No bare count row is emitted for it — nothing reads
 *    one, and `n()`'s exact-count branch only fires when the bare path
 *    holds digits only.
 *  - Anything else (a function, a symbol, `undefined`): omitted, the same
 *    treatment `canonicalArgsJson` gives `undefined`.
 *
 * The result is always flat: no value in the returned object is ever an
 * array of objects or a plain object. Path segments are joined with `/` and
 * never escaped — they come from manifest-declared property names and
 * array indices, never from free-form caller text.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Flattens one value under `prefix` into `out`, recursing per these module's rules. */
function flattenOne(prefix: string, v: unknown, out: Record<string, unknown>): void {
  if (v === undefined || typeof v === "function" || typeof v === "symbol") {
    return;
  }
  if (Array.isArray(v)) {
    const elements: readonly unknown[] = v;
    if (elements.every((el) => typeof el === "string")) {
      out[prefix] = elements;
      return;
    }
    out[prefix] = elements.length;
    elements.forEach((el, i) => flattenOne(`${prefix}/${i}`, el, out));
    return;
  }
  if (isPlainObject(v)) {
    for (const [key, value] of Object.entries(v)) {
      flattenOne(`${prefix}/${key}`, value, out);
    }
    return;
  }
  // string, number, boolean, null
  out[prefix] = v;
}

/**
 * Flattens `args` for a `flatArgs: true` manifest. Not a plain object at
 * the top → returned unchanged. See the file header for the per-value
 * rules; each own, defined property of a top-level plain object is run
 * through {@link flattenOne} under its own key as the path prefix.
 */
export function flattenScanArgs(args: unknown): unknown {
  if (!isPlainObject(args)) {
    return args;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    flattenOne(key, value, out);
  }
  return out;
}
