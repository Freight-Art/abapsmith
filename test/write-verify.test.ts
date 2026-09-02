/**
 * Round 3 regression pins for `src/adt/write-verify.ts` — the three-state
 * post-create verifier (fix (a)) and its repository-search fallback probe
 * (fix (b)). See `src/adt/write-verify.ts`'s own module doc for the live
 * finding this closes; see `FIX-NOTES.md` round 3 section for the fuller
 * writeup.
 *
 * This file exercises `verifyViaVitBridge`, `verifyViaRepositorySearch` and
 * `verifyObjectCreated` DIRECTLY, against a real `AbapConnection` wired to a
 * `FakeAdtServer` — the same harness idiom `test/bopf-client.test.ts` and
 * `test/server-session-revival.test.ts` use — rather than going through the
 * whole `abap_write` tool surface (`test/write.test.ts`'s "DEFECT 1 closed
 * for VIEW/DV" block already pins the end-to-end tool behaviour for the
 * three states via the VIT bridge alone; this file is the one place the
 * fallback probe and the UNSUPPORTED guardrail get DIRECT coverage).
 */
import { AdtErrorException } from "abap-adt-api/build/AdtException.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FakeAdtServer,
  __resetFakeAdtCounters,
  fakeResponse,
  objectMetadataXml,
  searchResultsXml,
  type FakeObjectRef,
  type FakeRoute,
} from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError } from "../src/adt/errors.js";
import { buildUri, specForType } from "../src/adt/types.js";
import {
  verifyViaVitBridge,
  verifyViaRepositorySearch,
  verifyObjectCreated,
  vitBridgeUri,
  isSessionDeadFailure,
  probeObjectPresence,
  vitStubShowsExistence,
  vitStubShowsRegistration,
} from "../src/adt/write-verify.js";

// ----------------------------------------------------------------------- harness ---

const systemRoleRoute: FakeRoute = (r) =>
  r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined;

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

const openConnections: AbapConnection[] = [];

beforeEach(() => {
  __resetFakeAdtCounters();
});

afterEach(() => {
  for (const conn of openConnections.splice(0)) conn.dispose();
});

async function wired(
  options: { routes?: readonly FakeRoute[]; catchAll?: FakeRoute; transportErrors?: "resolve" | "throw" } = {},
): Promise<{ conn: AbapConnection; server: FakeAdtServer }> {
  const server = new FakeAdtServer({
    transportErrors: options.transportErrors ?? "throw",
    routes: [systemRoleRoute, ...(options.routes ?? [])],
    ...(options.catchAll ? { catchAll: options.catchAll } : {}),
  });
  const client = server.client("s1");
  const conn = new AbapConnection(cfg(), {
    httpClient: client,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  openConnections.push(conn);
  await conn.connect();
  return { conn, server };
}

// ------------------------------------------------------------------ VIT-bridge stubs ---

/** A genuine, rich VIT-bridge stub — carries `packageRef` plus a matching type/name echo (registered, `vitStubShowsExistence` AND `vitStubShowsRegistration`). */
const richStub = (type: string, name: string, packageName = "STRN"): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:mainObject adtcore:name="${name}" adtcore:type="${type}" ` +
  `adtcore:version="active" adtcore:language="EN" xmlns:adtcore="http://www.sap.com/adt/core">` +
  `<adtcore:packageRef adtcore:name="${packageName}"/>` +
  `</adtcore:mainObject>`;

/** A thin VIT-bridge stub, echoing type/name — `200`, no `packageRef`, no enriched attrs. This settles as `confirmed-absent`, not `indeterminate`; see the "VIT bridge existence vs. registration" describe block below and `test/fixtures/vit/`. */
const sparseStub = (type: string, name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:mainObject adtcore:name="${name}" adtcore:type="${type}" ` +
  `adtcore:version="active" adtcore:language="EN" xmlns:adtcore="http://www.sap.com/adt/core"/>`;

/** A stub that answers for a DIFFERENT object than was asked — stays `indeterminate`, since nothing echoes back what was requested. */
const mismatchedStub = (type: string, name: string): string => sparseStub(type, `${name}_NOPE`);

/** An enriched-but-unregistered stub — `changedAt`/`changedBy`/`description`, no `packageRef` (exists, but not in TADIR). Same shape as `test/fixtures/vit/003-viewdv-enriched-unregistered.xml`, parametrized so both VIT types can be pinned symmetrically. */
const enrichedUnregisteredStub = (type: string, name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<adtcore:mainObject adtcore:name="${name}" adtcore:type="${type}" ` +
  `adtcore:changedAt="2026-08-20T00:00:00Z" adtcore:version="active" adtcore:changedBy="DEVELOPER" ` +
  `adtcore:description="${name}" adtcore:language="EN" xmlns:adtcore="http://www.sap.com/adt/core"/>`;

// ---------------------------------------------------------- VIT existence/registration live fixtures ---

const VIT_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "vit");
const vitFixture = (f: string): string => readFileSync(join(VIT_FIXTURES, f), "utf8");

/** `trant/ZTMD_T442R_NEVER` — never created: thin stub. */
const FX_THIN_TRANT = vitFixture("001-trant-thin-never-created.xml");
/** `viewdv/ZTMD_V_NEVERXX` — never created: thin stub (live capture). */
const FX_THIN_VIEWDV = vitFixture("002-viewdv-thin-never-created.xml");
/** `viewdv/ZTMD_V_442G2` — EXISTS, TADIR-unregistered: enriched attrs, no `packageRef` (live capture). */
const FX_ENRICHED_UNREGISTERED_VIEWDV = vitFixture("003-viewdv-enriched-unregistered.xml");
/** `trant/ZTMD_T442R` — after delete: thin stub. */
const FX_THIN_TRANT_AFTER_DELETE = vitFixture("004-trant-thin-after-delete.xml");
/** `trant/SE93` — EXISTS, registered: `packageRef adtcore:name="SEUA"`. */
const FX_ENRICHED_REGISTERED_TRANT = vitFixture("005-trant-enriched-registered.xml");

const VIT_TYPE = "viewdv";
const EXPECT_TYPE = "VIEW/DV";
const OBJ_NAME = "ZPROPW_VIEW";
const VIT_URI = vitBridgeUri(VIT_TYPE, OBJ_NAME);
const SEARCH_PATH = "/sap/bc/adt/repository/informationsystem/search";

describe("verifyViaVitBridge — the three states in isolation", () => {
  it("confirmed: a rich stub (packageRef + matching type/name echo) settles it", async () => {
    const route: FakeRoute = (r) =>
      r.url === VIT_URI ? fakeResponse(200, richStub(EXPECT_TYPE, OBJ_NAME), { "content-type": "application/xml" }) : undefined;
    const { conn } = await wired({ routes: [route] });

    const result = await verifyViaVitBridge(conn, VIT_TYPE, OBJ_NAME, EXPECT_TYPE);

    expect(result.status).toBe("confirmed");
    if (result.status === "confirmed") expect(result.via).toBe("vit-bridge");
  });

  it("confirmed-absent: a genuine 404 settles it — and NEVER lands as confirmed", async () => {
    const route: FakeRoute = (r) => (r.url === VIT_URI ? fakeResponse(404, "") : undefined);
    const { conn } = await wired({ routes: [route] });

    const result = await verifyViaVitBridge(conn, VIT_TYPE, OBJ_NAME, EXPECT_TYPE);

    expect(result.status).toBe("confirmed-absent");
    if (result.status === "confirmed-absent") expect(result.via).toBe("vit-bridge");
  });

  it("confirmed-absent: a thin 200 stub that echoes the name/type settles it as absent, not indeterminate", async () => {
    const route: FakeRoute = (r) =>
      r.url === VIT_URI ? fakeResponse(200, sparseStub(EXPECT_TYPE, OBJ_NAME), { "content-type": "application/xml" }) : undefined;
    const { conn } = await wired({ routes: [route] });

    const result = await verifyViaVitBridge(conn, VIT_TYPE, OBJ_NAME, EXPECT_TYPE);

    expect(result.status).toBe("confirmed-absent");
    if (result.status === "confirmed-absent") expect(result.via).toBe("vit-bridge");
  });

  it("indeterminate: a 200 that does not echo the requested name/type is not an answer about this object", async () => {
    const route: FakeRoute = (r) =>
      r.url === VIT_URI ? fakeResponse(200, mismatchedStub(EXPECT_TYPE, OBJ_NAME), { "content-type": "application/xml" }) : undefined;
    const { conn } = await wired({ routes: [route] });

    const result = await verifyViaVitBridge(conn, VIT_TYPE, OBJ_NAME, EXPECT_TYPE);

    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") expect(result.reason).toMatch(/did not echo back/);
  });

  it("regression pin: a probe response of UNSUPPORTED yields indeterminate and does not produce a refusal", async () => {
    // Coordinator finding: a live A4H run found `abap_read`'s default mode
    // throws `UNSUPPORTED` for some types (MSAG/N, ENQU/DL) REGARDLESS of
    // existence — not a valid not-found signal. `verifyViaVitBridge` guards
    // against exactly this in its catch block (see the long comment there),
    // but the guard is provably unreachable via any realistic wire-level
    // fake: `conn.get` (src/adt/connection.ts) does not call
    // `translateAdtError`, so a genuine wire response can only ever throw
    // abap-adt-api's own `AdtException` shape, never our `AbapError` class
    // (confirmed by reading node_modules/abap-adt-api/build/AdtHTTP.js). This
    // test therefore pins the DEFENSIVE branch directly, by stubbing
    // `conn.get` to throw the shape a future caller (or a future `conn.get`
    // implementation change) might one day actually produce — it is
    // honestly NOT a live-reachable path today, only a documented guardrail
    // against ever reintroducing the confirmed-absent-on-UNSUPPORTED defect.
    const { conn } = await wired();
    const originalGet = conn.get.bind(conn);
    conn.get = (async () => {
      throw new AbapError("UNSUPPORTED", "read not supported for this request shape");
    }) as typeof conn.get;
    try {
      const result = await verifyViaVitBridge(conn, VIT_TYPE, OBJ_NAME, EXPECT_TYPE);
      expect(result.status).toBe("indeterminate");
      if (result.status === "indeterminate") {
        expect(result.reason).toMatch(/not supported/);
      }
      // The combinator must not throw / refuse either — an UNSUPPORTED
      // primary must fall through to the fallback probe, not blow up.
      const combined = await verifyObjectCreated(conn, {
        vitType: VIT_TYPE,
        objectName: OBJ_NAME,
        expectType: EXPECT_TYPE,
      });
      expect(combined.status).not.toBe("confirmed-absent");
    } finally {
      conn.get = originalGet;
    }
  });
});

describe("verifyViaRepositorySearch — fix (b)'s fallback probe, in isolation", () => {
  const searchRoute = (refs: readonly FakeObjectRef[]): FakeRoute => (r) =>
    r.path === SEARCH_PATH ? fakeResponse(200, searchResultsXml(refs), { "content-type": "application/xml" }) : undefined;

  it("confirmed: an exact-name hit typed as expected settles it", async () => {
    const ref: FakeObjectRef = { name: OBJ_NAME, type: EXPECT_TYPE, uri: `/sap/bc/adt/ddic/views/${OBJ_NAME}`, packageName: "STRN" };
    const { conn } = await wired({ routes: [searchRoute([ref])] });

    const result = await verifyViaRepositorySearch(conn, OBJ_NAME, EXPECT_TYPE);

    expect(result.status).toBe("confirmed");
    if (result.status === "confirmed") expect(result.via).toBe("repository-search");
  });

  it("confirmed-absent: zero exact-name hits settles it (the live finding's own evidence shape)", async () => {
    const { conn } = await wired({ routes: [searchRoute([])] });

    const result = await verifyViaRepositorySearch(conn, OBJ_NAME, EXPECT_TYPE);

    expect(result.status).toBe("confirmed-absent");
    if (result.status === "confirmed-absent") expect(result.via).toBe("repository-search");
  });

  it("indeterminate: an exact-name hit typed DIFFERENTLY than expected is neither confirmed nor confirmed-absent", async () => {
    const ref: FakeObjectRef = { name: OBJ_NAME, type: "TABL/DT", uri: `/sap/bc/adt/ddic/tables/${OBJ_NAME}`, packageName: "STRN" };
    const { conn } = await wired({ routes: [searchRoute([ref])] });

    const result = await verifyViaRepositorySearch(conn, OBJ_NAME, EXPECT_TYPE);

    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") expect(result.reason).toMatch(/none typed/);
  });
});

describe("verifyViaRepositorySearch — blind spot for FUGR/FF", () => {
  const zeroHitSearch: FakeRoute = (r) =>
    r.path === SEARCH_PATH ? fakeResponse(200, searchResultsXml([]), { "content-type": "application/xml" }) : undefined;

  const BLIND_TYPE = "FUGR/FF";
  const blindSpec = specForType(BLIND_TYPE)!;
  const BLIND_GROUP = "ZHS416";
  const BLIND_FM = "ZHS416_FM";
  const blindObjUri = buildUri(blindSpec, BLIND_FM, BLIND_GROUP);
  const blindSrcUri = `${blindObjUri}/source/main`;

  it("FUGR/FF absent: 0 hits -> indeterminate, not confirmed-absent", async () => {
    const { conn } = await wired({ routes: [zeroHitSearch] });

    const result = await verifyViaRepositorySearch(conn, BLIND_FM, BLIND_TYPE);

    // LOAD-BEARING: at base this was `confirmed-absent` — the index simply
    // does not cover FUGR/FF, so a 0-hit answer here proves nothing.
    expect(result.status).toBe("indeterminate");
  });

  it("the positive control: FUGR/FF PRESENT, same 0-hit search -> STILL indeterminate", async () => {
    // Establishes presence independently of the search: the object AND its
    // source both answer 200 off this SAME server. That makes the 0 hits
    // below a constant of the search (it never indexes FUGR/FF module
    // names), not an observation about this particular object.
    const routes: FakeRoute[] = [
      zeroHitSearch,
      (r) =>
        r.url === blindObjUri
          ? fakeResponse(200, objectMetadataXml({ name: BLIND_FM, type: BLIND_TYPE }), { "content-type": "application/xml" })
          : undefined,
      (r) => (r.url === blindSrcUri ? fakeResponse(200, "FORM foo.\nENDFORM.", { "content-type": "text/plain" }) : undefined),
    ];
    const { conn } = await wired({ routes });

    const objResp = await conn.get(blindObjUri, { headers: { Accept: "application/*" } });
    const srcResp = await conn.get(blindSrcUri, { headers: { Accept: "text/plain" } });
    expect(objResp.status).toBe(200);
    expect(srcResp.status).toBe(200);

    const result = await verifyViaRepositorySearch(conn, BLIND_FM, BLIND_TYPE);

    // LOAD-BEARING: same 0-hit search response as the absent case above, now
    // against a demonstrably-present object — still indeterminate. The
    // search's "no" carries no information for this type, present or absent.
    expect(result.status).toBe("indeterminate");
  });

  it("contrast: a type NOT in the blind set still gets confirmed-absent from the same 0-hit shape", async () => {
    const { conn } = await wired({ routes: [zeroHitSearch] });

    const result = await verifyViaRepositorySearch(conn, "ZHS416_PROG", "PROG/P");

    expect(result.status).toBe("confirmed-absent");
    if (result.status === "confirmed-absent") expect(result.via).toBe("repository-search");
  });
});

describe("probeObjectPresence — the three states of one direct GET", () => {
  const PROBE_URI = "/sap/bc/adt/probe/ZHS414";
  const ACCEPT = "application/vnd.sap.adt.probe+xml";

  it("present: a 200 settles it", async () => {
    const route: FakeRoute = (r) => (r.url === PROBE_URI ? fakeResponse(200, "<probe/>", { "content-type": "application/xml" }) : undefined);
    const { conn } = await wired({ routes: [route] });

    const result = await probeObjectPresence(conn, PROBE_URI, ACCEPT);

    expect(result.presence).toBe("present");
    expect(result.revived).toBe(false);
  });

  it("absent: a 404 settles it", async () => {
    const route: FakeRoute = (r) => (r.url === PROBE_URI ? fakeResponse(404, "") : undefined);
    const { conn } = await wired({ routes: [route] });

    const result = await probeObjectPresence(conn, PROBE_URI, ACCEPT);

    expect(result.presence).toBe("absent");
    expect(result.revived).toBe(false);
  });

  it("no-answer: a failure that is neither absence nor a dead session settles nothing", async () => {
    const route: FakeRoute = (r) => (r.url === PROBE_URI ? fakeResponse(403, "") : undefined);
    const { conn } = await wired({ routes: [route] });

    const result = await probeObjectPresence(conn, PROBE_URI, ACCEPT);

    expect(result.presence).toBe("no-answer");
    expect(result.revived).toBe(false);
  });
});

describe("probeObjectPresence — reconnect-once on a dead session", () => {
  const PROBE_URI = "/sap/bc/adt/probe/ZHS413";
  const ACCEPT = "application/vnd.sap.adt.probe+xml";

  /** A genuine (non-hand-rolled) transport error whose `.response` carries the ICM dead-session header. */
  const sessionDeadOnWire = (): unknown =>
    AdtErrorException.create(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { status: 400, statusText: "Bad Request", headers: { "x-sap-icm-err-id": "ICMENOSESSION" }, body: "" } as any,
      {},
    );

  const notFoundOnWire = (): unknown => AdtErrorException.create(404, {}, "ExceptionResourceNotFound", "Not found");

  /** Per-URL, sequenced mock: first GET throws `first()`, every GET after throws/resolves via `second()`. */
  function sequencedConn(first: () => unknown, second: () => unknown) {
    const state = { calls: 0, connected: 0 };
    const conn = {
      get: async () => {
        state.calls++;
        const err = state.calls === 1 ? first() : second();
        if (err === undefined) return { body: "", status: 200, headers: {} };
        throw err;
      },
      connect: async () => {
        state.connected++;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as AbapConnection;
    return { conn, state };
  }

  it("dies once, reconnects, confirms absent -> presence: absent, revived: true, GET issued exactly twice", async () => {
    const { conn, state } = sequencedConn(sessionDeadOnWire, notFoundOnWire);
    const result = await probeObjectPresence(conn, PROBE_URI, ACCEPT);

    expect(result.presence).toBe("absent");
    expect(result.revived).toBe(true);
    expect(state.calls).toBe(2);
    expect(state.connected).toBe(1);
  });

  it("dies twice in a row -> presence: no-answer, revived: true, GET issued exactly twice (one re-issue, not a loop)", async () => {
    const { conn, state } = sequencedConn(sessionDeadOnWire, sessionDeadOnWire);
    const result = await probeObjectPresence(conn, PROBE_URI, ACCEPT);

    expect(result.presence).toBe("no-answer");
    expect(result.revived).toBe(true);
    expect(state.calls).toBe(2);
    expect(state.connected).toBe(1);
  });
});

describe("isSessionDeadFailure — the predicate the reconnect-once path relies on", () => {
  it("true: an ordinary-looking 400 that carries the ICM dead-session header", () => {
    const e = AdtErrorException.create(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { status: 400, statusText: "Bad Request", headers: { "x-sap-icm-err-id": "ICMENOSESSION" }, body: "" } as any,
      {},
    );
    expect(isSessionDeadFailure(e)).toBe(true);
  });

  it("false: an ordinary 400 with no dead-session header — the predicate must not say yes to everything", () => {
    const e = AdtErrorException.create(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { status: 400, statusText: "Bad Request", headers: {}, body: "" } as any,
      {},
    );
    expect(isSessionDeadFailure(e)).toBe(false);
  });

  it("false: an ordinary 404 — not-found is not session-death either", () => {
    const e = AdtErrorException.create(404, {}, "ExceptionResourceNotFound", "Not found");
    expect(isSessionDeadFailure(e)).toBe(false);
  });
});

describe("verifyObjectCreated — the combinator: fallback confirms, but a fallback miss never settles it", () => {
  it("VIT bridge indeterminate, repository search confirmed -> overall confirmed via repository-search", async () => {
    const routes: FakeRoute[] = [
      (r) => (r.url === VIT_URI ? fakeResponse(200, mismatchedStub(EXPECT_TYPE, OBJ_NAME), { "content-type": "application/xml" }) : undefined),
      (r) =>
        r.path === SEARCH_PATH
          ? fakeResponse(
              200,
              searchResultsXml([{ name: OBJ_NAME, type: EXPECT_TYPE, uri: `/sap/bc/adt/ddic/views/${OBJ_NAME}`, packageName: "STRN" }]),
              { "content-type": "application/xml" },
            )
          : undefined,
    ];
    const { conn, server } = await wired({ routes });

    const result = await verifyObjectCreated(conn, { vitType: VIT_TYPE, objectName: OBJ_NAME, expectType: EXPECT_TYPE });

    expect(result.status).toBe("confirmed");
    if (result.status === "confirmed") expect(result.via).toBe("repository-search");
    // Both probes must actually have been consulted — the fallback is not a
    // substitute for the primary, only a rescue when the primary can't decide.
    expect(server.calls.some((c) => c.url === VIT_URI)).toBe(true);
    expect(server.calls.some((c) => c.path === SEARCH_PATH)).toBe(true);
  });

  it("VIT bridge indeterminate, repository search confirmed-absent -> overall indeterminate, not confirmed-absent", async () => {
    const routes: FakeRoute[] = [
      (r) => (r.url === VIT_URI ? fakeResponse(200, mismatchedStub(EXPECT_TYPE, OBJ_NAME), { "content-type": "application/xml" }) : undefined),
      (r) => (r.path === SEARCH_PATH ? fakeResponse(200, searchResultsXml([]), { "content-type": "application/xml" }) : undefined),
    ];
    const { conn } = await wired({ routes });

    const result = await verifyObjectCreated(conn, { vitType: VIT_TYPE, objectName: OBJ_NAME, expectType: EXPECT_TYPE });

    // A zero-hit search is not proof of absence: a live object recorded
    // existing (test/fixtures/vit/003) but was TADIR-unregistered, and a
    // search miss looks identical for that case and for a genuinely-absent
    // one — so this must downgrade to indeterminate, not settle as absent.
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") expect(result.reason).toMatch(/not proof/);
  });

  it("VIT bridge confirmed -> repository search is never consulted at all (primary wins outright, no wasted round trip)", async () => {
    const searchCalled = { count: 0 };
    const routes: FakeRoute[] = [
      (r) => (r.url === VIT_URI ? fakeResponse(200, richStub(EXPECT_TYPE, OBJ_NAME), { "content-type": "application/xml" }) : undefined),
      (r) => {
        if (r.path !== SEARCH_PATH) return undefined;
        searchCalled.count++;
        return fakeResponse(200, searchResultsXml([]), { "content-type": "application/xml" });
      },
    ];
    const { conn } = await wired({ routes });

    const result = await verifyObjectCreated(conn, { vitType: VIT_TYPE, objectName: OBJ_NAME, expectType: EXPECT_TYPE });

    expect(result.status).toBe("confirmed");
    if (result.status === "confirmed") expect(result.via).toBe("vit-bridge");
    expect(searchCalled.count).toBe(0);
  });

  it("both probes indeterminate -> overall indeterminate, with BOTH probes' reasons folded into the message", async () => {
    const ref: FakeObjectRef = { name: OBJ_NAME, type: "TABL/DT", uri: `/sap/bc/adt/ddic/tables/${OBJ_NAME}`, packageName: "STRN" };
    const routes: FakeRoute[] = [
      (r) => (r.url === VIT_URI ? fakeResponse(200, mismatchedStub(EXPECT_TYPE, OBJ_NAME), { "content-type": "application/xml" }) : undefined),
      (r) => (r.path === SEARCH_PATH ? fakeResponse(200, searchResultsXml([ref]), { "content-type": "application/xml" }) : undefined),
    ];
    const { conn } = await wired({ routes });

    const result = await verifyObjectCreated(conn, { vitType: VIT_TYPE, objectName: OBJ_NAME, expectType: EXPECT_TYPE });

    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason).toMatch(/did not echo back/);
      expect(result.reason).toMatch(/none typed/);
    }
  });

  it("VIT bridge confirmed-absent (thin stub), repository search confirmed -> contradiction reported as indeterminate, not resolved either way", async () => {
    const routes: FakeRoute[] = [
      (r) => (r.url === VIT_URI ? fakeResponse(200, sparseStub(EXPECT_TYPE, OBJ_NAME), { "content-type": "application/xml" }) : undefined),
      (r) =>
        r.path === SEARCH_PATH
          ? fakeResponse(
              200,
              searchResultsXml([{ name: OBJ_NAME, type: EXPECT_TYPE, uri: `/sap/bc/adt/ddic/views/${OBJ_NAME}`, packageName: "STRN" }]),
              { "content-type": "application/xml" },
            )
          : undefined,
    ];
    const { conn, server } = await wired({ routes });

    const result = await verifyObjectCreated(conn, { vitType: VIT_TYPE, objectName: OBJ_NAME, expectType: EXPECT_TYPE });

    // A thin stub alone would settle this as confirmed-absent, but the
    // search contradicts it — right after a create, a false confirmed-absent
    // here would wrongly discard a successful write, so the contradiction is
    // reported rather than resolved either way (see verifyObjectCreated's doc).
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") expect(result.reason).toMatch(/contradict each other/);
    expect(server.calls.some((c) => c.url === VIT_URI)).toBe(true);
    expect(server.calls.some((c) => c.path === SEARCH_PATH)).toBe(true);
  });

  it("regression pin: a repository-search miss never resolves verifyObjectCreated as confirmed-absent via: repository-search", async () => {
    const routes: FakeRoute[] = [
      (r) => (r.url === VIT_URI ? fakeResponse(200, FX_ENRICHED_UNREGISTERED_VIEWDV, { "content-type": "application/xml" }) : undefined),
      (r) => (r.path === SEARCH_PATH ? fakeResponse(200, searchResultsXml([]), { "content-type": "application/xml" }) : undefined),
    ];
    const { conn } = await wired({ routes });

    // FX_ENRICHED_UNREGISTERED_VIEWDV is 003's live body (ZTMD_V_442G2),
    // requested here under OBJ_NAME instead so it doesn't echo — VIT primary
    // lands indeterminate, same shape as the rewritten test above, but this
    // one pins the invariant directly instead of one reason string.
    const result = await verifyObjectCreated(conn, { vitType: VIT_TYPE, objectName: OBJ_NAME, expectType: EXPECT_TYPE });

    const resolvedAsSearchAbsent = result.status === "confirmed-absent" && result.via === "repository-search";
    expect(resolvedAsSearchAbsent).toBe(false);
    expect(result.status).toBe("indeterminate");
  });
});

/**
 * The VIT bridge never 404s — a never-created name still answers `200`
 * with a thin name/type-only stub. Pins `vitStubShowsExistence` /
 * `vitStubShowsRegistration` and `verifyViaVitBridge` against all three real
 * shapes, for BOTH bridge types, plus the fixture files that don't fit the
 * type-parametrized matrix (`004`'s post-delete thin stub and `005`'s
 * registered `SE93`). `002`/`003` are byte-verbatim live captures; `001`,
 * `004`, `005` are reconstructions on that now-known real envelope. See
 * `test/fixtures/vit/INDEX.md`.
 */
describe("VIT bridge existence vs. registration", () => {
  const TYPES: readonly { vitType: string; expectType: string }[] = [
    { vitType: "trant", expectType: "TRAN/T" },
    { vitType: "viewdv", expectType: "VIEW/DV" },
  ];

  for (const { vitType, expectType } of TYPES) {
    describe(`${expectType} (vitType "${vitType}")`, () => {
      const NAME = "ZHS450_OBJ";
      const uri = vitBridgeUri(vitType, NAME);

      it("thin stub, echoing name/type -> confirmed-absent via vit-bridge", async () => {
        const route: FakeRoute = (r) =>
          r.url === uri ? fakeResponse(200, sparseStub(expectType, NAME), { "content-type": "application/xml" }) : undefined;
        const { conn } = await wired({ routes: [route] });

        const result = await verifyViaVitBridge(conn, vitType, NAME, expectType);

        expect(result.status).toBe("confirmed-absent");
        if (result.status === "confirmed-absent") expect(result.via).toBe("vit-bridge");
      });

      it("enriched-unregistered stub (changedAt/changedBy/description, no packageRef) -> confirmed — existence does NOT require packageRef", async () => {
        const route: FakeRoute = (r) =>
          r.url === uri ? fakeResponse(200, enrichedUnregisteredStub(expectType, NAME), { "content-type": "application/xml" }) : undefined;
        const { conn } = await wired({ routes: [route] });

        const result = await verifyViaVitBridge(conn, vitType, NAME, expectType);

        expect(result.status).toBe("confirmed");
        if (result.status === "confirmed") expect(result.via).toBe("vit-bridge");
      });

      it("enriched-registered stub (packageRef) -> confirmed", async () => {
        const route: FakeRoute = (r) =>
          r.url === uri ? fakeResponse(200, richStub(expectType, NAME), { "content-type": "application/xml" }) : undefined;
        const { conn } = await wired({ routes: [route] });

        const result = await verifyViaVitBridge(conn, vitType, NAME, expectType);

        expect(result.status).toBe("confirmed");
        if (result.status === "confirmed") expect(result.via).toBe("vit-bridge");
      });
    });
  }

  it("a stub that does not echo the asked-for name/type stays indeterminate even when enriched — the fix must not swallow a mismatched answer", async () => {
    const uri = vitBridgeUri("viewdv", "ZHS450_OBJ");
    const route: FakeRoute = (r) =>
      r.url === uri
        ? fakeResponse(200, enrichedUnregisteredStub("VIEW/DV", "ZHS450_OBJ_WRONG"), { "content-type": "application/xml" })
        : undefined;
    const { conn } = await wired({ routes: [route] });

    const result = await verifyViaVitBridge(conn, "viewdv", "ZHS450_OBJ", "VIEW/DV");

    expect(result.status).toBe("indeterminate");
  });

  describe("the live-measured fixtures themselves (test/fixtures/vit/)", () => {
    it("001 trant + 002 viewdv, thin/never-created -> confirmed-absent", async () => {
      for (const [vitType, expectType, name, body] of [
        ["trant", "TRAN/T", "ZTMD_T442R_NEVER", FX_THIN_TRANT],
        ["viewdv", "VIEW/DV", "ZTMD_V_NEVERXX", FX_THIN_VIEWDV],
      ] as const) {
        const uri = vitBridgeUri(vitType, name);
        const route: FakeRoute = (r) => (r.url === uri ? fakeResponse(200, body, { "content-type": "application/xml" }) : undefined);
        const { conn } = await wired({ routes: [route] });

        const result = await verifyViaVitBridge(conn, vitType, name, expectType);
        expect(result.status).toBe("confirmed-absent");
      }
    });

    it("003 viewdv, EXISTS but TADIR-unregistered -> confirmed", async () => {
      const uri = vitBridgeUri("viewdv", "ZTMD_V_442G2");
      const route: FakeRoute = (r) =>
        r.url === uri ? fakeResponse(200, FX_ENRICHED_UNREGISTERED_VIEWDV, { "content-type": "application/xml" }) : undefined;
      const { conn } = await wired({ routes: [route] });

      const result = await verifyViaVitBridge(conn, "viewdv", "ZTMD_V_442G2", "VIEW/DV");
      expect(result.status).toBe("confirmed");
    });

    it("004 trant, thin after delete -> confirmed-absent", async () => {
      const uri = vitBridgeUri("trant", "ZTMD_T442R");
      const route: FakeRoute = (r) =>
        r.url === uri ? fakeResponse(200, FX_THIN_TRANT_AFTER_DELETE, { "content-type": "application/xml" }) : undefined;
      const { conn } = await wired({ routes: [route] });

      const result = await verifyViaVitBridge(conn, "trant", "ZTMD_T442R", "TRAN/T");
      expect(result.status).toBe("confirmed-absent");
    });

    it("005 trant SE93, EXISTS and registered (packageRef SEUA) -> confirmed", async () => {
      const uri = vitBridgeUri("trant", "SE93");
      const route: FakeRoute = (r) =>
        r.url === uri ? fakeResponse(200, FX_ENRICHED_REGISTERED_TRANT, { "content-type": "application/xml" }) : undefined;
      const { conn } = await wired({ routes: [route] });

      const result = await verifyViaVitBridge(conn, "trant", "SE93", "TRAN/T");
      expect(result.status).toBe("confirmed");
    });
  });

  describe("the two predicates, directly, over the three real shapes", () => {
    it("vitStubShowsExistence: false / true / true (thin, enriched-unregistered, enriched-registered)", () => {
      expect(vitStubShowsExistence(FX_THIN_VIEWDV)).toBe(false);
      expect(vitStubShowsExistence(FX_ENRICHED_UNREGISTERED_VIEWDV)).toBe(true);
      expect(vitStubShowsExistence(FX_ENRICHED_REGISTERED_TRANT)).toBe(true);
    });

    it("vitStubShowsRegistration: false / false / true — row 2 is the whole design decision: an object can exist while unregistered", () => {
      expect(vitStubShowsRegistration(FX_THIN_VIEWDV)).toBe(false);
      expect(vitStubShowsRegistration(FX_ENRICHED_UNREGISTERED_VIEWDV)).toBe(false);
      expect(vitStubShowsRegistration(FX_ENRICHED_REGISTERED_TRANT)).toBe(true);
    });
  });
});
