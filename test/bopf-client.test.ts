/**
 * Acceptance tests for `src/adt/bopf.ts` — the BOPF ADT wire client.
 *
 * Every test below drives the REAL `bopf.ts` functions (no mocking of that
 * module) against a `FakeAdtServer` session, exactly the way
 * `test/connection-death-wire.test.ts` drives `AbapConnection` against one:
 * a real `AbapConnection`, a real `ADTClient` (via `conn.adt`), a real
 * `StatefulSession` (via `conn.withStatefulSession`) — only the HTTP socket
 * is fake. Entirely offline; nothing here contacts A4H.
 *
 * Scope: acceptance-testing the hazard mitigations this client requires —
 * non-atomic create, dangling class refs, activation always answering 200 (so
 * the client must not trust the body alone), DDIC cascade + batching
 * (including the documented "table types not swept" gap), the DDIC
 * `Accept: *\/*` trap, re-lock-after-failure, and the two local-package
 * enforcement points.
 *
 * WHAT IS REAL AND WHAT IS RECONSTRUCTED, per test — read each test's own
 * comment. Model documents come from `test/fixtures/bopf/*.xml` (real
 * captures) wherever the scenario allows it; response envelopes bopf.ts's
 * own doc comments already flag as unverified live (the activation-failure
 * body, the `$search` result shape) are hand-built and marked as such.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FakeAdtServer,
  __resetFakeAdtCounters,
  fakeResponse,
  bopfStore,
  bopfLockTransportRoute,
  classSourceRoute,
  ddicProbeRoute,
  activationRoute,
  activationFailureXml,
  BOPF_COLLECTION_PATH,
  BOPF_ACCEPT_V4,
  BOPF_LOCK_ACCEPT,
  type FakeRoute,
} from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import { parseModel } from "../src/adt/bopf-xml.js";
import { SafetyGate } from "../src/safety.js";
import {
  bopfUri,
  readModel,
  createBusinessObject,
  putModel,
  activateBusinessObject,
  deleteBusinessObject,
  searchBusinessObjects,
  checkReferences,
  collectRefSites,
  DEFAULT_CHECK_REFS_MAX_SITES,
  effectiveRootNodeName,
} from "../src/adt/bopf.js";

// ------------------------------------------------------------------ safety gate ---

/**
 * Every mutating `bopf.ts` function now requires an `AuthorizedTarget` minted
 * by a real `SafetyGate` (Layer 2) — this file drives the
 * REAL `bopf.ts` functions, so it must mint real tokens, exactly the pattern
 * `test/bopf-tools.test.ts` already established (`openGate`/`closedGate`).
 */
const openGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowTransportRelease: true,
    // Without this, `deleteBusinessObject`'s new
    // `allowCascadeDelete` ceiling (src/adt/bopf.ts) fails closed and every
    // `cascadeDdic: true` test in this file refuses before even reading the
    // model — this gate is meant to be "wide open", so it needs the ceiling
    // too, same as it already carries `allowTransportRelease: true`.
    allowCascadeDelete: true,
  });

/** Mints a fresh `AuthorizedTarget<"write">` from a fresh open gate — package defaults to `$TMP` to match this file's fixtures. */
const authWrite = (name: string, packageName = "$TMP") =>
  openGate().authorize("write", { name, packageName, type: "BOBF" });

/** Mints a fresh `AuthorizedTarget<"delete">` AND returns the gate it came from, since `deleteBusinessObject` needs both — the parent-BO token as proof the top-level check ran, and the live gate to authorize each dynamically-discovered DDIC cascade candidate individually. */
function mintDelete(name: string, packageName = "$TMP"): { authorized: ReturnType<SafetyGate["authorize"]>; gate: SafetyGate } {
  const gate = openGate();
  return { authorized: gate.authorize("delete", { name, packageName, type: "BOBF" }), gate };
}

// --------------------------------------------------------------------- fixtures ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const fixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

/** ZBOPF_MC5, active, real dangling class refs (ZCL_BOPF_NOPE_ACT/DET/VAL). */
const FX_ACTIVE_DANGLING = fixture("10-model-coverage-final.v4.xml");
/** ZBOPF_PRB1, inactive, root-node-only — the just-created shape. */
const FX_JUST_CREATED = fixture("02-created-zbopf_prb1-root-only.v4.xml");

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

const listenerCounts = (): Record<string, number> => ({
  SIGINT: process.listenerCount("SIGINT"),
  SIGTERM: process.listenerCount("SIGTERM"),
  beforeExit: process.listenerCount("beforeExit"),
});

let listenersBefore = listenerCounts();

beforeEach(() => {
  __resetFakeAdtCounters();
  listenersBefore = listenerCounts();
});

afterEach(() => {
  for (const conn of openConnections.splice(0)) conn.dispose();
  expect(listenerCounts()).toEqual(listenersBefore);
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

/** Every request past `connect()`'s own login/probe traffic. */
function callsAfterConnect(server: FakeAdtServer): number {
  return server.calls.length;
}

// -------------------------------------------------------- SessionTransport fakes ---

/**
 * Reusable `TrRequirement` fake, matching the exact injection idiom already
 * proven in `test/write-package.test.ts` (`fakeReq`/`pinnedTo`) — avoids
 * hand-deriving every field `src/adt/transports.ts`'s real `trRequirement`
 * would compute.
 */
const fakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({
    kind: "transport",
    required: true,
    mustSupplyCorrNr: true,
    serverWouldFabricate: false,
    ...overrides,
  }) as unknown as TrRequirement;

/** A `$TMP`-shaped local package: `trRequirement` reports `kind: "local"`, so `resolve()` is a no-HTTP `not-needed`. */
const localTransport = (): SessionTransport =>
  new SessionTransport({
    allowTransports: ["auto"],
    cts: { trRequirement: vi.fn(async () => fakeReq({ kind: "local" })) },
  });

/** A transportable package server-pinned to `trkorr` — `resolve()` grants `outcome: "transport"`. Same idiom as `write-package.test.ts`'s `pinnedTo`. */
const pinnedTransport = (trkorr: string): SessionTransport =>
  new SessionTransport({
    allowTransports: [trkorr],
    cts: { trRequirement: vi.fn(async () => fakeReq({ pinnedTo: trkorr })) },
  });

// ===========================================================================

describe("wire shapes: Accept headers and query params", () => {
  it("GET uses BOPF_ACCEPT_V4", async () => {
    const store = bopfStore({ zbopf_mc5: FX_ACTIVE_DANGLING });
    const { conn, server } = await wired({ routes: [store.route] });

    await readModel(conn, "ZBOPF_MC5");

    const gets = server.callsFor((r) => r.method === "GET" && r.path === bopfUri("ZBOPF_MC5"));
    expect(gets).toHaveLength(1);
    expect(gets[0]?.headers["accept"]).toBe(BOPF_ACCEPT_V4);
  });

  it("LOCK uses BOPF_LOCK_ACCEPT (capital-R Result) and DELETE carries lockHandle as a query param", async () => {
    const store = bopfStore({ zbopf_mc5: FX_ACTIVE_DANGLING });
    const { conn, server } = await wired({ routes: [store.route] });

    await conn.withStatefulSession(async (session) => {
      const { authorized, gate } = mintDelete("ZBOPF_MC5");
      await deleteBusinessObject(conn, session, "ZBOPF_MC5", authorized, gate);
    });

    const locks = server.callsFor((r) => r.method === "POST" && r.qs["_action"] === "LOCK" && r.path === bopfUri("ZBOPF_MC5"));
    expect(locks).toHaveLength(1);
    expect(locks[0]?.headers["accept"]).toBe(BOPF_LOCK_ACCEPT);

    const dels = server.callsFor((r) => r.method === "DELETE" && r.path === bopfUri("ZBOPF_MC5"));
    expect(dels).toHaveLength(1);
    expect(typeof dels[0]?.qs["lockHandle"]).toBe("string");
    expect(dels[0]?.qs["lockHandle"]).not.toBe("");
    expect(store.has("zbopf_mc5")).toBe(false);
  });

  it("PUT and POST-create use BOPF_ACCEPT_V4 for both Content-Type and Accept", async () => {
    const store = bopfStore();
    const { conn, server } = await wired({ routes: [store.route] });

    await createBusinessObject(conn, localTransport(), { name: "ZBOPF_NEW1", packageName: "$TMP" }, authWrite("ZBOPF_NEW1"));
    const creates = server.callsFor((r) => r.method === "POST" && r.path === BOPF_COLLECTION_PATH);
    expect(creates).toHaveLength(1);
    expect(creates[0]?.headers["accept"]).toBe(BOPF_ACCEPT_V4);
    expect(creates[0]?.headers["content-type"]).toBe(BOPF_ACCEPT_V4);

    await conn.withStatefulSession(async (session) => {
      await putModel(conn, session, "ZBOPF_NEW1", (xml) => xml, authWrite("ZBOPF_NEW1"));
    });
    const puts = server.callsFor((r) => r.method === "PUT" && r.path === bopfUri("ZBOPF_NEW1"));
    expect(puts).toHaveLength(1);
    expect(puts[0]?.headers["accept"]).toBe(BOPF_ACCEPT_V4);
    expect(puts[0]?.headers["content-type"]).toBe(BOPF_ACCEPT_V4);
  });

  /**
   * `effectiveRootNodeName` is `buildCreateBody`'s single source of truth
   * for "what root name did this create actually ask for" — a
   * verifier elsewhere (`tools/bopf.ts`'s `createBoRootNodeNotes`) calls the
   * same function independently and must never be able to drift from what
   * went on the wire. Asserted here against the REAL wire body, not just
   * the function's return value, so a future edit that changes one without
   * the other is caught.
   */
  it("effectiveRootNodeName and buildCreateBody agree: a blank or omitted rootNodeName both default to ROOT on the wire", async () => {
    expect(effectiveRootNodeName({ name: "X", packageName: "$TMP", rootNodeName: "   " })).toBe("ROOT");
    expect(effectiveRootNodeName({ name: "X", packageName: "$TMP" })).toBe("ROOT");

    const store = bopfStore();
    const { conn, server } = await wired({ routes: [store.route] });

    await createBusinessObject(
      conn,
      localTransport(),
      { name: "ZBOPF_NEW2", packageName: "$TMP", rootNodeName: "   " },
      authWrite("ZBOPF_NEW2"),
    );
    await createBusinessObject(
      conn,
      localTransport(),
      { name: "ZBOPF_NEW3", packageName: "$TMP" },
      authWrite("ZBOPF_NEW3"),
    );

    const creates = server.callsFor((r) => r.method === "POST" && r.path === BOPF_COLLECTION_PATH);
    expect(creates).toHaveLength(2);
    for (const create of creates) {
      expect(create.body).toContain('bo:name="ROOT"');
    }
  });
});

// ===========================================================================

/**
 * `bopfUri()` interpolated a namespace-prefixed BO name
 * (`/BOBF/DEMO_SALES_ORDER` and every other leading-slash SAP-standard or
 * partner-namespace BOPF business object) RAW, producing a path with a
 * literal unencoded `/` inside the name segment
 * (`/sap/bc/adt/bopf/businessobjects//bobf/demo_sales_order`, note the
 * double slash) instead of `%2F`-encoding the namespace slash the way live
 * probes already do
 * (`/sap/bc/adt/bopf/businessobjects/%2Fbobf%2Fdemo_sales_order`). Live
 * reproduction against A4H 2026-08-08 confirmed the broken path 404s
 * (`ExceptionResourceNotFound`) while the `%2F`-encoded one 200s with the
 * real BO model. Customer `Z*`/`Y*` names never contain `/`, which is why
 * this stayed green offline indefinitely — no test anywhere in this suite
 * used a namespace-prefixed name before this.
 */
describe("namespace-prefixed BO names", () => {
  it("bopfUri %2F-encodes every namespace slash instead of emitting it raw", () => {
    expect(bopfUri("/BOBF/DEMO_SALES_ORDER")).toBe(`${BOPF_COLLECTION_PATH}/%2Fbobf%2Fdemo_sales_order`);
    // A partner namespace (not just /BOBF/) must be encoded the same way — this is not a hardcoded /BOBF/ special-case.
    expect(bopfUri("/PARTNER/SOME_BO")).toBe(`${BOPF_COLLECTION_PATH}/%2Fpartner%2Fsome_bo`);
    // Customer Z*/Y* names (no namespace slash) are unaffected — no gratuitous re-encoding of an already-safe segment.
    expect(bopfUri("ZBOPF_MC5")).toBe(`${BOPF_COLLECTION_PATH}/zbopf_mc5`);
  });

  it("readModel reaches a namespace-prefixed BO instead of 404ing on the old double-slash path", async () => {
    // The store is keyed on exactly what bopfUri() now sends — %2F-encoded, lowercased.
    const nsKey = encodeURIComponent("/bobf/demo_sales_order");
    const store = bopfStore({ [nsKey]: FX_ACTIVE_DANGLING });
    const { conn, server } = await wired({ routes: [store.route] });

    const result = await readModel(conn, "/BOBF/DEMO_SALES_ORDER");
    expect(result.model).toBeDefined();

    const gets = server.callsFor((r) => r.method === "GET" && r.path === bopfUri("/BOBF/DEMO_SALES_ORDER"));
    expect(gets).toHaveLength(1);
    expect(gets[0]?.path).toBe(`${BOPF_COLLECTION_PATH}/%2Fbobf%2Fdemo_sales_order`);

    // The literal broken double-slash path the old bopfUri() produced must never be sent.
    expect(server.calls.some((r) => r.path === `${BOPF_COLLECTION_PATH}//bobf/demo_sales_order`)).toBe(false);
  });

  it("readModel 404s (NOT_FOUND) for a namespace-prefixed BO that genuinely does not exist — the correctly-encoded path still distinguishes missing from unreachable", async () => {
    const store = bopfStore(); // empty — nothing seeded under any key
    const { conn } = await wired({ routes: [store.route] });

    await expect(readModel(conn, "/BOBF/ZZZNOPE")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("non-atomic create", () => {
  it("recovers when the create landed server-side but the response was lost", async () => {
    // Real captured bytes for "just after create" (fixture 02) pre-seeded —
    // this models the create having genuinely happened server-side, with
    // the injected failure only ever touching the RESPONSE.
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    store.failNextCreates(1);
    const { conn } = await wired({ routes: [store.route] });

    const result = await createBusinessObject(
      conn,
      localTransport(),
      {
        name: "ZBOPF_PRB1",
        packageName: "$TMP",
      },
      authWrite("ZBOPF_PRB1"),
    );

    expect(result.recovered).toBe(true);
    expect(result.model.name).toBe("ZBOPF_PRB1");
    expect(result.model.version).toBe("inactive");
  });

  it("rethrows the ORIGINAL error when the create genuinely did not land (recovery GET also fails)", async () => {
    const store = bopfStore();
    store.failNextCreates(1, { landed: false });
    const { conn } = await wired({ routes: [store.route] });

    await expect(
      createBusinessObject(conn, localTransport(), { name: "ZBOPF_GONE", packageName: "$TMP" }, authWrite("ZBOPF_GONE")),
    ).rejects.toSatisfy((e: unknown) => isAbapError(e));
    expect(store.has("zbopf_gone")).toBe(false);
  });
});

// ===========================================================================

describe("activation always answers 200; verdict is AND of body and re-read version", () => {
  it("activated: true only when BOTH the activation body succeeds AND the re-read model.version is active", async () => {
    const store = bopfStore({ zbopf_mc5: FX_ACTIVE_DANGLING });
    const { conn } = await wired({
      routes: [store.route, activationRoute({ uri: bopfUri("ZBOPF_MC5") })],
    });

    const outcome = await activateBusinessObject(conn, "ZBOPF_MC5");
    expect(outcome.activated).toBe(true);
    expect(outcome.version).toBe("active");
  });

  it("activated: false when the body reports success but the re-read model is still inactive (the classic activation lie)", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({
      routes: [store.route, activationRoute({ uri: bopfUri("ZBOPF_PRB1") })],
    });

    const outcome = await activateBusinessObject(conn, "ZBOPF_PRB1");
    expect(outcome.activated).toBe(false);
    expect(outcome.version).toBe("inactive");
  });

  it("activated: false when the body reports a hard failure, even if the re-read model somehow shows active", async () => {
    // RECONSTRUCTED: no captured chkl:messages-with-type=E body exists in this
    // repo's fixtures (see activationFailureXml's doc comment) — this exercises
    // the AND-logic's other side, deliberately contradicting the two signals to
    // prove neither one is trusted alone.
    const store = bopfStore({ zbopf_mc5: FX_ACTIVE_DANGLING });
    const { conn } = await wired({
      routes: [
        store.route,
        activationRoute({ uri: bopfUri("ZBOPF_MC5"), body: activationFailureXml({ uri: bopfUri("ZBOPF_MC5") }) }),
      ],
    });

    const outcome = await activateBusinessObject(conn, "ZBOPF_MC5");
    expect(outcome.activated).toBe(false);
    expect(outcome.messages.length).toBeGreaterThan(0);
  });
});

// ===========================================================================

describe("dangling class refs found via SOURCE GET, not object-URI GET", () => {
  it("distinguishes a real class (source has IMPLEMENTATION) from three genuinely dangling ones, using the real captured fixture's own dangling refs", async () => {
    const model = parseModel(FX_ACTIVE_DANGLING);

    // The framework class every LOCK_ROOT action references — real and
    // implemented. A minimal but real-shaped ABAP OO source with an
    // IMPLEMENTATION section (reconstructed body; the class itself is real).
    // `LOCK_ROOT` is owned by an `action` element, so `checkReferences`
    // additionally requires the source to mention `/BOBF/IF_FRW_ACTION`
    // (`IMPL_INTERFACE_BY_OWNER.action` in bopf.ts) or the verdict downgrades
    // to `"wrong-interface"` — the `INTERFACES` line below is what keeps this
    // a clean `"present"`, matching what the real framework class actually
    // implements.
    // bopf.ts's substring check is case-sensitive against the literal
    // "/BOBF/IF_FRW_ACTION" (IMPL_INTERFACE_BY_OWNER.action) — matching real
    // ABAP pretty-printer convention of upper-casing framework type names.
    const realClassSource =
      `CLASS /bobf/cl_lib_a_lock DEFINITION PUBLIC.\n` +
      `  PUBLIC SECTION.\n    INTERFACES /BOBF/IF_FRW_ACTION.\nENDCLASS.\n` +
      `CLASS /bobf/cl_lib_a_lock IMPLEMENTATION.\nENDCLASS.`;

    // Any DDIC ref this model touches — answered generically as "present" so
    // the test stays scoped to the CLASS-ref hazard;
    // the DDIC side of checkReferences is covered by its own dedicated path
    // in `evaluateDdicRef`, not re-derived here.
    const ddicCatchAll: FakeRoute = (r) => {
      const accept = String(r.headers["accept"] ?? "");
      if (r.method === "GET" && accept === "*/*") {
        return fakeResponse(200, `<tabl:table xmlns:tabl="http://www.sap.com/wbobj/tables"/>`, {
          "content-type": "application/xml",
        });
      }
      return undefined;
    };

    const { conn } = await wired({
      routes: [
        classSourceRoute({ name: "/BOBF/CL_LIB_A_LOCK", body: realClassSource }),
        classSourceRoute({ name: "ZCL_BOPF_NOPE_ACT", body: undefined }),
        classSourceRoute({ name: "ZCL_BOPF_NOPE_DET", body: undefined }),
        classSourceRoute({ name: "ZCL_BOPF_NOPE_VAL", body: undefined }),
      ],
      catchAll: ddicCatchAll,
    });

    const findings = await checkReferences(conn, model);

    const byName = (name: string) => findings.find((f) => f.site.ref.name === name);
    expect(byName("/BOBF/CL_LIB_A_LOCK")?.verdict).toBe("present");
    expect(byName("ZCL_BOPF_NOPE_ACT")?.verdict).toBe("missing");
    expect(byName("ZCL_BOPF_NOPE_DET")?.verdict).toBe("missing");
    expect(byName("ZCL_BOPF_NOPE_VAL")?.verdict).toBe("missing");

    // checkReferences never throws — every site got a verdict.
    expect(findings.every((f) => f.verdict !== undefined)).toBe(true);
  });

  it("never throws — a class whose source GET fails with something other than 404 degrades to unchecked", async () => {
    const model = parseModel(FX_ACTIVE_DANGLING);
    // No routes at all for any class or DDIC uri: every probe is unrouted,
    // which the fake raises as a genuine thrown error (not a 404) — proving
    // checkReferences degrades rather than propagates.
    const { conn } = await wired({ routes: [] });

    const findings = await checkReferences(conn, model);
    expect(findings.length).toBeGreaterThan(0);

    // `evaluateTargetNodeRef` (bopf.ts) strips the composite
    // "<BO-NAME>~<NODE-NAME>" wire shape (confirmed in fixture 10, e.g.
    // `"ZBOPF_MC5~ITEM"`, `"ZBOPF_MC5~ROOT"`) before comparing against
    // `n.name` (bare, e.g. `"ITEM"`/`"ROOT"`). Every association's target
    // node in this fixture genuinely exists in the same model — only the
    // CLASS refs are dangling — so every targetNodeRef finding is "present",
    // purely a local string comparison with no HTTP involved (confirmed by
    // it resolving correctly here with zero routes wired).
    const targetNodeFindings = findings.filter((f) => f.site.element === "targetNodeRef");
    expect(targetNodeFindings.length).toBeGreaterThan(0);
    expect(targetNodeFindings.every((f) => f.verdict === "present")).toBe(true);

    // Every non-targetNodeRef site (class refs and DDIC refs) genuinely needs
    // HTTP, every probe here is unrouted (not a 404), and checkReferences's
    // invariant is that it degrades rather than propagates — so all of
    // them come back "unchecked", never a thrown error.
    const httpFindings = findings.filter((f) => f.site.element !== "targetNodeRef");
    expect(httpFindings.length).toBeGreaterThan(0);
    expect(httpFindings.every((f) => f.verdict === "unchecked")).toBe(true);
  });

  it("ARCH-09 P7: maxSites caps how many reference sites are probed, never silently — findings.length tracks the cap, not the model's true site count", async () => {
    const model = parseModel(FX_ACTIVE_DANGLING);
    const totalSites = collectRefSites(model).length;
    expect(totalSites).toBeGreaterThan(2);
    const { conn } = await wired({ routes: [] });

    const findings = await checkReferences(conn, model, { maxSites: 2 });
    expect(findings.length).toBe(2);
  });

  it("ARCH-09 P7: default maxSites is DEFAULT_CHECK_REFS_MAX_SITES when no option is passed", async () => {
    const model = parseModel(FX_ACTIVE_DANGLING);
    const totalSites = collectRefSites(model).length;
    const { conn } = await wired({ routes: [] });

    const findings = await checkReferences(conn, model);
    expect(findings.length).toBe(Math.min(totalSites, DEFAULT_CHECK_REFS_MAX_SITES));
  });

  // The cap also reaches `abap_bopf_test`'s H2 pre-flight, whose whole claim is
  // that a dangling reference "cannot be ruled out" when the check is missing.
  // A partial check presented as a complete one is the same lie in a quieter voice.
  it("ARCH-09 P7: abap_bopf_test discloses the sites the cap skipped rather than implying a complete check", async () => {
    const { formatSkippedRefsNote } = await import("../src/tools/bopf-test.js");
    const note = formatSkippedRefsNote(25, 15);

    expect(note).toContain("stopped after 25 reference site(s)");
    expect(note).toContain("15 more were never probed");
    expect(note).toContain("not ruled out");
    // It must never read as a clean bill of health for the sites it skipped.
    expect(note).not.toMatch(/\bclean\b|\ball (?:refs|references) (?:are )?(?:ok|present)\b/i);
  });
});

// ===========================================================================

describe("re-lock-after-failure — putModel via withRelockRetry", () => {
  it("re-locks, re-reads and rebuilds from FRESH bytes after a first PUT fails, and the second PUT succeeds", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    store.failNextPuts(1);
    const { conn, server } = await wired({ routes: [store.route] });

    const rebuild = vi.fn((fresh: string) => fresh);

    const result = await conn.withStatefulSession(async (session) => {
      return await putModel(conn, session, "ZBOPF_PRB1", rebuild, authWrite("ZBOPF_PRB1"));
    });

    // reread -> rebuild -> attempt ran twice: once for the failed attempt,
    // once for the retry (relock.ts's module contract: never reuse a payload
    // built from pre-failure bytes).
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(result.model.name).toBe("ZBOPF_PRB1");

    const locks = server.callsFor((r) => r.method === "POST" && r.qs["_action"] === "LOCK" && r.path === bopfUri("ZBOPF_PRB1"));
    expect(locks).toHaveLength(2);

    const puts = server.callsFor((r) => r.method === "PUT" && r.path === bopfUri("ZBOPF_PRB1"));
    expect(puts).toHaveLength(2);
    // Two DIFFERENT lock handles were used — never a stale handle reused.
    expect(puts[0]?.qs["lockHandle"]).not.toBe(puts[1]?.qs["lockHandle"]);
  });

  it("exhausts retries and surfaces the last error, annotated with attempts, when EVERY PUT fails", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    store.failNextPuts(99); // more than maxAttempts (default 2) will ever consume
    const { conn, server } = await wired({ routes: [store.route] });

    const err = await conn
      .withStatefulSession(async (session) => putModel(conn, session, "ZBOPF_PRB1", (xml) => xml, authWrite("ZBOPF_PRB1")))
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(isAbapError(err)).toBe(true);
    const abapErr = err as AbapError;
    expect(abapErr.details).toMatchObject({ attempts: 2 });

    const puts = server.callsFor((r) => r.method === "PUT" && r.path === bopfUri("ZBOPF_PRB1"));
    expect(puts).toHaveLength(2);
  });
});

// ===========================================================================

describe("delete cascade + batching", () => {
  it("without cascadeDdic: deletes only the BO itself, no DDIC probes at all", async () => {
    const store = bopfStore({ zbopf_mc5: FX_ACTIVE_DANGLING });
    const { conn, server } = await wired({ routes: [store.route] });

    const before = callsAfterConnect(server);
    const result = await conn.withStatefulSession(async (session) => {
      const { authorized, gate } = mintDelete("ZBOPF_MC5");
      return await deleteBusinessObject(conn, session, "ZBOPF_MC5", authorized, gate);
    });

    expect(result.boDeleted).toBe(true);
    expect(result.ddic).toEqual([]);
    // Every request past `before` must be for the BO itself (LOCK/DELETE),
    // never a DDIC uri.
    const after = server.calls.slice(before);
    expect(after.every((r) => r.path === bopfUri("ZBOPF_MC5"))).toBe(true);
  });

  it("cascadeDdic:true without the allowCascadeDelete ceiling refuses the WHOLE delete — BO included, no HTTP call at all", async () => {
    // A gate that is otherwise wide open for writes/deletes (readOnly:
    // false, allowPackages: ["*"]) but does NOT carry allowCascadeDelete —
    // e.g. what `ABAP_MODE=edit` resolves to. Before this ceiling existed,
    // this exact gate shape let a cascading DDIC delete through under
    // `edit` mode with no admin-only distinction at all.
    const noCascadeGate = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
    const authorized = noCascadeGate.authorize("delete", {
      name: "ZBOPF_MC5",
      packageName: "$TMP",
      type: "BOBF",
    });
    const store = bopfStore({ zbopf_mc5: FX_ACTIVE_DANGLING });
    const { conn, server } = await wired({ routes: [store.route] });

    const before = callsAfterConnect(server);
    await expect(
      conn.withStatefulSession(async (session) =>
        deleteBusinessObject(conn, session, "ZBOPF_MC5", authorized, noCascadeGate, {
          cascadeDdic: true,
        }),
      ),
    ).rejects.toMatchObject({ code: "SAFETY_DENIED" });

    // Refused before the BO's own lock/delete is ever attempted — not a
    // downgrade to "delete the BO but skip the cascade". Zero HTTP calls.
    const after = server.calls.slice(before);
    expect(after).toEqual([]);
  });

  it("cascadeDdic:false (the default) is entirely unaffected by a missing allowCascadeDelete ceiling", async () => {
    const noCascadeGate = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
    const authorized = noCascadeGate.authorize("delete", {
      name: "ZBOPF_MC5",
      packageName: "$TMP",
      type: "BOBF",
    });
    const store = bopfStore({ zbopf_mc5: FX_ACTIVE_DANGLING });
    const { conn } = await wired({ routes: [store.route] });

    const result = await conn.withStatefulSession(async (session) =>
      deleteBusinessObject(conn, session, "ZBOPF_MC5", authorized, noCascadeGate),
    );
    expect(result.boDeleted).toBe(true);
    expect(result.ddic).toEqual([]);
  });

  it("with cascadeDdic on the real active fixture: only the 5 GENERATED candidates are processed, in table -> structure -> constants-interface order; the 4 REFERENCED ones are spared and never probed (see also bopf-cascade-provenance.test.ts)", async () => {
    // Fixture 10 carries 9 DDIC refs; 5 are this BO's own generated objects,
    // the other 4 (incl. two genuinely SAP-owned demo structures) arrive via
    // persistentStructureRef/persistentTableRef and are never cascaded.
    const store = bopfStore({ zbopf_mc5: FX_ACTIVE_DANGLING });
    const ddicRoutes = [
      "/sap/bc/adt/ddic/tabletypes/zbopf_t_root6",
      "/sap/bc/adt/ddic/tabletypes/zbopf_mc5_t_item",
      "/sap/bc/adt/ddic/structures/zbopf_s_root6",
      "/sap/bc/adt/ddic/structures/zbopf_mc5_s_item",
      "/sap/bc/adt/oo/interfaces/zif_bopf_mc5_c",
    ].map((uri) => ddicProbeRoute({ uri, exists: true }));
    const { conn, server } = await wired({ routes: [store.route, ...ddicRoutes] });

    const result = await conn.withStatefulSession(async (session) => {
      const { authorized, gate } = mintDelete("ZBOPF_MC5");
      return await deleteBusinessObject(conn, session, "ZBOPF_MC5", authorized, gate, { cascadeDdic: true });
    });

    expect(result.boDeleted).toBe(true);
    expect(result.ddic).toHaveLength(5);
    expect(result.ddic.every((d) => d.existed && d.deleted)).toBe(true);
    // Every attempted candidate is customer-namespace (Z*) — the two
    // SAP-owned structures never reach `ddic` at all now.
    expect(result.ddic.every((d) => !d.name.startsWith("/"))).toBe(true);

    const kinds = result.ddic.map((d) => d.kind);
    const lastTable = kinds.lastIndexOf("table");
    const firstStructure = kinds.indexOf("structure");
    const firstConstants = kinds.indexOf("constants-interface");
    expect(lastTable).toBeLessThan(firstStructure);
    expect(firstStructure).toBeLessThan(firstConstants);
    expect(kinds.filter((k) => k === "table")).toHaveLength(2);
    expect(kinds.filter((k) => k === "structure")).toHaveLength(2);
    expect(kinds.filter((k) => k === "constants-interface")).toHaveLength(1);

    // The 4 referenced (spared) candidates: 2 SAP-owned persistentStructureRef,
    // 2 customer-namespace persistentTableRef.
    expect(result.ddicSpared).toHaveLength(4);
    const sparedNames = result.ddicSpared.map((d) => d.name).sort();
    expect(sparedNames).toEqual(
      ["/BOBF/S_DEMO_SALES_ORDER_HDR", "/BOBF/S_DEMO_SALES_ORDER_ITM", "ZBOPF_D_ROOT6", "ZBOPF_MC5_D_ITEM"].sort(),
    );
    expect(
      result.ddicSpared
        .filter((d) => d.name.startsWith("/"))
        .every(
          (d) =>
            d.reason ===
            "referenced via persistentStructureRef — the model does not record whether this BO generated it, so it is not deleted",
        ),
    ).toBe(true);
    expect(
      result.ddicSpared
        .filter((d) => !d.name.startsWith("/"))
        .every(
          (d) =>
            d.reason ===
            "referenced via persistentTableRef — the model does not record whether this BO generated it, so it is not deleted",
        ),
    ).toBe(true);

    // No wire call at all was ever made for a spared candidate's guessed
    // URI — sparing happens before any probe, not after a failed one.
    const sparedProbes = server.callsFor(
      (r) =>
        r.path.includes("s_demo_sales_order") || r.path === "/sap/bc/adt/ddic/tables/zbopf_d_root6" || r.path === "/sap/bc/adt/ddic/tables/zbopf_mc5_d_item",
    );
    expect(sparedProbes).toEqual([]);

    // Every DDIC probe used the literal `*/*` Accept — `ddicProbeRoute`
    // itself only answers that Accept, so a passing assertion above already
    // proves it; this repeats the check directly against the raw calls too.
    const probes = server.callsFor((r) => r.method === "GET" && ddicRoutes.length > 0 && r.path.startsWith("/sap/bc/adt/ddic/"));
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((r) => r.headers["accept"] === "*/*")).toBe(true);
  });

  it("a table-type ref with no uri is guessed into the TABLETYPES collection, not TABLES, and is found and swept; the plain table (persistentTableRef) is guessed the same way but spared, not swept", async () => {
    // Fixture 02: combinedTableRef ZBOPF_T_ROOT (TTYP/DA) has no `uri`
    // attribute — real captured shape. ZBOPF_D_ROOT (persistentTableRef) is
    // guessed the same way but lands in `ddicSpared`, never probed.
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({
      routes: [
        store.route,
        // The correct collection for a table type:
        ddicProbeRoute({ uri: "/sap/bc/adt/ddic/tabletypes/zbopf_t_root", exists: true }),
        // The wrong (pre-fix) collection: nothing lives there, and the client
        // must never even probe it now.
        ddicProbeRoute({ uri: "/sap/bc/adt/ddic/tables/zbopf_t_root", exists: false }),
        ddicProbeRoute({ uri: "/sap/bc/adt/oo/interfaces/zif_bopf_prb1_c", exists: true }),
      ],
    });

    const result = await conn.withStatefulSession(async (session) => {
      const { authorized, gate } = mintDelete("ZBOPF_PRB1");
      return await deleteBusinessObject(conn, session, "ZBOPF_PRB1", authorized, gate, { cascadeDdic: true });
    });

    const tableType = result.ddic.find((d) => d.name === "ZBOPF_T_ROOT");
    expect(tableType?.uri).toBe("/sap/bc/adt/ddic/tabletypes/zbopf_t_root");
    expect(tableType?.existed).toBe(true);
    expect(tableType?.deleted).toBe(true);

    // The genuine plain table is spared, not swept, and reported with its
    // guessed URI so a caller can still see exactly what was excluded:
    expect(result.ddic.find((d) => d.name === "ZBOPF_D_ROOT")).toBeUndefined();
    const table = result.ddicSpared.find((d) => d.name === "ZBOPF_D_ROOT");
    expect(table?.uri).toBe("/sap/bc/adt/ddic/tables/zbopf_d_root");
    expect(table?.reason).toBe(
      "referenced via persistentTableRef — the model does not record whether this BO generated it, so it is not deleted",
    );

    // Never probed at all — sparing happens before any wire call.
    const tableProbes = server.callsFor((r) => r.path === "/sap/bc/adt/ddic/tables/zbopf_d_root");
    expect(tableProbes).toEqual([]);
  });

  it("a GENERATED candidate the cascade does attempt is still refused by a live SafetyGate denial, not silently deleted", async () => {
    // allowNamePrefixes covers the BO's own name but not its generated DDIC
    // candidates, so the parent-level authorize (minted below) passes while
    // the per-candidate authorize() inside the cascade loop genuinely fails —
    // exercises the src/adt/bopf.ts:731 catch block, which the referenced/
    // generated split left untested (it previously only fired for the
    // SAP-namespace structures that are now spared before authorization is
    // ever attempted).
    const restricted = new SafetyGate({
      readOnly: false,
      allowPackages: ["*"],
      allowCascadeDelete: true,
      allowNamePrefixes: ["ZBOPF_PRB1"],
    });
    const authorized = restricted.authorize("delete", { name: "ZBOPF_PRB1", packageName: "$TMP", type: "BOBF" });
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });

    const before = callsAfterConnect(server);
    const result = await conn.withStatefulSession(async (session) =>
      deleteBusinessObject(conn, session, "ZBOPF_PRB1", authorized, restricted, { cascadeDdic: true }),
    );

    expect(result.boDeleted).toBe(true);
    expect(result.ddic).toHaveLength(3);
    expect(result.ddic.every((d) => d.existed === false && d.deleted === false)).toBe(true);
    expect(result.ddic.every((d) => d.reason?.includes("safety gate denied"))).toBe(true);

    // Denied before any existence probe or delete is even attempted.
    const after = server.calls.slice(before);
    expect(after.some((r) => r.path.startsWith("/sap/bc/adt/ddic/"))).toBe(false);
  });
});

// ===========================================================================

describe("local package refusal at both enforcement points", () => {
  it("createBusinessObject refuses PRE-lock via SessionTransport.resolve — no HTTP call at all", async () => {
    const store = bopfStore();
    const { conn, server } = await wired({ routes: [store.route] });
    const before = callsAfterConnect(server);

    const err = await createBusinessObject(
      conn,
      pinnedTransport("A4HK900123"),
      {
        name: "ZBOPF_TR1",
        packageName: "ZTRANSPORTABLE",
      },
      authWrite("ZBOPF_TR1", "ZTRANSPORTABLE"),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(isAbapError(err)).toBe(true);
    expect((err as AbapError).code).toBe("UNSUPPORTED");
    expect((err as AbapError).details).toMatchObject({ corrNr: "A4HK900123" });
    // No POST landed — the refusal happened before any wire call.
    expect(server.calls.slice(before).some((r) => r.method === "POST" && r.path === BOPF_COLLECTION_PATH)).toBe(false);
  });

  it("putModel refuses POST-lock via transportFromLock on every retry's fresh lock — and burns two lock/unlock round trips before surfacing UNSUPPORTED", async () => {
    // SUSPECT: `putModel`'s transport-refusal throw uses code "UNSUPPORTED",
    // which relock.ts's `defaultRetryable` does NOT exclude (only
    // SAFETY_DENIED/BAD_INPUT/LOCKED are). A transport pin cannot be fixed by
    // a fresh lock, yet withRelockRetry retries it anyway — this test proves
    // exactly that (2 LOCK calls, not 1) rather than assuming it. Documented
    // in the final report as a suspected inefficiency, NOT fixed here.
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({
      routes: [store.route, bopfLockTransportRoute({ name: "ZBOPF_PRB1", corrNr: "A4HK900555" })],
    });

    const err = await conn
      .withStatefulSession(async (session) => putModel(conn, session, "ZBOPF_PRB1", (xml) => xml, authWrite("ZBOPF_PRB1")))
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(isAbapError(err)).toBe(true);
    expect((err as AbapError).code).toBe("UNSUPPORTED");
    expect((err as AbapError).details).toMatchObject({ corrNr: "A4HK900555" });

    const locks = server.callsFor((r) => r.method === "POST" && r.qs["_action"] === "LOCK" && r.path === bopfUri("ZBOPF_PRB1"));
    expect(locks).toHaveLength(2); // retried despite being fundamentally unfixable by a fresh lock
    // Never actually PUT — the refusal happens before the wire write.
    const puts = server.callsFor((r) => r.method === "PUT" && r.path === bopfUri("ZBOPF_PRB1"));
    expect(puts).toHaveLength(0);
  });

  it("deleteBusinessObject refuses POST-lock via transportFromLock — single-shot, no retry (unlike putModel)", async () => {
    const store = bopfStore({ zbopf_mc5: FX_ACTIVE_DANGLING });
    const { conn, server } = await wired({
      routes: [store.route, bopfLockTransportRoute({ name: "ZBOPF_MC5", corrNr: "A4HK900777" })],
    });

    const err = await conn
      .withStatefulSession(async (session) => {
        const { authorized, gate } = mintDelete("ZBOPF_MC5");
        return deleteBusinessObject(conn, session, "ZBOPF_MC5", authorized, gate);
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(isAbapError(err)).toBe(true);
    expect((err as AbapError).code).toBe("UNSUPPORTED");
    expect((err as AbapError).details).toMatchObject({ corrNr: "A4HK900777" });

    const locks = server.callsFor((r) => r.method === "POST" && r.qs["_action"] === "LOCK" && r.path === bopfUri("ZBOPF_MC5"));
    expect(locks).toHaveLength(1); // no retry loop wraps deleteBusinessObject's own lock
    expect(store.has("zbopf_mc5")).toBe(true); // untouched
  });
});

// ===========================================================================

describe("searchBusinessObjects", () => {
  it("refuses locally with BAD_INPUT when objectType is missing or blank — no HTTP call", async () => {
    const { conn, server } = await wired({});
    const before = callsAfterConnect(server);

    const err1 = await searchBusinessObjects(conn, { objectType: "" } as never).then(
      () => undefined,
      (e: unknown) => e,
    );
    const err2 = await searchBusinessObjects(conn, { objectType: "   " }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(isAbapError(err1)).toBe(true);
    expect((err1 as AbapError).code).toBe("BAD_INPUT");
    expect(isAbapError(err2)).toBe(true);
    expect((err2 as AbapError).code).toBe("BAD_INPUT");
    expect(server.calls.length).toBe(before); // truly zero HTTP calls

    // ARCH-09 P5: the hint must name the actual zod field on abap_bopf
    // (object_type, snake_case) — not the internal camelCase objectType — or
    // an agent that follows it literally gets a second schema rejection.
    expect((err1 as AbapError).message).toContain("object_type");
    expect((err1 as AbapError).message).not.toMatch(/requires objectType/);
    expect((err1 as AbapError).hint).toContain("object_type");
  });

  it("parses the search result list and sends the right Accept + query params", async () => {
    // RECONSTRUCTED: no captured `$search` response exists in this repo's
    // fixtures. Shaped exactly as `parseSearchResults`'s own regex expects
    // (see bopf.ts): prefixed `adtcore:*ObjectReference` elements.
    const SEARCH_XML =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">` +
      `<adtcore:objectReference adtcore:uri="/sap/bc/adt/bopf/businessobjects/zbopf_mc5" adtcore:type="BOBF" adtcore:name="ZBOPF_MC5"/>` +
      `<adtcore:objectReference adtcore:uri="/sap/bc/adt/bopf/businessobjects/zbopf_prb1" adtcore:type="BOBF" adtcore:name="ZBOPF_PRB1"/>` +
      `</adtcore:objectReferences>`;
    const searchRoute: FakeRoute = (r) =>
      r.method === "GET" && r.path === `${BOPF_COLLECTION_PATH}/$search` ? fakeResponse(200, SEARCH_XML, { "content-type": "application/xml" }) : undefined;
    const { conn, server } = await wired({ routes: [searchRoute] });

    const results = await searchBusinessObjects(conn, { objectType: "BOBF", query: "ZBOPF*", maxResults: 50 });

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.name)).toEqual(["ZBOPF_MC5", "ZBOPF_PRB1"]);

    const calls = server.callsFor((r) => r.path === `${BOPF_COLLECTION_PATH}/$search`);
    expect(calls).toHaveLength(1);
    // OBSERVED live on A4H: $search 406s
    // (ExceptionResourceNotAcceptable) on the v4 media type — the response
    // body is a generic adtcore:objectReferences list, not a
    // bo:businessObject document, so plain application/xml is correct here,
    // not BOPF_ACCEPT_V4 (which is right for the collection root/instance URIs).
    expect(calls[0]?.headers["accept"]).toBe("application/xml");
    expect(calls[0]?.qs).toMatchObject({ objectType: "BOBF", query: "ZBOPF*", maxResults: "50" });
  });
});

// ===========================================================================

describe("fail-closed transport default", () => {
  it("createBusinessObject throws UNSUPPORTED with no HTTP call when transport is undefined", async () => {
    const { conn, server } = await wired({});
    const before = callsAfterConnect(server);

    const err = await createBusinessObject(conn, undefined, { name: "ZBOPF_X", packageName: "$TMP" }, authWrite("ZBOPF_X")).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(isAbapError(err)).toBe(true);
    expect((err as AbapError).code).toBe("UNSUPPORTED");
    expect(server.calls.length).toBe(before);
  });
});
