/**
 * Pure-function unit tests for `exerciseFragment` (`src/adt/
 * enhancement-templates.ts`) — split out from `test/enhancement-templates.
 * test.ts` (which covers the other five templates) because this fix
 * needed enough new coverage to warrant its own
 * file. No HTTP, no connection, no classrun — `exerciseFragment` is a
 * synchronous string generator, so every test here calls it directly and
 * asserts on the exact ABAP lines produced.
 *
 * Root cause pinned here: `exerciseFragment` used to pass EVERY parameter
 * value as a bare ABAP literal (`abapLiteral(param.value)`), including ones
 * bound for the `CHANGING` clause. ABAP refuses a literal as the actual
 * parameter for a modifiable formal parameter — confirmed live:
 * `CALL BADI lo_badi->M_CHG CHANGING CV_TXT = 'CHG-PROBE-1'.` and
 * `CALL BADI lo_badi->M_MIX EXPORTING IV_TXT = 'MIX-EXP-1' CHANGING
 * CV_TXT = 'MIX-CHG-1'.` both failed activation with "field cannot be
 * modified" — so no `exercise` call could ever dispatch a method with a
 * CHANGING parameter. The M_CHG/M_MIX method names and literal values in
 * the tests below are taken directly from that live evidence.
 */
import { describe, expect, it } from "vitest";
import { exerciseFragment } from "../src/adt/enhancement-templates.js";
import { isAbapError } from "../src/adt/errors.js";

function catchErr(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

function message(err: unknown): string {
  return String((err as { message: unknown }).message);
}

// ---------------------------------------------------------------------------
// Regression pins — shapes exerciseFragment already generated correctly
// before this fix must not move at all.
// ---------------------------------------------------------------------------

describe("exerciseFragment — regression pins (unchanged shapes)", () => {
  it("no-parameter call is byte-for-byte unchanged", () => {
    const lines = exerciseFragment({ badiName: "ZMCP_BADI", methodName: "RUN", params: [] });
    expect(lines).toEqual([
      "DATA lo_badi TYPE REF TO ZMCP_BADI.",
      "GET BADI lo_badi.",
      "IF lo_badi IS BOUND.",
      "  CALL BADI lo_badi->RUN.",
      "  out->write( 'EXERCISED' ).",
      "ELSE.",
      "  out->write( 'NOT-BOUND' ).",
      "ENDIF.",
    ]);
  });

  it("importing-only params are byte-for-byte unchanged (kind omitted, defaults to importing)", () => {
    const lines = exerciseFragment({
      badiName: "ZMCP_BADI",
      methodName: "RUN",
      params: [{ name: "IV_TXT", value: "hello" }],
    });
    expect(lines).toEqual([
      "DATA lo_badi TYPE REF TO ZMCP_BADI.",
      "GET BADI lo_badi.",
      "IF lo_badi IS BOUND.",
      "  CALL BADI lo_badi->RUN EXPORTING IV_TXT = 'hello'.",
      "  out->write( 'EXERCISED' ).",
      "ELSE.",
      "  out->write( 'NOT-BOUND' ).",
      "ENDIF.",
    ]);
  });

  it("importing-only params are byte-for-byte unchanged (kind explicit)", () => {
    const lines = exerciseFragment({
      badiName: "ZMCP_BADI",
      methodName: "RUN",
      params: [{ name: "IV_TXT", kind: "importing", value: "hello" }],
    });
    expect(lines[3]).toBe("  CALL BADI lo_badi->RUN EXPORTING IV_TXT = 'hello'.");
    // No local variable, no read-back line, for an importing-only call.
    expect(lines.join("\n")).not.toContain("DATA lv_");
    expect(lines.join("\n")).not.toContain("RESULT>");
  });

  it("FILTERS clause shape is unchanged", () => {
    const lines = exerciseFragment({
      badiName: "ZMCP_BADI",
      methodName: "RUN",
      filterName: "FLT",
      filterValue: "LH",
      params: [],
    });
    expect(lines[1]).toBe("GET BADI lo_badi FILTERS FLT = 'LH'.");
  });
});

// ---------------------------------------------------------------------------
// The fix itself — CHANGING (and EXPORTING-from-callee / RECEIVING) params
// get a real local variable, never a literal, in a modifiable clause.
// ---------------------------------------------------------------------------

describe("exerciseFragment — kind:\"changing\" (the defect's exact live-evidence shape)", () => {
  it("declares a local, seeds it, passes the VARIABLE (not a literal) in CHANGING, and reads it back", () => {
    const lines = exerciseFragment({
      badiName: "ZMCP_BADI",
      methodName: "M_CHG",
      params: [{ name: "CV_TXT", kind: "changing", value: "CHG-PROBE-1", type: "STRING" }],
    });
    expect(lines).toEqual([
      "DATA lo_badi TYPE REF TO ZMCP_BADI.",
      "GET BADI lo_badi.",
      "DATA lv_cv_txt TYPE STRING.",
      "lv_cv_txt = 'CHG-PROBE-1'.",
      "IF lo_badi IS BOUND.",
      "  CALL BADI lo_badi->M_CHG CHANGING CV_TXT = lv_cv_txt.",
      "  out->write( 'EXERCISED' ).",
      "  out->write( |RESULT>CV_TXT={ lv_cv_txt }| ).",
      "ELSE.",
      "  out->write( 'NOT-BOUND' ).",
      "ENDIF.",
    ]);
    const source = lines.join("\n");
    // The exact defect: a literal must never appear as the CHANGING actual parameter.
    expect(source).not.toContain("CHANGING CV_TXT = 'CHG-PROBE-1'");
  });
});

describe("exerciseFragment — mixed importing + changing (the M_MIX live-evidence shape)", () => {
  it("passes the importing arg as a literal and the changing arg as a variable", () => {
    const lines = exerciseFragment({
      badiName: "ZMCP_BADI",
      methodName: "M_MIX",
      params: [
        { name: "IV_TXT", value: "MIX-EXP-1" },
        { name: "CV_TXT", kind: "changing", value: "MIX-CHG-1", type: "STRING" },
      ],
    });
    expect(lines).toEqual([
      "DATA lo_badi TYPE REF TO ZMCP_BADI.",
      "GET BADI lo_badi.",
      "DATA lv_cv_txt TYPE STRING.",
      "lv_cv_txt = 'MIX-CHG-1'.",
      "IF lo_badi IS BOUND.",
      "  CALL BADI lo_badi->M_MIX EXPORTING IV_TXT = 'MIX-EXP-1' CHANGING CV_TXT = lv_cv_txt.",
      "  out->write( 'EXERCISED' ).",
      "  out->write( |RESULT>CV_TXT={ lv_cv_txt }| ).",
      "ELSE.",
      "  out->write( 'NOT-BOUND' ).",
      "ENDIF.",
    ]);
  });
});

describe('exerciseFragment — kind:"exporting" (callee-writes, call-site IMPORTING clause)', () => {
  it("declares a local (unseeded), passes it in the call-site IMPORTING clause, and reads it back", () => {
    const lines = exerciseFragment({
      badiName: "ZMCP_BADI",
      methodName: "M_EXP",
      params: [{ name: "EV_TXT", kind: "exporting", type: "STRING" }],
    });
    expect(lines).toEqual([
      "DATA lo_badi TYPE REF TO ZMCP_BADI.",
      "GET BADI lo_badi.",
      "DATA lv_ev_txt TYPE STRING.",
      "IF lo_badi IS BOUND.",
      "  CALL BADI lo_badi->M_EXP IMPORTING EV_TXT = lv_ev_txt.",
      "  out->write( 'EXERCISED' ).",
      "  out->write( |RESULT>EV_TXT={ lv_ev_txt }| ).",
      "ELSE.",
      "  out->write( 'NOT-BOUND' ).",
      "ENDIF.",
    ]);
    // No seed line for an exporting-only param — nothing to seed with.
    expect(lines).not.toContain("lv_ev_txt = ");
  });
});

describe('exerciseFragment — kind:"receiving" (RETURNING parameter via classic RECEIVING clause)', () => {
  it("declares a local, passes it in RECEIVING, and reads it back", () => {
    const lines = exerciseFragment({
      badiName: "ZMCP_BADI",
      methodName: "M_RET",
      params: [{ name: "RESULT", kind: "receiving", type: "STRING" }],
    });
    expect(lines).toEqual([
      "DATA lo_badi TYPE REF TO ZMCP_BADI.",
      "GET BADI lo_badi.",
      "DATA lv_result TYPE STRING.",
      "IF lo_badi IS BOUND.",
      "  CALL BADI lo_badi->M_RET RECEIVING RESULT = lv_result.",
      "  out->write( 'EXERCISED' ).",
      "  out->write( |RESULT>RESULT={ lv_result }| ).",
      "ELSE.",
      "  out->write( 'NOT-BOUND' ).",
      "ENDIF.",
    ]);
  });
});

describe("exerciseFragment — all four kinds together, in a single call", () => {
  it("emits clauses in EXPORTING/IMPORTING/CHANGING/RECEIVING order, locals for every non-importing kind", () => {
    const lines = exerciseFragment({
      badiName: "ZMCP_BADI",
      methodName: "M_ALL",
      params: [
        { name: "IV_TXT", value: "in-1" },
        { name: "EV_TXT", kind: "exporting", type: "STRING" },
        { name: "CV_TXT", kind: "changing", value: "chg-1", type: "STRING" },
        { name: "RESULT", kind: "receiving", type: "STRING" },
      ],
    });
    expect(lines).toEqual([
      "DATA lo_badi TYPE REF TO ZMCP_BADI.",
      "GET BADI lo_badi.",
      "DATA lv_ev_txt TYPE STRING.",
      "DATA lv_cv_txt TYPE STRING.",
      "DATA lv_result TYPE STRING.",
      "lv_cv_txt = 'chg-1'.",
      "IF lo_badi IS BOUND.",
      "  CALL BADI lo_badi->M_ALL EXPORTING IV_TXT = 'in-1' IMPORTING EV_TXT = lv_ev_txt CHANGING " +
        "CV_TXT = lv_cv_txt RECEIVING RESULT = lv_result.",
      "  out->write( 'EXERCISED' ).",
      "  out->write( |RESULT>EV_TXT={ lv_ev_txt }| ).",
      "  out->write( |RESULT>CV_TXT={ lv_cv_txt }| ).",
      "  out->write( |RESULT>RESULT={ lv_result }| ).",
      "ELSE.",
      "  out->write( 'NOT-BOUND' ).",
      "ENDIF.",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Refusals — the generator must never emit ABAP it knows won't compile; a
// caller error here is a client-side BAD_INPUT, before any network call.
// ---------------------------------------------------------------------------

describe("exerciseFragment — refuses rather than guesses", () => {
  it('rejects an unknown kind', () => {
    const err = catchErr(() =>
      exerciseFragment({ badiName: "Z", methodName: "M", params: [{ name: "X", kind: "bogus" as never, value: "v" }] }),
    );
    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("BAD_INPUT");
    expect(message(err)).toContain("kind");
    expect(message(err)).toContain('"importing"');
  });

  it('requires "value" for kind:"importing"', () => {
    const err = catchErr(() => exerciseFragment({ badiName: "Z", methodName: "M", params: [{ name: "X" }] }));
    expect(isAbapError(err)).toBe(true);
    expect(message(err)).toContain("value");
  });

  it('requires "value" for kind:"changing"', () => {
    const err = catchErr(() =>
      exerciseFragment({ badiName: "Z", methodName: "M", params: [{ name: "X", kind: "changing", type: "STRING" }] }),
    );
    expect(isAbapError(err)).toBe(true);
    expect(message(err)).toContain("value");
  });

  it('refuses a "value" supplied for kind:"exporting" (callee determines it, nothing to seed)', () => {
    const err = catchErr(() =>
      exerciseFragment({
        badiName: "Z",
        methodName: "M",
        params: [{ name: "X", kind: "exporting", type: "STRING", value: "should-not-be-here" }],
      }),
    );
    expect(isAbapError(err)).toBe(true);
    expect(message(err)).toContain('must not supply "value"');
  });

  it('refuses a "value" supplied for kind:"receiving"', () => {
    const err = catchErr(() =>
      exerciseFragment({
        badiName: "Z",
        methodName: "M",
        params: [{ name: "X", kind: "receiving", type: "STRING", value: "should-not-be-here" }],
      }),
    );
    expect(isAbapError(err)).toBe(true);
    expect(message(err)).toContain('must not supply "value"');
  });

  it('requires "type" for kind:"changing"', () => {
    const err = catchErr(() =>
      exerciseFragment({ badiName: "Z", methodName: "M", params: [{ name: "X", kind: "changing", value: "v" }] }),
    );
    expect(isAbapError(err)).toBe(true);
    expect(message(err)).toContain('"type"');
  });

  it('requires "type" for kind:"exporting"', () => {
    const err = catchErr(() =>
      exerciseFragment({ badiName: "Z", methodName: "M", params: [{ name: "X", kind: "exporting" }] }),
    );
    expect(isAbapError(err)).toBe(true);
    expect(message(err)).toContain('"type"');
  });

  it('requires "type" for kind:"receiving"', () => {
    const err = catchErr(() =>
      exerciseFragment({ badiName: "Z", methodName: "M", params: [{ name: "X", kind: "receiving" }] }),
    );
    expect(isAbapError(err)).toBe(true);
    expect(message(err)).toContain('"type"');
  });

  it('refuses a "type" supplied for kind:"importing" (no local variable is declared for it)', () => {
    const err = catchErr(() =>
      exerciseFragment({
        badiName: "Z",
        methodName: "M",
        params: [{ name: "X", value: "v", type: "STRING" }],
      }),
    );
    expect(isAbapError(err)).toBe(true);
    expect(message(err)).toContain('must not supply "type"');
  });

  it("rejects a duplicate parameter name (exact match)", () => {
    const err = catchErr(() =>
      exerciseFragment({
        badiName: "Z",
        methodName: "M",
        params: [
          { name: "X", value: "a" },
          { name: "X", value: "b" },
        ],
      }),
    );
    expect(isAbapError(err)).toBe(true);
    expect(message(err)).toContain("more than once");
  });

  it("rejects a duplicate parameter name that differs only by case (ABAP identifiers are case-insensitive)", () => {
    const err = catchErr(() =>
      exerciseFragment({
        badiName: "Z",
        methodName: "M",
        params: [
          { name: "CV_TXT", kind: "changing", value: "a", type: "STRING" },
          { name: "cv_txt", kind: "changing", value: "b", type: "STRING" },
        ],
      }),
    );
    expect(isAbapError(err)).toBe(true);
    expect(message(err)).toContain("more than once");
  });

  it('rejects more than one kind:"receiving" param (a method has at most one RETURNING parameter)', () => {
    const err = catchErr(() =>
      exerciseFragment({
        badiName: "Z",
        methodName: "M",
        params: [
          { name: "R1", kind: "receiving", type: "STRING" },
          { name: "R2", kind: "receiving", type: "STRING" },
        ],
      }),
    );
    expect(isAbapError(err)).toBe(true);
    expect(message(err)).toContain("at most one");
  });

  it("rejects a params[].type that is not a valid bare ABAP identifier (no compound type expressions)", () => {
    const err = catchErr(() =>
      exerciseFragment({
        badiName: "Z",
        methodName: "M",
        params: [{ name: "X", kind: "changing", value: "v", type: "ZCL_FOO=>TY_BAR" }],
      }),
    );
    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("BAD_INPUT");
  });
});
