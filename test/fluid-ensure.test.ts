/**
 * `ensureFluidTool` / `classifyFluidTool` offline against a hand-rolled
 * recording `HttpClient` — same idiom as `test/delete-throw-path-verification.test.ts`.
 * `FakeAdtServer` is not used here: it has no builtin route for
 * `POST /sap/bc/adt/activation`, `POST /sap/bc/adt/checkruns`, or a class
 * `DELETE`, all three of which these flows need.
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
import { systemKey } from "../src/journal.js";
import {
  ensureFluidTool,
  classifyFluidTool,
  resetFluidEnsureState,
  type FluidCallContext,
} from "../src/adt/fluid/ensure.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { readFluidRegistry, recordManifest } from "../src/adt/fluid/registry.js";
import { manifestVersion, type FluidManifest, type LoadedFluidTool } from "../src/adt/fluid/manifest.js";

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
  get labels(): string[] {
    return this.calls.map((c) => c.label);
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
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-state-"));
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

// --- ABAP-side fixtures -----------------------------------------------------

const classUri = (name: string): string => `/sap/bc/adt/oo/classes/${name.toLowerCase()}`;
const classSrc = (name: string): string => `${classUri(name)}/source/main`;
const CLS_COLLECTION = "/sap/bc/adt/oo/classes";
const PKG_URI = "/sap/bc/adt/packages/%24abapsmith_fluid_api";
const PACKAGES = "/sap/bc/adt/packages";

const notFoundXml = (name: string): string =>
  `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
  `<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>` +
  `<message lang="EN">${name} does not exist</message><properties/></exc:exception>`;

const PACKAGE_XML = (name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<pak:package xmlns:pak="http://www.sap.com/adt/packages" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" adtcore:type="DEVC/K">` +
  `<adtcore:packageRef adtcore:name="${name}" adtcore:type="DEVC/K"/>` +
  `<pak:superPackage/>` +
  `</pak:package>`;

/**
 * Shaped like live fixture 062 (`062-class-get-check.xml`): a root version
 * plus one `adtcore:version` per include. `activationFromBody` (src/adt/write.ts)
 * treats the object as active only if every one of these agrees "active".
 */
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

function checkrunDirty(name: string): string {
  const uri = classSrc(name);
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun">` +
    `<chkrun:checkReport chkrun:reporter="abapCheckRun" chkrun:triggeringUri="${uri}" chkrun:status="processed" chkrun:statusText="">` +
    `<chkrun:checkMessageList>` +
    `<chkrun:checkMessage chkrun:uri="${uri}#start=1,0" chkrun:type="E" chkrun:shortText="Syntax error"/>` +
    `</chkrun:checkMessageList>` +
    `</chkrun:checkReport>` +
    `</chkrun:checkRunReports>`
  );
}

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
  /** Ignore PUT bodies and keep serving this fixed text — fakes a server silently rejecting content. */
  pinnedSource?: string;
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
        const body = opts.pinnedSource ?? st.source;
        if (body === undefined) return resp(404, notFoundXml(name), OK_XML);
        return resp(200, body, OK_TEXT);
      }
      if (r.url === uri && r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.url === uri && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === src && r.method === "PUT") {
        if (opts.pinnedSource === undefined) st.source = r.body ?? "";
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

// --- manifest / tool construction -------------------------------------------

function makeTool(objects: readonly { name: string; source: string }[], id = "t1"): LoadedFluidTool {
  const manifest: FluidManifest = {
    contract: "1.0",
    id,
    title: "Test tool",
    description: "a fluid tool used only by fluid-ensure.test.ts",
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
  return { manifest, origin: "builtin", sources, version: manifestVersion(manifest, sources) };
}

const SOURCE_A = "CLASS zcl_zmcp_demo DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_zmcp_demo IMPLEMENTATION.\nENDCLASS.";
const SOURCE_B = "CLASS zcl_zmcp_demo DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_zmcp_demo IMPLEMENTATION.\n* v2\nENDCLASS.";

function mutations(calls: readonly Recorded[]): Recorded[] {
  return calls.filter((c) => c.method === "PUT" || c.method === "POST" || c.method === "DELETE");
}

// `checkSource` (called from `classifyOne` for an already-active, content-matching
// object) issues a genuine POST, but it is a read-only syntax check, not a write —
// excluded here so "classification never mutates" isn't falsely tripped by it.
function nonReadOnlyMutations(calls: readonly Recorded[]): Recorded[] {
  return mutations(calls).filter((c) => !c.url.includes("/checkruns"));
}

describe("ensureFluidTool — cold cache", () => {
  it("deploys and activates an absent object, and records the registry only after activation succeeds", async () => {
    const NAME = "ZCL_COLD";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({ [NAME]: { exists: false } });
    const { conn, adt } = await connected(fluidRoute(store));

    const result = await ensureFluidTool(conn, gate(), cfg(), tool, CTX);

    expect(result.deployed).toBe(true);
    expect(result.objects).toEqual([{ name: NAME, type: "CLAS/OC", state: "present" }]);

    expect(adt.labels).toEqual([
      `GET ${PKG_URI}`,
      `GET ${classUri(NAME)}`,
      `GET ${classUri(NAME)}`,
      `POST ${CLS_COLLECTION}`,
      `LOCK ${classUri(NAME)}`,
      `PUT ${classSrc(NAME)}`,
      `UNLOCK ${classUri(NAME)}`,
      `POST /sap/bc/adt/activation`,
      `GET ${classSrc(NAME)}`,
    ]);

    const registry = await readFluidRegistry(cfg(), systemKey(conn.cfg));
    const entry = registry.get(tool.manifest.id);
    expect(entry?.version).toBe(tool.version);
    expect(entry?.objects).toEqual([NAME]);
  });

  it("does not write to the registry when the activation POST fails", async () => {
    const NAME = "ZCL_COLD_FAIL";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({ [NAME]: { exists: false } });
    const { conn, adt } = await connected(fluidRoute(store, { activation: resp(500, "<x/>", OK_XML) }));

    await expect(ensureFluidTool(conn, gate(), cfg(), tool, CTX)).rejects.toBeTruthy();

    expect(adt.labels.filter((l) => l.startsWith("PUT"))).toHaveLength(1);
    expect(adt.labels.some((l) => l.startsWith("POST /sap/bc/adt/activation"))).toBe(true);

    const registry = await readFluidRegistry(cfg(), systemKey(conn.cfg));
    expect(registry.get(tool.manifest.id)).toBeUndefined();
  });
});

describe("ensureFluidTool — warm cache", () => {
  it("issues zero requests when the registry already matches the manifest contract and version", async () => {
    const NAME = "ZCL_WARM";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const { conn, adt } = await connected(() => undefined);

    await recordManifest(cfg(), systemKey(conn.cfg), {
      toolId: tool.manifest.id,
      contract: tool.manifest.contract,
      version: tool.version,
      objects: [NAME],
      deployedAt: new Date().toISOString(),
    });

    const result = await ensureFluidTool(conn, gate(), cfg(), tool, CTX);

    expect(adt.calls).toEqual([]);
    expect(result.deployed).toBe(false);
    expect(result.objects).toEqual([{ name: NAME, type: "CLAS/OC", state: "present" }]);
  });
});

describe("ensureFluidTool — manifest version bump", () => {
  it("rewrites exactly the object whose content changed", async () => {
    const KEPT = "ZCL_KEPT";
    const CHANGED = "ZCL_CHANGED";
    const tool = makeTool([
      { name: KEPT, source: SOURCE_A },
      { name: CHANGED, source: SOURCE_B },
    ]);
    const store = makeStore({
      [KEPT]: { exists: true, packageName: FLUID_PACKAGE, source: SOURCE_A, active: true },
      [CHANGED]: { exists: true, packageName: FLUID_PACKAGE, source: SOURCE_A, active: true },
    });
    const { conn, adt } = await connected(fluidRoute(store));

    // Stale registry entry: same tool, an older version hash.
    await recordManifest(cfg(), systemKey(conn.cfg), {
      toolId: tool.manifest.id,
      contract: tool.manifest.contract,
      version: "00000000",
      objects: [KEPT, CHANGED],
      deployedAt: new Date().toISOString(),
    });

    const result = await ensureFluidTool(conn, gate(), cfg(), tool, CTX);

    expect(result.deployed).toBe(true);
    expect(result.objects).toEqual([
      { name: KEPT, type: "CLAS/OC", state: "present" },
      { name: CHANGED, type: "CLAS/OC", state: "present" },
    ]);

    const puts = adt.calls.filter((c) => c.method === "PUT" && c.url.includes("/source/main"));
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toBe(classSrc(CHANGED));
  });
});

describe("ensureFluidTool — write succeeds but content still differs", () => {
  it("redeploys once, then throws FLUID_OBJECT_CONFLICT after exactly two PUTs", async () => {
    const NAME = "ZCL_DIVERGENT";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({
      [NAME]: { exists: true, packageName: FLUID_PACKAGE, source: SOURCE_B, active: true },
    });
    const { conn, adt } = await connected(fluidRoute(store, { pinnedSource: SOURCE_B }));

    const err = await catchErr(ensureFluidTool(conn, gate(), cfg(), tool, CTX));
    expect(err.code).toBe("FLUID_OBJECT_CONFLICT");

    const puts = adt.calls.filter((c) => c.method === "PUT" && c.url.includes("/source/main"));
    expect(puts).toHaveLength(2);
  });

  it("a second call in the same process throws after only one further PUT — the redeploy is already spent", async () => {
    const NAME = "ZCL_DIVERGENT2";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({
      [NAME]: { exists: true, packageName: FLUID_PACKAGE, source: SOURCE_B, active: true },
    });
    const { conn, adt } = await connected(fluidRoute(store, { pinnedSource: SOURCE_B }));

    await catchErr(ensureFluidTool(conn, gate(), cfg(), tool, CTX));
    expect(adt.calls.filter((c) => c.method === "PUT" && c.url.includes("/source/main"))).toHaveLength(2);

    const before = adt.calls.length;
    const err2 = await catchErr(ensureFluidTool(conn, gate(), cfg(), tool, CTX));
    expect(err2.code).toBe("FLUID_OBJECT_CONFLICT");

    const putsAfterSecondCall = adt.calls
      .slice(before)
      .filter((c) => c.method === "PUT" && c.url.includes("/source/main"));
    expect(putsAfterSecondCall).toHaveLength(1);
  });
});

describe("ensureFluidTool — legacy relocation", () => {
  it("deletes the $TMP object exactly once, then recreates it in FLUID_PACKAGE", async () => {
    const NAME = "ZCL_ZMCP_DEMO";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({
      [NAME]: { exists: true, packageName: "$TMP", source: SOURCE_A, active: true },
    });
    const { conn, adt } = await connected(fluidRoute(store));

    const result = await ensureFluidTool(conn, gate(), cfg(), tool, CTX);

    expect(result.deployed).toBe(true);
    expect(result.objects).toEqual([{ name: NAME, type: "CLAS/OC", state: "present" }]);

    expect(adt.labels).toEqual([
      `GET ${PKG_URI}`,
      `GET ${classUri(NAME)}`,
      `GET ${classUri(NAME)}`,
      `GET ${classSrc(NAME)}`,
      `LOCK ${classUri(NAME)}`,
      `GET ${classSrc(NAME)}`,
      `DELETE ${classUri(NAME)}`,
      `GET ${classSrc(NAME)}`,
      `GET ${classUri(NAME)}`,
      `POST ${CLS_COLLECTION}`,
      `LOCK ${classUri(NAME)}`,
      `PUT ${classSrc(NAME)}`,
      `UNLOCK ${classUri(NAME)}`,
      `POST /sap/bc/adt/activation`,
      `GET ${classSrc(NAME)}`,
    ]);

    expect(adt.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(store[NAME]?.packageName).toBe(FLUID_PACKAGE);
  });
});

describe("ensureFluidTool — foreign conflict", () => {
  it("refuses a reserved name already claimed in a non-legacy package, issuing no delete", async () => {
    const NAME = "ZCL_ZMCP_DEMO";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({
      [NAME]: { exists: true, packageName: "ZFOO", source: SOURCE_A, active: true },
    });
    const { conn, adt } = await connected(fluidRoute(store));

    const err = await catchErr(ensureFluidTool(conn, gate(), cfg(), tool, CTX));
    expect(err.code).toBe("FLUID_OBJECT_CONFLICT");

    expect(adt.calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(mutations(adt.calls)).toEqual([]);
  });

  it("refuses a non-reserved name sitting in $TMP the same way — pins the reserved-prefix half of the legacy test", async () => {
    const NAME = "ZCL_OTHER";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({
      [NAME]: { exists: true, packageName: "$TMP", source: SOURCE_A, active: true },
    });
    const { conn, adt } = await connected(fluidRoute(store));

    const err = await catchErr(ensureFluidTool(conn, gate(), cfg(), tool, CTX));
    expect(err.code).toBe("FLUID_OBJECT_CONFLICT");

    expect(adt.calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(mutations(adt.calls)).toEqual([]);
  });
});

describe("classifyFluidTool — per-state classification (read-only)", () => {
  it("present: correct package, matching source, active, clean checkrun", async () => {
    const NAME = "ZCL_PRESENT";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({
      [NAME]: { exists: true, packageName: FLUID_PACKAGE, source: SOURCE_A, active: true },
    });
    const { conn, adt } = await connected(fluidRoute(store));

    const statuses = await classifyFluidTool(conn, cfg(), tool);

    expect(statuses).toEqual([{ name: NAME, type: "CLAS/OC", state: "present" }]);
    expect(nonReadOnlyMutations(adt.calls)).toEqual([]);
  });

  it("stale: correct package, source differs from the manifest", async () => {
    const NAME = "ZCL_STALE";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({
      [NAME]: { exists: true, packageName: FLUID_PACKAGE, source: SOURCE_B, active: true },
    });
    const { conn, adt } = await connected(fluidRoute(store));

    const statuses = await classifyFluidTool(conn, cfg(), tool);

    expect(statuses).toEqual([{ name: NAME, type: "CLAS/OC", state: "stale" }]);
    expect(nonReadOnlyMutations(adt.calls)).toEqual([]);
  });

  it("inactive: correct package, matching source, main include not active", async () => {
    const NAME = "ZCL_INACTIVE";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({
      [NAME]: { exists: true, packageName: FLUID_PACKAGE, source: SOURCE_A, active: false },
    });
    const { conn, adt } = await connected(fluidRoute(store));

    const statuses = await classifyFluidTool(conn, cfg(), tool);

    expect(statuses).toEqual([{ name: NAME, type: "CLAS/OC", state: "inactive" }]);
    expect(nonReadOnlyMutations(adt.calls)).toEqual([]);
  });

  it("broken: correct package, matching source, active, dirty checkrun", async () => {
    const NAME = "ZCL_BROKEN";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({
      [NAME]: { exists: true, packageName: FLUID_PACKAGE, source: SOURCE_A, active: true },
    });
    const { conn, adt } = await connected(fluidRoute(store, { checkrun: resp(200, checkrunDirty(NAME), OK_XML) }));

    const statuses = await classifyFluidTool(conn, cfg(), tool);

    expect(statuses).toEqual([{ name: NAME, type: "CLAS/OC", state: "broken" }]);
    expect(nonReadOnlyMutations(adt.calls)).toEqual([]);
  });

  it("foreign: exists in a package that is neither FLUID_PACKAGE nor legacy", async () => {
    const NAME = "ZCL_FOREIGN";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({
      [NAME]: { exists: true, packageName: "ZOTHER", source: SOURCE_A, active: true },
    });
    const { conn, adt } = await connected(fluidRoute(store));

    const statuses = await classifyFluidTool(conn, cfg(), tool);

    expect(statuses).toEqual([{ name: NAME, type: "CLAS/OC", state: "foreign", foundIn: "ZOTHER" }]);
    expect(nonReadOnlyMutations(adt.calls)).toEqual([]);
  });

  it("legacy: reserved name sitting in $TMP", async () => {
    const NAME = "ZCL_ZMCP_DEMO";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({
      [NAME]: { exists: true, packageName: "$TMP", source: SOURCE_A, active: true },
    });
    const { conn, adt } = await connected(fluidRoute(store));

    const statuses = await classifyFluidTool(conn, cfg(), tool);

    expect(statuses).toEqual([{ name: NAME, type: "CLAS/OC", state: "legacy", foundIn: "$TMP" }]);
    expect(nonReadOnlyMutations(adt.calls)).toEqual([]);
  });

  it("absent: no object at all", async () => {
    const NAME = "ZCL_ABSENT";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({ [NAME]: { exists: false } });
    const { conn, adt } = await connected(fluidRoute(store));

    const statuses = await classifyFluidTool(conn, cfg(), tool);

    expect(statuses).toEqual([{ name: NAME, type: "CLAS/OC", state: "absent" }]);
    expect(nonReadOnlyMutations(adt.calls)).toEqual([]);
  });
});

describe("D23 — the fluid API refuses before issuing any request", () => {
  const NAME = "ZCL_REFUSED";

  it("readOnly: true blocks both ensureFluidTool and classifyFluidTool with zero requests", async () => {
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({ [NAME]: { exists: false } });
    const { conn, adt } = await connected(fluidRoute(store));
    const roCfg = cfg({ readOnly: true });

    const err1 = await catchErr(ensureFluidTool(conn, gate(), roCfg, tool, CTX));
    expect(err1.code).toBe("FLUID_API_DISABLED");
    expect(adt.calls).toEqual([]);

    const err2 = await catchErr(classifyFluidTool(conn, roCfg, tool));
    expect(err2.code).toBe("FLUID_API_DISABLED");
    expect(adt.calls).toEqual([]);
  });

  it("fluidApi: false blocks both ensureFluidTool and classifyFluidTool with zero requests", async () => {
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({ [NAME]: { exists: false } });
    const { conn, adt } = await connected(fluidRoute(store));
    const offCfg = cfg({ fluidApi: false });

    const err1 = await catchErr(ensureFluidTool(conn, gate(), offCfg, tool, CTX));
    expect(err1.code).toBe("FLUID_API_DISABLED");
    expect(adt.calls).toEqual([]);

    const err2 = await catchErr(classifyFluidTool(conn, offCfg, tool));
    expect(err2.code).toBe("FLUID_API_DISABLED");
    expect(adt.calls).toEqual([]);
  });
});

// --- P2: one-shot session revive after the delete-then-write choreography --

/**
 * Live capture shape (also used by fluid-bridge-package.test.ts's
 * `ICMENOSESSION_RESPONSE`, same header pair): a 400 whose body fails to
 * parse as ADT XML, which is the one shape `classifySessionFailure` — and
 * the connection's own wire-level death detector — can see.
 */
const ICMENOSESSION_RESPONSE = (): HttpClientResponse =>
  resp(400, "Session Timed Out — ICM: no session (not XML)", {
    "content-type": "text/html",
    "x-sap-icm-err-id": "ICMENOSESSION",
    "sap-err-id": "ICMENOSESSION",
  });

const LOGIN_URL = "compatibility/graph";

/**
 * `fluidRoute`, but the class-path GET (the existence/package check inside
 * `resolveWriteTarget`) dies with the session-death shape `diesTimes` times
 * in a row once a DELETE for that same class has been seen — modelling the
 * live A4H finding that deleting a class tears the session down, so the very
 * next request on those cookies gets `SESSION_DEAD`. The DELETE's own
 * read-back (a GET on the *source* URI, done inside `deleteObject` itself,
 * with its own independent one-shot revive in `probeObjectPresence`) is
 * deliberately left alone — only the class-path GET dies, matching
 * `respondStrandedInTmpSessionDies` in fluid-bridge-package.test.ts. A hit on
 * the login endpoint (`conn.connect()`'s revive) does not by itself clear
 * the count: `diesTimes: 2` keeps the class GET dying even across a
 * reconnect, for the not-a-loop test.
 */
function fluidRouteSessionDies(store: Record<string, ObjState>, className: string, diesTimes: number): Route {
  const inner = fluidRoute(store);
  const uri = classUri(className);
  let deleted = false;
  let deathsLeft = diesTimes;
  return (r) => {
    if (r.method === "DELETE" && r.url === uri) {
      deleted = true;
      return inner(r);
    }
    if (deleted && r.url === uri && r.method === "GET" && !r.qs._action && deathsLeft > 0) {
      deathsLeft -= 1;
      return ICMENOSESSION_RESPONSE();
    }
    return inner(r);
  };
}

describe("ensureFluidTool — legacy relocation survives the delete killing the session", () => {
  it("a legacy object relocated out of $TMP survives the delete killing the session: one revive, then the recreate succeeds", async () => {
    const NAME = "ZCL_ZMCP_REVIVE1";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({
      [NAME]: { exists: true, packageName: "$TMP", source: SOURCE_A, active: true },
    });
    const { conn, adt } = await connected(fluidRouteSessionDies(store, NAME, 1));

    const result = await ensureFluidTool(conn, gate(), cfg(), tool, CTX);

    expect(result.deployed).toBe(true);
    expect(result.objects).toEqual([{ name: NAME, type: "CLAS/OC", state: "present" }]);
    expect(store[NAME]?.packageName).toBe(FLUID_PACKAGE);

    const delIdx = adt.calls.findIndex((c) => c.method === "DELETE" && c.url === classUri(NAME));
    expect(delIdx).toBeGreaterThanOrEqual(0);

    // Exactly one revive: one login strictly between the post-delete class
    // GET that died and the one that succeeded.
    const after = adt.calls.slice(delIdx + 1);
    const classGets = after.filter((c) => c.url === classUri(NAME) && c.method === "GET" && !c.qs._action);
    expect(classGets.length).toBe(2);
    const logins = after.filter((c) => c.url.includes(LOGIN_URL));
    expect(logins.length).toBe(1);

    const idxFirstGet = after.indexOf(classGets[0]!);
    const idxLogin = after.findIndex((c) => c.url.includes(LOGIN_URL));
    const idxSecondGet = after.lastIndexOf(classGets[1]!);
    expect(idxFirstGet).toBeGreaterThanOrEqual(0);
    expect(idxFirstGet).toBeLessThan(idxLogin);
    expect(idxLogin).toBeLessThan(idxSecondGet);
  });

  it("a second consecutive session death on the retry is not swallowed by a second reconnect", async () => {
    const NAME = "ZCL_ZMCP_REVIVE2";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({
      [NAME]: { exists: true, packageName: "$TMP", source: SOURCE_A, active: true },
    });
    const { conn, adt } = await connected(fluidRouteSessionDies(store, NAME, 2));

    const err = await catchErr(ensureFluidTool(conn, gate(), cfg(), tool, CTX));
    expect(err.code).toBe("SESSION_DEAD");

    // Exactly one reconnect attempted — the second death is not itself retried.
    const delIdx = adt.calls.findIndex((c) => c.method === "DELETE" && c.url === classUri(NAME));
    expect(delIdx).toBeGreaterThanOrEqual(0);
    const after = adt.calls.slice(delIdx + 1);
    const classGets = after.filter((c) => c.url === classUri(NAME) && c.method === "GET" && !c.qs._action);
    expect(classGets.length).toBe(2);
    const logins = after.filter((c) => c.url.includes(LOGIN_URL));
    expect(logins.length).toBe(1);
  });
});

// --- P2: the "broken" repair path (delete-then-recreate, not a no-op rewrite) --

/**
 * `fluidRoute`, but the `checkruns` POST answers with each response in
 * `results` in turn (holding the last one for any call past the end) —
 * lets a test make `classifyOne`'s check dirty, then a later `checkSource`
 * call (after the broken object has been repaired) clean, or keep it dirty
 * throughout to prove a still-broken object is reported honestly.
 */
function fluidRouteCheckrunSequence(store: Record<string, ObjState>, results: readonly HttpClientResponse[]): Route {
  const inner = fluidRoute(store);
  let i = 0;
  return (r) => {
    if (r.url.startsWith("/sap/bc/adt/checkruns") && r.method === "POST") {
      const result = results[Math.min(i, results.length - 1)]!;
      i += 1;
      return result;
    }
    return inner(r);
  };
}

describe("ensureFluidTool — broken repair", () => {
  it("a broken object is repaired by delete-then-recreate, not by a no-op rewrite", async () => {
    const NAME = "ZCL_BROKEN_FIX";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({
      [NAME]: { exists: true, packageName: FLUID_PACKAGE, source: SOURCE_A, active: true },
    });
    const { conn, adt } = await connected(
      fluidRouteCheckrunSequence(store, [
        resp(200, checkrunDirty(NAME), OK_XML), // classifyOne's check: broken
        resp(200, CHECKRUN_CLEAN, OK_XML), // recheck after the repair: clean
      ]),
    );

    const result = await ensureFluidTool(conn, gate(), cfg(), tool, CTX);

    expect(result.deployed).toBe(true);
    expect(result.objects).toEqual([{ name: NAME, type: "CLAS/OC", state: "present" }]);

    // The key assertion: repairing "broken" must actually delete the class,
    // not silently no-op because a rewrite of identical content short-circuits.
    expect(adt.calls.filter((c) => c.method === "DELETE" && c.url === classUri(NAME))).toHaveLength(1);

    const registry = await readFluidRegistry(cfg(), systemKey(conn.cfg));
    expect(registry.get(tool.manifest.id)?.version).toBe(tool.version);
  });

  it("a still-broken object after one repair is reported broken and not cached", async () => {
    const NAME = "ZCL_BROKEN_STILL";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({
      [NAME]: { exists: true, packageName: FLUID_PACKAGE, source: SOURCE_A, active: true },
    });
    const { conn, adt } = await connected(
      // Every checkruns call answers dirty — the repair does not fix it.
      fluidRouteCheckrunSequence(store, [resp(200, checkrunDirty(NAME), OK_XML)]),
    );

    const result = await ensureFluidTool(conn, gate(), cfg(), tool, CTX);

    expect(result.objects).toEqual([{ name: NAME, type: "CLAS/OC", state: "broken" }]);
    expect(result.deployed).toBe(true);
    expect(adt.calls.filter((c) => c.method === "DELETE" && c.url === classUri(NAME))).toHaveLength(1);

    // Still broken after the one repair attempt must not be cached: no
    // registry entry for this tool, and the manifest stays un-recorded so
    // the next call classifies from scratch instead of trusting a lie.
    const registry = await readFluidRegistry(cfg(), systemKey(conn.cfg));
    expect(registry.get(tool.manifest.id)).toBeUndefined();
  });
});
