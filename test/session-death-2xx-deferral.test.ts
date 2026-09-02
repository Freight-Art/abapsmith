/**
 * A session death learned on a response that RESOLVED (a `200`
 * carrying `x-sap-icm-err-id: ICMENOSESSION`) is information about the NEXT
 * request, not a verdict on the one that just committed. `classifySessionFailure`
 * (src/adt/session.ts) is deliberately status-ungated, so `noteWireResponse`
 * can learn a death from a 2xx; before this fix it applied that death via
 * `markDead()` to the call still unwinding — `markDead()` fires `onDead`
 * synchronously and flips `connected = false`, so `assertUsable()` (re-run by
 * anything that re-reads `connection.adt`, e.g. the `finally` in
 * `DebugTransport.request()`) could throw `SESSION_DEAD` over a result SAP had
 * already committed and handed back.
 *
 * `AbapConnection` now defers a death learned this way (`deferredDeath`) and
 * promotes it at the next request boundary (`applyDeferredDeath()`). Separately,
 * `DebugTransport.request()` now captures its `ADTClient` handle once, before
 * dispatch, and restores through that handle rather than re-reading
 * `connection.adt` in `finally` — because two concurrent debugger requests
 * share one connection, a *non-2xx* death recorded by one can still make the
 * other's `finally` throw over its own success (T6).
 *
 * Entirely offline. Nothing here addresses a real SAP system.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError } from "../src/adt/errors.js";
import { DebugTransport } from "../src/debug/transport.js";
import { SafetyGate } from "../src/safety.js";
import {
  FakeAdtServer,
  __resetFakeAdtCounters,
  deferred,
  fakeResponse,
  flushMicrotasks,
  type FakeRoute,
} from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, DATAPREVIEW_XML, T000_NONPRODUCTIVE, systemRoleProbeResponse } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Fixtures shared by T1-T5 (the FakeAdtServer-backed tests)
// ---------------------------------------------------------------------------

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    // Client 001 -> CCCATEGORY "C", proving non-productive so the writable
    // tests below aren't answered by the fail-closed lockout instead of the
    // thing under test.
    client: "001",
    readOnly: false,
  });

const OK_XML = { "content-type": "application/xml" } as const;

/** The system-role probe, answered non-productive — see cfg()'s comment. */
const systemRoleRoute: FakeRoute = (r) =>
  r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined;

/**
 * The 2xx-carried-death shape: a `200` carrying `x-sap-icm-err-id: ICMENOSESSION`
 * alongside a REAL, committed body — exactly what a caller must not lose.
 */
const icmDeath200 = (body: string, extraHeaders: Record<string, string> = {}) =>
  fakeResponse(200, body, { ...OK_XML, "x-sap-icm-err-id": "ICMENOSESSION", ...extraHeaders });

const openConnections: AbapConnection[] = [];

beforeEach(() => {
  __resetFakeAdtCounters();
});

afterEach(() => {
  for (const conn of openConnections.splice(0)) conn.dispose();
});

/** A `FakeAdtServer` + real `AbapConnection`, wired the way production wires them. */
function wire(routes: readonly FakeRoute[] = []): { conn: AbapConnection; server: FakeAdtServer } {
  const server = new FakeAdtServer({ transportErrors: "throw", routes: [systemRoleRoute, ...routes] });
  const conn = new AbapConnection(cfg(), {
    httpClient: server.client("s1"),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  openConnections.push(conn);
  return { conn, server };
}

const PROBE_URI = "/sap/bc/adt/programs/programs/zmcp_probe_rep";
const DEBUGGER_URI = "/sap/bc/adt/debugger";
const PUT_URI = "/sap/bc/adt/programs/programs/zmcp_probe_rep/source/main";

// ---------------------------------------------------------------------------
// T1 — the committed result survives
// ---------------------------------------------------------------------------

describe("T1 — a committed 2xx result is not discarded for a death it also carried", () => {
  it("a mutating debugger POST answered 200+ICMENOSESSION resolves with the server's body", async () => {
    const attachBody = "<dbg:attach/>";
    const { conn, server } = wire([
      (r) => (r.method === "POST" && r.path === DEBUGGER_URI ? icmDeath200(attachBody) : undefined),
    ]);
    await conn.connect();
    const safety = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const transport = new DebugTransport(conn, { safety });

    const r = await transport.request({ method: "POST", path: DEBUGGER_URI, qs: { method: "attach" } });

    expect(r.status).toBe(200);
    expect(r.body).toBe(attachBody);
    void server;
  });
});

// ---------------------------------------------------------------------------
// T2 — the signal is preserved, but deferred to the NEXT request
// ---------------------------------------------------------------------------

describe("T2 — the death is not lost, only deferred to the next request boundary", () => {
  it("resolves the committed call untouched, then refuses the next one", async () => {
    const attachBody = "<dbg:attach/>";
    const { conn, server } = wire([
      (r) => (r.method === "POST" && r.path === DEBUGGER_URI ? icmDeath200(attachBody) : undefined),
      (r) => (r.method === "GET" && r.path === PROBE_URI ? fakeResponse(200, "<ok/>", OK_XML) : undefined),
    ]);
    await conn.connect();
    const safety = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const transport = new DebugTransport(conn, { safety });

    let fired = 0;
    conn.onDead(() => fired++);

    const r = await transport.request({ method: "POST", path: DEBUGGER_URI, qs: { method: "attach" } });
    expect(r.body).toBe(attachBody);

    // (i) — at the moment the committed call returns, the death has NOT been
    // applied yet: no listener fired, the connection does not report dead.
    // This is the assertion that fails without the fix (the listener already
    // fired synchronously inside the call above).
    expect(fired).toBe(0);
    expect(conn.isDead).toBe(false);

    // (ii) — the NEXT request is refused locally, with the real shape.
    const callsBefore = server.calls.length;
    const err = await conn.get(PROBE_URI).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isAbapError(err) && err.code).toBe("SESSION_DEAD");
    expect(isAbapError(err) && (err.details as { condemned?: boolean } | undefined)?.condemned).toBe(true);

    // (iii) — only NOW is the death actually applied.
    expect(conn.isDead).toBe(true);
    expect(fired).toBe(1);

    // T3 lives here too: the refusal never reached the wire.
    expect(server.calls.length).toBe(callsBefore);
  });
});

// ---------------------------------------------------------------------------
// T3 is the last assertion of T2 above (kept in the same test rather than
// re-running the same call sequence a second time just to recount `calls`).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T4 — connect()'s own semantics are unchanged: a 200 carrying ICMENOSESSION
// on a discovery/role probe must still make connect() REJECT, because there
// is no committed caller result to protect at connect time. This property is
// already pinned by test/connection-generation-race.test.ts's "connect()'s
// tail (F1a)" and "the revival's own logon (F1b)" blocks (both built on the
// same icmDeath200() shape used above) — not duplicated here. Verified as
// part of this change's targeted-test run that that file still passes in
// full, unchanged.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T5 — the write seam: a PUT inside withStatefulSession answered 200+ICMENOSESSION
// still resolves with the PUT's own result.
// ---------------------------------------------------------------------------

describe("T5 — the write seam: a stateful PUT survives a death it also carried", () => {
  it("conn.withStatefulSession(() => conn.put(...)) resolves with the PUT's result", async () => {
    const putBody = "<program>normalised source</program>";
    const { conn } = wire([
      (r) => (r.method === "PUT" && r.path === PUT_URI ? icmDeath200(putBody) : undefined),
    ]);
    await conn.connect();

    let fired = 0;
    conn.onDead(() => fired++);

    const result = await conn.withStatefulSession(async () => {
      const r = await conn.put(PUT_URI, { qs: { lockHandle: "IRRELEVANT-NOT-A-REAL-LOCK" }, body: "source" });
      return r;
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe(putBody);
    // Same deferred-not-lost property as T2, at the write seam.
    expect(fired).toBe(0);
    expect(conn.isDead).toBe(false);
    const err = await conn.get(PROBE_URI).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isAbapError(err) && err.code).toBe("SESSION_DEAD");
    expect(conn.isDead).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T6 — Part B in isolation: two DebugTransport requests sharing one
// connection, where a NON-2xx death is recorded by one while the other is
// still in flight and about to succeed.
//
// FakeAdtServer models real captured head-of-line behaviour: once a session
// is marked stateful (every DebugTransport request sets
// `X-sap-adt-sessiontype: stateful`), a second request on that SAME session
// is queued behind the first at the fake's own arrival point and cannot be
// answered before the first settles — so it cannot be used to construct the
// interleaving this test needs (kill-while-the-other-is-still-parked). A
// manual, hand-rolled `HttpClient` (same idiom as `FakeAdt` in
// test/connection-liveness.test.ts, plus `deferred()` from
// test/helpers/fake-adt.ts to hold a response open) gives direct control over
// resolution order instead.
// ---------------------------------------------------------------------------

const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

/** The real transport's throw shape — `abap-adt-api` narrows on `isHttpClientException`. */
const axiosLike = (request: HttpClientOptions, response: HttpClientResponse): HttpClientException =>
  new HttpClientException(
    `Request failed with status code ${response.status}`,
    "ERR_BAD_REQUEST",
    response.status,
    undefined,
    request,
    response,
    undefined,
  );

const SESSION_GONE_PAGE = `<!DOCTYPE html><html><head><title>Application Server Error</title></head>
<body><h1>400 Session timed out</h1></body></html>`;
const ICMENOSESSION_HEADERS = {
  "content-type": "text/html",
  "x-sap-icm-err-id": "ICMENOSESSION",
  "sap-err-id": "ICMENOSESSION",
  connection: "close",
};

const T6_SURVIVOR_URI = "/sap/bc/adt/debugger/stack";
const T6_KILLER_URI = "/sap/bc/adt/debugger/variables";

/** Manual `HttpClient`: a route answers immediately, or returns `"hold"` to park the call on a `deferred()` the test releases later. */
class ManualClient implements HttpClient {
  readonly calls: HttpClientOptions[] = [];
  private readonly held = new Map<string, ReturnType<typeof deferred<HttpClientResponse>>>();
  constructor(private readonly route: (o: HttpClientOptions, n: number) => HttpClientResponse | "hold") {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    const label = `${(o.method ?? "GET").toUpperCase()} ${o.url}`;
    const out = this.route(o, this.calls.length);
    if (out === "hold") {
      const d = deferred<HttpClientResponse>();
      this.held.set(label, d);
      return d.promise;
    }
    if (out.status < 200 || out.status >= 300) throw axiosLike(o, out);
    return out;
  }
  release(label: string, response: HttpClientResponse): void {
    const held = this.held.get(label);
    if (!held) throw new Error(`ManualClient: no held request '${label}'`);
    this.held.delete(label);
    held.resolve(response);
  }
}

const t6Route = (o: HttpClientOptions, n: number): HttpClientResponse | "hold" => {
  if (o.url.includes("/compatibility/graph")) return fakeResponse(200, "<graph/>", LOGIN_HEADERS);
  if (o.url.endsWith("/discovery")) return fakeResponse(200, "<service/>", OK_XML);
  if (o.url.includes("/ato/settings")) return fakeResponse(200, "<settings/>", OK_XML);
  if (o.url.includes(DATA_PREVIEW_PATH)) return fakeResponse(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  if (o.url === T6_SURVIVOR_URI) return "hold";
  if (o.url === T6_KILLER_URI) return fakeResponse(400, SESSION_GONE_PAGE, ICMENOSESSION_HEADERS);
  throw new Error(`ManualClient (T6): unrouted request #${n} ${o.method ?? "GET"} ${o.url}`);
};

describe("T6 — Part B: a concurrent non-2xx death must not mask another request's own success", () => {
  /**
   * `GuardedHttpClient` (src/adt/http-guard.ts, "LEVEL A") serialises actual
   * WIRE dispatch to one at a time per connection — real, not a fake
   * artefact — so the killer cannot be ON THE WIRE while the survivor is
   * still parked; it queues behind the survivor's held dispatch instead.
   * What this test can and does construct: release the survivor, and in the
   * SAME synchronous tick (before its continuation is even scheduled) start
   * the killer. `http-guard.ts`'s `release()` (line 533) runs — and hands the
   * mutex to the queued killer — INSIDE the `finally` of the survivor's own
   * `guard.request()` call, strictly before that call's own promise resolves
   * and schedules the survivor's continuation. FIFO microtask ordering then
   * runs the killer's unblocked dispatch, and everything through
   * `noteWireThrow`/`markDead`, ahead of the survivor's own remaining unwind
   * back to `DebugTransport.request()`'s `finally`. Asserted below, not
   * assumed: `conn.isDead` is already `true` when the survivor's own promise
   * settles.
   */
  it("the survivor still resolves even though the killer recorded a real death first", async () => {
    const client = new ManualClient(t6Route);
    const conn = new AbapConnection(cfg(), { httpClient: client, breaker: new AuthCircuitBreaker(), log: () => {} });
    openConnections.push(conn);
    await conn.connect();
    const safety = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const transport = new DebugTransport(conn, { safety });

    const survivor = transport.request({ method: "GET", path: T6_SURVIVOR_URI });
    // Let the survivor's request() run past capturing `connection.adt` and
    // reach the wire, where ManualClient parks it and the LEVEL A mutex is
    // held for the duration of the park.
    await flushMicrotasks(50);

    // Queued behind the survivor's held dispatch (LEVEL A) — not yet on the
    // wire, and not awaited yet: released below in the same tick as the
    // survivor, so it runs its whole death exactly in the gap between the
    // survivor's wire dispatch resolving and its own `finally`.
    const killer = transport.request({ method: "GET", path: T6_KILLER_URI }).catch(() => undefined);

    client.release(`GET ${T6_SURVIVOR_URI}`, fakeResponse(200, "<dbg:stack/>", OK_XML));

    await killer;
    // Sanity: this is a REAL death, not a test fiction, and it landed before
    // the survivor's own promise below settled.
    expect(conn.isDead).toBe(true);

    const result = await survivor;
    expect(result.status).toBe(200);
    expect(result.body).toBe("<dbg:stack/>");
  });
});
