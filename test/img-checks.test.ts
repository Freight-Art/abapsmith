/**
 * Tests for `src/adt/img-checks.ts` — the read-only "what SM30 would have
 * checked" disclosure for `abap_img_edit` (issue #62). A plain MODIFY on the
 * base table (see `img-write-bridge.ts`) never runs a maintenance view's own
 * TVIMF event routines, DD03L check-table foreign keys, or DD07L fixed-value
 * validation — `readImgChecks` reads the same DDIC catalog tables a human
 * maintaining the view through SM30 implicitly relies on, and reports what a
 * plain MODIFY skipped.
 *
 * Fake connection modeled on `test/img-read.test.ts`'s `queueConn`: each test
 * hands `readImgChecks` the exact freestyle response bodies it expects to be
 * asked for, in the exact order `readImgChecks`'s own steps 2-6 issue them
 * (see that function's doc comment). No network call is possible.
 *
 * The TB003/V_TB003 numbers below (DD03L, DD26S, TVIMF, DD07L, DD07T) are the
 * live-measured issue #62 case, not invented — see the img-catalog.ts/
 * img-query.ts doc comments dated 2026-09-12. The ZRANGE scenario (used only
 * for the domain-range edge case, which the live case does not exercise) is
 * a synthetic table/domain, the same way test/img-read.test.ts's tree ids are
 * synthetic — its DDIC *shape* (DD03L/DD07L column layout) is still real.
 */
import { describe, expect, it } from "vitest";

import { readImgChecks, type ImgChecksQuery } from "../src/adt/img-checks.js";
import type { ImgReadConnection } from "../src/adt/img-read.js";

// ------------------------------------------------------------ fake wire ---

/** Builds one column's `<dataPreview:columns>` block. */
function columnXml(name: string, values: readonly string[]): string {
  const data = values.map((v) => `<dataPreview:data>${v}</dataPreview:data>`).join("");
  return (
    `<dataPreview:columns><dataPreview:metadata dataPreview:name="${name}" dataPreview:type="C" dataPreview:keyAttribute="false"/>` +
    `<dataPreview:dataSet>${data}</dataPreview:dataSet></dataPreview:columns>`
  );
}

/** A hand-built freestyle response body: `cols` maps column name -> that column's values (column-major, matching the real wire shape). */
function body(cols: Record<string, readonly string[]>): string {
  const names = Object.keys(cols);
  const rowCount = names.length === 0 ? 0 : cols[names[0]!]!.length;
  for (const n of names) {
    if (cols[n]!.length !== rowCount) throw new Error(`test fixture bug: column "${n}" has a different row count than "${names[0]}"`);
  }
  const colsXml = names.map((n) => columnXml(n, cols[n]!)).join("");
  return (
    '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
    `${colsXml}</dataPreview:tableData>`
  );
}

/** An empty result set — no rows, no columns. */
function emptyBody(): string {
  return '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview"></dataPreview:tableData>';
}

interface RecordedCall {
  sql: string;
  rowNumber: number;
}

/**
 * A fake `ImgReadConnection` that answers each `dataPreviewFreestyle` call
 * with the next body off a fixed queue, in call order. Running past the end
 * of the queue is a loud test-authoring bug, never a silent empty response —
 * this fake never performs I/O of any kind.
 */
function queueConn(bodies: readonly string[]): { conn: ImgReadConnection; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const conn: ImgReadConnection = {
    async dataPreviewFreestyle(sql: string, rowNumber: number) {
      calls.push({ sql, rowNumber });
      const b = bodies[i];
      i++;
      if (b === undefined) {
        throw new Error(`queueConn: no fixture queued for call #${i} (only ${bodies.length} queued). SQL was:\n${sql}`);
      }
      return { body: b };
    },
  };
  return { conn, calls };
}

// ------------------------------------------------------------- live data ---
// DD26S root views over TB003.
const TB003_VIEWS_BODY = body({
  VIEWNAME: ["H_TB003", "IBPROLE", "V_TB003"],
  TABNAME: ["TB003", "TB003", "TB003"],
  TABPOS: ["0001", "0001", "0001"],
});

// TVIMF for the TB003 lookup set: only V_TB003 has registered event routines.
const TB003_EVENTS_BODY = body({
  TABNAME: ["V_TB003", "V_TB003"],
  EVENT: ["01", "13"],
  FORMNAME: ["V_TB003_CHECK_DEFAULT", "V_TB003_RESET_DFLT"],
});

// DD07T for domain MAINTEVENT, language E — only the two codes TB003's events use.
const MAINTEVENT_TEXTS_BODY = body({
  DOMNAME: ["MAINTEVENT", "MAINTEVENT"],
  DOMVALUE_L: ["01", "13"],
  DDTEXT: ["Before saving the data in the database", "Exit editing (exit main function module)"],
});

// DD03L for TB003.
const TB003_FIELD_CHECKS_BODY = body({
  TABNAME: ["TB003", "TB003", "TB003", "TB003", "TB003", "TB003", "TB003", "TB003"],
  FIELDNAME: ["CLIENT", "ROLE", "ROLECATEGORY", "STND_ROLECAT", ".INCLUDE", "BPVIEW", "XSUPPRESS", "POSNR"],
  POSITION: ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008"],
  CHECKTABLE: ["T000", "", "TB003A", "", "", "TBZ0", "", ""],
  DOMNAME: ["MANDT", "BU_ROLE", "BU_ROLECAT", "XFELD", "", "BU_RLTYP", "XFELD", "NUM3"],
});

// DD07L for domain XFELD: two fixed values, "X" and blank.
const XFELD_FIXED_VALUES_BODY = body({
  DOMNAME: ["XFELD", "XFELD"],
  VALPOS: ["0001", "0002"],
  DOMVALUE_L: ["X", ""],
  DOMVALUE_H: ["", ""],
  APPVAL: ["", ""],
});

/** DD07L for both XFELD and BU_ROLECAT — BU_ROLECAT genuinely has no rows at all. */
function xfeldAndBuRolecatFixedValuesBody(): string {
  // Only XFELD rows come back — BU_ROLECAT contributes nothing, which is the
  // real, measured shape (a domain with no fixed values has no DD07L rows).
  return XFELD_FIXED_VALUES_BODY;
}

const TB003_ROW = { key: { ROLE: "ZBUP001" }, values: { STND_ROLECAT: "X", ROLECATEGORY: "BUP001" } };

function tb003Query(overrides: Partial<ImgChecksQuery> = {}): ImgChecksQuery {
  return {
    table: "TB003",
    view: "TB003",
    clientField: "CLIENT",
    language: "E",
    checkValues: true,
    rows: [TB003_ROW],
    ...overrides,
  };
}

// ==================================================================== ===

describe("readImgChecks — issue #62's own case (TB003/V_TB003)", () => {
  it("finds V_TB003_CHECK_DEFAULT (event 01) registered against V_TB003, with its DD07T description", async () => {
    const { conn } = queueConn([TB003_VIEWS_BODY, TB003_EVENTS_BODY, MAINTEVENT_TEXTS_BODY, TB003_FIELD_CHECKS_BODY, xfeldAndBuRolecatFixedValuesBody()]);
    const result = await readImgChecks(conn, tb003Query());

    expect(result.events).toContainEqual({
      view: "V_TB003",
      event: "01",
      formName: "V_TB003_CHECK_DEFAULT",
      description: "Before saving the data in the database",
    });
  });

  it("result.views is the TVIMF lookup set: TB003 (view/table) plus the three root views", async () => {
    const { conn } = queueConn([TB003_VIEWS_BODY, TB003_EVENTS_BODY, MAINTEVENT_TEXTS_BODY, TB003_FIELD_CHECKS_BODY, xfeldAndBuRolecatFixedValuesBody()]);
    const result = await readImgChecks(conn, tb003Query());

    expect(result.views).toContain("TB003");
    expect(result.views).toContain("H_TB003");
    expect(result.views).toContain("IBPROLE");
    expect(result.views).toContain("V_TB003");
    // Deduplicated: TB003 was named as both q.view and q.table, but appears once.
    expect(result.views.filter((v) => v === "TB003")).toHaveLength(1);
  });

  it("checkTables reports ROLECATEGORY -> TB003A, not CLIENT (client field), and not ROLE/STND_ROLECAT (blank CHECKTABLE)", async () => {
    const { conn } = queueConn([TB003_VIEWS_BODY, TB003_EVENTS_BODY, MAINTEVENT_TEXTS_BODY, TB003_FIELD_CHECKS_BODY, xfeldAndBuRolecatFixedValuesBody()]);
    const result = await readImgChecks(conn, tb003Query());

    expect(result.checkTables).toEqual([{ field: "ROLECATEGORY", checkTable: "TB003A" }]);
    expect(result.checkTables.some((c) => c.field === "CLIENT")).toBe(false);
    expect(result.checkTables.some((c) => c.field === "ROLE")).toBe(false);
    expect(result.checkTables.some((c) => c.field === "STND_ROLECAT")).toBe(false);
  });

  it("STND_ROLECAT: 'X' against domain XFELD is a fixed value — no finding", async () => {
    const { conn } = queueConn([TB003_VIEWS_BODY, TB003_EVENTS_BODY, MAINTEVENT_TEXTS_BODY, TB003_FIELD_CHECKS_BODY, xfeldAndBuRolecatFixedValuesBody()]);
    const result = await readImgChecks(conn, tb003Query());

    expect(result.fixedValueFindings).toEqual([]);
  });

  it("ROLECATEGORY's domain BU_ROLECAT has no DD07L rows at all — not checked, no finding, no note about it", async () => {
    const { conn } = queueConn([TB003_VIEWS_BODY, TB003_EVENTS_BODY, MAINTEVENT_TEXTS_BODY, TB003_FIELD_CHECKS_BODY, xfeldAndBuRolecatFixedValuesBody()]);
    const result = await readImgChecks(conn, tb003Query());

    expect(result.fixedValueFindings.some((f) => f.field === "ROLECATEGORY")).toBe(false);
    expect(result.notes.join(" ")).not.toContain("BU_ROLECAT");
  });

  it("statementsIssued is 5 when events were found (DD07T text lookup runs)", async () => {
    const { conn } = queueConn([TB003_VIEWS_BODY, TB003_EVENTS_BODY, MAINTEVENT_TEXTS_BODY, TB003_FIELD_CHECKS_BODY, xfeldAndBuRolecatFixedValuesBody()]);
    const result = await readImgChecks(conn, tb003Query());

    expect(result.statementsIssued).toBe(5);
  });
});

describe("readImgChecks — fixed-value comparison edge cases (domain XFELD)", () => {
  /** Same TB003 shape as the issue case, but only STND_ROLECAT is written (ROLECATEGORY omitted so its domain-less-rows path never interferes with these assertions). */
  function xfeldOnlyQuery(writtenValue: string): ImgChecksQuery {
    return tb003Query({ rows: [{ key: { ROLE: "ZBUP001" }, values: { STND_ROLECAT: writtenValue } }] });
  }

  it("a value not in the domain's fixed values produces exactly one finding", async () => {
    const { conn } = queueConn([TB003_VIEWS_BODY, TB003_EVENTS_BODY, MAINTEVENT_TEXTS_BODY, TB003_FIELD_CHECKS_BODY, XFELD_FIXED_VALUES_BODY]);
    const result = await readImgChecks(conn, xfeldOnlyQuery("Q"));

    expect(result.fixedValueFindings).toEqual([{ field: "STND_ROLECAT", domain: "XFELD", value: "Q", allowed: ["X", ""] }]);
  });

  it("a blank written value produces no finding (blank means 'not set')", async () => {
    const { conn } = queueConn([TB003_VIEWS_BODY, TB003_EVENTS_BODY, MAINTEVENT_TEXTS_BODY, TB003_FIELD_CHECKS_BODY, XFELD_FIXED_VALUES_BODY]);
    const result = await readImgChecks(conn, xfeldOnlyQuery(""));

    expect(result.fixedValueFindings).toEqual([]);
  });

  it("a lower-case 'x' produces no finding — comparison against DOMVALUE_L is deliberately case-insensitive", async () => {
    const { conn } = queueConn([TB003_VIEWS_BODY, TB003_EVENTS_BODY, MAINTEVENT_TEXTS_BODY, TB003_FIELD_CHECKS_BODY, XFELD_FIXED_VALUES_BODY]);
    const result = await readImgChecks(conn, xfeldOnlyQuery("x"));

    expect(result.fixedValueFindings).toEqual([]);
  });
});

describe("readImgChecks — domain describing a value range (non-blank DOMVALUE_H)", () => {
  // Synthetic table/domain (ZRANGE/ZSTATUS_RANGE) — isolated from the live TB003
  // numbers so this edge case (not present in the live issue #62 data) can't be
  // mistaken for something measured. DD03L/DD07L column shapes are still real.
  const ZRANGE_VIEWS_BODY = emptyBody(); // no maintenance views over ZRANGE
  const ZRANGE_EVENTS_BODY = emptyBody(); // no TVIMF rows for ZRANGE itself
  const ZRANGE_FIELD_CHECKS_BODY = body({
    TABNAME: ["ZRANGE", "ZRANGE"],
    FIELDNAME: ["ID", "STATUS"],
    POSITION: ["0001", "0002"],
    CHECKTABLE: ["", ""],
    DOMNAME: ["", "ZSTATUS_RANGE"],
  });
  const ZRANGE_DOMAIN_VALUES_BODY = body({
    DOMNAME: ["ZSTATUS_RANGE"],
    VALPOS: ["0001"],
    DOMVALUE_L: ["A"],
    DOMVALUE_H: ["Z"], // non-blank -> this row describes a range, not a fixed value
    APPVAL: [""],
  });

  it("a range domain produces no finding, and adds a note explaining why it was skipped", async () => {
    const { conn } = queueConn([ZRANGE_VIEWS_BODY, ZRANGE_EVENTS_BODY, ZRANGE_FIELD_CHECKS_BODY, ZRANGE_DOMAIN_VALUES_BODY]);
    const q: ImgChecksQuery = {
      table: "ZRANGE",
      view: "ZRANGE",
      clientField: "CLIENT",
      language: "E",
      checkValues: true,
      rows: [{ key: { ID: "1" }, values: { STATUS: "M" } }],
    };
    const result = await readImgChecks(conn, q);

    expect(result.fixedValueFindings).toEqual([]);
    expect(result.notes.some((n) => n.includes("ZSTATUS_RANGE") && n.toUpperCase().includes("RANGE"))).toBe(true);
  });

  it("statementsIssued is 4 when no events were found (no view over the table, DD07T text lookup skipped)", async () => {
    const { conn } = queueConn([ZRANGE_VIEWS_BODY, ZRANGE_EVENTS_BODY, ZRANGE_FIELD_CHECKS_BODY, ZRANGE_DOMAIN_VALUES_BODY]);
    const q: ImgChecksQuery = {
      table: "ZRANGE",
      view: "ZRANGE",
      clientField: "CLIENT",
      language: "E",
      checkValues: true,
      rows: [{ key: { ID: "1" }, values: { STATUS: "M" } }],
    };
    const result = await readImgChecks(conn, q);

    expect(result.events).toEqual([]);
    expect(result.statementsIssued).toBe(4);
  });
});

describe("readImgChecks — checkValues: false (delete case)", () => {
  it("issues no DD07L fixed-values query and returns no fixedValueFindings", async () => {
    // No 5th (DD07L) body queued: if the code wrongly issued that read anyway,
    // queueConn's fake would throw "no fixture queued for call #5" and fail the test.
    const { conn, calls } = queueConn([TB003_VIEWS_BODY, TB003_EVENTS_BODY, MAINTEVENT_TEXTS_BODY, TB003_FIELD_CHECKS_BODY]);
    const result = await readImgChecks(conn, tb003Query({ checkValues: false, rows: [{ key: { ROLE: "ZBUP001" } }] }));

    expect(result.fixedValueFindings).toEqual([]);
    expect(calls).toHaveLength(4);
  });
});

describe("readImgChecks — tolerance of malformed responses", () => {
  it("a DD03L response whose columns don't match what the query asked for yields a note and an empty finding list, not a throw", async () => {
    // Wrong shape entirely: only TABNAME/FIELDNAME come back, no POSITION/CHECKTABLE/DOMNAME —
    // mapRows drops every row as unusable instead of crashing on a missing column.
    const malformedFieldChecksBody = body({ TABNAME: ["TB003"], FIELDNAME: ["ROLE"] });
    const { conn } = queueConn([TB003_VIEWS_BODY, TB003_EVENTS_BODY, MAINTEVENT_TEXTS_BODY, malformedFieldChecksBody]);

    const result = await readImgChecks(
      conn,
      tb003Query({ checkValues: false, rows: [{ key: { ROLE: "ZBUP001" } }] }),
    );

    expect(result.checkTables).toEqual([]);
    expect(result.fixedValueFindings).toEqual([]);
    expect(result.notes.some((n) => n.includes("DD03L") && n.toLowerCase().includes("unusable shape"))).toBe(true);
  });
});
