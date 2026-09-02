/**
 * The pool COMPOSED with the connection lifecycle.
 *
 * `src/adt/pool.ts` and `AbapConnection`'s death lifecycle shipped as
 * two correct halves that did not touch. `pool.ts` mentioned neither `isDead`
 * nor `onDead` nor `markDead` anywhere, and kept a private `slot.dead` boolean
 * it set from exactly one place — a `SESSION_DEAD` thrown out of the caller's
 * own `fn`. Everything the CONNECTION knew about its own death was invisible to
 * the pool. Two consequences, both silent:
 *
 *   1. A connection that died any other way — under `connect()`, under a
 *      request the pool did not classify, under a caller holding `primary()`
 *      directly — stayed "idle, healthy" in `stats()` and WAS HANDED TO THE
 *      NEXT CALLER, who then got `SESSION_DEAD` from `assertUsable()`.
 *
 *   2. A DEBUG LEASE had no death path AT ALL. `reserveDebug` hands out a lease
 *      the caller owns for the length of a long poll and releases explicitly;
 *      there is no `finally` bounding it. A connection dying mid-poll therefore
 *      pinned its slot `busy` forever — and at the shipped `maxSessions: 1`
 *      that is the entire pool, wedged for the life of the process, refusing
 *      every read and write with `lease-held` on behalf of a debugger that no
 *      longer exists.
 *
 * This file also pins the reconciliation of `acquire()` with `runOn` (they
 * disagreed about auth failures, and `runOn` was right) and the bound on the
 * preparation retry loop.
 *
 * ENTIRELY OFFLINE — see `test/pool-doubles.ts`.
 */
import { describe, expect, it } from "vitest";
import { AbapConnection, type ConnectionOptions } from "../src/adt/connection.js";
import { AdtSessionPool } from "../src/adt/pool.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { AbapError } from "../src/adt/errors.js";
import { SessionBusyError } from "../src/adt/session-lock.js";
import type { Config } from "../src/config.js";
import { cfg, clock, deferred, factory, settle, type Sizing } from "./pool-doubles.js";

function makePool(over: Partial<Sizing> = {}, extra: Record<string, unknown> = {}) {
  const f = factory();
  const c = clock();
  const pool = new AdtSessionPool({
    cfg: cfg(over),
    breaker: new AuthCircuitBreaker(),
    createConnection: f.create,
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    ...extra,
  });
  return { pool, f, c };
}

// ===========================================================================
// 0. The doubles must not drift from the class they stand in for
// ===========================================================================

/**
 * `test/pool-doubles.ts` hand-implements `isDead` / `markDead` / `onDead`, and
 * a hand-written mirror is only as good as the day it was written. This reads
 * the REAL `AbapConnection.prototype` — it never constructs one, so this file
 * stays out of the connection-building population `system-role-probe-guard`
 * polices, and it opens nothing.
 *
 * If the death lifecycle renames or re-kinds any of the three, this goes red HERE, next to the
 * doubles, instead of leaving every test below quietly asserting against an API
 * that no longer exists.
 */
describe("the death API the pool composes with", () => {
  it("AbapConnection still declares isDead (getter), markDead and onDead (methods)", () => {
    const proto = AbapConnection.prototype as unknown as Record<string, unknown>;
    const isDead = Object.getOwnPropertyDescriptor(proto, "isDead");
    expect(isDead, "isDead must exist on the prototype").toBeDefined();
    expect(typeof isDead!.get, "isDead is a getter, not a data property").toBe("function");
    expect(isDead!.set, "and it is read-only — death is declared via markDead()").toBeUndefined();
    expect(typeof proto["markDead"]).toBe("function");
    expect(typeof proto["onDead"]).toBe("function");
    expect(AbapConnection.prototype.markDead.length, "markDead(reason)").toBe(1);
    expect(AbapConnection.prototype.onDead.length, "onDead(listener)").toBe(1);
  });

  /**
   * `pool.ts` used to read `heldLockUris()` too (`stillHoldsLocks()`, now deleted —
   * it was dead in production, see `pool.ts`'s `releaseSlot()` comment). `heldLockUris()` is
   * still load-bearing elsewhere, though: `AbapConnection` reads its own ledger for death
   * payloads and error details (`connection.ts`), and
   * `test/connection-liveness.test.ts`'s lock-leak-diagnostics block asserts against it directly to pin
   * the real leak-then-drop path. Rename or re-kind it upstream and those go red — so this
   * stays as a cheap prototype-shape pin, independent of which caller currently reads it.
   */
  it("AbapConnection still declares heldLockUris(), still read elsewhere for lock-leak diagnostics", () => {
    const proto = AbapConnection.prototype as unknown as Record<string, unknown>;
    expect(typeof proto["heldLockUris"]).toBe("function");
    expect(AbapConnection.prototype.heldLockUris.length, "heldLockUris()").toBe(0);
  });
});

// ===========================================================================
// 1. A dead connection is never handed out
// ===========================================================================

describe("a slot whose connection is dead is never leased", () => {
  it("counts a connection that died outside the pool as dead, without being asked", async () => {
    const { pool, f } = makePool();
    await pool.withRead("warmup", async () => undefined);
    expect(pool.stats()).toMatchObject({ total: 1, busy: 0, idle: 1, dead: 0 });

    // The death the pool never learned about: something else on this connection
    // — `connect()`, a `primary()` caller, a classifier the pool does not sit
    // under — saw `400 Session Timed Out` and called `markDead`.
    f.created[0]!.markDead("HTTP 400: the ABAP session no longer exists");

    expect(pool.stats(), "the pool must not still call this slot idle").toMatchObject({
      idle: 0,
    });
  });

  it("drops the corpse and builds a replacement rather than leasing it out", async () => {
    const { pool, f } = makePool();
    await pool.withRead("warmup", async () => undefined);
    const corpse = f.created[0]!;
    corpse.markDead("session gone");

    const used = await pool.withRead("next", async (conn) => conn);

    expect(used, "the next caller must NOT be handed the dead connection").not.toBe(
      corpse as unknown as typeof used,
    );
    expect(f.created, "a replacement was built").toHaveLength(2);
    expect(used).toBe(f.created[1] as unknown as typeof used);
    expect(corpse.disposals).toBe(1);
    expect(
      corpse.shutdowns,
      "a session the server has already discarded must not be asked to drop itself",
    ).toEqual([]);
    expect(f.created[1]!.breaker, "the replacement still shares the ONE breaker").toBe(
      corpse.breaker,
    );
  });

  it("reads conn.isDead even when the connection offers no onDead to subscribe to", async () => {
    // `createConnection` is a public seam and an implementation is not obliged
    // to provide `onDead` — the `typeof` guard in `createSlot` exists for
    // exactly that. With no subscription, the only way the pool can learn is by
    // READING `isDead` when it is about to make a decision. That is a field
    // read on an object which already knew the answer, not a question put to
    // the server, so L2 is untouched.
    const made: { dead: boolean; disposals: number }[] = [];
    const create = (_c: Config, o: ConnectionOptions): AbapConnection => {
      const c = {
        dead: false,
        disposals: 0,
        breaker: o.breaker,
        get isDead(): boolean {
          return c.dead;
        },
        async shutdown(): Promise<void> {},
        dispose(): void {
          c.disposals++;
        },
      };
      made.push(c);
      return c as unknown as AbapConnection;
    };
    const cl = clock();
    const pool = new AdtSessionPool({
      cfg: cfg(),
      breaker: new AuthCircuitBreaker(),
      createConnection: create,
      now: cl.now,
      setTimer: cl.setTimer,
      clearTimer: cl.clearTimer,
    });

    await pool.withRead("warmup", async () => undefined);
    expect(made).toHaveLength(1);
    expect(pool.stats()).toMatchObject({ total: 1, idle: 1, dead: 0 });

    made[0]!.dead = true;

    expect(pool.stats(), "learned without being told, and without asking").toMatchObject({
      idle: 0,
      dead: 1,
    });
    await pool.withRead("next", async () => undefined);
    expect(made, "and the corpse is replaced rather than handed out").toHaveLength(2);
    expect(made[0]!.disposals).toBe(1);
  });

  it("drops an idle slot the moment its connection reports death — no next-acquire delay", async () => {
    const { pool, f } = makePool({ maxSessions: 2, readConcurrency: 2 });
    const hold = deferred();
    const a = pool.withRead("a", async () => hold.promise);
    await settle();
    const b = pool.withRead("b", async () => hold.promise);
    await settle();
    expect(f.created).toHaveLength(2);
    hold.resolve();
    await Promise.all([a, b]);
    expect(pool.stats()).toMatchObject({ total: 2, idle: 2 });

    f.created[1]!.markDead("session gone");

    expect(pool.stats(), "dropped synchronously, not lazily at the next tryTake").toMatchObject({
      total: 1,
      idle: 1,
      dead: 0,
    });
  });
});

// ===========================================================================
// 2. The debug lease finally has a death path
// ===========================================================================

describe("a debug lease is invalidated when its connection dies", () => {
  it("frees the slot instead of pinning the whole pool on a poll that will never return", async () => {
    const { pool, f } = makePool(); // shipped defaults: maxSessions 1
    const lease = await pool.reserveDebug("debugger/listeners");
    expect(pool.stats()).toMatchObject({ total: 1, busy: 1, idle: 0 });

    // Ordinary work is correctly refused while the lease is held.
    await expect(pool.withRead("blocked", async () => undefined)).rejects.toBeInstanceOf(
      SessionBusyError,
    );

    // The long poll's session dies. The lease owner is blocked on a request
    // that will never come back, so it will not release; nothing else can.
    f.created[0]!.markDead("HTTP 400: the ABAP session no longer exists");

    expect(pool.stats().busy, "the lease must not survive its own connection").toBe(0);
    expect(pool.stats().total, "and the corpse is dropped").toBe(0);
    expect(f.created[0]!.disposals).toBe(1);

    // The pool is USABLE again — this is the whole point.
    await expect(pool.withRead("after", async () => "ok")).resolves.toBe("ok");
    expect(f.created, "on a fresh session").toHaveLength(2);
  });

  it("keeps release() idempotent — the owner calling it afterwards is still a no-op", async () => {
    const { pool, f } = makePool();
    const lease = await pool.reserveDebug("debugger/listeners");
    f.created[0]!.markDead("session gone");
    expect(pool.stats().busy).toBe(0);

    const held = deferred();
    const running = pool.withRead("later-caller", async () => held.promise);
    await settle();
    expect(pool.stats().busy, "a later caller now owns a fresh slot").toBe(1);

    // L1. The stale owner finally notices and releases. It must not free the
    // slot the LATER caller is holding — the classic double-release bug, and
    // the forced release must not have opened a door to it.
    expect(lease.release()).toBeUndefined();
    lease.release();
    expect(pool.stats()).toEqual({ total: 1, busy: 1, idle: 0, waiting: 0, dead: 0 });

    held.resolve();
    await running;
  });

  it("hands the freed capacity to a caller parked behind the dying slot", async () => {
    // maxSessions 2 so the queue is blocked by an ORDINARY lease as well as the
    // debug one — otherwise `park()` refuses outright (nothing may queue behind
    // a long poll) and there is no waiter to hand off to. readConcurrency 2 so
    // that what the waiter is short of is a SESSION, which the death frees, and
    // not a read permit, which it does not.
    const { pool, f, c } = makePool({ maxSessions: 2, readConcurrency: 2 });
    const lease = await pool.reserveDebug("debugger/listeners");
    const hold = deferred();
    const reader = pool.withRead("reader", async () => hold.promise);
    await settle();
    expect(pool.stats().busy).toBe(2);

    const parked = pool.withRead("parked", async () => "parked");
    await settle();
    expect(pool.stats().waiting).toBe(1);
    expect(c.armed(), "armed on the injected wheel, and never fired below").toBe(1);

    f.created[0]!.markDead("session gone");
    await settle();

    // Killed by the un-wired version, which leaves the waiter to burn its full
    // sessionWaitMs waiting on a release that is never coming.
    expect(pool.stats().waiting, "the waiter is served, not left to time out").toBe(0);
    await expect(parked).resolves.toBe("parked");
    expect(c.armed(), "and its timer was cleared, not left to fire later").toBe(0);

    lease.release();
    hold.resolve();
    await reader;
  });

  it("does not yank an in-flight read out from under the caller still running on it", async () => {
    // The deliberate asymmetry: `runOn`'s `finally` already bounds a read or a
    // write. Force-releasing one mid-flight would make `inFlight()` undercount
    // and admit a SECOND concurrent request onto a session that still has one
    // outstanding — the exact thing this module exists to prevent.
    const { pool, f } = makePool();
    const hold = deferred();
    const running = pool.withRead("reader", async () => {
      f.created[0]!.markDead("session gone");
      return hold.promise;
    });
    await settle();

    expect(
      pool.stats(),
      "still leased to the caller that is still running, and reported dead as well as busy",
    ).toMatchObject({ total: 1, busy: 1, idle: 0, dead: 1 });

    // A second caller must WAIT, not be admitted alongside the one still
    // running. A corpse that stopped counting towards `inFlight`/`liveCount`
    // would let this one straight through onto a brand-new session while the
    // first request is still outstanding — the undercount that the "busy
    // dominates dead" rule in `stats()` exists to prevent.
    let intruderRan = false;
    const intruder = pool.withRead("intruder", async () => {
      intruderRan = true;
      return "second";
    });
    await settle();
    expect(pool.stats().waiting, "parked behind the lease, not admitted beside it").toBe(1);
    expect(intruderRan).toBe(false);
    expect(f.created, "and no replacement session was opened for it either").toHaveLength(1);

    hold.resolve();
    await running;
    await expect(intruder, "and it is served the moment the first caller lets go").resolves.toBe(
      "second",
    );
    expect(f.created, "on a fresh session, the corpse having been dropped on release").toHaveLength(
      2,
    );
    expect(f.created[0]!.disposals).toBe(1);
  });

  /**
   * The two counters that make the paragraph above true, pinned SEPARATELY.
   *
   * `tryTake` checks the role limit first and the session limit second, so each
   * one masks the other: undercounting in `inFlight()` alone is still stopped by
   * `maxSessions`, and undercounting in `liveCount()` alone is still stopped by
   * the role limit. Only a test that removes one barrier can see the other fail,
   * which is why the in-flight test above — run at the shipped 1/1 sizing, where
   * both barriers bind — cannot tell either of them from correct code.
   */
  describe("a corpse that is still leased keeps counting", () => {
    const startDyingRead = (pool: AdtSessionPool, f: ReturnType<typeof factory>) => {
      const hold = deferred();
      const running = pool.withRead("dying", async () => {
        f.created[0]!.markDead("session gone");
        return hold.promise;
      });
      return { hold, running };
    };

    it("against its ROLE limit, with sessions to spare", async () => {
      const { pool, f } = makePool({ maxSessions: 2, readConcurrency: 1 });
      const { hold, running } = startDyingRead(pool, f);
      await settle();

      let ran = false;
      const second = pool.withRead("second", async () => {
        ran = true;
      });
      await settle();
      expect(ran, "readConcurrency is 1 and one read is still in flight").toBe(false);
      expect(pool.stats().waiting).toBe(1);
      expect(f.created, "so no second session may be opened to run it alongside").toHaveLength(1);

      hold.resolve();
      await running;
      await second;
    });

    it("against maxSessions, with role permits to spare", async () => {
      const { pool, f } = makePool({ maxSessions: 1, readConcurrency: 2 });
      const { hold, running } = startDyingRead(pool, f);
      await settle();

      let ran = false;
      const second = pool.withRead("second", async () => {
        ran = true;
      });
      await settle();
      expect(ran, "the corpse still occupies the pool's only session").toBe(false);
      expect(pool.stats().waiting).toBe(1);
      expect(f.created).toHaveLength(1);

      hold.resolve();
      await running;
      await second;
    });

    it("and is NAMED as the blocker when the caller behind it gives up", async () => {
      // The `SessionBusyError` exists to tell an operator which operation is
      // holding the pool. Skipping corpses when looking for the holder produces
      // the least useful message it is possible to emit — "holder: (none)" on a
      // pool that just refused you — in exactly the situation where the operator
      // most needs to know what is stuck.
      const { pool, f, c } = makePool({ sessionWaitMs: 5_000 });
      const { hold, running } = startDyingRead(pool, f);
      await settle();

      const refused = pool
        .withRead("second", async () => undefined)
        .then(() => null)
        .catch((e: unknown) => e);
      await settle();
      c.advance(5_000);

      const e = (await refused) as SessionBusyError;
      expect(e).toBeInstanceOf(SessionBusyError);
      expect(e.reason).toBe("wait-timeout");
      expect(e.holder, "the corpse's operation, not '(none)'").toBe("dying");
      expect(e.holderKind).toBe("exclusive");
      expect(e.heldForMs).toBe(5_000);

      hold.resolve();
      await running;
    });
  });

  it("unsubscribes from the connection it no longer owns", async () => {
    const { pool, f } = makePool();
    const primary = f.created[0]!;
    expect(primary.listenerCount(), "the pool listens while it owns the slot").toBe(1);

    pool.dispose();
    expect(
      primary.listenerCount(),
      "primary() outlives dispose(), so a listener left on it is a leak onto a dead pool",
    ).toBe(0);

    // And a death afterwards must be inert rather than mutating a disposed pool.
    expect(() => primary.markDead("after dispose")).not.toThrow();
    expect(pool.stats()).toEqual({ total: 0, busy: 0, idle: 0, waiting: 0, dead: 0 });
  });
});

// ===========================================================================
// 3. acquire() and runOn() now agree about auth failures
// ===========================================================================

/**
 * `runOn` has always documented that an auth failure is NOT a property of the
 * session — "those are the shared breaker's business … retiring the slot and
 * building a replacement would spend another logon against the user-lock
 * counter for nothing" — and it honours that: only `SESSION_DEAD` marks a slot
 * dead there. `acquire()` did the opposite, retiring the slot on ANY
 * preparation failure and then LOOPING, which is that same wasted logon in a
 * `for (;;)`. One SAP user, one `login/fails_to_user_lock` counter, ~5
 * consecutive failures to a lock: a loop that answers a rejected password by
 * building a fresh connection and logging on again is a lock-the-user machine.
 *
 * The comment was right and the code was wrong. These pin the fix.
 */
describe("a preparation failure that is not the session's fault", () => {
  for (const code of ["AUTH_FAILED", "AUTH_CIRCUIT_OPEN", "CIRCUIT_OPEN_TRANSIENT"] as const) {
    it(`${code}: rethrown as-is, slot kept, exactly ONE logon attempted`, async () => {
      const f = factory();
      const c = clock();
      let prepares = 0;
      const boom = new AbapError(code, "credentials refused");
      const pool = new AdtSessionPool({
        cfg: cfg(),
        breaker: new AuthCircuitBreaker(),
        createConnection: f.create,
        now: c.now,
        setTimer: c.setTimer,
        clearTimer: c.clearTimer,
        prepareConnection: async () => {
          prepares++;
          throw boom;
        },
      });

      const e = await pool
        .withRead("r", async () => undefined)
        .then(() => null)
        .catch((err: unknown) => err);

      expect(e, "the caller gets the REAL error, not a manufactured 'busy'").toBe(boom);
      expect(e).not.toBeInstanceOf(SessionBusyError);
      expect(prepares, "no retry: the breaker owns this failure, not the pool").toBe(1);
      expect(f.created, "and no replacement session was built for it").toHaveLength(1);
      expect(pool.stats(), "the slot is released, not retired").toEqual({
        total: 1,
        busy: 0,
        idle: 1,
        waiting: 0,
        dead: 0,
      });
    });
  }

  it("clears the poisoned memo so the breaker's cooldown can still be honoured later", async () => {
    // `prepare()` memoises per SLOT, so a rejected promise left in place would
    // poison that slot for the life of the process — and the breaker's whole
    // point is that it re-admits after a cooldown.
    const f = factory();
    const c = clock();
    let prepares = 0;
    const pool = new AdtSessionPool({
      cfg: cfg(),
      breaker: new AuthCircuitBreaker(),
      createConnection: f.create,
      now: c.now,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
      prepareConnection: async () => {
        prepares++;
        if (prepares === 1) throw new AbapError("AUTH_CIRCUIT_OPEN", "cooling down");
      },
    });

    await expect(pool.withRead("first", async () => undefined)).rejects.toMatchObject({
      code: "AUTH_CIRCUIT_OPEN",
    });
    await expect(pool.withRead("second", async () => "ok")).resolves.toBe("ok");
    expect(prepares).toBe(2);
    expect(f.created, "recovery happened on the SAME session, costing no extra slot").toHaveLength(
      1,
    );
  });

  it("still retires the slot when the failure really is dead-on-arrival", async () => {
    // The converse control: the auth carve-out must not have turned every
    // preparation failure into "keep the slot".
    const f = factory();
    const c = clock();
    const pool = new AdtSessionPool({
      cfg: cfg({ sessionWaitMs: 5_000 }),
      breaker: new AuthCircuitBreaker(),
      createConnection: f.create,
      now: c.now,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
      prepareConnection: async () => {
        c.advance(6_000);
        throw new Error("logon refused");
      },
    });
    const e = await pool
      .withRead("r", async () => undefined)
      .then(() => null)
      .catch((err: unknown) => err);
    expect(e).toBeInstanceOf(SessionBusyError);
    expect((e as SessionBusyError).reason).toBe("wait-timeout");
    expect(pool.stats().total, "the unpreparable slot IS dropped").toBe(0);
  });
});

/**
 * The other half of the same defect: `for (;;)` with the wall clock as its only
 * bound. `sessionWaitMs` bounds nothing when the clock is not moving between
 * attempts — a preparation that rejects in well under a millisecond leaves
 * `now() >= deadline` false and turns the loop into a spin that constructs a
 * fresh connection, and issues a fresh logon, every iteration.
 *
 * This test would not TIME OUT against the unbounded version — it would hang
 * the runner outright and take the whole file with it.
 */
describe("the preparation retry loop is bounded in iterations, not only in time", () => {
  it("gives up after a fixed number of attempts when the clock never advances", async () => {
    const f = factory();
    const c = clock();
    let prepares = 0;
    const pool = new AdtSessionPool({
      cfg: cfg({ sessionWaitMs: 10_000 }), // a budget that can never expire here
      breaker: new AuthCircuitBreaker(),
      createConnection: f.create,
      now: c.now, // and a clock nothing advances
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
      prepareConnection: async () => {
        prepares++;
        throw new Error("boom");
      },
    });

    const e = await pool
      .withRead("r", async () => undefined)
      .then(() => null)
      .catch((err: unknown) => err);

    expect(e, "the CAUSE is rethrown — we did not time out, so saying so would be a lie").toBeInstanceOf(
      Error,
    );
    expect((e as Error).message).toBe("boom");
    expect(e).not.toBeInstanceOf(SessionBusyError);
    expect(prepares, "a small fixed cap, not one attempt per available millisecond").toBe(4);
    expect(f.created.length, "and therefore a bounded number of logons").toBe(4);
    expect(pool.stats().total).toBe(0);
  });

  it("leaves the wait budget as the binding bound whenever the clock does advance", async () => {
    // The cap sits ABOVE what a real deadline exercises, so it must not be what
    // ends an ordinary bounded wait. Three attempts at 2 000 ms against a
    // 5 000 ms budget: the deadline stops it, not the cap.
    const f = factory();
    const c = clock();
    let prepares = 0;
    const pool = new AdtSessionPool({
      cfg: cfg({ sessionWaitMs: 5_000 }),
      breaker: new AuthCircuitBreaker(),
      createConnection: f.create,
      now: c.now,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
      prepareConnection: async () => {
        prepares++;
        c.advance(2_000);
        throw new Error("connect failed");
      },
    });
    const e = await pool
      .withRead("r", async () => undefined)
      .then(() => null)
      .catch((err: unknown) => err);
    expect(e).toBeInstanceOf(SessionBusyError);
    expect((e as SessionBusyError).reason).toBe("wait-timeout");
    expect(prepares, "T, T+2000, T+4000; T+6000 is past the T+5000 deadline").toBe(3);
  });
});

// ===========================================================================
// 6. The N>1 defects — unreachable at the shipped 1/1/1, live at 5/2/2
// ===========================================================================

/**
 * Every defect below is INVISIBLE at `maxSessions/read/write = 1/1/1`, because
 * each needs either a second slot or a second waiter to express itself. They
 * are pinned here, before the numbers are raised, so that raising them is a
 * config change and not a bug report.
 */
describe("defects that only exist once the pool holds more than one session", () => {
  // "DESTROYS a slot released while it still holds ABAP enqueues" used to live
  // here. It was deleted, not merely disabled, and this is not a coverage loss:
  //
  // The test pushed straight into a double's `locks` array
  // (`f.created[0]!.locks.push(...)`), so the double's `heldLockUris()` just echoed that
  // array back — always live, never cleared by anything real. It exercised `pool.ts`'s
  // now-deleted `stillHoldsLocks()` branch in `releaseSlot()`, which was itself dead in
  // production (see that method's `git blame` in the git history for the comment that used to sit there):
  // a real `AbapConnection.activeSession` is already cleared by
  // `withStatefulSession()`'s outer `finally` before `releaseSlot()` can ever read it, so the
  // double could pass this test while the equivalent real-connection case always read `[]`.
  // A green test here was never evidence the guard worked.
  //
  // The actual protection — `if (session.leakedLocks.length > 0) await this.dropSession()` in
  // `connection.ts` — is covered end-to-end, through the real `StatefulSession` lifecycle with
  // no double standing in for the lock ledger, by
  // `test/connection-liveness.test.ts`'s describe block for a lock leak that is invisible to
  // `heldLockUris()` by the time anyone could read it, but whose enqueue is released anyway.
  // That is where this behaviour is actually pinned now.

  /**
   * FIX 2 — `evictStaleIdle` used to run only from `releaseSlot`. A pool that
   * goes quiet therefore sweeps once, at the last release, when nothing is
   * stale yet, and then never again: the next caller after a long gap is handed
   * a session SAP expired ~30 min ago and gets the failure thrown out of the
   * tool. The sweep now also runs at CHECKOUT, before the warmest-first scan.
   *
   * Asserted while a lease is still HELD, because the release at the end of
   * `withRead` would run the old release-time sweep too and hide the defect.
   */
  it("sweeps stale idle slots at CHECKOUT, not only at release", async () => {
    const { pool, f, c } = makePool({
      maxSessions: 2,
      readConcurrency: 2,
      sessionIdleMs: 1_000,
    });
    const holdA = deferred();
    const holdB = deferred();
    const a = pool.withRead("a", async () => holdA.promise);
    await settle();
    const b = pool.withRead("b", async () => holdB.promise);
    await settle();
    expect(f.created).toHaveLength(2);

    holdA.resolve();
    await a;
    c.advance(100);
    holdB.resolve(); // slot 1 is now strictly the warmer of the two
    await b;
    c.advance(5_000); // both idle well past sessionIdleMs

    // Take a lease and HOLD it: nothing is released, so only a checkout-time
    // sweep can have run by the time these assertions read `stats()`.
    const holdC = deferred();
    const cLease = pool.withRead("c", async () => holdC.promise);
    await settle();

    expect(pool.stats().total, "the stale non-pinned slot is gone at checkout time").toBe(1);
    expect(f.created[1]!.shutdowns, "and it was retired, not merely forgotten").toHaveLength(1);

    holdC.resolve();
    await cLease;
  });

  /**
   * FIX 3 — `handoff()` runs inside `releaseSlot`, which runs inside `runOn`'s
   * `finally`. `tryTake` can THROW from there: `createSlot` refuses a factory
   * that returns a connection carrying its own `AuthCircuitBreaker` (L3). A
   * throw out of a `finally` replaces the releasing caller's own result with an
   * unrelated error AND abandons the whole waiter queue mid-scan.
   *
   * The choice made: REJECT THE HEAD AND CONTINUE. The queue must not stall
   * (waiting buys nothing — a breaker mismatch is structural and will not heal
   * on the next attempt), and the parked caller gets the real cause rather than
   * a `wait-timeout` ten seconds later that names the wrong thing.
   */
  it("rejects the head waiter and keeps draining when handoff's tryTake throws", async () => {
    const f = factory({ rogueBreakerFrom: 1 }); // slot 0 fine, every later one rogue
    const c = clock();
    const pool = new AdtSessionPool({
      cfg: cfg({ maxSessions: 2, readConcurrency: 1, sessionWaitMs: 10_000 }),
      breaker: new AuthCircuitBreaker(),
      createConnection: f.create,
      now: c.now,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
    });

    // r1 holds the only read lease OPEN and its connection dies mid-lease, so
    // `releaseSlot`'s "dead on release" branch (`isSlotDead(slot)`) DESTROYS slot
    // 0 — leaving handoff with no live slot and forcing it through `createSlot`,
    // which the rogue factory makes throw. (Previously this used a leaked
    // lock via `stillHoldsLocks()`'s branch instead; that branch was dead code
    // in production — see `pool.ts`'s `releaseSlot()` — and was deleted, so this
    // test now drives the same "slot 0 is destroyed out from under a parked
    // waiter" setup through the still-live dead-on-release path.) r1 must still
    // be running when r2 arrives, or r2 takes the slot itself and the handoff
    // path is never exercised at all.
    const holdR1 = deferred();
    const r1 = pool
      .withRead("r1", async () => {
        f.created[0]!.markDead("session gone mid-lease");
        await holdR1.promise;
      })
      .then(
        () => "resolved",
        (e: unknown) => `rejected: ${String(e)}`,
      );
    await settle();
    // r2 parks: readConcurrency is 1, so `tryTake` returns before it can create.
    const r2 = pool.withRead("r2", async () => "served").then(
      () => "resolved" as unknown,
      (e: unknown) => e,
    );
    await settle();
    expect(pool.stats().waiting, "r2 really is parked, so handoff is the path under test").toBe(1);

    holdR1.resolve();
    await settle();

    // Only needed to unwedge a PRE-fix run, where r2 is parked forever behind a
    // queue that was abandoned mid-drain. Post-fix r2 has already rejected.
    c.advance(60_000);

    expect(await r1, "a failed handoff must not become the releasing caller's error").toBe("resolved");
    const err = await r2;
    expect(err, "the parked caller gets the STRUCTURAL cause, not a wait-timeout").toBeInstanceOf(
      AbapError,
    );
    expect((err as AbapError).code).toBe("NOT_CONNECTED");
    expect(pool.stats().waiting, "and the queue is drained, not stalled").toBe(0);
  });

  /**
   * FIX 4 — a new arrival used to call `tryTake` before looking at the queue,
   * so it could seize a slot a parked waiter was owed. `handoff()`'s comment
   * has always claimed strict FIFO with head-of-line blocking; that was true of
   * `handoff`'s own loop and false of the pool as a whole.
   *
   * PARK-THEN-TAKE was chosen over "re-run handoff after a barge": re-running
   * handoff still lets the barger keep the slot it stole, so it narrows the
   * window without curing the starvation. Parking makes the existing comment
   * true. `debug` is exempt because a debug reservation NEVER QUEUES — it is
   * take-or-fail by contract.
   *
   * The write/read split is what makes the barge reachable: w2 parks on
   * `writeConcurrency`, not on slot exhaustion, so a read could still find
   * capacity and jump the queue.
   */
  it("makes a new arrival QUEUE behind a parked waiter instead of barging", async () => {
    const { pool, f } = makePool({
      maxSessions: 2,
      readConcurrency: 2,
      writeConcurrency: 1,
    });
    const order: string[] = [];
    const holdW1 = deferred();

    const w1 = pool.withWrite("w1", undefined, async () => {
      order.push("w1");
      await holdW1.promise;
    });
    await settle();
    const w2 = pool.withWrite("w2", undefined, async () => {
      order.push("w2");
    });
    await settle(); // w2 parks: writeConcurrency is 1
    const r1 = pool.withRead("r1", async () => {
      order.push("r1");
    });
    await settle();

    expect(order, "r1 must not run ahead of the waiter that arrived first").toEqual(["w1"]);
    expect(f.created, "and no extra session is minted to carry the barge").toHaveLength(1);

    holdW1.resolve();
    await Promise.all([w1, w2, r1]);
    expect(order, "strict FIFO, as handoff() has always claimed").toEqual(["w1", "w2", "r1"]);
  });

  /**
   * FIX 5 — `primaryConn` used to be immortal. When slot 0 died the pool
   * retired the slot but left the corpse installed as the primary, and
   * `server.ts` had cached that same object for the process lifetime. Revival
   * therefore meant `connect()` on the SAME object, and
   * `LOGON_ENDPOINT_LIFETIME_CEILING` is a LIFETIME counter: the 6th revival
   * throws, permanently, and every refused attempt still increments it.
   *
   * `primary()` now re-seats onto a slot the pool holds. Re-seating is LAZY
   * (done on read, never from `dropSlot`) because `dropSlot` also runs from
   * `acquire`'s preparation-retry loop — minting there turned one failing
   * acquire into one logon per attempt, aimed straight at the shared
   * `login/fails_to_user_lock` counter.
   */
  it("re-seats primary() onto a live session instead of handing back the corpse", async () => {
    const { pool, f } = makePool();
    const before = pool.primary();
    expect(before).toBe(f.created[0] as unknown as AbapConnection);

    f.created[0]!.markDead("session expired after ~30 min idle");

    const after = pool.primary();
    expect(after, "a dead connection must never be handed out again").not.toBe(before);
    expect(after.isDead, "and the replacement is alive").toBe(false);
    expect(f.created, "exactly one replacement — re-seating is not a logon storm").toHaveLength(2);
    expect(pool.primary(), "and it is stable once seated").toBe(after);
  });

  /**
   * FIX 6 — the replacement primary must be a slot the pool COUNTS. The
   * immortal `primaryConn` lived outside `this.slots`, so after the first
   * death the pool would grow back to `maxSessions` pooled sessions while the
   * revivable primary sat beside them: a permanent, silent cap violation of
   * exactly one session, on a system whose whole point is a bounded number of
   * ADT sessions.
   */
  it("books the re-seated primary against maxSessions instead of orphaning it", async () => {
    const { pool, f } = makePool(); // maxSessions: 1
    pool.primary();
    f.created[0]!.markDead("session expired after ~30 min idle");
    const revived = pool.primary();

    expect(pool.stats().total, "the revived primary is a slot, not a stowaway").toBe(1);

    await pool.withRead("a", async () => undefined);
    expect(
      f.created,
      "at maxSessions:1 the read REUSES the primary; an uncounted primary would make this 3",
    ).toHaveLength(2);
    expect(pool.primary(), "and the read ran on the primary itself").toBe(revived);
  });

  /**
   * The re-seat PREFERS ADOPTION over minting: if the pool still holds a live
   * slot when the pinned one dies, the pin MOVES to the warmest survivor and
   * nothing is constructed. A fresh connection costs a logon plus discovery
   * plus the role probe, and re-running role detection can only ever
   * change the verdict by failing closed mid-session.
   */
  it("ADOPTS the warmest live slot rather than minting when one is available", async () => {
    const { pool, f } = makePool({ maxSessions: 2, readConcurrency: 2 });
    const holdA = deferred();
    const holdB = deferred();
    const a = pool.withRead("a", async () => holdA.promise);
    await settle();
    const b = pool.withRead("b", async () => holdB.promise);
    await settle();
    holdA.resolve();
    await a;
    holdB.resolve();
    await b;
    expect(f.created).toHaveLength(2);

    f.created[0]!.markDead("session expired after ~30 min idle");

    expect(pool.primary(), "slot 1 was already there — adopt it").toBe(
      f.created[1] as unknown as AbapConnection,
    );
    expect(f.created, "adoption costs no logon at all").toHaveLength(2);
    expect(pool.stats().total).toBe(1);
  });

  /**
   * The pinned-primary exposure defect, structural half — `pool.ts`'s comment on
   * `releaseSlot()` used to claim "The pinned primary is NOT exempt either" as
   * though that settled the matter for the whole pool. It is true of THAT
   * branch (`dropSlot()` itself never special-cases `pinned`) and false of
   * `evictStaleIdle()`, which skips `s.pinned` slots unconditionally. Neither
   * of those, though, is where a pinned slot's actual exposure lives: this
   * test pins it down at the root, in `tryTake()`, which hands out WRITE
   * leases with no `pinned` check in its scan at all
   * (`if (s.busy || this.isSlotDead(s)) continue;` — no third condition).
   *
   * So the pinned primary is not merely "not exempted from cleanup" — it can
   * be checked out for a write like any other idle slot, which is the
   * precondition every downstream part of defect 2 depends on: without this,
   * a leaked lock could only ever land on a slot `evictStaleIdle` was already
   * exempting for an unrelated, understood reason, and the exemption gap
   * would be moot.
   *
   * This does not exercise a leak — that is defect 1/3's job, proven end to
   * end against the real `withStatefulSession()` lifecycle in
   * `test/connection-liveness.test.ts`. This test is offline and
   * structural: it proves the PRECONDITION ("pinned can get a write lease")
   * in isolation, via connection identity — `pool.stats()` has no per-slot
   * `pinned` field to assert against directly.
   */
  it("tryTake() hands the pinned primary slot a WRITE lease when it is the warmest idle slot — no pinned exclusion", async () => {
    const { pool, f, c } = makePool({ maxSessions: 2, readConcurrency: 2, writeConcurrency: 2 });

    // Seat the pin on slot 0. Idle immediately: primary() never marks a slot busy.
    const pinned = pool.primary();
    expect(pinned, "sanity: primary() really did seat slot 0").toBe(f.created[0] as unknown as AbapConnection);

    // Force a SECOND slot into existence without ever routing through slot 0,
    // by holding two reads open concurrently: slot 0 (idle) is taken by the
    // first, so the second — arriving while slot 0 is still busy — must mint.
    const holdA = deferred();
    const holdB = deferred();
    const a = pool.withRead("a", async () => holdA.promise);
    await settle();
    const b = pool.withRead("b", async () => holdB.promise);
    await settle();
    expect(f.created, "slot 0 (pinned) took `a`; `b` had to mint slot 1").toHaveLength(2);

    // Release the NON-pinned slot first and the pinned one second, so the
    // pinned slot ends up with the LATER `lastReleasedAt` — the warmest —
    // which is what `tryTake`'s "warmest first" scan keys on.
    holdB.resolve();
    await b;
    c.advance(1_000);
    holdA.resolve();
    await a;

    // Confirm the pin is still where we think it is before reading the
    // signal the write is about to give us.
    expect(pool.primary(), "the pin does not move on its own between releases").toBe(pinned);

    let sawConn: unknown;
    await pool.withWrite("w", undefined, async (conn) => {
      sawConn = conn;
    });

    expect(
      sawConn,
      "the WARMEST idle slot was the pinned primary, and tryTake() handed it a write lease anyway",
    ).toBe(pinned);
    // Nothing was evicted or minted to serve the write — same two slots as before.
    expect(f.created).toHaveLength(2);
    expect(pool.stats().total).toBe(2);
  });
});

// ===========================================================================
// 6. Re-seating the primary is a decision about WHO ELSE IS USING THE SESSION
// ===========================================================================

/**
 * `primary()` is the one handle in this file that is consumed OUTSIDE any
 * lease: `ensureConnected`, the public getter, `abap_journal`'s undo path and
 * the UNGATED debugger all call it and then use the connection with no slot
 * checked out. So every choice `seatPrimary` makes about WHICH slot to seat is
 * a choice about whether two unrelated callers end up on one ADT session.
 */
describe("seatPrimary picks a seat nobody else is sitting on", () => {
  const nOf = (conn: unknown): number => (conn as { n: number }).n;

  /**
   * THE BUSY FILTER. `tryTake` skips `s.busy || isSlotDead(s)`; `seatPrimary`
   * skipped only the dead. With a live slot checked out and headroom under
   * `maxSessions`, it adopted the checked-out one — aiming the debugger, or a
   * journal undo, at a session another caller is mid-request on.
   */
  it("does not seat the primary on a session another caller is checked out on", async () => {
    const { pool, f } = makePool({ maxSessions: 2, readConcurrency: 2 });
    const holdA = deferred();
    const holdB = deferred();
    const a = pool.withRead("a", async () => holdA.promise);
    await settle();
    const b = pool.withRead("b", async () => holdB.promise);
    await settle();
    expect(f.created, "A holds slot 0 (the primary), B holds slot 1").toHaveLength(2);

    // A gives the primary back; the primary then dies IDLE and is dropped, so
    // `primaryConn` is off the books. B is still checked out on connection 1.
    holdA.resolve();
    await a;
    f.created[0]!.markDead("session expired after ~30 min idle");
    expect(pool.stats()).toMatchObject({ total: 1, busy: 1, idle: 0 });

    const seated = pool.primary();
    expect(
      nOf(seated),
      "connection 1 has a read in flight on it; `primary()` is consumed outside " +
        "any lease, so seating it there shares one ADT session between two callers",
    ).not.toBe(1);
    expect(seated.isDead, "and the seat is alive").toBe(false);
    expect(f.created, "there was room under maxSessions, so mint rather than share").toHaveLength(3);

    holdB.resolve();
    await b;
  });

  /**
   * THE LIVENESS CHECK ON THE IDENTITY EARLY-RETURN. `onSlotConnectionDied`
   * deliberately does NOT drop a read/write slot that dies while BUSY —
   * `runOn`'s `finally` owns that lease. So the pinned slot can sit in
   * `this.slots` as a known corpse, and a bare `s.conn === primaryConn` test
   * matched it and handed the corpse straight back.
   */
  it("re-seats away from a pinned slot that died while BUSY", async () => {
    const { pool, f } = makePool({ maxSessions: 2, readConcurrency: 2 });
    const hold = deferred();
    const dying = pool.withRead("dying", async () => {
      f.created[0]!.markDead("session gone");
      return hold.promise;
    });
    await settle();
    // The corpse is still in `slots`, still busy, still pinned.
    expect(pool.stats()).toMatchObject({ total: 1, busy: 1, dead: 1 });

    expect(
      pool.primary().isDead,
      "the pinned slot is a corpse the pool is holding open for its lease; " +
        "matching it by identity and returning it hands out a dead session",
    ).toBe(false);

    hold.resolve();
    await dying;
  });

  /**
   * SWEEP BEFORE SCANNING. `evictStaleIdle` exempts pinned slots, so pinning a
   * slot that is ALREADY past `sessionIdleMs` does not merely keep a stale
   * session — it makes that staleness permanent, and adds one more
   * never-swept slot on every re-seat. `tryTake` sweeps before it scans;
   * `seatPrimary` did neither.
   */
  it("sweeps stale slots before scanning, so the pin cannot land on one", async () => {
    const { pool, f, c } = makePool({
      maxSessions: 3,
      readConcurrency: 3,
      sessionIdleMs: 1_000,
    });
    // Three reads launched together: `tryTake` runs synchronously inside each
    // `acquire`, so each one mints its own slot before any of them yields.
    const holds = [deferred(), deferred(), deferred()];
    const reads = holds.map((h, i) => pool.withRead(`r${i}`, async () => h.promise));
    await settle();
    for (const h of holds) h.resolve();
    await Promise.all(reads);
    expect(f.created, "three slots exist and all three are now idle").toHaveLength(3);

    // Everything goes stale, then the pinned primary dies idle and is dropped.
    c.advance(5_000);
    f.created[0]!.markDead("session expired after ~30 min idle");
    expect(pool.stats().total, "two stale survivors").toBe(2);

    const seated = pool.primary();
    expect(
      { total: pool.stats().total, seatedIsFresh: nOf(seated) === 3 },
      "both survivors were past sessionIdleMs; pinning one exempts it from " +
        "eviction forever, so they must be swept and a fresh session seated",
    ).toEqual({ total: 1, seatedIsFresh: true });
  });
});

// ===========================================================================
// 7. Freeing capacity without draining the queue
// ===========================================================================

/**
 * `acquire` refuses to `tryTake` while anyone is parked. That anti-barging
 * rule is what turns a missing `handoff()` from a delay into a STALL: an
 * arrival that would once have minted now defers to a queue nobody is
 * draining. Every path that frees capacity therefore has to drain.
 */
describe("every path that frees capacity hands it off", () => {
  it("drains the queue when the head waiter times out", async () => {
    const { pool, c } = makePool({
      maxSessions: 2,
      readConcurrency: 2,
      writeConcurrency: 1,
      sessionWaitMs: 10_000,
    });
    const holdW1 = deferred();
    const w1 = pool.withWrite("w1", undefined, async () => holdW1.promise);
    await settle();

    // W2 cannot run — writeConcurrency is 1. It parks, deadline t0 + 10s.
    let w2Err: unknown;
    const w2 = pool
      .withWrite("w2", undefined, async () => undefined)
      .catch((e: unknown) => {
        w2Err = e;
      });
    await settle();

    // R1 arrives 5s later. There IS headroom for it (maxSessions 2,
    // readConcurrency 2) but it defers to the parked head. Deadline t0 + 15s.
    c.advance(5_000);
    let r1Ran = false;
    const r1 = pool.withRead("r1", async () => {
      r1Ran = true;
    });
    await settle();
    expect(pool.stats().waiting).toBe(2);

    // W2's deadline. It leaves the queue; R1 becomes head and IS servable.
    c.advance(5_000);
    await settle();

    expect(w2Err, "the head really did time out").toBeInstanceOf(SessionBusyError);
    expect(
      { r1Ran, waiting: pool.stats().waiting },
      "a timeout is a queue exit, and the new head was servable the instant " +
        "the old one left — nothing else is coming to notice",
    ).toEqual({ r1Ran: true, waiting: 0 });

    holdW1.resolve();
    await w1;
    await w2;
    await r1;
  });

  it("drains the queue when a failed preparation retires a slot", async () => {
    const f = factory();
    const c = clock();
    const prep = deferred();
    const pool = new AdtSessionPool({
      cfg: cfg({ maxSessions: 2, readConcurrency: 3, sessionWaitMs: 60_000 }),
      breaker: new AuthCircuitBreaker(),
      createConnection: f.create,
      now: c.now,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
      // Only connection 1 is dead on arrival.
      prepareConnection: async (conn) => {
        if ((conn as unknown as { n: number }).n !== 1) return;
        await prep.promise;
      },
    });

    const hold1 = deferred();
    const r1 = pool.withRead("r1", async () => hold1.promise);
    await settle();

    // R2 mints slot 1 and hangs in preparation, holding it busy.
    let r2Ran = false;
    const r2 = pool.withRead("r2", async () => {
      r2Ran = true;
    });
    await settle();
    expect(f.created).toHaveLength(2);

    // R3 finds the pool at maxSessions and parks. It is head of the queue.
    let r3Ran = false;
    const r3 = pool.withRead("r3", async () => {
      r3Ran = true;
    });
    await settle();
    expect(pool.stats().waiting).toBe(1);

    // Slot 1 is dead on arrival. Retiring it frees a whole slot against
    // maxSessions — capacity R3 is entitled to and can use right now.
    prep.reject(new Error("logon refused"));
    await settle();

    expect(
      { r3Ran, waiting: pool.stats().waiting },
      "retire() freed the capacity the parked head was waiting for; without a " +
        "drain the retrying caller just defers to that same head and the whole " +
        "queue stalls until an unrelated release()",
    ).toEqual({ r3Ran: true, waiting: 0 });

    hold1.resolve();
    await r1;
    await r2;
    await r3;
    expect(r2Ran, "and the caller whose slot died is still served").toBe(true);
  });
});

// ===========================================================================
// 8. `primary()` must be safe to ask DURING a checkout
// ===========================================================================

/**
 * `server.ts` used to decide whether to `connect()` a slot by asking
 * `conn !== pool.primary()` from inside `prepareConnection` — a question the
 * pool answers by MUTATING itself. `seatPrimary` could adopt the very slot
 * being prepared, make the test false, and skip the `connect()` that slot
 * needed. The host no longer asks (the pool passes the pin as an argument),
 * but the pool must be safe against a host that does.
 */
describe("a slot mid-preparation is not a seat", () => {
  it("never adopts the slot whose own preparation is asking", async () => {
    const f = factory();
    const c = clock();
    const connected: number[] = [];
    const pool = new AdtSessionPool({
      cfg: cfg({ maxSessions: 1, readConcurrency: 1 }),
      breaker: new AuthCircuitBreaker(),
      createConnection: f.create,
      now: c.now,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
      // The re-entrant shape server.ts used to have.
      prepareConnection: async (conn) => {
        if (conn !== pool.primary()) connected.push((conn as unknown as { n: number }).n);
      },
    });

    pool.primary();
    // The primary dies IDLE and is dropped, so `primaryConn` is off the books
    // and the next `primary()` will look for a new seat.
    f.created[0]!.markDead("session expired after ~30 min idle");

    await pool.withRead("r", async () => undefined);

    expect(
      connected,
      "connection 1 was mid-preparation and not logged on yet; adopting it as " +
        "the primary makes `conn !== primary()` false and hands out a session " +
        "nobody ever connected",
    ).toEqual([1]);
  });
});

// ===========================================================================
// 9. The debug exemption is PREEMPTION, and that is the chosen behaviour
// ===========================================================================

/**
 * BEHAVIOUR LOCK, NOT A REGRESSION TEST — this passed before the
 * comment fix and passes after it. It is here because the code comment used to
 * justify the exemption with "a debug reservation never queues, by contract",
 * which describes the mechanism and denies the effect. The effect is that a
 * debug reservation TAKES CAPACITY A QUEUED WAITER IS ENTITLED TO and leaves
 * that waiter parked.
 *
 * That is kept deliberately: `park` rejects `debug` outright, so the only
 * alternative to preempting is FAILING the reservation whenever anybody is
 * queued, even with a slot sitting free. A queued read or write that loses
 * this race is still queued and recovers by waiting; a refused debug
 * reservation does not. The starvation is bounded by `DEBUG_CONCURRENCY`, by
 * the `debugDiaBudget` floor check, and by debug being an interactive act
 * rather than anything a request stream can generate.
 */
describe("a debug reservation preempts the queue, deliberately", () => {
  it("takes headroom the parked head was owed, and leaves it parked", async () => {
    const { pool, f } = makePool({
      maxSessions: 2,
      readConcurrency: 2,
      writeConcurrency: 1,
    });
    const holdW1 = deferred();
    const w1 = pool.withWrite("w1", undefined, async () => holdW1.promise);
    await settle();

    let w2Ran = false;
    const w2 = pool.withWrite("w2", undefined, async () => {
      w2Ran = true;
    });
    await settle();
    expect(pool.stats().waiting, "W2 is head of the queue").toBe(1);

    // Headroom exists (one slot of two is in use). W2 is entitled to it.
    const lease = await pool.reserveDebug("dbg");
    expect(f.created, "the debug reservation minted the session W2 was owed").toHaveLength(2);
    expect(
      { w2Ran, waiting: pool.stats().waiting },
      "debug PREEMPTS: it does not queue, and the head stays parked",
    ).toEqual({ w2Ran: false, waiting: 1 });

    lease.release();
    holdW1.resolve();
    await w1;
    await w2;
    expect(w2Ran, "and W2 is served as soon as a write slot frees").toBe(true);
  });
});

// ===========================================================================
// DEFECT 3 — `isDead` is the pool's ONLY liveness authority
// ===========================================================================

/**
 * The pool has exactly one way to learn that a session is unusable:
 * `isSlotDead()`, which reads `slot.dead` and `conn.isDead` and NOTHING else.
 * Both tests below pin that, from its two sides, because the whole of DEFECT 3
 * lived in the gap between them — a connection can be PERMANENTLY unusable
 * (its logon-endpoint lifetime ceiling latched, so every future `connect()` is
 * refused locally without reaching the wire) while still reporting
 * `isDead === false`. `seatPrimary()` is a lazy fixup, not an event, so it then
 * early-returned on that live, idle, useless slot forever and the process
 * stayed bricked for its whole lifetime.
 *
 * Nothing here can observe the ceiling itself — these are doubles. What they
 * pin is the CONTRACT the fix relies on: marking dead is both NECESSARY (§1)
 * and SUFFICIENT (§2) to get the primary replaced. That is precisely why the
 * fix belongs in `AbapConnection.connectUnderLock()` and not here — see
 * `test/server-session-revival.test.ts` §4 for the end-to-end proof.
 */
describe("DEFECT 3 — the pool re-seats the primary on death, and on nothing else", () => {
  /**
   * BEHAVIOUR-LOCK. This is the SHIPPED behaviour and it is correct: the pool
   * must not invent liveness opinions of its own, or it would need a second
   * registry to disagree with the connection. It is recorded so that the cost
   * of that choice is explicit — an unusable connection that stays silent is
   * handed back for ever, which is exactly what made DEFECT 3 permanent.
   */
  it("BEHAVIOUR-LOCK: a primary that never reports death is handed back for ever, however unusable", () => {
    const { pool, f } = makePool();
    const first = pool.primary();
    expect(f.created, "the first `primary()` mints slot 0").toHaveLength(1);

    // Stand in for any number of FAILED `connect()` calls. Nothing in the pool
    // sees them: the primary is connected outside the pool by `server.ts`'s
    // `ensureConnected`, and a failed `connect()` marks nothing dead.
    for (let i = 0; i < 10; i++) {
      expect(pool.primary(), "still the same object — nothing said it was dead").toBe(first);
    }
    expect(f.created, "and therefore no re-seat, and no second logon").toHaveLength(1);
  });

  /**
   * REGRESSION TEST for DEFECT 3's fix. `markDead()` is SUFFICIENT: the next
   * `primary()` returns a different connection. This is the whole reason the
   * fix could route through the existing death machinery instead of adding a
   * `permanentlyUnusable` predicate to `isSlotDead()`.
   */
  it("REGRESSION: `markDead()` alone re-seats the primary onto a fresh connection", () => {
    const { pool, f } = makePool();
    const first = pool.primary();
    expect(f.created).toHaveLength(1);

    f.created[0]!.markDead(
      "Refused locally by the logon-endpoint lifetime ceiling (5): this connection can never log on again.",
    );

    const second = pool.primary();
    expect(second, "the corpse is not handed back").not.toBe(first);
    expect(f.created, "a fresh session was minted for the seat").toHaveLength(2);

    // And the retirement is FREE. `dropSlot` skips `shutdown()` for a slot it
    // can already see is dead, so closing the brick costs nothing on the wire —
    // load-bearing, because the whole point of the ceiling is to protect
    // `login/fails_to_user_lock`.
    expect(f.created[0]!.shutdowns, "a session known dead gets dispose() only").toEqual([]);
    expect(f.created[0]!.disposals).toBe(1);
  });
});
