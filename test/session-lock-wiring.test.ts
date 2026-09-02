/**
 * `SessionLock` wired into `AbapConnection`.
 *
 * `src/adt/session-lock.ts` shipped implemented, tested and with ZERO callers in
 * `src/`. This suite covers the wiring that gave it callers, at the two levels
 * it was wired at:
 *
 *   LEVEL A — `GuardedHttpClient.opts.acquire` (`src/adt/http-guard.ts:64`), so
 *             exactly one request is in flight on one ADT session at a time.
 *   LEVEL B — `runExclusive` around the four MULTI-REQUEST flows that mutate
 *             session state: `connect`, `withStatefulSession`, `dropSession`
 *             and `withFreshSession`.
 *
 * Level B is the level that actually matters, and it is the reason this file
 * exists. Corruption on an ADT session does not happen *within* one request —
 * Level A alone would be nearly pointless. It happens BETWEEN the requests of a
 * flow, and both mechanisms are captured, not theorised:
 *
 *   1. `ADTClient.stateful` is ONE MUTABLE FIELD on ONE SHARED client, sampled
 *      per dispatch by `AdtHTTP._request()` (node_modules/abap-adt-api/build/
 *      AdtHTTP.js:205, `headers[SESSION_HEADER] = this.stateful`) and written
 *      out as `X-sap-adt-sessiontype`. An unrelated request dispatched inside a
 *      stateful window silently rides out as `stateful`.
 *   2. `dropSession()` discards the `sap-contextid`. A live capture recorded
 *      what a request in flight across that looks like on the wire: `400`, header
 *      `x-sap-icm-err-id: ICMENOSESSION`, body `Session Timed Out`, and the ADT
 *      enqueue silently released.
 *
 * NO CSRF CLAIM IS MADE ANYWHERE IN THIS FILE. The live captures backing this
 * suite contain zero CSRF experiments, so "interleaving corrupts CSRF state" is not
 * capture-backed and must not be repeated as though it were.
 *
 * ## The instrument
 *
 * Most assertions here read ONE recorded field: {@link Recorded.holder} — the
 * `op` label of whoever held the session mutex at the moment the request was
 * dispatched. That single observation distinguishes all three states that
 * matter, which no counter can:
 *
 *   - `"connect"` / `"withStatefulSession"` / `"dropSession"` /
 *     `"withFreshSession"` → dispatched inside a LEVEL B window;
 *   - a request PATH (e.g. `"/sap/bc/adt/foo"`) → only LEVEL A was held, i.e.
 *     the surrounding `runExclusive` is gone;
 *   - `null` → no hold at all, i.e. LEVEL A is gone.
 *
 * Everything is offline. The transport is a fake `HttpClient` injected through
 * `ConnectionOptions.httpClient`; nothing here touches a real SAP system.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection, type ConnectionOptions } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SessionLock, SessionBusyError } from "../src/adt/session-lock.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isSystemRoleProbe, systemRoleProbeResponse } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Offline transport
// ---------------------------------------------------------------------------

interface Recorded {
  label: string;
  method: string;
  url: string;
  /** `X-sap-adt-sessiontype` as it went out — the header `_request()` stamps. */
  sessionType: string | undefined;
  /** The mutex holder's `op` at dispatch time. See the file header. */
  holder: string | null;
  /** How many requests were in flight (inclusive) when this one was dispatched. */
  inFlight: number;
}

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_XML = { "content-type": "application/xml" };
/** The login response MUST carry a token: `loggedin` is `csrfToken !== "fetch"`. */
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

/**
 * A fake transport that records, per dispatch, the three things this suite
 * reasons about: the outgoing session-type header, the mutex holder, and the
 * concurrency actually achieved.
 *
 * `route` may return a promise, which is how every gated/deferred test below
 * parks a request in flight.
 */
class RecordingAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  /** Peak observed concurrency. LEVEL A's whole job is to keep this at 1. */
  maxInFlight = 0;
  private live = 0;
  /** Set by the tests that need to read the holder; unset ⇒ holder is `null`. */
  lock: SessionLock | undefined;

  constructor(
    private readonly route: (r: Recorded, o: HttpClientOptions) => HttpClientResponse | Promise<HttpClientResponse>,
  ) {}

  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const headers = (o.headers ?? {}) as Record<string, string>;
    this.live += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.live);
    const rec: Recorded = {
      label: `${method} ${o.url}`,
      method,
      url: o.url,
      sessionType: headers["X-sap-adt-sessiontype"],
      holder: this.lock?.currentHolder()?.op ?? null,
      inFlight: this.live,
    };
    this.calls.push(rec);
    try {
      return await this.route(rec, o);
    } finally {
      this.live -= 1;
    }
  }

  get labels(): string[] {
    return this.calls.map((c) => c.label);
  }
  /** Every recorded holder label, in dispatch order. */
  get holders(): (string | null)[] {
    return this.calls.map((c) => c.holder);
  }
  find(fragment: string): Recorded | undefined {
    return this.calls.find((c) => c.url.includes(fragment));
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
 * The `connect()` preamble, answered exactly as `test/session.test.ts:baseRoute`
 * answers it — plus the system-role probe, answered `nonproductive`
 * through the shared helper.
 *
 * The probe is answered on purpose and not by accident: an unanswered probe is
 * not neutral, it is `inconclusive`, which locks writes out and would answer
 * assertions this file makes about stateful sessions with a REFUSAL rather than
 * with the mutex behaviour under test.
 */
function preamble(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (isSystemRoleProbe(r)) return systemRoleProbeResponse("nonproductive");
  return undefined;
}

// ---------------------------------------------------------------------------
// Connection lifecycle — every connection this file opens MUST be disposed
// ---------------------------------------------------------------------------

/**
 * Same canary as `test/session.test.ts`: `connect()` installs SIGINT/SIGTERM/
 * beforeExit listeners and `dispose()` removes them. Net-zero per test, so a
 * registration that loses its matching removal fails HERE rather than surfacing
 * as an anonymous `MaxListenersExceededWarning` many tests later.
 */
const openConnections: AbapConnection[] = [];

// `ConnectionOptions.breaker` is now required, and threading it through every
// call site in this file would be noise — this helper owns it, and no test
// here needs to reach the breaker it silently injects.
function tracked(opts: Omit<ConnectionOptions, "breaker">, c: Config = cfg()): AbapConnection {
  const conn = new AbapConnection(c, { breaker: new AuthCircuitBreaker(), ...opts });
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
  expect(listenerCounts()).toEqual(listenersBefore);
});

/**
 * A connected `AbapConnection` with the session mutex INJECTED, so the test can
 * read `queueDepth` / `currentHolder()` from outside.
 *
 * ⚠️ Each call builds its OWN `SessionLock`. Sharing one between two
 * connections is the exact mistake the wiring forbids (they are two SAP
 * sessions); the test that pins that is "two connections do not serialise".
 */
async function connected(
  route: (r: Recorded, o: HttpClientOptions) => HttpClientResponse | Promise<HttpClientResponse> = () =>
    resp(200, "<ok/>", OK_XML),
  lockOpts?: ConstructorParameters<typeof SessionLock>[0],
): Promise<{ conn: AbapConnection; adt: RecordingAdt; lock: SessionLock }> {
  const adt = new RecordingAdt((r, o) => preamble(r) ?? route(r, o));
  const lock = new SessionLock(lockOpts);
  adt.lock = lock;
  const conn = tracked({ httpClient: adt, log: () => {}, sessionLock: lock });
  await conn.connect();
  return { conn, adt, lock };
}

/** A promise plus its settle functions. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Let a pending request advance as far as it can — through `AbapConnection`,
 * `ADTClient`, `AdtHTTP` and into the guard's `acquire`. Several `await` hops,
 * so drain generously; every caller of this then asserts something DETERMINISTIC
 * (a queue depth, a holder label), never a timing.
 */
async function settleTurns(n = 12): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

/**
 * Runs `fn` OUTSIDE the caller's `AsyncLocalStorage` context.
 *
 * Load-bearing for every "a stranger collides with the flow" test in this file.
 * A request fired from inside a `runExclusive` callback inherits that hold's
 * token through ALS and passes straight through by re-entrancy — it is not a
 * stranger, it is the flow itself. This starts the async context at the top
 * level and only *resumes* it from inside, so the continuation carries the
 * empty store rather than the holder's.
 */
function asStranger<T>(gate: Promise<void>, fn: () => Promise<T>): Promise<T> {
  return (async () => {
    await gate;
    return fn();
  })();
}

// ---------------------------------------------------------------------------
// LEVEL A — one dispatch at a time on one ADT session
// ---------------------------------------------------------------------------

describe("LEVEL A — the guard's acquire is supplied from the connection's SessionLock", () => {
  it("serialises concurrent requests on ONE connection: peak in-flight is 1", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const { conn, adt } = await connected(async (r) => {
      const g = deferred();
      gates.set(r.url, g);
      await g.promise;
      return resp(200, "<ok/>", OK_XML);
    });
    adt.calls.length = 0;

    const all = Promise.all([conn.get("/sap/bc/adt/a"), conn.get("/sap/bc/adt/b"), conn.get("/sap/bc/adt/c")]);
    await settleTurns();

    // Only the first was even dispatched; the other two are parked in the mutex.
    expect(adt.calls.length).toBe(1);
    for (let i = 0; i < 3; i += 1) {
      const [only] = [...gates.values()].slice(-1);
      only?.resolve(undefined);
      await settleTurns();
    }
    await all;

    expect(adt.labels).toEqual([
      "GET /sap/bc/adt/a",
      "GET /sap/bc/adt/b",
      "GET /sap/bc/adt/c",
    ]);
    // THE assertion. Without `acquire`, this is 3.
    expect(adt.maxInFlight).toBe(1);
  });

  it("holds the mutex for every dispatch, so no request is ever dispatched unheld", async () => {
    const { conn, adt } = await connected();
    await conn.get("/sap/bc/adt/foo");
    // Includes the four preamble requests: `login()` and `dropSession()` are
    // issued by abap-adt-api itself and never seen by src/adt/connection.ts,
    // but they still funnel through the guard.
    expect(adt.holders.every((h) => h !== null)).toBe(true);
  });

  it("does NOT serialise two independent connections — a per-connection lock, never a global one", async () => {
    const bothIn = { count: 0 };
    const open = deferred();
    const route = async (r: Recorded): Promise<HttpClientResponse> => {
      if (!r.url.includes("/gated")) return resp(200, "<ok/>", OK_XML);
      bothIn.count += 1;
      if (bothIn.count === 2) open.resolve(undefined);
      await open.promise;
      return resp(200, "<ok/>", OK_XML);
    };
    const a = await connected(route);
    const b = await connected(route);

    // Deadlocks (and blows the timeout) if the two connections share a lock.
    await Promise.all([a.conn.get("/sap/bc/adt/gated"), b.conn.get("/sap/bc/adt/gated")]);
    expect(bothIn.count).toBe(2);
  }, 5_000);

  it("builds its OWN lock when none is injected: two DEFAULT-constructed connections do not serialise", async () => {
    // The test above cannot see this. `connected()` passes `sessionLock`, and
    // the wiring reads `opts.sessionLock ?? new SessionLock(...)` — so an
    // injected lock short-circuits the construction path entirely. Only a
    // connection built WITHOUT the option exercises it, and only that can catch
    // the one mistake that matters here: a single module-level lock shared by
    // every connection, which would serialise the whole pool down to one
    // in-flight request and silently undo it.
    const bothIn = { count: 0 };
    const open = deferred();
    const route = async (r: Recorded): Promise<HttpClientResponse> => {
      if (!r.url.includes("/gated")) return resp(200, "<ok/>", OK_XML);
      bothIn.count += 1;
      if (bothIn.count === 2) open.resolve(undefined);
      await open.promise;
      return resp(200, "<ok/>", OK_XML);
    };
    const build = async (): Promise<AbapConnection> => {
      const adt = new RecordingAdt((r, o) => preamble(r) ?? route(r, o));
      // NO `sessionLock` — this is the whole point of the test.
      const conn = tracked({ httpClient: adt, log: () => {} });
      await conn.connect();
      return conn;
    };
    const a = await build();
    const b = await build();

    // Deadlocks (and blows the timeout) if the default is one shared lock.
    await Promise.all([a.get("/sap/bc/adt/gated"), b.get("/sap/bc/adt/gated")]);
    expect(bothIn.count).toBe(2);
  }, 5_000);

  it("releases the hold when the request THROWS, not only when it resolves", async () => {
    // Production axios sets no `validateStatus` and THROWS on every non-2xx, so
    // a fake that RESOLVES a 500 would be politer than the real transport and
    // would not exercise this path at all.
    let boom = true;
    const { conn, lock } = await connected(() => {
      if (boom) throw Object.assign(new Error("kaboom"), { response: resp(500, "dump") });
      return resp(200, "<ok/>", OK_XML);
    });

    await expect(conn.get("/sap/bc/adt/explodes")).rejects.toThrow();
    expect(lock.currentHolder()).toBeNull();
    expect(lock.queueDepth).toBe(0);

    // And the session is still usable — a leaked hold would hang here.
    boom = false;
    await expect(conn.get("/sap/bc/adt/after")).resolves.toBeDefined();
  }, 5_000);

  it("labels the holder with the request PATH, never the query string", async () => {
    // `SessionBusyError.holder` is surfaced to the MCP client, and on this path a
    // query string carries `lockHandle=<a live ADT enqueue handle>` and
    // `_action=LOCK`. The path alone says what holds the session and leaks
    // nothing — that is what `opOf()` in src/adt/connection.ts is for.
    const seen: (string | null)[] = [];
    const { conn, adt } = await connected((r) => {
      seen.push(r.holder);
      return resp(200, "<ok/>", OK_XML);
    });
    adt.calls.length = 0;

    await conn.get("/sap/bc/adt/programs/programs/zfoo?lockHandle=SECRETHANDLE&_action=LOCK");

    expect(seen).toEqual(["/sap/bc/adt/programs/programs/zfoo"]);
    expect(seen.join()).not.toContain("SECRETHANDLE");
  });
});

// ---------------------------------------------------------------------------
// LEVEL B — exclusive windows around the multi-request flows
// ---------------------------------------------------------------------------

describe("LEVEL B — connect()", () => {
  it("runs the whole preamble inside ONE exclusive window", async () => {
    const { adt } = await connected();
    expect(adt.calls.length).toBeGreaterThan(1);
    expect(adt.holders).toEqual(adt.calls.map(() => "connect"));
  });

  it("two concurrent connect() calls issue the preamble ONCE", async () => {
    // `connect()` is not memoised in AbapConnection (only server.ts memoises it)
    // and `this.connected` is not set until after login() resolves, so before
    // the exclusive window both callers passed the check and both issued the
    // whole preamble — two logons against a shared login/fails_to_user_lock
    // counter. The `connected` re-check moved INSIDE the hold, so the second
    // caller re-reads it after the wait and issues zero requests.
    const adt = new RecordingAdt((r) => preamble(r) ?? resp(200, "<ok/>", OK_XML));
    const lock = new SessionLock();
    adt.lock = lock;
    const conn = tracked({ httpClient: adt, log: () => {}, sessionLock: lock });

    const [x, y] = await Promise.all([conn.connect(), conn.connect()]);

    expect(x.connected).toBe(true);
    expect(y.connected).toBe(true);
    expect(adt.calls.filter((c) => c.url.includes("/compatibility/graph")).length).toBe(1);
    expect(adt.calls.filter((c) => c.url.includes("/ato/settings")).length).toBe(1);
    expect(adt.calls.filter((c) => c.url.includes("/datapreview/freestyle")).length).toBe(1);
  }, 5_000);
});

describe("LEVEL B — withStatefulSession()", () => {
  it("is re-entrant: requests issued INSIDE the window pass straight through", async () => {
    // THE deadlock-freedom test. LEVEL B is only safe because `acquireImplicit`
    // is re-entrant via AsyncLocalStorage (session-lock invariant I3): every
    // request the callback issues finds this hold's own token in the ambient
    // token set. Lose that, and each inner request queues behind its own outer
    // hold for the full `waitTimeoutMs` (70 s at defaults) — so the explicit
    // 3 s timeout below is what turns "regression" into a RED test instead of a
    // hung CI job.
    const { conn, adt, lock } = await connected();
    adt.calls.length = 0;

    const holders = await conn.withStatefulSession(async () => {
      await conn.get("/sap/bc/adt/inner-1");
      expect(lock.queueDepth).toBe(0);
      await conn.get("/sap/bc/adt/inner-2");
      return adt.holders;
    });

    // Every inner request ran under the FLOW's hold, not under its own path
    // label — i.e. it was re-entrant, it did not take a second hold.
    expect(holders).toEqual(["withStatefulSession", "withStatefulSession"]);
    expect(lock.currentHolder()).toBeNull();
  }, 3_000);

  it("holds the mutex for the WHOLE window: a stranger queues and never rides out stateful", async () => {
    // Mechanism 1 from the file header. `AdtHTTP._request()` samples
    // `this.stateful` PER DISPATCH, so an unrelated request dispatched inside
    // the window goes out with `X-sap-adt-sessiontype: stateful` — on a session
    // whose enqueues belong to somebody else.
    const inside = deferred();
    const { conn, adt, lock } = await connected();
    adt.calls.length = 0;

    const stranger = asStranger(inside.promise, () => conn.get("/sap/bc/adt/stranger"));

    await conn.withStatefulSession(async () => {
      inside.resolve(undefined);
      await settleTurns();
      // DETERMINISTIC evidence the stranger reached the mutex and parked —
      // not merely that it happened to be slow.
      expect(lock.queueDepth).toBe(1);
      await conn.get("/sap/bc/adt/mine");
      expect(adt.find("/stranger")).toBeUndefined();
    });

    await stranger;
    expect(adt.find("/mine")?.sessionType).toBe("stateful");
    expect(adt.find("/stranger")?.sessionType).toBe("stateless");
    expect(adt.find("/stranger")?.holder).toBe("/sap/bc/adt/stranger");
  }, 5_000);

  it("does not set the stateful flag until the session is actually OWNED", async () => {
    // The flag flip must be INSIDE the hold. If it happens before the wait, the
    // window opens on a session somebody else is still using, and every request
    // they dispatch in the gap rides out stateful.
    const { conn, lock } = await connected();
    const holderDone = deferred();

    // Occupy the lock from outside, so withStatefulSession must wait for it.
    const occupied = deferred();
    const occupying = lock.runExclusive("stranger-flow", async () => {
      occupied.resolve(undefined);
      await holderDone.promise;
    });
    await occupied.promise;

    const flow = asStranger(Promise.resolve(), () => conn.withStatefulSession(async () => "done"));
    await settleTurns();

    expect(lock.currentHolder()?.op).toBe("stranger-flow");
    expect(conn.adt.stateful).toBe("stateless");

    holderDone.resolve(undefined);
    await occupying;
    await expect(flow).resolves.toBe("done");
    expect(conn.adt.stateful).toBe("stateless");
  }, 5_000);

  it("keeps the TOCTOU claim on activeSession — a second flow is refused, not queued", async () => {
    // The `if (this.activeSession) throw` check and `this.activeSession = session`
    // must stay adjacent with NO `await` between them. Taking the mutex first
    // would insert exactly the yield point that guard exists to avoid, and the
    // symptom would be that a colliding caller PARKS (and then times out 70 s
    // later) instead of being told immediately what is wrong.
    const release = deferred();
    const { conn } = await connected();

    const first = conn.withStatefulSession(async () => {
      await release.promise;
      return "first";
    });
    await settleTurns();

    await expect(
      asStranger(Promise.resolve(), () => conn.withStatefulSession(async () => "second")),
    ).rejects.toThrow(/already/i);

    release.resolve(undefined);
    await expect(first).resolves.toBe("first");
  }, 5_000);

  it("resets the stateful flag INSIDE the window: the very next holder never sees it set", async () => {
    // The reset must happen before the hold is released, not in the outer
    // `finally` after `runExclusive` has returned. Move it out and the next
    // holder is woken by `handOff()` one microtask BEFORE the outer `finally`
    // runs, so it takes the session with `stateful` still set — and anything it
    // dispatches carries an `X-sap-adt-sessiontype: stateful` bound to a
    // `sap-contextid` whose enqueues have just been released.
    //
    // The observer is a `runExclusive` waiter rather than an HTTP request on
    // purpose: `acquireImplicit` resolves through an extra `.then` hop, which
    // is enough to hide the gap behind the reset. A gap that only one extra
    // microtask hides is a gap.
    const { conn, lock } = await connected();
    const inside = deferred();
    let observed: string | undefined;

    const nextHolder = asStranger(inside.promise, () =>
      lock.runExclusive("next-holder", async () => {
        observed = conn.adt.stateful;
      }),
    );

    await conn.withStatefulSession(async () => {
      inside.resolve(undefined);
      await settleTurns();
      expect(lock.queueDepth).toBe(1);
    });

    await nextHolder;
    expect(observed).toBe("stateless");
  }, 5_000);

  it("claims activeSession in the SAME TICK: a collision in one turn is refused, not admitted", async () => {
    // The companion to the TOCTOU test above, which lets the first flow settle
    // before the second calls and so cannot see a yield inserted between the
    // check and the claim. Here both calls happen in ONE synchronous turn: the
    // claim is only safe because it is reached with no `await` in front of it.
    // Insert one — taking the mutex first is the tempting way to do exactly
    // that — and BOTH callers pass the `if (this.activeSession)` check, the
    // second overwrites the first's session object, and two flows share one
    // lock ledger.
    const release = deferred();
    const { conn } = await connected();

    const first = conn.withStatefulSession(async () => {
      await release.promise;
      return "first";
    });
    const second = conn.withStatefulSession(async () => "second");

    await expect(second).rejects.toThrow(/already/i);
    release.resolve(undefined);
    await expect(first).resolves.toBe("first");
  }, 5_000);

  it("releases the hold when the callback throws", async () => {
    const { conn, lock } = await connected();
    await expect(
      conn.withStatefulSession(async () => {
        throw new Error("body blew up");
      }),
    ).rejects.toThrow("body blew up");
    expect(lock.currentHolder()).toBeNull();
    expect(lock.queueDepth).toBe(0);
    expect(conn.adt.stateful).toBe("stateless");
  }, 5_000);
});

describe("LEVEL B — dropSession() and withFreshSession()", () => {
  it("dropSession takes its OWN exclusive window when called standalone", async () => {
    const { conn, adt } = await connected();
    adt.calls.length = 0;
    await conn.dropSession();
    // abap-adt-api's own dropSession() request. Without the runExclusive it
    // would be labelled with the request path (LEVEL A only).
    expect(adt.calls.length).toBeGreaterThan(0);
    expect(adt.holders).toEqual(adt.calls.map(() => "dropSession"));
  }, 5_000);

  it("withFreshSession spans BOTH the drop and the callback, and dropSession nests re-entrantly", async () => {
    // Splitting them would leave a window in which the sap-contextid has just
    // been discarded and a stranger can be dispatched onto it — the captured
    // `400` + `x-sap-icm-err-id: ICMENOSESSION` case — and would also let a
    // stranger establish a NEW session between the drop and the callback, which
    // is precisely the program-buffer staleness withFreshSession exists to
    // prevent.
    const { conn, adt, lock } = await connected();
    adt.calls.length = 0;

    await conn.withFreshSession(async () => {
      await conn.get("/sap/bc/adt/after-drop");
      expect(lock.queueDepth).toBe(0);
    });

    // The nested dropSession did NOT take a second hold: everything, the drop
    // included, is labelled with the OUTER flow.
    expect(adt.holders).toEqual(adt.calls.map(() => "withFreshSession"));
    expect(adt.find("/after-drop")).toBeDefined();
  }, 3_000);

  it("a stranger cannot be dispatched between the drop and the callback", async () => {
    const inside = deferred();
    const { conn, adt, lock } = await connected();
    adt.calls.length = 0;

    const stranger = asStranger(inside.promise, () => conn.get("/sap/bc/adt/stranger"));

    await conn.withFreshSession(async () => {
      inside.resolve(undefined);
      await settleTurns();
      expect(lock.queueDepth).toBe(1);
      expect(adt.find("/stranger")).toBeUndefined();
    });

    await stranger;
    expect(adt.find("/stranger")?.holder).toBe("/sap/bc/adt/stranger");
  }, 5_000);
});

// ---------------------------------------------------------------------------
// The derived wait timeout
// ---------------------------------------------------------------------------

describe("the wait timeout is DERIVED from the config, not SessionLock's default", () => {
  it("waits out a full slot wait PLUS a full request before refusing", async () => {
    // `SessionLock`'s own default is 10 000 ms — six times SMALLER than a single
    // request's own timeout, so a caller queued behind one perfectly healthy
    // request would be refused SESSION_BUSY long before that request could
    // possibly have finished. A live capture of work-process starvation
    // measured 14 075 ms of legitimate server-side queueing ON ITS OWN,
    // which already exceeds that default.
    //
    // The relation that composes is `sessionWaitMs + timeoutMs` = 10 000 +
    // 60 000 = 70 000 at defaults. The two probes below pin BOTH terms: still
    // pending at 69 s kills "use timeoutMs alone" (60 s) and "revert to the
    // 10 s default"; refused by 70.1 s kills "make it enormous".
    const c = cfg();
    expect(c.sessionWaitMs).toBe(10_000);
    expect(c.timeoutMs).toBe(60_000);

    // ONLY setTimeout/clearTimeout. Vitest's default `toFake` also captures
    // `setImmediate`, which `settleTurns()` uses to yield a macrotask turn — a
    // fully-faked clock deadlocks this test AND, because the `finally` below
    // then never runs, leaks the fake clock into every subsequent test in the
    // file. `SessionLock`'s wait timer is a plain `setTimeout`, so these two are
    // the whole surface this test needs to control.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const hold = deferred();
      // Deliberately NOT injecting a lock: this test is about the one the
      // CONSTRUCTOR builds, so it must be the production path.
      const adt = new RecordingAdt(async (r) => {
        const answered = preamble(r);
        if (answered) return answered;
        await hold.promise;
        return resp(200, "<ok/>", OK_XML);
      });
      const conn = tracked({ httpClient: adt, log: () => {} }, c);
      await conn.connect();

      const first = conn.get("/sap/bc/adt/slow");
      await settleTurns();
      expect(adt.find("/slow")).toBeDefined();

      // The queued caller is a LEVEL B flow rather than a `conn.get()`, for one
      // reason: it is the only route on which the structured error survives. See
      // the next test.
      let settled: "pending" | "rejected" | "resolved" = "pending";
      let err: unknown;
      const second = conn.dropSession().then(
        () => {
          settled = "resolved";
        },
        (e: unknown) => {
          settled = "rejected";
          err = e;
        },
      );
      await settleTurns();

      await vi.advanceTimersByTimeAsync(69_000);
      await settleTurns();
      expect(settled).toBe("pending");

      await vi.advanceTimersByTimeAsync(1_100);
      await settleTurns();
      await second;
      expect(settled).toBe("rejected");
      expect(err).toBeInstanceOf(SessionBusyError);
      expect((err as SessionBusyError).code).toBe("SESSION_BUSY");
      expect((err as SessionBusyError).reason).toBe("wait-timeout");
      expect((err as SessionBusyError).holderKind).toBe("exclusive");
      expect((err as SessionBusyError).holder).toBe("/sap/bc/adt/slow");

      hold.resolve(undefined);
      await first;
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it("KNOWN LOSS: on the conn.get() route abap-adt-api flattens SESSION_BUSY to an AdtErrorException", async () => {
    // Not an assertion that this is RIGHT — it is a pin on a limitation that is
    // not fixable from inside this repo, so that a future fix shows up here as a
    // red test rather than going unnoticed.
    //
    // The guard sits BELOW `AdtHTTP._request()`, whose `catch` runs
    // `fromException(error, config)` on everything the http client throws. A
    // `SessionBusyError` raised by the LEVEL A `acquire` is therefore re-wrapped
    // into an `AdtErrorException` (`err: 500`, `type: "Unknown error"`) before
    // any code in `src/` sees it, and the machine-readable `code`/`reason`/
    // `holder` fields are gone. Only the MESSAGE survives — so the message is
    // what must carry the diagnosis, and that is asserted below.
    //
    // LEVEL B flows (`connect`, `withStatefulSession`, `dropSession`,
    // `withFreshSession`) call `runExclusive` directly and never cross
    // `AdtHTTP`, so on those routes the structured error arrives intact — see
    // the test above. Recovering it on the `conn.get()` route would mean
    // sniffing the message text, which is exactly the fragile classification
    // this codebase avoids elsewhere; the real fix belongs in abap-adt-api,
    // as a preserved `cause`.
    const hold = deferred();
    const { conn } = await connected(
      async () => {
        await hold.promise;
        return resp(200, "<ok/>", OK_XML);
      },
      { waitTimeoutMs: 20 },
    );

    const first = conn.get("/sap/bc/adt/slow");
    await settleTurns();
    const refused = await conn.get("/sap/bc/adt/queued").then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(refused).toBeDefined();
    expect(refused).not.toBeInstanceOf(SessionBusyError);
    // The diagnosis still reaches a human, naming both the waiter and the holder.
    expect((refused as Error).message).toContain("SessionBusyError");
    expect((refused as Error).message).toContain("/sap/bc/adt/queued");
    expect((refused as Error).message).toContain("/sap/bc/adt/slow");

    hold.resolve(undefined);
    await first;
  }, 5_000);
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

describe("shutdown force-releases the mutex", () => {
  it("lets a signal-fired unlockAll run even though the holder is a different async context", async () => {
    // `withStatefulSession` registers `() => session.unlockAll()` on the
    // shutdown chain while it still HOLDS the lock, and a signal fires that
    // cleanup from a callback OUTSIDE the holder's async context — so it is not
    // re-entrant, it queues, and it queues for `sessionWaitMs + timeoutMs`
    // while handleSignal's 5 s force-exit timer runs underneath it. The unlock
    // would be severed and the ADT enqueue leaked until the session itself died.
    //
    // NOTE: `test/session.test.ts` fires shutdown from INSIDE the stateful
    // callback, which is re-entrant and therefore does NOT exercise this.
    const { conn, lock } = await connected();
    const entered = deferred();
    const finish = deferred();

    const flow = conn.withStatefulSession(async () => {
      entered.resolve(undefined);
      await finish.promise;
      return "flow";
    });
    await entered.promise;
    await settleTurns();
    expect(lock.currentHolder()?.op).toBe("withStatefulSession");

    // From OUTSIDE the holder's ALS context — the signal-handler shape.
    await asStranger(Promise.resolve(), () => conn.shutdown("SIGTERM"));

    expect(lock.currentHolder()).toBeNull();

    finish.resolve(undefined);
    await flow.catch(() => undefined);
  }, 5_000);

  it("costs zero requests: forceRelease never health-probes the session", async () => {
    // Live-proven: a pooled session must NEVER be health-probed. Nothing in
    // the lock path may put a byte on the wire.
    const { conn, adt, lock } = await connected();
    adt.calls.length = 0;

    const rel = await lock.acquireImplicit("probe-free");
    rel();
    const lease = lock.acquireLease("probe-free-lease");
    lease.release();
    lock.forceRelease("probe-free-force");

    expect(adt.calls.length).toBe(0);
    expect(conn.info().connected).toBe(true);
  });
});
