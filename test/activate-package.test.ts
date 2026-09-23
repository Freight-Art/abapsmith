/**
 * `abap_activate`'s `package` form (#217): activate every inactive object of
 * a package, intersected with the caller's own inactive worklist. Harness
 * copied from test/activate.test.ts (RoutingClient, connect/connectWrite,
 * OBJECT_META, LOGON_ROUTE) and test/activate-affects-preflight.test.ts
 * (registerActivateTools handler harness via InMemoryTransport).
 */
import { describe, expect, it, vi } from "vitest";
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
import { abapActivate, registerActivateTools, type ActivateToolDeps } from "../src/tools/activate.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// --------------------------------------------------------------- fixtures ---

const CLASS_URI = "/sap/bc/adt/oo/classes/zcl_as_t217";
const PROG_URI = "/sap/bc/adt/programs/programs/zas_r217";

/** Two inactive entries, same user, both in the non-DDIC chunk class. */
const inactiveXml = (opts: { classDeleted?: boolean } = {}): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects">` +
  `<ioc:entry><ioc:object ioc:user="ABAPSMITH" ioc:deleted="${opts.classDeleted ? "true" : "false"}">` +
  `<ioc:ref adtcore:uri="${CLASS_URI}" adtcore:type="CLAS/OC" adtcore:name="ZCL_AS_T217" xmlns:adtcore="http://www.sap.com/adt/core"/>` +
  `</ioc:object><ioc:transport/></ioc:entry>` +
  `<ioc:entry><ioc:object ioc:user="ABAPSMITH" ioc:deleted="false">` +
  `<ioc:ref adtcore:uri="${PROG_URI}" adtcore:type="PROG/P" adtcore:name="ZAS_R217" xmlns:adtcore="http://www.sap.com/adt/core"/>` +
  `</ioc:object><ioc:transport/></ioc:entry>` +
  `</ioc:inactiveObjects>`;

const EMPTY_INACTIVE_XML =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects"/>';

const NODE_FIXTURE = {
  nodes: [
    { OBJECT_TYPE: "CLAS/OC", OBJECT_NAME: "ZCL_AS_T217", OBJECT_URI: CLASS_URI },
    { OBJECT_TYPE: "PROG/P", OBJECT_NAME: "ZAS_R217", OBJECT_URI: PROG_URI },
  ],
};

const OBJECT_META = (name: string, type: string, packageName = "ZAS_PKG213"): string =>
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

const onInactiveList: Route["match"] = (o) => o.url.includes("/sap/bc/adt/activation/inactiveobjects");
// `.../activation/inactiveobjects` is a GET substring of `.../activation` —
// require POST so the activation-count assertions below don't double-count it.
const onActivation: Route["match"] = (o) => o.method === "POST" && o.url.includes("/sap/bc/adt/activation");
const onDataPreview: Route["match"] = (o) => o.url.includes("/sap/bc/adt/datapreview/freestyle");
const onLogon: Route["match"] = (o) => o.url.includes("/sap/bc/adt/compatibility/graph");
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
const LOGON_ROUTE: Route = { match: onLogon, reply: resp(200, "<graph/>", LOGIN_HEADERS) };
const T000_ROUTE: Route = { match: onDataPreview, reply: resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML) };
const ACTIVATION_CLEAN: Route = { match: onActivation, reply: resp(200, "", { "content-length": "0" }) };

async function connectWrite(routes: Route[]): Promise<{ conn: AbapConnection; http: RoutingClient }> {
  const http = new RoutingClient([...routes, T000_ROUTE]);
  const conn = new AbapConnection(ConfigSchema.parse({ ...cfg(), readOnly: false }), {
    httpClient: http,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  return { conn, http };
}

/** Spies `conn.adt.nodeContents` against a real connection's vendor client. */
function spyPackageNodes(conn: AbapConnection, nodes: typeof NODE_FIXTURE = NODE_FIXTURE): void {
  vi.spyOn(conn.adt, "nodeContents").mockResolvedValue(nodes as never);
}

const gate = () => new SafetyGate({ readOnly: false, allowPackages: ["ZAS_PKG213"] });

// ----------------------------------------------------------------- tests ---

describe("abapActivate — package form (#217)", () => {
  it("`package` + `object` together: BAD_INPUT, zero requests", async () => {
    const { conn, http } = await connectWrite([]);
    const before = http.calls.length;
    const e = await abapActivate(
      conn,
      { package: "ZAS_PKG213", object: "ZCL_AS_T217" },
      100_000,
      gate(),
    ).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(isAbapError(e)).toBe(true);
    expect((e as AbapError).code).toBe("BAD_INPUT");
    expect((e as AbapError).details).toEqual({ stray: ["object"] });
    expect(http.calls.length).toBe(before);
  });

  it("`package` + `objects`: BAD_INPUT, zero requests", async () => {
    const { conn, http } = await connectWrite([]);
    const before = http.calls.length;
    const e = await abapActivate(
      conn,
      { package: "ZAS_PKG213", objects: [{ object: "ZCL_AS_T217" }] },
      100_000,
      gate(),
    ).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(isAbapError(e)).toBe(true);
    expect((e as AbapError).code).toBe("BAD_INPUT");
    expect(http.calls.length).toBe(before);
  });

  it("`recursive` without `package`: BAD_INPUT", async () => {
    const { conn, http } = await connectWrite([]);
    const before = http.calls.length;
    const e = await abapActivate(conn, { recursive: true, object: "ZCL_AS_T217" }, 100_000, gate()).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(isAbapError(e)).toBe(true);
    expect((e as AbapError).code).toBe("BAD_INPUT");
    expect(http.calls.length).toBe(before);
  });

  it("`package` with mode=check: BAD_INPUT", async () => {
    const { conn, http } = await connectWrite([]);
    const before = http.calls.length;
    const e = await abapActivate(conn, { package: "ZAS_PKG213", mode: "check" }, 100_000, gate()).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(isAbapError(e)).toBe(true);
    expect((e as AbapError).code).toBe("BAD_INPUT");
    expect(http.calls.length).toBe(before);
  });

  it("package activation sends ONE activation request naming both inactive objects of the package", async () => {
    const { conn, http } = await connectWrite([
      LOGON_ROUTE,
      { match: onInactiveList, reply: resp(200, inactiveXml(), XML) },
      { match: (o) => o.url === CLASS_URI, reply: resp(200, OBJECT_META("ZCL_AS_T217", "CLAS/OC"), XML) },
      { match: (o) => o.url === PROG_URI, reply: resp(200, OBJECT_META("ZAS_R217", "PROG/P"), XML) },
      ACTIVATION_CLEAN,
    ]);
    spyPackageNodes(conn);

    const res = await abapActivate(conn, { package: "ZAS_PKG213" }, 100_000, gate());

    const activationCalls = http.calls.filter(onActivation);
    expect(activationCalls).toHaveLength(1);
    const body = String(activationCalls[0]!.body ?? "");
    expect(body).toContain(CLASS_URI);
    expect(body).toContain(PROG_URI);
    expect(res.text).toContain("package: ZAS_PKG213");
    expect(res.text).toContain("count: 2");
  });

  it("objects pending deletion are skipped and reported", async () => {
    const { conn, http } = await connectWrite([
      LOGON_ROUTE,
      { match: onInactiveList, reply: resp(200, inactiveXml({ classDeleted: true }), XML) },
      { match: (o) => o.url === PROG_URI, reply: resp(200, OBJECT_META("ZAS_R217", "PROG/P"), XML) },
      ACTIVATION_CLEAN,
    ]);
    spyPackageNodes(conn);

    const res = await abapActivate(conn, { package: "ZAS_PKG213" }, 100_000, gate());

    const activationCalls = http.calls.filter(onActivation);
    expect(activationCalls).toHaveLength(1);
    const body = String(activationCalls[0]!.body ?? "");
    expect(body).not.toContain(CLASS_URI);
    expect(body).toContain(PROG_URI);
    expect(res.text).toContain("pending deletion");
    expect(res.text).toContain("ZCL_AS_T217");
  });

  it("nothing inactive: no activation request, header result nothing to activate, count 0", async () => {
    const { conn, http } = await connectWrite([
      LOGON_ROUTE,
      { match: onInactiveList, reply: resp(200, EMPTY_INACTIVE_XML, XML) },
    ]);
    spyPackageNodes(conn);

    const res = await abapActivate(conn, { package: "ZAS_PKG213" }, 100_000, gate());

    expect(http.calls.some(onActivation)).toBe(false);
    expect(res.text).toContain("result: nothing to activate");
    expect(res.text).toContain("count: 0");
  });
});

// -------------------------------------------------------- handler level ---

function harness(gateArg: SafetyGate) {
  let writeCalls = 0;
  const deps: ActivateToolDeps = {
    pool: {
      withRead: async <T>(): Promise<T> => {
        throw new Error("withRead should not be reached in this test");
      },
      withWrite: async <T>(): Promise<T> => {
        writeCalls += 1;
        return { text: "stub: reached pool.withWrite", truncated: false } as unknown as T;
      },
    } as never,
    safety: gateArg,
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: 50_000 },
    transport: undefined as never,
    journal: new Journal({ dir: "/tmp/abapsmith-activate-package-preflight", enabled: false, maxEntries: 0, maxAgeDays: 0 }, "TST"),
  };
  const server = new McpServer({ name: "activate-package-probe", version: "0.0.0" });
  registerActivateTools(server, deps);
  const call = async (args: Record<string, unknown>): Promise<string> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "activate-package-probe", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const res = await client.callTool({ name: "abap_activate", arguments: args });
    const first = Array.isArray(res.content) ? res.content[0] : undefined;
    return first && typeof first === "object" && "text" in first ? String((first as { text: unknown }).text) : "";
  };
  return { call, writes: () => writeCalls };
}

describe("registerActivateTools: package form read-only refusal (#217)", () => {
  it("read-only mode: package form refused before any request", async () => {
    const readOnlyGate = new SafetyGate({ readOnly: true, allowPackages: ["ZAS_PKG213"] });
    const h = harness(readOnlyGate);
    const text = await h.call({ package: "ZAS_PKG213" });
    expect(text).toMatch(/READ_ONLY|SAFETY_DENIED/);
    expect(h.writes()).toBe(0);
  });
});
