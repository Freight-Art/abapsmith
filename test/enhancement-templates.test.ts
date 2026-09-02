/**
 * Pure-function unit tests for `src/adt/enhancement-templates.ts` — the
 * closed set of six ABAP-generating templates plus their two shared
 * validation disciplines (`assertEnhIdentifier` for bare identifiers,
 * `assertAbapText`/`abapLiteral` for free text). No HTTP, no connection, no
 * classrun — every function here is a synchronous string generator, so these
 * tests call them directly and assert on the exact ABAP lines produced.
 *
 * `exerciseFragment`'s own coverage (FILTERS clause, no-parens `CALL BADI`,
 * and the per-kind local-variable declare/seed/pass/
 * read-back mechanism) lives in its own dedicated file,
 * `test/enhancement-exercise.test.ts` — that template grew enough surface
 * area (four parameter kinds, several refusal paths) to warrant a file of
 * its own rather than a describe block bolted onto this one. This file
 * covers the other five templates plus the shared helpers, and the
 * cross-tool `compare` operator aliasing.
 */
import { describe, expect, it } from "vitest";
import {
  assertEnhIdentifier,
  assertAbapText,
  abapLiteral,
  createSpotFragment,
  addBadiDefFragment,
  addFilterDefFragment,
  createImplFragment,
  setFilterValuesFragment,
} from "../src/adt/enhancement-templates.js";
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

// ---------------------------------------------------------------------------
// createSpotFragment
// ---------------------------------------------------------------------------

describe("createSpotFragment", () => {
  it("emits the factory call, SPOT-OBJECT-CREATED tag, and a shorttext write", () => {
    const lines = createSpotFragment({ spotName: "ZMCP_SPOT", description: "A spot" });
    const source = lines.join("\n");
    expect(source).toContain("cl_enh_factory=>create_enhancement_spot(");
    expect(source).toContain("spot_name = 'ZMCP_SPOT'");
    expect(source).toContain("out->write( 'SPOT-OBJECT-CREATED' ).");
    expect(source).toContain("lo_spot->if_enh_object_docu~set_shorttext( 'A spot' ).");
  });

  it("enforces the 60-character description limit (SAP's adtcore:description is CHAR60)", () => {
    const err = catchErr(() => createSpotFragment({ spotName: "ZMCP_SPOT", description: "A".repeat(61) }));
    expect(isAbapError(err)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// addBadiDefFragment — H20 (context_mode hardcode)
// ---------------------------------------------------------------------------

describe("addBadiDefFragment", () => {
  it("hardcodes context_mode = 'N' — H20, never a caller-supplied parameter", () => {
    const lines = addBadiDefFragment({
      badiName: "ZMCP_BADI",
      interfaceName: "ZIF_MCP_BADI",
      singleUse: true,
      shortText: "A BAdI",
    });
    expect(lines).toContain("ls_badi-context_mode = 'N'.");
    expect(lines.join("\n")).toContain("out->write( 'BADI-DEF-ADDED' ).");
  });

  it("emits abap_true/abap_false for singleUse, not a caller-controlled string", () => {
    const single = addBadiDefFragment({
      badiName: "ZMCP_BADI",
      interfaceName: "ZIF_MCP_BADI",
      singleUse: true,
      shortText: "A BAdI",
    });
    expect(single).toContain("ls_badi-single_use     = abap_true.");
    const multi = addBadiDefFragment({
      badiName: "ZMCP_BADI",
      interfaceName: "ZIF_MCP_BADI",
      singleUse: false,
      shortText: "A BAdI",
    });
    expect(multi).toContain("ls_badi-single_use     = abap_false.");
  });

  it("enforces the 60-character shortText limit", () => {
    const err = catchErr(() =>
      addBadiDefFragment({
        badiName: "ZMCP_BADI",
        interfaceName: "ZIF_MCP_BADI",
        singleUse: true,
        shortText: "A".repeat(61),
      }),
    );
    expect(isAbapError(err)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// addFilterDefFragment — filterType single-uppercase-letter constraint
// ---------------------------------------------------------------------------

describe("addFilterDefFragment", () => {
  it("accepts a single uppercase letter filterType", () => {
    const lines = addFilterDefFragment({
      badiName: "ZMCP_BADI",
      filterName: "CARRID",
      filterType: "C",
    });
    expect(lines.join("\n")).toContain("ls_filter-filter_type = 'C'.");
    expect(lines.join("\n")).toContain("out->write( 'FILTER-DEF-ADDED' ).");
  });

  it("rejects a multi-character filterType like CHAR10 (Defect 5's regression guard)", () => {
    const err = catchErr(() =>
      addFilterDefFragment({ badiName: "ZMCP_BADI", filterName: "CARRID", filterType: "CHAR10" }),
    );
    expect(isAbapError(err)).toBe(true);
    expect((err as { message: string }).message).toMatch(/single uppercase letter/);
  });

  it("rejects a lowercase filterType", () => {
    const err = catchErr(() =>
      addFilterDefFragment({ badiName: "ZMCP_BADI", filterName: "CARRID", filterType: "c" }),
    );
    expect(isAbapError(err)).toBe(true);
  });

  it("defaults filterText to an empty literal when omitted", () => {
    const lines = addFilterDefFragment({ badiName: "ZMCP_BADI", filterName: "CARRID", filterType: "C" });
    expect(lines.join("\n")).toContain("ls_filter-filtertext  = ''.");
  });

  it("enforces the 255-character filterText limit when supplied", () => {
    const err = catchErr(() =>
      addFilterDefFragment({
        badiName: "ZMCP_BADI",
        filterName: "CARRID",
        filterType: "C",
        filterText: "A".repeat(256),
      }),
    );
    expect(isAbapError(err)).toBe(true);
  });

  it("deletes then re-adds the BAdI def (edit-in-place is not supported by IF_ENH_TOOL_BADI_DEF)", () => {
    const lines = addFilterDefFragment({ badiName: "ZMCP_BADI", filterName: "CARRID", filterType: "C" });
    const getIdx = lines.findIndex((l) => l.includes("get_badi_def"));
    const delIdx = lines.findIndex((l) => l.includes("delete_badi_def"));
    const addIdx = lines.findIndex((l) => l.includes("add_badi_def"));
    expect(getIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(getIdx);
    expect(addIdx).toBeGreaterThan(delIdx);
  });
});

// ---------------------------------------------------------------------------
// createImplFragment
// ---------------------------------------------------------------------------

describe("createImplFragment", () => {
  it("emits ENHO-OBJECT-CREATED then IMPL-ADDED, with a shorttext write in between", () => {
    const lines = createImplFragment({
      enhName: "ZMCP_ENH_B",
      spotName: "ZMCP_SPOT",
      badiName: "ZMCP_BADI",
      implName: "ZMCP_IMPL",
      implClass: "ZCL_MCP_IMPL",
      active: true,
      description: "An implementation",
    });
    const source = lines.join("\n");
    const createdIdx = lines.findIndex((l) => l.includes("ENHO-OBJECT-CREATED"));
    const shorttextIdx = lines.findIndex((l) => l.includes("set_shorttext"));
    const addedIdx = lines.findIndex((l) => l.includes("IMPL-ADDED"));
    expect(createdIdx).toBeGreaterThanOrEqual(0);
    expect(shorttextIdx).toBeGreaterThan(createdIdx);
    expect(addedIdx).toBeGreaterThan(shorttextIdx);
    expect(source).toContain("ls_impl-active     = abap_true.");
  });

  it("enforces the 60-character description limit (root cause of the unwritable-object hole)", () => {
    const err = catchErr(() =>
      createImplFragment({
        enhName: "ZMCP_ENH_B",
        spotName: "ZMCP_SPOT",
        badiName: "ZMCP_BADI",
        implName: "ZMCP_IMPL",
        implClass: "ZCL_MCP_IMPL",
        active: true,
        description: "A".repeat(61),
      }),
    );
    expect(isAbapError(err)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setFilterValuesFragment — H24 (never writes ls_impl-filters) + compare
// operator dual-convention acceptance (Defect 4)
// ---------------------------------------------------------------------------

describe("setFilterValuesFragment", () => {
  const base = { implName: "ZMCP_IMPL", filterName: "CARRID", filterType: "C", value: "LH" };

  it("never assigns ls_impl-filters directly (H24 — that field is server-derived)", () => {
    const lines = setFilterValuesFragment({ ...base, compare: "=" });
    const source = lines.join("\n");
    expect(source).not.toMatch(/^\s*ls_impl-filters\s*=/m);
    expect(source).toContain("CLEAR: ls_impl-filters, ls_impl-filter_values, ls_impl-filter_root, ls_impl-filter_tree.");
  });

  it("deletes then re-adds the implementation (add_implementation means create-new, not modify)", () => {
    const lines = setFilterValuesFragment({ ...base, compare: "=" });
    const getIdx = lines.findIndex((l) => l.includes("get_implementation"));
    const delIdx = lines.findIndex((l) => l.includes("delete_implementation"));
    const addIdx = lines.findIndex((l) => l.includes("add_implementation"));
    expect(delIdx).toBeGreaterThan(getIdx);
    expect(addIdx).toBeGreaterThan(delIdx);
  });

  it("accepts the symbolic operator '=' directly (the only one this codebase has live evidence for)", () => {
    const lines = setFilterValuesFragment({ ...base, compare: "=" });
    expect(lines.join("\n")).toContain("ls_val-compare            = '='.");
  });

  // Defect 4: set_filter_values previously required symbolic operators only,
  // rejecting EQ/NE/etc, while abap_run's ranges.option uses the opposite
  // (two-letter SELECT-OPTIONS) convention for the identical six relations.
  // Rather than force callers to remember which sibling tool wants which
  // spelling, both are now accepted and normalized to the symbolic form the
  // generated ABAP literal actually needs.
  it.each([
    ["EQ", "="],
    ["NE", "<>"],
    ["LT", "<"],
    ["LE", "<="],
    ["GT", ">"],
    ["GE", ">="],
  ])("normalizes abap_run-style '%s' to symbolic '%s'", (alias, symbolic) => {
    const lines = setFilterValuesFragment({ ...base, compare: alias });
    expect(lines.join("\n")).toContain(`ls_val-compare            = '${symbolic}'.`);
  });

  it("still rejects CP/NP/BT/NB — genuinely different relations with no live evidence here", () => {
    for (const bogus of ["CP", "NP", "BT", "NB"]) {
      const err = catchErr(() => setFilterValuesFragment({ ...base, compare: bogus }));
      expect(isAbapError(err)).toBe(true);
    }
  });

  it("rejects an unrecognized compare operator with a clear allowlist message", () => {
    const err = catchErr(() => setFilterValuesFragment({ ...base, compare: "~=" }));
    expect(isAbapError(err)).toBe(true);
    expect((err as { message: string }).message).toMatch(/not one of the operators/);
  });

  it("enforces the 255-character value limit", () => {
    const err = catchErr(() => setFilterValuesFragment({ ...base, compare: "=", value: "A".repeat(256) }));
    expect(isAbapError(err)).toBe(true);
  });

  it("rejects a multi-character filterType (same CHAR10 regression guard as addFilterDefFragment)", () => {
    const err = catchErr(() => setFilterValuesFragment({ ...base, compare: "=", filterType: "CHAR10" }));
    expect(isAbapError(err)).toBe(true);
  });
});
