/**
 * Proves the healed-request sentence `SessionTransport.#resolveAuto`
 * prefixes onto its grant survives all the way into `abap_write`'s RESPONSE
 * TEXT. test/session-transport-revalidate.test.ts pins the resolver's own
 * `SessionTrResolution.reason`; nothing else drives `abapWrite`
 * (src/tools/write.ts) end to end through a REAL `SessionTransport` whose
 * `trRequirement` hits the wire, which is what it takes to show the sentence
 * is not lost between the resolver and the caller.
 *
 * Only `trCreate` and `trShow` are injected; the candidate list is parsed by
 * the real `checkCandidates`/`headerFromCheck` (src/adt/transports.ts) from
 * XML built inline below, in the `REQUESTS/CTS_REQUEST/REQ_HEADER` shape shown
 * by test/fixtures/cts/transport-info-transportable.xml.
 *
 * Both tests run TWO writes against ONE `SessionTransport` and one connection:
 * the bug was about a warm process whose cached request went away underneath
 * it, so a single cold write cannot reach it.
 *
 * Harness idiom copied from test/write-package.test.ts's `connected()` /
 * `FakeAdt` / `resp()`.
 */
import { describe, expect, it, vi } from "vitest";
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
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequest, TrStatus } from "../src/adt/transports.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

const REPORT = "ZMCP_TR_NOTE";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_tr_note";
const REPORT_SRC = `${REPORT_URI}/source/main`;
const TRANSPORTCHECKS = "/sap/bc/adt/cts/transportchecks";

const SOURCE_A = "REPORT zmcp_tr_note.\nWRITE: / 'a'.\n";
const SOURCE_B = "REPORT zmcp_tr_note.\nWRITE: / 'b'.\n";

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

const CLEAN_CHECKRUN = `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`;

const LOCK_XML = (handle: string, corrNr: string) =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL/><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

/**
 * The `POST /sap/bc/adt/cts/transportchecks` pre-flight response, in the
 * `REQUESTS/CTS_REQUEST/REQ_HEADER` shape `checkCandidates`/`headerFromCheck`
 * (src/adt/transports.ts) parse — element names and nesting taken from
 * test/fixtures/cts/transport-info-transportable.xml, one `CTS_REQUEST` per
 * candidate.
 */
const transportChecksXml = (opts: {
  devclass: string;
  candidates: ReadonlyArray<{ trkorr: string; owner: string; text?: string }>;
}): string =>
  `<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">` +
  `<asx:values><DATA><PGMID>LIMU</PGMID><OBJECT>REPS</OBJECT><OBJECTNAME>${REPORT}</OBJECTNAME>` +
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
  `</REQUESTS><LOCKS/><TADIRDEVC>${opts.devclass}</TADIRDEVC><URI>${REPORT_URI}/source/main</URI>` +
  `<CTS_PROJECTS/></DATA></asx:values></asx:abap>`;

const gate = () =>
  new SafetyGate({ readOnly: false, allowPackages: ["ZPKG"], allowTransports: ["auto"] });

const authorizeCreate = (devClass: string) =>
  gate().authorize(
    "transport",
    { name: devClass, packageName: devClass },
    { corr: { kind: "unresolved" } },
  );

/** Only `status` is read by `#probe`; the rest satisfies `TrRequest`. */
const trRequest = (trkorr: string, status: TrStatus): TrRequest => ({
  trkorr,
  kind: "workbench",
  kindRaw: "K",
  status,
  statusRaw: status === "released" ? "R" : "D",
  owner: "DEVELOPER",
  description: "a request the session created earlier",
  tasks: [],
  objects: [],
});

/**
 * GET metadata, GET/re-GET source, LOCK, PUT, UNLOCK — everything but the
 * transportchecks call. The CORRNR the lock reports is read fresh from
 * `state` on every call, because it is what `abap_write` prints as
 * `transport:` and it changes between the two writes of a test.
 */
const writeRoute = (state: { lockCorrNr: string }): Route => (r) => {
  if (r.url === REPORT_URI && r.method === "GET")
    return resp(200, OBJECT_XML(REPORT, "PROG/P", "ZPKG"), OK_XML);
  if (r.url === REPORT_SRC && r.method === "GET") return resp(200, SOURCE_A, OK_TEXT);
  if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H1", state.lockCorrNr), OK_XML);
  if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
  if (r.url === REPORT_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
  if (r.url.includes("/checkruns")) return resp(200, CLEAN_CHECKRUN, OK_XML);
  return undefined;
};

const write = (conn: AbapConnection, transport: SessionTransport) =>
  abapWrite(
    conn,
    { object: REPORT, type: "PROG/P", source: SOURCE_B, activate: false },
    20_000,
    gate(),
    undefined,
    transport,
  );

describe("abap_write response text carries the session-transport provenance note", () => {
  it("names the released request it swapped out, and the fresh one it created instead", async () => {
    const first = "A4HK900131";
    const second = "A4HK900199";
    const state = {
      lockCorrNr: first,
      candidates: [] as ReadonlyArray<{ trkorr: string; owner: string }>,
    };
    const { conn, adt } = await connected((r) => {
      if (r.url === TRANSPORTCHECKS && r.method === "POST")
        return resp(
          200,
          transportChecksXml({ devclass: "ZPKG", candidates: state.candidates }),
          OK_XML,
        );
      return writeRoute(state)(r);
    });

    const created: string[] = [first, second];
    const trCreate = vi.fn(async () => {
      const trkorr = created.shift() as string;
      return { trkorr, path: `/x/${trkorr}` };
    });
    const trShow = vi.fn(async (_conn: AbapConnection, trkorr: string) =>
      trRequest(trkorr, "released"),
    );
    const transport = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trCreate, trShow },
    });

    const cold = await write(conn, transport);
    expect(cold.text).toMatch(new RegExp(`^transport: ${first}$`, "m"));
    expect(transport.trkorr).toBe(first);
    expect(trShow).not.toHaveBeenCalled();

    // Somebody released `first` out from under the session, and CTS now offers
    // an unrelated request instead — the non-empty list that no longer names
    // `first` is what makes the resolver probe.
    state.candidates = [{ trkorr: "A4HK900177", owner: "DEVELOPER" }];
    state.lockCorrNr = second;

    const warm = await write(conn, transport);

    expect(warm.text).toMatch(new RegExp(`^transport: ${second}$`, "m"));
    expect(warm.text).toMatch(
      new RegExp(`previous request ${first} is no longer usable \\(released\\)`),
    );
    expect(warm.text).toContain(`Created request ${second}`);
    expect(trShow).toHaveBeenCalledWith(expect.anything(), first);
    expect(trCreate).toHaveBeenCalledTimes(2);
    // One pre-flight per write: the heal happened inside the second one, not
    // by re-entering resolve().
    expect(adt.calls.filter((c) => c.method === "POST" && c.url === TRANSPORTCHECKS)).toHaveLength(
      2,
    );
  });

  it("reuses a request the candidate list still corroborates, without probing or creating again", async () => {
    const trkorr = "A4HK900131";
    const state = {
      lockCorrNr: trkorr,
      candidates: [] as ReadonlyArray<{ trkorr: string; owner: string }>,
    };
    const { conn } = await connected((r) => {
      if (r.url === TRANSPORTCHECKS && r.method === "POST")
        return resp(
          200,
          transportChecksXml({ devclass: "ZPKG", candidates: state.candidates }),
          OK_XML,
        );
      return writeRoute(state)(r);
    });

    const trCreate = vi.fn(async () => ({ trkorr, path: `/x/${trkorr}` }));
    const trShow = vi.fn(async (_conn: AbapConnection, tr: string) =>
      trRequest(tr, "modifiable"),
    );
    const transport = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trCreate, trShow },
    });

    await write(conn, transport);
    state.candidates = [{ trkorr, owner: "DEVELOPER" }];
    const warm = await write(conn, transport);

    expect(warm.text).toMatch(new RegExp(`^transport: ${trkorr}$`, "m"));
    expect(warm.text).toContain(`Reusing this session's request ${trkorr}`);
    expect(warm.text).not.toMatch(/no longer usable/);
    expect(trShow).not.toHaveBeenCalled();
    expect(trCreate).toHaveBeenCalledTimes(1);
  });
});
