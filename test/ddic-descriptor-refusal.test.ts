/**
 * Behavioural RED PROOF for the pre-send DDIC descriptor guard
 * wired into `abapWrite` (src/tools/write.ts). Drives `abapWrite` end to end
 * against an offline stub, importing only modules that already exist on the
 * base commit (`src/tools/write.js` and friends) — never
 * `../src/adt/ddic-payload.js`, which does not exist there.
 *
 * Cases 1/2/4 route LOCK/PUT/UNLOCK to what the appliance actually does, so
 * a base-commit run reaches the wire and fails on what the PRODUCT does
 * (accepts a corrupt payload, or forwards SAP's raw rejection unchanged) —
 * not on an under-specified stub. On head the pre-send guard refuses before
 * any of those routes are ever reached, which is exactly what the `PUT`/
 * `LOCK` call assertions below are checking. Case 3 is a regression guard
 * and passes on both.
 *
 * Harness copied from test/properties-write-fidelity.test.ts (itself copied
 * from test/write-toctou.test.ts) — no network, no live appliance.
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
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Harness, copied from test/properties-write-fidelity.test.ts.
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

const DTEL_NAME = "ZFIX137_DTEL";
const DTEL_URI = "/sap/bc/adt/ddic/dataelements/zfix137_dtel";
const TTYP_NAME = "ZFIX137_TTYP";
const TTYP_URI = "/sap/bc/adt/ddic/tabletypes/zfix137_ttyp";
const DOMA_NAME = "ZFIX137_DOMA";
const DOMA_URI = "/sap/bc/adt/ddic/domains/zfix137_doma";

const WRONG_TTYP_NS = "http://www.sap.com/adt/dictionary/tabletypes";
const CORRECT_TTYP_NS = "http://www.sap.com/dictionary/tabletype";

/**
 * A DTEL/DE silent-corruption shape: the inner element inherits the
 * root's own "blue" prefix/namespace instead of being bound to the
 * dataElement's distinct namespace. Same failure class as the live-observed
 * case — which explicitly binds `xmlns:dtel` to a wrong URI on the inner
 * element — but a different mechanism; that variant is covered in
 * test/ddic-descriptor-shape.test.ts. On the real appliance this shape is
 * ACCEPTED (ok:true, created:true, activated:true) and silently produces a
 * data element with no type (`abap.(0)`, length 0).
 */
function dtelSilentCorruption(name: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?><blue:wbobj ` +
    `xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel" xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:name="${name}" adtcore:type="DTEL/DE" adtcore:description="probe" ` +
    `adtcore:masterLanguage="EN" adtcore:language="EN">` +
    `<adtcore:packageRef adtcore:name="$TMP"/>` +
    `<blue:dataElement><blue:typeKind>domain</blue:typeKind><blue:typeName>ZDOM_EXAMPLE</blue:typeName>` +
    `</blue:dataElement></blue:wbobj>`
  );
}

/** A real observed wrong guess at the TTYP/DA root namespace. */
function ttypWrongNamespace(name: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?><ttyp:tableType xmlns:ttyp="${WRONG_TTYP_NS}" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" adtcore:type="TTYP/DA" ` +
    `adtcore:description="probe"><adtcore:packageRef adtcore:name="$TMP"/>` +
    `<ttyp:rowType><ttyp:typeKind>dictionaryType</ttyp:typeKind><ttyp:typeName>ZS_EXAMPLE</ttyp:typeName>` +
    `</ttyp:rowType></ttyp:tableType>`
  );
}

/** A TTYP/DA payload with the correct root identity — must pass the new guard unchanged. */
function ttypCorrect(name: string, rowTypeName: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?><ttyp:tableType xmlns:ttyp="${CORRECT_TTYP_NS}" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" adtcore:type="TTYP/DA" ` +
    `adtcore:description="probe"><adtcore:packageRef adtcore:name="$TMP"/>` +
    `<ttyp:rowType><ttyp:typeKind>dictionaryType</ttyp:typeKind><ttyp:typeName>${rowTypeName}</ttyp:typeName>` +
    `<ttyp:builtInType><ttyp:dataType>STRU</ttyp:dataType><ttyp:length>000000</ttyp:length>` +
    `<ttyp:decimals>000000</ttyp:decimals></ttyp:builtInType></ttyp:rowType>` +
    `<ttyp:initialRowCount>00000</ttyp:initialRowCount><ttyp:accessType>standard</ttyp:accessType>` +
    `</ttyp:tableType>`
  );
}

function domaCorrect(name: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?><doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" adtcore:type="DOMA/DD" ` +
    `adtcore:description="probe" adtcore:masterLanguage="EN"><adtcore:packageRef adtcore:name="$TMP"/>` +
    `<doma:content><doma:typeInformation><doma:datatype>CHAR</doma:datatype><doma:length>000010</doma:length>` +
    `<doma:decimals>000000</doma:decimals></doma:typeInformation></doma:content></doma:domain>`
  );
}

/** GET response body for an EXISTING object: just enough for resolveWriteTarget to read a package. */
const existingObjectBody = () =>
  resp(200, `<x:root xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:packageRef adtcore:name="$TMP"/></x:root>`, OK_XML);

/** SAP's own communication-framework error envelope, same shape as its live captures. */
const sapEnvelope = (type: string, message: string) =>
  `<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
  `<namespace id="com.sap.adt"/><type id="${type}"/><message lang="EN">${message}</message>` +
  `<localizedMessage lang="EN">${message}</localizedMessage>` +
  `<properties><entry key="ExceptionText">${message}</entry></properties></exc:exception>`;

const writeVia = (conn: AbapConnection, name: string, type: string, source: string, activate = false) =>
  abapWrite(conn, { object: name, type, source, activate } as never, 60_000, gate());

// ---------------------------------------------------------------------------

describe("abapWrite — pre-send DDIC descriptor guard", () => {
  it("REFUSES the DTEL/DE silent-corruption shape before anything is sent (highest value)", async () => {
    // LOCK/PUT/UNLOCK route to success here — on the real appliance this
    // payload IS accepted (that's the bug). The base-commit run must reach
    // that accepting wire and get back "ok, no error", not an unrouted-stub
    // throw, for the PUT/LOCK-zero-calls assertions below to mean anything.
    const route: Route = (r) => {
      if (r.url === DTEL_URI && r.method === "GET") return existingObjectBody();
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === DTEL_URI && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    };
    const { conn, adt } = await connected(route);

    const err = await catchErr(writeVia(conn, DTEL_NAME, "DTEL/DE", dtelSilentCorruption(DTEL_NAME)));

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toMatch(/dataElement/);
    expect(typeof err.details.ddicSkeleton).toBe("string");
    expect((err.details.ddicSkeleton as string).length).toBeGreaterThan(0);

    // Load-bearing: this is a PRE-SEND guard, not a post-hoc complaint —
    // nothing beyond the one resolution GET reached the wire.
    expect(adt.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(adt.calls.some((c) => c.method === "POST")).toBe(false);
    expect(adt.calls.some((c) => c.qs._action === "LOCK")).toBe(false);
  });

  it("REFUSES a wrong root namespace on TTYP/DA and names the correct URI", async () => {
    // The appliance rejects this one, so a faithful base-commit run must
    // reach the PUT and get SAP's own root-element complaint back — not an
    // unrouted-stub throw — reproducing the original complaint: SAP's
    // raw message with no skeleton/guidance attached.
    const sapMessage =
      `Wrong root element {${WRONG_TTYP_NS}}tableType, expected {${CORRECT_TTYP_NS}}tableType`;
    const route: Route = (r) => {
      if (r.url === TTYP_URI && r.method === "GET") return existingObjectBody();
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === TTYP_URI && r.method === "PUT") {
        return resp(400, sapEnvelope("someBadInputException", sapMessage), OK_XML);
      }
      return undefined;
    };
    const { conn, adt } = await connected(route);

    const err = await catchErr(writeVia(conn, TTYP_NAME, "TTYP/DA", ttypWrongNamespace(TTYP_NAME)));

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain(CORRECT_TTYP_NS);
    expect(typeof err.details.ddicSkeleton).toBe("string");
    const skeleton = err.details.ddicSkeleton as string;
    expect(skeleton.length).toBeGreaterThan(0);
    expect(skeleton).toContain("ttyp:tableType");
    expect(skeleton).toContain(CORRECT_TTYP_NS);

    expect(adt.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("still writes a TTYP/DA payload with the correct root identity, bytes unchanged (regression guard)", async () => {
    const sent = ttypCorrect(TTYP_NAME, "ZFIX137_STRU");
    const route: Route = (r) => {
      if (r.url === TTYP_URI && r.method === "GET") return existingObjectBody();
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === TTYP_URI && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    };
    const { conn, adt } = await connected(route);

    await writeVia(conn, TTYP_NAME, "TTYP/DA", sent, false);

    const put = adt.calls.find((c) => c.url === TTYP_URI && c.method === "PUT");
    expect(put).toBeDefined();
    expect(put?.body).toBe(sent);
  });

  it("attaches a ddicSkeleton hint to a genuine server rejection, keeping SAP's message verbatim", async () => {
    const sapMessage = "Element doma:datatype is missing";
    const route: Route = (r) => {
      if (r.url === DOMA_URI && r.method === "GET") return existingObjectBody();
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === DOMA_URI && r.method === "PUT") {
        return resp(400, sapEnvelope("someBadInputException", sapMessage), OK_XML);
      }
      return undefined;
    };
    const { conn } = await connected(route);

    const err = await catchErr(writeVia(conn, DOMA_NAME, "DOMA/DD", domaCorrect(DOMA_NAME)));

    expect(err.message).toContain(sapMessage);
    expect(typeof err.details.ddicSkeleton).toBe("string");
    const skeleton = err.details.ddicSkeleton as string;
    expect(skeleton.length).toBeGreaterThan(0);
    expect(skeleton).toContain("doma:domain");
  });
});
