/**
 * The session-pool core (`src/adt/pool.ts`).
 *
 * ENTIRELY OFFLINE. Not one byte reaches a socket: every connection is a stub
 * handed to the pool through `opts.createConnection`, the clock and the timers
 * are injected, and no `AbapConnection` is ever constructed. That is the point
 * of the factory seam — the pool's contention, retirement and fairness rules
 * are all decidable without a server, and a suite that needed one would be
 * slow, flaky and untrustworthy about exactly the timing it claims to pin.
 *
 * This suite deliberately does NOT build a `Config` through `ConfigSchema.parse`
 * or `loadConfig`. The pool reads five numeric fields and nothing else, so a
 * literal double is both sufficient and honest; the real resolution of those
 * fields (env string in, `1 / 1 / 1 / 300000 / 10000` out) is pinned in
 * `test/config-concurrency.test.ts`, which is where it belongs. Keeping the
 * double here also keeps this file out of the connection-building population
 * that `test/system-role-probe-guard.test.ts` polices — nothing here opens,
 * or can open, a connection.
 *
 * ## What each block is written to CATCH
 *
 * Stated per `describe`. The rule applied throughout: a test that only proves
 * "the code handles the shape the test fed it" earns nothing. Every assertion
 * below names a plausible edit to `src/adt/pool.ts` that it would turn red.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Config } from "../src/config.js";
import type { AbapConnection, ConnectionOptions } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { SessionBusyError } from "../src/adt/session-lock.js";
import {
  AdtSessionPool,
  InProcessObjectGate,
  createSessionPool,
  DEBUG_CONCURRENCY,
  DIA_COST_PER_DEBUG_SESSION,
  type ObjectGate,
  type SessionPool,
} from "../src/adt/pool.js";

// ---------------------------------------------------------------------------
// Keep this file's default gate off the filesystem.
//
// `AdtSessionPool`'s constructor reads `ABAP_CROSS_PROCESS_OBJECT_LOCK`
// straight off `process.env` (there is no `Config` field for it — see
// `src/adt/pool.ts`'s three-way gate-selection comment above the
// constructor), so whenever a test here pins `serialiseSameObjectWrites` to
// anything other than `false` — including leaving it `undefined`, to test
// the shipped default — the constructor's OWN default would otherwise mint a
// `FileLockObjectGate`, which does real (if brief) file-lock I/O. That
// breaks this file's stated "not one byte reaches a socket" / deterministic
// promise: `settle()` drains microtasks, not libuv's threadpool.
//
// Forcing the env var to `"false"` for the whole file still exercises the
// constructor's real default-selection branch between `NoopObjectGate` and
// `InProcessObjectGate` (branches 1 vs 2 in that comment) — it only removes
// the third branch, which is covered on its own terms, against a real state
// dir, in test/pool-cross-process-object-gate.test.ts. `vitest.config.ts`
// pins `fileParallelism: false`, so this file's `afterAll` is guaranteed to
// restore the original value before any other test file runs.
const ORIGINAL_CROSS_PROCESS_OBJECT_LOCK = process.env.ABAP_CROSS_PROCESS_OBJECT_LOCK;
beforeAll(() => {
  process.env.ABAP_CROSS_PROCESS_OBJECT_LOCK = "false";
});
afterAll(() => {
  if (ORIGINAL_CROSS_PROCESS_OBJECT_LOCK === undefined) {
    delete process.env.ABAP_CROSS_PROCESS_OBJECT_LOCK;
  } else {
    process.env.ABAP_CROSS_PROCESS_OBJECT_LOCK = ORIGINAL_CROSS_PROCESS_OBJECT_LOCK;
  }
});

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** The seven fields the pool reads. Everything else is irrelevant to it. */
interface Sizing {
  maxSessions: number;
  readConcurrency: number;
  writeConcurrency: number;
  sessionIdleMs: number;
  sessionWaitMs: number;
  debugDiaBudget: number;
  /**
   * `boolean | undefined` (not just `boolean`) so a test can pass
   * `serialiseSameObjectWrites: undefined` through `cfg()`'s spread to pin
   * the true "unset" default distinctly from an explicit `false` — see the
   * "ObjectGate" describe block below.
   */
  serialiseSameObjectWrites: boolean | undefined;
}

/**
 * A fixed SERIAL baseline, pinned here on purpose. This is NOT a mirror of the
 * shipped defaults and must not be resynced with them: `src/config.ts` ships
 * `maxSessions: 5`, `readConcurrency: 2`, `writeConcurrency: 2`, so a drift here
 * is intended, not a bug.
 *
 * Every test in this file that does not pass an explicit `over` is written
 * against one session and one slot of each kind, so concurrency is the thing
 * under test rather than an ambient condition. Raising these to the shipped
 * values would make queueing tests stop queueing and staleness tests stop
 * evicting — they would go green without exercising anything. Tests that want
 * a larger pool ask for it per-case via `cfg({ maxSessions: n })`.
 *
 * `serialiseSameObjectWrites: false` here is now a DELIBERATE DIVERGENCE from
 * the shipped default, not a mirror of it. Since 2026-08-07 the
 * `AdtSessionPool` constructor (`src/adt/pool.ts`) installs
 * `InProcessObjectGate` — real serialisation — unless this is explicitly
 * `false`, which is what selects `NoopObjectGate`. Baselining it `false` keeps
 * the fixture pool non-serialising BY DEFAULT FOR THIS FILE, so the many
 * unrelated tests below that never mention the gate stay unaffected by it;
 * a test that wants to pin the SHIPPED default's actual behaviour passes
 * `serialiseSameObjectWrites: undefined` explicitly instead of relying on this
 * baseline (see the "ObjectGate" describe block).
 */
const SERIAL_BASELINE: Sizing = {
  maxSessions: 1,
  readConcurrency: 1,
  writeConcurrency: 1,
  sessionIdleMs: 300_000,
  sessionWaitMs: 10_000,
  debugDiaBudget: 2,
  serialiseSameObjectWrites: false,
};

function cfg(over: Partial<Sizing> = {}): Config {
  return { ...SERIAL_BASELINE, ...over } as unknown as Config;
}

interface StubConn {
  readonly n: number;
  breaker: AuthCircuitBreaker;
  shutdowns: string[];
  disposals: number;
  /** Every method the POOL invoked on this connection, in order. */
  touched: string[];
  shutdown(reason: string): Promise<void>;
  dispose(): void;
}

interface Factory {
  create: (c: Config, o: ConnectionOptions) => AbapConnection;
  created: StubConn[];
  optsSeen: ConnectionOptions[];
}

/**
 * @param rogueBreakerFrom from this creation index onwards the stub IGNORES
 *                         `opts.breaker` and mints its own — the exact mistake
 *                         L3 exists to make impossible. An INDEX rather than a
 *                         boolean because slot 0 and slot N are now refused on
 *                         different code paths: slot 0 throws out of the
 *                         constructor (it is built eagerly), slot N out of the
 *                         `withRead` that needed it.
 */
function factory(rogueBreakerFrom?: number): Factory {
  const created: StubConn[] = [];
  const optsSeen: ConnectionOptions[] = [];
  const create = (_c: Config, o: ConnectionOptions): AbapConnection => {
    optsSeen.push(o);
    const rogue = rogueBreakerFrom !== undefined && created.length >= rogueBreakerFrom;
    const stub: StubConn = {
      n: created.length,
      // The `?? new AuthCircuitBreaker()` that used to sit on the right-hand
      // side is gone: `ConnectionOptions.breaker` is required, so an honest
      // factory always has one to pass through. The ROGUE branch stays — it is
      // the only way to make the pool's L3 refusal fire.
      breaker: rogue ? new AuthCircuitBreaker() : o.breaker,
      shutdowns: [],
      disposals: 0,
      touched: [],
      async shutdown(reason: string) {
        this.touched.push(`shutdown(${reason})`);
        this.shutdowns.push(reason);
      },
      dispose() {
        this.touched.push("dispose");
        this.disposals++;
      },
    };
    created.push(stub);
    return stub as unknown as AbapConnection;
  };
  return { create, created, optsSeen };
}

/** Deterministic clock + timer wheel. Nothing here uses real time. */
function clock(start = 1_000_000) {
  let t = start;
  interface Handle {
    at: number;
    fn: () => void;
  }
  const timers: Handle[] = [];
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number): unknown => {
      const h: Handle = { at: t + ms, fn };
      timers.push(h);
      return h;
    },
    clearTimer: (h: unknown): void => {
      const i = timers.indexOf(h as Handle);
      if (i >= 0) timers.splice(i, 1);
    },
    /** How many timers are currently armed. A `setInterval` would show up here. */
    armed: (): number => timers.length,
    advance(ms: number): void {
      t += ms;
      for (const h of [...timers]) {
        if (h.at > t) continue;
        const i = timers.indexOf(h);
        if (i >= 0) timers.splice(i, 1);
        h.fn();
      }
    },
  };
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

/**
 * Drain the microtask queue completely, several times.
 *
 * `setImmediate` yields to the macrotask phase, which cannot run until every
 * pending microtask has. Counting `Promise.resolve()` ticks instead would make
 * these assertions depend on the number of `await`s inside the pool, which is
 * an implementation detail and a source of the worst kind of flake.
 *
 * Nothing here touches the pool's clock: its timers are the injected wheel.
 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r));
};

function makePool(over: Partial<Sizing> = {}, extra: Record<string, unknown> = {}) {
  const f = factory();
  const c = clock();
  // RETURNED, because it is now knowable UP FRONT. The pool used to adopt its
  // shared breaker from whatever the factory handed back first, so a test could
  // only learn the instance by looking at a connection after the fact. It is an
  // argument now, so assertions can name it before slot 0 exists.
  const breaker = new AuthCircuitBreaker();
  const pool = new AdtSessionPool({
    cfg: cfg(over),
    breaker,
    createConnection: f.create,
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    ...extra,
  });
  return { pool, f, c, breaker };
}

const sessionDead = (): AbapError =>
  new AbapError("SESSION_DEAD", "The ABAP session was destroyed by a short dump.");

// The second error shape `isSessionDeadError` recognises — see
// `refuseCsrfRecoveryInStatefulSession` in src/adt/connection.ts and the
// `csrf-stale-in-stateful-session` tests in test/csrf-duplicate-delivery.test.ts,
// which is where this exact `AbapError` shape is actually thrown live.
const csrfStaleInStatefulSession = (): AbapError =>
  new AbapError(
    "ADT_ERROR",
    "The ABAP system rejected a request with a stale CSRF token while a stateful session was in flight.",
    { operation: "request", reason: "csrf-stale-in-stateful-session" },
  );

// ===========================================================================
// 1. The shared circuit breaker (L3)
// ===========================================================================

/**
 * CATCHES: any edit that gives a pooled connection its own `AuthCircuitBreaker`
 * — dropping `connOpts.breaker = this.sharedBreaker`, or a factory that
 * writes `new AbapConnection(cfg, {})`. There is ONE SAP user and ONE
 * `login/fails_to_user_lock` counter; N private breakers means N first failures
 * are permitted against a counter that locks the user at ~5, so the pool would
 * burn the budget N times faster than the server it replaces. Nothing else in
 * the suite would notice: every functional assertion passes with N breakers.
 */
describe("one circuit breaker per process, shared by every slot", () => {
  it("hands EVERY slot, slot 0 included, the SAME breaker instance", async () => {
    const { pool, f, breaker } = makePool({ maxSessions: 3, readConcurrency: 3 });
    const gate = deferred();
    const running = [0, 1, 2].map((i) => pool.withRead(`read-${i}`, async () => gate.promise));
    await settle();
    expect(f.created).toHaveLength(3);

    for (const stub of f.created) expect(stub.breaker).toBe(breaker);
    // Not just "equal breakers" — every CONSTRUCTION was told which one to use.
    // Without this, a factory that happened to reuse a module-level breaker
    // would make the assertion above vacuous.
    //
    // INDEX 0 IS THE POINT OF THIS TEST NOW. It used to assert
    // `toBeUndefined()`, because slot 0 was built before the pool had a breaker
    // and the pool ADOPTED whatever came back. The instance is passed in now,
    // so slot 0 is TOLD, like every other slot.
    expect(f.optsSeen[0]!.breaker).toBe(breaker);
    expect(f.optsSeen[1]!.breaker).toBe(breaker);
    expect(f.optsSeen[2]!.breaker).toBe(breaker);

    gate.resolve();
    await Promise.all(running);
  });

  it("REFUSES a factory that ignores opts.breaker rather than tolerating it", async () => {
    // Rogue from the SECOND connection: slot 0 is honest, so the pool comes into
    // existence, and the refusal has to fire on the lazily-grown slot. (Rogue
    // from slot 0 is now refused too — that is the test below.)
    const f = factory(1);
    const pool = new AdtSessionPool({
      cfg: cfg({ maxSessions: 2, readConcurrency: 2 }),
      breaker: new AuthCircuitBreaker(),
      createConnection: f.create,
    });
    const held = deferred();
    const first = pool.withRead("a", async () => held.promise);
    await settle();

    // The second construction returns a connection carrying a private breaker.
    // The pool must not shrug and use it.
    const e = await pool
      .withRead("b", async () => undefined)
      .then(() => null)
      .catch((err: unknown) => err);
    expect(isAbapError(e)).toBe(true);
    expect((e as AbapError).details.reason).toBe("breaker-not-shared");

    held.resolve();
    await first;
  });

  /**
   * THE LAW CHANGED HERE, AND IT GOT STRONGER.
   *
   * This test used to be "adopts the first connection's breaker rather than
   * constructing one itself", and it asserted `optsSeen[0].breaker` was
   * UNDEFINED. Adoption existed to preserve the D1 fingerprint-latch replay:
   * `AbapConnection`, handed no breaker, called its private `buildBreaker(cfg)`,
   * which returns an ALREADY-LATCHED breaker for credentials that tripped
   * before — at a cost of zero requests. A pool that built a plain
   * `new AuthCircuitBreaker()` would have thrown that away and re-earned the
   * latch with a live failed logon.
   *
   * The price was that slot 0 — the PINNED slot, the one `primary()` hands to
   * every caller working outside a lease — was the single slot L3 could not
   * refuse. Whatever breaker came back from the first construction BECAME the
   * law by definition, so a factory that minted a private breaker for slot 0
   * was not a violation, it was the input.
   *
   * The replay did not have to be paid for with that hole. It moved, intact, to
   * `AuthCircuitBreaker.forConfig(cfg)` — the same function body — and the
   * composition root calls it and passes the result in. So slot 0 is now
   * constructed WITH the shared breaker like everything else, and L3 refuses it
   * on exactly the same terms.
   */
  it("REFUSES a rogue breaker on SLOT 0 — the slot the old adopt-law could not refuse", () => {
    const f = factory(0); // rogue from creation 0, i.e. the pinned slot itself
    const breaker = new AuthCircuitBreaker();
    const build = (): AdtSessionPool =>
      new AdtSessionPool({ cfg: cfg(), breaker, createConnection: f.create });

    // Synchronous, because slot 0 is built eagerly in the constructor: the pool
    // does not come into existence at all if its pinned connection is unguarded.
    const e = (() => {
      try {
        build();
        return null;
      } catch (err: unknown) {
        return err;
      }
    })();

    expect(isAbapError(e)).toBe(true);
    expect((e as AbapError).details.reason).toBe("breaker-not-shared");
    // The construction WAS told which breaker to use. The refusal is about the
    // factory ignoring it, not about the pool having nothing to compare against.
    expect(f.optsSeen[0]!.breaker).toBe(breaker);
  });

  it("tells slot 0 which breaker to use instead of reading it back off slot 0", () => {
    const f = factory();
    const breaker = new AuthCircuitBreaker();
    const pool = new AdtSessionPool({ cfg: cfg(), breaker, createConnection: f.create });
    expect(f.created).toHaveLength(1);
    expect(f.optsSeen[0]!.breaker).toBe(breaker);
    expect(f.created[0]!.breaker).toBe(breaker);
    pool.dispose();
  });

  it("preserves the D1 fingerprint-latch replay through AuthCircuitBreaker.forConfig", () => {
    // The one thing adoption was protecting. `forConfig` is `buildBreaker`'s
    // body, moved: for credentials with no stored trip it returns a clean
    // breaker, and it does so without sending anything.
    const b = AuthCircuitBreaker.forConfig(cfg());
    expect(b.isTripped).toBe(false);
    // A pool built on it is a pool built on the replay path, which is what the
    // old adopt-law bought and what this change keeps.
    const f = factory();
    const pool = new AdtSessionPool({ cfg: cfg(), breaker: b, createConnection: f.create });
    expect(f.created[0]!.breaker).toBe(b);
    pool.dispose();
  });
});

// ===========================================================================
// 2. Slot budget at the shipped defaults
// ===========================================================================

/**
 * CATCHES: a default raised from 1 (in `src/config.ts` or via a local `?? 3`),
 * and a pool that connects per checkout. The latter is the defect
 * `test/pool-characterization.test.ts` hunts from the other side — an extra
 * logon + discovery + role probe at the front of a wire trace — and it is
 * invisible to every behavioural assertion in the repo.
 */
describe("at the shipped defaults the pool constructs exactly one connection", () => {
  it("drives read, gated write, ungated write and a debug lease on ONE connection", async () => {
    const { pool, f } = makePool();
    const seen: AbapConnection[] = [];

    await pool.withRead("abap_read", async (c) => void seen.push(c));
    await pool.withWrite("abap_write", "/sap/bc/adt/oo/classes/zcl_a/source/main", async (c) =>
      void seen.push(c),
    );
    await pool.withWrite("abap_create_package", undefined, async (c) => void seen.push(c));
    const lease = await pool.reserveDebug("abap_debug_attach");
    seen.push(lease.conn);
    lease.release();

    expect(f.created, "one pooled session at maxSessions=1").toHaveLength(1);
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toBe(pool.primary());
    expect(pool.stats()).toEqual({ total: 1, busy: 0, idle: 1, waiting: 0, dead: 0 });
  });

  it("creates the primary eagerly and keeps the reference stable across shutdown", async () => {
    const { pool, f } = makePool();
    const primary = pool.primary();
    expect(f.created).toHaveLength(1);
    await pool.shutdown("test");
    expect(pool.primary()).toBe(primary);
    pool.dispose();
    expect(pool.primary()).toBe(primary);
  });

  it("grows to maxSessions and no further", async () => {
    const { pool, f } = makePool({ maxSessions: 2, readConcurrency: 4 });
    const hold = deferred();
    const running = [0, 1, 2, 3].map((i) => pool.withRead(`r${i}`, async () => hold.promise));
    await settle();
    expect(f.created).toHaveLength(2);
    const s = pool.stats();
    expect(s.total).toBe(2);
    expect(s.busy).toBe(2);
    expect(s.waiting).toBe(2);
    hold.resolve();
    await Promise.all(running);
  });
});

// ===========================================================================
// 3. release() — void, idempotent, and not a lock report (L1)
// ===========================================================================

/**
 * CATCHES: the two classic release bugs.
 *  (a) A release that decrements a counter instead of guarding on a per-lease
 *      flag. A stale double-release then frees a slot a LATER caller owns,
 *      producing two concurrent requests on one ADT session — the precise thing
 *      the whole design exists to prevent, and undetectable from the wire.
 *  (b) A signature that returns whether a lock came off. `unLock` with a
 *      garbage handle answers HTTP 200 on a real system, so such a boolean is
 *      always fabricated. Pinned as a type-level fact via the source text and
 *      as a runtime fact here.
 */
describe("PoolSlot.release() is idempotent and returns void", () => {
  it("returns undefined", async () => {
    const { pool } = makePool();
    const lease = await pool.reserveDebug("attach");
    expect(lease.release()).toBeUndefined();
  });

  it("a stale second release cannot free the slot a later caller now holds", async () => {
    const { pool, c } = makePool();
    const stale = await pool.reserveDebug("attach");
    stale.release();
    expect(pool.stats().busy).toBe(0);

    const held = deferred();
    const running = pool.withRead("later-caller", async () => held.promise);
    await settle();
    expect(pool.stats().busy).toBe(1);

    stale.release(); // the bug: this must be a complete no-op
    stale.release();
    expect(pool.stats(), "a stale release must not hand out a busy slot").toEqual({
      total: 1,
      busy: 1,
      idle: 0,
      waiting: 0,
      dead: 0,
    });

    // And the proof that matters: a second caller still cannot get in. It parks
    // rather than being admitted, and only the wait budget frees it.
    const intruder = pool.withRead("intruder", async () => "admitted");
    await settle();
    expect(pool.stats().waiting).toBe(1);
    c.advance(10_000);
    await expect(intruder).rejects.toBeInstanceOf(SessionBusyError);

    held.resolve();
    await running;
  });

  it("release from a finally runs even when the operation throws", async () => {
    const { pool } = makePool();
    await expect(
      pool.withRead("boom", async () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow("kaboom");
    expect(pool.stats().busy).toBe(0);
    expect(pool.stats().idle).toBe(1);
  });
});

// ===========================================================================
// 4. No health probes, no per-lease reconnect (L2)
// ===========================================================================

/**
 * CATCHES: someone adding a liveness check on checkout ("is this session still
 * ours?"). That request head-of-line blocks behind an outstanding long poll for
 * its full remaining duration — ~55 s measured against a 60 s listener, ~115 s
 * against a 120 s one. A probe would make the pool's own bookkeeping the
 * slowest thing in the process. Also catches re-running `prepareConnection`
 * (i.e. `connect()`) per checkout, which is one extra logon per operation.
 */
describe("a slot is healthy until a request fails — never probed", () => {
  it("touches the connection ONLY through the caller's fn", async () => {
    const { pool, f } = makePool();
    await pool.withRead("r1", async () => undefined);
    await pool.withRead("r2", async () => undefined);
    await pool.withWrite("w1", "/sap/bc/adt/programs/programs/zx", async () => undefined);
    const lease = await pool.reserveDebug("d1");
    lease.release();
    expect(
      f.created[0]!.touched,
      "the pool must issue nothing of its own on a pooled session",
    ).toEqual([]);
  });

  it("prepares a session at most once, however many times it is leased", async () => {
    const f = factory();
    const prepared: number[] = [];
    const pool = new AdtSessionPool({
      cfg: cfg(),
      breaker: new AuthCircuitBreaker(),
      createConnection: f.create,
      prepareConnection: async (c) => {
        prepared.push((c as unknown as StubConn).n);
      },
    });
    for (let i = 0; i < 5; i++) await pool.withRead(`r${i}`, async () => undefined);
    expect(prepared).toEqual([0]);
  });
});

// ===========================================================================
// 5. Death is learned from a failure, never assumed
// ===========================================================================

/**
 * CATCHES: retiring a slot on ANY error. Every failed request would then cost a
 * fresh connection — i.e. a fresh logon — and a run of ordinary ADT_ERRORs
 * would spend the `fails_to_user_lock` budget for no reason. Also catches the
 * opposite: keeping a session the server has already destroyed, which returns
 * `400 Session Timed Out` for everything afterwards.
 */
describe("slot retirement", () => {
  it("retires a slot whose request threw SESSION_DEAD, and replaces it", async () => {
    const { pool, f } = makePool();
    const dead = f.created[0]!;
    // Reads get ONE bounded replay on a fresh slot before a
    // SESSION_DEAD is finally surfaced — see `runOnAttempt`. This `fn`
    // throws unconditionally, so the pool cannot tell it apart from "the
    // slot I was just handed was already a corpse" (L2 forbids probing to
    // find out), and correctly spends its one replay attempt: a SECOND slot
    // is built, also dies, and ONLY THEN does the caller see SESSION_DEAD.
    await expect(
      pool.withRead("r", async () => {
        throw sessionDead();
      }),
    ).rejects.toMatchObject({ code: "SESSION_DEAD" });

    expect(pool.stats().total, "both corpses are dropped, not kept").toBe(0);
    expect(f.created, "one original slot plus one bounded replay").toHaveLength(2);
    expect(dead.disposals).toBe(1);
    expect(f.created[1]!.disposals, "the replay's slot is retired too").toBe(1);
    expect(dead.shutdowns, "a dead session must not be asked to drop itself").toEqual([]);
    expect(f.created[1]!.shutdowns).toEqual([]);

    await pool.withRead("r2", async () => undefined);
    expect(f.created).toHaveLength(3);
    // The REPLACEMENT still shares the one breaker. A replacement path that
    // forgot this would re-open the N-breakers hole from a different direction.
    expect(f.created[2]!.breaker).toBe(dead.breaker);
  });

  it("replays a read exactly ONCE on a fresh slot when the caller inherits a corpse, and returns the caller's real result", async () => {
    // The shape this guards against: the SLOT died from an EARLIER, unrelated
    // operation (modelled here as already dead when handed out), and THIS
    // caller's read is innocent — it should get its answer, not an error
    // that blames it for something it did not do.
    const { pool, f } = makePool();
    let calls = 0;
    const result = await pool.withRead("victim", async (conn) => {
      calls++;
      if (calls === 1) throw sessionDead();
      return conn;
    });
    expect(calls, "exactly one retry, on top of the original attempt").toBe(2);
    expect(f.created, "the corpse plus one fresh slot").toHaveLength(2);
    expect(result, "the caller gets the SECOND attempt's real return value").toBe(
      f.created[1] as unknown as typeof result,
    );
    expect(f.created[0]!.disposals, "the corpse is retired").toBe(1);
    expect(pool.stats()).toMatchObject({ total: 1, idle: 1, dead: 0 });
  });

  it("does NOT replay a write whose SESSION_DEAD arrives too slowly to be dead-on-arrival", async () => {
    // Conservative half of the idempotency rule: a WRITE that took long
    // enough to plausibly have reached the server must not be blindly
    // replayed — see DEAD_ON_ARRIVAL_MS and `eligibleForDeadSlotReplay`.
    const { pool, f, c } = makePool();
    let calls = 0;
    await expect(
      pool.withWrite("mutate", undefined, async () => {
        calls++;
        c.advance(2000); // well past DEAD_ON_ARRIVAL_MS — real work, not a fast rejection
        throw sessionDead();
      }),
    ).rejects.toMatchObject({ code: "SESSION_DEAD" });
    expect(calls, "no replay — the slow failure is surfaced as-is").toBe(1);
    expect(f.created).toHaveLength(1);
  });

  it("DOES replay a write whose SESSION_DEAD arrives dead-on-arrival (implausibly fast)", async () => {
    const { pool, f, c } = makePool();
    let calls = 0;
    const result = await pool.withWrite("mutate", undefined, async (conn) => {
      calls++;
      if (calls === 1) {
        c.advance(50); // far under DEAD_ON_ARRIVAL_MS — the ICM rejected it before dispatch
        throw sessionDead();
      }
      return conn;
    });
    expect(calls).toBe(2);
    expect(f.created).toHaveLength(2);
    expect(result).toBe(f.created[1] as unknown as typeof result);
  });

  it("retires a slot and replays a write on ADT_ERROR/csrf-stale-in-stateful-session, dead-on-arrival", async () => {
    // The connection.ts D3 refusal names its own recovery: "Retry the whole
    // operation. It starts a fresh session and re-takes the lock, which is
    // safe" (see `refuseCsrfRecoveryInStatefulSession`). This is that retry,
    // exercised through the same dead-on-arrival gate as SESSION_DEAD.
    const { pool, f, c } = makePool();
    let calls = 0;
    const result = await pool.withWrite("mutate", undefined, async (conn) => {
      calls++;
      if (calls === 1) {
        c.advance(50); // far under DEAD_ON_ARRIVAL_MS
        throw csrfStaleInStatefulSession();
      }
      return conn;
    });
    expect(calls).toBe(2);
    expect(f.created).toHaveLength(2);
    expect(result).toBe(f.created[1] as unknown as typeof result);
    expect(f.created[0]!.disposals, "the corpse is retired").toBe(1);
  });

  it("does NOT replay a write whose csrf-stale-in-stateful-session arrives too slowly to be dead-on-arrival", async () => {
    const { pool, f, c } = makePool();
    let calls = 0;
    await expect(
      pool.withWrite("mutate", undefined, async () => {
        calls++;
        c.advance(2000); // well past DEAD_ON_ARRIVAL_MS
        throw csrfStaleInStatefulSession();
      }),
    ).rejects.toMatchObject({ code: "ADT_ERROR", details: { reason: "csrf-stale-in-stateful-session" } });
    expect(calls, "no replay — the slow failure is surfaced as-is").toBe(1);
    expect(f.created).toHaveLength(1);
  });

  it("does NOT retire a slot for an ordinary ADT error or an auth failure", async () => {
    const { pool, f } = makePool();
    for (const err of [
      new AbapError("ADT_ERROR", "syntax error"),
      new AbapError("ADT_ERROR", "stale token", { reason: "some-other-reason" }),
      new AbapError("AUTH_FAILED", "bad password"),
      new AbapError("LOCKED", "somebody else is editing"),
      new Error("socket hang up"),
    ]) {
      await expect(
        pool.withRead("r", async () => {
          throw err;
        }),
      ).rejects.toBe(err);
    }
    expect(f.created, "one failed request is not one dead session").toHaveLength(1);
    expect(pool.stats()).toEqual({ total: 1, busy: 0, idle: 1, waiting: 0, dead: 0 });
  });

  it("retires a slot whose preparation rejects and surfaces the cause", async () => {
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
        c.advance(6_000); // exhausts the budget on the first attempt
        throw new Error("logon refused");
      },
    });
    const e = await pool
      .withRead("r", async () => undefined)
      .then(() => null)
      .catch((err: unknown) => err);
    expect(e).toBeInstanceOf(SessionBusyError);
    expect((e as SessionBusyError).reason).toBe("wait-timeout");
    expect(
      (e as SessionBusyError).message,
      "an operator needs the underlying failure, not just 'busy'",
    ).toContain("logon refused");
    expect(pool.stats().total, "the unpreparable slot is dropped").toBe(0);
  });

  /**
   * CATCHES: moving `const deadline = now() + sessionWaitMs` INSIDE the retry
   * loop. Each dead-on-arrival session would then buy a fresh full wait budget,
   * so "bounded wait" becomes unbounded — with a fresh logon per turn against
   * the shared `fails_to_user_lock` counter. The single-failure test above does
   * not catch it, because that path never reaches a second iteration.
   */
  it("keeps ONE absolute wait budget across dead-on-arrival retries", async () => {
    const f = factory();
    const c = clock();
    let attempts = 0;
    const pool = new AdtSessionPool({
      cfg: cfg({ sessionWaitMs: 5_000 }),
      breaker: new AuthCircuitBreaker(),
      createConnection: (conf, o) => {
        // A reset budget never terminates. The cap converts that hang into a
        // fast, legible failure instead of a 30 s runner timeout.
        if (f.created.length >= 6) throw new Error("connection cap exceeded");
        return f.create(conf, o);
      },
      now: c.now,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
      prepareConnection: async () => {
        attempts++;
        c.advance(2_000); // less than the budget, so the loop retries
        throw new Error("connect failed");
      },
    });
    const e = await pool
      .withRead("r", async () => undefined)
      .then(() => null)
      .catch((err: unknown) => err);
    expect(e).toBeInstanceOf(SessionBusyError);
    expect((e as SessionBusyError).reason).toBe("wait-timeout");
    expect(attempts, "tries at T, T+2000, T+4000; T+6000 is past the T+5000 deadline").toBe(3);
  });
});

// ===========================================================================
// 6. ObjectGate
// ===========================================================================

/**
 * CATCHES: an inline `Map` in `withWrite` (no seam for the later cross-process
 * `withFileLock` implementation), and — the sharper one — a second
 * canonicaliser. `/…/zcl_x/source/main` and `/…/zcl_x` are ONE object to SAP's
 * enqueue table and to `StatefulSession`'s lock ledger. A gate that keyed on
 * the raw URI would let two writes to the same object run concurrently while
 * believing they were unrelated.
 */
describe("ObjectGate", () => {
  it("serialises the source URI and the object URI as ONE object", async () => {
    // `serialiseSameObjectWrites: true` is pinned DELIBERATELY, not inherited
    // from either the schema default or this FILE's `SERIAL_BASELINE` (which
    // pins `false`, a deliberate divergence — see its doc comment). Explicit
    // `true` keeps this test covering the serialisation path regardless of
    // where either default drifts to next, rather than depending on this
    // file's local baseline to happen to agree with it.
    const { pool } = makePool({
      maxSessions: 2,
      writeConcurrency: 2,
      serialiseSameObjectWrites: true,
    });
    const order: string[] = [];
    const first = deferred();

    const a = pool.withWrite("w", "/sap/bc/adt/oo/classes/zcl_x/source/main", async () => {
      order.push("a-start");
      await first.promise;
      order.push("a-end");
    });
    await settle();
    const b = pool.withWrite("w", "/sap/bc/adt/oo/classes/zcl_x", async () => {
      order.push("b-start");
    });
    await settle();

    expect(order, "b must not have started while a holds the object").toEqual(["a-start"]);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  /**
   * CATCHES: `false` being ignored — a constructor that keeps minting an
   * `InProcessObjectGate` even when the flag explicitly says not to. This is
   * no longer the case that pins the SHIPPED default (see the test right
   * after this one for that) — it pins the explicit-opt-out behaviour that
   * `SERIAL_BASELINE.serialiseSameObjectWrites: false` exercises throughout
   * this file.
   *
   * The sizing is load-bearing: `maxSessions: 2, writeConcurrency: 2` gives two
   * write slots, so the slot queue itself cannot serialise these two writes and
   * mask the gate. At the 1/1/1 baseline the second write would park on the
   * SLOT no matter what the gate does, and the assertion below would be
   * vacuous.
   */
  it("does NOT serialise two writes to the same object when explicitly opted out (false)", async () => {
    const { pool } = makePool({ maxSessions: 2, writeConcurrency: 2, serialiseSameObjectWrites: false });
    const order: string[] = [];
    const uri = "/sap/bc/adt/oo/classes/zcl_x/source/main";
    const hold = deferred();

    const a = pool.withWrite("w", uri, async () => {
      order.push("a-start");
      await hold.promise;
      order.push("a-end");
    });
    await settle();
    expect(order, "a is in flight and parked on the deferred").toEqual(["a-start"]);

    const b = pool.withWrite("w", uri, async () => {
      order.push("b-start");
    });
    await settle();

    // The whole point: b entered WHILE a is still in flight.
    expect(order, "b must enter while a still holds the object").toEqual(["a-start", "b-start"]);

    hold.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "b-start", "a-end"]);
  });

  /**
   * CATCHES: the constructor's default flipping back to a pass-through — a
   * regression this test exists to prevent. `cfg()` here
   * passes `serialiseSameObjectWrites: undefined` EXPLICITLY (overriding
   * `SERIAL_BASELINE`'s `false` via the object spread in `cfg()`), so this is
   * the one case in the file that actually exercises what an operator gets by
   * setting nothing: `AdtSessionPool`'s constructor must read that as
   * "install `InProcessObjectGate`", not "install `NoopObjectGate`". Every
   * other test in this block pins its own value explicitly and therefore
   * cannot catch the constructor's OWN default silently reverting.
   *
   * Same load-bearing sizing as the sibling test above, for the same reason.
   */
  it("serialises two writes to the same object BY DEFAULT (serialiseSameObjectWrites unset)", async () => {
    const { pool } = makePool({
      maxSessions: 2,
      writeConcurrency: 2,
      serialiseSameObjectWrites: undefined,
    });
    const order: string[] = [];
    const uri = "/sap/bc/adt/oo/classes/zcl_x/source/main";
    const hold = deferred();

    const a = pool.withWrite("w", uri, async () => {
      order.push("a-start");
      await hold.promise;
      order.push("a-end");
    });
    await settle();
    const b = pool.withWrite("w", uri, async () => {
      order.push("b-start");
    });
    await settle();

    // Two free write slots, so anything holding b back is the gate and only
    // the gate — and with the flag unset, the gate must still be the
    // serialising one.
    expect(order, "b must wait on the object, not on a slot").toEqual(["a-start"]);

    hold.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  /**
   * CATCHES: the mirror of the two cases above — a constructor that hard-wires
   * `InProcessObjectGate` and drops `cfg.serialiseSameObjectWrites` on the
   * floor, so an explicit `true` (redundant with the default, but a caller may
   * still set it) keeps working exactly like the default does.
   */
  it("serialises two writes to the same object when serialiseSameObjectWrites is set", async () => {
    const { pool } = makePool({
      maxSessions: 2,
      writeConcurrency: 2,
      serialiseSameObjectWrites: true,
    });
    const order: string[] = [];
    const uri = "/sap/bc/adt/oo/classes/zcl_x/source/main";
    const hold = deferred();

    const a = pool.withWrite("w", uri, async () => {
      order.push("a-start");
      await hold.promise;
      order.push("a-end");
    });
    await settle();
    const b = pool.withWrite("w", uri, async () => {
      order.push("b-start");
    });
    await settle();

    // Two free write slots, so anything holding b back is the gate and only
    // the gate.
    expect(order, "b must wait on the object, not on a slot").toEqual(["a-start"]);

    hold.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  it("also folds query strings, fragments and trailing slashes onto the same key", async () => {
    const gate = new InProcessObjectGate();
    const order: string[] = [];
    const hold = deferred();
    const a = gate.run("/sap/bc/adt/oo/classes/zcl_x/source/main?version=active", async () => {
      order.push("a");
      await hold.promise;
    });
    const b = gate.run("/sap/bc/adt/oo/classes/zcl_x/#frag", async () => void order.push("b"));
    const c = gate.run("/sap/bc/adt/oo/classes/zcl_x", async () => void order.push("c"));
    await settle();
    expect(order).toEqual(["a"]);
    hold.resolve();
    await Promise.all([a, b, c]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("does NOT serialise different objects", async () => {
    const { pool } = makePool({ maxSessions: 2, writeConcurrency: 2 });
    const started: string[] = [];
    const hold = deferred();
    const a = pool.withWrite("w", "/sap/bc/adt/oo/classes/zcl_a", async () => {
      started.push("a");
      await hold.promise;
    });
    const b = pool.withWrite("w", "/sap/bc/adt/oo/classes/zcl_b", async () => {
      started.push("b");
      await hold.promise;
    });
    await settle();
    expect(started.sort()).toEqual(["a", "b"]);
    hold.resolve();
    await Promise.all([a, b]);
  });

  it("a failing write does not wedge the object's chain, and the map does not leak", async () => {
    const gate = new InProcessObjectGate();
    await expect(
      gate.run("/sap/bc/adt/oo/classes/zcl_x", async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");
    await expect(gate.run("/sap/bc/adt/oo/classes/zcl_x", async () => "ok")).resolves.toBe("ok");
    await settle();
    expect(gate.pending, "an idle gate must hold no keys").toBe(0);
  });

  it("is a SEAM: an injected gate receives the canonical key and wraps the slot", async () => {
    // Proves the later `withFileLock` implementation can be dropped in without
    // touching `withWrite`, AND that canonicalisation happens in the pool — so
    // a cross-process implementation cannot key differently by omission.
    const keys: string[] = [];
    const marks: string[] = [];
    const spy: ObjectGate = {
      async run(objectUri, fn) {
        keys.push(objectUri);
        marks.push("gate-enter");
        try {
          return await fn();
        } finally {
          marks.push("gate-exit");
        }
      },
    };
    const f = factory();
    const pool = new AdtSessionPool({
      cfg: cfg(),
      breaker: new AuthCircuitBreaker(),
      createConnection: f.create,
      gate: spy,
    });
    await pool.withWrite("w", "/sap/bc/adt/oo/classes/zcl_x/source/main?v=1", async () => {
      marks.push("work");
    });
    expect(keys).toEqual(["/sap/bc/adt/oo/classes/zcl_x"]);
    expect(marks).toEqual(["gate-enter", "work", "gate-exit"]);
  });

  it("skips the gate entirely when the write names no object", async () => {
    const keys: string[] = [];
    const spy: ObjectGate = {
      async run(objectUri, fn) {
        keys.push(objectUri);
        return fn();
      },
    };
    const f = factory();
    const pool = new AdtSessionPool({
      cfg: cfg(),
      breaker: new AuthCircuitBreaker(),
      createConnection: f.create,
      gate: spy,
    });
    await pool.withWrite("create-package", undefined, async () => undefined);
    expect(keys).toEqual([]);
  });
});

/**
 * CATCHES: the gate/slot ordering inversion — `runOn(..., conn => gate.run(...))`
 * instead of `gate.run(..., () => runOn(...))`. It looks equivalent and every
 * write still completes, which is why it needs a test aimed straight at it.
 *
 * The difference is who holds the scarce thing. Sessions are budgeted
 * (`maxSessions`, default 1); object gates are free and local. Inverted, a write
 * that is merely QUEUED behind another write to the same object sits on a
 * session while doing nothing with it, and every unrelated read is refused or
 * timed out for the duration of a wait it has no stake in. Correct order: the
 * gate is entered first, and the session is grabbed last and given back first.
 *
 * The observable, asserted below: an unrelated read overtakes a gate-blocked
 * write. Under the inversion the read is stuck behind it in the slot queue.
 */
describe("the gate is taken OUTSIDE the slot", () => {
  it("a write waiting on the object gate does not hold a session hostage", async () => {
    // `serialiseSameObjectWrites: true` is pinned DELIBERATELY, not inherited
    // from either the schema default (which now also serialises) or this
    // FILE's `SERIAL_BASELINE` (which pins
    // `false`, a deliberate divergence). The observable this test is aimed at
    // — an unrelated read overtaking a gate-blocked write — needs a write that
    // is genuinely parked on the object and not on the session; pinning `true`
    // explicitly keeps this test covering the serialisation path regardless of
    // where either default drifts to next.
    const { pool } = makePool({ serialiseSameObjectWrites: true }); // maxSessions: 1
    const order: string[] = [];
    const uri = "/sap/bc/adt/oo/classes/zcl_x/source/main";
    const hold = deferred();

    const w1 = pool.withWrite("w1", uri, async () => {
      order.push("w1-start");
      await hold.promise;
      order.push("w1-end");
    });
    await settle();
    // w2 is blocked on the OBJECT, not on the session.
    const w2 = pool.withWrite("w2", uri, async () => void order.push("w2"));
    await settle();
    // The read is blocked on the session, and it is next in line for it.
    const r = pool.withRead("read", async () => void order.push("read"));
    await settle();
    expect(order).toEqual(["w1-start"]);

    hold.resolve();
    await Promise.all([w1, w2, r]);
    expect(
      order,
      "the read must not queue behind a write that is only waiting for a lock",
    ).toEqual(["w1-start", "w1-end", "read", "w2"]);
    expect(pool.stats().busy).toBe(0);
  });

  it("two concurrent writes to the same object still both complete at maxSessions = 1", async () => {
    const { pool } = makePool();
    const order: string[] = [];
    const uri = "/sap/bc/adt/oo/classes/zcl_x/source/main";
    const both = Promise.all([
      pool.withWrite("w1", uri, async () => void order.push("w1")),
      pool.withWrite("w2", uri, async () => void order.push("w2")),
    ]);
    await expect(both).resolves.toBeDefined();
    expect(order).toEqual(["w1", "w2"]);
    expect(pool.stats().busy).toBe(0);
  });
});

// ===========================================================================
// 7. Bounded, FIFO acquisition
// ===========================================================================

/**
 * CATCHES: unbounded queueing (an MCP client blocked with no upper bound is
 * indistinguishable from a hung server), LIFO/barging handoff (a save parked
 * behind an endless stream of reads), and a wait that never expires.
 */
describe("acquisition is FIFO and bounded", () => {
  it("refuses with queue-full once maxQueue waiters are parked", async () => {
    const { pool, c } = makePool({}, { maxQueue: 1 });
    const hold = deferred();
    const a = pool.withRead("a", async () => hold.promise);
    await settle();
    const b = pool.withRead("b", async () => undefined);
    await settle();

    const e = await pool
      .withRead("c", async () => undefined)
      .then(() => null)
      .catch((err: unknown) => err);
    expect(e).toBeInstanceOf(SessionBusyError);
    expect((e as SessionBusyError).reason).toBe("queue-full");
    expect((e as SessionBusyError).code).toBe("SESSION_BUSY");
    expect((e as SessionBusyError).holder).toBe("a");

    expect(pool.stats().waiting).toBe(1);
    hold.resolve();
    await Promise.all([a, b]);
    expect(c.armed(), "every waiter timer is cleared on settle").toBe(0);
  });

  it("serves parked callers strictly first-in-first-out", async () => {
    const { pool } = makePool();
    const order: string[] = [];
    const gates = [deferred(), deferred(), deferred()];
    const run = (name: string, g: Deferred<void>): Promise<void> =>
      pool.withRead(name, async () => {
        order.push(name);
        await g.promise;
      });

    const a = run("a", gates[0]!);
    await settle();
    const b = run("b", gates[1]!);
    const c2 = run("c", gates[2]!);
    await settle();
    expect(order).toEqual(["a"]);

    gates[0]!.resolve();
    await settle();
    expect(order, "the head of the queue goes next, not the newest arrival").toEqual(["a", "b"]);
    gates[1]!.resolve();
    await settle();
    expect(order).toEqual(["a", "b", "c"]);
    gates[2]!.resolve();
    await Promise.all([a, b, c2]);
  });

  it("times a parked caller out after sessionWaitMs and no later", async () => {
    const { pool, c } = makePool({ sessionWaitMs: 10_000 });
    const hold = deferred();
    const a = pool.withRead("holder", async () => hold.promise);
    await settle();

    const parked = pool.withRead("parked", async () => undefined);
    await settle();
    expect(pool.stats().waiting).toBe(1);

    c.advance(9_999);
    await settle();
    expect(pool.stats().waiting, "must not give up early").toBe(1);

    c.advance(1);
    const e = await parked.then(() => null).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(SessionBusyError);
    expect((e as SessionBusyError).reason).toBe("wait-timeout");
    expect(pool.stats().waiting).toBe(0);

    hold.resolve();
    await a;
  });

  it("arms no timer at all when nothing parks", async () => {
    // The negative control for "do not add a setInterval for idle eviction".
    // At N=1 the primary is pinned, so such a timer would have nothing to do
    // while being one more thing that can keep the process (or vitest) alive.
    const { pool, c } = makePool();
    expect(c.armed()).toBe(0);
    await pool.withRead("r", async () => undefined);
    await pool.withWrite("w", "/sap/bc/adt/oo/classes/zcl_x", async () => undefined);
    const lease = await pool.reserveDebug("d");
    lease.release();
    expect(c.armed(), "the pool must arm timers only for parked waiters").toBe(0);
  });
});

// ===========================================================================
// 8. The debug lease never queues, and nothing queues behind it
// ===========================================================================

/**
 * CATCHES: removing either fail-fast. Both failures look like success in a
 * green suite and both are multi-minute hangs in production: a caller parked
 * behind `debugger/listeners` waits for the listener's full remaining timeout
 * (~55 s at timeout=60, ~115 s at timeout=120, measured 3/3), and a debug
 * reservation parked behind anything is the same hang one level down.
 *
 * The test asserts this WITHOUT advancing the clock — the injected wheel means
 * a parked caller could never settle, so a rejection arriving at all is proof
 * the pool refused rather than queued.
 */
describe("debug reservations", () => {
  it("caps concurrent debug leases at one, and the cap does not scale with the DIA budget", async () => {
    expect(DEBUG_CONCURRENCY, "the constant, as a tripwire on a silent edit").toBe(1);

    // This test used to be the line above and NOTHING ELSE, under this same
    // title. It therefore survived a mutant that redefined the debug role limit
    // as `floor(debugDiaBudget / DIA_COST_PER_DEBUG_SESSION)` — at the shipped
    // budget of 2 that expression is also 1, so every other test in the file
    // agreed with the mutant too, and the one test named after the cap could
    // not tell them apart. A budget of 8 is four debug sessions' worth of DIA
    // work processes and four spare slots to put them in. The answer must still
    // be one, because the cap is a statement about the DEBUGGER (one ADT debug
    // session per user, and the ABAP debugger is not re-entrant), not about how
    // many work processes happen to be free.
    const { pool } = makePool({
      maxSessions: 4,
      readConcurrency: 4,
      debugDiaBudget: 8,
      sessionWaitMs: 600_000,
    });
    const first = await pool.reserveDebug("listen-1");
    const e = await pool
      .reserveDebug("listen-2")
      .then(() => null)
      .catch((err: unknown) => err);
    expect(e).toBeInstanceOf(SessionBusyError);
    expect((e as SessionBusyError).reason).toBe("lease-held");
    expect(pool.stats().waiting, "and it is refused outright, never parked").toBe(0);
    expect(pool.stats().busy, "the refused reservation took no slot of its own").toBe(1);
    first.release();
  });

  it("a second debug reservation fails fast instead of queueing", async () => {
    const { pool } = makePool({ maxSessions: 2, readConcurrency: 2, sessionWaitMs: 600_000 });
    const first = await pool.reserveDebug("listen-1");
    const e = await pool
      .reserveDebug("listen-2")
      .then(() => null)
      .catch((err: unknown) => err);
    expect(e).toBeInstanceOf(SessionBusyError);
    expect((e as SessionBusyError).reason).toBe("lease-held");
    expect(pool.stats().waiting).toBe(0);
    first.release();
  });

  it("a read does not park behind a long poll — it is refused immediately", async () => {
    const { pool } = makePool({ sessionWaitMs: 600_000 });
    const lease = await pool.reserveDebug("debugger/listeners");
    const e = await pool
      .withRead("abap_read", async () => undefined)
      .then(() => null)
      .catch((err: unknown) => err);
    expect(e).toBeInstanceOf(SessionBusyError);
    expect((e as SessionBusyError).reason).toBe("lease-held");
    expect((e as SessionBusyError).holderKind).toBe("lease");
    expect((e as SessionBusyError).holder).toBe("debugger/listeners");
    expect(pool.stats().waiting, "nobody may be parked behind a long poll").toBe(0);
    lease.release();
  });

  it("but an ordinary busy slot DOES admit queueing", async () => {
    // The converse, so the fail-fast above is proven to be about the LEASE and
    // not simply "the pool never queues".
    const { pool } = makePool({ sessionWaitMs: 600_000 });
    const hold = deferred();
    const a = pool.withRead("holder", async () => hold.promise);
    await settle();
    const parked = pool.withRead("parked", async () => "done");
    await settle();
    expect(pool.stats().waiting).toBe(1);
    hold.resolve();
    await expect(parked).resolves.toBe("done");
    await a;
  });

  it("releasing the lease re-admits ordinary callers", async () => {
    const { pool } = makePool();
    const lease = await pool.reserveDebug("listen");
    lease.release();
    await expect(pool.withRead("r", async () => "ok")).resolves.toBe("ok");
  });

  // -------------------------------------------------------------------------
  // DIA budget floor check (M1, M2, M3, M5) and the constant it reads.
  // -------------------------------------------------------------------------

  it("DIA_COST_PER_DEBUG_SESSION is 2 — a silent change to the constant must be visible", () => {
    expect(DIA_COST_PER_DEBUG_SESSION).toBe(2);
  });

  it("M1: deleting the DIA floor check — budget 0 refuses BEFORE taking a slot, and withRead still works after", async () => {
    const { pool } = makePool({ debugDiaBudget: 0 });
    const e = await pool
      .reserveDebug("d")
      .then(() => null)
      .catch((err: unknown) => err);
    expect(e).toBeInstanceOf(AbapError);
    expect((e as AbapError).code).toBe("UNSUPPORTED");
    expect((e as AbapError).details.reason).toBe("dia-budget");

    // Not merely "rejected" — rejected WITHOUT ever touching the slot table.
    // A mutant that deletes the floor check would call acquire() first and
    // this would show busy: 1, not busy: 0.
    expect(pool.stats().busy).toBe(0);
    expect(pool.stats().waiting).toBe(0);

    // The refusal must not have consumed or poisoned anything: an ordinary
    // caller behind it must still be served normally.
    await expect(pool.withRead("r", async () => "ok")).resolves.toBe("ok");
  });

  it("M2: a weakened floor check (< 1) still lets budget 1 through — budget 1 must refuse, budget 2 must succeed", async () => {
    const refused = makePool({ debugDiaBudget: 1 });
    const e = await refused.pool
      .reserveDebug("d")
      .then(() => null)
      .catch((err: unknown) => err);
    expect(e).toBeInstanceOf(AbapError);
    expect((e as AbapError).code).toBe("UNSUPPORTED");
    expect((e as AbapError).details.reason).toBe("dia-budget");
    expect(refused.pool.stats().busy).toBe(0);

    // The converse, so this test cannot pass against a mutant that refuses
    // everything regardless of budget.
    const admitted = makePool({ debugDiaBudget: 2 });
    const lease = await admitted.pool.reserveDebug("d");
    expect(lease).toBeDefined();
    lease.release();
  });

  it(
    "anti-parallel-debugging: raising debugDiaBudget to 8 must NEVER hand out a second " +
      "concurrent debug lease — floor(8/2)=4 under the mutant, but roleLimit(\"debug\") must " +
      "stay DEBUG_CONCURRENCY=1. Parallel debugging is CLOSED, " +
      "not merely unmeasured; a budget knob must never widen debug concurrency.",
    async () => {
      const { pool, c } = makePool({ debugDiaBudget: 8 });
      expect(DEBUG_CONCURRENCY).toBe(1);

      // NOTE: this fixture inherits SERIAL_BASELINE.maxSessions = 1, so the second
      // reserveDebug() below is refused by park() — which rejects "debug"
      // unconditionally, before ever consulting roleLimit() — NOT because
      // roleLimit("debug") held at 1. Under the `floor(budget/cost)` mutant
      // this test still passes for the WRONG reason: with only one slot ever
      // permitted, tryTake() can't create a second one regardless of what
      // roleLimit("debug") returns. This case alone does not pin roleLimit();
      // see the hardened test immediately below, which raises maxSessions so
      // slot capacity cannot be the thing doing the refusing.
      const first = await pool.reserveDebug("listen-1");
      const e = await pool
        .reserveDebug("listen-2")
        .then(() => null)
        .catch((err: unknown) => err);

      // Asserted WITHOUT advancing the injected clock: a rejection arriving
      // at all — with no timer ever fired — proves refusal rather than a
      // queue that happened to drain.
      expect(e).toBeInstanceOf(SessionBusyError);
      expect((e as SessionBusyError).reason).toBe("lease-held");
      expect(pool.stats().waiting).toBe(0);
      expect(c.armed()).toBe(0);

      first.release();
    },
  );

  it(
    "anti-parallel-debugging, hardened: with slot capacity NOT the limiter (maxSessions: 4), raising " +
      "debugDiaBudget to 8 must still NEVER widen debug concurrency — " +
      "roleLimit(\"debug\") must stay pinned to DEBUG_CONCURRENCY = 1, not " +
      "floor(debugDiaBudget / DIA_COST_PER_DEBUG_SESSION) = 4. Parallel " +
      "debugging is CLOSED, not merely " +
      "unmeasured. Unlike the test above, maxSessions here is large enough " +
      "that tryTake() COULD create a second live slot if roleLimit(\"debug\") " +
      "were wrongly raised — so a rejection here can only come from " +
      "roleLimit(\"debug\") itself, not from slot-capacity exhaustion.",
    async () => {
      const { pool, c } = makePool({ debugDiaBudget: 8, maxSessions: 4 });
      expect(DEBUG_CONCURRENCY).toBe(1);

      const first = await pool.reserveDebug("listen-1");
      const e = await pool
        .reserveDebug("listen-2")
        .then(() => null)
        .catch((err: unknown) => err);

      // Asserted WITHOUT advancing the injected clock: a rejection arriving
      // at all — with no timer ever fired — proves refusal rather than a
      // queue that happened to drain.
      expect(e).toBeInstanceOf(SessionBusyError);
      expect((e as SessionBusyError).reason).toBe("lease-held");
      expect(pool.stats().waiting).toBe(0);
      expect(c.armed()).toBe(0);

      // The decisive check: under the mutant, roleLimit("debug") returns
      // floor(8/2) = 4, so tryTake() — finding maxSessions: 4 headroom and no
      // idle slot — creates a SECOND live debug slot instead of refusing.
      // busy would read 2, not 1. Pinning busy === 1 here is what the M3 test
      // above cannot do, because with maxSessions: 1 no second slot could ever
      // exist regardless of roleLimit("debug")'s return value.
      expect(pool.stats().busy).toBe(1);

      first.release();
    },
  );

  it("M5: budget exhaustion throws synchronously instead of queueing — no clock advance, no timer armed", async () => {
    const { pool, c } = makePool({ debugDiaBudget: 0 });
    const e = await pool
      .reserveDebug("d")
      .then(() => null)
      .catch((err: unknown) => err);
    expect(e).toBeInstanceOf(AbapError);
    expect((e as AbapError).details.reason).toBe("dia-budget");
    // A queueing implementation would park the caller and need the clock
    // advanced to settle; this rejection arrives with the wheel untouched.
    expect(c.armed()).toBe(0);
    expect(pool.stats().waiting).toBe(0);
  });

  it("a successful reserveDebug at the shipped budget releases cleanly and re-admits ordinary callers", async () => {
    const { pool } = makePool({ debugDiaBudget: 2 });
    const lease = await pool.reserveDebug("d");
    expect(pool.stats().busy).toBe(1);
    lease.release();
    expect(pool.stats().busy).toBe(0);
    // Guards against the floor check leaking a slot on the success path.
    await expect(pool.withRead("r", async () => "ok")).resolves.toBe("ok");
  });
});

// ===========================================================================
// 9. Idle eviction at release time only
// ===========================================================================

/**
 * CATCHES: evicting the PINNED primary. Recycling it costs a logon + discovery
 * + the T000 role probe, which is exactly the extra traffic the golden
 * baseline tests are recorded to detect, and this change must produce no
 * observable behaviour difference. Also catches an eviction sweep that never
 * runs (unbounded growth of stale sessions as maxSessions is raised).
 */
describe("idle eviction", () => {
  it("drops a non-pinned slot idle past sessionIdleMs, on release", async () => {
    const { pool, f, c } = makePool({
      maxSessions: 2,
      readConcurrency: 2,
      sessionIdleMs: 1_000,
    });
    const hold = deferred();
    const both = Promise.all([
      pool.withRead("a", async () => hold.promise),
      pool.withRead("b", async () => hold.promise),
    ]);
    await settle();
    expect(pool.stats().total).toBe(2);
    hold.resolve();
    await both;
    expect(pool.stats()).toMatchObject({ total: 2, idle: 2 });

    c.advance(5_000);
    // The sweep runs at release time — nothing else is allowed to arm a timer.
    await pool.withRead("c", async () => undefined);

    expect(pool.stats().total, "the stale second slot is gone").toBe(1);
    expect(f.created, "and no replacement was built for it").toHaveLength(2);
    const evicted = f.created[1]!;
    expect(evicted.disposals).toBe(1);
    expect(evicted.shutdowns, "a live-but-stale session is dropped politely").toEqual([
      "pool-evict",
    ]);
  });

  it("never evicts the pinned primary, however long it has been idle", async () => {
    const { pool, f, c } = makePool({ sessionIdleMs: 1_000 });
    await pool.withRead("a", async () => undefined);
    c.advance(60 * 60_000);
    await pool.withRead("b", async () => undefined);
    expect(pool.stats().total).toBe(1);
    expect(f.created, "recycling the primary would cost a logon + discovery + probe").toHaveLength(
      1,
    );
    expect(f.created[0]!.shutdowns).toEqual([]);
  });

  it("spares the primary even when it is the STALEST slot at sweep time", async () => {
    // The sweep only runs on release, so the slot just used is always fresh —
    // which means the test above passes even with the `pinned` guard deleted.
    // This one arranges for slot 1 to be the warmest and the primary to be long
    // past `sessionIdleMs` when slot 1 is released, so the guard is the only
    // thing standing between the primary and the chopping block.
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

    holdA.resolve(); // primary released first...
    await a;
    c.advance(100);
    holdB.resolve(); // ...so slot 1 is strictly the warmer of the two.
    await b;

    c.advance(5_000); // both now idle well past sessionIdleMs
    await pool.withRead("c", async () => undefined); // takes the warmer slot 1

    // ONE, not two: the checkout-time sweep (`tryTake` calls `evictStaleIdle`
    // before the warmest-first scan) retires the stale NON-pinned slot 1 on the
    // way in, so "c" lands on the primary. What this test exists to catch is
    // unchanged and is asserted on the next three lines — slot 0 was the
    // stalest slot in the pool and the `pinned` guard is the only reason it was
    // not the one retired.
    expect(pool.stats().total, "the primary survives its own staleness").toBe(1);
    expect(f.created[0]!.shutdowns).toEqual([]);
    expect(f.created[0]!.disposals).toBe(0);
    expect(pool.primary()).toBe(f.created[0] as unknown as AbapConnection);
  });
});

// ===========================================================================
// 10. stats(), shutdown() and dispose()
// ===========================================================================

describe("bookkeeping and lifecycle", () => {
  it("keeps total === busy + idle + dead in every state", async () => {
    const { pool } = makePool({ maxSessions: 2, readConcurrency: 2 });
    const check = (): void => {
      const s = pool.stats();
      expect(s.total).toBe(s.busy + s.idle + s.dead);
    };
    check();
    const hold = deferred();
    const running = Promise.all([
      pool.withRead("a", async () => hold.promise),
      pool.withRead("b", async () => hold.promise),
    ]);
    await settle();
    check();
    hold.resolve();
    await running;
    check();
  });

  /**
   * CATCHES: a shutdown that leaves parked callers hanging. A queued waiter
   * whose promise is never settled keeps the MCP request open past process
   * exit; the operator sees a client that never returns.
   */
  it("shutdown drains parked waiters and drops every session once", async () => {
    const { pool, f } = makePool({ maxSessions: 2, readConcurrency: 2 });
    const hold = deferred();
    const running = Promise.all([
      pool.withRead("a", async () => hold.promise),
      pool.withRead("b", async () => hold.promise),
    ]);
    await settle();
    const parked = pool.withRead("parked", async () => undefined);
    await settle();
    expect(pool.stats().waiting).toBe(1);

    const drained = parked.then(() => null).catch((e: unknown) => e);
    await pool.shutdown("SIGTERM");
    const e = await drained;
    expect(isAbapError(e)).toBe(true);
    expect((e as AbapError).code).toBe("NOT_CONNECTED");
    for (const stub of f.created) expect(stub.shutdowns).toEqual(["SIGTERM"]);

    hold.resolve();
    await running;
  });

  it("refuses new work after shutdown", async () => {
    const { pool } = makePool();
    await pool.shutdown("bye");
    await expect(pool.withRead("r", async () => undefined)).rejects.toMatchObject({
      code: "NOT_CONNECTED",
    });
    await expect(pool.reserveDebug("d")).rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });

  it("dispose is synchronous, idempotent and never throws", async () => {
    const f = factory();
    const pool: SessionPool = createSessionPool({
      cfg: cfg(),
      breaker: new AuthCircuitBreaker(),
      createConnection: f.create,
    });
    pool.dispose();
    pool.dispose();
    // Idempotent means the SECOND call is a no-op, not a second teardown: the
    // slot list is emptied by the first, so nothing is disposed twice.
    expect(f.created[0]!.disposals).toBe(1);
    expect(pool.stats()).toEqual({ total: 0, busy: 0, idle: 0, waiting: 0, dead: 0 });
  });

  it("a shutdown that throws does not stop the remaining slots being dropped", async () => {
    const f = factory();
    const pool = new AdtSessionPool({
      cfg: cfg({ maxSessions: 2, readConcurrency: 2 }),
      breaker: new AuthCircuitBreaker(),
      createConnection: f.create,
    });
    const hold = deferred();
    const running = Promise.all([
      pool.withRead("a", async () => hold.promise),
      pool.withRead("b", async () => hold.promise),
    ]);
    await settle();
    expect(f.created).toHaveLength(2);
    f.created[0]!.shutdown = async () => {
      throw new Error("dropSession failed");
    };

    await expect(pool.shutdown("SIGINT")).resolves.toBeUndefined();
    expect(f.created[1]!.shutdowns, "slot 1 must still be asked").toEqual(["SIGINT"]);

    hold.resolve();
    await running;
  });
});

// ===========================================================================
// 11. Structural tripwires on the module source
// ===========================================================================

/**
 * CATCHES: the four edits that are correct-looking, pass every behavioural test
 * above, and are each a documented live-capture violation:
 *   - a second copy of the object-URI canonicaliser,
 *   - a pool-side lock registry mirroring `StatefulSession`'s ledger,
 *   - persistence (a `pool.json` in the state dir),
 *   - a `setInterval` for idle eviction.
 * Behaviour cannot detect any of them; source text can.
 *
 * The "persists nothing" tripwire below was later narrowed: it was
 * written before `ObjectGate`'s own doc comment's "later phase" (a
 * `withFileLock`-backed cross-process gate) existed, and that phase became
 * `FileLockObjectGate`, which necessarily imports `../state-dir.js` and calls
 * `withFileLock(`.
 *
 * That sanctioned exception has since MOVED OUT of this file: the gate
 * implementations now live in `src/adt/object-gate.ts`. So the exception is
 * withdrawn here and re-asserted there — `pool.ts` is back to a single
 * `resolveStateDir` import (it still picks the default lock directory in the
 * constructor), and the `withFileLock` reach is pinned by
 * `structural invariants of src/adt/object-gate.ts` below. Splitting it this
 * way is deliberately stricter than relaxing the original regex would have
 * been: neither file may now acquire the other's persistence surface.
 *
 * Everything else the original tripwire was aimed at (a `pool.json` cache, a
 * second lock ledger, a raw `writeFile`/`readFile`/`mkdir` outside of what
 * `withFileLock` itself does inside `state-dir.ts`) is still forbidden, in
 * both files.
 */
describe("structural invariants of src/adt/pool.ts", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/adt/pool.ts", import.meta.url)), "utf8");
  /** Comment-only lines stripped, as the http-guard canary does. */
  const code = src
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");

  it("imports objectUriOf rather than growing a second canonicaliser", () => {
    expect(code).toMatch(/import\s*{[^}]*\bobjectUriOf\b[^}]*}\s*from\s*"\.\/session\.js"/);
    // No local re-implementation: the three replaces that make up objectUriOf.
    expect(code).not.toContain("/source/main$");
    expect(code).not.toMatch(/replace\(\s*\/\[\?#\]/);
  });

  it("reuses SessionBusyError and its reason vocabulary, not a parallel one", () => {
    expect(code).toMatch(/import\s*{[^}]*\bSessionBusyError\b[^}]*}\s*from\s*"\.\/session-lock\.js"/);
    expect(code).not.toMatch(/class\s+\w*Busy\w*Error/);
    for (const reason of ["lease-held", "queue-full", "wait-timeout"]) {
      expect(code).toContain(`"${reason}"`);
    }
  });

  it("keeps no lock registry of its own", () => {
    expect(code).not.toContain("LockInfo");
    expect(code).not.toMatch(/\block(s)?\s*=\s*new Map/i);
    expect(code).not.toMatch(/\bunLock\b|\block\(uri/);
  });

  it("persists nothing at all now that the gates have moved out", () => {
    // Still forbidden outright: raw `node:fs`, and the journal (a pool must
    // never reach into `../journal.js` — that dependency runs the other way).
    expect(code).not.toMatch(/from\s+"(node:fs|node:fs\/promises|\.\.\/journal\.js)"/);
    // The ONE remaining reach into `../state-dir.js` is `resolveStateDir`, for
    // the constructor's default lock directory. `withFileLock` left with
    // `FileLockObjectGate`; pool.ts must not re-acquire it, nor anything
    // broader like `atomicWriteFileSync` that would open a persistence path.
    expect(code).toMatch(/import\s*{\s*resolveStateDir\s*}\s*from\s*"\.\.\/state-dir\.js"/);
    expect(code).not.toMatch(
      /atomicWriteFileSync|hardenFileModeSync|withFileLockSync|\bwithFileLock\b/,
    );
    // Still no raw fs verbs and no ad-hoc persisted file of the pool's own.
    expect(code).not.toMatch(/\bwriteFile\b|\breadFile\b|\bmkdir\b/);
    expect(code).not.toContain("pool.json");
  });

  it("arms no interval", () => {
    expect(code).not.toContain("setInterval");
  });

  it("opens no socket — it must not become a third egress sink", () => {
    expect(code).not.toMatch(/from\s+"node:(http|https|net|tls)"/);
    expect(code).not.toMatch(/from\s+"axios"|new AxiosHttpClient/);
  });

  it("declares release() as void and names no override-flavoured option", () => {
    expect(src).toMatch(/release\(\)\s*:\s*void/);
    expect(src).not.toMatch(/release\(\)\s*:\s*boolean/);
    for (const banned of ["ignoreLocks", "skipChecks", "ignoreATC"]) {
      expect(code).not.toContain(banned);
    }
    expect(code, "no `force` option name").not.toMatch(/\bforce\s*[?:]/);
  });
});

/**
 * The other half of the tripwire above. `FileLockObjectGate` moved here from
 * `pool.ts`, and with it the single sanctioned `withFileLock` reach it
 * introduced. Re-pinned at its new address so the exception stays
 * bounded to one function in one file rather than becoming ambient permission
 * for a new module to persist whatever it likes.
 *
 * `objectGateLockPath` is the only thing here that names a path, and the
 * `describe("ObjectGate", …)` block above pins its shape behaviourally.
 */
describe("structural invariants of src/adt/object-gate.ts", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/adt/object-gate.ts", import.meta.url)),
    "utf8",
  );
  const code = src
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");

  it("reaches into state-dir.ts for the lock and its error shape, and nothing else", () => {
    const reach = code.match(/import\s*{([^}]*)}\s*from\s*"\.\.\/state-dir\.js"/);
    expect(reach, "object-gate.ts must still reach state-dir.ts by a named import").not.toBeNull();
    const named = (reach?.[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .sort();
    // Pinned as an exact set, not a substring match, so a new name cannot be
    // slipped in beside `withFileLock`. `withFileLock` is the lock itself; the
    // other two only READ the error it throws ("is this failure mine?", "who
    // holds it?") so this file can render OBJECT_LOCKED_CROSS_PROCESS without
    // re-deriving state-dir's private error shape — the alternative was the
    // private copy of that discriminator this file used to carry, which drifts
    // silently the moment state-dir changes it.
    expect(named).toEqual(["fileLockHolderOf", "isFileLockAcquisitionFailure", "withFileLock"]);
    // None of the three writes anything; these are what would.
    expect(code).not.toMatch(
      /atomicWriteFileSync|hardenFileModeSync|withFileLockSync|resolveStateDir/,
    );
  });

  it("persists nothing of its own beyond the lock file withFileLock manages", () => {
    // Same three forbidden classes as pool.ts: raw fs, the journal (dependency
    // runs the other way), and an ad-hoc cache file.
    expect(code).not.toMatch(/from\s+"(node:fs|node:fs\/promises|\.\.\/journal\.js)"/);
    expect(code).not.toMatch(/\bwriteFile\b|\breadFile\b|\bmkdir\b/);
    expect(code).not.toContain(".json");
  });

  it("imports objectUriOf rather than growing a second canonicaliser", () => {
    // The gate keys on object URIs; a private normaliser here would silently
    // disagree with the pool's and un-serialise writes to the same object.
    expect(code).toMatch(/import\s*{[^}]*\bobjectUriOf\b[^}]*}\s*from\s*"\.\/session\.js"/);
    expect(code).not.toContain("/source/main$");
    expect(code).not.toMatch(/replace\(\s*\/\[\?#\]/);
  });

  it("opens no socket", () => {
    expect(code).not.toMatch(/from\s+"node:(http|https|net|tls)"/);
    expect(code).not.toMatch(/from\s+"axios"|new AxiosHttpClient/);
  });
});
