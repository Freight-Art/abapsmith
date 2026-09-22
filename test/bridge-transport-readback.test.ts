/**
 * Issue #173: read-back confirmation of which transport request CTS actually
 * recorded a bridge write's object under.
 *
 * Part A: offline unit tests of `readBackTransportEntry`/`sameEntry`/
 * `entryLabel` (src/adt/transport-readback.ts) with a mocked `cts` param —
 * no network, no AbapConnection.
 *
 * Part B: through `abapWrite` for VIEW/DV and TABL/DI. `autoMgr()` mocks the
 * SessionTransport-level create-resolution (`trCreate`/`trRequirement` as
 * vi.fn, never over the wire); the read-back step calls the REAL
 * `trShow`/`trRequirement` from src/adt/transports.ts over FakeAdt HTTP.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import type { AbapConnection } from "../src/adt/connection.js";
import { AbapConnection as RealAbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { abapWrite } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrHeader, TrObject, TrRequest, TrRequirement } from "../src/adt/transports.js";
import { classicFake, useFluidState, type ClassicFake } from "./helpers/fluid-classic-fake.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { vitBridgeUri } from "../src/adt/write-verify.js";
import { readBackTransportEntry, sameEntry, entryLabel, type TrEntryKey } from "../src/adt/transport-readback.js";

// ============================================================= Part A ====

type Cts = Parameters<typeof readBackTransportEntry>[2];

function mockCts(): { cts: Cts; trShow: ReturnType<typeof vi.fn>; trRequirement: ReturnType<typeof vi.fn> } {
  const trShow = vi.fn();
  const trRequirement = vi.fn();
  return { cts: { trShow, trRequirement } as unknown as Cts, trShow, trRequirement };
}

function obj(pgmid: string, type: string, name: string): TrObject {
  return { pgmid, type, name, locked: true };
}

function req(trkorr: string, objects: TrObject[], overrides: Partial<TrRequest> = {}): TrRequest {
  return {
    trkorr,
    kind: "workbench",
    kindRaw: "K",
    status: "modifiable",
    statusRaw: "D",
    owner: "DEVELOPER",
    description: "a request",
    tasks: [],
    objects,
    ...overrides,
  };
}

describe("issue #173: transport-readback.ts unit tests", () => {
  it("sameEntry ignores case and all whitespace in the name", () => {
    expect(sameEntry({ pgmid: "limu", type: "indx", name: "  zas_t173   z01 " }, { pgmid: "LIMU", type: "INDX", name: "ZAS_T173Z01" })).toBe(true);
    expect(sameEntry({ pgmid: "LIMU", type: "INDX", name: "ZAS_T173 Z01" }, { pgmid: "LIMU", type: "INDX", name: "ZAS_T174 Z01" })).toBe(false);
    expect(sameEntry({ pgmid: "R3TR", type: "VIEW", name: "X" }, { pgmid: "LIMU", type: "VIEW", name: "X" })).toBe(false);
  });

  it("entryLabel collapses whitespace", () => {
    expect(entryLabel({ pgmid: " limu ", type: "indx", name: "zas_t173    z01" })).toBe("LIMU INDX ZAS_T173 Z01");
  });

  it("confirmed-same when the intended request lists the entry", async () => {
    const { cts, trShow, trRequirement } = mockCts();
    const entry: TrEntryKey = { pgmid: "R3TR", type: "VIEW", name: "ZMCP_V_AUTO" };
    trShow.mockResolvedValue(req("A4HK900321", [obj("R3TR", "VIEW", "ZMCP_V_AUTO")]));

    const result = await readBackTransportEntry({} as AbapConnection, { intended: "A4HK900321", entry }, cts);

    expect(result).toEqual({ status: "confirmed-same", trkorr: "A4HK900321", matched: entry });
    expect(trRequirement).not.toHaveBeenCalled();
  });

  it("confirmed-same via the covering R3TR TABL entry", async () => {
    const { cts, trShow } = mockCts();
    const entry: TrEntryKey = { pgmid: "LIMU", type: "INDX", name: "ZAS_T173 Z01" };
    const covering: TrEntryKey = { pgmid: "R3TR", type: "TABL", name: "ZAS_T173" };
    trShow.mockResolvedValue(req("A4HK900321", [obj("R3TR", "TABL", "ZAS_T173")]));

    const result = await readBackTransportEntry({} as AbapConnection, { intended: "A4HK900321", entry, covering }, cts);

    expect(result).toEqual({ status: "confirmed-same", trkorr: "A4HK900321", matched: covering });
  });

  it("confirmed-other when CTS reports the lock in another request that lists the covering entry", async () => {
    const { cts, trShow, trRequirement } = mockCts();
    const entry: TrEntryKey = { pgmid: "LIMU", type: "INDX", name: "ZAS_T173 Z01" };
    const covering: TrEntryKey = { pgmid: "R3TR", type: "TABL", name: "ZAS_T173" };
    const holder = req("A4HK900117", [obj("R3TR", "TABL", "ZAS_T173")], { owner: "OTHERDEV", description: "someone else's request" });
    const holderHeader: TrHeader = {
      trkorr: "A4HK900117",
      kind: "workbench",
      kindRaw: "K",
      status: "modifiable",
      statusRaw: "D",
      owner: "OTHERDEV",
      description: "someone else's request",
    };
    trShow.mockImplementation(async (_conn: unknown, trkorr: string) => (trkorr === "A4HK900321" ? req("A4HK900321", []) : holder));
    trRequirement.mockResolvedValue({
      uri: "/sap/bc/adt/ddic/tables/zas_t173",
      operation: "U",
      candidates: [],
      locks: [{ object: { pgmid: "R3TR", type: "TABL", name: "ZAS_T173" }, request: holderHeader, tasks: [] }],
      pinnedTo: "A4HK900117",
      pinnedOwner: "OTHERDEV",
      messages: [],
      checkFailed: false,
      raw: { result: "S", korrflag: "X", recording: "" },
      kind: "transport-required",
      mustSupplyCorrNr: true,
      serverWouldFabricate: false,
    } satisfies TrRequirement);

    const result = await readBackTransportEntry(
      {} as AbapConnection,
      { intended: "A4HK900321", entry, covering, lookup: { uri: "/sap/bc/adt/ddic/tables/zas_t173", devclass: "ZTM" } },
      cts,
    );

    expect(result).toEqual({ status: "confirmed-other", trkorr: "A4HK900117", intended: "A4HK900321", holder, matched: covering });
  });

  it("unknown when neither lists it, and unknown (never a throw) when trShow throws", async () => {
    const entry: TrEntryKey = { pgmid: "R3TR", type: "TRAN", name: "ZMCPTAUTO" };

    const notListed = mockCts();
    notListed.trShow.mockResolvedValue(req("A4HK900321", []));
    const r1 = await readBackTransportEntry({} as AbapConnection, { intended: "A4HK900321", entry }, notListed.cts);
    expect(r1.status).toBe("unknown");
    if (r1.status === "unknown") {
      expect(r1.reason).toMatch(/does not list/);
      expect(r1.entry).toEqual(entry);
    }

    const throwing = mockCts();
    throwing.trShow.mockRejectedValue(new Error("network exploded"));
    const r2 = await readBackTransportEntry({} as AbapConnection, { intended: "A4HK900321", entry }, throwing.cts);
    expect(r2.status).toBe("unknown");
    if (r2.status === "unknown") {
      expect(r2.reason).toMatch(/reading back request A4HK900321 failed: network exploded/);
    }
  });
});

// ============================================================= Part B ====

const MAX = 20_000;
const PKG = "ZTM";
const CREATED = "A4HK900321";
const VIEW = "ZMCP_V_AUTO";
const TABLE = "ZMCP_TEST_TAB";
const INDEX = "Z01";

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

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
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body };
    this.calls.push(rec);
    const res = this.route(rec);
    if (!res) throw new Error(`FakeAdt: unrouted request ${label}`);
    return res;
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

async function connected(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  let duringConnect = true;
  const adt = new FakeAdt((r) => {
    if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
    if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
    if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
    if (duringConnect && r.url.includes("/datapreview/freestyle")) {
      return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
    }
    return route(r);
  });
  const conn = new RealAbapConnection(cfg(), { httpClient: adt, log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  duringConnect = false;
  adt.calls.length = 0;
  return { conn, adt };
}

const both =
  (...routes: Route[]): Route =>
  (r) => {
    for (const route of routes) {
      const hit = route(r);
      if (hit) return hit;
    }
    return undefined;
  };

const OBJECT_XML = (name: string, type: string, packageName: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="${name}" adtcore:type="${type}">` +
  `<adtcore:packageRef adtcore:name="${packageName}"/>` +
  `</adtcore:objectMetadata>`;

const metaRoute =
  (uri: string, name: string, type: string, packageName: string): Route =>
  (r) =>
    r.method === "GET" && !r.qs._action && r.url === uri ? resp(200, OBJECT_XML(name, type, packageName), OK_XML) : undefined;

const vitRoute =
  (vitType: string, name: string, type: string): Route =>
  (r) =>
    r.url === vitBridgeUri(vitType, name)
      ? resp(
          200,
          `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" ` +
            `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:type="${type}" ` +
            `adtcore:name="${name}"><adtcore:packageRef adtcore:name="${PKG}"/></vit:properties>`,
          OK_XML,
        )
      : undefined;

function columnXml(name: string, values: readonly string[]): string {
  const data = values.map((v) => `<dataPreview:data>${v}</dataPreview:data>`).join("");
  return (
    `<dataPreview:columns><dataPreview:metadata dataPreview:name="${name}" dataPreview:type="C" dataPreview:keyAttribute="false"/>` +
    `<dataPreview:dataSet>${data}</dataPreview:dataSet></dataPreview:columns>`
  );
}
function tableBody(cols: Record<string, readonly string[]>): string {
  const colsXml = Object.keys(cols)
    .map((n) => columnXml(n, cols[n]!))
    .join("");
  return (
    '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' +
    `${colsXml}</dataPreview:tableData>`
  );
}

/** TABL/DI's post-create DD12V/DD17S catalog re-read, routed by SQL body. */
const tablDiCatalogRoute: Route = (r) => {
  if (!r.url.includes("/datapreview/freestyle")) return undefined;
  const sql = String(r.body ?? "").toLowerCase();
  if (sql.includes("dd12v")) {
    return resp(
      200,
      tableBody({ SQLTAB: [TABLE], INDEXNAME: [INDEX], DDLANGUAGE: ["E"], UNIQUEFLAG: [""], AS4LOCAL: ["A"], DBSTATE: ["ACT"], DDTEXT: ["probe idx"] }),
      DATAPREVIEW_XML,
    );
  }
  if (sql.includes("dd17s")) {
    return resp(200, tableBody({ SQLTAB: [TABLE], INDEXNAME: [INDEX], POSITION: ["0001"], FIELDNAME: ["CARRIER"] }), DATAPREVIEW_XML);
  }
  return undefined;
};

const gateWith = (allowTransports: string[], allowPackages: string[] = ["*"]): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages,
    allowNamePrefixes: ["*"],
    allowTransports,
    writesLockedOut: false,
  });

/** A `SessionTransport` in auto mode; `trCreate` always mints `CREATED`. */
function autoMgr(): { mgr: SessionTransport } {
  const authorizeCreate = () =>
    new SafetyGate({ readOnly: false, allowPackages: ["*"] }).authorize(
      "transport",
      { name: PKG, packageName: PKG },
      { corr: { kind: "unresolved" } },
    );
  const trCreate = vi.fn(async () => ({ trkorr: CREATED, path: `/com.sap.cts/object_record/${CREATED}` }));
  const trRequirement = vi.fn(async (_conn: unknown, uri: string, devClass: string) => ({
    uri,
    operation: "I",
    devclass: devClass,
    candidates: [],
    locks: [],
    messages: [],
    checkFailed: false,
    raw: { result: "S", korrflag: "X", recording: "" },
    kind: "transport-required",
    mustSupplyCorrNr: true,
    serverWouldFabricate: false,
  }));
  const mgr = new SessionTransport({
    allowTransports: ["auto"],
    authorizeCreate,
    whoami: () => "DEVELOPER",
    cts: { trCreate, trRequirement } as never,
  });
  return { mgr };
}

/** The real wire GET /sap/bc/adt/cts/transportrequests/<nr> response `trShow` parses. */
const trShowXml = (trkorr: string, owner: string, desc: string, objects: readonly { pgmid: string; type: string; name: string }[]): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `tm:object_type="R" adtcore:name="${trkorr}" adtcore:type="RQRQ">` +
  `<tm:request tm:number="${trkorr}" tm:owner="${owner}" tm:desc="${desc}" tm:type="K" tm:status="D">` +
  `<tm:all_objects>` +
  objects.map((o) => `<tm:abap_object tm:pgmid="${o.pgmid}" tm:type="${o.type}" tm:name="${o.name}" tm:lock_status="X"/>`).join("") +
  `</tm:all_objects>` +
  `</tm:request></tm:root>`;

const trShowRoute =
  (bodies: Record<string, string>): Route =>
  (r) => {
    if (r.method !== "GET") return undefined;
    const prefix = "/sap/bc/adt/cts/transportrequests/";
    if (!r.url.startsWith(prefix)) return undefined;
    const trkorr = decodeURIComponent(r.url.slice(prefix.length));
    const body = bodies[trkorr];
    return body !== undefined ? resp(200, body, OK_XML) : undefined;
  };

/** The real wire POST /sap/bc/adt/cts/transportchecks response `trRequirement` parses, with one lock holder. */
const lockCheckXml = (holderTrkorr: string, holderOwner: string, holderDesc: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>` +
  `<RESULT>S</RESULT><KORRFLAG>X</KORRFLAG><RECORDING></RECORDING>` +
  `<LOCKS><CTS_OBJECT_LOCK><OBJECT_KEY><PGMID>LIMU</PGMID><OBJECT>INDX</OBJECT><OBJ_NAME>X</OBJ_NAME></OBJECT_KEY>` +
  `<LOCK_HOLDER><REQ_HEADER><TRKORR>${holderTrkorr}</TRKORR><TRFUNCTION>K</TRFUNCTION><TRSTATUS>D</TRSTATUS>` +
  `<AS4USER>${holderOwner}</AS4USER><AS4TEXT>${holderDesc}</AS4TEXT></REQ_HEADER><REQ_ATTRS/><TASK_HEADERS/></LOCK_HOLDER>` +
  `</CTS_OBJECT_LOCK></LOCKS></DATA></asx:values></asx:abap>`;

const lockCheckRoute =
  (xmlBody: string): Route =>
  (r) =>
    r.method === "POST" && r.url === "/sap/bc/adt/cts/transportchecks" ? resp(200, xmlBody, OK_XML) : undefined;

const viewInput = { object: VIEW, type: "VIEW/DV", package: PKG, description: "Carriers", base_table: "ZMCP_CARRIER", view_fields: ["CARRIER_ID", "NAME"] };
const indexInput = { object: INDEX, type: "TABL/DI", description: "probe idx", base_table: TABLE, index_fields: ["CARRIER"] };

const viewClassic = (): ClassicFake => classicFake({ action: "create_view", lines: () => ["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"] });
const indexClassic = (): ClassicFake => classicFake({ action: "create_index", lines: () => ["INDEX-CREATED", "INDEX-ACTIVE", "INDEX-FIELDS"] });

describe("issue #173: read-back through abapWrite (VIEW/DV, TABL/DI)", () => {
  it("TABL/DI: the request the write sent lists LIMU INDX <TABLE> <ID> → transport: is that request and the note says it was read back", async () => {
    const classic = indexClassic();
    const trShowBodies = { [CREATED]: trShowXml(CREATED, "DEVELOPER", "abapsmith session", [{ pgmid: "LIMU", type: "INDX", name: `${TABLE} ${INDEX}` }]) };
    const { conn } = await connected(
      both(classic.route, metaRoute(`/sap/bc/adt/ddic/tables/${TABLE.toLowerCase()}`, TABLE, "TABL/DT", PKG), tablDiCatalogRoute, trShowRoute(trShowBodies)),
    );
    const { mgr } = autoMgr();

    const result = await abapWrite(conn, indexInput as never, MAX, gateWith(["auto"]), undefined, mgr);

    expect(result.text).toMatch(new RegExp(`transport:\\s*${CREATED}`));
    expect(result.text).toMatch(new RegExp(`Read back after the write: request ${CREATED} lists LIMU INDX ${TABLE} ${INDEX}\\.`));
  });

  it("TABL/DI: the index landed in the request holding the R3TR TABL lock → transport: names that request and the note explains", async () => {
    const classic = indexClassic();
    const HOLDER = "A4HK900117";
    const trShowBodies = {
      [CREATED]: trShowXml(CREATED, "DEVELOPER", "abapsmith session", []),
      [HOLDER]: trShowXml(HOLDER, "OTHERDEV", "someone else's request", [{ pgmid: "R3TR", type: "TABL", name: TABLE }]),
    };
    const { conn } = await connected(
      both(
        classic.route,
        metaRoute(`/sap/bc/adt/ddic/tables/${TABLE.toLowerCase()}`, TABLE, "TABL/DT", PKG),
        tablDiCatalogRoute,
        trShowRoute(trShowBodies),
        lockCheckRoute(lockCheckXml(HOLDER, "OTHERDEV", "someone else's request")),
      ),
    );
    const { mgr } = autoMgr();

    const result = await abapWrite(conn, indexInput as never, MAX, gateWith(["auto"]), undefined, mgr);

    expect(result.text).toMatch(new RegExp(`transport:\\s*${HOLDER}`));
    expect(result.text).toMatch(new RegExp(`Recorded in ${HOLDER} \\(holds the R3TR TABL lock for ${TABLE}\\), not in the session's request ${CREATED}`));
  });

  it("TABL/DI: a failing read-back keeps transport: at the number sent and says it could not confirm", async () => {
    const classic = indexClassic();
    // No trShowRoute: the read-back's GET goes unrouted, FakeAdt throws.
    const { conn } = await connected(both(classic.route, metaRoute(`/sap/bc/adt/ddic/tables/${TABLE.toLowerCase()}`, TABLE, "TABL/DT", PKG), tablDiCatalogRoute));
    const { mgr } = autoMgr();

    const result = await abapWrite(conn, indexInput as never, MAX, gateWith(["auto"]), undefined, mgr);

    expect(result.text).toMatch(new RegExp(`transport:\\s*${CREATED}`));
    expect(result.text).toMatch(/Could not confirm from CTS which request holds LIMU INDX/);
  });

  it("VIEW/DV: the same read-back on the view's own R3TR VIEW entry (same request)", async () => {
    const classic = viewClassic();
    const trShowBodies = { [CREATED]: trShowXml(CREATED, "DEVELOPER", "abapsmith session", [{ pgmid: "R3TR", type: "VIEW", name: VIEW }]) };
    const { conn } = await connected(both(classic.route, vitRoute("viewdv", VIEW, "VIEW/DV"), trShowRoute(trShowBodies)));
    const { mgr } = autoMgr();

    const result = await abapWrite(conn, viewInput as never, MAX, gateWith(["auto"]), undefined, mgr);

    expect(result.text).toMatch(new RegExp(`transport:\\s*${CREATED}`));
    expect(result.text).toMatch(new RegExp(`Read back after the write: request ${CREATED} lists R3TR VIEW ${VIEW}\\.`));
  });

  it("VIEW/DV: recorded in another request", async () => {
    const classic = viewClassic();
    const HOLDER = "A4HK900117";
    const trShowBodies = {
      [CREATED]: trShowXml(CREATED, "DEVELOPER", "abapsmith session", []),
      [HOLDER]: trShowXml(HOLDER, "OTHERDEV", "someone else's request", [{ pgmid: "R3TR", type: "VIEW", name: VIEW }]),
    };
    const { conn } = await connected(
      both(
        classic.route,
        vitRoute("viewdv", VIEW, "VIEW/DV"),
        trShowRoute(trShowBodies),
        lockCheckRoute(lockCheckXml(HOLDER, "OTHERDEV", "someone else's request")),
      ),
    );
    const { mgr } = autoMgr();

    const result = await abapWrite(conn, viewInput as never, MAX, gateWith(["auto"]), undefined, mgr);

    expect(result.text).toMatch(new RegExp(`transport:\\s*${HOLDER}`));
    expect(result.text).toMatch(new RegExp(`Recorded in ${HOLDER} \\(holds the R3TR VIEW lock for ${VIEW}\\), not in the session's request ${CREATED}`));
  });
});
