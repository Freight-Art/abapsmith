/**
 * Offline coverage for the additive `ensure.ts` behavior added to fix the
 * "registry says present, server disagrees" defect: the genuine behavioral
 * divergence between `classifyFluidTool` (always asks the server; see its
 * doc comment in ensure.ts) and `ensureFluidTool`'s cache-trusting fast path,
 * plus `probeFluidObjectsExist`/`anyFluidObjectMissing` (the existence-probe
 * dispatch.ts's self-heal now gates on — a provable server fact over the
 * tool's manifest objects, not a classification of the failing error's own
 * code/message text; see their doc comments in ensure.ts for why free-text
 * matching on the failure was replaced) and `recoverMissingFluidObject`
 * (forget + redeploy once). Same FakeAdt idiom as `test/fluid-ensure.test.ts`
 * — nothing there is exported, so the harness is re-built here rather than
 * imported.
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
import { systemKey } from "../src/journal.js";
import {
  ensureFluidTool,
  classifyFluidTool,
  anyFluidObjectMissing,
  probeFluidObjectsExist,
  recoverMissingFluidObject,
  resetFluidEnsureState,
  type FluidCallContext,
} from "../src/adt/fluid/ensure.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { readFluidRegistry, recordManifest } from "../src/adt/fluid/registry.js";
import { manifestVersion, type FluidManifest, type LoadedFluidTool } from "../src/adt/fluid/manifest.js";
import { dispatch, type FluidDeps } from "../src/adt/fluid/dispatch.js";
import { canonicalArgsJson, invokerName, invokerSource } from "../src/adt/fluid/invoke.js";

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

describe("probeFluidObjectsExist / anyFluidObjectMissing", () => {
  it("probeFluidObjectsExist reports each manifest object's live existence independently", async () => {
    const PRESENT = "ZCL_PROBE_PRESENT";
    const ABSENT = "ZCL_PROBE_ABSENT";
    const tool = makeTool(
      [
        { name: PRESENT, source: SOURCE_A },
        { name: ABSENT, source: SOURCE_A },
      ],
      "probe-mixed",
    );
    const store = makeStore({
      [PRESENT]: { exists: true, packageName: FLUID_PACKAGE, source: SOURCE_A, active: true },
      [ABSENT]: { exists: false },
    });
    const { conn } = await connected(fluidRoute(store));

    const presence = await probeFluidObjectsExist(conn, tool);
    expect(presence).toEqual([
      { name: PRESENT, type: "CLAS/OC", exists: true },
      { name: ABSENT, type: "CLAS/OC", exists: false },
    ]);
  });

  it("anyFluidObjectMissing is true the moment any single manifest object is provably absent on the server", async () => {
    const PRESENT = "ZCL_ANY_PRESENT";
    const ABSENT = "ZCL_ANY_ABSENT";
    const tool = makeTool(
      [
        { name: PRESENT, source: SOURCE_A },
        { name: ABSENT, source: SOURCE_A },
      ],
      "any-mixed",
    );
    const store = makeStore({
      [PRESENT]: { exists: true, packageName: FLUID_PACKAGE, source: SOURCE_A, active: true },
      [ABSENT]: { exists: false },
    });
    const { conn } = await connected(fluidRoute(store));

    expect(await anyFluidObjectMissing(conn, tool)).toBe(true);
  });

  it("anyFluidObjectMissing is false when every manifest object actually exists on the server — a genuine codegen defect (e.g. CHECK_FAILED) must not be papered over by recovery in this case", async () => {
    const NAME = "ZCL_ANY_ALL_PRESENT";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }], "any-all-present");
    const store = makeStore({
      [NAME]: { exists: true, packageName: FLUID_PACKAGE, source: SOURCE_A, active: true },
    });
    const { conn } = await connected(fluidRoute(store));

    expect(await anyFluidObjectMissing(conn, tool)).toBe(false);
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

describe("dispatch(): the retry must actually get the invoker's compiled program regenerated", () => {
  it("forceInvokerRegeneration issues the invoker's activation POST strictly between the two classrun attempts — not merely 'the retry didn't throw'", async () => {
    const NAME = "ZCL_ZMCP_DEMO3";
    const tool = makeTool([{ name: NAME, source: SOURCE_A }], "t3");
    const action = tool.manifest.actions[0]!;
    const args = {};
    const argsJson = canonicalArgsJson(args);

    // Independently computed with the exact same pure functions dispatch.ts
    // uses internally, from the exact same inputs — this is what makes the
    // store's invoker entry (below) byte-identical to what dispatch.ts will
    // itself derive, which is what triggers deployBridge's F6 "already
    // active, nothing to do" shortcut on BOTH of dispatch's own attempts.
    const invoker = invokerName(tool.manifest.id, action.name, args, tool.manifest.contract);
    const invokerSrc = invokerSource({
      name: invoker,
      entry: tool.manifest.entry,
      toolId: tool.manifest.id,
      action: action.name,
      argsJson,
      version: tool.version,
      contract: tool.manifest.contract,
      commit: action.category === "mutate",
    });

    // The body class is actually gone — the real-world precondition this
    // whole mechanism exists for (see `anyFluidObjectMissing`'s doc in
    // ensure.ts). The invoker, in contrast, starts present, active, and
    // byte-matching what dispatch.ts will itself derive: unchanged from
    // deployBridge's point of view, so its own F6 shortcut ("already active,
    // nothing to do") engages on BOTH of dispatch's attempts and the invoker
    // is never re-activated by deployBridge itself — its stale compiled
    // program runs and dumps against the now-missing body class. Because the
    // body class genuinely does not exist right now, the new probe-based
    // catch in dispatch.ts (`anyFluidObjectMissing`) correctly finds it
    // missing and recovers, instead of rethrowing the dump unchanged.
    const store = makeStore({
      [NAME]: { exists: false, packageName: FLUID_PACKAGE },
      [invoker]: { exists: true, packageName: FLUID_PACKAGE, source: invokerSrc, active: true },
    });

    const dumpBody =
      `<!DOCTYPE html><html><head><title>Application Server Error</title></head><body>` +
      `<div class="err"><h1>500 Internal Server Error</h1>` +
      `<p>Error: Syntax error in program "${invoker}===========CP" (termination: RABAX_STATE)</p>` +
      `<p class="detailText"><span id="msgText">Server time: n/a</span></p>` +
      `</div></body></html>`;

    const successFrames =
      `ZMCP-H>BEGIN ${JSON.stringify({ id: tool.manifest.id, ver: tool.version, action: action.name, contract: tool.manifest.contract })}\n` +
      `ZMCP-H>OUT ${JSON.stringify({ ok: true })}\n` +
      `ZMCP-H>END ${JSON.stringify({ rc: 0, outBytes: 0, ms: 1, truncated: false })}\n`;

    // The classrun POST is intercepted directly (ahead of fluidRoute, which
    // has no notion of "dump the first time, succeed the second") — every
    // other request (GET/PUT/LOCK/UNLOCK/activation/checkrun/package) goes
    // through the same static store-backed fluidRoute the rest of this file
    // uses, so any activation POST it serves for the invoker is still the
    // one under test.
    let classrunCalls = 0;
    const route: Route = (r) => {
      if (r.method === "POST" && r.url === `/sap/bc/adt/oo/classrun/${invoker}`) {
        classrunCalls += 1;
        if (classrunCalls === 1) {
          return resp(500, dumpBody, { "content-type": "text/html; charset=utf-8", connection: "close" });
        }
        return resp(200, successFrames, OK_TEXT);
      }
      return fluidRoute(store)(r);
    };

    const { conn, adt } = await connected(route);
    await recordManifest(cfg(), systemKey(conn.cfg), {
      toolId: tool.manifest.id,
      contract: tool.manifest.contract,
      version: tool.version,
      objects: tool.manifest.objects.map((o) => o.name),
      deployedAt: new Date().toISOString(),
    });
    adt.calls.length = 0;

    const deps: FluidDeps = {
      conn,
      cfg: cfg(),
      gate: gate(),
      tools: new Map([[tool.manifest.id, tool]]),
    };

    const result = await dispatch(deps, { tool: tool.manifest.id, action: action.name, args });
    expect(result.result).toEqual({ ok: true });

    // Two classrun attempts happened — the retry actually ran the invoker
    // again, it did not just swallow the first failure.
    expect(classrunCalls).toBe(2);

    const indices = (pred: (c: Recorded) => boolean): number[] =>
      adt.calls.reduce<number[]>((acc, c, i) => (pred(c) ? [...acc, i] : acc), []);

    const classrunIdx = indices(
      (c) => c.method === "POST" && c.url === `/sap/bc/adt/oo/classrun/${invoker}`,
    );
    expect(classrunIdx.length).toBe(2);

    const invokerActivationIdx = indices(
      (c) =>
        c.method === "POST" &&
        c.url === "/sap/bc/adt/activation" &&
        (c.body ?? "").includes(`adtcore:name="${invoker}"`),
    );

    // The crux: exactly one activation POST targeted the invoker, and it
    // happened strictly between the two classrun calls — i.e. it is
    // `forceInvokerRegeneration`'s own POST, not one `deployBridge` issued on
    // its own on either attempt (both hit the F6 "already active, unchanged"
    // shortcut, since the invoker's source and active-metadata never
    // actually diverged from what the store already had). If this predicate
    // fix let the retry fire but the invoker's stale compiled program was
    // never forced to regenerate, this assertion — not just "no exception
    // escaped" — is what would catch it.
    expect(invokerActivationIdx.length).toBe(1);
    expect(invokerActivationIdx[0]).toBeGreaterThan(classrunIdx[0]!);
    expect(invokerActivationIdx[0]).toBeLessThan(classrunIdx[1]!);
  });
});
