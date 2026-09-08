/**
 * `probeRetiredBridges` / `reapRetiredBridges` (`../src/adt/fluid/retired.js`)
 * offline against a hand-rolled recording `HttpClient` — same idiom as
 * `test/fluid-ensure.test.ts` (`FakeAdt` + a per-file `Route` function), which
 * is the fake-connection pattern the existing fluid suites use for this exact
 * class-resolve/lock/delete shape. `FakeAdtServer` (test/helpers/fake-adt.ts)
 * is not used: it has no builtin route for a class `DELETE`, and
 * `fluid-classic-fake.ts` / `fluid-img-fake.ts` are bound to their own tools'
 * classrun-transcript protocol, not the plain resolve+delete flow retired.ts
 * needs.
 */
import { describe, expect, it, vi } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { LEGACY_FLUID_PACKAGES } from "../src/adt/fluid/package.js";
import {
  RETIRED_BRIDGE_CLASSES,
  probeRetiredBridges,
  reapRetiredBridges,
  type FluidLease,
  type RetiredBridgeProbe,
} from "../src/adt/fluid/retired.js";

// --- fake HttpClient plumbing (mirrors test/fluid-ensure.test.ts) ----------

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

/** Handles `AbapConnection.connect()`'s own housekeeping requests, on every call — including a mid-test revive. */
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
  adt.calls.length = 0; // only requests issued by the code under test are asserted on below
  return { conn, adt };
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
    ...overrides,
  });
}

/** Permissive: the spec's assertions are about probe/reap behaviour, not gate package/prefix policy. */
const gate = (): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"] });

/**
 * Fakes the pool's `withWrite`-shaped lease `reapRetiredBridges` now takes:
 * every call mints a *fresh* `AbapConnection` (own `FakeAdt`, own logon
 * counter) against the same `route`/backing store, exactly what
 * `AdtSessionPool` gives each lease in production. `calls` accumulates every
 * request issued across every minted connection, in order, for assertions
 * that look at the whole run; `connectCallCounts` records, per lease call,
 * how many times application code (as opposed to `connected()`'s own initial
 * login) called `conn.connect()` on that lease's connection — the reap
 * itself must never do this any more, since reviving a spent connection is
 * exactly the bug this design removes.
 */
function makeLease(route: Route): {
  lease: FluidLease;
  calls: Recorded[];
  connectCallCounts: number[];
  /** One entry per lease call, in order — how many DELETEs that lease's own connection issued. */
  deletesPerLeaseCall: number[];
} {
  const calls: Recorded[] = [];
  const connectCallCounts: number[] = [];
  const deletesPerLeaseCall: number[] = [];
  const lease: FluidLease = async (_op, fn) => {
    const { conn, adt } = await connected(route);
    const connectSpy = vi.spyOn(conn, "connect");
    try {
      return await fn(conn);
    } finally {
      calls.push(...adt.calls);
      connectCallCounts.push(connectSpy.mock.calls.length);
      deletesPerLeaseCall.push(adt.calls.filter((c) => c.method === "DELETE").length);
    }
  };
  return { lease, calls, connectCallCounts, deletesPerLeaseCall };
}

// --- ABAP-side fixtures ------------------------------------------------------

const classUri = (name: string): string => `/sap/bc/adt/oo/classes/${name.toLowerCase()}`;
const classSrc = (name: string): string => `${classUri(name)}/source/main`;

const notFoundXml = (name: string): string =>
  `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
  `<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>` +
  `<message lang="EN">${name} does not exist</message><properties/></exc:exception>`;

function classDocXml(className: string, packageName: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<class:abapClass adtcore:name="${className}" adtcore:type="CLAS/OC" adtcore:version="active" ` +
    `xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core">` +
    `<adtcore:packageRef adtcore:name="${packageName}"/>` +
    `</class:abapClass>`
  );
}

const SOURCE_TEXT = (name: string): string =>
  `CLASS ${name.toLowerCase()} DEFINITION PUBLIC.\nENDCLASS.\nCLASS ${name.toLowerCase()} IMPLEMENTATION.\nENDCLASS.`;

interface ObjState {
  exists: boolean;
  packageName: string;
  source?: string;
}

const ALL_RETIRED_NAMES: readonly string[] = RETIRED_BRIDGE_CLASSES.map((c) => c.name);

/** Every one of the ten fixed names gets an entry (defaulting to absent) — `probeRetiredBridges` always GETs all ten, so an unrouted name would break every scenario. */
function defaultStore(overrides: Record<string, Partial<ObjState>> = {}): Record<string, ObjState> {
  const store: Record<string, ObjState> = {};
  for (const name of ALL_RETIRED_NAMES) {
    store[name] = { exists: false, packageName: "$TMP", ...overrides[name] };
  }
  return store;
}

interface RouteOpts {
  /** Names whose existence-check GET (class URI, no `_action`) answers a bare 500 instead of consulting the store — models an unrelated server failure, not "not found" and not session-death. */
  brokenNames?: readonly string[];
}

function retiredRoute(store: Record<string, ObjState>, opts: RouteOpts = {}): Route {
  const broken = new Set((opts.brokenNames ?? []).map((n) => n.toUpperCase()));
  return (r) => {
    for (const [name, st] of Object.entries(store)) {
      const uri = classUri(name);
      const src = classSrc(name);
      if (r.url === uri && r.method === "GET" && !r.qs._action) {
        if (broken.has(name)) return resp(500, "<unexpected/>", OK_XML);
        if (!st.exists) return resp(404, notFoundXml(name), OK_XML);
        return resp(200, classDocXml(name, st.packageName), OK_XML);
      }
      if (r.url === src && r.method === "GET") {
        if (!st.exists || st.source === undefined) return resp(404, notFoundXml(name), OK_XML);
        return resp(200, st.source, OK_TEXT);
      }
      if (r.url === uri && r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.url === uri && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === uri && r.method === "DELETE") {
        st.exists = false;
        st.source = undefined;
        return resp(200, "", OK_TEXT);
      }
    }
    return undefined;
  };
}

/** Requests that mutate server state — "the fake saw zero mutations" idiom from `test/run.test.ts` (~640-700) / `test/fluid-ensure.test.ts`. */
function mutations(calls: readonly Recorded[]): Recorded[] {
  return calls.filter((c) => c.method === "PUT" || c.method === "POST" || c.method === "DELETE" || c.qs._action === "LOCK");
}

// --- P2-style session-death fixtures (mirrors test/fluid-ensure.test.ts) ---

/** Live capture shape: a 400 whose body fails to parse as ADT XML — the one shape the connection's dead-session detector recognises. */
const ICMENOSESSION_RESPONSE = (): HttpClientResponse =>
  resp(400, "Session Timed Out — ICM: no session (not XML)", {
    "content-type": "text/html",
    "x-sap-icm-err-id": "ICMENOSESSION",
    "sap-err-id": "ICMENOSESSION",
  });

const LOGIN_URL = "compatibility/graph";

/**
 * `retiredRoute`, but for each name in `failAfter`, that name's class-URI
 * existence-check GET answers normally the first `failAfter[name]` times and
 * the session-dead shape every time after. With `reapRetiredBridges` probing
 * once (one successful read of every name) before ever deleting anything,
 * `failAfter[name]: 1` means: the probe's own read succeeds (so the class is
 * classified `"present"`), but that name's *delete*-lease — a brand-new
 * connection, taking its own independent resolve read as the first step of
 * `authorizeMutation` — hits a session already dead. Models a delete whose
 * own lease connection is bad, independent of any other object's delete:
 * exactly the failure mode left for the reaper to handle honestly now that
 * it never revives a connection itself.
 */
function retiredRouteFailsResolveAfter(store: Record<string, ObjState>, failAfter: Record<string, number>): Route {
  const inner = retiredRoute(store);
  const counts = new Map<string, number>();
  return (r) => {
    if (r.method === "GET" && !r.qs._action) {
      for (const [name, okCalls] of Object.entries(failAfter)) {
        if (r.url !== classUri(name)) continue;
        const n = (counts.get(name) ?? 0) + 1;
        counts.set(name, n);
        if (n > okCalls) return ICMENOSESSION_RESPONSE();
      }
    }
    return inner(r);
  };
}

// -----------------------------------------------------------------------------

describe("RETIRED_BRIDGE_CLASSES — the static list", () => {
  const EXPECTED_NAMES = [
    "ZCL_ZMCP_DDIC_CVIEW",
    "ZCL_ZMCP_DDIC_DVIEW",
    "ZCL_ZMCP_DDIC_CTRAN",
    "ZCL_ZMCP_DDIC_DTRAN",
    "ZCL_ZMCP_DDIC_CINDX",
    "ZCL_ZMCP_DDIC_DINDX",
    "ZCL_ZMCP_DDIC_CPKG",
    "ZCL_ZMCP_DDIC_DPKG",
    "ZCL_ZMCP_DDIC_TREN",
    "ZCL_ZMCP_IMG_WPROBE",
  ];

  it("has exactly ten entries, named exactly the nine DDIC bridges plus IMG_WPROBE", () => {
    expect(RETIRED_BRIDGE_CLASSES.length).toBe(10);
    const names = RETIRED_BRIDGE_CLASSES.map((c) => c.name).slice().sort();
    expect(names).toEqual(EXPECTED_NAMES.slice().sort());
  });

  it("every entry has no duplicate name", () => {
    const names = RETIRED_BRIDGE_CLASSES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every entry's type is CLAS/OC", () => {
    for (const entry of RETIRED_BRIDGE_CLASSES) {
      expect(entry.type).toBe("CLAS/OC");
    }
  });

  it("every entry's packageName is one of LEGACY_FLUID_PACKAGES", () => {
    for (const entry of RETIRED_BRIDGE_CLASSES) {
      expect(LEGACY_FLUID_PACKAGES).toContain(entry.packageName);
    }
  });
});

describe("probeRetiredBridges", () => {
  it("classifies every entry absent on a system with none of them, and issues zero mutations", async () => {
    const store = defaultStore();
    const { conn, adt } = await connected(retiredRoute(store));

    const probes = await probeRetiredBridges(conn);

    expect(probes).toHaveLength(10);
    for (const p of probes) {
      expect(p.state).toBe("absent");
    }
    expect(mutations(adt.calls)).toEqual([]);
  });

  it("classifies a class present in $TMP as present, and leaves the rest absent", async () => {
    const NAME = "ZCL_ZMCP_DDIC_CVIEW";
    const store = defaultStore({
      [NAME]: { exists: true, packageName: "$TMP", source: SOURCE_TEXT(NAME) },
    });
    const { conn } = await connected(retiredRoute(store));

    const probes = await probeRetiredBridges(conn);

    const byName = new Map(probes.map((p) => [p.name, p]));
    expect(byName.get(NAME)?.state).toBe("present");
    expect(byName.get(NAME)?.foundIn).toBe("$TMP");
    for (const p of probes) {
      if (p.name !== NAME) expect(p.state).toBe("absent");
    }
  });

  it("classifies a class relocated into a foreign package as moved, and reapRetiredBridges leaves it alone", async () => {
    const NAME = "ZCL_ZMCP_DDIC_DVIEW";
    const store = defaultStore({
      [NAME]: { exists: true, packageName: "ZFOO", source: SOURCE_TEXT(NAME) },
    });
    const { conn: probeConn } = await connected(retiredRoute(store));
    const probes = await probeRetiredBridges(probeConn);
    const byName = new Map(probes.map((p) => [p.name, p]));
    expect(byName.get(NAME)?.state).toBe("moved");
    expect(byName.get(NAME)?.foundIn).toBe("ZFOO");

    // Fresh store for the reap half: same fixture, but now driving the
    // mutating call and asserting the DELETE never happens for it.
    const store2 = defaultStore({
      [NAME]: { exists: true, packageName: "ZFOO", source: SOURCE_TEXT(NAME) },
    });
    const { lease, calls } = makeLease(retiredRoute(store2));
    const results = await reapRetiredBridges(gate(), lease);
    const outcome = results.find((r) => r.name === NAME);
    expect(outcome?.outcome).toBe("left-alone");
    expect(outcome?.foundIn).toBe("ZFOO");
    expect(calls.some((c) => c.method === "DELETE" && c.url === classUri(NAME))).toBe(false);
  });

  it("classifies a class whose probe throws as unknown, and never rejects itself", async () => {
    const NAME = "ZCL_ZMCP_DDIC_CTRAN";
    const store = defaultStore();
    const { conn } = await connected(retiredRoute(store, { brokenNames: [NAME] }));

    let threw = false;
    let probes: readonly RetiredBridgeProbe[] = [];
    try {
      probes = await probeRetiredBridges(conn);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    const byName = new Map(probes.map((p) => [p.name, p]));
    expect(byName.get(NAME)?.state).toBe("unknown");
    expect(byName.get(NAME)?.error).toBeDefined();
    for (const p of probes) {
      if (p.name !== NAME) expect(p.state).toBe("absent");
    }
  });
});

describe("reapRetiredBridges", () => {
  it("deletes exactly the present entries, via the authorized delete path, and reports both", async () => {
    const A = "ZCL_ZMCP_DDIC_CVIEW";
    const B = "ZCL_ZMCP_DDIC_DVIEW";
    const store = defaultStore({
      [A]: { exists: true, packageName: "$TMP", source: SOURCE_TEXT(A) },
      [B]: { exists: true, packageName: "$TMP", source: SOURCE_TEXT(B) },
    });
    const { lease, calls } = makeLease(retiredRoute(store));
    const g = gate();
    const authorizeSpy = vi.spyOn(g, "authorize");

    const results = await reapRetiredBridges(g, lease);

    const byName = new Map(results.map((r) => [r.name, r]));
    expect(byName.get(A)?.outcome).toBe("deleted");
    expect(byName.get(B)?.outcome).toBe("deleted");
    for (const r of results) {
      if (r.name !== A && r.name !== B) expect(r.outcome).toBe("already-absent");
    }

    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes.map((c) => c.url).sort()).toEqual([classUri(A), classUri(B)].sort());

    // "via the authorized delete path": the real SafetyGate.authorize was
    // actually invoked (and permitted) for both deletes, not bypassed.
    const deleteAuthCalls = authorizeSpy.mock.calls.filter((c) => c[0] === "delete");
    expect(deleteAuthCalls.map((c) => (c[1] as { name: string }).name).sort()).toEqual([A, B].sort());
  });

  it("a delete whose own lease connection dies does not stop the reap: later deletes still run, on a fresh connection each — and the reaper itself never calls connect()", async () => {
    const A = "ZCL_ZMCP_DDIC_CVIEW";
    const B = "ZCL_ZMCP_DDIC_DVIEW";
    const store = defaultStore({
      [A]: { exists: true, packageName: "$TMP", source: SOURCE_TEXT(A) },
      [B]: { exists: true, packageName: "$TMP", source: SOURCE_TEXT(B) },
    });
    // A's own delete-lease resolve dies (its connection's session is already
    // dead); B is untouched, so B's own fresh lease connection is healthy.
    const { lease, calls, connectCallCounts } = makeLease(retiredRouteFailsResolveAfter(store, { [A]: 1 }));

    const results = await reapRetiredBridges(gate(), lease);

    const byName = new Map(results.map((r) => [r.name, r]));
    expect(byName.get(A)?.outcome).toBe("failed");
    expect(byName.get(A)?.error).toBeTruthy();
    // The reap made progress past A's failure: B still got deleted, on its
    // own (later, fresh) lease connection.
    expect(byName.get(B)?.outcome).toBe("deleted");
    expect(calls.some((c) => c.method === "DELETE" && c.url === classUri(B))).toBe(true);

    // No revive: reviveOnDeadSession is gone, so `reapRetiredBridges` never
    // calls `conn.connect()` on any of the connections its leases hand it —
    // that job now belongs entirely to the pool.
    expect(connectCallCounts.every((n) => n === 0)).toBe(true);
    // Confirmed independently: no extra logon requests appear at all beyond
    // each lease's own initial connect (which `connected()` strips from
    // `calls` before returning).
    expect(calls.filter((c) => c.url.includes(LOGIN_URL))).toEqual([]);
  });

  it("a failed delete is recorded failed with a non-empty error, and the loop continues to the remaining objects rather than cascading", async () => {
    const A = "ZCL_ZMCP_DDIC_CVIEW";
    const B = "ZCL_ZMCP_DDIC_DVIEW";
    const C = "ZCL_ZMCP_DDIC_CTRAN";
    const store = defaultStore({
      [A]: { exists: true, packageName: "$TMP", source: SOURCE_TEXT(A) },
      [B]: { exists: true, packageName: "$TMP", source: SOURCE_TEXT(B) },
      [C]: { exists: true, packageName: "$TMP", source: SOURCE_TEXT(C) },
    });
    // Only B's delete-lease connection is bad; A and C are unaffected.
    const { lease, calls } = makeLease(retiredRouteFailsResolveAfter(store, { [B]: 1 }));

    const results = await reapRetiredBridges(gate(), lease);

    const byName = new Map(results.map((r) => [r.name, r]));
    expect(byName.get(A)?.outcome).toBe("deleted");
    expect(byName.get(B)?.outcome).toBe("failed");
    expect(byName.get(B)?.error).toBeTruthy();
    // B's failure did not cascade: C, declared after it, still got deleted —
    // no loop, no abort, just an honestly recorded failure on B alone.
    expect(byName.get(C)?.outcome).toBe("deleted");

    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes.map((c) => c.url).sort()).toEqual([classUri(A), classUri(C)].sort());
  });

  it("performs zero deletes on an all-absent system", async () => {
    const store = defaultStore();
    const { lease, calls } = makeLease(retiredRoute(store));

    const results = await reapRetiredBridges(gate(), lease);

    expect(results).toHaveLength(10);
    for (const r of results) {
      expect(r.outcome).toBe("already-absent");
    }
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("regression: with more than five retired classes present, every one is deleted, and no single connection is ever asked to do more than one delete", async () => {
    // All ten. `AbapConnection.LOGON_ENDPOINT_LIFETIME_CEILING` is 5 — this
    // is exactly the shape that used to strand five classes undeleted when
    // the reap shared one connection and revived it between deletes.
    const store = defaultStore(
      Object.fromEntries(ALL_RETIRED_NAMES.map((n) => [n, { exists: true, packageName: "$TMP", source: SOURCE_TEXT(n) }])),
    );
    const { lease, calls, deletesPerLeaseCall } = makeLease(retiredRoute(store));

    const results = await reapRetiredBridges(gate(), lease);

    expect(results).toHaveLength(10);
    for (const r of results) {
      expect(r.outcome).toBe("deleted");
    }

    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes.map((c) => c.url).sort()).toEqual(ALL_RETIRED_NAMES.map((n) => classUri(n)).sort());

    // One lease call for the probe, plus exactly one per delete — never a
    // shared connection asked to carry more than one delete.
    expect(deletesPerLeaseCall).toHaveLength(11);
    expect(deletesPerLeaseCall.reduce((a, b) => a + b, 0)).toBe(10);
    expect(deletesPerLeaseCall.every((n) => n <= 1)).toBe(true);
  });
});
