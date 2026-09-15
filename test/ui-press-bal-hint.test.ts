/**
 * Defect 4 (issue #108): `buildPressResponse` (src/tools/ui.ts) used to push
 * the BAL correlation line onto `buildResponse`'s `hints` array. `hints` is
 * only rendered by compact.ts inside a TRUNCATED/WINDOW notice — on an
 * ordinary, well-under-budget response (the common case, and the only mode
 * `abap_ui` executes anything in — `press`) the line was silently dropped.
 * It must now come back as a `notes` entry, which compact.ts always renders.
 *
 * Harness: a trimmed copy of test/ui-system-key.test.ts's own harness (its
 * header explains the fake classrun routing for `press`'s two-bridge
 * choreography — TSTC precheck then BDCDATA press). This file drops the
 * journal-persistence half of that test (mkdtemp/readPersistedEntries) since
 * it is not what's under test here; only the rendered response text is.
 */
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { UI_LINE_PREFIX } from "../src/adt/ui-runtime.js";
import { registerUiTools, type UiToolDeps } from "../src/tools/ui.js";
import { errorResult } from "../src/server.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { dynamicUiFluidRoute, isUiFluidClass, uiScreenConsole } from "./helpers/fluid-ui-fake.js";
import { FLUID_PACKAGE } from "../src/adt/fluid/package.js";

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
const SESSION_URL = "/sap/bc/adt/compatibility/graph";
const CLASS_COLLECTION = "/sap/bc/adt/oo/classes";

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

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

/** Same idiom as test/ui-system-key.test.ts's own `pressHappyPath` — see its doc comment. */
function pressHappyPath(tcode: string): (o: HttpClientOptions) => HttpClientResponse {
  const fluidRoute = dynamicUiFluidRoute({
    transcript: () =>
      uiScreenConsole({
        tcode: {
          tcode,
          program: "SAPMZUI1",
          dynpro: "0100",
          cinfo: "00",
          kind: "dialog transaction",
          bdcApplies: true,
        },
        program: "SAPMZUI1",
        dynpro: "0100",
        fields: [],
      }),
    packageName: FLUID_PACKAGE,
  });

  return (o: HttpClientOptions) => {
    const qs = (o.qs ?? {}) as Record<string, string>;
    const method = (o.method ?? "GET").toUpperCase();

    if (o.url.startsWith("/sap/bc/adt/oo/classrun/")) {
      const name = o.url.slice("/sap/bc/adt/oo/classrun/".length);
      if (isUiFluidClass(name)) {
        const r = fluidRoute(o);
        if (r) return r;
      }
      // The actual press: subrc 0, two BDCDATA rows submitted, no messages.
      return resp(200, `${UI_LINE_PREFIX}SUBRC 0\n${UI_LINE_PREFIX}ROWCOUNT 2\n`, {
        "content-type": "text/plain",
      });
    }
    if (o.url.includes(SESSION_URL)) return resp(200, "<graph/>", LOGIN_HEADERS);
    if (o.url.includes(DATA_PREVIEW_PATH)) return systemRoleProbeResponse("nonproductive");
    if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
    if (o.url === PKG_URI && method === "GET") {
      return resp(200, PACKAGE_XML(FLUID_PACKAGE), { "content-type": "application/xml" });
    }

    const fluid = fluidRoute(o);
    if (fluid) return fluid;

    if (o.url.startsWith(`${CLASS_COLLECTION}/zcl_zmcp_ui_`) && method === "GET" && !qs._action) {
      const r = resp(404, "<exc:exception/>", { "content-type": "application/xml" });
      throw new HttpClientException("Request failed with status code 404", "404", 404, undefined, o, r);
    }
    if (o.url === CLASS_COLLECTION && method === "POST") return resp(200, "", {});
    if (qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
    if (qs._action === "UNLOCK") return resp(200, "", { "content-type": "text/plain" });
    if (o.url.startsWith(`${CLASS_COLLECTION}/zcl_zmcp_ui_`) && o.url.endsWith("/source/main") && method === "PUT") {
      return resp(200, "", { "content-type": "text/plain" });
    }
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

const gate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP", "$ABAPSMITH_FLUID_API"],
    allowNamePrefixes: ["*"],
    writesLockedOut: false,
  });

function fakePool(conn: AbapConnection) {
  return {
    withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    withWrite: <T,>(_op: string, _objectUri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    reserveDebug: () => {
      throw new Error("reserveDebug: not used by abap_ui, and not implemented in this fake.");
    },
  } as unknown as UiToolDeps["pool"];
}

function fakeMcp(): {
  mcp: McpServer;
  tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>;
} {
  const tools = new Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>();
  const mcp = {
    registerTool: (name: string, _config: Record<string, unknown>, handler: (args: unknown) => Promise<CallToolResult>) => {
      tools.set(name, { handler });
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

function okText(result: CallToolResult): string {
  expect(result.isError).toBeFalsy();
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return text.text;
}

function registered(conn: AbapConnection): Map<string, { handler: (args: unknown) => Promise<CallToolResult> }> {
  const { mcp, tools } = fakeMcp();
  const c = cfg();
  const deps: UiToolDeps = {
    pool: fakePool(conn),
    safety: gate(),
    // No journal exercised by this file — press's systemKey behaviour is
    // covered by test/ui-system-key.test.ts; this file is BAL-line only.
    journal: undefined as unknown as UiToolDeps["journal"],
    ensureConnected: async () => {},
    errorResult,
    cfg: {
      maxResponseChars: 30_000,
      abapMode: "admin",
      sid: c.sid,
      url: c.url,
      client: c.client,
      allowUiPress: true,
    },
  };
  registerUiTools(mcp, deps);
  return tools;
}

describe("abap_ui press: the BAL correlation line always reaches the caller (defect 4)", () => {
  it("appears in the rendered text on the normal, non-truncated fast path — not only when truncated", async () => {
    const tcode = "ZUI_TEST";
    const { conn } = await connected(pressHappyPath(tcode));
    const tools = registered(conn);

    const text = okText(
      await invoke(tools, "abap_ui", {
        mode: "press",
        tcode,
        confirm: true,
        screens: [
          {
            program: "SAPMZUI1",
            dynpro: "0100",
            okcode: "=ENTR",
            fields: [{ name: "BKPF-BLDAT", value: "20260101" }],
          },
        ],
      }),
    );

    expect(text).toContain("Application log (BAL) entries this execution may have written");
    expect(text).toMatch(
      /\{"tool":"log","action":"read","args":\{"last_seconds":\d+,"detail":"messages"\}\}/,
    );
  });
});
