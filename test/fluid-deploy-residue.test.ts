/**
 * Fluid deploy path: any failure after `writeObject` succeeds must disclose
 * the class it left behind, exactly like `deployBridge` (src/adt/run.ts)
 * already does for the classic bridge path. Harness copied verbatim from
 * `test/fluid-ensure.test.ts` (FakeAdtServer has no builtin route for
 * activation/checkrun/DELETE), since these are the only two files that build
 * this hand-rolled recording HttpClient.
 */
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate, type Operation, type SafetyTarget, type EvaluateOptions } from "../src/safety.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { ensureFluidTool, resetFluidEnsureState, type FluidCallContext } from "../src/adt/fluid/ensure.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { manifestVersion, type FluidManifest, type LoadedFluidTool } from "../src/adt/fluid/manifest.js";
// Dynamic, not static: on a checkout before bridge-residue.ts exists this must
// fail inside the one test that needs it, not abort the whole file's collection.
const bridgeResidue = () => import("../src/adt/bridge-residue.js");

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

async function withTmpDir<T>(fn: () => Promise<T>): Promise<T> {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-residue-"));
  resetFluidEnsureState();
  resetFluidPackageMemo();
  try {
    return await fn();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

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

/** Blocks `activate` specifically — everything else passes through the real gate. */
class GateBlocksActivate extends SafetyGate {
  assert(op: Operation, obj?: SafetyTarget, opts?: EvaluateOptions): void {
    if (op === "activate") {
      throw new AbapError(
        "SAFETY_DENIED",
        "activate is blocked for this test",
        { operation: op, object: obj?.name },
      );
    }
    super.assert(op, obj, opts);
  }
}

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

interface RouteOpts {
  checkrun?: HttpClientResponse;
  activation?: HttpClientResponse;
  /** The source GET (contentConfirmed's read-back) answers this instead of the store's content. */
  sourceGetOverride?: HttpClientResponse;
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
        if (opts.sourceGetOverride) return opts.sourceGetOverride;
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

function makeTool(objects: readonly { name: string; source: string }[], id = "t1"): LoadedFluidTool {
  const manifest: FluidManifest = {
    contract: "1.0",
    id,
    title: "Test tool",
    description: "a fluid tool used only by fluid-deploy-residue.test.ts",
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

describe("fluid deploy — activation failure discloses the class it left behind", () => {
  it("write succeeds, activation fails: hint names the class, the package, and safe-to-delete, details carry bridgeLeftBehind/bridgeClass, code is unchanged", async () => {
    await withTmpDir(async () => {
      const NAME = "ZCL_RESIDUE_ACT";
      const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
      const store = makeStore({ [NAME]: { exists: false } });
      const { conn } = await connected(fluidRoute(store, { activation: resp(500, "<x/>", OK_XML) }));

      const err = await catchErr(ensureFluidTool(conn, gate(), cfg(), tool, CTX));

      expect(err.code).toBe("ADT_ERROR");
      expect(err.hint).toContain(`Bridge class ${NAME} was written to ${FLUID_PACKAGE}`);
      expect(err.hint).toContain("failed to activate");
      expect(err.hint).toContain("safe to delete");
      expect(err.details.bridgeLeftBehind).toBe(true);
      expect(err.details.bridgeClass).toBe(NAME);

      // The class really did land — the residue disclosure is honest, not aspirational.
      expect(store[NAME]?.exists).toBe(true);
      expect(store[NAME]?.active).toBe(false);
    });
  });
});

describe("fluid deploy — the gate refusing activate after the write landed", () => {
  it("discloses the class as left behind, wording it as blocked before activation could run", async () => {
    await withTmpDir(async () => {
      const NAME = "ZCL_RESIDUE_GATE";
      const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
      const store = makeStore({ [NAME]: { exists: false } });
      const { conn } = await connected(fluidRoute(store));

      const err = await catchErr(ensureFluidTool(conn, new GateBlocksActivate({
        readOnly: false,
        allowPackages: ["*"],
        allowNamePrefixes: ["*"],
      }), cfg(), tool, CTX));

      expect(err.code).toBe("SAFETY_DENIED");
      expect(err.hint).toContain(`Bridge class ${NAME} was written to ${FLUID_PACKAGE}`);
      expect(err.hint).toContain("was blocked before activation could run");
      expect(err.hint).toContain("safe to delete");
      expect(err.details.bridgeLeftBehind).toBe(true);
      expect(err.details.bridgeClass).toBe(NAME);

      expect(store[NAME]?.exists).toBe(true);
      expect(store[NAME]?.active).toBe(false);
    });
  });
});

describe("discloseBridgeResidue — idempotence", () => {
  it("returns an already-disclosed error unchanged, so the sentence is not appended twice", async () => {
    const { discloseBridgeResidue } = await bridgeResidue();

    const first = discloseBridgeResidue(
      new AbapError("ADT_ERROR", "boom", {}, "original hint"),
      "ZCL_TWICE",
      FLUID_PACKAGE,
      "activation",
    );
    expect(isAbapError(first)).toBe(true);
    const firstHint = isAbapError(first) ? first.hint : undefined;
    expect(firstHint).toBeDefined();
    const occurrences = (firstHint!.match(/safe to delete/g) ?? []).length;
    expect(occurrences).toBe(1);

    const second = discloseBridgeResidue(first, "ZCL_TWICE", FLUID_PACKAGE, "verify");
    expect(second).toBe(first);
    expect(isAbapError(second) && second.hint).toBe(firstHint);
    const secondOccurrences = (isAbapError(second) && second.hint ? second.hint : "").match(/safe to delete/g) ?? [];
    expect(secondOccurrences.length).toBe(1);
  });
});

describe("fluid deploy — happy path adds no residue disclosure anywhere", () => {
  it("a clean deploy throws nothing and the result carries no residue-shaped field", async () => {
    await withTmpDir(async () => {
      const NAME = "ZCL_RESIDUE_CLEAN";
      const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
      const store = makeStore({ [NAME]: { exists: false } });
      const { conn } = await connected(fluidRoute(store));

      const result = await ensureFluidTool(conn, gate(), cfg(), tool, CTX);

      expect(result.deployed).toBe(true);
      expect(result.objects).toEqual([{ name: NAME, type: "CLAS/OC", state: "present" }]);

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("bridgeLeftBehind");
      expect(serialized).not.toContain("safe to delete");
    });
  });
});

describe("fluid deploy — content-verify stage", () => {
  it("a failed post-activation read-back discloses the class as left behind, activated", async () => {
    await withTmpDir(async () => {
      const NAME = "ZCL_RESIDUE_VERIFY";
      const tool = makeTool([{ name: NAME, source: SOURCE_A }]);
      const store = makeStore({ [NAME]: { exists: false } });
      const { conn } = await connected(
        fluidRoute(store, { sourceGetOverride: resp(500, "<x/>", OK_XML) }),
      );

      const err = await catchErr(ensureFluidTool(conn, gate(), cfg(), tool, CTX));

      expect(err.code).toBe("ADT_ERROR");
      expect(err.hint).toContain(`Bridge class ${NAME} was written to ${FLUID_PACKAGE}`);
      expect(err.hint).toContain("failed the source read-back that confirms what landed");
      expect(err.hint).toContain("safe to delete");
      expect(err.details.bridgeLeftBehind).toBe(true);
      expect(err.details.bridgeClass).toBe(NAME);

      // Activation itself succeeded — only the confirmation read failed.
      expect(store[NAME]?.exists).toBe(true);
      expect(store[NAME]?.active).toBe(true);
    });
  });
});
