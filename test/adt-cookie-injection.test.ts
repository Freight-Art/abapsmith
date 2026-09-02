/**
 * Cookie-mode auth, injected at the `GuardedHttpClient` transport seam
 * (`GuardOptions.injectedCookies`, step 2c in `dispatch()`).
 *
 * WHY HERE, NOT IN `abap-adt-api`
 * --------------------------------
 * `AdtHTTP.login()` calls `this.cookie.clear()` unconditionally, on every
 * login AND every 401-retry re-login — pre-seeding the vendor jar cannot
 * survive that. The guard sits underneath `AdtHTTP` and sees every outbound
 * request after the jar has had its say, so it merges there instead.
 *
 * MERGE RULE PINNED BY THIS FILE
 * -------------------------------
 * The jar (server-issued, already present on `opts.headers.Cookie` when this
 * guard sees it) wins for any name it holds with a NON-EMPTY value. A jar
 * value of "" is a server deletion directive, not a win — the injected value
 * fills it. A name the jar lacks is filled from the injected map. Exactly one
 * pair per name in the result. The injected map itself is never written to.
 *
 * Offline throughout — a scripted `inner: HttpClient` and an injected clock,
 * same as `test/http-guard.test.ts`. No packet leaves this file.
 */
import { describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { GuardedHttpClient } from "../src/adt/http-guard.js";

// ---------------------------------------------------------------- fixtures ---

const SENTINEL = "s3cr3t-do-not-log";

let fakeNow = 1_700_000_000_000;

class ScriptedClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

const resp = (status: number, body = "ok"): HttpClientResponse =>
  ({
    status,
    statusText: String(status),
    body,
    headers: { "content-type": "text/plain" },
  }) as unknown as HttpClientResponse;

const REQ = { url: "/sap/bc/adt/discovery", method: "GET" } as unknown as HttpClientOptions;

const makeBreaker = (): AuthCircuitBreaker =>
  new AuthCircuitBreaker({ cooldownMs: 30_000, failureThreshold: 3, now: () => fakeNow });

const AUTH = { username: "u", password: "p" };

// -------------------------------------------------------------------- tests --

describe("GuardedHttpClient — cookie injection", () => {
  it("puts the injected cookie on the outgoing Cookie header", async () => {
    const inner = new ScriptedClient(() => resp(200));
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, injectedCookies: () => new Map([["MYSAPSSO2", SENTINEL]]) },
      makeBreaker(),
    );

    await guard.request(REQ);

    expect(inner.calls[0]?.headers?.["Cookie"]).toBe(`MYSAPSSO2=${SENTINEL}`);
  });

  it("drops opts.auth when a cookie is configured", async () => {
    const inner = new ScriptedClient(() => resp(200));
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, injectedCookies: () => new Map([["MYSAPSSO2", SENTINEL]]) },
      makeBreaker(),
    );

    await guard.request({ ...REQ, auth: AUTH } as HttpClientOptions);

    expect(inner.calls[0]?.auth).toBeUndefined();
  });

  it("leaves opts.auth untouched when no cookie is configured", async () => {
    const inner = new ScriptedClient(() => resp(200));
    const guard = new GuardedHttpClient({ baseURL: "http://x", inner }, makeBreaker());

    await guard.request({ ...REQ, auth: AUTH } as HttpClientOptions);

    expect(inner.calls[0]?.auth).toEqual(AUTH);
  });

  it("leaves opts.auth untouched when the hook returns undefined", async () => {
    const inner = new ScriptedClient(() => resp(200));
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, injectedCookies: () => undefined },
      makeBreaker(),
    );

    await guard.request({ ...REQ, auth: AUTH } as HttpClientOptions);

    expect(inner.calls[0]?.auth).toEqual(AUTH);
    expect(inner.calls[0]?.headers?.["Cookie"]).toBeUndefined();
  });

  it("a non-empty jar value wins over the injected value for the same name", async () => {
    const inner = new ScriptedClient(() => resp(200));
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, injectedCookies: () => new Map([["MYSAPSSO2", SENTINEL]]) },
      makeBreaker(),
    );

    await guard.request({
      ...REQ,
      headers: { Cookie: "MYSAPSSO2=server-issued; OTHER=x" },
    } as HttpClientOptions);

    const cookie = inner.calls[0]?.headers?.["Cookie"];
    expect(cookie).toContain("MYSAPSSO2=server-issued");
    expect(cookie).not.toContain(SENTINEL);
  });

  it("an EMPTY jar value does not win — the injected value fills it", async () => {
    const inner = new ScriptedClient(() => resp(200));
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, injectedCookies: () => new Map([["MYSAPSSO2", SENTINEL]]) },
      makeBreaker(),
    );

    await guard.request({
      ...REQ,
      headers: { Cookie: "MYSAPSSO2=; OTHER=x" },
    } as HttpClientOptions);

    const cookie = inner.calls[0]?.headers?.["Cookie"] ?? "";
    expect(cookie).toContain(`MYSAPSSO2=${SENTINEL}`);
    const names = cookie.split(";").map((p) => p.trim().split("=")[0]);
    expect(names.filter((n) => n === "MYSAPSSO2")).toHaveLength(1);
  });

  it("fills a name the jar lacks, without duplicating names already present", async () => {
    const inner = new ScriptedClient(() => resp(200));
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, injectedCookies: () => new Map([["MYSAPSSO2", SENTINEL]]) },
      makeBreaker(),
    );

    await guard.request({ ...REQ, headers: { Cookie: "OTHER=x" } } as HttpClientOptions);

    const cookie = inner.calls[0]?.headers?.["Cookie"] ?? "";
    const pairs = cookie.split(";").map((p) => p.trim());
    expect(pairs).toContain("OTHER=x");
    expect(pairs).toContain(`MYSAPSSO2=${SENTINEL}`);
    expect(pairs).toHaveLength(2);
  });

  it("copies the caller's headers object instead of writing through it", async () => {
    const original = { Cookie: "OTHER=x" };
    const inner = new ScriptedClient(() => resp(200));
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, injectedCookies: () => new Map([["MYSAPSSO2", SENTINEL]]) },
      makeBreaker(),
    );

    await guard.request({ ...REQ, headers: original } as HttpClientOptions);

    expect(original.Cookie).toBe("OTHER=x");
    expect(inner.calls[0]?.headers?.["Cookie"]).not.toBe(original.Cookie);
  });

  it("JSON.stringify of GuardOptions never contains the cookie value", () => {
    const injected = new Map([["MYSAPSSO2", SENTINEL]]);
    const opts = { baseURL: "http://x", injectedCookies: () => injected };

    expect(JSON.stringify(opts)).not.toContain(SENTINEL);
  });

  it("never mutates the injected map, across repeated dispatches with different jars", async () => {
    const injected = new Map([["MYSAPSSO2", SENTINEL]]);
    const inner = new ScriptedClient(() => resp(200));
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, injectedCookies: () => injected },
      makeBreaker(),
    );

    await guard.request({
      ...REQ,
      headers: { Cookie: "MYSAPSSO2=server-issued" },
    } as HttpClientOptions);
    await guard.request({ ...REQ, headers: { Cookie: "OTHER=y" } } as HttpClientOptions);

    expect(injected.size).toBe(1);
    expect(injected.get("MYSAPSSO2")).toBe(SENTINEL);
  });
});
