/**
 * A condemned-connection refusal must not authorize a WRITE
 * replay.
 *
 * `assertUsable()` (`src/adt/connection.ts`) throws `connectionDeadError()`
 * whenever `this.death` is set — state recorded by an EARLIER response, via
 * `markDead()`. That error is coded `SESSION_DEAD`, the exact code `pool.ts`'s
 * `isSessionDeadError` uses to decide a slot is untrustworthy AND (subject to
 * `eligibleForDeadSlotReplay`) that the caller's own operation is safe to
 * replay on a fresh slot.
 *
 * The hazard: `connectionDeadError` proves the CONNECTION was condemned. It
 * proves NOTHING about whether the operation failing right now was applied —
 * in the incident this test reproduces, it is thrown from a cleanup path's
 * `finally` AFTER a successful write, and a throw from a `finally` silently replaces that
 * success. If the pool blindly replayed on that shape, a successful write
 * would be silently repeated against a real SAP system — the worst failure
 * mode in this codebase. And critically, this shape can arrive well under
 * `DEAD_ON_ARRIVAL_MS`, because nothing about it
 * ever went over the wire — so the OLD timing-only gate would have let it
 * through.
 *
 * `connectionDeadError` now stamps `details.condemned: true` (F3a), and
 * `pool.ts`'s `isCondemnedConnectionError` / the write-replay gate in
 * `eligibleForDeadSlotReplay` (F3b) refuse to replay a WRITE that fails this
 * way — structurally, independent of timing. This file pins that guard at the
 * pool boundary. It reuses `test/pool.test.ts`'s offline harness style: no
 * socket, an injected clock, a stub connection factory.
 */
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { AbapConnection, ConnectionOptions } from "../src/adt/connection.js";
import { connectionDeadError, type DeathRecord } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { AdtSessionPool } from "../src/adt/pool.js";

// ---------------------------------------------------------------------------
// Harness — mirrors test/pool.test.ts. Kept local (not imported) because that
// file's helpers are module-private; duplicating the small subset needed here
// is cheaper than exporting test-only surface from pool.test.ts.
// ---------------------------------------------------------------------------

interface Sizing {
  maxSessions: number;
  readConcurrency: number;
  writeConcurrency: number;
  sessionIdleMs: number;
  sessionWaitMs: number;
  debugDiaBudget: number;
  serialiseSameObjectWrites: boolean | undefined;
}

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
  dead: boolean;
  disposals: number;
  shutdown(reason: string): Promise<void>;
  dispose(): void;
}

interface Factory {
  create: (c: Config, o: ConnectionOptions) => AbapConnection;
  created: StubConn[];
}

function factory(): Factory {
  const created: StubConn[] = [];
  const create = (_c: Config, o: ConnectionOptions): AbapConnection => {
    const stub: StubConn = {
      n: created.length,
      breaker: o.breaker,
      dead: false,
      disposals: 0,
      async shutdown() {},
      dispose() {
        this.disposals++;
      },
    };
    created.push(stub);
    return stub as unknown as AbapConnection;
  };
  return { create, created };
}

/** Deterministic clock. Nothing here uses real time. */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    setTimer: (): unknown => undefined,
    clearTimer: (): void => {},
    advance(ms: number): void {
      t += ms;
    },
  };
}

function makePool(over: Partial<Sizing> = {}) {
  const f = factory();
  const c = clock();
  const breaker = new AuthCircuitBreaker();
  const pool = new AdtSessionPool({
    cfg: cfg(over),
    breaker,
    createConnection: f.create,
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
  });
  return { pool, f, c, breaker };
}

const ORIGINAL_CROSS_PROCESS_OBJECT_LOCK = process.env.ABAP_CROSS_PROCESS_OBJECT_LOCK;
process.env.ABAP_CROSS_PROCESS_OBJECT_LOCK = "false";
// vitest.config.ts pins fileParallelism: false (see test/pool.test.ts's own
// note), so restoring at module-eval time here would race that file. This
// file only ever sets the same value pool.test.ts's beforeAll sets, so a
// missing afterAll does not leave a difference behind for anything else to
// observe. (Kept intentionally minimal — see pool.test.ts for the full
// three-branch gate-selection reasoning this env var exists for.)
void ORIGINAL_CROSS_PROCESS_OBJECT_LOCK;

// A genuine death record, as `markDead()` would produce.
function death(): DeathRecord {
  return { reason: "test dump", atMs: 1_000_000, heldLockUris: [] };
}

/** The condemned shape: connectionDeadError()'s own output. */
const condemned = (): AbapError => connectionDeadError(death());

/** A genuine PER-REQUEST wire death — the wire-death shape, no condemned marker. */
const wireSessionDead = (): AbapError =>
  new AbapError("SESSION_DEAD", "The ABAP session was destroyed by a short dump.");

describe("a condemned-connection refusal must not authorize a write replay", () => {
  it("does NOT replay a WRITE whose error is a condemned-connection refusal, even arriving fast", async () => {
    const { pool, c } = makePool();
    let calls = 0;
    await expect(
      pool.withWrite("mutate", undefined, async () => {
        calls++;
        c.advance(50); // far under DEAD_ON_ARRIVAL_MS — the old timing gate WOULD allow replay
        throw condemned();
      }),
    ).rejects.toMatchObject({ code: "SESSION_DEAD", details: { condemned: true } });

    // The load-bearing assertion: without F3b's structural gate, this fn
    // would be invoked a SECOND time on a fresh slot — replaying whatever
    // mutation it represents against a real SAP system.
    expect(calls, "no replay: a condemned-connection refusal proves nothing about this write").toBe(
      1,
    );
  });

  it("still retires the slot when a write is refused by a condemned connection (only the REPLAY is refused)", async () => {
    const { pool, f, c } = makePool();
    await expect(
      pool.withWrite("mutate", undefined, async () => {
        c.advance(50);
        throw condemned();
      }),
    ).rejects.toMatchObject({ code: "SESSION_DEAD" });

    expect(pool.stats(), "the condemned slot is not kept in the pool").toMatchObject({
      total: 0,
      dead: 0,
    });
    expect(f.created[0]!.disposals, "the condemned slot was disposed, i.e. retired").toBe(1);
  });

  it("a READ with the same condemned error still replays — a GET has no side effect to duplicate", async () => {
    const { pool, f, c } = makePool();
    let calls = 0;
    const result = await pool.withRead("victim-read", async (conn) => {
      calls++;
      if (calls === 1) {
        c.advance(50);
        throw condemned();
      }
      return conn;
    });
    expect(calls, "the condemned marker does not block a read replay").toBe(2);
    expect(f.created).toHaveLength(2);
    expect(result).toBe(f.created[1] as unknown as typeof result);
  });

  it("a WRITE with a genuine wire SESSION_DEAD (no condemned marker) still replays fast — the DEAD_ON_ARRIVAL_MS fast-replay path intact", async () => {
    const { pool, f, c } = makePool();
    let calls = 0;
    const result = await pool.withWrite("mutate", undefined, async (conn) => {
      calls++;
      if (calls === 1) {
        c.advance(50); // far under DEAD_ON_ARRIVAL_MS
        throw wireSessionDead();
      }
      return conn;
    });
    expect(calls, "the DEAD_ON_ARRIVAL_MS fast-arrival replay must still work for a genuine wire death").toBe(2);
    expect(f.created).toHaveLength(2);
    expect(result).toBe(f.created[1] as unknown as typeof result);
  });

  it("connectionDeadError() carries the condemned marker and is still coded SESSION_DEAD", () => {
    const e = connectionDeadError(death());
    expect(isAbapError(e)).toBe(true);
    expect(e.code).toBe("SESSION_DEAD");
    expect(e.details.condemned).toBe(true);
    // The existing `reason` field is untouched — other code reads it, and F3a
    // was explicit that `condemned` must not repurpose it.
    expect(e.details.reason).toBe("test dump");
  });
});
