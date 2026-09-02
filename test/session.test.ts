/**
 * Stateful session, locking and session-death classification.
 *
 * All offline: the transport is a fake `HttpClient` injected through
 * `ConnectionOptions.httpClient` (the pattern established in
 * test/circuit-breaker.test.ts). Nothing here touches a real SAP system.
 *
 * What these tests are actually protecting, in order of how expensive the bug
 * would be:
 *   1. A short dump must NOT trip the auth circuit breaker. If it did, one
 *      bad ABAP statement would disable the server for the lifetime of the
 *      process.
 *   2. Locks must be released on every exit path, including shutdown — a
 *      stranded ADT enqueue only dies with the session.
 *   3. `withFreshSession` must drop the session BEFORE running the callback,
 *      or classrun silently executes stale code.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ADTClient } from "abap-adt-api";
import { fromException } from "abap-adt-api/build/AdtException.js";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection, type ConnectionOptions } from "../src/adt/connection.js";
import { AuthCircuitBreaker, classifyAuthFailure } from "../src/adt/circuit-breaker.js";
import { GuardedHttpClient } from "../src/adt/http-guard.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import {
  StatefulSession,
  adtExceptionInfo,
  classifySessionFailure,
  extractDumpServerTime,
  extractDumpShortText,
  isLockConflict,
  isSessionDeath,
  objectUriOf,
  parseDumpPage,
  translateAdtError,
} from "../src/adt/session.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { captured, DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Fixtures captured from a live A4H session
// ---------------------------------------------------------------------------

const PROG_URI = "/sap/bc/adt/programs/programs/zmcp_probe_rep";

const LOCK_XML = (handle = "LOCKHANDLEA", isLocal = "X", corrNr = "") =>
  `<?xml version="1.0" encoding="utf-8"?>
<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>
  <LOCK_HANDLE>${handle}</LOCK_HANDLE>
  <CORRNR>${corrNr}</CORRNR><CORRUSER/><CORRTEXT/>
  <IS_LOCAL>${isLocal}</IS_LOCAL>
  <IS_LINK_UP/><MODIFICATION_SUPPORT/><SCOPE_MESSAGES/>
</DATA></asx:values></asx:abap>`;

/** Verbatim shape — including the ~700-byte LONGTEXT blob we must strip. */
const LONGTEXT_BLOB = `<HTML><HEAD></HEAD><BODY>${"An ENQUEUE lock is held; see transaction SM12. ".repeat(
  14,
)}</BODY></HTML>`;

/** `object`/`uri`/`blockingUser`/`t100` in the LOCKED envelope all scale with
 * this name — parameterised so a test can plug in a realistic long one. */
const lockConflictXml = (objectName: string) => `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceNoAccess"/>
  <message lang="EN">User DEVELOPER is currently editing ${objectName}</message>
  <localizedMessage lang="EN">User DEVELOPER is currently editing ${objectName}</localizedMessage>
  <properties>
    <entry key="LONGTEXT">${LONGTEXT_BLOB.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</entry>
    <entry key="T100KEY-ID">EU</entry>
    <entry key="T100KEY-NO">510</entry>
    <entry key="T100KEY-V1">DEVELOPER</entry>
    <entry key="T100KEY-V2">${objectName}</entry>
  </properties>
</exc:exception>`;

const LOCK_CONFLICT_XML = lockConflictXml("ZMCP_PROBE_REP");

/** The fixed part of `LOCK_HINT_TAIL` (src/adt/session.ts) — everything from
 * this anchor on is identical no matter how long the object name is. Throws
 * rather than returning a meaningless slice if the anchor is ever removed:
 * `hint.slice(-1)` on a missing anchor is 1 char, which would sail under any
 * length bound and silently stop testing anything. */
const lockHintTail = (hint: string): string => {
  const i = hint.indexOf("Locks bind to a session");
  if (i < 0) throw new Error("LOCK_HINT_TAIL anchor not found in hint: " + hint);
  return hint.slice(i);
};

/**
 * The ICM "Application Server Error" page a short dump produces.
 * ⚠️ The recon captured the three content strings but not the exact markup, so
 * this fixture is a reconstruction — see the note on `extractDumpShortText`.
 * The `Server time` block below matches the real shape seen in live
 * captures (test/fixtures/live-captured/701-…706-…): a client-side
 * `var d`/`var t` script, not a rendered string — see `extractDumpServerTime`.
 */
const DUMP_PAGE = `<!DOCTYPE html><html><head><title>Application Server Error</title>
<style>body{font-family:Arial}</style></head><body>
<h1>500 Internal Server Error</h1>
<p>Division by zero</p>
<p class="detailText"><span id="msgText">Server time:
<script>
var d = "20260731";
var t = "130257";
document.write(d.slice(0,4)+"-"+d.slice(4,6)+"-"+d.slice(6,8)+" "+t.slice(0,2)+":"+t.slice(2,4)+":"+t.slice(4,6));
</script>
</span></p>
</body></html>`;

const SESSION_GONE_PAGE = `<!DOCTYPE html><html><head><title>Session Timed Out</title></head>
<body><h1>400 Session Timed Out</h1><p>Session no longer exists</p></body></html>`;

/** The 45-byte body the LOCK verb gets on a dead session. */
const SESSION_GONE_SHORT = "400 Session Timed Out - Session no longer exists";

const ICF_LOGON_PAGE = `<!DOCTYPE html><html><head><title>Logon Error Message</title></head>
<body><h1>Anmeldung fehlgeschlagen</h1>
<form name="sap-system-login"><input name="sap-user"><input name="sap-password"></form>
</body></html>`;

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
/*
 * `DATAPREVIEW_XML` and `T000_NONPRODUCTIVE` come from
 * ./helpers/system-role-fake.js. The latter is the real 200 capture of
 * `SELECT mandt, cccategory, cccoractiv FROM t000` (fixture 087): client 000 →
 * "S", client 001 → "C". These fakes log on as client 001, so the fake system
 * is provably NON-productive — which, since the write gate became fail-closed,
 * is now a precondition for every test that expects writes/locks to work at
 * all.
 */
/** The login response MUST carry a token: `loggedin` is `csrfToken !== "fetch"`. */
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: (r: Recorded) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    // `_action=LOCK/UNLOCK` is the interesting verb, not the POST underneath.
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body };
    this.calls.push(rec);
    return this.route(rec);
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
    // What ABAP_ALLOW_WRITE will set (src/config.ts is owned by another agent).
    readOnly: false,
  });

const readOnlyCfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
  });

/** Everything the connect() handshake needs; anything else falls through. */
function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle"))
    return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

// ---------------------------------------------------------------------------
// Connection lifecycle — every connection this file opens MUST be disposed
// ---------------------------------------------------------------------------

/**
 * `AbapConnection.connect()` installs three listeners on the shared `process`
 * object (SIGINT, SIGTERM, beforeExit) so that `unlockAll()` runs even when the
 * process is killed; `dispose()` removes them again
 * (`src/adt/connection.ts:878` / `:897`).
 *
 * A server has ONE connection for its whole life, so that machinery is
 * invisible in production — but this file builds seventeen of them in one
 * process. Every connection created here is therefore tracked and disposed in
 * `afterEach`, and the listener count is asserted back to its pre-test value.
 *
 * That assertion is deliberately NOT a `setMaxListeners` bump or a warning
 * filter. `MaxListenersExceededWarning` on these three events is the *only*
 * signal that would catch the production version of this bug — a registration
 * that lost its matching removal — and the shutdown hooks exist precisely to
 * guarantee that a stranded ABAP enqueue gets released. Silencing the
 * warning would delete the alarm and keep the fire.
 */
const openConnections: AbapConnection[] = [];

/**
 * An `AbapConnection` whose process listeners are cleaned up afterwards.
 *
 * `ConnectionOptions.breaker` is now required, and threading it through the
 * ~25 call sites in this file would be noise — this helper owns it, and no
 * test in this file needs to reach the breaker it silently injects.
 */
function tracked(cfg: Config, opts: Omit<ConnectionOptions, "breaker">): AbapConnection {
  const conn = new AbapConnection(cfg, { breaker: new AuthCircuitBreaker(), ...opts });
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
  // Net-zero per test. A future test that opens a connection without going
  // through `tracked()` / `connected()` fails HERE, at the test that leaked,
  // instead of surfacing as an anonymous warning eighteen tests later.
  expect(listenerCounts()).toEqual(listenersBefore);
});

async function connected(
  route: (r: Recorded) => HttpClientResponse,
  cfg: Config = writableCfg(),
): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = tracked(cfg, { httpClient: adt, log: () => {} });
  await conn.connect();
  adt.calls.length = 0; // forget the handshake; assertions are about what follows
  return { conn, adt };
}

describe("session-death classification", () => {
  it("classifies a 500 text/html dump page", () => {
    expect(
      classifySessionFailure({
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: DUMP_PAGE,
      }),
    ).toBe("dump");
  });

  it("classifies the 400 Session Timed Out page AND its 45-byte short form", () => {
    expect(classifySessionFailure({ status: 400, body: SESSION_GONE_PAGE })).toBe(
      "session-timeout",
    );
    expect(classifySessionFailure({ status: 400, body: SESSION_GONE_SHORT })).toBe(
      "session-timeout",
    );
    expect(classifySessionFailure({ status: 400, statusText: "Session timed out" })).toBe(
      "session-timeout",
    );
  });

  it("is conservative: the status alone is never enough", () => {
    expect(classifySessionFailure({ status: 500, body: "<error/>" })).toBeUndefined();
    expect(
      classifySessionFailure({ status: 500, headers: OK_XML, body: "<exc:exception/>" }),
    ).toBeUndefined();
    expect(classifySessionFailure({ status: 400, body: "Bad Request" })).toBeUndefined();
    expect(classifySessionFailure({ status: 404, body: "Session timed out" })).toBeUndefined();
    expect(classifySessionFailure(undefined)).toBeUndefined();
  });

  it("extracts the short text and the server time from the ICM page", () => {
    expect(extractDumpShortText(DUMP_PAGE)).toBe("Division by zero");
    expect(parseDumpPage(DUMP_PAGE)).toEqual({
      shortText: "Division by zero",
      serverTime: "2026-07-31 13:02:57",
    });
    expect(extractDumpShortText("")).toBeUndefined();
  });

  /**
   * `extractDumpServerTime` was dead code on every real capture: it looked
   * for an already-rendered `Server time: YYYY-MM-DD HH:MM:SS` string, but
   * real ICF error pages compose that string client-side from a `var d` /
   * `var t` `<script>` block (see test/fixtures/live-captured/INDEX.md, "ICF
   * short-dump pages"). These six REAL captures — one per RABAX-style
   * failure mode — prove the fix against the actual wire shape, not a
   * reconstruction.
   */
  const REAL_DUMPS: Array<[string, string]> = [
    ["701-run-zcl_zmcp_dmp_zerodiv.html", "2026-08-11 12:34:41"],
    ["702-run-zcl_zmcp_dmp_msgx.html", "2026-08-11 12:34:42"],
    ["703-run-zcl_zmcp_dmp_assert.html", "2026-08-11 12:34:44"],
    ["704-run-zcl_zmcp_dmp_convt.html", "2026-08-11 12:34:45"],
    ["705-run-zcl_zmcp_dmp_itab.html", "2026-08-11 12:34:46"],
    ["706-run-zcl_zmcp_dmp_sql.html", "2026-08-11 12:34:47"],
  ];

  it.each(REAL_DUMPS)(
    "extracts the composed server time from the real capture %s",
    (file, expected) => {
      const html = captured(file);
      expect(extractDumpServerTime(html)).toBe(expected);
      expect(extractDumpShortText(html)).toBeTruthy();
    },
  );
});

describe("a short dump must NOT trip the auth breaker (recon trap #3)", () => {
  const dumpResp = {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: DUMP_PAGE,
  };
  const goneResp = { status: 400, headers: { "content-type": "text/html" }, body: SESSION_GONE_PAGE };

  it("classifyAuthFailure returns undefined for both dead-session shapes", () => {
    expect(classifyAuthFailure(dumpResp)).toBeUndefined();
    expect(classifyAuthFailure(goneResp)).toBeUndefined();
    expect(isSessionDeath(dumpResp)).toBe(true);
    expect(isSessionDeath(goneResp)).toBe(true);
  });

  it("the breaker stays closed after a dump and after a dead session", async () => {
    for (const r of [dumpResp, goneResp]) {
      const breaker = new AuthCircuitBreaker();
      const inner = new FakeAdt(() => resp(r.status, r.body, r.headers));
      const guard = new GuardedHttpClient({ baseURL: "http://x", inner }, breaker);
      const got = await guard.request({ url: "/sap/bc/adt/oo/classrun/ZX" } as HttpClientOptions);
      expect(got.status).toBe(r.status);
      expect(breaker.isTripped).toBe(false);
    }
  });

  it("but a real 401 and the ICF logon page still trip it", async () => {
    const b1 = new AuthCircuitBreaker();
    const g1 = new GuardedHttpClient(
      { baseURL: "http://x", inner: new FakeAdt(() => resp(401, "Unauthorized")) },
      b1,
    );
    await expect(g1.request({ url: "/a" } as HttpClientOptions)).rejects.toThrow(/circuit breaker/i);
    expect(b1.isTripped).toBe(true);
    expect(b1.info?.reason).toBe("http-401");

    const b2 = new AuthCircuitBreaker();
    const g2 = new GuardedHttpClient(
      {
        baseURL: "http://x",
        inner: new FakeAdt(() => resp(200, ICF_LOGON_PAGE, { "content-type": "text/html" })),
      },
      b2,
    );
    await expect(g2.request({ url: "/a" } as HttpClientOptions)).rejects.toThrow(/circuit breaker/i);
    expect(b2.info?.reason).toBe("icf-logon-page");
  });
});

describe("objectUriOf", () => {
  it("strips /source/main, query strings and fragments", () => {
    expect(objectUriOf(`${PROG_URI}/source/main`)).toBe(PROG_URI);
    expect(objectUriOf(`${PROG_URI}/source/main#start=4,0`)).toBe(PROG_URI);
    expect(objectUriOf(`${PROG_URI}?version=active`)).toBe(PROG_URI);
    expect(objectUriOf(PROG_URI)).toBe(PROG_URI);
  });
});

describe("StatefulSession locking", () => {
  const lockingRoute = (r: Recorded): HttpClientResponse => {
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML(`H_${r.url.split("/").pop()}`), OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    return resp(200, "ok", OK_TEXT);
  };

  it("locks once per object and reuses the handle — it is stable per session", async () => {
    const { conn, adt } = await connected(lockingRoute);
    const handles = await conn.withStatefulSession(async (s) => {
      const a = await s.lock(PROG_URI);
      // The source URI must resolve to the same object — no second enqueue.
      const b = await s.lock(`${PROG_URI}/source/main`);
      expect(s.heldLocks).toHaveLength(1);
      return [a.handle, b.handle];
    });
    expect(handles[0]).toBe(handles[1]);
    expect(adt.labels.filter((l) => l.startsWith("LOCK "))).toHaveLength(1);
    expect(adt.labels).toContain(`UNLOCK ${PROG_URI}`);
  });

  it("reports $TMP objects as local, needing no transport", async () => {
    const { conn } = await connected(lockingRoute);
    const info = await conn.withStatefulSession((s) => s.lock(PROG_URI));
    expect(info.isLocal).toBe(true);
    expect(info.corrNr).toBeUndefined();
  });

  it("unlocks everything in reverse order, and only once", async () => {
    const { conn, adt } = await connected(lockingRoute);
    const a = "/sap/bc/adt/programs/programs/zmcp_a";
    const b = "/sap/bc/adt/programs/programs/zmcp_b";
    await conn.withStatefulSession(async (s) => {
      await s.lock(a);
      await s.lock(b);
    });
    expect(adt.labels).toEqual([`LOCK ${a}`, `LOCK ${b}`, `UNLOCK ${b}`, `UNLOCK ${a}`]);
  });

  /**
   * REPLACES `it("never throws out of unlock, even when the server rejects it")`.
   *
   * That test asserted the swallowing as a feature: one UNLOCK, no retry, no
   * error, and a `"done"` return as if nothing had happened. What actually
   * happened is that the ABAP enqueue stayed held for the lifetime of the
   * process. Swallowing is only harmless if the session dies soon — and the
   * session of a long-lived MCP server does not die. What survives from the
   * old test is the part that was right: `unlock` is idempotent, and the
   * failure must not take the connection down with it.
   */
  it("escalates a failed unlock instead of swallowing it, and stays idempotent", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(500, "<exc/>", OK_XML);
      return resp(200, "ok", OK_TEXT);
    });
    await expect(
      conn.withStatefulSession(async (s) => {
        await s.lock(PROG_URI);
        await s.unlock(PROG_URI);
        return "done";
      }),
    ).rejects.toMatchObject({ code: "ADT_ERROR", details: { reason: "lock-leaked" } });
    // Retried, not fired once and forgotten.
    expect(adt.labels.filter((l) => l.startsWith("UNLOCK"))).toHaveLength(3);

    // …and the connection is still usable: `unlockAll()` in the `finally` did
    // not throw, so `activeSession` was cleared. A leak must not brick the server.
    adt.calls.length = 0;
    const out = await conn.withStatefulSession(async () => "second session ran");
    expect(out).toBe("second session ran");
  });

  it("unlocks when the caller's callback throws", async () => {
    const { conn, adt } = await connected(lockingRoute);
    await expect(
      conn.withStatefulSession(async (s) => {
        await s.lock(PROG_URI);
        throw new Error("caller blew up");
      }),
    ).rejects.toThrow(/caller blew up/);
    expect(adt.labels).toEqual([`LOCK ${PROG_URI}`, `UNLOCK ${PROG_URI}`]);
  });

  it("unlocks everything on shutdown while the session is still live", async () => {
    const { conn, adt } = await connected(lockingRoute);
    await conn.withStatefulSession(async (s) => {
      await s.lock(PROG_URI);
      adt.calls.length = 0;
      await conn.shutdown("SIGTERM"); // the hook registered by withStatefulSession
      expect(adt.labels).toContain(`UNLOCK ${PROG_URI}`);
      expect(s.heldLocks).toHaveLength(0);
    });
  });

  it("does not leak shutdown hooks across sessions", async () => {
    const { conn, adt } = await connected(lockingRoute);
    for (let i = 0; i < 3; i++) {
      await conn.withStatefulSession(async (s) => {
        await s.lock(PROG_URI);
      });
    }
    adt.calls.length = 0;
    await conn.shutdown("SIGTERM");
    // Three finished sessions must contribute zero unlock work at shutdown.
    expect(adt.labels.filter((l) => l.startsWith("UNLOCK"))).toHaveLength(0);
  });

  /**
   * The process-listener half of the same contract, and the reason this is a
   * test rather than a `setMaxListeners(0)`.
   *
   * `connect()` puts a SIGINT, a SIGTERM and a `beforeExit` listener on the
   * shared `process` object so that a killed process still runs `unlockAll()`;
   * `dispose()` takes them off again. If registration ever outlives removal,
   * the hooks pile up on the one object that is global to the whole runtime —
   * and the failure mode is not tidiness, it is `unlockAll()` being invoked
   * once per dead connection at shutdown while a stranded ABAP enqueue is
   * released only when its `sap-contextid` dies.
   *
   * Asserts COUNTS, not the absence of a warning string: the peak across the
   * loop pins one live connection's worth of listeners at any instant (so the
   * hooks must come off each cycle, not merely at the end), and the final
   * count pins net zero. 12 cycles is deliberately past Node's default
   * `MaxListeners` of 10, so a regression here also reproduces the warning.
   */
  it("registers and removes exactly one set of process hooks per connection", async () => {
    const CYCLES = 12;
    const baseline = listenerCounts();
    const peak = { ...baseline };

    for (let i = 0; i < CYCLES; i++) {
      const adt = new FakeAdt((r) => baseRoute(r) ?? lockingRoute(r));
      const conn = tracked(writableCfg(), { httpClient: adt, log: () => {} });
      await conn.connect();
      await conn.withStatefulSession(async (s) => {
        await s.lock(PROG_URI);
      });
      for (const [evt, n] of Object.entries(listenerCounts())) {
        peak[evt] = Math.max(peak[evt] ?? 0, n);
      }
      conn.dispose();
    }

    // One connection alive at a time ⇒ at most one hook per event above the
    // baseline. Pre-fix this climbed to baseline + 12.
    expect(peak).toEqual(
      Object.fromEntries(Object.entries(baseline).map(([evt, n]) => [evt, n + 1])),
    );
    // …and nothing survives the loop.
    expect(listenerCounts()).toEqual(baseline);
  });

  it("translates a 403 lock conflict into AbapError(LOCKED) with the blocking user", async () => {
    const { conn } = await connected((r) => {
      if (r.qs._action === "LOCK") return resp(403, LOCK_CONFLICT_XML, OK_XML);
      return resp(200, "ok", OK_TEXT);
    });

    const err = await conn
      .withStatefulSession((s) => s.lock(PROG_URI))
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(isAbapError(err)).toBe(true);
    const e = err as import("../src/adt/errors.js").AbapError;
    expect(e.code).toBe("LOCKED");
    expect(e.message).toMatch(/DEVELOPER is currently editing ZMCP_PROBE_REP/);
    expect(e.details.blockingUser).toBe("DEVELOPER");
    expect(e.details.object).toBe("ZMCP_PROBE_REP");
    expect(e.details.adtExceptionType).toBe("ExceptionResourceNoAccess");

    // The ~700-byte LONGTEXT HTML blob is 70% of the payload and says
    // nothing the short text doesn't. It must not reach the model.
    const rendered = JSON.stringify(e.toJSON());
    expect(rendered).not.toMatch(/LONGTEXT/i);
    expect(rendered).not.toMatch(/SM12/);
    expect(rendered).not.toMatch(/<HTML>/i);

    // `object`/`uri`/`blockingUser`/`t100` all scale with the caller's object
    // name, so capping the whole envelope pins this fixture's short name, not
    // the guard above. Assert the one part that is genuinely fixed instead:
    // `LOCK_HINT_TAIL` (src/adt/session.ts) never varies with the object.
    expect(e.hint).toContain("Do NOT retry in a loop; there is no lock timeout");
    expect(lockHintTail(e.hint!).length).toBeLessThan(450);
  });

  it("keeps the LOCKED hint's fixed guidance intact for a long namespaced object name", async () => {
    const objectName = "/ACMEGRP/CL_VERY_LONG_BUSINESS_OBJECT_NAME";
    const { conn } = await connected((r) => {
      if (r.qs._action === "LOCK") return resp(403, lockConflictXml(objectName), OK_XML);
      return resp(200, "ok", OK_TEXT);
    });

    const err = await conn
      .withStatefulSession((s) => s.lock(PROG_URI))
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(isAbapError(err)).toBe(true);
    const e = err as import("../src/adt/errors.js").AbapError;
    expect(e.details.object).toBe(objectName);

    const rendered = JSON.stringify(e.toJSON());
    expect(rendered).not.toMatch(/LONGTEXT/i);
    expect(rendered).not.toMatch(/SM12/);
    expect(rendered).not.toMatch(/<HTML>/i);
    // Deliberately no assertion on `rendered.length` here: `object`/`uri`/
    // `t100` all scale with the name above, so any bound on the whole
    // envelope would pin this particular name, not a behaviour — the exact
    // defect this test replaces. A future change that shrinks the envelope
    // (e.g. dropping `t100`) must not fail this test.

    expect(e.hint).toContain("Do NOT retry in a loop; there is no lock timeout");
    expect(lockHintTail(e.hint!).length).toBeLessThan(450);
  });

  it("rejects a nested stateful session instead of corrupting the lock ledger", async () => {
    const { conn } = await connected(lockingRoute);
    await conn.withStatefulSession(async (s) => {
      await s.lock(PROG_URI);
      await expect(conn.withStatefulSession(async () => 1)).rejects.toThrow(/nested/i);
      // The outer session is untouched.
      expect(s.heldLocks.map((l) => l.uri)).toEqual([PROG_URI]);
    });
  });

  it("refuses to open a stateful session on a read-only connection", async () => {
    const { conn } = await connected(lockingRoute, readOnlyCfg());
    expect(conn.readOnly).toBe(true);
    await expect(conn.withStatefulSession(async () => 1)).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "READ_ONLY",
    );
  });
});

describe("read-only policy", () => {
  /** Everything except the T000 probe, which is left un-routed → inconclusive. */
  const noT000 = (r: Recorded): HttpClientResponse | undefined => {
    if (r.url.includes("/datapreview/freestyle")) return undefined;
    return baseRoute(r);
  };

  it("stays read-only when the system cannot be classified", async () => {
    const adt = new FakeAdt((r) => noT000(r) ?? resp(200, "ok", OK_TEXT));
    const conn = tracked(readOnlyCfg(), { httpClient: adt, log: () => {} });
    await conn.connect();
    expect(conn.systemRole).toBe("unknown");
    expect(conn.roleDetection.role).toBe("inconclusive");
    expect(conn.readOnly).toBe(true);
    expect(conn.readOnlyReason).toMatch(/could NOT be proven non-productive/i);
  });

  it("REFUSES writes on an unclassifiable system even when explicitly opted in", async () => {
    const warnings: string[] = [];
    const adt = new FakeAdt((r) => noT000(r) ?? resp(200, "ok", OK_TEXT));
    const conn = tracked(writableCfg(), {
      httpClient: adt,
      log: (m) => warnings.push(m),
    });
    await conn.connect();
    expect(conn.roleDetection.role).toBe("inconclusive");
    expect(conn.systemRole).toBe("unknown");
    // The whole point: ABAP_ALLOW_WRITE does not get a vote here.
    expect(conn.readOnly).toBe(true);
    expect(conn.writesLockedOut).toBe(true);
    expect(warnings.join("\n")).toMatch(/INCONCLUSIVE/);
    expect(warnings.join("\n")).toMatch(/ABAP_ALLOW_WRITE was set but is NOT honoured/i);
  });

  it("honours the write opt-in only once the system is PROVEN non-productive", async () => {
    const { conn } = await connected(() => resp(200, "ok", OK_TEXT), writableCfg());
    expect(conn.roleDetection.role).toBe("nonproductive");
    expect(conn.roleDetection.client).toBe("001");
    expect(conn.roleDetection.ccCategory).toBe("C");
    expect(conn.systemRole).toBe("development"); // legacy-union view
    expect(conn.readOnly).toBe(false);
    expect(conn.writesLockedOut).toBe(false);
  });

  it("forces read-only on a productive system with no override", async () => {
    const adt = new FakeAdt((r) => {
      if (r.url.includes("/ato/settings")) {
        return resp(200, `<settings isProductionSystem="true"/>`, OK_XML);
      }
      return baseRoute(r) ?? resp(200, "ok", OK_TEXT);
    });
    const conn = tracked(writableCfg(), { httpClient: adt, log: () => {} });
    await conn.connect();
    expect(conn.systemRole).toBe("productive");
    expect(conn.readOnly).toBe(true); // even though cfg.readOnly === false
    expect(conn.readOnlyReason).toMatch(/PRODUCTIVE/);
  });
});

describe("withFreshSession (recon trap #2 — classrun runs stale code)", () => {
  it("drops the session BEFORE invoking the callback", async () => {
    const { conn, adt } = await connected(() => resp(200, "output", OK_TEXT));
    const order: string[] = [];
    const out = await conn.withFreshSession(async (client) => {
      order.push(...adt.labels); // whatever happened before the callback ran
      await client.httpClient.request("/sap/bc/adt/oo/classrun/ZCL_X", {
        method: "POST",
      } as never);
      return "ran";
    });
    expect(out).toBe("ran");
    // The drop is the FIRST thing on the wire; the run is strictly after it.
    expect(order).toEqual(["GET /sap/bc/adt/compatibility/graph"]);
    expect(adt.labels).toEqual([
      "GET /sap/bc/adt/compatibility/graph",
      "POST /sap/bc/adt/oo/classrun/ZCL_X",
    ]);
  });

  it("refuses to drop a session that still holds locks", async () => {
    const { conn } = await connected((r) => {
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      return resp(200, "ok", OK_TEXT);
    });
    await conn.withStatefulSession(async (s) => {
      await s.lock(PROG_URI);
      await expect(conn.withFreshSession(async () => 1)).rejects.toThrow(/holds locks/i);
    });
  });

  it("survives a dropSession that fails because the session is already dead", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url.includes("/compatibility/graph")) return resp(400, SESSION_GONE_SHORT, OK_TEXT);
      return resp(200, "output", OK_TEXT);
    });
    // The goal of the drop is "no stale ABAP session"; a 400 Session Timed Out
    // means that goal is already met, so the callback must still run.
    const out = await conn.withFreshSession(async () => "ran");
    expect(out).toBe("ran");
    expect(adt.labels[0]).toBe("GET /sap/bc/adt/compatibility/graph");
    expect(conn.breaker.isTripped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Structural classification, on REAL captured bodies
// ---------------------------------------------------------------------------

/**
 * The genuine ICM "Application Server Error" page a short dump returns:
 * `test/fixtures/live-captured/016-trigger-classrun.xml`, 9,993 bytes,
 * `500 text/html; charset=windows-1252`.
 * Not a reconstruction — this is what came off the wire.
 */
const REAL_DUMP_PAGE = captured("016-trigger-classrun.xml");

/**
 * The same captured page with ONLY the human-readable prose localised; every
 * tag, class and id is byte-for-byte the original. This is what the appliance
 * returns when the logon language is German — and it is the case the old
 * English-only `DUMP_MARKERS` could not classify, so a short dump surfaced as a
 * generic `ADT_ERROR` and the caller retried against a session that no longer
 * existed.
 *
 * NB: the German strings themselves are translations, not captures — no
 * German-language body exists in `test/fixtures/`. That is exactly why the fix
 * matches on `class="errorTextHeader"` / `id="msgText"` instead of on these.
 */
const REAL_DUMP_PAGE_DE = REAL_DUMP_PAGE.replace(
  /Application Server Error/g,
  "Fehler des Applikationsservers",
)
  .replace(/500 Internal Server Error/g, "500 Interner Serverfehler")
  .replace(/Communication failure/g, "Kommunikationsfehler");

/** A real parsed `<exc:exception>` envelope — the negative control. */
const REAL_EXC_ENVELOPE = captured("041-stack-after-terminate.xml");

const HTML_500 = { "content-type": "text/html; charset=windows-1252" };

/** Replay a captured body through the REAL abap-adt-api error path. */
function thrownByLibrary(status: number, statusText: string, headers: object, body: string) {
  try {
    throw fromException({ status, statusText, headers, body }, {});
  } catch (e) {
    return e;
  }
}

describe("session-death classification is structural, not prose (B9)", () => {
  it("classifies the REAL captured ICM dump page", () => {
    expect(classifySessionFailure({ status: 500, headers: HTML_500, body: REAL_DUMP_PAGE })).toBe(
      "dump",
    );
  });

  it("classifies the same page when the appliance answers in German", () => {
    // Pre-fix this was `undefined`: every marker was English prose.
    expect(classifySessionFailure({ status: 500, headers: HTML_500, body: REAL_DUMP_PAGE_DE })).toBe(
      "dump",
    );
  });

  it("classifies the ICM page on its markup alone, with no readable prose at all", () => {
    // Locale-independence, taken to the limit: strip every word we ever matched
    // on. `class="errorTextHeader"` is not a language.
    const noProse = REAL_DUMP_PAGE_DE.replace(/Fehler|Serverfehler|Applikationsservers/g, "…");
    expect(classifySessionFailure({ status: 500, headers: HTML_500, body: noProse })).toBe("dump");
  });

  it("a German 400 body is still a session timeout", () => {
    expect(
      classifySessionFailure({ status: 400, body: "400 Die Sitzung existiert nicht mehr" }),
    ).toBe("session-timeout");
    expect(classifySessionFailure({ status: 400, statusText: "Sitzung ist abgelaufen" })).toBe(
      "session-timeout",
    );
  });

  /**
   * The conservatism `circuit-breaker.ts`'s `classifyFailure` depends on (its
   * `status >= 500` branch, which treats a 500 as transient), restated against a
   * REAL envelope rather than a hand-written `<exc:exception/>`: an `AdiFailed`
   * 500 is an ordinary error and must stay transient. Widening the 500 branch
   * far enough to catch this would make every 500 a session death.
   */
  it("does NOT classify a real 500 <exc:exception> envelope as a dump", () => {
    expect(
      classifySessionFailure({
        status: 500,
        headers: { "content-type": "application/xml" },
        body: REAL_EXC_ENVELOPE,
      }),
    ).toBeUndefined();
    expect(isSessionDeath({ status: 500, body: REAL_EXC_ENVELOPE })).toBe(false);
  });

  it("translates a German dump into SESSION_DEAD through the real abap-adt-api path", () => {
    // End to end: the library's own error construction, then our translation.
    const e = thrownByLibrary(500, "Internal Server Error", HTML_500, REAL_DUMP_PAGE_DE);
    expect(translateAdtError(e, { operation: "run" }).code).toBe("SESSION_DEAD");
  });

  it("recovers the response from an AdtHttpException's parent", () => {
    // `AdtHttpException` exposes no `.response` of its own; the dump page only
    // survives on `.parent.response`. Without the walk this was an ADT_ERROR.
    const wrapped = Object.assign(new Error("Request failed with status code 500"), {
      status: 500,
      parent: { response: { status: 500, statusText: "Internal Server Error", headers: HTML_500, body: REAL_DUMP_PAGE } },
    });
    expect(translateAdtError(wrapped, { operation: "run" }).code).toBe("SESSION_DEAD");
  });

  it("a real parsed envelope stays ADT_ERROR end to end", () => {
    const e = thrownByLibrary(
      500,
      "Internal Server Error",
      { "content-type": "application/xml" },
      REAL_EXC_ENVELOPE,
    );
    expect(translateAdtError(e, { operation: "run" }).code).toBe("ADT_ERROR");
  });
});

// ---------------------------------------------------------------------------
// The generic ADT_ERROR fallback must carry a hint
// ---------------------------------------------------------------------------
//
// Pre-fix, the catch-all at the bottom of `translateAdtError` constructed
// `AbapError` with no 4th argument at all, so `.hint` was `undefined` and
// `toJSON()`/the tool-error envelope omitted the `hint` key entirely — the
// live incident this pins: `TRANSPORT_ERROR: "Request failed with status
// code 400"` reached a caller with `details.operation: "trRequirement"` and
// nothing else to act on (see the `CONTENTLESS_HTTP_MESSAGE_RE` doc comment
// in src/adt/session.ts). The `ctsError` half of that incident is covered in
// transports-verify.test.ts; this covers the sibling `ADT_ERROR` fallback in
// `translateAdtError` itself.
describe("translateAdtError — ADT_ERROR fallback carries a hint", () => {
  it("the unclassified fallback is non-empty and points at the adt envelope and S_DEVELOP", () => {
    const e = thrownByLibrary(
      500,
      "Internal Server Error",
      { "content-type": "application/xml" },
      REAL_EXC_ENVELOPE,
    );
    const err = translateAdtError(e, { operation: "run" });
    expect(err.code).toBe("ADT_ERROR");
    expect(err.hint).toBeTruthy();
    expect(err.hint).toMatch(/adt\.localizedMessage/);
    expect(err.hint).toMatch(/adt\.t100/);
    expect(err.hint).toMatch(/S_DEVELOP/);
    // The one wrong move this hint has to close off.
    expect(err.hint).toMatch(/do not retry/i);
    // And the one it must NOT make. An earlier draft told the caller to
    // "verify it exists with abap_search", which `test/source.test.ts`'s C1
    // guard rejected: steering an unclassified 500 toward a missing-object
    // story is the exact misdirection C1 was filed about. This branch knows
    // less than any other in the function, so it is the last one entitled to
    // suggest a cause. Kept as a positive assertion so the wording cannot
    // drift back.
    expect(err.hint).not.toMatch(/abap_search/);
  });

  it("does not leak onto NOT_FOUND, whose own hint stays exactly what it was", () => {
    const e = thrownByLibrary(
      404,
      "Not Found",
      { "content-type": "application/xml" },
      `<?xml version="1.0"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
        `<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>` +
        `<message lang="EN">Object PROG/ZMCP_NOPE does not exist</message></exc:exception>`,
    );
    const err = translateAdtError(e, { operation: "read", name: "ZMCP_NOPE" });
    expect(err.code).toBe("NOT_FOUND");
    expect(err.hint).toBe("Check the name with abap_search, or create the object first.");
  });

  it("does not leak onto LOCKED, whose own hint keeps its no-retry-loop wording", () => {
    const e = thrownByLibrary(403, "Forbidden", OK_XML, LOCK_CONFLICT_XML);
    const err = translateAdtError(e, { operation: "lock" });
    expect(err.code).toBe("LOCKED");
    expect(err.hint).toMatch(/Do NOT retry in a loop/);
    expect(err.hint).not.toMatch(/adt\.localizedMessage/);
  });
});

// ---------------------------------------------------------------------------
// A lock conflict must not be reported as an authorization failure
// ---------------------------------------------------------------------------

/**
 * REAL live capture, not reconstructed. Captured live against A4H on
 * 2026-08-01 by a stateless probe run (label `t2-create-2-recreate`): a
 * create-after-delete on `ZMCP_LK_P` (lock a program, DELETE it, then POST a
 * CREATE for the same name while the lock is still held). It replaces an
 * earlier fixture that had been reconstructed from prose alone, without these
 * bytes, under the name `ZMCP_NL2_PROG`.
 *
 * The real bytes prove one thing that reconstruction did not capture:
 * `<message>` carries the exact same text as `<localizedMessage>` (both
 * `lang="EN"`, both "User DEVELOPER is currently editing ZMCP_LK_P") — the
 * reconstruction only recorded the `<localizedMessage>` value.
 * `<properties/>` is confirmed self-closing empty.
 */
const LK_P_CREATE_403 = captured("602-t2-create-2-recreate.xml");

describe("isLockConflict recognizes ExceptionResourceNoAuthorization when corroborated by text", () => {
  it("classifies the live-captured create-path 403 (empty <properties/>, type ExceptionResourceNoAuthorization) as a lock conflict", () => {
    // Replayed through the REAL abap-adt-api parsing path, exactly like the
    // structural-classification block above — not a hand-built plain
    // object — so the test also proves the fixture actually parses as
    // `fromResponse` expects.
    const e = thrownByLibrary(403, "Forbidden", OK_XML, LK_P_CREATE_403);
    expect(isLockConflict(e)).toBe(true);

    const err = translateAdtError(e, { operation: "create", name: "ZMCP_LK_P" });
    // Pre-fix this was ADT_ERROR (in practice AUTH-flavoured) —
    // the whole point of the fix is that this reaches the user as LOCKED.
    expect(err.code).toBe("LOCKED");
    expect(err.message).toMatch(/currently editing/i);
  });

  /**
   * The false-positive guard the doc comment on `isLockConflict` argues for:
   * `ExceptionResourceNoAuthorization` is ALSO the real SAP type id for a
   * genuine missing-authorization refusal, so the type id must never decide
   * this alone. Same 403 + same type id as the fixture above, but a message
   * that is unambiguously a permission refusal, not a lock — this must stay
   * classified as NOT a lock conflict, or a real "you are not authorized"
   * error would be told to the user as "just retry, someone's editing it".
   */
  it("does NOT classify a genuine authorization failure with the SAME type id as a lock conflict", () => {
    const authFailureXml = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceNoAuthorization"/>
  <message lang="EN">No authorization to create objects in package $TMP</message>
  <localizedMessage lang="EN">No authorization to create objects in package $TMP</localizedMessage>
  <properties/>
</exc:exception>`;
    const e = thrownByLibrary(403, "Forbidden", OK_XML, authFailureXml);
    expect(isLockConflict(e)).toBe(false);

    const err = translateAdtError(e, { operation: "create", name: "ZMCP_AUTH_PROBE" });
    expect(err.code).not.toBe("LOCKED");
    expect(err.code).toBe("ADT_ERROR");
  });

  it("still recognizes the original ExceptionResourceNoAccess shape (no regression from the fix)", () => {
    const e = thrownByLibrary(403, "Forbidden", OK_XML, LOCK_CONFLICT_XML);
    expect(isLockConflict(e)).toBe(true);
    expect(translateAdtError(e, { operation: "lock" }).code).toBe("LOCKED");
  });
});

// ---------------------------------------------------------------------------
// B8 — a failed UNLOCK must not strand the ABAP enqueue
// ---------------------------------------------------------------------------

/**
 * An `AdtErrorException`-shaped throw: `adtExceptionInfo` keys on a numeric
 * `.err`, which is what `abap-adt-api` sets (`AdtException.js:47`).
 */
const adtThrow = (status: number, message: string): Error =>
  Object.assign(new Error(message), { err: status, properties: {} });

/**
 * Minimal `ADTClient` stand-in — `lock`/`unLock` are all `StatefulSession` touches.
 *
 * `onUnlock` may be sync OR return a promise: `await`ing it is a no-op for every
 * existing sync hook (`await undefined` resolves immediately), so this is purely
 * additive — it exists so a hook can stand in for a slow transport (e.g. a
 * request that takes real wall-clock time before failing), which the unlock
 * BUDGET tests below need and no existing caller does.
 */
function fakeLockClient(
  onUnlock: (uri: string, nthForThisUri: number) => void | Promise<void> = () => {},
) {
  const unlocks: string[] = [];
  const counts = new Map<string, number>();
  const client = {
    async lock(uri: string) {
      return { LOCK_HANDLE: `H${uri.slice(-1).toUpperCase()}`, IS_LOCAL: "X" };
    },
    async unLock(uri: string, handle: string) {
      unlocks.push(`${uri}#${handle}`);
      const n = (counts.get(uri) ?? 0) + 1;
      counts.set(uri, n);
      await onUnlock(uri, n);
    },
  } as unknown as ADTClient;
  return { client, unlocks };
}

const A = "/sap/bc/adt/programs/programs/zmcp_a";
const B = "/sap/bc/adt/programs/programs/zmcp_b";
const C = "/sap/bc/adt/programs/programs/zmcp_c";

/** No wall-clock cost for the backoff. */
const fast = { unlockRetryDelayMs: 0, sleep: async () => {}, log: () => {} };

describe("a failed UNLOCK is retried and escalated, never swallowed (B8)", () => {
  it("retries, then throws a structured error naming the object and the lock handle", async () => {
    const leaks: AbapError[] = [];
    const { client, unlocks } = fakeLockClient(() => {
      throw adtThrow(500, "Internal Server Error");
    });
    const s = new StatefulSession(client, { ...fast, onLockLeak: (e) => leaks.push(e) });
    await s.lock(A);

    const err = await s.unlock(A).catch((e: unknown) => e);

    // Retried — the old code fired UNLOCK once and logged the failure away.
    expect(unlocks).toEqual([`${A}#HA`, `${A}#HA`, `${A}#HA`]);
    expect(isAbapError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "ADT_ERROR",
      details: { reason: "lock-leaked", uri: A, lockHandle: "HA", attempts: 3, operation: "unlock" },
    });
    // Visible to the caller AND to the journal, not just to a log line.
    expect(leaks).toHaveLength(1);
    expect(s.leakedLocks).toHaveLength(1);
    // The ledger is clear, so nothing can spin on this handle forever.
    expect(s.heldLocks).toEqual([]);
  });

  it("stops as soon as the unlock succeeds, and reports no leak", async () => {
    const { client, unlocks } = fakeLockClient((_uri, n) => {
      if (n === 1) throw adtThrow(500, "Internal Server Error");
    });
    const s = new StatefulSession(client, fast);
    await s.lock(A);
    await expect(s.unlock(A)).resolves.toBeUndefined();
    expect(unlocks).toHaveLength(2);
    expect(s.leakedLocks).toEqual([]);
  });

  it("one stranded lock does not stop unlockAll from releasing the rest", async () => {
    const leaks: AbapError[] = [];
    const { client, unlocks } = fakeLockClient((uri) => {
      if (uri === B) throw adtThrow(500, "Internal Server Error");
    });
    const s = new StatefulSession(client, { ...fast, onLockLeak: (e) => leaks.push(e) });
    await s.lock(A);
    await s.lock(B);
    await s.lock(C);

    // Must not throw: `connection.ts:417` awaits this inside a `finally` whose
    // remaining statements keep the connection usable.
    await expect(s.unlockAll()).resolves.toBeUndefined();

    // Reverse order, and C and A were released despite B failing three times.
    expect(unlocks).toEqual([`${C}#HC`, `${B}#HB`, `${B}#HB`, `${B}#HB`, `${A}#HA`]);
    expect(leaks).toHaveLength(1);
    expect(leaks[0]?.details.uri).toBe(B);
    expect(s.heldLocks).toEqual([]);
  });

  it("does not retry or report a leak when the session itself died", async () => {
    // Dropping the session releases every lock it held. Retrying an UNLOCK
    // against a dead session is three guaranteed-useless round trips, and
    // calling it a leaked enqueue would be a lie.
    const { client, unlocks } = fakeLockClient(() => {
      throw adtThrow(400, SESSION_GONE_SHORT);
    });
    const s = new StatefulSession(client, fast);
    await s.lock(A);
    await expect(s.unlock(A)).resolves.toBeUndefined();
    expect(unlocks).toHaveLength(1);
    expect(s.leakedLocks).toEqual([]);
    expect(s.heldLocks).toEqual([]);
  });

  it("never sends two UNLOCKs for one handle, even when called concurrently", async () => {
    const { client, unlocks } = fakeLockClient();
    const s = new StatefulSession(client, fast);
    await s.lock(A);
    await Promise.all([s.unlock(A), s.unlock(A), s.unlockAll()]);
    expect(unlocks).toEqual([`${A}#HA`]);
  });

  /**
   * D5(a). The UNLOCK retry loop and the auth circuit breaker used to know
   * nothing about each other. If credentials were rejected mid-session — an
   * ICF password expiry, an admin resetting the user, a 401 on the very
   * request that was holding the lock — `releaseLock()` kept firing its full
   * retry budget of `unLock()` calls into a system that had just refused this
   * process, and each one is another attempt against the five the ICF lockout
   * counter allows. The retries could not possibly succeed: the same breaker,
   * one layer up in `GuardedHttpClient`, refuses every one of them anyway.
   *
   * The check goes at the TOP of each iteration, so the first attempt is
   * unaffected (the breaker is still closed when it runs) and only the retries
   * are cut. The lock is then reported leaked through the existing path — it
   * genuinely is leaked, and saying otherwise would strand an ABAP enqueue
   * silently.
   */
  it("stops retrying UNLOCK the moment the auth breaker latches (D5a)", async () => {
    let tripped = false;
    const { client, unlocks } = fakeLockClient(() => {
      // The failure that "carried" the auth rejection: from here on the
      // breaker is latched, exactly as `GuardedHttpClient` would have latched
      // it on the way back from this same call.
      tripped = true;
      throw adtThrow(500, "Internal Server Error");
    });
    const leaks: AbapError[] = [];
    const s = new StatefulSession(client, {
      ...fast,
      onLockLeak: (e) => leaks.push(e),
      isBreakerTripped: () => tripped,
    });
    await s.lock(A);

    const err = await s.unlock(A).catch((e: unknown) => e);

    // ONE request, not the default three: attempts 2 and 3 were refused
    // locally before they could reach the wire.
    expect(unlocks).toEqual([`${A}#HA`]);
    // Still escalated, not swallowed — the enqueue really is stranded.
    expect(isAbapError(err)).toBe(true);
    expect(err).toMatchObject({ code: "ADT_ERROR", details: { reason: "lock-leaked", uri: A } });
    expect(leaks).toHaveLength(1);
    expect(s.heldLocks).toEqual([]);
  });

  it("still uses the FULL retry budget while the breaker stays closed (D5a control)", async () => {
    // The companion to the test above: `isBreakerTripped` must be a gate that
    // is actually consulted, not one that always fires. A `() => false`
    // callback must behave exactly like supplying nothing at all.
    const { client, unlocks } = fakeLockClient(() => {
      throw adtThrow(500, "Internal Server Error");
    });
    const s = new StatefulSession(client, { ...fast, isBreakerTripped: () => false });
    await s.lock(A);
    await expect(s.unlock(A)).rejects.toSatisfy((e: unknown) => isAbapError(e));
    expect(unlocks).toEqual([`${A}#HA`, `${A}#HA`, `${A}#HA`]);
  });

  /**
   * `unlockBudgetMs` — the wall-clock cap `UNLOCK_BUDGET_MS`'s doc comment
   * exists to explain. Pre-fix, `releaseLock` retried purely by ATTEMPT COUNT:
   * `1 + unlockRetries` = 3 tries, each one a POST that sits under this
   * connection's axios timeout (`cfg.timeoutMs`, default 60_000 ms) before it
   * can fail. Against an appliance that has stopped answering, that is
   *
   *     3 * 60_000 + 150 + 300 = 180_450 ms  — THREE MINUTES
   *
   * parked in a `finally`, after the PUT the caller actually asked for had
   * already succeeded. Every existing B8 test above uses `sleep: async () =>
   * {}`, which zeroes out the BACKOFF but says nothing about a slow UNLOCK
   * itself — offline, the fake transport answers instantly, so the 180 s
   * ceiling was entirely unobservable before this test existed.
   *
   * This is the case the budget exists for: a transport whose UNLOCK just sits
   * there (a stand-in for "under the 60 s axios timeout") before failing. One
   * attempt alone (1200 ms, real wall-clock via `setTimeout` in the `onUnlock`
   * hook — NOT the injected `sleep`, which only covers backoff) already spends
   * more than the 1000 ms budget, so attempts 2 and 3 must never start.
   *
   * The `elapsed >= ~1150 ms` assertion is the "no in-flight request is
   * abandoned" half of the contract: the budget gates STARTING a new UNLOCK,
   * it never races or aborts the one already sent — so `unlock()` must not
   * resolve/reject before the one real attempt actually finished.
   */
  it("stops retrying once the unlock budget is spent, however slow the transport is", async () => {
    const { client, unlocks } = fakeLockClient(async () => {
      await new Promise((r) => setTimeout(r, 1200)); // stands in for the 60s axios timeout
      throw adtThrow(500, "Internal Server Error");
    });
    const s = new StatefulSession(client, { ...fast, unlockBudgetMs: 1000 });
    await s.lock(A);

    const t0 = Date.now();
    const err = await s.unlock(A).catch((e: unknown) => e);
    const elapsed = Date.now() - t0;

    // Attempt 1 already blew the budget — attempts 2 and 3 never fired.
    expect(unlocks).toEqual([`${A}#HA`]);
    // The in-flight attempt was awaited to completion, not abandoned early.
    expect(elapsed).toBeGreaterThanOrEqual(1150);
    expect(isAbapError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "ADT_ERROR",
      details: { reason: "lock-leaked", uri: A, lockHandle: "HA" },
    });
    // NB: `details.attempts`/the message text both say "3 attempts" even here
    // — that field is the CONFIGURED budget (`1 + unlockRetries`), not the
    // number actually sent. The true count survives only inside
    // `details.cause`, asserted below — see the report for this finding.
    expect((err as AbapError).details.cause).toMatch(/gave up after 1 of 3 attempts/i);
    expect((err as AbapError).details.cause).toMatch(/unlock budget was spent/i);
  });

  /**
   * The companion control: a healthy appliance that is merely SLOW — nowhere
   * near the 60 s axios timeout — must still get its full three-attempt
   * budget. This is the whole reason `UNLOCK_BUDGET_MS` is 5 s and not, say,
   * 500 ms: the doc comment's own arithmetic (~1.5 s/attempt ⇒ the third
   * attempt starts at 3.45 s) shows a generous margin so the cap never
   * silently shrinks B8's retry budget on ordinary latency. Each fake attempt
   * here costs 100 ms of REAL wall-clock (via `setTimeout`, not `sleep`), so
   * three attempts total ~300 ms against a 2 s budget — comfortably inside,
   * proving the cap did not fire.
   */
  it("still spends the full retry budget when the appliance is slow but alive, not dead", async () => {
    const { client, unlocks } = fakeLockClient(async () => {
      await new Promise((r) => setTimeout(r, 100));
      throw adtThrow(500, "Internal Server Error");
    });
    const s = new StatefulSession(client, { ...fast, unlockBudgetMs: 2000 });
    await s.lock(A);

    const err = await s.unlock(A).catch((e: unknown) => e);

    // All three attempts fired — the budget did not cut the normal case short.
    expect(unlocks).toEqual([`${A}#HA`, `${A}#HA`, `${A}#HA`]);
    expect(isAbapError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "ADT_ERROR",
      details: { reason: "lock-leaked", uri: A, attempts: 3 },
    });
  });

  /**
   * Escalation semantics survive the budget change: the two other
   * `UNLOCK_NOT_A_LEAK` bail-outs (`SESSION_DEAD` above, `LOCKED` in
   * `test/lock-conflict-ux.test.ts`'s "D. releaseLock does not retry on
   * LOCKED" block) already have single-attempt, no-escalation coverage
   * elsewhere in this repo — this fills the one gap, `NOT_FOUND`, which
   * neither file pins for the UNLOCK retry path specifically. A generous
   * `unlockBudgetMs` is supplied so this also demonstrates the bail-out fires
   * on its own (before the budget is ever consulted), not because the budget
   * happened to run out.
   */
  it("does not retry or report a leak when the object no longer exists (NOT_FOUND)", async () => {
    const { client, unlocks } = fakeLockClient(() => {
      throw adtThrow(404, "Not Found");
    });
    const s = new StatefulSession(client, { ...fast, unlockBudgetMs: 60_000 });
    await s.lock(A);
    await expect(s.unlock(A)).resolves.toBeUndefined();
    expect(unlocks).toHaveLength(1);
    expect(s.leakedLocks).toEqual([]);
    expect(s.heldLocks).toEqual([]);
  });

  it("a throwing onLockLeak sink cannot break the cleanup path", async () => {
    const { client } = fakeLockClient(() => {
      throw adtThrow(500, "Internal Server Error");
    });
    const s = new StatefulSession(client, {
      ...fast,
      onLockLeak: () => {
        throw new Error("journal is on fire");
      },
    });
    await s.lock(A);
    await expect(s.unlockAll()).resolves.toBeUndefined();
    expect(s.leakedLocks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// axios's own generic message must never become "the diagnostic"
// ---------------------------------------------------------------------------

/**
 * Reproduces the REAL vendor degrade path, not a hand-shaped stand-in for it:
 * `abap-adt-api`'s `AdtHTTP._request` wraps any axios failure as a genuine
 * `HttpClientException` (`AdtHTTP.js`) whose `.message` is axios's own
 * `"Request failed with status code N"`, generated client-side from the
 * status alone, before any response body is inspected. `AdtException.js`'s
 * `fromError` then tries `fromResponse(error.response.body, error.response)`
 * to recover something better from the body; when that throws — an empty
 * body, HTML, or any shape that isn't the `<exc:exception>` root it insists
 * on — the `catch (e) {}` silently swallows it and falls through to
 * `new AdtHttpException(error)`, whose `get message()` is a bare
 * `return this.parent.message` — i.e. the exact axios sentence, with the
 * response BODY still sitting untouched on `.parent.response.body`. Calling
 * the real `fromException` (as `abap-adt-api` itself does, and as
 * `thrownByLibrary` above already does for the `exc:exception`-shaped cases)
 * is what makes this a fixture proving the actual leak, not a guess at it.
 */
function axiosLeakLikeException(status: number, statusText: string, body: string): unknown {
  const httpErr = new HttpClientException(
    `Request failed with status code ${status}`,
    "ERR_BAD_REQUEST",
    status,
    {},
    {},
    { status, statusText, headers: {}, body },
    undefined,
  );
  try {
    throw fromException(httpErr, {});
  } catch (e) {
    return e;
  }
}

/**
 * The OTHER real vendor branch: `fromError` only even attempts
 * `fromResponse(error.response.body, …)` when `error.response` is truthy at
 * all — a `HttpClientException` with no `.response` (a connection-level axios
 * failure, no HTTP response ever arrived) skips straight to
 * `new AdtHttpException(error)`, no body to have tried and failed to parse.
 * This is the genuine "there is nothing to scrape" case, as opposed to the
 * "there was a body but it didn't parse" case the fixture above exercises.
 */
function axiosLeakNoResponseException(status: number): unknown {
  const httpErr = new HttpClientException(
    `Request failed with status code ${status}`,
    "ERR_BAD_REQUEST",
    status,
    {},
    {},
    undefined,
    undefined,
  );
  try {
    throw fromException(httpErr, {});
  } catch (e) {
    return e;
  }
}

describe("adtExceptionInfo never surfaces axios's own contentless message when a body exists", () => {
  it("degrades to AdtHttpException on an unparseable body, and repairs the message from the body text", () => {
    const e = axiosLeakLikeException(400, "Bad Request", "<html><body>Bad Gateway upstream</body></html>");
    const info = adtExceptionInfo(e);
    expect(info).toBeDefined();
    expect(info?.status).toBe(400);
    // The bug this pins: pre-fix, this was literally "Request failed with
    // status code 400" — axios's own words, naming nothing SAP said.
    expect(info?.message).not.toMatch(/^Request failed with status code \d+$/i);
    expect(info?.message).toMatch(/Bad Gateway upstream/);
    // Markup must not survive the scrape — htmlToLines strips it before the message is built.
    expect(info?.message).not.toMatch(/[<>]/);
    expect(info?.message).toBe("Bad Gateway upstream");
  });

  it("recovers a bare <message> element from an unrecognised-root body", () => {
    const e = axiosLeakLikeException(
      400,
      "Bad Request",
      `<not-exc-exception><message lang="EN">Message number is missing</message></not-exc-exception>`,
    );
    const info = adtExceptionInfo(e);
    expect(info?.message).toBe("Message number is missing");
  });

  it("admits honestly that there is no diagnostic body, rather than repeating axios's sentence", () => {
    const e = axiosLeakNoResponseException(400);
    const info = adtExceptionInfo(e);
    expect(info?.status).toBe(400);
    expect(info?.message).not.toMatch(/^Request failed with status code \d+$/i);
    expect(info?.message).toMatch(/no diagnostic body/i);
    expect(info?.message).toMatch(/400/);
  });

  it("leaves a genuine, informative message untouched", () => {
    const e = thrownByLibrary(
      400,
      "Bad Request",
      OK_XML,
      `<?xml version="1.0"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
        `<namespace id="com.sap.adt"/><type id="ExceptionResourceBadRequest"/>` +
        `<message lang="EN">Message number is missing</message></exc:exception>`,
    );
    const info = adtExceptionInfo(e);
    expect(info?.message).toBe("Message number is missing");
  });

  it("propagates through translateAdtError for the trRequirement path too, not just direct calls", () => {
    // `ctsError`/`wireFailure` (src/adt/transports.ts) both bottom out on
    // `adtExceptionInfo`; `translateAdtError` is the sibling normalizer this
    // suite exercises directly. Same fixture, same guarantee: whatever
    // consumes `adtExceptionInfo` never sees the bare axios sentence either.
    const e = axiosLeakLikeException(400, "Bad Request", "<html><body>upstream refused it</body></html>");
    const err = translateAdtError(e, { operation: "trRequirement" });
    expect(err.message).not.toMatch(/Request failed with status code \d+/i);
  });

  it("scrapes the real ICM error page instead of its CSS boilerplate", () => {
    const html = captured("701-run-zcl_zmcp_dmp_zerodiv.html");
    const e = axiosLeakLikeException(500, "Internal Server Error", html);
    const info = adtExceptionInfo(e);
    expect(info?.message).not.toMatch(/[<>]/);
    expect(info?.message).not.toMatch(/background|#ffffff/i);
    expect(info?.message).toMatch(/Division by zero/);
  });

  it("leaves a plain-text body (no markup) through the whitespace-collapse tier — the HTML gate must not fire on it", () => {
    // Real corpus body, not HTML: test/fixtures/enhancement/273-session-death-400-timeout.txt
    // (400 "Session timed out", 45 bytes, CRLF between the two lines).
    const e = axiosLeakLikeException(400, "Session timed out", "400 Session Timed Out\r\n\r\n 2026-08-05 15:51:34");
    const info = adtExceptionInfo(e);
    expect(info?.message).toBe("400 Session Timed Out 2026-08-05 15:51:34");
  });
});
