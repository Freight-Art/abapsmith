/**
 * Shared doubles for the `pool-*.test.ts` suites.
 *
 * ENTIRELY OFFLINE, and deliberately so: nothing here constructs an
 * `AbapConnection`, parses a `Config` or opens a socket, which is what keeps
 * these files out of the connection-building population that
 * `test/system-role-probe-guard.test.ts` polices.
 *
 * The stub connection mirrors the THREE members of `AbapConnection`'s death
 * API that `src/adt/pool.ts` now depends on — `isDead`, `markDead()`,
 * `onDead()` — with the same contracts the real class documents:
 *
 *   - `markDead` is IDEMPOTENT and the FIRST reason wins;
 *   - listeners are copied before iteration, so a listener may unsubscribe
 *     itself from inside the notification;
 *   - a listener that throws is swallowed, because a broken observer must not
 *     turn "the session died" into "the process threw from somewhere else";
 *   - `onDead` returns an unsubscribe that is safe to call more than once.
 *
 * A hand-written mirror can drift from the class it mirrors, so
 * `pool-lifecycle.test.ts` carries a drift guard that asserts the real
 * `AbapConnection.prototype` still declares exactly these members with these
 * kinds. That check reads the prototype; it never instantiates it.
 */
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import type { AbapConnection, ConnectionOptions } from "../src/adt/connection.js";
import type { Config } from "../src/config.js";

/** The seven fields the pool reads. Everything else is irrelevant to it. */
export interface Sizing {
  maxSessions: number;
  readConcurrency: number;
  writeConcurrency: number;
  sessionIdleMs: number;
  sessionWaitMs: number;
  debugDiaBudget: number;
  serialiseSameObjectWrites: boolean;
}

/**
 * A deliberately pinned FULLY-SERIAL baseline (1/1/1) for the pool suites —
 * NOT the shipped defaults. Several landed, green pool suites depend on this
 * exact serial sizing, so the values must never move with `src/config.ts`.
 *
 * As of 2026-08-06 the actual shipped defaults in `src/config.ts` are
 * `maxSessions: 5`, `readConcurrency: 2`, `writeConcurrency: 2` — already
 * diverged from the 1/1/1 below. Tests that need the shipped sizing must set
 * it explicitly (`cfg({ maxSessions: 5, readConcurrency: 2, writeConcurrency: 2 })`
 * or equivalent); do not assume this constant tracks `src/config.ts`.
 *
 * The identifier `SHIPPED` is now a slight misnomer, kept as-is because
 * renaming it would ripple through every file that imports it.
 *
 * `serialiseSameObjectWrites: false` is now a DELIBERATE DIVERGENCE from the
 * shipped default, not a mirror of it. Since 2026-08-07
 * `src/adt/pool.ts`'s `AdtSessionPool` constructor installs
 * `InProcessObjectGate` (real serialisation) unless `cfg.serialiseSameObjectWrites`
 * is explicitly `false`, which is what this baseline sets — chosen so a
 * fixture pool built from `SHIPPED` serialises nothing UNLESS a test opts in,
 * keeping the many callers of this double that never mention the gate
 * unaffected by the 2026-08-07 default flip. A test that specifically wants
 * the SHIPPED default's own behaviour should override this field explicitly
 * (`cfg({ serialiseSameObjectWrites: undefined })`) rather than rely on
 * `SHIPPED` to represent it.
 */
export const SHIPPED: Sizing = {
  maxSessions: 1,
  readConcurrency: 1,
  writeConcurrency: 1,
  sessionIdleMs: 300_000,
  sessionWaitMs: 10_000,
  debugDiaBudget: 2,
  serialiseSameObjectWrites: false,
};

export function cfg(over: Partial<Sizing> = {}): Config {
  return { ...SHIPPED, ...over } as unknown as Config;
}

export interface StubDeathRecord {
  reason: string;
  atMs: number;
  heldLockUris: string[];
}

export interface StubConn {
  readonly n: number;
  breaker: AuthCircuitBreaker;
  shutdowns: string[];
  disposals: number;
  /** Every method the POOL invoked on this connection, in order. */
  touched: string[];
  shutdown(reason: string): Promise<void>;
  dispose(): void;
  readonly isDead: boolean;
  markDead(reason: string): void;
  onDead(fn: (r: StubDeathRecord) => void): () => void;
  /** Listeners still attached. A pool that never unsubscribes shows up here. */
  listenerCount(): number;
  /**
   * The enqueues this session is holding. Stands in for the ledger
   * `StatefulSession` owns — tests push/splice it directly, exactly as a real
   * `lock()`/`unLock()` pair would. The pool may only READ it.
   */
  locks: string[];
  heldLockUris(): string[];
}

export interface Factory {
  create: (c: Config, o: ConnectionOptions) => AbapConnection;
  created: StubConn[];
  optsSeen: ConnectionOptions[];
}

export interface FactoryOptions {
  /**
   * From this creation index onwards, ignore `ConnectionOptions.breaker` and
   * hand back a connection carrying its own. This is the factory L3 exists to
   * refuse, and the only way to make `createSlot()` throw.
   */
  rogueBreakerFrom?: number;
}

export function factory(opts: FactoryOptions = {}): Factory {
  const created: StubConn[] = [];
  const optsSeen: ConnectionOptions[] = [];
  const create = (_c: Config, o: ConnectionOptions): AbapConnection => {
    const rogue =
      opts.rogueBreakerFrom !== undefined && created.length >= opts.rogueBreakerFrom;
    let death: StubDeathRecord | undefined;
    const listeners: ((r: StubDeathRecord) => void)[] = [];
    const stub: StubConn = {
      n: created.length,
      breaker: rogue ? new AuthCircuitBreaker() : o.breaker,
      shutdowns: [],
      disposals: 0,
      touched: [],
      locks: [],
      heldLockUris() {
        this.touched.push("heldLockUris");
        return [...this.locks];
      },
      async shutdown(reason: string) {
        this.touched.push(`shutdown(${reason})`);
        this.shutdowns.push(reason);
      },
      dispose() {
        this.touched.push("dispose");
        this.disposals++;
      },
      get isDead() {
        return death !== undefined;
      },
      markDead(reason: string) {
        if (death) return; // idempotent, first reason wins
        death = { reason, atMs: 0, heldLockUris: [] };
        for (const fn of [...listeners]) {
          try {
            fn(death);
          } catch {
            /* a broken observer must not break the death notification */
          }
        }
      },
      onDead(fn: (r: StubDeathRecord) => void) {
        listeners.push(fn);
        let done = false;
        return () => {
          if (done) return;
          done = true;
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      listenerCount: () => listeners.length,
    };
    created.push(stub);
    optsSeen.push(o);
    return stub as unknown as AbapConnection;
  };
  return { create, created, optsSeen };
}

/** Deterministic clock + timer wheel. Nothing here uses real time. */
export function clock(start = 1_000_000) {
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

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export function deferred<T = void>(): Deferred<T> {
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
 */
export const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r));
};
