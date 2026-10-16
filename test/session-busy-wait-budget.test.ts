/**
 * Issue #242 — a call queued behind a long holder (an `abap_ui` press) must
 * wait as long as that holder can legitimately run, and a refusal that still
 * happens must be classified retryable with the holder's details.
 *
 * Verified with injected clocks and timer queues only: nothing here touches
 * real time or a live SAP system (a timing change has no meaningful A4H repro).
 */
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { AbapConnection, ConnectionOptions } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { AdtSessionPool } from "../src/adt/pool.js";
import { SessionBusyError, SessionLock } from "../src/adt/session-lock.js";
import { buildErrorPayload } from "../src/tool-errors.js";

interface Timer {
  at: number;
  fn: () => void;
  cancelled: boolean;
}

function fakeTime() {
  let t = 1_000_000;
  const timers: Timer[] = [];
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number): unknown => {
      const timer = { at: t + ms, fn, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (h: unknown): void => {
      (h as Timer).cancelled = true;
    },
    async advance(ms: number): Promise<void> {
      const target = t + ms;
      for (;;) {
        const due = timers.filter((x) => !x.cancelled && x.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = Math.max(t, due.at);
        due.cancelled = true;
        due.fn();
        await flush();
      }
      t = target;
      await flush();
    },
  };
}

function poolCfg(over: Record<string, number> = {}): Config {
  return {
    maxSessions: 1,
    readConcurrency: 1,
    writeConcurrency: 1,
    sessionIdleMs: 300_000,
    sessionWaitMs: 10_000,
    timeoutMs: 60_000,
    bopfTimeoutMs: 60_000,
    activateTimeoutMs: 60_000,
    runTimeoutMs: 60_000,
    searchTimeoutMs: 60_000,
    debugDiaBudget: 2,
    serialiseSameObjectWrites: false,
    ...over,
  } as unknown as Config;
}

function makePool(over: Record<string, number> = {}) {
  const time = fakeTime();
  const pool = new AdtSessionPool({
    cfg: poolCfg(over),
    breaker: new AuthCircuitBreaker(),
    createConnection: (_c: Config, o: ConnectionOptions) =>
      ({ breaker: o.breaker, async shutdown() {}, dispose() {} }) as unknown as AbapConnection,
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  });
  return { pool, time };
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

describe("pool wait budget includes the holder's own timeout (#242)", () => {
  it("keeps a call queued past sessionWaitMs while the holder is within its request timeout", async () => {
    const { pool, time } = makePool();
    const g = gate();
    const holder = pool.withWrite("abap_ui", undefined, () => g.promise);
    await time.advance(0);
    const queued = pool.withWrite("abap_fluid", undefined, async () => "done");
    let settled = false;
    queued.then(
      () => (settled = true),
      () => (settled = true),
    );

    await time.advance(55_000); // far past the old 10 s fixed budget
    expect(settled, "must still be waiting: the press may legitimately run 60 s").toBe(false);

    g.open();
    await holder;
    await expect(queued).resolves.toBe("done");
  });

  it("refuses with a retryable SESSION_BUSY naming holder, elapsed and expected remaining when the budget is spent", async () => {
    const { pool, time } = makePool();
    const g = gate();
    void pool.withWrite("abap_ui", undefined, () => g.promise);
    await time.advance(0);
    const queued = pool.withWrite("abap_fluid", undefined, async () => "done");
    const outcome = queued.then(
      () => undefined,
      (e: unknown) => e,
    );

    await time.advance(70_000); // sessionWaitMs 10 s + ceiling 60 s
    const err = await outcome;
    expect(err).toBeInstanceOf(SessionBusyError);
    const busy = err as SessionBusyError;
    expect(busy).toMatchObject({
      code: "SESSION_BUSY",
      reason: "wait-timeout",
      holder: "abap_ui",
      retryable: true,
      heldForMs: 70_000,
      expectedRemainingMs: 0,
    });
    expect(busy.retryAfterMs).toBe(1_000);
    expect(busy.message).toContain("retry in ~1000ms");
    g.open();
  });
});

describe("SessionBusyError classification (#242)", () => {
  it("suggests a retry delay from the expected remaining time, clamped", () => {
    const e = new SessionBusyError({
      reason: "wait-timeout",
      holder: "abap_ui",
      holderKind: "exclusive",
      heldForMs: 20_000,
      expectedRemainingMs: 40_000,
    });
    expect(e.retryable).toBe(true);
    expect(e.expectedRemainingMs).toBe(40_000);
    expect(e.retryAfterMs).toBe(40_000);
    expect(e.message).toContain("up to ~40000ms longer");
  });

  it("does not claim a lease refusal is retryable", () => {
    const e = new SessionBusyError({
      reason: "lease-held",
      holder: "debug",
      holderKind: "lease",
      heldForMs: 5,
    });
    expect(e.retryable).toBe(false);
    expect(e.retryAfterMs).toBeUndefined();
  });

  it("reaches the tool result as SESSION_BUSY with retryable and details, not ADT_ERROR", () => {
    const e = new SessionBusyError({
      reason: "wait-timeout",
      holder: "abap_ui",
      holderKind: "exclusive",
      heldForMs: 61_000,
      expectedRemainingMs: 0,
      op: "abap_fluid",
    });
    const p = buildErrorPayload(e);
    expect(p).toMatchObject({
      error: "SESSION_BUSY",
      retryable: true,
      details: { holder: "abap_ui", heldForMs: 61_000, expectedRemainingMs: 0, retryAfterMs: 1_000 },
    });
    expect(p.hint).toMatch(/Retry the same call/);
  });
});

describe("SessionLock reports the holder's expected remaining time (#242)", () => {
  it("fills expectedRemainingMs from expectedHoldMs minus time held", async () => {
    const time = fakeTime();
    const lock = new SessionLock({
      maxQueue: 0,
      expectedHoldMs: 60_000,
      now: time.now,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    });
    const g = gate();
    void lock.runExclusive("abap_ui", () => g.promise);
    await time.advance(15_000);
    const err = await lock.runExclusive("other", async () => 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionBusyError);
    expect(err).toMatchObject({ reason: "queue-full", retryable: true, expectedRemainingMs: 45_000 });
    g.open();
  });
});
