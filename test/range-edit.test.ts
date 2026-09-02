/**
 * Offline, pure unit tests for the column-aware ranged-edit applier
 * (`src/adt/range-edit.ts`). No ADT/network dependency at all — every case
 * here is a direct `applyRangeEdit`/`applyRangeEdits` call against a literal
 * string. Style follows `test/v2-edit.test.ts` (the sibling primitive for
 * `abap_write`'s substring-match edit).
 *
 * Convention reminder for readers of this file (full justification lives in
 * `range-edit.ts`'s header): `line` is 1-based, `column` is 0-based UTF-16
 * code units and names the GAP before that index (a caret), and a range is
 * half-open `[start, end)`.
 */
import { describe, expect, it } from "vitest";
import {
  applyRangeEdit,
  applyRangeEdits,
  type ApplyInvertedRange,
  type ApplyOutOfBoundsColumn,
  type ApplyOutOfBoundsLine,
  type ApplyOverlappingEdits,
  type Position,
} from "../src/adt/range-edit.js";

/** Shorthand for a `Position`. */
const at = (line: number, column: number): Position => ({ line, column });

describe("applyRangeEdit — single edit", () => {
  it("replaces a mid-line span, leaving the rest of the source untouched", () => {
    const source = "REPORT z_foo.\nWRITE 'hello'.\nEND.";
    // "hello" occupies columns 7..12 on line 2 (0-based, half-open) — after
    // "WRITE " (6 chars) and the opening quote (1 char).
    const result = applyRangeEdit(source, {
      range: { start: at(2, 7), end: at(2, 12) },
      content: "world",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("REPORT z_foo.\nWRITE 'world'.\nEND.");
  });

  it("zero-width range at the very start of the document is a pure insertion", () => {
    const source = "WRITE 1.";
    const result = applyRangeEdit(source, { range: { start: at(1, 0), end: at(1, 0) }, content: "* header\n" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("* header\nWRITE 1.");
  });

  it("zero-width range at the very end of the document (no trailing newline) is a pure insertion", () => {
    const source = "WRITE 1.";
    const result = applyRangeEdit(source, { range: { start: at(1, 8), end: at(1, 8) }, content: "\nWRITE 2." });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("WRITE 1.\nWRITE 2.");
  });

  it("insertion mid-line leaves everything before and after byte-identical", () => {
    const source = "DATA: lv_x TYPE i.";
    const result = applyRangeEdit(source, { range: { start: at(1, 6), end: at(1, 6) }, content: "lv_new TYPE i,\n       " });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const expected = "DATA: lv_new TYPE i,\n       lv_x TYPE i.";
    expect(result.result).toBe(expected);
    // Explicitly confirm the untouched prefix/suffix survive verbatim.
    expect(result.result.startsWith("DATA: ")).toBe(true);
    expect(result.result.endsWith("lv_x TYPE i.")).toBe(true);
  });

  it("insertion at a line boundary (start of a non-first line) — column 0", () => {
    const source = "LINE1\nLINE2\nLINE3";
    const result = applyRangeEdit(source, { range: { start: at(2, 0), end: at(2, 0) }, content: "INSERTED\n" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("LINE1\nINSERTED\nLINE2\nLINE3");
  });

  it("insertion into an empty source, at the only valid position (1,0)", () => {
    const result = applyRangeEdit("", { range: { start: at(1, 0), end: at(1, 0) }, content: "REPORT z." });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("REPORT z.");
  });

  it("pure deletion: empty content over a non-empty range", () => {
    const source = "DATA: lv_x TYPE i, lv_y TYPE i.";
    // Delete " lv_y TYPE i" (columns 18..30).
    const result = applyRangeEdit(source, { range: { start: at(1, 18), end: at(1, 30) }, content: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("DATA: lv_x TYPE i,.");
  });

  it("range covering the whole single-line document", () => {
    const source = "WRITE 'old'.";
    const result = applyRangeEdit(source, { range: { start: at(1, 0), end: at(1, source.length) }, content: "WRITE 'new'." });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("WRITE 'new'.");
  });

  it("range covering the whole multi-line document, via the phantom last line", () => {
    const source = "A\nB\n";
    // 3 lines under the phantom-last-line convention: "A", "B", "".
    const result = applyRangeEdit(source, { range: { start: at(1, 0), end: at(3, 0) }, content: "REPLACED" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("REPLACED");
  });

  it("edit at the very first character of the document", () => {
    const source = "Xbc";
    const result = applyRangeEdit(source, { range: { start: at(1, 0), end: at(1, 1) }, content: "Y" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("Ybc");
  });

  it("edit at the very last character of the document", () => {
    const source = "abX";
    const result = applyRangeEdit(source, { range: { start: at(1, 2), end: at(1, 3) }, content: "Y" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("abY");
  });
});

describe("applyRangeEdit — CRLF and trailing-newline preservation", () => {
  it("preserves CRLF line endings verbatim outside the edited range", () => {
    const source = "REPORT z.\r\nWRITE 'a'.\r\nEND.";
    const result = applyRangeEdit(source, { range: { start: at(2, 6), end: at(2, 9) }, content: "'b'" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("REPORT z.\r\nWRITE 'b'.\r\nEND.");
    // No LF was introduced or CRLF collapsed anywhere in the untouched text.
    expect(result.result.includes("\r\n")).toBe(true);
    expect((result.result.match(/\r\n/g) ?? []).length).toBe(2);
  });

  it("mixed CRLF/LF source: each line's own terminator survives untouched", () => {
    const source = "L1\r\nL2\nL3\r\nL4";
    const result = applyRangeEdit(source, { range: { start: at(2, 0), end: at(2, 2) }, content: "X2" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("L1\r\nX2\nL3\r\nL4");
  });

  it("does not normalise CRLF to LF anywhere it didn't touch (unlike applyEdit's documented LF-normalisation)", () => {
    const source = "A\r\nB\r\nC";
    const result = applyRangeEdit(source, { range: { start: at(3, 0), end: at(3, 1) }, content: "Z" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("A\r\nB\r\nZ");
    expect(result.result.includes("\n") && !result.result.includes("\r\n")).toBe(false);
  });

  it("a source with no trailing newline keeps none after an edit elsewhere", () => {
    const source = "A\nB";
    const result = applyRangeEdit(source, { range: { start: at(1, 0), end: at(1, 1) }, content: "Z" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("Z\nB");
    expect(result.result.endsWith("\n")).toBe(false);
  });

  it("a source WITH a trailing newline keeps it after an edit elsewhere", () => {
    const source = "A\nB\n";
    const result = applyRangeEdit(source, { range: { start: at(1, 0), end: at(1, 1) }, content: "Z" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("Z\nB\n");
    expect(result.result.endsWith("\n")).toBe(true);
  });

  it("content is inserted byte-for-byte, even if its own newlines mismatch the source's style (no silent reformatting)", () => {
    const source = "A\r\nB\r\nC";
    const result = applyRangeEdit(source, { range: { start: at(1, 1), end: at(1, 1) }, content: "\ninserted-with-LF" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // The inserted LF is NOT upgraded to CRLF — content passes through verbatim.
    expect(result.result).toBe("A\ninserted-with-LF\r\nB\r\nC");
  });
});

describe("applyRangeEdit — non-ASCII", () => {
  it("column arithmetic is correct around a BMP non-ASCII character (e-acute, 1 UTF-16 code unit)", () => {
    const source = "* café comment\nWRITE 1.";
    // "café" occupies columns 2..6 on line 1; replace just the accented word.
    const result = applyRangeEdit(source, { range: { start: at(1, 2), end: at(1, 6) }, content: "coffee" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("* coffee comment\nWRITE 1.");
  });

  it("column arithmetic around an astral character (surrogate pair, 2 UTF-16 code units)", () => {
    // U+1F600 GRINNING FACE is a surrogate pair — 2 UTF-16 code units.
    const emoji = "\u{1F600}";
    const source = `* ${emoji} note\nEND.`;
    expect(emoji.length).toBe(2);
    // Columns: '*'=0 ' '=1 [emoji: 2,3] ' '=4 'n'=5...
    const result = applyRangeEdit(source, { range: { start: at(1, 2), end: at(1, 4) }, content: "OK" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("* OK note\nEND.");
  });
});

describe("applyRangeEdit — rejected input, never clamped, never thrown", () => {
  it("start line beyond the document is rejected, not clamped to the last line", () => {
    const source = "A\nB\nC";
    const result = applyRangeEdit(source, { range: { start: at(99, 0), end: at(99, 0) }, content: "x" });
    expect(result.ok).toBe(false);
    const f = result as ApplyOutOfBoundsLine;
    expect(f.kind).toBe("out-of-bounds-line");
    expect(f.endpoint).toBe("start");
    expect(f.line).toBe(99);
    expect(f.lineCount).toBe(3);
  });

  it("end line beyond the document is rejected, not clamped", () => {
    const source = "A\nB\nC";
    const result = applyRangeEdit(source, { range: { start: at(1, 0), end: at(50, 0) }, content: "x" });
    expect(result.ok).toBe(false);
    const f = result as ApplyOutOfBoundsLine;
    expect(f.kind).toBe("out-of-bounds-line");
    expect(f.endpoint).toBe("end");
    expect(f.line).toBe(50);
  });

  it("line 0 (below the 1-based floor) is out-of-bounds, not silently treated as line 1", () => {
    const source = "A\nB";
    const result = applyRangeEdit(source, { range: { start: at(0, 0), end: at(0, 0) }, content: "x" });
    expect(result.ok).toBe(false);
    expect((result as ApplyOutOfBoundsLine).kind).toBe("out-of-bounds-line");
  });

  it("column beyond the end of its line is rejected, not clamped to end-of-line", () => {
    const source = "AB\nCD";
    // Line 1 ("AB") has length 2; column 2 is valid (end-of-line caret), column 3 is not.
    const result = applyRangeEdit(source, { range: { start: at(1, 3), end: at(1, 3) }, content: "x" });
    expect(result.ok).toBe(false);
    const f = result as ApplyOutOfBoundsColumn;
    expect(f.kind).toBe("out-of-bounds-column");
    expect(f.endpoint).toBe("start");
    expect(f.line).toBe(1);
    expect(f.column).toBe(3);
    expect(f.lineLength).toBe(2);
  });

  it("column exactly at end-of-line (== line length) is VALID, not rejected", () => {
    const source = "AB\nCD";
    const result = applyRangeEdit(source, { range: { start: at(1, 2), end: at(1, 2) }, content: "X" });
    expect(result.ok).toBe(true);
  });

  it("negative column is rejected", () => {
    const source = "AB";
    const result = applyRangeEdit(source, { range: { start: at(1, -1), end: at(1, -1) }, content: "x" });
    expect(result.ok).toBe(false);
    expect((result as ApplyOutOfBoundsColumn).kind).toBe("out-of-bounds-column");
  });

  it("inverted range (end before start, same line) is rejected", () => {
    const source = "ABCDEF";
    const result = applyRangeEdit(source, { range: { start: at(1, 4), end: at(1, 1) }, content: "x" });
    expect(result.ok).toBe(false);
    const f = result as ApplyInvertedRange;
    expect(f.kind).toBe("inverted-range");
  });

  it("inverted range (end line before start line) is rejected", () => {
    const source = "A\nB\nC";
    const result = applyRangeEdit(source, { range: { start: at(3, 0), end: at(1, 0) }, content: "x" });
    expect(result.ok).toBe(false);
    expect((result as ApplyInvertedRange).kind).toBe("inverted-range");
  });

  it("does not throw for any of the above — every case is a plain ok:false return", () => {
    const source = "A\nB";
    expect(() => applyRangeEdit(source, { range: { start: at(-5, -5), end: at(-5, -5) }, content: "x" })).not.toThrow();
  });
});

describe("applyRangeEdits — realistic quickfix shape (live-verified ranges)", () => {
  // Live A4H capture: a rename-refactor over `lv_text` in a 12-line ABAP
  // report returned FOUR `fixEdits` delta units in one response, each
  // `<content>lv_text</content>` (7 bytes) against these wire ranges:
  //   #start=3,5;end=3,12    #start=8,14;end=8,21
  //   #start=10,10;end=10,17 #start=12,8;end=12,15
  // Hand-verified: `lv_text` is 7 characters and every range spans exactly
  // 7 columns. This is the shape `applyRangeEdits` exists for — multiple
  // edits in one call is the NORMAL case for a quickfix response, not an
  // edge case, and every range is relative to the ORIGINAL source.
  const BAIT_SOURCE =
    "REPORT zmcp_qf_probe1.\n" +
    "\n" +
    "DATA lv_text TYPE string.\n" +
    "DATA lv_unused TYPE i.\n" +
    "\n" +
    "BREAK-POINT.\n" +
    "\n" +
    "MOVE 'abc' TO lv_text.\n" +
    "\n" +
    "TRANSLATE lv_text TO UPPER CASE.\n" +
    "\n" +
    "WRITE / lv_text.\n";

  it("renames all four occurrences of lv_text in one call, from live-captured quickfix ranges", () => {
    const result = applyRangeEdits(BAIT_SOURCE, [
      { range: { start: at(3, 5), end: at(3, 12) }, content: "lv_msg" },
      { range: { start: at(8, 14), end: at(8, 21) }, content: "lv_msg" },
      { range: { start: at(10, 10), end: at(10, 17) }, content: "lv_msg" },
      { range: { start: at(12, 8), end: at(12, 15) }, content: "lv_msg" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe(
      "REPORT zmcp_qf_probe1.\n" +
        "\n" +
        "DATA lv_msg TYPE string.\n" +
        "DATA lv_unused TYPE i.\n" +
        "\n" +
        "BREAK-POINT.\n" +
        "\n" +
        "MOVE 'abc' TO lv_msg.\n" +
        "\n" +
        "TRANSLATE lv_msg TO UPPER CASE.\n" +
        "\n" +
        "WRITE / lv_msg.\n",
    );
    // The untouched lines (declaration of lv_unused, BREAK-POINT, blanks)
    // survive byte-for-byte.
    expect(result.result.includes("DATA lv_unused TYPE i.")).toBe(true);
    expect(result.result.includes("BREAK-POINT.")).toBe(true);
  });

  it("each live-captured range spans exactly the 7 characters of lv_text (sanity-checks the fixture itself)", () => {
    const lines = BAIT_SOURCE.split("\n");
    expect(lines[2]!.slice(5, 12)).toBe("lv_text"); // line 3, 1-based
    expect(lines[7]!.slice(14, 21)).toBe("lv_text"); // line 8
    expect(lines[9]!.slice(10, 17)).toBe("lv_text"); // line 10
    expect(lines[11]!.slice(8, 15)).toBe("lv_text"); // line 12
  });
});

describe("applyRangeEdits — mixed insertion/replacement units, server order not trusted", () => {
  // Synthetic shape modelled on an observed multi-unit quickfix response: one
  // unit is a REPLACEMENT (start !== end, earlier in the document) and the
  // other is a pure INSERTION (start === end, later in the document), and
  // the applier must not assume either (a) both units are the same kind or
  // (b) the input array arrives in document order.
  const SOURCE = "AAAA\nBBBB\nCCCC\nDDDD\nEEEEEEEE\nFFFF\nGGGG\nHHHHHHHHHH\nIIII\nJJJJ\n";
  const REPLACEMENT = { range: { start: at(5, 4), end: at(5, 8) }, content: "XXXX" }; // line 5: "EEEEEEEE" -> "EEEEXXXX"
  const INSERTION = { range: { start: at(8, 5), end: at(8, 5) }, content: "-INS-" }; // line 8: "HHHHHHHHHH" -> "HHHHH-INS-HHHHH"
  const EXPECTED = "AAAA\nBBBB\nCCCC\nDDDD\nEEEEXXXX\nFFFF\nGGGG\nHHHHH-INS-HHHHH\nIIII\nJJJJ\n";

  it("sanity-checks the fixture's own slicing before trusting the applier's output", () => {
    const lines = SOURCE.split("\n");
    expect(lines[4]).toBe("EEEEEEEE");
    expect(lines[4]!.slice(4, 8)).toBe("EEEE");
    expect(lines[7]).toBe("HHHHHHHHHH");
    expect(lines[7]!.slice(0, 5) + lines[7]!.slice(5)).toBe("HHHHHHHHHH");
  });

  it("applies a replacement and an insertion together, passed in ascending document order", () => {
    const result = applyRangeEdits(SOURCE, [REPLACEMENT, INSERTION]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe(EXPECTED);
  });

  it("produces the byte-identical result when the same two units are passed in reverse (insertion first) — server order is never assumed", () => {
    const result = applyRangeEdits(SOURCE, [INSERTION, REPLACEMENT]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe(EXPECTED);
  });
});

describe("applyRangeEdits — multiple edits", () => {
  it("empty edits array is a no-op success", () => {
    const source = "WRITE 1.";
    const result = applyRangeEdits(source, []);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe(source);
  });

  it("applies multiple non-overlapping edits, all ranges relative to the ORIGINAL source", () => {
    const source = "DATA: lv_a TYPE i.\nDATA: lv_b TYPE i.\nDATA: lv_c TYPE i.";
    // Replace lv_a on line 1, lv_c on line 3 — line 2 untouched. If ranges were
    // relative to a partially-edited buffer instead of the original, the
    // second edit's column would drift once the first edit changed length.
    const result = applyRangeEdits(source, [
      { range: { start: at(1, 6), end: at(1, 10) }, content: "lv_alpha" },
      { range: { start: at(3, 6), end: at(3, 10) }, content: "lv_gamma" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("DATA: lv_alpha TYPE i.\nDATA: lv_b TYPE i.\nDATA: lv_gamma TYPE i.");
  });

  it("edits are order-independent in the input array — result is identical either order", () => {
    const source = "AAAA BBBB CCCC";
    const editFirst = { range: { start: at(1, 0), end: at(1, 4) }, content: "1111" };
    const editSecond = { range: { start: at(1, 10), end: at(1, 14) }, content: "3333" };
    const r1 = applyRangeEdits(source, [editFirst, editSecond]);
    const r2 = applyRangeEdits(source, [editSecond, editFirst]);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) throw new Error("unreachable");
    expect(r1.result).toBe(r2.result);
    expect(r1.result).toBe("1111 BBBB 3333");
  });

  it("adjacent (touching, non-overlapping) edits are both applied", () => {
    const source = "ABCDEF";
    // First replaces [0,3), second replaces [3,6) — they touch at column 3 but do not overlap.
    const result = applyRangeEdits(source, [
      { range: { start: at(1, 0), end: at(1, 3) }, content: "xyz" },
      { range: { start: at(1, 3), end: at(1, 6) }, content: "123" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("xyz123");
  });

  it("a zero-width insertion touching a replace edit's boundary is applied cleanly (insert-then-replace)", () => {
    const source = "ABCDEF";
    const result = applyRangeEdits(source, [
      { range: { start: at(1, 3), end: at(1, 3) }, content: "|" }, // insert at the boundary
      { range: { start: at(1, 3), end: at(1, 6) }, content: "XYZ" }, // replace starting at the same boundary
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Insertion sorts before the replace that starts at the same point.
    expect(result.result).toBe("ABC|XYZ");
  });

  it("overlapping edits are rejected outright, not silently resolved", () => {
    const source = "ABCDEFGH";
    const result = applyRangeEdits(source, [
      { range: { start: at(1, 0), end: at(1, 5) }, content: "x" },
      { range: { start: at(1, 3), end: at(1, 8) }, content: "y" },
    ]);
    expect(result.ok).toBe(false);
    const f = result as ApplyOverlappingEdits;
    expect(f.kind).toBe("overlapping-edits");
    expect([f.firstIndex, f.secondIndex].sort()).toEqual([0, 1]);
  });

  it("overlap detection is independent of input order", () => {
    const source = "ABCDEFGH";
    const result = applyRangeEdits(source, [
      { range: { start: at(1, 3), end: at(1, 8) }, content: "y" },
      { range: { start: at(1, 0), end: at(1, 5) }, content: "x" },
    ]);
    expect(result.ok).toBe(false);
    expect((result as ApplyOverlappingEdits).kind).toBe("overlapping-edits");
  });

  it("one range fully nested inside another is rejected as overlapping", () => {
    const source = "ABCDEFGH";
    const result = applyRangeEdits(source, [
      { range: { start: at(1, 0), end: at(1, 8) }, content: "outer" },
      { range: { start: at(1, 2), end: at(1, 4) }, content: "inner" },
    ]);
    expect(result.ok).toBe(false);
    expect((result as ApplyOverlappingEdits).kind).toBe("overlapping-edits");
  });

  it("two zero-width insertions at the exact same position are rejected as ambiguous", () => {
    const source = "ABCDEF";
    const result = applyRangeEdits(source, [
      { range: { start: at(1, 3), end: at(1, 3) }, content: "first" },
      { range: { start: at(1, 3), end: at(1, 3) }, content: "second" },
    ]);
    expect(result.ok).toBe(false);
    expect((result as ApplyOverlappingEdits).kind).toBe("overlapping-edits");
  });

  it("an out-of-bounds edit among otherwise-valid ones is rejected and identifies its own index", () => {
    const source = "A\nB\nC";
    const result = applyRangeEdits(source, [
      { range: { start: at(1, 0), end: at(1, 1) }, content: "x" },
      { range: { start: at(999, 0), end: at(999, 0) }, content: "y" },
    ]);
    expect(result.ok).toBe(false);
    const f = result as ApplyOutOfBoundsLine;
    expect(f.kind).toBe("out-of-bounds-line");
    expect(f.editIndex).toBe(1);
  });

  it("an inverted edit among otherwise-valid ones is rejected and identifies its own index", () => {
    const source = "ABCDEF";
    const result = applyRangeEdits(source, [
      { range: { start: at(1, 5), end: at(1, 1) }, content: "x" },
      { range: { start: at(1, 0), end: at(1, 1) }, content: "y" },
    ]);
    expect(result.ok).toBe(false);
    const f = result as ApplyInvertedRange;
    expect(f.kind).toBe("inverted-range");
    expect(f.editIndex).toBe(0);
  });

  it("multiple edits preserve CRLF and trailing newline together", () => {
    const source = "A\r\nB\r\nC\r\n";
    const result = applyRangeEdits(source, [
      { range: { start: at(1, 0), end: at(1, 1) }, content: "X" },
      { range: { start: at(3, 0), end: at(3, 1) }, content: "Z" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toBe("X\r\nB\r\nZ\r\n");
  });

  it("does not throw for a malformed edit set — plain ok:false", () => {
    const source = "AB";
    expect(() =>
      applyRangeEdits(source, [
        { range: { start: at(1, 0), end: at(1, 5) }, content: "x" },
        { range: { start: at(1, 0), end: at(1, 1) }, content: "y" },
      ]),
    ).not.toThrow();
  });
});
