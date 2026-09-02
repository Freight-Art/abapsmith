/**
 * GOLDEN WIRE TRACES against the UNREFACTORED code.
 *
 * This introduces a session pool fixed at N=1 whose defining requirement is
 * that observable behaviour stays IDENTICAL to today — EXCEPT for the one
 * documented, deliberate change recorded under "Why this trace GREW" below.
 * "Identical" asserted in prose is worthless; these goldens make it falsifiable.
 * The exception is spelled out rather than left implicit precisely so this
 * header cannot go on claiming something the arrays below contradict.
 *
 * Each test drives the REAL `createServer()` from `src/server.ts` over the
 * shared `FakeAdtServer` (test/helpers/fake-adt.ts) and freezes the ORDERED
 * list of `(method, path+query, session-id, stateful-flag)` tuples the tool put
 * on the wire. A trace array that changes IS the failure signal. That is what
 * catches the three things a plain green suite would miss:
 *
 *   1. an EXTRA LOGON — a pool that connects per-checkout adds
 *      `GET /sap/bc/adt/compatibility/graph` + `/discovery` + the T000 probe to
 *      the front of a trace, and no behavioural assertion anywhere else notices.
 *   2. a REORDERED lock/read/write — a pool that acquires its lock outside the
 *      stateful scope, or reads the before-image after locking instead of
 *      before, produces identical tool output and identical journal entries.
 *   3. a STATEFUL-FLAG FLIP — a read that starts riding a stateful session, or
 *      a write whose PUT lands stateless, is invisible to every functional
 *      assertion and is exactly the bug a pool introduces.
 *
 * These MUST be recorded before the refactor. Written afterwards they would
 * merely canonise whatever the refactor did.
 *
 * ## Why this trace GREW — the ONE sanctioned departure from "identical"
 *
 * The two `abap_write` goldens were re-recorded (update 12→13 rows, create
 * 11→12). Exactly one tuple was inserted into each, nothing reordered and
 * nothing removed:
 *
 *     ["GET", "<object>/source/main", "s1", true]
 *
 * sitting between the `checkruns` POST and the `activation` POST.
 *
 * The reason, which anyone changing these rows again must argue against:
 * abapsmith's write lock is released inside `writeObject` (the last statement of
 * its stateful frame) and activation happens afterwards, from the tool layer,
 * outside that frame. ADT activation carries NO version pin — it POSTs the
 * object's name and URI, and SAP activates whichever inactive version is saved
 * at that instant. There is no If-Match on this protocol; the etag abapsmith
 * emits is a CLIENT-SIDE content hash that never travels on the wire. So a
 * second writer that locks, PUTs and unlocks in the unlock→activate window used
 * to get ITS source activated while abapsmith reported success under a hash of
 * OUR source — a lost update, the wrong content live, a fabricated etag, and no
 * error raised. This was reachable with no concurrency configuration at all:
 * `InProcessObjectGate` is in-process, so two abapsmith processes against one SAP
 * system share no gate whatsoever.
 *
 * The inserted GET is `src/tools/write.ts` re-reading the source and comparing
 * `canonicalEtag` against what the write recorded, refusing to activate content
 * it did not write (`ETAG_CONFLICT`, `phase: "pre-activation"`). It costs one
 * GET, only on the path that actually activates, and it holds no lock — note
 * the `true` stateful flag with no surrounding LOCK/UNLOCK pair. Behavioural
 * coverage of the guard itself lives in test/write-toctou.test.ts and
 * test/tools.test.ts; what these goldens add is that the fix is VISIBLE ON THE
 * WIRE, which is the only place a caller could ever have observed the bug.
 *
 * If these rows disappear again, the hole above is open again. That is the bar
 * for re-recording them: not "the trace changed", but a reason that answers
 * the paragraph above.
 *
 * ## Why `assertNoViolations()` is on every test
 *
 * `FakeAdtServer` records a `concurrent-stateful-request` violation whenever a
 * second request arrives on a session that already has one in flight (it then
 * head-of-line blocks it, faithfully). That
 * violation firing is the machine-checkable form of "the serialisation broke".
 * The fake also flags `cross-session-lock-handle` and `unknown-lock-handle`,
 * which is precisely how a pool that hands object A's handle to session B would
 * announce itself.
 *
 * ## The productive-system probe is ROUTED, never allow-listed
 *
 * `connect()` POSTs once to `/sap/bc/adt/datapreview/freestyle` and is
 * fail-closed, so an unanswered probe would write-lock the system and make
 * every mutating golden below a trace of a REFUSAL rather than of the work.
 * {@link systemRoleProbeResponse} answers it with the real captured
 * non-productive bytes, and `client: "001"` gives detection a row to attribute.
 * This file is deliberately absent from `PROBE_ALLOWLIST`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { createServer, type AbapsmithServer } from "../src/server.js";
import { Journal } from "../src/journal.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import {
  FakeAdtServer,
  __resetFakeAdtCounters,
  fakeResponse,
  objectMetadataXml,
  searchResultsXml,
  type FakeRequest,
  type FakeRoute,
} from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------- the trace ---

/** `[method, path-with-query, session-id, stateful-flag]` — the golden tuple. */
type WireTuple = readonly [string, string, string, boolean];

/**
 * Lock handles are minted from a monotonic counter, so their VALUE is an
 * artefact of how many locks ran before. The IDENTITY of the handle is asserted
 * by the fake itself (a wrong one is a `cross-session-lock-handle` violation),
 * so the golden normalises it and stays readable.
 */
function normaliseQuery(qs: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(qs).sort();
  if (keys.length === 0) return "";
  const parts = keys.map((k) => {
    const raw = String(qs[k]);
    const value = k === "lockHandle" ? "<handle>" : raw;
    return `${k}=${value}`;
  });
  return `?${parts.join("&")}`;
}

function tupleOf(r: FakeRequest): WireTuple {
  return [r.method, `${r.path}${normaliseQuery(r.qs)}`, r.sessionId, r.stateful];
}

const trace = (server: FakeAdtServer): WireTuple[] => server.calls.map(tupleOf);

/** Pretty-print a recorded trace as pasteable source, for recording a new golden. */
const _render = (server: FakeAdtServer): string =>
  trace(server)
    .map(([m, p, s, st]) => `    [${JSON.stringify(m)}, ${JSON.stringify(p)}, ${JSON.stringify(s)}, ${st}],`)
    .join("\n");

// ------------------------------------------------------------------ fixtures ---

/**
 * The productive-system probe, answered as a route on the fake itself rather than by
 * wrapping the client: `routeSystemRoleProbe` forwards to the inner fake FIRST,
 * which on `FakeAdtServer` would record an `unrouted-request` violation and
 * blow up `assertNoViolations()` on every test in this file.
 */
const systemRoleRoute: FakeRoute = (r) =>
  r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined;

const cfg = (over: Partial<Config> = {}): Config => ({
  ...ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "hunter2",
    sid: "TST",
    // The productive-system probe reads T000 for THIS client. Fixture 087 carries 000 -> "S"
    // and 001 -> "C", so 001 is provably non-productive.
    client: "001",
  }),
  ...over,
});

/** Writes enabled, confined to $TMP — the shape every mutating golden needs. */
const writableCfg = (over: Partial<Config> = {}): Config =>
  cfg({ readOnly: false, allowPackages: ["$TMP"], ...over });

interface Harness {
  readonly srv: AbapsmithServer;
  readonly client: Client;
  readonly server: FakeAdtServer;
}

interface ToolCallResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

let openHarnesses: Harness[] = [];
let journalDir = "";

/**
 * A REAL on-disk journal in a throwaway directory. Disabling it would be the
 * wrong simplification: `abap_write`'s before-image capture is a journal
 * operation, and switching the journal off would delete requests from the very
 * traces this file exists to freeze.
 */
async function harness(config: Config, server: FakeAdtServer): Promise<Harness> {
  const srv = createServer(config, {
    httpClient: server.client(),
    log: () => {},
    journal: new Journal(
      { dir: journalDir, enabled: true, maxEntries: 100, maxAgeDays: 30 },
      config.sid,
    ),
    breaker: new AuthCircuitBreaker(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "pool-characterization", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);
  const h: Harness = { srv, client, server };
  openHarnesses.push(h);
  return h;
}

async function call(h: Harness, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  return (await h.client.callTool({ name, arguments: args })) as unknown as ToolCallResult;
}

/** A tool call that must have SUCCEEDED — a golden of a failed path is a golden of nothing. */
async function callOk(h: Harness, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  const res = await call(h, name, args);
  if (res.isError) {
    throw new Error(`${name} failed, so its trace proves nothing: ${res.content[0]?.text ?? "(no body)"}`);
  }
  return res;
}

beforeEach(() => {
  __resetFakeAdtCounters();
  openHarnesses = [];
  journalDir = mkdtempSync(join(tmpdir(), "abapsmith-pool-char-"));
});

afterEach(async () => {
  for (const h of openHarnesses) {
    await h.client.close().catch(() => {});
    await h.srv.stop().catch(() => {});
  }
  openHarnesses = [];
  rmSync(journalDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

const CLAS_URI = "/sap/bc/adt/oo/classes/zcl_demo";
const PROG_URI = "/sap/bc/adt/programs/programs/zmcp_demo";

const scaffold = (extra: FakeRoute[] = []) =>
  new FakeAdtServer({
    routes: [systemRoleRoute, ...extra],
    objects: {
      [`${CLAS_URI}/source/main`]:
        "CLASS zcl_demo DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_demo IMPLEMENTATION.\nENDCLASS.\n",
      [`${PROG_URI}/source/main`]: "REPORT zmcp_demo.\nWRITE 'hi'.\n",
    },
    objectMetadata: {
      [CLAS_URI]: objectMetadataXml({ name: "ZCL_DEMO", type: "CLAS/OC", packageName: "$TMP" }),
      [PROG_URI]: objectMetadataXml({ name: "ZMCP_DEMO", type: "PROG/P", packageName: "$TMP" }),
    },
    // No `catchAll` ON PURPOSE (the StrictAdt idiom): an unrouted request throws
    // loudly instead of being absorbed by a generic `<ok/>`. A catch-all is how
    // a golden quietly becomes a trace of a refusal — a metadata GET answered
    // `<ok/>` carries no `adtcore:packageRef`, every mutating tool then fails
    // PACKAGE_UNKNOWN, and the trace freezes the failure path.
  });

/**
 * `resolveObject` only skips the server round trip when the caller forced a
 * `type`; `abap_run` has no `type` parameter at all and `abap_test` is normally
 * called without one, so both go through `/repository/informationsystem/search`
 * — and that search result is the ONLY carrier of the object's package, which
 * the safety gate then judges. Answering it is what makes those two goldens
 * traces of the work rather than of a `PACKAGE_UNKNOWN` refusal.
 */
const searchRoute: FakeRoute = (r) =>
  r.path.endsWith("/repository/informationsystem/search")
    ? fakeResponse(
        200,
        searchResultsXml(
          String(r.qs["query"] ?? "").toUpperCase().startsWith("ZCL_DEMO")
            ? [{ name: "ZCL_DEMO", type: "CLAS/OC", uri: CLAS_URI, packageName: "$TMP" }]
            : String(r.qs["query"] ?? "").toUpperCase().startsWith("ZMCP_DEMO")
              ? [{ name: "ZMCP_DEMO", type: "PROG/P", uri: PROG_URI, packageName: "$TMP" }]
              : [],
        ),
        { "content-type": "application/xml; charset=utf-8" },
      )
    : undefined;

const xml = (body: string): ReturnType<typeof fakeResponse> =>
  fakeResponse(200, body, { "content-type": "application/xml; charset=utf-8" });

/**
 * `POST /sap/bc/adt/cts/transportchecks`, answered LOCAL (`KORRFLAG` empty).
 * $TMP objects need no transport, so this keeps every mutating golden free of
 * the `trCreate` round trip — the transport branch has its own tests, and
 * mixing it in here would make the pool goldens fail for transport reasons.
 */
const transportChecksRoute: FakeRoute = (r) =>
  r.method === "POST" && r.path.endsWith("/cts/transportchecks")
    ? xml(
        `<?xml version="1.0" encoding="utf-8"?>` +
          `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
          `<RESULT>S</RESULT><KORRFLAG/><RECORDING/><REQUESTS/><LOCKS/>` +
          `</DATA></asx:values></asx:abap>`,
      )
    : undefined;

/** A clean syntax check: the empty `chkrun:checkRunReports` envelope. */
const checkrunsRoute: FakeRoute = (r) =>
  r.method === "POST" && r.path.endsWith("/checkruns")
    ? xml(
        `<?xml version="1.0" encoding="utf-8"?>` +
          `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`,
      )
    : undefined;

/**
 * Activation success is a ZERO-BYTE body — the only unambiguous success signal
 * on this endpoint (a non-empty body is `chkl:messages` or `ioc:inactiveObjects`,
 * both of which mean something went wrong).
 */
const activationRoute: FakeRoute = (r) =>
  r.method === "POST" && r.path.endsWith("/activation") ? fakeResponse(200, "") : undefined;

/** `POST /sap/bc/adt/oo/classrun/{CLASS}` — 200 text/plain, raw console output. */
const classrunRoute: FakeRoute = (r) =>
  r.method === "POST" && r.path.includes("/oo/classrun/")
    ? fakeResponse(200, "hello from ZCL_DEMO\n", { "content-type": "text/plain; charset=utf-8" })
    : undefined;

/** `POST /sap/bc/adt/abapunit/testruns` — the "no test classes" run result. */
const testrunsRoute: FakeRoute = (r) =>
  r.method === "POST" && r.path.endsWith("/abapunit/testruns")
    ? xml(
        `<?xml version="1.0" encoding="utf-8"?>` +
          `<aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit"><program><alerts>` +
          `<alert kind="noTestClasses" severity="tolerable"><title>The task definition does not refer to any test</title></alert>` +
          `</alerts></program></aunit:runResult>`,
      )
    : undefined;

/** `GET /sap/bc/adt/cts/transportrequests?targets=false` — one modifiable request. */
const transportListRoute: FakeRoute = (r) =>
  r.method === "GET" && r.path.endsWith("/cts/transportrequests")
    ? xml(
        `<?xml version="1.0" encoding="utf-8"?>` +
          `<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm"><tm:workbench tm:targetuser="TESTUSER">` +
          `<tm:modifiable><tm:request tm:number="TSTK900001" tm:parent="" tm:desc="pool golden" ` +
          `tm:type="K" tm:status="D" tm:owner="TESTUSER" tm:target="" tm:uri="/sap/bc/adt/cts/transportrequests/TSTK900001"/>` +
          `</tm:modifiable></tm:workbench></tm:root>`,
      )
    : undefined;

/**
 * `GET /sap/bc/adt/cts/transportrequests/searchconfiguration/configurations`
 * — one already-saved search configuration. `opList`
 * discovers this before its own list GET and, finding one, reuses it with no
 * authorization needed and no create POST — see `resolveSearchConfigUri` in
 * `src/tools/transport.ts`. The link's `rel` here is
 * `http://www.sap.com/adt/categories/configurations`, not `"self"` — that is
 * genuinely what the plural list response carries on each entry, confirmed
 * live against A4H 2026-08-07 (`test/fixtures/cts/transport-search-configurations-list.xml`).
 * `walkForConfigEntries` matches on the link's `type` attribute instead of
 * `rel`, since `rel` differs between this plural shape and the singular
 * create response (`rel="self"`) while `type` is stable across both.
 */
const transportSearchConfigRoute: FakeRoute = (r) =>
  r.method === "GET" && r.path.endsWith("/cts/transportrequests/searchconfiguration/configurations")
    ? xml(
        `<?xml version="1.0" encoding="utf-8"?>` +
          `<configurations:configurations xmlns:configurations="http://www.sap.com/adt/configurations">` +
          `<configuration:configuration xmlns:configuration="http://www.sap.com/adt/configuration">` +
          `<configuration:properties><configuration:property key="User">TESTUSER</configuration:property>` +
          `</configuration:properties><atom:link xmlns:atom="http://www.w3.org/2005/Atom" ` +
          `href="/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/POOLGOLDEN" ` +
          `rel="http://www.sap.com/adt/categories/configurations" type="application/vnd.sap.adt.configuration.v1+xml"/>` +
          `</configuration:configuration></configurations:configurations>`,
      )
    : undefined;

/**
 * The object the CREATE golden writes must NOT exist. With no `catchAll` on the
 * fake an unrouted request throws loudly, so absence has to be stated: this is
 * the 404 that makes `resolveWriteTarget` report `exists: false`.
 */
const NEW_URI = "/sap/bc/adt/programs/programs/zmcp_new";
const absentObjectRoute: FakeRoute = (r) =>
  r.method === "GET" && r.path === NEW_URI ? fakeResponse(404, "") : undefined;

/** `POST /sap/bc/adt/programs/programs` — object creation answers 200 + empty body. */
const createRoute: FakeRoute = (r) =>
  r.method === "POST" && r.path === "/sap/bc/adt/programs/programs"
    ? fakeResponse(200, "")
    : undefined;

/** Every route a mutating golden needs, in one bundle. */
const writeRoutes: FakeRoute[] = [
  searchRoute,
  transportChecksRoute,
  checkrunsRoute,
  activationRoute,
  absentObjectRoute,
  createRoute,
];

// ------------------------------------------------------------- the goldens ---

describe("golden wire traces (pre-pool baseline)", () => {
  /**
   * `type: "CLAS/OC"` forces `opts.type`, so `resolveObject` takes the
   * "certain" fast path — no type-disambiguation search. Note that
   * path still spends ONE search round trip to recover `packageName` (no ref
   * shape carries it for free — see `lookupPackageName` in
   * `src/adt/resolve.ts`), so this golden is now TWO stateless calls before
   * the source GET, not one. `searchRoute` supplies the packageName the
   * safety gate needs; the golden was zero-search before that fix landed.
   */
  it("abap_read — connect preamble, package lookup, then ONE stateless source GET", async () => {
    const server = scaffold([searchRoute]);
    const h = await harness(cfg(), server);

    await callOk(h, "abap_read", { object: "ZCL_DEMO", type: "CLAS/OC" });

    expect(trace(server)).toEqual([
      ["GET", "/sap/bc/adt/compatibility/graph", "s1", false],
      ["GET", "/sap/bc/adt/discovery", "s1", false],
      ["POST", "/sap/bc/adt/datapreview/freestyle?rowNumber=20", "s1", false],
      ["GET", "/sap/bc/adt/ato/settings", "s1", false],
      [
        "GET",
        "/sap/bc/adt/repository/informationsystem/search?maxResults=25&objectType=CLAS&operation=quickSearch&query=ZCL_DEMO",
        "s1",
        false,
      ],
      ["GET", "/sap/bc/adt/oo/classes/zcl_demo/source/main", "s1", false],
    ]);
    server.assertNoViolations();
  });

  it("abap_search — one stateless quickSearch, no resolution round trip", async () => {
    const server = scaffold([searchRoute]);
    const h = await harness(cfg(), server);

    await callOk(h, "abap_search", { query: "ZCL_DEMO*" });

    expect(trace(server)).toEqual([
      ["GET", "/sap/bc/adt/compatibility/graph", "s1", false],
      ["GET", "/sap/bc/adt/discovery", "s1", false],
      ["POST", "/sap/bc/adt/datapreview/freestyle?rowNumber=20", "s1", false],
      ["GET", "/sap/bc/adt/ato/settings", "s1", false],
      [
        "GET",
        "/sap/bc/adt/repository/informationsystem/search?maxResults=50&operation=quickSearch&query=ZCL_DEMO*",
        "s1",
        false,
      ],
    ]);
    server.assertNoViolations();
  });

  /**
   * THE headline golden. Read it as: the before-image is taken BEFORE the lock,
   * the lock is what turns the session stateful, and the PUT and the UNLOCK both
   * ride that same stateful session. A pool that checks a session out per call
   * cannot reproduce this shape by accident.
   */
  it("abap_write (update) — before-image, then LOCK/GET/PUT/UNLOCK on one stateful session", async () => {
    const server = scaffold(writeRoutes);
    const h = await harness(writableCfg(), server);

    await callOk(h, "abap_write", {
      object: "ZMCP_DEMO",
      type: "PROG/P",
      package: "$TMP",
      source: "REPORT zmcp_demo.\nWRITE 'bye'.\n",
    });

    expect(trace(server)).toEqual([
      ["GET", "/sap/bc/adt/compatibility/graph", "s1", false],
      ["GET", "/sap/bc/adt/discovery", "s1", false],
      ["POST", "/sap/bc/adt/datapreview/freestyle?rowNumber=20", "s1", false],
      ["GET", "/sap/bc/adt/ato/settings", "s1", false],
      // package the gate judges
      ["GET", PROG_URI, "s1", false],
      // before-image, PRE-lock
      [`GET`, `${PROG_URI}/source/main`, "s1", false],
      ["POST", "/sap/bc/adt/cts/transportchecks", "s1", false],
      // The LOCK is the request that CARRIES `x-sap-adt-sessiontype: stateful`;
      // `FakeRequest.stateful` is sampled at dispatch, before its own header can
      // flip the session, so this one is recorded `false` and everything after
      // it `true`. That boundary is the assertion.
      ["POST", `${PROG_URI}?_action=LOCK&accessMode=MODIFY`, "s1", false],
      // post-lock re-read: the TOCTOU / ETAG_CONFLICT check
      ["GET", `${PROG_URI}/source/main`, "s1", true],
      ["PUT", `${PROG_URI}/source/main?lockHandle=<handle>`, "s1", true],
      ["POST", `${PROG_URI}?_action=UNLOCK&lockHandle=<handle>`, "s1", true],
      ["POST", "/sap/bc/adt/checkruns?reporters=abapCheckRun", "s1", true],
      // ↓ RE-RECORDED (was 12 rows, now 13). See "Why this trace GREW" in the
      // file header. This GET is the pre-activation content check: the write
      // lock was released two rows above, ADT activation carries no If-Match
      // and activates whatever inactive version is on the server, so without
      // this read a concurrent writer's source gets activated silently under
      // our etag. It rides the same stateful session and holds no lock.
      // Deleting this row to "restore" the old trace re-opens that hole.
      ["GET", `${PROG_URI}/source/main`, "s1", true],
      ["POST", "/sap/bc/adt/activation?method=activate&preauditRequested=true", "s1", true],
    ]);
    server.assertNoViolations();
  });

  it("abap_write (create) — 404, then create POST inside the stateful block, no before-image", async () => {
    const server = scaffold(writeRoutes);
    const h = await harness(writableCfg(), server);

    await callOk(h, "abap_write", {
      object: "ZMCP_NEW",
      type: "PROG/P",
      package: "$TMP",
      description: "pool golden",
      source: "REPORT zmcp_new.\n",
    });

    expect(trace(server)).toEqual([
      ["GET", "/sap/bc/adt/compatibility/graph", "s1", false],
      ["GET", "/sap/bc/adt/discovery", "s1", false],
      ["POST", "/sap/bc/adt/datapreview/freestyle?rowNumber=20", "s1", false],
      ["GET", "/sap/bc/adt/ato/settings", "s1", false],
      ["GET", NEW_URI, "s1", false],
      ["POST", "/sap/bc/adt/cts/transportchecks", "s1", false],
      ["POST", "/sap/bc/adt/programs/programs", "s1", false],
      ["POST", `${NEW_URI}?_action=LOCK&accessMode=MODIFY`, "s1", true],
      ["PUT", `${NEW_URI}/source/main?lockHandle=<handle>`, "s1", true],
      ["POST", `${NEW_URI}?_action=UNLOCK&lockHandle=<handle>`, "s1", true],
      ["POST", "/sap/bc/adt/checkruns?reporters=abapCheckRun", "s1", true],
      // ↓ RE-RECORDED (was 11 rows, now 12). Same pre-activation content check
      // as the update golden — see the comment there and the file header. Worth
      // noting on the CREATE path specifically: there is no before-image row
      // above (the object 404'd), and this is nevertheless a real read, because
      // the create/PUT and the activation are separated by an UNLOCK just the
      // same. A freshly created object is not exempt from the race.
      ["GET", `${NEW_URI}/source/main`, "s1", true],
      ["POST", "/sap/bc/adt/activation?method=activate&preauditRequested=true", "s1", true],
    ]);
    server.assertNoViolations();
  });

  it("abap_activate — TWO metadata GETs, check before activate, never stateful", async () => {
    const server = scaffold(writeRoutes);
    const h = await harness(writableCfg(), server);

    await callOk(h, "abap_activate", {
      object: "ZMCP_DEMO",
      type: "PROG/P",
      source: "REPORT zmcp_demo.\nWRITE 'hi'.\n",
    });

    expect(trace(server)).toEqual([
      ["GET", "/sap/bc/adt/compatibility/graph", "s1", false],
      ["GET", "/sap/bc/adt/discovery", "s1", false],
      ["POST", "/sap/bc/adt/datapreview/freestyle?rowNumber=20", "s1", false],
      ["GET", "/sap/bc/adt/ato/settings", "s1", false],
      // Two identical metadata GETs, on purpose: `resolveWriteTarget` and then
      // `authorizeMutation`, so the gate judges a package this connection read
      // itself. A pool that memoises resolution would silently drop the second.
      ["GET", PROG_URI, "s1", false],
      ["GET", PROG_URI, "s1", false],
      ["POST", "/sap/bc/adt/checkruns?reporters=abapCheckRun", "s1", false],
      ["POST", "/sap/bc/adt/cts/transportchecks", "s1", false],
      ["POST", "/sap/bc/adt/activation?method=activate&preauditRequested=true", "s1", false],
    ]);
    server.assertNoViolations();
  });

  /**
   * The mid-trace `GET /sap/bc/adt/compatibility/graph` is a deliberate SESSION
   * DROP (`withFreshSession`), not a second logon: a report run against a stale
   * program buffer returns the previous version's output. A pool that reuses one
   * long-lived session and quietly skips the drop would break `abap_run`'s only
   * correctness guarantee and change nothing else observable.
   */
  it("abap_run — search, session drop, classrun, activation check", async () => {
    const server = scaffold([searchRoute, classrunRoute]);
    const h = await harness(writableCfg(), server);

    await callOk(h, "abap_run", { object: "ZCL_DEMO" });

    expect(trace(server)).toEqual([
      ["GET", "/sap/bc/adt/compatibility/graph", "s1", false],
      ["GET", "/sap/bc/adt/discovery", "s1", false],
      ["POST", "/sap/bc/adt/datapreview/freestyle?rowNumber=20", "s1", false],
      ["GET", "/sap/bc/adt/ato/settings", "s1", false],
      [
        "GET",
        "/sap/bc/adt/repository/informationsystem/search?maxResults=25&objectType=CLAS&operation=quickSearch&query=ZCL_DEMO",
        "s1",
        false,
      ],
      ["GET", "/sap/bc/adt/compatibility/graph", "s1", false],
      ["POST", "/sap/bc/adt/oo/classrun/ZCL_DEMO", "s1", false],
      ["GET", CLAS_URI, "s1", false],
    ]);
    server.assertNoViolations();
  });

  it("abap_test — resolve, then ONE stateless testruns POST", async () => {
    const server = scaffold([searchRoute, testrunsRoute]);
    const h = await harness(writableCfg(), server);

    await callOk(h, "abap_test", { object: "ZCL_DEMO" });

    expect(trace(server)).toEqual([
      ["GET", "/sap/bc/adt/compatibility/graph", "s1", false],
      ["GET", "/sap/bc/adt/discovery", "s1", false],
      ["POST", "/sap/bc/adt/datapreview/freestyle?rowNumber=20", "s1", false],
      ["GET", "/sap/bc/adt/ato/settings", "s1", false],
      [
        "GET",
        "/sap/bc/adt/repository/informationsystem/search?maxResults=25&objectType=CLAS&operation=quickSearch&query=ZCL_DEMO",
        "s1",
        false,
      ],
      ["POST", "/sap/bc/adt/abapunit/testruns", "s1", false],
    ]);
    server.assertNoViolations();
  });

  it("abap_transport (list) — discovers and reuses an existing search configuration, then a configUri-scoped CTS GET", async () => {
    // Without a saved CTS search configuration, `list`
    // never sees Modifiable requests — see the warning on `TrListOptions` in
    // `src/adt/transports.ts`, confirmed live against A4H. `opList` now does
    // a discovery GET first; finding one (`transportSearchConfigRoute`
    // above), it reuses it — no authorization needed, no create POST — and
    // its own list GET is scoped by `configUri`.
    const server = scaffold([transportSearchConfigRoute, transportListRoute]);
    const h = await harness(writableCfg(), server);

    await callOk(h, "abap_transport", { operation: "list" });

    expect(trace(server)).toEqual([
      ["GET", "/sap/bc/adt/compatibility/graph", "s1", false],
      ["GET", "/sap/bc/adt/discovery", "s1", false],
      ["POST", "/sap/bc/adt/datapreview/freestyle?rowNumber=20", "s1", false],
      ["GET", "/sap/bc/adt/ato/settings", "s1", false],
      ["GET", "/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations", "s1", false],
      [
        "GET",
        "/sap/bc/adt/cts/transportrequests?configUri=/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/POOLGOLDEN&targets=false",
        "s1",
        false,
      ],
    ]);
    server.assertNoViolations();
  });

  /**
   * `abap_journal mode=list` reads the local store and MUST NOT connect at all —
   * it is the tool you reach for when the system is down. A pool that eagerly
   * warms a session on server start would put the four-request connect preamble
   * in front of this empty trace, and nothing else would notice.
   */
  it("abap_journal (list) — ZERO requests, not even a logon", async () => {
    const server = scaffold();
    const h = await harness(cfg(), server);

    await callOk(h, "abap_journal", { mode: "list" });

    expect(trace(server)).toEqual([]);
    server.assertNoViolations();
  });

  /**
   * The connect preamble is paid ONCE per process, not once per tool call
   * (`connectPromise` in server.ts). Two tool calls on one server therefore
   * share a single logon — the single most likely thing a session pool breaks,
   * and the one a per-tool golden above cannot see.
   */
  it("two tool calls on one server share ONE logon and ONE session", async () => {
    const server = scaffold([searchRoute]);
    const h = await harness(cfg(), server);

    await callOk(h, "abap_read", { object: "ZCL_DEMO", type: "CLAS/OC" });
    await callOk(h, "abap_search", { query: "ZCL_DEMO*" });

    expect(trace(server)).toEqual([
      ["GET", "/sap/bc/adt/compatibility/graph", "s1", false],
      ["GET", "/sap/bc/adt/discovery", "s1", false],
      ["POST", "/sap/bc/adt/datapreview/freestyle?rowNumber=20", "s1", false],
      ["GET", "/sap/bc/adt/ato/settings", "s1", false],
      // The "certain" fast path spends one search round
      // trip to recover `packageName` (see the golden above).
      [
        "GET",
        "/sap/bc/adt/repository/informationsystem/search?maxResults=25&objectType=CLAS&operation=quickSearch&query=ZCL_DEMO",
        "s1",
        false,
      ],
      ["GET", "/sap/bc/adt/oo/classes/zcl_demo/source/main", "s1", false],
      [
        "GET",
        "/sap/bc/adt/repository/informationsystem/search?maxResults=50&operation=quickSearch&query=ZCL_DEMO*",
        "s1",
        false,
      ],
    ]);
    server.assertNoViolations();
  });
});
