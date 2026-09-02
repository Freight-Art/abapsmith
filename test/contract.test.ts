/**
 * `extractContract` — the pure text transform
 * `src/bin/contract.ts` runs inside the isolated `abap-contract` subprocess.
 *
 * These tests import {@link extractContract} directly (not the CLI): the
 * module's `invokedAsProgram()` gate keeps `main()` from running on import,
 * exactly like `src/index.ts`'s own pattern (see that file's header). No ADT
 * connection, no subprocess spawn — `src/tools/v2/handlers/read.ts` (not
 * exercised here) owns the spawn plumbing.
 */
import { describe, expect, it } from "vitest";
import { extractContract } from "../src/bin/contract.js";

const THREE_SECTION_CLASS = `CLASS zcl_demo DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_row,
             id   TYPE i,
             name TYPE string,
           END OF ty_row.
    CONSTANTS c_max TYPE i VALUE 100.
    DATA mv_count TYPE i READ-ONLY.
    METHODS constructor
      IMPORTING iv_name TYPE string
      RAISING   cx_static_check.
    METHODS get_data
      IMPORTING iv_id         TYPE i
      RETURNING VALUE(rt_row) TYPE ty_row
      RAISING   cx_static_check.
    CLASS-METHODS create
      IMPORTING iv_name       TYPE string
      RETURNING VALUE(ro_obj) TYPE REF TO zcl_demo.
  PROTECTED SECTION.
    METHODS do_helper
      IMPORTING iv_x TYPE i.
  PRIVATE SECTION.
    DATA mv_secret TYPE string.
    METHODS internal_only.
ENDCLASS.

CLASS zcl_demo IMPLEMENTATION.
  METHOD constructor.
    " some comment
    mv_count = 0.
    IF iv_name IS INITIAL.
      RAISE EXCEPTION TYPE cx_static_check.
    ENDIF.
  ENDMETHOD.
  METHOD get_data.
    rt_row-id = iv_id.
    rt_row-name = |hello { iv_id }|.
  ENDMETHOD.
  METHOD create.
    CREATE OBJECT ro_obj
      EXPORTING iv_name = iv_name.
  ENDMETHOD.
  METHOD do_helper.
    " helper body, lots of lines in real life
    WRITE iv_x.
  ENDMETHOD.
  METHOD internal_only.
  ENDMETHOD.
ENDCLASS.
`;

const PUBLIC_ONLY_CLASS = `CLASS zcl_simple DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.

CLASS zcl_simple IMPLEMENTATION.
  METHOD run.
    WRITE 'hi'.
  ENDMETHOD.
ENDCLASS.
`;

const INTERFACE_SOURCE = `INTERFACE zif_demo PUBLIC.
  METHODS do_something
    IMPORTING iv_x TYPE i
    RETURNING VALUE(rv_y) TYPE i.
ENDINTERFACE.
`;

describe("extractContract — CLAS", () => {
  it("keeps every public/protected signature verbatim", () => {
    const { text } = extractContract(THREE_SECTION_CLASS, "CLAS", "ZCL_DEMO");
    expect(text).toContain("METHODS constructor");
    expect(text).toContain("IMPORTING iv_name TYPE string");
    expect(text).toContain("METHODS get_data");
    expect(text).toContain("RETURNING VALUE(rt_row) TYPE ty_row");
    expect(text).toContain("CLASS-METHODS create");
    expect(text).toContain("METHODS do_helper");
    expect(text).toContain("CONSTANTS c_max TYPE i VALUE 100.");
    expect(text).toContain("DATA mv_count TYPE i READ-ONLY.");
  });

  it("strips every method body — no implementation logic survives", () => {
    const { text } = extractContract(THREE_SECTION_CLASS, "CLAS", "ZCL_DEMO");
    expect(text).not.toContain("mv_count = 0");
    expect(text).not.toContain("RAISE EXCEPTION TYPE cx_static_check");
    expect(text).not.toContain("rt_row-id = iv_id");
    expect(text).not.toContain("hello { iv_id }");
    expect(text).not.toContain("CREATE OBJECT ro_obj");
    expect(text).not.toContain("WRITE iv_x");
  });

  it("excises the PRIVATE SECTION — not part of the public contract", () => {
    const { text } = extractContract(THREE_SECTION_CLASS, "CLAS", "ZCL_DEMO");
    expect(text).not.toContain("mv_secret");
    expect(text).not.toContain("internal_only");
  });

  it("is dramatically smaller than the source it was extracted from", () => {
    const { text } = extractContract(THREE_SECTION_CLASS, "CLAS", "ZCL_DEMO");
    expect(text.length).toBeLessThan(THREE_SECTION_CLASS.length);
  });

  it("reports what it did via notes, never silently", () => {
    const { notes } = extractContract(THREE_SECTION_CLASS, "CLAS", "ZCL_DEMO");
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.join(" ")).toMatch(/IMPLEMENTATION block/);
    expect(notes.join(" ")).toMatch(/PRIVATE SECTION/);
  });

  it("handles a class with no PROTECTED/PRIVATE section at all", () => {
    const { text } = extractContract(PUBLIC_ONLY_CLASS, "CLAS", "ZCL_SIMPLE");
    expect(text).toContain("METHODS run.");
    expect(text).not.toContain("WRITE 'hi'");
  });
});

describe("extractContract — INTF", () => {
  it("returns the interface source unmodified — no bodies to strip", () => {
    const { text, notes } = extractContract(INTERFACE_SOURCE, "INTF", "ZIF_DEMO");
    expect(text).toContain("METHODS do_something");
    expect(text).toContain("RETURNING VALUE(rv_y) TYPE i.");
    expect(notes.join(" ")).toMatch(/no METHOD … ENDMETHOD bodies|whole interface source/);
  });
});

describe("extractContract — defensive fallbacks", () => {
  it("returns garbage input unmodified with an honest note, never throws", () => {
    expect(() => extractContract("this is not ABAP at all {{{", "CLAS", "ZCL_GARBAGE")).not.toThrow();
    const { text, notes } = extractContract("this is not ABAP at all {{{", "CLAS", "ZCL_GARBAGE");
    expect(text).toBe("this is not ABAP at all {{{");
    expect(notes.length).toBeGreaterThan(0);
  });

  it("returns an empty string unmodified with a note, never throws", () => {
    expect(() => extractContract("", "CLAS", "ZCL_EMPTY")).not.toThrow();
    const { notes } = extractContract("", "CLAS", "ZCL_EMPTY");
    expect(notes.length).toBeGreaterThan(0);
  });
});
