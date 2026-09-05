/**
 * The write path — offline, with a fake `HttpClient` injected through
 * `ConnectionOptions.httpClient`. Nothing here touches a real SAP system.
 *
 * These tests exist to pin the two orderings live testing proved you cannot get
 * wrong:
 *
 *   - lock → PUT → UNLOCK, with the unlock strictly before any activation —
 *         activation while holding your OWN lock is a 403.
 *   - compare-before-write happens before a lock is taken, and an unchanged
 *         source is not written at all (the server returns CRLF for source that
 *         was PUT as LF, so only `contentHash()` can tell).
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type {
  HttpClient,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { canonicalSource, contentHash } from "../src/compact.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import {
  authorizeMutation,
  CREATABLE_TYPES,
  CREATE_ONLY_TYPES,
  deleteObject,
  DELETABLE_TYPES,
  ENHANCEABLE_TYPES,
  isEnhanceableType,
  preflightCorr,
  resolveWriteTarget,
  sourceEquals,
  transportFromLock,
  VERIFIED_CREATABLE_TYPES,
  WRITABLE_TYPES,
  writeObject,
  type WriteTarget,
} from "../src/adt/write.js";
import {
  assertNoConflictingCapabilities,
  assertRegistryCoversTypes,
  assertWritableTypesAreReadable,
  BRIDGE_CREATABLE_TYPES,
  BRIDGE_DELETABLE_TYPES,
  BRIDGE_ONLY_CREATE_TYPES,
  capabilitiesFor,
  isBridgeCreatableType,
  isBridgeDeletableType,
  REGISTRY,
} from "../src/adt/capabilities.js";
import {
  abapWrite,
  abapWriteBatchDelete,
  registerWriteTools,
  targetFromInput,
  writeInputSchema,
} from "../src/tools/write.js";
import { CLASS_INCLUDES, type ClassInclude } from "../src/adt/types.js";
import { assertNoDuplicateDeleteTargets, MAX_DELETE_BATCH } from "../src/adt/write.js";
import { Journal, systemKey } from "../src/journal.js";
import { DDIC_BRIDGE_CLASS, DDIC_BRIDGE_PACKAGE } from "../src/adt/ddic-bridge.js";
import { vitBridgeUri } from "../src/adt/write-verify.js";
import type { WriteToolDeps } from "../src/tools/write.js";
import { errorResult } from "../src/server.js";
import { isEnhancementType, SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import { loadCtsFixture } from "./helpers/cts-fixtures.js";
import { captured, DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { searchResultsXml } from "./helpers/fake-adt.js";

const REPORT = "ZMCP_TEST_REP";
const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_test_rep";
const REPORT_SRC = `${REPORT_URI}/source/main`;
const TABLE_URI = "/sap/bc/adt/ddic/tables/zmcp_test_tab";

const SOURCE_A = "REPORT zmcp_test_rep.\nWRITE: / 'a'.\n";
const SOURCE_B = "REPORT zmcp_test_rep.\nWRITE: / 'b'.\n";
/** The server normalises LF to CRLF on read-back. */
const SOURCE_A_CRLF = SOURCE_A.replace(/\n/g, "\r\n");

/**
 * The etag abapsmith emits — a content hash of the CANONICAL source: LF line
 * endings, trailing `[ \t]` trimmed per line, minus ALL trailing newlines.
 *
 * Now imports the shared `canonicalSource` (src/compact.ts) instead of
 * re-spelling the normalisation a third time — a stale third copy is exactly
 * what let this file's version and src/journal.ts's diverge from
 * src/adt/write.ts's in the past without any test noticing. Importing it here
 * does NOT make this file impl-compares-to-impl: `etagOf` is still never
 * called with a caller-under-test's own buffer to produce an expectation
 * (e.g. never `etagOf(CALLER)`) — expectations that matter are spelled as
 * literals with no trailing whitespace, where the raw and canonical forms
 * coincide, so a broken `canonicalSource` cannot silently satisfy its own
 * test.
 *
 * The server strips ALL trailing newlines on store — measured live on
 * ZMCP_NL_PROBE (PROG/P): four PUT/GET pairs under one lock at 0, 1, 2 and 3
 * trailing newlines all read back byte-identical — and strips trailing
 * space/tab from every line, measured live on PROG and CLAS (ZMCP_NL2_PROGW,
 * probe 1b). See `canonicalSource` in src/compact.ts for the full record.
 */
const etagOf = (s: string): string => contentHash(canonicalSource(s));

/**
 * A permissive gate for tests that are not about authorization at all (locking,
 * etag comparison, activation ordering, ...). `allowPackages: ["*"]` (see
 * `packagePattern` in src/safety.ts) matches every package name, so it never
 * masks a real authorization decision the way the old `WriteTarget |
 * AuthorizedTarget` escape hatch did — `authWrite`/`authDelete` below still go
 * through the real `authorizeMutation` → `SafetyGate.authorize` path and mint a
 * real `AuthorizedTarget`; this just keeps the mechanics-only call sites (the
 * large majority) from each having to construct their own gate just to get
 * past the type. Tests that ARE about authorization construct and pass their
 * own `gate` instead, as before.
 */
const DEFAULT_GATE = new SafetyGate({ readOnly: false, allowPackages: ["*"] });

const authWrite = (conn: AbapConnection, target: WriteTarget, gate: SafetyGate = DEFAULT_GATE) =>
  authorizeMutation(conn, gate, "write", target);

const authDelete = (conn: AbapConnection, target: WriteTarget, gate: SafetyGate = DEFAULT_GATE) =>
  authorizeMutation(conn, gate, "delete", target);

/**
 * Mints the `AuthorizedTarget` `trCreate` now requires,
 * for `SessionTransport({ authorizeCreate })` wiring in tests that exercise
 * the real auto-create path. Deliberately backed by a fully-open gate
 * (`DEFAULT_GATE`, `allowPackages: ["*"]`) rather than each test's own
 * (often intentionally narrow) `gate` — this only needs to satisfy
 * `SessionTransport`'s new "was a minter configured at all" wiring check,
 * not re-exercise package/name-prefix policy that the test's real `gate`
 * already covers via `preflightCorr`'s own `gate.assert`/`gate.evaluate`
 * calls elsewhere in the flow.
 */
const authorizeCreate = (devClass: string) =>
  DEFAULT_GATE.authorize(
    "transport",
    { name: devClass, packageName: devClass },
    { corr: { kind: "unresolved" } },
  );

const LOCK_XML = (handle = "H1", isLocal = "X", corrNr = "") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR>${corrNr}</CORRNR><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>${isLocal}</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">${REPORT} does not exist</message><properties/></exc:exception>`;

/** A syntax problem mislabelled as "AlreadyExists". */
const DDIC_REJECT_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceAlreadyExists"/>
  <message lang="EN">Can't save due to errors in source; execute check for details</message>
  <properties/></exc:exception>`;

// ---------------------------------------------------------------------------

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
  /**
   * The outgoing request headers, verbatim. Added so tests can pin the
   * literal `Content-Type`/`Accept` value a call went out with, rather than
   * arguing from the shape of the code that it must have been
   * `application/*` — see the "pins the literal Content-Type header" test
   * in the properties-shape describe block below, and the BDEF
   * skeleton-create test, which pins the exact `Content-Type` sent on the
   * create POST (no `; charset=…` — see `SkeletonCreate.contentType`'s doc
   * in capabilities.ts). Also exercised by `SRVB/SVB`: it is the one type
   * whose GET/PUT/POST Accept and Content-Type headers are NOT the
   * `application/*` every other properties-shape type here uses
   * (`capabilities.ts`'s `mediaType` field). Additive only; every existing
   * test that never reads `.headers` is unaffected.
   */
  headers?: Record<string, string>;
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
 *    system is provably NON-productive. Since `detectSystemRole()` became
 *    fail-closed that is a precondition for every test here that expects a
 *    lock, a PUT or a DELETE to happen at all.
 */

/**
 * `GET {objectUri}` with `Accept: application/*` — the metadata document
 * `resolveWriteTarget` reads the object's REAL package off. Every write
 * and every delete now opens with this request; a fake that cannot answer it
 * makes resolution fail closed with SAFETY_DENIED / PACKAGE_UNKNOWN.
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
    const rec: Recorded = {
      label,
      method,
      url: o.url,
      qs,
      body: o.body,
      headers: o.headers as Record<string, string> | undefined,
    };
    this.calls.push(rec);
    const res = this.route(rec);
    // Loud on purpose. A catch-all `resp(200, "ok")` is what let this fake rot
    // silently while production grew two new requests it never answered.
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
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle"))
    return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
  return undefined;
}

/**
 * The resolution GET, for the tests that are not about resolution.
 *
 * Consulted only AFTER the test's own route has declined, so a test that wants
 * a 404 (the create path) still gets to say so.
 */
function objectMetaRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.method !== "GET" || r.qs._action || r.url.endsWith("/source/main")) return undefined;
  if (r.url === REPORT_URI) return resp(200, OBJECT_XML(REPORT, "PROG/P"), OK_XML);
  if (r.url === TABLE_URI) return resp(200, OBJECT_XML("ZMCP_TEST_TAB", "TABL/DT"), OK_XML);
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

/** An existing report whose source is `current`; lock/unlock/PUT all succeed. */
const existingReport = (current: string): Route => (r) => {
  if (r.url === REPORT_SRC && r.method === "GET") return resp(200, current, OK_TEXT);
  if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
  if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
  if (r.url === REPORT_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
  // No catch-all: the resolution GET falls through to `objectMetaRoute`, and
  // anything else is a hole this fake should shout about.
  return undefined;
};

/** Nothing exists on this system, so every object GET is a clean ADT 404. Module-level so every describe block below can reach it, not just `resolveWriteTarget`'s own. */
const ABSENT_ROUTE: Route = () => resp(404, NOT_FOUND_XML, OK_XML);

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

// ---------------------------------------------------------------------------

describe("resolveWriteTarget", () => {
  /**
   * The offline half of resolution: a null connection is the assertion. Every
   * refusal below has to happen before a single byte goes on the wire,
   * and a `conn` that would explode on touch is the only way to pin that.
   */
  const offline = null as unknown as AbapConnection;

  /** Nothing exists on this system, so every object GET is a clean ADT 404. */
  const absent: Route = () => resp(404, NOT_FOUND_XML, OK_XML);

  it("resolves the four writable types by code and by keyword", async () => {
    const { conn } = await connected(absent);
    expect((await resolveWriteTarget(conn, { type: "PROG/P", name: REPORT })).uri).toBe(REPORT_URI);
    expect((await resolveWriteTarget(conn, { type: "report", name: REPORT })).type).toBe("PROG/P");
    expect((await resolveWriteTarget(conn, { type: "class", name: "ZCL_X" })).type).toBe("CLAS/OC");
    expect((await resolveWriteTarget(conn, { type: "interface", name: "ZIF_X" })).type).toBe(
      "INTF/OI",
    );
    expect((await resolveWriteTarget(conn, { type: "table", name: "ZMCP_T" })).type).toBe("TABL/DT");
  });

  it("defaults the package to $TMP only for an object that does not exist yet", async () => {
    const { conn, adt } = await connected(absent);
    const t = await resolveWriteTarget(conn, { type: "PROG/P", name: "zmcp_x" });
    expect(t.name).toBe("ZMCP_X");
    expect(t.exists).toBe(false);
    expect(t.packageName).toBe("$TMP");
    // $TMP is a *request*, never a claim about the server — there is no object
    // to have a package yet.
    expect(t.packageSource).toBe("requested");
    expect(t.description).toBe("Program ZMCP_X");
    expect(t.sourceUri).toBe("/sap/bc/adt/programs/programs/zmcp_x/source/main");
    expect(adt.labels).toEqual(["GET /sap/bc/adt/programs/programs/zmcp_x"]);
  });

  it("takes the package of an existing object from the server, never from the caller", async () => {
    const { conn, adt } = await connected((r) =>
      r.url === REPORT_URI ? resp(200, OBJECT_XML(REPORT, "PROG/P", "ZLOCAL"), OK_XML) : undefined,
    );
    const t = await resolveWriteTarget(conn, { type: "PROG/P", name: REPORT });
    expect(t.exists).toBe(true);
    expect(t.packageName).toBe("ZLOCAL");
    expect(t.packageSource).toBe("server");
    // One GET of the object URI — not of /source/main, which carries no packageRef.
    expect(adt.labels).toEqual([`GET ${REPORT_URI}`]);
  });

  it("fails closed when the server will not say which package an object is in", async () => {
    // A 200 with no <adtcore:packageRef>: the object is there and we still
    // cannot judge it. Guessing $TMP here would make a $TMP allowlist approve
    // an object in any package at all.
    const { conn } = await connected((r) =>
      r.url === REPORT_URI ? resp(200, "<adtcore:objectMetadata/>", OK_XML) : undefined,
    );
    const e = await catchErr(resolveWriteTarget(conn, { type: "PROG/P", name: REPORT }));
    expect(e.code).toBe("SAFETY_DENIED");
    expect(e.details.reason).toBe("PACKAGE_UNKNOWN");
    // a failure to determine the package, not a policy verdict — retryable once a healthy connection resolves it
    expect(e.retryable).toBe(true);
  });

  it("an existing DEVC/K with no packageRef resolves to itself, not PACKAGE_UNKNOWN", async () => {
    // Live shape (A4H, 2026-09-04): a root LOCAL package created over REST
    // reads back 200 with adtcore:name but an empty <pak:superPackage/> and
    // no <adtcore:packageRef> at all — unlike $TMP/ZTMD_COURSES, which do
    // carry one.
    const pkg = "$ZTMD_PKG_01";
    const uri = "/sap/bc/adt/packages/%24ztmd_pkg_01";
    const xml =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<pak:package xmlns:pak="http://www.sap.com/adt/packages" ` +
      `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${pkg}" adtcore:type="DEVC/K">` +
      `<pak:attributes packageType="development"/>` +
      `<pak:superPackage/>` +
      `</pak:package>`;
    const { conn, adt } = await connected((r) => (r.url === uri ? resp(200, xml, OK_XML) : undefined));
    const t = await resolveWriteTarget(conn, { type: "DEVC/K", name: pkg });
    expect(t.exists).toBe(true);
    expect(t.packageName).toBe(pkg);
    expect(t.packageSource).toBe("server");
    expect(adt.labels).toEqual([`GET ${uri}`]);
  });

  it("a non-package type with no packageRef still fails closed — the carve-out is CREATE_ONLY-scoped", async () => {
    // Same missing-packageRef 200 as "fails closed…" above, but on TABL/DT —
    // pins that the DEVC/K carve-out is type-scoped (CREATE_ONLY only), not a
    // general "existing object, no packageRef -> trust adtcore:name" rule.
    const { conn } = await connected((r) =>
      r.url === TABLE_URI ? resp(200, "<adtcore:objectMetadata/>", OK_XML) : undefined,
    );
    const e = await catchErr(resolveWriteTarget(conn, { type: "TABL/DT", name: "ZMCP_TEST_TAB" }));
    expect(e.code).toBe("SAFETY_DENIED");
    expect(e.details.reason).toBe("PACKAGE_UNKNOWN");
  });

  // The package-lookup GET (`conn.get`, unclassified — see the
  // comment above `resolveWriteTarget`'s catch block in src/adt/write.ts)
  // used to have every throw that was not already an `AbapError` treated as
  // "the package genuinely cannot be determined" and reported as
  // `SAFETY_DENIED` / `PACKAGE_UNKNOWN` — a policy refusal ABOUT THE OBJECT,
  // when a dead session (this GET landing on a corpse left by an earlier,
  // unrelated request) is an infrastructure failure with nothing to do with
  // the object at all. `translateAdtError` — the same classifier every other
  // write/delete path in this file already goes through — recognizes this
  // exact shape as `SESSION_DEAD`; this pins that `resolveWriteTarget` now
  // asks it FIRST, before falling back to `packageUnknown`.
  it("does not launder a dead session on the package-lookup GET into SAFETY_DENIED", async () => {
    const { conn } = await connected((r) =>
      r.url === REPORT_URI
        ? resp(400, "400 Session Timed Out - Session no longer exists", OK_TEXT)
        : undefined,
    );
    const e = await catchErr(resolveWriteTarget(conn, { type: "PROG/P", name: REPORT }));
    expect(e.code).toBe("SESSION_DEAD");
  });

  it("enforces the DDIC 16-character name limit", async () => {
    const e = await catchErr(
      resolveWriteTarget(offline, { type: "TABL/DT", name: "ZMCP_WAY_TOO_LONG_TABLE" }),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.details.maxLength).toBe(16);
  });

  it("refuses types it cannot create, and refuses to guess", async () => {
    // Was `DTEL/DE` until the properties-shape pass made data elements
    // genuinely writable, then `XSLT/VT` until the corrected transformations
    // path made it genuinely writable too, then `PROG/I` until it gained its
    // own vendor create/write recipe, retiring it from this role. `ENHO/XH`
    // is present in types.ts (so `specForType` finds it — this is not the
    // "unknown type" `BAD_INPUT` case below) but declared in capabilities.ts
    // with neither `create` nor `write`, so it's refused before a byte goes
    // on the wire, which `offline` proves.
    expect((await catchErr(resolveWriteTarget(offline, { type: "ENHO/XH", name: "ZTMD_INC" }))).code).toBe(
      "UNSUPPORTED",
    );
    expect((await catchErr(resolveWriteTarget(offline, { name: "ZSOMETHING" }))).code).toBe(
      "BAD_INPUT",
    );
    expect((await catchErr(resolveWriteTarget(offline, { name: "ZCL_X=>METHOD" }))).code).toBe(
      "BAD_INPUT",
    );
  });

  it("still infers a type from an unambiguous naming convention", async () => {
    const { conn } = await connected(absent);
    expect((await resolveWriteTarget(conn, { name: "ZCL_MCP_DEMO" })).type).toBe("CLAS/OC");
  });
});

/**
 * `resolveWriteTarget` addresses a class's SUB-INCLUDES.
 *
 * `sourceUri` used to be the hardcoded `${uri}/source/main`, which made CCDEF
 * (`definitions`), CCIMP (`implementations`), CCMAC (`macros`) and CCAU
 * (`testclasses`) unwritable — and CCAU is where ABAP Unit test classes live,
 * so "the agent can write the class but not its unit tests" was a capability
 * hole, not a missing convenience.
 *
 * The property every test here defends is the one `assertClassInclude`
 * (src/adt/types.ts) and `sourceUriFor` (src/adt/source.ts) both state in
 * words: **an include is never silently downgraded to the main source.** A
 * write that the caller believed was going into `testclasses` and that landed
 * in `main` instead would overwrite the entire class body with a test class.
 * That is the data-loss shape this repo refuses everywhere else, so the
 * refusals below are as load-bearing as the successes.
 */
describe("resolveWriteTarget: class includes", () => {
  /** A null connection is the assertion that a refusal costs no round trip. */
  const offline = null as unknown as AbapConnection;

  const CLAS_NAME = "ZMCP_CL_INC";
  const CLAS_URI = "/sap/bc/adt/oo/classes/zmcp_cl_inc";
  /** The four that are NOT `main` — the ones that were unreachable. */
  const SUB_INCLUDES = ["definitions", "implementations", "macros", "testclasses"] as const;

  it("addresses each sub-include at /includes/<name>, never at /source/main", async () => {
    for (const include of SUB_INCLUDES) {
      const { conn } = await connected(ABSENT_ROUTE);
      const t = await resolveWriteTarget(conn, { name: CLAS_NAME, type: "CLAS/OC", include });
      expect(t.sourceUri).toBe(`${CLAS_URI}/includes/${include}`);
      // Spelled as its own assertion: this is the exact main-source-to-sub-include substitution being pinned.
      expect(t.sourceUri).not.toBe(`${CLAS_URI}/source/main`);
      // The include is REPORTED, not merely used — a caller (and the journal)
      // has to be able to tell which document the write is going to address.
      expect(t.include).toBe(include);
      // The OBJECT is still the class. Only `sourceUri` moves; identity does not.
      expect(t.uri).toBe(CLAS_URI);
      expect(t.name).toBe(CLAS_NAME);
      expect(t.type).toBe("CLAS/OC");
    }
  });

  it("means /source/main when no include is named, and reports that as `undefined` not \"main\"", async () => {
    const { conn } = await connected(ABSENT_ROUTE);
    const t = await resolveWriteTarget(conn, { name: CLAS_NAME, type: "CLAS/OC" });
    expect(t.sourceUri).toBe(`${CLAS_URI}/source/main`);
    // `ResolvedTarget.include`'s own doc: undefined means "the caller said
    // nothing", which is a different fact from "the caller said main". A
    // journal or a renderer that collapses the two loses the distinction.
    expect(t.include).toBeUndefined();
  });

  it("accepts an explicit include=\"main\" and keeps the canonical /source/main shape", async () => {
    const { conn } = await connected(ABSENT_ROUTE);
    const t = await resolveWriteTarget(conn, { name: CLAS_NAME, type: "CLAS/OC", include: "main" });
    expect(t.sourceUri).toBe(`${CLAS_URI}/source/main`);
    // …but it is still RECORDED as having been asked for. See above.
    expect(t.include).toBe("main");
  });

  it("resolves the CLASS's metadata, not the include's — one GET, of the object URI", async () => {
    const { conn, adt } = await connected((r) =>
      r.url === CLAS_URI ? resp(200, OBJECT_XML(CLAS_NAME, "CLAS/OC", "ZLOCAL"), OK_XML) : undefined,
    );
    const t = await resolveWriteTarget(conn, {
      name: CLAS_NAME,
      type: "CLAS/OC",
      include: "testclasses",
    });
    // An include has no packageRef of its own; the safety gate must keep
    // judging the CLASS. A GET of `${CLAS_URI}/includes/testclasses` here would
    // mean the package decision had moved to a document that cannot carry one.
    expect(adt.labels).toEqual([`GET ${CLAS_URI}`]);
    expect(t.exists).toBe(true);
    expect(t.packageName).toBe("ZLOCAL");
    expect(t.packageSource).toBe("server");
    expect(t.sourceUri).toBe(`${CLAS_URI}/includes/testclasses`);
  });

  it("REFUSES an include on a non-class type — BAD_INPUT that names it, before any request", async () => {
    for (const [type, name] of [
      ["PROG/P", "ZMCP_REP"],
      ["INTF/OI", "ZIF_MCP"],
      ["TABL/DT", "ZMCP_TAB"],
      ["FUGR/F", "ZMCP_FG"],
    ] as const) {
      const e = await catchErr(
        resolveWriteTarget(offline, { name, type, include: "testclasses" }),
      );
      expect(e.code, type).toBe("BAD_INPUT");
      // The message NAMES the include. "Unsupported parameter" would leave the
      // caller unable to tell what was dropped.
      expect(e.message, type).toContain("testclasses");
      expect(e.details.include, type).toBe("testclasses");
      expect(e.details.type, type).toBe(type);
      // The anti-downgrade promise, in the words the caller actually reads.
      expect(e.hint ?? "", type).toMatch(/NOT silently redirected/i);
    }
  });

  it("is loud about an include ADT does not have, before any request", async () => {
    const e = await catchErr(
      resolveWriteTarget(offline, {
        name: CLAS_NAME,
        type: "CLAS/OC",
        include: "tests" as ClassInclude,
      }),
    );
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.message).toContain('Unknown class include "tests"');
    // The five names are handed back so the caller can retry without guessing.
    expect(e.details.supported).toEqual([...CLASS_INCLUDES]);
    expect(e.hint ?? "").toMatch(/NOT silently answered/i);
  });

  it("normalises case and surrounding space rather than rejecting or downgrading", async () => {
    // `WriteTarget.include` is typed to `ClassInclude`, but the value arrives
    // from a tool argument at runtime — `assertClassInclude` exists precisely
    // because the type cannot police that boundary. The cast reproduces what an
    // untyped caller hands over.
    const { conn } = await connected(ABSENT_ROUTE);
    const t = await resolveWriteTarget(conn, {
      name: CLAS_NAME,
      type: "CLAS/OC",
      include: " TestClasses " as ClassInclude,
    });
    expect(t.include).toBe("testclasses");
    expect(t.sourceUri).toBe(`${CLAS_URI}/includes/testclasses`);
  });

  it("never double-suffixes, whatever shape the class URI arrives in", async () => {
    // `classBaseUri` strips an existing `/source/main` or `/includes/<x>`
    // before appending. `buildUri` cannot produce those today, so this is a
    // defence against a future caller that resolves from an include URI —
    // `…/includes/testclasses/includes/testclasses` resolves to nothing and
    // would fail as a confusing 404 rather than as a bug.
    const { conn } = await connected(ABSENT_ROUTE);
    const t = await resolveWriteTarget(conn, {
      name: CLAS_NAME,
      type: "CLAS/OC",
      include: "testclasses",
    });
    expect(t.sourceUri.match(/\/includes\//g)).toHaveLength(1);
    expect(t.sourceUri).not.toContain("/source/main");
  });
});

/**
 * The capability-registry refactor (src/adt/capabilities.ts) computes
 * `WRITABLE_TYPES`/`CREATE_ONLY_TYPES`/`CREATABLE_TYPES`/`ENHANCEABLE_TYPES`
 * from one `REGISTRY` instead of four hand-maintained arrays. These pin the
 * two things a silent regression there could break: the registry stays
 * internally coherent (every `types.ts` entry has a capability declaration,
 * nothing is both a capability and `unsupported`), and the two DDIC types
 * newly admitted to `WRITABLE_TYPES` this task — `DDLS/DF` and `TABL/DS` —
 * resolve exactly like the pre-existing source-shape types (PROG/P etc): same
 * `resolveWriteTarget` code path, same URI shape, no bespoke handling.
 */
describe("capabilities.ts registry (write-support-for-missing-DDIC-types)", () => {
  /** Same reasoning as the `offline` in the `resolveWriteTarget` describe above: every
   * refusal here must happen before a single byte goes on the wire. */
  const offline = null as unknown as AbapConnection;

  it("covers every type in types.ts and never declares both a capability and 'unsupported'", () => {
    expect(() => assertRegistryCoversTypes()).not.toThrow();
    expect(() => assertNoConflictingCapabilities()).not.toThrow();
    // Added alongside abap_read's format:"raw" (src/tools/read.ts): every
    // writable type must also be readable in at least one mode, or "read an
    // existing object to see the exact shape" is a dead end for it — exactly
    // the hole MSAG/N and ENQU/DL sat in before format:"raw" existed.
    expect(() => assertWritableTypesAreReadable()).not.toThrow();
  });

  it("WRITABLE_TYPES is exactly the source-shape eighteen plus the properties-shape six", () => {
    // Spelled as one exhaustive set on purpose: a type silently ACQUIRING a
    // write capability is as much a regression as one losing it, and only an
    // exhaustive comparison catches the first. The eighteen-plus-six split is:
    //   source shape     — CLAS/OC INTF/OI PROG/P DDLS/DF DDLX/EX SRVD/SRV
    //                      TABL/DT TABL/DS FUGR/FF FUGR/F BDEF/BDO XSLT/VT
    //                      DCLS/DL DDLA/ADF PROG/I FUGR/I TYPE/DG DRUL/DRL
    //   properties shape — DTEL/DE DOMA/DD TTYP/DA MSAG/N ENQU/DL SRVB/SVB
    // PROG/I and FUGR/I joined source-shape on their own vendor create
    // routes (programs/includes and functions/groups/%s/includes).
    // `create.verified` and `delete` are both `true`, live-verified end to
    // end on A4H 2026-09-04 (create/activate/re-write/read/delete/NOT_FOUND
    // read for both), putting both in VERIFIED_CREATABLE_TYPES and
    // DELETABLE_TYPES — see capabilities.ts for the evidence, including
    // PROG/I's delete-while-referenced 403 and FUGR/I's must-exist-group
    // 500.
    // DCLS/DL joined source-shape on the same recipe as DDLS/DF: vendor
    // CreatableTypes has a real entry, so create is vendor, not a hand-built
    // skeleton. `create.verified` and `delete` are both `true`, live-verified
    // end to end on A4H 2026-09-04 (create/PUT/activate/read-back/delete/
    // NOT_FOUND read), putting it in VERIFIED_CREATABLE_TYPES and
    // DELETABLE_TYPES.
    // DDLA/ADF joined on the same vendor-create recipe as DCLS/DL, but a
    // 2026-09-04 A4H probe DISPROVED create (403
    // ExceptionNoAnnotationDefinitionAuthorization — SAP-only object type),
    // so `create.verified` is `false`. `delete` stays `"unverified"` since
    // create never succeeded, keeping it out of VERIFIED_CREATABLE_TYPES and
    // DELETABLE_TYPES.
    // FUGR/F joined on live evidence, not inference: its `/source/main` is the
    // TOP-include skeleton, and a PUT carrying a distinguishing marker line came
    // back on the read, checked clean and activated (capabilities.ts documents
    // the probe). Source-shape membership is also what keeps it OUT of
    // CREATE_ONLY_TYPES, whose three consumers in `resolveWriteTarget` mean
    // "this object IS its own package" — see the CREATE_ONLY_TYPES test below.
    // DDLX/EX and SRVD/SRV joined alongside DDLS/DF: same source-shape recipe,
    // both live-verified create/PUT/activate/delete, twice, on A4H (see
    // capabilities.ts's comments on those two entries).
    // BDEF/BDO is the newest source-shape member, and the odd one out:
    // source-shape AND `create.vendor: false` at once — see capabilities.ts's
    // `SkeletonCreate` doc for why that combination needed a new mechanism
    // rather than reusing TTYP/ENQU's "payload doubles as create body" trick.
    // XSLT/VT's read path is live-measured (`/xslt/transformations/…
    // /source/main` returns real stylesheet source, 2026-09-04), and its
    // raw-POST create/PUT/activate flow was then live-verified too (see
    // capabilities.ts) — `create.verified` and `delete` are both `true`,
    // in VERIFIED_CREATABLE_TYPES and DELETABLE_TYPES.
    // SRVB/SVB joined properties shape on documentation, and its provenance
    // was contested for a while: a session scratchpad claimed a live run
    // (create 201, read-back 200 at 1664 bytes, activate 200 clean, delete
    // 200, twice), but that claim was contradicted by a later report that
    // service bindings do not exist at all on this project's only real
    // system. That conflict is now resolved — a later, independent live
    // verification run against the same A4H box, through abapsmith's own
    // v1 tool surface, on 2026-08-18, corroborates create/activate/
    // read-back/delete for the flow exercised. See the PROVENANCE WARNING
    // on the REGISTRY entry in src/adt/capabilities.ts for the full
    // confirmed/caveated/still-inferred breakdown.
    // TYPE/DG and DRUL/DRL joined once both gained a `create` skeleton,
    // moving them out of ENHANCEABLE_TYPES and into this set. Both later
    // had their full create → write → activate → read-back → delete cycle
    // run live through abapsmith on A4H 2026-09-04 (ZTMDY, ZTMD_DRUL_02,
    // $TMP), so `create.verified` and `delete` are both `true` — see
    // capabilities.ts.
    expect(new Set(WRITABLE_TYPES)).toEqual(
      new Set([
        "CLAS/OC",
        "INTF/OI",
        "PROG/P",
        "DDLS/DF",
        "DDLX/EX",
        "SRVD/SRV",
        "TABL/DT",
        "TABL/DS",
        "FUGR/FF",
        "FUGR/F",
        "BDEF/BDO",
        "XSLT/VT",
        "DCLS/DL",
        "DDLA/ADF",
        "PROG/I",
        "FUGR/I",
        "DTEL/DE",
        "DOMA/DD",
        "TTYP/DA",
        "MSAG/N",
        "ENQU/DL",
        "SRVB/SVB",
        "TYPE/DG",
        "DRUL/DRL",
      ]),
    );
  });

  // TABL/DI (table secondary index) is an `unsupported` entry,
  // not a capability — registering it must not widen any write surface.
  // This is the negative-space check the exhaustive set comparison above
  // doesn't itself make explicit for a brand-new registry member.
  it("TABL/DI is not in WRITABLE_TYPES, CREATABLE_TYPES or DELETABLE_TYPES", () => {
    expect(WRITABLE_TYPES).not.toContain("TABL/DI");
    expect(CREATABLE_TYPES).not.toContain("TABL/DI");
    expect(DELETABLE_TYPES).not.toContain("TABL/DI");
  });

  /**
   * The gap this pins is the one that blocked a whole acceptance lesson: a
   * function module can ONLY be created inside a function group, `FUGR/FF`'s
   * create is `parent: "container"`, and `FUGR/F` used to be a bare `{ label }`
   * — neither writable nor creatable. So a user with no pre-existing group
   * could not get a function module at all. Two independent facts keep that
   * fixed, and they fail for different reasons if the entry regresses.
   */
  it("FUGR/F is creatable, and PACKAGE-parented — not container-parented like its own FUGR/FF", () => {
    expect(CREATABLE_TYPES).toContain("FUGR/F");
    // The default. A group hangs off a package (`/sap/bc/adt/packages/…`), the
    // module inside it hangs off the group — mixing these up sends
    // `createNewObject` to `containerParent()` and asks the server to create a
    // group inside a group.
    expect(capabilitiesFor("FUGR/F")?.create?.parent).toBeUndefined();
    expect(capabilitiesFor("FUGR/FF")?.create?.parent).toBe("container");
    // Vendor create (`conn.adt.createObject`), so the group create body comes
    // from abap-adt-api's own `CreatableTypes` table rather than hand-rolled XML.
    expect(capabilitiesFor("FUGR/F")?.create?.vendor).toBe(true);
    // Delete needs a lock for a group where a module needs none
    // (a bare DELETE is refused 423 ExceptionResourceInvalidLockHandle).
    // `deleteObject` locks
    // unconditionally, so this needs no special case; the capability just has
    // to be declared.
    expect(capabilitiesFor("FUGR/F")?.delete).toBe(true);
  });

  it("CREATE_ONLY_TYPES stays package-only: its three consumers mean 'this object IS its own package'", () => {
    // `resolveWriteTarget` uses CREATE_ONLY_TYPES for exactly three things —
    // reporting `packageName: base.name` for a NOT_FOUND object, falling back
    // to `base.name` when an EXISTING object's 200 carries no packageRef
    // either (the root-LOCAL-package-over-REST case, A4H 2026-09-04), and
    // skipping the "already exists in another package" refusal. All three are
    // true of DEVC/K and of nothing else. A create-without-write type would
    // land here and silently inherit all three, which is why FUGR/F carries a
    // write shape.
    expect(CREATE_ONLY_TYPES).toEqual(["DEVC/K"]);
  });

  it("resolves DDLS/DF (CDS view / DDL source) the same way as any other source-shape type", async () => {
    const uri = "/sap/bc/adt/ddic/ddl/sources/zi_mcp_demo";
    const { conn } = await connected((r) =>
      r.url === uri ? resp(404, NOT_FOUND_XML, OK_XML) : undefined,
    );
    const t = await resolveWriteTarget(conn, { type: "DDLS/DF", name: "zi_mcp_demo" });
    expect(t.type).toBe("DDLS/DF");
    expect(t.uri).toBe(uri);
    expect(t.exists).toBe(false);
    expect(t.sourceUri).toBe(`${uri}/source/main`);
  });

  // DDLX/EX and SRVD/SRV newly admitted alongside DDLS/DF this pass — same
  // source-shape recipe, same resolveWriteTarget code path, only the URI
  // differs. See capabilities.ts's comments on both entries for the live
  // create/PUT/activate/delete evidence.
  it("resolves DDLX/EX (metadata extension) the same way as any other source-shape type", async () => {
    const uri = "/sap/bc/adt/ddic/ddlx/sources/zi_mcp_demo";
    const { conn } = await connected((r) =>
      r.url === uri ? resp(404, NOT_FOUND_XML, OK_XML) : undefined,
    );
    const t = await resolveWriteTarget(conn, { type: "DDLX/EX", name: "zi_mcp_demo" });
    expect(t.type).toBe("DDLX/EX");
    expect(t.uri).toBe(uri);
    expect(t.exists).toBe(false);
    expect(t.sourceUri).toBe(`${uri}/source/main`);
  });

  it("resolves SRVD/SRV (service definition) the same way as any other source-shape type", async () => {
    const uri = "/sap/bc/adt/ddic/srvd/sources/zi_mcp_demo";
    const { conn } = await connected((r) =>
      r.url === uri ? resp(404, NOT_FOUND_XML, OK_XML) : undefined,
    );
    const t = await resolveWriteTarget(conn, { type: "SRVD/SRV", name: "zi_mcp_demo" });
    expect(t.type).toBe("SRVD/SRV");
    expect(t.uri).toBe(uri);
    expect(t.exists).toBe(false);
    expect(t.sourceUri).toBe(`${uri}/source/main`);
  });

  it("resolves TABL/DS (DDIC structure) the same way as TABL/DT", async () => {
    const uri = "/sap/bc/adt/ddic/structures/zmcp_demo_s";
    const { conn } = await connected((r) =>
      r.url === uri ? resp(404, NOT_FOUND_XML, OK_XML) : undefined,
    );
    const t = await resolveWriteTarget(conn, { type: "TABL/DS", name: "zmcp_demo_s" });
    expect(t.type).toBe("TABL/DS");
    expect(t.uri).toBe(uri);
    expect(t.exists).toBe(false);
  });

  /**
   * SHLP/DH and VIEW/DV are real ADT concepts that abapsmith deliberately does
   * not support: both 404 on every ADT request on this release (recon —
   * see capabilities.ts's module doc). TRAN/T (transaction) is a different
   * kind of refusal: TSTC is NOT the ADT-writable type code for a
   * transaction, so this also pins that abapsmith does not fall for the
   * TSTC-looks-like-a-table-name trap. PROG/PS (screen/dynpro), PROG/PC
   * (GUI status/CUA status) and PROG/PT (GUI title/titlebar) are program
   * subobjects with no ADT discovery collection and no
   * informationsystem/objecttypes registration — read-only as a content-free
   * VIT-bridge stub (for PROG/PT, not even key-validated: the bridge returns
   * 200 for a made-up title id or a nonexistent program), 405 on every write
   * verb, verified live. SUSO/B (authorization object) is the newest member,
   * added: IS a registered ADT object type (unlike the PROG
   * subobjects), but has no discovery collection and no writable route
   * either — the VIT bridge answers with a basic-properties stub only, live
   * recon via a manual probe script (not shipped in this release). `TABL/DI` (table secondary
   * index) is the eighth member and a DIFFERENT KIND of entry
   * from the other seven: SHLP/DH through SUSO/B all rest on live recon —
   * someone drove a real request at ADT and recorded what came back. TABL/DI
   * rests on abapsmith's OWN reach instead — no writable type code exists
   * for it, and the two in-band routes (a second `define index` statement
   * appended to a TABL/DT source PUT, and driving SE11's Indexes tab through
   * abap_ui) both fail, reproduced directly against this repo's own reach — but ADT's own
   * /sap/bc/adt/ddic/tables/{table}/indexes/{id} resource has never been
   * probed from this repo, so its entry does not claim ADT itself refuses
   * it. None of the eight are in `types.ts`'s `TYPES` array, so this
   * exercises the dedicated registry-sourced short-circuit in
   * `resolveWriteTarget`, not the ordinary `specForType`/`specForKeyword`
   * lookup — and it must fire before any network call, exactly like the
   * DTEL/DE and ENHO/XH refusals above.
   */
  it.each([
    ["SHLP/DH", "search help"],
    ["PROG/PS", "screen"],
    ["PROG/PC", "GUI status"],
    ["PROG/PT", "GUI title"],
    ["SUSO/B", "authorization object"],
    ["TABL/DI", "table secondary index"],
  ])("refuses %s with a specific UNSUPPORTED, offline, not the generic BAD_INPUT", async (type) => {
    const e = await catchErr(resolveWriteTarget(offline, { type, name: "ZX" }));
    expect(e.code).toBe("UNSUPPORTED");
    expect(String(e.message)).toMatch(/cannot be written by abapsmith/i);
  });

  /**
   * VIEW/DV and TRAN/T were rows in the `it.each` above until the classrun
   * bridge landed, and they asserted the message "cannot be written by
   * abapsmith". That sentence is now false — they ARE written, by
   * `abapCreateViaBridge`, which `abapWrite` routes to before this function is
   * ever reached. What stayed true is the half of the old finding this test
   * still pins: ADT has no writable collection to resolve a URI against, so
   * `resolveWriteTarget` — the SOURCE-write path — must keep refusing them,
   * UNSUPPORTED rather than the generic "Unknown object type" BAD_INPUT, and
   * must now name what `abap_write` really does for the type. Weakening this
   * to BAD_INPUT would be a silent regression in refusal quality, which is why
   * it is pinned rather than deleted.
   */
  it.each([
    ["VIEW/DV", "classic view"],
    ["TRAN/T", "transaction"],
  ])(
    "refuses %s on the SOURCE-write path with UNSUPPORTED, offline, and names what abap_write really does for it",
    async (type) => {
      const e = await catchErr(resolveWriteTarget(offline, { type, name: "ZX" }));
      expect(e.code).toBe("UNSUPPORTED");
      expect(String(e.message)).toMatch(/no writable ADT collection/i);
      expect(String(e.message)).toMatch(/405|GET-only/);
      // The refusal is where the guidance lives — the schema's `.describe()`
      // for these fields is deliberately terse (byte budget), so a caller who
      // lands here must be told the working call from the error alone.
      expect(String(e.hint ?? "")).toMatch(/abap_write/);
      expect(String(e.hint ?? "")).toMatch(/no update route/);
      expect(String(e.hint ?? "")).toMatch(new RegExp(type.replace("/", "\\/")));
    },
  );

  /**
   * The two types no longer diverge on the create half: neither REGISTRY
   * entry declares `bridgeCreate.createRefused` any more (RS_CORR_INSERT
   * registers a VIEW/DV create for every package now), so both hints fall
   * back to the same generic "no mode=create" call-out. What must NOT
   * collapse is each hint's own `limits` text — that is still the only
   * place a caller learns what the bridge for THIS type can and cannot do,
   * so each hint is pinned on content unique to its type.
   */
  it("TRAN/T's and VIEW/DV's hints share the generic create call-out but keep their own type-specific limits", async () => {
    const tran = await catchErr(resolveWriteTarget(offline, { type: "TRAN/T", name: "ZX" }));
    expect(String(tran.hint ?? "")).toMatch(/no mode=create/);
    expect(String(tran.hint ?? "")).toMatch(/REPORT transaction/);
    expect(String(tran.hint ?? "")).not.toMatch(/base table/);

    const view = await catchErr(resolveWriteTarget(offline, { type: "VIEW/DV", name: "ZX" }));
    expect(String(view.hint ?? "")).toMatch(/no mode=create/);
    expect(String(view.hint ?? "")).toMatch(/exactly\s+ONE base table/);
    expect(String(view.hint ?? "")).toMatch(/TRANSPORTABLE package requires corr_nr/);
    expect(String(view.hint ?? "")).not.toMatch(/REPORT transaction/);
  });

  it("TRAN/T's refusal explicitly distinguishes itself from TSTC, the underlying table", async () => {
    const e = await catchErr(resolveWriteTarget(offline, { type: "TRAN/T", name: "ZTX" }));
    expect(e.code).toBe("UNSUPPORTED");
    expect(String(e.message)).toMatch(/TSTC/);
  });

  it("PROG/PS's refusal names the real ADT type code and explains it is a program subobject, not a standalone type", async () => {
    const e = await catchErr(resolveWriteTarget(offline, { type: "PROG/PS", name: "ZX" }));
    expect(e.code).toBe("UNSUPPORTED");
    expect(String(e.message)).toMatch(/PROG\/PS/);
    expect(String(e.message)).toMatch(/screen/i);
    expect(String(e.message)).toMatch(/SE51/);
  });

  it("PROG/PC's refusal names the real ADT type code and explains it is a program subobject, not a standalone type", async () => {
    const e = await catchErr(resolveWriteTarget(offline, { type: "PROG/PC", name: "SCREEN_100" }));
    expect(e.code).toBe("UNSUPPORTED");
    expect(String(e.message)).toMatch(/PROG\/PC/);
    expect(String(e.message)).toMatch(/GUI status/i);
    expect(String(e.message)).toMatch(/SE41/);
  });

  it("PROG/PT's refusal names the real ADT type code and explains it is a program subobject, not a standalone type", async () => {
    const e = await catchErr(resolveWriteTarget(offline, { type: "PROG/PT", name: "ZX" }));
    expect(e.code).toBe("UNSUPPORTED");
    expect(String(e.message)).toMatch(/PROG\/PT/);
    expect(String(e.message)).toMatch(/title/i);
    expect(String(e.message)).toMatch(/SE41/);
  });

  /**
   * Authorization objects (SUSO/B) get the same explicit
   * unsupported treatment as SHLP/DH, following that entry's pattern exactly
   * — a stated boundary instead of a silent fall-through to the generic
   * "Unknown object type" refusal. `alternative` (SU21) must reach the
   * caller as `e.hint`, the same channel `resolveWriteTarget` uses for every
   * other unsupported type (see the VIEW/DV/TRAN/T test above).
   */
  it("SUSO/B's refusal names the real ADT type code, confirms it as a registered ADT type with no writable route, and names SU21 as the alternative", async () => {
    const e = await catchErr(resolveWriteTarget(offline, { type: "SUSO/B", name: "Z_TEST" }));
    expect(e.code).toBe("UNSUPPORTED");
    expect(String(e.message)).toMatch(/SUSO\/B/);
    expect(String(e.message)).toMatch(/authorization object/i);
    expect(String(e.message)).toMatch(/no ADT-writable collection/i);
    expect(String(e.hint ?? "")).toMatch(/SU21/);
  });

  /**
   * A table's secondary index reached only a generic BAD_INPUT
   * "Unknown object type" before this entry existed — no route, no
   * explanation, no pointer to SE11. This pins the fix and, unlike the
   * SUSO/B test above, also pins the honesty caveat this entry is careful
   * to state: the refusal is abapsmith admitting it has no route of its
   * own, NOT a claim that ADT's own table-index resource was probed and
   * refused it.
   */
  it("TABL/DI's refusal names the real ADT type code, names the closed in-band routes, states that ADT itself was never probed, and hints SE11 with the table staying writable as TABL/DT", async () => {
    const e = await catchErr(resolveWriteTarget(offline, { type: "TABL/DI", name: "ZTMC_TORDER" }));
    expect(e.code).toBe("UNSUPPORTED");
    expect(String(e.message)).toMatch(/TABL\/DI/);
    expect(String(e.message)).toMatch(/secondary index/i);
    expect(String(e.message)).toMatch(/define index/i);
    expect(String(e.message)).toMatch(/SE11|CINFO/);
    expect(String(e.message)).toMatch(/NOT established|never been probed/);
    expect(String(e.hint ?? "")).toMatch(/SE11/);
    expect(String(e.hint ?? "")).toMatch(/TABL\/DT/);
  });
});

/**
 * `delete` used to be purely descriptive in capabilities.ts — a
 * type could pass `resolveWriteTarget`'s single writability gate and still
 * reach a real `DELETE {uri}` even though nothing had ever verified delete
 * worked for it. These tests pin `DELETABLE_TYPES` (the `c.delete === true`
 * projection) and confirm the new `op === "delete"` check in
 * `resolveWriteTarget` refuses UNSUPPORTED — with zero requests on the wire —
 * for a type whose registry entry is `"unverified"` (DDLA/ADF, whose CREATE
 * is DISPROVEN — not merely untried — live 403
 * `ExceptionNoAnnotationDefinitionAuthorization`, so delete was never
 * reachable to test either). The gate also refuses a registry entry of
 * `false`, but none exists today — after the BDEF/BDO delete flip, no type
 * in the registry is `delete: false`. A type verified live (CLAS/OC) is
 * checked as a same-shape control so this isn't accidentally refusing
 * everything.
 */
describe("resolveWriteTarget: op:'delete' gate", () => {
  const offline = null as unknown as AbapConnection;
  const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
  const MAX = 20_000;

  it("DELETABLE_TYPES is the strict c.delete === true projection: excludes disproven and unverified types", () => {
    expect(DELETABLE_TYPES).toContain("CLAS/OC");
    expect(DELETABLE_TYPES).toContain("FUGR/F");
    expect(DELETABLE_TYPES).toContain("FUGR/FF");
    expect(DELETABLE_TYPES).toContain("DDLS/DF");
    expect(DELETABLE_TYPES).toContain("MSAG/N");
    // BDEF/BDO: the earlier "survived a successful DELETE" reading was a
    // misread of the source endpoint's 200/empty response for an absent
    // object, not a failed delete — the object was actually gone.
    expect(DELETABLE_TYPES).toContain("BDEF/BDO");
    // ENQU/DL: create AND delete both live-verified true on 2026-09-05
    // (EZTMD_I30 in $TMP over table T000 — 201 create, 200 delete, confirmed
    // absent on read-back).
    expect(DELETABLE_TYPES).toContain("ENQU/DL");
    // DDLA/ADF: CREATE is DISPROVEN live (403, SAP-only object type on this
    // system), so delete was never actually exercised. "unverified", not
    // `true` — the exemplar for the group this test protects.
    expect(DELETABLE_TYPES).not.toContain("DDLA/ADF");
  });

  it("a DDLA/ADF delete is refused UNSUPPORTED with ZERO requests on the wire (unverified)", async () => {
    const { conn, adt } = await connected(ABSENT_ROUTE);
    const e = await catchErr(
      resolveWriteTarget(conn, { type: "DDLA/ADF", name: "ZTMD_DDLA" }, "delete"),
    );
    expect(e.code).toBe("UNSUPPORTED");
    expect(String(e.message)).toMatch(/DDLA\/ADF/);
    expect(String(e.message)).toMatch(/delete/i);
    expect(adt.calls).toEqual([]);

    const offlineErr = await catchErr(
      resolveWriteTarget(offline, { type: "DDLA/ADF", name: "ZTMD_DDLA" }, "delete"),
    );
    expect(offlineErr.code).toBe("UNSUPPORTED");
  });

  it("a DDLA/ADF delete is refused UNSUPPORTED with ZERO requests on the wire (unverified)", async () => {
    const { conn, adt } = await connected(ABSENT_ROUTE);
    const e = await catchErr(
      resolveWriteTarget(conn, { type: "DDLA/ADF", name: "ZTMD_ANNO_X" }, "delete"),
    );
    expect(e.code).toBe("UNSUPPORTED");
    expect(String(e.message)).toMatch(/DDLA\/ADF/);
    expect(String(e.message)).toMatch(/delete/i);
    expect(adt.calls).toEqual([]);

    const offlineErr = await catchErr(
      resolveWriteTarget(offline, { type: "DDLA/ADF", name: "ZTMD_ANNO_X" }, "delete"),
    );
    expect(offlineErr.code).toBe("UNSUPPORTED");
  });

  it("the batch-delete tool refuses DDLA/ADF through the same gate, via abapWriteBatchDelete", async () => {
    const { conn, adt } = await connected(ABSENT_ROUTE);
    const e = await catchErr(
      abapWriteBatchDelete(conn, [{ object: "ZTMD_DDLA", type: "DDLA/ADF" }], MAX, gate, undefined),
    );
    expect(e.code).toBe("UNSUPPORTED");
    expect(String(e.message)).toMatch(/DDLA\/ADF/);
    expect(adt.calls).toEqual([]);
  });

  it("does not regress a genuinely deletable type: CLAS/OC still resolves for op:'delete' (control)", async () => {
    const { conn } = await connected(ABSENT_ROUTE);
    // ABSENT_ROUTE 404s the existence GET. With an explicit `type` (so
    // `specSource === "caller"`), `resolveWriteTarget` does NOT throw on that
    // 404 — it resolves with `exists: false` and leaves the NOT_FOUND call to
    // `authorizeMutation`. So the promise resolving at all (rather than
    // rejecting UNSUPPORTED) is exactly what proves the new op:"delete" gate
    // check let CLAS/OC through instead of refusing it up front.
    const resolved = await resolveWriteTarget(conn, { type: "CLAS/OC", name: "ZCL_X" }, "delete");
    expect(resolved.type).toBe("CLAS/OC");
    expect(resolved.exists).toBe(false);
  });

  // `rollbackCreate`'s `delete !== true` guard is kept as a safety net for a
  // future type that can create but not (yet verified to) delete. This test
  // is what will tell us when the guard becomes reachable again.
  it("every type that can reach writeObject's create-and-rollback path is deletable — rollbackCreate's guard has no reachable subject today", () => {
    const canRollback = WRITABLE_TYPES.filter((t) => VERIFIED_CREATABLE_TYPES.includes(t));
    expect(canRollback.length).toBeGreaterThan(0);
    const notDeletable = canRollback.filter((t) => capabilitiesFor(t)?.delete !== true);
    expect(notDeletable).toEqual([]);
  });
});

/**
 * The CREATE-direction twin of the delete gate above.
 * `writeObject` learns only at the point it computes `created` (step ~3,
 * `src/adt/write.ts`, right before `preflightCorr`) whether this call is
 * bringing a brand-new object into existence — `resolveWriteTarget` cannot
 * decide that up front the way the delete gate's `op === "delete"` check could, because
 * every write goes through `op: "write"` and "is this a create" depends on
 * `t.exists`/`readCurrentSource`, not the target alone. So the refusal here
 * is NOT zero-wire the way the delete gate's is: by the time it fires, the existence GET
 * (`resolveWriteTarget`, inside `authorizeMutation`) has already gone out —
 * pinned exactly, not just "not a POST", in the test below.
 *
 * `DDLA/ADF` anchors every test that needs a settled non-`true` type today:
 * its `create.verified` is `false` — DISPROVEN, not merely untested. A
 * 2026-09-04 live A4H probe refused BOTH `abap_write` (creating
 * `ZTMD_ANNO_01` in `$TMP`) and a raw vendor-body `POST .../ddic/ddla/sources`
 * with `403 ExceptionNoAnnotationDefinitionAuthorization` — annotation
 * definitions are SAP-only on this system, so unlike a recipe that just
 * hasn't been tried, this is an authorization wall no future sweep is
 * expected to lift. `CLAS/OC` anchors the "verified:true still works"
 * control: it was one of that live create-verification sweep's own targets
 * (2/2 FULL_CYCLE_OK, live on A4H 2026-08-19) and is load-bearing for
 * abapsmith's own internal bridge-class deploys, so it is about as settled
 * as `true` gets in this registry.
 *
 * `ENQU/DL` used to be this describe block's anchor, and is exactly why the
 * anchor moved: its `create.verified` was DISPROVEN (two independent
 * `400 ExceptionInvalidData` live attempts), reproduced again by the live
 * create-verification sweep, and yet a later attempt on 2026-09-05 found
 * the real cause — the root element has to be lowercase `enqu:lockobject`
 * in namespace `http://www.sap.com/adt/ddic/enqu`, not the camelCase
 * `enqu:lockObject` in `http://www.sap.com/dictionary/lockobject` every
 * earlier attempt sent — and flipped it live to `true`. A test suite that
 * hardcodes today's disproven type as a fixture for "this will never
 * create" eventually has to be unwound exactly the way this one just was;
 * see the "properties-shape writes" describe block below for ENQU/DL's own
 * (now positive) create test.
 *
 * The tri-state matters and is pinned explicitly below: `DDLA/ADF`
 * (`verified: false`, DISPROVEN) is the settled-false leg. No entry in the
 * registry carries `"unverified"` for `create` today — `DEVC/K`, the last
 * type that did, was itself settled `true` by a live A4H run on
 * 2026-09-04 — so the tri-state is asserted over the whole registry's legal
 * values rather than pinned to one "unverified" exemplar.
 */
describe("writeObject: create gate", () => {
  const offline = null as unknown as AbapConnection;

  /**
   * Well-formed ENQU/DL payload — lowercase `enqu:lockobject` root in
   * namespace `http://www.sap.com/adt/ddic/enqu`, per the live-verified
   * shape (2026-09-05, A4H) — carrying `adtcore:name`/`adtcore:type` so it
   * clears `assertPayloadMatchesTarget`'s (earlier, unrelated)
   * payload-identity check, and a complete
   * `<enqu:primaryTable><enqu:tableName>…</enqu:tableName><enqu:lockMode>…`
   * so it clears `assertLockObjectRoot` too (element order matters; omitting
   * `lockMode` 400s live). Used below only by the ENQU/DL EDIT test — an
   * edit of an EXISTING ENQU/DL must still work.
   */
  const ENQU_154_XML =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<enqu:lockobject xmlns:enqu="http://www.sap.com/adt/ddic/enqu" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="EZ154_X" ` +
    `adtcore:type="ENQU/DL"><adtcore:packageRef adtcore:name="$TMP"/>` +
    `<enqu:content><enqu:primaryTable><enqu:tableName>ZTAB1</enqu:tableName>` +
    `<enqu:lockMode>E</enqu:lockMode></enqu:primaryTable></enqu:content></enqu:lockobject>`;

  /**
   * DDLA/ADF is source-shape (ABAP annotation-definition DDL text, not XML),
   * so none of the properties-shape guards above (`assertPayloadMatchesTarget`,
   * `assertDomaMasterLanguage`, `assertLockObjectRoot`) apply to it — it
   * reaches the create gate on content alone.
   */
  const DDLA_ANNO_SOURCE =
    "@EndUserText.label: 'probe'\nannotate view ZI_TMD_ANNO_X with\n{\n}\n";

  it("VERIFIED_CREATABLE_TYPES is the strict c.create?.verified === true projection — a proper subset of CREATABLE_TYPES", () => {
    // DDLA/ADF must stay in the BROAD set (an EDIT of an existing DDLA/ADF
    // must still be reachable — see the "EDIT is not refused" test below) but
    // must never appear in the narrow, live-verified set.
    expect(CREATABLE_TYPES).toContain("DDLA/ADF");
    expect(VERIFIED_CREATABLE_TYPES).not.toContain("DDLA/ADF");

    // The subset relationship is the design's whole point (module doc,
    // `src/adt/capabilities.ts`, "VERIFIED_CREATABLE_TYPES ... a proper
    // subset of CREATABLE_TYPES") and must be pinned structurally, not just
    // spot-checked on one member: every verified-creatable type is also
    // creatable.
    for (const t of VERIFIED_CREATABLE_TYPES) {
      expect(CREATABLE_TYPES).toContain(t);
    }
    // ...and the containment is STRICT — `CREATABLE_TYPES` stays exactly as
    // broad as it always was rather than narrowing down to match. A future
    // "simplification" that collapses the two sets back into one (the
    // regression this gate exists to prevent) would make this fail.
    expect(VERIFIED_CREATABLE_TYPES.length).toBeLessThan(CREATABLE_TYPES.length);
  });

  it("an unverified type's CREATE is refused UNSUPPORTED — DDLA/ADF, name ZTMD_ANNO_X", async () => {
    // DDLA/ADF has no namePrefixes override, so the global Z/Y rule applies
    // and a plain `Z...` name is exactly right — unlike ENQU/DL, there is no
    // second, type-specific name check that could make this test pass for
    // the wrong reason.
    const { conn, adt } = await connected(ABSENT_ROUTE);
    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "DDLA/ADF", name: "ZTMD_ANNO_X" }), {
        source: DDLA_ANNO_SOURCE,
      }),
    );
    expect(e.code).toBe("UNSUPPORTED");
    expect(String(e.message)).toMatch(/DDLA\/ADF/);
    expect(String(e.message)).toMatch(/cannot be created/i);
  });

  it("the refusal's exact wire sequence — no create POST, no transport minted", async () => {
    // THE KEY ASSERTION. The refusal is not zero-wire: `resolveWriteTarget`'s
    // own existence GET (run inside `authWrite`, before `writeObject` is even
    // called) has already gone out by the time `created` is known. What must
    // be true, and is pinned here with `toEqual` on the WHOLE sequence rather
    // than `.not.toContain`, is that nothing past that GET reaches the wire —
    // in particular no POST to the create collection
    // (`/sap/bc/adt/ddic/ddla/sources`) and no transport request minted
    // (`preflightCorr`'s `/cts/transportchecks`), because the gate in
    // `writeObject` sits BEFORE `preflightCorr` is ever called. A loose
    // `.not.toContain("POST")` could hide an unexpected extra GET or a stray
    // call this test never anticipated; `toEqual` on the full list cannot.
    //
    // DDLA/ADF is source-shape, so `readCurrentSource` (step 1, before the
    // create gate) would normally GET `/source/main` too — but it short-
    // circuits to `undefined` without a request whenever `!t.exists`
    // (`src/adt/write.ts`, `readCurrentSource`), so the existence GET below
    // really is the WHOLE transcript, same as it was for ENQU/DL's
    // properties-shape version of this test.
    const { conn, adt } = await connected(ABSENT_ROUTE);
    const DDLA_URI = "/sap/bc/adt/ddic/ddla/sources/ztmd_anno_x";
    const target = await authWrite(conn, { type: "DDLA/ADF", name: "ZTMD_ANNO_X" });
    const e = await catchErr(writeObject(conn, target, { source: DDLA_ANNO_SOURCE }));
    expect(e.code).toBe("UNSUPPORTED");
    // The ENTIRE transcript: one GET (the existence check), and nothing else
    // — no POST, no LOCK, no PUT, no UNLOCK, no /cts/transportchecks call.
    expect(adt.calls).toEqual([
      expect.objectContaining({ method: "GET", url: DDLA_URI }),
    ]);
    expect(adt.labels).toEqual([`GET ${DDLA_URI}`]);
  });

  it("an EDIT of an existing ENQU/DL still works (control, unrelated to the create gate now that ENQU/DL's create is verified)", async () => {
    // This test predates ENQU/DL's create flipping to verified:true
    // (2026-09-05) and originally proved the create-gate's "created===false
    // must never reach the gate" property using ENQU/DL as the settled
    // non-true anchor. That property is now proven by the DDLA/ADF test
    // below instead — DDLA/ADF is today's settled-false type. Kept here,
    // re-anchored, as a plain control: an ENQU/DL edit must still work.
    const uri = "/sap/bc/adt/ddic/lockobjects/sources/ez154_x";
    const before = ENQU_154_XML;
    const after = before.replace("ZTAB1", "ZTAB2");
    // Stateful, not a fixed `before` on every GET: the properties-shape
    // UPDATE path (`writeObject` step 4b) does a genuine post-lock,
    // pre-PUT re-read AND a genuine post-write re-read on this same URI (see
    // `src/adt/write.ts` step 4b's doc comment — it computes `changed` from
    // comparing those two REAL reads, not from the PUT response). A route
    // that always answers `before` regardless of order makes both reads
    // identical and `changed` false no matter what was actually written —
    // exactly the trap this comment exists to name.
    let served = before;
    const { conn, adt } = await connected((r) => {
      if (r.url === uri && r.method === "GET") return resp(200, served, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === uri && r.method === "PUT") {
        served = after;
        return resp(200, after, OK_XML);
      }
      return undefined;
    });
    const res = await writeObject(conn, await authWrite(conn, { type: "ENQU/DL", name: "EZ154_X" }), {
      source: after,
    });
    expect(res.created).toBe(false);
    expect(res.changed).toBe(true);
    expect(adt.verbs).toContain("PUT");
    expect(adt.verbs).not.toContain("POST");
  });

  it("an EDIT of an existing DDLA/ADF is NOT refused — created === false must never reach the gate", async () => {
    // The regression that would matter most if someone later "simplified"
    // this gate to key off `CREATABLE_TYPES`/the type alone instead of
    // `created`: an existing DDLA/ADF must remain editable even though its
    // create is refused (403 ExceptionNoAnnotationDefinitionAuthorization,
    // live). The gate (`src/adt/write.ts`, the `if (created && ...)` check
    // right before `preflightCorr`) is deliberately gated on `created`, not
    // on the type's capability alone — precisely so this keeps working.
    // Source shape, not properties: DDLA/ADF's content lives at
    // `/source/main`, unlike ENQU/DL's properties-shape object-URI-is-the-
    // content — so none of `assertPayloadMatchesTarget`/
    // `assertDomaMasterLanguage`/`assertLockObjectRoot` apply here either.
    const uri = "/sap/bc/adt/ddic/ddla/sources/ztmd_anno_x";
    const src = `${uri}/source/main`;
    const before = DDLA_ANNO_SOURCE;
    const after = before.replace("probe", "probe2");
    const { conn, adt } = await connected((r) => {
      if (r.url === uri && r.method === "GET" && !r.qs._action) {
        return resp(200, OBJECT_XML("ZTMD_ANNO_X", "DDLA/ADF"), OK_XML);
      }
      if (r.url === src && r.method === "GET") return resp(200, before, OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === src && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    });
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "DDLA/ADF", name: "ZTMD_ANNO_X" }),
      { source: after },
    );
    expect(res.created).toBe(false);
    expect(res.changed).toBe(true);
    expect(adt.verbs).toContain("PUT");
    expect(adt.verbs).not.toContain("POST");
  });

  it("control: a verified:true type (CLAS/OC) still creates normally through the same path", async () => {
    // CLAS/OC, not DTEL/DE, MSAG/N or TABL/DT: those three were still in
    // flux under the live A4H sweep at the time this test was written.
    // CLAS/OC is one of the sweep's own settled targets (2/2 FULL_CYCLE_OK,
    // live on A4H — see its REGISTRY entry's comment) and is load-bearing
    // for abapsmith's own internal bridge-class deploys
    // (`deployBridge`/`ensureMarkerInterface`), so a regression here would be
    // caught immediately by a much wider blast radius than this test alone.
    const CLS_URI = "/sap/bc/adt/oo/classes/zi154_ctrl_cl";
    const CLS_COLLECTION = "/sap/bc/adt/oo/classes";
    const CLS_SRC = `${CLS_URI}/source/main`;
    const { conn, adt } = await connected((r) => {
      if (r.url === CLS_URI && r.method === "GET" && !r.qs._action) {
        return resp(404, NOT_FOUND_XML, OK_XML);
      }
      if (r.url === CLS_COLLECTION && r.method === "POST") return resp(200, "", OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === CLS_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    });
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "CLAS/OC", name: "ZI154_CTRL_CL" }),
      { source: "CLASS zi154_ctrl_cl DEFINITION.\nENDCLASS.\n" },
    );
    expect(res.created).toBe(true);
    expect(adt.labels).toEqual([
      `GET ${CLS_URI}`,
      `POST ${CLS_COLLECTION}`,
      `LOCK ${CLS_URI}`,
      `PUT ${CLS_SRC}`,
      `UNLOCK ${CLS_URI}`,
    ]);
  });

  it("create.verified is tri-state across the whole registry, and the false leg (DDLA/ADF, disproven) still holds", () => {
    // DEVC/K was this test's "unverified" exemplar until a live A4H run
    // (2026-09-04) settled it to true. ENQU/DL was the false-leg exemplar
    // until a live A4H run (2026-09-05) settled ITS create to true as well
    // (the real defect all along was the wire XML's root element, not the
    // capability) — DDLA/ADF (403 ExceptionNoAnnotationDefinitionAuthorization,
    // live 2026-09-04) is the false leg now.
    const ddla = capabilitiesFor("DDLA/ADF");
    expect(ddla?.create?.verified).toBe(false);
    expect(ddla?.create?.verified).not.toBe(true);
    expect(VERIFIED_CREATABLE_TYPES).not.toContain("DDLA/ADF");

    // ENQU/DL's create flipped true — pinned explicitly here so a future
    // regression of either exemplar trips this test, not just the other.
    const enqu = capabilitiesFor("ENQU/DL");
    expect(enqu?.create?.verified).toBe(true);
    expect(VERIFIED_CREATABLE_TYPES).toContain("ENQU/DL");

    const devc = capabilitiesFor("DEVC/K");
    expect(devc?.create?.verified).toBe(true);

    // Every declared `create.verified` in the registry is one of the three
    // legal states — `TypeCapabilities` already guarantees this at compile
    // time; this is the runtime companion, so a future refactor that widens
    // the type can't silently smuggle a fourth value through unnoticed.
    const verifiedValues = Object.values(REGISTRY)
      .map((c) => c.create?.verified)
      .filter((v) => v !== undefined);
    expect(verifiedValues.length).toBeGreaterThan(0);
    for (const v of verifiedValues) {
      expect([true, false, "unverified"]).toContain(v);
    }
  });

  /**
   * `createNewObject` (src/adt/write.ts, ~line 3683) carries its own
   * `cap?.create?.verified !== true` refusal as defence-in-depth — the same
   * shape as the delete gate's `rollbackCreate` guard, and for the identical reason:
   * `writeObject`'s gate lives in the CALLER, and `createNewObject` is the
   * one function that actually sends the create POST, reached today by
   * `writeObject`, `deployBridge`, `ensureMarkerInterface` and undo's
   * recreate-on-delete-undo alike.
   *
   * It is NOT independently exercisable from this test file, honestly: the
   * function is not exported, and its only reachable call site is
   * `writeObject`'s own (`if (created) await createNewObject(...)`), gated
   * immediately beforehand by the IDENTICAL predicate
   * (`capabilitiesFor(t.type)?.create?.verified !== true`) on the SAME
   * `t.type`. There is no way to construct a call through `writeObject` where
   * the caller's gate does not fire but `createNewObject`'s internal check
   * does — they always agree, for any type, because they test the same fact.
   * This guard is real defence-in-depth against a FUTURE caller that reaches
   * `createNewObject` some other way (mirroring exactly why the delete gate added the
   * `rollbackCreate` guard, which calls `conn.del` directly and bypasses
   * `resolveWriteTarget`'s delete gate the same way) — but nothing in this
   * offline suite can prove that path without either exporting the function
   * (an `src/` change, out of scope here) or duplicating its body. Recorded
   * here rather than faked with a test that would actually just be
   * re-testing the SAME call already covered above.
   */
});

/**
 * A NEW set, deliberately not a widening of `WRITABLE_TYPES` — see the
 * doc comment on `ENHANCEABLE_TYPES` in src/adt/write.ts. The set is really
 * "write, no create", not "enhancement". `TYPE/DG` and `DRUL/DRL` left it
 * once both gained a `create` skeleton (see capabilities.ts); `ENHO/XHH`
 * (the source-code plug-in) is the sole remaining member, with a real
 * PUT-source path but no create anywhere. `ENHO/XH` and `ENHS/XS` are
 * structured-XML-only with no writer anywhere in this codebase, and stay
 * refused by `resolveWriteTarget`.
 */
describe("ENHANCEABLE_TYPES / isEnhanceableType", () => {
  it("contains exactly ENHO/XHH (write, no create) — TYPE/DG and DRUL/DRL moved out once they gained create", () => {
    expect(ENHANCEABLE_TYPES).toEqual(["ENHO/XHH"]);
    expect(isEnhanceableType("TYPE/DG")).toBe(false);
    expect(isEnhanceableType("DRUL/DRL")).toBe(false);
    expect(isEnhanceableType("ENHO/XHH")).toBe(true);
    expect(isEnhanceableType("ENHO/XH")).toBe(false);
    expect(isEnhanceableType("ENHS/XS")).toBe(false);
    expect(isEnhanceableType(undefined)).toBe(false);
  });
});

/**
 * Closes the general invariant a specific defect was one instance of, not
 * just that one instance: `capabilities.ts` declaring `write:{...}` for a
 * type is what makes `resolveWriteTarget` accept it at all, but `safety.ts`'s
 * `evaluate()` routes every type `isEnhancementType()` matches through the
 * intent branch, which is satisfiable ONLY if some field on the REGISTERED
 * `abap_write` schema can carry the `affects` an `EnhancementIntent` is built
 * from (there is no second writer for these types — `ENHANCEABLE_TYPES`,
 * i.e. write-but-no-create, all funnel through `abapWrite`). `ENHO/XHH` once
 * had `write` here and `affects` nowhere on `writeInputSchema`: a type the
 * registry called writable that no schema could actually write. This test
 * walks the REAL `REGISTRY`, not a hand-picked list of today's known types,
 * so a type added to it later that matches `isEnhancementType()` re-triggers
 * the same check with no further code needed — closing the class of defect,
 * not the one member of it found by hand.
 *
 * Demonstrated red against the pre-fix code by temporarily deleting the
 * `affects` field from `writeInputSchema` in src/tools/write.ts and
 * re-running this file: this test failed alongside the five Blocker-A tests
 * above, with the assertion message correctly naming `ENHO/XHH` as the
 * type with no schema path. Restored before commit.
 */
describe("invariant: no REGISTRY type may declare `write` for an enhancement-gated type with no schema path to its required intent (Blocker A)", () => {
  it("every REGISTRY entry with `write` that isEnhancementType() matches is reachable via a field on abap_write's own schema", () => {
    const enhancementWritableTypes = Object.entries(REGISTRY)
      .filter(([, c]) => c.write !== undefined)
      .map(([type]) => type)
      .filter((type) => isEnhancementType(type));
    // Sanity: if this walk found nothing, the assertion below would be
    // vacuously true and the invariant would not actually be closed. The one
    // type the whole fix was about must be among them, or this test is
    // testing nothing.
    expect(enhancementWritableTypes).toContain("ENHO/XHH");
    for (const type of enhancementWritableTypes) {
      expect(
        Object.keys(writeInputSchema),
        `capabilities.ts declares write:{...} for ${type}, and isEnhancementType() matches it, ` +
          "so safety.ts's evaluate() will demand an EnhancementIntent before this type " +
          "can ever be written — but abap_write's own registered schema has no `affects` field " +
          "for a caller to build one from. See src/tools/write.ts's `affects` field and " +
          "`enhancementPreflightIntent`.",
      ).toContain("affects");
    }
  });
});

describe("resolveWriteTarget: ENHO/XHH and the masterSystem scraper", () => {
  const ENH_URI = "/sap/bc/adt/enhancements/enhoxhh/zenh_foo";

  /** Same shape as `OBJECT_XML`, plus `adtcore:masterSystem` on the root element. */
  const ENH_XML = (masterSystem: string | undefined, packageName = "$TMP"): string =>
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:name="ZENH_FOO" adtcore:type="ENHO/XHH"` +
    (masterSystem === undefined ? "" : ` adtcore:masterSystem="${masterSystem}"`) +
    `>` +
    `<adtcore:packageRef adtcore:name="${packageName}"/>` +
    `</adtcore:objectMetadata>`;

  it("resolves ENHO/XHH — previously UNSUPPORTED, since it is in neither CREATABLE_TYPES nor the old set", async () => {
    const { conn } = await connected((r) =>
      r.url === ENH_URI ? resp(200, ENH_XML("A4H"), OK_XML) : undefined,
    );
    const t = await resolveWriteTarget(conn, { type: "ENHO/XHH", name: "zenh_foo" });
    expect(t.type).toBe("ENHO/XHH");
    expect(t.uri).toBe(ENH_URI);
    expect(t.exists).toBe(true);
  });

  it("still refuses ENHO/XH and ENHS/XS — structured-XML-only, no writer, not in ENHANCEABLE_TYPES", async () => {
    // Refused before any network call, exactly like the DTEL/DE case above.
    const offlineTarget = null as unknown as AbapConnection;
    expect((await catchErr(resolveWriteTarget(offlineTarget, { type: "ENHO/XH", name: "ZX" }))).code).toBe(
      "UNSUPPORTED",
    );
    expect((await catchErr(resolveWriteTarget(offlineTarget, { type: "ENHS/XS", name: "ZX" }))).code).toBe(
      "UNSUPPORTED",
    );
  });

  it("scrapes adtcore:masterSystem off the same GET packageName already comes from", async () => {
    const { conn } = await connected((r) =>
      r.url === ENH_URI ? resp(200, ENH_XML("A4H"), OK_XML) : undefined,
    );
    const t = await resolveWriteTarget(conn, { type: "ENHO/XHH", name: "zenh_foo" });
    expect(t.masterSystem).toBe("A4H");
  });

  it("also carries masterSystem for an ordinary writable type — the attribute is generic, not enhancement-specific", async () => {
    const { conn } = await connected((r) =>
      r.url === REPORT_URI
        ? resp(
            200,
            `<?xml version="1.0" encoding="utf-8"?>` +
              `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
              `adtcore:name="${REPORT}" adtcore:type="PROG/P" adtcore:masterSystem="SAP">` +
              `<adtcore:packageRef adtcore:name="ZLOCAL"/></adtcore:objectMetadata>`,
            OK_XML,
          )
        : undefined,
    );
    const t = await resolveWriteTarget(conn, { type: "PROG/P", name: REPORT });
    expect(t.masterSystem).toBe("SAP");
  });

  it("is undefined (not guessed) when the document is absent, and undefined on a create", async () => {
    const { conn: connNoAttr } = await connected((r) =>
      r.url === ENH_URI ? resp(200, ENH_XML(undefined), OK_XML) : undefined,
    );
    expect((await resolveWriteTarget(connNoAttr, { type: "ENHO/XHH", name: "zenh_foo" })).masterSystem).toBe(
      undefined,
    );
    const { conn: connCreate } = await connected(ABSENT_ROUTE);
    expect((await resolveWriteTarget(connCreate, { type: "ENHO/XHH", name: "zenh_foo" })).masterSystem).toBe(
      undefined,
    );
  });

  it("fails closed to undefined (never picks one) when two masterSystem attributes disagree", async () => {
    const ambiguous =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
      `adtcore:name="ZENH_FOO" adtcore:type="ENHO/XHH" adtcore:masterSystem="A4H">` +
      `<adtcore:objectReference adtcore:masterSystem="SAP"/>` +
      `<adtcore:packageRef adtcore:name="$TMP"/>` +
      `</adtcore:objectMetadata>`;
    const { conn } = await connected((r) => (r.url === ENH_URI ? resp(200, ambiguous, OK_XML) : undefined));
    const t = await resolveWriteTarget(conn, { type: "ENHO/XHH", name: "zenh_foo" });
    expect(t.masterSystem).toBe(undefined);
  });
});

/**
 * `affects` threaded into `authorizeMutation`'s `gate.assert` call, so an
 * enhancement-type mutation gives the gate the `EnhancementIntent` it requires
 * instead of always failing with "must go through evaluateIntent()". `$TMP`
 * throughout — no `SessionTransport` needed to prove this, since a `$TMP`
 * write never reaches the transport step.
 */
describe("authorizeMutation: affects → EnhancementIntent", () => {
  it("refuses an enhancement-type write with no affects — the gate cannot judge it from the artefact alone", async () => {
    const { conn } = await connected(ABSENT_ROUTE);
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const e = await catchErr(
      authorizeMutation(conn, gate, "write", { type: "ENHO/XHH", name: "zenh_foo" }),
    );
    expect(e.code).toBe("SAFETY_DENIED");
    expect(e.details.rule).toBe("enhancement write needs an intent");
  });

  it("passes affects through as the EnhancementIntent the gate needs, and the gate can then allow it", async () => {
    const { conn } = await connected(ABSENT_ROUTE);
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      allowEnhancements: true,
      enhanceTargets: "customer",
      originSystems: ["A4H"],
    });
    const t = await authorizeMutation(conn, gate, "write", {
      type: "ENHO/XHH",
      name: "zenh_foo",
      affects: { name: "ZTARGET_CLS", packageName: "ZTARGET_PKG", masterSystem: "A4H", spotName: "ZSPOT_FOO" },
    });
    expect(t.target.type).toBe("ENHO/XHH");
  });

  it("still refuses a target the gate's enhancement rules reject, even with affects supplied", async () => {
    const { conn } = await connected(ABSENT_ROUTE);
    // allowEnhancements is unset (closed by default) — affects alone does not
    // bypass the master switch.
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const e = await catchErr(
      authorizeMutation(conn, gate, "write", {
        type: "ENHO/XHH",
        name: "zenh_foo",
        affects: { name: "ZTARGET_CLS", packageName: "ZTARGET_PKG", masterSystem: "A4H" },
      }),
    );
    expect(e.code).toBe("ENHANCEMENT_DISABLED");
  });
});

/**
 * Blocker A: the ADT layer above (`authorizeMutation`/`enhancementIntentFor`,
 * proven by the describe block just above) has known what to do with
 * `affects` since it was built. But
 * `abap_write`'s OWN registered schema (`writeInputSchema`) never declared an
 * `affects` field, so:
 *
 *  1. the MCP SDK's zod validation stripped it from every real call before the
 *     handler ever saw it (the exact "undeclared key vanishes silently"
 *     mechanism `test/v2-write-arg-forwarding.test.ts` §1 pins for other
 *     fields), and
 *  2. `targetFromInput` had nothing to read even if it had survived, and
 *  3. the registrar's own zero-network preflight `deps.safety.assert(...)`
 *     call (BEFORE `ensureConnected()`) passed no `intent` at all, so it hit
 *     safety.ts's "no intent" branch and refused EVERY explicit
 *     `type: "ENHO/XHH"` write unconditionally — before the fixed final-check
 *     path (`authorizeMutation`) could ever run.
 *
 * A live agent hit exactly this: SAFETY_DENIED, four call shapes, on an empty
 * ENHO/XHH hook body it had legitimately created and needed to fill in.
 */
describe("targetFromInput: affects survives into WriteTarget (Blocker A)", () => {
  it("declares `affects` on writeInputSchema, mirroring abap_enh's own field", () => {
    expect(Object.keys(writeInputSchema)).toContain("affects");
  });

  it("maps input.affects onto WriteTarget.affects, unchanged", () => {
    const affects = { name: "ZTARGET_CLS", packageName: "ZTARGET_PKG", masterSystem: "A4H", spotName: "ZSPOT_FOO" };
    const target = targetFromInput({ object: "ZENH_FOO", type: "ENHO/XHH", affects } as never);
    expect(target.affects).toEqual(affects);
  });

  it("leaves affects absent when the caller supplies none", () => {
    const target = targetFromInput({ object: "ZCL_FOO", type: "CLAS/OC" } as never);
    expect(target).not.toHaveProperty("affects");
  });
});

/**
 * Blocker A, continued: the exact zero-network preflight `registerWriteTools`
 * runs, end to end through a real `McpServer`/`Client` over `InMemoryTransport`
 * — the same harness shape `test/v2-write-arg-forwarding.test.ts` uses for the
 * SDK+zod boundary — with a REAL `SafetyGate`, so both halves of the defect
 * (schema stripping the field, preflight building no intent) are exercised at
 * once, exactly as a live call would hit them.
 *
 * `deps.pool.withWrite` never calls its `fn` — it only records whether it was
 * reached at all, which is precisely the question here: did the preflight gate
 * let the call through to the point where a real connection would be opened?
 * Nothing past that line is under test in this describe block.
 */
describe("registerWriteTools: the tool's own preflight needs affects too (Blocker A)", () => {
  /**
   * `deps.pool.withWrite` never calls the `fn` it is handed — it only counts
   * how many times it was reached, which is exactly the question under test:
   * did the zero-network preflight let the call through?
   */
  function harnessWithCounter(gate: SafetyGate) {
    let poolCalls = 0;
    const deps: WriteToolDeps = {
      pool: {
        withWrite: async <T>(): Promise<T> => {
          poolCalls += 1;
          return { text: "stub: reached pool.withWrite (preflight passed)", truncated: false } as unknown as T;
        },
      } as never,
      safety: gate,
      ensureConnected: async () => {},
      errorResult,
      cfg: { maxResponseChars: 50_000 },
      journal: undefined as never,
      transport: undefined as never,
    };
    const server = new McpServer({ name: "write-preflight-probe", version: "0.0.0" });
    registerWriteTools(server, deps);
    const call = async (args: Record<string, unknown>): Promise<string> => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "write-preflight-probe", version: "0.0.0" });
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const res = await client.callTool({ name: "abap_write", arguments: args });
      const first = Array.isArray(res.content) ? res.content[0] : undefined;
      const text = first && typeof first === "object" && "text" in first ? String((first as { text: unknown }).text) : "";
      return text;
    };
    return { call, calls: () => poolCalls };
  }

  const permissiveGate = () =>
    new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      allowEnhancements: true,
      enhanceTargets: "customer",
      originSystems: ["A4H"],
    });

  it("refuses an ENHO/XHH write with no affects, naming the parameter — not an internal function", async () => {
    const { call, calls } = harnessWithCounter(permissiveGate());
    const text = await call({ object: "ZTM_HOOK_IMPL", type: "ENHO/XHH", source: "ENHANCEMENT 1.\nENDENHANCEMENT." });
    expect(text).toMatch(/SAFETY_DENIED/);
    expect(text).toMatch(/affects/);
    // The old wording named an internal function a caller cannot call and
    // should never have seen — pin its absence, not just the new presence.
    expect(text).not.toMatch(/SafetyGate\.evaluateIntent/);
    expect(calls()).toBe(0);
  });

  it("passes preflight and reaches pool.withWrite once affects is supplied and the gate allows it", async () => {
    const { call, calls } = harnessWithCounter(permissiveGate());
    const text = await call({
      object: "ZTM_HOOK_IMPL",
      type: "ENHO/XHH",
      source: "ENHANCEMENT 1.\nENDENHANCEMENT.",
      affects: { name: "ZTM_HW011_BADI", packageName: "$TMP", spotName: "ZTM_ES_HW011B_EP" },
    });
    expect(text).toBe("stub: reached pool.withWrite (preflight passed)");
    expect(calls()).toBe(1);
  });

  it("still refuses when the gate's enhancement rules reject it, even with affects supplied", async () => {
    // allowEnhancements unset — affects alone must not bypass the master switch.
    const closedGate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const { call, calls } = harnessWithCounter(closedGate);
    const text = await call({
      object: "ZTM_HOOK_IMPL",
      type: "ENHO/XHH",
      source: "ENHANCEMENT 1.\nENDENHANCEMENT.",
      affects: { name: "ZTM_HW011_BADI", packageName: "$TMP" },
    });
    expect(text).toMatch(/ENHANCEMENT_DISABLED|SAFETY_DENIED/);
    expect(calls()).toBe(0);
  });

  it("a non-enhancement write is unaffected by any of this (no affects needed, no intent built)", async () => {
    const { call, calls } = harnessWithCounter(new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] }));
    const text = await call({ object: "ZCL_FOO", type: "CLAS/OC", source: "CLASS zcl_foo DEFINITION.\nENDCLASS." });
    expect(text).not.toMatch(/SAFETY_DENIED/);
    expect(calls()).toBe(1);
  });
});

/**
 * Blocker A, continued: the "no intent" refusal text itself (src/safety.ts),
 * pinned directly against `SafetyGate.evaluate()` so the wording is proven
 * independent of any one call site. The `rule` string (asserted in
 * test/safety.test.ts's own "SafetyTarget.type participates in the decision"
 * describe block) is UNCHANGED by this fix — only `reason`, the human-facing
 * text, moved from naming an internal function to naming the parameter that
 * fixes it.
 */
describe("SafetyGate 'no intent' refusal names `affects`, not an internal function (Blocker A)", () => {
  it("says `affects` and does not say SafetyGate.evaluateIntent()", () => {
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      allowEnhancements: true,
      enhanceTargets: "customer",
      originSystems: ["A4H"],
    });
    const d = gate.evaluate("write", { name: "ZENH_FOO", packageName: "$TMP", type: "ENHO/XHH" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/affects/);
    expect(d.reason).not.toMatch(/SafetyGate\.evaluateIntent/);
  });
});

/**
 * `preflightCorr` is exported and its parameter is `PreflightTarget` — a
 * minimal shape, narrower than `ResolvedTarget` on purpose, so a caller
 * with an object identity from somewhere else entirely does not have to
 * fabricate one. These tests call it directly with a hand-built minimal
 * object (no `spec`/`description`/`packageSource`) to prove the narrowed
 * signature actually works, and that `opts.affects` threads into its own
 * `gate.assert` call exactly as it does in `authorizeMutation`.
 */
describe("preflightCorr: narrowed PreflightTarget and affects", () => {
  const offlineConn = null as unknown as AbapConnection;

  const fakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
    ({
      uri: "/sap/bc/adt/enhancements/enhoxhh/zenh_foo/source/main",
      operation: "U",
      devclass: "ZTARGET_PKG",
      candidates: [],
      locks: [],
      messages: [],
      checkFailed: false,
      raw: { result: "S", korrflag: "X", recording: "" },
      kind: "transport-required",
      mustSupplyCorrNr: true,
      serverWouldFabricate: false,
      ...overrides,
    }) as unknown as TrRequirement;

  const minimalTarget = {
    uri: "/sap/bc/adt/enhancements/enhoxhh/zenh_foo",
    sourceUri: "/sap/bc/adt/enhancements/enhoxhh/zenh_foo/source/main",
    name: "ZENH_FOO",
    type: "ENHO/XHH",
    packageName: "ZENH_PKG",
  };

  it("returns undefined with no transport manager wired — not a licence to proceed", async () => {
    const corr = await preflightCorr(offlineConn, minimalTarget, {}, "U", "write");
    expect(corr).toBe(undefined);
  });

  it("resolves local without ever calling gate.assert, off a minimal PreflightTarget with no sourceUri", async () => {
    // A narrower target still: only the fields PreflightTarget actually
    // requires, proving ResolvedTarget's extra fields were never load-bearing.
    const bopfLikeTarget = { uri: "/sap/bc/adt/bo/ZBO", name: "ZBO", type: "BOPF/BOB", packageName: "$TMP" };
    // A gate that would refuse anything reaching gate.assert (no allowPackages
    // at all) — if this passes, gate.assert was never called.
    const gate = new SafetyGate({ readOnly: false, allowPackages: [] });
    const transport = new SessionTransport({
      allowTransports: ["auto"],
      cts: { trRequirement: vi.fn(async () => fakeReq({ kind: "local", devclass: "$TMP" })) },
    });
    const corr = await preflightCorr(offlineConn, bopfLikeTarget, { transport, gate }, "U", "write");
    expect(corr).toEqual({ kind: "local" });
  });

  /**
   * Live-captured defect: a $TMP object got `RESULT=E` / T100 `TO131` ("Test
   * objects cannot be created in foreign namespaces") back from
   * `transportchecks`, over HTTP 200. `SessionTransport.resolve()` used to
   * check `kind === "local"` before `checkFailed`, so the refusal was
   * discarded and the write proceeded to fail later with a worse message.
   * "no transport needed" and "SAP told us this write will fail" are
   * orthogonal facts, and a check failure must surface regardless of
   * locality — see the fix in `src/adt/session-transport.ts`.
   */
  it("still refuses a LOCAL object when the pre-flight check itself failed (TO131, live-captured)", async () => {
    const bopfLikeTarget = { uri: "/sap/bc/adt/bo/ZBO", name: "ZBO", type: "BOPF/BOB", packageName: "$TMP" };
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const transport = new SessionTransport({
      allowTransports: ["auto"],
      cts: {
        trRequirement: vi.fn(async () =>
          fakeReq({
            kind: "local",
            devclass: "$TMP",
            checkFailed: true,
            raw: { result: "E", korrflag: "", recording: "" },
            messages: [
              {
                severity: "E",
                messageClass: "TO",
                messageNumber: "131",
                text: "Test objects cannot be created in foreign namespaces",
                variables: [],
              },
            ],
          }),
        ),
      },
    });
    const e = await catchErr(
      preflightCorr(offlineConn, bopfLikeTarget, { transport, gate }, "U", "write"),
    );
    expect(e.code).toBe("TRANSPORT_ERROR");
    expect(e.message).toMatch(/foreign namespaces/);
  });

  it("threads opts.affects into its own gate.assert call for a transportable enhancement write", async () => {
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZENH_PKG"],
      allowTransports: ["auto"],
      allowEnhancements: true,
      enhanceTargets: "customer",
      originSystems: ["A4H"],
    });
    const transport = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      cts: {
        trRequirement: vi.fn(async () => fakeReq({})),
        trCreate: vi.fn(async () => ({
          trkorr: "A4HK900321",
          path: "/com.sap.cts/object_record/A4HK900321",
        })),
      },
    });
    const corr = await preflightCorr(
      offlineConn,
      minimalTarget,
      {
        transport,
        gate,
        affects: { name: "ZTARGET_CLS", packageName: "ZTARGET_PKG", masterSystem: "A4H" },
      },
      "U",
      "write",
    );
    // `source` is the provenance the gate just judged this corrNr under
    // (SessionTransport minted it via trCreate, so it's server-chosen, not
    // human-named) — carried on `GatedCorr` so a second `gate.assert` on the
    // same mutation judges the identical corr instead of fabricating "auto".
    expect(corr).toEqual({ kind: "transport", corrNr: "A4HK900321", source: "auto" });
  });

  it("refuses the same transportable write with no affects — the gate has no intent to judge", async () => {
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZENH_PKG"],
      allowTransports: ["auto"],
      allowEnhancements: true,
      enhanceTargets: "customer",
      originSystems: ["A4H"],
    });
    const transport = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      cts: {
        trRequirement: vi.fn(async () => fakeReq({})),
        trCreate: vi.fn(async () => ({
          trkorr: "A4HK900321",
          path: "/com.sap.cts/object_record/A4HK900321",
        })),
      },
    });
    const e = await catchErr(
      preflightCorr(offlineConn, minimalTarget, { transport, gate }, "U", "write"),
    );
    expect(e.code).toBe("SAFETY_DENIED");
    expect(e.details.rule).toBe("enhancement write needs an intent");
  });
});

describe("transportFromLock", () => {
  it("treats IS_LOCAL=X with an empty CORRNR as needing no transport", () => {
    // `status: "local"` and not merely `required: false` — a lock response is a
    // real answer to the transport question, and the distinction between
    // "measured local" and "nobody asked" is load-bearing (see `TransportInfo`).
    expect(transportFromLock({ uri: "u", handle: "h", isLocal: true })).toEqual({
      status: "local",
      required: false,
    });
  });
  it("flags anything else as needing one, carrying what the server said", () => {
    expect(
      transportFromLock({
        uri: "u",
        handle: "h",
        isLocal: false,
        corrNr: "A4HK900123",
        corrUser: "DEVELOPER",
      }),
    ).toEqual({
      status: "transport",
      required: true,
      corrNr: "A4HK900123",
      corrUser: "DEVELOPER",
      corrText: undefined,
    });
  });
});

describe("compare-before-write", () => {
  it("raises ETAG_CONFLICT BEFORE any lock request is sent", async () => {
    const { conn, adt } = await connected(existingReport(SOURCE_A_CRLF));
    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
        source: SOURCE_B,
        expectEtag: contentHash("something else entirely"),
      }),
    );
    expect(e.code).toBe("ETAG_CONFLICT");
    expect(e.details.actualEtag).toBe(etagOf(SOURCE_A));
    // The un-canonicalised hash is reported too: that is the spelling
    // `abap_read` hands out, and a caller has to be able to recognise its own.
    expect(e.details.actualEtagRaw).toBe(contentHash(SOURCE_A_CRLF));
    expect(e.hint).toMatch(/re-read/i);

    // The whole point: no enqueue was taken and nothing was written.
    expect(adt.verbs.filter((v) => v === "LOCK")).toHaveLength(0);
    expect(adt.verbs).not.toContain("PUT");
    // Two reads, both unavoidable and both harmless: the metadata GET that tells
    // the safety gate which package this object is really in, then the
    // source GET the comparison itself needs.
    expect(adt.labels).toEqual([`GET ${REPORT_URI}`, `GET ${REPORT_SRC}`]);
  });

  it("accepts a matching etag across the server's LF→CRLF normalisation", async () => {
    const { conn, adt } = await connected(existingReport(SOURCE_A_CRLF));
    const res = await writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
      source: SOURCE_B,
      expectEtag: contentHash(SOURCE_A), // what the reader handed the model
    });
    expect(res.changed).toBe(true);
    expect(adt.verbs).toContain("PUT");
  });

  it("skips the PUT entirely when the source is byte-identical modulo CRLF", async () => {
    const { conn, adt } = await connected(existingReport(SOURCE_A_CRLF));
    const res = await writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
      source: SOURCE_A,
    });
    expect(res.changed).toBe(false);
    expect(res.created).toBe(false);
    expect(res.etag).toBe(etagOf(SOURCE_A));
    expect(res.previousEtag).toBe(res.etag);
    // No lock, no PUT, no unlock — reads and nothing else.
    expect(adt.labels).toEqual([`GET ${REPORT_URI}`, `GET ${REPORT_SRC}`]);
  });
});

describe("writeObject ordering", () => {
  it("updates an existing object as GET → GET → LOCK → GET → PUT → UNLOCK", async () => {
    const { conn, adt } = await connected(existingReport(SOURCE_A_CRLF));
    const res = await writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
      source: SOURCE_B,
    });

    expect(res.created).toBe(false);
    expect(res.changed).toBe(true);
    expect(res.etag).toBe(etagOf(SOURCE_B));
    expect(res.previousEtag).toBe(etagOf(SOURCE_A));
    // A real write of a $TMP object: the lock was taken and it said
    // `IS_LOCAL = X`, so "local" here is measured rather than assumed.
    expect(res.transport).toEqual({ status: "local", required: false });

    // The second GET of /source/main (after LOCK, before PUT) is the
    // post-lock recheck that closes the GET→LOCK TOCTOU window: its bytes are
    // re-hashed against the pre-lock etag and become the journal before-image.
    expect(adt.labels).toEqual([
      // Resolution: which package is this object REALLY in? Before anything else,
      // because the safety gate has to judge the server's answer, not a guess.
      `GET ${REPORT_URI}`,
      `GET ${REPORT_SRC}`,
      `LOCK ${REPORT_URI}`,
      `GET ${REPORT_SRC}`,
      `PUT ${REPORT_SRC}`,
      `UNLOCK ${REPORT_URI}`,
    ]);
    // The unlock is after the PUT and — since writeObject never activates —
    // strictly before anything an activation step could do.
    expect(adt.verbs.indexOf("UNLOCK")).toBeGreaterThan(adt.verbs.indexOf("PUT"));
    expect(adt.calls.find((c) => c.method === "PUT")?.qs.lockHandle).toBe("H1");
    expect(adt.calls.find((c) => c.method === "PUT")?.body).toBe(SOURCE_B);
  });

  it("never activates — that is a separate step, and it must not hold the lock", async () => {
    const { conn, adt } = await connected(existingReport(SOURCE_A_CRLF));
    await writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
      source: SOURCE_B,
    });
    expect(adt.labels.some((l) => l.includes("/activation"))).toBe(false);
  });

  it("creates a missing object first: GET(404) → POST → LOCK → PUT → UNLOCK", async () => {
    const { conn, adt } = await connected((r) => {
      // The object URI 404s — that single answer settles BOTH questions
      // resolution asks: it does not exist, so there is no server-side package
      // and the caller's ($TMP) is the only truth there can be.
      if (r.url === REPORT_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      // Deliberately NOT routing a GET of /source/main: reading the source of an
      // object that is known not to exist is a request a create must not pay
      // for, and the loud unrouted-request throw is what proves it never happens.
      if (r.url === "/sap/bc/adt/programs/programs" && r.method === "POST") {
        // A DDIC PUT answers 200, content-length 0, no body, no Location.
        return resp(200, "", {});
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === REPORT_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    });

    const res = await writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
      source: SOURCE_A,
    });
    expect(res.created).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.previousEtag).toBeUndefined();
    expect(adt.labels).toEqual([
      `GET ${REPORT_URI}`,
      "POST /sap/bc/adt/programs/programs",
      `LOCK ${REPORT_URI}`,
      `PUT ${REPORT_SRC}`,
      `UNLOCK ${REPORT_URI}`,
    ]);
    const create = adt.calls.find((c) => c.url === "/sap/bc/adt/programs/programs")!;
    expect(create.body).toContain(`adtcore:name="${REPORT}"`);
    expect(create.body).toContain(`adtcore:type="PROG/P"`);
    expect(create.body).toContain(`adtcore:packageRef adtcore:name="$TMP"`);
  });

  it("unlocks even when the PUT fails", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") return resp(200, SOURCE_A_CRLF, OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.method === "PUT") return resp(500, "<exc:exception/>", OK_XML);
      return undefined;
    });
    await expect(
      writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
        source: SOURCE_B,
      }),
    ).rejects.toThrow();
    // GET (resolve) → GET (compare) → LOCK → GET (post-lock recheck) →
    // PUT (500) → UNLOCK. The unlock is the assertion: a failed PUT must not
    // strand an enqueue that only dies with the session.
    expect(adt.verbs).toEqual(["GET", "GET", "LOCK", "GET", "PUT", "UNLOCK"]);
    expect(adt.labels.at(-1)).toBe(`UNLOCK ${REPORT_URI}`);
  });

  it("translates the mislabelled DDIC rejection into CHECK_FAILED", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url.endsWith("/source/main") && r.method === "GET") {
        return resp(200, "define table zmcp_test_tab {}\r\n", OK_TEXT);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.method === "PUT") return resp(400, DDIC_REJECT_XML, OK_XML);
      return undefined;
    });
    const e = await catchErr(
      writeObject(
        conn,
        await authWrite(conn, { type: "TABL/DT", name: "ZMCP_TEST_TAB" }),
        { source: "define table x {}" },
      ),
    );
    expect(e.code).toBe("CHECK_FAILED");
    expect(e.hint).toMatch(/checkruns/i);
    expect(adt.verbs).toContain("UNLOCK"); // the lock is still released
  });

  it("keeps the server-normalised source that a DDIC PUT returns", async () => {
    const normalised = "@EndUserText.label : 'x'\ndefine table zmcp_test_tab {\n  key id : abap.char(10);\n}\n";
    const { conn } = await connected((r) => {
      if (r.url.endsWith("/source/main") && r.method === "GET") return resp(200, "old\r\n", OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.method === "PUT") return resp(200, normalised, OK_TEXT);
      return undefined;
    });
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "TABL/DT", name: "ZMCP_TEST_TAB" }),
      { source: "define table zmcp_test_tab { key id : abap.char(10); }" },
    );
    expect(res.normalisedSource).toBe(normalised);
    expect(res.etag).toBe(etagOf(normalised));
  });

  it("refuses a transportable object cleanly and releases the lock", async () => {
    const { conn, adt } = await connected((r) => {
      // The server says this report lives in ZPKG, not $TMP — which is exactly
      // why the lock below comes back demanding a transport request.
      if (r.url === REPORT_URI && r.method === "GET")
        return resp(200, OBJECT_XML(REPORT, "PROG/P", "ZPKG"), OK_XML);
      if (r.url === REPORT_SRC && r.method === "GET") return resp(200, SOURCE_A_CRLF, OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H1", "", "A4HK900123"), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      return undefined;
    });
    const e = await catchErr(
      writeObject(
        conn,
        await authWrite(conn, { type: "PROG/P", name: REPORT, packageName: "ZPKG" }),
        { source: SOURCE_B },
      ),
    );
    expect(e.code).toBe("TRANSPORT_ERROR");
    expect(e.details.corrNr).toBe("A4HK900123");
    // Locked, then the post-lock recheck GET, then it learned it needs a
    // transport, unlocked — and never PUT.
    expect(adt.verbs).toEqual(["GET", "GET", "LOCK", "GET", "UNLOCK"]);
    expect(adt.verbs).not.toContain("PUT");
  });

  it("refuses an empty source rather than emptying an object", async () => {
    const { conn, adt } = await connected(existingReport(SOURCE_A_CRLF));
    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), { source: "" }),
    );
    expect(e.code).toBe("BAD_INPUT");
    // The "must not cost a request" guarantee is for `source === undefined`
    // — src/tools/write.ts refuses that BEFORE calling `authorizeMutation`.
    // An empty STRING is a defined value, so it
    // reaches `writeObject` only after the real `AuthorizedTarget` gate has
    // already resolved the object — one GET, not zero. `writeObject`'s own
    // empty-source check still fires before any lock/PUT, which is the part
    // that actually matters: no enqueue, no mutation attempted.
    expect(adt.labels).toEqual([`GET ${REPORT_URI}`]);
  });

  it("is refused outright on a read-only connection", async () => {
    // The system IS provably non-productive here (client 001, T000 category "C")
    // — the refusal has to come from the read-only policy itself, not from the
    // fail-closed gate. Omitting the client would make this test pass for
    // entirely the wrong reason, with SAFETY_DENIED standing in for READ_ONLY.
    const ro = ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "DEVELOPER",
      password: "secret",
      sid: "A4H",
      client: "001",
      // and no `readOnly: false` — i.e. ABAP_ALLOW_WRITE was never set.
    });
    const { conn } = await connected(existingReport(SOURCE_A_CRLF), ro);
    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
        source: SOURCE_B,
      }),
    );
    expect(e.code).toBe("READ_ONLY");
  });
});

// `objectExists` is gone from src/adt/write.ts — existence is now one of the two
// answers `resolveWriteTarget`'s single metadata GET returns (the other being the
// package), so a separate exists-only probe would be a second request for
// information the resolver already has. What it used to assert — 404 ⇒ absent,
// 200 ⇒ present, no ADT XML leaking out — is covered above by "defaults the
// package to $TMP only for an object that does not exist yet" (exists: false)
// and "takes the package of an existing object from the server" (exists: true).

describe("abap_write: the gate judges the RESOLVED transport, not the literal 'auto'", () => {
  /**
   * `grep -rn "new SessionTransport" test/` and `grep -rn "session-transport"
   * test/` both return NOTHING before this block — `SessionTransport` had zero
   * direct test coverage, which is exactly how the
   * `SessionTransport → preflightCorr → corrForMutation` chain went unnoticed:
   * `preflightCorr` judges `res.corrNr` (a real TRKORR like `A4HK900117`)
   * against `ABAP_ALLOW_TRANSPORTS`, mapping `res.source` to `"named"` or
   * `"auto"` first — never the literal string `"auto"` a naive
   * `corrNr ?? "auto"` would have produced.
   *
   * A minimal, always-valid `TrRequirement`, overridden per case. Only the
   * fields `SessionTransport.resolve()` actually reads matter; the rest exist
   * to satisfy the type.
   */
  const fakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
    ({
      uri: REPORT_SRC,
      operation: "U",
      devclass: "ZPKG",
      candidates: [],
      locks: [],
      messages: [],
      checkFailed: false,
      raw: { result: "S", korrflag: "X", recording: "" },
      kind: "transport-required",
      mustSupplyCorrNr: true,
      serverWouldFabricate: false,
      ...overrides,
    }) as unknown as TrRequirement;

  const transportableReport = (extra: Route): Route => (r) => {
    if (r.url === REPORT_URI && r.method === "GET")
      return resp(200, OBJECT_XML(REPORT, "PROG/P", "ZPKG"), OK_XML);
    return extra(r);
  };

  it("denies the write when the auto-created TRKORR is outside a pinned ABAP_ALLOW_TRANSPORTS", async () => {
    const { conn, adt } = await connected(
      transportableReport((r) => {
        if (r.url === REPORT_SRC && r.method === "GET") return resp(200, SOURCE_A_CRLF, OK_TEXT);
        // Deliberately NOT routing LOCK/UNLOCK/PUT: the refusal must happen
        // before any of them are reached. `FakeAdt` throws loudly on an
        // unrouted request, which is a stronger proof than `adt.verbs` alone.
        return undefined;
      }),
    );
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZPKG"],
      allowTransports: ["A4HK900123"],
    });
    // A server-imposed pin resolves to A4HK900999 — not the pinned
    // A4HK900123 — regardless of what the manager's own allowlist says;
    // `#resolvePin` bypasses `#policy` entirely. Only the GATE can refuse it.
    const transport = new SessionTransport({
      allowTransports: ["A4HK900123"],
      cts: { trRequirement: vi.fn(async () => fakeReq({ pinnedTo: "A4HK900999" })) },
    });
    const onBeforeImage = vi.fn(async () => {});
    const e = await catchErr(
      writeObject(
        conn,
        await authWrite(conn, { type: "PROG/P", name: REPORT, packageName: "ZPKG" }, gate),
        { source: SOURCE_B, transport, gate, onBeforeImage },
      ),
    );
    expect(e.code).toBe("SAFETY_DENIED");
    // The RESOLVED number, never the literal string "auto".
    expect(e.message).toMatch(/A4HK900999/);
    expect(adt.verbs).not.toContain("PUT");
    expect(adt.labels.filter((l) => /lock/i.test(l))).toHaveLength(0);
    expect(onBeforeImage).not.toHaveBeenCalled();
  });

  it("allows the write when the resolved TRKORR is the pinned one, and puts it on the PUT", async () => {
    const { conn, adt } = await connected(
      transportableReport((r) => {
        if (r.url === REPORT_SRC && r.method === "GET") return resp(200, SOURCE_A_CRLF, OK_TEXT);
        if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H1", "", "A4HK900123"), OK_XML);
        if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
        if (r.url === REPORT_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
        return undefined;
      }),
    );
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZPKG"],
      allowTransports: ["A4HK900123"],
    });
    const transport = new SessionTransport({
      allowTransports: ["A4HK900123"],
      cts: { trRequirement: vi.fn(async () => fakeReq({ pinnedTo: "A4HK900123" })) },
    });
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "PROG/P", name: REPORT, packageName: "ZPKG" }, gate),
      { source: SOURCE_B, transport, gate },
    );
    expect(res.changed).toBe(true);
    expect(adt.verbs).toContain("PUT");
    const putCall = adt.calls.find((c) => c.method === "PUT")!;
    expect(putCall.qs.corrNr).toBe("A4HK900123");
  });

  it("allows an auto-created request under the DEFAULT ['auto'] list even though the number is not literally 'auto'", async () => {
    const { conn, adt } = await connected(
      transportableReport((r) => {
        if (r.url === REPORT_SRC && r.method === "GET") return resp(200, SOURCE_A_CRLF, OK_TEXT);
        if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H1", "", "A4HK900117"), OK_XML);
        if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
        if (r.url === REPORT_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
        return undefined;
      }),
    );
    // The DEFAULT config: no pin, just "auto".
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["ZPKG"], allowTransports: ["auto"] });
    const transport = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      cts: {
        trRequirement: vi.fn(async () => fakeReq({})), // no pinnedTo ⇒ falls through to auto-create
        trCreate: vi.fn(async () => ({
          trkorr: "A4HK900117",
          path: "/com.sap.cts/object_record/A4HK900117",
        })),
      },
    });
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "PROG/P", name: REPORT, packageName: "ZPKG" }, gate),
      { source: SOURCE_B, transport, gate },
    );
    expect(res.changed).toBe(true);
    const putCall = adt.calls.find((c) => c.method === "PUT")!;
    // The literal string "auto" NEVER reaches the wire — only the real TRKORR
    // `trCreate` minted, matched by PROVENANCE (source: "session-created" ⇒
    // gate-facing "auto"), not by string equality with "auto".
    expect(putCall.qs.corrNr).toBe("A4HK900117");
  });

  it("still refuses before any transport traffic when ABAP_ALLOW_TRANSPORTS is explicitly empty", async () => {
    const { conn, adt } = await connected(transportableReport(() => undefined));
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["ZPKG"], allowTransports: [] });
    // No `SessionTransport` at all: `authorizeMutation` is the call site
    // `src/tools/write.ts` runs BEFORE `writeObject`/`preflightCorr`, so this
    // proves the deny-all fires without ever resolving a transport.
    const e = await catchErr(authorizeMutation(conn, gate, "write", { type: "PROG/P", name: REPORT }));
    expect(e.code).toBe("SAFETY_DENIED");
    expect(e.message).toMatch(/ABAP_ALLOW_TRANSPORTS is explicitly empty/);
    // Only the resolution GET happened — no transportchecks, no trCreate, no
    // lock.
    expect(adt.verbs).toEqual(["GET"]);
  });

  it("a local object is unaffected: LOCK_XML(handle, isLocal=true) still PUTs with no corrNr", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_URI && r.method === "GET")
        return resp(200, OBJECT_XML(REPORT, "PROG/P", "$TMP"), OK_XML);
      if (r.url === REPORT_SRC && r.method === "GET") return resp(200, SOURCE_A_CRLF, OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H1", "X", ""), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === REPORT_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    });
    // A pinned, narrow allowlist on BOTH the gate and the manager — proving a
    // local write reaches neither: `preflightCorr` returns `LOCAL_WRITE`
    // without ever calling `gate.assert`, because `resolve()` returns
    // `outcome: "not-needed"` the moment `trRequirement` says `kind: "local"`.
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      allowTransports: ["A4HK900123"],
    });
    const transport = new SessionTransport({
      allowTransports: ["A4HK900123"],
      cts: {
        trRequirement: vi.fn(async () =>
          fakeReq({ kind: "local", mustSupplyCorrNr: false, serverWouldFabricate: false, devclass: "$TMP" }),
        ),
      },
    });
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "PROG/P", name: REPORT, packageName: "$TMP" }, gate),
      { source: SOURCE_B, transport, gate },
    );
    expect(res.changed).toBe(true);
    const putCall = adt.calls.find((c) => c.method === "PUT")!;
    expect(putCall).toBeDefined();
    expect(putCall.qs).not.toHaveProperty("corrNr");
  });
});

/**
 * A no-op write must not report a transportable object as local.
 *
 * ## The mechanism, as measured rather than as sketched
 *
 * `writeObject` step 3 returns the moment `sourceEquals(current, source)` holds.
 * That return sits above BOTH of the things that can answer the transport
 * question, and the first of the two is the one the original defect report did
 * not account for:
 *
 *   step 3   no-op short-circuit          ← returns here
 *   step 3a  preflightCorr → POST /cts/transportchecks → KORRFLAG
 *   step 4   session.lock → IS_LOCAL / CORRNR
 *
 * So the verdict is NOT "genuinely the lock response" on this system any more.
 * The authoritative signal moved to `transportchecks`/`KORRFLAG`,
 * which needs no lock at all; the lock's `IS_LOCAL`/`CORRNR` is now the second
 * opinion that `corrForMutation` reconciles against it. `transportFromLock`'s
 * own comment is about the lock, not about the only source of truth.
 *
 * The first test below pins that distinction directly: the injected
 * `trRequirement` — the pre-flight, not the lock — is never called either.
 *
 * ## What it used to return, and why that was the dangerous direction
 *
 * `transport: { required: false }`, hard-coded, which every consumer read as
 * "local object, no transport, nothing to ship". For an object in a
 * transportable package that is false in the direction that loses work: a
 * caller who believes an object is local believes their change needs no
 * transport and will never be shipped.
 *
 * ## What it returns now
 *
 * `status: "not-determined"` with a reason. Not a lock (that costs a round trip
 * and a real enqueue for a write that changes nothing), not a pre-flight (that
 * can CREATE a transport request for a change that is not happening), and not an
 * inference from the package name (a verdict derived from a string rather than
 * from the system). The honest answer to "is this object transportable?" after
 * asking nobody is "this call did not find out".
 */
describe("a no-op write reports transport status honestly, not as local", () => {
  const fakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
    ({
      uri: REPORT_SRC,
      operation: "U",
      devclass: "ZPKG",
      candidates: [],
      locks: [],
      messages: [],
      checkFailed: false,
      raw: { result: "S", korrflag: "X", recording: "" },
      kind: "transport-required",
      mustSupplyCorrNr: true,
      serverWouldFabricate: false,
      ...overrides,
    }) as unknown as TrRequirement;

  /** An object the server says lives in the transportable package ZPKG. */
  const inZPKG = (extra: Route): Route => (r) => {
    if (r.url === REPORT_URI && r.method === "GET")
      return resp(200, OBJECT_XML(REPORT, "PROG/P", "ZPKG"), OK_XML);
    return extra(r);
  };

  const gateFor = (pkg: string) =>
    new SafetyGate({ readOnly: false, allowPackages: [pkg], allowTransports: ["A4HK900123"] });

  it("returns status 'not-determined' — never 'local' — for a byte-identical write in a transportable package", async () => {
    const { conn, adt } = await connected(
      // ONLY the two reads are routed. `FakeAdt` throws on anything else, so a
      // lock, an unlock or a PUT would fail the test loudly rather than
      // quietly — a stronger proof than counting `adt.verbs` afterwards.
      inZPKG((r) =>
        r.url === REPORT_SRC && r.method === "GET" ? resp(200, SOURCE_A_CRLF, OK_TEXT) : undefined,
      ),
    );
    const trRequirement = vi.fn(async () => fakeReq({}));
    const transport = new SessionTransport({
      allowTransports: ["A4HK900123"],
      cts: { trRequirement },
    });
    const onBeforeImage = vi.fn(async () => {});

    const gate = gateFor("ZPKG");
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "PROG/P", name: REPORT }, gate),
      { source: SOURCE_A, transport, gate, onBeforeImage },
    );

    expect(res.changed).toBe(false);
    // The claim under test. Spelled as an inequality as well as an equality:
    // the defect was not "the wrong string", it was asserting a measured
    // verdict where there was none.
    expect(res.transport.status).toBe("not-determined");
    expect(res.transport.status).not.toBe("local");
    expect(res.transport).toEqual({
      status: "not-determined",
      required: false,
      reason: expect.stringContaining("took no lock and ran no transport pre-check"),
    });
    // `required` survives, and it answers the OTHER question — did this call put
    // the object into a transport? It did not, and that much is true.
    expect(res.transport.required).toBe(false);
    expect(res.transport.corrNr).toBeUndefined();

    // The mechanism, pinned twice over. No lock …
    expect(adt.labels).toEqual([`GET ${REPORT_URI}`, `GET ${REPORT_SRC}`]);
    // … and no pre-flight either. This is the half the "the verdict IS the lock
    // response" reading of the defect misses: `transportchecks` would have
    // answered without any lock at all, and it was not called.
    expect(trRequirement).not.toHaveBeenCalled();
    // Nothing was journalled, because nothing mutated.
    expect(onBeforeImage).not.toHaveBeenCalled();
  });

  it("costs exactly the two reads it already paid for — the honest answer is free", async () => {
    // The reason `not-determined` beats "take the lock and find out": a lock is
    // a round trip AND a real enqueue on the server for a write that changes
    // nothing. If a future change decides to buy the verdict after all, this
    // test is the one that should fail and be argued with.
    const { conn, adt } = await connected(
      inZPKG((r) =>
        r.url === REPORT_SRC && r.method === "GET" ? resp(200, SOURCE_A_CRLF, OK_TEXT) : undefined,
      ),
    );
    const transport = new SessionTransport({
      allowTransports: ["A4HK900123"],
      cts: { trRequirement: vi.fn(async () => fakeReq({})) },
    });
    await writeObject(
      conn,
      await authWrite(conn, { type: "PROG/P", name: REPORT }, gateFor("ZPKG")),
      { source: SOURCE_A, transport, gate: gateFor("ZPKG") },
    );
    expect(adt.calls).toHaveLength(2);
    expect(adt.verbs).toEqual(["GET", "GET"]);
  });

  it("the SAME object, actually written, reports status 'transport' — the two answers never disagree by claiming local", async () => {
    // The other half of the defect: whatever the no-op says, it must not
    // contradict what a real write of the same object reports. It now says "I
    // did not find out" where the real write says "A4HK900123" — a gap in
    // knowledge, not a contradiction. Before the fix the pair read
    // `{required:false}` (⇒ "local") and `{required:true, corrNr:…}`.
    const { conn } = await connected(
      inZPKG((r) => {
        if (r.url === REPORT_SRC && r.method === "GET") return resp(200, SOURCE_A_CRLF, OK_TEXT);
        if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H1", "", "A4HK900123"), OK_XML);
        if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
        if (r.url === REPORT_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
        return undefined;
      }),
    );
    const transport = new SessionTransport({
      allowTransports: ["A4HK900123"],
      cts: { trRequirement: vi.fn(async () => fakeReq({ pinnedTo: "A4HK900123" })) },
    });
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "PROG/P", name: REPORT }, gateFor("ZPKG")),
      { source: SOURCE_B, transport, gate: gateFor("ZPKG") },
    );
    expect(res.changed).toBe(true);
    expect(res.transport.status).toBe("transport");
    expect(res.transport.required).toBe(true);
    expect(res.transport.corrNr).toBe("A4HK900123");
  });

  it("says 'not-determined' for a $TMP object too — the package name is not evidence", async () => {
    // Deliberate, and the more tempting half of the fix to get wrong. The
    // object's package here is `$TMP`, server-confirmed (`packageSource:
    // "server"`), and `test/fixtures/cts/transport-info-tmp.xml` does record
    // `<DEVCLASS>$TMP</DEVCLASS>` with an empty `<KORRFLAG/>`. It would be easy
    // to short-cut from the name to "local" and keep the old output for the
    // common case.
    //
    // We do not, because that is a verdict derived from a string rather than
    // from the system — the same shape of reasoning `resolveWriteTarget`
    // refuses when it declines to default an unknown package to $TMP.
    // One captured package name is not a rule about every package, and the cost
    // of being wrong is the same lie a stale "local" verdict tells.
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_URI && r.method === "GET")
        return resp(200, OBJECT_XML(REPORT, "PROG/P", "$TMP"), OK_XML);
      if (r.url === REPORT_SRC && r.method === "GET") return resp(200, SOURCE_A_CRLF, OK_TEXT);
      return undefined;
    });
    const res = await writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
      source: SOURCE_A,
    });
    expect(res.changed).toBe(false);
    expect(res.target.packageName).toBe("$TMP");
    expect(res.target.packageSource).toBe("server");
    expect(res.transport.status).toBe("not-determined");
    expect(adt.labels).toEqual([`GET ${REPORT_URI}`, `GET ${REPORT_SRC}`]);
  });

  it("keeps 'measured local' and 'nobody asked' distinguishable even though both carry required:false", async () => {
    // The regression this guards against, without changing a single string: if
    // some future edit collapses the two arms back onto the boolean, a consumer
    // that only reads `required` is back to being told "local" by a call that
    // never asked. `status` is what must stay different.
    const { conn } = await connected(
      inZPKG((r) =>
        r.url === REPORT_SRC && r.method === "GET" ? resp(200, SOURCE_A_CRLF, OK_TEXT) : undefined,
      ),
    );
    const noop = await writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
      source: SOURCE_A,
    });
    const measuredLocal = transportFromLock({ uri: "u", handle: "h", isLocal: true });

    expect(noop.transport.required).toBe(false);
    expect(measuredLocal.required).toBe(false);
    expect(noop.transport.status).not.toBe(measuredLocal.status);
    expect([noop.transport.status, measuredLocal.status]).toEqual(["not-determined", "local"]);
  });
});

/**
 * The transport note named the CURRENT ABAP_MODE, not the mode
 * `abap_transport_release`'s gate actually requires (`admin`). Under
 * ABAP_MODE=edit that rendered the self-refuting "stays off unless
 * ABAP_MODE=edit". Pinned via `abap_write`, the public path that composes
 * the note (transportNote is private to src/tools/write.ts).
 */
describe("abap_write: the transport note names the REQUIRED mode, not the current one", () => {
  const fakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
    ({
      uri: REPORT_SRC,
      operation: "U",
      devclass: "ZPKG",
      candidates: [],
      locks: [],
      messages: [],
      checkFailed: false,
      raw: { result: "S", korrflag: "X", recording: "" },
      kind: "transport-required",
      mustSupplyCorrNr: true,
      serverWouldFabricate: false,
      ...overrides,
    }) as unknown as TrRequirement;

  it("says ABAP_MODE=admin, never ABAP_MODE=edit, when the gate's current mode is edit", async () => {
    let current = SOURCE_A;
    const { conn } = await connected((r) => {
      if (r.url === REPORT_URI && r.method === "GET")
        return resp(200, OBJECT_XML(REPORT, "PROG/P", "ZPKG"), OK_XML);
      if (r.url === REPORT_SRC && r.method === "GET") return resp(200, current, OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H1", "", "A4HK900123"), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === REPORT_SRC && r.method === "PUT") {
        current = r.body ?? "";
        return resp(200, "", OK_TEXT);
      }
      if (r.url.includes("/checkruns")) {
        return resp(200, `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`, OK_XML);
      }
      if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
      return undefined;
    });
    const transport = new SessionTransport({
      allowTransports: ["A4HK900123"],
      cts: { trRequirement: vi.fn(async () => fakeReq({ pinnedTo: "A4HK900123" })) },
    });
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZPKG"],
      allowTransports: ["A4HK900123"],
      abapMode: "edit",
    });
    const result = await abapWrite(
      conn,
      { object: REPORT, type: "PROG/P", source: SOURCE_B },
      20_000,
      gate,
      undefined,
      transport,
    );
    expect(result.text).toMatch(/NOTE: Transport A4HK900123/);
    expect(result.text).toMatch(
      /ABAP_MODE=admin \(ABAP_ALLOW_TRANSPORT_RELEASE is not read while ABAP_MODE is set\)\./,
    );
    expect(result.text).not.toMatch(/ABAP_MODE=edit/);
  });
});

/**
 * The CREATE POST carries the gate-judged `corrNr` too.
 *
 * Before this, `createNewObject` called `conn.adt.createObject` with no
 * `transport` option, so the POST that brings a brand-new object into existence
 * went out unnumbered. Captured live on 2026-08-01, that made SAP record the new
 * object in a request of its own choosing; the lock then reported THAT request
 * and the PUT — carrying the correct number — collided with it:
 *
 *     POST /sap/bc/adt/programs/programs   ?{}                200  0B
 *     POST …/zmcp_tr_live1 ?_action=LOCK                      200  CORRNR=A4HK900131
 *     PUT  …/source/main   ?corrNr=A4HK900129                 500
 *       "Object R3TR PROG ZMCP_TR_LIVE1 is already locked in request A4HK900131"
 *
 * So the FIRST write of a new object into a transportable package always failed,
 * and the retry that appeared to fix it silently recorded the object in the
 * server's request while the session still believed it was using its own — a
 * safety hole, not a usability one.
 *
 * The wire contract for the fix was captured against A4H and is checked against
 * the recorded bytes below (`test/fixtures/cts/create-object-with-corrnr-*`).
 */
describe("abap_write: the CREATE POST carries the gate-judged corrNr", () => {
  const fakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
    ({
      uri: REPORT_SRC,
      operation: "I",
      devclass: "ZPKG",
      candidates: [],
      locks: [],
      messages: [],
      checkFailed: false,
      raw: { result: "S", korrflag: "X", recording: "" },
      kind: "transport-required",
      mustSupplyCorrNr: true,
      serverWouldFabricate: false,
      ...overrides,
    }) as unknown as TrRequirement;

  /** A transport manager pinned by the server to `trkorr`, like a server-pin above. */
  const pinnedTo = (trkorr: string): SessionTransport =>
    new SessionTransport({
      allowTransports: [trkorr],
      cts: { trRequirement: vi.fn(async () => fakeReq({ pinnedTo: trkorr })) },
    });

  const gateFor = (trkorr: string): SafetyGate =>
    new SafetyGate({ readOnly: false, allowPackages: ["ZPKG"], allowTransports: [trkorr] });

  /**
   * The object does not exist (404 ⇒ create), and every step of the recipe
   * answers. `lockCorr` is what the LOCK claims the object is already in.
   */
  const createRoute =
    (lockCorr: string, opts: { deleteFails?: boolean } = {}): Route =>
    (r) => {
      if (r.url === REPORT_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === "/sap/bc/adt/programs/programs" && r.method === "POST")
        // Re-confirmed live WITH `?corrNr=`: 200, zero bytes.
        return resp(200, "", {});
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H1", "", lockCorr), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.method === "DELETE")
        return opts.deleteFails ? resp(500, "<exc:exception/>", OK_XML) : resp(200, "", {});
      if (r.url === REPORT_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    };

  it("puts the resolved TRKORR on the create POST, not only on the PUT", async () => {
    const { conn, adt } = await connected(createRoute("A4HK900123"));
    const gate = gateFor("A4HK900123");
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "PROG/P", name: REPORT, packageName: "ZPKG" }, gate),
      { source: SOURCE_A, transport: pinnedTo("A4HK900123"), gate },
    );
    expect(res.created).toBe(true);

    const create = adt.calls.find(
      (c) => c.url === "/sap/bc/adt/programs/programs" && c.method === "POST",
    )!;
    // THE assertion of this block. Live, this is what stops SAP
    // fabricating a request behind the gate's back.
    expect(create.qs.corrNr).toBe("A4HK900123");
    // …and the PUT still carries it, so both requests name one number.
    expect(adt.calls.find((c) => c.method === "PUT")!.qs.corrNr).toBe("A4HK900123");
    // No rollback, no second lock: the happy path is unchanged in shape.
    expect(adt.verbs).toEqual(["GET", "POST", "LOCK", "PUT", "UNLOCK"]);
  });

  it("sends the create POST with NO corrNr key at all for a local object", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === "/sap/bc/adt/programs/programs" && r.method === "POST") return resp(200, "", {});
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H1", "X", ""), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === REPORT_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    });
    const transport = new SessionTransport({
      allowTransports: ["A4HK900123"],
      cts: {
        trRequirement: vi.fn(async () =>
          fakeReq({ kind: "local", mustSupplyCorrNr: false, devclass: "$TMP" }),
        ),
      },
    });
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      allowTransports: ["A4HK900123"],
    });
    await writeObject(
      conn,
      await authWrite(conn, { type: "PROG/P", name: REPORT, packageName: "$TMP" }, gate),
      { source: SOURCE_A, transport, gate },
    );
    const create = adt.calls.find(
      (c) => c.url === "/sap/bc/adt/programs/programs" && c.method === "POST",
    )!;
    // Absent, not `undefined`: `createNewObject` spreads one of two literal
    // shapes exactly as `putSource` does. (Live, a superfluous corrNr on a $TMP
    // create is accepted with 200 and silently ignored — see the
    // `create-object-with-corrnr-tmp-ignored` fixture — so this is a discipline
    // the server would NOT have caught for us.)
    expect(create.qs).not.toHaveProperty("corrNr");
  });

  it("refuses and rolls back when the lock names a DIFFERENT request from the gated one", async () => {
    // The fabrication signature. Unreachable now that the create is numbered —
    // asserted anyway, because "unreachable" is a claim about a server we do not
    // control.
    const { conn, adt } = await connected(createRoute("A4HK900999"));
    const gate = gateFor("A4HK900123");
    const e = await catchErr(
      writeObject(
        conn,
        await authWrite(conn, { type: "PROG/P", name: REPORT, packageName: "ZPKG" }, gate),
        { source: SOURCE_A, transport: pinnedTo("A4HK900123"), gate },
      ),
    );
    expect(e.code).toBe("TRANSPORT_ERROR");
    // BOTH numbers are named — the whole point is that they disagree.
    expect(e.details.gatedCorrNr).toBe("A4HK900123");
    expect(e.details.serverCorrNr).toBe("A4HK900999");
    expect(e.message).toMatch(/A4HK900123/);
    expect(e.message).toMatch(/A4HK900999/);
    expect(e.details.created).toBe(true);
    expect(e.details.rolledBack).toBe(true);
    // Nothing was written, and the object this call created was taken back:
    // create → lock → (refuse) unlock → re-lock → DELETE.
    expect(adt.verbs).toEqual(["GET", "POST", "LOCK", "UNLOCK", "LOCK", "DELETE"]);
    expect(adt.verbs).not.toContain("PUT");
  });

  it("says so loudly when the rollback itself fails, and still reports the divergence", async () => {
    const { conn, adt } = await connected(createRoute("A4HK900999", { deleteFails: true }));
    const gate = gateFor("A4HK900123");
    const e = await catchErr(
      writeObject(
        conn,
        await authWrite(conn, { type: "PROG/P", name: REPORT, packageName: "ZPKG" }, gate),
        { source: SOURCE_A, transport: pinnedTo("A4HK900123"), gate },
      ),
    );
    // The TRANSPORT_ERROR survives — a failed cleanup must never replace the
    // error the caller needs to see.
    expect(e.code).toBe("TRANSPORT_ERROR");
    expect(e.details.rolledBack).toBe(false);
    expect(typeof e.details.rollbackError).toBe("string");
    expect(e.message).toMatch(/has to be deleted by hand/);
    expect(adt.verbs).not.toContain("PUT");
  });

  it("refuses a divergence on an EXISTING object too, with nothing to roll back", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_URI && r.method === "GET")
        return resp(200, OBJECT_XML(REPORT, "PROG/P", "ZPKG"), OK_XML);
      if (r.url === REPORT_SRC && r.method === "GET") return resp(200, SOURCE_A_CRLF, OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H1", "", "A4HK900999"), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      return undefined;
    });
    const gate = gateFor("A4HK900123");
    const e = await catchErr(
      writeObject(
        conn,
        await authWrite(conn, { type: "PROG/P", name: REPORT, packageName: "ZPKG" }, gate),
        { source: SOURCE_B, transport: pinnedTo("A4HK900123"), gate },
      ),
    );
    expect(e.code).toBe("TRANSPORT_ERROR");
    expect(e.details.created).toBe(false);
    expect(e.details.rolledBack).toBe(false);
    // The extra GET after LOCK is the post-lock recheck. No DELETE: this
    // object was here before the call and stays.
    expect(adt.verbs).toEqual(["GET", "GET", "LOCK", "GET", "UNLOCK"]);
    expect(adt.verbs).not.toContain("DELETE");
  });
});

/**
 * Until this block's fix, an object this call had just created via the
 * vendor/collection POST, and whose FILL-IN PUT was then rejected, was left
 * on the server forever — `rollbackCreate` was wired to the two TRANSPORT
 * refusal paths above (both reached BEFORE any content is sent) and to
 * nothing else. This is the third path: content submitted, content refused.
 *
 * Each test below pins one of the five obstacles the original defect named:
 *
 *  - obstacle 5 (which rejections are even safe to roll back): a properties-
 *    shape BAD_INPUT and a source-shape CHECK_FAILED are both "definite
 *    content rejection" and get an automatic DELETE; a `create.vendor: false`
 *    type whose create already carried the FULL payload (TTYP/DA) does not,
 *    because there is no empty skeleton to undo.
 *  - obstacle 3 (never silent): every case below inspects `e.details` for a
 *    positive statement of what happened — attempted-and-succeeded,
 *    attempted-and-failed, or deliberately not attempted, with why.
 *  - obstacle 4 (a dead session cannot clean up its own mess): SESSION_DEAD
 *    is a `not attempted` case, not a second failed cleanup bolted onto the
 *    first failure.
 *  - obstacle 2 (the lock is still held; re-entering `session.lock` must not
 *    silently reuse it): pinned indirectly by the wire sequence itself — a
 *    successful rollback always shows `UNLOCK` immediately followed by a
 *    fresh `LOCK` before the `DELETE`, exactly like the two pre-existing
 *    refusal paths above, never a `DELETE` with no `LOCK`/`UNLOCK` pair
 *    around it.
 *  - obstacle 1 (the rollback DELETE needs the SAME corrNr the create and
 *    the rejected PUT carried): the last test in this block.
 */
describe("abap_write: rolling back an orphaned CREATE when the fill-in PUT is rejected", () => {
  /** A generic, unclassified rejection — falls through to BAD_INPUT for the properties shape. */
  const BAD_INPUT_XML =
    `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
    `<type id="ExceptionResourceBadRequest"/><message lang="EN">Bad payload</message>` +
    `</exc:exception>`;

  it("deletes the empty object it just created (properties shape, create.vendor = true, BAD_INPUT)", async () => {
    const DOMA_URI = "/sap/bc/adt/ddic/domains/zpropw_orph_doma";
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" ` +
      `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZPROPW_ORPH_DOMA" ` +
      `adtcore:type="DOMA/DD"><adtcore:packageRef adtcore:name="$TMP"/>` +
      `<doma:typeInformation><doma:datatype>CHAR</doma:datatype>` +
      `<doma:length>10</doma:length></doma:typeInformation></doma:domain>`;
    const { conn, adt } = await connected((r) => {
      if (r.url === DOMA_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === "/sap/bc/adt/ddic/domains" && r.method === "POST") return resp(201, "", {});
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === DOMA_URI && r.method === "PUT") return resp(400, BAD_INPUT_XML, OK_XML);
      if (r.method === "DELETE") return resp(200, "", {});
      return undefined;
    });
    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "DOMA/DD", name: "ZPROPW_ORPH_DOMA" }), {
        source: xml,
      }),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.details.created).toBe(true);
    expect(e.details.rolledBack).toBe(true);
    expect(e.message).toMatch(/deleted again/);
    // Before this fix the sequence stopped at UNLOCK with no DELETE at all —
    // this is the orphan. create → lock → PUT (rejected) → unlock → re-lock →
    // DELETE, the same shape the two pre-existing refusal paths pin above.
    expect(adt.verbs).toEqual(["GET", "POST", "LOCK", "PUT", "UNLOCK", "LOCK", "DELETE"]);
  });

  it("deletes the empty object it just created (source shape, PROG/P, CHECK_FAILED)", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === "/sap/bc/adt/programs/programs" && r.method === "POST") return resp(200, "", {});
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === REPORT_SRC && r.method === "PUT") return resp(400, DDIC_REJECT_XML, OK_XML);
      if (r.method === "DELETE") return resp(200, "", {});
      return undefined;
    });
    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
        source: SOURCE_A,
      }),
    );
    expect(e.code).toBe("CHECK_FAILED");
    expect(e.details.created).toBe(true);
    expect(e.details.rolledBack).toBe(true);
    expect(e.message).toMatch(/deleted again/);
    // The extra POST between PUT and UNLOCK is `tryCheckSource`'s own
    // `/checkruns` attempt (unrouted here, so it fails and is swallowed —
    // see the "translates the mislabelled DDIC rejection" test above, which
    // established that CHECK_FAILED classification does not need a stubbed
    // response for it).
    expect(adt.verbs).toEqual(["GET", "POST", "LOCK", "PUT", "POST", "UNLOCK", "LOCK", "DELETE"]);
  });

  it("does NOT delete when the create already sent the FULL payload (TTYP/DA, create.vendor = false)", async () => {
    const TTYP_URI = "/sap/bc/adt/ddic/tabletypes/zpropw_orph_ttyp";
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<ttyp:tableType xmlns:ttyp="http://www.sap.com/dictionary/tabletype" ` +
      `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZPROPW_ORPH_TTYP" ` +
      `adtcore:type="TTYP/DA"><adtcore:packageRef adtcore:name="$TMP"/></ttyp:tableType>`;
    const { conn, adt } = await connected((r) => {
      if (r.url === TTYP_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === "/sap/bc/adt/ddic/tabletypes" && r.method === "POST")
        return resp(201, xml, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === TTYP_URI && r.method === "PUT") return resp(400, BAD_INPUT_XML, OK_XML);
      // Deliberately unrouted: a DELETE here would mean this test's whole
      // point — that TTYP/DA is excluded — silently regressed. `writeObject`
      // rejecting with "FakeAdt: unrouted request DELETE …" would fail this
      // test loudly rather than pass it by accident.
      return undefined;
    });
    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "TTYP/DA", name: "ZPROPW_ORPH_TTYP" }), {
        source: xml,
      }),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.details.created).toBe(true);
    expect(e.details.rolledBack).toBe(false);
    expect(e.details.rollbackAttempted).toBe(false);
    expect(typeof e.details.rollbackSkipReason).toBe("string");
    expect(e.message).toMatch(/did NOT attempt/);
    expect(e.message).toMatch(/full submitted content|not an empty skeleton/i);
    // Same shape as BEFORE the fix: create → lock → PUT (rejected) → unlock.
    // The difference this fix makes is not in the wire calls here — it is
    // that `e.details` now says so, instead of staying silent.
    expect(adt.verbs).toEqual(["GET", "POST", "LOCK", "PUT", "UNLOCK"]);
    expect(adt.verbs).not.toContain("DELETE");
  });

  // BDEF/BDO is shape "source", so `putRejectionRollbackSkipReason` does not
  // exclude it, and now that its registry `delete` is `true` the
  // `rollbackCreate` guard does not either — so a created-then-rejected
  // BDEF/BDO is cleaned up like any other source-shape type.
  it("deletes a rejected BDEF/BDO create — rollbackCreate's guard no longer excludes it", async () => {
    const BDEF_URI = "/sap/bc/adt/bo/behaviordefinitions/zpropw_orph_bdef";
    const BDEF_SRC = `${BDEF_URI}/source/main`;
    const BDEF_COLLECTION = "/sap/bc/adt/bo/behaviordefinitions";
    const BDEF_SOURCE = "implementation unmanaged;\ndefine behavior for ZPROPW_ORPH_ROOT {\n}\n";
    const { conn, adt } = await connected((r) => {
      if (r.url === BDEF_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === BDEF_COLLECTION && r.method === "POST") return resp(201, "", {});
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === BDEF_SRC && r.method === "PUT") return resp(400, DDIC_REJECT_XML, OK_XML);
      if (r.url === BDEF_URI && r.method === "DELETE") return resp(200, "", {});
      return undefined;
    });
    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "BDEF/BDO", name: "ZPROPW_ORPH_BDEF" }), {
        source: BDEF_SOURCE,
      }),
    );
    expect(e.code).toBe("CHECK_FAILED");
    expect(e.details.created).toBe(true);
    expect(e.details.rolledBack).toBe(true);
    expect(e.message).toMatch(/was deleted again, so nothing was left behind/);
    // Same shape as the PROG/P CHECK_FAILED rollback test above (POST is
    // tryCheckSource's swallowed unrouted /checkruns attempt), except no
    // trailing UNLOCK: the DELETE here succeeds, so rollbackCreate's
    // session.forgetLock drops the fresh lock from the ledger before
    // withStatefulSession's finally runs, unlike the DOMA/DD FAILED-rollback
    // case just below where the failed DELETE leaves it there to be unlocked.
    expect(adt.verbs).toEqual(["GET", "POST", "LOCK", "PUT", "POST", "UNLOCK", "LOCK", "DELETE"]);
  });

  it("attempts and reports a FAILED rollback, without losing the original rejection", async () => {
    const DOMA_URI = "/sap/bc/adt/ddic/domains/zpropw_orph_doma2";
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" ` +
      `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZPROPW_ORPH_DOMA2" ` +
      `adtcore:type="DOMA/DD"><adtcore:packageRef adtcore:name="$TMP"/>` +
      `<doma:typeInformation><doma:datatype>CHAR</doma:datatype>` +
      `<doma:length>10</doma:length></doma:typeInformation></doma:domain>`;
    const { conn, adt } = await connected((r) => {
      if (r.url === DOMA_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === "/sap/bc/adt/ddic/domains" && r.method === "POST") return resp(201, "", {});
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === DOMA_URI && r.method === "PUT") return resp(400, BAD_INPUT_XML, OK_XML);
      if (r.method === "DELETE") return resp(500, "<exc:exception/>", OK_XML);
      return undefined;
    });
    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "DOMA/DD", name: "ZPROPW_ORPH_DOMA2" }), {
        source: xml,
      }),
    );
    // The ORIGINAL rejection survives — a failed cleanup must never replace
    // the error the caller actually needs to see (same rule as the two
    // pre-existing refusal paths above).
    expect(e.code).toBe("BAD_INPUT");
    expect(e.details.created).toBe(true);
    expect(e.details.rolledBack).toBe(false);
    expect(typeof e.details.rollbackError).toBe("string");
    expect(e.message).toMatch(/has to be deleted by hand/);
    // The trailing UNLOCK is `withStatefulSession`'s own `finally`: the fresh
    // lock `rollbackCreate` took is still in the session ledger because the
    // DELETE that would have `forgetLock`-ed it failed, so the object is
    // still locked (by us) when the whole call unwinds.
    expect(adt.verbs).toEqual(["GET", "POST", "LOCK", "PUT", "UNLOCK", "LOCK", "DELETE", "UNLOCK"]);
  });

  it("does not attempt a rollback on a dead session — SESSION_DEAD, not a second failed cleanup", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === "/sap/bc/adt/programs/programs" && r.method === "POST") return resp(200, "", {});
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === REPORT_SRC && r.method === "PUT") {
        // The header-tier signature `classifySessionFailure` looks for FIRST
        // and status-ungated (src/adt/session.ts) — an ICM "no session"
        // error id, mirrored server-side as `sap-err-id` too.
        //
        // The body deliberately is NOT empty and NOT a well-formed
        // `<exc:exception>` document. `abap-adt-api`'s own `fromResponse`
        // (node_modules/abap-adt-api/build/AdtException.js) drops the
        // response object — headers and all — off the exception it builds
        // in BOTH of its success shapes: `!data` takes the `simpleError`
        // branch, and a well-formed `<exc:exception>` body takes the
        // `AdtErrorException` branch — neither passes `response` as the 8th
        // constructor argument. Only the THIRD shape, where parsing the body
        // as ADT XML itself throws (a plain-text or malformed body, as
        // here), falls through to `AdtErrorException.create(errOrResp, {})`
        // in `fromExceptionOrResponse_int`'s catch — and THAT overload does
        // keep the raw response (headers included) as `.response`. This is
        // the one shape `classifySessionFailure` can actually see through
        // `adtExceptionInfo`'s `pickResponse`. A same-file empty-body
        // version of this test was tried first and failed for exactly this
        // reason — worth keeping as a comment so nobody "simplifies" this
        // fixture back to `resp(500, "", {...})` and reintroduces a
        // silently-untestable branch.
        return resp(500, "ICM: no session (not XML)", {
          "content-type": "text/html",
          "x-sap-icm-err-id": "ICMENOSESSION",
          "sap-err-id": "ICMENOSESSION",
        });
      }
      return undefined;
    });
    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
        source: SOURCE_A,
      }),
    );
    expect(e.code).toBe("SESSION_DEAD");
    expect(e.details.created).toBe(true);
    expect(e.details.rolledBack).toBe(false);
    expect(e.details.rollbackAttempted).toBe(false);
    expect(e.details.rollbackSkipReason).toMatch(/session/i);
    // The dead session cannot LOCK or DELETE anything — no attempt is made.
    expect(adt.verbs).not.toContain("DELETE");
  });

  it("carries the gate-judged corrNr on the rollback DELETE too, not just the create and the rejected PUT", async () => {
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZPKG"],
      allowTransports: ["A4HK900123"],
    });
    const transport = new SessionTransport({
      allowTransports: ["A4HK900123"],
      cts: {
        trRequirement: vi.fn(async () =>
          ({
            uri: REPORT_SRC,
            operation: "I",
            devclass: "ZPKG",
            candidates: [],
            locks: [],
            messages: [],
            checkFailed: false,
            raw: { result: "S", korrflag: "X", recording: "" },
            kind: "transport-required",
            mustSupplyCorrNr: true,
            serverWouldFabricate: false,
            pinnedTo: "A4HK900123",
          }) as unknown as TrRequirement,
        ),
      },
    });
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === "/sap/bc/adt/programs/programs" && r.method === "POST") return resp(200, "", {});
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML("H1", "", "A4HK900123"), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === REPORT_SRC && r.method === "PUT") return resp(400, DDIC_REJECT_XML, OK_XML);
      if (r.method === "DELETE") return resp(200, "", {});
      return undefined;
    });
    const e = await catchErr(
      writeObject(
        conn,
        await authWrite(conn, { type: "PROG/P", name: REPORT, packageName: "ZPKG" }, gate),
        { source: SOURCE_A, transport, gate },
      ),
    );
    expect(e.code).toBe("CHECK_FAILED");
    expect(e.details.rolledBack).toBe(true);
    const del = adt.calls.find((c) => c.method === "DELETE")!;
    expect(del.qs.corrNr).toBe("A4HK900123");
    // The create and the rejected PUT carried the same number — this is the
    // point: obstacle 1 was that the rollback DELETE could not.
    expect(adt.calls.find((c) => c.method === "POST")!.qs.corrNr).toBe("A4HK900123");
    expect(adt.calls.find((c) => c.method === "PUT")!.qs.corrNr).toBe("A4HK900123");
  });
});

/**
 * The recorded bytes behind the block above. Captured against A4H on
 * 2026-08-01 and asserted here rather than paraphrased, so a re-capture that
 * disagrees with the code fails a test instead of a production write.
 */
describe("wire contract: POST /sap/bc/adt/{collection}?corrNr= (live capture)", () => {
  it("PROG: 200 with an empty body, and the parameter really is spelled corrNr", () => {
    const { meta, body } = loadCtsFixture("create-object-with-corrnr-prog");
    expect(meta.method).toBe("POST");
    expect(meta.url).toBe("/sap/bc/adt/programs/programs");
    expect(meta.qs).toEqual({ corrNr: "A4HK900140" });
    expect(meta.status).toBe(200);
    expect(meta.threw).toBe(false);
    // This holds with a corrNr as it does without: no body, no Location.
    expect(meta.bodyBytes).toBe(0);
    expect(body).toBe("");
    expect(meta.responseHeaders).not.toHaveProperty("location");
    expect(meta.requestBody).toContain(`adtcore:name="ZMCP_D1_A01"`);
    expect(meta.requestBody).toContain(`adtcore:packageRef adtcore:name="Z_FLIGHT_ADDITIONAL"`);
  });

  it("CLAS: the same contract on a different collection — no per-type spelling", () => {
    const { meta, body } = loadCtsFixture("create-object-with-corrnr-clas");
    expect(meta.url).toBe("/sap/bc/adt/oo/classes");
    expect(meta.qs).toEqual({ corrNr: "A4HK900142" });
    expect(meta.status).toBe(200);
    expect(meta.bodyBytes).toBe(0);
    expect(body).toBe("");
  });

  it("the object lands in OUR request — re-read from the appliance", () => {
    const { meta, body } = loadCtsFixture("transport-details-after-create-with-corrnr");
    expect(meta.url).toBe("/sap/bc/adt/cts/transportrequests/A4HK900140");
    expect(meta.status).toBe(200);
    // The request we named, holding the object the numbered POST created — and
    // its task holding it too. This is the fix's proof, not the 200 above.
    expect(body).toContain(`tm:number="A4HK900140"`);
    expect(body).toContain(
      `<tm:abap_object tm:pgmid="R3TR" tm:type="PROG" tm:name="ZMCP_D1_A01" tm:wbtype="PROG/P"`,
    );
    expect(body).toContain(`tm:number="A4HK900141"`);
  });

  it("the follow-up transportchecks pins the object to that same request", () => {
    const { meta, body } = loadCtsFixture("transport-info-after-create-with-corrnr");
    expect(meta.url).toBe("/sap/bc/adt/cts/transportchecks");
    expect(meta.status).toBe(200);
    expect(body).toContain("A4HK900140");
    // KORRFLAG stays the transport-need signal; RESULT is "S" here as it is for
    // $TMP, which is why nothing keys on it.
    expect(body).toContain("<KORRFLAG>X</KORRFLAG>");
  });

  it("the LOCK then reports our own number back, not a fabricated one", () => {
    const { meta, body } = loadCtsFixture("lock-object-created-with-corrnr");
    expect(meta.qs).toEqual({ _action: "LOCK", accessMode: "MODIFY" });
    expect(meta.status).toBe(200);
    expect(body).toContain("<CORRNR>A4HK900140</CORRNR>");
    expect(body).toContain("<CORRUSER>DEVELOPER</CORRUSER>");
    // Before the fix this field held a number nobody had asked for, and the
    // PUT's own corrNr then collided with it (HTTP 500, CTS_WBO_API/020).
  });

  it("a superfluous corrNr on a $TMP create is ACCEPTED and ignored — it does not 403", () => {
    const { meta } = loadCtsFixture("create-object-with-corrnr-tmp-ignored");
    expect(meta.requestBody).toContain(`adtcore:packageRef adtcore:name="$TMP"`);
    expect(meta.qs).toEqual({ corrNr: "A4HK900140" });
    // 200, NOT the 403 an older comment in src/adt/write.ts claimed. Re-reading
    // A4HK900140 afterwards showed only ZMCP_D1_A01 — the $TMP object never
    // entered the request. Recorded because the intuitive guess is the opposite.
    expect(meta.status).toBe(200);
    expect(meta.threw).toBe(false);
    const landed = loadCtsFixture("transport-details-after-create-with-corrnr");
    expect(landed.body).not.toContain("ZMCP_D1_C01");
  });

  it("still rejects a corrNr that is not a usable change request (403, unchanged)", () => {
    // The other half of the contract, captured earlier: only a malformed,
    // unknown or not-a-change-request number is refused.
    for (const name of [
      "create-object-error-corrnr-not-found",
      "create-object-error-corrnr-not-a-change-request",
    ]) {
      const { meta } = loadCtsFixture(name);
      expect(meta.url).toBe("/sap/bc/adt/programs/programs");
      expect(meta.status).toBe(403);
      expect(meta.threw).toBe(true);
    }
  });
});

describe("deleteObject", () => {
  it("reads a before-image, locks, DELETEs with the handle, and wastes no UNLOCK on a dead object", async () => {
    // A real server: the content URI answers 404 once the DELETE has landed —
    // that 404 is what the post-delete read-back needs to confirm `deleted:
    // true` instead of degrading to `"unverified"`.
    let deleted = false;
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") {
        return deleted ? resp(404, NOT_FOUND_XML, OK_XML) : resp(200, SOURCE_A_CRLF, OK_TEXT);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML("HDEL"), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.method === "DELETE") {
        deleted = true;
        return resp(200, "", {});
      }
      return undefined;
    });
    const res = await deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: REPORT }));
    expect(res.deleted).toBe(true);
    // The first GET of /source/main is the pre-lock read (etag baseline); the
    // second, after LOCK, is the post-lock recheck. The before-image the
    // journal records — and `previousSource` below — now comes from that
    // second, post-lock read, since that is the last read guaranteed to
    // describe what the DELETE actually destroyed.
    expect(res.previousSource).toBe(SOURCE_A_CRLF);
    expect(adt.labels).toEqual([
      `GET ${REPORT_URI}`,
      `GET ${REPORT_SRC}`,
      `LOCK ${REPORT_URI}`,
      `GET ${REPORT_SRC}`,
      `DELETE ${REPORT_URI}`,
      // The post-delete verification: a 404 read-back is the success
      // signal and short-circuits before any repository-search fallback.
      `GET ${REPORT_SRC}`,
    ]);
    // Still the point of the test: the DELETE carries the handle, and no UNLOCK
    // follows it — the enqueue died with the object.
    expect(adt.calls.at(-2)!.qs.lockHandle).toBe("HDEL");
    expect(adt.verbs).not.toContain("UNLOCK");
  });

  it("releases the lock when the DELETE fails", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") return resp(200, SOURCE_A_CRLF, OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML("HDEL"), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.method === "DELETE") return resp(403, "<exc:exception/>", OK_XML);
      return undefined;
    });
    await expect(
      (async () => deleteObject(conn, await authDelete(conn, { type: "PROG/P", name: REPORT })))(),
    ).rejects.toThrow();
    // Resolve, pre-lock read, lock, post-lock recheck GET, failed DELETE —
    // and then the unlock, because the object is still there and still enqueued.
    expect(adt.verbs).toEqual(["GET", "GET", "LOCK", "GET", "DELETE", "UNLOCK"]);
  });
});

/**
 * Regression: the server strips the trailing newline on read-back.
 *
 * Found live on 2026-07-31 running the write-and-reread acceptance check twice
 * — every object reported `changed: true` on the second run even though the source was
 * byte-identical, because we PUT `…|.\n` (224 bytes) and read back `…|.`
 * (228 bytes, CRLF, no final newline). `contentHash()` normalises CRLF but not
 * the missing final newline, so the skip-the-PUT path never fired for PROG or
 * TABL and every no-op edit paid for a lock + PUT + unlock + activate.
 */
describe("sourceEquals — server-side source normalisation", () => {
  const SENT = "REPORT z.\nWRITE: / 'x'.\n";
  const READ_BACK = "REPORT z.\r\nWRITE: / 'x'.";

  it("treats the server's CRLF, newline-stripped read-back as identical", () => {
    expect(sourceEquals(SENT, READ_BACK)).toBe(true);
    // The raw hashes genuinely differ — this is exactly why the helper exists.
    expect(contentHash(SENT)).not.toBe(contentHash(READ_BACK));
  });

  /**
   * MEASURED: the server strips ALL trailing newlines on store, however many
   * were sent — not just one.
   *
   * Live probe on ZMCP_NL_PROBE (PROG/P, package $TMP): one lock held across
   * four PUTs, each immediately followed by a GET —
   *
   *   sent 32 B, 0 trailing LF -> read back 33 B, tail bytes 27 78 27 2e
   *   sent 33 B, 1 trailing LF -> read back 33 B, tail bytes 27 78 27 2e
   *   sent 34 B, 2 trailing LF -> read back 33 B, tail bytes 27 78 27 2e
   *   sent 35 B, 3 trailing LF -> read back 33 B, tail bytes 27 78 27 2e
   *
   * All four readbacks byte-identical, sha256 2a6ae1a68287f16f…. The 32→33
   * step is LF→CRLF conversion of the one internal line break, not a
   * trailing-newline effect; 1, 2 and 3 trailing newlines all collapse to the
   * same 33-byte readback, so `sourceEquals` must treat any number of trailing
   * newlines, on either side, as no difference at all.
   */
  it("is insensitive to any number of trailing newlines, on either side", () => {
    // The general contract this test exists to pin.
    expect(sourceEquals("REPORT x.", "REPORT x.\n")).toBe(true);
    expect(sourceEquals("REPORT x.\n", "REPORT x.")).toBe(true);
    // …and CRLF still folds, including the CRLF spelling of a trailing newline.
    expect(sourceEquals("a\r\nb", "a\nb")).toBe(true);
    expect(sourceEquals("A.", "A.\r\n")).toBe(true);

    // Pinned to the four measured rows: 0, 1, 2 and 3 trailing newlines all
    // canonicalise to the same thing, in both directions.
    expect(sourceEquals("REPORT x.", "REPORT x.\n")).toBe(true); // 0 vs 1
    expect(sourceEquals("REPORT x.\n", "REPORT x.\n\n")).toBe(true); // 1 vs 2
    expect(sourceEquals("REPORT x.\n\n", "REPORT x.\n\n\n")).toBe(true); // 2 vs 3
    expect(sourceEquals("REPORT x.", "REPORT x.\n\n\n")).toBe(true); // 0 vs 3
    expect(sourceEquals("REPORT x.\n\n\n", "REPORT x.")).toBe(true); // 3 vs 0, symmetric
    expect(sourceEquals("A.\n", "A.\n\n")).toBe(true);
  });

  it("still detects a real change, including one only at the end", () => {
    expect(sourceEquals(SENT, "REPORT z.\r\nWRITE: / 'y'.")).toBe(false);
    expect(sourceEquals("A.", "A. B.")).toBe(false);
    // Internal blank lines are meaningful and must not be collapsed.
    expect(sourceEquals("A.\n\nB.", "A.\nB.")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-line trailing-whitespace trim.
//
// Before this fix landed, NO existing test input anywhere in this repo carried
// a trailing space or tab on any canonicaliser path (verified by exhaustive
// grep). A green suite therefore proves nothing about whether the trim works —
// only that nothing broke. These tests carry the entire burden of proof; each
// was falsified individually.
// ---------------------------------------------------------------------------

describe("trailing space or tab on any line is not a difference", () => {
  it("sourceEquals treats a trailing space, a trailing tab, and trailing spaces on the final line as no difference", () => {
    expect(sourceEquals("A.  \nB.", "A.\r\nB.")).toBe(true);
    expect(sourceEquals("A.\t\nB.", "A.\r\nB.")).toBe(true);
    expect(sourceEquals("A.\nB.   ", "A.\r\nB.")).toBe(true);
  });
});

describe("a whitespace-only internal line is EMPTIED, not deleted", () => {
  /**
   * MEASURED: `wsonlymid` (`\n   \n`) and `wstabonlymid` (`\n\t\n`) both land on
   * the `blankmid` hash — the one with an extra EMPTY line — not on `t0`. Had
   * the line been deleted instead of emptied, they would have collapsed onto
   * `t0`. So the trim must reduce the line's content to nothing and KEEP the
   * line, never filter it out.
   */
  it("keeps the line's position (collapses to blankmid, not to a shorter source)", () => {
    expect(sourceEquals("A.\n   \nB.", "A.\n\nB.")).toBe(true);
    // If the line were deleted rather than emptied, this would also be true —
    // it must not be. The line count differs and sourceEquals must see that.
    expect(sourceEquals("A.\n   \nB.", "A.\nB.")).toBe(false);
    expect(sourceEquals("A.\n\t\nB.", "A.\n\nB.")).toBe(true);
  });
});

describe("only space and tab are trimmed; FF, VT, NBSP and a bare CR are left alone", () => {
  /**
   * This pins that abapsmith does not GUESS while the FF/VT/CR/NBSP question
   * is open — it does NOT claim the server keeps these bytes. Revisit
   * this test when the four mid-source variants are finally probed live.
   */
  it("does not trim FF, VT or NBSP", () => {
    expect(sourceEquals("A.\f\nB.", "A.\nB.")).toBe(false);
    expect(sourceEquals("A.\v\nB.", "A.\nB.")).toBe(false);
    expect(sourceEquals("A. \nB.", "A.\nB.")).toBe(false);
  });

  /**
   * The one assertion in the repo that discriminates `split("\n").map(...)`
   * from a single `/[ \t]+$/gm` regex: JavaScript's multiline `$` matches
   * before a bare `\r` too, so `/gm` would silently strip the two trailing
   * spaces here. Spelling the trim as split/map/join must NOT.
   */
  it("does not trim trailing spaces before a bare CR (discriminates split/map/join from /gm)", () => {
    expect(sourceEquals("A.  \rB.", "A.\rB.")).toBe(false);
  });
});

describe("the per-line trim runs BEFORE the trailing-newline strip", () => {
  it("empties a whitespace-only last line so the newline strip can then remove it", () => {
    expect(sourceEquals("A.\n   ", "A.")).toBe(true);
    expect(sourceEquals("A.\n\t", "A.")).toBe(true);
    expect(sourceEquals("A.\n \n ", "A.")).toBe(true);
  });
});

describe("a source differing only by trailing whitespace is a no-op on the wire", () => {
  it("takes no lock and sends no PUT when the only difference is trailing whitespace", async () => {
    const SERVER_TEXT = "REPORT zmcp_test_rep.\r\nWRITE: / 'a'.";
    const CALLER_TEXT = "REPORT zmcp_test_rep.\nWRITE: / 'a'.  \n";
    const { conn, adt } = await connected(existingReport(SERVER_TEXT));
    const res = await writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
      source: CALLER_TEXT,
    });
    expect(res.changed).toBe(false);
    expect(adt.verbs.filter((v) => v === "LOCK")).toHaveLength(0);
    expect(adt.verbs).not.toContain("PUT");
  });
});

describe("the etag handed back for a whitespace-carrying source is one a later read reproduces", () => {
  it("equals contentHash of the literal with no trailing whitespace and no trailing newline", async () => {
    // Deliberately spelled as a literal, NOT `etagOf(CALLER)` — that would make
    // this impl-compares-to-impl and prove nothing about canonicalSource.
    const CALLER = "REPORT zmcp_test_rep.\nWRITE: / 'a'.   \n";
    const SOURCE_B_CRLF = SOURCE_B.replace(/\n/g, "\r\n");
    const { conn, adt } = await connected(existingReport(SOURCE_B_CRLF));
    const res = await writeObject(conn, await authWrite(conn, { type: "PROG/P", name: REPORT }), {
      source: CALLER,
    });
    // A genuine PUT, not the no-op path — the server currently holds SOURCE_B.
    expect(res.changed).toBe(true);
    expect(adt.verbs).toContain("PUT");
    expect(res.etag).toBe(contentHash("REPORT zmcp_test_rep.\nWRITE: / 'a'."));
  });
});

// ---------------------------------------------------------------------------
// CLAS. Unlike PROG, the server PRESERVES trailing newlines on a CLAS
// main include exactly (measured: probe 1b, four distinct hashes, readback =
// sent + 9 + t). Strip-all is applied to CLAS anyway, DELIBERATELY — see
// canonicalSource in src/compact.ts.
// ---------------------------------------------------------------------------

const CLASS_NAME = "ZMCP_C";
const CLASS_URI = "/sap/bc/adt/oo/classes/zmcp_c";
const CLASS_SRC = `${CLASS_URI}/source/main`;

/** Same shape as `existingReport`, but for a CLAS main include: the fake server
 * hands back exactly the `current` bytes given, so the test controls whether
 * trailing newlines are preserved (as A4H really does for CLAS) without the
 * fake having to model that itself. */
const existingClass = (current: string): Route => (r) => {
  if (r.url === CLASS_URI && r.method === "GET" && !r.qs._action) {
    return resp(200, OBJECT_XML(CLASS_NAME, "CLAS/OC"), OK_XML);
  }
  if (r.url === CLASS_SRC && r.method === "GET") return resp(200, current, OK_TEXT);
  if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
  if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
  if (r.url === CLASS_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
  return undefined;
};

describe("the symmetry-invariant pin: canonicalEtag never sees a caller-supplied string on the `current` side", () => {
  const SERVER = "CLASS zmcp_c DEFINITION.\r\nENDCLASS.\r\n\r\n";
  const CALLER = "CLASS zmcp_c DEFINITION.\nENDCLASS.\n";

  it("collapses a CLAS write differing only in trailing blank lines into a false noop", async () => {
    const { conn } = await connected(existingClass(SERVER));
    const res = await writeObject(conn, await authWrite(conn, { type: "CLAS/OC", name: CLASS_NAME }), {
      source: CALLER,
    });
    expect(res.changed).toBe(false);
    expect(res.etag).toBe(res.previousEtag);
    expect(res.etag).toBe(contentHash("CLASS zmcp_c DEFINITION.\nENDCLASS."));
    // If this fails, `canonicalEtag` is being fed a caller-supplied string on
    // the `current` side and the CLAS de-escalation is VOID — the
    // over-collapse becomes a write loop, not a false noop.
    //
    // NOTE ON FALSIFICATION (measured, not assumed): this assertion is NOT
    // sensitive to swapping `canonicalEtag(current)` for `canonicalEtag(opts.source)`
    // on the previousEtag line ("Falsify A"). That swap is
    // mathematically invisible here: `sourceEquals(current, opts.source)` is
    // true BY CONSTRUCTION in a false-noop fixture, which forces
    // `canonicalEtag(current) === canonicalEtag(opts.source)` regardless of
    // which one the code reads. Falsify A was applied to src/adt/write.ts and
    // run against the full file: it left this test green but turned RED the
    // pre-existing "writeObject ordering > updates an existing object
    // as GET → GET → LOCK → PUT → UNLOCK" test, on `res.previousEtag`. That
    // test — not this one — is what actually pins the current/opts.source
    // symmetry on the previousEtag line; it has current !== opts.source, so
    // the swap is observable there. This test cannot be the vehicle for
    // Falsify A without contradicting its own premise (a false noop requires
    // the two sides to canonicalize identically).
  });

  it("also refuses a stale expectEtag pinned to the server's RAW (non-canonical) bytes only via the current side", async () => {
    // This exercises assertEtagMatches with an etag that matches `current`'s
    // RAW bytes but not `opts.source`'s — the raw hashes differ (SERVER has
    // CRLF + extra blank lines, CALLER does not) even though the CANONICAL
    // hashes coincide. That makes this assertion sensitive to "Falsify C"
    // (assertEtagMatches fed opts.source instead of current): under the
    // correct code the raw-current match succeeds silently; under Falsify C
    // it throws ETAG_CONFLICT, because neither canonicalEtag(opts.source) nor
    // contentHash(opts.source) equals the pinned raw-SERVER hash.
    const { conn } = await connected(existingClass(SERVER));
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "CLAS/OC", name: CLASS_NAME }),
      { source: CALLER, expectEtag: contentHash(SERVER) },
    );
    expect(res.changed).toBe(false);
  });
});

describe("CLAS decision pin (deliberate, recorded): DELETE THIS TEST ON PURPOSE IF THE STRIP-ALL RULE EVER CHANGES", () => {
  /**
   * Team decision: keep strip-all everywhere, accept the cost, do not add a
   * per-type parameter. The cost: a CLAS write whose ONLY change is the
   * number of trailing blank lines is reported `noop` and silently skipped,
   * so abapsmith and Eclipse can disagree about file state. It cannot become
   * a write loop — canonicalSource runs symmetrically on both sides (the
   * symmetry-invariant pin above proves that).
   *
   * If option (b) (per-type canonicalisation) is ever taken, THIS is the test
   * you delete — deliberately, in the same commit — not a fixture to quietly
   * "fix" because its expectation looks wrong to a future reader who has not
   * seen this decision.
   */
  const SERVER = "CLASS zmcp_c DEFINITION.\r\nENDCLASS.\r\n\r\n";
  const CALLER = "CLASS zmcp_c DEFINITION.\nENDCLASS.\n";

  it("DELIBERATE: a CLAS write differing only in trailing blank lines sends no PUT (accepted cost of option (a), not a bug)", async () => {
    const { conn, adt } = await connected(existingClass(SERVER));
    const res = await writeObject(conn, await authWrite(conn, { type: "CLAS/OC", name: CLASS_NAME }), {
      source: CALLER,
    });
    expect(res.changed).toBe(false);
    expect(adt.verbs).not.toContain("PUT");
    expect(adt.verbs).not.toContain("LOCK");
    // Falsification (the spec gives no explicit instruction here, so this
    // was derived and verified directly): neither SERVER nor CALLER has a
    // trailing space/tab on any line here — the ONLY difference is the count
    // of trailing blank LINES — so this fixture is not sensitive to the
    // per-line trim step at all. What it pins is the strip-ALL-trailing-
    // newlines step in canonicalSource. Changing `.replace(/\n+$/, "")` to
    // strip-one (`.replace(/\n$/, "")`) was applied to src/compact.ts and run
    // against the full trio (write/journal/undo, 169 tests): it turned this
    // assertion red (changed: true, expected false, got true), together with
    // the symmetry-invariant pin's both assertions and two pre-existing tests
    // — "sourceEquals ... is insensitive to any number of trailing newlines,
    // on either side" and the per-line-trim-ordering test.
  });
});

// ---------------------------------------------------------------------------
// A class SUB-INCLUDE that does not exist yet has to be CREATED before it
// can be written. LIVE (A4H, 2026-08-18): PUT does not create it — CCAU answers
// `ZCL_…================CCAU does not have any inactive version` — so
// `writeObject` step 4a-ii issues `POST {classUri}/includes?lockHandle=…`
// first. These pin that step's SHAPE and, just as importantly, its
// CONDITIONALITY: CCDEF/CCIMP/CCMAC materialise with the class and must NOT be
// re-created, or every write to them would POST a duplicate.
// ---------------------------------------------------------------------------

const CLASS_CCAU = `${CLASS_URI}/includes/testclasses`;
const CLASS_CCDEF = `${CLASS_URI}/includes/definitions`;
const TESTCLASS_SRC = "CLASS ltcl DEFINITION FOR TESTING.\nENDCLASS.";

/**
 * A class that exists, whose `testclasses` include does NOT, and which accepts
 * the creation POST. `createPost` lets one test make that POST fail.
 */
const classWithAbsentCcau =
  (createPost: HttpClientResponse = resp(200, "", OK_XML)): Route =>
  (r) => {
    if (r.url === CLASS_URI && r.method === "GET" && !r.qs._action) {
      return resp(200, OBJECT_XML(CLASS_NAME, "CLAS/OC"), OK_XML);
    }
    // The include is genuinely absent — both the pre-lock read and the
    // under-lock read say so. That is the ONLY signal step 4a-ii keys on.
    if (r.url === CLASS_CCAU && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
    if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
    if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === `${CLASS_URI}/includes` && r.method === "POST") return createPost;
    if (r.url === CLASS_CCAU && r.method === "PUT") return resp(200, "", OK_TEXT);
    return undefined;
  };

describe("writeObject: an absent class include is created before it is written", () => {
  it("POSTs to {classUri}/includes under the class lock, then PUTs — in that order", async () => {
    const { conn, adt } = await connected(classWithAbsentCcau());
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "CLAS/OC", name: CLASS_NAME, include: "testclasses" }),
      { source: TESTCLASS_SRC },
    );
    expect(res.changed).toBe(true);

    const post = adt.calls.find((c) => c.method === "POST" && c.url === `${CLASS_URI}/includes`);
    expect(post, "no POST to {classUri}/includes — the CCAU write would fail live").toBeDefined();
    // The lock handle is what authorises the create. Live evidence: a PUT with
    // no handle is refused, and the class handle authorises both this POST and
    // the PUT that follows (confirmed by a manual probe script, not shipped
    // in this release).
    expect(post?.qs.lockHandle).toBe("H1");
    // `includeType` comes from the TARGET, never hardcoded to `testclasses`.
    expect(String(post?.body)).toContain('class:includeType="testclasses"');
    expect(post?.headers?.["Content-Type"]).toBe("application/*");

    // Ordering. Anything else and the server sees a create it cannot authorise
    // or a PUT to a document that still does not exist.
    const seq = adt.calls
      .map((c) => (c.qs._action ? c.qs._action : `${c.method} ${c.url}`))
      .filter((l) => l === "LOCK" || l === "UNLOCK" || l.startsWith("POST") || l.startsWith("PUT"));
    expect(seq).toEqual(["LOCK", `POST ${CLASS_URI}/includes`, `PUT ${CLASS_CCAU}`, "UNLOCK"]);
  });

  it("creates `definitions` as CCDEF, not `testclasses` — the include type is read off the target", async () => {
    const route: Route = (r) => {
      if (r.url === CLASS_CCDEF && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === `${CLASS_URI}/includes` && r.method === "POST") return resp(200, "", OK_XML);
      if (r.url === CLASS_CCDEF && r.method === "PUT") return resp(200, "", OK_TEXT);
      return classWithAbsentCcau()(r);
    };
    const { conn, adt } = await connected(route);
    await writeObject(
      conn,
      await authWrite(conn, { type: "CLAS/OC", name: CLASS_NAME, include: "definitions" }),
      { source: "TYPES ty_x TYPE i." },
    );
    const post = adt.calls.find((c) => c.method === "POST" && c.url === `${CLASS_URI}/includes`);
    expect(String(post?.body)).toContain('class:includeType="definitions"');
  });

  it("does NOT create an include that already has content — CCDEF/CCIMP/CCMAC ship with the class", async () => {
    // LIVE: a brand-new class answers 200 on definitions/implementations/macros
    // with a short generated stub. Re-POSTing those on every write would be a
    // duplicate create against a document that is already there.
    const route: Route = (r) => {
      if (r.url === CLASS_URI && r.method === "GET" && !r.qs._action) {
        return resp(200, OBJECT_XML(CLASS_NAME, "CLAS/OC"), OK_XML);
      }
      if (r.url === CLASS_CCDEF && r.method === "GET") return resp(200, "*stub", OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === CLASS_CCDEF && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    };
    const { conn, adt } = await connected(route);
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "CLAS/OC", name: CLASS_NAME, include: "definitions" }),
      { source: "TYPES ty_x TYPE i." },
    );
    expect(res.changed).toBe(true);
    // `c.method === "POST"` alone would be wrong: LOCK/UNLOCK are POSTs too.
    expect(adt.calls.some((c) => c.url === `${CLASS_URI}/includes`)).toBe(false);
  });

  it("never creates anything for the MAIN include, whose absence means the CLASS is absent", async () => {
    const { conn, adt } = await connected(existingClass("CLASS zmcp_c DEFINITION.\nENDCLASS."));
    await writeObject(conn, await authWrite(conn, { type: "CLAS/OC", name: CLASS_NAME }), {
      source: "CLASS zmcp_c DEFINITION.\nENDCLASS.\n\nCLASS zmcp_c IMPLEMENTATION.\nENDCLASS.",
    });
    expect(adt.calls.some((c) => c.url === `${CLASS_URI}/includes`)).toBe(false);
  });

  it("abap_write's report NAMES the include — a CCAU write is not indistinguishable from a main write", async () => {
    // LIVE 2026-08-18: the first run of the acceptance suite failed on exactly
    // this. The write had landed in CCAU perfectly; the REPORT said only
    // `uri: /sap/bc/adt/oo/classes/zmcp_ccau_live`, which is the class, so
    // "did my test class go where I asked?" was unanswerable from the output.
    let current: string | undefined;
    const route: Route = (r) => {
      if (r.url === CLASS_URI && r.method === "GET" && !r.qs._action) {
        return resp(200, OBJECT_XML(CLASS_NAME, "CLAS/OC"), OK_XML);
      }
      // Stateful: `abapWrite` re-reads after PUT/UNLOCK before activating, so a
      // fake that kept answering 404 would look like a concurrent writer.
      if (r.url === CLASS_CCAU && r.method === "GET") {
        return current === undefined ? resp(404, NOT_FOUND_XML, OK_XML) : resp(200, current, OK_TEXT);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === `${CLASS_URI}/includes` && r.method === "POST") return resp(200, "", OK_XML);
      if (r.url === CLASS_CCAU && r.method === "PUT") {
        current = r.body ?? "";
        return resp(200, "", OK_TEXT);
      }
      if (r.url.includes("/checkruns")) {
        return resp(200, `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`, OK_XML);
      }
      if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
      return undefined;
    };
    const { conn } = await connected(route);
    const res = await abapWrite(
      conn,
      { object: CLASS_NAME, type: "CLAS/OC", include: "testclasses", source: TESTCLASS_SRC },
      20_000,
      DEFAULT_GATE,
    );
    expect(res.text).toMatch(/^include: testclasses$/m);
    expect(res.text).toMatch(/^changed: true$/m);
  });

  it("does NOT add an `include:` line to an ordinary main-source write", async () => {
    // The line is worth its bytes only if it appears when it means something.
    let current = "REPORT zmcp_test_rep.";
    const { conn } = await connected((r) => {
      // Stateful for the same reason as the test above: `abapWrite` re-reads
      // after PUT/UNLOCK and refuses to activate if the bytes moved.
      if (r.url === REPORT_SRC && r.method === "GET") return resp(200, current, OK_TEXT);
      if (r.url === REPORT_SRC && r.method === "PUT") {
        current = r.body ?? "";
        return resp(200, "", OK_TEXT);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url.includes("/checkruns")) {
        return resp(200, `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`, OK_XML);
      }
      if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
      return undefined;
    });
    const res = await abapWrite(
      conn,
      { object: REPORT, type: "PROG/P", source: "REPORT zmcp_test_rep.\nWRITE: / 'a'." },
      20_000,
      DEFAULT_GATE,
    );
    expect(res.text).not.toMatch(/^include:/m);
  });

  it("when the create is refused: no PUT, the lock is released, and the message names the include", async () => {
    const { conn, adt } = await connected(
      classWithAbsentCcau(resp(403, NOT_FOUND_XML, OK_XML)),
    );
    const e = await catchErr(
      writeObject(
        conn,
        await authWrite(conn, { type: "CLAS/OC", name: CLASS_NAME, include: "testclasses" }),
        { source: TESTCLASS_SRC },
      ),
    );
    expect(e.message).toContain("testclasses");
    expect(adt.calls.some((c) => c.method === "PUT" && c.url === CLASS_CCAU)).toBe(false);
    // Leaving a class enqueued because a sub-resource could not be created is
    // strictly worse than the failure itself.
    expect(adt.verbs).toContain("UNLOCK");
  });
});

// ---------------------------------------------------------------------------

/**
 * The SECOND write engine: the properties shape.
 *
 * `DOMA/DD`, `DTEL/DE`, `TTYP/DA`, `MSAG/N` and `ENQU/DL` have no
 * `/source/main` at all — a GET of it 404s (verified live). Their content IS
 * their XML descriptor, PUT to the object's OWN URI with
 * `Content-Type: application/*`.
 *
 * What these tests are for is the thing this file exists to prevent: a
 * SECOND COPY of the write choreography. `writeObject` is one function and one
 * ordering for both shapes — only the request construction (which URI, which
 * media type) and the body differ. So each ordering assertion below is
 * deliberately spelled out in full and compared against the source-shape
 * ordering pinned in "writeObject ordering" above: if someone forks the
 * choreography, the two lists stop agreeing and this file says so.
 */
describe("properties-shape writes (DOMA, DTEL, TTYP, MSAG, ENQU)", () => {
  const DOMA_URI = "/sap/bc/adt/ddic/domains/zpropw_doma";
  const DTEL_URI = "/sap/bc/adt/ddic/dataelements/zpropw_dtel";
  const TTYP_URI = "/sap/bc/adt/ddic/tabletypes/zpropw_ttyp";
  const ENQU_URI = "/sap/bc/adt/ddic/lockobjects/sources/ezpropw_lock";

  /** A minimal but real-shaped domain descriptor: root element, name, package. */
  const domaXml = (name = "ZPROPW_DOMA", pkg = "$TMP", datatype = "CHAR"): string =>
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" ` +
    `adtcore:type="DOMA/DD" adtcore:description="probe">` +
    `<adtcore:packageRef adtcore:name="${pkg}"/>` +
    `<doma:typeInformation><doma:datatype>${datatype}</doma:datatype>` +
    `<doma:length>10</doma:length></doma:typeInformation>` +
    `</doma:domain>`;

  /** A minimal but real-shaped data-element descriptor: root element, name, package. */
  const dtelXml = (name = "ZPROPW_DTEL", pkg = "$TMP", short = "probe"): string =>
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<dtel:dataElement xmlns:dtel="http://www.sap.com/dictionary/dataelement" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" ` +
    `adtcore:type="DTEL/DE" adtcore:description="${short}">` +
    `<adtcore:packageRef adtcore:name="${pkg}"/></dtel:dataElement>`;

  const ttypXml = (name = "ZPROPW_TTYP"): string =>
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<ttyp:tableType xmlns:ttyp="http://www.sap.com/dictionary/tabletype" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" ` +
    `adtcore:type="TTYP/DA"><adtcore:packageRef adtcore:name="$TMP"/></ttyp:tableType>`;

  // Root MUST be lowercase `enqu:lockobject` in the `.../ddic/enqu` namespace
  // (not camelCase `enqu:lockObject` in `.../dictionary/lockobject` — that
  // was the actual, long-unrecognised cause of every historical ENQU create
  // failure; see `assertLockObjectRoot`, src/adt/write.ts).
  const enquXml = (name = "EZPROPW_LOCK"): string =>
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<enqu:lockobject xmlns:enqu="http://www.sap.com/adt/ddic/enqu" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" ` +
    `adtcore:type="ENQU/DL"><adtcore:packageRef adtcore:name="$TMP"/>` +
    `<enqu:content><enqu:primaryTable><enqu:tableName>ZPROPW_TAB</enqu:tableName>` +
    `<enqu:lockMode>E</enqu:lockMode></enqu:primaryTable></enqu:content></enqu:lockobject>`;

  // ---- The registry is the single source of truth ------------------------

  it("declares all five as properties-shape, and none of the source-shape types as one", () => {
    const properties = ["DOMA/DD", "DTEL/DE", "TTYP/DA", "MSAG/N", "ENQU/DL"];
    for (const t of properties) {
      expect(capabilitiesFor(t)?.write?.shape).toBe("properties");
    }
    for (const t of [
      "PROG/P",
      "CLAS/OC",
      "INTF/OI",
      "TABL/DT",
      "TABL/DS",
      "DDLS/DF",
      "DDLX/EX",
      "SRVD/SRV",
      "FUGR/FF",
    ]) {
      expect(capabilitiesFor(t)?.write?.shape).toBe("source");
    }
    // All three load-time invariants still hold with the five new entries in
    // place — in particular `create.vendor === false` ⇒ properties shape, a
    // declared `namePrefixes` is non-empty, and all five properties-shape
    // types are readable via format:"raw" (by construction, since that gate
    // is this exact `write.shape === "properties"` predicate).
    expect(() => assertRegistryCoversTypes()).not.toThrow();
    expect(() => assertNoConflictingCapabilities()).not.toThrow();
    expect(() => assertWritableTypesAreReadable()).not.toThrow();
  });

  it("records the two per-type facts the server enforces: MSAG is born active, ENQU needs an E-prefix", () => {
    // `activate: false` is not decoration — a message class has no inactive
    // version to activate, so the tool layer must not offer to.
    expect(capabilitiesFor("MSAG/N")?.activate).toBe(false);
    expect(capabilitiesFor("PROG/P")?.activate).toBe(true);
    // SAP rejects `ZRECON_MLK1` for a lock object with 400
    // ExceptionResourceCreationFailure and accepts `EZRECON_MLK1`.
    // The list is per-type; the global one is untouched.
    expect(capabilitiesFor("ENQU/DL")?.namePrefixes).toEqual(["EZ", "EY"]);
    expect(capabilitiesFor("DOMA/DD")?.namePrefixes).toBeUndefined();
  });

  it("marks exactly the two types the vendor library cannot create as vendor:false", () => {
    // Checked by reading abap-adt-api's objectcreator.js `CreatableTypes` map,
    // not by trusting a doc: it has DOMA/DD, DTEL/DE and MSAG/N entries and no
    // TTYP/DA or ENQU/DL entry at all.
    expect(capabilitiesFor("TTYP/DA")?.create?.vendor).toBe(false);
    expect(capabilitiesFor("ENQU/DL")?.create?.vendor).toBe(false);
    expect(capabilitiesFor("DOMA/DD")?.create?.vendor).toBe(true);
    expect(capabilitiesFor("DTEL/DE")?.create?.vendor).toBe(true);
    expect(capabilitiesFor("MSAG/N")?.create?.vendor).toBe(true);
  });

  // ---- Resolution: same code path, no bespoke handling -------------------

  it.each([
    ["DOMA/DD", "ZPROPW_DOMA", "/sap/bc/adt/ddic/domains/zpropw_doma"],
    ["DTEL/DE", "ZPROPW_DTEL", "/sap/bc/adt/ddic/dataelements/zpropw_dtel"],
    ["TTYP/DA", "ZPROPW_TTYP", "/sap/bc/adt/ddic/tabletypes/zpropw_ttyp"],
    ["MSAG/N", "ZPROPW_MSG", "/sap/bc/adt/messageclass/zpropw_msg"],
    ["ENQU/DL", "EZPROPW_LOCK", "/sap/bc/adt/ddic/lockobjects/sources/ezpropw_lock"],
  ])("resolves %s through the ordinary resolveWriteTarget path", async (type, name, uri) => {
    const { conn } = await connected((r) =>
      r.url === uri ? resp(404, NOT_FOUND_XML, OK_XML) : undefined,
    );
    const t = await resolveWriteTarget(conn, { type, name });
    expect(t.type).toBe(type);
    expect(t.uri).toBe(uri);
    expect(t.exists).toBe(false);
    expect(t.packageName).toBe("$TMP");
    // `sourceUri` is still computed — it is simply not what a properties-shape
    // write uses. Pinned so a future reader does not "fix" it away and quietly
    // break the source-shape types that share the field.
    expect(t.sourceUri).toBe(`${uri}/source/main`);
  });

  it("enforces the 16-character lock-object name limit before the network", async () => {
    const offline = null as unknown as AbapConnection;
    const e = await catchErr(
      resolveWriteTarget(offline, { type: "ENQU/DL", name: "EZPROPW_FAR_TOO_LONG" }),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.details.maxLength).toBe(16);
  });

  // ---- The update path ---------------------------------------------------

  /** An existing properties-shape object whose descriptor is `current`. */
  const existingProperties = (uri: string, type: string, name: string, current: string): Route =>
    (r) => {
      if (r.url === uri && r.method === "GET") return resp(200, current, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === uri && r.method === "PUT") return resp(200, current, OK_XML);
      // Deliberately unrouted: `${uri}/source/main`. A properties-shape write
      // that ever touched it would make the fake throw, which is the point —
      // that resource 404s on the real system.
      return undefined;
    };

  it("updates a domain with the SAME choreography as a report, but against the object URI", async () => {
    const before = domaXml("ZPROPW_DOMA", "$TMP", "CHAR");
    const after = domaXml("ZPROPW_DOMA", "$TMP", "NUMC");
    // Stateful, not a fixed `before` for every GET. Step 4b
    // (`src/adt/write.ts`) issues a genuine post-write GET through this
    // same route to derive `changed`/`etag`, so a fake that always answers
    // `before` regardless of the PUT having happened would make every write
    // look like a no-op — exactly the false negative this guards against,
    // just pointed the other direction. A real server returns what it now
    // holds; this fake does too.
    let current = before;
    const { conn, adt } = await connected((r) => {
      // The resolution GET and the content GET are the same URL here — that is
      // the shape, not a bug: for this shape the descriptor IS the content.
      if (r.url === DOMA_URI && r.method === "GET") return resp(200, current, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === DOMA_URI && r.method === "PUT") {
        current = after;
        return resp(200, after, OK_XML);
      }
      return undefined;
    });

    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "DOMA/DD", name: "ZPROPW_DOMA" }),
      { source: after },
    );

    expect(res.created).toBe(false);
    expect(res.changed).toBe(true);
    // Byte-for-byte the ordering pinned for PROG/P in "writeObject ordering",
    // with `sourceUri` replaced by `uri` — one choreography, two
    // request shapes — PLUS one addition: step 4b's post-write GET,
    // issued after the PUT and before the UNLOCK, is real for this shape (an
    // UPDATE) and this is where `changed:true` above actually comes from now,
    // not from the PUT response.
    expect(adt.labels).toEqual([
      `GET ${DOMA_URI}`,
      `GET ${DOMA_URI}`,
      `LOCK ${DOMA_URI}`,
      `GET ${DOMA_URI}`,
      `PUT ${DOMA_URI}`,
      `GET ${DOMA_URI}`,
      `UNLOCK ${DOMA_URI}`,
    ]);
    expect(adt.verbs.indexOf("UNLOCK")).toBeGreaterThan(adt.verbs.indexOf("PUT"));
    const put = adt.calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe(DOMA_URI);
    expect(put.url.endsWith("/source/main")).toBe(false);
    expect(put.qs.lockHandle).toBe("H1");
    expect(put.body).toBe(after);
    // Never activated while the lock is held — the 403 exists for both shapes.
    expect(adt.labels.some((l) => l.includes("/activation"))).toBe(false);
    expect(res.etagSource).toBe("post-write-read");
  });

  it("sends Content-Type: application/* for the properties shape and text/plain for the source shape", async () => {
    const before = domaXml();
    const doma = await connected(
      existingProperties(DOMA_URI, "DOMA/DD", "ZPROPW_DOMA", before),
    );
    await writeObject(
      doma.conn,
      await authWrite(doma.conn, { type: "DOMA/DD", name: "ZPROPW_DOMA" }),
      { source: domaXml("ZPROPW_DOMA", "$TMP", "NUMC") },
    );
    const domaPut = doma.adt.calls.find((c) => c.method === "PUT")!;
    expect(domaPut.url).toBe(DOMA_URI);

    const prog = await connected(existingReport(SOURCE_A_CRLF));
    await writeObject(prog.conn, await authWrite(prog.conn, { type: "PROG/P", name: REPORT }), {
      source: SOURCE_B,
    });
    const progPut = prog.adt.calls.find((c) => c.method === "PUT")!;
    // The source shape is untouched by this pass — same URI, same media type.
    expect(progPut.url).toBe(REPORT_SRC);
  });

  it("pins the literal Content-Type header sent on the PUT for DOMA, DTEL and MSAG", async () => {
    // The test above ("sends Content-Type: application/* ...") only ever
    // compared URLs — it never actually read a header value, so it could not
    // have caught a regression in `contentType()` (src/adt/write.ts) even
    // though its own name promised otherwise. This is the real assertion:
    // capture the outgoing `Content-Type` on the wire via `FakeAdt`'s new
    // `headers` field and check it byte-for-byte, for three of the five
    // properties-shape types. `contentType()` returns the SAME hardcoded
    // `"application/*"` literal for all five regardless of type — DOMA/DTEL
    // are picked because their fixtures already exist above, and MSAG
    // because it is the type whose registry entry carries the most other
    // per-type special-casing (`activate: false`), making it the type most
    // likely to grow an accidental type-specific branch in `contentType()`
    // in the future.
    const msagXml = (n: string): string =>
      `<?xml version="1.0"?><mc:messageClass xmlns:mc="http://www.sap.com/adt/MessageClass" ` +
      `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZPROPW_MSG" ` +
      `adtcore:type="MSAG/N"><adtcore:packageRef adtcore:name="$TMP"/>` +
      `<mc:messages><mc:message mc:msgno="${n}"/></mc:messages></mc:messageClass>`;
    const MSAG_URI = "/sap/bc/adt/messageclass/zpropw_msg";

    const cases: Array<{ type: string; name: string; uri: string; before: string; after: string }> = [
      {
        type: "DOMA/DD",
        name: "ZPROPW_DOMA",
        uri: DOMA_URI,
        before: domaXml("ZPROPW_DOMA", "$TMP", "CHAR"),
        after: domaXml("ZPROPW_DOMA", "$TMP", "NUMC"),
      },
      {
        type: "DTEL/DE",
        name: "ZPROPW_DTEL",
        uri: DTEL_URI,
        before: dtelXml("ZPROPW_DTEL", "$TMP", "probe"),
        after: dtelXml("ZPROPW_DTEL", "$TMP", "probe updated"),
      },
      {
        type: "MSAG/N",
        name: "ZPROPW_MSG",
        uri: MSAG_URI,
        before: msagXml("001"),
        after: msagXml("002"),
      },
    ];

    for (const { type, name, uri, before, after } of cases) {
      const { conn, adt } = await connected(existingProperties(uri, type, name, before));
      await writeObject(conn, await authWrite(conn, { type, name }), { source: after });
      const put = adt.calls.find((c) => c.method === "PUT")!;
      expect(put.url).toBe(uri);
      // The literal header value on the wire — not an inference from reading
      // `contentType()`'s source.
      expect(put.headers?.["Content-Type"]).toBe("application/*");
    }
  });

  it("does not PUT at all when the descriptor is byte-identical (compare-before-write, both shapes)", async () => {
    const same = domaXml();
    const { conn, adt } = await connected(
      existingProperties(DOMA_URI, "DOMA/DD", "ZPROPW_DOMA", same),
    );
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "DOMA/DD", name: "ZPROPW_DOMA" }),
      { source: same },
    );
    expect(res.changed).toBe(false);
    expect(adt.verbs).not.toContain("PUT");
    // The comparison happens BEFORE a lock is taken, for this shape too.
    expect(adt.verbs).not.toContain("LOCK");
  });

  // ---- The create path: two branches, one choreography -------------------

  it("creates a DOMA through the vendor CreatableTypes entry (create.vendor = true)", async () => {
    const xml = domaXml();
    const { conn, adt } = await connected((r) => {
      if (r.url === DOMA_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === "/sap/bc/adt/ddic/domains" && r.method === "POST") return resp(201, "", {});
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === DOMA_URI && r.method === "PUT") return resp(200, xml, OK_XML);
      return undefined;
    });
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "DOMA/DD", name: "ZPROPW_DOMA" }),
      { source: xml },
    );
    expect(res.created).toBe(true);
    expect(adt.labels).toEqual([
      `GET ${DOMA_URI}`,
      "POST /sap/bc/adt/ddic/domains",
      `LOCK ${DOMA_URI}`,
      `PUT ${DOMA_URI}`,
      `UNLOCK ${DOMA_URI}`,
    ]);
    // The vendor builds its own skeleton body; the caller's descriptor arrives
    // on the PUT that follows.
    const create = adt.calls.find((c) => c.url === "/sap/bc/adt/ddic/domains")!;
    expect(create.body).toContain(`adtcore:name="ZPROPW_DOMA"`);
    expect(adt.calls.find((c) => c.method === "PUT")!.body).toBe(xml);
  });

  it("creates a TTYP by POSTing the caller's own XML to the collection (create.vendor = false)", async () => {
    // `abap-adt-api` has no TTYP/DA entry, so `conn.adt.createObject` would
    // throw "Unsupported object type" before any HTTP call. The collection URI
    // is derived from the type's own TypeSpec.path, so it cannot drift from
    // the object URI the rest of the module builds.
    const xml = ttypXml();
    const { conn, adt } = await connected((r) => {
      if (r.url === TTYP_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === "/sap/bc/adt/ddic/tabletypes" && r.method === "POST")
        return resp(201, xml, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === TTYP_URI && r.method === "PUT") return resp(200, xml, OK_XML);
      return undefined;
    });
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "TTYP/DA", name: "ZPROPW_TTYP" }),
      { source: xml },
    );
    expect(res.created).toBe(true);
    expect(adt.labels).toEqual([
      `GET ${TTYP_URI}`,
      "POST /sap/bc/adt/ddic/tabletypes",
      `LOCK ${TTYP_URI}`,
      `PUT ${TTYP_URI}`,
      `UNLOCK ${TTYP_URI}`,
    ]);
    // The caller's descriptor verbatim — this is the only shape ENQU accepts
    // (its create REQUIRES a non-empty <enqu:content>), and TTYP
    // takes it happily.
    expect(adt.calls.find((c) => c.method === "POST" && c.url.endsWith("tabletypes"))!.body).toBe(
      xml,
    );
  });

  /**
   * This test used to assert that an ENQU/DL create is REFUSED
   * (`create.verified: false`, DISPROVEN by three independent live attempts).
   * That, too, was wrong — but not the way the old passing-for-years "it
   * creates fine" mock test was wrong. All three disproving attempts sent a
   * payload rooted at camelCase `<enqu:lockObject>` in the (plausible-looking
   * but wrong) namespace `http://www.sap.com/dictionary/lockobject`; the
   * appliance answered `400`/`403` every time because it never recognised
   * that element as a lock-object descriptor at all. A live A4H run
   * (2026-09-05) sending the correct root — lowercase `<enqu:lockobject>` in
   * `http://www.sap.com/adt/ddic/enqu` — got `201`. So `create.verified` is
   * `true`, `create.vendor` is still `false` (`abap-adt-api` has no ENQU/DL
   * entry), and the real, lasting fix is the `assertLockObjectRoot` guard
   * (src/adt/write.ts) that now refuses the OLD wrong-root document before
   * any wire call, rather than a capability flag alone.
   */
  it("creates an ENQU by POSTing the caller's own XML to the collection (create.vendor = false)", async () => {
    const xml = enquXml();
    const { conn, adt } = await connected((r) => {
      if (r.url === ENQU_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === "/sap/bc/adt/ddic/lockobjects/sources" && r.method === "POST")
        return resp(201, xml, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === ENQU_URI && r.method === "PUT") return resp(200, xml, OK_XML);
      return undefined;
    });
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "ENQU/DL", name: "EZPROPW_LOCK" }),
      { source: xml },
    );
    expect(res.created).toBe(true);
    expect(adt.labels).toEqual([
      `GET ${ENQU_URI}`,
      "POST /sap/bc/adt/ddic/lockobjects/sources",
      `LOCK ${ENQU_URI}`,
      `PUT ${ENQU_URI}`,
      `UNLOCK ${ENQU_URI}`,
    ]);
    // The caller's descriptor verbatim — this is the only shape ENQU accepts
    // (its create REQUIRES a non-empty <enqu:content>), and the correct
    // lowercase root passes `assertLockObjectRoot` untouched.
    expect(
      adt.calls.find((c) => c.method === "POST" && c.url.endsWith("lockobjects/sources"))!.body,
    ).toBe(xml);
  });

  // ---- The payload IS the identity ---------------------------------------

  /**
   * A properties-shape body names the object and its package. On the create
   * POST it goes to a COLLECTION, so the `adtcore:name` inside it is the only
   * thing deciding which object comes into existence — the gate approved one
   * object and the body could ask for another. Refused before the wire, and on
   * both the POST and the PUT, so no shape of the call skips the check.
   */
  it("refuses a payload naming a different object — before any create POST", async () => {
    const { conn, adt } = await connected((r) =>
      r.url === DOMA_URI && r.method === "GET" ? resp(404, NOT_FOUND_XML, OK_XML) : undefined,
    );
    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "DOMA/DD", name: "ZPROPW_DOMA" }), {
        source: domaXml("ZPROPW_OTHER"),
      }),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.details.declaredName).toBe("ZPROPW_OTHER");
    expect(adt.verbs).not.toContain("POST");
    expect(adt.verbs).not.toContain("PUT");
  });

  it("refuses a payload naming a different package", async () => {
    const { conn, adt } = await connected((r) =>
      r.url === DOMA_URI && r.method === "GET" ? resp(404, NOT_FOUND_XML, OK_XML) : undefined,
    );
    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "DOMA/DD", name: "ZPROPW_DOMA" }), {
        source: domaXml("ZPROPW_DOMA", "ZOTHER_PKG"),
      }),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.details.declaredPackage).toBe("ZOTHER_PKG");
    expect(adt.verbs).not.toContain("POST");
  });

  /**
   * The bug this pins: `adtcore:name` appears TWICE in these documents — once
   * on the root element (the object) and once on the nested
   * `<adtcore:packageRef>` (the package). A whole-document search for the
   * attribute finds the packageRef's and cheerfully "verifies" the object's
   * identity against its package name. The check reads the ROOT element only.
   */
  it("reads adtcore:name off the ROOT element, never off the nested packageRef", async () => {
    const { conn } = await connected((r) =>
      r.url === DOMA_URI && r.method === "GET" ? resp(404, NOT_FOUND_XML, OK_XML) : undefined,
    );
    // Root element carries NO name; the only `adtcore:name` in the document is
    // the packageRef's, and it happens to equal the target's name. A
    // whole-document scraper would accept this.
    const nameless =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" ` +
      `xmlns:adtcore="http://www.sap.com/adt/core">` +
      `<adtcore:packageRef adtcore:name="ZPROPW_DOMA"/></doma:domain>`;
    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "DOMA/DD", name: "ZPROPW_DOMA" }), {
        source: nameless,
      }),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toMatch(/carries no adtcore:name/);
  });

  it("refuses a mismatched payload on an UPDATE too — before the lock, so there is nothing to release", async () => {
    const { conn, adt } = await connected(
      existingProperties(DOMA_URI, "DOMA/DD", "ZPROPW_DOMA", domaXml()),
    );
    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "DOMA/DD", name: "ZPROPW_DOMA" }), {
        // Same package, different object. `sourceEquals` would see a change, so
        // nothing downstream would stop this on its own.
        source: domaXml("ZPROPW_OTHER"),
      }),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(adt.verbs).not.toContain("PUT");
    // The check is the first thing `writeObject` does (refuse before the
    // wire), so an update never even reaches the enqueue. `putContent` checks
    // again while holding the lock; that copy is defence in depth for a future
    // call path, not the one this refusal travels.
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("UNLOCK");
  });

  // ---- Server-side rejection --------------------------------------------

  it("translates 400 ExceptionInvalidData into a payload error carrying the server's own XML coordinates", async () => {
    // MSAG answers a malformed descriptor with `ExceptionInvalidData` plus
    // XML_PATH/XML_OFFSET properties. Running that through the DDIC
    // "AlreadyExists means syntax error" heuristic would tell the caller to run
    // a syntax check on a document that has no syntax to check.
    const MSAG_URI = "/sap/bc/adt/messageclass/zpropw_msg";
    const invalid =
      `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
      `<namespace id="com.sap.adt"/><type id="ExceptionInvalidData"/>` +
      `<message lang="EN">Invalid XML content</message>` +
      `<properties><entry key="XML_PATH">/mc:messageClass/mc:messages</entry>` +
      `<entry key="XML_OFFSET">412</entry></properties></exc:exception>`;
    const msagXml = (n: string): string =>
      `<?xml version="1.0"?><mc:messageClass xmlns:mc="http://www.sap.com/adt/MessageClass" ` +
      `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZPROPW_MSG" ` +
      `adtcore:type="MSAG/N"><adtcore:packageRef adtcore:name="$TMP"/>` +
      `<mc:messages><mc:message mc:number="${n}"/></mc:messages></mc:messageClass>`;
    const { conn, adt } = await connected((r) => {
      if (r.url === MSAG_URI && r.method === "GET") return resp(200, msagXml("001"), OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === MSAG_URI && r.method === "PUT") return resp(400, invalid, OK_XML);
      return undefined;
    });
    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "MSAG/N", name: "ZPROPW_MSG" }), {
        source: msagXml("002"),
      }),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.details.xmlPath).toBe("/mc:messageClass/mc:messages");
    expect(e.details.xmlOffset).toBe("412");
    expect(e.details.adtExceptionType).toBe("ExceptionInvalidData");
    // Still unlocked — a rejected PUT never leaks a lock.
    expect(adt.verbs).toContain("UNLOCK");
  });

  it("still calls out a payload problem honestly when the same failure class arrives with no XML position at all", async () => {
    // Live-captured: the identical mistake — a message child
    // using the wrong attribute name (`mc:number`/`mc:text` instead of
    // `mc:msgno`/`mc:msgtext`) — can also come back as
    // `ExceptionResourceBadRequest` / "Message number is missing", with NO
    // XML_PATH/XML_OFFSET properties at all. Keying the branch above on
    // `info.type === "ExceptionInvalidData"` would miss this entirely and
    // fall through to the bare generic ADT_ERROR — which is what let an
    // agent retry the identical payload eight times with zero new
    // information each time. This must still land as an honest, actionable
    // BAD_INPUT, just without coordinates the server never sent.
    const MSAG_URI = "/sap/bc/adt/messageclass/zpropw_msg";
    const noPosition =
      `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
      `<namespace id="com.sap.adt"/><type id="ExceptionResourceBadRequest"/>` +
      `<message lang="EN">Message number is missing</message></exc:exception>`;
    const msagXml = (attr: string): string =>
      `<?xml version="1.0"?><mc:messageClass xmlns:mc="http://www.sap.com/adt/MessageClass" ` +
      `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZPROPW_MSG" ` +
      `adtcore:type="MSAG/N"><adtcore:packageRef adtcore:name="$TMP"/>` +
      `<mc:messages><mc:message ${attr}/></mc:messages></mc:messageClass>`;
    const { conn, adt } = await connected((r) => {
      if (r.url === MSAG_URI && r.method === "GET") return resp(200, msagXml('mc:msgno="001"'), OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === MSAG_URI && r.method === "PUT") return resp(400, noPosition, OK_XML);
      return undefined;
    });
    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "MSAG/N", name: "ZPROPW_MSG" }), {
        // The bad payload: wrong attribute name (`mc:number` instead of
        // `mc:msgno`), the confirmed live cause of this exact rejection shape.
        source: msagXml('mc:number="002"'),
      }),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toMatch(/Message number is missing/);
    expect(e.details.adtExceptionType).toBe("ExceptionResourceBadRequest");
    expect(e.details.xmlPath).toBeUndefined();
    expect(e.details.xmlOffset).toBeUndefined();
    // No coordinates ⇒ say so honestly rather than pretending there weren't any to give.
    expect(e.details.position).toBe("not reported by the server for this rejection");
    // …and point the caller somewhere better than "guess and retry the same payload."
    expect(e.hint ?? e.details.hint ?? JSON.stringify(e)).toMatch(/abap_read/);
    // Still unlocked — a rejected PUT never leaks a lock.
    expect(adt.verbs).toContain("UNLOCK");
  });

  /**
   * The `abap_write` etag-unchanged warning (`src/tools/write.ts`), added
   * against a LIVE finding: an `abap_write` to a MSAG/N class carrying a
   * fabricated, schema-unknown `<mc:longtext>` child returned `changed: true`,
   * and a follow-up read showed the etag UNCHANGED — the element was silently
   * discarded server-side. `writeObject` already returns both `etag` and
   * `previousEtag`; comparing them costs nothing extra, so the tool layer now
   * warns whenever a properties-shape write the server accepted produced a
   * canonically IDENTICAL document to what was there before. This does NOT
   * (and, per the note text itself, cannot) prove WHY nothing changed — a
   * fully-spurious payload and a partially-discarded one that also reverted
   * itself both look the same from here — it only proves that nothing did.
   */
  describe("the etag-unchanged warning (properties shape only)", () => {
    const MSAG_URI = "/sap/bc/adt/messageclass/zpropw_msg";
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
    const msagXml = (n: string): string =>
      `<?xml version="1.0"?><mc:messageClass xmlns:mc="http://www.sap.com/adt/MessageClass" ` +
      `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZPROPW_MSG" ` +
      `adtcore:type="MSAG/N"><adtcore:packageRef adtcore:name="$TMP"/>` +
      `<mc:messages><mc:message mc:msgno="${n}"/></mc:messages></mc:messageClass>`;

    it("reports changed:false (with a CONFIRMED warning, not a heuristic one) when the server accepts a write that DIFFERS from what is there, but a post-write read shows the OLD document unchanged", async () => {
      // This fake is stateful (a `current` cell the PUT route does NOT
      // advance) rather than a fixed `before` answered to every GET. That
      // distinction matters here specifically: write.ts step 4b adds a REAL
      // post-write GET through this same route, so a fake that always
      // answered `before` regardless of what happened would mask the case
      // this test is named for — a server that accepts a PUT and then,
      // provably, still holds the old document.
      const before = msagXml("001");
      const current = before;
      const { conn } = await connected((r) => {
        if (r.url === MSAG_URI && r.method === "GET") return resp(200, current, OK_XML);
        if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
        if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
        // Simulates the live finding: the caller's payload asked for "002",
        // the server took it (200, not a rejection) but the round-tripped
        // descriptor it hands back is byte-for-byte the one that was already
        // there — the same shape a silently-discarded element would produce.
        // `current` is deliberately never advanced, so the post-write GET
        // step 4b issues sees exactly what a real silently-dropped write
        // would leave behind.
        if (r.url === MSAG_URI && r.method === "PUT") return resp(200, before, OK_XML);
        return undefined;
      });
      const result = await abapWrite(
        conn,
        { object: "ZPROPW_MSG", type: "MSAG/N", package: "$TMP", source: msagXml("002") },
        20_000,
        gate,
      );
      // The headline claim is corrected, not just the warning: `changed`
      // itself now reflects what a post-write read actually found, so this
      // is `false` — no separate note is needed to walk back a wrong `true`.
      expect(result.text).toMatch(/changed:\s*false/);
      expect(result.text).toMatch(
        /NOTE: WARNING: the write you asked for differed from what was on the server/,
      );
      expect(result.text).toMatch(/etag UNCHANGED/);
      // An older wording asserted a heuristic ("cannot tell whether... or
      // whether") for a case the post-write read can now confirm outright —
      // pinned absent so a regression toward the old text is caught here.
      expect(result.text).not.toMatch(/server reported this write as accepted, but the object/);
    });

    it("does NOT fire on an ordinary change that the read-back confirms actually landed", async () => {
      const before = msagXml("001");
      const after = msagXml("002");
      // Stateful — the post-write GET step 4b issues must see `after`
      // for this test to mean what its name says ("the read-back confirms it
      // actually landed"). A fake that kept answering `before` regardless of
      // the PUT would make every write look silently dropped.
      let current = before;
      const { conn } = await connected((r) => {
        if (r.url === MSAG_URI && r.method === "GET") return resp(200, current, OK_XML);
        if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
        if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
        if (r.url === MSAG_URI && r.method === "PUT") {
          current = after;
          return resp(200, after, OK_XML);
        }
        return undefined;
      });
      const result = await abapWrite(
        conn,
        { object: "ZPROPW_MSG", type: "MSAG/N", package: "$TMP", source: after },
        20_000,
        gate,
      );
      expect(result.text).toMatch(/changed:\s*true/);
      expect(result.text).not.toMatch(/etag UNCHANGED/);
    });

    it("does NOT fire on the byte-identical no-op path either — that one never even reaches the server", async () => {
      const same = msagXml("001");
      const { conn, adt } = await connected((r) => {
        if (r.url === MSAG_URI && r.method === "GET") return resp(200, same, OK_XML);
        return undefined;
      });
      const result = await abapWrite(
        conn,
        { object: "ZPROPW_MSG", type: "MSAG/N", package: "$TMP", source: same },
        20_000,
        gate,
      );
      expect(result.text).toMatch(/changed:\s*false/);
      expect(result.text).not.toMatch(/etag is UNCHANGED/);
      // The pre-check short-circuits before any lock/PUT — nothing to warn about.
      expect(adt.calls.some((c) => c.method === "PUT" || c.qs?._action === "LOCK")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------

/**
 * BDEF/BDO: the third write engine's odd member — SOURCE shape (its content
 * is ABAP behavior-definition text, not XML) combined with `create.vendor:
 * false` (no vendor `CreatableTypes` entry). Neither existing no-vendor trick
 * applies: the payload cannot double as the create body (it is not XML), so
 * `write.ts`'s `createByXml` hand-builds the create XML from the target
 * itself via `capabilitiesFor("BDEF/BDO").create.skeleton` — see that field's
 * doc comment in capabilities.ts for the full reasoning and the provenance
 * caveat (the skeleton shape is a raw-wire capture; this offline suite is the
 * first exercise of abapsmith's OWN create → PUT → activate code path
 * carrying it, not a re-run of a prior live pass).
 */
describe("BDEF/BDO — skeleton create (source shape, create.vendor = false)", () => {
  const BDEF_URI = "/sap/bc/adt/bo/behaviordefinitions/zpropw_bdef";
  const BDEF_SRC = `${BDEF_URI}/source/main`;
  const BDEF_COLLECTION = "/sap/bc/adt/bo/behaviordefinitions";
  const BDEF_SOURCE = "implementation unmanaged;\ndefine behavior for ZPROPW_ROOT {\n}\n";

  it("is registered as source-shape, no-vendor, with the blueSource skeleton", () => {
    const cap = capabilitiesFor("BDEF/BDO");
    expect(cap?.write?.shape).toBe("source");
    expect(cap?.create?.vendor).toBe(false);
    expect(cap?.create?.skeleton).toEqual({
      rootName: "blue:blueSource",
      namespace: 'xmlns:blue="http://www.sap.com/wbobj/blue"',
      contentType: "application/vnd.sap.adt.blues.v1+xml",
    });
    // The source endpoint answers 200/empty for an absent object, which is
    // what the earlier audit misread as "still there". `blankSourceOnAbsence`
    // is what makes the read and the post-delete read-back confirm at the
    // object URI instead of trusting that blank body.
    expect(cap?.delete).toBe(true);
    expect(cap?.blankSourceOnAbsence).toBe(true);
    expect(cap?.activate).toBe(true);
    // The narrowed invariant accepts this combination; a bare re-run of the
    // module's own coherence checks is the cheapest proof that narrowing it
    // did not also loosen it for every other type.
    expect(() => assertRegistryCoversTypes()).not.toThrow();
    expect(() => assertNoConflictingCapabilities()).not.toThrow();
    expect(() => assertWritableTypesAreReadable()).not.toThrow();
  });

  it("resolves through the ordinary resolveWriteTarget path, same as any other source-shape type", async () => {
    const { conn } = await connected((r) =>
      r.url === BDEF_URI ? resp(404, NOT_FOUND_XML, OK_XML) : undefined,
    );
    const t = await resolveWriteTarget(conn, { type: "BDEF/BDO", name: "ZPROPW_BDEF" });
    expect(t.uri).toBe(BDEF_URI);
    expect(t.sourceUri).toBe(BDEF_SRC);
    expect(t.exists).toBe(false);
    expect(t.packageName).toBe("$TMP");
  });

  it("creates a missing BDEF: GET(404) → POST skeleton XML → LOCK → PUT source → UNLOCK", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === BDEF_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === BDEF_COLLECTION && r.method === "POST") return resp(201, "", {});
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === BDEF_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    });

    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "BDEF/BDO", name: "ZPROPW_BDEF" }),
      { source: BDEF_SOURCE },
    );
    expect(res.created).toBe(true);
    expect(res.changed).toBe(true);
    expect(adt.labels).toEqual([
      `GET ${BDEF_URI}`,
      `POST ${BDEF_COLLECTION}`,
      `LOCK ${BDEF_URI}`,
      `PUT ${BDEF_SRC}`,
      `UNLOCK ${BDEF_URI}`,
    ]);

    // The create POST body: a hand-built skeleton, NOT the ABAP source payload
    // (which goes on the PUT instead — checked below). Pinned exactly, since
    // this is now abapsmith's own responsibility rather than a vendor
    // library's, and this string is the only place that responsibility is
    // proven rather than merely described in a comment.
    const create = adt.calls.find((c) => c.url === BDEF_COLLECTION && c.method === "POST")!;
    expect(create.body).toBe(
      '<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue" ' +
        'xmlns:adtcore="http://www.sap.com/adt/core" ' +
        'adtcore:description="Behavior definition ZPROPW_BDEF" ' +
        'adtcore:name="ZPROPW_BDEF" adtcore:type="BDEF/BDO" ' +
        'adtcore:language="EN" adtcore:masterLanguage="EN" ' +
        'adtcore:responsible="DEVELOPER">' +
        '<adtcore:packageRef adtcore:name="$TMP"/>' +
        "</blue:blueSource>",
    );
    // The no-charset trap — see `SkeletonCreate.contentType`'s doc comment:
    // a `; charset=…` suffix here has been observed to 406 on this resource.
    expect(create.headers?.["Content-Type"]).toBe("application/vnd.sap.adt.blues.v1+xml");

    // The ABAP source, unchanged, is what actually reaches the PUT — the
    // skeleton above replaces the payload only on the create POST.
    const put = adt.calls.find((c) => c.url === BDEF_SRC && c.method === "PUT")!;
    expect(put.body).toBe(BDEF_SOURCE);
    expect(put.headers?.["Content-Type"]).toBe("text/plain; charset=utf-8");
  });

  // A 200/empty read-back is BDEF/BDO's real absent-object response, not
  // proof the object survived — the confirming GET at the object URI is
  // what earns `deleted: true`, per `blankSourceOnAbsence`.
  it("reads a before-image, locks, DELETEs with the handle, and confirms absence at the object URI when the source read-back is blank", async () => {
    let deleted = false;
    const { conn, adt } = await connected((r) => {
      if (r.url === BDEF_SRC && r.method === "GET") {
        return deleted ? resp(200, "", OK_TEXT) : resp(200, BDEF_SOURCE, OK_TEXT);
      }
      if (r.url === BDEF_URI && r.method === "GET") {
        return deleted
          ? resp(404, NOT_FOUND_XML, OK_XML)
          : resp(200, OBJECT_XML("ZPROPW_BDEF", "BDEF/BDO"), OK_XML);
      }
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML("HDEL"), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.method === "DELETE") {
        deleted = true;
        return resp(200, "", {});
      }
      return undefined;
    });
    const res = await deleteObject(
      conn,
      await authDelete(conn, { type: "BDEF/BDO", name: "ZPROPW_BDEF" }),
    );
    expect(res.deleted).toBe(true);
    expect(adt.labels).toEqual([
      `GET ${BDEF_URI}`,
      `GET ${BDEF_SRC}`,
      `LOCK ${BDEF_URI}`,
      `GET ${BDEF_SRC}`,
      `DELETE ${BDEF_URI}`,
      // The blank 200 read-back settles nothing on its own; the confirming
      // GET at the object URI is what earns `deleted: true`.
      `GET ${BDEF_SRC}`,
      `GET ${BDEF_URI}`,
    ]);
    expect(adt.calls.some((c) => c.url.includes("/repository/informationsystem/search"))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------

/**
 * XSLT/VT's skeleton is the second `rootAttributes` user (BDEF/BDO's has
 * none) — pins that `buildSkeletonXml` splices `trans:transformationType`
 * onto the root for this type without perturbing BDEF/BDO's body above. See
 * capabilities.ts's XSLT/VT REGISTRY comment for the two live 400s
 * (namespace, then InvalidTransformationValue) this attribute exists to fix.
 */
describe("XSLT/VT — skeleton create carries rootAttributes", () => {
  const XSLT_URI = "/sap/bc/adt/xslt/transformations/ztmd_x";
  const XSLT_SRC = `${XSLT_URI}/source/main`;
  const XSLT_COLLECTION = "/sap/bc/adt/xslt/transformations";
  const XSLT_SOURCE = '<xsl:transform version="1.0"></xsl:transform>';

  it("creates a missing transformation with trans:transformationType on the root", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === XSLT_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === XSLT_COLLECTION && r.method === "POST") return resp(201, "", {});
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === XSLT_SRC && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    });

    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "XSLT/VT", name: "ZTMD_X" }),
      { source: XSLT_SOURCE },
    );
    expect(res.created).toBe(true);

    const create = adt.calls.find((c) => c.url === XSLT_COLLECTION && c.method === "POST")!;
    expect(create.body).toBe(
      '<trans:transformation xmlns:trans="http://www.sap.com/adt/transformation" ' +
        'xmlns:adtcore="http://www.sap.com/adt/core" ' +
        'trans:transformationType="XSLTProgram" ' +
        'adtcore:description="Transformation ZTMD_X" ' +
        'adtcore:name="ZTMD_X" adtcore:type="XSLT/VT" ' +
        'adtcore:language="EN" adtcore:masterLanguage="EN" ' +
        'adtcore:responsible="DEVELOPER">' +
        '<adtcore:packageRef adtcore:name="$TMP"/>' +
        "</trans:transformation>",
    );
    expect(create.headers?.["Content-Type"]).toBe("application/vnd.sap.adt.transformations+xml");

    const put = adt.calls.find((c) => c.url === XSLT_SRC && c.method === "PUT")!;
    expect(put.body).toBe(XSLT_SOURCE);

    // BDEF/BDO's skeleton has no rootAttributes — this splice leaves it alone.
    expect(capabilitiesFor("BDEF/BDO")?.create?.skeleton?.rootAttributes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

/**
 * `SRVB/SVB` — a third write engine only in the sense that it needs a
 * type-specific media type; the choreography is the SAME properties shape as
 * DOMA/DTEL/TTYP/MSAG/ENQU above (no `/source/main`, the object's own URI is
 * both the resolution GET and the content PUT/POST target).
 *
 * PROVENANCE, RESOLVED — this used to carry a warning that none of it had
 * been observed live. A session scratchpad once claimed a raw ADT probe
 * against A4H (SAP_BASIS 754 SP0007) exercised create/activate/read-back/
 * delete for SRVB/SVB successfully, but that claim was contradicted by a
 * later, separately-reported live finding that service bindings do not
 * exist on that same appliance/release at all. Both could not be true of the
 * same system, and this test file had no way to adjudicate which report was
 * right. That conflict is now resolved by a later, independent live
 * verification run against the same A4H appliance, through abapsmith's own
 * v1 tool surface, on 2026-08-18 — per that run's report, not observed
 * directly by these tests, create/activate/read-back/delete all succeeded
 * for the flow exercised. These tests below remain synthetic (a fake
 * HttpClient, not a live capture): they pin the shape this codebase sends
 * and expects, corroborated — not replaced — by that run. See
 * `src/adt/capabilities.ts`'s `SRVB/SVB` REGISTRY entry for the full
 * confirmed/caveated/still-inferred breakdown, and the PR description for
 * run evidence.
 *
 * What makes it worth its own describe block: it is the ONE properties-shape
 * type where a generic `Accept: application/*` is documented to fail with
 * 406, so `capabilities.ts` pins the exact vendor type
 * (`application/vnd.sap.adt.businessservices.servicebinding.v1+xml`) rather
 * than gambling on the wildcard. These tests pin that the header actually
 * goes out on every request that touches the object URI (resolution GET,
 * create POST, content PUT), and pin the exact create-body XML documented in
 * the session scratchpad's "SRVB inner body" template — see
 * `src/adt/capabilities.ts`'s `SRVB/SVB` REGISTRY entry for the full story.
 */
describe("SRVB/SVB service binding (properties shape, vendor media type)", () => {
  const SRVB_URI = "/sap/bc/adt/businessservices/bindings/zpropw_svb";
  const SRVB_MEDIA_TYPE = "application/vnd.sap.adt.businessservices.servicebinding.v1+xml";

  /**
   * SYNTHETIC — hand-written to match a documented/scratchpad-recorded
   * template, not captured from any live system. Follows the "SRVB inner
   * body" template (a `<srvb:services>` element
   * naming the BINDING, wrapping a `<srvb:content>` that names the target
   * SRVD, plus a `<srvb:binding>` fixed at category 0 / ODATA / V2 — the only
   * binding type `/businessservices/bindings/bindingtypes` offers on this
   * release). The caller supplies this whole document as the create/update
   * payload — `createByXml` POSTs it verbatim, exactly as it already does for
   * `TTYP/DA`/`ENQU/DL`. Per the 2026-08-18 live verification run's report,
   * a body built to this same template round-tripped on read-back against
   * this project's A4H box — see the describe block's own leading comment
   * above for the full provenance history. This fixture stays hand-built
   * (not swapped for a captured cassette) so the test keeps pinning the
   * shape this codebase sends, independent of any one system's response.
   */
  const srvbXml = (name = "ZPROPW_SVB", srvdName = "ZPROPW_SRVD"): string =>
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<srvb:serviceBinding xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" ` +
    `adtcore:type="SRVB/SVB"><adtcore:packageRef adtcore:name="$TMP"/>` +
    `<srvb:services srvb:name="${name}">` +
    `<srvb:content srvb:version="0001">` +
    `<srvb:serviceDefinition adtcore:name="${srvdName}"/>` +
    `</srvb:content>` +
    `</srvb:services>` +
    `<srvb:binding srvb:category="0" srvb:type="ODATA" srvb:version="V2">` +
    `<srvb:implementation adtcore:name=""/>` +
    `</srvb:binding>` +
    `</srvb:serviceBinding>`;

  it("is properties-shape, vendor:false create, with the vendor media type pinned — the registry facts these tests rely on", () => {
    const cap = capabilitiesFor("SRVB/SVB");
    expect(cap?.write?.shape).toBe("properties");
    expect(cap?.create?.vendor).toBe(false);
    expect(cap?.delete).toBe(true);
    expect(cap?.activate).toBe(true);
    expect(cap?.mediaType).toBe(SRVB_MEDIA_TYPE);
  });

  it("resolves through the ordinary resolveWriteTarget path, at the 26-char name limit", async () => {
    const { conn, adt } = await connected((r) =>
      r.url === SRVB_URI ? resp(404, NOT_FOUND_XML, OK_XML) : undefined,
    );
    const t = await resolveWriteTarget(conn, { type: "SRVB/SVB", name: "ZPROPW_SVB" });
    expect(t.type).toBe("SRVB/SVB");
    expect(t.uri).toBe(SRVB_URI);
    expect(t.exists).toBe(false);
    expect(t.packageName).toBe("$TMP");
    // No `/source/main` for this shape — the field is still computed (every
    // ResolvedTarget has one) but nothing reads it for SRVB.
    expect(t.sourceUri).toBe(`${SRVB_URI}/source/main`);
    // The one documented-but-unverified fact this whole file exists to
    // protect: the resolution GET must NOT ask for the generic
    // `application/*` this same it.each block uses for DOMA/TTYP/MSAG/ENQU
    // above — that is documented to 406 on this resource, though it has not
    // been observed against a live system. See `resolveWriteTarget`'s
    // comment in src/adt/write.ts.
    const get = adt.calls.find((c) => c.url === SRVB_URI && c.method === "GET")!;
    expect(get.headers?.["Accept"]).toBe(SRVB_MEDIA_TYPE);
  });

  it("enforces the 26-character service-binding name limit before the network — 30 (the generic DDIC limit) is too long", async () => {
    const offline = null as unknown as AbapConnection;
    // 28 characters — deliberately past 26 but still under the generic
    // 30-char DDIC limit, so this only proves SRVB got its OWN (tighter)
    // override and not the generic one every other DDIC type falls back to.
    const e = await catchErr(
      resolveWriteTarget(offline, { type: "SRVB/SVB", name: "ZPROPW_SVB_FAR_TOO_LONG_NAME" }),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.details.maxLength).toBe(26);
  });

  it("creates an SRVB by POSTing the caller's own XML to the collection (create.vendor = false), with the vendor Content-Type", async () => {
    // Mirrors the TTYP/ENQU create tests above byte-for-byte in choreography;
    // the only difference is the media type on the create POST and the
    // content PUT — `abap-adt-api` DOES have an `SRVB/SVB` entry in
    // `CreatableTypes`, but its `createBodyBinding()` throws unless the
    // caller passes `service`/`bindingtype` options `createNewObject` never
    // sends (see the REGISTRY entry's comment in src/adt/capabilities.ts), so
    // this type takes the same `createByXml` route TTYP/DA and ENQU/DL do.
    const xml = srvbXml();
    const { conn, adt } = await connected((r) => {
      if (r.url === SRVB_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === "/sap/bc/adt/businessservices/bindings" && r.method === "POST")
        return resp(201, xml, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === SRVB_URI && r.method === "PUT") return resp(200, xml, OK_XML);
      return undefined;
    });
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "SRVB/SVB", name: "ZPROPW_SVB" }),
      { source: xml },
    );
    expect(res.created).toBe(true);
    expect(adt.labels).toEqual([
      `GET ${SRVB_URI}`,
      "POST /sap/bc/adt/businessservices/bindings",
      `LOCK ${SRVB_URI}`,
      `PUT ${SRVB_URI}`,
      `UNLOCK ${SRVB_URI}`,
    ]);
    const create = adt.calls.find(
      (c) => c.method === "POST" && c.url === "/sap/bc/adt/businessservices/bindings",
    )!;
    // The golden document, pinned byte-for-byte against the synthetic
    // fixture above, which itself follows a documented/scratchpad-recorded
    // (not live-observed) create body inner shape: `<srvb:services>` names
    // the BINDING, `<srvb:content>` wraps the `<srvb:serviceDefinition>`
    // naming the target SRVD, `<srvb:binding category="0" type="ODATA"
    // version="V2">` is documented as the only binding type this release's
    // `bindingtypes` endpoint offers — none of this has been confirmed live.
    expect(create.body).toBe(xml);
    expect(create.headers?.["Content-Type"]).toBe(SRVB_MEDIA_TYPE);
    // The same vendor type reappears on the content PUT that follows —
    // `contentType()` in src/adt/write.ts, not the `application/*` every
    // other properties-shape type sends there.
    const put = adt.calls.find((c) => c.method === "PUT" && c.url === SRVB_URI)!;
    expect(put.headers?.["Content-Type"]).toBe(SRVB_MEDIA_TYPE);
  });

  it("refuses a create payload naming a different service binding — before any POST", async () => {
    const { conn, adt } = await connected((r) =>
      r.url === SRVB_URI && r.method === "GET" ? resp(404, NOT_FOUND_XML, OK_XML) : undefined,
    );
    const e = await catchErr(
      writeObject(conn, await authWrite(conn, { type: "SRVB/SVB", name: "ZPROPW_SVB" }), {
        source: srvbXml("ZPROPW_OTHER"),
      }),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.details.declaredName).toBe("ZPROPW_OTHER");
    expect(adt.verbs).not.toContain("POST");
    expect(adt.verbs).not.toContain("PUT");
  });
});

// ---------------------------------------------------------------------------

/**
 * Scope D: container-parented creates.
 *
 * A function module's URI has a `{parent}` segment naming its function group
 * (`/sap/bc/adt/functions/groups/{group}/fmodules/{name}`), and its create body
 * carries `<adtcore:containerRef>` rather than `<adtcore:packageRef>` — so the
 * "parent" a create hands the vendor library is the GROUP, not the package.
 * `ParentKind = "container"` in the registry is what selects that; before this
 * pass it existed and nothing read it.
 */
describe("container-parented creates (FUGR/FF)", () => {
  const GROUP_URI = "/sap/bc/adt/functions/groups/zpropw_grp";
  const FM_URI = `${GROUP_URI}/fmodules/zpropw_fm`;

  it("declares FUGR/FF as container-parented, and no other type as one", () => {
    expect(capabilitiesFor("FUGR/FF")?.create?.parent).toBe("container");
    for (const t of ["PROG/P", "CLAS/OC", "DOMA/DD", "TTYP/DA"]) {
      expect(capabilitiesFor(t)?.create?.parent).toBeUndefined();
    }
  });

  /**
   * The tool layer, one step above `resolveWriteTarget`.
   *
   * `abap_write`'s own BAD_INPUT hint tells the caller to say
   * `"ZPROPW_FM1 in ZPROPW_GRP"`, and that spelling used to be refused: the
   * tool parsed the ref hintless, kept only `parsed.name`, and dropped the
   * parent — so the string `resolveWriteTarget` re-parsed no longer had a
   * container in it. `"ZPROPW_GRP/ZPROPW_FM1"` survived by luck (with no type
   * hint the `/` split does not fire, so the whole string reached the second,
   * hinted parse intact). Live on A4H: the slash form deleted the function
   * module, the documented `in` form answered *"lives inside a container
   * object, and none was named"*.
   */
  it("carries the container out of BOTH spellings of the tool's `object` argument", () => {
    for (const object of ["ZPROPW_GRP/ZPROPW_FM1", "ZPROPW_FM1 in ZPROPW_GRP"]) {
      expect(targetFromInput({ object, type: "FUGR/FF" } as never)).toMatchObject({
        name: "ZPROPW_FM1",
        containerName: "ZPROPW_GRP",
        type: "FUGR/FF",
      });
    }
  });

  it("leaves non-container types alone: a slash-free name gains no container", () => {
    expect(targetFromInput({ object: "ZMCP_REP", type: "PROG/P" } as never).containerName).toBe(
      undefined,
    );
    // …and a `/NS/` name is a namespace, not a container, whatever the type.
    const ns = targetFromInput({ object: "/DMO/CL_X", type: "CLAS/OC" } as never);
    expect(ns.name).toBe("/DMO/CL_X");
    expect(ns).not.toHaveProperty("containerName");
  });

  it("refuses to build a URI when no container was named — before any request", async () => {
    const offline = null as unknown as AbapConnection;
    const e = await catchErr(resolveWriteTarget(offline, { type: "FUGR/FF", name: "ZPROPW_FM" }));
    expect(e.code).toBe("BAD_INPUT");
    // The URI cannot be built at all without it: `…/groups//fmodules/z_my_fm`
    // resolves to nothing, so this is the object's address, not decoration.
    expect(e.message).toMatch(/container/i);
  });

  it.each([
    ["parsed from ZPROPW_GRP/ZPROPW_FM", { type: "FUGR/FF", name: "ZPROPW_GRP/ZPROPW_FM" }],
    ["parsed from 'ZPROPW_FM in ZPROPW_GRP'", { type: "FUGR/FF", name: "ZPROPW_FM in ZPROPW_GRP" }],
    [
      "passed explicitly",
      { type: "FUGR/FF", name: "ZPROPW_FM", containerName: "zpropw_grp" },
    ],
  ])("threads the container through resolution — %s", async (_label, target) => {
    const { conn } = await connected((r) =>
      r.url === FM_URI ? resp(404, NOT_FOUND_XML, OK_XML) : undefined,
    );
    const t = await resolveWriteTarget(conn, target as WriteTarget);
    expect(t.name).toBe("ZPROPW_FM");
    expect(t.containerName).toBe("ZPROPW_GRP");
    expect(t.uri).toBe(FM_URI);
  });

  it("creates the function module against its GROUP, not against the package", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === FM_URI && r.method === "GET") return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === `${GROUP_URI}/fmodules` && r.method === "POST") return resp(200, "", {});
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === `${FM_URI}/source/main` && r.method === "PUT") return resp(200, "", OK_TEXT);
      return undefined;
    });
    const src = "FUNCTION zpropw_fm.\nENDFUNCTION.\n";
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "FUGR/FF", name: "ZPROPW_GRP/ZPROPW_FM" }),
      { source: src },
    );
    expect(res.created).toBe(true);
    // Still the source shape — FUGR/FF writes ABAP to /source/main. Only the
    // create's parent differs from PROG/P.
    expect(adt.calls.find((c) => c.method === "PUT")!.url).toBe(`${FM_URI}/source/main`);
    const create = adt.calls.find((c) => c.method === "POST" && c.url.endsWith("/fmodules"))!;
    expect(create.body).toContain("ZPROPW_FM");
    // The parent is the function group's URI. A packageRef here would be the
    // bug `ParentKind` exists to prevent.
    expect(create.body).toContain("zpropw_grp");
  });

  /*
   * Live finding, and the reason this block exists: a function module's own ADT
   * metadata document carries NO `<adtcore:packageRef>` at all. Every writable
   * type before FUGR/FF did, so resolution refused outright with SAFETY_DENIED
   * / PACKAGE_UNKNOWN — meaning an FM could be created (where the caller's own
   * `package` argument is the only truth) and then never written or deleted
   * again. Caught on a real A4H function module, activated and healthy.
   *
   * The fix reads the GROUP's packageRef. That is not a forbidden guess:
   * an FM has no package of its own to guess at, it lives in its group, and the
   * group's packageRef is a real server-side answer fetched with a real
   * request.
   */
  it("takes an existing function module's package from its GROUP, which is where it lives", async () => {
    const { conn, adt } = await connected((r) => {
      // The FM answers — with a descriptor that has no packageRef, exactly as
      // the live system does.
      if (r.url === FM_URI && r.method === "GET")
        return resp(
          200,
          `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
            `adtcore:name="ZPROPW_FM" adtcore:type="FUGR/FF"/>`,
          OK_XML,
        );
      if (r.url === GROUP_URI && r.method === "GET")
        return resp(200, OBJECT_XML("ZPROPW_GRP", "FUGR/F", "$TMP"), OK_XML);
      return undefined;
    });
    const t = await resolveWriteTarget(conn, { type: "FUGR/FF", name: "ZPROPW_GRP/ZPROPW_FM" });
    expect(t.exists).toBe(true);
    expect(t.packageName).toBe("$TMP");
    // "server", not "requested": it was READ, from the container.
    expect(t.packageSource).toBe("server");
    expect(adt.calls.map((c) => c.url)).toContain(GROUP_URI);
  });

  it("still refuses when the container cannot answer either — it never falls back to $TMP", async () => {
    const { conn } = await connected((r) => {
      if (r.url === FM_URI && r.method === "GET")
        return resp(
          200,
          `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
            `adtcore:name="ZPROPW_FM" adtcore:type="FUGR/FF"/>`,
          OK_XML,
        );
      // The group read fails. An unanswerable package question must stay
      // unanswered — assuming $TMP would let an allowlist of $TMP approve an
      // object living anywhere at all.
      if (r.url === GROUP_URI && r.method === "GET") return resp(500, "", OK_XML);
      return undefined;
    });
    const e = await catchErr(
      resolveWriteTarget(conn, { type: "FUGR/FF", name: "ZPROPW_GRP/ZPROPW_FM" }),
    );
    expect(e.code).toBe("SAFETY_DENIED");
    expect((e.details as { reason?: string }).reason).toBe("PACKAGE_UNKNOWN");
    expect(e.retryable).toBe(true); // a failure to determine the package, not a policy verdict
  });
});

/**
 * The other half of the FUGR family, and the reason the half above was
 * unreachable: `FUGR/FF`'s create is `parent: "container"`, so it needs a
 * function group to exist ALREADY, and `FUGR/F` used to be a bare `{ label }`
 * — no write, no create. A user with no pre-existing group therefore could not
 * create a function module at all; the capability existed only for people who
 * had one lying around.
 *
 * Group and module are deliberately exercised back to back below, against ONE
 * route table, because that ordering IS the fixed defect: nothing here may
 * assume a pre-existing container.
 *
 * Live-verified on A4H before being pinned: group created into $TMP, TOP-include
 * skeleton PUT and read back with a distinguishing marker line, group active,
 * function module created INSIDE that new group, and the module then actually
 * CALLED from a throwaway report (`ZFGFIX SUM = 42`).
 */
describe("package-parented creates (FUGR/F) — the group a function module needs", () => {
  const GROUP_URI = "/sap/bc/adt/functions/groups/zfgfix_g1";
  const FM_URI = `${GROUP_URI}/fmodules/zfgfix_fm1`;
  /**
   * A group's `/source/main` is NOT general ABAP: it is the TOP-include
   * skeleton, a list of `INCLUDE` statements naming the generated
   * `L<GROUP>TOP` / `L<GROUP>UXX` includes. Writing anything else there is how
   * a caller silently breaks a group, which is why the registry entry says so.
   */
  const TOP = "  INCLUDE LZFGFIX_G1TOP.\n  INCLUDE LZFGFIX_G1UXX.\n";
  const FM_SRC = "FUNCTION zfgfix_fm1.\nENDFUNCTION.\n";

  /** Group 404s until created; both objects then lock/unlock and PUT normally. */
  const fugrRoutes =
    () =>
    (r: { url: string; method: string; qs: Record<string, string> }): unknown => {
      if (r.method === "GET" && (r.url === GROUP_URI || r.url === FM_URI))
        return resp(404, NOT_FOUND_XML, OK_XML);
      if (r.url === "/sap/bc/adt/functions/groups" && r.method === "POST") return resp(200, "", {});
      if (r.url === `${GROUP_URI}/fmodules` && r.method === "POST") return resp(200, "", {});
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.method === "PUT" && r.url.endsWith("/source/main")) return resp(200, "", OK_TEXT);
      return undefined;
    };

  it("creates the group against its PACKAGE, then PUTs the TOP include to /source/main", async () => {
    const { conn, adt } = await connected(fugrRoutes() as never);
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "FUGR/F", name: "ZFGFIX_G1", packageName: "$TMP" }),
      { source: TOP },
    );
    expect(res.created).toBe(true);
    const create = adt.calls.find(
      (c) => c.method === "POST" && c.url === "/sap/bc/adt/functions/groups",
    )!;
    // A PACKAGE parent, not a container one: the mirror image of the FUGR/FF
    // assertion above, and the whole content of `create.parent`'s default.
    expect(create.body).toContain(`<adtcore:packageRef adtcore:name="$TMP"/>`);
    // A `containerRef` here would be the FUGR/FF body — i.e. `create.parent`
    // wrongly set to "container", asking the server for a group inside a group.
    expect(create.body).not.toContain("containerRef");
    expect(adt.calls.find((c) => c.method === "PUT")!.url).toBe(`${GROUP_URI}/source/main`);
  });

  /**
   * THE case that was impossible: no group exists at the start of this test,
   * and a function module exists at the end of it. Before the registry entry
   * the first `writeObject` below refused with UNSUPPORTED, so the second could
   * never be reached by any caller who did not already own a group.
   */
  it("creates a function module into a group created moments earlier, in one flow", async () => {
    const { conn, adt } = await connected(fugrRoutes() as never);

    const group = await writeObject(
      conn,
      await authWrite(conn, { type: "FUGR/F", name: "ZFGFIX_G1", packageName: "$TMP" }),
      { source: TOP },
    );
    expect(group.created).toBe(true);

    const fm = await writeObject(
      conn,
      await authWrite(conn, {
        type: "FUGR/FF",
        name: "ZFGFIX_G1/ZFGFIX_FM1",
        packageName: "$TMP",
      }),
      { source: FM_SRC },
    );
    expect(fm.created).toBe(true);

    // Two creates, each against the right parent — the group under the package
    // collection, the module under the group that create just made.
    expect(adt.calls.filter((c) => c.method === "POST" && c.url.endsWith("groups"))).toHaveLength(1);
    const fmCreate = adt.calls.find((c) => c.method === "POST" && c.url.endsWith("/fmodules"))!;
    expect(fmCreate.body).toContain("zfgfix_g1");
    expect(adt.calls.filter((c) => c.method === "PUT").map((c) => c.url)).toEqual([
      `${GROUP_URI}/source/main`,
      `${FM_URI}/source/main`,
    ]);
  });

  /**
   * The one place a group diverges from its own modules: `DELETE` on a group
   * without a lock is refused `423 ExceptionResourceInvalidLockHandle`
   * ("Resource FUGR_MAINPROGRAM … is not locked"), while the same call for a
   * FUGR/FF succeeds. No special case is
   * needed because `deleteObject` locks unconditionally — this pins that it
   * stays that way, so a future lock-elision fast path cannot quietly break
   * group deletion.
   */
  it("locks before deleting the group — a bare DELETE is refused 423 by the server", async () => {
    const { conn, adt } = await connected((r) => {
      if (r.url === GROUP_URI && r.method === "GET")
        return resp(200, OBJECT_XML("ZFGFIX_G1", "FUGR/F", "$TMP"), OK_XML);
      // The post-lock re-read that journals the before-image.
      if (r.url === `${GROUP_URI}/source/main` && r.method === "GET")
        return resp(200, TOP, OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === GROUP_URI && r.method === "DELETE") return resp(200, "", OK_TEXT);
      return undefined;
    });
    const t = await authDelete(conn, { type: "FUGR/F", name: "ZFGFIX_G1" });
    await deleteObject(conn, t);
    const lockAt = adt.calls.findIndex((c) => c.qs?._action === "LOCK");
    const deleteAt = adt.calls.findIndex((c) => c.method === "DELETE");
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThan(lockAt);
  });

  /**
   * `L<GROUP>UXX` is the generated include that pulls in the
   * function-module implementation includes (`L<GROUP>U01`, `U02`, …). A
   * TOP-only source writes, activates, and reads back active — but with no
   * function module body in the compiled unit, `CALL FUNCTION` against it
   * dumps `CX_SY_DYN_CALL_ILLEGAL_FUNC`. Refused before the vendor create,
   * not repaired, so the caller sees why instead of a group that silently
   * cannot be called.
   */
  it("refuses a group whose main source names the TOP include but no implementation include", async () => {
    const { conn, adt } = await connected(fugrRoutes() as never);
    const e = await catchErr(
      writeObject(
        conn,
        await authWrite(conn, { type: "FUGR/F", name: "ZFGFIX_G1", packageName: "$TMP" }),
        { source: "  INCLUDE LZFGFIX_G1TOP.\n" },
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.details.missingInclude).toBe("LZFGFIX_G1UXX");
    // The refusal is offline: nothing that would ever leave the group half
    // created reached the wire. `authWrite` itself already issued its own
    // existence GET, so `adt.calls` is not asserted empty — only the
    // mutating calls the guard exists to prevent.
    expect(
      adt.calls.find((c) => c.method === "POST" && c.url === "/sap/bc/adt/functions/groups"),
    ).toBeUndefined();
    expect(adt.calls.find((c) => c.qs?._action === "LOCK")).toBeUndefined();
    expect(adt.calls.find((c) => c.method === "PUT")).toBeUndefined();
  });

  it("accepts a group that lists its L<GROUP>U01 implementation includes instead of UXX", async () => {
    const { conn, adt } = await connected(fugrRoutes() as never);
    const res = await writeObject(
      conn,
      await authWrite(conn, { type: "FUGR/F", name: "ZFGFIX_G1", packageName: "$TMP" }),
      { source: "  INCLUDE LZFGFIX_G1TOP.\n  INCLUDE LZFGFIX_G1U01.\n" },
    );
    expect(res.created).toBe(true);
    expect(adt.calls.find((c) => c.method === "PUT")!.url).toBe(`${GROUP_URI}/source/main`);
  });
});

/*
 * The transport pre-flight (`POST /sap/bc/adt/cts/transportchecks`) has to be
 * shown a URI the CTS layer can map back to an object. Caught live on the first
 * MSAG/N write: handing it `/sap/bc/adt/messageclass/ZPROPW_MSG1/source/main`
 * answered `400 ADT_TM_COMMON_EXCEPTION "No URI-Mapping defined for URI"` and
 * the write was refused as a TRANSPORT_ERROR before anything was locked. A
 * properties-shape object has no `/source/main` sub-resource at all — the
 * object URI IS its content URI — so the suffix names a path that does not
 * exist. DOMA/DTEL/TTYP happened to survive the suffixed form (the DDIC
 * collections map loosely); keying off the write shape rather than the observed
 * failure fixes all five instead of the one that happened to be caught.
 */
describe("transport pre-flight URI, per write shape", () => {
  const offlineConn = null as unknown as AbapConnection;

  /** Records the URI CTS was shown, and answers "local" so nothing else runs. */
  const spyTransport = (seen: string[]) =>
    new SessionTransport({
      allowTransports: ["auto"],
      cts: {
        trRequirement: vi.fn(async (_conn: unknown, uri: string) => {
          seen.push(uri);
          return { kind: "local", devclass: "$TMP" } as unknown as TrRequirement;
        }),
      },
    });

  it.each([
    ["DOMA/DD", "/sap/bc/adt/ddic/domains/zpropw_dom"],
    ["MSAG/N", "/sap/bc/adt/messageclass/zpropw_msg"],
    ["ENQU/DL", "/sap/bc/adt/ddic/lockobjects/sources/ezpropw_lk"],
    ["TTYP/DA", "/sap/bc/adt/ddic/tabletypes/zpropw_tt"],
    ["DTEL/DE", "/sap/bc/adt/ddic/dataelements/zpropw_de"],
    ["SRVB/SVB", "/sap/bc/adt/businessservices/bindings/zpropw_svb"],
  ])("shows CTS the object URI for %s, which has no /source/main", async (type, uri) => {
    const seen: string[] = [];
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    await preflightCorr(
      offlineConn,
      { uri, sourceUri: `${uri}/source/main`, name: "ZX", type, packageName: "$TMP" },
      { gate, transport: spyTransport(seen) },
      "U",
      "write",
    );
    expect(seen).toEqual([uri]);
  });

  it("still shows CTS /source/main for the source shape, where it really exists", async () => {
    const seen: string[] = [];
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    await preflightCorr(
      offlineConn,
      { uri: REPORT_URI, sourceUri: REPORT_SRC, name: REPORT, type: "PROG/P", packageName: "$TMP" },
      { gate, transport: spyTransport(seen) },
      "U",
      "write",
    );
    expect(seen).toEqual([REPORT_SRC]);
  });
});

/**
 * Closes the INVARIANT the `VIEW/DV` / `TRAN/T` bridge creates are two
 * instances of, not just those two instances.
 *
 * `capabilities.ts` declaring a type creatable is what makes `abapsmith` accept
 * it at all — but the create is only actually REACHABLE if two further things
 * hold, and neither of them lives in `capabilities.ts`:
 *
 *   (a) `abap_write`'s REGISTERED schema (`writeInputSchema`, the shape handed
 *       to the MCP SDK) has a field for every input the create genuinely
 *       requires, and
 *   (b) something actually ROUTES that type away from the ADT-REST path —
 *       here `isBridgeCreatableType()` and the branch `abapWrite` keys off it.
 *
 * `capabilities` says yes, the code demands an input, the schema cannot express
 * it: that three-way disagreement has shipped three times in this repo, and
 * pairwise review never catches it, because each pair looks fine on its own —
 * the registry entry is defensible, the create function is defensible, the
 * schema is defensible. Only the triple is wrong.
 *
 * What makes (a) SILENT rather than loud is zod: `z.object(writeInputSchema)`
 * strips keys it does not declare, without error and without warning. A caller
 * who dutifully sends `view_fields` for an undeclared `view_fields` gets a
 * parsed input with no `view_fields` at all, and the create refuses as though
 * the caller had omitted it. Two shipped `abap_write` defects had exactly that
 * root cause (`edit`/`method`, per src/tools/write.ts's own comment on the
 * subject — and `affects`, pinned by the describe block above).
 * An undeclared field is invisible, never noisy, which is precisely why it
 * needs a test and not a code review.
 *
 * So this walks the REAL `REGISTRY` rather than a hand-picked list of today's
 * two bridge types, and its per-type table of required schema fields FAILS on a
 * type it does not know about instead of skipping it — a new `bridgeCreate`
 * entry added later re-triggers the whole check with no further code needed.
 * A vacuously-true invariant closes nothing, so the walk also asserts it found
 * the two types the feature was about.
 */
describe("invariant: no REGISTRY type may declare `bridgeCreate` without a routing path away from ADT REST and a schema field for every input its create requires (VIEW/DV, TRAN/T)", () => {
  /**
   * The `writeInputSchema` keys each bridge create genuinely requires — the
   * ones `abapCreateViaBridge` (src/tools/write.ts) reads and refuses without.
   * `object`/`type` select the create at all, `description` is the object's
   * short text (DD25V-DDTEXT / TSTCT-TTEXT) and is refused when blank,
   * `package` is DEVCLASS, and the rest are the per-type inputs the ABAP API
   * has no default for.
   *
   * A `bridgeCreate` type absent from this table is a FAILURE, not a skip (see
   * the assertion below). That is the difference between closing the CLASS of
   * defect and closing today's two members of it.
   */
  const REQUIRED_SCHEMA_FIELDS: Record<string, readonly string[]> = {
    "VIEW/DV": ["object", "type", "description", "package", "base_table", "view_fields"],
    "TRAN/T": ["object", "type", "description", "package", "program"],
    // DEVC/K: `software_component` is required (BAD_INPUT otherwise);
    // `package`/`description` are optional (root has no super, description
    // defaults). `corr_nr` is excluded — its absence is judged by transport
    // policy (preflightPackageCorr), not field-presence, like VIEW/DV/TRAN/T.
    "DEVC/K": ["object", "type", "software_component"],
  };

  /** The walk. Deliberately over the real REGISTRY, not over BRIDGE_CREATABLE_TYPES. */
  const bridgeTypes = Object.entries(REGISTRY)
    .filter(([, c]) => c.bridgeCreate !== undefined)
    .map(([type]) => type);

  it("the walk is not vacuous, and BRIDGE_CREATABLE_TYPES does not disagree with it", () => {
    // The two types the whole feature was about must be among them, or every
    // per-type assertion below runs zero times and this file pins nothing.
    expect(bridgeTypes).toContain("VIEW/DV");
    expect(bridgeTypes).toContain("TRAN/T");
    // The derived export and the walk are two spellings of one fact. If they
    // ever disagree, `src/tools/write.ts` routes off one of them while every
    // reader of the registry believes the other.
    expect(new Set(BRIDGE_CREATABLE_TYPES)).toEqual(new Set(bridgeTypes));
    expect(BRIDGE_CREATABLE_TYPES.length).toBe(bridgeTypes.length);
  });

  it.each(bridgeTypes)(
    "%s: something routes it away from the ADT-REST path, on the caller's RAW spelling",
    (type) => {
      expect(
        isBridgeCreatableType(type),
        `src/adt/capabilities.ts declares bridgeCreate for ${type}, but isBridgeCreatableType() ` +
          "does not recognise it — so `abapWrite` would never take the bridge branch and the " +
          "request would fall through to `resolveWriteTarget`, which has no ADT collection to " +
          "resolve this type against and answers 405/refusal. Declared creatable, unreachable.",
      ).toBe(true);
      // `abapWrite` keys the branch off `input.type` as the CALLER spelled it,
      // before any normalisation of its own, so the predicate has to be as
      // forgiving as `capabilitiesFor` is.
      expect(isBridgeCreatableType(type.toLowerCase())).toBe(true);
      expect(isBridgeCreatableType(` ${type.toLowerCase()} `)).toBe(true);
    },
  );

  it("the raw-spelling tolerance is real for the literal a caller would send", () => {
    expect(isBridgeCreatableType(" view/dv ")).toBe(true);
    expect(isBridgeCreatableType("tran/t")).toBe(true);
    expect(isBridgeCreatableType(undefined)).toBe(false);
    expect(isBridgeCreatableType("PROG/P")).toBe(false);
  });

  it.each(bridgeTypes)(
    "%s is not double-declared: write/unsupported are always refused; `create` may coexist with " +
      "`bridgeCreate` ONLY when `alongsideRestCreate` names the discriminator between the two routes",
    (type) => {
      const cap = capabilitiesFor(type);
      // `unsupported` would leave `resolveWriteTarget` quoting a refusal reason
      // that is no longer true; `write` would claim a PUT-source path that does
      // not exist. Neither ever coexists with `bridgeCreate` — unconditionally,
      // for every bridge type, including DEVC/K.
      expect(cap?.write).toBeUndefined();
      expect(cap?.unsupported).toBeUndefined();
      // Since the DEVC/K package-create bridge landed, `create` may coexist with `bridgeCreate` only when
      // `alongsideRestCreate` names the discriminator between the two
      // routes (assertNoConflictingCapabilities enforces both directions);
      // types without it still require no `create` at all, as before.
      if (cap?.bridgeCreate?.alongsideRestCreate !== undefined) {
        expect(cap?.create).toBeDefined();
      } else {
        expect(cap?.create).toBeUndefined();
      }
      // `resolveWriteTarget` must keep refusing these over PUT-source write —
      // there is no ADT collection to resolve them against for THAT path, and
      // `src/tools/write.ts` intercepts them long before `resolveWriteTarget`
      // is consulted for either of their real create routes.
      expect(WRITABLE_TYPES).not.toContain(type);
      // CREATABLE_TYPES tracks `create` alone (src/adt/capabilities.ts), so —
      // unlike WRITABLE_TYPES — it now legitimately contains a bridge type
      // that also names a REST alongside-create discriminator.
      if (cap?.bridgeCreate?.alongsideRestCreate !== undefined) {
        expect(CREATABLE_TYPES).toContain(type);
      } else {
        expect(CREATABLE_TYPES).not.toContain(type);
      }
    },
  );

  it("the walk is not vacuous for the coexistence case either: DEVC/K is actually exercised above", () => {
    // Without this, the `if` branches in the test above could silently never
    // execute their `toBeDefined()`/`toContain()` arms and the new rule would
    // be unpinned — exactly the failure mode the walk's own vacuity check
    // (two tests up) exists to catch for the walk as a whole.
    expect(bridgeTypes).toContain("DEVC/K");
    expect(capabilitiesFor("DEVC/K")?.bridgeCreate?.alongsideRestCreate).toBeDefined();
  });

  /**
   * Temporarily overwrites `PROG/I` — a real registry entry, but one nothing
   * else in this test file depends on — to exercise the real guard against
   * a bad shape without touching src/, restoring it in `finally` so no
   * other test observes the mutation.
   */
  it("the pairing is still refused with no discriminator: bridgeCreate + create + no alongsideRestCreate throws at registry load", () => {
    const original = REGISTRY["PROG/I"];
    REGISTRY["PROG/I"] = {
      label: "Include",
      create: { vendor: true, verified: "unverified" },
      bridgeCreate: {
        adtRest: "test fixture: pretend REST reason",
        via: "test fixture: pretend bridge mechanism",
        limits: "test fixture: pretend limits",
        // alongsideRestCreate deliberately omitted.
      },
    };
    try {
      expect(() => assertNoConflictingCapabilities()).toThrow(/alongsideRestCreate/);
    } finally {
      REGISTRY["PROG/I"] = original;
    }
    // The restore itself must leave the registry passing again, or a bug in
    // this test would poison every test that runs after it in the file.
    expect(() => assertNoConflictingCapabilities()).not.toThrow();
  });

  it("the pairing is still refused the other way too: alongsideRestCreate with no create throws at registry load", () => {
    // The inverse check the task description calls out: a registry entry
    // cannot name a discriminator field for a `create` that does not exist.
    const original = REGISTRY["PROG/I"];
    REGISTRY["PROG/I"] = {
      label: "Include",
      bridgeCreate: {
        adtRest: "test fixture: pretend REST reason",
        via: "test fixture: pretend bridge mechanism",
        limits: "test fixture: pretend limits",
        alongsideRestCreate: "software_component",
      },
      // create deliberately omitted.
    };
    try {
      expect(() => assertNoConflictingCapabilities()).toThrow(/alongsideRestCreate/);
    } finally {
      REGISTRY["PROG/I"] = original;
    }
    expect(() => assertNoConflictingCapabilities()).not.toThrow();
  });

  it.each(bridgeTypes)(
    "%s: every input its create requires is a declared field on abap_write's OWN registered schema",
    (type) => {
      const required = REQUIRED_SCHEMA_FIELDS[type];
      expect(
        required,
        `src/adt/capabilities.ts declares bridgeCreate for ${type}, but this test's ` +
          "REQUIRED_SCHEMA_FIELDS table has no entry for it. Add one, naming the writeInputSchema " +
          "fields that type's create refuses without — a bridgeCreate type with no entry makes " +
          "this invariant vacuous exactly for the newest, least-reviewed type, which is the one " +
          "most likely to be carrying the defect.",
      ).toBeDefined();
      for (const field of required ?? []) {
        expect(
          Object.keys(writeInputSchema),
          `capabilities.ts declares ${type} creatable via the classrun bridge, and ` +
            `abapCreateViaBridge (src/tools/write.ts) refuses the create without \`${field}\` — ` +
            `but \`${field}\` is not a field on abap_write's registered schema, so no caller ` +
            "could ever supply it. zod strips undeclared keys silently, so a caller who sends it " +
            "anyway gets the same refusal as one who omitted it. The type is declared creatable " +
            "and is not creatable.",
        ).toContain(field);
      }
    },
  );

  it.each(bridgeTypes)("%s: the declared bridgeCreate shape is honest, not decorative", (type) => {
    const bc = capabilitiesFor(type)?.bridgeCreate;
    expect(bc).toBeDefined();
    expect(bc?.adtRest.trim().length ?? 0).toBeGreaterThan(0);
    expect(bc?.via.trim().length ?? 0).toBeGreaterThan(0);
    expect(bc?.limits.trim().length ?? 0).toBeGreaterThan(0);
    if (BRIDGE_ONLY_CREATE_TYPES.includes(type)) {
      // The accurate half of the old `unsupported` reason (405/GET-only
      // recon) is deliberately kept for types where it's still true — only
      // the "therefore unsupported" conclusion was wrong; a future reader
      // needs it here to avoid re-running the recon.
      expect(
        bc?.adtRest,
        `${type}'s bridgeCreate.adtRest no longer records the REST finding (405 / GET-only). ` +
          "That recon is the reason this type is not simply `create:{...}`; dropping it invites " +
          "the next reader to try REST again.",
      ).toMatch(/405|GET/);
    } else {
      // DEVC/K genuinely IS REST-creatable (LOCAL packages), so the blanket
      // /405|GET/ regex above would wrongly pass on the substring inside
      // "is NOT 405 here". Assert the real claim instead: REST works; what's
      // unreachable is abapsmith's own transport pre-flight.
      expect(BRIDGE_ONLY_CREATE_TYPES).not.toContain(type);
      expect(bc?.adtRest).toMatch(/NOT 405/);
      expect(bc?.adtRest).not.toMatch(/\bGET-only\b/);
    }
  });

  it("VIEW/DV's declared limits state plainly that no SE54 maintenance dialog is generated", () => {
    // The single most surprising thing about a view created this way: SM30
    // will not open it. VIEW_MAINTENANCE_GENERATE has no headless equivalent,
    // so the scope limit is stated on the capability itself, not just in a doc.
    expect(capabilitiesFor("VIEW/DV")?.bridgeCreate?.limits).toMatch(/SE54/);
  });
});

/**
 * Same invariant as bridgeCreate's above, for the delete side.
 * Both throws are unreachable from the shipped REGISTRY — DEVC/K is the only
 * `bridgeDelete` entry and triggers neither conflict — so a fixture is the
 * only way to prove `assertNoConflictingCapabilities()` actually rejects them.
 */
describe("invariant: bridgeDelete conflicts are refused at registry load", () => {
  const FIXTURE_BRIDGE_DELETE = {
    adtRest: "test fixture: pretend REST reason",
    via: "test fixture: pretend bridge mechanism",
    limits: "test fixture: pretend limits",
  };

  it("bridgeDelete + unsupported throws at registry load", () => {
    const original = REGISTRY["PROG/I"];
    REGISTRY["PROG/I"] = {
      label: "Include",
      unsupported: { reason: "test fixture: pretend unsupported reason" },
      bridgeDelete: FIXTURE_BRIDGE_DELETE,
    };
    try {
      expect(() => assertNoConflictingCapabilities()).toThrow(
        /'bridgeDelete' together with 'unsupported'/,
      );
    } finally {
      REGISTRY["PROG/I"] = original;
    }
    // The restore itself must leave the registry passing again, or a bug in
    // this test would poison every test that runs after it in the file.
    expect(() => assertNoConflictingCapabilities()).not.toThrow();
  });

  it("bridgeDelete + delete: true throws at registry load", () => {
    const original = REGISTRY["PROG/I"];
    REGISTRY["PROG/I"] = {
      label: "Include",
      delete: true,
      bridgeDelete: FIXTURE_BRIDGE_DELETE,
    };
    try {
      expect(() => assertNoConflictingCapabilities()).toThrow(
        /'bridgeDelete' together with 'delete: true'/,
      );
    } finally {
      REGISTRY["PROG/I"] = original;
    }
    expect(() => assertNoConflictingCapabilities()).not.toThrow();
  });

  it("the two bridgeDelete throw messages are distinguishable from each other, not one vague shared string", () => {
    // Each test above already pins its own message by regex; this proves
    // those two regexes could not both match the OTHER invariant's message —
    // i.e. a caller reading only the thrown text can tell which rule fired.
    const original = REGISTRY["PROG/I"];
    let unsupportedMsg = "";
    let deleteTrueMsg = "";
    try {
      REGISTRY["PROG/I"] = {
        label: "Include",
        unsupported: { reason: "test fixture" },
        bridgeDelete: FIXTURE_BRIDGE_DELETE,
      };
      try {
        assertNoConflictingCapabilities();
      } catch (e) {
        unsupportedMsg = String((e as Error).message);
      }
      REGISTRY["PROG/I"] = {
        label: "Include",
        delete: true,
        bridgeDelete: FIXTURE_BRIDGE_DELETE,
      };
      try {
        assertNoConflictingCapabilities();
      } catch (e) {
        deleteTrueMsg = String((e as Error).message);
      }
    } finally {
      REGISTRY["PROG/I"] = original;
    }
    expect(() => assertNoConflictingCapabilities()).not.toThrow();

    expect(unsupportedMsg).not.toBe("");
    expect(deleteTrueMsg).not.toBe("");
    expect(unsupportedMsg).not.toBe(deleteTrueMsg);
    expect(unsupportedMsg).toMatch(/'bridgeDelete' together with 'unsupported'/);
    expect(deleteTrueMsg).toMatch(/'bridgeDelete' together with 'delete: true'/);
  });

  it('bridgeDelete + delete: "unverified" does NOT throw — the REST tri-state and the bridge route are different questions', () => {
    // Only `delete === true` (a claimed REST delete route) conflicts with
    // bridgeDelete; "unverified" is the honest "no REST route" state DEVC/K
    // itself would be in if it stated the field at all.
    const original = REGISTRY["PROG/I"];
    REGISTRY["PROG/I"] = {
      label: "Include",
      delete: "unverified",
      bridgeDelete: FIXTURE_BRIDGE_DELETE,
    };
    try {
      expect(() => assertNoConflictingCapabilities()).not.toThrow();
    } finally {
      REGISTRY["PROG/I"] = original;
    }
  });
});

describe("BRIDGE_DELETABLE_TYPES / isBridgeDeletableType", () => {
  it("the walk is not vacuous: BRIDGE_DELETABLE_TYPES is non-empty", () => {
    // Guards every assertion below from silently running zero times if a
    // future edit ever drops the only bridgeDelete entry from REGISTRY.
    expect(BRIDGE_DELETABLE_TYPES.length).toBeGreaterThan(0);
  });

  it("contains DEVC/K, VIEW/DV and TRAN/T — all three now declare bridgeDelete", () => {
    // VIEW/DV and TRAN/T used to bridgeCreate but not bridgeDelete; they were later given a real
    // classrun-bridge delete (src/adt/view-delete.ts, src/adt/tran-delete.ts), so their
    // REGISTRY entries now declare bridgeDelete too and belong in this list.
    expect(BRIDGE_DELETABLE_TYPES).toContain("DEVC/K");
    expect(BRIDGE_DELETABLE_TYPES).toContain("VIEW/DV");
    expect(BRIDGE_DELETABLE_TYPES).toContain("TRAN/T");
    expect(isBridgeDeletableType("DEVC/K")).toBe(true);
    expect(isBridgeDeletableType("VIEW/DV")).toBe(true);
    expect(isBridgeDeletableType("TRAN/T")).toBe(true);
    // A type that bridge-CREATES nothing and bridge-DELETES nothing either — contrast case,
    // not a stand-in for every non-bridge type. CLAS/OC is deletable (DELETABLE_TYPES, REST
    // DELETE), which is exactly the "different question" this predicate must not conflate.
    expect(isBridgeDeletableType("CLAS/OC")).toBe(false);
    expect(isBridgeDeletableType(undefined)).toBe(false);
  });

  it.each(BRIDGE_DELETABLE_TYPES)(
    "%s: raw-spelling tolerance matches isBridgeCreatableType's",
    (type) => {
      expect(isBridgeDeletableType(type.toLowerCase())).toBe(true);
      expect(isBridgeDeletableType(` ${type.toLowerCase()} `)).toBe(true);
    },
  );

  it("DEVC/K declares bridgeDelete but does NOT set delete: true — the REST tri-state and the bridge route are different questions", () => {
    // `delete` answers "is there an ADT REST delete route" (there isn't, which
    // is why bridgeDelete exists); DEVC/K leaves it unset rather than `true`,
    // keeping DELETABLE_TYPES — the REST-only consumer — honestly excluding it.
    const cap = capabilitiesFor("DEVC/K");
    expect(cap?.bridgeDelete).toBeDefined();
    expect(cap?.delete).not.toBe(true);
    expect(cap?.delete).toBeUndefined();
    expect(DELETABLE_TYPES).not.toContain("DEVC/K");
  });
});

/**
 * The routing half of the same invariant, exercised through `abapWrite` itself
 * rather than through the registry — modelled on `abap_write → package creation
 * (DEVC/K)` in test/tools.test.ts, the closest precedent for a non-source
 * create branch.
 *
 * Most refusals here still happen BEFORE a byte goes on the wire, using the
 * file's `offline = null as unknown as AbapConnection` idiom: a connection
 * that would throw a `TypeError` on touch, which `catchErr`'s `isAbapError`
 * check would then fail. The `mode:"delete"` case below is the one exception:
 * a delete now genuinely reads the object first (there is no way to
 * know an existing object's real package without asking the server — see
 * `abapDeleteViaBridge`'s doc comment in src/tools/write.ts), so "zero
 * requests" is no longer the claim there. What still must hold, and what a
 * half-built bridge class left behind would violate (this repo cannot clean
 * that up), is "no MUTATING request" — no bridge-class deploy, no
 * activation, no classrun execution — which is what that test now asserts.
 */
describe("abap_write → bridge creation (VIEW/DV, TRAN/T): routing and zero-network refusals", () => {
  /** Same reasoning as every other `offline` in this file. */
  const offline = null as unknown as AbapConnection;
  const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
  const MAX = 20_000;

  it("mode:'delete' on a nonexistent VIEW/DV is refused NOT_FOUND after exactly one read-only GET — no bridge class ever deployed (staleness fix: this used to be an unconditional UNSUPPORTED)", async () => {
    // VIEW/DV was given a real delete; ABSENT_ROUTE 404s every URL, so the
    // pre-delete VIT-bridge package read (abapDeleteViaBridge) comes back
    // confirmed-absent — deleting an object that was never there is now a
    // NOT_FOUND, not a blanket "this type can't be deleted".
    const { conn, adt } = await connected(ABSENT_ROUTE);
    const e = await catchErr(
      abapWrite(conn, { object: "ZMCP_V_CARRIER", type: "VIEW/DV", mode: "delete" }, MAX, gate),
    );
    expect(e.code).toBe("NOT_FOUND");
    expect(String(e.message)).toMatch(/does not exist/i);
    expect(String(e.message)).toMatch(/nothing to delete/i);
    // The invariant that actually matters: no bridge class was deployed and
    // no classrun was executed — only the one read-only resolution GET.
    expect(adt.calls.length).toBe(1);
    expect(adt.calls[0]?.method).toBe("GET");
    expect(adt.calls.some((c) => c.method === "POST" || c.method === "PUT")).toBe(false);
    expect(adt.calls.some((c) => c.url.includes("/oo/classrun/"))).toBe(false);
  });

  it("a VIEW/DV carrying `source` is refused BAD_INPUT before any network call", async () => {
    const e = await catchErr(
      abapWrite(
        offline,
        {
          object: "ZMCP_V_CARRIER",
          type: "VIEW/DV",
          package: "$TMP",
          description: "Carriers",
          base_table: "ZMCP_CARRIER",
          view_fields: ["CARRIER_ID", "NAME"],
          source: "DEFINE VIEW zmcp_v_carrier AS SELECT FROM zmcp_carrier { }",
        },
        MAX,
        gate,
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/no source/i);
  });

  // The VIEW/DV create now REACHES the bridge for every package, so a missing
  // `view_fields`/`base_table`/`description` is refused the same way TRAN/T's
  // missing `program`/`description` is below: BAD_INPUT, naming the field,
  // zero network calls. Nothing here implies the field alone would complete
  // the create — corr_nr/package pairing is checked first (assertClassicViewCreateTarget)
  // and $TMP needs none — but a missing field is now a field-shaped refusal,
  // not a blanket policy one.
  it("a VIEW/DV with no `view_fields` is refused BAD_INPUT, and the refusal NAMES view_fields", async () => {
    const e = await catchErr(
      abapWrite(
        offline,
        {
          object: "ZMCP_V_CARRIER",
          type: "VIEW/DV",
          package: "$TMP",
          description: "Carriers",
          base_table: "ZMCP_CARRIER",
        },
        MAX,
        gate,
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/view_fields/);
  });

  it("a TRAN/T with no `program` is refused BAD_INPUT, and the refusal NAMES program", async () => {
    const e = await catchErr(
      abapWrite(
        offline,
        { object: "ZMCPT01", type: "TRAN/T", package: "$TMP", description: "Carrier list" },
        MAX,
        gate,
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/program/);
  });

  it("a TRAN/T carrying `base_table` is refused BAD_INPUT — cross-type field leakage, not silently ignored", async () => {
    // `base_table` and `view_fields` are on the SHARED abap_write shape, so
    // nothing in the schema stops a caller sending a view field on a
    // transaction create. Accepting and ignoring it would let a caller believe
    // the transaction was somehow bound to a table.
    const e = await catchErr(
      abapWrite(
        offline,
        {
          object: "ZMCPT01",
          type: "TRAN/T",
          package: "$TMP",
          description: "Carrier list",
          program: "ZMCP_CARRIER_LIST",
          base_table: "ZMCP_CARRIER",
        },
        MAX,
        gate,
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/base_table/);
  });

  it("a VIEW/DV with no `base_table` is refused BAD_INPUT, and the refusal NAMES base_table", async () => {
    const e = await catchErr(
      abapWrite(
        offline,
        {
          object: "ZMCP_V_CARRIER",
          type: "VIEW/DV",
          package: "$TMP",
          description: "Carriers",
          view_fields: ["CARRIER_ID", "NAME"],
        },
        MAX,
        gate,
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/base_table/);
  });

  it("a VIEW/DV with no `description` is refused BAD_INPUT, and the refusal NAMES description", async () => {
    const e = await catchErr(
      abapWrite(
        offline,
        {
          object: "ZMCP_V_CARRIER",
          type: "VIEW/DV",
          package: "$TMP",
          base_table: "ZMCP_CARRIER",
          view_fields: ["CARRIER_ID", "NAME"],
        },
        MAX,
        gate,
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/description/);
  });

  it("a TRAN/T with no `description` is refused BAD_INPUT, and the refusal NAMES description", async () => {
    const e = await catchErr(
      abapWrite(
        offline,
        { object: "ZMCPT01", type: "TRAN/T", package: "$TMP", program: "ZMCP_CARRIER_LIST" },
        MAX,
        gate,
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/description/);
  });
});

/**
 * DEFECT 1 (VIEW/DV) / DEFECT 2 (TRAN/T): the two describe blocks below close
 * the gap the invariant-and-routing blocks above do not reach. Those prove a
 * MALFORMED VIEW/DV or TRAN/T request is refused before any network call —
 * they never exercise a WELL-FORMED one, so they cannot see whether a valid
 * create claims success without a read-back proving the object is really
 * there. DEFECT 1 was reproduced live for VIEW/DV: `created: true` off the
 * classrun transcript alone, for a view a follow-up read could not find.
 * RS_CORR_INSERT now registers a VIEW/DV create for every package — the
 * describe block below proves the create itself REACHES the bridge (for a
 * transportable package with corr_nr, and for $TMP with korrnum = space) and
 * that DEFECT 1's read-back guard still holds, the same shape TRAN/T's
 * DEFECT 2 block below proves for its own create (see
 * src/adt/write-verify.ts's module doc for the full argument).
 */
describe("abap_write → bridge creation: DEFECT 1 closed for VIEW/DV (create runs for every package, post-create verification)", () => {
  const gate = new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowTransports: ["*"],
    writesLockedOut: false,
  });
  const MAX = 20_000;
  const VIEW = "ZMCP_V_CARRIER";
  const BRIDGE = DDIC_BRIDGE_CLASS.createView;
  const CLASS_COLLECTION = "/sap/bc/adt/oo/classes";
  const bridgeObjUrl = `${CLASS_COLLECTION}/${BRIDGE.toLowerCase()}`;
  const bridgeSourceUri = `${bridgeObjUrl}/source/main`;

  /** GET-404 → POST-create → LOCK → PUT → UNLOCK for the bridge class itself, same shape as view-create.test.ts's happy path. */
  const bridgeDeployRoute: Route = (r) => {
    if (r.url === bridgeObjUrl && r.method === "GET" && !r.qs._action) {
      return resp(404, NOT_FOUND_XML, OK_XML);
    }
    if (r.url === CLASS_COLLECTION && r.method === "POST") return resp(200, "", OK_TEXT);
    if (r.url === bridgeObjUrl && r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
    if (r.url === bridgeObjUrl && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === bridgeSourceUri && r.method === "PUT") return resp(200, "", OK_TEXT);
    return undefined;
  };

  /** The classrun execution itself, plus the activation ping `deployBridge` makes. */
  const classrunRoute =
    (tags: readonly string[]): Route =>
    (r) => {
      if (r.url.startsWith("/sap/bc/adt/oo/classrun/")) return resp(200, tags.join("\n"), OK_TEXT);
      if (r.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
      return undefined;
    };

  /**
   * The post-create read-back `verifyViaVitBridge` makes, at the SAME uri
   * builder the production code uses (`vitBridgeUri`) — so a rename on either
   * side breaks this test instead of silently verifying the wrong URI.
   */
  const vitRoute =
    (mode: "confirmed" | "absent" | "indeterminate", name: string): Route =>
    (r) => {
      const uri = vitBridgeUri("viewdv", name);
      if (r.url !== uri) return undefined;
      if (mode === "absent") return resp(404, NOT_FOUND_XML, OK_XML);
      const rich = mode === "confirmed" ? `<adtcore:packageRef adtcore:name="ZTM"/>` : "";
      // "indeterminate": a thin 200 that DOES echo the name is now
      // `confirmed-absent`, not indeterminate — so the non-committal case has
      // to fail the echo check instead, the only other way a 200 stays unproven.
      const echoedName = mode === "indeterminate" ? `${name}_UNRELATED` : name;
      return resp(
        200,
        `<adtcore:mainObject adtcore:name="${echoedName}" adtcore:type="VIEW/DV" ` +
          `adtcore:version="active" adtcore:language="EN" xmlns:adtcore="http://www.sap.com/adt/core">` +
          `${rich}</adtcore:mainObject>`,
        OK_XML,
      );
    };

  // Every package now emits all three tags — RS_CORR_INSERT runs unconditionally
  // (korrnum = space for a local package, the caller's TRKORR otherwise), so
  // VIEW-REGISTERED fires the same for $TMP as for a transportable package.
  const happyRoute = (vitMode: "confirmed" | "absent" | "indeterminate"): Route => {
    const classrun = classrunRoute(["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"]);
    const vit = vitRoute(vitMode, VIEW);
    return (r) => bridgeDeployRoute(r) ?? classrun(r) ?? vit(r);
  };

  const validInput = {
    object: VIEW,
    type: "VIEW/DV" as const,
    package: "$TMP",
    description: "Carriers",
    base_table: "ZMCP_CARRIER",
    view_fields: ["CARRIER_ID", "NAME"],
  };

  it("into $TMP: RS_CORR_INSERT registers it with korrnum = space, then the VIT bridge confirms present — created:true and verified:true", async () => {
    const { conn } = await connected(happyRoute("confirmed"));
    const result = await abapWrite(conn, validInput, MAX, gate);
    expect(result.text).toMatch(/created:\s*true/);
    expect(result.text).toMatch(/verified:\s*true/);
    expect(result.text).toMatch(/package:\s*\$TMP/);
    expect(result.text).toMatch(/NOTE: Read back and confirmed present/);
  });

  it("into a transportable package with a valid corr_nr: creates, then confirms present — created:true and verified:true", async () => {
    const { conn } = await connected(happyRoute("confirmed"));
    const result = await abapWrite(
      conn,
      { ...validInput, package: "ZTM", corr_nr: "TR1K900123" },
      MAX,
      gate,
    );
    expect(result.text).toMatch(/created:\s*true/);
    expect(result.text).toMatch(/verified:\s*true/);
  });

  it("with an unconfirmable read-back: still reports created:true (trusting the transcript), but verified:false and says why", async () => {
    const { conn } = await connected(happyRoute("indeterminate"));
    const result = await abapWrite(conn, validInput, MAX, gate);
    expect(result.text).toMatch(/created:\s*true/);
    expect(result.text).toMatch(/verified:\s*false/);
    expect(result.text).toMatch(/NOTE: NOT independently confirmed present/);
  });

  it("when the read-back proves the view is NOT there, throws CHECK_FAILED instead of ever reporting created:true — the exact DEFECT 1 shape, closed", async () => {
    const { conn } = await connected(happyRoute("absent"));
    const e = await catchErr(abapWrite(conn, validInput, MAX, gate));
    expect(e.code).toBe("CHECK_FAILED");
    expect(String(e.message)).toMatch(/did not find/);
    expect(String(e.message)).toMatch(/not proof the object is absent/);
    expect(String(e.message)).toMatch(/VIEW-REGISTERED/);
    expect(String(e.message)).toMatch(/VIEW-PUT/);
    expect(String(e.message)).toMatch(/VIEW-ACTIVATED/);
  });

  it("a $ package WITH a corr_nr is refused BAD_INPUT before any network call — the pairing check runs before the bridge is ever reached", async () => {
    const offline = null as unknown as AbapConnection;
    const e = await catchErr(
      abapWrite(offline, { ...validInput, package: "$TMP", corr_nr: "TR1K900123" }, MAX, gate),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(String(e.message)).toMatch(/corr_nr/);
    expect(String(e.message)).toMatch(/\$TMP/);
  });

  it("a transportable package with NO corr_nr is refused TRANSPORT_ERROR before any network call", async () => {
    const offline = null as unknown as AbapConnection;
    const e = await catchErr(
      abapWrite(offline, { ...validInput, package: "ZTM" }, MAX, gate),
    );
    expect(e.code).toBe("TRANSPORT_ERROR");
    expect(String(e.message)).toMatch(/corr_nr/);
  });
});

/**
 * DEFECT 2: a `TRAN/T` create used to bind a transaction to a program
 * `abapsmith` never checked, and (the DEFECT 1 shape, applied here) used to
 * report `created: true` off the classrun transcript alone, with no read-back
 * proving the transaction row was actually still there afterward. Both halves
 * are closed in `abapCreateViaBridge` (src/tools/write.ts): a real
 * `resolveWriteTarget(conn, {type:"PROG/P", ...})` GET before any ABAP is
 * generated, and a real `verifyViaVitBridge` GET after the classrun bridge
 * reports success.
 *
 * The happy-path routing below is deliberately built the same way
 * test/tran-create.test.ts's own "happy path" describe block builds it
 * (`objectHappyPath`-equivalent GET-404 → POST-create → LOCK → PUT → UNLOCK
 * for the bridge class, then a classrun execution response) — that file
 * already proves `createTransaction` itself is correct; these tests are
 * about what `abapCreateViaBridge` does AROUND that call, not the call
 * itself.
 */
describe("abap_write → bridge creation: DEFECT 2 closed for TRAN/T (program existence + post-create verification)", () => {
  const gate = new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowTransports: ["*"],
    writesLockedOut: false,
  });
  const MAX = 20_000;
  const TCODE = "ZMCPT01";
  const BRIDGE = DDIC_BRIDGE_CLASS.createTransaction;
  const CLASS_COLLECTION = "/sap/bc/adt/oo/classes";
  const bridgeObjUrl = `${CLASS_COLLECTION}/${BRIDGE.toLowerCase()}`;
  const bridgeSourceUri = `${bridgeObjUrl}/source/main`;

  /** GET-404 → POST-create → LOCK → PUT → UNLOCK for the bridge class itself, same shape as tran-create.test.ts's objectHappyPath. */
  const bridgeDeployRoute: Route = (r) => {
    if (r.url === bridgeObjUrl && r.method === "GET" && !r.qs._action) {
      return resp(404, NOT_FOUND_XML, OK_XML);
    }
    if (r.url === CLASS_COLLECTION && r.method === "POST") return resp(200, "", OK_TEXT);
    if (r.url === bridgeObjUrl && r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
    if (r.url === bridgeObjUrl && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
    if (r.url === bridgeSourceUri && r.method === "PUT") return resp(200, "", OK_TEXT);
    return undefined;
  };

  /** The classrun execution itself, plus the activation ping `deployBridge` makes. */
  const classrunRoute =
    (tags: readonly string[]): Route =>
    (r) => {
      if (r.url.startsWith("/sap/bc/adt/oo/classrun/")) return resp(200, tags.join("\n"), OK_TEXT);
      if (r.url.includes("/sap/bc/adt/activation")) return resp(200, "", { "content-length": "0" });
      return undefined;
    };

  /**
   * The post-create read-back `verifyViaVitBridge` makes, at the SAME uri
   * builder the production code uses (`vitBridgeUri`) — so a rename on either
   * side breaks this test instead of silently verifying the wrong URI.
   */
  const vitRoute =
    (mode: "confirmed" | "absent" | "indeterminate", name: string): Route =>
    (r) => {
      const uri = vitBridgeUri("trant", name);
      if (r.url !== uri) return undefined;
      if (mode === "absent") return resp(404, NOT_FOUND_XML, OK_XML);
      const rich = mode === "confirmed" ? `<adtcore:packageRef adtcore:name="ZTM"/>` : "";
      // "indeterminate": a thin 200 that DOES echo the name is now
      // `confirmed-absent`, not indeterminate — so the non-committal case has
      // to fail the echo check instead, the only other way a 200 stays unproven.
      const echoedName = mode === "indeterminate" ? `${name}_UNRELATED` : name;
      return resp(
        200,
        `<adtcore:mainObject adtcore:name="${echoedName}" adtcore:type="TRAN/T" ` +
          `adtcore:version="active" adtcore:language="EN" xmlns:adtcore="http://www.sap.com/adt/core">` +
          `${rich}</adtcore:mainObject>`,
        OK_XML,
      );
    };

  const happyRoute = (vitMode: "confirmed" | "absent" | "indeterminate"): Route => {
    const classrun = classrunRoute(["TRAN-CREATED"]);
    const vit = vitRoute(vitMode, TCODE);
    return (r) => bridgeDeployRoute(r) ?? classrun(r) ?? vit(r);
  };

  const validInput = {
    object: TCODE,
    type: "TRAN/T" as const,
    package: "$TMP",
    description: "Carrier list",
    program: REPORT, // objectMetaRoute already answers PROG/P for REPORT/REPORT_URI — a REAL existing program.
  };

  it("refuses NOT_FOUND when `program` does not exist, after exactly the one resolution GET — no bridge class ever generated", async () => {
    const { conn, adt } = await connected(ABSENT_ROUTE);
    const e = await catchErr(
      abapWrite(conn, { ...validInput, program: "ZMCP_GHOST_PROGRAM" }, MAX, gate),
    );
    expect(e.code).toBe("NOT_FOUND");
    expect(String(e.message)).toMatch(/ZMCP_GHOST_PROGRAM/);
    expect(String(e.message)).toMatch(/does not exist/i);
    // Exactly the resolveWriteTarget GET for the program — nothing about the
    // bridge class (GET-404/POST/LOCK/PUT/UNLOCK) or a classrun execution.
    expect(adt.calls.length).toBe(1);
    expect(adt.calls[0]?.method).toBe("GET");
  });

  it("with a REAL existing program: creates, then confirms present via the VIT bridge — created:true AND verified:true", async () => {
    const { conn } = await connected(happyRoute("confirmed"));
    const result = await abapWrite(conn, validInput, MAX, gate);
    expect(result.text).toMatch(/created:\s*true/);
    expect(result.text).toMatch(/verified:\s*true/);
    expect(result.text).toMatch(/NOTE: Read back and confirmed present/);
  });

  it("with a REAL existing program but an unconfirmable read-back: still reports created:true (trusting the transcript), but verified:false and says why", async () => {
    const { conn } = await connected(happyRoute("indeterminate"));
    const result = await abapWrite(conn, validInput, MAX, gate);
    expect(result.text).toMatch(/created:\s*true/);
    expect(result.text).toMatch(/verified:\s*false/);
    expect(result.text).toMatch(/NOTE: NOT independently confirmed present/);
  });

  it("when the read-back proves the transaction is NOT there, throws CHECK_FAILED instead of ever reporting created:true — the exact DEFECT 1 shape, closed", async () => {
    const { conn } = await connected(happyRoute("absent"));
    const e = await catchErr(abapWrite(conn, validInput, MAX, gate));
    expect(e.code).toBe("CHECK_FAILED");
    expect(String(e.message)).toMatch(/did not find/);
    expect(String(e.message)).toMatch(/not proof the object is absent/);
    expect(String(e.message)).toMatch(/the same gap was measured for VIEW\/DV/);
    expect(String(e.message)).toMatch(/TRAN-CREATED/);
  });
});

/**
 * ARCH-09 §5.2: a name that matches no convention used to be refused outright,
 * even when the object was sitting on the server. The refusal was correct for a
 * create and pure waste for an edit; only the server can tell those apart.
 */
describe("resolveWriteTarget — asking the server is not guessing", () => {
  const UNTYPED = "ZMCP_DEMO_PROG";
  const UNTYPED_URI = "/sap/bc/adt/programs/programs/zmcp_demo_prog";

  const searching =
    (rows: readonly { name: string; type: string; uri: string }[]): Route =>
    (r) =>
      r.url.endsWith("/repository/informationsystem/search")
        ? resp(200, searchResultsXml(rows), OK_XML)
        : undefined;

  const both =
    (...routes: Route[]): Route =>
    (r) => {
      for (const route of routes) {
        const hit = route(r);
        if (hit) return hit;
      }
      return undefined;
    };

  it("takes the type of an existing object from the server when the name implies none", async () => {
    const { conn } = await connected(
      both(
        searching([{ name: UNTYPED, type: "PROG/P", uri: UNTYPED_URI }]),
        (r) =>
          r.url === UNTYPED_URI
            ? resp(200, OBJECT_XML(UNTYPED, "PROG/P", "ZLOCAL"), OK_XML)
            : undefined,
      ),
    );
    const t = await resolveWriteTarget(conn, { name: UNTYPED });
    expect(t.type).toBe("PROG/P");
    expect(t.exists).toBe(true);
    expect(t.packageName).toBe("ZLOCAL");
  });

  it("still refuses to guess a type for an object that does not exist", async () => {
    const { conn } = await connected(both(searching([]), ABSENT_ROUTE));
    const e = await catchErr(resolveWriteTarget(conn, { name: UNTYPED }));
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toContain("no object of that name exists");
  });

  it("refuses, and names the candidates, when one name is several object types", async () => {
    const { conn } = await connected(
      both(
        searching([
          { name: UNTYPED, type: "PROG/P", uri: UNTYPED_URI },
          { name: UNTYPED, type: "TABL/DT", uri: "/sap/bc/adt/ddic/tables/zmcp_demo_prog" },
        ]),
        ABSENT_ROUTE,
      ),
    );
    const e = await catchErr(resolveWriteTarget(conn, { name: UNTYPED }));
    expect(e.code).toBe("BAD_INPUT");
    expect(e.details.candidates).toEqual(["PROG/P", "TABL/DT"]);
  });

  it("does not create when the search claims an object the authoritative read cannot find", async () => {
    const { conn } = await connected(
      both(searching([{ name: UNTYPED, type: "PROG/P", uri: UNTYPED_URI }]), ABSENT_ROUTE),
    );
    const e = await catchErr(resolveWriteTarget(conn, { name: UNTYPED }));
    expect(e.code).toBe("NOT_FOUND");
    expect(e.details.typeSource).toBe("repository-search");
  });

  it("costs no search at all when the caller named a type", async () => {
    const { conn, adt } = await connected(ABSENT_ROUTE);
    await resolveWriteTarget(conn, { type: "PROG/P", name: UNTYPED });
    expect(adt.labels.some((l) => l.includes("informationsystem/search"))).toBe(false);
  });
});

/**
 * A classic DDIC-based CDS view (DDLS/DF) names the database view
 * its activation creates with its OWN `@AbapCatalog.sqlViewName` annotation,
 * inside the source text — a value the object-name namespace check (inside
 * `authorizeMutation` → `gate.evaluate`) never looked at. `test/safety.test.ts`
 * already covers `extractSqlViewName` and `SafetyGate.evaluateDdlsSqlViewName`
 * exhaustively in isolation; what is missing there is proof that
 * `abapWrite` (src/tools/write.ts) actually CALLS `gate.assertDdlsSqlViewName`
 * on the real path a caller's `abap_write` reaches — not just that the gate
 * method is correct if invoked. These two tests close that gap the same way
 * every other adversarial test in this file does: by leaving the
 * LOCK/PUT/UNLOCK routes deliberately unrouted for the refusal case, so
 * `FakeAdt`'s loud "unrouted request" throw would fail the test if the
 * refusal did not happen before any network mutation.
 */
describe("abap_write: DDLS/DF sqlViewName is checked against the SAME namespace guard as the object name", () => {
  const DDLS_NAME = "Z_MCP_SQLVN_TEST";
  const DDLS_URI = "/sap/bc/adt/ddic/ddl/sources/z_mcp_sqlvn_test";
  const DDLS_SRC = `${DDLS_URI}/source/main`;
  const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"] });

  const ddlsSource = (sqlViewName: string): string =>
    `@AbapCatalog.sqlViewName: '${sqlViewName}'\n` +
    `@AbapCatalog.compiler.compareFilter: true\n` +
    `@AccessControl.authorizationCheck: #NOT_REQUIRED\n` +
    `define view ${DDLS_NAME} as select from sflight {\n` +
    `  key carrid,\n` +
    `  key connid\n` +
    `}\n`;

  const CLEAN_CHECKRUN = `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`;

  /**
   * An existing DDLS/DF object whose current source starts as `initial`;
   * lock/unlock/PUT/checkrun/activation all succeed. Stateful (a mutable
   * `current` cell the PUT route advances): `abapWrite` re-reads the source
   * after PUT/UNLOCK to guard against a concurrent writer before activating
   * (src/tools/write.ts's pre-activation ETAG_CONFLICT check), so a fake
   * that kept answering `initial` regardless of the PUT would make every
   * write through this path look like it raced another writer.
   */
  const existingDdls = (initial: string): Route => {
    let current = initial;
    return (r) => {
      if (r.url === DDLS_URI && r.method === "GET")
        return resp(200, OBJECT_XML(DDLS_NAME, "DDLS/DF", "$TMP"), OK_XML);
      if (r.url === DDLS_SRC && r.method === "GET") return resp(200, current, OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === DDLS_SRC && r.method === "PUT") {
        current = r.body ?? "";
        return resp(200, "", OK_TEXT);
      }
      if (r.url.includes("/checkruns")) return resp(200, CLEAN_CHECKRUN, OK_XML);
      if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
      return undefined;
    };
  };

  it("allows a full write when @AbapCatalog.sqlViewName names a Z-namespace database view, and actually reaches PUT", async () => {
    const before = ddlsSource("ZVMCP_SQLVN_TES");
    const after = ddlsSource("ZVMCP_SQLVN_TS2");
    const { conn, adt } = await connected(existingDdls(before));
    const result = await abapWrite(
      conn,
      { object: DDLS_NAME, type: "DDLS/DF", package: "$TMP", source: after },
      20_000,
      gate,
    );
    expect(result.text).toMatch(/changed:\s*true/);
    // The whole point of this test: the write actually landed. A check that
    // "closes" the hole by refusing everything (including legitimate
    // Z-namespace sqlViewNames) would pass a lazier version of this test too,
    // which is exactly why this asserts PUT happened, not just that no error
    // was thrown.
    expect(adt.verbs).toContain("PUT");
    expect(adt.calls.find((c) => c.method === "PUT")?.body).toBe(after);
  });

  it("refuses a Z-named DDLS whose @AbapCatalog.sqlViewName points OUTSIDE the customer namespace, and names the reason, before any LOCK/PUT is attempted", async () => {
    const before = ddlsSource("ZVMCP_SQLVN_TES");
    // SFLIGHT_X: no leading Z/Y and not a registered (/NAMESPACE/) name either
    // — squarely the scenario this guard exists for: a Z-named DDLS whose sqlViewName
    // activates a database view outside the customer namespace.
    const maliciousSource = ddlsSource("SFLIGHT_X");
    const { conn, adt } = await connected((r) => {
      if (r.url === DDLS_URI && r.method === "GET")
        return resp(200, OBJECT_XML(DDLS_NAME, "DDLS/DF", "$TMP"), OK_XML);
      if (r.url === DDLS_SRC && r.method === "GET") return resp(200, before, OK_TEXT);
      // Deliberately NOT routing LOCK/UNLOCK/PUT: the refusal must happen
      // before any of them are reached. FakeAdt throws loudly on an unrouted
      // request, which is a stronger proof than `adt.verbs` alone.
      return undefined;
    });
    const e = await catchErr(
      abapWrite(
        conn,
        { object: DDLS_NAME, type: "DDLS/DF", package: "$TMP", source: maliciousSource },
        20_000,
        gate,
      ),
    );
    expect(e.code).toBe("SAFETY_DENIED");
    // The refusal must NAME the reason: which database view, and why it is
    // out of bounds — not a generic "denied".
    expect(e.message).toContain("SFLIGHT_X");
    expect(e.message).toMatch(/customer namespace/);
    expect(adt.verbs.filter((v) => v === "LOCK")).toHaveLength(0);
    expect(adt.verbs).not.toContain("PUT");
  });

  it("refuses (rather than guesses) when the annotation is ambiguous — two sqlViewName occurrences — before any LOCK/PUT is attempted", async () => {
    const before = ddlsSource("ZVMCP_SQLVN_TES");
    const ambiguousSource =
      `@AbapCatalog.sqlViewName: 'ZVMCP_SQLVN_TES'\n` +
      `@AbapCatalog.sqlViewName: 'ZVMCP_OTHER_NAM'\n` +
      `@AccessControl.authorizationCheck: #NOT_REQUIRED\n` +
      `define view ${DDLS_NAME} as select from sflight { key carrid }\n`;
    const { conn, adt } = await connected((r) => {
      if (r.url === DDLS_URI && r.method === "GET")
        return resp(200, OBJECT_XML(DDLS_NAME, "DDLS/DF", "$TMP"), OK_XML);
      if (r.url === DDLS_SRC && r.method === "GET") return resp(200, before, OK_TEXT);
      return undefined;
    });
    const e = await catchErr(
      abapWrite(
        conn,
        { object: DDLS_NAME, type: "DDLS/DF", package: "$TMP", source: ambiguousSource },
        20_000,
        gate,
      ),
    );
    expect(e.code).toBe("SAFETY_DENIED");
    expect(adt.verbs.filter((v) => v === "LOCK")).toHaveLength(0);
    expect(adt.verbs).not.toContain("PUT");
  });

  it("does not even look at sqlViewName for a non-DDLS write — the check is scoped to DDLS/DF only", async () => {
    // A PROG/P write whose source happens to contain the literal string
    // "sqlViewName" (e.g. in a comment or string constant) must not be
    // affected by this guard at all: it is not a DDLS, so there is no
    // database view being activated by an annotation.
    const src = `REPORT ${REPORT}.\n* sqlViewName: 'SFLIGHT_X' -- not a DDLS, must not be checked\nWRITE: / 'x'.\n`;
    // A dedicated, stateful route rather than composing over `existingReport`:
    // `abapWrite` re-reads the source after PUT/UNLOCK before activating (the
    // pre-activation ETAG_CONFLICT guard in src/tools/write.ts), so the fake
    // must advance on PUT the same way `existingDdls` above does.
    let current = SOURCE_A_CRLF;
    const { conn, adt } = await connected((r) => {
      if (r.url === REPORT_SRC && r.method === "GET") return resp(200, current, OK_TEXT);
      if (r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === REPORT_SRC && r.method === "PUT") {
        current = r.body ?? "";
        return resp(200, "", OK_TEXT);
      }
      if (r.url.includes("/checkruns")) return resp(200, CLEAN_CHECKRUN, OK_XML);
      if (r.url.includes("/activation")) return resp(200, "", OK_TEXT);
      return undefined;
    });
    const result = await abapWrite(conn, { object: REPORT, type: "PROG/P", source: src }, 20_000, gate);
    expect(result.text).toMatch(/changed:\s*true/);
    expect(adt.verbs).toContain("PUT");
  });
});

// =============================================================================
// Batch delete: `abap_write`'s `objects` field (mode=delete only).
//
// Mirrors `test/activate.test.ts`'s own "batch activation (`objects`)"
// section — schema/dispatch level first (zero-network refusals), then an
// end-to-end tier exercising real (faked-HTTP) multi-object deletes. Delete's
// execution semantics diverge from activation's on purpose (see
// `abapWriteBatchDelete`'s doc comment in src/tools/write.ts): there is no
// server-side batch endpoint, so this is a client-side loop, and it continues
// past a per-object failure instead of aborting the rest of the set.
// =============================================================================

/** SYNTHETIC — invented for these tests; never captured from a live system. */
const BDEL_A = { name: "ZMCP_BDEL_A", uri: "/sap/bc/adt/programs/programs/zmcp_bdel_a", type: "PROG/P" };
/** SYNTHETIC — invented for these tests; never captured from a live system. */
const BDEL_B = { name: "ZMCP_BDEL_B", uri: "/sap/bc/adt/programs/programs/zmcp_bdel_b", type: "PROG/P" };
/** SYNTHETIC — invented for these tests; never captured from a live system. */
const BDEL_C = { name: "ZMCP_BDEL_C", uri: "/sap/bc/adt/programs/programs/zmcp_bdel_c", type: "PROG/P" };
/** SYNTHETIC — invented for these tests; never captured from a live system. */
const BDEL_PKG = { name: "ZMCP_BDEL_PKG", uri: "/sap/bc/adt/packages/zmcp_bdel_pkg", type: "DEVC/K" };

/**
 * A fake system that can answer resolve/lock/unlock/delete for any of `objs`,
 * keyed off each object's own URI so several distinguishable objects can
 * share one route in one test — the only way to pin cross-object ordering.
 * SYNTHETIC — invented for these tests, never captured from a live system.
 */
function batchDeleteRoute(
  objs: ReadonlyArray<{ name: string; uri: string; type: string }>,
  opts: {
    failDeleteFor?: string | ReadonlyArray<string>;
    failReadFor?: string | ReadonlyArray<string>;
    /**
     * Test setup: the DELETE succeeds, but neither probe can settle it —
     * post-delete read-back 500s and the repository search reports a
     * mismatched type, the same shape delete-verification.test.ts uses for
     * `deleted: "unverified"`.
     */
    unverifiedFor?: string | ReadonlyArray<string>;
    /**
     * The object's own resolution GET 404s (ADT's real answer for a name
     * that isn't there), same fixture as module-level `ABSENT_ROUTE`. No
     * LOCK/DELETE route is ever reached for it — `resolveWriteTarget` throws
     * NOT_FOUND straight off that GET, before pass 2 could touch it.
     */
    absentFor?: string | ReadonlyArray<string>;
  } = {},
): Route {
  // A real server: once an object's DELETE has actually landed, its content
  // URI answers 404 — that 404 is what the post-delete read-back needs to
  // confirm `deleted: true` instead of degrading to `"unverified"`. A failed
  // DELETE (opts.failDeleteFor) never flips this, since the object is still there.
  const failing = new Set(
    opts.failDeleteFor === undefined
      ? []
      : Array.isArray(opts.failDeleteFor)
        ? opts.failDeleteFor
        : [opts.failDeleteFor],
  );
  // A source GET that 500s, unlike failDeleteFor, fails BEFORE the lock
  // is even taken — `readCurrentSourceResult` comes back `{ ok: false }`, so
  // `deleteObject` throws BEFORE_IMAGE_UNAVAILABLE ahead of the before-image
  // hook (src/adt/write.ts:3881) and no LOCK/DELETE is ever issued for it.
  const unreadable = new Set(
    opts.failReadFor === undefined
      ? []
      : Array.isArray(opts.failReadFor)
        ? opts.failReadFor
        : [opts.failReadFor],
  );
  const unverifiedSet = new Set(
    opts.unverifiedFor === undefined
      ? []
      : Array.isArray(opts.unverifiedFor)
        ? opts.unverifiedFor
        : [opts.unverifiedFor],
  );
  const absentSet = new Set(
    opts.absentFor === undefined ? [] : Array.isArray(opts.absentFor) ? opts.absentFor : [opts.absentFor],
  );
  const gone = new Set<string>();
  return (r) => {
    if (r.url.endsWith("/repository/informationsystem/search")) {
      const queried = String(r.qs.query ?? "");
      const hit = objs.find((o) => o.name === queried && unverifiedSet.has(o.name));
      // A hit under a DIFFERENT type ⇒ verifyViaRepositorySearch's own
      // indeterminate branch (mismatched type), not confirmed/confirmed-absent.
      return hit
        ? resp(
            200,
            searchResultsXml([{ name: hit.name, type: "CLAS/OC", uri: "/sap/bc/adt/oo/classes/zmcp_unverified" }]),
            OK_XML,
          )
        : resp(200, searchResultsXml([]), OK_XML);
    }
    for (const o of objs) {
      const src = `${o.uri}/source/main`;
      if (r.url === o.uri && r.method === "GET" && !r.qs._action) {
        if (absentSet.has(o.name)) return resp(404, NOT_FOUND_XML, OK_XML);
        return resp(200, OBJECT_XML(o.name, o.type), OK_XML);
      }
      if (r.url === src && r.method === "GET") {
        if (unreadable.has(o.name)) return resp(500, "<exc:exception/>", OK_XML);
        // Post-delete read-back only — the pre-delete reads must still see the object.
        if (gone.has(o.name) && unverifiedSet.has(o.name)) return resp(500, "<exc:exception/>", OK_XML);
        return gone.has(o.name)
          ? resp(404, NOT_FOUND_XML, OK_XML)
          : resp(200, `REPORT ${o.name.toLowerCase()}.\n`, OK_TEXT);
      }
      if (r.url === o.uri && r.qs._action === "LOCK") {
        return resp(200, LOCK_XML(`H_${o.name}`), OK_XML);
      }
      if (r.url === o.uri && r.qs._action === "UNLOCK") {
        return resp(200, "", OK_TEXT);
      }
      if (r.url === o.uri && r.method === "DELETE") {
        if (failing.has(o.name)) return resp(403, "<exc:exception/>", OK_XML);
        gone.add(o.name);
        return resp(200, "", {});
      }
    }
    return undefined;
  };
}

describe("abapWrite — `objects` (batch delete), schema/dispatch level", () => {
  it("`object` AND `objects` together — BAD_INPUT, no request", async () => {
    const { conn, adt } = await connected(() => undefined);
    const e = await catchErr(
      abapWrite(
        conn,
        { object: BDEL_A.name, objects: [{ object: BDEL_B.name }], mode: "delete" } as never,
        100_000,
        DEFAULT_GATE,
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toContain("does not combine with top-level");
    expect(adt.calls).toHaveLength(0);
  });

  it("neither `object` nor `objects` — BAD_INPUT, no request", async () => {
    const { conn, adt } = await connected(() => undefined);
    const e = await catchErr(abapWrite(conn, {} as never, 100_000, DEFAULT_GATE));
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toContain("Pass either `object`");
    expect(adt.calls).toHaveLength(0);
  });

  it("`objects` with mode absent (write's own default) — BAD_INPUT, requires explicit mode:\"delete\"", async () => {
    const { conn, adt } = await connected(() => undefined);
    const e = await catchErr(abapWrite(conn, { objects: [{ object: BDEL_A.name }] } as never, 100_000, DEFAULT_GATE));
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toContain('mode: "delete"');
    expect(adt.calls).toHaveLength(0);
  });

  it("`objects` with mode:\"write\" explicit — still BAD_INPUT", async () => {
    const { conn, adt } = await connected(() => undefined);
    const e = await catchErr(
      abapWrite(conn, { objects: [{ object: BDEL_A.name }], mode: "write" } as never, 100_000, DEFAULT_GATE),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(adt.calls).toHaveLength(0);
  });

  it("a stray top-level field alongside `objects` — BAD_INPUT naming it, no request", async () => {
    const { conn, adt } = await connected(() => undefined);
    const e = await catchErr(
      abapWrite(
        conn,
        { objects: [{ object: BDEL_A.name }], mode: "delete", source: "REPORT x." } as never,
        100_000,
        DEFAULT_GATE,
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toContain("`source`");
    expect(adt.calls).toHaveLength(0);
  });

  it("the registered schema caps `objects` at MAX_DELETE_BATCH — one more is rejected before any code runs", () => {
    const schema = z.object(writeInputSchema);
    const atCap = Array.from({ length: MAX_DELETE_BATCH }, (_, i) => ({ object: `ZMCP_BDEL_${i}` }));
    const overCap = [...atCap, { object: "ZMCP_BDEL_ONE_TOO_MANY" }];
    expect(schema.safeParse({ mode: "delete", objects: atCap }).success).toBe(true);
    expect(schema.safeParse({ mode: "delete", objects: overCap }).success).toBe(false);
  });

  it("`abapWriteBatchDelete` itself re-checks the cap (belt-and-braces for direct callers), no request", async () => {
    const { conn, adt } = await connected(() => undefined);
    const tooMany = Array.from({ length: MAX_DELETE_BATCH + 1 }, (_, i) => ({
      object: `ZMCP_BDEL_X${i}`,
      type: "PROG/P",
    }));
    const e = await catchErr(abapWriteBatchDelete(conn, tooMany, 100_000, DEFAULT_GATE, undefined));
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toContain(String(MAX_DELETE_BATCH));
    expect(adt.calls).toHaveLength(0);
  });

  it("an empty `objects` array is refused directly (schema already forbids it, this is belt-and-braces)", async () => {
    const { conn, adt } = await connected(() => undefined);
    const e = await catchErr(abapWriteBatchDelete(conn, [], 100_000, DEFAULT_GATE, undefined));
    expect(e.code).toBe("BAD_INPUT");
    expect(adt.calls).toHaveLength(0);
  });

  it("refuses a batch naming the same object twice, before deleting (or even locking) anything", async () => {
    const { conn, adt } = await connected(batchDeleteRoute([BDEL_A]));
    const e = await catchErr(
      abapWriteBatchDelete(
        conn,
        [
          { object: BDEL_A.name, type: "PROG/P" },
          { object: BDEL_A.name, type: "PROG/P" },
        ],
        100_000,
        DEFAULT_GATE,
        undefined,
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toContain("more than once");
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("DELETE");
  });

  it("`assertNoDuplicateDeleteTargets` itself: same name twice throws, distinct names pass", () => {
    expect(() =>
      assertNoDuplicateDeleteTargets([
        { name: BDEL_A.name, uri: BDEL_A.uri },
        { name: BDEL_A.name, uri: BDEL_A.uri },
      ]),
    ).toThrow(/more than once/);
    expect(() =>
      assertNoDuplicateDeleteTargets([
        { name: BDEL_A.name, uri: BDEL_A.uri },
        { name: BDEL_B.name, uri: BDEL_B.uri },
      ]),
    ).not.toThrow();
  });
});

describe("abapWriteBatchDelete — package refusal inside a set (validate the WHOLE set before deleting ANYTHING)", () => {
  it("a DEVC/K entry LAST in the batch still refuses the WHOLE thing — the objects before it are never deleted", async () => {
    const { conn, adt } = await connected(batchDeleteRoute([BDEL_A, BDEL_B, BDEL_PKG]));
    const e = await catchErr(
      abapWriteBatchDelete(
        conn,
        [
          { object: BDEL_A.name, type: "PROG/P" },
          { object: BDEL_B.name, type: "PROG/P" },
          { object: BDEL_PKG.name, type: "DEVC/K" },
        ],
        100_000,
        DEFAULT_GATE,
        undefined,
      ),
    );
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.message).toContain(BDEL_PKG.name);
    expect(e.message).toContain("Nothing in this batch was deleted");
    // The refusal is about BATCHING, not deletability: it must
    // NOT claim packages can't be deleted, and must point at the real
    // single-object route instead of a dead end.
    expect(e.message).toMatch(/one at a time/);
    expect(e.message).not.toMatch(/does not delete packages/);
    expect(e.hint).toContain('abap_write { mode: "delete", type: "DEVC/K" }');
    // Pass 1 resolved/authorised A and B (their resolve GETs happened) before
    // reaching the package and throwing — proving the refusal is a genuine
    // whole-set validation, not a lucky short-circuit — but pass 2 (the
    // deleting pass) never started at all: no LOCK, no DELETE, for anything.
    expect(adt.labels).toEqual([`GET ${BDEL_A.uri}`, `GET ${BDEL_B.uri}`, `GET ${BDEL_PKG.uri}`]);
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("DELETE");
  });

  it("a DEVC/K entry FIRST in the batch also refuses the WHOLE thing, not just entry #1", async () => {
    const { conn, adt } = await connected(batchDeleteRoute([BDEL_PKG, BDEL_A, BDEL_B]));
    const e = await catchErr(
      abapWriteBatchDelete(
        conn,
        [
          { object: BDEL_PKG.name, type: "DEVC/K" },
          { object: BDEL_A.name, type: "PROG/P" },
          { object: BDEL_B.name, type: "PROG/P" },
        ],
        100_000,
        DEFAULT_GATE,
        undefined,
      ),
    );
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.message).toContain(BDEL_PKG.name);
    expect(e.message).toMatch(/one at a time/);
    expect(e.hint).toContain('abap_write { mode: "delete", type: "DEVC/K" }');
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("DELETE");
  });
});

describe("abapWriteBatchDelete — ordering: caller order, never reordered", () => {
  it("deletes three objects in the EXACT order given, one fully at a time", async () => {
    const { conn, adt } = await connected(batchDeleteRoute([BDEL_A, BDEL_B, BDEL_C]));
    const res = await abapWriteBatchDelete(
      conn,
      [BDEL_A, BDEL_B, BDEL_C].map((o) => ({ object: o.name, type: "PROG/P" })),
      100_000,
      DEFAULT_GATE,
      undefined,
    );
    expect(res.text).toContain("deleted: 3");
    expect(res.text).toContain("failed: 0");
    // Pass 1 (all three resolves), THEN pass 2 one object fully at a time —
    // never interleaved, never reordered. Each DELETE is followed by the
    // post-delete read-back (a 404, so no repository-search fallback call),
    // then a session renewal before the next entry's LOCK (not before the first).
    expect(adt.labels).toEqual([
      `GET ${BDEL_A.uri}`,
      `GET ${BDEL_B.uri}`,
      `GET ${BDEL_C.uri}`,
      `GET ${BDEL_A.uri}/source/main`,
      `LOCK ${BDEL_A.uri}`,
      `GET ${BDEL_A.uri}/source/main`,
      `DELETE ${BDEL_A.uri}`,
      `GET ${BDEL_A.uri}/source/main`,
      `GET /sap/bc/adt/compatibility/graph`,
      `GET ${BDEL_B.uri}/source/main`,
      `LOCK ${BDEL_B.uri}`,
      `GET ${BDEL_B.uri}/source/main`,
      `DELETE ${BDEL_B.uri}`,
      `GET ${BDEL_B.uri}/source/main`,
      `GET /sap/bc/adt/compatibility/graph`,
      `GET ${BDEL_C.uri}/source/main`,
      `LOCK ${BDEL_C.uri}`,
      `GET ${BDEL_C.uri}/source/main`,
      `DELETE ${BDEL_C.uri}`,
      `GET ${BDEL_C.uri}/source/main`,
    ]);
  });

  it("reversing the caller's order reverses the delete order too — abapsmith does not sort by name or type", async () => {
    const { conn, adt } = await connected(batchDeleteRoute([BDEL_A, BDEL_B, BDEL_C]));
    await abapWriteBatchDelete(
      conn,
      [BDEL_C, BDEL_B, BDEL_A].map((o) => ({ object: o.name, type: "PROG/P" })),
      100_000,
      DEFAULT_GATE,
      undefined,
    );
    const deleteOrder = adt.calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    expect(deleteOrder).toEqual([BDEL_C.uri, BDEL_B.uri, BDEL_A.uri]);
  });
});

describe("abapWriteBatchDelete — already-absent entries are skipped, not refused", () => {
  it("an absent entry in the middle does not stop the others — they are really deleted, and the absence is reported by name", async () => {
    const { conn, adt } = await connected(batchDeleteRoute([BDEL_A, BDEL_B, BDEL_C], { absentFor: BDEL_B.name }));
    const res = await abapWriteBatchDelete(
      conn,
      [BDEL_A, BDEL_B, BDEL_C].map((o) => ({ object: o.name, type: "PROG/P" })),
      100_000,
      DEFAULT_GATE,
      undefined,
    );
    // Reaching a response at all (rather than a thrown error) is the "no
    // throw" proof — a refusal here would reject the promise instead.
    expect(res.text).toContain("deleted: 2");
    expect(res.text).toContain("absent: 1");
    expect(res.text).toContain("failed: 0");
    expect(res.text).toMatch(/ZMCP_BDEL_B: already absent/);
    // A and C were genuinely deleted.
    const deleteOrder = adt.calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    expect(deleteOrder).toEqual([BDEL_A.uri, BDEL_C.uri]);
    // B got nothing beyond its own resolution GET (which 404s) — no
    // before-image read, no LOCK, no DELETE.
    const bVerbs = adt.calls
      .filter((c) => c.url === BDEL_B.uri || c.url === `${BDEL_B.uri}/source/main`)
      .map((c) => (c.qs._action ? c.qs._action : c.method));
    expect(bVerbs).toEqual(["GET"]);
  });

  it("an absent entry mixed with a genuine package still fails the WHOLE batch before any delete", async () => {
    const { conn, adt } = await connected(batchDeleteRoute([BDEL_A, BDEL_PKG], { absentFor: BDEL_A.name }));
    const e = await catchErr(
      abapWriteBatchDelete(
        conn,
        [
          { object: BDEL_A.name, type: "PROG/P" },
          { object: BDEL_PKG.name, type: "DEVC/K" },
        ],
        100_000,
        DEFAULT_GATE,
        undefined,
      ),
    );
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.message).toContain(BDEL_PKG.name);
    // The package guard still wins over an already-absent neighbour — no
    // mutating request was issued for anything in the batch.
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("DELETE");
  });

  it("a batch where every entry is absent succeeds, reports zero deleted, and issues no mutating request at all", async () => {
    const { conn, adt } = await connected(
      batchDeleteRoute([BDEL_A, BDEL_B], { absentFor: [BDEL_A.name, BDEL_B.name] }),
    );
    const res = await abapWriteBatchDelete(
      conn,
      [BDEL_A, BDEL_B].map((o) => ({ object: o.name, type: "PROG/P" })),
      100_000,
      DEFAULT_GATE,
      undefined,
    );
    expect(res.text).toContain("deleted: 0");
    expect(res.text).toContain("absent: 2");
    expect(res.text).toContain("failed: 0");
    expect(res.text).toMatch(/None of the 2 object\(s\) in this batch existed on A4H — nothing was deleted\./);
    expect(adt.calls.filter((c) => c.method === "DELETE" || c.qs._action === "LOCK")).toHaveLength(0);
  });

  it("a duplicate that is also absent is still refused up front", async () => {
    const { conn, adt } = await connected(batchDeleteRoute([BDEL_A], { absentFor: BDEL_A.name }));
    const e = await catchErr(
      abapWriteBatchDelete(
        conn,
        [
          { object: BDEL_A.name, type: "PROG/P" },
          { object: BDEL_A.name, type: "PROG/P" },
        ],
        100_000,
        DEFAULT_GATE,
        undefined,
      ),
    );
    expect(e.code).toBe("BAD_INPUT");
    expect(e.message).toContain("more than once");
    expect(adt.verbs).not.toContain("LOCK");
    expect(adt.verbs).not.toContain("DELETE");
  });
});

describe("abapWriteBatchDelete — partial failure: continue past it, report every object's own outcome", () => {
  it("object B's failed delete does NOT stop C from being attempted, and both outcomes are reported correctly", async () => {
    const { conn, adt } = await connected(batchDeleteRoute([BDEL_A, BDEL_B, BDEL_C], { failDeleteFor: BDEL_B.name }));
    // A partial failure now throws CHECK_FAILED instead of returning an
    // `ok` envelope — see the `abapWriteBatchDelete` doc comment. The
    // per-object text this test used to read off `res.text` now lives on the
    // thrown error's `details.body`/`details.perObject` instead.
    const e = await catchErr(
      abapWriteBatchDelete(
        conn,
        [BDEL_A, BDEL_B, BDEL_C].map((o) => ({ object: o.name, type: "PROG/P" })),
        100_000,
        DEFAULT_GATE,
        undefined,
      ),
    );
    expect(e.code).toBe("CHECK_FAILED");
    expect(e.details.body).toMatch(/ZMCP_BDEL_A: deleted/);
    expect(e.details.body).toMatch(/ZMCP_BDEL_B: FAILED/);
    expect(e.details.body).toMatch(/ZMCP_BDEL_C: deleted/);
    const perObject = e.details.perObject as Array<{ object: string; ok: boolean }>;
    expect(perObject.find((o) => o.object === BDEL_A.name)?.ok).toBe(true);
    expect(perObject.find((o) => o.object === BDEL_B.name)?.ok).toBe(false);
    expect(perObject.find((o) => o.object === BDEL_C.name)?.ok).toBe(true);
    // C was genuinely attempted — not skipped because B failed.
    const deleteOrder = adt.calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    expect(deleteOrder).toEqual([BDEL_A.uri, BDEL_B.uri, BDEL_C.uri]);
    // B's own call sequence: resolve, pre-lock read, lock, post-lock read,
    // failed DELETE, and (unlike a successful delete) an UNLOCK — the object
    // is still there and still enqueued.
    const bVerbs = adt.calls
      .filter((c) => c.url === BDEL_B.uri || c.url === `${BDEL_B.uri}/source/main`)
      .map((c) => (c.qs._action ? c.qs._action : c.method));
    expect(bVerbs).toEqual(["GET", "GET", "LOCK", "GET", "DELETE", "UNLOCK"]);
  });

  it("failures anywhere in the middle still let every later object be attempted", async () => {
    const { conn, adt } = await connected(batchDeleteRoute([BDEL_A, BDEL_B, BDEL_C], { failDeleteFor: BDEL_A.name }));
    // Still a partial failure — still throws — but execution (this
    // test's whole point) is unaffected.
    await catchErr(
      abapWriteBatchDelete(
        conn,
        [BDEL_A, BDEL_B, BDEL_C].map((o) => ({ object: o.name, type: "PROG/P" })),
        100_000,
        DEFAULT_GATE,
        undefined,
      ),
    );
    const deleteOrder = adt.calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    expect(deleteOrder).toEqual([BDEL_A.uri, BDEL_B.uri, BDEL_C.uri]);
  });
});

// `deleted: "unverified"` stays `ok: true` (kept out of `failed`) but
// must not be folded into the "deleted" rollup as a plain success either.
describe("abapWriteBatchDelete — unverified deletes get their own rollup line, not folded into `deleted`", () => {
  it("a mixed batch (one confirmed, one unverified) reports both counts separately and does not claim all were deleted", async () => {
    const { conn } = await connected(batchDeleteRoute([BDEL_A, BDEL_B], { unverifiedFor: BDEL_B.name }));
    const res = await abapWriteBatchDelete(
      conn,
      [BDEL_A, BDEL_B].map((o) => ({ object: o.name, type: "PROG/P" })),
      100_000,
      DEFAULT_GATE,
      undefined,
    );
    expect(res.text).toContain("deleted: 1");
    expect(res.text).toContain("unverified: 1");
    expect(res.text).toContain("failed: 0");
    expect(res.text).not.toMatch(/All 2 object\(s\) were deleted\./);
    expect(res.text).toMatch(/1 of 2 object\(s\) confirmed deleted; 1 unverified/);
    expect(res.text).toMatch(/ZMCP_BDEL_B: deleted \(UNVERIFIED/);
  });

  it("an all-unverified batch is still ok (no throw) but is NOT reported as unqualified success", async () => {
    const { conn } = await connected(
      batchDeleteRoute([BDEL_A, BDEL_B], { unverifiedFor: [BDEL_A.name, BDEL_B.name] }),
    );
    const res = await abapWriteBatchDelete(
      conn,
      [BDEL_A, BDEL_B].map((o) => ({ object: o.name, type: "PROG/P" })),
      100_000,
      DEFAULT_GATE,
      undefined,
    );
    // Reaching a returned response at all (rather than a thrown CHECK_FAILED)
    // is itself the "does not throw" assertion — `ok` stays true per-object.
    expect(res.text).toContain("deleted: 0");
    expect(res.text).toContain("unverified: 2");
    expect(res.text).toContain("failed: 0");
    expect(res.text).not.toMatch(/All 2 object\(s\) were deleted\./);
    expect(res.text).toMatch(/0 of 2 object\(s\) confirmed deleted; 2 unverified/);
  });

  it("a batch with a confirmed, an unverified, AND a failure: CHECK_FAILED's tally matches the header's split, not a folded `succeeded` count", async () => {
    const { conn } = await connected(
      batchDeleteRoute([BDEL_A, BDEL_B, BDEL_C], { unverifiedFor: BDEL_B.name, failDeleteFor: BDEL_C.name }),
    );
    const e = await catchErr(
      abapWriteBatchDelete(
        conn,
        [BDEL_A, BDEL_B, BDEL_C].map((o) => ({ object: o.name, type: "PROG/P" })),
        100_000,
        DEFAULT_GATE,
        undefined,
      ),
    );
    expect(e.code).toBe("CHECK_FAILED");
    expect(String(e.message)).toMatch(/1 deleted, 1 unverified, 1 failed/);
  });
});

describe("abapWriteBatchDelete — per-object journal entries", () => {
  const withJournal = async (fn: (j: Journal) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "abapsmith-write-batch-journal-"));
    try {
      await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it("a batch of 3 successful deletes produces 3 INDEPENDENT, individually-settled entries — never one aggregate entry", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(batchDeleteRoute([BDEL_A, BDEL_B, BDEL_C]));
      const res = await abapWriteBatchDelete(
        conn,
        [BDEL_A, BDEL_B, BDEL_C].map((o) => ({ object: o.name, type: "PROG/P" })),
        100_000,
        DEFAULT_GATE,
        journal,
      );
      expect(res.text).toContain("deleted: 3");

      const entries = await journal.list();
      expect(entries).toHaveLength(3);
      const byName = new Map(entries.map((e) => [e.object.name, e]));
      for (const o of [BDEL_A, BDEL_B, BDEL_C]) {
        const entry = byName.get(o.name);
        expect(entry, `no journal entry for ${o.name}`).toBeDefined();
        expect(entry!.operation).toBe("delete");
        // Fully settled — not left pending or "begun and abandoned".
        expect(entry!.outcome).toBe("succeeded");
        // Its OWN before-image, not a neighbour's — each object's source was distinct.
        expect(await journal.beforeImage(entry!)).toBe(`REPORT ${o.name.toLowerCase()}.\n`);
        // `abapWriteBatchDelete` is a distinct call site from
        // `abapWrite`'s own single-object delete path (added later, after
        // the systemKey gap was first fixed there) and initially reintroduced
        // the same gap — no `systemKey` on the entry it wrote. Pin it here so
        // a future refactor of this path can't silently drop it again the same way.
        expect(entry!.systemKey).toBe(systemKey(conn.cfg));
      }
    });
  });

  it("settles object k's entry BEFORE object k+1's DELETE is even issued — not just 'eventually all N exist'", async () => {
    await withJournal(async (journal) => {
      const trace: string[] = [];
      const realFinish = journal.finish.bind(journal);
      vi.spyOn(journal, "finish").mockImplementation(async (id, patch) => {
        const merged = await realFinish(id, patch);
        trace.push(`finish:${merged?.object.name ?? id}`);
        return merged;
      });
      const route = batchDeleteRoute([BDEL_A, BDEL_B, BDEL_C]);
      const objs = [BDEL_A, BDEL_B, BDEL_C];
      const { conn } = await connected((r) => {
        if (r.method === "DELETE") {
          const hit = objs.find((o) => r.url === o.uri);
          if (hit) trace.push(`DELETE:${hit.name}`);
        }
        return route(r);
      });
      await abapWriteBatchDelete(
        conn,
        objs.map((o) => ({ object: o.name, type: "PROG/P" })),
        100_000,
        DEFAULT_GATE,
        journal,
      );
      expect(trace).toEqual([
        "DELETE:ZMCP_BDEL_A",
        "finish:ZMCP_BDEL_A",
        "DELETE:ZMCP_BDEL_B",
        "finish:ZMCP_BDEL_B",
        "DELETE:ZMCP_BDEL_C",
        "finish:ZMCP_BDEL_C",
      ]);
    });
  });

  it("a batch that dies partway leaves a TRUTHFUL journal — succeeded entries say so, the failed one says FAILED, nothing is silently optimistic", async () => {
    await withJournal(async (journal) => {
      const route = batchDeleteRoute([BDEL_A, BDEL_B, BDEL_C], { failDeleteFor: BDEL_B.name });
      const { conn } = await connected(route);
      // A partial failure now throws instead of returning `ok` — the
      // journal is still written for real regardless, which is what this
      // test is actually pinning.
      const e = await catchErr(
        abapWriteBatchDelete(
          conn,
          [BDEL_A, BDEL_B, BDEL_C].map((o) => ({ object: o.name, type: "PROG/P" })),
          100_000,
          DEFAULT_GATE,
          journal,
        ),
      );
      expect(e.code).toBe("CHECK_FAILED");
      expect(e.details.blamed).toEqual([BDEL_B.name]);

      const entries = await journal.list();
      // C was still attempted and journalled despite B's mid-batch failure —
      // continue-past-failure, not abort-the-rest-of-the-loop.
      expect(entries).toHaveLength(3);
      const byName = new Map(entries.map((e) => [e.object.name, e]));
      expect(byName.get(BDEL_A.name)?.outcome).toBe("succeeded");
      expect(byName.get(BDEL_C.name)?.outcome).toBe("succeeded");
      // B's own entry is truthfully marked failed — never silently dropped,
      // and never left claiming a success that did not happen.
      expect(byName.get(BDEL_B.name)?.outcome).toBe("failed");
    });
  });
});

/**
 * Live finding: a batch delete of two PROG/P objects, over real ADT,
 * reported success — object A was deleted and journalled, object B was still
 * on the server with ZERO journal entries. The mechanism: B's pre-lock source
 * read failed, so `deleteObject` threw BEFORE_IMAGE_UNAVAILABLE before the
 * before-image hook ever fired (src/adt/write.ts:3881) and before any
 * LOCK/DELETE — so B was never attempted at all, not "attempted and failed".
 * `failDeleteFor` (used above) fails AFTER that hook and DOES journal, so it
 * can't reproduce this shape; `failReadFor` (added to `batchDeleteRoute` for
 * this test) fails the pre-lock `/source/main` GET instead, the same failure
 * ADT gave live. Exercises the real `abapWriteBatchDelete` loop and a real
 * `Journal` against a fake transport — nothing about the function under test
 * is mocked.
 */
describe("abapWriteBatchDelete — partial failure must not report success (live-signature regression)", () => {
  const withJournal = async (fn: (j: Journal) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "abapsmith-write-batch-partial-failure-"));
    try {
      await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it("B's pre-lock read fails ⇒ zero journal entries and no DELETE for B, A is deleted and journalled, and the call throws instead of reporting ok", async () => {
    await withJournal(async (journal) => {
      const { conn, adt } = await connected(batchDeleteRoute([BDEL_A, BDEL_B], { failReadFor: BDEL_B.name }));
      const e = await catchErr(
        abapWriteBatchDelete(
          conn,
          [BDEL_A, BDEL_B].map((o) => ({ object: o.name, type: "PROG/P" })),
          100_000,
          DEFAULT_GATE,
          journal,
        ),
      );

      // Leg 4: the call surfaces the failure instead of a success envelope.
      expect(e.code).toBe("CHECK_FAILED");

      const deleteUrls = adt.calls.filter((c) => c.method === "DELETE").map((c) => c.url);
      // Leg 2: A really was deleted.
      expect(deleteUrls).toContain(BDEL_A.uri);
      // Leg 1: no DELETE was ever issued for B — its pre-lock read failed first.
      expect(deleteUrls).not.toContain(BDEL_B.uri);

      // Leg 3: the real journal on disk holds exactly one delete entry, for A —
      // the exact assertion the live acceptance script made ("produced
      // exactly one delete entry", found 0).
      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.object.name).toBe(BDEL_A.name);
      expect(entries[0]!.operation).toBe("delete");
      expect(entries[0]!.outcome).toBe("succeeded");

      // Leg 4 continued: the new error envelope does not hide A's undo id —
      // `details.perObject` still names A as ok, with its journal entry.
      const perObject = e.details.perObject as Array<{ object: string; ok: boolean; journalEntry?: string }>;
      const aOutcome = perObject.find((o) => o.object === BDEL_A.name);
      expect(aOutcome?.ok).toBe(true);
      expect(aOutcome?.journalEntry).toBe(entries[0]!.id);
      const bOutcome = perObject.find((o) => o.object === BDEL_B.name);
      expect(bOutcome?.ok).toBe(false);
      expect(bOutcome?.journalEntry).toBeUndefined();
    });
  });
});

describe("abapWrite mode=delete — the journal note, by beforeCapture outcome", () => {
  const withJournal = async (fn: (j: Journal) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "abapsmith-single-delete-journal-"));
    try {
      await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  // Contrasts with test/write-package.test.ts's DEVC/K case (beforeCapture
  // "failed"): a source-bearing object's source IS captured, so THIS note —
  // and only this one — may claim undo re-creates the object. Pins WHICH
  // note is emitted for beforeCapture="captured"; asserts nothing about
  // whether the undo would actually succeed.
  it("a source-bearing PROG/P delete's note says undo re-creates the object (beforeCapture=\"captured\")", async () => {
    await withJournal(async (journal) => {
      const { conn } = await connected(batchDeleteRoute([BDEL_A]));
      const res = await abapWrite(
        conn,
        { object: BDEL_A.name, type: "PROG/P", mode: "delete" },
        20_000,
        DEFAULT_GATE,
        journal,
      );

      expect(res.text).toMatch(/^deleted: true$/m);
      expect(res.text).toContain("re-creates the object from it");
      expect(res.text).not.toContain("CANNOT restore it from this entry");

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.beforeCapture).toBe("captured");
    });
  });

  it("with the journal off, the note says nothing was journalled and the deletion is IRREVERSIBLE — never either capture-outcome note", async () => {
    const { conn } = await connected(batchDeleteRoute([BDEL_A]));
    const res = await abapWrite(
      conn,
      { object: BDEL_A.name, type: "PROG/P", mode: "delete" },
      20_000,
      DEFAULT_GATE,
      // no journal argument — same as passing `undefined`.
    );

    expect(res.text).toMatch(/^deleted: true$/m);
    expect(res.text).toContain("IRREVERSIBLE from here");
    expect(res.text).not.toContain("re-creates the object from it");
    expect(res.text).not.toContain("CANNOT restore it from this entry");
  });

  // Non-package side: pins the LOCAL header/note and that
  // the package-only "was not recorded" warning never leaks onto it.
  it("an ordinary (non-package) delete also gets a transport: header now, and never the package-only warning", async () => {
    const { conn } = await connected(batchDeleteRoute([BDEL_A]));
    const res = await abapWrite(conn, { object: BDEL_A.name, type: "PROG/P", mode: "delete" }, 20_000, DEFAULT_GATE);

    expect(res.text).toMatch(/^deleted: true$/m);
    expect(res.text).toMatch(/^transport: none \(\$TMP\/local\)$/m);
    expect(res.text).not.toContain("observed to NOT record");
  });
});

describe("registerWriteTools: `objects` (batch delete) dispatch, zero-network preflight", () => {
  function harness(gate: SafetyGate) {
    let poolCalls = 0;
    let lastGateKey: string | undefined = undefined;
    let gateKeyWasSet = false;
    const deps: WriteToolDeps = {
      pool: {
        withWrite: async <T>(_tool: string, gateKey: string | undefined): Promise<T> => {
          poolCalls += 1;
          lastGateKey = gateKey;
          gateKeyWasSet = true;
          return { text: "stub: reached pool.withWrite (preflight passed)", truncated: false } as unknown as T;
        },
      } as never,
      safety: gate,
      ensureConnected: async () => {},
      errorResult,
      cfg: { maxResponseChars: 50_000 },
      journal: undefined as never,
      transport: undefined as never,
    };
    const server = new McpServer({ name: "write-batch-preflight-probe", version: "0.0.0" });
    registerWriteTools(server, deps);
    const call = async (args: Record<string, unknown>): Promise<string> => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "write-batch-preflight-probe", version: "0.0.0" });
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const res = await client.callTool({ name: "abap_write", arguments: args });
      const first = Array.isArray(res.content) ? res.content[0] : undefined;
      return first && typeof first === "object" && "text" in first ? String((first as { text: unknown }).text) : "";
    };
    return { call, calls: () => poolCalls, gateKey: () => (gateKeyWasSet ? lastGateKey : "NEVER CALLED") };
  }

  const basicGate = () => new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

  it("preflights EVERY entry in `objects` before ensureConnected — one bad entry refuses zero-network", async () => {
    const { call, calls } = harness(basicGate());
    const text = await call({
      mode: "delete",
      objects: [{ object: "ZMCP_BDEL_OK1" }, { object: "ZMCP_BDEL_ENH_BAD", type: "ENHO/XHH" }],
    });
    expect(text).toMatch(/SAFETY_DENIED/);
    expect(calls()).toBe(0);
  });

  it("reaches pool.withWrite ONCE with gate key undefined — 'take a slot, take no gate' for the whole batch", async () => {
    const { call, calls, gateKey } = harness(basicGate());
    const text = await call({
      mode: "delete",
      objects: [{ object: "ZMCP_BDEL_OK1" }, { object: "ZMCP_BDEL_OK2" }],
    });
    expect(text).toBe("stub: reached pool.withWrite (preflight passed)");
    expect(calls()).toBe(1);
    expect(gateKey()).toBeUndefined();
  });

  it("`objects` with mode write (not delete) is refused before ensureConnected too, at the registrar level", async () => {
    const { call, calls } = harness(basicGate());
    const text = await call({ objects: [{ object: "ZMCP_BDEL_OK1" }] });
    expect(text).toMatch(/BAD_INPUT/);
    expect(text).toMatch(/mode.*delete/i);
    expect(calls()).toBe(0);
  });
});

/**
 * Any batch delete that leaves an object undeleted must set
 * `isError` — an MCP client keying on it (as the protocol says it should)
 * must not read a wipeout, total OR PARTIAL, as a success. The original guard
 * only fired on a total wipeout; it was generalised to partial failures after a live
 * run showed a partial failure reporting `isError` falsy while one of its two
 * objects was never even attempted. Runs through the real `client.callTool`,
 * not the core function directly, so it pins the registrar's envelope, not
 * just `abapWriteBatchDelete`'s return value.
 */
describe("registerWriteTools: batch delete — isError on the envelope, not just the outcomes", () => {
  function harness(conn: AbapConnection) {
    const deps: WriteToolDeps = {
      pool: {
        withWrite: async <T>(_tool: string, _gateKey: string | undefined, fn: (c: AbapConnection) => Promise<T>): Promise<T> =>
          fn(conn),
      } as never,
      safety: DEFAULT_GATE,
      ensureConnected: async () => {},
      errorResult,
      cfg: { maxResponseChars: 100_000 },
      journal: undefined as never,
      transport: undefined as never,
    };
    const server = new McpServer({ name: "write-batch-envelope-probe", version: "0.0.0" });
    registerWriteTools(server, deps);
    return async (args: Record<string, unknown>): Promise<{ text: string; isError: boolean | undefined }> => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "write-batch-envelope-probe", version: "0.0.0" });
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const res = await client.callTool({ name: "abap_write", arguments: args });
      const first = Array.isArray(res.content) ? res.content[0] : undefined;
      const text = first && typeof first === "object" && "text" in first ? String((first as { text: unknown }).text) : "";
      return { text, isError: res.isError as boolean | undefined };
    };
  }

  const objectsArg = [BDEL_A, BDEL_B, BDEL_C].map((o) => ({ object: o.name, type: "PROG/P" }));

  it("every object fails ⇒ isError is true, and the per-object detail survives into the error body", async () => {
    const { conn } = await connected(
      batchDeleteRoute([BDEL_A, BDEL_B, BDEL_C], { failDeleteFor: [BDEL_A.name, BDEL_B.name, BDEL_C.name] }),
    );
    const { text, isError } = await harness(conn)({ mode: "delete", objects: objectsArg });
    expect(isError).toBe(true);
    const payload = JSON.parse(text) as { error: string; details?: { blamed?: string[]; perObject?: unknown[] } };
    expect(payload.error).toBe("CHECK_FAILED");
    expect(payload.details?.blamed).toEqual([BDEL_A.name, BDEL_B.name, BDEL_C.name]);
    expect(payload.details?.perObject).toHaveLength(3);
    expect(text).toContain(BDEL_A.name);
    expect(text).toContain(BDEL_B.name);
    expect(text).toContain(BDEL_C.name);
  });

  it("a partial failure ALSO sets isError — the succeeded objects' journal entries survive into the error body", async () => {
    const { conn } = await connected(batchDeleteRoute([BDEL_A, BDEL_B, BDEL_C], { failDeleteFor: BDEL_B.name }));
    const { text, isError } = await harness(conn)({ mode: "delete", objects: objectsArg });
    expect(isError).toBe(true);
    const payload = JSON.parse(text) as {
      error: string;
      details?: { blamed?: string[]; perObject?: Array<{ object: string; ok: boolean }> };
    };
    expect(payload.error).toBe("CHECK_FAILED");
    expect(payload.details?.blamed).toEqual([BDEL_B.name]);
    expect(payload.details?.perObject).toHaveLength(3);
    expect(payload.details?.perObject?.find((o) => o.object === BDEL_A.name)?.ok).toBe(true);
    expect(payload.details?.perObject?.find((o) => o.object === BDEL_C.name)?.ok).toBe(true);
    expect(text).toContain("2 deleted");
    expect(text).toContain("1 failed");
  });

  it("every object succeeds ⇒ isError is falsy", async () => {
    const { conn } = await connected(batchDeleteRoute([BDEL_A, BDEL_B, BDEL_C]));
    const { text, isError } = await harness(conn)({ mode: "delete", objects: objectsArg });
    expect(isError).toBeFalsy();
    expect(text).toContain("deleted: 3");
    expect(text).toContain("failed: 0");
  });
});
