/**
 * B3 — the restore branch of `abap_journal mode=undo`: what happens when the
 * before-image PUT lands but the post-restore `activateObject` call then
 * throws.
 *
 * The neighbouring pre-activation ETAG_CONFLICT guard in src/adt/undo.ts
 * already names the "saved but not activated" state explicitly. Before this
 * fix, the activation call three lines below it had no such disclosure: a
 * throw there left the before-image saved as the server's INACTIVE version,
 * the undo's own journal entry stranded `pending` with nothing pointing back
 * at what it restored, and the original entry never marked undone — while the
 * caller saw a bare activation error that reads like nothing happened.
 *
 * These tests drive the real `performUndo` against a fake HTTP layer (same
 * idiom as test/undo.test.ts) and pin: the disclosed error keeps its original
 * `code`, the hint says what actually happened, the details correlate both
 * journal entries, the undo entry is left `pending` (not `failed`, not
 * absent), the original entry is not marked undone, and the happy path is
 * unaffected.
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
import { abapWrite } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";

const REPORT = "ZMCP_UNDO_ACT_REP";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_undo_act_rep";
const REPORT_SRC = `${REPORT_URI}/source/main`;

const V1 = "REPORT zmcp_undo_act_rep.\nWRITE: / 'one'.\n";
const V2 = "REPORT zmcp_undo_act_rep.\nWRITE: / 'two'.\n";

// Server-side normalisation, same model test/undo.test.ts uses: CRLF, trailing
// blank/tab trimmed per line, trailing newlines stripped.
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

/** 403 the live A4H "somebody else is editing this object" shape — see test/activate.test.ts. */
const ACTIVATE_LOCKED_XML = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceNoAccess"/>
  <message lang="EN">User DEVELOPER is currently editing ${REPORT}</message>
  <properties/>
</exc:exception>`;

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

/**
 * Same mutable fake server as test/undo.test.ts, plus a counter over the
 * activation POST specifically: the Nth call to `/activation` (1-based) can
 * be redirected to a caller-supplied failure response instead of the usual
 * clean 200. `failOn: undefined` never fails — every call succeeds, the
 * ordinary happy-path shape.
 */
function fakeServer(initial: string | undefined, opts: { failOn?: number; failResp?: HttpClientResponse } = {}) {
  const state: { source?: string } = { source: initial };
  let activationCalls = 0;
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
    if (r.url.includes("/checkruns")) {
      return resp(200, `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`, OK_XML);
    }
    if (r.url.includes("/activation")) {
      activationCalls += 1;
      if (opts.failOn !== undefined && activationCalls === opts.failOn) {
        return opts.failResp ?? resp(500, "<html>ICM</html>", { "content-type": "text/html" });
      }
      return resp(200, "", OK_TEXT);
    }
    return resp(200, "", OK_TEXT);
  };
  return { state, route };
}

let dir: string;
let journal: Journal;

const jcfg = (): JournalConfig => ({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "abap-undo-act-"));
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

// Same visible-authorisation idiom as test/undo.test.ts's ALLOW.
const ALLOW: UndoOptions = {
  assertAllowed: (action, target) => openGate().authorize(action === "delete" ? "delete" : "write", target),
  gate: openGate(),
};

const writeVia = (conn: AbapConnection, source: string) =>
  abapWrite(conn, { object: REPORT, type: "PROG/P", source } as never, 60_000, openGate(), journal);

describe("undo restore, activation throws (B3 disclosure)", () => {
  it("keeps the original error code, discloses the saved-inactive before-image, and correlates both journal entries", async () => {
    // First `/activation` call is the setup write's own; the SECOND is the
    // undo's — that is the one this test fails.
    const srv = fakeServer(V1, { failOn: 2, failResp: resp(403, ACTIVATE_LOCKED_XML, OK_XML) });
    const { conn } = await connected(srv.route);

    await writeVia(conn, V2);
    const original = (await journal.list())[0]!;
    expect(original.outcome).toBe("succeeded");

    const err = await catchErr(performUndo(conn, journal, original, ALLOW));

    // translateActivationError's own classification for this 403 shape is
    // LOCKED — the disclosure must NOT change that.
    expect(err.code).toBe("LOCKED");

    // The restore itself DID land (as the inactive version) — the hint must
    // say so, not read like a bare activation failure.
    expect(err.hint).toMatch(/inactive/i);
    expect(err.hint).toMatch(/pending/i);
    expect(err.hint).toMatch(/undo again/i);

    // Identity keys correlating the two entries, same idiom as the
    // neighbouring pre-activation ETAG_CONFLICT guard.
    expect(err.details.entry).toBe(original.id);
    expect(err.details.written).toBe(true);
    expect(err.details.activated).toBe(false);
    expect(typeof err.details.journal).toBe("string");

    const undoEntryId = err.details.journal as string;
    const undoEntry = await journal.get(undoEntryId);
    expect(undoEntry).toBeDefined();
    // Left pending — never patched to failed, never absent.
    expect(undoEntry!.outcome).toBe("pending");
    expect(undoEntry!.undoOf).toBe(original.id);

    // The original entry must NOT be marked undone: the outcome was never proven.
    const reloadedOriginal = await journal.get(original.id);
    expect(reloadedOriginal!.undoneBy).toBeUndefined();

    // The before-image really did land server-side (as the inactive version) —
    // the PUT was not itself part of what failed.
    expect(srv.state.source).toBe(asServer(V1));
  });

  it("preserves the original error's message and lets a caller still branch on hint prose for the safe next move", async () => {
    const srv = fakeServer(V1, { failOn: 2, failResp: resp(403, ACTIVATE_LOCKED_XML, OK_XML) });
    const { conn } = await connected(srv.route);

    await writeVia(conn, V2);
    const original = (await journal.list())[0]!;

    const err = await catchErr(performUndo(conn, journal, original, ALLOW));

    // message is untouched — same string translateActivationError produced.
    expect(err.message).toMatch(/User DEVELOPER is currently editing/i);
    // hint appends the disclosure onto the original hint rather than replacing it.
    expect(err.hint).toMatch(/unlock/i); // original LOCKED hint survives
    expect(err.hint).toMatch(/re-read/i); // the safe-next-move disclosure
    expect(err.hint).toMatch(new RegExp(original.id));
  });

  it("regression: the happy path still activates, settles succeeded, and marks the original entry undone", async () => {
    const srv = fakeServer(V1); // no failOn — every activation call succeeds
    const { conn } = await connected(srv.route);

    await writeVia(conn, V2);
    const original = (await journal.list())[0]!;

    const res = await performUndo(conn, journal, original, ALLOW);

    expect(res.performed).toBe(true);
    expect(res.activation?.activated).toBe(true);
    expect(srv.state.source).toBe(asServer(V1));

    expect(res.undoEntryId).toBeDefined();
    const undoEntry = await journal.get(res.undoEntryId!);
    expect(undoEntry!.outcome).toBe("succeeded");

    const reloadedOriginal = await journal.get(original.id);
    expect(reloadedOriginal!.undoneBy).toBe(res.undoEntryId);
  });
});
