/**
 * The sliding-window logon ceiling and the two request-level recoveries that
 * sit beside it, all offline.
 *
 * ## The contract this file pins
 *
 *  - `LOGON_CEILING_PER_WINDOW` (5) unbudgeted logon-endpoint requests
 *    (`GET /sap/bc/adt/compatibility/graph`) are allowed per connection in
 *    any `LOGON_CEILING_WINDOW_MS` (600_000 ms) sliding window, measured by
 *    the injected `ConnectionOptions.now`. The 6th within the window is
 *    refused BEFORE dispatch — nothing reaches the fake — with `AbapError`
 *    code `"LOGON_CEILING"`.
 *  - N concurrent `conn.get()` calls on a never-connected connection perform
 *    exactly ONE logon (shared in-flight logon), not N.
 *  - A budgeted stateless request (`conn.get()`/`conn.request()`) that meets
 *    `400 ICMENOSESSION` OUTSIDE a stateful session gets ONE re-logon and ONE
 *    resend; a second consecutive `ICMENOSESSION` is reported, not retried
 *    forever.
 *  - Inside `conn.withStatefulSession(...)` the OLD behaviour stays: a `400
 *    ICMENOSESSION` marks the connection dead immediately, with NO re-logon.
 *  - None of this trips the auth circuit breaker — `ICMENOSESSION` is a
 *    session death, not a credential rejection.
 *
 * Modelled on `test/connection-liveness.test.ts`'s offline transport: the fake
 * REJECTS every non-2xx exactly as the real axios transport does (see
 * `axiosLike`), because a fake that resolved a 400 would never exercise the
 * throw-carrying path production actually takes.
 */
import { afterEach, describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import {
  AbapConnection,
  LOGON_CEILING_PER_WINDOW,
  LOGON_CEILING_WINDOW_MS,
  type ConnectionOptions,
} from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError } from "../src/adt/errors.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Offline transport — copied in shape from test/connection-liveness.test.ts
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
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

const ICMENOSESSION_HEADERS = {
  "content-type": "text/html",
  "x-sap-icm-err-id": "ICMENOSESSION",
  "sap-err-id": "ICMENOSESSION",
  connection: "close",
};
const SESSION_GONE_PAGE = `<!DOCTYPE html><html><head><title>Application Server Error</title></head>
<body><h1>400 Session timed out</h1></body></html>`;
const ICMENOSESSION_RESP = () => resp(400, SESSION_GONE_PAGE, ICMENOSESSION_HEADERS);

const LOCK_XML = (handle = "LOCKHANDLEA") =>
  `<?xml version="1.0" encoding="utf-8"?>
<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>
  <LOCK_HANDLE>${handle}</LOCK_HANDLE>
  <CORRNR/><CORRUSER/><CORRTEXT/>
  <IS_LOCAL>X</IS_LOCAL>
  <IS_LINK_UP/><MODIFICATION_SUPPORT/><SCOPE_MESSAGES/>
</DATA></asx:values></asx:abap>`;

class Thrown {
  constructor(readonly error: unknown) {}
}
class Resolved {
  constructor(readonly response: HttpClientResponse) {}
}

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
  get graphGets(): number {
    return this.calls.filter((c) => c.url.includes("/compatibility/graph")).length;
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

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle"))
    return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

const openConnections: AbapConnection[] = [];

function tracked(cfg: Config, opts: Omit<ConnectionOptions, "breaker">): AbapConnection {
  const conn = new AbapConnection(cfg, { breaker: new AuthCircuitBreaker(), ...opts });
  openConnections.push(conn);
  return conn;
}

afterEach(() => {
  for (const conn of openConnections.splice(0)) conn.dispose();
});

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

/** A connection that has NEVER connected — for the shared in-flight-logon test. */
function freshUnconnected(
  route: (r: Recorded) => HttpClientResponse | Thrown | Resolved,
  opts: { now?: () => number } = {},
): { conn: AbapConnection; adt: FakeAdt } {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = tracked(writableCfg(), { httpClient: adt, log: () => {}, ...opts });
  return { conn, adt };
}

const GENERIC_OK = (): HttpClientResponse => resp(200, "ok", OK_TEXT);
const READ_URI = "/sap/bc/adt/programs/programs/zmcp_probe_rep/source/main";

async function catchErr(p: Promise<unknown>): Promise<{ code?: string; details: Record<string, unknown>; message: string; hint?: string }> {
  try {
    await p;
    throw new Error("expected a rejection");
  } catch (e) {
    if (isAbapError(e)) return e as unknown as { code?: string; details: Record<string, unknown>; message: string; hint?: string };
    throw e;
  }
}

// ===========================================================================

describe("logon-ceiling / sliding window", () => {
  it("6 concurrent reads on a fresh connection perform one logon", async () => {
    // Kept under `SessionLock`'s default `maxQueue` (8, src/adt/session-lock.ts)
    // — that queue is a separate, pre-existing per-connection mutex on wire
    // requests, unrelated to this contract. 6 concurrent callers is 1 active +
    // 5 queued, comfortably inside capacity, while still exercising N>1
    // concurrent callers sharing one in-flight logon.
    const { conn, adt } = freshUnconnected((r) => {
      if (r.url === READ_URI && r.method === "GET") return resp(200, "* source", OK_TEXT);
      return GENERIC_OK();
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, () => conn.get(READ_URI)),
    );

    expect(results).toHaveLength(6);
    for (const r of results) expect(r.status).toBe(200);
    expect(adt.graphGets).toBe(1);
    expect(conn.logonEndpointRequests).toBe(1);
  });

  it("the ceiling is a sliding window: the 6th unbudgeted logon in 10 minutes is refused with LOGON_CEILING and retryAfterSeconds", async () => {
    const c = clock();
    const { conn, adt } = await connected(GENERIC_OK, { now: c.now });
    expect(conn.logonEndpointRequests).toBe(1);

    for (let i = 0; i < LOGON_CEILING_PER_WINDOW - 1; i++) {
      c.advance(1_000);
      await conn.adt.login();
    }
    expect(conn.logonEndpointRequests).toBe(LOGON_CEILING_PER_WINDOW);
    expect(conn.logonsInWindow).toBe(LOGON_CEILING_PER_WINDOW);

    // The refusal-triggering call goes through `conn.connect()`, not a raw
    // `conn.adt.login()`: the vendor client's own `login()` re-wraps whatever
    // it catches via `fromException()`, which does not recognise a plain
    // `AbapError` and rewrites it into a generic, detail-free exception —
    // `connectUnderLock()`'s catch is the one place that reconstructs a clean
    // `AbapError` afterward (from the `logonCeilingRefusal` side channel; see
    // its doc comment in src/adt/connection.ts). `markDead()` first so this
    // `connect()` actually re-attempts a logon instead of short-circuiting on
    // an already-`connected` connection.
    conn.markDead("forcing a reconnect attempt for this test");
    const graphBefore = adt.graphGets;
    const err = await catchErr(conn.connect());

    expect(err.code).toBe("LOGON_CEILING");
    expect(err.details.reason).toBe("logon-ceiling-exceeded");
    expect(err.details.limit).toBe(LOGON_CEILING_PER_WINDOW);
    expect(err.details.attempted).toBe(LOGON_CEILING_PER_WINDOW + 1);
    expect(err.details.windowSeconds).toBe(LOGON_CEILING_WINDOW_MS / 1000);
    expect(typeof err.details.retryAfterSeconds).toBe("number");
    const retryAfter = err.details.retryAfterSeconds as number;
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(600);
    expect(err.hint ?? "").toMatch(/NOT an authentication failure/i);
    expect(err.hint ?? "").toMatch(/user lock counter was never touched/i);
    expect(err.hint ?? "").toMatch(/concurrent/i);

    // Refused BEFORE dispatch: nothing new reached the fake.
    expect(adt.graphGets).toBe(graphBefore);
    expect(conn.logonEndpointRequests).toBe(LOGON_CEILING_PER_WINDOW);
  });

  it("connect()'s refusal reads as a local refusal, and marks the connection dead", async () => {
    const c = clock();
    const { conn } = await connected(GENERIC_OK, { now: c.now });
    for (let i = 0; i < LOGON_CEILING_PER_WINDOW - 1; i++) {
      c.advance(1_000);
      await conn.adt.login();
    }
    conn.markDead("session gone — operator asked for a revival");

    const err = await catchErr(conn.connect());
    expect(err.message).toMatch(/refused locally/i);
    expect(err.message).toMatch(/a new logon is allowed in \d+ s/);
    expect(conn.isDead).toBe(true);
    expect(conn.deathRecord?.reason).toMatch(/logon ceiling/i);
  });

  it("once the window has slid a new logon is allowed", async () => {
    const c = clock();
    const { conn, adt } = await connected(GENERIC_OK, { now: c.now });
    for (let i = 0; i < LOGON_CEILING_PER_WINDOW - 1; i++) {
      c.advance(1_000);
      await conn.adt.login();
    }
    expect(conn.logonEndpointRequests).toBe(LOGON_CEILING_PER_WINDOW);
    await expect(conn.adt.login()).rejects.toThrow();
    expect(conn.logonEndpointRequests).toBe(LOGON_CEILING_PER_WINDOW);

    c.advance(LOGON_CEILING_WINDOW_MS + 1);

    const graphBefore = adt.graphGets;
    await expect(conn.adt.login()).resolves.not.toThrow();
    expect(adt.graphGets).toBe(graphBefore + 1);
    expect(conn.logonEndpointRequests).toBe(LOGON_CEILING_PER_WINDOW + 1);
  });
});

describe("ICMENOSESSION recovery, budgeted requests outside a stateful session", () => {
  it("a dead session followed by 6 sequential calls costs one re-logon", async () => {
    const c = clock();
    let icmenosessionsToServe = 1;
    const { conn, adt } = await connected((r) => {
      if (r.url === READ_URI && r.method === "GET") {
        if (icmenosessionsToServe > 0) {
          icmenosessionsToServe--;
          return ICMENOSESSION_RESP();
        }
        return resp(200, "* source", OK_TEXT);
      }
      return GENERIC_OK();
    }, { now: c.now });

    const graphBefore = adt.graphGets;
    const result = await conn.get(READ_URI);
    expect(result.status).toBe(200);
    expect(conn.isDead).toBe(false);
    expect(adt.graphGets).toBe(graphBefore + 1);
    expect(conn.logonEndpointRequests).toBe(graphBefore + 1);

    // Five more sequential calls, none of which meet ICMENOSESSION again —
    // they must not pay for a re-logon they don't need.
    const graphAfterFirst = adt.graphGets;
    for (let i = 0; i < 5; i++) {
      const r = await conn.get(READ_URI);
      expect(r.status).toBe(200);
    }
    expect(adt.graphGets).toBe(graphAfterFirst);
  });

  it("a second consecutive ICMENOSESSION is reported, not retried forever", async () => {
    const c = clock();
    const { conn, adt } = await connected((r) => {
      if (r.url === READ_URI && r.method === "GET") return ICMENOSESSION_RESP();
      return GENERIC_OK();
    }, { now: c.now });

    const graphBefore = adt.graphGets;
    // The unrecovered failure itself is not asserted to be AbapError-shaped:
    // it is the vendor client's own `AdtHTTP._request()` that puts the FINAL
    // exception on the wire back to the caller (it wraps whatever it catches
    // via its own `fromException()`, on every dispatch, independent of this
    // connection's recovery bookkeeping), and for a non-`exc:exception` body
    // (an HTML session-timeout page, as here) that wrapping falls back to a
    // generic `AdtHttpException`, not an `AbapError`. This mirrors the
    // established convention in test/connection-liveness.test.ts, where every
    // ICMENOSESSION-via-conn.get() test asserts only connection-level state
    // (`isDead`/`deathRecord`), never the thrown error's class — `isAbapError`
    // is asserted there only for a PRE-CHECKED death (`assertUsable()`
    // synthesizing its own `SESSION_DEAD`), not for the wire failure that
    // first discovers it.
    const err = await conn.get(READ_URI).then(() => undefined, (e: unknown) => e);

    expect(err).toBeDefined();
    expect(conn.isDead).toBe(true);
    expect(conn.deathRecord?.reason ?? "").toMatch(/ICMENOSESSION/);
    // Exactly one recovery attempt: the original graph GET's re-logon, no loop.
    expect(adt.graphGets).toBe(graphBefore + 1);
  });

  it("session death by ICMENOSESSION never trips the auth breaker", async () => {
    const c = clock();
    const breaker = new AuthCircuitBreaker();
    const { conn } = await connected(
      (r) => {
        if (r.url === READ_URI && r.method === "GET") return ICMENOSESSION_RESP();
        return GENERIC_OK();
      },
      { now: c.now, breaker },
    );

    await conn.get(READ_URI).catch(() => undefined);

    expect(conn.isDead).toBe(true);
    expect(breaker.isTripped).toBe(false);
  });
});

describe("ICMENOSESSION inside a stateful session", () => {
  it("a stateful session is not recovered: it dies immediately, with no re-logon", async () => {
    const c = clock();
    const PROG_URI = "/sap/bc/adt/programs/programs/zmcp_probe_rep";
    const PROG_SRC = `${PROG_URI}/source/main`;
    const { conn, adt } = await connected((r) => {
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === PROG_SRC && r.method === "PUT") return ICMENOSESSION_RESP();
      return GENERIC_OK();
    }, { now: c.now });

    const graphBefore = adt.graphGets;
    // Same reasoning as the stateless ICMENOSESSION tests above: the raw PUT
    // failure is not asserted to be AbapError-shaped (the vendor client's own
    // `fromException()` wrapping applies here too), only the connection-level
    // outcome is.
    const err = await conn
      .withStatefulSession(async (session) => {
        await session.lock(PROG_URI);
        return conn.put(PROG_SRC, { body: "* changed" });
      })
      .then(() => undefined, (e: unknown) => e);

    expect(err).toBeDefined();
    expect(conn.isDead).toBe(true);
    // No re-logon: the stateful path is refused, not recovered.
    expect(adt.graphGets).toBe(graphBefore);
  });
});
