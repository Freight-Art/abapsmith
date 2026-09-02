/**
 * Pins the page-full-at-max disclosure: "The server returned
 * its full page of N hit(s) at max=F ..." fires exactly when the raw fetch
 * window (fetchMax) came back full — independently of `max`, `type`, and the
 * two other disclosures `searchObjects` also carries (the UNDER-REPORTED
 * type-filter note, and the fetch-window-full/not-full body lines). Section
 * 3 drives every reachable combination of those three and checks they never
 * tell a caller two contradictory things; section 4 pins the retired
 * `NOT proof` wording (removed from the not-full branch) to the one
 * place — a full window with zero surviving rows — where it still fires and
 * is still true.
 */
import { describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { abapSearch } from "../src/tools/search.js";

interface Row {
  "adtcore:type": string;
  "adtcore:name": string;
}

/** Models the server's own pagination: it never sends more than the
 *  requested window. No name or group matching — `searchObjects` always
 *  calls with group=undefined, and the query pattern is irrelevant to these
 *  tests; only row counts and types are. */
function fixedWindowBackend(available: Row[]): (query: string, group?: string, max?: number) => Promise<Row[]> {
  return async (_query, _group, max) => available.slice(0, max ?? available.length);
}

function searchConn(searchObject: (q: string, group?: string, max?: number) => Promise<unknown[]>): AbapConnection {
  return {
    cfg: { sid: "A4H" },
    adt: { searchObject, usageReferences: async () => [] },
  } as unknown as AbapConnection;
}

function rowsOfType(type: string, count: number, prefix: string): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    "adtcore:type": type,
    "adtcore:name": `${prefix}${String(i).padStart(4, "0")}`,
  }));
}

/** Pulls an integer out of the response header, e.g. "matches: 3". */
function headerNumber(text: string, field: string): number {
  const m = text.match(new RegExp(`${field}: (\\d+)`));
  if (!m) throw new Error(`header field "${field}" not found in:\n${text}`);
  return Number(m[1]);
}

// The stable, mechanical prefix of the page-full-at-max note. Its trailing
// "there are probably more matches" clause is a claim about SAP itself, so
// this suite must not assert that clause as fact — only presence/absence of
// the note, identified by this prefix, is pinned.
const PAGE_FULL_NOTE = /returned its full page of \d+ hit\(s\)/;

describe("page-full-at-max note, untyped: trigger and complement", () => {
  it("fires when the server fills the window exactly at max", async () => {
    const max = 5;
    const conn = searchConn(fixedWindowBackend(rowsOfType("CLAS/OC", max, "ZU1_")));
    const r = await abapSearch(conn, { query: "ZU1_*", max }, 20_000);
    expect(r.text).toMatch(PAGE_FULL_NOTE);
  });

  it("is absent, with no TRUNCATED window line, one row short of the window", async () => {
    const max = 5;
    const conn = searchConn(fixedWindowBackend(rowsOfType("CLAS/OC", max - 1, "ZU2_")));
    const r = await abapSearch(conn, { query: "ZU2_*", max }, 20_000);
    expect(r.text).not.toMatch(PAGE_FULL_NOTE);
    expect(r.text).not.toContain("--- TRUNCATED ---");
  });
});

describe("page-full-at-max note, typed: keys on the widened fetch window, not the caller's max", () => {
  it("fires and names the fetch window, not the caller's max, when fetchMax is exactly filled", async () => {
    const max = 3; // fetchMax = min(1000, 3*10) = 30
    const conn = searchConn(fixedWindowBackend(rowsOfType("CLAS/OC", 30, "ZT1_")));
    const r = await abapSearch(conn, { query: "ZT1_*", type: "CLAS/OC", max }, 20_000);
    const noteLine = r.text.split("\n").find((l) => l.includes("returned its full page of"));
    expect(noteLine).toBeDefined();
    expect(noteLine).toContain("at max=30");
    expect(noteLine).not.toContain("at max=3;");
  });

  it("stays absent when the server sends more than the caller's max but the fetch window is not full", async () => {
    const max = 3; // fetchMax = 30
    // 10 rows: more than the caller's max=3, well under fetchMax=30 — the
    // exact case that would wrongly trigger the note if its guard were ever
    // simplified back to results.length >= max instead of >= fetchMax.
    const conn = searchConn(fixedWindowBackend(rowsOfType("CLAS/OC", 10, "ZT2_")));
    const r = await abapSearch(conn, { query: "ZT2_*", type: "CLAS/OC", max }, 20_000);
    expect(r.text).not.toMatch(PAGE_FULL_NOTE);
  });
});

interface Combo {
  label: string;
  type?: string;
  max: number;
  wantedCount: number;
  unwantedCount: number;
  expectFull: boolean;
  expectZero: boolean;
}

const TYPED_MAX = 2; // fetchMax = min(1000, 2*10) = 20
const UNTYPED_MAX = 5; // fetchMax = max = 5

// Every genuinely reachable cell of {untyped, typed} x {window full, window
// not full} x {type filter drops rows, drops nothing} x {some survive, zero
// survive}. Two cells are missing on purpose, not just hard to hit: a full
// window forces available.length === fetchMax >= 1, and "drops nothing"
// means filtered.length === available.length — together that rules out zero
// survivors (typed: full + drops-nothing + zero). Untyped has no "drops
// rows" axis at all (there is no `type`, so nothing is ever filtered), and
// the same arithmetic rules out untyped + full + zero.
const COMBOS: Combo[] = [
  {
    label: "typed, window full, type filter drops rows, some survive",
    type: "CLAS/OC",
    max: TYPED_MAX,
    wantedCount: 15,
    unwantedCount: 5,
    expectFull: true,
    expectZero: false,
  },
  {
    label: "typed, window full, type filter drops rows, zero survive",
    type: "CLAS/OC",
    max: TYPED_MAX,
    wantedCount: 0,
    unwantedCount: 20,
    expectFull: true,
    expectZero: true,
  },
  {
    label: "typed, window full, type filter drops nothing, some survive",
    type: "CLAS/OC",
    max: TYPED_MAX,
    wantedCount: 20,
    unwantedCount: 0,
    expectFull: true,
    expectZero: false,
  },
  {
    label: "typed, window not full, type filter drops rows, some survive",
    type: "CLAS/OC",
    max: TYPED_MAX,
    wantedCount: 10,
    unwantedCount: 5,
    expectFull: false,
    expectZero: false,
  },
  {
    label: "typed, window not full, type filter drops rows, zero survive",
    type: "CLAS/OC",
    max: TYPED_MAX,
    wantedCount: 0,
    unwantedCount: 10,
    expectFull: false,
    expectZero: true,
  },
  {
    label: "typed, window not full, type filter drops nothing, some survive",
    type: "CLAS/OC",
    max: TYPED_MAX,
    wantedCount: 10,
    unwantedCount: 0,
    expectFull: false,
    expectZero: false,
  },
  {
    label: "typed, window not full, type filter drops nothing, zero survive",
    type: "CLAS/OC",
    max: TYPED_MAX,
    wantedCount: 0,
    unwantedCount: 0,
    expectFull: false,
    expectZero: true,
  },
  {
    label: "untyped, window full, some survive",
    max: UNTYPED_MAX,
    wantedCount: 5,
    unwantedCount: 0,
    expectFull: true,
    expectZero: false,
  },
  {
    label: "untyped, window not full, some survive",
    max: UNTYPED_MAX,
    wantedCount: 3,
    unwantedCount: 0,
    expectFull: false,
    expectZero: false,
  },
  {
    label: "untyped, window not full, zero survive",
    max: UNTYPED_MAX,
    wantedCount: 0,
    unwantedCount: 0,
    expectFull: false,
    expectZero: true,
  },
];

async function runCombo(c: Combo) {
  // available.length never exceeds fetchMax, so the fake always returns the
  // whole array — every "wanted" row survives the type filter and nothing
  // wanted is cut off by the window itself, which is what keeps the fixture
  // arithmetic (wantedCount -> matches) honest.
  const available = c.type
    ? [...rowsOfType(c.type, c.wantedCount, "ZW_"), ...rowsOfType("PROG/P", c.unwantedCount, "ZP_")]
    : rowsOfType("CLAS/OC", c.wantedCount, "ZW_");
  const fetchMax = c.type ? Math.min(1000, c.max * 10) : c.max;
  const conn = searchConn(fixedWindowBackend(available));
  const r = await abapSearch(conn, { query: "Z*", type: c.type, max: c.max }, 20_000);
  const serverHits = headerNumber(r.text, "serverHits");
  const matches = headerNumber(r.text, "matches");
  return { r, serverHits, matches, fetchMax };
}

describe("composition: the page-full note, the UNDER-REPORTED note, and the window body line never contradict", () => {
  const COMPLETENESS = /every hit the server has|every object of any type matching this pattern|was not full/;
  const INCOMPLETENESS = /returned its full page of|was full for|may be incomplete|probably more matches/;

  for (const c of COMBOS) {
    it(`${c.label}: reaches the intended state, and completeness/incompleteness claims are mutually exclusive`, async () => {
      const { r, serverHits, matches, fetchMax } = await runCombo(c);

      // Confirm the fixture actually landed in the cell it claims to before
      // trusting the assertions that follow.
      expect(serverHits >= fetchMax).toBe(c.expectFull);
      expect(matches === 0).toBe(c.expectZero);

      const hasCompleteness = COMPLETENESS.test(r.text);
      const hasIncompleteness = INCOMPLETENESS.test(r.text);
      expect(hasCompleteness && hasIncompleteness).toBe(false);

      if (r.text.includes("NOT proof")) expect(hasIncompleteness).toBe(true);
    });
  }
});

describe("the retired NOT-proof wording (removed from the not-full branch) stays retired", () => {
  for (const c of COMBOS) {
    // The literal only ever fires from the full-window, zero-survivor body
    // branch — every other cell, full window or not, must not carry it.
    const expectNotProof = c.expectFull && c.expectZero;

    it(`${c.label}: "NOT proof" is ${expectNotProof ? "present" : "absent"}`, async () => {
      const { r } = await runCombo(c);
      if (expectNotProof) expect(r.text).toContain("NOT proof");
      else expect(r.text).not.toContain("NOT proof");
    });
  }
});
