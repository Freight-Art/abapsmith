/**
 * `dispatch` offline against a hand-rolled recording `HttpClient` — same
 * idiom as `test/fluid-ensure.test.ts`, generalized to a dynamic route that
 * auto-vivifies class state by name (dispatch's own invoker class name is
 * content-hash-derived, so it cannot be known ahead of time the way
 * `fluid-ensure.test.ts`'s static store can).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { systemKey } from "../src/journal.js";
import { Journal } from "../src/journal.js";
import { dispatch, type FluidDeps, type FluidRunRequest } from "../src/adt/fluid/dispatch.js";
import { resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { readFluidRegistry, recordManifest } from "../src/adt/fluid/registry.js";
import { canonicalArgsJson, invokerName, invokerSource } from "../src/adt/fluid/invoke.js";
import {
  manifestVersion,
  type FluidActionSpec,
  type FluidManifest,
  type LoadedFluidTool,
} from "../src/adt/fluid/manifest.js";

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

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  return undefined;
}

let tmp: string;

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

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-fluid-dispatch-"));
  resetFluidEnsureState();
  resetFluidPackageMemo();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function cfg(overrides: Partial<Config> = {}): Config {
  const { abapMode, ...rest } = overrides;
  const base = ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
    fluidApi: true,
    stateDir: tmp,
    ...rest,
  });
  return abapMode !== undefined ? { ...base, abapMode } : base;
}

const gate = (): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"] });

async function catchErr(p: Promise<unknown>): Promise<AbapError> {
  try {
    await p;
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected a rejection");
}

const classUri = (name: string): string => `/sap/bc/adt/oo/classes/${name.toLowerCase()}`;
const CLS_COLLECTION = "/sap/bc/adt/oo/classes";
const PKG_URI = "/sap/bc/adt/packages/%24abapsmith_fluid_api";
const PACKAGES = "/sap/bc/adt/packages";
const CLASSRUN_BASE = "/sap/bc/adt/oo/classrun/";

const notFoundXml = (name: string): string =>
  `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
  `<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>` +
  `<message lang="EN">${name} does not exist</message><properties/></exc:exception>`;

const CHECKRUN_CLEAN_XML =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:atom="http://www.w3.org/2005/Atom"/>`;

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

/**
 * Auto-vivifying class store: unlike fluid-ensure.test.ts's static
 * pre-declared store, this learns object names from the request URL on
 * first sight — necessary because the invoker class name is content-hash
 * derived and cannot be known before `dispatch` computes it.
 */
function dynamicFluidRoute(opts: { transcript: () => string }): { route: Route; store: Map<string, ObjState> } {
  const store = new Map<string, ObjState>();
  const at = (name: string): ObjState => {
    let st = store.get(name);
    if (!st) {
      st = { exists: false, packageName: "$TMP", active: false };
      store.set(name, st);
    }
    return st;
  };

  const route: Route = (r) => {
    if (r.url === PKG_URI && r.method === "GET") return resp(200, PACKAGE_XML(FLUID_PACKAGE), OK_XML);
    if (r.url === PACKAGES && r.method === "POST") return resp(200, "", OK_TEXT);
    // Only reachable once a test redeploys an object that already exists+active (e.g. a forced
    // recovery retry re-classifying what the first attempt just deployed) — classifyOne's
    // "already there, verify content" branch runs a checkruns syntax check before trusting it.
    if (r.url.startsWith("/sap/bc/adt/checkruns") && r.method === "POST") return resp(200, CHECKRUN_CLEAN_XML, OK_XML);

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

  return { route, store };
}

// Mirrors fluid-ensure.test.ts's `mutations()`, plus the literal `_action=LOCK`
// URL-substring clause from test/run.test.ts's own idiom — belt and suspenders,
// since LOCK/UNLOCK land as GET+qs._action here rather than as PUT/POST/DELETE.
function mutations(calls: readonly Recorded[]): Recorded[] {
  return calls.filter(
    (c) => c.method === "PUT" || c.method === "POST" || c.method === "DELETE" || String(c.url).includes("_action=LOCK"),
  );
}

function makeManifestTool(opts: {
  id: string;
  className: string;
  actions: readonly FluidActionSpec[];
  origin?: "builtin" | "plugin";
}): LoadedFluidTool {
  const cls = opts.className.toLowerCase();
  const source = `CLASS ${cls} DEFINITION PUBLIC.\nENDCLASS.\nCLASS ${cls} IMPLEMENTATION.\nENDCLASS.`;
  const manifest: FluidManifest = {
    contract: "1.0",
    id: opts.id,
    title: "test tool",
    description: "fluid-dispatch.test.ts fixture",
    objects: [{ name: opts.className, type: "CLAS/OC", description: "obj", source: { text: source } }],
    entry: opts.className,
    actions: opts.actions,
  };
  const sources = new Map([[opts.className, source]]);
  return { manifest, origin: opts.origin ?? "builtin", sources, version: manifestVersion(manifest, sources) };
}

function frameLine(name: string, payload: unknown): string {
  return `ZMCP-H>${name} ${JSON.stringify(payload)}`;
}

function buildTranscript(opts: {
  id?: string;
  ver: string;
  action: string;
  outs?: readonly unknown[];
  errs?: readonly { kind: "subrc" | "exception" | "message"; step: string; text: string }[];
  end?: { rc?: number; outBytes?: number; truncated?: boolean; ms?: number } | null;
}): string {
  const lines: string[] = [];
  lines.push(frameLine("BEGIN", { id: opts.id ?? "t", ver: opts.ver, action: opts.action, contract: "1.0" }));
  for (const v of opts.outs ?? []) lines.push(frameLine("OUT", v));
  for (const e of opts.errs ?? []) lines.push(frameLine("ERR", e));
  if (opts.end !== null) {
    const end = { rc: 0, outBytes: 0, truncated: false, ms: 1, ...(opts.end ?? {}) };
    lines.push(frameLine("END", end));
  }
  return lines.join("\n") + "\n";
}

const READ_ACTION: FluidActionSpec = {
  name: "run",
  category: "execute",
  description: "run",
  input: { type: "object" },
  output: { type: "object" },
};

const STRING_ACTION: FluidActionSpec = {
  name: "run",
  category: "execute",
  description: "run, returning a string",
  input: { type: "object" },
  output: { type: "string" },
};

const MUTATE_ACTION: FluidActionSpec = {
  name: "commit",
  category: "mutate",
  description: "mutate",
  input: { type: "object" },
  output: { type: "object" },
};

const VOID_ACTION: FluidActionSpec = {
  name: "run",
  category: "execute",
  description: "run, declaring no output at all",
  input: { type: "object" },
  output: {},
};

const MUTATE_STRICT_OUTPUT_ACTION: FluidActionSpec = {
  name: "commit",
  category: "mutate",
  description: "mutate, with an output schema the fixture transcript will violate",
  input: { type: "object" },
  output: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
};

const TARGETED_ACTION: FluidActionSpec = {
  name: "run",
  category: "execute",
  description: "run against a declared target",
  input: { type: "object", properties: { obj: { type: "string" } }, required: ["obj"] },
  output: { type: "object" },
  targets: { object: "/obj" },
};

function depsFor(
  conn: AbapConnection,
  g: SafetyGate,
  tool: LoadedFluidTool,
  overrides: Partial<Pick<FluidDeps, "cfg" | "journal" | "warn">> = {},
): FluidDeps {
  return {
    conn,
    cfg: overrides.cfg ?? cfg(),
    gate: g,
    tools: new Map([[tool.manifest.id, tool]]),
    ...(overrides.journal ? { journal: overrides.journal } : {}),
    ...(overrides.warn ? { warn: overrides.warn } : {}),
  };
}

describe("dispatch — enable gates", () => {
  it("refuses when the fluid flag is off, with zero mutations on wire", async () => {
    const tool = makeManifestTool({ id: "flagoff", className: "ZCL_FLAGOFF", actions: [READ_ACTION] });
    const { route } = dynamicFluidRoute({
      transcript: () => buildTranscript({ ver: tool.version, action: "run", outs: [{}] }),
    });
    const { conn, adt } = await connected(route);
    const d = depsFor(conn, gate(), tool, { cfg: cfg({ fluidApi: false }) });

    const err = await catchErr(dispatch(d, { tool: tool.manifest.id, action: "run", args: {} }));

    expect(err.code).toBe("FLUID_API_DISABLED");
    expect(mutations(adt.calls)).toEqual([]);
    expect(adt.calls).toEqual([]);
  });

  it("refuses in read-only mode (abapMode: read), FLUID_API_DISABLED, zero mutations", async () => {
    const tool = makeManifestTool({ id: "romode", className: "ZCL_ROMODE", actions: [READ_ACTION] });
    const { route } = dynamicFluidRoute({
      transcript: () => buildTranscript({ ver: tool.version, action: "run", outs: [{}] }),
    });
    const { conn, adt } = await connected(route);
    const d = depsFor(conn, gate(), tool, { cfg: cfg({ abapMode: "read" }) });

    const err = await catchErr(dispatch(d, { tool: tool.manifest.id, action: "run", args: {} }));

    expect(err.code).toBe("FLUID_API_DISABLED");
    expect(mutations(adt.calls)).toEqual([]);
    expect(adt.calls).toEqual([]);
  });
});

describe("dispatch — targets reach the gate before any invoker exists", () => {
  it("gates the action's own resolved target before issuing any HTTP request", async () => {
    const tool = makeManifestTool({ id: "ordtool", className: "ZCL_ORDTOOL", actions: [TARGETED_ACTION] });
    const { route } = dynamicFluidRoute({
      transcript: () => buildTranscript({ id: tool.manifest.id, ver: tool.version, action: "run", outs: [{}] }),
    });
    const { conn, adt } = await connected(route);
    const g = gate();
    const original = g.assert.bind(g);
    const httpCountsAtAssert: number[] = [];
    vi.spyOn(g, "assert").mockImplementation((...args: Parameters<SafetyGate["assert"]>) => {
      httpCountsAtAssert.push(adt.calls.length);
      return original(...args);
    });
    const d = depsFor(conn, g, tool);

    const result = await dispatch(d, { tool: tool.manifest.id, action: "run", args: { obj: "ZFOO_BAR" } });

    expect(result.result).toEqual({});
    expect(httpCountsAtAssert.length).toBeGreaterThan(0);
    expect(httpCountsAtAssert[0]).toBe(0);
  });
});

describe("dispatch — transcript protocol", () => {
  it("an ERR frame produces FLUID_ACTION_FAILED with the frame details", async () => {
    const tool = makeManifestTool({ id: "errframe", className: "ZCL_ERRFRAME", actions: [READ_ACTION] });
    const { route } = dynamicFluidRoute({
      transcript: () =>
        buildTranscript({
          ver: tool.version,
          action: "run",
          errs: [{ kind: "exception", step: "run", text: "boom" }],
          end: { rc: 8 },
        }),
    });
    const { conn } = await connected(route);
    const d = depsFor(conn, gate(), tool);

    const err = await catchErr(dispatch(d, { tool: tool.manifest.id, action: "run", args: {} }));

    expect(err.code).toBe("FLUID_ACTION_FAILED");
    expect(err.details["frames"]).toEqual([{ kind: "exception", step: "run", text: "boom" }]);
  });

  // A mid-run abort after the invoker's CATCH arm prints ERR but never reaches END: this must
  // still read as the plugin's own failure (with its frames attached), not a bare protocol error.
  it("BEGIN, ERR with no END raises FLUID_ACTION_FAILED, not a protocol error", async () => {
    const tool = makeManifestTool({ id: "errnoend", className: "ZCL_ERRNOEND", actions: [READ_ACTION] });
    const { route } = dynamicFluidRoute({
      transcript: () =>
        buildTranscript({
          id: tool.manifest.id,
          ver: tool.version,
          action: "run",
          errs: [{ kind: "exception", step: "run", text: "boom" }],
          end: null,
        }),
    });
    const { conn } = await connected(route);
    const d = depsFor(conn, gate(), tool);

    const err = await catchErr(dispatch(d, { tool: tool.manifest.id, action: "run", args: {} }));

    expect(err.code).toBe("FLUID_ACTION_FAILED");
    expect(err.details["frames"]).toEqual([{ kind: "exception", step: "run", text: "boom" }]);
  });

  it("no END frame throws instead of a bogus empty success", async () => {
    const tool = makeManifestTool({ id: "noendtool", className: "ZCL_NOEND", actions: [READ_ACTION] });
    const { route } = dynamicFluidRoute({
      transcript: () => buildTranscript({ ver: tool.version, action: "run", end: null }),
    });
    const { conn } = await connected(route);
    const d = depsFor(conn, gate(), tool);

    const err = await catchErr(dispatch(d, { tool: tool.manifest.id, action: "run", args: {} }));

    expect(err.code).toBe("FLUID_PROTOCOL_ERROR");
  });

  // Distinct from the case above: exactly one OUT value is present (so the
  // output-value-count check can't accidentally also catch a missing END),
  // isolating the missing-END check as the only thing standing between this
  // transcript and a bogus success.
  it("no END frame throws even when a single valid output value is present", async () => {
    const tool = makeManifestTool({ id: "noendval", className: "ZCL_NOENDVAL", actions: [READ_ACTION] });
    const { route } = dynamicFluidRoute({
      transcript: () => buildTranscript({ ver: tool.version, action: "run", outs: [{}], end: null }),
    });
    const { conn } = await connected(route);
    const d = depsFor(conn, gate(), tool);

    const err = await catchErr(dispatch(d, { tool: tool.manifest.id, action: "run", args: {} }));

    expect(err.code).toBe("FLUID_PROTOCOL_ERROR");
  });

  it("a BEGIN.ver mismatch forgets the registry entry, redeploys once, and succeeds once the retry's transcript matches", async () => {
    const NAME = "ZCL_VERMIS_OK";
    const tool = makeManifestTool({ id: "vermisok", className: NAME, actions: [READ_ACTION] });
    let transcriptCalls = 0;
    const { route } = dynamicFluidRoute({
      transcript: () => {
        transcriptCalls++;
        const ver = transcriptCalls === 1 ? "deadbeef" : tool.version;
        return buildTranscript({ id: tool.manifest.id, ver, action: "run", outs: [{}] });
      },
    });
    const { conn } = await connected(route);
    const sysKey = systemKey(conn.cfg);
    await recordManifest(cfg(), sysKey, {
      toolId: tool.manifest.id,
      contract: tool.manifest.contract,
      version: "00000000",
      objects: [NAME],
      deployedAt: new Date().toISOString(),
    });
    const d = depsFor(conn, gate(), tool);

    const result = await dispatch(d, { tool: tool.manifest.id, action: "run", args: {} });

    expect(result.result).toEqual({});
    expect(result.version).toBe(tool.version);
    // Exactly one retry: the mismatched first BEGIN.ver triggers exactly one forget +
    // redeploy + re-run, evidenced by exactly two classrun executions, never a loop.
    expect(transcriptCalls).toBe(2);
    const registry = await readFluidRegistry(cfg(), sysKey);
    expect(registry.get(tool.manifest.id)?.version).toBe(tool.version);
  });

  it("a BEGIN.ver mismatch that persists after the redeploy raises FLUID_PROTOCOL_ERROR naming expected/got", async () => {
    const NAME = "ZCL_VERMIS_STILL";
    const tool = makeManifestTool({ id: "vermisstill", className: NAME, actions: [READ_ACTION] });
    let transcriptCalls = 0;
    const { route } = dynamicFluidRoute({
      transcript: () => {
        transcriptCalls++;
        return buildTranscript({ id: tool.manifest.id, ver: "deadbeef", action: "run", outs: [{}] });
      },
    });
    const { conn } = await connected(route);
    const sysKey = systemKey(conn.cfg);
    await recordManifest(cfg(), sysKey, {
      toolId: tool.manifest.id,
      contract: tool.manifest.contract,
      version: "00000000",
      objects: [NAME],
      deployedAt: new Date().toISOString(),
    });
    const d = depsFor(conn, gate(), tool);

    const err = await catchErr(dispatch(d, { tool: tool.manifest.id, action: "run", args: {} }));

    expect(err.code).toBe("FLUID_PROTOCOL_ERROR");
    expect(err.details["expected"]).toBe(tool.version);
    expect(err.details["got"]).toBe("deadbeef");
    // Exactly one retry, never a loop: two classrun executions total.
    expect(transcriptCalls).toBe(2);
    // The stale pre-existing "00000000" lie does not survive: forgetManifest ran inside the
    // retry's recovery, and the redeploy that followed recorded a fresh, correct entry — the
    // registry is not left holding the original lie even though the call still failed.
    const registry = await readFluidRegistry(cfg(), sysKey);
    const entry = registry.get(tool.manifest.id);
    expect(entry?.version).toBe(tool.version);
    expect(entry?.version).not.toBe("00000000");
  });

  it("a BEGIN.id mismatch raises FLUID_PROTOCOL_ERROR naming what was requested and what came back", async () => {
    const tool = makeManifestTool({ id: "idmis", className: "ZCL_IDMIS", actions: [READ_ACTION] });
    const { route } = dynamicFluidRoute({
      transcript: () => buildTranscript({ id: "someoneelse", ver: tool.version, action: "run", outs: [{}] }),
    });
    const { conn } = await connected(route);
    const d = depsFor(conn, gate(), tool);

    const err = await catchErr(dispatch(d, { tool: tool.manifest.id, action: "run", args: {} }));

    expect(err.code).toBe("FLUID_PROTOCOL_ERROR");
    expect(err.details["beginId"]).toBe("someoneelse");
    expect(err.details["tool"]).toBe(tool.manifest.id);
  });

  it("a BEGIN.action mismatch raises FLUID_PROTOCOL_ERROR naming what was requested and what came back", async () => {
    const tool = makeManifestTool({ id: "actmis", className: "ZCL_ACTMIS", actions: [READ_ACTION] });
    const { route } = dynamicFluidRoute({
      transcript: () => buildTranscript({ id: tool.manifest.id, ver: tool.version, action: "other", outs: [{}] }),
    });
    const { conn } = await connected(route);
    const d = depsFor(conn, gate(), tool);

    const err = await catchErr(dispatch(d, { tool: tool.manifest.id, action: "run", args: {} }));

    expect(err.code).toBe("FLUID_PROTOCOL_ERROR");
    expect(err.details["beginAction"]).toBe("other");
    expect(err.details["action"]).toBe("run");
  });
});

describe("dispatch — END with neither OUT nor ERR", () => {
  it("a non-void output schema raises FLUID_PROTOCOL_ERROR when END carries no OUT frames", async () => {
    const tool = makeManifestTool({ id: "silentend", className: "ZCL_SILENTEND", actions: [READ_ACTION] });
    const { route } = dynamicFluidRoute({
      transcript: () => buildTranscript({ id: tool.manifest.id, ver: tool.version, action: "run" }),
    });
    const { conn } = await connected(route);
    const d = depsFor(conn, gate(), tool);

    const err = await catchErr(dispatch(d, { tool: tool.manifest.id, action: "run", args: {} }));

    expect(err.code).toBe("FLUID_PROTOCOL_ERROR");
    expect(err.details["count"]).toBe(0);
  });

  it("a void (typeless) output schema succeeds when END carries no OUT frames", async () => {
    const tool = makeManifestTool({ id: "voidend", className: "ZCL_VOIDEND", actions: [VOID_ACTION] });
    const { route } = dynamicFluidRoute({
      transcript: () => buildTranscript({ id: tool.manifest.id, ver: tool.version, action: "run" }),
    });
    const { conn } = await connected(route);
    const d = depsFor(conn, gate(), tool);

    const result = await dispatch(d, { tool: tool.manifest.id, action: "run", args: {} });

    expect(result.result).toBeUndefined();
  });

  it("a void (typeless) output schema still raises FLUID_PROTOCOL_ERROR if the body emits an OUT anyway", async () => {
    const tool = makeManifestTool({ id: "voidout", className: "ZCL_VOIDOUT", actions: [VOID_ACTION] });
    const { route } = dynamicFluidRoute({
      transcript: () => buildTranscript({ id: tool.manifest.id, ver: tool.version, action: "run", outs: [{}] }),
    });
    const { conn } = await connected(route);
    const d = depsFor(conn, gate(), tool);

    const err = await catchErr(dispatch(d, { tool: tool.manifest.id, action: "run", args: {} }));

    expect(err.code).toBe("FLUID_PROTOCOL_ERROR");
    expect(err.details["count"]).toBe(1);
  });
});

describe("dispatch — transcript warnings (protocol.md's stray/dropped, surfaced not swallowed)", () => {
  it("a stray console line surfaces as a warning on an otherwise successful call", async () => {
    const tool = makeManifestTool({ id: "straywarn", className: "ZCL_STRAYWARN", actions: [READ_ACTION] });
    const { route } = dynamicFluidRoute({
      transcript: () =>
        [
          frameLine("BEGIN", { id: tool.manifest.id, ver: tool.version, action: "run", contract: "1.0" }),
          "unexpected debug noise printed by some other WRITE statement",
          frameLine("OUT", {}),
          frameLine("END", { rc: 0, outBytes: 0, truncated: false, ms: 1 }),
        ].join("\n") + "\n",
    });
    const { conn } = await connected(route);
    const d = depsFor(conn, gate(), tool);

    const result = await dispatch(d, { tool: tool.manifest.id, action: "run", args: {} });

    expect(result.result).toEqual({});
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("unexpected debug noise printed by some other WRITE statement");
  });

  it("a clean transcript surfaces no warnings", async () => {
    const tool = makeManifestTool({ id: "nowarn", className: "ZCL_NOWARN", actions: [READ_ACTION] });
    const { route } = dynamicFluidRoute({
      transcript: () => buildTranscript({ id: tool.manifest.id, ver: tool.version, action: "run", outs: [{}] }),
    });
    const { conn } = await connected(route);
    const d = depsFor(conn, gate(), tool);

    const result = await dispatch(d, { tool: tool.manifest.id, action: "run", args: {} });

    expect(result.warnings).toEqual([]);
  });

  // `dropped` can only ever be populated alongside an ERR frame (protocol.ts's own invariant —
  // an unparseable reassembled OUTC/OUTE value is swallowed as "dropped" instead of thrown only
  // because an ERR frame already explains the failure), and an ERR frame always makes dispatch
  // throw FLUID_ACTION_FAILED before any success FluidRunResult could be built. So the one place
  // a `dropped` entry can ever actually reach a caller is the thrown error's own details, not
  // `result.warnings` on a success — see buildWarnings' doc comment in dispatch.ts.
  it("a dropped value alongside an ERR frame surfaces in the thrown error's warnings", async () => {
    const tool = makeManifestTool({ id: "droppedwarn", className: "ZCL_DROPPEDWARN", actions: [READ_ACTION] });
    const { route } = dynamicFluidRoute({
      transcript: () =>
        [
          frameLine("BEGIN", { id: tool.manifest.id, ver: tool.version, action: "run", contract: "1.0" }),
          "ZMCP-H>OUTC not valid json",
          "ZMCP-H>OUTE  still not valid",
          frameLine("ERR", { kind: "exception", step: "run", text: "boom" }),
          frameLine("END", { rc: 8, outBytes: 0, truncated: false, ms: 1 }),
        ].join("\n") + "\n",
    });
    const { conn } = await connected(route);
    const d = depsFor(conn, gate(), tool);

    const err = await catchErr(dispatch(d, { tool: tool.manifest.id, action: "run", args: {} }));

    expect(err.code).toBe("FLUID_ACTION_FAILED");
    const warnings = err.details["warnings"] as readonly string[];
    expect(warnings.some((w) => w.includes("not valid json still not valid"))).toBe(true);
  });
});

describe("dispatch — plugin gates", () => {
  it("refuses a plugin mutate action without allowFluidPluginMutate, zero mutations on wire", async () => {
    const tool = makeManifestTool({
      id: "plugnomut",
      className: "ZCL_PLUGNOMUT",
      actions: [MUTATE_ACTION],
      origin: "plugin",
    });
    const { route } = dynamicFluidRoute({
      transcript: () => buildTranscript({ ver: tool.version, action: "commit", outs: [{}] }),
    });
    const { conn, adt } = await connected(route);
    const d = depsFor(conn, gate(), tool, { cfg: cfg({ allowFluidPlugins: true, allowFluidPluginMutate: false }) });

    const err = await catchErr(
      dispatch(d, { tool: tool.manifest.id, action: "commit", args: {}, confirm: `${tool.manifest.id}.commit` }),
    );

    expect(err.code).toBe("FLUID_PLUGIN_MUTATE_DISABLED");
    expect(mutations(adt.calls)).toEqual([]);
  });

  it("refuses a plugin mutate action with the mutate flag on but a missing or wrong confirm", async () => {
    const tool = makeManifestTool({
      id: "plugbadconf",
      className: "ZCL_PLUGBADCONF",
      actions: [MUTATE_ACTION],
      origin: "plugin",
    });
    const { route } = dynamicFluidRoute({
      transcript: () => buildTranscript({ ver: tool.version, action: "commit", outs: [{}] }),
    });
    const { conn, adt } = await connected(route);
    const d = depsFor(conn, gate(), tool, { cfg: cfg({ allowFluidPlugins: true, allowFluidPluginMutate: true }) });

    const errMissing = await catchErr(dispatch(d, { tool: tool.manifest.id, action: "commit", args: {} }));
    expect(errMissing.code).toBe("BAD_INPUT");

    const errWrong = await catchErr(
      dispatch(d, { tool: tool.manifest.id, action: "commit", args: {}, confirm: "nope" }),
    );
    expect(errWrong.code).toBe("BAD_INPUT");

    expect(mutations(adt.calls)).toEqual([]);
  });

  it("refuses any plugin action when plugins are disabled entirely", async () => {
    const tool = makeManifestTool({
      id: "plugoff",
      className: "ZCL_PLUGOFF",
      actions: [READ_ACTION],
      origin: "plugin",
    });
    const { route } = dynamicFluidRoute({
      transcript: () => buildTranscript({ ver: tool.version, action: "run", outs: [{}] }),
    });
    const { conn, adt } = await connected(route);
    const d = depsFor(conn, gate(), tool, { cfg: cfg({ allowFluidPlugins: false }) });

    const err = await catchErr(dispatch(d, { tool: tool.manifest.id, action: "run", args: {} }));

    expect(err.code).toBe("FLUID_PLUGINS_DISABLED");
    expect(adt.calls).toEqual([]);
  });
});

describe("dispatch — invoker naming and reuse", () => {
  it("an identical repeat call issues no second write", async () => {
    const tool = makeManifestTool({ id: "repeat", className: "ZCL_REPEAT", actions: [READ_ACTION] });
    const { route } = dynamicFluidRoute({
      transcript: () => buildTranscript({ id: tool.manifest.id, ver: tool.version, action: "run", outs: [{}] }),
    });
    const { conn, adt } = await connected(route);
    const d = depsFor(conn, gate(), tool);
    const req: FluidRunRequest = { tool: tool.manifest.id, action: "run", args: { a: 1 } };

    await dispatch(d, req);
    expect(adt.calls.filter((c) => c.method === "PUT").length).toBeGreaterThan(0);

    const before = adt.calls.length;
    await dispatch(d, req);
    const putsAfterSecond = adt.calls.slice(before).filter((c) => c.method === "PUT");
    expect(putsAfterSecond).toEqual([]);
  });

  it("different args produce different invoker names, each deployed and run separately", async () => {
    const tool = makeManifestTool({ id: "diffargs", className: "ZCL_DIFFARGS", actions: [READ_ACTION] });
    const { route } = dynamicFluidRoute({
      transcript: () => buildTranscript({ id: tool.manifest.id, ver: tool.version, action: "run", outs: [{}] }),
    });
    const { conn, adt } = await connected(route);
    const d = depsFor(conn, gate(), tool);

    await dispatch(d, { tool: tool.manifest.id, action: "run", args: { a: 1 } });
    await dispatch(d, { tool: tool.manifest.id, action: "run", args: { a: 2 } });

    const classrunUrls = adt.calls.filter((c) => c.url.startsWith(CLASSRUN_BASE)).map((c) => c.url);
    expect(classrunUrls).toHaveLength(2);
    expect(classrunUrls[0]).not.toBe(classrunUrls[1]);
  });

  it("args that are deeply equal but differently key-ordered deploy byte-identical invoker source", async () => {
    const tool = makeManifestTool({ id: "keyorder", className: "ZCL_KEYORDER", actions: [READ_ACTION] });
    const { route } = dynamicFluidRoute({
      transcript: () => buildTranscript({ id: tool.manifest.id, ver: tool.version, action: "run", outs: [{}] }),
    });
    const { conn, adt } = await connected(route);
    const d = depsFor(conn, gate(), tool);

    await dispatch(d, { tool: tool.manifest.id, action: "run", args: { b: 2, a: 1 } });
    await dispatch(d, { tool: tool.manifest.id, action: "run", args: { a: 1, b: 2 } });

    const puts = adt.calls.filter(
      (c) => c.method === "PUT" && c.url.endsWith("/source/main") && /zcl_zmcp_i_/i.test(c.url),
    );
    expect(puts).toHaveLength(1);

    const contract = tool.manifest.contract;
    const expectedArgsJson = canonicalArgsJson({ a: 1, b: 2 });
    const expectedName = invokerName(tool.manifest.id, "run", { a: 1, b: 2 }, contract);
    const expectedSource = invokerSource({
      name: expectedName,
      entry: tool.manifest.entry,
      toolId: tool.manifest.id,
      action: "run",
      argsJson: expectedArgsJson,
      version: tool.version,
      contract,
      commit: false,
    });

    expect(puts[0]?.body).toBe(expectedSource);
  });
});

describe("dispatch — output size, no caps", () => {
  it("returns a several-hundred-KB output value whole, with truncated staying false", async () => {
    const tool = makeManifestTool({ id: "bigout", className: "ZCL_BIGOUT", actions: [STRING_ACTION] });
    const big = "x".repeat(500_000);
    const { route } = dynamicFluidRoute({
      transcript: () =>
        buildTranscript({
          id: tool.manifest.id,
          ver: tool.version,
          action: "run",
          outs: [big],
          end: { outBytes: big.length },
        }),
    });
    const { conn } = await connected(route);
    const d = depsFor(conn, gate(), tool);

    const result = await dispatch(d, { tool: tool.manifest.id, action: "run", args: {} });

    expect(result.truncated).toBe(false);
    expect(typeof result.result).toBe("string");
    expect((result.result as string).length).toBe(500_000);
  });

  it("passes truncated: true through from the ABAP side faithfully", async () => {
    const tool = makeManifestTool({ id: "trunctool", className: "ZCL_TRUNC", actions: [READ_ACTION] });
    const { route } = dynamicFluidRoute({
      transcript: () =>
        buildTranscript({
          id: tool.manifest.id,
          ver: tool.version,
          action: "run",
          outs: [{}],
          end: { truncated: true },
        }),
    });
    const { conn } = await connected(route);
    const d = depsFor(conn, gate(), tool);

    const result = await dispatch(d, { tool: tool.manifest.id, action: "run", args: {} });

    expect(result.truncated).toBe(true);
  });
});

describe("dispatch — journal", () => {
  it("journals a plugin mutate action post-hoc", async () => {
    const tool = makeManifestTool({
      id: "plugjournal",
      className: "ZCL_PLUGJOURNAL",
      actions: [MUTATE_ACTION],
      origin: "plugin",
    });
    const { route } = dynamicFluidRoute({
      transcript: () => buildTranscript({ id: tool.manifest.id, ver: tool.version, action: "commit", outs: [{}] }),
    });
    const { conn } = await connected(route);
    const journal = new Journal({ dir: path.join(tmp, "journal"), enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H");
    const d = depsFor(conn, gate(), tool, {
      cfg: cfg({ allowFluidPlugins: true, allowFluidPluginMutate: true }),
      journal,
    });

    await dispatch(d, {
      tool: tool.manifest.id,
      action: "commit",
      args: {},
      confirm: `${tool.manifest.id}.commit`,
    });

    const entries = await journal.list({ object: `${tool.manifest.id}.commit` });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outcome).toBe("succeeded");
    expect(entries[0]?.irreversible).toBe(true);
  });

  // A committed mutation must be journalled even when a later, purely local
  // check (here: output-schema validation) rejects the call — the ABAP-side
  // COMMIT WORK already happened by the time that check runs, and losing the
  // record would be exactly the failure post-hoc journalling exists to prevent.
  it("still journals a committed plugin mutation whose output violates its declared schema", async () => {
    const tool = makeManifestTool({
      id: "plugjournalbadout",
      className: "ZCL_PLUGJOURNALBADOUT",
      actions: [MUTATE_STRICT_OUTPUT_ACTION],
      origin: "plugin",
    });
    const { route } = dynamicFluidRoute({
      // Commits (no ERR frame) but the OUT value omits the required "ok" field.
      transcript: () => buildTranscript({ id: tool.manifest.id, ver: tool.version, action: "commit", outs: [{}] }),
    });
    const { conn } = await connected(route);
    const journal = new Journal({ dir: path.join(tmp, "journal"), enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H");
    const d = depsFor(conn, gate(), tool, {
      cfg: cfg({ allowFluidPlugins: true, allowFluidPluginMutate: true }),
      journal,
    });

    const err = await catchErr(
      dispatch(d, {
        tool: tool.manifest.id,
        action: "commit",
        args: {},
        confirm: `${tool.manifest.id}.commit`,
      }),
    );

    expect(err.code).toBe("FLUID_PROTOCOL_ERROR");
    const entries = await journal.list({ object: `${tool.manifest.id}.commit` });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outcome).toBe("succeeded");
    expect(entries[0]?.irreversible).toBe(true);
  });

  it("a plugin mutate action with an ERR frame is never journalled", async () => {
    const tool = makeManifestTool({
      id: "plugerrjournal",
      className: "ZCL_PLUGERRJOURNAL",
      actions: [MUTATE_ACTION],
      origin: "plugin",
    });
    const { route } = dynamicFluidRoute({
      transcript: () =>
        buildTranscript({
          id: tool.manifest.id,
          ver: tool.version,
          action: "commit",
          errs: [{ kind: "exception", step: "commit", text: "boom" }],
          end: { rc: 8 },
        }),
    });
    const { conn } = await connected(route);
    const journal = new Journal({ dir: path.join(tmp, "journal"), enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H");
    const d = depsFor(conn, gate(), tool, {
      cfg: cfg({ allowFluidPlugins: true, allowFluidPluginMutate: true }),
      journal,
    });

    const err = await catchErr(
      dispatch(d, {
        tool: tool.manifest.id,
        action: "commit",
        args: {},
        confirm: `${tool.manifest.id}.commit`,
      }),
    );

    expect(err.code).toBe("FLUID_ACTION_FAILED");
    const entries = await journal.list({ object: `${tool.manifest.id}.commit` });
    expect(entries).toHaveLength(0);
  });
});

describe("dispatch — self-heal after out-of-band deletion", () => {
  // The on-disk registry claims NAME is already deployed at this tool's exact
  // contract/version — but the fake server's store has never heard of it: a
  // matching on-disk lie, exactly what ensureFluidTool's cache-trusting fast
  // path (ensure.ts) accepts without ever touching the wire. The very first
  // classrun POST (the execute step) is made to 404 once, standing in for the
  // real-world failure this self-heal targets — the invoker's dispatch to a
  // deleted entry class.
  it("recovers from a stale-registry / missing-object NOT_FOUND on the execute step: redeploys once and the retry succeeds", async () => {
    const NAME = "ZCL_BODYGONE";
    const tool = makeManifestTool({ id: "bodygone", className: NAME, actions: [READ_ACTION] });
    let classrunCalls = 0;
    const { route: dynamicRoute } = dynamicFluidRoute({
      transcript: () => buildTranscript({ id: tool.manifest.id, ver: tool.version, action: "run", outs: [{}] }),
    });
    const route: Route = (r) => {
      if (r.url.startsWith(CLASSRUN_BASE) && r.method === "POST") {
        classrunCalls++;
        if (classrunCalls === 1) return resp(404, notFoundXml(NAME), OK_XML);
      }
      return dynamicRoute(r);
    };
    const { conn, adt } = await connected(route);
    const sysKey = systemKey(conn.cfg);
    await recordManifest(cfg(), sysKey, {
      toolId: tool.manifest.id,
      contract: tool.manifest.contract,
      version: tool.version,
      objects: [NAME],
      deployedAt: new Date().toISOString(),
    });
    const d = depsFor(conn, gate(), tool);

    const result = await dispatch(d, { tool: tool.manifest.id, action: "run", args: {} });

    expect(result.result).toEqual({});
    const bodyPuts = adt.calls.filter((c) => c.method === "PUT" && c.url === `${classUri(NAME)}/source/main`);
    expect(bodyPuts).toHaveLength(1);
    expect(classrunCalls).toBe(2);
  });

  it("propagates NOT_FOUND unchanged when the object is still missing after one recovery, having recovered exactly once", async () => {
    const NAME = "ZCL_STILLGONE";
    const tool = makeManifestTool({ id: "stillgone", className: NAME, actions: [READ_ACTION] });
    let classrunCalls = 0;
    const { route: dynamicRoute } = dynamicFluidRoute({
      transcript: () => buildTranscript({ id: tool.manifest.id, ver: tool.version, action: "run", outs: [{}] }),
    });
    const route: Route = (r) => {
      if (r.url.startsWith(CLASSRUN_BASE) && r.method === "POST") {
        classrunCalls++;
        return resp(404, notFoundXml(NAME), OK_XML);
      }
      return dynamicRoute(r);
    };
    const { conn, adt } = await connected(route);
    const sysKey = systemKey(conn.cfg);
    await recordManifest(cfg(), sysKey, {
      toolId: tool.manifest.id,
      contract: tool.manifest.contract,
      version: tool.version,
      objects: [NAME],
      deployedAt: new Date().toISOString(),
    });
    const d = depsFor(conn, gate(), tool);

    const err = await catchErr(dispatch(d, { tool: tool.manifest.id, action: "run", args: {} }));

    expect(err.code).toBe("NOT_FOUND");
    // Exactly one retry, never a loop: first attempt + one re-run after recovery, not more.
    expect(classrunCalls).toBe(2);
    // Exactly one recovery: the redeploy of NAME (forgetManifest + ensureFluidTool) fires once,
    // not once per failed classrun.
    const bodyPuts = adt.calls.filter((c) => c.method === "PUT" && c.url === `${classUri(NAME)}/source/main`);
    expect(bodyPuts).toHaveLength(1);
  });

  it("does not attempt recovery for a non-NOT_FOUND failure", async () => {
    const NAME = "ZCL_FOREIGNCONFLICT";
    const tool = makeManifestTool({ id: "foreignconflict", className: NAME, actions: [READ_ACTION] });
    const { route, store } = dynamicFluidRoute({
      transcript: () => buildTranscript({ id: tool.manifest.id, ver: tool.version, action: "run", outs: [{}] }),
    });
    // No registry entry recorded — ensureFluidTool takes its full classify path and finds NAME
    // sitting in a package abapsmith does not own: a legitimate, non-deployment NOT_FOUND-free
    // refusal (FLUID_OBJECT_CONFLICT), not an out-of-band deletion.
    store.set(NAME, { exists: true, packageName: "$SOME_OTHER_PACKAGE", active: true, source: "irrelevant" });
    const { conn, adt } = await connected(route);
    const d = depsFor(conn, gate(), tool);

    const err = await catchErr(dispatch(d, { tool: tool.manifest.id, action: "run", args: {} }));

    expect(err.code).toBe("FLUID_OBJECT_CONFLICT");
    // No recovery attempted: the classify GET for NAME ran exactly once, and execute was never
    // reached at all.
    const nameGets = adt.calls.filter((c) => c.method === "GET" && c.url === classUri(NAME));
    expect(nameGets).toHaveLength(1);
    expect(adt.calls.filter((c) => c.url.startsWith(CLASSRUN_BASE))).toEqual([]);
  });
});
