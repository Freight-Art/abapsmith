/**
 * `systemKey()` — pure identity string for an ABAP system (SID + URL origin
 * + client, normalised and percent-encoded). No I/O, no dependency on the
 * journal's persistence surface.
 *
 * Lives on its own so it can be shared without dragging in `node:fs`:
 * `src/journal.ts` re-exports it for its existing importers, and
 * `src/adt/undo.ts`, `src/adt/fluid/*`, `src/tools/*` use it directly. Since
 * issue #93, `src/adt/pool.ts` also imports it here (not from
 * `../journal.js`) to scope its cross-process object-gate lock per system —
 * `test/pool.test.ts` pins the pool never reaching into the journal, since
 * that dependency runs the other way and `journal.ts` reaches `node:fs`.
 */

/**
 * Stable identity of the system an operation was recorded against.
 *
 * The SID alone is a caller-supplied label (from `ABAP_SID`, defaults
 * "UNKNOWN"), so two different boxes can present the same one. Host + client
 * + SID together is what actually identifies a system, recorded normalised
 * as one comparable string, each part percent-encoded before joining so the
 * "|" separator cannot occur inside a part.
 *
 * Normalisation: URL origin lowercased; SID uppercased; client trimmed. A URL
 * that does not parse degrades to its raw trimmed text rather than being
 * dropped — an unparsable URL is still evidence.
 */
export function systemKey(parts: { sid: string; url: string; client: string }): string {
  const raw = parts.url.trim();
  let origin: string;
  try {
    const u = new URL(raw);
    // `origin` is the literal string "null" for opaque schemes; protocol+host
    // is the stable pair underneath it.
    origin = (u.origin && u.origin !== "null" ? u.origin : `${u.protocol}//${u.host}`).toLowerCase();
  } catch {
    origin = raw.toLowerCase();
  }
  return [parts.sid.trim().toUpperCase(), origin, parts.client.trim()]
    .map(encodeURIComponent)
    .join("|");
}
