/**
 * `abap_quick_fix` — ADT's two-hop position-driven quick fixes, evaluated
 * and (for deterministic proposals) applied through the same journalled
 * `abap_write` core every other mutation uses.
 *
 * These tests drive the real `abapQuickFix` (src/tools/quickfix.ts) and the
 * wire module underneath it (src/adt/quickfix.ts) against a fake HTTP layer,
 * same idiom as test/undo-activation-failure-disclosure.test.ts. The
 * evaluation/proposal response XML shapes are modelled on
 * test/fixtures/live-captured/ 804 (multi-proposal evaluation), 805 (a
 * zero-width insertion delta), 802 (rename_quickfix, parameterized with no
 * userContent), and 809 (an empty `<deltas/>` no-op) — reproduced here as
 * inline literals, not read from the fixture files.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { isAbapError } from "../src/adt/errors.js";
import { Journal, type JournalConfig } from "../src/journal.js";
import { performUndo, type UndoOptions } from "../src/adt/undo.js";
import { abapQuickFix } from "../src/tools/quickfix.js";
import { SafetyGate } from "../src/safety.js";

const CLS = "ZTMD_QF_TOOL";
const CLS_URI = "/sap/bc/adt/oo/classes/ztmd_qf_tool";
const CLS_SRC = `${CLS_URI}/source/main`;

const SOURCE =
  "CLASS ztmd_qf_tool DEFINITION PUBLIC FINAL CREATE PUBLIC.\n" +
  "  PUBLIC SECTION.\n" +
  "    INTERFACES if_oo_adt_classrun.\n" +
  "ENDCLASS.\n" +
  "\n" +
  "CLASS ztmd_qf_tool IMPLEMENTATION.\n" +
  "ENDCLASS.\n";

// Server-side normalisation, same model test/undo.test.ts and
// test/undo-activation-failure-disclosure.test.ts use: CRLF, trailing
// blank/tab trimmed per line, trailing newlines stripped.
const asServer = (s: string) =>
  s
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "")
    .replace(/\n/g, "\r\n");

/** What every hop-1 evaluation call posts and every source GET answers. */
const SERVED_SOURCE = asServer(SOURCE);

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
  headers: Record<string, string>;
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

const LOCK_XML =
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL>` +
  `<IS_LINK_UP/><MODIFICATION_SUPPORT/></DATA></asx:values></asx:abap>`;

const OBJ_XML =
  `<adtcore:objectData xmlns:adtcore="http://www.sap.com/adt/core">` +
  `<adtcore:packageRef adtcore:name="$TMP"/></adtcore:objectData>`;

const SEARCH_XML =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">` +
  `<adtcore:objectReference adtcore:uri="${CLS_URI}" adtcore:type="CLAS/OC" ` +
  `adtcore:name="${CLS}" adtcore:packageName="$TMP"/>` +
  `</adtcore:objectReferences>`;

const T000_XML =
  `<dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">` +
  `<dataPreview:columns><dataPreview:metadata dataPreview:name="MANDT"/>` +
  `<dataPreview:dataSet><dataPreview:data>000</dataPreview:data>` +
  `<dataPreview:data>001</dataPreview:data></dataPreview:dataSet></dataPreview:columns>` +
  `<dataPreview:columns><dataPreview:metadata dataPreview:name="CCCATEGORY"/>` +
  `<dataPreview:dataSet><dataPreview:data>S</dataPreview:data>` +
  `<dataPreview:data>C</dataPreview:data></dataPreview:dataSet></dataPreview:columns>` +
  `</dataPreview:tableData>`;

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: (r: Recorded) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body, headers: o.headers ?? {} };
    this.calls.push(rec);
    return this.route(rec);
  }
}

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_XML, OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/repository/informationsystem/search")) return resp(200, SEARCH_XML, OK_XML);
  return undefined;
}

async function connected(
  route: (r: Recorded) => HttpClientResponse,
): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
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

/**
 * A single mutable ZTMD_QF_TOOL server: source GET/PUT, LOCK/UNLOCK,
 * checkrun and activation — the object-URI GET (`resolveWriteTarget`) is
 * routed separately since it never changes. `evalXml`/`hop2` let each test
 * supply its own evaluation and proposal-delta documents at whatever URIs
 * they reference.
 */
function fakeServer(hop2: Record<string, string>) {
  const state = { source: SOURCE };
  const route = (r: Recorded): HttpClientResponse => {
    if (r.url === CLS_URI && r.method === "GET") return resp(200, OBJ_XML, OK_XML);
    if (r.url === CLS_SRC && r.method === "GET") {
      return resp(200, asServer(state.source), { ...OK_TEXT, etag: `srv-${state.source.length}` });
    }
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === CLS_SRC && r.method === "PUT") {
      state.source = r.body ?? "";
      return resp(200, "", OK_TEXT);
    }
    if (r.url.includes("/checkruns")) {
      return resp(200, `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`, OK_XML);
    }
    if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
    if (r.url.includes("/transportchecks")) {
      return resp(200, `<CHECK_RESULT><IS_LOCAL>X</IS_LOCAL></CHECK_RESULT>`, OK_XML);
    }
    if (r.url in hop2) return resp(200, hop2[r.url]!, OK_XML);
    return resp(200, "", OK_TEXT);
  };
  return { state, route };
}

let dir: string;
let journal: Journal;

const jcfg = (): JournalConfig => ({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "abap-qf-"));
  journal = new Journal(jcfg(), "A4H");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const catchErr = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as import("../src/adt/errors.js").AbapError;
};

const openGate = (): SafetyGate => new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

describe("abap_quick_fix", () => {
  it('mode="list" renders every proposal at the position, deterministic and parameterized alike', async () => {
    const UNIMPL_URI = `${CLS_SRC}/quickfixes/unimplemented_methods`;
    const RENAME_URI = `${CLS_SRC}/refactoring/quickfixes/qf_rename`;
    const evalXml =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<qf:evaluationResults xmlns:qf="http://www.sap.com/adt/quickfixes" xmlns:adtcore="http://www.sap.com/adt/core">` +
      `<evaluationResult><adtcore:objectReference adtcore:uri="${UNIMPL_URI}" adtcore:type="unimplemented_methods" ` +
      `adtcore:name="Add implementation for &apos;run&apos;" ` +
      `adtcore:description="Add implementation for method run in class ztmd_qf_tool"/></evaluationResult>` +
      `<evaluationResult><adtcore:objectReference adtcore:uri="${RENAME_URI}" adtcore:type="rename_quickfix" ` +
      `adtcore:name="Rename &apos;lv_unused&apos;" ` +
      `adtcore:description="Renames lv_unused and adjusts all occurrences"/></evaluationResult>` +
      `</qf:evaluationResults>`;
    const srv = fakeServer({});
    const { conn, adt } = await connected((r) => {
      if (r.url === CLS_SRC && r.method === "GET") {
        return resp(200, asServer(srv.state.source), { ...OK_TEXT, etag: "srv-1" });
      }
      if (r.url.includes("/quickfixes/evaluation")) return resp(200, evalXml, OK_XML);
      return srv.route(r);
    });

    const result = await abapQuickFix(
      conn,
      { mode: "list", object: CLS, type: "CLAS/OC", line: 7, column: 0 } as never,
      60_000,
      openGate(),
    );

    expect(result.text).toContain("proposals: 2");
    expect(result.text).toContain("unimplemented_methods");
    expect(result.text).toContain("Add implementation for 'run'");
    expect(result.text).toContain("deterministic");
    expect(result.text).toContain("qf_rename");
    expect(result.text).toContain("Rename 'lv_unused'");
    expect(result.text).toContain("parameterized (new name)");

    expect(adt.calls.map((c) => c.label)).toStrictEqual([
      "GET /sap/bc/adt/repository/informationsystem/search",
      `GET ${CLS_SRC}`,
      "POST /sap/bc/adt/quickfixes/evaluation",
    ]);
    const evalCall = adt.calls[2]!;
    expect(evalCall.body).toBe(SERVED_SOURCE);
    expect(evalCall.qs.uri).toBe(`${CLS_SRC}#start=7,0`);
  });

  it('mode="list" with zero proposals is a successful empty result, not an error', async () => {
    const emptyEvalXml =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<qf:evaluationResults xmlns:qf="http://www.sap.com/adt/quickfixes" xmlns:adtcore="http://www.sap.com/adt/core"/>`;
    const srv = fakeServer({});
    const { conn, adt } = await connected((r) => {
      if (r.url.includes("/quickfixes/evaluation")) return resp(200, emptyEvalXml, OK_XML);
      return srv.route(r);
    });

    const result = await abapQuickFix(
      conn,
      { mode: "list", object: CLS, type: "CLAS/OC", line: 3, column: 4 } as never,
      60_000,
      openGate(),
    );

    expect(result.text).toContain("proposals: 0");
    expect(result.text).toContain(
      "ADT offers no quick fix for CLAS/OC ZTMD_QF_TOOL at line 3, column 4 " +
        "(1-based line, 0-based column). This is a successful empty result, not an error.",
    );
    expect(adt.calls.map((c) => c.label)).toStrictEqual([
      "GET /sap/bc/adt/repository/informationsystem/search",
      `GET ${CLS_SRC}`,
      "POST /sap/bc/adt/quickfixes/evaluation",
    ]);
  });

  it("refuses a parameterized proposal by name, before any write, with an empty journal", async () => {
    const RENAME_URI = `${CLS_SRC}/refactoring/quickfixes/qf_rename`;
    const evalXml =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<qf:evaluationResults xmlns:qf="http://www.sap.com/adt/quickfixes" xmlns:adtcore="http://www.sap.com/adt/core">` +
      `<evaluationResult><adtcore:objectReference adtcore:uri="${RENAME_URI}" adtcore:type="rename_quickfix" ` +
      `adtcore:name="Rename &apos;lv_unused&apos;" ` +
      `adtcore:description="Renames lv_unused and adjusts all occurrences"/></evaluationResult>` +
      `</qf:evaluationResults>`;
    const srv = fakeServer({});
    const { conn, adt } = await connected((r) => {
      if (r.url.includes("/quickfixes/evaluation")) return resp(200, evalXml, OK_XML);
      if (r.url === RENAME_URI) throw new Error("hop 2 must never be called for a parameterized proposal");
      return srv.route(r);
    });

    const err = await catchErr(
      abapQuickFix(
        conn,
        { mode: "apply", object: CLS, type: "CLAS/OC", line: 3, column: 4, proposal: "qf_rename" } as never,
        60_000,
        openGate(),
        journal,
      ),
    );

    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toBe(
      'Proposal "qf_rename" (Rename \'lv_unused\') is parameterized — it needs a value for ' +
        '"new name". This version applies deterministic proposals only. No network write has happened.',
    );
    expect(adt.calls.map((c) => c.label)).toStrictEqual([
      "GET /sap/bc/adt/repository/informationsystem/search",
      `GET ${CLS_SRC}`,
      "POST /sap/bc/adt/quickfixes/evaluation",
    ]);
    expect((await journal.list()).length).toBe(0);
  });

  it("refuses a non-main include before any network call, for both mode=list and mode=apply", async () => {
    const { conn, adt } = await connected(() => {
      throw new Error("must never be called — the include check is zero-network");
    });

    const listErr = await catchErr(
      abapQuickFix(
        conn,
        { mode: "list", object: CLS, type: "CLAS/OC", include: "implementations", line: 1, column: 0 } as never,
        60_000,
        openGate(),
      ),
    );
    expect(listErr.code).toBe("BAD_INPUT");
    expect(listErr.message).toBe(
      `abap_quick_fix only targets a class's main include; ${CLS} named include "implementations".`,
    );
    expect(adt.calls.length).toBe(0);

    const applyErr = await catchErr(
      abapQuickFix(
        conn,
        { mode: "apply", object: CLS, type: "CLAS/OC", include: "implementations", line: 1, column: 0 } as never,
        60_000,
        openGate(),
      ),
    );
    expect(applyErr.code).toBe("BAD_INPUT");
    expect(applyErr.message).toBe(
      `abap_quick_fix only targets a class's main include; ${CLS} named include "implementations".`,
    );
    expect(adt.calls.length).toBe(0);
  });

  it("read-only mode refuses both submodes with the generic READ_ONLY message, after the one lookup call already made", async () => {
    const { conn, adt } = await connected(() => resp(200, "", OK_TEXT));
    const readOnlyGate = new SafetyGate({ readOnly: true, allowPackages: ["$TMP"] });
    const READ_ONLY_MESSAGE =
      "Server is running read-only. ABAP_ALLOW_WRITE does not enable writes, and ABAP_MODE is not " +
      "set, so that variable is what decides it. Set ABAP_ALLOW_WRITE=true (ABAP_ALLOW_PACKAGES is " +
      "optional — it narrows the default, which is every package).";

    const listErr = await catchErr(
      abapQuickFix(
        conn,
        { mode: "list", object: CLS, type: "CLAS/OC", line: 1, column: 0 } as never,
        60_000,
        readOnlyGate,
      ),
    );
    expect(listErr.code).toBe("READ_ONLY");
    expect(listErr.message).toBe(READ_ONLY_MESSAGE);
    // resolveObject's own search call already fired before the gate is consulted.
    expect(adt.calls.map((c) => c.label)).toStrictEqual([
      "GET /sap/bc/adt/repository/informationsystem/search",
    ]);

    adt.calls.length = 0;
    const applyErr = await catchErr(
      abapQuickFix(
        conn,
        { mode: "apply", object: CLS, type: "CLAS/OC", line: 1, column: 0, proposal: "whatever" } as never,
        60_000,
        readOnlyGate,
      ),
    );
    expect(applyErr.code).toBe("READ_ONLY");
    expect(applyErr.message).toBe(READ_ONLY_MESSAGE);
    expect(adt.calls.map((c) => c.label)).toStrictEqual([
      "GET /sap/bc/adt/repository/informationsystem/search",
    ]);
  });

  it("a proposal whose delta is an empty <deltas/> is a successful no-op — nothing written, locked, or journalled", async () => {
    const NOOP_URI = `${CLS_SRC}/quickfixes/no_op_fix`;
    const evalXml =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<qf:evaluationResults xmlns:qf="http://www.sap.com/adt/quickfixes" xmlns:adtcore="http://www.sap.com/adt/core">` +
      `<evaluationResult><adtcore:objectReference adtcore:uri="${NOOP_URI}" adtcore:type="no_op_fix" ` +
      `adtcore:name="Do nothing fix" ` +
      `adtcore:description="A fix ADT reports as available but produces no edits"/></evaluationResult>` +
      `</qf:evaluationResults>`;
    const proposalXml =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<qf:proposalResult xmlns:qf="http://www.sap.com/adt/quickfixes" xmlns:adtcore="http://www.sap.com/adt/core">` +
      `<deltas/><variableSourceStates><adtcore:objectReferences/></variableSourceStates></qf:proposalResult>`;
    const srv = fakeServer({});
    const { conn, adt } = await connected((r) => {
      if (r.url.includes("/quickfixes/evaluation")) return resp(200, evalXml, OK_XML);
      if (r.url === NOOP_URI) return resp(200, proposalXml, OK_XML);
      if (r.qs._action === "LOCK" || r.url === CLS_SRC && r.method === "PUT" || r.url.includes("/activation")) {
        throw new Error("must never write for a zero-edit delta");
      }
      return srv.route(r);
    });

    const result = await abapQuickFix(
      conn,
      { mode: "apply", object: CLS, type: "CLAS/OC", line: 2, column: 0, proposal: "no_op_fix" } as never,
      60_000,
      openGate(),
      journal,
    );

    expect(result.text).toContain(
      'Proposal "no_op_fix" (Do nothing fix) produced no edits. Nothing was written, locked, or journalled.',
    );
    expect(adt.calls.map((c) => c.label)).toStrictEqual([
      "GET /sap/bc/adt/repository/informationsystem/search",
      `GET ${CLS_SRC}`,
      "POST /sap/bc/adt/quickfixes/evaluation",
      `POST ${NOOP_URI}`,
    ]);
    expect((await journal.list()).length).toBe(0);
  });

  it("applies a deterministic proposal end-to-end, journals it as abap_quick_fix, and undoes cleanly", async () => {
    const UNIMPL_URI = `${CLS_SRC}/quickfixes/unimplemented_methods`;
    const evalXml =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<qf:evaluationResults xmlns:qf="http://www.sap.com/adt/quickfixes" xmlns:adtcore="http://www.sap.com/adt/core">` +
      `<evaluationResult><adtcore:objectReference adtcore:uri="${UNIMPL_URI}" adtcore:type="unimplemented_methods" ` +
      `adtcore:name="Add implementation for &apos;run&apos;" ` +
      `adtcore:description="Add implementation for method run in class ztmd_qf_tool"/></evaluationResult>` +
      `</qf:evaluationResults>`;
    const proposalXml =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<qf:proposalResult xmlns:qf="http://www.sap.com/adt/quickfixes" xmlns:adtcore="http://www.sap.com/adt/core">` +
      `<deltas><unit><content>  METHOD if_oo_adt_classrun~main.\r\n  ENDMETHOD.\r\n</content>` +
      `<adtcore:objectReference adtcore:uri="${CLS_SRC}#start=7,0" adtcore:type="CLAS/OC" ` +
      `adtcore:name="Insert method implementation"/></unit></deltas>` +
      `<variableSourceStates><adtcore:objectReferences/></variableSourceStates></qf:proposalResult>`;
    const srv = fakeServer({});
    const { conn, adt } = await connected((r) => {
      if (r.url.includes("/quickfixes/evaluation")) return resp(200, evalXml, OK_XML);
      if (r.url === UNIMPL_URI) return resp(200, proposalXml, OK_XML);
      return srv.route(r);
    });

    const result = await abapQuickFix(
      conn,
      { mode: "apply", object: CLS, type: "CLAS/OC", line: 7, column: 0, proposal: "unimplemented_methods" } as never,
      60_000,
      openGate(),
      journal,
    );

    expect(adt.calls.map((c) => c.label)).toStrictEqual([
      "GET /sap/bc/adt/repository/informationsystem/search",
      `GET ${CLS_SRC}`,
      "POST /sap/bc/adt/quickfixes/evaluation",
      `POST ${UNIMPL_URI}`,
      `GET ${CLS_URI}`,
      `GET ${CLS_SRC}`,
      `LOCK ${CLS_URI}`,
      `GET ${CLS_SRC}`,
      `PUT ${CLS_SRC}`,
      `UNLOCK ${CLS_URI}`,
      "POST /sap/bc/adt/checkruns?reporters=abapCheckRun",
      `GET ${CLS_SRC}`,
      "POST /sap/bc/adt/activation",
    ]);

    // The delta's <content> is written as \r\n, but XML line-end normalisation
    // (fast-xml-parser included) collapses \r\n to \n before we ever see it.
    // The surrounding source stays CRLF, so this pins the deliberately mixed result.
    expect(srv.state.source).toBe(
      "CLASS ztmd_qf_tool DEFINITION PUBLIC FINAL CREATE PUBLIC.\r\n" +
        "  PUBLIC SECTION.\r\n" +
        "    INTERFACES if_oo_adt_classrun.\r\n" +
        "ENDCLASS.\r\n" +
        "\r\n" +
        "CLASS ztmd_qf_tool IMPLEMENTATION.\r\n" +
        "  METHOD if_oo_adt_classrun~main.\n" +
        "  ENDMETHOD.\n" +
        "ENDCLASS.",
    );

    expect(result.text).toContain("edits: 1");
    const entries = await journal.list();
    expect(entries.length).toBe(1);
    const entryId = entries[0]!.id;
    expect(entries[0]!.tool).toBe("abap_quick_fix");
    expect(result.text).toContain(`journal: ${entryId}`);
    expect(result.text).toContain(`Journalled as ${entryId}, with the previous source kept as the before-image.`);
    // The undo-instruction hint only appears in compact.ts's truncation
    // notice, which a response this small never reaches — only the bare id
    // (asserted above) is guaranteed present.
    expect(result.text).not.toContain("abap_journal mode=undo");

    const undo = await performUndo(conn, journal, entries[0]!, {
      assertAllowed: (action, target) => openGate().authorize(action === "delete" ? "delete" : "write", target),
      gate: openGate(),
    } as UndoOptions);
    expect(undo.performed).toBe(true);
    expect(srv.state.source).toBe(SERVED_SOURCE);
  });

  it("dry_run previews the diff and makes no write, lock, or journal entry", async () => {
    const UNIMPL_URI = `${CLS_SRC}/quickfixes/unimplemented_methods`;
    const evalXml =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<qf:evaluationResults xmlns:qf="http://www.sap.com/adt/quickfixes" xmlns:adtcore="http://www.sap.com/adt/core">` +
      `<evaluationResult><adtcore:objectReference adtcore:uri="${UNIMPL_URI}" adtcore:type="unimplemented_methods" ` +
      `adtcore:name="Add implementation for &apos;run&apos;" ` +
      `adtcore:description="Add implementation for method run in class ztmd_qf_tool"/></evaluationResult>` +
      `</qf:evaluationResults>`;
    const proposalXml =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<qf:proposalResult xmlns:qf="http://www.sap.com/adt/quickfixes" xmlns:adtcore="http://www.sap.com/adt/core">` +
      `<deltas><unit><content>  METHOD if_oo_adt_classrun~main.\r\n  ENDMETHOD.\r\n</content>` +
      `<adtcore:objectReference adtcore:uri="${CLS_SRC}#start=7,0" adtcore:type="CLAS/OC" ` +
      `adtcore:name="Insert method implementation"/></unit></deltas>` +
      `<variableSourceStates><adtcore:objectReferences/></variableSourceStates></qf:proposalResult>`;
    const srv = fakeServer({});
    const { conn, adt } = await connected((r) => {
      if (r.url.includes("/quickfixes/evaluation")) return resp(200, evalXml, OK_XML);
      if (r.url === UNIMPL_URI) return resp(200, proposalXml, OK_XML);
      if (r.qs._action === "LOCK" || (r.url === CLS_SRC && r.method === "PUT") || r.url.includes("/activation")) {
        throw new Error("dry_run must never lock, write, or activate");
      }
      return srv.route(r);
    });

    const result = await abapQuickFix(
      conn,
      {
        mode: "apply",
        object: CLS,
        type: "CLAS/OC",
        line: 7,
        column: 0,
        proposal: "unimplemented_methods",
        dry_run: true,
      } as never,
      60_000,
      openGate(),
      journal,
    );

    expect(result.text).toContain("dry_run: true");
    expect(result.text).toContain("journal: nothing recorded (dry run)");
    expect(result.text).toContain(
      "NOTE: Dry run: nothing was written and nothing was journalled — no lock, PUT, DELETE, " +
        "activation, unlock or CTS call was made. Every request this preview made was a read.",
    );
    expect(result.text).toContain("+  METHOD if_oo_adt_classrun~main.");
    expect(result.text).toContain("+  ENDMETHOD.");
    expect(srv.state.source).toBe(SOURCE);
    expect(adt.calls.map((c) => c.label)).toStrictEqual([
      "GET /sap/bc/adt/repository/informationsystem/search",
      `GET ${CLS_SRC}`,
      "POST /sap/bc/adt/quickfixes/evaluation",
      `POST ${UNIMPL_URI}`,
      `GET ${CLS_URI}`,
      `GET ${CLS_SRC}`,
    ]);
    expect((await journal.list()).length).toBe(0);
  });
});
