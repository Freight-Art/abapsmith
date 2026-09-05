/**
 * `deleteObject`'s success path pays for a read-back (`verifyObjectDeleted`)
 * before it trusts a resolved DELETE — a `200` there is not proof the object
 * is gone (see test/delete-verification.test.ts). The throw path had no such
 * check: a DELETE that landed and then lost its response (session death,
 * a dropped connection) was translated and rethrown exactly like a DELETE
 * that never reached the server.
 *
 * The probe only fires when the DELETE was issued AND the failure may have
 * landed — a dead session or a response-less transport failure (same
 * predicate as bopf.ts's `attempt`). A real HTTP refusal (403/404/423/...)
 * rules out landing outright, so it rethrows completely unchanged: no
 * probe, no appended hint, no new details keys — that is what the last
 * test below pins.
 *
 * This file drives the real `deleteObject` against the hand-rolled
 * `FakeAdt` idiom test/delete-verification.test.ts's Section B (and
 * test/write-toctou.test.ts, test/write.test.ts) already use, copied in
 * verbatim for the same isolation reason those files give.
 */
import { describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { fakeResponse, lockConflict403, searchResultsXml, sessionTimedOut400 } from "./helpers/fake-adt.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { authorizeMutation, deleteObject, type WriteTarget } from "../src/adt/write.js";
import { isAbapError } from "../src/adt/errors.js";
import { SafetyGate } from "../src/safety.js";

const REPORT = "ZMCP_DEL_THROW";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_del_throw";
const REPORT_SRC = `${REPORT_URI}/source/main`;
const SOURCE = "REPORT zmcp_del_throw.\nWRITE: / 'a'.\n";
const SOURCE_CRLF = SOURCE.replace(/\n/g, "\r\n");
const SEARCH_PATH = "/sap/bc/adt/repository/informationsystem/search";

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

const OBJECT_XML = (name: string, type: string, packageName = "$TMP"): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="${name}" adtcore:type="${type}">` +
  `<adtcore:packageRef adtcore:name="${packageName}"/>` +
  `</adtcore:objectMetadata>`;

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

type Route = (r: Recorded) => HttpClientResponse | undefined;

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body };
    this.calls.push(rec);
    const res = this.route(rec);
    if (!res) throw new Error(`FakeAdt: unrouted request ${label}`);
    return res;
  }
  get verbs(): string[] {
    return this.calls.map((c) => (c.qs._action ? c.qs._action : c.method));
  }
}

const cfg = (): Config =>
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
  return undefined;
}

function objectMetaRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.method !== "GET" || r.qs._action || r.url.endsWith("/source/main")) return undefined;
  if (r.url === REPORT_URI) return resp(200, OBJECT_XML(REPORT, "PROG/P"), OK_XML);
  return undefined;
}

async function connected(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r) ?? objectMetaRoute(r));
  // The system-role probe is fail-closed (see test/system-role-probe-guard.test.ts):
  // an unanswered `/datapreview/freestyle` locks writes out with a verdict
  // `ABAP_ALLOW_WRITE` can't override. `routeSystemRoleProbe` still forwards the
  // request to `adt` first, so `adt.calls` sees it like any other request.
  const conn = new AbapConnection(cfg(), {
    httpClient: routeSystemRoleProbe(adt, { answer: "nonproductive" }),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

const DEFAULT_GATE = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
const authDelete = (conn: AbapConnection, target: WriteTarget) =>
  authorizeMutation(conn, DEFAULT_GATE, "delete", target);

/**
 * Common shape for the three "DELETE was issued, then something died"
 * scenarios: pre-lock read, LOCK, post-lock read all succeed; the DELETE
 * itself answers a dead session; a THIRD read of the source (the
 * disclosure path's own `verifyObjectDeleted` probe, since the DELETE threw
 * before the success path's own verification could run) decides the outcome.
 */
function routeDeleteThenDie(thirdReadAndAfter: Route): Route {
  let sourceReads = 0;
  return (r) => {
    if (r.url === REPORT_SRC && r.method === "GET") {
      sourceReads += 1;
      if (sourceReads <= 2) return resp(200, SOURCE_CRLF, OK_TEXT);
      return thirdReadAndAfter(r);
    }
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
    if (r.method === "DELETE") return sessionTimedOut400();
    // The session is already dead by the time `session.unlockAll()` runs its
    // retries — a real server answers the same session-timeout shape here,
    // not silence. Routing it keeps this a well-formed 400 (SESSION_DEAD),
    // not an unrouted throw the transport's transient breaker would count
    // as a network failure and use to shed the disclosure probe's own requests.
    if (r.qs._action === "UNLOCK") return sessionTimedOut400();
    // Anything else (the disclosure probe's repository-search fallback, in
    // particular) is this scenario's own to answer.
    return thirdReadAndAfter(r);
  };
}

describe("deleteObject — the throw path also pays for the read-back", () => {
  it("DELETE throws and the object is absent on read-back: original code kept, hint discloses the delete may have landed", async () => {
    const { conn } = await connected(routeDeleteThenDie((r) => (r.url === REPORT_SRC ? resp(404, "", OK_XML) : undefined)));

    let caught: unknown;
    try {
      await deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: REPORT }));
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect(isAbapError(caught)).toBe(true);
    if (!isAbapError(caught)) throw new Error("unreachable");
    expect(caught.code).toBe("SESSION_DEAD");
    expect(caught.message).toBe("The ABAP session no longer exists (400 Session Timed Out).");
    expect(caught.hint).toMatch(/appears to have been deleted/i);
    expect(caught.hint).toMatch(/no longer readable/i);
    expect(caught.hint).toMatch(/re-read first/i);
    // The original hint survives, disclosure is appended, not substituted.
    expect(caught.hint).toMatch(/retry the operation once/i);
    expect(caught.details.postFailureVerification).toBe("confirmed-absent");
  });

  it("DELETE throws and the object is still readable: hint says nothing was deleted", async () => {
    const ref = searchResultsXml([{ name: REPORT, type: "PROG/P", uri: REPORT_URI }]);
    const { conn } = await connected(
      routeDeleteThenDie((r) => {
        if (r.url === REPORT_SRC) return resp(200, SOURCE_CRLF, OK_TEXT);
        if (r.url.includes(SEARCH_PATH)) return resp(200, ref, OK_XML);
        return undefined;
      }),
    );

    let caught: unknown;
    try {
      await deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: REPORT }));
    } catch (e) {
      caught = e;
    }

    expect(isAbapError(caught)).toBe(true);
    if (!isAbapError(caught)) throw new Error("unreachable");
    expect(caught.code).toBe("SESSION_DEAD");
    expect(caught.hint).toMatch(/still there/i);
    expect(caught.hint).toMatch(/nothing was deleted/i);
    expect(caught.details.postFailureVerification).toBe("confirmed");
  });

  it("verification inconclusive: hint says it could not be settled", async () => {
    const { conn } = await connected(
      routeDeleteThenDie((r) => {
        if (r.url === REPORT_SRC) return resp(500, "<exc:exception/>", OK_XML);
        if (r.url.includes(SEARCH_PATH)) return resp(200, searchResultsXml([]), OK_XML);
        return undefined;
      }),
    );

    let caught: unknown;
    try {
      await deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: REPORT }));
    } catch (e) {
      caught = e;
    }

    expect(isAbapError(caught)).toBe(true);
    if (!isAbapError(caught)) throw new Error("unreachable");
    expect(caught.code).toBe("SESSION_DEAD");
    expect(caught.hint).toMatch(/could not be settled/i);
    expect(caught.hint).toMatch(/re-read/i);
    expect(caught.details.postFailureVerification).toBe("indeterminate");
  });

  it("a failure BEFORE the DELETE is issued (lock conflict) rethrows completely unchanged — no disclosure text, no verification probe", async () => {
    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") {
        sourceReads += 1;
        return resp(200, SOURCE_CRLF, OK_TEXT);
      }
      if (r.qs._action === "LOCK") {
        return lockConflict403({ user: "OTHERDEV", objectName: REPORT });
      }
      return undefined;
    });

    let caught: unknown;
    try {
      await deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: REPORT }));
    } catch (e) {
      caught = e;
    }

    expect(isAbapError(caught)).toBe(true);
    if (!isAbapError(caught)) throw new Error("unreachable");
    expect(caught.code).toBe("LOCKED");
    expect(caught.details.postFailureVerification).toBeUndefined();
    expect(caught.hint ?? "").not.toMatch(/appears to have been deleted/i);
    expect(caught.hint ?? "").not.toMatch(/nothing was deleted/i);
    expect(caught.hint ?? "").not.toMatch(/could not be settled/i);
    // No DELETE was ever issued, and the disclosure probe never fired either
    // (that probe would GET REPORT_SRC a second time; only the pre-lock read happened).
    expect(adt.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(sourceReads).toBe(1);
  });

  it("DELETE throws with a real refusal (403) after being issued: no probe fires, error passed through unchanged", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") return resp(200, SOURCE_CRLF, OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.method === "DELETE") return resp(403, "<exc:exception/>", OK_XML);
      return undefined;
    });

    let caught: unknown;
    try {
      await deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: REPORT }));
    } catch (e) {
      caught = e;
    }

    expect(isAbapError(caught)).toBe(true);
    if (!isAbapError(caught)) throw new Error("unreachable");
    // A real HTTP response (a genuine refusal, not a lost one) rules out the
    // DELETE landing — nothing to disclose, so no probe, no appended hint,
    // no new details keys. Exactly the pre-existing verb sequence, unchanged.
    expect(caught.code).not.toBe("SESSION_DEAD");
    expect(caught.details.postFailureVerification).toBeUndefined();
    expect(caught.hint ?? "").not.toMatch(/appears to have been deleted/i);
    expect(caught.hint ?? "").not.toMatch(/still there/i);
    expect(caught.hint ?? "").not.toMatch(/could not be settled/i);
    expect(adt.verbs).toEqual(["GET", "GET", "LOCK", "GET", "DELETE", "UNLOCK"]);
  });
});
