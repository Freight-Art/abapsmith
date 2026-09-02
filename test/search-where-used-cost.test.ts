/**
 * Regression test: `abap_search mode=where_used` against a
 * high-fan-in object (CL_ABAP_TYPEDESCR on A4H: measured p50 23,816ms,
 * min 22,618, max 24,549, N=4 warm, 5,896 references — figures quoted from
 * the issue report, not reproduced offline here) completed and returned
 * a correct `referencesTotal`, but nothing in the response ever said the
 * call was expensive or that `max` cannot make it cheaper. The fix adds a
 * cost warning, not a speedup — ADT's usageReferences endpoint honours no
 * server-side limit (see the existing source comment in `whereUsed`).
 *
 * All fixtures below are HAND-WRITTEN reference rows shaped like real ADT
 * usageReferences rows (see test/read-search.test.ts's REFS), not a live
 * capture. The reference counts (500, 499, 600) are chosen to straddle the
 * HIGH_FAN_IN_REFERENCES=500 threshold in src/tools/search.ts; that number
 * is not exported, so it is reproduced here as a literal and must be kept
 * in sync by hand.
 *
 * `resolveObject` is stubbed the same way test/read-search.test.ts stubs
 * it, so no ADT endpoint is contacted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import type { SessionPool } from "../src/adt/pool.js";
import type { SafetyGate } from "../src/safety.js";
import type { SearchToolDeps } from "../src/tools/search.js";

const stub = {
  object: {} as ResolvedObject,
};

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => stub.object,
}));

const { abapSearch, searchInputSchema, registerSearchTools } = await import("../src/tools/search.js");

function resolved(over: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    system: "A4H",
    type: "CLAS/OC",
    kind: "CLAS",
    label: "class",
    name: "CL_ABAP_TYPEDESCR",
    uri: "/sap/bc/adt/oo/classes/cl_abap_typedescr",
    mode: "source",
    activation: "unknown",
    spec: {},
    ...over,
  } as unknown as ResolvedObject;
}

const conn0 = { cfg: { sid: "A4H" } };

beforeEach(() => {
  stub.object = resolved();
});

function searchConn(handlers: {
  searchObject?: (q: string, group?: string, max?: number) => Promise<unknown[]>;
  usageReferences?: () => Promise<unknown[]>;
}): AbapConnection {
  return {
    cfg: conn0.cfg,
    adt: {
      searchObject: handlers.searchObject ?? (async () => []),
      usageReferences: handlers.usageReferences ?? (async () => []),
    },
  } as unknown as AbapConnection;
}

/** Hand-written reference rows, shaped like a real usageReferences response. */
function refs(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    "adtcore:type": "CLAS/OC",
    "adtcore:name": `ZCL_USER_${i}`,
    "adtcore:description": "uses it",
    packageRef: { "adtcore:name": "ZPKG" },
  }));
}

// Must match HIGH_FAN_IN_REFERENCES in src/tools/search.ts.
const THRESHOLD = 500;

describe("abap_search where_used discloses the cost of an expensive fetch", () => {
  it("RED-PROVABLE: warns on a high fan-in result even when max is large enough that nothing is capped", async () => {
    const r = await abapSearch(
      searchConn({ usageReferences: async () => refs(600) }),
      { query: "class CL_ABAP_TYPEDESCR", mode: "where_used", max: 1000 },
      20_000,
    );
    expect(r.text).toContain("referencesTotal: 600");
    expect(r.text).not.toMatch(/CAPPED/);
    expect(r.text).toMatch(/FETCH COST/);
    expect(r.text).toContain("600 reference(s)");
  });

  it("RED-PROVABLE: warns AND keeps the existing CAPPED note when both apply, without contradiction", async () => {
    const r = await abapSearch(
      searchConn({ usageReferences: async () => refs(600) }),
      { query: "class CL_ABAP_TYPEDESCR", mode: "where_used", max: 50 },
      20_000,
    );
    expect(r.text).toMatch(/FETCH COST/);
    expect(r.text).toMatch(/CAPPED: ADT returned 600 reference\(s\)/);
    expect(r.text).toMatch(/applied AFTER the full fetch/);
    expect(r.text).toContain("all 600 reference(s) were already retrieved");
  });

  it("PINS EXISTING BEHAVIOUR: stays silent on a small result — no warning, no fetchMs in the header", async () => {
    const r = await abapSearch(
      searchConn({ usageReferences: async () => refs(10) }),
      { query: "class ZCL_SMALL", mode: "where_used", max: 50 },
      20_000,
    );
    expect(r.text).not.toMatch(/FETCH COST/);
    expect(r.text).not.toMatch(/fetchMs/);
  });

  it("RED-PROVABLE: fires exactly at the threshold boundary (>=, not >)", async () => {
    const r = await abapSearch(
      searchConn({ usageReferences: async () => refs(THRESHOLD) }),
      { query: "class ZCL_EDGE", mode: "where_used", max: THRESHOLD },
      20_000,
    );
    expect(r.text).toContain(`referencesTotal: ${THRESHOLD}`);
    expect(r.text).not.toMatch(/CAPPED/);
    expect(r.text).toMatch(/FETCH COST/);
  });

  it("PINS EXISTING BEHAVIOUR: does not fire one below the threshold", async () => {
    const r = await abapSearch(
      searchConn({ usageReferences: async () => refs(THRESHOLD - 1) }),
      { query: "class ZCL_JUST_UNDER", mode: "where_used", max: THRESHOLD - 1 },
      20_000,
    );
    expect(r.text).not.toMatch(/FETCH COST/);
  });

  it("RED-PROVABLE: fires on a slow fetch even with few references (the SLOW_FETCH_MS arm)", async () => {
    // The fake advances the clock itself, inside usageReferences, so the
    // elapsed figure reflects when the fetch happened rather than how many
    // times anything on the path called Date.now() — an upstream call added
    // later cannot skew this.
    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const r = await abapSearch(
        searchConn({
          usageReferences: async () => {
            clock += 6000;
            return refs(10);
          },
        }),
        { query: "class ZCL_SLOW", mode: "where_used", max: 50 },
        20_000,
      );
      expect(r.text).not.toMatch(/CAPPED/);
      expect(r.text).toMatch(/FETCH COST/);
      expect(r.text).toMatch(/6\.0s/);
      expect(r.text).toContain("10 reference(s)");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("PINS EXISTING BEHAVIOUR: a fast fetch with few references stays silent even with a clock spy installed", async () => {
    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const r = await abapSearch(
        searchConn({
          usageReferences: async () => {
            clock += 10;
            return refs(10);
          },
        }),
        { query: "class ZCL_FAST", mode: "where_used", max: 50 },
        20_000,
      );
      expect(r.text).not.toMatch(/FETCH COST/);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("RED-PROVABLE: the note names the real reference count and a real (not fabricated) elapsed figure", async () => {
    const r = await abapSearch(
      searchConn({ usageReferences: async () => refs(600) }),
      { query: "class CL_ABAP_TYPEDESCR", mode: "where_used", max: 1000 },
      20_000,
    );
    // The fake resolves instantly, so the true elapsed figure here is ~0.0s
    // — that is the honest measurement for this fake, not an invented one.
    expect(r.text).toMatch(/\d+\.\ds\b/);
    expect(r.text).toContain("600 reference(s)");
  });

  it("RED-PROVABLE: the note states that max does not reduce the cost", async () => {
    const r = await abapSearch(
      searchConn({ usageReferences: async () => refs(600) }),
      { query: "class CL_ABAP_TYPEDESCR", mode: "where_used", max: 1000 },
      20_000,
    );
    expect(r.text).toMatch(/not by max/i);
    expect(r.text).toMatch(/lowering max/i);
  });

  it("RED-PROVABLE: the note explains the mechanism — no server-side limit, full set enumerated before max is applied", async () => {
    const r = await abapSearch(
      searchConn({ usageReferences: async () => refs(600) }),
      { query: "class CL_ABAP_TYPEDESCR", mode: "where_used", max: 1000 },
      20_000,
    );
    expect(r.text).toMatch(/no server-side limit/);
    expect(r.text).toMatch(/enumerated/);
  });

  it("RED-PROVABLE: the note says what actually helps — a narrower or less widely-referenced object", async () => {
    const r = await abapSearch(
      searchConn({ usageReferences: async () => refs(600) }),
      { query: "class CL_ABAP_TYPEDESCR", mode: "where_used", max: 1000 },
      20_000,
    );
    expect(r.text).toMatch(/narrower|less widely-referenced/);
  });
});

describe("abap_search pre-call cost warning (the only channel that fires BEFORE the wait)", () => {
  it("PINS EXISTING BEHAVIOUR: `max`'s description says narrowing query, not lowering max, is what makes where_used cheaper", () => {
    expect(searchInputSchema.max.description).toMatch(
      /narrowing `query` \(not lowering `max`\) is what makes a broad call cheaper/,
    );
  });

  it("PINS EXISTING BEHAVIOUR: the registered tool description warns that where_used can take 20+ seconds", () => {
    const tools = new Map<string, { config: Record<string, unknown> }>();
    const mcp = {
      registerTool: (name: string, config: Record<string, unknown>) => {
        tools.set(name, { config });
        return {} as unknown;
      },
    } as unknown as McpServer;

    const deps: SearchToolDeps = {
      pool: {} as unknown as SessionPool,
      safety: {} as unknown as SafetyGate,
      ensureConnected: async () => {},
      errorResult: (e: unknown): CallToolResult => ({
        isError: true,
        content: [{ type: "text", text: String(e) }],
      }),
      cfg: { maxResponseChars: 20_000 },
    };

    registerSearchTools(mcp, deps);
    const entry = tools.get("abap_search");
    if (!entry) throw new Error('tool "abap_search" was never registered');
    expect(entry.config.description as string).toMatch(/20\+ seconds/);
  });
});
