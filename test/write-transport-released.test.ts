/**
 * The "already released" transport refusal: a session's request gets
 * released out from under it, and a later write into that package used to
 * fall through `classifyCorrNrError` unmatched, landing in
 * `translateAdtError`'s generic catch-all. `classifyCorrNrError` now gives it
 * its own `problem: "released"`, `corrNrFailure` (src/adt/write.ts) turns
 * that into a specific `TRANSPORT_ERROR`, and `noteTransportDead` drops the
 * dead request from the session's `SessionTransport` cache.
 *
 * The write-path PUT's real HTTP status for this wording has never been
 * captured live — only `trDelete`'s DELETE refusal has
 * (`test/fixtures/cts/transport-delete-error-already-released.xml`, a 400).
 * `classifyCorrNrError` accepting 400 as well as 403 for this one pattern is
 * therefore an inference, not a confirmed write-path shape.
 */
import { describe, expect, it, vi } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { authorizeMutation, writeObject, type WriteTarget } from "../src/adt/write.js";
import { classifyCorrNrError, type TrRequirement } from "../src/adt/transports.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { LoadedCtsFixture } from "./helpers/cts-fixtures.js";
import { fakeCtsConnection, loadCtsFixture } from "./helpers/cts-fixtures.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

/** A thrown-fixture step with no captured file behind it — same shape `syntheticThrow` uses in transports-parse.test.ts. */
function syntheticThrow(status: number, statusText: string, body: string): LoadedCtsFixture {
  return {
    meta: {
      method: "POST",
      url: "/synthetic",
      qs: null,
      requestHeaders: {},
      requestBody: null,
      status,
      statusText,
      responseHeaders: { "content-type": "application/xml" },
      threw: true,
      bodyFile: "synthetic",
      bodyBytes: Buffer.byteLength(body, "utf8"),
    },
    body,
  };
}

describe("classifyCorrNrError — the released transport", () => {
  it("maps the captured 'already released (not modifiable)' 400 to problem: released, trkorr extracted", async () => {
    const fixture = loadCtsFixture("transport-delete-error-already-released");
    const { conn } = fakeCtsConnection([fixture]);
    let caught: unknown;
    try {
      await conn.del("/sap/bc/adt/cts/transportrequests/A4HK900121");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(classifyCorrNrError(caught)).toEqual({
      problem: "released",
      trkorr: "A4HK900121",
      message: "Request/task A4HK900121 already released (not modifiable)",
      exceptionType: "ADT_TM_COMMON_EXCEPTION",
    });
  });

  it("maps the other observed spelling, 'Request X is already released', on a 403 too", async () => {
    const body =
      '<?xml version="1.0" encoding="utf-8"?><exc:exception ' +
      'xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">' +
      '<namespace id="com.sap.adt.tm"/><type id="ADT_TM_COMMON_EXCEPTION"/>' +
      '<message lang="EN">Request A4HK900199 is already released</message>' +
      '<localizedMessage lang="EN">Request A4HK900199 is already released</localizedMessage>' +
      "<properties/></exc:exception>";
    const { conn } = fakeCtsConnection([syntheticThrow(403, "Forbidden", body)]);
    let caught: unknown;
    try {
      await conn.post("/sap/bc/adt/programs/programs", { qs: { corrNr: "A4HK900199" } });
    } catch (e) {
      caught = e;
    }
    expect(classifyCorrNrError(caught)).toEqual({
      problem: "released",
      trkorr: "A4HK900199",
      message: "Request A4HK900199 is already released",
      exceptionType: "ADT_TM_COMMON_EXCEPTION",
    });
  });

  it("still returns not-found / not-a-change-request for the existing 403 wordings, and an unmatched 400 keeps returning undefined", async () => {
    const { conn: notFoundConn } = fakeCtsConnection([
      loadCtsFixture("create-object-error-corrnr-not-found"),
    ]);
    let notFoundCaught: unknown;
    try {
      await notFoundConn.post("/sap/bc/adt/programs/programs", { qs: { corrNr: "A4HK999999" } });
    } catch (e) {
      notFoundCaught = e;
    }
    expect(classifyCorrNrError(notFoundCaught)?.problem).toBe("not-found");

    const { conn: notARequestConn } = fakeCtsConnection([
      loadCtsFixture("create-object-error-corrnr-not-a-change-request"),
    ]);
    let notARequestCaught: unknown;
    try {
      await notARequestConn.post("/sap/bc/adt/programs/programs", { qs: { corrNr: "A4HK900122" } });
    } catch (e) {
      notARequestCaught = e;
    }
    expect(classifyCorrNrError(notARequestCaught)?.problem).toBe("not-a-change-request");

    // A genuine, unrelated 400 ("contains locked objects") — must not be
    // guessed into "released" just because it shares the status.
    const lockedObjects = loadCtsFixture("transport-delete-error-locked-objects");
    expect(lockedObjects.meta.status).toBe(400);
    const { conn: lockedConn } = fakeCtsConnection([lockedObjects]);
    let lockedCaught: unknown;
    try {
      await lockedConn.del("/sap/bc/adt/cts/transportrequests/A4HK900117");
    } catch (e) {
      lockedCaught = e;
    }
    expect(classifyCorrNrError(lockedCaught)).toBeUndefined();
  });
});

describe("write path: an 'already released' PUT refusal", () => {
  const REPORT = "ZMCP_TEST_REP";
  const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_test_rep";
  const REPORT_SRC = `${REPORT_URI}/source/main`;
  const SOURCE_A = "REPORT zmcp_test_rep.\nWRITE: / 'a'.\n";
  const SOURCE_A_CRLF = SOURCE_A.replace(/\n/g, "\r\n");
  const SOURCE_B = "REPORT zmcp_test_rep.\nWRITE: / 'b'.\n";
  const TRKORR = "A4HK900123";

  const resp = (
    status: number,
    body = "",
    headers: Record<string, unknown> = {},
  ): HttpClientResponse => ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

  const OK_TEXT = { "content-type": "text/plain" };
  const OK_XML = { "content-type": "application/xml" };
  const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

  const OBJECT_XML = (name: string, type: string, packageName: string): string =>
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:name="${name}" adtcore:type="${type}">` +
    `<adtcore:packageRef adtcore:name="${packageName}"/>` +
    `</adtcore:objectMetadata>`;

  const LOCK_XML = (handle: string, corrNr: string): string =>
    `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
    `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR><CORRUSER/><CORRTEXT/>` +
    `<IS_LOCAL></IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
    `</DATA></asx:values></asx:abap>`;

  const RELEASED_XML =
    '<?xml version="1.0" encoding="utf-8"?><exc:exception ' +
    'xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">' +
    '<namespace id="com.sap.adt.tm"/><type id="ADT_TM_COMMON_EXCEPTION"/>' +
    `<message lang="EN">Request/task ${TRKORR} already released (not modifiable)</message>` +
    `<localizedMessage lang="EN">Request/task ${TRKORR} already released (not modifiable)</localizedMessage>` +
    "<properties/></exc:exception>";

  interface Recorded {
    method: string;
    url: string;
    qs: Record<string, string>;
  }
  type Route = (r: Recorded) => HttpClientResponse | undefined;

  class FakeAdt implements HttpClient {
    readonly calls: Recorded[] = [];
    constructor(private readonly route: Route) {}
    async request(o: HttpClientOptions): Promise<HttpClientResponse> {
      const method = (o.method ?? "GET").toUpperCase();
      const qs = (o.qs ?? {}) as Record<string, string>;
      const rec: Recorded = { method, url: o.url, qs };
      this.calls.push(rec);
      const res = this.route(rec);
      if (!res) throw new Error(`FakeAdt: unrouted request ${method} ${o.url}`);
      return res;
    }
  }

  /** Everything `connect()` needs before a test's own route ever sees a call. */
  function baseRoute(r: Recorded): HttpClientResponse | undefined {
    if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
    if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
    if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
    if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
    return undefined;
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

  async function connected(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
    const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
    const conn = new AbapConnection(cfg(), {
      httpClient: adt,
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
    await conn.connect();
    adt.calls.length = 0;
    return { conn, adt };
  }

  const fakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
    ({
      uri: REPORT_SRC,
      operation: "U",
      devclass: "ZPKG",
      candidates: [],
      locks: [],
      messages: [],
      checkFailed: false,
      raw: { result: "S", korrflag: "X", recording: "" },
      kind: "transport-required",
      mustSupplyCorrNr: true,
      serverWouldFabricate: false,
      pinnedTo: TRKORR,
      ...overrides,
    }) as unknown as TrRequirement;

  const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
    const e = await p.then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(isAbapError(e)).toBe(true);
    return e as AbapError;
  };

  it("a PUT refused with 'already released' becomes a diagnosed TRANSPORT_ERROR and drops the dead request from the session", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_URI && r.method === "GET")
        return resp(200, OBJECT_XML(REPORT, "PROG/P", "ZPKG"), OK_XML);
      if (r.url === REPORT_SRC && r.method === "GET") return resp(200, SOURCE_A_CRLF, OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H1", TRKORR), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === REPORT_SRC && r.method === "PUT") return resp(400, RELEASED_XML, OK_XML);
      return undefined;
    });
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZPKG"],
      allowTransports: [TRKORR],
    });
    const transport = new SessionTransport({
      allowTransports: [TRKORR],
      cts: { trRequirement: vi.fn(async () => fakeReq()) },
    });
    const invalidate = vi.spyOn(transport, "invalidate");

    const target = await authorizeMutation(conn, gate, "write", {
      type: "PROG/P",
      name: REPORT,
      packageName: "ZPKG",
    } as WriteTarget);
    const e = await catchErr(writeObject(conn, target, { source: SOURCE_B, transport, gate }));

    expect(e.code).toBe("TRANSPORT_ERROR");
    expect(e.message).toContain(TRKORR);
    expect(e.message).toMatch(/was NOT written/);
    expect(e.details.trStatus).toBe("released");
    expect(e.hint).not.toContain("was not recognised by any specific rule here");

    expect(invalidate).toHaveBeenCalledWith(TRKORR, "released");
    expect(adt.calls.some((c) => c.method === "PUT")).toBe(true);
  });
});
