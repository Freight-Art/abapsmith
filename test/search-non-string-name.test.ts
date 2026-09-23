/**
 * #172: `abap_search` used to throw "result.adtcore:name.match is not a
 * function" whenever the server sent a name fast-xml-parser's
 * `parseAttributeValue: true` coerces to a non-string (e.g. an all-digit
 * WDCC/YG row). `src/adt/object-search.ts` parses attributes as strings and
 * only falls back to a manual fetch + parse when the library call throws
 * exactly that TypeError.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { AbapError } from "../src/adt/errors.js";
import { parseObjectSearchXml, searchObjectsTolerant } from "../src/adt/object-search.js";
import { abapSearch } from "../src/tools/search.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const FIXTURE_XML = readFileSync(join(FIXTURES, "984-i172-search-star-100.xml"), "utf8");

interface Row {
  "adtcore:uri": string;
  "adtcore:type": string;
  "adtcore:name": string;
  "adtcore:packageName"?: string;
  "adtcore:description"?: string;
}

interface GetCall {
  url: string;
  opts: { headers?: Record<string, string>; qs?: Record<string, string> };
}

function searchConn(handlers: {
  searchObject?: (q: string, group?: string, max?: number) => Promise<unknown>;
  get?: (
    url: string,
    opts: { headers?: Record<string, string>; qs?: Record<string, string> },
  ) => Promise<{ body: string; status: number; headers: Record<string, unknown> }>;
}): AbapConnection {
  return {
    cfg: { sid: "A4H", searchTimeoutMs: 60_000 },
    adt: { searchObject: handlers.searchObject ?? (async () => []) },
    get: handlers.get ?? (async () => { throw new Error("unexpected get call"); }),
    withRequestTimeout: async (_ms: number, fn: () => Promise<unknown>) => fn(),
  } as unknown as AbapConnection;
}

/** Pulls the `name` column out of the RESULTS table, ignoring the header and notes. */
function namesIn(text: string): string[] {
  const marker = "--- RESULTS ---";
  const idx = text.indexOf(marker);
  if (idx === -1) return [];
  const lines = text
    .slice(idx + marker.length)
    .split("\n")
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const nameCol = lines[0]!.split(/\s{2,}/).indexOf("name");
  if (nameCol === -1) return [];
  return lines
    .slice(2)
    .filter((l) => !l.startsWith("---"))
    .map((l) => l.split(/\s{2,}/)[nameCol])
    .filter((v): v is string => !!v);
}

describe("parseObjectSearchXml against the live-captured 100-row fixture", () => {
  const rows = parseObjectSearchXml(FIXTURE_XML);

  it("parses all 100 rows and coerces every value to a string", () => {
    expect(rows).toHaveLength(100);
    for (const r of rows as unknown as Row[]) {
      expect(typeof r["adtcore:uri"]).toBe("string");
      expect(typeof r["adtcore:type"]).toBe("string");
      expect(typeof r["adtcore:name"]).toBe("string");
    }
  });

  it("keeps the numeric-looking padded name of the first row as a string, not a coerced number", () => {
    const first = rows[0] as unknown as Row;
    expect(first["adtcore:type"]).toBe("WDCC/YG");
    expect(first["adtcore:name"]).toBe("                                00");
  });

  it("includes the DEVC/K $TMP row", () => {
    const tmp = (rows as unknown as Row[]).find(
      (r) => r["adtcore:type"] === "DEVC/K" && r["adtcore:name"] === "$TMP",
    );
    expect(tmp).toBeDefined();
  });
});

describe("parseObjectSearchXml on small inline XML", () => {
  it("handles a single objectReference (not wrapped in an array) and splits NAME (description)", () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">' +
      '<adtcore:objectReference adtcore:uri="/sap/bc/adt/programs/programs/zfoo" ' +
      'adtcore:type="PROG/P" adtcore:name="ZFOO (some text)"/>' +
      "</adtcore:objectReferences>";
    const rows = parseObjectSearchXml(xml) as unknown as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!["adtcore:name"]).toBe("ZFOO");
    expect(rows[0]!["adtcore:description"]).toBe("some text");
    expect(rows[0]!["adtcore:type"]).toBe("PROG/P");
    expect(rows[0]!["adtcore:uri"]).toBe("/sap/bc/adt/programs/programs/zfoo");
  });

  it("returns [] for an empty <adtcore:objectReferences/>", () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"/>';
    expect(parseObjectSearchXml(xml)).toEqual([]);
  });
});

describe("searchObjectsTolerant", () => {
  it("falls back to a manual GET + parse only when adt.searchObject throws a TypeError", async () => {
    const getCalls: GetCall[] = [];
    const conn = searchConn({
      searchObject: async () => {
        throw new TypeError('result["adtcore:name"].match is not a function');
      },
      get: async (url, opts) => {
        getCalls.push({ url, opts });
        return { body: FIXTURE_XML, status: 200, headers: {} };
      },
    });
    const rows = await searchObjectsTolerant(conn, "*", 100);
    expect(rows).toHaveLength(100);
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0]!.url).toBe("/sap/bc/adt/repository/informationsystem/search");
    expect(getCalls[0]!.opts.qs).toEqual({ operation: "quickSearch", query: "*", maxResults: "100" });
    expect(getCalls[0]!.opts.headers).toEqual({ Accept: "application/xml" });
  });

  it("returns the library's own result and never calls conn.get when it resolves normally", async () => {
    const getCalls: GetCall[] = [];
    const libraryRows: Row[] = [{ "adtcore:uri": "/x", "adtcore:type": "CLAS/OC", "adtcore:name": "ZCL_A" }];
    const conn = searchConn({
      searchObject: async () => libraryRows,
      get: async (url, opts) => {
        getCalls.push({ url, opts });
        return { body: "", status: 200, headers: {} };
      },
    });
    const rows = await searchObjectsTolerant(conn, "Z*", 50);
    expect(rows).toBe(libraryRows as unknown as never);
    expect(getCalls).toHaveLength(0);
  });

  it("rethrows any non-TypeError unchanged and never calls conn.get", async () => {
    const getCalls: GetCall[] = [];
    const thrown = new AbapError("ADT_ERROR", "server exploded", {});
    const conn = searchConn({
      searchObject: async () => {
        throw thrown;
      },
      get: async (url, opts) => {
        getCalls.push({ url, opts });
        return { body: "", status: 200, headers: {} };
      },
    });
    await expect(searchObjectsTolerant(conn, "Z*", 50)).rejects.toBe(thrown);
    expect(getCalls).toHaveLength(0);
  });
});

describe("abap_search end to end: type-filtered `*` no longer throws", () => {
  // #206: "*" is unspecific and DEVC resolves to sub-type "DEVC/K", so this
  // is now a type-scoped listing — the raw GET is used directly with the
  // full sub-type as objectType, and the vendor searchObject is never
  // consulted at all (searchObjectsTolerant branches on the "/" before
  // trying the library). fetchMax = 10 + max(10, ceil(10/2)=5) = 20.
  it('type: "DEVC", max: 10 — "*" + "DEVC/K" is a type-scoped raw GET; vendor searchObject not called, $TMP is among the results (#206)', async () => {
    const getCalls: GetCall[] = [];
    const conn = searchConn({
      searchObject: async () => {
        throw new Error("vendor searchObject must not be called for a type-scoped GET");
      },
      get: async (url, opts) => {
        getCalls.push({ url, opts });
        return { body: FIXTURE_XML, status: 200, headers: {} };
      },
    });
    const res = await abapSearch(conn, { query: "*", type: "DEVC", max: 10 }, 20_000);
    expect(res.text).not.toContain("is not a function");
    expect(namesIn(res.text)).toContain("$TMP");
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0]!.opts.qs).toMatchObject({ objectType: "DEVC/K", maxResults: "20" });
  });

  it('type: "DDLS", max: 10 against 30 DDLS/DF + 70 TABL/DT rows — exactly 10 DDLS names shown, and the display cap is disclosed', async () => {
    const rows: Row[] = [
      ...Array.from({ length: 30 }, (_, i) => ({
        "adtcore:uri": `/sap/bc/adt/ddic/ddl/sources/zas_v${i + 1}`,
        "adtcore:type": "DDLS/DF",
        "adtcore:name": `ZAS_V${i + 1}`,
      })),
      ...Array.from({ length: 70 }, (_, i) => ({
        "adtcore:uri": `/sap/bc/adt/ddic/tables/zas_t${i + 1}`,
        "adtcore:type": "TABL/DT",
        "adtcore:name": `ZAS_T${i + 1}`,
      })),
    ];
    const conn = searchConn({ searchObject: async () => rows });
    const res = await abapSearch(conn, { query: "ZAS*", type: "DDLS", max: 10 }, 20_000);
    const names = namesIn(res.text);
    expect(names).toHaveLength(10);
    for (const n of names) expect(n).toMatch(/^ZAS_V\d+$/);
    expect(res.text).toMatch(/TRUNCATED|not shown/);
  });
});
