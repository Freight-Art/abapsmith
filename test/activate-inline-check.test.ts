/**
 * `abap_activate mode=check` with no `object` (#213): check a PROG/P,
 * CLAS/OC or INTF/OI draft inline, matched to a server object by name parsed
 * out of the draft's own REPORT/CLASS/INTERFACE statement. Harness copied
 * from test/activate.test.ts (RoutingClient, connect/connectWrite, fixture
 * shapes) and test/activate-affects-preflight.test.ts (registerActivateTools
 * handler harness via InMemoryTransport).
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { SafetyGate } from "../src/safety.js";
import { Journal } from "../src/journal.js";
import { errorResult } from "../src/server.js";
import {
  abapActivate,
  inlineCheckTarget,
  registerActivateTools,
  type ActivateToolDeps,
} from "../src/tools/activate.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// --------------------------------------------------------------- fixtures ---

const CHECKRUN_CLEAN = `<?xml version="1.0" encoding="utf-8"?>
<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:atom="http://www.w3.org/2005/Atom"/>`;

/** One error, at line 2 col 6 — the position `resp="/.../source/main#start=2,6"` carries. */
const CHECKRUN_ONE_ERROR = `<?xml version="1.0" encoding="utf-8"?>
<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun">
  <chkrun:checkReport chkrun:reporter="abapCheckRun" chkrun:triggeringUri="/sap/bc/adt/programs/programs/zas_213" chkrun:status="processed" chkrun:statusText="">
    <chkrun:checkMessageList>
      <chkrun:checkMessage chkrun:uri="/sap/bc/adt/programs/programs/zas_213/source/main#start=2,6" chkrun:type="E" chkrun:shortText="Field &quot;UNDECLARED&quot; is unknown"/>
    </chkrun:checkMessageList>
  </chkrun:checkReport>
</chkrun:checkRunReports>`;

const NOT_FOUND_XML =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">' +
  '<message lang="EN">ZCL_AS_T217 does not exist</message><properties/></exc:exception>';

const OBJECT_META = (name: string, type: string, packageName = "$TMP"): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="${name}" adtcore:type="${type}">` +
  `<adtcore:packageRef adtcore:name="${packageName}"/>` +
  `</adtcore:objectMetadata>`;

// ------------------------------------------------------------- transport ---

interface Route {
  match: (o: HttpClientOptions) => boolean;
  reply: HttpClientResponse;
}

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const XML = { "content-type": "application/xml; charset=utf-8" };

class RoutingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly routes: Route[]) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    const hit = this.routes.find((r) => r.match(o));
    return hit ? hit.reply : resp(200, "ok", { "content-type": "text/plain" });
  }
}

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
  });

const onCheckruns: Route["match"] = (o) => o.url.includes("/sap/bc/adt/checkruns");
const onDataPreview: Route["match"] = (o) => o.url.includes("/sap/bc/adt/datapreview/freestyle");
const onLogon: Route["match"] = (o) => o.url.includes("/sap/bc/adt/compatibility/graph");
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
const LOGON_ROUTE: Route = { match: onLogon, reply: resp(200, "<graph/>", LOGIN_HEADERS) };

const T000_ROUTE: Route = { match: onDataPreview, reply: resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML) };

async function connect(routes: Route[]): Promise<{ conn: AbapConnection; http: RoutingClient }> {
  const http = new RoutingClient([...routes, T000_ROUTE]);
  const conn = new AbapConnection(cfg(), {
    httpClient: http,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  return { conn, http };
}

/** Run `fn`, require an `AbapError`, hand it back for field-level assertions. */
function catchAbap(fn: () => unknown): AbapError {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected an AbapError, but the call returned normally");
}

// ----------------------------------------------------------------- tests ---

describe("abapActivate — mode=check inline draft (#213)", () => {
  it("PROG/P draft with no findings: one POST to /sap/bc/adt/checkruns, no GET of any object, header result clean", async () => {
    const { conn, http } = await connect([
      LOGON_ROUTE,
      { match: onCheckruns, reply: resp(200, CHECKRUN_CLEAN, XML) },
    ]);
    const before = http.calls.length;
    const source = "REPORT zas_213.\nWRITE 'x'.";
    const gate = new SafetyGate({ readOnly: true, allowPackages: [] });

    const res = await abapActivate(conn, { mode: "check", type: "PROG/P", source }, 100_000, gate);

    const during = http.calls.slice(before);
    expect(during).toHaveLength(1);
    expect(onCheckruns(during[0]!)).toBe(true);
    expect(String(during[0]!.body)).toContain(Buffer.from(source, "utf8").toString("base64"));
    expect(String(during[0]!.body)).toContain("zas_213");
    expect(res.text).toContain("inline: true");
    expect(res.text).toContain("object: PROG/P ZAS_213");
  });

  it("PROG/P draft with one error: finding rendered with line 2 and column, does not throw", async () => {
    const { conn } = await connect([{ match: onCheckruns, reply: resp(200, CHECKRUN_ONE_ERROR, XML) }]);
    const source = "REPORT zas_213.\nWRITE undeclared.";
    const gate = new SafetyGate({ readOnly: true, allowPackages: [] });

    const res = await abapActivate(conn, { mode: "check", type: "PROG/P", source }, 100_000, gate);

    expect(res.text).toContain("errors: 1");
    expect(res.text).toContain("line 2");
    expect(res.text).toContain("col 6");
    expect(res.text).toContain('Field "UNDECLARED" is unknown');
  });

  it("CLAS/OC draft is checked against the existing class", async () => {
    const CLASS_URI = "/sap/bc/adt/oo/classes/zcl_as_t217";
    const { conn, http } = await connect([
      LOGON_ROUTE,
      { match: (o) => o.url === CLASS_URI, reply: resp(200, OBJECT_META("ZCL_AS_T217", "CLAS/OC"), XML) },
      { match: onCheckruns, reply: resp(200, CHECKRUN_CLEAN, XML) },
    ]);
    const source = "CLASS zcl_as_t217 DEFINITION PUBLIC.\nENDCLASS.";
    const gate = new SafetyGate({ readOnly: true, allowPackages: [] });

    const res = await abapActivate(conn, { mode: "check", type: "CLAS/OC", source }, 100_000, gate);

    const checkrunsCall = http.calls.find(onCheckruns)!;
    expect(String(checkrunsCall.body)).toContain(CLASS_URI);
    expect(res.text).toContain("result: clean");
  });

  it("CLAS/OC draft of a class that does not exist: NOT_FOUND, no checkruns POST", async () => {
    const CLASS_URI = "/sap/bc/adt/oo/classes/zcl_as_t217";
    const { conn, http } = await connect([
      LOGON_ROUTE,
      { match: (o) => o.url === CLASS_URI, reply: resp(404, NOT_FOUND_XML, XML) },
    ]);
    const source = "CLASS zcl_as_t217 DEFINITION PUBLIC.\nENDCLASS.";
    const gate = new SafetyGate({ readOnly: true, allowPackages: [] });

    const err = await abapActivate(conn, { mode: "check", type: "CLAS/OC", source }, 100_000, gate).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(isAbapError(err)).toBe(true);
    expect((err as AbapError).code).toBe("NOT_FOUND");
    expect(http.calls.some(onCheckruns)).toBe(false);
  });

  it("TABL/DT inline: UNSUPPORTED naming PROG/P, CLAS/OC, INTF/OI, zero requests via abapActivate", async () => {
    const err = catchAbap(() => inlineCheckTarget("TABL/DT", "x"));
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.details.supported).toEqual(["PROG/P", "CLAS/OC", "INTF/OI"]);

    const { conn, http } = await connect([]);
    const before = http.calls.length;
    const gate = new SafetyGate({ readOnly: true, allowPackages: [] });
    const rejected = await abapActivate(conn, { mode: "check", type: "TABL/DT", source: "x" }, 100_000, gate).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isAbapError(rejected)).toBe(true);
    expect((rejected as AbapError).code).toBe("UNSUPPORTED");
    expect(http.calls.length).toBe(before);
  });

  it("missing type: BAD_INPUT with zero requests", async () => {
    const { conn, http } = await connect([]);
    const before = http.calls.length;
    const gate = new SafetyGate({ readOnly: true, allowPackages: [] });
    const err = await abapActivate(conn, { mode: "check", source: "x" }, 100_000, gate).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isAbapError(err)).toBe(true);
    expect((err as AbapError).code).toBe("BAD_INPUT");
    expect(http.calls.length).toBe(before);
  });

  it("INTF/OI draft name is derived from the INTERFACE statement", () => {
    const t = inlineCheckTarget("INTF/OI", "INTERFACE zif_as_x PUBLIC.");
    expect(t.type).toBe("INTF/OI");
    expect(t.name).toBe("ZIF_AS_X");
  });

  it("object-form mode=check still works unchanged", async () => {
    const PROG_URI = "/sap/bc/adt/programs/programs/zmcp_probe_rep";
    const { conn, http } = await connect([
      LOGON_ROUTE,
      { match: (o) => o.url === PROG_URI, reply: resp(200, OBJECT_META("ZMCP_PROBE_REP", "PROG/P"), XML) },
      { match: onCheckruns, reply: resp(200, CHECKRUN_CLEAN, XML) },
    ]);
    const gate = new SafetyGate({ readOnly: true, allowPackages: [] });

    const res = await abapActivate(
      conn,
      { object: "ZMCP_PROBE_REP", type: "PROG/P", mode: "check", source: "REPORT z." },
      100_000,
      gate,
    );

    expect(res.text).toContain("result: clean");
    expect(http.calls.filter(onCheckruns)).toHaveLength(1);
  });
});

// -------------------------------------------------------- handler level ---

/**
 * `deps.pool.withWrite`/`withRead` never call `fn` — they only count how
 * many times each was reached, matching test/activate-affects-preflight.test.ts's
 * `harnessWithCounter`.
 */
function harness(gate: SafetyGate) {
  let readCalls = 0;
  let writeCalls = 0;
  let ensureCalls = 0;
  const deps: ActivateToolDeps = {
    pool: {
      withRead: async <T>(): Promise<T> => {
        readCalls += 1;
        return { text: "stub: reached pool.withRead", truncated: false } as unknown as T;
      },
      withWrite: async <T>(): Promise<T> => {
        writeCalls += 1;
        return { text: "stub: reached pool.withWrite", truncated: false } as unknown as T;
      },
    } as never,
    safety: gate,
    ensureConnected: async () => {
      ensureCalls += 1;
    },
    errorResult,
    cfg: { maxResponseChars: 50_000 },
    transport: undefined as never,
    journal: new Journal({ dir: "/tmp/abapsmith-activate-inline-preflight", enabled: false, maxEntries: 0, maxAgeDays: 0 }, "TST"),
  };
  const server = new McpServer({ name: "activate-inline-check-probe", version: "0.0.0" });
  registerActivateTools(server, deps);
  const call = async (args: Record<string, unknown>): Promise<string> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "activate-inline-check-probe", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const res = await client.callTool({ name: "abap_activate", arguments: args });
    const first = Array.isArray(res.content) ? res.content[0] : undefined;
    const text = first && typeof first === "object" && "text" in first ? String((first as { text: unknown }).text) : "";
    return text;
  };
  return { call, reads: () => readCalls, writes: () => writeCalls, ensures: () => ensureCalls };
}

const permissiveGate = () => new SafetyGate({ readOnly: true, allowPackages: [] });

describe("registerActivateTools: inline check dispatch (#213)", () => {
  it("{mode:check, type:TABL/DT, source:x} throws before ensureConnected is called", async () => {
    const h = harness(permissiveGate());
    const text = await h.call({ mode: "check", type: "TABL/DT", source: "x" });
    expect(text).toMatch(/UNSUPPORTED/);
    expect(h.ensures()).toBe(0);
    expect(h.reads()).toBe(0);
    expect(h.writes()).toBe(0);
  });

  it("{mode:check, type:PROG/P, source:REPORT z.} runs under pool.withRead, not withWrite", async () => {
    const h = harness(permissiveGate());
    const text = await h.call({ mode: "check", type: "PROG/P", source: "REPORT z." });
    expect(text).toBe("stub: reached pool.withRead");
    expect(h.reads()).toBe(1);
    expect(h.writes()).toBe(0);
    expect(h.ensures()).toBe(1);
  });
});
