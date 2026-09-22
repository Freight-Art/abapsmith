/**
 * The builtin `classic` fluid tool (`src/adt/fluid/builtin/classic.ts`):
 * deploy/cache lifecycle of its two body objects, all nine mutation round
 * trips plus `exists`, the domain gates that sit in front of `dispatch`'s
 * own gate, and the two module-boundary facts (`ddic-bridge.ts` exports,
 * the REST-only DDIC pin) other slices depend on. Same offline harness idiom
 * as `test/fluid-dispatch.test.ts`, duplicated here rather than imported —
 * that file has no exported surface for tests to share.
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
import { dispatch } from "../src/adt/fluid/dispatch.js";
import { ensureFluidTool, resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { SERVER_VERSION } from "../src/version.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import { readFluidRegistry } from "../src/adt/fluid/registry.js";
import {
  manifestVersion,
  FluidManifestSchema,
  type FluidActionSpec,
  type FluidManifest,
  type LoadedFluidTool,
} from "../src/adt/fluid/manifest.js";
import {
  CLASSIC_TOOL_ID,
  CLASSIC_BODY_CLASS,
  classicManifest,
  classicSources,
  classicTool,
} from "../src/adt/fluid/builtin/classic.js";
import { FLUID_RUNTIME_CLASS } from "../src/adt/fluid/abap/runtime.js";
import { createClassicView } from "../src/adt/view-create.js";
import { deleteClassicViewViaBridge } from "../src/adt/view-delete.js";
import { createTransaction } from "../src/adt/tran-create.js";
import { deleteTransactionViaBridge } from "../src/adt/tran-delete.js";
import { createSecondaryIndex, deleteSecondaryIndexViaBridge } from "../src/adt/index-create.js";
import { createPackageViaBridge } from "../src/adt/package-create.js";
import { deletePackageViaBridge } from "../src/adt/package-delete.js";
import { removeTransportEntryViaBridge } from "../src/adt/transport-entry-remove.js";
import { authorizeCeiling } from "../src/adt/transports.js";
import { serverPackage, type ServerPackage } from "../src/adt/resolved-package.js";
import { ddicBridgeSource } from "../src/adt/ddic-bridge.js";
import { BRIDGE_CREATABLE_TYPES, isBridgeCreatableType, isBridgeOnlyCreateType } from "../src/adt/capabilities.js";
import { abapWrite } from "../src/tools/write.js";
import { packagePart } from "../src/adt/fluid/builtin/classic/abap-package.js";

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
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-fluid-classic-"));
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

const gate = (): SafetyGate => new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"] });

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

const CHECKRUN_CLEAN =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:atom="http://www.w3.org/2005/Atom"/>`;

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

/** Auto-vivifying class store — see test/fluid-dispatch.test.ts's copy of this for the full rationale. */
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

    // classifyOne() syntax-checks an already-active, content-matching object
    // as its last gate before declaring it "present" — read-only, not a mutation.
    if (r.url.startsWith("/sap/bc/adt/checkruns") && r.method === "POST") {
      return resp(200, CHECKRUN_CLEAN, OK_XML);
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
    description: "fluid-classic.test.ts fixture",
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

function buildTranscript(opts: { id?: string; ver: string; action: string; outs?: readonly unknown[] }): string {
  const lines: string[] = [];
  lines.push(frameLine("BEGIN", { id: opts.id ?? CLASSIC_TOOL_ID, ver: opts.ver, action: opts.action, contract: "1.0" }));
  for (const v of opts.outs ?? []) lines.push(frameLine("OUT", v));
  lines.push(frameLine("END", { rc: 0, outBytes: 0, truncated: false, ms: 1 }));
  return lines.join("\n") + "\n";
}

/** Every classic-action test drives the real `classicTool`, so its canned transcript must claim the real deployed version. */
const classicTranscript = (opts: { action: string; outs: readonly unknown[] }) =>
  buildTranscript({ ver: classicTool.version, action: opts.action, outs: opts.outs });

const RUNTIME_URI = `${classUri(FLUID_RUNTIME_CLASS)}/source/main`;
const BODY_URI = `${classUri(CLASSIC_BODY_CLASS)}/source/main`;

// A $-prefixed server-resolved package, for the operations whose params require a ServerPackage brand.
const localServerPackage = (name = "$TMP"): ServerPackage =>
  serverPackage({ status: "confirmed", uri: `fixture://${name}`, via: "read-back", packageName: name })!;

describe("classic tool — cold cache", () => {
  it("first call deploys the runtime and body classes, activates both, then records the manifest", async () => {
    const { route, store } = dynamicFluidRoute({
      transcript: () => classicTranscript({ action: "exists", outs: ["EXISTS"] }),
    });
    const { conn } = await connected(route);

    const result = await ensureFluidTool(conn, gate(), conn.cfg, classicTool, {
      tool: CLASSIC_TOOL_ID,
      action: "exists",
      op: "run",
    });

    expect(result.deployed).toBe(true);
    expect(result.objects.map((o) => o.state)).toEqual(["present", "present"]);
    expect(store.get(FLUID_RUNTIME_CLASS)).toMatchObject({ exists: true, packageName: FLUID_PACKAGE, active: true });
    expect(store.get(CLASSIC_BODY_CLASS)).toMatchObject({ exists: true, packageName: FLUID_PACKAGE, active: true });

    const registry = await readFluidRegistry(conn.cfg, systemKey(conn.cfg));
    expect(registry.get(CLASSIC_TOOL_ID)?.version).toBe(classicTool.version);
  });
});

describe("classic tool — warm cache", () => {
  it("a second call with the version already recorded issues no body-class deploy requests", async () => {
    const { route } = dynamicFluidRoute({
      transcript: () => classicTranscript({ action: "exists", outs: ["EXISTS"] }),
    });
    const { conn, adt } = await connected(route);
    const d = { conn, cfg: conn.cfg, gate: gate(), tools: new Map([[CLASSIC_TOOL_ID, classicTool]]) };
    const req = { tool: CLASSIC_TOOL_ID, action: "exists", args: { kind: "view", name: "ZTM_V1" } };

    await dispatch(d, req);
    const bodyPutsAfterFirst = adt.calls.filter(
      (c) => c.method === "PUT" && (c.url === RUNTIME_URI || c.url === BODY_URI),
    );
    expect(bodyPutsAfterFirst).toHaveLength(2);

    const before = adt.calls.length;
    await dispatch(d, req);
    const sinceSecond = adt.calls.slice(before);
    expect(sinceSecond.filter((c) => c.method === "PUT" && (c.url === RUNTIME_URI || c.url === BODY_URI))).toEqual(
      [],
    );
    // identical args hash to the identical invoker source, so deployBridge's
    // GET-compare-before-PUT skips the invoker PUT too — but the action still
    // runs, proven by a fresh classrun POST on the second call.
    expect(sinceSecond.some((c) => c.method === "POST" && c.url.startsWith(CLASSRUN_BASE))).toBe(true);
  });
});

// Mirrors ensure.ts's own `withDeployedVersionMarker` — not exported, so
// reconstructed here rather than pulled in, to pin the exact line every
// deployed fluid object now carries prepended to its source.
const DEPLOYED_VERSION_MARKER = `* abapsmith fluid v${SERVER_VERSION}\n`;

describe("classic tool — version bump", () => {
  it("rewrites exactly the changed object and no other", async () => {
    const bumpedSource = `${classicSources.get(CLASSIC_BODY_CLASS)}\n* bumped for this test`;
    const bumpedSources = new Map(classicSources);
    bumpedSources.set(CLASSIC_BODY_CLASS, bumpedSource);
    const bumpedTool: LoadedFluidTool = {
      manifest: classicManifest,
      origin: "builtin",
      sources: bumpedSources,
      version: manifestVersion(classicManifest, bumpedSources),
    };
    expect(bumpedTool.version).not.toBe(classicTool.version);

    const { route, store } = dynamicFluidRoute({
      transcript: () => classicTranscript({ action: "exists", outs: ["EXISTS"] }),
    });
    const { conn, adt } = await connected(route);

    await ensureFluidTool(conn, gate(), conn.cfg, classicTool, { tool: CLASSIC_TOOL_ID, action: "exists", op: "run" });
    const runtimeSourceAfterFirst = store.get(FLUID_RUNTIME_CLASS)?.source;

    const before = adt.calls.length;
    const bumpResult = await ensureFluidTool(conn, gate(), conn.cfg, bumpedTool, {
      tool: CLASSIC_TOOL_ID,
      action: "exists",
      op: "run",
    });

    const putsAfterBump = adt.calls.slice(before).filter((c) => c.method === "PUT");
    expect(putsAfterBump.filter((c) => c.url === BODY_URI)).toHaveLength(1);
    expect(putsAfterBump.filter((c) => c.url === RUNTIME_URI)).toEqual([]);
    expect(bumpResult.deployed).toBe(true);
    // Every write now prepends a `* abapsmith fluid v<version>` provenance
    // marker (ensure.ts's `withDeployedVersionMarker`) — pin that the marker
    // is there AND that what follows it is exactly the bumped source, rather
    // than loosening this to a substring check.
    const bodySource = store.get(CLASSIC_BODY_CLASS)?.source ?? "";
    expect(bodySource.startsWith(DEPLOYED_VERSION_MARKER)).toBe(true);
    expect(bodySource.slice(DEPLOYED_VERSION_MARKER.length)).toBe(bumpedSource);
    expect(store.get(FLUID_RUNTIME_CLASS)?.source).toBe(runtimeSourceAfterFirst);
  });
});

describe("classic tool — action round trips", () => {
  it("create_view returns the tags the old bridge returned", async () => {
    const outs = ["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"];
    const { route } = dynamicFluidRoute({ transcript: () => classicTranscript({ action: "create_view", outs }) });
    const { conn } = await connected(route);

    const { transcript } = await createClassicView(conn, gate(), {
      viewName: "ZTM_V1",
      baseTable: "ZTM_T1",
      fields: ["MANDT", "FIELD1"],
      description: "Test view",
      packageName: "$TMP",
    });

    expect(transcript.tags).toEqual(outs);
  });

  it("delete_view returns the tags the old bridge returned", async () => {
    const outs = ["VIEW-DELETED", "VIEW-GONE"];
    const { route } = dynamicFluidRoute({ transcript: () => classicTranscript({ action: "delete_view", outs }) });
    const { conn } = await connected(route);

    const { transcript } = await deleteClassicViewViaBridge(conn, gate(), {
      viewName: "ZTM_V1",
      packageName: localServerPackage(),
    });

    expect(transcript.tags).toEqual(outs);
  });

  it("create_transaction returns the tags the old bridge returned", async () => {
    const outs = ["TRAN-CREATED"];
    const { route } = dynamicFluidRoute({ transcript: () => classicTranscript({ action: "create_transaction", outs }) });
    const { conn } = await connected(route);

    const { transcript } = await createTransaction(conn, gate(), {
      tcode: "ZTM_TC1",
      program: "ZTM_PROGRAM1",
      description: "Test tcode",
      packageName: "$TMP",
    });

    expect(transcript.tags).toEqual(outs);
  });

  it("delete_transaction returns the tags the old bridge returned", async () => {
    const outs = ["TRAN-DELETED", "TRAN-GONE"];
    const { route } = dynamicFluidRoute({ transcript: () => classicTranscript({ action: "delete_transaction", outs }) });
    const { conn } = await connected(route);

    const { transcript } = await deleteTransactionViaBridge(conn, gate(), {
      tcode: "ZTM_TC1",
      packageName: localServerPackage(),
    });

    expect(transcript.tags).toEqual(outs);
  });

  it("create_index returns the tags the old bridge returned", async () => {
    const outs = ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"];
    const { route } = dynamicFluidRoute({ transcript: () => classicTranscript({ action: "create_index", outs }) });
    const { conn } = await connected(route);

    const { transcript } = await createSecondaryIndex(conn, gate(), {
      indexName: "Z01",
      baseTable: "ZTM_T1",
      fields: ["MANDT", "FIELD1"],
      description: "Test index",
      packageName: localServerPackage(),
    });

    expect(transcript.tags).toEqual(outs);
  });

  it("delete_index returns the tags the old bridge returned", async () => {
    const outs = ["INDEX-DELETED", "INDEX-GONE"];
    const { route } = dynamicFluidRoute({ transcript: () => classicTranscript({ action: "delete_index", outs }) });
    const { conn } = await connected(route);

    const { transcript } = await deleteSecondaryIndexViaBridge(conn, gate(), {
      indexName: "Z01",
      baseTable: "ZTM_T1",
      packageName: localServerPackage(),
    });

    expect(transcript.tags).toEqual(outs);
  });

  it("create_package returns the tags the old bridge returned", async () => {
    const outs = ["PKG-CREATED", "PKG-CONFIRMED"];
    const { route } = dynamicFluidRoute({ transcript: () => classicTranscript({ action: "create_package", outs }) });
    const { conn } = await connected(route);

    const { transcript } = await createPackageViaBridge(conn, gate(), {
      packageName: "ZTM_NEWPKG",
      description: "Test pkg",
      softwareComponent: "HOME",
      corrNr: "A4HK900123",
    });

    expect(transcript.tags).toEqual(outs);
  });

  it("delete_package returns the tags the old bridge returned", async () => {
    const outs = ["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"];
    const { route } = dynamicFluidRoute({ transcript: () => classicTranscript({ action: "delete_package", outs }) });
    const { conn } = await connected(route);

    const { transcript } = await deletePackageViaBridge(conn, gate(), {
      packageName: "ZTM_OLDPKG",
      corrNr: "",
    });

    expect(transcript.tags).toEqual(outs);
  });

  it("remove_transport_entry returns the tags the old bridge returned", async () => {
    const outs = ["TREN-REMOVED", "TREN-GONE"];
    const { route } = dynamicFluidRoute({
      transcript: () => classicTranscript({ action: "remove_transport_entry", outs }),
    });
    const { conn } = await connected(route);
    const proof = authorizeCeiling(gate(), "transport");

    const { transcript } = await removeTransportEntryViaBridge(
      conn,
      gate(),
      { trkorr: "A4HK900001", objectName: "ZTM_OBJ" },
      proof,
    );

    expect(transcript.tags).toEqual(outs);
  });

  it("exists returns the tags the old bridge returned", async () => {
    const outs = ["EXISTS"];
    const { route } = dynamicFluidRoute({ transcript: () => classicTranscript({ action: "exists", outs }) });
    const { conn } = await connected(route);

    const result = await dispatch(
      { conn, cfg: conn.cfg, gate: gate(), tools: new Map([[CLASSIC_TOOL_ID, classicTool]]) },
      { tool: CLASSIC_TOOL_ID, action: "exists", args: { kind: "view", name: "ZTM_V1" } },
    );

    expect(result.result).toEqual(outs);
  });
});

describe("classic tool — mutate hands resolved targets to the gate before any ABAP source is generated", () => {
  it("gates the view before dispatching, with zero HTTP calls made by the time the gate is first asked", async () => {
    const outs = ["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"];
    const { route } = dynamicFluidRoute({ transcript: () => classicTranscript({ action: "create_view", outs }) });
    const { conn, adt } = await connected(route);
    const g = gate();
    const original = g.assert.bind(g);
    const httpCountsAtAssert: number[] = [];
    vi.spyOn(g, "assert").mockImplementation((...args: Parameters<SafetyGate["assert"]>) => {
      httpCountsAtAssert.push(adt.calls.length);
      return original(...args);
    });

    const { transcript } = await createClassicView(conn, g, {
      viewName: "ZTM_V1",
      baseTable: "ZTM_T1",
      fields: ["MANDT", "FIELD1"],
      description: "Test view",
      packageName: "$TMP",
    });

    expect(transcript.tags).toEqual(outs);
    expect(httpCountsAtAssert.length).toBeGreaterThan(0);
    expect(httpCountsAtAssert[0]).toBe(0);
  });
});

describe("classic tool — delete_package from outside the package", () => {
  it("succeeds when invoked from a gate not scoped to the package being deleted", async () => {
    const outs = ["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"];
    const { route } = dynamicFluidRoute({ transcript: () => classicTranscript({ action: "delete_package", outs }) });
    const { conn } = await connected(route);
    // gate() below is unscoped ("*") on purpose — nothing establishes ZTM_OLDPKG as a "current" package first.
    const { transcript } = await deletePackageViaBridge(conn, gate(), { packageName: "ZTM_OLDPKG", corrNr: "" });

    expect(transcript.tags).toEqual(outs);
  });
});

describe("classic tool — domain gates refuse before the fluid gate is ever reached", () => {
  it("assertBridgeMutation refuses a name outside allowNamePrefixes, zero HTTP calls", async () => {
    const { route } = dynamicFluidRoute({
      transcript: () => classicTranscript({ action: "create_view", outs: ["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"] }),
    });
    const { conn, adt } = await connected(route);
    const narrowGate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["ZZZ_ONLY"] });

    const err = await catchErr(
      createClassicView(conn, narrowGate, {
        viewName: "ZTM_V1",
        baseTable: "ZTM_T1",
        fields: ["MANDT", "FIELD1"],
        description: "Test view",
        packageName: "$TMP",
      }),
    );

    expect(err.code).toBe("SAFETY_DENIED");
    expect(adt.calls).toEqual([]);
  });

  it("assertServerPackage refuses an unbranded packageName, zero HTTP calls", async () => {
    const { route } = dynamicFluidRoute({
      transcript: () => classicTranscript({ action: "delete_view", outs: ["VIEW-DELETED", "VIEW-GONE"] }),
    });
    const { conn, adt } = await connected(route);
    const forged = { name: "$TMP" } as unknown as ServerPackage;

    const err = await catchErr(deleteClassicViewViaBridge(conn, gate(), { viewName: "ZTM_V1", packageName: forged }));

    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details["reason"]).toBe("PACKAGE_UNKNOWN");
    expect(adt.calls).toEqual([]);
  });

  it("the transport allowlist refuses a corr_nr it does not carry, zero HTTP calls", async () => {
    const { route } = dynamicFluidRoute({
      transcript: () => classicTranscript({ action: "create_transaction", outs: ["TRAN-CREATED"] }),
    });
    const { conn, adt } = await connected(route);
    const pinnedGate = new SafetyGate({
      readOnly: false,
      allowPackages: ["*"],
      allowNamePrefixes: ["*"],
      allowTransports: ["A4HK900099"],
    });

    const err = await catchErr(
      createTransaction(conn, pinnedGate, {
        tcode: "ZTM_TC1",
        program: "ZTM_PROGRAM1",
        description: "Test tcode",
        packageName: "ZTM_PKG01",
        corrNr: "A4HK900001",
      }),
    );

    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toContain("ABAP_ALLOW_TRANSPORTS");
    expect(adt.calls).toEqual([]);
  });
});

describe("classic tool — ddic-bridge exports S4 depends on", () => {
  it("ddicBridgeSource is still an exported function", () => {
    expect(typeof ddicBridgeSource).toBe("function");
  });
});

describe("classic tool — REST-only DDIC pin", () => {
  // SHLP/DH joined the bridge-creatable set alongside VIEW/DV and TRAN/T
  // when it dropped its `unsupported` registry entry for `bridgeCreate`
  // (RS_CORR_INSERT -> DDIF_SHLP_PUT -> DDIF_SHLP_ACTIVATE), so it now
  // belongs in BRIDGE_CREATABLE_TYPES with the other three. The pin's point
  // is unchanged: the six REST-writable DDIC types below (TABL/DT, TABL/DS,
  // DTEL/DE, DOMA/DD, TTYP/DA, DDLS/DF) must never silently move to the
  // bridge — they still create/write over ordinary ADT REST, so a caller
  // that gained the SHLP/DH bridge route must not gain one for any of these.
  it("TABL/DT, TABL/DS, DTEL/DE, DOMA/DD, TTYP/DA and DDLS/DF are never bridge-creatable", () => {
    const restOnly = ["TABL/DT", "TABL/DS", "DTEL/DE", "DOMA/DD", "TTYP/DA", "DDLS/DF"];
    for (const type of restOnly) {
      expect(isBridgeCreatableType(type)).toBe(false);
      expect(isBridgeOnlyCreateType(type)).toBe(false);
    }
    expect(new Set(BRIDGE_CREATABLE_TYPES)).toEqual(
      new Set(["SHLP/DH", "VIEW/DV", "TRAN/T", "TABL/DI", "DEVC/K"]),
    );
  });

  // dispatch's only route to the server is the classrun endpoint / the
  // generated ZCL_ZMCP_* proxies / $ABAPSMITH_FLUID_API — none touched here
  // means dispatch was never reached.
  const isBridgeUrl = (url: string): boolean =>
    url.includes(CLASSRUN_BASE) ||
    /ZCL_ZMCP_(FLUID|I|DDIC)_/i.test(url) ||
    url.toLowerCase().includes("abapsmith_fluid_api");

  const ddicObjectXml = (name: string, type: string): string =>
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:name="${name}" adtcore:type="${type}"><adtcore:packageRef adtcore:name="$TMP"/></adtcore:objectMetadata>`;

  const restOnlyPropsXml = (root: string, ns: string, name: string, type: string, marker: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<${root} xmlns:x="${ns}" xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:name="${name}" adtcore:type="${type}" adtcore:description="${marker}">` +
    `<adtcore:packageRef adtcore:name="$TMP"/></${root}>`;

  // DTEL/DE alone is checked by assertDdicDescriptorShape (src/adt/ddic-payload.ts):
  // root <blue:wbobj>, inner <dtel:dataElement> on its own distinct namespace.
  const dtelXml = (name: string, marker: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<blue:wbobj xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel" xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:name="${name}" adtcore:type="DTEL/DE" adtcore:description="${marker}">` +
    `<adtcore:packageRef adtcore:name="$TMP"/>` +
    `<dtel:dataElement xmlns:dtel="http://www.sap.com/adt/dictionary/dataelements"/>` +
    `</blue:wbobj>`;

  interface RestOnlyCase {
    type: string;
    name: string;
    uri: string;
    shape: "source" | "properties";
    before: string;
    after: string;
  }

  const cases: RestOnlyCase[] = [
    {
      type: "TABL/DT",
      name: "ZTM_PIN_TAB",
      uri: "/sap/bc/adt/ddic/tables/ztm_pin_tab",
      shape: "source",
      before: "@EndUserText.label : 'pin before'\ndefine table ztm_pin_tab {\n  key client : mandt not null;\n}\n",
      after: "@EndUserText.label : 'pin after'\ndefine table ztm_pin_tab {\n  key client : mandt not null;\n}\n",
    },
    {
      type: "TABL/DS",
      name: "ZTM_PIN_STR",
      uri: "/sap/bc/adt/ddic/structures/ztm_pin_str",
      shape: "source",
      before: "@EndUserText.label : 'pin before'\ndefine structure ztm_pin_str {\n  field1 : char10;\n}\n",
      after: "@EndUserText.label : 'pin after'\ndefine structure ztm_pin_str {\n  field1 : char10;\n}\n",
    },
    {
      type: "DDLS/DF",
      name: "ZTM_PIN_DDL",
      uri: "/sap/bc/adt/ddic/ddl/sources/ztm_pin_ddl",
      shape: "source",
      before:
        "@AccessControl.authorizationCheck: #NOT_REQUIRED\ndefine view ZTM_PIN_DDL as select from sflight { key carrid }\n",
      after:
        "@AccessControl.authorizationCheck: #NOT_REQUIRED\ndefine view ZTM_PIN_DDL as select from sflight { key carrid, key connid }\n",
    },
    {
      type: "DTEL/DE",
      name: "ZTM_PIN_DTEL",
      uri: "/sap/bc/adt/ddic/dataelements/ztm_pin_dtel",
      shape: "properties",
      before: dtelXml("ZTM_PIN_DTEL", "pin before"),
      after: dtelXml("ZTM_PIN_DTEL", "pin after"),
    },
    {
      type: "DOMA/DD",
      name: "ZTM_PIN_DOMA",
      uri: "/sap/bc/adt/ddic/domains/ztm_pin_doma",
      shape: "properties",
      before: restOnlyPropsXml(
        "doma:domain",
        "http://www.sap.com/dictionary/domain",
        "ZTM_PIN_DOMA",
        "DOMA/DD",
        "pin before",
      ),
      after: restOnlyPropsXml(
        "doma:domain",
        "http://www.sap.com/dictionary/domain",
        "ZTM_PIN_DOMA",
        "DOMA/DD",
        "pin after",
      ),
    },
    {
      type: "TTYP/DA",
      name: "ZTM_PIN_TTYP",
      uri: "/sap/bc/adt/ddic/tabletypes/ztm_pin_ttyp",
      shape: "properties",
      before: restOnlyPropsXml(
        "ttyp:tableType",
        "http://www.sap.com/dictionary/tabletype",
        "ZTM_PIN_TTYP",
        "TTYP/DA",
        "pin before",
      ),
      after: restOnlyPropsXml(
        "ttyp:tableType",
        "http://www.sap.com/dictionary/tabletype",
        "ZTM_PIN_TTYP",
        "TTYP/DA",
        "pin after",
      ),
    },
  ];

  function restOnlyRoute(c: RestOnlyCase): Route {
    if (c.shape === "source") {
      const srcUri = `${c.uri}/source/main`;
      let current = c.before;
      return (r) => {
        if (r.url === c.uri && r.method === "GET") return resp(200, ddicObjectXml(c.name, c.type), OK_XML);
        if (r.url === srcUri && r.method === "GET") return resp(200, current, OK_TEXT);
        if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
        if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
        if (r.url === srcUri && r.method === "PUT") {
          current = r.body ?? "";
          return resp(200, "", OK_TEXT);
        }
        if (r.url.includes("/checkruns")) return resp(200, CHECKRUN_CLEAN, OK_XML);
        return undefined;
      };
    }
    let current = c.before;
    return (r) => {
      if (r.url === c.uri && r.method === "GET") return resp(200, current, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === c.uri && r.method === "PUT") {
        current = r.body ?? current;
        return resp(200, current, OK_XML);
      }
      return undefined;
    };
  }

  it.each(cases)(
    "$type actually reaches PUT over plain ADT REST, and never touches a bridge URL or the classrun endpoint",
    async (c) => {
      const { conn, adt } = await connected(restOnlyRoute(c));
      // activate: false skips the /activation fake — isBridgeOnlyCreateType
      // is decided long before that, so this doesn't weaken what's pinned.
      const result = await abapWrite(
        conn,
        { object: c.name, type: c.type, package: "$TMP", source: c.after, activate: false },
        20_000,
        gate(),
      );
      expect(result.text).toMatch(/changed:\s*true/);

      const put = adt.calls.find((call) => call.method === "PUT");
      expect(put).toBeDefined();
      const expectedPutUri = c.shape === "source" ? `${c.uri}/source/main` : c.uri;
      expect(put!.url).toBe(expectedPutUri);

      for (const call of adt.calls) expect(isBridgeUrl(call.url)).toBe(false);
    },
  );
});

describe("classic tool — targets.corr: local", () => {
  it("is honoured for a builtin tool and ignored (falls back to the transport allowlist) for a plugin tool", async () => {
    const action: FluidActionSpec = {
      name: "commit",
      category: "mutate",
      description: "mutate honoring corr: local for a builtin action only",
      input: {
        type: "object",
        properties: { obj: { type: "string" }, pkg: { type: "string" } },
        required: ["obj", "pkg"],
      },
      output: { type: "object" },
      targets: { object: "/obj", package: "/pkg", corr: "local" },
    };
    const args = { obj: "ZFOO", pkg: "ZTM_PKG01" };
    const pinnedGate = new SafetyGate({
      readOnly: false,
      allowPackages: ["*"],
      allowNamePrefixes: ["*"],
      allowTransports: ["A4HK900001"],
    });

    const builtinTool = makeManifestTool({ id: "corrlocalb", className: "ZCL_CORRLOCALB", actions: [action] });
    const { route: builtinRoute } = dynamicFluidRoute({
      transcript: () => buildTranscript({ id: builtinTool.manifest.id, ver: builtinTool.version, action: "commit", outs: [{}] }),
    });
    const { conn: builtinConn } = await connected(builtinRoute);

    const builtinResult = await dispatch(
      { conn: builtinConn, cfg: builtinConn.cfg, gate: pinnedGate, tools: new Map([[builtinTool.manifest.id, builtinTool]]) },
      { tool: builtinTool.manifest.id, action: "commit", args, confirm: `${builtinTool.manifest.id}.commit` },
    );
    expect(builtinResult.result).toEqual({});

    const pluginTool = makeManifestTool({
      id: "corrlocalp",
      className: "ZCL_CORRLOCALP",
      actions: [action],
      origin: "plugin",
    });
    const { route: pluginRoute } = dynamicFluidRoute({
      transcript: () => buildTranscript({ id: pluginTool.manifest.id, ver: pluginTool.version, action: "commit", outs: [{}] }),
    });
    const { conn: pluginConn } = await connected(pluginRoute);
    const pluginCfg = cfg({ allowFluidPlugins: true, allowFluidPluginMutate: true });

    const err = await catchErr(
      dispatch(
        { conn: pluginConn, cfg: pluginCfg, gate: pinnedGate, tools: new Map([[pluginTool.manifest.id, pluginTool]]) },
        { tool: pluginTool.manifest.id, action: "commit", args, confirm: `${pluginTool.manifest.id}.commit` },
      ),
    );

    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toContain("ABAP_ALLOW_TRANSPORTS");
  });
});

describe("classic manifest — offline validation", () => {
  it("parses under FluidManifestSchema", () => {
    const parsed = FluidManifestSchema.safeParse(classicManifest);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2)).toBe(true);
  });

  // SAP rejects a longer CLAS description: "Description of ZCL_ZMCP_FLUID_CLASSIC
  // longer than 60 characters." — this is a live server limit, not a style rule.
  it("keeps every object description within SAP's 60-character CLAS limit", () => {
    for (const obj of classicManifest.objects) {
      expect(obj.description.length, `${obj.name}: "${obj.description}" (${obj.description.length} chars)`).toBeLessThanOrEqual(60);
    }
  });
});

// ---------------------------------------------------------------------------
// delete_package — structural pins for the DELFLAG=X open-request lookup
// (issue #185): the E071/E070 SELECT that finds the request/task still
// holding a deleted-but-not-yet-released object, and the OBJECT content
// line's added DELFLAG/TRKORR/TASK fields.
// ---------------------------------------------------------------------------

describe("delete_package ABAP source — DELFLAG=X open-request lookup (#185)", () => {
  const DELETE_METHOD = packagePart.source.slice(
    packagePart.source.indexOf("METHOD delete_package."),
    packagePart.source.indexOf("\n  ENDMETHOD.", packagePart.source.indexOf("METHOD delete_package.")),
  );

  const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

  it("joins e071 and e070, restricted to open/limited-release statuses, ordered by trkorr descending, exits after the first row", () => {
    expect(norm(DELETE_METHOD)).toContain(
      norm(`
        SELECT e071~trkorr, e070~strkorr
          FROM e071
          INNER JOIN e070 ON e070~trkorr = e071~trkorr
          WHERE e071~pgmid = @ls_tadir-pgmid
            AND e071~object = @ls_tadir-object
            AND e071~obj_name = @ls_tadir-obj_name
            AND e070~trstatus IN ( 'D', 'L' )
          ORDER BY e071~trkorr DESCENDING
          INTO ( @lv_holder, @lv_strkorr ).
          EXIT.
        ENDSELECT.
      `),
    );
  });

  it("the OBJECT content line carries DELFLAG, TRKORR and TASK", () => {
    expect(DELETE_METHOD).toContain(
      "line( |ZMCP-PKG-CONTENT> KIND=OBJECT PGMID={ ls_tadir-pgmid } OBJECT={ ls_tadir-object } " +
        "NAME={ ls_tadir-obj_name } DELFLAG={ ls_tadir-delflag } TRKORR={ lv_request } TASK={ lv_task }| ).",
    );
  });

  it("the lookup only runs when TADIR-DELFLAG is X, guarded before the SELECT", () => {
    const guardIdx = DELETE_METHOD.indexOf("IF ls_tadir-delflag = 'X'.");
    const selectIdx = DELETE_METHOD.indexOf("SELECT e071~trkorr, e070~strkorr");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(selectIdx).toBeGreaterThan(guardIdx);
  });
});
