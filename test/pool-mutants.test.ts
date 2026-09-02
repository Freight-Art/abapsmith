/**
 * MUTANT KILLERS for `src/adt/pool.ts`.
 *
 * Five mutants were applied to `src/adt/pool.ts` by an audit and killed
 * NOTHING: the whole suite, including `test/pool.test.ts` and the golden
 * baseline tests in `test/pool-characterization.test.ts`, stayed green with each of them in
 * place. A behaviour no test can distinguish from its own negation is not
 * covered, whatever the coverage report says.
 *
 * Each `it` below names exactly one of those mutants and is written to be the
 * test that dies when it is re-applied. Nothing here duplicates an assertion
 * `test/pool.test.ts` already makes; each one reaches a case that file's fixtures
 * cannot construct.
 *
 * ENTIRELY OFFLINE — see `test/pool-doubles.ts`.
 */
import { describe, expect, it } from "vitest";
import { AdtSessionPool } from "../src/adt/pool.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { SessionBusyError } from "../src/adt/session-lock.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";
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
// Mutant A — `evictStaleIdle` drops the `s.busy` guard
// ===========================================================================

/**
 * MUTANT: `if (s.pinned || s.busy || isSlotDead(s)) continue;`
 *      →  `if (s.pinned || isSlotDead(s)) continue;`
 *
 * The sweep would then evict a slot that is LEASED RIGHT NOW: `dropSlot`
 * removes it from `this.slots` and calls `conn.dispose()` underneath a caller
 * that is still running on that connection. The caller's later `release()`
 * lands on a slot the pool no longer owns, so the eviction is invisible in
 * `stats()` afterwards — which is exactly why no existing assertion notices.
 *
 * WHY `test/pool.test.ts` MISSES IT. Its three eviction tests all sweep with
 * every non-pinned slot IDLE (the sweep runs at release time, so the slot just
 * released is fresh and the others were released earlier). The mutant needs a
 * NON-PINNED slot that is BUSY and STALE at the moment some OTHER slot is
 * released, and no fixture there builds one: at `maxSessions: 1` the only
 * non-pinned slot cannot exist, and the two-slot fixtures always release both.
 */
describe("mutant: evict-busy-slot", () => {
  it("never evicts a leased slot, however stale its last release looks", async () => {
    const { pool, f, c } = makePool({
      maxSessions: 2,
      readConcurrency: 2,
      sessionIdleMs: 1_000,
    });

    // Slot 0 (pinned) takes A. Slot 1 is then CREATED for B — and a fresh
    // slot's `lastReleasedAt` is its creation time, so slot 1 looks "idle
    // since t0" for the whole time it is busy. That is the trap.
    const holdA = deferred();
    const holdB = deferred();
    const a = pool.withRead("a", async () => holdA.promise);
    await settle();
    const b = pool.withRead("b", async () => holdB.promise);
    await settle();
    expect(f.created, "two slots, both leased").toHaveLength(2);
    expect(pool.stats().busy).toBe(2);

    c.advance(5_000); // slot 1 is now 5x past sessionIdleMs — and still busy

    holdA.resolve();
    await a; // releases slot 0, which runs the stale sweep

    expect(pool.stats().total, "the busy slot must survive the sweep").toBe(2);
    expect(pool.stats().busy, "and must still be counted as leased").toBe(1);
    expect(
      f.created[1]!.disposals,
      "disposing a connection a caller is still running on is the whole bug",
    ).toBe(0);
    expect(f.created[1]!.shutdowns).toEqual([]);

    holdB.resolve();
    await b;
    // The control, so this test cannot pass against a mutant that simply never
    // evicts anything: once slot 1 is genuinely IDLE and genuinely stale, the
    // next release does sweep it.
    c.advance(2_000);
    await pool.withRead("c", async () => undefined);
    expect(pool.stats().total, "a genuinely idle stale slot is still evicted").toBe(1);
  });
});

// ===========================================================================
// Mutant B — `drainWaiters` rejects in place instead of emptying the queue
// ===========================================================================

/**
 * MUTANT: `for (const w of this.waiters.splice(0)) w.reject(err);`
 *      →  `for (const w of [...this.waiters]) w.reject(err);`
 *
 * THE MOST SERIOUS OF THE FIVE, because it makes a PERMANENT BUSY-SLOT LEAK
 * reachable. A settled-but-still-queued waiter is a live entry `handoff()` will
 * hand a slot to: `tryTake` sets `busy = true`, then `w.resolve` is a no-op
 * because the waiter already rejected — so the slot is leased to nobody, and
 * nobody is left to release it. At `maxSessions = 1` that is the entire pool,
 * wedged for the life of the process, with `stats()` reporting a perfectly
 * ordinary `busy: 1`.
 *
 * Two independent kills below: the queue must be EMPTY after a drain (the
 * direct observation), and `handoff()` must refuse to spend a slot on a settled
 * waiter even if one somehow ends up queued (the belt to that braces).
 */
describe("mutant: drainWaiters does not clear the queue", () => {
  it("shutdown leaves the waiter queue EMPTY, not merely rejected", async () => {
    const { pool } = makePool();
    const hold = deferred();
    const running = pool.withRead("holder", async () => hold.promise);
    await settle();
    const parked = pool.withRead("parked", async () => undefined);
    await settle();
    expect(pool.stats().waiting).toBe(1);

    const drained = parked.then(() => null).catch((e: unknown) => e);
    await pool.shutdown("SIGTERM");

    const e = await drained;
    expect(isAbapError(e)).toBe(true);
    expect((e as AbapError).code).toBe("NOT_CONNECTED");
    // The assertion the mutant fails. Rejecting a waiter without removing it
    // leaves `waiting: 1` forever — a queue that can never drain and that
    // `handoff` will keep trying to serve.
    expect(pool.stats().waiting, "a drained queue is an EMPTY queue").toBe(0);

    hold.resolve();
    await running;
    expect(pool.stats().waiting, "and it stays empty once the holder releases").toBe(0);
  });

  it("a settled waiter can never be handed a slot — no busy-slot leak", async () => {
    // Reaches `handoff()`'s settled-waiter guard without needing the mutant, by
    // letting the parked caller time out at the exact moment capacity frees.
    const { pool, c } = makePool({ sessionWaitMs: 5_000 });
    const hold = deferred();
    const running = pool.withRead("holder", async () => hold.promise);
    await settle();
    const parked = pool.withRead("parked", async () => undefined);
    await settle();
    expect(pool.stats().waiting).toBe(1);

    c.advance(5_000); // the waiter's budget expires...
    await expect(parked).rejects.toBeInstanceOf(SessionBusyError);
    expect(pool.stats().waiting).toBe(0);

    hold.resolve(); // ...and only then does the slot come free
    await running;

    expect(pool.stats(), "no slot may be left leased to a caller that gave up").toEqual({
      total: 1,
      busy: 0,
      idle: 1,
      waiting: 0,
      dead: 0,
    });
    // The proof that it is genuinely usable and not merely counted as idle.
    await expect(pool.withRead("after", async () => "ok")).resolves.toBe("ok");
  });
});

// ===========================================================================
// Mutant C — no handoff when acquisition gives up
// ===========================================================================

/**
 * MUTANT: delete `this.handoff();` from `acquire()`'s give-up branch.
 *
 * Retiring an unpreparable slot FREES CAPACITY. The caller that discovered the
 * corpse is about to walk away without using it, so if nobody hands that
 * capacity to the parked queue, the queue waits for a release that is never
 * coming — every waiter burns its full `sessionWaitMs` and fails, while the
 * pool sits idle. It is a stall, not a crash, which is why a green suite is
 * perfectly happy with it.
 *
 * WHY `test/pool.test.ts` MISSES IT. Its two preparation-failure tests
 * ("retires a slot whose preparation rejects…", "keeps ONE absolute wait
 * budget…") have NO parked waiter at all — the failing caller is the only one
 * in the pool, so there is nothing for the handoff to serve and its presence or
 * absence is unobservable.
 *
 * `sessionWaitMs: 0` makes the deadline arrive without advancing the clock, so
 * the parked caller's own timer (armed on the injected wheel, never fired) is
 * provably not what settles it. It can only have been the handoff.
 */
describe("mutant: no handoff when acquisition gives up", () => {
  it("hands the capacity freed by a retired slot to the parked queue", async () => {
    const f = factory();
    const c = clock();
    let prepares = 0;
    const gate = deferred();
    const pool = new AdtSessionPool({
      cfg: cfg({ sessionWaitMs: 0 }),
      breaker: new AuthCircuitBreaker(),
      createConnection: f.create,
      now: c.now,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
      prepareConnection: async () => {
        prepares++;
        if (prepares === 1) {
          await gate.promise; // hold the first caller inside prepare()
          throw new Error("logon refused");
        }
      },
    });

    const first = pool.withRead("first", async () => "first");
    await settle();
    const parked = pool.withRead("parked", async () => "parked");
    await settle();
    expect(pool.stats().waiting, "the second caller is queued behind the first").toBe(1);
    expect(c.armed(), "its timer is armed on the injected wheel and never fires").toBe(1);

    gate.resolve(); // the first caller's preparation now fails, past its deadline
    await expect(first).rejects.toBeInstanceOf(SessionBusyError);
    await settle();

    // The assertion the mutant fails, and it fails it instantly rather than by
    // timing out: without the handoff the waiter is still parked.
    expect(pool.stats().waiting, "the freed capacity must go to the queue").toBe(0);
    await expect(parked, "and the parked caller must actually run").resolves.toBe("parked");
    expect(prepares, "on a replacement session, prepared once").toBe(2);
    expect(f.created).toHaveLength(2);
  });
});

// ===========================================================================
// Mutants D and E — the two boundary comparisons
// ===========================================================================

/**
 * MUTANT D: `if (s.lastReleasedAt <= cutoff)` → `if (s.lastReleasedAt < cutoff)`
 *           in `evictStaleIdle`.
 *
 * The comparison is INCLUSIVE on purpose. `sessionIdleMs` is a PRESUME-STALE
 * horizon, not a measurement — L2 forbids probing, and the number is chosen to
 * sit well under the ~32-minute passive expiry observed live. At the horizon the
 * presumption applies; `<` would keep a slot that is, by the module's own
 * definition, stale. One tick of drift here is invisible in production and
 * invisible to every existing test, because none of them lands a release
 * EXACTLY `sessionIdleMs` before a sweep — `test/pool.test.ts` advances 5 000
 * against a 1 000 ms horizon, five times past the boundary.
 */
describe("mutant: idle-eviction boundary is inclusive", () => {
  it("evicts a slot released EXACTLY sessionIdleMs before the sweep", async () => {
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

    holdB.resolve();
    await b; // slot 1 released at T; sweep at T sees cutoff = T - 1000, no evictions
    expect(pool.stats().total).toBe(2);

    c.advance(1_000); // now exactly one horizon later

    holdA.resolve();
    await a; // release slot 0 → sweep at T+1000, cutoff = T, slot1.lastReleasedAt = T

    expect(pool.stats().total, "lastReleasedAt === cutoff is STALE, not fresh").toBe(1);
    expect(f.created[1]!.disposals).toBe(1);
    expect(f.created[1]!.shutdowns, "a live-but-stale session is dropped politely").toEqual([
      "pool-evict",
    ]);
    expect(f.created[0]!.disposals, "the pinned primary is exempt regardless").toBe(0);
  });
});

/**
 * MUTANT E: `if (this.now() >= deadline)` → `if (this.now() > deadline)` in
 *           `acquire()`.
 *
 * `deadline` is an ABSOLUTE instant, and at the instant it arrives the budget
 * is spent. `>` buys one extra iteration — and an iteration is not free: it
 * constructs another `AbapConnection` and issues another LOGON against the one
 * shared `login/fails_to_user_lock` counter (L3). The caller-visible outcome is
 * IDENTICAL either way (`SessionBusyError` / `wait-timeout` with the same
 * message shape), which is precisely why no existing assertion catches it: the
 * only observable difference is how many sessions were burned getting there.
 * So this test asserts the COUNTS, not the error.
 */
describe("mutant: wait-deadline boundary is inclusive", () => {
  it("spends no extra logon when preparation fails exactly at the deadline", async () => {
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
        c.advance(5_000); // lands the failure ON the deadline, not past it
        throw new Error("connect failed");
      },
    });

    const e = await pool
      .withRead("r", async () => undefined)
      .then(() => null)
      .catch((err: unknown) => err);

    expect(e).toBeInstanceOf(SessionBusyError);
    expect((e as SessionBusyError).reason).toBe("wait-timeout");
    // The two assertions the mutant fails. Under `>` the loop takes a second
    // turn: two preparations, two connections, two logons.
    expect(prepares, "now() === deadline means the budget is GONE, not nearly gone").toBe(1);
    expect(f.created, "one exhausted budget must cost exactly one session").toHaveLength(1);
    expect(pool.stats().total, "and the corpse is still dropped").toBe(0);
  });
});
