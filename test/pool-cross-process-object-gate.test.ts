/**
 * `FileLockObjectGate` (src/adt/pool.ts), the cross-process
 * half of `ObjectGate`.
 *
 * UNLIKE test/pool.test.ts, this file is deliberately NOT offline: the whole
 * point of `FileLockObjectGate` is a real `withFileLock` (src/state-dir.ts)
 * over a real directory, so a double would prove nothing about the one
 * property that matters — that two independent `FileLockObjectGate` instances
 * (standing in for two separate abapsmith processes) sharing one state dir
 * actually contend on disk. Every test below uses a real `fs.mkdtempSync`
 * state dir, cleaned up in `afterEach`.
 *
 * `waitMs` is passed explicitly and short (200-300 ms) everywhere a lock is
 * meant to be contended, so a failing test times out in well under a second
 * rather than at `ABAP_OBJECT_LOCK_WAIT_MS`'s 1500 ms default.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as os from "node:os";
import { dirname, join } from "node:path";

import { loadConfig, type Config } from "../src/config.js";
import type { AbapConnection, ConnectionOptions } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import {
  AdtSessionPool,
  FileLockObjectGate,
  InProcessObjectGate,
  objectGateLockPath,
  type ObjectGate,
  type SessionPoolOptions,
} from "../src/adt/pool.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
function mkStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "abapsmith-object-gate-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

/** Real fs I/O, so `settle()`'s microtask-draining trick does not apply — poll instead. */
async function waitUntil(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * A pid that is certainly not running here, for the stale-lock-recovery test.
 * Probed upward over a bounded range so a machine with every one of them
 * occupied skips the test rather than hanging or asserting against a live
 * process. Mirrors test/journal-concurrency.test.ts's `findDeadPid`.
 */
function findDeadPid(): number | undefined {
  for (let p = 30_000; p < 40_000; p++) {
    try {
      process.kill(p, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return p;
    }
  }
  return undefined;
}
const DEAD_PID = findDeadPid();

// ---------------------------------------------------------------------------
// a. Cross-process contention
// ---------------------------------------------------------------------------

describe("cross-process contention", () => {
  it("rejects a concurrent second gate instance with OBJECT_LOCKED_CROSS_PROCESS", async () => {
    const stateDir = mkStateDir();
    const uri = "/sap/bc/adt/oo/classes/zcl_x/source/main";
    // Two instances, standing in for two separate abapsmith PROCESSES sharing
    // one state dir — the exact scenario a single shared instance cannot
    // exercise, since InProcessObjectGate would already serialise that case.
    const gateA = new FileLockObjectGate({ stateDir, waitMs: 300 });
    const gateB = new FileLockObjectGate({ stateDir, waitMs: 300 });

    const hold = deferred<void>();
    const a = gateA.run(uri, async () => {
      await hold.promise;
      return "a-done";
    });

    await waitUntil(
      () => existsSync(objectGateLockPath(stateDir, uri)),
      "gateA to actually create the lock file",
    );

    const err: unknown = await gateB.run(uri, async () => "b-done").catch((e: unknown) => e);
    expect(isAbapError(err)).toBe(true);
    const abapErr = err as AbapError;
    expect(abapErr.code).toBe("OBJECT_LOCKED_CROSS_PROCESS");
    // The message names the CANONICAL object URI (`objectUriOf`), which
    // strips the `/source/main` suffix — not the raw uri passed to `run()`.
    expect(abapErr.message).toContain("/sap/bc/adt/oo/classes/zcl_x");
    // Same process for both gate instances in this test, so the holder IS
    // this pid/hostname — proves the holder record round-trips through the
    // error, not just that SOME error was thrown.
    const holder = abapErr.details.holder as { pid: number; hostname: string } | undefined;
    expect(holder?.pid).toBe(process.pid);
    expect(holder?.hostname).toBe(os.hostname());

    hold.resolve();
    await expect(a).resolves.toBe("a-done");
  });

  it("does not block distinct objectUris against each other", async () => {
    const stateDir = mkStateDir();
    const gateA = new FileLockObjectGate({ stateDir, waitMs: 300 });
    const gateB = new FileLockObjectGate({ stateDir, waitMs: 300 });
    const order: string[] = [];
    const holdA = deferred<void>();

    const a = gateA.run("/sap/bc/adt/oo/classes/zcl_a", async () => {
      order.push("a-start");
      await holdA.promise;
      order.push("a-end");
    });
    await waitUntil(() => order.includes("a-start"), "gateA's write to start");

    // A different objectUri AND a different gate instance (a different
    // "process"): must complete WHILE a is still in flight, not queue behind
    // it. If FileLockObjectGate hashed the state dir instead of the object
    // URI, or shared one lock path for everything, this would deadlock until
    // the 300 ms timeout instead.
    const b = gateB.run("/sap/bc/adt/oo/classes/zcl_b", async () => {
      order.push("b-start");
      order.push("b-end");
      return "b-done";
    });
    await expect(b).resolves.toBe("b-done");
    expect(order).toEqual(["a-start", "b-start", "b-end"]);

    holdA.resolve();
    await a;
    expect(order).toEqual(["a-start", "b-start", "b-end", "a-end"]);
  });
});

// ---------------------------------------------------------------------------
// b. Stale-lock recovery
// ---------------------------------------------------------------------------

describe("stale-lock recovery", () => {
  it.skipIf(DEAD_PID === undefined)(
    "recovers a lock left by a dead pid on this host once it ages past 2*waitMs",
    async () => {
      const stateDir = mkStateDir();
      const uri = "/sap/bc/adt/oo/classes/zcl_stale";
      const waitMs = 100;
      const lockPath = objectGateLockPath(stateDir, uri);
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: DEAD_PID,
          hostname: os.hostname(),
          startedAt: new Date(Date.now() - 10_000).toISOString(),
        }),
        "utf8",
      );
      // Aged past `2 * waitMs` (state-dir.ts's `breakIfStale`) so the liveness
      // check is consulted at all, but nowhere near the 60 s hard-stale valve
      // — what breaks this lock must be the dead-pid test, nothing else.
      const aged = new Date(Date.now() - (2 * waitMs + 500));
      utimesSync(lockPath, aged, aged);

      const gate = new FileLockObjectGate({ stateDir, waitMs });
      await expect(gate.run(uri, async () => "recovered")).resolves.toBe("recovered");
    },
  );

  /**
   * The other side of the same valve, and the defect this test guards
   * against: a lock whose holder is ALIVE must not be broken just because it has
   * been held a while.
   *
   * `withFileLock`'s default hard-stale window is `max(10 × waitMs, 60_000)` —
   * a number derived from how long a CONTENDER waits, then used to decide when
   * a HOLDER is abandoned. At the gate's 1500 ms default that is 60 s, which is
   * shorter than a legitimate gated write (≈7 sequential ADT round trips, each
   * with its own 60 s `ABAP_TIMEOUT_MS`). So a slow-but-healthy write had its
   * lock broken and a second process walked into the same object — silently
   * losing exactly the serialisation guarantee this gate exists to establish,
   * and losing it precisely when the appliance was slow, i.e. when contention
   * was most likely. `FileLockObjectGate` now passes `hardStaleMs` explicitly.
   *
   * The holder here is `process.pid` — unambiguously alive — so the dead-pid
   * rule cannot fire and the hard-stale valve is the ONLY thing under test.
   * Fails before the fix by resolving "stolen" instead of rejecting.
   */
  it("does not break a 70 s-old lock whose holder is still alive", async () => {
    const stateDir = mkStateDir();
    const uri = "/sap/bc/adt/oo/classes/zcl_slow_but_alive";
    const waitMs = 100;
    const lockPath = objectGateLockPath(stateDir, uri);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        startedAt: new Date(Date.now() - 70_000).toISOString(),
      }),
      "utf8",
    );
    // 70 s: past the 60 s default hard-stale window this test exists to
    // disprove, far short of the gate's explicit 600 s one.
    const aged = new Date(Date.now() - 70_000);
    utimesSync(lockPath, aged, aged);

    const gate = new FileLockObjectGate({ stateDir, waitMs });
    let entered = false;
    const err = await gate
      .run(uri, async () => {
        entered = true;
        return "stolen";
      })
      .catch((e: unknown) => e);

    expect(entered, "the live holder's lock was broken and we entered anyway").toBe(false);
    expect(isAbapError(err)).toBe(true);
    expect((err as AbapError).code).toBe("OBJECT_LOCKED_CROSS_PROCESS");
    // The holder's file is left exactly as it was — not stolen, not rewritten.
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
  });
});

// ---------------------------------------------------------------------------
// c. Same-process FIFO ordering survives composition with the file lock
// ---------------------------------------------------------------------------

describe("in-process ordering, composed", () => {
  it("never overlaps two writers to the same objectUri on one gate instance", async () => {
    const stateDir = mkStateDir();
    const gate = new FileLockObjectGate({ stateDir, waitMs: 500 });
    const uri = "/sap/bc/adt/oo/classes/zcl_fifo";
    let busy = false;
    const order: string[] = [];

    const run = (label: string): Promise<void> =>
      gate.run(uri, async () => {
        expect(busy, `${label} must not start while another writer is in flight`).toBe(false);
        busy = true;
        order.push(`${label}-start`);
        await new Promise((r) => setTimeout(r, 10));
        order.push(`${label}-end`);
        busy = false;
      });

    await Promise.all([run("a"), run("b"), run("c")]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end", "c-start", "c-end"]);
  });
});

// ---------------------------------------------------------------------------
// d. Pool-construction gate selection
// ---------------------------------------------------------------------------

/** Minimal `SessionPoolOptions.cfg` double — the pool reads these fields and
 * nothing else. Mirrors test/pool.test.ts's `cfg()`, not imported from it
 * because that file's `Sizing` type and `SERIAL_BASELINE` are private to it. */
function fakeConfig(over: Partial<Record<string, unknown>> = {}): Config {
  return {
    maxSessions: 1,
    readConcurrency: 1,
    writeConcurrency: 1,
    sessionIdleMs: 300_000,
    sessionWaitMs: 10_000,
    debugDiaBudget: 2,
    ...over,
  } as unknown as Config;
}

function fakeCreateConnection(): SessionPoolOptions["createConnection"] {
  return (_c, o: ConnectionOptions) =>
    ({
      breaker: o.breaker,
      async shutdown() {},
      dispose() {},
    }) as unknown as AbapConnection;
}

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

describe("pool construction selects the gate", () => {
  it("installs InProcessObjectGate when ABAP_CROSS_PROCESS_OBJECT_LOCK=false", () => {
    withEnv("ABAP_CROSS_PROCESS_OBJECT_LOCK", "false", () => {
      const pool = new AdtSessionPool({
        cfg: fakeConfig({ serialiseSameObjectWrites: undefined }),
        breaker: new AuthCircuitBreaker(),
        createConnection: fakeCreateConnection(),
      });
      const gate = (pool as unknown as { gate: ObjectGate }).gate;
      expect(gate).toBeInstanceOf(InProcessObjectGate);
      expect(gate).not.toBeInstanceOf(FileLockObjectGate);
    });
  });

  it("installs FileLockObjectGate by default (ABAP_CROSS_PROCESS_OBJECT_LOCK unset)", () => {
    withEnv("ABAP_CROSS_PROCESS_OBJECT_LOCK", undefined, () => {
      const pool = new AdtSessionPool({
        cfg: fakeConfig({ serialiseSameObjectWrites: undefined }),
        breaker: new AuthCircuitBreaker(),
        createConnection: fakeCreateConnection(),
      });
      const gate = (pool as unknown as { gate: ObjectGate }).gate;
      expect(gate).toBeInstanceOf(FileLockObjectGate);
    });
  });

  it("still lets serialiseSameObjectWrites: false win outright, cross-process included", () => {
    withEnv("ABAP_CROSS_PROCESS_OBJECT_LOCK", undefined, () => {
      const pool = new AdtSessionPool({
        cfg: fakeConfig({ serialiseSameObjectWrites: false }),
        breaker: new AuthCircuitBreaker(),
        createConnection: fakeCreateConnection(),
      });
      const gate = (pool as unknown as { gate: ObjectGate }).gate;
      expect(gate).not.toBeInstanceOf(FileLockObjectGate);
      expect(gate).not.toBeInstanceOf(InProcessObjectGate);
    });
  });
});

// ---------------------------------------------------------------------------
// Gate selection off a REAL parsed Config
// ---------------------------------------------------------------------------

/**
 * The three tests immediately above build the pool from `fakeConfig()`, a
 * partial `Config` cast that has no `crossProcessObjectLock` key at all — so
 * they exercise the `?? resolveCrossProcessObjectLock()` fall-back arm in
 * `AdtSessionPool`'s constructor, which is exactly what keeps every other test
 * double in this repo working unchanged.
 *
 * This block exercises the OTHER arm: a genuinely `loadConfig`-parsed `Config`,
 * which always supplies a boolean and therefore always wins over the env
 * resolver. That is the arm production takes, and the one this fix moved, so
 * "the shipped defaults still select the cross-process file-lock gate" has to
 * be pinned here rather than inferred from the double-driven tests.
 *
 * Note both halves are asserted with the ENV VAR UNSET, so what is being
 * pinned is genuinely the default and not an env value leaking in from the
 * surrounding process.
 */
describe("gate selection from a parsed Config", () => {
  const parsedCfg = (over: Record<string, string> = {}): Config =>
    loadConfig({
      env: {
        ABAP_URL: "http://sap.invalid:50000",
        ABAP_USER: "U",
        ABAP_PASSWORD: "p",
        ...over,
      },
      warn: () => {},
      skipDotenv: true,
    });

  it("shipped defaults (nothing set) still install FileLockObjectGate", () => {
    withEnv("ABAP_CROSS_PROCESS_OBJECT_LOCK", undefined, () => {
      const pool = new AdtSessionPool({
        cfg: parsedCfg(),
        breaker: new AuthCircuitBreaker(),
        createConnection: fakeCreateConnection(),
      });
      const gate = (pool as unknown as { gate: ObjectGate }).gate;
      expect(gate).toBeInstanceOf(FileLockObjectGate);
    });
  });

  it("the parsed config value, not process.env, is what decides", () => {
    // The env var says nothing; the parsed config says `false` because it was
    // built from an env object that set it. If the constructor were still
    // reading `process.env` directly this would come back a
    // `FileLockObjectGate` and fail — which is the regression this plumbing
    // could most plausibly introduce in reverse.
    withEnv("ABAP_CROSS_PROCESS_OBJECT_LOCK", undefined, () => {
      const pool = new AdtSessionPool({
        cfg: parsedCfg({ ABAP_CROSS_PROCESS_OBJECT_LOCK: "off" }),
        breaker: new AuthCircuitBreaker(),
        createConnection: fakeCreateConnection(),
      });
      const gate = (pool as unknown as { gate: ObjectGate }).gate;
      expect(gate).toBeInstanceOf(InProcessObjectGate);
      expect(gate).not.toBeInstanceOf(FileLockObjectGate);
    });
  });

  it("serialiseSameObjectWrites=false still wins outright over the parsed switch", () => {
    // Precedence is unchanged here: the explicit opt-out of same-object
    // serialisation entirely still beats the cross-process switch, whichever
    // way that switch is set.
    const pool = new AdtSessionPool({
      cfg: parsedCfg({
        ABAP_SERIALISE_SAME_OBJECT_WRITES: "false",
        ABAP_CROSS_PROCESS_OBJECT_LOCK: "true",
      }),
      breaker: new AuthCircuitBreaker(),
      createConnection: fakeCreateConnection(),
    });
    const gate = (pool as unknown as { gate: ObjectGate }).gate;
    expect(gate).not.toBeInstanceOf(FileLockObjectGate);
    expect(gate).not.toBeInstanceOf(InProcessObjectGate);
  });

  it("objectLockWaitMs from the parsed config reaches the gate", () => {
    withEnv("ABAP_OBJECT_LOCK_WAIT_MS", undefined, () => {
      const pool = new AdtSessionPool({
        cfg: parsedCfg({ ABAP_OBJECT_LOCK_WAIT_MS: "4321" }),
        breaker: new AuthCircuitBreaker(),
        createConnection: fakeCreateConnection(),
      });
      const gate = (pool as unknown as { gate: ObjectGate }).gate as FileLockObjectGate;
      expect(gate).toBeInstanceOf(FileLockObjectGate);
      expect((gate as unknown as { waitMs: number }).waitMs).toBe(4321);
    });
  });

  it("an out-of-range objectLockWaitMs reaches the gate as the default, not clamped", () => {
    // 1 ms is below the 200 ms minimum. The soft-fallback must have already
    // happened in the schema, so the gate sees 1500 — not 1, and not 200.
    withEnv("ABAP_OBJECT_LOCK_WAIT_MS", undefined, () => {
      const pool = new AdtSessionPool({
        cfg: parsedCfg({ ABAP_OBJECT_LOCK_WAIT_MS: "1" }),
        breaker: new AuthCircuitBreaker(),
        createConnection: fakeCreateConnection(),
      });
      const gate = (pool as unknown as { gate: ObjectGate }).gate;
      expect((gate as unknown as { waitMs: number }).waitMs).toBe(1500);
    });
  });
});
