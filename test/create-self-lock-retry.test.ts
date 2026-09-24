/**
 * Issue #205: MSAG/N's vendor create POST leaves the server's own enqueue on
 * the new object for the rest of a stateful session, so a LOCK taken right
 * after create inside that same session is refused by the connected user's
 * OWN lock. Two independent fixes, both exercised here offline:
 *
 *   - MSAG/N (`capabilitiesFor("MSAG/N")?.create?.statelessPost === true`)
 *     sends its create POST OUTSIDE the stateful session entirely, before one
 *     is even opened (`src/adt/write.ts`'s `createOutsideSession`).
 *   - A generic one-time retry (`CreateSelfLockRetry`/`isSelfLock`, same
 *     file) covers any OTHER type whose create still runs inside the
 *     session: if the very next LOCK is refused by our own user, the whole
 *     lock→PUT→unlock sequence is retried once in a fresh session, skipping
 *     the create (which already landed). A lock held by a DIFFERENT user is
 *     never retried — that is a real conflict, reported as an orphan create.
 *
 * Entirely offline, same `FakeAdt`/`connected()`/`authWrite()` idiom as
 * test/write.test.ts (redefined locally, per that file's own convention of
 * not sharing this boilerplate across files).
 */
import { afterAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { authorizeMutation, writeObject, type WriteTarget } from "../src/adt/write.js";
import { SafetyGate } from "../src/safety.js";
import { abapWrite } from "../src/tools/write.js";
import { lockConflict403 } from "./helpers/fake-adt.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { useFluidState } from "./helpers/fluid-classic-fake.js";

// ---------------------------------------------------------------------------
// Boilerplate — the same shapes as test/write.test.ts, kept local per that
// file's own convention.
// ---------------------------------------------------------------------------

const DEFAULT_GATE = new SafetyGate({ readOnly: false, allowPackages: ["*"] });

const authWrite = (conn: AbapConnection, target: WriteTarget, gate: SafetyGate = DEFAULT_GATE) =>
  authorizeMutation(conn, gate, "write", target);

const LOCK_XML = (handle = "H1", isLocal = "X", corrNr = "") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>${isLocal}</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">not found</message><properties/></exc:exception>`;

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
  headers?: Record<string, string>;
}

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

type Route = (r: Recorded) => HttpClientResponse | undefined;

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const rec: Recorded = {
      label,
      method,
      url: o.url,
      qs,
      body: o.body,
      headers: o.headers as Record<string, string> | undefined,
    };
    this.calls.push(rec);
    const res = this.route(rec);
    if (!res) throw new Error(`FakeAdt: unrouted request ${label}`);
    return res;
  }
  get labels(): string[] {
    return this.calls.map((c) => c.label);
  }
}

const fluidState = useFluidState();
afterAll(async () => {
  await rm(fluidState.dir(), { recursive: true, force: true });
});

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
    stateDir: fluidState.dir(),
  });

/** Everything `connect()` needs, including the T000 probe; anything else falls through. */
function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

async function connected(route: Route, config: Config = cfg()): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(config, { httpClient: adt, log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

/**
 * The real, flat MSAG/N document shape — each message is its own self-closing
 * `<mc:messages>` element (root's own child), NOT a `<mc:message>` nested one
 * level deeper. `msgs` are appended as siblings, so a two-message document is
 * literally two of these elements back to back.
 */
const msagXml = (
  name: string,
  msgs: Array<{ no: string; text: string }>,
  pkg = "$TMP",
  description = "probe",
): string =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<mc:messageClass xmlns:mc="http://www.sap.com/adt/MessageClass" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" ` +
  `adtcore:type="MSAG/N" adtcore:description="${description}">` +
  `<adtcore:packageRef adtcore:name="${pkg}"/>` +
  msgs.map((m) => `<mc:messages mc:msgno="${m.no}" mc:msgtext="${m.text}"/>`).join("") +
  `</mc:messageClass>`;

// ---------------------------------------------------------------------------

describe("MSAG/N create and the server's own enqueue (#205)", () => {
  it("sends the MSAG/N create POST stateless, then locks, PUTs and unlocks in the stateful session — success, created:true", async () => {
    const MSAG_URI = "/sap/bc/adt/messageclass/zi205_msg1";
    const MSAG_COLLECTION = "/sap/bc/adt/messageclass";
    const xml = msagXml("ZI205_MSG1", [{ no: "001", text: "Test &amp;1" }]);
    const { conn, adt } = await connected((r) => {
      if (r.url === MSAG_URI && r.method === "GET" && !r.qs._action) return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === MSAG_COLLECTION && r.method === "POST") return resp(201, "", {});
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === MSAG_URI && r.method === "PUT") return resp(200, xml, OK_XML);
      return undefined;
    });

    const res = await writeObject(conn, await authWrite(conn, { type: "MSAG/N", name: "ZI205_MSG1" }), {
      source: xml,
    });

    expect(res.created).toBe(true);
    expect(res.createLockRetried).toBeFalsy();
    expect(adt.labels).toEqual([
      `GET ${MSAG_URI}`,
      `POST ${MSAG_COLLECTION}`,
      `LOCK ${MSAG_URI}`,
      `PUT ${MSAG_URI}`,
      `UNLOCK ${MSAG_URI}`,
    ]);

    // The create POST goes out stateless (before the stateful session ever
    // opens); LOCK/PUT/UNLOCK go out inside it. This is the whole fix.
    const post = adt.calls.find((c) => c.method === "POST" && c.url === MSAG_COLLECTION)!;
    expect(post.headers?.["X-sap-adt-sessiontype"]).toBe("stateless");
    for (const call of adt.calls.filter((c) => ["LOCK", "UNLOCK"].includes(c.qs._action ?? ""))) {
      expect(call.headers?.["X-sap-adt-sessiontype"]).toBe("stateful");
    }
    const put = adt.calls.find((c) => c.method === "PUT" && c.url === MSAG_URI)!;
    expect(put.headers?.["X-sap-adt-sessiontype"]).toBe("stateful");
  });

  it("retries the lock once in a fresh session when the first LOCK is refused by the connected user's own enqueue, and says so", async () => {
    // CLAS/OC deliberately, NOT MSAG/N — CLAS/OC has no `statelessPost`, so
    // its create POST runs INSIDE the stateful session and can genuinely
    // collide with the LOCK that follows it. This is the generic retry
    // mechanism #205 also introduced, exercised on a type MSAG/N's own fix
    // does not touch.
    const CLS_URI = "/sap/bc/adt/oo/classes/zi205_slr_cl";
    const CLS_COLLECTION = "/sap/bc/adt/oo/classes";
    const CLS_SRC = `${CLS_URI}/source/main`;
    const src = "CLASS zi205_slr_cl DEFINITION.\nENDCLASS.\n";
    const CLEAN_CHECKRUN = `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`;

    let lockAttempts = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === CLS_URI && r.method === "GET" && !r.qs._action) return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === CLS_COLLECTION && r.method === "POST") return resp(200, "", OK_TEXT);
      if (r.qs._action === "LOCK") {
        lockAttempts += 1;
        return lockAttempts === 1
          ? lockConflict403({ user: "DEVELOPER", objectName: "ZI205_SLR_CL" })
          : resp(200, LOCK_XML(), OK_XML);
      }
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === CLS_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url.includes("/checkruns")) return resp(200, CLEAN_CHECKRUN, OK_XML);
      return undefined;
    });

    // abapWrite, not writeObject directly: "and says so" is a note
    // src/tools/write.ts adds when `written.createLockRetried` is true —
    // that text only exists at this layer.
    const result = await abapWrite(
      conn,
      { object: "ZI205_SLR_CL", type: "CLAS/OC", source: src, activate: false },
      20_000,
      DEFAULT_GATE,
    );

    expect(result.text).toMatch(/created:\s*true/);
    expect(result.text).toMatch(/retried once in a fresh session/);
    expect(result.text).toMatch(/#205/);

    // Not an exact `adt.labels` sequence: `withStatefulSession`'s cleanup
    // drops the ABAP session (an extra GET to /compatibility/graph, already
    // answered by `baseRoute`) whenever a lock conflict's blocking user is
    // the connected user — which is exactly this scenario. Count/filter
    // assertions are what actually matters and are immune to that noise.
    expect(adt.calls.filter((c) => c.method === "POST" && c.url === CLS_COLLECTION)).toHaveLength(1);
    expect(adt.calls.filter((c) => c.qs._action === "LOCK")).toHaveLength(2);
    expect(adt.calls.filter((c) => c.method === "PUT" && c.url === CLS_SRC)).toHaveLength(1);
    expect(adt.calls.filter((c) => c.qs._action === "UNLOCK")).toHaveLength(1);
  });

  it("does not retry a lock held by another user: LOCKED, created:true, one LOCK", async () => {
    const CLS_URI = "/sap/bc/adt/oo/classes/zi205_olk_cl";
    const CLS_COLLECTION = "/sap/bc/adt/oo/classes";
    const CLS_SRC = `${CLS_URI}/source/main`;
    const src = "CLASS zi205_olk_cl DEFINITION.\nENDCLASS.\n";

    const { conn, adt } = await connected((r) => {
      if (r.url === CLS_URI && r.method === "GET" && !r.qs._action) return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === CLS_COLLECTION && r.method === "POST") return resp(200, "", OK_TEXT);
      if (r.qs._action === "LOCK") return lockConflict403({ user: "OTHERDEV", objectName: "ZI205_OLK_CL" });
      // reportCreateOrphan's verification read-back: a non-blank body at the
      // source endpoint is enough to confirm the class WAS created.
      if (r.url === CLS_SRC && r.method === "GET") return resp(200, src, OK_TEXT);
      return undefined;
    });

    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "CLAS/OC", name: "ZI205_OLK_CL" }), { source: src }),
    );

    expect(e.code).toBe("LOCKED");
    expect(e.details.created).toBe(true);
    expect(e.message).toMatch(/WAS created/);
    expect(adt.labels).toEqual([
      `GET ${CLS_URI}`,
      `POST ${CLS_COLLECTION}`,
      `LOCK ${CLS_URI}`,
      `GET ${CLS_SRC}`,
    ]);
    expect(adt.calls.some((c) => c.qs._action === "UNLOCK")).toBe(false);
  });

  it('a second write of an existing message class takes the update path: created:false, no create POST, not LOCKED', async () => {
    const MSAG_URI = "/sap/bc/adt/messageclass/zi205_msg2";
    const before = msagXml("ZI205_MSG2", [{ no: "001", text: "Test &amp;1" }], "$TMP", "probe");
    const after = msagXml("ZI205_MSG2", [{ no: "001", text: "Test &amp;1" }], "$TMP", "probe updated");
    let current = before;
    const { conn, adt } = await connected((r) => {
      if (r.url === MSAG_URI && r.method === "GET") return resp(200, current, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === MSAG_URI && r.method === "PUT") {
        current = after;
        return resp(200, after, OK_XML);
      }
      return undefined;
    });

    const res = await writeObject(conn, await authWrite(conn, { type: "MSAG/N", name: "ZI205_MSG2" }), {
      source: after,
    });

    expect(res.created).toBe(false);
    expect(adt.calls.some((c) => c.method === "POST" && !c.qs._action)).toBe(false);
    // `writeObject` resolving at all (rather than throwing a LOCKED
    // AbapError) is itself the proof that the LOCK was not refused.
  });

  it("adding message 002 to an existing message class reads back both", async () => {
    const MSAG_URI = "/sap/bc/adt/messageclass/zi205_msg3";
    const before = msagXml("ZI205_MSG3", [{ no: "001", text: "Test &amp;1" }]);
    const after = msagXml("ZI205_MSG3", [
      { no: "001", text: "Test &amp;1" },
      { no: "002", text: "Test &amp;2" },
    ]);
    let current = before;
    const { conn, adt } = await connected((r) => {
      if (r.url === MSAG_URI && r.method === "GET") return resp(200, current, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === MSAG_URI && r.method === "PUT") {
        current = after;
        return resp(200, after, OK_XML);
      }
      return undefined;
    });

    const res = await writeObject(conn, await authWrite(conn, { type: "MSAG/N", name: "ZI205_MSG3" }), {
      source: after,
    });

    expect(res.created).toBe(false);
    expect(res.changed).toBe(true);
    expect(res.normalisedSource).toContain('mc:msgno="001"');
    expect(res.normalisedSource).toContain('mc:msgno="002"');
    expect(adt.calls.some((c) => c.method === "POST" && !c.qs._action)).toBe(false);

    // Fallback (per this test's assignment): MSAG/N is NOT among the
    // `mode:"update"`-capable bridge types (VIEW/DV, TRAN/T, SHLP/DH —
    // src/tools/write-bridge-update.ts's `BRIDGE_UPDATE_TYPES`), so `abap_write
    // mode="update"` on it is refused BAD_INPUT before any network call.
    const { conn: conn2, adt: adt2 } = await connected(() => undefined);
    const e = await catchErr(
      abapWrite(
        conn2,
        { object: "ZI205_MSG3", type: "MSAG/N", mode: "update", source: after },
        20_000,
        DEFAULT_GATE,
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(adt2.calls).toHaveLength(0);
  });
});
