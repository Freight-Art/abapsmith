/**
 * Dispatch-level tests for `abap_search mode="source"` (src/tools/search.ts's
 * `registerSearchTools`) — the MCP tool layer over `runSourceScan`
 * (src/adt/source-scan.ts), which itself runs through `dispatch()` against
 * the static fluid `scan` tool body (`ZCL_ZMCP_FLUID_SCAN`).
 *
 * Modeled directly on test/fpm-tools.test.ts's harness shape: a minimal
 * `registerTool`-capturing fake `McpServer`, a one-line passthrough
 * `SessionPool`, a real `SafetyGate`, and the real `errorResult` from
 * `src/server.ts`, wired to a `RecordingClient` implementing `HttpClient`
 * directly, composed with `test/helpers/fluid-scan-fake.ts`'s
 * `scanFluidRoute` for the deploy/activate/classrun mechanics.
 *
 * Kept separate from test/search-source-mode.test.ts (which covers the pure,
 * network-free `buildSourceScanQuery`/`buildSourceResponse`/`scanDispatchArgs`
 * builders) because everything here needs a live `AbapConnection` wired to a
 * fake server.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type HttpClient,
  type HttpClientOptions,
  type HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import type { SessionPool } from "../src/adt/pool.js";
import { errorResult } from "../src/server.js";
import { resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { manifestVersion } from "../src/adt/fluid/manifest.js";
import { scanManifest, scanSources } from "../src/adt/fluid/builtin/scan.js";
import { registerSearchTools, type SearchToolDeps } from "../src/tools/search.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { scanFluidRoute, scanTranscript, scanErrTranscript } from "./helpers/fluid-scan-fake.js";

/** `scan`'s deployed manifest version, so canned transcripts claim the real one dispatch() checks against. */
const SCAN_VER = manifestVersion(scanManifest, scanSources);

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-search-source-dispatch-"));
  resetFluidEnsureState();
  resetFluidPackageMemo();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const cfg = (overrides: Partial<Config> = {}): Config => {
  const { abapMode, ...rest } = overrides;
  const base = ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
    readOnly: false,
    fluidApi: true,
    stateDir: tmp,
    ...rest,
  });
  return abapMode !== undefined ? { ...base, abapMode } : base;
};

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
  statusText = String(status),
): HttpClientResponse => ({ status, statusText, body, headers }) as unknown as HttpClientResponse;

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

const SESSION_URL = "/sap/bc/adt/compatibility/graph";

async function connected(
  route: (o: HttpClientOptions) => HttpClientResponse,
  connCfg: Config,
): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const inner = new RecordingClient(route);
  const conn = new AbapConnection(connCfg, { httpClient: inner, log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  inner.calls.length = 0;
  return { conn, inner };
}

/** Non-scan-specific parts of the wire: login/session, discovery, ato settings, the §10.4 role probe. */
function scanBaseRoute(o: HttpClientOptions): HttpClientResponse | undefined {
  if (o.url.includes(SESSION_URL)) {
    return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
  }
  if (o.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
  if (o.url.endsWith("/discovery")) return resp(200, "<service/>", { "content-type": "application/xml" });
  return undefined;
}

async function connectedFluid(opts: {
  transcript: () => string;
  cfg?: Config;
}): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const { route: fluidRoute } = scanFluidRoute(opts);
  const route = (o: HttpClientOptions): HttpClientResponse => {
    const viaBase = scanBaseRoute(o);
    if (viaBase) return viaBase;
    const viaFluid = fluidRoute(o);
    if (viaFluid) return viaFluid;
    throw new Error(`connectedFluid: unrouted request ${(o.method ?? "GET").toUpperCase()} ${o.url}`);
  };
  return connected(route, opts.cfg ?? cfg());
}

const openGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP", "$ABAPSMITH_FLUID_API"],
    allowNamePrefixes: ["*"],
    writesLockedOut: false,
  });

/** A `SessionPool` that just forwards straight onto one wired connection — this repo has no reusable fake pool. */
function fakePool(conn: AbapConnection): SessionPool {
  return {
    withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    withWrite: <T,>(_op: string, _objectUri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    reserveDebug: () => {
      throw new Error("reserveDebug: not used by abap_search, and not implemented in this fake.");
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

function depsFor(conn: AbapConnection, opts: { safety?: SafetyGate; cfg?: Config } = {}): SearchToolDeps {
  return {
    pool: fakePool(conn),
    safety: opts.safety ?? openGate(),
    ensureConnected: async () => {},
    errorResult,
    cfg: opts.cfg ?? cfg(),
  };
}

async function registered(
  conn: AbapConnection,
  opts: { safety?: SafetyGate; cfg?: Config } = {},
): Promise<{
  tools: Map<string, { config: Record<string, unknown>; handler: (args: unknown) => Promise<CallToolResult> }>;
  deps: SearchToolDeps;
}> {
  const { mcp, tools } = fakeMcp();
  const deps = depsFor(conn, opts);
  registerSearchTools(mcp, deps);
  return { tools, deps };
}

describe("abap_search mode=source — dispatch happy path", () => {
  it("a successful scan renders its hits in the response text", async () => {
    const outs = [
      { kind: "hit", obj_type: "PROG", obj_name: "ZFOO", include: "ZFOO", line: 12, text: "DATA: lv_foo TYPE string." },
      {
        kind: "summary",
        objects_total: 1,
        objects_scanned: 1,
        includes_scanned: 1,
        includes_skipped: 0,
        hits: 1,
        truncated: "",
      },
    ];
    const { conn } = await connectedFluid({
      transcript: () => scanTranscript({ ver: SCAN_VER, outs }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_search", {
      mode: "source",
      query: "lv_foo",
      packages: ["ZTEST"],
    });
    const text = okText(result);

    expect(text).toContain("mode: source");
    expect(text).toContain("ZFOO");
    expect(text).toContain("DATA: lv_foo TYPE string.");
  });

  it("propagates a scan-side failure (ERR frame) as a tool error", async () => {
    const { conn } = await connectedFluid({
      transcript: () =>
        scanErrTranscript({ ver: SCAN_VER, kind: "exception", step: "scan", text: "CX_SY_ITAB_LINE_NOT_FOUND" }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_search", {
      mode: "source",
      query: "lv_foo",
      packages: ["ZTEST"],
    });

    expect(result.isError).toBe(true);
  });
});

describe("abap_search mode=source — FLUID_API_DISABLED refusal", () => {
  it("refuses with FLUID_API_DISABLED when the fluid API flag is off, and names how to enable it", async () => {
    const { conn } = await connectedFluid({
      transcript: () => scanTranscript({ ver: SCAN_VER, outs: [] }),
      cfg: cfg({ fluidApi: false }),
    });
    const { tools } = await registered(conn, { cfg: cfg({ fluidApi: false }) });

    const result = await invoke(tools, "abap_search", {
      mode: "source",
      query: "lv_foo",
      packages: ["ZTEST"],
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("FLUID_API_DISABLED");
    expect(JSON.stringify(payload)).toContain("ABAP_FLUID_API");
  });

  it('refuses with FLUID_API_DISABLED when the connection is read-only (ABAP_MODE=read), and names how to enable it', async () => {
    const { conn } = await connectedFluid({
      transcript: () => scanTranscript({ ver: SCAN_VER, outs: [] }),
      cfg: cfg({ abapMode: "read" }),
    });
    const { tools } = await registered(conn, { cfg: cfg({ abapMode: "read" }) });

    const result = await invoke(tools, "abap_search", {
      mode: "source",
      query: "lv_foo",
      packages: ["ZTEST"],
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("FLUID_API_DISABLED");
    // The read-only refusal message points at write access / ABAP_MODE, not the flag.
    expect(JSON.stringify(payload)).toMatch(/ABAP_MODE|read-only|write access/i);
  });
});
