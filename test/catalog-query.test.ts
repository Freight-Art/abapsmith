/**
 * Pure-function tests for `src/adt/catalog-query.ts` — no connection/HTTP
 * fake, no live call, exactly the style `test/img-query.test.ts` uses for
 * the sibling builders this module reuses (`buildSelect`, `inClause`,
 * `tbl`/`fld`, `assertEntityName`, `assertTransactionCode`,
 * `assertImgLanguage`). Every builder here is a pure string assembly over
 * `IMG_CATALOG`, so its output is fully determined by the source — asserting
 * the exact generated SQL text is pinning behaviour, not fabricating data.
 *
 * The endpoint constraints documented in `img-query.ts`'s header (no `UP TO`,
 * no `OFFSET`, 255-char line wrap, explicit column lists) are proven live
 * once for the whole freestyle endpoint, not per catalog-query.ts builder —
 * so they are asserted here as properties over every exported builder,
 * rather than repeated as a per-builder assertion.
 */
import { describe, expect, it } from "vitest";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { IMG_SQL_LINE_MAX } from "../src/adt/img-query.js";
import {
  buildSearchHelpAssignmentsQuery,
  buildSearchHelpHeaderQuery,
  buildSearchHelpIncludesQuery,
  buildSearchHelpParamsQuery,
  buildSearchHelpParentsQuery,
  buildSearchHelpTextQuery,
  buildSearchHelpUsingDataElementsQuery,
  buildTransactionAuthQuery,
  buildTransactionDetailQuery,
  buildTransactionParamQuery,
  buildTransactionRolesQuery,
  buildTransactionTextDetailQuery,
  buildViewBaseTablesDetailQuery,
  buildViewDirectoryDetailQuery,
  buildViewFieldsDetailQuery,
  buildViewHeaderDetailQuery,
  buildViewTextDetailQuery,
  parseTransactionParameters,
} from "../src/adt/catalog-query.js";

function expectBadInput(fn: () => unknown): AbapError {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e) && e.code === "BAD_INPUT") return e;
    throw e;
  }
  throw new Error("expected a BAD_INPUT AbapError, but the call did not throw");
}

// ---------------------------------------------------------------------------
// Cross-builder properties — the freestyle endpoint's live-proven invariants
// ---------------------------------------------------------------------------

// One-name builders (search help / view) and one-tcode builders take a single
// string argument; call each with a value long/varied enough to be realistic
// without needing to be a live-observed name (the shape checked here is the
// generated SQL text, not the argument's plausibility as SAP data).
const oneNameBuilders: Array<[string, (name: string) => string]> = [
  ["buildSearchHelpHeaderQuery", buildSearchHelpHeaderQuery],
  ["buildSearchHelpIncludesQuery", buildSearchHelpIncludesQuery],
  ["buildSearchHelpParamsQuery", buildSearchHelpParamsQuery],
  ["buildSearchHelpAssignmentsQuery", buildSearchHelpAssignmentsQuery],
  ["buildSearchHelpUsingDataElementsQuery", buildSearchHelpUsingDataElementsQuery],
  ["buildSearchHelpParentsQuery", buildSearchHelpParentsQuery],
  ["buildViewHeaderDetailQuery", buildViewHeaderDetailQuery],
  ["buildViewBaseTablesDetailQuery", buildViewBaseTablesDetailQuery],
  ["buildViewFieldsDetailQuery", buildViewFieldsDetailQuery],
  ["buildViewDirectoryDetailQuery", buildViewDirectoryDetailQuery],
];

const oneTcodeBuilders: Array<[string, (tcode: string) => string]> = [
  ["buildTransactionDetailQuery", buildTransactionDetailQuery],
  ["buildTransactionParamQuery", buildTransactionParamQuery],
  ["buildTransactionAuthQuery", buildTransactionAuthQuery],
  ["buildTransactionRolesQuery", buildTransactionRolesQuery],
];

const oneNameOneLangBuilders: Array<[string, (name: string, lang: string) => string]> = [
  ["buildSearchHelpTextQuery", buildSearchHelpTextQuery],
  ["buildViewTextDetailQuery", buildViewTextDetailQuery],
];

const oneTcodeOneLangBuilders: Array<[string, (tcode: string, lang: string) => string]> = [
  ["buildTransactionTextDetailQuery", buildTransactionTextDetailQuery],
];

// Every builder's output, gathered once, keyed by name — used by every
// cross-cutting property test below so each invariant is asserted once per
// builder without re-invoking builders with side-effect-free but non-trivial
// validation on every single `it`.
const allOutputs: Array<[string, string]> = [
  ...oneNameBuilders.map(([name, fn]) => [name, fn("ZFOO")] as [string, string]),
  ...oneTcodeBuilders.map(([name, fn]) => [name, fn("ZFOO")] as [string, string]),
  ...oneNameOneLangBuilders.map(([name, fn]) => [name, fn("ZFOO", "E")] as [string, string]),
  ...oneTcodeOneLangBuilders.map(([name, fn]) => [name, fn("ZFOO", "E")] as [string, string]),
];

describe("catalog-query.ts builders: freestyle-endpoint properties (all builders)", () => {
  it.each(allOutputs)("%s: never emits UP TO (the server appends its own)", (_name, sql) => {
    expect(sql).not.toMatch(/\bUP TO\b/i);
  });

  it.each(allOutputs)("%s: never emits OFFSET (the endpoint has none)", (_name, sql) => {
    expect(sql).not.toMatch(/\bOFFSET\b/i);
  });

  it.each(allOutputs)("%s: no line exceeds the 255-char request-body wrap limit", (_name, sql) => {
    for (const line of sql.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(IMG_SQL_LINE_MAX);
    }
  });

  it.each(allOutputs)("%s: emits an explicit column list, never SELECT *", (_name, sql) => {
    const selectLine = sql.split("\n")[0]!;
    expect(selectLine.startsWith("SELECT ")).toBe(true);
    expect(selectLine).not.toMatch(/SELECT\s+\*/);
  });

  it.each(allOutputs)("%s: is multi-line (SELECT/FROM/WHERE on separate lines)", (_name, sql) => {
    const lines = sql.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0]!.startsWith("SELECT ")).toBe(true);
    expect(lines[1]!.startsWith("FROM ")).toBe(true);
    expect(lines[2]!.startsWith("WHERE ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Identifier validation: bad names/tcodes are refused, never interpolated
// ---------------------------------------------------------------------------

describe("catalog-query.ts builders: identifier validation", () => {
  // A raw double-quote is not a shape either assertEntityName's
  // isValidDdicEntityName or assertTransactionCode's ID_CHARSET_RE accepts —
  // if a builder ever interpolated it unchecked instead of refusing it, the
  // generated SQL text would contain the quote verbatim.
  const badName = 'BAD"NAME';

  it.each(oneNameBuilders)("%s: refuses a bad name (BAD_INPUT) instead of interpolating it", (_label, fn) => {
    const err = expectBadInput(() => fn(badName));
    expect(err.message).toContain(badName);
  });

  it.each(oneNameOneLangBuilders)("%s: refuses a bad name (BAD_INPUT) instead of interpolating it", (_label, fn) => {
    const err = expectBadInput(() => fn(badName, "E"));
    expect(err.message).toContain(badName);
  });

  it.each(oneTcodeBuilders)("%s: refuses a bad tcode (BAD_INPUT) instead of interpolating it", (_label, fn) => {
    const err = expectBadInput(() => fn(badName));
    expect(err.message).toContain(badName);
  });

  it.each(oneTcodeOneLangBuilders)("%s: refuses a bad tcode (BAD_INPUT) instead of interpolating it", (_label, fn) => {
    const err = expectBadInput(() => fn(badName, "E"));
    expect(err.message).toContain(badName);
  });

  it.each(oneNameOneLangBuilders)("%s: refuses an ISO language code (e.g. 'EN') rather than a single SAP key", (_label, fn) => {
    expectBadInput(() => fn("ZFOO", "EN"));
  });

  it.each(oneTcodeOneLangBuilders)("%s: refuses an ISO language code (e.g. 'EN') rather than a single SAP key", (_label, fn) => {
    expectBadInput(() => fn("ZFOO", "EN"));
  });

  it("buildSearchHelpHeaderQuery: lower-case input is upper-cased (assertEntityName), not refused", () => {
    // assertEntityName upper-cases before validating (img-query.ts), so a
    // lower-case-but-otherwise-valid name is accepted and normalised, not
    // refused — the generated SQL carries the upper-cased form.
    const sql = buildSearchHelpHeaderQuery("zfoo");
    expect(sql).toContain("SHLPNAME IN ('ZFOO')");
  });

  it("buildTransactionDetailQuery: lower-case input is upper-cased (assertTransactionCode), not refused", () => {
    const sql = buildTransactionDetailQuery("se38");
    expect(sql).toContain("TCODE IN ('SE38')");
  });
});

// ---------------------------------------------------------------------------
// Per-builder exact-text assertions
// ---------------------------------------------------------------------------

describe("search help builders: exact SQL text", () => {
  it("buildSearchHelpHeaderQuery: DD30L header, active version only", () => {
    expect(buildSearchHelpHeaderQuery("ZSHLP")).toBe(
      [
        "SELECT SHLPNAME, AS4LOCAL, ISSIMPLE, ELEMEXI, ATTACHEXI, SELMETHOD, SELMTYPE, TEXTTAB, SELMEXIT, HOTKEY, DIALOGTYPE",
        "FROM DD30L",
        "WHERE SHLPNAME IN ('ZSHLP')",
        "  AND AS4LOCAL = 'A'",
      ].join("\n"),
    );
  });

  it("buildSearchHelpTextQuery: DD30T text, active version, one language", () => {
    expect(buildSearchHelpTextQuery("ZSHLP", "E")).toBe(
      ["SELECT SHLPNAME, DDTEXT", "FROM DD30T", "WHERE SHLPNAME IN ('ZSHLP')", "  AND DDLANGUAGE = 'E'", "  AND AS4LOCAL = 'A'"].join(
        "\n",
      ),
    );
  });

  it("buildSearchHelpIncludesQuery: DD31S includes, active version, ordered by position", () => {
    expect(buildSearchHelpIncludesQuery("ZSHLP")).toBe(
      [
        "SELECT SHLPNAME, SUBSHLP, SHPOSITION, VIASHLP, HIDEFLAG",
        "FROM DD31S",
        "WHERE SHLPNAME IN ('ZSHLP')",
        "  AND AS4LOCAL = 'A'",
        "ORDER BY SHPOSITION",
      ].join("\n"),
    );
  });

  it("buildSearchHelpParamsQuery: DD32S parameters, active version, ordered by position", () => {
    expect(buildSearchHelpParamsQuery("ZSHLP")).toBe(
      [
        "SELECT SHLPNAME, FIELDNAME, FLPOSITION, ROLLNAME, SHLPINPUT, SHLPOUTPUT, SHLPSELPOS, SHLPLISPOS, DEFAULTVAL, DEFAULTTYP, DATATYPE, LENG",
        "FROM DD32S",
        "WHERE SHLPNAME IN ('ZSHLP')",
        "  AND AS4LOCAL = 'A'",
        "ORDER BY FLPOSITION",
      ].join("\n"),
    );
  });

  it("buildSearchHelpAssignmentsQuery: DD33S assignments, active version, ordered by field", () => {
    expect(buildSearchHelpAssignmentsQuery("ZSHLP")).toBe(
      [
        "SELECT SHLPNAME, FIELDNAME, SUBSHLP, SUBFIELD, DEFAULTVAL, DEFAULTTYP, VALUEDIREC",
        "FROM DD33S",
        "WHERE SHLPNAME IN ('ZSHLP')",
        "  AND AS4LOCAL = 'A'",
        "ORDER BY FIELDNAME",
      ].join("\n"),
    );
  });

  it("buildSearchHelpUsingDataElementsQuery: DD04L data elements attaching this search help, ordered by data element", () => {
    expect(buildSearchHelpUsingDataElementsQuery("ZSHLP")).toBe(
      [
        "SELECT ROLLNAME, SHLPNAME, SHLPFIELD",
        "FROM DD04L",
        "WHERE SHLPNAME IN ('ZSHLP')",
        "  AND AS4LOCAL = 'A'",
        "ORDER BY ROLLNAME",
      ].join("\n"),
    );
  });

  it("buildSearchHelpParentsQuery: DD31S rows where this search help is INCLUDED by another, ordered by parent", () => {
    // Filters on includedHelp (SUBSHLP), not searchHelp — this is the
    // "who includes me" direction, the mirror of buildSearchHelpIncludesQuery.
    expect(buildSearchHelpParentsQuery("ZSHLP")).toBe(
      [
        "SELECT SHLPNAME, SUBSHLP, SHPOSITION, VIASHLP, HIDEFLAG",
        "FROM DD31S",
        "WHERE SUBSHLP IN ('ZSHLP')",
        "  AND AS4LOCAL = 'A'",
        "ORDER BY SHLPNAME",
      ].join("\n"),
    );
  });
});

describe("classic view builders: exact SQL text", () => {
  it("buildViewHeaderDetailQuery: DD25L header, active version only", () => {
    expect(buildViewHeaderDetailQuery("ZVIEW")).toBe(
      [
        "SELECT VIEWNAME, AGGTYPE, ROOTTAB, VIEWCLASS, READONLY, VIEWGRANT, GLOBALFLAG, APPLCLASS, MASTERLANG",
        "FROM DD25L",
        "WHERE VIEWNAME IN ('ZVIEW')",
        "  AND AS4LOCAL = 'A'",
      ].join("\n"),
    );
  });

  it("buildViewTextDetailQuery: DD25T text, active version, one language", () => {
    expect(buildViewTextDetailQuery("ZVIEW", "D")).toBe(
      ["SELECT VIEWNAME, DDTEXT", "FROM DD25T", "WHERE VIEWNAME IN ('ZVIEW')", "  AND DDLANGUAGE = 'D'", "  AND AS4LOCAL = 'A'"].join(
        "\n",
      ),
    );
  });

  it("buildViewBaseTablesDetailQuery: DD26S base tables, active version, ordered by position", () => {
    expect(buildViewBaseTablesDetailQuery("ZVIEW")).toBe(
      [
        "SELECT VIEWNAME, TABNAME, TABPOS, FORTABNAME, FORFIELD, FORDIR",
        "FROM DD26S",
        "WHERE VIEWNAME IN ('ZVIEW')",
        "  AND AS4LOCAL = 'A'",
        "ORDER BY TABPOS",
      ].join("\n"),
    );
  });

  it("buildViewFieldsDetailQuery: DD27S field list, active version, ordered by position", () => {
    expect(buildViewFieldsDetailQuery("ZVIEW")).toBe(
      [
        "SELECT VIEWNAME, VIEWFIELD, TABNAME, FIELDNAME, OBJPOS, KEYFLAG, ROLLNAME, RDONLY, ENQMODE",
        "FROM DD27S",
        "WHERE VIEWNAME IN ('ZVIEW')",
        "  AND AS4LOCAL = 'A'",
        "ORDER BY OBJPOS",
      ].join("\n"),
    );
  });

  it("buildViewDirectoryDetailQuery: TVDIR row, NO active-version predicate (TVDIR has no AS4LOCAL column)", () => {
    // TVDIR genuinely has no active-version column — asserting the WHERE
    // clause has exactly one part pins that this is deliberate, not a
    // missing filter.
    const sql = buildViewDirectoryDetailQuery("ZVIEW");
    expect(sql).toBe(
      ["SELECT TABNAME, AREA, TYPE, BASTAB, FLAG, DEVCLASS, LISTE", "FROM TVDIR", "WHERE TABNAME IN ('ZVIEW')"].join("\n"),
    );
    expect(sql).not.toContain("AS4LOCAL");
  });
});

describe("transaction builders: exact SQL text", () => {
  it("buildTransactionDetailQuery: TSTC row", () => {
    expect(buildTransactionDetailQuery("SE38")).toBe(
      ["SELECT TCODE, PGMNA, DYPNO, CINFO, ARBGB", "FROM TSTC", "WHERE TCODE IN ('SE38')"].join("\n"),
    );
  });

  it("buildTransactionTextDetailQuery: TSTCT description, one language, NO active-version predicate (TSTCT has no AS4LOCAL column)", () => {
    const sql = buildTransactionTextDetailQuery("SE38", "E");
    expect(sql).toBe(["SELECT TCODE, TTEXT", "FROM TSTCT", "WHERE TCODE IN ('SE38')", "  AND SPRSL = 'E'"].join("\n"));
    expect(sql).not.toContain("AS4LOCAL");
  });

  it("buildTransactionParamQuery: TSTCP call parameters", () => {
    expect(buildTransactionParamQuery("SE38")).toBe(["SELECT TCODE, PARAM", "FROM TSTCP", "WHERE TCODE IN ('SE38')"].join("\n"));
  });

  it("buildTransactionAuthQuery: TSTCA authorisation checks, ordered by authObject then authField", () => {
    expect(buildTransactionAuthQuery("SE38")).toBe(
      [
        "SELECT TCODE, OBJCT, FIELD, VALUE",
        "FROM TSTCA",
        "WHERE TCODE IN ('SE38')",
        "ORDER BY OBJCT, FIELD",
      ].join("\n"),
    );
  });

  it("buildTransactionRolesQuery: AGR_TCODES role menus, ordered by role", () => {
    expect(buildTransactionRolesQuery("SE38")).toBe(
      ["SELECT AGR_NAME, TCODE", "FROM AGR_TCODES", "WHERE TCODE IN ('SE38')", "ORDER BY AGR_NAME"].join("\n"),
    );
  });
});

// ---------------------------------------------------------------------------
// parseTransactionParameters
// ---------------------------------------------------------------------------

describe("parseTransactionParameters", () => {
  it("parses a /*<TCODE> NAME=VALUE;... parameter transaction into kind 'parameter'", () => {
    // Encoding and example both taken from the source's own doc comment
    // (measured 2026-09-12 on A4H), not invented here.
    expect(parseTransactionParameters("/*SM30 VIEWNAME=/AIF/BDC_V_CONF;UPDATE=X;")).toEqual({
      kind: "parameter",
      target: "SM30",
      skipFirstScreen: true,
      assignments: [
        { name: "VIEWNAME", value: "/AIF/BDC_V_CONF" },
        { name: "UPDATE", value: "X" },
      ],
    });
  });

  it("parses an assignment name containing a dash (e.g. a structure-qualified field)", () => {
    // Also taken directly from the source's doc comment.
    expect(parseTransactionParameters("/*SM34 VCLDIR-VCLNAME=/AIF/ACTIONS;UPDATE=X;")).toEqual({
      kind: "parameter",
      target: "SM34",
      skipFirstScreen: true,
      assignments: [
        { name: "VCLDIR-VCLNAME", value: "/AIF/ACTIONS" },
        { name: "UPDATE", value: "X" },
      ],
    });
  });

  it("parses a bare /N<TCODE> switch into kind 'parameter', not skipping the first screen, no assignments", () => {
    expect(parseTransactionParameters("/NSE38")).toEqual({
      kind: "parameter",
      target: "SE38",
      skipFirstScreen: false,
      assignments: [],
    });
  });

  it("upper-cases the target of a /N<TCODE> switch", () => {
    expect(parseTransactionParameters("/nse38")).toEqual({
      kind: "parameter",
      target: "SE38",
      skipFirstScreen: false,
      assignments: [],
    });
  });

  it("degrades unparseable input to kind 'other' with no target and no assignments, never throwing", () => {
    expect(parseTransactionParameters("")).toEqual({ kind: "other", assignments: [] });
    expect(parseTransactionParameters("garbage that matches neither shape")).toEqual({ kind: "other", assignments: [] });
  });

  it("skips empty pieces and pieces with no '=' when parsing assignments", () => {
    expect(parseTransactionParameters("/*SM30 ;NOEQUALSIGN;NAME=VALUE;;")).toEqual({
      kind: "parameter",
      target: "SM30",
      skipFirstScreen: true,
      assignments: [{ name: "NAME", value: "VALUE" }],
    });
  });

  it("skips an assignment piece whose name is empty after trimming", () => {
    expect(parseTransactionParameters("/*SM30 =VALUE;NAME=OK;")).toEqual({
      kind: "parameter",
      target: "SM30",
      skipFirstScreen: true,
      assignments: [{ name: "NAME", value: "OK" }],
    });
  });

  it("trims surrounding whitespace before matching either shape", () => {
    expect(parseTransactionParameters("  /NSE38  ")).toEqual({
      kind: "parameter",
      target: "SE38",
      skipFirstScreen: false,
      assignments: [],
    });
  });

  // The remaining 4 of parseTransactionParameters's 6 ordered branches
  // (issue #214) — OS_APPLICATION-with-model is covered above via the
  // general parameter-transaction tests' sibling shape.
  it("parses /*OS_APPLICATION CLASS=...;METHOD=...;UPDATE_MODE=...; into kind 'oo' with a transaction model", () => {
    expect(parseTransactionParameters("/*OS_APPLICATION CLASS=ZCL_FOO;METHOD=RUN;UPDATE_MODE=S;")).toEqual({
      kind: "oo",
      target: "OS_APPLICATION",
      transactionModel: true,
      className: "ZCL_FOO",
      methodName: "RUN",
      updateMode: "S",
      assignments: [],
    });
  });

  it("parses \\PROGRAM=...\\CLASS=...\\METHOD=... into kind 'oo' with no transaction model", () => {
    expect(parseTransactionParameters("\\PROGRAM=SAPMZFOO\\CLASS=ZCL_FOO\\METHOD=RUN")).toEqual({
      kind: "oo",
      transactionModel: false,
      className: "ZCL_FOO",
      methodName: "RUN",
      localProgram: "SAPMZFOO",
      assignments: [],
    });
  });

  it("parses \\CLASS=...\\METHOD=... (no PROGRAM) into kind 'oo' with no localProgram", () => {
    expect(parseTransactionParameters("\\CLASS=ZCL_FOO\\METHOD=RUN")).toEqual({
      kind: "oo",
      transactionModel: false,
      className: "ZCL_FOO",
      methodName: "RUN",
      assignments: [],
    });
  });

  it("parses @<TCODE> <VARIANT> into kind 'variant', client-specific", () => {
    expect(parseTransactionParameters("@SM30 ZVARIANT1")).toEqual({
      kind: "variant",
      crossClient: false,
      target: "SM30",
      variant: "ZVARIANT1",
      assignments: [],
    });
  });

  it("parses @@<TCODE> <VARIANT> into kind 'variant', cross-client", () => {
    expect(parseTransactionParameters("@@SM30 ZVARIANT1")).toEqual({
      kind: "variant",
      crossClient: true,
      target: "SM30",
      variant: "ZVARIANT1",
      assignments: [],
    });
  });

  it("parses a bare token with no target transaction into kind 'report-variant'", () => {
    expect(parseTransactionParameters("ZVARIANT1")).toEqual({
      kind: "report-variant",
      variant: "ZVARIANT1",
      assignments: [],
    });
  });
});
