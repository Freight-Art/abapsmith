/**
 * Issue #65: live on A4H, `abap_write {"mode":"delete", …, "corr_nr": T2}`
 * deleted an object locked by request T1. CTS recorded the deletion on T1,
 * but the response printed `transport: T1` under the ordinary transport
 * note's claim "That is the number this write sent, after the safety gate
 * approved it" — false: T1 was never sent, T2 was, and CTS ignored it. This
 * file pins the TOOL layer's fix (`abapWrite`/`abapWriteBatchDelete`,
 * src/tools/write.ts and src/tools/write-batch-delete.ts): the `corr_nr_honoured: false` header field, the
 * replacement note text (`corrNrNotHonouredNote`), and the batch body's
 * per-object suffix. It deliberately does NOT cover `src/adt/write.ts`'s
 * own refusal (`corrNrNotHonoured`, thrown before anything is deleted when
 * the caller NAMED the corr_nr) beyond confirming it surfaces through the
 * tool as a rejection, not a success — that function's own behaviour is
 * pinned by test/delete-corr-nr-honoured.test.ts.
 *
 * Harness idiom copied from test/write-transport-note.test.ts: a real
 * `SessionTransport` (only `trCreate`/`trShow` injected; the transport
 * pre-flight candidate list is parsed by the real `checkCandidates`/
 * `headerFromCheck`, src/adt/transports.ts, from inline XML), a real
 * `SafetyGate`, and the same hand-rolled `FakeAdt` routing
 * `POST /sap/bc/adt/cts/transportchecks`, LOCK/UNLOCK, and the object GETs.
 *
 * The one addition this file needs that the transport-note harness doesn't:
 * a LOCK response that NAMES a transport request, shaped like the fixture
 * test/fixtures/cts/lock-transportable-object.xml (`<LOCK_HANDLE>`,
 * `<CORRNR>`, `<CORRUSER>`, `<CORRTEXT>`, `<IS_LOCAL/>`, content-type
 * `application/vnd.sap.as+xml; charset=utf-8; dataname=com.sap.adt.lock.Result`).
 * A delete also needs its post-delete read-back routed to a 404 so
 * `deleted: true` (not `false`, which throws) — copied from how
 * test/delete-verification.test.ts's `deleteObject` section drives that.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { abapWrite, abapWriteBatchDelete } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequest, TrStatus } from "../src/adt/transports.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

const TRANSPORTCHECKS = "/sap/bc/adt/cts/transportchecks";

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
/** Same content-type the real LOCK response uses, per lock-transportable-object.meta.json. */
const LOCK_HEADERS = {
  "content-type": "application/vnd.sap.as+xml; charset=utf-8; dataname=com.sap.adt.lock.Result",
};

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
  if (r.url.includes("/datapreview/freestyle"))
    return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
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

const OBJECT_XML = (name: string, type: string, packageName: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="${name}" adtcore:type="${type}">` +
  `<adtcore:packageRef adtcore:name="${packageName}"/>` +
  `</adtcore:objectMetadata>`;

/** Shaped like test/fixtures/cts/lock-transportable-object.xml — names a transport request. */
const LOCK_XML = (handle: string, corrNr: string): string =>
  `<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">` +
  `<asx:values><DATA><LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR>` +
  `<CORRUSER>DEVELOPER</CORRUSER><CORRTEXT>Generated Request for Change Recording</CORRTEXT>` +
  `<IS_LOCAL/></DATA></asx:values></asx:abap>`;

/**
 * The `POST /sap/bc/adt/cts/transportchecks` pre-flight response — copied
 * verbatim from test/write-transport-note.test.ts. Element names/nesting
 * taken from test/fixtures/cts/transport-info-transportable.xml, one
 * `CTS_REQUEST` per candidate. `objectName`/`uri` are parameterised so this
 * file's several report names can each get a matching response.
 */
const transportChecksXml = (opts: {
  objectName: string;
  uri: string;
  devclass: string;
  candidates: ReadonlyArray<{ trkorr: string; owner: string; text?: string }>;
}): string =>
  `<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">` +
  `<asx:values><DATA><PGMID>LIMU</PGMID><OBJECT>REPS</OBJECT><OBJECTNAME>${opts.objectName}</OBJECTNAME>` +
  `<OPERATION>U</OPERATION><DEVCLASS>${opts.devclass}</DEVCLASS><CTEXT/><KORRFLAG>X</KORRFLAG>` +
  `<AS4USER/><PDEVCLASS/><DLVUNIT>HOME</DLVUNIT><NAMESPACE/><RESULT>S</RESULT><RECORDING>X</RECORDING>` +
  `<EXISTING_REQ_ONLY/><MESSAGES/><REQUESTS>` +
  opts.candidates
    .map(
      (c) =>
        `<CTS_REQUEST><REQ_HEADER><TRKORR>${c.trkorr}</TRKORR><TRFUNCTION>K</TRFUNCTION>` +
        `<TRSTATUS>D</TRSTATUS><TARSYSTEM/><AS4USER>${c.owner}</AS4USER><AS4DATE>2026-08-27</AS4DATE>` +
        `<AS4TIME>09:00:00</AS4TIME><AS4TEXT>${c.text ?? "a request CTS offered"}</AS4TEXT>` +
        `<CLIENT>001</CLIENT></REQ_HEADER><REQ_ATTRS/><TASK_HEADERS/></CTS_REQUEST>`,
    )
    .join("") +
  `</REQUESTS><LOCKS/><TADIRDEVC>${opts.devclass}</TADIRDEVC><URI>${opts.uri}</URI>` +
  `<CTS_PROJECTS/></DATA></asx:values></asx:abap>`;

/** `allowTransports: ["auto"]` — the caller never names a corr_nr in cases 1/2/4. */
const gate = () =>
  new SafetyGate({ readOnly: false, allowPackages: ["ZPKG"], allowTransports: ["auto"] });
/** `allowTransports: ["*"]` — case 3 alone needs the caller to be able to NAME a corr_nr. */
const wildcardGate = () =>
  new SafetyGate({ readOnly: false, allowPackages: ["ZPKG"], allowTransports: ["*"] });

const authorizeCreate = (g: SafetyGate) => (devClass: string) =>
  g.authorize("transport", { name: devClass, packageName: devClass }, { corr: { kind: "unresolved" } });

/** Only `status`/`owner`/`tasks` are read by `#checkUsable`/`#probe`; the rest satisfies `TrRequest`. */
const trRequest = (trkorr: string, status: TrStatus, owner = "DEVELOPER"): TrRequest => ({
  trkorr,
  kind: "workbench",
  kindRaw: "K",
  status,
  statusRaw: status === "released" ? "R" : "D",
  owner,
  description: "a request the session created earlier",
  tasks: [],
  objects: [],
});

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

// ---------------------------------------------------------------------------
// Single-object delete: ZMCP_DEL_CORR_NOTE / ZPKG.
// ---------------------------------------------------------------------------

const REPORT = "ZMCP_DEL_CORR_NOTE";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_del_corr_note";
const REPORT_SRC = `${REPORT_URI}/source/main`;
const SOURCE = "REPORT zmcp_del_corr_note.\nWRITE: / 'a'.\n";

/**
 * GET metadata, GET source (pre-lock, post-lock, then the post-delete
 * read-back), LOCK, UNLOCK, DELETE. The third+ source read answers 404 —
 * that is what makes `deleted: true` rather than throwing on `deleted: false`
 * (see test/delete-verification.test.ts's `deleteObject` section for the
 * same shape).
 */
function deleteRoute(state: { lockCorrNr: string }): Route {
  let sourceReads = 0;
  return (r) => {
    if (r.url === REPORT_URI && r.method === "GET")
      return resp(200, OBJECT_XML(REPORT, "PROG/P", "ZPKG"), OK_XML);
    if (r.url === REPORT_SRC && r.method === "GET") {
      sourceReads += 1;
      if (sourceReads <= 2) return resp(200, SOURCE, OK_TEXT);
      return resp(404, "", OK_XML);
    }
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H1", state.lockCorrNr), LOCK_HEADERS);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.method === "DELETE") return resp(200, "", {});
    return undefined;
  };
}

const transportChecksRoute = (state: {
  candidates: ReadonlyArray<{ trkorr: string; owner: string }>;
}): Route => (r) => {
  if (r.url === TRANSPORTCHECKS && r.method === "POST")
    return resp(
      200,
      transportChecksXml({
        objectName: REPORT,
        uri: REPORT_SRC,
        devclass: "ZPKG",
        candidates: state.candidates,
      }),
      OK_XML,
    );
  return undefined;
};

describe("abap_write mode=delete — corr_nr not honoured (issue #65)", () => {
  it("a delete whose auto-resolved request differs from the lock's says the number was not used", async () => {
    const T1 = "A4HK900101"; // what the lock names — CTS records the deletion here
    const T3 = "A4HK900103"; // what the session auto-resolved and sent on the wire
    const state = { lockCorrNr: T1, candidates: [] as ReadonlyArray<{ trkorr: string; owner: string }> };
    const { conn } = await connected((r) => transportChecksRoute(state)(r) ?? deleteRoute(state)(r));

    const trCreate = vi.fn(async () => ({ trkorr: T3, path: `/x/${T3}` }));
    const trShow = vi.fn(async (_conn: AbapConnection, tr: string) => trRequest(tr, "modifiable"));
    const g = gate();
    const transport = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate: authorizeCreate(g),
      whoami: () => "DEVELOPER",
      cts: { trCreate, trShow },
    });

    const res = await abapWrite(
      conn,
      { mode: "delete", object: REPORT, type: "PROG/P" },
      20_000,
      g,
      undefined,
      transport,
    );

    expect(res.text).toContain("corr_nr_honoured: false");
    expect(res.text).toContain(`corr_nr ${T3} was not used:`);
    expect(res.text).toContain(`was locked by transport request ${T1}`);
    expect(res.text).toContain("abapsmith did NOT re-read either request");
    // The false claim this pins: the number the write sent is NOT the number
    // CTS recorded the deletion under, so the ordinary note's clause must be gone.
    expect(res.text).not.toContain("That is the number this write sent");
  });

  it("the ordinary delete (lock names the same request the call sent) is unchanged", async () => {
    const T1 = "A4HK900111";
    const state = { lockCorrNr: T1, candidates: [] as ReadonlyArray<{ trkorr: string; owner: string }> };
    const { conn } = await connected((r) => transportChecksRoute(state)(r) ?? deleteRoute(state)(r));

    const trCreate = vi.fn(async () => ({ trkorr: T1, path: `/x/${T1}` }));
    const trShow = vi.fn(async (_conn: AbapConnection, tr: string) => trRequest(tr, "modifiable"));
    const g = gate();
    const transport = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate: authorizeCreate(g),
      whoami: () => "DEVELOPER",
      cts: { trCreate, trShow },
    });

    const res = await abapWrite(
      conn,
      { mode: "delete", object: REPORT, type: "PROG/P" },
      20_000,
      g,
      undefined,
      transport,
    );

    expect(res.text).not.toContain("corr_nr_honoured");
    expect(res.text).toContain(
      "That is the number this write sent, after the safety gate approved it",
    );
    expect(res.text).toMatch(new RegExp(`^transport: ${T1}$`, "m"));
  });

  it("a named corr_nr that cannot be honoured surfaces as a refusal through the tool, not as a success", async () => {
    const T1 = "A4HK900121"; // what the lock names
    const T2 = "A4HK900122"; // what the caller named — cannot be honoured
    const state = { lockCorrNr: T1, candidates: [] as ReadonlyArray<{ trkorr: string; owner: string }> };
    const { conn, adt } = await connected((r) => transportChecksRoute(state)(r) ?? deleteRoute(state)(r));

    const trCreate = vi.fn(async () => {
      throw new Error("trCreate must not be called: the caller named a corr_nr");
    });
    const trShow = vi.fn(async (_conn: AbapConnection, tr: string) => trRequest(tr, "modifiable"));
    const g = wildcardGate();
    const transport = new SessionTransport({
      allowTransports: ["*"],
      authorizeCreate: authorizeCreate(g),
      whoami: () => "DEVELOPER",
      cts: { trCreate, trShow },
    });

    const e = await catchErr(
      abapWrite(
        conn,
        { mode: "delete", object: REPORT, type: "PROG/P", corr_nr: T2 },
        20_000,
        g,
        undefined,
        transport,
      ),
    );

    expect(e.code).toBe("TRANSPORT_ERROR");
    expect(e.details.reason).toBe("CORR_NR_NOT_HONOURED");
    expect(trCreate).not.toHaveBeenCalled();
    expect(adt.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Batch delete: `abapWriteBatchDelete` directly, one object — same tool-layer
// suffix, exercised through the real entry point rather than `abapWrite`'s
// `objects` dispatch (which requires 2+ entries; the underlying function
// itself accepts one, and that is all this line needs to prove).
// ---------------------------------------------------------------------------

const REPORT_B = "ZMCP_DEL_CORR_BATCH";
const REPORT_B_URI = "/sap/bc/adt/programs/programs/zmcp_del_corr_batch";
const REPORT_B_SRC = `${REPORT_B_URI}/source/main`;
const SOURCE_B = "REPORT zmcp_del_corr_batch.\nWRITE: / 'a'.\n";

function deleteRouteB(state: { lockCorrNr: string }): Route {
  let sourceReads = 0;
  return (r) => {
    if (r.url === REPORT_B_URI && r.method === "GET")
      return resp(200, OBJECT_XML(REPORT_B, "PROG/P", "ZPKG"), OK_XML);
    if (r.url === REPORT_B_SRC && r.method === "GET") {
      sourceReads += 1;
      if (sourceReads <= 2) return resp(200, SOURCE_B, OK_TEXT);
      return resp(404, "", OK_XML);
    }
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H2", state.lockCorrNr), LOCK_HEADERS);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.method === "DELETE") return resp(200, "", {});
    return undefined;
  };
}

const transportChecksRouteB = (state: {
  candidates: ReadonlyArray<{ trkorr: string; owner: string }>;
}): Route => (r) => {
  if (r.url === TRANSPORTCHECKS && r.method === "POST")
    return resp(
      200,
      transportChecksXml({
        objectName: REPORT_B,
        uri: REPORT_B_SRC,
        devclass: "ZPKG",
        candidates: state.candidates,
      }),
      OK_XML,
    );
  return undefined;
};

describe("abap_write batch delete (`objects`) — corr_nr not honoured, flagged per object", () => {
  it("flags the object's line in the OBJECTS body when its auto-resolved request differs from the lock's", async () => {
    const T1 = "A4HK900201"; // what the lock names
    const T3 = "A4HK900203"; // what the session auto-resolved and sent on the wire
    const state = { lockCorrNr: T1, candidates: [] as ReadonlyArray<{ trkorr: string; owner: string }> };
    const { conn } = await connected((r) => transportChecksRouteB(state)(r) ?? deleteRouteB(state)(r));

    const trCreate = vi.fn(async () => ({ trkorr: T3, path: `/x/${T3}` }));
    const trShow = vi.fn(async (_conn: AbapConnection, tr: string) => trRequest(tr, "modifiable"));
    const g = gate();
    const transport = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate: authorizeCreate(g),
      whoami: () => "DEVELOPER",
      cts: { trCreate, trShow },
    });

    const res = await abapWriteBatchDelete(
      conn,
      [{ object: REPORT_B, type: "PROG/P" }],
      20_000,
      g,
      undefined,
      transport,
    );

    expect(res.text).toContain("--- OBJECTS ---");
    expect(res.text).toContain(
      `(corr_nr ${T3} was not used — ${REPORT_B} was locked by ${T1} and CTS recorded the deletion there)`,
    );
  });
});
