/**
 * `abapWriteBatchDelete` deletes one object at a time on ONE `AbapConnection`.
 * `deleteObject`'s own `withStatefulSession` tears the ABAP session down after its
 * DELETE, so — unless something re-establishes a session in between — the next
 * entry's LOCK rides a context the server already dropped: a 400 "Session Timed
 * Out" (`x-sap-icm-err-id: ICMENOSESSION`), which `markDead()` records, after which
 * every later request on that connection is refused locally as SESSION_DEAD.
 *
 * These tests are offline, with a fake `HttpClient` injected through
 * `ConnectionOptions.httpClient` — same idiom as `test/write.test.ts`. Nothing here
 * touches a real SAP system, and nothing about `deleteObject`/`authorizeMutation`/
 * `SafetyGate` is mocked; only the fake HTTP layer models the session death.
 */
import { describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { MAX_DELETE_BATCH } from "../src/adt/write.js";
import { abapWriteBatchDelete } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

/** A permissive gate — these tests are about session renewal, not authorization policy. */
const DEFAULT_GATE = new SafetyGate({ readOnly: false, allowPackages: ["*"] });

const LOCK_XML = (handle = "H1", isLocal = "X", corrNr = "") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>${isLocal}</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">object does not exist</message><properties/></exc:exception>`;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

const OBJECT_XML = (name: string, type: string, packageName = "$TMP"): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="${name}" adtcore:type="${type}">` +
  `<adtcore:packageRef adtcore:name="${packageName}"/>` +
  `</adtcore:objectMetadata>`;

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

/** A route may decline; the composition below decides what an unrouted call means. */
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

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

/**
 * Everything `connect()` needs, including the T000 probe — same fixtures as
 * `test/write.test.ts`'s own `baseRoute`. Unlike that file's `connected()`, this one
 * is called explicitly AFTER the caller's own route has had first look at the
 * request, so a session-dying route can observe (and answer) the compatibility/graph
 * hit itself instead of it being swallowed here first.
 */
function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle"))
    return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

async function connected(
  route: Route,
  config: Config = cfg(),
): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  // `route` first, `baseRoute` second — a session-dying route needs to see (and
  // react to) a `/compatibility/graph` hit before `baseRoute` answers it, not after.
  const adt = new FakeAdt((r) => route(r) ?? baseRoute(r));
  const conn = new AbapConnection(config, {
    httpClient: adt,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

/**
 * The wire shape of a dropped ABAP session: a 400 whose body FAILS to parse as ADT
 * XML. `abap-adt-api`'s `fromResponse` drops the response object (headers included)
 * for an empty body and for a well-formed `<exc:exception>` body — only a body that
 * fails XML parsing falls through to `AdtErrorException.create(errOrResp, {})`, which
 * keeps `.response`. That's the one shape `classifySessionFailure` can see. See
 * `test/write.test.ts:3091-3112` for the full record of this finding.
 */
const ICMENOSESSION_RESPONSE = (): HttpClientResponse =>
  resp(400, "Session Timed Out — ICM: no session (not XML)", {
    "content-type": "text/html",
    "x-sap-icm-err-id": "ICMENOSESSION",
    "sap-err-id": "ICMENOSESSION",
  });

/** SYNTHETIC — invented for these tests; never captured from a live system. */
const A = { name: "ZMCP_I40_A", uri: "/sap/bc/adt/programs/programs/zmcp_i40_a", type: "PROG/P" };
/** SYNTHETIC — invented for these tests; never captured from a live system. */
const B = { name: "ZMCP_I40_B", uri: "/sap/bc/adt/programs/programs/zmcp_i40_b", type: "PROG/P" };
/** SYNTHETIC — invented for these tests; never captured from a live system. */
const C = { name: "ZMCP_I40_C", uri: "/sap/bc/adt/programs/programs/zmcp_i40_c", type: "PROG/P" };

/**
 * A fake system that models the ONE fact this whole suite is about: a DELETE tears
 * the session down, so the next stateful request on the same connection rides a
 * context the server has already dropped — UNLESS the session was re-established in
 * between (a hit on `/compatibility/graph`, which both `dropSession()` and `connect()`
 * issue). SYNTHETIC — invented for these tests, never captured from a live system.
 *
 *   - a request to "/sap/bc/adt/compatibility/graph"  => contextStale = false
 *   - qs._action === "LOCK" && contextStale           => the ICMENOSESSION 400
 *   - a successful DELETE                             => contextStale = true (after a 200)
 */
function sessionDyingRoute(
  objs: ReadonlyArray<{ name: string; uri: string; type: string }>,
  opts: { absentFor?: string | ReadonlyArray<string> } = {},
): Route {
  let contextStale = false;
  const absentSet = new Set(
    opts.absentFor === undefined ? [] : Array.isArray(opts.absentFor) ? opts.absentFor : [opts.absentFor],
  );
  const gone = new Set<string>();
  return (r) => {
    if (r.url.includes("/compatibility/graph")) {
      // Observed here, ahead of `baseRoute`, so `dropSession()`'s (or `connect()`'s)
      // own hit on this endpoint is what clears the stale flag — not `connected()`'s
      // one-time login hit, which never reaches this route (reset away below).
      contextStale = false;
      return undefined; // decline — let baseRoute answer the actual 200
    }
    for (const o of objs) {
      const src = `${o.uri}/source/main`;
      if (r.url === o.uri && r.method === "GET" && !r.qs._action) {
        if (absentSet.has(o.name)) return resp(404, NOT_FOUND_XML, OK_XML);
        return resp(200, OBJECT_XML(o.name, o.type), OK_XML);
      }
      if (r.url === src && r.method === "GET") {
        return gone.has(o.name)
          ? resp(404, NOT_FOUND_XML, OK_XML)
          : resp(200, `REPORT ${o.name.toLowerCase()}.\n`, OK_TEXT);
      }
      if (r.url === o.uri && r.qs._action === "LOCK") {
        if (contextStale) return ICMENOSESSION_RESPONSE();
        return resp(200, LOCK_XML(`H_${o.name}`), OK_XML);
      }
      if (r.url === o.uri && r.qs._action === "UNLOCK") {
        return resp(200, "", OK_TEXT);
      }
      if (r.url === o.uri && r.method === "DELETE") {
        gone.add(o.name);
        contextStale = true;
        return resp(200, "", {});
      }
    }
    return undefined;
  };
}

describe("abapWriteBatchDelete — per-entry session renewal", () => {
  it("a three-object batch survives the session the first delete tears down", async () => {
    const { conn, adt } = await connected(sessionDyingRoute([A, B, C]));
    const res = await abapWriteBatchDelete(
      conn,
      [A, B, C].map((o) => ({ object: o.name, type: "PROG/P" })),
      100_000,
      DEFAULT_GATE,
      undefined,
    );
    expect(res.text).toContain("deleted: 3");
    expect(res.text).toContain("failed: 0");
    const deleteOrder = adt.calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    expect(deleteOrder).toEqual([A.uri, B.uri, C.uri]);

    // Exactly 2 renewals — between A→B and between B→C, never before A and never
    // a third after C (nothing follows the last entry).
    const graphHits = adt.calls.filter((c) => c.url.includes("/compatibility/graph"));
    expect(graphHits).toHaveLength(2);
    const lockAt = (uri: string) => adt.calls.findIndex((c) => c.url === uri && c.qs._action === "LOCK");
    const deleteAt = (uri: string) => adt.calls.findIndex((c) => c.url === uri && c.method === "DELETE");
    const graphAt = adt.calls
      .map((c, i) => (c.url.includes("/compatibility/graph") ? i : -1))
      .filter((i) => i >= 0);
    // Each renewal lands strictly between one DELETE and the next entry's LOCK.
    expect(graphAt[0]).toBeGreaterThan(deleteAt(A.uri));
    expect(graphAt[0]).toBeLessThan(lockAt(B.uri));
    expect(graphAt[1]).toBeGreaterThan(deleteAt(B.uri));
    expect(graphAt[1]).toBeLessThan(lockAt(C.uri));
  });

  it("no renewal before the first entry — pass 1 spends zero network on session churn", async () => {
    const { conn, adt } = await connected(sessionDyingRoute([A, B, C]));
    await abapWriteBatchDelete(
      conn,
      [A, B, C].map((o) => ({ object: o.name, type: "PROG/P" })),
      100_000,
      DEFAULT_GATE,
      undefined,
    );
    expect(adt.calls[0]?.url.includes("/compatibility/graph")).toBe(false);
    expect(adt.calls[0]?.url).toBe(A.uri);
  });

  it("an already-absent entry costs nothing and does not trigger a renewal, under the same session-dying fake", async () => {
    const { conn, adt } = await connected(sessionDyingRoute([A, B, C], { absentFor: B.name }));
    const res = await abapWriteBatchDelete(
      conn,
      [A, B, C].map((o) => ({ object: o.name, type: "PROG/P" })),
      100_000,
      DEFAULT_GATE,
      undefined,
    );
    expect(res.text).toContain("deleted: 2");
    expect(res.text).toContain("absent: 1");
    expect(res.text).toContain("failed: 0");
    expect(res.text).toMatch(/ZMCP_I40_B: already absent/);
    const bCalls = adt.calls
      .filter((c) => c.url === B.uri || c.url === `${B.uri}/source/main`)
      .map((c) => (c.qs._action ? c.qs._action : c.method));
    expect(bCalls).toEqual(["GET"]);
    const deleteOrder = adt.calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    expect(deleteOrder).toEqual([A.uri, C.uri]);
    // Exactly one renewal — between A and C. The absent B neither opens a
    // session itself nor needs one renewed ahead of it.
    const graphHits = adt.calls.filter((c) => c.url.includes("/compatibility/graph"));
    expect(graphHits).toHaveLength(1);
  });

  it("a full-size batch (MAX_DELETE_BATCH objects) completes", async () => {
    const objs = Array.from({ length: MAX_DELETE_BATCH }, (_, i) => ({
      name: `ZMCP_I40_F${i}`,
      uri: `/sap/bc/adt/programs/programs/zmcp_i40_f${i}`,
      type: "PROG/P",
    }));
    const { conn, adt } = await connected(sessionDyingRoute(objs));
    const res = await abapWriteBatchDelete(
      conn,
      objs.map((o) => ({ object: o.name, type: "PROG/P" })),
      100_000,
      DEFAULT_GATE,
      undefined,
    );
    expect(res.text).toContain(`deleted: ${MAX_DELETE_BATCH}`);
    expect(res.text).toContain("failed: 0");
    const deleteOrder = adt.calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    expect(deleteOrder).toEqual(objs.map((o) => o.uri));
  });

  it("dropSession() reaches the wire but is not charged against logonEndpointRequests", async () => {
    const { conn, adt } = await connected(() => undefined);
    const before = conn.logonEndpointRequests;
    await conn.dropSession();
    expect(conn.logonEndpointRequests).toBe(before);
    const graphHits = adt.calls.filter((c) => c.url.includes("/compatibility/graph"));
    expect(graphHits).toHaveLength(1);
  });

  it("red control — a LOCK issued after a DELETE with no intervening renewal gets the ICMENOSESSION 400", () => {
    const route = sessionDyingRoute([A, B]);
    // Drive the route function directly, bypassing abapWriteBatchDelete entirely,
    // to prove the fake itself is hostile — an unfixed per-entry loop that issued
    // B's LOCK right after A's DELETE (no compatibility/graph in between) would hit
    // exactly this response.
    expect(route({ label: "", method: "GET", url: A.uri, qs: {} })?.status).toBe(200);
    expect(route({ label: "", method: "GET", url: `${A.uri}/source/main`, qs: {} })?.status).toBe(200);
    expect(route({ label: "", method: "GET", url: A.uri, qs: { _action: "LOCK" } })?.status).toBe(200);
    expect(route({ label: "", method: "GET", url: `${A.uri}/source/main`, qs: {} })?.status).toBe(200);
    expect(route({ label: "", method: "DELETE", url: A.uri, qs: {} })?.status).toBe(200);
    // No compatibility/graph hit here — straight to B's LOCK.
    const res = route({ label: "", method: "GET", url: B.uri, qs: { _action: "LOCK" } });
    expect(res?.status).toBe(400);
    expect((res?.headers as Record<string, string>)["x-sap-icm-err-id"]).toBe("ICMENOSESSION");
  });
});
