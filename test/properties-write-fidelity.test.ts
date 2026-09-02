/**
 * A `TTYP/DA` write carrying `<ttyp:rangeType>ZTMD_E_CARRID</ttyp:rangeType>`
 * came back `activated: true` with no warning, and a read-back showed
 * `<ttyp:rangeType/>` — the server had silently discarded the value. The
 * pre-activation etag gate (test/write-toctou.test.ts) missed this because
 * both the PUT's echo and the independent pre-activation read-back already
 * reflect the dropped value, so the two etags agree with each other even
 * though neither matches what was actually sent.
 *
 * This file covers `discardedDescriptorValues` (src/adt/descriptor-fidelity.ts)
 * directly, and the two sites in src/tools/write.ts that call it: the
 * `activate: true` path (refuses to activate, CHECK_FAILED/VALUE_DISCARDED)
 * and the `activate: false` path (warns in `notes`, does not refuse).
 *
 * Offline only, harness copied from test/write-toctou.test.ts (see that
 * file's own docblock for why it is copied rather than imported).
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
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { abapWrite } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import { discardedDescriptorValues } from "../src/adt/descriptor-fidelity.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Harness, copied verbatim from test/write-toctou.test.ts.
// ---------------------------------------------------------------------------

const resp = (
  status: number,
  body = "",
  headers: Record<string, unknown> = {},
): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

const LOCK_XML = (handle = "H1", isLocal = "X", corrNr = "") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>${isLocal}</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
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
  get labels(): string[] {
    return this.calls.map((c) => c.label);
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
  if (r.url.endsWith("/discovery")) return resp(200, "<discovery/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle"))
    return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

async function connected(
  route: Route,
  config: Config = cfg(),
): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(config, {
    httpClient: adt,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
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

const gate = (): SafetyGate => new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

// ---------------------------------------------------------------------------
// This file's own fixtures.
// ---------------------------------------------------------------------------

const TTYP_NAME = "ZFIXV4_TTYP";
const TTYP_URI = "/sap/bc/adt/ddic/tabletypes/zfixv4_ttyp";

/** A `TTYP/DA` descriptor shaped like the real capture in test/ddic.test.ts's
 *  `TTYP_XML`, parametrised on `<ttyp:rangeType>` — empty (`""`) renders it
 *  self-closing, matching what the reported case's read-back showed. */
const ttypXml = (rangeType: string, initialRowCount = "00000"): string =>
  `<?xml version="1.0" encoding="utf-8"?><ttyp:tableType adtcore:name="${TTYP_NAME}" ` +
  `adtcore:type="TTYP/DA" adtcore:description="probe" ` +
  `xmlns:ttyp="http://www.sap.com/dictionary/tabletype" xmlns:adtcore="http://www.sap.com/adt/core">` +
  `<adtcore:packageRef adtcore:name="$TMP"/>` +
  `<ttyp:rowType><ttyp:typeKind>dictionaryType</ttyp:typeKind><ttyp:typeName>ZFIXV4_STRU</ttyp:typeName>` +
  `<ttyp:builtInType><ttyp:dataType>STRU</ttyp:dataType><ttyp:length>000000</ttyp:length>` +
  `<ttyp:decimals>000000</ttyp:decimals></ttyp:builtInType>` +
  (rangeType ? `<ttyp:rangeType>${rangeType}</ttyp:rangeType>` : `<ttyp:rangeType/>`) +
  `</ttyp:rowType><ttyp:initialRowCount>${initialRowCount}</ttyp:initialRowCount>` +
  `<ttyp:accessType>standard</ttyp:accessType></ttyp:tableType>`;

/**
 * A properties-shape UPDATE that activates pays 5 GETs before this file's
 * pre-activation gate can fire (resolution probe, pre-lock read, post-lock
 * TOCTOU re-read, post-write confirmation read, then the pre-activation
 * `observed` read the VALUE_DISCARDED check reuses) — confirmed against
 * test/write-toctou.test.ts's MSAG/N COST PIN (getCount 4, one less because
 * MSAG/N never activates). `before` serves reads 1-3, `afterWrite` serves
 * everything from read 4 on (including any post-activation re-read, if
 * activation is reached at all).
 */
function toolServer(before: string, afterWrite: string) {
  let reads = 0;
  const route = (r: Recorded): HttpClientResponse | undefined => {
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
  return { route, reads: () => reads };
}

const writeVia = (conn: AbapConnection, source: string, activate = true) =>
  abapWrite(
    conn,
    { object: TTYP_NAME, type: "TTYP/DA", source, activate } as never,
    60_000,
    gate(),
  );

// ---------------------------------------------------------------------------

describe("abapWrite — pre-activation VALUE_DISCARDED gate", () => {
  it("refuses to activate when the server silently drops an element from a properties-shape write", async () => {
    const before = ttypXml("ZTMD_OLD_RANGE");
    const sent = ttypXml("ZTMD_E_CARRID");
    const storedAfterWrite = ttypXml(""); // the server kept everything except rangeType
    const srv = toolServer(before, storedAfterWrite);
    const { conn, adt } = await connected(srv.route);

    const err = await catchErr(writeVia(conn, sent));

    expect(err.code).toBe("CHECK_FAILED");
    expect(err.details.reason).toBe("VALUE_DISCARDED");
    expect(err.details.phase).toBe("pre-activation");
    expect(err.details).toMatchObject({ written: true, activated: false, created: false });
    expect(err.details.journal).toBeUndefined();
    expect(err.message).toContain(`TTYP/DA ${TTYP_NAME}`);
    expect(err.message).toContain("INACTIVE");
    expect(err.message).toContain("ttyp:rangeType");
    expect(err.message).not.toMatch(/syntax check/i);
    expect(err.hint).toMatch(/not a rejection/i);
    expect(err.hint).toMatch(/abap_read/);
    expect(err.hint).toMatch(/abap_activate/);
    expect(err.hint).toMatch(/write journal is off/);

    // Load-bearing: SAP is never asked to activate the object it silently mutilated.
    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(false);
  });

  it("activates normally when the read-back carries every value through unchanged", async () => {
    const before = ttypXml("ZTMD_OLD_RANGE");
    const sent = ttypXml("ZTMD_E_CARRID");
    const srv = toolServer(before, sent); // nothing dropped: read-back === what was sent
    const { conn, adt } = await connected(srv.route);

    const result = await writeVia(conn, sent);

    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(true);
    expect(result.text).toMatch(/changed:\s*true/);
    expect(result.text).not.toMatch(/VALUE_DISCARDED/);
  });

  it("warns instead of refusing on the activate:false path (no activation to retract)", async () => {
    const before = ttypXml("ZTMD_OLD_RANGE");
    const sent = ttypXml("ZTMD_E_CARRID");
    const storedAfterWrite = ttypXml(""); // dropped again, same as the refusal case
    const srv = toolServer(before, storedAfterWrite);
    const { conn, adt } = await connected(srv.route);

    const result = await writeVia(conn, sent, false);

    // Never refused, and never asked SAP to activate (activate:false, same as before).
    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(false);
    expect(result.text).toMatch(/WARNING:.*ttyp:rangeType/s);
  });
});

// ---------------------------------------------------------------------------

describe("discardedDescriptorValues", () => {
  it("reports nothing for an identical sent/stored descriptor", () => {
    const doc = ttypXml("ZTMD_E_CARRID");
    expect(discardedDescriptorValues(doc, doc)).toEqual([]);
  });

  it("does not report a value the server merely normalised (changed but non-empty)", () => {
    const sent = ttypXml("ZTMD_E_CARRID", "0");
    const stored = ttypXml("ZTMD_E_CARRID", "000000");
    expect(discardedDescriptorValues(sent, stored)).toEqual([]);
  });

  it("finds the DOMA/DD fixed-value-text loss shape", () => {
    const sent =
      `<doma:content xmlns:doma="http://www.sap.com/dictionary/domain"><doma:valueInformation><doma:fixValues>` +
      `<doma:fixValue><doma:low>1</doma:low><doma:text>Truck</doma:text></doma:fixValue>` +
      `<doma:fixValue><doma:low>2</doma:low><doma:text>Car</doma:text></doma:fixValue>` +
      `</doma:fixValues></doma:valueInformation></doma:content>`;
    const stored =
      `<doma:content xmlns:doma="http://www.sap.com/dictionary/domain"><doma:valueInformation><doma:fixValues>` +
      `<doma:fixValue><doma:low>1</doma:low><doma:text></doma:text></doma:fixValue>` +
      `<doma:fixValue><doma:low>2</doma:low><doma:text/></doma:fixValue>` +
      `</doma:fixValues></doma:valueInformation></doma:content>`;

    const discarded = discardedDescriptorValues(sent, stored);
    expect(discarded).toEqual([{ element: "doma:text", sent: ["Truck", "Car"], stored: [] }]);
  });

  it("ignores attribute-only differences, and a `>` inside a quoted attribute value doesn't break the scan", () => {
    const sent = `<root attr="a>b"><val>1</val><val>2</val></root>`;
    const stored = `<root attr="c>d"><val>1</val></root>`;

    // Attributes differ (a>b vs c>d) but that is never reported; the `val`
    // leaf discard proves the quoted `>` did not desynchronise the scan —
    // a broken scan would either misparse `val`'s count or throw.
    const discarded = discardedDescriptorValues(sent, stored);
    expect(discarded).toEqual([{ element: "val", sent: ["1", "2"], stored: ["1"] }]);
  });

  it("does not report a self-closing element that is empty on both sides", () => {
    const sent = ttypXml("", "00000");
    const stored = ttypXml("", "00007"); // a genuine change elsewhere, not a discard either
    const discarded = discardedDescriptorValues(sent, stored);
    expect(discarded.find((d) => d.element === "ttyp:rangeType")).toBeUndefined();
    expect(discarded).toEqual([]);
  });
});
