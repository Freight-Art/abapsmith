/**
 * The transport-release "ignore" endpoint exclusion inside `GuardedHttpClient`
 * — see the policy block above `assertHttpPathAllowed` in `src/adt/http-guard.ts`.
 *
 * `transportRelease(h, tr, ignoreLocks, IgnoreATC)` in `abap-adt-api` picks its
 * endpoint from two booleans the CALLER passes it:
 *
 *   normal release  -> .../transportrequests/{tr}/newreleasejobs   (fine, must pass)
 *   ignore locks    -> .../transportrequests/{tr}/relwithignlock   (must NEVER pass)
 *   ignore ATC      -> .../transportrequests/{tr}/relobjigchkatc   (must NEVER pass)
 *
 * The two "ignore" variants bypass the customer's own quality gates — the
 * enqueue lock and ATC findings — which is the whole reason they must be
 * unreachable at the URL layer rather than merely undialled by convention: a
 * calling convention ("we just never pass `true` for those booleans") breaks
 * with a one-line change anywhere upstream; a path deny does not.
 *
 * This file is entirely offline. It constructs `GuardedHttpClient` with an
 * injected `inner: HttpClient` spy and never emits a packet. The point of
 * every "denied" case below is proven two ways: the thrown error's `code`,
 * AND the spy's call count staying at 0 — a test that only checked the throw
 * would pass even if the guard dispatched the request first and threw
 * afterwards.
 */
import { describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { GuardedHttpClient } from "../src/adt/http-guard.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import type { AbapError } from "../src/adt/errors.js";

// NOTE: deliberately does not import `loadConfig`/build a `Config` or an
// `AbapConnection` here. `test/system-role-probe-guard.test.ts` treats any
// suite matching `loadConfig(`/`new AbapConnection(` as a "connection
// builder" that must route the system-role probe or be allow-listed —
// machinery this file has nothing to do with (it never connects to
// anything, real or faked). The "maximally permissive" cases below prove
// their point directly with `process.env`, which `GuardedHttpClient` reads
// exactly as much as `Config` does: not at all.

// ---------------------------------------------------------------- fixtures ---

/** Records every call it receives; never actually resolves off-box I/O. */
class SpyClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return {
      status: 200,
      statusText: "200",
      body: "ok",
      headers: { "content-type": "text/plain" },
    } as unknown as HttpClientResponse;
  }
}

const makeGuard = (inner: HttpClient) =>
  new GuardedHttpClient({ baseURL: "http://x", inner }, new AuthCircuitBreaker());

const codeOf = (e: unknown): AbapError["code"] => (e as AbapError).code;

const TR = "NPLK900123";
const RELEASE_BASE = `/sap/bc/adt/cts/transportrequests/${TR}`;

// --------------------------------------------------- the two denied paths ---

describe("the transport-release ignore-variants are denied unconditionally", () => {
  it("denies relwithignlock even with ABAP_ALLOW_WRITE=true and ABAP_ALLOW_TRANSPORT_RELEASE=true", async () => {
    // Set the flags a caller would use to try to enable release-with-ignore —
    // `GuardedHttpClient` reads no env var at all, so this is expected to have
    // zero effect, and the assertions below prove it.
    const prevWrite = process.env.ABAP_ALLOW_WRITE;
    const prevRelease = process.env.ABAP_ALLOW_TRANSPORT_RELEASE;
    process.env.ABAP_ALLOW_WRITE = "true";
    process.env.ABAP_ALLOW_TRANSPORT_RELEASE = "true";
    try {
      const inner = new SpyClient();
      const guard = makeGuard(inner);

      const e = await guard
        .request({ method: "POST", url: `${RELEASE_BASE}/relwithignlock` } as HttpClientOptions)
        .catch((err) => err);

      expect(codeOf(e)).toBe("HTTP_PATH_DENIED");
      expect(inner.calls.length).toBe(0);
    } finally {
      process.env.ABAP_ALLOW_WRITE = prevWrite;
      process.env.ABAP_ALLOW_TRANSPORT_RELEASE = prevRelease;
    }
  });

  it("denies relobjigchkatc even with ABAP_ALLOW_WRITE=true and ABAP_ALLOW_TRANSPORT_RELEASE=true", async () => {
    const prevWrite = process.env.ABAP_ALLOW_WRITE;
    const prevRelease = process.env.ABAP_ALLOW_TRANSPORT_RELEASE;
    process.env.ABAP_ALLOW_WRITE = "true";
    process.env.ABAP_ALLOW_TRANSPORT_RELEASE = "true";
    try {
      const inner = new SpyClient();
      const guard = makeGuard(inner);

      const e = await guard
        .request({ method: "POST", url: `${RELEASE_BASE}/relobjigchkatc` } as HttpClientOptions)
        .catch((err) => err);

      expect(codeOf(e)).toBe("HTTP_PATH_DENIED");
      expect(inner.calls.length).toBe(0);
    } finally {
      process.env.ABAP_ALLOW_WRITE = prevWrite;
      process.env.ABAP_ALLOW_TRANSPORT_RELEASE = prevRelease;
    }
  });

  it("denies both endpoints at GET/PUT/DELETE too — the deny is on the path, not the verb", async () => {
    for (const method of ["GET", "PUT", "DELETE", "POST"]) {
      for (const suffix of ["relwithignlock", "relobjigchkatc"]) {
        const inner = new SpyClient();
        const guard = makeGuard(inner);
        const e = await guard
          .request({ method, url: `${RELEASE_BASE}/${suffix}` } as HttpClientOptions)
          .catch((err) => err);
        expect(codeOf(e)).toBe("HTTP_PATH_DENIED");
        expect(inner.calls.length).toBe(0);
      }
    }
  });

  it("denies with no permission flags set at all (the default, most-restrictive baseline)", async () => {
    const inner = new SpyClient();
    const guard = makeGuard(inner);
    const e = await guard
      .request({ method: "POST", url: `${RELEASE_BASE}/relwithignlock` } as HttpClientOptions)
      .catch((err) => err);
    expect(codeOf(e)).toBe("HTTP_PATH_DENIED");
    expect(inner.calls.length).toBe(0);
  });
});

// ------------------------------------------- the normal release endpoint ---

describe("the normal release endpoint is unaffected", () => {
  it("permits newreleasejobs at the guard layer — it reaches the network", async () => {
    const inner = new SpyClient();
    const guard = makeGuard(inner);

    const r = await guard.request({
      method: "POST",
      url: `${RELEASE_BASE}/newreleasejobs`,
    } as HttpClientOptions);

    expect(r.status).toBe(200);
    expect(inner.calls.length).toBe(1);
  });
});

// ------------------------------------------------------- the error shape ---

describe("HTTP_PATH_DENIED's contract: no network, method+path yes, query string no", () => {
  it("throws before any network call — the spy is never invoked", async () => {
    const inner = new SpyClient();
    const guard = makeGuard(inner);

    await expect(
      guard.request({ method: "POST", url: `${RELEASE_BASE}/relwithignlock` } as HttpClientOptions),
    ).rejects.toMatchObject({ code: "HTTP_PATH_DENIED" });

    expect(inner.calls.length).toBe(0);
  });

  it("names the method and the path in the message", async () => {
    const inner = new SpyClient();
    const guard = makeGuard(inner);

    const e = await guard
      .request({ method: "post", url: `${RELEASE_BASE}/relwithignlock` } as HttpClientOptions)
      .catch((err) => err);

    expect(e.message).toContain("POST");
    expect(e.message).toContain(RELEASE_BASE);
    expect(e.message).toContain("relwithignlock");
  });

  it("never leaks the query string into the message or details, even when it carries an identifier", async () => {
    const inner = new SpyClient();
    const guard = makeGuard(inner);

    const secretQuery = "trkorr=NPLK900999&sap-password=hunter2&session-token=abc123";
    const e = await guard
      .request({
        method: "POST",
        url: `${RELEASE_BASE}/relwithignlock?${secretQuery}`,
      } as HttpClientOptions)
      .catch((err) => err);

    expect(e.code).toBe("HTTP_PATH_DENIED");
    expect(e.message).not.toContain("hunter2");
    expect(e.message).not.toContain("session-token");
    expect(e.message).not.toContain(secretQuery);
    expect(e.message).not.toContain("?");
    expect(JSON.stringify(e.details ?? {})).not.toContain("hunter2");
  });
});

// ------------------------------------------------------------- near misses --

describe("near-miss URLs cannot fool the matcher", () => {
  it("still denies when a safe-looking segment precedes the dangerous one (.../newreleasejobs/relwithignlock)", async () => {
    // A matcher keyed on "the url contains newreleasejobs => allow" would be
    // shadowed by this. The real rule anchors on the FINAL path segment, so
    // this must still be refused.
    const inner = new SpyClient();
    const guard = makeGuard(inner);

    const e = await guard
      .request({
        method: "POST",
        url: `${RELEASE_BASE}/newreleasejobs/relwithignlock`,
      } as HttpClientOptions)
      .catch((err) => err);

    expect(codeOf(e)).toBe("HTTP_PATH_DENIED");
    expect(inner.calls.length).toBe(0);
  });

  it("still denies a case-mangled variant (RelWithIgnLock / RELOBJIGCHKATC)", async () => {
    const inner = new SpyClient();
    const guard = makeGuard(inner);

    const e1 = await guard
      .request({ method: "POST", url: `${RELEASE_BASE}/RelWithIgnLock` } as HttpClientOptions)
      .catch((err) => err);
    expect(codeOf(e1)).toBe("HTTP_PATH_DENIED");

    const e2 = await guard
      .request({ method: "POST", url: `${RELEASE_BASE}/RELOBJIGCHKATC` } as HttpClientOptions)
      .catch((err) => err);
    expect(codeOf(e2)).toBe("HTTP_PATH_DENIED");

    expect(inner.calls.length).toBe(0);
  });

  it("allows a path where the dangerous token only appears embedded in the query string", async () => {
    // The token is real text in the URL, but after the `?` — a substring
    // matcher over the whole raw string would wrongly deny this; the actual
    // rule strips the query before matching, so this is a legitimate call to
    // the normal release endpoint and must reach the network.
    const inner = new SpyClient();
    const guard = makeGuard(inner);

    const r = await guard.request({
      method: "POST",
      url: `${RELEASE_BASE}/newreleasejobs?note=relwithignlock`,
    } as HttpClientOptions);

    expect(r.status).toBe(200);
    expect(inner.calls.length).toBe(1);
  });

  it("allows a path where the dangerous token only appears as a qs object value (never even reaches url)", async () => {
    // `options.qs` is a structurally separate field from `options.url` in
    // `abap-adt-api`'s `HttpClientOptions` — the policy check only ever reads
    // `options.url`, so a qs value can never influence it either way.
    const inner = new SpyClient();
    const guard = makeGuard(inner);

    const r = await guard.request({
      method: "GET",
      url: `${RELEASE_BASE}/newreleasejobs`,
      qs: { evil: "relwithignlock", trkorr: TR },
    } as HttpClientOptions);

    expect(r.status).toBe(200);
    expect(inner.calls.length).toBe(1);
  });

  it("allows a path where the token appears in a non-terminal segment", async () => {
    // The dangerous suffix must be the LAST segment. If it shows up earlier
    // in the path but something else follows it, this is not the dangerous
    // endpoint at all (abap-adt-api never produces such a shape) and a
    // bare-substring matcher would be the only thing that could deny it.
    const inner = new SpyClient();
    const guard = makeGuard(inner);

    const r = await guard.request({
      method: "GET",
      url: `${RELEASE_BASE}/relwithignlock/somethingelse`,
    } as HttpClientOptions);

    expect(r.status).toBe(200);
    expect(inner.calls.length).toBe(1);
  });
});
