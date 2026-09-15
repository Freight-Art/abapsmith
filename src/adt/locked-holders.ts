/**
 * Best-effort holder attachment for a `LOCKED` refusal.
 *
 * ADT's own lock error names a SESSION (`session.ts`'s `blockingUser`, T100
 * `V1`) — a real user string, when SAP sends one, but not always present.
 * When it is absent, this module makes one extra, read-only guess: look the
 * lock argument up in the enqueue table via the `core.locks` fluid action
 * (`enqueue-read.ts`) and, if that turns up a row, attach it to the error as
 * `details.lock_holders`.
 *
 * This is a diagnostic add-on, never a replacement path:
 *  - It is a SEPARATE lookup, run after the refusal already exists, not part
 *    of classifying the refusal itself.
 *  - It reads the enqueue table (`core.locks`), never writes or dequeues
 *    anything — see `enqueue-read.ts`'s header for why that file has no
 *    release path at all.
 *  - It can fail for any number of ordinary reasons (fluid API off, the
 *    fluid tool not deployed, a transient read error, the lookup simply
 *    finding nothing) and every one of those must produce the exact same
 *    outcome: the original `LOCKED` error, completely unchanged. A failed
 *    diagnostic must never replace or mask the refusal the caller actually
 *    needs to see, and it must never stack a second error on top of the
 *    first.
 */
import { AbapError, isAbapError } from "./errors.js";
import { formatLockHolders, type EnqueueReadResult } from "./enqueue-read.js";

/**
 * Looks up enqueue rows whose lock argument matches `argPattern`. Resolves
 * to `undefined` when the lookup is not available at all (fluid API off/not
 * deployed) — see the callers wiring this in `src/server.ts`.
 */
export type LockHolderLookup = (argPattern: string, callerTool: string) => Promise<EnqueueReadResult | undefined>;

/** How many holder rows are attached. A refusal is a diagnosis, not a lock listing. */
export const LOCK_HOLDER_LIMIT = 5;

/**
 * Attaches enqueue-table holder rows to a `LOCKED` error that ADT itself
 * left unattributed. Returns `e` completely unchanged in every other case:
 * `e` is not a `LOCKED` `AbapError`, ADT already named a `blockingUser`, no
 * `lookup` was wired (fluid API off), `objectName` is missing/blank, or the
 * lookup found nothing. Never turns `e` into a different error and never
 * throws.
 *
 * `callerTool` names the tool that actually invoked this (`abap_write`,
 * `abap_activate`, ...) and only ever reaches `lookup`'s `dispatch` call as
 * its `caller` field, which shapes a refusal message this function then
 * swallows anyway (see the catch block below) — it is threaded through so a
 * log line, or a future surfaced message, names the tool the user actually
 * invoked instead of a hardcoded one.
 */
export async function enrichLockedError(
  e: unknown,
  objectName: string | undefined,
  callerTool: string,
  lookup: LockHolderLookup | undefined,
  warn?: (message: string) => void,
): Promise<unknown> {
  if (!isAbapError(e) || e.code !== "LOCKED") return e;

  // ADT already named a holder (a session, per session.ts's own wording) —
  // that is the better answer already, so this diagnostic adds nothing and
  // must not overwrite or second-guess it.
  const blockingUser = e.details.blockingUser;
  if (typeof blockingUser === "string" && blockingUser.trim() !== "") return e;

  const name = objectName?.trim();
  if (!lookup || !name) return e;

  try {
    // `core.locks` matches its `table` argument against SEQG3-GARG, the
    // lock argument — the field where a repository object's own name shows
    // up in the locks ADT itself takes out. This is an inference from the
    // SEQG3 field semantics, not something checked live against an
    // ADT-held lock, hence the wildcard on both sides rather than an exact
    // match: the real GARG format for a given object type is not pinned
    // down here.
    const argPattern = `*${name.toUpperCase()}*`;
    const result = await lookup(argPattern, callerTool);
    if (!result || result.locks.length === 0) return e;

    const holders = formatLockHolders(result, LOCK_HOLDER_LIMIT);
    if (holders.length === 0) return e;

    const details: Record<string, unknown> = { ...e.details, lock_holders: holders };
    // State the truncation instead of implying it — same reasoning as every
    // other capped list in this codebase (see compact.ts's TRUNCATED idiom).
    if (result.locks.length > LOCK_HOLDER_LIMIT) {
      details.lock_holders_total = result.summary.matched;
    }

    // Same code, message and hint as the original — this lookup answers
    // "who", not "what happened" or "what to do next". In particular the
    // hint's "do not retry" position does not move: knowing who holds the
    // lock does not change whether retrying resolves it (it still does
    // not, per session.ts's LOCK_HINT_TAIL).
    return new AbapError(e.code, e.message, details, e.hint, { // Carries the original refusal's classified retryable through unchanged, so attaching holder rows cannot flip terminal into retryable or back.
      retryable: e.retryable,
    });
  } catch (lookupError) {
    // The lookup itself is a diagnostic, not the operation the caller asked
    // for. Whatever went wrong here (fluid API disabled mid-flight, a
    // transient read failure, a malformed manifest — anything) must never
    // replace or mask the LOCKED refusal the caller actually needs to see,
    // so it is logged and swallowed, and the original error returned as-is.
    warn?.(
      `Lock holder lookup failed (${describeLookupError(lookupError)}); returning the LOCKED ` +
        "refusal unchanged.",
    );
    return e;
  }
}

function describeLookupError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
