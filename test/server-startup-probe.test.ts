/**
 * `start()` performs one authenticated probe before the `ready on stdio`
 * banner.
 *
 * ## The defect
 *
 * Before this fix, `start()` (`src/server.ts`) printed `ready on stdio`
 * unconditionally, immediately after `mcp.connect(transport)`, without ever
 * touching the ADT connection — connecting is lazy, deferred to the first
 * tool call (`ensureConnected()`). A typo'd `ABAP_URL`, a down VPN, or a
 * wrong client therefore never reached the operator's terminal: it surfaced
 * inside an agent's transcript on the first tool call, misread as "the
 * agent is confused" rather than "the server is misconfigured".
 *
 * ## What this file pins
 *
 * 1. On a healthy system, `start()` performs exactly ONE logon on the wire
 *    (reusing `ensureConnected()`, not a second separate probe) and prints
 *    an authenticated `connected — …` banner naming the resolved SID/user/
 *    client, taken from `pool.primary().info()`.
 * 2. On a failing system, classified `AUTH_FAILED` / `SYSTEM_UNAVAILABLE` /
 *    `CONNECT_FAILED` (`src/adt/connect-failure.ts`) each print
 *    their code, message, and remediation hint on stderr, and `start()`
 *    STILL resolves — `ready on stdio` still prints, marked NOT CONNECTED.
 * 3. `ABAP_STARTUP_PROBE=false` skips the probe outright: zero logon
 *    requests reach the wire from `start()`, and the banner is unchanged
 *    from its pre-probe text.
 * 4. The probe never throws OUT of `start()`, even for a rejection that is
 *    not an `AbapError` — proven directly against the exported
 *    `describeStartupProbeFailure` helper, since (as that helper's own doc
 *    comment explains) nothing reachable through the real ADT stack can
 *    manufacture a non-`AbapError` rejection any more: `connect()`'s
 *    terminal fallback always classifies and wraps in one.
 * 5. The banner never leaks userinfo credentials for a `user:password@host`
 *    -shaped `ABAP_URL`, in any of the above outcomes.
 *
 * Modelled on `test/server-session-revival.test.ts`'s idiom for driving the
 * REAL `createServer` against a `FakeAdtServer`, except this file also
 * drives the REAL `start()` (that file never calls it) — `start()` is what
 * constructs the production `StdioServerTransport`, so `mcp.connect()` is
 * exercised against real `process.stdin`/`process.stdout` here. That is
 * safe in this environment: `StdioServerTransport.start()` only registers
 * `'data'`/`'error'` listeners, and `stop()` → `mcp.close()` removes them
 * again, so nothing leaks or blocks across tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { createServer, describeStartupProbeFailure, type AbapsmithServer } from "../src/server.js";
import { Journal } from "../src/journal.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import {
  FakeAdtServer,
  __resetFakeAdtCounters,
  fakeResponse,
  type FakeRequest,
  type FakeRoute,
} from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";

const LOGON_PATH = "/sap/bc/adt/compatibility/graph";

// The probe only needs `connect()` to complete; it never reads/writes a
// repository object. `systemRoleRoute` is still required — connect() always
// runs the T000 probe, and the fake has no `catchAll` (StrictAdt idiom), so
// an unrouted probe would record an `unrouted-request` violation.
const systemRoleRoute: FakeRoute = (r) =>
  r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined;

/** A non-auth, non-dump failure on the logon path only — mirrors `server-session-revival.test.ts`'s DEFECT-3 fixture. */
const failingLogonRoute = (status: number, body: string): FakeRoute => (r) =>
  r.path === LOGON_PATH ? fakeResponse(status, body, { "content-type": "text/plain" }) : undefined;

/**
 * Simulates a genuine network failure (no HTTP response at all) — the one
 * shape `FakeAdtServer`'s route mechanism cannot express, since every route
 * answers with a response. Throws a real `HttpClientException` with
 * `response` left `undefined` and `.code` set, exactly the shape
 * `classifyConnectFailure` (`src/adt/connect-failure.ts`) reads to decide
 * `CONNECT_FAILED` — see that module's header for the verified vendor
 * rewrite chain this mirrors (`AxiosHttpClient` → `HttpClientException`,
 * `.response` undefined for anything that never got an answer).
 */
class NetworkFailureHttpClient implements HttpClient {
  constructor(
    private readonly inner: HttpClient,
    private readonly failPath: string,
  ) {}
  async request(options: HttpClientOptions): Promise<HttpClientResponse> {
    if (options.url.includes(this.failPath)) {
      throw new HttpClientException(
        "connect ECONNREFUSED 127.0.0.1:9999",
        "ECONNREFUSED",
        undefined,
        undefined,
        options,
        undefined,
        undefined,
      );
    }
    return this.inner.request(options);
  }
}

/** Userinfo-carrying URL — proves the banner never leaks it, in any outcome. */
const CREDENTIAL_URL = "http://TESTUSER:hunter2@sap.invalid:50000";

const cfg = (over: Partial<Config> = {}): Config => ({
  ...ConfigSchema.parse({
    url: CREDENTIAL_URL,
    user: "TESTUSER",
    password: "hunter2",
    sid: "TST",
    // Fixture-standard client: CCCATEGORY "C" -> the T000 probe can PROVE
    // non-productive rather than fail closed. Irrelevant to most of these
    // tests (readOnly defaults true) but keeps the success-path banner
    // free of the unrelated "writes refused" warning.
    client: "001",
  }),
  ...over,
});

const scaffold = (before: FakeRoute[] = []): FakeAdtServer =>
  new FakeAdtServer({
    routes: [...before, systemRoleRoute],
    // No `catchAll`, deliberately (StrictAdt idiom) — an unrouted request
    // (e.g. a SECOND logon this suite must not see) fails loudly instead of
    // being quietly answered.
  });

const logonRequests = (server: FakeAdtServer): FakeRequest[] =>
  server.calls.filter((r) => r.path === LOGON_PATH);

let openServers: AbapsmithServer[] = [];
let journalDir = "";
let warnings: string[] = [];

function log(m: string): void {
  warnings.push(m);
}

async function build(
  config: Config,
  server: FakeAdtServer,
  extra: Record<string, unknown> = {},
): Promise<AbapsmithServer> {
  const srv = createServer(config, {
    breaker: new AuthCircuitBreaker(),
    ...extra,
    httpClient: extra.httpClient ?? server.client(),
    log,
    journal: new Journal(
      { dir: journalDir, enabled: true, maxEntries: 100, maxAgeDays: 30 },
      config.sid,
    ),
  });
  openServers.push(srv);
  return srv;
}

beforeEach(() => {
  __resetFakeAdtCounters();
  openServers = [];
  warnings = [];
  journalDir = mkdtempSync(join(tmpdir(), "abapsmith-startup-probe-"));
});

afterEach(async () => {
  for (const srv of openServers) {
    await srv.stop().catch(() => {});
  }
  openServers = [];
  rmSync(journalDir, { recursive: true, force: true });
});

// ===========================================================================

describe("start() startup probe", () => {
  it("on a healthy system: prints an authenticated banner, from exactly one logon", async () => {
    const server = scaffold();
    const srv = await build(cfg(), server);

    await srv.start();

    expect(logonRequests(server), "reuses ensureConnected() — not a second probe request").toHaveLength(1);
    const connectedLine = warnings.find((w) => w.includes("connected — authenticated to"));
    expect(connectedLine, `no connected banner in: ${JSON.stringify(warnings)}`).toBeDefined();
    expect(connectedLine).toContain("TST");
    expect(connectedLine).toContain("TESTUSER");
    const readyLine = warnings.find((w) => w.includes("ready on stdio"));
    expect(readyLine).toBeDefined();
    expect(readyLine).not.toContain("NOT CONNECTED");
  });

  it("banner never leaks the URL's userinfo credentials, on success", async () => {
    const server = scaffold();
    const srv = await build(cfg(), server);

    await srv.start();

    for (const w of warnings) {
      expect(w, `leaked credentials in: ${w}`).not.toContain("hunter2");
      expect(w, `leaked credentials in: ${w}`).not.toContain("TESTUSER:hunter2");
    }
  });

  it("AUTH_FAILED: prints code/message/hint on stderr, and still starts", async () => {
    const server = scaffold([failingLogonRoute(401, "not authorized")]);
    const srv = await build(cfg(), server);

    await expect(srv.start()).resolves.toBeUndefined();

    const failureLine = warnings.find((w) => w.includes("STARTUP PROBE FAILED"));
    expect(failureLine, `no failure banner in: ${JSON.stringify(warnings)}`).toBeDefined();
    expect(failureLine).toContain("AUTH_FAILED");
    expect(failureLine).toContain("Could not connect to");
    expect(failureLine).toMatch(/fails_to_user_lock|Credentials were rejected/);
    const readyLine = warnings.find((w) => w.includes("ready on stdio"));
    expect(readyLine, "must STILL print ready on stdio").toBeDefined();
    expect(readyLine).toContain("NOT CONNECTED");
  });

  it("SYSTEM_UNAVAILABLE: prints code/message/hint on stderr, and still starts", async () => {
    const server = scaffold([failingLogonRoute(500, "upstream unavailable")]);
    const srv = await build(cfg(), server);

    await expect(srv.start()).resolves.toBeUndefined();

    const failureLine = warnings.find((w) => w.includes("STARTUP PROBE FAILED"));
    expect(failureLine, `no failure banner in: ${JSON.stringify(warnings)}`).toBeDefined();
    expect(failureLine).toContain("SYSTEM_UNAVAILABLE");
    expect(failureLine).toMatch(/down or overloaded|do NOT change the password/);
    const readyLine = warnings.find((w) => w.includes("ready on stdio"));
    expect(readyLine, "must STILL print ready on stdio").toBeDefined();
    expect(readyLine).toContain("NOT CONNECTED");
  });

  it("CONNECT_FAILED: prints code/message/hint on stderr, and still starts", async () => {
    const server = scaffold();
    const srv = await build(cfg(), server, {
      httpClient: new NetworkFailureHttpClient(server.client(), LOGON_PATH),
    });

    await expect(srv.start()).resolves.toBeUndefined();

    const failureLine = warnings.find((w) => w.includes("STARTUP PROBE FAILED"));
    expect(failureLine, `no failure banner in: ${JSON.stringify(warnings)}`).toBeDefined();
    expect(failureLine).toContain("CONNECT_FAILED");
    expect(failureLine).toMatch(/host was never reached|ECONNREFUSED/);
    const readyLine = warnings.find((w) => w.includes("ready on stdio"));
    expect(readyLine, "must STILL print ready on stdio").toBeDefined();
    expect(readyLine).toContain("NOT CONNECTED");
  });

  it("banner never leaks the URL's userinfo credentials, on any failure kind", async () => {
    for (const server of [
      scaffold([failingLogonRoute(401, "not authorized")]),
      scaffold([failingLogonRoute(500, "upstream unavailable")]),
    ]) {
      warnings = [];
      const srv = await build(cfg(), server);
      await srv.start();
      for (const w of warnings) {
        expect(w, `leaked credentials in: ${w}`).not.toContain("hunter2");
        expect(w, `leaked credentials in: ${w}`).not.toContain("TESTUSER:hunter2");
      }
    }
  });

  it("ABAP_STARTUP_PROBE=false: skips the probe entirely — no connect attempt, unchanged banner", async () => {
    const server = scaffold([failingLogonRoute(401, "not authorized")]);
    const srv = await build(cfg({ startupProbe: false }), server);

    await srv.start();

    expect(logonRequests(server), "no logon attempt at all when the probe is disabled").toHaveLength(0);
    expect(warnings.some((w) => w.includes("STARTUP PROBE"))).toBe(false);
    expect(warnings.some((w) => w.includes("connected — authenticated to"))).toBe(false);
    const readyLine = warnings.find((w) => w.includes("ready on stdio"));
    expect(readyLine).toBeDefined();
    expect(readyLine).not.toContain("NOT CONNECTED");
  });

  it("a probe rejection that is not an AbapError is still reduced to a displayable, non-throwing shape", () => {
    // See `describeStartupProbeFailure`'s doc comment (src/server.ts): the
    // real ADT stack cannot manufacture this shape any more (`connect()`'s
    // terminal fallback always classifies and wraps in an `AbapError`), so
    // this is tested directly against the helper `start()` calls in its
    // `catch` — proving the defensive branch itself, not dead code.
    expect(describeStartupProbeFailure("boom")).toEqual({ code: "UNKNOWN", message: expect.any(String) });
    expect(describeStartupProbeFailure(42)).toEqual({ code: "UNKNOWN", message: expect.any(String) });
    expect(describeStartupProbeFailure(new TypeError("bug"))).toEqual({
      code: "UNKNOWN",
      message: expect.stringContaining("bug"),
    });
    expect(describeStartupProbeFailure(undefined)).toEqual({ code: "UNKNOWN", message: expect.any(String) });
  });
});
