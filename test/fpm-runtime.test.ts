/**
 * Tests for `src/adt/fpm-runtime.ts` — the `abap_fpm_read` adapter onto the
 * static fluid `fpm` tool body (`ZCL_ZMCP_FLUID_FPM`), plus the field
 * validators it still owns for `fpm-lock.ts` and `tools/fpm.ts`'s
 * zero-network preflight.
 *
 * Bridge-generation (`fpmBridgeClassName`/`fpmBridgeSource`) and the legacy
 * `FPM>`-line transcript parser (`parseFpmTranscript`) no longer exist in
 * the source — find/outline/app now run through `dispatch()` against
 * `fluid/builtin/fpm.ts`'s manifest, which owns both the ABAP source and its
 * own transcript-parsing tests (`test/fluid-builtin-fpm.test.ts`). What
 * remains testable here is `runFpmRead` itself: the query -> dispatch-args
 * mapping, the dispatch-result -> `FpmReadResult` envelope/transcript
 * mapping, and the outline not-found diagnostic reconstruction.
 *
 * Harness mirrors `test/fpm-tools.test.ts`'s `connectedFluid` (offline fluid
 * protocol via `helpers/fluid-fpm-fake.ts`), repeated self-contained here
 * per this repo's per-file harness convention.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SafetyGate } from "../src/safety.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { ERR_LINE_PREFIX } from "../src/adt/run.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { manifestVersion } from "../src/adt/fluid/manifest.js";
import { fpmManifest, fpmSources } from "../src/adt/fluid/builtin/fpm.js";
import { fpmFluidRoute, fpmTranscript, fpmTruncatedTranscript, fpmErrTranscript } from "./helpers/fluid-fpm-fake.js";
import {
  assertConfigId,
  assertConfigVar,
  runFpmRead,
  type FpmAppQuery,
  type FpmFindQuery,
  type FpmOutlineQuery,
} from "../src/adt/fpm-runtime.js";

/** `fpm`'s deployed manifest version, so canned transcripts claim the real one dispatch() checks against. */
const FPM_VER = manifestVersion(fpmManifest, fpmSources);

function expectBadInput(fn: () => unknown): AbapError {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e)) {
      expect(e.code).toBe("BAD_INPUT");
      return e;
    }
    throw e;
  }
  throw new Error("expected fn() to throw a BAD_INPUT AbapError");
}

// A representative set of injection-shaped payloads — the single most
// safety-critical property of this file: every one of these strings would,
// if interpolated unescaped into generated ABAP source, either close a
// string literal early or inject a statement separator.
const INJECTION_PAYLOADS = [
  "O'BRIEN",
  "X'; DELETE FROM t99 WHERE 'a'='a",
  "`whoami`",
  "A\"; DROP",
  "A.B",
  "A B",
  "A\nB",
  "A;B",
  "<script>",
  "A%00B",
];

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------

describe("assertConfigId", () => {
  it("accepts a plain config id up to 32 chars", () => {
    expect(assertConfigId("BOFU_DEMO_SO_HDR_VIEW")).toBe("BOFU_DEMO_SO_HDR_VIEW");
    expect(assertConfigId("/BOFU/DEMO_SO_HDR_VIEW")).toBe("/BOFU/DEMO_SO_HDR_VIEW");
    expect(assertConfigId("A".repeat(32))).toBe("A".repeat(32));
  });

  it("rejects a config id longer than 32 chars (WDY_CONFIG_ID is CHAR32) even though it is otherwise plain", () => {
    // 33 plain chars passes assertPlainName's 40-char ABAP-name regex but
    // must still be refused on the field-specific 32-char limit.
    expect(() => assertConfigId("A".repeat(33))).toThrowError(/CHAR32/);
  });

  for (const bad of INJECTION_PAYLOADS) {
    it(`rejects injection-shaped input: ${JSON.stringify(bad)}`, () => {
      expectBadInput(() => assertConfigId(bad));
    });
  }
});

describe("assertConfigVar", () => {
  it("defaults to blank when undefined, and blank passes through", () => {
    expect(assertConfigVar(undefined)).toBe("");
    expect(assertConfigVar("")).toBe("");
    expect(assertConfigVar("   ")).toBe("");
  });

  it("accepts up to 6 letters/digits/underscore", () => {
    expect(assertConfigVar("V1")).toBe("V1");
    expect(assertConfigVar("ABC_12")).toBe("ABC_12");
  });

  it("rejects more than 6 characters", () => {
    expectBadInput(() => assertConfigVar("TOOLONG1"));
  });

  for (const bad of ["V'1", "V`1", "V;1", "V.1", "V/1", "V 1"]) {
    it(`rejects injection-shaped input: ${JSON.stringify(bad)}`, () => {
      expectBadInput(() => assertConfigVar(bad));
    });
  }
});

// ---------------------------------------------------------------------------
// runFpmRead — offline fluid-protocol harness (mirrors test/fpm-tools.test.ts's
// connectedFluid; self-contained per this repo's per-file harness convention)
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-fpm-runtime-"));
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

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

class RecordingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

const SESSION_URL = "/sap/bc/adt/compatibility/graph";
/* `DATAPREVIEW_XML` + `T000_NONPRODUCTIVE` (fixture 087): imported from
 * ./helpers/system-role-fake.js — the productive-system probe is fail-closed,
 * so a fake that must stand for a writable system has to serve these real bytes. */

async function connected(
  route: (o: HttpClientOptions) => HttpClientResponse,
): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
  const inner = new RecordingClient(route);
  const conn = new AbapConnection(cfg(), { httpClient: inner, log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  inner.calls.length = 0;
  return { conn, inner };
}

/** Non-fpm-specific parts of the wire: login/session, discovery, ato settings, the productive-system probe. */
function fpmBaseRoute(o: HttpClientOptions): HttpClientResponse | undefined {
  if (o.url.includes(SESSION_URL)) {
    return resp(200, "<graph/>", { "content-type": "application/xml", "x-csrf-token": "TOKEN123" });
  }
  if (o.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  if (o.url.includes("/ato/settings")) return resp(200, "<settings/>", { "content-type": "application/xml" });
  if (o.url.endsWith("/discovery")) return resp(200, "<service/>", { "content-type": "application/xml" });
  return undefined;
}

async function connectedFluid(opts: { transcript: () => string }): Promise<{ conn: AbapConnection; inner: RecordingClient }> {
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

const allowingGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP", "$ABAPSMITH_FLUID_API"],
    // $ is outside the default Z/Y customer namespace, same as
    // test/fluid-package.test.ts's own gate() — ensureFluidPackage's own DEVC/K create needs this too.
    allowNamePrefixes: ["*"],
    writesLockedOut: false,
  });

// ---------------------------------------------------------------------------
// Canned OUT payloads (Record<string, unknown>, matching builtin/fpm.ts's
// output schemas — see fpm-tools.test.ts's own appNode/outlineOut for the
// pattern this is adapted from)
// ---------------------------------------------------------------------------

function findRow(
  opts: {
    configId?: string;
    configType?: string;
    configVar?: string;
    component?: string;
    description?: string;
    devclass?: string;
  } = {},
): Record<string, string> {
  return {
    config_id: opts.configId ?? "BOFU_DEMO_SO_HDR_VIEW",
    config_type: opts.configType ?? "00",
    config_var: opts.configVar ?? "",
    component: opts.component ?? "FPM_OVP_COMPONENT",
    description: opts.description ?? "Demo",
    devclass: opts.devclass ?? "",
  };
}

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

function appNode(opts: {
  nodePath: string;
  parentPath: string;
  isTop?: boolean;
  nodeName: string;
  description: string;
  componentName?: string;
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
    target_config_id: "",
    is_configurable: true,
    is_customized: false,
    is_enhanced: false,
    is_freestyle_uibb: false,
    is_leaf: opts.isLeaf ?? false,
    ...(opts.resolved ? { resolved: { xml_len: opts.resolved.xmlLen, feeder_hint: opts.resolved.feederHint, bopf_hint: opts.resolved.bopfHint, excerpt: opts.resolved.excerpt } } : {}),
    ...(opts.resolveError !== undefined ? { resolve_error: opts.resolveError } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reconstructing the args JSON dispatch() baked into a generated invoker's
// source — same technique as test/fluid-invoke.test.ts's own
// rebuildFromInvokerSource, repeated self-contained here.
// ---------------------------------------------------------------------------

function unescapeAbapBacktickLiteral(escaped: string): string {
  return escaped.replace(/``/g, "`");
}

function rebuildFromInvokerSource(source: string): string {
  return source
    .split("\n")
    .filter((l) => l.trim().startsWith("lv_json = lv_json && `"))
    .map((l) => {
      const m = /&& `([\s\S]*)`\.$/.exec(l.trim());
      return m ? unescapeAbapBacktickLiteral(m[1]!) : "";
    })
    .join("");
}

/** Finds the PUT to an invoker class's source, identified by its fixed generated-source comment (invoke.ts's `invokerSource`). */
function invokerArgs(calls: readonly HttpClientOptions[], action: string): unknown {
  const marker = `Generated by abapsmith for fluid tool 'fpm', action '${action}'.`;
  const call = calls.find(
    (c) => (c.method ?? "GET").toUpperCase() === "PUT" && c.url.endsWith("/source/main") && (c.body ?? "").includes(marker),
  );
  if (!call) throw new Error(`no invoker PUT found for fpm action '${action}' among ${calls.length} calls`);
  return JSON.parse(rebuildFromInvokerSource(call.body ?? ""));
}

// ---------------------------------------------------------------------------
// Dispatch-args mapping (fpmDispatchArgs, private — verified indirectly via
// the invoker source dispatch() generates from it)
// ---------------------------------------------------------------------------

describe("runFpmRead — dispatch args mapping", () => {
  it("find: maps every set optional field, none omitted", async () => {
    const query: FpmFindQuery = {
      mode: "find",
      configType: "02",
      component: "FPM_OVP_COMPONENT",
      queryPattern: "BOFU_*",
      package: "ZFPM_PKG",
    };
    const { conn, inner } = await connectedFluid({ transcript: () => fpmTranscript({ ver: FPM_VER, action: "find", outs: [] }) });

    await runFpmRead(conn, query, allowingGate());

    expect(invokerArgs(inner.calls, "find")).toEqual({
      config_type: "02",
      component: "FPM_OVP_COMPONENT",
      query: "BOFU_*",
      package: "ZFPM_PKG",
    });
  });

  it("find: an unset optional field is omitted from the args object entirely, not sent as null/undefined", async () => {
    const query: FpmFindQuery = { mode: "find", configType: "00" };
    const { conn, inner } = await connectedFluid({ transcript: () => fpmTranscript({ ver: FPM_VER, action: "find", outs: [] }) });

    await runFpmRead(conn, query, allowingGate());

    expect(invokerArgs(inner.calls, "find")).toEqual({ config_type: "00" });
  });

  it("outline: maps config_id/config_type/config_var", async () => {
    const query: FpmOutlineQuery = { mode: "outline", configId: "BOFU_DEMO_SO_HDR_VIEW", configType: "00", configVar: "V1" };
    const out = outlineOut({ configId: query.configId, configType: query.configType, configVar: query.configVar, xml: "<Component/>" });
    const { conn, inner } = await connectedFluid({ transcript: () => fpmTranscript({ ver: FPM_VER, action: "outline", outs: [out] }) });

    await runFpmRead(conn, query, allowingGate());

    expect(invokerArgs(inner.calls, "outline")).toEqual({
      config_id: "BOFU_DEMO_SO_HDR_VIEW",
      config_type: "00",
      config_var: "V1",
    });
  });

  it("app: resolve:true is passed through", async () => {
    const query: FpmAppQuery = { mode: "app", configId: "/BOBF/EPM_FPM_SADL_PD", resolve: true };
    const { conn, inner } = await connectedFluid({ transcript: () => fpmTranscript({ ver: FPM_VER, action: "app", outs: [] }) });

    await runFpmRead(conn, query, allowingGate());

    expect(invokerArgs(inner.calls, "app")).toEqual({ config_id: "/BOBF/EPM_FPM_SADL_PD", resolve: true });
  });

  it("app: resolve:false is passed through too — resolve is always sent, never omitted", async () => {
    const query: FpmAppQuery = { mode: "app", configId: "/BOBF/EPM_FPM_SADL_PD", resolve: false };
    const { conn, inner } = await connectedFluid({ transcript: () => fpmTranscript({ ver: FPM_VER, action: "app", outs: [] }) });

    await runFpmRead(conn, query, allowingGate());

    expect(invokerArgs(inner.calls, "app")).toEqual({ config_id: "/BOBF/EPM_FPM_SADL_PD", resolve: false });
  });
});

// ---------------------------------------------------------------------------
// Envelope mapping (bridgeClass/bridgeRefreshed/durationMs/outputComplete/bodyBytes)
// ---------------------------------------------------------------------------

describe("runFpmRead — envelope mapping", () => {
  it("bridgeClass is always the static fluid entry class, never a per-call generated name", async () => {
    const { conn } = await connectedFluid({ transcript: () => fpmTranscript({ ver: FPM_VER, action: "find", outs: [] }) });
    const result = await runFpmRead(conn, { mode: "find", configType: "00" }, allowingGate());
    expect(result.bridgeClass).toBe(fpmManifest.entry);
    expect(result.bridgeClass).toBe("ZCL_ZMCP_FLUID_FPM");
  });

  it("bridgeRefreshed is true on first deploy and false once the identical invoker/body are already active", async () => {
    const query: FpmFindQuery = { mode: "find", configType: "00", component: "FPM_OVP_COMPONENT" };
    const { conn } = await connectedFluid({ transcript: () => fpmTranscript({ ver: FPM_VER, action: "find", outs: [] }) });

    const first = await runFpmRead(conn, query, allowingGate());
    expect(first.bridgeRefreshed).toBe(true);

    const second = await runFpmRead(conn, query, allowingGate());
    expect(second.bridgeRefreshed).toBe(false);
  });

  it("durationMs is a non-negative number", async () => {
    const { conn } = await connectedFluid({ transcript: () => fpmTranscript({ ver: FPM_VER, action: "find", outs: [] }) });
    const result = await runFpmRead(conn, { mode: "find", configType: "00" }, allowingGate());
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("outputComplete is true for a non-truncated transcript and false for dispatch's truncated:true END frame", async () => {
    const query: FpmFindQuery = { mode: "find", configType: "00" };
    const rows = [findRow()];

    const { conn: connFull } = await connectedFluid({ transcript: () => fpmTranscript({ ver: FPM_VER, action: "find", outs: rows }) });
    expect((await runFpmRead(connFull, query, allowingGate())).outputComplete).toBe(true);

    const { conn: connTrunc } = await connectedFluid({ transcript: () => fpmTruncatedTranscript({ ver: FPM_VER, action: "find", outs: rows }) });
    expect((await runFpmRead(connTrunc, query, allowingGate())).outputComplete).toBe(false);
  });

  it("bodyBytes is the UTF-8 byte length of the raw dispatch result JSON (multi-byte chars included)", async () => {
    const rows = [findRow({ description: "héllo — unicode" })];
    const { conn } = await connectedFluid({ transcript: () => fpmTranscript({ ver: FPM_VER, action: "find", outs: rows }) });

    const result = await runFpmRead(conn, { mode: "find", configType: "00" }, allowingGate());

    expect(result.bodyBytes).toBe(Buffer.byteLength(JSON.stringify(rows), "utf8"));
    expect(result.bodyBytes).toBeGreaterThan(rows.length ? JSON.stringify(rows).length - 1 : 0);
  });
});

// ---------------------------------------------------------------------------
// Result field mapping per mode
// ---------------------------------------------------------------------------

describe("runFpmRead — result field mapping per mode", () => {
  it("find: rows map 1:1 into transcript.configs, and count is always rows.length (the fluid body applies the package filter before emitting, so there is no separate pre-filter total any more)", async () => {
    const rows = [findRow({ configId: "CFG_A" }), findRow({ configId: "CFG_B", devclass: "ZFPM_PKG" })];
    const { conn } = await connectedFluid({ transcript: () => fpmTranscript({ ver: FPM_VER, action: "find", outs: rows }) });

    const result = await runFpmRead(conn, { mode: "find", configType: "00" }, allowingGate());

    expect(result.transcript.count).toBe(2);
    expect(result.transcript.configs).toEqual([
      { configId: "CFG_A", configType: "00", configVar: "", component: "FPM_OVP_COMPONENT", description: "Demo", devclass: "" },
      { configId: "CFG_B", configType: "00", configVar: "", component: "FPM_OVP_COMPONENT", description: "Demo", devclass: "ZFPM_PKG" },
    ]);
    expect(result.transcript.outlineXml).toBeUndefined();
    expect(result.transcript.appNodes).toEqual([]);
    expect(result.transcript.diagnostics).toEqual([]);
    expect(result.transcript.droppedLines).toBe(0);
  });

  it("outline: xml/meta map into transcript.outlineXml/outlineMeta verbatim", async () => {
    const out = outlineOut({
      configId: "BOFU_DEMO_SO_HDR_VIEW",
      configType: "00",
      xml: "<Component/>\nwith an embedded newline",
      component: "FPM_OVP_COMPONENT",
      devclass: "ZFPM_PKG",
      configIdPar: "PARENT_CONFIG",
    });
    const { conn } = await connectedFluid({ transcript: () => fpmTranscript({ ver: FPM_VER, action: "outline", outs: [out] }) });

    const result = await runFpmRead(
      conn,
      { mode: "outline", configId: "BOFU_DEMO_SO_HDR_VIEW", configType: "00", configVar: "" },
      allowingGate(),
    );

    expect(result.transcript.outlineXml).toBe("<Component/>\nwith an embedded newline");
    expect(result.transcript.outlineMeta).toEqual({
      configIdPar: "PARENT_CONFIG",
      configTypePar: "",
      configVarPar: "",
      component: "FPM_OVP_COMPONENT",
      devclass: "ZFPM_PKG",
    });
    expect(result.transcript.configs).toEqual([]);
    expect(result.transcript.appNodes).toEqual([]);
    expect(result.transcript.count).toBeUndefined();
  });

  it("app: node fields map snake_case -> camelCase, resolved passes through, and a per-node resolve_error becomes a diagnostic without failing the whole call", async () => {
    const ok = appNode({
      nodePath: "APPLICATION_CONFIGURATION",
      parentPath: "",
      isTop: true,
      nodeName: "CONFIGURATION_CONTEXT",
      description: "Application Configuration",
      resolved: { xmlLen: 5, feederHint: true, bopfHint: false, excerpt: "<x/>" },
    });
    const failed = appNode({
      nodePath: "CONFIGURATION_CONTEXT.000001.OVP_APPLICATION",
      parentPath: "APPLICATION_CONFIGURATION",
      nodeName: "OVP_APPLICATION",
      description: "Overview Page",
      isLeaf: true,
      resolveError: "Configuration does not exist",
    });
    const { conn } = await connectedFluid({ transcript: () => fpmTranscript({ ver: FPM_VER, action: "app", outs: [ok, failed] }) });

    const result = await runFpmRead(conn, { mode: "app", configId: "/BOBF/EPM_FPM_SADL_PD", resolve: true }, allowingGate());

    expect(result.transcript.count).toBe(2);
    expect(result.transcript.appNodes).toHaveLength(2);
    expect(result.transcript.appNodes[0]).toMatchObject({
      nodePath: "APPLICATION_CONFIGURATION",
      isTopNode: true,
      nodeName: "CONFIGURATION_CONTEXT",
      resolved: { xmlLen: 5, feederHint: true, bopfHint: false, excerpt: "<x/>" },
    });
    expect(result.transcript.appNodes[1]).toMatchObject({
      nodePath: "CONFIGURATION_CONTEXT.000001.OVP_APPLICATION",
      isLeaf: true,
      resolved: undefined,
    });
    expect(result.transcript.diagnostics).toEqual([
      `${ERR_LINE_PREFIX}RESOLVE CONFIGURATION_CONTEXT.000001.OVP_APPLICATION FAILED Configuration does not exist`,
    ]);
    expect(result.transcript.droppedLines).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// outline not-found diagnostic (outlineNotFoundDiagnostic — the only
// error-shape narrowing left in this file after the reroute)
// ---------------------------------------------------------------------------

describe("runFpmRead — outline not-found diagnostic", () => {
  it("subrc/select shape (WDY_CONFIG_APPL not-found) becomes the legacy diagnostic line, with an empty-but-complete result", async () => {
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

    const result = await runFpmRead(conn, { mode: "outline", configId: "NOPE", configType: "02", configVar: "" }, allowingGate());

    expect(result.transcript.diagnostics).toEqual([`${ERR_LINE_PREFIX}wdy_config_appl: no matching row for the given key`]);
    expect(result.transcript.outlineXml).toBeUndefined();
    expect(result.transcript.configs).toEqual([]);
    expect(result.bridgeClass).toBe(fpmManifest.entry);
    expect(result.bridgeRefreshed).toBe(false);
    expect(result.outputComplete).toBe(true);
    expect(result.bodyBytes).toBe(0);
  });

  it("exception/read_comp_config_from_db shape becomes the legacy diagnostic line", async () => {
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

    const result = await runFpmRead(conn, { mode: "outline", configId: "NOPE", configType: "00", configVar: "" }, allowingGate());

    expect(result.transcript.diagnostics).toEqual([`${ERR_LINE_PREFIX}READ_COMP_CONFIG_FROM_DB FAILED Configuration does not exist`]);
  });

  it("any other ERR shape is rethrown as FLUID_ACTION_FAILED, not silently swallowed into an empty result", async () => {
    const { conn } = await connectedFluid({
      transcript: () =>
        fpmErrTranscript({ ver: FPM_VER, action: "outline", kind: "exception", step: "some_other_step", text: "unexpected" }),
    });

    await expect(
      runFpmRead(conn, { mode: "outline", configId: "X", configType: "00", configVar: "" }, allowingGate()),
    ).rejects.toMatchObject({ code: "FLUID_ACTION_FAILED" });
  });

  it("find/app modes do not apply the outline special-casing — any dispatch failure propagates untouched", async () => {
    const { conn } = await connectedFluid({
      transcript: () => fpmErrTranscript({ ver: FPM_VER, action: "find", kind: "subrc", step: "select", text: "boom" }),
    });

    await expect(runFpmRead(conn, { mode: "find", configType: "00" }, allowingGate())).rejects.toMatchObject({
      code: "FLUID_ACTION_FAILED",
    });
  });
});
