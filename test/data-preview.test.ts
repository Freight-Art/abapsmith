/**
 * DDIC data preview.
 *
 * Every parser assertion in this file is driven by the bytes A4H actually sent
 * on 2026-08-11, pulled through the cassette registry
 * (`test/cassettes/registry.ts`) rather than from XML written here. That is the
 * point: this repo has shipped defects from hand-authored fixtures that were
 * politer than the wire (the reason the cassette format exists at all), and
 * three of the behaviours guarded below — the `"000"` → `0` corruption, the
 * self-closing empty cell, the one-column/one-row collapse — are precisely the
 * ones a hand-written fixture would have gotten wrong in the same direction as
 * the code.
 *
 * The failure inputs are likewise built from the captured 400 envelopes through
 * `abap-adt-api`'s own exception factory (`fromResponse`, the function
 * `AdtHTTP` itself calls), so the classifier sees the shape the transport
 * really throws.
 */
import { fromResponse } from "abap-adt-api/build/AdtException.js";
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";

import type { AbapConnection } from "../src/adt/connection.js";
import {
  classifyPreviewFailure,
  isValidDdicEntityName,
  parsePreviewBody,
  previewDdicEntity,
} from "../src/adt/datapreview.js";
import { AbapError } from "../src/adt/errors.js";
import { renderPreview } from "../src/tools/data-preview.js";
import { loadAllCassettes } from "./cassettes/registry.js";
import type { Cassette } from "./cassettes/schema.js";

// ---------------------------------------------------------------- cassettes ---

const T000_ROWS3 = "ddic-t000-rows3";
const SVERS_1x1 = "ddic-svers-single-column-single-row";
const NOT_FOUND_400 = "ddic-table-not-found-400";
const INJECTION_200 = "ddic-injection-where-executed-200";
const INJECTION_400 = "ddic-injection-boolean-expression-400";
/** CDS view WITH parameters: 200, zero columns, one in-band `I` message. */
const CDS_PARAMS_MESSAGE = "ddic-cds-with-parameters-inband-message";
/** `/BOFU/CV_BPRELSHPCONTACTPERSON` — 30 chars, 8 columns, genuinely empty. */
const NAMESPACED_30 = "ddic-namespaced-name-30-chars";

const CASSETTES = new Map<string, Cassette>(loadAllCassettes().map((c) => [c.id, c]));

function cassette(id: string): Cassette {
  const found = CASSETTES.get(id);
  if (!found) {
    // Loud rather than skipped: a missing cassette means these tests would
    // silently stop testing the wire, which is the failure mode the whole
    // mechanism exists to prevent.
    throw new Error(
      `cassette '${id}' not found under test/cassettes/ — known ids: ` +
        `${[...CASSETTES.keys()].join(", ")}`,
    );
  }
  return found;
}

/** The exact response bytes the appliance sent for `id`. */
function capturedBody(id: string): string {
  const body = cassette(id).response.body;
  if (body === null) throw new Error(`cassette '${id}' has no response body`);
  return body;
}

/** The captured `<exc:exception>` 400 rebuilt into the error the transport throws. */
function capturedFailure(id: string): unknown {
  const c = cassette(id);
  const body = capturedBody(id);
  return fromResponse(body, {
    status: c.response.status,
    statusText: "",
    headers: c.response.headers,
    body,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

// ----------------------------------------------------------- fake connection ---

interface PreviewCall {
  table: string;
  rowNumber: number;
}

/**
 * Minimal `AbapConnection` exposing only `dataPreviewDdic`, following the house
 * convention (`test/ddic.test.ts:290`, `test/read-search.test.ts:189`): a plain
 * object cast through `unknown`, recording what it was asked for so a test can
 * assert on the *absence* of a call as well as its arguments.
 */
function fakeConn(handler: (table: string, rowNumber: number) => string | never): {
  conn: AbapConnection;
  calls: PreviewCall[];
} {
  const calls: PreviewCall[] = [];
  const conn = {
    async dataPreviewDdic(table: string, rowNumber: number) {
      calls.push({ table, rowNumber });
      return { body: handler(table, rowNumber), status: 200, headers: {} };
    },
  } as unknown as AbapConnection;
  return { conn, calls };
}

/** Always answers with one captured body, whatever it is asked. */
function connServing(cassetteId: string): { conn: AbapConnection; calls: PreviewCall[] } {
  return fakeConn(() => capturedBody(cassetteId));
}

function expectAbapError(fn: () => unknown, code: string): AbapError {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(AbapError);
  const err = thrown as AbapError;
  expect(err.code).toBe(code);
  return err;
}

/**
 * Cell accessor returning `unknown`, deliberately: `noUncheckedIndexedAccess`
 * is on, and a missing cell is one of the failures these tests exist to catch,
 * so it must reach the assertion as `undefined` rather than be asserted away
 * with `!`. `expect(at(rows, 0, 3)).toBe("000")` fails loudly on a short row.
 */
const at = (rows: string[][], r: number, c: number): unknown => rows[r]?.[c];

/** Row accessor that throws rather than typing the gap away. */
function rowAt(rows: string[][], r: number): string[] {
  const found = rows[r];
  if (found === undefined) throw new Error(`expected a row at index ${r}, got none`);
  return found;
}

async function expectRejectsWith(p: Promise<unknown>, code: string): Promise<AbapError> {
  const caught = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(caught).toBeInstanceOf(AbapError);
  const err = caught as AbapError;
  expect(err.code).toBe(code);
  return err;
}

// =============================================================== name checks ===

describe("isValidDdicEntityName", () => {
  it("rejects the injection string the appliance actually executed", () => {
    // CAPTURED (`ddic-injection-where-executed-200`): sending
    // ddicEntityName=T000 WHERE MANDT = '000' returned **HTTP 200** with the
    // WHERE applied server-side — one row (client 000) where the unfiltered
    // table returns two — and `<dataPreview:name>` echoed the injected string
    // straight back. The server concatenates this parameter into SQL. So this
    // rejection is a *correctness* requirement, not defence in depth: it is
    // the only thing standing between a name parameter and an arbitrary WHERE.
    expect(isValidDdicEntityName("T000 WHERE MANDT = '000'")).toBe(false);

    const injected = cassette(INJECTION_200);
    expect(injected.response.status).toBe(200);
    // Verbatim from the capture — the appliance echoes the apostrophes raw,
    // unescaped, inside the element.
    expect(capturedBody(INJECTION_200)).toContain(
      "<dataPreview:name>T000 WHERE MANDT = '000'</dataPreview:name>",
    );
    // And the filter really took effect: the unfiltered T000 capture has two
    // clients, the injected one has a single MANDT cell.
    expect(capturedBody(INJECTION_200).match(/<dataPreview:data>/g)?.length).toBeLessThan(
      capturedBody(T000_ROWS3).match(/<dataPreview:data>/g)?.length ?? 0,
    );
  });

  it("rejects the second captured injection (HTTP 400, Boolean expression)", () => {
    expect(isValidDdicEntityName("T000 WHERE 1=1")).toBe(false);
    expect(cassette(INJECTION_400).response.status).toBe(400);
  });

  const rejected: Array<[string, string]> = [
    ["", "empty"],
    [" ", "whitespace only"],
    ["T000 ", "trailing space (untrimmed)"],
    [" T000", "leading space (untrimmed)"],
    ["T 000", "interior space"],
    ["T000\tDD02L", "tab"],
    ["T000\nDD02L", "newline"],
    ["T000;DROP", "semicolon"],
    ["T000'", "single quote"],
    ['T000"', "double quote"],
    ["T000*", "asterisk / wildcard"],
    ["*", "bare wildcard"],
    ["T000(1)", "parentheses"],
    ["(T000)", "parentheses"],
    ["T000=1", "equals"],
    ["T000-1", "hyphen"],
    ["T000,DD02L", "comma"],
    ["T000.DD02L", "dot"],
    ["SELECT * FROM T000", "an SQL statement"],
    ["t000", "lower case (caller must normalise first)"],
    ["0T000", "leading digit"],
    ["_T000", "leading underscore"],
    ["A".repeat(31), "31 characters — over the 30-char DDIC ceiling"],
    ["/NS/", "namespace with no object name"],
    ["/NS", "unterminated namespace"],
    ["NS/TABLE", "namespace without the leading slash"],
    ["/NS/TABLE/EXTRA", "three segments"],
    ["/TOOLONGNAMES/TAB", "namespace over 10 characters"],
    ["/NS/TABLE ", "namespaced with a trailing space"],
    // The second segment is capped at 30, but the WHOLE name is capped at 30
    // too, so a maximal namespace plus a maximal segment is still refused. If
    // only the segment cap existed this would be a 42-character name and would
    // pass — which is the bug the overall length check exists to prevent.
    [`/${"N".repeat(10)}/${"A".repeat(30)}`, "42 characters — segments legal, whole name over 30"],
    [`/BOFU/${"A".repeat(25)}`, "31 characters — one over the DDIC ceiling"],
    ["/NS/TABLE-1", "namespaced with a hyphen"],
    ["/NS/T000 WHERE MANDT = '000'", "the captured injection wearing a namespace"],
  ];
  it.each(rejected)("rejects %j (%s)", (name) => {
    expect(isValidDdicEntityName(name)).toBe(false);
  });

  const accepted = [
    "T000",
    "DD02L",
    "SVERS",
    "/NS/TABLE",
    "/ACME/PA0008",
    "Z_MY_TABLE",
    "A",
    "A".repeat(30),
    // 30 characters, 24 of them in the second segment — a real, SAP-shipped
    // entity this endpoint serves. See the cassette-driven test below.
    "/BOFU/CV_BPRELSHPCONTACTPERSON",
    // Exactly 30 with a maximal 10-character namespace.
    `/${"N".repeat(10)}/${"A".repeat(18)}`,
  ];
  it.each(accepted)("accepts %j", (name) => {
    expect(isValidDdicEntityName(name)).toBe(true);
  });

  it("accepts the 30-character namespaced name the appliance actually serves", () => {
    // The defect: NAMESPACED_NAME_RE capped the second segment at 20, so
    // /BOFU/CV_BPRELSHPCONTACTPERSON (namespace 4 + segment 24 = 30 chars) was
    // refused client-side with BAD_INPUT and no request was ever sent — while
    // the appliance answers the very same name with 200 and 8 columns. The cap
    // was ours, not the server's, and it was wrong.
    const name = "/BOFU/CV_BPRELSHPCONTACTPERSON";
    expect(name).toHaveLength(30);
    expect(isValidDdicEntityName(name)).toBe(true);

    const served = cassette(NAMESPACED_30);
    expect(served.response.status).toBe(200);
    expect(capturedBody(NAMESPACED_30)).toContain(
      `<dataPreview:name>${name}</dataPreview:name>`,
    );
    expect(capturedBody(NAMESPACED_30).match(/<dataPreview:metadata /g)).toHaveLength(8);
  });

  it("still refuses everything longer than the 30-character DDIC ceiling", () => {
    // Widening the segment must not widen the name: the guarantee is a total
    // length bound, checked before either pattern runs.
    for (let n = 31; n <= 40; n++) {
      expect(isValidDdicEntityName("A".repeat(n))).toBe(false);
      expect(isValidDdicEntityName(`/NS/${"A".repeat(n - 4)}`)).toBe(false);
    }
  });
});

// ================================================================== parsing ===

describe("parsePreviewBody — captured T000 body", () => {
  const parsed = parsePreviewBody(capturedBody(T000_ROWS3));

  it("reads the column-major envelope into 17 columns and 2 rows", () => {
    expect(parsed.columns.map((c) => c.name).slice(0, 4)).toEqual([
      "MANDT",
      "MTEXT",
      "ORT01",
      "MWAER",
    ]);
    expect(parsed.columns).toHaveLength(17);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.columns[0]).toEqual({
      name: "MANDT",
      type: "C",
      length: 3,
      description: "Client",
      key: false,
    });
  });

  it("PINS parseTagValue:false — MANDT '000' stays the string \"000\", never 0", () => {
    const mandt = parsed.columns.findIndex((c) => c.name === "MANDT");
    expect(at(parsed.rows, 0, mandt)).toBe("000");
    expect(at(parsed.rows, 1, mandt)).toBe("001");
    // Not `toEqual`: `expect(0).toEqual("000")` fails, but the whole point is
    // that the *type* is the defect, so assert it explicitly too.
    expect(typeof at(parsed.rows, 0, mandt)).toBe("string");

    // The trap is real, over these exact bytes. With the parser's default
    // tag-value coercion the same capture yields the NUMBER 0 — every DDIC
    // CHAR/NUMC key with leading zeros silently corrupted, and the corruption
    // looks like data. This control is what makes the assertion above a
    // regression test rather than a tautology.
    const coercing = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      removeNSPrefix: true,
      parseAttributeValue: false,
      trimValues: true,
      isArray: (_n, jpath) =>
        jpath === "tableData.columns" || jpath === "tableData.columns.dataSet.data",
      // parseTagValue left at its default (true) — this is the wrong config.
    });
    const naive = coercing.parse(capturedBody(T000_ROWS3)) as {
      tableData: { columns: Array<{ dataSet: { data: unknown[] } }> };
    };
    const naiveMandt = naive.tableData.columns[0]?.dataSet.data[0];
    expect(naiveMandt).toBe(0);
    expect(typeof naiveMandt).toBe("number");
  });

  it("keeps a NUMC-style date column as its literal digits", () => {
    const d = parsed.columns.findIndex((c) => c.name === "CHANGEDATE");
    expect(at(parsed.rows, 0, d)).toBe("00000000");
    expect(at(parsed.rows, 1, d)).toBe("20170713");
  });

  it("turns self-closing <dataPreview:data/> into \"\" without shifting alignment", () => {
    // The capture really does contain empty cells — this is not a constructed
    // case (ADRNR, CCNOCLIIND, CCNOCASCAD… are all empty in both rows, and
    // CCCOPYLOCK is empty in row 1 only, so a dropped cell would slide the
    // column's second value up into the first row and go unnoticed).
    expect(capturedBody(T000_ROWS3)).toContain("<dataPreview:data/>");

    const idx = (n: string) => parsed.columns.findIndex((c) => c.name === n);
    expect(at(parsed.rows, 0, idx("ADRNR"))).toBe("");
    expect(at(parsed.rows, 1, idx("ADRNR"))).toBe("");
    // The asymmetric column: present in row 0, empty in row 1.
    expect(at(parsed.rows, 0, idx("CCCOPYLOCK"))).toBe("X");
    expect(at(parsed.rows, 1, idx("CCCOPYLOCK"))).toBe("");
    // And the column *after* a run of empties still carries its own values —
    // the alignment proof: a dropped empty cell would put "BWDEVELOPER" in
    // row 0 and shorten the row.
    expect(at(parsed.rows, 0, idx("CHANGEUSER"))).toBe("");
    expect(at(parsed.rows, 1, idx("CHANGEUSER"))).toBe("BWDEVELOPER");
    expect(at(parsed.rows, 1, idx("LOGSYS"))).toBe("A4HCLNT001");
  });

  it("emits rows that are never sparse: every row is exactly as wide as columns", () => {
    for (const row of parsed.rows) {
      expect(row).toHaveLength(parsed.columns.length);
      for (const cell of row) expect(typeof cell).toBe("string");
    }
  });
});

describe("parsePreviewBody — singleton collapse (trap 2)", () => {
  // SVERS is an ordinary table that happens to be 1 column x 1 row, so this is
  // a routine result, not an edge case: fast-xml-parser collapses one-element
  // arrays, which makes `columns` an object and `dataSet.data` a bare string
  // unless `isArray` covers both jpaths. Blind iteration breaks on both.
  const parsed = parsePreviewBody(capturedBody(SVERS_1x1));

  it("yields a 1-column, 1-row result as real arrays", () => {
    expect(Array.isArray(parsed.columns)).toBe(true);
    expect(Array.isArray(parsed.rows)).toBe(true);
    expect(parsed.columns).toHaveLength(1);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.columns[0]?.name).toBe("VERSION");
    expect(parsed.rows[0]).toEqual(["754"]);
  });

  it("does not degrade into a string-indexed object or a bare string", () => {
    // The collapsed shapes this guards against: `columns` as `{metadata:…}`
    // (whose keys would be "metadata"/"dataSet", not "0"), and the single row
    // as the string "754" (whose [0] is "7").
    expect(Object.keys(parsed.columns)).toEqual(["0"]);
    expect(typeof parsed.rows[0]).not.toBe("string");
    expect(Array.isArray(parsed.rows[0])).toBe(true);
    expect(Object.keys(rowAt(parsed.rows, 0))).toEqual(["0"]);
    expect(at(parsed.rows, 0, 0)).toBe("754");
    expect(at(parsed.rows, 0, 0)).not.toBe("7");
  });
});

describe("parsePreviewBody — columns without a length attribute", () => {
  it("omits `length` rather than reporting NaN (captured: the injected query's metadata carries no length)", () => {
    const parsed = parsePreviewBody(capturedBody(INJECTION_200));
    expect(parsed.columns.length).toBeGreaterThan(0);
    for (const col of parsed.columns) {
      expect(col.length).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(col, "length")).toBe(false);
    }
  });
});

// ============================================================ previewDdicEntity ===

describe("previewDdicEntity — N+1 and the row ceiling", () => {
  it("returns at most maxRows and reports the extra row as moreRowsExist", async () => {
    // `rowNumber=N` returns N+1 rows (CAPTURED). The T000 capture holds 2 rows,
    // so asking for 1 is exactly that shape: the second row is the server
    // saying "there is more", not data to hand back.
    const { conn, calls } = connServing(T000_ROWS3);
    const result = await previewDdicEntity(conn, { table: "T000", maxRows: 1 });

    expect(result.rows).toHaveLength(1);
    expect(result.rows.length).toBeLessThanOrEqual(1);
    expect(result.moreRowsExist).toBe(true);
    expect(result.rowsRequested).toBe(1);
    expect(at(result.rows, 0, 0)).toBe("000");
    // The slice is applied to parsed rows, and `rowNumber` is sent as-is —
    // maxRows is never pre-incremented to "compensate" for the off-by-one.
    expect(calls).toEqual([{ table: "T000", rowNumber: 1 }]);
  });

  it("does not claim more rows exist when the server returned fewer than asked", async () => {
    const { conn, calls } = connServing(T000_ROWS3);
    const result = await previewDdicEntity(conn, { table: "T000", maxRows: 5 });
    expect(result.rows).toHaveLength(2);
    expect(result.moreRowsExist).toBe(false);
    expect(result.rowsRequested).toBe(5);
    expect(calls[0]?.rowNumber).toBe(5);
  });

  it("carries the 1x1 result through without collapsing", async () => {
    const { conn } = connServing(SVERS_1x1);
    const result = await previewDdicEntity(conn, { table: "SVERS", maxRows: 5 });
    expect(result.columns).toHaveLength(1);
    expect(result.rows).toEqual([["754"]]);
    expect(result.moreRowsExist).toBe(false);
  });

  it("normalises the name to upper case before sending it", async () => {
    const { conn, calls } = connServing(T000_ROWS3);
    const result = await previewDdicEntity(conn, { table: "  t000  ", maxRows: 5 });
    expect(calls[0]?.table).toBe("T000");
    expect(result.table).toBe("T000");
  });
});

describe("previewDdicEntity — totalRows is not a row count", () => {
  it("surfaces no row-count claim derived from <totalRows>, which ddic always reports as 0", async () => {
    // CAPTURED: `<dataPreview:totalRows>0</dataPreview:totalRows>` even in a
    // response that carries rows. On this endpoint the field is meaningless;
    // reporting it would tell the caller a populated table is empty.
    expect(capturedBody(T000_ROWS3)).toContain(
      "<dataPreview:totalRows>0</dataPreview:totalRows>",
    );

    const { conn } = connServing(T000_ROWS3);
    const result = await previewDdicEntity(conn, { table: "T000", maxRows: 5 });

    expect(Object.keys(result).sort()).toEqual(
      // `messages` joined this set when the in-band `<dataPreview:message>`
      // channel started being read; `totalRows` still must not, and that is
      // what this assertion is for.
      ["columns", "messages", "moreRowsExist", "rows", "rowsRequested", "table"].sort(),
    );
    expect(Object.keys(result).some((k) => /total/i.test(k))).toBe(false);
    // Nothing in the result carries the bogus 0 as a count.
    expect(result.rows).toHaveLength(2);
    expect(result.rowsRequested).toBe(5);
    for (const value of Object.values(result)) {
      expect(value).not.toBe(0);
    }
  });
});

describe("previewDdicEntity — refusals cost zero HTTP calls", () => {
  const invalidNames = [
    "T000 WHERE MANDT = '000'",
    "T000 WHERE 1=1",
    "T000;DROP",
    "SELECT * FROM T000",
    "",
    "A".repeat(31),
  ];
  it.each(invalidNames)("refuses %j with BAD_INPUT and issues no request", async (name) => {
    const { conn, calls } = connServing(T000_ROWS3);
    const err = await expectRejectsWith(
      previewDdicEntity(conn, { table: name, maxRows: 5 }),
      "BAD_INPUT",
    );
    expect(err.message).toContain("valid DDIC table or view name");
    // The name is the injection surface; a rejected one has nothing safe to
    // send, so validation must precede the request rather than accompany it.
    expect(calls).toEqual([]);
  });

  const badRowCounts: Array<[unknown, string]> = [
    [0, "0 means UNLIMITED on this endpoint"],
    [-1, "negative"],
    [1.5, "non-integer"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
  ];
  it.each(badRowCounts)("refuses maxRows=%p (%s) instead of clamping", async (maxRows) => {
    const { conn, calls } = connServing(T000_ROWS3);
    const err = await expectRejectsWith(
      previewDdicEntity(conn, { table: "T000", maxRows: maxRows as number }),
      "BAD_INPUT",
    );
    expect(err.message).toContain("positive integer");
    // P-32: the module must NOT re-default or clamp. The clamp lives in the
    // tool layer; here `0` is refused, never quietly turned into 1 or 100 —
    // and it is certainly never forwarded, because 0 on the wire pulled a
    // captured 155 924-row / 8.3 MB response.
    expect(calls).toEqual([]);
  });

  it("refuses maxRows=0 without ever consulting the connection", async () => {
    const conn = {
      dataPreviewDdic() {
        throw new Error("dataPreviewDdic must not be reached for maxRows=0");
      },
    } as unknown as AbapConnection;
    await expectRejectsWith(previewDdicEntity(conn, { table: "T000", maxRows: 0 }), "BAD_INPUT");
  });
});

describe("previewDdicEntity — transport failures classify", () => {
  it("maps the captured 'table not found' 400 to NOT_FOUND", async () => {
    const conn = {
      dataPreviewDdic() {
        throw capturedFailure(NOT_FOUND_400);
      },
    } as unknown as AbapConnection;
    const err = await expectRejectsWith(
      previewDdicEntity(conn, { table: "ZZNOSUCHTABLE", maxRows: 5 }),
      "NOT_FOUND",
    );
    expect(err.message).toContain("ZZNOSUCHTABLE");
  });
});

// ========================================================= error classification ===

// ==================================================== in-band message channel ===

/**
 * The silent-empty defect, end to end: captured bytes → parser → result →
 * rendered text.
 *
 * A CDS view WITH PARAMETERS is not refused with a 4xx. The appliance answers
 * HTTP 200, `<dataPreview:totalRows>0`, zero `<dataPreview:columns>`, and one
 * `<dataPreview:message ... severity="I"/>` saying the preview is not
 * supported. Structurally that is byte-for-byte the shape of a transparent
 * table holding no rows, so the tool rendered it as one and told the caller the
 * entity "was read successfully" and is "a genuinely empty result". Nothing was
 * read. The message is the only wire evidence, so it is parsed and stated.
 *
 * The pairing with `NAMESPACED_30` is deliberate and is the whole test: that
 * cassette is a REAL empty entity (zero rows, 8 columns, no message) captured
 * on the same run. If the fix had simply stopped claiming "empty" whenever
 * there are no rows, that cassette would fail — a genuine empty result must
 * still be reported as one.
 */
describe("dataPreview:message — the in-band silent-empty channel", () => {
  const MESSAGE_TEXT = "Data preview not supported for view with parameters";

  it("the captured body really is 200, zero columns, and a message (guards the fixture)", () => {
    const c = cassette(CDS_PARAMS_MESSAGE);
    expect(c.response.status).toBe(200);
    const body = capturedBody(CDS_PARAMS_MESSAGE);
    expect(body).toContain("<dataPreview:totalRows>0</dataPreview:totalRows>");
    expect(body).not.toContain("<dataPreview:columns>");
    expect(body).toContain(
      `<dataPreview:message dataPreview:text="${MESSAGE_TEXT}" dataPreview:severity="I"/>`,
    );
  });

  it("parses the message out of the captured DEMO_CDS_PARA body", () => {
    const parsed = parsePreviewBody(capturedBody(CDS_PARAMS_MESSAGE));
    expect(parsed.columns).toEqual([]);
    expect(parsed.rows).toEqual([]);
    // `removeNSPrefix` strips the prefix from attributes too: the wire's
    // `dataPreview:text` must be read as `@_text`, not `@_dataPreview:text`.
    expect(parsed.messages).toEqual([{ text: MESSAGE_TEXT, severity: "I" }]);
  });

  it("reports no messages for an ordinary populated read", () => {
    expect(parsePreviewBody(capturedBody(T000_ROWS3)).messages).toEqual([]);
    expect(parsePreviewBody(capturedBody(SVERS_1x1)).messages).toEqual([]);
  });

  it("reports no messages for a genuinely empty entity", () => {
    // 8 columns, every <dataPreview:dataSet/> self-closing, no message.
    const parsed = parsePreviewBody(capturedBody(NAMESPACED_30));
    expect(parsed.columns).toHaveLength(8);
    expect(parsed.rows).toEqual([]);
    expect(parsed.messages).toEqual([]);
  });

  it("carries the message through previewDdicEntity instead of throwing", async () => {
    // DECISION (documented at the return site in datapreview.ts): an in-band
    // message is reported, never thrown — the response is 200 and may carry
    // real rows alongside the message, and only severity "I" has ever been
    // captured, so mapping a severity onto an AbapError code would be invented
    // wire semantics.
    const { conn } = connServing(CDS_PARAMS_MESSAGE);
    const result = await previewDdicEntity(conn, { table: "DEMO_CDS_PARA", maxRows: 5 });
    expect(result.messages).toEqual([{ text: MESSAGE_TEXT, severity: "I" }]);
    expect(result.rows).toEqual([]);
    expect(result.columns).toEqual([]);
    expect(result.moreRowsExist).toBe(false);
  });

  // --- severity variants, and multiplicity ---------------------------------
  //
  // Only "I" is CAPTURED. These bodies are the captured DEMO_CDS_PARA envelope
  // with the severity attribute substituted, so the XML shape stays the real
  // one and only the value under test varies — a hand-written envelope is what
  // this repo's cassette rule exists to avoid.
  const withSeverity = (severity: string): string =>
    capturedBody(CDS_PARAMS_MESSAGE).replace('dataPreview:severity="I"', `dataPreview:severity="${severity}"`);

  it.each(["I", "W", "E"])("passes severity %s through unmapped", (severity) => {
    const parsed = parsePreviewBody(withSeverity(severity));
    expect(parsed.messages).toEqual([{ text: MESSAGE_TEXT, severity }]);
  });

  it("keeps every message when the server sends more than one", () => {
    const one = `<dataPreview:message dataPreview:text="${MESSAGE_TEXT}" dataPreview:severity="I"/>`;
    const body = capturedBody(CDS_PARAMS_MESSAGE).replace(
      one,
      one + '<dataPreview:message dataPreview:text="second thing" dataPreview:severity="W"/>',
    );
    // fast-xml-parser collapses a lone element to an object and only makes an
    // array from two — dropping the second message would be the same class of
    // bug as ignoring the first, so both shapes are forced to an array.
    expect(parsePreviewBody(body).messages).toEqual([
      { text: MESSAGE_TEXT, severity: "I" },
      { text: "second thing", severity: "W" },
    ]);
  });

  it("does not invent a message from an attribute-less element", () => {
    const body = capturedBody(CDS_PARAMS_MESSAGE).replace(
      `<dataPreview:message dataPreview:text="${MESSAGE_TEXT}" dataPreview:severity="I"/>`,
      "<dataPreview:message/>",
    );
    expect(parsePreviewBody(body).messages).toEqual([]);
  });

  it("keeps a message that carries text but no severity", () => {
    const body = capturedBody(CDS_PARAMS_MESSAGE).replace(' dataPreview:severity="I"', "");
    expect(parsePreviewBody(body).messages).toEqual([{ text: MESSAGE_TEXT, severity: "" }]);
  });

  // --- the rendered text: the false claim must be gone --------------------

  const render = (cassetteId: string, table: string) => {
    const parsed = parsePreviewBody(capturedBody(cassetteId));
    return renderPreview(
      { table, ...parsed, rowsRequested: 5, moreRowsExist: false },
      5,
      20_000,
    ).text;
  };

  it("never claims a genuinely empty result when the server sent a message", () => {
    const text = render("ddic-cds-with-parameters-inband-message", "DEMO_CDS_PARA");
    // The exact false sentence the defect produced, in its two halves.
    expect(text).not.toContain("was read successfully");
    expect(text).not.toContain("genuinely empty result");
    expect(text).not.toContain("EMPTY: DEMO_CDS_PARA");
    // And what it says instead: the server's own words, verbatim.
    expect(text).toContain(MESSAGE_TEXT);
    expect(text).toContain("SERVER NOTICE");
    expect(text).toContain("NOT READ");
  });

  it("still reports a genuinely empty entity as genuinely empty", () => {
    // The regression guard on the fix itself: no rows AND no message really is
    // an empty entity, and must keep saying so.
    const text = render(NAMESPACED_30, "/BOFU/CV_BPRELSHPCONTACTPERSON");
    expect(text).toContain("EMPTY: /BOFU/CV_BPRELSHPCONTACTPERSON");
    expect(text).toContain("genuinely empty result");
    expect(text).not.toContain("NOT READ");
    expect(text).not.toContain("SERVER NOTICE");
  });

  it.each([
    ["I", "SERVER NOTICE"],
    ["W", "SERVER WARNING"],
    ["E", "SERVER ERROR"],
  ])("labels severity %s as %s in the rendered notes", (severity, label) => {
    const parsed = parsePreviewBody(withSeverity(severity));
    const text = renderPreview(
      { table: "DEMO_CDS_PARA", ...parsed, rowsRequested: 5, moreRowsExist: false },
      5,
      20_000,
    ).text;
    expect(text).toContain(label);
    expect(text).toContain(MESSAGE_TEXT);
    expect(text).not.toContain("genuinely empty result");
  });

  it("states a message even when the response also carried rows", () => {
    // The reason a message is not thrown: it can arrive alongside real data,
    // and throwing would destroy rows the server did return.
    const parsed = parsePreviewBody(capturedBody(T000_ROWS3));
    const text = renderPreview(
      {
        table: "T000",
        ...parsed,
        messages: [{ text: "partial", severity: "W" }],
        rowsRequested: 5,
        moreRowsExist: false,
      },
      5,
      20_000,
    ).text;
    expect(text).toContain("SERVER WARNING");
    expect(text).toContain("partial");
    // The rows survive.
    expect(text).toContain("000");
    expect(text).not.toContain("NOT READ");
  });
});

describe("classifyPreviewFailure", () => {
  const ctx = { operation: "read", name: "ZZNOSUCHTABLE", type: "TABL/DT" };

  it("classifies the captured missing-table 400 as NOT_FOUND, not a permission problem", () => {
    // This endpoint answers a missing table with 400 + <exc:exception>, not
    // 404 (CAPTURED), so without the refinement the commonest user error — a
    // typo — reads as a server fault.
    expect(capturedBody(NOT_FOUND_400)).toContain("Table/View ZZNOSUCHTABLE not found");
    const err = classifyPreviewFailure(capturedFailure(NOT_FOUND_400), ctx);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.code).not.toBe("AUTH_FAILED");
    expect(err.code).not.toBe("ADT_ERROR");
    expect(err.message).toContain("ZZNOSUCHTABLE");
    expect(err.details.status).toBe(400);
    expect(err.hint ?? "").toMatch(/400/);
  });

  it("leaves the captured Boolean-expression 400 as ADT_ERROR", () => {
    // "A Boolean expression was expected in \"1=1\"" means something reached
    // the server-side SQL that should not have. Relabelling it NOT_FOUND would
    // hide the one signal that says so — and it is emphatically not an
    // authorisation failure either.
    const err = classifyPreviewFailure(capturedFailure(INJECTION_400), {
      ...ctx,
      name: "T000 WHERE 1=1",
    });
    expect(err.code).toBe("ADT_ERROR");
    expect(err.code).not.toBe("NOT_FOUND");
    expect(err.code).not.toBe("AUTH_FAILED");
    expect(err.message).toContain("Boolean expression");
    expect(err.details.status).toBe(400);
  });

  it("classifies 401/403 as AUTH_FAILED, not as a missing table", () => {
    // No cassette: the technical user on A4H is authorised for these tables,
    // so this envelope is synthetic — a 403 in the shape the transport throws,
    // not a captured one. It pins the direction of the 'vice versa': an
    // authorisation refusal must never be reported as a name problem, because
    // the advice that follows ("check the spelling") is wrong and the retry it
    // invites is wasted.
    for (const status of [401, 403]) {
      const err = classifyPreviewFailure(
        Object.assign(new Error("No authorization to display data from table T000"), {
          err: status,
          type: "ExceptionDataPreviewGeneral",
          properties: {},
        }),
        { ...ctx, name: "T000" },
      );
      expect(err.code).toBe("AUTH_FAILED");
      expect(err.code).not.toBe("NOT_FOUND");
      expect(err.details.status).toBe(status);
      expect(err.hint ?? "").toMatch(/do not retry with a different name/i);
    }
  });

  it("passes an existing AbapError through untouched", () => {
    // Circuit-breaker codes, SESSION_DEAD and real 404s must survive
    // classification rather than being re-badged as preview failures.
    const original = new AbapError("AUTH_CIRCUIT_OPEN", "breaker is open", {});
    const err = classifyPreviewFailure(original, ctx);
    expect(err).toBe(original);
    expect(err.code).toBe("AUTH_CIRCUIT_OPEN");
  });
});

// =========================================================== cassette provenance ===

describe("cassette provenance", () => {
  it.each([T000_ROWS3, SVERS_1x1, NOT_FOUND_400, INJECTION_200, INJECTION_400])(
    "%s is a raw live capture of POST /datapreview/ddic",
    (id) => {
      const c = cassette(id);
      expect(c.source.type).toBe("live-capture-raw");
      expect(c.source.citation.length).toBeGreaterThan(0);
      expect(c.request.method).toBe("POST");
      expect(c.request.path).toContain("/sap/bc/adt/datapreview/ddic");
      // Every parser assertion above rests on these being the appliance's own
      // bytes; a cassette rewritten to a hand-authored body would pass the
      // parser tests and prove nothing.
      expect(c.request.path).toContain("rowNumber=");
    },
  );

  it("guards the assertion that isValidDdicEntityName would have blocked both injections", () => {
    for (const id of [INJECTION_200, INJECTION_400]) {
      const encoded = cassette(id).request.path.split("ddicEntityName=")[1] ?? "";
      const sent = decodeURIComponent(encoded);
      expect(sent.startsWith("T000 WHERE")).toBe(true);
      expect(isValidDdicEntityName(sent)).toBe(false);
    }
  });
});

/**
 * Deliberately NOT covered here, so the gap is recorded rather than implied:
 *
 * - `conn.dataPreviewDdic` itself (the CSRF/`Accept`/shared-`request()` route)
 *   — that is `src/adt/connection.ts`, exercised by `test/data-preview-csrf.test.ts`
 *   and the connection suites.
 * - the tool-layer clamp, its disclosure, the deny-list and the productive
 *   ceiling — `test/tools.test.ts` and the safety suite.
 * - a real 403 from the appliance: no capture exists, and the synthetic
 *   envelope above is labelled as such.
 */
