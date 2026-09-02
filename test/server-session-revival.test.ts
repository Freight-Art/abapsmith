/**
 * The COMPOSITION ROOT reconnects after a session dies.
 *
 * ## The gap this file closes
 *
 * `src/server.ts` memoises the logon in a `connectPromise` local to
 * `createServer`, and subscribes to the primary connection's death seam to
 * throw that memo away. It is a `watchPrimary` helper rather than a bare
 * one-shot subscription, because the primary is re-seatable: the memo has to be
 * dropped on identity change as well as on death.
 *
 * ```ts
 * const watchPrimary = (conn: AbapConnection): void => {
 *   if (watched === conn) return;
 *   watched = conn;
 *   connectPromise = undefined;
 *   conn.onDead(() => { if (watched === conn) connectPromise = undefined; });
 * };
 * ```
 *
 * Deleting that subscription left the ENTIRE suite green when this file was
 * written (60 files / 2182 tests — a historical measurement; the suite has
 * grown since). Everything that looked like coverage was coverage of something
 * else:
 *
 *  - `test/connection-liveness.test.ts` proves `onDead` FIRES, that `markDead`
 *    drops `connected`, and that `connect()` revives a dead connection. All of
 *    that is `AbapConnection`'s half of the contract and holds whether or not
 *    `server.ts` ever subscribes.
 *  - the same file's "models the server.ts fix" test re-implements
 *    `ensureConnected` LOCALLY over a bare connection. A miniature of a fix can
 *    only ever pin the miniature; it never imports `createServer`, so the real
 *    composition root could lose its subscription without that test noticing.
 *  - `test/pool-characterization.test.ts` does drive the real `createServer`,
 *    but every golden there is a HEALTHY-session trace. Nothing in it ever
 *    dies, so nothing in it can observe a failure to revive.
 *
 * So this file asserts the one thing none of them can: that the connection
 * `createServer` actually built is wired to the memo `createServer` actually
 * uses. The discriminating observable is `logonEndpointRequests` — a SECOND
 * logon must reach the wire after the session dies. Without the subscription,
 * `ensureConnected()` awaits the stale RESOLVED promise, returns instantly,
 * and the count never moves; every request under it then fails `SESSION_DEAD`
 * until the process restarts. That is the ~32-minute idle expiry
 * as a user experiences it.
 *
 * ## Why the control test is not padding
 *
 * "The logon count went up by one" is only evidence if the count does NOT go
 * up on its own. §2 invokes the same entry point twice with no death in
 * between and pins the count at ONE — so §1's `+1` is attributable to the
 * death and to nothing else. Without it, a regression that re-logs-on per call
 * (the classic session-pool defect) would keep §1 green while being a far
 * worse bug than the one under test.
 *
 * ## Why `markDead()` rather than an ICMENOSESSION on the wire
 *
 * Both would work; `markDead()` is the smaller claim. That an ICM 400 with
 * `x-sap-icm-err-id: ICMENOSESSION` reaches `markDead()` is already pinned by
 * `test/connection-liveness.test.ts` ("isSessionDeath is wired into markDead").
 * Re-deriving it here would test that classifier a second time and make THIS
 * file fail for reasons that have nothing to do with the composition root.
 * The reason string is kept faithful to the live capture regardless.
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

// ------------------------------------------------------------------ fixtures ---

/**
 * The §10.4 non-productive probe, answered as a ROUTE on the fake (not by
 * wrapping the client), for the reason `pool-characterization.test.ts`
 * documents: the fake has no `catchAll`, so an unrouted probe would record an
 * `unrouted-request` violation and break `assertNoViolations()`.
 *
 * It matters twice as much here as it does there. The probe is skipped only
 * when the SAME `AbapConnection` already holds a DEFINITIVE verdict in its
 * private `cachedDetection` (`src/adt/connection.ts`); revival now mints a NEW
 * connection (see §1), whose cache is empty, so the revival logon runs the
 * probe again. A route that answered only once would record an
 * `unrouted-request` violation AND degrade the second verdict to
 * `inconclusive`, which `applyReadOnlyPolicy` turns into a fail-closed write
 * lockout — the reconnect would still succeed, but on a system this file
 * intends to have PROVED non-productive.
 */
const systemRoleRoute: FakeRoute = (r) =>
  r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined;

const CLAS_URI = "/sap/bc/adt/oo/classes/zcl_demo";

/**
 * `abap_read`'s `type: "CLAS/OC"` forces `resolveObject`'s
 * "certain" fast path, which now spends one search round trip to recover
 * `packageName` (no ref shape carries it for free — see `lookupPackageName`
 * in `src/adt/resolve.ts`). Without this route the revival logon's SECOND
 * `abap_read` would record an `unrouted-request` violation and fail
 * `assertNoViolations()` — the fix genuinely adds a call this file must
 * answer, on both the pre- and post-revival connections.
 */
const searchRoute: FakeRoute = (r) =>
  r.path.endsWith("/repository/informationsystem/search")
    ? fakeResponse(
        200,
        searchResultsXml(
          String(r.qs["query"] ?? "").toUpperCase().startsWith("ZCL_DEMO")
            ? [{ name: "ZCL_DEMO", type: "CLAS/OC", uri: CLAS_URI, packageName: "$TMP" }]
            : [],
        ),
        { "content-type": "application/xml; charset=utf-8" },
      )
    : undefined;

const cfg = (over: Partial<Config> = {}): Config => ({
  ...ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "hunter2",
    sid: "TST",
    // Fixture 087 carries client 001 -> CCCATEGORY "C", so the probe can PROVE
    // non-productive rather than fail closed.
    client: "001",
  }),
  ...over,
});

const SYSTEM_RESOURCE_URI = `abap://${cfg().sid}/system`;

/**
 * `before` routes are matched FIRST (custom routes are tried in order), which
 * is how §4 overrides the logon path without disturbing the builtins.
 */
const scaffold = (before: FakeRoute[] = []): FakeAdtServer =>
  new FakeAdtServer({
    routes: [...before, systemRoleRoute, searchRoute],
    objects: {
      [`${CLAS_URI}/source/main`]:
        "CLASS zcl_demo DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_demo IMPLEMENTATION.\nENDCLASS.\n",
    },
    objectMetadata: {
      [CLAS_URI]: objectMetadataXml({ name: "ZCL_DEMO", type: "CLAS/OC", packageName: "$TMP" }),
    },
    // No `catchAll`, deliberately (the StrictAdt idiom). A generic `<ok/>` would
    // let the REVIVAL logon quietly succeed on garbage, which is exactly the
    // thing this file must not be able to do.
  });

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

async function harness(
  config: Config,
  server: FakeAdtServer,
  /**
   * Extra `ServerOptions`. `ServerOptions extends ConnectionOptions`
   * (`src/server.ts`), so this is how §4 injects a breaker with a drivable
   * clock — the transient circuit is otherwise wall-clock bound and would
   * mask the defect under test rather than expose it.
   */
  extra: Record<string, unknown> = {},
): Promise<Harness> {
  const srv = createServer(config, {
    breaker: new AuthCircuitBreaker(),
    ...extra,
    httpClient: server.client(),
    log: () => {},
    journal: new Journal(
      { dir: journalDir, enabled: true, maxEntries: 100, maxAgeDays: 30 },
      config.sid,
    ),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "server-session-revival", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);
  const h: Harness = { srv, client, server };
  openHarnesses.push(h);
  return h;
}

/**
 * The CHEAPEST thing that provably runs `ensureConnected()`: the `system`
 * resource's read handler awaits it and then reads only in-memory state, so it
 * adds ZERO requests of its own to the wire. Every request in a trace below
 * therefore belongs to the logon preamble, which is what makes the counts
 * readable.
 * (`abap_journal mode=list` would be cheaper still and is useless here — it
 * deliberately never connects at all.)
 */
async function readSystemResource(h: Harness): Promise<void> {
  await h.client.readResource({ uri: SYSTEM_RESOURCE_URI });
}

async function callOk(h: Harness, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  const res = (await h.client.callTool({ name, arguments: args })) as unknown as ToolCallResult;
  if (res.isError) {
    throw new Error(`${name} failed, so it proves nothing: ${res.content[0]?.text ?? "(no body)"}`);
  }
  return res;
}

/** How many times the logon endpoint was hit, as the FAKE saw it — independent of the connection's own counter. */
const logonRequests = (server: FakeAdtServer): FakeRequest[] =>
  server.calls.filter((r) => r.path === "/sap/bc/adt/compatibility/graph");

/** The live ICM shape a ~32-minute idle expiry produces. */
const IDLE_EXPIRY = "HTTP 400: ICMENOSESSION";

beforeEach(() => {
  __resetFakeAdtCounters();
  openHarnesses = [];
  journalDir = mkdtempSync(join(tmpdir(), "abapsmith-revival-"));
});

afterEach(async () => {
  for (const h of openHarnesses) {
    await h.client.close().catch(() => {});
    await h.srv.stop().catch(() => {});
  }
  openHarnesses = [];
  rmSync(journalDir, { recursive: true, force: true });
});

// ===========================================================================

describe("createServer() revives its session after death (the REAL composition root)", () => {
  /**
   * §1 — THE discriminating test. Delete the `watchPrimary`/`connectPromise`
   * block from `src/server.ts` and this fails: the second `ensureConnected()`
   * awaits the stale resolved memo, no second logon reaches the fake, and the
   * server is left holding a session it cannot use.
   *
   * ---------------------------------------------------------------------
   * WHAT CHANGED, AND WHY IT HAD TO
   * ---------------------------------------------------------------------
   * Revival used to mean `connect()` on the SAME `AbapConnection` object,
   * which `src/server.ts` had captured once and cached for the life of the
   * process. `LOGON_ENDPOINT_LIFETIME_CEILING` is 5, and it is a LIFETIME
   * counter on that object. The initial logon is charged too, so logons 1-5 fly
   * and the 6th — the FIFTH revival — is refused; a `logonCeilingRefused` flag
   * then latches and every later `connect()` throws the same error, so the
   * server is bricked until it is restarted. The refusal itself is free: the
   * ceiling is CHECKED BEFORE the request is charged, so refused attempts do
   * not dig the hole deeper. A long-lived server on a system that expires idle
   * sessions every ~30 minutes reaches that ceiling as a matter of routine, not
   * as an incident.
   *
   * `pool.primary()` is now a live read that re-seats onto a session the pool
   * actually holds, and `src/server.ts` calls it at the point of use instead
   * of caching the object. `markDead()` RETIRES the dead slot; the re-seat then
   * ADOPTS another live slot if the pool holds one, and mints a fresh
   * connection if it does not. Either way the connection handed out AFTER a
   * death is a DIFFERENT object from the one that died, with its own logon
   * budget — nothing inherits the corpse's counters. Slots are created on
   * demand and this file drives one call at a time, so here there is nothing to
   * adopt and the re-seat mints; that is asserted below
   * (`after.logonEndpointRequests === 0`) rather than assumed. The assertions
   * are therefore written against the WIRE (which is model-independent) and
   * against per-object counters read at the right time.
   */
  it("logs on AGAIN after markDead, exactly once, and comes back alive", async () => {
    const server = scaffold();
    const h = await harness(cfg(), server);

    await readSystemResource(h);
    const before = h.srv.connection;
    expect(before.logonEndpointRequests).toBe(1);
    expect(before.isConnected).toBe(true);

    // The ~32-min idle expiry, as `AbapConnection` records it.
    before.markDead(IDLE_EXPIRY);
    expect(before.isDead, "the object that died stays dead — nothing resurrects it").toBe(true);
    expect(before.isConnected).toBe(false);

    // Read through the live getter: the corpse is no longer what the server
    // hands to callers. A pool that returned it here is the bricking bug.
    const after = h.srv.connection;
    expect(after, "the dead session must not be handed out again").not.toBe(before);
    expect(after.isDead).toBe(false);
    expect(after.isConnected, "re-seating is LAZY: nothing has logged on yet").toBe(false);
    expect(after.logonEndpointRequests, "and the replacement starts on a fresh budget").toBe(0);

    await readSystemResource(h);

    // EXACTLY one more logon on the wire: not zero (the stale-memo bug) and not
    // more than one (a logon storm, which `LOGON_ENDPOINT_LIFETIME_CEILING`
    // would eventually trip but which must be caught here, at one call).
    expect(logonRequests(server)).toHaveLength(2);
    expect(h.srv.connection).toBe(after);
    expect(after.logonEndpointRequests).toBe(1);
    expect(after.isConnected).toBe(true);
    expect(after.isDead).toBe(false);
    expect(after.deathRecord).toBeUndefined();
    server.assertNoViolations();
  });

  /**
   * §2 — the CONTROL that gives §1's `+1` its meaning. Same entry point, twice,
   * no death: the logon must be paid ONCE per process. A server that re-connects
   * per invocation would satisfy §1 for entirely the wrong reason.
   */
  it("does NOT log on again when the session is still alive", async () => {
    const server = scaffold();
    const h = await harness(cfg(), server);

    await readSystemResource(h);
    await readSystemResource(h);

    expect(h.srv.connection.logonEndpointRequests).toBe(1);
    expect(logonRequests(server)).toHaveLength(1);
    server.assertNoViolations();
  });

  /**
   * §3 — revival has to serve real WORK, not just the resource that triggered
   * it. §1 proves a second logon happens; this proves the connection that comes
   * back is usable: a tool call after death returns its payload instead of
   * `SESSION_DEAD`. Both entry points go through the same `ensureConnected`, and
   * a fix wired to only one of them would be no fix at all.
   */
  it("serves a TOOL call on the revived session, with its real payload", async () => {
    const server = scaffold();
    const h = await harness(cfg(), server);

    await callOk(h, "abap_read", { object: "ZCL_DEMO", type: "CLAS/OC" });
    expect(h.srv.connection.logonEndpointRequests).toBe(1);

    h.srv.connection.markDead(IDLE_EXPIRY);

    const res = await callOk(h, "abap_read", { object: "ZCL_DEMO", type: "CLAS/OC" });
    expect(res.content[0]?.text ?? "").toContain("CLASS zcl_demo DEFINITION");

    // ONE on the revived object (it is a new session with its own budget), TWO
    // on the wire. The wire count is the one that would catch a logon storm.
    expect(h.srv.connection.logonEndpointRequests).toBe(1);
    expect(logonRequests(server)).toHaveLength(2);
    expect(h.srv.connection.isDead).toBe(false);
    // The source GET happened on BOTH sides of the death: the revived session
    // did the work, it was not served from anything cached.
    expect(server.calls.filter((r) => r.path === `${CLAS_URI}/source/main`)).toHaveLength(2);
    server.assertNoViolations();
  });

  /**
   * §4 — the ORDER on the wire. §1 counts logons; this pins that the revival
   * logon lands AFTER the pre-death work rather than being an eager reconnect
   * that happened to fall in the right place. Revival is lazy and
   * caller-driven: nothing reconnects at `markDead()` time, only at the next
   * `ensureConnected()`.
   */
  it("reconnects LAZILY — markDead puts nothing on the wire; the next call does", async () => {
    const server = scaffold();
    const h = await harness(cfg(), server);

    await readSystemResource(h);
    const callsAfterFirstConnect = server.calls.length;

    // Prime the latch BEFORE death: the fixture's `systemRoleRoute` always
    // answers "nonproductive", so without an existing lockout to defend,
    // `writesLockedOut` is false on both sides of the revival and the
    // one-way-latch assertions below would be vacuously true.
    const LOCKOUT_REASON = "DEFECT-5 fixture: locked before markDead";
    h.srv.safety.update({ writesLockedOut: true, lockoutReason: LOCKOUT_REASON });

    h.srv.connection.markDead(IDLE_EXPIRY);
    // Death is RECORDED, never confirmed — the pool's "learned, never probed"
    // rule (L2, `src/adt/pool.ts`). Confirming it would not merely be wasteful:
    // a synthetic probe on that session sits behind any outstanding long poll
    // (live measurement showed ~115 s blocked on a 120 s listener; the
    // server-side mechanism is an inference from timing rather than an
    // observation).
    expect(server.calls.length).toBe(callsAfterFirstConnect);

    await readSystemResource(h);

    // Recorded, not stipulated. This trace USED to be TWO requests —
    // `compatibility/graph` and `discovery` — because revival meant `connect()`
    // on the SAME object, and `cachedDetection` (a private instance field in
    // `src/adt/connection.ts`) survives a death. That ONE latch suppressed BOTH
    // of the missing requests: `ato/settings` is only ever reached from inside
    // `detectSystemRole`, downstream of the cache's early return.
    //
    // `Discovery.state` was NOT a second latch here, and an earlier version of
    // this comment was wrong to name it as one. This fake answers `discovery`
    // with an empty `<service/>`, so the state settles on "empty" rather than
    // "loaded", and only "loaded" short-circuits the next load — `discovery`
    // was re-fetched on every connect in BOTH traces, and it is one of the two
    // requests in the old one. Probed directly against this fixture, not
    // reasoned about.
    //
    // Revival is now a NEW connection (see §1) with an empty detection cache,
    // so it pays the FULL preamble: +2 requests per revival, against a
    // permanent brick after the 5th. That is the trade, and it is deliberate.
    //
    // The comment this replaced claimed the re-detection skip was a SECURITY
    // property — that a revival "cannot silently re-open writes on a system
    // already locked out: it never re-runs the detection that would have to be
    // fooled". That was an OVERCLAIM, not a fiction. Writes are locked out for
    // exactly two reasons (`applyReadOnlyPolicy`), and the claim held for one
    // of them:
    //
    //   - detected `productive` — LATCHED, because only DEFINITIVE verdicts are
    //     cached. A same-object revival replayed the cached `productive` and
    //     re-applied the lockout without re-probing. The claim was TRUE here.
    //   - detection `inconclusive` — deliberately NOT latched (an inconclusive
    //     answer may become definitive once a CSRF token exists). A same-object
    //     revival re-ran the full probe, and a second probe returning
    //     `nonproductive` cleared the lockout. The claim was FALSE here.
    //
    // What settles it now is simpler than either half. An earlier rewrite
    // argued that the old claim "stops being true once `maxSessions > 1`" —
    // which is a bad argument twice over: it appeals to a config as though it
    // were exotic (`maxSessions` in fact ships defaulting to 5, `src/config.ts`)
    // when the decisive fact needs no appeal to pool size at all. That fact is
    // in the change itself: a revival never hands back the object that died.
    // The pool re-seats onto a DIFFERENT connection, and `cachedDetection` is
    // per-object and never inherited, so the replacement either already ran
    // detection on its own connect or runs it on its first. At the shipped
    // default, on any pool size, no revival replays the dead object's cached
    // verdict — and the trace below is the mint case paying the full probe.
    // There is no skip left to call a security property.
    //
    // The property itself is not lost — it moved to where it belongs.
    // `SafetyGate.writesLockedOut` is a ONE-WAY latch (`src/safety.ts`): an
    // ordinary `update()` carrying `false` cannot clear a lockout; only the
    // explicit, reason-requiring `resetWriteLockout()` can. That is a stronger
    // guarantee than the old one — it holds for BOTH lockout reasons, it is
    // process-wide rather than per-object, and it survives the re-detection
    // this very trace shows happening instead of depending on that detection
    // being skipped. Re-detection also still fails CLOSED on its own: an
    // inconclusive re-probe locks writes out rather than opening them.
    expect(server.calls.slice(callsAfterFirstConnect).map((r) => r.path)).toEqual([
      "/sap/bc/adt/compatibility/graph",
      "/sap/bc/adt/discovery",
      DATA_PREVIEW_PATH,
      "/sap/bc/adt/ato/settings",
    ]);
    expect(
      server.calls.filter((r) => r.path === DATA_PREVIEW_PATH),
      "once per session, not once per request",
    ).toHaveLength(2);

    // The property the comment above states in prose, asserted: the revived
    // session's re-detection (a fresh "nonproductive" verdict, per
    // `systemRoleRoute`) must not talk the gate out of a lockout it already
    // held. `SafetyGate.writesLockedOut` is a ONE-WAY latch (`src/safety.ts`
    // `update()`); only `resetWriteLockout()` may clear it.
    expect(
      h.srv.safety.config.writesLockedOut,
      "a revived session must not come back with writes re-opened",
    ).toBe(true);
    expect(
      h.srv.safety.config.lockoutReason,
      "the revived session's contradictory nonproductive evidence must not overwrite the original lockout reason",
    ).toBe(LOCKOUT_REASON);
    expect(
      h.srv.safety.writeLockoutResets,
      "nothing talked itself out of the verdict via resetWriteLockout",
    ).toEqual([]);

    server.assertNoViolations();
  });
});

// ===========================================================================
// §4 — DEFECT 3: the failed-connect brick
// ===========================================================================

/**
 * REGRESSION TEST (both cases below).
 *
 * ## The defect, as it shipped
 *
 * A connection could become PERMANENTLY unusable while still reporting
 * `isDead === false`, and the pool trusts `isDead` as its sole liveness
 * authority (`AdtSessionPool.isSlotDead` reads nothing but `slot.dead` and
 * `conn.isDead`). That state discontinuity bricked the process:
 *
 *  - `markDead()` was reached from exactly ONE internal site — `noteWireResponse`,
 *    and only for a `classifySessionFailure` hit (ICMENOSESSION / short dump).
 *    A 401, a plain 500, a timeout or a bare network error left `isDead` false.
 *  - so a FAILED `connect()` marked nothing. `seatPrimary()` is a lazy fixup
 *    that re-seats only when the seated slot is absent or `isSlotDead`, so it
 *    early-returned on the live, idle, useless slot 0 forever.
 *  - each failed logon still charged `logonEndpointRequestCount`. On the 6th,
 *    `LOGON_ENDPOINT_LIFETIME_CEILING` (5) latched `logonCeilingRefused`, which
 *    `connectUnderLock()`'s catch checks FIRST — so every later `connect()` on
 *    that object threw "logon-ceiling-exceeded" without reaching the wire.
 *
 * Net effect: FIVE failing tool calls during an appliance restart bricked the
 * server for the whole life of the process, and it stayed bricked after the
 * appliance came back. The ceiling is a LIFETIME count that revival never
 * resets, so nothing could ever clear it.
 *
 * The fix marks the connection DEAD when that latch engages, so the existing
 * death machinery — `onDead` -> `onSlotConnectionDied` -> drop + re-seat, and
 * `watchPrimary` dropping the memoised `connectPromise` — runs unchanged.
 *
 * ## Why a plain 500
 *
 * It must be neither auth-shaped (`classifyAuthFailure`) nor session-death
 * shaped (`classifySessionFailure`). An auth shape latches the breaker at
 * STRIKE ONE, which caps logons at 1 and HIDES the brick; a session-death shape
 * calls `markDead()` and so fixes the defect by accident. A plain
 * `500 text/plain` is classified by neither (`src/adt/session.ts` returns
 * `undefined` for a 500 with no dump marker and no HTML content type).
 */
describe("DEFECT 3 — a connection refused by its own logon ceiling does not brick the server", () => {
  const LOGON_PATH = "/sap/bc/adt/compatibility/graph";

  /** A non-auth, non-dump 500 on the logon path only, switchable at will. */
  const failingLogonRoute = (isFailing: () => boolean): FakeRoute => (r) =>
    isFailing() && r.path === LOGON_PATH
      ? fakeResponse(500, "upstream unavailable", { "content-type": "text/plain" })
      : undefined;

  /**
   * The transient half of the breaker opens after 3 consecutive failures and is
   * wall-clock bound. Driving `now` lets every attempt genuinely reach the fake
   * with no timers and no waiting, so the trace measures the defect and not the
   * cooldown.
   */
  const drivableBreaker = (clock: { readonly ms: number }) =>
    new AuthCircuitBreaker({
      cooldownMs: 1_000,
      maxCooldownMs: 1_000,
      failureThreshold: 3,
      now: () => clock.ms,
    });

  /**
   * §4.1 — THE discriminating test. Against the shipped code this fails on the
   * FIRST assertion: the server never recovers, because `srv.connection` is
   * still the bricked object whose every `connect()` is refused locally.
   *
   * Verbatim pre-fix failure:
   *   "Could not connect to http://sap.invalid:50000: refused locally after 5
   *    logon-endpoint requests (ceiling 5). Nothing was sent; no credential was
   *    rejected."
   */
  it("REGRESSION: recovers once the wire does, after enough failures to exhaust the lifetime ceiling", async () => {
    let logonFails = true;
    const server = scaffold([failingLogonRoute(() => logonFails)]);
    const clock = { ms: 1_000_000 };
    const h = await harness(cfg(), server, { breaker: drivableBreaker(clock) });
    const original = h.srv.connection;

    // Six failing tool calls: five spend the ceiling, the sixth is refused
    // locally. That sixth is the one that used to brick the process.
    for (let i = 0; i < 6; i++) {
      clock.ms += 10_000;
      const failed = await readSystemResource(h).then(
        () => false,
        () => true,
      );
      expect(failed, `request ${i + 1} must FAIL, not silently succeed`).toBe(true);
    }
    expect(logonRequests(server), "one logon per failing request, and the 6th refused for free").toHaveLength(5);
    expect(original.isDead, "the exhausted connection reports itself dead").toBe(true);

    // THE APPLIANCE COMES BACK.
    logonFails = false;
    clock.ms += 10_000;
    await readSystemResource(h);

    expect(h.srv.connection, "the bricked primary was REPLACED, not revived").not.toBe(original);
    expect(logonRequests(server), "recovery cost exactly one further logon").toHaveLength(6);
  });

  /**
   * §4.2 — BEHAVIOUR-LOCK on the SAFETY BUDGET, and it is the reason this fix
   * is allowed to ship at all.
   *
   * An earlier attempt at a related fix turned one failing request into one
   * logon PER RETRY, aimed straight at `login/fails_to_user_lock = 5` — a
   * PERMANENT SAP user lock. This pins the property that forbids it: a single
   * inbound request never costs more than ONE logon on the wire, before or
   * after the primary is replaced.
   *
   * The observed shape is [1,1,1,1,1,0, 1,1,1,1,1,0, 1,1]: five charged logons,
   * then a FREE local refusal that retires the corpse, then a fresh connection
   * repeating the cycle. Never two logons for one request.
   *
   * The `0`s are why this asserts AT MOST N rather than EXACTLY N — a local
   * refusal sends nothing, which is the conservative direction.
   */
  it("BEHAVIOUR-LOCK: N failing requests cost AT MOST N logons — never one per retry", async () => {
    const server = scaffold([failingLogonRoute(() => true)]);
    const clock = { ms: 1_000_000 };
    const h = await harness(cfg(), server, { breaker: drivableBreaker(clock) });

    const N = 14; // past TWO ceiling exhaustions, so it spans the replacement boundary
    const perRequest: number[] = [];
    for (let i = 0; i < N; i++) {
      clock.ms += 10_000;
      const before = logonRequests(server).length;
      const failed = await readSystemResource(h).then(
        () => false,
        () => true,
      );
      expect(failed, `request ${i + 1} must FAIL`).toBe(true);
      perRequest.push(logonRequests(server).length - before);
    }

    expect(
      Math.max(...perRequest),
      "ONE logon per failing inbound request is the whole safety budget",
    ).toBe(1);
    expect(logonRequests(server).length, "and therefore never more than N in total").toBeLessThanOrEqual(N);
  });
});
