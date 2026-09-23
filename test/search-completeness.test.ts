/**
 * Regression tests for two related search defects: a name-and-group-matched
 * candidate list gets truncated to `max` BEFORE sub-type is ever considered,
 * so a legitimate row can be pushed out of the window before its sub-type is
 * even looked at; and typed rows come back stripped of attributes. The fake
 * backend models the pre-existing server behaviour: given an `objectType`, it
 * caps the name-and-group-matched candidates at `max` BEFORE sub-type is
 * considered — the same model `searchObjects`' own client-side filter already
 * assumed. The row loss was established to happen server-side, though not the
 * exact mechanism; this fake reproduces the observed shape offline.
 */
import { describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { abapSearch } from "../src/tools/search.js";

interface Row {
  "adtcore:type": string;
  "adtcore:name": string;
  "adtcore:packageName"?: string;
  "adtcore:description"?: string;
}

function nameMatches(pattern: string, name: string): boolean {
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
  return re.test(name);
}

interface Call {
  query: string;
  group?: string;
  max?: number;
}

/**
 * `group` given: candidates are matched by name pattern AND type-group only
 * (a group such as "CLAS", or the full sub-type such as "TABL/DS" that #206
 * sends for an unspecific query) — then `max` truncates that candidate set
 * before any sub-type distinction is made. Only a sub-typed objectType
 * ("TABL/DS") strips `adtcore:description`/`adtcore:packageName`, as
 * captures 818/819 show; a bare group keeps both.
 * `group` omitted: candidates are matched by name pattern only, across every
 * type, then `max` truncates, and every attribute is kept.
 * Either way, results are handed back sorted by name — the same order ADT's
 * quickSearch responses observe in every capture this repo holds.
 */
function fakeSearchBackend(all: Row[], calls: Call[]) {
  return async (query: string, group?: string, max?: number): Promise<Row[]> => {
    calls.push({ query, group, max });
    const byName = all.filter((r) => nameMatches(query, r["adtcore:name"]));
    const candidates = group ? byName.filter((r) => r["adtcore:type"].split("/")[0] === group.split("/")[0]) : byName;
    const sorted = [...candidates].sort((a, b) => a["adtcore:name"].localeCompare(b["adtcore:name"]));
    const page = sorted.slice(0, max ?? sorted.length);
    if (!group?.includes("/")) return page;
    return page.map((r) => {
      const { "adtcore:description": _d, "adtcore:packageName": _p, ...rest } = r;
      return rest as Row;
    });
  };
}

function searchConn(searchObject: (q: string, group?: string, max?: number) => Promise<unknown[]>): AbapConnection {
  return {
    cfg: { sid: "A4H", searchTimeoutMs: 60_000 },
    adt: { searchObject, usageReferences: async () => [] },
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

describe("abap_search: the ZTMD_ES_HW17 invariant", () => {
  // Four ENHS/XS objects (the reported case) plus ENHS/XB filler so a
  // group-level pre-filter window (what the old server-truthing code sent)
  // has something to push ZTMD_ES_HW17 out of on the broad pattern but not
  // on the narrower one.
  const ALL: Row[] = [
    { "adtcore:type": "ENHS/XB", "adtcore:name": "ZTMD_AA_HW17" },
    { "adtcore:type": "ENHS/XS", "adtcore:name": "ZTMD_BD_HW17" },
    { "adtcore:type": "ENHS/XB", "adtcore:name": "ZTMD_CC_HW17" },
    { "adtcore:type": "ENHS/XB", "adtcore:name": "ZTMD_DD_HW17" },
    { "adtcore:type": "ENHS/XS", "adtcore:name": "ZTMD_ES_HW17" },
    { "adtcore:type": "ENHS/XS", "adtcore:name": "ZTMD_ES_HW17_EP" },
    { "adtcore:type": "ENHS/XS", "adtcore:name": "ZTMD_ES_HW17_ES" },
  ];

  it("the narrow pattern's result set is a SUBSET of the broad pattern's", async () => {
    const calls: Call[] = [];
    const conn = searchConn(fakeSearchBackend(ALL, calls));

    const broad = await abapSearch(conn, { query: "ZTMD_*", type: "ENHS/XS", max: 4 }, 20_000);
    const narrow = await abapSearch(conn, { query: "ZTMD_ES_*", type: "ENHS/XS", max: 4 }, 20_000);

    const broadNames = namesIn(broad.text);
    const narrowNames = namesIn(narrow.text);
    expect(narrowNames.length).toBeGreaterThan(0);
    for (const name of narrowNames) {
      expect(broadNames, `${name} from the narrow query is missing from the broad query`).toContain(name);
    }
    // The reported row specifically.
    expect(broadNames).toContain("ZTMD_ES_HW17");
  });
});

// #206: the server's own type filter is trusted again for speed, so a typed
// call now sends the type GROUP to searchObject (not undefined) and the
// fetch window is a margin above `max`, not a 10x multiplier.
describe("abap_search sends the type GROUP, and widens the window with a margin, when typed", () => {
  const ROWS: Row[] = [
    { "adtcore:type": "CLAS/OC", "adtcore:name": "ZCL_ONE", "adtcore:packageName": "ZPKG", "adtcore:description": "one" },
  ];

  it("passes group=undefined to searchObject when untyped, and the type's GROUP when typed (#206)", async () => {
    const calls: Call[] = [];
    const conn = searchConn(fakeSearchBackend(ROWS, calls));

    await abapSearch(conn, { query: "Z*", max: 50 }, 20_000);
    await abapSearch(conn, { query: "Z*", type: "CLAS/OC", max: 50 }, 20_000);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.group).toBeUndefined();
    expect(calls[1]!.group).toBe("CLAS");
  });

  it("requests max as-is when untyped, and max + margin(max) (capped at 1000) when typed (#206)", async () => {
    const calls: Call[] = [];
    const conn = searchConn(fakeSearchBackend(ROWS, calls));

    await abapSearch(conn, { query: "Z*", max: 50 }, 20_000);
    expect(calls[0]!.max).toBe(50);

    await abapSearch(conn, { query: "Z*", type: "CLAS/OC", max: 50 }, 20_000);
    expect(calls[1]!.max).toBe(75); // 50 + max(10, ceil(50/2)=25) = 75

    await abapSearch(conn, { query: "Z*", type: "CLAS/OC", max: 200 }, 20_000);
    expect(calls[2]!.max).toBe(300); // 200 + max(10, ceil(200/2)=100) = 300
  });
});

// #206 sends the GROUP for a specific query, and the group path keeps
// description/packageName (only the sub-typed path of an unspecific query
// strips them — captures 818/819, and the TYPE-SCOPED LISTING note).
describe("abap_search: a typed group-scoped search keeps description/packageName", () => {
  const ROWS: Row[] = [
    {
      "adtcore:type": "CLAS/OC",
      "adtcore:name": "ZCL_TYPED",
      "adtcore:packageName": "ZPKG_TYPED",
      "adtcore:description": "a typed row's own description",
    },
  ];

  it("still renders package/description for a typed specific query, since only the group is sent (#206)", async () => {
    const conn = searchConn(fakeSearchBackend(ROWS, []));
    const r = await abapSearch(conn, { query: "ZCL_TYPED", type: "CLAS/OC", max: 50 }, 20_000);
    expect(r.text).toContain("ZPKG_TYPED");
    expect(r.text).toContain("a typed row's own description");
  });
});

describe("abap_search honours a sub-type specForType does not know", () => {
  const ROWS: Row[] = [
    { "adtcore:type": "ENHS/XS", "adtcore:name": "ZTMD_XS_ONE" },
    { "adtcore:type": "ENHS/XS", "adtcore:name": "ZTMD_XS_TWO" },
    { "adtcore:type": "ENHS/XB", "adtcore:name": "ZTMD_XB_ONE" },
    { "adtcore:type": "ENHS/XB", "adtcore:name": "ZTMD_XB_TWO" },
  ];

  it('type: "ENHS/XB" keeps only ENHS/XB rows even though specForType has never heard of it', async () => {
    const conn = searchConn(fakeSearchBackend(ROWS, []));
    const r = await abapSearch(conn, { query: "ZTMD_*", type: "ENHS/XB", max: 50 }, 20_000);
    const names = namesIn(r.text);
    expect(names).toContain("ZTMD_XB_ONE");
    expect(names).toContain("ZTMD_XB_TWO");
    expect(names).not.toContain("ZTMD_XS_ONE");
    expect(names).not.toContain("ZTMD_XS_TWO");
    expect(r.text).toContain("matches: 2");
  });
});

describe("abap_search marks window exhaustion in the body, not just the notes", () => {
  // #206: a typed, non-wildcard-only query now sends the GROUP to
  // searchObject, so the fake's own group filter excludes any non-CLAS
  // filler before the candidate list is ever truncated — a "filler" of
  // another group can no longer be the thing that fills the window, so this
  // helper only produces CLAS/OC rows.
  const windowOf = (clasCount: number): Row[] =>
    Array.from({ length: clasCount }, (_, i) => ({
      "adtcore:type": "CLAS/OC",
      "adtcore:name": `ZWIN_A_${String(i).padStart(3, "0")}`,
    }));

  it("carries a --- TRUNCATED --- marker in the body when the fetch window comes back full", async () => {
    // type given, max=2 -> fetchMax = 2 + max(10, ceil(2/2)=1) = 12 (#206); exactly 12 candidates fills it.
    const conn = searchConn(fakeSearchBackend(windowOf(12), []));
    const r = await abapSearch(conn, { query: "ZWIN_*", type: "CLAS/OC", max: 2 }, 20_000);
    expect(r.text).toContain("matches: 2"); // only the first `max` shown; display cap is a separate concern
    expect(r.text).toContain("--- TRUNCATED ---");
    expect(r.text).toMatch(/may be incomplete/);
    expect(r.text).toMatch(/raise `max`|Raise `max`/i);
  });

  it("carries no truncation marker when the server sent fewer rows than the window", async () => {
    const conn = searchConn(fakeSearchBackend(windowOf(5), []));
    const r = await abapSearch(conn, { query: "ZWIN_*", type: "CLAS/OC", max: 5 }, 20_000);
    expect(r.text).not.toContain("--- TRUNCATED ---");
  });
});

describe("abap_search caps displayed rows at max, even though the fetch window is wider", () => {
  const MATCHING: Row[] = Array.from({ length: 8 }, (_, i) => ({
    "adtcore:type": "CLAS/OC",
    "adtcore:name": `ZCAP_${String(i).padStart(3, "0")}`,
  }));

  it("returns exactly max rows and states the true matched total, not up to 10x max", async () => {
    // fetchMax = min(1000, 3*10) = 30, well over the 8 matching rows — all 8
    // come back from the fake, but only 3 may be shown per the `max` contract.
    const conn = searchConn(fakeSearchBackend(MATCHING, []));
    const r = await abapSearch(conn, { query: "ZCAP_*", type: "CLAS/OC", max: 3 }, 20_000);
    const shown = [...r.text.matchAll(/ZCAP_\d+/g)].map((m) => m[0]);
    expect(shown).toHaveLength(3);
    expect(r.text).toContain("matches: 3");
    expect(r.text).toContain("matchedTotal: 8");
    expect(r.text).toContain("--- TRUNCATED ---");
    expect(r.text).toMatch(/5 (matching row\(s\)|of 8)/);
  });
});
