/**
 * `AdtSessionPool.eligibleForDeadSlotReplay` returns `true` unconditionally
 * for `role === "read"`: a read failing with `SESSION_DEAD` is replayed on a
 * fresh slot without consulting either write-lane gate
 * (`isCondemnedConnectionError`, `DEAD_ON_ARRIVAL_MS`). That is safe for a
 * GET — nothing to duplicate.
 *
 * `abap_run` and `abap_test` execute customer ABAP, and used to dispatch on
 * that read lane. `src/adt/run.ts`'s `translateRunFailure` synthesizes
 * exactly the triggering `SESSION_DEAD` shape (the `kind: "session-timeout"`
 * branch) AFTER the classrun POST has already reached the server — so a
 * session death partway through a run could replay ungated and unreported,
 * executing the ABAP a second time against a real system.
 *
 * This file pins three things: (a) `abap_run`/`abap_test`, dispatched through
 * their real registrars, take a WRITE slot with no object gate; (b) a
 * `SESSION_DEAD` raised in the shape `run.ts` actually produces, arriving
 * well after `DEAD_ON_ARRIVAL_MS`, is NOT replayed on that lane — the
 * classrun runs exactly once; (c) the same failure on the read lane (an op
 * that does not execute ABAP) still replays, unchanged — proving (b) isn't
 * vacuous; (d) `withRead` refuses `abap_run`/`abap_test`/`abap_bopf_test`
 * outright, behaviourally (never importing the module-private op set), so a
 * future call site cannot reintroduce this by omission.
 */
import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../src/config.js";
import type { AbapConnection, ConnectionOptions } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { AbapError } from "../src/adt/errors.js";
import { AdtSessionPool, type SessionPool } from "../src/adt/pool.js";
import { SafetyGate } from "../src/safety.js";
import { errorResult } from "../src/server.js";
import { registerRunTools } from "../src/tools/run.js";
import { registerTestTools } from "../src/tools/test.js";

// ---------------------------------------------------------------------------
// Harness — mirrors test/pool-condemned-replay.test.ts, which mirrors
// test/pool.test.ts. Kept local (not imported) because that file's helpers
// are module-private; duplicating the small subset needed here is cheaper
// than exporting test-only surface from pool.test.ts.
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
// observe.
void ORIGINAL_CROSS_PROCESS_OBJECT_LOCK;

/** The exact SESSION_DEAD shape `src/adt/run.ts`'s `translateRunFailure` synthesizes for a
 * session timeout hit AFTER the classrun POST already reached the server — no `condemned`
 * marker, because nothing about this shape proves the connection died mid-`fn`. */
const sessionTimeoutDead = (): AbapError =>
  new AbapError(
    "SESSION_DEAD",
    'The ABAP session was gone while running ZCL_ZTMD_X (HTTP 403, "Session Timed Out").',
    { class: "ZCL_ZTMD_X", status: 403, kind: "session-timeout" },
  );

// ---------------------------------------------------------------------------
// (a) lane observation, driven through the real registrars.
// ---------------------------------------------------------------------------

/** Captures `registerTool` into a map instead of talking to an MCP client. */
function fakeMcp(): {
  mcp: McpServer;
  tools: Map<
    string,
    { config: Record<string, unknown>; handler: (args: unknown) => Promise<CallToolResult> }
  >;
} {
  const tools = new Map<
    string,
    { config: Record<string, unknown>; handler: (args: unknown) => Promise<CallToolResult> }
  >();
  const mcp = {
    registerTool: (
      name: string,
      config: Record<string, unknown>,
      handler: (args: unknown) => Promise<CallToolResult>,
    ) => {
      tools.set(name, { config, handler });
      return {} as unknown;
    },
  } as unknown as McpServer;
  return { mcp, tools };
}

type Lane = "read" | "write";
interface Dispatch {
  lane: Lane;
  op: string;
  objectUri: string | undefined;
}

/** Records which lane each op was dispatched on, then hands `fn` a leak-detecting stub connection. */
function recorderPool(): { pool: SessionPool; dispatches: Dispatch[] } {
  const dispatches: Dispatch[] = [];
  const conn = {
    discovery: { assertSupported: () => {} },
    async get() {
      throw new Error("NETWORK CALL LEAKED: this harness has no responses");
    },
    async post() {
      throw new Error("NETWORK CALL LEAKED: this harness has no responses");
    },
  } as unknown as AbapConnection;

  const pool = {
    withRead: <T,>(op: string, fn: (c: AbapConnection) => Promise<T>) => {
      dispatches.push({ lane: "read", op, objectUri: undefined });
      return fn(conn);
    },
    withWrite: <T,>(op: string, objectUri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => {
      dispatches.push({ lane: "write", op, objectUri });
      return fn(conn);
    },
  } as unknown as SessionPool;

  return { pool, dispatches };
}

function toolHarness() {
  const { pool, dispatches } = recorderPool();
  const safety = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"], writesLockedOut: false });
  const { mcp, tools } = fakeMcp();
  registerRunTools(mcp, {
    pool,
    safety,
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: 60_000 },
  });
  registerTestTools(mcp, {
    pool,
    safety,
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: 60_000 },
  });
  const run = tools.get("abap_run");
  const test = tools.get("abap_test");
  if (!run) throw new Error("abap_run was never registered");
  if (!test) throw new Error("abap_test was never registered");
  return { dispatches, run: run.handler, test: test.handler };
}

describe("abap_run / abap_test take the write lane", () => {
  it("abap_run: exactly one pool dispatch, on the write lane, no object gate", async () => {
    const { dispatches, run } = toolHarness();
    // Fails downstream (the stub connection has no responses) — expected. What
    // is asserted is which lane was taken on the way there.
    await run({ object: "ZCL_ZTMD_X" });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toEqual({ lane: "write", op: "abap_run", objectUri: undefined });
  });

  it("abap_test: exactly one pool dispatch, on the write lane, no object gate", async () => {
    const { dispatches, test } = toolHarness();
    await test({ object: "ZCL_ZTMD_X", risk_level: "harmless" });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toEqual({ lane: "write", op: "abap_test", objectUri: undefined });
  });
});

// ---------------------------------------------------------------------------
// (b)/(c) THE KEY TEST — dispatch through the pool on the lane the real
// registrars actually chose in (a), so this breaks if the registrar ever
// moves back.
// ---------------------------------------------------------------------------

function dispatchOn<T>(
  pool: AdtSessionPool,
  lane: Lane,
  op: string,
  fn: (conn: AbapConnection) => Promise<T>,
): Promise<T> {
  return lane === "write" ? pool.withWrite(op, undefined, fn) : pool.withRead(op, fn);
}

describe("a SESSION_DEAD raised after the ABAP already ran is not replayed on the write lane", () => {
  it("abap_run's lane: the classrun function runs exactly once", async () => {
    const { dispatches, run } = toolHarness();
    await run({ object: "ZCL_ZTMD_X" }).catch(() => {});
    const lane = dispatches[0]!.lane;

    const { pool, c } = makePool();
    let calls = 0;
    await expect(
      dispatchOn(pool, lane, "abap_run", async () => {
        calls++;
        // A real classrun round trip, well past DEAD_ON_ARRIVAL_MS (500ms).
        c.advance(900);
        throw sessionTimeoutDead();
      }),
    ).rejects.toMatchObject({ code: "SESSION_DEAD" });

    expect(
      calls,
      "a second invocation here is the classrun executing a second time against a real system",
    ).toBe(1);
  });

  it("abap_test's lane: the AUnit run runs exactly once", async () => {
    const { dispatches, test } = toolHarness();
    await test({ object: "ZCL_ZTMD_X", risk_level: "harmless" }).catch(() => {});
    const lane = dispatches[0]!.lane;

    const { pool, c } = makePool();
    let calls = 0;
    await expect(
      dispatchOn(pool, lane, "abap_test", async () => {
        calls++;
        c.advance(900);
        throw sessionTimeoutDead();
      }),
    ).rejects.toMatchObject({ code: "SESSION_DEAD" });

    expect(
      calls,
      "a second invocation here is the AUnit run executing a second time against a real system",
    ).toBe(1);
  });

  it("contrast: the same failure on a non-executing read op still replays, unchanged", async () => {
    const { pool, c } = makePool();
    let calls = 0;
    await pool.withRead("abap_read", async (conn) => {
      calls++;
      if (calls === 1) {
        c.advance(900);
        throw sessionTimeoutDead();
      }
      return conn;
    });
    // Pins that (b) passes because of the LANE, not because replay was
    // globally disabled: an op that doesn't execute ABAP still replays.
    expect(calls, "read-lane replay is deliberate and unchanged for a non-executing op").toBe(2);
  });
});

// ---------------------------------------------------------------------------
// (d) the guard, behaviourally — never importing the op set itself.
// ---------------------------------------------------------------------------

describe("withRead refuses an op that executes ABAP", () => {
  it.each(["abap_run", "abap_test", "abap_bopf_test"])("%s: UNSUPPORTED, fn never invoked", async (op) => {
    const { pool } = makePool();
    let invoked = false;
    await expect(
      pool.withRead(op, async () => {
        invoked = true;
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(invoked, `${op} must never run on the read lane`).toBe(false);
  });
});
