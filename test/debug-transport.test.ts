/**
 * Tests for the debugger's HTTP long-poll transport (src/debug/transport.ts) — not SAP CTS.
 *
 * Offline unit tests for `src/debug/transport.ts`.
 *
 * Everything here runs against fakes — no live SAP calls, per
 * the debugger build's hard offline constraint.
 * Covers: the long-poll timeout assertion, the 401 no-retry rule, the 403
 * single-retry rule, error translation without any string matching on
 * `.message`, and long-poll cancellation.
 */
import http from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { fromResponse } from "abap-adt-api/build/AdtException.js";
import { session_types } from "abap-adt-api";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { AbapConnection } from "../src/adt/connection.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError } from "../src/adt/errors.js";
import { SafetyGate } from "../src/safety.js";
import type { AdtError, RawResponse } from "../src/debug/types.js";
import {
  ACQUIRE_NO_SESSION_LEASE,
  DEBUG_ATTACH_WAIT_TIME_MS,
  DEBUG_LAZY_TIME_MS,
  LISTENER_SERVER_TIMEOUT_MS,
  LONGPOLL_TIMEOUT_MARGIN_MS,
  assertLongPollTimeoutSafe,
  assertServerHoldSafe,
  DebugLongPollClient,
  DebugTransport,
  LongPollAborted,
  defaultRawHttpRequest,
  fetchCsrfToken,
  isConflict,
  isNoSessionAttached,
  isSessionExpired,
  isResourceNoAccess,
  isStaleCsrfChallenge,
  mergeCookieHeader,
  RESOURCE_NO_ACCESS_TYPE,
  translateDebugError,
  adtErrorFromException,
  type RawHttpRequest,
  type RawHttpRequestFn,
  type DebugSessionLease,
} from "../src/debug/transport.js";
import {
  LIVE_CAPTURED_DIR,
  DATAPREVIEW_XML,
  T000_NONPRODUCTIVE,
} from "./helpers/system-role-fake.js";

/**
 * The REAL 200 body the appliance returned for
 * `POST /sap/bc/adt/datapreview/freestyle?rowNumber=20` with
 * `SELECT mandt, cccategory, cccoractiv FROM t000`
 * (capture `087-p3b-datapreview-t000`, 2026-07-31, A4H). Column-major:
 * MANDT `000`/`001`, CCCATEGORY `S`/`C`. So client `001` is CCCATEGORY `C`
 * — a customising client, i.e. provably NON-productive.
 *
 * `AbapConnection.connect()` runs this probe on every connection
 * (`detectSystemRole`, src/adt/connection.ts:728) and is **fail-closed**: a
 * fake that does not answer this route classifies as `inconclusive`, which
 * locks writes out in a way `ABAP_ALLOW_WRITE` cannot override.
 * Any fake here that must stand for a WRITABLE system therefore has to serve
 * these bytes and log on as a client that appears in them.
 *
 * Imported from ./helpers/system-role-fake.js, together with
 * `DATAPREVIEW_XML` — the one Accept/content type the data-preview endpoint
 * speaks (connection.ts:113).
 */

/**
 * The read-only default. `client: "001"` pairs with `T000_NONPRODUCTIVE` above
 * so that a fake which answers the T000 route yields a system that IS provably
 * non-productive and is read-only purely because `ABAP_ALLOW_WRITE` is unset.
 * That distinction matters: without a client the verdict is
 * `inconclusive`, the refusal comes from the fail-closed lockout instead, and
 * the hint the tests below assert on ("set ABAP_ALLOW_WRITE to enable them")
 * would be advice that does not actually work. Fakes that do NOT answer the
 * T000 route are still `inconclusive` — read-only either way.
 */
const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
  });

/**
 * The same config with writes ENABLED. `ConfigSchema` defaults `readOnly` to
 * true, so every `cfg()`-built connection refuses debugger mutations by
 * default — which is the reason the handful of tests below that legitimately
 * exercise a debugger POST must opt in here exactly as a real operator would
 * (`ABAP_ALLOW_WRITE=true` + `ABAP_ALLOW_PACKAGES`).
 *
 * `client: "001"` is NOT decoration. The operator opt-in is only half of the
 * gate: since the write gate became fail-closed, `connect()` must also be able
 * to PROVE the system non-productive, and it does that by attributing a T000
 * row to the logon client. With no `sap-client` in the cookie jar and none
 * configured, the client is unknown, no row can be attributed, and the verdict
 * is `inconclusive` — which locks writes out and which `ABAP_ALLOW_WRITE`
 * deliberately cannot override. Client `001` is CCCATEGORY `C` in the captured
 * `T000_NONPRODUCTIVE` bytes, so the pair (config client + real fixture) is
 * what a genuinely writable A4H looks like. Mirrors `writableCfg` in
 * test/session.test.ts.
 */
const writableCfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
    readOnly: false,
    allowPackages: ["$TMP"],
  });

/** Mirrors test/circuit-breaker.test.ts's fake — counts every request that would leave the process. */
class CountingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions, n: number) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o, this.calls.length);
  }
}

const httpResp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse => ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

// ---------------------------------------------------------------------------
// Lifetime constants — pinned so a later "simplification" is caught by CI.
// ---------------------------------------------------------------------------

describe("lifetime constants", () => {
  it("match the documented SAP numbers", () => {
    expect(DEBUG_ATTACH_WAIT_TIME_MS).toBe(30_000);
    expect(DEBUG_LAZY_TIME_MS).toBe(600_000);
    expect(LISTENER_SERVER_TIMEOUT_MS).toBe(240_000);
    expect(LONGPOLL_TIMEOUT_MARGIN_MS).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// The timeout assertion.
// ---------------------------------------------------------------------------

describe("assertLongPollTimeoutSafe", () => {
  it("throws when the client timeout does not clear the margin", () => {
    expect(() => assertLongPollTimeoutSafe(240_000, 240_000)).toThrow(/unsafe long-poll timeout/i);
    expect(() => assertLongPollTimeoutSafe(240_000, 300_000)).toThrow(/unsafe long-poll timeout/i);
  });

  it("passes once the client timeout clears listenTimeoutMs + margin", () => {
    expect(() => assertLongPollTimeoutSafe(240_000, 300_001)).not.toThrow();
    expect(() => assertLongPollTimeoutSafe(60_000, 360_000)).not.toThrow();
  });

  it("is enforced at DebugLongPollClient construction time", () => {
    const breaker = new AuthCircuitBreaker();
    expect(
      () =>
        new DebugLongPollClient({
          baseUrl: "http://sap.invalid",
          breaker,
          auth: { cookieHeader: () => "", csrfToken: () => "fetch", acquireSession: ACQUIRE_NO_SESSION_LEASE },
          listenTimeoutMs: 240_000,
          clientTimeoutMs: 250_000, // margin not cleared
        }),
    ).toThrow(/unsafe long-poll timeout/i);
  });

  it("applies a safe default clientTimeoutMs when none is given", () => {
    const breaker = new AuthCircuitBreaker();
    expect(
      () =>
        new DebugLongPollClient({
          baseUrl: "http://sap.invalid",
          breaker,
          auth: { cookieHeader: () => "", csrfToken: () => "fetch", acquireSession: ACQUIRE_NO_SESSION_LEASE },
        }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertServerHoldSafe — guards the value ACTUALLY sent on the wire
// (`DebugSession.listenerTimeoutSeconds`), unlike assertLongPollTimeoutSafe's
// first param which (pre-rename) was fed a client-side-only knob that is
// never transmitted. See transport.ts's doc comment above the export.
// ---------------------------------------------------------------------------

describe("assertServerHoldSafe", () => {
  const cases: Array<[serverHoldSeconds: number, clientAbortMs: number]> = [
    [240, 240_000],
    [240, 300_000],
    [240, 300_001],
    [60, 360_000],
    [0, 59_999],
    [0, 60_001],
    [100, 160_000],
    [100, 160_001],
    [1, 1_000],
    [3600, 3_600_001],
  ];

  it.each(cases)(
    "serverHoldSeconds=%p, clientAbortMs=%p throws iff serverHoldMs + margin >= clientAbortMs",
    (serverHoldSeconds, clientAbortMs) => {
      const expectThrow = serverHoldSeconds * 1000 + LONGPOLL_TIMEOUT_MARGIN_MS >= clientAbortMs;
      if (expectThrow) {
        expect(() => assertServerHoldSafe(serverHoldSeconds, clientAbortMs)).toThrow();
      } else {
        expect(() => assertServerHoldSafe(serverHoldSeconds, clientAbortMs)).not.toThrow();
      }
    },
  );

  it("throws exactly AT the margin (strict <), and passes one ms above it", () => {
    const serverHoldSeconds = 100;
    const serverHoldMs = serverHoldSeconds * 1000;
    expect(() =>
      assertServerHoldSafe(serverHoldSeconds, serverHoldMs + LONGPOLL_TIMEOUT_MARGIN_MS),
    ).toThrow();
    expect(() =>
      assertServerHoldSafe(serverHoldSeconds, serverHoldMs + LONGPOLL_TIMEOUT_MARGIN_MS + 1),
    ).not.toThrow();
  });

  it("converts seconds to ms — a value that would pass if seconds were mistaken for ms still throws", () => {
    // If `serverHoldSeconds` were used as-is (no *1000): 5 + margin(60_000) = 60_005 < 60_006,
    // so a buggy implementation would NOT throw here. Correctly converted to ms it is
    // 5_000 + 60_000 = 65_000, which is >= 60_006, so it MUST throw.
    const serverHoldSeconds = 5;
    const clientAbortMs = 60_006;
    expect(serverHoldSeconds + LONGPOLL_TIMEOUT_MARGIN_MS).toBeLessThan(clientAbortMs); // sanity: unconverted would pass
    expect(() => assertServerHoldSafe(serverHoldSeconds, clientAbortMs)).toThrow();
  });

  it("failure message names BOTH the server-hold knob and the client-abort knob", () => {
    let message = "";
    try {
      assertServerHoldSafe(240, 240_000);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/listenerTimeoutSeconds/);
    expect(message).toMatch(/listenTimeoutSeconds|clientTimeoutMs/);
  });
});

// ---------------------------------------------------------------------------
// DebugLongPollClient.clientAbortTimeoutMs — the public getter callers use to
// cross-check the effective client-side abort deadline against what is
// actually sent on the wire, via assertServerHoldSafe (transport.ts ~774-779).
// ---------------------------------------------------------------------------

describe("DebugLongPollClient.clientAbortTimeoutMs", () => {
  it("returns the explicit clientTimeoutMs when one is given", () => {
    const breaker = new AuthCircuitBreaker();
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "", csrfToken: () => "fetch", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      listenTimeoutMs: 100_000,
      clientTimeoutMs: 300_000,
    });
    expect(client.clientAbortTimeoutMs).toBe(300_000);
  });

  it("returns the derived default (listenTimeoutMs + margin + 60_000) when only listenTimeoutMs is given, strictly beyond the margin", () => {
    const breaker = new AuthCircuitBreaker();
    const listenTimeoutMs = 120_000;
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "", csrfToken: () => "fetch", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      listenTimeoutMs,
    });
    expect(client.clientAbortTimeoutMs).toBe(listenTimeoutMs + LONGPOLL_TIMEOUT_MARGIN_MS + 60_000);
    expect(client.clientAbortTimeoutMs).toBeGreaterThan(listenTimeoutMs + LONGPOLL_TIMEOUT_MARGIN_MS);
  });
});

// ---------------------------------------------------------------------------
// Long-poll: 401 never retries, trips the shared breaker, and every
// subsequent call — long-poll or otherwise — is refused without touching the
// fake transport again.
// ---------------------------------------------------------------------------

describe("DebugLongPollClient — 401 no-retry rule", () => {
  it("trips the breaker on a 401 and never calls the transport again", async () => {
    const breaker = new AuthCircuitBreaker();
    const calls: string[] = [];
    const requestFn: RawHttpRequestFn = async (req) => {
      calls.push(req.method);
      return { status: 401, headers: {}, body: "Unauthorized" };
    };
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "SAP_SESSIONID=x", csrfToken: () => "TOKEN", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      requestFn,
    });

    const first = client.listen("/sap/bc/adt/debugger/listeners");
    await expect(first.result).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "AUTH_CIRCUIT_OPEN",
    );
    expect(breaker.isTripped).toBe(true);
    expect(calls).toHaveLength(1);

    // A second, independent listen() call must be refused locally — no network call.
    const second = client.listen("/sap/bc/adt/debugger/listeners");
    await expect(second.result).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "AUTH_CIRCUIT_OPEN",
    );
    expect(calls).toHaveLength(1); // ← the whole point
  });

  it("also trips on the ICF logon-failure HTML page served as 200", async () => {
    const ICF_LOGON_PAGE = `<!DOCTYPE html><html><body><h1>Anmeldung fehlgeschlagen</h1>
      <form name="sap-system-login"><input name="sap-user"><input name="sap-password"></form>
      </body></html>`;
    const breaker = new AuthCircuitBreaker();
    let calls = 0;
    const requestFn: RawHttpRequestFn = async () => {
      calls++;
      return { status: 200, headers: { "content-type": "text/html" }, body: ICF_LOGON_PAGE };
    };
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "", csrfToken: () => "fetch", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      requestFn,
    });
    await expect(client.listen("/sap/bc/adt/debugger/listeners").result).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "AUTH_CIRCUIT_OPEN",
    );
    expect(breaker.info?.reason).toBe("icf-logon-page");
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// An auth failure hit DURING the CSRF refetch (the HEAD to /core/discovery,
// not the original POST) must trip the shared breaker and never be retried —
// this is the account-lock guard (fetchCsrfToken's `breaker.inspect` + the
// `isTripped` throw right after the HEAD, before the token-missing check).
// ---------------------------------------------------------------------------

describe("DebugLongPollClient — auth failure during CSRF refetch trips the breaker", () => {
  it("an ICF logon-failure HEAD during CSRF refetch trips the breaker and is never retried", async () => {
    const ICF_LOGON_PAGE = `<!DOCTYPE html><html><body><h1>Anmeldung fehlgeschlagen</h1>
      <form name="sap-system-login"><input name="sap-user"><input name="sap-password"></form>
      </body></html>`;
    const breaker = new AuthCircuitBreaker();
    const calls: string[] = [];
    const requestFn: RawHttpRequestFn = async (req) => {
      calls.push(req.method);
      if (req.method === "HEAD") {
        return { status: 200, headers: { "content-type": "text/html" }, body: ICF_LOGON_PAGE };
      }
      // Stale-token 403 on the original POST — this is what drives the retry
      // ladder into fetchCsrfToken() in the first place.
      return { status: 403, headers: { "x-csrf-token": "Required" }, body: "CSRF token missing" };
    };
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "SAP_SESSIONID=x", csrfToken: () => "STALE", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      requestFn,
    });

    const first = client.listen("/sap/bc/adt/debugger/listeners");
    await expect(first.result).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "AUTH_CIRCUIT_OPEN",
    );
    expect(breaker.isTripped).toBe(true);
    expect(breaker.info?.reason).toBe("icf-logon-page");
    // Exactly one POST (stale) then one HEAD (refetch) — NO second POST, NO second HEAD.
    expect(calls).toEqual(["POST", "HEAD"]);

    // The account-lock guard: a SUBSEQUENT listen() on the same client makes
    // ZERO further network calls and rejects immediately from the latched breaker.
    const second = client.listen("/sap/bc/adt/debugger/listeners");
    await expect(second.result).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "AUTH_CIRCUIT_OPEN",
    );
    expect(calls).toEqual(["POST", "HEAD"]); // ← the whole point: no new attempts at all
  });

  it("a plain 401 HEAD during CSRF refetch trips the breaker with reason http-401", async () => {
    const breaker = new AuthCircuitBreaker();
    const calls: string[] = [];
    const requestFn: RawHttpRequestFn = async (req) => {
      calls.push(req.method);
      if (req.method === "HEAD") {
        return { status: 401, headers: {}, body: "Unauthorized" };
      }
      return { status: 403, headers: { "x-csrf-token": "Required" }, body: "CSRF token missing" };
    };
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "SAP_SESSIONID=x", csrfToken: () => "STALE", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      requestFn,
    });

    await expect(client.listen("/sap/bc/adt/debugger/listeners").result).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "AUTH_CIRCUIT_OPEN",
    );
    expect(breaker.info?.reason).toBe("http-401");
    expect(calls).toEqual(["POST", "HEAD"]);
  });
});

// ---------------------------------------------------------------------------
// Long-poll: 403 retries AT MOST ONCE, and only on the header-confirmed
// stale-token signal.
// ---------------------------------------------------------------------------

describe("DebugLongPollClient — 403 single-retry rule", () => {
  it("refreshes CSRF and retries exactly once on a stale-token 403, then succeeds", async () => {
    const breaker = new AuthCircuitBreaker();
    const calls: Array<{ method: string; token: string }> = [];
    const requestFn: RawHttpRequestFn = async (req) => {
      const token = req.headers?.["x-csrf-token"] ?? "";
      calls.push({ method: req.method, token });
      if (req.method === "HEAD") {
        return { status: 200, headers: { "x-csrf-token": "FRESH-TOKEN" }, body: "" };
      }
      if (token !== "FRESH-TOKEN") {
        return { status: 403, headers: { "x-csrf-token": "Required" }, body: "CSRF token missing" };
      }
      return { status: 200, headers: {}, body: "" };
    };
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "cookie=1", csrfToken: () => "STALE", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      requestFn,
    });

    const handle = client.listen("/sap/bc/adt/debugger/listeners");
    const result = await handle.result;
    expect(result.status).toBe(200);

    // POST (stale) → HEAD (refresh) → POST (fresh) — never a second retry loop.
    expect(calls.map((c) => c.method)).toEqual(["POST", "HEAD", "POST"]);
    expect(breaker.isTripped).toBe(false);
  });

  it("does not loop a second time if the retried request is STILL a 403", async () => {
    const breaker = new AuthCircuitBreaker();
    let postCount = 0;
    let headCount = 0;
    const requestFn: RawHttpRequestFn = async (req) => {
      if (req.method === "HEAD") {
        headCount++;
        return { status: 200, headers: { "x-csrf-token": "STILL-BAD" }, body: "" };
      }
      postCount++;
      return { status: 403, headers: { "x-csrf-token": "Required" }, body: "CSRF token missing" };
    };
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "", csrfToken: () => "STALE", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      requestFn,
    });

    await expect(client.listen("/sap/bc/adt/debugger/listeners").result).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "AUTH_FAILED",
    );
    expect(postCount).toBe(2); // original + exactly one retry
    expect(headCount).toBe(1); // exactly one CSRF refresh
  });

  it("does NOT retry a bare 403 with no stale-token evidence", async () => {
    const breaker = new AuthCircuitBreaker();
    let calls = 0;
    const requestFn: RawHttpRequestFn = async () => {
      calls++;
      return { status: 403, headers: {}, body: "Forbidden: you may not do this" };
    };
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "", csrfToken: () => "TOKEN", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      requestFn,
    });
    await expect(client.listen("/sap/bc/adt/debugger/listeners").result).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "AUTH_FAILED",
    );
    expect(calls).toBe(1); // no retry at all — no evidence of a stale token
  });

  it("isStaleCsrfChallenge requires BOTH the 403 AND the exact header value", () => {
    expect(isStaleCsrfChallenge({ status: 403, headers: { "x-csrf-token": "Required" } })).toBe(true);
    expect(isStaleCsrfChallenge({ status: 403, headers: { "X-CSRF-Token": "required" } })).toBe(true);
    expect(isStaleCsrfChallenge({ status: 403, headers: {} })).toBe(false);
    expect(isStaleCsrfChallenge({ status: 401, headers: { "x-csrf-token": "Required" } })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The CSRF refetch (the retry call site's fetchCsrfToken call) is abortable:
// it passes `signal` through, and re-checks `signal.aborted` after the await
// instead of hanging forever on a stuck HEAD.
// ---------------------------------------------------------------------------

describe("DebugLongPollClient — CSRF refetch is abortable", () => {
  it("passes the abort signal to the CSRF-refresh HEAD and abort() settles the result rather than hanging", async () => {
    const breaker = new AuthCircuitBreaker();
    let headSignal: AbortSignal | undefined;
    const requestFn: RawHttpRequestFn = (req) => {
      if (req.method === "HEAD") {
        // Hangs like a stuck HEAD — but honours the passed AbortSignal, exactly
        // like the existing cancellation tests' fake transport does for POST.
        return new Promise((_resolve, reject) => {
          headSignal = req.signal;
          req.signal?.addEventListener("abort", () => reject(new Error("head-aborted-for-test")), {
            once: true,
          });
        });
      }
      return Promise.resolve({
        status: 403,
        headers: { "x-csrf-token": "Required" },
        body: "CSRF token missing",
      });
    };
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "SAP_SESSIONID=x", csrfToken: () => "STALE", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      requestFn,
    });

    const handle = client.listen("/sap/bc/adt/debugger/listeners");
    await handle.armed;
    // Give the retry ladder time to run the stale-token POST and reach the
    // (hanging) HEAD before we assert on it / abort.
    await new Promise((r) => setTimeout(r, 50));
    expect(headSignal).toBeDefined();
    expect(headSignal?.aborted).toBe(false);

    handle.abort();

    const TIMED_OUT = Symbol("timed-out");
    const winner = await Promise.race([
      handle.result.catch((e: unknown) => e),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 1000)),
    ]);
    expect(winner).not.toBe(TIMED_OUT); // ← must settle, never hang
    expect(isAbapError(winner) && winner.code === "TRANSPORT_ERROR").toBe(true);
    expect(headSignal?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Long-poll: same X-sap-adt-sessiontype: stateful requirement as ordinary
// requests — "A" is a single SAP session across both request paths, so both
// must carry it.
// ---------------------------------------------------------------------------

describe("DebugLongPollClient — X-sap-adt-sessiontype header", () => {
  it("sends X-sap-adt-sessiontype: stateful on the long-poll request, and it is never overridden by extraHeaders", async () => {
    const breaker = new AuthCircuitBreaker();
    const seenHeaders: Array<Record<string, string> | undefined> = [];
    const requestFn: RawHttpRequestFn = async (req) => {
      seenHeaders.push(req.headers);
      return { status: 200, headers: {}, body: "" };
    };
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "SAP_SESSIONID=x", csrfToken: () => "TOKEN", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      requestFn,
    });

    // Even a caller that (mistakenly) tries to set this header via extraHeaders
    // must not win — the transport's own value always wins.
    await client.listen("/sap/bc/adt/debugger/listeners", {
      headers: { Accept: "application/json", "X-sap-adt-sessiontype": "stateless" },
    }).result;

    expect(seenHeaders).toHaveLength(1);
    expect(seenHeaders[0]?.["X-sap-adt-sessiontype"]).toBe("stateful");
    expect(seenHeaders[0]?.Accept).toBe("application/json");
  });

  it("the CSRF-refresh HEAD carries X-sap-adt-sessiontype: stateful and the retry POST's cookie is the rotated session id", async () => {
    const breaker = new AuthCircuitBreaker();
    const headersByCall: Record<string, Record<string, string> | undefined> = {};
    let postCount = 0;
    const requestFn: RawHttpRequestFn = async (req) => {
      if (req.method === "HEAD") {
        headersByCall.HEAD = req.headers;
        return {
          status: 200,
          headers: {
            "x-csrf-token": "FRESH-TOKEN",
            "set-cookie": "SAP_SESSIONID=ROTATED987; Path=/; HttpOnly",
          },
          body: "",
        };
      }
      postCount++;
      headersByCall[`POST${postCount}`] = req.headers;
      if (postCount === 1) {
        return { status: 403, headers: { "x-csrf-token": "Required" }, body: "CSRF token missing" };
      }
      return { status: 200, headers: {}, body: "" };
    };
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "SAP_SESSIONID=stale123", csrfToken: () => "STALE", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      requestFn,
    });

    const result = await client.listen("/sap/bc/adt/debugger/listeners").result;
    expect(result.status).toBe(200);
    expect(headersByCall.HEAD?.["X-sap-adt-sessiontype"]).toBe("stateful");
    expect(headersByCall.POST2?.cookie).toContain("SAP_SESSIONID=ROTATED987");
    expect(headersByCall.POST2?.cookie).not.toContain("stale123");
  });
});

// ---------------------------------------------------------------------------
// Long-poll cancellation — no leaked listeners.
// ---------------------------------------------------------------------------

describe("DebugLongPollClient — cancellation", () => {
  it("abort() settles the result promise and never leaves it dangling", async () => {
    const breaker = new AuthCircuitBreaker();
    let requestSignal: AbortSignal | undefined;
    const requestFn: RawHttpRequestFn = (req) =>
      new Promise((resolve, reject) => {
        requestSignal = req.signal;
        req.signal?.addEventListener("abort", () => reject(new Error("aborted-for-test")), {
          once: true,
        });
        // Never resolves on its own — only settles via abort, simulating a real
        // hanging long-poll.
      });
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "", csrfToken: () => "TOKEN", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      requestFn,
    });

    const handle = client.listen("/sap/bc/adt/debugger/listeners");
    await handle.armed; // request has been dispatched
    expect(requestSignal?.aborted).toBe(false);
    expect(handle.aborted).toBe(false);

    handle.abort();
    expect(handle.aborted).toBe(true);
    expect(requestSignal?.aborted).toBe(true);

    await expect(handle.result).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "TRANSPORT_ERROR",
    );

    // Idempotent — calling it again must not throw or double-abort.
    expect(() => handle.abort()).not.toThrow();
  });

  it("armed resolves before result on a call that never returns", async () => {
    const breaker = new AuthCircuitBreaker();
    let armedFirst = false;
    const requestFn: RawHttpRequestFn = (req) =>
      new Promise((_resolve, reject) => {
        req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "", csrfToken: () => "TOKEN", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      requestFn,
    });
    const handle = client.listen("/sap/bc/adt/debugger/listeners");
    handle.armed.then(() => {
      armedFirst = true;
    });
    await handle.armed;
    expect(armedFirst).toBe(true);
    handle.abort();
    await expect(handle.result).rejects.toBeDefined();
  });

  it("armed settles synchronously at dispatch, well before a slow response arrives", async () => {
    const breaker = new AuthCircuitBreaker();
    // requestFn's returned promise deliberately never resolves within the test —
    // `armed` must not be waiting on it (transport.ts ~716-721 resolves `armed`
    // right after dispatch, not after `await pending`).
    const requestFn: RawHttpRequestFn = () => new Promise(() => {});
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "", csrfToken: () => "TOKEN", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      requestFn,
    });

    const handle = client.listen("/sap/bc/adt/debugger/listeners");

    const ARMED = "armed";
    const TIMEOUT = "timeout";
    const winner = await Promise.race([
      handle.armed.then(() => ARMED),
      new Promise<string>((resolve) => setTimeout(() => resolve(TIMEOUT), 100)),
    ]);

    expect(winner).toBe(ARMED);
  });

  it("an externally supplied signal also cancels the request", async () => {
    const breaker = new AuthCircuitBreaker();
    const external = new AbortController();
    const requestFn: RawHttpRequestFn = (req) =>
      new Promise((_resolve, reject) => {
        req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "", csrfToken: () => "TOKEN", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      requestFn,
    });
    const handle = client.listen("/sap/bc/adt/debugger/listeners", { signal: external.signal });
    await handle.armed;
    external.abort();
    expect(handle.aborted).toBe(true);
    await expect(handle.result).rejects.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// A second concurrent listen() on the SAME client is rejected rather than
// silently cancelling the first — the private `inFlight` guard.
// ---------------------------------------------------------------------------

describe("DebugLongPollClient — concurrent listen() is rejected (in-flight guard)", () => {
  it("throws LOCKED synchronously, leaves the first handle undisturbed, and releases the guard once the first is aborted", async () => {
    const breaker = new AuthCircuitBreaker();
    let postCount = 0;
    const requestFn: RawHttpRequestFn = (req) => {
      postCount++;
      return new Promise((_resolve, reject) => {
        req.signal?.addEventListener("abort", () => reject(new Error("aborted-for-test")), { once: true });
      });
    };
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "", csrfToken: () => "TOKEN", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      requestFn,
    });

    const first = client.listen("/sap/bc/adt/debugger/listeners");
    await first.armed;
    expect(postCount).toBe(1);

    // Synchronous throw, not a rejection — the guard runs before any promise exists.
    expect(() => client.listen("/sap/bc/adt/debugger/listeners")).toThrow(/already in flight/i);
    let locked: unknown;
    try {
      client.listen("/sap/bc/adt/debugger/listeners");
    } catch (e) {
      locked = e;
    }
    expect(isAbapError(locked) && locked.code === "LOCKED").toBe(true);

    // The first handle is undisturbed: no extra request, not settled.
    expect(postCount).toBe(1);
    let firstSettled = false;
    void first.result.then(
      () => (firstSettled = true),
      () => (firstSettled = true),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(firstSettled).toBe(false);

    // Releasing the first releases the guard.
    first.abort();
    await expect(first.result).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "TRANSPORT_ERROR",
    );

    const third = client.listen("/sap/bc/adt/debugger/listeners");
    await third.armed;
    expect(postCount).toBe(2);
    third.abort();
    await expect(third.result).rejects.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Error translation — status/subtype driven, never `.includes()` on `.message`.
// ---------------------------------------------------------------------------

describe("translateDebugError — structural discrimination only", () => {
  const err = (partial: Partial<AdtError>): AdtError => ({
    status: 0,
    message: "",
    path: "/sap/bc/adt/debugger",
    bodyExcerpt: "",
    ...partial,
  });

  it("maps a conflictDetected subtype to LOCKED", () => {
    const e = translateDebugError(err({ status: 500, subtype: "conflictDetected" }));
    expect(e.code).toBe("LOCKED");
  });

  it("does NOT classify prose merely containing the word 'conflict' as a conflict", () => {
    // The exact false-positive this module exists to avoid:
    // `strings.Contains(err, "conflict")` fires on ordinary prose using the word.
    const e = translateDebugError(
      err({ status: 500, message: "There is no conflict here, everything is fine." }),
    );
    expect(e.code).not.toBe("LOCKED");
  });

  it("maps noSessionAttached to NOT_CONNECTED", () => {
    const e = translateDebugError(err({ status: 500, subtype: "noSessionAttached", abapType: "AdiFailed" }));
    expect(e.code).toBe("NOT_CONNECTED");
  });

  it("does NOT broaden to (500, AdiFailed) alone with no subtype", () => {
    // transport.ts used to OR in `status === 500 && abapType === "AdiFailed"` as a second
    // way to detect noSessionAttached. That broadening was rejected in favor of
    // xml-response.ts's narrower, subtype-only match: other subtypes from the same ADI
    // layer (`debuggeeEnded`, `autoAttachTimeout`) plausibly share the same generic
    // `AdiFailed` abapType — only the `noSessionAttached` pairing is confirmed live.
    // Matching on (500, AdiFailed) alone would misclassify "your
    // debuggee already ended" as merely "not attached yet," masking a real, differently-
    // handled state. subtype is now the only signal.
    expect(isNoSessionAttached(err({ status: 500, abapType: "AdiFailed" }))).toBe(false);
    expect(isNoSessionAttached(err({ status: 500, subtype: "noSessionAttached", abapType: "AdiFailed" }))).toBe(
      true,
    );
  });

  it("does NOT classify a body merely containing the digits '404' as NOT_FOUND", () => {
    // Another cited false positive: `strings.Contains(err, "404")` fires on any
    // body whose text happens to contain a line number 404.
    const e = translateDebugError(
      err({ status: 200, message: "Breakpoint set at line 404 of the include." }),
    );
    expect(e.code).not.toBe("NOT_FOUND");
  });

  it("maps status 404 (structurally) to NOT_FOUND", () => {
    expect(translateDebugError(err({ status: 404 })).code).toBe("NOT_FOUND");
    expect(translateDebugError(err({ status: 200, abapType: "ExceptionResourceNotFound" })).code).toBe(
      "NOT_FOUND",
    );
  });

  it("maps 401 to AUTH_FAILED", () => {
    expect(translateDebugError(err({ status: 401 })).code).toBe("AUTH_FAILED");
  });

  it("maps a 403 (post-retry-ladder) to AUTH_FAILED, not a generic ADT_ERROR", () => {
    expect(translateDebugError(err({ status: 403 })).code).toBe("AUTH_FAILED");
  });

  it("maps a session-death body to SESSION_DEAD via the shared session.ts classifier", () => {
    const e = translateDebugError(
      err({ status: 400, bodyExcerpt: "400 Session Timed Out", message: "Session Timed Out" }),
    );
    expect(e.code).toBe("SESSION_DEAD");
  });

  it("falls back to ADT_ERROR for anything unrecognised, carrying the raw details", () => {
    const e = translateDebugError(err({ status: 500, message: "Some other ADT failure." }));
    expect(e.code).toBe("ADT_ERROR");
    expect(e.details.status).toBe(500);
  });

  // -------------------------------------------------------------------------
  // REGRESSION GUARD (live-proven 2026-07-31, "Debuggee already attached"):
  // `subtype` is what DebugSession.attach() switches on to recover from a
  // double attach (`invalidDebuggee`). It reached `details` from the fallback
  // ADT_ERROR branch ONLY — SESSION_DEAD, 401 and NOT_FOUND dropped it, so the
  // very same wire error silently lost its discriminator and the recovery never
  // ran. Every branch must now preserve it.
  // -------------------------------------------------------------------------

  it("preserves subtype in details on the SESSION_DEAD branch", () => {
    const e = translateDebugError(
      err({
        status: 500,
        subtype: "invalidDebuggee",
        message: "Debuggee already attached",
        bodyExcerpt: "<html>Application Server Error</html>",
      }),
    );
    expect(e.code).toBe("SESSION_DEAD");
    expect(e.details.subtype).toBe("invalidDebuggee");
  });

  // -------------------------------------------------------------------------
  // Defect 4 (deathReason/termination-result structuring, 2026-08): the SESSION_DEAD
  // branch mirrored the subtype bug above for TWO more fields — `exceptionClassNames`
  // and `bodyExcerpt` were extracted by `collectExceptionClassNames`/the transport
  // exactly as for the fallback ADT_ERROR branch, then silently dropped here. Without
  // the exception class name, a caller (and now `session.ts`'s structured termination
  // result) cannot tell CX_TPDA_SYS_COMM_DBGSESSIONEND / CX_TPDA_SYS_COMM_SLAVENOTCONN /
  // CX_TPDAPI_DEBUGGEE_ENDED apart, nor recover the raw body text that is sometimes the
  // ONLY evidence of which one fired (the undocumented "fourth shape" — no
  // exceptionClassNames at all — per xml-response.ts's isSessionExpired doc comment).
  // -------------------------------------------------------------------------

  it("preserves exceptionClassNames and bodyExcerpt in details on the SESSION_DEAD branch", () => {
    const e = translateDebugError(
      err({
        status: 500,
        message: "The ABAP debug session no longer exists.",
        exceptionClassNames: ["CX_TPDA_SYS_COMM_DBGSESSIONEND"],
        bodyExcerpt: "<exception>CX_TPDA_SYS_COMM_DBGSESSIONEND</exception>",
      }),
    );
    expect(e.code).toBe("SESSION_DEAD");
    expect(e.details.exceptionClassNames).toEqual(["CX_TPDA_SYS_COMM_DBGSESSIONEND"]);
    expect(e.details.bodyExcerpt).toBe("<exception>CX_TPDA_SYS_COMM_DBGSESSIONEND</exception>");
  });

  it("does NOT add an undefined/empty exceptionClassNames or bodyExcerpt key when absent", () => {
    const e = translateDebugError(
      err({ status: 400, bodyExcerpt: "400 Session Timed Out", message: "Session Timed Out" }),
    );
    expect(e.code).toBe("SESSION_DEAD");
    expect(Object.keys(e.details)).not.toContain("exceptionClassNames");
    // bodyExcerpt IS present here (non-empty on the input), so this only guards the
    // exceptionClassNames key, which the input left undefined.
  });

  it("preserves subtype in details on the 401 AUTH_FAILED branch", () => {
    const e = translateDebugError(err({ status: 401, subtype: "invalidDebuggee" }));
    expect(e.code).toBe("AUTH_FAILED");
    expect(e.details.subtype).toBe("invalidDebuggee");
  });

  it("preserves subtype in details on the NOT_FOUND branch", () => {
    const e = translateDebugError(err({ status: 404, subtype: "invalidDebuggee" }));
    expect(e.code).toBe("NOT_FOUND");
    expect(e.details.subtype).toBe("invalidDebuggee");
  });

  it("does NOT add an undefined `subtype` key when the error carries no subtype", () => {
    // The key is spread in conditionally, so subtype-less errors keep exactly the
    // detail shape they had before this fix (no `{ subtype: undefined }` noise).
    for (const e of [
      translateDebugError(err({ status: 400, bodyExcerpt: "400 Session Timed Out" })),
      translateDebugError(err({ status: 401 })),
      translateDebugError(err({ status: 404 })),
    ]) {
      expect(Object.keys(e.details)).not.toContain("subtype");
    }
  });

  it("carries subtype end-to-end from a real abap-adt-api exception through to details", () => {
    // Not hand-built: this is the exact shape `adtErrorFromException` reads
    // (`err`/`type`/`properties`/`response`), so the whole extraction →
    // classification → details chain is under test, not just the last step.
    const thrown = {
      err: 500,
      type: "AdiFailed",
      message: "Debuggee already attached",
      properties: { "com.sap.adt.communicationFramework.subType": "invalidDebuggee" },
      response: { status: 500, body: "<html>Application Server Error</html>" },
    };
    const e = translateDebugError(adtErrorFromException(thrown, "/sap/bc/adt/debugger"));
    expect(e.code).toBe("SESSION_DEAD"); // NOT the fallback ADT_ERROR branch
    expect(e.details.subtype).toBe("invalidDebuggee");
  });

  // -------------------------------------------------------------------------
  // REGRESSION GUARD (live acceptance run 5, idle-timeout case): SAP released
  // the debug session on `rdisp/max_debug_lazy_time`; the next `getStack`
  // rejected — correctly — but as a GENERIC ADT_ERROR ("An exception was
  // raised"), so a caller could not tell "re-attach" from "unknown failure".
  //
  // Why nothing caught it: on this path `abap-adt-api` parses the
  // `<exc:exception>` itself and does NOT attach the response to the exception
  // it throws (`AdtException.js`), so `adtErrorFromException`'s `bodyExcerpt`
  // degrades to the MESSAGE text — and `isSessionDeath`'s 500 branch demands an
  // HTML ICM page before it will even look. The only thing on the wire that
  // names the condition is the ABAP class `CX_TPDA_SYS_COMM_DBGSESSIONEND`,
  // which now travels on `exceptionClassNames`.
  // -------------------------------------------------------------------------

  it("maps a RELEASED debug session (CX_TPDA_SYS_COMM_DBGSESSIONEND) to SESSION_DEAD, not ADT_ERROR", () => {
    const thrown = {
      err: 500,
      type: "AdiFailed",
      message: "An exception was raised",
      properties: {
        "com.sap.adt.communicationFramework.subType": "getStack",
        previous2ExceptionClassName: "CX_TPDA_SYS_COMM_DBGSESSIONEND",
        "T100KEY-ID": "SY",
        "T100KEY-NO": "530",
      },
      // No `response` — exactly what abap-adt-api throws for a parsed exception.
    };
    const e = translateDebugError(adtErrorFromException(thrown, "/sap/bc/adt/debugger/stack"));
    expect(e.code).toBe("SESSION_DEAD");
    expect(e.details.subtype).toBe("getStack");
  });

  it("the localised message is irrelevant — a German-language body still maps to SESSION_DEAD", () => {
    // The appliance answers in the logon language. Class names are not translated; prose is.
    const e = translateDebugError(
      adtErrorFromException(
        {
          err: 500,
          type: "AdiFailed",
          message: "Es wurde eine Ausnahme ausgelöst",
          properties: { previousExceptionClassName: "CX_TPDA_SYS_COMM_DBGSESSIONEND" },
        },
        "/sap/bc/adt/debugger/stack",
      ),
    );
    expect(e.code).toBe("SESSION_DEAD");
  });

  // ---------------------------------------------------------------------------
  // ARCH-09 §5.5/P6 — LIVE: `debug.step.continue-to-end` on a program that ran to completion
  // answered with `subtype: "debuggeeEnded"`, `abapType: "AdiFailed"`. `isSessionExpired` now
  // classifies that as gone (its "FOURTH shape" clause), but the MESSAGE forwarded to the caller
  // was still the generic ADI wrapper text ("An exception was raised"), reading like a crash
  // rather than the ordinary end of a program. Built via the local `err()` helper — the same
  // `AdtError` shape `parseAdtError`/`adtErrorFromException` both produce on the wire — not a
  // guessed-at XML body.
  // ---------------------------------------------------------------------------
  it("maps a debuggeeEnded subtype to SESSION_DEAD with an end-of-program message and hint, not the generic wire text", () => {
    const e = translateDebugError(
      err({
        status: 500,
        abapType: "AdiFailed",
        subtype: "debuggeeEnded",
        message: "An exception was raised",
        path: "/sap/bc/adt/debugger?method=stepContinue",
      }),
    );
    expect(e.code).toBe("SESSION_DEAD");
    expect(e.details.subtype).toBe("debuggeeEnded");
    // NOT the raw "An exception was raised" wire text — that is the exact defect being fixed.
    expect(e.message).toBe(
      "The debuggee ran to completion. The program finished running, and the debug session " +
        "that was attached to it is over.",
    );
    expect(e.hint).toBe(
      "This is a normal end, not a failure — nothing crashed. Start a new debug session " +
        "(set a breakpoint and attach again) to debug another run.",
    );
  });

  it("still returns ADT_ERROR for an AdiFailed 500 that is NOT a session end", () => {
    const e = translateDebugError(
      adtErrorFromException(
        {
          err: 500,
          type: "AdiFailed",
          message: "An exception was raised",
          properties: {
            "com.sap.adt.communicationFramework.subType": "getStack",
            previous2ExceptionClassName: "CX_TPDA_SYS_COMM_OTHER",
          },
        },
        "/sap/bc/adt/debugger/stack",
      ),
    );
    expect(e.code).toBe("ADT_ERROR");
  });

  it("terminateDebuggee's 500-shaped SUCCESS keeps the subtype+status DebugClient unwraps on", () => {
    // That success answer carries the same class name, so it now classifies as SESSION_DEAD
    // (semantically exact: the kill ended the session). `DebugClient.terminateDebuggee()` keys
    // on `details.subtype === "terminateDebuggee"` + an accepted status, never on the code —
    // both must survive this branch, or teardown starts reporting failure on every case.
    const e = translateDebugError(
      adtErrorFromException(
        {
          err: 500,
          type: "AdiFailed",
          message: "An exception was raised",
          properties: {
            "com.sap.adt.communicationFramework.subType": "terminateDebuggee",
            previous2ExceptionClassName: "CX_TPDA_SYS_COMM_DBGSESSIONEND",
          },
        },
        "/sap/bc/adt/debugger",
      ),
    );
    expect(e.details.subtype).toBe("terminateDebuggee");
    expect(e.details.status).toBe(500);
  });
});

describe("isConflict / isSessionExpired / isNoSessionAttached", () => {
  it("isConflict requires the exact literal subtype", () => {
    expect(isConflict({ status: 500, subtype: "conflictDetected", message: "", path: "", bodyExcerpt: "" })).toBe(
      true,
    );
    expect(isConflict({ status: 500, subtype: "somethingElse", message: "", path: "", bodyExcerpt: "" })).toBe(
      false,
    );
  });

  it("isSessionExpired reuses adt/session.ts's classifier (both observed shapes)", () => {
    expect(
      isSessionExpired({
        status: 400,
        message: "Session Timed Out",
        path: "",
        bodyExcerpt: "400 Session Timed Out",
      }),
    ).toBe(true);
    expect(
      isSessionExpired({
        status: 500,
        message: "dump",
        path: "",
        bodyExcerpt: "<html>Application Server Error</html>",
      }),
    ).toBe(true);
    expect(isSessionExpired({ status: 404, message: "not found", path: "", bodyExcerpt: "" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The long-poll's own narrow regex parser, `adtErrorFromRawResponse`, has
// been deleted — the long-poll error path (`DebugLongPollClient.run()`) now
// calls `parseAdtError` directly (see `transport.ts`). Equivalent, stronger
// coverage (real XML parsing, namespace safety, truncation of huge bodies,
// graceful degradation on non-XML input) already exists in
// `test/debug-xml-response.test.ts`'s `parseAdtError` `describe` block, so it
// is not duplicated here.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// fetchCsrfToken — HEAD /sap/bc/adt/core/discovery, reads the header even off
// a non-2xx response.
// ---------------------------------------------------------------------------

describe("fetchCsrfToken", () => {
  it("reads the token off a HEAD response WITHOUT checking status first", async () => {
    const requestFn: RawHttpRequestFn = async (req) => {
      expect(req.method).toBe("HEAD");
      expect(req.url).toContain("/sap/bc/adt/core/discovery");
      // A 400 that STILL carries a valid token — must not be discarded.
      return { status: 400, headers: { "x-csrf-token": "GOOD-TOKEN" }, body: "" };
    };
    const token = await fetchCsrfToken({
      baseUrl: "http://sap.invalid",
      breaker: new AuthCircuitBreaker(),
      requestFn,
    });
    expect(token).toBe("GOOD-TOKEN");
  });

  it("throws when no usable token comes back", async () => {
    const requestFn: RawHttpRequestFn = async () => ({ status: 200, headers: {}, body: "" });
    await expect(
      fetchCsrfToken({
        baseUrl: "http://sap.invalid",
        breaker: new AuthCircuitBreaker(),
        requestFn,
      }),
    ).rejects.toThrow();
  });

  it("forwards the cookie header so the token is scoped to the right session", async () => {
    let seenCookie = "";
    const requestFn: RawHttpRequestFn = async (req) => {
      seenCookie = req.headers?.cookie ?? "";
      return { status: 200, headers: { "x-csrf-token": "T" }, body: "" };
    };
    await fetchCsrfToken({
      baseUrl: "http://sap.invalid",
      breaker: new AuthCircuitBreaker(),
      cookieHeader: "SAP_SESSIONID=abc",
      requestFn,
    });
    expect(seenCookie).toBe("SAP_SESSIONID=abc");
  });

  /**
   * RUNTIME REGRESSION TEST. This is the one seam of the breaker-required change
   * where a request genuinely reached the wire past a LATCHED process.
   *
   * `FetchCsrfTokenOptions.breaker` used to be optional, and the three gates in
   * `fetchCsrfToken` were each written `if (breaker) ...`. So a caller that
   * simply left the key out — which is what the three tests above did, and what
   * any new caller would do by default — skipped all three, and the HEAD to
   * /sap/bc/adt/core/discovery was dispatched even with the process already
   * latched on `login/fails_to_user_lock`.
   *
   * PRE-FIX, demonstrated in a scratch copy of the tree with the call written
   * `fetchCsrfToken({ baseUrl, requestFn })` — no `breaker` key at all, which
   * the old optional type accepted — and asserting only on the spy, this failed
   * with exactly:
   *
   *   AssertionError: expected [ Array(1) ] to deeply equal []
   *   - Expected  []
   *   + Received  [ "http://sap.invalid/sap/bc/adt/core/discovery" ]
   *
   * i.e. the spy WAS invoked. The omission cannot be written any more (see
   * test/breaker-required.fixture.ts for the compile-time half), so what
   * survives here is the positive law: a latched breaker stops the request
   * BEFORE `requestFn`, not after.
   */
  it("with a LATCHED breaker, throws before requestFn is ever called", async () => {
    const breaker = new AuthCircuitBreaker();
    breaker.trip("auth-failed", "401 from the appliance", {
      status: 401,
      url: "http://sap.invalid/sap/bc/adt/discovery",
    });
    expect(breaker.isTripped).toBe(true);

    const calls: string[] = [];
    const requestFn: RawHttpRequestFn = async (req) => {
      calls.push(req.url);
      return { status: 200, headers: { "x-csrf-token": "SHOULD-NEVER-BE-REACHED" }, body: "" };
    };

    await expect(
      fetchCsrfToken({ baseUrl: "http://sap.invalid", breaker, requestFn }),
    ).rejects.toMatchObject({ code: "AUTH_CIRCUIT_OPEN" });

    // The whole point: not "the failure was reported", but "nothing was sent".
    // A gate that ran AFTER the request would satisfy the rejection above and
    // still have spent a logon against the shared lock counter.
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mergeCookieHeader — merges a `set-cookie` into an existing `Cookie:` header
// BY NAME, tolerating the array/joined-string shapes and dropping attributes.
// ---------------------------------------------------------------------------

describe("mergeCookieHeader", () => {
  it("overwrites a rotated cookie by name from set-cookie, leaving unrelated cookies untouched", () => {
    const merged = mergeCookieHeader(
      "SAP_SESSIONID=old; other=keep",
      "SAP_SESSIONID=new123; Path=/; HttpOnly",
    );
    const segments = merged.split("; ");
    expect(segments).toContain("SAP_SESSIONID=new123");
    expect(segments).toContain("other=keep");
    expect(segments).not.toContain("SAP_SESSIONID=old");
  });

  it("accepts a string[] set-cookie input", () => {
    const merged = mergeCookieHeader("A=1", ["B=2; Path=/", "A=9; HttpOnly"]);
    const segments = merged.split("; ");
    expect(segments).toContain("A=9");
    expect(segments).toContain("B=2");
    expect(segments).not.toContain("A=1");
  });

  it("accepts a ', '-joined single-string set-cookie input", () => {
    const merged = mergeCookieHeader("A=1", "A=2; Path=/, B=3; HttpOnly");
    const segments = merged.split("; ");
    expect(segments).toContain("A=2");
    expect(segments).toContain("B=3");
    expect(segments).not.toContain("A=1");
  });

  it("drops cookie attributes (Path, HttpOnly, SameSite)", () => {
    const merged = mergeCookieHeader("", "SAP_SESSIONID=abc; Path=/; HttpOnly; SameSite=Lax");
    expect(merged).toBe("SAP_SESSIONID=abc");
  });

  it("does not mis-split an Expires attribute containing a comma into a bogus cookie", () => {
    const setCookie =
      "SAP_SESSIONID=new1; Path=/; Expires=Wed, 21 Oct 2015 07:28:00 GMT; HttpOnly, sap-usercontext=xyz; Path=/";
    const merged = mergeCookieHeader("SAP_SESSIONID=old", setCookie);
    const segments = merged.split("; ");
    // Exactly the two real cookies — no spurious entry carved out of the date.
    expect(segments).toHaveLength(2);
    expect(segments).toContain("SAP_SESSIONID=new1");
    expect(segments).toContain("sap-usercontext=xyz");
  });

  it("returns existing unchanged when set-cookie is undefined", () => {
    expect(mergeCookieHeader("A=1; B=2", undefined)).toBe("A=1; B=2");
  });
});

// ---------------------------------------------------------------------------
// DebugTransport — ordinary (non-long-poll) requests reuse AbapConnection's
// EXISTING breaker + CSRF handling wholesale. This proves the reuse, end to
// end, rather than asserting it in a comment.
// ---------------------------------------------------------------------------

describe("DebugTransport — reuses the existing connection/breaker, no rival path", () => {
  it("a 401 on a debugger GET trips the SAME breaker AbapConnection uses elsewhere", async () => {
    const inner = new CountingClient(() => httpResp(401, "Unauthorized"));
    // The ONLY test in this file that lets a `cfg()`-built connection trip
    // for real. The auth latch is now remembered process-wide, keyed on a
    // fingerprint of (url, user, password), so leaving this on the shared
    // `cfg()` credentials would latch every later `cfg()`/`writableCfg()`
    // connection in this file from birth: they would stop issuing requests and
    // the tests that count them would pass for the wrong reason. Its own
    // password keeps the latch confined to this test.
    // `forConfig` rather than a bare `new AuthCircuitBreaker()`: this is the one
    // test here that CARES about the fingerprint store, and the minting function
    // that used to live inside `AbapConnection` now lives on the breaker. Same
    // body, same tagging, so the isolation the comment above buys still holds.
    const breakerCfg = { ...cfg(), password: "secret-401-trips-shared-breaker" };
    const conn = new AbapConnection(breakerCfg, {
      httpClient: inner,
      breaker: AuthCircuitBreaker.forConfig(breakerCfg),
      log: () => {},
    });
    // `safety` is REQUIRED even though this
    // test is GET-only and never reaches `authorizeMutation` — same permissive
    // gate the mutation-path tests in this file already construct.
    const transport = new DebugTransport(conn, { safety: new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] }) });

    await expect(transport.request({ method: "GET", path: "/sap/bc/adt/debugger/stack" })).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "AUTH_CIRCUIT_OPEN",
    );
    expect(conn.breaker.isTripped).toBe(true);
    expect(inner.calls).toHaveLength(1);

    // Every subsequent debugger request is refused locally — proves DebugTransport
    // did not stand up a second, independent breaker.
    await expect(transport.request({ method: "GET", path: "/sap/bc/adt/debugger/stack" })).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "AUTH_CIRCUIT_OPEN",
    );
    expect(inner.calls).toHaveLength(1);
  });

  it("translates a 404-shaped ADT exception via translateDebugError, not a raw throw", async () => {
    const inner = new CountingClient((_o, n) =>
      n === 1
        ? httpResp(200, "ok", { "content-type": "text/plain" }) // fake login
        : httpResp(404, `<exc:exception><type id="ExceptionResourceNotFound"/></exc:exception>`, {
            "content-type": "application/xml",
          }),
    );
    const conn = new AbapConnection(cfg(), {
      httpClient: inner,
      breaker: new AuthCircuitBreaker(),
      log: () => {},
    });
    await conn.connect();
    // `safety` is REQUIRED even though this
    // test is GET-only and never reaches `authorizeMutation` — same permissive
    // gate the mutation-path tests in this file already construct.
    const transport = new DebugTransport(conn, { safety: new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] }) });
    await expect(
      transport.request({ method: "GET", path: "/sap/bc/adt/debugger/breakpoints/does-not-exist" }),
    ).rejects.toSatisfy((e: unknown) => isAbapError(e) && e.code === "NOT_FOUND");
  });

  it("passes a successful response through untranslated", async () => {
    const inner = new CountingClient((o, n) =>
      n === 1
        ? httpResp(200, "ok", { "content-type": "text/plain" })
        : o.url.includes("/datapreview/freestyle")
          ? httpResp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML)
          : httpResp(200, "<dbg:attach/>", { "content-type": "application/xml" }),
    );
    // Writes enabled: this test issues a debugger POST, which the safety gate
    // below refuses outright on the read-only default. See `writableCfg` — and
    // note the T000 route above, without which connect() cannot prove the
    // system non-productive and the opt-in is ignored (fail-closed).
    const conn = new AbapConnection(writableCfg(), {
      httpClient: inner,
      breaker: new AuthCircuitBreaker(),
      log: () => {},
    });
    await conn.connect();
    // A permissive gate: this test is about response pass-through, not the
    // gate itself — the tests below cover denial/allow in detail.
    const safety = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const transport = new DebugTransport(conn, { safety });
    const r: RawResponse = await transport.request({
      method: "POST",
      path: "/sap/bc/adt/debugger",
      qs: { method: "attach" },
    });
    expect(r.status).toBe(200);
    expect(r.body).toBe("<dbg:attach/>");
  });

  // "A" (the connection that arms breakpoints, runs the listener, and does
  // attach/step/variable/stack calls) must send `X-sap-adt-sessiontype:
  // stateful` on EVERY debugger call — the defect this fixes is that an
  // earlier implementation never sets `Stateful: true`.
  it("sends X-sap-adt-sessiontype: stateful on every ordinary debugger request", async () => {
    const inner = new CountingClient((_o, n) =>
      n === 1
        ? httpResp(200, "ok", { "content-type": "text/plain" }) // fake login
        : httpResp(200, "<dbg:attach/>", { "content-type": "application/xml" }),
    );
    const conn = new AbapConnection(cfg(), {
      httpClient: inner,
      breaker: new AuthCircuitBreaker(),
      log: () => {},
    });
    await conn.connect();
    // `safety` is REQUIRED even though this
    // test is GET-only and never reaches `authorizeMutation` — same permissive
    // gate the mutation-path tests in this file already construct.
    const transport = new DebugTransport(conn, { safety: new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] }) });
    await transport.request({
      method: "GET",
      path: "/sap/bc/adt/debugger/stack",
      headers: { Accept: "application/xml" }, // caller-supplied header must survive alongside it
    });

    const debugCall = inner.calls[inner.calls.length - 1];
    expect(debugCall.headers?.["X-sap-adt-sessiontype"]).toBe("stateful");
    expect(debugCall.headers?.Accept).toBe("application/xml"); // not clobbered
  });
});

// ---------------------------------------------------------------------------
// Regression: a background rejection of `handle.result` must never surface as
// a Node `unhandledRejection` — callers routinely await `handle.armed`, go do
// other work for a while, and only await `handle.result` afterwards.
// ---------------------------------------------------------------------------
describe("unhandled rejection safety", () => {
  it("a background rejection of result does not become an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const breaker = new AuthCircuitBreaker();
      const requestFn: RawHttpRequestFn = () =>
        new Promise((_resolve, reject) => {
          // Simulates a background transport failure (reject site transport.ts:715)
          // that lands well after the caller has moved on from `armed`.
          setTimeout(() => reject(new Error("transport failed in the background")), 20);
        });
      const client = new DebugLongPollClient({
        baseUrl: "http://sap.invalid",
        breaker,
        auth: { cookieHeader: () => "", csrfToken: () => "TOKEN", acquireSession: ACQUIRE_NO_SESSION_LEASE },
        requestFn,
      });

      const handle = client.listen("/sap/bc/adt/debugger/listeners");
      await handle.armed; // caller now goes off to do other work...

      // ...and deliberately does NOT await `handle.result` yet. Give the
      // background rejection (fires at ~20ms) plenty of time to land and for
      // Node to run its unhandledRejection microtask checkpoint.
      await new Promise((r) => setTimeout(r, 150));

      expect(unhandled).toEqual([]);

      // The rejection must still be observable by a late consumer — the fix
      // must not simply swallow the error.
      await expect(handle.result).rejects.toBeDefined();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});

// ---------------------------------------------------------------------------
// Socket-pool isolation for the long poll — the ONE bug in this module that
// nothing offline could previously see.
//
// Root cause (wire-proven live):
// `defaultRawHttpRequest` passed no `agent`, so it used `http.globalAgent` /
// `https.globalAgent`. An earlier request left a keep-alive socket in that
// shared pool carrying a stale idle timeout, and `socket.setTimeout()` PERSISTS
// across pool reuse. The long poll picked that socket up, inherited the stale
// timer, and — being idle by definition — was destroyed *locally* with an
// ECONNRESET "socket hang up" that looks like a server fault but is ours.
// (Note for anyone re-deriving the 5000ms figure: on Node >= 19 `http.globalAgent`
// is itself constructed with `timeout: 5000`, so the poison does not even need a
// third-party library to plant it.)
//
// Everything below is 100% offline: a loopback (127.0.0.1) `http.createServer`
// on an ephemeral port, closed in a `finally` so the suite can never hang.
// ---------------------------------------------------------------------------

/** How long the `/slow` route holds its response open. Deliberately short. */
const SLOW_ROUTE_HOLD_MS = 400;
/** The stale idle timer planted on the pooled socket. 4x margin below the hold. */
const POISON_IDLE_MS = 100;

interface Loopback {
  /** e.g. `http://127.0.0.1:47123` */
  base: string;
  /** Count of TCP connections the server has accepted so far. */
  connections: () => number;
  /** Whether `/slow`'s delayed 200 was actually written (its hold timer fired). */
  slowRouteReleased: () => boolean;
}

/**
 * Two routes: `/fast` answers immediately (used to prime the keep-alive pool),
 * `/slow` holds the response open for {@link SLOW_ROUTE_HOLD_MS} (stands in for
 * a long poll that is idle on the wire). The server is always closed in the
 * `finally`, and every response is defended against a client that vanishes
 * mid-flight (which is exactly what the control test below makes happen).
 */
async function withLoopbackServer<T>(fn: (lb: Loopback) => Promise<T>): Promise<T> {
  let connections = 0;
  let slowRouteReleased = false;
  const server = http.createServer((req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    if ((req.url ?? "").startsWith("/slow")) {
      const timer = setTimeout(() => {
        if (!res.writableEnded && !res.destroyed) {
          slowRouteReleased = true;
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("slow");
        }
      }, SLOW_ROUTE_HOLD_MS);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("fast");
  });
  server.on("connection", () => {
    connections++;
  });
  server.keepAliveTimeout = 60_000;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("loopback server has no port");
  try {
    return await fn({
      base: `http://127.0.0.1:${address.port}`,
      connections: () => connections,
      slowRouteReleased: () => slowRouteReleased,
    });
  } finally {
    http.globalAgent.destroy();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** One `/fast` request THROUGH `http.globalAgent`, leaving its socket in the free pool. */
function primeGlobalAgentPool(base: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(`${base}/fast`), { method: "GET" }, (res) => {
      res.resume();
      // `setImmediate` so Node's own nextTick-scheduled "return socket to the
      // free pool" bookkeeping has already run by the time we poison it.
      res.on("end", () => setImmediate(resolve));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Reproduce a poisoned pool: give every socket sitting in `http.globalAgent`'s
 * free list a stale idle timer that destroys it when it fires. This is the
 * simulated form of the live poisoning (a leftover `socket.setTimeout` from an
 * earlier consumer) — done explicitly so the reproduction is deterministic in
 * milliseconds rather than depending on which library ran before us.
 * Returns how many pooled sockets were poisoned.
 */
function poisonFreeSockets(idleMs: number): number {
  const free = Object.values(http.globalAgent.freeSockets).flatMap((s) => s ?? []);
  for (const socket of free) {
    socket.once("timeout", () => socket.destroy());
    socket.setTimeout(idleMs);
  }
  return free.length;
}

describe("RawHttpRequest.longPoll — the opt-in is set on exactly one call site", () => {
  it("DebugLongPollClient dispatches the listener POST with longPoll: true", async () => {
    const breaker = new AuthCircuitBreaker();
    const seen: RawHttpRequest[] = [];
    const requestFn: RawHttpRequestFn = async (req) => {
      seen.push(req);
      return { status: 200, headers: {}, body: "" };
    };
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "SAP_SESSIONID=x", csrfToken: () => "TOKEN", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      requestFn,
    });

    const result = await client.listen("/sap/bc/adt/debugger/listeners").result;
    expect(result.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.longPoll).toBe(true);
  });

  it("the CSRF-refresh HEAD must NOT opt in — a genuinely hung short request has to be able to fail", async () => {
    const breaker = new AuthCircuitBreaker();
    const seen: RawHttpRequest[] = [];
    const requestFn: RawHttpRequestFn = async (req) => {
      seen.push(req);
      if (req.method === "HEAD") return { status: 200, headers: { "x-csrf-token": "FRESH" }, body: "" };
      return req.headers?.["x-csrf-token"] === "FRESH"
        ? { status: 200, headers: {}, body: "" }
        : { status: 403, headers: { "x-csrf-token": "Required" }, body: "CSRF token missing" };
    };
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "", csrfToken: () => "STALE", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      requestFn,
    });

    await client.listen("/sap/bc/adt/debugger/listeners").result;
    expect(seen.map((r) => r.method)).toEqual(["POST", "HEAD", "POST"]);
    // Every POST opts in; the HEAD deliberately does not (and is not merely
    // `false` by accident — the field is absent, so `agent` stays unset too).
    expect(seen.filter((r) => r.method === "POST").map((r) => r.longPoll)).toEqual([true, true]);
    expect(seen.find((r) => r.method === "HEAD")?.longPoll).toBeUndefined();
  });
});

describe("defaultRawHttpRequest — a stale pooled socket cannot kill an in-flight long poll", () => {
  it("survives a poisoned globalAgent pool and resolves 200 (the regression)", async () => {
    await withLoopbackServer(async ({ base }) => {
      await primeGlobalAgentPool(base);
      expect(poisonFreeSockets(POISON_IDLE_MS)).toBe(1); // the pool really is loaded and poisoned

      const started = Date.now();
      const resp = await defaultRawHttpRequest({
        method: "POST",
        url: `${base}/slow`,
        longPoll: true,
      });

      expect(resp.status).toBe(200);
      expect(resp.body).toBe("slow");
      // It genuinely waited out the hold — it did not resolve early off some
      // other socket, and it did not die at POISON_IDLE_MS.
      expect(Date.now() - started).toBeGreaterThanOrEqual(POISON_IDLE_MS);
    });
  });

  it("CONTROL — the identical request WITHOUT the opt-in dies with ECONNRESET 'socket hang up'", async () => {
    // This is the test's teeth. Without `agent: false` + `setTimeout(0)` the
    // long poll IS this control: destroyed locally, mid-flight, by a timer it
    // never set, with the exact error text seen live against A4H.
    await withLoopbackServer(async ({ base }) => {
      await primeGlobalAgentPool(base);
      expect(poisonFreeSockets(POISON_IDLE_MS)).toBe(1);

      const err = await defaultRawHttpRequest({ method: "POST", url: `${base}/slow` }).then(
        () => undefined,
        (e: unknown) => e as NodeJS.ErrnoException,
      );

      expect(err).toBeDefined();
      expect(err?.code).toBe("ECONNRESET");
      expect(err?.message).toMatch(/socket hang up/i);
    });
  });
});

describe("defaultRawHttpRequest — ordinary requests keep their normal pooling/timeout behaviour", () => {
  it("only the long poll gets a fresh socket; an ordinary request still reuses the shared pool", async () => {
    // Pins `agent: false` as strictly OPT-IN. If someone later makes it (or the
    // `setTimeout(0)` neutralisation) unconditional, the ordinary request stops
    // reusing the pooled socket and the second assertion fails immediately.
    await withLoopbackServer(async ({ base, connections }) => {
      await primeGlobalAgentPool(base);
      expect(connections()).toBe(1);

      const ordinary = await defaultRawHttpRequest({ method: "GET", url: `${base}/fast` });
      expect(ordinary.status).toBe(200);
      expect(connections()).toBe(1); // reused the pooled socket — globalAgent still in play

      const poll = await defaultRawHttpRequest({ method: "GET", url: `${base}/fast`, longPoll: true });
      expect(poll.status).toBe(200);
      expect(connections()).toBe(2); // brand-new socket, zero inherited state
    });
  });

  it("an ordinary request is still subject to a socket timer it inherited (it is NOT neutralised)", async () => {
    // The complement of the CONTROL above, stated as a requirement rather than
    // as a harness check: a genuinely hung SHORT request must still be able to
    // fail. Making `setTimeout(0)` unconditional would make this resolve 200.
    await withLoopbackServer(async ({ base, slowRouteReleased }) => {
      await primeGlobalAgentPool(base);
      expect(poisonFreeSockets(POISON_IDLE_MS)).toBe(1);

      const err = await defaultRawHttpRequest({ method: "GET", url: `${base}/slow` }).then(
        () => undefined,
        (e: unknown) => e as NodeJS.ErrnoException,
      );

      expect(err?.code).toBe("ECONNRESET");
      // Ordering, not duration: died before /slow's hold timer ever released its
      // response. A wall-clock bound here is a flaky proxy for the same fact.
      expect(slowRouteReleased()).toBe(false);
    });
  });
});

describe("defaultRawHttpRequest — the https transport takes the same opt-in path", () => {
  it("an https:// long poll reaches the network and fails with a CONNECTION error, never a hang-up", async () => {
    // No TLS needed: `url.protocol` selects `https` before the `longPoll`
    // options are applied, so both protocols run through one shared options
    // object. Proving the request leaves the process and comes back with a
    // connect-level refusal (not a timeout, not ECONNRESET) is enough to show
    // the opt-in did not break/park the https branch.
    const started = Date.now();
    const err = await defaultRawHttpRequest({
      method: "POST",
      url: "https://127.0.0.1:1/sap/bc/adt/debugger/listeners",
      longPoll: true,
    }).then(
      () => undefined,
      (e: unknown) => e as NodeJS.ErrnoException,
    );

    expect(err?.code).toBe("ECONNREFUSED");
    expect(err?.message).not.toMatch(/socket hang up/i);
    expect(Date.now() - started).toBeLessThan(5_000); // fails fast — no inherited ceiling, no hang
  });
});

describe("longPoll: true preserves abort semantics", () => {
  it("a genuine abort surfaces as LongPollAborted, NOT as an ECONNRESET", async () => {
    // The whole point of the distinction: a cancellation the caller asked for
    // must stay diagnosable, and must never be confused with the socket-hang-up
    // failure mode the fix above eliminated.
    await withLoopbackServer(async ({ base }) => {
      const controller = new AbortController();
      const pending = defaultRawHttpRequest({
        method: "POST",
        url: `${base}/slow`,
        longPoll: true,
        signal: controller.signal,
      });
      const timer = setTimeout(() => controller.abort(), 50);
      const err = await pending.then(
        () => undefined,
        (e: unknown) => e,
      );
      clearTimeout(timer);

      expect(err).toBeInstanceOf(LongPollAborted);
      expect((err as Error).name).toBe("AbortError");
      expect((err as NodeJS.ErrnoException).code).not.toBe("ECONNRESET");
    });
  });

  it("end to end over the REAL transport, DebugLongPollClient.abort() still yields 'Long-poll cancelled'", async () => {
    // Same assertion the injected-fake cancellation tests make, but running
    // through `defaultRawHttpRequest` itself (no requestFn override) against
    // loopback — so the `longPoll: true` dispatch is exercised for real.
    await withLoopbackServer(async ({ base }) => {
      const breaker = new AuthCircuitBreaker();
      const client = new DebugLongPollClient({
        baseUrl: base,
        breaker,
        auth: { cookieHeader: () => "", csrfToken: () => "TOKEN", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      });

      const handle = client.listen("/slow");
      await handle.armed;
      await new Promise((r) => setTimeout(r, 30));
      handle.abort();

      const err = await handle.result.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isAbapError(err) && err.code === "TRANSPORT_ERROR").toBe(true);
      expect((err as Error).message).toMatch(/Long-poll cancelled/);
      expect((err as Error).message).not.toMatch(/socket hang up/i);
    });
  });
});

// ---------------------------------------------------------------------------
// LIVE-CAPTURED dead-session envelopes (A4H, 2026-07). These are not idealised
// fixtures: the XML below is the body the appliance actually returned, taken at
// the http-guard layer, and the exceptions are built by running it through the
// REAL `abap-adt-api` parser (`fromResponse`) rather than by hand-rolling an
// object that merely looks like what the library throws. That distinction is
// the whole point — an earlier round of this fix was written against a guessed
// shape (`AdtHttpException`, no `properties`) and shipped a classifier that
// could not fire.
// ---------------------------------------------------------------------------
describe("dead debug session — real captured <exc:exception> envelopes", () => {
  /** The captured getStack body, verbatim apart from indentation. */
  const capturedEnvelope = (
    previous2: string,
    subType: string,
  ): string => `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="AdiFailed"/>
  <message lang="EN">An exception was raised</message>
  <properties>
    <entry key="previous1ExceptionClassName">CX_TPDAPI_FAILURE</entry>
    <entry key="previous2ExceptionClassName">${previous2}</entry>
    <entry key="com.sap.adt.communicationFramework.subType">${subType}</entry>
    <entry key="previous1Text">An exception was raised</entry>
    <entry key="previous1SourcePositionProgram">CL_TPDAPI_SESSION============CP</entry>
    <entry key="T100KEY-ID">SY</entry>
    <entry key="T100KEY-NO">530</entry>
  </properties>
</exc:exception>`;

  /** Runs the captured body through the library exactly as the live path does. */
  const thrownByLibrary = (previous2: string, subType: string): unknown => {
    const body = capturedEnvelope(previous2, subType);
    return fromResponse(body, {
      body,
      status: 500,
      statusText: "Internal Server Error",
      headers: { "content-type": "application/xml" },
    });
  };

  it("the library throws AdtErrorException WITH a populated property map (not AdtHttpException)", () => {
    // The premise the previous fix got wrong, pinned so it cannot be re-guessed.
    const thrown = thrownByLibrary("CX_TPDA_SYS_COMM_SLAVENOTCONN", "getStack") as Record<
      string,
      unknown
    >;
    expect((thrown as object).constructor.name).toBe("AdtErrorException");
    expect(Object.prototype.hasOwnProperty.call(thrown, "properties")).toBe(true);
    expect((thrown.properties as Record<string, string>).previous2ExceptionClassName).toBe(
      "CX_TPDA_SYS_COMM_SLAVENOTCONN",
    );
    // …and NO `response`: fromResponse constructs with seven arguments, so the raw body is gone.
    expect(thrown.response).toBeUndefined();
  });

  it("getStack / CX_TPDA_SYS_COMM_SLAVENOTCONN → SESSION_DEAD", () => {
    const err = adtErrorFromException(
      thrownByLibrary("CX_TPDA_SYS_COMM_SLAVENOTCONN", "getStack"),
      "/sap/bc/adt/debugger/stack",
    );
    // The bounded extractor accepts BOTH captured class names — verified, not reasoned about.
    expect(err.exceptionClassNames).toEqual([
      "CX_TPDAPI_FAILURE",
      "CX_TPDA_SYS_COMM_SLAVENOTCONN",
    ]);
    expect(err.abapType).toBe("AdiFailed");
    expect(err.subtype).toBe("getStack");
    // The raw body never reaches us: bodyExcerpt degrades to the 23-char message.
    expect(err.bodyExcerpt).toBe("An exception was raised");

    const e = translateDebugError(err);
    expect(e.code).toBe("SESSION_DEAD");
    expect(e.details.subtype).toBe("getStack");
  });

  it("terminateDebuggee / CX_TPDA_SYS_COMM_DBGSESSIONEND → SESSION_DEAD", () => {
    const err = adtErrorFromException(
      thrownByLibrary("CX_TPDA_SYS_COMM_DBGSESSIONEND", "terminateDebuggee"),
      "/sap/bc/adt/debugger",
    );
    expect(err.exceptionClassNames).toContain("CX_TPDA_SYS_COMM_DBGSESSIONEND");
    const e = translateDebugError(err);
    expect(e.code).toBe("SESSION_DEAD");
    // DebugClient.terminateDebuggee() keys on these two, whichever branch classifies.
    expect(e.details.subtype).toBe("terminateDebuggee");
    expect(e.details.status).toBe(500);
  });

  it("an AdiFailed 500 with NO session-end class name is still ADT_ERROR", () => {
    const err = adtErrorFromException(
      thrownByLibrary("CX_TPDA_SYS_COMM_TIMEOUT", "getStack"),
      "/sap/bc/adt/debugger/stack",
    );
    expect(err.exceptionClassNames).toEqual(["CX_TPDAPI_FAILURE", "CX_TPDA_SYS_COMM_TIMEOUT"]);
    const e = translateDebugError(err);
    // Same status, same abapType, same subtype as the SESSION_DEAD case above — only the class
    // name differs, which proves the discriminator keys on the class name and nothing else.
    expect(e.code).toBe("ADT_ERROR");
    expect(e.details.exceptionClassNames).toEqual([
      "CX_TPDAPI_FAILURE",
      "CX_TPDA_SYS_COMM_TIMEOUT",
    ]);
  });

  it("CX_TPDAPI_FAILURE alone (the generic ADI wrapper) does not mean the session is gone", () => {
    const body = `<exc:exception><type id="AdiFailed"/><message>An exception was raised</message>` +
      `<properties><entry key="previous1ExceptionClassName">CX_TPDAPI_FAILURE</entry></properties></exc:exception>`;
    const err = adtErrorFromException(
      fromResponse(body, {
        body,
        status: 500,
        statusText: "Internal Server Error",
        headers: {},
      }),
      "/sap/bc/adt/debugger/stack",
    );
    expect(translateDebugError(err).code).toBe("ADT_ERROR");
  });
});

// ===========================================================================
// Regression tests.
//
// Each block below fails on the code as it stood before its fix; the exact
// pre-fix behaviour it pins is named in each `it()`.
// ===========================================================================

// ---------------------------------------------------------------------------
// `ExceptionResourceNoAccess` used to collapse into `AUTH_FAILED`, which
// told the operator to check credentials for a problem that, in the ONLY live
// capture we have, is a self-inflicted ENQUEUE lock. The bytes below are read
// from the capture file itself (not retyped) and run through the REAL
// `abap-adt-api` parser, so the test cannot pass against a shape SAP does not
// actually send.
// ---------------------------------------------------------------------------
describe("ExceptionResourceNoAccess is AMBIGUOUS, not AUTH_FAILED (live-captured bytes)", () => {
  /** HTTP 403, POST /sap/bc/adt/activation?method=activate — A4H, 2026-07. */
  const capturedBody = readFileSync(join(LIVE_CAPTURED_DIR, "095-np-activate.xml"), "utf8");

  const capturedError = (): AdtError =>
    adtErrorFromException(
      fromResponse(capturedBody, {
        body: capturedBody,
        status: 403,
        statusText: "Forbidden",
        headers: { "content-type": "application/xml" },
      }),
      "/sap/bc/adt/activation",
    );

  it("the capture really is the shape this branch keys on (403 + <type id=ExceptionResourceNoAccess/>)", () => {
    // Pin the premise, so a fixture edit fails here rather than silently making
    // every assertion below vacuous.
    expect(capturedBody).toContain('<type id="ExceptionResourceNoAccess"/>');
    expect(capturedBody).toContain('<entry key="T100KEY-ID">EU</entry>');
    expect(capturedBody).toContain('<entry key="T100KEY-NO">510</entry>');
    const err = capturedError();
    expect(err.status).toBe(403);
    expect(err.abapType).toBe(RESOURCE_NO_ACCESS_TYPE);
    expect(isResourceNoAccess(err)).toBe(true);
  });

  it("classifies as AMBIGUOUS and NOT as AUTH_FAILED (the pre-fix answer)", () => {
    const e = translateDebugError(capturedError());
    expect(e.code).toBe("AMBIGUOUS");
    expect(e.code).not.toBe("AUTH_FAILED"); // ← what this branch used to return
  });

  it("names BOTH meanings, machine-readably and in prose, with a next step for each", () => {
    const e = translateDebugError(capturedError());
    // Machine-readable: a caller can branch on the pair without parsing prose.
    expect(e.details.possibleCauses).toEqual(["lock-conflict", "missing-authorization"]);
    // Prose names both meanings...
    expect(e.message).toMatch(/LOCKED/);
    expect(e.message).toMatch(/AUTHORISATION/);
    // ...and the hint gives the concrete next step for each of them.
    expect(e.hint).toMatch(/SM12/); // (a) lock: clear/await the ENQUEUE
    expect(e.hint).toMatch(/S_DEVELOP/); // (b) authorisation: check the auth object
    expect(e.hint).toMatch(/SU53/);
    // And it must NOT send the operator down the credentials path: repeated
    // logons lock the SAP user, and the logon here demonstrably succeeded.
    expect(e.hint).toMatch(/NOT a credentials problem/i);
  });

  it("the EN message text is an annotation only — it never becomes the classification", () => {
    const e = translateDebugError(capturedError());
    // The captured (English) text matches the T100 EU/510 lock wording, so the
    // lock reading is flagged as the likelier one...
    expect(e.details.likelyCause).toBe("lock-conflict");
    expect(e.details.evidence).toBe("t100-eu510-message-text");
    // ...but the code stays AMBIGUOUS and BOTH causes stay listed: the text is
    // localised, so a non-match proves nothing and must not narrow the answer.
    expect(e.code).toBe("AMBIGUOUS");
    expect(e.details.possibleCauses).toEqual(["lock-conflict", "missing-authorization"]);
  });

  it("a non-English (unmatchable) rendering of the SAME exception still classifies identically", () => {
    // Same `<type id>`, German message: the structural discriminator carries the
    // whole classification, the text carries only the optional hint.
    const german = capturedBody.replace(
      /User DEVELOPER is currently editing ZMCP_DBG_DEMO/g,
      "Benutzer DEVELOPER bearbeitet gerade ZMCP_DBG_DEMO",
    );
    expect(german).not.toContain("is currently editing");
    const e = translateDebugError(
      adtErrorFromException(
        fromResponse(german, {
          body: german,
          status: 403,
          statusText: "Forbidden",
          headers: { "content-type": "application/xml" },
        }),
        "/sap/bc/adt/activation",
      ),
    );
    expect(e.code).toBe("AMBIGUOUS");
    expect(e.details.possibleCauses).toEqual(["lock-conflict", "missing-authorization"]);
    // No hint claimed, because nothing in these bytes supports one.
    expect(e.details.likelyCause).toBeUndefined();
  });

  it("an ordinary 403 that is NOT ExceptionResourceNoAccess is still AUTH_FAILED", () => {
    // Proves the new branch keys on the exception type and did not swallow the
    // whole 403 class into a hedge.
    const body = `<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework"><type id="ExceptionSecurityRestriction"/><message lang="EN">Refused</message></exc:exception>`;
    const e = translateDebugError(
      adtErrorFromException(
        fromResponse(body, { body, status: 403, statusText: "Forbidden", headers: {} }),
        "/sap/bc/adt/debugger",
      ),
    );
    expect(e.code).toBe("AUTH_FAILED");
  });
});

// ---------------------------------------------------------------------------
// `DebugTransport.request()` called `connection.post/put/del` directly,
// so a debugger POST (attach, step, terminate — all of which suspend and
// resume real work processes) went out on a server explicitly running
// read-only. `AbapConnection`'s own post/put/del only consult the circuit
// breaker; the read-only decision lives one layer up, and the transport was
// reaching past it.
// ---------------------------------------------------------------------------
describe("debugger mutations go through the safety gate, not around it", () => {
  /**
   * The fake answers the two routes `connect()` actually asks about, on the
   * real captured bytes:
   *   - the T000 data preview → capture `087`, the 200 a non-productive A4H
   *     sends. Without it the system is `inconclusive` and EVERY config below
   *     — including `writableCfg()` — is forced read-only, which would make
   *     the "gate is a gate, not a wall" test unfalsifiable.
   *   - `ato/settings` is left on the generic 200; it names no role on this
   *     release, and it can only ever escalate TO productive, never away from
   *     it, so a generic body is the honest A4H answer.
   * Whether writes end up enabled is then decided by the CONFIG alone —
   * exactly the distinction these tests exist to pin.
   */
  const connected = async (config: Config) => {
    const inner = new CountingClient((o, n) =>
      n === 1
        ? httpResp(200, "ok", { "content-type": "text/plain" }) // fake login
        : o.url.includes("/datapreview/freestyle")
          ? httpResp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML)
          : httpResp(200, "<dbg:ok/>", { "content-type": "application/xml" }),
    );
    const conn = new AbapConnection(config, {
      httpClient: inner,
      breaker: new AuthCircuitBreaker(),
      log: () => {},
    });
    await conn.connect();
    return { inner, conn, callsAfterConnect: inner.calls.length };
  };

  it("refuses a debugger POST on a read-only server, locally, with zero network calls", async () => {
    const { inner, conn, callsAfterConnect } = await connected(cfg());
    expect(conn.readOnly).toBe(true);
    // …and read-only for the reason this suite is about: the ABAP_ALLOW_WRITE
    // default, on a system that WAS successfully proven non-productive. Pinned
    // because the alternative — a fake so thin that connect() cannot classify
    // the system, so writes are locked out fail-closed — refuses every mutation
    // too, and would let all four denial tests below keep passing while
    // testing something else entirely.
    expect(conn.info().systemRole).toBe("development");
    expect(conn.readOnlyReason).toMatch(/ABAP_ALLOW_WRITE is not set/);
    // A permissive gate on purpose: this test is about the CONNECTION's own
    // readOnly check (step 2 of authorizeMutation), which fires "gate or no
    // gate" — a gate-less transport would refuse one step earlier, with
    // SAFETY_DENIED, and never exercise this branch at all.
    const safety = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const transport = new DebugTransport(conn, { safety });

    await expect(
      transport.request({ method: "POST", path: "/sap/bc/adt/debugger", qs: { method: "attach" } }),
    ).rejects.toSatisfy((e: unknown) => isAbapError(e) && e.code === "READ_ONLY");
    // The whole point: the request never left the process. Pre-fix this was a
    // real POST that attached the debugger to a live work process.
    expect(inner.calls).toHaveLength(callsAfterConnect);
  });

  it("refuses PUT and DELETE on a read-only server too, not just POST", async () => {
    const { inner, conn, callsAfterConnect } = await connected(cfg());
    const safety = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const transport = new DebugTransport(conn, { safety });
    for (const method of ["PUT", "DELETE"] as const) {
      await expect(
        transport.request({ method, path: "/sap/bc/adt/debugger/breakpoints" }),
      ).rejects.toSatisfy((e: unknown) => isAbapError(e) && e.code === "READ_ONLY");
    }
    expect(inner.calls).toHaveLength(callsAfterConnect);
  });

  it("still allows GET on a read-only server — reading a stack changes nothing", async () => {
    const { inner, conn, callsAfterConnect } = await connected(cfg());
    // `safety` is REQUIRED even though this
    // test is GET-only and never reaches `authorizeMutation` — same permissive
    // gate the mutation-path tests in this file already construct.
    const transport = new DebugTransport(conn, { safety: new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] }) });
    const r = await transport.request({ method: "GET", path: "/sap/bc/adt/debugger/stack" });
    expect(r.status).toBe(200);
    // ">" rather than "=== +1": AbapConnection may spend an extra CSRF fetch.
    expect(inner.calls.length).toBeGreaterThan(callsAfterConnect);
  });

  it("the refusal explains itself and cites the flag that would enable it", async () => {
    const { conn } = await connected(cfg());
    const safety = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const err = await new DebugTransport(conn, { safety })
      .request({ method: "POST", path: "/sap/bc/adt/debugger" })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(isAbapError(err)).toBe(true);
    const e = err as import("../src/adt/errors.js").AbapError;
    expect(e.hint).toMatch(/ABAP_ALLOW_WRITE/);
    expect(e.details.method).toBe("POST");
  });

  it("a POST is allowed once writes are enabled (the gate is a gate, not a wall)", async () => {
    const { inner, conn, callsAfterConnect } = await connected(writableCfg());
    expect(conn.readOnly).toBe(false);
    const safety = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const r = await new DebugTransport(conn, { safety }).request({
      method: "POST",
      path: "/sap/bc/adt/debugger",
      qs: { method: "attach" },
    });
    expect(r.status).toBe(200);
    expect(inner.calls.length).toBeGreaterThan(callsAfterConnect);
  });

  it("an injected SafetyGate can deny a mutation the connection alone would allow", async () => {
    const { inner, conn, callsAfterConnect } = await connected(writableCfg());
    const safety = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const transport = new DebugTransport(conn, {
      safety,
      // Debuggee outside the package allowlist.
      target: { name: "ZOTHER", packageName: "ZNOT_ALLOWLISTED" },
    });
    await expect(
      transport.request({ method: "POST", path: "/sap/bc/adt/debugger", qs: { method: "attach" } }),
    ).rejects.toSatisfy((e: unknown) => isAbapError(e) && e.code === "SAFETY_DENIED");
    expect(inner.calls).toHaveLength(callsAfterConnect);

    // …and permits it when the target IS allowlisted, so the gate is not simply
    // refusing everything with a `target` set.
    const ok = new DebugTransport(conn, {
      safety,
      target: { name: "ZMCP_DBG_DEMO", packageName: "$TMP" },
    });
    const r = await ok.request({ method: "POST", path: "/sap/bc/adt/debugger" });
    expect(r.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Both debugger paths FED the shared breaker (`inspect()`) while never
// being STOPPED by it: they never called `allowRequest()`. Worst of both
// worlds — these calls could push the breaker open for every other caller in
// the process and then sail straight through it themselves, request after
// request, onto a system already refusing everyone else.
// ---------------------------------------------------------------------------
describe("the debugger paths ask the breaker before spending a request on it", () => {
  /** A breaker in the transient-open (cooling down) phase, not auth-latched. */
  const transientlyOpen = (): AuthCircuitBreaker => {
    const b = new AuthCircuitBreaker({ cooldownMs: 60_000, failureThreshold: 1 });
    b.recordTransientFailure({ status: 503, url: "http://sap.invalid/other" });
    expect(b.state).toBe("open");
    expect(b.isTripped).toBe(false); // NOT the permanent auth latch
    return b;
  };

  it("fetchCsrfToken sheds its HEAD while the breaker is transiently open", async () => {
    const breaker = transientlyOpen();
    let calls = 0;
    const requestFn: RawHttpRequestFn = async () => {
      calls++;
      return { status: 200, headers: { "x-csrf-token": "TOK" }, body: "" };
    };
    await expect(
      fetchCsrfToken({ baseUrl: "http://sap.invalid", breaker, requestFn }),
    ).rejects.toSatisfy((e: unknown) => isAbapError(e) && e.code === "CIRCUIT_OPEN_TRANSIENT");
    // Pre-fix this HEAD went out regardless of the breaker's state.
    expect(calls).toBe(0);
  });

  it("DebugLongPollClient sheds its POST while the breaker is transiently open", async () => {
    const breaker = transientlyOpen();
    let calls = 0;
    const requestFn: RawHttpRequestFn = async () => {
      calls++;
      return { status: 200, headers: {}, body: "<dbg:debuggee/>" };
    };
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "SAP_SESSIONID=x", csrfToken: () => "TOKEN", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      requestFn,
    });
    await expect(client.listen("/sap/bc/adt/debugger/listeners").result).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "CIRCUIT_OPEN_TRANSIENT",
    );
    expect(calls).toBe(0);
  });

  it("the asymmetry itself: a long-poll that OPENS the breaker is then shed by it", async () => {
    // This is the defect in one test. Pre-fix, call 2 went out exactly like
    // call 1 — the path fed the breaker and ignored it.
    const breaker = new AuthCircuitBreaker({ cooldownMs: 60_000, failureThreshold: 1 });
    let calls = 0;
    const requestFn: RawHttpRequestFn = async () => {
      calls++;
      return { status: 503, headers: {}, body: "<html>Service Unavailable</html>" };
    };
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "", csrfToken: () => "TOKEN", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      requestFn,
    });

    // 1st listen: goes out (breaker closed), 503 feeds the transient machine.
    await expect(client.listen("/sap/bc/adt/debugger/listeners").result).rejects.toThrow();
    expect(calls).toBe(1);
    expect(breaker.state).toBe("open");

    // 2nd listen: refused locally, by the very breaker the 1st call opened.
    await expect(client.listen("/sap/bc/adt/debugger/listeners").result).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "CIRCUIT_OPEN_TRANSIENT",
    );
    expect(calls).toBe(1); // ← the whole point
  });

  it("a half-open probe is resolved, never wedged — a plain 4xx still frees the probe slot", async () => {
    // `inspect()` resolves the probe for 2xx/3xx and 5xx/408/429 but not for a
    // plain 4xx; without the explicit resolution in run()'s finally, the single
    // probe slot would stay claimed and refuse every later request forever.
    const breaker = new AuthCircuitBreaker({ cooldownMs: 1, failureThreshold: 1 });
    let calls = 0;
    const requestFn: RawHttpRequestFn = async () => {
      calls++;
      return { status: 404, headers: {}, body: `<exc:exception><type id="ExceptionResourceNotFound"/></exc:exception>` };
    };
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "", csrfToken: () => "TOKEN", acquireSession: ACQUIRE_NO_SESSION_LEASE },
      requestFn,
    });
    breaker.recordTransientFailure({ status: 503 });
    await new Promise((r) => setTimeout(r, 5)); // let the 1ms cooldown elapse
    expect(breaker.state).toBe("half-open");

    await expect(client.listen("/sap/bc/adt/debugger/listeners").result).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "NOT_FOUND",
    );
    expect(calls).toBe(1);
    // The probe reported back: no probe is left in flight.
    expect(breaker.status().probeInFlight).toBe(false);
  });

  it("an auth-latched breaker still wins over the transient machine (AUTH_CIRCUIT_OPEN, not CIRCUIT_OPEN_TRANSIENT)", async () => {
    const breaker = new AuthCircuitBreaker({ cooldownMs: 60_000, failureThreshold: 1 });
    breaker.recordTransientFailure({ status: 503 });
    breaker.trip("http-401", "Unauthorized", { status: 401 });
    let calls = 0;
    const requestFn: RawHttpRequestFn = async () => {
      calls++;
      return { status: 200, headers: { "x-csrf-token": "TOK" }, body: "" };
    };
    await expect(
      fetchCsrfToken({ baseUrl: "http://sap.invalid", breaker, requestFn }),
    ).rejects.toSatisfy((e: unknown) => isAbapError(e) && e.code === "AUTH_CIRCUIT_OPEN");
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Before this fix, `DebugTransport.request()` set
// `connection.adt.stateful = session_types.stateful` (transport.ts:1013) and
// never put it back. `connection.adt` is the ONE shared `ADTClient` for the
// whole process, so the first debugger call in a process left the flag latched
// stateful forever — every later ORDINARY read (getObjectSource, a search, an
// activation) silently rode out as `X-sap-adt-sessiontype: stateful`. The fix
// saves the pre-call value and restores it in a `finally` (transport.ts:1037),
// on every exit path including a throw.
// ---------------------------------------------------------------------------
describe("stateful flag save/restore (request() must not leave the shared ADTClient latched stateful)", () => {
  it("restores connection.adt.stateful to its pre-call value after a successful debug mutation", async () => {
    const inner = new CountingClient((o, n) =>
      n === 1
        ? httpResp(200, "ok", { "content-type": "text/plain" }) // fake login
        : o.url.includes("/datapreview/freestyle")
          ? httpResp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML)
          : httpResp(200, "<dbg:attach/>", { "content-type": "application/xml" }),
    );
    // writableCfg(): this issues a debugger POST (a mutation), which the
    // safety gate refuses outright on the read-only default — see writableCfg's
    // doc comment and the T000 fixture it depends on to prove non-productive.
    const conn = new AbapConnection(writableCfg(), {
      httpClient: inner,
      breaker: new AuthCircuitBreaker(),
      log: () => {},
    });
    await conn.connect();
    // The pre-value: AbapConnection's constructor sets this to stateless
    // (connection.ts:351) and connect() does not change it.
    expect(conn.adt.stateful).toBe(session_types.stateless);

    const safety = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const transport = new DebugTransport(conn, { safety });
    const r = await transport.request({
      method: "POST",
      path: "/sap/bc/adt/debugger",
      qs: { method: "attach" },
    });
    expect(r.status).toBe(200);

    // The whole point: NOT left latched stateful for the next, ordinary caller.
    expect(conn.adt.stateful).toBe(session_types.stateless);
  });

  it("restores connection.adt.stateful even when request() THROWS — the finally's whole job", async () => {
    // A structured, NON-breaker-tripping throw on purpose: a 401 (as used
    // elsewhere in this file to exercise the breaker) trips AuthCircuitBreaker,
    // and AbapConnection's own `adt` getter calls `assertUsable()`, which
    // refuses to hand back the client at all once tripped — so a post-call
    // read of `conn.adt.stateful` would be testing the wrong thing entirely
    // (or just throwing itself). A 404-shaped ADT exception, exactly like
    // "translates a 404-shaped ADT exception via translateDebugError" above,
    // throws NOT_FOUND without touching the breaker, so `conn.adt` stays
    // readable afterwards and this test actually proves the `finally` ran.
    const inner = new CountingClient((_o, n) =>
      n === 1
        ? httpResp(200, "ok", { "content-type": "text/plain" }) // fake login
        : httpResp(404, `<exc:exception><type id="ExceptionResourceNotFound"/></exc:exception>`, {
            "content-type": "application/xml",
          }),
    );
    const conn = new AbapConnection(cfg(), {
      httpClient: inner,
      breaker: new AuthCircuitBreaker(),
      log: () => {},
    });
    await conn.connect();
    expect(conn.adt.stateful).toBe(session_types.stateless);

    // `safety` is REQUIRED even though this
    // test is GET-only and never reaches `authorizeMutation` — same permissive
    // gate the mutation-path tests in this file already construct.
    const transport = new DebugTransport(conn, { safety: new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] }) });
    await expect(
      transport.request({ method: "GET", path: "/sap/bc/adt/debugger/breakpoints/does-not-exist" }),
    ).rejects.toSatisfy((e: unknown) => isAbapError(e) && e.code === "NOT_FOUND");
    expect(conn.breaker.isTripped).toBe(false); // sanity: this throw did NOT trip the breaker

    // Restored on the throw path too — not just on success.
    expect(conn.adt.stateful).toBe(session_types.stateless);
  });

  it("the flag IS session_types.stateful DURING the request, and the wire header matches (:1016)", async () => {
    let statefulDuringCall: session_types | undefined;
    let headerDuringCall: unknown;
    const inner = new CountingClient((o, n) => {
      if (n === 1) return httpResp(200, "ok", { "content-type": "text/plain" }); // fake login
      // Captured from INSIDE the fake transport, at the moment the debugger
      // request is actually dispatched — proves the flag (and header) are set
      // on the real wire path, not merely unchanged before/after the call.
      statefulDuringCall = conn.adt.stateful;
      headerDuringCall = o.headers?.["X-sap-adt-sessiontype"];
      return httpResp(200, "<dbg:stack/>", { "content-type": "application/xml" });
    });
    const conn = new AbapConnection(cfg(), {
      httpClient: inner,
      breaker: new AuthCircuitBreaker(),
      log: () => {},
    });
    await conn.connect();
    // `safety` is REQUIRED even though this
    // test is GET-only and never reaches `authorizeMutation` — same permissive
    // gate the mutation-path tests in this file already construct.
    const transport = new DebugTransport(conn, { safety: new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] }) });
    await transport.request({ method: "GET", path: "/sap/bc/adt/debugger/stack" });

    expect(statefulDuringCall).toBe(session_types.stateful);
    expect(headerDuringCall).toBe("stateful");
    // ...and restored again afterwards, same as the tests above.
    expect(conn.adt.stateful).toBe(session_types.stateless);
  });
});

// ---------------------------------------------------------------------------
// `DebugLongPollAuth.acquireSession` is a REQUIRED hook (transport.ts)
// so a caller can hand `DebugLongPollClient.run()` a session lease for the
// lifetime of one long poll, protecting it from a second request landing on
// the same stateful session and silently cancelling the poll
// (transport.ts:1143-1151). Required, not optional-with-a-permissive-default:
// a caller who forgot the field and a caller who deliberately opted out of
// the protection must not be indistinguishable — see `ACQUIRE_NO_SESSION_LEASE`.
// Acquired AFTER the circuit-breaker gate and BEFORE the CSRF fetch
// (transport.ts:1359-1381), released in `run()`'s `finally` on every exit
// path (transport.ts:1543-1553), defensively wrapped so a throwing `release`
// cannot replace the real outcome.
// ---------------------------------------------------------------------------
describe("injected session-lease provider (DebugLongPollAuth.acquireSession)", () => {
  it("with the explicit ACQUIRE_NO_SESSION_LEASE opt-out, run() behaves exactly as it did when the field was omissible — no crash, normal result", async () => {
    const breaker = new AuthCircuitBreaker();
    let calls = 0;
    const requestFn: RawHttpRequestFn = async () => {
      calls++;
      return { status: 200, headers: {}, body: "<dbg:debuggee/>" };
    };
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: {
        cookieHeader: () => "SAP_SESSIONID=x",
        csrfToken: () => "TOKEN",
        acquireSession: ACQUIRE_NO_SESSION_LEASE,
      },
      requestFn,
    });
    const r = await client.listen("/sap/bc/adt/debugger/listeners").result;
    expect(r.status).toBe(200);
    expect(r.body).toBe("<dbg:debuggee/>");
    expect(calls).toBe(1);
  });

  it("an injected acquireSession is called exactly once, and release exactly once, on a normal successful return", async () => {
    const breaker = new AuthCircuitBreaker();
    let acquireCalls = 0;
    let releaseCalls = 0;
    const acquireSession = async (op: string): Promise<DebugSessionLease> => {
      acquireCalls++;
      expect(op).toBe("debug-long-poll"); // LONGPOLL_LEASE_OP, transport.ts:1125
      return {
        release: () => {
          releaseCalls++;
        },
      };
    };
    const requestFn: RawHttpRequestFn = async () => ({
      status: 200,
      headers: {},
      body: "<dbg:debuggee/>",
    });
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "SAP_SESSIONID=x", csrfToken: () => "TOKEN", acquireSession },
      requestFn,
    });
    const r = await client.listen("/sap/bc/adt/debugger/listeners").result;
    expect(r.status).toBe(200);
    expect(acquireCalls).toBe(1);
    expect(releaseCalls).toBe(1);
  });

  it("release is called even when run() throws", async () => {
    const breaker = new AuthCircuitBreaker();
    let releaseCalls = 0;
    const acquireSession = async (): Promise<DebugSessionLease> => ({
      release: () => {
        releaseCalls++;
      },
    });
    const requestFn: RawHttpRequestFn = async () => ({
      status: 404,
      headers: {},
      body: `<exc:exception><type id="ExceptionResourceNotFound"/></exc:exception>`,
    });
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "", csrfToken: () => "TOKEN", acquireSession },
      requestFn,
    });
    await expect(client.listen("/sap/bc/adt/debugger/listeners").result).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "NOT_FOUND",
    );
    expect(releaseCalls).toBe(1);
  });

  it("acquireSession is never called when the breaker refuses the request — nothing to release", async () => {
    // Transiently open, not auth-latched — mirrors transientlyOpen() above.
    const breaker = new AuthCircuitBreaker({ cooldownMs: 60_000, failureThreshold: 1 });
    breaker.recordTransientFailure({ status: 503, url: "http://sap.invalid/other" });
    expect(breaker.state).toBe("open");
    expect(breaker.isTripped).toBe(false);

    let acquireCalls = 0;
    const acquireSession = async (): Promise<DebugSessionLease> => {
      acquireCalls++;
      return { release: () => {} };
    };
    let requestCalls = 0;
    const requestFn: RawHttpRequestFn = async () => {
      requestCalls++;
      return { status: 200, headers: {}, body: "<dbg:debuggee/>" };
    };
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "", csrfToken: () => "TOKEN", acquireSession },
      requestFn,
    });
    await expect(client.listen("/sap/bc/adt/debugger/listeners").result).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "CIRCUIT_OPEN_TRANSIENT",
    );
    expect(acquireCalls).toBe(0);
    expect(requestCalls).toBe(0);
  });

  it("acquireSession is called AFTER the breaker gate and BEFORE the CSRF token getter, when the breaker allows the call", async () => {
    const breaker = new AuthCircuitBreaker();
    const order: string[] = [];
    const acquireSession = async (): Promise<DebugSessionLease> => {
      order.push("acquireSession");
      return { release: () => {} };
    };
    const requestFn: RawHttpRequestFn = async () => ({
      status: 200,
      headers: {},
      body: "<dbg:debuggee/>",
    });
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: {
        cookieHeader: () => "",
        csrfToken: () => {
          order.push("csrfToken");
          return "TOKEN";
        },
        acquireSession,
      },
      requestFn,
    });
    const r = await client.listen("/sap/bc/adt/debugger/listeners").result;
    expect(r.status).toBe(200);
    expect(order).toEqual(["acquireSession", "csrfToken"]);
  });

  it("a release() that THROWS does not mask a successful result", async () => {
    const breaker = new AuthCircuitBreaker();
    const acquireSession = async (): Promise<DebugSessionLease> => ({
      release: () => {
        throw new Error("boom-release");
      },
    });
    const requestFn: RawHttpRequestFn = async () => ({
      status: 200,
      headers: {},
      body: "<dbg:debuggee/>",
    });
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "", csrfToken: () => "TOKEN", acquireSession },
      requestFn,
    });
    const r = await client.listen("/sap/bc/adt/debugger/listeners").result;
    expect(r.status).toBe(200);
    expect(r.body).toBe("<dbg:debuggee/>");
  });

  it("a release() that THROWS does not mask the real thrown error", async () => {
    const breaker = new AuthCircuitBreaker();
    const acquireSession = async (): Promise<DebugSessionLease> => ({
      release: () => {
        throw new Error("boom-release");
      },
    });
    const requestFn: RawHttpRequestFn = async () => ({
      status: 404,
      headers: {},
      body: `<exc:exception><type id="ExceptionResourceNotFound"/></exc:exception>`,
    });
    const client = new DebugLongPollClient({
      baseUrl: "http://sap.invalid",
      breaker,
      auth: { cookieHeader: () => "", csrfToken: () => "TOKEN", acquireSession },
      requestFn,
    });
    await expect(client.listen("/sap/bc/adt/debugger/listeners").result).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "NOT_FOUND",
    );
  });
});

/**
 * Guard — the debugger must not import `src/adt/session-lock.ts`.
 *
 * `session-lock.ts` has a re-entrancy defect: its header describes invariant
 * I3 as membership in a SET of AsyncLocalStorage-carried tokens, but the
 * implementation still stores a single `{ token }` via `als.run({ token },
 * fn)` and tests identity against it in `isReentrant()`, so a context holding
 * two locks keeps only the innermost token — an ALS store replacement that
 * self-deadlocks and surfaces as `SESSION_BUSY`. Until that divergence is
 * settled by session-lock's own owner, the coordinator ruling is that the
 * debugger — whose whole job is to hold a session for minutes — must NOT
 * become its first caller. That is why `DebugSessionLease` / `NO_SESSION_LEASE`
 * / `DebugLongPollAuth.acquireSession` in `src/debug/transport.ts` (see the
 * comments around :1107 and :1162) name their own two-line interface instead
 * of importing session-lock's `SessionLease` — a type import would already be
 * the compile-time coupling this ruling forbids.
 *
 * This is a durable negative control: nothing else in the suite would catch a
 * future change that quietly wires `session-lock.ts` into the debugger, so if
 * this test goes red, that is what happened — restore the injected-lease seam
 * instead of deleting this test.
 */
describe("guard: src/debug/ must never import src/adt/session-lock.ts", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..");
  const debugDir = join(repoRoot, "src", "debug");
  const toolsDebugFile = join(repoRoot, "src", "tools", "debug.ts");

  /** All `.ts` files directly under src/debug/, plus the single file src/tools/debug.ts. */
  function guardedFiles(): string[] {
    const debugFiles = readdirSync(debugDir)
      .filter((entry) => entry.endsWith(".ts"))
      .map((entry) => join(debugDir, entry));
    return [...debugFiles, toolsDebugFile];
  }

  // Matches `from "...session-lock.js"`, `from "...session-lock"`, and a
  // dynamic `import("...session-lock.js")` — static, `import type`, and
  // dynamic import all go through a `from "..."` or `import("...")` literal
  // containing the module name, so one regex on the raw source covers all
  // three forms without needing a real parser.
  const SESSION_LOCK_IMPORT = /\b(?:from\s+["'][^"']*session-lock(?:\.js)?["']|import\(\s*["'][^"']*session-lock(?:\.js)?["']\s*\))/;

  const REASON =
    "src/adt/session-lock.ts has an unresolved re-entrancy defect (AsyncLocalStorage store " +
    "replacement self-deadlocks, surfacing as SESSION_BUSY) and the coordinator ruling is that " +
    "the debugger must not become its first caller (see src/debug/transport.ts:~1107-1116, ~1162). " +
    "If you meant to wire in the real lock, inject an adapter satisfying DebugSessionLease instead " +
    "of importing session-lock.ts directly.";

  it("covers at least src/debug/transport.ts and src/tools/debug.ts (sweep is not blind)", () => {
    const files = guardedFiles().map((f) => relative(repoRoot, f).split("\\").join("/"));
    expect(files).toContain("src/debug/transport.ts");
    expect(files).toContain("src/tools/debug.ts");
    expect(files.length).toBeGreaterThan(2);
  });

  it("no file under src/debug/ or src/tools/debug.ts imports src/adt/session-lock.ts", () => {
    const offenders: string[] = [];
    for (const file of guardedFiles()) {
      const source = readFileSync(file, "utf8");
      if (SESSION_LOCK_IMPORT.test(source)) {
        offenders.push(relative(repoRoot, file).split("\\").join("/"));
      }
    }
    expect(
      offenders,
      offenders.length > 0
        ? `Forbidden import of src/adt/session-lock.ts found in: ${offenders.join(", ")}. ${REASON}`
        : undefined,
    ).toEqual([]);
  });
});
