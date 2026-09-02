/**
 * Live integration test for `src/debug/session.ts`. Skipped unless
 * ABAP_URL is set. Drives `DebugSession`/`DebugClient`/`DebugTransport`
 * against A4H exactly following the proven choreography for the ADT debugger
 * protocol, reusing the `ZMCP_DBG_ITEM`/`ZMCP_DBG_FILL`/`ZMCP_DBG_DEMO`/
 * `ZMCP_DBG_RUN` fixtures already deployed in `$TMP` (never recreated here).
 *
 *     npx vitest run test/integration-debug.test.ts
 *
 * SAFETY (same discipline as the work-process budget below):
 * at most ONE listener and ONE suspended debuggee at a time, released in a
 * `finally` on every path AND — since a case killed by a timeout or by a
 * background rejection never reaches its own `finally` — again in a registry-
 * driven `afterEach` that cannot throw and that aborts the whole run rather
 * than start another case on an appliance it could not confirm clean (see the
 * PER-CASE TEARDOWN block below). Dedicated, disposable `AbapConnection`s are
 * used for debug control (`connA`, `connA2` — each becomes permanently stateful
 * the moment any debugger call goes through it, by design, see `session.ts`'s
 * `createDebugClientForConnection` doc comment) and for triggering the
 * classrun launcher (`connB`/`connB2` — plain classrun POSTs, never touch
 * `DebugTransport`, stay stateless). Every debug-driving case gets its OWN
 * control connection: the server binds the debug session to the stateful HTTP
 * session, not to the terminal id, so two cases sharing one connection share
 * one debug session no matter how their `DebugContext`s differ.
 *
 * KNOWN LIVE FINDING (2026-07-31 live-verification pass, not fixed here per
 * that pass's explicit instructions not to edit `src/debug/transport.ts`):
 * `DebugLongPollClient`'s raw `node:http`/`node:https` long-poll socket
 * (`defaultRawHttpRequest` in `transport.ts`) reproducibly reset
 * (`ECONNRESET`/"socket hang up") within ~1-2s of being opened, 3/3 attempts,
 * in that verification session's execution environment — even though a
 * parallel plain `fetch()`-based long-poll to the SAME endpoint from the SAME
 * environment survived a full 15s idle window cleanly. This points at a real
 * bug specific to the raw-socket long-poll implementation, not at the SAP
 * server or a blanket environment limitation. Until that is fixed, the two
 * tests below that depend on `armListener()` completing (the main loop and
 * the idle-timeout test) are expected to fail at that step in an environment
 * with the same defect; the fixture-existence and batch-probe tests do not
 * depend on the long-poll and should pass independently. See that session's
 * final report for full evidence (raw captures, request ledger).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type TestContext } from "vitest";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { loadConfig, loadEnvFile, type Config } from "../src/config.js";
import {
  createDebugClientForConnection,
  DebugSession,
  listActiveDebugSessions,
  shutdownAllDebugSessions,
} from "../src/debug/session.js";
import { resolveTerminalId } from "../src/debug/client.js";
import type { DebugContext } from "../src/debug/types.js";
import { SafetyGate } from "../src/safety.js";
import { skipForApplianceState, underApplianceStateWatch } from "./live-appliance-state.js";

loadEnvFile();
const live = Boolean(process.env.ABAP_URL);
const d = live ? describe : describe.skip;

// `CreateDebugClientOptions.safety` is REQUIRED — this is the exact call site
// that a gate-less `DebugTransport` hitting `SAFETY_DENIED` on the first
// mutating debugger request (discovered only at runtime) would go through.
// One process-wide-shaped permissive gate, scoped to the `$TMP`/`ZMCP_DBG_*`
// fixtures this file already drives,
// reused at every `createDebugClientForConnection` call below.
//
// `allowNamePrefixes` is left at its default (`DEFAULT_NAME_PREFIXES`,
// `["Z", "Y"]` — src/safety.ts) rather than narrowed to `["ZMCP_"]`.
// `DebugClient.runBatch`/`setBreakpoints` called directly (as this file does,
// bypassing `abap_debug`'s target-resolving handler) hit `DebugTransport`'s
// `UNRESOLVED_DEBUG_TARGET` fallback (src/debug/transport.ts) — a synthetic
// `Z`-prefixed sentinel name, `ZDEBUG_TRANSPORT_UNRESOLVED_TARGET`, that
// transport.ts's own doc comment says is "built to clear those rules under
// the DEFAULT config". A narrower `["ZMCP_"]` allowlist — live-verified
// against this exact failure mode — excludes that sentinel and hard-refuses every
// mutating call this file makes with `ZDEBUG_TRANSPORT_UNRESOLVED_TARGET is
// outside the customer namespace`, which is a test-construction mismatch
// with transport.ts's documented contract, not a real object-scoping gap:
// the concrete fixtures this file touches are still all `ZMCP_DBG_*`,
// itself `Z`-prefixed, so the default is no wider than intended here.
const GATE = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });

// A crash class found live: DebugLongPollClient's ListenHandle.result can
// reject in the background (observed cause: ECONNRESET) during the window
// after armListener() has consumed only `handle.armed`, before
// waitForDebuggee() later attaches to `handle.result` — an unhandled
// rejection that crashes the whole process on Node's current default. This
// guard does not fix session.ts/transport.ts (not touched here); it only
// keeps a transient background rejection from taking down this whole test
// file uncleanly (skipping every `finally`/cleanup). Any rejection here is a
// live finding worth seeing, so it is logged loudly, never swallowed silently.
process.on("unhandledRejection", (reason: unknown) => {
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  process.stderr.write(`[integration-debug.test.ts] UNHANDLED REJECTION (suppressed, logged): ${msg}\n`);
});

const MAX = 120_000;
/**
 * Settle delay between `armListener()` RETURNING and firing the classrun
 * trigger. Registering an external breakpoint and arming the listener are
 * acknowledged by the server BEFORE the breakpoints are actually active in the
 * debuggee's work process — activation is asynchronous and is NOT synchronous
 * with the arm response. Trigger too early and the debuggee runs straight past
 * the breakpoint: live evidence is case 3 attaching at line 93 instead of 84
 * (execution had already passed 84 when activation landed) and case 4 coming
 * back `kind="timeout"` with nothing caught at all.
 *
 * The recipe is documented on `DebugClient.launchListener()`
 * (`src/debug/client.ts`, ~line 475): await `armed`, wait 2-3s, THEN trigger
 * the debuggee. Upper end of that range is used.
 */
const BREAKPOINT_ACTIVATION_SETTLE_MS = 3_000;
const DEMO_URI ="/sap/bc/adt/programs/programs/zmcp_dbg_demo/source/main";
const FILL_URI = "/sap/bc/adt/programs/programs/zmcp_dbg_fill/source/main";
const ITEM_URI = "/sap/bc/adt/ddic/tables/zmcp_dbg_item/source/main";
const RUN_URI = "/sap/bc/adt/oo/classes/zmcp_dbg_run/source/main";
const LAUNCHER = "ZMCP_DBG_RUN";

let connA: AbapConnection;
let connB: AbapConnection;
let cfg: Config;

const assertUsable = () => {
  if (connA.breaker.isTripped) {
    throw new Error(`circuit breaker tripped: ${connA.breaker.info?.message}`);
  }
};

/** Read-only `POST /sap/bc/adt/datapreview/freestyle` — the same recipe used to verify cleanliness. Never `Accept: application/xml` bare — that 406s. */
async function freestyleRowCount(conn: AbapConnection, sql: string): Promise<number | undefined> {
  const r = await conn.post(`/sap/bc/adt/datapreview/freestyle?rowNumber=200`, {
    headers: { "Content-Type": "text/plain", Accept: "*/*" },
    body: sql,
  });
  const m = /<dataPreview:totalRows>(\d+)<\/dataPreview:totalRows>/.exec(r.body);
  return m ? Number(m[1]) : undefined;
}

async function assertCleanDebugTables(conn: AbapConnection): Promise<void> {
  const counts = await readDebugTableCounts(conn);
  expect(counts.extdbps).toBe(0);
  expect(counts.listener).toBe(0);
  expect(counts.activation).toBe(0);
}

// ---------------------------------------------------------------------------
// PER-CASE TEARDOWN (added after the 2026-07-31 live run: 2 passed / 2 failed,
// where case 4 did NOT fail independently — it inherited case 3's still-attached
// debuggee and blew up as `AbapError: Debuggee already attached` out of
// `client.ts`'s `stopListener()`. One real failure, one cascaded one, because
// nothing between the cases put the appliance back to a known state.)
//
// The appliance has SEVEN dialog work processes. A stranded suspended debuggee
// holds one hostage, so the rules here are:
//   * cleanup runs after EVERY case, on every exit path, driven off the module
//     registry rather than off the case's local variables — a case killed by a
//     timeout or by an unhandled rejection never gets to run its own `finally`,
//     but its `DebugSession` is still in `activeSessions` and is still reachable;
//   * cleanup is idempotent and NEVER throws — a throwing teardown would be
//     reported in place of the case's real assertion failure, hiding the actual
//     defect (which is exactly what we are trying to stop happening);
//   * if cleanup cannot CONFIRM a clean appliance, the run aborts instead of
//     marching into the next case and wedging more work processes.
// ---------------------------------------------------------------------------

/** Set by teardown once it could not confirm a clean appliance. Every later case then fails immediately, before it makes a single live call. */
let abortRun: string | undefined;

/**
 * Set once in `beforeAll`, before any case has run. A dirty reading here is
 * someone else's stranded debuggee from an earlier run — appliance state, not
 * a regression in this run — so every case skips instead of failing. Distinct
 * from `abortRun`, which is about a case THIS run drove; that one still throws.
 */
let dirtyOnArrival: string | undefined;

/** One line per case: skip immediately, before any live call, when the appliance was already dirty on arrival. */
function skipIfDirtyOnArrival(ctx: TestContext): void {
  if (dirtyOnArrival) skipForApplianceState(ctx, dirtyOnArrival);
}

/**
 * Problems a case detected in its OWN `finally` (a failed `terminate()`, say)
 * that must end up in `abortRun` — but only once the per-case teardown below
 * has had its chance to clean up. A case must NOT assign `abortRun` directly:
 * that would trip `afterEach`'s "already aborted — do not touch the appliance
 * again" guard and skip the very cleanup a failed teardown calls for. Draining
 * this list is the first thing `afterEach` does, so the failure still becomes a
 * loud, run-aborting problem instead of a line in the log nobody reads.
 */
const pendingProblems: string[] = [];

/** Connections a single case opened for itself. Teardown owns their shutdown, never the case — a case that dies by timeout never reaches its own `finally`. */
const caseConnections = new Set<AbapConnection>();

/**
 * Every connection that DRIVES the debugger — `connA` plus each case's own control
 * connection (`connA2`, and whatever a future fifth case opens) — with a label for
 * the teardown log. The server binds a debug session to the STATEFUL HTTP SESSION,
 * not to the terminal id, so ANY of these can be the one still holding a suspended
 * debuggee; the last-resort sweep must walk all of them, not just `connA` (a
 * stranded debuggee holds one of the seven dialog work processes hostage).
 * Registration happens in `openCaseConnection()`, so a new case cannot silently
 * escape the sweep by forgetting a hardcoded list.
 *
 * Trigger connections (`connB`/`connB2`) are deliberately NOT registered: they only
 * fire classrun POSTs, they never touch `DebugTransport`, they cannot be the session
 * a debuggee is attached to, and putting a debug client on one would make it
 * permanently stateful for no gain (see the file header).
 */
const debugControlConnections = new Map<AbapConnection, string>();

const tlog = (msg: string) => process.stderr.write(`[integration-debug.test.ts] teardown: ${msg}\n`);
const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** Both live cases' debug contexts, defined once so teardown can address the very listeners the cases registered. */
function debugContext(seed: "main" | "idle"): DebugContext {
  return {
    debuggingMode: "user",
    terminalId: resolveTerminalId({ seed: `abapsmith-integration-debug-${seed}-terminal` }),
    ideId: resolveTerminalId({ seed: `abapsmith-integration-debug-${seed}-ide` }),
    requestUser: cfg.user,
  };
}
const SEEDS = ["main", "idle"] as const;

/**
 * `role` decides whether the connection joins the last-resort sweep registry:
 * `"debug-control"` for a connection debugger calls go through (it can end up
 * holding a suspended debuggee), `"trigger"` for a plain classrun POST connection
 * that must stay stateless.
 */
async function openCaseConnection(role: "debug-control" | "trigger"): Promise<AbapConnection> {
  const conn = new AbapConnection(cfg, { log: () => {}, breaker: new AuthCircuitBreaker() });
  caseConnections.add(conn); // registered BEFORE connect(), so a failed connect is still torn down
  if (role === "debug-control") {
    // Also BEFORE connect(): a connect that fails half-way can still have left a
    // stateful session behind, and the sweep tolerates an unusable connection.
    debugControlConnections.set(conn, `case control connection #${debugControlConnections.size}`);
  }
  await conn.connect();
  return conn;
}

/**
 * Drains `caseConnections`. Never throws. Also de-registers each connection from the
 * sweep registry — once shut down it can no longer issue a single cleanup call, so
 * keeping it there would only make a later sweep log noise against a dead handle.
 */
async function shutdownCaseConnections(reason: string): Promise<void> {
  for (const conn of [...caseConnections]) {
    caseConnections.delete(conn);
    debugControlConnections.delete(conn);
    try {
      await conn.shutdown(reason);
    } catch (e) {
      tlog(`case connection shutdown failed (${reason}): ${errText(e)}`);
    }
  }
}

interface DebugTableCounts {
  extdbps: number | undefined;
  listener: number | undefined;
  activation: number | undefined;
}

/** Read-only. Never throws: an unreadable count comes back as `undefined`, which teardown treats as "could not confirm" (i.e. not clean). */
async function readDebugTableCounts(conn: AbapConnection): Promise<DebugTableCounts> {
  const read = async (sql: string): Promise<number | undefined> => {
    try {
      return await freestyleRowCount(conn, sql);
    } catch (e) {
      tlog(`could not read \`${sql}\`: ${errText(e)}`);
      return undefined;
    }
  };
  const [extdbps, listener, activation] = await Promise.all([
    read("SELECT * FROM abdbg_extdbps"),
    read("SELECT * FROM abdbg_listener"),
    read("SELECT * FROM abdbg_activation"),
  ]);
  return { extdbps, listener, activation };
}

const countsAreClean = (c: DebugTableCounts) => c.extdbps === 0 && c.listener === 0 && c.activation === 0;
const describeCounts = (c: DebugTableCounts) =>
  `abdbg_extdbps=${c.extdbps ?? "?"} abdbg_listener=${c.listener ?? "?"} abdbg_activation=${c.activation ?? "?"}`;

/**
 * The one bounded last-resort sweep, run ONLY when the read-only check says the
 * appliance is still dirty after the ordered session cleanup. Not a retry loop:
 * a single pass, every step swallowed, and the state is re-read once afterwards —
 * if it is still dirty the run aborts rather than trying again.
 *
 * This is what breaks the observed cascade: `DebugSession.terminate()` can decide
 * it has nothing to terminate while `connA` ITSELF is still attached server-side,
 * and a connection-level attachment poisons the NEXT case's listener calls.
 *
 * NOTE — `terminateDebuggee()` answers with HTTP 500 (`CX_TPDA_SYS_COMM_DBGSESSIONEND`)
 * ON SUCCESS. `DebugClient.terminateDebuggee()` (`client.ts:566`)
 * already unwraps that into `{terminated:true}`, so it resolves rather than rejecting
 * and nothing here must "handle" the 500. Do not add a status check that re-reads
 * that 500 as a failure — it would make teardown report failure on every single case.
 */
async function lastResortDetach(): Promise<void> {
  // EVERY registered debug-control connection, not just `connA`: the attachment is
  // bound to the stateful HTTP session, so the connection still holding the debuggee
  // may well be a case's own (`connA2`). One unusable or throwing connection must
  // never stop the others from being attempted — hence a try/catch per step, per
  // connection, all of them silent-but-logged.
  if (debugControlConnections.size === 0) {
    tlog("skipping last-resort detach — no debug control connection registered");
    return;
  }
  for (const [conn, label] of debugControlConnections) {
    if (!conn || conn.breaker.isTripped) {
      tlog(`skipping last-resort detach on ${label} — connection unusable`);
      continue;
    }
    let client: ReturnType<typeof createDebugClientForConnection>;
    try {
      client = createDebugClientForConnection(conn, { safety: GATE, listenTimeoutSeconds: 60 });
    } catch (e) {
      tlog(`last-resort detach could not build a debug client on ${label}: ${errText(e)}`);
      continue;
    }
    try {
      await client.terminateDebuggee();
      tlog(`last-resort terminateDebuggee() on ${label} succeeded (500-shaped success is unwrapped by the client)`);
    } catch (e) {
      // NOT_CONNECTED here is the ordinary, expected answer: nothing was attached.
      tlog(`last-resort terminateDebuggee() on ${label} did not apply: ${errText(e)}`);
    }
    for (const seed of SEEDS) {
      try {
        await client.stopListener(debugContext(seed));
      } catch (e) {
        tlog(`last-resort stopListener(${seed}) on ${label} did not apply: ${errText(e)}`);
      }
    }
  }
}

d("live debug-session verification (A4H)", () => {
  beforeAll(async () => {
    cfg = loadConfig();
    connA = new AbapConnection(cfg, { log: () => {}, breaker: new AuthCircuitBreaker() });
    connB = new AbapConnection(cfg, { log: () => {}, breaker: new AuthCircuitBreaker() });
    await underApplianceStateWatch("integration-debug beforeAll connect connA", () => connA.connect());
    // Baseline, before any case runs: dirty here means someone else's stranded
    // debuggee, not ours. `readDebugTableCounts` never throws (unreadable
    // counts come back `undefined`, which `countsAreClean` treats as dirty too).
    const baseline = await underApplianceStateWatch("integration-debug beforeAll baseline read", () =>
      readDebugTableCounts(connA),
    );
    if (!countsAreClean(baseline)) {
      dirtyOnArrival =
        `appliance already dirty on arrival (${describeCounts(baseline)}) — a stranded debug ` +
        "session from an earlier run. Clear it manually (SM50 / abdbg_extdbps) before re-running.";
    }
    await underApplianceStateWatch("integration-debug beforeAll connect connB", () => connB.connect());
    // `connA` is a debug-control connection too (cases 2 and 3 drive the debugger
    // over it), so it must be in the sweep registry like every case's own.
    debugControlConnections.set(connA, "connA");
  }, 60_000);

  afterAll(async () => {
    // Belt and braces: teardown has already run per case, and every step of this
    // is idempotent, but the debug sessions must be gone BEFORE their connection is.
    await shutdownAllDebugSessions(tlog).catch((e: unknown) => tlog(`afterAll shutdown failed: ${errText(e)}`));
    await shutdownCaseConnections("test-end");
    debugControlConnections.delete(connA);
    await connA?.shutdown("test-end");
    await connB?.shutdown("test-end");
    // Explicit timeout: `vitest.config.ts` sets `hookTimeout: 30_000`, which is
    // not enough for a cleanup sweep that may have to terminate a debuggee.
  }, 60_000);

  // Fail fast rather than march into another case on a wedged appliance. This
  // throws BEFORE any live call is made, so an aborted run costs nothing.
  beforeEach(() => {
    if (abortRun) {
      throw new Error(
        `ABORTED: an earlier case's teardown could not confirm a clean appliance (${abortRun}). ` +
          `Refusing to start another live debug case — a stranded debuggee holds one of the seven ` +
          `dialog work processes. Clear the debug session manually (SM50 / ` +
          `abdbg_extdbps) before re-running.`,
      );
    }
  });

  /**
   * Ordering is deliberate and each step depends on the one before it:
   *
   *  1. `shutdownAllDebugSessions()` FIRST — it is the only informed path, and it
   *     runs the sequence the server actually accepts (best-effort attach →
   *     terminateDebuggee → stopListener → clear breakpoints, `session.ts:922-975`).
   *     The debuggee must go before the listener that caught it, and the
   *     breakpoints must go last or the next case re-hits a stale one. It is
   *     driven off the module registry, so it reaches sessions a timed-out or
   *     rejection-killed case never handed back.
   *  2. Read-only verification next — it observes the result of 1.
   *  3. Only if that says "dirty": one bounded last-resort detach across EVERY
   *     registered debug-control connection (`connA` AND each case's own), because
   *     the session still holding the debuggee is bound to a connection, and that
   *     connection may not be `connA`.
   *  4. Per-case connections are released AFTER that sweep — a connection that has
   *     already been shut down can no longer issue a single cleanup call, and the
   *     sweep's whole point is to speak over the very connection that may still be
   *     attached — but still BEFORE the ONE re-read, so their sessions are gone when
   *     the verdict is taken. Still dirty (or unreadable) ⇒ abort the whole run.
   *
   * Idempotency: `terminate()` returns immediately on an already-dead session and
   * removes itself from the registry; the connection set is drained as it is
   * walked; the last-resort calls tolerate NOT_CONNECTED. Running this twice in a
   * row does nothing the second time. It never throws — every failure is logged
   * and folded into `abortRun` instead, so the case's own assertion failure stays
   * the reported one.
   */
  afterEach(async () => {
    if (abortRun) return; // already aborted — do not touch the appliance again
    // Anything the case itself reported (see `pendingProblems`) counts as a
    // problem for THIS case, and is drained before cleanup runs so a failed
    // in-case teardown still aborts the run — after the sweep, not instead of it.
    const problems: string[] = pendingProblems.splice(0);

    try {
      await shutdownAllDebugSessions(tlog);
    } catch (e) {
      problems.push(`shutdownAllDebugSessions threw: ${errText(e)}`);
    }
    const undead = listActiveDebugSessions().filter((s) => s.snapshot.status !== "dead");
    if (undead.length > 0) {
      problems.push(`${undead.length} DebugSession(s) still registered and not dead after cleanup`);
    }

    if (!connA) {
      problems.push("connection A never came up — cannot confirm a clean appliance");
      await shutdownCaseConnections("per-case teardown");
    } else {
      let counts = await readDebugTableCounts(connA);
      const dirty = !countsAreClean(counts);
      if (dirty) {
        tlog(`appliance still dirty after session cleanup (${describeCounts(counts)}) — one last-resort sweep`);
        await lastResortDetach();
      }
      // Only now: see step 4 of the ordering above. The sweep needs the case's own
      // control connection ALIVE to be able to detach over it.
      await shutdownCaseConnections("per-case teardown");
      if (dirty) {
        counts = await readDebugTableCounts(connA);
        if (!countsAreClean(counts)) {
          problems.push(`server-side debug state not confirmed clean: ${describeCounts(counts)}`);
        }
      }
    }

    if (problems.length > 0) {
      abortRun = problems.join("; ");
      tlog(`COULD NOT CONFIRM A CLEAN APPLIANCE — aborting remaining cases: ${abortRun}`);
    }
  }, MAX);

  it(
    "the four ZMCP_DBG_* fixtures still exist and are active",
    async (ctx) => {
      skipIfDirtyOnArrival(ctx);
      assertUsable();
      const [demo, run, fill, item] = await Promise.all([
        connA.get(DEMO_URI, { headers: { Accept: "text/plain" } }),
        connA.get(RUN_URI, { headers: { Accept: "text/plain" } }),
        connA.get(FILL_URI, { headers: { Accept: "text/plain" } }),
        connA.get(ITEM_URI, { headers: { Accept: "text/plain" } }),
      ]);
      expect(demo.status).toBe(200);
      expect(run.status).toBe(200);
      expect(fill.status).toBe(200);
      expect(item.status).toBe(200);
    },
    MAX,
  );

  it(
    "the batch endpoint round-trips a multipart request with an embedded per-sub-response status",
    async (ctx) => {
      skipIfDirtyOnArrival(ctx);
      assertUsable();
      // Nobody had live-probed /sap/bc/adt/debugger/batch before. Connection A is NOT
      // attached to anything here, so the single sub-operation is expected
      // to come back with a noSessionAttached-shaped failure status — the
      // point of this test is that the multipart envelope itself decodes
      // into a real, independent per-operation BatchResult, not that the
      // sub-operation succeeds.
      const client = createDebugClientForConnection(connA, { safety: GATE, listenTimeoutSeconds: 60 });
      const stackOp = {
        method: "POST" as const,
        path: "/sap/bc/adt/debugger?method=getStack&emode=_&semanticURIs=true",
      };
      const results = await client.runBatch([stackOp]);
      expect(results).toHaveLength(1);
      expect(results[0]!.status).toBeGreaterThanOrEqual(400);
    },
    MAX,
  );

  it(
    "drives attach/variables/step through DebugSession, probes setStackPosition and setDebuggerSettings, and leaves no server-side trace",
    async (ctx) => {
      skipIfDirtyOnArrival(ctx);
      assertUsable();
      const client = createDebugClientForConnection(connA, { safety: GATE, listenTimeoutSeconds: 60 });
      const context: DebugContext = debugContext("main");
      const session = new DebugSession({ client, context, idleTimeoutMs: 300_000, listenerTimeoutSeconds: 60 });

      let triggerP: Promise<{ status: number; body: string }> | undefined;
      let bodyCompleted = false;
      try {
        const created = await session.prepareBreakpoints([
          { kind: "line", clientId: "stop1", uri: `${DEMO_URI}#start=84` },
          { kind: "line", clientId: "stop2", uri: `${DEMO_URI}#start=93` },
        ]);
        expect(created).toHaveLength(2);

        await session.armListener();
        expect(session.snapshot.status).toBe("listening");

        // Do NOT trigger immediately — see BREAKPOINT_ACTIVATION_SETTLE_MS.
        await new Promise((r) => setTimeout(r, BREAKPOINT_ACTIVATION_SETTLE_MS));

        triggerP = connB.post(`/sap/bc/adt/oo/classrun/${LAUNCHER}`, { headers: { Accept: "text/plain" } });

        const listenResult = await session.waitForDebuggee();
        expect(listenResult.kind).toBe("debuggee");
        if (listenResult.kind !== "debuggee") return;

        const a1 = await session.attach(listenResult.debuggee.id);
        let stateId = a1.stateId;
        // Diagnostic (not an assertion): records the REAL attach-time frame shape so the
        // launcher-dependent base stack depth is observable in the next live run's output.
        console.log(
          `[attach] frames=${a1.stack.frames.length} ${JSON.stringify(
            a1.stack.frames.map((f) => ({ p: f.programName, i: f.includeName, l: f.line })),
          )}`,
        );
        expect(a1.stack.frames[0]?.programName).toBe("ZMCP_DBG_DEMO");
        expect(a1.stack.frames[0]?.line).toBe(84);

        const rootVars = await session.getRootVariables(stateId);
        expect(rootVars.variables.variables.some((v) => v.name === "LT_ITEMS")).toBe(true);
        expect(rootVars.variables.variables.some((v) => v.name === "LV_GRAND_TOTAL")).toBe(true);

        const s1 = await session.step(stateId, "stepOver");
        stateId = s1.stateId;
        expect(s1.stack.frames[0]?.line).toBe(85);

        const s2 = await session.step(stateId, "stepOver");
        stateId = s2.stateId;
        expect(s2.stack.frames[0]?.line).toBe(87);

        const s3 = await session.step(stateId, "stepInto");
        stateId = s3.stateId;
        expect(s3.stack.frames.length).toBe(s2.stack.frames.length + 1);
        expect(s3.stack.frames[0]?.line).toBe(42); // inside lcl_calc=>line_value

        // --- setStackPosition probe ---
        const frames = s3.stack.frames;
        const currentPos = frames[0]!.stackPosition;
        const targetFrame = frames.find((f) => f.stackPosition !== currentPos) ?? frames[1]!;
        // Deliberately not asserting a specific outcome shape here: this is
        // the open question itself. Record what actually happens rather than
        // encoding an assumption — a throw is caught and reported via the
        // test's own failure message (with the real error code/status
        // visible), a success is followed by re-reading the stack so the
        // cursor-move evidence is visible in the same run.
        await session.setStackPosition(stateId, { stackPosition: targetFrame.stackPosition, stackType: "ABAP" });
        const afterStack = await session.getStack(stateId);
        expect(afterStack.frames.length).toBeGreaterThan(0);

        // --- setDebuggerSettings probe ---
        const baseline = s3.step.settings;
        const flipped = { ...baseline, showDataAging: !baseline.showDataAging };
        // Assert against the POST's OWN response body — the server's authoritative echo of
        // what it applied. Run 5 asserted against the next step response's settings snapshot
        // instead and failed: that snapshot rides on the stop event and is NOT a contract.
        const applied = await session.setDebuggerSettings(flipped);
        expect(applied.showDataAging).toBe(flipped.showDataAging);
        const s4 = await session.step(stateId, "stepReturn");
        stateId = s4.stateId;
        // RECORDING ONLY, deliberately not an assertion (see above). Kept so the run log shows
        // whether the step echo tracks the applied settings on this system.
        console.log(
          `[settings-echo] requested showDataAging=${flipped.showDataAging} ` +
            `applied(POST echo)=${applied.showDataAging} stepEcho=${s4.step.settings.showDataAging}`,
        );

        if (session.snapshot.status === "suspended") {
          await session.step(stateId, "stepContinue");
        }
        bodyCompleted = true;
      } finally {
        // A failed terminate() here is NOT cosmetic: it means this case may still
        // hold a suspended debuggee / an attached debug session server-side, and
        // the next case then fails for a reason that has nothing to do with it
        // ("Debuggee already attached"). So it is logged AND recorded, and
        // `afterEach` turns it into `abortRun` once it has run its own sweep —
        // a failed teardown now fails loudly instead of poisoning the next case.
        await session.terminate().catch((e: unknown) => {
          const detail = `case 3 terminate() failed: ${errText(e)}`;
          tlog(detail);
          pendingProblems.push(detail);
        });
        // Assert terminate() reached "dead" ONLY when the body itself got that
        // far. On a body that already failed, this same expect() would be
        // reported IN PLACE OF the real assertion failure — the exact masking
        // that turned one live failure into two. The unconditional guarantee
        // now lives in afterEach, which cannot throw.
        if (bodyCompleted) expect(session.snapshot.status).toBe("dead");
        if (triggerP) await triggerP.catch(() => undefined);
      }

      await assertCleanDebugTables(connA);
    },
    MAX,
  );

  it(
    "the idle timeout fires on schedule and genuinely releases the server-side debug session",
    async (ctx) => {
      skipIfDirtyOnArrival(ctx);
      assertUsable();
      // This case drives the debugger over its OWN connection, not `connA`. The
      // server binds a debug session to the STATEFUL HTTP SESSION, not to the
      // terminal id — `debugContext("idle")` only scopes the listener and the
      // breakpoints — so a different terminal id buys this case no isolation at
      // all from whatever case 3 left attached on `connA`. Live evidence: run 4
      // failed right here, at the attach below, with "Debuggee already attached",
      // on a connection this case never attached anything on itself.
      // Both connections are opened through `openCaseConnection()`, which
      // registers them with teardown BEFORE `connect()`, so they are shut down on
      // every exit path — including a timeout or a background rejection that
      // never reaches this case's own `finally` (see the PER-CASE TEARDOWN block).
      const connA2 = await openCaseConnection("debug-control");
      const client = createDebugClientForConnection(connA2, { safety: GATE, listenTimeoutSeconds: 60 });
      const context: DebugContext = debugContext("idle");
      const session2 = new DebugSession({ client, context, idleTimeoutMs: 8_000, listenerTimeoutSeconds: 60 });
      const connB2 = await openCaseConnection("trigger");

      let triggerP2: Promise<{ status: number; body: string }> | undefined;
      let savedStateId: string | undefined;
      try {
        await session2.prepareBreakpoints([{ kind: "line", clientId: "idle1", uri: `${DEMO_URI}#start=84` }]);
        await session2.armListener();

        // Do NOT trigger immediately — see BREAKPOINT_ACTIVATION_SETTLE_MS.
        await new Promise((r) => setTimeout(r, BREAKPOINT_ACTIVATION_SETTLE_MS));

        triggerP2 = connB2.post(`/sap/bc/adt/oo/classrun/${LAUNCHER}`, { headers: { Accept: "text/plain" } });

        const lr = await session2.waitForDebuggee();
        expect(lr.kind).toBe("debuggee");
        if (lr.kind !== "debuggee") return;

        const a2 = await session2.attach(lr.debuggee.id);
        savedStateId = a2.stateId;
        expect(session2.snapshot.status).toBe("suspended");

        // Deliberately NO calls of any kind for longer than idleTimeoutMs —
        // no keepalive(), no step, nothing. Real wall-clock wait.
        await new Promise((r) => setTimeout(r, 16_000));

        expect(session2.snapshot.status).toBe("dead");
        expect(session2.snapshot.deathReason).toBe("idle_timeout");

        // Proves the SERVER-side session, not just the client object, is
        // gone — the stateId is still recorded on a "dead" session, so a
        // real network call is issued and must throw.

        await expect(session2.getStack(savedStateId)).rejects.toMatchObject({
          code: expect.stringMatching(/SESSION_DEAD|NOT_CONNECTED/),
        });
      } finally {
        // Recorded, exactly like case 3 — a rejection here is a real defect, NOT an
        // expected consequence of this case ending on an already-dead session:
        //   * on the happy path the idle timeout has already fired, and
        //     `DebugSession.terminate()` returns immediately on a `"dead"` session
        //     (`src/debug/session.ts:896`) WITHOUT issuing a single call, so there is
        //     nothing there that can legitimately reject;
        //   * on every path where the body failed EARLIER (arm, trigger, attach, or
        //     the idle timeout not firing at all) the session is still live and may
        //     still hold a suspended debuggee — case 3's situation exactly;
        //   * and `doTerminate()` swallows and deadlines every network step itself,
        //     so even a server-side failure resolves rather than rejects.
        // A rejection therefore means the guaranteed-cleanup contract broke, which is
        // precisely what must abort the run rather than be logged and forgotten.
        await session2.terminate().catch((e: unknown) => {
          const detail = `case 4 terminate() failed: ${errText(e)}`;
          tlog(detail);
          pendingProblems.push(detail);
        });
        if (triggerP2) await triggerP2.catch(() => undefined);
        // connA2/connB2 are NOT shut down here — afterEach owns every connection
        // `openCaseConnection()` handed out, so they are released on every exit
        // path including the ones that skip this `finally` entirely.
      }

      await assertCleanDebugTables(connA);
    },
    MAX,
  );
});
