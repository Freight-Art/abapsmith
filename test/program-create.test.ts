/**
 * Issue #178 contract E: PROG/P create with Fixed Point Arithmetic.
 * `buildProgramCreateBody`/`parseFixPointArithmetic` (src/adt/program-create.ts),
 * `WriteOptions.fixedPointArithmetic` (src/adt/write.ts), the `fixed_point_arithmetic`
 * tool param and its PROG/P-only gating (src/tools/write.ts), and the
 * `fixed_point_arithmetic:` header line on a whole-object PROG/P abap_read.
 */
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { authorizeMutation, writeObject } from "../src/adt/write.js";
import { buildProgramCreateBody, parseFixPointArithmetic } from "../src/adt/program-create.js";
import { SafetyGate } from "../src/safety.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { useFluidState } from "./helpers/fluid-classic-fake.js";
import { searchResultsXml } from "./helpers/fake-adt.js";
import type { ResolvedObject } from "../src/adt/resolve.js";

const stub = { object: {} as ResolvedObject, source: "" };

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => stub.object,
}));
vi.mock("../src/adt/source.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/source.js")>()),
  readSource: async () => ({
    source: stub.source,
    serverEtag: '"W/etag"',
    sourceUri: "/sap/bc/adt/programs/programs/ztest/source/main",
  }),
}));
vi.mock("../src/adt/text-pool.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/text-pool.js")>()),
  readTextPool: async () => undefined,
}));

const { abapWrite, WriteInput } = await import("../src/tools/write.js");
const { abapRead, ReadInput } = await import("../src/tools/read.js");

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "programs");
const RSPARAM_DESCRIPTOR = readFileSync(join(FIXTURE_DIR, "rsparam-descriptor.xml"), "utf8");

const REPORT = "ZMCP_TEST_PROG178";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_test_prog178";
const REPORT_SRC = `${REPORT_URI}/source/main`;
const SOURCE_A = "REPORT zmcp_test_prog178.\nWRITE: / 'a'.\n";

const LOCK_XML = (handle = "H1", isLocal = "X", corrNr = "") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>${isLocal}</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">${REPORT} does not exist</message><properties/></exc:exception>`;

const CLEAN_CHECKRUN = `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`;

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
  headers?: Record<string, string>;
}

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

type Route = (r: Recorded) => HttpClientResponse | undefined;

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body, headers: o.headers as Record<string, string> | undefined };
    this.calls.push(rec);
    const res = this.route(rec);
    if (!res) throw new Error(`FakeAdt: unrouted request ${label}`);
    return res;
  }
  get labels(): string[] {
    return this.calls.map((c) => c.label);
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

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

function objectMetaRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.method !== "GET" || r.qs._action || r.url.endsWith("/source/main")) return undefined;
  if (r.url === REPORT_URI) return resp(200, OBJECT_XML(REPORT, "PROG/P"), OK_XML);
  return undefined;
}

async function connected(route: Route, config: Config = cfg()): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r) ?? objectMetaRoute(r));
  const conn = new AbapConnection(config, { httpClient: adt, log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

const DEFAULT_GATE = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
const authWrite = (conn: AbapConnection, target: { type: string; name: string }, gate = DEFAULT_GATE) =>
  authorizeMutation(conn, gate, "write", target as never);

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(() => undefined, (err: unknown) => err);
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

describe("buildProgramCreateBody", () => {
  const BASE = { name: "z_prog", description: "a report", packageName: "$TMP", responsible: "DEVELOPER" };

  it("uppercases the name and includes adtcore:type PROG/P", () => {
    const xml = buildProgramCreateBody({ ...BASE, fixPointArithmetic: true });
    expect(xml).toContain(`adtcore:name="Z_PROG"`);
    expect(xml).toContain(`adtcore:type="PROG/P"`);
    expect(xml).toContain(`adtcore:packageRef adtcore:name="$TMP"`);
  });

  it("emits abapsource:fixPointArithmetic=\"true\" when true", () => {
    const xml = buildProgramCreateBody({ ...BASE, fixPointArithmetic: true });
    expect(xml).toContain(`abapsource:fixPointArithmetic="true"`);
  });

  it("OMITS the attribute entirely when false — does not write =\"false\"", () => {
    const xml = buildProgramCreateBody({ ...BASE, fixPointArithmetic: false });
    expect(xml).not.toContain("fixPointArithmetic");
  });
});

describe("parseFixPointArithmetic", () => {
  it("returns true against the real rsparam-descriptor.xml fixture", () => {
    expect(parseFixPointArithmetic(RSPARAM_DESCRIPTOR)).toBe(true);
  });

  it("returns false against hand-built XML with an explicit =\"false\"", () => {
    const xml = `<program:abapProgram abapsource:fixPointArithmetic="false" adtcore:name="Z"/>`;
    expect(parseFixPointArithmetic(xml)).toBe(false);
  });

  it("returns undefined when the attribute is entirely absent (hand-built)", () => {
    const xml = `<program:abapProgram adtcore:name="Z"/>`;
    expect(parseFixPointArithmetic(xml)).toBeUndefined();
  });
});

describe("writeObject — create with fixedPointArithmetic (src/adt/write.ts WriteOptions)", () => {
  it("fixedPointArithmetic: false — create body omits the attribute", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === "/sap/bc/adt/programs/programs" && r.method === "POST") return resp(200, "", {});
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === REPORT_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    });
    const res = await writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
      source: SOURCE_A,
      fixedPointArithmetic: false,
    });
    expect(res.created).toBe(true);
    const create = adt.calls.find((c) => c.url === "/sap/bc/adt/programs/programs")!;
    expect(create.body).not.toContain("fixPointArithmetic");
  });

  it("fixedPointArithmetic omitted defaults to true — create body carries the attribute", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === "/sap/bc/adt/programs/programs" && r.method === "POST") return resp(200, "", {});
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === REPORT_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    });
    const res = await writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
      source: SOURCE_A,
    });
    expect(res.created).toBe(true);
    const create = adt.calls.find((c) => c.url === "/sap/bc/adt/programs/programs")!;
    expect(create.body).toContain(`abapsource:fixPointArithmetic="true"`);
  });
});

describe("abapWrite — fixed_point_arithmetic/text_pool PROG/P-only gating (src/tools/write.ts)", () => {
  it("zero-network BAD_INPUT: fixed_point_arithmetic with an explicit non-PROG/P type", async () => {
    const { conn, adt } = await connected(() => undefined);
    const input = WriteInput.parse({
      object: "ZMCP_TEST_CLS",
      type: "CLAS/OC",
      source: "irrelevant",
      fixed_point_arithmetic: false,
    });
    const err = await catchErr(abapWrite(conn, input, 20_000, DEFAULT_GATE));
    expect(err.code).toBe("BAD_INPUT");
    expect(adt.calls.length).toBe(0);
  });

  it("zero-network BAD_INPUT: text_pool with an explicit unsupported type names the supported types", async () => {
    const { conn, adt } = await connected(() => undefined);
    const input = WriteInput.parse({
      object: "ZIF_TEST_INTF",
      type: "INTF/OI",
      text_pool: { symbols: { "001": "hi" } },
    });
    const err = await catchErr(abapWrite(conn, input, 20_000, DEFAULT_GATE));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("PROG/P, CLAS/OC and FUGR/F");
    expect(err.message).toContain("INTF/OI");
    expect(adt.calls.length).toBe(0);
  });

  it("post-resolution BAD_INPUT: type omitted, resolved object is not PROG/P", async () => {
    const TAB_URI = "/sap/bc/adt/ddic/tables/zmcp_test_tab178";
    const { conn, adt } = await connected((r) => {
      if (r.url.endsWith("/repository/informationsystem/search"))
        return resp(200, searchResultsXml([{ name: "ZMCP_TEST_TAB178", type: "TABL/DT", uri: TAB_URI }]), OK_XML);
      if (r.url === TAB_URI && r.method === "GET" && !r.qs._action)
        return resp(200, OBJECT_XML("ZMCP_TEST_TAB178", "TABL/DT"), OK_XML);
      return undefined;
    });
    const input = WriteInput.parse({
      object: "ZMCP_TEST_TAB178",
      fixed_point_arithmetic: false,
      source: "irrelevant",
    });
    const err = await catchErr(abapWrite(conn, input, 20_000, DEFAULT_GATE));
    expect(err.code).toBe("BAD_INPUT");
    expect(adt.calls.some((c) => c.url === TAB_URI)).toBe(true);
  });
});

describe("abapWrite — full create through the tool layer with fixed_point_arithmetic:false", () => {
  it("creates a new PROG/P without the fixPointArithmetic attribute, activate:false", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_URI && r.method === "GET" && !r.qs._action) return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === "/sap/bc/adt/programs/programs" && r.method === "POST") return resp(200, "", {});
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === REPORT_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url.includes("/checkruns")) return resp(200, CLEAN_CHECKRUN, OK_XML);
      return undefined;
    });
    const input = WriteInput.parse({
      object: REPORT,
      type: "PROG/P",
      source: SOURCE_A,
      fixed_point_arithmetic: false,
      activate: false,
    });
    await abapWrite(conn, input, 20_000, DEFAULT_GATE);
    const create = adt.calls.find((c) => c.url === "/sap/bc/adt/programs/programs")!;
    expect(create).toBeDefined();
    expect(create.body).not.toContain("fixPointArithmetic");
  });
});

describe("abapRead — fixed_point_arithmetic: header line on a whole-object PROG/P read", () => {
  const conn = {
    cfg: { sid: "A4H" },
    get: async () => ({ body: RSPARAM_DESCRIPTOR }),
  } as unknown as AbapConnection;

  it("adds fixed_point_arithmetic: true, read against the real rsparam-descriptor.xml fixture", async () => {
    stub.object = {
      system: "A4H",
      type: "PROG/P",
      kind: "PROG",
      label: "program",
      name: "RSPARAM",
      uri: "/sap/bc/adt/programs/programs/rsparam",
      mode: "source",
      activation: "unknown",
      spec: {},
    } as unknown as ResolvedObject;
    stub.source = "REPORT rsparam.\n";
    const res = await abapRead(conn, ReadInput.parse({ object: "RSPARAM" }), 20_000);
    expect(res.text).toMatch(/^fixed_point_arithmetic: true$/m);
  });
});
