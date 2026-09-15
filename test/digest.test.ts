/**
 * Pure unit tests for `src/adt/digest.ts` — `abap_read view=digest` (issue
 * #110): supported-type checks, the static dependency/interface scanners,
 * the test-class counter, the public-API summariser and the six-section
 * renderer. No AbapConnection, no ADT call: `buildDigestSections` and its
 * scanners are pure functions over caller-supplied source text and typed
 * input, so every fixture below is literal ABAP source or a hand-built
 * `DigestInput`, the same idiom test/source-scan-rows.test.ts uses for the
 * sibling `scan` tool.
 */
import { describe, expect, it } from "vitest";
import {
  DIGEST_TYPES,
  DIGEST_MAX_ROWS_PER_SECTION,
  isDigestType,
  scanDependencies,
  scanProgramInterface,
  countTestClasses,
  summarisePublicApi,
  scanFunctionInterface,
  scanCdsFields,
  buildDigestSections,
  type DigestInput,
} from "../src/adt/digest.js";
import type { ClassMember } from "../src/adt/source.js";
import { NO_RELEASED_HISTORY_EXPLANATION } from "../src/adt/revisions.js";

// ---------------------------------------------------------------------------
// DIGEST_TYPES / isDigestType
// ---------------------------------------------------------------------------

describe("DIGEST_TYPES", () => {
  it("is exactly these six types", () => {
    expect(DIGEST_TYPES).toEqual(["CLAS/OC", "INTF/OI", "PROG/P", "FUGR/F", "FUGR/FF", "DDLS/DF"]);
  });
});

describe("isDigestType", () => {
  it.each(["CLAS/OC", "INTF/OI", "PROG/P", "FUGR/F", "FUGR/FF", "DDLS/DF"])("accepts the full type %s", (t) => {
    expect(isDigestType(t)).toBe(true);
  });

  it.each(["CLAS", "INTF", "PROG", "DDLS"])("accepts a bare kind that names exactly one digest type: %s", (t) => {
    expect(isDigestType(t)).toBe(true);
  });

  it("rejects bare FUGR — ambiguous between FUGR/F and FUGR/FF", () => {
    expect(isDigestType("FUGR")).toBe(false);
  });

  it("is case-insensitive and tolerant of surrounding whitespace", () => {
    expect(isDigestType("clas/oc")).toBe(true);
    expect(isDigestType("  PROG/P  ")).toBe(true);
  });

  it.each(["TABL/DT", "DTEL/DE", "XYZ", "", "CLAS/OI"])("rejects unsupported/unknown type %j", (t) => {
    expect(isDigestType(t)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scanDependencies — literal captured class + function module fixtures.
// ---------------------------------------------------------------------------

const CLASS_SOURCE = `CLASS zcl_i110_probe DEFINITION
  PUBLIC
  INHERITING FROM cl_abstract_service
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES zif_loggable.

    METHODS process
      IMPORTING
        iv_id     TYPE bapi_user-username
        io_helper TYPE REF TO zcl_helper
      RETURNING
        VALUE(rv_ok) TYPE abap_bool.

  PRIVATE SECTION.
    DATA mo_helper TYPE REF TO zcl_helper.

ENDCLASS.


CLASS zcl_i110_probe IMPLEMENTATION.

  METHOD process.
    DATA ls_user     TYPE bapiuname.
    DATA lo_instance TYPE REF TO zcl_worker.

    lo_instance = NEW zcl_worker( ).
    " Instance call through a local variable - the receiver's declared type
    " is not known from this line alone, so this must NOT be reported as a
    " dependency (see digest.ts's own comment on the staticRe pattern).
    lo_instance->do_work( iv_id ).

    " Static call - the class name sits directly before "=>".
    zcl_message_helper=>info( |processing { iv_id }| ).

    CALL FUNCTION 'BAPI_USER_GET_DETAIL'
      EXPORTING
        username  = iv_id
      IMPORTING
        logondata = ls_user.

    rv_ok = abap_true.
  ENDMETHOD.

ENDCLASS.
`;

const FUNCTION_MODULE_SOURCE = `FUNCTION z_i110_get_partner.
*"----------------------------------------------------------------------
*"*"Local interface:
*"  IMPORTING
*"     VALUE(IV_PARTNER) TYPE  BU_PARTNER
*"  EXPORTING
*"     VALUE(ES_PARTNER) TYPE  BUT000
*"----------------------------------------------------------------------
  CALL FUNCTION 'BUP_PARTNER_LOAD'
    EXPORTING
      iv_partner = iv_partner
    IMPORTING
      es_partner = es_partner.
ENDFUNCTION.
`;

describe("scanDependencies: finds the statement forms the module actually implements", () => {
  const deps = scanDependencies(CLASS_SOURCE);
  const byName = new Map(deps.map((d) => [d.name, d] as const));

  it("finds the superclass via INHERITING FROM", () => {
    expect(byName.get("CL_ABSTRACT_SERVICE")?.via).toBe("superclass");
  });

  it("finds an implemented interface via INTERFACES", () => {
    expect(byName.get("ZIF_LOGGABLE")?.via).toBe("interface");
  });

  it("finds a TYPE REF TO target", () => {
    expect(byName.get("ZCL_WORKER")?.via).toBe("type");
  });

  it('finds a static "=>" call, naming the class directly before the arrow', () => {
    expect(byName.get("ZCL_MESSAGE_HELPER")?.via).toBe("class");
  });

  it("finds a CALL FUNCTION literal", () => {
    expect(byName.get("BAPI_USER_GET_DETAIL")?.via).toBe("function module");
  });

  it("emits an abap_read {type:FUGR/FF} read call for a function module dependency", () => {
    expect(byName.get("BAPI_USER_GET_DETAIL")?.readCall).toBe(
      'abap_read {"object":"BAPI_USER_GET_DETAIL","type":"FUGR/FF"}',
    );
  });

  it('does NOT report an instance "->" call as a dependency — the receiver type is not statically known', () => {
    expect(byName.has("LO_INSTANCE")).toBe(false);
    expect(byName.has("DO_WORK")).toBe(false);
    // No via value of any dependency this scan produces is ever derived from "->".
    for (const d of deps) {
      expect(d.name).not.toBe("LO_INSTANCE");
    }
  });

  it("de-duplicates a name seen more than once, keeping the first via encountered", () => {
    // ZCL_HELPER appears via TYPE REF TO twice (once in the IMPORTING
    // signature, once on mo_helper) and is reported exactly once.
    expect(deps.filter((d) => d.name === "ZCL_HELPER")).toHaveLength(1);
    expect(byName.get("ZCL_HELPER")?.via).toBe("type");
  });

  it("finds a CALL FUNCTION literal inside a function module body too", () => {
    const fmDeps = scanDependencies(FUNCTION_MODULE_SOURCE);
    const fmByName = new Map(fmDeps.map((d) => [d.name, d] as const));
    expect(fmByName.get("BUP_PARTNER_LOAD")?.via).toBe("function module");
  });
});

describe("scanDependencies: SELECT ... FROM <table> and INCLUDE", () => {
  it("SELECT SINGLE ... FROM <table> is reported as a dependency", () => {
    const src = "    SELECT SINGLE * FROM zfoo_tab INTO ls_foo WHERE id = iv_id.\n";
    const deps = scanDependencies(src);
    const dep = deps.find((d) => d.name === "ZFOO_TAB");
    expect(dep?.via).toBe("SELECT FROM");
    expect(dep?.readCall).toBe('abap_read {"object":"ZFOO_TAB","type":"TABL/DT"}');
  });

  it("INCLUDE is reported as a dependency", () => {
    const src = "    INCLUDE zfoo_incl.\n";
    const deps = scanDependencies(src);
    const dep = deps.find((d) => d.name === "ZFOO_INCL");
    expect(dep?.via).toBe("INCLUDE");
    expect(dep?.readCall).toBe('abap_read {"object":"ZFOO_INCL","type":"PROG/I"}');
  });

  it("a joined select naming two tables reports both, across continuation lines", () => {
    const src = [
      "SELECT a~matnr, b~werks",
      "  FROM mara AS a",
      "  JOIN marc AS b ON a~matnr = b~matnr",
      "  INTO TABLE @lt_result.",
    ].join("\n");
    const deps = scanDependencies(src);
    const names = deps.filter((d) => d.via === "SELECT FROM").map((d) => d.name);
    expect(names).toContain("MARA");
    expect(names).toContain("MARC");
  });

  it("FROM @lt_itab (the Open-SQL host-variable escape) does NOT become a dependency", () => {
    const src = "SELECT * FROM @lt_itab INTO TABLE @lt_result.\n";
    const deps = scanDependencies(src);
    expect(deps.some((d) => d.name === "LT_ITAB")).toBe(false);
    expect(deps.some((d) => d.via === "SELECT FROM")).toBe(false);
  });

  it("a commented-out SELECT line does NOT become a dependency", () => {
    const src = "* SELECT * FROM zfoo_tab.\n    DATA lv_x TYPE i.\n";
    const deps = scanDependencies(src);
    expect(deps.some((d) => d.name === "ZFOO_TAB")).toBe(false);
  });

  it("SELECT-OPTIONS is not mistaken for a SELECT statement (no false FROM capture)", () => {
    const src = ["SELECT-OPTIONS s_matnr FOR mara-matnr.", "PERFORM sub_from_somewhere."].join("\n");
    const deps = scanDependencies(src);
    expect(deps.some((d) => d.via === "SELECT FROM")).toBe(false);
  });

  it("skips SELECT FROM scanning entirely for CDS (DEFINE VIEW) source", () => {
    const src = [
      "@AbapCatalog.sqlViewName: 'ZI_FOOV'",
      "define view ZI_FOO as select from zfoo_tab as foo",
      "{",
      "  key foo.id,",
      "  foo.name as name",
      "}",
    ].join("\n");
    const deps = scanDependencies(src);
    expect(deps.some((d) => d.via === "SELECT FROM")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scanProgramInterface — literal captured program fixture.
// ---------------------------------------------------------------------------

const PROGRAM_SOURCE = `REPORT zi110_probe.

PARAMETERS p_bukrs TYPE bukrs OBLIGATORY.
PARAMETERS p_test TYPE abap_bool AS CHECKBOX DEFAULT abap_true.

SELECT-OPTIONS s_matnr FOR mara-matnr.
SELECT-OPTIONS s_werks FOR marc-werks.

START-OF-SELECTION.
  PERFORM process_data.

FORM process_data.
  WRITE: / 'Processing', p_bukrs.
ENDFORM.

FORM cleanup.
  CLEAR sy-subrc.
ENDFORM.
`;

describe("scanProgramInterface", () => {
  const iface = scanProgramInterface(PROGRAM_SOURCE);

  it("extracts PARAMETERS names", () => {
    expect(iface.parameters).toEqual(["p_bukrs", "p_test"]);
  });

  it("extracts SELECT-OPTIONS names", () => {
    expect(iface.selectOptions).toEqual(["s_matnr", "s_werks"]);
  });

  it("extracts the FORM list", () => {
    expect(iface.forms).toEqual(["process_data", "cleanup"]);
  });

  it("detects START-OF-SELECTION", () => {
    expect(iface.hasStartOfSelection).toBe(true);
  });

  it("hasStartOfSelection is false when absent", () => {
    expect(scanProgramInterface("REPORT z_no_selection.\n").hasStartOfSelection).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// countTestClasses — literal captured testclasses include fixture.
// ---------------------------------------------------------------------------

const TESTCLASSES_SOURCE = `CLASS ltc_process_data DEFINITION
  FOR TESTING
  RISK LEVEL HARMLESS
  DURATION SHORT.

  PRIVATE SECTION.
    METHODS ok_case FOR TESTING.
ENDCLASS.

CLASS ltc_process_data IMPLEMENTATION.
  METHOD ok_case.
    cl_abap_unit_assert=>assert_equals( act = 1 exp = 1 ).
  ENDMETHOD.
ENDCLASS.

CLASS ltc_edge_case DEFINITION
  FOR TESTING
  RISK LEVEL HARMLESS
  DURATION SHORT.

  PRIVATE SECTION.
    METHODS empty_input FOR TESTING.
ENDCLASS.

CLASS ltc_edge_case IMPLEMENTATION.
  METHOD empty_input.
    cl_abap_unit_assert=>assert_equals( act = 0 exp = 0 ).
  ENDMETHOD.
ENDCLASS.
`;

describe("countTestClasses", () => {
  it("counts FOR TESTING classes in a captured testclasses include", () => {
    expect(countTestClasses(TESTCLASSES_SOURCE)).toBe(2);
  });

  it("returns 0 for an empty include", () => {
    expect(countTestClasses("")).toBe(0);
  });

  it("does not count the IMPLEMENTATION blocks (no DEFINITION keyword there)", () => {
    // Sanity check on the fixture itself: it has 4 CLASS statements total,
    // only 2 of which are DEFINITION ... FOR TESTING.
    expect(TESTCLASSES_SOURCE.match(/^CLASS /gm)).toHaveLength(4);
    expect(countTestClasses(TESTCLASSES_SOURCE)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// summarisePublicApi
// ---------------------------------------------------------------------------

describe("summarisePublicApi", () => {
  const MEMBERS: ClassMember[] = [
    { name: "PROCESS", type: "Method", visibility: "public", level: "instance" },
    { name: "GET_STATUS", type: "Method", visibility: "public", level: "instance", redefinition: true },
    { name: "MV_STATUS", type: "Attribute", visibility: "private" },
    { name: "MO_HELPER", type: "Attribute", visibility: "private" },
    { name: "VALIDATE_INPUT", type: "Method", visibility: "protected" },
  ];

  const api = summarisePublicApi(MEMBERS);

  it("lists public components by name/kind/detail", () => {
    expect(api.rows).toEqual([
      { name: "PROCESS", kind: "Method", detail: "instance" },
      { name: "GET_STATUS", kind: "Method", detail: "instance redefinition" },
    ]);
  });

  it("counts private/protected components instead of listing them", () => {
    expect(api.hiddenCounts).toEqual([
      { visibility: "private", count: 2 },
      { visibility: "protected", count: 1 },
    ]);
  });

  it("never puts a private/protected member's name in rows", () => {
    const listedNames = api.rows.map((r) => r.name);
    expect(listedNames).not.toContain("MV_STATUS");
    expect(listedNames).not.toContain("MO_HELPER");
    expect(listedNames).not.toContain("VALIDATE_INPUT");
  });
});

// ---------------------------------------------------------------------------
// scanFunctionInterface — literal captured-looking FM interface comment
// blocks (issue #110's FUGR/FF "public API" gap).
// ---------------------------------------------------------------------------

const FM_FULL_SIGNATURE_SOURCE = `FUNCTION z_i110_full_signature.
*"----------------------------------------------------------------------
*"*"Local Interface:
*"  IMPORTING
*"     VALUE(IV_KEY) TYPE  ZKEY
*"     REFERENCE(IV_FLAG) TYPE  ABAP_BOOL DEFAULT ABAP_FALSE
*"  EXPORTING
*"     VALUE(EV_TEXT) TYPE  STRING
*"  CHANGING
*"     VALUE(CV_COUNTER) TYPE  I OPTIONAL
*"  TABLES
*"     ET_ROWS STRUCTURE  ZROW
*"  EXCEPTIONS
*"     NOT_FOUND
*"----------------------------------------------------------------------
  ev_text = |{ iv_key }|.
ENDFUNCTION.
`;

const FM_NO_INTERFACE_SOURCE = `FUNCTION z_i110_no_interface.
  " No ADT-generated interface comment block at all - a hand-written or
  " malformed source.
  WRITE 'hello'.
ENDFUNCTION.
`;

describe("scanFunctionInterface", () => {
  it("finds every kind, in source order, over a full five-kind signature", () => {
    const params = scanFunctionInterface(FM_FULL_SIGNATURE_SOURCE);
    expect(params.map((p) => p.kind)).toEqual([
      "IMPORTING",
      "IMPORTING",
      "EXPORTING",
      "CHANGING",
      "TABLES",
      "EXCEPTIONS",
    ]);
  });

  it("strips the VALUE()/REFERENCE() wrapper from the name", () => {
    const params = scanFunctionInterface(FM_FULL_SIGNATURE_SOURCE);
    expect(params.map((p) => p.name)).toEqual([
      "IV_KEY",
      "IV_FLAG",
      "EV_TEXT",
      "CV_COUNTER",
      "ET_ROWS",
      "NOT_FOUND",
    ]);
  });

  it("carries the TYPE/STRUCTURE typing, with the DEFAULT/OPTIONAL suffix stripped out of it", () => {
    const params = scanFunctionInterface(FM_FULL_SIGNATURE_SOURCE);
    const byName = new Map(params.map((p) => [p.name, p] as const));
    expect(byName.get("IV_KEY")).toEqual({ kind: "IMPORTING", name: "IV_KEY", typing: "TYPE ZKEY", optional: false });
    expect(byName.get("EV_TEXT")).toEqual({
      kind: "EXPORTING",
      name: "EV_TEXT",
      typing: "TYPE STRING",
      optional: false,
    });
    expect(byName.get("ET_ROWS")).toEqual({
      kind: "TABLES",
      name: "ET_ROWS",
      typing: "STRUCTURE ZROW",
      optional: false,
    });
  });

  it("marks optional:true for DEFAULT and for bare OPTIONAL", () => {
    const params = scanFunctionInterface(FM_FULL_SIGNATURE_SOURCE);
    const byName = new Map(params.map((p) => [p.name, p] as const));
    expect(byName.get("IV_FLAG")).toEqual({
      kind: "IMPORTING",
      name: "IV_FLAG",
      typing: "TYPE ABAP_BOOL",
      optional: true,
    });
    expect(byName.get("CV_COUNTER")).toEqual({
      kind: "CHANGING",
      name: "CV_COUNTER",
      typing: "TYPE I",
      optional: true,
    });
  });

  it("gives an EXCEPTIONS entry an empty typing", () => {
    const params = scanFunctionInterface(FM_FULL_SIGNATURE_SOURCE);
    expect(params.find((p) => p.name === "NOT_FOUND")).toEqual({
      kind: "EXCEPTIONS",
      name: "NOT_FOUND",
      typing: "",
      optional: false,
    });
  });

  it("returns [] — not an error — when the source carries no interface comment block", () => {
    expect(scanFunctionInterface(FM_NO_INTERFACE_SOURCE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scanCdsFields — literal captured-looking CDS view sources (issue #110's
// DDLS/DF "public API" gap).
// ---------------------------------------------------------------------------

const CDS_SIMPLE_SOURCE = `@AbapCatalog.sqlViewName: 'ZI110FOOV'
@EndUserText.label: 'Foo projection'
define view Z_I110_FOO as select from zfoo_tab as foo
{
  key foo.id,
  @EndUserText.label: 'Display name'
  foo.name as display_name,
  foo.qty
}
`;

const CDS_ASSOCIATION_SOURCE = `@AbapCatalog.sqlViewName: 'ZI110BARV'
define view Z_I110_BAR as select from zbar_tab as bar
  association [0..1] to Z_I110_FOO as _foo on bar.foo_id = _foo.id
{
  key bar.id,
  bar.name,
  _foo
}
`;

describe("scanCdsFields", () => {
  it("extracts the projected field list, resolving `as <alias>` to the alias", () => {
    expect(scanCdsFields(CDS_SIMPLE_SOURCE)).toEqual(["ID", "DISPLAY_NAME", "QTY"]);
  });

  it("gives up (returns []) for the WHOLE view when a bare association is in the select list", () => {
    expect(scanCdsFields(CDS_ASSOCIATION_SOURCE)).toEqual([]);
  });

  it("returns [] when there is no select-from projection to find", () => {
    expect(scanCdsFields("CLASS zcl_not_a_cds DEFINITION.\nENDCLASS.\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildDigestSections
// ---------------------------------------------------------------------------

function baseInput(over: Partial<DigestInput> = {}): DigestInput {
  return {
    header: {
      type: "CLAS/OC",
      name: "ZCL_I110_PROBE",
      packageName: "ZI110",
      description: "Digest probe class",
      lastChanged: "2026-09-01 by DEVELOPER (version 3)",
      lastChangedSource: "released",
      activationState: "active",
    },
    publicApi: { rows: [{ name: "PROCESS", kind: "Method" }], hiddenCounts: [{ visibility: "private", count: 2 }] },
    dependencies: [{ name: "ZCL_HELPER", via: "type", readCall: 'abap_read {"object":"ZCL_HELPER"}' }],
    tests: {
      hasTestInclude: true,
      testClassCount: 2,
      testCall: 'abap_test {"object":"ZCL_I110_PROBE"}',
      atcCall: 'abap_atc {"object":"ZCL_I110_PROBE"}',
    },
    history: [
      { version: "3", date: "2026-09-01", author: "DEVELOPER", note: "release" },
      { version: "2", date: "2026-08-01", author: "DEVELOPER" },
      { version: "1", date: "2026-07-01", author: "DEVELOPER" },
    ],
    nextSteps: [
      'Read the full source: abap_read {"object":"ZCL_I110_PROBE"}',
      'See the full component list: abap_read {"object":"ZCL_I110_PROBE","outline":true}',
      'See the full version history: abap_read {"object":"ZCL_I110_PROBE","view":"history"}',
    ],
    ...over,
  };
}

describe("buildDigestSections: section order", () => {
  it("emits exactly HEADER, PUBLIC API, DIRECT DEPENDENCIES, TESTS AND CHECKS, RECENT HISTORY, WHERE TO GO NEXT, in that order", () => {
    const { sections } = buildDigestSections(baseInput(), { maxRowsPerSection: DIGEST_MAX_ROWS_PER_SECTION });
    expect(sections.map((s) => s.title)).toEqual([
      "HEADER",
      "PUBLIC API",
      "DIRECT DEPENDENCIES",
      "TESTS AND CHECKS",
      "RECENT HISTORY",
      "WHERE TO GO NEXT",
    ]);
  });
});

describe("buildDigestSections: section-wise truncation", () => {
  it("cuts a section that exceeds maxRowsPerSection and marks it with --- TRUNCATED ---", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ name: `MEMBER_${i}`, kind: "Method" }));
    const input = baseInput({ publicApi: { rows, hiddenCounts: [] } });
    const { sections, notes } = buildDigestSections(input, { maxRowsPerSection: DIGEST_MAX_ROWS_PER_SECTION });

    const apiSection = sections.find((s) => s.title === "PUBLIC API");
    expect(apiSection?.content).toContain("--- TRUNCATED ---");
    expect(apiSection?.content).toContain(`cut after ${DIGEST_MAX_ROWS_PER_SECTION} of 30 rows`);
    expect(apiSection?.content).toContain("MEMBER_0");
    expect(apiSection?.content).not.toContain("MEMBER_29");

    expect(notes.some((n) => n.includes("PUBLIC API") && n.includes("showed 25 of 30"))).toBe(true);
  });

  it("does not truncate a section at or under the row budget", () => {
    const rows = Array.from({ length: DIGEST_MAX_ROWS_PER_SECTION }, (_, i) => ({
      name: `MEMBER_${i}`,
      kind: "Method",
    }));
    const input = baseInput({ publicApi: { rows, hiddenCounts: [] } });
    const { sections } = buildDigestSections(input, { maxRowsPerSection: DIGEST_MAX_ROWS_PER_SECTION });
    const apiSection = sections.find((s) => s.title === "PUBLIC API");
    expect(apiSection?.content).not.toContain("--- TRUNCATED ---");
  });
});

describe("buildDigestSections: recent history", () => {
  it("shows at most three entries", () => {
    const history = [
      { version: "5" },
      { version: "4" },
      { version: "3" },
      { version: "2" },
      { version: "1" },
    ];
    const input = baseInput({ history });
    const { sections } = buildDigestSections(input, { maxRowsPerSection: DIGEST_MAX_ROWS_PER_SECTION });
    const histSection = sections.find((s) => s.title === "RECENT HISTORY");
    expect(histSection?.content).toContain("5");
    expect(histSection?.content).toContain("4");
    expect(histSection?.content).toContain("3");
    expect(histSection?.content).not.toContain("2");
    expect(histSection?.content).not.toContain("1");
  });

  it("de-duplicates consecutive same-version entries before taking the top three", () => {
    const history = [
      { version: "3", note: "first" },
      { version: "3", note: "duplicate" },
      { version: "2" },
      { version: "1" },
      { version: "0" },
    ];
    const input = baseInput({ history });
    const { sections } = buildDigestSections(input, { maxRowsPerSection: DIGEST_MAX_ROWS_PER_SECTION });
    const histSection = sections.find((s) => s.title === "RECENT HISTORY");
    // Deduped to [3, 2, 1, 0], top three kept: 3, 2, 1 — "0" must not appear.
    expect(histSection?.content).toContain("3");
    expect(histSection?.content).toContain("2");
    expect(histSection?.content).toContain("1");
    expect(histSection?.content).not.toMatch(/\b0\b/);
  });
});

describe("buildDigestSections: no released history", () => {
  it("emits NO_RELEASED_HISTORY_EXPLANATION when lastChangedSource is active", () => {
    const input = baseInput({
      header: {
        type: "PROG/P",
        name: "ZI110_PROBE",
        lastChangedSource: "active",
      },
    });
    const { notes } = buildDigestSections(input, { maxRowsPerSection: DIGEST_MAX_ROWS_PER_SECTION });
    expect(notes.some((n) => n === `PROG/P ZI110_PROBE ${NO_RELEASED_HISTORY_EXPLANATION}`)).toBe(true);
  });

  it("does not emit that note when lastChangedSource is released", () => {
    const { notes } = buildDigestSections(baseInput(), { maxRowsPerSection: DIGEST_MAX_ROWS_PER_SECTION });
    expect(notes.some((n) => n.includes(NO_RELEASED_HISTORY_EXPLANATION))).toBe(false);
  });
});

describe("buildDigestSections: where to go next names only real calls", () => {
  it('contains abap_search with mode:"where_used" and never invents abap_read view=footprint or abap_search mode=call_graph', () => {
    const { sections, notes } = buildDigestSections(baseInput(), { maxRowsPerSection: DIGEST_MAX_ROWS_PER_SECTION });
    const wholeOutput = [...sections.map((s) => s.content), ...notes].join("\n");

    expect(wholeOutput).toContain("abap_search");
    expect(wholeOutput).toContain('"mode":"where_used"');
    expect(wholeOutput).not.toContain("footprint");
    expect(wholeOutput).not.toContain("call_graph");
  });

  it("WHERE TO GO NEXT lists the caller-supplied next steps as bullet lines", () => {
    const { sections } = buildDigestSections(baseInput(), { maxRowsPerSection: DIGEST_MAX_ROWS_PER_SECTION });
    const next = sections.find((s) => s.title === "WHERE TO GO NEXT");
    expect(next?.content).toContain('- Read the full source: abap_read {"object":"ZCL_I110_PROBE"}');
  });
});
