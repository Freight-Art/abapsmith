/**
 * Pins issue #64: `abap_read {"type":"FUGR/FF","object":"BUP_ROLES_GET_ALL"}`
 * used to refuse with `BAD_INPUT` demanding a function group, even though
 * BUP_ROLES_GET_ALL is a perfectly ordinary, searchable function module. The
 * cause was `searchExact` narrowing its exact-name search to
 * `objectType=FUGR` for a `FUGR/FF` ref — but `FUGR` selects function GROUPS
 * only and comes back EMPTY for a function module (capture
 * 847-i64-quicksearch-fm-objecttype-fugr), while the same query untyped
 * finds it fine (capture 846-i64-quicksearch-fm-untyped). Search-then-read
 * was a dead end: the search that was supposed to recover the group instead
 * made the object invisible.
 *
 * The fix sends the exact-name search for a parented type (FUGR/FF, FUGR/I)
 * untyped and filters the type back in locally, then recovers the group from
 * each surviving row's `adtcore:uri` (the only field that carries it —
 * `adtcore:packageName` is the module's ABAP package, a different thing).
 * This suite is offline only — no live calls — and pins the resulting
 * behaviour: the untyped request itself, one-group resolution, many-groups
 * and no-groups refusals, that an unrelated same-named object of another
 * type is never substituted, that an explicitly-given group still works,
 * and how `abap_search` renders the recovered group.
 */
import { describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { isAbapError } from "../src/adt/errors.js";
import { resolveObject } from "../src/adt/resolve.js";
import { abapSearch } from "../src/tools/search.js";

/** A fake that also records every argument `searchObject` was called with,
 *  so the "the request goes out untyped" assertion has something to check —
 *  `test/resolve.test.ts`'s `connWith` idiom doesn't capture calls. */
function connSpy(hits: unknown[]) {
  const calls: Array<{ query: string; group?: string; max?: number }> = [];
  const conn = {
    cfg: { sid: "A4H" },
    adt: {
      searchObject: async (query: string, group?: string, max?: number) => {
        calls.push({ query, group, max });
        return hits;
      },
      usageReferences: async () => [],
    },
  } as unknown as AbapConnection;
  return { conn, calls };
}

/** Plain fake, no call recording, for tests that only care about the result. */
function connWith(hits: unknown[]): AbapConnection {
  return connSpy(hits).conn;
}

// Modelled on the real capture: BUP_ROLES_GET_ALL lives in function group
// BUDA, but its ABAP package is S_BUPA_GENERAL — a different name, on
// purpose, so a test that reads `parent` off `packageName` by mistake fails.
const BUP_ROLES_GET_ALL_HIT = {
  "adtcore:type": "FUGR/FF",
  "adtcore:name": "BUP_ROLES_GET_ALL",
  "adtcore:uri": "/sap/bc/adt/functions/groups/buda/fmodules/bup_roles_get_all",
  "adtcore:packageName": "S_BUPA_GENERAL",
  "adtcore:description": "Determine All BP Roles",
};

describe("resolveObject — FUGR/FF resolves without a given group (issue #64 regression)", () => {
  it("resolves BUP_ROLES_GET_ALL from an untyped search hit alone", async () => {
    const r = await resolveObject(connWith([BUP_ROLES_GET_ALL_HIT]), "BUP_ROLES_GET_ALL", {
      type: "FUGR/FF",
    });
    expect(r.type).toBe("FUGR/FF");
    expect(r.parent).toBe("BUDA");
    expect(r.uri).toBe("/sap/bc/adt/functions/groups/buda/fmodules/bup_roles_get_all");
    expect(r.sourceUri).toBe(
      "/sap/bc/adt/functions/groups/buda/fmodules/bup_roles_get_all/source/main",
    );
    expect(r.packageName).toBe("S_BUPA_GENERAL");
  });

  it("takes the group from adtcore:uri, never from packageName", async () => {
    const r = await resolveObject(connWith([BUP_ROLES_GET_ALL_HIT]), "BUP_ROLES_GET_ALL", {
      type: "FUGR/FF",
    });
    // The whole point of the fix: BUDA (the group) and S_BUPA_GENERAL (the
    // package) are different strings. A regression that fell back to
    // packageName would set `parent` to "S_BUPA_GENERAL" instead.
    expect(r.parent).toBe("BUDA");
    expect(r.parent).not.toBe(r.packageName);
  });
});

describe("the exact-name search goes out untyped for a parented type", () => {
  it("sends group=undefined for a FUGR/FF request", async () => {
    const { conn, calls } = connSpy([BUP_ROLES_GET_ALL_HIT]);
    await resolveObject(conn, "BUP_ROLES_GET_ALL", { type: "FUGR/FF" });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.group).toBeUndefined();
  });

  it("control: a non-parented type (CLAS/OC) still narrows the search server-side", async () => {
    const classHit = {
      "adtcore:type": "CLAS/OC",
      "adtcore:name": "ZCL_FOO",
      "adtcore:uri": "/sap/bc/adt/oo/classes/zcl_foo",
      "adtcore:packageName": "$TMP",
      "adtcore:description": "Demo class",
    };
    const { conn, calls } = connSpy([classHit]);
    await resolveObject(conn, "ZCL_FOO", { type: "CLAS/OC" });
    expect(calls.length).toBeGreaterThan(0);
    // Unlike FUGR/FF above, this is scoped to parented types only.
    expect(calls[0]!.group).toBe("CLAS");
  });
});

describe("a same-named object of another type is not substituted", () => {
  it("refuses with BAD_INPUT instead of resolving to the program", async () => {
    const programHit = {
      "adtcore:type": "PROG/P",
      "adtcore:name": "BUP_ROLES_GET_ALL",
      "adtcore:uri": "/sap/bc/adt/programs/programs/bup_roles_get_all",
    };
    try {
      await resolveObject(connWith([programHit]), "BUP_ROLES_GET_ALL", { type: "FUGR/FF" });
      expect.unreachable();
    } catch (e) {
      expect(isAbapError(e)).toBe(true);
      expect((e as { code: string }).code).toBe("BAD_INPUT");
      expect((e as Error).message).toMatch(/needs its function group/);
    }
  });
});

describe("two function groups share the name — defensive branch, not observed live", () => {
  // Not seen on the wire (BUP_ROLES_GET_ALL is single-group); pinned anyway
  // because resolveParented's own logic makes the many-groups case reachable
  // for any name that genuinely has same-named modules in two groups.
  it("refuses with BAD_INPUT naming both groups", async () => {
    const hitInGroup = (group: string) => ({
      "adtcore:type": "FUGR/FF",
      "adtcore:name": "BUP_ROLES_GET_ALL",
      "adtcore:uri": `/sap/bc/adt/functions/groups/${group.toLowerCase()}/fmodules/bup_roles_get_all`,
      "adtcore:packageName": "S_BUPA_GENERAL",
    });
    try {
      await resolveObject(connWith([hitInGroup("buda"), hitInGroup("budb")]), "BUP_ROLES_GET_ALL", {
        type: "FUGR/FF",
      });
      expect.unreachable();
    } catch (e) {
      expect(isAbapError(e)).toBe(true);
      const err = e as { code: string; message: string; hint?: string; details?: Record<string, unknown> };
      expect(err.code).toBe("BAD_INPUT");
      expect(err.message).toMatch(/exists in 2 function groups \(BUDA, BUDB\)/);
      expect(err.details?.groups).toEqual(["BUDA", "BUDB"]);
      expect(err.hint).toMatch(/BUDA/);
    }
  });
});

describe("no hits at all — a generated function module still needs its group named", () => {
  // ENQUEUE_E_TABLE really is readable at
  // /sap/bc/adt/functions/groups/etable/fmodules/enqueue_e_table (capture
  // 851-i64-fmodule-generated-read-200), but quickSearch does not index
  // generated function modules at all — the same query comes back empty
  // (capture 850-i64-quicksearch-generated-fm-missing). With zero rows to
  // recover a group from, the refusal must stay: there is nothing to resolve
  // "no group given" against.
  it("refuses with the exact BAD_INPUT wording and a hint to name the group", async () => {
    try {
      await resolveObject(connWith([]), "ENQUEUE_E_TABLE", { type: "FUGR/FF" });
      expect.unreachable();
    } catch (e) {
      expect(isAbapError(e)).toBe(true);
      const err = e as { code: string; message: string; hint?: string };
      expect(err.code).toBe("BAD_INPUT");
      expect(err.message).toBe("Function module ENQUEUE_E_TABLE needs its function group.");
      expect(err.hint).toMatch(/ENQUEUE_E_TABLE in/);
    }
  });
});

describe("still works when the group is given explicitly", () => {
  it("resolves PARENT/NAME shorthand", async () => {
    const r = await resolveObject(connWith([BUP_ROLES_GET_ALL_HIT]), "BUDA/BUP_ROLES_GET_ALL", {
      type: "FUGR/FF",
    });
    expect(r.type).toBe("FUGR/FF");
    expect(r.parent).toBe("BUDA");
    expect(r.uri).toBe("/sap/bc/adt/functions/groups/buda/fmodules/bup_roles_get_all");
  });

  it('resolves "function module X in GROUP" phrasing', async () => {
    const r = await resolveObject(
      connWith([BUP_ROLES_GET_ALL_HIT]),
      "function module BUP_ROLES_GET_ALL in BUDA",
    );
    expect(r.type).toBe("FUGR/FF");
    expect(r.parent).toBe("BUDA");
    expect(r.uri).toBe("/sap/bc/adt/functions/groups/buda/fmodules/bup_roles_get_all");
  });
});

describe("abap_search mode=objects renders the recovered group", () => {
  // searchObjects always fetches untyped (its own comment: "the request now
  // always goes out untyped"), so its rows carry the group-bearing URI
  // regardless of what `type` the caller passed in — the rendering decision
  // below is keyed on whether a displayed row happens to have a parent, not
  // on the request's own type filter.
  function searchConnFor(rows: unknown[]): AbapConnection {
    return {
      cfg: { sid: "A4H", searchTimeoutMs: 60_000 },
      adt: { searchObject: async () => rows, usageReferences: async () => [] },
      withRequestTimeout: async (_ms: number, fn: () => Promise<unknown>) => fn(),
    } as unknown as AbapConnection;
  }

  it("adds a group column and cell when a FUGR/FF row is present", async () => {
    const conn = searchConnFor([BUP_ROLES_GET_ALL_HIT]);
    const r = await abapSearch(conn, { query: "BUP_ROLES_GET_ALL" }, 20_000);
    expect(r.text).toMatch(/^type\s+name\s+group\s+package\s+description/m);
    expect(r.text).toMatch(/\bBUDA\b/);
  });

  it("the extra group/package hint appears once the response is windowed", async () => {
    // `hints` is only rendered as part of the TRUNCATED/WINDOW notice (see
    // compact.ts: "Shown verbatim when the response is incomplete"), so a
    // one-row response never shows it — pad with filler rows and a small
    // maxChars to force that notice, the same way the rest of this file's
    // untruncated assertions could not.
    const filler = Array.from({ length: 30 }, (_, i) => ({
      "adtcore:type": "CLAS/OC",
      "adtcore:name": `ZCL_FILLER_${String(i).padStart(3, "0")}`,
      "adtcore:uri": `/sap/bc/adt/oo/classes/zcl_filler_${String(i).padStart(3, "0")}`,
      "adtcore:packageName": "$TMP",
      "adtcore:description": "Filler class row, only here to force a windowed response",
    }));
    const conn = searchConnFor([BUP_ROLES_GET_ALL_HIT, ...filler]);
    // #206: an untyped "*" is now refused BAD_INPUT before any request; the
    // fake ignores the query text entirely, so any non-unspecific pattern
    // still returns every fixture row.
    const r = await abapSearch(conn, { query: "Z*", max: 100 }, 1000);
    expect(r.truncated).toBe(true);
    expect(r.text).toMatch(/\bBUDA\b/);
    expect(r.text).toMatch(/`group` is the function group/);
  });

  it("stays four-column, with no group hint, for ordinary rows", async () => {
    const classHit = {
      "adtcore:type": "CLAS/OC",
      "adtcore:name": "ZCL_FOO",
      "adtcore:uri": "/sap/bc/adt/oo/classes/zcl_foo",
      "adtcore:packageName": "$TMP",
      "adtcore:description": "Demo class",
    };
    const conn = searchConnFor([classHit]);
    const r = await abapSearch(conn, { query: "ZCL_FOO" }, 20_000);
    expect(r.text).toMatch(/^type\s+name\s+package\s+description/m);
    expect(r.text).not.toMatch(/^type\s+name\s+group\s+package\s+description/m);
    expect(r.text).not.toMatch(/`group` is the function group/);
  });
});
