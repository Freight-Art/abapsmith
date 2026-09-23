/** `package`, `corr_nr` and `activate` on the abap_enh create-family operations (#215). */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequest, TrRequirement } from "../src/adt/transports.js";
import type { SessionPool } from "../src/adt/pool.js";
import { errorResult } from "../src/server.js";
import { registerEnhancementTools, type EnhToolDeps } from "../src/tools/enh.js";
import { Journal } from "../src/journal.js";
import { invokerName } from "../src/adt/fluid/invoke.js";
import { enhManifest } from "../src/adt/fluid/builtin/enh.js";
import { ENH_BRIDGE_PACKAGE, ENH_CREATE_PACKAGE } from "../src/adt/enhancement-bridge.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { dynamicEnhFluidRoute, enhProbeConsole } from "./helpers/fluid-enh-fake.js";

// ---------------------------------------------------------------------------
// ADT-layer harness — trimmed copy of test/enhancement-tools.test.ts's own.
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement");
const DISCOVERY_ENHANCEMENTS_XML = readFileSync(join(FIXTURES_DIR, "discovery-enhancements.xml"), "utf8");

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse => ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

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
  get labels(): string[] {
    return this.calls.map((c) => c.label);
  }
}

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

const FLUID_PKG_URI = "/sap/bc/adt/packages/%24abapsmith_fluid_api";

const FLUID_PACKAGE_XML =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<pak:package xmlns:pak="http://www.sap.com/adt/packages" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${ENH_BRIDGE_PACKAGE}" adtcore:type="DEVC/K">` +
  `<adtcore:packageRef adtcore:name="${ENH_BRIDGE_PACKAGE}" adtcore:type="DEVC/K"/>` +
  `<pak:superPackage/>` +
  `</pak:package>`;

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, DISCOVERY_ENHANCEMENTS_XML, OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  if (r.url === FLUID_PKG_URI && r.method === "GET" && !r.qs._action) return resp(200, FLUID_PACKAGE_XML, OK_XML);
  return undefined;
}

async function connected(route: Route, config: Config = cfg()): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(config, { httpClient: adt, log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

const gate = (extra: Partial<ConstructorParameters<typeof SafetyGate>[0]> = {}): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: [ENH_CREATE_PACKAGE, ENH_BRIDGE_PACKAGE],
    allowNamePrefixes: ["*"],
    allowEnhancements: true,
    enhanceTargets: "customer",
    originSystems: ["A4H"],
    ...extra,
  });

const AFFECTS_SPOT = { name: "ZMCP_SPOT", packageName: "$TMP", spotName: "ZMCP_SPOT" };
const AFFECTS_HOOK = { name: "ZMCP_BADI_HOST", packageName: "$TMP" };

// ---------------------------------------------------------------------------
// MCP-tool-layer harness — trimmed copy of test/enhancement-tools.test.ts's own.
// ---------------------------------------------------------------------------

function fakePool(conn: AbapConnection): SessionPool {
  return {
    withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    withWrite: <T,>(_op: string, _objectUri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    reserveDebug: () => {
      throw new Error("reserveDebug: not used by abap_enh, and not implemented in this fake.");
    },
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

function errorPayload(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBe(true);
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return JSON.parse(text.text) as Record<string, unknown>;
}

function okText(result: CallToolResult): string {
  expect(result.isError).toBeFalsy();
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return text.text;
}

/** Local package only — every object in these tests defaults to $TMP unless a test says otherwise. */
function localTransport(): SessionTransport {
  const trRequirement = async (_conn: AbapConnection, uri: string, devclass?: string): Promise<TrRequirement> => ({
    kind: "local",
    mustSupplyCorrNr: false,
    serverWouldFabricate: false,
    uri,
    operation: "U",
    devclass,
    candidates: [],
    locks: [],
    messages: [],
    checkFailed: false,
    raw: { result: "S", korrflag: "", recording: "" },
  });
  return new SessionTransport({ allowTransports: ["*"], cts: { trRequirement } });
}

function depsFor(
  conn: AbapConnection,
  opts: { safety?: SafetyGate; transport?: SessionTransport; journal?: Journal } = {},
): EnhToolDeps {
  return {
    pool: fakePool(conn),
    safety: opts.safety ?? gate(),
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: 30_000, allowEnhancements: true, allowSourcePlugins: true, allowEnhancementDelete: true, user: "DEVELOPER" },
    transport: opts.transport ?? localTransport(),
    journal: opts.journal ?? new Journal({ dir: "", enabled: false, maxEntries: 200, maxAgeDays: 30 }, "A4H"),
  };
}

async function registered(
  conn: AbapConnection,
  opts: { safety?: SafetyGate; transport?: SessionTransport; journal?: Journal } = {},
): Promise<{ tools: Map<string, { config: Record<string, unknown>; handler: (args: unknown) => Promise<CallToolResult> }> }> {
  const { mcp, tools } = fakeMcp();
  registerEnhancementTools(mcp, depsFor(conn, opts));
  return { tools };
}

async function withJournal(fn: (j: Journal) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "abapsmith-enh-pkgtx-"));
  try {
    await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Fluid-bridge routes plus the /activation fallback for the post-op activateObject call.

function createSpotBridgeRoute(created: boolean): Route {
  const route = dynamicEnhFluidRoute({
    transcript: () => enhProbeConsole("create_spot", { created }),
    packageName: ENH_BRIDGE_PACKAGE,
  });
  return (r: Recorded) => {
    const hit = route(r as unknown as HttpClientOptions);
    if (hit) return hit;
    if (r.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
    return undefined;
  };
}

function createImplBridgeRoute(): Route {
  const route = dynamicEnhFluidRoute({
    transcript: () => enhProbeConsole("create_impl", { created: true, impl_added: true, filter_check: "no_filters" }),
    packageName: ENH_BRIDGE_PACKAGE,
  });
  return (r: Recorded) => {
    const hit = route(r as unknown as HttpClientOptions);
    if (hit) return hit;
    if (r.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
    return undefined;
  };
}

/** Invoker class name dispatch() computes for this (action, args) pair; a POST creating it proves the exact args. */
function expectedInvokerName(action: string, args: Record<string, unknown>): string {
  return invokerName(enhManifest.id, action, args, enhManifest.contract);
}

/** True when an activation POST named `objectName` (the fluid deploy activates its own invoker class, which does not count). */
function activationNaming(adt: FakeAdt, objectName: string): boolean {
  return adt.calls.some(
    (c) => c.method === "POST" && c.url.includes("/sap/bc/adt/activation") && String(c.body).toLowerCase().includes(objectName),
  );
}

function createdInvoker(adt: FakeAdt, name: string): boolean {
  return adt.calls.some(
    (c) => c.method === "POST" && c.url === "/sap/bc/adt/oo/classes" && String(c.body).includes(`adtcore:name="${name}"`),
  );
}

const CREATE_IMPL_SPEC = {
  spotName: "ZMCP_SPOT",
  badiName: "ZMCP_BADI",
  implName: "ZMCP_IMPL",
  implClass: "ZCL_MCP_IMPL",
  active: true,
  description: "An implementation",
};

// ===========================================================================
// #215 — package, corr_nr and activate on the create-family operations
// ===========================================================================

describe("abap_enh — package, corr_nr and activate on the create-family operations (#215)", () => {
  it("$TMP is the default: create_spot dispatches package_name $TMP, corr_nr '' and activate true", async () => {
    const { conn, adt } = await connected(createSpotBridgeRoute(true));
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "create_spot",
      name: "ZMCP_SPOT",
      spec: { description: "A spot" },
      affects: AFFECTS_SPOT,
    });

    const text = okText(result);
    expect(text).toContain("$TMP");
    const args = { spot_name: "ZMCP_SPOT", description: "A spot", package_name: "$TMP", corr_nr: "", activate: true };
    expect(createdInvoker(adt, expectedInvokerName("create_spot", args))).toBe(true);
  });

  it("package propagates into the create payload and the journal: create_spot package ZMCP_PKG with a transportable package gets the session-resolved request", async () => {
    const PKG = "ZMCP_PKG";
    const CREATED = "A4HK900123";
    const trCreate = vi.fn(async () => ({ trkorr: CREATED, path: `/com.sap.cts/object_record/${CREATED}` }));
    const trRequirement = vi.fn(async (_conn: unknown, uri: string, devclass: string) => ({
      uri,
      operation: "I",
      devclass,
      candidates: [],
      locks: [],
      messages: [],
      checkFailed: false,
      raw: { result: "S", korrflag: "X", recording: "" },
      kind: "transport-required",
      mustSupplyCorrNr: true,
      serverWouldFabricate: false,
    }));
    const g = gate({ allowPackages: [PKG, ENH_CREATE_PACKAGE, ENH_BRIDGE_PACKAGE], allowTransports: ["auto"] });
    const transport = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate: () => g.authorize("transport", { name: PKG, packageName: PKG }, { corr: { kind: "unresolved" } }),
      whoami: () => "DEVELOPER",
      cts: { trCreate, trRequirement } as never,
    });

    await withJournal(async (journal) => {
      const { conn, adt } = await connected(createSpotBridgeRoute(true));
      const { tools } = await registered(conn, { safety: g, transport, journal });

      const result = await invoke(tools, "abap_enh", {
        operation: "create_spot",
        name: "ZMCP_SPOT",
        package: PKG,
        spec: { description: "A spot" },
        affects: { name: "ZMCP_SPOT", packageName: PKG, spotName: "ZMCP_SPOT" },
      });

      const text = okText(result);
      expect(trCreate).toHaveBeenCalledTimes(1);
      expect(text).toContain(PKG);
      expect(text).toContain(CREATED);
      const args = { spot_name: "ZMCP_SPOT", description: "A spot", package_name: PKG, corr_nr: CREATED, activate: true };
      expect(createdInvoker(adt, expectedInvokerName("create_spot", args))).toBe(true);

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.object.package).toBe(PKG);
    });
  });

  it("a caller-named corr_nr on a transportable package is used as named and creates no request", async () => {
    const PKG = "ZMCP_PKG";
    const NAMED = "A4HK900777";
    const trCreate = vi.fn(async () => ({ trkorr: "SHOULD-NOT-BE-CALLED", path: "" }));
    const trRequirement = vi.fn(async (_conn: unknown, uri: string, devclass: string) => ({
      uri,
      operation: "I",
      devclass,
      candidates: [],
      locks: [],
      messages: [],
      checkFailed: false,
      raw: { result: "S", korrflag: "X", recording: "" },
      kind: "transport-required",
      mustSupplyCorrNr: true,
      serverWouldFabricate: false,
    }));
    const trShow = vi.fn(
      async (_conn: AbapConnection, trkorr: string): Promise<TrRequest> => ({
        trkorr,
        kind: "workbench",
        kindRaw: "K",
        status: "modifiable",
        statusRaw: "D",
        owner: "DEVELOPER",
        description: "the caller's own request",
        tasks: [],
        objects: [],
      }),
    );
    const g = gate({ allowPackages: [PKG, ENH_CREATE_PACKAGE, ENH_BRIDGE_PACKAGE], allowTransports: [NAMED] });
    const transport = new SessionTransport({
      allowTransports: [NAMED],
      authorizeCreate: () => g.authorize("transport", { name: PKG, packageName: PKG }, { corr: { kind: "unresolved" } }),
      whoami: () => "DEVELOPER",
      cts: { trCreate, trRequirement, trShow } as never,
    });

    const { conn, adt } = await connected(createSpotBridgeRoute(true));
    const { tools } = await registered(conn, { safety: g, transport });

    const result = await invoke(tools, "abap_enh", {
      operation: "create_spot",
      name: "ZMCP_SPOT",
      package: PKG,
      corr_nr: NAMED,
      spec: { description: "A spot" },
      affects: { name: "ZMCP_SPOT", packageName: PKG, spotName: "ZMCP_SPOT" },
    });

    const text = okText(result);
    expect(trCreate).not.toHaveBeenCalled();
    expect(trShow).toHaveBeenCalledWith(expect.anything(), NAMED);
    expect(text).toContain(NAMED);
    expect(text).toMatch(/named by the caller/i);
    const args = { spot_name: "ZMCP_SPOT", description: "A spot", package_name: PKG, corr_nr: NAMED, activate: true };
    expect(createdInvoker(adt, expectedInvokerName("create_spot", args))).toBe(true);
  });

  it("deny-all transports refuse a transportable package before any wire request", async () => {
    const PKG = "ZMCP_PKG";
    const g = gate({ allowPackages: [PKG, ENH_CREATE_PACKAGE, ENH_BRIDGE_PACKAGE], allowTransports: [] });
    const { conn, adt } = await connected(() => undefined);
    const { tools } = await registered(conn, { safety: g });

    const result = await invoke(tools, "abap_enh", {
      operation: "create_spot",
      name: "ZMCP_SPOT",
      package: PKG,
      spec: { description: "A spot" },
      affects: { name: "ZMCP_SPOT", packageName: PKG, spotName: "ZMCP_SPOT" },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("SAFETY_DENIED");
    expect(String(payload.message)).toContain("ABAP_ALLOW_TRANSPORTS is explicitly empty");
    expect(adt.calls).toHaveLength(0);
  });

  it("corr_nr with a local package is refused BAD_INPUT at zero wire cost", async () => {
    const { conn, adt } = await connected(() => undefined);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "create_spot",
      name: "ZMCP_SPOT",
      corr_nr: "A4HK900001", // package omitted -> defaults to $TMP, local
      spec: { description: "A spot" },
      affects: AFFECTS_SPOT,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("is local");
    expect(String(payload.message)).toContain("does not apply");
    expect(adt.calls).toHaveLength(0);
  });

  it("package on an operation that does not take it is refused BAD_INPUT at zero wire cost", async () => {
    const { conn, adt } = await connected(() => undefined);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "write_description",
      type: "ENHO/XHH",
      name: "ZMCP_ENH_B",
      description: "A new description",
      package: "ZMCP_PKG", // write_description is not one of the five fluid ops
      affects: AFFECTS_HOOK,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("package");
    expect(String(payload.message)).toContain("create_spot");
    expect(String(payload.message)).toContain("add_badi_def");
    expect(String(payload.message)).toContain("add_filter_def");
    expect(String(payload.message)).toContain("create_impl");
    expect(String(payload.message)).toContain("set_filter_values");
    expect(adt.calls).toHaveLength(0);
  });

  it("activate:false skips the activation call and reports the object inactive", async () => {
    const { conn, adt } = await connected(createSpotBridgeRoute(true));
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "create_spot",
      name: "ZMCP_SPOT",
      activate: false,
      spec: { description: "A spot" },
      affects: AFFECTS_SPOT,
    });

    const text = okText(result);
    expect(text).toContain("Created inactive (activate:false)");
    expect(text).toContain(`abap_read(object:"ZMCP_SPOT", type:"ENHS/XS", enhancements:true)`);
    expect(text).toContain(`abap_activate(object:"ZMCP_SPOT", type:"ENHS/XS", affects:${JSON.stringify(AFFECTS_SPOT)})`);
    expect(activationNaming(adt, "zmcp_spot")).toBe(false);
    const args = { spot_name: "ZMCP_SPOT", description: "A spot", package_name: "$TMP", corr_nr: "", activate: false };
    expect(createdInvoker(adt, expectedInvokerName("create_spot", args))).toBe(true);
  });

  it("create_impl activate:false leaves the implementation inactive", async () => {
    const { conn, adt } = await connected(createImplBridgeRoute());
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_enh", {
      operation: "create_impl",
      name: "ZMCP_ENH_BADI",
      activate: false,
      spec: CREATE_IMPL_SPEC,
      affects: AFFECTS_SPOT,
    });

    const text = okText(result);
    expect(text).toContain("Created inactive (activate:false)");
    expect(activationNaming(adt, "zmcp_enh_badi")).toBe(false);
    const args = {
      enh_name: "ZMCP_ENH_BADI",
      spot_name: "ZMCP_SPOT",
      badi_name: "ZMCP_BADI",
      impl_name: "ZMCP_IMPL",
      impl_class: "ZCL_MCP_IMPL",
      active: true,
      description: "An implementation",
      package_name: "$TMP",
      corr_nr: "",
      activate: false,
    };
    expect(createdInvoker(adt, expectedInvokerName("create_impl", args))).toBe(true);
  });
});
