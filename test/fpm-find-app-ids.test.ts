/**
 * Tests for issue #155 — `abap_fpm_read`'s find-vs-app id mismatch:
 *
 *  - mode=find rows gain `loadable`/`app_config_id`/`component_config_id`/
 *    `reason` fields, rendered as new table columns (or hoisted into the
 *    compact `allRows:` header line when constant across all rows).
 *  - mode=app, when the bridge reports the requested `config_id` does not
 *    exist (a `load_configuration` failure frame), dispatches a new `resolve`
 *    bridge action and, when the id turns out to be a component configuration
 *    referenced by exactly one application configuration, retries `app` with
 *    that application configuration id — surfacing both ids in the header and
 *    a NOTE explaining what happened. Every other outcome of that resolve
 *    step (no candidates, several candidates, unknown id, resolve itself
 *    failing) is a `NOT_FOUND` `AbapError` (or, when resolve doesn't apply,
 *    the original `FLUID_ACTION_FAILED` is left untouched).
 *
 * Self-contained per this repo's per-file offline harness convention (see
 * test/fpm-tools.test.ts's own header) — the harness below is a trimmed copy
 * of test/fpm-tools.test.ts's (RecordingClient, connectedFluid, fakeMcp,
 * invoke, errorPayload, okText, tableHeader, openGate/closedGate, appNode),
 * plus a local `queuedTranscript` helper this file needs that the shared
 * fake (test/helpers/fluid-fpm-fake.ts) does not provide: a transcript
 * function that returns a DIFFERENT canned transcript on each successive
 * classrun POST, for the multi-dispatch (app fails -> resolve -> app retry)
 * scenarios in mode=app.
 *
 * NOTE: written against the #155 spec ahead of (concurrently with) the
 * src/ implementation — see the task brief for the exact field/response
 * shapes asserted below.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import type { SessionPool } from "../src/adt/pool.js";
import { errorResult } from "../src/server.js";
import { resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { manifestVersion } from "../src/adt/fluid/manifest.js";
import { fpmManifest, fpmSources } from "../src/adt/fluid/builtin/fpm.js";
import { registerFpmTools, type FpmToolDeps } from "../src/tools/fpm.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { fpmFluidRoute, fpmTranscript, fpmErrTranscript } from "./helpers/fluid-fpm-fake.js";

/** `fpm`'s deployed manifest version, so canned transcripts claim the real one dispatch() checks against. */
const FPM_VER = manifestVersion(fpmManifest, fpmSources);

/** Same base as helpers/fluid-fpm-fake.ts's own (non-exported) `CLASSRUN_BASE`. */
const CLASSRUN_BASE = "/sap/bc/adt/oo/classrun/";

// ----------------------------------------------------------------------- harness ---
// Trimmed copy of test/fpm-tools.test.ts's harness — see that file's header for the
// rationale (self-contained per-file harnesses, not shared across test files).

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-fpm-find-app-ids-"));
  resetFluidEnsureState();
  resetFluidPackageMemo();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
    readOnly: false,
    fluidApi: true,
    stateDir: tmp,
  });

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
): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const inner = new RecordingClient(route);
  const conn = new AbapConnection(cfg(), { httpClient: inner, log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  inner.calls.length = 0;
  return { conn, inner };
}

/** Non-fpm-specific parts of the wire: login/session, discovery, ato settings, the §10.4 role probe. */
function fpmBaseRoute(o: HttpClientOptions): HttpClientResponse | undefined {
  if (o.url.includes(SESSION_URL)) {
    return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
  }
  if (o.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
  if (o.url.endsWith("/discovery")) return resp(200, "<service/>", { "content-type": "application/xml" });
  return undefined;
}

/** Same composition as test/fpm-tools.test.ts's own `connectedFluid`. */
async function connectedFluid(opts: {
  transcript: () => string;
}): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const { route: fluidRoute } = fpmFluidRoute(opts);
  const route = (o: HttpClientOptions): HttpClientResponse => {
    const viaBase = fpmBaseRoute(o);
    if (viaBase) return viaBase;
    const viaFluid = fluidRoute(o);
    if (viaFluid) return viaFluid;
    throw new Error(`connectedFluid: unrouted request ${(o.method ?? "GET").toUpperCase()} ${o.url}`);
  };
  return connected(route);
}

/**
 * A transcript function that hands out a DIFFERENT canned transcript on each
 * successive classrun POST (dispatch() call) — for the app-fails / resolve /
 * app-retries multi-dispatch scenarios `connectedFluid`'s single-transcript
 * callback can't express. Throws if called more times than transcripts were
 * queued, to catch an unexpectedly-extra dispatch.
 */
function queuedTranscript(transcripts: readonly string[]): () => string {
  const queue = [...transcripts];
  return () => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("queuedTranscript: exhausted — more classrun POSTs happened than transcripts were queued");
    }
    return next;
  };
}

/** classrun POSTs among a RecordingClient's captured calls (one per dispatch() invocation). */
function classrunCalls(calls: readonly HttpClientOptions[]): HttpClientOptions[] {
  return calls.filter((c) => c.url.startsWith(CLASSRUN_BASE));
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
      throw new Error("reserveDebug: not used by abap_fpm_read, and not implemented in this fake.");
    },
  } as unknown as SessionPool;
}

/** Captures `registerTool` calls into a `Map<name, {config, handler}>` instead of talking to a real MCP client. */
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

function depsFor(conn: AbapConnection, opts: { safety?: SafetyGate; maxResponseChars?: number } = {}): FpmToolDeps {
  return {
    pool: fakePool(conn),
    safety: opts.safety ?? openGate(),
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: opts.maxResponseChars ?? 30_000 },
  };
}

async function registered(
  conn: AbapConnection,
  opts: { safety?: SafetyGate; maxResponseChars?: number } = {},
): Promise<{
  tools: Map<string, { config: Record<string, unknown>; handler: (args: unknown) => Promise<CallToolResult> }>;
  deps: FpmToolDeps;
}> {
  const { mcp, tools } = fakeMcp();
  const deps = depsFor(conn, opts);
  registerFpmTools(mcp, deps);
  return { tools, deps };
}

/** Column names of the header row of a `textTable`-rendered `--- <label> ---` section. */
function tableHeader(text: string, label: string): string[] {
  const marker = `--- ${label} ---\n`;
  const idx = text.indexOf(marker);
  if (idx === -1) throw new Error(`section "${label}" not found in:\n${text}`);
  const headerLine = text.slice(idx + marker.length).split("\n")[0] ?? "";
  return headerLine.trim().split(/\s{2,}/);
}

/** The table (or allRows-hoisted) line mentioning `marker` — used to check per-row cell values precisely. */
function rowLine(text: string, marker: string): string {
  const line = text.split("\n").find((l) => l.includes(marker));
  if (!line) throw new Error(`no line containing "${marker}" found in:\n${text}`);
  return line;
}

// ------------------------------------------------------------------------ fixtures ---

/** A #155 find row: the six original fields plus the four new optional ones. */
function findRow(opts: {
  configId: string;
  configType: string;
  configVar?: string;
  component: string;
  description: string;
  devclass?: string;
  loadable?: boolean;
  appConfigId?: string;
  componentConfigId?: string;
  reason?: string;
}): Record<string, unknown> {
  return {
    config_id: opts.configId,
    config_type: opts.configType,
    config_var: opts.configVar ?? "",
    component: opts.component,
    description: opts.description,
    devclass: opts.devclass ?? "",
    ...(opts.loadable !== undefined ? { loadable: opts.loadable } : {}),
    ...(opts.appConfigId !== undefined ? { app_config_id: opts.appConfigId } : {}),
    ...(opts.componentConfigId !== undefined ? { component_config_id: opts.componentConfigId } : {}),
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
  };
}

/** A #155 `resolve` bridge-action output object (one JSON object line, per the spec). */
function resolveOut(opts: {
  configId: string;
  existsAsApp?: boolean;
  existsAsComponent?: boolean;
  component?: string;
  componentConfigVar?: string;
  applicationConfigs?: { configId: string; application: string; configVar?: string }[];
  truncated?: boolean;
}): Record<string, unknown> {
  return {
    config_id: opts.configId,
    exists_as_app: opts.existsAsApp ?? false,
    exists_as_component: opts.existsAsComponent ?? false,
    component: opts.component ?? "",
    component_config_var: opts.componentConfigVar ?? "",
    application_configs: (opts.applicationConfigs ?? []).map((a) => ({
      config_id: a.configId,
      application: a.application,
      config_var: a.configVar ?? "",
    })),
    truncated: opts.truncated ?? false,
  };
}

/** A `mode=app` `load_configuration` failure transcript — the trigger for the #155 resolve-retry flow. */
function loadFailedTranscript(configId: string): string {
  return fpmErrTranscript({
    ver: FPM_VER,
    action: "app",
    kind: "exception",
    step: "load_configuration",
    text: `Configuration ${configId} does not exist`,
  });
}

/** An `app` node fixture, trimmed to what these tests need (all `FpmAppNodeResult`-required fields present). */
function appNode(opts: {
  nodePath: string;
  parentPath: string;
  isTop?: boolean;
  nodeName: string;
  description: string;
  componentName?: string;
  configId?: string;
  configType?: string;
  isLeaf?: boolean;
}): Record<string, unknown> {
  return {
    node_path: opts.nodePath,
    parent_path: opts.parentPath,
    is_top_node: opts.isTop ?? false,
    node_name: opts.nodeName,
    description: opts.description,
    component_name: opts.componentName ?? "",
    interface_view: "",
    config_id: opts.configId ?? "",
    config_type: opts.configType ?? "02",
    config_var: "",
    target_config_id: "",
    is_configurable: true,
    is_customized: false,
    is_enhanced: false,
    is_freestyle_uibb: false,
    is_leaf: opts.isLeaf ?? true,
  };
}

const NODE_TOP = appNode({
  nodePath: "APPLICATION_CONFIGURATION",
  parentPath: "",
  isTop: true,
  nodeName: "CONFIGURATION_CONTEXT",
  description: "Application Configuration",
});

// ===========================================================================

describe("abap_fpm_read mode: find — loadability and id columns (#155)", () => {
  it("a type-00 component row without a same-named application config renders loadable=no, an empty app_config_id and the reason; a type-02 row renders loadable=yes with its component_config_id", async () => {
    const outs = [
      findRow({
        configId: "ZFPM_COMP_ORPHAN",
        configType: "00",
        component: "FPM_OVP_COMPONENT",
        description: "Orphan component config",
        loadable: false,
        appConfigId: "",
        componentConfigId: "",
        reason: "No application configuration references this component configuration",
      }),
      findRow({
        configId: "ZFPM_APP_CFG",
        configType: "02",
        component: "FPM_OVP_COMPONENT",
        description: "Application config",
        loadable: true,
        appConfigId: "",
        componentConfigId: "ZFPM_COMP_UNDERLYING",
        reason: "",
      }),
    ];
    const { conn } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "find", outs }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", {
      mode: "find",
      component: "FPM_OVP_COMPONENT",
      detail: "full",
    });
    const text = okText(result);

    const headers = tableHeader(text, "CONFIGURATIONS");
    expect(headers).toContain("loadable");
    expect(headers).toContain("app_config_id");
    expect(headers).toContain("component_config_id");
    expect(headers).toContain("reason");

    expect(rowLine(text, "ZFPM_COMP_ORPHAN")).toMatch(/\bno\b/);
    expect(text).toContain("No application configuration references this component configuration");

    expect(rowLine(text, "ZFPM_APP_CFG")).toMatch(/\byes\b/);
    expect(text).toContain("ZFPM_COMP_UNDERLYING");

    expect(text).toContain(
      'mode=app takes app_config_id. loadable=no rows name the reason; a component configuration id ' +
        "passed to mode=app is resolved to the application configuration that references it when there " +
        "is exactly one.",
    );
  });

  it("compact detail hoists loadable when it is constant across rows", async () => {
    const outs = [
      findRow({
        configId: "ZFPM_APP_1",
        configType: "02",
        configVar: "V1",
        component: "COMP_A",
        description: "App 1",
        loadable: true,
        appConfigId: "",
        componentConfigId: "COMP_CFG_1",
        reason: "",
      }),
      findRow({
        configId: "ZFPM_APP_2",
        configType: "02",
        configVar: "V2",
        component: "COMP_B",
        description: "App 2",
        loadable: true,
        appConfigId: "",
        componentConfigId: "COMP_CFG_2",
        reason: "",
      }),
      findRow({
        configId: "ZFPM_APP_3",
        configType: "02",
        configVar: "V3",
        component: "COMP_C",
        description: "App 3",
        loadable: true,
        appConfigId: "",
        componentConfigId: "COMP_CFG_3",
        reason: "",
      }),
    ];
    const { conn } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "find", outs }),
    });
    const { tools } = await registered(conn);

    // No `detail` passed — the default is "compact".
    const result = await invoke(tools, "abap_fpm_read", { mode: "find", component: "FPM_OVP_COMPONENT" });
    const text = okText(result);

    const allRowsLine = text.split("\n").find((l) => l.startsWith("allRows:"));
    expect(allRowsLine).toBeDefined();
    expect(allRowsLine).toContain("loadable=yes");
    expect(tableHeader(text, "CONFIGURATIONS")).not.toContain("loadable");
  });

  it("rows from a bridge that predates the new fields (no loadable key) still render, without the new columns", async () => {
    const outs = [
      {
        config_id: "ZFPM_OLD_1",
        config_type: "00",
        config_var: "",
        component: "FPM_OVP_COMPONENT",
        description: "Pre-#155 row",
        devclass: "",
      },
    ];
    const { conn } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "find", outs }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", {
      mode: "find",
      component: "FPM_OVP_COMPONENT",
      detail: "full",
    });
    const text = okText(result);

    const headers = tableHeader(text, "CONFIGURATIONS");
    expect(headers).not.toContain("loadable");
    expect(headers).not.toContain("app_config_id");
    expect(headers).not.toContain("component_config_id");
    expect(headers).not.toContain("reason");
    expect(text).toContain("ZFPM_OLD_1");
  });

  it("a row with loadable of the wrong type is a protocol error", async () => {
    const badRow: Record<string, unknown> = {
      config_id: "ZFPM_BAD",
      config_type: "00",
      config_var: "",
      component: "FPM_OVP_COMPONENT",
      description: "Bad row",
      devclass: "",
      loadable: "yes",
    };
    const { conn } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "find", outs: [badRow] }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "find", component: "FPM_OVP_COMPONENT" });
    const payload = errorPayload(result);

    expect(payload.error).toBe("FLUID_PROTOCOL_ERROR");
  });
});

// ===========================================================================

describe("abap_fpm_read mode: app — a component configuration id is resolved to its application configuration (#155)", () => {
  it("single referencing application config: app is retried with it, header names both ids, one note explains", async () => {
    const CONFIG_ID = "ZFPM_COMP_CFG";
    const APP_ID = "ZFPM_APP_CFG";
    const COMPONENT = "FPM_OVP_COMPONENT";

    const transcript = queuedTranscript([
      loadFailedTranscript(CONFIG_ID),
      fpmTranscript({
        ver: FPM_VER,
        action: "resolve",
        outs: [
          resolveOut({
            configId: CONFIG_ID,
            existsAsApp: false,
            existsAsComponent: true,
            component: COMPONENT,
            applicationConfigs: [{ configId: APP_ID, application: "FPM_TEST_OVP" }],
          }),
        ],
      }),
      fpmTranscript({ ver: FPM_VER, action: "app", outs: [NODE_TOP] }),
    ]);
    const { conn, inner } = await connectedFluid({ transcript });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "app", config_id: CONFIG_ID });
    const text = okText(result);

    expect(text).toContain(`config_id: ${APP_ID}`);
    expect(text).toContain(`resolvedFrom: ${CONFIG_ID}`);
    expect(text).toContain(
      `config_id ${CONFIG_ID} is a component configuration (component ${COMPONENT}); loaded the ` +
        `application configuration ${APP_ID} that references it.`,
    );
    expect(classrunCalls(inner.calls)).toHaveLength(3);
  });

  it("no referencing application config: NOT_FOUND with tried id, empty candidates and the find hint", async () => {
    const CONFIG_ID = "ZFPM_COMP_CFG";

    const transcript = queuedTranscript([
      loadFailedTranscript(CONFIG_ID),
      fpmTranscript({
        ver: FPM_VER,
        action: "resolve",
        outs: [
          resolveOut({
            configId: CONFIG_ID,
            existsAsApp: false,
            existsAsComponent: true,
            component: "FPM_OVP_COMPONENT",
            applicationConfigs: [],
          }),
        ],
      }),
    ]);
    const { conn, inner } = await connectedFluid({ transcript });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "app", config_id: CONFIG_ID });
    const payload = errorPayload(result);

    expect(payload.error).toBe("NOT_FOUND");
    expect(String(payload.message)).toMatch(
      new RegExp(`^mode=app could not load configuration ${CONFIG_ID}:`),
    );
    const details = payload.details as Record<string, unknown>;
    expect(details.tried).toEqual({ config_id: CONFIG_ID, config_type: "02", table: "WDY_CONFIG_APPL" });
    expect(details.applicationConfigs).toEqual([]);
    expect(String(payload.hint)).toContain('mode=find config_type="02"');
    expect(classrunCalls(inner.calls)).toHaveLength(2);
  });

  it("several referencing application configs: NOT_FOUND lists them in details and in the hint, and does not guess", async () => {
    const CONFIG_ID = "ZFPM_COMP_CFG";

    const transcript = queuedTranscript([
      loadFailedTranscript(CONFIG_ID),
      fpmTranscript({
        ver: FPM_VER,
        action: "resolve",
        outs: [
          resolveOut({
            configId: CONFIG_ID,
            existsAsApp: false,
            existsAsComponent: true,
            component: "FPM_OVP_COMPONENT",
            applicationConfigs: [
              { configId: "APP1", application: "FPM_TEST_OVP" },
              { configId: "APP2", application: "FPM_TEST_OVP2" },
            ],
          }),
        ],
      }),
    ]);
    const { conn, inner } = await connectedFluid({ transcript });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "app", config_id: CONFIG_ID });
    const payload = errorPayload(result);

    expect(payload.error).toBe("NOT_FOUND");
    const details = payload.details as Record<string, unknown>;
    expect((details.applicationConfigs as unknown[]).length).toBe(2);
    expect(String(payload.hint)).toContain("Pass one of these to mode=app: APP1, APP2");
    expect(classrunCalls(inner.calls)).toHaveLength(2);
  });

  it("an id that exists nowhere: NOT_FOUND with the spelling hint", async () => {
    const CONFIG_ID = "ZFPM_NOWHERE";

    const transcript = queuedTranscript([
      loadFailedTranscript(CONFIG_ID),
      fpmTranscript({
        ver: FPM_VER,
        action: "resolve",
        outs: [
          resolveOut({
            configId: CONFIG_ID,
            existsAsApp: false,
            existsAsComponent: false,
            applicationConfigs: [],
          }),
        ],
      }),
    ]);
    const { conn } = await connectedFluid({ transcript });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "app", config_id: CONFIG_ID });
    const payload = errorPayload(result);

    expect(payload.error).toBe("NOT_FOUND");
    expect(String(payload.hint)).toContain("Neither an application");
  });

  it("resolve itself failing rethrows the original load error", async () => {
    const CONFIG_ID = "ZFPM_COMP_CFG";

    const transcript = queuedTranscript([
      loadFailedTranscript(CONFIG_ID),
      fpmErrTranscript({
        ver: FPM_VER,
        action: "resolve",
        kind: "exception",
        step: "select_resolve",
        text: "resolve blew up",
      }),
    ]);
    const { conn, inner } = await connectedFluid({ transcript });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "app", config_id: CONFIG_ID });
    const payload = errorPayload(result);

    expect(payload.error).toBe("FLUID_ACTION_FAILED");
    const details = payload.details as Record<string, unknown>;
    const frames = details.frames as { step?: unknown }[];
    expect(frames[0]?.step).toBe("load_configuration");
    expect(classrunCalls(inner.calls)).toHaveLength(2);
  });

  it("a load failure that is not load_configuration is not resolved", async () => {
    const CONFIG_ID = "ZFPM_COMP_CFG";

    const transcript = queuedTranscript([
      fpmErrTranscript({ ver: FPM_VER, action: "app", kind: "exception", step: "args", text: "bad args" }),
    ]);
    const { conn, inner } = await connectedFluid({ transcript });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "app", config_id: CONFIG_ID });
    const payload = errorPayload(result);

    expect(payload.error).toBe("FLUID_ACTION_FAILED");
    expect(classrunCalls(inner.calls)).toHaveLength(1);
  });

  it("the happy path still costs one classrun POST", async () => {
    const { conn, inner } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "app", outs: [NODE_TOP] }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "app", config_id: "ZFPM_APP_CFG" });
    const text = okText(result);

    expect(text).not.toContain("resolvedFrom");
    expect(classrunCalls(inner.calls)).toHaveLength(1);
  });
});
