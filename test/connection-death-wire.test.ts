/**
 * Session death, end to end, through the transport shape production actually
 * uses.
 *
 * ## Why this file exists
 *
 * `AbapConnection` has two observation points for a response —
 * `noteWireResponse` on the resolve path and `noteWireThrow` on the throw path.
 * They are NOT two halves of a symmetric pair. `AxiosHttpClient`
 * (`abap-adt-api/build/AxiosHttpClient.js`) installs no `validateStatus`, so
 * axios' default `status >= 200 && status < 300` stands and it REJECTS every
 * non-2xx response. Both shapes of session death are non-2xx:
 *
 *  - `400` with `x-sap-icm-err-id: ICMENOSESSION` — passive expiry, answered by
 *    the ICM before the ABAP stack is involved at all;
 *  - `500` short-dump page — the session destroyed by an ABAP dump.
 *
 * So in production, `noteWireThrow` is the ONLY reachable death detector.
 * `noteWireResponse` is entered directly only for a 2xx, and a 2xx is never a
 * death.
 *
 * That asymmetry was invisible to the suite for as long as the fakes RESOLVED
 * non-2xx responses. An auditor mutated `noteWireThrow` to drop 5xx silently
 * and the mutant survived all 2186 tests, because the one test covering the 500
 * dump drove it through a path production cannot take. This file closes that
 * hole with the shared `FakeAdtServer` in `transportErrors: "throw"` mode: a
 * real `HttpClientException`, a real `AdtHTTP`, a real `GuardedHttpClient`, a
 * real `AbapConnection` — nothing hand-rolled between the status code and
 * `isDead`.
 *
 * Entirely offline. Nothing here addresses a real SAP system.
 *
 * `test/connection-liveness.test.ts` covers the same property at unit scale
 * against a smaller fake; the duplication is deliberate, because a single test
 * for the only production-reachable death path is a single point of failure.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import {
  FakeAdtServer,
  __resetFakeAdtCounters,
  fakeResponse,
  type FakeRoute,
} from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError } from "../src/adt/errors.js";

// ------------------------------------------------------------------ fixtures ---

/**
 * The non-productive probe, answered as a ROUTE (the fake has no
 * `catchAll` here, so an unrouted probe would be recorded as a violation). It
 * must keep answering after a revival logon, because `connect()` re-runs the
 * probe on every logon.
 */
const systemRoleRoute: FakeRoute = (r) =>
  r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined;

const PROBE_URI = "/sap/bc/adt/programs/programs/zmcp_probe_rep";

/**
 * The ICM page a short dump produces. A reconstruction of the markup; the three
 * content strings are the captured ones (`extractDumpShortText`).
 */
const DUMP_PAGE = `<!DOCTYPE html><html><head><title>Application Server Error</title>
<style>body{font-family:Arial}</style></head><body>
<h1>500 Internal Server Error</h1>
<p>Division by zero</p>
<table><tr><td>Server time:</td><td>2026-07-31 13:02:57</td></tr></table>
</body></html>`;

const dumpRoute: FakeRoute = (r) =>
  r.path === PROBE_URI ? fakeResponse(500, DUMP_PAGE, { "content-type": "text/html" }) : undefined;

/** An ordinary application 500 — an `exc:exception`, emphatically NOT a dump. */
const APP_ERROR_ROUTE: FakeRoute = (r) =>
  r.path === PROBE_URI
    ? fakeResponse(500, "<exc:exception><type id='CX_SY_ZERODIVIDE'/></exc:exception>", {
        "content-type": "application/xml",
      })
    : undefined;

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    // Fixture 087 carries client 001 -> CCCATEGORY "C", so the probe can PROVE
    // non-productive rather than fail closed.
    client: "001",
    readOnly: false,
  });

// ----------------------------------------------------------------- lifecycle ---

const openConnections: AbapConnection[] = [];

const listenerCounts = (): Record<string, number> => ({
  SIGINT: process.listenerCount("SIGINT"),
  SIGTERM: process.listenerCount("SIGTERM"),
  beforeExit: process.listenerCount("beforeExit"),
});

let listenersBefore = listenerCounts();

beforeEach(() => {
  __resetFakeAdtCounters();
  listenersBefore = listenerCounts();
});

afterEach(() => {
  for (const conn of openConnections.splice(0)) conn.dispose();
  expect(listenerCounts()).toEqual(listenersBefore);
});

/**
 * A connected `AbapConnection` whose transport is a `FakeAdtServer` session and
 * whose non-2xx responses are RAISED, exactly as axios raises them.
 */
async function wired(
  options: { routes?: readonly FakeRoute[]; transportErrors?: "resolve" | "throw" } = {},
): Promise<{ conn: AbapConnection; server: FakeAdtServer; sessionId: string }> {
  const server = new FakeAdtServer({
    transportErrors: options.transportErrors ?? "throw",
    routes: [systemRoleRoute, ...(options.routes ?? [])],
  });
  const client = server.client("s1");
  const conn = new AbapConnection(cfg(), {
    httpClient: client,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  openConnections.push(conn);
  await conn.connect();
  return { conn, server, sessionId: client.session.id };
}

// ===========================================================================

describe("the fake raises non-2xx the way the real transport raises it", () => {
  it("throws a real HttpClientException carrying the response", async () => {
    // The premise every test below rests on. If this ever goes green while the
    // fake resolves, the coverage underneath is theatre.
    const server = new FakeAdtServer({ transportErrors: "throw", routes: [systemRoleRoute] });
    const client = server.client("s1");
    // A ROUTED non-2xx. An UNROUTED request raises `FakeAdtProtocolError`
    // before `deliver` is reached, which would prove nothing about this mode.
    server.expire(client.session.id);

    const e = await client.request({ url: "/sap/bc/adt/discovery" }).then(
      () => undefined,
      (err: unknown) => err,
    );

    // The real class, not a look-alike: `abap-adt-api` narrows with
    // `isHttpClientException` before reading `.response`, and an impostor is
    // downgraded to a generic status-500 `AdtErrorException` with the status,
    // headers and body all lost.
    expect(e).toBeInstanceOf(HttpClientException);
    expect((e as HttpClientException).status).toBe(400);
    expect((e as HttpClientException).response?.status).toBe(400);
    expect((e as HttpClientException).response?.headers["x-sap-icm-err-id"]).toBe("ICMENOSESSION");
  });

  it("still resolves 2xx, and still resolves everything under the default setting", async () => {
    const throwing = new FakeAdtServer({ transportErrors: "throw", routes: [systemRoleRoute] });
    const ok = await throwing.client("s1").request({ url: "/sap/bc/adt/discovery" });
    expect(ok.status).toBe(200);

    // `"resolve"` is the default, so no existing suite changes behaviour.
    const legacy = new FakeAdtServer({ routes: [systemRoleRoute] });
    const legacyClient = legacy.client("s1");
    legacy.expire(legacyClient.session.id);
    const resolved = await legacyClient.request({ url: "/sap/bc/adt/discovery" });
    expect(resolved.status).toBe(400);
    expect(resolved.headers["x-sap-icm-err-id"]).toBe("ICMENOSESSION");
  });
});

describe("passive expiry — the 400 ICMENOSESSION, thrown", () => {
  it("marks the connection dead on the next request", async () => {
    const { conn, server, sessionId } = await wired();
    expect(conn.isDead).toBe(false);
    expect(conn.isConnected).toBe(true);

    // Server-side expiry. The client is not told; it finds out on its next
    // request, which is the whole point.
    server.expire(sessionId);

    const e = await conn.get(PROBE_URI).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(e).toBeDefined();
    expect(conn.isDead).toBe(true);
    expect(conn.deathRecord?.reason).toContain("ICMENOSESSION");
    expect(conn.deathRecord?.reason).toContain("400");
    // A dead session is not a connected one.
    expect(conn.isConnected).toBe(false);
    expect(conn.info().connected).toBe(false);
  });

  it("every later request fails with SESSION_DEAD, and none reaches the wire", async () => {
    const { conn, server, sessionId } = await wired();
    server.expire(sessionId);
    await conn.get(PROBE_URI).catch(() => undefined);
    const callsAfterDeath = server.calls.length;

    for (const call of [
      () => conn.get(PROBE_URI),
      () => conn.post(PROBE_URI),
      () => conn.withStatefulSession(async () => undefined),
    ]) {
      const e = await Promise.resolve()
        .then(call)
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      expect(isAbapError(e) && e.code).toBe("SESSION_DEAD");
    }

    // Death is recorded, never re-confirmed: a synthetic request on a
    // session with an outstanding long poll is head-of-line blocked for that
    // poll's full remaining timeout, so a probe is never cheap.
    expect(server.calls.length).toBe(callsAfterDeath);
  });

  it("does not trip the auth circuit breaker", async () => {
    // If an expired session latched the breaker, one idle timeout would disable
    // the process — the latch is one-way and remembered per credential
    // fingerprint.
    const { conn, server, sessionId } = await wired();
    server.expire(sessionId);
    await conn.get(PROBE_URI).catch(() => undefined);

    expect(conn.isDead).toBe(true);
    const e = await conn.get(PROBE_URI).then(
      () => undefined,
      (err: unknown) => err,
    );
    // SESSION_DEAD, not AUTH_CIRCUIT_OPEN: the breaker outranks death, so if it
    // had latched this would say so.
    expect(isAbapError(e) && e.code).toBe("SESSION_DEAD");
  });
});

describe("short dump — the 500 dump page, thrown", () => {
  it("marks the connection dead and names the dump", async () => {
    // THE regression test for the mutant that survived: a `noteWireThrow` that
    // returns early for `status >= 500` leaves `isDead` false here.
    const { conn } = await wired({ routes: [dumpRoute] });

    const e = await conn.get(PROBE_URI).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(e).toBeDefined();
    expect(conn.isDead).toBe(true);
    expect(conn.deathRecord?.reason).toMatch(/short dump/i);
    expect(conn.deathRecord?.reason).toContain("500");
    expect(conn.isConnected).toBe(false);
  });

  it("an ordinary application 500 is NOT a death", async () => {
    // The classifier must distinguish "the ABAP runtime raised an exception and
    // told you about it in XML" from "the session is gone". Treating every 5xx
    // as death would poison a connection on any failing report.
    const { conn } = await wired({ routes: [APP_ERROR_ROUTE] });

    await conn.get(PROBE_URI).catch(() => undefined);

    expect(conn.isDead).toBe(false);
    expect(conn.isConnected).toBe(true);
  });
});

describe("recovery", () => {
  it("connect() revives a wire-killed connection with a real second logon", async () => {
    // Killed by a DUMP rather than by `expire()`: the fake's `expire` marks a
    // session state permanently gone, so a re-logon on the same handle would
    // keep getting the 400 — a limitation of the fake, not of the appliance,
    // where a new logon mints a new session. The dump kills the connection
    // without poisoning the fake's session, so the revival is observable.
    let dumping = true;
    const oneDump: FakeRoute = (r) => {
      if (r.path !== PROBE_URI) return undefined;
      return dumping
        ? fakeResponse(500, DUMP_PAGE, { "content-type": "text/html" })
        : fakeResponse(200, "<ok/>", { "content-type": "application/xml" });
    };
    const { conn } = await wired({ routes: [oneDump] });

    await conn.get(PROBE_URI).catch(() => undefined);
    expect(conn.isDead).toBe(true);
    const logonsBefore = conn.logonEndpointRequests;

    dumping = false;
    await conn.connect();

    expect(conn.isDead).toBe(false);
    expect(conn.deathRecord).toBeUndefined();
    expect(conn.isConnected).toBe(true);
    expect(conn.logonEndpointRequests).toBe(logonsBefore + 1);
    // And it genuinely works again afterwards.
    await conn.get(PROBE_URI);
    expect(conn.isDead).toBe(false);
  });

  it("onDead fires once, carrying the wire-derived reason", async () => {
    const { conn, server, sessionId } = await wired();
    const seen: string[] = [];
    conn.onDead((r) => seen.push(r.reason));

    server.expire(sessionId);
    await conn.get(PROBE_URI).catch(() => undefined);
    // A second request cannot fire it again — it never reaches the wire, and
    // `markDead` is idempotent regardless.
    await conn.get(PROBE_URI).catch(() => undefined);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("ICMENOSESSION");
  });
});
