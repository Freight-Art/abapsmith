/**
 * Shared shutdown hook (`src/shutdown-hook.ts`) — regression tests for:
 *
 *  (A) Before this hook existed, every `AbapConnection` installed its own
 *      SIGINT/SIGTERM/beforeExit listeners directly on `process`, so N live
 *      connections meant N listeners per signal — past Node's default cap of
 *      10 this printed `MaxListenersExceededWarning`. The hook installs at
 *      most ONE listener per signal no matter how many subscribers register.
 *  (B) A subscriber that unregisters (mirrors `AbapConnection.dispose()`)
 *      must not leave a dangling process listener behind once it was the
 *      last one.
 *  (C) A promise-returning cleanup is a one-shot: a second signal arriving
 *      while it is still in flight, or after it already settled, must not
 *      invoke it again (this is what makes `beforeExit` firing after
 *      `SIGTERM` already ran cleanup safe).
 *  (D) One subscriber throwing or rejecting must never stop any other
 *      subscriber — earlier or later in registration order — from running.
 *  (E) `SHUTDOWN_HOOK_BUDGET_MS` (overridable for tests) bounds how long the
 *      hook WAITS on a hung promise-returning cleanup; it must mark it
 *      abandoned rather than hang forever, without pretending to cancel the
 *      underlying work (see module doc in src/shutdown-hook.ts).
 *
 * All offline: signals are fired synthetically via `process.emit`, which
 * just invokes registered listeners — it never kills this process. Real
 * `process.exit` is never reachable from this hook (see module doc: it never
 * calls `process.exit` itself, that stays `AbapConnection`'s job).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetShutdownHookForTests,
  __setShutdownHookBudgetMsForTests,
  __setShutdownHookLogForTests,
  __shutdownHandlerCountForTests,
  registerShutdownHandler,
} from "../src/shutdown-hook.js";

afterEach(() => {
  __resetShutdownHookForTests();
  __setShutdownHookBudgetMsForTests(undefined);
  __setShutdownHookLogForTests(undefined);
});

describe("shared shutdown hook — listener sharing", () => {
  it("installs at most one process listener per signal regardless of subscriber count", () => {
    const beforeInt = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    const beforeExit = process.listenerCount("beforeExit");

    const unregisters = [
      registerShutdownHandler("a", () => {}),
      registerShutdownHandler("b", () => {}),
      registerShutdownHandler("c", () => {}),
    ];

    expect(__shutdownHandlerCountForTests()).toBe(3);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
    expect(process.listenerCount("beforeExit")).toBe(beforeExit + 1);

    for (const unregister of unregisters) unregister();
  });

  it("removes the process listeners once the last subscriber unregisters", () => {
    const beforeInt = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    const beforeExit = process.listenerCount("beforeExit");

    const unregisterA = registerShutdownHandler("a", () => {});
    const unregisterB = registerShutdownHandler("b", () => {});
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);

    unregisterA();
    // Still one subscriber left — the shared listener must stay installed.
    expect(__shutdownHandlerCountForTests()).toBe(1);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
    expect(process.listenerCount("beforeExit")).toBe(beforeExit + 1);

    unregisterB();
    expect(__shutdownHandlerCountForTests()).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    expect(process.listenerCount("beforeExit")).toBe(beforeExit);
  });

  it("calling unregister twice is a no-op (does not double-decrement)", () => {
    const beforeInt = process.listenerCount("SIGINT");
    const unregister = registerShutdownHandler("a", () => {});
    unregister();
    unregister();
    expect(__shutdownHandlerCountForTests()).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
  });
});

describe("shared shutdown hook — idempotency of one-shot (promise-returning) cleanups", () => {
  it("does not re-invoke a still-pending cleanup on a second signal", () => {
    const spy = vi.fn(() => new Promise<void>(() => {})); // never settles
    const unregister = registerShutdownHandler("pending", spy);

    process.emit("SIGINT");
    process.emit("SIGINT");
    process.emit("SIGTERM");

    expect(spy).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("does not re-invoke a cleanup after it has already settled", async () => {
    const spy = vi.fn(() => Promise.resolve());
    const unregister = registerShutdownHandler("settles", spy);

    process.emit("SIGINT");
    await new Promise((r) => setTimeout(r, 10));
    expect(spy).toHaveBeenCalledTimes(1);

    // beforeExit firing after SIGINT already ran cleanup must be a no-op.
    process.emit("beforeExit");
    await new Promise((r) => setTimeout(r, 10));
    expect(spy).toHaveBeenCalledTimes(1);

    unregister();
  });

  it("DOES re-invoke a synchronous (self-managed) cleanup on every signal", () => {
    const spy = vi.fn(() => {});
    const unregister = registerShutdownHandler("sync", spy);

    process.emit("SIGINT");
    process.emit("SIGINT");
    process.emit("SIGTERM");

    expect(spy).toHaveBeenCalledTimes(3);
    unregister();
  });
});

describe("shared shutdown hook — isolated failures", () => {
  it("a synchronously throwing cleanup does not block earlier or later subscribers", () => {
    const before = vi.fn(() => {});
    const thrower = vi.fn(() => {
      throw new Error("boom");
    });
    const after = vi.fn(() => Promise.resolve());
    __setShutdownHookLogForTests(() => {}); // silence the expected failure log

    const u1 = registerShutdownHandler("before", before);
    const u2 = registerShutdownHandler("thrower", thrower);
    const u3 = registerShutdownHandler("after", after);

    process.emit("SIGINT");

    expect(before).toHaveBeenCalledTimes(1);
    expect(thrower).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);

    u1();
    u2();
    u3();
  });

  it("a rejecting cleanup does not block other subscribers and is logged once", async () => {
    const logs: string[] = [];
    __setShutdownHookLogForTests((m) => logs.push(m));

    const other = vi.fn(() => Promise.resolve());
    const rejecter = vi.fn(() => Promise.reject(new Error("nope")));

    const u1 = registerShutdownHandler("rejecter", rejecter);
    const u2 = registerShutdownHandler("other", other);

    process.emit("SIGINT");
    await new Promise((r) => setTimeout(r, 10));

    expect(other).toHaveBeenCalledTimes(1);
    expect(rejecter).toHaveBeenCalledTimes(1);
    expect(logs.some((m) => m.includes("rejecter") && m.includes("nope"))).toBe(true);

    u1();
    u2();
  });
});

describe("shared shutdown hook — bounded waiting", () => {
  it("marks a hanging cleanup abandoned once the budget elapses, instead of waiting forever", async () => {
    const logs: string[] = [];
    __setShutdownHookLogForTests((m) => logs.push(m));
    __setShutdownHookBudgetMsForTests(20);

    const hang = vi.fn(() => new Promise<void>(() => {})); // never settles
    const unregister = registerShutdownHandler("hangs", hang);

    process.emit("SIGINT");
    // Give the 20ms budget time to elapse and fire its abandonment timer.
    await new Promise((r) => setTimeout(r, 60));

    expect(hang).toHaveBeenCalledTimes(1);
    expect(logs.some((m) => m.includes("hangs") && m.includes("no longer waiting"))).toBe(true);

    // A later signal must not start a second, concurrent attempt at the same
    // hung work (module doc: abandoned means "never invoked again").
    process.emit("SIGTERM");
    expect(hang).toHaveBeenCalledTimes(1);

    unregister();
  });

  it("a well-behaved cleanup that settles within the budget is not marked abandoned", async () => {
    const logs: string[] = [];
    __setShutdownHookLogForTests((m) => logs.push(m));
    __setShutdownHookBudgetMsForTests(50);

    const spy = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
    const unregister = registerShutdownHandler("quick", spy);

    process.emit("SIGINT");
    await new Promise((r) => setTimeout(r, 30));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(logs.some((m) => m.includes("no longer waiting"))).toBe(false);

    unregister();
  });
});
