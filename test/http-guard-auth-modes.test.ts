/**
 * `GuardedHttpClient` dispatch-level behaviour for the three auth modes added
 * alongside password/cookie: `buildHttpsAgent` (the TLS-credential builder
 * shared with `src/debug/transport.ts` — see test/tls-policy-agreement.test.ts
 * for the real-socket side of that sharing), bearer-token injection (step 2d),
 * `suppressBasicAuth` (step 2e, certificate mode), and the OAuth-only 401
 * refresh-and-retry (step 2f).
 *
 * Everything here is offline: a fake `inner: HttpClient` (`ScriptedClient`,
 * copied from test/http-guard.test.ts's pattern) and an
 * `AuthCircuitBreaker` with an injected clock. No test in this file can emit a
 * packet.
 *
 * THE OVERRIDING RULE: the bearer token is exactly as sensitive as a password.
 * "bearer token never appears in error messages" asserts a sentinel is absent
 * from every observable surface of a thrown error, not just that the request
 * rejects.
 */
import { describe, expect, it } from "vitest";
import https from "node:https";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { buildHttpsAgent, GuardedHttpClient } from "../src/adt/http-guard.js";
import type { AbapError } from "../src/adt/errors.js";

// ---------------------------------------------------------------- fixtures ---

let fakeNow = 1_700_000_000_000;

/** Records every dispatched request, copied from test/http-guard.test.ts's pattern. */
class ScriptedClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(
    private readonly respond: (
      o: HttpClientOptions,
      n: number,
    ) => Promise<HttpClientResponse> | HttpClientResponse,
  ) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return await this.respond(o, this.calls.length);
  }
}

const resp = (status: number, body = "ok", ctype = "text/plain"): HttpClientResponse =>
  ({
    status,
    statusText: String(status),
    body,
    headers: { "content-type": ctype },
  }) as unknown as HttpClientResponse;

/** Axios shape: throws on >= 400 and carries the response on the exception. */
const httpError = (status: number, body = "err", ctype = "text/plain"): Error =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: resp(status, body, ctype),
  });

const REQ = { url: "/sap/bc/adt/discovery", method: "GET" } as unknown as HttpClientOptions;

const makeBreaker = (): AuthCircuitBreaker =>
  new AuthCircuitBreaker({ cooldownMs: 30_000, failureThreshold: 3, now: () => fakeNow });

const TOKEN_SENTINEL = "t0ken-do-not-log";

// -------------------------------------------------------------- buildHttpsAgent ---

describe("buildHttpsAgent", () => {
  it("returns undefined when nothing is configured — 'no agent', not 'insecure'", () => {
    expect(buildHttpsAgent(undefined)).toBeUndefined();
    expect(buildHttpsAgent({})).toBeUndefined();
  });

  it("insecure: true sets rejectUnauthorized: false and nothing else", () => {
    const agent = buildHttpsAgent({ insecure: true });
    expect(agent).toBeInstanceOf(https.Agent);
    expect(agent?.options.rejectUnauthorized).toBe(false);
    expect(agent?.options.cert).toBeUndefined();
  });

  it("a client certificate (cert + key) is carried into the agent's options", () => {
    const cert = Buffer.from("cert-bytes");
    const key = Buffer.from("key-bytes");
    const agent = buildHttpsAgent({ cert, key });
    expect(agent?.options.cert).toBe(cert);
    expect(agent?.options.key).toBe(key);
    expect(agent?.options.rejectUnauthorized).toBeUndefined();
  });

  it("a PFX blob with a passphrase is carried into the agent's options", () => {
    const pfx = Buffer.from("pfx-bytes");
    const agent = buildHttpsAgent({ pfx, passphrase: "hunter2" });
    expect(agent?.options.pfx).toBe(pfx);
    expect(agent?.options.passphrase).toBe("hunter2");
  });

  it("a CA bundle is independent of `insecure` — both can be set at once", () => {
    const ca = Buffer.from("ca-bytes");
    const agent = buildHttpsAgent({ ca, insecure: true });
    expect(agent?.options.ca).toBe(ca);
    expect(agent?.options.rejectUnauthorized).toBe(false);
  });

  it("a CA bundle alone (no insecure) leaves rejectUnauthorized untouched (real verification)", () => {
    const ca = Buffer.from("ca-bytes");
    const agent = buildHttpsAgent({ ca });
    expect(agent?.options.ca).toBe(ca);
    expect(agent?.options.rejectUnauthorized).toBeUndefined();
  });
});

// -------------------------------------------------------- bearer injection (2d) ---

describe("GuardedHttpClient: bearer-token injection (step 2d)", () => {
  it("a defined bearer token sets Authorization: Bearer <token> and drops any `auth`", async () => {
    const inner = new ScriptedClient(() => resp(200));
    const client = new GuardedHttpClient(
      { baseURL: "http://x", inner, bearerToken: () => TOKEN_SENTINEL },
      makeBreaker(),
    );
    await client.request({ ...REQ, auth: { username: "u", password: "p" } });
    expect(inner.calls[0]?.headers?.["Authorization"]).toBe(`Bearer ${TOKEN_SENTINEL}`);
    expect(inner.calls[0]?.auth).toBeUndefined();
  });

  it("an async bearerToken is awaited before the request goes out", async () => {
    const inner = new ScriptedClient(() => resp(200));
    let resolveToken!: (v: string) => void;
    const tokenPromise = new Promise<string>((r) => (resolveToken = r));
    const client = new GuardedHttpClient(
      { baseURL: "http://x", inner, bearerToken: () => tokenPromise },
      makeBreaker(),
    );
    const pending = client.request(REQ);
    // Give any stray microtask a chance to run; the request must NOT have
    // reached `inner` yet because `bearerToken()` has not resolved.
    await Promise.resolve();
    await Promise.resolve();
    expect(inner.calls.length).toBe(0);
    resolveToken(TOKEN_SENTINEL);
    await pending;
    expect(inner.calls.length).toBe(1);
    expect(inner.calls[0]?.headers?.["Authorization"]).toBe(`Bearer ${TOKEN_SENTINEL}`);
  });

  it("bearerToken resolving to undefined sends no Authorization header at all", async () => {
    const inner = new ScriptedClient(() => resp(200));
    const client = new GuardedHttpClient(
      { baseURL: "http://x", inner, bearerToken: () => undefined },
      makeBreaker(),
    );
    await client.request(REQ);
    expect(inner.calls[0]?.headers?.["Authorization"]).toBeUndefined();
  });

  it("no bearerToken configured at all leaves headers/auth completely untouched (password/cookie modes unaffected)", async () => {
    const inner = new ScriptedClient(() => resp(200));
    const client = new GuardedHttpClient({ baseURL: "http://x", inner }, makeBreaker());
    await client.request({ ...REQ, auth: { username: "u", password: "p" } });
    expect(inner.calls[0]?.auth).toEqual({ username: "u", password: "p" });
    expect(inner.calls[0]?.headers?.["Authorization"]).toBeUndefined();
  });
});

// ------------------------------------------------ suppressBasicAuth (2e) ---

describe("GuardedHttpClient: suppressBasicAuth (step 2e, certificate mode)", () => {
  it("suppressBasicAuth() true strips a stray Authorization header and drops `auth`", async () => {
    const inner = new ScriptedClient(() => resp(200));
    const client = new GuardedHttpClient(
      { baseURL: "http://x", inner, suppressBasicAuth: () => true },
      makeBreaker(),
    );
    await client.request({
      ...REQ,
      headers: { Authorization: "Basic dXNlcjpwYXNz", "X-Other": "keep" },
      auth: { username: "u", password: "p" },
    });
    expect(inner.calls[0]?.headers?.["Authorization"]).toBeUndefined();
    expect(inner.calls[0]?.headers?.["X-Other"]).toBe("keep");
    expect(inner.calls[0]?.auth).toBeUndefined();
  });

  it("suppressBasicAuth() false leaves Authorization/auth exactly as the caller built them", async () => {
    const inner = new ScriptedClient(() => resp(200));
    const client = new GuardedHttpClient(
      { baseURL: "http://x", inner, suppressBasicAuth: () => false },
      makeBreaker(),
    );
    await client.request({
      ...REQ,
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
      auth: { username: "u", password: "p" },
    });
    expect(inner.calls[0]?.headers?.["Authorization"]).toBe("Basic dXNlcjpwYXNz");
    expect(inner.calls[0]?.auth).toEqual({ username: "u", password: "p" });
  });

  it("a configured bearer token takes precedence over suppressBasicAuth — bearer wins, nothing is stripped-then-reapplied incorrectly", async () => {
    const inner = new ScriptedClient(() => resp(200));
    const client = new GuardedHttpClient(
      {
        baseURL: "http://x",
        inner,
        bearerToken: () => TOKEN_SENTINEL,
        suppressBasicAuth: () => true,
      },
      makeBreaker(),
    );
    await client.request({ ...REQ, headers: { Authorization: "Basic dXNlcjpwYXNz" } });
    expect(inner.calls[0]?.headers?.["Authorization"]).toBe(`Bearer ${TOKEN_SENTINEL}`);
  });
});

// -------------------------------------------- OAuth 401 refresh-and-retry (2f) ---

describe("GuardedHttpClient: OAuth 401 refresh-and-retry (step 2f)", () => {
  it("a 401 triggers exactly one refresh and one retry, which succeeds and is what settle() sees", async () => {
    let call = 0;
    const inner = new ScriptedClient(() => {
      call++;
      return call === 1 ? Promise.reject(httpError(401)) : resp(200, "ok");
    });
    const breaker = makeBreaker();
    let refreshCalls = 0;
    const client = new GuardedHttpClient(
      {
        baseURL: "http://x",
        inner,
        bearerToken: () => "stale-token",
        refreshBearerToken: async () => {
          refreshCalls++;
          return "fresh-token";
        },
      },
      breaker,
    );
    const response = await client.request(REQ);
    expect(response.status).toBe(200);
    expect(refreshCalls).toBe(1);
    expect(client.refreshRetryCount).toBe(1);
    expect(inner.calls.length).toBe(2);
    expect(inner.calls[1]?.headers?.["Authorization"]).toBe("Bearer fresh-token");
    // The retry succeeded, so the ORIGINAL 401 must never have reached
    // breaker.inspect() — the auth latch must still be closed.
    expect(breaker.isTripped).toBe(false);
  });

  it("refreshBearerToken() resolving undefined falls through to settle() on the ORIGINAL 401, which trips the latch", async () => {
    const inner = new ScriptedClient(() => Promise.reject(httpError(401)));
    const breaker = makeBreaker();
    const client = new GuardedHttpClient(
      {
        baseURL: "http://x",
        inner,
        bearerToken: () => "stale-token",
        refreshBearerToken: async () => undefined,
      },
      breaker,
    );
    await expect(client.request(REQ)).rejects.toBeTruthy();
    // Only the original attempt was made — no retry without a fresh token.
    expect(inner.calls.length).toBe(1);
    expect(client.refreshRetryCount).toBe(0);
    // A bare 401 always trips the one-way auth latch, with no threshold.
    expect(breaker.isTripped).toBe(true);
  });

  it("a second 401 on the RETRY is settled as-is — no second retry is attempted", async () => {
    const inner = new ScriptedClient(() => Promise.reject(httpError(401)));
    const breaker = makeBreaker();
    let refreshCalls = 0;
    const client = new GuardedHttpClient(
      {
        baseURL: "http://x",
        inner,
        bearerToken: () => "stale-token",
        refreshBearerToken: async () => {
          refreshCalls++;
          return "still-bad-token";
        },
      },
      breaker,
    );
    await expect(client.request(REQ)).rejects.toBeTruthy();
    expect(refreshCalls).toBe(1);
    expect(client.refreshRetryCount).toBe(1);
    // Exactly two network attempts: the original and the one retry.
    expect(inner.calls.length).toBe(2);
    expect(breaker.isTripped).toBe(true);
  });

  it("a non-401 failure (e.g. 500) never calls refreshBearerToken at all", async () => {
    const inner = new ScriptedClient(() => Promise.reject(httpError(500)));
    let refreshCalls = 0;
    const client = new GuardedHttpClient(
      {
        baseURL: "http://x",
        inner,
        bearerToken: () => "token",
        refreshBearerToken: async () => {
          refreshCalls++;
          return "fresh";
        },
      },
      makeBreaker(),
    );
    await expect(client.request(REQ)).rejects.toBeTruthy();
    expect(refreshCalls).toBe(0);
    expect(inner.calls.length).toBe(1);
  });

  it("a successful first response (200) never calls refreshBearerToken", async () => {
    const inner = new ScriptedClient(() => resp(200));
    let refreshCalls = 0;
    const client = new GuardedHttpClient(
      {
        baseURL: "http://x",
        inner,
        bearerToken: () => "token",
        refreshBearerToken: async () => {
          refreshCalls++;
          return "fresh";
        },
      },
      makeBreaker(),
    );
    await client.request(REQ);
    expect(refreshCalls).toBe(0);
  });

  it("if refreshBearerToken() itself throws, request() rejects with that error and no retry is sent", async () => {
    const inner = new ScriptedClient(() => Promise.reject(httpError(401)));
    const refreshError = new Error("refresh network failure");
    const client = new GuardedHttpClient(
      {
        baseURL: "http://x",
        inner,
        bearerToken: () => "token",
        refreshBearerToken: async () => {
          throw refreshError;
        },
      },
      makeBreaker(),
    );
    await expect(client.request(REQ)).rejects.toBe(refreshError);
    expect(inner.calls.length).toBe(1);
  });

  it("the retry is reported to onRequest too — an observer never sees fewer requests than were sent", async () => {
    let call = 0;
    const inner = new ScriptedClient(() => {
      call++;
      return call === 1 ? Promise.reject(httpError(401)) : resp(200, "ok");
    });
    const observed: HttpClientOptions[] = [];
    const client = new GuardedHttpClient(
      {
        baseURL: "http://x",
        inner,
        bearerToken: () => "stale-token",
        refreshBearerToken: async () => "fresh-token",
        onRequest: (o) => observed.push(o),
      },
      makeBreaker(),
    );
    await client.request(REQ);
    // Two requests reached the wire (the original 401 and the retry), so the
    // observer must have been called twice — not once for the pair.
    expect(observed.length).toBe(2);
    expect(observed[0]?.headers?.["Authorization"]).toBe("Bearer stale-token");
    expect(observed[1]?.headers?.["Authorization"]).toBe("Bearer fresh-token");
    // Observations and wire sends must agree.
    expect(client.requestCount).toBe(2);
  });
});

// ------------------------------------------------------------------ redaction ---

describe("THE OVERRIDING RULE: bearer token never appears in error messages", () => {
  it("a tripped-latch error (circuitOpenError) from a bare 401 never contains the bearer token", async () => {
    const inner = new ScriptedClient(() => Promise.reject(httpError(401)));
    const breaker = makeBreaker();
    const client = new GuardedHttpClient(
      {
        baseURL: "http://x",
        inner,
        bearerToken: () => TOKEN_SENTINEL,
        refreshBearerToken: async () => undefined,
      },
      breaker,
    );
    let caught: AbapError | undefined;
    try {
      await client.request(REQ);
      expect.unreachable("request should have rejected");
    } catch (e) {
      caught = e as AbapError;
    }
    expect(caught).toBeDefined();
    const serialised = JSON.stringify({
      message: caught?.message,
      details: caught?.details,
      hint: caught?.hint,
    });
    expect(serialised).not.toContain(TOKEN_SENTINEL);
    expect(serialised).not.toContain(TOKEN_SENTINEL.slice(0, 6));
  });

  it("the request that carried the token in its own headers is unaffected — only ERROR TEXT is asserted secret-free", async () => {
    // Sanity check for the assertion above: the token DOES go out on the
    // wire (that's the point of bearer auth) — this test pins that fact down
    // so the redaction test can't be vacuously true because no token was
    // ever sent in the first place.
    const inner = new ScriptedClient(() => resp(200));
    const client = new GuardedHttpClient(
      { baseURL: "http://x", inner, bearerToken: () => TOKEN_SENTINEL },
      makeBreaker(),
    );
    await client.request(REQ);
    expect(inner.calls[0]?.headers?.["Authorization"]).toContain(TOKEN_SENTINEL);
  });

  it("a transient-circuit error (5xx) never contains the bearer token either", async () => {
    const inner = new ScriptedClient(() => Promise.reject(httpError(503)));
    const breaker = new AuthCircuitBreaker({ cooldownMs: 30_000, failureThreshold: 1, now: () => fakeNow });
    const client = new GuardedHttpClient(
      { baseURL: "http://x", inner, bearerToken: () => TOKEN_SENTINEL },
      breaker,
    );
    // Drive past the failure threshold so the transient circuit opens.
    await expect(client.request(REQ)).rejects.toBeTruthy();
    let caught: AbapError | undefined;
    try {
      await client.request(REQ);
    } catch (e) {
      caught = e as AbapError;
    }
    expect(caught).toBeDefined();
    const serialised = JSON.stringify({
      message: caught?.message,
      details: caught?.details,
      hint: caught?.hint,
    });
    expect(serialised).not.toContain(TOKEN_SENTINEL);
    expect(serialised).not.toContain(TOKEN_SENTINEL.slice(0, 6));
  });
});
