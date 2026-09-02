/**
 * SessionLock — behavioural tests.
 *
 * RULE FOLLOWED HERE: every test must fail against a naive or absent
 * implementation. A test that only proves "the function returned the shape I
 * fed it" is worthless — that is exactly the kind of green suite that let a
 * concurrent-request bug ship. So:
 *
 *  - concurrency is proven with an ORDERING LOG (a lock that does nothing
 *    produces a visibly interleaved log), never with a call count;
 *  - re-entrancy is proven by the nested call COMPLETING and by the holder
 *    being unchanged, so a lock without ALS deadlocks or reassigns the hold;
 *  - fail-fast is proven by the SYNCHRONOUS throw / by an immediate rejection
 *    while the blocker is still held, so a lock that quietly queued would pass
 *    a "did it eventually run" assertion but fails these;
 *  - cleanup is proven by the NEXT caller getting the lock, so a leaked hold
 *    is caught rather than hidden.
 *
 * Time is entirely fake: an injected clock plus an injected timer queue. The
 * suite touches no real timers, so it cannot hang the runner and runs in ms.
 */
import { describe, expect, it } from "vitest";
import {
  SessionBusyError,
  SessionLock,
  type Release,
  type SessionLockOptions,
} from "../src/adt/session-lock.js";

// --------------------------------------------------------------------------
// fake clock + timer queue
// --------------------------------------------------------------------------

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
  cancelled: boolean;
}

class FakeClock {
  t = 0;
  private seq = 0;
  private readonly timers: FakeTimer[] = [];

  now = (): number => this.t;

  setTimer = (fn: () => void, ms: number): unknown => {
    const timer: FakeTimer = { id: ++this.seq, at: this.t + ms, fn, cancelled: false };
    this.timers.push(timer);
    return timer;
  };

  clearTimer = (h: unknown): void => {
    if (h && typeof h === "object" && "cancelled" in h) {
      (h as FakeTimer).cancelled = true;
    }
  };

  /** Timers still armed — used to prove nothing was left behind. */
  get pending(): number {
    return this.timers.filter((x) => !x.cancelled).length;
  }

  /** Advance time, firing due timers in chronological order, flushing microtasks. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      let next: FakeTimer | undefined;
      for (const timer of this.timers) {
        if (timer.cancelled || timer.at > target) continue;
        if (next === undefined || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) {
          next = timer;
        }
      }
      if (next === undefined) break;
      this.t = Math.max(this.t, next.at);
      next.cancelled = true;
      next.fn();
      await flush();
    }
    this.t = target;
    await flush();
  }
}

/** Drain the microtask queue. Generous enough for a few chained awaits. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Settle a promise into a value or the thrown error, so nothing is unhandled. */
function settle<T>(p: Promise<T>): Promise<T | unknown> {
  return p.then(
    (v) => v,
    (e: unknown) => e,
  );
}

function makeLock(
  clock: FakeClock,
  opts: Omit<SessionLockOptions, "now" | "setTimer" | "clearTimer"> = {},
  log?: string[],
): SessionLock {
  return new SessionLock({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...(log ? { log: (m: string) => log.push(m) } : {}),
    ...opts,
  });
}

function asBusy(e: unknown): SessionBusyError {
  expect(e).toBeInstanceOf(SessionBusyError);
  return e as SessionBusyError;
}

// --------------------------------------------------------------------------

describe("SessionLock — mutual exclusion", () => {
  it("serialises two concurrent runExclusive bodies (proven by ordering, not call counts)", async () => {
    const clock = new FakeClock();
    const lock = makeLock(clock);
    const order: string[] = [];
    const gateA = deferred();
    const gateB = deferred();

    const a = lock.runExclusive("A", async () => {
      order.push("A:enter");
      await gateA.promise;
      order.push("A:exit");
      return "a";
    });
    const b = lock.runExclusive("B", async () => {
      order.push("B:enter");
      await gateB.promise;
      order.push("B:exit");
      return "b";
    });

    await flush();
    // A lock that does not serialise would already show "B:enter" here.
    expect(order).toEqual(["A:enter"]);
    expect(lock.queueDepth).toBe(1);
    expect(lock.currentHolder()).toMatchObject({ op: "A", kind: "exclusive" });

    gateA.resolve();
    await flush();
    // B only starts after A has fully exited.
    expect(order).toEqual(["A:enter", "A:exit", "B:enter"]);
    expect(lock.queueDepth).toBe(0);
    expect(lock.currentHolder()).toMatchObject({ op: "B" });

    gateB.resolve();
    expect(await a).toBe("a");
    expect(await b).toBe("b");
    expect(order).toEqual(["A:enter", "A:exit", "B:enter", "B:exit"]);
    expect(lock.currentHolder()).toBeNull();
  });

  it("hands the lock to waiters in FIFO order", async () => {
    const clock = new FakeClock();
    const lock = makeLock(clock);
    const order: string[] = [];
    const gate = deferred();

    const first = lock.runExclusive("first", async () => {
      order.push("first");
      await gate.promise;
    });
    const rest = ["w1", "w2", "w3"].map((op) =>
      lock.runExclusive(op, async () => {
        order.push(op);
      }),
    );

    await flush();
    expect(lock.queueDepth).toBe(3);
    gate.resolve();
    await Promise.all([first, ...rest]);
    expect(order).toEqual(["first", "w1", "w2", "w3"]);
  });

  it("releases the lock when the body throws, and the next waiter still runs", async () => {
    const clock = new FakeClock();
    const lock = makeLock(clock);
    const gate = deferred();
    let waiterRan = false;

    const boom = settle(
      lock.runExclusive("boom", async () => {
        await gate.promise;
        throw new Error("kaboom");
      }),
    );
    const after = lock.runExclusive("after", async () => {
      waiterRan = true;
      return 42;
    });

    await flush();
    expect(waiterRan).toBe(false);
    gate.resolve();

    const err = await boom;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("kaboom");
    // The throw must not wedge the connection.
    expect(await after).toBe(42);
    expect(waiterRan).toBe(true);
    expect(lock.currentHolder()).toBeNull();
    expect(lock.queueDepth).toBe(0);
  });
});

describe("SessionLock — re-entrancy (AsyncLocalStorage)", () => {
  it("does not deadlock on runExclusive nested inside runExclusive", async () => {
    const clock = new FakeClock();
    const lock = makeLock(clock);
    const order: string[] = [];

    const result = await lock.runExclusive("outer", async () => {
      order.push("outer:enter");
      const inner = await lock.runExclusive("inner", async () => {
        order.push("inner");
        // No queueing and no change of holder: the nested call reuses the hold.
        expect(lock.queueDepth).toBe(0);
        expect(lock.currentHolder()).toMatchObject({ op: "outer", kind: "exclusive" });
        // Three levels deep must still work.
        return lock.runExclusive("innermost", async () => {
          order.push("innermost");
          return "deep";
        });
      });
      order.push("outer:exit");
      return inner;
    });

    expect(result).toBe("deep");
    expect(order).toEqual(["outer:enter", "inner", "innermost", "outer:exit"]);
    // The nested frames must NOT have released the outer hold on their way out.
    expect(lock.currentHolder()).toBeNull();
  });

  it("acquireImplicit inside a runExclusive body passes straight through (guard-deadlock regression)", async () => {
    const clock = new FakeClock();
    const lock = makeLock(clock);

    await lock.runExclusive("write", async () => {
      let resolved = false;
      const p = lock.acquireImplicit("PUT /source/main").then((r) => {
        resolved = true;
        return r;
      });
      // One microtask, no queue, no timer: this is what makes the HTTP guard
      // usable from inside runExclusive at all.
      await flush();
      expect(resolved).toBe(true);
      expect(lock.queueDepth).toBe(0);

      const release: Release = (await p) as Release;
      expect(lock.currentHolder()).toMatchObject({ op: "write" });
      release();
      // The pass-through release is a no-op: it must NOT free the outer hold.
      expect(lock.currentHolder()).toMatchObject({ op: "write", kind: "exclusive" });
      release(); // idempotent, still a no-op
      expect(lock.currentHolder()).toMatchObject({ op: "write" });
    });

    expect(lock.currentHolder()).toBeNull();
  });

  it("does not leak re-entrancy across two different locks", async () => {
    const clock = new FakeClock();
    const a = makeLock(clock);
    const b = makeLock(clock);

    await a.runExclusive("on-a", async () => {
      // The ALS store is module-level; only token IDENTITY may grant re-entry,
      // so lock B must genuinely acquire rather than wave the caller through.
      await b.runExclusive("on-b", async () => {
        expect(b.currentHolder()).toMatchObject({ op: "on-b" });
        expect(a.currentHolder()).toMatchObject({ op: "on-a" });
      });
      expect(b.currentHolder()).toBeNull();
    });
  });

  it("acquireImplicit outside any hold acquires for real and serialises", async () => {
    const clock = new FakeClock();
    const lock = makeLock(clock);
    const release = await lock.acquireImplicit("GET /nodestructure");
    expect(lock.currentHolder()).toMatchObject({ op: "GET /nodestructure", kind: "exclusive" });

    let secondGranted = false;
    const second = lock.acquireImplicit("GET /objectstructure").then((r) => {
      secondGranted = true;
      return r;
    });
    await flush();
    expect(secondGranted).toBe(false);
    expect(lock.queueDepth).toBe(1);

    release();
    const r2 = await second;
    expect(secondGranted).toBe(true);
    expect(lock.currentHolder()).toMatchObject({ op: "GET /objectstructure" });
    r2();
    expect(lock.currentHolder()).toBeNull();
  });
});

describe("SessionLock — re-entrancy survives a foreign lock in between", () => {
  /**
   * The ALS store is MODULE-LEVEL and shared by every instance, and `als.run`
   * REPLACES the store instead of merging into it. Storing one token per `run`
   * therefore made an enclosing hold on lock A INVISIBLE as soon as a hold on
   * lock B was nested inside it — A's innermost frame failed its own
   * re-entrancy check and queued behind A's own outer hold.
   *
   * Every test in this block is written so that failure is a HANG, and a hang
   * is asserted as a failure WITHOUT advancing the fake clock. The clock never
   * moves here, so a regression cannot masquerade as "slow but green": the
   * wait-timeout that would eventually unwedge the deadlock is never reached.
   */

  /**
   * The value `p` settled to, or the PENDING sentinel if it is STILL unsettled
   * after draining the microtask queue far beyond what a correct
   * implementation needs. No timer is ever fired and the clock never moves, so
   * a deadlocked promise can only come back as PENDING.
   */
  const PENDING = Symbol("still-pending");
  async function settledOrPending<T>(p: Promise<T>): Promise<T | unknown> {
    let out: unknown = PENDING;
    void settle(p).then((v) => {
      out = v;
    });
    for (let i = 0; i < 200; i++) await Promise.resolve();
    return out;
  }

  it("A → B → A completes promptly instead of deadlocking until waitTimeoutMs", async () => {
    const clock = new FakeClock();
    // Short timeout AND a frozen clock: the only way out of the deadlock is
    // the fix, not patience.
    const a = makeLock(clock, { waitTimeoutMs: 50 });
    const b = makeLock(clock, { waitTimeoutMs: 50 });
    const order: string[] = [];

    const outer = a.runExclusive("a-outer", async () => {
      order.push("a-outer");
      return b.runExclusive("b-middle", async () => {
        order.push("b-middle");
        // Back onto A, which THIS async context already holds. Pre-fix the ALS
        // store here is {token: b-middle} and A's own token is gone, so this
        // parked behind "a-outer" and could only ever fail at waitTimeoutMs.
        return a.runExclusive("a-inner", async () => {
          order.push("a-inner");
          // Re-entered, not re-acquired: no queueing, holder unchanged.
          expect(a.queueDepth).toBe(0);
          expect(a.currentHolder()).toMatchObject({ op: "a-outer", kind: "exclusive" });
          return "deep";
        });
      });
    });

    const result = await settledOrPending(outer);
    expect(result).not.toBe(PENDING);
    expect(result).toBe("deep");
    expect(order).toEqual(["a-outer", "b-middle", "a-inner"]);

    // Nothing waited: the clock never moved and no wait timer survives.
    expect(clock.t).toBe(0);
    expect(clock.pending).toBe(0);
    expect(a.currentHolder()).toBeNull();
    expect(b.currentHolder()).toBeNull();
    // Both locks are genuinely free afterwards — no hold was leaked by the
    // pass-through frame.
    expect(await a.runExclusive("after-a", async () => "a-ok")).toBe("a-ok");
    expect(await b.runExclusive("after-b", async () => "b-ok")).toBe("b-ok");
  });

  it("nests four deep across three locks and never queues on a re-entry", async () => {
    const clock = new FakeClock();
    const a = makeLock(clock, { waitTimeoutMs: 50 });
    const b = makeLock(clock, { waitTimeoutMs: 50 });
    const c = makeLock(clock, { waitTimeoutMs: 50 });
    const order: string[] = [];

    const run = a.runExclusive("a1", async () => {
      order.push("a1");
      return b.runExclusive("b1", async () => {
        order.push("b1");
        return c.runExclusive("c1", async () => {
          order.push("c1");
          // A and B are both still owned by this context, two and one frames
          // up respectively. Both must be re-enterable from here.
          return a.runExclusive("a2", async () => {
            order.push("a2");
            expect(a.queueDepth).toBe(0);
            expect(a.currentHolder()).toMatchObject({ op: "a1" });
            return b.runExclusive("b2", async () => {
              order.push("b2");
              expect(b.queueDepth).toBe(0);
              expect(b.currentHolder()).toMatchObject({ op: "b1" });
              return c.runExclusive("c2", async () => {
                order.push("c2");
                expect(c.queueDepth).toBe(0);
                expect(c.currentHolder()).toMatchObject({ op: "c1" });
                return "bottom";
              });
            });
          });
        });
      });
    });

    const result = await settledOrPending(run);
    expect(result).not.toBe(PENDING);
    expect(result).toBe("bottom");
    expect(order).toEqual(["a1", "b1", "c1", "a2", "b2", "c2"]);
    expect(clock.t).toBe(0);
    expect(clock.pending).toBe(0);
    for (const lock of [a, b, c]) expect(lock.currentHolder()).toBeNull();
  });

  it("acquireImplicit re-enters its own outer hold through a nested foreign hold", async () => {
    const clock = new FakeClock();
    const a = makeLock(clock, { waitTimeoutMs: 50 });
    const b = makeLock(clock, { waitTimeoutMs: 50 });

    const run = a.runExclusive("a-write", async () => {
      return b.runExclusive("b-work", async () => {
        // This is the HTTP guard firing from inside a nested foreign hold: the
        // shape `connection.ts` produces once two connections coexist.
        let granted = false;
        const p = a.acquireImplicit("PUT /source/main").then((r) => {
          granted = true;
          return r;
        });
        await flush();
        expect(granted).toBe(true);
        expect(a.queueDepth).toBe(0);

        const release: Release = (await p) as Release;
        // Pass-through: the holder is untouched and the release is inert.
        expect(a.currentHolder()).toMatchObject({ op: "a-write", kind: "exclusive" });
        release();
        release();
        expect(a.currentHolder()).toMatchObject({ op: "a-write", kind: "exclusive" });
        return "guarded";
      });
    });

    const result = await settledOrPending(run);
    expect(result).not.toBe(PENDING);
    expect(result).toBe("guarded");
    expect(clock.t).toBe(0);
    expect(clock.pending).toBe(0);
    expect(a.currentHolder()).toBeNull();
    expect(b.currentHolder()).toBeNull();
  });

  it("a foreign hold still does NOT open the door to a lock this context does not own", async () => {
    // The property the old (incomplete) safety argument was defending, and the
    // one a sloppy fix — "any ambient token means re-entrant", or a set kept
    // across releases — would destroy. B's hold must not let a caller barge
    // past A's hold when A is held by SOMEBODY ELSE.
    const clock = new FakeClock();
    const a = makeLock(clock, { waitTimeoutMs: 1_000 });
    const b = makeLock(clock, { waitTimeoutMs: 1_000 });
    const gate = deferred();
    const order: string[] = [];

    // An unrelated async context takes A and holds it.
    const strangerHoldsA = a.runExclusive("stranger", async () => {
      order.push("stranger:enter");
      await gate.promise;
      order.push("stranger:exit");
    });
    await flush();
    expect(a.currentHolder()).toMatchObject({ op: "stranger" });

    let barged = false;
    const viaB = b.runExclusive("b-work", async () => {
      // Holding B gives this context NO claim on A.
      return a.runExclusive("wants-a", async () => {
        barged = true;
        order.push("wants-a");
        return "got-a";
      });
    });

    await flush();
    // Must have QUEUED, not barged in and not been waved through.
    expect(barged).toBe(false);
    expect(a.queueDepth).toBe(1);
    expect(a.currentHolder()).toMatchObject({ op: "stranger", kind: "exclusive" });
    expect(b.currentHolder()).toMatchObject({ op: "b-work" });

    gate.resolve();
    expect(await viaB).toBe("got-a");
    await strangerHoldsA;
    // Serialised: it ran only after the stranger let go.
    expect(order).toEqual(["stranger:enter", "stranger:exit", "wants-a"]);
    expect(a.currentHolder()).toBeNull();
    expect(b.currentHolder()).toBeNull();
  });

  it("a released outer hold's token cannot re-enter a later, different hold", async () => {
    // Stale-token direction: tokens accumulate in the ambient set for the
    // lifetime of the scope, so the membership test must be against the LIVE
    // hold token or a finished frame could wave itself past a new owner.
    const clock = new FakeClock();
    const a = makeLock(clock, { waitTimeoutMs: 1_000 });
    const b = makeLock(clock, { waitTimeoutMs: 1_000 });

    await b.runExclusive("b-outer", async () => {
      // Take and fully release a hold on A while still inside B's scope...
      await a.runExclusive("a-first", async () => "one");
      expect(a.currentHolder()).toBeNull();

      // ...then let an unrelated context own A, and try again from a scope
      // whose ambient set still contains the DEAD "a-first" token.
      const gate = deferred();
      const other = a.runExclusive("a-other-owner", async () => {
        await gate.promise;
        return "other";
      });
      await flush();
      expect(a.currentHolder()).toMatchObject({ op: "a-other-owner" });

      let barged = false;
      const mine = a.runExclusive("a-second", async () => {
        barged = true;
        return "two";
      });
      await flush();
      expect(barged).toBe(false);
      expect(a.queueDepth).toBe(1);

      gate.resolve();
      expect(await other).toBe("other");
      expect(await mine).toBe("two");
    });
    expect(a.currentHolder()).toBeNull();
    expect(b.currentHolder()).toBeNull();
  });
});

describe("SessionLock — leases fail fast, never queue", () => {
  it("acquireLease throws SESSION_BUSY synchronously while an exclusive hold is active", async () => {
    const clock = new FakeClock();
    const lock = makeLock(clock);
    const gate = deferred();

    const running = lock.runExclusive("activate", async () => {
      await gate.promise;
    });
    await flush();
    clock.t += 250;

    let thrown: unknown;
    try {
      lock.acquireLease("debug-listener");
    } catch (e) {
      thrown = e;
    }
    // Synchronous throw is the contract: the long poll must never be parked.
    const busy = asBusy(thrown);
    expect(busy.code).toBe("SESSION_BUSY");
    expect(busy.reason).toBe("lease-held");
    expect(busy.holder).toBe("activate");
    expect(busy.holderKind).toBe("exclusive");
    expect(busy.heldForMs).toBe(250);
    expect(lock.queueDepth).toBe(0);

    gate.resolve();
    await running;
    // And once free, the lease is grantable.
    expect(lock.acquireLease("debug-listener").released).toBe(false);
  });

  it("a second acquireLease fails fast while a lease is held", () => {
    const clock = new FakeClock();
    const lock = makeLock(clock);
    const first = lock.acquireLease("poll-1", 60_000);
    expect(lock.isLeaseHeld()).toBe(true);
    clock.t += 900;

    const busy = asBusy(
      (() => {
        try {
          lock.acquireLease("poll-2");
          return new Error("acquireLease should have thrown");
        } catch (e) {
          return e;
        }
      })(),
    );
    expect(busy.reason).toBe("lease-held");
    expect(busy.holderKind).toBe("lease");
    expect(busy.holder).toBe("poll-1");
    expect(busy.heldForMs).toBe(900);

    first.release();
    expect(first.released).toBe(true);
    expect(lock.isLeaseHeld()).toBe(false);
    expect(() => lock.acquireLease("poll-2")).not.toThrow();
  });

  it("runExclusive rejects with lease-held and does NOT queue behind a lease", async () => {
    const clock = new FakeClock();
    const lock = makeLock(clock);
    const lease = lock.acquireLease("debug-listener", 300_000);

    let ran = false;
    const rejected = settle(
      lock.runExclusive("read-source", async () => {
        ran = true;
      }),
    );
    await flush();

    const busy = asBusy(await rejected);
    expect(busy.code).toBe("SESSION_BUSY");
    expect(busy.reason).toBe("lease-held");
    expect(busy.holderKind).toBe("lease");
    expect(busy.holder).toBe("debug-listener");
    // The body must never have run, and nothing may be parked: releasing the
    // lease later must not suddenly execute a request the caller gave up on.
    expect(ran).toBe(false);
    expect(lock.queueDepth).toBe(0);

    lease.release();
    await flush();
    expect(ran).toBe(false);
    expect(lock.currentHolder()).toBeNull();
  });

  it("acquireImplicit is shed with lease-held rather than killing the long poll", async () => {
    const clock = new FakeClock();
    const lock = makeLock(clock);
    lock.acquireLease("debug-listener", 300_000);

    const busy = asBusy(await settle(lock.acquireImplicit("GET /source/main")));
    expect(busy.code).toBe("SESSION_BUSY");
    expect(busy.reason).toBe("lease-held");
    expect(lock.queueDepth).toBe(0);
    // The lease is untouched — shedding must not disturb the holder.
    expect(lock.currentHolder()).toMatchObject({ op: "debug-listener", kind: "lease" });
  });

  it("releasing a lease hands off to exclusive waiters queued before it was taken", async () => {
    const clock = new FakeClock();
    const lock = makeLock(clock);
    const gate = deferred();
    const order: string[] = [];

    // Queue a waiter behind an EXCLUSIVE hold, then take a lease after that
    // hold releases; the waiter must be served, not stranded.
    const holder = lock.runExclusive("holder", async () => {
      order.push("holder");
      await gate.promise;
    });
    const waiter = lock.runExclusive("waiter", async () => {
      order.push("waiter");
    });
    await flush();
    expect(lock.queueDepth).toBe(1);

    gate.resolve();
    await Promise.all([holder, waiter]);
    expect(order).toEqual(["holder", "waiter"]);
  });
});

describe("SessionLock — queue limits", () => {
  it("throws queue-full at maxQueue + 1", async () => {
    const clock = new FakeClock();
    const lock = makeLock(clock, { maxQueue: 2 });
    const gate = deferred();

    const holder = lock.runExclusive("holder", async () => {
      await gate.promise;
    });
    const w1 = settle(lock.runExclusive("w1", async () => "w1"));
    const w2 = settle(lock.runExclusive("w2", async () => "w2"));
    await flush();
    expect(lock.queueDepth).toBe(2);

    const overflow = asBusy(await settle(lock.runExclusive("w3", async () => "w3")));
    expect(overflow.code).toBe("SESSION_BUSY");
    expect(overflow.reason).toBe("queue-full");
    expect(overflow.holder).toBe("holder");
    // The rejected caller must not have been parked anyway.
    expect(lock.queueDepth).toBe(2);

    gate.resolve();
    await holder;
    expect(await w1).toBe("w1");
    expect(await w2).toBe("w2");
    // Queue drained: a later caller is admitted again.
    expect(await lock.runExclusive("w4", async () => "w4")).toBe("w4");
  });

  it("times a waiter out, removes it from the queue, and hands off to the NEXT waiter", async () => {
    const clock = new FakeClock();
    const lock = makeLock(clock, { maxQueue: 8, waitTimeoutMs: 1_000 });
    const gate = deferred();
    const ran: string[] = [];

    const holder = lock.runExclusive("holder", async () => {
      await gate.promise;
      ran.push("holder");
    });
    const doomed = settle(
      lock.runExclusive("doomed", async () => {
        ran.push("doomed");
      }),
    );
    await flush();

    // "later" parks 600ms after "doomed", so only "doomed" can time out at 1000.
    await clock.advance(600);
    const later = lock.runExclusive("later", async () => {
      ran.push("later");
      return "later-result";
    });
    await flush();
    expect(lock.queueDepth).toBe(2);

    await clock.advance(400); // t = 1000 → "doomed" gives up
    const busy = asBusy(await doomed);
    expect(busy.code).toBe("SESSION_BUSY");
    expect(busy.reason).toBe("wait-timeout");
    expect(busy.holder).toBe("holder");
    // Removed from the queue — a settled waiter left in place would later be
    // handed a token nobody releases, wedging the connection forever.
    expect(lock.queueDepth).toBe(1);

    gate.resolve();
    await holder;
    // The lock went to the NEXT live waiter, not to the corpse.
    expect(await later).toBe("later-result");
    expect(ran).toEqual(["holder", "later"]);
    expect(lock.currentHolder()).toBeNull();
    expect(lock.queueDepth).toBe(0);
  });

  it("does not time out a waiter that was already served", async () => {
    const clock = new FakeClock();
    const lock = makeLock(clock, { waitTimeoutMs: 1_000 });
    const gate = deferred();

    const holder = lock.runExclusive("holder", async () => {
      await gate.promise;
    });
    const waiter = lock.runExclusive("waiter", async () => "served");
    await flush();

    await clock.advance(200);
    gate.resolve();
    await holder;
    expect(await waiter).toBe("served");

    // Push well past the original deadline: a stale timer must not fire into a
    // finished waiter, and it must not disturb whoever holds the lock now.
    const stillGate = deferred();
    const nowHolding = lock.runExclusive("now-holding", async () => {
      await stillGate.promise;
      return "ok";
    });
    await flush();
    await clock.advance(5_000);
    expect(lock.currentHolder()).toMatchObject({ op: "now-holding" });
    stillGate.resolve();
    expect(await nowHolding).toBe("ok");
  });
});

describe("SessionLock — lease TTL is the only stuck-lease recovery", () => {
  it("force-releases a never-released lease at TTL, logs LEASE_EXPIRED, and the lock becomes usable", async () => {
    const clock = new FakeClock();
    const log: string[] = [];
    const lock = makeLock(clock, {}, log);

    const lease = lock.acquireLease("debug-listener", 5_000);
    expect(lease.expiresAt).toBe(5_000);

    await clock.advance(4_999);
    // Still held: the TTL must not fire early or the long poll dies mid-wait.
    expect(lock.isLeaseHeld()).toBe(true);
    expect(lease.released).toBe(false);
    expect(asBusy(await settle(lock.runExclusive("blocked", async () => "x"))).reason).toBe(
      "lease-held",
    );

    await clock.advance(1);
    expect(lock.isLeaseHeld()).toBe(false);
    expect(lock.currentHolder()).toBeNull();
    expect(lease.released).toBe(true);

    const expired = log.find((l) => l.startsWith("LEASE_EXPIRED"));
    expect(expired).toBeDefined();
    expect(expired).toContain("op=debug-listener");
    expect(expired).toContain("heldForMs=5000");

    // Recovered: the connection is usable again with no server round-trip.
    expect(await lock.runExclusive("after-expiry", async () => "free")).toBe("free");
  });

  it("renew() pushes the TTL out and re-arms the timer", async () => {
    const clock = new FakeClock();
    const log: string[] = [];
    const lock = makeLock(clock, {}, log);
    const lease = lock.acquireLease("debug-listener", 1_000);

    await clock.advance(900);
    lease.renew();
    expect(lease.expiresAt).toBe(1_900);

    await clock.advance(500); // t = 1400 — past the ORIGINAL deadline
    expect(lock.isLeaseHeld()).toBe(true);
    expect(lease.released).toBe(false);
    expect(log.some((l) => l.startsWith("LEASE_EXPIRED"))).toBe(false);

    lease.renew(10_000);
    expect(lease.expiresAt).toBe(11_400);
    await clock.advance(9_999);
    expect(lock.isLeaseHeld()).toBe(true);
    await clock.advance(1);
    expect(lock.isLeaseHeld()).toBe(false);
    expect(log.some((l) => l.startsWith("LEASE_EXPIRED"))).toBe(true);
  });

  it("renew() throws on a released or expired lease instead of re-taking the lock", async () => {
    const clock = new FakeClock();
    const lock = makeLock(clock);

    const released = lock.acquireLease("poll-a", 1_000);
    released.release();
    expect(() => released.renew()).toThrow(/already released/i);
    expect(lock.currentHolder()).toBeNull();

    const expiring = lock.acquireLease("poll-b", 1_000);
    await clock.advance(1_000);
    expect(expiring.released).toBe(true);
    expect(() => expiring.renew()).toThrow(/already released|expired/i);
    // Critically: the failed renew did not resurrect the hold.
    expect(lock.currentHolder()).toBeNull();
  });

  it("a lease TTL expiry hands the lock to a waiter queued while the lease was taken later", async () => {
    // A waiter parked behind an exclusive hold, which then expires via lease
    // TTL, must still be served — the expiry path goes through the normal
    // release, not a shortcut that forgets the queue.
    const clock = new FakeClock();
    const lock = makeLock(clock);
    const lease = lock.acquireLease("stuck-poll", 2_000);
    expect(lease.released).toBe(false);
    await clock.advance(2_000);
    expect(await lock.runExclusive("recovered", async () => "yes")).toBe("yes");
  });
});

describe("SessionLock — release idempotence", () => {
  it("a double release() never frees a hold a later caller now owns", async () => {
    const clock = new FakeClock();
    const lock = makeLock(clock);
    const lease = lock.acquireLease("debug-listener", 60_000);
    lease.release();
    expect(lease.released).toBe(true);

    const gate = deferred();
    const later = lock.runExclusive("later-owner", async () => {
      await gate.promise;
      return "done";
    });
    await flush();
    expect(lock.currentHolder()).toMatchObject({ op: "later-owner" });

    // The stale release must be inert. If it were not, the session would admit
    // a second concurrent request and cancel any outstanding long poll.
    lease.release();
    lease.release();
    expect(lock.currentHolder()).toMatchObject({ op: "later-owner", kind: "exclusive" });

    gate.resolve();
    expect(await later).toBe("done");
    expect(lock.currentHolder()).toBeNull();
  });

  it("a double implicit Release never frees a later holder", async () => {
    const clock = new FakeClock();
    const lock = makeLock(clock);
    const release = await lock.acquireImplicit("req-1");
    release();
    expect(lock.currentHolder()).toBeNull();

    const gate = deferred();
    const later = lock.runExclusive("later-owner", async () => {
      await gate.promise;
    });
    await flush();
    release();
    release();
    expect(lock.currentHolder()).toMatchObject({ op: "later-owner" });
    gate.resolve();
    await later;
  });

  it("a lease force-released by TTL cannot later steal the lock back via release()", async () => {
    const clock = new FakeClock();
    const lock = makeLock(clock);
    const lease = lock.acquireLease("stuck", 1_000);
    await clock.advance(1_000);
    expect(lease.released).toBe(true);

    const gate = deferred();
    const owner = lock.runExclusive("new-owner", async () => {
      await gate.promise;
    });
    await flush();
    lease.release();
    expect(lock.currentHolder()).toMatchObject({ op: "new-owner" });
    gate.resolve();
    await owner;
  });
});

describe("SessionLock — forceRelease", () => {
  it("rejects every queued waiter instead of leaving them pending forever", async () => {
    const clock = new FakeClock();
    const log: string[] = [];
    const lock = makeLock(clock, { maxQueue: 8 }, log);
    const gate = deferred();
    const ran: string[] = [];

    const holder = settle(
      lock.runExclusive("holder", async () => {
        await gate.promise;
        ran.push("holder");
      }),
    );
    const w1 = settle(
      lock.runExclusive("w1", async () => {
        ran.push("w1");
      }),
    );
    const w2 = settle(
      lock.runExclusive("w2", async () => {
        ran.push("w2");
      }),
    );
    await flush();
    expect(lock.queueDepth).toBe(2);

    lock.forceRelease("dropSession");

    const e1 = asBusy(await w1);
    const e2 = asBusy(await w2);
    for (const e of [e1, e2]) {
      expect(e.code).toBe("SESSION_BUSY");
      expect(e.message).toContain("dropSession");
    }
    // Nothing parked, nothing held, no waiter body ever ran.
    expect(lock.queueDepth).toBe(0);
    expect(lock.currentHolder()).toBeNull();
    expect(ran).toEqual([]);
    expect(log.some((l) => l.includes("SESSION_LOCK_FORCE_RELEASE") && l.includes("dropSession"))).toBe(
      true,
    );

    // The abandoned holder finishing must not hand the lock to a corpse.
    gate.resolve();
    await holder;
    expect(lock.currentHolder()).toBeNull();
    expect(await lock.runExclusive("after", async () => "ok")).toBe("ok");
  });

  it("cancels a lease TTL timer so an expired-but-forced lease logs nothing later", async () => {
    const clock = new FakeClock();
    const log: string[] = [];
    const lock = makeLock(clock, {}, log);
    const lease = lock.acquireLease("debug-listener", 1_000);

    lock.forceRelease("shutdown");
    expect(lease.released).toBe(true);
    expect(lock.currentHolder()).toBeNull();
    expect(clock.pending).toBe(0);

    await clock.advance(10_000);
    expect(log.some((l) => l.startsWith("LEASE_EXPIRED"))).toBe(false);
    // And the lock is immediately reusable.
    expect(await lock.runExclusive("after", async () => "ok")).toBe("ok");
  });

  it("is safe on an idle lock", async () => {
    const clock = new FakeClock();
    const lock = makeLock(clock);
    expect(() => lock.forceRelease("idle")).not.toThrow();
    expect(lock.currentHolder()).toBeNull();
    expect(await lock.runExclusive("after", async () => "ok")).toBe("ok");
  });
});

describe("SessionLock — observability", () => {
  it("currentHolder reports kind and elapsed time from the injected clock", async () => {
    const clock = new FakeClock();
    const lock = makeLock(clock);
    expect(lock.currentHolder()).toBeNull();
    expect(lock.isLeaseHeld()).toBe(false);

    const lease = lock.acquireLease("debug-listener", 30_000);
    clock.t += 1_234;
    expect(lock.isLeaseHeld()).toBe(true);
    expect(lock.currentHolder()).toEqual({
      op: "debug-listener",
      kind: "lease",
      heldForMs: 1_234,
    });

    lease.release();
    const gate = deferred();
    const running = lock.runExclusive("activate", async () => {
      await gate.promise;
    });
    await flush();
    clock.t += 7;
    expect(lock.isLeaseHeld()).toBe(false);
    expect(lock.currentHolder()).toEqual({ op: "activate", kind: "exclusive", heldForMs: 7 });
    gate.resolve();
    await running;
  });
});
