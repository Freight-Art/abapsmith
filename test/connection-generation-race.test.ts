/**
 * Liveness across a reconnect: the window between "we decided to revive" and
 * "we are actually revived".
 *
 * ## Why this file exists
 *
 * `AbapConnection.death` is the connection's single liveness fact. It is SET in
 * exactly one place (`markDead`, connection.ts:1229, driven from `noteWireThrow`)
 * and CLEARED in exactly one place — `connection.ts:1718`, the first statement
 * of `connect()`. That clear sits FOURTEEN LINES ABOVE the mutex the reconnect
 * actually runs under (`this.lock.runExclusive("connect", ...)`, :1119), and
 * nothing re-establishes it if the revival then fails: the catch at :1170 throws
 * `AUTH_FAILED` and leaves `death === undefined` forever.
 *
 * So for the whole duration of a reconnect — the logon round trip, plus however
 * long the caller waited for the session lock, bounded by
 * `sessionWaitMs + timeoutMs` = 70 s with the shipped defaults — the connection
 * reports itself ALIVE while being neither dead nor connected. `assertUsable()`
 * (:1037) is the only admission control on `get`/`put`/`post`/`del` and
 * `withStatefulSession()`, and it consults exactly that erased field. Every
 * concurrent caller in that window is waved through.
 *
 * There is a second, opposite-direction hole with the same root cause: because
 * `markDead` carries no notion of WHICH session died, a rejection belonging to
 * the corpse can land after the successor is already live and kill it too.
 *
 * The existing suite gets close but never crosses the line.
 * `test/session-lock-wiring.test.ts:425` runs two concurrent `connect()` calls
 * but on a HEALTHY connection, so the death field is never in play.
 * `test/connection-liveness.test.ts:844-943` lands a death during `connect()`
 * but with a single caller, so nothing observes the erased field.
 * `test/connection-death-wire.test.ts` has the honest harness — real
 * `AdtHTTP`, real `GuardedHttpClient`, `FakeAdtServer` in `transportErrors:
 * "throw"` mode — but only one request at a time.
 *
 * This file combines the two: the honest transport stack, plus genuine
 * concurrency, plus death that arrives from inside a REAL rejected request
 * rather than from a hand-called `markDead()`. Every gate below is a promise
 * the test resolves; nothing here depends on a `setTimeout` winning a race.
 *
 * Entirely offline. Nothing here addresses a real SAP system.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FakeAdtServer,
  PENDING,
  __resetFakeAdtCounters,
  fakeResponse,
  flushMicrotasks,
  sessionTimedOut400,
  settledOrPending,
  type FakeRoute,
} from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SessionLock } from "../src/adt/session-lock.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError } from "../src/adt/errors.js";

// ------------------------------------------------------------------ fixtures ---

/** The logon endpoint `abap-adt-api` uses; `AdtHTTP.login()` GETs exactly this. */
const LOGON_PATH = "/sap/bc/adt/compatibility/graph";

/** A URI that answers with the ICM's session-expiry page — i.e. kills the connection. */
const KILL_URI = "/sap/bc/adt/programs/programs/zmcp_kill_rep";

/** An ordinary, healthy URI used to ask "would this request have been let through?". */
const PROBE_URI = "/sap/bc/adt/programs/programs/zmcp_probe_rep";

/** A second healthy URI, used for the request that is left in flight across a reconnect. */
const STALE_URI = "/sap/bc/adt/programs/programs/zmcp_stale_rep";

/**
 * The system-role non-productive probe, answered as a ROUTE (these servers carry no
 * `catchAll`, so an unrouted probe would be recorded as a violation). It must
 * keep answering after a revival logon, because `connect()` re-runs the probe
 * on every logon.
 */
const systemRoleRoute: FakeRoute = (r) =>
  r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined;

/** The passive-expiry shape: `400` + `x-sap-icm-err-id: ICMENOSESSION`, raised as axios raises it. */
const killRoute: FakeRoute = (r) => (r.path === KILL_URI ? sessionTimedOut400() : undefined);

const OK_XML = { "content-type": "application/xml" } as const;

const healthyRoute: FakeRoute = (r) =>
  r.path === PROBE_URI || r.path === STALE_URI ? fakeResponse(200, "<ok/>", { ...OK_XML }) : undefined;

/** An ordinary application 500 — an `exc:exception`, emphatically NOT a short dump, so it must not kill. */
const APP_ERROR_500 = () =>
  fakeResponse(500, "<exc:exception><type id='CX_SY_ZERODIVIDE'/></exc:exception>", { ...OK_XML });

/** The Atom service document `Discovery.load()` fetches. */
const DISCOVERY_PATH = "/sap/bc/adt/discovery";

/**
 * The other captured death shape, and the nastier one: a **`200`** carrying
 * `x-sap-icm-err-id: ICMENOSESSION`.
 *
 * `classifySessionFailure`'s header tier is status-ungated on purpose
 * (`src/adt/session.ts`), and `abap-adt-api` only throws on `status >= 400`, so
 * this is a session death that arrives on a RESOLVED response — no rejection
 * anywhere for a caller to notice. `AdtHTTP` never inspects response headers,
 * which is why it can also be served as the answer to a logon.
 */
const icmDeath200 = (extraHeaders: Record<string, string> = {}) =>
  fakeResponse(200, "<ok/>", {
    ...OK_XML,
    "x-sap-icm-err-id": "ICMENOSESSION",
    ...extraHeaders,
  });

/** A logon answer that RESOLVES (and mints a usable token) while reporting the session gone. */
const logonWithDeadSession = () => icmDeath200({ "x-csrf-token": "FAKE_CSRF_0001" });

/** Drain microtasks until `pred` holds, or fail with `label` rather than hang. */
async function until(pred: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200 && !pred(); i++) await flushMicrotasks(20);
  if (!pred()) throw new Error(`timed out waiting for: ${label}`);
}

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    // Client 001 -> CCCATEGORY "C", so the probe can PROVE non-productive
    // rather than fail closed and force readOnly back on.
    client: "001",
    readOnly: false,
  });

// ----------------------------------------------------------------- lifecycle ---

const openConnections: AbapConnection[] = [];

const listenerCounts = (): Record<string, number> => ({
  SIGINT: process.listenerCount("SIGINT"),
  SIGTERM: process.listenerCount("SIGTERM"),
  beforeExit: process.listenerCount("beforeExit"),
});

let listenersBefore = listenerCounts();

beforeEach(() => {
  __resetFakeAdtCounters();
  listenersBefore = listenerCounts();
});

afterEach(() => {
  for (const conn of openConnections.splice(0)) conn.dispose();
  expect(listenerCounts()).toEqual(listenersBefore);
});

/**
 * A `FakeAdtServer` + `AbapConnection` pair wired the way production wires
 * them: the fake is the LOWEST layer only, so `ADTClient`, `AdtHTTP`, the
 * `GuardedHttpClient` and the `SessionLock` above it are all the real ones, and
 * non-2xx responses are RAISED exactly as axios raises them.
 */
function wire(options: { routes?: readonly FakeRoute[]; sessionLock?: SessionLock } = {}): {
  conn: AbapConnection;
  server: FakeAdtServer;
} {
  const server = new FakeAdtServer({
    transportErrors: "throw",
    routes: [systemRoleRoute, killRoute, healthyRoute, ...(options.routes ?? [])],
  });
  const conn = new AbapConnection(cfg(), {
    httpClient: server.client("s1"),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
    ...(options.sessionLock ? { sessionLock: options.sessionLock } : {}),
  });
  openConnections.push(conn);
  return { conn, server };
}

/** Connect, then kill the connection from inside a REAL rejected request. Never calls `markDead()`. */
async function connectedThenKilled(
  options: { routes?: readonly FakeRoute[]; sessionLock?: SessionLock } = {},
): Promise<{ conn: AbapConnection; server: FakeAdtServer }> {
  const wired = wire(options);
  await wired.conn.connect();
  await wired.conn.get(KILL_URI).catch(() => undefined);
  // Sanity: the death under test is a wire fact, not a test fiction.
  expect(wired.conn.isDead).toBe(true);
  expect(wired.conn.deathRecord?.reason ?? "").toContain("ICMENOSESSION");
  return wired;
}

/** Turn a settled-or-pending outcome into a single readable verdict string. */
const verdictOf = (outcome: unknown): string => {
  if (outcome === PENDING) return "admitted-and-queued";
  if (isAbapError(outcome)) return outcome.code;
  if (outcome instanceof Error) return `threw:${outcome.constructor.name}`;
  return `dispatched:${String(outcome)}`;
};

// ===========================================================================

describe("the reconnect window — death cleared 14 lines above the mutex", () => {
  /**
   * PINS: connection.ts:1718 clears `this.death` BEFORE `connect()` has taken
   * the session lock (:1119) and long before the replacement session exists
   * (:1210). A concurrent caller's `assertUsable()` (:1037) therefore sees
   * `death === undefined` and admits a request onto a connection that is dead
   * and has not been revived.
   *
   * Caller A is parked INSIDE the reconnect on a gate the test owns, so there
   * is no timing race: when the assertion runs, the revival is provably still
   * in flight.
   */
  it("refuses a concurrent request while the reconnect is still in flight", async () => {
    const { conn, server } = await connectedThenKilled();

    const logonGate = server.hold((r) => r.path.includes(LOGON_PATH));
    const reconnect = conn.connect().then(
      () => "connected",
      (e: unknown) => e,
    );
    // Caller A is now inside connect(): `death` has been cleared, the logon is
    // on the wire, and no fresh session exists yet.
    await logonGate.arrived;

    // Caller B arrives. `get()` calls assertUsable() as its very first
    // statement with no preceding await, so a correctly-refused request
    // rejects within microtasks; an ADMITTED one instead queues behind the
    // reconnect and is still pending here.
    const admitted = conn.get(PROBE_URI).then(
      () => "dispatched",
      (e: unknown) => e,
    );
    const outcome = await settledOrPending(admitted);

    expect(verdictOf(outcome)).toBe("SESSION_DEAD");
    expect(server.callsFor(PROBE_URI).length).toBe(0);

    logonGate.release();
    await reconnect;
    await admitted;
  }, 10_000);

  /**
   * PINS: the terminal variant of the death-clear race pinned above. When the revival's `client.login()`
   * (connection.ts:1622) fails, the catch at :1623-1690 throws a classified
   * error (`SYSTEM_UNAVAILABLE` for the 500 fixture below, per
   * `classifyConnectFailure` — before that classifier existed this was
   * hardcoded `AUTH_FAILED` regardless of cause) and NEVER restores the death record
   * cleared at :1105. `isDead` is then permanently `false` on a connection
   * that is dead, has no session, and will never regain one — the liveness
   * fact is not just briefly wrong, it is destroyed. The exact CODE is
   * incidental to what this test pins (the death record survives ANY
   * revival failure); what matters here is picking a fixture that is
   * unambiguously not a credential rejection.
   *
   * The logon is failed with an ordinary application 500 (`exc:exception`)
   * rather than a 401, deliberately: a 401 would latch the auth circuit
   * breaker and `assertUsable()` would then refuse for a completely
   * different reason, masking the defect under test. With `classifyConnectFailure`
   * in place, that same 500 fixture also exercises its system-down path,
   * which is why the assertion below is `SYSTEM_UNAVAILABLE`, not
   * `AUTH_FAILED` — a 500 during logon is the system refusing everyone, not
   * a rejected credential.
   */
  it("does not erase the death record when the revival logon fails", async () => {
    const { conn, server } = await connectedThenKilled();

    const logonGate = server.hold((r) => r.path.includes(LOGON_PATH));
    const reconnect = conn.connect().then(
      () => "connected",
      (e: unknown) => e,
    );
    await logonGate.arrived;
    logonGate.releaseWith(APP_ERROR_500());

    const failure = await reconnect;
    expect(isAbapError(failure) && failure.code).toBe("SYSTEM_UNAVAILABLE");

    // The revival failed, so the connection is exactly as dead as it was.
    expect(conn.isDead).toBe(true);
    expect(conn.isConnected).toBe(false);
    expect(conn.deathRecord?.reason ?? "").toContain("ICMENOSESSION");

    // ...and it must still refuse work with a typed error, without touching the wire.
    const after = await conn.get(PROBE_URI).then(
      () => "dispatched",
      (e: unknown) => e,
    );
    expect(verdictOf(after)).toBe("SESSION_DEAD");
    expect(server.callsFor(PROBE_URI).length).toBe(0);
  }, 10_000);
});

describe("the corpse and its successor — a death has no generation", () => {
  /**
   * PINS: `markDead()` (connection.ts:1229) records a death with no notion of
   * WHICH session died, and `noteWireThrow` (:1029) calls it for any rejected
   * request regardless of when that request was issued. A rejection belonging
   * to the session that already died therefore kills the session that
   * REPLACED it — the successor is executed for the corpse's crime, and
   * `markDead`'s idempotence guard (:901) makes it unrecoverable without
   * another full `connect()`.
   *
   * The stale request is issued inside a `runExclusive` window, which is how
   * `connect()` and `withStatefulSession()` themselves run: implicit acquires
   * made inside such a window are re-entrant and take NO hold
   * (`session-lock.ts` `acquireImplicit`). That is precisely how a request can
   * still be on the wire while a later `connect()` acquires the lock, and it
   * is the only way to reach this state through the public API.
   */
  it("does not let a rejection from the dead session kill the fresh one", async () => {
    const lock = new SessionLock();
    const { conn, server } = wire({ sessionLock: lock });
    await conn.connect();

    // Put a request on the wire that holds no lock, then leave it there.
    const staleGate = server.hold((r) => r.path === STALE_URI);
    let stale!: Promise<unknown>;
    await lock.runExclusive("test-window", async () => {
      stale = conn.get(STALE_URI).then(
        () => "resolved",
        (e: unknown) => e,
      );
      await staleGate.arrived;
    });

    // Generation 1 dies from a real rejected request...
    await conn.get(KILL_URI).catch(() => undefined);
    expect(conn.isDead).toBe(true);

    // ...and generation 2 replaces it, successfully.
    await conn.connect();
    expect(conn.isDead).toBe(false);
    expect(conn.isConnected).toBe(true);

    // Now the corpse's request finally answers, with the same 400 ICMENOSESSION
    // that killed generation 1. It says nothing whatsoever about generation 2.
    staleGate.releaseWith(sessionTimedOut400());
    await stale;

    expect(conn.isDead).toBe(false);
    expect(conn.deathRecord).toBeUndefined();

    const after = await conn.get(PROBE_URI).then(
      (r) => r.status,
      (e: unknown) => e,
    );
    expect(after).toBe(200);
  }, 10_000);
});

describe("per-request budgets — activeBudget is a single field, request() is not serialised", () => {
  /**
   * PINS: connection.ts:1990-1995. `request()` stores its `RequestBudget` in
   * the instance field `this.activeBudget` and restores the previous value in a
   * `finally`, but `request()` itself is NOT serialised — only its individual
   * wire DISPATCHES are, by `acquireImplicit` (:735). Two overlapping
   * `request()` calls therefore clobber each other: whichever ran its
   * synchronous head last owns the field, so the FIRST request's logon is
   * charged to the SECOND request's budget (:848), and when either one
   * finishes it restores `outer` and drops the survivor's budget on the floor,
   * leaving it running unbudgeted on the lifetime-ceiling path (:854).
   *
   * The externally visible symptom is misattribution: `RequestBudget.exceeded`
   * (:447) names the URL of the budget that was charged, so a request gets
   * refused with an error naming a DIFFERENT request's URL. The connection is
   * left logged out (fresh instance, `csrfToken === "fetch"`), so both requests
   * enter `attempt()` needing a logon; `AdtHTTP.login()` memoises, so exactly
   * one logon reaches the wire and exactly one budget can legitimately be
   * charged for it.
   *
   * NOTE: `noteWireRequest`'s refusal is thrown from inside
   * `AdtHTTP._request`'s try, which rewrites any non-`AdtException` into an
   * `AdtErrorException` (see connection.ts:1176-1195). The `AbapError` does NOT
   * survive to the caller, so this asserts on the message text, never on
   * `instanceof`.
   */
  it("charges a request's logon to that request's own budget", async () => {
    const A_URL = `${LOGON_PATH}?probe=A`;
    const B_URL = `${LOGON_PATH}?probe=B`;
    const { conn } = wire();

    // Deliberately NOT connected: both requests must acquire a logon, which is
    // the only cost `RequestBudget` meters.
    const [ra, rb] = await Promise.all([
      conn.get(A_URL).then(
        () => "resolved",
        (e: unknown) => e,
      ),
      conn.get(B_URL).then(
        () => "resolved",
        (e: unknown) => e,
      ),
    ]);

    const REFUSAL = /for a single request to (\S+?): one logical/;
    const attribution = (outcome: unknown, ownUrl: string, otherUrl: string): string => {
      if (!(outcome instanceof Error)) return "no-refusal";
      const m = REFUSAL.exec(outcome.message);
      if (!m) return "no-refusal";
      if (m[1] === ownUrl) return "own";
      if (m[1] === otherUrl) return "other-request's-budget";
      return `unexpected:${m[1] ?? ""}`;
    };

    const misattributed = [
      { request: "A", charged: attribution(ra, A_URL, B_URL) },
      { request: "B", charged: attribution(rb, B_URL, A_URL) },
    ].filter((v) => v.charged !== "own" && v.charged !== "no-refusal");

    expect(misattributed).toEqual([]);
  }, 10_000);
});

// ===========================================================================

describe("connect()'s tail (F1a) — the death record is cleared before two more probes run", () => {
  /**
   * PINS: `connectUnderLock()` clears `death` and sets `connected = true`, and
   * only THEN runs `discovery.load()` and `detectSystemRole()`. Neither has to
   * throw to kill the session: a `200` carrying
   * `x-sap-icm-err-id: ICMENOSESSION` classifies as a death on the RESOLVED
   * path, and both probes swallow failures by design (discovery is non-fatal,
   * the role probe fails closed to `inconclusive`).
   *
   * Without the closing check, `connect()` RESOLVES while leaving
   * `isDead === true` and `connected === false`. `ensureConnected()` in
   * `src/server.ts` reads a resolved `connect()` as "there is a session",
   * applies its safety verdict, returns — and the tool then throws
   * `SESSION_DEAD` at `assertUsable()`. A burnt call, and the exact opposite of
   * this fix's contract that the record is cleared only once a replacement
   * session provably exists.
   */
  it("does not resolve when the session dies during the discovery probe", async () => {
    const { conn, server } = wire();

    const discoveryGate = server.hold((r) => r.path.endsWith(DISCOVERY_PATH));
    const connected = conn.connect().then(
      () => "resolved",
      (e: unknown) => e,
    );
    await discoveryGate.arrived;
    discoveryGate.releaseWith(icmDeath200());

    expect(verdictOf(await connected)).toBe("SESSION_DEAD");
    expect(conn.isDead).toBe(true);
    expect(conn.isConnected).toBe(false);
    // The record is the one the wire produced, not a fabrication of the tail.
    expect(conn.deathRecord?.reason ?? "").toContain("ICMENOSESSION");
  }, 10_000);

  /** The same defect with the other victim: the system-role probe. */
  it("does not resolve when the session dies during the system-role probe", async () => {
    const { conn, server } = wire();

    const probeGate = server.hold((r) => r.path.includes(DATA_PREVIEW_PATH));
    const connected = conn.connect().then(
      () => "resolved",
      (e: unknown) => e,
    );
    await probeGate.arrived;
    probeGate.releaseWith(icmDeath200());

    expect(verdictOf(await connected)).toBe("SESSION_DEAD");
    expect(conn.isDead).toBe(true);
    expect(conn.isConnected).toBe(false);
  }, 10_000);

  /**
   * The other half of the contract: a connect whose tail is healthy must still
   * resolve, and must not be turned into a failure by a death record belonging
   * to the generation it just replaced.
   */
  it("still resolves normally when the tail is healthy", async () => {
    const { conn } = await connectedThenKilled();
    const info = await conn.connect();
    expect(info.connected).toBe(true);
    expect(conn.isDead).toBe(false);
    expect(info.generation).toBe(2);
  }, 10_000);
});

describe("the revival's own logon (F1b) — an older record must not swallow the new death", () => {
  /**
   * PINS the generation-scoped idempotency guard in `markDead()`:
   *
   *     if (this.death && this.deathGeneration >= this.currentGeneration) return;
   *
   * Reverting that scope to a plain `if (this.death) return;` leaves all 2561
   * tests passing, because no test drives a death during a revival's own logon
   * WHILE an older death record still exists. This is that test.
   *
   * Generation 1 dies from a real `400`. The revival advances to generation 2
   * and SAP answers its logon `200` — so `login()` resolves — with the ICM
   * session-gone header. That death belongs to generation 2 and must overwrite
   * the generation-1 corpse, so the re-check after `login()` sees it and fails
   * the connect. With an unscoped idempotency guard the generation-1 record
   * swallows it, `deathGeneration` stays 1, the re-check compares `1 >= 2` and
   * passes, and `connect()` writes `connected = true` over a session that died
   * during its own logon.
   */
  it("fails the connect when the logon's own answer reports the session gone", async () => {
    const { conn, server } = await connectedThenKilled();

    const logonGate = server.hold((r) => r.path.includes(LOGON_PATH));
    const revival = conn.connect().then(
      () => "resolved",
      (e: unknown) => e,
    );
    await logonGate.arrived;
    logonGate.releaseWith(logonWithDeadSession());

    expect(verdictOf(await revival)).toBe("SESSION_DEAD");
    expect(conn.isDead).toBe(true);
    expect(conn.isConnected).toBe(false);
    // The death recorded is generation 2's, so a subsequent connect() is not
    // blocked by it — the connection is failed, not bricked.
    expect(conn.staleDeathAnomalies).toBe(0);
  }, 10_000);
});

describe("the dispatch instant (F1b) — a request parked on the session mutex", () => {
  /**
   * PINS `noteWireRequest()` as the stamping point.
   *
   * Moving the stamp up into `observedTransport.request` — where the ticket is
   * created — survives the whole suite, because the existing stale-request test
   * parks its request on the FAKE's gate, which lives inside `inner.request()`
   * and therefore AFTER `noteWireRequest`: entry-stamp and dispatch-stamp are
   * both generation 1 there.
   *
   * The distinguishing case is a request parked on the GUARD's session mutex —
   * `GuardedHttpClient` awaits `acquire()` for up to `sessionWaitMs +
   * timeoutMs` before dispatching — across a legitimate reconnect. Stamped at
   * entry it carries generation 1 and its GENUINE death of the generation-2
   * session is discarded as a corpse's late answer: the catastrophic direction.
   *
   * The parked request is created OUTSIDE the exclusive window, so its
   * continuation carries the outer async context, holds no re-entrancy token,
   * and must queue on the mutex like any stranger.
   */
  it("stamps the generation at dispatch, not at entry, so a reconnect cannot orphan it", async () => {
    const lock = new SessionLock();
    const { conn } = wire({ sessionLock: lock });
    await conn.connect();
    expect(conn.generation).toBe(1);

    let fire!: () => void;
    const trigger = new Promise<void>((resolve) => {
      fire = resolve;
    });
    // Registered here, in the root context: when it runs it is a stranger to
    // any hold taken below.
    const parked = trigger.then(() => conn.get(KILL_URI)).then(
      () => "resolved",
      (e: unknown) => e,
    );

    await lock.runExclusive("test-window", async () => {
      fire();
      await until(() => lock.queueDepth > 0, "the parked request to reach the session mutex");

      // Generation 1 dies from a real rejected request (re-entrant, so it
      // dispatches straight past the parked one)...
      await conn.get(KILL_URI).catch(() => undefined);
      expect(conn.isDead).toBe(true);

      // ...and generation 2 replaces it, all while the parked request has still
      // never been dispatched.
      await conn.connect();
      expect(conn.isConnected).toBe(true);
      expect(conn.generation).toBe(2);
    });

    // Released, dispatched under generation 2, answered with a genuine
    // ICMENOSESSION `400`. That is generation 2's death and it must count.
    await parked;
    expect({
      isDead: conn.isDead,
      staleDropped: conn.staleDeathReports,
      anomalies: conn.staleDeathAnomalies,
    }).toEqual({ isDead: true, staleDropped: 0, anomalies: 0 });
    expect(conn.deathRecord?.reason ?? "").toContain("ICMENOSESSION");
  }, 10_000);
});

describe("staleDeathReports is a counter, staleDeathAnomalies is the signal", () => {
  /**
   * The benign interleaving, which the original comment on `staleDeathCount`
   * denied could happen ("zero on a healthy system"). A request from the corpse
   * answers after its successor is live: the DROP is correct, and it duplicates
   * a death already recorded for that very generation, so nothing was lost and
   * nothing should be announced.
   */
  it("classifies a corpse's late answer as a duplicate, not an anomaly", async () => {
    const lines: string[] = [];
    const lock = new SessionLock();
    const server = new FakeAdtServer({
      transportErrors: "throw",
      routes: [systemRoleRoute, killRoute, healthyRoute],
    });
    const conn = new AbapConnection(cfg(), {
      httpClient: server.client("s1"),
      log: (m) => lines.push(m),
      sessionLock: lock,
      breaker: new AuthCircuitBreaker(),
    });
    openConnections.push(conn);
    await conn.connect();

    const staleGate = server.hold((r) => r.path === STALE_URI);
    let stale!: Promise<unknown>;
    await lock.runExclusive("test-window", async () => {
      stale = conn.get(STALE_URI).then(
        () => "resolved",
        (e: unknown) => e,
      );
      await staleGate.arrived;
    });

    await conn.get(KILL_URI).catch(() => undefined);
    await conn.connect();
    staleGate.releaseWith(sessionTimedOut400());
    await stale;

    expect({
      dropped: conn.staleDeathReports,
      duplicates: conn.staleDeathDuplicates,
      anomalies: conn.staleDeathAnomalies,
    }).toEqual({ dropped: 1, duplicates: 1, anomalies: 0 });
    // ...and it is SILENT. A line printed on healthy traffic is a line nobody
    // reads, which is what would cost the audit trail when it matters.
    expect(lines.filter((l) => l.includes("session-death report"))).toEqual([]);
    expect(conn.isDead).toBe(false);
  }, 10_000);

  /**
   * The counters have to be reachable by someone other than a unit test:
   * `generation` and `staleDeathReports` had ZERO consumers in `src/` or
   * `test/`, so the design's only defence against a swallowed death was a
   * private field and one stderr line. `info()` is the server's single rendered
   * diagnostic surface — it is serialised whole into the `abap://<SID>/system`
   * MCP resource.
   */
  it("surfaces the counters through info(), the abap://<SID>/system resource", async () => {
    const { conn } = await connectedThenKilled();
    await conn.connect();
    const info = conn.info();
    expect(info).toMatchObject({
      connected: true,
      generation: 2,
      staleDeathReports: 0,
      staleDeathAnomalies: 0,
      overlappingDispatches: 0,
    });
  }, 10_000);
});
