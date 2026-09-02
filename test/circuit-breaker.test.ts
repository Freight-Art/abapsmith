/**
 * The most important tests in the repo.
 *
 * `login/fails_to_user_lock` defaults to 5. A retry loop
 * on a stale password locks the technical user. 3 of the 5 attempts on the
 * sandbox account were already spent during recon.
 *
 * These tests assert, against the real `abap-adt-api` stack, that ONE failed
 * logon reaches the network and that everything afterwards is refused locally.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthCircuitBreaker,
  classifyAuthFailure,
  classifyFailure,
  isIcfLogonFailure,
  isIcfPasswordChangePage,
  type ResponseLike,
} from "../src/adt/circuit-breaker.js";
import { GuardedHttpClient } from "../src/adt/http-guard.js";
import { AbapConnection } from "../src/adt/connection.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError } from "../src/adt/errors.js";

const ICF_LOGON_PAGE = `<!DOCTYPE html><html><head><title>Logon Error Message</title></head>
<body><h1>Anmeldung fehlgeschlagen</h1>
<form name="sap-system-login"><input name="sap-user"><input name="sap-password"></form>
</body></html>`;

/**
 * D1 — `who` exists because the auth latch is now remembered PROCESS-WIDE,
 * keyed on a fingerprint of (url, user, password): once any test in this file
 * lets a connection trip for real, a later `new AbapConnection` built with the
 * same three values is latched from birth and never issues a request at all.
 *
 * That is the feature, but it silently rewrites every test below it — including
 * the happy-path ones, which never trip anything themselves and would simply
 * inherit an earlier test's latch. So every test that builds an
 * `AbapConnection` without passing its own `breaker` gets its own credentials.
 * The default is deliberately still the plain shared one: tests that never
 * construct a connection (the classifier and state-machine blocks) are
 * unaffected and read exactly as before.
 *
 * Since `ConnectionOptions.breaker` became REQUIRED there is no longer an
 * omission to inherit through: every site below now says which breaker it
 * wants. `AuthCircuitBreaker.forConfig(c)` is the credential-keyed one that
 * replays a prior trip (the D1 tests); `new AuthCircuitBreaker()` is the plain
 * one for tests where the breaker is incidental. The per-test `who` suffix
 * still matters for the former, and is harmless for the latter.
 */
const cfg = (who = ""): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: `secret${who}`,
    sid: "TST",
  });

/** Counts every request that would leave the process. */
class CountingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

describe("auth failure classification", () => {
  it("classifies a plain 401", () => {
    expect(classifyAuthFailure({ status: 401 })).toBe("http-401");
  });

  it("classifies the ICF logon-failed HTML page served with status 200", () => {
    // This system answers a bad logon with 200 + HTML.
    expect(
      classifyAuthFailure({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: ICF_LOGON_PAGE,
      }),
    ).toBe("icf-logon-page");
  });

  it("classifies a 403 carrying a WWW-Authenticate challenge", () => {
    expect(
      classifyAuthFailure({ status: 403, headers: { "www-authenticate": 'Basic realm="SAP"' } }),
    ).toBe("http-403-auth");
  });

  it("does NOT trip on ordinary failures", () => {
    expect(classifyAuthFailure({ status: 404, body: "No suitable resource found" })).toBeUndefined();
    expect(classifyAuthFailure({ status: 403, body: "CSRF token validation failed" })).toBeUndefined();
    expect(classifyAuthFailure({ status: 500, body: "<html>dump</html>" })).toBeUndefined();
  });

  it("does NOT mistake ABAP source mentioning 'logon failed' for the ICF page", () => {
    const source = resp(200, `WRITE 'logon failed'.`, { "content-type": "text/plain" });
    expect(isIcfLogonFailure(source)).toBe(false);
    expect(classifyAuthFailure(source)).toBeUndefined();
  });
});

describe("AuthCircuitBreaker", () => {
  it("latches on the first trip and keeps the first reason", () => {
    const b = new AuthCircuitBreaker();
    expect(b.isTripped).toBe(false);
    b.trip("http-401", "first");
    b.trip("icf-logon-page", "second");
    expect(b.isTripped).toBe(true);
    expect(b.info?.reason).toBe("http-401");
    expect(b.info?.message).toBe("first");
  });

  it("notifies listeners exactly once", () => {
    const b = new AuthCircuitBreaker();
    let n = 0;
    b.onTrip(() => n++);
    b.trip("http-401", "x");
    b.trip("http-401", "y");
    expect(n).toBe(1);
  });
});

describe("GuardedHttpClient", () => {
  it("refuses every request after the first 401 without touching the network", async () => {
    const inner = new CountingClient(() => resp(401, "Unauthorized"));
    const guard = new GuardedHttpClient({ baseURL: "http://x", inner }, new AuthCircuitBreaker());

    await expect(guard.request({ url: "/a" } as HttpClientOptions)).rejects.toThrow(
      /circuit breaker/i,
    );
    for (const url of ["/b", "/c", "/d", "/e"]) {
      await expect(guard.request({ url } as HttpClientOptions)).rejects.toThrow(/circuit breaker/i);
    }

    expect(inner.calls).toHaveLength(1); // ← the whole point
    expect(guard.blockedCount).toBe(4);
    expect(guard.breaker.info?.reason).toBe("http-401");
  });

  it("trips on the ICF logon page even though it is a 200", async () => {
    const inner = new CountingClient(() =>
      resp(200, ICF_LOGON_PAGE, { "content-type": "text/html" }),
    );
    const guard = new GuardedHttpClient({ baseURL: "http://x", inner }, new AuthCircuitBreaker());
    await expect(guard.request({ url: "/a" } as HttpClientOptions)).rejects.toThrow(
      /circuit breaker/i,
    );
    expect(guard.breaker.info?.reason).toBe("icf-logon-page");
    expect(inner.calls).toHaveLength(1);
  });

  it("strips ?sap-client= unless explicitly opted in", async () => {
    const inner = new CountingClient(() => resp(200, "ok", { "content-type": "text/plain" }));
    const guard = new GuardedHttpClient({ baseURL: "http://x", inner }, new AuthCircuitBreaker());
    await guard.request({ url: "/a", qs: { "sap-client": "001", other: "1" } } as never);
    expect(inner.calls[0]!.qs).toEqual({ other: "1" });
  });

  it("passes sap-client through when opted in", async () => {
    const inner = new CountingClient(() => resp(200, "ok", { "content-type": "text/plain" }));
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner, sendClientParam: true },
      new AuthCircuitBreaker(),
    );
    await guard.request({ url: "/a", qs: { "sap-client": "001" } } as never);
    expect(inner.calls[0]!.qs).toEqual({ "sap-client": "001" });
  });

  it("lets non-auth errors through without tripping", async () => {
    const inner = new CountingClient(() => resp(404, "No suitable resource found"));
    const guard = new GuardedHttpClient({ baseURL: "http://x", inner }, new AuthCircuitBreaker());
    const r = await guard.request({ url: "/a" } as HttpClientOptions);
    expect(r.status).toBe(404);
    expect(guard.breaker.isTripped).toBe(false);
  });
});

describe("AbapConnection over the real abap-adt-api stack", () => {
  it("makes exactly ONE logon attempt when credentials are rejected", async () => {
    // abap-adt-api's AdtHTTP.request() retries once on a login error by design.
    // The guard must answer that retry locally.
    const inner = new CountingClient(() => resp(401, "Unauthorized"));
    // Not a D1 test: the trip under test comes off the WIRE, so a plain,
    // untagged breaker is both sufficient and clearer here.
    const conn = new AbapConnection(cfg("-one-logon"), {
      httpClient: inner,
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });

    // `AUTH_FAILED`, not `AUTH_CIRCUIT_OPEN`: this connect's OWN logon is the 401
    // that latched the breaker, so the accurate account of what happened is the
    // credential rejection. The latch is reported for what it is only once it is
    // refusing something OTHER than the request that set it — asserted two lines
    // below, and by the D1 cases. See `connect()`'s login catch.
    await expect(conn.connect()).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "AUTH_FAILED",
    );
    expect(conn.breaker.isTripped).toBe(true);
    expect(inner.calls).toHaveLength(1);

    // Every later call is refused locally, forever.
    await expect(conn.connect()).rejects.toThrow(/circuit breaker/i);
    await expect(conn.get("/sap/bc/adt/discovery")).rejects.toThrow(/circuit breaker/i);
    expect(inner.calls).toHaveLength(1);
    expect(conn.requestCount).toBe(1);
  });

  it("makes exactly ONE attempt when the system answers with the ICF logon page", async () => {
    const inner = new CountingClient(() =>
      resp(200, ICF_LOGON_PAGE, { "content-type": "text/html; charset=utf-8" }),
    );
    const conn = new AbapConnection(cfg("-icf-page"), {
      httpClient: inner,
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    await expect(conn.connect()).rejects.toThrow(/circuit breaker/i);
    expect(inner.calls).toHaveLength(1);
  });

  it("never sends ?sap-client= on the login request", async () => {
    const inner = new CountingClient(() => resp(401, ""));
    const c = { ...cfg("-no-client-param"), client: "001" };
    const conn = new AbapConnection(c, {
      httpClient: inner,
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    await expect(conn.connect()).rejects.toThrow();
    const qs = inner.calls[0]!.qs ?? {};
    expect(qs).not.toHaveProperty("sap-client");
  });

  it("preserves the full cookie jar including saplb_* (§5.2.4)", async () => {
    const inner = new CountingClient(() =>
      resp(200, "ok", {
        "content-type": "text/plain",
        "x-csrf-token": "TOKEN123",
        "set-cookie": [
          "SAP_SESSIONID_A4H_001=abc; path=/",
          "saplb_*=(sapa4h_A4H_00)3557150; path=/",
          "sap-usercontext=sap-client=001; path=/",
        ],
      }),
    );
    const conn = new AbapConnection(cfg("-cookie-jar"), {
      httpClient: inner,
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    await conn.connect();
    const cookies = conn.cookies();
    expect(cookies).toContain("saplb_*=(sapa4h_A4H_00)3557150");
    expect(cookies).toContain("SAP_SESSIONID_A4H_001=abc");
    expect(cookies).toContain("sap-usercontext=sap-client=001");
    expect(conn.csrfToken()).toBe("TOKEN123");
  });

  it("keeps writes off and refuses stateful sessions in read mode", async () => {
    const inner = new CountingClient(() => resp(200, "ok", { "content-type": "text/plain" }));
    const conn = new AbapConnection(cfg("-phase0"), {
      httpClient: inner,
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    await conn.connect();
    expect(conn.readOnly).toBe(true);
    // This fake never answers the T000 probe, so the system is unclassifiable
    // and writes are locked out — the reason text is now the fail-closed one.
    expect(conn.writesLockedOut).toBe(true);
    await expect(conn.withStatefulSession(async () => 1)).rejects.toThrow(
      /require writes to be enabled/,
    );
  });
});

// ---------------------------------------------------------------------------
// D1 — the auth latch is remembered PROCESS-WIDE, keyed on the credentials.
//
// Before this, the latch lived on the breaker instance, and every short-lived
// `AbapConnection` (one per one-shot tool call) built its own. A rejected
// password was forgotten the moment that object went away, so the NEXT
// connection sent its own logon and burned another of the five attempts the
// ICF lockout counter allows. These tests assert the fix in the only currency
// that matters: requests that would have left the process.
// ---------------------------------------------------------------------------
describe("D1 — a rejected credential latches for the whole process, not one object", () => {
  it("a second connection with the SAME rejected credentials issues NO request at all", async () => {
    const first = new CountingClient(() => resp(401, "Unauthorized"));
    const c = cfg("-d1-shared");

    // D1: BOTH connections must ask for the credential-keyed breaker by name.
    // `forConfig(c)` is what tags the first one's fingerprint (so its real trip
    // is remembered) and what replays that trip into the second one.
    const a = new AbapConnection(c, {
      httpClient: first,
      log: () => {},
      breaker: AuthCircuitBreaker.forConfig(c),
    });
    // `AUTH_FAILED` here and `AUTH_CIRCUIT_OPEN` below is the whole distinction:
    // the first connection's own credentials were rejected, the second one was
    // refused by a latch it inherited. Both are terminal; only one of them is a
    // statement about the operator's password.
    await expect(a.connect()).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "AUTH_FAILED",
    );
    expect(a.breaker.isTripped).toBe(true);
    expect(first.calls).toHaveLength(1);

    // A brand-new connection, its own transport, the same three credential
    // values. It must be latched from birth.
    const second = new CountingClient(() => resp(401, "Unauthorized"));
    const b = new AbapConnection(c, {
      httpClient: second,
      log: () => {},
      breaker: AuthCircuitBreaker.forConfig(c),
    });
    expect(b.breaker.isTripped).toBe(true);
    expect(b.breaker.info?.reason).toBe("http-401");
    await expect(b.connect()).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "AUTH_CIRCUIT_OPEN",
    );

    // The whole point: ONE request for both connections put together.
    expect(second.calls).toHaveLength(0);
    expect(b.requestCount).toBe(0);
    expect(first.calls.length + second.calls.length).toBe(1);
  });

  it("a CHANGED password gets a clean slate and issues its own request", async () => {
    // The latch must key on the credentials, not on the URL or the user, or
    // fixing the password would leave the operator permanently locked out of
    // their own restart-free recovery.
    const bad = new CountingClient(() => resp(401, "Unauthorized"));
    // Hoisted so the breaker is minted from the IDENTICAL Config value the
    // connection is built with — a second `cfg(...)` call would still produce
    // the same three credential values, but tying them together is the point.
    const oldPw = cfg("-d1-old-password");
    const a = new AbapConnection(oldPw, {
      httpClient: bad,
      log: () => {},
      breaker: AuthCircuitBreaker.forConfig(oldPw),
    });
    // Its own 401 — so the credential rejection, not the latch it just set.
    await expect(a.connect()).rejects.toSatisfy(
      (e: unknown) => isAbapError(e) && e.code === "AUTH_FAILED",
    );
    expect(a.breaker.isTripped).toBe(true);
    expect(bad.calls).toHaveLength(1);

    const good = new CountingClient(() => resp(200, "ok", { "content-type": "text/plain" }));
    const newPw = cfg("-d1-new-password");
    const b = new AbapConnection(newPw, {
      httpClient: good,
      log: () => {},
      breaker: AuthCircuitBreaker.forConfig(newPw),
    });
    expect(b.breaker.isTripped).toBe(false);
    await b.connect();
    expect(good.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("never leaks the password or the fingerprint into any observable surface", async () => {
    const PASSWORD = "hunter2-d1-leak-probe";
    const logs: string[] = [];
    const inner = new CountingClient(() => resp(401, "Unauthorized"));
    // `forConfig`, not a bare breaker: the fingerprint this test proves is
    // unobservable only EXISTS on a credential-keyed breaker, so an untagged
    // one would quietly stop testing anything.
    const leakCfg = { ...cfg(), password: PASSWORD };
    const conn = new AbapConnection(leakCfg, {
      httpClient: inner,
      log: (m) => logs.push(m),
      breaker: AuthCircuitBreaker.forConfig(leakCfg),
    });

    const err = await conn.connect().catch((e: unknown) => e);
    expect(isAbapError(err)).toBe(true);

    // Everything an operator, a log scraper or a tool caller can see.
    const surfaces = [
      err instanceof Error ? err.message : String(err),
      JSON.stringify(isAbapError(err) ? err.details : {}),
      isAbapError(err) ? (err.hint ?? "") : "",
      JSON.stringify(isAbapError(err) ? err.toJSON() : {}),
      JSON.stringify(conn.breaker.status()),
      JSON.stringify(conn.breaker.info ?? {}),
      logs.join("\n"),
    ].join("\n");

    expect(surfaces).not.toContain(PASSWORD);
    // ...and no bare 16-hex-char token either: the fingerprint is derived from
    // the password, so exposing it would be exposing an oracle for it.
    expect(surfaces).not.toMatch(/\b[0-9a-f]{16}\b/);
  });

  /**
   * BEHAVIOUR-LOCK for the `AbapConnection.buildBreaker` →
   * `AuthCircuitBreaker.forConfig` move.
   *
   * The replay used to be reachable only by omitting `breaker` from
   * `ConnectionOptions`, which made it the DEFAULT and therefore invisible.
   * It is now a named, public seam — and every test above reaches it through
   * an `AbapConnection`. This one asserts the seam itself, with no connection
   * and no transport in the picture at all, so that a future refactor of
   * `AbapConnection` cannot take the replay down with it unnoticed.
   */
  it("BEHAVIOUR-LOCK: AuthCircuitBreaker.forConfig replays a stored trip, and only for the same credentials", () => {
    const c = cfg("-d1-forconfig-behaviour-lock");

    // A miss returns an ordinary clean breaker — tagged, but not latched.
    const first = AuthCircuitBreaker.forConfig(c);
    expect(first.isTripped).toBe(false);
    expect(first.state).toBe("closed");
    expect(first.allowRequest()).toBe(true);

    // A REAL trip, through the ordinary classification path, is what puts this
    // fingerprint in the store. Nothing here goes near a socket.
    expect(first.inspect({ status: 401 }, "/sap/bc/adt/discovery")?.reason).toBe("http-401");
    expect(first.isTripped).toBe(true);

    // The replay: a second, independent breaker minted from the SAME Config
    // comes back ALREADY latched, carrying the original reason, at a cost of
    // zero network calls.
    const replay = AuthCircuitBreaker.forConfig(c);
    expect(replay).not.toBe(first);
    expect(replay.isTripped).toBe(true);
    expect(replay.info?.reason).toBe("http-401");
    expect(replay.info?.url).toBe("/sap/bc/adt/discovery");
    expect(replay.state).toBe("latched");
    expect(replay.allowRequest()).toBe(false);

    // ...and the latch is keyed on the credentials, not on the URL or the
    // user: a different password is a different fingerprint, hence a miss.
    const other = AuthCircuitBreaker.forConfig(cfg("-d1-forconfig-behaviour-lock-other"));
    expect(other.isTripped).toBe(false);
    expect(other.state).toBe("closed");
    expect(other.allowRequest()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D4 — the ICF page markers are TIERED.
//
// Structural markers (form/field names ICF emits itself) are sufficient alone.
// Prose markers ("logon failed", "Anmeldung fehlgeschlagen") are translated
// copy that can legitimately appear in an ABAP payload, so they trip only when
// an actual `<form` corroborates them. A false positive here disables the
// process permanently, which is why the weaker evidence needs a second
// witness.
// ---------------------------------------------------------------------------
describe("D4 — tiered ICF page markers", () => {
  const LIVE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");

  /**
   * The `.txt` captures carry a `#`-commented preamble (request, status,
   * headers) followed by the verbatim body. Only the body is the page.
   */
  const capturedBody = (name: string): string => {
    const raw = readFileSync(join(LIVE, name), "utf8");
    const marker = "# --- raw body follows (verbatim, unmodified) ---\n";
    const i = raw.indexOf(marker);
    expect(i).toBeGreaterThanOrEqual(0);
    return raw.slice(i + marker.length);
  };

  /** SYNTHETIC — hand-written, not captured. See each test for what it stands in for. */
  const synthetic = (body: string): ResponseLike => ({
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body,
  });

  it("a Tier A structural marker alone trips, with no prose and no form", () => {
    // SYNTHETIC. Stands in for the ICF logon FORM, of which this project has
    // no capture and cannot make one: provoking it means a deliberate failed
    // logon, which spends one of five attempts
    // before the user locks. The field name is the marker under test.
    const page = `<!DOCTYPE html><html><body><input name="sap-password"></body></html>`;
    expect(page).not.toMatch(/<form/i);
    expect(isIcfLogonFailure(synthetic(page))).toBe(true);
    expect(classifyAuthFailure(synthetic(page))).toBe("icf-logon-page");
  });

  it("a Tier B prose marker alone, with no form and no challenge header, does NOT trip", () => {
    // SYNTHETIC. The false positive the tiering exists to prevent: prose that
    // could equally be an ABAP string literal or an object description.
    const page = `<!DOCTYPE html><html><body><h1>Logon failed</h1><p>Anmeldung fehlgeschlagen</p></body></html>`;
    expect(page).not.toMatch(/<form/i);
    expect(isIcfLogonFailure(synthetic(page))).toBe(false);
    expect(classifyAuthFailure(synthetic(page))).toBeUndefined();

    // Either corroborator flips it — the rule is a rule, not an accidental
    // "loose prose can never trip".
    const withForm = `<!DOCTYPE html><html><body><h1>Logon failed</h1><form action="/x"></form></body></html>`;
    expect(classifyAuthFailure(synthetic(withForm))).toBe("icf-logon-page");

    const withChallenge: ResponseLike = {
      ...synthetic(page),
      headers: { "content-type": "text/html", "www-authenticate": 'Basic realm="SAP"' },
    };
    expect(isIcfLogonFailure(withChallenge)).toBe(true);
  });

  /**
   * REAL BYTES, captured 2026-08-01: one anonymous `GET /sap/bc/adt/discovery`
   * with no Authorization header. This is a genuine auth failure and must
   * classify as one.
   *
   * It is also the fixture that corrected the marker design. The page has NO
   * `<form>` and none of the logon-form field names — only
   * `<title>Anmeldung fehlgeschlagen</title>` and a `WWW-Authenticate` header
   * — so the first cut of this fix (Tier B corroborated by `<form>` alone)
   * classified it as NOT an auth page. That was masked in `classifyAuthFailure`
   * by the `status === 401` check running first, which is exactly why the
   * body-marker path is asserted here on its own.
   */
  it("the real captured anonymous-401 page classifies as an auth failure", () => {
    const body = capturedBody("700-anon-no-auth-adt-discovery.txt");
    const captured: ResponseLike = {
      status: 401,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "www-authenticate": 'Basic realm="SAP NetWeaver Application Server [A4H/001]"',
        "sap-system": "A4H",
      },
      body,
    };
    expect(classifyAuthFailure(captured)).toBe("http-401");

    const b = new AuthCircuitBreaker();
    b.inspect(captured, "/sap/bc/adt/discovery");
    expect(b.isTripped).toBe(true);
    expect(b.info?.reason).toBe("http-401");
  });

  it("...and the BODY alone identifies it, independently of the 401 status", () => {
    // The status check must not be the only thing holding this up. Same real
    // body, status neutralised to 200 — the shape point 2 of this module's
    // header comment warns about, where an ICF logon problem arrives as a 200.
    const body = capturedBody("700-anon-no-auth-adt-discovery.txt");
    const asHttp200: ResponseLike = {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body,
    };
    // No form, no logon-form field names — only the title carries it.
    expect(body).not.toMatch(/<form/i);
    expect(body).not.toMatch(/sap-system-login|name="sap-user"|name="sap-password"/i);
    expect(isIcfLogonFailure(asHttp200)).toBe(true);
    expect(classifyAuthFailure(asHttp200)).toBe("icf-logon-page");
  });

  it("the real captured ICM 'Application Server Error' page never latches anything", () => {
    // REAL BYTES: a 500 produced by a COMMUNICATION failure, not a credential
    // one. It shares its entire skeleton with the 401 page above — same CSS
    // classes, same embedded SAP logo — and differs in the title. It is
    // exactly what a loosened marker set starts swallowing, at which point one
    // ABAP mistake disables the MCP server for the whole process.
    const captured: ResponseLike = {
      status: 500,
      headers: { "content-type": "text/html; charset=windows-1252" },
      body: readFileSync(join(LIVE, "016-trigger-classrun.xml"), "utf8"),
    };
    expect(isIcfLogonFailure(captured)).toBe(false);
    expect(isIcfPasswordChangePage(captured)).toBe(false);
    expect(classifyAuthFailure(captured)).toBeUndefined();

    const b = new AuthCircuitBreaker();
    b.inspect(captured, "/sap/bc/adt/oo/classrun/ZX");
    expect(b.isTripped).toBe(false);
  });

  it("the ICF password-change page trips with its OWN reason, not icf-logon-page", () => {
    // SYNTHETIC. No capture of this page exists either — see the JUDGMENT CALL
    // note on ICF_PASSWORD_CHANGE_MARKERS_TIER_A in circuit-breaker.ts.
    const page =
      `<!DOCTYPE html><html><body><form name="sap-system-login-change">` +
      `<input name="sap-new-password1"><input name="sap-new-password2"></form></body></html>`;
    expect(isIcfPasswordChangePage(synthetic(page))).toBe(true);
    expect(classifyAuthFailure(synthetic(page))).toBe("icf-password-change");

    // It must reach the latch through the ordinary observation path, and be
    // distinguishable there — an operator whose password EXPIRED needs a
    // different action from one whose password is WRONG.
    const b = new AuthCircuitBreaker();
    b.inspect(synthetic(page), "/sap/bc/adt/compatibility/graph");
    expect(b.isTripped).toBe(true);
    expect(b.info?.reason).toBe("icf-password-change");
  });
});

describe("transient circuit breaker state machine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------- 1. trip-on-transient
  it("stays closed below the failure threshold, opens exactly at it", () => {
    const b = new AuthCircuitBreaker({ cooldownMs: 1000, failureThreshold: 3 });
    b.recordTransientFailure();
    expect(b.state).toBe("closed");
    expect(b.allowRequest()).toBe(true);
    b.recordTransientFailure();
    expect(b.state).toBe("closed");
    expect(b.allowRequest()).toBe(true);
    b.recordTransientFailure(); // 3rd consecutive failure hits the threshold
    expect(b.state).toBe("open");
    expect(b.allowRequest()).toBe(false);
  });

  // -------------------------------------------------------- 2. stays-open-during-cooldown
  it("refuses requests throughout the cooldown; msUntilNextProbe counts down and never goes negative", () => {
    const b = new AuthCircuitBreaker({ cooldownMs: 10_000, failureThreshold: 1 });
    b.recordTransientFailure();
    expect(b.state).toBe("open");
    expect(b.allowRequest()).toBe(false);

    const first = b.status().msUntilNextProbe!;
    expect(first).toBeGreaterThan(0);

    vi.advanceTimersByTime(4000);
    expect(b.allowRequest()).toBe(false);
    const second = b.status().msUntilNextProbe!;
    expect(second).toBeLessThan(first);
    expect(second).toBeGreaterThanOrEqual(0);

    vi.advanceTimersByTime(4000);
    expect(b.allowRequest()).toBe(false);
    const third = b.status().msUntilNextProbe!;
    expect(third).toBeLessThan(second);
    expect(third).toBeGreaterThanOrEqual(0);
  });

  // ------------------------------------------------------------- 3. single-probe half-open
  it("allows exactly one probe once the cooldown elapses, then refuses until it reports back", () => {
    const b = new AuthCircuitBreaker({ cooldownMs: 5000, failureThreshold: 1 });
    b.recordTransientFailure();
    vi.advanceTimersByTime(5000);

    expect(b.allowRequest()).toBe(true); // the one probe
    expect(b.state).toBe("half-open");

    // No burst: every further call in a row is refused while the probe is outstanding.
    for (let i = 0; i < 5; i++) {
      expect(b.allowRequest()).toBe(false);
    }
  });

  // ---------------------------------------------------------- 4. close-on-successful-probe
  it("recordSuccess from half-open fully recovers to closed", () => {
    const b = new AuthCircuitBreaker({ cooldownMs: 5000, failureThreshold: 1 });
    b.recordTransientFailure();
    vi.advanceTimersByTime(5000);
    expect(b.allowRequest()).toBe(true);
    expect(b.state).toBe("half-open");

    b.recordSuccess();
    expect(b.state).toBe("closed");
    expect(b.allowRequest()).toBe(true);
    expect(b.status().consecutiveFailures).toBe(0);
  });

  // ---------------------------------------------------------- 5. re-open-on-failed-probe
  it("a failed probe re-opens and doubles the cooldown, capped at maxCooldownMs", () => {
    const b = new AuthCircuitBreaker({ cooldownMs: 1000, maxCooldownMs: 3000, failureThreshold: 1 });
    b.recordTransientFailure(); // opens: cooldown 1000
    expect(b.status().cooldownMs).toBe(1000);

    vi.advanceTimersByTime(1000);
    expect(b.allowRequest()).toBe(true); // half-open probe
    expect(b.state).toBe("half-open");

    b.recordTransientFailure(); // failed probe -> re-opens, cooldown doubles
    expect(b.state).toBe("open");
    const afterFirstReopen = b.status();
    expect(afterFirstReopen.cooldownMs).toBe(2000);
    expect(afterFirstReopen.cooldownMs).toBeGreaterThan(1000);
    expect(afterFirstReopen.msUntilNextProbe).toBeGreaterThan(0);

    vi.advanceTimersByTime(2000);
    expect(b.allowRequest()).toBe(true); // second probe
    b.recordTransientFailure(); // would double to 4000, capped at 3000
    expect(b.status().cooldownMs).toBe(3000);

    vi.advanceTimersByTime(3000);
    expect(b.allowRequest()).toBe(true); // third probe
    b.recordTransientFailure(); // stays capped
    expect(b.status().cooldownMs).toBe(3000);
  });

  // ------------------------------- 6. MOST IMPORTANT: auth latches permanently, never probed
  it("auth latches permanently on a plain 401 and is never probed again, however long we wait", () => {
    const b = new AuthCircuitBreaker({ cooldownMs: 1000, failureThreshold: 1 });
    expect(b.inspect({ status: 401 })?.reason).toBe("http-401");
    expect(b.isTripped).toBe(true);
    expect(b.state).toBe("latched");
    expect(b.allowRequest()).toBe(false);

    for (const ms of [10 * 60_000, 60 * 60_000, 24 * 60 * 60_000]) {
      vi.advanceTimersByTime(ms);
      expect(b.allowRequest()).toBe(false);
      expect(b.state).toBe("latched");
    }

    // A success cannot un-latch it, and a latched breaker never enters half-open.
    b.recordSuccess();
    expect(b.state).toBe("latched");
    expect(b.allowRequest()).toBe(false);
  });

  it("auth latches permanently on the ICF logon page (HTTP 200 + HTML) and is never probed again", () => {
    const b = new AuthCircuitBreaker({ cooldownMs: 1000, failureThreshold: 1 });
    const cls = b.noteFailure({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: ICF_LOGON_PAGE,
    });
    expect(cls).toBe("auth");
    expect(b.isTripped).toBe(true);
    expect(b.state).toBe("latched");

    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(b.allowRequest()).toBe(false);
    expect(b.state).toBe("latched");
    b.recordSuccess();
    expect(b.state).toBe("latched");
  });

  // --------------------------------------------------------------- 7. classifyFailure
  describe("classifyFailure", () => {
    it("classifies session death as ignored", () => {
      expect(
        classifyFailure({
          status: 500,
          headers: { "content-type": "text/html" },
          body: "<html><body>500 Internal Server Error: Application Server Error</body></html>",
        }),
      ).toBe("ignored");
      expect(classifyFailure({ status: 400, body: "Session Timed Out" })).toBe("ignored");
    });

    it("classifies auth failures as auth", () => {
      expect(classifyFailure({ status: 401 })).toBe("auth");
      expect(
        classifyFailure({
          status: 200,
          headers: { "content-type": "text/html" },
          body: ICF_LOGON_PAGE,
        }),
      ).toBe("auth");
      expect(
        classifyFailure({ status: 403, headers: { "www-authenticate": 'Basic realm="SAP"' } }),
      ).toBe("auth");
    });

    it("classifies everything else as transient", () => {
      expect(classifyFailure(new Error("boom"))).toBe("transient");
      const econnreset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      expect(classifyFailure(econnreset)).toBe("transient");
      expect(classifyFailure({ status: 503 })).toBe("transient");
      expect(classifyFailure({ status: 408 })).toBe("transient");
      expect(classifyFailure({ status: 429 })).toBe("transient");
    });
  });

  // ------------------------------------------------------------------- 8. noteFailure
  it("noteFailure on session death does not latch and does not increment consecutiveFailures", () => {
    const b = new AuthCircuitBreaker({ cooldownMs: 1000, failureThreshold: 3 });
    const cls = b.noteFailure({
      status: 500,
      headers: { "content-type": "text/html" },
      body: "<html><body>500 Internal Server Error: Application Server Error</body></html>",
    });
    expect(cls).toBe("ignored");
    expect(b.isTripped).toBe(false);
    expect(b.state).toBe("closed");
    expect(b.status().consecutiveFailures).toBe(0);
  });

  // ------------------------------------------------------------------------ 9. status()
  it("status() is distinct and actionable when latched", () => {
    const b = new AuthCircuitBreaker();
    b.trip("http-401", "Authentication rejected by the ABAP system (HTTP 401).", { status: 401 });
    const s = b.status();
    expect(s.latched).toBe(true);
    expect(s.authReason).toBe("http-401");
    expect(s.message).toMatch(/credentials/i);
    // "restart" dropped from describeState("latched") — it previously
    // implied a restart clears the durable latch, which is false (a fresh
    // process replays auth-latch.json and re-latches immediately).
    expect(s.message).toMatch(/exiting the process clears it/i);
  });

  // --------------------------------------------------------------------- 10. never throws
  it("never throws, latched or not, even with garbage input", () => {
    const b = new AuthCircuitBreaker({ cooldownMs: 1000, failureThreshold: 1 });
    expect(() => b.allowRequest()).not.toThrow();
    expect(() => b.status()).not.toThrow();
    expect(() => b.state).not.toThrow();
    expect(() => b.recordSuccess()).not.toThrow();
    expect(() => b.noteFailure(undefined)).not.toThrow();

    b.trip("http-401", "x");
    expect(() => b.allowRequest()).not.toThrow();
    expect(() => b.status()).not.toThrow();
    expect(() => b.state).not.toThrow();
    expect(() => b.recordSuccess()).not.toThrow();
    expect(() => b.noteFailure(undefined)).not.toThrow();
  });

  // --------------------------------------------------------------------- 11. resetForTests
  it("resetForTests clears the transient state machine but leaves an untripped breaker untouched", () => {
    const b = new AuthCircuitBreaker({ cooldownMs: 1000, failureThreshold: 1 });
    b.recordTransientFailure(); // opens the transient machine
    expect(b.state).toBe("open");
    expect(b.isTripped).toBe(false);

    b.resetForTests();
    expect(b.state).toBe("closed");
    expect(b.status().consecutiveFailures).toBe(0);
    expect(b.status().probeInFlight).toBe(false);
    expect(b.isTripped).toBe(false);
    expect(b.allowRequest()).toBe(true);
  });

  // -------------------------------------------- 12. resetForTests + the auth latch
  it("resetForTests does NOT clear the permanent auth latch — the ICF lockout guard must survive test resets", () => {
    const b = new AuthCircuitBreaker({ cooldownMs: 1000, failureThreshold: 1 });

    // Trip through the real classification path — a genuine ICF logon-failure
    // page, not a poked private field — exactly what `inspect()` sees on the wire.
    const info = b.inspect({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: ICF_LOGON_PAGE,
    });
    expect(info?.reason).toBe("icf-logon-page");
    expect(b.isTripped).toBe(true);
    expect(b.state).toBe("latched");

    b.resetForTests();

    // The latch is permanent by design: resetForTests()
    // must not be a way to quietly re-arm a breaker whose credentials were
    // already rejected, or a footgun in a shared fixture would let a bad
    // password keep burning attempts against `login/fails_to_user_lock`.
    expect(b.isTripped).toBe(true);
    expect(b.state).toBe("latched");
    expect(b.info?.reason).toBe("icf-logon-page");
    expect(b.allowRequest()).toBe(false);

    // The transient machine underneath is still reset, even while latched —
    // `state` reports "latched" (it outranks everything), but the counters
    // resetForTests() is responsible for must not have been skipped.
    expect(b.status().consecutiveFailures).toBe(0);
  });

  // ------------------------------------ 13. a fresh instance IS the clean-slate escape hatch
  it("a freshly constructed breaker is unlatched — the documented way to get a clean slate in tests", () => {
    const tripped = new AuthCircuitBreaker({ cooldownMs: 1000, failureThreshold: 1 });
    tripped.inspect({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: ICF_LOGON_PAGE,
    });
    expect(tripped.isTripped).toBe(true);

    const fresh = new AuthCircuitBreaker({ cooldownMs: 1000, failureThreshold: 1 });
    expect(fresh.isTripped).toBe(false);
    expect(fresh.state).toBe("closed");
    expect(fresh.allowRequest()).toBe(true);
  });
});
