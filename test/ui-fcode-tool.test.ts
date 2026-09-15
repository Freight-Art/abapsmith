/**
 * Tool-level tests for `abap_ui mode:"fcode"` (src/tools/ui.ts's `runFcodeTool`).
 * Harness is a trimmed, self-contained copy of test/ui-system-key.test.ts's own
 * idiom (RecordingClient/connected/gate/fakePool/fakeMcp/invoke/okText/registered) —
 * not imported, since that file is owned by another concurrent change; duplicating
 * the small amount needed keeps this file independent of it.
 */
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { registerUiTools, type UiToolDeps } from "../src/tools/ui.js";
import { Journal } from "../src/journal.js";
import { errorResult } from "../src/server.js";
import { uiManifest } from "../src/adt/fluid/builtin/ui.js";
import { FLUID_PACKAGE } from "../src/adt/fluid/package.js";
import { dynamicUiFluidRoute, uiFcodeConsole } from "./helpers/fluid-ui-fake.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
const SESSION_URL = "/sap/bc/adt/compatibility/graph";

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

async function connected(route: (o: HttpClientOptions) => HttpClientResponse): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
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

function fakeMcp(): { mcp: McpServer; tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }> } {
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

function registered(conn: AbapConnection, journal: Journal): Map<string, { handler: (args: unknown) => Promise<CallToolResult> }> {
  const { mcp, tools } = fakeMcp();
  const c = cfg();
  const deps: UiToolDeps = {
    pool: fakePool(conn),
    safety: gate(),
    journal,
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

// No "src" frame here: this fixture only needs to exercise PAI-module/FCODE rendering, which
// none of the frames below depend on. METHOD emit_src (src/adt/fluid/builtin/ui.ts) used to emit
// a bare unquoted integer for a src frame's "line" against a schema that declares every frame's
// "line" as a string; that mismatch is fixed (emit_src now quotes it, like every other frame) —
// see test/fluid-builtin-ui.test.ts's round-trip test.
const FRAMES: readonly unknown[] = [
  { kind: "target", program: "SAPMSVMA", dynpro: "0100", fcode_filter: "" },
  { kind: "flow", index: 1, line: "PROCESS AFTER INPUT." },
  { kind: "pai_module", index: 1, name: "EXIT_COMMAND", at_exit: true, flow_line: 2 },
  { kind: "cua", functions: [{ code: "BACK", text: "Back", type: "E" }], fkeys: [] },
  { kind: "include", name: "SAPMSVMA", lines: 220 },
  { kind: "module", name: "EXIT_COMMAND", include: "SAPMSVMA", line_from: 453, line_to: 458 },
  { kind: "summary", program: "SAPMSVMA", dynpro: "0100", includes: 1, includes_failed: 0, modules: 1, pai_modules: 1, src_lines: 0, truncated: "" },
];

function fcodeHappyPath(): (o: HttpClientOptions) => HttpClientResponse {
  const fluidRoute = dynamicUiFluidRoute({
    transcript: () => uiFcodeConsole(FRAMES),
    packageName: FLUID_PACKAGE,
  });
  return (o: HttpClientOptions) => {
    if (o.url.includes(SESSION_URL)) return resp(200, "<graph/>", LOGIN_HEADERS);
    if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
    if (o.url.includes(DATA_PREVIEW_PATH)) return systemRoleProbeResponse("nonproductive");
    const fluid = fluidRoute(o);
    if (fluid) return fluid;
    return resp(200, "<ok/>", OK_XML);
  };
}

// Frames for a synthetic MODULE MULTI_CASE with TWO top-level CASE ok_code statements (issue
// #101, DEFECT 1) where the first CASE's WHEN 'ONE' branch remaps the dispatch variable with a
// MOVE statement (DEFECT 2) to a literal ('REMAPPED') that only the SECOND CASE recognises. Tracing
// fcode "ONE" end to end through the tool should surface BOTH the WHEN 'ONE' branch (first CASE)
// and, via one-hop remap-following, the WHEN 'REMAPPED' branch (second CASE) with its own PERFORM,
// plus a NOTE line carrying the remap provenance so a reader can see why a branch that doesn't
// literally say 'ONE' is shown.
const MULTI_CASE_MODULE_LINES: readonly string[] = [
  "module multi_case.",
  "case ok_code.",
  "  when 'ONE'.",
  "    move 'REMAPPED' to ok_code.",
  "  when 'TWO'.",
  "    perform handle_two.",
  "endcase.",
  "case ok_code.",
  "  when 'REMAPPED'.",
  "    perform handle_remapped.",
  "  when 'THREE'.",
  "    perform handle_three.",
  "endcase.",
  "endmodule.",
];
const MULTI_CASE_LINE_FROM = 500;
const MULTI_CASE_LINE_TO = MULTI_CASE_LINE_FROM + MULTI_CASE_MODULE_LINES.length - 1;

const MULTI_CASE_FRAMES: readonly unknown[] = [
  { kind: "target", program: "SAPMSVMA", dynpro: "0100", fcode_filter: "" },
  { kind: "flow", index: 1, line: "PROCESS AFTER INPUT." },
  { kind: "pai_module", index: 1, name: "MULTI_CASE", at_exit: false, flow_line: 1 },
  { kind: "cua", functions: [{ code: "ONE", text: "One", type: "E" }], fkeys: [] },
  { kind: "include", name: "SAPMSVMA", lines: MULTI_CASE_LINE_TO },
  { kind: "module", name: "MULTI_CASE", include: "SAPMSVMA", line_from: MULTI_CASE_LINE_FROM, line_to: MULTI_CASE_LINE_TO },
  ...MULTI_CASE_MODULE_LINES.map((text, i) => ({ kind: "src", include: "SAPMSVMA", line: String(MULTI_CASE_LINE_FROM + i), text })),
  {
    kind: "summary",
    program: "SAPMSVMA",
    dynpro: "0100",
    includes: 1,
    includes_failed: 0,
    modules: 1,
    pai_modules: 1,
    src_lines: MULTI_CASE_MODULE_LINES.length,
    truncated: "",
  },
];

function fcodeMultiCasePath(): (o: HttpClientOptions) => HttpClientResponse {
  const fluidRoute = dynamicUiFluidRoute({
    transcript: () => uiFcodeConsole(MULTI_CASE_FRAMES),
    packageName: FLUID_PACKAGE,
  });
  return (o: HttpClientOptions) => {
    if (o.url.includes(SESSION_URL)) return resp(200, "<graph/>", LOGIN_HEADERS);
    if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
    if (o.url.includes(DATA_PREVIEW_PATH)) return systemRoleProbeResponse("nonproductive");
    const fluid = fluidRoute(o);
    if (fluid) return fluid;
    return resp(200, "<ok/>", OK_XML);
  };
}

describe("abap_ui mode:\"fcode\"", () => {
  it("renders PAI modules, the matched branch, and FCODE_NOTES, tracing every function code when fcode is omitted", async () => {
    const { conn } = await connected(fcodeHappyPath());
    const journal = new Journal({ dir: "/tmp/abapsmith-ui-fcode-tool-test", enabled: false, maxEntries: 0, maxAgeDays: 0 }, "A4H");
    const tools = registered(conn, journal);

    const result = await invoke(tools, "abap_ui", { mode: "fcode", program: "SAPMSVMA", dynpro: "0100" });
    const text = okText(result);

    expect(text).toContain("EXIT_COMMAND");
    expect(text).toContain("FCODE BACK");
    expect(text).toContain("Static source analysis only");
    expect(text).toContain("CASE resolution:");
    expect(text).toMatch(/dispatch: none/);
  });

  it("uses the SAME gates as screen (read + a write preflight on uiManifest.entry), not press's extra gates", async () => {
    const { conn } = await connected(fcodeHappyPath());
    const journal = new Journal({ dir: "/tmp/abapsmith-ui-fcode-tool-test", enabled: false, maxEntries: 0, maxAgeDays: 0 }, "A4H");
    const { mcp, tools } = fakeMcp();
    const c = cfg();
    const asserted: Array<{ action: string; target?: unknown }> = [];
    const safety = gate();
    const originalAssert = safety.assert.bind(safety);
    safety.assert = ((action: string, target?: unknown, opts?: unknown) => {
      asserted.push({ action, target });
      return originalAssert(action as never, target as never, opts as never);
    }) as typeof safety.assert;

    const deps: UiToolDeps = {
      pool: fakePool(conn),
      safety,
      journal,
      ensureConnected: async () => {},
      errorResult,
      cfg: { maxResponseChars: 30_000, abapMode: "admin", sid: c.sid, url: c.url, client: c.client, allowUiPress: true },
    };
    registerUiTools(mcp, deps);

    await invoke(tools, "abap_ui", { mode: "fcode", program: "SAPMSVMA", dynpro: "0100" });

    // The tool's own preflight is "read" then "write" against uiManifest.entry - dispatch()
    // (src/adt/fluid/dispatch.ts) then asserts its own "write"/"activate"/"execute" internally
    // while deploying and running the body class. What matters for this test (fcode vs. press) is
    // that every one of those, including "execute", targets the CLAS/OC body class - never a TCODE
    // the way press's own extra assert("execute", { type: "TCODE" }, ...) preflight does.
    expect(asserted[0]).toEqual({ action: "read", target: undefined });
    expect(asserted[1]!.action).toBe("write");
    expect(asserted[1]!.target).toEqual({ name: uiManifest.entry, packageName: FLUID_PACKAGE, type: "CLAS/OC" });
    for (const a of asserted.slice(1)) {
      expect((a.target as { type?: string } | undefined)?.type).not.toBe("TCODE");
    }
    expect(asserted.some((a) => a.action === "execute")).toBe(true); // dispatch()'s own classrun execute, not press's TCODE one
  });

  it("rejects a query with neither tcode nor program+dynpro, with the exact mode:\"fcode\" BAD_INPUT message", async () => {
    const { conn } = await connected(fcodeHappyPath());
    const journal = new Journal({ dir: "/tmp/abapsmith-ui-fcode-tool-test", enabled: false, maxEntries: 0, maxAgeDays: 0 }, "A4H");
    const tools = registered(conn, journal);

    const result = await invoke(tools, "abap_ui", { mode: "fcode" });
    expect(result.isError).toBe(true);
    const text = result.content[0];
    if (!text || text.type !== "text") throw new Error("expected a text content part");
    const parsed = JSON.parse(text.text) as { message: string };
    expect(parsed.message).toBe('mode:"fcode" needs either tcode, or both program and dynpro.');
  });

  it("DEFECT 1 + DEFECT 2 (issue #101): a module with two top-level CASE ok_code blocks and an in-branch MOVE remap renders BOTH branches, with remap provenance as a NOTE", async () => {
    const { conn } = await connected(fcodeMultiCasePath());
    const journal = new Journal({ dir: "/tmp/abapsmith-ui-fcode-tool-test", enabled: false, maxEntries: 0, maxAgeDays: 0 }, "A4H");
    const tools = registered(conn, journal);

    const result = await invoke(tools, "abap_ui", { mode: "fcode", program: "SAPMSVMA", dynpro: "0100", fcode: "ONE" });
    const text = okText(result);

    expect(text).toContain("MODULE MULTI_CASE");
    // Both branches show up under the same module hit: the literal match (first CASE) and the
    // one-hop remap target (second CASE) — a genuine multi-branch result from a single fcode.
    expect(text).toContain("WHEN ONE — lines 502-503");
    expect(text).toContain("WHEN REMAPPED — lines 508-509");
    expect(text).toContain("- line 509: PERFORM handle_remapped");
    // The remap provenance is ALSO surfaced generically via the notes pipeline (buildResponse
    // renders f.notes as "NOTE: ..." lines), in addition to the inline per-branch marker asserted
    // in the next test.
    expect(text).toMatch(/NOTE: fcode "ONE" in module MULTI_CASE: WHEN 'ONE' remaps to 'REMAPPED' at line 503/);
  });

  it("issue #101 follow-up: prints viaRemap provenance on the remapped branch's own WHEN line, leaving the ordinary matched branch's line untouched", async () => {
    const { conn } = await connected(fcodeMultiCasePath());
    const journal = new Journal({ dir: "/tmp/abapsmith-ui-fcode-tool-test", enabled: false, maxEntries: 0, maxAgeDays: 0 }, "A4H");
    const tools = registered(conn, journal);

    const result = await invoke(tools, "abap_ui", { mode: "fcode", program: "SAPMSVMA", dynpro: "0100", fcode: "ONE" });
    const text = okText(result);

    // The remap-pulled branch (WHEN 'REMAPPED', reached because WHEN 'ONE' reassigns ok_code at
    // line 503) carries its viaRemap provenance appended to its own WHEN row.
    expect(text).toContain("WHEN REMAPPED — lines 508-509 — via remap ONE -> REMAPPED at line 503");
    // The ordinary matched branch (WHEN 'ONE' itself, no viaRemap) is rendered byte-for-byte as
    // before: no trailing " — via remap" text on its line.
    const oneLine = text.split("\n").find((l) => l.includes("WHEN ONE — lines 502-503"));
    expect(oneLine).toBe("    WHEN ONE — lines 502-503");
  });
});
