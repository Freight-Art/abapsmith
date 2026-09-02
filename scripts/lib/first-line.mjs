/**
 * One-line summary of a tool result's text, for harness report notes.
 *
 * Taking the literal first non-blank line of a failed tool call's text is
 * wrong when that text is JSON: the MCP error envelope (`src/tool-errors.ts`)
 * used to pretty-print with `JSON.stringify(payload, null, 2)`, so the first
 * non-blank line was always the single character `{` and the entire
 * diagnostic was thrown away before it was ever recorded. The first live A4H
 * benchmark run recorded every DTEL/DE and MSAG/N failure exactly that way.
 *
 * `src/tool-errors.ts` now serialises compactly, which already
 * fixes the worst of it — the "first line" of compact JSON is the whole
 * envelope, not `{`. This helper goes one step further and stays useful even
 * if that changes again, or against any other JSON text a harness happens to
 * hand it: parse as JSON when the text is JSON, and pull out the fields that
 * actually carry the server's complaint, rather than dumping the whole
 * envelope into a report note. Falls back to the flattened JSON for object
 * shapes it does not recognise, and to the plain first-line behaviour for
 * genuinely non-JSON text — a plain-string error summarises exactly as it did
 * before this helper existed.
 *
 * Originally written inline and independently in two separate report tools;
 * consolidated here so every caller — and any future one — shares one
 * implementation instead of drifting apart.
 *
 * @param {unknown} s
 * @returns {string}
 */
export function firstLine(s) {
  const text = String(s ?? "").trim();
  if (text === "") return "(no message)";
  try {
    const o = JSON.parse(text);
    if (o && typeof o === "object") {
      const parts = [];
      for (const k of ["code", "error", "message", "detail", "details", "reason", "hint"]) {
        const v = o[k] ?? o.error?.[k];
        if (typeof v === "string" && v.trim() !== "" && !parts.includes(v)) parts.push(v);
      }
      if (parts.length > 0) return parts.join(" — ").slice(0, 600);
      // Shape we did not anticipate: show the flattened JSON rather than `{`.
      return JSON.stringify(o).slice(0, 600);
    }
  } catch {
    // Not JSON — fall through to the plain-text path.
  }
  return text.split("\n").find((l) => l.trim() !== "")?.slice(0, 600) ?? "(no message)";
}
