/**
 * `src/adt/run-parameters.ts` — selection-screen value marshalling.
 *
 * Pure, offline, no transport at all: every function under test is a plain
 * synchronous function over strings, so this file exercises them directly.
 * The live-execution proof (that a marshalled row actually reaches a real
 * report through `SUBMIT ... WITH SELECTION-TABLE`) lives outside the test
 * suite, against A4H — see the final report for that evidence. What belongs
 * here is what CAN be verified offline: the typed conversions, the
 * structural validation of range rows, and that every rejection path throws
 * `BAD_INPUT` naming the exact field, never silently coerces.
 */
import { describe, expect, it } from "vitest";
import { isAbapError } from "../src/adt/errors.js";
import {
  formatSelectionValue,
  marshalSelectionTable,
  parseSelectionScreen,
  selectionScreenNotes,
  RSPARAMS_LOW_MAX,
  type RunParameterInput,
} from "../src/adt/run-parameters.js";
import { runInputSchema } from "../src/tools/run.js";

describe("formatSelectionValue", () => {
  it("char: passes plain text through unchanged", () => {
    expect(formatSelectionValue("hello world", "char", "p")).toBe("hello world");
  });

  it("char: refuses text longer than RSPARAMS-LOW's real 45-char length", () => {
    const tooLong = "x".repeat(RSPARAMS_LOW_MAX + 1);
    expect(() => formatSelectionValue(tooLong, "char", "p.low")).toThrowError(/45-character limit/);
  });

  it("char: refuses control characters rather than stripping them", () => {
    expect(() => formatSelectionValue("a\nb", "char", "p.low")).toThrowError(/control character/);
  });

  it("int: accepts a plain (optionally negative) integer", () => {
    expect(formatSelectionValue("42", "int", "p")).toBe("42");
    expect(formatSelectionValue("-7", "int", "p")).toBe("-7");
  });

  it("int: refuses a decimal or non-numeric value", () => {
    expect(() => formatSelectionValue("4.2", "int", "p")).toThrowError(/not a plain integer/);
    expect(() => formatSelectionValue("abc", "int", "p")).toThrowError(/not a plain integer/);
  });

  it("packed: accepts a dot-decimal number, positive or negative", () => {
    expect(formatSelectionValue("123.45", "packed", "p")).toBe("123.45");
    expect(formatSelectionValue("-0.5", "packed", "p")).toBe("-0.5");
    expect(formatSelectionValue("100", "packed", "p")).toBe("100");
  });

  it("packed: refuses a comma decimal separator rather than reinterpreting it", () => {
    expect(() => formatSelectionValue("123,45", "packed", "p")).toThrowError(/not a plain decimal/);
  });

  it("date: converts ISO YYYY-MM-DD to internal YYYYMMDD (the confirmed-safe live recipe)", () => {
    // Live-verified 2026-08-12: RSPARAMS-LOW/HIGH are un-converted internal
    // text for TYPE D fields (no conversion exit), so a separator-bearing
    // value (external DD.MM.YYYY or ISO YYYY-MM-DD sent as-is) short-dumps
    // ("Enter date in the format __.__.____"); the clean 8-digit internal
    // form round-trips correctly. This module accepts the readable ISO form
    // from callers and performs that conversion itself.
    expect(formatSelectionValue("2026-08-12", "date", "p")).toBe("20260812");
    expect(formatSelectionValue("1999-01-01", "date", "p")).toBe("19990101");
  });

  it("date: refuses anything not in YYYY-MM-DD form, rather than guessing", () => {
    expect(() => formatSelectionValue("12.08.2026", "date", "p")).toThrowError(/YYYY-MM-DD/);
    expect(() => formatSelectionValue("20260812", "date", "p")).toThrowError(/YYYY-MM-DD/);
    expect(() => formatSelectionValue("2026/08/12", "date", "p")).toThrowError(/YYYY-MM-DD/);
  });

  it("date: refuses an out-of-range month/day", () => {
    expect(() => formatSelectionValue("2026-13-01", "date", "p")).toThrowError(/month must be/);
    expect(() => formatSelectionValue("2026-02-32", "date", "p")).toThrowError(/month must be/);
  });
});

describe("marshalSelectionTable", () => {
  it("turns a PARAMETERS-shorthand value into a single EQ/include row", () => {
    const rows = marshalSelectionTable([{ name: "p_str", value: "hello" }]);
    expect(rows).toEqual([
      { selname: "P_STR", kind: "P", sign: "I", option: "EQ", low: "hello", high: "" },
    ]);
  });

  it("uppercases and validates the field name against the 8-char ABAP identifier grammar", () => {
    expect(() => marshalSelectionTable([{ name: "toolongname", value: "x" }])).toThrowError(
      /not a valid selection-screen field name/,
    );
    expect(() => marshalSelectionTable([{ name: "1abc", value: "x" }])).toThrowError(
      /not a valid selection-screen field name/,
    );
  });

  it("marshals a SELECT-OPTIONS field with several range rows, defaulting sign/option", () => {
    const rows = marshalSelectionTable([
      {
        name: "s_id",
        ranges: [{ low: "A" }, { sign: "E", option: "NE", low: "B" }, { option: "BT", low: "C", high: "M" }],
      },
    ]);
    expect(rows).toEqual([
      { selname: "S_ID", kind: "S", sign: "I", option: "EQ", low: "A", high: "" },
      { selname: "S_ID", kind: "S", sign: "E", option: "NE", low: "B", high: "" },
      { selname: "S_ID", kind: "S", sign: "I", option: "BT", low: "C", high: "M" },
    ]);
  });

  it("applies the declared type to every row of a ranged field", () => {
    const rows = marshalSelectionTable([
      { name: "s_num", type: "int", ranges: [{ option: "BT", low: "1", high: "10" }] },
    ]);
    expect(rows).toEqual([
      { selname: "S_NUM", kind: "S", sign: "I", option: "BT", low: "1", high: "10" },
    ]);
  });

  it("requires exactly one of value/ranges — refuses both and refuses neither", () => {
    expect(() =>
      marshalSelectionTable([{ name: "p_x", value: "a", ranges: [{ low: "b" }] } as RunParameterInput]),
    ).toThrowError(/must set exactly one of "value"/);
    expect(() => marshalSelectionTable([{ name: "p_x" } as RunParameterInput])).toThrowError(
      /must set exactly one of "value"/,
    );
  });

  it("refuses an empty ranges array — schema description and runtime rule stay pinned together", () => {
    const paramsArray = runInputSchema.parameters.unwrap();
    const rangesField = paramsArray.element.shape.ranges;
    expect(rangesField.description).toMatch(/non-empty/);
    expect(() => marshalSelectionTable([{ name: "s_id", ranges: [] }])).toThrowError(
      /ranges must be a non-empty array/,
    );
  });

  it("requires BT/NB to carry a high bound", () => {
    expect(() =>
      marshalSelectionTable([{ name: "s_id", ranges: [{ option: "BT", low: "A" }] }]),
    ).toThrowError(/requires a "high" bound/);
  });

  it("refuses a high bound on an operator that doesn't take one", () => {
    expect(() =>
      marshalSelectionTable([{ name: "s_id", ranges: [{ option: "EQ", low: "A", high: "Z" }] }]),
    ).toThrowError(/does not take a "high" bound/);
  });

  it("refuses an unknown option / sign", () => {
    expect(() =>
      marshalSelectionTable([{ name: "s_id", ranges: [{ option: "XX" as never, low: "A" }] }]),
    ).toThrowError(/not one of the ten standard/);
    expect(() =>
      marshalSelectionTable([{ name: "s_id", ranges: [{ sign: "Q" as never, low: "A" }] }]),
    ).toThrowError(/"I" \(include\) or "E" \(exclude\)/);
  });

  it("refuses a duplicate field name — a ranged field uses one entry with several rows", () => {
    expect(() =>
      marshalSelectionTable([
        { name: "p_x", value: "1" },
        { name: "p_x", value: "2" },
      ]),
    ).toThrowError(/duplicate/);
  });

  it("names the exact offending field/row in every thrown error's details", () => {
    try {
      marshalSelectionTable([{ name: "p_bad", type: "int", value: "not-a-number" }]);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isAbapError(e)).toBe(true);
      if (isAbapError(e)) {
        expect(e.code).toBe("BAD_INPUT");
        expect(e.message).toContain("P_BAD");
      }
    }
  });

  it("marshals the full realistic scenario: a value, a typed range, and a BT range together", () => {
    const rows = marshalSelectionTable([
      { name: "p_str", value: "acme" },
      { name: "p_num", type: "packed", value: "12.34" },
      { name: "p_date", type: "date", value: "2026-08-12" },
      {
        name: "s_id",
        ranges: [{ option: "BT", low: "AAA", high: "ZZZ" }],
      },
    ]);
    expect(rows).toEqual([
      { selname: "P_STR", kind: "P", sign: "I", option: "EQ", low: "acme", high: "" },
      { selname: "P_NUM", kind: "P", sign: "I", option: "EQ", low: "12.34", high: "" },
      { selname: "P_DATE", kind: "P", sign: "I", option: "EQ", low: "20260812", high: "" },
      { selname: "S_ID", kind: "S", sign: "I", option: "BT", low: "AAA", high: "ZZZ" },
    ]);
  });
});

describe("parseSelectionScreen", () => {
  it("finds PARAMETERS and SELECT-OPTIONS declarations, including a colon-chained list", () => {
    const source = `REPORT ztest.
PARAMETERS: p_str  TYPE c LENGTH 20,
            p_num  TYPE p DECIMALS 2,
            p_date TYPE d,
            p_reqd TYPE c OBLIGATORY.
SELECT-OPTIONS s_id FOR sy-uname.
START-OF-SELECTION.
  WRITE p_str.
`;
    const fields = parseSelectionScreen(source);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.P_STR).toMatchObject({ statement: "PARAMETERS", type: "c" });
    expect(byName.P_NUM).toMatchObject({ statement: "PARAMETERS", type: "p" });
    expect(byName.P_DATE).toMatchObject({ statement: "PARAMETERS", type: "d" });
    expect(byName.P_REQD).toMatchObject({ statement: "PARAMETERS", obligatory: true });
    expect(byName.S_ID).toMatchObject({ statement: "SELECT-OPTIONS" });
  });

  it("ignores declarations inside * and \" comments", () => {
    const source = `REPORT ztest.
* PARAMETERS: p_fake TYPE c.
PARAMETERS p_real TYPE c. " trailing comment, not p_trailing TYPE c
`;
    const fields = parseSelectionScreen(source);
    expect(fields.map((f) => f.name)).toEqual(["P_REAL"]);
  });

  it("returns an empty array for source with no selection screen, or empty input", () => {
    expect(parseSelectionScreen("REPORT ztest.\nWRITE 'hi'.\n")).toEqual([]);
    expect(parseSelectionScreen("")).toEqual([]);
  });
});

describe("selectionScreenNotes", () => {
  const parsed = parseSelectionScreen(
    "PARAMETERS: p_str TYPE c, p_reqd TYPE c OBLIGATORY.\nSELECT-OPTIONS s_id FOR sy-uname.\n",
  );

  it("is silent when every supplied name is found and every OBLIGATORY field is covered", () => {
    const notes = selectionScreenNotes(parsed, [
      { name: "p_str", value: "x" },
      { name: "p_reqd", value: "y" },
    ]);
    expect(notes).toEqual([]);
  });

  it("warns (not refuses) about a supplied name the parse did not find", () => {
    const notes = selectionScreenNotes(parsed, [{ name: "p_missing", value: "x" }]);
    expect(notes.some((n) => n.includes("P_MISSING") && n.includes("not found"))).toBe(true);
  });

  it("warns about an OBLIGATORY field left unsupplied", () => {
    const notes = selectionScreenNotes(parsed, [{ name: "p_str", value: "x" }]);
    expect(notes.some((n) => n.includes("P_REQD") && n.includes("OBLIGATORY"))).toBe(true);
  });

  it("adds a general caveat, not per-field noise, when the parse found nothing at all", () => {
    const notes = selectionScreenNotes([], [{ name: "p_str", value: "x" }]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("could not be parsed");
  });

  it("is silent when nothing was supplied, even if the parse found nothing", () => {
    expect(selectionScreenNotes([], [])).toEqual([]);
  });
});
