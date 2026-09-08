/**
 * `abap_fluid` — the MCP tool registrar in `src/tools/fluid.ts`.
 *
 * Zero-network ops (bare call, list, describe, status) are exercised
 * against a booby-trapped `pool`/`ensureConnected` that throw if touched,
 * proving they never leave the process. `run` is exercised end-to-end
 * against a real (fake) `AbapConnection`, reusing
 * `test/fluid-dispatch.test.ts`'s dynamic, content-hash-agnostic class store
 * (the invoker class name is derived from the args hash and cannot be known
 * ahead of time). Registration gating is checked the same way
 * `test/data-preview-gates.test.ts` checks `abap_data_preview`: a real
 * `createServer` + an in-memory MCP client's `tools/list`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import type { SessionPool } from "../src/adt/pool.js";
import { createServer, errorResult, type AbapsmithServer } from "../src/server.js";
import { registerFluidTool, type FluidToolDeps } from "../src/tools/fluid.js";
import { resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import {
  manifestVersion,
  type FluidActionSpec,
  type FluidManifest,
  type LoadedFluidTool,
} from "../src/adt/fluid/manifest.js";
import type { FluidToolSet } from "../src/adt/fluid/plugin-loader.js";

// --- fake ADT wiring (mirrors test/fluid-ensure.test.ts / test/fluid-dispatch.test.ts) ---

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

type Route = (r: Recorded) => HttpClientResponse | undefined;

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body };
    this.calls.push(rec);
    const res = this.route(rec);
    if (!res) throw new Error(`FakeAdt: unrouted request ${label}`);
    return res;
  }
}

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  return undefined;
}

async function connected(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(cfg(), {
    httpClient: routeSystemRoleProbe(adt, { answer: "nonproductive" }),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

// --- run-op dynamic class store (copied idiom from test/fluid-dispatch.test.ts: the invoker
// class name is content-hash derived, so a static pre-declared store cannot work here) ---

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

const CLS_COLLECTION = "/sap/bc/adt/oo/classes";
const PKG_URI = "/sap/bc/adt/packages/%24abapsmith_fluid_api";
const PACKAGES = "/sap/bc/adt/packages";
const CLASSRUN_BASE = "/sap/bc/adt/oo/classrun/";

const notFoundXml = (name: string): string =>
  `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
  `<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>` +
  `<message lang="EN">${name} does not exist</message><properties/></exc:exception>`;

const PACKAGE_XML = (name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<pak:package xmlns:pak="http://www.sap.com/adt/packages" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" adtcore:type="DEVC/K">` +
  `<adtcore:packageRef adtcore:name="${name}" adtcore:type="DEVC/K"/>` +
  `<pak:superPackage/>` +
  `</pak:package>`;

function classDocXml(
  className: string,
  opts: { rootVersion?: string; mainVersion?: string; packageName?: string } = {},
): string {
  const root = opts.rootVersion ?? "active";
  const main = opts.mainVersion ?? root;
  const pkg = opts.packageName ?? "$TMP";
  const ver = (v: string) => ` adtcore:version="${v}"`;
  const inc = (type: string, version: string) =>
    `<class:include class:includeType="${type}" ` +
    `abapsource:sourceUri="${type === "main" ? "source/main" : `includes/${type}`}" ` +
    `adtcore:name="" adtcore:type="CLAS/I"${ver(version)}/>`;
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<class:abapClass adtcore:name="${className}" adtcore:type="CLAS/OC"${ver(root)} ` +
    `xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `xmlns:abapsource="http://www.sap.com/adt/abapsource">` +
    `<adtcore:packageRef adtcore:name="${pkg}"/>` +
    inc("definitions", "active") +
    inc("implementations", "active") +
    inc("macros", "active") +
    inc("main", main) +
    `</class:abapClass>`
  );
}

interface ObjState {
  exists: boolean;
  packageName: string;
  source?: string;
  active: boolean;
}

function nameFromClassUrl(url: string): string | undefined {
  const prefix = "/sap/bc/adt/oo/classes/";
  if (!url.startsWith(prefix)) return undefined;
  const rest = url.slice(prefix.length);
  if (rest.endsWith("/source/main")) return rest.slice(0, -"/source/main".length).toUpperCase();
  if (rest.includes("/")) return undefined;
  return rest.toUpperCase();
}

function dynamicFluidRoute(opts: { transcript: () => string }): Route {
  const store = new Map<string, ObjState>();
  const at = (name: string): ObjState => {
    let st = store.get(name);
    if (!st) {
      st = { exists: false, packageName: "$TMP", active: false };
      store.set(name, st);
    }
    return st;
  };

  return (r) => {
    if (r.url === PKG_URI && r.method === "GET") return resp(200, PACKAGE_XML(FLUID_PACKAGE), OK_XML);
    if (r.url === PACKAGES && r.method === "POST") return resp(200, "", OK_TEXT);

    if (r.url === CLS_COLLECTION && r.method === "POST") {
      const m = /adtcore:name="([^"]+)"/.exec(r.body ?? "");
      const name = (m?.[1] ?? "").toUpperCase();
      const prior = store.get(name);
      store.set(name, { exists: true, packageName: FLUID_PACKAGE, source: prior?.source, active: false });
      return resp(200, "", OK_TEXT);
    }

    if (r.url === "/sap/bc/adt/activation" && r.method === "POST") {
      const m = /adtcore:name="([^"]+)"/.exec(r.body ?? "");
      const name = (m?.[1] ?? "").toUpperCase();
      const st = store.get(name);
      if (st) st.active = true;
      return resp(200, "", OK_TEXT);
    }

    if (r.url.startsWith(CLASSRUN_BASE) && r.method === "POST") {
      return resp(200, opts.transcript(), OK_TEXT);
    }

    const name = nameFromClassUrl(r.url);
    if (name !== undefined) {
      const st = at(name);
      const isSrc = r.url.endsWith("/source/main");
      if (!isSrc && r.method === "GET" && !r.qs._action) {
        if (!st.exists) return resp(404, notFoundXml(name), OK_XML);
        return resp(
          200,
          classDocXml(name, { packageName: st.packageName, mainVersion: st.active ? "active" : "inactive" }),
          OK_XML,
        );
      }
      if (isSrc && r.method === "GET") {
        if (!st.exists || st.source === undefined) return resp(404, notFoundXml(name), OK_XML);
        return resp(200, st.source, OK_TEXT);
      }
      if (!isSrc && r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (!isSrc && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (isSrc && r.method === "PUT") {
        st.source = r.body ?? "";
        st.exists = true;
        st.active = false;
        return resp(200, "", OK_TEXT);
      }
    }
    return undefined;
  };
}

function frameLine(name: string, payload: unknown): string {
  return `ZMCP-H>${name} ${JSON.stringify(payload)}`;
}

function buildTranscript(opts: { id: string; ver: string; action: string; outs?: readonly unknown[] }): string {
  const lines: string[] = [];
  lines.push(frameLine("BEGIN", { id: opts.id, ver: opts.ver, action: opts.action, contract: "1.0" }));
  for (const v of opts.outs ?? [{}]) lines.push(frameLine("OUT", v));
  lines.push(frameLine("END", { rc: 0, outBytes: 0, truncated: false, ms: 1 }));
  return lines.join("\n") + "\n";
}

// --- config / gate / tool-set fixtures ---

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-fluid-tool-"));
  resetFluidEnsureState();
  resetFluidPackageMemo();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function cfg(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
    fluidApi: true,
    stateDir: tmp,
    ...overrides,
  });
}

const gate = (): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"] });

const RUN_ACTION: FluidActionSpec = {
  name: "run",
  category: "execute",
  description: "runs the demo action",
  input: { type: "object", properties: { note: { type: "string" } } },
  output: { type: "object" },
};

function makeTool(opts: { id: string; className: string; actions?: readonly FluidActionSpec[] }): LoadedFluidTool {
  const cls = opts.className.toLowerCase();
  const source = `CLASS ${cls} DEFINITION PUBLIC.\nENDCLASS.\nCLASS ${cls} IMPLEMENTATION.\nENDCLASS.`;
  const manifest: FluidManifest = {
    contract: "1.0",
    id: opts.id,
    title: `${opts.id} tool`,
    description: `test fixture for ${opts.id}`,
    objects: [{ name: opts.className, type: "CLAS/OC", description: "demo class", source: { text: source } }],
    entry: opts.className,
    actions: opts.actions ?? [RUN_ACTION],
  };
  const sources = new Map([[opts.className, source]]);
  return { manifest, origin: "builtin", sources, version: manifestVersion(manifest, sources) };
}

function toolSetOf(...tools: readonly LoadedFluidTool[]): FluidToolSet {
  return {
    tools: new Map(tools.map((t) => [t.manifest.id, t])),
    refused: [],
    warnings: [],
  };
}

// --- fakeMcp()/registered()/invoke() triad (test/bopf-show-partial-view-caveat.test.ts) ---

function fakeMcp(): { mcp: McpServer; tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }> } {
  const tools = new Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>();
  const mcp = {
    registerTool: (name: string, _config: unknown, handler: (args: unknown) => Promise<CallToolResult>) => {
      tools.set(name, { handler });
      return {} as unknown;
    },
  } as unknown as McpServer;
  return { mcp, tools };
}

/** Throws if a zero-network op ever reaches the pool or tries to connect. */
function boobyPool(): SessionPool {
  return {
    withRead: () => {
      throw new Error("NETWORK LEAKED: pool.withRead was called by a supposedly zero-network op");
    },
    withWrite: () => {
      throw new Error("NETWORK LEAKED: pool.withWrite was called by a supposedly zero-network op");
    },
    reserveDebug: () => {
      throw new Error("reserveDebug: not used by abap_fluid zero-network ops");
    },
  } as unknown as SessionPool;
}

const boobyEnsureConnected = async (): Promise<void> => {
  throw new Error("NETWORK LEAKED: ensureConnected was called by a supposedly zero-network op");
};

function registered(deps: Partial<FluidToolDeps> & Pick<FluidToolDeps, "toolSet">): Map<string, { handler: (args: unknown) => Promise<CallToolResult> }> {
  const { mcp, tools } = fakeMcp();
  const full: FluidToolDeps = {
    pool: deps.pool ?? boobyPool(),
    cfg: deps.cfg ?? cfg(),
    safety: deps.safety ?? gate(),
    ensureConnected: deps.ensureConnected ?? boobyEnsureConnected,
    errorResult,
    toolSet: deps.toolSet,
    ...(deps.journal ? { journal: deps.journal } : {}),
    ...(deps.warn ? { warn: deps.warn } : {}),
  };
  registerFluidTool(mcp, full);
  return tools;
}

async function invoke(
  tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>,
  args: unknown,
): Promise<CallToolResult> {
  const entry = tools.get("abap_fluid");
  if (!entry) throw new Error('"abap_fluid" was never registered');
  return entry.handler(args);
}

function okText(result: CallToolResult): string {
  expect(result.isError).toBeFalsy();
  const part = result.content[0];
  if (!part || part.type !== "text") throw new Error("expected a text content part");
  return part.text;
}

function errorPayload(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBe(true);
  const part = result.content[0];
  if (!part || part.type !== "text") throw new Error("expected a text content part");
  return JSON.parse(part.text) as Record<string, unknown>;
}

// ============================================================================
// 1. bare call — catalogue, zero HTTP, ends with a NEXT: line
// ============================================================================

describe("abap_fluid — bare call (no op/tool/action)", () => {
  it("returns the catalogue with loaded tool ids and a trailing NEXT: line, touching no network", async () => {
    const toolSet = toolSetOf(makeTool({ id: "demo", className: "ZCL_ZMCP_DEMO" }));
    const tools = registered({ toolSet });

    const text = okText(await invoke(tools, {}));

    expect(text).toContain("demo");
    const lines = text.split("\n").filter((l) => l.length > 0);
    expect(lines[lines.length - 1]).toMatch(/^NEXT:/);
  });

  it("names the disabled reason instead of the catalogue when the fluid flag is off, touching no network", async () => {
    const toolSet = toolSetOf(makeTool({ id: "demo", className: "ZCL_ZMCP_DEMO" }));
    const tools = registered({ toolSet, cfg: cfg({ fluidApi: false }) });

    const payload = errorPayload(await invoke(tools, {}));
    expect(payload.error).toBe("FLUID_API_DISABLED");
  });
});

// ============================================================================
// 2. list — zero HTTP
// ============================================================================

describe("abap_fluid — op: list", () => {
  it("lists every loaded tool with origin/version and action:category pairs, touching no network", async () => {
    const toolSet = toolSetOf(makeTool({ id: "demo", className: "ZCL_ZMCP_DEMO" }));
    const tools = registered({ toolSet });

    const text = okText(await invoke(tools, { op: "list" }));

    expect(text).toContain("demo");
    expect(text).toContain("builtin");
    expect(text).toContain("run:execute");
  });
});

// ============================================================================
// 3. describe — with and without `tool`
// ============================================================================

describe("abap_fluid — op: describe", () => {
  it("with `tool`: renders objects, entry, and per-action input/output schema, touching no network", async () => {
    const tool = makeTool({ id: "demo", className: "ZCL_ZMCP_DEMO" });
    const tools = registered({ toolSet: toolSetOf(tool) });

    const text = okText(await invoke(tools, { op: "describe", tool: "demo" }));

    expect(text).toContain("ZCL_ZMCP_DEMO");
    expect(text).toContain("[entry]");
    expect(text).toContain("run");
    expect(text).toContain('"note"');
  });

  it("without `tool`: refuses, naming `tool` as the missing field, touching no network", async () => {
    const tools = registered({ toolSet: toolSetOf(makeTool({ id: "demo", className: "ZCL_ZMCP_DEMO" })) });

    const payload = errorPayload(await invoke(tools, { op: "describe" }));

    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("tool");
  });
});

// ============================================================================
// 4. run — the default op, routed to dispatch() end-to-end
// ============================================================================

describe("abap_fluid — op: run (default)", () => {
  it("tool+action with no `op` defaults to run and actually dispatches the action", async () => {
    const tool = makeTool({ id: "demo", className: "ZCL_ZMCP_DEMO" });
    const route = dynamicFluidRoute({
      transcript: () => buildTranscript({ id: "demo", ver: tool.version, action: "run", outs: [{ note: "hi" }] }),
    });
    const { conn } = await connected(route);
    const pool: SessionPool = {
      withRead: (_op: string, fn: (c: AbapConnection) => Promise<unknown>) => fn(conn),
      withWrite: (op: string, _uri: string | undefined, fn: (c: AbapConnection) => Promise<unknown>) => {
        withWriteCalls.push(op);
        return fn(conn);
      },
      reserveDebug: () => {
        throw new Error("reserveDebug: not used by abap_fluid run");
      },
    } as unknown as SessionPool;
    const withWriteCalls: string[] = [];
    let ensureConnectedCalls = 0;
    const tools = registered({
      toolSet: toolSetOf(tool),
      pool,
      ensureConnected: async () => {
        ensureConnectedCalls += 1;
      },
    });

    const text = okText(await invoke(tools, { tool: "demo", action: "run", args: {} }));

    expect(ensureConnectedCalls).toBe(1);
    expect(withWriteCalls).toContain("abap_fluid.run");
    expect(text).toContain('"note": "hi"');
  });
});

// ============================================================================
// 5. remove without confirm — refuses zero-HTTP, naming confirm:"remove"
// ============================================================================

describe("abap_fluid — op: remove", () => {
  it('without confirm: refuses, naming confirm:"remove" as required, touching no network', async () => {
    const tools = registered({ toolSet: toolSetOf(makeTool({ id: "demo", className: "ZCL_ZMCP_DEMO" })) });

    const payload = errorPayload(await invoke(tools, { op: "remove", tool: "demo" }));

    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain('confirm: "remove"');
  });

  it('a wrong confirm string is refused the same way, touching no network', async () => {
    const tools = registered({ toolSet: toolSetOf(makeTool({ id: "demo", className: "ZCL_ZMCP_DEMO" })) });

    const payload = errorPayload(await invoke(tools, { op: "remove", tool: "demo", confirm: "yes" }));

    expect(payload.error).toBe("BAD_INPUT");
  });
});

// ============================================================================
// 6. run with tool but no action — refuses, naming `action`
// ============================================================================

describe("abap_fluid — op: run input validation", () => {
  it("tool without action refuses, naming `action` as the missing field, touching no network", async () => {
    const tools = registered({ toolSet: toolSetOf(makeTool({ id: "demo", className: "ZCL_ZMCP_DEMO" })) });

    const payload = errorPayload(await invoke(tools, { op: "run", tool: "demo" }));

    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("action");
  });

  it("action without tool refuses, naming `tool` as the missing field, touching no network", async () => {
    const tools = registered({ toolSet: toolSetOf(makeTool({ id: "demo", className: "ZCL_ZMCP_DEMO" })) });

    const payload = errorPayload(await invoke(tools, { action: "run" }));

    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("tool");
  });
});

// ============================================================================
// 7. registration gating — canUseFluidApi, flag-off vs writable+flag-on
// ============================================================================

/** A transport that must never be reached — `tools/list` costs zero requests. */
class ForbiddenClient implements Partial<HttpClient> {
  request(_o: HttpClientOptions): Promise<HttpClientResponse> {
    throw new Error("NETWORK CALL LEAKED: listing tools must not touch the wire");
  }
}

async function toolNames(config: Config): Promise<Set<string>> {
  const srv: AbapsmithServer = createServer(config, {
    httpClient: routeSystemRoleProbe(new ForbiddenClient() as unknown as HttpClient, { answer: "nonproductive" }),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return new Set(tools.map((t) => t.name));
}

describe("abap_fluid — registration gating (server.ts, toolCapabilities.canUseFluidApi)", () => {
  it("is ABSENT from tools/list on a read-only server, even with the flag on (its default)", async () => {
    const names = await toolNames(
      ConfigSchema.parse({
        url: "http://sap.invalid:50000",
        user: "U",
        password: "p",
        sid: "A4H",
        client: "001",
        // readOnly defaults to true — deliberately not overridden here.
      }),
    );
    expect(names.has("abap_fluid")).toBe(false);
  });

  it("is ABSENT from tools/list on a writable server once ABAP_FLUID_API is explicitly off", async () => {
    const names = await toolNames(
      ConfigSchema.parse({
        url: "http://sap.invalid:50000",
        user: "U",
        password: "p",
        sid: "A4H",
        client: "001",
        readOnly: false,
        allowPackages: ["*"],
        fluidApi: false,
      }),
    );
    expect(names.has("abap_write")).toBe(true);
    expect(names.has("abap_fluid")).toBe(false);
  });

  it("IS present on a writable server with the flag on (the default)", async () => {
    const names = await toolNames(
      ConfigSchema.parse({
        url: "http://sap.invalid:50000",
        user: "U",
        password: "p",
        sid: "A4H",
        client: "001",
        readOnly: false,
        allowPackages: ["*"],
      }),
    );
    expect(names.has("abap_fluid")).toBe(true);
  });
});

// ============================================================================
// 8. response budget clamping — small maxResponseChars
// ============================================================================

describe("abap_fluid — response budget clamping", () => {
  it("op: list clamps to a small maxResponseChars via buildResponse's own truncation notice, not a hand-rolled cut", async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      makeTool({
        id: `demo${i}`,
        className: `ZCL_ZMCP_DEMO${i}`,
        actions: [RUN_ACTION, { ...RUN_ACTION, name: "other", description: "a second action, for width" }],
      }),
    );
    const tools = registered({ toolSet: toolSetOf(...many), cfg: cfg({ maxResponseChars: 400 }) });

    const text = okText(await invoke(tools, { op: "list" }));

    expect(text.length).toBeLessThanOrEqual(400 + 600); // notice itself costs some room; not an unbounded blob
    expect(text).toMatch(/capped at 400 chars/);
  });
});
