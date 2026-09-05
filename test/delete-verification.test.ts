/**
 * `deleteObject` reported `deleted: true` from a hardcoded literal, the
 * moment the DELETE promise resolved — nothing verified anything. The fix
 * inverts that: a 404 read-back is treated as proof of success, but a 200
 * read-back is never treated as proof of failure on its own — only an
 * independent repository search (or a confirming GET at the bare object
 * URI — for FUGR/FF's 500 read-back, or a blank body under
 * `blankSourceOnAbsence`) can settle what a 200 alone cannot.
 *
 * Two harnesses, matching how the rest of the suite already tests each
 * piece: `verifyObjectDeleted` (src/adt/write-verify.ts) is exercised
 * directly against `FakeAdtServer`, the idiom test/write-verify.test.ts uses
 * for the sibling create-side probes; `deleteObject`'s end-to-end behaviour
 * is exercised against the hand-rolled `FakeAdt` idiom test/write-toctou.test.ts
 * and test/write.test.ts use for the same function's other tests.
 */
import { describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import {
  FakeAdtServer,
  __resetFakeAdtCounters,
  fakeResponse,
  searchResultsXml,
  sessionTimedOut400,
  type FakeObjectRef,
  type FakeRoute,
} from "./helpers/fake-adt.js";
import {
  DATA_PREVIEW_PATH,
  DATAPREVIEW_XML,
  systemRoleProbeResponse,
  T000_NONPRODUCTIVE,
} from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { verifyObjectDeleted } from "../src/adt/write-verify.js";
import { authorizeMutation, deleteObject, type WriteTarget } from "../src/adt/write.js";
import { SafetyGate } from "../src/safety.js";

// ---------------------------------------------------------------------------
// Section A — verifyObjectDeleted, direct against FakeAdtServer.
// ---------------------------------------------------------------------------

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

const systemRoleRoute: FakeRoute = (r) =>
  r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined;

const openConnections: AbapConnection[] = [];

async function wired(
  options: { routes?: readonly FakeRoute[] } = {},
): Promise<{ conn: AbapConnection; server: FakeAdtServer }> {
  __resetFakeAdtCounters();
  const server = new FakeAdtServer({
    transportErrors: "throw",
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
  return { conn, server };
}

const OBJ_NAME = "ZPROPW_DEL";
const EXPECT_TYPE = "PROG/P";
const CONTENT_URI = "/sap/bc/adt/programs/programs/zpropw_del/source/main";
const CONTENT_ACCEPT = "text/plain";
const SEARCH_PATH = "/sap/bc/adt/repository/informationsystem/search";

const verifyOpts = { uri: CONTENT_URI, accept: CONTENT_ACCEPT, objectName: OBJ_NAME, expectType: EXPECT_TYPE };

describe("verifyObjectDeleted — the inversion: a 404 read-back is the success signal", () => {
  it("confirmed-absent on a genuine 404, with no repository search at all (the cheap common case)", async () => {
    const { conn, server } = await wired({
      routes: [(r) => (r.url === CONTENT_URI ? fakeResponse(404, "") : undefined)],
    });

    const result = await verifyObjectDeleted(conn, verifyOpts);

    expect(result.status).toBe("confirmed-absent");
    if (result.status === "confirmed-absent") expect(result.via).toBe("read-back");
    expect(server.callsFor(CONTENT_URI)).toHaveLength(1);
    expect(server.calls.some((c) => c.path === SEARCH_PATH)).toBe(false);
  });

  it("confirmed when the read-back answers 200 AND the repository search agrees the object is still there", async () => {
    const ref: FakeObjectRef = { name: OBJ_NAME, type: EXPECT_TYPE, uri: CONTENT_URI };
    const { conn } = await wired({
      routes: [
        (r) => (r.url === CONTENT_URI ? fakeResponse(200, "REPORT zpropw_del.", { "content-type": "text/plain" }) : undefined),
        (r) => (r.path === SEARCH_PATH ? fakeResponse(200, searchResultsXml([ref]), { "content-type": "application/xml" }) : undefined),
      ],
    });

    const result = await verifyObjectDeleted(conn, verifyOpts);

    expect(result.status).toBe("confirmed");
  });

  it("indeterminate when the read-back answers 200 but the repository search finds nothing — the stale 200 is named in the reason", async () => {
    const { conn } = await wired({
      routes: [
        (r) => (r.url === CONTENT_URI ? fakeResponse(200, "REPORT zpropw_del.", { "content-type": "text/plain" }) : undefined),
        (r) => (r.path === SEARCH_PATH ? fakeResponse(200, searchResultsXml([]), { "content-type": "application/xml" }) : undefined),
      ],
    });

    const result = await verifyObjectDeleted(conn, verifyOpts);

    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason).toMatch(/200/);
      expect(result.reason).toMatch(/stale 200 read-back is not proof the delete failed/);
    }
  });

  it("indeterminate, not confirmed-absent, when the read-back fails for a reason other than not-found and only the search says absent", async () => {
    const { conn } = await wired({
      routes: [
        (r) => (r.url === CONTENT_URI ? fakeResponse(500, "<exc:exception/>", { "content-type": "application/xml" }) : undefined),
        (r) => (r.path === SEARCH_PATH ? fakeResponse(200, searchResultsXml([]), { "content-type": "application/xml" }) : undefined),
      ],
    });

    const result = await verifyObjectDeleted(conn, verifyOpts);

    // Before this fix this was `confirmed-absent` via repository-search: a read-back
    // that never answered plus a zero-hit search is not two probes agreeing
    // absence — a search miss alone is not proof.
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") expect(result.reason).toMatch(/never settled it/);
  });

  it("regression pin: verifyObjectDeleted never resolves confirmed-absent via repository-search alone", async () => {
    const { conn } = await wired({
      routes: [
        (r) => (r.url === CONTENT_URI ? fakeResponse(500, "<exc:exception/>", { "content-type": "application/xml" }) : undefined),
        (r) => (r.path === SEARCH_PATH ? fakeResponse(200, searchResultsXml([]), { "content-type": "application/xml" }) : undefined),
      ],
    });

    const result = await verifyObjectDeleted(conn, verifyOpts);

    const resolvedAsSearchAbsent = result.status === "confirmed-absent" && result.via === "repository-search";
    expect(resolvedAsSearchAbsent).toBe(false);
  });
});

// The confirmed-live envelope shape (same capture absent-source-500.test.ts
// pins): a real ADT exception type, distinct from the bare `<exc:exception/>`
// used above, which parses to no type at all.
const typedFiveHundred = (message = "An exception was raised") =>
  fakeResponse(
    500,
    `<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
      `<namespace id="com.sap.adt"/><type id="ExceptionInternalServerError"/><message lang="EN">${message}</message>` +
      `<localizedMessage lang="EN">${message}</localizedMessage>` +
      `<properties><entry key="ExceptionText">${message}</entry></properties></exc:exception>`,
    { "content-type": "application/xml" },
  );

// FUGR/FF: its content endpoint 500s for an absent module (never 404s) and
// its own name can never come back as a FUGR-kind search hit — the
// type that makes both the object-URI step and the blind-search guard
// observable at all.
const FF_NAME = "ZFG_DEL_FF";
const FF_TYPE = "FUGR/FF";
const FF_OBJ_URI = "/sap/bc/adt/functions/groups/zfg_del/fmodules/zfg_del_ff";
const FF_CONTENT_URI = `${FF_OBJ_URI}/source/main`;
const ffVerifyOpts = { uri: FF_CONTENT_URI, accept: CONTENT_ACCEPT, objectName: FF_NAME, expectType: FF_TYPE };
const zeroHitSearchRoute: FakeRoute = (r) =>
  r.path === SEARCH_PATH ? fakeResponse(200, searchResultsXml([]), { "content-type": "application/xml" }) : undefined;

describe("verifyObjectDeleted — settling FUGR/FF and surviving a dead session", () => {
  it("confirms absence at the bare object URI when the content URI can only ever answer 500", async () => {
    const { conn, server } = await wired({
      routes: [
        (r) => (r.url === FF_CONTENT_URI ? typedFiveHundred() : undefined),
        (r) => (r.url === FF_OBJ_URI ? fakeResponse(404, "") : undefined),
        zeroHitSearchRoute,
      ],
    });

    const result = await verifyObjectDeleted(conn, ffVerifyOpts);

    expect(result.status).toBe("confirmed-absent");
    if (result.status === "confirmed-absent") {
      expect(result.via).toBe("read-back");
      expect(result.uri).toBe(FF_OBJ_URI);
    }
    expect(server.callsFor((r) => r.url === FF_OBJ_URI)).toHaveLength(1);
  });

  it("refuses to trust a blind zero-hit search as absence when the 500 carries no exception type, and names the type", async () => {
    const { conn, server } = await wired({
      routes: [
        (r) => (r.url === FF_CONTENT_URI ? fakeResponse(500, "<exc:exception/>", { "content-type": "application/xml" }) : undefined),
        zeroHitSearchRoute,
      ],
    });

    const result = await verifyObjectDeleted(conn, ffVerifyOpts);

    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") expect(result.reason).toMatch(/FUGR\/FF/);
    expect(server.callsFor((r) => r.url === FF_OBJ_URI)).toHaveLength(0);
  });

  it("reconnects once and re-issues the read-back on a dead session, then trusts the 404", async () => {
    let calls = 0;
    const { conn, server } = await wired({
      routes: [
        (r) => {
          if (r.url !== CONTENT_URI) return undefined;
          calls += 1;
          return calls === 1 ? sessionTimedOut400() : fakeResponse(404, "");
        },
      ],
    });

    const result = await verifyObjectDeleted(conn, verifyOpts);

    expect(result.status).toBe("confirmed-absent");
    if (result.status === "confirmed-absent") expect(result.via).toBe("read-back");
    expect(server.callsFor(CONTENT_URI)).toHaveLength(2);
  });

  it("reports a server that never answered as having said nothing, not as having said 404", async () => {
    const { conn } = await wired({
      routes: [
        (r) => (r.url === FF_CONTENT_URI ? typedFiveHundred() : undefined),
        (r) => (r.url === FF_OBJ_URI ? sessionTimedOut400() : undefined),
        zeroHitSearchRoute,
      ],
    });

    const result = await verifyObjectDeleted(conn, ffVerifyOpts);

    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason).toMatch(/did not answer at all/);
      expect(result.reason).not.toMatch(/did not answer 404/);
    }
  });
});

// ---------------------------------------------------------------------------
// Section B — deleteObject end to end, against the hand-rolled FakeAdt idiom
// test/write-toctou.test.ts and test/write.test.ts already use for this
// function. Copied in verbatim (not imported) for the same reason
// test/write-toctou.test.ts gives for its own copy: keep this file's scope
// isolated so the two can't drift on anything both need without noticing.
// ---------------------------------------------------------------------------

const REPORT = "ZMCP_DEL_TEST";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_del_test";
const REPORT_SRC = `${REPORT_URI}/source/main`;
const SOURCE = "REPORT zmcp_del_test.\nWRITE: / 'a'.\n";
const SOURCE_CRLF = SOURCE.replace(/\n/g, "\r\n");

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

const cfgB = (): Config =>
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
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

function objectMetaRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.method !== "GET" || r.qs._action || r.url.endsWith("/source/main")) return undefined;
  if (r.url === REPORT_URI) return resp(200, OBJECT_XML(REPORT, "PROG/P"), OK_XML);
  return undefined;
}

async function connected(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r) ?? objectMetaRoute(r));
  const conn = new AbapConnection(cfgB(), {
    httpClient: adt,
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

describe("deleteObject — deleted comes from a read-back, not from the DELETE resolving", () => {
  it("deleted: true, verification confirmed-absent, when the post-delete read-back 404s", async () => {
    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") {
        sourceReads += 1;
        if (sourceReads <= 2) return resp(200, SOURCE_CRLF, OK_TEXT);
        return resp(404, "", OK_XML); // the post-delete read-back
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.method === "DELETE") return resp(200, "", {});
      return undefined;
    });

    const res = await deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: REPORT }));

    expect(res.deleted).toBe(true);
    expect(res.verification.status).toBe("confirmed-absent");
    if (res.verification.status === "confirmed-absent") expect(res.verification.via).toBe("read-back");
    // Resolve, pre-lock GET, LOCK, post-lock GET, DELETE, post-delete read-back.
    expect(sourceReads).toBe(3);
  });

  /**
   * The DELETE answers 200, but the object is still readable
   * afterwards AND an independent repository search still finds it — the
   * two probes AGREE the delete did not take. On the pre-fix tree this
   * returned `deleted: true` unconditionally; this is the test that carries
   * the regression.
   */
  it("deleted: false when the DELETE answers 200 but both the read-back and the repository search still see the object", async () => {
    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") {
        sourceReads += 1;
        // Every read, including the one after DELETE, still returns the
        // object — the two-probes-agree shape the regression pin covers.
        return resp(200, SOURCE_CRLF, OK_TEXT);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.method === "DELETE") return resp(200, "", {});
      if (r.url.includes("/repository/informationsystem/search")) {
        const ref: FakeObjectRef = { name: REPORT, type: "PROG/P", uri: REPORT_URI };
        return resp(200, searchResultsXml([ref]), OK_XML);
      }
      return undefined;
    });

    const res = await deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: REPORT }));

    expect(res.deleted).toBe(false);
    expect(res.verification.status).toBe("confirmed");
    expect(adt.verbs).toContain("DELETE");
  });

  it("deleted: \"unverified\" (and does not throw) when neither the read-back nor the repository search can settle it", async () => {
    let sourceReads = 0;
    const { conn } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") {
        sourceReads += 1;
        if (sourceReads <= 2) return resp(200, SOURCE_CRLF, OK_TEXT);
        return resp(500, "<exc:exception/>", OK_XML); // the post-delete read-back fails
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.method === "DELETE") return resp(200, "", {});
      if (r.url.includes("/repository/informationsystem/search")) {
        // A hit under a DIFFERENT type: verifyViaRepositorySearch's own
        // indeterminate branch, not an unrouted-request accident.
        const ref: FakeObjectRef = { name: REPORT, type: "CLAS/OC", uri: "/sap/bc/adt/oo/classes/zmcp_del_test" };
        return resp(200, searchResultsXml([ref]), OK_XML);
      }
      return undefined;
    });

    const res = await deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: REPORT }));

    expect(res.deleted).toBe("unverified");
    expect(res.verification.status).toBe("indeterminate");
  });
});
