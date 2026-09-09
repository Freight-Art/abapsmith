/**
 * S13 red proofs, offline against a hand-rolled recording `HttpClient` — same
 * idiom (and largely the same fixtures) as `test/fluid-ensure.test.ts`:
 *
 *   (a) `ensureFluidRuntimeFor` deploys the runtime for a plugin tool that
 *       does not already declare it, and is a true no-op for a builtin tool
 *       or a plugin tool that already declares it.
 *   (b) an installed deploy-version marker naming a newer abapsmith than this
 *       one classifies as `newer` and `ensureFluidTool` refuses with
 *       `FLUID_OBJECT_CONFLICT`, never rewriting the object.
 *   (c) an older or equal marker with different stripped content still
 *       classifies `stale` and is rewritten exactly as before marking existed.
 *   (d) an unmarked installed object with identical content classifies
 *       `present` and is never rewritten — the marker's absence alone is not
 *       a content difference.
 *   (e) a create race (first CREATE POST answers
 *       `ExceptionResourceAlreadyExists`, as a concurrent winner would leave
 *       it) is not misreported as a syntax failure: one re-probe finds the
 *       winner's object and continues normally instead of throwing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import {
  ensureFluidTool,
  ensureFluidRuntimeFor,
  classifyFluidTool,
  resetFluidEnsureState,
  type FluidCallContext,
} from "../src/adt/fluid/ensure.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { FLUID_RUNTIME_CLASS, fluidRuntimeTool } from "../src/adt/fluid/abap/runtime.js";
import { manifestVersion, type FluidManifest, type LoadedFluidTool } from "../src/adt/fluid/manifest.js";
import { SERVER_VERSION } from "../src/version.js";

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

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-state-s13-"));
  resetFluidEnsureState();
  resetFluidPackageMemo();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function cfg(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
    fluidApi: true,
    stateDir: tmp,
    ...overrides,
  });
}

const gate = (): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"] });

const CTX: FluidCallContext = { tool: "t1", action: "run", op: "run" };

async function catchErr(p: Promise<unknown>): Promise<AbapError> {
  try {
    await p;
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected a rejection");
}

// --- ABAP-side fixtures (same shapes as fluid-ensure.test.ts) --------------

const classUri = (name: string): string => `/sap/bc/adt/oo/classes/${name.toLowerCase()}`;
const classSrc = (name: string): string => `${classUri(name)}/source/main`;
const CLS_COLLECTION = "/sap/bc/adt/oo/classes";
const PKG_URI = "/sap/bc/adt/packages/%24abapsmith_fluid_api";
const PACKAGES = "/sap/bc/adt/packages";

const notFoundXml = (name: string): string =>
  `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
  `<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>` +
  `<message lang="EN">${name} does not exist</message><properties/></exc:exception>`;

// Same shape write.test.ts's DDIC_REJECT_XML uses ("a syntax problem
// mislabelled as AlreadyExists") — status 400, this `<type id=...>`.
const alreadyExistsXml = (name: string): string =>
  `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
  `<namespace id="com.sap.adt"/><type id="ExceptionResourceAlreadyExists"/>` +
  `<message lang="EN">${name} already exists</message><properties/></exc:exception>`;

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

const CHECKRUN_CLEAN =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:atom="http://www.w3.org/2005/Atom"/>`;

interface ObjState {
  exists: boolean;
  packageName: string;
  source?: string;
  active: boolean;
}

function makeStore(entries: Record<string, Partial<ObjState>>): Record<string, ObjState> {
  const store: Record<string, ObjState> = {};
  for (const [name, e] of Object.entries(entries)) {
    store[name.toUpperCase()] = { exists: false, packageName: "$TMP", active: false, ...e };
  }
  return store;
}

interface RouteOpts {
  checkrun?: HttpClientResponse;
  activation?: HttpClientResponse;
}

function fluidRoute(store: Record<string, ObjState>, opts: RouteOpts = {}): Route {
  const checkrunResp = opts.checkrun ?? resp(200, CHECKRUN_CLEAN, OK_XML);
  const activationResp = opts.activation ?? resp(200, "", OK_TEXT);

  return (r) => {
    if (r.url === PKG_URI && r.method === "GET") return resp(200, PACKAGE_XML(FLUID_PACKAGE), OK_XML);
    if (r.url === PACKAGES && r.method === "POST") return resp(200, "", OK_TEXT);

    if (r.url === CLS_COLLECTION && r.method === "POST") {
      const m = /adtcore:name="([^"]+)"/.exec(r.body ?? "");
      const name = (m?.[1] ?? "").toUpperCase();
      const prior = store[name];
      store[name] = { exists: true, packageName: FLUID_PACKAGE, source: prior?.source, active: false };
      return resp(200, "", OK_TEXT);
    }

    if (r.url.startsWith("/sap/bc/adt/checkruns") && r.method === "POST") return checkrunResp;

    if (r.url === "/sap/bc/adt/activation" && r.method === "POST") {
      if (activationResp.status === 200) {
        const m = /adtcore:name="([^"]+)"/.exec(r.body ?? "");
        const name = (m?.[1] ?? "").toUpperCase();
        const st = store[name];
        if (st) st.active = true;
      }
      return activationResp;
    }

    for (const [name, st] of Object.entries(store)) {
      const uri = classUri(name);
      const src = classSrc(name);
      if (r.url === uri && r.method === "GET" && !r.qs._action) {
        if (!st.exists) return resp(404, notFoundXml(name), OK_XML);
        return resp(
          200,
          classDocXml(name, { packageName: st.packageName, mainVersion: st.active ? "active" : "inactive" }),
          OK_XML,
        );
      }
      if (r.url === src && r.method === "GET") {
        if (!st.exists) return resp(404, notFoundXml(name), OK_XML);
        if (st.source === undefined) return resp(404, notFoundXml(name), OK_XML);
        return resp(200, st.source, OK_TEXT);
      }
      if (r.url === uri && r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.url === uri && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === src && r.method === "PUT") {
        st.source = r.body ?? "";
        st.exists = true;
        st.active = false;
        return resp(200, "", OK_TEXT);
      }
      if (r.url === uri && r.method === "DELETE") {
        st.exists = false;
        st.source = undefined;
        return resp(200, "", OK_TEXT);
      }
    }
    return undefined;
  };
}

function makeTool(
  objects: readonly { name: string; source: string }[],
  opts: { id?: string; origin?: "builtin" | "plugin" } = {},
): LoadedFluidTool {
  const id = opts.id ?? "t1";
  const manifest: FluidManifest = {
    contract: "1.0",
    id,
    title: "Test tool",
    description: "a fluid tool used only by fluid-ensure-s13.test.ts",
    objects: objects.map((o) => ({
      name: o.name,
      type: "CLAS/OC" as const,
      description: "obj",
      source: { text: o.source },
    })),
    entry: objects[0]!.name,
    actions: [
      {
        name: "run",
        category: "execute" as const,
        description: "run it",
        input: { type: "object" as const },
        output: { type: "object" as const },
      },
    ],
  };
  const sources = new Map(objects.map((o) => [o.name, o.source]));
  return { manifest, origin: opts.origin ?? "builtin", sources, version: manifestVersion(manifest, sources) };
}

const SOURCE_A = "CLASS zcl_zmcp_demo DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_zmcp_demo IMPLEMENTATION.\nENDCLASS.";
const SOURCE_B = "CLASS zcl_zmcp_demo DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_zmcp_demo IMPLEMENTATION.\n* v2\nENDCLASS.";

const marked = (version: string, source: string): string => `* abapsmith fluid v${version}\n${source}`;

// === (a) ensureFluidRuntimeFor ==============================================

describe("ensureFluidRuntimeFor", () => {
  it("deploys the shared runtime class for a plugin tool that does not declare it", async () => {
    const tool = makeTool([{ name: "ZCL_ZMCP_PLUGIN1", source: SOURCE_A }], { origin: "plugin", id: "p1" });
    const store = makeStore({ [FLUID_RUNTIME_CLASS]: { exists: false } });
    const { conn, adt } = await connected(fluidRoute(store));

    await ensureFluidRuntimeFor(conn, gate(), cfg(), tool, CTX);

    expect(store[FLUID_RUNTIME_CLASS]?.exists).toBe(true);
    expect(store[FLUID_RUNTIME_CLASS]?.packageName).toBe(FLUID_PACKAGE);
    expect(adt.calls.some((c) => c.method === "POST" && c.url === CLS_COLLECTION)).toBe(true);
  });

  it("is a no-op — zero requests — for a builtin-origin tool", async () => {
    const tool = makeTool([{ name: "ZCL_ZMCP_BUILTIN1", source: SOURCE_A }], { origin: "builtin", id: "b1" });
    const store = makeStore({ [FLUID_RUNTIME_CLASS]: { exists: false } });
    const { conn, adt } = await connected(fluidRoute(store));

    await ensureFluidRuntimeFor(conn, gate(), cfg(), tool, CTX);

    expect(adt.calls).toEqual([]);
    expect(store[FLUID_RUNTIME_CLASS]?.exists).toBe(false);
  });

  it("is a no-op — zero requests — for a plugin tool whose own manifest already declares the runtime class", async () => {
    const tool = makeTool(
      [
        { name: "ZCL_ZMCP_PLUGIN2", source: SOURCE_A },
        { name: FLUID_RUNTIME_CLASS, source: fluidRuntimeTool.sources.get(FLUID_RUNTIME_CLASS) ?? "" },
      ],
      { origin: "plugin", id: "p2" },
    );
    const store = makeStore({ [FLUID_RUNTIME_CLASS]: { exists: false } });
    const { conn, adt } = await connected(fluidRoute(store));

    await ensureFluidRuntimeFor(conn, gate(), cfg(), tool, CTX);

    expect(adt.calls).toEqual([]);
    expect(store[FLUID_RUNTIME_CLASS]?.exists).toBe(false);
  });

  it("works with no ctx at all", async () => {
    const tool = makeTool([{ name: "ZCL_ZMCP_PLUGIN3", source: SOURCE_A }], { origin: "plugin", id: "p3" });
    const store = makeStore({ [FLUID_RUNTIME_CLASS]: { exists: false } });
    const { conn } = await connected(fluidRoute(store));

    await ensureFluidRuntimeFor(conn, gate(), cfg(), tool);

    expect(store[FLUID_RUNTIME_CLASS]?.exists).toBe(true);
  });
});

// === (b)/(c)/(d) cross-release version marker ==============================

describe("classifyOne / ensureFluidTool — deploy-version marker", () => {
  it("an installed marker naming a NEWER abapsmith classifies `newer` and ensureFluidTool refuses without rewriting", async () => {
    const NAME = "ZCL_NEWER";
    const NEWER_VERSION = "9.9.9";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({
      [NAME]: { exists: true, packageName: FLUID_PACKAGE, source: marked(NEWER_VERSION, SOURCE_A), active: true },
    });
    const { conn, adt } = await connected(fluidRoute(store));

    const statuses = await classifyFluidTool(conn, cfg(), tool);
    expect(statuses).toEqual([{ name: NAME, type: "CLAS/OC", state: "newer" }]);

    const err = await catchErr(ensureFluidTool(conn, gate(), cfg(), tool, CTX));
    expect(err.code).toBe("FLUID_OBJECT_CONFLICT");
    expect(err.details["installed_version"]).toBe(NEWER_VERSION);
    expect(err.details["our_version"]).toBe(SERVER_VERSION);
    expect(err.hint).toContain("upgrade abapsmith or run abap_fluid op=remove");

    // Never written over.
    expect(adt.calls.filter((c) => c.method === "PUT" || c.method === "DELETE")).toEqual([]);
  });

  it("an OLDER marker with different stripped content classifies `stale` and is rewritten as before marking existed", async () => {
    const NAME = "ZCL_OLDER_STALE";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({
      [NAME]: { exists: true, packageName: FLUID_PACKAGE, source: marked("0.0.1", SOURCE_B), active: true },
    });
    const { conn } = await connected(fluidRoute(store));

    const statuses = await classifyFluidTool(conn, cfg(), tool);
    expect(statuses).toEqual([{ name: NAME, type: "CLAS/OC", state: "stale" }]);

    const result = await ensureFluidTool(conn, gate(), cfg(), tool, CTX);
    expect(result.deployed).toBe(true);
    expect(result.objects).toEqual([{ name: NAME, type: "CLAS/OC", state: "present" }]);
    expect(store[NAME]?.source).toBe(marked(SERVER_VERSION, SOURCE_A));
  });

  it("an EQUAL marker version with different content still classifies `stale`, not `newer`", async () => {
    const NAME = "ZCL_EQUAL_STALE";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({
      [NAME]: { exists: true, packageName: FLUID_PACKAGE, source: marked(SERVER_VERSION, SOURCE_B), active: true },
    });
    const { conn } = await connected(fluidRoute(store));

    const statuses = await classifyFluidTool(conn, cfg(), tool);
    expect(statuses).toEqual([{ name: NAME, type: "CLAS/OC", state: "stale" }]);
  });

  it("an unmarked installed object with identical content classifies `present` and is never rewritten", async () => {
    const NAME = "ZCL_UNMARKED_SAME";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({
      [NAME]: { exists: true, packageName: FLUID_PACKAGE, source: SOURCE_A, active: true },
    });
    const { conn, adt } = await connected(fluidRoute(store));

    const statuses = await classifyFluidTool(conn, cfg(), tool);
    expect(statuses).toEqual([{ name: NAME, type: "CLAS/OC", state: "present" }]);

    const result = await ensureFluidTool(conn, gate(), cfg(), tool, CTX);
    expect(result.deployed).toBe(false);
    expect(adt.calls.filter((c) => c.method === "PUT" || c.method === "DELETE")).toEqual([]);
  });
});

// === (e) first-deploy create race ===========================================

function fluidRouteCreateConflict(
  store: Record<string, ObjState>,
  name: string,
  opts: { winnerCreates: boolean } = { winnerCreates: true },
): { route: Route; attempts: () => number } {
  const inner = fluidRoute(store);
  let attempts = 0;
  const route: Route = (r) => {
    if (r.url === CLS_COLLECTION && r.method === "POST" && (r.body ?? "").includes(`adtcore:name="${name}"`)) {
      attempts += 1;
      if (attempts === 1) {
        if (opts.winnerCreates) {
          store[name] = { exists: true, packageName: FLUID_PACKAGE, source: SOURCE_A, active: true };
        }
        return resp(400, alreadyExistsXml(name), OK_XML);
      }
    }
    return inner(r);
  };
  return { route, attempts: () => attempts };
}

describe("ensureFluidTool — first-deploy create race", () => {
  it("re-probes once after a create-conflict and continues as present once a concurrent winner's object is found", async () => {
    const NAME = "ZCL_RACE_WINNER";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({ [NAME]: { exists: false } });
    const { route, attempts } = fluidRouteCreateConflict(store, NAME, { winnerCreates: true });
    const { conn } = await connected(route);

    const result = await ensureFluidTool(conn, gate(), cfg(), tool, CTX);

    expect(result.objects).toEqual([{ name: NAME, type: "CLAS/OC", state: "present" }]);
    expect(attempts()).toBe(1);
  });

  it("does not swallow a genuine create failure: re-probing and still finding it absent rethrows", async () => {
    const NAME = "ZCL_RACE_NOWINNER";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({ [NAME]: { exists: false } });
    const { route, attempts } = fluidRouteCreateConflict(store, NAME, { winnerCreates: false });
    const { conn } = await connected(route);

    const err = await catchErr(ensureFluidTool(conn, gate(), cfg(), tool, CTX));

    expect(err.details["adtExceptionType"]).toBe("ExceptionResourceAlreadyExists");
    // One create attempt, one re-probe, no second create attempt.
    expect(attempts()).toBe(1);
  });
});
