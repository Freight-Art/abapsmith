/**
 * Undo and drift detection — offline, with a fake `HttpClient`.
 *
 * These pin the correctness requirements that are the whole point of undo.
 * The restore itself is the easy half; the half that matters is the *refusal*:
 *
 *   - a before-image is captured BEFORE the mutation, not after;
 *   - third-party drift stops an undo in BOTH directions — the object changed,
 *     and the object vanished — and an explicit `force` is the only way past;
 *   - undo of a create is a DELETE, decided from `existedBefore`, never from
 *     the operation label;
 *   - a refused undo makes ZERO network calls;
 *   - objects the journal never saw are refused in plain words rather than
 *     guessed at.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
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
import { AbapError, RETRYABILITY, isAbapError } from "../src/adt/errors.js";
import {
  Journal,
  sourceFingerprint,
  systemKey,
  type JournalConfig,
  type JournalEntry,
} from "../src/journal.js";
import {
  detectDrift,
  performUndo,
  planUndo,
  plannedAction,
  targetFromEntry,
  type UndoOptions,
} from "../src/adt/undo.js";
import { abapJournal, undoPreflightTarget } from "../src/tools/journal.js";
import { abapWrite } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import { DDIC_BRIDGE_CLASS } from "../src/adt/ddic-bridge.js";
import { vitBridgeUri } from "../src/adt/write-verify.js";
import { PKG_CONTENT_PREFIX } from "../src/adt/package-delete.js";
import { searchResultsXml, type FakeObjectRef } from "./helpers/fake-adt.js";

const REPORT = "ZMCP_UNDO_REP";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_undo_rep";
const REPORT_SRC = `${REPORT_URI}/source/main`;

const V1 = "REPORT zmcp_undo_rep.\nWRITE: / 'one'.\n";
const V2 = "REPORT zmcp_undo_rep.\nWRITE: / 'two'.\n";
/**
 * The server hands source back as CRLF, trailing `[ \t]` trimmed from every
 * line, and ALL trailing newlines stripped.
 *
 * Per-line trim added (previously missing) so this fake stays an accurate
 * model of A4H now that the trim is measured (ZMCP_NL2_PROGW, probe 1b) —
 * harmless against every existing input here since none of this file's
 * sources carry trailing space/tab, so the suite stays green with no input
 * changes.
 */
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

/**
 * The object descriptor a GET of the object URI returns. The `adtcore:packageRef`
 * is not decoration: `resolveWriteTarget` refuses to write an object whose
 * package the server did not state, so a descriptor without it fails every
 * write here before it starts.
 */
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
  get verbs(): string[] {
    return this.calls.map((c) => (c.qs._action ? c.qs._action : c.method));
  }
}

const cfg = (over: Partial<Record<string, unknown>> = {}): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    // The logon client is REQUIRED for these tests to be able to write at all:
    // `connect()` classifies the system from T000 for a known client, and an
    // unclassifiable system is pinned read-only (fail closed).
    client: "001",
    readOnly: false,
    ...over,
  });

/**
 * The T000 data-preview answer, in the column-major shape A4H really returns
 * (test/fixtures/live-captured/087-p3b-datapreview-t000.xml, trimmed). Client
 * 001 is CCCATEGORY "C" — not "P" — so the system classifies as NONPRODUCTIVE
 * and writes are allowed. Without this the fake server is "inconclusive" and
 * every write in this file is refused before it starts.
 */
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
 * A mutable fake server: one report whose source is whatever `state.source` is,
 * or absent when it is `undefined`. Writes and deletes update it, so a test can
 * assert on the *state the server ends in* rather than on request order alone.
 */
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
  dir = await mkdtemp(join(tmpdir(), "abap-undo-"));
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

/**
 * An entry with POSITIVE evidence that the object was absent before the write.
 *
 * Undo may only delete on `beforeCapture === "confirmed-absent"`. `abapWrite`
 * now records exactly that for a create (off a genuine 404 from the pre-write
 * metadata GET), so this is a no-op for entries it produced — kept because
 * tests that are about something OTHER than the evidence gate (drift, DDIC
 * bytes, the delete mechanics) must state the precondition they rely on
 * instead of inheriting it silently from another file.
 */
const evidencedAbsent = (e: JournalEntry): JournalEntry => ({
  ...e,
  beforeCapture: "confirmed-absent",
});

/**
 * The opposite: an entry that says the object was absent but not how it knows.
 * Legacy entries (written before provenance existed) look like this, and undo
 * must refuse to delete on them however old they are.
 */
const unevidenced = (e: JournalEntry): JournalEntry => ({ ...e, beforeCapture: "unknown" });

/**
 * `abapWrite` takes a mandatory gate, so the setup writes need one. It is
 * deliberately permissive: these tests are about undo semantics, and the gate
 * has its own describe block below where it is supposed to say no.
 */
const openGate = (): SafetyGate => new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

/**
 * `performUndo` REQUIRES an authorisation hook — a caller with no gate has to
 * say so in the source rather than get an unchecked mutation by omission (see
 * `UndoOptions.assertAllowed`). It must return the `AuthorizedTarget` proof
 * `writeObject`/`deleteObject` require to run at all (the safety-gate
 * authorisation layer), so this routes through the same deliberately-permissive
 * `openGate()` every setup write in this file uses — a real authorisation,
 * not a rubber stamp. Tests that are not about authorisation pass this
 * visible helper; grep for it to find every unauthorised undo in the suite.
 */
const ALLOW: UndoOptions = {
  assertAllowed: (action, target) => openGate().authorize(action === "delete" ? "delete" : "write", target),
  gate: openGate(),
};

const writeVia = (conn: AbapConnection, source: string, extra: Record<string, unknown> = {}) =>
  abapWrite(conn, { object: REPORT, type: "PROG/P", source, ...extra } as never, 60_000, openGate(), journal);

// ---------------------------------------------------------------------------

describe("before-image capture", () => {
  it("records the previous source BEFORE the write, and the entry survives it", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);

    await writeVia(conn, V2);

    const entries = await journal.list();
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.operation).toBe("update");
    expect(e.existedBefore).toBe(true);
    expect(e.outcome).toBe("succeeded");
    // The before-image is what the SERVER had, byte-for-byte — CRLF and all.
    // Normalising it here would quietly change what undo restores.
    expect(await journal.beforeImage(e)).toBe(asServer(V1));
    expect(e.after?.fingerprint).toBe(sourceFingerprint(V2));
  });

  it("marks a brand-new object as existedBefore=false with no before-image", async () => {
    const srv = fakeServer(undefined);
    const { conn } = await connected(srv.route);

    await writeVia(conn, V1);

    const e = (await journal.list())[0]!;
    expect(e.operation).toBe("create");
    expect(e.existedBefore).toBe(false);
    expect(e.before).toBeUndefined();
    expect(await journal.beforeImage(e)).toBeUndefined();
    // This single boolean is what makes undo a DELETE rather than a restore.
    expect(plannedAction(e)).toBe("delete");
  });

  it("journals nothing for a byte-identical no-op write", async () => {
    // Nothing changed on the server, so there is nothing to undo. An entry here
    // would be a lie that `undo` would then act on.
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);

    const res = await writeVia(conn, V1);

    expect(res.text).toMatch(/changed: false/);
    expect(await journal.list()).toHaveLength(0);
  });

  it("records the before-image of a DELETE, so the object can be recreated", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);

    await abapWrite(
      conn,
      { object: REPORT, type: "PROG/P", mode: "delete" } as never,
      60_000,
      openGate(),
      journal,
    );

    const e = (await journal.list())[0]!;
    expect(e.operation).toBe("delete");
    expect(e.existedBefore).toBe(true);
    expect(await journal.beforeImage(e)).toBe(asServer(V1));
    expect(plannedAction(e)).toBe("recreate");
    expect(srv.state.source).toBeUndefined();
  });

  it("marks the entry `failed` when the write blows up, and keeps the before-image", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "PUT") return resp(500, "boom", OK_TEXT);
      return srv.route(r);
    });

    await catchErr(writeVia(conn, V2));

    const e = (await journal.list())[0]!;
    expect(e.outcome).toBe("failed");
    expect(await journal.beforeImage(e)).toBe(asServer(V1));
  });
});

describe("drift detection", () => {
  it("passes when the server still holds exactly what we wrote", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);

    const plan = await planUndo(conn, journal, (await journal.list())[0]!);
    expect(plan.drift.drifted).toBe(false);
    expect(plan.action).toBe("restore");
    expect(plan.undoable).toBe(true);
  });

  it("DIRECTION 1 — refuses when someone else changed the object after our write", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);

    // Eclipse / SE38 / another agent edits it behind our back.
    srv.state.source = "REPORT zmcp_undo_rep.\nWRITE: / 'someone else'.\n";

    const e = (await journal.list())[0]!;
    const err = await catchErr(performUndo(conn, journal, e, ALLOW));
    expect(err.code).toBe("ETAG_CONFLICT");
    expect(err.message).toMatch(/has CHANGED on the server/);
    // The message must say WHAT changed, not merely that something did.
    expect(err.details.expectedFingerprint).toBe(sourceFingerprint(V2));
    expect(err.details.actualFingerprint).toBe(sourceFingerprint(srv.state.source!));
    // …and nothing was touched.
    expect(srv.state.source).toMatch(/someone else/);
  });

  it("DIRECTION 2 — refuses when the object was deleted after our write", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);

    srv.state.source = undefined; // deleted behind our back

    const err = await catchErr(performUndo(conn, journal, (await journal.list())[0]!, ALLOW));
    expect(err.code).toBe("ETAG_CONFLICT");
    expect(err.message).toMatch(/no longer exists/);
  });

  it("DIRECTION 2b — refuses to delete an object we created that someone then edited", async () => {
    // The nastiest case: undo-of-create is a DELETE, so a false negative here
    // destroys somebody's work outright rather than merely overwriting text.
    const srv = fakeServer(undefined);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V1);

    srv.state.source = V2; // they edited the object we created

    const err = await catchErr(
      performUndo(conn, journal, evidencedAbsent((await journal.list())[0]!), ALLOW),
    );
    expect(err.code).toBe("ETAG_CONFLICT");
    expect(srv.state.source).toBe(V2);
  });

  it("refuses when a deleted object has been recreated by somebody else", async () => {
    const entry = {
      id: "x",
      ts: new Date().toISOString(),
      system: "A4H",
      operation: "delete" as const,
      object: { name: REPORT, type: "PROG/P", uri: REPORT_URI, package: "$TMP" },
      existedBefore: true,
      beforeCapture: "captured" as const,
      before: { etag: "e", fingerprint: sourceFingerprint(V1), bytes: V1.length },
      outcome: "succeeded" as const,
    };
    const d = detectDrift(entry, "recreate", { exists: true, source: V2 });
    expect(d.drifted).toBe(true);
    expect(d.reason).toMatch(/EXISTS on the server again/);
  });

  it("is not fooled by the trailing newline the server strips", async () => {
    // A subtle bug in drift's clothing: we PUT `…\n`, the server hands back
    // `…` with CRLF. A raw hash comparison would report drift on every undo.
    const entry = {
      id: "x",
      ts: new Date().toISOString(),
      system: "A4H",
      operation: "update" as const,
      object: { name: REPORT, type: "PROG/P", uri: REPORT_URI, package: "$TMP" },
      existedBefore: true,
      beforeCapture: "captured" as const,
      after: { etag: "e", fingerprint: sourceFingerprint(V2), bytes: V2.length },
      outcome: "succeeded" as const,
    };
    const d = detectDrift(entry, "restore", { exists: true, source: asServer(V2) });
    expect(d.drifted).toBe(false);
  });

  it("treats an already-reverted object as nothing-to-do, not as drift", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);
    srv.state.source = V1; // someone put it back by hand

    const res = await performUndo(conn, journal, (await journal.list())[0]!, ALLOW);
    expect(res.performed).toBe(false);
    expect(res.plan.action).toBe("noop");
  });

  it("force=true overrides the refusal and preserves what it overwrote", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);
    const theirs = "REPORT zmcp_undo_rep.\nWRITE: / 'theirs'.\n";
    srv.state.source = theirs;

    const res = await performUndo(conn, journal, (await journal.list())[0]!, { ...ALLOW, force: true });

    expect(res.performed).toBe(true);
    expect(res.forced).toBe(true);
    expect(srv.state.source).toBe(asServer(V1));
    // The overwritten third-party change must itself be recoverable — the undo
    // is journalled, so its before-image IS their version.
    const undoEntry = await journal.get(res.undoEntryId!);
    expect(await journal.beforeImage(undoEntry!)).toBe(asServer(theirs));
  });
});

/**
 * A consequence worse than the write loop it sits next to.
 *
 * `src/tools/write.ts` stores `afterSource: input.source` — the caller's
 * UNTRIMMED buffer — as `entry.after.fingerprint`. `src/adt/undo.ts`
 * (`detectDrift`) compares that against `sourceFingerprint(now.source)`, the
 * server's TRIMMED readback (`asServer` here models the server's trim, same as
 * the rest of this file). Pre-fix, writing any source with a trailing space
 * GUARANTEED the next undo reported `drifted: true` — a false accusation of
 * third-party drift ("Eclipse/SE38/another agent edited this") — and REFUSED
 * the undo outright. This fix closes it.
 */
describe("a trailing space on the written source must not manufacture drift", () => {
  it("does not report drifted for a source that carried a trailing space when written", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    // Same content as V2, but with a trailing space on its last content line —
    // exactly the shape that used to guarantee a false drift report.
    const V2_TRAILING_SPACE = "REPORT zmcp_undo_rep.\nWRITE: / 'two'.  \n";
    await writeVia(conn, V2_TRAILING_SPACE);

    const plan = await planUndo(conn, journal, (await journal.list())[0]!);
    expect(plan.drift.drifted).toBe(false);
    expect(plan.action).toBe("restore");
    expect(plan.undoable).toBe(true);
  });
});

describe("performing the undo", () => {
  it("restores an update byte-for-byte and re-activates", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);
    await writeVia(conn, V2);
    expect(srv.state.source).toBe(V2);

    adt.calls.length = 0;
    const res = await performUndo(conn, journal, (await journal.list())[0]!, ALLOW);

    expect(res.performed).toBe(true);
    expect(res.plan.action).toBe("restore");
    // Byte-identical to what the server originally held.
    expect(srv.state.source).toBe(asServer(V1));
    // …and the ordering that cannot be got wrong: unlock strictly before activate.
    const verbs = adt.verbs;
    expect(verbs.indexOf("UNLOCK")).toBeLessThan(verbs.lastIndexOf("POST"));
    expect(res.activation?.activated).toBe(true);
  });

  /**
   * The syntax check on the before-image is ADVISORY and must never block.
   *
   * Restoring a known-broken state in order to then fix it forward is a real
   * workflow. Refusing to restore because the rollback target does not compile
   * would be the tool overriding the user's judgment about their own code —
   * they are trying to get *back* to a known state, and the state being bad is
   * exactly why they want to leave it. Drift is the only default blocker,
   * because that one protects somebody else's work.
   */
  it("reports a broken before-image but restores it ANYWAY", async () => {
    const srv = fakeServer(V1);
    // Only break checkruns AFTER the setup write — abap_write runs its own
    // check on V2 (which must stay clean, or the setup write itself
    // now throws CHECK_FAILED instead of landing); this test is about the
    // ADVISORY check performUndo runs against the restored before-image, V1.
    let broken = false;
    const { conn } = await connected((r) => {
      if (broken && r.url.includes("/checkruns")) {
        return resp(
          200,
          `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun">` +
            `<chkrun:checkReport><chkrun:checkMessageList>` +
            `<chkrun:checkMessage chkrun:uri="${REPORT_SRC}#start=2,0" chkrun:type="E" ` +
            `chkrun:shortText="Statement is not expected."/>` +
            `</chkrun:checkMessageList></chkrun:checkReport></chkrun:checkRunReports>`,
          OK_XML,
        );
      }
      return srv.route(r);
    });
    await writeVia(conn, V2);
    broken = true;

    const res = await performUndo(conn, journal, (await journal.list())[0]!, ALLOW);

    expect(res.performed).toBe(true);
    expect(res.check?.ok).toBe(false);
    expect(res.check?.errors).toBeGreaterThan(0);
    // The restore happened regardless.
    expect(srv.state.source).toBe(asServer(V1));
  });

  it("says the undo was performed even when the restored version is broken", async () => {
    const srv = fakeServer(V1);
    // Same reasoning as the previous test: keep the setup write's own check
    // clean and only surface the synthetic syntax error for the restore's
    // advisory check, or the setup write throws CHECK_FAILED before
    // there is even a journal entry to undo.
    let broken = false;
    const { conn } = await connected((r) => {
      if (broken && r.url.includes("/checkruns")) {
        return resp(
          200,
          `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun">` +
            `<chkrun:checkReport><chkrun:checkMessageList>` +
            `<chkrun:checkMessage chkrun:uri="${REPORT_SRC}#start=2,0" chkrun:type="E" ` +
            `chkrun:shortText="Statement is not expected."/>` +
            `</chkrun:checkMessageList></chkrun:checkReport></chkrun:checkRunReports>`,
          OK_XML,
        );
      }
      return srv.route(r);
    });
    await writeVia(conn, V2);
    broken = true;
    const entry = (await journal.list())[0]!;

    const out = await abapJournal(conn, { mode: "undo", entry: entry.id }, 60_000, journal, openGate());
    expect(out.text).toMatch(/performed: true/);
    expect(out.text).toMatch(/syntax error\(s\)/);
    expect(out.text).toMatch(/undo was performed anyway/i);
  });

  it("a checkruns failure never stops the restore", async () => {
    // The advisory check is best-effort: if the endpoint itself errors, that is
    // not a reason to withhold the user's rollback.
    const srv = fakeServer(V1);
    // Only break checkruns AFTER the setup write — abap_write runs its own
    // check, and breaking that would test the wrong thing.
    let broken = false;
    const { conn } = await connected((r) => {
      if (broken && r.url.includes("/checkruns")) return resp(500, "boom", OK_TEXT);
      return srv.route(r);
    });
    await writeVia(conn, V2);
    broken = true;

    const res = await performUndo(conn, journal, (await journal.list())[0]!, ALLOW);
    expect(res.performed).toBe(true);
    expect(res.check).toBeUndefined();
    // …but the response says WHY it is undefined, so "no check result" cannot
    // be misread as "the check found nothing".
    expect(res.checkUnavailable).toMatch(/could not be run/);
    expect(srv.state.source).toBe(asServer(V1));
  });

  it("check=false skips the pre-flight request entirely", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);
    await writeVia(conn, V2);

    adt.calls.length = 0;
    const res = await performUndo(conn, journal, (await journal.list())[0]!, { ...ALLOW, check: false });
    expect(res.check).toBeUndefined();
    expect(adt.calls.some((c) => c.url.includes("/checkruns"))).toBe(false);
    expect(srv.state.source).toBe(asServer(V1));
  });

  it("undo of a create DELETES the object", async () => {
    const srv = fakeServer(undefined);
    const { conn, adt } = await connected(srv.route);
    await writeVia(conn, V1);
    expect(srv.state.source).toBe(V1);

    adt.calls.length = 0;
    const res = await performUndo(conn, journal, evidencedAbsent((await journal.list())[0]!), ALLOW);

    expect(res.plan.action).toBe("delete");
    expect(srv.state.source).toBeUndefined();
    expect(adt.verbs).toContain("DELETE");
  });

  /**
   * `deleteObject`'s post-delete verification is three-valued, and the
   * undo-of-create path used to collapse `"unverified"` and `false` into the
   * same `succeeded` outcome. These two pin the three-way branch in
   * `performUndo`'s `plan.action === "delete"` block.
   */
  const UNDO_SEARCH_PATH = "/sap/bc/adt/repository/informationsystem/search";

  it("undo of a create whose delete can't be verified either way still settles succeeded, DELETEs, and surfaces deleteUnverified", async () => {
    const srv = fakeServer(undefined);
    const { conn } = await connected((r) => {
      if (r.url === REPORT_URI && r.method === "DELETE") {
        // the DELETE itself is accepted normally — srv.route flips the state
        return srv.route(r);
      }
      if (r.url === REPORT_SRC && r.method === "GET" && srv.state.source === undefined) {
        // post-delete: the read-back blows up before a 404/200 status can be
        // determined at all — neither probe alone
        return resp(500, "boom", OK_TEXT);
      }
      if (r.url === UNDO_SEARCH_PATH) {
        // and the repository search finds a hit under this exact name, but
        // typed differently — not proof either way (write-verify.ts's
        // "exact-name hit with a different type" branch)
        return resp(200, searchResultsXml([{ name: REPORT, type: "CLAS/OC", uri: REPORT_URI }]), OK_XML);
      }
      return srv.route(r);
    });
    await writeVia(conn, V1);
    expect(srv.state.source).toBe(V1);

    const markUndoneSpy = vi.spyOn(journal, "markUndone");
    const original = (await journal.list())[0]!;
    const res = await performUndo(conn, journal, evidencedAbsent(original), ALLOW);

    expect(res.plan.action).toBe("delete");
    expect(srv.state.source).toBeUndefined(); // the DELETE landed regardless
    expect(res.deleteUnverified).toBeDefined();
    expect(res.deleteUnverified).toMatch(/could not confirm the object is actually gone/);
    // Unverified is a durable success (the DELETE landed), so the original
    // entry IS marked undone — unlike the contradicted case below.
    expect(markUndoneSpy).toHaveBeenCalledWith(original.id, res.undoEntryId);
    expect((await journal.get(original.id))!.undoneBy).toBe(res.undoEntryId);
  });

  it("undo of a create whose object still verifiably exists after the DELETE throws CHECK_FAILED and never marks the original entry undone", async () => {
    const srv = fakeServer(undefined);
    const { conn } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") {
        // the read-back keeps answering 200 no matter what the DELETE did
        return resp(200, asServer(V1), { ...OK_TEXT, etag: "srv-stale" });
      }
      if (r.url === UNDO_SEARCH_PATH) {
        // and an independent repository search agrees the object is still there
        return resp(200, searchResultsXml([{ name: REPORT, type: "PROG/P", uri: REPORT_URI }]), OK_XML);
      }
      return srv.route(r);
    });
    await writeVia(conn, V1);
    const original = (await journal.list())[0]!;

    const markUndoneSpy = vi.spyOn(journal, "markUndone");
    const err = await catchErr(performUndo(conn, journal, evidencedAbsent(original), ALLOW));

    expect(err.code).toBe("CHECK_FAILED");
    expect(err.details.reason).toBe("DELETE_NOT_CONFIRMED");
    // The actual guarantee is that the original entry survives — asserted on
    // the journal's own recorded calls, not just on the thrown error.
    expect(markUndoneSpy).not.toHaveBeenCalled();
    expect((await journal.get(original.id))!.undoneBy).toBeUndefined();
  });

  it("undo of a delete recreates the object from the before-image", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await abapWrite(
      conn,
      { object: REPORT, type: "PROG/P", mode: "delete" } as never,
      60_000,
      openGate(),
      journal,
    );
    expect(srv.state.source).toBeUndefined();

    const res = await performUndo(conn, journal, (await journal.list())[0]!, ALLOW);
    expect(res.plan.action).toBe("recreate");
    expect(srv.state.source).toBe(asServer(V1));
  });

  it("is itself journalled, so an undo can be undone", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);
    const original = (await journal.list())[0]!;

    const res = await performUndo(conn, journal, original, ALLOW);
    expect(srv.state.source).toBe(asServer(V1));

    const undoEntry = (await journal.get(res.undoEntryId!))!;
    expect(undoEntry.undoOf).toBe(original.id);
    expect((await journal.get(original.id))!.undoneBy).toBe(undoEntry.id);

    // Undo the undo → back to V2.
    await performUndo(conn, journal, undoEntry, ALLOW);
    expect(srv.state.source).toBe(asServer(V2));
  });

  it("refuses an entry that is already undone unless the object drifted back", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);
    const original = (await journal.list())[0]!;
    await performUndo(conn, journal, original, ALLOW);

    // The server now holds V1, i.e. the before-image: a second undo is a no-op
    // rather than an error, and it must NOT re-write anything.
    const again = await performUndo(conn, journal, (await journal.get(original.id))!, ALLOW);
    expect(again.performed).toBe(false);
  });

  it("refuses an activation entry in plain words", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    // `begin()` answers `undefined` when the journal is off; this one is on, so
    // the assertion is about the test's own setup, not about undo.
    const e = await journal.begin({
      operation: "activate",
      object: { name: REPORT, type: "PROG/P", uri: REPORT_URI, package: "$TMP" },
      existedBefore: true,
      beforeSource: V1,
    });
    expect(e).toBeDefined();
    await journal.finish(e!.id, { outcome: "succeeded" });

    const err = await catchErr(performUndo(conn, journal, (await journal.get(e!.id))!, ALLOW));
    expect(err.message).toMatch(/no deactivate operation|nothing to reverse/i);
  });

  /**
   * A transport request, journalled as a `JournalObjectRef` whose `name` IS the
   * TRKORR. The connection/server fixtures above are irrelevant
   * to these entries — the refusal is decided from the entry alone, before any
   * request — but `performUndo` still wants a live `conn` to call, so the
   * ordinary `fakeServer(V1)` is reused purely as plumbing.
   */
  const TRKORR = "A4HK900123";
  const transportRef = (trkorr = TRKORR) => ({
    name: trkorr,
    type: "CTS/TR",
    uri: `/sap/bc/adt/cts/transportrequests/${trkorr}`,
    package: "",
  });

  it("refuses to undo a released transport, by name, with the exact reason (irreversible)", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);
    const e = await journal.begin({
      operation: "transport-release",
      object: transportRef(),
      existedBefore: true,
      corrNr: TRKORR,
      irreversible: true,
    });
    expect(e).toBeDefined();
    await journal.finish(e!.id, { outcome: "succeeded" });

    const err = await catchErr(performUndo(conn, journal, (await journal.get(e!.id))!, ALLOW));
    // Exact wording — this is the one refusal the design pins verbatim.
    expect(err.message).toBe(
      "a released transport cannot be recalled; create a corrective transport instead",
    );
    expect(adt.calls).toHaveLength(0); // refused before any request, like every other blocker
    // Not even force=true gets past it: there is no evidence to "accept" here,
    // unlike the partial-class-restore case below.
    const stillErr = await catchErr(
      performUndo(conn, journal, (await journal.get(e!.id))!, { ...ALLOW, force: true }),
    );
    expect(stillErr.message).toBe(
      "a released transport cannot be recalled; create a corrective transport instead",
    );
  });

  it("refuses to undo any other transport-* entry with the generic transport reason", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);
    for (const op of ["transport-create", "transport-add-user", "transport-set-owner"] as const) {
      const e = await journal.begin({
        operation: op,
        object: transportRef(),
        existedBefore: op !== "transport-create",
        corrNr: TRKORR,
      });
      await journal.finish(e!.id, { outcome: "succeeded" });

      const err = await catchErr(performUndo(conn, journal, (await journal.get(e!.id))!, ALLOW));
      expect(err.message).toBe(
        "transport requests are not undone automatically; use abap_transport to reverse this manually",
      );
    }
    expect(adt.calls).toHaveLength(0);
  });

  it("warns — but does not block — undoing a write whose transport was already released", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);
    const original = (await journal.list())[0]!;

    // The write's own entry did not know its corrNr at begin() time (this fake
    // server's LOCK response is IS_LOCAL=X, no transport) — attach one the same
    // way `performUndo` itself does, via `finish()`, to model an object write
    // that DID land in a transport.
    const withCorr = await journal.finish(original.id, { outcome: "succeeded", corrNr: TRKORR });
    expect(withCorr!.corrNr).toBe(TRKORR);

    // ...and now that transport gets released.
    const rel = await journal.begin({
      operation: "transport-release",
      object: transportRef(),
      existedBefore: true,
      corrNr: TRKORR,
      irreversible: true,
    });
    await journal.finish(rel!.id, { outcome: "succeeded" });

    const res = await performUndo(conn, journal, (await journal.get(original.id))!, ALLOW);
    // The restore itself is NOT blocked — it is a legitimate thing to do to the
    // server regardless of what happened to the transport.
    expect(res.performed).toBe(true);
    expect(srv.state.source).toBe(asServer(V1));
    expect(res.plan.releasedTransportWarning).toBeDefined();
    expect(res.plan.releasedTransportWarning).toMatch(new RegExp(TRKORR));
    expect(res.plan.releasedTransportWarning).toMatch(/already been released|ALREADY BEEN RELEASED/i);
    expect(res.plan.releasedTransportWarning).toMatch(rel!.id);
  });

  it("does not warn when the write's transport carries no release entry", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);
    const original = (await journal.list())[0]!;
    await journal.finish(original.id, { outcome: "succeeded", corrNr: TRKORR });
    // No transport-release entry recorded anywhere.

    const res = await performUndo(conn, journal, (await journal.get(original.id))!, ALLOW);
    expect(res.performed).toBe(true);
    expect(res.plan.releasedTransportWarning).toBeUndefined();
  });

  it("leaves the undo's own entry without a corrNr when the restore's own write needed no transport", async () => {
    // `performUndo` records `written.transport.corrNr` on its OWN journal entry
    // once the restore's write actually lands (src/adt/undo.ts) — reusing
    // whatever transport that write's OWN lock response reported, never the
    // original entry's `corrNr` (which may be stale or absent). This fake
    // server's LOCK response is IS_LOCAL=X with an empty CORRNR, i.e.
    // `transport.required === false`, so the undo's own entry correctly ends up
    // with no corrNr rather than fabricating one from `entry.corrNr`.
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);
    const original = (await journal.list())[0]!;
    // Pretend the ORIGINAL write did carry a corrNr, to prove the undo's entry
    // is not simply copying it forward.
    await journal.finish(original.id, { outcome: "succeeded", corrNr: TRKORR });

    const res = await performUndo(conn, journal, (await journal.get(original.id))!, ALLOW);
    expect(res.performed).toBe(true);
    expect(res.undoEntryId).toBeDefined();
    const undoEntry = (await journal.get(res.undoEntryId!))!;
    expect(undoEntry.corrNr).toBeUndefined();
  });
});

describe("abap_journal tool", () => {
  it("lists and shows without a connection, and surfaces pending entries", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);
    await writeVia(conn, V2);
    // A crash mid-write: begun, never finished.
    await journal.begin({
      operation: "update",
      object: { name: "ZMCP_CRASHED", type: "PROG/P", uri: "/x", package: "$TMP" },
      existedBefore: true,
      beforeSource: V1,
    });

    adt.calls.length = 0;
    const list = await abapJournal(conn, { mode: "list" }, 60_000, journal);
    expect(adt.calls).toHaveLength(0);
    expect(list.text).toMatch(/ZMCP_CRASHED/);
    expect(list.text).toMatch(/pending/);

    const e = (await journal.list({ object: REPORT }))[0]!;
    const show = await abapJournal(conn, { mode: "show", entry: e.id }, 60_000, journal);
    expect(adt.calls).toHaveLength(0);
    expect(show.text).toContain("BEFORE-IMAGE");
    expect(show.text).toContain("WRITE: / 'one'.");
  });

  it("says plainly that an object it never wrote cannot be undone", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);

    const err = await catchErr(
      abapJournal(conn, { mode: "undo", object: "ZMCP_NEVER_SEEN" }, 60_000, journal, openGate()),
    );
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toMatch(/never wrote this object|no journal entry/i);
    expect(err.hint).toMatch(/will not reconstruct/i);
    expect(adt.calls).toHaveLength(0);
  });

  it("reports that the journal is off rather than pretending undo exists", async () => {
    const off = new Journal(jcfg({ enabled: false }), "A4H");
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    const err = await catchErr(abapJournal(conn, { mode: "list" }, 60_000, off));
    expect(err.code).toBe("UNSUPPORTED");
  });

  it("mode=undo object=… skips a transport-* entry and undoes the real object write underneath", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);

    // A transport-create entry that happens to share the object filter value —
    // newer than the write, so it would be `list()`'s first match. `pickEntry`
    // must skip past it rather than fail on the first (structurally correct,
    // but never-undoable) hit.
    const tEntry = await journal.begin({
      operation: "transport-create",
      object: { name: REPORT, type: "CTS/TR", uri: "/sap/bc/adt/cts/transportrequests/A4HK900123", package: "" },
      existedBefore: false,
      corrNr: "A4HK900123",
    });
    await journal.finish(tEntry!.id, { outcome: "succeeded" });

    const res = await abapJournal(
      conn,
      { mode: "undo", object: REPORT },
      60_000,
      journal,
      openGate(),
    );
    expect(res.text).toMatch(/performed: true/);
    expect(srv.state.source).toBe(asServer(V1));
  });

  it("mode=show surfaces corrNr and the IRREVERSIBLE note for a transport-release entry", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    const trkorr = "A4HK900123";
    const e = await journal.begin({
      operation: "transport-release",
      object: { name: trkorr, type: "CTS/TR", uri: `/sap/bc/adt/cts/transportrequests/${trkorr}`, package: "" },
      existedBefore: true,
      corrNr: trkorr,
      irreversible: true,
    });
    await journal.finish(e!.id, { outcome: "succeeded" });

    const show = await abapJournal(conn, { mode: "show", entry: e!.id }, 60_000, journal);
    expect(show.text).toContain(`corrNr: ${trkorr}`);
    expect(show.text).toMatch(/IRREVERSIBLE/);
    expect(show.text).toMatch(/a released transport cannot be recalled/);
  });
});

describe("safety gate", () => {
  /**
   * A refused mutation must not reach the wire. The connection here throws on
   * ANY request, so a single network call fails the test outright.
   */
  const exploding = (): AbapConnection => {
    const client: HttpClient = {
      async request(): Promise<HttpClientResponse> {
        throw new Error("the safety gate let a refused undo reach the network");
      },
    } as unknown as HttpClient;
    return new AbapConnection(cfg(), {
      httpClient: client,
      log: () => {},
      breaker: new AuthCircuitBreaker(),
    });
  };

  it("read-only mode refuses an undo with ZERO network calls", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);
    const entry = (await journal.list())[0]!;

    const gate = new SafetyGate({ readOnly: true, allowPackages: ["$TMP"] });
    // The pre-flight target comes out of the LOCAL journal — that is what makes
    // a zero-call refusal possible at all.
    const t = await undoPreflightTarget(journal, { mode: "undo", entry: entry.id });
    expect(t).toEqual({ op: "write", name: REPORT, packageName: "$TMP", type: "PROG/P" });

    const boom = exploding();
    const err = await catchErr(
      (async () => {
        gate.assert(t!.op, { name: t!.name, packageName: t!.packageName, type: t!.type });
        return abapJournal(boom, { mode: "undo", entry: entry.id }, 60_000, journal, gate);
      })(),
    );
    expect(err.code).toBe("READ_ONLY");
  });

  it("the package allowlist applies to undo, before any request", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);
    const entry = (await journal.list())[0]!;

    const gate = new SafetyGate({ readOnly: false, allowPackages: ["ZOTHER_*"] });
    const t = await undoPreflightTarget(journal, { mode: "undo", entry: entry.id });
    const err = await catchErr(
      (async () => {
        gate.assert(t!.op, { name: t!.name, packageName: t!.packageName, type: t!.type });
      })(),
    );
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toMatch(/not in the allowlist/);
  });

  it("undo-of-create is gated as a DELETE, not as a write", async () => {
    const srv = fakeServer(undefined);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V1);
    const entry = (await journal.list())[0]!;

    const t = await undoPreflightTarget(journal, { mode: "undo", entry: entry.id });
    expect(t?.op).toBe("delete");
  });

  it("the final gate runs on the resolved object and stops the mutation", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);
    const entry = (await journal.list())[0]!;
    // A gate that only turns hostile once the object is resolved — the write
    // must still not happen.
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"], allowNamePrefixes: ["QQ"] });

    const err = await catchErr(
      abapJournal(conn, { mode: "undo", entry: entry.id }, 60_000, journal, gate),
    );
    expect(err.code).toBe("SAFETY_DENIED");
    expect(srv.state.source).toBe(V2); // untouched
  });
});

describe("journal directory hygiene", () => {
  it("keeps before-image blobs out of the repo root", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);
    const files = await readdir(dir);
    expect(files).toContain("index.jsonl");
    expect(files).toContain("blobs");
  });
});

// ---------------------------------------------------------------------------
// DDIC (TABL/DT) — the reformatting server
// ---------------------------------------------------------------------------

/**
 * DDIC is the type that initially shipped WITHOUT live proof, on the argument
 * that recording the PUT response body as the after-image would cancel out
 * the server's reformatting. That argument was tested live against A4H on
 * 2026-07-31 ("DDIC undo — verified live") and it holds: a DDIC undo is
 * byte-identical, not merely semantically equal.
 *
 * The fixtures below are the *actual bytes* from that run on `ZMCP_UNDO_TAB`,
 * so these tests pin the real A4H normalisation rather than an invented one.
 * Two facts about it, both measured:
 *
 *   1. The server moves the closing brace onto its own line after a blank one:
 *      we PUT `…char(40);\n}\n`, the server stores `…char(40);\n\n}`.
 *   2. The DDL comes back **LF, not CRLF** — unlike PROG/CLAS source. It is
 *      still trailing-newline-stripped.
 *
 * So the caller's DDL and the server's DDL differ under `sourceEquals`, which
 * is exactly why the after-image must be the PUT response body and not the
 * text we sent.
 */
const TAB = "ZMCP_UNDO_TAB";
const TAB_URI = "/sap/bc/adt/ddic/tables/zmcp_undo_tab";
const TAB_SRC = `${TAB_URI}/source/main`;

/** Verbatim: what we PUT to A4H. */
const DDL_SENT = `@EndUserText.label : 'MCP undo probe table'
@AbapCatalog.enhancementCategory : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #LIMITED
define table zmcp_undo_tab {
  key client : abap.clnt not null;
  key id     : abap.char(10) not null;
  descr      : abap.char(40);
}
`;

/**
 * Verbatim: the 344-byte body A4H returned from the source PUT — and, byte for
 * byte, what a subsequent GET returned *after activation*. Recorded live;
 * `md5 2734a2f998e081ec3752fe595bfb5e7e` covered the PUT body, the post-activate
 * GET, the journal after-image blob, the next write's before-image and the
 * source after the undo, all five identical.
 */
const DDL_SERVER = `@EndUserText.label : 'MCP undo probe table'
@AbapCatalog.enhancementCategory : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #LIMITED
define table zmcp_undo_tab {
  key client : abap.clnt not null;
  key id     : abap.char(10) not null;
  descr      : abap.char(40);

}`;

/** The same table with one extra field, in the server's normalised form. */
const DDL_SERVER_V2 = DDL_SERVER.replace(
  "  descr      : abap.char(40);\n",
  "  descr      : abap.char(40);\n  note       : abap.char(20);\n",
);

/**
 * Reproduce A4H's reformat: blank line before the closing brace, no final NL.
 *
 * **Idempotent, deliberately.** That the reformat is a fixed point is itself a
 * live-verified fact and the thing that makes DDIC undo work: on A4H the source
 * that came back after the restore was md5-identical to the source that came
 * back after the original create, so feeding the normalised form back in does
 * not normalise it a second time. A fake that appended another blank line each
 * pass would model a server A4H is not.
 */
const ddicNormalise = (s: string) =>
  s.replace(/\n+$/, "").replace(/\n+\}$/, "\n\n}");

/**
 * A fake DDIC server. The one behaviour that matters and that PROG/CLAS do NOT
 * have: the source PUT answers **200 with the normalised source in the body**,
 * and that body is what a later GET returns.
 *
 * `descriptorBody` flips it into the failure mode the handoff worried about —
 * a PUT that answers with an XML object descriptor instead of source, which
 * `putSource()` discards. It is a negative control, not a real A4H behaviour.
 */
function fakeDdicServer(initial?: string, opts: { descriptorBody?: boolean } = {}) {
  const state: { source?: string } = { source: initial };
  const route = (r: Recorded): HttpClientResponse => {
    if (r.url === TAB_SRC && r.method === "GET") {
      return state.source === undefined
        ? resp(404, NOT_FOUND_XML, OK_XML)
        : resp(200, state.source, { ...OK_TEXT, etag: `20260731142047000${state.source.length}` });
    }
    if (r.url === TAB_URI && r.method === "GET") {
      return state.source === undefined ? resp(404, NOT_FOUND_XML, OK_XML) : resp(200, OBJ_XML, OK_XML);
    }
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === TAB_SRC && r.method === "PUT") {
      state.source = ddicNormalise(r.body ?? "");
      return opts.descriptorBody
        ? resp(200, `<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue"/>`, OK_XML)
        : resp(200, state.source, OK_TEXT);
    }
    if (r.url === TAB_URI && r.method === "DELETE") {
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

const writeTab = (conn: AbapConnection, source: string) =>
  abapWrite(conn, { object: TAB, type: "TABL/DT", source } as never, 60_000, openGate(), journal);

describe("DDIC (TABL/DT) undo — the reformatting server", () => {
  it("pins A4H's actual reformat: the sent DDL and the stored DDL are NOT equal", () => {
    // If this ever fails, A4H changed its DDL formatter and every conclusion
    // below needs re-measuring against the live system.
    expect(ddicNormalise(DDL_SENT)).toBe(DDL_SERVER);
    // Fixed point — verified live, and the reason a restore round-trips.
    expect(ddicNormalise(DDL_SERVER)).toBe(DDL_SERVER);
    expect(DDL_SERVER).not.toContain("\r");
    expect(DDL_SERVER.endsWith("}")).toBe(true);
    expect(sourceFingerprint(DDL_SENT)).not.toBe(sourceFingerprint(DDL_SERVER));
    // Recorded live from A4H, 2026-07-31.
    expect(sourceFingerprint(DDL_SERVER)).toBe("sha256:e088715b9c702d4677d1c83ae6e2ac95");
  });

  it("records the SERVER's normalised DDL as the after-image, not what we sent", async () => {
    const srv = fakeDdicServer(undefined);
    const { conn } = await connected(srv.route);

    await writeTab(conn, DDL_SENT);

    const e = (await journal.list())[0]!;
    expect(e.operation).toBe("create");
    expect(await journal.afterImage(e)).toBe(DDL_SERVER);
    expect(e.after?.fingerprint).toBe(sourceFingerprint(DDL_SERVER));
    // The distinction the whole DDIC undo path rests on.
    expect(e.after?.fingerprint).not.toBe(sourceFingerprint(DDL_SENT));
  });

  it("sees NO drift after a DDIC write, because the after-image is the stored form", async () => {
    const srv = fakeDdicServer(undefined);
    const { conn } = await connected(srv.route);
    await writeTab(conn, DDL_SENT);
    const create = (await journal.list())[0]!;

    const plan = await planUndo(conn, journal, evidencedAbsent(create));

    expect(plan.drift.drifted).toBe(false);
    expect(plan.action).toBe("delete");
    expect(plan.drift.actualFingerprint).toBe(create.after?.fingerprint);
  });

  it("restores a DDIC before-image BYTE-identically", async () => {
    const srv = fakeDdicServer(undefined);
    const { conn } = await connected(srv.route);
    await writeTab(conn, DDL_SENT);
    await writeTab(conn, DDL_SENT.replace("  descr      : abap.char(40);\n", "  descr      : abap.char(40);\n  note       : abap.char(20);\n"));
    expect(srv.state.source).toBe(DDL_SERVER_V2);
    const update = (await journal.list())[0]!;
    expect(update.operation).toBe("update");

    const res = await performUndo(conn, journal, update, ALLOW);

    expect(res.performed).toBe(true);
    expect(res.plan.action).toBe("restore");
    // Byte-identical, not merely `sourceEquals`. This is the claim the live
    // probe settled; weakening it to sourceEquals would hide a re-reformat.
    expect(srv.state.source).toBe(DDL_SERVER);
    expect(await journal.beforeImage(update)).toBe(DDL_SERVER);
  });

  it("an undone DDIC restore leaves no drift for the NEXT undo", async () => {
    // The second-order property: restoring writes normalised text, which the
    // server normalises again — and the result must be a fixed point, or every
    // undo would poison the entry before it.
    const srv = fakeDdicServer(undefined);
    const { conn } = await connected(srv.route);
    await writeTab(conn, DDL_SENT);
    const create = (await journal.list())[0]!;
    await writeTab(conn, DDL_SENT.replace("descr      : abap.char(40);", "descr      : abap.char(60);"));
    await performUndo(conn, journal, (await journal.list())[0]!, ALLOW);

    // `evidencedAbsent` matters here: without it the plan stops at the evidence
    // gate and never probes, so "no drift" would be vacuously true.
    const plan = await planUndo(conn, journal, evidencedAbsent(create));
    expect(plan.drift.drifted).toBe(false);
    expect(plan.action).toBe("delete");
    expect(plan.blocker).toBeUndefined();
  });

  it("undo of a DDIC create DELETES the table", async () => {
    const srv = fakeDdicServer(undefined);
    const { conn } = await connected(srv.route);
    await writeTab(conn, DDL_SENT);
    const create = (await journal.list())[0]!;

    const res = await performUndo(conn, journal, evidencedAbsent(create), ALLOW);

    expect(res.plan.action).toBe("delete");
    expect(res.performed).toBe(true);
    expect(srv.state.source).toBeUndefined();
  });

  it("NEGATIVE CONTROL: without the PUT response body, DDIC undo would refuse", async () => {
    // The mechanism, stated as a test. `putSource()` discards a PUT body that
    // looks like an XML descriptor, so `afterSource` falls back to the caller's
    // raw DDL — which the server never stored. Drift detection then fires on
    // the reformat and refuses. This is what DDIC undo would do if anybody
    // "simplified" the normalisedSource plumbing away.
    const srv = fakeDdicServer(undefined, { descriptorBody: true });
    const { conn } = await connected(srv.route);
    // The pre-activation content gate in src/tools/write.ts now catches this
    // one MOVE EARLIER than the undo path does: it re-reads the object before
    // activating, sees bytes that are not the bytes it believes it wrote, and
    // refuses to activate rather than publishing content it cannot account for.
    // That is the same divergence this test was always about, caught at write
    // time instead of at undo time — so the write no longer resolves, and the
    // rest of the test (the entry is on disk with the WRONG after-image, and
    // undo therefore refuses) is unchanged and still the point.
    const wrote = await catchErr(writeTab(conn, DDL_SENT));
    expect(wrote.code).toBe("ETAG_CONFLICT");
    expect(wrote.details.phase).toBe("pre-activation");
    const create = (await journal.list())[0]!;
    // Settled, not left pending: the PUT was durable, so the entry has to stay
    // reachable by undo. And `afterSource` is deliberately still OUR bytes —
    // rewriting it to the observed source is what would make the drift check
    // below pass and let undo clobber content abapsmith never wrote.
    expect(create.outcome).toBe("succeeded");
    expect(create.activation?.attempted).toBe(false);
    expect(create.after?.fingerprint).toBe(sourceFingerprint(DDL_SENT));

    const err = await catchErr(performUndo(conn, journal, evidencedAbsent(create), ALLOW));
    expect(err.code).toBe("ETAG_CONFLICT");
    expect(err.message).toMatch(/has CHANGED on the server/);
    expect(srv.state.source).toBe(DDL_SERVER); // nothing was deleted
  });
});

// ---------------------------------------------------------------------------
// undo may DELETE only on positive evidence that the object was absent
// ---------------------------------------------------------------------------

/**
 * The asymmetry that justifies all of this: a wrong *restore* overwrites source
 * abapsmith is holding a copy of, and a wrong *delete* destroys source nobody
 * holds a copy of. `existedBefore: false` is not evidence — it is a boolean that
 * a failed read, a timeout or an entry written before provenance existed all
 * produce just as readily as a genuine 404.
 */
describe("a delete-shaped undo needs positive evidence", () => {
  it("refuses when the entry does not say HOW absence was established, without a single request", async () => {
    const srv = fakeServer(undefined);
    const { conn, adt } = await connected(srv.route);
    await writeVia(conn, V1);

    const recorded = (await journal.list())[0]!;
    expect(recorded.existedBefore).toBe(false);
    // `existedBefore: false` with NO claim about how that was established:
    // a pre-provenance entry from an older journal, or any future write path
    // that cannot prove absence. Constructed here rather than taken from
    // `abapWrite`, so this test keeps testing the acting side even as the
    // recording side improves. (Today `abapWrite` does better than this — see
    // "a create written by abap_write carries the evidence its undo needs".)
    const entry = unevidenced(recorded);
    expect(entry.beforeCapture).toBe("unknown");

    adt.calls.length = 0;
    const plan = await planUndo(conn, journal, entry);
    expect(plan.undoable).toBe(false);
    expect(plan.blocker).toMatch(/does not\s+have positive evidence/);
    expect(plan.blocker).toMatch(/beforeCapture="unknown"/);
    // Decided from the journal alone — resolving the target would have cost a GET.
    expect(adt.calls).toHaveLength(0);

    const err = await catchErr(performUndo(conn, journal, entry, ALLOW));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details.beforeCapture).toBe("unknown");
    expect(err.details.forceable).toBe(false);
    // The only assertions that really matter: no DELETE went out, and the
    // object is still there.
    expect(adt.verbs).not.toContain("DELETE");
    expect(srv.state.source).toBe(V1);
  });

  it("is NOT forceable — force=true overrides drift, not missing evidence", async () => {
    const srv = fakeServer(undefined);
    const { conn, adt } = await connected(srv.route);
    await writeVia(conn, V1);
    const entry = unevidenced((await journal.list())[0]!);

    adt.calls.length = 0;
    const err = await catchErr(performUndo(conn, journal, entry, { ...ALLOW, force: true }));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.hint).toMatch(/force=true will not change that/);
    expect(adt.verbs).not.toContain("DELETE");
    expect(srv.state.source).toBe(V1);
  });

  it("refuses a FAILED capture and blames the failed read, not retention", async () => {
    const srv = fakeServer(undefined);
    const { conn, adt } = await connected(srv.route);
    await writeVia(conn, V1);
    const entry = { ...(await journal.list())[0]!, beforeCapture: "failed" as const };

    adt.calls.length = 0;
    const plan = await planUndo(conn, journal, entry);
    expect(plan.undoable).toBe(false);
    expect(plan.blocker).toMatch(/beforeCapture="failed"/);
    expect(plan.blocker).toMatch(/read that failed|failed/i);
    expect(adt.calls).toHaveLength(0);
    expect(srv.state.source).toBe(V1);
  });

  it("deletes when — and only when — absence was confirmed", async () => {
    const srv = fakeServer(undefined);
    const { conn, adt } = await connected(srv.route);
    await writeVia(conn, V1);
    const entry = (await journal.list())[0]!;

    adt.calls.length = 0;
    const res = await performUndo(conn, journal, evidencedAbsent(entry), ALLOW);
    expect(res.performed).toBe(true);
    expect(adt.verbs).toContain("DELETE");
    expect(srv.state.source).toBeUndefined();
  });

  it("asserts the invariant again at the last statement before deleteObject", async () => {
    // Simulates a future refactor that loses the blocker: the plan is made from
    // an evidenced entry, and the evidence is gone by the time the delete runs.
    // The assertion immediately before `deleteObject()` is what catches that.
    const srv = fakeServer(undefined);
    const { conn, adt } = await connected(srv.route);
    await writeVia(conn, V1);
    const entry = evidencedAbsent((await journal.list())[0]!) as { beforeCapture: string };

    adt.calls.length = 0;
    const err = await catchErr(
      performUndo(conn, journal, entry as unknown as JournalEntry, {
        // Runs after planning, before any mutation. Must still return a real
        // `AuthorizedTarget` (the safety-gate authorisation layer) so `performUndo`'s
        // own op-match check passes silently and control reaches the
        // pre-delete invariant check this test is actually probing.
        assertAllowed: (action, target) => {
          entry.beforeCapture = "unknown";
          return openGate().authorize(action === "delete" ? "delete" : "write", target);
        },
      }),
    );
    expect(err.message).toMatch(/INTERNAL INVARIANT VIOLATED/);
    expect(err.message).toMatch(/Nothing was deleted/);
    expect(err.retryable).toBe(false); // an internal bug, not a caller argument to change
    expect(adt.verbs).not.toContain("DELETE");
    expect(srv.state.source).toBe(V1);
  });

  it("asserts the op-match invariant when assertAllowed authorises the wrong verb", async () => {
    // A misbehaving authorisation callback that ignores the requested action
    // and always authorises "write" — for a delete-shaped undo this trips the
    // op-match check immediately after `assertAllowed` runs, before any
    // mutation is attempted.
    const srv = fakeServer(undefined);
    const { conn, adt } = await connected(srv.route);
    await writeVia(conn, V1);
    const entry = evidencedAbsent((await journal.list())[0]!);

    adt.calls.length = 0;
    const err = await catchErr(
      performUndo(conn, journal, entry, {
        assertAllowed: (_action, target) => openGate().authorize("write", target),
      }),
    );
    expect(err.message).toMatch(/INTERNAL INVARIANT VIOLATED/);
    expect(err.message).toMatch(/assertAllowed authorised/);
    expect(err.retryable).toBe(false); // an internal bug, not a caller argument to change
    expect(adt.verbs).not.toContain("DELETE");
    expect(srv.state.source).toBe(V1);
  });

  it("the listing says an entry will be refused BEFORE anyone tries it", async () => {
    const srv = fakeServer(undefined);
    const { conn, adt } = await connected(srv.route);
    // Recorded straight into the journal with a bare `existedBefore: false`,
    // which `begin()` derives as "unknown" — i.e. exactly what an older
    // abapsmith left behind, and what a user still has sitting in their journal.
    const e = (await journal.begin({
      operation: "create",
      object: { name: REPORT, type: "PROG/P", uri: REPORT_URI, package: "$TMP" },
      existedBefore: false,
    }))!;
    await journal.finish(e.id, { outcome: "succeeded" });

    adt.calls.length = 0;
    const list = await abapJournal(conn, { mode: "list" }, 60_000, journal);
    expect(adt.calls).toHaveLength(0);
    expect(list.text).toMatch(/capture/);
    expect(list.text).toMatch(/unknown/);

    const show = await abapJournal(conn, { mode: "show", entry: e.id }, 60_000, journal);
    expect(show.text).toMatch(/WILL BE REFUSED/);
  });

  /**
   * The two halves of the rule, in one test.
   *
   * `deleteEvidenceBlocker` demands `beforeCapture === "confirmed-absent"`
   * before an undo may delete; `abapWrite` is the only thing that can honestly
   * assert it, and it does so off the pre-write metadata GET returning a
   * genuine 404 (`resolveWriteTarget` yields `exists: false` ONLY inside
   * `if (isNotFoundError(e))` — every other failure throws PACKAGE_UNKNOWN).
   *
   * Neither half is any use alone, and each was landed by a different agent, so
   * this asserts the seam rather than either side of it:
   *   - revert the recording half (`captureOf` back to "unknown") and the first
   *     expectation fails, then the undo is refused and the rest fails;
   *   - revert the acting half (blocker accepting "unknown") and the "refuses
   *     when the entry does not say HOW" tests above fail.
   * A create you cannot undo is a promise abap_write's own output makes and
   * would be breaking.
   */
  it("a create written by abap_write carries the evidence its undo needs", async () => {
    const srv = fakeServer(undefined); // 404: the object genuinely does not exist
    const { conn, adt } = await connected(srv.route);
    await writeVia(conn, V1);

    const entry = (await journal.list())[0]!;
    expect(entry.operation).toBe("create");
    expect(entry.existedBefore).toBe(false);
    // The recording half. Not "unknown": absence was PROVEN, by a 404.
    expect(entry.beforeCapture).toBe("confirmed-absent");

    // The acting half: that evidence, and only that, unlocks the delete.
    const plan = await planUndo(conn, journal, entry);
    expect(plan.undoable).toBe(true);
    expect(plan.blocker).toBeUndefined();
    expect(plan.action).toBe("delete");

    adt.calls.length = 0;
    const res = await performUndo(conn, journal, entry, ALLOW);
    expect(res.performed).toBe(true);
    expect(adt.verbs).toContain("DELETE");
    expect(srv.state.source).toBeUndefined();
  });

  /**
   * The same principle from the other side. Above, the rule refuses a DELETE
   * with no evidence of prior absence; here absence is DIRECTLY OBSERVED, and the
   * honest response to that evidence is to send nothing and call it done.
   *
   * This used to throw ETAG_CONFLICT ("no longer exists ... nothing left to
   * delete"), i.e. report failure for exactly the state the user asked for and
   * already had, sending them looking for cleanup that was not needed.
   */
  it("undo of a create is DONE, not failed, when the object is already gone", async () => {
    const srv = fakeServer(undefined);
    const { conn, adt } = await connected(srv.route);
    await writeVia(conn, V1);
    const entry = (await journal.list())[0]!;
    srv.state.source = undefined; // somebody else got there first

    adt.calls.length = 0;
    const plan = await planUndo(conn, journal, entry);
    expect(plan.drift.drifted).toBe(false);
    expect(plan.undoable).toBe(true);
    expect(plan.action).toBe("noop");
    expect(plan.drift.reason).toMatch(/already absent/);

    const res = await performUndo(conn, journal, entry, ALLOW);
    expect(res.performed).toBe(false);
    // The point: no destructive request went out, and no error came back.
    expect(adt.verbs).not.toContain("DELETE");

    const out = await abapJournal(conn, { mode: "undo", entry: entry.id }, 60_000, journal, openGate());
    expect(out.text).toMatch(/DONE/);
    expect(out.text).toMatch(/already absent/);
    expect(out.text).toMatch(/Nothing is left to clean up/);
  });

  it("still refuses when the object is gone but the entry cannot prove it ever was", async () => {
    // Absence observed NOW is what licenses sending nothing. It is not evidence
    // about the past, so an entry with no provenance is still refused — the
    // delete-evidence blocker runs first, from the journal alone, before any probe.
    const srv = fakeServer(undefined);
    const { conn, adt } = await connected(srv.route);
    await writeVia(conn, V1);
    const entry = unevidenced((await journal.list())[0]!);
    srv.state.source = undefined;

    adt.calls.length = 0;
    const err = await catchErr(performUndo(conn, journal, entry, ALLOW));
    expect(err.code).toBe("BAD_INPUT");
    expect(adt.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// an undo is a write, so it cannot happen without authorisation
// ---------------------------------------------------------------------------

/**
 * `assertAllowed` used to be optional and optional-chained, so ANY caller that
 * omitted it got an unchecked mutation — a DELETE, for an undo of a create —
 * and no diagnostic at all. TypeScript now refuses those call sites; these
 * tests cover the runtime half, because `test/` is not typechecked and the
 * gate must fail closed for JS callers too.
 */
describe("an undo cannot run ungated", () => {
  it("refuses an undo with no authorisation callback, before a single request", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);
    await writeVia(conn, V2);
    const entry = (await journal.list())[0]!;

    adt.calls.length = 0;
    // What a JS caller (or an un-typechecked test) can still do.
    const err = await catchErr(
      performUndo(conn, journal, entry, undefined as unknown as UndoOptions),
    );
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toMatch(/without an authorisation callback/);
    // Fails before planning: no round trip, no lock, and nothing changed.
    expect(adt.calls).toHaveLength(0);
    expect(srv.state.source).toBe(V2);
  });

  it("a refusing gate stops the undo, and the refusal is not swallowed", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);
    await writeVia(conn, V2);
    const entry = (await journal.list())[0]!;

    adt.calls.length = 0;
    const err = await catchErr(
      performUndo(conn, journal, entry, {
        assertAllowed: () => {
          throw new AbapError("SAFETY_DENIED", "policy says no");
        },
      }),
    );
    expect(err.code).toBe("SAFETY_DENIED");
    expect(adt.verbs).not.toContain("PUT");
    expect(adt.verbs).not.toContain("DELETE");
    expect(srv.state.source).toBe(V2);
  });

  it("abap_journal mode=undo refuses when the caller wired no safety gate", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);
    const entry = (await journal.list())[0]!;

    // `gate` is optional so that list/show work with no gate and with the
    // system down; an undo must not inherit that permissiveness by silently
    // degrading `gate?.assert(...)` into a no-op that authorises everything.
    const err = await catchErr(abapJournal(conn, { mode: "undo", entry: entry.id }, 60_000, journal));
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toMatch(/without a safety gate/);
    expect(srv.state.source).toBe(V2);

    // The read-only modes still work ungated.
    const list = await abapJournal(conn, { mode: "list" }, 60_000, journal);
    expect(list.text).toContain(REPORT);
  });

  it("says when the syntax check did not run, instead of staying silent", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);
    const entry = (await journal.list())[0]!;

    const res = await performUndo(conn, journal, entry, { ...ALLOW, check: false });
    expect(res.performed).toBe(true);
    expect(res.check).toBeUndefined();
    // Silence about a check that never ran must not read as a clean check.
    expect(res.checkUnavailable).toMatch(/disabled/);
  });

  it("distinguishes a check that was skipped from a check that FAILED", async () => {
    const srv = fakeServer(V1);
    let broken = false;
    const { conn } = await connected((r) => {
      if (broken && r.url.includes("/checkruns")) return resp(500, "boom", OK_TEXT);
      return srv.route(r);
    });
    await writeVia(conn, V2);
    broken = true;

    const out = await abapJournal(
      conn,
      { mode: "undo", entry: (await journal.list())[0]!.id },
      60_000,
      journal,
      openGate(),
    );
    // The restore happened; what the model must not conclude is that the
    // restored source was checked and found clean.
    expect(out.text).toMatch(/No syntax check result/);
    expect(out.text).toMatch(/could not be run/);
    expect(srv.state.source).toBe(asServer(V1));
  });
});

// ---------------------------------------------------------------------------
// an entry belongs to the system it was recorded on
// ---------------------------------------------------------------------------

describe("undo refuses an entry from another system", () => {
  const liveKey = () =>
    systemKey({ sid: "A4H", url: "http://sap.invalid:50000", client: "001" });

  it("refuses a foreign systemKey with ZERO requests, and force cannot override it", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);
    await writeVia(conn, V2);
    const foreign: JournalEntry = {
      ...(await journal.list())[0]!,
      systemKey: systemKey({ sid: "A4H", url: "http://other.invalid:50000", client: "001" }),
    };

    adt.calls.length = 0;
    const plan = await planUndo(conn, journal, foreign);
    expect(plan.undoable).toBe(false);
    expect(plan.blocker).toMatch(/DIFFERENT system/);
    expect(plan.blocker).toContain("other.invalid");
    expect(adt.calls).toHaveLength(0);

    const err = await catchErr(performUndo(conn, journal, foreign, { ...ALLOW, force: true }));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details.forceable).toBe(false);
    expect(adt.calls).toHaveLength(0);
    expect(srv.state.source).toBe(V2); // untouched
  });

  it("accepts a matching systemKey — the key is built from the live connection", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);
    const same: JournalEntry = { ...(await journal.list())[0]!, systemKey: liveKey() };

    const res = await performUndo(conn, journal, same, ALLOW);
    expect(res.performed).toBe(true);
    expect(srv.state.source).toBe(asServer(V1));
  });

  it("does NOT refuse merely because the entry predates systemKey", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);
    // abap_write now always stamps systemKey, so a genuinely
    // "predates the field" entry has to be constructed by hand — strip it
    // back off to simulate a journal line written before systemKey existed.
    const legacy: JournalEntry = { ...(await journal.list())[0]! };
    delete (legacy as { systemKey?: string }).systemKey;
    expect(legacy.systemKey).toBeUndefined();

    const res = await performUndo(conn, journal, legacy, ALLOW);
    expect(res.performed).toBe(true);
    expect(srv.state.source).toBe(asServer(V1));
  });

  it("falls back to the SID for a legacy entry, and says the check was the weak one", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);
    await writeVia(conn, V2);
    // Same reasoning as above: writeVia's entry now carries a systemKey
    // that MATCHES the live connection, so the strong check would pass and
    // this test would stop exercising the weak SID-only fallback entirely.
    // Strip it to simulate an entry from before systemKey existed, before
    // overriding `system`.
    const elsewhere: JournalEntry = { ...(await journal.list())[0]!, system: "PRD" };
    delete (elsewhere as { systemKey?: string }).systemKey;

    adt.calls.length = 0;
    const err = await catchErr(performUndo(conn, journal, elsewhere, ALLOW));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toMatch(/SID PRD/);
    expect(err.message).toMatch(/WEAKER, SID-only check/);
    expect(adt.calls).toHaveLength(0);
    expect(srv.state.source).toBe(V2);
  });

  it("stamps its OWN entry with the system key and honest provenance", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);

    const res = await performUndo(conn, journal, (await journal.list())[0]!, ALLOW);
    const undoEntry = (await journal.get(res.undoEntryId!))!;
    expect(undoEntry.systemKey).toBe(liveKey());
    // It read V2 off the server before overwriting it: that IS a capture.
    expect(undoEntry.beforeCapture).toBe("captured");
  });

  it("records confirmed-absent when it recreates, so undoing the undo may delete", async () => {
    // The round trip that only closes if provenance is stated accurately:
    // delete → undo (recreate) → undo again (delete). The last step is a delete
    // and is allowed ONLY because the recreate positively observed the absence.
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await abapWrite(
      conn,
      { object: REPORT, type: "PROG/P", mode: "delete" } as never,
      60_000,
      openGate(),
      journal,
    );

    const undone = await performUndo(conn, journal, (await journal.list())[0]!, ALLOW);
    expect(srv.state.source).toBe(asServer(V1));
    const undoEntry = (await journal.get(undone.undoEntryId!))!;
    expect(undoEntry.beforeCapture).toBe("confirmed-absent");
    expect(undoEntry.systemKey).toBe(liveKey());

    const again = await performUndo(conn, journal, undoEntry, ALLOW);
    expect(again.performed).toBe(true);
    expect(srv.state.source).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// a class is five includes and the journal holds one
// ---------------------------------------------------------------------------

const CLS = "ZCL_MCP_UNDO";
const CLS_URI = "/sap/bc/adt/oo/classes/zcl_mcp_undo";
const CLS_SRC = `${CLS_URI}/source/main`;
const CLS_V1 =
  "CLASS zcl_mcp_undo DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\nENDCLASS.\n" +
  "CLASS zcl_mcp_undo IMPLEMENTATION.\nENDCLASS.\n";
const CLS_V2 = CLS_V1.replace("  PUBLIC SECTION.\n", "  PUBLIC SECTION.\n    METHODS run.\n");

/** Same shape as `fakeServer`, for the class URIs. */
function fakeClassServer(initial?: string) {
  const state: { source?: string } = { source: initial };
  const route = (r: Recorded): HttpClientResponse => {
    if (r.url === CLS_SRC && r.method === "GET") {
      return state.source === undefined
        ? resp(404, NOT_FOUND_XML, OK_XML)
        : resp(200, asServer(state.source), { ...OK_TEXT, etag: `cls-${state.source.length}` });
    }
    if (r.url === CLS_URI && r.method === "GET") {
      return state.source === undefined ? resp(404, NOT_FOUND_XML, OK_XML) : resp(200, OBJ_XML, OK_XML);
    }
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === CLS_SRC && r.method === "PUT") {
      state.source = r.body ?? "";
      return resp(200, "", OK_TEXT);
    }
    if (r.url === CLS_URI && r.method === "DELETE") {
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

const writeClass = (conn: AbapConnection, source: string, extra: Record<string, unknown> = {}) =>
  abapWrite(conn, { object: CLS, type: "CLAS/OC", source, ...extra } as never, 60_000, openGate(), journal);

describe("a partial class restore must not report success", () => {
  it("refuses to recreate a deleted class by default, and says exactly what would be missing", async () => {
    const srv = fakeClassServer(CLS_V1);
    const { conn, adt } = await connected(srv.route);
    await writeClass(conn, "", { mode: "delete" });
    expect(srv.state.source).toBeUndefined();
    const del = (await journal.list())[0]!;

    adt.calls.length = 0;
    const plan = await planUndo(conn, journal, del);
    expect(plan.action).toBe("recreate");
    expect(plan.undoable).toBe(false);
    expect(plan.blockerForceable).toBe(true);
    expect(plan.partial?.unrestored).toEqual([
      "definitions",
      "implementations",
      "macros",
      "testclasses",
    ]);
    expect(plan.blocker).toMatch(/CCDEF/);
    expect(plan.blocker).toMatch(/CCAU/);
    expect(plan.blocker).toMatch(/force=true/);

    const err = await catchErr(performUndo(conn, journal, del, ALLOW));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details.forceable).toBe(true);
    expect(err.details.unrestored).toContain("testclasses");
    expect(adt.verbs).not.toContain("PUT");
    expect(srv.state.source).toBeUndefined();
  });

  it("with force=true it recreates, and the result is loudly PARTIAL", async () => {
    const srv = fakeClassServer(CLS_V1);
    const { conn } = await connected(srv.route);
    await writeClass(conn, "", { mode: "delete" });
    const del = (await journal.list())[0]!;

    const res = await performUndo(conn, journal, del, { ...ALLOW, force: true });
    expect(res.performed).toBe(true);
    expect(res.partial?.unrestored).toContain("testclasses");
    expect(srv.state.source).toBe(asServer(CLS_V1));

    const out = await abapJournal(
      conn,
      { mode: "undo", entry: (await journal.list({ object: CLS }))[1]!.id, force: true },
      60_000,
      journal, openGate());
    // The tool text is what a model actually reads — it must not read as clean.
    expect(out.text).toMatch(/PARTIAL/);
  });

  it("restores a class UPDATE but warns that the other includes are uncovered", async () => {
    const srv = fakeClassServer(CLS_V1);
    const { conn } = await connected(srv.route);
    await writeClass(conn, CLS_V2);
    const update = (await journal.list())[0]!;

    const res = await performUndo(conn, journal, update, ALLOW);
    expect(res.performed).toBe(true); // a restore is NOT refused
    expect(res.partial?.unrestored).toContain("implementations");
    expect(srv.state.source).toBe(asServer(CLS_V1));

    const out = await abapJournal(conn, { mode: "show", entry: update.id }, 60_000, journal);
    expect(out.text).toMatch(/CLASS and abapsmith records only its MAIN include/);
    expect(out.text).toMatch(/CCAU/);
  });

  it("says PARTIAL in the undo tool's own output, not only in the plan", async () => {
    const srv = fakeClassServer(CLS_V1);
    const { conn } = await connected(srv.route);
    await writeClass(conn, CLS_V2);
    const update = (await journal.list())[0]!;

    const out = await abapJournal(conn, { mode: "undo", entry: update.id }, 60_000, journal, openGate());
    expect(out.text).toMatch(/performed: true/);
    expect(out.text).toMatch(/PARTIAL/);
    expect(out.text).toMatch(/NOT restored/);
  });
});

// ---------------------------------------------------------------------------
// undo of a write that was scoped to a class SUB-INCLUDE
// ---------------------------------------------------------------------------

/**
 * ============================ EXPECTED RED ================================
 * Four of the six tests below are EXPECTED TO FAIL until the undo half of
 * class sub-include write support lands. They are written against the contract the change must meet,
 * deliberately NOT weakened to today's behaviour, and deliberately NOT
 * skipped: a skipped test is a test nobody notices is missing.
 *
 * THE DEFECT they describe (found while writing them; reported, not fixed —
 * `src/adt/undo.ts` is not this agent's file):
 *
 *   `journalRef()` (src/journal.ts:125) copies `ResolvedTarget.sourceUri`
 *   into the entry, so once abap_write can address an include the journal
 *   DOES record `…/oo/classes/<c>/includes/testclasses`.
 *
 *   `planUndo()` (src/adt/undo.ts:755) then throws that away. It re-resolves
 *   the target from `name`/`type`/`packageName` ONLY:
 *
 *       const target = await resolveWriteTarget(conn, {
 *         name: entry.object.name, type: entry.object.type,
 *         packageName: entry.object.package, …
 *       });                                   // <- no `include`
 *
 *   `resolveWriteTarget` with no `include` yields `sourceUri` =
 *   `${uri}/source/main`. So for a CCAU entry the undo path:
 *     1. PROBES the wrong document (reads main, calls it "the object now"),
 *     2. DIAGNOSES the mismatch as third-party drift — it tells the user
 *        somebody else changed the class, which is a false accusation, and
 *     3. on `force=true`, PUTs the recorded CCAU before-image ONTO
 *        `/source/main`, destroying the class body and replacing it with a
 *        test include. That is the worst outcome this repo has: a confident,
 *        authorised, journalled write of the right bytes to the wrong URI.
 *
 * THE FIX I would make (reported for the owner of src/adt/undo.ts):
 *   (a) carry the include on the entry — either a new
 *       `JournalObjectRef.include?: ClassInclude`, or derive it at the seam
 *       with `includeFromUri(entry.object.sourceUri)`; `sourceUri` is already
 *       recorded and already survives the disk round-trip, so no journal
 *       format change is strictly required;
 *   (b) pass it through at src/adt/undo.ts:755 —
 *       `...(inc && inc !== "main" ? { include: inc } : {})`;
 *   (c) make `partialClassRestore`/`classRecreateBlocker` stop asserting
 *       "abapsmith only ever recorded its MAIN include" for an entry that is
 *       demonstrably an include entry — that sentence becomes false.
 *   If (a)+(b) are out of scope for this PR, then the honest interim is to
 *   REFUSE: `undoBlocker` returns a blocker naming the include. Both shapes
 *   satisfy every assertion below, which is why they are written as
 *   "restored the include, or refused" rather than pinning one design.
 *
 * OUT OF SCOPE and NOT built here (per the brief): before-image capture of
 * the sub-includes, and relaxing `classRecreateBlocker`.
 * ==========================================================================
 */
const CLS_CCAU = `${CLS_URI}/includes/testclasses`;

const TESTS_V1 =
  "CLASS ltcl_run DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.\n" +
  "  PRIVATE SECTION.\n    METHODS one FOR TESTING.\nENDCLASS.\n" +
  "CLASS ltcl_run IMPLEMENTATION.\n  METHOD one.\n  ENDMETHOD.\nENDCLASS.\n";
const TESTS_V2 = TESTS_V1.replace("METHOD one.\n", "METHOD one.\n    cl_abap_unit_assert=>fail( ).\n");

/**
 * A class server that models main and CCAU as SEPARATE documents, because
 * that is the one fact the code under test currently loses. Every other fake
 * in this file serves a single source URI, which is exactly why this defect
 * could not show up in the existing suite.
 */
function fakeIncludeClassServer(main: string, ccau: string) {
  // Both documents are stored ALREADY in server shape, so `state` can be
  // compared against `asServer(...)` uniformly whether or not a PUT touched it.
  const state = { main: asServer(main) as string | undefined, ccau: asServer(ccau) as string | undefined };
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
    if (r.url === CLS_URI && r.method === "GET") return resp(200, OBJ_XML, OK_XML);
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

/**
 * The entry abap_write produces for a CCAU write, built directly rather than
 * by driving `abapWrite` — the tool cannot address an include yet (that is
 * the sibling change), and this block is about the UNDO half, which must be
 * correct independently of how the entry was produced.
 *
 * `sourceUri` is the load-bearing field: `journalRef()` records it verbatim
 * from the resolved target, and it survives the journal's disk round-trip
 * today. `include` is set alongside it for the shape where the owner of
 * `src/adt/undo.ts` prefers an explicit field; the cast is there so this file
 * compiles whether or not that field exists yet, and NOT to smuggle past a
 * type error in shipped code.
 *
 * `before`/`after` are run through `asServer()` because a real before-image
 * holds what the SERVER handed back, not what a test literal looks like —
 * CRLF, trailing whitespace trimmed. Feeding raw text here would make the
 * restore PUT bytes no capture ever produces.
 */
const ccauEntry = async (before: string, after: string): Promise<JournalEntry> => {
  const e = await journal.begin({
    operation: "update",
    object: {
      name: CLS,
      type: "CLAS/OC",
      uri: CLS_URI,
      sourceUri: CLS_CCAU,
      package: "$TMP",
      include: "testclasses",
    } as JournalEntry["object"],
    existedBefore: true,
    beforeCapture: "captured",
    beforeSource: asServer(before),
    afterSource: asServer(after),
  });
  expect(e, "the journal is enabled in this suite; begin() must produce an entry").toBeDefined();
  await journal.finish(e!.id, { outcome: "succeeded" });
  return (await journal.get(e!.id))!;
};

describe("[EXPECTED RED until the undo half lands] an include-scoped undo must not hit /source/main", () => {
  it("never writes the recorded include bytes to the main source — not even with force=true", async () => {
    // THE test. Everything else in this block explains or narrows it.
    //
    // force=true means "I accept the drift, do it anyway". It has never meant
    // "and you may pick a different document to do it to". Today the plan's
    // target is /source/main, drift is (spuriously) detected, force overrides
    // the drift, and TESTS_V1 lands on top of the class body.
    const srv = fakeIncludeClassServer(CLS_V1, TESTS_V2);
    const { conn, adt } = await connected(srv.route);
    const entry = await ccauEntry(TESTS_V1, TESTS_V2);

    adt.calls.length = 0;
    await performUndo(conn, journal, entry, { ...ALLOW, force: true }).catch(() => undefined);

    expect(
      srv.state.main,
      "the undo of a CCAU write replaced the CLASS BODY with a test include. The bytes " +
        "were right and the URI was wrong: planUndo re-resolved the target without the " +
        "include (src/adt/undo.ts:755) and force=true waved through the drift that " +
        "mismatch produced. This is silent, authorised source destruction.",
    ).toBe(asServer(CLS_V1));
    expect(
      adt.calls.filter((c) => c.method === "PUT" && c.url === CLS_SRC),
      "a PUT reached /source/main for an entry recorded against /includes/testclasses.",
    ).toEqual([]);
  });

  it("either restores the include or refuses — it never reports a success it did not perform", async () => {
    const srv = fakeIncludeClassServer(CLS_V1, TESTS_V2);
    const { conn } = await connected(srv.route);
    const entry = await ccauEntry(TESTS_V1, TESTS_V2);

    const res = await performUndo(conn, journal, entry, { ...ALLOW, force: true }).catch(
      (e: unknown) => e as AbapError,
    );

    if (isAbapError(res)) {
      // The refusal shape. Acceptable — as long as nothing moved.
      expect(srv.state.ccau).toBe(asServer(TESTS_V2));
    } else {
      // The support shape. Then it must actually have restored the INCLUDE.
      expect(res.performed).toBe(true);
      expect(
        srv.state.ccau,
        "the undo reported success but the testclasses include still holds the text " +
          "abapsmith wrote. A 'performed' undo that changed nothing the entry names is a lie.",
      ).toBe(asServer(TESTS_V1));
      expect(res.plan.target.sourceUri).toBe(CLS_CCAU);
    }
  });

  it("never probes /source/main for an include entry — it reads the include or reads nothing", async () => {
    // The root cause, stated as a property that holds under BOTH shapes this
    // suite accepts. Reading /source/main to decide whether a CCAU write
    // drifted compares two unrelated documents and is guaranteed to answer
    // "drifted" for every healthy class in existence — so the forbidden
    // outcome is a GET of main, not the absence of a GET of the include.
    //
    // As shipped, `classIncludeBlocker` (src/adt/undo.ts) refuses in the
    // `localBlocker` chain, which is decided from the journal entry alone and
    // therefore probes nothing at all. That is the "reads nothing" branch, and
    // it satisfies the property for the strongest possible reason. When the
    // undo half lands, the plan will name the include and GET it instead, and
    // this test keeps holding without being rewritten — which is the point of
    // pinning the property rather than the current implementation.
    const srv = fakeIncludeClassServer(CLS_V1, TESTS_V2);
    const { conn, adt } = await connected(srv.route);
    const entry = await ccauEntry(TESTS_V1, TESTS_V2);

    adt.calls.length = 0;
    const plan = await planUndo(conn, journal, entry);

    const got = adt.calls.filter((c) => c.method === "GET").map((c) => c.url);
    expect(
      got,
      `probed ${got.join(", ")} — /source/main is the class BODY, and diffing it against a ` +
        "recorded CCAU before-image can only ever report drift that did not happen.",
    ).not.toContain(CLS_SRC);

    if (plan.undoable) {
      expect(got, `probed ${got.join(", ")} — the include was never read`).toContain(CLS_CCAU);
      expect(plan.target.sourceUri).toBe(CLS_CCAU);
    }
  });

  it("if it refuses, the refusal NAMES the include and does not accuse anybody of drift", async () => {
    const srv = fakeIncludeClassServer(CLS_V1, TESTS_V2);
    const { conn } = await connected(srv.route);
    const entry = await ccauEntry(TESTS_V1, TESTS_V2);

    const plan = await planUndo(conn, journal, entry);
    if (plan.undoable) return; // supported rather than refused — covered above

    const blocker = plan.blocker ?? "";
    expect(
      blocker,
      "an include-scoped undo was refused without saying that an include is why.",
    ).toMatch(/testclasses|include/i);
    // The wrong diagnosis is worse than no diagnosis: today's message reports
    // third-party drift, sending the user to hunt a colleague's edit that never
    // happened — and offering force=true, which is the destructive branch.
    expect(
      blocker,
      "the refusal blames drift or a missing object. Neither is true: the class is " +
        "present and unmodified; abapsmith is looking at the wrong include of it.",
    ).not.toMatch(/somebody|no longer exists|was deleted after/i);
  });

  it("does not over-refuse: an entry with no include is still undoable exactly as before", async () => {
    // The guard must be a scalpel. A plain class write — the overwhelming
    // majority of entries, and every entry written before class sub-include
    // write support existed — has to keep working, warning included.
    const srv = fakeIncludeClassServer(CLS_V2, TESTS_V1);
    const { conn } = await connected(srv.route);
    const e = await journal.begin({
      operation: "update",
      object: { name: CLS, type: "CLAS/OC", uri: CLS_URI, sourceUri: CLS_SRC, package: "$TMP" },
      existedBefore: true,
      beforeCapture: "captured",
      beforeSource: asServer(CLS_V1),
      afterSource: asServer(CLS_V2),
    });
    await journal.finish(e!.id, { outcome: "succeeded" });

    const res = await performUndo(conn, journal, (await journal.get(e!.id))!, ALLOW);
    expect(res.performed).toBe(true);
    expect(srv.state.main).toBe(asServer(CLS_V1));
    expect(srv.state.ccau).toBe(asServer(TESTS_V1)); // untouched
    // The existing E4 partial warning must survive the change, not be replaced
    // by it: a main-include restore still does not cover the other four.
    expect(res.partial?.unrestored).toContain("testclasses");
  });

  it("does not over-refuse: an explicit include=\"main\" is the main source, and undoes normally", async () => {
    const srv = fakeIncludeClassServer(CLS_V2, TESTS_V1);
    const { conn } = await connected(srv.route);
    const e = await journal.begin({
      operation: "update",
      object: {
        name: CLS,
        type: "CLAS/OC",
        uri: CLS_URI,
        sourceUri: CLS_SRC,
        package: "$TMP",
        include: "main",
      } as JournalEntry["object"],
      existedBefore: true,
      beforeCapture: "captured",
      beforeSource: asServer(CLS_V1),
      afterSource: asServer(CLS_V2),
    });
    await journal.finish(e!.id, { outcome: "succeeded" });

    const res = await performUndo(conn, journal, (await journal.get(e!.id))!, ALLOW);
    expect(res.performed).toBe(true);
    expect(srv.state.main).toBe(asServer(CLS_V1));
  });

  it("keeps refusing to recreate a deleted class — include support must not unlock that", async () => {
    // Restates the existing guarantee from "a partial class restore must not
    // report success" above, deliberately, as a tripwire: the natural way to
    // implement include-aware undo is to teach `partialClassRestore` about
    // includes, and the natural bug in that is to conclude "we have includes
    // now, so a recreate is complete". It is not — nothing CAPTURES the four
    // sub-includes on delete (out of scope here), so the refusal at
    // src/adt/undo.ts:448-457 stays correct behaviour and stays on.
    const srv = fakeClassServer(CLS_V1);
    const { conn, adt } = await connected(srv.route);
    await writeClass(conn, "", { mode: "delete" });
    const del = (await journal.list())[0]!;

    adt.calls.length = 0;
    const plan = await planUndo(conn, journal, del);
    expect(plan.action).toBe("recreate");
    expect(plan.undoable).toBe(false);
    expect(plan.blockerForceable).toBe(true);
    expect(plan.partial?.unrestored).toEqual(["definitions", "implementations", "macros", "testclasses"]);

    const err = await catchErr(performUndo(conn, journal, del, ALLOW));
    expect(err.code).toBe("BAD_INPUT");
    expect(adt.verbs).not.toContain("PUT");
    expect(srv.state.source).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// an unjournalled undo must say so
// ---------------------------------------------------------------------------

describe("undo with no journal entry of its own", () => {
  /** The journal answering `undefined` from `begin()` is exactly "journal off". */
  const silence = (j: Journal): void => {
    (j as unknown as { begin: () => Promise<undefined> }).begin = async () => undefined;
  };

  it("performs the undo and leaves undoEntryId undefined instead of crashing", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);
    const entry = (await journal.list())[0]!;

    silence(journal);
    const res = await performUndo(conn, journal, entry, ALLOW);
    expect(res.performed).toBe(true);
    expect(res.undoEntryId).toBeUndefined();
    expect(srv.state.source).toBe(asServer(V1));
  });

  it("the tool says the undo was NOT journalled and cannot itself be undone", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);
    const entry = (await journal.list())[0]!;

    silence(journal);
    const out = await abapJournal(conn, { mode: "undo", entry: entry.id }, 60_000, journal, openGate());
    expect(out.text).toMatch(/performed: true/);
    expect(out.text).toMatch(/NOT journalled/);
    expect(out.text).toMatch(/CANNOT BE UNDONE/);
    expect(out.text).toContain("newEntry: NOT JOURNALLED");
    // No id is invented anywhere — including in the hint.
    expect(out.text).not.toMatch(/mode=undo entry=\S+ undoes this undo/);
  });

  it("warns that a FORCED overwrite is unrecoverable when it is not journalled", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await writeVia(conn, V2);
    const entry = (await journal.list())[0]!;
    srv.state.source = "REPORT zmcp_undo_rep.\nWRITE: / 'theirs'.\n";

    silence(journal);
    const out = await abapJournal(
      conn,
      { mode: "undo", entry: entry.id, force: true },
      60_000,
      journal, openGate());
    expect(out.text).toMatch(/is GONE/);
  });
});

// ---------------------------------------------------------------------------
// stranded `pending` entries are named, not hidden
// ---------------------------------------------------------------------------

describe("stranded pending entries", () => {
  const strand = async (name: string): Promise<JournalEntry> => {
    const e = await journal.begin({
      operation: "update",
      object: { name, type: "PROG/P", uri: `/sap/bc/adt/programs/programs/${name.toLowerCase()}`, package: "$TMP" },
      existedBefore: true,
      beforeSource: V1,
    });
    expect(e).toBeDefined();
    return e!;
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mode=list calls an old pending entry STRANDED and names it", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);
    // Only Date is faked: the journal's own fs calls must keep working.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-31T10:00:00Z"));
    const stale = await strand("ZMCP_CRASHED");
    vi.setSystemTime(new Date("2026-07-31T10:30:00Z"));

    adt.calls.length = 0;
    const list = await abapJournal(conn, { mode: "list" }, 60_000, journal);
    expect(adt.calls).toHaveLength(0);
    expect(list.text).toMatch(/STRANDED/);
    expect(list.text).toContain(stale.id);
    expect(list.text).toContain("ZMCP_CRASHED");
    expect(list.text).toMatch(/NOT\s+usable undos/);
  });

  it("does not call a write that started a second ago stranded", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    await strand("ZMCP_INFLIGHT");

    const list = await abapJournal(conn, { mode: "list" }, 60_000, journal);
    expect(list.text).not.toMatch(/STRANDED/);
    expect(list.text).toMatch(/still `pending`|in flight right now/);
  });

  it("names a stranded entry even when the listing page or filter would hide it", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-31T10:00:00Z"));
    await strand("ZMCP_CRASHED");
    vi.setSystemTime(new Date("2026-07-31T10:30:00Z"));
    await writeVia(conn, V2);

    // A filter that excludes the pending entry entirely.
    const list = await abapJournal(conn, { mode: "list", object: REPORT }, 60_000, journal);
    expect(list.text).toMatch(/STRANDED/);
    expect(list.text).toContain("ZMCP_CRASHED");
  });

  it("mode=show warns loudly that a pending entry is not a usable undo", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);
    const pending = await strand("ZMCP_CRASHED");

    adt.calls.length = 0;
    const show = await abapJournal(conn, { mode: "show", entry: pending.id }, 60_000, journal);
    expect(adt.calls).toHaveLength(0);
    expect(show.text).toMatch(/THIS IS NOT A USABLE UNDO/);
    expect(show.text).toMatch(/pending/);
  });

  it("keeps refusing a pending entry, and the journal-off error, unchanged", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    const pending = await strand("ZMCP_CRASHED");

    const err = await catchErr(performUndo(conn, journal, pending, ALLOW));
    expect(err.code).toBe("BAD_INPUT");

    const off = new Journal(jcfg({ enabled: false }), "A4H");
    const offErr = await catchErr(abapJournal(conn, { mode: "list" }, 60_000, off));
    expect(offErr.code).toBe("UNSUPPORTED");
  });
});

/**
 * Undo of an enhancement-type entry is refused outright.
 *
 * Before real TypeSpec rows were registered for the three enhancement types
 * (ENHO/XH, ENHO/XHH, ENHS/XS), `targetFromEntry` fell back to a fabricated,
 * generic `TypeSpec` for any unrecognised type — including these three — and
 * `undoBlocker` had no enhancement-specific check at all, so undo would have
 * gone on to *attempt* a restore/delete against a fabricated, source-shaped
 * target. That fixed the fabricated *spec*, but `targetFromEntry`'s
 * `sourceUri` fallback (`{uri}/source/main`) is still actively wrong for
 * ENHO/XH and ENHS/XS, neither of which has a `/source/main` on this
 * release. `undoBlocker` now refuses every enhancement entry before a target
 * is ever needed, so these tests pin both halves: the refusal fires, and it
 * fires with zero network calls, for every operation shape.
 */
describe("enhancement undo refusals", () => {
  const enhoXhRef = (name = "ZBADI_IMPL") => ({
    name,
    type: "ENHO/XH",
    uri: `/sap/bc/adt/enhancements/badiimpl/${name.toLowerCase()}`,
    package: "$TMP",
  });
  const enhoXhhRef = (name = "ZBADI_IMPL") => ({
    name,
    type: "ENHO/XHH",
    uri: `/sap/bc/adt/enhancements/badiimpl/${name.toLowerCase()}`,
    sourceUri: `/sap/bc/adt/enhancements/badiimpl/${name.toLowerCase()}/source/main`,
    package: "$TMP",
  });
  const enhsXsRef = (name = "ZBADI_SPOT") => ({
    name,
    type: "ENHS/XS",
    uri: `/sap/bc/adt/enhancements/enhsxs/${name.toLowerCase()}`,
    package: "$TMP",
  });

  it("refuses undo-of-create against a BAdI implementation with the sharp DELETE message, zero requests", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);
    const e = await journal.begin({
      operation: "create",
      object: enhoXhRef(),
      existedBefore: false, // undo-of-create ⇒ plannedAction === "delete"
      beforeCapture: "confirmed-absent",
    });
    expect(e).toBeDefined();
    await journal.finish(e!.id, { outcome: "succeeded" });

    adt.calls.length = 0;
    const err = await catchErr(performUndo(conn, journal, (await journal.get(e!.id))!, ALLOW));
    expect(err.message).toMatch(/DELETE the BAdI implementation ZBADI_IMPL/);
    expect(err.message).toMatch(/isActive/);
    expect(err.message).toMatch(/no local record of whether this implementation is/);
    expect(adt.calls).toHaveLength(0);

    // NOT FORCEABLE — there is no evidence force=true could supply here.
    const stillErr = await catchErr(
      performUndo(conn, journal, (await journal.get(e!.id))!, { ...ALLOW, force: true }),
    );
    expect(stillErr.message).toMatch(/DELETE the BAdI implementation ZBADI_IMPL/);
    expect(adt.calls).toHaveLength(0);
  });

  it("refuses a restore (not undo-of-create) against a BAdI implementation with the general refusal message", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);
    const e = await journal.begin({
      operation: "update",
      object: enhoXhRef(),
      existedBefore: true, // plannedAction === "restore", not "delete" ⇒ not the sharp DELETE branch
      beforeSource: V1,
    });
    expect(e).toBeDefined();
    await journal.finish(e!.id, { outcome: "succeeded" });

    adt.calls.length = 0;
    const err = await catchErr(performUndo(conn, journal, (await journal.get(e!.id))!, ALLOW));
    expect(err.message).toMatch(/refused outright/);
    expect(err.message).toMatch(/permanently undeletable phantom object/);
    expect(err.message).toMatch(/TADIR and E071 rows behind indefinitely/);
    expect(err.message).toMatch(/`tp` misconfigured/);
    expect(err.message).not.toMatch(/DELETE the BAdI implementation/);
    expect(adt.calls).toHaveLength(0);
  });

  it("refuses undo-of-create against a source-code plug-in (ENHO/XHH) with the general message, not the sharp one", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);
    const e = await journal.begin({
      operation: "create",
      object: enhoXhhRef(),
      existedBefore: false,
      beforeCapture: "confirmed-absent",
    });
    expect(e).toBeDefined();
    await journal.finish(e!.id, { outcome: "succeeded" });

    adt.calls.length = 0;
    const err = await catchErr(performUndo(conn, journal, (await journal.get(e!.id))!, ALLOW));
    // ENHO/XHH is a real, PUT-able source object, but the sharp DELETE message
    // is reserved for ENHO/XH specifically — a source-code plug-in still gets
    // the general outright-refusal message.
    expect(err.message).toMatch(/refused outright/);
    expect(err.message).not.toMatch(/DELETE the BAdI implementation/);
    expect(adt.calls).toHaveLength(0);
  });

  it("refuses undo-of-recreate against a deleted enhancement spot (ENHS/XS) with the general message", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);
    const e = await journal.begin({
      operation: "delete",
      object: enhsXsRef(),
      existedBefore: true,
      beforeSource: "<enhs:enhancementSpot/>",
    });
    expect(e).toBeDefined();
    await journal.finish(e!.id, { outcome: "succeeded" });

    adt.calls.length = 0;
    const err = await catchErr(performUndo(conn, journal, (await journal.get(e!.id))!, ALLOW));
    expect(err.message).toMatch(/refused outright/);
    expect(err.message).toMatch(/ENHS\/XS ZBADI_SPOT/);
    expect(adt.calls).toHaveLength(0);
  });

  it("planUndo reports the refusal without throwing and without fabricating a target that points at a real /source/main", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);
    const e = await journal.begin({
      operation: "create",
      object: enhoXhRef(),
      existedBefore: false,
      beforeCapture: "confirmed-absent",
    });
    expect(e).toBeDefined();
    await journal.finish(e!.id, { outcome: "succeeded" });

    adt.calls.length = 0;
    const plan = await planUndo(conn, journal, (await journal.get(e!.id))!);
    expect(plan.undoable).toBe(false);
    expect(plan.blocker).toMatch(/DELETE the BAdI implementation ZBADI_IMPL/);
    // planUndo must not throw for an enhancement entry — targetFromEntry (which
    // DOES throw for these types) is never the function that builds this
    // target; refusedEnhancementTarget is. The target it builds is honest: the
    // entry's own recorded uri, not a guessed /source/main.
    expect(plan.target.type).toBe("ENHO/XH");
    expect(plan.target.sourceUri).toBe(enhoXhRef().uri);
    expect(plan.target.sourceUri).not.toMatch(/\/source\/main$/);
    expect(adt.calls).toHaveLength(0);
  });

  // planUndo never reaches targetFromEntry for an enhancement entry (the
  // test above pins that), so this exercises targetFromEntry directly —
  // the exported unit-under-test, same idiom as plannedAction elsewhere in
  // this file — to pin the retryable:false override on the throw itself.
  it("targetFromEntry itself throws BAD_INPUT with retryable:false for an enhancement entry, overriding BAD_INPUT's retryable:true default", async () => {
    const e = await journal.begin({
      operation: "create",
      object: enhoXhRef(),
      existedBefore: false,
      beforeCapture: "confirmed-absent",
    });
    expect(e).toBeDefined();
    await journal.finish(e!.id, { outcome: "succeeded" });

    let caught: unknown;
    try {
      targetFromEntry((await journal.get(e!.id))!);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AbapError);
    const err = caught as AbapError;
    expect(err.code).toBe("BAD_INPUT");
    expect(RETRYABILITY["BAD_INPUT"]).toBe("retryable");
    expect(err.retryable).toBe(false);
  });
});

describe("a missing before-image says WHY it is missing", () => {
  /** existed + no bytes ⇒ the journal records `failed`, and fabricates no blob. */
  const captureFailed = async (): Promise<JournalEntry> => {
    const e = await journal.begin({
      operation: "update",
      object: { name: REPORT, type: "PROG/P", uri: REPORT_URI, package: "$TMP" },
      existedBefore: true,
    });
    expect(e).toBeDefined();
    await journal.finish(e!.id, { outcome: "succeeded" });
    return (await journal.get(e!.id))!;
  };

  it("blames the failed read, not the retention policy", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    const entry = await captureFailed();
    expect(entry.beforeCapture).toBe("failed");

    const plan = await planUndo(conn, journal, entry);
    expect(plan.undoable).toBe(false);
    expect(plan.blocker).toMatch(/never\s+captured/);
    expect(plan.blocker).toMatch(/Nothing was pruned/);
    // The wrong answer, verbatim: sending the reader to the retention settings
    // for a failure that happened on the wire.
    expect(plan.blocker).not.toMatch(/pruned by the retention policy/);
    expect(srv.state.source).toBe(V1);
  });

  it("mode=show says the same thing about the empty before-image", async () => {
    const srv = fakeServer(V1);
    const { conn } = await connected(srv.route);
    const entry = await captureFailed();

    const show = await abapJournal(conn, { mode: "show", entry: entry.id }, 60_000, journal);
    expect(show.text).toMatch(/none was ever captured/);
    expect(show.text).not.toMatch(/blob is gone/);
  });
});

/**
 * The unlock→activate window on the RECOVERY path.
 *
 * An undo is an ordinary write (`lock → PUT → unlock → activate`), and the
 * object lock does NOT span the activation. `abap_write` has long re-read the
 * source immediately before its activation POST and refused to activate bytes
 * it did not write (test/write-toctou.test.ts:740); undo did not, and leaned
 * instead on the in-process `ObjectGate` to keep a racing writer out of that
 * window. That gate is now opt-in and OFF by default, so the lean no longer
 * holds and `src/adt/undo.ts` carries the same guard.
 *
 * Why it matters more here than on the write path: this is the path a caller
 * reaches for to RECOVER. Activating whatever happens to be inactive would
 * publish a colleague's source as the result of the undo while reporting a
 * clean restore — a lost update dressed up as a rollback.
 *
 * The three fakes in this file all serve `GET <SRC>` out of a mutable
 * `state.source` that the undo's own PUT has just filled in, so the guard's
 * re-read always matched and the whole branch was invisible to the suite. This
 * test wraps `fakeServer` from the OUTSIDE — the fake itself is untouched, so
 * no existing test can be affected — and lands a third-party write on the
 * server at the one instant the guard exists to catch: after our unlock, before
 * our activation.
 */
describe("the undo's own unlock→activate window", () => {
  it("refuses to activate when another writer changed the object between the undo's PUT and its activation", async () => {
    const THEIRS = "REPORT zmcp_undo_rep.\nWRITE: / 'theirs'.\n";
    const srv = fakeServer(V1);

    // Armed only after the setup write, so `abapWrite`'s own pre-activation
    // re-read is left alone and the entry we are going to undo lands normally.
    let armed = false;
    let ourPutLanded = false;
    let theyLanded = false;
    const { conn, adt } = await connected((r) => {
      const out = srv.route(r);
      if (armed && ourPutLanded && !theyLanded && r.qs._action === "UNLOCK") {
        // The racing writer, landing in the gap the lock does not cover: our
        // restore is unlocked and not yet activated, and their source is now
        // the inactive version that our activation POST would publish.
        theyLanded = true;
        srv.state.source = THEIRS;
      }
      if (armed && r.url === REPORT_SRC && r.method === "PUT") ourPutLanded = true;
      return out;
    });

    await writeVia(conn, V2);
    const entry = (await journal.list())[0]!;
    armed = true;
    adt.calls.length = 0;

    const err = await catchErr(performUndo(conn, journal, entry, ALLOW));

    // The whole point of the guard: SAP is never asked to activate.
    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(false);
    expect(err.code).toBe("ETAG_CONFLICT");
    expect(err.details).toMatchObject({
      phase: "pre-activation",
      written: true,
      activated: false,
      operation: "undo",
      entry: entry.id,
    });
    // The two hashes are the evidence, and they must differ — a guard that
    // fired on equal etags would be firing for some other reason.
    expect(err.details.expectedEtag).not.toBe(err.details.actualEtag);
    expect(err.message).toContain(REPORT);
    expect(err.message).toMatch(/NOT activated/);
    // "Conflict" must not read as "nothing happened": our PUT is not rolled
    // back, and a blind retry would re-run the race and discard their work.
    expect(adt.calls.some((c) => c.method === "PUT" && c.url === REPORT_SRC)).toBe(true);
    expect(err.hint).toMatch(/DO NOT simply undo again/);
    // The race really did happen — the server ends holding THEIR bytes, and it
    // is precisely those bytes the undo declined to publish.
    expect(theyLanded).toBe(true);
    expect(srv.state.source).toBe(THEIRS);
  });
});

// ---------------------------------------------------------------------------
// probe() must ask the RIGHT uri for undo-of-create — DTEL/DE, DOMA/DD,
// TTYP/DA, MSAG/N, ENQU/DL, SRVB/SVB (write.shape: "properties") have no
// `/source/main` at all. Before the fix, `probe()` GET `t.sourceUri`, built
// unconditionally as `${uri}/source/main` (`targetFromEntry`) — a 404 for
// every one of those six types. Read as `{ exists: false }`, that made
// `detectDrift` and then `planUndo` collapse the undo of a create to
// `"noop"`: abapsmith reported success while the object stayed on the
// server. The fix (`probe()`, src/adt/undo.ts) asks `contentUri(t)`/
// `contentAccept(t)` instead — the SAME per-shape resolution `src/adt/write.ts`
// already uses for its own reads and writes.
//
// DEVC/K (a package) is deliberately NOT covered by that same fix. It used to
// be — routed through `contentUri`'s OTHER condition, `isPackageType()` — but
// that only swapped a 404-on-the-wrong-URI for a 406-on-the-right-one:
// `contentAccept()` still picks `text/plain` for `DEVC/K` (no `write` entry
// in the capabilities REGISTRY at all), and the packages XML endpoint 406s
// `Accept: text/plain` regardless of whether the package exists (live
// on A4H). See the next describe block below for that fix: `probe()` now
// special-cases packages entirely, before `contentUri`/`contentAccept` are
// ever consulted, and answers existence through repository search instead.
// ---------------------------------------------------------------------------

describe("undo-of-create probe URI: properties-shape type (DOMA/DD)", () => {
  const DOMA_NAME = "ZMCP_UNDO_DOMA";
  const DOMA_URI = "/sap/bc/adt/ddic/domains/zmcp_undo_doma";
  const DOMA_SRC = `${DOMA_URI}/source/main`;

  /** A minimal but real-shaped domain descriptor: root element, name, package. */
  const domaXml = (name = DOMA_NAME, pkg = "$TMP"): string =>
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" ` +
    `adtcore:type="DOMA/DD" adtcore:description="undo probe">` +
    `<adtcore:packageRef adtcore:name="${pkg}"/>` +
    `<doma:typeInformation><doma:datatype>CHAR</doma:datatype>` +
    `<doma:length>10</doma:length></doma:typeInformation>` +
    `</doma:domain>`;

  it("BEFORE THE FIX this reads as noop (wrong URI 404s); the fix probes the object's own URI and reports a real delete", async () => {
    const xml = domaXml();
    const { conn, adt } = await connected((r) => {
      if (r.url === DOMA_URI && r.method === "GET") return resp(200, xml, OK_XML);
      // Deliberately explicit 404 at the WRONG URI `targetFromEntry` used to
      // hand `probe()` (`${uri}/source/main`) before this fix. A
      // properties-shape object genuinely 404s here on the real system
      // (verified live — see probe()'s docstring) — routing it here means the
      // test fails loudly if `probe()` ever asks again.
      if (r.url === DOMA_SRC) return resp(404, NOT_FOUND_XML, OK_XML);
      return resp(200, "", OK_TEXT);
    });

    const e = await journal.begin({
      operation: "create",
      object: { name: DOMA_NAME, type: "DOMA/DD", uri: DOMA_URI, package: "$TMP" },
      existedBefore: false,
      beforeCapture: "confirmed-absent",
      afterSource: xml,
    });
    expect(e).toBeDefined();
    await journal.finish(e!.id, { outcome: "succeeded" });

    const plan = await planUndo(conn, journal, (await journal.get(e!.id))!);

    // The bug: a 404 on the wrong URI reads as "already absent", so
    // `effective` collapses "delete" to "noop" and undo silently does
    // nothing while the domain is still on the server.
    expect(plan.action).toBe("delete");
    expect(plan.undoable).toBe(true);
    expect(plan.blocker).toBeUndefined();
    expect(plan.drift.drifted).toBe(false);
    expect(plan.currentlyExists).toBe(true);
    expect(adt.calls.some((c) => c.url === DOMA_SRC)).toBe(false);
    expect(adt.calls.some((c) => c.url === DOMA_URI && c.method === "GET")).toBe(true);
  });
});

describe("undo-of-create probe: DEVC/K package existence via repository search, never a content GET to the packages URI", () => {
  const PKG_NAME = "ZMCP_UNDO_PKG";
  const PKG_URI = "/sap/bc/adt/packages/zmcp_undo_pkg";
  const PKG_SRC = `${PKG_URI}/source/main`;
  const SEARCH_PATH = "/sap/bc/adt/repository/informationsystem/search";

  const NOT_ACCEPTABLE_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
    <namespace id="com.sap.adt"/><type id="ExceptionResourceNotAcceptable"/>
    <message lang="EN">The message content is not acceptable</message><properties/></exc:exception>`;

  /** Same shape as the package-delete block below: a package names itself as its own `packageRef`. */
  const pkgXml = (name = PKG_NAME): string =>
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<pak:package xmlns:pak="http://www.sap.com/adt/packages" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" ` +
    `adtcore:type="DEVC/K" adtcore:description="undo probe">` +
    `<adtcore:packageRef adtcore:name="${name}"/></pak:package>`;

  const pkgRef: FakeObjectRef = { name: PKG_NAME, type: "DEVC/K", uri: PKG_URI, packageName: PKG_NAME };

  /**
   * Deliberately NOT `irreversible: true`, and deliberately NO `afterSource`
   * — production `DEVC/K` creates (`abapCreatePackage`, src/tools/write.ts)
   * set neither: `settle()` is called with `activation: { attempted: false }`
   * and no `afterSource`, because a package has no source to capture. This
   * entry models that faithfully rather than an idealised one `detectDrift`
   * would never actually see live.
   */
  const beginEntry = () =>
    journal.begin({
      operation: "create",
      object: { name: PKG_NAME, type: "DEVC/K", uri: PKG_URI, package: PKG_NAME },
      existedBefore: false,
      beforeCapture: "confirmed-absent",
    });

  /**
   * `resolveWriteTarget`'s own metadata read (`Accept: application/*`,
   * unconditional — needed to authorize against the package's `packageRef`,
   * nothing to do with `probe()`) always answers with a genuine descriptor
   * here; only the SEARCH_PATH route below varies per test, exactly the way
   * `probe()`/`probePackage` settles existence now.
   */
  const metadataRoute = (r: Recorded): HttpClientResponse | undefined =>
    r.url === PKG_URI && r.method === "GET" ? resp(200, pkgXml(), OK_XML) : undefined;

  it("package still exists: plan is a real delete, decided from repository search — no content GET against the packages URI", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === SEARCH_PATH) return resp(200, searchResultsXml([pkgRef]), OK_XML);
      return metadataRoute(r) ?? resp(200, "", OK_TEXT);
    });

    const e = await beginEntry();
    expect(e).toBeDefined();
    expect(e!.irreversible).toBeUndefined();
    await journal.finish(e!.id, { outcome: "succeeded" });

    const plan = await planUndo(conn, journal, (await journal.get(e!.id))!);

    expect(plan.action).toBe("delete");
    expect(plan.undoable).toBe(true);
    expect(plan.blocker).toBeUndefined();
    expect(plan.drift.drifted).toBe(false);
    expect(plan.currentlyExists).toBe(true);
    expect(adt.calls.some((c) => c.url === SEARCH_PATH)).toBe(true);
    // The whole point of this fix: existence is decided from SEARCH_PATH, not
    // from asking the packages URI for its (nonexistent) content — the ONE
    // GET to PKG_URI here is `resolveWriteTarget`'s own metadata read
    // (asserted below to carry a different Accept), and PKG_SRC is never
    // asked at all.
    expect(adt.calls.some((c) => c.url === PKG_URI && c.method === "GET")).toBe(true);
    expect(
      adt.calls.filter((c) => c.url === PKG_URI && c.method === "GET").every((c) => c.headers["Accept"] !== "text/plain"),
    ).toBe(true);
    expect(adt.calls.some((c) => c.url === PKG_SRC)).toBe(false);
  });

  it("package already absent: the existing 'nothing to do' no-op verdict, unchanged", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === SEARCH_PATH) return resp(200, searchResultsXml([]), OK_XML);
      return metadataRoute(r) ?? resp(200, "", OK_TEXT);
    });

    const e = await beginEntry();
    await journal.finish(e!.id, { outcome: "succeeded" });

    const plan = await planUndo(conn, journal, (await journal.get(e!.id))!);

    expect(plan.action).toBe("noop");
    expect(plan.undoable).toBe(true);
    expect(plan.blocker).toBeUndefined();
    expect(plan.currentlyExists).toBe(false);
    expect(plan.drift.reason).toMatch(/already absent/);
    expect(adt.calls.some((c) => c.url === SEARCH_PATH)).toBe(true);
    expect(adt.calls.some((c) => c.url === PKG_SRC)).toBe(false);
  });

  it("indeterminate existence (search hit, wrong type) refuses honestly — never silently reported as exists or absent", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === SEARCH_PATH) {
        return resp(200, searchResultsXml([{ ...pkgRef, type: "TABL/DT" }]), OK_XML);
      }
      return metadataRoute(r) ?? resp(200, "", OK_TEXT);
    });

    const e = await beginEntry();
    await journal.finish(e!.id, { outcome: "succeeded" });

    const plan = await planUndo(conn, journal, (await journal.get(e!.id))!);

    expect(plan.undoable).toBe(false);
    expect(plan.blockerForceable).toBeUndefined();
    expect(plan.blocker).toMatch(
      /could not be determined.*abapsmith will not guess either way before a delete-shaped undo/s,
    );
    expect(plan.blocker).toMatch(/TABL\/DT/); // verifyViaRepositorySearch's own reason, preserved verbatim
    expect(plan.drift.drifted).toBe(false);
    expect(plan.drift.reason).toBe("not evaluated — package existence could not be determined");

    // force=true must not manufacture an existence check that never settled —
    // same message, forced or not.
    const packageGate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP", PKG_NAME] });
    const allow: UndoOptions = {
      assertAllowed: (action, target) =>
        packageGate.authorize(action === "delete" ? "delete" : "write", target),
      gate: packageGate,
      force: true,
    };
    adt.calls.length = 0;
    const err = await catchErr(performUndo(conn, journal, (await journal.get(e!.id))!, allow));
    expect(err.message).toBe(plan.blocker);
  });

  it("regression trap: a GET with Accept: text/plain to the packages URI must never happen again — this is the exact live 406", async () => {
    const { conn } = await connected((r) => {
      if (r.url === SEARCH_PATH) return resp(200, searchResultsXml([pkgRef]), OK_XML);
      // The precise pre-fix bug: probe() asking `contentUri(t)` (the
      // package's own URI, since `usesObjectUriForContent` is true for a
      // package too) for `contentAccept(t)` — `text/plain`, since DEVC/K has
      // no `write` REGISTRY entry. `resolveWriteTarget`'s own metadata read
      // uses a DIFFERENT Accept (`application/*`) and is answered normally
      // by `metadataRoute` below — only the exact old buggy signature 406s.
      // If `probe()` is ever changed to fall back to that path for a
      // package, this route reproduces the live 406 instead of quietly
      // succeeding, and the assertions below catch it.
      if (r.url === PKG_URI && r.method === "GET" && r.headers["Accept"] === "text/plain") {
        return resp(406, NOT_ACCEPTABLE_XML, OK_XML);
      }
      return metadataRoute(r) ?? resp(200, "", OK_TEXT);
    });

    const e = await beginEntry();
    await journal.finish(e!.id, { outcome: "succeeded" });

    // No throw, and a real delete plan: proves the trap route above was
    // never reached.
    const plan = await planUndo(conn, journal, (await journal.get(e!.id))!);
    expect(plan.action).toBe("delete");
    expect(plan.undoable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// package delete now has a real mechanism (the DDIC classrun
// bridge, src/adt/package-delete.ts), so undo of a DEVC/K create performs
// it — this block pins the new mechanism, not the old refusal it replaced.
// ---------------------------------------------------------------------------

describe("undo of a DEVC/K package create now performs the delete", () => {
  const PKG_NAME = "ZMCP_UNDO_PKG3";
  const PKG_URI = "/sap/bc/adt/packages/zmcp_undo_pkg3";

  /** Same shape as the properties-shape block above: a package names itself as its own `packageRef`. */
  const pkgXml = (name = PKG_NAME): string =>
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<pak:package xmlns:pak="http://www.sap.com/adt/packages" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" ` +
    `adtcore:type="DEVC/K" adtcore:description="undo probe">` +
    `<adtcore:packageRef adtcore:name="${name}"/></pak:package>`;

  const BRIDGE_CLASS = DDIC_BRIDGE_CLASS.deletePackage;
  const BRIDGE_COLLECTION = "/sap/bc/adt/oo/classes";
  const BRIDGE_OBJ_URI = `${BRIDGE_COLLECTION}/${BRIDGE_CLASS.toLowerCase()}`;
  const BRIDGE_SRC_URI = `${BRIDGE_OBJ_URI}/source/main`;

  /**
   * `src/safety.ts` judges a package delete by the package's OWN name as its
   * container (it is its own package) — `openGate()`'s `["$TMP"]` allowlist
   * doesn't cover a name like PKG_NAME, so this block needs its own gate.
   * Wired to both `assertAllowed` and `.gate` from the SAME instance, exactly
   * as `src/tools/journal.ts`'s real undo handler does — not a weaker gate,
   * a correctly-scoped one.
   */
  const packageGate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP", PKG_NAME] });
  const PKG_ALLOW: UndoOptions = {
    assertAllowed: (action, target) => packageGate.authorize(action === "delete" ? "delete" : "write", target),
    gate: packageGate,
  };

  /** Deploy → activate → run the delete bridge; `classrunLines` is the transcript it produces. */
  const bridgeRoute =
    (classrunLines: string[]) =>
    (r: Recorded): HttpClientResponse | undefined => {
      if (r.url === BRIDGE_OBJ_URI && r.method === "GET" && !r.qs._action) return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === BRIDGE_COLLECTION && r.method === "POST") return resp(200, "", OK_TEXT);
      if (r.url === BRIDGE_OBJ_URI && r.qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
      if (r.url === BRIDGE_OBJ_URI && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === BRIDGE_SRC_URI && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
      if (r.url.startsWith("/sap/bc/adt/oo/classrun/")) return resp(200, classrunLines.join("\n"), OK_TEXT);
      return undefined;
    };

  const SEARCH_PATH = "/sap/bc/adt/repository/informationsystem/search";
  const pkgRef: FakeObjectRef = { name: PKG_NAME, type: "DEVC/K", uri: PKG_URI, packageName: PKG_NAME };

  /**
   * `resolveWriteTarget`'s OWN metadata read (unconditional, independent of
   * `probe()` — it needs the package's `packageRef` to authorize against,
   * `Accept: application/*` since DEVC/K sets no `mediaType`) plus `planUndo`'s
   * drift-check probe, now repository search confirming the package exists
   * (no GET to `PKG_SRC`/`/source/main` any more — see the describe
   * block above), plus the delete bridge above.
   */
  const packageRoute =
    (classrunLines: string[]) =>
    (r: Recorded): HttpClientResponse => {
      if (r.url === PKG_URI && r.method === "GET") return resp(200, pkgXml(), OK_XML);
      if (r.url === SEARCH_PATH) return resp(200, searchResultsXml([pkgRef]), OK_XML);
      return bridgeRoute(classrunLines)(r) ?? resp(200, "", OK_TEXT);
    };

  it("deletes the package for real, through the bridge — never through ADT lock/REST-DELETE", async () => {
    const { conn, adt } = await connected(packageRoute(["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"]));
    const e = await journal.begin({
      operation: "create",
      object: { name: PKG_NAME, type: "DEVC/K", uri: PKG_URI, package: PKG_NAME },
      existedBefore: false,
      beforeCapture: "confirmed-absent",
      afterSource: pkgXml(),
    });
    expect(e).toBeDefined();
    expect(e!.irreversible).toBeUndefined();
    await journal.finish(e!.id, { outcome: "succeeded" });

    adt.calls.length = 0;
    const res = await performUndo(conn, journal, (await journal.get(e!.id))!, PKG_ALLOW);

    expect(res.performed).toBe(true);
    expect(res.plan.action).toBe("delete");
    // The bridge really ran: its class was written and executed.
    expect(adt.calls.some((c) => c.url === BRIDGE_SRC_URI && c.method === "PUT")).toBe(true);
    expect(adt.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
    // Never the ordinary object path — there is no ADT REST DELETE for a package.
    expect(adt.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(adt.calls.some((c) => c.url === PKG_URI && c.qs._action === "LOCK")).toBe(false);

    expect((await journal.get(e!.id))!.undoneBy).toBeDefined();
  });

  it("PKG-DELETED/PKG-GONE are required, not just PKG-EMPTY — a truncated transcript is a failure", async () => {
    const { conn } = await connected(packageRoute(["PKG-EMPTY", "PKG-DELETED"])); // no PKG-GONE
    const e = await journal.begin({
      operation: "create",
      object: { name: PKG_NAME, type: "DEVC/K", uri: PKG_URI, package: PKG_NAME },
      existedBefore: false,
      beforeCapture: "confirmed-absent",
      afterSource: pkgXml(),
    });
    await journal.finish(e!.id, { outcome: "succeeded" });

    const err = await catchErr(performUndo(conn, journal, (await journal.get(e!.id))!, PKG_ALLOW));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toMatch(/PKG-GONE/);
    expect((await journal.get(e!.id))!.undoneBy).toBeUndefined();
  });

  it("the gate really reaches the bridge: a mismatched allowlist refuses before the bridge is ever touched", async () => {
    const { conn, adt } = await connected(packageRoute(["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"]));
    const e = await journal.begin({
      operation: "create",
      object: { name: PKG_NAME, type: "DEVC/K", uri: PKG_URI, package: PKG_NAME },
      existedBefore: false,
      beforeCapture: "confirmed-absent",
      afterSource: pkgXml(),
    });
    await journal.finish(e!.id, { outcome: "succeeded" });

    // assertAllowed still authorises normally (PKG_ALLOW's own gate) — only
    // opts.gate is hostile, so a refusal here can only come from
    // deleteObject's bridgeGate really being opts.gate, not from
    // assertAllowed's authorization being reused for both.
    const mismatchedGate = new SafetyGate({ readOnly: false, allowPackages: ["ZOTHER_*"] });
    adt.calls.length = 0;
    const err = await catchErr(
      performUndo(conn, journal, (await journal.get(e!.id))!, { ...PKG_ALLOW, gate: mismatchedGate }),
    );
    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toMatch(/not in the allowlist/);
    // planUndo's own drift-check probe (the package's own descriptor) still
    // runs — unavoidable, unrelated to the bridge. What must be true is that
    // NOTHING past it happened: the bridge was never deployed or run.
    expect(adt.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(false);
    expect(adt.calls.some((c) => c.url === BRIDGE_SRC_URI)).toBe(false);
    expect(adt.verbs).not.toContain("LOCK");
  });

  it("deleteEvidenceBlocker is exactly as strict for DEVC/K as for any other type — not forceable", async () => {
    const { conn, adt } = await connected(packageRoute(["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"]));
    const e = await journal.begin({
      operation: "create",
      object: { name: PKG_NAME, type: "DEVC/K", uri: PKG_URI, package: PKG_NAME },
      existedBefore: false,
      beforeCapture: "unknown",
    });
    await journal.finish(e!.id, { outcome: "succeeded" });

    adt.calls.length = 0;
    const err = await catchErr(performUndo(conn, journal, (await journal.get(e!.id))!, PKG_ALLOW));
    expect(err.message).toMatch(/positive evidence/);
    expect(adt.calls).toHaveLength(0); // this blocker fires from the entry alone

    const stillErr = await catchErr(
      performUndo(conn, journal, (await journal.get(e!.id))!, { ...PKG_ALLOW, force: true }),
    );
    expect(stillErr.message).toBe(err.message);
  });

  it("a non-empty package refuses honestly — CHECK_FAILED names the contents, and the entry is not marked undone", async () => {
    const contentLine = `${PKG_CONTENT_PREFIX} KIND=OBJECT PGMID=R3TR OBJECT=CLAS NAME=ZCL_INSIDE_PKG`;
    const { conn, adt } = await connected(packageRoute([contentLine]));
    const e = await journal.begin({
      operation: "create",
      object: { name: PKG_NAME, type: "DEVC/K", uri: PKG_URI, package: PKG_NAME },
      existedBefore: false,
      beforeCapture: "confirmed-absent",
      afterSource: pkgXml(),
    });
    await journal.finish(e!.id, { outcome: "succeeded" });

    const err = await catchErr(performUndo(conn, journal, (await journal.get(e!.id))!, PKG_ALLOW));
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("is not empty and was NOT deleted");
    expect(err.message).toContain("ZCL_INSIDE_PKG");
    expect((await journal.get(e!.id))!.undoneBy).toBeUndefined();
    expect(adt.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("a genuinely irreversible entry (non-package) is still refused generically, with no package clause", async () => {
    const srv = fakeServer(V1);
    const { conn, adt } = await connected(srv.route);
    const e = await journal.begin({
      operation: "create",
      object: { name: REPORT, type: "PROG/P", uri: REPORT_URI, package: "$TMP" },
      existedBefore: false,
      beforeCapture: "confirmed-absent",
      irreversible: true,
    });
    expect(e).toBeDefined();
    await journal.finish(e!.id, { outcome: "succeeded" });

    const expectedMessage =
      "This entry is marked irreversible — recorded for history only. No mechanism " +
      "can undo it, not even with force=true.";

    const err = await catchErr(performUndo(conn, journal, (await journal.get(e!.id))!, ALLOW));
    expect(err.message).toBe(expectedMessage);
    expect(adt.calls).toHaveLength(0); // refused before any request, like every other local blocker

    const stillErr = await catchErr(
      performUndo(conn, journal, (await journal.get(e!.id))!, { ...ALLOW, force: true }),
    );
    expect(stillErr.message).toBe(expectedMessage);
  });
});

// ---------------------------------------------------------------------------
// VIEW/DV and TRAN/T undo-of-create. Neither type reaches ADT REST at
// all (isBridgeOnlyCreateType, src/adt/capabilities.ts) — resolveWriteTarget
// refuses both unconditionally, and probe()'s /source/main GET has nothing
// to read for either — so planUndo resolves them through a single
// verifyViaVitBridge read instead (resolveBridgeCreateUndo), and performUndo
// dispatches their delete-shaped undo to deleteClassicViewViaBridge /
// deleteTransactionViaBridge rather than deleteObject.
// ---------------------------------------------------------------------------

describe("undo-of-create probe: VIEW/DV existence via the VIT bridge, never resolveWriteTarget or /source/main", () => {
  const VIEW = "ZMCP_UNDO_V1";
  const VIT_URI = vitBridgeUri("viewdv", VIEW);

  /**
   * `pkg === null` renders `<adtcore:packageRef />` (note the space before
   * the self-close: `vitStubShowsRegistration`, src/adt/write-verify.ts,
   * requires whitespace or `>` immediately after `packageRef` — kept
   * byte-identical to the earlier test that first pinned this requirement — so a bare
   * `<adtcore:packageRef/>` would NOT satisfy it) — present (so
   * `vitStubShowsExistence` still counts the stub as existing) but with no
   * usable name, so `packageRefName` returns `undefined`. That is the only
   * way to reach `verifyViaVitBridge`'s `status: "confirmed"` with no
   * `packageName` — a stub with NO `packageRef` element and none of
   * `vitStubShowsExistence`'s enriched attributes either comes back
   * `confirmed-absent` instead (see `vitStubShowsExistence`,
   * src/adt/write-verify.ts), never `confirmed`.
   */
  const vitXml = (pkg?: string | null): string =>
    `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:type="VIEW/DV" adtcore:name="${VIEW}">` +
    (pkg === null ? `<adtcore:packageRef />` : pkg ? `<adtcore:packageRef adtcore:name="${pkg}"/>` : "") +
    `</vit:properties>`;

  const beginEntry = () =>
    journal.begin({
      operation: "create",
      object: { name: VIEW, type: "VIEW/DV", uri: VIT_URI, package: "$TMP" },
      existedBefore: false,
      beforeCapture: "confirmed-absent",
    });

  it("still exists with a package: plan is a real delete, resolved from ONE VIT read — never /source/main", async () => {
    const { conn, adt } = await connected((r) =>
      r.url === VIT_URI && r.method === "GET" ? resp(200, vitXml("ZTM"), OK_XML) : resp(200, "", OK_TEXT),
    );
    const e = await beginEntry();
    await journal.finish(e!.id, { outcome: "succeeded" });

    const plan = await planUndo(conn, journal, (await journal.get(e!.id))!);

    expect(plan.action).toBe("delete");
    expect(plan.undoable).toBe(true);
    expect(plan.blocker).toBeUndefined();
    expect(plan.target.packageName).toBe("ZTM");
    expect(plan.target.packageSource).toBe("server");
    expect(plan.currentlyExists).toBe(true);
    expect(adt.calls.filter((c) => c.url === VIT_URI)).toHaveLength(1);
    expect(adt.calls.some((c) => c.url.endsWith("/source/main"))).toBe(false);
  });

  it("already absent: the existing 'nothing to do' no-op verdict, unchanged", async () => {
    const { conn, adt } = await connected((r) =>
      r.url === VIT_URI && r.method === "GET" ? resp(404, NOT_FOUND_XML, OK_XML) : resp(200, "", OK_TEXT),
    );
    const e = await beginEntry();
    await journal.finish(e!.id, { outcome: "succeeded" });

    const plan = await planUndo(conn, journal, (await journal.get(e!.id))!);

    expect(plan.action).toBe("noop");
    expect(plan.undoable).toBe(true);
    expect(plan.currentlyExists).toBe(false);
    expect(plan.drift.reason).toMatch(/already absent/);
    expect(adt.calls.filter((c) => c.url === VIT_URI)).toHaveLength(1);
  });

  it("confirmed but carrying an empty packageRef: refused honestly, never treated as exists or absent", async () => {
    const { conn } = await connected((r) =>
      r.url === VIT_URI && r.method === "GET" ? resp(200, vitXml(null), OK_XML) : resp(200, "", OK_TEXT),
    );
    const e = await beginEntry();
    await journal.finish(e!.id, { outcome: "succeeded" });

    const plan = await planUndo(conn, journal, (await journal.get(e!.id))!);

    expect(plan.undoable).toBe(false);
    expect(plan.blocker).toMatch(/could not be determined/);
    expect(plan.blocker).toMatch(/no <adtcore:packageRef>/);
    expect(plan.drift.drifted).toBe(false);
  });

  it("indeterminate VIT read: refused as a plan, not a throw, and not overridable with force", async () => {
    const { conn } = await connected((r) =>
      r.url === VIT_URI && r.method === "GET" ? resp(500, "boom", OK_TEXT) : resp(200, "", OK_TEXT),
    );
    const e = await beginEntry();
    await journal.finish(e!.id, { outcome: "succeeded" });

    const plan = await planUndo(conn, journal, (await journal.get(e!.id))!);
    expect(plan.undoable).toBe(false);
    expect(plan.blocker).toMatch(/could not be determined/);

    const err = await catchErr(performUndo(conn, journal, (await journal.get(e!.id))!, { ...ALLOW, force: true }));
    expect(err.message).toBe(plan.blocker);
  });
});

describe("undo of a VIEW/DV bridge create now performs the delete via the DDIC bridge", () => {
  const VIEW = "ZMCP_UNDO_V2";
  const VIT_URI = vitBridgeUri("viewdv", VIEW);
  const BRIDGE_CLASS = DDIC_BRIDGE_CLASS.deleteView;
  const BRIDGE_COLLECTION = "/sap/bc/adt/oo/classes";
  const BRIDGE_OBJ_URI = `${BRIDGE_COLLECTION}/${BRIDGE_CLASS.toLowerCase()}`;
  const BRIDGE_SRC_URI = `${BRIDGE_OBJ_URI}/source/main`;

  const vitXml = (pkg: string): string =>
    `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:type="VIEW/DV" adtcore:name="${VIEW}"><adtcore:packageRef adtcore:name="${pkg}"/></vit:properties>`;

  /**
   * The real package the server hands back is `ZTM`; the journal entry's
   * OWN `object.package` is stashed as a DIFFERENT, made-up value
   * (`WRONG_PKG`) — a stand-in for a stale/incorrect record. The gate below
   * allows only `ZTM`. If `performUndo` ever reconstructed the `ServerPackage`
   * from `entry.object.package` instead of `plan.bridgeCreateVerify`, this
   * gate would refuse it; if it correctly uses the VIT-confirmed package, it
   * proceeds. That is the whole point of this fixture.
   */
  const REAL_PKG = "ZTM";
  const STALE_JOURNAL_PKG = "WRONG_PKG";
  const viewGate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP", REAL_PKG] });
  const VIEW_ALLOW: UndoOptions = {
    assertAllowed: (action, target) => viewGate.authorize(action === "delete" ? "delete" : "write", target),
    gate: viewGate,
  };

  /** Deploy → run the delete bridge; toggles `state.exists` so the post-delete VIT read reflects it. */
  const bridgeServer = (classrunLines: string[]) => {
    const state = { exists: true };
    const route = (r: Recorded): HttpClientResponse | undefined => {
      if (r.url === VIT_URI && r.method === "GET") {
        return state.exists ? resp(200, vitXml(REAL_PKG), OK_XML) : resp(404, NOT_FOUND_XML, OK_XML);
      }
      if (r.url === BRIDGE_OBJ_URI && r.method === "GET" && !r.qs._action) return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === BRIDGE_COLLECTION && r.method === "POST") return resp(200, "", OK_TEXT);
      if (r.url === BRIDGE_OBJ_URI && r.qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
      if (r.url === BRIDGE_OBJ_URI && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === BRIDGE_SRC_URI && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
      if (r.url.startsWith("/sap/bc/adt/oo/classrun/")) {
        state.exists = false;
        return resp(200, classrunLines.join("\n"), OK_TEXT);
      }
      return undefined;
    };
    return { state, route };
  };

  const beginEntry = () =>
    journal.begin({
      operation: "create",
      object: { name: VIEW, type: "VIEW/DV", uri: VIT_URI, package: STALE_JOURNAL_PKG },
      existedBefore: false,
      beforeCapture: "confirmed-absent",
    });

  it("deletes for real through the bridge, using the SERVER-confirmed package, not the journal's stored one", async () => {
    const { state, route } = bridgeServer(["VIEW-DELETED", "VIEW-GONE"]);
    const { conn, adt } = await connected(route);
    const e = await beginEntry();
    await journal.finish(e!.id, { outcome: "succeeded" });

    adt.calls.length = 0;
    const res = await performUndo(conn, journal, (await journal.get(e!.id))!, VIEW_ALLOW);

    expect(res.performed).toBe(true);
    expect(res.plan.action).toBe("delete");
    expect(state.exists).toBe(false);
    expect(adt.calls.some((c) => c.url === BRIDGE_SRC_URI && c.method === "PUT")).toBe(true);
    expect(adt.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
    // Never the ordinary object path — VIEW/DV has no writable ADT REST collection.
    expect(adt.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect((await journal.get(e!.id))!.undoneBy).toBeDefined();
  });

  it("VIEW-DELETED/VIEW-GONE are both required — a truncated transcript is a failure, and the entry stays not-undone", async () => {
    const { route } = bridgeServer(["VIEW-DELETED"]); // no VIEW-GONE
    const { conn } = await connected(route);
    const e = await beginEntry();
    await journal.finish(e!.id, { outcome: "succeeded" });

    const err = await catchErr(performUndo(conn, journal, (await journal.get(e!.id))!, VIEW_ALLOW));
    expect(err.code).toBe("CHECK_FAILED");
    expect((await journal.get(e!.id))!.undoneBy).toBeUndefined();
  });

  it("a gate that only allows the journal's (wrong) package refuses — proving the server package, not the journal's, is what gets checked", async () => {
    const { route } = bridgeServer(["VIEW-DELETED", "VIEW-GONE"]);
    const { conn, adt } = await connected(route);
    const e = await beginEntry();
    await journal.finish(e!.id, { outcome: "succeeded" });

    const wrongGate = new SafetyGate({ readOnly: false, allowPackages: [STALE_JOURNAL_PKG] });
    adt.calls.length = 0;
    const err = await catchErr(
      performUndo(conn, journal, (await journal.get(e!.id))!, {
        assertAllowed: (action, target) => wrongGate.authorize(action === "delete" ? "delete" : "write", target),
        gate: wrongGate,
      }),
    );
    expect(err.code).toBe("SAFETY_DENIED");
    expect(adt.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(false);
  });

  it("deleteEvidenceBlocker is exactly as strict for VIEW/DV as for any other type — not forceable, zero network calls", async () => {
    const { route } = bridgeServer(["VIEW-DELETED", "VIEW-GONE"]);
    const { conn, adt } = await connected(route);
    const e = await journal.begin({
      operation: "create",
      object: { name: VIEW, type: "VIEW/DV", uri: VIT_URI, package: STALE_JOURNAL_PKG },
      existedBefore: false,
      beforeCapture: "failed",
    });
    await journal.finish(e!.id, { outcome: "succeeded" });

    adt.calls.length = 0;
    const err = await catchErr(performUndo(conn, journal, (await journal.get(e!.id))!, VIEW_ALLOW));
    expect(err.message).toMatch(/positive evidence/);
    expect(adt.calls).toHaveLength(0);
  });
});

describe("undo of a TRAN/T bridge create now performs the delete via the DDIC bridge", () => {
  const TCODE = "ZMCPT02";
  const VIT_URI = vitBridgeUri("trant", TCODE);
  const BRIDGE_CLASS = DDIC_BRIDGE_CLASS.deleteTransaction;
  const BRIDGE_COLLECTION = "/sap/bc/adt/oo/classes";
  const BRIDGE_OBJ_URI = `${BRIDGE_COLLECTION}/${BRIDGE_CLASS.toLowerCase()}`;
  const BRIDGE_SRC_URI = `${BRIDGE_OBJ_URI}/source/main`;
  const REAL_PKG = "ZTM";

  const vitXml = (pkg: string): string =>
    `<vit:properties xmlns:vit="http://www.sap.com/adt/vit" xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:type="TRAN/T" adtcore:name="${TCODE}"><adtcore:packageRef adtcore:name="${pkg}"/></vit:properties>`;

  const tranGate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP", REAL_PKG] });
  const TRAN_ALLOW: UndoOptions = {
    assertAllowed: (action, target) => tranGate.authorize(action === "delete" ? "delete" : "write", target),
    gate: tranGate,
  };

  const bridgeServer = (classrunLines: string[]) => {
    const state = { exists: true };
    const route = (r: Recorded): HttpClientResponse | undefined => {
      if (r.url === VIT_URI && r.method === "GET") {
        return state.exists ? resp(200, vitXml(REAL_PKG), OK_XML) : resp(404, NOT_FOUND_XML, OK_XML);
      }
      if (r.url === BRIDGE_OBJ_URI && r.method === "GET" && !r.qs._action) return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === BRIDGE_COLLECTION && r.method === "POST") return resp(200, "", OK_TEXT);
      if (r.url === BRIDGE_OBJ_URI && r.qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
      if (r.url === BRIDGE_OBJ_URI && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === BRIDGE_SRC_URI && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
      if (r.url.startsWith("/sap/bc/adt/oo/classrun/")) {
        state.exists = false;
        return resp(200, classrunLines.join("\n"), OK_TEXT);
      }
      return undefined;
    };
    return { state, route };
  };

  const beginEntry = () =>
    journal.begin({
      operation: "create",
      object: { name: TCODE, type: "TRAN/T", uri: VIT_URI, package: "$TMP" },
      existedBefore: false,
      beforeCapture: "confirmed-absent",
    });

  it("deletes for real through the bridge, same dispatch as VIEW/DV", async () => {
    const { state, route } = bridgeServer(["TRAN-DELETED", "TRAN-GONE"]);
    const { conn, adt } = await connected(route);
    const e = await beginEntry();
    await journal.finish(e!.id, { outcome: "succeeded" });

    adt.calls.length = 0;
    const res = await performUndo(conn, journal, (await journal.get(e!.id))!, TRAN_ALLOW);

    expect(res.performed).toBe(true);
    expect(state.exists).toBe(false);
    expect(adt.calls.some((c) => c.url === BRIDGE_SRC_URI && c.method === "PUT")).toBe(true);
    expect(adt.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect((await journal.get(e!.id))!.undoneBy).toBeDefined();
  });

  it("TRAN-DELETED/TRAN-GONE are both required — a truncated transcript is a failure", async () => {
    const { route } = bridgeServer(["TRAN-DELETED"]); // no TRAN-GONE
    const { conn } = await connected(route);
    const e = await beginEntry();
    await journal.finish(e!.id, { outcome: "succeeded" });

    const err = await catchErr(performUndo(conn, journal, (await journal.get(e!.id))!, TRAN_ALLOW));
    expect(err.code).toBe("CHECK_FAILED");
    expect((await journal.get(e!.id))!.undoneBy).toBeUndefined();
  });
});

/**
 * Every test in the two package-undo blocks above hand-builds its journal
 * entry with `journal.begin({...})` — a HYPOTHESIS about what `abap_write`
 * records for a package create — then feeds that hand-built entry to
 * `planUndo`/`performUndo`. None of them would notice if `abapCreatePackage`
 * (src/tools/write.ts) ever started recording something different. This
 * block drives the real `abapWrite` create path instead, reads back the
 * entry production actually wrote, and undoes THAT.
 */
describe("undo of a package create, end-to-end through the real abap_write create path", () => {
  const PKG_NAME = "ZMCP_UNDO_PKG_E2E";
  const PKG_URI = "/sap/bc/adt/packages/zmcp_undo_pkg_e2e";
  const PACKAGES = "/sap/bc/adt/packages";
  const SEARCH_PATH = "/sap/bc/adt/repository/informationsystem/search";

  /** Same shape as the hand-built blocks above: a package names itself as its own `packageRef`. */
  const pkgXml = (name = PKG_NAME): string =>
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<pak:package xmlns:pak="http://www.sap.com/adt/packages" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" ` +
    `adtcore:type="DEVC/K" adtcore:description="undo e2e probe">` +
    `<adtcore:packageRef adtcore:name="${name}"/></pak:package>`;

  const pkgRef: FakeObjectRef = { name: PKG_NAME, type: "DEVC/K", uri: PKG_URI, packageName: PKG_NAME };

  const BRIDGE_CLASS = DDIC_BRIDGE_CLASS.deletePackage;
  const BRIDGE_COLLECTION = "/sap/bc/adt/oo/classes";
  const BRIDGE_OBJ_URI = `${BRIDGE_COLLECTION}/${BRIDGE_CLASS.toLowerCase()}`;
  const BRIDGE_SRC_URI = `${BRIDGE_OBJ_URI}/source/main`;

  /** Deploy → activate → run the delete bridge; same shape as the blocks above. */
  const bridgeRoute =
    (classrunLines: string[]) =>
    (r: Recorded): HttpClientResponse | undefined => {
      if (r.url === BRIDGE_OBJ_URI && r.method === "GET" && !r.qs._action) return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === BRIDGE_COLLECTION && r.method === "POST") return resp(200, "", OK_TEXT);
      if (r.url === BRIDGE_OBJ_URI && r.qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
      if (r.url === BRIDGE_OBJ_URI && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === BRIDGE_SRC_URI && r.method === "PUT") return resp(200, "", OK_TEXT);
      if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
      if (r.url.startsWith("/sap/bc/adt/oo/classrun/")) return resp(200, classrunLines.join("\n"), OK_TEXT);
      return undefined;
    };

  /**
   * A single fake package that actually tracks whether it exists, so ONE
   * server answers both halves of the round trip: absent for the create's
   * own GET(404) -> POST /packages, then present for the undo's own probes
   * (resolveWriteTarget's GET, planUndo's repository-search drift check),
   * with the delete bridge layered on top.
   */
  function fakePackageServer(classrunLines: string[]) {
    let exists = false;
    const route = (r: Recorded): HttpClientResponse | undefined => {
      if (r.url === PKG_URI && r.method === "GET") {
        return exists ? resp(200, pkgXml(), OK_XML) : resp(404, NOT_FOUND_XML, OK_XML);
      }
      if (r.url === PACKAGES && r.method === "POST") {
        exists = true;
        return resp(200, "", OK_TEXT);
      }
      if (r.url === SEARCH_PATH) return resp(200, searchResultsXml(exists ? [pkgRef] : []), OK_XML);
      return bridgeRoute(classrunLines)(r);
    };
    return { route };
  }

  it("planUndo/performUndo, fed the entry abap_write actually wrote for a package create, delete it clean", async () => {
    const srv = fakePackageServer(["PKG-EMPTY", "PKG-DELETED", "PKG-GONE"]);
    const { conn, adt } = await connected(srv.route);
    // Root package (no `package`/superPackage given): permitted only by the
    // explicit `*` allowlist entry, same as production requires (see the
    // ROOT-package note abapCreatePackage's own response emits).
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"] });

    const createRes = await abapWrite(
      conn,
      { object: PKG_NAME, type: "DEVC/K", software_component: "LOCAL" } as never,
      60_000,
      gate,
      journal,
    );
    expect(createRes.text).toMatch(/^created: true$/m);

    const entries = await journal.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;

    // Read back what abap_write ACTUALLY wrote — not a hand-built stand-in.
    expect(entry.operation).toBe("create");
    expect(entry.object.type).toBe("DEVC/K");
    expect(entry.object.name).toBe(PKG_NAME);
    expect(entry.object.package).toBe(PKG_NAME); // a package is its own container
    expect(entry.existedBefore).toBe(false);
    expect(entry.beforeCapture).toBe("confirmed-absent");
    expect(entry.irreversible).toBeUndefined();
    // Production sets no after-image for a package create (abapCreatePackage's
    // `begin()`, both the REST and bridge routes, never passes `afterSource`)
    // — unlike the neighbouring hand-built tests above, which pass
    // `afterSource: pkgXml()` explicitly. That is harmless today only because
    // detectDrift's package-specific branch (src/adt/undo.ts) short-circuits
    // before ever consulting `entry.after` — but it is exactly the kind of
    // test-vs-production drift this test exists to catch, so it is pinned
    // here as a positive assertion rather than left implicit.
    expect(entry.after).toBeUndefined();

    adt.calls.length = 0;
    const packageGate = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
    const allow: UndoOptions = {
      assertAllowed: (action, target) =>
        packageGate.authorize(action === "delete" ? "delete" : "write", target),
      gate: packageGate,
    };

    const plan = await planUndo(conn, journal, entry);
    expect(plan.action).toBe("delete");
    expect(plan.undoable).toBe(true);
    expect(plan.blocker).toBeUndefined();
    expect(plan.drift.drifted).toBe(false);

    const res = await performUndo(conn, journal, entry, allow);
    expect(res.performed).toBe(true);
    expect(res.plan.action).toBe("delete");
    // The bridge really ran: its class was written and executed.
    expect(adt.calls.some((c) => c.url === BRIDGE_SRC_URI && c.method === "PUT")).toBe(true);
    expect(adt.calls.some((c) => c.url.startsWith("/sap/bc/adt/oo/classrun/"))).toBe(true);
    // Never the ordinary object path — there is no ADT REST DELETE for a package.
    expect(adt.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(adt.calls.some((c) => c.url === PKG_URI && c.qs._action === "LOCK")).toBe(false);
    expect((await journal.get(entry.id))!.undoneBy).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// undo-of-create on an ACTIVATING properties-shape type (`DOMA/DD`)
// was refused as third-party drift. Nobody edited the object; activation did,
// and `abap_write` recorded the object as it looked one instant before that.
//
// Mechanism, read off CURRENT master (not off any proposed fix):
//
//   - `src/tools/write.ts`'s `settle()` records
//     `afterSource: written.normalisedSource` — for a properties-shape
//     CREATE this is the raw PUT-response body, i.e. the PRE-ACTIVATION XML
//     descriptor (`adtcore:version="inactive"`/`"new"`; see write.ts's own
//     `finalNormalisedSource`/`postWriteSource` logic — a CREATE never sets
//     `postWriteSource`, so `normalisedSource` is exactly the PUT's echo).
//   - The SAME function then re-reads the object POST-activation
//     (`readCurrentSource`, gated on `propertiesShape &&
//     activation?.activated === true`) and used THAT read only for the `etag`
//     value it RETURNS to the caller — pre-fix that happened AFTER the single
//     `settle()` had already written `afterSource`, so the post-activation
//     read never reached the journal.
//   - Activation flips `adtcore:version` inside the XML descriptor (see
//     write.ts's own comment block around the post-activation re-read —
//     "confirmed live" that this flip is real and everything else stays
//     byte-identical).
//     `sourceFingerprint`/`canonicalEtag` (both `contentHash(canonicalSource(s))`
//     — see journal.ts's `sourceFingerprint` doc, which states the two MUST
//     agree) hash the WHOLE descriptor, so the two hashes differ even though
//     no human edited anything.
//   - `detectDrift`'s final "everything else" branch compares
//     `entry.after.fingerprint` (pre-activation, from the journal) against
//     `sourceFingerprint(now.source)` (post-activation, from `probe()`), finds
//     them unequal, and returns `drifted: true` with the "Somebody else edited
//     this object" wording — against an object nobody else edited. `planUndo`
//     then reports `undoable: false`, and `performUndo` (without `force`)
//     throws `ETAG_CONFLICT`.
//
// WHAT THIS BLOCK PINS, AND WHAT IT DOES NOT.
//
// Layer 1 (below) hands `detectDrift`/`planUndo`/`performUndo` an entry whose
// after-image is stale, BUILT BY HAND, and asserts they refuse. Those verdicts
// are CORRECT and permanent: the drift check cannot tell a stale recording from
// a real third-party edit, and it must fail closed when the two hashes differ.
// The fix does not touch that judgement and these assertions do not flip. They
// are kept as the guard that this was not "fixed" by making drift detection
// quieter — deleting the wrong recording is the fix; deleting the alarm is not.
//
// Layer 2 pins the ROOT CAUSE, at `abapWrite`, and DID flip: its one assertion
// was measured `.not.toBe` before the fix and is `.toBe` after it.
//
// The end-to-end proof that undo-of-create now succeeds without `force` is the
// "undo of a create is not refused as third-party drift" block at the
// bottom of this file, which drives the real handler and the real tool.
// ---------------------------------------------------------------------------

describe("a stale after-image is indistinguishable from a third-party edit, and must stay refused", () => {
  const DOMA_NAME = "ZMCP_UNDO_DOMA_221";
  const DOMA_URI = "/sap/bc/adt/ddic/domains/zmcp_undo_doma_221";

  /**
   * SYNTHETIC — hand-written, not a recorded wire capture (no live XML
   * capture exists in test/fixtures). Models the one fact this bug turns on,
   * per write.ts's own comment (line ~1711): activation flips
   * `adtcore:version` inside the descriptor and refreshes `adtcore:changedAt`,
   * leaving everything else byte-identical. `changedAt` is omitted here
   * entirely (rather than varied) to isolate the ONE attribute the bug
   * actually depends on — `version` — from a second one this suite does not
   * need to model to reproduce the bug.
   */
  const domaXml221 = (version: "inactive" | "active"): string =>
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${DOMA_NAME}" ` +
    `adtcore:type="DOMA/DD" adtcore:description="undo probe activation-drift" ` +
    `adtcore:version="${version}">` +
    `<adtcore:packageRef adtcore:name="$TMP"/>` +
    `<doma:typeInformation><doma:datatype>CHAR</doma:datatype>` +
    `<doma:length>10</doma:length></doma:typeInformation>` +
    `</doma:domain>`;

  /** `written.normalisedSource` on current master — the PUT's own echo, PRE-activation. */
  const PRE_ACTIVATION_XML = domaXml221("inactive");
  /** What `readCurrentSource` returns AFTER `activateObject` succeeds. */
  const POST_ACTIVATION_XML = domaXml221("active");

  it("fixture sanity: the two descriptors differ ONLY in adtcore:version, and therefore fingerprint differently", () => {
    // Pins the TEST FIXTURE's own
    // shape, which must stay true regardless of how this defect is fixed.
    expect(PRE_ACTIVATION_XML.replace(/adtcore:version="[a-z]+"/, "")).toBe(
      POST_ACTIVATION_XML.replace(/adtcore:version="[a-z]+"/, ""),
    );
    expect(sourceFingerprint(PRE_ACTIVATION_XML)).not.toBe(sourceFingerprint(POST_ACTIVATION_XML));
  });

  /**
   * Builds the journal entry exactly the way `abap_write`'s `settle()` call
   * does on current master for a DOMA/DD create that activates: `afterSource`
   * is the PRE-activation descriptor, and `activation.activated` is `true` —
   * both drawn from `src/tools/write.ts:1684-1693`.
   */
  async function beginCreateEntry(): Promise<JournalEntry> {
    const e = await journal.begin({
      operation: "create",
      object: { name: DOMA_NAME, type: "DOMA/DD", uri: DOMA_URI, package: "$TMP" },
      existedBefore: false,
      beforeCapture: "confirmed-absent",
      afterSource: PRE_ACTIVATION_XML,
    });
    expect(e).toBeDefined();
    await journal.finish(e!.id, {
      outcome: "succeeded",
      activation: { attempted: true, activated: true },
    });
    return (await journal.get(e!.id))!;
  }

  it("detectDrift reports drift when the journal's after-image is the pre-activation descriptor and the probe is post-activation", async () => {
    const entry = await beginCreateEntry();
    expect(entry.after?.fingerprint).toBe(sourceFingerprint(PRE_ACTIVATION_XML));

    const d = detectDrift(entry, "delete", { exists: true, source: POST_ACTIVATION_XML });

    // PERMANENT, not a characterisation. Given an after-image that does not
    // match the object, `detectDrift` must refuse — it has no way to know the
    // mismatch came from a stale recording rather than from Eclipse. This is
    // fixed by not recording the stale image (see Layer 2), NOT by softening
    // this. If either assertion below ever needs relaxing, check first that
    // the real fix has not been undone somewhere upstream.
    expect(d.drifted).toBe(true);
    expect(d.reason).toContain("Somebody else edited this object");
    // For action === "delete" (undo-of-create), detectDrift's own wording
    // deliberately says "Deleting it", not "Restoring the before-image" —
    // there is no before-image to restore. See undo.ts's comment at the
    // branch that picks this wording.
    expect(d.reason).toContain("Deleting it now would silently destroy their change");
    expect(d.expectedFingerprint).toBe(sourceFingerprint(PRE_ACTIVATION_XML));
    expect(d.actualFingerprint).toBe(sourceFingerprint(POST_ACTIVATION_XML));
  });

  it("planUndo reports such a create as NOT undoable, blocked by the drift verdict", async () => {
    const entry = await beginCreateEntry();
    const { conn } = await connected((r) => {
      if (r.url === DOMA_URI && r.method === "GET") return resp(200, POST_ACTIVATION_XML, OK_XML);
      return resp(200, "", OK_TEXT);
    });

    const plan = await planUndo(conn, journal, entry);

    expect(plan.action).toBe("delete");
    // PERMANENT: a stale-or-genuinely-drifted after-image blocks the plan.
    // That undo-of-create is now performable for an entry `abap_write`
    // actually produced is proved end-to-end at the bottom of this file, on a
    // real entry rather than a hand-built stale one.
    expect(plan.undoable).toBe(false);
    expect(plan.blocker).toMatch(/Somebody else edited this object/);
    expect(plan.drift.drifted).toBe(true);
  });

  it("performUndo without force throws ETAG_CONFLICT on a stale after-image, and sends no DELETE", async () => {
    const entry = await beginCreateEntry();
    const { conn, adt } = await connected((r) => {
      if (r.url === DOMA_URI && r.method === "GET") return resp(200, POST_ACTIVATION_XML, OK_XML);
      if (r.url === DOMA_URI && r.method === "DELETE") return resp(200, "", OK_TEXT);
      return resp(200, "", OK_TEXT);
    });

    const err = await catchErr(performUndo(conn, journal, entry, ALLOW));

    // PERMANENT: `ETAG_CONFLICT` is the right refusal for an object whose
    // recorded image does not match what is on the server. The defect was
    // that `abap_write` manufactured that mismatch out of its own activation;
    // the refusal itself was never the bug.
    expect(err.code).toBe("ETAG_CONFLICT");
    expect(err.message).toMatch(/has CHANGED on the server since abapsmith wrote it/);
    expect(err.message).toMatch(/Somebody else edited this object \(Eclipse, SE38, another agent\)/);
    // True TODAY and true AFTER the fix: a refused undo makes no destructive
    // request — this line is not itself a characterisation of the bug.
    expect(adt.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Layer 2 — the ROOT CAUSE, at the handler. Layer 1 above builds the journal
  // entry BY HAND (`journal.begin`/`journal.finish` called directly) to pin how
  // `detectDrift`/`planUndo`/`performUndo` react to a stale after-image; it does
  // not prove `abap_write` is what PRODUCED that stale after-image. This block
  // drives the real `abapWrite` handler (src/tools/write.ts) end to end —
  // create, lock, PUT, unlock, activate — against a fake ADT server, with a
  // real `Journal` wired in exactly the way `writeVia` above wires one for
  // PROG/P.
  //
  // The invariant it pins is deliberately NOT "the after-image equals this
  // particular XML" (the regression block at the end of this file asserts
  // that). It is the weaker, more durable one that the bug actually violated:
  // the journal's after-image fingerprint and the etag the TOOL RESPONSE
  // reports must describe the SAME moment in the object's life. Before the fix
  // they could not: `settle()` recorded the pre-activation PUT echo, and the
  // etag was computed from a post-activation re-read four lines later that
  // never reached the journal. Two views of one object, one instant apart, and
  // `abap_journal mode=undo` compared against the wrong one.
  //
  // Both sides are `sha256:...` in the SAME format — `entry.after.fingerprint`
  // is `sourceFingerprint(...)`, the etag is `canonicalEtag(...)`, and both are
  // `contentHash(canonicalSource(s))` (journal.ts's `sourceFingerprint` doc
  // states the two MUST agree) — so they compare directly, with no re-hashing.
  describe("Layer 2 — abap_write handler, root cause not symptom", () => {
    const L2_NAME = "ZMCP_UNDO_DOMA_221_L2";
    const L2_URI = "/sap/bc/adt/ddic/domains/zmcp_undo_doma_221_l2";
    const l2Xml = (version: "inactive" | "active"): string =>
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" ` +
      `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${L2_NAME}" ` +
      `adtcore:type="DOMA/DD" adtcore:description="undo probe activation-drift layer 2" ` +
      `adtcore:version="${version}">` +
      `<adtcore:packageRef adtcore:name="$TMP"/>` +
      `<doma:typeInformation><doma:datatype>CHAR</doma:datatype>` +
      `<doma:length>10</doma:length></doma:typeInformation>` +
      `</doma:domain>`;
    const L2_PRE = l2Xml("inactive");
    const L2_POST = l2Xml("active");

    /**
     * A stateful fake DOMA/DD server driving the FULL create+activate
     * choreography `abapWrite` performs for a vendor-creatable
     * properties-shape type (create.vendor: true, capabilities.ts):
     *   GET (404) -> POST .../ddic/domains -> LOCK -> PUT -> UNLOCK
     *   -> [pre-activation content gate: GET] -> POST .../activation
     *   -> [post-activation re-read: GET]
     * `state` tracks what a GET on the object's own URI should answer at
     * each point, modelling the one live-verified fact write.ts's own
     * comment states: activation flips `adtcore:version` and nothing else.
     */
    function l2FakeServer() {
      let state: "absent" | "pre-activation" | "post-activation" = "absent";
      const route = (r: Recorded): HttpClientResponse => {
        if (r.url === L2_URI && r.method === "GET") {
          if (state === "absent") return resp(404, NOT_FOUND_XML, OK_XML);
          return resp(200, state === "pre-activation" ? L2_PRE : L2_POST, OK_XML);
        }
        if (r.url === "/sap/bc/adt/ddic/domains" && r.method === "POST") return resp(201, "", {});
        if (r.qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
        if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
        if (r.url === L2_URI && r.method === "PUT") {
          state = "pre-activation";
          return resp(200, L2_PRE, OK_XML);
        }
        if (r.url.includes("/activation")) {
          state = "post-activation";
          return resp(200, "", OK_TEXT);
        }
        return resp(200, "", OK_TEXT);
      };
      return { route, currentState: () => state };
    }

    /**
     * The measured history of this assertion, kept because it is the evidence
     * that it can actually fail. Written first as `.not.toBe` — the true
     * statement of the ORIGINAL bug — it was run against pre-fix
     * `src/tools/write.ts` and passed, then re-run against the fixed handler
     * and failed with the two hashes identical:
     *
     *   AssertionError: expected 'sha256:77042fba1c04ab…' not to be
     *   'sha256:77042fba1c04ab…' // Object.is equality
     *
     * That is the characterisation-to-regression flip, done the honest way
     * round: the wrong expectation was pinned and observed to hold BEFORE the
     * fix, and only then inverted. It is `.toBe` below because the fix landed,
     * not because the fix was assumed.
     */
    it("root cause: the journal's after-image and the response etag describe the same moment", async () => {
      const srv = l2FakeServer();
      const { conn } = await connected(srv.route);

      const res = await abapWrite(
        conn,
        { object: L2_NAME, type: "DOMA/DD", package: "$TMP", source: L2_PRE } as never,
        60_000,
        openGate(),
        journal,
      );

      // Sanity: the write actually activated, through the real handler.
      expect(res.text).toMatch(/^changed: true$/m);
      const entry = (await journal.list())[0]!;
      expect(entry.operation).toBe("create");
      expect(entry.activation?.activated).toBe(true);

      const etagMatch = res.text.match(/^etag: (\S+)$/m);
      expect(etagMatch).toBeTruthy();
      const responseEtag = etagMatch![1];

      // The whole of the defect in one line. Before the fix these disagreed by
      // construction: the after-image was fingerprinted from the PRE-activation
      // PUT echo and the etag from a POST-activation re-read that never reached
      // the journal, so every later `abap_journal mode=undo` compared a probe of
      // the live (activated) object against a recording of the object as it was
      // one instant earlier, and called the difference somebody else's edit.
      //
      // One read now feeds both consumers, so they agree. If this ever fails
      // with two different hashes again, undo-of-create is refused again.
      expect(entry.after?.fingerprint).toBe(responseEtag);
    });
  });
});

// ---------------------------------------------------------------------------
// REGRESSION — end-to-end: `abap_write` creates it, `abap_journal
// mode=undo` must take it away again WITHOUT `force`.
//
// The characterisation block above pins the DOWNSTREAM half: given a journal
// entry whose after-image is the pre-activation descriptor, `detectDrift`
// correctly shouts. That half is load-bearing and is deliberately NOT changed
// by the fix — a stale after-image SHOULD look like drift, because the check
// cannot tell a stale recording from a real third-party edit.
//
// The fix is UPSTREAM, in `src/tools/write.ts`: stop recording the stale image
// in the first place. So the regression test has to be end-to-end, through the
// real `abapWrite` against a server that actually activates, or it tests the
// wrong half and passes either way.
//
// BOTH ARMS are asserted, on purpose. A one-sided test (only DOMA) would pass
// for a fix that re-fingerprints every write unconditionally and thereby breaks
// the source-shape case that was already correct. `PROG/P` is the control: it
// activates too, but its content hash is over bare source text that activation
// does not rewrite, so it must undo clean BOTH before and after this fix, and
// must not acquire an extra request.
// ---------------------------------------------------------------------------

const RDOMA = "ZMCP_UNDO_RDOMA";
const RDOMA_URI = "/sap/bc/adt/ddic/domains/zmcp_undo_rdoma";

/**
 * The one fact this defect turns on, as a fake server: a properties-shape type whose
 * CONTENT IS ITS DESCRIPTOR, where activation rewrites that descriptor.
 *
 * `adtcore:version` goes `inactive` -> `active` on activation. Live-verified
 * (see the comment block in `src/tools/write.ts` around the post-activation
 * re-read): the flip is real, everything else stays byte-identical, and the
 * post-activation state is stable. SYNTHETIC XML — hand-written, not a
 * recorded wire capture; it models that one attribute and nothing else.
 */
const rdomaXml = (version: "inactive" | "active", datatype = "CHAR"): string =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${RDOMA}" ` +
  `adtcore:type="DOMA/DD" adtcore:description="undo regression activation-drift" ` +
  `adtcore:version="${version}">` +
  `<adtcore:packageRef adtcore:name="$TMP"/>` +
  `<doma:content><doma:typeInformation><doma:datatype>${datatype}</doma:datatype>` +
  `<doma:length>10</doma:length></doma:typeInformation></doma:content>` +
  `</doma:domain>`;

/**
 * A properties-shape server that ACTIVATES. `state.doc` is the single
 * resource: the resolution GET, the content GET and the PUT all address the
 * object URI, because for this shape the descriptor IS the content. The
 * activation POST rewrites it, which is the whole mechanism.
 *
 * `${RDOMA_URI}/source/main` is deliberately unrouted and returns 500 — a
 * properties-shape write or probe that ever reached for it would be a real
 * defect (that resource 404s on the live system), and this makes it loud.
 */
function fakeActivatingProperties() {
  const state: { doc?: string; activations: number } = { doc: undefined, activations: 0 };
  const route = (r: Recorded): HttpClientResponse => {
    if (r.url === `${RDOMA_URI}/source/main`) return resp(500, "source/main is not this shape", OK_TEXT);
    if (r.url.includes("/activation")) {
      state.activations += 1;
      if (state.doc) state.doc = state.doc.replace('adtcore:version="inactive"', 'adtcore:version="active"');
      return resp(200, "", OK_TEXT);
    }
    if (r.url.includes("/checkruns")) {
      return resp(200, `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`, OK_XML);
    }
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML, OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === RDOMA_URI && r.method === "GET") {
      return state.doc === undefined
        ? resp(404, NOT_FOUND_XML, OK_XML)
        : resp(200, state.doc, { ...OK_XML, etag: `srv-${state.doc.length}` });
    }
    if (r.url === RDOMA_URI && r.method === "PUT") {
      // A create always writes the INACTIVE form: `writeObject` never
      // activates, so nothing has published it yet at this point.
      state.doc = (r.body ?? "").replace('adtcore:version="active"', 'adtcore:version="inactive"');
      return resp(200, state.doc, OK_XML);
    }
    if (r.url === RDOMA_URI && r.method === "DELETE") {
      state.doc = undefined;
      return resp(200, "", OK_TEXT);
    }
    return resp(200, "", OK_TEXT);
  };
  return { state, route };
}

const writeRdoma = (conn: AbapConnection, source: string) =>
  abapWrite(conn, { object: RDOMA, type: "DOMA/DD", source } as never, 60_000, openGate(), journal);

describe("undo of a create is not refused as third-party drift", () => {
  it("sanity: this fake really does activate, and activation really does change the hash", async () => {
    // If this fails, the rest of the block proves nothing — it would be
    // asserting that undo works on a server where the bug cannot occur.
    const srv = fakeActivatingProperties();
    const { conn } = await connected(srv.route);

    await writeRdoma(conn, rdomaXml("inactive"));

    expect(srv.state.activations).toBe(1);
    expect(srv.state.doc).toBe(rdomaXml("active"));
    expect(sourceFingerprint(rdomaXml("inactive"))).not.toBe(sourceFingerprint(rdomaXml("active")));
  });

  it("records the POST-activation descriptor as the after-image, not the bytes it PUT", async () => {
    // The fix, stated as the single fact it changes. Before it, `after`
    // held the pre-activation form and every later undo compared against it.
    const srv = fakeActivatingProperties();
    const { conn } = await connected(srv.route);

    await writeRdoma(conn, rdomaXml("inactive"));

    const e = (await journal.list())[0]!;
    expect(e.operation).toBe("create");
    expect(e.outcome).toBe("succeeded");
    expect(e.activation?.activated).toBe(true);
    expect(await journal.afterImage(e)).toBe(rdomaXml("active"));
    expect(e.after?.fingerprint).toBe(sourceFingerprint(rdomaXml("active")));
    // The distinction the whole bug lives in.
    expect(e.after?.fingerprint).not.toBe(sourceFingerprint(rdomaXml("inactive")));
  });

  it("plans the undo as an unblocked DELETE with NO drift", async () => {
    const srv = fakeActivatingProperties();
    const { conn } = await connected(srv.route);
    await writeRdoma(conn, rdomaXml("inactive"));
    const create = (await journal.list())[0]!;

    const plan = await planUndo(conn, journal, create);

    expect(plan.action).toBe("delete");
    expect(plan.drift.drifted).toBe(false);
    expect(plan.undoable).toBe(true);
    expect(plan.blocker).toBeUndefined();
    // `abap_write` must have recorded the absence evidence a delete-shaped
    // undo requires — if it had not, `undoable` above would be false for a
    // reason that has nothing to do with this defect.
    expect(create.beforeCapture).toBe("confirmed-absent");
    expect(plan.drift.actualFingerprint).toBe(create.after?.fingerprint);
  });

  it("performs the undo WITHOUT force, and the object is actually gone", async () => {
    const srv = fakeActivatingProperties();
    const { conn, adt } = await connected(srv.route);
    await writeRdoma(conn, rdomaXml("inactive"));
    const create = (await journal.list())[0]!;

    const res = await performUndo(conn, journal, create, ALLOW);

    expect(res.performed).toBe(true);
    expect(res.plan.action).toBe("delete");
    // `force` was never passed. If this ever needs it again, the activation-drift bug is back.
    expect(res.forced).not.toBe(true);
    expect(srv.state.doc).toBeUndefined();
    expect(adt.verbs).toContain("DELETE");
  });

  it("undo through the abap_journal TOOL succeeds and never says ETAG_CONFLICT", async () => {
    // The path the issue reporter actually walked. Asserting on the tool's own
    // text is what pins the user-visible half: a green `detectDrift` that the
    // tool still renders as a conflict would be no fix at all.
    const srv = fakeActivatingProperties();
    const { conn } = await connected(srv.route);
    await writeRdoma(conn, rdomaXml("inactive"));
    const create = (await journal.list())[0]!;

    const out = await abapJournal(
      conn,
      { mode: "undo", entry: create.id } as never,
      60_000,
      journal,
      openGate(),
    );

    expect(out.isError).not.toBe(true);
    expect(out.text).not.toMatch(/ETAG_CONFLICT/);
    expect(out.text).not.toMatch(/Somebody else edited this object/);
    expect(srv.state.doc).toBeUndefined();
  });

  it("CONTROL: the source shape (PROG/P) still undoes clean, and pays no extra request", async () => {
    // The other arm. `PROG/P` activates too, but hashes bare source text,
    // which activation does not rewrite — so it was never affected and must
    // not be "fixed". A guard that fired on every write would show up here as
    // an extra GET of the source after activation.
    const srv = fakeServer(undefined);
    const { conn, adt } = await connected(srv.route);

    await writeVia(conn, V1);
    const create = (await journal.list())[0]!;
    const getsOfSourceAfterActivation = adt.calls
      .slice(adt.calls.findIndex((c) => c.url.includes("/activation")) + 1)
      .filter((c) => c.url === REPORT_SRC && c.method === "GET");
    expect(getsOfSourceAfterActivation).toHaveLength(0);

    expect(create.after?.fingerprint).toBe(sourceFingerprint(asServer(V1)));
    const res = await performUndo(conn, journal, create, ALLOW);
    expect(res.performed).toBe(true);
    expect(res.plan.action).toBe("delete");
    expect(res.plan.drift.drifted).toBe(false);
    expect(srv.state.source).toBeUndefined();
  });

  it("a REAL third-party edit is still caught — the drift check was not weakened", async () => {
    // The refusal this fix must NOT have bought off. Same object, same create,
    // but somebody really does change it after activation.
    const srv = fakeActivatingProperties();
    const { conn } = await connected(srv.route);
    await writeRdoma(conn, rdomaXml("inactive"));
    const create = (await journal.list())[0]!;

    // Eclipse, SE38, another agent — anything that is not abapsmith.
    srv.state.doc = rdomaXml("active", "NUMC");

    const plan = await planUndo(conn, journal, create);
    expect(plan.drift.drifted).toBe(true);
    expect(plan.undoable).toBe(false);

    const err = await catchErr(performUndo(conn, journal, create, ALLOW));
    expect(err.code).toBe("ETAG_CONFLICT");
    expect(err.message).toMatch(/Somebody else edited this object/);
    // Undo of a create DELETES; the wording must describe that, not a restore
    // of a before-image that does not exist.
    expect(err.message).toMatch(/Deleting it now would silently destroy their change/);
    expect(srv.state.doc).toBe(rdomaXml("active", "NUMC")); // nothing was deleted
  });
});
