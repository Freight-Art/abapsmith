/**
 * Pure-function unit tests for `src/adt/enhancement-templates.ts`'s surviving
 * shared validation disciplines (`assertEnhIdentifier` for bare identifiers,
 * `assertAbapText`/`abapLiteral` for free text). No HTTP, no connection, no
 * classrun.
 *
 * The five ABAP-generating templates this file used to cover
 * (`createSpotFragment`, `addBadiDefFragment`, `addFilterDefFragment`,
 * `createImplFragment`, `setFilterValuesFragment`) are gone — the five
 * `abap_enh` operations they backed now dispatch through the static fluid
 * body `ZCL_ZMCP_FLUID_ENH` instead (see `src/adt/enhancement-bridge.ts`'s
 * module doc comment); their coverage moved to `test/enhancement-bridge.test.ts`
 * and `test/enhancement-tools.test.ts`, which assert on the dispatched action
 * and args rather than generated ABAP lines. `exerciseFragment` is the only
 * template left — its own coverage (FILTERS clause, no-parens `CALL BADI`,
 * and the per-kind local-variable declare/seed/pass/read-back mechanism)
 * lives in its own dedicated file, `test/enhancement-exercise.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { assertEnhIdentifier, assertAbapText, abapLiteral } from "../src/adt/enhancement-templates.js";
import { isAbapError } from "../src/adt/errors.js";

function catchErr(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

// ---------------------------------------------------------------------------
// assertEnhIdentifier / assertAbapText / abapLiteral — shared H50 defence
// ---------------------------------------------------------------------------

describe("assertEnhIdentifier", () => {
  it("accepts a plain identifier", () => {
    expect(assertEnhIdentifier("ZMCP_BADI", "badiName")).toBe("ZMCP_BADI");
  });

  it("rejects a period (statement-injection risk)", () => {
    const err = catchErr(() => assertEnhIdentifier("ZMCP.BADI", "badiName"));
    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("BAD_INPUT");
  });

  it("rejects a quote", () => {
    const err = catchErr(() => assertEnhIdentifier("ZMCP'BADI", "badiName"));
    expect(isAbapError(err)).toBe(true);
  });

  it("rejects a newline", () => {
    const err = catchErr(() => assertEnhIdentifier("ZMCP\nBADI", "badiName"));
    expect(isAbapError(err)).toBe(true);
  });

  it("rejects a name over the default 30-char max", () => {
    const err = catchErr(() => assertEnhIdentifier("Z" + "A".repeat(30), "badiName"));
    expect(isAbapError(err)).toBe(true);
  });
});

describe("assertAbapText", () => {
  it("accepts text at exactly the limit", () => {
    const s = "A".repeat(60);
    expect(assertAbapText(s, "description", 60)).toBe(s);
  });

  it("rejects text one character over the limit", () => {
    const err = catchErr(() => assertAbapText("A".repeat(61), "description", 60));
    expect(isAbapError(err)).toBe(true);
    expect((err as { message: string }).message).toMatch(/60-character limit/);
  });

  it("rejects an embedded newline (would corrupt the generated source's line structure)", () => {
    const err = catchErr(() => assertAbapText("line1\nline2", "description", 60));
    expect(isAbapError(err)).toBe(true);
    expect((err as { message: string }).message).toMatch(/control character/);
  });
});

describe("abapLiteral", () => {
  it("doubles an embedded single quote (standard ABAP '' escape)", () => {
    expect(abapLiteral("O'Brien")).toBe("'O''Brien'");
  });

  it("wraps plain text in single quotes", () => {
    expect(abapLiteral("hello")).toBe("'hello'");
  });
});
