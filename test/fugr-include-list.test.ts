/**
 * Pre-send guard for the FUGR/F missing-implementation-include defect.
 *
 * A function group's `/source/main` is not ABAP code — it is SE37's
 * generated include list:
 *
 *   INCLUDE LZMY_GROUPTOP.
 *   INCLUDE LZMY_GROUPUXX.
 *
 * `L<GROUP>UXX` is what actually pulls the function-module implementation
 * includes (`U01`, `U02`, …) into the compiled unit. A caller who PUTs only
 * the TOP line gets a group that writes, activates, and reads back as
 * active — but every `CALL FUNCTION` against it dumps
 * `CX_SY_DYN_CALL_ILLEGAL_FUNC`. `assertFunctionGroupImplementationInclude`
 * in src/adt/write.ts refuses such a payload before it is sent, rather than
 * silently rewriting caller-authored source.
 */
import { describe, expect, it } from "vitest";
import { assertFunctionGroupImplementationInclude, type ResolvedTarget } from "../src/adt/write.js";
import { isAbapError } from "../src/adt/errors.js";

function target(type: string, name = "ZFGFIX_G1"): ResolvedTarget {
  return {
    spec: { type, kind: type.split("/")[0], label: type.split("/")[0], uriPath: "x", mode: "source" },
    type,
    name,
    uri: `/sap/bc/adt/functions/groups/${name.toLowerCase()}`,
  } as unknown as ResolvedTarget;
}

describe("a FUGR/F main source must name an implementation include", () => {
  it("refuses a TOP-only source, reporting the missing UXX include", () => {
    const source = "  INCLUDE LZFGFIX_G1TOP.\n";
    expect(() => assertFunctionGroupImplementationInclude(target("FUGR/F"), source)).toThrow();
    try {
      assertFunctionGroupImplementationInclude(target("FUGR/F"), source);
      throw new Error("expected throw");
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("BAD_INPUT");
      expect(isAbapError(e) ? e.message : "").toMatch(/no implementation include|LZFGFIX_G1UXX/);
      const details = isAbapError(e) ? (e.details as Record<string, unknown> | undefined) : undefined;
      expect(details?.topInclude).toBe("LZFGFIX_G1TOP");
      expect(details?.missingInclude).toBe("LZFGFIX_G1UXX");
    }
  });

  it("refuses a lower-case TOP-only source, uppercasing topInclude in the details", () => {
    const source = "include lzfgfix_g1top.\n";
    try {
      assertFunctionGroupImplementationInclude(target("FUGR/F"), source);
      throw new Error("expected throw");
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("BAD_INPUT");
      const details = isAbapError(e) ? (e.details as Record<string, unknown> | undefined) : undefined;
      expect(details?.topInclude).toBe("LZFGFIX_G1TOP");
      expect(details?.missingInclude).toBe("LZFGFIX_G1UXX");
    }
  });

  it("refuses when the UXX line is present but commented out with a full-line *", () => {
    const source = "  INCLUDE LZFGFIX_G1TOP.\n*  INCLUDE LZFGFIX_G1UXX.\n";
    expect(() => assertFunctionGroupImplementationInclude(target("FUGR/F"), source)).toThrow();
  });

  it("refuses when the UXX line is present but only inside an end-of-line comment", () => {
    const source = '  INCLUDE LZFGFIX_G1TOP. " INCLUDE LZFGFIX_G1UXX.\n';
    expect(() => assertFunctionGroupImplementationInclude(target("FUGR/F"), source)).toThrow();
  });

  it("accepts the canonical SE37-generated TOP/UXX pair", () => {
    const source = "  INCLUDE LZFGFIX_G1TOP.\n  INCLUDE LZFGFIX_G1UXX.\n";
    expect(() => assertFunctionGroupImplementationInclude(target("FUGR/F"), source)).not.toThrow();
  });

  it("accepts the canonical pair lower-cased", () => {
    const source = "include lzfgfix_g1top.\ninclude lzfgfix_g1uxx.\n";
    expect(() => assertFunctionGroupImplementationInclude(target("FUGR/F"), source)).not.toThrow();
  });

  it("accepts individually-listed implementation includes in place of UXX", () => {
    const source = "  INCLUDE LZFGFIX_G1TOP.\n  INCLUDE LZFGFIX_G1U01.\n  INCLUDE LZFGFIX_G1U02.\n";
    expect(() => assertFunctionGroupImplementationInclude(target("FUGR/F"), source)).not.toThrow();
  });

  it("does not fire when there is no TOP include at all", () => {
    expect(() =>
      assertFunctionGroupImplementationInclude(target("FUGR/F"), "  INCLUDE LZFGFIX_G1UXX.\n"),
    ).not.toThrow();
    expect(() => assertFunctionGroupImplementationInclude(target("FUGR/F"), "")).not.toThrow();
  });

  it("does not fire for a non-FUGR/F target, even with a TOP-only source", () => {
    const source = "  INCLUDE LZFGFIX_G1TOP.\n";
    expect(() => assertFunctionGroupImplementationInclude(target("PROG/P"), source)).not.toThrow();
  });
});
