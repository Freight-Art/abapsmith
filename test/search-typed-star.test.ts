/**
 * #206: typed-wildcard routing in `abapSearch`'s mode=objects (`searchObjects`
 * in src/tools/search.ts). A typed request now sends an objectType instead of
 * relying purely on client-side filtering: a wildcard-only query ("*", "%",
 * whitespace) combined with a type resolves (via specForType/specForKeyword,
 * which always yield a full "GROUP/SUB" code for any known kind) to the full
 * sub-type and is sent as a type-scoped raw GET, bypassing the vendor
 * `searchObject` entirely (it strips everything after "/"). A real name
 * pattern (or a bare group used WITH a name pattern) instead goes through the
 * vendor with just the group. The fetch window widens by a margin
 * (`max + max(10, ceil(max/2))`, capped at 1000), not a 10x multiplier.
 */
import { describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { AbapError } from "../src/adt/errors.js";
import { abapSearch } from "../src/tools/search.js";

interface Row {
  "adtcore:uri": string;
  "adtcore:type": string;
  "adtcore:name": string;
}

interface GetCall {
  url: string;
  opts: { headers?: Record<string, string>; qs?: Record<string, string> };
}

interface VendorCall {
  query: string;
  group?: string;
  max?: number;
}

function rowsOfType(type: string, count: number, prefix: string): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    "adtcore:uri": `/sap/bc/adt/x/${prefix}${i}`,
    "adtcore:type": type,
    "adtcore:name": `${prefix}${String(i).padStart(4, "0")}`,
  }));
}

/** Builds the same `<adtcore:objectReferences>` shape parseObjectSearchXml expects. */
function objectRefXml(rows: Row[]): string {
  const refs = rows
    .map(
      (r) =>
        `<adtcore:objectReference adtcore:uri="${r["adtcore:uri"]}" ` +
        `adtcore:type="${r["adtcore:type"]}" adtcore:name="${r["adtcore:name"]}"/>`,
    )
    .join("");
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">' +
    refs +
    "</adtcore:objectReferences>"
  );
}

function searchConn(handlers: {
  searchObject?: (q: string, group?: string, max?: number) => Promise<unknown[]>;
  get?: (
    url: string,
    opts: { headers?: Record<string, string>; qs?: Record<string, string> },
  ) => Promise<{ body: string; status: number; headers: Record<string, unknown> }>;
  searchTimeoutMs?: number;
  withRequestTimeout?: (ms: number, fn: () => Promise<unknown>) => Promise<unknown>;
}): AbapConnection {
  return {
    cfg: { sid: "A4H", searchTimeoutMs: handlers.searchTimeoutMs ?? 60_000 },
    adt: {
      searchObject:
        handlers.searchObject ??
        (async () => {
          throw new Error("vendor searchObject must not be called");
        }),
    },
    get:
      handlers.get ??
      (async () => {
        throw new Error("conn.get must not be called");
      }),
    withRequestTimeout: handlers.withRequestTimeout ?? (async (_ms: number, fn: () => Promise<unknown>) => fn()),
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

describe("abap_search typed wildcard routing (#206)", () => {
  it('"*" + "FUGR/F" max 3: a wildcard-only query with a full sub-type is a type-scoped raw GET; vendor searchObject is never called', async () => {
    const getCalls: GetCall[] = [];
    const rows = rowsOfType("FUGR/F", 5, "ZFG_");
    const conn = searchConn({
      get: async (url, opts) => {
        getCalls.push({ url, opts });
        return { body: objectRefXml(rows), status: 200, headers: {} };
      },
    });
    const r = await abapSearch(conn, { query: "*", type: "FUGR/F", max: 3 }, 20_000);
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0]!.url).toBe("/sap/bc/adt/repository/informationsystem/search");
    expect(getCalls[0]!.opts.qs).toEqual({
      operation: "quickSearch",
      query: "*",
      // fetchMax = min(1000, 3 + max(10, ceil(3/2)=2)) = 13
      maxResults: "13",
      objectType: "FUGR/F",
    });
    expect(namesIn(r.text)).toHaveLength(3);
    expect(r.text).toContain("TYPE-SCOPED LISTING");
  });

  it('"*" + "TABL/DS" max 3: same type-scoped routing for a DDIC sub-type', async () => {
    const getCalls: GetCall[] = [];
    const rows = rowsOfType("TABL/DS", 3, "ZST_");
    const conn = searchConn({
      get: async (url, opts) => {
        getCalls.push({ url, opts });
        return { body: objectRefXml(rows), status: 200, headers: {} };
      },
    });
    const r = await abapSearch(conn, { query: "*", type: "TABL/DS", max: 3 }, 20_000);
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0]!.opts.qs).toMatchObject({ objectType: "TABL/DS", maxResults: "13" });
    expect(namesIn(r.text)).toHaveLength(3);
    expect(r.text).toContain("TYPE-SCOPED LISTING");
  });

  it('"Z*" + "CLAS/OC" max 50: a real name pattern goes through the vendor with the GROUP only, fetch window widened, display capped at max', async () => {
    const calls: VendorCall[] = [];
    const rows = rowsOfType("CLAS/OC", 60, "ZCL_");
    const conn = searchConn({
      searchObject: async (query, group, max) => {
        calls.push({ query, group, max });
        return rows;
      },
    });
    const r = await abapSearch(conn, { query: "Z*", type: "CLAS/OC", max: 50 }, 20_000);
    // fetchMax = min(1000, 50 + max(10, ceil(50/2)=25)) = 75
    expect(calls).toEqual([{ query: "Z*", group: "CLAS", max: 75 }]);
    expect(namesIn(r.text)).toHaveLength(50);
    expect(r.text).toContain("DISPLAY CAP");
  });

  // A wildcard-only query with a BARE group (e.g. "*"+"FUGR") is NOT this
  // case: specForType/specForKeyword resolve any known bare kind to a full
  // "GROUP/SUB" code via BY_KIND (confirmed: specForType("FUGR").type ===
  // "FUGR/F"), so "*"+"FUGR" is typeScoped and takes the raw-GET path in the
  // first test above, never reaching the vendor. The vendor GROUP path for a
  // bare group is reached only with a real name pattern.
  it('"Z*" + bare group "FUGR" max 3: a name pattern with a bare group resolves to its group via the vendor, not its sub-type', async () => {
    const calls: VendorCall[] = [];
    const rows = rowsOfType("FUGR/F", 2, "ZFG_");
    const conn = searchConn({
      searchObject: async (query, group, max) => {
        calls.push({ query, group, max });
        return rows;
      },
    });
    const r = await abapSearch(conn, { query: "Z*", type: "FUGR", max: 3 }, 20_000);
    expect(calls).toEqual([{ query: "Z*", group: "FUGR", max: 13 }]);
    expect(namesIn(r.text)).toHaveLength(2);
  });

  describe("an unspecific untyped query is refused BAD_INPUT before any request", () => {
    for (const query of ["*", "", "**", "%", "   "]) {
      it(`query: ${JSON.stringify(query)}`, async () => {
        // searchConn({}) throws if either adt.searchObject or conn.get is
        // reached, so a non-AbapError failure here would mean a request
        // went out before the refusal.
        const conn = searchConn({});
        const err = await abapSearch(conn, { query, max: 5 }, 20_000).catch((e) => e as AbapError);
        expect(err).toBeInstanceOf(AbapError);
        expect((err as AbapError).code).toBe("BAD_INPUT");
        expect((err as AbapError).details).toMatchObject({ reason: "unspecific" });
      });
    }
  });

  it('untyped "Z*" still goes out untyped with maxResults = max (default 50): searchObject("Z*", undefined, 50)', async () => {
    const calls: VendorCall[] = [];
    const conn = searchConn({
      searchObject: async (query, group, max) => {
        calls.push({ query, group, max });
        return [];
      },
    });
    await abapSearch(conn, { query: "Z*" }, 20_000);
    expect(calls).toEqual([{ query: "Z*", group: undefined, max: 50 }]);
  });

  it("a transport timeout during the search becomes AbapError TIMEOUT, family \"search\", naming ABAP_SEARCH_TIMEOUT_MS", async () => {
    const conn = searchConn({
      searchObject: async () => {
        throw Object.assign(new Error("timeout of 60000ms exceeded"), { code: "ECONNABORTED" });
      },
    });
    const err = await abapSearch(conn, { query: "Z*", max: 5 }, 20_000).catch((e) => e as AbapError);
    expect(err).toBeInstanceOf(AbapError);
    expect((err as AbapError).code).toBe("TIMEOUT");
    expect((err as AbapError).details).toMatchObject({ family: "search", envVar: "ABAP_SEARCH_TIMEOUT_MS" });
  });

  it("the search runs under conn.withRequestTimeout with cfg.searchTimeoutMs", async () => {
    let seenMs: number | undefined;
    const conn = searchConn({
      searchObject: async () => [],
      searchTimeoutMs: 12_345,
      withRequestTimeout: async (ms, fn) => {
        seenMs = ms;
        return fn();
      },
    });
    await abapSearch(conn, { query: "Z*", max: 5 }, 20_000);
    expect(seenMs).toBe(12_345);
  });
});
