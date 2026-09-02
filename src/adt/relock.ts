/**
 * Re-lock-after-failure for whole-document PUT flows.
 *
 * After ANY PUT that errors, the lock handle is dead server-side — every
 * subsequent PUT on it answers 423 ("invalid lock handle"), an OBSERVED,
 * SAP-undocumented behavior that turns one bad element into a misleading
 * 423 cascade that looks like a concurrency problem and isn't. Fix: on any
 * non-2xx, discard the handle, re-acquire a fresh lock, re-read the model
 * under it, rebuild the payload from the FRESH bytes (never the stale
 * pre-failure one — BOPF rewrites GUIDs/`bo:xmlName`/`TO_PARENT`/`TO_ROOT`
 * on every PUT), then retry.
 *
 * Modelled on `writeObject`'s inline version of this law (`src/adt/write.ts`
 * step 4/4a, ~lines 1409-1530); not extracted into a shared helper — see
 * the git history for why. Any new whole-document
 * writer (e.g. the ENHO/ENHS enhancement path) should call `withRelockRetry`
 * directly rather than fork a third copy of this law.
 *
 * Rides a `StatefulSession` the caller already opened via
 * `AbapConnection.withStatefulSession`; never opens its own connection.
 */
import type { LockInfo, StatefulSession } from "./session.js";
import { translateAdtError } from "./session.js";
import { AbapError, isAbapError } from "./errors.js";

export interface RelockOptions<T> {
  session: StatefulSession;
  uri: string;
  /** BOPF: capital-R `Result`. Omitted ⇒ the session's default lowercase `result`. */
  lockAccept?: string;
  /** Total attempts across the whole call, lock included. Default 2. */
  maxAttempts?: number;
  /** Re-read under the lock. Its return feeds `rebuild`, every attempt. */
  reread: (lock: LockInfo) => Promise<string>;
  /** Rebuild from the freshly-read bytes — never reuse the previous payload (stale by construction; see module header). */
  rebuild: (fresh: string, attempt: number) => Promise<string>;
  attempt: (lock: LockInfo, payload: string) => Promise<T>;
  /** Default: retryable unless `SAFETY_DENIED`/`BAD_INPUT`/`LOCKED` — a fresh lock can't fix those, only wastes two requests reproducing the refusal. */
  retryable?: (e: unknown) => boolean;
}

/** Default `retryable`: opt OUT for the three failure kinds a fresh lock cannot fix. */
function defaultRetryable(e: unknown): boolean {
  if (isAbapError(e) && (e.code === "SAFETY_DENIED" || e.code === "BAD_INPUT" || e.code === "LOCKED")) {
    return false;
  }
  return true;
}

/**
 * Tags the final error with `attempts`/`uri` so "same failure every attempt"
 * (model is wrong) is distinguishable from "different failures" (lock kept
 * dying) without re-deriving it from logs. Rebuilds a new `AbapError` since
 * `details` isn't mutable post-construction; non-`AbapError` throws go
 * through `translateAdtError` first.
 */
function annotateExhausted(e: unknown, uri: string, attempts: number): AbapError {
  const base = isAbapError(e) ? e : translateAdtError(e, { operation: "write", uri });
  return new AbapError(
    base.code,
    base.message,
    { ...base.details, attempts, uri },
    base.hint,
  );
}

/**
 * Lock → re-read → rebuild → attempt, fresh lock and fresh bytes on every
 * retry. On failure: not retryable ⇒ rethrow, lock left as-is (caller's
 * `withStatefulSession` unwinds it). `SESSION_DEAD` ⇒ `forgetLock` only, no
 * `unlock` — a dead session already released its enqueues server-side and
 * can't receive one. Otherwise: best-effort `unlock` FIRST, THEN
 * `forgetLock` — reversed order used to leak the enqueue server-side because
 * `unlock` silently no-ops once the ledger entry is gone (incident; see
 * the git history). Exhausted ⇒ rethrow the last error
 * seen, annotated (`annotateExhausted`).
 */
export async function withRelockRetry<T>(o: RelockOptions<T>): Promise<T> {
  const maxAttempts = o.maxAttempts ?? 2;
  const isRetryable = o.retryable ?? defaultRetryable;

  let lastError: unknown;

  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
    const lock = o.lockAccept
      ? await o.session.lock(o.uri, { accept: o.lockAccept })
      : await o.session.lock(o.uri);

    try {
      const fresh = await o.reread(lock);
      const payload = await o.rebuild(fresh, attemptNo);
      return await o.attempt(lock, payload);
    } catch (e) {
      lastError = e;

      if (!isRetryable(e)) throw e;

      // Dead session: no unlock, see module header.
      if (isAbapError(e) && e.code === "SESSION_DEAD") {
        o.session.forgetLock(o.uri);
        throw e;
      }

      const attemptsRemain = attemptNo < maxAttempts;

      // unlock before forgetLock — order is load-bearing, see module header.
      try {
        await o.session.unlock(o.uri);
      } catch {
        // Best-effort — StatefulSession.unlock already retries/escalates; swallow so it can't mask the real error.
      }
      o.session.forgetLock(o.uri);

      if (!attemptsRemain) break;
      // Otherwise loop: fresh lock, fresh read, fresh rebuild — never reuse this payload.
    }
  }

  throw annotateExhausted(lastError, o.uri, maxAttempts);
}
