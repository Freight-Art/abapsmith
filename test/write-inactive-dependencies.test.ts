/**
 * `abapWrite`'s check+activate flow, when the activation reply itself is an
 * `ioc:inactiveObjects` document naming a DIFFERENT object still inactive
 * (e.g. a table the written class depends on): `assertNoErrors` (src/adt/activate.ts)
 * throws CHECK_FAILED with `details.inactive` populated, and `abapWrite`'s
 * catch block (src/tools/write.ts ~2417-2483) re-wraps it with a
 * `details.inactive_dependencies` list and an `abap_activate objects=...` hint.
 * Offline, with a fake `HttpClient` — `FakeAdt` throws loudly on any unrouted
 * request, so a missing route fails the test rather than masking it.
 */
import { afterAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { abapWrite } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { useFluidState } from "./helpers/fluid-classic-fake.js";

const CLASS_NAME = "ZMCP_W217_CL";
const CLASS_URI = "/sap/bc/adt/oo/classes/zmcp_w217_cl";
const CLASS_SRC = `${CLASS_URI}/source/main`;

const SOURCE = `CLASS ${CLASS_NAME} DEFINITION PUBLIC FINAL CREATE PUBLIC.\n` +
  `  PUBLIC SECTION.\n    METHODS run.\nENDCLASS.\n` +
  `CLASS ${CLASS_NAME} IMPLEMENTATION.\n  METHOD run.\n  ENDMETHOD.\nENDCLASS.\n`;

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

type Route = (r: Recorded) => HttpClientResponse | undefined;

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

const LOCK_XML = (handle = "H1", isLocal = "X", corrNr = "") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>${isLocal}</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

const CLEAN_CHECKRUN = `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`;

/** A checkrun reply carrying one syntax error — no inactive objects involved at all. */
const SYNTAX_ERROR_CHECKRUN =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core">` +
  `<chkrun:checkReport chkrun:triggeringUri="${CLASS_URI}">` +
  `<chkrun:checkMessageList>` +
  `<chkrun:checkMessage chkrun:uri="${CLASS_URI}/source/main#start=3,0" chkrun:type="E">` +
  `<chkrun:shortText>Unexpected token.</chkrun:shortText>` +
  `</chkrun:checkMessage>` +
  `</chkrun:checkMessageList>` +
  `</chkrun:checkReport>` +
  `</chkrun:checkRunReports>`;

/**
 * The activation POST reply when the server reports a dependent object still
 * inactive: `TABL/DT ZAS_T217`. Shape confirmed against `ACTIVATION_INACTIVE`
 * in test/activate.test.ts (lines 131-138) — an `ioc:inactiveObjects`
 * document with zero errors, which `activateObject` maps straight into
 * `outcome.inactive` (see `mapInactiveObjects`, src/adt/activate.ts).
 */
const ACTIVATION_INACTIVE_TABL =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">` +
  `<ioc:entry>` +
  `<ioc:object ioc:user="DEVELOPER" ioc:deleted="false">` +
  `<ioc:ref adtcore:uri="/sap/bc/adt/ddic/tables/zas_t217" adtcore:type="TABL/DT" adtcore:name="ZAS_T217" adtcore:parentUri=""/>` +
  `</ioc:object>` +
  `</ioc:entry>` +
  `</ioc:inactiveObjects>`;

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

const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"] });

/** Everything `connect()` needs, plus the class metadata GET; anything else is the test's own route. */
function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  if (r.url === CLASS_URI && r.method === "GET" && !r.qs._action)
    return resp(200, OBJECT_XML(CLASS_NAME, "CLAS/OC", "$TMP"), OK_XML);
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

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

/** An existing class whose source is `current`; lock/unlock/PUT advance it, checkrun is clean. */
const existingClass = (initial: string, activationReply: string): Route => {
  let current = initial;
  return (r) => {
    if (r.url === CLASS_SRC && r.method === "GET") return resp(200, current, OK_TEXT);
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === CLASS_SRC && r.method === "PUT") {
      current = r.body ?? "";
      return resp(200, "", OK_TEXT);
    }
    if (r.url.includes("/checkruns")) return resp(200, CLEAN_CHECKRUN, OK_XML);
    if (r.method === "POST" && r.url.includes("/sap/bc/adt/activation")) return resp(200, activationReply, OK_XML);
    return undefined;
  };
};

describe("abap_write: CHECK_FAILED carries inactive dependencies from the activation reply", () => {
  it("names the inactive dependent, with details.inactive_dependencies and an abap_activate hint", async () => {
    const { conn } = await connected(existingClass(SOURCE, ACTIVATION_INACTIVE_TABL));
    const e = await catchErr(
      abapWrite(conn, { object: CLASS_NAME, type: "CLAS/OC", package: "$TMP", source: SOURCE }, 20_000, gate),
    );

    expect(e.code).toBe("CHECK_FAILED");
    expect(e.message).toContain("Inactive dependencies: TABL/DT ZAS_T217");
    expect(e.details?.inactive_dependencies).toEqual([
      { name: "ZAS_T217", type: "TABL/DT", uri: "/sap/bc/adt/ddic/tables/zas_t217" },
    ]);
    expect(String(e.hint)).toContain("abap_activate objects=");
  });

  it("a plain syntax-error CHECK_FAILED has no inactive_dependencies key at all", async () => {
    const { conn } = await connected((r) => {
      if (r.url === CLASS_SRC && r.method === "GET") return resp(200, SOURCE, OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === CLASS_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url.includes("/checkruns")) return resp(200, SYNTAX_ERROR_CHECKRUN, OK_XML);
      // Activation must never be reached: a failed pre-check stops the flow first.
      return undefined;
    });
    const e = await catchErr(
      abapWrite(conn, { object: CLASS_NAME, type: "CLAS/OC", package: "$TMP", source: SOURCE }, 20_000, gate),
    );

    expect(e.code).toBe("CHECK_FAILED");
    expect(e.details && "inactive_dependencies" in e.details).toBe(false);
    expect(e.message).not.toContain("Inactive dependencies:");
  });
});
