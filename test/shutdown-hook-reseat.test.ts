/**
 * P2-3 — the entry point's debug cleanup must survive a primary RE-SEAT.
 *
 * ## The defect
 *
 * `src/index.ts` used to register the Ctrl-C cleanup once, at startup, as
 * `server.connection.onShutdown(...)`. `server.connection` is a live getter
 * over `pool.primary()`, and the pool re-points the primary onto a DIFFERENT
 * `AbapConnection` object when the seated one is retired. The retired object
 * is then `dispose()`d by `dropSlot`, which unregisters ITS subscription to
 * the shared shutdown hook (`src/shutdown-hook.ts`) — so the cleanup parked in
 * its `shutdownTasks` is unreachable from any later signal. Ctrl-C after a
 * re-seat runs no `shutdownAllDebugSessions()`, and a suspended debuggee is
 * left holding one of the appliance's dialog work processes.
 *
 * `armDebugShutdown` (src/index.ts) replaces the startup registration with a
 * synchronous shared-hook subscriber that arms the cleanup onto whichever
 * connection is primary AT SIGNAL TIME. See its doc comment for why a plain
 * second hook subscriber is not an option: `AbapConnection` owns
 * `process.exit` and the hook has no completion barrier.
 *
 * ## Offline by construction
 *
 * A real `AdtSessionPool` drives a real re-seat, but every connection is the
 * local `FakeConn` below — no `AbapConnection`, no `Config` parse, no socket,
 * no real timer (the pool's clock is injected). Signals are synthetic
 * `process.emit(...)`, which only invokes listeners; and `FakeConn`
 * deliberately has NO `process.exit`, unlike the class it mirrors, so nothing
 * here can kill the vitest worker. The hook is reset before every test so no
 * subscriber from an earlier file can be reached by the emit either.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import type { AbapConnection, ConnectionOptions } from "../src/adt/connection.js";
import { AdtSessionPool } from "../src/adt/pool.js";
import type { Config } from "../src/config.js";
import { armDebugShutdown } from "../src/index.js";
import {
  __resetShutdownHookForTests,
  __setShutdownHookBudgetMsForTests,
  __setShutdownHookLogForTests,
  registerShutdownHandler,
} from "../src/shutdown-hook.js";
import { cfg, clock, settle, type Sizing } from "./pool-doubles.js";

/**
 * The slice of `AbapConnection` this defect lives in, mirrored faithfully:
 *
 *   - it subscribes ONE callback to the shared hook from `connect()`, NOT from
 *     its constructor — `installShutdownHooks()` runs after a successful logon
 *     in the real class, which is precisely what leaves registration order
 *     free for `src/index.ts` to claim subscriber #0 before `server.start()`;
 *   - `dispose()` unregisters that subscription — the step that orphans a
 *     retired connection's shutdown tasks;
 *   - `shutdown()` drains `shutdownTasks` sequentially, which is the only
 *     ordering guarantee this codebase has against exit;
 *   - a second signal during shutdown force-exits instead of re-running
 *     cleanup (the real double-Ctrl-C escape hatch — recorded here, never
 *     acted on).
 */
class FakeConn {
  readonly breaker: AuthCircuitBreaker;
  readonly signals: string[] = [];
  shutdowns: string[] = [];
  disposals = 0;
  private dead = false;
  private shuttingDown = false;
  private readonly deathListeners: Array<(r: unknown) => void> = [];
  private readonly shutdownTasks: Array<() => Promise<void> | void> = [];
  private unregisterHook: (() => void) | undefined;

  constructor(
    readonly n: number,
    opts: ConnectionOptions,
  ) {
    // The pool refuses any connection that does not share its breaker (L3).
    this.breaker = (opts.breaker as AuthCircuitBreaker | undefined) ?? new AuthCircuitBreaker();
  }

  /** Stands for logon + `installShutdownHooks()`. Idempotent, as the real one is. */
  connect(): this {
    // A retired connection is never logged back on by the pool.
    if (this.unregisterHook || this.disposals > 0) return this;
    this.unregisterHook = registerShutdownHandler(`FakeConn(${this.n})`, (signal) => {
      this.signals.push(signal);
      if (this.shuttingDown) {
        this.signals.push("force-exit");
        return;
      }
      this.shuttingDown = true;
      void this.shutdown(signal);
    });
    return this;
  }

  get isDead(): boolean {
    return this.dead;
  }

  markDead(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    for (const fn of this.deathListeners.slice()) fn({ reason, atMs: 0, heldLockUris: [] });
  }

  onDead(fn: (r: unknown) => void): () => void {
    this.deathListeners.push(fn);
    return () => {
      const i = this.deathListeners.indexOf(fn);
      if (i >= 0) this.deathListeners.splice(i, 1);
    };
  }

  heldLockUris(): string[] {
    return [];
  }

  onShutdown(fn: () => Promise<void> | void): void {
    this.shutdownTasks.push(fn);
  }

  offShutdown(fn: () => Promise<void> | void): void {
    const i = this.shutdownTasks.indexOf(fn);
    if (i >= 0) this.shutdownTasks.splice(i, 1);
  }

  async shutdown(reason = "shutdown"): Promise<void> {
    this.shutdowns.push(reason);
    const tasks = this.shutdownTasks.splice(0, this.shutdownTasks.length);
    for (const t of tasks) await t();
  }

  dispose(): void {
    this.disposals += 1;
    if (this.unregisterHook) {
      this.unregisterHook();
      this.unregisterHook = undefined;
    }
  }
}

function makePool(over: Partial<Sizing> = {}) {
  const created: FakeConn[] = [];
  const c = clock();
  const pool = new AdtSessionPool({
    cfg: cfg(over) as Config,
    breaker: new AuthCircuitBreaker(),
    createConnection: (_c, o) => {
      const conn = new FakeConn(created.length, o);
      created.push(conn);
      return conn as unknown as AbapConnection;
    },
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
  });
  // Exactly what `createServer` returns for `connection`: a getter, never a
  // captured object (src/server.ts).
  const server = {
    get connection(): AbapConnection {
      return pool.primary();
    },
  };
  /** Stands for `server.start()` / the pool's owner logging a new slot on. */
  const connectAll = () => {
    for (const conn of created) conn.connect();
  };
  return { pool, created, server, c, connectAll };
}

beforeEach(() => {
  // No subscriber from an earlier suite may be reachable when we emit a
  // signal — a stray real `AbapConnection` would call the real `process.exit`.
  __resetShutdownHookForTests();
});

afterEach(() => {
  __resetShutdownHookForTests();
  __setShutdownHookBudgetMsForTests(undefined);
  __setShutdownHookLogForTests(undefined);
});

describe("index.ts shutdown cleanup — survives a primary re-seat", () => {
  it("still runs the debug cleanup on SIGINT after the pool re-seats the primary", async () => {
    const { pool, created, server, connectAll } = makePool();
    const runs: string[] = [];
    // Registered before anything logs on, exactly as `main()` does it.
    armDebugShutdown(server, async () => {
      runs.push("cleanup");
    });
    connectAll();

    const before = pool.primary();
    expect(before, "the pool seats slot 0 eagerly").toBe(created[0] as unknown as AbapConnection);

    // The re-seat: slot 0 dies, `dropSlot` retires and DISPOSES it (which
    // unregisters its shared-hook subscription), `primary()` seats a new one.
    created[0]!.markDead("session expired after ~30 min idle");
    const after = pool.primary();
    expect(after, "a re-seat really happened").not.toBe(before);
    expect(created, "onto a freshly minted connection").toHaveLength(2);
    expect(created[0]!.disposals, "and the corpse was disposed").toBe(1);
    connectAll();

    process.emit("SIGINT");
    await settle();

    expect(
      runs,
      "the entry point's debug cleanup must still run on Ctrl-C after a re-seat — " +
        "otherwise a suspended debuggee is stranded on a dialog work process",
    ).toEqual(["cleanup"]);
    expect(created[1]!.shutdowns, "it ran as a task of the CURRENT primary").toEqual(["SIGINT"]);
    expect(created[0]!.shutdowns, "the retired connection was never asked to shut down").toEqual(
      [],
    );
  });

  it("runs the cleanup on SIGINT when no re-seat ever happens", async () => {
    const { pool, created, server, connectAll } = makePool();
    const runs: string[] = [];
    armDebugShutdown(server, async () => {
      runs.push("cleanup");
    });
    connectAll();

    expect(pool.primary()).toBe(created[0] as unknown as AbapConnection);

    process.emit("SIGINT");
    await settle();

    expect(runs).toEqual(["cleanup"]);
    expect(created, "and nothing was minted to do it").toHaveLength(1);
  });

  it("does not arm the cleanup during normal operation, so a pool evict cannot fire it", async () => {
    // A retired-but-LIVE slot gets `conn.shutdown("pool-evict")` from
    // `dropSlot`. Under the old startup registration that drained the entry
    // point's cleanup — and with it `server.mcp.close()` — mid-life.
    const { pool, created, server } = makePool({ maxSessions: 2, readConcurrency: 2 });
    const runs: string[] = [];
    armDebugShutdown(server, async () => {
      runs.push("cleanup");
    });

    pool.primary();
    await created[0]!.shutdown("pool-evict");

    expect(runs, "nothing is attached until a signal arrives").toEqual([]);
  });

  it("is idempotent across a second signal (no double cleanup)", async () => {
    const { pool, created, server, connectAll } = makePool();
    const runs: string[] = [];
    armDebugShutdown(server, async () => {
      runs.push("cleanup");
    });
    connectAll();
    pool.primary();

    process.emit("SIGINT");
    await settle();
    process.emit("SIGINT");
    await settle();

    expect(runs, "re-arming the same connection must not queue the cleanup twice").toEqual([
      "cleanup",
    ]);
    expect(created[0]!.signals).toEqual(["SIGINT", "SIGINT", "force-exit"]);
  });
});
