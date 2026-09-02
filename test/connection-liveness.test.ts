/**
 * `AbapConnection` knows whether its own ABAP session is alive.
 *
 * Entirely offline: the transport is a fake `HttpClient` injected through
 * `ConnectionOptions.httpClient`, the pattern established in
 * `test/session.test.ts` / `test/circuit-breaker.test.ts`. Nothing here
 * addresses a real SAP system.
 *
 * ## The three properties worth the file
 *
 *  1. **Death is LEARNED, never asked for.** There is no probe, no ping, no
 *     timer and no heartbeat anywhere in the liveness path, and the tests below
 *     assert that with request counts rather than with prose. The measurement
 *     forbidding a probe is captured live: "The same session
 *     is head-of-line blocked — **not** killed" — a synthetic request issued on
 *     a session that already has an outstanding long poll waits out that poll's
 *     entire remaining timeout. A "health check" on a pooled session is not a
 *     cheap liveness read, it is a stall of unbounded length.
 *
 *  2. **Both outcomes of a request are observed.** The real transport THROWS
 *     for every status >= 400 and carries the response on `.response`, while
 *     most fakes in this suite RESOLVE the same status. Session death is a
 *     `400`/`ICMENOSESSION` or a `500` dump page, so a wiring that only
 *     watched resolutions would pass
 *     every offline test and never fire once against the appliance. Both paths
 *     are pinned here.
 *
 *  3. **Death un-sticks the connection.** `markDead()` drops `connected`, so
 *     `connect()` genuinely logs on again instead of early-returning — and the
 *     bounds that stop that becoming a logon loop (`login/fails_to_user_lock`
 *     is a SHARED counter on SAP; a loop on bad credentials locks the real
 *     user) are asserted, not assumed.
 *
 * ## What `heldLockUris()` is and is not
 *
 * It reads the ONE existing ledger — `StatefulSession.heldLocks` — and builds
 * no second one. It is for reporting and for clearing local state. It is never
 * a work list: when the session dies its enqueues are already gone server-side,
 * `unLock` with a stale handle answers `200` regardless, and re-locking in the
 * same session answers `403` indistinguishably from a genuine conflict. So
 * nothing may turn this array into unlock or re-lock traffic.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
// A VALUE import, on purpose. The fake below raises the real exception class the
// real transport raises; see `axiosLike`.
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import {
  AbapConnection,
  connectionDeadError,
  type ConnectionOptions,
  type DeathRecord,
} from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError } from "../src/adt/errors.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROG_URI = "/sap/bc/adt/programs/programs/zmcp_probe_rep";

const LOCK_XML = (handle = "LOCKHANDLEA") =>
  `<?xml version="1.0" encoding="utf-8"?>
<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>
  <LOCK_HANDLE>${handle}</LOCK_HANDLE>
  <CORRNR/><CORRUSER/><CORRTEXT/>
  <IS_LOCAL>X</IS_LOCAL>
  <IS_LINK_UP/><MODIFICATION_SUPPORT/><SCOPE_MESSAGES/>
</DATA></asx:values></asx:abap>`;

/**
 * The ICM page a short dump produces — a reconstruction of the markup, but the
 * three content strings are the captured ones (see `extractDumpShortText`).
 */
const DUMP_PAGE = `<!DOCTYPE html><html><head><title>Application Server Error</title>
<style>body{font-family:Arial}</style></head><body>
<h1>500 Internal Server Error</h1>
<p>Division by zero</p>
<table><tr><td>Server time:</td><td>2026-07-31 13:02:57</td></tr></table>
</body></html>`;

/**
 * The passive-expiry answer, captured live: the
 * ICM answers `400` with `x-sap-icm-err-id: ICMENOSESSION` before the ABAP
 * stack is involved at all, and the header — not the localised HTML — is the
 * reliable signature.
 */
const ICMENOSESSION_HEADERS = {
  "content-type": "text/html",
  "x-sap-icm-err-id": "ICMENOSESSION",
  "sap-err-id": "ICMENOSESSION",
  connection: "close",
};
const SESSION_GONE_PAGE = `<!DOCTYPE html><html><head><title>Application Server Error</title></head>
<body><h1>400 Session timed out</h1></body></html>`;

/** The lock conflict — a 403 that is emphatically NOT session death. */
const LOCK_CONFLICT_XML = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceNoAccess"/>
  <message lang="EN">User DEVELOPER is currently editing ZMCP_PROBE_REP</message>
</exc:exception>`;

// ---------------------------------------------------------------------------
// Offline transport
// ---------------------------------------------------------------------------

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

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
/**
 * Fixture 087, the real 200 capture of
 * `SELECT mandt, cccategory, cccoractiv FROM t000`: client 000 -> "S",
 * client 001 -> "C". These fakes log on as client 001, so the fake system is
 * provably NON-productive — which is a precondition for anything here that
 * takes a lock. This suite ROUTES the system-role probe; it is deliberately
 * not on `PROBE_ALLOWLIST`.
 *
 * Imported, with `DATAPREVIEW_XML`, from ./helpers/system-role-fake.js.
 */
/** `loggedin` is `csrfToken !== "fetch"`, so the logon response must carry one. */
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

/** Makes `route` throw an arbitrary value — a bare network error, say. */
class Thrown {
  constructor(readonly error: unknown) {}
}

/**
 * Opt OUT of the axios-faithful throw below and RESOLVE this response instead,
 * whatever its status.
 *
 * Exactly one property needs this: that `noteWireResponse` classifies a
 * resolved non-2xx too, so the observation point is not one-sided. Every other
 * test wants production's shape, which is the throw. If you reach for this
 * wrapper to make a test pass, the test is wrong.
 */
class Resolved {
  constructor(readonly response: HttpClientResponse) {}
}

/**
 * The exception the REAL transport raises, built the way the real transport
 * builds it.
 *
 * `AxiosHttpClient.request` (`abap-adt-api/build/AxiosHttpClient.js:105`) has no
 * `validateStatus` override, so axios' default — `status >= 200 && status < 300`
 * — applies and axios REJECTS every other status. The catch there rethrows as
 * `new HttpClientException(message, code, status, config, options, response,
 * parent)`, hanging the response off `.response`. That, and not a resolution, is
 * how a `400`/`ICMENOSESSION` and a `500` dump page reach this process in
 * production.
 *
 * It is the real class rather than a plain object with a `.response` field
 * because `abap-adt-api` narrows on `isHttpClientException` (`AdtHTTP.js:41`,
 * used by `AdtException.fromException`); an impostor is downgraded to a generic
 * status-500 `AdtErrorException` and the status is lost. A fake that produced
 * the impostor would still exercise `noteWireThrow`, but it would misrepresent
 * everything downstream of it.
 */
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

/**
 * The offline transport — and it REJECTS every non-2xx, because axios does.
 *
 * This default is the whole point of the class. While this fake RESOLVED a
 * `400`, the only production-reachable death path (`noteWireThrow`) was covered
 * by a single hand-rolled test: an auditor mutated `noteWireThrow` to drop 5xx
 * silently and the mutant survived the entire suite. `resp(500, DUMP_PAGE)`
 * proved nothing, because production never took the path it exercised.
 *
 *  - a plain `HttpClientResponse` with a 2xx status → resolved;
 *  - a plain `HttpClientResponse` with any other status → thrown as
 *    {@link axiosLike}, response attached, exactly as on the appliance;
 *  - `Thrown` → that value is thrown raw (a bare `ECONNRESET`, no `.response`);
 *  - `Resolved` → resolved regardless of status, for the one test that needs it.
 */
class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(public route: (r: Recorded) => HttpClientResponse | Thrown | Resolved) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body };
    this.calls.push(rec);
    const out = this.route(rec);
    if (out instanceof Thrown) throw out.error;
    if (out instanceof Resolved) return out.response;
    if (out.status < 200 || out.status >= 300) throw axiosLike(o, out);
    return out;
  }
  get labels(): string[] {
    return this.calls.map((c) => c.label);
  }
}

const writableCfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

/** The connect() handshake, including the system-role probe. Anything else falls through. */
function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle"))
    return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

// ---------------------------------------------------------------------------
// Lifecycle — the process-listener canary, same contract as session.test.ts
// ---------------------------------------------------------------------------

const openConnections: AbapConnection[] = [];

// `ConnectionOptions.breaker` is now required, and threading it through the
// ~25 call sites in this file would be noise — this helper owns it, and no
// test in this file needs to reach the breaker it silently injects.
function tracked(cfg: Config, opts: Omit<ConnectionOptions, "breaker">): AbapConnection {
  const conn = new AbapConnection(cfg, { breaker: new AuthCircuitBreaker(), ...opts });
  openConnections.push(conn);
  return conn;
}

/** Same as `tracked`, for the one test that supplies its own breaker and asserts on it. */
function trackedWith(cfg: Config, opts: ConnectionOptions): AbapConnection {
  const conn = new AbapConnection(cfg, opts);
  openConnections.push(conn);
  return conn;
}

const listenerCounts = (): Record<string, number> => ({
  SIGINT: process.listenerCount("SIGINT"),
  SIGTERM: process.listenerCount("SIGTERM"),
  beforeExit: process.listenerCount("beforeExit"),
});

let listenersBefore = listenerCounts();

beforeEach(() => {
  listenersBefore = listenerCounts();
});

afterEach(() => {
  for (const conn of openConnections.splice(0)) conn.dispose();
  // Net-zero per test. Nothing here may add a `process.on` — the shared hook
  // in `src/shutdown-hook.ts` is the only module allowed to, and this is the
  // canary that notices if that stops being true.
  expect(listenerCounts()).toEqual(listenersBefore);
});

/** A fake clock, so timestamps are asserted rather than approximated. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

async function connected(
  route: (r: Recorded) => HttpClientResponse | Thrown | Resolved,
  opts: { now?: () => number; breaker?: AuthCircuitBreaker } = {},
): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = tracked(writableCfg(), { httpClient: adt, log: () => {}, ...opts });
  await conn.connect();
  return { conn, adt };
}

const GENERIC_OK = (): HttpClientResponse => resp(200, "ok", OK_TEXT);

// ===========================================================================

describe("markDead / isDead", () => {
  it("records the reason and a timestamp, and is idempotent (first reason wins)", async () => {
    const c = clock();
    const { conn } = await connected(GENERIC_OK, { now: c.now });

    expect(conn.isDead).toBe(false);
    expect(conn.deathRecord).toBeUndefined();

    c.advance(5_000);
    conn.markDead("first reason");
    expect(conn.isDead).toBe(true);
    expect(conn.deathRecord?.reason).toBe("first reason");
    expect(conn.deathRecord?.atMs).toBe(1_005_000);

    // The FIRST reason is the one with the evidence; a later caller only ever
    // knows the consequences. Neither the reason nor the timestamp may move.
    c.advance(9_999);
    conn.markDead("second reason");
    expect(conn.deathRecord?.reason).toBe("first reason");
    expect(conn.deathRecord?.atMs).toBe(1_005_000);
  });

  it("issues no request — death is recorded, never confirmed", async () => {
    const { conn, adt } = await connected(GENERIC_OK);
    const before = adt.calls.length;
    const requestsBefore = conn.requestCount;

    conn.markDead("idle timeout");

    // A synthetic request on a session with an outstanding long poll is
    // head-of-line blocked for that poll's full remaining timeout. Nothing on
    // this path may ever put a byte on the wire.
    expect(adt.calls.length).toBe(before);
    expect(conn.requestCount).toBe(requestsBefore);
  });

  it("drops `connected`, because a dead session is not a connected one", async () => {
    const { conn } = await connected(GENERIC_OK);
    expect(conn.isConnected).toBe(true);

    conn.markDead("session gone");

    expect(conn.isConnected).toBe(false);
    expect(conn.info().connected).toBe(false);
  });
});

describe("assertUsable() learns the dead state", () => {
  it("throws SESSION_DEAD naming the recorded reason, from every entry point", async () => {
    const { conn } = await connected(GENERIC_OK);
    conn.markDead("HTTP 400: the ABAP session no longer exists");

    for (const call of [
      () => conn.adt,
      () => conn.get("/sap/bc/adt/discovery"),
      () => conn.post("/sap/bc/adt/activation"),
      () => conn.put("/sap/bc/adt/x", { body: "" }),
      () => conn.del("/sap/bc/adt/x"),
      () => conn.dropSession(),
      () => conn.withStatefulSession(async () => undefined),
      () => conn.withFreshSession(async () => undefined),
    ]) {
      const e = await Promise.resolve()
        .then(call)
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      expect(isAbapError(e)).toBe(true);
      expect(isAbapError(e) && e.code).toBe("SESSION_DEAD");
      expect(isAbapError(e) && e.message).toContain(
        "HTTP 400: the ABAP session no longer exists",
      );
    }
  });

  it("the typed error carries the held-lock snapshot and says nothing needs cleaning up", () => {
    const err = connectionDeadError({
      reason: "short dump",
      atMs: 1_700_000_000_000,
      heldLockUris: [PROG_URI],
    });
    expect(err.code).toBe("SESSION_DEAD");
    expect(err.details.heldLocks).toEqual([PROG_URI]);
    expect(err.details.reason).toBe("short dump");
    // The enqueues died with the session. The hint must not send anyone
    // hunting for locks to release, and must not read as an auth failure.
    expect(err.hint).toMatch(/already.*released|nothing to clean up/i);
    expect(err.hint).toMatch(/not an authentication failure/i);
  });

  it("the breaker still outranks death — the latch is the harder stop", async () => {
    const breaker = new AuthCircuitBreaker();
    const { conn } = await connected(GENERIC_OK, { breaker });
    conn.markDead("session gone");
    breaker.trip("http-401", "bad credentials");

    const e = await conn.get("/sap/bc/adt/discovery").then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(isAbapError(e) && e.code).toBe("AUTH_CIRCUIT_OPEN");
  });
});

// `withStatefulSession()` checked `readOnly` but the raw
// `put()`/`post()`/`del()` verbs — reachable directly, without going through
// a lock — did not. A connection built with `readOnly: true` must refuse ALL
// mutating traffic, not merely lock acquisition, purely at the connection
// level (no safety-gate/tool layer involved here).
describe("readOnly gates raw put()/post()/del(), mirroring withStatefulSession()", () => {
  const readOnlyCfg = (): Config =>
    ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "DEVELOPER",
      password: "secret",
      sid: "A4H",
      client: "001",
      readOnly: true,
    });

  async function connectedReadOnly(): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
    const adt = new FakeAdt((r) => baseRoute(r) ?? GENERIC_OK());
    const conn = tracked(readOnlyCfg(), { httpClient: adt, log: () => {} });
    await conn.connect();
    return { conn, adt };
  }

  it("refuses put()/post()/del() with READ_ONLY before any request is dispatched", async () => {
    const { conn, adt } = await connectedReadOnly();
    const before = adt.calls.length;

    for (const call of [
      () => conn.put("/sap/bc/adt/x", { body: "<x/>" }),
      () => conn.post("/sap/bc/adt/activation"),
      () => conn.del("/sap/bc/adt/x"),
    ]) {
      const e = await Promise.resolve()
        .then(call)
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      expect(isAbapError(e)).toBe(true);
      expect(isAbapError(e) && e.code).toBe("READ_ONLY");
    }

    // Same contract as `withStatefulSession()`'s existing readOnly guard: the
    // refusal is a pure client-side gate, so nothing extra hits the wire.
    expect(adt.calls.length).toBe(before);
  });

  it("still allows get() — the gate is on mutating verbs only", async () => {
    const { conn } = await connectedReadOnly();
    await expect(conn.get("/sap/bc/adt/discovery")).resolves.toBeDefined();
  });

  it("still refuses withStatefulSession() with the same READ_ONLY code, unchanged", async () => {
    const { conn } = await connectedReadOnly();
    const e = await conn.withStatefulSession(async () => undefined).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(isAbapError(e) && e.code).toBe("READ_ONLY");
  });

  it("a writable connection (readOnly: false) still lets put()/post()/del() reach the wire", async () => {
    const { conn, adt } = await connected(GENERIC_OK);

    await conn.put("/sap/bc/adt/x", { body: "<x/>" });
    await conn.post("/sap/bc/adt/activation");
    await conn.del("/sap/bc/adt/x");

    expect(adt.labels).toEqual(
      expect.arrayContaining([
        "PUT /sap/bc/adt/x",
        "POST /sap/bc/adt/activation",
        "DELETE /sap/bc/adt/x",
      ]),
    );
  });
});

describe("heldLockUris() — the existing ledger, read, not rebuilt", () => {
  it("is empty outside a stateful session, populated inside it, empty after", async () => {
    const seen: string[][] = [];
    const { conn } = await connected((r) => {
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      return GENERIC_OK();
    });

    expect(conn.heldLockUris()).toEqual([]);

    await conn.withStatefulSession(async (session) => {
      await session.lock(PROG_URI);
      // The ledger under test is `StatefulSession.heldLocks`; this asserts the
      // connection is reading THAT one and not a private copy of its own.
      seen.push(conn.heldLockUris());
      expect(conn.heldLockUris()).toEqual(session.heldLocks.map((l) => l.uri));
    });

    expect(seen).toEqual([[PROG_URI]]);
    expect(conn.heldLockUris()).toEqual([]);
  });

  it("is snapshotted into the death record at the moment of death", async () => {
    let recorded: readonly string[] | undefined;
    const { conn } = await connected((r) => {
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      return GENERIC_OK();
    });

    await conn.withStatefulSession(async (session) => {
      await session.lock(PROG_URI);
      conn.markDead("session expired mid-edit");
      recorded = conn.deathRecord?.heldLockUris;
    });

    expect(recorded).toEqual([PROG_URI]);
    // Still there after the session was torn down: the record is a snapshot for
    // REPORTING, not a live view and not a to-do list.
    expect(conn.deathRecord?.heldLockUris).toEqual([PROG_URI]);
  });

  it("marking dead sends no unlock and no re-lock", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      return GENERIC_OK();
    });

    let duringDeath: string[] = [];
    await conn.withStatefulSession(async (session) => {
      await session.lock(PROG_URI);
      const before = adt.labels.length;
      conn.markDead("session expired mid-edit");
      duringDeath = adt.labels.slice(before);
    });

    // `unLock` with a stale handle answers 200, so release can never be
    // inferred from a status — and re-locking in the same session answers
    // 403, indistinguishable from a real conflict. The only safe number of
    // requests `markDead` may issue is zero.
    expect(duringDeath).toEqual([]);
  });
});

/**
 * The "would have caught this" test for the pool's dead guard.
 *
 * `test/pool-lifecycle.test.ts`'s "DESTROYS a slot released while it still
 * holds ABAP enqueues" test pushes straight into a DOUBLE's `locks` array
 * (`f.created[0]!.locks.push(...)`), so the double's `heldLockUris()` just
 * returns that array verbatim — always live, never cleared. It passes
 * without ever exercising `AbapConnection.activeSession`'s real lifetime, so
 * it could not have caught (and does not pin) the actual bug: `heldLockUris()`
 * on a REAL connection reads `activeSession`, and `withStatefulSession()`'s
 * own outer `finally` clears `activeSession` before ANY caller outside that
 * method — including the pool's `releaseSlot()` — can run again.
 *
 * This drives a genuine UNLOCK failure through the REAL `StatefulSession`
 * lifecycle (no double) and checks the two things that actually matter:
 *
 *   1. `heldLockUris()` — the pool guard's one data source — really is blind
 *      to a leak that just, genuinely, happened. That is the dead-code
 *      finding, pinned rather than merely argued in a comment.
 *   2. The enqueue is released anyway, by an entirely different mechanism:
 *      `withStatefulSession()`'s own `finally` drops the session the moment
 *      it records a leak (`connection.ts`), which is what this fix
 *      added. Observed here as the `dropSession()` signature request —
 *      `GET /sap/bc/adt/compatibility/graph` — landing AFTER the exhausted
 *      UNLOCK retries.
 */
describe("a lock leak is invisible to heldLockUris() by the time anyone could read it, but the enqueue is released anyway", () => {
  /**
   * `423 ExceptionResourceInvalidLockHandle` — CONFIRMED LIVE, captured twice
   * verbatim (see `session.ts`'s `translateAdtError`, the
   * `INVALID_LOCK_HANDLE_TYPE_IDS` branch, and `test/helpers/fake-adt.ts`'s
   * `invalidLockHandle423()`). Deliberately NOT a 5xx/408/429: those feed
   * `AuthCircuitBreaker.inspect()`'s transient-failure counter (any 5xx counts,
   * regardless of whether it carries a well-formed ADT exception body), and
   * three of them in a row — exactly `1 + unlockRetries` — trips the transient
   * breaker and sheds the very `dropSession()` request this test exists to
   * observe, for a reason that has nothing to do with defect 1 or defect 3. A
   * 423 is also the far more faithful fixture: it is what a real stale/invalid
   * lock handle actually produces on the wire, not a generic 500.
   */
  const GENUINE_UNLOCK_FAILURE_XML = (handle: string) => `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceInvalidLockHandle"/>
  <message lang="EN">Resource PROG ${PROG_URI} is not locked (invalid lock handle: ${handle})</message>
</exc:exception>`;

  it("heldLockUris() is [] right after the leak, and dropSession() fires to release it anyway", async () => {
    let unlockAttempts = 0;
    const { conn, adt } = await connected((r) => {
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") {
        unlockAttempts++;
        return resp(423, GENUINE_UNLOCK_FAILURE_XML("LOCKHANDLEA"), OK_XML);
      }
      return GENERIC_OK();
    });

    const before = adt.labels.length;
    let sawHeldWhileLocked: string[] = [];
    await conn.withStatefulSession(async (session) => {
      await session.lock(PROG_URI);
      // Sanity: the ledger DOES see it while the session is genuinely alive
      // and holding it — this is not a claim that heldLockUris() never works.
      sawHeldWhileLocked = conn.heldLockUris();
    });
    expect(sawHeldWhileLocked).toEqual([PROG_URI]);

    // The retry loop actually ran to exhaustion: `unlockRetries` defaults to
    // 2, so 1 + 2 = 3 attempts, all genuinely failing.
    expect(unlockAttempts).toBe(3);

    // DEFECT 1, pinned: a real leak just happened, and there is nothing left
    // for the pool's guard to read — `heldLockUris()` is unconditionally [].
    expect(conn.heldLockUris()).toEqual([]);

    // DEFECT 3's fix: the connection escalated on its own. `dropSession()`'s
    // signature GET must appear, and it must appear AFTER the last failed
    // UNLOCK, not merely somewhere in the whole call (which could just be
    // the initial connect() handshake before `before` was captured).
    const after = adt.labels.slice(before);
    const lastUnlockIdx = after.reduce(
      (last, label, i) => (label.startsWith("UNLOCK ") ? i : last),
      -1,
    );
    const dropIdx = after.indexOf("GET /sap/bc/adt/compatibility/graph");
    expect(lastUnlockIdx, "the fixture must have actually seen UNLOCK calls").toBeGreaterThanOrEqual(0);
    expect(dropIdx, "dropSession()'s GET must fire").toBeGreaterThanOrEqual(0);
    expect(dropIdx).toBeGreaterThan(lastUnlockIdx);

    // The secondary fix: onLockLeak is wired, and the leak survives past the
    // frame that recorded it (unlike heldLockUris(), on purpose — see
    // `lastLockLeak`'s own comment).
    expect(conn.lastLeakedLock).toBeDefined();
    expect(conn.lastLeakedLock?.details?.["reason"]).toBe("lock-leaked");
  });

  it("does NOT escalate a normal lock -> unlock cycle — dropSession() is not called when nothing leaked", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      return GENERIC_OK();
    });

    const before = adt.labels.length;
    await conn.withStatefulSession(async (session) => {
      await session.lock(PROG_URI);
    });

    const after = adt.labels.slice(before);
    expect(after).not.toContain("GET /sap/bc/adt/compatibility/graph");
    expect(conn.lastLeakedLock).toBeUndefined();
  });

  /**
   * The two session-death classifiers' disagreement, surfaced during the
   * `runOnAttempt` rebase (merged `3ebe2ca`): `dropSession()`'s FIRST line is `assertUsable()`,
   * which throws a `SESSION_DEAD`-coded error if `this.death` is already
   * set — and `this.death` is set by a WIRE-LEVEL classifier
   * (`noteWireResponse`/`classifySessionFailure`) that runs independently of
   * the per-error translation (`translateAdtError`) this session uses to
   * decide whether an UNLOCK failure counts as a leak at all
   * (`UNLOCK_NOT_A_LEAK`). Those two classifiers can disagree on the SAME
   * response: `translateAdtError` checks `INVALID_LOCK_HANDLE_TYPE_IDS`
   * before it ever reaches its own `classifySessionFailure` call, so a 423
   * `ExceptionResourceInvalidLockHandle` body that ALSO happens to carry an
   * `x-sap-icm-err-id: ICMENOSESSION` header is "not a death" to the first
   * (a leak) and "a death" to the second (`this.death` gets set). This
   * fixture reproduces exactly that disagreement — not a hypothetical.
   *
   * Before the swallow-guard added alongside this test, the leak-triggered
   * `dropSession()` call would itself throw the freshly-synthesized
   * `SESSION_DEAD`, which — thrown from `withStatefulSession()`'s `finally`
   * — overrides whatever `fn(session)` already returned, INCLUDING A
   * SUCCESSFUL WRITE. `pool.ts`'s `runOnAttempt` (added to replay a mutating
   * operation on a session-dead error shape) replays
   * exactly that error shape once on a fresh slot, which would double the
   * write. The guard exists so this can never happen: the operation's own
   * result must survive, and no `SESSION_DEAD` may escape from a
   * post-success, leak-triggered cleanup.
   */
  it("a SESSION_DEAD synthesized by the leak-triggered dropSession() itself does not override a successful result", async () => {
    const logged: string[] = [];
    const adt = new FakeAdt(
      (r) =>
        baseRoute(r) ??
        (r.qs._action === "LOCK"
          ? resp(200, LOCK_XML(), OK_XML)
          : r.qs._action === "UNLOCK"
            ? resp(423, GENUINE_UNLOCK_FAILURE_XML("LOCKHANDLEA"), {
                ...OK_XML,
                // The divergence: this header makes the CONNECTION-level
                // classifier (`classifySessionFailure`, wire-response shape)
                // record a death, even though `translateAdtError` — reading
                // the SAME response as a caught exception — resolves the
                // `ExceptionResourceInvalidLockHandle` type id first and
                // never reaches its own `classifySessionFailure` call, so
                // session.ts still treats this as a genuine leak.
                "x-sap-icm-err-id": "ICMENOSESSION",
              })
            : GENERIC_OK()),
    );
    const conn = tracked(writableCfg(), { httpClient: adt, log: (m) => logged.push(m) });
    await conn.connect();

    const before = adt.labels.length;
    // The assertion that matters: this must resolve with the caller's own
    // successful result, not throw — a throw here would be exactly the
    // masked-success/double-write hazard this guard exists to prevent.
    const result = await conn.withStatefulSession(async (session) => {
      await session.lock(PROG_URI);
      return "WRITE_SUCCEEDED";
    });
    expect(result).toBe("WRITE_SUCCEEDED");

    // The leak WAS recorded (session.ts's own classifier won that race).
    expect(conn.lastLeakedLock).toBeDefined();

    // The connection-level classifier ALSO recorded a death — the
    // disagreement this test exists to reproduce actually happened, not
    // merely "the guard swallowed something, who knows what".
    expect(conn.isDead).toBe(true);
    expect(conn.deathRecord?.reason).toContain("ICMENOSESSION");

    // dropSession()'s own signature GET must NOT appear: `assertUsable()`
    // throws before `this.lock.runExclusive` — and therefore before
    // `this.client.dropSession()` — ever runs, so there is nothing to swallow
    // downstream of that throw; the guard added in connection.ts around this
    // call is what stops the throw from escaping `withStatefulSession()`.
    const after = adt.labels.slice(before);
    expect(after).not.toContain("GET /sap/bc/adt/compatibility/graph");

    // And the swallow was logged, not silent.
    expect(logged.some((l) => l.includes("post-leak dropSession() itself failed"))).toBe(true);
  });
});

describe("lastWireActivityMs", () => {
  it("is 0 before anything has come back, then tracks each completed response", async () => {
    const c = clock();
    const adt = new FakeAdt((r) => baseRoute(r) ?? GENERIC_OK());
    const conn = tracked(writableCfg(), { httpClient: adt, log: () => {}, now: c.now });

    expect(conn.lastWireActivityMs).toBe(0);

    await conn.connect();
    expect(conn.lastWireActivityMs).toBe(1_000_000);

    c.advance(30_000);
    await conn.get("/sap/bc/adt/discovery");
    expect(conn.lastWireActivityMs).toBe(1_030_000);
  });

  it("is stamped by a FAILING response too — SAP answering is the liveness signal", async () => {
    const c = clock();
    const { conn } = await connected(() => resp(404, "not found", OK_TEXT), { now: c.now });
    c.advance(7_000);

    // `AdtHTTP._request` raises for a 404, so the caller sees a rejection —
    // but the remote demonstrably answered, which is exactly what liveness is.
    await expect(conn.get("/sap/bc/adt/programs/programs/nosuch")).rejects.toThrow();

    expect(conn.lastWireActivityMs).toBe(1_007_000);
    expect(conn.isDead).toBe(false);
  });

  it("is NOT stamped by a request that never got an answer", async () => {
    const c = clock();
    const { conn } = await connected(GENERIC_OK, { now: c.now });
    const afterConnect = conn.lastWireActivityMs;

    c.advance(60_000);
    // A bare network error: no `.response`, so nothing was learned about the
    // remote. Treating it as liveness would be a lie; treating it as death
    // would poison the connection on a blip.
    const adt2 = new FakeAdt((r) => baseRoute(r) ?? new Thrown(new Error("ECONNRESET")));
    const conn2 = tracked(writableCfg(), { httpClient: adt2, log: () => {}, now: c.now });
    await conn2.connect();
    const stamp = conn2.lastWireActivityMs;
    c.advance(60_000);
    await conn2.get("/sap/bc/adt/x").catch(() => undefined);

    expect(conn2.lastWireActivityMs).toBe(stamp);
    expect(conn2.isDead).toBe(false);
    expect(conn.lastWireActivityMs).toBe(afterConnect);
  });

  it("is not stamped when the breaker refuses the request before the wire", async () => {
    // ### Why this test does not pre-trip the breaker
    //
    // It used to: `breaker.trip(...)` before `connect()`, then assert
    // `lastWireActivityMs === 0` and `adt.calls === []`. Both held VACUOUSLY.
    // `connect()` throws out of `assertUsable()` in its prologue, so no request
    // is ever dispatched, `observedTransport` is never entered, and the stamp is
    // still its field initializer `0`. `toBe(0)` therefore could not tell
    // "correctly refused before the wire" apart from "the stamping code was
    // deleted". Four separate mutations were measured surviving it: deleting the
    // stamp entirely, stamping on every throw, stamping on ENTRY to
    // `observedTransport` (literally the thing the title forbids), and deleting
    // the breaker check from `assertUsable()`.
    //
    // So: latch the breaker with a REAL 401 mid-handshake, and give every wire
    // touch a distinct timestamp. The stamp is then a specific number rather
    // than the initial one, and "did not move" is a real claim.
    const c = clock();
    const breaker = new AuthCircuitBreaker();
    const adt = new FakeAdt((r) => {
      c.advance(1_000);
      if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
      return resp(401, "denied", OK_TEXT);
    });
    const conn = trackedWith(writableCfg(), { httpClient: adt, log: () => {}, now: c.now, breaker });

    await conn.connect().catch(() => undefined);

    // The logon answered at 1_001_000. The 401 that followed latched the
    // breaker, and the guard converted it into a `circuitOpenError` carrying no
    // `.response` — so it stamped nothing.
    expect(breaker.isTripped).toBe(true);
    expect(conn.lastWireActivityMs).toBe(1_001_000);
    const callsAfterLatch = adt.calls.length;

    c.advance(60_000);
    const e = await conn.get("/sap/bc/adt/discovery").then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(isAbapError(e) && e.code).toBe("AUTH_CIRCUIT_OPEN");
    const e2 = await conn.connect().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(isAbapError(e2) && e2.code).toBe("AUTH_CIRCUIT_OPEN");

    // Refused before the wire — nothing new was dispatched…
    expect(adt.calls.length).toBe(callsAfterLatch);
    // …and, the point of the test, the stamp did not move for the refusals.
    expect(conn.lastWireActivityMs).toBe(1_001_000);
  });
});

describe("isSessionDeath is wired into markDead — both outcomes of a request", () => {
  /**
   * ### Why this block is written against the THROW path
   *
   * `noteWireThrow` is not one of two equal halves. It is the ONLY
   * production-reachable death detector. `AxiosHttpClient` sets no
   * `validateStatus`, so axios' default (`>= 200 && < 300`) stands and EVERY
   * non-2xx arrives as a rejection — including both death shapes, the `400`
   * `ICMENOSESSION` and the `500` dump page. `noteWireResponse` is reached
   * directly only for a 2xx, which is never a death.
   *
   * That asymmetry is what made the old version of this block worthless. It
   * covered the 500 dump with a fake that RESOLVED the 500, i.e. exclusively
   * through a path production cannot take; an auditor mutated `noteWireThrow`
   * to ignore 5xx and the mutant survived all 2186 tests. The fake now throws
   * non-2xx by default (see {@link FakeAdt}), so the tests below traverse the
   * shipped path, and each death shape is pinned more than once — one test is
   * a single point of failure for the property that matters most here.
   */
  it("a 400 carrying x-sap-icm-err-id: ICMENOSESSION marks the connection dead (thrown, as in production)", async () => {
    const { conn } = await connected(() => resp(400, SESSION_GONE_PAGE, ICMENOSESSION_HEADERS));

    const e = await conn
      .get("/sap/bc/adt/programs/programs/zfoo")
      .then(() => undefined, (err: unknown) => err);

    // The rejection proves the fake threw rather than resolved: a resolved 400
    // would have been converted by `AdtHTTP` too, so assert the death instead —
    // and assert the SHAPE of the death, which only the classifier can produce.
    expect(e).toBeDefined();
    expect(conn.isDead).toBe(true);
    expect(conn.deathRecord?.reason).toContain("ICMENOSESSION");
    expect(conn.deathRecord?.reason).toContain("400");
  });

  it("a 500 short-dump page marks it dead through the throw path, and names the dump", async () => {
    // THE regression test for the surviving mutant. `resp(500, DUMP_PAGE)` is
    // now delivered as a rejection, so a `noteWireThrow` that drops 5xx —
    // `if (resp.status >= 500) return;` — leaves `isDead` false and this fails.
    const adt = new FakeAdt(
      (r) => baseRoute(r) ?? resp(500, DUMP_PAGE, { "content-type": "text/html" }),
    );
    const conn = tracked(writableCfg(), { httpClient: adt, log: () => {} });
    await conn.connect();

    const e = await conn
      .post("/sap/bc/adt/oo/classrun/zcl_x")
      .then(() => undefined, (err: unknown) => err);

    expect(e).toBeDefined();
    expect(conn.isDead).toBe(true);
    expect(conn.deathRecord?.reason).toMatch(/short dump/i);
    expect(conn.deathRecord?.reason).toContain("500");
  });

  it("both death shapes are seen when the transport raises the real HttpClientException", async () => {
    // Belt and braces for the two above: the exception is constructed here, by
    // hand, in the exact shape `AxiosHttpClient.js:105` constructs it, and fed
    // in through `Thrown` so the assertion does not depend on `FakeAdt`'s
    // default staying a throw. If someone reverts that default, these still
    // hold — and the two tests above go red, which is the intended alarm.
    const shapes: Array<{ what: string; response: HttpClientResponse; match: RegExp }> = [
      {
        what: "ICMENOSESSION 400",
        response: resp(400, SESSION_GONE_PAGE, ICMENOSESSION_HEADERS),
        match: /ICMENOSESSION/,
      },
      {
        what: "500 short-dump page",
        response: resp(500, DUMP_PAGE, { "content-type": "text/html" }),
        match: /short dump/i,
      },
    ];

    for (const shape of shapes) {
      const { conn } = await connected(
        (r) =>
          new Thrown(
            new HttpClientException(
              `Request failed with status code ${shape.response.status}`,
              "ERR_BAD_REQUEST",
              shape.response.status,
              undefined,
              { url: r.url },
              shape.response,
              undefined,
            ),
          ),
      );

      await conn.get("/sap/bc/adt/programs/programs/zfoo").catch(() => undefined);

      expect(conn.isDead, `${shape.what} must mark the connection dead`).toBe(true);
      expect(conn.deathRecord?.reason).toMatch(shape.match);
    }
  });

  it("a RESOLVED non-2xx is classified too — the observation point is not one-sided", async () => {
    // `noteWireResponse` is unreachable for a death in production (everything
    // non-2xx throws), but it is the function `noteWireThrow` delegates to, and
    // a transport that ever did resolve a 400 must not become a blind spot.
    // `Resolved` is the ONLY use of that escape hatch in this file.
    const { conn } = await connected(
      () => new Resolved(resp(400, SESSION_GONE_PAGE, ICMENOSESSION_HEADERS)),
    );

    await conn.get("/sap/bc/adt/programs/programs/zfoo").catch(() => undefined);

    expect(conn.isDead).toBe(true);
    expect(conn.deathRecord?.reason).toContain("ICMENOSESSION");
  });

  it("does NOT mark dead on a 200, a 404, or a 403 lock conflict", async () => {
    for (const answer of [
      resp(200, "ok", OK_TEXT),
      resp(404, "<exc:exception/>", OK_XML),
      resp(403, LOCK_CONFLICT_XML, OK_XML),
      resp(500, "<exc:exception><type id='CX_SY_ZERODIVIDE'/></exc:exception>", OK_XML),
    ]) {
      const { conn } = await connected(() => answer);
      await conn.get("/sap/bc/adt/x").catch(() => undefined);
      expect(conn.isDead, `status ${answer.status} must not mean session death`).toBe(false);
    }
  });

  it("does not mark dead on an exception with no response at all", async () => {
    const { conn } = await connected(() => new Thrown(new Error("socket hang up")));
    await conn.get("/sap/bc/adt/x").catch(() => undefined);
    expect(conn.isDead).toBe(false);
  });

  it("session death does not trip or latch the auth circuit breaker", async () => {
    // If it did, one expired session would disable the whole process — and the
    // latch is permanent and remembered per credential fingerprint.
    const breaker = new AuthCircuitBreaker();
    const { conn } = await connected(() => resp(400, SESSION_GONE_PAGE, ICMENOSESSION_HEADERS), {
      breaker,
    });

    await conn.get("/sap/bc/adt/x").catch(() => undefined);

    expect(conn.isDead).toBe(true);
    expect(breaker.isTripped).toBe(false);
    expect(breaker.state).toBe("closed");
  });
});

describe("onDead — the seam that invalidates a cached connect promise", () => {
  it("fires once, with the record, and only on the first markDead", async () => {
    const { conn } = await connected(GENERIC_OK);
    const seen: string[] = [];
    conn.onDead((r) => seen.push(r.reason));

    conn.markDead("first");
    conn.markDead("second");

    expect(seen).toEqual(["first"]);
  });

  it("unsubscribes, and a second off() evicts nobody else", async () => {
    // The old form registered ONE listener, called `off()` twice and asserted it
    // never fired. That pinned "unsubscribes" but not "idempotently": with a
    // single subscriber the second `off()` is harmless either way, because
    // `indexOf` returns -1 and even an unguarded `splice(-1, 1)` on an empty
    // array removes nothing. Two mutations were measured surviving it —
    // deleting the `done` flag, and deleting the `i >= 0` guard as well. A
    // bystander subscriber is what makes the second call observable.
    const { conn } = await connected(GENERIC_OK);
    const seen: string[] = [];
    const survivor: string[] = [];
    const off = conn.onDead((r) => seen.push(r.reason));
    conn.onDead((r) => survivor.push(r.reason));

    off();
    off();

    conn.markDead("gone");

    expect(seen).toEqual([]);
    // Kills the unguarded `splice(indexOf(fn), 1)`: with `fn` already gone,
    // `splice(-1, 1)` would eat the LAST registration, i.e. this one.
    expect(survivor).toEqual(["gone"]);
  });

  it("a doubled off() removes ONE registration, not both", async () => {
    // The same listener function registered twice, on purpose. Without the
    // `done` latch the second `off()` finds the surviving copy by identity and
    // removes it too, so the count is the assertion that bites.
    const { conn } = await connected(GENERIC_OK);
    const seen: string[] = [];
    const fn = (r: DeathRecord): void => {
      seen.push(r.reason);
    };
    const offFirst = conn.onDead(fn);
    conn.onDead(fn);

    offFirst();
    offFirst();

    conn.markDead("gone");

    expect(seen).toEqual(["gone"]);
  });

  it("a throwing listener does not break the death path", async () => {
    const logged: string[] = [];
    const adt = new FakeAdt((r) => baseRoute(r) ?? GENERIC_OK());
    const conn = tracked(writableCfg(), { httpClient: adt, log: (m) => logged.push(m) });
    await conn.connect();

    const seen: string[] = [];
    conn.onDead(() => {
      throw new Error("observer is broken");
    });
    conn.onDead((r) => seen.push(r.reason));

    expect(() => conn.markDead("gone")).not.toThrow();
    expect(conn.isDead).toBe(true);
    expect(seen).toEqual(["gone"]);
    expect(logged.join("\n")).toContain("observer is broken");
  });

  it("markDead makes a `connected`-gated caller log on again, exactly once", async () => {
    // Renamed from "models the server.ts fix". It does not model src/server.ts —
    // it never imports `createServer`, it re-implements a five-line miniature of
    // `ensureConnected()` here, and deleting the real `connection.onDead(...)`
    // wiring at src/server.ts:735 leaves this test GREEN. What actually pins
    // that wiring is `test/server-session-revival.test.ts`.
    //
    // The test is not vacuous, though, and an audit that called it so was wrong:
    // it is the only place that pins the COMPOSITION `markDead` ⇒ `connected`
    // false AND listeners fire AND `connect()` clears the death record, in the
    // order a lazy-connect caller experiences it. Measured killers: dropping
    // `connected = false` from `markDead`, emptying the listener fan-out,
    // dropping the `push` in `onDead`, and dropping `this.death = undefined`
    // from `connect()`.
    const { conn, adt } = await connected(GENERIC_OK);
    let connectPromise: Promise<unknown> | undefined = Promise.resolve(conn.info());
    conn.onDead(() => {
      connectPromise = undefined;
    });
    const ensureConnected = async (): Promise<void> => {
      if (conn.isConnected) return;
      connectPromise ??= conn.connect();
      await connectPromise;
    };

    await ensureConnected();
    const logonsBefore = conn.logonEndpointRequests;

    conn.markDead("HTTP 400: ICMENOSESSION");
    await ensureConnected();

    expect(conn.isDead).toBe(false);
    expect(conn.isConnected).toBe(true);
    expect(conn.logonEndpointRequests).toBe(logonsBefore + 1);
    expect(adt.labels.filter((l) => l.includes("/compatibility/graph"))).toHaveLength(2);
  });
});

describe("a death that lands DURING connect() is not clobbered", () => {
  /**
   * `connect()` clears `this.death`, awaits `client.login()`, and then used to
   * assign `this.connected = true` unconditionally. A `markDead()` that arrived
   * while that await was in flight — a pool reaper, a sibling holder, or the
   * observation wrapper classifying the logon exchange itself — set
   * `connected = false` and was then overwritten two lines later.
   *
   * The wreckage is a connection that is simultaneously `isDead` and
   * `isConnected`: the ONE state this class must never be in. It presents as a
   * healthy session that has never actually logged on. `assertUsable()` throws
   * `SESSION_DEAD` on every request, `isConnected` keeps answering yes so no
   * supervisor reconnects, and `connect()`'s own `if (this.connected) return`
   * short-circuit means no caller can revive it either. Permanent, silent, and
   * indistinguishable from a working connection to anything that asks.
   */
  const dyingDuringLogin = (
    reason: string,
  ): { conn: AbapConnection; adt: FakeAdt } => {
    let conn: AbapConnection | undefined;
    const adt = new FakeAdt((r) => {
      if (r.url.includes("/compatibility/graph")) {
        // Synchronously inside the request the `login()` await is parked on, so
        // the death is recorded strictly between "logon dispatched" and
        // "`connect()` resumes" — the exact window.
        conn?.markDead(reason);
      }
      return baseRoute(r) ?? GENERIC_OK();
    });
    conn = tracked(writableCfg(), { httpClient: adt, log: () => {} });
    return { conn, adt };
  };

  it("never reports isDead and isConnected at the same time", async () => {
    const { conn } = dyingDuringLogin("reaped while logging on");

    await conn.connect().catch(() => undefined);

    expect(conn.isDead).toBe(true);
    // The assertion that failed before the fix: `connected = true` ran anyway.
    expect(conn.isConnected).toBe(false);
    expect(conn.info().connected).toBe(false);
    expect(conn.deathRecord?.reason).toBe("reaped while logging on");
  });

  it("fails the connect with SESSION_DEAD rather than handing back a corpse", async () => {
    const { conn } = dyingDuringLogin("HTTP 400: ICMENOSESSION");

    const e = await conn.connect().then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(isAbapError(e)).toBe(true);
    expect(isAbapError(e) && e.code).toBe("SESSION_DEAD");
    expect(isAbapError(e) && e.message).toContain("ICMENOSESSION");
  });

  it("stops before the discovery probe — no work is done on a session known to be gone", async () => {
    const { conn, adt } = dyingDuringLogin("session gone mid-logon");

    await conn.connect().catch(() => undefined);

    // The logon went out (it is what raced), but nothing after it did.
    expect(adt.labels.filter((l) => l.includes("/compatibility/graph"))).toHaveLength(1);
    expect(adt.labels.filter((l) => l.endsWith("/discovery"))).toEqual([]);
    expect(adt.labels.filter((l) => l.includes("/datapreview/freestyle"))).toEqual([]);
  });

  it("is not a dead end — the next connect() clears the record and succeeds", async () => {
    // Refusing the connect must not be terminal, or the fix would trade a
    // silent zombie for a permanent brick. `connect()` clears `this.death`
    // first, so a caller that simply asks again gets a real logon.
    let dying = true;
    let conn: AbapConnection | undefined;
    const adt = new FakeAdt((r) => {
      if (dying && r.url.includes("/compatibility/graph")) conn?.markDead("first attempt raced");
      return baseRoute(r) ?? GENERIC_OK();
    });
    conn = tracked(writableCfg(), { httpClient: adt, log: () => {} });

    await expect(conn.connect()).rejects.toThrow();
    expect(conn.isConnected).toBe(false);

    dying = false;
    await conn.connect();

    expect(conn.isDead).toBe(false);
    expect(conn.deathRecord).toBeUndefined();
    expect(conn.isConnected).toBe(true);
    expect(conn.logonEndpointRequests).toBe(2);
  });

  it("a clean connect is unaffected — connected goes true exactly as before", async () => {
    // The guard is `if (this.death)`, so it must be invisible when nothing died.
    const { conn } = await connected(GENERIC_OK);
    expect(conn.isConnected).toBe(true);
    expect(conn.isDead).toBe(false);
    expect(conn.logonEndpointRequests).toBe(1);
  });
});

describe("connect() revives a dead connection — and cannot become a logon storm", () => {
  it("clears the death record and logs on again", async () => {
    const { conn } = await connected(GENERIC_OK);
    expect(conn.logonEndpointRequests).toBe(1);

    conn.markDead("session gone");
    expect(conn.isDead).toBe(true);

    await conn.connect();

    expect(conn.isDead).toBe(false);
    expect(conn.deathRecord).toBeUndefined();
    expect(conn.isConnected).toBe(true);
    expect(conn.logonEndpointRequests).toBe(2);
  });

  it("connect() on a LIVE connection still costs nothing — the early return is intact", async () => {
    const { conn } = await connected(GENERIC_OK);
    const before = conn.requestCount;
    await conn.connect();
    expect(conn.requestCount).toBe(before);
    expect(conn.logonEndpointRequests).toBe(1);
  });

  it("a latched breaker refuses the revival before a single byte leaves", async () => {
    // `login/fails_to_user_lock` is a SHARED counter on SAP, so this is the
    // bound that matters: the auth latch trips on the FIRST auth failure, is
    // one-way, and gates pre-network. A revival loop on bad credentials
    // therefore costs at most one logon attempt, ever.
    const breaker = new AuthCircuitBreaker();
    const { conn, adt } = await connected(GENERIC_OK, { breaker });
    conn.markDead("session gone");
    breaker.trip("http-401", "bad credentials");
    const before = adt.calls.length;

    const e = await conn.connect().then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(isAbapError(e) && e.code).toBe("AUTH_CIRCUIT_OPEN");
    expect(adt.calls.length).toBe(before);
    // Still dead. The death record is now cleared only once a replacement
    // session provably exists, and this revival never got a byte out — so
    // nothing was repaired and nothing looks repaired. (F1a: the old pre-lock
    // clear made a corpse report `isDead === false` to every concurrent
    // caller, which is exactly the state this assertion used to enshrine.)
    expect(conn.isDead).toBe(true);
  });

  it("the per-connection logon ceiling bounds repeated revivals, locally", async () => {
    // The third bound: `connect()`'s login runs with no RequestBudget, so
    // `noteWireRequest()` applies LOGON_ENDPOINT_LIFETIME_CEILING (5). The 6th
    // is refused BEFORE dispatch, so it never reaches the wire.
    const { conn, adt } = await connected(GENERIC_OK);
    expect(conn.logonEndpointRequests).toBe(1);

    for (let i = 0; i < 4; i++) {
      conn.markDead(`death ${i}`);
      await conn.connect();
    }
    expect(conn.logonEndpointRequests).toBe(5);

    conn.markDead("one death too many");
    const requestsBefore = conn.requestCount;
    const graphBefore = adt.labels.filter((l) => l.includes("/compatibility/graph")).length;

    await expect(conn.connect()).rejects.toThrow();

    expect(conn.requestCount).toBe(requestsBefore);
    expect(adt.labels.filter((l) => l.includes("/compatibility/graph"))).toHaveLength(graphBefore);
  });
});
