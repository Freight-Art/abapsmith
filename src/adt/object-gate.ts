/**
 * `ObjectGate` — same-object write serialisation, in-process and cross-process.
 *
 * Split out of `src/adt/pool.ts` (see the git history
 * for the rationale). `pool.ts` re-exports every name below, so no import site
 * outside this file and `pool.ts` needed to change when the code moved.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import { fileLockHolderOf, isFileLockAcquisitionFailure, withFileLock } from "../state-dir.js";
import { AbapError, describeUnknownError } from "./errors.js";
import { objectUriOf } from "./session.js";

// ---------------------------------------------------------------------------
// ObjectGate — the interface
// ---------------------------------------------------------------------------

/**
 * Serialises operations that target the same ABAP object.
 *
 * An interface (not an inline `Map`) so the in-process implementation can be
 * swapped for a cross-process, `withFileLock`-backed one ({@link FileLockObjectGate})
 * without touching call sites. `AdtSessionPool.withWrite` applies `objectUriOf()`
 * before calling `run()`, so every implementation gets the identical canonical
 * key; implementations should still apply it (idempotent) to defend a direct
 * caller. See archive for why a second canonicaliser would be a bug here.
 */
export interface ObjectGate {
  run<T>(objectUri: string, fn: () => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// ObjectGate — in-process implementation
// ---------------------------------------------------------------------------

/**
 * `Map`-backed, single-process {@link ObjectGate}: one promise chain per
 * canonical object URI. THE DEFAULT since 2026-08-07 — opt out via
 * `ABAP_SERIALISE_SAME_OBJECT_WRITES=false` (selects {@link NoopObjectGate}).
 *
 * Keys with `objectUriOf()` from `src/adt/session.ts` — the same
 * canonicaliser `StatefulSession` keys its lock ledger with; do not
 * reimplement it here (see archive).
 *
 * Chain survives a throwing predecessor (`prev.then(fn, fn)`) so one failing
 * write doesn't wedge later writes to the same object.
 *
 * Deliberately no timeout — the waiter's predecessor is already bounded by
 * the slot budget and the HTTP timeout; see archive.
 */
export class InProcessObjectGate implements ObjectGate {
  /** key -> tail of the chain. Entries are deleted once they ARE the tail. */
  private readonly chains = new Map<string, Promise<void>>();

  /** Live keys, for tests and diagnostics. Must return to 0 when idle. */
  get pending(): number {
    return this.chains.size;
  }

  run<T>(objectUri: string, fn: () => Promise<T>): Promise<T> {
    const key = objectUriOf(objectUri);
    const prev = this.chains.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, settled);
    void settled.then(() => {
      // Only the tail may clear the entry, so a middle link finishing can't
      // let a later caller jump the queue.
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return result;
  }
}

/**
 * The explicit-opt-out {@link ObjectGate}: a genuine pass-through (`run`
 * returns `fn()` directly). Same-object writes run concurrently. Selected
 * only via `ABAP_SERIALISE_SAME_OBJECT_WRITES=false` or direct injection —
 * never by leaving the setting unset; see {@link InProcessObjectGate}.
 *
 * Safe to opt into only because a PRE-ACTIVATION ETAG GUARD
 * (`src/tools/write.ts`, `src/adt/undo.ts`) now catches the lost-update race
 * this bypass used to allow — narrows, but does not close, the window. See
 * archive for the full incident and the guard's honest limit.
 *
 * No `pending` member: {@link ObjectGate} doesn't declare one and this gate
 * has no state.
 */
export class NoopObjectGate implements ObjectGate {
  run<T>(_objectUri: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

// ---------------------------------------------------------------------------
// ObjectGate — cross-process implementation
// ---------------------------------------------------------------------------

/**
 * `ABAP_OBJECT_LOCK_WAIT_MS` → default 1 500 ms, range 200…30 000 ms,
 * out-of-range falls back to default (not clamped, so a bad value doesn't
 * look like it took effect). Deliberately its own env var, not
 * `ABAP_LOCK_WAIT_MS` — that one is sized for a same-process cooperative
 * wait; this one for a genuinely different process/session holding the lock.
 *
 * Also expressed as `Config.objectLockWaitMs` (`src/config.ts`); the
 * two are kept equal by `test/object-gate-config-equivalence.test.ts`, not by
 * one calling the other (`config.ts` is parsed before `src/adt` exists).
 */
export function resolveObjectLockWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const DEFAULT_MS = 1_500;
  const MIN_MS = 200;
  const MAX_MS = 30_000;
  const raw = env.ABAP_OBJECT_LOCK_WAIT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MS;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MS;
  const ms = Math.floor(n);
  if (ms < MIN_MS || ms > MAX_MS) return DEFAULT_MS;
  return ms;
}

/**
 * Whether {@link AdtSessionPool} installs {@link FileLockObjectGate} (`true`,
 * the default) or falls back to {@link InProcessObjectGate} (`false`).
 * `ABAP_CROSS_PROCESS_OBJECT_LOCK` → default true; "false"/"0"/"no"/"off"
 * (case-insensitive) opts out. Only matters when `serialiseSameObjectWrites`
 * hasn't already selected {@link NoopObjectGate}.
 *
 * Also expressed as `Config.crossProcessObjectLock` (`src/config.ts`)
 * so it's validated and visible in `redactConfigSecrets`. Kept in lockstep with this
 * function by `test/object-gate-config-equivalence.test.ts`, not by delegation.
 */
export function resolveCrossProcessObjectLock(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ABAP_CROSS_PROCESS_OBJECT_LOCK;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === "") return true;
  return !["false", "0", "no", "off"].includes(v);
}

/**
 * Hex width of the object-lock filename hash. 20 chars = 80 bits; see
 * {@link objectGateLockPath} for why that is enough.
 */
const LOCK_HASH_HEX_LEN = 20;

/**
 * `<stateDir>/locks/objects/<sha256(objectUri)-20hex>.lock` — the cross-process
 * lock file for one object. URI is hashed because it's a full ADT path, not a
 * legal filename component everywhere; 20 hex chars (80 bits) is a lock
 * namespace, not a security boundary, so a birthday collision isn't a
 * realistic concern. Exported for tests to assert on / pre-create the file.
 */
export function objectGateLockPath(stateDir: string, objectUri: string): string {
  const key = objectUriOf(objectUri);
  const hash = createHash("sha256").update(key).digest("hex").slice(0, LOCK_HASH_HEX_LEN);
  return path.join(stateDir, "locks", "objects", `${hash}.lock`);
}

/**
 * Re-wraps a lock-acquisition failure into `OBJECT_LOCKED_CROSS_PROCESS`,
 * naming the object rather than the lock file's path as the primary fact —
 * the interesting condition here is "someone else is editing this object",
 * not a disk problem. Callers MUST check `isFileLockAcquisitionFailure`
 * first — this does not re-check, so it is not safe to call on whatever
 * `fn()` threw.
 */
function toObjectLockBusyError(e: AbapError, objectUri: string, lockPath: string): AbapError {
  const holder = fileLockHolderOf(e);

  const held = holder
    ? `held by pid ${holder.pid} on ${holder.hostname} since ${holder.startedAt || "an unknown time"}`
    : "the holder is unknown — the lock file could not be read, or was written by another version";

  return new AbapError(
    "OBJECT_LOCKED_CROSS_PROCESS",
    `Cannot lock ${objectUri} for editing: another abapsmith process (or external session) is ` +
      `holding this object's cross-process lock (${held}). This object was left in a ` +
      `possibly-inconsistent state if that session did not finish; wait for it to complete or ` +
      `confirm it is stale before retrying.`,
    { objectUri, lockPath, holder, cause: describeUnknownError(e) },
    `If no other abapsmith process (and no SAP GUI/Eclipse session sharing this gate) is ` +
      `actually running, this is a stale leftover and you can delete ${lockPath} by hand. ` +
      `Raise ABAP_OBJECT_LOCK_WAIT_MS (currently the process default) if the other session is ` +
      `real but merely slow.`,
  );
}

/**
 * THE cross-process {@link ObjectGate}: composes {@link InProcessObjectGate}
 * with `withFileLock` (src/state-dir.ts) rather than replacing it, so two
 * abapsmith PROCESSES can't interleave writes to one object, on top of the
 * same-process FIFO ordering the in-process gate already gives.
 *
 * Composition order matters: `run()` enters the in-process chain first and
 * takes the file lock only once it's this process's turn
 * (`inner.run(objectUri, () => withFileLock(lockPath, fn))`) — see archive
 * for why inverting that would be wrong.
 *
 * On a cross-process timeout, rejects with `OBJECT_LOCKED_CROSS_PROCESS`
 * (see {@link toObjectLockBusyError}), never the raw `JOURNAL_IO` `withFileLock`
 * throws.
 */
/**
 * How long a lock HOLDER may run before its lock is treated as abandoned.
 * Passed explicitly rather than derived from `waitMs` (do NOT re-derive it —
 * that conflation is the defect this guards against): a legitimate gated
 * write can take ~7 sequential ADT round trips, up to roughly 420 s; 600 000 ms
 * is the next round number above that. See archive for the full derivation.
 * An ordinary crashed holder is still collected far sooner by `withFileLock`'s
 * dead-pid rule (~3 s); this backstop only covers pid reuse, a foreign
 * hostname, or an unparseable payload.
 */
const OBJECT_LOCK_HARD_STALE_MS = 600_000;

export class FileLockObjectGate implements ObjectGate {
  private readonly inner = new InProcessObjectGate();
  private readonly stateDir: string;
  private readonly waitMs: number;

  constructor(opts: { stateDir: string; waitMs?: number }) {
    this.stateDir = opts.stateDir;
    this.waitMs = opts.waitMs ?? resolveObjectLockWaitMs();
  }

  run<T>(objectUri: string, fn: () => Promise<T>): Promise<T> {
    return this.inner.run(objectUri, async () => {
      const lockPath = objectGateLockPath(this.stateDir, objectUri);
      try {
        return await withFileLock(lockPath, fn, {
          waitMs: this.waitMs,
          hardStaleMs: OBJECT_LOCK_HARD_STALE_MS,
        });
      } catch (e) {
        // Only a failure to ACQUIRE the lock is this gate's business; whatever
        // fn() itself threw propagates unchanged.
        if (isFileLockAcquisitionFailure(e, lockPath)) {
          throw toObjectLockBusyError(e, objectUriOf(objectUri), lockPath);
        }
        throw e;
      }
    });
  }
}
