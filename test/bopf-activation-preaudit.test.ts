/**
 * Acceptance tests for the just-fixed `activateBusinessObject` two-phase
 * preaudit handshake: a phase-one reply naming
 * inactive dependents now drives a real phase two via `activateWithPreauditSet`
 * (`src/adt/activate.ts`) — the same machinery `activateObject` already used —
 * instead of stopping dead at phase one's own (often stale) verdict.
 *
 * Same pattern as `test/bopf-client.test.ts`: the REAL `activateBusinessObject`
 * against a `FakeAdtServer`, real BOPF fixtures for the model documents, no
 * mocking of `bopf.ts` or `activate.ts`. `activationRoute` (fake-adt.js)
 * can't express a two-phase exchange — it answers every activation POST
 * identically — so this file has its own route that branches on
 * `preauditRequested`.
 *
 * Preaudit XML bodies below are CONSTRUCTED, not captured, following the
 * envelope `test/activation-preaudit.test.ts`'s `PREAUDIT_ZMCP_MAIN` already
 * documents. The object names/types/URIs inside them are real: taken from
 * `04-active-after-structures.v4.xml`, the fixture ZBOPF_PRB1 reaches once
 * its root node's DDIC refs exist — i.e. exactly the objects a genuine
 * preaudit reply for this BO would need to name.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FakeAdtServer,
  __resetFakeAdtCounters,
  fakeResponse,
  bopfStore,
  activationFailureXml,
  BOPF_ACCEPT_V4,
  type FakeRoute,
} from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { bopfUri, activateBusinessObject } from "../src/adt/bopf.js";

// --------------------------------------------------------------------- fixtures ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const fixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

/** ZBOPF_PRB1, inactive, root-node-only — before its DDIC dependents exist. */
const FX_JUST_CREATED = fixture("02-created-zbopf_prb1-root-only.v4.xml");
/** ZBOPF_PRB1, active, root node's DDIC refs filled in. */
const FX_ACTIVE_STRUCTURES = fixture("04-active-after-structures.v4.xml");

/**
 * CONSTRUCTED. The three refs are ZBOPF_PRB1's real constants interface and
 * root-node DDIC refs (see fixture 04): an interface, a DDIC structure, and
 * a DDIC table, none of which existed with a `uri` until the root node's
 * structure refs were filled in.
 */
const PREAUDIT_ZBOPF_PRB1 = `<?xml version="1.0" encoding="utf-8"?>
<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/oo/interfaces/zif_bopf_prb1_c" adtcore:type="INTF/OI" adtcore:name="ZIF_BOPF_PRB1_C" adtcore:parentUri=""/>
    </ioc:object>
  </ioc:entry>
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/ddic/structures/zbopf_s_root" adtcore:type="TABL/DS" adtcore:name="ZBOPF_S_ROOT" adtcore:parentUri=""/>
    </ioc:object>
  </ioc:entry>
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/ddic/tables/zbopf_d_root" adtcore:type="TABL/DT" adtcore:name="ZBOPF_D_ROOT" adtcore:parentUri=""/>
    </ioc:object>
  </ioc:entry>
</ioc:inactiveObjects>`;

/**
 * CONSTRUCTED — row 3 of the probe table (`PREAUDIT_SEED_ONLY` in
 * `test/activation-preaudit.test.ts`), applied to the BOPF BO URI: a
 * preaudit document naming only the seed itself, differently cased.
 * `activationRefKey` lowercases before comparing, so this must collapse to
 * the same key as `bopfUri("ZBOPF_PRB1")` and add nothing to the set.
 */
const PREAUDIT_SEED_ONLY_RECASED = `<?xml version="1.0" encoding="utf-8"?>
<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/BOPF/businessobjects/ZBOPF_PRB1" adtcore:type="BOBF" adtcore:name="ZBOPF_PRB1" adtcore:parentUri=""/>
    </ioc:object>
  </ioc:entry>
</ioc:inactiveObjects>`;

/**
 * CONSTRUCTED, same shape as `ACTIVATION_ERROR_WITH_INACTIVE` in
 * `test/activation-preaudit.test.ts`: a real syntax error alongside a
 * preaudit set that would otherwise grow past the seed. This is what
 * actually exercises `activateWithPreauditSet`'s error-tally guard — a
 * document with an `[EAX]` message but ZERO `ioc:inactiveObjects` entries
 * never gets that far, since `first.inactive.length === 0` stops it first.
 */
const PREAUDIT_ERROR_WITH_INACTIVE = `<?xml version="1.0" encoding="utf-8"?>
<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">
  <msg objDescr="Interface ZIF_BOPF_PRB1_C" type="E" line="1" href="/sap/bc/adt/oo/interfaces/zif_bopf_prb1_c/source/main#start=1,0">
    <shortText><txt>Real syntax error, unrelated to the inactive dependents below.</txt></shortText>
  </msg>
</chkl:messages>
<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/oo/interfaces/zif_bopf_prb1_c" adtcore:type="INTF/OI" adtcore:name="ZIF_BOPF_PRB1_C" adtcore:parentUri=""/>
    </ioc:object>
  </ioc:entry>
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/ddic/structures/zbopf_s_root" adtcore:type="TABL/DS" adtcore:name="ZBOPF_S_ROOT" adtcore:parentUri=""/>
    </ioc:object>
  </ioc:entry>
</ioc:inactiveObjects>`;

/** CONSTRUCTED — a phase-two reply where one dependent is still genuinely inactive after the second POST. */
const PHASE2_STILL_INACTIVE = `<?xml version="1.0" encoding="utf-8"?>
<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/ddic/tables/zbopf_d_root" adtcore:type="TABL/DT" adtcore:name="ZBOPF_D_ROOT" adtcore:parentUri=""/>
    </ioc:object>
  </ioc:entry>
</ioc:inactiveObjects>`;

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

/**
 * Phase one's `preauditRequested` arrives as the vendor's own boolean `true`
 * (`conn.adt.activate`); phase two's arrives as the literal string `"false"`
 * (`postActivation`, `src/adt/activate.ts`). `String(...)` collapses both to
 * compare, matching `FakeRequest.qs`'s type-preserving `options.qs` spread.
 */
function twoPhaseActivationRoute(opts: { phase1Body: string; phase2Body?: string; onPhase2?: () => void }): FakeRoute {
  return (r) => {
    if (r.path !== "/sap/bc/adt/activation" || r.method !== "POST") return undefined;
    if (String(r.qs["preauditRequested"]) === "false") {
      opts.onPhase2?.();
      const body = opts.phase2Body ?? "";
      return fakeResponse(200, body, body ? { "content-type": "application/xml" } : { "content-length": "0" });
    }
    return fakeResponse(200, opts.phase1Body, opts.phase1Body ? { "content-type": "application/xml" } : { "content-length": "0" });
  };
}

const activationPosts = (server: FakeAdtServer) => server.callsFor((r) => r.method === "POST" && r.path === "/sap/bc/adt/activation");
const phase2Posts = (server: FakeAdtServer) => activationPosts(server).filter((r) => String(r.qs["preauditRequested"]) === "false");

/** Every `adtcore:uri="..."` attribute value in a hand-built activation body, in document order. */
function extractUris(body: string): string[] {
  return [...body.matchAll(/adtcore:uri="([^"]*)"/g)].map((m) => m[1] ?? "");
}

// ===========================================================================

describe("phase two POST shape", () => {
  it('names the seed BO plus every addressable preaudit ref, with preauditRequested sent as the literal string "false"', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({
      routes: [store.route, twoPhaseActivationRoute({ phase1Body: PREAUDIT_ZBOPF_PRB1 })],
    });

    await activateBusinessObject(conn, "ZBOPF_PRB1");

    const phase2 = phase2Posts(server);
    expect(phase2).toHaveLength(1);
    expect(String(phase2[0]?.qs["preauditRequested"])).toBe("false");
    expect(extractUris(phase2[0]?.body ?? "")).toEqual([
      bopfUri("ZBOPF_PRB1"),
      "/sap/bc/adt/oo/interfaces/zif_bopf_prb1_c",
      "/sap/bc/adt/ddic/structures/zbopf_s_root",
      "/sap/bc/adt/ddic/tables/zbopf_d_root",
    ]);
  });

  it("outcome.preaudit carries phase one's inactive set once phase two fires, and is absent (undefined) when it doesn't", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn: connWithPhase2 } = await wired({
      routes: [store.route, twoPhaseActivationRoute({ phase1Body: PREAUDIT_ZBOPF_PRB1 })],
    });
    const withPhase2 = await activateBusinessObject(connWithPhase2, "ZBOPF_PRB1");
    expect(withPhase2.preaudit?.map((p) => p.name)).toEqual(["ZIF_BOPF_PRB1_C", "ZBOPF_S_ROOT", "ZBOPF_D_ROOT"]);

    const store2 = bopfStore({ zbopf_prb1: FX_ACTIVE_STRUCTURES });
    const { conn: connClean } = await wired({
      routes: [store2.route, twoPhaseActivationRoute({ phase1Body: "" })],
    });
    const clean = await activateBusinessObject(connClean, "ZBOPF_PRB1");
    expect(clean.preaudit).toBeUndefined();
  });

  it("skips the second POST when the preaudit set adds nothing beyond the seed itself", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({
      routes: [store.route, twoPhaseActivationRoute({ phase1Body: PREAUDIT_SEED_ONLY_RECASED })],
    });

    await activateBusinessObject(conn, "ZBOPF_PRB1");

    expect(activationPosts(server)).toHaveLength(1);
  });

  it("a plain syntax-error reply, no preaudit document at all, never reaches phase two", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({
      routes: [store.route, twoPhaseActivationRoute({ phase1Body: activationFailureXml({ uri: bopfUri("ZBOPF_PRB1") }) })],
    });

    const outcome = await activateBusinessObject(conn, "ZBOPF_PRB1");

    // activationFailureXml carries no ioc:inactiveObjects, so this is
    // stopped by `first.inactive.length === 0` — the [EAX]-tally guard
    // below is what fires when a preaudit set is actually on the table.
    expect(activationPosts(server)).toHaveLength(1);
    expect(outcome.activated).toBe(false);
  });

  it("a phase-one [EAX] message suppresses phase two entirely, even with a growable inactive set on the table", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({
      routes: [store.route, twoPhaseActivationRoute({ phase1Body: PREAUDIT_ERROR_WITH_INACTIVE })],
    });

    const outcome = await activateBusinessObject(conn, "ZBOPF_PRB1");

    expect(activationPosts(server)).toHaveLength(1);
    expect(outcome.activated).toBe(false);
  });
});

// ===========================================================================

describe("verdict: AND of the phase-two body and the fresh re-read", () => {
  it("activated: true once phase two lands and the fresh re-read agrees the BO is active", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({
      routes: [
        store.route,
        twoPhaseActivationRoute({
          phase1Body: PREAUDIT_ZBOPF_PRB1,
          onPhase2: () => store.set("zbopf_prb1", FX_ACTIVE_STRUCTURES),
        }),
      ],
    });

    const outcome = await activateBusinessObject(conn, "ZBOPF_PRB1");
    expect(outcome.activated).toBe(true);
    expect(outcome.version).toBe("active");
  });

  it("activated: false when the fresh re-read still shows inactive, even though phase two came back clean", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({
      routes: [store.route, twoPhaseActivationRoute({ phase1Body: PREAUDIT_ZBOPF_PRB1 })],
    });

    const outcome = await activateBusinessObject(conn, "ZBOPF_PRB1");
    expect(outcome.activated).toBe(false);
    expect(outcome.version).toBe("inactive");
  });

  it("activated: false when the phase-two reply itself still lists an inactive dependent", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({
      routes: [store.route, twoPhaseActivationRoute({ phase1Body: PREAUDIT_ZBOPF_PRB1, phase2Body: PHASE2_STILL_INACTIVE })],
    });

    const outcome = await activateBusinessObject(conn, "ZBOPF_PRB1");
    expect(outcome.activated).toBe(false);
  });
});

// ===========================================================================

describe("BOPF's version-history blind spot: the fresh re-read is load-bearing, not redundant", () => {
  it("seedsStillInactive's revisions GET goes unrouted for a BOPF seed, so a clean phase two is believed and the fresh re-read alone decides the verdict", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({
      routes: [store.route, twoPhaseActivationRoute({ phase1Body: PREAUDIT_ZBOPF_PRB1 })],
    });

    const outcome = await activateBusinessObject(conn, "ZBOPF_PRB1");

    // `conn.adt.revisions(seed.uri)` first GETs the seed's object-structure
    // document (vendor `objectStructure`, default `Accept: */*`, no override).
    // A BOPF BO URI never answers that Accept with anything — only the v4
    // model document exists — so this GET always falls through to unrouted
    // and `seedsStillInactive` treats the seed as unreadable (believed, not
    // proven). The shared driver's version-history check is therefore a
    // no-op for BOPF: this file's own fresh `readModel` re-read is the only
    // thing standing between a silent no-op and a reported success.
    expect(
      server.violations.some(
        (v) => v.kind === "unrouted-request" && v.request.path === bopfUri("ZBOPF_PRB1") && v.request.headers["accept"] === "*/*",
      ),
    ).toBe(true);

    // The store was never flipped to active. A body-verdict-only client
    // would report this activated (phase two came back clean, and the
    // version-history check believed it for lack of anything to disprove
    // it) — the fresh re-read is what actually catches the no-op.
    expect(outcome.activated).toBe(false);
    expect(outcome.version).toBe("inactive");
  });

  it("a re-read failure AFTER phase two was sent gets no benefit of the doubt: activated: false", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const failReadModelGet: FakeRoute = (r) =>
      r.method === "GET" && r.path === bopfUri("ZBOPF_PRB1") && r.headers["accept"] === BOPF_ACCEPT_V4
        ? fakeResponse(500, `<exc:exception><type id="ExceptionSystemError"/></exc:exception>`, { "content-type": "application/xml" })
        : undefined;
    const { conn } = await wired({
      routes: [failReadModelGet, store.route, twoPhaseActivationRoute({ phase1Body: PREAUDIT_ZBOPF_PRB1 })],
    });

    // With the re-read gone, an empty phase-two 200 is byte-identical to the
    // silent no-op this catch exists to guard against — `preaudit !== undefined` here, so
    // the catch block's `corroborated = preaudit === undefined` comes out false.
    const outcome = await activateBusinessObject(conn, "ZBOPF_PRB1");
    expect(outcome.activated).toBe(false);
    expect(outcome.version).toBeUndefined();
  });

  it("characterisation: a re-read failure with NO phase two still falls back to the body verdict", async () => {
    const failReadModelGet: FakeRoute = (r) =>
      r.method === "GET" && r.path === bopfUri("ZBOPF_PRB1") && r.headers["accept"] === BOPF_ACCEPT_V4
        ? fakeResponse(500, `<exc:exception><type id="ExceptionSystemError"/></exc:exception>`, { "content-type": "application/xml" })
        : undefined;
    const { conn } = await wired({
      routes: [failReadModelGet, twoPhaseActivationRoute({ phase1Body: "" })],
    });

    // No phase two ran, so `preaudit` stays undefined and
    // `corroborated = preaudit === undefined` is true regardless of the
    // re-read's own failure — today's behaviour, deliberately unchanged.
    const outcome = await activateBusinessObject(conn, "ZBOPF_PRB1");
    expect(outcome.activated).toBe(true);
    expect(outcome.version).toBeUndefined();
  });
});
