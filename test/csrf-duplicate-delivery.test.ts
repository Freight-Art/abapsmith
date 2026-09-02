/**
 * CSRF-403 recovery: how many times does a write BODY reach the wire, and what
 * does the recovery cost?
 *
 * ## What a CSRF 403 actually means
 *
 * `403` + body `CSRF token validation failed` + header `x-csrf-token: Required`
 * is ICF **refusing the request at the gate, before the application handler
 * runs**. The body was not applied. Nothing was written, nothing was activated,
 * no version was created. It is a rejection, not an ambiguous outcome.
 *
 * That single fact fixes the correct behaviour, and it is *not* "exactly one
 * delivery":
 *
 *  - **One resend after a CSRF 403 is correct recovery.** Two wire deliveries —
 *    one refused, one applied — is one logical write. An earlier revision of
 *    this file asserted `toHaveLength(1)` on the delivered bodies and called
 *    the second delivery "the defect". That assertion was **simply wrong**: it
 *    counted a request the server threw away as if it were a mutation. It has
 *    been replaced with "at most one resend" throughout, and the paragraphs
 *    that argued for it (lost update, spurious version, journal blindness) are
 *    gone, because every one of them presumed the first delivery landed.
 *
 *  - **What IS a defect is the second resend, the logon, and the lost session.**
 *    Those are the three things this file now pins:
 *
 *      D1  Two independent retry layers used to stack — `AbapConnection` caught
 *          the CSRF error and replayed, on top of `AdtHTTP.request()` having
 *          already re-logged-on and resent (`isLoginError(adtErr) && !autologin
 *          && !this.isStateful`). A persistent 403 multiplied to FOUR
 *          deliveries. `AbapConnection` now sends through `AdtHTTP._request`
 *          ("HTTP request without automated login / retry"), so the library's
 *          retry is not in the call path and ours is the only one.
 *
 *      D2  A token *refresh* used to cost a full `login()`, because
 *          `AdtHTTP.loggedin` is literally `csrfToken !== "fetch"` — so arming
 *          the token capture disarmed the session. Every logon is an attempt
 *          against `login/fails_to_user_lock` (5 on a stock system). Refreshing
 *          a token must cost zero logons.
 *
 *      D3  `login()` opens with `this.cookie.clear()`. Firing one from inside
 *          `withStatefulSession` discards the `sap-contextid` the object's ADT
 *          enqueue is bound to, so the caller's lock evaporates and
 *          the replay carries a lockHandle from a session that no longer
 *          exists. On the stateful path the recovery is therefore **refused**:
 *          abapsmith fails loudly and the caller retries the whole operation,
 *          which takes a fresh lock in a fresh session. A wrong confident
 *          success is worse than an error.
 *
 * So the measures here are: deliveries of the *body* (not a call count),
 * `adt.logons` (requests to `/compatibility/graph`, which only `login()`
 * issues) and `conn.logonEndpointRequests` (the same thing counted below the
 * library, at the guard).
 *
 * Everything is OFFLINE: a fake `HttpClient` is injected through
 * `ConnectionOptions.httpClient` (the convention in test/write.test.ts and
 * test/connection-signals.test.ts). The 403 is not invented — it is the real
 * captured rejection, fixture `078-p3-datapreview-t000` (body
 * `CSRF token validation failed`, header `x-csrf-token: Required`), and the
 * fake throws it the way the real transport does (axios rejects on 4xx, so
 * `AxiosHttpClient` raises an `HttpClientException` carrying the response).
 * "the fake's 403 is what abap-adt-api classifies as a CSRF error" below pins
 * that shape against `isCsrfError`, so none of this can go vacuously green if
 * the library's classification changes.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { fromException, isCsrfError } from "abap-adt-api/build/AdtException.js";
import { AbapConnection, RequestBudget } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { AbapError } from "../src/adt/errors.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { authorizeMutation, resolveWriteTarget, writeObject } from "../src/adt/write.js";
import { activateObject } from "../src/adt/activate.js";
import { SafetyGate } from "../src/safety.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

const LIVE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const captured = (name: string): string => readFileSync(join(LIVE, name), "utf8");

/** Real 403 body, 28 bytes, captured off A4H. */
const CSRF_403_BODY = captured("078-p3-datapreview-t000.txt");
/** Real 403 response headers from the same capture's `.meta.json`. */
const CSRF_403_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "x-csrf-token": "Required",
};


const REPORT = "ZMCP_TEST_REP";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_test_rep";
const REPORT_SRC = `${REPORT_URI}/source/main`;
const ACTIVATION = "/sap/bc/adt/activation";
const LOGON_URL = "/sap/bc/adt/compatibility/graph";
const DISCOVERY_URL = "/sap/bc/adt/discovery";

const SOURCE_OLD = "REPORT zmcp_test_rep.\nWRITE: / 'old'.\n";
const SOURCE_NEW = "REPORT zmcp_test_rep.\nWRITE: / 'new'.\n";

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_TOKEN = "TOKEN123";
const REFRESHED_TOKEN = "TOKEN-AFTER-REFRESH";
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": LOGIN_TOKEN };
/**
 * A `X-CSRF-Token: Fetch` GET is answered with the new token in the response
 * header — that is the whole mechanism, and it is why a refresh need not cost a
 * logon. The value differs from `LOGIN_TOKEN` so a test can prove the refresh
 * actually replaced the token rather than merely not crashing.
 */
const DISCOVERY_HEADERS = { "content-type": "application/xml", "x-csrf-token": REFRESHED_TOKEN };
/* `DATAPREVIEW_XML` and `T000_NONPRODUCTIVE` (fixture 087, the real 200 T000
 * capture that makes the fake system provably non-productive) are imported
 * from ./helpers/system-role-fake.js. */

const LOCK_XML =
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

const OBJECT_XML =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="${REPORT}" adtcore:type="PROG/P">` +
  `<adtcore:packageRef adtcore:name="$TMP"/>` +
  `</adtcore:objectMetadata>`;

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

// --------------------------------------------------------------- the fake ---

/** One request as it actually reached the transport. */
interface Delivery {
  method: string;
  url: string;
  qs: Record<string, string>;
  headers: Record<string, string>;
  body: string | undefined;
}

type Route = (d: Delivery) => HttpClientResponse | undefined;

/**
 * The CSRF rejection exactly as `AxiosHttpClient` would surface it: axios
 * rejects on 4xx, so the guard and `AdtHTTP._request` both see a thrown
 * `HttpClientException` whose `.response` carries the captured bytes.
 */
function csrfRejection(o: HttpClientOptions): HttpClientException {
  return new HttpClientException(
    "Request failed with status code 403",
    "ERR_BAD_REQUEST",
    403,
    undefined,
    o,
    {
      body: CSRF_403_BODY,
      status: 403,
      statusText: "Forbidden",
      headers: CSRF_403_HEADERS,
    } as unknown as HttpClientResponse,
    undefined,
  );
}

class RecordingAdt implements HttpClient {
  /** Every request that reached the transport, in order, bodies included. */
  readonly deliveries: Delivery[] = [];
  private rejections = 0;

  constructor(
    private readonly route: Route,
    /** Which deliveries get the CSRF 403. */
    private readonly reject: (d: Delivery) => boolean,
    /** How many times `reject` may fire. 1 = "first attempt only". */
    private readonly maxRejections = 1,
  ) {}

  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const d: Delivery = {
      method: (o.method ?? "GET").toUpperCase(),
      url: o.url,
      qs: (o.qs ?? {}) as Record<string, string>,
      headers: (o.headers ?? {}) as Record<string, string>,
      body: o.body,
    };
    this.deliveries.push(d);

    if (this.rejections < this.maxRejections && this.reject(d)) {
      this.rejections++;
      throw csrfRejection(o);
    }

    const res = this.route(d);
    if (!res) throw new Error(`RecordingAdt: unrouted ${d.method} ${d.url}`);
    return res;
  }

  /** Deliveries carrying exactly this body — the duplicate-delivery measure. */
  withBody(body: string): Delivery[] {
    return this.deliveries.filter((d) => d.body === body);
  }

  /** `login()` is the only thing that requests `/compatibility/graph`. */
  get logons(): number {
    return this.deliveries.filter((d) => d.url.includes(LOGON_URL)).length;
  }

  get trace(): string[] {
    return this.deliveries.map((d) => `${d.method} ${d.url}`);
  }
}

// ---------------------------------------------------------------- routing ---

/** Everything `connect()` needs; the T000 answer proves the system non-productive. */
const baseRoute: Route = (d) => {
  if (d.url.includes(LOGON_URL)) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (d.url.endsWith("/discovery")) return resp(200, "<service/>", DISCOVERY_HEADERS);
  if (d.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (d.url.includes("/datapreview/freestyle"))
    return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
};

/** Same, but `/discovery` answers without a token — see the "no token" test. */
const tokenlessDiscoveryRoute: Route = (d) => {
  if (d.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  return baseRoute(d);
};

/** An existing $TMP report whose current source is SOURCE_OLD. */
const reportRoute: Route = (d) => {
  if (d.qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
  if (d.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
  if (d.url === REPORT_SRC && d.method === "GET") return resp(200, SOURCE_OLD, OK_TEXT);
  if (d.url === REPORT_SRC && d.method === "PUT") return resp(200, "", OK_TEXT);
  if (d.url === REPORT_URI && d.method === "GET" && !d.qs._action)
    return resp(200, OBJECT_XML, OK_XML);
  // Activation success is an empty 200 body.
  if (d.url === ACTIVATION && d.method === "POST") return resp(200, "", OK_TEXT);
  return undefined;
};

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false, // what ABAP_ALLOW_WRITE sets
  });

interface ConnectedOptions {
  /** How many times the CSRF 403 may fire. 1 = "transient". 99 = "persistent". */
  maxRejections?: number;
  /** Swap the base routing table (used for the tokenless-`/discovery` case). */
  base?: Route;
}

async function connected(
  reject: (d: Delivery) => boolean,
  opts: ConnectedOptions = {},
): Promise<{ conn: AbapConnection; adt: RecordingAdt }> {
  const base = opts.base ?? baseRoute;
  const adt = new RecordingAdt((d) => base(d) ?? reportRoute(d), reject, opts.maxRejections ?? 1);
  const conn = new AbapConnection(cfg(), {
    httpClient: adt,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.deliveries.length = 0; // connect() is not under test
  return { conn, adt };
}

const isSourcePut = (d: Delivery) => d.method === "PUT" && d.url === REPORT_SRC;
const isActivationPost = (d: Delivery) => d.method === "POST" && d.url === ACTIVATION;

/** The thrown value, as an `AbapError`, or a failed assertion naming what came instead. */
async function rejectsWithAbapError(p: Promise<unknown>): Promise<AbapError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AbapError);
    return e as AbapError;
  }
  throw new Error("expected the operation to reject, but it resolved");
}

// ---------------------------------------------------------------------------

describe("the fake's 403 is the shape abap-adt-api recognises", () => {
  it("classifies the captured rejection as a CSRF error, not a generic 403", () => {
    // If this ever fails, every assertion below is vacuous: our layer's
    // `isCsrfError(e)` guard would never fire and no recovery would be exercised.
    const exc = csrfRejection({ url: REPORT_SRC, method: "PUT" } as HttpClientOptions);
    expect(isCsrfError(fromException(exc, {}))).toBe(true);
    expect(CSRF_403_BODY).toMatch(/CSRF/);
  });
});

// ------------------------------------------------------------------- D3 ----

describe("D3 — a CSRF 403 under a held lock is refused, never replayed", () => {
  /**
   * The centrepiece. `writeObject` runs inside `withStatefulSession` holding
   * the object's ADT enqueue. Recovering here would mean `login()`, which means
   * `cookie.clear()`, which means the `sap-contextid` the lock lives in is
   * gone — and the replayed PUT would carry lockHandle `H1` minted in a session
   * that no longer exists. The server's answer to that is not something this
   * codebase gets to guess at, so the recovery does not happen.
   */
  // A permissive gate — this file is about CSRF/retry mechanics, not
  // authorization. `writeObject` now requires a real gate-minted
  // `AuthorizedTarget`, so every call below resolves through the real
  // `authorizeMutation` first.
  const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
  const authWrite = (conn: AbapConnection) =>
    authorizeMutation(conn, gate, "write", { name: REPORT, type: "PROG/P" });

  it("does not resend the source body — the one delivery is the refused one", async () => {
    const { conn, adt } = await connected(isSourcePut);

    const err = await rejectsWithAbapError(
      writeObject(conn, await authWrite(conn), { source: SOURCE_NEW }),
    );
    expect(err.details.reason).toBe("csrf-stale-in-stateful-session");

    // Exactly one delivery, and it is the one the server refused. Not "at most
    // one resend" — on this path there is no resend at all.
    expect(adt.withBody(SOURCE_NEW)).toHaveLength(1);
    expect(adt.deliveries.filter(isSourcePut)).toHaveLength(1);
    conn.dispose();
  });

  it("spends no logon, so the session and its lock are never discarded", async () => {
    const { conn, adt } = await connected(isSourcePut);
    const before = conn.logonEndpointRequests;

    await rejectsWithAbapError(
      writeObject(conn, await authWrite(conn), { source: SOURCE_NEW }),
    );

    // Both counters: `adt.logons` is the wire, `logonEndpointRequests` is the
    // guard hook below the library. Neither may move.
    expect(adt.logons).toBe(0);
    expect(conn.logonEndpointRequests - before).toBe(0);
    expect(adt.trace).not.toContain(`GET ${DISCOVERY_URL}`);
    conn.dispose();
  });

  it("releases the lock before reporting, so a clean retry can take it again", async () => {
    const { conn, adt } = await connected(isSourcePut);

    await rejectsWithAbapError(
      writeObject(conn, await authWrite(conn), { source: SOURCE_NEW }),
    );

    // `withStatefulSession`'s finally still runs: the refusal is an ordinary
    // failure, not a torn session. The last thing on the wire is the UNLOCK.
    const actions = adt.deliveries.map((d) => d.qs._action).filter(Boolean);
    expect(actions).toEqual(["LOCK", "UNLOCK"]);
    conn.dispose();
  });

  it("tells the caller what to do, and names the lock it was holding", async () => {
    const { conn } = await connected(isSourcePut);

    const err = await rejectsWithAbapError(
      writeObject(conn, await authWrite(conn), { source: SOURCE_NEW }),
    );

    // The message has to carry the one fact that makes a retry safe: the
    // server REFUSED the request, so nothing was written.
    expect(err.message).toMatch(/REFUSED/);
    expect(err.message).toMatch(/nothing\s+was written/);
    expect(err.hint).toMatch(/Retry the whole operation/);
    expect(err.details.heldLocks).toEqual([REPORT_URI]);
    conn.dispose();
  });
});

// ---------------------------------------------------------------- D1/D2 ----

describe("D1/D2 — the stateless path resends once, and the resend is free", () => {
  it("resends the body exactly once: first delivery refused, second applied", async () => {
    const { conn, adt } = await connected(isSourcePut);

    await conn.put(REPORT_SRC, { body: SOURCE_NEW, qs: { lockHandle: "H1" } });

    // TWO deliveries is correct, and this is the assertion the old revision of
    // this file got wrong. The first was refused at the CSRF gate and applied
    // nothing; the second is the write. What must not appear is a third.
    expect(adt.withBody(SOURCE_NEW)).toHaveLength(2);
    expect(adt.trace).toEqual([
      `PUT ${REPORT_SRC}`, // refused: 403 CSRF, body not applied
      `GET ${DISCOVERY_URL}`, // token refresh — no logon, no cookie.clear()
      `PUT ${REPORT_SRC}`, // the one resend
    ]);
    conn.dispose();
  });

  it("the refresh costs zero logons and actually replaces the token", async () => {
    const { conn, adt } = await connected(isSourcePut);
    const before = conn.logonEndpointRequests;

    await conn.put(REPORT_SRC, { body: SOURCE_NEW, qs: { lockHandle: "H1" } });

    // D2: `csrfToken = "fetch"` used to make `loggedin` false and force a full
    // `login()`. Sending through `AdtHTTP._request` breaks that coupling —
    // `_request` never reads `loggedin`, but still captures the new token off
    // the response header.
    expect(adt.logons).toBe(0);
    expect(conn.logonEndpointRequests - before).toBe(0);
    expect(conn.csrfToken()).toBe(REFRESHED_TOKEN);
    conn.dispose();
  });

  it("a persistent 403 stops after that one resend — two deliveries, not four", async () => {
    // D1 in one number. With both retry layers live this was 4 deliveries and
    // 3 logons: the library resent, our layer replayed the whole thing, and the
    // library resent again. The library's retry is no longer in the call path.
    const { conn, adt } = await connected(isSourcePut, { maxRejections: 99 });

    await expect(conn.put(REPORT_SRC, { body: SOURCE_NEW })).rejects.toThrow();

    expect(adt.withBody(SOURCE_NEW)).toHaveLength(2);
    expect(adt.logons).toBe(0);
    conn.dispose();
  });

  it("does not resend when the refresh yields no token", async () => {
    // There is no live capture proving `/sap/bc/adt/discovery` issues a token
    // on every release, so the code checks instead of assuming. If no token
    // arrives there is nothing to resend WITH, and a resend carrying the same
    // stale token would just be a second refusal.
    const { conn, adt } = await connected(isSourcePut, { base: tokenlessDiscoveryRoute });

    const err = await rejectsWithAbapError(conn.put(REPORT_SRC, { body: SOURCE_NEW }));
    expect(err.details.reason).toBe("csrf-refresh-no-token");
    expect(err.message).toMatch(/NOT resent/);

    expect(adt.withBody(SOURCE_NEW)).toHaveLength(1);
    expect(adt.logons).toBe(0);
    conn.dispose();
  });

  it("does not recover from a 403 that follows a logon it just performed", async () => {
    // A token minted milliseconds ago and immediately refused is not stale, so
    // fetching another identical one changes nothing. Mirrors the library's own
    // `!autologin` guard — and, with D1's stacking gone, keeps a token-less
    // request at ONE logon instead of the three it used to burn.
    const { conn, adt } = await connected(isSourcePut);
    conn.adt.httpClient.csrfToken = "fetch"; // `loggedin` is `csrfToken !== "fetch"`
    const before = conn.logonEndpointRequests;

    await expect(conn.put(REPORT_SRC, { body: SOURCE_NEW })).rejects.toThrow();

    expect(adt.trace).toEqual([`GET ${LOGON_URL}`, `PUT ${REPORT_SRC}`]);
    expect(adt.logons).toBe(1);
    expect(conn.logonEndpointRequests - before).toBe(1);
    expect(adt.withBody(SOURCE_NEW)).toHaveLength(1);
    conn.dispose();
  });
});

// ------------------------------------------------------- the logon bound ----

describe("the logon bound is structural, not a promise in a comment", () => {
  /**
   * The previous revision of `connect()` carried the sentence "Exactly ONE
   * logon attempt is ever made. A failure is terminal." It was false — a single
   * CSRF-403'd request burned three. A comment cannot enforce anything, so the
   * bound is now a counter that refuses at the wire, and these tests fail if it
   * stops refusing.
   */
  it("refuses a second logon for one logical request", () => {
    const budget = new RequestBudget(REPORT_SRC);
    expect(() => budget.spendLogon()).not.toThrow();

    let thrown: unknown;
    try {
      budget.spendLogon();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AbapError);
    expect((thrown as AbapError).details.reason).toBe("request-budget-exceeded");
    expect((thrown as AbapError).details.limit).toBe(1);
    expect((thrown as AbapError).details.attempted).toBe(2);
    // Refused locally, before the request flew: the point is to NOT spend the
    // attempt against `login/fails_to_user_lock`.
    expect((thrown as AbapError).hint).toMatch(/5-attempt user lock/);
  });

  it("refuses a second resend for one logical request", () => {
    const budget = new RequestBudget(REPORT_SRC);
    expect(() => budget.spendResend()).not.toThrow();
    expect(() => budget.spendResend()).toThrow(/at most one logon and one resend/);
  });

  it("counts logons below the library, where they cannot be hidden", async () => {
    // `logonEndpointRequests` is fed by the guard's `onRequest` hook, which sits
    // under `AdtHTTP`. It therefore sees logons this file never issued —
    // including any the library performs on paths that bypass `request()`.
    const adt = new RecordingAdt(
      (d) => baseRoute(d) ?? reportRoute(d),
      () => false,
    );
    const conn = new AbapConnection(cfg(), {
      httpClient: adt,
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    expect(conn.logonEndpointRequests).toBe(0);

    await conn.connect();

    expect(conn.logonEndpointRequests).toBe(1);
    expect(adt.logons).toBe(1);
    conn.dispose();
  });

  /**
   * D5(b). `RequestBudget` caps logons at one per logical request — but that
   * budget only exists for the duration of `AbapConnection.request()`. Every
   * other route to the logon endpoint (`connect()`'s own `login()`,
   * `dropSession()`, anything a caller does straight through `conn.adt.*`)
   * reached `noteWireRequest()` with `activeBudget === undefined`, where the
   * old code counted the request and then did nothing at all. An unbounded
   * re-logon loop on that path was invisible AND unrefused, which is precisely
   * the failure the whole breaker exists to prevent.
   *
   * The ceiling is deliberately generous (5) — it is a runaway detector, not a
   * quota — and it refuses the same way `RequestBudget` does: a real throw
   * from the `onRequest` hook, i.e. before the request is dispatched, so the
   * refused attempt is never spent against `login/fails_to_user_lock`.
   */
  it("bounds unbudgeted logon-endpoint requests for the connection's lifetime (D5b)", async () => {
    const adt = new RecordingAdt(
      (d) => baseRoute(d) ?? reportRoute(d),
      () => false,
    );
    const conn = new AbapConnection(cfg(), {
      httpClient: adt,
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    await conn.connect(); // spends 1
    expect(conn.logonEndpointRequests).toBe(1);

    // Direct `conn.adt.*` use: no `request()` wrapper, so no budget. Four more
    // reach the wire (2..5), and the sixth is refused before it does.
    for (let i = 0; i < 4; i++) await conn.adt.login();
    expect(conn.logonEndpointRequests).toBe(5);
    expect(adt.logons).toBe(5);

    // Asserted at the guard, which is where the refusal is raised, because
    // `AdtHTTP` rewrites every foreign throw: BOTH `request()` and `_request()`
    // funnel through `fromException`, which turns anything that is not already
    // an `AdtException` into `AdtErrorException.create(500, {}, "Unknown
    // error", ...)` (AdtException.js:167-174). A structured `AbapError` cannot
    // survive `conn.adt.login()` as itself, so asserting its shape means
    // calling the layer that raises it: the `GuardedHttpClient` AdtHTTP
    // dispatches through, whose `onRequest` hook runs before its own
    // try/catch. Same object, same counter, one layer down.
    const guard = (conn.adt.httpClient as unknown as { httpclient: HttpClient }).httpclient;
    const err = await rejectsWithAbapError(guard.request({ url: LOGON_URL, method: "GET" }));
    expect(err.code).toBe("ADT_ERROR");
    expect(err.details.reason).toBe("logon-ceiling-exceeded");
    expect(err.details.limit).toBe(5);
    expect(err.details.attempted).toBe(6);

    // Refused LOCALLY: nothing new reached the transport, and — because the
    // refusal happened before dispatch — nothing was charged for it either.
    expect(adt.logons).toBe(5);
    expect(conn.logonEndpointRequests).toBe(5);

    // And the realistic path is bounded too, whatever exception type comes
    // back out of the library: still nothing on the wire.
    await expect(conn.adt.login()).rejects.toThrow();
    expect(adt.logons).toBe(5);
    expect(conn.logonEndpointRequests).toBe(5);
    conn.dispose();
  });

  /**
   * The ordering inside the hook, pinned. `logonEndpointRequestCount` is the
   * "how many logons did this cost?" measurement (its own docstring says so),
   * and a refused attempt costs nothing: it is thrown out of `noteWireRequest()`
   * before the request is handed to the transport, so no byte, no user-lock
   * attempt, no charge.
   *
   * Charging it — incrementing above the ceiling check rather than below —
   * looks harmless because the refusal still fires. It is not: the counter then
   * climbs one per *refusal*, forever, so the number an operator reads as
   * "logons spent" drifts arbitrarily far from the traffic, and the identical
   * refusal reports a different `attempted` every time it happens. This test
   * fails with the increment in that position and passes with it below.
   */
  it("does not charge an attempt it refused — the ceiling counts flights, not tries", async () => {
    const adt = new RecordingAdt(
      (d) => baseRoute(d) ?? reportRoute(d),
      () => false,
    );
    const conn = new AbapConnection(cfg(), {
      httpClient: adt,
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    await conn.connect();
    for (let i = 0; i < 4; i++) await conn.adt.login();
    expect(conn.logonEndpointRequests).toBe(5);

    const guard = (conn.adt.httpClient as unknown as { httpclient: HttpClient }).httpclient;
    // Three refusals in a row. Every one of them is the SIXTH attempt: the
    // fifth flight is the last thing this connection ever charged.
    for (let i = 0; i < 3; i++) {
      const err = await rejectsWithAbapError(guard.request({ url: LOGON_URL, method: "GET" }));
      expect(err.details.attempted, `refusal ${i + 1} reports a stable ordinal`).toBe(6);
      expect(err.message).toMatch(/Refused logon-endpoint request #6 /);
      expect(conn.logonEndpointRequests, `refusal ${i + 1} charged nothing`).toBe(5);
    }
    expect(adt.logons).toBe(5);
    conn.dispose();
  });
});

// ------------------------------------------ a local refusal is not a 401 ----

/**
 * D5(c). Live-verified on A4H, 2026-08-03: `connect()` reported a
 * ceiling-exceeded refusal as **`AUTH_FAILED`**, and that is the single most
 * dangerous label this codebase can attach to it.
 *
 * `LOGON_ENDPOINT_LIFETIME_CEILING` refuses the 6th unbudgeted logon-endpoint
 * request *inside the guard's `onRequest` hook*, i.e. **before dispatch**:
 * nothing is sent, no credential is presented, and SAP's shared
 * `login/fails_to_user_lock` counter is never touched. The standing operational
 * rule on a genuine `AUTH_FAILED` is STOP IMMEDIATELY, DO NOT RETRY — because
 * the account locks at 5 and one failed connect can burn several. An operator
 * handed `AUTH_FAILED` here stops working on a system that never rejected them,
 * and — worse — never looks for the abapsmith bug that is actually present: some
 * caller keeps logging on outside a budgeted `request()`.
 *
 * So the code below is the discriminating assertion, and `not.toBe`
 * ("AUTH_FAILED") is the load-bearing line: restore the plain `AUTH_FAILED`
 * wrap in `connectUnderLock()`'s catch and this test goes red on it.
 */
describe("D5c — a ceiling-exceeded connect() is a LOCAL refusal, never AUTH_FAILED", () => {
  /** `connect()` + four direct `conn.adt.login()` calls: counter at the ceiling. */
  async function atTheCeiling(): Promise<{ conn: AbapConnection; adt: RecordingAdt }> {
    const adt = new RecordingAdt(
      (d) => baseRoute(d) ?? reportRoute(d),
      () => false,
    );
    const conn = new AbapConnection(cfg(), {
      httpClient: adt,
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    await conn.connect(); // spends 1
    for (let i = 0; i < 4; i++) await conn.adt.login(); // 2..5 — all reach the wire
    expect(conn.logonEndpointRequests).toBe(5);
    expect(adt.logons).toBe(5);
    return { conn, adt };
  }

  it("reports ADT_ERROR / logon-ceiling-exceeded and NOT AUTH_FAILED", async () => {
    const { conn, adt } = await atTheCeiling();

    // `connect()` early-returns on `this.connected`, so the reconnect has to be
    // asked for. `markDead()` drops `connected`; `connect()` no longer honours
    // the death half of `assertUsable()`, so the revival gets as far as the
    // LOGIN and it is the login that fails below, not the corpse. (The record
    // itself is only cleared once a replacement session exists, so it is still
    // set afterwards — this test does not assert on it either way.)
    conn.markDead("session gone — operator asked for a revival");
    const deliveriesBefore = adt.deliveries.length;
    // `GuardedHttpClient` increments `requestCount` AFTER the `onRequest` hook
    // that raises the refusal, so this counter is a genuine pre-dispatch
    // measure: it cannot move for a request that was refused before it flew.
    const requestsBefore = conn.requestCount;

    const err = await rejectsWithAbapError(conn.connect());

    // ↓↓ THE ASSERTION THIS TEST EXISTS FOR ↓↓
    expect(err.code).not.toBe("AUTH_FAILED");
    expect(err.code).toBe("ADT_ERROR");
    expect(err.details.reason).toBe("logon-ceiling-exceeded");
    expect(err.details.limit).toBe(5);
    expect(err.details.attempted).toBe(6); // the ordinal of the refused attempt

    // The prose has to be actionable too, because that is what an operator
    // reads: it must say nothing was sent, and it must not read as a 401.
    expect(err.message).toMatch(/refused locally/i);
    expect(err.message).toMatch(/Nothing was sent; no credential was rejected/);
    expect(err.hint ?? "").toMatch(/NOT an authentication failure/i);
    expect(err.hint ?? "").toMatch(/user lock counter was never touched/i);

    // Refused BEFORE dispatch: nothing new — not one byte — reached the
    // transport, and the refusal was not charged against the ceiling either.
    expect(adt.deliveries.length).toBe(deliveriesBefore);
    expect(adt.logons).toBe(5);
    expect(conn.requestCount).toBe(requestsBefore);
    expect(conn.logonEndpointRequests).toBe(5);
    conn.dispose();
  });

  /**
   * Why the fix keys on our OWN counter rather than on the error's shape, and
   * the measurement that forces it: `AdtHTTP` funnels every foreign throw
   * through `fromException`, which rewrites anything that is not already an
   * `AdtException` into a generic `AdtErrorException(500, "Unknown error")`
   * (AdtException.js:167-174). The structured `AbapError` the guard raised
   * therefore **cannot** survive `client.login()` as itself — its `code`,
   * `details` and `hint` are all gone by the time `connectUnderLock()`'s catch
   * sees it; only a stringified `.message` is smuggled through.
   *
   * This is the observation, pinned. If a library upgrade ever starts passing
   * the `AbapError` through intact, this test says so — and the `instanceof`
   * half of the guard in `connectUnderLock()` becomes the live one.
   */
  it("because the library destroys the structured error: only the counter survives", async () => {
    const { conn } = await atTheCeiling();

    let raw: unknown;
    try {
      await conn.adt.login(); // the 6th — refused in the guard, rewritten above it
    } catch (e) {
      raw = e;
    }

    expect(raw).toBeInstanceOf(Error);
    // NOT our error any more. This is the whole reason `details.reason` cannot
    // be the discriminator inside the catch.
    expect(raw).not.toBeInstanceOf(AbapError);
    const rewritten = raw as Record<string, unknown>;
    expect(rewritten.constructor?.name).toBe("AdtErrorException");
    expect(rewritten.details).toBeUndefined();
    expect(rewritten.code).toBeUndefined();
    expect(rewritten.err).toBe(500); // the generic rewrite, not our refusal
    expect(rewritten.type).toBe("Unknown error");
    // The refusal is still in there — but only as prose, in `.message`.
    expect(String((raw as Error).message)).toMatch(/Refused logon-endpoint request #6/);

    // The counter is local state the library cannot rewrite — but it deliberately
    // does NOT move for a refusal, which is why the catch keys on the latched
    // `logonCeilingRefused` flag rather than on this number.
    expect(conn.logonEndpointRequests).toBe(5);
    conn.dispose();
  });
});

// ------------------------------------------------------- characterisation ---
//
// Not assertions about what SHOULD happen — a record of what the remaining
// retry does, so a library upgrade that changes it shows up here rather than on
// a customer's system.

describe("characterisation: activation still runs through the LIBRARY's retry", () => {
  /**
   * `activate.ts` calls `conn.adt.activate(...)` directly, not
   * `AbapConnection.request()`, so its CSRF recovery is `AdtHTTP.request()`'s
   * own: re-logon, then resend, guarded by `!autologin && !this.isStateful`.
   *
   * That is ONE resend, which is correct recovery — the refused POST activated
   * nothing. What it costs that our path does not is a `login()`. It is outside
   * a stateful session so no lock is at risk, but it is still an attempt
   * against the 5-attempt user lock. Closing it means routing activation
   * through `AbapConnection.request()`, i.e. editing `activate.ts`.
   */
  it("delivers the activation body twice — one refused, one applied", async () => {
    const { conn, adt } = await connected(isActivationPost);

    const target = await resolveWriteTarget(conn, { name: REPORT, type: "PROG/P" });
    const outcome = await activateObject(conn, target);
    expect(outcome.activated).toBe(true);

    const posts = adt.deliveries.filter(isActivationPost);
    expect(posts).toHaveLength(2);
    expect(posts[0]?.body).toContain(`adtcore:name="${REPORT}"`);
    expect(new Set(posts.map((d) => d.body)).size).toBe(1);
    conn.dispose();
  });

  it("and burns one logon doing it, because the library recovers by re-logging-on", async () => {
    const { conn, adt } = await connected(isActivationPost);
    const target = await resolveWriteTarget(conn, { name: REPORT, type: "PROG/P" });
    await activateObject(conn, target);

    expect(adt.logons).toBe(1);
    // The bound still holds — one logical operation, at most one logon.
    expect(conn.logonEndpointRequests).toBe(2); // connect() + this one
    conn.dispose();
  });
});
