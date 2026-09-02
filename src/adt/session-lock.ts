/**
 * Per-connection session lock — the ADT stateful-session mutex.
 *
 * A second request on the same ADT *stateful* session head-of-line blocks
 * behind an outstanding long poll (e.g. the debugger's `debugger/listeners`)
 * for its entire remaining duration — a server-side property of the ABAP
 * session (keyed by cookies, not the TCP connection), so a second HTTP
 * connection does not help. Measured via live testing, not assumed — see
 * the git history.
 *
 * Rule enforced: exactly one HTTP request in flight per `AbapConnection`, via
 * two asymmetric modes:
 *   - EXCLUSIVE (`runExclusive`, `acquireImplicit`): bounded work queues
 *     FIFO with a wait timeout.
 *   - LEASE (`acquireLease`): the debug long poll's multi-minute hold. Never
 *     queues and is never queued behind — both sides fail fast with
 *     `SESSION_BUSY` instead of parking for however long the poll has left.
 *
 * No "ask the server if I still hold it" probe exists, and none should be
 * added: it would itself head-of-line block behind what it's checking. All
 * lock state is local; a hard TTL on leases is the only recovery mechanism.
 *
 * Invariants: (I1) no `await` between "lock is free" and "lock is mine"
 * (TOCTOU); (I2) exactly one release per acquisition, from `finally`, keyed
 * by token; (I3) re-entrancy is token-identity via `AsyncLocalStorage` (a
 * `Symbol` set, not a counter — see `als` below); (I4) timers are injectable
 * and `unref()`ed, must never hold the process/test runner open.
 *
 * Wired at two levels: `acquireImplicit` guards every outbound request
 * (`src/adt/http-guard.ts`); `runExclusive` wraps the multi-request flows in
 * `src/adt/connection.ts` that mutate session state (`connect`,
 * `withStatefulSession`, `dropSession`, `withFreshSession`) — corruption
 * happens between a flow's requests, not within one. One lock per
 * connection, never a singleton (main + debug-trigger connections coexist).
 *
 * `acquireLease` has no callers yet, deliberately: wiring it to the debug
 * long poll today would regress, not fix — the poll bypasses the guard
 * entirely, and a refusing lease would block the debugger's own teardown.
 * Full reasoning in the archive.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Returned by `acquireImplicit`; MUST be called from a `finally`. Idempotent. */
export type Release = () => void;

/**
 * A long-lived, non-queueing hold on the session. Handed to the debug long
 * poll. Carries a hard TTL so a crashed or forgotten poll cannot wedge the
 * connection for the lifetime of the process.
 */
export interface SessionLease {
  /** Operation label, for diagnostics and for the `SESSION_BUSY` message. */
  readonly op: string;
  readonly acquiredAt: number;
  /** Wall-clock (per the injected `now()`) at which the TTL force-releases. */
  readonly expiresAt: number;
  readonly released: boolean;
  /**
   * Push the expiry out. Throws if the lease is already released or already
   * expired — renewing a dead lease would silently re-take a lock somebody else
   * may now own, which is I2 violated by another name.
   */
  renew(ttlMs?: number): void;
  /** Idempotent. Hands off to any queued exclusive waiters. */
  release(): void;
}

/** Snapshot of whoever currently holds the session. */
export interface LockHolder {
  op: string;
  kind: "lease" | "exclusive";
  heldForMs: number;
}

/**
 * Why an acquisition was refused.
 *
 * - `"lease-held"`   — something else holds the session and we refuse to queue.
 *                      Raised both when a lease blocks an exclusive caller and
 *                      when ANY hold blocks `acquireLease` (which never
 *                      queues); read `holderKind` to tell those apart.
 * - `"queue-full"`   — `maxQueue` waiters are already parked.
 * - `"wait-timeout"` — parked longer than `waitTimeoutMs`, or the queue was
 *                      drained by `forceRelease` (message says which).
 */
export type SessionBusyReason = "lease-held" | "queue-full" | "wait-timeout";

/** Everything `SessionBusyError` needs to explain who is holding the session. */
export interface SessionBusyDetail {
  reason: SessionBusyReason;
  holder: string;
  holderKind: "lease" | "exclusive";
  heldForMs: number;
  op?: string;
  note?: string;
}

/**
 * Refusal to admit a request onto the shared ADT session.
 *
 * This is a normal, expected outcome — not a bug, not a server error — written
 * for a human deciding what to do next. Refusing beats letting the caller
 * silently head-of-line block behind the long poll; see the module header.
 */
export class SessionBusyError extends Error {
  readonly code = "SESSION_BUSY";
  /** Op label of the holder at the moment of refusal. */
  readonly holder: string;
  readonly holderKind: "lease" | "exclusive";
  readonly heldForMs: number;
  readonly reason: SessionBusyReason;

  constructor(detail: SessionBusyDetail) {
    super(SessionBusyError.describe(detail));
    this.name = "SessionBusyError";
    this.reason = detail.reason;
    this.holder = detail.holder;
    this.holderKind = detail.holderKind;
    this.heldForMs = detail.heldForMs;
  }

  private static describe(detail: SessionBusyDetail): string {
    const who = `${detail.holderKind} "${detail.holder}" (held ${detail.heldForMs}ms)`;
    const mine = detail.op ? ` for "${detail.op}"` : "";
    const tail = detail.note ? ` ${detail.note}` : "";
    if (detail.reason === "lease-held") {
      return (
        `The ABAP session is busy${mine}: ${who}. ` +
        "Only one request may be in flight on a stateful ADT session — a second one does not " +
        "complete until the debugger's long poll settles, up to its full remaining timeout — " +
        "and this holder is not queued behind, by design." +
        tail
      );
    }
    if (detail.reason === "queue-full") {
      return (
        `The ABAP session queue is full${mine}; current holder is ${who}. ` +
        "Requests are serialised per connection; retry once the current work completes." +
        tail
      );
    }
    return (
      `Timed out waiting for the ABAP session${mine}; holder was ${who}. ` +
      "The session serialises requests, so a slow operation delays every other one." +
      tail
    );
  }
}

export interface SessionLockOptions {
  /** Max parked exclusive waiters. Default 8. */
  maxQueue?: number;
  /** How long a parked waiter may wait before it gives up. Default 10_000. */
  waitTimeoutMs?: number;
  /** Hard TTL applied to a lease when the caller does not name one. Default 300_000. */
  defaultLeaseTtlMs?: number;
  /** Injectable clock. Default `() => Date.now()`. */
  now?: () => number;
  /** Injectable timer. Default `setTimeout` with the handle `unref()`ed. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /**
   * Diagnostics sink. Defaults to a NO-OP on purpose: this server speaks MCP
   * over stdio, and anything written to stdout corrupts the protocol stream.
   */
  log?: (msg: string) => void;
}

const DEFAULT_MAX_QUEUE = 8;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_LEASE_TTL_MS = 300_000;

/**
 * Ambient SET of hold tokens owned by the calling async context, shared
 * module-wide so one context can hold several locks at once (e.g. the main
 * and debug-trigger `AbapConnection`s). Must be a SET that each acquisition
 * EXTENDS, not a single token replaced per `als.run` — a single token caused
 * a real self-deadlock in `A.runExclusive → B.runExclusive → A.runExclusive`
 * nesting. See the git history; do not
 * "simplify" this back to one token.
 */
const als = new AsyncLocalStorage<ReadonlySet<symbol>>();

/**
 * The caller's ambient token set PLUS `token`. A fresh object every time, so an
 * inner scope can never mutate the set an outer frame is still relying on.
 */
function withToken(parent: ReadonlySet<symbol> | undefined, token: symbol): ReadonlySet<symbol> {
  const next = new Set<symbol>(parent);
  next.add(token);
  return next;
}

interface Hold {
  readonly token: symbol;
  readonly op: string;
  readonly kind: "lease" | "exclusive";
  readonly acquiredAt: number;
  /** Only for leases: the TTL force-release timer. */
  timer?: unknown;
  /** Only for leases: flips the lease object's `released` flag. */
  markReleased?: () => void;
}

interface Waiter {
  readonly op: string;
  readonly enqueuedAt: number;
  settled: boolean;
  timer: unknown;
  resolve(token: symbol): void;
  reject(err: Error): void;
}

const NOOP_RELEASE: Release = () => {
  /* re-entrant pass-through: the outer hold owns the release */
};

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const h = setTimeout(fn, ms);
  // A pending lock timer must never be the reason the process (or `vitest`)
  // refuses to exit. `unref` is absent on some shims, hence the guard.
  if (typeof (h as { unref?: () => void }).unref === "function") {
    (h as { unref: () => void }).unref();
  }
  return h;
}

/**
 * One lock per `AbapConnection`. Not shared across connections: two different
 * ABAP sessions are genuinely independent and serialising them together would
 * halve throughput for nothing.
 */
export class SessionLock {
  private hold: Hold | null = null;
  private readonly waiters: Waiter[] = [];

  private readonly maxQueue: number;
  private readonly waitTimeoutMs: number;
  private readonly defaultLeaseTtlMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private readonly log: (msg: string) => void;

  constructor(opts: SessionLockOptions = {}) {
    this.maxQueue =
      typeof opts.maxQueue === "number" && opts.maxQueue >= 0
        ? Math.floor(opts.maxQueue)
        : DEFAULT_MAX_QUEUE;
    this.waitTimeoutMs =
      typeof opts.waitTimeoutMs === "number" && opts.waitTimeoutMs > 0
        ? opts.waitTimeoutMs
        : DEFAULT_WAIT_TIMEOUT_MS;
    this.defaultLeaseTtlMs =
      typeof opts.defaultLeaseTtlMs === "number" && opts.defaultLeaseTtlMs > 0
        ? opts.defaultLeaseTtlMs
        : DEFAULT_LEASE_TTL_MS;
    this.now = typeof opts.now === "function" ? opts.now : () => Date.now();
    this.setTimer = typeof opts.setTimer === "function" ? opts.setTimer : defaultSetTimer;
    this.clearTimer =
      typeof opts.clearTimer === "function"
        ? opts.clearTimer
        : (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>);
    this.log =
      typeof opts.log === "function"
        ? opts.log
        : () => {
            /* silent by default — stdout belongs to the MCP protocol */
          };
  }

  // ------------------------------------------------------------- observability

  /** Parked exclusive waiters. Timed-out and force-rejected waiters are removed. */
  get queueDepth(): number {
    return this.waiters.length;
  }

  isLeaseHeld(): boolean {
    return this.hold !== null && this.hold.kind === "lease";
  }

  currentHolder(): LockHolder | null {
    const h = this.hold;
    if (h === null) return null;
    return { op: h.op, kind: h.kind, heldForMs: Math.max(0, this.now() - h.acquiredAt) };
  }

  // ---------------------------------------------------------------- exclusive

  /**
   * Run `fn` with the session to itself. Check order is load-bearing:
   * re-entrancy first (a nested call must never queue behind its own outer
   * hold — unbreakable self-deadlock), then lease-held (refuse, never
   * queue), then take-or-park-FIFO. I1: free-check through take runs
   * synchronously, so the first `await` is on an already-decided promise.
   */
  async runExclusive<T>(op: string, fn: () => Promise<T>): Promise<T> {
    // Snapshot ambient holds before anything else, so upstream re-entrancy
    // checks still see them.
    const parent = als.getStore();
    if (this.isReentrant()) {
      // Already inside the hold: no state change, no release on exit — the
      // outer frame owns that.
      return fn();
    }
    const token = await this.acquireExclusiveToken(op);
    try {
      // Extend, never replace: `als.run` overwrites the store wholesale.
      return await als.run(withToken(parent, token), fn);
    } finally {
      this.releaseToken(token); // I2: keyed release, safe on success and throw.
    }
  }

  /**
   * The HTTP guard's entry point, called for every outbound request.
   * Deliberately not `async`: the re-entrancy check must run in the caller's
   * synchronous block, guaranteed by construction rather than by relying on
   * an async function's head happening to run synchronously. No ALS scope is
   * established for the granted hold (the caller resumes outside any
   * `als.run`); the returned `Release` clears the hold directly instead.
   */
  acquireImplicit(op: string): Promise<Release> {
    if (this.isReentrant()) return Promise.resolve(NOOP_RELEASE);
    return this.acquireExclusiveToken(op).then((token) => {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        this.releaseToken(token);
      };
    });
  }

  // -------------------------------------------------------------------- lease

  /**
   * Take a long-lived hold. SYNCHRONOUS BY DESIGN (I1): there is no await
   * between "free" and "mine", so two long polls can never both believe they
   * own the session.
   *
   * Fails fast against ANY existing hold, lease or exclusive. `holderKind` on
   * the error says which.
   */
  acquireLease(op: string, ttlMs?: number): SessionLease {
    const held = this.hold;
    if (held !== null) {
      throw this.busy("lease-held", held, op, "A lease never queues; it fails fast instead.");
    }

    const ttl = typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : this.defaultLeaseTtlMs;
    const acquiredAt = this.now();
    const token = Symbol(`lease:${op}`);
    let expiresAt = acquiredAt + ttl;
    let released = false;

    this.hold = {
      token,
      op,
      kind: "lease",
      acquiredAt,
      markReleased: () => {
        released = true;
      },
    };

    // Stuck-lease recovery: a crashed/dropped poll would otherwise wedge the
    // connection until process restart. No confirmation probe (see header);
    // TTL is the only recovery, re-armed by `renew()`.
    const arm = (): void => {
      const h = this.hold;
      if (h === null || h.token !== token) return;
      if (h.timer !== undefined) this.clearTimer(h.timer);
      h.timer = this.setTimer(() => this.expireLease(token), Math.max(0, expiresAt - this.now()));
    };
    arm();

    const lease: SessionLease = {
      op,
      acquiredAt,
      get expiresAt(): number {
        return expiresAt;
      },
      get released(): boolean {
        return released;
      },
      renew: (nextTtlMs?: number): void => {
        if (released) {
          throw new Error(
            `Session lease "${op}" was already released; renew() would re-take a lock that may now belong to another caller.`,
          );
        }
        const t = this.now();
        if (t >= expiresAt) {
          throw new Error(
            `Session lease "${op}" expired at ${expiresAt} (now ${t}); it cannot be renewed. Acquire a new lease.`,
          );
        }
        const add = typeof nextTtlMs === "number" && nextTtlMs > 0 ? nextTtlMs : ttl;
        expiresAt = t + add;
        arm();
      },
      release: (): void => {
        // Idempotent: `releaseToken` is a no-op unless this exact token still
        // holds the lock.
        this.releaseToken(token);
      },
    };
    return lease;
  }

  // ----------------------------------------------------------------- teardown

  /**
   * Drop whatever is held and reject every parked waiter. Used by shutdown
   * and `dropSession()` — after the ABAP session is gone, parking waiters
   * forever (an MCP call that never answers) is worse than failing them.
   */
  forceRelease(reason: string): void {
    const held = this.hold;
    if (held !== null) {
      if (held.timer !== undefined) this.clearTimer(held.timer);
      held.markReleased?.();
      this.hold = null;
      this.log(
        `SESSION_LOCK_FORCE_RELEASE op=${held.op} kind=${held.kind} heldForMs=${Math.max(
          0,
          this.now() - held.acquiredAt,
        )} reason=${reason}`,
      );
    } else {
      this.log(`SESSION_LOCK_FORCE_RELEASE op=<none> reason=${reason}`);
    }

    // Snapshot before rejecting: a synchronous reject handler must not see a
    // half-drained array.
    const parked = this.waiters.splice(0, this.waiters.length);
    for (const w of parked) {
      if (w.settled) continue;
      w.settled = true;
      this.clearTimer(w.timer);
      w.reject(
        new SessionBusyError({
          // No "forced" reason exists; reuse "wait-timeout" and carry the
          // real cause in `note`.
          reason: "wait-timeout",
          holder: held ? held.op : "<none>",
          holderKind: held ? held.kind : "exclusive",
          heldForMs: held ? Math.max(0, this.now() - held.acquiredAt) : 0,
          op: w.op,
          note: `The session lock was force-released (${reason}), so this waiter can never be served.`,
        }),
      );
    }
  }

  // ---------------------------------------------------------------- internals

  /**
   * Is the calling async context already inside the current hold? Checks
   * membership of this lock's live token in the ambient set — foreign or
   * stale tokens in that set can't produce a false positive, since only the
   * live token is ever compared.
   */
  private isReentrant(): boolean {
    const held = this.hold;
    if (held === null) return false;
    const ambient = als.getStore();
    return ambient !== undefined && ambient.has(held.token);
  }

  /**
   * Decide-and-take, or park. NOT `async`: the executor of the returned promise
   * runs synchronously, so both the take and the enqueue happen inside the
   * caller's uninterrupted block (I1).
   */
  private acquireExclusiveToken(op: string): Promise<symbol> {
    const held = this.hold;

    if (held === null) return Promise.resolve(this.take(op, "exclusive"));

    if (held.kind === "lease") {
      // Never queue behind a lease — measured as real multi-minute hangs,
      // not a theoretical risk. See the git history.
      return Promise.reject(
        this.busy("lease-held", held, op, "Stop the debug session to free the ABAP session."),
      );
    }

    if (this.waiters.length >= this.maxQueue) {
      return Promise.reject(this.busy("queue-full", held, op));
    }

    return new Promise<symbol>((resolve, reject) => {
      const waiter: Waiter = {
        op,
        enqueuedAt: this.now(),
        settled: false,
        timer: undefined,
        resolve,
        reject,
      };
      waiter.timer = this.setTimer(() => this.timeOutWaiter(waiter), this.waitTimeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Mint a token and take the lock. The ONLY place `hold` is set. */
  private take(op: string, kind: "lease" | "exclusive"): symbol {
    const token = Symbol(`${kind}:${op}`);
    this.hold = { token, op, kind, acquiredAt: this.now() };
    return token;
  }

  /**
   * Release iff `token` still owns the lock — makes double-release harmless
   * instead of letting a stray second `release()` free the next caller's hold.
   */
  private releaseToken(token: symbol): void {
    const held = this.hold;
    if (held === null || held.token !== token) return;
    if (held.timer !== undefined) this.clearTimer(held.timer);
    held.markReleased?.();
    this.hold = null;
    this.handOff();
  }

  /**
   * Give the free lock to the next live waiter. The take happens here,
   * synchronously, before `resolve` schedules a microtask — resolving first
   * would open a window where another caller could grab the "free" lock.
   */
  private handOff(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (next === undefined) return;
      if (next.settled) continue; // timed out; it already rejected and must not get the lock
      next.settled = true;
      this.clearTimer(next.timer);
      next.resolve(this.take(next.op, "exclusive"));
      return;
    }
  }

  /**
   * A parked waiter gave up; must be spliced out here, not just skipped at
   * hand-off — otherwise hand-off mints a token nobody releases, wedging the
   * connection with an ownerless hold. See archive.
   */
  private timeOutWaiter(waiter: Waiter): void {
    if (waiter.settled) return;
    waiter.settled = true;
    this.clearTimer(waiter.timer);
    const i = this.waiters.indexOf(waiter);
    if (i >= 0) this.waiters.splice(i, 1);
    const held = this.hold;
    this.log(
      `SESSION_LOCK_WAIT_TIMEOUT op=${waiter.op} waitedMs=${Math.max(
        0,
        this.now() - waiter.enqueuedAt,
      )} holder=${held ? held.op : "<none>"}`,
    );
    waiter.reject(
      new SessionBusyError({
        reason: "wait-timeout",
        holder: held ? held.op : "<none>",
        holderKind: held ? held.kind : "exclusive",
        heldForMs: held ? Math.max(0, this.now() - held.acquiredAt) : 0,
        op: waiter.op,
      }),
    );
  }

  /** TTL fired: the lease owner is gone or stuck. Reclaim the session. */
  private expireLease(token: symbol): void {
    const held = this.hold;
    if (held === null || held.token !== token) return;
    const heldForMs = Math.max(0, this.now() - held.acquiredAt);
    this.log(`LEASE_EXPIRED op=${held.op} heldForMs=${heldForMs}`);
    // Reuse the normal release path so the hand-off to queued waiters happens.
    this.releaseToken(token);
  }

  private busy(
    reason: SessionBusyReason,
    held: Hold,
    op: string,
    note?: string,
  ): SessionBusyError {
    return new SessionBusyError({
      reason,
      holder: held.op,
      holderKind: held.kind,
      heldForMs: Math.max(0, this.now() - held.acquiredAt),
      op,
      ...(note ? { note } : {}),
    });
  }
}
