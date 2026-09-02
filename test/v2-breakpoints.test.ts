/**
 * `parseBreakpoints`: pure, offline coverage of the `breakpoints: string[]`
 * grammar v2's `abap_debug` uses — `target(#skipCount)?(?condition)?`. See
 * src/tools/v2/breakpoints.ts's header for the full grammar.
 */
import { describe, expect, it } from "vitest";
import { isAbapError } from "../src/adt/errors.js";
import { parseBreakpoints } from "../src/tools/v2/breakpoints.js";
import type { DebugInput } from "../src/tools/debug.js";

// v1's own breakpoint element type — the parser's output must be assignable
// to this without a cast, proving the shapes match exactly.
type V1Breakpoint = NonNullable<DebugInput["breakpoints"]>[number];

describe("parseBreakpoints", () => {
  // -------------------------------------------------------------- targets ---

  it("parses OBJECT:LINE into a v1 line breakpoint", () => {
    const { breakpoints, notes } = parseBreakpoints(["ZCL_FOO:10"]);
    expect(notes).toEqual([]);
    expect(breakpoints).toHaveLength(1);
    const bp = breakpoints[0]!;
    expect(bp.kind).toBe("line");
    if (bp.kind === "line") {
      expect(bp.object).toBe("ZCL_FOO");
      expect(bp.line).toBe(10);
      expect(bp.condition).toBeUndefined();
      expect(bp.skipCount).toBeUndefined();
    }
  });

  it("splits OBJECT:LINE on the LAST colon, so the object may itself contain colons", () => {
    const { breakpoints } = parseBreakpoints(["class ZCL_FOO=>METH:10"]);
    const bp = breakpoints[0]!;
    expect(bp.kind).toBe("line");
    if (bp.kind === "line") {
      expect(bp.object).toBe("class ZCL_FOO=>METH");
      expect(bp.line).toBe(10);
    }
  });

  it("parses exception:CLASSNAME into a v1 exception breakpoint", () => {
    const { breakpoints, notes } = parseBreakpoints(["exception:CX_SY_ZERODIVIDE"]);
    expect(notes).toEqual([]);
    const bp = breakpoints[0]!;
    expect(bp.kind).toBe("exception");
    if (bp.kind === "exception") {
      expect(bp.exceptionClass).toBe("CX_SY_ZERODIVIDE");
      expect(bp.condition).toBeUndefined();
      expect(bp.skipCount).toBeUndefined();
    }
  });

  it("matches the 'exception:' keyword case-insensitively", () => {
    const { breakpoints } = parseBreakpoints(["EXCEPTION:CX_SY_ZERODIVIDE"]);
    expect(breakpoints[0]!.kind).toBe("exception");
  });

  // ------------------------------------------------------------- skipCount ---

  it("parses a #skipCount suffix on a line breakpoint", () => {
    const { breakpoints } = parseBreakpoints(["ZCL_FOO:10#5"]);
    const bp = breakpoints[0]!;
    expect(bp.kind).toBe("line");
    if (bp.kind === "line") {
      expect(bp.line).toBe(10);
      expect(bp.skipCount).toBe(5);
    }
  });

  it("parses a #skipCount suffix on an exception breakpoint", () => {
    const { breakpoints } = parseBreakpoints(["exception:CX_SY_ZERODIVIDE#3"]);
    const bp = breakpoints[0]!;
    expect(bp.kind).toBe("exception");
    if (bp.kind === "exception") expect(bp.skipCount).toBe(3);
  });

  it("skipCount: 0 ('break on every hit') survives — the single most likely silent regression", () => {
    const { breakpoints } = parseBreakpoints(["ZCL_FOO:10#0"]);
    const bp = breakpoints[0]!;
    expect(bp.kind).toBe("line");
    if (bp.kind === "line") {
      // Explicitly NOT a truthiness check: `expect(bp.skipCount).toBeFalsy()`
      // would also pass for `undefined`, which is exactly the bug this test
      // exists to catch. skipCount:0 must be present and equal to 0.
      expect(bp.skipCount).not.toBeUndefined();
      expect(bp.skipCount).toBe(0);
    }
  });

  it("rejects a skipCount above the v1 bound (1_000_000)", () => {
    expect(() => parseBreakpoints(["ZCL_FOO:10#1000001"])).toThrow();
    try {
      parseBreakpoints(["ZCL_FOO:10#1000001"]);
      expect.unreachable();
    } catch (e) {
      expect(isAbapError(e)).toBe(true);
      if (isAbapError(e)) expect(e.code).toBe("BAD_INPUT");
    }
  });

  // ------------------------------------------------------------- condition ---

  it("parses a ?condition on a line breakpoint", () => {
    const { breakpoints } = parseBreakpoints(["ZCL_FOO:10?sy-tabix = 500"]);
    const bp = breakpoints[0]!;
    expect(bp.kind).toBe("line");
    if (bp.kind === "line") expect(bp.condition).toBe("sy-tabix = 500");
  });

  it("takes everything after the first '?' verbatim to end-of-string, even embedded '?'", () => {
    const { breakpoints } = parseBreakpoints(["ZCL_FOO:10?lv_x = 'a?b?c'"]);
    const bp = breakpoints[0]!;
    if (bp.kind === "line") expect(bp.condition).toBe("lv_x = 'a?b?c'");
  });

  it("parses skipCount BEFORE condition together, in that order", () => {
    const { breakpoints } = parseBreakpoints(["ZCL_FOO:10#5?sy-tabix = 500"]);
    const bp = breakpoints[0]!;
    if (bp.kind === "line") {
      expect(bp.skipCount).toBe(5);
      expect(bp.condition).toBe("sy-tabix = 500");
    }
  });

  it("does not hard-fail a condition that looks like a misplaced trailing #skipCount — discloses via notes instead", () => {
    const { breakpoints, notes } = parseBreakpoints(["ZCL_FOO:10?sy-tabix = 500#5"]);
    const bp = breakpoints[0]!;
    // The entire tail is the condition, verbatim — never re-split.
    if (bp.kind === "line") {
      expect(bp.condition).toBe("sy-tabix = 500#5");
      expect(bp.skipCount).toBeUndefined();
    }
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/misplaced/i);
    expect(notes[0]).toContain("breakpoints[0]");
  });

  it("rejects an empty condition after '?'", () => {
    expect(() => parseBreakpoints(["ZCL_FOO:10?"])).toThrow();
  });

  // ------------------------------------------------------- all-or-nothing ---

  it("aborts the ENTIRE parse on the first malformed entry — a valid entry before it is never armed", () => {
    let threw: unknown;
    try {
      parseBreakpoints(["ZCL_FOO:10", "not-a-valid-target"]);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();
    expect(isAbapError(threw)).toBe(true);
    if (isAbapError(threw)) {
      expect(threw.code).toBe("BAD_INPUT");
      expect(threw.details.index).toBe(1);
      expect(threw.details.raw).toBe("not-a-valid-target");
    }
  });

  it("aborts even when the malformed entry comes first, before a well-formed one", () => {
    expect(() => parseBreakpoints(["not-a-valid-target", "ZCL_FOO:10"])).toThrow();
  });

  it("rejects an entry with no colon and no 'exception:' prefix", () => {
    expect(() => parseBreakpoints(["ZCL_FOO"])).toThrow();
  });

  it("rejects a non-numeric line", () => {
    expect(() => parseBreakpoints(["ZCL_FOO:abc"])).toThrow();
  });

  it("rejects line 0 (out of the 1..999_999 v1 bound)", () => {
    expect(() => parseBreakpoints(["ZCL_FOO:0"])).toThrow();
  });

  it("rejects an empty exception class", () => {
    expect(() => parseBreakpoints(["exception:"])).toThrow();
  });

  it("rejects an empty entry", () => {
    expect(() => parseBreakpoints([""])).toThrow();
  });

  // -------------------------------------------------------------- batches ---

  it("parses a mixed batch of line and exception breakpoints with no notes", () => {
    const { breakpoints, notes } = parseBreakpoints([
      "ZCL_FOO:10",
      "exception:CX_SY_ZERODIVIDE",
      "ZCL_BAR:20#2?lv_x = 1",
    ]);
    expect(breakpoints).toHaveLength(3);
    expect(notes).toEqual([]);
  });

  it("returns an empty result for an empty input array", () => {
    const { breakpoints, notes } = parseBreakpoints([]);
    expect(breakpoints).toEqual([]);
    expect(notes).toEqual([]);
  });

  // ----------------------------------------------------- v1 shape round-trip ---

  it("output elements are assignable to v1's own DebugInput['breakpoints'] element type with no cast", () => {
    const { breakpoints } = parseBreakpoints(["ZCL_FOO:10#0?sy-tabix = 500", "exception:CX_SY_ZERODIVIDE#1"]);
    const roundTrip: V1Breakpoint[] = breakpoints;
    expect(roundTrip).toHaveLength(2);
  });
});
