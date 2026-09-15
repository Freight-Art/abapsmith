/**
 * `src/adt/catalog-read.ts` — offline renderer tests. No live call: a fake
 * `CatalogReadConnection` stands in for `AbapConnection.dataPreviewFreestyle`,
 * and `catalog-read.ts`'s own `issue()` helper runs every fake response
 * through the REAL `toRecordSet`/`parsePreviewBody` XML pipeline (no shortcut
 * exists at that layer) — so the fake's response bodies are genuine
 * `dataPreview:tableData` XML, built by `xmlBody()` below to the wire shape
 * confirmed against two real captures: `test/cassettes/datapreview/
 * ddic-svers-single-column-single-row.cassette.json` (minimal single-
 * column/single-row shape) and `test/cassettes/datapreview/
 * ddic-t000-rows3.cassette.json` (column-major `<dataPreview:columns>`
 * repetition, one `<dataPreview:data>` per row per column).
 *
 * Fixture discipline (see the task for this suite): these tests assert the
 * RENDERER's behaviour, not a live-system fact. Every field name fed into a
 * fixture row is a column name lifted from `catalog-query.ts`'s own builders
 * (which in turn come from `IMG_CATALOG`); every code value exercising a
 * decode table is a key of that table as defined in `catalog-read.ts` itself
 * (`SELMTYPE_DECODE`, `DIALOGTYPE_DECODE`, `AGGTYPE_DECODE`,
 * `VIEWCLASS_DECODE`, `VIEWGRANT_DECODE`). Free-text values (descriptions,
 * data-element names, ...) are plain placeholders, never dressed up as
 * something observed on a real system.
 */
import { describe, expect, it } from "vitest";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { readCatalogObject, readClassicView, readSearchHelp, readTransaction, type CatalogReadConnection } from "../src/adt/catalog-read.js";

// ---------------------------------------------------------------------------
// Synthetic dataPreview:tableData XML + a fake CatalogReadConnection
// ---------------------------------------------------------------------------

/**
 * Builds a well-formed `dataPreview:tableData` body, column-major, exactly
 * the shape the real endpoint uses (see file header) — one `<dataPreview:
 * columns>` block per column, one `<dataPreview:data>` cell per row inside
 * it. `toRecordSet` (which every fake response here is run through) only
 * reads each `<dataPreview:metadata dataPreview:name="...">` attribute and
 * the `<dataPreview:data>` cells, so those are the only two things this
 * builder needs to get right.
 */
function xmlBody(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const columnBlocks = columns
    .map((name, i) => {
      const cells = rows.map((row) => `<dataPreview:data>${esc(row[i] ?? "")}</dataPreview:data>`).join("");
      return (
        `<dataPreview:columns><dataPreview:metadata dataPreview:name="${esc(name)}" dataPreview:type="C" ` +
        `dataPreview:keyAttribute="false" dataPreview:length="30"/><dataPreview:dataSet>${cells}</dataPreview:dataSet></dataPreview:columns>`
      );
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">` +
    `<dataPreview:totalRows>0</dataPreview:totalRows><dataPreview:name>FIXTURE</dataPreview:name>${columnBlocks}</dataPreview:tableData>`
  );
}

interface TableFixture {
  columns: readonly string[];
  rows: readonly (readonly string[])[];
}

/** Records every call it receives and answers from a table-name-keyed fixture map; a table with no fixture answers zero rows. */
class FakeCatalogConn implements CatalogReadConnection {
  readonly calls: Array<{ sql: string; rowNumber: number; table: string }> = [];
  constructor(private readonly tables: Record<string, TableFixture>) {}

  async dataPreviewFreestyle(sql: string, rowNumber: number): Promise<{ body: string }> {
    const table = /FROM\s+(\S+)/.exec(sql)?.[1] ?? "";
    this.calls.push({ sql, rowNumber, table });
    const fixture = this.tables[table];
    return { body: xmlBody(fixture?.columns ?? [], fixture?.rows ?? []) };
  }
}

function rowsOf(n: number, row: readonly string[]): readonly (readonly string[])[] {
  return Array.from({ length: n }, () => row);
}

async function catchErr(p: Promise<unknown>): Promise<AbapError> {
  try {
    await p;
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected an AbapError, but the call resolved");
}

// ---------------------------------------------------------------------------
// readSearchHelp
// ---------------------------------------------------------------------------

describe("readSearchHelp", () => {
  it("renders ddl/sections/meta/notes/hashInput for an elementary search help", async () => {
    const conn = new FakeCatalogConn({
      DD30L: {
        // Field names from IMG_CATALOG.searchHelpHeader via catalog-query.ts's
        // buildSearchHelpHeaderQuery column list.
        columns: [
          "SHLPNAME",
          "AS4LOCAL",
          "ISSIMPLE",
          "ELEMEXI",
          "ATTACHEXI",
          "SELMETHOD",
          "SELMTYPE",
          "TEXTTAB",
          "SELMEXIT",
          "HOTKEY",
          "DIALOGTYPE",
        ],
        // ISSIMPLE='X' (elementary); SELMTYPE='T' and DIALOGTYPE='D' are both
        // SELMTYPE_DECODE/DIALOGTYPE_DECODE keys taken from catalog-read.ts
        // itself, and both are the codes its own doc comments say were
        // observed live (T on H_T000, D on H_T000) — cited there, not here.
        rows: [["ZSHLP", "A", "X", "", "", "ZSHLPTAB", "T", "ZSHLPT", "", "", "D"]],
      },
      DD30T: { columns: ["SHLPNAME", "DDTEXT"], rows: [["ZSHLP", "placeholder search help text"]] },
      DD32S: {
        columns: [
          "SHLPNAME",
          "FIELDNAME",
          "FLPOSITION",
          "ROLLNAME",
          "SHLPINPUT",
          "SHLPOUTPUT",
          "SHLPSELPOS",
          "SHLPLISPOS",
          "DEFAULTVAL",
          "DEFAULTTYP",
          "DATATYPE",
          "LENG",
        ],
        rows: [
          ["ZSHLP", "CARRID", "1", "ZCARRID", "X", "", "1", "1", "", "", "CHAR", "3"],
          ["ZSHLP", "CONNID", "2", "ZCONNID", "", "X", "2", "2", "", "", "CHAR", "4"],
        ],
      },
      DD31S: {
        columns: ["SHLPNAME", "SUBSHLP", "SHPOSITION", "VIASHLP", "HIDEFLAG"],
        rows: [["ZSHLP", "ZSUBHLP", "1", "", ""]],
      },
      DD33S: {
        columns: ["SHLPNAME", "FIELDNAME", "SUBSHLP", "SUBFIELD", "DEFAULTVAL", "DEFAULTTYP", "VALUEDIREC"],
        // "I" is a plausible VALUEDIREC code shape only (a single letter), not
        // a claim it was observed live — the point of this row is only that
        // DD33S-VALUEDIREC is NOT decoded (see the dedicated test below).
        rows: [["ZSHLP", "CARRID", "ZSUBHLP", "CARRID", "", "", "I"]],
      },
    });

    const render = await readSearchHelp(conn, "ZSHLP", "E");

    expect(render.ddl).toContain("SEARCH HELP ZSHLP.");
    expect(render.ddl).toContain("KIND: ELEMENTARY");
    // SELMTYPE_DECODE['T'] = "table" (measured on A4H per catalog-read.ts's own comment).
    expect(render.ddl).toContain("SELECTION METHOD TYPE: table (T)");
    // DIALOGTYPE_DECODE['D'] = "display values immediately" (measured on A4H).
    expect(render.ddl).toContain("DIALOG TYPE: display values immediately (D)");
    expect(render.ddl).toContain("CARRID : ZCARRID (IMPORT) POS 1");
    expect(render.ddl).toContain("CONNID : ZCONNID (EXPORT) POS 2");

    expect(render.meta.searchHelp).toBe("ZSHLP");
    expect(render.meta.elementary).toBe("true");
    expect(render.meta.selectionMethod).toBe("ZSHLPTAB");
    expect(render.meta.textTable).toBe("ZSHLPT");
    expect(render.meta.parameterCount).toBe(2);
    expect(render.meta.includeCount).toBe(1);

    const paramSection = render.sections.find((s) => s.title === "PARAMETERS");
    expect(paramSection?.content).toContain("CARRID");
    expect(render.hashInput).toBe(render.ddl);
  });

  it("DD31S self-row (SUBSHLP = SHLPNAME = own name) is suppressed from INCLUDES/INCLUDED BY and includeCount, with a NOTE explaining why", async () => {
    // Evidence: a live read of a freshly created ELEMENTARY search help
    // ZSH_I83_EL — two interface fields, NO includes, NO assignments —
    // measured 2026-09-15 on A4H came back with exactly one DD31S row,
    // SUBSHLP = SHLPNAME = ZSH_I83_EL, reported as both an include and an
    // "included by" of itself. This is DDIC's own representation, not a
    // write-path bug (see catalog-read.ts's comment above the filter).
    const conn = new FakeCatalogConn({
      DD30L: {
        columns: ["SHLPNAME", "AS4LOCAL", "ISSIMPLE", "SELMETHOD", "SELMTYPE"],
        rows: [["ZSHLP", "A", "X", "ZSHLPTAB", "T"]],
      },
      DD31S: {
        columns: ["SHLPNAME", "SUBSHLP", "SHPOSITION", "VIASHLP", "HIDEFLAG"],
        rows: [["ZSHLP", "ZSHLP", "1", "", ""]],
      },
    });
    const render = await readSearchHelp(conn, "ZSHLP", "E");

    expect(render.meta.includeCount).toBe(0);
    expect(render.ddl).not.toContain("INCLUDES");
    expect(render.ddl).not.toContain("INCLUDED BY");
    expect(render.notes.some((n) => n.includes("SUBSHLP = SHLPNAME"))).toBe(true);
  });

  it("a genuine include survives self-row suppression: the real include is listed, the self-row is not, includeCount counts only the real one", async () => {
    const conn = new FakeCatalogConn({
      DD30L: {
        columns: ["SHLPNAME", "AS4LOCAL", "ISSIMPLE", "SELMETHOD", "SELMTYPE"],
        rows: [["ZSHLP", "A", "", "ZSHLPTAB", "T"]],
      },
      DD31S: {
        columns: ["SHLPNAME", "SUBSHLP", "SHPOSITION", "VIASHLP", "HIDEFLAG"],
        // Position 1 is the self-row DDIC also writes for a collective help;
        // position 2 is a genuine include of another search help.
        rows: [
          ["ZSHLP", "ZSHLP", "1", "", ""],
          ["ZSHLP", "ZREALSUB", "2", "", ""],
        ],
      },
    });
    const render = await readSearchHelp(conn, "ZSHLP", "E");

    expect(render.meta.includeCount).toBe(1);
    expect(render.ddl).toContain("ZREALSUB POS 2");
    const includeSection = render.sections.find((s) => s.title === "INCLUDES");
    expect(includeSection?.content).not.toContain("ZSHLP POS 1");
    expect(render.notes.some((n) => n.includes("SUBSHLP = SHLPNAME"))).toBe(true);
  });

  it("no DD31S self-row present — the suppression NOTE is absent and includeCount reflects the raw row count", async () => {
    // Reuses the same fixture shape as the very first test in this suite
    // (SUBSHLP = ZSUBHLP, not the search help's own name).
    const conn = new FakeCatalogConn({
      DD30L: {
        columns: ["SHLPNAME", "AS4LOCAL", "ISSIMPLE", "SELMETHOD", "SELMTYPE"],
        rows: [["ZSHLP", "A", "X", "ZSHLPTAB", "T"]],
      },
      DD31S: {
        columns: ["SHLPNAME", "SUBSHLP", "SHPOSITION", "VIASHLP", "HIDEFLAG"],
        rows: [["ZSHLP", "ZSUBHLP", "1", "", ""]],
      },
    });
    const render = await readSearchHelp(conn, "ZSHLP", "E");

    expect(render.meta.includeCount).toBe(1);
    expect(render.ddl).toContain("ZSUBHLP POS 1");
    expect(render.notes.some((n) => n.includes("SUBSHLP = SHLPNAME"))).toBe(false);
  });

  it("DD31S self-row suppression is case/whitespace-insensitive", async () => {
    const conn = new FakeCatalogConn({
      DD30L: {
        columns: ["SHLPNAME", "AS4LOCAL", "ISSIMPLE", "SELMETHOD", "SELMTYPE"],
        rows: [["ZSHLP", "A", "X", "ZSHLPTAB", "T"]],
      },
      DD31S: {
        columns: ["SHLPNAME", "SUBSHLP", "SHPOSITION", "VIASHLP", "HIDEFLAG"],
        rows: [[" zshlp ", " zshlp ", "1", "", ""]],
      },
    });
    const render = await readSearchHelp(conn, "ZSHLP", "E");

    expect(render.meta.includeCount).toBe(0);
    expect(render.ddl).not.toContain("INCLUDES");
    expect(render.notes.some((n) => n.includes("SUBSHLP = SHLPNAME"))).toBe(true);
  });

  it("NOT_FOUND (DD30L returned no row) — the exact contract catalogProbe() in src/tools/write.ts keys off", async () => {
    // src/tools/write.ts's catalogProbe() treats ONLY an AbapError with code
    // === "NOT_FOUND" as "confirmed absent" and rethrows every other code —
    // so a NOT_FOUND here is a cross-module contract, not an incidental
    // choice, and this test pins the code specifically (not just "it threw").
    const conn = new FakeCatalogConn({});
    const err = await catchErr(readSearchHelp(conn, "ZGONE", "E"));
    expect(err.code).toBe("NOT_FOUND");
  });

  it("DD33S-VALUEDIREC is deliberately NOT decoded — the raw code is printed as-is, with a note explaining why", async () => {
    // catalog-read.ts's own comment: "the column exists (measured
    // 2026-09-12) but its value set was not independently verified on this
    // system, so the raw code is printed as-is." This test pins that
    // decision, not a claim about what VALUEDIREC's real values mean.
    const conn = new FakeCatalogConn({
      DD30L: {
        columns: ["SHLPNAME", "AS4LOCAL", "ISSIMPLE", "SELMETHOD", "SELMTYPE"],
        rows: [["ZSHLP", "A", "", "ZSHLPTAB", "T"]],
      },
      DD33S: {
        columns: ["SHLPNAME", "FIELDNAME", "SUBSHLP", "SUBFIELD", "VALUEDIREC"],
        rows: [["ZSHLP", "CARRID", "ZSUBHLP", "CARRID", "Q"]],
      },
    });
    const render = await readSearchHelp(conn, "ZSHLP", "E");
    expect(render.ddl).toContain("DIR Q");
    expect(render.notes.some((n) => n.includes("DD33S-VALUEDIREC is not decoded here"))).toBe(true);
  });

  it("SELMTYPE_DECODE: an unknown code degrades to the bare raw value, never throwing or blanking", async () => {
    const conn = new FakeCatalogConn({
      DD30L: {
        columns: ["SHLPNAME", "AS4LOCAL", "ISSIMPLE", "SELMETHOD", "SELMTYPE"],
        // "Z" is not a key of SELMTYPE_DECODE ({T,V,M}) in catalog-read.ts.
        rows: [["ZSHLP", "A", "", "ZSHLPTAB", "Z"]],
      },
    });
    const render = await readSearchHelp(conn, "ZSHLP", "E");
    expect(render.ddl).toContain("SELECTION METHOD TYPE: Z");
    expect(render.ddl).not.toContain("SELECTION METHOD TYPE: Z (Z)");
  });

  it.each([
    ["PARAMETERS", "DD32S"],
    ["INCLUDES", "DD31S"],
    ["ASSIGNMENTS", "DD33S"],
    ["USED BY DATA ELEMENTS", "DD04L"],
    ["INCLUDED BY", "DD31S"],
  ])("truncation: %s is marked once its row count reaches CAP_LIST (200), never silently", async (label) => {
    // All five multi-row search-help queries share CAP_LIST=200 — feeding one
    // list exactly 200 rows should mark that list, and marking must never be
    // silent (project rule: truncation is always noted).
    const listRow = ["ZSHLP", "X", "1", "", ""];
    const conn = new FakeCatalogConn({
      DD30L: { columns: ["SHLPNAME", "AS4LOCAL", "ISSIMPLE"], rows: [["ZSHLP", "A", ""]] },
      DD32S: {
        columns: ["SHLPNAME", "FIELDNAME", "FLPOSITION", "SHLPINPUT", "SHLPOUTPUT"],
        rows: label === "PARAMETERS" ? rowsOf(200, listRow) : [],
      },
      DD31S: {
        columns: ["SHLPNAME", "SUBSHLP", "SHPOSITION", "VIASHLP", "HIDEFLAG"],
        rows: label === "INCLUDES" || label === "INCLUDED BY" ? rowsOf(200, listRow) : [],
      },
      DD33S: {
        columns: ["SHLPNAME", "FIELDNAME", "SUBSHLP", "SUBFIELD", "VALUEDIREC"],
        rows: label === "ASSIGNMENTS" ? rowsOf(200, listRow) : [],
      },
      DD04L: {
        columns: ["ROLLNAME", "SHLPNAME", "SHLPFIELD"],
        rows: label === "USED BY DATA ELEMENTS" ? rowsOf(200, listRow) : [],
      },
    });
    const render = await readSearchHelp(conn, "ZSHLP", "E");
    expect(render.notes.some((n) => n.startsWith(`${label} is capped at 200 row(s)`))).toBe(true);
  });

  it("truncation: one row under CAP_LIST does not mark truncation", async () => {
    const conn = new FakeCatalogConn({
      DD30L: { columns: ["SHLPNAME", "AS4LOCAL", "ISSIMPLE"], rows: [["ZSHLP", "A", ""]] },
      DD31S: {
        columns: ["SHLPNAME", "SUBSHLP", "SHPOSITION", "VIASHLP", "HIDEFLAG"],
        rows: rowsOf(199, ["ZSHLP", "X", "1", "", ""]),
      },
    });
    const render = await readSearchHelp(conn, "ZSHLP", "E");
    expect(render.notes.some((n) => n.startsWith("INCLUDES is capped"))).toBe(false);
  });

  it("issues the header query with rowNumber=1 (CAP_ONE), text with 50 (CAP_TEXT), and every list query with 200 (CAP_LIST)", async () => {
    const conn = new FakeCatalogConn({ DD30L: { columns: ["SHLPNAME", "AS4LOCAL"], rows: [["ZSHLP", "A"]] } });
    await readSearchHelp(conn, "ZSHLP", "E");
    const byTable = Object.fromEntries(conn.calls.map((c) => [c.table, c.rowNumber]));
    expect(byTable.DD30L).toBe(1);
    expect(byTable.DD30T).toBe(50);
    expect(byTable.DD32S).toBe(200);
    expect(byTable.DD31S).toBe(200);
    expect(byTable.DD33S).toBe(200);
    expect(byTable.DD04L).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// readClassicView
// ---------------------------------------------------------------------------

describe("readClassicView", () => {
  it("renders ddl/sections/meta/notes/hashInput for a classic view", async () => {
    const conn = new FakeCatalogConn({
      DD25L: {
        columns: [
          "VIEWNAME",
          "AGGTYPE",
          "ROOTTAB",
          "VIEWCLASS",
          "READONLY",
          "VIEWGRANT",
          "GLOBALFLAG",
          "APPLCLASS",
          "MASTERLANG",
        ],
        // AGGTYPE='V', VIEWCLASS='C', VIEWGRANT='R' — all decode-table keys
        // from catalog-read.ts (AGGTYPE_DECODE/VIEWCLASS_DECODE/VIEWGRANT_DECODE).
        rows: [["ZVIEW", "V", "ZROOT", "C", "", "R", "", "", "E"]],
      },
      DD25T: { columns: ["VIEWNAME", "DDTEXT"], rows: [["ZVIEW", "placeholder view text"]] },
      DD26S: {
        columns: ["VIEWNAME", "TABNAME", "TABPOS", "FORTABNAME", "FORFIELD", "FORDIR"],
        rows: [["ZVIEW", "ZBASE", "1", "", "", ""]],
      },
      DD27S: {
        columns: ["VIEWNAME", "VIEWFIELD", "TABNAME", "FIELDNAME", "OBJPOS", "KEYFLAG", "ROLLNAME", "RDONLY", "ENQMODE"],
        rows: [["ZVIEW", "CARRID", "ZBASE", "CARRID", "1", "X", "ZCARRID", "", ""]],
      },
      TVDIR: {
        columns: ["TABNAME", "AREA", "TYPE", "BASTAB", "FLAG", "DEVCLASS", "LISTE"],
        rows: [["ZVIEW", "", "", "ZBASE", "", "ZPACKAGE", "100"]],
      },
    });

    const render = await readClassicView(conn, "ZVIEW", "E");

    expect(render.ddl).toContain("VIEW ZVIEW.");
    // AGGTYPE_DECODE['V'] = "database view".
    expect(render.ddl).toContain("AGGREGATE TYPE: database view (V)");
    // VIEWCLASS_DECODE['C'] = "help view".
    expect(render.ddl).toContain("VIEW CLASS: help view (C)");
    // VIEWGRANT_DECODE['R'] = "read-only".
    expect(render.ddl).toContain("VIEW GRANT: read-only (R)");
    expect(render.ddl).toContain("PACKAGE: ZPACKAGE");
    expect(render.ddl).toContain("CARRID : ZCARRID (ZBASE.CARRID) KEY");

    expect(render.meta.view).toBe("ZVIEW");
    expect(render.meta.rootTable).toBe("ZROOT");
    expect(render.meta.package).toBe("ZPACKAGE");
    expect(render.meta.baseTableCount).toBe(1);
    expect(render.meta.fieldCount).toBe(1);
    expect(render.hashInput).toBe(render.ddl);
  });

  it("NOT_FOUND (DD25L returned no row) — the same catalogProbe() contract readSearchHelp relies on", async () => {
    const conn = new FakeCatalogConn({});
    const err = await catchErr(readClassicView(conn, "ZGONE", "E"));
    expect(err.code).toBe("NOT_FOUND");
  });

  it("VIEWCLASS_DECODE: an unknown code degrades to the bare raw value", async () => {
    const conn = new FakeCatalogConn({
      DD25L: {
        columns: ["VIEWNAME", "AGGTYPE", "ROOTTAB", "VIEWCLASS"],
        // "Z" is not a key of VIEWCLASS_DECODE ({D,C,P,M,E}).
        rows: [["ZVIEW", "", "ZROOT", "Z"]],
      },
    });
    const render = await readClassicView(conn, "ZVIEW", "E");
    expect(render.ddl).toContain("VIEW CLASS: Z");
    expect(render.ddl).not.toContain("VIEW CLASS: Z (Z)");
  });

  it.each([
    ["BASE TABLES", "DD26S"],
    ["FIELDS", "DD27S"],
  ])("truncation: %s is marked once its row count reaches CAP_LIST (200)", async (label) => {
    const conn = new FakeCatalogConn({
      DD25L: { columns: ["VIEWNAME", "ROOTTAB"], rows: [["ZVIEW", "ZROOT"]] },
      DD26S: {
        columns: ["VIEWNAME", "TABNAME", "TABPOS", "FORTABNAME", "FORFIELD", "FORDIR"],
        rows: label === "BASE TABLES" ? rowsOf(200, ["ZVIEW", "ZBASE", "1", "", "", ""]) : [],
      },
      DD27S: {
        columns: ["VIEWNAME", "VIEWFIELD", "TABNAME", "FIELDNAME", "OBJPOS", "KEYFLAG", "ROLLNAME", "RDONLY", "ENQMODE"],
        rows: label === "FIELDS" ? rowsOf(200, ["ZVIEW", "F", "ZBASE", "F", "1", "", "ZDE", "", ""]) : [],
      },
    });
    const render = await readClassicView(conn, "ZVIEW", "E");
    expect(render.notes.some((n) => n.startsWith(`${label} is capped at 200 row(s)`))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readTransaction
// ---------------------------------------------------------------------------

describe("readTransaction", () => {
  it("renders ddl/sections/meta/notes/hashInput, including parsed TSTCP-PARAM, for a transaction", async () => {
    const conn = new FakeCatalogConn({
      TSTC: {
        columns: ["TCODE", "PGMNA", "DYPNO", "CINFO", "ARBGB"],
        rows: [["ZTRAN", "SAPMZTRAN", "0100", "", ""]],
      },
      TSTCT: { columns: ["TCODE", "TTEXT"], rows: [["ZTRAN", "placeholder transaction text"]] },
      // Encoding taken from catalog-query.ts's own doc comment on
      // parseTransactionParameters (measured 2026-09-12 on A4H).
      TSTCP: { columns: ["TCODE", "PARAM"], rows: [["ZTRAN", "/*SM30 VIEWNAME=ZFOO;UPDATE=X;"]] },
      TSTCA: {
        columns: ["TCODE", "OBJCT", "FIELD", "VALUE"],
        rows: [["ZTRAN", "S_TABU_DIS", "ACTVT", "03"]],
      },
      AGR_TCODES: { columns: ["AGR_NAME", "TCODE"], rows: [["Z_ROLE", "ZTRAN"]] },
    });

    const render = await readTransaction(conn, "ZTRAN", "E");

    expect(render.ddl).toContain("TRANSACTION ZTRAN.");
    expect(render.ddl).toContain("PROGRAM: SAPMZTRAN");
    expect(render.ddl).toContain("RAW: /*SM30 VIEWNAME=ZFOO;UPDATE=X;");
    expect(render.ddl).toContain("STARTS: SM30");
    expect(render.ddl).toContain("VIEWNAME = ZFOO");
    expect(render.ddl).toContain("S_TABU_DIS ACTVT = 03");
    expect(render.ddl).toContain("Z_ROLE");

    expect(render.meta.transaction).toBe("ZTRAN");
    expect(render.meta.program).toBe("SAPMZTRAN");
    expect(render.meta.parameterKind).toBe("parameter");
    expect(render.meta.parameterTarget).toBe("SM30");
    expect(render.meta.authCheckCount).toBe(1);
    expect(render.meta.roleCount).toBe(1);
    expect(render.hashInput).toBe(render.ddl);
  });

  it("NOT_FOUND (TSTC returned no row) — the same catalogProbe() contract the other two readers rely on", async () => {
    const conn = new FakeCatalogConn({});
    const err = await catchErr(readTransaction(conn, "ZGONE", "E"));
    expect(err.code).toBe("NOT_FOUND");
  });

  it("a PARAM matching neither TSTCP encoding degrades to kind 'other' with no target, never throwing", async () => {
    const conn = new FakeCatalogConn({
      TSTC: { columns: ["TCODE", "PGMNA"], rows: [["ZTRAN", "SAPMZTRAN"]] },
      TSTCP: { columns: ["TCODE", "PARAM"], rows: [["ZTRAN", "unparseable text"]] },
    });
    const render = await readTransaction(conn, "ZTRAN", "E");
    expect(render.meta.parameterKind).toBe("other");
    expect(render.meta.parameterTarget).toBeUndefined();
  });

  it.each([
    ["AUTHORIZATION", "TSTCA"],
    ["ASSIGNED TO ROLES", "AGR_TCODES"],
  ])("truncation: %s is marked once its row count reaches CAP_LIST (200)", async (label) => {
    const conn = new FakeCatalogConn({
      TSTC: { columns: ["TCODE", "PGMNA"], rows: [["ZTRAN", "SAPMZTRAN"]] },
      TSTCA: {
        columns: ["TCODE", "OBJCT", "FIELD", "VALUE"],
        rows: label === "AUTHORIZATION" ? rowsOf(200, ["ZTRAN", "S_TABU_DIS", "ACTVT", "03"]) : [],
      },
      AGR_TCODES: {
        columns: ["AGR_NAME", "TCODE"],
        rows: label === "ASSIGNED TO ROLES" ? rowsOf(200, ["Z_ROLE", "ZTRAN"]) : [],
      },
    });
    const render = await readTransaction(conn, "ZTRAN", "E");
    expect(render.notes.some((n) => n.startsWith(`${label} is capped at 200 row(s)`))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readCatalogObject
// ---------------------------------------------------------------------------

describe("readCatalogObject", () => {
  it("dispatches kind SHLP to readSearchHelp (queries DD30L)", async () => {
    const conn = new FakeCatalogConn({ DD30L: { columns: ["SHLPNAME", "AS4LOCAL"], rows: [["ZSHLP", "A"]] } });
    const render = await readCatalogObject(conn, { kind: "SHLP", type: "SHLP/DH", name: "ZSHLP" });
    expect(render.ddl).toContain("SEARCH HELP ZSHLP.");
    expect(conn.calls[0]?.table).toBe("DD30L");
  });

  it("dispatches kind VIEW to readClassicView (queries DD25L)", async () => {
    const conn = new FakeCatalogConn({ DD25L: { columns: ["VIEWNAME", "ROOTTAB"], rows: [["ZVIEW", "ZROOT"]] } });
    const render = await readCatalogObject(conn, { kind: "VIEW", type: "VIEW/DV", name: "ZVIEW" });
    expect(render.ddl).toContain("VIEW ZVIEW.");
    expect(conn.calls[0]?.table).toBe("DD25L");
  });

  it("dispatches kind TRAN to readTransaction (queries TSTC)", async () => {
    const conn = new FakeCatalogConn({ TSTC: { columns: ["TCODE", "PGMNA"], rows: [["ZTRAN", "SAPMZTRAN"]] } });
    const render = await readCatalogObject(conn, { kind: "TRAN", type: "TRAN/T", name: "ZTRAN" });
    expect(render.ddl).toContain("TRANSACTION ZTRAN.");
    expect(conn.calls[0]?.table).toBe("TSTC");
  });

  it("dispatch is case-insensitive on kind", async () => {
    const conn = new FakeCatalogConn({ TSTC: { columns: ["TCODE", "PGMNA"], rows: [["ZTRAN", "SAPMZTRAN"]] } });
    const render = await readCatalogObject(conn, { kind: "tran", type: "TRAN/T", name: "ZTRAN" });
    expect(render.ddl).toContain("TRANSACTION ZTRAN.");
  });

  it("refuses a kind it does not handle with an UNSUPPORTED AbapError naming the type and the renderable list", async () => {
    const conn = new FakeCatalogConn({});
    const err = await catchErr(readCatalogObject(conn, { kind: "TABL", type: "TABL/DT", name: "ZFOO" }));
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.message).toContain("TABL/DT");
    expect(err.details.renderable).toEqual(["SHLP/DH", "VIEW/DV", "TRAN/T"]);
  });
});
