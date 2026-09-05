/**
 * `abap_debug` / `abap_debug_vars` / `abap_debug_value` — MCP tool surface for
 * the ABAP debugger (M7b).
 *
 * Pure orchestration: never talks to `DebugClient` or raw HTTP directly.
 * State lives in `DebugSession` (`src/debug/session.ts`); variable rendering
 * lives in `src/debug/render.ts`. This file:
 *   - owns the one module-level "current debug session" registry (one
 *     session per process),
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
  type DebugSessionOptions,
  type DebugTerminationResult,
} from "../debug/session.js";
import { resolveDebugIdentity, warnIfDerivedIdentity } from "../debug/identity.js";
import { createDebugArmLock } from "../debug/arm-lock.js";
import { resolveStateDir } from "../state-dir.js";
import type { DebugSessionLease } from "../debug/transport.js";
import { withStartFragment } from "../debug/endpoints.js";
import type { PoolSlot, SessionPool } from "../adt/pool.js";
import {
  DEBUG_MAX_CHARS,
  formatPath,
  isComplex,
  renderDrill,
  renderEmptyBodyTrap,
  renderStackSection,
  renderSurvey,
  validatePath,
  withChildren,
  type VariableNode,
} from "../debug/render.js";
import { alignRequestedVariables, DebugXmlParseError } from "../debug/xml-response.js";
import { readBadiImplementation, readEnhancementSpot, readSourceCodePlugin } from "../adt/enhancement.js";
import type {
  Breakpoint,
  DebugStack,
  DebugStepKind,
  DebugVariable,
  StateId,
} from "../debug/types.js";
import { abapRun, type RunInput } from "./run.js";

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
    },
  ): DebugSession;
  /** Produce a second, independent, already-CONNECTED AbapConnection for firing the trigger. */
  createTriggerConnection(): Promise<AbapConnection>;
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
   * deterministic (terminalId, ideId) identity with no `currentRun` in this
   * process to route a `stop` through — e.g. an earlier process instance
   * armed it and exited uncleanly.
   */
  releaseOrphanListener?(conn: AbapConnection): Promise<OrphanListenerResult>;
  /**
   * Force-clear a debuggee ATTACHED (suspended) at THIS server's own
   * identity with no `currentRun` to route a `stop` through — the
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
  // ONE instance for this process, shared by `createSession` and the
  // `releaseOrphanDebuggee` probe — both arm a listener at the same identity
  // and must be counted by the same lock. Built over `resolveStateDir`, like
  // `AdtSessionPool`'s `FileLockObjectGate`. `enabled`/`waitMs` come from the
  // parsed `Config` rather than re-derived from `process.env`.
  const armLock = createDebugArmLock({
    stateDir: resolveStateDir(process.env),
    cfg: params.cfg,
    enabled: params.cfg.crossProcessDebugLock,
    waitMs: params.cfg.debugLockWaitMs,
  });
  return {
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
      const identity = resolveDebugIdentity(params.cfg);
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
        armLock,
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
      // Same deterministic identity `createSession` derives — can only find a
      // listener THIS server's own identity would have armed.
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
        armLock,
      });
      try {
        await probe.armListener();
        const caught = await probe.waitForDebuggee();
        if (caught.kind !== "debuggee") {
          // timeout/blocked/conflict: nothing reconnected in the short
          // window; `waitForDebuggee()` already released the listener.
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
// Module-level session registry — one debug session per process.
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
  /** Never rejects — already normalized via .then(ok, err) attached synchronously at creation time. */
  triggerSettled: Promise<DebugTriggerOutcome>;
  /**
   * Release `triggerConn`. Idempotent, synchronous, and NEVER throws or
   * rejects — every teardown path may call it blindly without ordering itself
   * against the trigger's settle handler.
   */
  closeTriggerConn: () => void;
}

let currentRun: CurrentRun | undefined;

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
 */
export function shutdownDebugTools(): void {
  const run = currentRun;
  currentRun = undefined;
  run?.closeTriggerConn();
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

/** How long a failed `start` waits for `session.cleanup()` before it continues in the background (memoised). */
const START_FAILURE_CLEANUP_WAIT_MS = 5_000;

/** How long `stop` waits for `session.terminate()` and the trigger run before dropping the session anyway. */
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

export const debugInputSchema = {
  action: z
    .enum(["start", "step", "stack", "frame", "keepalive", "stop", "status"])
    .describe(
      "start needs breakpoints+run. step needs stateId+step. stack needs stateId. frame " +
        "needs stateId+frame. keepalive/stop/status need nothing.",
    ),
  breakpoints: z
    .array(z.discriminatedUnion("kind", [lineBreakpointSchema, exceptionBreakpointSchema]))
    .optional()
    .describe(
      "≥1 entry, required for action=\"start\"; kinds may mix and are validated against SAP " +
        "before arming. Both kinds take optional condition (ABAP expression, suspend only " +
        'when true) and skipCount (sent to SAP, NOT enforced — use step:"continue").',
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
      "From the most recent start/step/stack/frame response; a stale id is refused.",
    ),
  frame: z
    .number()
    .int()
    .min(1)
    .describe(
      "1-based stackPosition from the last STACK section. Read-only.",
    )
    .optional(),
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
): Promise<BuiltResponse> {
  const root = await run.session.getRootVariables(stateId);
  const entries = root.variables.variables.map((variable) => ({ variable }));
  // D6: without `stateId`, the renderer's retrieval-call hints fill the slot
  // with the literal placeholder `<stateId>` — an agent would copy that verbatim.
  const survey = renderSurvey(entries, { maxChars: DEBUG_MAX_CHARS, stateId });

  const stackText = renderStackSection(stack, stateId);
  const visibleFrames = stack.frames.filter((f) => !f.systemProgram);
  const top = visibleFrames[0] ?? stack.frames[0];

  return buildResponse({
    header: {
      action,
      status: run.session.snapshot.status,
      program: top?.programName,
      include: top?.includeName,
      line: top?.line,
      stateId,
    },
    sections: [{ title: "STACK", content: stackText }],
    body: survey.text,
    bodyLabel: "VARIABLES",
    notes: [
      ...extraNotes,
      ...(survey.degraded.length
        ? [`${survey.degraded.length} value(s) shortened to fit budget — each still names its own retrieval call.`]
        : []),
    ],
    maxChars: clampMaxChars(maxChars),
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

/** Compose the response for a session that has died (debuggee finished, whether via signal A or signal B). Always a SUCCESSFUL response — the debuggee finishing is a normal outcome, not a tool failure. */
async function composeDeathOutput(
  run: CurrentRun,
  action: string,
  maxChars: number,
  cause?: unknown,
): Promise<BuiltResponse> {
  // Bounded like `stop`: the session is already dead and `currentRun` is
  // cleared right after this, so a trigger that never returns must not wedge
  // the death response.
  const settled = await raceDeadline(run.triggerSettled, STOP_WAIT_MS);
  const outputSection = {
    title: "PROGRAM OUTPUT",
    content: renderTriggerOutcome(settled, STOP_WAIT_MS),
  };
  // Last chance to release the trigger connection before `currentRun` is dropped.
  run.closeTriggerConn();
  const snapshot = run.session.snapshot;
  // `deathDetail` and `terminationResult.detail` are always the SAME string
  // (both set from `doTerminate()`'s one `detail` param) — suppress the same
  // generic-fallback content here that `renderTerminationEvidence` withholds,
  // or it prints twice.
  const showDeathDetail = !isGenericFallbackEvidence(snapshot.terminationResult);
  const notes = [
    showDeathDetail ? snapshot.deathDetail : undefined,
    snapshot.deathDetail === undefined && cause instanceof Error ? cause.message : undefined,
    ...renderTerminationEvidence(snapshot.terminationResult),
  ].filter((n): n is string => Boolean(n));
  if (settled === TIMED_OUT) {
    notes.push("Program output is incomplete: the trigger run had not returned when the wait expired.");
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
  // Reads `listActiveDebugSessions()` — the same registry `handleStop`/
  // `handleStatus` consult (see `clearLeakedSessions`) — never `currentRun`
  // alone. `currentRun` only exists after a FULL success; a `start` that
  // constructs a `DebugSession` and then fails leaves it registered here with
  // no matching `currentRun` ("leaked"). Distinguishing the two in the
  // message matters: a leaked session's cleanup already ran once, so a plain
  // `stop` is more likely to need a retry or `force:true`.
  const live = listActiveDebugSessions();
  if (live.length > 0) {
    const status = live[0]!.snapshot.status;
    const tracked = currentRun !== undefined && live.includes(currentRun.session);
    throw new AbapError(
      "UNSUPPORTED",
      tracked
        ? `A debug session is already "${status}" (one session per process) — ` +
          "stop it first: abap_debug({action:\"stop\"})."
        : `A debug session from an earlier, unsuccessful start attempt is still registered ` +
          `(status "${status}") even though it never became this process's active session ` +
          "(one session per process) — clear it first: abap_debug({action:\"stop\"}); if that " +
          "reports the cleanup is still running, retry, or use " +
          "abap_debug({action:\"stop\", force:true}) to force it out of tracking.",
      { status, tracked },
      undefined,
      { retryable: true }, // transient occupancy, not an unimplemented capability — a stop clears it
    );
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
  // nothing armed. Build on the LEASED slot's connection, never the caller's:
  // the long poll reads its cookies/CSRF from that connection. Coincide at
  // the shipped maxSessions:1; not above it.
  const slot = await deps.reserveDebugSession?.("debugger/listeners");
  let session: DebugSession;
  try {
    session = deps.createSession(slot?.conn ?? conn, gate, {
      target: sessionTarget,
      sessionLease: slot,
    });
  } catch (e) {
    // The session never existed, so nothing else will ever release this.
    slot?.release();
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
  // Declared OUTSIDE the try so the catch can release the trigger connection
  // even though it's created inside it. Starts as a no-op.
  let closeTriggerConn: () => void = () => {};
  try {
    const resolvedCache = new Map<string, ResolvedObject>();
    const breakpoints: Breakpoint[] = [];
    for (const bp of input.breakpoints) {
      if (bp.skipCount !== undefined && bp.skipCount > 0) {
        const where = bp.kind === "line" ? `${bp.object}:${bp.line}` : bp.exceptionClass;
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
      } else {
        // An exception breakpoint names a class to WATCH, not modify — gating
        // it against the exception class's own name would deny every standard
        // CX_* for no safety gain, so the session-level (run target) check covers it.
        breakpoints.push({
          kind: "exception",
          exceptionClass: bp.exceptionClass,
          ...(bp.condition !== undefined ? { condition: bp.condition } : {}),
          ...(bp.skipCount !== undefined ? { skipCount: bp.skipCount } : {}),
        });
      }
    }

    await session.prepareBreakpoints(breakpoints);
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
    await raceDeadline(
      session.cleanup().catch(() => undefined),
      START_FAILURE_CLEANUP_WAIT_MS,
    );

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
  currentRun = {
    session,
    triggerConn: triggerConn!,
    triggerSettled: triggerSettled!,
    closeTriggerConn,
    gateTarget,
    lastStack: attachedStack,
  };
  return await composeStopOutput(currentRun, "start", attachedStack, attachedStateId, maxChars, skipCountWarnings);
}

async function handleStep(
  input: DebugInput,
  maxChars: number,
  gate: SafetyGate,
  deps: DebugToolDeps,
): Promise<BuiltResponse> {
  if (!currentRun) {
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
  const run = currentRun;
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
      currentRun = undefined;
      return out;
    }
    throw e;
  }
  if (run.session.snapshot.status === "dead") {
    const out = await composeDeathOutput(run, "step", maxChars);
    currentRun = undefined;
    return out;
  }
  run.lastStack = result.stack;
  // Advisory (see session.ts's `visitedPositions`): this exact (program,
  // stack level, line) has been reported before this session. The ONE fact
  // provable about a revisit — NOT a loop-iteration count.
  const revisitNotes =
    result.positionVisitCount > 1
      ? [
          `Position revisited: this exact program/line/stack-level has now been reached ` +
            `${result.positionVisitCount} times by stepping in this session. If you are stepping ` +
            `through a loop body, "step over"/"step into" can under-report how many iterations ` +
            `actually ran between visits — this only proves you returned to this line, not how ` +
            `many times the loop body executed in between. For a reliable per-iteration count, set ` +
            `a breakpoint at the loop body's start (abap_debug action:"start" or a line breakpoint) ` +
            `and use step:"continue" repeatedly instead of stepping through — each hit is a real, ` +
            `separately counted stop.`,
        ]
      : [];
  return composeStopOutput(run, "step", result.stack, result.stateId, maxChars, revisitNotes);
}

async function handleStack(input: DebugInput, maxChars: number): Promise<BuiltResponse> {
  if (!currentRun) {
    throw new AbapError(
      "BAD_INPUT",
      'No active debug session. Start one with abap_debug({action:"start", ...}).',
    );
  }
  if (!input.stateId) {
    throw new AbapError("BAD_INPUT", 'abap_debug({action:"stack"}) requires "stateId".');
  }
  const stack = await currentRun.session.getStack(input.stateId);
  currentRun.lastStack = stack;
  const stackText = renderStackSection(stack, input.stateId);
  const visibleFrames = stack.frames.filter((f) => !f.systemProgram);
  const top = visibleFrames[0] ?? stack.frames[0];
  return buildResponse({
    header: {
      action: "stack",
      status: currentRun.session.snapshot.status,
      program: top?.programName,
      include: top?.includeName,
      line: top?.line,
      stateId: input.stateId,
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
  if (!currentRun) {
    throw new AbapError(
      "BAD_INPUT",
      'No active debug session. Start one with abap_debug({action:"start", ...}).',
    );
  }
  if (!input.stateId) {
    throw new AbapError("BAD_INPUT", 'abap_debug({action:"frame"}) requires "stateId".');
  }
  if (input.frame === undefined) {
    throw new AbapError(
      "BAD_INPUT",
      'abap_debug({action:"frame"}) requires "frame" — the 1-based stackPosition of the frame ' +
        "to move the read cursor to.",
    );
  }
  const run = currentRun;
  // Hoisted so the STACK section can render from a narrowed local — the
  // compiler can't follow "target implies lastStack" through the optional
  // chain plus `find`.
  const lastStack = run.lastStack;
  const target = lastStack?.frames.find((f) => f.stackPosition === input.frame);
  if (!lastStack || !target) {
    throw new AbapError(
      "BAD_INPUT",
      `abap_debug({action:"frame", frame:${input.frame}}) does not match any frame in the most ` +
        `recently known stack. Call abap_debug({action:"stack", stateId:"${input.stateId}"}) ` +
        "first to see the current stackPosition values.",
      { frame: input.frame },
    );
  }
  await run.session.setStackPosition(input.stateId, { stackPosition: input.frame, stackType: "ABAP" });
  const root = await run.session.getRootVariables(input.stateId);
  const entries = root.variables.variables.map((variable) => ({ variable }));
  const survey = renderSurvey(entries, { maxChars: DEBUG_MAX_CHARS, stateId: input.stateId });
  const stackText = renderStackSection(lastStack, input.stateId);
  return buildResponse({
    header: {
      action: "frame",
      status: run.session.snapshot.status,
      program: target.programName,
      include: target.includeName,
      line: target.line,
      frame: target.stackPosition,
      stateId: input.stateId,
    },
    sections: [{ title: "STACK", content: stackText }],
    body: survey.text,
    bodyLabel: "VARIABLES",
    notes: [
      `Read cursor switched to frame #${target.stackPosition} — this does not change what runs ` +
        "next. The next step resumes from the live top frame regardless (live-verified).",
      ...(survey.degraded.length
        ? [`${survey.degraded.length} value(s) shortened to fit budget — each still names its own retrieval call.`]
        : []),
    ],
    maxChars: clampMaxChars(maxChars),
  });
}

async function handleKeepalive(
  maxChars: number,
  gate: SafetyGate,
): Promise<BuiltResponse> {
  if (!currentRun) {
    throw new AbapError(
      "BAD_INPUT",
      'No active debug session. Start one with abap_debug({action:"start", ...}).',
    );
  }
  // D4: keepalive keeps a dialog work process pinned on the live system —
  // a write, and formerly the one execution-affecting action with no check.
  assertSessionWrite(gate, currentRun);
  currentRun.session.keepalive();
  const snapshot = currentRun.session.snapshot;
  return buildResponse({
    header: {
      action: "keepalive",
      status: snapshot.status,
      stateId: snapshot.stateId,
      debugSessionId: snapshot.debugSessionId,
    },
    maxChars: clampMaxChars(maxChars),
  });
}

/** Result of a `clearLeakedSessions` pass: `found` = sessions `listActiveDebugSessions()` showed that `currentRun` did not track; `notes` describes what happened to each. */
interface LeakedSessionClearResult {
  found: number;
  notes: string[];
}

/**
 * Single source of truth for "is there a debug session this process is still
 * responsible for": `listActiveDebugSessions()` — the same registry
 * `handleStart`'s guard reads. `currentRun` is NOT an independent answer —
 * it's auxiliary bookkeeping that only exists after full success. A `start`
 * that constructs a session and then fails leaves it in `activeSessions`
 * with no `currentRun`, which used to make `stop`/`status` blind to it
 * (both dispatched on `currentRun` alone) — a process-lifetime deadlock,
 * since the guard refused every subsequent `start` forever with nothing able
 * to clear it.
 *
 * This closes that gap: drives EVERY session the registry shows towards
 * `terminate()`, bounded like the `currentRun`-tracked path. Loops
 * defensively even though at most one such session is expected.
 *
 * `force` additionally force-drops (`forceDropDebugSession`) any session
 * whose bounded `terminate()` wait didn't return — last-resort for
 * `terminate()` never reaching `doTerminate`'s `finally`. Without `force`,
 * left tracked, same "continues in the background" contract as elsewhere.
 */
async function clearLeakedSessions(force: boolean): Promise<LeakedSessionClearResult> {
  const leaked = listActiveDebugSessions().filter((s) => s !== currentRun?.session);
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
  if (!currentRun) {
    // `currentRun` unset does NOT mean `listActiveDebugSessions()` is empty —
    // a `start` that constructed a session and then failed leaves it
    // registered with no `currentRun`. Reach for it unconditionally, before
    // the orphan checks below (those cover a DIFFERENT gap: a listener/
    // debuggee left by an EARLIER PROCESS INSTANCE, with no live session
    // object at all). See `clearLeakedSessions`.
    const leaked = await clearLeakedSessions(force);
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
  const run = currentRun;
  // D4: terminating a debuggee issues `terminateDebuggee` against the live
  // system. In practice this only refuses if the gate was tightened AFTER
  // `start` — and even then the work process isn't stranded, since
  // `shutdownDebugTools()`/`shutdownAllDebugSessions()` are ungated.
  assertSessionWrite(gate, run);
  const notes: string[] = [];
  // Both waits are bounded (an unreturned trigger used to hang `stop`
  // forever and leave `currentRun` set); dropping the session has
  // finally-block semantics regardless of how they resolve.
  try {
    const terminated = await raceDeadline(
      run.session.terminate("terminated_by_caller").catch((e: unknown) => {
        notes.push(`Session terminate reported an error: ${describeUnknownError(e)}`);
      }),
      STOP_WAIT_MS,
    );
    if (terminated === TIMED_OUT) {
      notes.push(
        `Session terminate had not returned after ${STOP_WAIT_MS} ms — it continues in the ` +
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
    if (finalSnapshot.abandonedCleanupSteps?.length) {
      notes.push(formatAbandonedCleanupNote(finalSnapshot.abandonedCleanupSteps));
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
    currentRun = undefined;
  }
}

async function handleStatus(maxChars: number): Promise<BuiltResponse> {
  if (!currentRun) {
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
        stateId: snapshot.stateId,
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
  const snapshot = currentRun.session.snapshot;
  const notes: string[] = [];
  if (snapshot.status === "dead") {
    notes.push('Session is dead — check PROGRAM OUTPUT via a step/stop response for the captured trigger output.');
  }
  return buildResponse({
    header: {
      action: "status",
      status: snapshot.status,
      stateId: snapshot.stateId,
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
    .describe("From the most recent start/step/stack/frame response."),
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
  if (!currentRun) {
    throw new AbapError("BAD_INPUT", "No active debug session.");
  }
  if (!input.stateId) {
    throw new AbapError("BAD_INPUT", 'abap_debug_vars requires "stateId".');
  }
  const root = await currentRun.session.getRootVariables(input.stateId);

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
      stateId: input.stateId,
    },
  );

  return buildResponse({
    header: { stateId: input.stateId, scope: input.scope ?? "all", count: filtered.length },
    body: survey.text,
    bodyLabel: "VARIABLES",
    notes: survey.degraded.length
      ? [`${survey.degraded.length} value(s) shortened to fit budget — each still names its own retrieval call.`]
      : [],
    maxChars: clampMaxChars(maxChars),
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

function describeOmissions(
  requestedIds: readonly string[],
  align: { resolved: DebugVariable[]; missing: string[]; unexpected: DebugVariable[] },
  ctx: { subject: string; stateId: string },
): string[] {
  const notes: string[] = [];
  if (align.missing.length > 0) {
    notes.push(
      `OMITTED: the debugger returned ${align.resolved.length} of the ${requestedIds.length} variable ` +
        `id(s) requested for ${ctx.subject} — ${listIds(align.missing)} came back with NO row at all ` +
        "and are NOT shown. A requested id with no row is UNRESOLVED at this stop (unknown name, " +
        "out-of-range index, or not visible in this frame); it is NOT an empty value, and " +
        "re-requesting it returns the same nothing. Confirm the id exists here with " +
        `abap_debug_vars({stateId:"${ctx.stateId}"}).`,
    );
  }
  if (align.unexpected.length > 0) {
    const ids = align.unexpected.map((v) => v.id);
    notes.push(
      `UNREQUESTED: the debugger also returned ${align.unexpected.length} row(s) whose id was NOT ` +
        `requested — ${listIds(ids)}. Their values are NOT shown, because a row nobody asked for, ` +
        `rendered under ${ctx.subject}, is a wrong answer wearing the right label — the exact ` +
        "mis-attribution that hid this defect. Read one on purpose with " +
        `abap_debug_value({stateId:"${ctx.stateId}", path:"${ids[0]}"}).`,
    );
  }
  return notes;
}

export const debugValueInputSchema = {
  stateId: z
    .string()
    .describe("From the most recent start/step/stack/frame response."),
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
  if (!currentRun) {
    throw new AbapError("BAD_INPUT", "No active debug session.");
  }
  if (!input.stateId) {
    throw new AbapError("BAD_INPUT", 'abap_debug_value requires "stateId".');
  }
  const run = currentRun;

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
        header: { stateId: input.stateId, path: canonicalPath },
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
  const rootNotes = describeOmissions([canonicalPath], rootAlign, {
    subject: canonicalPath,
    stateId: input.stateId,
  });
  const rootVar = rootAlign.resolved[0];
  if (!rootVar) {
    return buildResponse({
      header: { stateId: input.stateId, path: canonicalPath },
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
      stateId: input.stateId,
    });
    return buildResponse({
      header: { stateId: input.stateId, path: canonicalPath },
      body: text,
      bodyLabel: "VALUE",
      notes: rootNotes,
      maxChars: clampedMaxChars,
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
          `abap_debug_value({stateId:"${input.stateId}", path:"${canonicalPath}", from:${from + count}, count:${MAX_TABLE_ROWS}}).`,
      );
    }
    if (total === 0) {
      tableNotes.push(`${canonicalPath} is empty: 0 rows.`);
    } else if (total === undefined) {
      tableNotes.push(
        `Row count is unavailable — the debugger did not report TABLE_LINES for ${canonicalPath}. ` +
          "This is NOT the same as an empty table. \"from\" could not be range-checked. " +
          `To settle it, probe the first row: abap_debug_value({stateId:"${input.stateId}", ` +
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
          ...describeOmissions(ids, rowAlign, { subject: canonicalPath, stateId: input.stateId }),
        );
      } catch (e) {
        // T5c: same 0-byte-body trap as the root `getVariables` call above (SAP
        // answers some reads with an empty body; XML layer surfaces it as
        // DebugXmlParseError) — without this a row read hitting it threw raw.
        if (e instanceof DebugXmlParseError) {
          return buildResponse({
            header: { stateId: input.stateId, path: canonicalPath },
            body: renderEmptyBodyTrap({ path: canonicalPath, tableLines: total }),
            bodyLabel: "VALUE",
            notes: tableNotes,
            maxChars: clampedMaxChars,
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
          header: { stateId: input.stateId, path: canonicalPath },
          body: renderEmptyBodyTrap({ path: canonicalPath, tableLines: total }),
          bodyLabel: "VALUE",
          notes: tableNotes,
          maxChars: clampedMaxChars,
        });
      }
    }
    const node: VariableNode = { variable: rootVar, children: rowNodes };
    const { text } = renderDrill(node, canonicalPath, {
      rows: { start: clampedFrom, end: clampedTo || clampedFrom },
      maxChars: clampedMaxChars,
      stateId: input.stateId,
    });
    return buildResponse({
      header: { stateId: input.stateId, path: canonicalPath },
      body: text,
      bodyLabel: "VALUE",
      notes: tableNotes,
      maxChars: clampedMaxChars,
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
    stateId: input.stateId,
  });
  return buildResponse({
    header: { stateId: input.stateId, path: canonicalPath },
    body: text,
    bodyLabel: "VALUE",
    // The `getChildVariables` hop below returns CHILDREN of `canonicalPath`, whose
    // ids are by definition not the id that was requested, so it has no requested-id
    // alignment to do. `rootNotes` still travels: it describes the root read.
    notes: rootNotes,
    maxChars: clampedMaxChars,
  });
}
