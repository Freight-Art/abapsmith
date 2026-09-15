/**
 * `abap_search mode="call_graph"` (issue #105) — `src/adt/call-graph.ts`
 * (rendering, both directions) and `src/adt/call-sites.ts` (`parseCallSites`,
 * the static parser behind direction="callees").
 *
 * Live captures used, all in test/fixtures/live-captured/:
 *   - 971/972: usageReferences answers for ZCL_I105_A / ZCL_I105_B, a real
 *     two-object cycle (A's callers include B, B's callers include A).
 *   - 973: usageReferences answer for ZCL_I105_LEAF — one real caller
 *     (ZCL_I105_A) plus a $TMP DEVC/K row and the self-row, neither of
 *     which is a caller.
 *   - 974/975: the two classes' own source (zcl_i105_a, zcl_i105_b), the
 *     ground truth for parseCallSites.
 *
 * `resolveObject` is mocked the same way test/search-where-used-cost.test.ts
 * mocks it, so direction="callers" tests never touch conn.adt.searchObject.
 * direction="callers" only calls conn.post (fetchUsageReferences, via
 * element-info.ts); direction="callees" only calls conn.get (readSource).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import type { SessionPool } from "../src/adt/pool.js";
import type { SafetyGate } from "../src/safety.js";
import type { SearchToolDeps } from "../src/tools/search.js";
import { parseCallSites } from "../src/adt/call-sites.js";
import { isAbapError } from "../src/adt/errors.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const read = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

const stub = { object: {} as ResolvedObject };

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => stub.object,
}));

const { abapSearch, registerSearchTools } = await import("../src/tools/search.js");

function resolved(over: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    system: "A4H",
    type: "CLAS/OC",
    kind: "CLAS",
    label: "class",
    name: "ZCL_I105_A",
    uri: "/sap/bc/adt/oo/classes/zcl_i105_a",
    sourceUri: "/sap/bc/adt/oo/classes/zcl_i105_a/source/main",
    mode: "source",
    activation: "unknown",
    spec: {},
    ...over,
  } as unknown as ResolvedObject;
}

function catchAbap(fn: () => unknown): import("../src/adt/errors.js").AbapError {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected an AbapError, but the call returned normally");
}

async function catchAbapAsync(p: Promise<unknown>): Promise<import("../src/adt/errors.js").AbapError> {
  try {
    await p;
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected an AbapError, but the call resolved normally");
}

beforeEach(() => {
  stub.object = resolved();
});

// ---------------------------------------------------------------------------
// direction="callers" fake connection: conn.post replays a fixture keyed by
// the `qs.uri` fragment the request carried, exactly what fetchUsageReferences
// (element-info.ts) builds it as (no pos => the fragment IS the node's uri).
// ---------------------------------------------------------------------------

function callerConn(byUri: Record<string, string>, postSpy?: (uri: string) => void): AbapConnection {
  return {
    cfg: { sid: "A4H" },
    post: async (_url: string, opts: { qs?: { uri?: string } }) => {
      const uri = opts.qs?.uri ?? "";
      postSpy?.(uri);
      const body = byUri[uri];
      if (body === undefined) throw new Error(`callerConn: no fixture stubbed for uri "${uri}"`);
      return { body, headers: {} };
    },
  } as unknown as AbapConnection;
}

const URI_A = "/sap/bc/adt/oo/classes/zcl_i105_a";
const URI_B = "/sap/bc/adt/oo/classes/zcl_i105_b";
const URI_LEAF = "/sap/bc/adt/oo/classes/zcl_i105_leaf";

const XML_A = read("971-i105-usage-references-cycle-a.xml");
const XML_B = read("972-i105-usage-references-cycle-b.xml");
const XML_LEAF = read("973-i105-usage-references-leaf.xml");

// ---------------------------------------------------------------------------
// direction="callees" fake connection: conn.get returns a class's own
// /source/main text; every other include (definitions/implementations/
// macros/testclasses) throws, same as a real class with no such include.
// ---------------------------------------------------------------------------

function calleeConn(mainByUri: Record<string, string>): AbapConnection {
  return {
    cfg: { sid: "A4H" },
    get: async (uri: string) => {
      const body = mainByUri[uri];
      if (body === undefined) throw new Error(`calleeConn: no main source stubbed for uri "${uri}"`);
      return { body, headers: {} };
    },
  } as unknown as AbapConnection;
}

const SRC_A = read("974-i105-source-zcl-i105-a.txt");
const SRC_B = read("975-i105-source-zcl-i105-b.txt");

describe("call_graph direction=\"callers\" replays live where-used captures", () => {
  it("973 REGRESSION: whereUsed's real caller for ZCL_I105_LEAF is NOT empty (historical vendor-parser defect: conn.adt.usageReferences hardcoded capital \"usageReferences:\" but A4H sends lowercase \"usagereferences:\" — call-graph.ts no longer calls that vendor function; see element-info.ts's fetchUsageReferences)", async () => {
    stub.object = resolved({ name: "ZCL_I105_LEAF", uri: URI_LEAF, packageName: "$TMP" });
    const r = await abapSearch(
      callerConn({ [URI_LEAF]: XML_LEAF }),
      { query: "ZCL_I105_LEAF", mode: "call_graph", direction: "callers", depth: 1 },
      20_000,
    );
    expect(r.text).toContain("ZCL_I105_A");
  });

  it("973: the DEVC/K $TMP package row and the self-row are excluded from children — exactly one child (ZCL_I105_A), not three", async () => {
    stub.object = resolved({ name: "ZCL_I105_LEAF", uri: URI_LEAF, packageName: "$TMP" });
    const r = await abapSearch(
      callerConn({ [URI_LEAF]: XML_LEAF }),
      { query: "ZCL_I105_LEAF", mode: "call_graph", direction: "callers", depth: 1 },
      20_000,
    );
    const body = r.text.split("--- CALL GRAPH ---")[1] ?? "";
    // Count child NODES, not the raw substring: each node's line also
    // contains a same-named `abap_read {"object":"ZCL_I105_A",...}` suggestion,
    // so the substring "ZCL_I105_A" legitimately appears twice per node.
    // Counting the node-label pattern (`CLAS/OC ZCL_I105_A (`) isolates one
    // match per rendered node.
    const nodeOccurrences = body.split("CLAS/OC ZCL_I105_A (").length - 1;
    expect(nodeOccurrences).toBe(1);
    expect(body).not.toContain("$TMP (cycle");
    expect(body).not.toContain("DEVC/K $TMP");
  });

  it("971/972 cycle: direction=\"callers\" over A renders B, and B's own callers (which include A again) render as \"(cycle -> seen above)\" and terminate — no fetch for the already-seen node", async () => {
    const seenUris: string[] = [];
    const conn = callerConn({ [URI_A]: XML_A, [URI_B]: XML_B }, (uri) => seenUris.push(uri));
    stub.object = resolved({ name: "ZCL_I105_A", uri: URI_A, packageName: "$TMP" });
    const r = await abapSearch(
      conn,
      { query: "ZCL_I105_A", mode: "call_graph", direction: "callers", depth: 4 },
      20_000,
    );
    expect(r.text).toMatch(/ZCL_I105_B[^\n]*\n\s+CLAS\/OC ZCL_I105_A[^\n]*\(cycle -> seen above\)/);
    // Exactly one fetch per distinct node: A once (root) and B once (child) — never a third fetch for A again.
    expect(seenUris).toEqual([URI_A, URI_B]);
  });

  it("depth=1 expands one level only — B is shown, but its own callers (which would need a third fetch) are never fetched", async () => {
    const seenUris: string[] = [];
    const conn = callerConn({ [URI_A]: XML_A, [URI_B]: XML_B }, (uri) => seenUris.push(uri));
    stub.object = resolved({ name: "ZCL_I105_A", uri: URI_A, packageName: "$TMP" });
    const r = await abapSearch(
      conn,
      { query: "ZCL_I105_A", mode: "call_graph", direction: "callers", depth: 1 },
      20_000,
    );
    expect(r.text).toContain("ZCL_I105_B");
    expect(seenUris).toEqual([URI_A]);
  });

  it("depth=5 is refused BAD_INPUT — the message names the maximum (4)", async () => {
    const err = await catchAbapAsync(
      abapSearch(
        callerConn({}),
        { query: "ZCL_I105_A", mode: "call_graph", direction: "callers", depth: 5 },
        20_000,
      ),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("4");
    expect(err.message).toMatch(/exceeds the maximum/i);
    expect(err.message).not.toMatch(/clamp/i);
  });

  it("a 500-row hand-written where-used answer renders \"(not expanded: 500 references)\" and does not fetch that node's own children", async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({
      uri: `/sap/bc/adt/oo/classes/zcl_high_fanin_${i}`,
      "adtcore:name": `ZCL_HIGH_FANIN_${i}`,
      "adtcore:type": "CLAS/OC",
      packageRef: { "adtcore:name": "$TMP" },
    }));
    const highFanInXml = `<?xml version="1.0" encoding="utf-8"?><usagereferences:usageReferenceResult numberOfResults="${rows.length}" xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences"><usagereferences:referencedObjects>${rows
      .map(
        (r) =>
          `<usagereferences:referencedObject uri="${r.uri}" isResult="false"><usagereferences:adtObject adtcore:name="${r["adtcore:name"]}" adtcore:type="${r["adtcore:type"]}" xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:packageRef adtcore:name="$TMP"/></usagereferences:adtObject></usagereferences:referencedObject>`,
      )
      .join("")}</usagereferences:referencedObjects></usagereferences:usageReferenceResult>`;
    const seenUris: string[] = [];
    const conn = callerConn({ [URI_A]: highFanInXml }, (uri) => seenUris.push(uri));
    stub.object = resolved({ name: "ZCL_I105_A", uri: URI_A });
    const r = await abapSearch(
      conn,
      { query: "ZCL_I105_A", mode: "call_graph", direction: "callers", depth: 4 },
      20_000,
    );
    expect(r.text).toContain("(not expanded: 500 references)");
    expect(seenUris).toEqual([URI_A]);
  });

  it("`max` truncation emits \"--- TRUNCATED ---\" in the body naming the omitted and total counts", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      uri: `/sap/bc/adt/oo/classes/zcl_child_${i}`,
      "adtcore:name": `ZCL_CHILD_${i}`,
      "adtcore:type": "CLAS/OC",
    }));
    const xml = `<?xml version="1.0" encoding="utf-8"?><usagereferences:usageReferenceResult numberOfResults="5" xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences"><usagereferences:referencedObjects>${rows
      .map(
        (r) =>
          `<usagereferences:referencedObject uri="${r.uri}" isResult="false"><usagereferences:adtObject adtcore:name="${r["adtcore:name"]}" adtcore:type="${r["adtcore:type"]}" xmlns:adtcore="http://www.sap.com/adt/core"/></usagereferences:referencedObject>`,
      )
      .join("")}</usagereferences:referencedObjects></usagereferences:usageReferenceResult>`;
    stub.object = resolved({ name: "ZCL_I105_A", uri: URI_A });
    const r = await abapSearch(
      callerConn({ [URI_A]: xml }),
      { query: "ZCL_I105_A", mode: "call_graph", direction: "callers", depth: 1, max: 2 },
      20_000,
    );
    expect(r.text).toContain("--- TRUNCATED ---");
    expect(r.text).toMatch(/3 of 5 caller\(s\)/);
  });
});

describe("call_graph direction=\"callees\" end to end (buildCallGraph -> collectCallSites -> parseCallSites, 974)", () => {
  it("974: direction=\"callees\" over ZCL_I105_A reports the static targets parseCallSites finds", async () => {
    stub.object = resolved({ name: "ZCL_I105_A", uri: URI_A, sourceUri: `${URI_A}/source/main` });
    const r = await abapSearch(
      calleeConn({ [`${URI_A}/source/main`]: SRC_A }),
      { query: "ZCL_I105_A", mode: "call_graph", direction: "callees", depth: 1 },
      20_000,
    );
    // Each static callee is resolved via the mocked resolveObject, which
    // always answers with `stub.object` (ZCL_I105_A) regardless of the
    // target queried — so the render shows ZCL_I105_A's own label at each
    // resolved child, not the real target names. What this end-to-end test
    // actually pins is that four children were found and resolved (not left
    // as "unresolved"), matching parseCallSites's four static sites in 974.
    // The fixed static-blind-spot note always mentions the word
    // "unresolved" while describing what a dynamic-target leaf looks like
    // — so only the rendered CALL GRAPH body (not the whole response,
    // which includes that note) can tell us whether any node actually
    // came out unresolved.
    const body = r.text.split("--- CALL GRAPH ---")[1] ?? "";
    expect(body).not.toMatch(/unresolved/);
    const nodesLine = r.text.match(/nodes:\s*(\d+)/);
    expect(nodesLine).not.toBeNull();
    // root + 4 static callees (function module, 2 methods, 1 report) = 5 nodes.
    expect(Number(nodesLine![1])).toBe(5);
  });
});

describe("parseCallSites (974/975) — the static parser behind direction=\"callees\"", () => {
  it("974: CALL FUNCTION 'RFC_SYSTEM_INFO' is a function-module site targeting RFC_SYSTEM_INFO", () => {
    const sites = parseCallSites(SRC_A, "main");
    const fn = sites.find((s) => s.kind === "function module");
    expect(fn?.target).toBe("RFC_SYSTEM_INFO");
  });

  it("974: zcl_i105_b=>run( ) and zcl_i105_leaf=>calc( ) are method sites targeting ZCL_I105_B and ZCL_I105_LEAF", () => {
    const sites = parseCallSites(SRC_A, "main");
    const methodTargets = sites.filter((s) => s.kind === "method").map((s) => s.target).sort();
    expect(methodTargets).toEqual(["ZCL_I105_B", "ZCL_I105_LEAF"]);
  });

  it("974: SUBMIT zi105_rep AND RETURN is a report site targeting ZI105_REP", () => {
    const sites = parseCallSites(SRC_A, "main");
    const report = sites.find((s) => s.kind === "report");
    expect(report?.target).toBe("ZI105_REP");
  });

  it("975: PERFORM dummy IN PROGRAM zi105_form IF FOUND is a form site whose target is the PROGRAM name ZI105_FORM, not the form name DUMMY", () => {
    const sites = parseCallSites(SRC_B, "main");
    const form = sites.find((s) => s.kind === "form");
    expect(form?.target).toBe("ZI105_FORM");
  });

  it("975: zcl_i105_a=>run( ) is a method site targeting ZCL_I105_A", () => {
    const sites = parseCallSites(SRC_B, "main");
    const method = sites.find((s) => s.kind === "method");
    expect(method?.target).toBe("ZCL_I105_A");
  });

  it("dynamic CALL FUNCTION lv_name and CALL FUNCTION (lv_name) both yield target===undefined", () => {
    const sites = parseCallSites("CALL FUNCTION lv_name.\nCALL FUNCTION (lv_name).", "main");
    expect(sites).toHaveLength(2);
    for (const s of sites) {
      expect(s.kind).toBe("function module");
      expect(s.target).toBeUndefined();
    }
  });

  it("dynamic SUBMIT (lv_prog) yields target===undefined", () => {
    const sites = parseCallSites("SUBMIT (lv_prog).", "main");
    expect(sites).toHaveLength(1);
    expect(sites[0]?.kind).toBe("report");
    expect(sites[0]?.target).toBeUndefined();
  });

  it("dynamic lo_ref->method( ) yields target===undefined (the receiver is a variable, not a class name)", () => {
    const sites = parseCallSites("lo_ref->method( ).", "main");
    expect(sites).toHaveLength(1);
    expect(sites[0]?.kind).toBe("method");
    expect(sites[0]?.target).toBeUndefined();
  });

  it("a bare PERFORM dummy. with no IN PROGRAM yields NO call site at all (it calls a form in the SAME program)", () => {
    const sites = parseCallSites("PERFORM dummy.", "main");
    expect(sites).toHaveLength(0);
  });

  it("a full-line * comment produces no site, even though the commented text names a real call", () => {
    const sites = parseCallSites("* CALL FUNCTION 'RFC_SYSTEM_INFO'.", "main");
    expect(sites).toHaveLength(0);
  });

  it("a trailing \" comment produces no site for the commented call, but the code before it is still parsed", () => {
    const sites = parseCallSites("SUBMIT zi105_rep. \" CALL FUNCTION 'RFC_SYSTEM_INFO'.", "main");
    expect(sites).toHaveLength(1);
    expect(sites[0]?.kind).toBe("report");
    expect(sites[0]?.target).toBe("ZI105_REP");
  });

  it("a quoted target survives comment-stripping — the string literal itself is not blanked, only a trailing real comment is cut", () => {
    const sites = parseCallSites("CALL FUNCTION 'RFC_SYSTEM_INFO'. \" trailing note", "main");
    expect(sites).toHaveLength(1);
    expect(sites[0]?.target).toBe("RFC_SYSTEM_INFO");
  });
});

// direction/depth are refused by assertNoCallGraphOnlyFields, which lives
// inside the registered tool's request handler (search.ts line ~787), not
// inside abapSearch itself — so this check has to go through the
// registered "abap_search" tool, not a direct abapSearch(...) call.
function registerAbapSearchHandler(): (args: unknown) => Promise<CallToolResult> {
  let handler: ((args: unknown) => Promise<CallToolResult>) | undefined;
  const mcp = {
    registerTool: (_name: string, _config: unknown, h: (args: unknown) => Promise<CallToolResult>) => {
      handler = h;
      return {} as unknown;
    },
  } as unknown as McpServer;
  const deps: SearchToolDeps = {
    pool: {} as unknown as SessionPool,
    safety: {} as unknown as SafetyGate,
    ensureConnected: async () => {},
    errorResult: (e: unknown): CallToolResult => ({
      isError: true,
      content: [{ type: "text", text: isAbapError(e) ? `${e.code}: ${e.message}` : String(e) }],
    }),
    cfg: { maxResponseChars: 20_000 } as unknown as SearchToolDeps["cfg"],
  };
  registerSearchTools(mcp, deps);
  if (!handler) throw new Error('tool "abap_search" was never registered');
  return handler;
}

describe("call_graph parameter validation", () => {
  it("direction with a non-call_graph mode is refused BAD_INPUT", async () => {
    const handler = registerAbapSearchHandler();
    const result = await handler({ query: "X", mode: "objects", direction: "callers" });
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toMatch(/BAD_INPUT/);
  });

  it("depth with a non-call_graph mode is refused BAD_INPUT", async () => {
    const handler = registerAbapSearchHandler();
    const result = await handler({ query: "X", mode: "where_used", depth: 2 });
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toMatch(/BAD_INPUT/);
  });
});

describe("static blind-spot note appears on every call_graph response", () => {
  it("direction=\"callers\": the note about dynamic dispatch (CALL FUNCTION lv_name, obj->method( ), etc.) is present", async () => {
    stub.object = resolved({ name: "ZCL_I105_LEAF", uri: URI_LEAF });
    const r = await abapSearch(
      callerConn({ [URI_LEAF]: XML_LEAF }),
      { query: "ZCL_I105_LEAF", mode: "call_graph", direction: "callers", depth: 1 },
      20_000,
    );
    expect(r.text).toMatch(/dynamically dispatched/i);
  });

  it("direction=\"callees\": the same dynamic-dispatch note is present, plus the source-parsing (not an ADT index) caveat", async () => {
    stub.object = resolved({ name: "ZCL_I105_A", uri: URI_A, sourceUri: `${URI_A}/source/main` });
    const r = await abapSearch(
      calleeConn({ [`${URI_A}/source/main`]: SRC_A }),
      { query: "ZCL_I105_A", mode: "call_graph", direction: "callees", depth: 1 },
      20_000,
    );
    expect(r.text).toMatch(/dynamically dispatched/i);
    expect(r.text).toMatch(/not an ADT index/i);
  });
});

describe("abap_search registered tool description covers call_graph", () => {
  it("mentions call_graph, direction, and depth<=4", () => {
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
      content: [{ type: "text", text: isAbapError(e) ? `${e.code}: ${e.message}` : String(e) }],
    }),
      cfg: { maxResponseChars: 20_000 } as unknown as SearchToolDeps["cfg"],
    };

    registerSearchTools(mcp, deps);
    const entry = tools.get("abap_search");
    if (!entry) throw new Error('tool "abap_search" was never registered');
    const description = entry.config.description as string;
    expect(description).toMatch(/call_graph/);
    expect(description).toMatch(/direction/);
    expect(description).toMatch(/depth<=4/);
  });
});
