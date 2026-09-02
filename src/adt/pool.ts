/**
 * ADT session pool — bounded set of `AbapConnection` slots, leased one operation at a time.
 *
 * WIRED IN: `src/server.ts` builds one `AdtSessionPool` and routes every tool handler through
 * `withRead`/`withWrite`/`reserveDebug`; `pool.primary()` replaces every pre-pool connection
 * reference. `test/pool-characterization.test.ts` freezes the wire-level (method, path,
 * session-id, stateful-flag) sequence each tool produces via a real `createServer()` — that is
 * the safety net for this file, not "this module isn't imported".
 *
 * Slot 0 is built eagerly in the constructor; further slots are minted lazily, up to
 * `maxSessions` (default 5 = readConcurrency 2 + writeConcurrency 2 + 1 debug lease).
 *
 * Invariants (full reasoning and measurements: the git history):
 *  L1 `PoolSlot.release()` is void and idempotent — ADT's `unLock` answers 200 regardless of
 *     whether anything was released, so no honest success boolean exists.
 *  L2 No confirmation round-trips or health probes, ever — a request behind an open long poll
 *     head-of-line blocks for the rest of it (measured ~55-115s). A slot is healthy until one
 *     of its own requests fails.
 *  L3 One `AuthCircuitBreaker`, shared by every slot (`login/fails_to_user_lock` is per-user,
 *     not per-session) — enforced structurally in `mintConnection`.
 *  L4 No second lock registry — `StatefulSession` (session.ts) is the only place that can tell
 *     "I already hold this" from "somebody else holds this" (both answer 403 the same way).
 *  L5 The pool persists nothing; cross-process coordination is the injectable `ObjectGate`
 *     (default `FileLockObjectGate`), never pool state.
 *  L6 A slot is dead only when `conn.isDead`/`onDead` says so, latched once into `slot.dead`.
 *
 * Roles: "read" (no enqueue, incl. `abap_run` — resets shared CSRF token, never shares a slot
 * with an open lock), "write" (LOCK -> modify -> UNLOCK, serialised per object URI via
 * `ObjectGate`), "debug" (long poll lease, capped at `DEBUG_CONCURRENCY`, never queues).
 *
 * Idle eviction runs at release/checkout, never on a timer; the pinned primary slot is exempt.
 */
import type { Config } from "../config.js";
import { resolveStateDir } from "../state-dir.js";
import { AbapConnection, type ConnectionOptions } from "./connection.js";
import type { AuthCircuitBreaker } from "./circuit-breaker.js";
import { AbapError, isAbapError, describeUnknownError } from "./errors.js";
import { CONNECT_FAILURE_REASONS, type ConnectFailureReason } from "./connect-failure.js";
import { objectUriOf } from "./session.js";
import { SessionBusyError, type SessionBusyReason } from "./session-lock.js";
import {
  type ObjectGate,
  InProcessObjectGate,
  NoopObjectGate,
  FileLockObjectGate,
  objectGateLockPath,
  resolveCrossProcessObjectLock,
} from "./object-gate.js";

// Re-exported so existing import sites keep resolving these from pool.js.
export type { ObjectGate };
export { InProcessObjectGate, NoopObjectGate, FileLockObjectGate, objectGateLockPath };

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type SlotRole = "read" | "write" | "debug";

/**
 * A lease on one pooled connection.
 *
 * `release()` returns `void` and is idempotent — see L1 in the module header.
 * It is safe (and expected) to call it from a `finally`, twice, or after the
 * pool has been shut down.
 */
export interface PoolSlot {
  readonly conn: AbapConnection;
  readonly role: SlotRole;
  readonly id: number;
  release(): void;
}

export interface PoolStats {
  /** Every slot the pool is holding, live or awaiting retirement. */
  total: number;
  /** Slots currently leased. */
  busy: number;
  /** Live slots available right now. */
  idle: number;
  /** Callers parked in the FIFO queue. */
  waiting: number;
  /** Slots known dead (a request on them threw `SESSION_DEAD`) not yet dropped. */
  dead: number;
}

export interface SessionPool {
  /** Run `fn` on a read-role slot. See "ROLE SEMANTICS" — `abap_run` is a READ. */
  withRead<T>(op: string, fn: (conn: AbapConnection) => Promise<T>): Promise<T>;
  /**
   * Run `fn` on a write-role slot, routed through the {@link ObjectGate} on its object URI
   * (default gate serialises same-object writes; `cfg.serialiseSameObjectWrites: false` opts
   * out via {@link NoopObjectGate}). Pass `undefined` for `objectUri` only for writes with no
   * single object (e.g. package-level) — such a call takes a slot but no gate.
   */
  withWrite<T>(
    op: string,
    objectUri: string | undefined,
    fn: (conn: AbapConnection) => Promise<T>,
  ): Promise<T>;
  /**
   * Reserve a slot for the debugger long poll. Caller owns the returned lease and must
   * `release()` it. Never queues. Throws `UNSUPPORTED` when `cfg.debugDiaBudget` is below
   * `DIA_COST_PER_DEBUG_SESSION`.
   */
  reserveDebug(op: string): Promise<PoolSlot>;
  /**
   * The pinned slot-0 connection, always present, never evicted — the handle for everything
   * not (yet) pooled (`connect()`, `info()`, discovery). Survives `shutdown()`/`dispose()`.
   *
   * RE-POINTED WHEN SLOT 0 IS RETIRED — never cache it, read `primary()` at point of use. A
   * prior version promised a process-lifetime-stable reference; that was the bug, since
   * `AbapConnection`'s logon-endpoint ceiling is a lifetime count that never resets, so an
   * immortal primary bricks permanently on its 6th revival. `primary()` re-seats onto a slot
   * in `this.slots` so the primary always counts against `maxSessions`.
   *
   * Prefers an idle session; falls back to the warmest busy one only when the cap is reached
   * and every slot is busy (the steady state at `maxSessions = 1`) — so the returned
   * connection MAY have a request in flight on it. Callers needing exclusivity must take a
   * lease (`withRead`/`withWrite`/`reserveDebug`) instead.
   */
  primary(): AbapConnection;
  /**
   * Mint a connection that shares the pool's process-wide breaker but is NOT a pool slot — no
   * lease, no DIA accounting, caller-owned lifecycle. One caller: the debugger's trigger
   * connection (see `AdtSessionPool.createUnpooledConnection`).
   */
  createUnpooledConnection(purpose: string): AbapConnection;
  stats(): PoolStats;
  /** Best-effort, awaited: drop every pooled session. Never throws. */
  shutdown(reason: string): Promise<void>;
  /** Sync teardown, mirroring `AbapConnection.dispose()`. Never throws. */
  dispose(): void;
}

/** Constructs a connection. Injectable so tests can drive the pool with no HTTP. */
export type ConnectionFactory = (cfg: Config, opts: ConnectionOptions) => AbapConnection;

export interface SessionPoolOptions {
  cfg: Config;
  /**
   * The process-wide auth circuit breaker, required. Taken as an argument (rather than
   * adopted from the first connection built) so L3 can refuse slot 0 exactly like every other
   * slot — see {@link AdtSessionPool.sharedBreaker}. Produced by {@link
   * AuthCircuitBreaker.forConfig} at the composition root.
   */
  breaker: AuthCircuitBreaker;
  /**
   * Testability seam. Defaults to `new AbapConnection(cfg, opts)`. Must honour `opts.breaker`
   * (L3 refuses the connection otherwise) and must NOT connect — see `prepareConnection`.
   */
  createConnection?: ConnectionFactory;
  /**
   * Called at most once per slot, lazily, before that slot is first handed out — the seam for
   * `conn.connect()`. Kept separate from `createConnection` so construction stays synchronous
   * (needed for `primary()` to be total). A rejection retires the slot as dead.
   *
   * `isPrimary` is passed rather than looked up via `primary()` because `primary()` re-seats
   * as a side effect of being called — asking it here could re-point the pin onto the very
   * slot being prepared and skip the `connect()` it needed.
   */
  prepareConnection?: (
    conn: AbapConnection,
    role: SlotRole,
    isPrimary: boolean,
  ) => Promise<void>;
  /**
   * An explicit value always wins. Otherwise: `cfg.serialiseSameObjectWrites === false`
   * installs {@link NoopObjectGate} (opts out entirely); else `ABAP_CROSS_PROCESS_OBJECT_LOCK
   * =false` installs {@link InProcessObjectGate} (same-process only); else the default is
   * {@link FileLockObjectGate} over `resolveStateDir(process.env)`, serialising same-object
   * writes both in-process and across abapsmith processes.
   */
  gate?: ObjectGate;
  /** Max parked waiters before acquisition fails `queue-full`. Default 8. */
  maxQueue?: number;
  /** Injectable clock. Default `Date.now`. */
  now?: () => number;
  /** Injectable timer. Default `setTimeout` with the handle `unref()`ed (I4). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Diagnostics sink. Defaults to a NO-OP: stdout is the MCP stream. */
  log?: (msg: string) => void;
}

/** Same default as `SessionLock`'s queue bound — one vocabulary, one number. */
export const DEFAULT_POOL_MAX_QUEUE = 8;

/** Concurrent debug leases. Fixed at 1 — a second concurrent long poll is a bug, not a tuning opportunity. */
export const DEBUG_CONCURRENCY = 1;

/**
 * DIA work processes one debug session is assumed to pin: 1 for the suspended debuggee
 * (measured live) + 1 for the blocked trigger connection (inferred, kept as an over-estimate).
 * A local a-priori ceiling, never a probe — runtime DIA occupancy is unobservable on this
 * appliance (`/sap/bc/adt/runtime/workprocesses` 405s; `TH_USER_INFO.act_sessions` under-reported
 * live). See archive for the measurement detail.
 */
export const DIA_COST_PER_DEBUG_SESSION = 2;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface InternalSlot {
  readonly id: number;
  readonly conn: AbapConnection;
  /**
   * The primary's slot; never evicted for idleness. Exactly one slot carries it. Not
   * `readonly`: {@link AdtSessionPool.seatPrimary} moves the pin when the pinned slot retires.
   */
  pinned: boolean;
  /** Memoised `prepareConnection` result. Runs at most once per slot. */
  prepared: Promise<void> | undefined;
  /**
   * `prepareConnection` is in flight — leased but not yet usable. Distinct from `busy` (true
   * for the whole lease). {@link AdtSessionPool.seatPrimary}'s last-resort tier must skip these
   * slots or it would publish a half-built session through `primary()`.
   */
  preparing: boolean;
  busy: boolean;
  /**
   * A request threw `SESSION_DEAD`, or `conn.isDead` went true — learned, never probed (L2).
   * Read through {@link AdtSessionPool.isSlotDead}, never directly.
   */
  dead: boolean;
  /** `conn.onDead()` unsubscribe, when the connection supports it (L6). */
  unsubscribeDead: (() => void) | undefined;
  /**
   * `release()` of the lease currently outstanding, or `undefined` when idle. The pool's only
   * handle on a lease it did not hand to `runOn`'s `finally` — i.e. a debug lease (L6).
   */
  activeRelease: (() => void) | undefined;
  /** Role of the current lease (or of the last one, when idle). */
  role: SlotRole;
  /** Op label of the current lease, for `SessionBusyError.holder`. */
  op: string;
  /** When the current lease started. */
  leasedAt: number;
  lastReleasedAt: number;
}

interface Waiter {
  readonly role: SlotRole;
  readonly op: string;
  settled: boolean;
  timer: unknown;
  resolve(slot: InternalSlot): void;
  reject(err: unknown): void;
}

function poolClosedError(what: string): AbapError {
  return new AbapError(
    "NOT_CONNECTED",
    `The ABAP session pool has been shut down; ${what} cannot be served.`,
    { operation: what, reason: "pool-closed" },
    "This is a lifecycle error, not a SAP one — the process is shutting down.",
  );
}

/**
 * True for the error classes that prove a slot must not be trusted again (L2): the explicit
 * `SESSION_DEAD` classification, or `connection.ts`'s `refuseCsrfRecoveryInStatefulSession`
 * (`ADT_ERROR` / `reason: "csrf-stale-in-stateful-session"`) — a stale-CSRF refusal on a
 * connection that held a stateful session. Both are routed through the same
 * `eligibleForDeadSlotReplay` gate; the "session destroyed vs. CSRF token
 * invalidated" ambiguity is deliberately left unresolved because retiring-and-replaying under
 * that gate is correct under either reading. Full reasoning: archive.
 */
function isSessionDeadError(e: unknown): boolean {
  if (!isAbapError(e)) return false;
  if (e.code === "SESSION_DEAD") return true;
  return e.code === "ADT_ERROR" && e.details.reason === "csrf-stale-in-stateful-session";
}

/**
 * True only for `connection.ts`'s `connectionDeadError`: a `SESSION_DEAD`
 * `AbapError` that also carries `details.condemned === true`.
 *
 * `isSessionDeadError` answers "must this slot be retired?" (yes, for any `SESSION_DEAD`
 * shape). This predicate answers a narrower question: "does this error prove the caller's own
 * operation was applied?" — and for `connectionDeadError` specifically, it does not, because
 * that error is synthesized from `AbapConnection.death`, i.e. it is evidence about the
 * connection in general, not about the failing request.
 *
 * Provably always means "died mid-operation" here, never "inherited already dead": `acquire()`
 * never hands back an already-dead slot (see its own doc), and `this.death` is cleared in
 * exactly one place — a successful logon. So a `connectionDeadError` thrown from inside `fn`
 * was recorded during THIS call, possibly after part of `fn`'s work already landed (the hazard:
 * a write succeeds, a later UNLOCK in the same call discovers the session is gone, and
 * JS `finally` semantics replace the already-successful return with the throw). Replaying would
 * risk a duplicate mutation, so `eligibleForDeadSlotReplay` refuses it unconditionally for
 * writes. See archive for the full proof and scope note.
 */
function isCondemnedConnectionError(e: unknown): boolean {
  return isAbapError(e) && e.code === "SESSION_DEAD" && e.details.condemned === true;
}

/**
 * Conservative cutoff for "this `SESSION_DEAD` arrived too fast to be a real round trip" —
 * see `eligibleForDeadSlotReplay`. Chosen from measured victim latencies
 * (160-224ms) vs. real-work latencies (686-2540ms) on the same appliance/object types; 500ms
 * sits in the middle with margin both ways. A heuristic over one appliance's captured shape,
 * not a proven bound — see archive. Only gates WRITE replay; reads never consult it.
 */
const DEAD_ON_ARRIVAL_MS = 500;

/**
 * True for failures that are a property of the credentials or shared circuit breaker rather
 * than of any one session — these must not cause `acquire()` to retire-and-retry, which would
 * spend another logon against the shared `login/fails_to_user_lock` counter for nothing.
 */
function isAuthClassError(e: unknown): boolean {
  return (
    isAbapError(e) &&
    (e.code === "AUTH_FAILED" ||
      e.code === "AUTH_CIRCUIT_OPEN" ||
      e.code === "CIRCUIT_OPEN_TRANSIENT")
  );
}

/**
 * True for a `connect()` failure classified as the system being down or unreachable
 * (`SYSTEM_UNAVAILABLE` / `CONNECT_FAILED`) — belongs on the same `acquire()` exit
 * as `isAuthClassError` (release without retiring, no retry loop), since hammering an
 * unreachable system with same-deadline retries is exactly as wrong as retrying a bad
 * password. Before these codes were split out, every connect failure surfaced as `AUTH_FAILED`
 * and got this treatment by accident of the old mislabelling; this predicate keeps it correct
 * now that the codes are distinct. Keyed on `CONNECT_FAILURE_REASONS`
 * (`src/adt/connect-failure.ts`) rather than repeating literals, so the two files cannot drift.
 */
function isConnectFailureClassError(e: unknown): boolean {
  return (
    isAbapError(e) &&
    (e.code === "SYSTEM_UNAVAILABLE" || e.code === "CONNECT_FAILED") &&
    typeof e.details.reason === "string" &&
    CONNECT_FAILURE_REASONS.has(e.details.reason as ConnectFailureReason)
  );
}

/**
 * Opt-in slot-lifecycle timing, behind `ABAP_TIMING_DEBUG` (the pool half of the flag
 * `connection.ts` documents). Answers "whose call pays for a minted session": `prepare()` runs
 * inside `acquire()` inside the tool call, so whichever caller mints a slot pays a whole
 * `connect()` inside its own measured window while every other caller pays none.
 */
function timingDebugEnabled(): boolean {
  const v = process.env.ABAP_TIMING_DEBUG;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Hard bound on preparation attempts within one `acquire()` — an ITERATION bound, not a time
 * one. `cfg.sessionWaitMs` only bounds the wall clock while the clock advances between
 * attempts; a `prepareConnection` that rejects in under a millisecond would otherwise spin
 * `for (;;)`, minting a fresh connection and logon every iteration against the shared
 * `login/fails_to_user_lock` counter. Set to 4 (above the 3 attempts the absolute-deadline
 * path normally exercises) so `sessionWaitMs` stays the binding bound in ordinary operation.
 */
const MAX_PREPARE_ATTEMPTS = 4;

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

export class AdtSessionPool implements SessionPool {
  private readonly cfg: Config;
  private readonly factory: ConnectionFactory;
  private readonly prepareFn: SessionPoolOptions["prepareConnection"];
  private readonly gate: ObjectGate;
  private readonly maxQueue: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly log: (msg: string) => void;
  /**
   * Whether `log` was supplied. Only then is it forwarded to constructed
   * connections: passing the pool's own no-op default through would SILENCE
   * `AbapConnection`'s stderr diagnostics — including the breaker-tripped line
   * — which nobody asked for.
   */
  private readonly forwardLog: boolean;

  private readonly slots: InternalSlot[] = [];
  private readonly waiters: Waiter[] = [];
  private nextId = 0;
  private closed = false;

  /**
   * L3. Supplied by the caller ({@link SessionPoolOptions.breaker}) and passed to every
   * construction, slot 0 included — a prior version adopted the breaker from slot 0's own
   * connection instead, which made the pinned slot the one L3 could structurally never refuse.
   *
   * Last line of defence against locking the SAP user out: `login/fails_to_user_lock` counts
   * failed logons per user (not per session) and locks the account at the fifth, so a
   * per-connection breaker would let each slot burn its own first failure and lock the account
   * faster. `mintConnection` enforces this by refusing any connection carrying a different
   * breaker instance — do not weaken that refusal or bypass `mintConnection`.
   */
  private readonly sharedBreaker: AuthCircuitBreaker;

  /**
   * The pinned slot's connection. Held separately so `primary()` survives `dispose()` (which
   * empties `slots` but retires nothing). Re-pointed by {@link AdtSessionPool.seatPrimary}.
   */
  private primaryConn: AbapConnection;

  constructor(opts: SessionPoolOptions) {
    this.cfg = opts.cfg;
    // Set before `createSlot(true)` below: slot 0 must be constructed WITH the shared breaker.
    this.sharedBreaker = opts.breaker;
    this.factory = opts.createConnection ?? ((cfg, o) => new AbapConnection(cfg, o));
    this.prepareFn = opts.prepareConnection;
    // An explicit gate always wins. Otherwise: serialiseSameObjectWrites===false ->
    // NoopObjectGate (opt out entirely); else ABAP_CROSS_PROCESS_OBJECT_LOCK=false ->
    // InProcessObjectGate (same-process only); else FileLockObjectGate (the shipped default),
    // serialising same-object writes across abapsmith processes too. The `??` fallback to
    // resolveCrossProcessObjectLock() only matters for a partial `Config` test double; a real
    // parsed `Config` always supplies the boolean.
    this.gate =
      opts.gate ??
      (opts.cfg.serialiseSameObjectWrites === false
        ? new NoopObjectGate()
        : (opts.cfg.crossProcessObjectLock ?? resolveCrossProcessObjectLock()) === false
          ? new InProcessObjectGate()
          : new FileLockObjectGate({
              stateDir: resolveStateDir(process.env),
              waitMs: opts.cfg.objectLockWaitMs,
            }));
    this.maxQueue = Math.max(0, opts.maxQueue ?? DEFAULT_POOL_MAX_QUEUE);
    this.now = opts.now ?? (() => Date.now());
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const h = setTimeout(fn, ms);
        h.unref?.();
        return h;
      });
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.log = opts.log ?? (() => undefined);
    this.forwardLog = opts.log !== undefined;

    // Eager, synchronous, exactly one. Tools driven one at a time (never concurrently) always
    // find idle slot 0 in `tryTake` first, so nothing new gets built regardless of maxSessions.
    const primary = this.createSlot(true);
    this.slots.push(primary);
    this.primaryConn = primary.conn;
  }

  // ------------------------------------------------------------- creation ---

  /**
   * The shared-breaker contract, shared by `createSlot` and `createUnpooledConnection` so the
   * two paths cannot drift. `operation` only labels the L3 refusal.
   */
  private mintConnection(operation: string): AbapConnection {
    const connOpts: ConnectionOptions = { breaker: this.sharedBreaker };
    if (this.forwardLog) connOpts.log = this.log;

    const conn = this.factory(this.cfg, connOpts);

    // Checked for the first construction exactly like the hundredth — no adopt-if-unset branch.
    if (conn.breaker !== this.sharedBreaker) {
      // Structural, not advisory: a per-slot breaker would let N slots each burn their own
      // first failed logon against the one shared `login/fails_to_user_lock` counter.
      throw new AbapError(
        "NOT_CONNECTED",
        "Session pool refused a connection that does not share the process-wide auth circuit breaker.",
        { operation, reason: "breaker-not-shared" },
        "The connection factory must pass ConnectionOptions.breaker through to " +
          "AbapConnection unchanged. One SAP user means one fails_to_user_lock " +
          "counter, so the pool must have exactly one breaker.",
      );
    }
    return conn;
  }

  /** The only place a pooled connection is constructed; delegates the L3 check to {@link mintConnection}. */
  private createSlot(pinned: boolean): InternalSlot {
    const conn = this.mintConnection("pool.createSlot");

    const at = this.now();
    const slot: InternalSlot = {
      id: this.nextId++,
      conn,
      pinned,
      prepared: undefined,
      preparing: false,
      busy: false,
      dead: false,
      unsubscribeDead: undefined,
      activeRelease: undefined,
      role: "read",
      op: "(idle)",
      leasedAt: at,
      lastReleasedAt: at,
    };

    // L6: learn the death the connection already knows, at the moment it knows it — no probe.
    // Guarded by `typeof`: `createConnection` is a public seam a test double need not implement.
    if (typeof conn.onDead === "function") {
      slot.unsubscribeDead = conn.onDead(() => this.onSlotConnectionDied(slot));
    }
    return slot;
  }

  /**
   * A connection that shares the pool's breaker but is NOT a pool slot: no id, no slot record,
   * no `onDead` subscription, no DIA accounting, no lease. Caller owns its whole lifecycle.
   *
   * Exists for one caller — the debugger's trigger connection (`src/tools/debug.ts`), which
   * deliberately carries a SEPARATE ADT session from the leased slot the listener long-polls
   * on and is already counted as the second DIA in `DIA_COST_PER_DEBUG_SESSION`; pooling it
   * would double-count and could consume the only debug lease. Routing it through
   * `mintConnection` (rather than the caller constructing its own `AbapConnection`) is what
   * makes breaker-sharing structural instead of a property someone has to remember to pass.
   */
  createUnpooledConnection(purpose: string): AbapConnection {
    return this.mintConnection(`pool.createUnpooledConnection(${purpose})`);
  }

  /**
   * `conn.onDead` fired. Runs synchronously inside `markDead()`, inside the response handling
   * of whatever request killed the session — must stay allocation-cheap and never throw back.
   */
  private onSlotConnectionDied(slot: InternalSlot): void {
    if (slot.dead) return;
    slot.dead = true;

    if (!slot.busy) {
      this.dropSlot(slot, "connection reported dead while idle");
      // Belt and braces, not load-bearing today (a parked waiter implies no live idle slot was
      // available and none can have appeared since — see archive), kept for when that changes.
      this.handoff();
      return;
    }

    // A debug lease has no bounding `finally`, so nothing else will ever free this slot —
    // force it. `release()` stays idempotent (L1), so the owner calling it later is a no-op.
    if (slot.role === "debug") {
      const release = slot.activeRelease;
      slot.activeRelease = undefined;
      if (release) release();
      else this.releaseSlot(slot);
      return;
    }

    // read/write: `runOn`'s `finally` owns this lease. Yanking it now would let `inFlight()`
    // undercount and admit a second concurrent request onto a session still in flight.
  }

  // --------------------------------------------------------------- public ---

  primary(): AbapConnection {
    this.seatPrimary();
    return this.primaryConn;
  }

  /**
   * Re-seat the primary if the slot behind it has been retired. Fixes a prior bug where a
   * retired primary stayed installed and was still revivable: its logon-endpoint ceiling is a
   * lifetime count that never resets, so revival eventually bricks permanently, and the
   * retired object was invisible to `liveCount()` while `tryTake` grew a replacement, exceeding
   * `maxSessions`.
   *
   * Lazy (nothing minted until someone asks for the primary — minting inside `acquire`'s retry
   * loop would be a logon amplifier) and prefers adoption over minting (minting at the cap
   * would recreate the same violation from the other side). The pin moves with the seat.
   *
   * Three-tier seating order, since `primary()` is consumed OUTSIDE any lease (`ensureConnected`,
   * `abap_journal`'s undo path, the debugger) so an idle seat is the difference between a shared
   * session and one somebody is mid-write on:
   *  1. Warmest live IDLE slot.
   *  2. Else mint, while `liveCount() < maxSessions`.
   *  3. Else, last resort: warmest live BUSY slot (excluding `preparing` ones) — a knowingly
   *     shared session. Not new behaviour: at `maxSessions = 1` this has always been the case.
   *     Returning the retired corpse instead would revive the object this method exists to
   *     retire; throwing isn't available since `primary()` is total.
   *
   * When even tier 3 finds nothing, the old reference is deliberately left in place — bounded
   * by the in-flight leases that created that state; the next `release()`/`primary()` recovers.
   * Never throws.
   */
  private seatPrimary(): void {
    // `dispose()` empties `slots` on purpose; `primary()` must stay total across it.
    if (this.closed) return;

    // Already seated — but only if that seat is alive. `onSlotConnectionDied` deliberately
    // does not drop a busy read/write slot that dies (`runOn`'s `finally` owns that lease), so
    // a pinned slot can sit in `this.slots` as a known corpse; a dead match falls through.
    for (const s of this.slots) {
      if (s.conn !== this.primaryConn) continue;
      if (!this.isSlotDead(s)) return;
      break;
    }

    // Sweep before scanning, exactly as `tryTake` does — the pin about to be set makes its
    // slot exempt from `evictStaleIdle` forever after, so re-seating onto an already-stale
    // slot would make that staleness permanent.
    this.dropDeadIdle();
    this.evictStaleIdle();

    // Tier 1: warmest live IDLE slot.
    let seat: InternalSlot | undefined;
    for (const s of this.slots) {
      if (s.busy || this.isSlotDead(s)) continue;
      if (!seat || s.lastReleasedAt > seat.lastReleasedAt) seat = s;
    }

    // Tier 2: mint, if the cap leaves room.
    if (!seat && this.liveCount() < this.cfg.maxSessions) {
      try {
        seat = this.createSlot(true);
        this.slots.push(seat);
      } catch (e) {
        this.log(`[abapsmith] pool could not re-seat the primary: ${describeUnknownError(e)}`);
        return;
      }
    }

    // Tier 3: warmest live BUSY slot — knowingly shared. See the doc above.
    if (!seat) {
      for (const s of this.slots) {
        if (this.isSlotDead(s) || s.preparing) continue;
        if (!seat || s.lastReleasedAt > seat.lastReleasedAt) seat = s;
      }
    }

    if (!seat) return;
    // The pin MOVES, not copied — `InternalSlot.pinned` promises exactly one carrier.
    for (const s of this.slots) if (s !== seat) s.pinned = false;
    seat.pinned = true;
    this.primaryConn = seat.conn;
    // `connected`/`prepared` in the log line distinguish the two zero-wire-cost paths that
    // land here: tier 1 adopts an already-logged-on slot; tier 2 mints a pinned slot whose
    // `connect()` is deferred onto the next caller that touches the primary.
    this.log(
      `[abapsmith] pool re-seated the primary onto slot ${seat.id}` +
        (timingDebugEnabled()
          ? ` (connected=${seat.conn.isConnected} prepared=${seat.prepared !== undefined}).`
          : "."),
    );
  }

  /**
   * The one deadness question in this file (L6). The connection is the authority; `slot.dead`
   * latches it so a slot stays retired even if `conn.connect()` later revives the object.
   * Reading `isDead` is not a probe (L2 forbids asking the server, not listening).
   */
  private isSlotDead(s: InternalSlot): boolean {
    if (s.dead) return true;
    if (s.conn.isDead === true) {
      s.dead = true;
      return true;
    }
    return false;
  }

  /**
   * Busy dominates dead everywhere a slot is COUNTED (L6): death makes a slot unfit to be
   * handed out, but it does not end an outstanding lease. Skipping a dead-but-leased slot
   * would undercount `inFlight()` and let the pool admit a second concurrent request — the
   * exact failure this module exists to prevent. So `busy` counts leases regardless of
   * deadness, `idle` counts free-and-fit slots, and `dead` (every known corpse, leased or not)
   * overlaps `busy`.
   */
  stats(): PoolStats {
    let busy = 0;
    let idle = 0;
    let dead = 0;
    for (const s of this.slots) {
      const isDead = this.isSlotDead(s);
      if (isDead) dead++;
      if (s.busy) busy++;
      else if (!isDead) idle++;
    }
    return { total: this.slots.length, busy, idle, waiting: this.waiters.length, dead };
  }

  async withRead<T>(op: string, fn: (conn: AbapConnection) => Promise<T>): Promise<T> {
    return this.runOn("read", op, fn);
  }

  async withWrite<T>(
    op: string,
    objectUri: string | undefined,
    fn: (conn: AbapConnection) => Promise<T>,
  ): Promise<T> {
    if (objectUri === undefined) return this.runOn("write", op, fn);
    // Canonicalised once, with the same `objectUriOf` (session.ts) that `StatefulSession` keys
    // its lock ledger with — two keys that disagree is the failure where the pool believes two
    // operations target different objects and SAP's enqueue table says otherwise.
    const key = objectUriOf(objectUri);
    // Gate outside slot, always: taking the slot first would deadlock at maxSessions=1 (the
    // waiter would hold the only session while blocking on a predecessor that needs one).
    return this.gate.run(key, () => this.runOn("write", op, fn));
  }

  async reserveDebug(op: string): Promise<PoolSlot> {
    // A floor check, not a multiplier: `roleLimit("debug")` stays fixed at DEBUG_CONCURRENCY=1
    // on purpose — `floor(budget / cost)` would let a raised budget buy concurrent debug leases.
    if (this.cfg.debugDiaBudget < DIA_COST_PER_DEBUG_SESSION) {
      throw new AbapError(
        "UNSUPPORTED",
        `Debugging is disabled: ABAP_DEBUG_DIA_BUDGET is ${this.cfg.debugDiaBudget}, below the ` +
          `${DIA_COST_PER_DEBUG_SESSION} dialog work processes one debug session pins.`,
        {
          operation: op,
          reason: "dia-budget",
          budget: this.cfg.debugDiaBudget,
          cost: DIA_COST_PER_DEBUG_SESSION,
        },
        "Raise ABAP_DEBUG_DIA_BUDGET only if the target system's rdisp/wp_no_dia has headroom. " +
          "Raising it does not enable a second concurrent debug session.",
      );
    }
    const slot = await this.acquire("debug", op);
    return this.lease(slot, "debug");
  }

  async shutdown(reason: string): Promise<void> {
    this.closed = true;
    this.drainWaiters(poolClosedError(`shutdown(${reason})`));
    // Sequential, not `Promise.all`: the appliance has ~7 dialog work processes and a fan-out
    // of session drops at exit is the last thing to ask of it. Failures are logged, not
    // rethrown — one slot that won't die must not stop the next one from trying.
    for (const s of [...this.slots]) {
      try {
        await s.conn.shutdown(reason);
      } catch (e) {
        this.log(`[abapsmith] pool slot ${s.id} shutdown failed: ${describeUnknownError(e)}`);
      }
    }
  }

  dispose(): void {
    this.closed = true;
    this.drainWaiters(poolClosedError("dispose()"));
    for (const s of [...this.slots]) {
      this.unsubscribeSlot(s);
      try {
        s.conn.dispose();
      } catch (e) {
        this.log(`[abapsmith] pool slot ${s.id} dispose failed: ${describeUnknownError(e)}`);
      }
    }
    this.slots.splice(0);
  }

  // ------------------------------------------------------------ acquisition ---

  private roleLimit(role: SlotRole): number {
    if (role === "debug") return DEBUG_CONCURRENCY;
    return role === "write" ? this.cfg.writeConcurrency : this.cfg.readConcurrency;
  }

  /** Outstanding leases in `role`. Deadness is NOT consulted — see {@link stats}. */
  private inFlight(role: SlotRole): number {
    let n = 0;
    for (const s of this.slots) if (s.busy && s.role === role) n++;
    return n;
  }

  /** Slots that still count against `maxSessions`: everything live, plus every corpse still leased. */
  private liveCount(): number {
    let n = 0;
    for (const s of this.slots) if (s.busy || !this.isSlotDead(s)) n++;
    return n;
  }

  /**
   * Decide-and-take in one synchronous run-to-completion block — no `await` between "a slot is
   * free" and "the slot is mine" (the TOCTOU invariant `session-lock.ts` calls I1). This is why
   * `createConnection` must be synchronous.
   */
  private tryTake(role: SlotRole, op: string): InternalSlot | undefined {
    if (this.closed) return undefined;
    if (this.inFlight(role) >= this.roleLimit(role)) return undefined;

    this.dropDeadIdle();
    // Sweep staleness here too, not only at release — a pool that goes quiet only sweeps once
    // (at the last release) and never again, so the next caller after a long gap would
    // otherwise inherit a corpse. Checkout-time half of "presume stale, never probe" (L2).
    this.evictStaleIdle();

    // Warmest first: the most recently released slot is least likely to have gone stale
    // server-side, and staleness cannot be checked (L2).
    let best: InternalSlot | undefined;
    for (const s of this.slots) {
      if (s.busy || this.isSlotDead(s)) continue;
      if (!best || s.lastReleasedAt > best.lastReleasedAt) best = s;
    }

    if (!best && this.liveCount() < this.cfg.maxSessions) {
      best = this.createSlot(false);
      this.slots.push(best);
    }
    if (!best) return undefined;

    best.busy = true;
    best.role = role;
    best.op = op;
    best.leasedAt = this.now();
    return best;
  }

  /** The slot whose lease is blocking us, for the `SessionBusyError` message. */
  private blockingSlot(): InternalSlot | undefined {
    let oldest: InternalSlot | undefined;
    for (const s of this.slots) {
      // A corpse still holding a lease is exactly what's blocking the caller — name it.
      if (!s.busy) continue;
      if (!oldest || s.leasedAt < oldest.leasedAt) oldest = s;
    }
    return oldest;
  }

  private busyError(reason: SessionBusyReason, op: string, note?: string): SessionBusyError {
    const holder = this.blockingSlot();
    return new SessionBusyError({
      reason,
      op,
      holder: holder ? holder.op : "(none)",
      holderKind: holder?.role === "debug" ? "lease" : "exclusive",
      heldForMs: holder ? Math.max(0, this.now() - holder.leasedAt) : 0,
      ...(note ? { note } : {}),
    });
  }

  /** True when the pool is full and everything holding it is a debug lease. */
  private blockedOnlyByDebugLease(): boolean {
    if (this.liveCount() < this.cfg.maxSessions) return false;
    let anyBusy = false;
    for (const s of this.slots) {
      if (!s.busy) {
        if (this.isSlotDead(s)) continue; // a corpse awaiting drop refuses nobody
        return false; // a live idle slot exists; something else refused us
      }
      anyBusy = true;
      if (s.role !== "debug") return false;
    }
    return anyBusy;
  }

  /**
   * Acquire a live, prepared slot, or reject.
   *
   * The wait budget is an absolute deadline computed once; a corpse found during preparation
   * is dropped and retried against the SAME deadline, never a fresh `sessionWaitMs`.
   *
   * Three exits, not one — preparation is `conn.connect()` (a logon against the one shared
   * `login/fails_to_user_lock` counter, L3), so retrying on every failure would be a logon
   * amplifier:
   *  - AUTH-CLASS failure ({@link isAuthClassError} / {@link isConnectFailureClassError}
   *    for system-down/unreachable) — not a property of this session: release without
   *    retiring, clear the memoised preparation, hand off, rethrow unwrapped. No second logon.
   *  - Any other failure — dead on arrival: retire and retry against the same deadline, bounded
   *    by {@link MAX_PREPARE_ATTEMPTS}.
   *  - Budget or attempts exhausted — hand freed capacity to whoever is parked, then fail.
   */
  private async acquire(role: SlotRole, op: string): Promise<InternalSlot> {
    const deadline = this.now() + this.cfg.sessionWaitMs;
    const acquireStart = this.now();
    let attempts = 0;
    for (;;) {
      if (this.closed) throw poolClosedError(op);
      // Park behind the queue, do not barge it: taking a free slot while somebody is already
      // parked would let a caller that just arrived jump ahead of one that's been waiting,
      // starving it under a steady stream on a pool that was never actually full.
      //
      // `debug` is exempt — honestly, this is preemption: a debug reservation can take
      // capacity a queued waiter was owed, leaving that waiter parked. Chosen because the only
      // alternative is failing the reservation whenever anybody is queued (parking a debug
      // reservation is not an option — see ROLE SEMANTICS, it's the same multi-minute hang one
      // level down). A queued read/write that loses this race just waits and is served by the
      // next `handoff`; a refused debug reservation has no such recovery. Bounded by
      // `DEBUG_CONCURRENCY`, the `debugDiaBudget` floor check, and debug reservations being
      // rare, human-initiated acts.
      const mayTake = role === "debug" || !this.hasParkedWaiter();
      const slot = (mayTake ? this.tryTake(role, op) : undefined) ?? (await this.park(role, op, deadline));
      attempts++;
      try {
        // Busy from `tryTake` onwards, but not a usable session until preparation resolves —
        // `seatPrimary`'s last-resort tier adopts busy slots, so it needs this narrower window
        // to stay off a half-built one (see `InternalSlot.preparing`).
        slot.preparing = true;
        // Read BEFORE `prepare()` installs the memo — the only point where "inherited a live
        // session" and "about to pay for one" are still distinguishable.
        const warm = slot.prepared !== undefined;
        await this.prepare(slot, role);
        if (timingDebugEnabled()) {
          this.log(
            `[abapsmith] timing acquire op=${op} role=${role} slot=${slot.id} ` +
              `warm=${warm} attempts=${attempts} ms=${this.now() - acquireStart}`,
          );
        }
        return slot;
      } catch (e) {
        if (isAuthClassError(e) || isConnectFailureClassError(e)) {
          // Not this session's fault (see isConnectFailureClassError). Keep the slot, drop the
          // poisoned memo so a later attempt can retry, and get out.
          slot.prepared = undefined;
          this.releaseSlot(slot);
          throw e;
        }
        this.retire(slot, "preparation failed", e);
        if (this.now() >= deadline) {
          this.handoff();
          throw this.busyError(
            "wait-timeout",
            op,
            "Every session offered was dead on arrival; the last failure was: " +
              describeUnknownError(e),
          );
        }
        if (attempts >= MAX_PREPARE_ATTEMPTS) {
          // The clock isn't moving, so `sessionWaitMs` bounds nothing here — rethrow the cause
          // rather than manufacturing a `wait-timeout`.
          this.handoff();
          throw e;
        }
      } finally {
        slot.preparing = false;
      }
    }
  }

  /** Park in the FIFO queue, or fail fast when parking is the wrong answer. */
  private park(role: SlotRole, op: string, deadline: number): Promise<InternalSlot> {
    // A debug reservation never queues — parking the long poll is the same hang one level down.
    if (role === "debug") {
      return Promise.reject(
        this.busyError(
          "lease-held",
          op,
          "A debug reservation never queues — stop the running debug session first.",
        ),
      );
    }
    // Nobody queues behind a long poll either: from the MCP client's side an unbounded block
    // (~55s/~115s measured) is indistinguishable from a hung server.
    if (this.blockedOnlyByDebugLease()) {
      return Promise.reject(
        this.busyError(
          "lease-held",
          op,
          "The only session is held by a debugger long poll; queueing behind it " +
            "would block for the rest of that poll.",
        ),
      );
    }
    if (this.waiters.length >= this.maxQueue) {
      return Promise.reject(this.busyError("queue-full", op));
    }

    return new Promise<InternalSlot>((resolve, reject) => {
      const w: Waiter = {
        role,
        op,
        settled: false,
        timer: undefined,
        resolve: () => undefined,
        reject: () => undefined,
      };
      w.resolve = (slot) => {
        if (w.settled) return;
        w.settled = true;
        this.clearTimer(w.timer);
        resolve(slot);
      };
      w.reject = (err) => {
        if (w.settled) return;
        w.settled = true;
        this.clearTimer(w.timer);
        reject(err);
      };
      w.timer = this.setTimer(() => {
        this.unpark(w);
        w.reject(this.busyError("wait-timeout", op));
        // A timeout is a queue exit, and every queue exit must drain: losing the head can make
        // the queue servable for the first time (a different role, or a head `tryTake` kept
        // refusing), and nothing else would drain it otherwise. Re-entrancy is safe: this runs
        // from a timer, and the waiter is already unparked and settled before the drain.
        this.handoff();
      }, Math.max(0, deadline - this.now()));
      this.waiters.push(w);
    });
  }

  private unpark(w: Waiter): void {
    const i = this.waiters.indexOf(w);
    if (i >= 0) this.waiters.splice(i, 1);
  }

  /**
   * Is anyone actually waiting? Checks `settled` rather than trusting `waiters.length`, same
   * reason `handoff` discards settled heads: a settled-but-still-queued waiter must never make
   * a live caller defer to a ghost. Defensive — every queue exit should already remove itself.
   */
  private hasParkedWaiter(): boolean {
    for (const w of this.waiters) if (!w.settled) return true;
    return false;
  }

  /**
   * Hand freed capacity to parked callers, strict FIFO — if the head can't be served, nobody
   * behind it is served either, or a write could starve behind a stream of reads. FIFO is a
   * property of the pool, not just this loop: `acquire` refuses `tryTake` while anyone is
   * parked ({@link AdtSessionPool.hasParkedWaiter}).
   */
  private handoff(): void {
    while (this.waiters.length > 0) {
      const w = this.waiters[0]!;
      // Discarded BEFORE `tryTake` marks a slot busy, not after: handing a slot to an
      // already-settled waiter would leak that slot busy forever with nobody to release it.
      // Should be unreachable (every queue exit already removes itself) — defensive.
      if (w.settled) {
        this.waiters.shift();
        continue;
      }
      let slot: InternalSlot | undefined;
      try {
        slot = this.tryTake(w.role, w.op);
      } catch (e) {
        // `tryTake` reaches `createSlot`, which throws on a foreign circuit breaker (L3). An
        // escaping throw here would replace the caller's real error (this runs from `runOn`'s
        // `finally`) and abandon the rest of the queue mid-drain. Reject this waiter (a
        // breaker mismatch is structural and won't heal, so waiting buys nothing) and keep
        // draining so nobody stalls behind an unservable head.
        this.waiters.shift();
        w.reject(e);
        continue;
      }
      if (!slot) return;
      this.waiters.shift();
      w.resolve(slot);
    }
  }

  /**
   * Reject every parked caller and empty the queue. `splice(0)` matters: rejecting in place
   * would leave settled waiters queued for `stats().waiting` and `handoff` to trip over.
   */
  private drainWaiters(err: unknown): void {
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  private prepare(slot: InternalSlot, role: SlotRole): Promise<void> {
    if (!this.prepareFn) return Promise.resolve();
    // Memoised on the slot: preparation is per-session, not per-lease.
    if (slot.prepared) return slot.prepared;
    const started = this.now();
    const p = this.prepareFn(slot.conn, role, slot.pinned);
    // Timing wraps the memo, not the return, or a second checkout would re-report the first cost.
    slot.prepared = timingDebugEnabled()
      ? p.then(
          (v) => {
            this.log(
              `[abapsmith] timing prepare slot=${slot.id} role=${slot.role} ` +
                `pinned=${slot.pinned} op=${slot.op} ms=${this.now() - started}`,
            );
            return v;
          },
          (e: unknown) => {
            this.log(
              `[abapsmith] timing prepare FAILED slot=${slot.id} ms=${this.now() - started}`,
            );
            throw e;
          },
        )
      : p;
    return slot.prepared;
  }

  // ------------------------------------------------------------- leasing ---

  private lease(slot: InternalSlot, role: SlotRole): PoolSlot {
    let released = false;
    const pool = this;
    // L6: the pool's handle on this lease, so `onSlotConnectionDied` can free a debug lease
    // whose owner is blocked on a long poll that will never return.
    slot.activeRelease = (): void => {
      if (released) return;
      released = true;
      pool.releaseSlot(slot);
    };
    return {
      conn: slot.conn,
      role,
      id: slot.id,
      /** L1: void, idempotent. Frees a pool slot only — locks are released by `StatefulSession`. */
      release(): void {
        if (released) return;
        released = true;
        pool.releaseSlot(slot);
      },
    };
  }

  private releaseSlot(slot: InternalSlot): void {
    slot.busy = false;
    slot.op = "(idle)";
    slot.activeRelease = undefined;
    slot.lastReleasedAt = this.now();
    if (this.isSlotDead(slot)) this.dropSlot(slot, "dead on release");
    // This used to have a second branch here — `stillHoldsLocks(slot)`, reading
    // `conn.heldLockUris()` and dropping the slot if it still reported an enqueue. It was
    // deleted (not merely disabled) because it was dead in production, not because the
    // protection it gestured at is unwanted: `withStatefulSession()`'s outer `finally`
    // (connection.ts) clears `activeSession` before control ever returns to this method, so
    // `heldLockUris()` always read `[]` here regardless of what actually leaked. A dead branch
    // that looks like a backstop is worse than no branch — see the archive for the full
    // incident history. The real protection lives entirely in `connection.ts`: `if
    // (session.leakedLocks.length > 0) await this.dropSession()`, which runs — and terminates
    // the session, releasing the enqueue with it — before this method is ever called, whether
    // the slot is pinned or not. Covered end-to-end (no double) by
    // `test/connection-liveness.test.ts`'s dead-lock-leak describe block.
    this.evictStaleIdle();
    this.handoff();
  }

  /**
   * Bounded (one attempt) recovery for a caller that inherited a corpse. A slot
   * can die from a prior caller's own successful request, or an unrelated blip, and the pool
   * has no way to learn until the next request fails on it (L2). This replays that caller's own
   * request once on a freshly acquired slot, instead of surfacing `SESSION_DEAD` for free.
   * Also covers `isSessionDeadError`'s CSRF-refusal shape (see its own comment).
   *
   * Idempotency: reads are unconditionally safe to replay (no side effect to duplicate).
   * Writes replay only when the failure arrived implausibly fast (`DEAD_ON_ARRIVAL_MS`) — a
   * slow `SESSION_DEAD` means the server had time to apply the write, so blind replay risks a
   * duplicate mutation. Conservative first cut, not a proof — "session destroyed" vs.
   * "CSRF token invalidated" isn't fully discriminated by any capture
   * so far; see archive. Bounded to exactly one replay (`allowReplay=false` recursively), same
   * reasoning as `MAX_PREPARE_ATTEMPTS`.
   *
   * A third case layers on top that skips the timing gate entirely: `isCondemnedConnectionError`
   * recognises `connectionDeadError`, provably raised only when the connection died DURING
   * this call's own `fn` (see that predicate's comment) — so `eligibleForDeadSlotReplay`
   * refuses to replay a write carrying that marker regardless of `elapsedMs`, since the
   * manufactured failure can arrive well under `DEAD_ON_ARRIVAL_MS`. Reads still unaffected.
   */
  private async runOn<T>(
    role: SlotRole,
    op: string,
    fn: (conn: AbapConnection) => Promise<T>,
  ): Promise<T> {
    return this.runOnAttempt(role, op, fn, true);
  }

  private async runOnAttempt<T>(
    role: SlotRole,
    op: string,
    fn: (conn: AbapConnection) => Promise<T>,
    allowReplay: boolean,
  ): Promise<T> {
    const slot = await this.acquire(role, op);
    const lease = this.lease(slot, role);
    // Timed around exactly the caller's own request, not around `acquire()` —
    // any queueing this call did waiting for a slot must not count toward the
    // "implausibly fast" signature.
    const startedAt = this.now();
    try {
      return await fn(slot.conn);
    } catch (e) {
      // The only way a slot is ever marked dead: `SESSION_DEAD`, or the equally-untrustworthy
      // CSRF-refusal shape `isSessionDeadError` also recognises. Never a probe (L2). Auth
      // failures are deliberately NOT here — that's the shared breaker's business, not this
      // session's.
      if (isSessionDeadError(e)) {
        slot.dead = true;
        if (allowReplay && this.eligibleForDeadSlotReplay(role, this.now() - startedAt, e)) {
          // Release BEFORE recursing so the next `acquire()` sees accurate pool state.
          lease.release();
          this.log(
            `[abapsmith] pool replaying ${op} (role=${role}) on a fresh slot: ` +
              `inherited slot ${slot.id} was already dead (ms=${this.now() - startedAt}).`,
          );
          return this.runOnAttempt(role, op, fn, false);
        }
      }
      throw e;
    } finally {
      lease.release();
    }
  }

  /**
   * See `runOnAttempt`'s doc for the reasoning; this implements the threshold(s). Two
   * independent gates for a write, checked in order: (1) `isCondemnedConnectionError(e)` — a
   * structural refusal, checked first because a condemned error can arrive well
   * under `DEAD_ON_ARRIVAL_MS` (nothing about the throw itself touches the wire), so the timing
   * gate alone can't catch it; (2) the `DEAD_ON_ARRIVAL_MS` timing heuristic. Gate 1 has
   * no lost-recovery cost: it can only suppress replays where `fn` had already started (proven
   * in `isCondemnedConnectionError`'s comment), which this module's own conservative policy says
   * shouldn't be replayed either. Reads bypass both gates unconditionally.
   */
  private eligibleForDeadSlotReplay(role: SlotRole, elapsedMs: number, e: unknown): boolean {
    if (role === "read") return true;
    if (isCondemnedConnectionError(e)) return false;
    return elapsedMs <= DEAD_ON_ARRIVAL_MS;
  }

  // ------------------------------------------------------------- retirement ---

  /** Detach this slot's `onDead` subscription. Idempotent; never throws. */
  private unsubscribeSlot(slot: InternalSlot): void {
    const off = slot.unsubscribeDead;
    slot.unsubscribeDead = undefined;
    if (!off) return;
    try {
      off();
    } catch (e) {
      this.log(`[abapsmith] pool slot ${slot.id} onDead unsubscribe failed: ${describeUnknownError(e)}`);
    }
  }

  private dropDeadIdle(): void {
    for (const s of [...this.slots]) {
      if (this.isSlotDead(s) && !s.busy) this.dropSlot(s, "dead");
    }
  }

  /**
   * Presume-stale sweep. Runs at release time and again at checkout (`tryTake`), never on a
   * timer — release-only would never fire on a quiet pool, precisely when slots go stale.
   * Pinned slot 0 is exempt: recycling it costs a fresh logon + discovery + system-role probe.
   *
   * This exemption means a lock leaked on the pinned primary is never caught here
   * — not a gap in practice, since `withStatefulSession()`'s own `finally` already drops a
   * session the moment it records a leak, before this sweep would ever run.
   */
  private evictStaleIdle(): void {
    const cutoff = this.now() - this.cfg.sessionIdleMs;
    for (const s of [...this.slots]) {
      if (s.pinned || s.busy || this.isSlotDead(s)) continue;
      if (s.lastReleasedAt <= cutoff) this.dropSlot(s, "idle past sessionIdleMs");
    }
  }

  /**
   * Kill a slot and give the capacity it was holding to whoever is parked.
   *
   * The `handoff()` is not optional: `retire` runs from `acquire`'s preparation-failure path
   * and frees a slot against `maxSessions`; without a drain, `acquire`'s anti-barging rule
   * would just send the retiring caller back to `park`, leaving free headroom nobody notices
   * until an unrelated `release()`. It is not a logon amplifier — it only lets the head's own
   * `tryTake` mint the one session it was already entitled to, bounded by its own
   * `sessionWaitMs`/`MAX_PREPARE_ATTEMPTS`. Cannot recurse: `handoff` resolves a promise, so
   * the served caller resumes in a later microtask.
   */
  private retire(slot: InternalSlot, why: string, cause?: unknown): void {
    slot.dead = true;
    slot.busy = false;
    this.dropSlot(slot, cause ? `${why}: ${describeUnknownError(cause)}` : why);
    this.handoff();
  }

  private dropSlot(slot: InternalSlot, why: string): void {
    const i = this.slots.indexOf(slot);
    if (i < 0) return;
    this.slots.splice(i, 1);
    // Unsubscribe BEFORE teardown: `primaryConn` outlives the pool, so a listener left attached
    // would be a closure over a retired slot and a dead pool.
    this.unsubscribeSlot(slot);
    this.log(`[abapsmith] pool retiring slot ${slot.id} (${why}).`);
    try {
      // A session known dead gets `dispose()` only — `shutdown()` would put one more doomed
      // request on the wire for a session the server already discarded.
      if (!this.isSlotDead(slot)) {
        void slot.conn.shutdown("pool-evict").catch((e: unknown) => {
          this.log(`[abapsmith] pool slot ${slot.id} evict-shutdown failed: ${describeUnknownError(e)}`);
        });
      }
      slot.conn.dispose();
    } catch (e) {
      this.log(`[abapsmith] pool slot ${slot.id} teardown failed: ${describeUnknownError(e)}`);
    }
  }
}

/** Convenience constructor, so callers need not import the class name. */
export function createSessionPool(opts: SessionPoolOptions): SessionPool {
  return new AdtSessionPool(opts);
}
