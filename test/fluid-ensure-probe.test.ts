/**
 * Offline coverage for the additive `ensure.ts` behavior added to fix the
 * "registry says present, server disagrees" defect: the genuine behavioral
 * divergence between `classifyFluidTool` (always asks the server; see its
 * doc comment in ensure.ts) and `ensureFluidTool`'s cache-trusting fast path,
 * plus `isFluidObjectMissingFailure` (the missing-class predicate for the
 * dispatch-side self-heal) and `recoverMissingFluidObject` (forget + redeploy
 * once). Same FakeAdt idiom as `test/fluid-ensure.test.ts` — nothing there is
 * exported, so the harness is re-built here rather than imported.
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
import { AbapError } from "../src/adt/errors.js";
import { systemKey } from "../src/journal.js";
import {
  ensureFluidTool,
  classifyFluidTool,
  isFluidObjectMissingFailure,
  recoverMissingFluidObject,
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

function fluidRoute(store: Record<string, ObjState>): Route {
  const checkrunResp = resp(200, CHECKRUN_CLEAN, OK_XML);
  const activationResp = resp(200, "", OK_TEXT);

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
        const body = st.source;
        if (body === undefined) return resp(404, notFoundXml(name), OK_XML);
        return resp(200, body, OK_TEXT);
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

function makeTool(objects: readonly { name: string; source: string }[], id = "t1"): LoadedFluidTool {
  const manifest: FluidManifest = {
    contract: "1.0",
    id,
    title: "Test tool",
    description: "a fluid tool used only by fluid-ensure-probe.test.ts",
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

async function withRegistryHit(
  tool: LoadedFluidTool,
  store: Record<string, ObjState>,
): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const { conn, adt } = await connected(fluidRoute(store));
  await recordManifest(cfg(), systemKey(conn.cfg), {
    toolId: tool.manifest.id,
    contract: tool.manifest.contract,
    version: tool.version,
    objects: tool.manifest.objects.map((o) => o.name),
    deployedAt: new Date().toISOString(),
  });
  adt.calls.length = 0;
  return { conn, adt };
}

describe("classifyFluidTool vs ensureFluidTool: the registry-cache divergence", () => {
  it("classifyFluidTool reports absent on live server state the registry doesn't know about, while ensureFluidTool's cache-trusting fast path reports the same object present", async () => {
    const NAME = "ZCL_DIVERGE";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({ [NAME]: { exists: false } });
    // withRegistryHit records a manifest entry at this tool's current
    // contract/version — the exact condition ensureFluidTool's short-circuit
    // (readFluidRegistry + a contract/version match) checks for.
    const { conn } = await withRegistryHit(tool, store);

    // ensureFluidTool: cache-trusting fast path. The registry entry matches
    // contract+version, so it returns immediately without any server call —
    // every object reported "present" — even though the server has never
    // been asked on this connection and the fake store says the class does
    // not exist.
    const cached = await ensureFluidTool(conn, gate(), cfg(), tool, CTX);
    expect(cached.deployed).toBe(false);
    expect(cached.objects).toEqual([{ name: NAME, type: "CLAS/OC", state: "present" }]);

    // classifyFluidTool: always-live classification, same connection, same
    // registry entry still on disk. It ignores the registry entirely and
    // asks the server directly, so it reports what the server actually has —
    // "absent" — the opposite value from what ensureFluidTool just reported
    // for the identical on-disk state. This is the real bug: two functions
    // disagreeing about the same object's existence, not merely a call that
    // throws because an export is missing.
    const live = await classifyFluidTool(conn, cfg(), tool);
    expect(live).toEqual([{ name: NAME, type: "CLAS/OC", state: "absent" }]);
    expect(live).not.toEqual(cached.objects);
  });
});

describe("isFluidObjectMissingFailure", () => {
  it("is true for an AbapError NOT_FOUND", () => {
    const e = new AbapError("NOT_FOUND", "ZCL_X does not exist.");
    expect(isFluidObjectMissingFailure(e)).toBe(true);
  });

  it("is false for an unrelated AbapError code", () => {
    const e = new AbapError("CHECK_FAILED", "Syntax error in ZCL_X.");
    expect(isFluidObjectMissingFailure(e)).toBe(false);
  });

  it("is false for a plain Error and for non-error values", () => {
    expect(isFluidObjectMissingFailure(new Error("boom"))).toBe(false);
    expect(isFluidObjectMissingFailure("boom")).toBe(false);
    expect(isFluidObjectMissingFailure(undefined)).toBe(false);
  });
});

describe("recoverMissingFluidObject", () => {
  it("forgets the stale registry entry and redeploys, instead of trusting the cache", async () => {
    const NAME = "ZCL_RECOVER";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
    const store = makeStore({ [NAME]: { exists: false } });
    const { conn, adt } = await withRegistryHit(tool, store);

    const stillCached = await ensureFluidTool(conn, gate(), cfg(), tool, CTX);
    expect(stillCached.deployed).toBe(false);
    expect(adt.calls).toEqual([]);

    const recovered = await recoverMissingFluidObject(conn, gate(), cfg(), tool, CTX);
    expect(recovered.deployed).toBe(true);
    expect(recovered.objects).toEqual([{ name: NAME, type: "CLAS/OC", state: "present" }]);
    expect(adt.labels.some((l) => l.startsWith("PUT"))).toBe(true);

    const registry = await readFluidRegistry(cfg(), systemKey(conn.cfg));
    expect(registry.get(tool.manifest.id)?.version).toBe(tool.version);
  });
});
