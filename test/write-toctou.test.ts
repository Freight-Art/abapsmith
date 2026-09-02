/**
 * The post-lock re-read.
 *
 * `writeObject`'s pre-lock GET and `deleteObject`'s pre-delete GET are
 * both taken across an OPEN window: the transport pre-flight, the journal
 * hook and — until this phase — the enqueue itself all sit between "read the
 * bytes" and "the object cannot move any more". A writer who lands in that
 * window used to get silently clobbered by the PUT (or destroyed by the
 * DELETE), and the before-image recorded for undo would describe a state
 * that was already stale by the time it was written down.
 *
 * These tests pin the fix: an unconditional re-read taken the moment the
 * lock is held, compared against the pre-lock baseline, with a refusal (and
 * an explicit unlock) on any mismatch — and the before-image/`previousSource`
 * now sourced from those post-lock bytes rather than the pre-lock ones.
 *
 * Offline only, exactly like test/write.test.ts (this file's template): a
 * fake `HttpClient` is injected through `ConnectionOptions.httpClient` and
 * nothing here touches a real SAP system. Conventions (the `FakeAdt` fake,
 * `cfg()`, `baseRoute()`, `objectMetaRoute()`, `connected()`, `catchErr()`,
 * the fixtures) are copied in verbatim from that file rather than imported,
 * to keep this file's scope isolated — do not let the two drift on
 * anything both need without noticing.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { canonicalSource, contentHash } from "../src/compact.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { authorizeMutation, deleteObject, writeObject, type WriteTarget } from "../src/adt/write.js";
import { abapWrite } from "../src/tools/write.js";
import { SafetyGate } from "../src/safety.js";
import { writeEnhancementDescription } from "../src/adt/enhancement-write.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Copied from test/write.test.ts — see that file for the full rationale on
// each piece. Only what this file actually uses is included.
// ---------------------------------------------------------------------------


/** Real A4H discovery capture — see test/enhancement-write.test.ts's
 *  copy of this same constant for why the enhancement-path tests below need it:
 *  `writeEnhancementDescription` now gates on `conn.discovery.assertEnhancementCapable`. */
const ENH_FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement");
const DISCOVERY_ENHANCEMENTS_XML = readFileSync(join(ENH_FIXTURES_DIR, "discovery-enhancements.xml"), "utf8");

const REPORT = "ZMCP_TEST_REP";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_test_rep";
const REPORT_SRC = `${REPORT_URI}/source/main`;

const SOURCE_A = "REPORT zmcp_test_rep.\nWRITE: / 'a'.\n";
const SOURCE_B = "REPORT zmcp_test_rep.\nWRITE: / 'b'.\n";
/** The server normalises LF to CRLF on read-back. */
const SOURCE_A_CRLF = SOURCE_A.replace(/\n/g, "\r\n");

/**
 * The etag abapsmith emits — a content hash of the CANONICAL source. See
 * `canonicalEtag` in src/adt/write.ts for the production spelling this
 * mirrors; kept as a literal formula here (not imported) for the same
 * impl-compares-to-impl reason test/write.test.ts's copy exists for.
 */
const etagOf = (s: string): string => contentHash(canonicalSource(s));

const LOCK_XML = (handle = "H1", isLocal = "X", corrNr = "") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>${isLocal}</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">${REPORT} does not exist</message><properties/></exc:exception>`;

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
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
/*
 * `DATAPREVIEW_XML` and `T000_NONPRODUCTIVE` are imported from
 * ./helpers/system-role-fake.js — the two facts they carry are unchanged:
 *
 *  - The 406 Accept trap is real: T000 only answers
 *    `application/vnd.sap.adt.datapreview.table.v1+xml`.
 *  - `T000_NONPRODUCTIVE` is the real 200 capture of
 *    `SELECT mandt, cccategory, cccoractiv FROM t000` (fixture 087): client 000
 *    → "S", client 001 → "C". `cfg()` below logs on as client 001, so the fake
 *    system is provably NON-productive — a precondition for every test here
 *    that expects a lock, a PUT or a DELETE to happen at all.
 */

/**
 * `GET {objectUri}` with `Accept: application/*` — the metadata document
 * `resolveWriteTarget` reads the object's REAL package off. Every
 * write and every delete opens with this request.
 */
const OBJECT_XML = (name: string, type: string, packageName = "$TMP"): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
  `adtcore:name="${name}" adtcore:type="${type}">` +
  `<adtcore:packageRef adtcore:name="${packageName}"/>` +
  `</adtcore:objectMetadata>`;

/** A route may decline; the composition below decides what an unrouted call means. */
type Route = (r: Recorded) => HttpClientResponse | undefined;

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: Route) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const qs = (o.qs ?? {}) as Record<string, string>;
    const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
    const rec: Recorded = { label, method, url: o.url, qs, body: o.body };
    this.calls.push(rec);
    const res = this.route(rec);
    // Loud on purpose. A catch-all `resp(200, "ok")` is what let this fake rot
    // silently while production grew a request it never answered — precisely
    // what this file needs to prove ABSENCE of (no post-lock GET on create, no
    // PUT/DELETE on a post-lock conflict).
    if (!res) throw new Error(`FakeAdt: unrouted request ${label}`);
    return res;
  }
  get labels(): string[] {
    return this.calls.map((c) => c.label);
  }
  get verbs(): string[] {
    return this.calls.map((c) => (c.qs._action ? c.qs._action : c.method));
  }
}

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    // The logon client the fail-closed role detection attributes a T000 row to.
    // Without it the system cannot be PROVEN non-productive and every write is
    // refused with SAFETY_DENIED, whatever ABAP_ALLOW_WRITE says.
    client: "001",
    readOnly: false, // what ABAP_ALLOW_WRITE sets
  });

/** Everything `connect()` needs, including the T000 probe; anything else falls through. */
function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, DISCOVERY_ENHANCEMENTS_XML, OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle"))
    return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

/**
 * The resolution GET, for the tests that are not about resolution.
 *
 * Consulted only AFTER the test's own route has declined, so a test that
 * wants a 404 (the create path) still gets to say so.
 */
function objectMetaRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.method !== "GET" || r.qs._action || r.url.endsWith("/source/main")) return undefined;
  if (r.url === REPORT_URI) return resp(200, OBJECT_XML(REPORT, "PROG/P"), OK_XML);
  return undefined;
}

async function connected(
  route: Route,
  config: Config = cfg(),
): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r) ?? objectMetaRoute(r));
  const conn = new AbapConnection(config, {
    httpClient: adt,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  adt.calls.length = 0;
  return { conn, adt };
}

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

/**
 * `writeObject`/`deleteObject` now require a real gate-minted `AuthorizedTarget`
 * rather than the bare `WriteTarget` literal this
 * file's tests were written against. `allowPackages: ["*"]` matches everything
 * (see `packagePattern` in src/safety.ts) — every object under test here lives
 * in `$TMP` (`OBJECT_XML`'s default), so this never masks an authorization
 * decision; it only gets these TOCTOU/timing tests, which are not ABOUT the
 * gate, past the type. `authorizeMutation` performs its own resolve GET
 * (formerly done inside `writeObject`/`deleteObject` themselves), so the
 * request sequences these tests pin are unchanged — only which function issues
 * the first GET moved.
 */
const DEFAULT_GATE = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
const authWrite = (conn: AbapConnection, target: WriteTarget) =>
  authorizeMutation(conn, DEFAULT_GATE, "write", target);
const authDelete = (conn: AbapConnection, target: WriteTarget) =>
  authorizeMutation(conn, DEFAULT_GATE, "delete", target);

// ---------------------------------------------------------------------------
// This file's own fixtures.
// ---------------------------------------------------------------------------

/** What a concurrent editor left behind during the GET→LOCK window. */
const SOURCE_C = "REPORT zmcp_test_rep.\nWRITE: / 'c'.\n";

/**
 * Canonically IDENTICAL to `SOURCE_A` (same LF-normalised, whitespace-trimmed,
 * trailing-newline-stripped form) but byte-DIFFERENT from `SOURCE_A_CRLF`:
 * LF instead of CRLF, trailing spaces on the last line (stripped by the
 * per-line trim), and three trailing newlines instead of one (all stripped by
 * the trailing-newline rule). See `canonicalSource` in src/compact.ts for the
 * two rules this leans on.
 *
 * Used to prove the post-lock recheck compares CANONICAL etags (so this
 * mutation is allowed through) while the before-image/`previousSource` still
 * come from these exact post-lock bytes, not from the pre-lock ones.
 */
const SOURCE_A_CANON_ALT = "REPORT zmcp_test_rep.\nWRITE: / 'a'.   \n\n\n";

/**
 * The ICM's own dead-session answer — NOT an ADT `exc:exception` envelope at
 * all. Live-verified 2026-08-02 ("passive expiry past
 * `rdisp/plugin_auto_logout`"): a
 * stateful session idled past `rdisp/plugin_auto_logout` (1800s + 120s in the
 * probe) is destroyed, and the next request on the same `sap-contextid`
 * answers `400 Session timed out` with this header — never a parsed envelope,
 * because the ICM answers before the ABAP stack (and so before any
 * `<exc:exception>`) is even reached. By the time this arrives the ADT
 * enqueue the session held is already gone (`ENQSUM rows=0`; a fresh session
 * re-locked the same object in 138 ms) and even UNLOCK on the dead session
 * fails the same way (the dead-session UNLOCK probe) — a stored lock handle is
 * worthless once its session has died.
 */
const ICMENOSESSION_HEADERS = {
  "content-type": "text/html",
  "x-sap-icm-err-id": "ICMENOSESSION",
  "sap-err-id": "ICMENOSESSION",
};
const ICMENOSESSION_BODY =
  "<html><head><title>Application Server Error</title></head>" +
  "<body>Session timed out</body></html>";

// ---------------------------------------------------------------------------

describe("writeObject — post-lock re-read (update path)", () => {
  it("catches an external edit that lands in the GET→LOCK window, with the lock released", async () => {
    // First GET (pre-lock baseline) sees SOURCE_A; second GET (taken
    // the moment the enqueue is held) sees SOURCE_C — a genuinely different
    // object, not a canonicalisation quirk. The write must be refused and the
    // lock it just took must be given back.
    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") {
        sourceReads += 1;
        return resp(200, sourceReads === 1 ? SOURCE_A_CRLF : SOURCE_C, OK_TEXT);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      // Deliberately no PUT route: if the conflict were not caught before the
      // PUT, the fake's loud "unrouted request" throw would fail this test
      // with a plain Error, not the AbapError `catchErr` expects — a stronger
      // proof than asserting `adt.verbs` afterwards.
      return undefined;
    });

    // No `expectEtag` supplied — the post-lock recheck is unconditional and
    // must fire regardless.
    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), { source: SOURCE_B }),
    );

    expect(e.code).toBe("ETAG_CONFLICT");
    expect(e.details.phase).toBe("post-lock");
    expect(e.details.operation).toBe("write");
    expect(e.details.expectedEtag).toBe(etagOf(SOURCE_A));
    expect(e.details.actualEtag).toBe(etagOf(SOURCE_C));
    expect(e.details.actualEtagRaw).toBe(contentHash(SOURCE_C));

    expect(adt.verbs).not.toContain("PUT");
    // The lock WAS taken and WAS released — this is a refusal after an
    // enqueue, not the cheap pre-lock refusal.
    expect(adt.labels).toEqual([
      `GET ${REPORT_URI}`,
      `GET ${REPORT_SRC}`,
      `LOCK ${REPORT_URI}`,
      `GET ${REPORT_SRC}`,
      `UNLOCK ${REPORT_URI}`,
    ]);
  });

  it("still catches it when the caller supplied a matching expectEtag for the pre-lock bytes", async () => {
    // The pre-lock cheap check (step 2) passes — the caller's etag was
    // correct AT THE TIME they read it. The post-lock recheck is a SEPARATE,
    // unconditional gate and must still catch the edit that landed after.
    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") {
        sourceReads += 1;
        return resp(200, sourceReads === 1 ? SOURCE_A_CRLF : SOURCE_C, OK_TEXT);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      return undefined;
    });

    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
        source: SOURCE_B,
        expectEtag: etagOf(SOURCE_A),
      }),
    );

    expect(e.code).toBe("ETAG_CONFLICT");
    expect(e.details.phase).toBe("post-lock");
    expect(e.details.expectedEtag).toBe(etagOf(SOURCE_A));
    expect(e.details.actualEtag).toBe(etagOf(SOURCE_C));
    expect(adt.verbs).not.toContain("PUT");
    // The lock was taken (the cheap check passed) and then released.
    expect(adt.labels).toEqual([
      `GET ${REPORT_URI}`,
      `GET ${REPORT_SRC}`,
      `LOCK ${REPORT_URI}`,
      `GET ${REPORT_SRC}`,
      `UNLOCK ${REPORT_URI}`,
    ]);
  });

  it("sources the before-image and previousSource from the POST-LOCK bytes, not the pre-lock ones", async () => {
    // First GET (pre-lock) sees SOURCE_A_CRLF; second GET (post-lock) sees
    // SOURCE_A_CANON_ALT — canonically the SAME object (so the recheck passes
    // and the write proceeds) but byte-DIFFERENT (so which read the
    // before-image came from is observable). If the before-image were still
    // built from the pre-lock bytes, `onBeforeImage` would see SOURCE_A_CRLF
    // and `previousSource` would too; the post-lock recheck requires the post-lock bytes.
    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") {
        sourceReads += 1;
        return resp(200, sourceReads === 1 ? SOURCE_A_CRLF : SOURCE_A_CANON_ALT, OK_TEXT);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === REPORT_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    });

    let verbsAtHookTime: string[] = [];
    const onBeforeImage = vi.fn(async (img: { source?: string }) => {
      // Captured INSIDE the hook so the snapshot reflects exactly what has
      // gone over the wire so far — proof the hook fires from inside the
      // session, after the lock, not before it.
      verbsAtHookTime = adt.verbs.slice();
      void img;
    });

    const res = await writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
      source: SOURCE_B,
      onBeforeImage,
    });

    // The recheck passed (canonically equal), so the write actually happened.
    expect(res.changed).toBe(true);
    expect(adt.verbs).toContain("PUT");

    expect(onBeforeImage).toHaveBeenCalledTimes(1);
    expect(onBeforeImage.mock.calls[0]![0].source).toBe(SOURCE_A_CANON_ALT);
    expect(res.previousSource).toBe(SOURCE_A_CANON_ALT);
    // The lock was already held by the time the hook fired.
    expect(verbsAtHookTime).toContain("LOCK");
  });

  it("a session that died between LOCK and the re-read propagates as SESSION_DEAD, never collapsed into ETAG_CONFLICT", async () => {
    // Same ~32-min-idle / ICMENOSESSION condition as the delete-path test
    // below (passive expiry past
    // `rdisp/plugin_auto_logout`) — here on `writeObject`'s
    // update path. Its post-lock re-read goes through `readCurrentSource`
    // (write.ts), which THROWS through `translateAdtError` rather than
    // returning a result object, so `SESSION_DEAD` is classified before the
    // etag comparison ever runs and must reach the caller intact — see the
    // production comment at write.ts:1445-1457 ("a SESSION_DEAD propagates
    // intact and never reaches the comparison below").
    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") {
        sourceReads += 1;
        if (sourceReads === 1) return resp(200, SOURCE_A_CRLF, OK_TEXT);
        return resp(400, ICMENOSESSION_BODY, ICMENOSESSION_HEADERS);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      // No UNLOCK route, deliberately (now symmetric with the delete-path
      // test below): `writeObject`'s SESSION_DEAD branch mirrors
      // `deleteObject`'s — it calls `session.forgetLock(t.uri)` instead of
      // `session.unlock(t.uri)`, so no UNLOCK is ever sent on this path. The
      // live capture backs this: the dead session's enqueue is already gone
      // server-side (`ENQSUM rows=0`, and a
      // fresh session re-locked the same object in 138 ms), and UNLOCK on
      // the dead session itself would answer 400/`ICMENOSESSION`
      // (the dead-session UNLOCK probe) — a stored lock handle is worthless once its
      // session has died. `FakeAdt` records a call's label BEFORE consulting
      // the route, so if a regression reintroduced `session.unlock()` here,
      // it would show up in `adt.verbs` below.
      // No PUT route: a dead session must never reach the write.
      return undefined;
    });

    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), { source: SOURCE_B }),
    );

    expect(e.code).toBe("SESSION_DEAD");
    expect(adt.verbs).not.toContain("PUT");
    expect(adt.verbs).not.toContain("UNLOCK");
  });
});

describe("writeObject — the create path pays no extra request", () => {
  it("is GET obj, POST …/programs/programs, LOCK, PUT, UNLOCK — no post-lock GET at all", async () => {
    const { conn, adt } = await connected((r) => {
      // The object URI 404s — it does not exist, so there is no pre-lock
      // source read either (`readCurrentSource`'s
      // `!t.exists` guard). Deliberately NOT routing GET .../source/main: if
      // production paid for a post-lock re-read on create, this fake would
      // throw its loud unrouted-request error instead of silently permitting
      // it.
      if (r.url === REPORT_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === "/sap/bc/adt/programs/programs" && r.method === "POST") return resp(200, "", {});
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === REPORT_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    });

    let verbsAtHookTime: string[] = [];
    const onBeforeImage = vi.fn(async (img: { source?: string }) => {
      verbsAtHookTime = adt.verbs.slice();
      void img;
    });

    const res = await writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
      source: SOURCE_A,
      onBeforeImage,
    });

    expect(res.created).toBe(true);
    expect(adt.labels).toEqual([
      `GET ${REPORT_URI}`,
      "POST /sap/bc/adt/programs/programs",
      `LOCK ${REPORT_URI}`,
      `PUT ${REPORT_SRC}`,
      `UNLOCK ${REPORT_URI}`,
    ]);

    // The create's before-image fires BEFORE the session (and so before the
    // POST), with no source at all — there is nothing to be stale about a
    // brand-new object.
    expect(onBeforeImage).toHaveBeenCalledTimes(1);
    expect(onBeforeImage.mock.calls[0]![0].source).toBeUndefined();
    expect(verbsAtHookTime).not.toContain("POST");
  });
});

describe("writeObject — the pre-lock cheap path is unchanged", () => {
  it("an expectEtag mismatch is refused before any lock, with no post-lock phase on the error", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") return resp(200, SOURCE_A_CRLF, OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === REPORT_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    });

    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
        source: SOURCE_B,
        expectEtag: contentHash("something else entirely"),
      }),
    );

    expect(e.code).toBe("ETAG_CONFLICT");
    // `assertEtagMatches`'s refusal carries no `phase` key at all — that is
    // the one field that distinguishes it from the post-lock refusal (see the
    // production comment at the `phase: "post-lock"` throw site).
    expect(e.details.phase).toBeUndefined();
    // Zero lock requests: the whole point of doing this check before the
    // enqueue is that a mismatch here costs nothing beyond the two GETs.
    expect(adt.verbs.filter((v) => v === "LOCK")).toHaveLength(0);
    expect(adt.verbs).not.toContain("PUT");
  });

  it("a byte-identical (no-op) write costs exactly two requests: no lock, no post-lock GET", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") return resp(200, SOURCE_A_CRLF, OK_TEXT);
      // No LOCK/UNLOCK/PUT routed: a no-op must never reach any of them.
      return undefined;
    });

    const res = await writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
      source: SOURCE_A,
    });

    expect(res.changed).toBe(false);
    expect(res.created).toBe(false);
    // Exactly two requests total: the resolution GET and the one compare-
    // before-write GET. A stray post-lock (or any other) GET would show up
    // here as a third call.
    expect(adt.calls).toHaveLength(2);
    expect(adt.verbs).toEqual(["GET", "GET"]);
  });
});

describe("deleteObject — post-lock re-read", () => {
  it("catches an external edit that lands in the GET→LOCK window: ETAG_CONFLICT, no DELETE sent, lock released", async () => {
    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") {
        sourceReads += 1;
        return resp(200, sourceReads === 1 ? SOURCE_A_CRLF : SOURCE_C, OK_TEXT);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      // No DELETE route: catching this before the DELETE is the whole point.
      return undefined;
    });

    const e = await catchErr(deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: REPORT })));

    expect(e.code).toBe("ETAG_CONFLICT");
    expect(e.details.operation).toBe("delete");
    expect(e.details.phase).toBe("post-lock");
    expect(e.details.expectedEtag).toBe(etagOf(SOURCE_A));
    expect(e.details.actualEtag).toBe(etagOf(SOURCE_C));
    expect(e.details.actualEtagRaw).toBe(contentHash(SOURCE_C));

    expect(adt.verbs).not.toContain("DELETE");
    expect(adt.labels).toEqual([
      `GET ${REPORT_URI}`,
      `GET ${REPORT_SRC}`,
      `LOCK ${REPORT_URI}`,
      `GET ${REPORT_SRC}`,
      `UNLOCK ${REPORT_URI}`,
    ]);
  });

  it("sources the before-image and previousSource from the post-lock bytes on the happy path", async () => {
    let sourceReads = 0;
    // Once the DELETE lands, the post-delete read-back must see a real
    // 404 — otherwise `deleteObject`'s verification can't confirm `deleted:
    // true` and degrades to `"unverified"`.
    let deleted = false;
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") {
        if (deleted) return resp(404, NOT_FOUND_XML, OK_XML);
        sourceReads += 1;
        return resp(200, sourceReads === 1 ? SOURCE_A_CRLF : SOURCE_A_CANON_ALT, OK_TEXT);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.method === "DELETE") {
        deleted = true;
        return resp(200, "", {});
      }
      return undefined;
    });

    let verbsAtHookTime: string[] = [];
    const onBeforeImage = vi.fn(async (img: { source?: string }) => {
      verbsAtHookTime = adt.verbs.slice();
      void img;
    });

    const res = await deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: REPORT }), {
      onBeforeImage,
    });

    expect(res.deleted).toBe(true);
    expect(res.previousSource).toBe(SOURCE_A_CANON_ALT);
    expect(onBeforeImage).toHaveBeenCalledTimes(1);
    expect(onBeforeImage.mock.calls[0]![0].source).toBe(SOURCE_A_CANON_ALT);
    expect(verbsAtHookTime).toContain("LOCK");
    expect(verbsAtHookTime).not.toContain("DELETE");
  });

  it("a session that died between LOCK and the re-read is SESSION_DEAD, sends no DELETE, and — unlike every other post-lock read failure — sends no UNLOCK either", async () => {
    // Live-verified 2026-08-02 (passive expiry
    // past `rdisp/plugin_auto_logout`): a
    // stateful session idled ~32 min (past `rdisp/plugin_auto_logout`, 1800s
    // + 120s in the probe) is destroyed, and the next request on the same
    // `sap-contextid` — here, the post-lock re-read — answers `400` with
    // header `x-sap-icm-err-id: ICMENOSESSION` and an ICM HTML body, not an
    // ADT `exc:exception` envelope. The enqueue the session held is already
    // gone by then (`ENQSUM rows=0`), so this must classify as `SESSION_DEAD`
    // (reconnect and retry), never as the generic `ADT_ERROR`/
    // `ETAG_UNVERIFIABLE` the sibling test below pins for an ordinary
    // unreadable post-lock answer.
    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") {
        sourceReads += 1;
        if (sourceReads === 1) return resp(200, SOURCE_A_CRLF, OK_TEXT);
        return resp(400, ICMENOSESSION_BODY, ICMENOSESSION_HEADERS);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      // No UNLOCK route, deliberately: write.ts's SESSION_DEAD branch calls
      // `session.forgetLock(t.uri)` instead of `session.unlock(t.uri)` — the
      // capture shows the enqueue is already gone and UNLOCK on the dead
      // session would itself fail the same way (`:636-639,656-659`), so this
      // path must never even attempt it. `FakeAdt` records a call's label
      // BEFORE consulting the route, so if a regression reintroduced the
      // UNLOCK, it would show up in `adt.verbs` below even though
      // `unlockAll()`'s swallow-everything `finally` would hide the resulting
      // throw from the test's outcome otherwise.
      // No DELETE route either: a dead session must never reach the DELETE.
      return undefined;
    });

    const e = await catchErr(deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: REPORT })));

    expect(e.code).toBe("SESSION_DEAD");
    expect(e.code).not.toBe("ADT_ERROR");
    expect(e.details.reason).not.toBe("ETAG_UNVERIFIABLE");
    expect(adt.verbs).not.toContain("DELETE");
    expect(adt.verbs).not.toContain("UNLOCK");
    // Exactly four requests: resolve, pre-lock GET, LOCK, the fatal post-lock
    // GET — nothing after it.
    expect(adt.labels).toEqual([
      `GET ${REPORT_URI}`,
      `GET ${REPORT_SRC}`,
      `LOCK ${REPORT_URI}`,
      `GET ${REPORT_SRC}`,
    ]);
  });

  // The narrow control proving the above is a targeted fix, not a broadening
  // of the post-lock refusal in general: an ORDINARY unreadable post-lock
  // answer (a plain 500, no ICM session-death signature) must still refuse
  // exactly as before — ADT_ERROR/ETAG_UNVERIFIABLE, UNLOCK sent, no DELETE.
  // This test already asserted every one of those before the SESSION_DEAD
  // branch above existed; nothing here changed for it.
  it("refuses with ADT_ERROR/ETAG_UNVERIFIABLE when the post-lock source read itself fails, and sends no DELETE", async () => {
    // The pre-lock read succeeds (so there IS a baseline and the call gets as
    // far as taking the lock); the post-lock read 500s. This must not be
    // mistaken for "the object was deleted out from under us" — it is an
    // unreadable answer, which `readCurrentSourceResult` reports as
    // `{ ok: false }` rather than `{ ok: true, source: undefined }`.
    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") {
        sourceReads += 1;
        if (sourceReads === 1) return resp(200, SOURCE_A_CRLF, OK_TEXT);
        return resp(500, "<exc:exception/>", OK_XML);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      // No DELETE route: an unreadable post-lock source must refuse before it.
      return undefined;
    });

    const e = await catchErr(deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: REPORT })));

    expect(e.code).toBe("ADT_ERROR");
    expect(e.details.reason).toBe("ETAG_UNVERIFIABLE");
    expect(e.details.phase).toBe("post-lock");
    expect(adt.verbs).not.toContain("DELETE");
    // The lock taken to attempt the re-read was given back.
    expect(adt.verbs).toContain("UNLOCK");
  });
});

// ---------------------------------------------------------------------------
// The SECOND time-of-check/time-of-use window: unlock → activate
//
// Everything above this line guards the GET→LOCK window inside `writeObject`.
// There is a second window that guard cannot see, and it is wider: the lock is
// released as the last statement of `writeObject`'s stateful frame, and
// activation runs afterwards, from the TOOL layer, outside it. Activation also
// carries no version pin — it POSTs the object's name and URI and SAP activates
// whichever inactive version happens to be saved at that instant. There is no
// If-Match to pin it with; the etag abapsmith emits is a client-side content
// hash and never travels on the wire.
//
// So a second writer that locks, PUTs and unlocks between our UNLOCK and our
// activation gets ITS source activated, while we report success under a hash of
// OUR source — content that exists nowhere on the server. Nothing raised an
// error. This is reachable today with no concurrency configuration at all,
// because `InProcessObjectGate` is in-process: two abapsmith processes against
// one SAP system share no gate whatsoever.
//
// These tests drive the whole tool over the fake wire, because the bug lives in
// the seam between the two layers and neither layer alone can show it.
// ---------------------------------------------------------------------------
describe("abapWrite — pre-activation content gate (unlock → activate window)", () => {
  const gate = (): SafetyGate => new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

  /**
   * Serves a full tool-level write. `sourceReads` counts GETs of the source:
   * #1 is the pre-lock read, #2 the post-lock re-read, #3 the pre-activation
   * re-read this suite is about. `thirdRead` is what the concurrent writer left
   * behind by the time we get to #3.
   */
  function toolServer(thirdRead: string) {
    let sourceReads = 0;
    const puts: string[] = [];
    const route = (r: Recorded): HttpClientResponse | undefined => {
      if (r.url === REPORT_SRC && r.method === "GET") {
        sourceReads += 1;
        return resp(200, sourceReads >= 3 ? thirdRead : SOURCE_A_CRLF, OK_TEXT);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === REPORT_SRC && r.method === "PUT") {
        puts.push(r.body ?? "");
        return resp(200, "", OK_TEXT); // PROG: empty body, no normalisedSource
      }
      if (r.url.includes("/checkruns"))
        return resp(
          200,
          `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`,
          OK_XML,
        );
      if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
      return undefined;
    };
    return { route, puts, reads: () => sourceReads };
  }

  const writeVia = (conn: AbapConnection, source: string) =>
    abapWrite(conn, { object: REPORT, type: "PROG/P", source } as never, 60_000, gate());

  it("activates normally when nobody wrote in the unlock→activate window", async () => {
    // Positive control. If the gate cost every write its activation, the fix
    // would be worse than the bug — so this must stay exactly as it was.
    const srv = toolServer(SOURCE_B);
    const { conn, adt } = await connected(srv.route);

    await writeVia(conn, SOURCE_B);

    expect(srv.puts).toEqual([SOURCE_B]);
    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(true);
    // Exactly one extra GET, paid only on the path that activates.
    expect(srv.reads()).toBe(3);
    // ...and it is the LAST thing before the activation, not somewhere earlier
    // where it could go stale again.
    const idx = adt.calls.findIndex((c) => c.url.includes("/activation"));
    expect(adt.calls[idx - 1]).toMatchObject({ method: "GET", url: REPORT_SRC });
  });

  it("refuses to activate a concurrent writer's source, and never POSTs the activation", async () => {
    // A writes SOURCE_B and unlocks. B locks, writes SOURCE_C, unlocks. A is
    // now about to activate — and would activate SOURCE_C.
    const srv = toolServer(SOURCE_C);
    const { conn, adt } = await connected(srv.route);

    const err = await catchErr(writeVia(conn, SOURCE_B));

    // The whole point: SAP is never asked to activate.
    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(false);
    expect(err.code).toBe("ETAG_CONFLICT");
    expect(err.details.phase).toBe("pre-activation");
    expect(err.message).toContain(REPORT);
    expect(err.message).toMatch(/NOT activated/);
    // The two hashes are the evidence, and they are the real thing — the same
    // `canonicalEtag` the write used, not a second normalisation.
    expect(err.details.expectedEtag).toBe(etagOf(SOURCE_B));
    expect(err.details.actualEtag).toBe(etagOf(SOURCE_C));
    // Our PUT is NOT rolled back and the error has to say so, because a caller
    // that reads "conflict" as "nothing happened" is now wrong.
    expect(err.details).toMatchObject({ written: true, activated: false });
    expect(err.hint).toMatch(/DO NOT simply write again/);
    // Our PUT did land — it is simply no longer the inactive version.
    expect(srv.puts).toEqual([SOURCE_B]);
  });

  /**
   * COST PIN, NOT A TEST OF THE GUARD — stated plainly so nobody later reads it
   * as coverage of the fix. This test PASSED BEFORE the pre-activation gate
   * existed (there was no extra GET to avoid), so it can never have failed for
   * the reason the two tests above fail. What it is worth having for is the
   * opposite direction: it pins that the gate was scoped to the path that
   * activates, and it WILL fail if someone later hoists the re-read out of the
   * `wantActivate && check.ok` branch and charges every write for it.
   */
  it("COST PIN (passes without the guard): activate=false is not charged the extra GET", async () => {
    const srv = toolServer(SOURCE_C);
    const { conn, adt } = await connected(srv.route);

    await abapWrite(
      conn,
      { object: REPORT, type: "PROG/P", source: SOURCE_B, activate: false } as never,
      60_000,
      gate(),
    );

    // Pre-lock + post-lock only. The gate exists to protect an activation; a
    // write that never activates must not be charged for it.
    expect(srv.reads()).toBe(2);
    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `abap_write`'s reported etag for
// `DOMA/DD` matched neither `abap_read`'s etag right after the create nor
// after a genuine content change, even though `previousEtag` chaining (a
// PRIOR `abap_read`'s etag fed back in as the NEXT write's `expect_etag`)
// worked correctly both times. `MSAG/N` — also properties-shape — showed no
// such divergence.
//
// Root cause: `writeObject` never activates (activation runs afterwards, from
// this tool layer, per the describe block above), so `written.etag` is always
// captured from the PRE-activation state. `capabilities.ts` confirms `MSAG/N`
// is the one properties-shape type with `activate: false` ("a message class
// is born ACTIVE ... there is no inactive version for an activation to
// publish") — `DOMA/DD`, `TTYP/DA` and `ENQU/DL` all activate. Activation
// flips `adtcore:version` to `"active"` and refreshes `adtcore:changedAt`,
// and `canonicalEtag` hashes the
// WHOLE XML descriptor for properties-shape types (no separate `/source/main`
// the way `PROG/P`/`CLAS/OC` have), so that flip changes the reported hash —
// which is also why source-shape types, which hash only the bare source text,
// never showed this live even though they activate too (`PROG/P`).
//
// This was NOT the "etag UNCHANGED" verifier being unsound (that comparison
// is entirely pre-activation, read-side vs read-side, and untouched by this
// fix) — it was the `etag` VALUE handed back to the caller going stale
// between being captured and the call actually returning. The fix: one more
// read, after activation, through the same path a caller's own follow-up
// `abap_read` would use — mirroring how the analogous
// UPDATE-only, pre-activation staleness inside `writeObject` itself was fixed.
// ---------------------------------------------------------------------------
describe("abapWrite — post-activation etag re-read (properties-shape types that activate)", () => {
  const gate = (): SafetyGate => new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

  const DOMA_URI = "/sap/bc/adt/ddic/domains/zfixv4_doma";

  /**
   * `adtcore:version` is the field the recon doc says activation flips
   * ("new"/"inactive" → "active"); genuinely different bytes, not a
   * canonicalisation quirk, standing in for whatever real activation
   * actually rewrites (version plus `adtcore:changedAt` live-measured).
   */
  const domaXml = (version: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZFIXV4_DOMA" ` +
    `adtcore:type="DOMA/DD" adtcore:version="${version}" adtcore:description="probe">` +
    `<adtcore:packageRef adtcore:name="$TMP"/>` +
    `<doma:typeInformation><doma:datatype>CHAR</doma:datatype>` +
    `<doma:length>10</doma:length></doma:typeInformation>` +
    `</doma:domain>`;

  it("reports the POST-activation etag, not the PUT-echoed pre-activation one — matching what abap_read would see next", async () => {
    const submitted = domaXml("inactive"); // what the caller PUTs, and what the server holds pre-activation
    const afterActivation = domaXml("active"); // what activation genuinely leaves behind — real, different bytes

    let phase: "before-create" | "written" | "activated" = "before-create";
    const { conn, adt } = await connected((r) => {
      if (r.url === DOMA_URI && r.method === "GET") {
        if (phase === "before-create") return resp(404, NOT_FOUND_XML, OK_XML);
        return resp(200, phase === "activated" ? afterActivation : submitted, OK_XML);
      }
      if (r.url === "/sap/bc/adt/ddic/domains" && r.method === "POST") return resp(201, "", {});
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === DOMA_URI && r.method === "PUT") {
        phase = "written";
        return resp(200, submitted, OK_XML);
      }
      if (r.url.includes("/activation")) {
        phase = "activated";
        return resp(200, "", OK_TEXT);
      }
      return undefined;
    });

    const result = await abapWrite(
      conn,
      { object: "ZFIXV4_DOMA", type: "DOMA/DD", package: "$TMP", source: submitted } as never,
      60_000,
      gate(),
    );

    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(true);
    expect(result.text).toMatch(/created:\s*true/);
    expect(result.text).toMatch(/changed:\s*true/);
    // The whole point: the etag reported is the ACTIVATED state's hash — what
    // the very next `abap_read` would report — not the pre-activation PUT echo.
    // Before this fix, `written.etag` (== `etagOf(submitted)`) was what shipped.
    expect(result.text).toMatch(new RegExp(`etag:\\s*${etagOf(afterActivation)}`));
    expect(etagOf(afterActivation)).not.toBe(etagOf(submitted)); // the fixture actually exercises a real divergence
    expect(result.text).not.toContain(`etag: ${etagOf(submitted)}`);
    // The extra read is the LAST thing before this call returns, after activation.
    const actIdx = adt.calls.findIndex((c) => c.url.includes("/activation"));
    const lastGet = [...adt.calls].reverse().find((c) => c.method === "GET" && c.url === DOMA_URI);
    expect(adt.calls.indexOf(lastGet!)).toBeGreaterThan(actIdx);
  });

  it("COST PIN — MSAG/N (properties-shape, activate:false) is not charged the extra post-activation GET", async () => {
    const MSAG_URI = "/sap/bc/adt/messageclass/zfixv4_msg";
    const msagXml = (n: string): string =>
      `<?xml version="1.0"?><mc:messageClass xmlns:mc="http://www.sap.com/adt/MessageClass" ` +
      `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZFIXV4_MSG" ` +
      `adtcore:type="MSAG/N"><adtcore:packageRef adtcore:name="$TMP"/>` +
      `<mc:messages><mc:message mc:msgno="${n}"/></mc:messages></mc:messageClass>`;
    const before = msagXml("001");
    let current = before;
    let getCount = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === MSAG_URI && r.method === "GET") {
        getCount += 1;
        return resp(200, current, OK_XML);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === MSAG_URI && r.method === "PUT") {
        current = msagXml("002");
        return resp(200, current, OK_XML);
      }
      return undefined;
    });

    const result = await abapWrite(
      conn,
      { object: "ZFIXV4_MSG", type: "MSAG/N", package: "$TMP", source: msagXml("002") } as never,
      60_000,
      gate(),
    );

    expect(result.text).toMatch(/changed:\s*true/);
    expect(adt.calls.some((c) => c.url.includes("/activation"))).toBe(false);
    // Baseline for a properties-shape UPDATE:
    // (1) resolveWriteTarget's existence probe, (2) writeObject's pre-lock
    // readCurrentSource (step 1), (3) the post-lock TOCTOU re-read,
    // (4) the post-write confirmation read (write.ts:2364, gated
    // on `!created && properties shape`) — four requests already, before any
    // post-activation re-read touches the file. The only thing THIS test
    // proves is that the fix adds no fifth: MSAG/N never activates
    // (`activation?.activated === true` is never true for it), so the new
    // post-activation re-read in src/tools/write.ts must not fire.
    expect(getCount).toBe(4);
  });
});

// =============================================================================
// src/adt/enhancement-write.ts — the SAME two invariants proved
// above for writeObject/deleteObject, re-proved for the enhancement write
// choreography. This is the one file in the suite where extending in place
// (rather than a sibling test/enhancement-write-toctou.test.ts) is the right
// call: these two properties are the file's whole reason to exist, and the
// enhancement path shares the fixtures/helpers above (T000_NONPRODUCTIVE,
// LOCK_XML, resp, OK_TEXT/OK_XML, ICMENOSESSION_HEADERS/BODY, catchErr) rather
// than needing its own.
// =============================================================================

/** GET `{objectUri}` with the ENHO/XHH Accept header — real shape, name/package/
 *  masterSystem/description copied verbatim from the embedded PUT request body
 *  in test/fixtures/enhancement/138-put-wholedoc-success.meta.json (the one
 *  enhancement collection with a captured live PUT 200). */
const ENHOXHH_URI = "/sap/bc/adt/enhancements/enhoxhh/ZMCP_ENH_B";
const ENHOXHH_XML =
  `<?xml version="1.0" encoding="utf-8"?><enho:enhancement ` +
  `abapsource:sourceUri="./zmcp_enh_b/source/main" adtcore:masterSystem="A4H" ` +
  `adtcore:name="ZMCP_ENH_B" adtcore:type="ENHO/XHH" adtcore:version="inactive" ` +
  `adtcore:description="ZMCP recon hook impl" adtcore:language="EN" ` +
  `xmlns:enho="http://www.sap.com/adt/enhancements/enho" ` +
  `xmlns:abapsource="http://www.sap.com/adt/abapsource" xmlns:adtcore="http://www.sap.com/adt/core">` +
  `<adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/%24tmp" adtcore:type="DEVC/K" ` +
  `adtcore:name="$TMP" adtcore:description="Temporary Objects (never transported!)"/>` +
  `<enho:contentCommon enho:toolType="HOOK_IMPL"/></enho:enhancement>`;

/** A concurrent editor's version of the same document — genuinely different
 *  bytes (a different description), not a canonicalisation quirk. */
const ENHOXHH_XML_CHANGED = ENHOXHH_XML.replace(
  'adtcore:description="ZMCP recon hook impl"',
  'adtcore:description="someone else changed this"',
);

const enhoxhhGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP"],
    allowEnhancements: true,
    enhanceTargets: "customer",
    originSystems: ["A4H"],
  });
const ENHOXHH_AFFECTS = { name: "ZMCP_BADI_HOST", packageName: "$TMP", masterSystem: "A4H" };

describe("writeEnhancementDescription — post-lock re-read and session-death (enhancement path)", () => {
  it("(a) catches an external edit that lands in the GET→LOCK window: refused ETAG_CONFLICT, lock released, no PUT sent", async () => {
    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") {
        sourceReads += 1;
        return resp(200, sourceReads === 1 ? ENHOXHH_XML : ENHOXHH_XML_CHANGED, OK_XML);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML("EH1", "X"), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      // Deliberately no PUT route: the same "loud unrouted throw beats a
      // trailing assertion" reasoning as the writeObject test above.
      return undefined;
    });

    const e = await catchErr(
      writeEnhancementDescription(
        conn,
        enhoxhhGate(),
        { type: "ENHO/XHH", name: "ZMCP_ENH_B", description: "my own new description" },
        { affects: ENHOXHH_AFFECTS },
      ),
    );

    expect(e.code).toBe("ETAG_CONFLICT");
    expect(e.details.phase).toBe("post-lock");
    expect(adt.verbs).not.toContain("PUT");
    // The lock WAS taken and WAS released — a refusal after an enqueue, not
    // the cheap pre-lock (expectEtag) refusal.
    expect(adt.labels).toEqual([
      `GET ${ENHOXHH_URI}`,
      `LOCK ${ENHOXHH_URI}`,
      `GET ${ENHOXHH_URI}`,
      `UNLOCK ${ENHOXHH_URI}`,
    ]);
  });

  it("(b) a session that died between LOCK and the post-lock reread propagates as SESSION_DEAD, not silently retried, not collapsed into a generic error, and sends NO UNLOCK", async () => {
    // Same ICMENOSESSION signature as the writeObject/deleteObject tests
    // above. Verified directly against
    // src/adt/relock.ts's withRelockRetry for the enhancement path: SESSION_DEAD
    // is not in enhancement-write.ts's own NON_RETRYABLE_CODES set, so it passes
    // relock.ts's first `isRetryable` check and falls into relock's OWN
    // dedicated SESSION_DEAD branch — `session.forgetLock(uri)` then an
    // immediate rethrow, with NO `session.unlock()` call at all (that call is
    // only made on the *retryable-but-not-SESSION_DEAD* branch). This is why
    // the route below has no UNLOCK case: if a regression reintroduced one,
    // `FakeAdt`'s loud unrouted-request throw would surface it as a plain
    // Error, not the AbapError `catchErr` expects.
    let sourceReads = 0;
    const { conn, adt } = await connected((r) => {
      if (r.url === ENHOXHH_URI && r.method === "GET") {
        sourceReads += 1;
        if (sourceReads === 1) return resp(200, ENHOXHH_XML, OK_XML);
        return resp(400, ICMENOSESSION_BODY, ICMENOSESSION_HEADERS);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML("EH2", "X"), OK_XML);
      // No UNLOCK route, no PUT route, deliberately — see comment above.
      return undefined;
    });

    const e = await catchErr(
      writeEnhancementDescription(
        conn,
        enhoxhhGate(),
        { type: "ENHO/XHH", name: "ZMCP_ENH_B", description: "never gets written" },
        { affects: ENHOXHH_AFFECTS },
      ),
    );

    expect(e.code).toBe("SESSION_DEAD");
    expect(adt.verbs).not.toContain("PUT");
    expect(adt.verbs).not.toContain("UNLOCK");
    expect(adt.labels).toEqual([
      `GET ${ENHOXHH_URI}`,
      `LOCK ${ENHOXHH_URI}`,
      `GET ${ENHOXHH_URI}`,
    ]);
  });
});
