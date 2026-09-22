/**
 * #177: `abap_write` can set a function module's `processingType` (rfc vs.
 * normal) via `remote_enabled`, and `abap_read` reports it back.
 *
 * Fixtures (test/fixtures/live-captured/), real A4H captures: 984 module-GET
 * 404 (ZAS_FM_ONE absent), 985/986 group-GET + transportchecks for the $TMP
 * create path (see test/function-module-create-transport.test.ts for their
 * ZTMA_COURSES-transportable siblings — not needed here), 990 an RFC
 * module's descriptor (RFC_PING, processingType rfc), 991 ZAS_FM_ONE's
 * descriptor (processingType normal), 992 the 200 ADT echoes after a
 * descriptor PUT with processingType rfc, 993 the read-back after that PUT
 * (rfc, version inactive).
 *
 * Harness for items 1-6 copied from test/write-transport-note.test.ts (same
 * FakeAdt/connected()/resp() idiom as test/function-module-create-transport.test.ts).
 * Item 8 copied from test/read-docu-fugr-digest.test.ts's `vi.mock` idiom —
 * resolveObject and readSource stubbed, no network.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { abapWrite } from "../src/tools/write.js";
import { parseProcessingType } from "../src/adt/write.js";
import { isAbapError } from "../src/adt/errors.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequest } from "../src/adt/transports.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import type { ResolvedObject } from "../src/adt/resolve.js";

/** For the abap_read describe block below — module-scope so vi.mock's hoisted factories can see it. */
const readStub = {
  object: {} as ResolvedObject,
  source: "",
  descriptor: "",
};

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => readStub.object,
}));

vi.mock("../src/adt/source.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/source.js")>()),
  readSource: async () => ({ source: readStub.source, sourceUri: "" }),
}));

const { abapRead } = await import("../src/tools/read.js");

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const fx = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const FMODULE_404 = fx("984-i171-fmodule-get-404.xml");
const TRANSPORTCHECKS_TMP_LOCKED = fx("986-i171-transportchecks-tmp-locked.xml");
const FMODULE_GET_RFC = fx("990-i177-fmodule-get-rfc-ping.xml");
const FMODULE_GET_NORMAL = fx("991-i177-fmodule-get-normal.xml");
const FMODULE_PUT_RFC_RESPONSE = fx("992-i177-fmodule-put-rfc-response.xml");
const FMODULE_GET_AFTER_RFC_PUT = fx("993-i177-fmodule-get-after-rfc-put.xml");

const GROUP_NAME = "ZAS_FG171";
const MODULE_NAME = "ZAS_FM_ONE";
const OBJECT_REF = `${GROUP_NAME}/${MODULE_NAME}`;
const GROUP_URI = "/sap/bc/adt/functions/groups/zas_fg171";
const MODULE_URI = `${GROUP_URI}/fmodules/zas_fm_one`;
const MODULE_SRC = `${MODULE_URI}/source/main`;
const CREATE_URI = `${GROUP_URI}/fmodules`;
const TRANSPORTCHECKS = "/sap/bc/adt/cts/transportchecks";
const SOURCE = "FUNCTION zas_fm_one.\nENDFUNCTION.\n";

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
  headers?: Record<string, string>;
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
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body, headers: o.headers as Record<string, string> };
    this.calls.push(rec);
    const res = this.route(rec);
    if (!res) throw new Error(`FakeAdt: unrouted request ${label}`);
    return res;
  }
}

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "ABAPSMITH",
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

const CLEAN_CHECKRUN = `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`;

/** The group's own packageRef, read by `containerPackage` — parsePackageRef only cares about this element, not the enclosing root. */
const GROUP_XML_TMP =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<group:abapFunctionGroup xmlns:group="http://www.sap.com/adt/functions/groups" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${GROUP_NAME}" adtcore:type="FUGR/F">` +
  `<adtcore:packageRef adtcore:name="$TMP"/>` +
  `</group:abapFunctionGroup>`;

const LOCK_XML_LOCAL = (handle: string) =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

const gate = () =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransports: ["auto"] });

const authorizeCreate = (devClass: string) =>
  gate().authorize("transport", { name: devClass, packageName: devClass }, { corr: { kind: "unresolved" } });

/** Not exercised on the $TMP path (kind stays "local"); satisfies `SessionTransport`'s config shape. */
const trRequest = (trkorr: string): TrRequest => ({
  trkorr,
  kind: "workbench",
  kindRaw: "K",
  status: "modifiable",
  statusRaw: "D",
  owner: "ABAPSMITH",
  description: "abapsmith session",
  tasks: [],
  objects: [],
});

function makeTransport(): SessionTransport {
  const trCreate = vi.fn(async () => {
    throw new Error("trCreate must not be called on the $TMP path");
  });
  const trShow = vi.fn(async (_conn: AbapConnection, trkorr: string) => trRequest(trkorr));
  return new SessionTransport({
    allowTransports: ["auto"],
    authorizeCreate,
    whoami: () => "ABAPSMITH",
    cts: { trCreate, trShow },
  });
}

describe("abap_write remote_enabled (#177)", () => {
  it("is refused BAD_INPUT for a non-FUGR/FF type before any request", async () => {
    const { conn, adt } = await connected(() => undefined);
    let thrown: unknown;
    try {
      await abapWrite(
        conn,
        { object: "ZAS_RFC_CALL", type: "PROG/P", source: "REPORT zas_rfc_call.\n", remote_enabled: true },
        20_000,
        gate(),
      );
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown)).toBe(true);
    if (isAbapError(thrown)) expect(thrown.code).toBe("BAD_INPUT");
    expect(adt.calls.length).toBe(0);
  });

  it("is refused for mode=delete", async () => {
    const { conn, adt } = await connected(() => undefined);
    let thrown: unknown;
    try {
      await abapWrite(
        conn,
        { object: OBJECT_REF, type: "FUGR/FF", mode: "delete", remote_enabled: true },
        20_000,
        gate(),
      );
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown)).toBe(true);
    if (isAbapError(thrown)) expect(thrown.code).toBe("BAD_INPUT");
    expect(adt.calls.length).toBe(0);
  });

  it("creates an RFC module: source PUT, then the descriptor PUT with processingType rfc under the same lock, then UNLOCK", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === MODULE_URI && r.method === "GET") return resp(404, FMODULE_404, OK_XML);
      if (r.url === GROUP_URI && r.method === "GET") return resp(200, GROUP_XML_TMP, OK_XML);
      if (r.url === TRANSPORTCHECKS && r.method === "POST")
        return resp(200, TRANSPORTCHECKS_TMP_LOCKED, OK_XML);
      if (r.url === CREATE_URI && r.method === "POST") return resp(201, "", OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML_LOCAL("H1"), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === MODULE_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url === MODULE_URI && r.method === "PUT") return resp(200, FMODULE_PUT_RFC_RESPONSE, OK_XML);
      if (r.url.includes("/checkruns")) return resp(200, CLEAN_CHECKRUN, OK_XML);
      return undefined;
    });

    const transport = makeTransport();
    const result = await abapWrite(
      conn,
      { object: OBJECT_REF, type: "FUGR/FF", source: SOURCE, remote_enabled: true, activate: false },
      20_000,
      gate(),
      undefined,
      transport,
    );

    const idx = (pred: (c: Recorded) => boolean) => adt.calls.findIndex(pred);
    const createIdx = idx((c) => c.url === CREATE_URI && c.method === "POST");
    const lockIdx = idx((c) => c.qs._action === "LOCK");
    const srcPutIdx = idx((c) => c.url === MODULE_SRC && c.method === "PUT");
    const descPutIdx = idx((c) => c.url === MODULE_URI && c.method === "PUT");
    const unlockIdx = idx((c) => c.qs._action === "UNLOCK");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeGreaterThan(createIdx);
    expect(srcPutIdx).toBeGreaterThan(lockIdx);
    expect(descPutIdx).toBeGreaterThan(srcPutIdx);
    expect(unlockIdx).toBeGreaterThan(descPutIdx);

    const descPut = adt.calls[descPutIdx]!;
    const srcPut = adt.calls[srcPutIdx]!;
    expect(descPut.headers?.["Content-Type"]).toBe("application/vnd.sap.adt.functions.fmodules.v3+xml");
    expect(descPut.body).toContain('fmodule:processingType="rfc"');
    expect(descPut.body).toContain('adtcore:name="ZAS_FM_ONE"');
    expect(descPut.body).toMatch(/adtcore:containerRef adtcore:uri="\/sap\/bc\/adt\/functions\/groups\/zas_fg171"/);
    expect(descPut.qs.lockHandle).toBe(srcPut.qs.lockHandle);

    expect(result.text).toMatch(/^processing_type: rfc$/m);
  });

  it("sends no descriptor PUT when the module already has the requested processing type", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === MODULE_URI && r.method === "GET") return resp(200, FMODULE_GET_NORMAL, OK_XML);
      if (r.url === GROUP_URI && r.method === "GET") return resp(200, GROUP_XML_TMP, OK_XML);
      if (r.url === MODULE_SRC && r.method === "GET")
        return resp(200, "FUNCTION zas_fm_one.\n  \" old body\nENDFUNCTION.\n", OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML_LOCAL("H1"), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === MODULE_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url.includes("/checkruns")) return resp(200, CLEAN_CHECKRUN, OK_XML);
      return undefined;
    });

    const result = await abapWrite(
      conn,
      { object: OBJECT_REF, type: "FUGR/FF", source: SOURCE, remote_enabled: false, activate: false },
      20_000,
      gate(),
    );

    expect(adt.calls.some((c) => c.url === MODULE_URI && c.method === "PUT")).toBe(false);
    expect(result.text).toMatch(/^processing_type: normal$/m);
  });

  it("changes the processing type even when the source is byte-identical", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === MODULE_URI && r.method === "GET") return resp(200, FMODULE_GET_NORMAL, OK_XML);
      if (r.url === GROUP_URI && r.method === "GET") return resp(200, GROUP_XML_TMP, OK_XML);
      if (r.url === MODULE_SRC && r.method === "GET") return resp(200, SOURCE, OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML_LOCAL("H1"), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === MODULE_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url === MODULE_URI && r.method === "PUT") return resp(200, FMODULE_PUT_RFC_RESPONSE, OK_XML);
      if (r.url.includes("/checkruns")) return resp(200, CLEAN_CHECKRUN, OK_XML);
      return undefined;
    });

    const result = await abapWrite(
      conn,
      { object: OBJECT_REF, type: "FUGR/FF", source: SOURCE, remote_enabled: true, activate: false },
      20_000,
      gate(),
    );

    expect(adt.calls.some((c) => c.qs._action === "LOCK")).toBe(true);
    expect(adt.calls.some((c) => c.url === MODULE_SRC && c.method === "PUT")).toBe(true);
    expect(adt.calls.some((c) => c.url === MODULE_URI && c.method === "PUT")).toBe(true);
    expect(adt.calls.some((c) => c.qs._action === "UNLOCK")).toBe(true);
    expect(result.text).toMatch(/^processing_type: rfc$/m);
  });

  it("omitting remote_enabled leaves the descriptor alone", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === MODULE_URI && r.method === "GET") return resp(200, FMODULE_GET_NORMAL, OK_XML);
      if (r.url === GROUP_URI && r.method === "GET") return resp(200, GROUP_XML_TMP, OK_XML);
      if (r.url === MODULE_SRC && r.method === "GET")
        return resp(200, "FUNCTION zas_fm_one.\n  \" old body\nENDFUNCTION.\n", OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML_LOCAL("H1"), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === MODULE_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url.includes("/checkruns")) return resp(200, CLEAN_CHECKRUN, OK_XML);
      return undefined;
    });

    await abapWrite(
      conn,
      { object: OBJECT_REF, type: "FUGR/FF", source: SOURCE, activate: false },
      20_000,
      gate(),
    );

    expect(adt.calls.some((c) => c.url === MODULE_URI && c.method === "PUT")).toBe(false);
  });

  it("parseProcessingType reads rfc/normal off the live descriptors", () => {
    expect(parseProcessingType(FMODULE_GET_RFC)).toBe("rfc");
    expect(parseProcessingType(FMODULE_GET_NORMAL)).toBe("normal");
    expect(parseProcessingType(FMODULE_GET_AFTER_RFC_PUT)).toBe("rfc");
    expect(parseProcessingType("<x/>")).toBeUndefined();
  });
});

function resolvedFmodule(name: string, uri: string): ResolvedObject {
  return {
    system: "A4H",
    type: "FUGR/FF",
    kind: "FUGR",
    label: "function module",
    name,
    uri,
    sourceUri: `${uri}/source/main`,
    mode: "source",
    activation: "unknown",
    spec: {},
  } as unknown as ResolvedObject;
}

const readConn = {
  cfg: { sid: "A4H" },
  get: async (uri: string) =>
    uri === readStub.object.uri ? { body: readStub.descriptor } : { body: "" },
} as unknown as AbapConnection;

describe("abap_read of a FUGR/FF prints processing_type and remote_enabled (#177)", () => {
  beforeEach(() => {
    readStub.object = resolvedFmodule("RFC_PING", "/sap/bc/adt/functions/groups/srfc/fmodules/rfc_ping");
    readStub.source = "";
    readStub.descriptor = "";
  });

  it("reports rfc/yes for an RFC-enabled module", async () => {
    readStub.source = "FUNCTION rfc_ping.\nENDFUNCTION.\n";
    readStub.descriptor = FMODULE_GET_RFC;
    const r = await abapRead(readConn, { object: "RFC_PING", type: "FUGR/FF" }, 20_000);
    expect(r.text).toMatch(/^processing_type: rfc$/m);
    expect(r.text).toMatch(/^remote_enabled: yes$/m);
  });

  it("reports normal/no for an ordinary module", async () => {
    readStub.object = resolvedFmodule(MODULE_NAME, MODULE_URI);
    readStub.source = SOURCE;
    readStub.descriptor = FMODULE_GET_NORMAL;
    const r = await abapRead(readConn, { object: OBJECT_REF, type: "FUGR/FF" }, 20_000);
    expect(r.text).toMatch(/^processing_type: normal$/m);
    expect(r.text).toMatch(/^remote_enabled: no$/m);
  });
});
