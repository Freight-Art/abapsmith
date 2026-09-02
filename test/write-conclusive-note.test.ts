/**
 * The CONCLUSIVE note — `abap_write`'s success response earning the right to
 * say a write is settled, instead of leaving the caller to re-read an object
 * this response already proves landed (measured: 77% of reads in a benchmark
 * leg were redundant read-backs of a write that had already answered).
 *
 * Two building blocks, both in the main write/create branch of `abapWrite`
 * (src/tools/write.ts):
 *
 *  1. The post-activation re-read properties-shape types (DOMA/DD, TTYP/DA,
 *     ENQU/DL) already pay for is also checked for whether its OWN descriptor
 *     reports itself as the active version (`activationFromBody`,
 *     src/adt/write.ts) — `readBackActive`/`readBackPresent`.
 *  2. A `CONCLUSIVE` note fires only when every one of seven conditions
 *     holds; otherwise, if a properties-shape re-read came back non-active,
 *     a distinct "NOT settled" note fires instead — never both.
 *
 * Offline only. Harness copied from test/write-toctou.test.ts / test/
 * properties-write-fidelity.test.ts (see those files' own docblocks for why
 * the harness is copied rather than imported).
 */
import { describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { abapWrite } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Harness
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

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/>` +
  `<MODIFICATION_SUPPORT/></DATA></asx:values></asx:abap>`;

const NOT_FOUND_XML = (name: string) =>
  `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
  `<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>` +
  `<message lang="EN">${name} does not exist</message><properties/></exc:exception>`;

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
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

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

const gate = (): SafetyGate => new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

// ---------------------------------------------------------------------------
// DOMA/DD fixtures — properties-shape, activates, `adtcore:version` is the
// field activation flips (same shape as test/write-toctou.test.ts's copy).
// ---------------------------------------------------------------------------

const DOMA_URI = "/sap/bc/adt/ddic/domains/zfixv4_doma";

const domaXml = (version: string | undefined): string =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZFIXV4_DOMA" ` +
  `adtcore:type="DOMA/DD"${version !== undefined ? ` adtcore:version="${version}"` : ""} adtcore:description="probe">` +
  `<adtcore:packageRef adtcore:name="$TMP"/>` +
  `<doma:typeInformation><doma:datatype>CHAR</doma:datatype>` +
  `<doma:length>10</doma:length></doma:typeInformation>` +
  `</doma:domain>`;

/**
 * A DOMA/DD create: GET 404s until the PUT lands, then answers with
 * `submitted` until activation, after which it answers with `afterActivation`
 * — so the post-activation re-read this suite is about sees genuinely
 * different bytes, not a canonicalisation quirk.
 */
function domaCreateRoute(submitted: string, afterActivation: string): Route {
  let phase: "before-create" | "written" | "activated" = "before-create";
  return (r) => {
    if (r.url === DOMA_URI && r.method === "GET") {
      if (phase === "before-create") return resp(404, NOT_FOUND_XML("ZFIXV4_DOMA"), OK_XML);
      return resp(200, phase === "activated" ? afterActivation : submitted, OK_XML);
    }
    if (r.url === "/sap/bc/adt/ddic/domains" && r.method === "POST") return resp(201, "", {});
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === DOMA_URI && r.method === "PUT") {
      phase = "written";
      return resp(200, submitted, OK_XML);
    }
    if (r.url.includes("/activation")) {
      phase = "activated";
      return resp(200, "", OK_TEXT);
    }
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// TTYP/DA fixture — properties-shape, activates, used for the silent-drop
// (server discards an element on the `activate:false` path) case. Copied
// from test/properties-write-fidelity.test.ts.
// ---------------------------------------------------------------------------

const TTYP_NAME = "ZFIXV4_TTYP";
const TTYP_URI = "/sap/bc/adt/ddic/tabletypes/zfixv4_ttyp";

const ttypXml = (rangeType: string): string =>
  `<?xml version="1.0" encoding="utf-8"?><ttyp:tableType adtcore:name="${TTYP_NAME}" ` +
  `adtcore:type="TTYP/DA" adtcore:description="probe" ` +
  `xmlns:ttyp="http://www.sap.com/dictionary/tabletype" xmlns:adtcore="http://www.sap.com/adt/core">` +
  `<adtcore:packageRef adtcore:name="$TMP"/>` +
  `<ttyp:rowType><ttyp:typeKind>dictionaryType</ttyp:typeKind><ttyp:typeName>ZFIXV4_STRU</ttyp:typeName>` +
  `<ttyp:builtInType><ttyp:dataType>STRU</ttyp:dataType><ttyp:length>000000</ttyp:length>` +
  `<ttyp:decimals>000000</ttyp:decimals></ttyp:builtInType>` +
  (rangeType ? `<ttyp:rangeType>${rangeType}</ttyp:rangeType>` : `<ttyp:rangeType/>`) +
  `</ttyp:rowType><ttyp:initialRowCount>00000</ttyp:initialRowCount>` +
  `<ttyp:accessType>standard</ttyp:accessType></ttyp:tableType>`;

/** `before` serves the first 3 reads (resolve, pre-lock, post-lock TOCTOU); `afterWrite` from read 4 on. */
function ttypUpdateRoute(before: string, afterWrite: string): Route {
  let reads = 0;
  return (r) => {
    if (r.url === TTYP_URI && r.method === "GET") {
      reads += 1;
      return resp(200, reads <= 3 ? before : afterWrite, OK_XML);
    }
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === TTYP_URI && r.method === "PUT") return resp(200, "", OK_TEXT);
    if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// PROG/P fixture — source-shape, used for the "check failed" case (only
// reachable in a success response when `activate:false`, since `activate:
// true` with a failing check throws before this response is built).
// ---------------------------------------------------------------------------

const REPORT = "ZMCP_CONCLUSIVE_REP";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_conclusive_rep";
const REPORT_SRC = `${REPORT_URI}/source/main`;
const SOURCE_A = "REPORT zmcp_conclusive_rep.\nWRITE: / 'a'.\n";
const SOURCE_B = "REPORT zmcp_conclusive_rep.\nWRITE: / 'b'.\n";

const OBJECT_XML = (name: string, type: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="${name}" adtcore:type="${type}">` +
  `<adtcore:packageRef adtcore:name="$TMP"/></adtcore:objectMetadata>`;

const CHECKRUN_ERROR = `<?xml version="1.0" encoding="utf-8"?>
<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun">
  <chkrun:checkReport chkrun:reporter="abapCheckRun" chkrun:triggeringUri="${REPORT_URI}" chkrun:status="processed" chkrun:statusText="">
    <chkrun:checkMessageList>
      <chkrun:checkMessage chkrun:uri="${REPORT_SRC}#start=1,0" chkrun:type="E" chkrun:shortText="Syntax error"/>
    </chkrun:checkMessageList>
  </chkrun:checkReport>
</chkrun:checkRunReports>`;

const CLEAN_CHECKRUN =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`;

function reportUpdateRoute(opts: { checkrun: string }): Route {
  let current = SOURCE_A;
  return (r) => {
    if (r.url === REPORT_URI && r.method === "GET") return resp(200, OBJECT_XML(REPORT, "PROG/P"), OK_XML);
    if (r.url === REPORT_SRC && r.method === "GET") return resp(200, current, OK_TEXT);
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === REPORT_SRC && r.method === "PUT") {
      current = r.body ?? "";
      return resp(200, "", OK_TEXT);
    }
    if (r.url.includes("/checkruns")) return resp(200, opts.checkrun, OK_XML);
    return undefined;
  };
}

/**
 * A source-shape write that checks clean and activates — the path the
 * CONCLUSIVE note's non-read-back clause describes. `exists: false` makes it a
 * create (no pre-write etag to compare); `storedAfterPut` overrides what the
 * pre-activation read-back sees, which is the only lever that can make the
 * "stored source matches the etag reported above" clause untrue.
 */
function reportActivateRoute(opts: { exists: boolean; storedAfterPut?: string }): Route {
  let stored: string | undefined = opts.exists ? SOURCE_A : undefined;
  let written = false;
  return (r) => {
    if (r.url === REPORT_URI && r.method === "GET")
      return !opts.exists && !written
        ? resp(404, NOT_FOUND_XML(REPORT), OK_XML)
        : resp(200, OBJECT_XML(REPORT, "PROG/P"), OK_XML);
    if (r.url === REPORT_SRC && r.method === "GET") {
      if (stored === undefined) return resp(404, NOT_FOUND_XML(REPORT), OK_XML);
      return resp(200, written ? (opts.storedAfterPut ?? stored) : stored, OK_TEXT);
    }
    if (r.url === "/sap/bc/adt/programs/programs" && r.method === "POST") return resp(200, "", {});
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === REPORT_SRC && r.method === "PUT") {
      stored = r.body ?? "";
      written = true;
      return resp(200, "", OK_TEXT);
    }
    if (r.url.includes("/checkruns")) return resp(200, CLEAN_CHECKRUN, OK_XML);
    if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
    return undefined;
  };
}

// ---------------------------------------------------------------------------

describe("abap_write — CONCLUSIVE note", () => {
  it("fires for a clean properties-shape create with an active read-back", async () => {
    const submitted = domaXml("inactive");
    const afterActivation = domaXml("active");
    const { conn } = await connected(domaCreateRoute(submitted, afterActivation));

    const result = await abapWrite(
      conn,
      { object: "ZFIXV4_DOMA", type: "DOMA/DD", package: "$TMP", source: submitted } as never,
      60_000,
      gate(),
    );

    expect(result.text).toMatch(/created:\s*true/);
    expect(result.text).toMatch(
      /CONCLUSIVE: DOMA\/DD ZFIXV4_DOMA is on A4H as written — abapsmith read it back from the server after activation and the server returned it as the active version/,
    );
    expect(result.text).toMatch(/verify:\s*confirmed — read back after activation/);
    // The speculative note is suppressed: CONCLUSIVE already settled this, and
    // the read-back it claims never happened did.
    expect(result.text).not.toMatch(/NOTE: verify: speculative/);
  });

  it("does NOT fire for activate:false (an inactive write is never conclusive)", async () => {
    const submitted = domaXml("inactive");
    // No `/activation` route: if this fired one, the fake's loud unrouted
    // throw would fail the test — stronger proof than asserting afterwards.
    const { conn, adt } = await connected(domaCreateRoute(submitted, submitted));

    const result = await abapWrite(
      conn,
      { object: "ZFIXV4_DOMA", type: "DOMA/DD", package: "$TMP", source: submitted, activate: false } as never,
      60_000,
      gate(),
    );

    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(false);
    expect(result.text).not.toContain("CONCLUSIVE:");
    expect(result.text).toMatch(/activate=false — the object is saved INACTIVE/);
  });

  it("does NOT fire when the check failed", async () => {
    const { conn } = await connected(reportUpdateRoute({ checkrun: CHECKRUN_ERROR }));

    const result = await abapWrite(
      conn,
      { object: REPORT, type: "PROG/P", source: SOURCE_B, activate: false } as never,
      60_000,
      gate(),
    );

    expect(result.text).toMatch(/changed:\s*true/);
    expect(result.text).toMatch(/check:\s*1 error\(s\)/);
    expect(result.text).not.toContain("CONCLUSIVE:");
  });

  it("does NOT fire on a silent-drop warning", async () => {
    const before = ttypXml("ZTMD_OLD_RANGE");
    const sent = ttypXml("ZTMD_E_CARRID");
    const storedAfterWrite = ttypXml(""); // the server kept everything except rangeType
    const { conn } = await connected(ttypUpdateRoute(before, storedAfterWrite));

    const result = await abapWrite(
      conn,
      { object: TTYP_NAME, type: "TTYP/DA", source: sent, activate: false } as never,
      60_000,
      gate(),
    );

    expect(result.text).toMatch(/WARNING:.*ttyp:rangeType/s);
    expect(result.text).not.toContain("CONCLUSIVE:");
  });

  it("the not-active variant fires and suppresses CONCLUSIVE", async () => {
    const submitted = domaXml("inactive");
    // The re-read after activation still reports itself as "inactive" —
    // present, but its own descriptor does not claim to be the active version.
    const { conn } = await connected(domaCreateRoute(submitted, submitted));

    const result = await abapWrite(
      conn,
      { object: "ZFIXV4_DOMA", type: "DOMA/DD", package: "$TMP", source: submitted } as never,
      60_000,
      gate(),
    );

    expect(result.text).not.toContain("CONCLUSIVE:");
    expect(result.text).toMatch(
      /abapsmith read DOMA\/DD ZFIXV4_DOMA back from A4H after activation and the server returned it, so it is present — but the descriptor it returned does not report itself as the active version/,
    );
    expect(result.text).toMatch(/verify:\s*read back after activation — NOT reported active/);
    // Read-back happened, so the speculative note must not offer to do one.
    expect(result.text).not.toMatch(/NOTE: verify: speculative/);
  });
});

/**
 * One test per clause of the source-shape note, each pinned to the condition
 * that establishes it. A clause with no test here is a clause with no evidence.
 */
describe("abap_write — the source-shape CONCLUSIVE clauses are pinned to their evidence", () => {
  const writeReport = (conn: AbapConnection, source: string, exists: boolean) =>
    abapWrite(
      conn,
      { object: REPORT, type: "PROG/P", source, ...(exists ? {} : { package: "$TMP" }) } as never,
      60_000,
      gate(),
    );

  it("an update states the write, the pre-activation read-back, the etag advance and activation — and nothing else", async () => {
    const { conn } = await connected(reportActivateRoute({ exists: true }));

    const result = await writeReport(conn, SOURCE_B, true);

    expect(result.text).toContain(
      `CONCLUSIVE: PROG/P ${REPORT} is on A4H as written — the server accepted the write, a ` +
        "read-back taken before activation confirmed the stored source matches the etag reported " +
        "above, that etag differs from the pre-write one, and activation reported success.",
    );
    // The three claims the code never made. They must not come back.
    expect(result.text).not.toContain("returned the stored object");
    expect(result.text).not.toContain("no element was dropped");
    expect(result.text).not.toContain("the etag advanced");
  });

  it("a create drops the etag clause — `created` short-circuits the comparison, and there is no pre-write etag", async () => {
    const { conn } = await connected(reportActivateRoute({ exists: false }));

    const result = await writeReport(conn, SOURCE_A, false);

    expect(result.text).toMatch(/created:\s*true/);
    expect(result.text).not.toContain("previousEtag:");
    expect(result.text).toContain(
      `CONCLUSIVE: PROG/P ${REPORT} is on A4H as written — the server accepted the write, a ` +
        "read-back taken before activation confirmed the stored source matches the etag reported " +
        "above, and activation reported success.",
    );
    expect(result.text).not.toContain("differs from the pre-write one");
  });

  it("the read-back clause is the pre-activation content gate: divert that read and the write never gets to say it", async () => {
    // Same route, except the server hands back somebody else's source from the
    // read-back taken between the write and the activation.
    const { conn } = await connected(reportActivateRoute({ exists: true, storedAfterPut: SOURCE_A }));

    await expect(writeReport(conn, SOURCE_B, true)).rejects.toMatchObject({
      code: "ETAG_CONFLICT",
      details: { phase: "pre-activation", written: true, activated: false },
    });
  });

  it("CONCLUSIVE suppresses the speculative note — one claim, not two with opposite framing", async () => {
    const { conn } = await connected(reportActivateRoute({ exists: true }));

    const result = await writeReport(conn, SOURCE_B, true);

    expect(result.text).toContain("CONCLUSIVE:");
    // The header still records the mode; only the contradicting NOTE goes.
    expect(result.text).toMatch(/verify:\s*speculative — /);
    expect(result.text).not.toMatch(/NOTE: verify: speculative/);
  });

  it("the header does not tell the caller the object was not read back while CONCLUSIVE says it was", async () => {
    const { conn } = await connected(reportActivateRoute({ exists: true }));

    const result = await writeReport(conn, SOURCE_B, true);

    expect(result.text).toContain("read-back taken before activation confirmed the stored source");
    expect(result.text).not.toContain("speculative (not read back)");
    expect(result.text).toMatch(
      /verify:\s*speculative — matched a read-back taken before activation, not after/,
    );
    // The stronger post-activation claims belong to `readBackActive`, which is
    // false here — this path never re-read the object after activating it.
    expect(result.text).not.toContain("confirmed — read back after activation");
    expect(result.text).not.toContain("read back after activation — NOT reported active");
  });

  it("a create reaches the same header — the contradiction was not update-only", async () => {
    const { conn } = await connected(reportActivateRoute({ exists: false }));

    const result = await writeReport(conn, SOURCE_A, false);

    expect(result.text).toMatch(/created:\s*true/);
    expect(result.text).toContain("CONCLUSIVE:");
    expect(result.text).not.toContain("speculative (not read back)");
    expect(result.text).toMatch(
      /verify:\s*speculative — matched a read-back taken before activation, not after/,
    );
  });
});

describe("abap_write — the speculative note describes what actually happened", () => {
  it("activate:false says nothing was activated, instead of claiming it activated", async () => {
    const { conn, adt } = await connected(reportActivateRoute({ exists: true }));

    const result = await abapWrite(
      conn,
      { object: REPORT, type: "PROG/P", source: SOURCE_B, activate: false } as never,
      60_000,
      gate(),
    );

    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(false);
    expect(result.text).toMatch(/activated:\s*skipped/);
    expect(result.text).toMatch(/activate=false — the object is saved INACTIVE/);
    expect(result.text).toContain(
      "verify: speculative — this write saved without error, and nothing was activated " +
        "(activate=false)",
    );
    expect(result.text).not.toContain("created and activated without error");
    // Nothing was activated, so the advice about activation messages is dropped too.
    expect(result.text).not.toContain('activation messages with type "E"');
  });

  it("activate:false keeps the speculative header — nothing read it back, and no note claims otherwise", async () => {
    const { conn } = await connected(reportActivateRoute({ exists: true }));

    const result = await abapWrite(
      conn,
      { object: REPORT, type: "PROG/P", source: SOURCE_B, activate: false } as never,
      60_000,
      gate(),
    );

    expect(result.text).not.toContain("CONCLUSIVE:");
    expect(result.text).toMatch(/verify:\s*speculative \(not read back\)/);
  });
});
