/**
 * Issue #178 contract F: PROG/P text pool (symbols/selection texts) over
 * the ADT textelements resource. `src/adt/text-pool.ts`'s pure builders/
 * parsers, `writeTextPool`/`readTextPool` over a fake `HttpClient`, the
 * `text_pool` (without `source`) branch of `abapWrite` (src/tools/write.ts),
 * and the `TEXT POOL` section on a whole-object PROG/P abap_read.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { Journal } from "../src/journal.js";
import { authorizeMutation } from "../src/adt/write.js";
import {
  TEXTELEMENTS_COLLECTION,
  buildSelectionsBody,
  buildSymbolsBody,
  parseSelections,
  parseSymbols,
  readTextPool,
  textPoolUri,
  writeTextPool,
} from "../src/adt/text-pool.js";
import { SafetyGate } from "../src/safety.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { useFluidState } from "./helpers/fluid-classic-fake.js";
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

const { abapWrite, WriteInput } = await import("../src/tools/write.js");
const { abapRead, ReadInput } = await import("../src/tools/read.js");

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "textelements");
const fixture = (name: string): string => readFileSync(join(FIXTURE_DIR, name), "utf8");
const ZAS_SYMBOLS = fixture("zas_txt182-symbols.txt");
const ZAS_SELECTIONS = fixture("zas_txt182-selections.txt");
const RSUSR000_SYMBOLS = fixture("rsusr000-symbols.txt");
const RSPARAM_SELECTIONS = fixture("rsparam-selections.txt");
const ZAS_DESCRIPTOR = fixture("zas_txt182-descriptor.xml");

const REPORT = "ZMCP_TEST_TXT178";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_test_txt178";
const TEXT_URI = textPoolUri(REPORT);

const LOCK_XML = (handle = "H1", isLocal = "X", corrNr = "") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>${isLocal}</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

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

describe("textPoolUri", () => {
  it("lowercases the program name under the textelements/programs collection", () => {
    expect(textPoolUri("RSPARAM")).toBe(`${TEXTELEMENTS_COLLECTION}/rsparam`);
  });
});

describe("buildSymbolsBody / buildSelectionsBody", () => {
  it("emits @MaxLength:N then KEY=text, uppercased, blank-line separated for multiple entries", () => {
    const body = buildSymbolsBody({ a1: "hello", b2: "world" });
    expect(body).toBe("@MaxLength:5\nA1=hello\n\n@MaxLength:5\nB2=world\n");
  });

  it("rejects a symbol key longer than 3 characters", () => {
    expect(() => buildSymbolsBody({ toolong: "x" })).toThrowError(AbapError);
    try {
      buildSymbolsBody({ toolong: "x" });
    } catch (e) {
      expect((e as AbapError).code).toBe("BAD_INPUT");
    }
  });

  it("rejects symbol text over 132 characters", () => {
    const long = "x".repeat(133);
    expect(() => buildSymbolsBody({ a: long })).toThrowError(AbapError);
  });

  it("rejects empty symbol text", () => {
    expect(() => buildSymbolsBody({ a: "" })).toThrowError(AbapError);
  });

  it("emits NAME=text per line, uppercased, no @MaxLength", () => {
    const body = buildSelectionsBody({ p_x: "Parameter X" });
    expect(body).toBe("P_X=Parameter X\n");
  });

  it("rejects a selection name over 8 characters", () => {
    expect(() => buildSelectionsBody({ waytoolongname: "x" })).toThrowError(AbapError);
  });

  it("rejects selection text over 30 characters", () => {
    expect(() => buildSelectionsBody({ p_x: "x".repeat(31) })).toThrowError(AbapError);
  });
});

describe("parseSymbols — real captured fixtures", () => {
  it("parses the single-entry CRLF fixture (zas_txt182-symbols.txt)", () => {
    expect(parseSymbols(ZAS_SYMBOLS)).toEqual({ "001": "Hello from issue 182" });
  });

  it("parses the 11-entry LF fixture, skipping @MaxLength lines and blank separators (rsusr000-symbols.txt)", () => {
    const parsed = parseSymbols(RSUSR000_SYMBOLS);
    expect(Object.keys(parsed)).toHaveLength(11);
    expect(parsed["001"]).toBe("Aktive Instanzen");
    expect(parsed["011"]).toBe("Anzahl der Plugin Anwender");
    expect(Object.keys(parsed).some((k) => k.startsWith("@MaxLength"))).toBe(false);
  });
});

describe("parseSelections — real captured fixtures", () => {
  it("parses the padded-name fixture, trimming the server-padded name (zas_txt182-selections.txt)", () => {
    const parsed = parseSelections(ZAS_SELECTIONS);
    expect(parsed["P_X"]).toBe("Parameter X");
  });

  it("parses the unpadded 8-char-name fixture (rsparam-selections.txt)", () => {
    expect(parseSelections(RSPARAM_SELECTIONS)).toEqual({ ALSOUSUB: "Display also unsubstituted?" });
  });

  it("skips an untexted `?...` marker line (hand-built, per provenance.json's documented pre-activation shape)", () => {
    const body = "P_X     =?...\n";
    expect(parseSelections(body)).toEqual({});
  });
});

describe("writeTextPool — locks/PUTs/activates the textelements uri, not the program uri", () => {
  it("GET descriptor -> LOCK(text uri) -> PUT symbols -> PUT selections -> UNLOCK -> activate(PROG/PX)", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === TEXT_URI && r.method === "GET" && !r.qs._action) return resp(200, ZAS_DESCRIPTOR, OK_XML);
      if (r.url === TEXT_URI && r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.url === TEXT_URI && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === `${TEXT_URI}/source/symbols` && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url === `${TEXT_URI}/source/selections` && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
      return undefined;
    });
    const authorized = await authWrite(conn, { type: "PROG/P", name: REPORT });
    const result = await writeTextPool(
      conn,
      authorized,
      { symbols: { "001": "Hello" }, selectionTexts: { P_X: "Parameter X" } },
      { activate: true },
    );
    expect(result.symbols).toBe(1);
    expect(result.selectionTexts).toBe(1);
    expect(result.language).toBe("EN");
    expect(result.activation?.activated).toBe(true);
    // The program uri (REPORT_URI) is never locked or PUT for text-pool writes.
    expect(adt.calls.some((c) => c.url === REPORT_URI && c.qs._action)).toBe(false);
    const put = adt.calls.find((c) => c.url === `${TEXT_URI}/source/symbols`)!;
    expect(put.headers?.["Content-Type"]).toBe("application/vnd.sap.adt.textelements.symbols.v1");
    // UNLOCK strictly before activation.
    const unlockIdx = adt.labels.findIndex((l) => l.startsWith("UNLOCK"));
    const activateIdx = adt.labels.findIndex((l) => l.includes("/activation"));
    expect(unlockIdx).toBeGreaterThanOrEqual(0);
    expect(activateIdx).toBeGreaterThan(unlockIdx);
  });

  it("activate:false skips the activation POST entirely", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === TEXT_URI && r.method === "GET" && !r.qs._action) return resp(200, ZAS_DESCRIPTOR, OK_XML);
      if (r.url === TEXT_URI && r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.url === TEXT_URI && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === `${TEXT_URI}/source/symbols` && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    });
    const authorized = await authWrite(conn, { type: "PROG/P", name: REPORT });
    const result = await writeTextPool(conn, authorized, { symbols: { "001": "Hello" } }, { activate: false });
    expect(result.activation).toBeUndefined();
    expect(adt.labels.some((l) => l.includes("/activation"))).toBe(false);
  });
});

describe("readTextPool", () => {
  it("two GETs (symbols, selections), merges into one TextPool (real zas_txt182 fixtures)", async () => {
    const fakeConn = {
      get: async (uri: string) => {
        if (uri === `${TEXT_URI}/source/symbols`) return { body: ZAS_SYMBOLS };
        if (uri === `${TEXT_URI}/source/selections`) return { body: ZAS_SELECTIONS };
        throw new Error(`unrouted: ${uri}`);
      },
    } as unknown as AbapConnection;
    const pool = await readTextPool(fakeConn, REPORT);
    expect(pool).toEqual({
      symbols: { "001": "Hello from issue 182" },
      selectionTexts: { P_X: "Parameter X" },
    });
  });

  it("returns undefined when both symbols and selections come back empty (hand-built empty bodies)", async () => {
    const fakeConn = {
      get: async () => ({ body: "" }),
    } as unknown as AbapConnection;
    expect(await readTextPool(fakeConn, REPORT)).toBeUndefined();
  });
});

describe("abapWrite — text_pool without source, on an existing PROG/P (src/tools/write.ts)", () => {
  it("writes only the text pool, returns text_pool:/text_pool_activated: header fields and a journalled-irreversible note", async () => {
    const { conn } = await connected((r) => {
      if (r.url === TEXT_URI && r.method === "GET" && !r.qs._action) return resp(200, ZAS_DESCRIPTOR, OK_XML);
      if (r.url === TEXT_URI && r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.url === TEXT_URI && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === `${TEXT_URI}/source/symbols` && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
      return undefined;
    });
    const input = WriteInput.parse({
      object: REPORT,
      type: "PROG/P",
      text_pool: { symbols: { "001": "Hello" } },
    });
    const res = await abapWrite(conn, input, 20_000, DEFAULT_GATE);
    expect(res.text).toMatch(/^text_pool: symbols 1, selection_texts 0 \(EN\)$/m);
    expect(res.text).toMatch(/^text_pool_activated: yes$/m);
    expect(res.text).toContain("journalled as an irreversible update entry");
  });

  it("records an irreversible `update` journal entry on the PROG/PX textelements object (issue #178)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abapsmith-text-pool-journal-"));
    try {
      const journal = new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H");
      const { conn } = await connected((r) => {
        if (r.url === TEXT_URI && r.method === "GET" && !r.qs._action) return resp(200, ZAS_DESCRIPTOR, OK_XML);
        if (r.url === TEXT_URI && r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
        if (r.url === TEXT_URI && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
        if (r.url === `${TEXT_URI}/source/symbols` && r.method === "PUT") return resp(200, "", OK_TEXT);
        if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
        return undefined;
      });
      const input = WriteInput.parse({
        object: REPORT,
        type: "PROG/P",
        text_pool: { symbols: { "001": "Hello" } },
      });
      await abapWrite(conn, input, 20_000, DEFAULT_GATE, journal);
      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].operation).toBe("update");
      expect(entries[0].object.type).toBe("PROG/PX");
      expect(entries[0].irreversible).toBe(true);
      expect(entries[0].outcome).toBe("succeeded");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("BAD_INPUT when the program does not exist yet (text_pool without source cannot create)", async () => {
    const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
      <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
      <message lang="EN">absent</message><properties/></exc:exception>`;
    const ABSENT_URI = "/sap/bc/adt/programs/programs/zmcp_absent178";
    const { conn, adt } = await connected((r) => {
      if (r.url === ABSENT_URI && r.method === "GET" && !r.qs._action) return resp(404, NOT_FOUND_XML, OK_XML);
      return undefined;
    });
    const input = WriteInput.parse({
      object: "ZMCP_ABSENT178",
      type: "PROG/P",
      text_pool: { symbols: { "001": "Hello" } },
    });
    const err = await catchErr(abapWrite(conn, input, 20_000, DEFAULT_GATE));
    expect(err.code).toBe("BAD_INPUT");
    expect(adt.calls.some((c) => c.url === TEXT_URI)).toBe(false);
  });
});

describe("abapRead — TEXT POOL section on a whole-object PROG/P read", () => {
  it("renders symbols/selection_texts from readTextPool's real-fixture-backed output", async () => {
    stub.object = {
      system: "A4H",
      type: "PROG/P",
      kind: "PROG",
      label: "program",
      name: "ZAS_TXT182",
      uri: "/sap/bc/adt/programs/programs/zas_txt182",
      mode: "source",
      activation: "unknown",
      spec: {},
    } as unknown as ResolvedObject;
    stub.source = "REPORT zas_txt182.\n";
    const conn = {
      cfg: { sid: "A4H" },
      get: async (uri: string) => {
        if (uri === `${TEXTELEMENTS_COLLECTION}/zas_txt182/source/symbols`) return { body: ZAS_SYMBOLS };
        if (uri === `${TEXTELEMENTS_COLLECTION}/zas_txt182/source/selections`) return { body: ZAS_SELECTIONS };
        throw new Error(`unrouted: ${uri}`);
      },
    } as unknown as AbapConnection;
    const res = await abapRead(conn, ReadInput.parse({ object: "ZAS_TXT182" }), 20_000);
    expect(res.text).toContain("TEXT POOL");
    expect(res.text).toContain("symbols:");
    expect(res.text).toContain("001  Hello from issue 182");
    expect(res.text).toContain("selection_texts:");
    expect(res.text).toContain("P_X  Parameter X");
  });
});
