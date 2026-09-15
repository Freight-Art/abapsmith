/**
 * `src/tools/preview-fixture.ts` — issue #115's `format: abap_value |
 * test_double` and `mask` for `abap_data_preview`.
 *
 * The three fixtures below are transcribed verbatim from
 * `/tmp/i115-captures/NOTES.md`, live `abap_data_preview` responses captured
 * on A4H (client 001, user DEVELOPER, 2026-09-15) — not hand-written to look
 * plausible. Each fixture's comment repeats the exact `--- COLUMNS ---` line
 * it came from so a reviewer can diff against the capture directly. `key:
 * false` on every column in every fixture is not an oversight: the live ADT
 * metadata reported `keyAttribute="false"` for every column in every
 * capture, including genuine primary keys such as DD02L-TABNAME and
 * TCURR-MANDT (NOTES.md section 4).
 */
import { describe, expect, it } from "vitest";

import type { PreviewColumn, PreviewResult } from "../src/adt/datapreview.js";
import {
  ABAP_LINE_MAX,
  MASK_TEXT,
  abapLiteralFor,
  renderAbapValue,
  renderTestDouble,
} from "../src/tools/preview-fixture.js";

// ------------------------------------------------------------- fixtures ---

/** Finds a column by DDIC name, or fails loudly — a missing column means a fixture typo, not a real "not found". */
function columnNamed(result: PreviewResult, name: string): PreviewColumn {
  const found = result.columns.find((c) => c.name === name);
  if (!found) {
    throw new Error(`fixture bug: no column named '${name}' in table '${result.table}'`);
  }
  return found;
}

/**
 * Live `abap_data_preview` on A4H, client 001, user DEVELOPER, 2026-09-15.
 * `--- COLUMNS ---`:
 * TABNAME:C AS4LOCAL:C AS4VERS:N TABCLASS:C DATMIN:N DATMAX:N DATAVG:N
 * CLIDEP:C AS4USER:C AS4DATE:D AS4TIME:T PROZPUFF:N QUOTA_MAX_FIELDS:N
 * Three captured rows. CLIDEP is an EMPTY cell in all three (NOTES.md #1).
 */
const DD02L_PREVIEW: PreviewResult = {
  table: "DD02L",
  columns: [
    { name: "TABNAME", type: "C", key: false },
    { name: "AS4LOCAL", type: "C", key: false },
    { name: "AS4VERS", type: "N", key: false },
    { name: "TABCLASS", type: "C", key: false },
    { name: "DATMIN", type: "N", key: false },
    { name: "DATMAX", type: "N", key: false },
    { name: "DATAVG", type: "N", key: false },
    { name: "CLIDEP", type: "C", key: false },
    { name: "AS4USER", type: "C", key: false },
    { name: "AS4DATE", type: "D", key: false },
    { name: "AS4TIME", type: "T", key: false },
    { name: "PROZPUFF", type: "N", key: false },
    { name: "QUOTA_MAX_FIELDS", type: "N", key: false },
  ],
  rows: [
    ["DD02L", "A", "0000", "TRANSP", "0000000000", "0000000000", "0000000000", "", "SAP", "20201126", "140651", "000", "00000"],
    ["TADIR", "A", "0000", "TRANSP", "0000000000", "0000000000", "0000000000", "", "SAP", "20191111", "133909", "000", "00000"],
    ["T000", "A", "0000", "TRANSP", "0000000000", "0000000000", "0000000000", "", "SAP", "20220502", "105624", "000", "00000"],
  ],
  rowsRequested: 3,
  moreRowsExist: false,
  messages: [],
};

/**
 * Live `abap_data_preview` on A4H, client 001, user DEVELOPER, 2026-09-15.
 * `--- COLUMNS ---`:
 * MANDT:C(3) KURST:C(4) FCURR:C(5) TCURR:C(5) GDATU:C(10) UKURS:P(12)
 * FFACT:P(11) TFACT:P(11)
 * Four of many captured rows (`moreRowsExist: true`), including the two with
 * UKURS `0.94000-` — a NEGATIVE packed value rendered with a TRAILING minus
 * by ADT (NOTES.md #2). MANDT arrives as `C`, not `CLNT`; GDATU arrives as
 * `C`, not `D`/`N`.
 */
const TCURR_PREVIEW: PreviewResult = {
  table: "TCURR",
  columns: [
    { name: "MANDT", type: "C", length: 3, key: false },
    { name: "KURST", type: "C", length: 4, key: false },
    { name: "FCURR", type: "C", length: 5, key: false },
    { name: "TCURR", type: "C", length: 5, key: false },
    { name: "GDATU", type: "C", length: 10, key: false },
    { name: "UKURS", type: "P", length: 12, key: false },
    { name: "FFACT", type: "P", length: 11, key: false },
    { name: "TFACT", type: "P", length: 11, key: false },
  ],
  rows: [
    ["001", "100*", "EUR", "USD", "79989898", "0.94000", "0", "0"],
    ["001", "100*", "USD", "EUR", "79989898", "0.94000-", "0", "0"],
    ["001", "1001", "EUR", "USD", "79989898", "0.94000", "0", "0"],
    ["001", "1001", "USD", "EUR", "79989898", "0.94000-", "0", "0"],
  ],
  rowsRequested: 4,
  moreRowsExist: true,
  messages: [],
};

/**
 * Live `abap_data_preview` on A4H, client 001, user DEVELOPER, 2026-09-15.
 * `--- COLUMNS ---`:
 * CLSNAME:C VERSION:N STATE:N CHANGEDON:D DURATION_TYPE:b RISK_LEVEL:b
 * WITH_UNIT_TESTS:C
 * Two captured rows. WITH_UNIT_TESTS is empty in the first row, `X` in the
 * second. `type: "b"` for DURATION_TYPE/RISK_LEVEL is kept LOWER-CASE, exactly
 * as the wire delivered it (NOTES.md #3: the integer family, e.g. INT1,
 * arrives lower-case).
 */
const SEOCLASSDF_PREVIEW: PreviewResult = {
  table: "SEOCLASSDF",
  columns: [
    { name: "CLSNAME", type: "C", key: false },
    { name: "VERSION", type: "N", key: false },
    { name: "STATE", type: "N", key: false },
    { name: "CHANGEDON", type: "D", key: false },
    { name: "DURATION_TYPE", type: "b", key: false },
    { name: "RISK_LEVEL", type: "b", key: false },
    { name: "WITH_UNIT_TESTS", type: "C", key: false },
  ],
  rows: [
    ["CL_ABAP_TYPEDESCR", "1", "1", "20250129", "0", "0", ""],
    ["CL_ABAP_UNIT_ASSERT", "1", "1", "20240930", "0", "0", "X"],
  ],
  rowsRequested: 2,
  moreRowsExist: false,
  messages: [],
};

/**
 * Synthetic (not from a capture — the brief calls for a manufactured edge
 * case): one row of 40 character columns, each 30 characters wide, so the
 * single-line row group would be well over `ABAP_LINE_MAX` and must wrap.
 */
const WIDE_COLUMNS: PreviewColumn[] = Array.from({ length: 40 }, (_, i) => ({
  name: `FIELD${String(i + 1).padStart(2, "0")}`,
  type: "C",
  length: 30,
  key: false,
}));
const WIDE_CELL = "X".repeat(30);
const WIDE_PREVIEW: PreviewResult = {
  table: "ZWIDE_FIXTURE",
  columns: WIDE_COLUMNS,
  rows: [WIDE_COLUMNS.map(() => WIDE_CELL)],
  rowsRequested: 1,
  moreRowsExist: false,
  messages: [],
};

// ------------------------------------------------------------ abapLiteralFor ---

describe("abapLiteralFor", () => {
  it("quotes character types and doubles an embedded apostrophe", () => {
    const column: PreviewColumn = { name: "MTEXT", type: "C", key: false };
    expect(abapLiteralFor(column, "A's client")).toBe("'A''s client'");
  });

  it("keeps NUMC as a quoted string so leading zeros survive", () => {
    const column = columnNamed(DD02L_PREVIEW, "AS4VERS");
    expect(abapLiteralFor(column, "0000")).toBe("'0000'");
    expect(abapLiteralFor(column, "0000")).not.toBe("0");
  });

  it("renders D as 'YYYYMMDD' and T as 'HHMMSS'", () => {
    const dateColumn = columnNamed(DD02L_PREVIEW, "AS4DATE");
    const timeColumn = columnNamed(DD02L_PREVIEW, "AS4TIME");
    expect(abapLiteralFor(dateColumn, "20201126")).toBe("'20201126'");
    expect(abapLiteralFor(timeColumn, "140651")).toBe("'140651'");
  });

  it("emits an integer bare", () => {
    // Regression test for lower-case wire type codes: SEOCLASSDF-DURATION_TYPE
    // arrived as "b" (INT1), not "B" — see NOTES.md #3.
    const column = columnNamed(SEOCLASSDF_PREVIEW, "DURATION_TYPE");
    expect(column.type).toBe("b");
    expect(abapLiteralFor(column, "0")).toBe("0");
  });

  it("moves ADT's trailing minus to the front for a packed value", () => {
    // Live capture (NOTES.md #2): TCURR-UKURS for a USD -> EUR row rendered
    // by ADT as "0.94000-" — a TRAILING minus, which is not valid ABAP.
    const column = columnNamed(TCURR_PREVIEW, "UKURS");
    const result = abapLiteralFor(column, "0.94000-");
    expect(result).toBe("'-0.94000'");
    expect(result.endsWith("-'")).toBe(false);
    expect(result.at(-1)).not.toBe("-");
  });

  it("renders a positive packed value in quoted ABAP literal form", () => {
    const column = columnNamed(TCURR_PREVIEW, "UKURS");
    expect(abapLiteralFor(column, "0.94000")).toBe("'0.94000'");
  });

  it("falls back to a quoted raw cell rather than guessing when the digits do not fit the type", () => {
    const column: PreviewColumn = { name: "SOMEDATE", type: "D", key: false };
    expect(abapLiteralFor(column, "not-a-date")).toBe("'not-a-date'");
  });

  it("never emits a bare value for an unrecognised type", () => {
    const column: PreviewColumn = { name: "WEIRD", type: "ZZ", key: false };
    expect(abapLiteralFor(column, "7")).toBe("'7'");
  });
});

// ------------------------------------------------------------ renderAbapValue ---

describe("renderAbapValue", () => {
  it("emits the TYPES line above a VALUE literal named for the entity", () => {
    const render = renderAbapValue({ result: DD02L_PREVIEW, maskedFields: [] });
    expect(render.text.startsWith("TYPES ty_rows TYPE STANDARD TABLE OF dd02l WITH EMPTY KEY.")).toBe(true);
    expect(render.text).toContain("DATA(lt_rows) = VALUE ty_rows(");
    expect(render.text.endsWith(").")).toBe(true);
  });

  it("emits one parenthesised group per row", () => {
    const render = renderAbapValue({ result: DD02L_PREVIEW, maskedFields: [] });
    const groupLines = render.text.split("\n").filter((l) => /^\s*\(/.test(l));
    expect(groupLines.length).toBe(3);
  });

  it("omits an empty cell when the column is not a key", () => {
    const render = renderAbapValue({ result: DD02L_PREVIEW, maskedFields: [] });
    expect(render.text).not.toContain("clidep =");
  });

  it("discloses that cells were omitted and that the key metadata is unreliable", () => {
    const render = renderAbapValue({ result: DD02L_PREVIEW, maskedFields: [] });
    // Live captures (NOTES.md #4): the ADT preview reported keyAttribute=false
    // for every column in every capture, including genuine primary keys — so
    // this disclosure is necessary, not decorative.
    expect(render.notes.some((n) => n.includes("omitted"))).toBe(true);
    expect(render.notes.some((n) => n.includes("key attribute"))).toBe(true);
  });

  it("emits a key column even when its cell is empty", () => {
    const keyedResult: PreviewResult = {
      ...DD02L_PREVIEW,
      columns: DD02L_PREVIEW.columns.map((c) => (c.name === "CLIDEP" ? { ...c, key: true } : c)),
    };
    const render = renderAbapValue({ result: keyedResult, maskedFields: [] });
    expect(render.text).toContain("clidep = ''");
  });

  it("follows the caller's columns order when one is given", () => {
    const render = renderAbapValue({
      result: DD02L_PREVIEW,
      maskedFields: [],
      columnOrder: ["AS4DATE", "TABNAME"],
    });
    const firstGroup = render.text.split("\n").find((l) => /^\s*\(/.test(l));
    expect(firstGroup?.trim()).toBe("( as4date = '20201126' tabname = 'DD02L' )");
  });

  it("falls back to DDIC order when no columns order is given", () => {
    const render = renderAbapValue({ result: DD02L_PREVIEW, maskedFields: [] });
    const firstGroup = render.text.split("\n").find((l) => /^\s*\(/.test(l));
    expect(firstGroup?.trim().startsWith("( tabname =")).toBe(true);
  });

  it("ignores a name in columns order that is not a column", () => {
    expect(() =>
      renderAbapValue({ result: DD02L_PREVIEW, maskedFields: [], columnOrder: ["TABNAME", "NOPE"] }),
    ).not.toThrow();
    const render = renderAbapValue({
      result: DD02L_PREVIEW,
      maskedFields: [],
      columnOrder: ["TABNAME", "NOPE"],
    });
    expect(render.text).not.toContain("nope");
  });

  it("always states that the fixture is governed by the preview's own policy", () => {
    const render = renderAbapValue({ result: DD02L_PREVIEW, maskedFields: [] });
    const firstNote = render.notes[0] ?? "";
    expect(firstNote).toContain("deny-list");
    expect(firstNote).toContain("ABAP_ALLOW_DATA_PREVIEW");
    expect(firstNote).toContain("applied to rows already fetched");
  });

  it("keeps every emitted line at or under the ABAP source line limit", () => {
    const render = renderAbapValue({ result: WIDE_PREVIEW, maskedFields: [] });
    const lines = render.text.split("\n");
    expect(lines.every((l) => l.length <= ABAP_LINE_MAX)).toBe(true);
    for (const column of WIDE_COLUMNS) {
      const fieldName = column.name.toLowerCase();
      const occurrences = render.text.split(`${fieldName} =`).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it("emits an empty literal and says so when the preview returned no rows", () => {
    const emptyResult: PreviewResult = { ...DD02L_PREVIEW, rows: [], rowsRequested: 0 };
    const render = renderAbapValue({ result: emptyResult, maskedFields: [] });
    expect(render.text).toContain("VALUE ty_rows( ).");
    expect(render.notes.some((n) => n.toLowerCase().includes("no rows"))).toBe(true);
  });
});

// ----------------------------------------------------- renderAbapValue with mask ---

describe("renderAbapValue with mask", () => {
  it("replaces a character field with the MASKED constant", () => {
    const render = renderAbapValue({ result: DD02L_PREVIEW, maskedFields: ["AS4USER"] });
    expect(render.text).toContain(`as4user = '${MASK_TEXT}'`);
    expect(render.text.split("as4user =").length - 1).toBe(3);
    expect(render.text).not.toContain("'SAP'");
  });

  it("reduces a non-character field to its initial value", () => {
    // AS4DATE is not a key column in DD02L_PREVIEW. Masking deliberately
    // overrides the empty-cell omission rule, so the field is still emitted
    // — carrying its initial-value literal ('00000000' for a "D" column, per
    // maskedInitialLiteral in src/tools/preview-fixture.ts), not the real cell.
    const render = renderAbapValue({ result: DD02L_PREVIEW, maskedFields: ["AS4DATE"] });
    expect(render.text).not.toContain("20201126");
    const occurrences = render.text.split("as4date = '00000000'").length - 1;
    expect(occurrences).toBe(3);
  });

  it("emits a masked field even when the underlying cell is empty", () => {
    // CLIDEP is empty in all three live rows and is not a key column —
    // ordinarily that means the empty-cell omission rule would drop it, but
    // masking wins regardless of whether the cell happened to be empty.
    const render = renderAbapValue({ result: DD02L_PREVIEW, maskedFields: ["CLIDEP"] });
    const occurrences = render.text.split(`clidep = '${MASK_TEXT}'`).length - 1;
    expect(occurrences).toBe(3);
  });

  it("matches a masked field against the upper-cased DDIC column name", () => {
    // The tool normalises `mask` to upper case before calling the renderer,
    // so the caller-facing case is not exercised here. What this test pins
    // is that the renderer's own matching is done against `column.name`
    // upper-cased, and DD02L-AS4USER is already upper-case on the wire —
    // exactly the shape the tool always hands the renderer.
    const column = columnNamed(DD02L_PREVIEW, "AS4USER");
    expect(column.name).toBe(column.name.toUpperCase());
    const render = renderAbapValue({ result: DD02L_PREVIEW, maskedFields: ["AS4USER"] });
    expect(render.text).toContain(`'${MASK_TEXT}'`);
    expect(render.text).not.toContain("'SAP'");
  });
});

// ------------------------------------------------------------ renderTestDouble ---

describe("renderTestDouble", () => {
  it("wraps the literal in a cl_osql_test_environment fixture", () => {
    const render = renderTestDouble({ result: TCURR_PREVIEW, maskedFields: [] });
    expect(render.text).toContain("cl_osql_test_environment=>create( VALUE #( ( 'TCURR' ) ) )");
    expect(render.text).toContain("insert_test_data( lt_rows )");
    expect(render.text).toContain("class_teardown");
    expect(render.text).toContain("destroy( )");
  });

  it("reports the fixture kind it chose", () => {
    const render = renderTestDouble({ result: TCURR_PREVIEW, maskedFields: [] });
    expect(render.fixtureKind).toBe("osql_test_environment");
  });

  it("states what cl_osql_test_environment can and cannot double", () => {
    const render = renderTestDouble({ result: TCURR_PREVIEW, maskedFields: [] });
    expect(render.notes.some((n) => n.includes("cl_abap_testdouble"))).toBe(true);
    expect(render.notes.some((n) => n.includes("doubles a class") && n.includes("not a table"))).toBe(true);
  });

  it("keeps every emitted line at or under the ABAP source line limit once indented", () => {
    // Regression test for the extra `cl_osql_test_environment` indentation
    // eating into the 255-character budget on top of the plain literal case.
    const render = renderTestDouble({ result: WIDE_PREVIEW, maskedFields: [] });
    const lines = render.text.split("\n");
    expect(lines.every((l) => l.length <= ABAP_LINE_MAX)).toBe(true);
  });

  it("carries the negative packed value through into the fixture", () => {
    const render = renderTestDouble({ result: TCURR_PREVIEW, maskedFields: [] });
    expect(render.text).toContain("'-0.94000'");
    expect(render.text).not.toContain("'0.94000-'");
  });
});
