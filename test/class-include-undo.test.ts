/**
 * Undo of a write scoped to a class SUB-INCLUDE (Part B of issue #75).
 *
 * `test/undo.test.ts`'s "[EXPECTED RED until the undo half lands]" block
 * already pins the contract this file exercises against the real
 * implementation (not a placeholder): a CCAU/CCDEF/CCIMP/CCMAC entry's undo
 * must target the include document, never `/source/main`, and undo of the
 * CREATION of an include must be refused rather than silently deleting the
 * whole class. This file is the dedicated home for that behaviour going
 * forward, built through the real `abapWrite`/`planUndo`/`performUndo` path
 * rather than synthetic journal entries, so a regression in how `abapWrite`
 * records an include write would show up here too.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { Journal, type JournalConfig, type JournalEntry } from "../src/journal.js";
import { performUndo, planUndo, type UndoOptions } from "../src/adt/undo.js";
import { abapJournal } from "../src/tools/journal.js";
import { abapWrite } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";

const CLS = "ZCL_MCP_INC_UNDO";
const CLS_URI = "/sap/bc/adt/oo/classes/zcl_mcp_inc_undo";
const CLS_SRC = `${CLS_URI}/source/main`;
const CLS_CCAU = `${CLS_URI}/includes/testclasses`;

const CLS_V1 =
  "CLASS zcl_mcp_inc_undo DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\nENDCLASS.\n" +
  "CLASS zcl_mcp_inc_undo IMPLEMENTATION.\nENDCLASS.\n";

const TESTS_V1 =
  "CLASS ltcl_run DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.\n" +
  "  PRIVATE SECTION.\n    METHODS one FOR TESTING.\nENDCLASS.\n" +
  "CLASS ltcl_run IMPLEMENTATION.\n  METHOD one.\n  ENDMETHOD.\nENDCLASS.\n";
const TESTS_V2 = TESTS_V1.replace("METHOD one.\n", "METHOD one.\n    cl_abap_unit_assert=>fail( ).\n");

/**
 * The server's CRLF/trim/trailing-newline normalisation — copied verbatim
 * from `test/undo.test.ts` (`asServer`), since a before-image is only ever
 * compared byte-for-byte against what the fake claims the server holds.
 */
const asServer = (s: string) =>
  s
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "")
    .replace(/\n/g, "\r\n");

interface Recorded {
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
  headers: Record<string, string>;
}

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

const LOCK_XML =
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL>` +
  `<IS_LINK_UP/><MODIFICATION_SUPPORT/></DATA></asx:values></asx:abap>`;

const OBJ_XML =
  `<adtcore:objectData xmlns:adtcore="http://www.sap.com/adt/core">` +
  `<adtcore:packageRef adtcore:name="$TMP"/></adtcore:objectData>`;

const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">not found</message><properties/></exc:exception>`;

const T000_XML =
  `<dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">` +
  `<dataPreview:columns><dataPreview:metadata dataPreview:name="MANDT"/>` +
  `<dataPreview:dataSet><dataPreview:data>000</dataPreview:data>` +
  `<dataPreview:data>001</dataPreview:data></dataPreview:dataSet></dataPreview:columns>` +
  `<dataPreview:columns><dataPreview:metadata dataPreview:name="CCCATEGORY"/>` +
  `<dataPreview:dataSet><dataPreview:data>S</dataPreview:data>` +
  `<dataPreview:data>C</dataPreview:data></dataPreview:dataSet></dataPreview:columns>` +
  `</dataPreview:tableData>`;

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_XML, OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  return undefined;
}

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: (r: Recorded) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const rec: Recorded = { method, url: o.url, qs, body: o.body, headers: o.headers ?? {} };
    this.calls.push(rec);
    return this.route(rec);
  }
  get verbs(): string[] {
    return this.calls.map((c) => (c.qs._action ? c.qs._action : c.method));
  }
}

let stateDir: string;

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
    stateDir,
  });

async function connected(route: (r: Recorded) => HttpClientResponse): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(cfg(), { httpClient: adt, log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

/**
 * Main and CCAU modelled as separate documents — the one fact a
 * single-document fake would hide. `main` may be `undefined` (class does not
 * exist yet); `ccau` may likewise be `undefined` (include never written).
 */
function fakeIncludeClassServer(main: string | undefined, ccau: string | undefined) {
  const state = {
    main: main !== undefined ? (asServer(main) as string) : undefined,
    ccau: ccau !== undefined ? (asServer(ccau) as string) : undefined,
  };
  const doc = (r: Recorded) => (r.url === CLS_SRC ? "main" : r.url === CLS_CCAU ? "ccau" : undefined) as
    | "main"
    | "ccau"
    | undefined;
  const route = (r: Recorded): HttpClientResponse => {
    const d = doc(r);
    if (d && r.method === "GET") {
      const s = state[d];
      return s === undefined
        ? resp(404, NOT_FOUND_XML, OK_XML)
        : resp(200, s, { ...OK_TEXT, etag: `${d}-${s.length}` });
    }
    if (d && r.method === "PUT") {
      state[d] = r.body ?? "";
      return resp(200, "", OK_TEXT);
    }
    if (r.url === CLS_URI && r.method === "GET") {
      return state.main === undefined ? resp(404, NOT_FOUND_XML, OK_XML) : resp(200, OBJ_XML, OK_XML);
    }
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url.includes("/checkruns")) {
      return resp(200, `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`, OK_XML);
    }
    if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
    return resp(200, "", OK_TEXT);
  };
  return { state, route };
}

let dir: string;
let journal: Journal;

const jcfg = (over: Partial<JournalConfig> = {}): JournalConfig => ({
  dir,
  enabled: true,
  maxEntries: 200,
  maxAgeDays: 30,
  ...over,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "abap-inc-undo-j-"));
  stateDir = await mkdtemp(join(tmpdir(), "abap-inc-undo-s-"));
  journal = new Journal(jcfg(), "A4H");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

const openGate = (): SafetyGate => new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

const ALLOW: UndoOptions = {
  assertAllowed: (action, target) => openGate().authorize(action === "delete" ? "delete" : "write", target),
  gate: openGate(),
};

const writeTestclasses = (conn: AbapConnection, source: string, extra: Record<string, unknown> = {}) =>
  abapWrite(
    conn,
    { object: CLS, type: "CLAS/OC", include: "testclasses", source, ...extra } as never,
    60_000,
    openGate(),
    journal,
  );

describe("undo of a write scoped to a class sub-include", () => {
  it("plans testclasses restore against the include document, not /source/main", async () => {
    const srv = fakeIncludeClassServer(CLS_V1, TESTS_V1);
    const { conn, adt } = await connected(srv.route);
    await writeTestclasses(conn, TESTS_V2);
    const entry = (await journal.list())[0]!;
    expect(entry.object.sourceUri).toBe(CLS_CCAU);

    adt.calls.length = 0;
    const plan = await planUndo(conn, journal, entry);
    expect(plan.undoable).toBe(true);
    expect(plan.target.sourceUri).toBe(CLS_CCAU);

    const gets = adt.calls.filter((c) => c.method === "GET").map((c) => c.url);
    expect(gets).not.toContain(CLS_SRC);
    expect(gets).toContain(CLS_CCAU);
  });

  it("restores testclasses through the ordinary write path", async () => {
    const srv = fakeIncludeClassServer(CLS_V1, TESTS_V1);
    const { conn } = await connected(srv.route);
    await writeTestclasses(conn, TESTS_V2);
    const entry = (await journal.list())[0]!;

    const res = await performUndo(conn, journal, entry, ALLOW);
    expect(res.performed).toBe(true);
    expect(srv.state.ccau).toBe(asServer(TESTS_V1));
    // The class body must be untouched by an include-scoped undo.
    expect(srv.state.main).toBe(asServer(CLS_V1));
  });

  it('refuses undo of CREATION of an include: BAD_INPUT, not forceable, names the class, tells the caller to write a comment line, nothing sent to the server', async () => {
    // The include did not exist before this write, so undo-of-create would
    // normally be a DELETE — but there is no ADT verb that deletes a class
    // include on its own, so this must be refused rather than silently
    // deleting the whole class (or doing nothing while claiming success).
    const srv = fakeIncludeClassServer(CLS_V1, undefined);
    const { conn, adt } = await connected(srv.route);
    await writeTestclasses(conn, TESTS_V1);
    const entry = (await journal.list())[0]!;
    expect(entry.existedBefore).toBe(false);
    // Whatever shape the PUT actually sent — this is what a zero-network
    // refusal must leave completely untouched.
    const ccauAfterSetup = srv.state.ccau;

    adt.calls.length = 0;
    const plan = await planUndo(conn, journal, entry);
    expect(plan.undoable).toBe(false);
    // `blockerForceable` is only ever present (and true) when force=true
    // would change the outcome — omitted, not `false`, otherwise.
    expect(plan.blockerForceable).toBeUndefined();
    expect(plan.blocker).toContain(CLS);
    expect(plan.blocker).toMatch(/no local test classes/);
    expect(plan.blocker).toMatch(/does not send an empty document/);
    expect(plan.blocker).toMatch(/no ADT verb that deletes an include on its own/);

    const err = await catchErr(performUndo(conn, journal, entry, ALLOW));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details.forceable).toBe(false);
    // Not forceable at all — force=true must not change the outcome.
    const forcedErr = await catchErr(performUndo(conn, journal, entry, { ...ALLOW, force: true }));
    expect(forcedErr.code).toBe("BAD_INPUT");

    expect(adt.calls).toEqual([]);
    expect(srv.state.ccau).toBe(ccauAfterSetup);
  });

  it("no longer warns that the testclasses include is missing from its own entry", async () => {
    const srv = fakeIncludeClassServer(CLS_V1, TESTS_V1);
    const { conn } = await connected(srv.route);
    await writeTestclasses(conn, TESTS_V2);
    const entry = (await journal.list())[0]!;

    const out = await abapJournal(conn, { mode: "show", entry: entry.id }, 60_000, journal);
    // The old (wrong) message treated every CLAS/OC entry as a main-source
    // entry and warned that testclasses specifically was uncovered — which,
    // for an entry that IS the testclasses write, is nonsense: it is not
    // "missing", it is the very thing this entry covers.
    expect(out.text).not.toMatch(/CLASS and abapsmith records only its MAIN include/);
    expect(out.text).toMatch(/testclasses/);
    expect(out.text).toMatch(/include: testclasses/);
  });

  it("leaves a main-source entry planned and worded exactly as before", async () => {
    const srv = fakeIncludeClassServer(CLS_V1, TESTS_V1);
    const { conn } = await connected(srv.route);
    const CLS_V2 = CLS_V1.replace("  PUBLIC SECTION.\n", "  PUBLIC SECTION.\n    METHODS run.\n");
    await abapWrite(conn, { object: CLS, type: "CLAS/OC", source: CLS_V2 } as never, 60_000, openGate(), journal);
    const entry = (await journal.list())[0]!;
    expect(entry.object.sourceUri).toBe(CLS_SRC);

    const plan = await planUndo(conn, journal, entry);
    expect(plan.action).toBe("restore");
    expect(plan.undoable).toBe(true);
    expect(plan.target.sourceUri).toBe(CLS_SRC);
    // The pre-existing E4 partial warning (main-only capture on a plain
    // class update) must survive include-aware undo, worded as before.
    expect(plan.partial?.unrestored).toContain("testclasses");

    const res = await performUndo(conn, journal, entry, ALLOW);
    expect(res.performed).toBe(true);
    expect(srv.state.main).toBe(asServer(CLS_V1));

    const out = await abapJournal(conn, { mode: "show", entry: entry.id }, 60_000, journal);
    expect(out.text).toMatch(/CLASS and abapsmith records only its MAIN include/);
  });
});
