/**
 * `abap_search inactive=true` (#217): list inactive objects of a package.
 * Covers `parseInactiveObjectsXml`/`listInactiveObjectsOfPackage`
 * (src/adt/object-search.ts, src/adt/inactive-objects.ts), `abapSearch`'s
 * inactive dispatch (src/tools/search.ts), and `registerSearchTools`'s
 * zero-wire preflight rules. Harness copied from test/activate-package.test.ts
 * (RoutingClient/connect) and test/search-source-dispatch.test.ts (fakeMcp/
 * depsFor/registered handler harness).
 */
import { describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import { errorResult } from "../src/server.js";
import { parseInactiveObjectsXml } from "../src/adt/object-search.js";
import { listInactiveObjectsOfPackage } from "../src/adt/inactive-objects.js";
import { abapSearch, registerSearchTools, type SearchToolDeps } from "../src/tools/search.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// --------------------------------------------------------------- fixtures ---

const TABLE_URI = "/sap/bc/adt/ddic/tables/zas_t217";
const CLASS_URI = "/sap/bc/adt/oo/classes/zcl_as_t217";

/** Hand-built in the shape A4H answered on 2026-09-23 — one DDIC table, one class, same user. */
const TWO_ENTRY_XML =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects">' +
  '<ioc:entry><ioc:object ioc:user="ABAPSMITH" ioc:deleted="false">' +
  `<ioc:ref adtcore:uri="${TABLE_URI}" adtcore:type="TABL/DT" adtcore:name="ZAS_T217" xmlns:adtcore="http://www.sap.com/adt/core"/>` +
  "</ioc:object><ioc:transport/></ioc:entry>" +
  '<ioc:entry><ioc:object ioc:user="ABAPSMITH" ioc:deleted="false">' +
  `<ioc:ref adtcore:uri="${CLASS_URI}" adtcore:type="CLAS/OC" adtcore:name="ZCL_AS_T217" xmlns:adtcore="http://www.sap.com/adt/core"/>` +
  "</ioc:object><ioc:transport/></ioc:entry>" +
  "</ioc:inactiveObjects>";

const EMPTY_XML =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects"/>';

const DELETED_ENTRY_XML =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects">' +
  '<ioc:entry><ioc:object ioc:user="ABAPSMITH" ioc:deleted="true">' +
  `<ioc:ref adtcore:uri="${CLASS_URI}" adtcore:type="CLAS/OC" adtcore:name="ZCL_AS_T217" xmlns:adtcore="http://www.sap.com/adt/core"/>` +
  "</ioc:object><ioc:transport/></ioc:entry>" +
  "</ioc:inactiveObjects>";

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

async function catchAbapAsync(fn: () => Promise<unknown>): Promise<AbapError> {
  const e = await fn().then(
    () => undefined,
    (x: unknown) => x,
  );
  if (isAbapError(e)) return e;
  throw new Error(`expected an AbapError, got ${String(e)}`);
}

// ----------------------------------------------------------------- tests ---

describe("parseInactiveObjectsXml", () => {
  it("parses the two-entry fixture into two entries with name/type/uri/user/deleted", () => {
    const entries = parseInactiveObjectsXml(TWO_ENTRY_XML);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ name: "ZAS_T217", type: "TABL/DT", uri: TABLE_URI, user: "ABAPSMITH", deleted: false });
    expect(entries[1]).toEqual({ name: "ZCL_AS_T217", type: "CLAS/OC", uri: CLASS_URI, user: "ABAPSMITH", deleted: false });
  });

  it("the empty-list shape (self-closing root) parses to []", () => {
    expect(parseInactiveObjectsXml(EMPTY_XML)).toEqual([]);
  });

  it("ioc:deleted=true parses to deleted: true", () => {
    const entries = parseInactiveObjectsXml(DELETED_ENTRY_XML);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.deleted).toBe(true);
  });
});

describe("listInactiveObjectsOfPackage", () => {
  it("one entry, matched to a package member, carries packageName ZAS_PKG213", async () => {
    const { conn } = await connect([
      LOGON_ROUTE,
      { match: onInactiveList, reply: resp(200, TWO_ENTRY_XML, XML) },
    ]);
    vi.spyOn(conn.adt, "nodeContents").mockResolvedValue({
      nodes: [
        { OBJECT_TYPE: "TABL/DT", OBJECT_NAME: "ZAS_T217", OBJECT_URI: TABLE_URI },
        { OBJECT_TYPE: "CLAS/OC", OBJECT_NAME: "ZCL_AS_T217", OBJECT_URI: CLASS_URI },
      ],
    } as never);

    const listing = await listInactiveObjectsOfPackage(conn, { packageName: "ZAS_PKG213" });

    expect(listing.entries).toHaveLength(2);
    expect(listing.entries.every((e) => e.packageName === "ZAS_PKG213")).toBe(true);
  });

  it("recursive: true walks a DEVC/K child, whose member is included", async () => {
    const { conn } = await connect([
      LOGON_ROUTE,
      { match: onInactiveList, reply: resp(200, TWO_ENTRY_XML, XML) },
    ]);
    const SUB_URI = "/sap/bc/adt/packages/zas_pkg213_sub";
    vi.spyOn(conn.adt, "nodeContents").mockImplementation(async (_type: string, pkg: string) => {
      if (pkg.toUpperCase() === "ZAS_PKG213") {
        return { nodes: [{ OBJECT_TYPE: "DEVC/K", OBJECT_NAME: "ZAS_PKG213_SUB", OBJECT_URI: SUB_URI }] } as never;
      }
      if (pkg.toUpperCase() === "ZAS_PKG213_SUB") {
        return {
          nodes: [
            { OBJECT_TYPE: "TABL/DT", OBJECT_NAME: "ZAS_T217", OBJECT_URI: TABLE_URI },
            { OBJECT_TYPE: "CLAS/OC", OBJECT_NAME: "ZCL_AS_T217", OBJECT_URI: CLASS_URI },
          ],
        } as never;
      }
      return { nodes: [] } as never;
    });

    const listing = await listInactiveObjectsOfPackage(conn, { packageName: "ZAS_PKG213", recursive: true });

    expect(listing.entries).toHaveLength(2);
    expect(listing.entries.every((e) => e.packageName === "ZAS_PKG213_SUB")).toBe(true);
    expect(listing.packages).toContain("ZAS_PKG213_SUB");
  });
});

describe("abapSearch inactive=true", () => {
  async function connWithTwoEntries(): Promise<AbapConnection> {
    const { conn } = await connect([
      LOGON_ROUTE,
      { match: onInactiveList, reply: resp(200, TWO_ENTRY_XML, XML) },
    ]);
    vi.spyOn(conn.adt, "nodeContents").mockResolvedValue({
      nodes: [
        { OBJECT_TYPE: "TABL/DT", OBJECT_NAME: "ZAS_T217", OBJECT_URI: TABLE_URI },
        { OBJECT_TYPE: "CLAS/OC", OBJECT_NAME: "ZCL_AS_T217", OBJECT_URI: CLASS_URI },
      ],
    } as never);
    return conn;
  }

  it("renders a TYPE/NAME/PACKAGE/USER/STATE table, header inactive: true, count: 2", async () => {
    const conn = await connWithTwoEntries();
    const res = await abapSearch(conn, { inactive: true, packages: ["ZAS_PKG213"] }, 4000);
    expect(res.text).toContain("TYPE");
    expect(res.text).toContain("NAME");
    expect(res.text).toContain("PACKAGE");
    expect(res.text).toContain("USER");
    expect(res.text).toContain("STATE");
    expect(res.text).toContain("ZAS_T217");
    expect(res.text).toContain("ZCL_AS_T217");
    expect(res.text).toContain("inactive: true");
    expect(res.text).toContain("count: 2");
  });

  it("query: ZCL_* filters to the class", async () => {
    const conn = await connWithTwoEntries();
    const res = await abapSearch(conn, { inactive: true, packages: ["ZAS_PKG213"], query: "ZCL_*" }, 4000);
    expect(res.text).toContain("ZCL_AS_T217");
    expect(res.text).not.toContain("ZAS_T217");
    expect(res.text).toContain("count: 1");
  });

  it("type: TABL/DT filters to the table", async () => {
    const conn = await connWithTwoEntries();
    const res = await abapSearch(conn, { inactive: true, packages: ["ZAS_PKG213"], type: "TABL/DT" }, 4000);
    expect(res.text).toContain("ZAS_T217");
    expect(res.text).not.toContain("ZCL_AS_T217");
    expect(res.text).toContain("count: 1");
  });

  it("without query and without inactive=true: BAD_INPUT", async () => {
    const { conn } = await connect([]);
    const err = await catchAbapAsync(() => abapSearch(conn, {}, 4000));
    expect(err.code).toBe("BAD_INPUT");
  });
  it("max: discloses the rows it cuts on a TRUNCATED body line and in the header", async () => {
    const conn = await connWithTwoEntries();
    const res = await abapSearch(conn, { inactive: true, packages: ["ZAS_PKG213"], max: 1 }, 4000);
    expect(res.text).toContain("count: 1");
    expect(res.text).toContain("truncated_by_max: true");
    expect(res.text).toContain("--- TRUNCATED --- 1 of 2 inactive object(s) not shown (display cap max=1)");
  });

  it("prints no TRUNCATED line when every row fits", async () => {
    const conn = await connWithTwoEntries();
    const res = await abapSearch(conn, { inactive: true, packages: ["ZAS_PKG213"] }, 4000);
    expect(res.text).not.toContain("--- TRUNCATED ---");
    expect(res.text).not.toContain("truncated_by_max");
  });
});

// -------------------------------------------------------- handler level ---

function fakePool() {
  return {
    withRead: async () => {
      throw new Error("withRead should not be reached in this test");
    },
    withWrite: async () => {
      throw new Error("withWrite should not be reached in this test");
    },
    reserveDebug: () => {
      throw new Error("reserveDebug: not implemented in this fake.");
    },
  } as never;
}

function fakeMcp(): {
  mcp: McpServer;
  tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>;
} {
  const tools = new Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>();
  const mcp = {
    registerTool: (name: string, _config: unknown, handler: (args: unknown) => Promise<CallToolResult>) => {
      tools.set(name, { handler });
      return {} as unknown;
    },
  } as unknown as McpServer;
  return { mcp, tools };
}

const openGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP"],
    allowNamePrefixes: ["*"],
    writesLockedOut: false,
  });

function registerWithCounter(): {
  tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>;
  ensures: () => number;
} {
  let ensures = 0;
  const deps: SearchToolDeps = {
    pool: fakePool(),
    safety: openGate(),
    ensureConnected: async () => {
      ensures += 1;
    },
    errorResult,
    cfg: cfg() as never,
  };
  const { mcp, tools } = fakeMcp();
  registerSearchTools(mcp, deps);
  return { tools, ensures: () => ensures };
}

async function invokeErr(
  tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>,
  args: unknown,
): Promise<Record<string, unknown>> {
  const entry = tools.get("abap_search");
  if (!entry) throw new Error('tool "abap_search" was never registered');
  const result = await entry.handler(args);
  expect(result.isError).toBe(true);
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return JSON.parse(text.text) as Record<string, unknown>;
}

describe("registerSearchTools: inactive=true preflight (#217)", () => {
  it("{inactive:true} without packages: BAD_INPUT before ensureConnected", async () => {
    const { tools, ensures } = registerWithCounter();
    const payload = await invokeErr(tools, { inactive: true });
    expect(payload.error).toBe("BAD_INPUT");
    expect(ensures()).toBe(0);
  });

  it("{inactive:true, packages: [...6 names]}: BAD_INPUT before ensureConnected", async () => {
    const { tools, ensures } = registerWithCounter();
    const packages = ["A", "B", "C", "D", "E", "F"];
    const payload = await invokeErr(tools, { inactive: true, packages });
    expect(payload.error).toBe("BAD_INPUT");
    expect(ensures()).toBe(0);
  });

  it("{query:'Z*', user:'X'}: BAD_INPUT before ensureConnected", async () => {
    const { tools, ensures } = registerWithCounter();
    const payload = await invokeErr(tools, { query: "Z*", user: "X" });
    expect(payload.error).toBe("BAD_INPUT");
    expect(ensures()).toBe(0);
  });

  it("{inactive:true, mode:'source', packages:['A']}: BAD_INPUT before ensureConnected", async () => {
    const { tools, ensures } = registerWithCounter();
    const payload = await invokeErr(tools, { inactive: true, mode: "source", packages: ["A"] });
    expect(payload.error).toBe("BAD_INPUT");
    expect(ensures()).toBe(0);
  });
});
