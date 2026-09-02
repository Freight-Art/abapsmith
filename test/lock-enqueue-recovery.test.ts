/**
 * A LOCK request can strand a server-side enqueue even when it
 * FAILS: the live incident was an ADT gateway intermittently answering a
 * non-ADT HTML `400` "Service cannot be reached" page for a LOCK that SAP
 * had, in fact, already taken. Because `StatefulSession.locks` only gains an
 * entry once `lockDefault`/`lockWithAccept` RESOLVE, a failed LOCK left no
 * ledger entry — so `unlockAll()` found nothing, `leakedLocks` stayed empty,
 * and `withStatefulSession()`'s `finally` never dropped the session. The
 * `sap-contextid` survived and the enqueue it held stayed live for the rest
 * of the process, blocked by the caller's own now-gone session.
 *
 * `StatefulSession.suspectedEnqueues` (session.ts) and the widened drop guard
 * in `withStatefulSession()` (connection.ts) are what this file pins.
 *
 * Harness: the offline fake-`HttpClient` idiom
 * `test/connection-liveness.test.ts` uses for its session-death tests — a real
 * `AbapConnection` + real `StatefulSession` over a wire double that throws
 * exactly the way `axios` does for a non-2xx status, so `translateAdtError`
 * runs unmodified, not a double standing in for it.
 */
import { afterEach, describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection, type ConnectionOptions } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

const PROG_URI = "/sap/bc/adt/programs/programs/zmcp_probe_rep";

const LOCK_XML = (handle = "LOCKHANDLEA") =>
  `<?xml version="1.0" encoding="utf-8"?>
<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>
  <LOCK_HANDLE>${handle}</LOCK_HANDLE>
  <CORRNR/><CORRUSER/><CORRTEXT/>
  <IS_LOCAL>X</IS_LOCAL>
  <IS_LINK_UP/><MODIFICATION_SUPPORT/><SCOPE_MESSAGES/>
</DATA></asx:values></asx:abap>`;

/** Same envelope as a real LOCK success, minus the one field that matters. */
const LOCK_XML_NO_HANDLE = `<?xml version="1.0" encoding="utf-8"?>
<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>
  <CORRNR/><CORRUSER/><CORRTEXT/>
  <IS_LOCAL>X</IS_LOCAL>
  <IS_LINK_UP/><MODIFICATION_SUPPORT/><SCOPE_MESSAGES/>
</DATA></asx:values></asx:abap>`;

/** `403 ExceptionResourceNoAccess` — translates to `LOCKED`. */
const LOCK_CONFLICT_XML = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceNoAccess"/>
  <message lang="EN">User DEVELOPER is currently editing ZMCP_PROBE_REP</message>
</exc:exception>`;

/**
 * `403 ExceptionResourceNoAccess` with the T100 `properties` block populated,
 * naming a blocking user — unlike `LOCK_CONFLICT_XML` above (message text
 * only, no `<properties>`), this is what a real ADT envelope carries and is
 * what `details.blockingUser` is actually extracted from. `blockingUser`
 * here equals `writableCfg()`'s `user` ("DEVELOPER") — the self-block case.
 */
const LOCK_CONFLICT_SELF_XML = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceNoAccess"/>
  <message lang="EN">User DEVELOPER is currently editing ZMCP_PROBE_REP</message>
  <properties>
    <entry key="T100KEY-ID">EU</entry>
    <entry key="T100KEY-NO">510</entry>
    <entry key="T100KEY-V1">DEVELOPER</entry>
    <entry key="T100KEY-V2">ZMCP_PROBE_REP</entry>
  </properties>
</exc:exception>`;

/** Same as `LOCK_CONFLICT_SELF_XML` but the blocking user is genuinely someone else. */
const LOCK_CONFLICT_OTHER_XML = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceNoAccess"/>
  <message lang="EN">User OTHERDEV is currently editing ZMCP_PROBE_REP</message>
  <properties>
    <entry key="T100KEY-ID">EU</entry>
    <entry key="T100KEY-NO">510</entry>
    <entry key="T100KEY-V1">OTHERDEV</entry>
    <entry key="T100KEY-V2">ZMCP_PROBE_REP</entry>
  </properties>
</exc:exception>`;

/** `404 ExceptionResourceNotFound` — translates to `NOT_FOUND`. */
const NOT_FOUND_XML = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceNotFound"/>
  <message lang="EN">Object ZMCP_PROBE_REP does not exist</message>
</exc:exception>`;

/**
 * The incident's exact shape: a gateway-level `400` that is NOT an ADT
 * exception envelope at all — no `exc:exception` root, so the vendor's own
 * parser throws internally and falls back to a generic `AdtHttpException`.
 * `translateAdtError` has no dedicated branch for this and lands in the
 * unclassified `ADT_ERROR` tail — neither `LOCKED` nor `NOT_FOUND`.
 */
const SERVICE_UNREACHABLE_400 = `<html><body><h1>400 Bad Request</h1><p>Service cannot be reached</p></body></html>`;

/** `423 ExceptionResourceInvalidLockHandle` — a genuine, non-leak-excluded UNLOCK failure. */
const INVALID_LOCK_HANDLE_XML = (handle: string) => `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceInvalidLockHandle"/>
  <message lang="EN">Resource PROG ${PROG_URI} is not locked (invalid lock handle: ${handle})</message>
</exc:exception>`;

// ---------------------------------------------------------------------------
// Offline transport — copied idiom from test/connection-liveness.test.ts
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

/** REJECTS every non-2xx the way the real axios-backed transport does. */
class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(public route: (r: Recorded) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body };
    this.calls.push(rec);
    const out = this.route(rec);
    if (out.status < 200 || out.status >= 300) throw axiosLike(o, out);
    return out;
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

async function connected(
  route: (r: Recorded) => HttpClientResponse,
): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = tracked(writableCfg(), { httpClient: adt, log: () => {} });
  await conn.connect();
  return { conn, adt };
}

const GENERIC_OK = (): HttpClientResponse => resp(200, "ok", OK_TEXT);
const DROP_SESSION_LABEL = "GET /sap/bc/adt/compatibility/graph";

// ===========================================================================

describe("a LOCK failure that may have taken an enqueue drops the session", () => {
  it("a LOCK rejected with a non-ADT HTML 400 (ADT_ERROR) causes a session drop", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.qs._action === "LOCK") return resp(400, SERVICE_UNREACHABLE_400, { "content-type": "text/html" });
      return GENERIC_OK();
    });

    const before = adt.labels.length;
    const e = await conn
      .withStatefulSession(async (session) => {
        await session.lock(PROG_URI);
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    // Sanity: the failure really is the unclassified tail, not LOCKED/NOT_FOUND —
    // this is what makes the fixture faithful to the incident, not an accident.
    expect(String((e as { code?: unknown } | undefined)?.code)).toBe("ADT_ERROR");

    const after = adt.labels.slice(before);
    expect(after).toContain(DROP_SESSION_LABEL);
  });

  it("a LOCK answered 200 with no LOCK_HANDLE also causes a session drop", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML_NO_HANDLE, OK_XML);
      return GENERIC_OK();
    });

    const before = adt.labels.length;
    const e = await conn
      .withStatefulSession(async (session) => {
        await session.lock(PROG_URI);
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(String((e as { message?: unknown } | undefined)?.message)).toMatch(/no LOCK_HANDLE/);

    const after = adt.labels.slice(before);
    expect(after).toContain(DROP_SESSION_LABEL);
  });

  it("a LOCK rejected as LOCKED does NOT cause a session drop", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.qs._action === "LOCK") return resp(403, LOCK_CONFLICT_XML, OK_XML);
      return GENERIC_OK();
    });

    const before = adt.labels.length;
    const e = await conn
      .withStatefulSession(async (session) => {
        await session.lock(PROG_URI);
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(String((e as { code?: unknown } | undefined)?.code)).toBe("LOCKED");

    const after = adt.labels.slice(before);
    expect(after).not.toContain(DROP_SESSION_LABEL);
  });

  it("a LOCK rejected as NOT_FOUND does NOT cause a session drop", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.qs._action === "LOCK") return resp(404, NOT_FOUND_XML, OK_XML);
      return GENERIC_OK();
    });

    const before = adt.labels.length;
    const e = await conn
      .withStatefulSession(async (session) => {
        await session.lock(PROG_URI);
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(String((e as { code?: unknown } | undefined)?.code)).toBe("NOT_FOUND");

    const after = adt.labels.slice(before);
    expect(after).not.toContain(DROP_SESSION_LABEL);
  });

  it("a healthy lock -> unlock cycle causes no drop and no extra request", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      return GENERIC_OK();
    });

    const before = adt.labels.length;
    await conn.withStatefulSession(async (session) => {
      await session.lock(PROG_URI);
    });

    // Exactly the LOCK and its matching UNLOCK — nothing else, and in
    // particular no dropSession() round trip pinned onto the healthy path.
    const after = adt.labels.slice(before);
    expect(after).toEqual([`LOCK ${PROG_URI}`, `UNLOCK ${PROG_URI}`]);
  });

  it("the lock-leaked hint leads with the session-discard remedy, not SM12/restart alone", async () => {
    let unlockAttempts = 0;
    const { conn } = await connected((r) => {
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") {
        unlockAttempts++;
        return resp(423, INVALID_LOCK_HANDLE_XML("LOCKHANDLEA"), OK_XML);
      }
      return GENERIC_OK();
    });

    await conn.withStatefulSession(async (session) => {
      await session.lock(PROG_URI);
    });

    // The retry loop genuinely ran and genuinely failed every time — this is
    // a real lock-leaked escalation, not a stub.
    expect(unlockAttempts).toBeGreaterThan(0);

    const leak = conn.lastLeakedLock;
    expect(leak?.details?.["reason"]).toBe("lock-leaked");
    const hint = leak?.hint ?? "";

    // The primary remedy must actually be present and must actually be
    // FIRST — a fix that merely appends "...or the session gets discarded"
    // after an unchanged SM12-first sentence would still fail this.
    const remedyIdx = hint.search(/discards?\b.*sap-contextid|drops? the session|releases? the enqueue/i);
    const sm12Idx = hint.indexOf("SM12");
    expect(remedyIdx, `hint did not mention the session-discard remedy: ${hint}`).toBeGreaterThanOrEqual(0);
    expect(sm12Idx, `hint dropped the SM12 fallback entirely: ${hint}`).toBeGreaterThan(0);
    expect(remedyIdx).toBeLessThan(sm12Idx);
  });
});

describe("a LOCK already held by our own earlier session recovers on close", () => {
  it("LOCKED naming the configured user as blocker causes a session drop", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.qs._action === "LOCK") return resp(403, LOCK_CONFLICT_SELF_XML, OK_XML);
      return GENERIC_OK();
    });

    const before = adt.labels.length;
    const e = await conn
      .withStatefulSession(async (session) => {
        await session.lock(PROG_URI);
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    // Sanity: this really is the self-block shape (LOCKED, blockingUser ===
    // writableCfg().user), not some other path that happens to drop.
    expect(String((e as { code?: unknown } | undefined)?.code)).toBe("LOCKED");
    expect((e as { details?: { blockingUser?: unknown } } | undefined)?.details?.blockingUser).toBe(
      "DEVELOPER",
    );

    const after = adt.labels.slice(before);
    expect(after).toContain(DROP_SESSION_LABEL);
  });

  it("LOCKED naming a DIFFERENT user as blocker does NOT cause a session drop", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.qs._action === "LOCK") return resp(403, LOCK_CONFLICT_OTHER_XML, OK_XML);
      return GENERIC_OK();
    });

    const before = adt.labels.length;
    const e = await conn
      .withStatefulSession(async (session) => {
        await session.lock(PROG_URI);
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(String((e as { code?: unknown } | undefined)?.code)).toBe("LOCKED");
    expect((e as { details?: { blockingUser?: unknown } } | undefined)?.details?.blockingUser).toBe(
      "OTHERDEV",
    );

    // NOTE: this assertion is structurally green on the unmodified base
    // commit too — base never drops for ANY LOCKED failure, self-block or
    // not, so this test cannot be red-on-base by construction. It is kept
    // anyway (asserted on the wire, not merely a comment) because it is the
    // one test in this file that would catch an implementation comparing
    // the wrong field, or dropping unconditionally on any LOCKED regardless
    // of who holds it — a plausible bug this file must guard against even
    // though it can't prove its own necessity against base.
    const after = adt.labels.slice(before);
    expect(after).not.toContain(DROP_SESSION_LABEL);
  });

  it("LOCKED with no blockingUser at all does NOT cause a session drop", async () => {
    const { conn, adt } = await connected((r) => {
      // LOCK_CONFLICT_XML (top of file) has no <properties> block, so
      // `details.blockingUser` is undefined — the T100 tier never fires.
      if (r.qs._action === "LOCK") return resp(403, LOCK_CONFLICT_XML, OK_XML);
      return GENERIC_OK();
    });

    const before = adt.labels.length;
    const e = await conn
      .withStatefulSession(async (session) => {
        await session.lock(PROG_URI);
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(String((e as { code?: unknown } | undefined)?.code)).toBe("LOCKED");
    expect((e as { details?: { blockingUser?: unknown } } | undefined)?.details?.blockingUser).toBeUndefined();

    // Same honest caveat as above: green on base by construction, since base
    // never drops on LOCKED at all. Kept because it pins that the self-block
    // comparison in connection.ts tolerates an absent `blockingUser` rather
    // than e.g. throwing on `.toLowerCase()` of `undefined`.
    const after = adt.labels.slice(before);
    expect(after).not.toContain(DROP_SESSION_LABEL);
  });
});
