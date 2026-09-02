/**
 * DEFECT 1 — `abap_write({object, method, source})` wrote invalid ABAP.
 *
 * Captured on A4H 2026-08-12 against CLAS/OC ZTM_CL_HWOOP_VIEW_WRITE:
 *   {"error":"ADT_ERROR","message":"The statement METHOD ... . is unexpected"}
 *   {"error":"ADT_ERROR","message":"The statement IF is unexpected"}
 * both t100 OO_SOURCE_BASED/038, ExceptionResourceScanDuringSaveFailure.
 *
 * The local write journal settles what actually happened. The bytes PUT to SAP
 * (.abapsmith/journal/A4H/blobs/20260812T122606520Z-9943da.after.txt) are 23
 * lines that begin `  METHOD ztm_if_hwoop_view~on_show_data.` and end
 * `  ENDMETHOD.` — with NO `CLASS ... IMPLEMENTATION` around them. The earlier
 * attempt (…122521839Z-426517) PUT the bare 21-line body starting
 * `    IF it_data IS INITIAL.`. Neither is a spliced class source; each is the
 * caller's own `source` argument written as the object's ENTIRE new text. So
 * the splice never executed, and SAP's two errors are just the first statement
 * of each payload read as an object header.
 *
 * Cause: `writeInputSchema` (src/tools/write.ts) declared no `method` key. The
 * MCP SDK validates arguments against that shape and passes the PARSED object
 * on, and zod strips undeclared keys — so `{object, method, source}` reached
 * `resolveWriteSource` as `{object, source}` and took the whole-object-rewrite
 * branch. The line arithmetic that everyone suspected was correct all along;
 * it was simply unreachable on the shipped default surface (`toolSurface:"v1"`).
 *
 * These tests pin both halves: the schema must carry `method` through, and the
 * splice must be right for the reasons it is right rather than by luck.
 *
 * Everything here is offline and pure — no connection, no fake HTTP, no A4H.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { scanMethodBlocks } from "../src/adt/source.js";
import { assertNotOrphanMethodBlock, spliceMethodBlock, writeInputSchema } from "../src/tools/write.js";
import { AbapError } from "../src/adt/errors.js";

/**
 * A class with four implementations, deliberately shaped to be hostile:
 * an interface-prefixed method, a body whose STRING contains `ENDMETHOD.`,
 * a body whose COMMENT contains `ENDMETHOD.`, a `METHODS` declaration block
 * that must not be mistaken for an implementation, and a full-line `*` comment.
 */
const CLASS_SOURCE = [
  /*  1 */ "CLASS ztm_cl_hwoop_view_write DEFINITION PUBLIC FINAL CREATE PUBLIC.",
  /*  2 */ "  PUBLIC SECTION.",
  /*  3 */ "    INTERFACES ztm_if_hwoop_view.",
  /*  4 */ "    METHODS first_one.",
  /*  5 */ "    METHODS middle_one.",
  /*  6 */ "    CLASS-METHODS last_one.",
  /*  7 */ "ENDCLASS.",
  /*  8 */ "",
  /*  9 */ "CLASS ztm_cl_hwoop_view_write IMPLEMENTATION.",
  /* 10 */ "  METHOD first_one.",
  /* 11 */ "    WRITE 'alpha'.",
  /* 12 */ "  ENDMETHOD.",
  /* 13 */ "",
  /* 14 */ "  METHOD middle_one.",
  /* 15 */ "    DATA(lv_txt) = 'ENDMETHOD. is only a string here'.",
  /* 16 */ '    WRITE lv_txt. " and ENDMETHOD. is only a comment here',
  /* 17 */ "*   ENDMETHOD. in column 1 is a comment too",
  /* 18 */ "  ENDMETHOD.",
  /* 19 */ "",
  /* 20 */ "  METHOD ztm_if_hwoop_view~on_show_data.",
  /* 21 */ "    IF it_data IS INITIAL.",
  /* 22 */ "      RETURN.",
  /* 23 */ "    ENDIF.",
  /* 24 */ "  ENDMETHOD.",
  /* 25 */ "",
  /* 26 */ "  METHOD last_one.",
  /* 27 */ "    WRITE 'omega'.",
  /* 28 */ "  ENDMETHOD.",
  /* 29 */ "ENDCLASS.",
].join("\n");

function splice(method: string, memberName: string, replacement: string, range?: { startLine: number; endLine: number }): string {
  return spliceMethodBlock({
    current: CLASS_SOURCE,
    replacement,
    memberName,
    requested: method,
    ...(range ? { range } : {}),
    object: "ZTM_CL_HWOOP_VIEW_WRITE",
  });
}

/** The code under test must never be handed a range it can lean on by accident. */
const NO_RANGE = undefined;

describe("scanMethodBlocks — boundaries are lexical, not textual", () => {
  it("finds exactly the four implementations and no declaration", () => {
    expect(scanMethodBlocks(CLASS_SOURCE)).toEqual({
      blocks: [
        { name: "first_one", startLine: 10, endLine: 12 },
        { name: "middle_one", startLine: 14, endLine: 18 },
        { name: "ztm_if_hwoop_view~on_show_data", startLine: 20, endLine: 24 },
        { name: "last_one", startLine: 26, endLine: 28 },
      ],
    });
  });

  it("is not fooled by ENDMETHOD. inside a literal, a trailing comment, or a * comment", () => {
    // If any of line 15/16/17 counted, middle_one would end at 15 and every
    // later block would shift — the exact failure mode that produced DEFECT 1's
    // error message on a live system.
    const middle = scanMethodBlocks(CLASS_SOURCE).blocks[1];
    expect(middle).toEqual({ name: "middle_one", startLine: 14, endLine: 18 });
  });
});

describe("spliceMethodBlock — exact resulting source", () => {
  it("replaces the FIRST method", () => {
    const out = splice("first_one", "FIRST_ONE", "  METHOD first_one.\n    WRITE 'NEW'.\n  ENDMETHOD.", NO_RANGE);
    expect(out).toBe(
      [
        "CLASS ztm_cl_hwoop_view_write DEFINITION PUBLIC FINAL CREATE PUBLIC.",
        "  PUBLIC SECTION.",
        "    INTERFACES ztm_if_hwoop_view.",
        "    METHODS first_one.",
        "    METHODS middle_one.",
        "    CLASS-METHODS last_one.",
        "ENDCLASS.",
        "",
        "CLASS ztm_cl_hwoop_view_write IMPLEMENTATION.",
        "  METHOD first_one.",
        "    WRITE 'NEW'.",
        "  ENDMETHOD.",
        "",
        "  METHOD middle_one.",
        "    DATA(lv_txt) = 'ENDMETHOD. is only a string here'.",
        '    WRITE lv_txt. " and ENDMETHOD. is only a comment here',
        "*   ENDMETHOD. in column 1 is a comment too",
        "  ENDMETHOD.",
        "",
        "  METHOD ztm_if_hwoop_view~on_show_data.",
        "    IF it_data IS INITIAL.",
        "      RETURN.",
        "    ENDIF.",
        "  ENDMETHOD.",
        "",
        "  METHOD last_one.",
        "    WRITE 'omega'.",
        "  ENDMETHOD.",
        "ENDCLASS.",
      ].join("\n"),
    );
  });

  it("replaces a MIDDLE method whose old body contained ENDMETHOD. in a string and a comment", () => {
    const out = splice(
      "middle_one",
      "MIDDLE_ONE",
      "  METHOD middle_one.\n    RETURN.\n  ENDMETHOD.",
      NO_RANGE,
    );
    expect(out).toBe(
      [
        "CLASS ztm_cl_hwoop_view_write DEFINITION PUBLIC FINAL CREATE PUBLIC.",
        "  PUBLIC SECTION.",
        "    INTERFACES ztm_if_hwoop_view.",
        "    METHODS first_one.",
        "    METHODS middle_one.",
        "    CLASS-METHODS last_one.",
        "ENDCLASS.",
        "",
        "CLASS ztm_cl_hwoop_view_write IMPLEMENTATION.",
        "  METHOD first_one.",
        "    WRITE 'alpha'.",
        "  ENDMETHOD.",
        "",
        "  METHOD middle_one.",
        "    RETURN.",
        "  ENDMETHOD.",
        "",
        "  METHOD ztm_if_hwoop_view~on_show_data.",
        "    IF it_data IS INITIAL.",
        "      RETURN.",
        "    ENDIF.",
        "  ENDMETHOD.",
        "",
        "  METHOD last_one.",
        "    WRITE 'omega'.",
        "  ENDMETHOD.",
        "ENDCLASS.",
      ].join("\n"),
    );
  });

  it("keeps ENDMETHOD. in a string and a comment when they are in the NEW body", () => {
    const out = splice(
      "first_one",
      "FIRST_ONE",
      [
        "  METHOD first_one.",
        "    DATA(lv) = 'ENDMETHOD.'.",
        '    WRITE lv. " ENDMETHOD. here as well',
        "  ENDMETHOD.",
      ].join("\n"),
      NO_RANGE,
    );
    // The replacement is inserted verbatim, and the object still balances.
    expect(out).toContain("    DATA(lv) = 'ENDMETHOD.'.");
    expect(out).toContain('    WRITE lv. " ENDMETHOD. here as well');
    expect(scanMethodBlocks(out).blocks.map((b) => b.name)).toEqual([
      "first_one",
      "middle_one",
      "ztm_if_hwoop_view~on_show_data",
      "last_one",
    ]);
  });

  it("replaces the LAST method", () => {
    const out = splice("last_one", "LAST_ONE", "  METHOD last_one.\n    WRITE 'ZULU'.\n  ENDMETHOD.", NO_RANGE);
    expect(out).toBe(
      [
        "CLASS ztm_cl_hwoop_view_write DEFINITION PUBLIC FINAL CREATE PUBLIC.",
        "  PUBLIC SECTION.",
        "    INTERFACES ztm_if_hwoop_view.",
        "    METHODS first_one.",
        "    METHODS middle_one.",
        "    CLASS-METHODS last_one.",
        "ENDCLASS.",
        "",
        "CLASS ztm_cl_hwoop_view_write IMPLEMENTATION.",
        "  METHOD first_one.",
        "    WRITE 'alpha'.",
        "  ENDMETHOD.",
        "",
        "  METHOD middle_one.",
        "    DATA(lv_txt) = 'ENDMETHOD. is only a string here'.",
        '    WRITE lv_txt. " and ENDMETHOD. is only a comment here',
        "*   ENDMETHOD. in column 1 is a comment too",
        "  ENDMETHOD.",
        "",
        "  METHOD ztm_if_hwoop_view~on_show_data.",
        "    IF it_data IS INITIAL.",
        "      RETURN.",
        "    ENDIF.",
        "  ENDMETHOD.",
        "",
        "  METHOD last_one.",
        "    WRITE 'ZULU'.",
        "  ENDMETHOD.",
        "ENDCLASS.",
      ].join("\n"),
    );
  });

  it("replaces an INTERFACE-PREFIXED method — the exact object DEFECT 1 destroyed", () => {
    const out = splice(
      "ZTM_IF_HWOOP_VIEW~ON_SHOW_DATA",
      "ZTM_IF_HWOOP_VIEW~ON_SHOW_DATA",
      [
        "  METHOD ztm_if_hwoop_view~on_show_data.",
        "    IF it_data IS INITIAL.",
        "      RETURN.",
        "    ENDIF.",
        "    cl_demo_output=>display( it_data ).",
        "  ENDMETHOD.",
      ].join("\n"),
      NO_RANGE,
    );
    expect(out).toBe(
      [
        "CLASS ztm_cl_hwoop_view_write DEFINITION PUBLIC FINAL CREATE PUBLIC.",
        "  PUBLIC SECTION.",
        "    INTERFACES ztm_if_hwoop_view.",
        "    METHODS first_one.",
        "    METHODS middle_one.",
        "    CLASS-METHODS last_one.",
        "ENDCLASS.",
        "",
        "CLASS ztm_cl_hwoop_view_write IMPLEMENTATION.",
        "  METHOD first_one.",
        "    WRITE 'alpha'.",
        "  ENDMETHOD.",
        "",
        "  METHOD middle_one.",
        "    DATA(lv_txt) = 'ENDMETHOD. is only a string here'.",
        '    WRITE lv_txt. " and ENDMETHOD. is only a comment here',
        "*   ENDMETHOD. in column 1 is a comment too",
        "  ENDMETHOD.",
        "",
        "  METHOD ztm_if_hwoop_view~on_show_data.",
        "    IF it_data IS INITIAL.",
        "      RETURN.",
        "    ENDIF.",
        "    cl_demo_output=>display( it_data ).",
        "  ENDMETHOD.",
        "",
        "  METHOD last_one.",
        "    WRITE 'omega'.",
        "  ENDMETHOD.",
        "ENDCLASS.",
      ].join("\n"),
    );
  });

  it("matches an ALIASed short name against the interface-prefixed block", () => {
    // ADT reports the member as ZTM_IF_HWOOP_VIEW~ON_SHOW_DATA; a caller may
    // reasonably type the aliased short form. Both must land on line 20-24.
    const out = splice(
      "on_show_data",
      "on_show_data",
      "  METHOD ztm_if_hwoop_view~on_show_data.\n    RETURN.\n  ENDMETHOD.",
      NO_RANGE,
    );
    expect(scanMethodBlocks(out).blocks).toEqual([
      { name: "first_one", startLine: 10, endLine: 12 },
      { name: "middle_one", startLine: 14, endLine: 18 },
      { name: "ztm_if_hwoop_view~on_show_data", startLine: 20, endLine: 22 },
      { name: "last_one", startLine: 24, endLine: 26 },
    ]);
  });
});

describe("spliceMethodBlock — the boundaries are LOCAL, not ADT's", () => {
  it("ignores an implementationRange that points at the wrong lines", () => {
    // This is the failure the old `lines.slice(startLine-1 … endLine)` could not
    // survive: a range measured against a DIFFERENT document (a class include,
    // another object) still slices happily and yields ABAP that cannot parse.
    // Name-derived boundaries make the bad range irrelevant.
    const withBadRange = splice(
      "last_one",
      "LAST_ONE",
      "  METHOD last_one.\n    WRITE 'ZULU'.\n  ENDMETHOD.",
      { startLine: 3, endLine: 7 },
    );
    const withoutRange = splice("last_one", "LAST_ONE", "  METHOD last_one.\n    WRITE 'ZULU'.\n  ENDMETHOD.", NO_RANGE);
    expect(withBadRange).toBe(withoutRange);
    expect(withBadRange).toContain("    INTERFACES ztm_if_hwoop_view.");
  });

  it("refuses when the method is not in the source it was given, instead of cutting at ADT's numbers", () => {
    const err = (() => {
      try {
        splice("ZIF_ELSEWHERE~DO_IT", "ZIF_ELSEWHERE~DO_IT", "  METHOD zif_elsewhere~do_it.\n  ENDMETHOD.", {
          startLine: 10,
          endLine: 12,
        });
      } catch (e) {
        return e as AbapError;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(AbapError);
    expect(err?.code).toBe("NOT_FOUND");
    expect(err?.message).toContain("nothing to replace");
    expect(err?.details.methodsInSource).toEqual([
      "first_one",
      "middle_one",
      "ztm_if_hwoop_view~on_show_data",
      "last_one",
    ]);
  });

  it("uses the range only to break a genuine tie between two same-short-named methods", () => {
    const twoIfaces = [
      "CLASS zcl_two IMPLEMENTATION.",
      "  METHOD zif_a~run.",
      "    WRITE 'A'.",
      "  ENDMETHOD.",
      "  METHOD zif_b~run.",
      "    WRITE 'B'.",
      "  ENDMETHOD.",
      "ENDCLASS.",
    ].join("\n");
    const call = (range?: { startLine: number; endLine: number }): string =>
      spliceMethodBlock({
        current: twoIfaces,
        replacement: "  METHOD run.\n    WRITE 'X'.\n  ENDMETHOD.",
        memberName: "run",
        requested: "run",
        ...(range ? { range } : {}),
        object: "ZCL_TWO",
      });
    expect(() => call()).toThrowError(/cannot tell which one you mean/);
    expect(call({ startLine: 5, endLine: 7 })).toBe(
      [
        "CLASS zcl_two IMPLEMENTATION.",
        "  METHOD zif_a~run.",
        "    WRITE 'A'.",
        "  ENDMETHOD.",
        "  METHOD run.",
        "    WRITE 'X'.",
        "  ENDMETHOD.",
        "ENDCLASS.",
      ].join("\n"),
    );
  });

  it("prefers an EXACT name match over the interface-suffix fallback", () => {
    const both = [
      "CLASS zcl_both IMPLEMENTATION.",
      "  METHOD zif_a~run.",
      "    WRITE 'IFACE'.",
      "  ENDMETHOD.",
      "  METHOD run.",
      "    WRITE 'OWN'.",
      "  ENDMETHOD.",
      "ENDCLASS.",
    ].join("\n");
    const out = spliceMethodBlock({
      current: both,
      replacement: "  METHOD run.\n    WRITE 'NEW'.\n  ENDMETHOD.",
      memberName: "RUN",
      requested: "run",
      object: "ZCL_BOTH",
    });
    expect(out).toContain("    WRITE 'IFACE'.");
    expect(out).toContain("    WRITE 'NEW'.");
    expect(out).not.toContain("    WRITE 'OWN'.");
  });
});

describe("spliceMethodBlock — refusals that keep bad ABAP off the wire", () => {
  it("rejects a replacement that is a bare body rather than a block", () => {
    expect(() => splice("first_one", "FIRST_ONE", "    WRITE 'no wrapper'.", NO_RANGE)).toThrowError(
      /exactly ONE complete "METHOD \.\.\. ENDMETHOD\." block/,
    );
  });

  it("rejects a replacement containing TWO methods", () => {
    expect(() =>
      splice(
        "first_one",
        "FIRST_ONE",
        "  METHOD first_one.\n  ENDMETHOD.\n  METHOD middle_one.\n  ENDMETHOD.",
        NO_RANGE,
      ),
    ).toThrowError(/found 2/);
  });

  it("refuses to rewrite a source whose own METHOD/ENDMETHOD do not balance", () => {
    expect(() =>
      spliceMethodBlock({
        current: "CLASS zcl_x IMPLEMENTATION.\n  METHOD run.\n    WRITE 'oops'.\nENDCLASS.",
        replacement: "  METHOD run.\n  ENDMETHOD.",
        memberName: "run",
        requested: "run",
        object: "ZCL_X",
      }),
    ).toThrowError(/never closed by ENDMETHOD/);
  });

  it("leaves the METHOD/ENDMETHOD balance of the object unchanged on every success", () => {
    const count = (s: string): number => scanMethodBlocks(s).blocks.length;
    for (const [m, n] of [
      ["first_one", "FIRST_ONE"],
      ["middle_one", "MIDDLE_ONE"],
      ["last_one", "LAST_ONE"],
      ["ZTM_IF_HWOOP_VIEW~ON_SHOW_DATA", "ZTM_IF_HWOOP_VIEW~ON_SHOW_DATA"],
    ] as const) {
      const rep = `  METHOD ${m}.\n    RETURN.\n  ENDMETHOD.`;
      expect(count(splice(m, n, rep, NO_RANGE))).toBe(count(CLASS_SOURCE));
    }
  });
});

describe("assertNotOrphanMethodBlock — the backstop for a dropped `method` field", () => {
  it("refuses the EXACT payload the journal recorded going to SAP", () => {
    // .abapsmith/journal/A4H/blobs/20260812T122606520Z-9943da.after.txt
    const journalled = [
      "  METHOD ztm_if_hwoop_view~on_show_data.",
      "    IF it_data IS INITIAL.",
      "      RETURN.",
      "    ENDIF.",
      "  ENDMETHOD.",
    ].join("\n");
    let err: AbapError | undefined;
    try {
      assertNotOrphanMethodBlock(journalled, "ZTM_CL_HWOOP_VIEW_WRITE");
    } catch (e) {
      err = e as AbapError;
    }
    expect(err).toBeInstanceOf(AbapError);
    expect(err?.code).toBe("BAD_INPUT");
    expect(err?.message).toContain("not a complete object source");
    // The message must name the likely cause, since the caller's own request
    // looked correct to them — the field was removed in transit.
    expect(err?.hint).toContain("does not declare it");
  });

  it("tolerates surrounding blank lines, which are still not a class source", () => {
    expect(() =>
      assertNotOrphanMethodBlock("\n\n  METHOD run.\n    RETURN.\n  ENDMETHOD.\n\n", "ZCL_X"),
    ).toThrowError(AbapError);
  });

  it("lets a REAL full class source through — one method or many", () => {
    expect(() => assertNotOrphanMethodBlock(CLASS_SOURCE, "ZCL_X")).not.toThrow();
    expect(() =>
      assertNotOrphanMethodBlock(
        [
          "CLASS zcl_one DEFINITION PUBLIC.",
          "  PUBLIC SECTION.",
          "    METHODS run.",
          "ENDCLASS.",
          "CLASS zcl_one IMPLEMENTATION.",
          "  METHOD run.",
          "    RETURN.",
          "  ENDMETHOD.",
          "ENDCLASS.",
        ].join("\n"),
        "ZCL_ONE",
      ),
    ).not.toThrow();
  });

  it("lets sources with no method block at all through untouched", () => {
    expect(() => assertNotOrphanMethodBlock("REPORT ztest.\nWRITE 'hi'.", "ZTEST")).not.toThrow();
    expect(() => assertNotOrphanMethodBlock("", "ZTEST")).not.toThrow();
  });

  it("exempts INCLUDE types, whose whole source legitimately can be a fragment", () => {
    const fragment = "  METHOD run.\n    RETURN.\n  ENDMETHOD.";
    expect(() => assertNotOrphanMethodBlock(fragment, "ZINCL", "PROG/I")).not.toThrow();
    expect(() => assertNotOrphanMethodBlock(fragment, "ZINCL", "FUGR/I")).not.toThrow();
    // …but a class is still refused, which is the type DEFECT 1 destroyed.
    expect(() => assertNotOrphanMethodBlock(fragment, "ZCL_X", "CLAS/OC")).toThrowError(AbapError);
  });
});

describe("writeInputSchema — the regression that caused DEFECT 1", () => {
  const Parsed = z.object(writeInputSchema);

  it("carries `method` through validation instead of stripping it", () => {
    const parsed = Parsed.parse({
      object: "ZTM_CL_HWOOP_VIEW_WRITE",
      method: "ZTM_IF_HWOOP_VIEW~ON_SHOW_DATA",
      source: "  METHOD ztm_if_hwoop_view~on_show_data.\n  ENDMETHOD.",
    });
    // Before the fix this was `undefined`, and the call silently degraded to a
    // whole-object rewrite that overwrote the class with one method block.
    expect(parsed.method).toBe("ZTM_IF_HWOOP_VIEW~ON_SHOW_DATA");
  });

  it("carries `edit` through validation, including replace_all", () => {
    const parsed = Parsed.parse({
      object: "ZCL_FOO",
      edit: { old_string: "a", new_string: "b", replace_all: true },
    });
    expect(parsed.edit).toEqual({ old_string: "a", new_string: "b", replace_all: true });
  });

  it("still publishes `method` and `edit` as optional", () => {
    expect(Parsed.parse({ object: "ZCL_FOO", source: "REPORT x." }).method).toBeUndefined();
    expect(Parsed.parse({ object: "ZCL_FOO", source: "REPORT x." }).edit).toBeUndefined();
  });
});
