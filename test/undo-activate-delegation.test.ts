/**
 * Issue #200 — activate-entry undo delegation, the stored `undoable` flag's
 * exact authority, and `abap_journal`'s surfacing of both.
 *
 * Harness copied from test/undo.test.ts (fake `HttpClient` + a real `Journal`
 * in a tmp dir) — trimmed to what this file exercises: a plain PROG/P report,
 * ordinary update/restore, and `journal.begin()`/`finish()` called directly
 * to build activate entries and legacy/forced fixtures that would be awkward
 * to produce through `abapWrite` alone.
 */
import { afterEach, afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import { Journal, type JournalConfig, type JournalEntry } from "../src/journal.js";
import { performUndo, planUndo } from "../src/adt/undo.js";
import { abapJournal } from "../src/tools/journal.js";
import { abapWrite } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import { useFluidState } from "./helpers/fluid-classic-fake.js";

const REPORT = "ZMCP_UNDO_REP";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_undo_rep";
const REPORT_SRC = `${REPORT_URI}/source/main`;

const V1 = "REPORT zmcp_undo_rep.\nWRITE: / 'one'.\n";
const V2 = "REPORT zmcp_undo_rep.\nWRITE: / 'two'.\n";

/** The server hands source back as CRLF, trailing newlines stripped. */
const asServer = (s: string) =>
  s
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "")
    .replace(/\n/g, "\r\n");

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

const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">${REPORT} does not exist</message><properties/></exc:exception>`;

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

const fluidState = useFluidState();
afterAll(async () => {
  await rm(fluidState.dir(), { recursive: true, force: true });
});

const cfg = (over: Partial<Record<string, unknown>> = {}): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
    stateDir: fluidState.dir(),
    ...over,
  });

/** T000 data-preview answer classifying the fake system NONPRODUCTIVE, so writes are allowed. */
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

/** A mutable fake server: one report whose source is `state.source`, or absent when `undefined`. */
function fakeServer(initial?: string) {
  const state: { source?: string } = { source: initial };
  const route = (r: Recorded): HttpClientResponse => {
    if (r.url === REPORT_SRC && r.method === "GET") {
      return state.source === undefined
        ? resp(404, NOT_FOUND_XML, OK_XML)
        : resp(200, asServer(state.source), { ...OK_TEXT, etag: `srv-${state.source.length}` });
    }
    if (r.url === REPORT_URI && r.method === "GET") {
      return state.source === undefined ? resp(404, NOT_FOUND_XML, OK_XML) : resp(200, OBJ_XML, OK_XML);
    }
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === REPORT_SRC && r.method === "PUT") {
      state.source = r.body ?? "";
      return resp(200, "", OK_TEXT);
    }
    if (r.url === REPORT_URI && r.method === "DELETE") {
      state.source = undefined;
      return resp(200, "", OK_TEXT);
    }
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
  dir = await mkdtemp(join(tmpdir(), "abap-undo-activate-"));
  journal = new Journal(jcfg(), "A4H");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
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

const ALLOW = {
  assertAllowed: (action: "write" | "delete", target: unknown) =>
    openGate().authorize(action === "delete" ? "delete" : "write", target as never),
  gate: openGate(),
};

const writeVia = (conn: AbapConnection, source: string) =>
  abapWrite(conn, { object: REPORT, type: "PROG/P", source } as never, 60_000, openGate(), journal);

const reportRef = () => ({ name: REPORT, type: "PROG/P", uri: REPORT_URI, package: "$TMP" });

// ---------------------------------------------------------------------------
// Item 1 — activate entries delegate their undo to the preceding write.
// ---------------------------------------------------------------------------

describe("activate-entry undo delegation", () => {
  it("undoes the preceding write, marks BOTH entries undone, and reports viaActivation", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);
    const writeEntry = (await journal.list())[0]!;
    expect(writeEntry.undoable).toBe(true);

    const activateEntry = await journal.begin({
      operation: "activate",
      object: reportRef(),
      existedBefore: true,
      beforeSource: V2,
    });
    expect(activateEntry).toBeDefined();
    await journal.finish(activateEntry!.id, { outcome: "succeeded" });

    const plan = await planUndo(conn, journal, (await journal.get(activateEntry!.id))!);
    expect(plan.undoable).toBe(true);
    expect(plan.action).toBe("restore");
    expect(plan.viaActivation).toEqual({ activateEntry: activateEntry!.id, writeEntry: writeEntry.id });

    const res = await performUndo(conn, journal, (await journal.get(activateEntry!.id))!, ALLOW);
    expect(res.performed).toBe(true);
    expect(res.viaActivation).toEqual({ activateEntry: activateEntry!.id, writeEntry: writeEntry.id });
    expect(srv.state.source).toBe(asServer(V1));

    const undoneWrite = await journal.get(writeEntry.id);
    const undoneActivate = await journal.get(activateEntry!.id);
    expect(undoneWrite!.undoneBy).toBe(res.undoEntryId);
    expect(undoneActivate!.undoneBy).toBe(res.undoEntryId);
  });

  it("refuses with 'No earlier write entry', zero requests, when the journal has no preceding write", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);

    const activateEntry = await journal.begin({
      operation: "activate",
      object: reportRef(),
      existedBefore: true,
      beforeSource: V1,
    });
    await journal.finish(activateEntry!.id, { outcome: "succeeded" });

    adt.calls.length = 0;
    const entry = (await journal.get(activateEntry!.id))!;
    const plan = await planUndo(conn, journal, entry);
    expect(plan.undoable).toBe(false);
    expect(plan.blocker).toMatch(/No earlier write entry/i);
    expect(plan.viaActivation).toBeUndefined();
    expect(adt.calls).toHaveLength(0);

    const err = await catchErr(performUndo(conn, journal, entry, ALLOW));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toMatch(/No earlier write entry/i);
    expect(adt.calls).toHaveLength(0);
  });

  it("refuses, naming the write entry, when the preceding write was already undone", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);
    await writeVia(conn, V2);
    const writeEntry = (await journal.list())[0]!;
    // Simulate the write already having been undone, without a real undo
    // pass — it stays the LATEST write entry for the object either way
    // (precedingWriteEntry does not filter on undoneBy).
    await journal.markUndone(writeEntry.id, "FAKE-UNDO-ENTRY-1");

    const activateEntry = await journal.begin({
      operation: "activate",
      object: reportRef(),
      existedBefore: true,
      beforeSource: V2,
    });
    await journal.finish(activateEntry!.id, { outcome: "succeeded" });

    adt.calls.length = 0;
    const entry = (await journal.get(activateEntry!.id))!;
    const err = await catchErr(performUndo(conn, journal, entry, ALLOW));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain(writeEntry.id);
    expect(err.message).toMatch(/already undone/i);
    expect(adt.calls).toHaveLength(0);
  });

  it("refuses, without naming a network call, when the preceding write is itself not undoable", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);

    // A write entry that existed before but whose before-image read never
    // resolved — writeTimeUndoability rule 11: not undoable, no blob to
    // restore.
    const notUndoableWrite = await journal.begin({
      operation: "update",
      object: reportRef(),
      existedBefore: true,
      beforeCapture: "failed",
    });
    await journal.finish(notUndoableWrite!.id, { outcome: "succeeded" });
    expect((await journal.get(notUndoableWrite!.id))!.undoable).toBe(false);

    const activateEntry = await journal.begin({
      operation: "activate",
      object: reportRef(),
      existedBefore: true,
      beforeSource: V1,
    });
    await journal.finish(activateEntry!.id, { outcome: "succeeded" });

    adt.calls.length = 0;
    const entry = (await journal.get(activateEntry!.id))!;
    const plan = await planUndo(conn, journal, entry);
    // planActivateUndo recurses into planUndo(pw) unconditionally, so
    // viaActivation is still attached even to a refused delegated plan.
    expect(plan.viaActivation).toEqual({
      activateEntry: entry.id,
      writeEntry: notUndoableWrite!.id,
    });
    expect(plan.undoable).toBe(false);
    expect(adt.calls).toHaveLength(0);

    const err = await catchErr(performUndo(conn, journal, entry, ALLOW));
    expect(err.code).toBe("BAD_INPUT");
    expect(adt.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Item 2 — the stored `undoable` flag is a real, narrowing-only authority.
// ---------------------------------------------------------------------------

describe("stored undoable flag", () => {
  it("refuses an otherwise-clean restore when undoable is stored false, and force=true does not override it", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);
    await writeVia(conn, V2);
    const original = (await journal.list())[0]!;
    const REASON = "custom reason: recorded not undoable for this test";
    const forced: JournalEntry = { ...original, undoable: false, undoBlocker: REASON };

    adt.calls.length = 0;
    const plan = await planUndo(conn, journal, forced);
    expect(plan.undoable).toBe(false);
    expect(plan.blocker).toBe(REASON);
    expect(plan.blockerForceable).toBeFalsy();
    expect(adt.calls).toHaveLength(0);

    const err = await catchErr(performUndo(conn, journal, forced, ALLOW));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toBe(REASON);
    expect(adt.calls).toHaveLength(0);

    const stillErr = await catchErr(performUndo(conn, journal, forced, { ...ALLOW, force: true }));
    expect(stillErr.code).toBe("BAD_INPUT");
    expect(stillErr.message).toBe(REASON);
    expect(adt.calls).toHaveLength(0);
    // Nothing was ever touched on the server.
    expect(srv.state.source).toBe(V2);
  });

  it("stored undoable=true does not skip the drift check", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);
    const original = (await journal.list())[0]!;
    expect(original.undoable).toBe(true);

    // Someone else changes the object after our write.
    srv.state.source = "REPORT zmcp_undo_rep.\nWRITE: / 'someone else'.\n";

    const forcedTrue: JournalEntry = { ...original, undoable: true, undoBlocker: "" };
    const err = await catchErr(performUndo(conn, journal, forcedTrue, ALLOW));
    expect(err.code).toBe("ETAG_CONFLICT");
    expect(err.message).toMatch(/has CHANGED on the server/);
    expect(srv.state.source).toMatch(/someone else/);
  });
});

// ---------------------------------------------------------------------------
// Item 7 — abap_journal surfaces `undoable` / `undo_blocker`.
// ---------------------------------------------------------------------------

describe("abap_journal undoable/undo_blocker columns", () => {
  it("mode=list shows undoable yes/no and a truncated undo_blocker", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2); // an ordinary undoable=true entry

    const LONG = "X".repeat(200);
    const blocked = await journal.begin({
      operation: "update",
      object: { name: "ZMCP_BLOCKED", type: "PROG/P", uri: "/sap/bc/adt/programs/programs/zmcp_blocked", package: "$TMP" },
      existedBefore: true,
      beforeSource: V1,
      undoBlocker: LONG,
    });
    await journal.finish(blocked!.id, { outcome: "succeeded" });

    const list = await abapJournal(conn, { mode: "list" }, 60_000, journal);
    expect(list.text).toContain("undoable");
    expect(list.text).toContain("undo_blocker");
    expect(list.text).toMatch(/\byes\b/);
    expect(list.text).toContain(`${LONG.slice(0, 160)}… (mode=show for the full reason)`);
    expect(list.text).not.toContain(LONG); // the untruncated 200-char string never appears
  });

  it('mode=list shows "unknown (written before this version)" for an entry with no undoable field', async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);

    const legacyId = "20200101T000000000Z-abc999";
    await writeFile(
      join(dir, "index.jsonl"),
      JSON.stringify({
        id: legacyId,
        ts: "2020-01-01T00:00:00.000Z",
        system: "A4H",
        operation: "update",
        object: { name: "ZMCP_LEGACY", type: "PROG/P", uri: "/sap/bc/adt/programs/programs/zmcp_legacy", package: "$TMP" },
        existedBefore: true,
        outcome: "succeeded",
      }) + "\n",
      "utf8",
    );

    const list = await abapJournal(conn, { mode: "list", object: "ZMCP_LEGACY" }, 60_000, journal);
    expect(list.text).toContain("unknown (written before this version)");
  });

  it("mode=show carries the full, untruncated undoBlocker", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);

    const LONG = "Y".repeat(200);
    const blocked = await journal.begin({
      operation: "update",
      object: { name: "ZMCP_BLOCKED2", type: "PROG/P", uri: "/sap/bc/adt/programs/programs/zmcp_blocked2", package: "$TMP" },
      existedBefore: true,
      beforeSource: V1,
      undoBlocker: LONG,
    });
    await journal.finish(blocked!.id, { outcome: "succeeded" });

    const show = await abapJournal(conn, { mode: "show", entry: blocked!.id }, 60_000, journal);
    expect(show.text).toContain(LONG);
    expect(show.text).toMatch(/WILL BE REFUSED/);
  });
});
