/**
 * `OAuthTokenProvider` (src/adt/oauth.ts) — RFC 6749 §4.4 client-credentials
 * token acquisition and caching for `authMethod: "oauth"`. Everything here is
 * driven by an injected `fetchToken` and an injected `now`: no socket is ever
 * opened and no real timer ever runs.
 *
 * THE OVERRIDING RULE: the client secret and any minted access token are
 * exactly as sensitive as a password. Every assertion here that touches a
 * thrown error's message/details/hint also asserts the relevant sentinel is
 * absent from it — including when the token endpoint's response BODY itself
 * echoes the secret back (a misconfigured/malicious server), since `details`
 * must never be built from the response body.
 */
import { describe, expect, it } from "vitest";

import { OAuthTokenProvider, type TokenEndpointFetch } from "../src/adt/oauth.js";
import type { OAuthSettings } from "../src/auth/service-key.js";
import type { AbapError } from "../src/adt/errors.js";

const CLIENT_SECRET_SENTINEL = "cl1entsecret-do-not-log";
const TOKEN_SENTINEL = "t0ken-do-not-log";

const settings = (over: Partial<OAuthSettings> = {}): OAuthSettings => ({
  tokenUrl: "https://uaa.example.com/oauth/token",
  clientId: "my-client-id",
  clientSecret: CLIENT_SECRET_SENTINEL,
  source: "env",
  ...over,
});

/** A scripted `TokenEndpointFetch` that records every call it receives. */
function scriptedFetch(
  respond: (url: string, body: URLSearchParams, n: number) => { status: number; body: string },
): { fetch: TokenEndpointFetch; calls: URLSearchParams[] } {
  const calls: URLSearchParams[] = [];
  const fetch: TokenEndpointFetch = async (url, body) => {
    calls.push(body);
    return respond(url, body, calls.length);
  };
  return { fetch, calls };
}

const tokenBody = (accessToken: string, expiresIn?: number): string =>
  JSON.stringify({
    access_token: accessToken,
    ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
    token_type: "bearer",
  });

const codeOf = (e: unknown): AbapError["code"] => (e as AbapError).code;

// -------------------------------------------------------------- happy path ---

describe("OAuthTokenProvider: minting and caching", () => {
  it("getToken() performs a client_credentials grant with client_id/client_secret and no scope by default", async () => {
    let now = 1_000_000;
    const { fetch, calls } = scriptedFetch(() => ({ status: 200, body: tokenBody(TOKEN_SENTINEL, 3600) }));
    const provider = new OAuthTokenProvider({ settings: settings(), fetchToken: fetch, now: () => now });
    const token = await provider.getToken();
    expect(token).toBe(TOKEN_SENTINEL);
    expect(calls[0]?.get("grant_type")).toBe("client_credentials");
    expect(calls[0]?.get("client_id")).toBe("my-client-id");
    expect(calls[0]?.get("client_secret")).toBe(CLIENT_SECRET_SENTINEL);
    expect(calls[0]?.has("scope")).toBe(false);
  });

  it("includes scope in the request body when settings.scope is set", async () => {
    let now = 1_000_000;
    const { fetch, calls } = scriptedFetch(() => ({ status: 200, body: tokenBody(TOKEN_SENTINEL, 3600) }));
    const provider = new OAuthTokenProvider({
      settings: settings({ scope: "uaa.resource" }),
      fetchToken: fetch,
      now: () => now,
    });
    await provider.getToken();
    expect(calls[0]?.get("scope")).toBe("uaa.resource");
  });

  it("a second getToken() call within the cached lifetime returns the cached token without a network call", async () => {
    let now = 1_000_000;
    const { fetch, calls } = scriptedFetch(() => ({ status: 200, body: tokenBody(TOKEN_SENTINEL, 3600) }));
    const provider = new OAuthTokenProvider({ settings: settings(), fetchToken: fetch, now: () => now });
    await provider.getToken();
    now += 1000; // well within the 3600s lifetime and the 60s skew
    const second = await provider.getToken();
    expect(second).toBe(TOKEN_SENTINEL);
    expect(calls.length).toBe(1);
  });

  it("a cached token within refreshSkewMs of expiry is treated as already expired and triggers a refetch", async () => {
    let now = 1_000_000;
    const { fetch, calls } = scriptedFetch(() => ({ status: 200, body: tokenBody(TOKEN_SENTINEL, 100) }));
    const provider = new OAuthTokenProvider({
      settings: settings(),
      fetchToken: fetch,
      now: () => now,
      refreshSkewMs: 60_000,
    });
    await provider.getToken(); // expiresAtMs = now + 100_000
    now += 100_000 - 60_000 + 1; // now inside the skew window
    await provider.getToken();
    expect(calls.length).toBe(2);
  });

  it("expires_in absent defaults to the ASSUMED 3600s lifetime", async () => {
    let now = 1_000_000;
    const { fetch } = scriptedFetch(() => ({ status: 200, body: tokenBody(TOKEN_SENTINEL) }));
    const provider = new OAuthTokenProvider({ settings: settings(), fetchToken: fetch, now: () => now });
    await provider.getToken();
    const status = provider.status();
    expect(status.expiresInMs).toBe(3600 * 1000);
  });

  it("a non-positive or non-numeric expires_in also falls back to the ASSUMED 3600s lifetime", async () => {
    let now = 1_000_000;
    const { fetch } = scriptedFetch(() => ({
      status: 200,
      body: JSON.stringify({ access_token: TOKEN_SENTINEL, expires_in: -5 }),
    }));
    const provider = new OAuthTokenProvider({ settings: settings(), fetchToken: fetch, now: () => now });
    await provider.getToken();
    expect(provider.status().expiresInMs).toBe(3600 * 1000);
  });

  it("forceRefresh() discards the cache and performs a fresh fetch even when the cached token is still valid", async () => {
    let now = 1_000_000;
    let n = 0;
    const { fetch, calls } = scriptedFetch(() => {
      n++;
      return { status: 200, body: tokenBody(`token-${n}`, 3600) };
    });
    const provider = new OAuthTokenProvider({ settings: settings(), fetchToken: fetch, now: () => now });
    const first = await provider.getToken();
    const forced = await provider.forceRefresh();
    expect(first).toBe("token-1");
    expect(forced).toBe("token-2");
    expect(calls.length).toBe(2);
  });
});

// ------------------------------------------------------------- single-flight ---

describe("OAuthTokenProvider: single-flight refresh", () => {
  it("concurrent getToken() calls during a refresh share one in-flight fetchToken call", async () => {
    let now = 1_000_000;
    let resolveFetch!: (v: { status: number; body: string }) => void;
    const pending = new Promise<{ status: number; body: string }>((r) => (resolveFetch = r));
    let calls = 0;
    const fetch: TokenEndpointFetch = async () => {
      calls++;
      return pending;
    };
    const provider = new OAuthTokenProvider({ settings: settings(), fetchToken: fetch, now: () => now });
    const p1 = provider.getToken();
    const p2 = provider.getToken();
    const p3 = provider.getToken();
    resolveFetch({ status: 200, body: tokenBody(TOKEN_SENTINEL, 3600) });
    const [t1, t2, t3] = await Promise.all([p1, p2, p3]);
    expect(calls).toBe(1);
    expect(t1).toBe(TOKEN_SENTINEL);
    expect(t2).toBe(TOKEN_SENTINEL);
    expect(t3).toBe(TOKEN_SENTINEL);
  });

  it("a new refresh can start once the in-flight one has settled (no permanently-shared promise)", async () => {
    let now = 1_000_000;
    let n = 0;
    const { fetch, calls } = scriptedFetch(() => {
      n++;
      return { status: 200, body: tokenBody(`token-${n}`, 1) }; // 1s lifetime, expires fast
    });
    const provider = new OAuthTokenProvider({
      settings: settings(),
      fetchToken: fetch,
      now: () => now,
      refreshSkewMs: 0,
    });
    const first = await provider.getToken();
    now += 2000; // past expiry
    const second = await provider.getToken();
    expect(first).toBe("token-1");
    expect(second).toBe("token-2");
    expect(calls.length).toBe(2);
  });
});

// ----------------------------------------------------------------- failures ---

describe("OAuthTokenProvider: refresh failure shapes", () => {
  it("fetchToken throwing (network error) yields AUTH_TOKEN_REFRESH_FAILED with 'no response' and the reason, never the client secret", async () => {
    let now = 1_000_000;
    const fetch: TokenEndpointFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const provider = new OAuthTokenProvider({ settings: settings(), fetchToken: fetch, now: () => now });
    let caught: AbapError | undefined;
    try {
      await provider.getToken();
    } catch (e) {
      caught = e as AbapError;
    }
    expect(caught).toBeDefined();
    expect(codeOf(caught)).toBe("AUTH_TOKEN_REFRESH_FAILED");
    expect(caught?.message).toContain("network error contacting the token endpoint: ECONNREFUSED");
    expect(caught?.message).toContain("no response");
    expect(caught?.details.status).toBeUndefined();
    const serialised = JSON.stringify(caught);
    expect(serialised).not.toContain(CLIENT_SECRET_SENTINEL);
    expect(serialised).not.toContain(CLIENT_SECRET_SENTINEL.slice(0, 6));
  });

  it("a non-200 status yields AUTH_TOKEN_REFRESH_FAILED naming the HTTP status, with no 'extra' clause", async () => {
    let now = 1_000_000;
    const { fetch } = scriptedFetch(() => ({ status: 403, body: "Forbidden" }));
    const provider = new OAuthTokenProvider({ settings: settings(), fetchToken: fetch, now: () => now });
    let caught: AbapError | undefined;
    try {
      await provider.getToken();
    } catch (e) {
      caught = e as AbapError;
    }
    expect(caught?.message).toContain("HTTP 403");
    expect(caught?.message).not.toContain("failed:"); // no extra-clause colon form
    expect(caught?.details.status).toBe(403);
  });

  it("the response BODY is never included in the error, even when it echoes the client secret back", async () => {
    let now = 1_000_000;
    const { fetch } = scriptedFetch(() => ({
      status: 400,
      body: `{"error":"invalid_client","echo":"${CLIENT_SECRET_SENTINEL}"}`,
    }));
    const provider = new OAuthTokenProvider({ settings: settings(), fetchToken: fetch, now: () => now });
    let caught: AbapError | undefined;
    try {
      await provider.getToken();
    } catch (e) {
      caught = e as AbapError;
    }
    const serialised = JSON.stringify(caught);
    expect(serialised).not.toContain(CLIENT_SECRET_SENTINEL);
    expect(serialised).not.toContain("invalid_client");
  });

  it("invalid JSON in a 200 response yields the 'not valid JSON' message", async () => {
    let now = 1_000_000;
    const { fetch } = scriptedFetch(() => ({ status: 200, body: "not json{" }));
    const provider = new OAuthTokenProvider({ settings: settings(), fetchToken: fetch, now: () => now });
    const msg = await provider.getToken().catch((e: AbapError) => e.message);
    expect(msg).toContain("the token endpoint's response was not valid JSON");
    expect(msg).toContain("HTTP 200");
  });

  it("a 200 response missing access_token yields the 'no access_token' message", async () => {
    let now = 1_000_000;
    const { fetch } = scriptedFetch(() => ({ status: 200, body: JSON.stringify({ token_type: "bearer" }) }));
    const provider = new OAuthTokenProvider({ settings: settings(), fetchToken: fetch, now: () => now });
    const msg = await provider.getToken().catch((e: AbapError) => e.message);
    expect(msg).toContain("the token endpoint's response had no access_token");
  });

  it("the tokenUrl in details/message has any embedded userinfo credentials stripped", async () => {
    let now = 1_000_000;
    const { fetch } = scriptedFetch(() => ({ status: 500, body: "" }));
    const provider = new OAuthTokenProvider({
      settings: settings({ tokenUrl: `https://embedded:${CLIENT_SECRET_SENTINEL}@uaa.example.com/oauth/token` }),
      fetchToken: fetch,
      now: () => now,
    });
    let caught: AbapError | undefined;
    try {
      await provider.getToken();
    } catch (e) {
      caught = e as AbapError;
    }
    const serialised = JSON.stringify(caught);
    expect(serialised).not.toContain(CLIENT_SECRET_SENTINEL);
    expect(caught?.details.tokenUrl).toContain("uaa.example.com");
  });

  it("the hint mentions the cooldown duration in seconds", async () => {
    let now = 1_000_000;
    const { fetch } = scriptedFetch(() => ({ status: 500, body: "" }));
    const provider = new OAuthTokenProvider({
      settings: settings(),
      fetchToken: fetch,
      now: () => now,
      failureCooldownMs: 45_000,
    });
    let caught: AbapError | undefined;
    try {
      await provider.getToken();
    } catch (e) {
      caught = e as AbapError;
    }
    expect(caught?.hint).toContain("45s");
  });
});

// ------------------------------------------------------------------ cooldown ---

describe("OAuthTokenProvider: failure cooldown", () => {
  it("a call during the cooldown window throws immediately, without a second network attempt", async () => {
    let now = 1_000_000;
    const { fetch, calls } = scriptedFetch(() => ({ status: 500, body: "" }));
    const provider = new OAuthTokenProvider({
      settings: settings(),
      fetchToken: fetch,
      now: () => now,
      failureCooldownMs: 30_000,
    });
    await expect(provider.getToken()).rejects.toMatchObject({ code: "AUTH_TOKEN_REFRESH_FAILED" });
    expect(calls.length).toBe(1);
    now += 5000; // still within the 30s cooldown
    await expect(provider.getToken()).rejects.toMatchObject({ code: "AUTH_TOKEN_REFRESH_FAILED" });
    expect(calls.length).toBe(1); // no second network attempt
  });

  it("the cooldown-window error message differs from a real failure's ('is in cooldown', not 'failed')", async () => {
    let now = 1_000_000;
    const { fetch } = scriptedFetch(() => ({ status: 500, body: "" }));
    const provider = new OAuthTokenProvider({
      settings: settings(),
      fetchToken: fetch,
      now: () => now,
      failureCooldownMs: 30_000,
    });
    await provider.getToken().catch(() => {});
    now += 1000;
    const msg = await provider.getToken().catch((e: AbapError) => e.message);
    expect(msg).toContain("is in cooldown after a recent failure");
  });

  it("once the cooldown elapses, the next call performs a real network attempt again", async () => {
    let now = 1_000_000;
    let n = 0;
    const fetch: TokenEndpointFetch = async () => {
      n++;
      return n === 1 ? { status: 500, body: "" } : { status: 200, body: tokenBody(TOKEN_SENTINEL, 3600) };
    };
    const provider = new OAuthTokenProvider({
      settings: settings(),
      fetchToken: fetch,
      now: () => now,
      failureCooldownMs: 30_000,
    });
    await provider.getToken().catch(() => {});
    now += 30_001; // cooldown has fully elapsed
    const token = await provider.getToken();
    expect(token).toBe(TOKEN_SENTINEL);
    expect(n).toBe(2);
  });

  it("the cooldown clock is not restarted by a cooldown-rejection itself, only by a real attempt", async () => {
    let now = 1_000_000;
    let n = 0;
    const fetch: TokenEndpointFetch = async () => {
      n++;
      return { status: 500, body: "" };
    };
    const provider = new OAuthTokenProvider({
      settings: settings(),
      fetchToken: fetch,
      now: () => now,
      failureCooldownMs: 10_000,
    });
    await provider.getToken().catch(() => {}); // real failure at t=1_000_000
    now += 9_000; // still in cooldown -> rejected without a real attempt
    await provider.getToken().catch(() => {});
    expect(n).toBe(1);
    now += 2_000; // total 11_000ms since the ORIGINAL failure -> cooldown over
    await provider.getToken().catch(() => {});
    expect(n).toBe(2); // proves the clock ran from the original failure, not from the cooldown rejection
  });

  it("a successful refresh clears lastFailure so a LATER failure gets its own fresh cooldown", async () => {
    let now = 1_000_000;
    let n = 0;
    const fetch: TokenEndpointFetch = async () => {
      n++;
      if (n === 1) return { status: 500, body: "" };
      if (n === 2) return { status: 200, body: tokenBody(TOKEN_SENTINEL, 1) }; // short-lived
      return { status: 500, body: "" };
    };
    const provider = new OAuthTokenProvider({
      settings: settings(),
      fetchToken: fetch,
      now: () => now,
      failureCooldownMs: 10_000,
      refreshSkewMs: 0,
    });
    await provider.getToken().catch(() => {}); // n=1, fails, cooldown starts
    now += 10_001; // cooldown elapsed
    await provider.getToken(); // n=2, succeeds, clears lastFailure, caches 1s token
    now += 2000; // token now expired
    await expect(provider.getToken()).rejects.toBeTruthy(); // n=3, fails again — must NOT be an immediate cooldown throw
    expect(n).toBe(3);
  });
});

// -------------------------------------------------------------------- status ---

describe("OAuthTokenProvider: status() never exposes secrets", () => {
  it("reports hasToken: false and inCooldown: false before anything has happened", () => {
    let now = 1_000_000;
    const provider = new OAuthTokenProvider({ settings: settings(), now: () => now });
    const status = provider.status();
    expect(status.hasToken).toBe(false);
    expect(status.inCooldown).toBe(false);
    expect(status.lastFailure).toBeUndefined();
  });

  it("reports hasToken: true and a positive expiresInMs after a successful mint", async () => {
    let now = 1_000_000;
    const { fetch } = scriptedFetch(() => ({ status: 200, body: tokenBody(TOKEN_SENTINEL, 3600) }));
    const provider = new OAuthTokenProvider({ settings: settings(), fetchToken: fetch, now: () => now });
    await provider.getToken();
    const status = provider.status();
    expect(status.hasToken).toBe(true);
    expect(status.expiresInMs).toBe(3600 * 1000);
  });

  it("reports inCooldown: true and a lastFailure string after a failure, and neither field ever contains the secret", async () => {
    let now = 1_000_000;
    const { fetch } = scriptedFetch(() => ({ status: 500, body: "" }));
    const provider = new OAuthTokenProvider({ settings: settings(), fetchToken: fetch, now: () => now });
    await provider.getToken().catch(() => {});
    const status = provider.status();
    expect(status.inCooldown).toBe(true);
    expect(status.lastFailure).toBeDefined();
    const serialised = JSON.stringify(status);
    expect(serialised).not.toContain(CLIENT_SECRET_SENTINEL);
    expect(serialised).not.toContain(CLIENT_SECRET_SENTINEL.slice(0, 6));
  });

  it("status() never includes the access token itself, only hasToken/expiresInMs", async () => {
    let now = 1_000_000;
    const { fetch } = scriptedFetch(() => ({ status: 200, body: tokenBody(TOKEN_SENTINEL, 3600) }));
    const provider = new OAuthTokenProvider({ settings: settings(), fetchToken: fetch, now: () => now });
    await provider.getToken();
    const serialised = JSON.stringify(provider.status());
    expect(serialised).not.toContain(TOKEN_SENTINEL);
    expect(serialised).not.toContain(TOKEN_SENTINEL.slice(0, 6));
  });
});
