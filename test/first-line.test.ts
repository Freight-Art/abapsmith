/**
 * Regression coverage for `scripts/lib/first-line.mjs`.
 *
 * This is the JSON-aware harness summariser that replaces the naive
 * `text.split("\n").find(...)` idiom used by the manual harness scripts this
 * helper was extracted from (not shipped in this release). Two
 * invariants matter equally here:
 *
 *  1. A JSON error envelope must never summarise to the bare `{` — that is
 *     the exact defect that made every recorded DTEL/DE and MSAG/N failure
 *     from a live A4H run unactionable.
 *  2. A plain-string error — the overwhelmingly common case, since this
 *     helper sits on every tool-call failure path in these harnesses — must
 *     keep summarising EXACTLY as it did before this fix. A regression here
 *     would be invisible: it would not throw, it would just quietly start
 *     handing back worse notes for the common case while looking like it
 *     fixed the rare one.
 */
import { describe, expect, it } from "vitest";
import { firstLine } from "../scripts/lib/first-line.mjs";

describe("scripts/lib/first-line.mjs — JSON-aware harness summary", () => {
  it("a pretty-printed JSON error envelope does not summarise to `{`", () => {
    const prettyPrinted = JSON.stringify(
      { error: "NOT_FOUND", message: "DTEL/DE ZFOO was not found.", hint: "Check the name." },
      null,
      2,
    );
    // Sanity: this is the exact shape that used to break — confirm the
    // naive idiom really would have returned "{" for this input.
    expect(prettyPrinted.split("\n")[0]).toBe("{");

    const note = firstLine(prettyPrinted);
    expect(note).not.toBe("{");
    expect(note).toContain("NOT_FOUND");
    expect(note).toContain("DTEL/DE ZFOO was not found.");
  });

  it("a compact JSON error envelope (current src/tool-errors.ts output) summarises usefully too", () => {
    const compact = JSON.stringify({ error: "ADT_ERROR", message: "MSAG/N ZBAR creation failed." });
    const note = firstLine(compact);
    expect(note).not.toBe("{");
    expect(note).toContain("ADT_ERROR");
    expect(note).toContain("MSAG/N ZBAR creation failed.");
  });

  it("an object shape with none of the recognised fields falls back to flattened JSON, never `{`", () => {
    const odd = JSON.stringify({ status: 500, unexpectedKey: "some detail" }, null, 2);
    const note = firstLine(odd);
    expect(note).not.toBe("{");
    expect(note).toContain("unexpectedKey");
  });

  it("a plain-string (non-JSON) error keeps summarising exactly as before: the first non-blank line, capped at 600 chars", () => {
    expect(firstLine("boom: connection refused")).toBe("boom: connection refused");
    expect(firstLine("\n\n  \nboom: connection refused\nmore detail below")).toBe("boom: connection refused");
    const long = "x".repeat(1000);
    expect(firstLine(long)).toBe(long.slice(0, 600));
    expect(firstLine(long).length).toBe(600);
  });

  it("empty, whitespace-only, null and undefined input all report '(no message)', matching prior behaviour", () => {
    expect(firstLine("")).toBe("(no message)");
    expect(firstLine("   \n  \n")).toBe("(no message)");
    expect(firstLine(null)).toBe("(no message)");
    expect(firstLine(undefined)).toBe("(no message)");
  });

  it("a JSON array parses as an object with none of the recognised keys, so it falls back to flattened JSON (still not `{`)", () => {
    const arr = JSON.stringify(["a", "b", "c"]);
    expect(firstLine(arr)).toBe(arr);
    expect(firstLine(arr)).not.toBe("{");
  });

  it("JSON that parses to a non-object (a bare number or string) is not treated as an envelope — falls through to the plain-text path", () => {
    expect(firstLine("42")).toBe("42");
    expect(firstLine('"just a quoted string"')).toBe('"just a quoted string"');
  });
});
