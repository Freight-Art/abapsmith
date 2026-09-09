/**
 * Tests for `src/tools/fpm.ts` — the MCP tool layer over `src/adt/fpm-runtime.ts`.
 *
 * Mirrors `test/bopf-tools.test.ts`'s harness shape (a minimal `registerTool`-
 * capturing fake `McpServer`, a one-line passthrough `SessionPool`, a real
 * `SafetyGate`, and the real `errorResult` from `src/server.ts`), but wires
 * the underlying `AbapConnection` the way `test/fpm-runtime.test.ts` does for
 * its own `runFpmRead` orchestration tests: a `RecordingClient` implementing
 * `HttpClient` directly (`bridgeHappyPath`), not `FakeAdtServer`. That keeps
 * this file focused on what is unique to the TOOL layer — input validation
 * before any network call, response rendering (`buildFindResponse` /
 * `buildOutlineResponse` / `buildAppResponse`), and the two-phase safety gate
 * — while reusing already-verified transcript parsing from
 * `fpm-runtime.test.ts` rather than re-proving it here.
 *
 * `runFpmRead`'s own write→activate→classrun wire mechanics (including the
 * CHECK_FAILED-on-bad-activation path) are already covered end-to-end in
 * `fpm-runtime.test.ts`'s `describe("runFpmRead", ...)` block, so this file
 * only ever exercises the HAPPY activation path — the interesting surface
 * here is entirely above that boundary.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  HttpClientException,
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
import { fpmManifest, fpmSources } from "../src/adt/fluid/builtin/fpm.js";
import {
  LOCK_LINE_PREFIX,
  fpmLockBridgeClassName,
  type FpmLockInspectQuery,
} from "../src/adt/fpm-lock.js";
import { registerFpmTools, type FpmToolDeps } from "../src/tools/fpm.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { fpmFluidRoute, fpmTranscript, fpmTruncatedTranscript, fpmErrTranscript } from "./helpers/fluid-fpm-fake.js";

/** `fpm`'s deployed manifest version, so canned transcripts claim the real one dispatch() checks against. */
const FPM_VER = manifestVersion(fpmManifest, fpmSources);

// --------------------------------------------------------------------- fixtures ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fpm");
const REAL_OUTLINE_XML = readFileSync(join(FIXTURES, "36-BOFU_DEMO_SO_HDR_VIEW.full-config.xml"), "utf8");

/* `DATAPREVIEW_XML` + `T000_NONPRODUCTIVE` (fixture 087): imported from
 * ./helpers/system-role-fake.js — the §10.4 probe is fail-closed, so a fake
 * that must stand for a writable system has to serve these real bytes. */

// ----------------------------------------------------------------------- harness ---

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-fpm-tools-"));
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

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

/**
 * Full write -> activate -> classrun happy path for a bridge class that does
 * not exist yet on the fake server. Same shape as `fpm-runtime.test.ts`'s own
 * `bridgeHappyPath` (itself adapted from `bopf-runtime.test.ts`) —
 * deliberately NOT imported/shared across files, per this repo's convention
 * of self-contained per-file test harnesses.
 */
function bridgeHappyPath(
  className: string,
  classrun: (o: HttpClientOptions) => HttpClientResponse,
): (o: HttpClientOptions) => HttpClientResponse {
  const classUri = `/sap/bc/adt/oo/classes/${className.toLowerCase()}`;
  const sourceUri = `${classUri}/source/main`;
  return (o: HttpClientOptions) => {
    const qs = (o.qs ?? {}) as Record<string, string>;
    const method = (o.method ?? "GET").toUpperCase();

    if (o.url.startsWith("/sap/bc/adt/oo/classrun/")) return classrun(o);
    if (o.url.includes(SESSION_URL)) {
      return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
    }
    if (o.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
    if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
    if (o.url === classUri && method === "GET" && !qs._action) {
      const r = resp(404, "<exc:exception/>", { "content-type": "application/xml" });
      throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
    }
    if (o.url === "/sap/bc/adt/oo/classes" && method === "POST") return resp(200, "", {});
    if (qs._action === "LOCK") return resp(200, LOCK_XML(), { "content-type": "application/xml" });
    if (qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (o.url === sourceUri && method === "PUT") return resp(200, "", { "content-type": "text/plain" });
    if (o.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
    return resp(200, "<ok/>", { "content-type": "application/xml" });
  };
}

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

/**
 * find/outline/app now run through `dispatch()` against the static fluid
 * `fpm` tool body, so their fake server needs the full deploy/activate/
 * classrun mechanics from `helpers/fluid-fpm-fake.ts`'s `fpmFluidRoute`,
 * composed with the session/discovery bits above — unlike `connected()` +
 * `bridgeHappyPath`, still used below for `locks` (a separate, per-call-
 * generated bridge untouched by this reroute).
 */
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

const openGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP", "$ABAPSMITH_FLUID_API"],
    // $ is outside the default Z/Y customer namespace, same as
    // test/fluid-package.test.ts's own gate() — ensureFluidPackage's own DEVC/K create needs this too.
    allowNamePrefixes: ["*"],
    writesLockedOut: false,
  });
const closedGate = (): SafetyGate => new SafetyGate({ readOnly: true, allowPackages: [] });

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

/**
 * Canned `find` rows at the scale actually measured on A4H
 * (doc/bench-runs/tool-calls-readonly.ndjson, c.fpm.find.filtered:
 * matches=200/serverRowCount=200) — config_type/config_var/component held
 * constant across every row so detail:"compact" has something to hoist.
 */
function generateFindRows(n: number): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      config_id: `SCALE_CONFIG_${String(i).padStart(4, "0")}`,
      config_type: "00",
      config_var: "STD",
      component: "FPM_OVP_COMPONENT",
      description: `Scale test configuration number ${i} of ${n}`,
      devclass: "",
    });
  }
  return rows;
}

/**
 * Canned `app` nodes at the scale actually measured on A4H
 * (doc/bench-runs/tool-calls-readonly.ndjson, c.fpm.app.resolve:
 * nodeCount=34/serverNodeCount=34) — every node resolved, each with an
 * excerpt padded to exactly `excerptChars` (the ABAP side caps at 300, per
 * `appBody`'s `nmin(... val2 = 300)`).
 */
function generateAppNodes(n: number, excerptChars = 300): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  for (let i = 1; i <= n; i++) {
    const path = `CONFIGURATION_CONTEXT.${String(i).padStart(6, "0")}.NODE`;
    const body = `<UIBB><FEEDER_CLASS>/BOFU/CL_SO_NODE_${i}</FEEDER_CLASS><BO_KEY>ROOT_${i}</BO_KEY></UIBB>`;
    const excerpt = body.padEnd(excerptChars, ".").slice(0, excerptChars);
    nodes.push({
      node_path: path,
      parent_path: "APPLICATION_CONFIGURATION",
      is_top_node: false,
      node_name: `NODE_${i}`,
      description: `Node ${i}`,
      component_name: "FPM_OVP_COMPONENT",
      interface_view: "",
      config_id: "/BOBF/EPM_FPM_SADL_PD",
      config_type: "02",
      config_var: "",
      target_config_id: "",
      is_configurable: true,
      is_customized: false,
      is_enhanced: false,
      is_freestyle_uibb: false,
      is_leaf: true,
      resolved: { xml_len: excerpt.length, feeder_hint: true, bopf_hint: true, excerpt },
    });
  }
  return nodes;
}

// ===========================================================================

describe("abap_fpm_read — mode: find", () => {
  it('detail: "full": canned find row renders a table plus the three fidelity notes verbatim', async () => {
    const outs = [
      {
        config_id: "BOFU_DEMO_SO_HDR_VIEW",
        config_type: "00",
        config_var: "",
        component: "FPM_OVP_COMPONENT",
        description: "Demo",
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

    expect(text).toContain("mode: find");
    expect(text).toContain("detail: full");
    expect(text).toContain("BOFU_DEMO_SO_HDR_VIEW");
    expect(text).toContain("FPM_OVP_COMPONENT");
    expect(text).toContain("Demo");
    // detail:"full" keeps all three FIDELITY_NOTES verbatim (not the condensed COMPACT_COVERAGE_NOTE).
    expect(text).toContain("AppCC (application-configuration-controller)");
    expect(text).toContain("CBA (Component-Based Architecture)");
    expect(text).toContain("XML decoding has only been verified in depth against FORM/LIST UIBBs");
    expect(text).not.toContain("Coverage limits: base persisted configuration only");
  });

  it('detail: "compact" (default): >=2 rows with identical config_type/config_var/component hoists them into allRows and drops them from the table', async () => {
    const outs = [
      {
        config_id: "CFG_A",
        config_type: "00",
        config_var: "STD",
        component: "FPM_OVP_COMPONENT",
        description: "Config A",
        devclass: "",
      },
      {
        config_id: "CFG_B",
        config_type: "00",
        config_var: "STD",
        component: "FPM_OVP_COMPONENT",
        description: "Config B",
        devclass: "",
      },
    ];
    const { conn } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "find", outs }),
    });
    const { tools } = await registered(conn);

    // No `detail` passed — proves the default is "compact", not just that compact works when asked for.
    const result = await invoke(tools, "abap_fpm_read", { mode: "find", component: "FPM_OVP_COMPONENT" });
    const text = okText(result);

    expect(text).toContain("mode: find");
    expect(text).toContain("detail: compact");
    expect(text).toContain("allRows: config_type=00, config_var=STD, component=FPM_OVP_COMPONENT");
    expect(tableHeader(text, "CONFIGURATIONS")).toEqual(["config_id", "description"]);
    expect(text).toContain("CFG_A");
    expect(text).toContain("Config A");
    // Compact swaps the three FIDELITY_NOTES for the one condensed note.
    expect(text).toContain("Coverage limits: base persisted configuration only");
    expect(text).not.toContain("AppCC (application-configuration-controller)");
    expect(text).not.toContain("CBA (Component-Based Architecture)");
  });

  it('detail: "compact": a column blank on every row still hoists, rendered as "(blank)" — distinguishing "blank on every row" from "column omitted"', async () => {
    const outs = [
      {
        config_id: "CFG_A",
        config_type: "00",
        config_var: "",
        component: "FPM_OVP_COMPONENT",
        description: "Config A",
        devclass: "",
      },
      {
        config_id: "CFG_B",
        config_type: "00",
        config_var: "",
        component: "FPM_OVP_COMPONENT",
        description: "Config B",
        devclass: "",
      },
    ];
    const { conn } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "find", outs }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "find", component: "FPM_OVP_COMPONENT" });
    const text = okText(result);

    expect(text).toContain("allRows: config_type=00, config_var=(blank), component=FPM_OVP_COMPONENT");
    expect(tableHeader(text, "CONFIGURATIONS")).toEqual(["config_id", "description"]);
  });

  it("a large but COMPLETE result set (outputComplete: true) does not claim possible truncation", async () => {
    const outs = generateFindRows(200);
    const { conn } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "find", outs }),
    });
    const { tools } = await registered(conn, { maxResponseChars: 200_000 });

    const result = await invoke(tools, "abap_fpm_read", { mode: "find", component: "FPM_OVP_COMPONENT" });
    const text = okText(result);

    expect(text).toContain("matches: 200");
    expect(text).toContain("serverRowCount: 200");
    expect(text).not.toContain("cut off before every matching row could be returned");
  });

  it("a genuinely truncated result (outputComplete: false, dispatch's END.truncated) still discloses it", async () => {
    const outs = generateFindRows(5);
    const { conn } = await connectedFluid({
      transcript: () => fpmTruncatedTranscript({ ver: FPM_VER, action: "find", outs }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "find", component: "FPM_OVP_COMPONENT" });
    const text = okText(result);

    expect(text).toContain(
      "cut off before every matching row could be returned — there may be more configs than are shown",
    );
  });
});

// ===========================================================================

/** `outline`'s canned single OUT-frame result object, matching `FpmOutlineResult` (fpm-runtime.ts). */
function outlineOut(opts: {
  configId: string;
  configType: string;
  configVar?: string;
  xml: string;
  configIdPar?: string;
  configTypePar?: string;
  configVarPar?: string;
  component?: string;
  devclass?: string;
}): Record<string, unknown> {
  return {
    config_id: opts.configId,
    config_type: opts.configType,
    config_var: opts.configVar ?? "",
    xml: opts.xml,
    meta: {
      config_idpar: opts.configIdPar ?? "",
      config_typepar: opts.configTypePar ?? "",
      config_varpar: opts.configVarPar ?? "",
      component: opts.component ?? "",
      devclass: opts.devclass ?? "",
    },
  };
}

describe("abap_fpm_read — mode: outline", () => {
  it("the real captured fixture XML comes through in the body verbatim, with NO delta warning — outline ignores detail and always returns full XML", async () => {
    const out = outlineOut({
      configId: "BOFU_DEMO_SO_HDR_VIEW",
      configType: "00",
      xml: REAL_OUTLINE_XML,
      component: "FPM_OVP_COMPONENT",
      devclass: "ZFPM_PKG",
    });
    const { conn } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "outline", outs: [out] }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", {
      mode: "outline",
      config_id: "BOFU_DEMO_SO_HDR_VIEW",
    });
    const text = okText(result);

    expect(text).toContain("mode: outline");
    // outline never prints a detail: header line, same as locks.
    expect(text).not.toMatch(/^detail: /m);
    expect(text).toContain(`xmlChars: ${REAL_OUTLINE_XML.length}`);
    expect(text).toContain("--- XML ---");
    // ConfId is namespaced ("/BOFU/DEMO_SO_HDR_VIEW"), not underscore-joined
    // — see fpm-runtime.test.ts's identical note on the fixture's real shape.
    expect(text).toContain("/BOFU/DEMO_SO_HDR_VIEW");
    expect(text).toContain("DELIVER_ORDER");
    expect(text).not.toContain("DELTA CONFIGURATION");
    expect(text).toContain("devclass: ZFPM_PKG");
    // All three FIDELITY_NOTES verbatim, always — outline never uses COMPACT_COVERAGE_NOTE.
    expect(text).toContain("AppCC (application-configuration-controller)");
    expect(text).toContain("CBA (Component-Based Architecture)");
    expect(text).toContain('mode "outline" always returns the raw XML verbatim.');
  });

  it("delta: a non-blank CONFIG_IDPAR produces a visible delta/parent warning naming the parent id", async () => {
    // NB: the delta signal is CONFIG_IDPAR alone — there is no separate
    // `is_delta` field anywhere in the fluid result or in
    // `buildOutlineResponse` (`src/tools/fpm.ts`'s
    // `const isRealDelta = idpar !== "" && !idpar.startsWith("N/A");`).
    const out = outlineOut({
      configId: "BOFU_DEMO_SO_ITM_VIEW",
      configType: "00",
      xml: "<Component/>",
      configIdPar: "BOFU_DEMO_SO_HDR_VIEW",
      configTypePar: "00",
      component: "FPM_OVP_COMPONENT",
    });
    const { conn } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "outline", outs: [out] }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", {
      mode: "outline",
      config_id: "BOFU_DEMO_SO_ITM_VIEW",
    });
    const text = okText(result);

    expect(text).toContain("DELTA CONFIGURATION");
    expect(text).toContain('CONFIG_IDPAR ("BOFU_DEMO_SO_HDR_VIEW")');
    expect(text).toContain("config_idpar: BOFU_DEMO_SO_HDR_VIEW");
  });

  it('a placeholder CONFIG_IDPAR value starting with "N/A" is NOT treated as a real delta', async () => {
    const out = outlineOut({
      configId: "SOME_APPL_CFG",
      configType: "02",
      xml: "<Component/>",
      configIdPar: "N/A - application config",
    });
    const { conn } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "outline", outs: [out] }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "outline", config_id: "SOME_APPL_CFG", config_type: "02" });
    const text = okText(result);

    expect(text).not.toContain("DELTA CONFIGURATION");
    expect(text).not.toContain("config_idpar:");
  });

  it("outline without config_id refuses BAD_INPUT, zero network calls", async () => {
    const { conn, inner } = await connectedFluid({
      transcript: () => {
        throw new Error("should never be reached");
      },
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "outline" });
    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(inner.calls).toHaveLength(0);
  });

  it("not found: the fluid body's not-found err() frame (select/wdy_config_appl not-found shape) is turned into the legacy diagnostic wording, with no XML content", async () => {
    const { conn } = await connectedFluid({
      transcript: () =>
        fpmErrTranscript({
          ver: FPM_VER,
          action: "outline",
          kind: "subrc",
          step: "select",
          text: "wdy_config_appl: no matching row for the given key",
        }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", {
      mode: "outline",
      config_id: "NOPE",
      config_type: "02",
    });
    const text = okText(result);

    expect(text).toContain("No XML content was returned");
    expect(text).toContain("wdy_config_appl: no matching row for the given key");
  });

  it("not found: the fluid body's not-found err() frame (read_comp_config_from_db exception shape) is turned into the legacy diagnostic wording", async () => {
    const { conn } = await connectedFluid({
      transcript: () =>
        fpmErrTranscript({
          ver: FPM_VER,
          action: "outline",
          kind: "exception",
          step: "read_comp_config_from_db",
          text: "Configuration does not exist",
        }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "outline", config_id: "NOPE" });
    const text = okText(result);

    expect(text).toContain("No XML content was returned");
    expect(text).toContain("READ_COMP_CONFIG_FROM_DB FAILED Configuration does not exist");
  });

  it('detail is ignored: output is identical whether detail is absent or "full", except an extra note appears only when detail was explicitly passed', async () => {
    const out = outlineOut({
      configId: "BOFU_DEMO_SO_HDR_VIEW",
      configType: "00",
      xml: REAL_OUTLINE_XML,
      component: "FPM_OVP_COMPONENT",
      devclass: "ZFPM_PKG",
    });
    const transcript = () => fpmTranscript({ ver: FPM_VER, action: "outline", outs: [out] });

    const { conn: connAbsent } = await connectedFluid({ transcript });
    const { tools: toolsAbsent } = await registered(connAbsent);
    const textAbsent = okText(
      await invoke(toolsAbsent, "abap_fpm_read", { mode: "outline", config_id: "BOFU_DEMO_SO_HDR_VIEW" }),
    );

    const { conn: connFull } = await connectedFluid({ transcript });
    const { tools: toolsFull } = await registered(connFull);
    const textFull = okText(
      await invoke(toolsFull, "abap_fpm_read", {
        mode: "outline",
        config_id: "BOFU_DEMO_SO_HDR_VIEW",
        detail: "full",
      }),
    );

    expect(textAbsent).not.toContain('mode "outline" ignores detail');
    expect(textFull).toContain('mode "outline" ignores detail — it always returns the verbatim XML.');

    const withoutIgnoresDetailNote = (t: string) =>
      t
        .split("\n")
        .filter((l) => !l.startsWith('NOTE: mode "outline" ignores detail'))
        .join("\n");
    expect(withoutIgnoresDetailNote(textFull)).toBe(textAbsent);
  });
});

// ===========================================================================

/** `app`'s canned per-node OUT payload, matching `FpmAppNodeResult` (fpm-runtime.ts). */
function appNode(opts: {
  nodePath: string;
  parentPath: string;
  isTop?: boolean;
  nodeName: string;
  description: string;
  componentName?: string;
  targetConfigId?: string;
  isLeaf?: boolean;
  resolved?: { xmlLen: number; feederHint: boolean; bopfHint: boolean; excerpt?: string };
  resolveError?: string;
}): Record<string, unknown> {
  return {
    node_path: opts.nodePath,
    parent_path: opts.parentPath,
    is_top_node: opts.isTop ?? false,
    node_name: opts.nodeName,
    description: opts.description,
    component_name: opts.componentName ?? "",
    interface_view: "",
    config_id: "/BOBF/EPM_FPM_SADL_PD",
    config_type: "02",
    config_var: "",
    target_config_id: opts.targetConfigId ?? "",
    is_configurable: true,
    is_customized: false,
    is_enhanced: false,
    is_freestyle_uibb: false,
    is_leaf: opts.isLeaf ?? false,
    ...(opts.resolved
      ? { resolved: { xml_len: opts.resolved.xmlLen, feeder_hint: opts.resolved.feederHint, bopf_hint: opts.resolved.bopfHint, excerpt: opts.resolved.excerpt } }
      : {}),
    ...(opts.resolveError !== undefined ? { resolve_error: opts.resolveError } : {}),
  };
}

describe("abap_fpm_read — mode: app", () => {
  const NODE_TOP = appNode({
    nodePath: "APPLICATION_CONFIGURATION",
    parentPath: "",
    isTop: true,
    nodeName: "CONFIGURATION_CONTEXT",
    description: "Application Configuration",
    targetConfigId: "Z_EPM_FPM_SADL_PD",
  });
  const NODE_UIBB_BASE = {
    nodePath: "CONFIGURATION_CONTEXT.000001.OVP_APPLICATION",
    parentPath: "APPLICATION_CONFIGURATION",
    nodeName: "OVP_APPLICATION",
    description: "Overview Page Floorplan",
    componentName: "FPM_OVP_COMPONENT",
  };
  const EXCERPT_XML = "<UIBB><FEEDER_CLASS>/BOFU/CL_SO_CONFIRM_DIALOG</FEEDER_CLASS><BO_KEY>ROOT</BO_KEY></UIBB>";

  it('detail: "full": node table renders top/leaf columns, FEEDER/BOPF hints and the per-node excerpt section', async () => {
    const NODE_UIBB = appNode({
      ...NODE_UIBB_BASE,
      resolved: { xmlLen: EXCERPT_XML.length, feederHint: true, bopfHint: true, excerpt: EXCERPT_XML },
    });
    const { conn } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "app", outs: [NODE_TOP, NODE_UIBB] }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", {
      mode: "app",
      config_id: "/BOBF/EPM_FPM_SADL_PD",
      detail: "full",
    });
    const text = okText(result);

    expect(text).toContain("mode: app");
    expect(text).toContain("detail: full");
    expect(text).toContain("OVP_APPLICATION");
    expect(text).toContain("FPM_OVP_COMPONENT");
    expect(text).toContain("FEEDER/BOPF-binding hints");
    expect(tableHeader(text, "NODES")).toContain("top");
    expect(tableHeader(text, "NODES")).toContain("leaf");
    // The excerpt section for the resolved node.
    expect(text).toContain("EXCERPT CONFIGURATION_CONTEXT.000001.OVP_APPLICATION");
    expect(text).toContain("/BOFU/CL_SO_CONFIRM_DIALOG");
    // All three FIDELITY_NOTES verbatim.
    expect(text).toContain("AppCC (application-configuration-controller)");
    expect(text).toContain("CBA (Component-Based Architecture)");
  });

  it('detail: "compact" (default): EXCERPT sections and top/leaf columns are omitted, replaced by an omitted-count note', async () => {
    const NODE_UIBB = appNode({
      ...NODE_UIBB_BASE,
      resolved: { xmlLen: EXCERPT_XML.length, feederHint: true, bopfHint: true, excerpt: EXCERPT_XML },
    });
    const { conn } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "app", outs: [NODE_TOP, NODE_UIBB] }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "app", config_id: "/BOBF/EPM_FPM_SADL_PD" });
    const text = okText(result);

    expect(text).toContain("mode: app");
    expect(text).toContain("detail: compact");
    expect(text).toContain("OVP_APPLICATION");
    expect(text).toContain("FPM_OVP_COMPONENT");
    expect(tableHeader(text, "NODES")).not.toContain("top");
    expect(tableHeader(text, "NODES")).not.toContain("leaf");
    expect(text).not.toContain("EXCERPT CONFIGURATION_CONTEXT.000001.OVP_APPLICATION");
    expect(text).not.toContain("/BOFU/CL_SO_CONFIRM_DIALOG");
    expect(text).toContain("1 per-node XML excerpt section(s) omitted");
    expect(text).toContain("Coverage limits: base persisted configuration only");
    expect(text).not.toContain("AppCC (application-configuration-controller)");
  });

  it("resolve: false suppresses the FEEDER/BOPF hint caveat note", async () => {
    const { conn } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "app", outs: [NODE_TOP] }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", {
      mode: "app",
      config_id: "/BOBF/EPM_FPM_SADL_PD",
      resolve: false,
    });
    const text = okText(result);

    expect(text).toContain("resolve: false");
    expect(text).not.toContain("FEEDER/BOPF-binding hints");
  });

  it("a node's resolve_error is surfaced as a DIAGNOSTICS line and counted in the unresolved-node note", async () => {
    const failedNode = appNode({ ...NODE_UIBB_BASE, resolveError: "READ_COMP_CONFIG_FROM_DB raised CX_WDR_RUNTIME" });
    const { conn } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "app", outs: [NODE_TOP, failedNode] }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", {
      mode: "app",
      config_id: "/BOBF/EPM_FPM_SADL_PD",
      detail: "full",
    });
    const text = okText(result);

    expect(text).toContain("RESOLVE CONFIGURATION_CONTEXT.000001.OVP_APPLICATION FAILED READ_COMP_CONFIG_FROM_DB raised CX_WDR_RUNTIME");
    expect(text).toContain("1 configurable node(s) with a component were NOT successfully resolved");
  });

  it("app without config_id refuses BAD_INPUT, zero network calls", async () => {
    const { conn, inner } = await connectedFluid({
      transcript: () => {
        throw new Error("should never be reached");
      },
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "app" });
    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(inner.calls).toHaveLength(0);
  });
});

// ===========================================================================

describe("abap_fpm_read — input validation refuses before any network call", () => {
  it("an injection-shaped config_id (containing an apostrophe) is rejected by the bridge-class-name preflight, zero network calls", async () => {
    const { conn, inner } = await connected(
      bridgeHappyPath("ZCL_ZMCP_FPM_ANY", () => resp(200, "should never be reached", { "content-type": "text/plain" })),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "outline", config_id: "O'BRIEN" });
    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(inner.calls).toHaveLength(0);
  });

  it("an injection-shaped config_id is rejected the same way in mode app", async () => {
    const { conn, inner } = await connected(
      bridgeHappyPath("ZCL_ZMCP_FPM_ANY", () => resp(200, "should never be reached", { "content-type": "text/plain" })),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "app", config_id: "X'; DROP" });
    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(inner.calls).toHaveLength(0);
  });

  it("a closed (read-only) safety gate refuses at the write-preflight phase, before ensureConnected/any network call", async () => {
    const { conn, inner } = await connected(
      bridgeHappyPath("ZCL_ZMCP_FPM_ANY", () => resp(200, "should never be reached", { "content-type": "text/plain" })),
    );
    const { tools } = await registered(conn, { safety: closedGate() });

    const result = await invoke(tools, "abap_fpm_read", { mode: "find" });
    expect(errorPayload(result).error).toBe("READ_ONLY");
    expect(inner.calls).toHaveLength(0);
  });
});

// ===========================================================================

describe("abap_fpm_read — tool registration", () => {
  it("is registered with readOnlyHint: true (even though it internally goes through pool.withWrite)", async () => {
    const { conn } = await connected(
      bridgeHappyPath("ZCL_ZMCP_FPM_ANY", () => resp(200, "", { "content-type": "text/plain" })),
    );
    const { tools } = await registered(conn);

    const entry = tools.get("abap_fpm_read");
    expect(entry).toBeDefined();
    const annotations = entry!.config.annotations as Record<string, unknown> | undefined;
    expect(annotations?.readOnlyHint).toBe(true);
  });
});

// ===========================================================================

/**
 * `mode: "locks"` — `src/adt/fpm-lock.ts`'s inspection bridge, wired through
 * `buildLocksQuery` / `buildLocksResponse` in `src/tools/fpm.ts`.
 *
 * HONESTY NOTE (repo lesson: "test fakes are politer than the wire"): every
 * test below drives the SAME fake-HTTP `RecordingClient`/`bridgeHappyPath`
 * harness the rest of this file uses, fed a hand-written `LCK>`-prefixed
 * transcript string. That proves this file's own claim — the TOOL's input
 * validation, `parseLockTranscript`'s parsing of that grammar, and
 * `buildLocksResponse`'s rendering of it — and nothing more. None of it
 * proves what a live `ENQUEUE_READ` against a real SEQG3 table actually
 * returns, whether the generated ABAP in `buildLockInspectSource` even
 * activates, or whether SAP's enqueue server behaves the way the module's
 * doc comment says it observed. The only test in this repo that touches the
 * wire for this feature is `test/integration-fpm-lock.test.ts`; every
 * assertion here is downstream of a string this test wrote itself.
 */
describe("abap_fpm_read — mode: locks", () => {
  // This segment is exactly `configId(32) + configType(2)`, no configVar/tail
  // — src/adt/fpm-lock.ts's own module doc comment records that a precise
  // component key's GARG arrives on the wire 34 characters long because ABAP
  // strips trailing blanks on the C -> STRING conversion, and parseGarg pads
  // it back out to 150 before slicing. Relying on that documented behaviour
  // (rather than spelling out all 150 characters by hand) is itself downstream
  // of the module's own claim, not an independent check of it.
  const GARG_PRECISE = "ZFPM_TEST" + " ".repeat(23) + "00";

  it("without config_id refuses BAD_INPUT, zero network calls", async () => {
    // Proves: buildLocksQuery's config_id preflight in src/tools/fpm.ts fires
    // before fpmLockBridgeClassName / any network call. Does NOT prove
    // anything about ENQUEUE_READ or SAP's enqueue table — see
    // test/integration-fpm-lock.test.ts for the only live proof of this
    // feature.
    const { conn, inner } = await connected(
      bridgeHappyPath("ZCL_ZMCP_FPMLK_ANY", () => resp(200, "should never be reached", { "content-type": "text/plain" })),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "locks" });
    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(inner.calls).toHaveLength(0);
  });

  it('a config_type that is not exactly 2 numeric digits ("0", "0A") is refused at the tool boundary, zero network calls', async () => {
    // Proves: buildLocksQuery routes config_type through fpm-lock.ts's STRICT
    // assertLockConfigType — unlike the lenient read path (src/tools/fpm.ts's
    // buildQuery, `input.config_type ?? "00"`, and the fluid `fpm` body's own
    // initial-value default), which silently defaults a missing value to "00"
    // — so a malformed NUMC2 is refused before any network call rather than
    // becoming a wildcard key (landmine 2). Does NOT prove anything about SAP's
    // enqueue function modules do with a malformed CONFIG_TYPE on the wire —
    // see test/integration-fpm-lock.test.ts for that.
    const { conn, inner } = await connected(
      bridgeHappyPath("ZCL_ZMCP_FPMLK_ANY", () => resp(200, "should never be reached", { "content-type": "text/plain" })),
    );
    const { tools } = await registered(conn);

    for (const badType of ["0", "0A"]) {
      const result = await invoke(tools, "abap_fpm_read", {
        mode: "locks",
        config_id: "ZFPM_TEST",
        config_type: badType,
      });
      expect(errorPayload(result).error).toBe("BAD_INPUT");
    }
    expect(inner.calls).toHaveLength(0);
  });

  it("happy path: one precise lock row renders a table with precision=precise and the right key columns, bodyLabel LOCKS", async () => {
    // Proves: the tool's parsing of a canned LCK> ROW line via
    // parseLockTranscript, and buildLocksResponse's rendering of a
    // non-wildcard row (config_id/config_type/config_var come straight
    // through the garg_view, precision reads "precise", bodyLabel is LOCKS).
    // The transcript below is entirely fabricated by this test to drive the
    // fake HTTP client — it proves nothing about what a real ENQUEUE_READ
    // returns. See test/integration-fpm-lock.test.ts for the live proof.
    const TRANSCRIPT =
      `${LOCK_LINE_PREFIX}SELF owner=[GUSR1] ok=[X]\n` +
      `${LOCK_LINE_PREFIX}ROW phase=[inspect] gname=[WDY_CONFIG_DATA] garg=[${GARG_PRECISE}] gmode=[E] guname=[TESTUSER] gclient=[001] gusr=[GUSR1] gusrvb=[] guse=[1] gusevb=[0] gobj=[]\n` +
      `${LOCK_LINE_PREFIX}COUNT phase=[inspect] rows=[1]\n`;
    const query: FpmLockInspectQuery = { mode: "locks", configId: "ZFPM_TEST", configType: "00" };
    const className = fpmLockBridgeClassName(query);
    const { conn } = await connected(
      bridgeHappyPath(className, () => resp(200, TRANSCRIPT, { "content-type": "text/plain" })),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", {
      mode: "locks",
      config_id: "ZFPM_TEST",
      config_type: "00",
    });
    const text = okText(result);

    expect(text).toContain("mode: locks");
    expect(text).toContain("--- LOCKS ---");
    const dataRow = text.split("\n").find((l) => l.includes("WDY_CONFIG_DATA"));
    expect(dataRow).toBeDefined();
    expect(dataRow).toContain("ZFPM_TEST");
    expect(dataRow).toContain("00");
    expect(dataRow).toContain("precise");
    expect(dataRow).toContain("MINE");
  });

  it("a WILDCARD row (real captured U+FFFF fill in config_type) is marked WILDCARD and the notes call it a defect", async () => {
    // The GARG below is `Buffer.from(hex, "hex").toString("utf8")` of a REAL
    // byte sequence captured live against A4H during the lock-discipline
    // spike that src/adt/fpm-lock.ts's module doc comment cites — the U+FFFF
    // / `EF BF BF` fill is genuine, not invented for this test. What IS fake
    // here is everything else: this test wraps that one real GARG in a
    // hand-written LCK> ROW/WILDCARD line pair and feeds it through a fake
    // HTTP client, so it proves the tool's parsing/rendering of a wildcard row
    // and the "DEFECT" framing in buildLocksResponse's notes. It does NOT
    // prove that a live ENQUEUE_READ against A4H (or any other system)
    // currently returns a row shaped like this — only that this byte sequence
    // was once observed on the wire. See test/integration-fpm-lock.test.ts for
    // the only live proof.
    // prettier-ignore
    const WILDCARD_HEX = "5A4D43505F4C4B5F485832202020202020202020202020202020202020202020EFBFBFEFBFBF2020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020";
    const gargWildcard = Buffer.from(WILDCARD_HEX, "hex").toString("utf8").replace(/ +$/, "");
    // The fill lands in the config_type segment (offset 32..34, two chars) —
    // a generic lock covering EVERY config_type of config_id "ZMCP_LK_HX2",
    // exactly landmine 2.
    expect(gargWildcard.slice(32, 34)).toBe("￿￿");
    const TRANSCRIPT =
      `${LOCK_LINE_PREFIX}SELF owner=[GUSR1] ok=[X]\n` +
      `${LOCK_LINE_PREFIX}ROW phase=[inspect] gname=[WDY_CONFIG_DATA] garg=[${gargWildcard}] gmode=[E] guname=[OTHERUSER] gclient=[001] gusr=[GUSR2] gusrvb=[] guse=[1] gusevb=[0] gobj=[]\n` +
      `${LOCK_LINE_PREFIX}WILDCARD phase=[inspect] garg=[${gargWildcard}] segments=[configType]\n` +
      `${LOCK_LINE_PREFIX}COUNT phase=[inspect] rows=[1]\n`;
    const query: FpmLockInspectQuery = { mode: "locks", configId: "ZMCP_LK_HX2" };
    const className = fpmLockBridgeClassName(query);
    const { conn } = await connected(
      bridgeHappyPath(className, () => resp(200, TRANSCRIPT, { "content-type": "text/plain" })),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "locks", config_id: "ZMCP_LK_HX2" });
    const text = okText(result);

    const dataRow = text.split("\n").find((l) => l.includes("WDY_CONFIG_DATA"));
    expect(dataRow).toBeDefined();
    expect(dataRow).toContain("WILDCARD");
    expect(text).toContain("wildcard: DEFECT");
    expect(text).toContain("A row whose precision is WILDCARD is a DEFECT, not a broad filter");
  });

  it("no lock rows renders body '(no locks held)'", async () => {
    // Proves: buildLocksResponse's empty-body fallback fires when the
    // transcript carries zero ROW lines. Does NOT prove that no lock is
    // actually held on any real config_id in SAP — it proves only that this
    // renderer, fed a canned empty transcript, produces this text.
    const TRANSCRIPT =
      `${LOCK_LINE_PREFIX}SELF owner=[GUSR1] ok=[X]\n` + `${LOCK_LINE_PREFIX}COUNT phase=[inspect] rows=[0]\n`;
    const query: FpmLockInspectQuery = { mode: "locks", configId: "ZFPM_EMPTY", configType: "00" };
    const className = fpmLockBridgeClassName(query);
    const { conn } = await connected(
      bridgeHappyPath(className, () => resp(200, TRANSCRIPT, { "content-type": "text/plain" })),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", {
      mode: "locks",
      config_id: "ZFPM_EMPTY",
      config_type: "00",
    });
    const text = okText(result);

    expect(text).toContain("(no locks held)");
  });

  it("the response notes state that this mode takes no lock on the caller's configuration — a read-only snapshot", async () => {
    // Proves: buildLocksResponse always emits its point-in-time/no-lock-taken
    // note, independent of row count. Does NOT prove the generated ABAP
    // actually behaves this way against a live enqueue table — that claim is
    // only verified by test/integration-fpm-lock.test.ts.
    const TRANSCRIPT =
      `${LOCK_LINE_PREFIX}SELF owner=[GUSR1] ok=[X]\n` + `${LOCK_LINE_PREFIX}COUNT phase=[inspect] rows=[0]\n`;
    const query: FpmLockInspectQuery = { mode: "locks", configId: "ZFPM_EMPTY", configType: "00" };
    const className = fpmLockBridgeClassName(query);
    const { conn } = await connected(
      bridgeHappyPath(className, () => resp(200, TRANSCRIPT, { "content-type": "text/plain" })),
    );
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", {
      mode: "locks",
      config_id: "ZFPM_EMPTY",
      config_type: "00",
    });
    const text = okText(result);

    expect(text).toContain("NO lock is taken on this configuration by this mode");
    expect(text).toContain("read-only inspection");
  });

  it('detail is ignored: output is identical whether detail is absent or "full", except an extra note appears only when detail was explicitly passed', async () => {
    const TRANSCRIPT =
      `${LOCK_LINE_PREFIX}SELF owner=[GUSR1] ok=[X]\n` +
      `${LOCK_LINE_PREFIX}ROW phase=[inspect] gname=[WDY_CONFIG_DATA] garg=[${GARG_PRECISE}] gmode=[E] guname=[TESTUSER] gclient=[001] gusr=[GUSR1] gusrvb=[] guse=[1] gusevb=[0] gobj=[]\n` +
      `${LOCK_LINE_PREFIX}COUNT phase=[inspect] rows=[1]\n`;
    const query: FpmLockInspectQuery = { mode: "locks", configId: "ZFPM_TEST", configType: "00" };
    const className = fpmLockBridgeClassName(query);
    const route = bridgeHappyPath(className, () => resp(200, TRANSCRIPT, { "content-type": "text/plain" }));

    const { conn: connAbsent } = await connected(route);
    const { tools: toolsAbsent } = await registered(connAbsent);
    const textAbsent = okText(
      await invoke(toolsAbsent, "abap_fpm_read", { mode: "locks", config_id: "ZFPM_TEST", config_type: "00" }),
    );

    const { conn: connFull } = await connected(route);
    const { tools: toolsFull } = await registered(connFull);
    const textFull = okText(
      await invoke(toolsFull, "abap_fpm_read", {
        mode: "locks",
        config_id: "ZFPM_TEST",
        config_type: "00",
        detail: "full",
      }),
    );

    expect(textAbsent).not.toContain('mode "locks" ignores detail');
    expect(textFull).toContain('mode "locks" ignores detail — its output is already compact');

    const withoutIgnoresDetailNote = (t: string) =>
      t
        .split("\n")
        .filter((l) => !l.startsWith('NOTE: mode "locks" ignores detail'))
        .join("\n");
    expect(withoutIgnoresDetailNote(textFull)).toBe(textAbsent);
  });
});

// ===========================================================================

describe("abap_fpm_read — detail is render-only: the bridge round trip is unaffected", () => {
  it("find: detail 'compact' (default) and 'full' produce byte-identical HTTP requests", async () => {
    const outs = [
      {
        config_id: "BOFU_DEMO_SO_HDR_VIEW",
        config_type: "00",
        config_var: "",
        component: "FPM_OVP_COMPONENT",
        description: "Demo",
        devclass: "",
      },
    ];
    const transcript = () => fpmTranscript({ ver: FPM_VER, action: "find", outs });

    const { conn: connCompact, inner: innerCompact } = await connectedFluid({ transcript });
    const { tools: toolsCompact } = await registered(connCompact);
    await invoke(toolsCompact, "abap_fpm_read", { mode: "find", component: "FPM_OVP_COMPONENT" });

    // ensureFluidTool's "already deployed" outcome is cached both in-memory (module scope) and on
    // disk (the registry under `stateDir`, shared by every connection in this test via `cfg()`'s
    // `tmp`). A second connection would otherwise skip straight to classrun — reset the in-memory
    // caches AND point at a fresh state dir so the "full" run gets its own cold deploy too.
    resetFluidEnsureState();
    resetFluidPackageMemo();
    await fs.rm(tmp, { recursive: true, force: true });
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-fpm-tools-"));
    const { conn: connFull, inner: innerFull } = await connectedFluid({ transcript });
    const { tools: toolsFull } = await registered(connFull);
    await invoke(toolsFull, "abap_fpm_read", { mode: "find", component: "FPM_OVP_COMPONENT", detail: "full" });

    const fingerprint = (o: HttpClientOptions) => ({ method: o.method, url: o.url, qs: o.qs, body: o.body });
    expect(innerCompact.calls.length).toBeGreaterThan(0);
    expect(innerCompact.calls.length).toBe(innerFull.calls.length);
    expect(innerCompact.calls.map(fingerprint)).toEqual(innerFull.calls.map(fingerprint));
  });

  it("app: detail 'compact' (default) and 'full' produce byte-identical HTTP requests", async () => {
    const NODE_TOP = appNode({
      nodePath: "APPLICATION_CONFIGURATION",
      parentPath: "",
      isTop: true,
      nodeName: "CONFIGURATION_CONTEXT",
      description: "Application Configuration",
      targetConfigId: "Z_EPM_FPM_SADL_PD",
    });
    const NODE_UIBB = appNode({
      nodePath: "CONFIGURATION_CONTEXT.000001.OVP_APPLICATION",
      parentPath: "APPLICATION_CONFIGURATION",
      nodeName: "OVP_APPLICATION",
      description: "Overview Page Floorplan",
      componentName: "FPM_OVP_COMPONENT",
      resolved: { xmlLen: 7, feederHint: true, bopfHint: true, excerpt: "<UIBB/>" },
    });
    const transcript = () => fpmTranscript({ ver: FPM_VER, action: "app", outs: [NODE_TOP, NODE_UIBB] });

    const { conn: connCompact, inner: innerCompact } = await connectedFluid({ transcript });
    const { tools: toolsCompact } = await registered(connCompact);
    await invoke(toolsCompact, "abap_fpm_read", { mode: "app", config_id: "/BOBF/EPM_FPM_SADL_PD" });

    // See the "find" test above: reset the module-level ensure/package caches, and give this
    // connection its own state-dir, so "full" also gets a cold deploy.
    resetFluidEnsureState();
    resetFluidPackageMemo();
    await fs.rm(tmp, { recursive: true, force: true });
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-fpm-tools-"));
    const { conn: connFull, inner: innerFull } = await connectedFluid({ transcript });
    const { tools: toolsFull } = await registered(connFull);
    await invoke(toolsFull, "abap_fpm_read", { mode: "app", config_id: "/BOBF/EPM_FPM_SADL_PD", detail: "full" });

    const fingerprint = (o: HttpClientOptions) => ({ method: o.method, url: o.url, qs: o.qs, body: o.body });
    expect(innerCompact.calls.length).toBeGreaterThan(0);
    expect(innerCompact.calls.length).toBe(innerFull.calls.length);
    expect(innerCompact.calls.map(fingerprint)).toEqual(innerFull.calls.map(fingerprint));
  });

  it("outline: detail 'compact' (default) and 'full' produce byte-identical HTTP requests", async () => {
    const transcript = () =>
      fpmTranscript({
        ver: FPM_VER,
        action: "outline",
        outs: [
          outlineOut({
            configId: "BOFU_DEMO_SO_HDR_VIEW",
            configType: "00",
            xml: REAL_OUTLINE_XML,
            component: "FPM_OVP_COMPONENT",
            devclass: "ZFPM_PKG",
          }),
        ],
      });

    const { conn: connCompact, inner: innerCompact } = await connectedFluid({ transcript });
    const { tools: toolsCompact } = await registered(connCompact);
    await invoke(toolsCompact, "abap_fpm_read", { mode: "outline", config_id: "BOFU_DEMO_SO_HDR_VIEW" });

    // See the "find" test above: reset the module-level ensure/package caches and give each
    // subsequent connection its own state-dir, so every run gets a cold deploy and the call
    // counts are comparable.
    resetFluidEnsureState();
    resetFluidPackageMemo();
    await fs.rm(tmp, { recursive: true, force: true });
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-fpm-tools-"));
    const { conn: connFull, inner: innerFull } = await connectedFluid({ transcript });
    const { tools: toolsFull } = await registered(connFull);
    await invoke(toolsFull, "abap_fpm_read", {
      mode: "outline",
      config_id: "BOFU_DEMO_SO_HDR_VIEW",
      detail: "full",
    });

    // xml_offset/xml_limit are render-side only, same invariant as detail — extend the
    // same fingerprint comparison rather than trusting a second, unrelated assertion to catch a regression.
    resetFluidEnsureState();
    resetFluidPackageMemo();
    await fs.rm(tmp, { recursive: true, force: true });
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-fpm-tools-"));
    const { conn: connWindowed, inner: innerWindowed } = await connectedFluid({ transcript });
    const { tools: toolsWindowed } = await registered(connWindowed);
    await invoke(toolsWindowed, "abap_fpm_read", {
      mode: "outline",
      config_id: "BOFU_DEMO_SO_HDR_VIEW",
      xml_offset: 50,
      xml_limit: 200,
    });

    const fingerprint = (o: HttpClientOptions) => ({ method: o.method, url: o.url, qs: o.qs, body: o.body });
    expect(innerCompact.calls.length).toBeGreaterThan(0);
    expect(innerCompact.calls.length).toBe(innerFull.calls.length);
    expect(innerCompact.calls.map(fingerprint)).toEqual(innerFull.calls.map(fingerprint));
    expect(innerCompact.calls.length).toBe(innerWindowed.calls.length);
    expect(innerCompact.calls.map(fingerprint)).toEqual(innerWindowed.calls.map(fingerprint));
  });
});

// ===========================================================================

describe("abap_fpm_read — detail: compact vs full size ratio at realistic scale", () => {
  it("find: 200 rows (A4H-measured scale) — compact is substantially smaller than full", async () => {
    const outs = generateFindRows(200);
    const transcript = () => fpmTranscript({ ver: FPM_VER, action: "find", outs });

    const { conn: connCompact } = await connectedFluid({ transcript });
    const { tools: toolsCompact } = await registered(connCompact, { maxResponseChars: 200_000 });
    const compactText = okText(
      await invoke(toolsCompact, "abap_fpm_read", { mode: "find", component: "FPM_OVP_COMPONENT" }),
    );

    const { conn: connFull } = await connectedFluid({ transcript });
    const { tools: toolsFull } = await registered(connFull, { maxResponseChars: 200_000 });
    const fullText = okText(
      await invoke(toolsFull, "abap_fpm_read", { mode: "find", component: "FPM_OVP_COMPONENT", detail: "full" }),
    );

    expect(compactText).toContain("detail: compact");
    expect(fullText).toContain("detail: full");
    // Neither response was hard-clamped — the ratio below reflects the shapes, not a truncation artifact.
    expect(compactText).not.toContain("OUTPUT HARD-CLAMPED");
    expect(fullText).not.toContain("OUTPUT HARD-CLAMPED");
    // detail:"compact" hoists the constant config_type/config_var/component/devclass fields out of
    // the row table; 0.7 leaves margin over the measured ratio without being toothless.
    expect(compactText.length).toBeLessThan(fullText.length * 0.7);
  });

  it("app: 34 nodes each with a ~300-char excerpt (A4H-measured scale) — compact is substantially smaller than full", async () => {
    const outs = generateAppNodes(34, 300);
    const transcript = () => fpmTranscript({ ver: FPM_VER, action: "app", outs });

    const { conn: connCompact } = await connectedFluid({ transcript });
    const { tools: toolsCompact } = await registered(connCompact, { maxResponseChars: 200_000 });
    const compactText = okText(
      await invoke(toolsCompact, "abap_fpm_read", { mode: "app", config_id: "/BOBF/EPM_FPM_SADL_PD" }),
    );

    const { conn: connFull } = await connectedFluid({ transcript });
    const { tools: toolsFull } = await registered(connFull, { maxResponseChars: 200_000 });
    const fullText = okText(
      await invoke(toolsFull, "abap_fpm_read", {
        mode: "app",
        config_id: "/BOBF/EPM_FPM_SADL_PD",
        detail: "full",
      }),
    );

    expect(compactText).toContain("detail: compact");
    expect(fullText).toContain("detail: full");
    expect(compactText).not.toContain("OUTPUT HARD-CLAMPED");
    expect(fullText).not.toContain("OUTPUT HARD-CLAMPED");
    // Excerpts dominate the full payload and are entirely omitted in compact; 0.6 leaves margin.
    expect(compactText.length).toBeLessThan(fullText.length * 0.6);
  });
});

// ===========================================================================

/**
 * `outline` had no way to ask for less XML, at any size — 22,350
 * chars / ~7,406 tokens for one config on A4H, with no lever to shrink it.
 * `xml_offset`/`xml_limit` are the opt-in character window added to fix that
 * (`src/tools/fpm.ts`'s `buildOutlineResponse`, `FpmXmlWindow`).
 */
describe("abap_fpm_read — outline xml_offset/xml_limit", () => {
  /** Single-line synthetic XML at the same ~22,350-char scale as the real A4H measurement — real outline XML has no embedded newlines either. */
  function generateLargeXml(targetChars: number): string {
    const unit = '<FIELD name="F001" label="Some Field Label Text Padding Value" visible="X"/>';
    let out = "<Component>";
    while (out.length < targetChars) out += unit;
    return out.slice(0, targetChars - "</Component>".length) + "</Component>";
  }

  const LARGE_XML = generateLargeXml(22_350);

  async function outlineTools(
    xml: string,
    maxResponseChars = 200_000,
  ): Promise<Map<string, { config: Record<string, unknown>; handler: (args: unknown) => Promise<CallToolResult> }>> {
    const { conn } = await connectedFluid({
      transcript: () =>
        fpmTranscript({
          ver: FPM_VER,
          action: "outline",
          outs: [
            outlineOut({
              configId: "BOFU_DEMO_SO_HDR_VIEW",
              configType: "00",
              xml,
              component: "FPM_OVP_COMPONENT",
              devclass: "ZFPM_PKG",
            }),
          ],
        }),
    });
    const { tools } = await registered(conn, { maxResponseChars });
    return tools;
  }

  const CALL = (extra: Record<string, unknown> = {}) => ({
    mode: "outline",
    config_id: "BOFU_DEMO_SO_HDR_VIEW",
    ...extra,
  });

  it("default (neither param passed): no window header fields, no WINDOW note", async () => {
    const tools = await outlineTools(REAL_OUTLINE_XML);
    const text = okText(await invoke(tools, "abap_fpm_read", CALL()));

    expect(text).not.toContain("xmlWindowChars");
    expect(text).not.toContain("xmlWindowRange");
    expect(text).not.toContain("xmlNextOffset");
    expect(text).not.toContain("XML WINDOW");
    expect(text).toContain('mode "outline" always returns the raw XML verbatim.');
  });

  it("xml_limit bounds the XML and discloses the cut; xmlChars still reports the FULL length", async () => {
    const tools = await outlineTools(LARGE_XML);
    const text = okText(await invoke(tools, "abap_fpm_read", CALL({ xml_limit: 1000 })));

    expect(text).toContain(`xmlChars: ${LARGE_XML.length}`);
    expect(text).toContain("xmlWindowChars: 1000");
    expect(text).toContain("xmlWindowRange: 0-1000");
    expect(text).toContain("xmlNextOffset: 1000");
    expect(text).toContain("XML WINDOW: chars 0-999");
    expect(text).toContain("pass xml_offset=1000 to continue");
    expect(text).toContain(LARGE_XML.slice(0, 1000));
    expect(text).not.toContain(LARGE_XML.slice(2000, 3000));
  });

  it("xml_offset + xml_limit returns the correct middle slice and names the next offset", async () => {
    const tools = await outlineTools(LARGE_XML);
    const text = okText(await invoke(tools, "abap_fpm_read", CALL({ xml_offset: 5000, xml_limit: 500 })));

    expect(text).toContain("xmlWindowRange: 5000-5500");
    expect(text).toContain("xmlWindowChars: 500");
    expect(text).toContain("xmlNextOffset: 5500");
    expect(text).toContain(LARGE_XML.slice(5000, 5500));
    expect(text).not.toContain(LARGE_XML.slice(0, 100));
  });

  it("xml_offset beyond the document end: no crash, and the response says so instead of silently returning nothing unexplained", async () => {
    const tools = await outlineTools(REAL_OUTLINE_XML);
    const beyond = REAL_OUTLINE_XML.length + 500;
    const text = okText(await invoke(tools, "abap_fpm_read", CALL({ xml_offset: beyond })));

    expect(text).toContain(`xml_offset ${beyond} is beyond the XML length (${REAL_OUTLINE_XML.length})`);
    expect(text).not.toContain("XML WINDOW: chars");
  });

  it("xml_limit larger than the document: everything from the offset comes back, and it says this is the last window", async () => {
    const tools = await outlineTools(REAL_OUTLINE_XML);
    const text = okText(
      await invoke(tools, "abap_fpm_read", CALL({ xml_limit: REAL_OUTLINE_XML.length + 10_000 })),
    );

    expect(text).toContain(`xmlWindowChars: ${REAL_OUTLINE_XML.length}`);
    expect(text).toContain("This is the last window.");
    expect(text).not.toContain("xmlNextOffset");
  });

  it('xml_limit: 0 returns an empty window without crashing and without being confused with "no content"', async () => {
    const tools = await outlineTools(REAL_OUTLINE_XML);
    const text = okText(await invoke(tools, "abap_fpm_read", CALL({ xml_limit: 0 })));

    expect(text).toContain("xmlWindowChars: 0");
    expect(text).toContain("0 chars returned (xml_limit 0)");
    expect(text).not.toContain("No XML content was returned");
  });

  it('mode "find": xml_offset/xml_limit are disclosed as ignored, not silently dropped', async () => {
    const { conn } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "find", outs: [] }),
    });
    const { tools } = await registered(conn);
    const text = okText(
      await invoke(tools, "abap_fpm_read", { mode: "find", component: "FPM_OVP_COMPONENT", xml_limit: 100 }),
    );

    expect(text).toContain('mode "find" ignores xml_offset/xml_limit');
  });

  it('mode "app": xml_offset/xml_limit are disclosed as ignored, not silently dropped', async () => {
    const { conn } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "app", outs: [] }),
    });
    const { tools } = await registered(conn);
    const text = okText(
      await invoke(tools, "abap_fpm_read", {
        mode: "app",
        config_id: "/BOBF/EPM_FPM_SADL_PD",
        xml_offset: 10,
      }),
    );

    expect(text).toContain('mode "app" ignores xml_offset/xml_limit');
  });

  it('mode "locks": xml_offset/xml_limit are disclosed as ignored, not silently dropped', async () => {
    const query: FpmLockInspectQuery = { mode: "locks", configId: "/BOBF/EPM_FPM_SADL_PD", configType: "02" };
    const className = fpmLockBridgeClassName(query);
    const TRANSCRIPT =
      `${LOCK_LINE_PREFIX}SELF owner=[GUSR1] ok=[X]\n` + `${LOCK_LINE_PREFIX}COUNT phase=[inspect] rows=[0]\n`;
    const { conn } = await connected(
      bridgeHappyPath(className, () => resp(200, TRANSCRIPT, { "content-type": "text/plain" })),
    );
    const { tools } = await registered(conn);
    const text = okText(
      await invoke(tools, "abap_fpm_read", {
        mode: "locks",
        config_id: "/BOBF/EPM_FPM_SADL_PD",
        config_type: "02",
        xml_limit: 50,
      }),
    );

    expect(text).toContain('mode "locks" ignores xml_offset/xml_limit');
  });

  it("token-cost: a bounded outline response is substantially smaller than the full response on a ~22,350-char synthetic XML (the real A4H measurement's scale)", async () => {
    const fullText = okText(await invoke(await outlineTools(LARGE_XML), "abap_fpm_read", CALL()));
    const boundedText = okText(
      await invoke(await outlineTools(LARGE_XML), "abap_fpm_read", CALL({ xml_limit: 2000 })),
    );

    expect(fullText).toContain(LARGE_XML);
    expect(boundedText.length).toBeLessThan(fullText.length * 0.2);
  });

  it("discovery: full XML over the token threshold gets a discovery NOTE naming xml_limit/xml_offset", async () => {
    const text = okText(await invoke(await outlineTools(LARGE_XML), "abap_fpm_read", CALL()));
    expect(text).toContain("xml_limit/xml_offset can fetch less");
  });

  it("discovery: a small XML does not get the discovery NOTE", async () => {
    const text = okText(await invoke(await outlineTools("<Component/>"), "abap_fpm_read", CALL()));
    expect(text).not.toContain("xml_limit/xml_offset can fetch less");
  });
});
