/**
 * `abap_debug` / `abap_debug_vars` / `abap_debug_value` — MCP tool surface for
 * the ABAP debugger (M7b).
 *
 * Pure orchestration: never talks to `DebugClient` or raw HTTP directly.
 * State lives in `DebugSession` (`src/debug/session.ts`); variable rendering
 * lives in `src/debug/render.ts`. This file:
 *   - owns the module-level "current debug session" registry — one slot
 *     ("lane") per concurrent session this process is configured for
 *     (`resolveDebugSessionLimit(cfg)`, `src/adt/pool.ts`; default 1, the
 *     historical "one session per process" behaviour, unchanged when
 *     `ABAP_DEBUG_SESSIONS` is unset),
 *   - drives the two-connection choreography a debug session needs (one
 *     connection arms the listener and waits; a second, independent
 *     connection fires the trigger that hits the breakpoint —
 *     `DebugToolDeps.createTriggerConnection`),
 *   - translates `DebugSession`/`render.ts` output into the standard
 *     `buildResponse` envelope.
 *
 * Read-only debugger, with one exception: `action:"frame"` exposes
 * `setStackPosition`, live-verified to move only the server-side READ cursor
 * — zero effect on what the debuggee executes next. `setVariableValue` stays
 * unexposed; `"frame"` must never become a foothold for it. See
 * the git history for the full original header.
 */
import { z } from "zod";
import type { AbapConnection } from "../adt/connection.js";
import { AbapError, describeUnknownError, isAbapError, type AbapErrorCode } from "../adt/errors.js";
import {
  parseObjectRef,
  resolveObject as resolveObjectLive,
  type ResolvedObject,
} from "../adt/resolve.js";
import type { Config } from "../config.js";
import { buildResponse, type BuiltResponse } from "../compact.js";
import type { AuthorizedTarget, EvaluateOptions, SafetyGate, SafetyTarget } from "../safety.js";
import {
  createDebugClientForConnection,
  DebugSession,
  forceDropDebugSession,
  listActiveDebugSessions,
  shortStateId,
  stateIdMatches,
  type DebugSessionOptions,
  type DebugTerminationResult,
} from "../debug/session.js";
import { resolveDebugIdentity, warnIfDerivedIdentity } from "../debug/identity.js";
import { createDebugArmLocks } from "../debug/arm-lock.js";
import { resolveStateDir } from "../state-dir.js";
import { ADT_REST_DATA_INVALID_TEXT, type DebugSessionLease } from "../debug/transport.js";
import { withStartFragment } from "../debug/endpoints.js";
import type { PoolSlot, SessionPool } from "../adt/pool.js";
import {
  DEBUG_MAX_CHARS,
  formatPath,
  isComplex,
  renderDrill,
  renderEmptyBodyTrap,
  renderInline,
  renderScalar,
  renderStackSection,
  renderSurvey,
  validatePath,
  withChildren,
  type VariableNode,
} from "../debug/render.js";
import { alignRequestedVariables, DebugXmlParseError } from "../debug/xml-response.js";
import { budgetWithNotes, GuidanceLedger, type GuidanceNote } from "../debug/guidance.js";
import { isPostMortemKind } from "../debug/types.js";
import { readBadiImplementation, readEnhancementSpot, readSourceCodePlugin } from "../adt/enhancement.js";
import type {
  Breakpoint,
  CreatedBreakpoint,
  DebugStack,
  DebugStepKind,
  DebugVariable,
  StateId,
  Watchpoint,
} from "../debug/types.js";
import { abapRun, type RunInput } from "./run.js";
// B2 (issue #89): multi-lane debug sessions. `resolveDebugSessionLimit` reads
// ABAP_DEBUG_SESSIONS/ABAP_DEBUG_DIA_BUDGET (src/adt/pool.js) to decide how
// many concurrent `DebugSession`s this PROCESS will hold; `DebugArmLock` is
// one-per-lane below (`createDebugArmLocks`, src/debug/arm-lock.js).
import { resolveDebugSessionLimit } from "../adt/pool.js";

// ---------------------------------------------------------------------------
// Dependency injection seam — makes this file offline-testable without a real
// AbapConnection/DebugSession.
// ---------------------------------------------------------------------------

/**
 * Outcome of the fire-and-forget trigger run, once it settles. Never rejects.
 * `code` preserves a stable `AbapError.code` (e.g. `"RUNTIME_DUMP"`) instead of
 * flattening it into `error`, so a genuine ABAP short dump can be told apart
 * from an ordinary trigger failure structurally. See archive.
 */
export type DebugTriggerOutcome =
  | { ok: true; text: string }
  | { ok: false; error: string; code?: AbapErrorCode };

/**
 * Outcome of `DebugToolDeps.releaseOrphanListener`. `"absent"` is the common
 * case; `"conflict"` is the one wire shape `DebugClient.getListener` cannot
 * confidently classify — reported rather than guessed at.
 */
export type OrphanListenerResult =
  | { kind: "absent" }
  | { kind: "released" }
  | { kind: "conflict"; detail: string };

/**
 * Outcome of `DebugToolDeps.releaseOrphanDebuggee` — sibling force-clear for an
 * ATTACHED (suspended) debuggee, not merely an armed listener. `"absent"` is
 * the common case; `"unknown"` covers any other failure, reported not guessed.
 * Unlike `releaseOrphanListener`, NEVER invoked automatically — terminating a
 * suspended debuggee is destructive, so only explicit `force:true` triggers it.
 */
export type OrphanDebuggeeResult =
  | { kind: "absent" }
  | { kind: "released" }
  | { kind: "unknown"; detail: string };

export interface DebugToolDeps {
  /**
   * Bind a fresh DebugSession to `conn` (connection A, the one the debugger
   * listens on). `safety`/`target` are the SAME gate/target this module
   * judges its own writes against, forwarded so the transport can refuse a
   * mutating debugger request underneath the tool-level check too. `safety`
   * is a required parameter (not buried in optional `opts`) so it can never
   * be silently omitted — see archive (D15).
   */
  createSession(
    conn: AbapConnection,
    safety: SafetyGate,
    opts?: {
      log?: (msg: string) => void;
      target?: SafetyTarget;
      sessionLease?: DebugSessionLease;
      /**
       * Which concurrent-session slot (0-based) this session occupies —
       * selects both the per-lane `DebugArmLock` and
       * `resolveDebugIdentity(cfg, lane)`'s (terminalId, ideId) pair.
       * Optional and defaulting to 0 so every existing test double/call site
       * that never heard of lanes keeps building lane 0 — byte-identical to
       * the pre-B2 single-session behaviour.
       */
      lane?: number;
    },
  ): DebugSession;
  /** Produce a second, independent, already-CONNECTED AbapConnection for firing the trigger. */
  createTriggerConnection(): Promise<AbapConnection>;
  /**
   * Mint a dedicated, already-CONNECTED `AbapConnection` that the
   * `DebugSession`'s `DebugClient` is built on for this session's ENTIRE
   * life, and that is shut down and discarded outright (never returned to
   * a pool) when the session ends — see `makeSessionConnCloser`. Nothing
   * else ever shares its stateful ADT session (`sap-contextid`), so the
   * "Debuggee already attached" defect `dropDebugSessionOnConnection`
   * documents cannot recur: there is no SHARED connection left for a later
   * `start` to inherit a stale attachment from.
   *
   * Optional purely so hand-built test literals may omit it. When absent,
   * `handleStart` falls back to the leased slot's connection (`slot?.conn
   * ?? conn`) — the historical behaviour, still exercised by the M14 test
   * above and by the fallback tests in the M15 block (issue #89).
   */
  createDebugSessionConnection?(): Promise<AbapConnection>;
  /** Resolve an object ref on `conn` — defaults to `resolveObject` from adt/resolve.js. Injected so tests don't need a real connection. */
  resolveObject(conn: AbapConnection, ref: string): Promise<ResolvedObject>;
  /**
   * Fire the trigger and return its output — defaults to `abapRun`. Injected
   * so tests can fake "the program ran and printed X" without a real
   * connection. `gate` is required so a deps literal can't omit it and get an
   * ungated trigger run by accident.
   */
  triggerRun(conn: AbapConnection, input: RunInput, maxChars: number, gate: SafetyGate): Promise<BuiltResponse>;
  /** Optional sink for teardown diagnostics that must never become an exception. */
  log?: (msg: string) => void;
  /**
   * How many concurrent debug lanes this process is configured for —
   * `resolveDebugSessionLimit(cfg)` (`src/adt/pool.ts`), surfaced through
   * `DebugToolDeps` the same way `allowJumpToLine` surfaces a cfg-derived
   * scalar without threading `Config` itself through every handler.
   * Optional, defaulting to `1` (see `laneLimit` below), so every existing
   * test double/call site that never heard of lanes keeps building exactly
   * one — byte-identical to the pre-B2 single-session behaviour.
   */
  debugLaneCount?: number;
  /**
   * Reserve the pooled session this debug session will own for its whole
   * life. Always supplied by `createLiveDebugToolDeps`; optional so hand-built
   * test literals may omit it. Handed to `createSession` as `sessionLease`
   * and released exactly once, by `DebugSession.doTerminate`'s `finally`.
   */
  reserveDebugSession?(op: string): Promise<PoolSlot>;
  /**
   * Server-level ceiling for `step:"jumpToLine"` (`ABAP_ALLOW_DEBUG_JUMP_TO_LINE`).
   * `undefined` reads as `false` — omitting it in test literals gives the
   * disabled (refusing) behaviour, never an accidental grant.
   */
  allowJumpToLine?: boolean;
  /**
   * Best-effort release of a debug listener armed at THIS server's own
   * deterministic (terminalId, ideId) identity with no tracked debug lane in this
   * process to route a `stop` through — e.g. an earlier process instance
   * armed it and exited uncleanly.
   */
  releaseOrphanListener?(conn: AbapConnection): Promise<OrphanListenerResult>;
  /**
   * Force-clear a debuggee ATTACHED (suspended) at THIS server's own
   * identity with no tracked debug lane to route a `stop` through — the
   * debuggee-shaped counterpart to `releaseOrphanListener`. Needed because a
   * hard process crash cannot run in-process cleanup, so SAP keeps holding
   * the attachment and the next `start` fails with "Debuggee already
   * attached" — this is the escape hatch that error's `hint` names
   * (`abap_debug({action:"stop", force:true})`). Identity-scoped like
   * `releaseOrphanListener`: can only reach a debuggee this server's own
   * identity produced. Explicit-only — never invoked by a bare `stop`, only
   * `force:true`. See archive for the full incident writeup.
   */
  releaseOrphanDebuggee?(conn: AbapConnection): Promise<OrphanDebuggeeResult>;
}

/**
 * Build the real, network-backed `DebugToolDeps`. `createSession` derives a
 * stable `terminalId`/`ideId` pair from `cfg.sid`/`cfg.user` (an explicit
 * `cfg.terminalId` override wins, like `resolveTerminalId`) — both must stay
 * identical for the whole session's life, derived fresh per call since only
 * one session is ever created at a time.
 */
export function createLiveDebugToolDeps(params: {
  cfg: Config;
  log: (msg: string) => void;
  /**
   * The pool that owns this debugger: supplies the debug lease AND mints the
   * trigger connection, so the trigger connection shares the process-wide
   * auth circuit breaker (pool law L3). Required, not optional — an optional
   * pool would just move the hole into the `undefined` branch.
   */
  pool: SessionPool;
  /**
   * Required for the same reason `pool` is: `releaseOrphanListener` issues a
   * DELETE, and `DebugTransport.authorizeMutation` hard-refuses any mutating
   * debugger request built with no gate. Must be the SAME process-wide
   * instance `server.ts` built (D15).
   */
  gate: SafetyGate;
}): DebugToolDeps {
  // One lock PER LANE for this process, shared by `createSession` and the
  // `releaseOrphanDebuggee` probe — both arm a listener at the same identity
  // and must be counted by the same lock. Built over `resolveStateDir`, like
  // `AdtSessionPool`'s `FileLockObjectGate`. `enabled`/`waitMs` come from the
  // parsed `Config` rather than re-derived from `process.env`. `armLocks[0]`
  // is byte-identical to the single lock this used to build (see
  // `debugArmLockPath`'s lane-0 doc comment, src/debug/arm-lock.js).
  const laneCount = resolveDebugSessionLimit(params.cfg);
  const armLocks = createDebugArmLocks({
    lanes: laneCount,
    stateDir: resolveStateDir(process.env),
    cfg: params.cfg,
    enabled: params.cfg.crossProcessDebugLock,
    waitMs: params.cfg.debugLockWaitMs,
  });
  return {
    debugLaneCount: laneCount,
    createSession(conn, safety, opts) {
      // D15 — hand the gate and the debuggee down to `DebugTransport`. Not a
      // second policy source: whatever `handleStart` passes here is the very
      // instance/target it asserted against itself one layer up.
      const client = createDebugClientForConnection(conn, {
        safety,
        target: opts?.target,
      });
      // terminalId/ideId are deterministic hashes of SID:user, so two
      // processes for the same SID+user collide unless ABAP_TERMINAL_ID/
      // ABAP_IDE_ID overrides them apart. But a distinct pair for the SAME
      // user trips a 409 (AdiFailed/conflictDetected) on a second global-scope
      // listener; the SAME pair avoids the 409 but risked wedging in testing.
      // There is no confirmed way to run two independent global-scope debug
      // listeners for one SAP user concurrently.
      //
      // `debuggingMode: "user"` below is deliberate, not an oversight:
      // terminal-scope listeners arm without conflict but were measured to
      // NEVER catch a debuggee (0/7 live trials; ADT/HTTP-triggered debuggees
      // carry no TERMINAL_ID for a terminal-keyed scope to match). Untested:
      // a debuggee started from a real SAP GUI session, which might populate
      // TERMINAL_ID and behave differently. Full experiment writeup: see
      // the git history.
      //
      // `opts?.lane` defaults to 0 so a call site that never heard of lanes
      // (every existing test double, and every real call at the shipped
      // ABAP_DEBUG_SESSIONS=1 default) gets byte-identical identity/lock
      // selection to before lanes existed.
      const lane = opts?.lane ?? 0;
      const identity = resolveDebugIdentity(params.cfg, lane);
      warnIfDerivedIdentity(identity, opts?.log ?? params.log);
      const sessionOpts: DebugSessionOptions = {
        client,
        context: {
          debuggingMode: "user",
          requestUser: params.cfg.user,
          terminalId: identity.terminalId,
          ideId: identity.ideId,
        },
        log: opts?.log ?? params.log,
        sessionLease: opts?.sessionLease,
        armLock: armLocks[lane]!,
      };
      return new DebugSession(sessionOpts);
    },
    async createTriggerConnection() {
      // The POOL mints it, so it shares the process-wide auth circuit breaker
      // (pool law L3) while staying outside the pool's slot set and DIA
      // accounting — see `AdtSessionPool.createUnpooledConnection`.
      const c = params.pool.createUnpooledConnection("debug-trigger");
      await c.connect();
      // D8: `connect()` subscribes every connection to the shared shutdown
      // hook, and this connection has no shutdown tasks of its own — left
      // subscribed, its callback would call process.exit() and strand the
      // server connection's shutdown (which terminates the debuggee) mid-
      // flight. `dispose()` unsubscribes; teardown is coordinated instead via
      // `closeTriggerConn`/`shutdownDebugTools()`. See archive.
      c.dispose();
      return c;
    },
    async createDebugSessionConnection() {
      // Same pool-law-L3 / D8-unsubscribe reasoning as `createTriggerConnection`
      // just above — see its comment. The only difference is `purpose`: this
      // connection is the session's OWN, not the trigger bridge's.
      const c = params.pool.createUnpooledConnection("debug-session");
      await c.connect();
      c.dispose();
      return c;
    },
    resolveObject(conn, ref) {
      return resolveObjectLive(conn, ref);
    },
    triggerRun(conn, input, maxChars, gate) {
      return abapRun(conn, input, maxChars, gate);
    },
    log: params.log,
    reserveDebugSession: (op: string) => params.pool.reserveDebug(op),
    allowJumpToLine: params.cfg.allowDebugJumpToLine,
    async releaseOrphanListener(conn) {
      // Lane 0's identity only, deliberately — an orphan here means an
      // EARLIER PROCESS INSTANCE armed a listener and exited uncleanly, and
      // lane 0 is the only lane every process (single- or multi-lane
      // configured) always has. Not extended to every configured lane: SAP's
      // own exclusivity is per SAP USER, not per (terminalId, ideId) (see
      // src/debug/identity.ts), so a listener armed under a non-zero lane's
      // identity is still one listener for the same user this query can
      // reasonably be expected to see regardless of which lane's identity
      // asks.
      const identity = resolveDebugIdentity(params.cfg);
      // Same gate every mutating debugger call goes through — omitting it
      // hits `DebugTransport.authorizeMutation`'s SAFETY_DENIED refusal on
      // the stopListener DELETE below (confirmed live). No `target`: a
      // listener names no ABAP object, falls back to UNRESOLVED_DEBUG_TARGET.
      const client = createDebugClientForConnection(conn, { safety: params.gate });
      const context = {
        debuggingMode: "user" as const,
        requestUser: params.cfg.user,
        terminalId: identity.terminalId,
        ideId: identity.ideId,
      };
      // checkConflict omitted (false/absent): selects getListener's *query*
      // branch — 404 → absent, 200 → exists — "is anything armed here".
      const probe = await client.getListener(context);
      if (probe.kind === "absent") return { kind: "absent" };
      if (probe.kind === "conflict") {
        // Undocumented shape on the query branch — report rather than guess
        // whether a DELETE here is safe.
        return { kind: "conflict", detail: probe.conflict.conflictText };
      }
      // "exists" (or the unreachable "clear", harmless either way): release it.
      await client.stopListener(context);
      return { kind: "released" };
    },
    async releaseOrphanDebuggee(conn) {
      // Live-confirmed: a bare `terminateDebuggee()` on a FRESH connection
      // answers NOT_CONNECTED even while a genuinely orphaned, suspended
      // debuggee sits attached at this exact identity — it operates on
      // whatever THIS stateful ADT session is attached to, not the identity
      // in the abstract. So this must first RECONNECT to the orphan under
      // this server's own identity (same reconnect `DebugSession.attach()`'s
      // isDoubleAttachError path already performs) and only then terminate
      // it. A suspended debuggee reconnects to a freshly armed listener
      // near-instantly, so a short window distinguishes "reconnected" from
      // "nothing here" without a full listener timeout. See archive.
      const client = createDebugClientForConnection(conn, { safety: params.gate });
      // Lane 0 only — same reasoning as `releaseOrphanListener` above.
      const identity = resolveDebugIdentity(params.cfg);
      const probe = new DebugSession({
        client,
        context: {
          debuggingMode: "user",
          requestUser: params.cfg.user,
          terminalId: identity.terminalId,
          ideId: identity.ideId,
        },
        log: params.log,
        listenerTimeoutSeconds: 5,
        registrationPollTimeoutMs: 3_000,
        // The probe arms a REAL listener at this identity, so it contends for
        // the same debugger slot and must take the same lock — a no-op if
        // THIS process already holds it, a refusal if another one does.
        armLock: armLocks[0]!,
      });
      try {
        await probe.armListener();
        const caught = await probe.waitForDebuggee();
        if (caught.kind !== "debuggee") {
          // timeout/blocked/conflict: nothing reconnected in the short
          // window; `waitForDebuggee()` already released the listener.
          //
          // Live-reproduced 2026-09-15: this branch used to `return` here
          // WITHOUT terminating `probe` first. `abap_debug({action:"stop",
          // force:true})` on an idle process took ~5.5s, correctly reported
          // "No active debug session (nothing to stop)" — and then the VERY
          // NEXT `start` was refused outright with UNSUPPORTED ("A debug
          // session from an earlier, unsuccessful start attempt is still
          // registered (status \"idle\")..."). The probe `DebugSession`
          // constructed above stays in the module registry
          // `listActiveDebugSessions()` (and `handleStart`'s guard reads
          // that registry) as an untracked, never-terminated "idle" session,
          // blocking every later `start` until a `stop` happens to clear it.
          // Same best-effort shape as the `catch` branch below — `terminate()`
          // is memoised, so this is a no-op on any path that already called it.
          try {
            await probe.terminate("terminated_by_caller", "cleanup after releaseOrphanDebuggee found nothing (absent)");
          } catch {
            // Nothing else to report: `kind: "absent"` already means "found
            // nothing to force-clear", and this is just probe hygiene.
          }
          return { kind: "absent" };
        }
        await probe.attach(caught.debuggee.id);
        await probe.terminate("terminated_by_caller", "force-cleared orphaned debuggee (abap_debug stop force:true)");
        return { kind: "released" };
      } catch (e) {
        // Best-effort cleanup of the probe FIRST, on every failure — so a
        // failed force-clear does not itself leave a listener armed or strand
        // the cross-process lock `armListener()` took. Memoised `terminate()`
        // is a no-op if the success path above already ran it.
        try {
          await probe.terminate("terminated_by_caller", "cleanup after failed orphan-debuggee force-clear");
        } catch {
          // Already reporting the primary failure below.
        }
        // NOT_CONNECTED: the reconnect found nothing to attach to — expected
        // answer for "nothing orphaned".
        if (isAbapError(e) && e.code === "NOT_CONNECTED") {
          return { kind: "absent" };
        }
        return { kind: "unknown", detail: describeUnknownError(e) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level session registry — up to `resolveDebugSessionLimit(cfg)` lanes
// per process (one, in the shipped default). See `debugLanes` below.
// ---------------------------------------------------------------------------

/**
 * D4: what the safety gate judges every FOLLOW-UP write on this session
 * against (`step`, `keepalive`, `stop`). Captured once, at `start`, since
 * none of those actions carries an object of its own. `phase` travels with
 * it: a resolved line breakpoint gets the full `final` rule set; a session
 * armed only with exception breakpoints stays `preflight` (package unknown).
 */
interface DebugGateTarget {
  target: SafetyTarget;
  phase: EvaluateOptions["phase"];
}

interface CurrentRun {
  session: DebugSession;
  /**
   * The connection the session's `DebugClient` was actually built on — NOT
   * necessarily the `conn` a later `stop` call happens to be handed. When
   * `deps.createDebugSessionConnection` is present (the live default, issue
   * #89) this is a DEDICATED connection minted just for this session, shut
   * down and discarded outright at teardown via `closeSessionConn`. When
   * absent, it falls back to the leased slot's connection (`slot?.conn ??
   * conn`), same as before issue #89: "M14 — handleStart builds the debug
   * client on the LEASED slot's connection, not the caller's"
   * (test/debug-tools.test.ts) pins that the two can be different objects
   * entirely.
   */
  sessionConn: AbapConnection;
  /**
   * Release `sessionConn`. Idempotent, never rejects, safe to call from any
   * teardown path in any order — same contract as `closeTriggerConn` below,
   * just async since a dedicated connection's `shutdown()` is a real network
   * call. For a DEDICATED connection (see `sessionConn`'s doc comment):
   * `shutdown()` then `dispose()`, discarding it outright. For the fallback
   * shared connection: `dropDebugSessionOnConnection()`, which only drops the
   * stateful ADT session and leaves the (pool-owned) connection itself alone.
   * See `makeSessionConnCloser`.
   */
  closeSessionConn: () => Promise<void>;
  triggerConn: AbapConnection;
  /** D4 — the object every follow-up write on this session is gated against. */
  gateTarget: DebugGateTarget;
  /**
   * D11 — the stack from the most recent stop. `stepRunToLine`/`stepJumpToLine`
   * need a source URI for the frame they are targeting, and this is where it
   * comes from: re-fetching the stack to find it would be a second request on
   * the stateful session, which is exactly what must never be added.
   */
  lastStack?: DebugStack;
  /**
   * #151 — note-once ledger for this session's advisory notes: the full
   * explanation the first time, a one-line brief afterwards, re-armed on a
   * state change (breakpoint hit, post-mortem attach). See guidance.ts.
   */
  guidance: GuidanceLedger;
  /**
   * #152 — exception classes whose breakpoints the server echoed as armed at
   * `start`, and whether any exception breakpoint has suspended this run yet.
   * Read at death: a run that ended without ever stopping at one of them says
   * so, instead of leaving the caller to infer it from the dump.
   */
  armedExceptionClasses: readonly string[];
  exceptionBreakpointFired: boolean;
  /** Never rejects — already normalized via .then(ok, err) attached synchronously at creation time. */
  triggerSettled: Promise<DebugTriggerOutcome>;
  /**
   * Release `triggerConn`. Idempotent, synchronous, and NEVER throws or
   * rejects — every teardown path may call it blindly without ordering itself
   * against the trigger's settle handler.
   */
  closeTriggerConn: () => void;
  /**
   * Which slot in `debugLanes` this run occupies — see `resolveLaneRun`
   * below for why every follow-up action needs to know.
   */
  lane: number;
}

// One slot per configured debug lane. A plain, sparse, lazily-populated
// array rather than something pre-sized at module load: `Config` (and so
// `resolveDebugSessionLimit(cfg)`) is not available until a caller builds a
// `DebugToolDeps`, well after this module's top level runs — see
// `createLiveDebugToolDeps` above, which is the only place `cfg` reaches
// this file at all. Index 0 is the historical, sole slot: at the shipped
// `ABAP_DEBUG_SESSIONS` default (1), only `debugLanes[0]` is ever touched,
// so behaviour, identity, and lock selection stay byte-identical to before
// lanes existed.
let debugLanes: (CurrentRun | undefined)[] = [];

/** Every currently-occupied lane's run, in ascending lane order. */
function activeLaneRuns(): CurrentRun[] {
  return debugLanes.filter((r): r is CurrentRun => r !== undefined);
}

/**
 * Resolve which lane's run a call should act on.
 *
 * - Zero lanes occupied: `undefined` — the historical "no active debug
 *   session" case, unchanged.
 * - Exactly one lane occupied (every real deployment, always, since SAP's
 *   own per-SAP-USER debugger-listener exclusivity — see
 *   `src/debug/identity.ts` — means a second lane in the SAME process only
 *   has a chance of ever getting occupied under a DIFFERENT `ABAP_USER`):
 *   that lane, byte-identical to the pre-B2 single-`currentRun` behaviour,
 *   REGARDLESS of whether `stateId` matches — a stale-but-real `stateId`
 *   still routes to the one real session, which refuses it itself with its
 *   own existing "stateId does not match"/stale wording
 *   (`DebugSession.validateStateId`, src/debug/session.ts). This function
 *   never reproduces or rewords that refusal.
 * - More than one lane occupied (only reachable with a hand-built test
 *   double — see above): an exact match against a lane's CURRENTLY expected
 *   `stateId` (`session.snapshot.stateId`) picks that lane; `stateId` is a
 *   hash over each session's own unique `debugSessionId`
 *   (`src/debug/types.ts`), so an exact match reliably names the right lane.
 *   No match (including when the caller passed no `stateId` at all, e.g.
 *   `keepalive`/`stop`/`status` — see below) deterministically falls back to
 *   the LOWEST-INDEXED occupied lane, so a genuinely stale-but-real
 *   `stateId` for some OTHER lane still reaches a real session and gets
 *   that session's own stale-stateId refusal, rather than a new "lane not
 *   found" error this change does not introduce.
 *
 * `keepalive`/`stop`/`status` carry no `stateId` in their input schema at
 * all (`debugInputSchema` — "keepalive/stop/status need nothing") and this
 * change does not add one — extending the schema is outside this file's
 * scope for B2. Calling this with `stateId: undefined` for those three
 * actions is the conservative fallback: reduces to the single active lane
 * (i.e. always, outside contrived multi-lane tests) and picks the
 * lowest-indexed lane deterministically in the fabricated multi-lane case.
 */
function resolveLaneRun(stateId: StateId | undefined): CurrentRun | undefined {
  const active = activeLaneRuns();
  if (active.length <= 1) return active[0];
  if (stateId !== undefined) {
    // #151 — the wire form is a prefix of the full id, so lanes are matched by
    // `stateIdMatches` (full id, short form, or a prefix of at least
    // MIN_STATE_ID_PREFIX_LENGTH), not by equality. A prefix that names more
    // than one lane's current id is refused rather than guessed.
    const matches = active.filter((r) => {
      const current = r.session.snapshot.stateId;
      return current !== undefined && stateIdMatches(current, stateId);
    });
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new AbapError(
        "BAD_INPUT",
        `stateId "${stateId}" is a prefix of ${matches.length} active debug sessions' current ids — ` +
          "pass a longer prefix or the full id.",
        { providedStateId: stateId, matchingLanes: matches.length },
      );
    }
  }
  return active[0];
}

/**
 * The canonical wire form of `run`'s CURRENT stateId (#151) — what every
 * response header and every retrieval hint prints, whatever spelling (full
 * id, short form, prefix) the caller passed in. Falls back to the caller's
 * own value only when the session has no current state, in which case the
 * stateful call that follows refuses it anyway.
 */
function wireStateId(run: CurrentRun, fallback: string): string {
  const current = run.session.snapshot.stateId;
  return current !== undefined ? shortStateId(current) : fallback;
}

/** Lowest-indexed lane with no run tracked, below `limit` — `undefined` if every lane 0..limit-1 is occupied. */
function firstFreeLane(limit: number): number | undefined {
  for (let i = 0; i < limit; i++) {
    if (debugLanes[i] === undefined) return i;
  }
  return undefined;
}

// D4 — the safety gate (src/safety.ts), applied to the debugger's WRITES: arming/
// clearing a breakpoint, every step, `keepalive`, `stop`. READS (`stack`, `status`,
// abap_debug_vars/value) are ungated — they observe a stop that already exists.
// `gate` is required, not optional, so a write can never slip through ungated.
// `shutdownDebugTools()` below is deliberately gate-free — shutdown must always
// release a work process even if the gate tightened mid-session.

/** Assert (and authorize) a debugger WRITE against the shared gate. Throws on refusal. */
function assertDebugWrite(
  gate: SafetyGate,
  target: SafetyTarget,
  phase: EvaluateOptions["phase"] = "final",
): AuthorizedTarget<"execute", SafetyTarget> {
  return gate.authorize("execute", target, { phase });
}

/** Assert a follow-up write (`step`/`keepalive`/`stop`) against the target captured at `start`. */
function assertSessionWrite(
  gate: SafetyGate,
  run: CurrentRun,
): AuthorizedTarget<"execute", SafetyTarget> {
  return assertDebugWrite(gate, run.gateTarget.target, run.gateTarget.phase);
}

/**
 * D8 — coordinated teardown for the tool layer's own state.
 * `shutdownAllDebugSessions()` (session.ts) terminates the DEBUGGEE but knows
 * nothing about this module's `currentRun` — the trigger connection and
 * registry slot are ours to release. Never throws, never awaits the network,
 * order-independent with `shutdownAllDebugSessions()`. Deliberately not gated.
 *
 * `closeSessionConn()` is fired with `void`, not `await`, deliberately: this
 * function's contract ("never awaits the network") must stay true even
 * though `closeSessionConn` is itself async (a dedicated connection's
 * `shutdown()` is a real network round trip). Firing it and moving on is
 * still strictly better than the pre-issue-89 behaviour, which released
 * NOTHING here at all — the session connection now at least gets a best-
 * effort shutdown kicked off before the process goes away, instead of being
 * abandoned outright.
 */
export function shutdownDebugTools(): void {
  const runs = debugLanes;
  debugLanes = [];
  for (const run of runs) {
    run?.closeTriggerConn();
    void run?.closeSessionConn();
  }
}

// Bounded waits: `triggerRun` may be blocked inside the debuggee we're tearing
// down, and terminate()/cleanup() have no timeout of their own — every such wait
// goes through `raceDeadline` below with a named constant, or it can wedge the tool.

/** Returned by `raceDeadline` when the deadline beat the promise. */
const TIMED_OUT = Symbol("debug.timed-out");
type TimedOut = typeof TIMED_OUT;

/**
 * Await `p`, but give up after `ms` and return `TIMED_OUT` instead. `p` keeps
 * running — this bounds the WAIT, not the work. `p` must not reject (attach a
 * `.catch` at the call site if that isn't guaranteed) — this helper does not
 * swallow rejections, so a real bug still surfaces rather than reading as a
 * timeout. Timer is `unref`'d. NOT the same contract as session.ts's
 * `settleWithin`, which never rejects — the two are deliberately unlike.
 */
function raceDeadline<T>(p: Promise<T>, ms: number): Promise<T | TimedOut> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<TimedOut>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([p, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * How long a FAILED `start` waits for the trigger run's output before
 * throwing without it — diagnostic bonus only, must never delay the error.
 */
const START_FAILURE_TRIGGER_WAIT_MS = 2_000;

/**
 * FLOOR — how long a failed `start` waits for `session.cleanup()` before it
 * continues in the background (memoised). Not a fixed wait any more: wherever
 * this bounds a wait on a specific session's `terminate()`/`cleanup()`, use
 * `Math.max(START_FAILURE_CLEANUP_WAIT_MS, session.terminateDeadlineMs + 1_000)`
 * instead of the bare constant, so a session holding several breakpoints (each
 * DELETE individually allowed up to `BREAKPOINT_DELETE_DEADLINE_MS` — see
 * `src/debug/session.ts`) isn't reported as "had not returned" while its own,
 * longer, still-legitimate deadline hasn't even elapsed yet.
 */
const START_FAILURE_CLEANUP_WAIT_MS = 5_000;

/**
 * FLOOR — how long `stop` waits for `session.terminate()` before dropping the
 * session anyway. Same `Math.max(STOP_WAIT_MS, session.terminateDeadlineMs +
 * 1_000)` floor rule as `START_FAILURE_CLEANUP_WAIT_MS` above applies wherever
 * this bounds a wait on `terminate()` specifically. Every OTHER use of this
 * constant (the `run.triggerSettled` wait, the `releaseOrphanListener` race in
 * `clearLeakedSessions`/`handleStop`'s idle path) is unrelated to breakpoint
 * cleanup and stays a plain, fixed 5s.
 */
const STOP_WAIT_MS = 5_000;

/**
 * How long `stop({force:true})` waits for `releaseOrphanDebuggee`. Longer
 * than `STOP_WAIT_MS`: it does real extra work (arm a listener, confirm
 * registration, wait for reconnect, attach, terminate) — live measurement put
 * the round trip just past 5s and under 10s. `force:true` is rare/explicit,
 * so a few extra seconds for a real answer is the right default.
 */
const FORCE_CLEAR_WAIT_MS = 15_000;

/**
 * How long `dropDebugSessionOnConnection` waits for `conn.dropSession()`
 * before giving up on it and letting the caller move on. Named separately
 * from the other `*_WAIT_MS` constants above because this wait guards
 * hygiene, not an outcome the caller asked about — a slow drop must never
 * delay `start`/`stop`'s own response by more than this.
 */
const DROP_DEBUG_SESSION_WAIT_MS = 3_000;

/**
 * Best-effort: drop the stateful ABAP session (the `sap-contextid`) on
 * `conn` after a debug session that used it is finished with, so the NEXT
 * debug `start` on this same connection attaches under a fresh ABAP session
 * instead of a reused one.
 *
 * LIVE-VERIFIED 2026-09-15 against A4H (do not re-litigate; no live access
 * from here). Inside ONE MCP server process, the FIRST `abap_debug`
 * start->stop cycle works perfectly, and EVERY subsequent `start` fails with
 * HTTP 500 "Debuggee already attached" -> `SESSION_DEAD` ("...does not
 * belong to this session"). A brand-new server process is clean again for
 * exactly one cycle. Reproduced 4x, including two byte-identical
 * exception-breakpoint cycles separated by a 3s pause.
 *
 * The evidence pins this to the CONNECTION, not the SAP server: the first
 * `stop` is completely clean (268-355ms, no abandoned cleanup steps, status
 * "dead", deathReason "terminated_by_caller" — i.e. NOT the breakpoint-
 * delete-timeout defect already fixed separately in src/debug/session.ts).
 * Immediately after that clean stop, a RAW request on a FRESH HTTP
 * connection at the SAME debug identity (terminalId/ideId) got
 * `terminateDebuggee` -> HTTP 404 `noSessionAttached`, and a listener poll
 * blocked the full 8s timeout and came back with a ZERO-BYTE body — i.e.
 * server-side there is no attached AND no queued debuggee at that identity.
 * Yet the SAME process's next `start` still got "Debuggee already
 * attached". So SAP's debugger attachment is bound to the STATEFUL ADT
 * session (the `sap-contextid`) the debugger calls travel on, and
 * `terminateDebuggee` does not free that session's attachment slot for a
 * later `attach` on the SAME `sap-contextid` — only a fresh ABAP session is
 * clean.
 *
 * NOT SOLVED by this function alone — re-verified live on 2026-09-15, same
 * day as the evidence above: dropping the stateful session on a SHARED
 * pooled connection proved insufficient. The failure recurred after clean
 * stops in further live re-verification. The evidence above (first cycle
 * clean, later `start`s on the same connection failing, a fresh connection
 * at the same identity reporting `terminateDebuggee` -> 404 `noSessionAttached`
 * and an empty listener poll) all still stands — it is the DIAGNOSIS, not
 * the fix. The primary fix is now a DEDICATED connection per debug session
 * (`DebugToolDeps.createDebugSessionConnection`, `makeSessionConnCloser`):
 * nothing else ever shares a dedicated connection's `sap-contextid`, so
 * there is no shared connection left for a later `start` to inherit a stale
 * attachment from at all. This function is retained as the FALLBACK for
 * callers that supply no `createDebugSessionConnection` dep, and for
 * `clearLeakedSessions` (which has no per-session dedicated connection to
 * reach for — a leaked session was never routed through `CurrentRun`).
 *
 * GUARD: skipped (logged, not enforced) when `conn` reports it is holding
 * object locks — `dropSession()` releases every lock the session holds (see
 * its doc comment in src/adt/connection.ts), and this helper has no
 * business silently releasing someone else's LOCK just to fix the debugger.
 * None of this module's three call sites can legitimately be holding a lock
 * — nothing in `src/tools/debug.ts` ever calls into
 * `withStatefulSession`/LOCK/PUT/activate — but the check is free
 * (`heldLockUris()` is a synchronous, zero-request snapshot) and the
 * alternative (assuming it forever) is exactly the kind of assumption live
 * testing keeps disproving.
 *
 * Never throws — `conn.dropSession()` already logs and swallows its own
 * failures — and never adds a user-visible note on success: this is
 * connection hygiene, not an outcome the caller asked about.
 */
async function dropDebugSessionOnConnection(
  conn: AbapConnection,
  log: ((msg: string) => void) | undefined,
  why: string,
): Promise<void> {
  // Bracketing "starting"/"completed" log lines exist so a live run can prove
  // from the log alone whether this actually ran or was skipped by the
  // held-locks guard below — exactly the kind of question the 2026-09-15
  // re-verification (see this function's doc comment) needed an answer to.
  log?.(`abap_debug: dropSession() after ${why} — starting.`);
  const heldLocks = conn.heldLockUris();
  if (heldLocks.length > 0) {
    log?.(
      `abap_debug: skipped dropSession() after ${why} — connection holds ${heldLocks.length} object ` +
        "lock(s), and dropSession() would silently release them.",
    );
    return;
  }
  try {
    const outcome = await raceDeadline(conn.dropSession(), DROP_DEBUG_SESSION_WAIT_MS);
    if (outcome === TIMED_OUT) {
      log?.(
        `abap_debug: dropSession() after ${why} had not returned after ${DROP_DEBUG_SESSION_WAIT_MS} ms — ` +
          "it continues in the background.",
      );
    } else {
      log?.(`abap_debug: dropSession() after ${why} — completed.`);
    }
  } catch (e) {
    // Defensive only — `dropSession()`'s own doc comment says it logs and
    // swallows its failures, but this call site must stay best-effort
    // regardless of whether that contract holds.
    log?.(`abap_debug: dropSession() after ${why} failed (ignored): ${describeUnknownError(e)}`);
  }
}

/**
 * Build the idempotent, never-throwing closer stored on `CurrentRun`. A
 * `shutdown()` that throws synchronously (not just rejects) is caught here
 * too — both failure shapes are contained and logged, never crash via
 * `unhandledRejection`.
 */
function makeTriggerConnCloser(
  triggerConn: AbapConnection,
  log: ((msg: string) => void) | undefined,
): () => void {
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    try {
      void triggerConn
        .shutdown("debug-trigger-done")
        .catch((e: unknown) => {
          log?.(`abap_debug: trigger connection shutdown failed: ${describeUnknownError(e)}`);
        })
        .finally(() => triggerConn.dispose());
    } catch (e) {
      log?.(`abap_debug: trigger connection shutdown threw: ${describeUnknownError(e)}`);
      triggerConn.dispose();
    }
  };
}

/**
 * Build the idempotent, never-throwing closer stored on `CurrentRun.closeSessionConn`
 * (issue #89). `owned` distinguishes the two shapes `sessionConn` can be:
 *
 * - `owned: true` (a DEDICATED connection from `deps.createDebugSessionConnection`):
 *   the connection belongs to nobody else, so it is shut down and DISCARDED
 *   outright — `shutdown()` then, in a `finally` so it runs even if `shutdown()`
 *   throws synchronously or its promise rejects, `dispose()`. Mirrors
 *   `makeTriggerConnCloser`'s own throw/reject handling exactly, for the same
 *   reason: both failure shapes must be contained and logged, never surface as
 *   an `unhandledRejection`.
 * - `owned: false` (the fallback shared/leased connection): the connection is
 *   NOT ours to shut down — other callers may still hold or reuse it — so only
 *   `dropDebugSessionOnConnection` runs, resetting the stateful ADT session and
 *   leaving the connection itself alone. Unchanged behaviour: the pre-existing
 *   `dropSession()` tests keep passing against this path.
 *
 * Never rejects under any circumstances, in either shape.
 */
function makeSessionConnCloser(
  conn: AbapConnection,
  log: ((msg: string) => void) | undefined,
  owned: boolean,
  why: string,
): () => Promise<void> {
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    if (!owned) {
      await dropDebugSessionOnConnection(conn, log, why);
      return;
    }
    try {
      await conn.shutdown("debug-session-done").catch((e: unknown) => {
        log?.(`abap_debug: dedicated debug session connection shutdown failed: ${describeUnknownError(e)}`);
      });
    } catch (e) {
      log?.(`abap_debug: dedicated debug session connection shutdown threw: ${describeUnknownError(e)}`);
    } finally {
      conn.dispose();
    }
    log?.(`abap_debug: dedicated debug session connection discarded after ${why}.`);
  };
}

/** Render a settled-or-timed-out trigger outcome as the PROGRAM OUTPUT section body. */
function renderTriggerOutcome(settled: DebugTriggerOutcome | TimedOut, waitedMs: number): string {
  if (settled === TIMED_OUT) {
    return (
      `(the trigger run had NOT returned after ${waitedMs} ms, so no program output is ` +
      `available — it may still be blocked inside the debuggee)`
    );
  }
  return settled.ok ? settled.text : `(trigger did not complete normally: ${settled.error})`;
}

/**
 * Structured discriminator for the death response HEADER. Before this, three
 * distinct real endings (clean finish, a failing ASSERT, an uncaught
 * CX_SY_ZERODIVIDE) all produced byte-identical `deathReason`/`terminationKind`.
 *
 * SOURCE WARNING — kept separate from `terminationKind`: this reads the
 * settled outcome of the TRIGGER BRIDGE (`deps.triggerRun`, a second
 * independent ABAP run), not the ADT debug protocol's own termination
 * evidence (`DebugTerminationResult`). The two can legitimately disagree —
 * e.g. a caller `stop` ends the session while the trigger it interrupted
 * still reports `"trigger_not_returned"`.
 *
 * `"short_dumped"` is backed by a real structured field: `translateRunFailure`
 * throws `RUNTIME_DUMP`, which survives onto `DebugTriggerOutcome` unflattened.
 */
function triggerOutcomeHeader(
  settled: DebugTriggerOutcome | TimedOut,
): "ran_to_completion" | "short_dumped" | "trigger_failed" | "trigger_not_returned" {
  if (settled === TIMED_OUT) return "trigger_not_returned";
  if (settled.ok) return "ran_to_completion";
  return settled.code === "RUNTIME_DUMP" ? "short_dumped" : "trigger_failed";
}

// ---------------------------------------------------------------------------
// Shared response budget — debugger responses use a tighter cap than the repo
// default (DEBUG_MAX_CHARS, `src/debug/render.ts`).
// ---------------------------------------------------------------------------

function clampMaxChars(maxChars: number): number {
  return Math.min(maxChars, DEBUG_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// Tool 1: `abap_debug` — the driver.
// ---------------------------------------------------------------------------

/**
 * D5: `condition`/`skipCount` are wire-real on EVERY breakpoint kind. They
 * used not to appear in this schema, and zod strips unknown keys by default —
 * a caller's condition was silently deleted and the breakpoint fired
 * unconditionally, worse than an error. Shared so both kinds can't drift
 * apart. `z.discriminatedUnion` inlines both members separately in
 * JSON-Schema with no `$ref` dedup, so every word of these descriptions is
 * serialized TWICE — which is why `condition`/`skipCount` carry no
 * `.describe()` at all below: their guidance is stated once, in the
 * `breakpoints` array description, and a caller who actually sets
 * `skipCount` gets the not-enforced warning back in the response
 * (`skipCountWarnings` in `startSession`).
 *
 * A `.meta({id})`-based `$ref` dedup for this pair was measured and
 * deliberately rejected: it saved only 247 bytes on the wire payload, no
 * other tool in this product emits `$ref`/`definitions` at all, and the
 * emitted node is a typeless `{"$ref": "..."}` that a client normalizing
 * into a restricted OpenAPI subset could reject outright rather than
 * degrade gracefully.
 */
const breakpointConditionFields = {
  condition: z.string().trim().min(1).max(255).optional(),
  skipCount: z.number().int().nonnegative().max(1_000_000).optional(),
};

const lineBreakpointSchema = z.object({
  ...breakpointConditionFields,
  kind: z.literal("line"),
  object: z
    .string()
    .describe("Class or report to break in — any form abap_read/abap_run accept."),
  line: z
    .number()
    .int()
    .min(1)
    .max(999_999)
    .describe(
      "1-based; SAP may snap it to the nearest executable statement (the start response " +
        "reports the correction).",
    ),
});

const exceptionBreakpointSchema = z.object({
  ...breakpointConditionFields,
  kind: z.literal("exception"),
  exceptionClass: z.string().describe("Exception class to break on, e.g. CX_SY_ZERODIVIDE."),
});

// D5 continued: `statement`/`msgTy` are free-text, not enums, on purpose —
// the legal `statement` values are a ~27kB server-enumerated list served at
// `GET /debugger/breakpoints/statements` and `msgTy` is one of a handful of
// single letters, but both are validated by SAP itself when the breakpoint
// is armed, and this module has no committed capture of either list to
// mirror client-side. A bad value is refused by SAP, not silently accepted.
// Descriptions kept short per the comment above `breakpointConditionFields`:
// a 4-member discriminatedUnion inlines every member's description 4 times.
const statementBreakpointSchema = z.object({
  ...breakpointConditionFields,
  kind: z.literal("statement"),
  statement: z.string().describe("ABAP statement keyword to break on, e.g. RAISE. SAP validates it."),
});

const messageBreakpointSchema = z.object({
  ...breakpointConditionFields,
  kind: z.literal("message"),
  msgId: z.string().describe("Message class, e.g. 00."),
  // String, not number: leading zeros (e.g. "001") are significant and must survive.
  msgNo: z.string().describe("Message number, e.g. 001."),
  msgTy: z.string().describe("Message type letter, e.g. E."),
});

export const debugInputSchema = {
  action: z
    .enum(["start", "step", "stack", "frame", "breakpoints", "watch", "keepalive", "stop", "status"])
    .describe(
      "start needs breakpoints+run. step needs stateId+step. stack needs stateId. frame " +
        "needs stateId+frame. breakpoints needs stateId (op add/remove) or nothing (op list, " +
        "default). watch needs stateId+variable (op add, default when variable given) or " +
        "stateId+id (op remove) or stateId (op list). keepalive/stop/status need nothing.",
    ),
  breakpoints: z
    .array(
      z.discriminatedUnion("kind", [
        lineBreakpointSchema,
        exceptionBreakpointSchema,
        statementBreakpointSchema,
        messageBreakpointSchema,
      ]),
    )
    .optional()
    .describe(
      "≥1 entry, required for action=\"start\" and for action=\"breakpoints\" op=\"add\"; kinds " +
        "(line/exception/statement/message) may mix and are validated against SAP before arming. " +
        "All kinds take optional condition (ABAP expression, suspend only when true) and " +
        'skipCount (sent to SAP, NOT enforced — use step:"continue").',
    ),
  run: z
    .object({
      object: z.string().describe("Class or report to execute — same resolution rules as abap_run."),
      mode: z.enum(["class", "report", "auto"]).optional().describe("Default auto."),
    })
    .optional()
    .describe(
      "The program to trigger (action=\"start\").",
    ),
  step: z
    .enum(["into", "over", "return", "continue", "runToLine", "jumpToLine"])
    .optional()
    .describe(
      "continue may end the session (status=\"dead\" plus captured output). " +
        "runToLine/jumpToLine need toLine; jumpToLine also needs server " +
        "ABAP_ALLOW_DEBUG_JUMP_TO_LINE=true and confirm:\"jumpToLine\".",
    ),
  toLine: z
    .number()
    .int()
    .min(1)
    .max(999_999)
    .optional()
    .describe(
      "Required for step=\"runToLine\"/\"jumpToLine\". 1-based line in the current frame's source.",
    ),
  stateId: z
    .string()
    .optional()
    .describe(
      "From the most recent start/step/stack/frame response (12-char token; the full id or a prefix of " +
        "at least 8 chars is accepted too); a stale id is refused.",
    ),
  frame: z
    .number()
    .int()
    .min(1)
    .describe(
      "1-based stackPosition from the last STACK section. Read-only.",
    )
    .optional(),
  // Shared between action="breakpoints" and action="watch" — meaning depends
  // on which. breakpoints: defaults to "list". watch: defaults to "add" when
  // "variable" is given, else "list".
  op: z
    .enum(["list", "add", "remove"])
    .optional()
    .describe(
      'action="breakpoints"/"watch" only. breakpoints defaults to "list"; watch defaults to ' +
        '"add" when "variable" is set, else "list".',
    ),
  id: z
    .string()
    .optional()
    .describe('action="breakpoints"/"watch" op="remove" only — the id to remove.'),
  variable: z
    .string()
    .optional()
    .describe(
      'action="watch" only — variable path to watch, same syntax abap_debug_value accepts. ' +
        'Presence selects op="add".',
    ),
  confirm: z
    .string()
    .optional()
    .describe(
      "Required for step=\"jumpToLine\": echo \"jumpToLine\". Ignored otherwise.",
    ),
  // "Uncleanly-exited process" = crash/kill-9/container respawn; NOT
  // automatic (unlike listener release) because terminating a SUSPENDED
  // debuggee ends real work; identity-scoped so it can only reach a debuggee
  // this server armed. See `releaseOrphanDebuggee` above; full prose moved to
  // doc/TOOLS/debugger.md.
  force: z
    .boolean()
    .optional()
    .describe(
      "stop only — force-terminates a debuggee left attached by an unclean exit (the " +
        "\"Debuggee already attached\" error's escape hatch).",
    ),
  // Top-level and named identically to the per-breakpoint `condition` field
  // above, but distinct: that one nests inside a `breakpoints[]` entry and
  // conditions a LINE/EXCEPTION/STATEMENT/MESSAGE breakpoint; this one is a
  // sibling of `variable` and conditions a WATCHPOINT (action="watch" only)
  // — different key paths, so the two never collide on the wire.
  condition: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe(
      'action="watch" op="add" only — ABAP expression; the watchpoint only suspends when it ' +
        "evaluates true.",
    ),
};

export const DebugInput = z.object(debugInputSchema);
export type DebugInput = z.infer<typeof DebugInput>;

/**
 * D11: `stepRunToLine`/`stepJumpToLine` existed in `DebugStepKind` and
 * `stepUrl()` already built their `?method=…&uri=…`, but this mapper only
 * ever covered four of the six — nothing could produce them. Wired through
 * rather than deleted; the `#start=<line>` fragment shape is live-confirmed
 * (`test/fixtures/live-captured/013-bp-set-accepted.xml`,
 * `018-stack-2frames.xml`). `method=stepRunToLine` dispatch itself has no
 * live capture.
 */
function stepKindOf(step: DebugInput["step"] & string): DebugStepKind {
  switch (step) {
    case "into":
      return "stepInto";
    case "over":
      return "stepOver";
    case "return":
      return "stepReturn";
    case "continue":
      return "stepContinue";
    case "runToLine":
      return "stepRunToLine";
    case "jumpToLine":
      return "stepJumpToLine";
  }
}

/** The two step kinds that target a line and therefore need a `uri` (`StepParams.uri`). */
const LINE_TARGETED_STEPS: ReadonlySet<DebugStepKind> = new Set<DebugStepKind>([
  "stepRunToLine",
  "stepJumpToLine",
]);

/**
 * Build the `uri` a line-targeted step needs: current top frame's source URI
 * carrying a `#start=<line>` fragment. Stack entries come back with the
 * fragment already on them (live: `…/source/main#start=84,0`), so the
 * existing one is stripped before appending ours to avoid a double fragment.
 * Only the line goes in — the server discards anything after the first comma.
 */
function lineStepUri(stack: DebugStack | undefined, toLine: number): string {
  const frame = stack?.frames.find((f) => !f.systemProgram && f.uri) ?? stack?.frames.find((f) => f.uri);
  if (!frame?.uri) {
    throw new AbapError(
      "UNSUPPORTED",
      'step:"runToLine"/"jumpToLine" needs the current frame\'s source URI, and the last stack ' +
        "reported none (system frames often have no resolvable source). Use " +
        'step:"over"/"into" instead, or set a line breakpoint and step:"continue" to it.',
      { toLine },
    );
  }
  return withStartFragment(frame.uri.split("#")[0]!, toLine);
}

/** Compose the standard "we're stopped, here's where and what's around" response used by `start` success and non-death `step` success. */
async function composeStopOutput(
  run: CurrentRun,
  action: string,
  stack: DebugStack,
  stateId: StateId,
  maxChars: number,
  extraNotes: readonly string[] = [],
  headerExtra: Record<string, string | undefined> = {},
): Promise<BuiltResponse> {
  const root = await run.session.getRootVariables(stateId);
  const entries = root.variables.variables.map((variable) => ({ variable }));
  // D6: without `stateId`, the renderer's retrieval-call hints fill the slot
  // with the literal placeholder `<stateId>` — an agent would copy that verbatim.
  // #151 — the full id is the session's internal value; the wire carries the short form.
  const wireId = shortStateId(stateId);
  const survey = renderSurvey(entries, { maxChars: DEBUG_MAX_CHARS, stateId: wireId });

  const stackText = renderStackSection(stack, wireId);
  const visibleFrames = stack.frames.filter((f) => !f.systemProgram);
  const top = visibleFrames[0] ?? stack.frames[0];
  const stopNotes = [
    ...extraNotes,
    ...(survey.degraded.length
      ? [`${survey.degraded.length} value(s) shortened to fit budget — each still names its own retrieval call.`]
      : []),
  ];

  return buildResponse({
    header: {
      action,
      status: run.session.snapshot.status,
      program: top?.programName,
      include: top?.includeName,
      line: top?.line,
      stateId: wireId,
      ...headerExtra,
    },
    sections: [{ title: "STACK", content: stackText }],
    body: survey.text,
    bodyLabel: "VARIABLES",
    notes: stopNotes,
    // #151 — notes ride outside the content budget: they never displace variables.
    maxChars: budgetWithNotes(stopNotes, clampMaxChars(maxChars)),
  });
}

/**
 * `bodyExcerpt === detail` is a structural signature, not a coincidence-prone
 * heuristic: on the `AdtErrorException` landing (`.response` absent),
 * `bodyExcerpt` is built as `truncateDiagnosticBody(rawBody || message)` —
 * literally the same string as `detail`. That produced a real defect: three
 * distinct deaths (clean finish, failing ASSERT, uncaught CX_SY_ZERODIVIDE)
 * all surfaced the same content-free "An exception was raised" boilerplate,
 * printed twice. On the other landing (`AdtHttpException`), `bodyExcerpt` is
 * independent HTTP-body content, so equality there is accepted as a rare,
 * explicit trade-off rather than widening the fix through `AdtError`/
 * `AbapError`. See archive; sibling fix is `DebugTriggerOutcome`.
 */
function isGenericFallbackEvidence(tr: DebugTerminationResult | undefined): boolean {
  if (!tr) return false;
  if (tr.kind !== "exception" && tr.kind !== "session_ended") return false;
  return tr.bodyExcerpt !== undefined && tr.bodyExcerpt === tr.detail;
}

/**
 * Turn the structured `DebugTerminationResult` into the prose notes a caller
 * reads, without collapsing distinct evidence back into one ambiguous
 * sentence (the old `deathDetail`-only string did). Each variant states
 * plainly what it is and is not evidence of.
 */
function renderTerminationEvidence(tr: DebugTerminationResult | undefined): string[] {
  if (!tr) return [];
  // An excerpt indistinguishable from the generic no-body fallback is
  // withheld rather than printed as "Raw evidence:" — see `isGenericFallbackEvidence`.
  const showBodyExcerpt = !isGenericFallbackEvidence(tr);
  switch (tr.kind) {
    case "exception":
      return [
        `Termination evidence: the debuggee ended via an ABAP exception — ${tr.exceptionClassNames.join(", ")}.` +
          (tr.bodyExcerpt && showBodyExcerpt ? ` Raw evidence: ${tr.bodyExcerpt}` : ""),
      ];
    case "session_ended":
      return [
        "Termination evidence: the debug session ended (SAP reported the session/debuggee is gone), but the " +
          "response carried no exception class name — this is NOT confirmed to be an exception; it is only " +
          "confirmed to be a session-gone condition." +
          (tr.bodyExcerpt && showBodyExcerpt ? ` Raw evidence: ${tr.bodyExcerpt}` : ""),
      ];
    case "idle_timeout":
      return [`Termination evidence: idle timeout — no debugger activity for ${tr.thresholdMs}ms.`];
    case "terminated_by_caller":
      return [`Termination evidence: stopped by explicit caller request (abap_debug action:"stop").`];
    case "finished":
      return [
        "Termination evidence: the debuggee itself reported stepping/termination as no longer possible " +
          "(a clean finish — no exception, no timeout, no caller-requested stop).",
      ];
  }
}

/**
 * `snapshot.deathDetail` sometimes carries `ADT_REST_DATA_INVALID_TEXT`
 * verbatim — `cx_adt_rest_data_invalid`'s bare default text, which reads
 * like a complaint about the caller's data but is neither: it is SAP's ADT
 * REST layer saying it could not convert the payload of the debugger
 * request in flight, and it carries no detail of its own. Reported by a
 * live verification run on 2026-09-15 on a `step`/`continue` issued right
 * after breakpoints were changed under a suspended debuggee, at a point
 * where that change reached the debuggee one stop-cycle late and the
 * debuggee was already gone (see `removeBreakpoint`/`armBreakpointsTwoPass`
 * in src/debug/session.ts, which now notify the attached debuggee
 * immediately, so this shape should no longer occur that way). Matched
 * case-insensitively after trimming, same as `translateDebugError`'s hint
 * for the same text (src/debug/transport.ts) — this only ADDS an
 * explanation after the server's own text, never replaces it.
 */
function explainOpaqueDeathDetail(detail: string): string {
  if (detail.trim().toLowerCase() !== ADT_REST_DATA_INVALID_TEXT.toLowerCase()) return detail;
  return (
    `${detail} — this is cx_adt_rest_data_invalid's default text, raised by SAP's ADT REST layer ` +
    "when it cannot convert the payload of the debugger request in flight; it is not a complaint " +
    "about a value passed to this tool, and the server gives no further detail. Reported by a " +
    "live verification run on 2026-09-15 right after breakpoints were changed under a suspended " +
    "debuggee, at a point where that change reached the debuggee one stop-cycle late and the " +
    "debuggee was already gone; breakpoint changes now notify the attached debuggee immediately, " +
    "so this shape should no longer occur that way. In practice: the debug session is no longer " +
    "there to step — start a new one."
  );
}

/** Compose the response for a session that has died (debuggee finished, whether via signal A or signal B). Always a SUCCESSFUL response — the debuggee finishing is a normal outcome, not a tool failure. */
async function composeDeathOutput(
  run: CurrentRun,
  action: string,
  maxChars: number,
  cause?: unknown,
  extraNotes: readonly string[] = [],
): Promise<BuiltResponse> {
  // Bounded like `stop`: the session is already dead and its lane is
  // cleared right after this, so a trigger that never returns must not wedge
  // the death response.
  const settled = await raceDeadline(run.triggerSettled, STOP_WAIT_MS);
  const outputSection = {
    title: "PROGRAM OUTPUT",
    content: renderTriggerOutcome(settled, STOP_WAIT_MS),
  };
  // Last chance to release the trigger connection before the lane is dropped.
  run.closeTriggerConn();
  // Last chance to release the session connection too — this path (the
  // debuggee finishing on its own during a `step`/`continue`, not a caller
  // `stop`) previously released NEITHER connection at all: `handleStep` just
  // read the death and cleared the lane. A real bug, not just plumbing —
  // the session connection kept its stateful ADT session forever, and every
  // later `start` in this process inherited the "Debuggee already attached"
  // failure `dropDebugSessionOnConnection` documents, even though the
  // session that caused it had died cleanly on its own.
  await run.closeSessionConn();
  const snapshot = run.session.snapshot;
  // `deathDetail` and `terminationResult.detail` are always the SAME string
  // (both set from `doTerminate()`'s one `detail` param) — suppress the same
  // generic-fallback content here that `renderTerminationEvidence` withholds,
  // or it prints twice.
  const showDeathDetail = !isGenericFallbackEvidence(snapshot.terminationResult);
  const notes = [
    ...extraNotes,
    showDeathDetail && snapshot.deathDetail !== undefined
      ? explainOpaqueDeathDetail(snapshot.deathDetail)
      : undefined,
    snapshot.deathDetail === undefined && cause instanceof Error ? cause.message : undefined,
    ...renderTerminationEvidence(snapshot.terminationResult),
  ].filter((n): n is string => Boolean(n));
  if (settled === TIMED_OUT) {
    notes.push("Program output is incomplete: the trigger run had not returned when the wait expired.");
  }
  // #152 — an exception breakpoint that never suspended the run is otherwise
  // invisible at death: the caller sees a dump and has to guess whether the
  // breakpoint was armed at all.
  if (run.armedExceptionClasses.length > 0 && !run.exceptionBreakpointFired) {
    notes.push(
      `Exception breakpoint(s) on ${run.armedExceptionClasses.join(", ")} were armed (server-echoed) but never ` +
        "suspended this run before it ended. To stop at the raise, arm a line breakpoint on the RAISE statement, " +
        'or a statement breakpoint "RAISE EXCEPTION TYPE" together with a line breakpoint in the target object.',
    );
  }
  // Structured discriminator alongside `deathReason`/`terminationKind` — see
  // `triggerOutcomeHeader`'s doc comment. Costs zero JSON-schema bytes: a
  // response HEADER field, not part of any tool's zod schema.
  const triggerOutcome = triggerOutcomeHeader(settled);
  if (triggerOutcome === "short_dumped" || triggerOutcome === "trigger_failed") {
    // Read off the TRIGGER BRIDGE, not the ADT protocol's own termination
    // evidence above — the two can disagree.
    notes.push(
      `triggerOutcome ("${triggerOutcome}") comes from the trigger run used to reach the breakpoint, not from ` +
        "the debug session's own termination evidence above — the two are independent signals and can " +
        "disagree. See PROGRAM OUTPUT for the trigger run's own error text.",
    );
  }
  return buildResponse({
    header: {
      action,
      status: snapshot.status,
      deathReason: snapshot.deathReason,
      terminationKind: snapshot.terminationResult?.kind,
      triggerOutcome,
    },
    sections: [outputSection],
    notes,
    maxChars: clampMaxChars(maxChars),
  });
}

/**
 * Issue #89 (live, 2026-09-15, A4H appliance): a `statement:"RAISE"` breakpoint
 * suspended in SAP gateway/framework code long before the caller's own $TMP
 * probe class ever ran. This is inherent, not a fluke — SAP's own XSLT
 * `TPDA_ADT_BREAKPOINTS_REQUEST` emits ONLY the `statement` attribute for a
 * statement breakpoint (same for exception/message breakpoints — see the
 * "names no object" comments on those breakpoint kinds above); there is no
 * program/include restriction on the wire at all, so the breakpoint fires in
 * the FIRST code that executes that statement anywhere in the work process.
 * `handleStart` auto-continues past a stop whose stack does not mention the
 * run object, bounded by this constant so a statement that keeps firing in
 * framework code on every single step (plausible — RAISE-shaped statements
 * are common in kernel dispatch code) can never spin `start` forever.
 */
const MAX_FRAMEWORK_AUTO_CONTINUES = 10;

/**
 * Does any frame in `stack` plausibly belong to `objectName` (already
 * `parseObjectRef(...).name.toUpperCase()`)? Used to decide whether a stop
 * is the caller's own breakpoint or a framework stop to auto-continue past
 * (see `MAX_FRAMEWORK_AUTO_CONTINUES`'s doc comment for why this exists).
 *
 * Matches generously and in only ONE direction of error: a class pool's
 * program/include names carry generated suffixes (`ZCL_FOO===============CP`,
 * its include `ZCL_FOO===============CM001`), so names are normalized with
 * `.replace(/=+/g, "")` and matched with `startsWith` rather than exact
 * equality; a frame is also accepted via its source `uri` containing
 * `/objectname/` (lowercased), since some frames carry no resolvable
 * program/include name at all. Both checks can OVER-match — a prefix match
 * can hit a similarly named but different object (`ZFOO_BAR` matching a
 * query for `ZFOO`), and a `uri` substring match is even looser. That is the
 * SAFE direction of error here: over-matching only ever means "treat this
 * stop as the caller's own and stop auto-continuing" — the worst case is
 * this function does nothing (the caller gets the stop `start` would have
 * produced with no auto-continue at all), never that it silently skips a
 * stop the caller actually wanted.
 */
function stackTouchesObject(stack: DebugStack, objectName: string): boolean {
  const normalize = (n: string): string => n.toUpperCase().replace(/=+/g, "");
  const uriNeedle = `/${objectName.toLowerCase()}/`;
  return stack.frames.some((frame) => {
    if (normalize(frame.programName).startsWith(objectName)) return true;
    if (normalize(frame.includeName).startsWith(objectName)) return true;
    if (frame.uri && frame.uri.toLowerCase().includes(uriNeedle)) return true;
    return false;
  });
}

/** `ENHO/XH` (BAdI impl), `ENHO/XHH` (source-code enhancement plug-in), `ENHS/XS` (enhancement spot) — none is a place `abap_debug` can usefully attach a line breakpoint. */
const ENHANCEMENT_DEBUG_TYPES = new Set(["ENHO/XH", "ENHO/XHH", "ENHS/XS"]);

/**
 * There is no ADT debugger verb for "break when this enhancement fires", so
 * this names the ABAP class/base object to point `abap_debug` at instead —
 * same refusal shape as the BOPF catch above, rather than letting
 * `resolveObject`'s generic "type is not readable" stand in.
 *
 * Called after `resolved` is known, before `baseUri`. `ENHO/XHH` genuinely
 * has `supportsSource: true`, so without this check a breakpoint would
 * silently attach to the plug-in's own tiny include instead of being
 * refused — looks like it worked when it didn't.
 *
 * Enrichment reads below are best-effort live GETs; a failed read still
 * produces a refusal, just a less specific one.
 */
async function refuseEnhancementDebugTarget(
  conn: AbapConnection,
  bpObject: string,
  resolved: ResolvedObject,
): Promise<never> {
  const name = resolved.name;
  let advice: string;
  switch (resolved.type) {
    case "ENHO/XH": {
      let classNames: string[] = [];
      try {
        const doc = await readBadiImplementation(conn, name);
        classNames = doc.data.implementations
          .map((impl) => impl.implementingClass?.name)
          .filter((n): n is string => Boolean(n));
      } catch {
        // Best-effort — fall through to the generic advice below.
      }
      advice =
        classNames.length > 0
          ? `Set the breakpoint in its implementing class instead: ${classNames.join(", ")}.`
          : "Set the breakpoint in its implementing class instead — read this BAdI implementation " +
            "with abap_read to find the class name.";
      break;
    }
    case "ENHO/XHH": {
      let enhancedObject: string | undefined;
      try {
        const doc = await readSourceCodePlugin(conn, name);
        enhancedObject = doc.data.enhancedObject?.name;
      } catch {
        // Best-effort.
      }
      advice = enhancedObject
        ? `Set the breakpoint in the object it enhances instead: ${enhancedObject}.`
        : "Set the breakpoint in the object it enhances instead — read this enhancement plug-in " +
          "with abap_read to find that object.";
      break;
    }
    case "ENHS/XS": {
      let badiNames: string[] = [];
      try {
        const doc = await readEnhancementSpot(conn, name);
        badiNames = doc.data.badiDefinitions.map((d) => d.name).filter(Boolean);
      } catch {
        // Best-effort.
      }
      advice =
        badiNames.length > 0
          ? `Set the breakpoint in an implementation of one of its BAdI definitions instead: ${badiNames.join(", ")}.`
          : "Set the breakpoint in an implementation of one of its BAdI definitions instead — read " +
            "this enhancement spot with abap_read to find them.";
      break;
    }
    default:
      // Unreachable: callers only invoke this after checking resolved.type
      // is in ENHANCEMENT_DEBUG_TYPES. Kept exhaustive-safe rather than
      // asserted away.
      advice = "Set the breakpoint in its implementation instead.";
  }
  throw new AbapError(
    "UNSUPPORTED",
    `${bpObject} is ${resolved.spec.label} (${resolved.type}), which has no debuggable source of ` +
      `its own. ${advice}`,
    { object: bpObject, type: resolved.type },
  );
}

async function handleStart(
  conn: AbapConnection,
  input: DebugInput,
  maxChars: number,
  deps: DebugToolDeps,
  gate: SafetyGate,
): Promise<BuiltResponse> {
  // How many lanes this process is configured for — `DebugToolDeps` surfaces
  // it (see its doc comment); absent (a test double that never heard of
  // lanes) reads as 1, byte-identical to the pre-B2 single-lane behaviour.
  const laneLimit = deps.debugLaneCount ?? 1;
  let targetLane: number;
  if (laneLimit === 1) {
    // WITHDRAWN HARD REQUIREMENT, busy case only: this branch used to carry
    // a HARD REQUIREMENT that it stay byte-identical to the pre-B2
    // single-session refusal, for BOTH the "busy" (tracked) and "leaked"
    // (untracked) sub-cases below. Issue #89: a live verification run found
    // that requirement produced an inconsistency — the identical condition
    // ("this process has no free debug lane right now") threw `UNSUPPORTED`
    // here at laneLimit 1, but `DEBUG_ALL_LEASES_BUSY` in the laneLimit > 1
    // branch below, purely as a function of a config value the caller has no
    // way to see from the error alone. The requirement is now withdrawn for
    // the busy case: the old `UNSUPPORTED` ("one session per process") shape
    // is REPLACED by `DEBUG_ALL_LEASES_BUSY` so both lane counts report the
    // same code for the same condition. The leaked-session refusal further
    // below is a DIFFERENT condition — nothing is legitimately busy, an
    // earlier failed start left debris that needs clearing — and it keeps
    // throwing `UNSUPPORTED`, unchanged, and must stay that way.
    //
    // Reads `listActiveDebugSessions()` — the same registry
    // `handleStop`/`handleStatus` consult (see `clearLeakedSessions`) —
    // never `debugLanes[0]` alone. `debugLanes[0]` only exists after a FULL
    // success; a `start` that constructs a `DebugSession` and then fails
    // leaves it registered here with no matching `debugLanes[0]` ("leaked").
    // Distinguishing the two in the message matters: a leaked session's
    // cleanup already ran once, so a plain `stop` is more likely to need a
    // retry or `force:true`.
    const live = listActiveDebugSessions();
    if (live.length > 0) {
      const status = live[0]!.snapshot.status;
      const tracked = debugLanes[0] !== undefined && live.includes(debugLanes[0].session);
      if (tracked) {
        throw new AbapError(
          "DEBUG_ALL_LEASES_BUSY",
          `This process is configured for a single debug session (laneLimit 1) and it is ` +
            `already "${status}" — stop it first: abap_debug({action:"stop"}). Raise ` +
            "ABAP_DEBUG_SESSIONS to run more than one at a time — itself capped at " +
            "floor(ABAP_DEBUG_DIA_BUDGET / 2), since each concurrent debug session pins 2 dialog " +
            "work processes on the SAP appliance (see debugDiaBudget/debugSessions in src/config.ts).",
          { laneLimit, status },
          undefined,
          { retryable: true }, // transient occupancy, not an unimplemented capability — a stop clears it
        );
      }
      throw new AbapError(
        "UNSUPPORTED",
        `A debug session from an earlier, unsuccessful start attempt is still registered ` +
          `(status "${status}") even though it never became this process's active session ` +
          "(one session per process) — clear it first: abap_debug({action:\"stop\"}); if that " +
          "reports the cleanup is still running, retry, or use " +
          "abap_debug({action:\"stop\", force:true}) to force it out of tracking.",
        { status, tracked },
        undefined,
        { retryable: true }, // transient occupancy, not an unimplemented capability — a stop clears it
      );
    }
    targetLane = 0;
  } else {
    // Multi-lane path (laneLimit > 1) — deliberately kept SEPARATE from the
    // limit-1 branch above rather than folded into one unified check, so
    // the hard byte-identical requirement above can never be perturbed by
    // logic that only exists for laneLimit > 1.
    //
    // A session `listActiveDebugSessions()` shows that no lane currently
    // tracks is "leaked" — left behind by an earlier start attempt that
    // constructed a `DebugSession` and then failed before any lane could
    // claim it — a process-wide hazard independent of which lane would
    // otherwise be free. Cleared the same way the limit-1 branch treats an
    // untracked session: refuse and name `abap_debug({action:"stop"})`.
    const tracked = new Set(activeLaneRuns().map((r) => r.session));
    const leaked = listActiveDebugSessions().find((s) => !tracked.has(s));
    if (leaked) {
      const status = leaked.snapshot.status;
      throw new AbapError(
        "UNSUPPORTED",
        `A debug session from an earlier, unsuccessful start attempt is still registered ` +
          `(status "${status}") even though it is not one of this process's tracked debug ` +
          "lanes — clear it first: abap_debug({action:\"stop\"}); if that reports the cleanup " +
          "is still running, retry, or use abap_debug({action:\"stop\", force:true}) to force it " +
          "out of tracking.",
        { status, tracked: false },
        undefined,
        { retryable: true }, // transient occupancy, not an unimplemented capability — a stop clears it
      );
    }
    const free = firstFreeLane(laneLimit);
    if (free === undefined) {
      // All of THIS process's own configured lanes are busy — see
      // src/adt/errors.ts's `DEBUG_ALL_LEASES_BUSY` doc comment for how
      // this differs from `DEBUG_SESSION_LOCKED_CROSS_PROCESS` and from
      // SAP's own 409/conflictDetected. `status` names one representative
      // busy lane (lane 0's) status — the same detail key the laneLimit-1
      // branch above attaches for its one busy session, so both
      // `DEBUG_ALL_LEASES_BUSY` shapes carry `{ laneLimit, status }` and are
      // machine-comparable regardless of which branch fired (issue #89).
      const status = activeLaneRuns()[0]!.session.snapshot.status;
      throw new AbapError(
        "DEBUG_ALL_LEASES_BUSY",
        `All ${laneLimit} configured debug lanes are already busy in this process (e.g. status ` +
          `"${status}"). Raise ABAP_DEBUG_SESSIONS to configure more — itself capped at ` +
          "floor(ABAP_DEBUG_DIA_BUDGET / 2), since each concurrent debug session pins 2 dialog " +
          "work processes on the SAP appliance (see debugDiaBudget/debugSessions in src/config.ts).",
        { laneLimit, status },
        'Stop an existing session first: abap_debug({action:"stop"}).',
        { retryable: true }, // transient occupancy: a stop on any lane frees one (issue #89)
      );
    }
    // Raising ABAP_DEBUG_SESSIONS only raises THIS CLIENT's own limit — it
    // does not, by itself, make a second concurrent debug session work.
    // Per the wire evidence identity.ts cites (test/cassettes/debugger/
    // listener-conflict-409.cassette.json), SAP refuses a second
    // global-scope debugger listener for the SAME SAP user with a
    // 409/conflictDetected (T100 SY 530) even from a different
    // (terminalId, ideId) identity — so a second lane only has a chance of
    // doing anything useful when it authenticates as a DIFFERENT
    // ABAP_USER. Not claimed as tested in this multi-lane shape; only the
    // underlying single-listener exclusivity is evidenced.
    targetLane = free;
  }

  if (!input.breakpoints || input.breakpoints.length === 0) {
    throw new AbapError(
      "BAD_INPUT",
      "abap_debug({action:\"start\"}) requires a non-empty \"breakpoints\" array.",
      {},
    );
  }
  if (!input.run) {
    throw new AbapError(
      "BAD_INPUT",
      "abap_debug({action:\"start\"}) requires a \"run\" object naming the program to trigger.",
      {},
    );
  }

  // D4: judged BEFORE anything touches the network — a refused start must
  // cost zero requests. Only the name is known yet, so this is `preflight`;
  // the package rule applies once a breakpoint resolves below.
  const runTarget: SafetyTarget = { name: parseObjectRef(input.run.object).name };
  assertDebugWrite(gate, runTarget, "preflight");
  // D15: ONE target object with two readers (this module's `assertSessionWrite`
  // and `DebugTransport`, which holds it by reference for the session's whole
  // life) — the refinement below (a resolved breakpoint beats the parsed run
  // name) must happen IN PLACE, or the transport backstop reads a stale target.
  const sessionTarget: SafetyTarget = { ...runTarget };
  let gateTarget: DebugGateTarget = { target: sessionTarget, phase: "preflight" };

  // Reserve BEFORE the debug client is built, AFTER all input validation
  // above — a BAD_INPUT never takes a lease, and a refusal surfaces with
  // nothing armed. This lease is STILL the DIA-budget accounting for the work
  // process the debug session pins (handed to `createSession` as
  // `sessionLease` below, released exactly once by `DebugSession.doTerminate`) —
  // issue #89 does not change that. What it changes is which CONNECTION the
  // debugger actually talks on: that is now a separate, dedicated one (see
  // `sessionConn` below), not the leased slot's connection.
  const slot = await deps.reserveDebugSession?.("debugger/listeners");
  // A dedicated connection for this session's whole life — issue #89. Nothing
  // else ever shares its stateful ADT session, so no later `start` in this
  // process can inherit a "Debuggee already attached" failure from it. Minted
  // AFTER the slot so a failure here still has a slot to release; released
  // BEFORE rethrowing, since nothing else will ever exist to release it.
  let dedicatedConn: AbapConnection | undefined;
  if (deps.createDebugSessionConnection) {
    try {
      dedicatedConn = await deps.createDebugSessionConnection();
    } catch (e) {
      slot?.release(); // nothing else will ever release it — no session exists yet
      throw e;
    }
  }
  // Captured once, ahead of `createSession`, so both the success path
  // (stored on `CurrentRun` for a later `stop` to drop) and this function's
  // own failure-cleanup path below share the exact connection the session's
  // `DebugClient` was actually wired to — see `sessionConn`'s doc comment on
  // `CurrentRun`. Falls back to the leased slot's connection, then the
  // caller's own, only when `deps.createDebugSessionConnection` is absent —
  // the historical, still-tested (M14) behaviour.
  const sessionConn = dedicatedConn ?? slot?.conn ?? conn;
  const closeSessionConn = makeSessionConnCloser(
    sessionConn,
    deps.log,
    dedicatedConn !== undefined,
    "session end",
  );
  let session: DebugSession;
  try {
    session = deps.createSession(sessionConn, gate, {
      target: sessionTarget,
      sessionLease: slot,
      lane: targetLane,
    });
  } catch (e) {
    // The session never existed, so nothing else will ever release the slot
    // — and, if minted, the dedicated connection this session never got to use.
    slot?.release();
    void closeSessionConn();
    throw e;
  }

  // Everything that can fail before the session is "successfully started"
  // funnels through the catch below, which cleans it up. Deliberately NOT
  // wrapped around the final response composition: if that itself fails, the
  // live, attached session must survive (recoverable via stack/vars) rather
  // than being torn down for a rendering problem.
  let attachedStack: DebugStack;
  let attachedStateId: StateId;
  let triggerConn: AbapConnection | undefined;
  let triggerSettled: Promise<DebugTriggerOutcome> | undefined;
  // Live-verified: the ADT debugger accepts and echoes a non-zero skipCount
  // but does not enforce it — every hit suspends. Collected so the response
  // repeats the warning per armed skipCount, not just in the schema text.
  const skipCountWarnings: string[] = [];
  // #152 — exception classes this start asked for, and the subset the server
  // echoed as armed. Outside the try so the run record can carry them.
  const requestedExceptionClasses: string[] = [];
  const armedExceptionClasses: string[] = [];
  // Declared OUTSIDE the try so the catch can release the trigger connection
  // even though it's created inside it. Starts as a no-op.
  let closeTriggerConn: () => void = () => {};
  try {
    const resolvedCache = new Map<string, ResolvedObject>();
    const breakpoints: Breakpoint[] = [];
    for (const bp of input.breakpoints) {
      if (bp.skipCount !== undefined && bp.skipCount > 0) {
        const where =
          bp.kind === "line"
            ? `${bp.object}:${bp.line}`
            : bp.kind === "exception"
              ? bp.exceptionClass
              : bp.kind === "statement"
                ? bp.statement
                : `${bp.msgId} ${bp.msgTy}${bp.msgNo}`;
        skipCountWarnings.push(
          `skipCount:${bp.skipCount} on ${where} was sent to SAP but is NOT enforced by this ADT ` +
            "debugger backend (live-verified on A4H) — expect a suspend on EVERY hit, " +
            'not just the Nth. Use abap_debug({action:"step", step:"continue"}) to advance past ' +
            "hits you want to skip.",
        );
      }
      if (bp.kind === "line") {
        const key = bp.object.toUpperCase();
        let resolved = resolvedCache.get(key);
        if (!resolved) {
          try {
            resolved = await deps.resolveObject(conn, bp.object);
          } catch (e) {
            // A BOPF business object (`adtcore:type="BOBF"`) has no source at
            // all, so `resolveObject` can only fall through to its generic
            // "type is not readable" UNSUPPORTED. Catch that shape and name
            // the real fix instead of leaving the caller to guess.
            if (
              e instanceof AbapError &&
              e.code === "UNSUPPORTED" &&
              Array.isArray(e.details.types) &&
              (e.details.types as unknown[]).includes("BOBF")
            ) {
              throw new AbapError(
                "UNSUPPORTED",
                `${bp.object} is a BOPF business object, which has no source. Set the breakpoint in its implementation class instead.`,
                { object: bp.object },
                'Run abap_bopf mode:"show" to list them.',
              );
            }
            throw e;
          }
          resolvedCache.set(key, resolved);
        }
        if (ENHANCEMENT_DEBUG_TYPES.has(resolved.type)) {
          await refuseEnhancementDebugTarget(conn, bp.object, resolved);
        }
        const baseUri = resolved.sourceUri ?? resolved.uri;
        if (!baseUri) {
          throw new AbapError(
            "UNSUPPORTED",
            `${bp.object} has no source URI to attach a line breakpoint to.`,
            { object: bp.object },
          );
        }
        // D4: a line breakpoint is a WRITE against the object it's armed in
        // — not necessarily the object being run. Judged `final` since
        // resolution has just produced the real package.
        const bpTarget: SafetyTarget = {
          name: resolved.name,
          packageName: resolved.packageName,
          type: resolved.type,
        };
        assertDebugWrite(gate, bpTarget);
        // Refined IN PLACE (see `sessionTarget` above) so the transport-level
        // backstop narrows with us.
        if (gateTarget.phase === "preflight") {
          Object.assign(sessionTarget, bpTarget);
          gateTarget = { target: sessionTarget, phase: "final" };
        }
        breakpoints.push({
          kind: "line",
          uri: `${baseUri}#start=${bp.line}`,
          // D5: forward what the caller asked for instead of dropping it.
          ...(bp.condition !== undefined ? { condition: bp.condition } : {}),
          ...(bp.skipCount !== undefined ? { skipCount: bp.skipCount } : {}),
        });
      } else if (bp.kind === "exception") {
        // An exception breakpoint names a class to WATCH, not modify — gating
        // it against the exception class's own name would deny every standard
        // CX_* for no safety gain, so the session-level (run target) check covers it.
        //
        // #152 — SAP does not refuse an exception breakpoint whose class it
        // cannot find (live: an empty exceptionClass was answered 200 and
        // registered nothing — test/debug-xml-request.test.ts), so an unknown
        // class would be armed, never fire, and the run would end in a dump
        // with nothing to say why. Resolve the class first (one read per
        // distinct class, cached) and refuse the start by name instead.
        const exceptionClass = bp.exceptionClass.trim().toUpperCase();
        if (!resolvedCache.has(exceptionClass)) {
          try {
            resolvedCache.set(exceptionClass, await deps.resolveObject(conn, exceptionClass));
          } catch (e) {
            throw new AbapError(
              "BAD_INPUT",
              `Exception breakpoint on ${exceptionClass}: the exception class could not be found ` +
                `(${describeUnknownError(e)}). SAP would accept the breakpoint and never fire it, so the ` +
                "start is refused instead.",
              { exceptionClass, cause: describeUnknownError(e) },
            );
          }
        }
        requestedExceptionClasses.push(exceptionClass);
        breakpoints.push({
          kind: "exception",
          exceptionClass: bp.exceptionClass,
          ...(bp.condition !== undefined ? { condition: bp.condition } : {}),
          ...(bp.skipCount !== undefined ? { skipCount: bp.skipCount } : {}),
        });
      } else if (bp.kind === "statement") {
        // Same reasoning as exception above: a statement breakpoint names no
        // object (it's a keyword, e.g. RAISE, that fires anywhere it occurs),
        // so there is nothing to resolve or gate more tightly than the run
        // target already covers. Stays `preflight` — never narrows `gateTarget`.
        breakpoints.push({
          kind: "statement",
          statement: bp.statement,
          ...(bp.condition !== undefined ? { condition: bp.condition } : {}),
          ...(bp.skipCount !== undefined ? { skipCount: bp.skipCount } : {}),
        });
      } else {
        // Message breakpoints (kind "message") likewise name no object —
        // just a message class/number/type SAP raises anywhere — so treated
        // identically to exception/statement above.
        breakpoints.push({
          kind: "message",
          msgId: bp.msgId,
          msgNo: bp.msgNo,
          msgTy: bp.msgTy,
          ...(bp.condition !== undefined ? { condition: bp.condition } : {}),
          ...(bp.skipCount !== undefined ? { skipCount: bp.skipCount } : {}),
        });
      }
    }

    const created = await session.prepareBreakpoints(breakpoints);
    // #152 — the server echoes every breakpoint it armed (live: an exception
    // breakpoint comes back as `KIND=5.EXCEPTION_CLASS=<class>`, cassette
    // bp-set-exception-accepted). One accepted without an echo is not armed;
    // say so now rather than after the run has dumped.
    for (const cls of requestedExceptionClasses) {
      const echoed = created.some(
        (c) => c.kind === "exception" && c.exceptionClass.trim().toUpperCase() === cls,
      );
      if (echoed) {
        if (!armedExceptionClasses.includes(cls)) armedExceptionClasses.push(cls);
      } else {
        skipCountWarnings.push(
          `Exception breakpoint on ${cls}: the server accepted the breakpoints request but did not echo ` +
            `this breakpoint as armed — treat it as NOT armed; the run will not stop when ${cls} is raised.`,
        );
      }
    }
    await session.armListener();

    triggerConn = await deps.createTriggerConnection();
    closeTriggerConn = makeTriggerConnCloser(triggerConn, deps.log);
    triggerSettled = deps.triggerRun(triggerConn, input.run, maxChars, gate).then(
      (res) => ({ ok: true as const, text: res.text }),
      // Preserve the structured AbapError.code alongside the flattened
      // message — see `DebugTriggerOutcome`'s doc comment.
      (e) => ({ ok: false as const, error: describeUnknownError(e), code: isAbapError(e) ? e.code : undefined }),
    );
    // Happy-path release; not the ONLY release — every teardown path also
    // calls `closeTriggerConn` directly so a trigger that never settles can't
    // strand the connection. Trailing catch is unreachable belt-and-braces.
    void triggerSettled.finally(closeTriggerConn).catch(() => {});

    const listenResult = await session.waitForDebuggee();
    if (listenResult.kind !== "debuggee") {
      if (listenResult.kind === "conflict") {
        throw new AbapError(
          "ADT_ERROR",
          `abap_debug start: another listener already holds this session ` +
            `(${listenResult.conflict.conflictText}${
              listenResult.conflict.ideUser ? `, ideUser=${listenResult.conflict.ideUser}` : ""
            }).`,
          { conflict: listenResult.conflict },
          "Retrying will not clear this: a 409 here means a DIFFERENT (terminalId, ideId) " +
            "identity already holds the global-scope listener for this SAP user. Stop that " +
            "listener, or give this process a stable ABAP_TERMINAL_ID/ABAP_IDE_ID pair that " +
            "matches it.",
        );
      }
      throw new AbapError(
        "ADT_ERROR",
        `abap_debug start: timed out waiting for the debuggee to hit a breakpoint (kind="${listenResult.kind}").`,
        { kind: listenResult.kind },
      );
    }

    const attached = await session.attach(listenResult.debuggee.id);
    attachedStack = attached.stack;
    attachedStateId = attached.stateId;
  } catch (e) {
    // Order matters. Cleanup FIRST: on a `waitForDebuggee` timeout the trigger
    // program is likely blocked inside the debuggee, and stopping the
    // listener/clearing breakpoints is what lets it run on and produce the
    // output we're about to ask for. Bounded so it can't hold the original
    // error hostage.
    // Read BEFORE calling cleanup(): terminate()'s own internal steps drain the
    // owned-breakpoint/watchpoint arrays as they issue their deletes, so reading
    // this after cleanup() had already started could race down to 0 owned. See
    // `terminateDeadlineMs`'s doc comment (src/debug/session.ts) for why the
    // order matters, and `START_FAILURE_CLEANUP_WAIT_MS`'s doc comment for why
    // this floors rather than replaces the constant.
    const cleanupWaitMs = Math.max(START_FAILURE_CLEANUP_WAIT_MS, session.terminateDeadlineMs + 1_000);
    await raceDeadline(
      session.cleanup().catch(() => undefined),
      cleanupWaitMs,
    );
    // A failed start still attached (or attempted to attach) on `sessionConn`
    // — release it here too, or the NEXT `start` inherits the live "Debuggee
    // already attached" defect `dropDebugSessionOnConnection` documents,
    // exactly as if this had been a clean `stop`. On the (default, issue #89)
    // dedicated-connection path this discards `sessionConn` outright — there
    // is no "next start on this connection" to protect, since nothing else
    // will ever use it. On the fallback shared-connection path it drops just
    // the stateful ADT session, same as before.
    await closeSessionConn();

    // `currentRun` is only assigned on success, so on a failed start
    // `triggerSettled` would otherwise be discarded — surface it in the
    // thrown error instead, bounded so a hung trigger can't block the report.
    let triggerNote: string | undefined;
    if (triggerSettled) {
      const settled = await raceDeadline(triggerSettled, START_FAILURE_TRIGGER_WAIT_MS);
      if (settled === TIMED_OUT) {
        triggerNote =
          `The trigger run had NOT returned after ${START_FAILURE_TRIGGER_WAIT_MS} ms, so no ` +
          "program output is available to explain this.";
      } else if (!settled.ok) {
        triggerNote = `The trigger run itself failed: ${settled.error}`;
      } else {
        const text = settled.text.trim();
        triggerNote = text
          ? `PROGRAM OUTPUT from the trigger run:\n${text}`
          : "The trigger run completed and produced no output.";
      }
    }

    // Release the trigger connection on the failure path DIRECTLY — relying
    // on `triggerSettled.finally` alone left an unreachable connection behind
    // whenever the trigger never settled.
    closeTriggerConn();

    if (triggerNote) {
      // Mutating `message` rather than re-wrapping keeps the error's class,
      // code, details, hint and stack exactly as thrown.
      if (e instanceof Error) {
        e.message = `${e.message}\n\n${triggerNote}`;
        throw e;
      }
      throw new AbapError("ADT_ERROR", `${describeUnknownError(e)}\n\n${triggerNote}`, {});
    }
    throw e;
  }

  // Necessarily assigned here: the only way past the block above is a clean
  // run through the try, since the catch always rethrows.
  const run: CurrentRun = {
    session,
    sessionConn,
    closeSessionConn,
    triggerConn: triggerConn!,
    triggerSettled: triggerSettled!,
    closeTriggerConn,
    gateTarget,
    lastStack: attachedStack,
    guidance: new GuidanceLedger(),
    armedExceptionClasses,
    exceptionBreakpointFired: false,
    lane: targetLane,
  };
  debugLanes[targetLane] = run;

  // #152 — say what was caught when it is not a live debuggee: a post-mortem
  // attach (the run already dumped; an exception breakpoint set to stop BEFORE
  // the dump did not fire) or a kind this server has never seen.
  const caught = run.session.snapshot.debuggee;
  const caughtHeader: Record<string, string | undefined> = {};
  if (caught && caught.kind !== "debuggee") {
    run.guidance.noteStateChange(isPostMortemKind(caught.kind) ? "postmortem" : `kind:${caught.rawKind}`);
    caughtHeader["debuggee"] = caught.rawKind;
    if (caught.dumpId) caughtHeader["dump"] = caught.dumpId;
    skipCountWarnings.push(...run.guidance.render([describeCaughtKind(caught, run.armedExceptionClasses)]));
  }

  // Issue #89: auto-continue past framework stops that have nothing to do
  // with the object this session was started against — see
  // `MAX_FRAMEWORK_AUTO_CONTINUES`'s doc comment for the live evidence and
  // `stackTouchesObject`'s for the (deliberately generous, conservatively
  // one-directional) match rule.
  const runObjectName = parseObjectRef(input.run.object).name.toUpperCase();
  const skippedFrameworkStops: string[] = [];
  const describeTopFrame = (stack: DebugStack): string => {
    const frame = stack.frames[0];
    if (!frame) return "<no frame reported>";
    const eventBits = [frame.eventType, frame.eventName].filter((s) => s).join(" ");
    return `${frame.programName}/${frame.includeName}:${frame.line}${eventBits ? ` (${eventBits})` : ""}`;
  };
  while (
    skippedFrameworkStops.length < MAX_FRAMEWORK_AUTO_CONTINUES &&
    !stackTouchesObject(attachedStack, runObjectName)
  ) {
    skippedFrameworkStops.push(describeTopFrame(attachedStack));
    let result: Awaited<ReturnType<DebugSession["step"]>>;
    try {
      result = await run.session.step(attachedStateId, "stepContinue");
    } catch (e) {
      if (run.session.snapshot.status === "dead") {
        skipCountWarnings.push(
          `Auto-continued past ${skippedFrameworkStops.length} stop(s) outside ${runObjectName} before the ` +
            `debuggee died: ${skippedFrameworkStops.join("; ")}. A statement/exception/message breakpoint has ` +
            "no program/include restriction on the wire in ADT, so it fires in the first code that hits it " +
            `anywhere in the work process (see MAX_FRAMEWORK_AUTO_CONTINUES's doc comment, src/tools/debug.ts).`,
        );
        const out = await composeDeathOutput(run, "start", maxChars, e, skipCountWarnings);
        debugLanes[run.lane] = undefined;
        return out;
      }
      throw e;
    }
    if (run.session.snapshot.status === "dead") {
      skipCountWarnings.push(
        `Auto-continued past ${skippedFrameworkStops.length} stop(s) outside ${runObjectName} before the ` +
          `debuggee died: ${skippedFrameworkStops.join("; ")}. A statement/exception/message breakpoint has no ` +
          "program/include restriction on the wire in ADT, so it fires in the first code that hits it anywhere " +
          `in the work process (see MAX_FRAMEWORK_AUTO_CONTINUES's doc comment, src/tools/debug.ts).`,
      );
      const out = await composeDeathOutput(run, "start", maxChars, undefined, skipCountWarnings);
      debugLanes[run.lane] = undefined;
      return out;
    }
    attachedStack = result.stack;
    attachedStateId = result.stateId;
    run.lastStack = result.stack;
  }

  if (skippedFrameworkStops.length > 0) {
    if (stackTouchesObject(attachedStack, runObjectName)) {
      skipCountWarnings.push(
        `Auto-continued past ${skippedFrameworkStops.length} stop(s) whose stack did not mention ` +
          `${runObjectName} before reaching this one: ${skippedFrameworkStops.join("; ")}. A statement/` +
          "exception/message breakpoint has no program/include restriction on the wire in ADT — it fires in " +
          "the first code that hits it anywhere in the work process, which is very often SAP's own " +
          "gateway/framework code running long before the caller's own object gets a chance to run (see " +
          "MAX_FRAMEWORK_AUTO_CONTINUES's doc comment, src/tools/debug.ts).",
      );
    } else {
      skipCountWarnings.push(
        `Auto-continue stopped after reaching MAX_FRAMEWORK_AUTO_CONTINUES (${MAX_FRAMEWORK_AUTO_CONTINUES}) ` +
          `without a stack mentioning ${runObjectName}: ${skippedFrameworkStops.join("; ")}. The session is ` +
          `suspended in code outside ${runObjectName} — keep issuing ` +
          'abap_debug({action:"step", step:"continue"}) to move past it, or inspect the current stop as-is.',
      );
    }
  }

  return await composeStopOutput(run, "start", attachedStack, attachedStateId, maxChars, skipCountWarnings, caughtHeader);
}

async function handleStep(
  input: DebugInput,
  maxChars: number,
  gate: SafetyGate,
  deps: DebugToolDeps,
): Promise<BuiltResponse> {
  const run = resolveLaneRun(input.stateId);
  if (!run) {
    throw new AbapError(
      "BAD_INPUT",
      'No active debug session. Start one with abap_debug({action:"start", ...}).',
    );
  }
  if (!input.stateId) {
    throw new AbapError("BAD_INPUT", 'abap_debug({action:"step"}) requires "stateId".');
  }
  if (!input.step) {
    throw new AbapError("BAD_INPUT", 'abap_debug({action:"step"}) requires "step".');
  }
  // D4: a step resumes a suspended debuggee on the live system. Gated BEFORE
  // the request is built, against the object this session was armed on.
  assertSessionWrite(gate, run);

  const kind = stepKindOf(input.step);

  // `jumpToLine` moves the execution pointer WITHOUT running the code in
  // between — unlike every other step (including `runToLine`, which still
  // executes everything on the way), it can skip statements and the checks
  // they'd have run. Gated SEPARATELY from the general write-gate above with
  // two independent checks: (1) server-level ceiling
  // Config.allowDebugJumpToLine, off by default and not implied by
  // ABAP_ALLOW_WRITE; (2) per-call confirm:"jumpToLine" echo, same idiom as
  // src/tools/transport.ts's release/delete.
  if (kind === "stepJumpToLine") {
    if (deps.allowJumpToLine !== true) {
      throw new AbapError(
        "DEBUG_JUMP_DISABLED",
        'step:"jumpToLine" is disabled on this server. Set ABAP_ALLOW_DEBUG_JUMP_TO_LINE=true to ' +
          "enable it — this is deliberately separate from ABAP_ALLOW_WRITE, because jumpToLine can " +
          "skip statements (and any authorization/validation checks they would have run) instead of " +
          'executing them in order. Use step:"runToLine" instead if the code in between is safe to run.',
        { step: input.step },
      );
    }
    if (input.confirm !== "jumpToLine") {
      throw new AbapError(
        "BAD_INPUT",
        'step:"jumpToLine" requires confirm:"jumpToLine" on the SAME call, even though ' +
          "ABAP_ALLOW_DEBUG_JUMP_TO_LINE is enabled — this step can skip code (and any checks it " +
          "would have run) rather than executing it in order. Reissue the call with " +
          'confirm:"jumpToLine" once you are sure this is the right target line.',
        { step: input.step },
      );
    }
  }

  let uri: string | undefined;
  if (LINE_TARGETED_STEPS.has(kind)) {
    if (input.toLine === undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `abap_debug({action:"step", step:"${input.step}"}) requires "toLine" — the line in the ` +
          "current program to run to. Without it there is no target and the step would be a no-op.",
        { step: input.step },
      );
    }
    uri = lineStepUri(run.lastStack, input.toLine);
  }

  let result: Awaited<ReturnType<DebugSession["step"]>>;
  try {
    result = await run.session.step(input.stateId, kind, uri);
  } catch (e) {
    if (run.session.snapshot.status === "dead") {
      const out = await composeDeathOutput(run, "step", maxChars, e);
      debugLanes[run.lane] = undefined;
      return out;
    }
    throw e;
  }
  if (run.session.snapshot.status === "dead") {
    const out = await composeDeathOutput(run, "step", maxChars);
    debugLanes[run.lane] = undefined;
    return out;
  }
  run.lastStack = result.stack;
  // #151 — a breakpoint hit is a state change worth re-reading the full notes
  // for; the same breakpoint hit again (a loop under step:"continue") is not.
  if (result.step.reachedBreakpoints.length > 0) {
    run.guidance.noteStateChange(`bp:${result.step.reachedBreakpoints.map((b) => b.id).join(",")}`);
  }
  // #152 — an exception breakpoint's server id is `KIND=5.EXCEPTION_CLASS=…`
  // (live cassette bp-set-exception-accepted); either signal counts as fired.
  if (result.step.reachedBreakpoints.some((b) => b.kind === "exception" || b.id.startsWith("KIND=5."))) {
    run.exceptionBreakpointFired = true;
  }
  // Advisory (see session.ts's `visitedPositions`): this exact (program,
  // stack level, line) has been reported before this session. The ONE fact
  // provable about a revisit — NOT a loop-iteration count. Explained in full
  // once per session (#151); afterwards only the fact.
  const revisitNotes =
    result.positionVisitCount > 1
      ? run.guidance.render([
          {
            key: "revisit",
            full:
              `Position revisited: this exact program/line/stack-level has now been reached ` +
              `${result.positionVisitCount} times by stepping in this session. If you are stepping ` +
              `through a loop body, "step over"/"step into" can under-report how many iterations ` +
              `actually ran between visits — this only proves you returned to this line, not how ` +
              `many times the loop body executed in between. For a reliable per-iteration count, set ` +
              `a breakpoint at the loop body's start (abap_debug action:"start" or a line breakpoint) ` +
              `and use step:"continue" repeatedly instead of stepping through — each hit is a real, ` +
              `separately counted stop.`,
            brief:
              `Position revisited (${result.positionVisitCount} times in this session) — proves a return to ` +
              "this line, not an iteration count; see the earlier NOTE.",
          },
        ])
      : [];
  // D-watch: `session.readWatchpoints()`'s own doc comment says it is "meant
  // for the tool layer to call right after a stop" with no `stateId` of its
  // own — and `noteStatefulRequest`'s head-of-line-blocking rule only bites a
  // stateful request issued while a LISTENER long-poll is outstanding
  // (between `armListener()` and attach). A step has already completed by
  // this point — there is no outstanding listener to block behind — so this
  // extra read is safe here. Best-effort only: a failure here must not lose
  // the step's own result, so it degrades to "old value not available"
  // rather than throwing.
  const watchpointNotes: string[] = [];
  if (result.step.reachedWatchpoints.length > 0) {
    let byId: Map<string, Watchpoint> | undefined;
    try {
      const owned = await run.session.readWatchpoints();
      byId = new Map(owned.map((wp) => [wp.id, wp]));
    } catch {
      byId = undefined;
    }
    for (const hit of result.step.reachedWatchpoints) {
      const old = byId?.get(hit.id)?.oldValue;
      watchpointNotes.push(
        `Stopped on watchpoint ${hit.id} (${hit.variableName}): now ${renderWatchValue(hit.currentValue)}` +
          (old !== undefined
            ? `, was ${renderWatchValue(old)} (read back from the watchpoint resource after the stop)`
            : `. Old value not available from this step's own data — call ` +
              'abap_debug({action:"watch", op:"list"}) to check.'),
      );
    }
  }
  return composeStopOutput(run, "step", result.stack, result.stateId, maxChars, [
    ...revisitNotes,
    ...watchpointNotes,
  ]);
}

async function handleStack(input: DebugInput, maxChars: number): Promise<BuiltResponse> {
  const run = resolveLaneRun(input.stateId);
  if (!run) {
    throw new AbapError(
      "BAD_INPUT",
      'No active debug session. Start one with abap_debug({action:"start", ...}).',
    );
  }
  if (!input.stateId) {
    throw new AbapError("BAD_INPUT", 'abap_debug({action:"stack"}) requires "stateId".');
  }
  const wireId = wireStateId(run, input.stateId);
  const stack = await run.session.getStack(input.stateId);
  run.lastStack = stack;
  const stackText = renderStackSection(stack, wireId);
  const visibleFrames = stack.frames.filter((f) => !f.systemProgram);
  const top = visibleFrames[0] ?? stack.frames[0];
  return buildResponse({
    header: {
      action: "stack",
      status: run.session.snapshot.status,
      program: top?.programName,
      include: top?.includeName,
      line: top?.line,
      stateId: wireId,
    },
    sections: [{ title: "STACK", content: stackText }],
    maxChars: clampMaxChars(maxChars),
  });
}

/**
 * `setStackPosition`, exposed read-only. Live-verified (two independent
 * captured scripts): the switch genuinely moves the server-side READ cursor,
 * and has ZERO effect on execution — the server unconditionally resets the
 * cursor to the live top frame on any real step. Not gated behind
 * `assertSessionWrite` for that reason — observes an existing stop, like
 * `stack`/`status`. Must never accept a value to write (`setVariableValue`
 * stays unexposed).
 */
async function handleFrame(input: DebugInput, maxChars: number): Promise<BuiltResponse> {
  const run = resolveLaneRun(input.stateId);
  if (!run) {
    throw new AbapError(
      "BAD_INPUT",
      'No active debug session. Start one with abap_debug({action:"start", ...}).',
    );
  }
  if (!input.stateId) {
    throw new AbapError("BAD_INPUT", 'abap_debug({action:"frame"}) requires "stateId".');
  }
  const wireId = wireStateId(run, input.stateId);
  if (input.frame === undefined) {
    throw new AbapError(
      "BAD_INPUT",
      'abap_debug({action:"frame"}) requires "frame" — the 1-based stackPosition of the frame ' +
        "to move the read cursor to.",
    );
  }
  // Hoisted so the STACK section can render from a narrowed local — the
  // compiler can't follow "target implies lastStack" through the optional
  // chain plus `find`.
  const lastStack = run.lastStack;
  const target = lastStack?.frames.find((f) => f.stackPosition === input.frame);
  if (!lastStack || !target) {
    throw new AbapError(
      "BAD_INPUT",
      `abap_debug({action:"frame", frame:${input.frame}}) does not match any frame in the most ` +
        `recently known stack. Call abap_debug({action:"stack", stateId:"${wireId}"}) ` +
        "first to see the current stackPosition values.",
      { frame: input.frame },
    );
  }
  await run.session.setStackPosition(input.stateId, { stackPosition: input.frame, stackType: "ABAP" });
  const root = await run.session.getRootVariables(input.stateId);
  const entries = root.variables.variables.map((variable) => ({ variable }));
  const survey = renderSurvey(entries, { maxChars: DEBUG_MAX_CHARS, stateId: wireId });
  const stackText = renderStackSection(lastStack, wireId);
  const frameNotes = [
    ...run.guidance.render([
      {
        key: "frame-cursor",
        full:
          `Read cursor switched to frame #${target.stackPosition} — this does not change what runs ` +
          "next. The next step resumes from the live top frame regardless (live-verified).",
        brief: `Read cursor at frame #${target.stackPosition}; the next step still resumes from the live top frame.`,
      },
    ]),
    ...(survey.degraded.length
      ? [`${survey.degraded.length} value(s) shortened to fit budget — each still names its own retrieval call.`]
      : []),
  ];
  return buildResponse({
    header: {
      action: "frame",
      status: run.session.snapshot.status,
      program: target.programName,
      include: target.includeName,
      line: target.line,
      frame: target.stackPosition,
      stateId: wireId,
    },
    sections: [{ title: "STACK", content: stackText }],
    body: survey.text,
    bodyLabel: "VARIABLES",
    notes: frameNotes,
    maxChars: budgetWithNotes(frameNotes, clampMaxChars(maxChars)),
  });
}

async function handleKeepalive(
  maxChars: number,
  gate: SafetyGate,
): Promise<BuiltResponse> {
  // `keepalive`'s input schema carries no `stateId` — resolve conservatively
  // (see `resolveLaneRun`'s doc comment): the sole active lane, or the
  // lowest-indexed one if more than one lane happens to be active.
  const run = resolveLaneRun(undefined);
  if (!run) {
    throw new AbapError(
      "BAD_INPUT",
      'No active debug session. Start one with abap_debug({action:"start", ...}).',
    );
  }
  // D4: keepalive keeps a dialog work process pinned on the live system —
  // a write, and formerly the one execution-affecting action with no check.
  assertSessionWrite(gate, run);
  run.session.keepalive();
  const snapshot = run.session.snapshot;
  return buildResponse({
    header: {
      action: "keepalive",
      status: snapshot.status,
      stateId: snapshot.stateId === undefined ? undefined : shortStateId(snapshot.stateId),
      debugSessionId: snapshot.debugSessionId,
    },
    maxChars: clampMaxChars(maxChars),
  });
}

/** One line describing a server-echoed breakpoint for the `breakpoints` action's list/add output. */
function describeBreakpoint(bp: CreatedBreakpoint): string {
  switch (bp.kind) {
    case "line":
      return bp.uri;
    case "exception":
      return `exception ${bp.exceptionClass}`;
    case "statement":
      return `statement ${bp.statement}`;
    case "message":
      return `message ${bp.msgId} ${bp.msgTy}${bp.msgNo}`;
  }
}

/**
 * Map one `breakpoints[]` input entry to the wire `Breakpoint` shape for
 * `action:"breakpoints", op:"add"`. Deliberately simpler than `handleStart`'s
 * per-kind loop: it does not narrow `gateTarget` (there is nothing to narrow
 * — the session's target was fixed once at `start`, and `assertSessionWrite`
 * re-asserts exactly that captured target/phase for every follow-up write,
 * the same way `step`/`keepalive` already do) and it does not special-case
 * the BOPF "no source" error `handleStart` gives a friendlier message for —
 * a plain `resolveObject` failure surfaces as-is here instead.
 */
async function mapInputBreakpointForAdd(
  bp: NonNullable<DebugInput["breakpoints"]>[number],
  conn: AbapConnection,
  deps: DebugToolDeps,
  resolvedCache: Map<string, ResolvedObject>,
): Promise<Breakpoint> {
  if (bp.kind === "line") {
    const key = bp.object.toUpperCase();
    let resolved = resolvedCache.get(key);
    if (!resolved) {
      resolved = await deps.resolveObject(conn, bp.object);
      resolvedCache.set(key, resolved);
    }
    const baseUri = resolved.sourceUri ?? resolved.uri;
    if (!baseUri) {
      throw new AbapError(
        "UNSUPPORTED",
        `${bp.object} has no source URI to attach a line breakpoint to.`,
        { object: bp.object },
      );
    }
    return {
      kind: "line",
      uri: `${baseUri}#start=${bp.line}`,
      ...(bp.condition !== undefined ? { condition: bp.condition } : {}),
      ...(bp.skipCount !== undefined ? { skipCount: bp.skipCount } : {}),
    };
  }
  if (bp.kind === "exception") {
    return {
      kind: "exception",
      exceptionClass: bp.exceptionClass,
      ...(bp.condition !== undefined ? { condition: bp.condition } : {}),
      ...(bp.skipCount !== undefined ? { skipCount: bp.skipCount } : {}),
    };
  }
  if (bp.kind === "statement") {
    return {
      kind: "statement",
      statement: bp.statement,
      ...(bp.condition !== undefined ? { condition: bp.condition } : {}),
      ...(bp.skipCount !== undefined ? { skipCount: bp.skipCount } : {}),
    };
  }
  return {
    kind: "message",
    msgId: bp.msgId,
    msgNo: bp.msgNo,
    msgTy: bp.msgTy,
    ...(bp.condition !== undefined ? { condition: bp.condition } : {}),
    ...(bp.skipCount !== undefined ? { skipCount: bp.skipCount } : {}),
  };
}

/**
 * `action:"breakpoints"` — list/add/remove against the session's OWN armed
 * breakpoints. Requires an active session with `stateId` given, same as
 * `stack`/`frame` — there is no ADT endpoint that reads back what's actually
 * armed while stopped (live-verified: see
 * test/fixtures/live-captured/917-bp-list-while-stopped.meta.json and
 * 925-bp-list-after-cleanup.meta.json), so `op:"list"` can only ever report
 * this session's own in-memory record, never confirm the server's live state.
 */
async function handleBreakpoints(
  conn: AbapConnection,
  input: DebugInput,
  maxChars: number,
  deps: DebugToolDeps,
  gate: SafetyGate,
): Promise<BuiltResponse> {
  const run = resolveLaneRun(input.stateId);
  if (!run) {
    throw new AbapError(
      "BAD_INPUT",
      'No active debug session. Start one with abap_debug({action:"start", ...}).',
    );
  }
  const op = input.op ?? "list";
  if (!input.stateId) {
    throw new AbapError(
      "BAD_INPUT",
      `abap_debug({action:"breakpoints", op:"${op}"}) requires "stateId" — same as stack/frame, ` +
        "to confirm which stop this call addresses.",
    );
  }
  const wireId = wireStateId(run, input.stateId);

  if (op === "list") {
    const owned = run.session.listOwnedBreakpoints();
    return buildResponse({
      header: {
        action: "breakpoints",
        op: "list",
        status: run.session.snapshot.status,
        stateId: wireId,
        count: owned.length,
      },
      sections: [
        {
          title: "BREAKPOINTS",
          content: owned.length
            ? owned.map((bp) => `${bp.id}\t${describeBreakpoint(bp)}`).join("\n")
            : "(none owned by this session)",
        },
      ],
      notes: [
        "This lists only breakpoints THIS session armed (in-memory) — ADT has no server-side read " +
          "of what is actually armed while stopped (live-verified — see the two captures cited in " +
          "this handler's doc comment). If SAP silently dropped or renumbered one, this will not " +
          "show it.",
      ],
      maxChars: clampMaxChars(maxChars),
    });
  }

  if (op === "add") {
    if (!input.breakpoints || input.breakpoints.length === 0) {
      throw new AbapError(
        "BAD_INPUT",
        'abap_debug({action:"breakpoints", op:"add"}) requires a non-empty "breakpoints" array.',
      );
    }
    assertSessionWrite(gate, run);
    const resolvedCache = new Map<string, ResolvedObject>();
    const toArm: Breakpoint[] = [];
    for (const bp of input.breakpoints) {
      toArm.push(await mapInputBreakpointForAdd(bp, conn, deps, resolvedCache));
    }
    const created = await run.session.addBreakpoints(input.stateId, toArm);
    return buildResponse({
      header: {
        action: "breakpoints",
        op: "add",
        status: run.session.snapshot.status,
        stateId: wireId,
        count: created.length,
      },
      sections: [
        { title: "BREAKPOINTS", content: created.map((bp) => `${bp.id}\t${describeBreakpoint(bp)}`).join("\n") },
      ],
      notes: [
        "Ids are server-assigned and unpredictable — do not guess one from a prior session or a " +
          'pattern (live example: a breakpoint set at "#start=11" came back tagged ' +
          '"INCLUDE=...CM001.LINE_NR=5"). Use the id printed above for a later op:"remove".',
      ],
      maxChars: clampMaxChars(maxChars),
    });
  }

  // op === "remove"
  if (!input.id) {
    throw new AbapError("BAD_INPUT", 'abap_debug({action:"breakpoints", op:"remove"}) requires "id".');
  }
  assertSessionWrite(gate, run);
  await run.session.removeBreakpoint(input.stateId, input.id);
  return buildResponse({
    header: {
      action: "breakpoints",
      op: "remove",
      status: run.session.snapshot.status,
      stateId: wireId,
      id: input.id,
    },
    maxChars: clampMaxChars(maxChars),
  });
}

/**
 * Render a watchpoint's raw `oldValue`/`currentValue` through the same
 * truncation-marking convention real variables use (`renderScalar`), even
 * though the watchpoint wire rows (`Watchpoint`/`DebugReachedWatchpoint` in
 * types.ts) carry no `isValueIncomplete` flag at all — so this always passes
 * `isValueIncomplete: false`. That's an honest "the wire never told us this
 * was cut short", not a claim that it wasn't.
 */
function renderWatchValue(raw: string): string {
  return renderScalar({
    id: "",
    name: "",
    declaredTypeName: "",
    actualTypeName: "",
    kind: "",
    instantiationKind: "",
    accessKind: "",
    metaType: "unknown",
    parameterKind: "",
    value: raw,
    hexValue: "",
    readOnly: true,
    technicalType: "",
    length: raw.length,
    tableBody: "",
    isValueIncomplete: false,
    isException: false,
    inheritanceLevel: 0,
    inheritanceClass: "",
  });
}

/**
 * `action:"watch"` — add/list/remove watchpoints on the session's OWN
 * watchpoints. `op` defaults to `"add"` when `variable` is given, else
 * `"list"`. `op:"list"` uses `readWatchpoints()` (this session's own rows,
 * session-wide — no `stateId` needed by the underlying call, but required on
 * input anyway for the same reason `stack`/`frame` require it: confirming
 * which stop this call addresses).
 */
async function handleWatch(input: DebugInput, maxChars: number, gate: SafetyGate): Promise<BuiltResponse> {
  const run = resolveLaneRun(input.stateId);
  if (!run) {
    throw new AbapError(
      "BAD_INPUT",
      'No active debug session. Start one with abap_debug({action:"start", ...}).',
    );
  }
  const op = input.op ?? (input.variable !== undefined ? "add" : "list");
  if (!input.stateId) {
    throw new AbapError(
      "BAD_INPUT",
      `abap_debug({action:"watch", op:"${op}"}) requires "stateId" — same as stack/frame, to ` +
        "confirm which stop this call addresses.",
    );
  }
  const wireId = wireStateId(run, input.stateId);

  if (op === "add") {
    if (!input.variable) {
      throw new AbapError("BAD_INPUT", 'abap_debug({action:"watch", op:"add"}) requires "variable".');
    }
    assertSessionWrite(gate, run);
    const created = await run.session.addWatchpoint(input.stateId, {
      variableName: input.variable,
      ...(input.condition !== undefined ? { condition: input.condition } : {}),
    });
    const lines = created.map(
      (wp) =>
        `${wp.id}\t${wp.variableName}` +
        (wp.condition ? ` (condition: ${wp.condition})` : "") +
        (wp.currentValue !== undefined ? ` = ${renderWatchValue(wp.currentValue)}` : ""),
    );
    return buildResponse({
      header: {
        action: "watch",
        op: "add",
        status: run.session.snapshot.status,
        stateId: wireId,
        count: created.length,
      },
      sections: [{ title: "WATCHPOINTS", content: lines.join("\n") }],
      notes: [
        "Watchpoint ids are not stable handles in general — a PUT that modifies a watchpoint's " +
          "condition can retire the old id and hand back a new one (live-verified: see " +
          "test/fixtures/live-captured/940-watchpoint-modify-condition.meta.json, " +
          "941-watchpoint-list-after-modify.meta.json, and " +
          "942-watchpoint-create-duplicate.meta.json). This tool never modifies a watchpoint (only " +
          'creates/lists/removes), so within this session\'s life the id returned here stays valid ' +
          'until you remove it with op:"remove".',
      ],
      maxChars: clampMaxChars(maxChars),
    });
  }

  if (op === "list") {
    const owned = await run.session.readWatchpoints();
    const lines = owned.map(
      (wp) =>
        `${wp.id}\t${wp.variableName}` +
        (wp.condition ? ` (condition: ${wp.condition})` : "") +
        (wp.currentValue !== undefined ? ` = ${renderWatchValue(wp.currentValue)}` : "") +
        (wp.oldValue !== undefined ? ` (was ${renderWatchValue(wp.oldValue)})` : ""),
    );
    return buildResponse({
      header: {
        action: "watch",
        op: "list",
        status: run.session.snapshot.status,
        stateId: wireId,
        count: owned.length,
      },
      sections: [
        { title: "WATCHPOINTS", content: owned.length ? lines.join("\n") : "(none owned by this session)" },
      ],
      maxChars: clampMaxChars(maxChars),
    });
  }

  // op === "remove"
  if (!input.id) {
    throw new AbapError("BAD_INPUT", 'abap_debug({action:"watch", op:"remove"}) requires "id".');
  }
  assertSessionWrite(gate, run);
  await run.session.removeWatchpoint(input.stateId, input.id);
  return buildResponse({
    header: {
      action: "watch",
      op: "remove",
      status: run.session.snapshot.status,
      stateId: wireId,
      id: input.id,
    },
    maxChars: clampMaxChars(maxChars),
  });
}

/** Result of a `clearLeakedSessions` pass: `found` = sessions `listActiveDebugSessions()` showed that no tracked lane (`debugLanes`) accounted for; `notes` describes what happened to each. */
interface LeakedSessionClearResult {
  found: number;
  notes: string[];
}

/**
 * Single source of truth for "is there a debug session this process is still
 * responsible for": `listActiveDebugSessions()` — the same registry
 * `handleStart`'s guard reads. The tracked lanes (`debugLanes`) are NOT an
 * independent answer — they're auxiliary bookkeeping that only exists after
 * full success. A `start` that constructs a session and then fails leaves it
 * in `activeSessions` with no matching tracked lane, which used to make
 * `stop`/`status` blind to it (both dispatched on the tracked lanes alone) —
 * a process-lifetime deadlock, since the guard refused every subsequent
 * `start` forever with nothing able to clear it.
 *
 * This closes that gap: drives EVERY session the registry shows towards
 * `terminate()`, bounded like the lane-tracked path. Loops defensively even
 * though at most one such session is expected per lane.
 *
 * `force` additionally force-drops (`forceDropDebugSession`) any session
 * whose bounded `terminate()` wait didn't return — last-resort for
 * `terminate()` never reaching `doTerminate`'s `finally`. Without `force`,
 * left tracked, same "continues in the background" contract as elsewhere.
 */
async function clearLeakedSessions(
  force: boolean,
  conn: AbapConnection,
  log: ((msg: string) => void) | undefined,
): Promise<LeakedSessionClearResult> {
  const tracked = new Set(activeLaneRuns().map((r) => r.session));
  const leaked = listActiveDebugSessions().filter((s) => !tracked.has(s));
  if (leaked.length === 0) return { found: 0, notes: [] };
  const notes: string[] = [];
  await Promise.all(
    leaked.map(async (session) => {
      const before = session.snapshot.status;
      const outcome = await raceDeadline(
        session.terminate("terminated_by_caller").catch((e: unknown) => {
          notes.push(`Leaked debug session cleanup reported an error: ${describeUnknownError(e)}`);
        }),
        STOP_WAIT_MS,
      );
      if (outcome === TIMED_OUT) {
        if (force) {
          forceDropDebugSession(session);
          notes.push(
            `A leaked debug session (was "${before}") had not finished terminate() after ${STOP_WAIT_MS} ms — ` +
              "force-dropped from tracking so start is unblocked; its own cleanup continues in the background.",
          );
        } else {
          notes.push(
            `A leaked debug session (still "${before}") had not finished terminate() after ${STOP_WAIT_MS} ms ` +
              '— it continues in the background; retry stop, or use stop({force:true}) to unblock start now.',
          );
        }
        return;
      }
      notes.push(
        'Cleared a leaked debug session (no in-process trigger/gate bookkeeping — most likely left behind ' +
          `by a start that constructed it and then failed) that was "${before}"; it is now "${session.snapshot.status}".`,
      );
    }),
  );
  // Once, not per-leaked-session: every leaked `DebugSession` this process
  // could ever construct went through `handleStart` on the SAME `conn` this
  // idle `stop` call was handed (`DebugSession` itself keeps no back-reference
  // to the connection it was built on, so this is the only one available
  // here) — see `dropDebugSessionOnConnection`'s doc comment for why a
  // leaked, terminated session still needs this to unblock the next `start`.
  await dropDebugSessionOnConnection(conn, log, "clearing leaked debug session(s)");
  return { found: leaked.length, notes };
}

/** 5.7: turns `DebugSessionSnapshot.abandonedCleanupSteps` into one terse note. Caller only invokes this when the list is non-empty. */
export function formatAbandonedCleanupNote(steps: string[]): string {
  return (
    `Cleanup timed out on: ${steps.join(", ")} — may still be armed on the server ` +
    `(e.g. a breakpoint); a later session could hit it.`
  );
}

async function handleStop(
  conn: AbapConnection,
  maxChars: number,
  deps: DebugToolDeps,
  gate: SafetyGate,
  force = false,
): Promise<BuiltResponse> {
  const run = resolveLaneRun(undefined);
  if (!run) {
    // No active lane does NOT mean `listActiveDebugSessions()` is empty —
    // a `start` that constructed a session and then failed leaves it
    // registered with no tracked lane. Reach for it unconditionally, before
    // the orphan checks below (those cover a DIFFERENT gap: a listener/
    // debuggee left by an EARLIER PROCESS INSTANCE, with no live session
    // object at all). See `clearLeakedSessions`.
    const leaked = await clearLeakedSessions(force, conn, deps.log);
    // An earlier instance of this same server (crash, restart, container
    // respawn) may have armed a listener at this identity and never released
    // it. Best-effort and identity-scoped: can only find/release a listener
    // THIS server's identity would have armed. Deliberately NOT gated — it's
    // risk-REDUCING (can only end an already-orphaned listener), so a
    // tightened gate must never make an orphan un-releasable.
    let orphanNote: string | undefined;
    if (deps.releaseOrphanListener) {
      try {
        const result = await raceDeadline(deps.releaseOrphanListener(conn), STOP_WAIT_MS);
        if (result === TIMED_OUT) {
          orphanNote =
            "Checked for a listener orphaned by an earlier process instance, but the check had not " +
            "returned in time — nothing more to report.";
        } else if (result.kind === "released") {
          orphanNote =
            "Released a debug listener armed at this server's identity with no in-process session " +
            "tracking it — most likely left behind by an earlier, uncleanly-exited process instance.";
        } else if (result.kind === "conflict") {
          orphanNote = `Found something at this server's listener identity but could not confirm release: ${result.detail}`;
        }
        // result.kind === "absent": the common case — nothing orphaned, nothing to report.
      } catch (e) {
        orphanNote = `Orphaned-listener check failed: ${describeUnknownError(e)}`;
      }
    }
    // force:true — explicit-only sibling to the always-on listener release
    // above. A stale ATTACHED debuggee may be mid-execution of real work, so
    // clearing it unconditionally on every idle `stop` would risk terminating
    // something legitimate. Exact recovery `DebugSession.attach()`'s
    // failed-double-attach error names. See `releaseOrphanDebuggee`.
    let debuggeeNote: string | undefined;
    if (force && deps.releaseOrphanDebuggee) {
      try {
        const result = await raceDeadline(deps.releaseOrphanDebuggee(conn), FORCE_CLEAR_WAIT_MS);
        if (result === TIMED_OUT) {
          debuggeeNote =
            "Force-clear of an orphaned debuggee was requested, but the check had not returned in " +
            "time — nothing more to report.";
        } else if (result.kind === "released") {
          debuggeeNote =
            "Force-terminated a debuggee attached at this server's identity with no in-process " +
            "session tracking it — most likely left behind by an earlier, uncleanly-exited process " +
            "instance (crash, kill -9, container respawn).";
        } else if (result.kind === "unknown") {
          debuggeeNote = `Force-clear of an orphaned debuggee did not confirm success: ${result.detail}`;
        }
        // result.kind === "absent": nothing orphaned at this identity, nothing to report.
      } catch (e) {
        debuggeeNote = `Force-clear of an orphaned debuggee failed: ${describeUnknownError(e)}`;
      }
    }
    // An idle `stop` touches no other system and must stay callable — every
    // test teardown and "did I leave one running?" check goes through it.
    return buildResponse({
      header: { action: "stop", status: leaked.found > 0 ? "dead" : "idle" },
      notes: [
        leaked.found > 0
          ? `Cleared ${leaked.found} leaked debug session(s) (constructed by an earlier start that never ` +
            "completed, with no in-process tracking of its own)."
          : "No active debug session (nothing to stop).",
        ...leaked.notes,
        ...(orphanNote ? [orphanNote] : []),
        ...(debuggeeNote ? [debuggeeNote] : []),
      ],
      maxChars: clampMaxChars(maxChars),
    });
  }
  // D4: terminating a debuggee issues `terminateDebuggee` against the live
  // system. In practice this only refuses if the gate was tightened AFTER
  // `start` — and even then the work process isn't stranded, since
  // `shutdownDebugTools()`/`shutdownAllDebugSessions()` are ungated.
  assertSessionWrite(gate, run);
  const notes: string[] = [];
  // Both waits are bounded (an unreturned trigger used to hang `stop`
  // forever and leave the lane occupied); dropping the session has
  // finally-block semantics regardless of how they resolve.
  try {
    // Read BEFORE calling terminate(): its own internal steps drain the
    // owned-breakpoint/watchpoint arrays as they issue their deletes, so reading
    // this after terminate() had already started could race down to 0 owned.
    // See `terminateDeadlineMs`'s doc comment (src/debug/session.ts) and
    // `STOP_WAIT_MS`'s doc comment here for why this floors rather than
    // replaces the constant.
    const terminateWaitMs = Math.max(STOP_WAIT_MS, run.session.terminateDeadlineMs + 1_000);
    let terminateTimedOut = false;
    const terminated = await raceDeadline(
      run.session.terminate("terminated_by_caller").catch((e: unknown) => {
        notes.push(`Session terminate reported an error: ${describeUnknownError(e)}`);
      }),
      terminateWaitMs,
    );
    if (terminated === TIMED_OUT) {
      terminateTimedOut = true;
      notes.push(
        `Session terminate had not returned after ${terminateWaitMs} ms — it continues in the ` +
          "background; the session was dropped here anyway.",
      );
    }

    const settled = await raceDeadline(run.triggerSettled, STOP_WAIT_MS);
    if (settled === TIMED_OUT) {
      notes.push(
        "Program output is incomplete: the trigger run had not returned when stop gave up waiting.",
      );
    }
    const finalSnapshot = run.session.snapshot;
    // Cleanup timeouts used to be stderr-only, hiding an armed breakpoint
    // left on the server from a clean-looking `stop` response. Only added
    // when non-empty, so an ordinary stop is unchanged.
    const cleanupAbandonedSteps = finalSnapshot.abandonedCleanupSteps?.length;
    if (cleanupAbandonedSteps) {
      notes.push(formatAbandonedCleanupNote(finalSnapshot.abandonedCleanupSteps!));
    }
    // force:true, active-run sibling of the idle path's same-named block above.
    // Only reached when cleanup did NOT come back clean — a terminate() wait
    // that timed out, or a reported abandoned cleanup step (e.g. the exact
    // live defect this whole change fixes: an abandoned breakpoint DELETE left
    // running, later colliding with the next session's attach as HTTP 500
    // "Debuggee already attached"). Never runs on a clean stop, and never runs
    // when force is false — same explicit-only reasoning as the idle path's
    // `releaseOrphanDebuggee` call: this terminates a possibly-still-live
    // debuggee, so it must stay opt-in.
    if ((terminateTimedOut || cleanupAbandonedSteps) && force && deps.releaseOrphanDebuggee) {
      try {
        const result = await raceDeadline(deps.releaseOrphanDebuggee(conn), FORCE_CLEAR_WAIT_MS);
        if (result === TIMED_OUT) {
          notes.push(
            "Force-clear of a possibly-still-attached debuggee was requested, but the check had not " +
              "returned in time — nothing more to report.",
          );
        } else if (result.kind === "released") {
          notes.push(
            "Force-terminated a debuggee still attached at this server's identity after cleanup did " +
              "not confirm it was gone.",
          );
        } else if (result.kind === "unknown") {
          notes.push(`Force-clear of a possibly-still-attached debuggee did not confirm success: ${result.detail}`);
        }
        // result.kind === "absent": cleanup's own deletes/terminate already succeeded server-side
        // despite the local timeout/abandoned-step report — nothing left to force-clear.
      } catch (e) {
        notes.push(`Force-clear of a possibly-still-attached debuggee failed: ${describeUnknownError(e)}`);
      }
    }
    return buildResponse({
      header: { action: "stop", status: finalSnapshot.status, deathReason: finalSnapshot.deathReason },
      sections: [{ title: "PROGRAM OUTPUT", content: renderTriggerOutcome(settled, STOP_WAIT_MS) }],
      notes,
      maxChars: clampMaxChars(maxChars),
    });
  } finally {
    // Unconditional: the run is over either way, so the trigger connection is
    // released and the registry cleared even if composing the response threw.
    run.closeTriggerConn();
    // Runs on every branch above, including a terminate() that threw or
    // timed out — see `dropDebugSessionOnConnection`'s doc comment for the
    // live evidence this fixes. `run.closeSessionConn()`, not a call keyed
    // off `conn` (the argument this call was handed): `run.sessionConn` can
    // be a different object entirely (see `CurrentRun.sessionConn`'s doc
    // comment) — a dedicated connection this session owns outright and
    // discards here, or the fallback shared connection, whose stateful ADT
    // session alone gets dropped.
    await run.closeSessionConn();
    debugLanes[run.lane] = undefined;
  }
}

async function handleStatus(maxChars: number): Promise<BuiltResponse> {
  const run = resolveLaneRun(undefined);
  if (!run) {
    // Same registry `handleStart`'s guard reads — report what's REALLY there
    // instead of a blanket "idle" that would mask a leaked session `start` is
    // refusing on and `stop` can already clear. A caller told "idle" here
    // would have no reason to call `stop`.
    const leaked = listActiveDebugSessions()[0];
    if (!leaked) {
      return buildResponse({
        header: { action: "status", status: "idle", note: "no active debug session" },
        maxChars: clampMaxChars(maxChars),
      });
    }
    const snapshot = leaked.snapshot;
    return buildResponse({
      header: {
        action: "status",
        status: snapshot.status,
        stateId: snapshot.stateId === undefined ? undefined : shortStateId(snapshot.stateId),
        debugSessionId: snapshot.debugSessionId,
        debuggeeId: snapshot.debuggeeId,
        deathReason: snapshot.deathReason,
        deathDetail: snapshot.deathDetail,
      },
      notes: [
        'This session has no in-process trigger/gate bookkeeping (most likely an earlier start ' +
          'that constructed it and then failed before completing) — abap_debug({action:"stop"}) will clear it.',
      ],
      maxChars: clampMaxChars(maxChars),
    });
  }
  const snapshot = run.session.snapshot;
  const notes: string[] = [];
  if (snapshot.status === "dead") {
    notes.push('Session is dead — check PROGRAM OUTPUT via a step/stop response for the captured trigger output.');
  }
  return buildResponse({
    header: {
      action: "status",
      status: snapshot.status,
      stateId: snapshot.stateId === undefined ? undefined : shortStateId(snapshot.stateId),
      debugSessionId: snapshot.debugSessionId,
      debuggeeId: snapshot.debuggeeId,
      deathReason: snapshot.deathReason,
      deathDetail: snapshot.deathDetail,
    },
    notes,
    maxChars: clampMaxChars(maxChars),
  });
}

export async function abapDebug(
  conn: AbapConnection,
  input: DebugInput,
  maxChars: number,
  deps: DebugToolDeps,
  gate: SafetyGate,
): Promise<BuiltResponse> {
  switch (input.action) {
    case "start":
      return handleStart(conn, input, maxChars, deps, gate);
    case "step":
      return handleStep(input, maxChars, gate, deps);
    case "stack":
      return handleStack(input, maxChars);
    case "frame":
      return handleFrame(input, maxChars);
    case "breakpoints":
      return handleBreakpoints(conn, input, maxChars, deps, gate);
    case "watch":
      return handleWatch(input, maxChars, gate);
    case "keepalive":
      return handleKeepalive(maxChars, gate);
    case "stop":
      return handleStop(conn, maxChars, deps, gate, input.force === true);
    case "status":
      return handleStatus(maxChars);
  }
}

// ---------------------------------------------------------------------------
// Tool 2: `abap_debug_vars` — Tier 1 survey.
// ---------------------------------------------------------------------------

export const debugVarsInputSchema = {
  stateId: z
    .string()
    .describe("From the most recent start/step/stack/frame response (12-char token; full id or a prefix of at least 8 chars also accepted)."),
  scope: z
    .enum(["all", "locals", "parameters", "globals"])
    .optional()
    .describe("Default all."),
  filter: z.string().optional().describe("Substring match on name."),
};

export const DebugVarsInput = z.object(debugVarsInputSchema);
export type DebugVarsInput = z.infer<typeof DebugVarsInput>;

const SCOPE_ID_BY_NAME: Record<"locals" | "parameters" | "globals", string> = {
  locals: "@LOCALS",
  parameters: "@PARAMETERS",
  globals: "@GLOBALS",
};

export async function abapDebugVars(input: DebugVarsInput, maxChars: number): Promise<BuiltResponse> {
  const run = resolveLaneRun(input.stateId);
  if (!run) {
    throw new AbapError("BAD_INPUT", "No active debug session.");
  }
  if (!input.stateId) {
    throw new AbapError("BAD_INPUT", 'abap_debug_vars requires "stateId".');
  }
  const wireId = wireStateId(run, input.stateId);
  const root = await run.session.getRootVariables(input.stateId);

  const scopeOf = new Map<string, string>();
  for (const h of root.variables.hierarchies) {
    scopeOf.set(h.childId, h.parentId);
  }

  let filtered: DebugVariable[] = root.variables.variables;
  if (input.scope && input.scope !== "all") {
    const wantScopeId = SCOPE_ID_BY_NAME[input.scope];
    filtered = filtered.filter((v) => scopeOf.get(v.id) === wantScopeId);
  }
  if (input.filter) {
    const needle = input.filter.toLowerCase();
    filtered = filtered.filter((v) => v.name.toLowerCase().includes(needle));
  }

  const survey = renderSurvey(
    filtered.map((variable) => ({ variable })),
    {
      maxChars: DEBUG_MAX_CHARS,
      scopeLabel: input.scope && input.scope !== "all" ? input.scope.toUpperCase() : undefined,
      // D6 — real stateId, not `STATE_ID_PLACEHOLDER`.
      stateId: wireId,
    },
  );

  const varsNotes = survey.degraded.length
    ? [`${survey.degraded.length} value(s) shortened to fit budget — each still names its own retrieval call.`]
    : [];
  return buildResponse({
    header: { stateId: wireId, scope: input.scope ?? "all", count: filtered.length },
    body: survey.text,
    bodyLabel: "VARIABLES",
    notes: varsNotes,
    maxChars: budgetWithNotes(varsNotes, clampMaxChars(maxChars)),
  });
}

// ---------------------------------------------------------------------------
// Tool 3: `abap_debug_value` — Tier 2 drill-in.
// ---------------------------------------------------------------------------

/** Rows returned when the caller does not say. Unchanged — it was always 20. */
export const DEFAULT_TABLE_ROWS = 20;

/**
 * D7 — hard ceiling on the row window `abap_debug_value` will ask for.
 * `count` used to be unbounded (`count: 1e8` exhausts the heap before a byte
 * reaches SAP). 200 is chosen against the response budget: DEBUG_MAX_CHARS
 * (30 000) / ~60 chars per row ≈ 500 rows is the absolute display ceiling, so
 * 200 keeps the renderer, not the fetch, deciding. Enforced twice — zod
 * `.max()` at the MCP boundary, and a runtime clamp for direct callers that
 * DISCLOSES the truncation (never silent — see test/no-silent-truncation.test.ts).
 */
export const MAX_TABLE_ROWS = 200;

/**
 * D19 — `getVariables` can answer a batch of ids with a SUBSET of rows at HTTP
 * 200, with no per-id status; an unresolved id produces NO element (not an
 * empty one), so positional indexing can silently render the wrong variable.
 * `alignRequestedVariables` (xml-response.ts) fixes this by matching on `ID`
 * only (NAME is not unique). This function turns its `{missing, unexpected}`
 * into disclosure notes. Live proof and full writeup:
 * the git history.
 */
const MAX_LISTED_IDS = 25;

/** Join ids for a disclosure note, clipped by MAX_LISTED_IDS so the note itself can't blow the budget. */
function listIds(ids: readonly string[]): string {
  if (ids.length <= MAX_LISTED_IDS) return ids.join(", ");
  const shown = ids.slice(0, MAX_LISTED_IDS);
  return (
    `${shown.join(", ")} … [TRUNCATED: ${shown.length} of ${ids.length} id(s) listed, ` +
    `${ids.length - shown.length} cut]`
  );
}

/**
 * #152 — the start-response note for a caught debuggee that is not a live
 * one. Post-mortem: the run already terminated with a short dump, so the
 * session inspects a final state that cannot be stepped, and an exception
 * breakpoint meant to stop BEFORE the dump did not fire. Unknown kind: the
 * wire said something this server has never seen; it is treated as attached.
 */
function describeCaughtKind(
  caught: {
    kind: string;
    rawKind: string;
    dumpId?: string;
    dumpUri?: string;
  },
  armedExceptionClasses: readonly string[],
): GuidanceNote {
  if (caught.kind === "postmortem" || caught.kind === "postmortem_dialog") {
    const dump = caught.dumpId ? ` dump ${caught.dumpId}` : "";
    // #152 — name the exception breakpoints that were supposed to stop the
    // run before this dump and did not.
    const notFired =
      armedExceptionClasses.length > 0
        ? `The exception breakpoint(s) on ${armedExceptionClasses.join(", ")} did not suspend the run before this dump. `
        : "";
    return {
      key: "postmortem",
      full:
        `POST-MORTEM: the debugger attached to a short dump (DBGEE_KIND ${caught.rawKind}${dump}), not to a ` +
        "running debuggee. The run has ALREADY terminated; stack and variables are its state at the dump, and " +
        `stepping cannot resume it. ${notFired}Read the dump text with abap_dumps` +
        `${caught.dumpId ? `({id:"${caught.dumpId}"})` : ""}.`,
      brief: `Post-mortem session (${caught.rawKind}${dump}) — the run already terminated; stepping cannot resume it.`,
    };
  }
  return {
    key: `kind:${caught.rawKind}`,
    full:
      `The debugger attached to a debuggee of an unrecognised kind (DBGEE_KIND "${caught.rawKind}"). It is ` +
      "treated as attached with kind unknown: stack, variables and stepping are attempted as for a live " +
      "debuggee, and any refusal is reported as it happens.",
    brief: `Debuggee kind "${caught.rawKind}" is unrecognised — treated as attached, kind unknown.`,
  };
}

function describeOmissions(
  requestedIds: readonly string[],
  align: { resolved: DebugVariable[]; missing: string[]; unexpected: DebugVariable[] },
  ctx: { subject: string; stateId: string },
): GuidanceNote[] {
  const notes: GuidanceNote[] = [];
  if (align.missing.length > 0) {
    notes.push({
      key: "omitted",
      full:
        `OMITTED: the debugger returned ${align.resolved.length} of the ${requestedIds.length} variable ` +
        `id(s) requested for ${ctx.subject} — ${listIds(align.missing)} came back with NO row at all ` +
        "and are NOT shown. A requested id with no row is UNRESOLVED at this stop (unknown name, " +
        "out-of-range index, or not visible in this frame); it is NOT an empty value, and " +
        "re-requesting it returns the same nothing. Confirm the id exists here with " +
        `abap_debug_vars({stateId:"${ctx.stateId}"}).`,
      brief:
        `OMITTED: ${listIds(align.missing)} — no row at this stop for ${ctx.subject} (unresolved, not empty; ` +
        `confirm with abap_debug_vars({stateId:"${ctx.stateId}"})).`,
    });
  }
  if (align.unexpected.length > 0) {
    const ids = align.unexpected.map((v) => v.id);
    notes.push({
      key: "unrequested",
      full:
        `UNREQUESTED: the debugger also returned ${align.unexpected.length} row(s) whose id was NOT ` +
        `requested — ${listIds(ids)}. Their values are NOT shown, because a row nobody asked for, ` +
        `rendered under ${ctx.subject}, is a wrong answer wearing the right label — the exact ` +
        "mis-attribution that hid this defect. Read one on purpose with " +
        `abap_debug_value({stateId:"${ctx.stateId}", path:"${ids[0]}"}).`,
      brief:
        `UNREQUESTED: ${listIds(ids)} returned but not requested under ${ctx.subject} — not shown ` +
        `(abap_debug_value({stateId:"${ctx.stateId}", path:"${ids[0]}"}) reads one on purpose).`,
    });
  }
  return notes;
}

export const debugValueInputSchema = {
  stateId: z
    .string()
    .describe("From the most recent start/step/stack/frame response (12-char token; full id or a prefix of at least 8 chars also accepted)."),
  path: z
    .string()
    .describe(
      "Variable path, e.g. LT_ITEMS[42]-MATNR. Field symbols keep their angle brackets, e.g. " +
        "<LS_ITEM>. Unknown paths return empty, not NOT_FOUND.",
    ),
  from: z
    .number()
    .int()
    .min(1)
    .max(999_999)
    .optional()
    .describe("First row — tables only. Default 1."),
  count: z
    .number()
    .int()
    .positive()
    .max(MAX_TABLE_ROWS)
    .optional()
    .describe(`Tables only. Default ${DEFAULT_TABLE_ROWS}, max ${MAX_TABLE_ROWS}. Page with "from".`),
  depth: z
    .number()
    .int()
    .min(1)
    .max(999_999)
    .optional()
    .describe("Max nesting depth. Default 3."),
};

export const DebugValueInput = z.object(debugValueInputSchema);
export type DebugValueInput = z.infer<typeof DebugValueInput>;

export async function abapDebugValue(input: DebugValueInput, maxChars: number): Promise<BuiltResponse> {
  const run = resolveLaneRun(input.stateId);
  if (!run) {
    throw new AbapError("BAD_INPUT", "No active debug session.");
  }
  if (!input.stateId) {
    throw new AbapError("BAD_INPUT", 'abap_debug_value requires "stateId".');
  }
  const wireId = wireStateId(run, input.stateId);

  const validation = validatePath(input.path);
  if (!validation.ok) {
    throw new AbapError(
      "BAD_INPUT",
      `Malformed path at "${validation.segment}": ${validation.message}`,
      { path: input.path, segment: validation.segment },
    );
  }
  const canonicalPath = formatPath(validation.path);
  const clampedMaxChars = clampMaxChars(maxChars);

  let rootVars: DebugVariable[];
  try {
    rootVars = await run.session.getVariables(input.stateId, [canonicalPath]);
  } catch (e) {
    if (e instanceof DebugXmlParseError) {
      return buildResponse({
        header: { stateId: wireId, path: canonicalPath },
        body: renderEmptyBodyTrap({ path: canonicalPath }),
        bodyLabel: "VALUE",
        maxChars: clampedMaxChars,
      });
    }
    throw e;
  }
  // D19: match the response to the request by `ID`, never by position. `rootVars[0]`
  // was a row the server chose, not the row that was asked for.
  const rootAlign = alignRequestedVariables([canonicalPath], rootVars);
  const rootNotes = run.guidance.render(
    describeOmissions([canonicalPath], rootAlign, { subject: canonicalPath, stateId: wireId }),
  );
  const rootVar = rootAlign.resolved[0];
  if (!rootVar) {
    return buildResponse({
      header: { stateId: wireId, path: canonicalPath },
      // The empty-body trap claims "0 bytes", which is only true when the
      // debugger really sent nothing. Rows for OTHER ids is a different fact and
      // gets its own words rather than a convenient lie.
      body:
        rootVars.length > 0
          ? rootNotes.join("\n\n")
          : renderEmptyBodyTrap({ path: canonicalPath }),
      bodyLabel: "VALUE",
      maxChars: clampedMaxChars,
    });
  }

  if (!isComplex(rootVar.metaType)) {
    const node: VariableNode = { variable: rootVar };
    // D6 — hints carry the caller's own stateId, not `<stateId>`.
    const { text } = renderDrill(node, canonicalPath, {
      depth: input.depth,
      maxChars: clampedMaxChars,
      stateId: wireId,
    });
    return buildResponse({
      header: { stateId: wireId, path: canonicalPath },
      body: text,
      bodyLabel: "VALUE",
      notes: rootNotes,
      maxChars: budgetWithNotes(rootNotes, clampedMaxChars),
    });
  }

  if (rootVar.metaType === "table") {
    const total = rootVar.tableLines;
    const from = input.from ?? 1;
    // D7: clamp BEFORE the window arithmetic below, so no oversized array, no
    // oversized request body and no oversized parse ever happens. The
    // disclosure is pushed into `tableNotes` a few lines down — never clamp
    // silently.
    const requestedCount = input.count ?? DEFAULT_TABLE_ROWS;
    const count = Math.min(requestedCount, MAX_TABLE_ROWS);
    const countWasClamped = count < requestedCount;

    // T5a: an out-of-range `from` is REPORTED, never silently clamped to the last
    // row (used to render row 15 for from:999 on a 15-row table with no signal).
    if (total !== undefined && total > 0 && from > total) {
      throw new AbapError(
        "BAD_INPUT",
        `${canonicalPath} has ${total} row(s) — "from" (${from}) is past the end. ` +
          `Ask for a row in 1..${total}.`,
        { path: canonicalPath, from, tableLines: total },
      );
    }

    // T5b: empty table (total===0) and unavailable row count (total===undefined) are distinct — never conflated.
    const tableNotes: string[] = [...rootNotes];
    if (countWasClamped) {
      tableNotes.push(
        `TRUNCATED: count:${requestedCount} exceeds the ${MAX_TABLE_ROWS}-row maximum, so only ` +
          `${count} row(s) were requested from ${canonicalPath} — rows ${from + count} onward were ` +
          "NOT fetched and are NOT shown. Continue with " +
          `abap_debug_value({stateId:"${wireId}", path:"${canonicalPath}", from:${from + count}, count:${MAX_TABLE_ROWS}}).`,
      );
    }
    if (total === 0) {
      tableNotes.push(`${canonicalPath} is empty: 0 rows.`);
    } else if (total === undefined) {
      tableNotes.push(
        `Row count is unavailable — the debugger did not report TABLE_LINES for ${canonicalPath}. ` +
          "This is NOT the same as an empty table. \"from\" could not be range-checked. " +
          `To settle it, probe the first row: abap_debug_value({stateId:"${wireId}", ` +
          `path:"${canonicalPath}[1]"}) — a row comes back only if data is actually present.`,
      );
      if (input.from !== undefined && input.from > 1) {
        tableNotes.push(
          `"from" (${input.from}) could not be range-checked because the row count is unavailable.`,
        );
      }
    }

    const clampedFrom = total !== undefined && total > 0 ? Math.min(Math.max(1, from), total) : total === 0 ? 1 : from;
    const clampedTo = total !== undefined && total > 0 ? Math.min(clampedFrom + count - 1, total) : total === 0 ? 0 : from + count - 1;
    let rowNodes: VariableNode[] = [];
    if (total === undefined || (total > 0 && clampedTo >= clampedFrom)) {
      const ids = Array.from({ length: clampedTo - clampedFrom + 1 }, (_, i) => `${canonicalPath}[${clampedFrom + i}]`);
      let rowCount = 0;
      try {
        const rowVars = await run.session.getVariables(input.stateId, ids);
        rowCount = rowVars.length;
        // D19: same batch-shortfall shape as the root case above — align by `ID` and
        // disclose what didn't come back, or `elide()` would present a REFUSED row
        // as merely "not fetched yet".
        const rowAlign = alignRequestedVariables(ids, rowVars);
        rowNodes = rowAlign.resolved.map((variable) => ({ variable }));
        tableNotes.push(
          ...run.guidance.render(describeOmissions(ids, rowAlign, { subject: canonicalPath, stateId: wireId })),
        );
      } catch (e) {
        // T5c: same 0-byte-body trap as the root `getVariables` call above (SAP
        // answers some reads with an empty body; XML layer surfaces it as
        // DebugXmlParseError) — without this a row read hitting it threw raw.
        if (e instanceof DebugXmlParseError) {
          return buildResponse({
            header: { stateId: wireId, path: canonicalPath },
            body: renderEmptyBodyTrap({ path: canonicalPath, tableLines: total }),
            bodyLabel: "VALUE",
            notes: tableNotes,
            maxChars: budgetWithNotes(tableNotes, clampedMaxChars),
          });
        }
        throw e;
      }
      // Same trap, reached the other way: D12's `parseVariablesResponse` treats a
      // 0-byte body as an empty RESULT, not a parse error (live-captured:
      // 037-vars-out-of-range-row, 026-vars-table-row-past-end), so this no longer
      // throws — but zero rows for a NON-EMPTY requested window is still the
      // "check your indices" trap and must render as such. D19: only when the
      // debugger sent no rows AT ALL — zero MATCHING rows out of a non-empty
      // response is a different fact, already stated by OMITTED/UNREQUESTED above.
      if (ids.length > 0 && rowCount === 0) {
        return buildResponse({
          header: { stateId: wireId, path: canonicalPath },
          body: renderEmptyBodyTrap({ path: canonicalPath, tableLines: total }),
          bodyLabel: "VALUE",
          notes: tableNotes,
          maxChars: budgetWithNotes(tableNotes, clampedMaxChars),
        });
      }
    }
    const node: VariableNode = { variable: rootVar, children: rowNodes };
    const { text } = renderDrill(node, canonicalPath, {
      rows: { start: clampedFrom, end: clampedTo || clampedFrom },
      maxChars: clampedMaxChars,
      stateId: wireId,
    });
    return buildResponse({
      header: { stateId: wireId, path: canonicalPath },
      body: text,
      bodyLabel: "VALUE",
      notes: tableNotes,
      maxChars: budgetWithNotes(tableNotes, clampedMaxChars),
    });
  }

  // structure / object / dataref / etc — one level of children, one getChildVariables call.
  let childResult: Awaited<ReturnType<DebugSession["getChildVariables"]>>;
  try {
    childResult = await run.session.getChildVariables(input.stateId, [canonicalPath]);
  } catch (e) {
    if (e instanceof DebugXmlParseError) {
      childResult = { hierarchies: [], variables: [] };
    } else {
      throw e;
    }
  }
  const node = withChildren(rootVar, childResult);
  const { text } = renderDrill(node, canonicalPath, {
    depth: input.depth,
    maxChars: clampedMaxChars,
    stateId: wireId,
  });
  return buildResponse({
    header: { stateId: wireId, path: canonicalPath },
    body: text,
    bodyLabel: "VALUE",
    // The `getChildVariables` hop below returns CHILDREN of `canonicalPath`, whose
    // ids are by definition not the id that was requested, so it has no requested-id
    // alignment to do. `rootNotes` still travels: it describes the root read.
    notes: rootNotes,
    maxChars: budgetWithNotes(rootNotes, clampedMaxChars),
  });
}
