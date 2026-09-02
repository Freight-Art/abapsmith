/**
 * Offline tests for `abap_open_url` — `src/tools/open-url.ts`.
 *
 * Three mutually-exclusive routes (`object` / `keyword` / `webdynpro`).
 * `resolveObject` is stubbed the same way `test/read-search.test.ts` stubs it,
 * so the `object` route never touches an ADT endpoint either. `keyword` and
 * `webdynpro` never call `resolveObject` at all — they are pure string
 * builders, asserted directly.
 *
 * Harness (fakeMcp/invoke/errorPayload/okText/fakePool/openGate) mirrors
 * `test/fpm-tools.test.ts`'s "registerTool-capturing fake McpServer" shape,
 * since `resolveOpenUrl` itself isn't exported — only `registerOpenUrlTools`
 * is, so the handler is exercised through the real MCP registration path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import type { SessionPool } from "../src/adt/pool.js";
import type { OpenUrlToolDeps } from "../src/tools/open-url.js";
import { SafetyGate } from "../src/safety.js";
import { errorResult } from "../src/server.js";

// --- stub state, set per test -----------------------------------------------
const stub = {
  object: {} as ResolvedObject,
};

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => stub.object,
}));

const { registerOpenUrlTools } = await import("../src/tools/open-url.js");

function resolved(over: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    system: "A4H",
    type: "CLAS/OC",
    kind: "CLAS",
    label: "class",
    name: "ZCL_BIG",
    uri: "/sap/bc/adt/oo/classes/zcl_big",
    mode: "source",
    activation: "unknown",
    spec: {},
    ...over,
  } as unknown as ResolvedObject;
}

const conn = { cfg: { sid: "A4H" } } as unknown as AbapConnection;

beforeEach(() => {
  stub.object = resolved();
});

// --- harness (mirrors test/fpm-tools.test.ts) -------------------------------

const openGate = (): SafetyGate => new SafetyGate({ readOnly: false, allowPackages: ["$TMP"], writesLockedOut: false });

function fakePool(c: AbapConnection): SessionPool {
  return {
    withRead: <T,>(_op: string, fn: (conn: AbapConnection) => Promise<T>) => fn(c),
  } as unknown as SessionPool;
}

function fakeMcp(): {
  mcp: McpServer;
  tools: Map<string, { config: Record<string, unknown>; handler: (args: unknown) => Promise<CallToolResult> }>;
} {
  const tools = new Map<string, { config: Record<string, unknown>; handler: (args: unknown) => Promise<CallToolResult> }>();
  const mcp = {
    registerTool: (name: string, config: Record<string, unknown>, handler: (args: unknown) => Promise<CallToolResult>) => {
      tools.set(name, { config, handler });
      return {} as unknown;
    },
  } as unknown as McpServer;
  return { mcp, tools };
}

async function invoke(
  tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>,
  name: string,
  args: unknown,
): Promise<CallToolResult> {
  const entry = tools.get(name);
  if (!entry) throw new Error(`tool "${name}" was never registered`);
  return entry.handler(args);
}

function okPayload(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return JSON.parse(text.text) as Record<string, unknown>;
}

function errorPayload(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBe(true);
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return JSON.parse(text.text) as Record<string, unknown>;
}

function registerAndGet(cfg: { url: string; sid: string } = { url: "http://sap.invalid:50000", sid: "A4H" }): {
  tools: Map<string, { config: Record<string, unknown>; handler: (args: unknown) => Promise<CallToolResult> }>;
} {
  const { mcp, tools } = fakeMcp();
  const deps: OpenUrlToolDeps = {
    pool: fakePool(conn),
    cfg,
    safety: openGate(),
    ensureConnected: async () => {},
    errorResult,
  };
  registerOpenUrlTools(mcp, deps);
  return { tools };
}

// ---------------------------------------------------------------------------
// object route
// ---------------------------------------------------------------------------

describe("abap_open_url — object route", () => {
  it("resolves a normal CLAS to the ADT source/main HTML view, with an adt:// deep link", async () => {
    const { tools } = registerAndGet();
    const r = okPayload(await invoke(tools, "abap_open_url", { object: "ZCL_BIG" }));
    expect(r.route).toBe("adt-source-html");
    expect(r.url).toBe("http://sap.invalid:50000/sap/bc/adt/oo/classes/zcl_big/source/main");
    expect(r.adtUrl).toBe("adt://A4H/sap/bc/adt/oo/classes/zcl_big");
  });

  it("appends a #start=N,0 fragment to both url and adtUrl when line is given", async () => {
    const { tools } = registerAndGet();
    const r = okPayload(await invoke(tools, "abap_open_url", { object: "ZCL_BIG", line: 42 }));
    expect(r.url).toBe("http://sap.invalid:50000/sap/bc/adt/oo/classes/zcl_big/source/main#start=42,0");
    expect(r.adtUrl).toBe("adt://A4H/sap/bc/adt/oo/classes/zcl_big#start=42,0");
  });

  it("omits adtUrl and notes that ABAP_SID is not configured when sid is UNKNOWN", async () => {
    const { tools } = registerAndGet({ url: "http://sap.invalid:50000", sid: "UNKNOWN" });
    const r = okPayload(await invoke(tools, "abap_open_url", { object: "ZCL_BIG" }));
    expect(r.adtUrl).toBeUndefined();
    expect(String(r.note)).toContain("ABAP_SID is not configured");
  });

  it.each(["DTEL", "DOMA", "TTYP"])("warns that %s does not render as HTML", async (kind) => {
    stub.object = resolved({ kind, type: `${kind}/DE` } as unknown as Partial<ResolvedObject>);
    const { tools } = registerAndGet();
    const r = okPayload(await invoke(tools, "abap_open_url", { object: "ZDTEL" }));
    expect(String(r.note)).toContain("metadata objects of this kind do not render as HTML");
  });

  it("does not warn for a kind that does support an HTML source view (e.g. CLAS)", async () => {
    const { tools } = registerAndGet();
    const r = okPayload(await invoke(tools, "abap_open_url", { object: "ZCL_BIG" }));
    expect(r.note).toBeUndefined();
  });

  it("rejects type/line supplied without object", async () => {
    const { tools } = registerAndGet();
    const r = errorPayload(await invoke(tools, "abap_open_url", { keyword: "SELECT", line: 5 }));
    expect(r.error).toBe("BAD_INPUT");
    expect(String(r.message)).toContain("type/line are only valid alongside object");
  });
});

// ---------------------------------------------------------------------------
// keyword route
// ---------------------------------------------------------------------------

describe("abap_open_url — keyword route", () => {
  it("builds the ABAP<KEYWORD> docu url and a query searchUrl, uppercasing the keyword", async () => {
    const { tools } = registerAndGet();
    const r = okPayload(await invoke(tools, "abap_open_url", { keyword: "select" }));
    expect(r.route).toBe("abap-docu");
    expect(r.url).toBe("http://sap.invalid:50000/sap/public/bc/abap/docu?object=ABAPSELECT");
    expect(r.searchUrl).toBe("http://sap.invalid:50000/sap/public/bc/abap/docu?query=SELECT");
    expect(r.keyword).toBe("SELECT");
  });

  it("rejects a keyword with invalid characters instead of escaping them", async () => {
    const { tools } = registerAndGet();
    const r1 = errorPayload(await invoke(tools, "abap_open_url", { keyword: "SEL;ECT" }));
    expect(r1.error).toBe("BAD_INPUT");
    const r2 = errorPayload(await invoke(tools, "abap_open_url", { keyword: "a&b" }));
    expect(r2.error).toBe("BAD_INPUT");
  });
});

// ---------------------------------------------------------------------------
// webdynpro route
// ---------------------------------------------------------------------------

describe("abap_open_url — webdynpro route", () => {
  it("builds the launch url, passing the app name through unchanged (no case normalization)", async () => {
    const { tools } = registerAndGet();
    const r = okPayload(await invoke(tools, "abap_open_url", { webdynpro: "ZfooApp_1" }));
    expect(r.route).toBe("web-dynpro");
    expect(r.url).toBe("http://sap.invalid:50000/sap/bc/webdynpro/sap/ZfooApp_1");
    expect(r.app).toBe("ZfooApp_1");
  });

  it("rejects a webdynpro app name with invalid characters", async () => {
    const { tools } = registerAndGet();
    const r1 = errorPayload(await invoke(tools, "abap_open_url", { webdynpro: "ZAPP;DROP" }));
    expect(r1.error).toBe("BAD_INPUT");
    const r2 = errorPayload(await invoke(tools, "abap_open_url", { webdynpro: "a b" }));
    expect(r2.error).toBe("BAD_INPUT");
  });
});

// ---------------------------------------------------------------------------
// cross-cutting
// ---------------------------------------------------------------------------

describe("abap_open_url — route selection and registration", () => {
  it("rejects when none of object/keyword/webdynpro is supplied", async () => {
    const { tools } = registerAndGet();
    const r = errorPayload(await invoke(tools, "abap_open_url", {}));
    expect(r.error).toBe("BAD_INPUT");
    expect(String(r.message)).toContain("Exactly one of");
  });

  it("rejects when two or more of object/keyword/webdynpro are supplied together", async () => {
    const { tools } = registerAndGet();
    const r = errorPayload(
      await invoke(tools, "abap_open_url", { object: "ZCL_BIG", keyword: "SELECT" }),
    );
    expect(r.error).toBe("BAD_INPUT");
    expect(String(r.message)).toContain("Exactly one of");
  });

  it("registers with readOnlyHint and openWorldHint annotations", () => {
    const { tools } = registerAndGet();
    const entry = tools.get("abap_open_url")!;
    expect(entry.config.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
  });
});
