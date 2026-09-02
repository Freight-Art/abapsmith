/**
 * Shared helpers for the live suite's "appliance state" outcomes.
 *
 * "Not exercised" and "misbehaved" are different outcomes: a test that cannot
 * run because the appliance is in an unexpected state — a fixture that was
 * never deployed, a stranded debug session left by an earlier run — must
 * SKIP with a stated reason, not fail like a real regression. A test that DID
 * run but hit a failure shape that is itself appliance state (system down,
 * breaker tripped, a request timing out under work-process contention) still
 * FAILS — see `underApplianceStateWatch` — just with the same greppable
 * prefix, so a sweep log can tell both apart from a real regression.
 *
 * ENTIRELY inert offline: nothing here opens a connection on import, and the
 * only two files that import it (`integration.test.ts`,
 * `integration-debug.test.ts`) are themselves excluded from `npm test` by
 * `vitest.config.ts` unless `ABAP_URL` is set. Modelled on `pool-doubles.ts`:
 * a plain non-test helper module, not collected by vitest itself.
 */
import type { TestContext } from "vitest";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
import type { AbapConnection } from "../src/adt/connection.js";
import { abapRead } from "../src/tools/read.js";

/**
 * Every skip minted for an environmental reason carries this prefix, so a
 * reader — or a grep over a sweep log — can separate "we could not run this"
 * from "this failed".
 */
export const APPLIANCE_STATE_PREFIX = "APPLIANCE STATE:";

/** Skip the current test with a stated, greppable reason. `ctx.skip` throws, so this never returns. */
export function skipForApplianceState(ctx: TestContext, reason: string): never {
  ctx.skip(`${APPLIANCE_STATE_PREFIX} ${reason}`);
}

export type ExistenceResult = { present: true } | { present: false; reason: string };

/**
 * A missing object surfaces through `abapRead` two different ways: a clean
 * `NOT_FOUND` when resolution itself fails, or a generic `ADT_ERROR` when the
 * name resolves deterministically (an explicit type hint like `"table type
 * X"` skips the existence-checking search — see `resolveObject`) and the
 * DDIC runtime only discovers the row is missing while importing it ("Error
 * while importing object X from the database"). Everything else — a tripped
 * breaker, 401/403, a lock, a dead session — is a real problem, not absence.
 */
function describesAbsence(e: AbapError): boolean {
  if (e.code === "NOT_FOUND") return true;
  return e.code === "ADT_ERROR" && /importing object .* from the database|does not exist/i.test(e.message);
}

// ---------------------------------------------------------------------------
// Failure-shape classification
//
// Free dialog work processes are not visible over ADT — that needs SM50-class
// data (doc/CONCURRENCY/several-agents-one-sandbox.md § "Why the failure mode is nasty"). What IS visible
// is the failure SHAPE contention (and other appliance-state problems)
// produces, so a mid-run failure can classify itself instead of needing a
// human to read the error text. Matched ONLY on structured `AbapError.code` /
// `details` fields already minted elsewhere in this repo — never on message
// text — and every branch below cites where that code is minted.
// ---------------------------------------------------------------------------

export type ApplianceStateVerdict =
  | { applianceState: false }
  | { applianceState: true; signature: string; reason: string };

const NOT_APPLIANCE_STATE: ApplianceStateVerdict = { applianceState: false };

/**
 * Deliberately NOT matched, because each is a real ambiguity, not an oversight:
 *  - `AUTH_FAILED` / `AUTH_CIRCUIT_OPEN` — credentials/config, not appliance
 *    state. (Pre-`connect-failure.ts` an outage could produce `AUTH_FAILED`
 *    with a 500; that's fixed, so today it really does mean 401/403.)
 *  - `SESSION_DEAD` — genuinely ambiguous: idle expiry / appliance restart
 *    (environmental) vs. a short dump THIS run caused (behavioural).
 *  - `NOT_FOUND` / `LOCKED` — context-dependent; `describesAbsence` above
 *    already handles the fixture-absence reading of `NOT_FOUND` narrowly.
 * No `SYSTEM_NO_ROLL` / `TIME_OUT` / `DYNPRO` / `RFC_*` / "no free work
 * process" text — none of those strings occur anywhere in this repo.
 */
export function classifyApplianceStateFailure(e: unknown): ApplianceStateVerdict {
  if (!isAbapError(e)) return NOT_APPLIANCE_STATE;
  switch (e.code) {
    // classifyConnectFailure, HTTP 5xx at logon (src/adt/connect-failure.ts:223-231).
    case "SYSTEM_UNAVAILABLE":
      return { applianceState: true, signature: e.code, reason: "system down or restarting at logon" };
    // classifyConnectFailure, transport/TLS below HTTP — NETWORK_CODES (src/adt/connect-failure.ts:76-86).
    case "CONNECT_FAILED":
      return { applianceState: true, signature: e.code, reason: "transport failure reaching the host" };
    // transientOpenError (http-guard.ts:403) mints this as a real AbapError; inspect() counts
    // 5xx/408/429 as transient (src/adt/circuit-breaker.ts:208-217,498-512). BreakerOpenError
    // (circuit-breaker.ts:209) carries the same code but is a plain Error, not an AbapError —
    // not caught here, currently unreachable since guardedRequest() has no callers.
    case "CIRCUIT_OPEN_TRANSIENT":
      return { applianceState: true, signature: e.code, reason: "transient circuit breaker open (5xx/408/429)" };
    // SafetyGate.roleProbeFailure: the connection dropped below HTTP mid-probe (src/adt/errors.ts:36-48).
    case "ROLE_PROBE_FAILED":
      return { applianceState: true, signature: e.code, reason: "connection dropped below HTTP during the role probe" };
    // FileLockObjectGate / FileLockDebugArmLock: another process holds the lock (src/adt/errors.ts:178-197).
    case "OBJECT_LOCKED_CROSS_PROCESS":
    case "DEBUG_SESSION_LOCKED_CROSS_PROCESS":
      return { applianceState: true, signature: e.code, reason: "another process holds the cross-process lock" };
    case "ADT_ERROR":
      // src/adt/source.ts:63-73 mints `details.timeout === true` for a transport
      // timeout with no response at all. doc/CONCURRENCY/several-agents-one-sandbox.md: contention
      // surfaces as queue delay first, then as exactly this — a request parking
      // for a free work process, not a request being refused. Matched on the
      // structured flag, never on message text.
      if (e.details.timeout === true) {
        return { applianceState: true, signature: "ADT_ERROR:timeout", reason: "request timed out (possible work-process contention)" };
      }
      return NOT_APPLIANCE_STATE;
    default:
      return NOT_APPLIANCE_STATE;
  }
}

/**
 * Runs `fn()` and classifies a throw — but never converts one to a skip. On an
 * appliance-state failure the rethrown error's message is prefixed with
 * `APPLIANCE_STATE_PREFIX` and names `label`/the verdict's reason, `cause` set
 * to the original error, so a grep over a sweep log separates "failed for an
 * environmental reason" from a real regression. The test still goes red: a
 * mechanism that turns real problems into green-looking skips is worse than
 * the failure it replaces. Any other error is rethrown UNTOUCHED.
 */
export async function underApplianceStateWatch<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const verdict = classifyApplianceStateFailure(e);
    if (!verdict.applianceState) throw e;
    throw new Error(`${APPLIANCE_STATE_PREFIX} ${label}: ${verdict.reason} (${verdict.signature})`, {
      cause: e,
    });
  }
}

/**
 * Read-only existence probe. Answers whether `object` is present without
 * throwing on absence — but a real error (auth, breaker, lock, ...) is
 * rethrown, never reinterpreted as "not present".
 */
export async function probeObjectExists(conn: AbapConnection, object: string): Promise<ExistenceResult> {
  return underApplianceStateWatch(`probeObjectExists(${object})`, async () => {
    try {
      await abapRead(conn, { object }, 200);
      return { present: true };
    } catch (e) {
      if (isAbapError(e) && describesAbsence(e)) return { present: false, reason: e.message };
      throw e;
    }
  });
}
