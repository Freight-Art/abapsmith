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
  assertTextPoolShape,
  assertTextPoolType,
  buildHeadingsBody,
  buildSelectionsBody,
  buildSymbolsBody,
  countHeadings,
  isTextPoolType,
  parseHeadings,
  parseSelections,
  parseSymbols,
  readTextPool,
  textPoolResourceType,
  textPoolUri,
  textPoolWriteSummary,
  writeTextPool,
  type TextPoolWriteResult,
} from "../src/adt/text-pool.js";
import { SafetyGate } from "../src/safety.js";
import { specForType } from "../src/adt/types.js";
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
const RSPARAM_HEADINGS = fixture("rsparam-headings.txt");
const ZAS_DESCRIPTOR = fixture("zas_txt182-descriptor.xml");
const ZAS_R199_HEADINGS = fixture("zas_r199-headings.txt");
const ZCL_DESCRIPTOR = fixture("zcl_as_text199-descriptor.xml");
const ZCL_SYMBOLS = fixture("zcl_as_text199-symbols.txt");
const FUGR_DESCRIPTOR = fixture("zas_fg199-descriptor.xml");
const FUGR_SYMBOLS = fixture("zas_fg199-symbols.txt");
const FUGR_HEADINGS = fixture("zas_fg199-headings.txt");

const REPORT = "ZMCP_TEST_TXT178";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_test_txt178";
const TEXT_URI = textPoolUri(REPORT);

const CLASS = "ZCL_AS_TEXT199";
const CLASS_URI = "/sap/bc/adt/oo/classes/zcl_as_text199";
const CLASS_TEXT_URI = textPoolUri(CLASS, "CLAS/OC");

const FGRP = "ZAS_FG199";
const FGRP_URI = "/sap/bc/adt/functions/groups/zas_fg199";
const FGRP_TEXT_URI = textPoolUri(FGRP, "FUGR/F");

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

const cfg = (language?: string): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
    stateDir: fluidState.dir(),
    ...(language !== undefined ? { language } : {}),
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
  if (r.url === CLASS_URI) return resp(200, OBJECT_XML(CLASS, "CLAS/OC"), OK_XML);
  if (r.url === FGRP_URI) return resp(200, OBJECT_XML(FGRP, "FUGR/F"), OK_XML);
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

/**
 * Mints an `AuthorizedTarget` with zero network calls, for tests asserting
 * a refusal happens before any request — `authorizeMutation` always does one
 * live existence GET, `gate.authorize` alone does not.
 */
function authorizeOffline(
  type: "PROG/P" | "CLAS/OC" | "FUGR/F",
  name: string,
  gate = DEFAULT_GATE,
) {
  const spec = specForType(type)!;
  const uri = textPoolUri(name, type);
  const target = {
    spec,
    type,
    name,
    uri,
    sourceUri: `${uri}/source/main`,
    packageName: "$TMP",
    description: `${spec.label} ${name}`,
    exists: true,
    packageSource: "server" as const,
    activation: "unknown" as const,
  };
  return gate.authorize("write", target as never);
}

describe("textPoolUri", () => {
  it("lowercases the program name under the textelements/programs collection", () => {
    expect(textPoolUri("RSPARAM")).toBe(`${TEXTELEMENTS_COLLECTION}/rsparam`);
  });

  it("CLAS/OC and FUGR/F map to their own collections", () => {
    expect(textPoolUri("ZCL_AS_TEXT199", "CLAS/OC")).toBe("/sap/bc/adt/textelements/classes/zcl_as_text199");
    expect(textPoolUri("ZAS_FG199", "FUGR/F")).toBe("/sap/bc/adt/textelements/functiongroups/zas_fg199");
    expect(textPoolResourceType("PROG/P")).toBe("PROG/PX");
    expect(textPoolResourceType("CLAS/OC")).toBe("CLAS/OCX");
    expect(textPoolResourceType("FUGR/F")).toBe("FUGR/PX");
  });
});

describe("assertTextPoolType / assertTextPoolShape", () => {
  it("refuses INTF/OI naming the supported types", async () => {
    const err = await catchErr(
      Promise.resolve().then(() => assertTextPoolType("INTF/OI", { type: "INTF/OI" })),
    );
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("PROG/P, CLAS/OC and FUGR/F");
    expect(err.message).toContain("INTF/OI");
  });

  it("undefined type is refused", async () => {
    const err = await catchErr(Promise.resolve().then(() => assertTextPoolType(undefined, {})));
    expect(err.code).toBe("BAD_INPUT");
  });

  it("CLAS/OC refuses selection_texts and headings", async () => {
    const err1 = await catchErr(
      Promise.resolve().then(() =>
        assertTextPoolShape("CLAS/OC", { selectionTexts: { P_X: "x" } }, { type: "CLAS/OC" }),
      ),
    );
    expect(err1.message).toContain("text symbols only");
    const err2 = await catchErr(
      Promise.resolve().then(() =>
        assertTextPoolShape("CLAS/OC", { headings: { listHeader: "x" } }, { type: "CLAS/OC" }),
      ),
    );
    expect(err2.message).toContain("text symbols only");
  });

  it("PROG/P and FUGR/F accept all three groups", () => {
    const pool = { symbols: { "001": "x" }, selectionTexts: { P_X: "x" }, headings: { listHeader: "x" } };
    expect(() => assertTextPoolShape("PROG/P", pool, { type: "PROG/P" })).not.toThrow();
    expect(() => assertTextPoolShape("FUGR/F", pool, { type: "FUGR/F" })).not.toThrow();
  });
});

describe("buildHeadingsBody", () => {
  it("always emits all five lines, LF, absent entries blank", () => {
    expect(buildHeadingsBody({ listHeader: "Issue 199 headings", columnHeaders: ["Col A", "Col B"] })).toBe(
      "listHeader=Issue 199 headings\n\ncolumnHeader_1=Col A\ncolumnHeader_2=Col B\n" +
        "columnHeader_3=\ncolumnHeader_4=\n",
    );
    expect(buildHeadingsBody({})).toBe(
      "listHeader=\n\ncolumnHeader_1=\ncolumnHeader_2=\ncolumnHeader_3=\ncolumnHeader_4=\n",
    );
  });

  it("refuses a list header over 70 chars", () => {
    expect(() => buildHeadingsBody({ listHeader: "x".repeat(71) })).toThrowError(AbapError);
  });

  it("refuses more than four column headers", () => {
    expect(() => buildHeadingsBody({ columnHeaders: ["a", "b", "c", "d", "e"] })).toThrowError(AbapError);
  });

  it("refuses a column header over 132 chars", () => {
    expect(() => buildHeadingsBody({ columnHeaders: ["x".repeat(133)] })).toThrowError(AbapError);
  });
});

describe("parseHeadings", () => {
  it("parses the live zas_r199 fixture (CRLF)", () => {
    expect(parseHeadings(ZAS_R199_HEADINGS)).toEqual({
      listHeader: "Issue 199 headings",
      columnHeaders: ["Col A", "Col B"],
    });
  });

  it("parses the live zas_fg199 fixture, keeping the empty column 1", () => {
    expect(parseHeadings(FUGR_HEADINGS)).toEqual({
      listHeader: "FG 199 header",
      columnHeaders: ["", "FG col 2"],
    });
  });

  it("empty rsparam fixture parses to {}", () => {
    expect(parseHeadings(RSPARAM_HEADINGS)).toEqual({});
    expect(countHeadings(parseHeadings(RSPARAM_HEADINGS))).toBe(0);
  });

  it("countHeadings counts non-empty lines", () => {
    expect(countHeadings(parseHeadings(ZAS_R199_HEADINGS))).toBe(3);
    expect(countHeadings(parseHeadings(FUGR_HEADINGS))).toBe(2);
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

  it("CLAS/OC: descriptor from the classes collection, symbols PUT only, activation as CLAS/OCX", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === CLASS_TEXT_URI && r.method === "GET" && !r.qs._action) return resp(200, ZCL_DESCRIPTOR, OK_XML);
      if (r.url === CLASS_TEXT_URI && r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.url === CLASS_TEXT_URI && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === `${CLASS_TEXT_URI}/source/symbols` && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
      return undefined;
    });
    const authorized = await authWrite(conn, { type: "CLAS/OC", name: CLASS });
    const result = await writeTextPool(conn, authorized, { symbols: { "001": "Hello" } }, { activate: true });
    expect(result.type).toBe("CLAS/OC");
    expect(result.language).toBe("EN");
    expect(result.headings).toBeUndefined();
    expect(result.activation?.activated).toBe(true);
    expect(adt.calls.some((c) => c.url === `${CLASS_TEXT_URI}/source/selections`)).toBe(false);
    expect(adt.calls.some((c) => c.url === `${CLASS_TEXT_URI}/source/headings`)).toBe(false);
    const put = adt.calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe(`${CLASS_TEXT_URI}/source/symbols`);
    // The single-object activation string overload (src/adt/activate.ts) only
    // ever emits adtcore:uri/adtcore:name, never adtcore:type — so the
    // observable fact here is which uri got activated, not a type attribute.
    const activation = adt.calls.find((c) => c.url.includes("/activation"))!;
    expect(activation.body).toContain(CLASS_TEXT_URI);
    expect(activation.body).toContain(CLASS);
  });

  it("FUGR/F: symbols + selections + headings PUT under the functiongroups lock, activation as FUGR/PX", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === FGRP_TEXT_URI && r.method === "GET" && !r.qs._action) return resp(200, FUGR_DESCRIPTOR, OK_XML);
      if (r.url === FGRP_TEXT_URI && r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.url === FGRP_TEXT_URI && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === `${FGRP_TEXT_URI}/source/symbols` && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url === `${FGRP_TEXT_URI}/source/selections` && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url === `${FGRP_TEXT_URI}/source/headings` && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
      return undefined;
    });
    const authorized = await authWrite(conn, { type: "FUGR/F", name: FGRP });
    const headings = { listHeader: "FG 199 header", columnHeaders: ["", "FG col 2"] };
    const result = await writeTextPool(
      conn,
      authorized,
      { symbols: { "002": "Hello from FM" }, selectionTexts: {}, headings },
      { activate: true },
    );
    const puts = adt.calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.url)).toEqual([
      `${FGRP_TEXT_URI}/source/symbols`,
      `${FGRP_TEXT_URI}/source/selections`,
      `${FGRP_TEXT_URI}/source/headings`,
    ]);
    const headingsPut = puts[2]!;
    expect(headingsPut.headers?.["Content-Type"]).toBe("application/vnd.sap.adt.textelements.headings.v1");
    expect(headingsPut.headers?.Accept).toBe("application/vnd.sap.adt.textelements.headings.v1");
    expect(headingsPut.body).toBe(buildHeadingsBody(headings));
    expect(headingsPut.qs.lockHandle).toBeTruthy();
    expect(result.headings).toBe(2);
    const activation = adt.calls.find((c) => c.url.includes("/activation"))!;
    expect(activation.body).toContain(FGRP_TEXT_URI);
  });

  it("PROG/P: headings PUT is skipped when headings are not given", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === TEXT_URI && r.method === "GET" && !r.qs._action) return resp(200, ZAS_DESCRIPTOR, OK_XML);
      if (r.url === TEXT_URI && r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.url === TEXT_URI && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === `${TEXT_URI}/source/symbols` && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
      return undefined;
    });
    const authorized = await authWrite(conn, { type: "PROG/P", name: REPORT });
    const result = await writeTextPool(conn, authorized, { symbols: { "001": "Hello" } }, { activate: true });
    expect(adt.calls.some((c) => c.url === `${TEXT_URI}/source/headings`)).toBe(false);
    expect(result.headings).toBeUndefined();
  });

  it("refuses a CLAS/OC pool with selection_texts before any request", async () => {
    const { conn, adt } = await connected(() => undefined);
    const authorized = authorizeOffline("CLAS/OC", CLASS);
    const err = await catchErr(writeTextPool(conn, authorized, { selectionTexts: { P_X: "x" } }, { activate: true }));
    expect(err.code).toBe("BAD_INPUT");
    expect(adt.calls.length).toBe(0);
  });

  it("language is the descriptor's master language even when the config language differs", async () => {
    const { conn } = await connected((r) => {
      if (r.url === TEXT_URI && r.method === "GET" && !r.qs._action) return resp(200, ZAS_DESCRIPTOR, OK_XML);
      if (r.url === TEXT_URI && r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.url === TEXT_URI && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === `${TEXT_URI}/source/symbols` && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    }, cfg("DE"));
    const authorized = await authWrite(conn, { type: "PROG/P", name: REPORT });
    const result = await writeTextPool(conn, authorized, { symbols: { "001": "Hello" } }, { activate: false });
    expect(result.language).toBe("EN");
  });
});

describe("textPoolWriteSummary", () => {
  it("PROG/P without headings is unchanged", () => {
    const base: TextPoolWriteResult = { type: "PROG/P", symbols: 1, selectionTexts: 0, language: "EN" };
    expect(textPoolWriteSummary(base)).toBe("symbols 1, selection_texts 0 (EN)");
  });

  it("appends headings when given", () => {
    const withHeadings: TextPoolWriteResult = {
      type: "PROG/P",
      symbols: 1,
      selectionTexts: 0,
      headings: 3,
      language: "EN",
    };
    expect(textPoolWriteSummary(withHeadings)).toBe("symbols 1, selection_texts 0, headings 3 (EN)");
  });

  it("CLAS/OC has symbols only", () => {
    const classResult: TextPoolWriteResult = { type: "CLAS/OC", symbols: 1, selectionTexts: 0, language: "EN" };
    expect(textPoolWriteSummary(classResult)).toBe("symbols 1 (EN)");
  });
});

describe("readTextPool", () => {
  it("three GETs (symbols, selections, headings), merges into one TextPool (real zas_txt182/rsparam fixtures)", async () => {
    const calls: Array<{ uri: string; headers?: Record<string, string> }> = [];
    const fakeConn = {
      get: async (uri: string, opts?: { headers?: Record<string, string> }) => {
        calls.push({ uri, headers: opts?.headers });
        if (uri === `${TEXT_URI}/source/symbols`) return { body: ZAS_SYMBOLS };
        if (uri === `${TEXT_URI}/source/selections`) return { body: ZAS_SELECTIONS };
        if (uri === `${TEXT_URI}/source/headings`) return { body: RSPARAM_HEADINGS };
        throw new Error(`unrouted: ${uri}`);
      },
    } as unknown as AbapConnection;
    const pool = await readTextPool(fakeConn, REPORT);
    expect(pool).toEqual({
      symbols: { "001": "Hello from issue 182" },
      selectionTexts: { P_X: "Parameter X" },
      headings: {},
    });
    expect(calls).toHaveLength(3);
    expect(calls[2]?.headers?.Accept).toBe("application/vnd.sap.adt.textelements.headings.v1");
  });

  it("returns undefined when both symbols and selections come back empty (hand-built empty bodies)", async () => {
    const fakeConn = {
      get: async () => ({ body: "" }),
    } as unknown as AbapConnection;
    expect(await readTextPool(fakeConn, REPORT)).toBeUndefined();
  });

  it("CLAS/OC: one GET (symbols), no selections/headings", async () => {
    const calls: string[] = [];
    const fakeConn = {
      get: async (uri: string) => {
        calls.push(uri);
        if (uri === `${CLASS_TEXT_URI}/source/symbols`) return { body: ZCL_SYMBOLS };
        throw new Error(`unrouted: ${uri}`);
      },
    } as unknown as AbapConnection;
    const pool = await readTextPool(fakeConn, CLASS, "CLAS/OC");
    expect(calls).toEqual([`${CLASS_TEXT_URI}/source/symbols`]);
    expect(pool).toEqual({ symbols: { "001": "Hello" }, selectionTexts: {}, headings: {} });
  });

  it("FUGR/F: three GETs on the functiongroups collection", async () => {
    const fakeConn = {
      get: async (uri: string) => {
        if (uri === `${FGRP_TEXT_URI}/source/symbols`) return { body: FUGR_SYMBOLS };
        if (uri === `${FGRP_TEXT_URI}/source/selections`) return { body: "" };
        if (uri === `${FGRP_TEXT_URI}/source/headings`) return { body: FUGR_HEADINGS };
        throw new Error(`unrouted: ${uri}`);
      },
    } as unknown as AbapConnection;
    const pool = await readTextPool(fakeConn, FGRP, "FUGR/F");
    expect(pool?.headings).toEqual({ listHeader: "FG 199 header", columnHeaders: ["", "FG col 2"] });
  });

  it("PROG/P with only headings set is not undefined", async () => {
    const fakeConn = {
      get: async (uri: string) => {
        if (uri === `${TEXT_URI}/source/symbols`) return { body: "" };
        if (uri === `${TEXT_URI}/source/selections`) return { body: "" };
        if (uri === `${TEXT_URI}/source/headings`) return { body: ZAS_R199_HEADINGS };
        throw new Error(`unrouted: ${uri}`);
      },
    } as unknown as AbapConnection;
    const pool = await readTextPool(fakeConn, REPORT);
    expect(pool).toBeDefined();
    expect(pool?.headings).toEqual({ listHeader: "Issue 199 headings", columnHeaders: ["Col A", "Col B"] });
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
    expect(err.message).toContain("needs an existing object");
    expect(adt.calls.some((c) => c.url === TEXT_URI)).toBe(false);
  });

  it("CLAS/OC text_pool-only write: header symbols 1 (EN), journalled as CLAS/OCX", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abapsmith-text-pool-journal-"));
    try {
      const journal = new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H");
      const { conn } = await connected((r) => {
        if (r.url === CLASS_TEXT_URI && r.method === "GET" && !r.qs._action) return resp(200, ZCL_DESCRIPTOR, OK_XML);
        if (r.url === CLASS_TEXT_URI && r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
        if (r.url === CLASS_TEXT_URI && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
        if (r.url === `${CLASS_TEXT_URI}/source/symbols` && r.method === "PUT") return resp(200, "", OK_TEXT);
        if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
        return undefined;
      });
      const input = WriteInput.parse({
        object: CLASS,
        type: "CLAS/OC",
        text_pool: { symbols: { "001": "Hello" } },
      });
      const res = await abapWrite(conn, input, 20_000, DEFAULT_GATE, journal);
      expect(res.text).toMatch(/^text_pool: symbols 1 \(EN\)$/m);
      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].object.type).toBe("CLAS/OCX");
      expect(entries[0].object.uri).toBe(CLASS_TEXT_URI);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("PROG/P text_pool with headings: header shows headings 3, PUT carries the headings body", async () => {
    let headingsPutBody: string | undefined;
    const { conn } = await connected((r) => {
      if (r.url === TEXT_URI && r.method === "GET" && !r.qs._action) return resp(200, ZAS_DESCRIPTOR, OK_XML);
      if (r.url === TEXT_URI && r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.url === TEXT_URI && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === `${TEXT_URI}/source/symbols` && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url === `${TEXT_URI}/source/selections` && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url === `${TEXT_URI}/source/headings` && r.method === "PUT") {
        headingsPutBody = r.body;
        return resp(200, "", OK_TEXT);
      }
      if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
      return undefined;
    });
    const input = WriteInput.parse({
      object: REPORT,
      type: "PROG/P",
      text_pool: {
        symbols: { "001": "Hello" },
        selection_texts: {},
        headings: { list_header: "Issue 199 headings", column_headers: ["Col A", "Col B"] },
      },
    });
    const res = await abapWrite(conn, input, 20_000, DEFAULT_GATE);
    expect(res.text).toMatch(/^text_pool: symbols 1, selection_texts 0, headings 3 \(EN\)$/m);
    expect(headingsPutBody).toBe(
      buildHeadingsBody({ listHeader: "Issue 199 headings", columnHeaders: ["Col A", "Col B"] }),
    );
  });

  it("text_pool on a resolved INTF/OI is refused, naming the supported types, before any write", async () => {
    const { conn, adt } = await connected(() => undefined);
    const input = WriteInput.parse({
      object: "ZIF_TEST_INTF199",
      type: "INTF/OI",
      text_pool: { symbols: { "001": "hi" } },
    });
    const err = await catchErr(abapWrite(conn, input, 20_000, DEFAULT_GATE));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("PROG/P, CLAS/OC and FUGR/F");
    expect(adt.calls.length).toBe(0);
  });

  it("CLAS/OC with selection_texts is refused BAD_INPUT before any PUT", async () => {
    const { conn, adt } = await connected(() => undefined);
    const input = WriteInput.parse({
      object: CLASS,
      type: "CLAS/OC",
      text_pool: { symbols: { "001": "Hello" }, selection_texts: { P_X: "x" } },
    });
    const err = await catchErr(abapWrite(conn, input, 20_000, DEFAULT_GATE));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("text symbols only");
    expect(adt.calls.length).toBe(0);
  });
});

describe("abapRead — TEXT POOL section on a whole-object PROG/P read", () => {
  it("renders symbols/selection_texts from readTextPool's real-fixture-backed output (three GETs)", async () => {
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
    const calls: Array<{ uri: string; headers?: Record<string, string> }> = [];
    const conn = {
      cfg: { sid: "A4H" },
      get: async (uri: string, opts?: { headers?: Record<string, string> }) => {
        calls.push({ uri, headers: opts?.headers });
        if (uri === `${TEXTELEMENTS_COLLECTION}/zas_txt182/source/symbols`) return { body: ZAS_SYMBOLS };
        if (uri === `${TEXTELEMENTS_COLLECTION}/zas_txt182/source/selections`) return { body: ZAS_SELECTIONS };
        if (uri === `${TEXTELEMENTS_COLLECTION}/zas_txt182/source/headings`) return { body: RSPARAM_HEADINGS };
        throw new Error(`unrouted: ${uri}`);
      },
    } as unknown as AbapConnection;
    const res = await abapRead(conn, ReadInput.parse({ object: "ZAS_TXT182" }), 20_000);
    expect(res.text).toContain("TEXT POOL");
    expect(res.text).toContain("symbols:");
    expect(res.text).toContain("001  Hello from issue 182");
    expect(res.text).toContain("selection_texts:");
    expect(res.text).toContain("P_X  Parameter X");
    // A fourth, unrelated GET (issue #179's best-effort fixed_point_arithmetic
    // lookup on the program's own uri) also runs for a PROG/P whole-object
    // read and is swallowed on failure — only the three textelements GETs
    // are asserted here.
    const headingsCall = calls.find((c) => c.uri.endsWith("/source/headings"));
    expect(calls.filter((c) => c.uri.includes(TEXTELEMENTS_COLLECTION))).toHaveLength(3);
    expect(headingsCall?.headers?.Accept).toBe("application/vnd.sap.adt.textelements.headings.v1");
  });

  it("CLAS/OC whole-object read shows symbols, no selection_texts/headings", async () => {
    stub.object = {
      system: "A4H",
      type: "CLAS/OC",
      kind: "CLAS",
      label: "class",
      name: CLASS,
      uri: CLASS_URI,
      mode: "source",
      activation: "unknown",
      spec: {},
    } as unknown as ResolvedObject;
    stub.source = "CLASS zcl_as_text199 DEFINITION.\nENDCLASS.\n";
    const conn = {
      cfg: { sid: "A4H" },
      get: async (uri: string) => {
        if (uri === `${CLASS_TEXT_URI}/source/symbols`) return { body: ZCL_SYMBOLS };
        throw new Error(`unrouted: ${uri}`);
      },
    } as unknown as AbapConnection;
    const res = await abapRead(conn, ReadInput.parse({ object: CLASS }), 20_000);
    expect(res.text).toContain("--- TEXT POOL ---");
    expect(res.text).toContain("symbols:");
    expect(res.text).toContain("001  Hello");
    expect(res.text).not.toContain("selection_texts:");
    expect(res.text).not.toContain("headings:");
  });

  it("FUGR/F whole-object read shows symbols and headings", async () => {
    stub.object = {
      system: "A4H",
      type: "FUGR/F",
      kind: "FUGR",
      label: "function group",
      name: FGRP,
      uri: FGRP_URI,
      mode: "source",
      activation: "unknown",
      spec: {},
    } as unknown as ResolvedObject;
    stub.source = "FUNCTION-POOL zas_fg199.\n";
    const conn = {
      cfg: { sid: "A4H" },
      get: async (uri: string) => {
        if (uri === `${FGRP_TEXT_URI}/source/symbols`) return { body: FUGR_SYMBOLS };
        if (uri === `${FGRP_TEXT_URI}/source/selections`) return { body: "" };
        if (uri === `${FGRP_TEXT_URI}/source/headings`) return { body: FUGR_HEADINGS };
        throw new Error(`unrouted: ${uri}`);
      },
    } as unknown as AbapConnection;
    const res = await abapRead(conn, ReadInput.parse({ object: FGRP }), 20_000);
    expect(res.text).toContain("002  Hello from FM");
    expect(res.text).toContain("headings:");
    expect(res.text).toContain("list_header  FG 199 header");
    expect(res.text).toContain("column_header_2  FG col 2");
    expect(res.text).not.toContain("column_header_1");
  });

  it("PROG/P read renders headings", async () => {
    stub.object = {
      system: "A4H",
      type: "PROG/P",
      kind: "PROG",
      label: "program",
      name: "ZAS_R199",
      uri: "/sap/bc/adt/programs/programs/zas_r199",
      mode: "source",
      activation: "unknown",
      spec: {},
    } as unknown as ResolvedObject;
    stub.source = "REPORT zas_r199.\n";
    const conn = {
      cfg: { sid: "A4H" },
      get: async (uri: string) => {
        if (uri === `${TEXTELEMENTS_COLLECTION}/zas_r199/source/symbols`) return { body: "" };
        if (uri === `${TEXTELEMENTS_COLLECTION}/zas_r199/source/selections`) return { body: "" };
        if (uri === `${TEXTELEMENTS_COLLECTION}/zas_r199/source/headings`) return { body: ZAS_R199_HEADINGS };
        throw new Error(`unrouted: ${uri}`);
      },
    } as unknown as AbapConnection;
    const res = await abapRead(conn, ReadInput.parse({ object: "ZAS_R199" }), 20_000);
    expect(res.text).toContain("headings:");
    expect(res.text).toContain("list_header  Issue 199 headings");
    expect(res.text).toContain("column_header_1  Col A");
    expect(res.text).toContain("column_header_2  Col B");
  });
});
