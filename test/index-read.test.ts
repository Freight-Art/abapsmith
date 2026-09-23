/**
 * Tests for `src/adt/index-read.ts` (issue #86) — the freestyle-preview-
 * backed re-read of a table's secondary DDIC indexes over DD12V/DD17S.
 *
 * `readTableIndexes`/`readSecondaryIndex`/`verifySecondaryIndex` are tested
 * against a fake `AbapConnection` whose `dataPreviewFreestyle` either
 * replays a real committed capture body (858, 859, 860 — read from disk,
 * never hand-typed) or, for the one contract capture 859 cannot exercise
 * (POSITION zero-padded numeric-vs-lexicographic ordering, since both of
 * its rows carry "0001"), a small hand-built body using the same
 * `columnXml`/`body()` shape `test/img-read.test.ts` uses for its own
 * freestyle fakes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { AbapConnection } from "../src/adt/connection.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import {
  INDEX_ID_MAX,
  INDEX_TABLE_NAME_MAX,
  readSecondaryIndex,
  readTableIndexes,
  renderIndexSection,
  renderSecondaryIndex,
  renderSecondaryIndexList,
  verifySecondaryIndex,
} from "../src/adt/index-read.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const read = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

const DD12V_BDSLORE10 = read("858-i86-dd12v-select-star.xml");
const DD17S_BDSLORE10 = read("859-i86-dd17s-select-star.xml");
const DD12V_TADIR_EMPTY = read("860-i86-dd12v-no-index.xml");

// --------------------------------------------------------------- fake wire ---

function columnXml(name: string, values: readonly string[]): string {
  const data = values.map((v) => `<dataPreview:data>${v}</dataPreview:data>`).join("");
  return (
    `<dataPreview:columns><dataPreview:metadata dataPreview:name="${name}" dataPreview:type="C" dataPreview:keyAttribute="false"/>` +
    `<dataPreview:dataSet>${data}</dataPreview:dataSet></dataPreview:columns>`
  );
}

function body(cols: Record<string, readonly string[]>, totalRows?: number): string {
  const names = Object.keys(cols);
  const rowCount = names.length === 0 ? 0 : cols[names[0]!]!.length;
  for (const n of names) {
    if (cols[n]!.length !== rowCount) {
      throw new Error(`test fixture bug: column "${n}" has a different row count than "${names[0]}"`);
    }
  }
  const totalRowsXml = totalRows === undefined ? "" : `<dataPreview:totalRows>${totalRows}</dataPreview:totalRows>`;
  const colsXml = names.map((n) => columnXml(n, cols[n]!)).join("");
  return (
    '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
    `${totalRowsXml}${colsXml}</dataPreview:tableData>`
  );
}

/**
 * A hand-built DD17S body for BDSLORE10/REL with POSITION "9" then "10"
 * (fields F9, F10), deliberately UNPADDED. This is the case that actually
 * separates a numeric sort from a lexicographic one: equal-width
 * zero-padded values (e.g. "002"/"010", the literal example named in issue
 * #86's own task text) already sort correctly either way — "002" < "010"
 * character-by-character, same as 2 < 10 numerically — so that pairing is
 * not a real counter-example. The real failure mode is a WIDTH mismatch:
 * as a plain string, "10" < "9" (the leading "1" loses to "9"), while
 * numerically 10 > 9. `readTableIndexes` must land F9 before F10.
 */
function dd17sOutOfOrderPositions(): string {
  return body({
    SQLTAB: ["BDSLORE10", "BDSLORE10"],
    INDEXNAME: ["REL", "REL"],
    POSITION: ["10", "9"],
    FIELDNAME: ["F10", "F9"],
  });
}

/**
 * The equal-width, zero-padded pairing issue #86's task text names
 * literally ("002"/"010") — included for fidelity to that instruction, even
 * though (see `dd17sOutOfOrderPositions` above) it does not by itself
 * distinguish a numeric sort from a lexicographic one.
 */
function dd17sZeroPaddedPositions(): string {
  return body({
    SQLTAB: ["BDSLORE10", "BDSLORE10"],
    INDEXNAME: ["REL", "REL"],
    POSITION: ["010", "002"],
    FIELDNAME: ["F10", "F2"],
  });
}

interface RecordedCall {
  sql: string;
  rowNumber: number;
}

/** Replays queued bodies in call order; running out is a loud test-authoring bug, never a fall-through. */
function queueConn(bodies: readonly string[]): { conn: AbapConnection; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const conn = {
    async dataPreviewFreestyle(sql: string, rowNumber: number) {
      calls.push({ sql, rowNumber });
      const b = bodies[i];
      i++;
      if (b === undefined) {
        throw new Error(`queueConn: no fixture queued for call #${i} (only ${bodies.length} queued). SQL was:\n${sql}`);
      }
      return { body: b };
    },
  } as unknown as AbapConnection;
  return { conn, calls };
}

/** A connection whose `dataPreviewFreestyle` always throws — for the "catalog re-read itself failed" case. */
function throwingConn(message: string): AbapConnection {
  return {
    async dataPreviewFreestyle() {
      throw new Error(message);
    },
  } as unknown as AbapConnection;
}

/** A connection that must never be called at all — for client-side-refusal assertions. */
function neverCalledConn(): { conn: AbapConnection; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const conn = {
    async dataPreviewFreestyle(sql: string, rowNumber: number) {
      calls.push({ sql, rowNumber });
      throw new Error("dataPreviewFreestyle must not be called for this input");
    },
  } as unknown as AbapConnection;
  return { conn, calls };
}

async function expectAsyncError(p: Promise<unknown>): Promise<AbapError> {
  try {
    await p;
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected the promise to reject");
}

// ============================================================= readTableIndexes ===

describe("readTableIndexes — real captures 858 (DD12V) + 859 (DD17S)", () => {
  it("parses id/unique/activation/db-status/description from DD12V, deduping the language-doubled rows", async () => {
    const { conn } = queueConn([DD12V_BDSLORE10, DD17S_BDSLORE10]);
    const { indexes, notes } = await readTableIndexes(conn, "BDSLORE10");

    expect(indexes.map((i) => i.id)).toEqual(["P2", "REL"]); // sorted by id
    const rel = indexes.find((i) => i.id === "REL")!;
    expect(rel.table).toBe("BDSLORE10");
    expect(rel.description).toBe("Relationship ID"); // English row (DDLANGUAGE "E"), not the German one
    expect(rel.unique).toBe(true); // UNIQUEFLAG "X"
    expect(rel.activation).toBe("A");
    expect(rel.activationLabel).toBe("active");
    expect(rel.dbState).toBe(""); // blank DBSTATE on the REL rows

    const p2 = indexes.find((i) => i.id === "P2")!;
    expect(p2.description).toBe("Partner 2 of Relationship");
    expect(p2.unique).toBe(false); // UNIQUEFLAG blank
    expect(p2.dbState).toBe("O");

    // Dedup note: DD12V carried 4 rows (2 languages x 2 indexes) but only 2 indexes came out.
    expect(notes.some((n) => /DD12V carried more than one row per index/.test(n))).toBe(true);
  });

  it("reads fields from DD17S in POSITION order (capture 859: both indexes have a single field at position 0001)", async () => {
    const { conn } = queueConn([DD12V_BDSLORE10, DD17S_BDSLORE10]);
    const { indexes } = await readTableIndexes(conn, "BDSLORE10");
    const rel = indexes.find((i) => i.id === "REL")!;
    const p2 = indexes.find((i) => i.id === "P2")!;
    expect(rel.fields).toEqual(["REIO_ID"]);
    expect(p2.fields).toEqual(["REP2_ID"]);
  });

  function dd12vSingleHeader(): string {
    return body(
      {
        SQLTAB: ["BDSLORE10"],
        INDEXNAME: ["REL"],
        DDLANGUAGE: ["E"],
        UNIQUEFLAG: [""],
        AS4LOCAL: ["A"],
        DBSTATE: [""],
        DDTEXT: ["Relationship ID"],
      },
      1,
    );
  }

  it("orders DD17S fields numerically by POSITION, not lexicographically (unpadded 9/10 — the case that actually distinguishes the two)", async () => {
    const { conn } = queueConn([dd12vSingleHeader(), dd17sOutOfOrderPositions()]);
    const { indexes } = await readTableIndexes(conn, "BDSLORE10");
    const rel = indexes.find((i) => i.id === "REL")!;
    // A plain string sort would put "10" before "9" (leading "1" < "9"); Number()-based sort
    // must put position 9 (F9) before position 10 (F10).
    expect(rel.fields).toEqual(["F9", "F10"]);
  });

  it('orders DD17S fields correctly for the equal-width zero-padded pairing issue #86 names literally ("002"/"010")', async () => {
    const { conn } = queueConn([dd12vSingleHeader(), dd17sZeroPaddedPositions()]);
    const { indexes } = await readTableIndexes(conn, "BDSLORE10");
    const rel = indexes.find((i) => i.id === "REL")!;
    expect(rel.fields).toEqual(["F2", "F10"]);
  });

  it("capture 860 (DD12V for TADIR, totalRows 0): a genuinely empty result — empty indexes array, no error", async () => {
    const dd17sEmpty = body({ SQLTAB: [], INDEXNAME: [], POSITION: [], FIELDNAME: [] }, 0);
    const { conn, calls } = queueConn([DD12V_TADIR_EMPTY, dd17sEmpty]);
    const { indexes, notes } = await readTableIndexes(conn, "TADIR");
    expect(indexes).toEqual([]);
    expect(notes.some((n) => /more than one row per index/.test(n))).toBe(false);
    expect(calls).toHaveLength(2); // both DD12V and DD17S are still queried
  });
});

describe("renderIndexSection — capture 860 negative control", () => {
  it("states the empty-indexes case is a definitive absence, citing capture 860, not an unread/failed check", () => {
    const { content } = renderIndexSection([]);
    expect(content).toMatch(/no secondary index/);
    expect(content).toMatch(/zero rows/);
    expect(content).toMatch(/not an unread or failed check/);
  });
});

// ============================================================= verifySecondaryIndex ===

describe("verifySecondaryIndex", () => {
  it('expect "absent" against a genuinely empty catalog (capture-860-shaped): present:false, verified:true, no mismatch clause', async () => {
    const dd17sEmpty = body({ SQLTAB: [], INDEXNAME: [], POSITION: [], FIELDNAME: [] }, 0);
    const { conn } = queueConn([DD12V_TADIR_EMPTY, dd17sEmpty]);
    const verdict = await verifySecondaryIndex(conn, "TADIR", "Z01", "absent");
    expect(verdict.verified).toBe(true);
    expect(verdict.present).toBe(false);
    expect(verdict.active).toBe(false);
    expect(verdict.statement).toMatch(/is absent from DD12V/);
    expect(verdict.statement).not.toMatch(/expected present/);
    expect(verdict.reason).toBeUndefined();
  });

  it('expect "present" against an empty catalog: verified:true, present:false, statement carries the mismatch clause', async () => {
    const dd17sEmpty = body({ SQLTAB: [], INDEXNAME: [], POSITION: [], FIELDNAME: [] }, 0);
    const { conn } = queueConn([DD12V_TADIR_EMPTY, dd17sEmpty]);
    const verdict = await verifySecondaryIndex(conn, "TADIR", "Z01", "present");
    expect(verdict.verified).toBe(true);
    expect(verdict.present).toBe(false);
    expect(verdict.statement).toMatch(/expected present, but the catalog shows no such row/);
  });

  it("a real present+active index (capture 858/859 REL) verified against expect present: no mismatch clause, active true", async () => {
    const { conn } = queueConn([DD12V_BDSLORE10, DD17S_BDSLORE10]);
    const verdict = await verifySecondaryIndex(conn, "BDSLORE10", "REL", "present");
    expect(verdict.verified).toBe(true);
    expect(verdict.present).toBe(true);
    expect(verdict.active).toBe(true);
    expect(verdict.statement).toMatch(/present and active/);
    expect(verdict.statement).not.toMatch(/expected absent/);
    expect(verdict.index?.id).toBe("REL");
  });

  it("a real present index verified against expect absent: mismatch clause present, verified stays true", async () => {
    const { conn } = queueConn([DD12V_BDSLORE10, DD17S_BDSLORE10]);
    const verdict = await verifySecondaryIndex(conn, "BDSLORE10", "REL", "absent");
    expect(verdict.verified).toBe(true);
    expect(verdict.present).toBe(true);
    expect(verdict.statement).toMatch(/expected absent, but the catalog still shows it/);
  });

  it("never throws when the catalog re-read itself fails: verified:false, reason set, statement explains", async () => {
    const conn = throwingConn("simulated network failure");
    const verdict = await verifySecondaryIndex(conn, "BDSLORE10", "REL", "present");
    expect(verdict.verified).toBe(false);
    expect(verdict.present).toBe(false);
    expect(verdict.active).toBe(false);
    expect(verdict.reason).toBe("simulated network failure");
    expect(verdict.statement).toMatch(/could not verify index REL on BDSLORE10/);
    expect(verdict.statement).toContain("simulated network failure");
  });

  it("never throws for a BAD_INPUT table/index name either: verified:false, reason set, no request made", async () => {
    const { conn, calls } = neverCalledConn();
    const verdict = await verifySecondaryIndex(conn, "*bad*", "Z01", "present");
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toBeDefined();
    expect(calls).toHaveLength(0);
  });
});

// ============================================================= safety / SQL shape ===

describe("SQL sent to dataPreviewFreestyle", () => {
  it("carries no unescaped caller input and no line over the builder's cap, for an index id containing a quote", async () => {
    // assertEnhIdentifier refuses non-identifier characters outright (including a quote), so this
    // must be refused client-side before any request — proving there is no path by which a quote
    // could reach the generated SQL unescaped.
    const { conn, calls } = neverCalledConn();
    const err = await expectAsyncError(readSecondaryIndex(conn, "BDSLORE10", "Z0'"));
    expect(err.code).toBe("BAD_INPUT");
    expect(calls).toHaveLength(0);
  });

  it("every line of every generated SELECT is at or under 200 characters", async () => {
    const { conn, calls } = queueConn([DD12V_BDSLORE10, DD17S_BDSLORE10]);
    await readTableIndexes(conn, "BDSLORE10");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      for (const line of call.sql.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(200);
      }
    }
  });

  it("refuses an over-long table name BEFORE any request (fake never called)", async () => {
    const { conn, calls } = neverCalledConn();
    const overLong = "A".repeat(INDEX_TABLE_NAME_MAX + 1);
    const err = await expectAsyncError(readTableIndexes(conn, overLong));
    expect(err.code).toBe("BAD_INPUT");
    expect(calls).toHaveLength(0);
  });

  it("refuses an over-long index id BEFORE any request (fake never called)", async () => {
    const { conn, calls } = neverCalledConn();
    const overLong = "A".repeat(INDEX_ID_MAX + 1);
    const err = await expectAsyncError(readSecondaryIndex(conn, "BDSLORE10", overLong));
    expect(err.code).toBe("BAD_INPUT");
    expect(calls).toHaveLength(0);
  });
});

// ============================================================= renderSecondaryIndex ===

describe("renderSecondaryIndex", () => {
  it("renders a DdicRender whose ddl and meta reflect a real read (BDSLORE10/REL)", async () => {
    const { conn } = queueConn([DD12V_BDSLORE10, DD17S_BDSLORE10]);
    const { index } = await readSecondaryIndex(conn, "BDSLORE10", "REL");
    expect(index).toBeDefined();
    const rendered = renderSecondaryIndex(index!);
    expect(rendered.ddl).toContain("define index rel on bdslore10");
    expect(rendered.ddl).toContain("reio_id;");
    expect(rendered.meta.table).toBe("BDSLORE10");
    expect(rendered.meta.index).toBe("REL");
    expect(rendered.meta.unique).toBe("true");
    expect(rendered.meta.fields).toBe(1);
    expect(rendered.hashInput).toContain("REL");
    expect(rendered.hashInput).toContain("REIO_ID");
  });
});

// ============================================================= readSecondaryIndex — indexes ===

describe("readSecondaryIndex returns every index of the table alongside the one asked for (captures 858/859)", () => {
  it("names both P2 and REL in `indexes` while `index` is the one asked for", async () => {
    const { conn } = queueConn([DD12V_BDSLORE10, DD17S_BDSLORE10]);
    const { index, indexes } = await readSecondaryIndex(conn, "BDSLORE10", "REL");
    expect(index?.id).toBe("REL");
    expect(indexes.map((i) => i.id)).toEqual(["P2", "REL"]);
  });
});

describe("readSecondaryIndex for an unknown id still lists the existing indexes", () => {
  it("returns index: undefined but indexes: [P2, REL] for BDSLORE10/Z09", async () => {
    const { conn } = queueConn([DD12V_BDSLORE10, DD17S_BDSLORE10]);
    const { index, indexes } = await readSecondaryIndex(conn, "BDSLORE10", "Z09");
    expect(index).toBeUndefined();
    expect(indexes.map((i) => i.id)).toEqual(["P2", "REL"]);
  });
});

// ============================================================= renderSecondaryIndexList ===

describe("renderSecondaryIndexList renders one define-index block per index plus the SECONDARY INDEXES section", () => {
  it("BDSLORE10 (P2, REL): ddl carries both define-index blocks, section content lists both, meta counts them", async () => {
    const { conn } = queueConn([DD12V_BDSLORE10, DD17S_BDSLORE10]);
    const { indexes } = await readTableIndexes(conn, "BDSLORE10");
    const rendered = renderSecondaryIndexList("BDSLORE10", indexes);

    expect(rendered.ddl).toContain("define index p2 on bdslore10");
    expect(rendered.ddl).toContain("define index rel on bdslore10");
    expect(rendered.sections[0]?.title).toBe("SECONDARY INDEXES");
    expect(rendered.sections[0]?.content).toContain("P2");
    expect(rendered.sections[0]?.content).toContain("REL");
    expect(rendered.sections[0]?.content).toContain("UNIQUE");
    expect(rendered.meta.indexes).toBe(2);
    expect(rendered.meta.table).toBe("BDSLORE10");

    const dropped = renderSecondaryIndexList("BDSLORE10", indexes.filter((i) => i.id !== "REL"));
    expect(dropped.hashInput).not.toBe(rendered.hashInput);
  });
});

describe("renderSecondaryIndexList with no index is a definitive empty listing, not an error", () => {
  it('renderSecondaryIndexList("TADIR", []): meta.indexes 0, ddl and section say "no secondary index"', () => {
    const rendered = renderSecondaryIndexList("TADIR", []);
    expect(rendered.meta.indexes).toBe(0);
    expect(rendered.ddl).toContain("TADIR has no secondary index");
    expect(rendered.sections[0]?.content).toMatch(/no secondary index/);
  });
});
