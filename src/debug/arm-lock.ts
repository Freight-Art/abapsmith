/**
 * `DebugArmLock` — cross-process exclusion on the ONE debugger slot a SAP
 * system+client+user has.
 *
 * `DebugSession.armListener()`'s guards were purely in-process, so two
 * abapsmith processes against the same system could each arm a listener and
 * silently reassign each other's debuggee. Writes already had cross-process
 * protection via {@link FileLockObjectGate}; this closes the same gap for
 * debugging, built on the same `withFileLock` mechanism (src/state-dir.ts) —
 * the file-locking algorithm itself is not reimplemented.
 *
 * A sibling abstraction rather than `ObjectGate` with a synthetic key:
 * there's no object to key on, the two gates are toggled by unrelated
 * settings, and `ObjectGate`'s object-shaped error ("Cannot lock X for
 * editing") would misdescribe a contended debugger. Full reasoning:
 * the git history.
 *
 * Lives entirely outside `AdtSessionPool` (pool law L5, src/adt/pool.ts):
 * constructed in `createLiveDebugToolDeps` and injected into `DebugSession`
 * like `sessionLease`; the pool neither knows nor stores anything about it.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import { AbapError, describeUnknownError } from "../adt/errors.js";
import { fileLockHolderOf, isFileLockAcquisitionFailure, withFileLock } from "../state-dir.js";

// ---------------------------------------------------------------------------
// DebugArmLock — the interface
// ---------------------------------------------------------------------------

/**
 * An ACQUIRE/RELEASE pair guarding entry to `DebugSession.armListener()`.
 *
 * An interface, not a concrete class, so `DebugSession` stays offline
 * testable: tests inject a two-method fake, live code injects
 * {@link FileLockDebugArmLock}. Not scope-shaped like `withFileLock` because
 * the protected region spans `armListener()` to `doTerminate()`, with
 * unbounded caller-driven stepping in between — see
 * {@link FileLockDebugArmLock} for how that span is held open.
 */
export interface DebugArmLock {
  /**
   * Rejects with `DEBUG_SESSION_LOCKED_CROSS_PROCESS` if another process holds
   * the slot. Resolving means the caller now holds it and MUST eventually call
   * {@link release}.
   */
  acquire(): Promise<void>;
  /**
   * Idempotent, never throws, safe to call when nothing is held.
   *
   * VOID, not `Promise<void>`: called from `doTerminate()`'s `finally`, the
   * one block that must always complete (pool law L1 applies the same
   * reasoning to `PoolSlot.release()`). Consequence: the lock FILE
   * disappears a tick after this returns, not synchronously — harmless
   * in-process (ref count drops immediately), and a process that exits in
   * that gap leaves a lock file that `withFileLock`'s dead-pid rule collects
   * within about `2 × waitMs`.
   */
  release(): void;
}

/** The explicit opt-out: hold nothing, refuse nothing. */
export class NoopDebugArmLock implements DebugArmLock {
  async acquire(): Promise<void> {}
  release(): void {}
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * How long {@link FileLockDebugArmLock} waits for the slot before giving up.
 *
 *   ABAP_DEBUG_LOCK_WAIT_MS → default 1 500 ms, accepted range 200…30 000 ms
 *
 * Fails fast rather than queuing: unlike an object lock (held for one write,
 * seconds at most), a contended debug slot is held as long as a human or
 * agent keeps stepping — minutes, plausibly longer — so no MCP-tolerable
 * wait budget would help. The budget only rides out same-instant races or a
 * dead holder's collection window.
 *
 * Out-of-range values fall back to the default rather than being clamped
 * (same reasoning as `resolveLockWaitMs`): clamping would look like the
 * setting took effect when it did not.
 */
export function resolveDebugLockWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const DEFAULT_MS = 1_500;
  const MIN_MS = 200;
  const MAX_MS = 30_000;
  const raw = env.ABAP_DEBUG_LOCK_WAIT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MS;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MS;
  const ms = Math.floor(n);
  if (ms < MIN_MS || ms > MAX_MS) return DEFAULT_MS;
  return ms;
}

/**
 * Whether the live debug deps install {@link FileLockDebugArmLock} (`true`,
 * the default) or {@link NoopDebugArmLock} (`false`).
 *
 *   ABAP_CROSS_PROCESS_DEBUG_LOCK → default true; "false"/"0"/"no"/"off"
 *   (case-insensitive) opt out
 *
 * On by default, same principle as `ABAP_CROSS_PROCESS_OBJECT_LOCK`. Its own
 * variable rather than shared, so toggling write serialisation and debugger
 * exclusion stay independent decisions (see file header).
 *
 * Realistic reason to disable: a shared or read-only `ABAP_STATE_DIR` where
 * lock files cannot be created at all.
 */
export function resolveCrossProcessDebugLock(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ABAP_CROSS_PROCESS_DEBUG_LOCK;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === "") return true;
  return !["false", "0", "no", "off"].includes(v);
}

/**
 * How long a debug-slot HOLDER may run before its lock is treated as
 * abandoned — passed explicitly since `withFileLock`'s default is derived
 * from CONTENDER wait time, an unrelated quantity (`defaultHardStaleMs`,
 * src/state-dir.ts). An hour: ~10x {@link FileLockObjectGate}'s 600s,
 * matching the longer protected span (arm → step → terminate, human-paced,
 * vs one write).
 *
 * Known, accepted gap: a genuine session still being stepped after an hour
 * WILL have its lock broken by a contender. Kept rather than removed or
 * enlarged — see the git history for why. Ordinary
 * crash recovery is unaffected: a crashed holder is collected by
 * `withFileLock`'s dead-pid rule at `age > 2 × waitMs` ≈ 3s; this valve only
 * governs pid reuse, a foreign hostname, or an unparseable payload.
 */
export const DEBUG_ARM_LOCK_HARD_STALE_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Key and path
// ---------------------------------------------------------------------------

/** Hex width of the debug-lock filename hash: 80 bits, same budget as `objectGateLockPath` — this is a lock namespace, not a security boundary. */
const LOCK_HASH_HEX_LEN = 20;

/**
 * What the lock is keyed on: `${url}|${client}|${USER}`.
 *
 * Deliberately NOT `(terminalId, ideId)` — the pair SAP itself uses to key
 * debuggee attachment (`resolveDebugIdentity`, src/debug/identity.ts).
 * Keying on that triple would give each process its own key, i.e. lock
 * nothing, and let both processes collide into the exact `409 AdiFailed`
 * this exists to prevent — SAP's exclusivity is per USER on a system+client,
 * not per debug identity (corroborated independently in
 * src/debug/identity.ts and src/tools/debug.ts; see
 * the git history for the detail).
 *
 * `client` is carried through as-is (default `""`, not normalised) since two
 * clients on one URL are different systems. `user` is upper-cased because
 * SAP usernames are case-insensitive. `url` is only trimmed, not
 * canonicalised — that's `src/config.ts`'s job, not this function's.
 */
export function debugArmLockKey(cfg: { url: string; client?: string; user: string }): string {
  return `${cfg.url.trim()}|${(cfg.client ?? "").trim()}|${cfg.user.trim().toUpperCase()}`;
}

/**
 * `<stateDir>/locks/debug/<sha256(key)-20hex>.lock` — a sibling of
 * `locks/objects/`, not nested inside it, so an operator can tell at a
 * glance whether a write or a debug session is wedged. The key is hashed
 * because it contains a URL, which is not a legal filename component.
 *
 * Exported for tests to assert on and pre-create.
 */
export function debugArmLockPath(
  stateDir: string,
  cfg: { url: string; client?: string; user: string },
): string {
  const hash = createHash("sha256").update(debugArmLockKey(cfg)).digest("hex").slice(0, LOCK_HASH_HEX_LEN);
  return path.join(stateDir, "locks", "debug", `${hash}.lock`);
}

// ---------------------------------------------------------------------------
// The cross-process implementation
// ---------------------------------------------------------------------------

/**
 * Re-wraps a lock-acquisition failure into `DEBUG_SESSION_LOCKED_CROSS_PROCESS`,
 * naming the contended debugger slot rather than the lock file's path as the
 * primary fact (`JOURNAL_IO`'s message is written for a disk problem, not
 * "somebody else is debugging as this user").
 *
 * Callers MUST check `isFileLockAcquisitionFailure` (src/state-dir.ts) first;
 * this does not re-check. Holder is named "unknown" rather than invented
 * when the lock file couldn't be read.
 */
function toDebugLockBusyError(e: AbapError, key: string, lockPath: string): AbapError {
  const holder = fileLockHolderOf(e);

  const held = holder
    ? `held by pid ${holder.pid} on ${holder.hostname} since ${holder.startedAt || "an unknown time"}`
    : "the holder is unknown — the lock file could not be read, or was written by another version";

  return new AbapError(
    "DEBUG_SESSION_LOCKED_CROSS_PROCESS",
    `Cannot start a debug session: another abapsmith process is already holding the debugger ` +
      `slot for this system/client/user (${held}). SAP allows one debug listener per user on a ` +
      `system, so arming a second one would silently reassign or wedge the other session.`,
    { key, lockPath, holder, cause: describeUnknownError(e) },
    `Stop the other debug session (abap_debug with action "stop") and retry. If no other ` +
      `abapsmith process is actually running, this is a stale leftover and you can delete ` +
      `${lockPath} by hand — a holder whose process has died is normally collected ` +
      `automatically within a few seconds. Set ABAP_CROSS_PROCESS_DEBUG_LOCK=false to disable ` +
      `this guard entirely (at the cost of the protection it provides).`,
  );
}

/** A promise plus its settle functions (`Promise.withResolvers` isn't available at this codebase's target `tsconfig` lib). */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * THE cross-process {@link DebugArmLock}, built on `withFileLock`
 * (src/state-dir.ts).
 *
 * `withFileLock(path, fn)` normally releases when `fn` settles, but this
 * lock must stay held from `armListener()` to `doTerminate()` — an interval
 * the caller controls, not the callback. Rather than add a second,
 * non-scope-shaped acquire/release pair to `state-dir.ts` (precisely how a
 * release gets forgotten), the scope is held open from the inside: `fn`
 * signals a `granted` deferred, then awaits a `hold` deferred that
 * {@link release} resolves. Every `withFileLock` ownership rule
 * (nonce-checked release, guaranteed unlink, warn instead of unlinking
 * someone else's file) still applies verbatim. The
 * `Promise.race([granted.promise, settled])` below is the same idiom
 * `armListener()` uses for `Promise.race([handle.armed, handle.result])`.
 *
 * Ref-counted and shared per-process: the one-debug-session-per-process
 * invariant keeps the count normally 0 or 1, but the `releaseOrphanDebuggee`
 * probe session can also hold it, so counting prevents it releasing a lock
 * out from under a real session (same rule {@link FileLockObjectGate} gets
 * via its in-process chain). A second in-process `acquire()` while held
 * increments the count without touching the filesystem — re-contending our
 * own file would deadlock against ourselves.
 */
export class FileLockDebugArmLock implements DebugArmLock {
  private readonly lockPath: string;
  private readonly key: string;
  private readonly waitMs: number;

  /** How many callers currently hold this lock. Released at 0. */
  private holds = 0;
  /** Resolved by {@link release} to end the `withFileLock` scope. */
  private hold?: { resolve: (v: void) => void };
  /** In flight while an acquisition is racing, so concurrent callers await it. */
  private acquiring?: Promise<void>;

  constructor(opts: {
    stateDir: string;
    cfg: { url: string; client?: string; user: string };
    waitMs?: number;
  }) {
    this.lockPath = debugArmLockPath(opts.stateDir, opts.cfg);
    this.key = debugArmLockKey(opts.cfg);
    this.waitMs = opts.waitMs ?? resolveDebugLockWaitMs();
  }

  /** The file this instance contends on. For diagnostics and tests. */
  get path(): string {
    return this.lockPath;
  }

  /** Whether this process currently holds the lock. For tests and diagnostics. */
  get held(): boolean {
    return this.holds > 0;
  }

  async acquire(): Promise<void> {
    // Already ours: take a reference and do not touch the filesystem.
    if (this.holds > 0) {
      this.holds += 1;
      return;
    }
    // Another caller in this process is mid-acquisition. Join it rather than
    // racing it into `EEXIST` against our own lock file.
    if (this.acquiring !== undefined) {
      await this.acquiring;
      this.holds += 1;
      return;
    }

    const attempt = this.run();
    this.acquiring = attempt;
    try {
      await attempt;
    } finally {
      this.acquiring = undefined;
    }
    this.holds = 1;
  }

  release(): void {
    if (this.holds === 0) return;
    this.holds -= 1;
    if (this.holds > 0) return;
    const hold = this.hold;
    this.hold = undefined;
    // Ends the `withFileLock` scope, whose `finally` performs the
    // nonce-checked unlink. Resolving a settled deferred is a no-op, so a
    // double release cannot throw.
    hold?.resolve();
  }

  /**
   * Opens the `withFileLock` scope and resolves once the lock is GRANTED,
   * leaving the scope running until {@link release}.
   */
  private async run(): Promise<void> {
    const granted = deferred<void>();
    const hold = deferred<void>();

    const scope = withFileLock(
      this.lockPath,
      async () => {
        granted.resolve();
        await hold.promise;
      },
      { waitMs: this.waitMs, hardStaleMs: DEBUG_ARM_LOCK_HARD_STALE_MS },
    );

    // Keep the scope's rejection observed: if acquisition fails, `settled`
    // resolves and the race falls through to the re-throw below.
    let failure: unknown;
    const settled = scope.then(
      () => undefined,
      (e: unknown) => {
        failure = e;
        // Nothing will ever resolve `hold` now, and nobody holds the lock.
        this.hold = undefined;
        return undefined;
      },
    );

    await Promise.race([granted.promise, settled]);

    if (failure !== undefined) {
      // Only an ACQUIRE failure is this lock's to reinterpret; anything else
      // is a genuine local disk problem and keeps its own remediation.
      if (isFileLockAcquisitionFailure(failure, this.lockPath)) {
        throw toDebugLockBusyError(failure, this.key, this.lockPath);
      }
      throw failure;
    }

    this.hold = hold;
  }
}

/**
 * Builds the {@link DebugArmLock} the live debug deps inject: the real thing
 * unless the cross-process debug lock is disabled.
 *
 * `enabled`/`waitMs` should be passed from the parsed `Config`
 * (`crossProcessDebugLock`/`debugLockWaitMs`, src/config.ts) by callers that
 * have one (`createLiveDebugToolDeps`, `src/tools/debug.ts`), so the config
 * layer stays authoritative. `env` is for callers without a `Config`
 * (tests); omitting both preserves the pre-existing env-driven defaults.
 *
 * Intended as ONE INSTANCE PER PROCESS, shared between `createSession` and
 * the `releaseOrphanDebuggee` probe so the ref count in
 * {@link FileLockDebugArmLock} sees every holder — two instances over the
 * same state dir would contend against each other for no reason.
 */
export function createDebugArmLock(opts: {
  stateDir: string;
  cfg: { url: string; client?: string; user: string };
  env?: NodeJS.ProcessEnv;
  waitMs?: number;
  enabled?: boolean;
}): DebugArmLock {
  const enabled = opts.enabled ?? resolveCrossProcessDebugLock(opts.env ?? process.env);
  if (!enabled) return new NoopDebugArmLock();
  return new FileLockDebugArmLock({ stateDir: opts.stateDir, cfg: opts.cfg, waitMs: opts.waitMs });
}
