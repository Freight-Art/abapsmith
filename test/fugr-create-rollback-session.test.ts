/**
 * Issue #203, end to end through `abapWrite`: a FUGR/FF (function module)
 * create whose content PUT is rejected must roll the empty create back AND
 * drop the stateful session it ran in — otherwise the vendor client's stale
 * `sap-contextid` survives into the NEXT stateless call, which the server
 * answers `ICMENOSESSION`, wrongly marking the connection dead.
 *
 * Three scenarios, one connection carried across all of them:
 *  1. create Z_AS_203 in group ZAS_FG203 ($TMP) → PUT rejected → rollback
 *     DELETE → `conn.dropSession()`. Surfaced as `CHECK_FAILED`,
 *     `details.created === true`, `details.rolledBack === true`, message
 *     contains both the server's own rejection text and "was deleted again".
 *  2. A second `abapWrite` on the SAME connection, corrected source,
 *     succeeds — the drop from (1) means the next stateless GET does not
 *     get misread as a dead session.
 *  3. Same as (2), but this time the second write's first stateless GET
 *     (the module existence probe) meets one `ICMENOSESSION` itself —
 *     outside any stateful session, so per the sliding-window contract
 *     (test/logon-ceiling-window.test.ts) that recovers with one re-logon
 *     and one resend, not a dead connection.
 *
 * No `transport` argument is passed to `abapWrite` — $TMP is not
 * transportable, so `preflightCorr` returns before any
 * `/cts/transportchecks` call (see `src/adt/write.ts`); nothing here needs
 * a `SessionTransport`.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection, type ConnectionOptions } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { abapWrite } from "../src/tools/write.js";
import { isAbapError } from "../src/adt/errors.js";
import { SafetyGate } from "../src/safety.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Offline transport — same shape as test/logon-ceiling-window.test.ts: the
// fake REJECTS every non-2xx exactly as the real axios transport does, so
// the throw-carrying path production actually takes gets exercised.
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

const ICMENOSESSION_HEADERS = {
  "content-type": "text/html",
  "x-sap-icm-err-id": "ICMENOSESSION",
  "sap-err-id": "ICMENOSESSION",
  connection: "close",
};
const SESSION_GONE_PAGE = `<!DOCTYPE html><html><head><title>Application Server Error</title></head>
<body><h1>400 Session timed out</h1></body></html>`;
const ICMENOSESSION_RESP = () => resp(400, SESSION_GONE_PAGE, ICMENOSESSION_HEADERS);

const LOCK_XML = (handle = "LOCKHANDLEA") =>
  `<?xml version="1.0" encoding="utf-8"?>
<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>
  <LOCK_HANDLE>${handle}</LOCK_HANDLE>
  <CORRNR/><CORRUSER/><CORRTEXT/>
  <IS_LOCAL>X</IS_LOCAL>
  <IS_LINK_UP/><MODIFICATION_SUPPORT/><SCOPE_MESSAGES/>
</DATA></asx:values></asx:abap>`;

/** The ADT communication-framework error envelope — same shape as test/absent-source-500.test.ts's `envelope`. */
const exceptionXml = (type: string, message: string) =>
  `<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
  `<namespace id="com.sap.adt"/><type id="${type}"/><message lang="EN">${message}</message>` +
  `<localizedMessage lang="EN">${message}</localizedMessage><properties/></exc:exception>`;

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
  get graphGets(): number {
    return this.calls.filter((c) => c.url.includes("/compatibility/graph")).length;
  }
}

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "ABAPSMITH",
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

function tracked(opts: Omit<ConnectionOptions, "breaker"> = {}): AbapConnection {
  const conn = new AbapConnection(cfg(), { breaker: new AuthCircuitBreaker(), ...opts });
  openConnections.push(conn);
  return conn;
}

afterEach(() => {
  for (const conn of openConnections.splice(0)) conn.dispose();
});

async function connected(route: (r: Recorded) => HttpClientResponse): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = tracked({ httpClient: adt, log: () => {} });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

// ---------------------------------------------------------------------------
// Fixtures — built inline (no live-captured XML), shaped like
// test/fixtures/live-captured/984/985 but for ZAS_FG203/Z_AS_203 in $TMP.
// ---------------------------------------------------------------------------

const GROUP_NAME = "ZAS_FG203";
const MODULE_NAME = "Z_AS_203";
const OBJECT_REF = `${GROUP_NAME}/${MODULE_NAME}`;
const GROUP_URI = "/sap/bc/adt/functions/groups/zas_fg203";
const MODULE_URI = `${GROUP_URI}/fmodules/z_as_203`;
const MODULE_SRC = `${MODULE_URI}/source/main`;
const CREATE_URI = `${GROUP_URI}/fmodules`;

const SOURCE_BAD = `FUNCTION z_as_203.\n* comment block that the server rejects\nENDFUNCTION.\n`;
const SOURCE_GOOD = `FUNCTION z_as_203.\nENDFUNCTION.\n`;

const REJECT_MESSAGE = "Parameter comment blocks are not allowed";
const PUT_REJECTED = () =>
  resp(400, exceptionXml("ExceptionResourceScanDuringSaveFailure", REJECT_MESSAGE), OK_XML);

const MODULE_404 = () =>
  resp(404, exceptionXml("ExceptionResourceNotFound", `Function module ${MODULE_NAME} does not exist`), OK_XML);

/** Group already exists, parented in $TMP — same shape as fixture 985, packageRef substituted. */
const FGROUP_TMP_XML =
  `<?xml version="1.0" encoding="utf-8"?><group:abapFunctionGroup group:lockedByEditor="false" ` +
  `abapsource:sourceUri="source/main" adtcore:responsible="ABAPSMITH" adtcore:masterLanguage="EN" ` +
  `adtcore:masterSystem="A4H" adtcore:name="${GROUP_NAME}" adtcore:type="FUGR/F" ` +
  `adtcore:version="active" adtcore:changedBy="ABAPSMITH" adtcore:createdBy="ABAPSMITH" ` +
  `adtcore:description="Function group ${GROUP_NAME}" adtcore:language="EN" ` +
  `xmlns:group="http://www.sap.com/adt/functions/groups" xmlns:abapsource="http://www.sap.com/adt/abapsource" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core">` +
  `<adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/%24tmp" adtcore:type="DEVC/K" adtcore:name="$TMP"/>` +
  `</group:abapFunctionGroup>`;

const CLEAN_CHECKRUN = `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`;

const gate = () => new SafetyGate({ readOnly: false, allowPackages: ["$TMP"], allowTransports: ["auto"] });

/** The create/lock/put/unlock happy path used by scenarios 2 and 3 once the module is (re)created. */
function creationRoutes(sourceAnswer: () => HttpClientResponse) {
  return (r: Recorded): HttpClientResponse | undefined => {
    if (r.url === GROUP_URI && r.method === "GET") return resp(200, FGROUP_TMP_XML, OK_XML);
    if (r.url === CREATE_URI && r.method === "POST") return resp(201, "", OK_TEXT);
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === MODULE_SRC && r.method === "PUT") return sourceAnswer();
    if (r.url === MODULE_URI && r.method === "DELETE") return resp(200, "", OK_TEXT);
    if (r.url.includes("/checkruns")) return resp(200, CLEAN_CHECKRUN, OK_XML);
    return undefined;
  };
}

describe("#203: FUGR/FF create + rejected PUT rolls back AND drops the session", () => {
  it("first write: create → PUT rejected → rollback DELETE → dropSession; CHECK_FAILED with created/rolledBack", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === MODULE_URI && r.method === "GET") return MODULE_404();
      return creationRoutes(PUT_REJECTED)(r) ?? resp(404, "", OK_TEXT);
    });

    let thrown: unknown;
    try {
      await abapWrite(
        conn,
        { object: OBJECT_REF, type: "FUGR/FF", source: SOURCE_BAD, activate: false },
        20_000,
        gate(),
      );
    } catch (e) {
      thrown = e;
    }

    expect(isAbapError(thrown)).toBe(true);
    if (isAbapError(thrown)) {
      expect(thrown.code).toBe("CHECK_FAILED");
      expect(thrown.message).toContain(REJECT_MESSAGE);
      expect(thrown.message).toContain("was deleted again");
      expect(thrown.details.created).toBe(true);
      expect(thrown.details.rolledBack).toBe(true);
    }
    expect(conn.isDead).toBe(false);

    // Wire order: create, lock, PUT (rejected), unlock, a FRESH lock for the
    // rollback DELETE, the DELETE itself, then dropSession's stateless GET.
    const createIdx = adt.calls.findIndex((c) => c.url === CREATE_URI && c.method === "POST");
    const putIdx = adt.calls.findIndex((c) => c.url === MODULE_SRC && c.method === "PUT");
    const deleteIdx = adt.calls.findIndex((c) => c.url === MODULE_URI && c.method === "DELETE");
    const dropIdx = adt.calls.findIndex((c) => c.url.includes("/compatibility/graph"));
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(putIdx).toBeGreaterThan(createIdx);
    expect(deleteIdx).toBeGreaterThan(putIdx);
    expect(dropIdx).toBeGreaterThan(deleteIdx);
    expect(adt.calls.filter((c) => c.url === MODULE_URI && c.method === "DELETE")).toHaveLength(1);
    expect(adt.graphGets).toBe(1);
  });

  it("second write on the SAME connection, corrected source, succeeds — the drop kept the next stateless call from reading ICMENOSESSION", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === MODULE_URI && r.method === "GET") return MODULE_404();
      return creationRoutes(PUT_REJECTED)(r) ?? resp(404, "", OK_TEXT);
    });

    let firstThrown: unknown;
    try {
      await abapWrite(
        conn,
        { object: OBJECT_REF, type: "FUGR/FF", source: SOURCE_BAD, activate: false },
        20_000,
        gate(),
      );
    } catch (e) {
      firstThrown = e;
    }
    expect(isAbapError(firstThrown)).toBe(true);
    expect(conn.isDead).toBe(false);
    const graphGetsAfterDrop = adt.graphGets;

    // Rewire the fake: the module is gone again (rolled back), so the second
    // write recreates it — this time the PUT succeeds.
    adt.route = (r) => {
      if (r.url === MODULE_URI && r.method === "GET") return MODULE_404();
      return creationRoutes(() => resp(200, "", OK_TEXT))(r) ?? resp(404, "", OK_TEXT);
    };

    const result = await abapWrite(
      conn,
      { object: OBJECT_REF, type: "FUGR/FF", source: SOURCE_GOOD, activate: false },
      20_000,
      gate(),
    );

    expect(result.text).toMatch(/^created: true$/m);
    expect(conn.isDead).toBe(false);
    // No extra logon: the second write's first stateless GET (module probe)
    // was answered directly, no re-logon needed.
    expect(adt.graphGets).toBe(graphGetsAfterDrop);
  });

  it("second write survives one ICMENOSESSION on its first stateless GET: one re-logon, one resend, still succeeds", async () => {
    let moduleGetAttempts = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === MODULE_URI && r.method === "GET") return MODULE_404();
      return creationRoutes(PUT_REJECTED)(r) ?? resp(404, "", OK_TEXT);
    });

    let firstThrown: unknown;
    try {
      await abapWrite(
        conn,
        { object: OBJECT_REF, type: "FUGR/FF", source: SOURCE_BAD, activate: false },
        20_000,
        gate(),
      );
    } catch (e) {
      firstThrown = e;
    }
    expect(isAbapError(firstThrown)).toBe(true);
    const graphGetsAfterDrop = adt.graphGets;

    // Rewire: the module probe GET answers ICMENOSESSION exactly once, then
    // 404 (still absent) on the resend — everything after that is the same
    // happy path as scenario 2, this time with a successful PUT.
    adt.route = (r) => {
      const base = baseRoute(r);
      if (base) return base;
      if (r.url === MODULE_URI && r.method === "GET") {
        moduleGetAttempts += 1;
        if (moduleGetAttempts === 1) return ICMENOSESSION_RESP();
        return MODULE_404();
      }
      return creationRoutes(() => resp(200, "", OK_TEXT))(r) ?? resp(404, "", OK_TEXT);
    };

    const result = await abapWrite(
      conn,
      { object: OBJECT_REF, type: "FUGR/FF", source: SOURCE_GOOD, activate: false },
      20_000,
      gate(),
    );

    expect(result.text).toMatch(/^created: true$/m);
    expect(conn.isDead).toBe(false);
    expect(moduleGetAttempts).toBe(2);
    // One extra graph GET: the re-logon the ICMENOSESSION recovery performs
    // outside any stateful session (see test/logon-ceiling-window.test.ts).
    expect(adt.graphGets).toBe(graphGetsAfterDrop + 1);
  });
});
