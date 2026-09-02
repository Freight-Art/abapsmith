/**
 * Lock-conflict classification and the message an agent actually sees —
 * pinned against `src/adt/session.ts`
 * (`isLockConflict`, the `LOCKED` branch of `translateAdtError`, and
 * `releaseLock`'s `UNLOCK_NOT_A_LEAK`).
 *
 * Pure unit — no `AbapConnection`, no `ConfigSchema.parse`, no network. Kept
 * that way deliberately so this file never has to answer the
 * system-role probe (see `test/system-role-probe-guard.test.ts`).
 *
 * Four areas, each protecting a different way this could go wrong:
 *   A. `isLockConflict`'s three tiers, and — more important than any of the
 *      positive cases — the invariant that a BARE status with no lock-specific
 *      evidence is never a lock conflict. If that invariant breaks, every
 *      `S_DEVELOP` authorization refusal starts looking like "just a lock,
 *      retry later" (see `src/adt/source.ts` / `src/adt/ddic.ts`, which
 *      re-badge a bare 403 `ADT_ERROR` as `AUTH_FAILED`).
 *   B. The rendered message an agent gets for a real lock conflict: it must
 *      identify who holds the lock and on what, and it must actively
 *      discourage a retry loop rather than merely fail to encourage one.
 *   C. A lock conflict must be INERT to `AuthCircuitBreaker` — the difference
 *      between "annoying" and "locks the SAP user out" (five ICF failures is
 *      the lockout threshold; a lock conflict must never spend one).
 *   D. `releaseLock`'s retry loop must not burn attempts against an enqueue
 *      that a different session now holds — a retry cannot change that
 *      answer.
 */
import { describe, expect, it } from "vitest";
import type { ADTClient } from "abap-adt-api";
import { fromException } from "abap-adt-api/build/AdtException.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { StatefulSession, isLockConflict, translateAdtError } from "../src/adt/session.js";
import { AuthCircuitBreaker, type ResponseLike } from "../src/adt/circuit-breaker.js";
import { errorResult } from "../src/server.js";
import { captured } from "./helpers/system-role-fake.js";

// ---------------------------------------------------------------------------
// Fixtures and mechanisms — copied in-file rather than imported from
// test/session.test.ts, to keep this file's unit-only scope independent of
// that file's larger harness.
// ---------------------------------------------------------------------------

/*
 * `captured` is the same accessor test/session.test.ts and
 * test/debug-session.test.ts use for live captures; it comes from the
 * shared ./helpers/system-role-fake.js rather than being re-copied here.
 */

/** Verbatim from test/session.test.ts:64-82 — the ~700-byte LONGTEXT blob included. */
const LONGTEXT_BLOB = `<HTML><HEAD></HEAD><BODY>${"An ENQUEUE lock is held; see transaction SM12. ".repeat(
  14,
)}</BODY></HTML>`;

const LOCK_CONFLICT_XML = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceNoAccess"/>
  <message lang="EN">User DEVELOPER is currently editing ZMCP_PROBE_REP</message>
  <localizedMessage lang="EN">User DEVELOPER is currently editing ZMCP_PROBE_REP</localizedMessage>
  <properties>
    <entry key="LONGTEXT">${LONGTEXT_BLOB.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</entry>
    <entry key="T100KEY-ID">EU</entry>
    <entry key="T100KEY-NO">510</entry>
    <entry key="T100KEY-V1">DEVELOPER</entry>
    <entry key="T100KEY-V2">ZMCP_PROBE_REP</entry>
  </properties>
</exc:exception>`;

/** The same envelope's type id, but with no T100 properties at all — the "no blocking user" shape. */
const LOCK_CONFLICT_XML_NO_T100 = `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionResourceNoAccess"/>
  <message lang="EN">The object is locked</message>
  <localizedMessage lang="EN">The object is locked</localizedMessage>
  <properties/>
</exc:exception>`;

const OK_XML = { "content-type": "application/xml" };

/** Replay a captured/hand-built body through the REAL abap-adt-api error path — test/session.test.ts:698-705. */
function thrownByLibrary(status: number, statusText: string, headers: object, body: string) {
  try {
    throw fromException({ status, statusText, headers, body }, {});
  } catch (e) {
    return e;
  }
}

// ---------------------------------------------------------------------------
// A. isLockConflict — classifier tiers and the false-positive invariant
// ---------------------------------------------------------------------------

describe("A. isLockConflict classifier tiers", () => {
  it("Tier 1: <type id=\"ExceptionResourceNoAccess\"/> classifies as a lock conflict at ANY status, including one LOCK_CONFLICT_STATUSES does not list", () => {
    // 500 is not in LOCK_CONFLICT_STATUSES — proves tier 1 does not gate on
    // status at all, per the doc comment: "at ANY status".
    const e = Object.assign(new Error("some transport-flavoured message"), {
      err: 500,
      type: "ExceptionResourceNoAccess",
      properties: {},
    });
    expect(isLockConflict(e)).toBe(true);
  });

  it("Tier 2: 403 + T100KEY-ID=EU/T100KEY-NO=510 (no type id) classifies as a lock conflict", () => {
    const e = Object.assign(new Error("Enqueue held"), {
      err: 403,
      properties: { "T100KEY-ID": "EU", "T100KEY-NO": "510" },
    });
    expect(isLockConflict(e)).toBe(true);
  });

  it("Tier 2, forward-compat slot: 409 + T100KEY EU/510 classifies as a lock conflict — RECONSTRUCTED, not captured: this is the CLAS/DDIC shape not yet captured live", () => {
    const e = Object.assign(new Error("Conflict: enqueue held by another user"), {
      err: 409,
      properties: { "T100KEY-ID": "EU", "T100KEY-NO": "510" },
    });
    expect(isLockConflict(e)).toBe(true);
  });

  it("Tier 2, forward-compat slot: 423 (WebDAV-flavoured Locked) + T100KEY EU/510 classifies as a lock conflict — RECONSTRUCTED, not captured, same forward-compat slot as the 409 case above", () => {
    const e = Object.assign(new Error("Locked"), {
      err: 423,
      properties: { "T100KEY-ID": "EU", "T100KEY-NO": "510" },
    });
    expect(isLockConflict(e)).toBe(true);
  });

  it("Tier 3: the LIVE-CAPTURED create-path 403 (ExceptionResourceNoAuthorization, empty <properties/>, 'currently editing' text) classifies as a lock conflict", () => {
    // The ONLY genuinely captured fixture in this file — everything else above
    // is either the original capture (LOCK_CONFLICT_XML) or a reconstructed
    // 409/423 shape. Replayed through the real abap-adt-api parser, exactly
    // like test/session.test.ts's B9 blocks, so this also proves the
    // fixture parses the way `fromResponse` expects.
    const xml = captured("602-t2-create-2-recreate.xml");
    const e = thrownByLibrary(403, "Forbidden", OK_XML, xml);
    expect(isLockConflict(e)).toBe(true);
    // And it must reach the agent as LOCKED, not as an authorization failure —
    // this is the bug the tier exists to fix.
    expect(translateAdtError(e, { operation: "create", name: "ZMCP_LK_P" }).code).toBe("LOCKED");
  });

  // -------------------------------------------------------------------------
  // THE INVARIANT THAT MATTERS MOST: a bare status with no lock-specific
  // evidence (no known type id, no EU/510, no corroborating text) must NEVER
  // classify as a lock conflict. `src/adt/source.ts` and `src/adt/ddic.ts`
  // re-badge a bare 403 `ADT_ERROR` as `AUTH_FAILED`; if this predicate stole
  // it first, every real `S_DEVELOP` refusal would tell the operator to wait
  // out a lock that does not exist instead of fixing their authorizations.
  // -------------------------------------------------------------------------

  it("INVARIANT: a bare 403 with an auth-worded message and no lock evidence is NOT a lock conflict, and translateAdtError leaves it ADT_ERROR", () => {
    const e = Object.assign(new Error("No authorization to create objects in package $TMP"), {
      err: 403,
      properties: {},
    });
    expect(isLockConflict(e)).toBe(false);
    expect(translateAdtError(e, { operation: "create" }).code).toBe("ADT_ERROR");
  });

  it("INVARIANT: a bare 409 with no lock evidence is NOT a lock conflict", () => {
    const e = Object.assign(new Error("Conflict: the request could not be completed"), {
      err: 409,
      properties: {},
    });
    expect(isLockConflict(e)).toBe(false);
    expect(translateAdtError(e, { operation: "write" }).code).toBe("ADT_ERROR");
  });

  it("INVARIANT: a bare 423 with no lock evidence is NOT a lock conflict", () => {
    const e = Object.assign(new Error("Locked"), {
      err: 423,
      properties: {},
    });
    expect(isLockConflict(e)).toBe(false);
    expect(translateAdtError(e, { operation: "write" }).code).toBe("ADT_ERROR");
  });

  it("a non-exception value is never a lock conflict — undefined and a plain Error both lack the shape adtExceptionInfo requires", () => {
    expect(isLockConflict(undefined)).toBe(false);
    // A plain Error carries none of `.err`/`.status`/`.type` — adtExceptionInfo's
    // `hasShape` gate returns undefined for it, so isLockConflict short-circuits.
    expect(isLockConflict(new Error("just a plain error, no ADT shape at all"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B. The agent-facing message
// ---------------------------------------------------------------------------

describe("B. the agent-facing LOCKED message", () => {
  it("renders blockingUser, object and adtExceptionType, and a hint that tells the agent what to do without inviting a retry storm", () => {
    const e = thrownByLibrary(403, "Forbidden", OK_XML, LOCK_CONFLICT_XML);
    const err = translateAdtError(e, { operation: "create" });
    expect(err.code).toBe("LOCKED");

    const json = err.toJSON();
    expect(json.error).toBe("LOCKED");
    // `blockingUser`/`object`/`adtExceptionType` are a `details` bag convention
    // this module invents in `translateAdtError` — `AbapError` itself has no
    // such fields; its constructor just stores whatever `details` object it is
    // handed (see src/adt/errors.ts:72-83).
    const details = json.details as Record<string, unknown>;
    expect(details.blockingUser).toBe("DEVELOPER");
    expect(details.object).toBe("ZMCP_PROBE_REP");
    expect(details.adtExceptionType).toBe("ExceptionResourceNoAccess");

    const hint = err.hint ?? "";
    // Tells the agent what to DO...
    expect(hint).toMatch(/Do NOT retry in a loop/);
    expect(hint).toMatch(/sap-contextid/);
    expect(hint).toMatch(/DEVELOPER/);
    expect(hint).toMatch(/ZMCP_PROBE_REP/);
    // ...and does not invite the retry storm the hint exists to prevent. No
    // "try again"/"retry shortly|later" phrasing (there is NO lock timeout
    // while the holding session lives), and no SM12 pointer
    // (that belongs to the lock-LEAK hint in releaseLock, where the stranded
    // enqueue really is ours to clean up — not here, where it is someone else's).
    expect(hint).not.toMatch(/try again|retry (shortly|later)|SM12|LONGTEXT/i);

    // The ~700-byte LONGTEXT HTML blob must never survive to this boundary —
    // it is stripped one layer down, in adtExceptionInfo.
    const rendered = JSON.stringify(json);
    expect(rendered).not.toMatch(/<HTML>/i);
  });

  it("the no-blocking-user branch (type id present, no T100 properties) still yields a usable hint with the same no-retry guidance", () => {
    const e = thrownByLibrary(403, "Forbidden", OK_XML, LOCK_CONFLICT_XML_NO_T100);
    const err = translateAdtError(e, { operation: "lock" });
    expect(err.code).toBe("LOCKED");
    // No T100KEY-V1 in this envelope, so there is no blocking user to name.
    expect(err.details.blockingUser).toBeUndefined();

    const hint = err.hint ?? "";
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).toMatch(/Do NOT retry in a loop/);
    expect(hint).toMatch(/sap-contextid/);
    expect(hint).not.toMatch(/try again|retry (shortly|later)|SM12|LONGTEXT/i);
  });

  it("envelope budget: the rendered payload stays comfortably under MAX_ERROR_ENVELOPE_CHARS (4000, src/server.ts:102)", () => {
    // `MAX_ERROR_ENVELOPE_CHARS` is a module-private const in src/server.ts, not
    // exported — the literal is copied here from src/server.ts:102.
    // Rendered through the REAL MCP boundary:
    // errorResult() on an already-translated AbapError takes the `isAbapError`
    // branch (src/server.ts:317-326), which is exactly what every tool handler
    // does today (they catch whatever translateAdtError produced, or the raw
    // throw, and hand it straight to errorResult — see src/server.ts:713-717).
    const e = thrownByLibrary(403, "Forbidden", OK_XML, LOCK_CONFLICT_XML);
    const err = translateAdtError(e, { operation: "create" });
    const res = errorResult(err);
    const text = (res.content[0] as { type: "text"; text: string }).text;
    // Measured today: ~815 chars for the blocking-user case — "comfortably
    // under" 4000, not brushing against the ceiling.
    expect(text.length).toBeLessThan(4_000);
    expect(text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// C. A lock-403 is inert to the circuit breaker
// ---------------------------------------------------------------------------

describe("C. a lock-403 is inert to AuthCircuitBreaker (the difference between annoying and locking the SAP user)", () => {
  it("inspect() on a lock-conflict response neither trips the auth latch nor moves the transient counters", () => {
    const breaker = new AuthCircuitBreaker();

    // Seed two ordinary transient failures first, so a bug that made the lock
    // response count as EITHER a failure (3rd, not 2nd) OR a success (reset to
    // 0) would be visible either way.
    breaker.recordTransientFailure();
    breaker.recordTransientFailure();
    expect(breaker.status().consecutiveFailures).toBe(2);

    const lockResp: ResponseLike = { status: 403, headers: OK_XML, body: LOCK_CONFLICT_XML };
    const result = breaker.inspect(lockResp);

    // No auth trip: inspect() returns a TripInfo only when it just latched.
    expect(result).toBeUndefined();
    expect(breaker.isTripped).toBe(false);
    expect(breaker.status().state).toBe("closed");
    // Neither a failure (would be 3) nor a success (would reset to 0): a 403
    // with no WWW-Authenticate challenge and no session-death shape falls
    // through inspect()'s status-range checks entirely (it is not >=500, not
    // 408/429, not 200-399), so neither recordTransientFailure nor
    // recordSuccess ever runs for it.
    expect(breaker.status().consecutiveFailures).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// D. releaseLock does not retry on LOCKED
// ---------------------------------------------------------------------------

/**
 * `AdtErrorException`-shaped throw — test/session.test.ts's B8 harness,
 * copied in-file rather than imported from that file. Keys on a
 * numeric `.err`, which is what `abap-adt-api` sets (`AdtException.js:47`).
 */
const adtThrow = (status: number, message: string): Error =>
  Object.assign(new Error(message), { err: status, properties: {} });

/** The same shape, but carrying a `<type id="…"/>` — for the lock-conflict case. */
const adtLockThrow = (status: number, message: string, type: string): Error =>
  Object.assign(new Error(message), { err: status, type, properties: {} });

/** Minimal ADTClient stand-in — copied from test/session.test.ts's B8 harness (~:862-880). */
function fakeLockClient(onUnlock: (uri: string, nthForThisUri: number) => void = () => {}) {
  const unlocks: string[] = [];
  const counts = new Map<string, number>();
  const client = {
    async lock(uri: string) {
      return { LOCK_HANDLE: `H${uri.slice(-1).toUpperCase()}`, IS_LOCAL: "X" };
    },
    async unLock(uri: string, handle: string) {
      unlocks.push(`${uri}#${handle}`);
      const n = (counts.get(uri) ?? 0) + 1;
      counts.set(uri, n);
      onUnlock(uri, n);
    },
  } as unknown as ADTClient;
  return { client, unlocks };
}

const A = "/sap/bc/adt/programs/programs/zmcp_a";

/** No wall-clock cost for the backoff — copied from test/session.test.ts's B8 harness (~:885). */
const fast = { unlockRetryDelayMs: 0, sleep: async () => {}, log: () => {} };

describe("D. releaseLock does not retry on LOCKED", () => {
  it("UNLOCK refused with a lock conflict (403 + ExceptionResourceNoAccess) is called exactly once, does not throw, and is not counted as a leak", async () => {
    const { client, unlocks } = fakeLockClient(() => {
      throw adtLockThrow(403, "User DEVELOPER is currently editing ZMCP_A", "ExceptionResourceNoAccess");
    });
    const s = new StatefulSession(client, fast);
    await s.lock(A);

    // Pinning what src/adt/session.ts does TODAY: LOCKED is a member of
    // UNLOCK_NOT_A_LEAK, so releaseLock drops the ledger entry and returns
    // quietly rather than retrying or escalating. This is the right trade —
    // the enqueue is held by a DIFFERENT session now, so this handle is stale
    // and a retry cannot possibly change the answer (an uncoordinated retry
    // here once burned three requests with 150ms/300ms backoff for a
    // question already answered on the first try).
    await expect(s.unlock(A)).resolves.toBeUndefined();

    // The "did not retry" idiom: exactly one call reached the fake transport,
    // not the default three-attempt budget.
    expect(unlocks).toEqual([`${A}#HA`]);
    expect(s.leakedLocks).toEqual([]);
    // The ledger entry is gone either way (see UNLOCK_NOT_A_LEAK's comment: for
    // LOCKED the enqueue is very much NOT gone, just no longer ours to release,
    // and the production code's own log line says exactly that distinction).
    expect(s.heldLocks).toEqual([]);
  });

  it("control: a 500 on UNLOCK still burns the full retry budget — proving the LOCKED no-retry above is specific to LOCKED, not a general 'give up on first failure'", async () => {
    const { client, unlocks } = fakeLockClient(() => {
      throw adtThrow(500, "Internal Server Error");
    });
    const s = new StatefulSession(client, fast);
    await s.lock(A);

    const err = await s.unlock(A).catch((e: unknown) => e);

    // All three attempts (1 + default unlockRetries of 2) were made.
    expect(unlocks).toEqual([`${A}#HA`, `${A}#HA`, `${A}#HA`]);
    expect(isAbapError(err)).toBe(true);
    expect((err as AbapError).details.reason).toBe("lock-leaked");
    expect(s.leakedLocks).toHaveLength(1);
  });
});
