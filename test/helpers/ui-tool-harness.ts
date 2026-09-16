/**
 * Shared tool-level harness for the abap_ui tests added with issue #150
 * (test/ui-screen-compact-tool.test.ts, test/ui-tstc-precheck.test.ts,
 * test/ui-press-route.test.ts). Same idiom as the hand-rolled copies in
 * test/ui-system-key.test.ts and test/ui-press-bal-hint.test.ts — a
 * RecordingClient behind a real AbapConnection, a pass-through pool, and
 * `registerUiTools` captured through a fake McpServer — pulled into one
 * place so three files do not carry a fourth, fifth and sixth copy.
 *
 * Routing order inside `uiRoute` matters: the TSTC select (issue #150's
 * pre-check) is matched on the SQL in the request body BEFORE the generic
 * data-preview branch, which otherwise answers every data-preview POST with
 * the T000 system-role body.
 */
import { expect } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";

import { AbapConnection } from "../../src/adt/connection.js";
import { AuthCircuitBreaker } from "../../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../../src/config.js";
import { SafetyGate } from "../../src/safety.js";
import { UI_LINE_PREFIX } from "../../src/adt/ui-runtime.js";
import { registerUiTools, type UiToolDeps } from "../../src/tools/ui.js";
import { errorResult } from "../../src/server.js";
import { FLUID_PACKAGE } from "../../src/adt/fluid/package.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./system-role-fake.js";
import { dynamicUiFluidRoute, isUiFluidClass, uiScreenConsole } from "./fluid-ui-fake.js";
import { isTstcSelect, tstcSelectResponse, type TstcRow } from "./tstc-select-fake.js";

export const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

export const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
const SESSION_URL = "/sap/bc/adt/compatibility/graph";
export const CLASS_COLLECTION = "/sap/bc/adt/oo/classes";
export const CLASSRUN_PREFIX = "/sap/bc/adt/oo/classrun/";

const LOCK_XML =
  `<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">` +
  `<asx:values><DATA><LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/>` +
  `<CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/>` +
  `<MODIFICATION_SUPPORT>NoModification</MODIFICATION_SUPPORT><SCOPE_MESSAGES/></DATA></asx:values></asx:abap>`;

const PKG_URI = "/sap/bc/adt/packages/%24abapsmith_fluid_api";
const PACKAGE_XML = (name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<pak:package xmlns:pak="http://www.sap.com/adt/packages" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" adtcore:type="DEVC/K">` +
  `<adtcore:packageRef adtcore:name="${name}" adtcore:type="DEVC/K"/>` +
  `<pak:superPackage adtcore:name="$TMP"/>` +
  `</pak:package>`;

export class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

export interface UiRouteOptions {
  /** The `ui.screen` OUT payload every fluid ui classrun answers with. */
  payload: Record<string, unknown>;
  /** Rows the TSTC pre-check select answers with; `[]` = no such transaction. */
  tstc: readonly TstcRow[];
}

/** Login, package, system-role probe, TSTC select, fluid ui store, and the press bridge's own classrun. */
export function uiRoute(opts: UiRouteOptions): (o: HttpClientOptions) => HttpClientResponse {
  const fluidRoute = dynamicUiFluidRoute({
    transcript: () => uiScreenConsole(opts.payload),
    packageName: FLUID_PACKAGE,
  });
  return (o: HttpClientOptions) => {
    const qs = (o.qs ?? {}) as Record<string, string>;
    const method = (o.method ?? "GET").toUpperCase();

    if (o.url.startsWith(CLASSRUN_PREFIX)) {
      const name = o.url.slice(CLASSRUN_PREFIX.length);
      if (isUiFluidClass(name)) {
        const r = fluidRoute(o);
        if (r) return r;
      }
      return resp(200, `${UI_LINE_PREFIX}SUBRC 0\n${UI_LINE_PREFIX}ROWCOUNT 2\n`, { "content-type": "text/plain" });
    }
    if (o.url.includes(SESSION_URL)) return resp(200, "<graph/>", LOGIN_HEADERS);
    if (isTstcSelect(o)) return tstcSelectResponse(opts.tstc);
    if (o.url.includes(DATA_PREVIEW_PATH)) return systemRoleProbeResponse("nonproductive");
    if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
    if (o.url === PKG_URI && method === "GET") return resp(200, PACKAGE_XML(FLUID_PACKAGE), OK_XML);

    const fluid = fluidRoute(o);
    if (fluid) return fluid;

    if (o.url.startsWith(`${CLASS_COLLECTION}/zcl_zmcp_ui_`) && method === "GET" && !qs._action) {
      const r = resp(404, "<exc:exception/>", OK_XML);
      throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
    }
    if (o.url === CLASS_COLLECTION && method === "POST") return resp(200, "", {});
    if (qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
    if (qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (o.url.startsWith(`${CLASS_COLLECTION}/zcl_zmcp_ui_`) && o.url.endsWith("/source/main") && method === "PUT") {
      return resp(200, "", { "content-type": "text/plain" });
    }
    if (o.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
    return resp(200, "<ok/>", OK_XML);
  };
}

export async function connected(
  route: (o: HttpClientOptions) => HttpClientResponse,
): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const inner = new RecordingClient(route);
  const conn = new AbapConnection(cfg(), { httpClient: inner, log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  inner.calls.length = 0;
  return { conn, inner };
}

export const gate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP", "$ABAPSMITH_FLUID_API"],
    allowNamePrefixes: ["*"],
    writesLockedOut: false,
  });

export function fakePool(conn: AbapConnection): UiToolDeps["pool"] {
  return {
    withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    withWrite: <T,>(_op: string, _objectUri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    reserveDebug: () => {
      throw new Error("reserveDebug: not used by abap_ui, and not implemented in this fake.");
    },
  } as unknown as UiToolDeps["pool"];
}

export type ToolMap = Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>;

function fakeMcp(): { mcp: McpServer; tools: ToolMap } {
  const tools: ToolMap = new Map();
  const mcp = {
    registerTool: (name: string, _config: Record<string, unknown>, handler: (args: unknown) => Promise<CallToolResult>) => {
      tools.set(name, { handler });
      return {} as unknown;
    },
  } as unknown as McpServer;
  return { mcp, tools };
}

export function registered(conn: AbapConnection, overrides: Partial<UiToolDeps> = {}): ToolMap {
  const { mcp, tools } = fakeMcp();
  const c = cfg();
  const deps: UiToolDeps = {
    pool: fakePool(conn),
    safety: gate(),
    journal: undefined as unknown as UiToolDeps["journal"],
    ensureConnected: async () => {},
    errorResult,
    cfg: {
      maxResponseChars: 60_000,
      abapMode: "admin",
      sid: c.sid,
      url: c.url,
      client: c.client,
      allowUiPress: true,
    },
    ...overrides,
  };
  registerUiTools(mcp, deps);
  return tools;
}

export async function invoke(tools: ToolMap, name: string, args: unknown): Promise<CallToolResult> {
  const entry = tools.get(name);
  if (!entry) throw new Error(`tool "${name}" was never registered`);
  return entry.handler(args);
}

function firstText(result: CallToolResult): string {
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return text.text;
}

export function okText(result: CallToolResult): string {
  expect(result.isError).toBeFalsy();
  return firstText(result);
}

export interface ErrorPayload {
  error: string;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

export function errPayload(result: CallToolResult): ErrorPayload {
  expect(result.isError).toBe(true);
  return JSON.parse(firstText(result)) as ErrorPayload;
}
