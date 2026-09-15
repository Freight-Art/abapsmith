/**
 * Regression tests: `abap_search` used to hand an
 * unrecognised `type` straight to the server, which silently answered with
 * zero rows instead of telling the caller the type was never valid. `type`
 * is now validated locally, before any server call, for both mode=objects
 * and mode=where_used.
 */
import { describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { AbapError } from "../src/adt/errors.js";
import { TYPES } from "../src/adt/types.js";
import { abapSearch, KNOWN_TYPE_GROUPS, searchInputSchema } from "../src/tools/search.js";

interface Row {
  "adtcore:type": string;
  "adtcore:name": string;
  "adtcore:packageName"?: string;
  "adtcore:description"?: string;
}

function searchConn(handlers: {
  searchObject?: (q: string, group?: string, max?: number) => Promise<Row[]>;
  usageReferences?: () => Promise<unknown[]>;
}): AbapConnection {
  return {
    cfg: { sid: "A4H" },
    adt: {
      searchObject: handlers.searchObject ?? (async () => []),
      usageReferences: handlers.usageReferences ?? (async () => []),
    },
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

async function rejects(conn: AbapConnection, input: Parameters<typeof abapSearch>[1]): Promise<AbapError> {
  const err = await abapSearch(conn, input, 20_000).catch((e) => e as AbapError);
  expect(err).toBeInstanceOf(AbapError);
  return err;
}

describe('abap_search rejects an unrecognised `type` before any server call', () => {
  it('type: "any" — the reported repro — rejects with BAD_INPUT and never calls searchObject', async () => {
    let calls = 0;
    const conn = searchConn({
      searchObject: async () => {
        calls++;
        return [];
      },
    });
    const err = await rejects(conn, { query: "ZTMD*", type: "any", max: 5 });
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain('type "any"');
    expect(calls).toBe(0);

    await expect(
      abapSearch(searchConn({}), { query: "ZTMD*", type: "any", max: 5 }, 20_000),
    ).rejects.toThrow();
  });

  it("lists every kind and type code from TYPES, not a hand-maintained list", async () => {
    const err = await rejects(searchConn({}), { query: "Z*", type: "any", max: 5 });
    for (const t of TYPES) {
      expect(err.message).toContain(`"${t.kind}"`);
      expect(err.message).toContain(`"${t.type}"`);
    }
  });

  it("names no internal function in the message or hint", async () => {
    const err = await rejects(searchConn({}), { query: "Z*", type: "any", max: 5 });
    expect(err.message).not.toMatch(/translateAdtError/);
    expect(err.hint ?? "").not.toMatch(/translateAdtError/);
  });

  it("the hint names a group/subtype example and the `type` parameter", async () => {
    const err = await rejects(searchConn({}), { query: "Z*", type: "any", max: 5 });
    expect(err.hint).toContain("ENHS/XB");
    expect(err.hint).toMatch(/type/);
  });

  it('rejects "FOO/BAR" (slash, unknown group)', async () => {
    const err = await rejects(searchConn({}), { query: "Z*", type: "FOO/BAR", max: 5 });
    expect(err.code).toBe("BAD_INPUT");
  });

  it('rejects "nonsense"', async () => {
    const err = await rejects(searchConn({}), { query: "Z*", type: "nonsense", max: 5 });
    expect(err.code).toBe("BAD_INPUT");
  });

  it('mode: "where_used" with type: "any" also rejects with BAD_INPUT before usageReferences is called', async () => {
    let calls = 0;
    const conn = searchConn({
      usageReferences: async () => {
        calls++;
        return [];
      },
    });
    const err = await rejects(conn, { query: "class ZCL_BIG", mode: "where_used", type: "any", max: 5 });
    expect(err.code).toBe("BAD_INPUT");
    expect(calls).toBe(0);
  });
});

describe("abap_search accepts every valid spelling of `type` and filters correctly", () => {
  const ROWS: Row[] = [
    { "adtcore:type": "CLAS/OC", "adtcore:name": "ZCL_A", "adtcore:packageName": "ZPKG", "adtcore:description": "a class" },
    { "adtcore:type": "PROG/P", "adtcore:name": "ZPROG_A", "adtcore:packageName": "ZPKG", "adtcore:description": "a program" },
    { "adtcore:type": "ENHS/XS", "adtcore:name": "ZENHS_XS_A" },
    { "adtcore:type": "ENHS/XB", "adtcore:name": "ZENHS_XB_A" },
    { "adtcore:type": "TABL/DT", "adtcore:name": "ZTAB_A" },
  ];

  it('a bare kind, "CLAS" and "clas", both return only the CLAS/OC row', async () => {
    const rUpper = await abapSearch(
      searchConn({ searchObject: async () => ROWS }),
      { query: "Z*", type: "CLAS", max: 50 },
      20_000,
    );
    expect(namesIn(rUpper.text)).toEqual(["ZCL_A"]);

    const rLower = await abapSearch(
      searchConn({ searchObject: async () => ROWS }),
      { query: "Z*", type: "clas", max: 50 },
      20_000,
    );
    expect(namesIn(rLower.text)).toEqual(["ZCL_A"]);
  });

  it('a full type code, "TABL/DT", is accepted', async () => {
    const r = await abapSearch(
      searchConn({ searchObject: async () => ROWS }),
      { query: "Z*", type: "TABL/DT", max: 50 },
      20_000,
    );
    expect(namesIn(r.text)).toEqual(["ZTAB_A"]);
  });

  // VIEW/DV used to be rejected here: `abap_read` had no route to a classic
  // view at all, so a search filter that admitted it would have pointed a
  // caller at a type it could never then read. VIEW/DV, TRAN/T and SHLP/DH
  // all gained a `mode: "ddic"` TypeSpec in types.ts on this branch (read
  // through catalog-read.ts's plain-text catalog SELECTs, not ADT REST), so
  // KNOWN_TYPE_GROUPS — derived from TYPES — now includes VIEW, and
  // abap_search's `type` filter agrees with abap_read instead of refusing
  // what abap_read can now serve.
  it('a full type code, "VIEW/DV", is accepted — abap_read now reads a classic view, and abap_search agrees', async () => {
    const r = await abapSearch(
      searchConn({ searchObject: async () => [...ROWS, { "adtcore:type": "VIEW/DV", "adtcore:name": "ZVIEW_A" }] }),
      { query: "Z*", type: "VIEW/DV", max: 50 },
      20_000,
    );
    expect(namesIn(r.text)).toEqual(["ZVIEW_A"]);
    expect(KNOWN_TYPE_GROUPS.has("VIEW")).toBe(true);
  });

  it('an unknown sub-type on a known group, "ENHS/XB", returns only the ENHS/XB row — this is the case a naive specForType-only check would wrongly reject', async () => {
    const r = await abapSearch(
      searchConn({ searchObject: async () => ROWS }),
      { query: "Z*", type: "ENHS/XB", max: 50 },
      20_000,
    );
    expect(namesIn(r.text)).toEqual(["ZENHS_XB_A"]);
  });

  it('an object-type keyword, "class", resolves to CLAS/OC and returns the class row, not the program row', async () => {
    const r = await abapSearch(
      searchConn({ searchObject: async () => ROWS }),
      { query: "Z*", type: "class", max: 50 },
      20_000,
    );
    const names = namesIn(r.text);
    expect(names).toContain("ZCL_A");
    expect(names).not.toContain("ZPROG_A");
  });
});

describe("the `type` schema description enumerates only groups the runtime actually accepts", () => {
  const description = searchInputSchema.type.description ?? "";

  it("is derived from KNOWN_TYPE_GROUPS, not hand-listed", () => {
    expect(description).toContain("CLAS");
    expect(description).toContain("TABL");
    expect(description).toContain("DDLS");
  });

  it("every listed group is accepted by the real validation path (no BAD_INPUT)", async () => {
    for (const group of KNOWN_TYPE_GROUPS) {
      const conn = searchConn({ searchObject: async () => [] });
      await expect(
        abapSearch(conn, { query: "Z*", type: group, max: 5 }, 20_000),
      ).resolves.toBeDefined();
    }
  });

  // TRAN, VIEW and SHLP used to be deliberately absent here: TRAN/T, VIEW/DV
  // and SHLP/DH had no `types.ts` TypeSpec, so KNOWN_TYPE_GROUPS (derived
  // from TYPES, per the first test in this describe) never contained their
  // group words and the description correctly never advertised them. All
  // three now have a `mode: "ddic"` TypeSpec, so KNOWN_TYPE_GROUPS contains
  // them and the description — being derived, not hand-listed — must too;
  // failing to advertise a group the runtime actually accepts would be a
  // caller-facing regression in the schema, not a safety property worth
  // keeping.
  it('advertises "TRAN", "VIEW", and "SHLP" as accepted groups now that all three have a TypeSpec', () => {
    const listed = description
      .replace(/^.*One of:\s*/s, "")
      .split(";")[0]!
      .trim()
      .split(/\s+/);
    expect(listed).toContain("TRAN");
    expect(listed).toContain("VIEW");
    expect(listed).toContain("SHLP");
    expect(KNOWN_TYPE_GROUPS.has("TRAN")).toBe(true);
    expect(KNOWN_TYPE_GROUPS.has("VIEW")).toBe(true);
    expect(KNOWN_TYPE_GROUPS.has("SHLP")).toBe(true);
  });
});
