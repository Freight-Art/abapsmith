/**
 * Debugger session lifecycle: arming a listener and confirming it actually
 * registered, catching a debuggee and attaching to it, tracking which stop a
 * `StateId` belongs to, detecting the debuggee finished on its own, and the
 * safety net between a forgotten suspended debuggee and a hung SAP work
 * process. `client.ts` stays one method per operation, no state/retries; all
 * of that lifecycle logic lives here instead.
 *
 * Shaped by three prior-implementation bugs: a mythical "30s attach deadline",
 * a listener-arm race from a bare `sleep(100ms)` (fixed here by not
 * returning from `armListener()` until registration is positively
 * confirmed), and a listener leak on the outer-timeout path (fixed by every
 * failure path running both a local `abortListener()` and the `stopListener()`
 * DELETE).
 *
 * Idle timeout exists because nothing server-side reaps a forgotten suspended
 * debuggee — a live probe measured at least 786s survival with zero
 * self-timeout — hence the 300s wall-clock cap enforced here, plus the
 * module-level shutdown registry at the bottom of this file.
 *
 * `DebugSession` is fully offline-testable: it only calls methods on its
 * injected `DebugClient`, never touching `AbapConnection`/`fetch`/`node:http`
 * directly. `createDebugClientForConnection` is the one real-connection
 * wiring helper, used by live callers only.
 */
import { createHash } from "node:crypto";
import { AbapError, describeUnknownError, isAbapError } from "../adt/errors.js";
import { buildInsecureHttpsAgent } from "../adt/http-guard.js";
import type { AbapConnection } from "../adt/connection.js";
import type { DebugArmLock } from "./arm-lock.js";
import { DebugClient, type RootVariablesResult, type SetStackPositionParams } from "./client.js";
import {
  ACQUIRE_NO_SESSION_LEASE,
  assertServerHoldSafe,
  DebugLongPollClient,
  type DebugSessionLease,
  DebugTransport,
  mergeCookieHeader,
} from "./transport.js";
import type { SafetyGate, SafetyTarget } from "../safety.js";
import type {
  Breakpoint,
  BreakpointError,
  BreakpointsRequest,
  ChildVariablesResult,
  CreatedBreakpoint,
  DebugAttachResult,
  DebugContext,
  DebugSettings,
  DebugStack,
  DebugStepKind,
  DebugStepResult,
  DebugVariable,
  ListenResult,
  StateId,
} from "./types.js";

// ---------------------------------------------------------------------------
// StateId — pure, unit-testable in isolation (an "opaque key scoping
// variable IDs to exactly one stop" — see `types.ts`'s `StateId` doc comment).
// ---------------------------------------------------------------------------

/**
 * `sha256(debugSessionId, stackPosition, program, line, stepCounter)`, NUL-joined
 * so adjacent fields can't collide by concatenation. Recomputed from `frames[0]`
 * on `attach()` (`stepCounter` 0) and after every `step()` (incremented).
 */
export function computeStateId(input: {
  debugSessionId: string;
  stackPosition: number;
  program: string;
  line: number;
  stepCounter: number;
}): StateId {
  return createHash("sha256")
    .update(
      `${input.debugSessionId}\u0000${input.stackPosition}\u0000${input.program}\u0000${input.line}\u0000${input.stepCounter}`,
      "utf8",
    )
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Public status / snapshot / options shapes.
// ---------------------------------------------------------------------------

export type DebugSessionStatus = "idle" | "listening" | "caught" | "suspended" | "dead";

export type DebugDeathReason =
  | "terminated_by_caller"
  | "idle_timeout"
  | "debuggee_finished"
  | "conflict"
  | "no_debuggee";

/**
 * Structured termination evidence, replacing a coarse `deathReason` enum plus a
 * free-text `deathDetail` (see the git history for why:
 * that shape let unrelated outcomes look alike). ONE variant per response, chosen
 * only from evidence actually in hand:
 *
 *   - `"finished"` — Signal B only (isSteppingPossible/isTerminationPossible both
 *     false, nothing thrown); not observed in three live trials so far (archive).
 *   - `"exception"` — Signal A with `exceptionClassNames` captured, reported VERBATIM
 *     (no attempt to guess real-ABAP-exception vs. debug-protocol-gone from the name).
 *   - `"session_ended"` — Signal A with no `exceptionClassNames`: the undocumented
 *     "fourth shape" (see xml-response.ts's `isSessionExpired`).
 *   - `"idle_timeout"` — `thresholdMs` is always the configured `idleTimeoutMs`, never
 *     parsed from error-message text.
 *   - `"terminated_by_caller"` — explicit terminate()/stop call.
 */
export type DebugTerminationResult =
  | { kind: "finished"; detail?: string }
  | { kind: "exception"; exceptionClassNames: readonly string[]; bodyExcerpt?: string; detail?: string }
  | { kind: "session_ended"; bodyExcerpt?: string; detail?: string }
  | { kind: "idle_timeout"; thresholdMs: number; detail?: string }
  | { kind: "terminated_by_caller"; detail?: string };

/** Evidence about the triggering error, extracted outside `buildTerminationResult` (kept pure) — always from `AbapError.details`, never from `.message` text. */
export interface DebugTerminationEvidence {
  exceptionClassNames?: readonly string[];
  bodyExcerpt?: string;
}

/** Reads `DebugTerminationEvidence` off an `AbapError`, or `undefined` for anything else (including Signal B, which has no thrown error at all). */
function terminationEvidenceFrom(e: unknown): DebugTerminationEvidence | undefined {
  if (!isAbapError(e)) return undefined;
  const d = e.details;
  const exceptionClassNames = Array.isArray(d.exceptionClassNames)
    ? (d.exceptionClassNames.filter((n): n is string => typeof n === "string") as readonly string[])
    : undefined;
  const bodyExcerpt = typeof d.bodyExcerpt === "string" ? d.bodyExcerpt : undefined;
  return { exceptionClassNames, bodyExcerpt };
}

export interface DebugSessionSnapshot {
  status: DebugSessionStatus;
  stateId?: StateId;
  debugSessionId?: string;
  debuggeeId?: string;
  deathReason?: DebugDeathReason;
  deathDetail?: string;
  /** Structured counterpart to `deathReason`/`deathDetail`. Undefined exactly when `deathReason` is. */
  terminationResult?: DebugTerminationResult;
  /**
   * Set when this session issued another stateful request on the SAME ADT session
   * while a listener long-poll was outstanding and that poll then came back empty —
   * the listener itself is never killed by this, but the other request is
   * head-of-line blocked behind it (see `ListenWaitResult`'s `"blocked"`). Holds the
   * colliding operation's name until `acknowledgeSessionBlock()` clears it. NOT a
   * death reason.
   */
  sessionBlockedBy?: string;
  /** Op names `terminateStep()` gave up on after `TERMINATE_STEP_DEADLINE_MS` — set only when non-empty. See `handleStop` in `src/tools/debug.ts`, which surfaces this in the tool response. */
  abandonedCleanupSteps?: string[];
}

/**
 * What `waitForDebuggee()` resolves to. Deliberately NOT `ListenResult`: an empty
 * long-poll body always means the server hold genuinely expired (live capture
 * disproved the old belief that a same-session request could end it early — see
 * `armListener()`'s doc comment). `"blocked"` flags that this session ALSO issued
 * another stateful request on the same ADT session while the poll was outstanding
 * (a caller bug, head-of-line-blocked, but not the cause of this timeout); `"timeout"`
 * is the normal, retryable outcome.
 */
export type ListenWaitResult =
  | Extract<ListenResult, { kind: "debuggee" | "conflict" }>
  | { kind: "timeout" }
  | { kind: "blocked"; detail: string };

export interface DebugSessionOptions {
  client: DebugClient;
  /** `{debuggingMode, terminalId, ideId, requestUser?}` — held for the whole session's life, never recomputed (types.ts's `IDE_ID_CONSISTENCY_NOTE`). */
  context: DebugContext;
  /**
   * Pool lease held for this session's entire life and released exactly once, in
   * `doTerminate`'s `finally`. Strictly dominates `DebugLongPollAuth.acquireSession`
   * (kept unset, see `createDebugClientForConnection`). Optional for backward compat.
   */
  sessionLease?: DebugSessionLease;
  /**
   * Cross-PROCESS exclusion on this system/client/user's single debugger slot, taken
   * inside `armListener()` and released on every path that stops listening (see
   * `src/debug/arm-lock.ts`). Counterpart to {@link sessionLease} one layer out: that
   * lease only sees debug sessions within this process, so two processes could each
   * see a free lease and both arm without this. Optional for backward compat.
   */
  armLock?: DebugArmLock;
  /** Wall-clock idle cap while suspended. Default 300_000. */
  idleTimeoutMs?: number;
  /** Requested server-side listener timeout, seconds. Default 60; clamped to `[1, 240]` — 240 is the server's hard max (`LISTENER_SERVER_TIMEOUT_MS`). */
  listenerTimeoutSeconds?: number;
  /** Gap between `getListener()` registration-confirmation polls. Default 250ms. */
  registrationPollIntervalMs?: number;
  /** Total budget for confirming registration before `armListener()` gives up and cleans up. Default 5_000ms. */
  registrationPollTimeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * Per-network-call and whole-sequence deadlines for `terminate()`/`cleanup()`.
 * Both must stay strictly below the tool-layer waits that wrap this module
 * (`src/tools/debug.ts`'s `START_FAILURE_CLEANUP_WAIT_MS`/`STOP_WAIT_MS`, both
 * 5_000ms) — otherwise the tool layer gives up first, leaving a session wedged
 * in `activeSessions` forever. See `forceDropDebugSession()` for the backstop.
 */
const TERMINATE_STEP_DEADLINE_MS = 1_500;
const TERMINATE_TOTAL_DEADLINE_MS = 4_000;

export type SettleOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "timeout" | "error"; error?: unknown };

/**
 * Races `p` against `ms`. Never rejects and never leaves an unhandled rejection
 * behind (a late failure after the deadline fired is swallowed). Opposite contract
 * to the tool layer's `raceDeadline` (`src/tools/debug.ts`), which propagates
 * rejections — deliberately not sharing a name with that one anymore.
 */
function settleWithin<T>(p: Promise<T>, ms: number): Promise<SettleOutcome<T>> {
  return new Promise<SettleOutcome<T>>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: "timeout" });
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
    p.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, reason: "error", error });
      },
    );
  });
}

/**
 * The one structural test for the harmless "Debuggee already attached" failure
 * (`subtype: "invalidDebuggee"` — never a `.includes()` on the message). Shared by
 * both `client.attach()` call sites (`attach()` and `terminationSteps()`'s
 * best-effort attach-before-terminate) so they agree on what's benign.
 */
function isDoubleAttachError(e: unknown): boolean {
  return isAbapError(e) && e.details?.["subtype"] === "invalidDebuggee";
}

// ---------------------------------------------------------------------------
// The session.
// ---------------------------------------------------------------------------

export class DebugSession {
  private readonly client: DebugClient;
  private readonly context: DebugContext;
  private readonly sessionLease?: DebugSessionLease;
  private readonly armLock?: DebugArmLock;
  private readonly idleTimeoutMs: number;
  private readonly listenerTimeoutSeconds: number;
  private readonly registrationPollIntervalMs: number;
  private readonly registrationPollTimeoutMs: number;
  private readonly log: (msg: string) => void;

  private status: DebugSessionStatus = "idle";
  private currentStateId: StateId | undefined;
  private debugSessionId: string | undefined;
  private debuggeeId: string | undefined;
  private deathReason: DebugDeathReason | undefined;
  private deathDetail: string | undefined;
  private terminationResult: DebugTerminationResult | undefined;

  /**
   * Per-session revisit ledger, keyed by `(program, stackPosition, line)`. Exists
   * because `step:"over"` across a `LOOP...ENDLOOP` back-edge was found to undercount
   * iterations (see the git history for the measured
   * evidence) — cause not proven client- or server-side. Not a fix: it only makes
   * revisits of a reported position visible (`recordVisit()`, read by `step()`) so the
   * tool layer can advise breakpoint+continue instead, which was verified correct.
   */
  private readonly visitedPositions = new Map<string, number>();

  private stepCounter = 0;
  private idleTimer: NodeJS.Timeout | undefined;

  private listenHandle: ReturnType<DebugClient["launchListener"]> | undefined;
  private listenConsumed = false;
  /** True only while `waitForDebuggee()` is parked on `handle.result` — re-entry guard. */
  private listenWaiting = false;
  /** Name of the first operation this session issued on the stateful ADT session while a long-poll was outstanding — that operation was head-of-line blocked behind the poll, not the other way around. */
  private pollPreempted: string | undefined;
  /** Unacknowledged session block; blocks a silent re-arm until `acknowledgeSessionBlock()`. */
  private sessionBlockedBy: string | undefined;
  /** Op names abandoned by `terminateStep()` on timeout — stderr already logs each one; kept here so `snapshot` can carry the same fact out to the tool response. */
  private readonly abandonedCleanupSteps: string[] = [];

  /** Cached only so the harmless "already attached" recovery path (see `attach()`) has something real to reuse instead of fabricating a response from nothing. */
  private lastAttachResult: DebugAttachResult | undefined;

  /**
   * Every breakpoint THIS session armed for real, keyed by the server-assigned id
   * (`CreatedBreakpoint.id`). Exists so shutdown deletes exactly what this session
   * created via targeted `DELETE /debugger/breakpoints/{id}` and nothing else.
   *
   * Do not replace this with `syncScope {mode:"full"}` + empty breakpoint list — that
   * tells SAP "this is now the complete set of external breakpoints for this user" and
   * deletes every breakpoint that user has, including ones set in Eclipse or by a
   * concurrent session. See `endpoints.ts`'s `SYNC_SCOPE_MODE` and `types.ts`'s
   * `BreakpointsRequest.syncScope`, both of which repeat this warning.
   */
  private readonly ownedBreakpoints: CreatedBreakpoint[] = [];

  private terminatePromise: Promise<void> | undefined;

  constructor(opts: DebugSessionOptions) {
    this.client = opts.client;
    this.context = opts.context;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 300_000;
    this.listenerTimeoutSeconds = Math.max(1, Math.min(240, opts.listenerTimeoutSeconds ?? 60));
    this.registrationPollIntervalMs = opts.registrationPollIntervalMs ?? 250;
    this.registrationPollTimeoutMs = opts.registrationPollTimeoutMs ?? 5_000;
    this.log = opts.log ?? (() => {});
    this.sessionLease = opts.sessionLease;
    this.armLock = opts.armLock;
    activeSessions.add(this);
  }

  /** A fresh, immutable-ish copy — never a live reference callers could mutate. */
  get snapshot(): DebugSessionSnapshot {
    return {
      status: this.status,
      stateId: this.currentStateId,
      debugSessionId: this.debugSessionId,
      debuggeeId: this.debuggeeId,
      deathReason: this.deathReason,
      deathDetail: this.deathDetail,
      terminationResult: this.terminationResult,
      sessionBlockedBy: this.sessionBlockedBy,
      abandonedCleanupSteps:
        this.abandonedCleanupSteps.length > 0 ? [...this.abandonedCleanupSteps] : undefined,
    };
  }

  /**
   * Called immediately before any client call that goes out on this session's
   * stateful ADT session. If a long-poll is outstanding, that call is about to be
   * head-of-line blocked behind it for the poll's remaining timeout (the listener
   * itself is never killed by this) — record which operation did it so
   * `waitForDebuggee()` can report `"blocked"` rather than a plain timeout. Only the
   * first colliding operation is kept, since it's the one that explains the delay.
   */
  private hasOutstandingListener(): boolean {
    return this.listenHandle !== undefined && !this.listenConsumed;
  }

  private noteStatefulRequest(op: string): void {
    if (!this.hasOutstandingListener()) return;
    if (this.pollPreempted !== undefined) return;
    this.pollPreempted = op;
    this.log(
      `[debug-session] ${op} is being issued on the same stateful ADT session as an OUTSTANDING listener ` +
        `long-poll — ${op} will be head-of-line blocked behind that poll for up to its full remaining timeout ` +
        `(the poll itself is not affected and will run to its natural timeout).`,
    );
  }

  /**
   * Clears a recorded session block so `armListener()` will arm again. Deliberately
   * explicit: a session block is a caller bug, and re-arming without acknowledging it
   * would hide that bug behind a retry loop.
   */
  acknowledgeSessionBlock(): void {
    this.sessionBlockedBy = undefined;
  }

  /**
   * Aborts the outstanding listener long-poll LOCALLY: `handle.abort()` fires the
   * `AbortController` `DebugLongPollClient.listen()` created and tears down the
   * in-flight HTTP request in this process. Sends nothing, is not an ADT call, cannot
   * head-of-line block anything — deliberately not routed through `noteStatefulRequest()`.
   *
   * THE LAW of this module: a second request on the same stateful ADT session is
   * head-of-line blocked behind an outstanding long-poll for the remainder of its
   * timeout (see `armListener()`'s doc comment and the archive for the measurement).
   * So a leaked listener can never be fixed by another request — only local socket
   * teardown; server-side release is the separate `stopListener()` DELETE already on
   * these paths. Without this, every path dropping `listenHandle` left the socket open
   * until the ~360s server timeout.
   */
  private abortListener(reason: string): void {
    const handle = this.listenHandle;
    if (!handle || handle.aborted) return;
    try {
      handle.abort();
      this.log(
        `[debug-session] aborted the outstanding listener long-poll locally (${reason}) — client-side only, no ` +
          `request issued, so the ~360s leak on this path is closed without pre-empting anything.`,
      );
    } catch (e) {
      this.log(`[debug-session] abortListener (${reason}) threw: ${describeUnknownError(e)}`);
    }
  }

  // --- Breakpoints ----------------------------------------------------------

  /**
   * Validates every breakpoint (`validationOnly="true"`) before arming any for real.
   * If validation refuses even one, nothing is armed and the thrown `BAD_INPUT` names
   * every refusal. The real pass is checked the same way defensively, in case SAP
   * refuses something for real that it accepted during validation.
   */
  async prepareBreakpoints(breakpoints: Breakpoint[]): Promise<CreatedBreakpoint[]> {
    const buildRequest = (bps: Breakpoint[]): BreakpointsRequest => ({
      debuggingMode: this.context.debuggingMode,
      requestUser: this.context.requestUser,
      terminalId: this.context.terminalId,
      ideId: this.context.ideId,
      scope: "external",
      breakpoints: bps,
    });

    const isRefusal = (r: CreatedBreakpoint | BreakpointError): r is BreakpointError => "errorMessage" in r;
    const describeRefusals = (refusals: BreakpointError[]): string =>
      refusals.map((r) => `[${r.kind}${r.clientId ? ` clientId=${r.clientId}` : ""}] ${r.errorMessage}`).join("; ");

    // Load-bearing ordering: production always calls this before armListener() — do
    // not move breakpoint preparation after arming.
    this.noteStatefulRequest("prepareBreakpoints (validation pass)");
    const validation = await this.client.setBreakpoints(
      buildRequest(breakpoints.map((bp) => ({ ...bp, validationOnly: true }))),
    );
    const validationRefusals = validation.filter(isRefusal);
    if (validationRefusals.length > 0) {
      throw new AbapError(
        "BAD_INPUT",
        `prepareBreakpoints: ${validationRefusals.length} breakpoint(s) refused during validation: ` +
          describeRefusals(validationRefusals),
        { refusals: validationRefusals },
      );
    }

    this.noteStatefulRequest("prepareBreakpoints (arming pass)");
    const real = await this.client.setBreakpoints(buildRequest(breakpoints));
    const realRefusals = real.filter(isRefusal);
    if (realRefusals.length > 0) {
      throw new AbapError(
        "BAD_INPUT",
        `prepareBreakpoints: ${realRefusals.length} breakpoint(s) refused when arming for real, ` +
          `despite passing validation: ${describeRefusals(realRefusals)}`,
        { refusals: realRefusals },
      );
    }
    // Record what this session owns so shutdown deletes precisely these. Only rows
    // with a server-issued id are deletable; a row without one is logged and skipped.
    const created = real as CreatedBreakpoint[];
    for (const bp of created) {
      if (typeof bp.id !== "string" || bp.id.length === 0) {
        this.log(
          `[debug-session] prepareBreakpoints: the server accepted a ${bp.kind} breakpoint but echoed no id — ` +
            `it cannot be deleted individually at shutdown and will be left registered.`,
        );
        continue;
      }
      if (!this.ownedBreakpoints.some((b) => b.id === bp.id)) this.ownedBreakpoints.push(bp);
    }
    return created;
  }

  /**
   * Deletes ONLY the breakpoints this session created — one targeted DELETE per
   * breakpoint (no batch delete exists).
   *
   * Never re-introduce the unscoped `syncScope {mode:"full"}, breakpoints: []` POST
   * this replaced — see `ownedBreakpoints`'s doc comment for why that wipes other
   * breakpoints, not just this session's. A session that never armed a breakpoint
   * issues nothing here.
   */
  private async deleteOwnedBreakpoints(): Promise<void> {
    if (this.ownedBreakpoints.length === 0) return;
    // Drained first so a second terminate() cannot re-issue deletes for handled ids.
    const owned = this.ownedBreakpoints.splice(0, this.ownedBreakpoints.length);
    this.noteStatefulRequest("shutdown deleting this session's own breakpoints");
    for (const bp of owned) {
      await this.terminateStep(
        `deleting this session's breakpoint ${bp.id}`,
        () =>
          this.client.deleteBreakpoint({
            id: bp.id,
            scope: "external",
            debuggingMode: this.context.debuggingMode,
            requestUser: this.context.requestUser,
            terminalId: this.context.terminalId,
            ideId: this.context.ideId,
          }),
        // Already gone (debuggee finished, or a previous partial cleanup got it).
        (e) => isAbapError(e) && e.code === "NOT_FOUND",
      );
    }
  }

  // --- Listener arm / wait ----------------------------------------------------

  private listenerParams(): DebugContext {
    return {
      debuggingMode: this.context.debuggingMode,
      terminalId: this.context.terminalId,
      ideId: this.context.ideId,
      requestUser: this.context.requestUser,
    };
  }

  /**
   * Starts the long-poll and returns once the POST has been dispatched.
   *
   * DO NOT reintroduce a `getListener()` confirmation poll here. It was tried and
   * broke the listener — not by killing it (that original theory was wrong; live
   * capture on 2026-08-02 showed the listener always survives to its natural
   * timeout) but by head-of-line blocking the confirming request behind the poll for
   * its whole remaining duration — measured 55-115s across trials, see
   * the git history. Both outcomes are indistinguishable on
   * the wire (HTTP 200, empty body), which is why the original bug was misdiagnosed.
   *
   * Operational rule: never issue a second request on a session with an armed
   * listener, and never reintroduce a confirmation poll here — polling on a second
   * connection isn't implementable either, since `DebugClient` holds exactly one
   * transport.
   *
   * `handle.armed` settles at dispatch — the strongest signal obtainable without
   * stalling behind the thing being observed, and a real synchronisation point
   * rather than the fixed `sleep` a prior implementation used.
   */
  async armListener(): Promise<void> {
    if (this.status !== "idle") {
      throw new AbapError(
        "BAD_INPUT",
        `armListener: session must be idle to arm a listener; current status is "${this.status}".`,
        { status: this.status },
      );
    }
    if (this.sessionBlockedBy !== undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `armListener: the previous listener's empty result is suspect — ${this.sessionBlockedBy} was issued on ` +
          `this SAME stateful ADT session while that poll was still outstanding, and would have been head-of-line ` +
          `blocked behind it for minutes. Re-arming without fixing the caller would repeat the same stall on ` +
          `${this.sessionBlockedBy}, not on the new listener.`,
        { status: this.status, sessionBlockedBy: this.sessionBlockedBy },
        "Stop issuing stateful debugger requests on this session while a listener poll is outstanding, then call " +
          "acknowledgeSessionBlock() to clear this and arm again.",
      );
    }

    // `listenerTimeoutSeconds` goes on the wire as the ADT listener `timeout` query
    // param (how long the server holds the poll open) and must stay below the
    // client-side abort deadline, or the client aborts a poll the server is still
    // legitimately holding. Checked against what's really sent, not `listenTimeoutMs`
    // (which never reaches the wire). Runs before `launchListener`, before any
    // `armed` promise exists, so a throw here can't strand `armed`.
    const clientAbortMs = this.client.longPollAbortTimeoutMs?.();
    if (typeof clientAbortMs === "number") {
      assertServerHoldSafe(this.listenerTimeoutSeconds, clientAbortMs);
    }

    // Cross-process exclusion, taken here (after every locally-decidable refusal
    // above, so a rejected call never costs a lock file) and released by
    // `releaseArmLock()`. Must precede `launchListener` — that's the first moment
    // this process becomes visible to SAP as a debug listener. A rejection here
    // propagates untouched, leaving the session "idle" with nothing to tear down.
    await this.armLock?.acquire();

    let handle;
    try {
      handle = this.client.launchListener({ ...this.listenerParams(), timeout: this.listenerTimeoutSeconds });
    } catch (e) {
      // launchListener() can throw synchronously; without this the lock would be
      // held by a session that never arms and never terminates.
      this.releaseArmLock("launchListener threw");
      throw e;
    }
    this.listenHandle = handle;
    this.listenConsumed = false;
    this.listenWaiting = false;
    this.pollPreempted = undefined;
    // `armed` never rejects and settles on failure too, so racing it against
    // `result` turns a failed listen into a thrown real cause (e.g. AUTH_CIRCUIT_OPEN)
    // instead of a hang followed by a misleading registration timeout.
    try {
      await Promise.race([handle.armed, handle.result]);
    } catch (e) {
      // Error teardown: nobody will ever await this handle now. Abort it locally
      // (no request — see `abortListener()`) instead of leaving a socket open until
      // the server's 360s timeout, and drop the handle so a later re-arm isn't
      // blocked by a corpse.
      this.abortListener("armListener failed");
      this.listenHandle = undefined;
      this.listenConsumed = false;
      // Status stays "idle" here, so a caller may legitimately re-arm and terminate()
      // may never be called — release the cross-process lock too.
      this.releaseArmLock("armListener failed");
      throw e;
    }

    this.status = "listening";
  }

  /**
   * Idempotent release of the cross-process debug lock — safe with no lock injected,
   * never acquired, or called twice. Named (not inlined) so "released on every exit
   * path" stays greppable. Three callers: `armListener()`'s two failure teardowns,
   * `waitForDebuggee()`'s non-debuggee return, and `doTerminate()`'s `finally`.
   *
   * Deliberately NOT called from `waitForDebuggee()`'s reject branch: status stays
   * `"listening"` there and the server-side registration may have survived, so this
   * process is still who SAP would hand a debuggee to — releasing would let a second
   * process arm against a still-live listener. `terminate()` is what ends that state.
   *
   * The crash case (a process that dies holds no `finally`) is covered instead by
   * `withFileLock`'s stale-holder rules and `DEBUG_ARM_LOCK_HARD_STALE_MS`.
   */
  private releaseArmLock(reason: string): void {
    if (this.armLock === undefined) return;
    try {
      this.armLock.release();
    } catch (e) {
      // Must never become the caller's error: every call site is already on a
      // failure/teardown path carrying a more useful one.
      this.log(`debug arm lock release failed (${reason}): ${describeUnknownError(e)}`);
    }
  }

  /**
   * Awaits the outcome of the listener armed by `armListener()`. The caller must have
   * fired the trigger (a separate connection this module doesn't manage) before or
   * while calling this. On `"timeout"`/`"conflict"` the listener is released and
   * status returns to `"idle"` — a normal outcome, not a failure. On `"debuggee"`,
   * status becomes `"caught"`, `debuggeeId` is stored, and the idle timer starts right
   * here, since a caught-but-not-yet-attached debuggee still occupies a work process.
   */
  async waitForDebuggee(): Promise<ListenWaitResult> {
    if (!this.listenHandle || this.listenConsumed || this.listenWaiting) {
      throw new AbapError(
        "BAD_INPUT",
        "waitForDebuggee: armListener() was never called, or its result was already consumed.",
        { status: this.status },
      );
    }
    const handle = this.listenHandle;
    this.listenWaiting = true;

    // Settled reflectively so the bookkeeping below runs even if the handle
    // rejects — otherwise `listenWaiting` would stick and wedge the session.
    const settled = await handle.result.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    // Order matters: capture the colliding operation and mark the poll
    // consumed BEFORE any teardown call below, so this method's own
    // `stopListener()` — which by definition runs after the poll has already
    // settled — can never be mistaken for the operation that collided with it.
    const preempter = this.pollPreempted;
    this.listenWaiting = false;
    this.listenConsumed = true;
    this.pollPreempted = undefined;

    if (!settled.ok) {
      // The poll rejected (transport error, or someone else's abort). The
      // handle is finished either way; abort it locally so any residual
      // in-flight request is torn down here rather than lingering, and drop it.
      this.abortListener("listener long-poll rejected");
      this.listenHandle = undefined;
      throw settled.error;
    }
    const outcome = settled.value;

    if (outcome.kind === "debuggee") {
      this.debuggeeId = outcome.debuggee.id;
      this.status = "caught";
      this.startIdleTimer();
      return outcome;
    }

    // An empty body always means the server hold genuinely expired (live capture
    // disproved the old belief that a second request could end it early). What only
    // this session can know is whether it ALSO issued another stateful request while
    // this poll was outstanding (`pollPreempted`) — worth surfacing even though it
    // never changed this poll's own outcome.
    let result: ListenWaitResult;
    if (outcome.kind === "empty" && preempter !== undefined) {
      const detail =
        `This session issued ${preempter} on the SAME stateful ADT session while this listener poll was still ` +
        `outstanding. ${preempter} would have been head-of-line blocked behind the poll for up to its full ` +
        `remaining timeout — the poll itself was not affected; it ran to its own natural timeout without ` +
        `catching a debuggee. Both outcomes return HTTP 200 with a 0-byte body, so this is reported separately ` +
        `from a plain timeout rather than silently retried.`;
      this.sessionBlockedBy = preempter;
      this.log(
        `[debug-session] SESSION BLOCKED — ${preempter} was issued on this session while the listener poll was ` +
          `outstanding and was head-of-line blocked behind it for the remainder of the poll's timeout; the ` +
          `listener itself timed out normally and was never cancelled, but this must not be silently re-armed ` +
          `until the caller stops colliding with its own outstanding poll`,
      );
      result = { kind: "blocked", detail };
    } else if (outcome.kind === "empty") {
      result = { kind: "timeout" };
    } else {
      result = outcome;
    }

    // Non-debuggee outcomes: release the listener and go idle. Local abort
    // first (free the socket immediately, no request), THEN the one DELETE that
    // releases the server-side registration — the round-trip count is unchanged.
    this.abortListener(`listener released after ${result.kind}`);
    try {
      await this.client.stopListener(this.listenerParams());
    } catch (e) {
      this.log(`[debug-session] waitForDebuggee: stopListener after ${result.kind} failed: ${describeUnknownError(e)}`);
    }
    this.listenHandle = undefined;
    this.status = "idle";
    // The server-side registration is gone (the DELETE above) and this session
    // is back to `"idle"` holding nothing, so the debugger slot must go back to
    // whoever wants it next — a caller that gives up after a timeout may never
    // call `terminate()`. See `releaseArmLock()` for why the reject branch
    // above deliberately does NOT do this.
    this.releaseArmLock(`listener released after ${result.kind}`);
    return result;
  }

  // --- Attach -----------------------------------------------------------------

  /**
   * Attaches to `debuggeeId`, fetches the stack, computes the initial `stateId`
   * (`stepCounter=0`), starts the idle timer, sets status `"suspended"`.
   *
   * Recovers from the harmless "Debuggee already attached" error by calling
   * `getStack()` instead of re-throwing. Reuses the last cached `DebugAttachResult`
   * if this session attached successfully before (the realistic case: a caller
   * retries after its own response was lost); otherwise builds a minimal synthetic
   * result from `getStack()` alone (placeholders for non-derivable fields, logged) —
   * the one documented case where the returned result isn't a real wire response.
   */
  async attach(debuggeeId: string): Promise<{ attach: DebugAttachResult; stack: DebugStack; stateId: StateId }> {
    let attachResult: DebugAttachResult;
    try {
      this.noteStatefulRequest("attach");
      attachResult = await this.client.attach({
        debuggeeId,
        debuggingMode: this.context.debuggingMode,
        requestUser: this.context.requestUser,
      });
    } catch (e) {
      if (isDoubleAttachError(e)) {
        this.log(
          '[debug-session] attach: harmless double attach ("Debuggee already attached") — recovering via getStack().',
        );
        this.noteStatefulRequest("attach (double-attach recovery getStack)");
        // getStack() below only succeeds if the existing attachment is THIS session's
        // own. If it belongs to a different session (typically a stale attachment left
        // by an earlier, uncleanly-exited process at the same terminalId/ideId
        // identity), getStack() also fails — handled explicitly below rather than
        // propagating a confusing raw NOT_CONNECTED.
        let stack: DebugStack;
        try {
          stack = await this.client.getStack();
        } catch (recoveryErr) {
          throw new AbapError(
            "SESSION_DEAD",
            "Debuggee already attached, and it does not belong to this session — the double-attach " +
              `recovery (getStack()) also failed: ${describeUnknownError(recoveryErr)}. This is most likely a ` +
              "stale attachment left by an earlier process instance that exited without a clean detach " +
              "(crash, kill -9, container respawn) — the ADT server is still holding it.",
            { subtype: "invalidDebuggee", recoveryError: describeUnknownError(recoveryErr) },
            'Force-clear the stale attachment with abap_debug({action:"stop", force:true}), then retry ' +
              "start. That call only ever releases a debuggee/listener armed at THIS server's own " +
              "deterministic identity (sid+user, or the configured ABAP_TERMINAL_ID/ABAP_IDE_ID) — it " +
              "cannot reach, and will not touch, another user's or another identity's live session.",
          );
        }
        const recovered = this.lastAttachResult ?? this.syntheticAttachResult(stack);
        return this.finishAttach(debuggeeId, recovered, stack);
      }
      throw e;
    }
    this.noteStatefulRequest("attach (post-attach getStack)");
    const stack = await this.client.getStack();
    return this.finishAttach(debuggeeId, attachResult, stack);
  }

  private syntheticAttachResult(stack: DebugStack): DebugAttachResult {
    this.log(
      "[debug-session] attach: no cached attach result to reuse on double-attach recovery — synthesizing a " +
        "minimal DebugAttachResult from getStack() alone; its non-stack fields are placeholders, not real wire data.",
    );
    return {
      isRfc: stack.isRfc,
      isSameSystem: stack.isSameSystem,
      serverName: stack.serverName,
      debugSessionId: this.debugSessionId ?? "",
      processId: 0,
      isPostMortem: false,
      isUserAuthorizedForChanges: false,
      debuggeeSessionId: "",
      abapTraceState: "",
      canAdvancedTableFeatures: false,
      isNonExclusive: false,
      isNonExclusiveToggled: false,
      guiEditorGuid: "",
      sessionTitle: "",
      isSteppingPossible: true,
      isTerminationPossible: true,
      actions: [],
      reachedBreakpoints: [],
    };
  }

  private finishAttach(
    debuggeeId: string,
    attachResult: DebugAttachResult,
    stack: DebugStack,
  ): { attach: DebugAttachResult; stack: DebugStack; stateId: StateId } {
    this.lastAttachResult = attachResult;
    this.debuggeeId = debuggeeId;
    this.debugSessionId = attachResult.debugSessionId;
    this.stepCounter = 0;
    const frame = stack.frames[0] ?? { stackPosition: 0, programName: "", line: 0 };
    this.currentStateId = computeStateId({
      debugSessionId: this.debugSessionId,
      stackPosition: frame.stackPosition,
      program: frame.programName,
      line: frame.line,
      stepCounter: 0,
    });
    this.status = "suspended";
    this.startIdleTimer();
    return { attach: attachResult, stack, stateId: this.currentStateId };
  }

  // --- stateId validation ------------------------------------------------------

  private validateStateId(stateId: StateId): void {
    if (this.currentStateId === undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `No active debug session state (status is "${this.status}"); attach to a debuggee first.`,
        { status: this.status },
      );
    }
    if (stateId !== this.currentStateId) {
      throw new AbapError(
        "BAD_INPUT",
        `Stale stateId: the session has moved on. The current stateId is "${this.currentStateId}".`,
        { providedStateId: stateId, currentStateId: this.currentStateId },
        "Re-fetch the stack/variables using the current stateId rather than one held from before the last step — " +
          "this session deliberately does not auto-recover against a different state (types.ts's StateId doc comment).",
      );
    }
  }

  /**
   * Runs one stateful, stop-scoped `DebugClient` call: validates `stateId` first,
   * resets the idle timer on success, and applies signal-A death detection (a thrown
   * `SESSION_DEAD`/`NOT_CONNECTED` means the debuggee is gone) uniformly to every
   * read/write, not just `step()`. On that signal the session is marked dead
   * (`"debuggee_finished"`) and the original error is rethrown unchanged.
   */
  private async runStateful<T>(stateId: StateId, op: () => Promise<T>): Promise<T> {
    this.validateStateId(stateId);
    try {
      const result = await op();
      this.touch();
      return result;
    } catch (e) {
      if (isAbapError(e) && (e.code === "SESSION_DEAD" || e.code === "NOT_CONNECTED")) {
        await this.terminate("debuggee_finished", e.message, terminationEvidenceFrom(e)).catch(
          (cleanupErr: unknown) =>
            this.log(`[debug-session] cleanup after death signal failed: ${describeUnknownError(cleanupErr)}`),
        );
      }
      throw e;
    }
  }

  async getStack(stateId: StateId): Promise<DebugStack> {
    return this.runStateful(stateId, () => this.client.getStack());
  }

  async getVariables(stateId: StateId, ids: readonly string[]): Promise<DebugVariable[]> {
    return this.runStateful(stateId, () => this.client.getVariables(ids));
  }

  async getChildVariables(stateId: StateId, parentIds: readonly string[]): Promise<ChildVariablesResult> {
    return this.runStateful(stateId, () => this.client.getChildVariables(parentIds));
  }

  async getRootVariables(stateId: StateId): Promise<RootVariablesResult> {
    return this.runStateful(stateId, () => this.client.getRootVariables());
  }

  async setVariableValue(stateId: StateId, name: string, value: string): Promise<void> {
    return this.runStateful(stateId, () => this.client.setVariableValue(name, value));
  }

  async setStackPosition(stateId: StateId, params: SetStackPositionParams): Promise<void> {
    return this.runStateful(stateId, () => this.client.setStackPosition(params));
  }

  /**
   * Session-wide, not stop-scoped — takes no `stateId`, bypassing
   * `runStateful()`/`validateStateId()`. Refused outright (not just recorded) while a
   * listener long-poll is outstanding: issuing it then would not cancel the poll, only
   * get head-of-line blocked behind it for up to its full remaining timeout.
   *
   * Resolves with the settings the server echoed back as applied — do NOT verify
   * against a subsequent step response's `step.settings`, which is not a contract.
   */
  async setDebuggerSettings(settings: DebugSettings): Promise<DebugSettings> {
    if (this.hasOutstandingListener()) {
      throw new AbapError(
        "BAD_INPUT",
        `setDebuggerSettings: a debug listener long-poll is currently outstanding on this session's stateful ` +
          `ADT session — issuing this call now would be head-of-line blocked behind that poll for up to its full ` +
          `remaining timeout, not served promptly. Call setDebuggerSettings() BEFORE armListener(), or after the ` +
          `debuggee has been caught.`,
      );
    }
    this.noteStatefulRequest("setDebuggerSettings");
    const applied = await this.client.setDebuggerSettings(settings);
    this.touch();
    return applied;
  }

  // --- Step --------------------------------------------------------------------

  /** Records one visit to `(program, stackPosition, line)`, returns the running count (1 = first visit). Pure bookkeeping; the caller decides what a revisit means. */
  private recordVisit(program: string, stackPosition: number, line: number): number {
    const key = `${program}::${stackPosition}::${line}`;
    const count = (this.visitedPositions.get(key) ?? 0) + 1;
    this.visitedPositions.set(key, count);
    return count;
  }

  /**
   * Runs one step, re-fetches the stack, recomputes `stateId` (`stepCounter+1`),
   * resets the idle timer. Never accepts `"terminateDebuggee"` as a step kind —
   * `terminate()` is the only sanctioned way to end a session; a raw step there would
   * incorrectly throw on the success-shaped HTTP 500 that operation returns.
   *
   * Two-signal death check:
   *   - **Signal A** (error path): `step()` or the follow-up `getStack()` throws
   *     `SESSION_DEAD`/`NOT_CONNECTED`. Marked dead (`"debuggee_finished"`). A throw
   *     from `step()` itself is rethrown unchanged; one from `getStack()` gets the
   *     "step already happened" wrapper below, original error in `details.cause`.
   *   - **Signal B** (success path): step succeeds but `isSteppingPossible`/
   *     `isTerminationPossible` comes back false — debuggee finished cleanly, nothing
   *     thrown. Session is marked dead but the call returns normally with the final
   *     stack/stateId; callers must check `.snapshot` after every `step()`.
   *
   * **Double-physical-step invariant**: `client.step()` returning is the point of no
   * return — the debuggee has moved and nothing client-side can undo it. `stateId` is
   * retired the instant `step()` returns, before `getStack()` is attempted, so a
   * `getStack()` failure can never leave a caller able to retry `step()` with the old
   * (still-valid-looking) `stateId` and physically step the debuggee twice. The error
   * on that path names the fix instead: re-read via `details.currentStateId`
   * (`details.stepExecuted === true`), never step again.
   */
  async step(
    stateId: StateId,
    kind: DebugStepKind,
    uri?: string,
  ): Promise<{ step: DebugStepResult; stack: DebugStack; stateId: StateId; positionVisitCount: number }> {
    if (kind === "terminateDebuggee") {
      throw new AbapError(
        "BAD_INPUT",
        'step: "terminateDebuggee" must not be issued as a step — call terminate() instead.',
        { kind },
        "terminate() unwraps the success-shaped HTTP 500 this operation returns; a raw step() call would " +
          "incorrectly throw on it.",
      );
    }
    this.validateStateId(stateId);

    const dieOnDeathSignal = async (e: unknown): Promise<void> => {
      if (isAbapError(e) && (e.code === "SESSION_DEAD" || e.code === "NOT_CONNECTED")) {
        await this.terminate("debuggee_finished", e.message, terminationEvidenceFrom(e)).catch(
          (cleanupErr: unknown) =>
            this.log(`[debug-session] cleanup after death signal (step) failed: ${describeUnknownError(cleanupErr)}`),
        );
      }
    };

    let stepResult: DebugStepResult;
    try {
      stepResult = await this.client.step({ step: kind, uri });
    } catch (e) {
      await dieOnDeathSignal(e);
      throw e;
    }

    // ---- Point of no return -------------------------------------------------
    // The physical step has happened; retire `stateId` before getStack() is even
    // attempted so no failure below can leave a re-usable handle on an abandoned
    // position. `stepCounter` guarantees a new id even on an identical program/line.
    const nextStepCounter = this.stepCounter + 1;
    this.stepCounter = nextStepCounter;
    this.debugSessionId = stepResult.debugSessionId;
    // Provisional, from a deliberately unknown frame — a valid handle for the
    // recovery getStack() the caller is told to make, and NOT the id they stepped with.
    this.currentStateId = computeStateId({
      debugSessionId: stepResult.debugSessionId,
      stackPosition: -1,
      program: "<stack-not-read>",
      line: -1,
      stepCounter: nextStepCounter,
    });

    let stack: DebugStack;
    try {
      stack = await this.client.getStack();
    } catch (e) {
      await dieOnDeathSignal(e);
      throw new AbapError(
        "BAD_INPUT",
        `step: the "${kind}" step DID execute on the debuggee — it has already moved and cannot be moved back — ` +
          `but the follow-up getStack() failed: ${describeUnknownError(e)}. Do NOT retry the step: doing so would ` +
          `step the debuggee a SECOND time. The stateId you passed has been retired; the current stateId is ` +
          `"${this.currentStateId}".`,
        {
          stepExecuted: true,
          kind,
          providedStateId: stateId,
          currentStateId: this.currentStateId,
          causeCode: isAbapError(e) ? e.code : undefined,
          cause: describeUnknownError(e),
        },
        `Re-read the stack with getStack("${this.currentStateId}") to resynchronise. Only re-issue step() once ` +
          `you have a fresh stack — a retry with the old stateId is now refused precisely so the debuggee cannot ` +
          `be stepped twice for one requested step.`,
        { retryable: false }, // the step already executed; retrying would step the debuggee a second time
      );
    }

    const frame = stack.frames[0] ?? { stackPosition: 0, programName: "", line: 0 };
    const nextStateId = computeStateId({
      debugSessionId: stepResult.debugSessionId,
      stackPosition: frame.stackPosition,
      program: frame.programName,
      line: frame.line,
      stepCounter: nextStepCounter,
    });
    this.currentStateId = nextStateId;
    this.touch();

    // Revisit ledger — see `visitedPositions`'s doc comment. Recorded for every
    // completed step regardless of kind/outcome.
    const positionVisitCount = this.recordVisit(frame.programName, frame.stackPosition, frame.line);

    // This branch is the ONLY place that can produce `kind: "finished"` (see
    // `DebugTerminationResult`'s doc comment) — not observed in three live trials so
    // far (all landed in `"session_ended"` instead, see the archive), but not proven
    // unreachable and still exercised directly by unit tests.
    if (!stepResult.isSteppingPossible || !stepResult.isTerminationPossible) {
      await this.terminate(
        "debuggee_finished",
        "isSteppingPossible/isTerminationPossible reported false after step (signal B).",
      ).catch((cleanupErr: unknown) =>
        this.log(`[debug-session] cleanup after death signal (step, signal B) failed: ${describeUnknownError(cleanupErr)}`),
      );
    }

    // ---- Mitigation: a lagging death signal ------------------------------------------
    // Live testing found a crashing statement (failing ASSERT) whose step+getStack
    // above come back looking like a clean suspended stop, with death only surfacing
    // on the caller's NEXT step (see archive for detail) — a one-response lag. Not a
    // proven fix, just a mitigation: skipped if Signal B already fired above, otherwise
    // issues one extra getStack() through the same signal-A path, on the theory it buys
    // SAP's own bookkeeping a little more time to catch up. Does not touch the
    // double-physical-step invariant (a read, not a step). Whether this actually closes
    // the observed lag has not been confirmed live.
    if (this.status !== "dead") {
      try {
        await this.client.getStack();
      } catch (e) {
        await dieOnDeathSignal(e);
        // Not rethrown: the step already succeeded and is returned below. Logged only
        // if NOT a death signal, so a transient blip doesn't turn a good step into an
        // error but also isn't silently invisible.
        if (!(isAbapError(e) && (e.code === "SESSION_DEAD" || e.code === "NOT_CONNECTED"))) {
          this.log(`[debug-session] step: post-step verification getStack() failed (not a death signal): ${describeUnknownError(e)}`);
        }
      }
    }

    return { step: stepResult, stack, stateId: this.currentStateId, positionVisitCount };
  }

  // --- Idle timer ----------------------------------------------------------------

  private startIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.terminate("idle_timeout", `No debugger activity for ${this.idleTimeoutMs}ms.`).catch(
        (e: unknown) => this.log(`[debug-session] idle-timeout cleanup failed: ${describeUnknownError(e)}`),
      );
    }, this.idleTimeoutMs);
    if (typeof this.idleTimer.unref === "function") this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** Only meaningful while suspended or caught — the idle timer does not run at any other status. */
  private touch(): void {
    if (this.status === "suspended" || this.status === "caught") this.startIdleTimer();
  }

  /** Explicit keepalive — resets the idle timer, no other side effect. */
  keepalive(): void {
    if (this.status !== "suspended" && this.status !== "caught") {
      throw new AbapError(
        "BAD_INPUT",
        `keepalive: nothing to keep alive; session status is "${this.status}", not "suspended" or "caught".`,
        { status: this.status },
      );
    }
    this.startIdleTimer();
  }

  // --- Termination / cleanup -------------------------------------------------------

  /**
   * Idempotent, guaranteed-cleanup teardown. Safe from any status, any number of
   * times, concurrently — once `"dead"`, further calls no-op; a call already in
   * flight is shared via `terminatePromise` rather than run twice.
   *
   * Every step below is best-effort and independently wrapped: one failure never
   * blocks the next.
   *
   * A debuggee caught (`waitForDebuggee()`) but never `attach()`ed (status
   * `"caught"`, e.g. idle timer fired first) is still correctly terminated:
   * `doTerminate()` does a best-effort internal `attach()` first so
   * `terminateDebuggee()` has something to act on, instead of throwing
   * `NOT_CONNECTED` and leaving the debuggee suspended and holding a work process.
   */
  async terminate(
    reason: DebugDeathReason = "terminated_by_caller",
    detail?: string,
    evidence?: DebugTerminationEvidence,
  ): Promise<void> {
    if (this.status === "dead") return;
    if (!this.terminatePromise) {
      // Reset in a `finally` so a cleanup that somehow still misbehaves cannot
      // leave every later terminate()/cleanup()/start awaiting a dead promise.
      // Concurrent callers already hold this same reference, so in-flight
      // dedupe is unaffected.
      this.terminatePromise = this.doTerminate(reason, detail, evidence).finally(() => {
        this.terminatePromise = undefined;
      });
    }
    return this.terminatePromise;
  }

  /** Alias for `terminate()`, intended for a process-exit / shutdown-hook context — same guaranteed-cleanup contract. */
  async cleanup(): Promise<void> {
    await this.terminate();
  }

  /** Pure `(reason, detail, evidence) -> DebugTerminationResult` mapping — see `DebugTerminationResult`'s doc comment. Uses no `this` state except `idleTimeoutMs`. */
  private buildTerminationResult(
    reason: DebugDeathReason,
    detail: string | undefined,
    evidence: DebugTerminationEvidence | undefined,
  ): DebugTerminationResult {
    switch (reason) {
      case "idle_timeout":
        return { kind: "idle_timeout", thresholdMs: this.idleTimeoutMs, detail };
      case "terminated_by_caller":
        return { kind: "terminated_by_caller", detail };
      case "debuggee_finished":
        if (evidence?.exceptionClassNames?.length) {
          return {
            kind: "exception",
            exceptionClassNames: evidence.exceptionClassNames,
            bodyExcerpt: evidence.bodyExcerpt,
            detail,
          };
        }
        if (evidence) {
          // Signal A fired (something WAS thrown), but the thrown error carried no
          // exception class name — the undocumented "fourth shape".
          return { kind: "session_ended", bodyExcerpt: evidence.bodyExcerpt, detail };
        }
        // No evidence object at all means nothing was thrown — this is Signal B
        // (isSteppingPossible/isTerminationPossible reported false). The ONLY path
        // entitled to say "finished".
        return { kind: "finished", detail };
      case "conflict":
      case "no_debuggee":
        // No call site in this module produces either value; kept mapped rather than
        // removed from the still-exported DebugDeathReason enum.
        return { kind: "session_ended", detail };
    }
  }

  private async doTerminate(
    reason: DebugDeathReason,
    detail?: string,
    evidence?: DebugTerminationEvidence,
  ): Promise<void> {
    // `settleWithin()` never cancels/aborts `terminationSteps()` when the deadline
    // wins, raising a concern that its `stopListener()` DELETE could strand the
    // session lock past the point terminate() returns — measured not to happen in
    // the listener-self-stopping case (see archive); the suspended-debuggee variant
    // (a real breakpoint hit during terminate) was not tested, flagged as an open gap.
    //
    // FIRST, outside the deadlined sequence: a purely local abort of any outstanding
    // listener poll (no request, see `abortListener()`), so it still runs even when
    // the whole sequence below blows its deadline and gets abandoned — otherwise the
    // socket would sit open for the full ~360s server timeout.
    this.abortListener(`terminate (${reason})`);
    try {
      const whole = await settleWithin(this.terminationSteps(), TERMINATE_TOTAL_DEADLINE_MS);
      if (!whole.ok && whole.reason === "timeout") {
        this.log(
          `[debug-session] terminate: cleanup did not finish within ${TERMINATE_TOTAL_DEADLINE_MS}ms — finalising ` +
            `the session anyway; any still-running SAP call is abandoned.`,
        );
      } else if (!whole.ok) {
        this.log(`[debug-session] terminate: cleanup threw: ${describeUnknownError(whole.error)}`);
      }
    } finally {
      // Always runs, even if every step above timed out — the only thing that
      // clears the idle timer, drops the debuggee handle, and de-registers the session.
      this.clearIdleTimer();
      this.listenHandle = undefined;
      this.debuggeeId = undefined;
      this.deathReason = reason;
      this.deathDetail = detail;
      this.terminationResult = this.buildTerminationResult(reason, detail, evidence);
      this.status = "dead";
      activeSessions.delete(this);
      // LAST — after the session is dead and de-registered, so the slot is handed
      // back only once nothing can still issue a request on it. Guarded because a
      // throwing injected lease must not turn a finished teardown into a failure;
      // `PoolSlot.release()` is already idempotent.
      try {
        this.sessionLease?.release();
      } catch (e) {
        this.log(`[debug-session] terminate: releasing the pool lease threw: ${describeUnknownError(e)}`);
      }
      // Cross-process half of the same handover — another process may now arm.
      this.releaseArmLock(`terminate: ${reason}`);
    }
  }

  /** The best-effort network half of `doTerminate()`. Never throws; every step is individually deadlined. */
  private async terminationSteps(): Promise<void> {
    // Status alone isn't enough: `waitForDebuggee()` can leave a caught debuggee's id
    // behind on a session gone back to `"idle"`, and skipping termination there
    // strands a dialog work process.
    const mayHoldDebuggee =
      this.status === "suspended" || this.status === "caught" || this.debuggeeId !== undefined;
    if (mayHoldDebuggee) {
      if (this.status !== "suspended" && this.debuggeeId) {
        // Never actually attached — terminateDebuggee() acts on whatever THIS
        // connection is attached to (nothing, right now), so it would throw
        // NOT_CONNECTED despite the debuggee being alive and suspended. Best-effort
        // attach first; failure is logged and swallowed either way, since
        // terminateDebuggee() is attempted below regardless.
        const debuggeeId = this.debuggeeId;
        this.noteStatefulRequest("shutdown attach-before-terminate");
        await this.terminateStep(
          "attach-before-terminate (never attached)",
          () =>
            this.client.attach({
              debuggeeId,
              debuggingMode: this.context.debuggingMode,
              requestUser: this.context.requestUser,
            }),
          // Same discriminator `attach()` recovers on: "Debuggee already attached"
          // means this connection IS attached, i.e. this step got what it wanted.
          // Not a cleanup failure and not worth a log line.
          isDoubleAttachError,
        );
      }
      // NOT_CONNECTED here just means "already gone" — not worth a scary log. The
      // success-shaped HTTP 500 terminateDebuggee() returns is unwrapped by the
      // client, so it never reaches this error path.
      this.noteStatefulRequest("shutdown terminateDebuggee");
      await this.terminateStep(
        "terminateDebuggee",
        () => this.client.terminateDebuggee(),
        (e) => isAbapError(e) && e.code === "NOT_CONNECTED",
      );
    }

    // Deliberately tears down an outstanding poll (local abort above, plus this
    // stopListener DELETE) — not guarded against a concurrent `waitForDebuggee()`,
    // only recorded, so a racing empty poll body is reported `blocked` not `timeout`.
    this.noteStatefulRequest("shutdown stopListener");
    await this.terminateStep("stopListener", () => this.client.stopListener(this.listenerParams()));

    // Scoped strictly to what THIS session armed — see `deleteOwnedBreakpoints()`
    // for why the unscoped syncScope full-sync this replaced was dangerous.
    await this.deleteOwnedBreakpoints();
  }

  /** One deadlined, best-effort cleanup call. Never throws: a step that fails or hangs past `TERMINATE_STEP_DEADLINE_MS` is logged and the sequence moves on. */
  private async terminateStep(
    op: string,
    run: () => Promise<unknown>,
    isExpectedFailure?: (e: unknown) => boolean,
  ): Promise<void> {
    let started: Promise<unknown>;
    try {
      started = run();
    } catch (e) {
      started = Promise.reject(e);
    }
    const settled = await settleWithin(started, TERMINATE_STEP_DEADLINE_MS);
    if (settled.ok) return;
    if (settled.reason === "timeout") {
      this.log(
        `[debug-session] terminate: ${op} did not return within ${TERMINATE_STEP_DEADLINE_MS}ms during cleanup — ` +
          `abandoning it and continuing.`,
      );
      // Same fact as the log line above, kept for `snapshot` — see `abandonedCleanupSteps`.
      this.abandonedCleanupSteps.push(op);
      return;
    }
    if (isExpectedFailure?.(settled.error)) return;
    this.log(`[debug-session] terminate: ${op} failed during cleanup: ${describeUnknownError(settled.error)}`);
  }
}

// Live wiring — not used by offline tests, only by real callers and live verification.

export interface CreateDebugClientOptions {
  /** Forwarded to the long-poll client's server-side `timeout` query param. Default 60. */
  listenTimeoutSeconds?: number;
  /**
   * The process-wide `SafetyGate` (`src/safety.ts`), forwarded verbatim to
   * `DebugTransport` so every mutating debugger request (POST/PUT/DELETE)
   * passes the same gate the tool layer already asked. A backstop, not a
   * second policy — the caller must hand over the SAME instance `server.ts`
   * built. Required: optional would just move the "no gate" hole to
   * `undefined`; `DebugTransport`'s own coarser `readOnly` check does not
   * substitute for this.
   */
  safety: SafetyGate;
  /**
   * The object the session is armed against; unlocks object-scoped rules
   * (package/namespace/name-prefix) at the transport layer. Held by
   * reference for the transport's whole life, so a caller that narrows its
   * target later refines this object in place rather than replacing it.
   */
  target?: SafetyTarget;
}

/**
 * Builds a real, network-backed `DebugClient` from a live `AbapConnection`,
 * wiring `DebugTransport` + `DebugLongPollClient` (./transport.js) together.
 */
export function createDebugClientForConnection(conn: AbapConnection, opts: CreateDebugClientOptions): DebugClient {
  // `opts.safety` is required, not optional — an optional `opts` would let a
  // caller skip the mutation-safety check entirely (previously dead code in
  // production; see the git history).
  const transport = new DebugTransport(conn, { safety: opts.safety, target: opts.target });
  // Cookie-rotation overlay: AbapConnection exposes no cookie-jar setter, so a
  // SAP_SESSIONID rotated by the long-poll's CSRF-refresh HEAD is tracked here
  // and re-applied on every read (else: stale cookie + new token -> permanent
  // 403). Each entry is dropped once the connection's own cookie value for
  // that name moves past the `base` recorded at rotation time, so a fresh
  // re-login jar always wins over a stale overlay entry.
  const rotatedCookies = new Map<string, { pair: string; base: string | undefined }>();
  /** Parse a `Cookie:` request header (`name=value; name=value`) into name -> value. */
  const parseCookieHeader = (header: string): Map<string, string> => {
    const jar = new Map<string, string>();
    for (const pair of (header || "").split(";")) {
      const trimmed = pair.trim();
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      jar.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
    }
    return jar;
  };
  // The long-poll's raw node:https bypasses GuardedHttpClient, so TLS
  // policy must be wired explicitly here — same cfg.insecure and the same
  // buildInsecureHttpsAgent (src/adt/http-guard.ts) the ADT/axios stack uses,
  // so the two cannot silently disagree; see test/tls-policy-agreement.test.ts.
  const httpsAgent = buildInsecureHttpsAgent(conn.cfg.insecure);
  const longPoll = new DebugLongPollClient({
    baseUrl: conn.cfg.url,
    breaker: conn.breaker,
    httpsAgent,
    // Deliberately a no-op (ACQUIRE_NO_SESSION_LEASE), not a second
    // `pool.reserveDebug(...)` — the outer `sessionLease` already covers this
    // whole window. A second reserveDebug here would self-deadlock
    // (DEBUG_CONCURRENCY=1) at arm time on a real listen, which offline tests
    // never exercise. Do not wire this to a second reserveDebug; see
    // the git history for the full reasoning.
    auth: {
      acquireSession: ACQUIRE_NO_SESSION_LEASE,
      cookieHeader: () => {
        const own = conn.cookies();
        if (rotatedCookies.size === 0) return own;
        const current = parseCookieHeader(own);
        for (const [name, entry] of [...rotatedCookies]) {
          if (current.get(name) !== entry.base) rotatedCookies.delete(name);
        }
        if (rotatedCookies.size === 0) return own;
        return mergeCookieHeader(own, [...rotatedCookies.values()].map((e) => e.pair));
      },
      csrfToken: () => conn.csrfToken(),
      updateCookies: (setCookieHeader) => {
        const current = parseCookieHeader(conn.cookies());
        for (const entry of Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader]) {
          const first = entry.split(";")[0]?.trim();
          if (!first) continue;
          const eq = first.indexOf("=");
          if (eq <= 0) continue;
          const name = first.slice(0, eq).trim();
          rotatedCookies.set(name, { pair: first, base: current.get(name) });
        }
      },
    },
    listenTimeoutMs: (opts?.listenTimeoutSeconds ?? 60) * 1000,
  });
  return new DebugClient({ transport, longPoll });
}

// Shutdown-hook registry: hooks into the existing MCP server shutdown path
// (src/server.ts's stop()) rather than building a rival one. An orphaned
// suspended debuggee holds a work process hostage on a 7-work-process
// appliance, so every live `DebugSession` must stay reachable from here until
// it reaches status "dead".

const activeSessions = new Set<DebugSession>();

/** Every `DebugSession` registers itself here at construction and removes itself once it reaches status `"dead"`. */
export function listActiveDebugSessions(): readonly DebugSession[] {
  return [...activeSessions];
}

/**
 * Removes `session` from the registry unconditionally, whether or not it
 * ever reached status `"dead"`. Last-resort escape hatch: `listActiveDebugSessions()`
 * feeds `src/tools/debug.ts`'s one-session-per-process `start` guard, so a
 * session stuck in this Set can refuse every future `start` forever.
 * `handleStop` only reaches for this after giving `terminate()` a real
 * bounded chance to finish, and only on explicit `force:true` — it does NOT
 * confirm the SAP-side listener/debuggee was released; `terminate()`'s
 * network sequence may still be running in the background after this
 * returns. See the git history for the full
 * reasoning (ties to the TERMINATE_STEP/TOTAL_DEADLINE_MS invariant above).
 *
 * Returns whether `session` was actually still registered.
 */
export function forceDropDebugSession(session: DebugSession): boolean {
  return activeSessions.delete(session);
}

/**
 * Calls `cleanup()` on every still-registered session, all in parallel,
 * swallowing individual failures (logs them, never throws). Call this from
 * the existing MCP server shutdown path BEFORE the underlying
 * `AbapConnection` itself shuts down.
 */
export async function shutdownAllDebugSessions(log?: (msg: string) => void): Promise<void> {
  const sessions = [...activeSessions];
  await Promise.all(
    sessions.map((s) =>
      s.cleanup().catch((e) => {
        (log ?? (() => {}))(`[debug-session] shutdown cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
      }),
    ),
  );
}
