/**
 * Offline: an etag must be a property of the RESOURCE, not of whichever
 * RENDERING a particular read format happened to produce.
 *
 * Measured live (6 of 6 objects tested, TTYP/DA and DOMA/DD): reading one
 * completely unchanged properties-shape DDIC object through
 * `abap_read {object, type}` (the rendered pseudo-DDL path) and through
 * `abap_read {object, type, format: "raw"}` (the raw XML descriptor path)
 * produced two DIFFERENT etags. The cause was that `src/tools/read.ts` used
 * to hash whatever string a given branch happened to have on hand — for
 * DTEL/DOMA/TTYP that was `readDdic`'s rendered pseudo-DDL, not the object's
 * actual wire bytes. `abap_write`'s compare-before-write
 * (`assertEtagMatches` in src/adt/write.ts) hashes the object's raw XML
 * descriptor, so it agreed with `format="raw"` but not with the default
 * read — an agent that read an object the default way and then tried to
 * write it back with `expect_etag` got a false `ETAG_CONFLICT`, on an
 * object nothing had touched, with a hint ("re-read and retry") that could
 * not terminate: re-reading with the same default format reproduced the
 * exact same wrong etag every time.
 *
 * This file proves the fix two ways:
 *
 *   1. `abap_read` alone: every read format of one unchanged object returns
 *      the identical etag (TTYP/DA, DOMA/DD, DTEL/DE — the three
 *      properties-shape types `readDdic` can render at all).
 *   2. End to end: `abap_write`'s own compare-before-write, exercised
 *      through the real `writeObject`/`deleteObject` machinery (the same
 *      `AbapConnection` + fake HTTP transport `test/write.test.ts` uses),
 *      accepts an `expect_etag` taken from EITHER format with no
 *      `ETAG_CONFLICT` — proving the two sides of the fix (what `abap_read`
 *      hands out, what `abap_write` checks against) actually agree, not
 *      just that they agree with themselves.
 *
 * Everything here is offline: part 1 stubs `resolveObject` and hands
 * `abapRead` a bare object with `get`/`adt.*` methods; part 2 uses the real
 * `AbapConnection` class wired to a fake `HttpClient`, exactly like
 * `test/write.test.ts`. No ADT endpoint is contacted.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import type { AbapConnection as AbapConnectionType } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { canonicalEtag } from "../src/adt/write.js";
import { authorizeMutation, deleteObject, NO_JOURNAL, writeObject } from "../src/adt/write.js";
import { SafetyGate } from "../src/safety.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Part 1 — cross-format etag identity, `abapRead` in isolation.
// ---------------------------------------------------------------------------

const stub = { object: {} as ResolvedObject };

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => stub.object,
}));

const { abapRead } = await import("../src/tools/read.js");

function resolved(over: Partial<ResolvedObject>): ResolvedObject {
  return {
    system: "A4H",
    type: "TTYP/DA",
    kind: "TTYP",
    label: "table type",
    name: "ZPROPW_TTYP",
    uri: "/sap/bc/adt/ddic/tabletypes/zpropw_ttyp",
    mode: "ddic",
    activation: "unknown",
    spec: {},
    packageName: "$TMP",
    description: "probe",
    ...over,
  } as unknown as ResolvedObject;
}

describe("abap_read: the etag is a property of the resource, not the rendering", () => {
  it("TTYP/DA: default (pseudo-DDL) read and format=\"raw\" agree, and both equal the raw descriptor's own canonical hash", async () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><ttyp:tableType ' +
      'xmlns:ttyp="http://www.sap.com/dictionary/tabletype" ' +
      'xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZPROPW_TTYP" ' +
      'adtcore:type="TTYP/DA"><ttyp:rowType><ttyp:typeKind>dictionaryType</ttyp:typeKind>' +
      "<ttyp:typeName>ZPROPW_S</ttyp:typeName><ttyp:builtInType><ttyp:dataType>STRU</ttyp:dataType>" +
      "<ttyp:length>000000</ttyp:length><ttyp:decimals>000000</ttyp:decimals></ttyp:builtInType>" +
      "<ttyp:rangeType/></ttyp:rowType><ttyp:accessType>standard</ttyp:accessType>" +
      '<ttyp:primaryKey ttyp:isVisible="true"><ttyp:definition>standard</ttyp:definition>' +
      "<ttyp:kind>nonUnique</ttyp:kind></ttyp:primaryKey></ttyp:tableType>";
    // readTableType (the default-mode renderer) and fetchRawDescriptor (used by
    // format="raw", and now — see src/tools/read.ts's ddic-mode branch — by the
    // default mode's OWN etag computation too) both call `conn.get` with this
    // exact uri/header. One stub answers both call sites identically, which is
    // the point: nothing here special-cases which format is asking.
    const conn = {
      cfg: { sid: "A4H" },
      get: async (uri: string, opts?: { headers?: Record<string, string> }) => {
        expect(uri).toBe("/sap/bc/adt/ddic/tabletypes/zpropw_ttyp");
        expect(opts?.headers?.Accept).toBe("application/*");
        return { body: xml, status: 200, headers: {} };
      },
    } as unknown as AbapConnectionType;
    stub.object = resolved({});

    const byDefault = await abapRead(conn, { object: "ZPROPW_TTYP", type: "TTYP/DA" } as never, 20_000);
    const byRaw = await abapRead(
      conn,
      { object: "ZPROPW_TTYP", type: "TTYP/DA", format: "raw" } as never,
      20_000,
    );

    expect(byDefault.etag).toBe(byRaw.etag);
    expect(byDefault.etag).toBe(canonicalEtag(xml));
    // Not the pseudo-DDL renderer's own hash — the whole bug was that it USED
    // to be exactly that.
    expect(byDefault.etag).not.toBe(canonicalEtag(byDefault.text.split("PSEUDO-DDL ---\n")[1] ?? ""));
  });

  it('DOMA/DD: default read and format="raw" agree, driven purely by conn.get — one GET, no getDomainProperties() involved', async () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" ' +
      'xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZPROPW_DOMA" adtcore:type="DOMA/DD" ' +
      'adtcore:description="probe"><doma:typeInformation><doma:datatype>CHAR</doma:datatype>' +
      "<doma:length>10</doma:length></doma:typeInformation></doma:domain>";
    // readDomain() fetches and parses these exact bytes for BOTH rendering and
    // the etag — there is no separate `getDomainProperties()` payload any more
    // (no `adt.getDomainProperties` stub here: if `readDomain` still called
    // it, this bare conn object has no `adt` at all and the call would
    // throw). This XML is missing the `<doma:content>` wrapper real ADT
    // sends — `parseDomainXml` degrades to an empty view rather than
    // throwing, which is exactly what this test needs: only the etag
    // identity is asserted below, not the rendering.
    const conn = {
      cfg: { sid: "A4H" },
      get: async (uri: string) => {
        expect(uri).toBe("/sap/bc/adt/ddic/domains/zpropw_doma");
        return { body: xml, status: 200, headers: {} };
      },
    } as unknown as AbapConnectionType;
    stub.object = resolved({
      type: "DOMA/DD",
      kind: "DOMA",
      name: "ZPROPW_DOMA",
      uri: "/sap/bc/adt/ddic/domains/zpropw_doma",
    });

    const byDefault = await abapRead(conn, { object: "ZPROPW_DOMA", type: "DOMA/DD" } as never, 20_000);
    const byRaw = await abapRead(
      conn,
      { object: "ZPROPW_DOMA", type: "DOMA/DD", format: "raw" } as never,
      20_000,
    );

    expect(byDefault.etag).toBe(byRaw.etag);
    expect(byDefault.etag).toBe(canonicalEtag(xml));
  });

  it('DTEL/DE: default read and format="raw" agree, driven purely by conn.get — one GET, no getDataElementProperties() involved', async () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><dtel:dataElement xmlns:dtel="http://www.sap.com/dictionary/dataelement" ' +
      'xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZPROPW_DTEL" adtcore:type="DTEL/DE" ' +
      'adtcore:description="probe"/>';
    // readDataElement() fetches and parses these exact bytes for BOTH
    // rendering and the etag — no `adt.getDataElementProperties` stub here
    // (if `readDataElement` still called it, this bare conn object has no
    // `adt` at all and the call would throw). This XML has no `<blue:wbobj>`
    // wrapper and no nested `<dtel:dataElement>` fields (real ADT shape) —
    // `parseDataElementXml` degrades to an empty typeName ("", i.e. no
    // domain, so no second fetch is attempted) rather than throwing; only
    // the etag identity is asserted below, not rendering.
    const conn = {
      cfg: { sid: "A4H" },
      get: async (uri: string) => {
        expect(uri).toBe("/sap/bc/adt/ddic/dataelements/zpropw_dtel");
        return { body: xml, status: 200, headers: {} };
      },
    } as unknown as AbapConnectionType;
    stub.object = resolved({
      type: "DTEL/DE",
      kind: "DTEL",
      name: "ZPROPW_DTEL",
      uri: "/sap/bc/adt/ddic/dataelements/zpropw_dtel",
    });

    const byDefault = await abapRead(conn, { object: "ZPROPW_DTEL", type: "DTEL/DE" } as never, 20_000);
    const byRaw = await abapRead(
      conn,
      { object: "ZPROPW_DTEL", type: "DTEL/DE", format: "raw" } as never,
      20_000,
    );

    expect(byDefault.etag).toBe(byRaw.etag);
    expect(byDefault.etag).toBe(canonicalEtag(xml));
  });
});

// ---------------------------------------------------------------------------
// Part 2 — end to end: abap_write's own compare-before-write accepts an
// etag taken from EITHER read format. Same fake-HttpClient harness as
// test/write.test.ts, trimmed to what a TTYP/DA object needs.
// ---------------------------------------------------------------------------

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

/** The read-back `verifyObjectDeleted` issues against a deleted object. */
const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">ZPROPW_TTYP does not exist</message><properties/></exc:exception>`;

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR></CORRNR><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

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

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle"))
    return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
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

const DEFAULT_GATE = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
const authWrite = (conn: AbapConnection, target: { type: string; name: string }) =>
  authorizeMutation(conn, DEFAULT_GATE, "write", target);
const authDelete = (conn: AbapConnection, target: { type: string; name: string }) =>
  authorizeMutation(conn, DEFAULT_GATE, "delete", target);

const TTYP_URI = "/sap/bc/adt/ddic/tabletypes/zpropw_ttyp";
const ttypXml = (rowType: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><ttyp:tableType ` +
  `xmlns:ttyp="http://www.sap.com/dictionary/tabletype" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZPROPW_TTYP" ` +
  `adtcore:type="TTYP/DA"><adtcore:packageRef adtcore:name="$TMP"/>` +
  `<ttyp:rowType><ttyp:typeKind>dictionaryType</ttyp:typeKind><ttyp:typeName>${rowType}</ttyp:typeName>` +
  `<ttyp:builtInType><ttyp:dataType>STRU</ttyp:dataType><ttyp:length>000000</ttyp:length>` +
  `<ttyp:decimals>000000</ttyp:decimals></ttyp:builtInType><ttyp:rangeType/></ttyp:rowType>` +
  `</ttyp:tableType>`;

const BEFORE = ttypXml("ZPROPW_S1");
const AFTER = ttypXml("ZPROPW_S2");

/**
 * An existing TTYP/DA whose descriptor STARTS as `initial`; lock/unlock/PUT/
 * DELETE all succeed.
 *
 * Stateful, not a fixed answer to every GET: round 3's fix (c) (write.ts step
 * 4b) adds a genuine post-write GET through this same route for a properties-
 * shape UPDATE, so a PUT must actually be reflected in the next GET for
 * `writeObject`'s `changed` verdict to come out right — exactly as a real
 * server would behave. This factory always advances to `AFTER` on a
 * successful PUT (the two `writeObject` tests below only ever write `AFTER`),
 * which is enough for their purposes without generalising further.
 */
const existingTtyp = (initial: string): Route => {
  let current = initial;
  // For a properties-shape type, contentUri(t) IS the object's own
  // URI (see src/adt/write.ts's usesObjectUriForContent), so the post-delete
  // read-back `verifyObjectDeleted` issues hits this same GET route — it
  // must answer 404 once the DELETE has actually landed, or the delete
  // degrades to `deleted: "unverified"` instead of confirming `true`.
  let deleted = false;
  return (r) => {
    if (r.url === TTYP_URI && r.method === "GET") {
      return deleted ? resp(404, NOT_FOUND_XML, OK_XML) : resp(200, current, OK_XML);
    }
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === TTYP_URI && r.method === "PUT") {
      current = AFTER;
      return resp(200, AFTER, OK_XML);
    }
    if (r.url === TTYP_URI && r.method === "DELETE") {
      deleted = true;
      return resp(200, "", {});
    }
    return undefined;
  };
};

describe("abap_write compare-before-write/-delete accepts an etag from EITHER abap_read format", () => {
  it('writeObject: accepts the default-mode etag AND the format="raw" etag, on two independent connections to the same unchanged object', async () => {
    stub.object = resolved({ uri: TTYP_URI });

    // Independent connections, not independent objects: each sees the same
    // `BEFORE` bytes on the wire, exactly as two separate abap_read calls
    // against the same unchanged live object would.
    const connA = (await connected(existingTtyp(BEFORE))).conn;
    const etagFromDefault = (
      await abapRead(connA, { object: "ZPROPW_TTYP", type: "TTYP/DA" } as never, 20_000)
    ).etag;

    const connB = (await connected(existingTtyp(BEFORE))).conn;
    const etagFromRaw = (
      await abapRead(connB, { object: "ZPROPW_TTYP", type: "TTYP/DA", format: "raw" } as never, 20_000)
    ).etag;

    expect(etagFromDefault).toBe(etagFromRaw);

    for (const expectEtag of [etagFromDefault, etagFromRaw]) {
      const { conn } = await connected(existingTtyp(BEFORE));
      const res = await writeObject(conn, await authWrite(conn, { type: "TTYP/DA", name: "ZPROPW_TTYP" }), {
        source: AFTER,
        expectEtag,
      });
      // The proof: writeObject ran to completion (a real PUT happened) rather
      // than throwing ETAG_CONFLICT — which is exactly what the measured bug
      // did for one of these two etags before this fix.
      expect(res.changed).toBe(true);
    }
  });

  it('deleteObject: accepts the default-mode etag AND the format="raw" etag, on two independent connections to the same unchanged object', async () => {
    stub.object = resolved({ uri: TTYP_URI });

    const connA = (await connected(existingTtyp(BEFORE))).conn;
    const etagFromDefault = (
      await abapRead(connA, { object: "ZPROPW_TTYP", type: "TTYP/DA" } as never, 20_000)
    ).etag;

    const connB = (await connected(existingTtyp(BEFORE))).conn;
    const etagFromRaw = (
      await abapRead(connB, { object: "ZPROPW_TTYP", type: "TTYP/DA", format: "raw" } as never, 20_000)
    ).etag;

    for (const expectEtag of [etagFromDefault, etagFromRaw]) {
      const { conn } = await connected(existingTtyp(BEFORE));
      const res = await deleteObject(conn, await authDelete(conn, { type: "TTYP/DA", name: "ZPROPW_TTYP" }), {
        expectEtag,
        onBeforeImage: NO_JOURNAL,
      });
      expect(res.deleted).toBe(true);
    }
  });

  it("still refuses a genuinely stale etag on a properties-shape object (the fix did not disable the check)", async () => {
    stub.object = resolved({ uri: TTYP_URI });
    const { conn } = await connected(existingTtyp(BEFORE));
    await expect(
      writeObject(conn, await authWrite(conn, { type: "TTYP/DA", name: "ZPROPW_TTYP" }), {
        source: AFTER,
        expectEtag: canonicalEtag("<completely-different-descriptor/>"),
      }),
    ).rejects.toMatchObject({ code: "ETAG_CONFLICT" });
  });
});

// ---------------------------------------------------------------------------
// Part 3 — perf fix: a default (non-`format:"raw"`) DTEL/DOMA/TTYP read used
// to perform TWO real HTTP GETs of the identical
// object URI — one inside `abap-adt-api`'s `getDataElementProperties`/
// `getDomainProperties` (parsed for rendering, raw body discarded) and one
// more from `fetchRawDescriptor` (raw bytes fetched again, purely to hash for
// the etag). This is deliberately the real `AbapConnection` + `FakeAdt`
// transport Part 2 uses, NOT the bare-stub harness Part 1 uses: the
// redundant call being tested for was `abap-adt-api`'s OWN internal
// `h.request(...)`, which a plain `{ get, adt: { getDomainProperties } }`
// stub cannot observe (it would just be a second, differently-named mock
// function). Only counting genuine requests on the wire transport can show
// this actually dropped from two to one.
// ---------------------------------------------------------------------------

const DOMA_URI = "/sap/bc/adt/ddic/domains/zpropw_doma";
const domaXml = () =>
  `<?xml version="1.0" encoding="UTF-8"?><doma:domain ` +
  `xmlns:doma="http://www.sap.com/dictionary/domain" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZPROPW_DOMA" ` +
  `adtcore:type="DOMA/DD" adtcore:description="probe"><adtcore:packageRef adtcore:name="$TMP"/>` +
  `<doma:content><doma:typeInformation><doma:datatype>CHAR</doma:datatype>` +
  `<doma:length>10</doma:length></doma:typeInformation></doma:content></doma:domain>`;

const DTEL_URI = "/sap/bc/adt/ddic/dataelements/zpropw_dtel";
const dtelXml = () =>
  `<?xml version="1.0" encoding="UTF-8"?><blue:wbobj ` +
  `xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZPROPW_DTEL" ` +
  `adtcore:type="DTEL/DE" adtcore:description="probe"><adtcore:packageRef adtcore:name="$TMP"/>` +
  `<dtel:dataElement xmlns:dtel="http://www.sap.com/adt/dictionary/dataelements">` +
  `<dtel:typeKind>predefinedAbapType</dtel:typeKind><dtel:typeName></dtel:typeName>` +
  `<dtel:dataType>CHAR</dtel:dataType><dtel:dataTypeLength>10</dtel:dataTypeLength>` +
  `</dtel:dataElement></blue:wbobj>`;

/** Only the object's own URI is wired — anything else throws "unrouted request". */
const onlyGet = (uri: string, xml: string): Route => (r) => {
  if (r.url === uri && r.method === "GET") return resp(200, xml, OK_XML);
  return undefined;
};

describe("a default DTEL/DOMA/TTYP read performs exactly one HTTP GET of the object", () => {
  it("TTYP/DA: one GET, not two", async () => {
    stub.object = resolved({ uri: TTYP_URI });
    const { conn, adt } = await connected(onlyGet(TTYP_URI, BEFORE));

    await abapRead(conn, { object: "ZPROPW_TTYP", type: "TTYP/DA" } as never, 20_000);

    const gets = adt.calls.filter((c) => c.method === "GET" && c.url === TTYP_URI);
    expect(gets).toHaveLength(1);
  });

  it("DOMA/DD: one GET, not two — abap-adt-api's getDomainProperties is never invoked", async () => {
    stub.object = resolved({ type: "DOMA/DD", kind: "DOMA", name: "ZPROPW_DOMA", uri: DOMA_URI });
    const { conn, adt } = await connected(onlyGet(DOMA_URI, domaXml()));

    await abapRead(conn, { object: "ZPROPW_DOMA", type: "DOMA/DD" } as never, 20_000);

    // If getDomainProperties were still called, it would perform its OWN GET
    // against this same URI through the same FakeAdt transport, and this
    // count would be 2 — exactly the bug this fix removes.
    const gets = adt.calls.filter((c) => c.method === "GET" && c.url === DOMA_URI);
    expect(gets).toHaveLength(1);
  });

  it("DTEL/DE: one GET, not two — abap-adt-api's getDataElementProperties is never invoked", async () => {
    stub.object = resolved({ type: "DTEL/DE", kind: "DTEL", name: "ZPROPW_DTEL", uri: DTEL_URI });
    const { conn, adt } = await connected(onlyGet(DTEL_URI, dtelXml()));

    await abapRead(conn, { object: "ZPROPW_DTEL", type: "DTEL/DE" } as never, 20_000);

    const gets = adt.calls.filter((c) => c.method === "GET" && c.url === DTEL_URI);
    expect(gets).toHaveLength(1);
  });
});
