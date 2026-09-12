/**
 * A class DELETE now records every include (Part C of issue #75).
 *
 * Before this change, `deleteObject` only ever captured the main include
 * (`/source/main`) in the journal entry — a class's local helper class
 * definitions/implementations/macros/test classes (CCDEF/CCIMP/CCMAC/CCAU)
 * were silently lost on undo-of-delete unless `force=true` was given, and
 * even then came back empty. This file pins the fix: a CLAS/OC delete reads
 * all four sub-includes before the DELETE verb goes out, records each one in
 * `entry.parts` with honest provenance (`captured`/`confirmed-absent`/
 * `failed` — never a fabricated empty string on failure), and undo-of-delete
 * writes the recorded includes back and activates the class again once all
 * of them have landed (a second, final activation — the first one, from
 * recreating the main include, does not publish the includes; see
 * src/adt/undo.ts:1769-1775).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { Journal, type JournalConfig } from "../src/journal.js";
import { performUndo, planUndo, type UndoOptions } from "../src/adt/undo.js";
import { abapJournal } from "../src/tools/journal.js";
import { abapWrite } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";

const CLS = "ZCL_MCP_DEL_INC";
const CLS_URI = "/sap/bc/adt/oo/classes/zcl_mcp_del_inc";
const CLS_SRC = `${CLS_URI}/source/main`;

const REPORT = "ZMCP_DEL_INC_REP";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_del_inc_rep";
const REPORT_SRC = `${REPORT_URI}/source/main`;

const CLASS_SUB_INCLUDE_NAMES = ["definitions", "implementations", "macros", "testclasses"] as const;
type IncludeName = (typeof CLASS_SUB_INCLUDE_NAMES)[number];
const includeUri = (name: IncludeName) => `${CLS_URI}/includes/${name}`;

const CLS_V1 =
  "CLASS zcl_mcp_del_inc DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\nENDCLASS.\n" +
  "CLASS zcl_mcp_del_inc IMPLEMENTATION.\nENDCLASS.\n";

const TESTS_V1 =
  "CLASS ltcl_run DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.\n" +
  "  PRIVATE SECTION.\n    METHODS one FOR TESTING.\nENDCLASS.\n" +
  "CLASS ltcl_run IMPLEMENTATION.\n  METHOD one.\n  ENDMETHOD.\nENDCLASS.\n";

const DEFS_V1 = "CLASS lcl_helper DEFINITION.\n  PUBLIC SECTION.\nENDCLASS.\n";

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
 * A class server modelling main + all four sub-includes as separate
 * documents, each independently present/absent, plus a simple report
 * document for the "non-class delete" control case.
 *
 * `opts.failIncludes` makes the GET for that include throw a 500 rather than
 * ever 404 or 200 — the read genuinely fails, so `deleteObject` must record
 * `capture: "failed"` and, critically, never fabricate a source string for it.
 */
function fakeFullClassServer(
  main: string | undefined,
  includes: Partial<Record<IncludeName, string>> = {},
  opts: { failIncludes?: readonly IncludeName[] } = {},
) {
  const state: { main?: string; includes: Partial<Record<IncludeName, string>>; report?: string } = {
    main: main !== undefined ? asServer(main) : undefined,
    includes: Object.fromEntries(
      Object.entries(includes).map(([k, v]) => [k, asServer(v as string)]),
    ) as Partial<Record<IncludeName, string>>,
  };
  const route = (r: Recorded): HttpClientResponse => {
    if (r.url === CLS_SRC && r.method === "GET") {
      return state.main === undefined
        ? resp(404, NOT_FOUND_XML, OK_XML)
        : resp(200, state.main, { ...OK_TEXT, etag: `cls-${state.main.length}` });
    }
    for (const name of CLASS_SUB_INCLUDE_NAMES) {
      if (r.url === includeUri(name) && r.method === "GET") {
        if (opts.failIncludes?.includes(name)) return resp(500, "boom", OK_TEXT);
        const s = state.includes[name];
        return s === undefined
          ? resp(404, NOT_FOUND_XML, OK_XML)
          : resp(200, s, { ...OK_TEXT, etag: `${name}-${s.length}` });
      }
      if (r.url === includeUri(name) && r.method === "PUT") {
        state.includes[name] = r.body ?? "";
        return resp(200, "", OK_TEXT);
      }
    }
    if (r.url === CLS_URI && r.method === "GET") {
      return state.main === undefined ? resp(404, NOT_FOUND_XML, OK_XML) : resp(200, OBJ_XML, OK_XML);
    }
    if (r.url === CLS_SRC && r.method === "PUT") {
      state.main = r.body ?? "";
      return resp(200, "", OK_TEXT);
    }
    if (r.url === CLS_URI && r.method === "DELETE") {
      state.main = undefined;
      state.includes = {};
      return resp(200, "", OK_TEXT);
    }
    if (r.url === REPORT_SRC && r.method === "GET") {
      return state.report === undefined
        ? resp(404, NOT_FOUND_XML, OK_XML)
        : resp(200, state.report, { ...OK_TEXT, etag: `rep-${state.report.length}` });
    }
    if (r.url === REPORT_URI && r.method === "GET") {
      return state.report === undefined ? resp(404, NOT_FOUND_XML, OK_XML) : resp(200, OBJ_XML, OK_XML);
    }
    if (r.url === REPORT_SRC && r.method === "PUT") {
      state.report = r.body ?? "";
      return resp(200, "", OK_TEXT);
    }
    if (r.url === REPORT_URI && r.method === "DELETE") {
      state.report = undefined;
      return resp(200, "", OK_TEXT);
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
  dir = await mkdtemp(join(tmpdir(), "abap-del-inc-j-"));
  stateDir = await mkdtemp(join(tmpdir(), "abap-del-inc-s-"));
  journal = new Journal(jcfg(), "A4H");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

const openGate = (): SafetyGate => new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

const ALLOW: UndoOptions = {
  assertAllowed: (action, target) => openGate().authorize(action === "delete" ? "delete" : "write", target),
  gate: openGate(),
};

// `j` has no default: a JS default parameter substitutes whenever the
// argument is `undefined`, including when a caller passes `undefined`
// EXPLICITLY — so a `j: Journal | undefined = journal` default would have
// silently turned `deleteClass(conn, undefined)` (the "journalling is off"
// test's whole point) back into `deleteClass(conn, journal)`. Every call
// site below names its journal explicitly instead.
const deleteClass = (conn: AbapConnection, j: Journal | undefined) =>
  abapWrite(conn, { object: CLS, type: "CLAS/OC", source: "", mode: "delete" } as never, 60_000, openGate(), j);

const deleteReport = (conn: AbapConnection, j: Journal | undefined) =>
  abapWrite(conn, { object: REPORT, type: "PROG/P", source: "", mode: "delete" } as never, 60_000, openGate(), j);

describe("a class delete records every include", () => {
  it("records all four includes in the delete entry's parts", async () => {
    const srv = fakeFullClassServer(CLS_V1, { testclasses: TESTS_V1, definitions: DEFS_V1 });
    const { conn } = await connected(srv.route);

    await deleteClass(conn, journal);
    const entry = (await journal.list())[0]!;

    expect(entry.parts).toHaveLength(4);
    const byInclude = new Map(entry.parts!.map((p) => [p.object.sourceUri, p]));
    expect(byInclude.get(includeUri("testclasses"))?.beforeCapture).toBe("captured");
    expect(byInclude.get(includeUri("testclasses"))?.existedBefore).toBe(true);
    expect(byInclude.get(includeUri("definitions"))?.beforeCapture).toBe("captured");
    expect(byInclude.get(includeUri("implementations"))?.beforeCapture).toBe("confirmed-absent");
    expect(byInclude.get(includeUri("macros"))?.beforeCapture).toBe("confirmed-absent");
    // Every part must name the CLASS, not some synthetic per-include object.
    for (const p of entry.parts!) {
      expect(p.object.name).toBe(CLS);
      expect(p.object.type).toBe("CLAS/OC");
    }
  });

  it("records an absent include as confirmed-absent with no source", async () => {
    const srv = fakeFullClassServer(CLS_V1, {}); // no includes ever existed
    const { conn } = await connected(srv.route);

    await deleteClass(conn, journal);
    const entry = (await journal.list())[0]!;
    const macros = entry.parts!.find((p) => p.object.sourceUri === includeUri("macros"))!;
    expect(macros.beforeCapture).toBe("confirmed-absent");
    expect(macros.existedBefore).toBe(false);
    expect(macros.before).toBeUndefined();
  });

  it("records a failed include read as failed, never as an empty capture", async () => {
    const srv = fakeFullClassServer(CLS_V1, { testclasses: TESTS_V1 }, { failIncludes: ["macros"] });
    const { conn } = await connected(srv.route);

    await deleteClass(conn, journal);
    const entry = (await journal.list())[0]!;
    const macros = entry.parts!.find((p) => p.object.sourceUri === includeUri("macros"))!;
    expect(macros.beforeCapture).toBe("failed");
    // A failed read must never be reported as if it captured an empty file.
    expect(macros.before).toBeUndefined();
    expect(macros.existedBefore).toBe(false);
  });

  it("does not read includes for a non-class delete", async () => {
    const srv = fakeFullClassServer(CLS_V1, {});
    const { conn, adt } = await connected(srv.route);
    // Prime the report so it exists to be deleted.
    await abapWrite(conn, { object: REPORT, type: "PROG/P", source: "REPORT zmcp_del_inc_rep.\n" } as never, 60_000, openGate(), journal);
    await journal.list(); // sanity: the priming write journalled fine

    adt.calls.length = 0;
    await deleteReport(conn, journal);

    const includeGets = adt.calls.filter((c) => c.method === "GET" && c.url.includes(`${CLS_URI}/includes/`));
    expect(includeGets).toEqual([]);
  });

  it("does not read includes when journalling is off", async () => {
    const srv = fakeFullClassServer(CLS_V1, { testclasses: TESTS_V1 });
    const { conn, adt } = await connected(srv.route);

    adt.calls.length = 0;
    await deleteClass(conn, undefined); // no journal passed at all

    const includeGets = adt.calls.filter((c) => c.method === "GET" && c.url.includes("/includes/"));
    expect(includeGets).toEqual([]);
    expect(await journal.list()).toEqual([]);
  });

  it("drops an include from the unrestored list once it is recorded (force-required transitions)", async () => {
    // Every include reads clean (confirmed-absent or captured) — nothing
    // unrestored, no force needed.
    const clean = fakeFullClassServer(CLS_V1, { testclasses: TESTS_V1 });
    const { conn: connClean } = await connected(clean.route);
    await deleteClass(connClean, journal);
    const cleanEntry = (await journal.list({ object: CLS }))[0]!;
    const cleanPlan = await planUndo(connClean, journal, cleanEntry);
    expect(cleanPlan.undoable).toBe(true);
    expect(cleanPlan.partial).toBeUndefined();

    // One include's read genuinely failed — that one, and only that one,
    // shows up as unrestored and forces the force=true gate back on.
    const dirty = fakeFullClassServer(CLS_V1, { testclasses: TESTS_V1 }, { failIncludes: ["macros"] });
    const { conn: connDirty } = await connected(dirty.route);
    await deleteClass(connDirty, journal);
    // `journal.list()` is newest-first (src/journal.ts:628,871) — the dirty
    // delete just landed, so it is index [0], not [1]; the clean entry from
    // above has been pushed down to [1].
    const dirtyEntry = (await journal.list({ object: CLS }))[0]!;
    const dirtyPlan = await planUndo(connDirty, journal, dirtyEntry);
    expect(dirtyPlan.undoable).toBe(false);
    expect(dirtyPlan.blockerForceable).toBe(true);
    expect(dirtyPlan.partial?.unrestored).toEqual(["macros"]);
  });

  it("restores recorded includes after recreating the class, with a final activation that covers them", async () => {
    const srv = fakeFullClassServer(CLS_V1, { testclasses: TESTS_V1, definitions: DEFS_V1 });
    const { conn, adt } = await connected(srv.route);
    await deleteClass(conn, journal);
    const entry = (await journal.list())[0]!;

    adt.calls.length = 0;
    const res = await performUndo(conn, journal, entry, ALLOW);
    expect(res.performed).toBe(true);
    expect(res.plan.action).toBe("recreate");
    expect(res.partial).toBeUndefined();

    expect(srv.state.main).toBe(asServer(CLS_V1));
    expect(srv.state.includes.testclasses).toBe(asServer(TESTS_V1));
    expect(srv.state.includes.definitions).toBe(asServer(DEFS_V1));
    // The two confirmed-absent includes must never have been PUT — there was
    // nothing recorded to write back.
    const includePuts = adt.calls.filter((c) => c.method === "PUT" && c.url.includes("/includes/"));
    expect(includePuts.map((c) => c.url).sort()).toEqual(
      [includeUri("testclasses"), includeUri("definitions")].sort(),
    );
    expect(res.restoredIncludes?.sort()).toEqual(["definitions", "testclasses"].sort());

    // Two activations, by design (src/adt/undo.ts:1769-1775, "A second
    // activation, deliberately"): the first publishes only the recreated
    // main include; CCDEF/CCIMP/CCMAC/CCAU have no active/inactive version
    // of their own, so a second, final activation is what actually
    // publishes the restored include bodies. One activation would leave
    // the includes written but not live.
    const activations = adt.calls.filter((c) => c.url.includes("/activation"));
    expect(activations).toHaveLength(2);
  });

  it("mode=show names which include each recorded part is", async () => {
    // All four sub-includes recorded (two captured, two confirmed-absent) —
    // before the `include` column, these four rows differed only by `bytes`.
    const srv = fakeFullClassServer(CLS_V1, { testclasses: TESTS_V1, definitions: DEFS_V1 });
    const { conn } = await connected(srv.route);

    await deleteClass(conn, journal);
    const entry = (await journal.list())[0]!;
    expect(entry.parts).toHaveLength(4);

    const out = await abapJournal(conn, { mode: "show", entry: entry.id }, 60_000, journal);
    for (const name of CLASS_SUB_INCLUDE_NAMES) {
      expect(out.text).toMatch(new RegExp(name));
    }
  });
});
