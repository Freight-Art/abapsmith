/**
 * Tool-level tests for `abap_fpm_read mode=events` (src/tools/fpm.ts's
 * `buildEventsResponse` + the "events" branch of `buildQuery`/
 * `runFpmReadTool`), for issue #101.
 *
 * Modeled directly on test/fpm-tools.test.ts's own harness (fake `McpServer`,
 * `RecordingClient`-backed `AbapConnection`, `fpmFluidRoute`/`fpmTranscript`
 * from test/helpers/fluid-fpm-fake.ts) — deliberately NOT importing that
 * file's helpers (per this repo's per-file offline harness convention, see
 * that file's own header), just rebuilding the small subset "events" needs.
 *
 * Scope: this file assumes `splitEventFrames`/`resolveFpmEvents` themselves
 * are already correct (test/fpm-events.test.ts covers that in detail against
 * real fixture XML). What is unique to the TOOL layer, and therefore unique
 * to this file, is: response rendering (header/table/notes for "events"),
 * the `uibb` filter reaching the ABAP round trip, the two-phase safety gate,
 * and `runFpmRead`'s `isFpmEventsFrame` guard turning a malformed dispatch
 * result into a structured protocol error rather than a crash.
 *
 * The four EVENTS_COVERAGE_LIMITS strings are asserted here, verbatim,
 * because — per fpm-events.test.ts's own header note — they are NOT part of
 * `resolveFpmEvents`'s `notes`; they are prepended only by
 * `buildEventsResponse` at this layer.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
import { registerFpmTools, type FpmToolDeps } from "../src/tools/fpm.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { fpmFluidRoute, fpmTranscript } from "./helpers/fluid-fpm-fake.js";

const FPM_VER = manifestVersion(fpmManifest, fpmSources);

// ----------------------------------------------------------------------- harness ---
// Copied in shape (not imported) from test/fpm-tools.test.ts — see that
// file's header for why each piece exists.

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-fpm-events-tool-"));
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

// --------------------------------------------------------------------- fixtures ---
// Small, hand-built "events" frames — the same shapes as
// test/fluid-builtin-fpm-events.test.ts's round-trip and
// test/fpm-events.test.ts's raw-frame builders, kept minimal here since this
// file is testing response rendering, not resolution.

// Node/Item shape matches src/adt/fpm-events.ts's actual parser
// (findAllNodesByName looks for <Node Name="..."> elements and walks
// through <Item> children, not literal tag names) — see
// test/fixtures/fpm-events/ovp-appcc-class.config.xml for the real captured
// equivalent of this same TOOLBAR/BUTTON/BUTTON_SUB_ITEM + ACTION shape.
const ROOT_XML =
  `<Component Name="FPM_OVP_COMPONENT" ConfId="EVENTS_TOOL_TEST_ROOT" ConfType="00" ConfVar="">` +
  `<Node Name="TOOLBAR"><Node Name="BUTTON"><Item>` +
  `<ELEMENT_ID>FPM_SAVE</ELEMENT_ID><TYPE>BU</TYPE>` +
  `<Node Name="BUTTON_SUB_ITEM"><Item><ACTION_ID>FPM_SAVE</ACTION_ID></Item></Node>` +
  `</Item></Node></Node>` +
  `<Node Name="ACTION"><Item><ID>FPM_SAVE</ID><EVENT_ID>FPM_SAVE</EVENT_ID></Item></Node>` +
  `</Component>`;

function configFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "config",
    role: "root",
    config_id: "EVENTS_TOOL_TEST_ROOT",
    config_type: "00",
    config_var: "",
    component: "FPM_OVP_COMPONENT",
    devclass: "$TMP",
    xml: ROOT_XML,
    ...overrides,
  };
}

const SUMMARY_FRAME = {
  kind: "summary",
  configs_read: 1,
  configs_failed: 0,
  configs_skipped: 0,
  bopf_nodes: 0,
  bopf_actions: 0,
  fpm_events: 0,
  truncated: "",
};

describe("abap_fpm_read mode=events — response rendering", () => {
  it("names the mode, renders one row per event, and discloses all four EVENTS_COVERAGE_LIMITS notes", async () => {
    const { conn } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "events", outs: [configFrame(), SUMMARY_FRAME] }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", {
      mode: "events",
      config_id: "EVENTS_TOOL_TEST_ROOT",
    });
    const text = okText(result);

    expect(text).toContain("mode: events");
    expect(text).toContain("config_id: EVENTS_TOOL_TEST_ROOT");

    // Issue #101: doc/TOOLS/ui-and-fpm.md promises the source UIBB (config
    // ID, kind, feeder class) — a VIEWS section, rendered BEFORE the EVENTS
    // body, listing every parsed config with its kind/feeder_class/bo/node.
    const viewsIdx = text.indexOf("--- VIEWS ---");
    const eventsIdx = text.indexOf("--- EVENTS ---");
    expect(viewsIdx, "no VIEWS section in rendered output").toBeGreaterThanOrEqual(0);
    expect(eventsIdx, "no EVENTS section in rendered output").toBeGreaterThanOrEqual(0);
    expect(viewsIdx).toBeLessThan(eventsIdx);
    expect(text).toMatch(/config_id\s+kind\s+feeder_class\s+bo\s+node/);
    expect(text).toMatch(/EVENTS_TOOL_TEST_ROOT\s+FPM_OVP_COMPONENT/);

    // One TOOLBAR/BUTTON element (FPM_SAVE) → one row in the EVENTS table,
    // carrying its own view's kind/feeder_class right after config_id.
    expect(text).toContain("--- EVENTS ---");
    expect(text).toMatch(/config_id\s+kind\s+feeder_class\s+source\s+element_id/);
    expect(text).toContain("FPM_SAVE");

    // The four issue-#101 coverage-limit disclosures, verbatim — these live
    // in EVENTS_COVERAGE_LIMITS (src/tools/fpm.ts), not in
    // resolveFpmEvents's own notes; see this file's header comment.
    expect(text).toContain(
      "An application-controller (AppCC) override can intercept or replace any event listed here",
    );
    expect(text).toContain("Personalisation can rebind a toolbar element to a different action at run time");
    expect(text).toContain("Context-based adaptation (CBA) and configuration deltas are not resolved");
    expect(text).toContain(
      "Nothing is executed: this is a trace of saved configuration, not an observation of a real event",
    );
    // Shared with FIDELITY_NOTES/other modes, disclosed alongside the four above.
    expect(text).toContain("XML decoding has only been verified in depth against FORM/LIST UIBBs");
  });

  it("an unresolved handler's row surfaces the raw-element excerpt in the rendered text, not just the reason (issue #101)", async () => {
    // TYPE "ZZ" is not a decoded button type and this element's ID has no
    // matching ACTION catalogue entry, so classifyHandler reports it
    // unresolved. describeHandler (src/tools/fpm.ts) must render the
    // FpmEventHandlerUnresolved.excerpt alongside the reason, not just the
    // reason — this is the tool-level half of issue #101's "never silently
    // dropped" requirement (test/fpm-events.test.ts covers the field itself).
    const mysteryXml =
      `<Component Name="FPM_OVP_COMPONENT" ConfId="EVENTS_TOOL_TEST_MYSTERY" ConfType="00" ConfVar="">` +
      `<Node Name="TOOLBAR"><Node Name="BUTTON"><Item>` +
      `<ELEMENT_ID>MYSTERY_BTN</ELEMENT_ID><TYPE>ZZ</TYPE>` +
      `</Item></Node></Node>` +
      `</Component>`;
    const { conn } = await connectedFluid({
      transcript: () =>
        fpmTranscript({
          ver: FPM_VER,
          action: "events",
          outs: [configFrame({ config_id: "EVENTS_TOOL_TEST_MYSTERY", xml: mysteryXml }), SUMMARY_FRAME],
        }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", {
      mode: "events",
      config_id: "EVENTS_TOOL_TEST_MYSTERY",
    });
    const text = okText(result);

    expect(text).toContain("MYSTERY_BTN");
    expect(text).toContain("unresolved");
    expect(text).toContain("excerpt:");
    // The excerpt itself is a serialisation of the offending raw element —
    // it must actually mention the element's own id, not just the reason.
    expect(text).toMatch(/excerpt:.*MYSTERY_BTN/);
  });

  it("a config with no toolbar/button-row/fbi-action elements renders the explicit empty-body message, not a blank table", async () => {
    const emptyXml = `<Component Name="FPM_OVP_COMPONENT" ConfId="EVENTS_TOOL_TEST_EMPTY" ConfType="00" ConfVar=""/>`;
    const { conn } = await connectedFluid({
      transcript: () =>
        fpmTranscript({
          ver: FPM_VER,
          action: "events",
          outs: [configFrame({ config_id: "EVENTS_TOOL_TEST_EMPTY", xml: emptyXml }), SUMMARY_FRAME],
        }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "events", config_id: "EVENTS_TOOL_TEST_EMPTY" });
    const text = okText(result);

    expect(text).toContain("(no toolbar/button-row/fbi-action elements found)");
  });

  it("detail is passed through but ignored, with a note saying so (events' output is already compact)", async () => {
    const { conn } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "events", outs: [configFrame(), SUMMARY_FRAME] }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", {
      mode: "events",
      config_id: "EVENTS_TOOL_TEST_ROOT",
      detail: "full",
    });
    const text = okText(result);
    expect(text).toContain('mode "events" ignores detail');
  });

  it("xml_offset/xml_limit are accepted (schema-shared with outline) but ignored, with a note saying so", async () => {
    const { conn } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "events", outs: [configFrame(), SUMMARY_FRAME] }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", {
      mode: "events",
      config_id: "EVENTS_TOOL_TEST_ROOT",
      xml_offset: 0,
      xml_limit: 10,
    });
    const text = okText(result);
    expect(text).toContain('mode "events" ignores xml_offset/xml_limit');
  });
});

describe("abap_fpm_read mode=events — bopf/feeder handler rendering (issue #101 Defects 1 & 2)", () => {
  it("renders a bopf handler's node, action and note alongside the abap_bopf follow-up", async () => {
    // Same BUTTON_ROW/BUTTON_ROW_ELEMENT/BUTTON_ACTION + PARAMETER BO/NODE
    // shape as test/fpm-events.test.ts's rowConfigXml helper, but the
    // action deliberately does NOT match any /BOBF/ACT_LIST row supplied
    // below, so buildBopfHandler leaves `action` undefined with a note —
    // exercising describeHandler's full bopf rendering, not just the happy
    // path.
    const bopfXml =
      `<Component Name="X" ConfId="BOPF_TOOL_TEST" ConfType="00" ConfVar="">` +
      `<Node Name="PARAMETER" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<Item Index="000001"><NAME>BO</NAME><VALUE>/BOFU/X</VALUE></Item>` +
      `<Item Index="000002"><NAME>NODE</NAME><VALUE>ITEM</VALUE></Item>` +
      `</Item></Node>` +
      `<Node Name="BUTTON_ROW" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<Node Name="BUTTON_ROW_ELEMENT" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<ELEMENT_ID>ROW_1</ELEMENT_ID><TEXT></TEXT><DISPLAY_TYPE>BT</DISPLAY_TYPE>` +
      `<Node Name="BUTTON_ACTION" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<EVENT_ID>FBI_CREATE</EVENT_ID><TEXT></TEXT></Item></Node>` +
      `</Item></Node></Item></Node></Component>`;
    const { conn } = await connectedFluid({
      transcript: () =>
        fpmTranscript({
          ver: FPM_VER,
          action: "events",
          outs: [
            configFrame({ config_id: "BOPF_TOOL_TEST", xml: bopfXml }),
            { kind: "bopf_node", bo: "/BOFU/X", node_name: "ITEM", node_key: "NODEKEY1", bo_key: "BOKEY1" },
            { kind: "bopf_action", bo: "/BOFU/X", act_name: "CREATE_ITEM", act_key: "ACTKEY1", node_key: "NODEKEY1", act_class: "ZCL_X", act_cat: "1" },
            SUMMARY_FRAME,
          ],
        }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", {
      mode: "events",
      config_id: "BOPF_TOOL_TEST",
      resolve: true,
    });
    const text = okText(result);

    expect(text).toContain("bopf (/BOFU/X, ITEM, ?)");
    expect(text).toContain('follow up: abap_bopf {"mode":"show","bo":"/BOFU/X"}');
    expect(text).toContain("FBI framework event");

    // Issue #101: the PARAMETER Item's NAME=BO/VALUE + NAME=NODE/VALUE pair
    // is this config's own BO/NODE — surfaced on its VIEWS row's bo/node
    // columns (BoNodePair, distinct from the bopf handler's own rendering
    // above, which is derived independently by classifyHandler).
    expect(text).toMatch(/BOPF_TOOL_TEST\s+FPM_OVP_COMPONENT\s+\/BOFU\/X\s+ITEM/);
    // The row's own event carries this view's kind (uibbKind) right after
    // config_id in the EVENTS table too.
    expect(text).toMatch(/BOPF_TOOL_TEST\s+FPM_OVP_COMPONENT/);
  });

  it("renders a feeder handler's interface-qualified method and abap_read follow-up", async () => {
    const feederXml =
      `<Component Name="X" ConfId="FEEDER_TOOL_TEST" ConfType="00" ConfVar="">` +
      `<Node Name="CONFIGURATION_CONTEXT" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<FEEDER>ZCL_MY_TOOL_FEEDER</FEEDER>` +
      `<Node Name="BUTTON_ROW" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<Node Name="BUTTON_ROW_ELEMENT" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<ELEMENT_ID>ROW_1</ELEMENT_ID><TEXT></TEXT><DISPLAY_TYPE>BT</DISPLAY_TYPE>` +
      `<Node Name="BUTTON_ACTION" SimpleFormat="true"><Item Index="000001" SimpleFormat="true">` +
      `<EVENT_ID>MY_EVENT</EVENT_ID><TEXT></TEXT></Item></Node>` +
      `</Item></Node></Item></Node>` +
      `</Item></Node></Component>`;
    const { conn } = await connectedFluid({
      transcript: () =>
        fpmTranscript({
          ver: FPM_VER,
          action: "events",
          outs: [
            configFrame({ config_id: "FEEDER_TOOL_TEST", component: "FPM_LIST_UIBB", xml: feederXml }),
            SUMMARY_FRAME,
          ],
        }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", {
      mode: "events",
      config_id: "FEEDER_TOOL_TEST",
    });
    const text = okText(result);

    expect(text).toContain("feeder ZCL_MY_TOOL_FEEDER method IF_FPM_GUIBB_LIST~PROCESS_EVENT");
    expect(text).toContain(
      'follow up: abap_read {"object":"ZCL_MY_TOOL_FEEDER","method":"IF_FPM_GUIBB_LIST~PROCESS_EVENT"}',
    );

    // Issue #101: this LIST UIBB's own component ("FPM_LIST_UIBB") and its
    // CONFIGURATION_CONTEXT FEEDER both surface on its VIEWS row, and the
    // same two values are joined onto its EVENTS row (uibbKind/feederClass)
    // right after config_id.
    expect(text).toMatch(/FEEDER_TOOL_TEST\s+FPM_LIST_UIBB\s+ZCL_MY_TOOL_FEEDER/);
  });
});

describe("abap_fpm_read mode=events — toolbar text resolution via WDY_CONFIG_COMPT (issue #101 Defect 3)", () => {
  const translXml =
    `<Component Name="X" ConfId="TEXT_TOOL_TEST" ConfType="00" ConfVar="">` +
    `<Node Name="TOOLBAR"><Node Name="BUTTON"><Item>` +
    `<ELEMENT_ID>FPM_SAVE</ELEMENT_ID><TYPE>BU</TYPE><TEXT Transl="true">30</TEXT>` +
    `<Node Name="BUTTON_SUB_ITEM"><Item><ACTION_ID>FPM_SAVE</ACTION_ID></Item></Node>` +
    `</Item></Node></Node>` +
    `<Node Name="ACTION"><Item><ID>FPM_SAVE</ID><EVENT_ID>FPM_SAVE</EVENT_ID></Item></Node>` +
    `</Component>`;

  it("resolves a text_id row to its description, and shows the raw key in a separate TEXT_KEY column", async () => {
    const { conn } = await connectedFluid({
      transcript: () =>
        fpmTranscript({
          ver: FPM_VER,
          action: "events",
          outs: [
            configFrame({ config_id: "TEXT_TOOL_TEST", component: "FPM_OVP_COMPONENT", xml: translXml }),
            { kind: "text_id", config_id: "TEXT_TOOL_TEST", config_type: "00", config_var: "", langu: "E", text_id: "30", description: "Change" },
            { ...SUMMARY_FRAME, text_ids: 1, logon_langu: "E" },
          ],
        }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "events", config_id: "TEXT_TOOL_TEST" });
    const text = okText(result);

    expect(text).toMatch(/\bChange\b/);
    expect(text).toContain("30");
    expect(text).toMatch(/WDY_CONFIG_COMPT.*resolved/);
  });

  it("falls back to the raw numeric key, with a note, when no WDY_CONFIG_COMPT row matches", async () => {
    const { conn } = await connectedFluid({
      transcript: () =>
        fpmTranscript({
          ver: FPM_VER,
          action: "events",
          outs: [configFrame({ config_id: "TEXT_TOOL_TEST", component: "FPM_OVP_COMPONENT", xml: translXml }), SUMMARY_FRAME],
        }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "events", config_id: "TEXT_TOOL_TEST" });
    const text = okText(result);

    expect(text).toMatch(/WDY_CONFIG_COMPT.*no matching row/);
  });
});

describe("abap_fpm_read mode=events — uibb narrows referenced-config reads", () => {
  it("passes uibb through to the ABAP round trip's dispatch args", async () => {
    const { conn, inner } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "events", outs: [configFrame(), SUMMARY_FRAME] }),
    });
    const { tools } = await registered(conn);

    await invoke(tools, "abap_fpm_read", {
      mode: "events",
      config_id: "EVENTS_TOOL_TEST_ROOT",
      uibb: "SOME_CHILD_UIBB",
    });

    // dispatch() (src/adt/fluid/dispatch.ts) bakes the args JSON
    // (canonicalArgsJson) into the deployed invoker class's own source via
    // invokerSource() — a PUT to that invoker's .../source/main, not a
    // classrun POST body. The invoker's class name is content-hashed
    // (invokerName()), so rather than predict it, scan every recorded
    // source-main PUT for the "uibb" key: fpmDispatchArgs
    // (src/adt/fpm-runtime.ts) only includes "uibb" in the JSON at all when
    // the query actually carries one, so finding it here proves the
    // tool-layer input reached that far, without re-testing
    // fpm-runtime.ts's own dispatch-arg construction (covered elsewhere).
    const sourcePuts = inner.calls.filter(
      (c) => (c.method ?? "GET").toUpperCase() === "PUT" && c.url.endsWith("/source/main"),
    );
    expect(sourcePuts.length).toBeGreaterThan(0);

    // invokerSource() (src/adt/fluid/invoke.ts) splits the args JSON into
    // <=90-char raw chunks (ARG_CHUNK_RAW) across several
    // `lv_json = lv_json && \`chunk\`.` lines, so "uibb"/the uibb value
    // could straddle a chunk boundary — reconstruct the full JSON by pulling
    // every chunk back out and concatenating, rather than substring-matching
    // the raw source text (which would be flaky at that boundary).
    const chunkRe = /lv_json = lv_json && `([^`]*)`\./g;
    const reconstructed = sourcePuts
      .map((c) => {
        const body = typeof c.body === "string" ? c.body : "";
        let joined = "";
        for (const m of body.matchAll(chunkRe)) joined += m[1];
        return joined;
      })
      .join("");

    expect(reconstructed).toContain('"uibb"');
    expect(reconstructed).toContain("SOME_CHILD_UIBB");
  });

  it("a referenced config that does not match uibb is reported as SKIPPED, not silently omitted", async () => {
    const rootXmlWithChildRef =
      `<Component Name="FPM_OVP_COMPONENT" ConfId="EVENTS_TOOL_TEST_ROOT" ConfType="00" ConfVar="">` +
      `<Node Name="TOOLBAR"><Node Name="BUTTON"><Item>` +
      `<ELEMENT_ID>OPEN_CHILD</ELEMENT_ID><TYPE>BU</TYPE>` +
      `<Node Name="BUTTON_SUB_ITEM"><Item><ACTION_ID>OPEN_CHILD</ACTION_ID></Item></Node>` +
      `</Item></Node></Node>` +
      `<Node Name="ACTION"><Item><ID>OPEN_CHILD</ID><EVENT_ID>WIRE_TEST_EXPOSABLE_TEST</EVENT_ID>` +
      `<COMPONENT>FPM_LIST_UIBB</COMPONENT><CONFIG_ID>NOT_THE_UIBB_ASKED_FOR</CONFIG_ID></Item></Node>` +
      `</Component>`;
    // role "child" + a "skipped" field (not read_error) is what
    // resolveFpmEvents's own `skipped` filter looks for (src/adt/fpm-events.ts,
    // `raw.configs.filter(c => c.role === "child" && c.skipped !== undefined)`).
    const skippedFrame = {
      kind: "config",
      role: "child",
      config_id: "NOT_THE_UIBB_ASKED_FOR",
      config_type: "00",
      config_var: "",
      skipped: "skipped by uibb filter",
    };
    const { conn } = await connectedFluid({
      transcript: () =>
        fpmTranscript({
          ver: FPM_VER,
          action: "events",
          outs: [configFrame({ xml: rootXmlWithChildRef }), skippedFrame, SUMMARY_FRAME],
        }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", {
      mode: "events",
      config_id: "EVENTS_TOOL_TEST_ROOT",
      uibb: "SOME_OTHER_UIBB",
    });
    const text = okText(result);

    expect(text).toContain("--- SKIPPED ---");
    expect(text).toContain("NOT_THE_UIBB_ASKED_FOR");
    expect(text).toContain("config(s) were skipped by the uibb filter");
  });
});

describe("abap_fpm_read mode=events — input validation and safety gate", () => {
  it("without config_id refuses BAD_INPUT, zero network calls", async () => {
    const { conn, inner } = await connectedFluid({
      transcript: () => {
        throw new Error("should never be reached");
      },
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "events" });
    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(inner.calls).toHaveLength(0);
  });

  it("an injection-shaped config_id (containing an apostrophe) is rejected by the bridge-class-name preflight, zero network calls", async () => {
    const { conn, inner } = await connectedFluid({
      transcript: () => {
        throw new Error("should never be reached");
      },
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "events", config_id: "O'BRIEN" });
    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(inner.calls).toHaveLength(0);
  });

  it("a closed (read-only) safety gate refuses at the write-preflight phase, before ensureConnected/any network call — same gating pattern as outline/app", async () => {
    const { conn, inner } = await connectedFluid({
      transcript: () => {
        throw new Error("should never be reached");
      },
    });
    const { tools } = await registered(conn, { safety: closedGate() });

    const result = await invoke(tools, "abap_fpm_read", { mode: "events", config_id: "EVENTS_TOOL_TEST_ROOT" });
    expect(errorPayload(result).error).toBe("READ_ONLY");
    expect(inner.calls).toHaveLength(0);
  });

  it("a safety fake whose assert('write', ...) throws refuses before any dispatch call reaches the fluid layer", async () => {
    const { conn, inner } = await connectedFluid({
      transcript: () => {
        throw new Error("dispatch must never be reached once the write-preflight assertion has thrown");
      },
    });
    const throwingSafety = {
      assert: (phase: string) => {
        if (phase === "write") {
          throw Object.assign(new Error("synthetic write-preflight refusal"), { code: "READ_ONLY" });
        }
      },
    } as unknown as SafetyGate;
    const { tools } = await registered(conn, { safety: throwingSafety });

    // registerFpmTools wraps the handler in a try/catch that funnels any
    // thrown error through deps.errorResult into an isError:true
    // CallToolResult (see src/tools/fpm.ts's registerTool callback) — it
    // never rejects the returned promise. What matters here is that the
    // write-preflight assertion fired before any network call, not the
    // exact shape errorResult gives a non-AbapError.
    const result = await invoke(tools, "abap_fpm_read", { mode: "events", config_id: "EVENTS_TOOL_TEST_ROOT" });
    expect(result.isError).toBe(true);
    expect(inner.calls).toHaveLength(0);
  });
});

describe("abap_fpm_read mode=events — malformed dispatch result", () => {
  it("a result frame missing/failing the events frame-kind check produces a structured FLUID_PROTOCOL_ERROR, not a crash", async () => {
    // "bogus_kind" is not in FPM_EVENTS_FRAME_KINDS (src/adt/fpm-runtime.ts) —
    // dispatch()'s own array-output check only requires output.type "array"
    // (see test/fluid-builtin-fpm-events.test.ts's manifest test), so a
    // frame like this passes dispatch() and only trips runFpmRead's own
    // isFpmEventsFrame guard.
    const { conn } = await connectedFluid({
      transcript: () =>
        fpmTranscript({ ver: FPM_VER, action: "events", outs: [{ kind: "bogus_kind", oops: true }] }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "events", config_id: "EVENTS_TOOL_TEST_ROOT" });
    const payload = errorPayload(result);
    expect(payload.error).toBe("FLUID_PROTOCOL_ERROR");
  });

  it("a non-object frame in the result array also produces FLUID_PROTOCOL_ERROR rather than throwing an unhandled type error", async () => {
    const { conn } = await connectedFluid({
      transcript: () => fpmTranscript({ ver: FPM_VER, action: "events", outs: ["not-an-object"] }),
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_fpm_read", { mode: "events", config_id: "EVENTS_TOOL_TEST_ROOT" });
    expect(errorPayload(result).error).toBe("FLUID_PROTOCOL_ERROR");
  });
});
