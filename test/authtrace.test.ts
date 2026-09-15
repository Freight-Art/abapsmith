/**
 * Unit tests for src/adt/authtrace.ts. `dispatch()` (src/adt/fluid/dispatch.js)
 * is mocked — same idiom as test/fluid-invokers.test.ts's `deleteMock` — so
 * every scenario below (trace-then-SU53 fallback, rendering, and every
 * `withAuthTrace` switch-off path) is a pure, fast unit test with no
 * AbapConnection, no fluid runtime, and no network.
 */
import { describe, expect, it, vi } from "vitest";

import { AbapError } from "../src/adt/errors.js";
import type { AbapConnection } from "../src/adt/connection.js";
import type { SafetyGate } from "../src/safety.js";

const dispatchMock = vi.fn();

vi.mock("../src/adt/fluid/dispatch.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/fluid/dispatch.js")>()),
  dispatch: (...args: unknown[]) => dispatchMock(...args),
}));

const {
  authTraceOn,
  authTraceOff,
  authTraceStatus,
  readFailedAuthChecks,
  renderFailedAuthChecks,
  withAuthTrace,
  switchOffErrorOf,
  authTraceOf,
  mapCheckRows,
} = await import("../src/adt/authtrace.js");

const FAKE_CONN = { cfg: { sid: "A4H" } } as unknown as AbapConnection;
const FAKE_GATE = {} as unknown as SafetyGate;
const DEPS = { conn: FAKE_CONN, gate: FAKE_GATE };

function dispatchResult(result: unknown): { result: unknown } {
  return { result };
}

function traceRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    origin: "trace",
    object: "S_TABU_NAM",
    rc: "4",
    reason: "",
    fields: "ACTVT=03, TABLE=ZTAB",
    program: "ZCL_FOO=>METHOD_BAR",
    line: "42",
    tcode: "",
    timestamp: "20260915083842",
    ...overrides,
  };
}

function su53Row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    origin: "su53",
    object: "S_RFCACL",
    rc: "12",
    reason: "",
    fields: "RFC_SYSID=QQQ, RFC_CLIENT=123",
    program: "ZCL_I112_PROBE================CM001",
    line: "63",
    tcode: "",
    timestamp: "20260915083842.0473560",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// readFailedAuthChecks: trace mapping + fallback
// ---------------------------------------------------------------------------

describe("readFailedAuthChecks", () => {
  it("maps kernel-trace rows to origin: 'trace' and does not fall back", async () => {
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValueOnce(dispatchResult([traceRow(), traceRow({ object: "S_DEVELOP" })]));

    const { checks, usedFallback } = await readFailedAuthChecks(DEPS, {
      user: "DEVELOPER",
      from: "20260915083000",
    });

    expect(usedFallback).toBe(false);
    expect(checks).toHaveLength(2);
    expect(checks[0]).toEqual({
      origin: "trace",
      object: "S_TABU_NAM",
      rc: "4",
      reason: "",
      fields: "ACTVT=03, TABLE=ZTAB",
      program: "ZCL_FOO=>METHOD_BAR",
      line: "42",
      tcode: "",
      timestamp: "20260915083842",
    });
    // read only — su53 was never called
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to su53 when the kernel trace returns zero rows, labeling rows origin: 'su53'", async () => {
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValueOnce(dispatchResult([])); // read
    dispatchMock.mockResolvedValueOnce(dispatchResult([su53Row(), su53Row({ object: "Z_I112_NOP" })])); // su53

    const { checks, usedFallback } = await readFailedAuthChecks(DEPS, {
      user: "DEVELOPER",
      from: "20260915083000",
    });

    expect(usedFallback).toBe(true);
    expect(checks).toHaveLength(2);
    expect(checks.every((c) => c.origin === "su53")).toBe(true);
    expect(checks[0]?.object).toBe("S_RFCACL");
    expect(dispatchMock).toHaveBeenCalledTimes(2);

    const secondCallArgs = dispatchMock.mock.calls[1]?.[1] as { action: string };
    expect(secondCallArgs.action).toBe("su53");
  });
});

describe("mapCheckRows", () => {
  it("rejects a row whose origin does not match the expected origin for the action", () => {
    expect(() => mapCheckRows("read", [su53Row()], "trace")).toThrow(AbapError);
  });

  it("rejects a non-array result", () => {
    expect(() => mapCheckRows("read", { not: "an array" }, "trace")).toThrow(AbapError);
  });

  it("rejects a row missing a required string field", () => {
    const bad = traceRow();
    delete bad.fields;
    expect(() => mapCheckRows("read", [bad], "trace")).toThrow(AbapError);
  });
});

// ---------------------------------------------------------------------------
// renderFailedAuthChecks
// ---------------------------------------------------------------------------

describe("renderFailedAuthChecks", () => {
  it("renders a FAILED AUTH CHECKS section with one [trace] line per check", () => {
    const text = renderFailedAuthChecks([traceRow() as never]);
    expect(text).toContain("FAILED AUTH CHECKS");
    expect(text).toContain("S_TABU_NAM ACTVT=03, TABLE=ZTAB rc=4 at ZCL_FOO=>METHOD_BAR line 42 [trace]");
  });

  it("labels su53 rows with the [SU53 fallback] provenance, not a bare [su53]", () => {
    const text = renderFailedAuthChecks([su53Row() as never]);
    expect(text).toContain("[SU53 fallback]");
    expect(text).not.toContain("[su53]");
  });

  it("never claims SU53 shows only the last failed check anywhere in the fixed strings this module emits", () => {
    // Static-text guard: renderFailedAuthChecks + its own module doc must not
    // regress into the issue's original (wrong) "last check only" framing.
    const text = renderFailedAuthChecks([su53Row(), su53Row()] as never);
    expect(text.toLowerCase()).not.toContain("last failed check");
    expect(text.toLowerCase()).not.toContain("only shows the last");
  });

  it("omits empty parts gracefully: no dangling 'rc=', no 'at  line ' with blanks", () => {
    const sparse = {
      origin: "trace" as const,
      object: "",
      rc: "",
      reason: "",
      fields: "",
      program: "",
      line: "",
      tcode: "",
      timestamp: "20260915083842",
    };
    const text = renderFailedAuthChecks([sparse]);
    const line = text.split("\n")[1];
    expect(line).toBe("[trace]");
    expect(line).not.toContain("rc=");
    expect(line).not.toContain("at ");
  });

  it("renders 'at <program>' with no line when only program is present", () => {
    const text = renderFailedAuthChecks([traceRow({ line: "" }) as never]);
    expect(text).toContain("at ZCL_FOO=>METHOD_BAR [trace]");
    expect(text).not.toContain("line");
  });

  it("renders 'at line <n>' with no program when only line is present", () => {
    const text = renderFailedAuthChecks([traceRow({ program: "" }) as never]);
    expect(text).toContain("at line 42 [trace]");
  });

  it("returns an empty string (no header) when there are no checks", () => {
    expect(renderFailedAuthChecks([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// authTraceOn / authTraceOff / authTraceStatus: thin dispatch mapping
// ---------------------------------------------------------------------------

describe("authTraceOn / authTraceOff / authTraceStatus", () => {
  it("authTraceOn defaults errors_only to true and maps the single output row", async () => {
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValueOnce(
      dispatchResult([{ active: true, for_user: "DEVELOPER", errors_only: true }]),
    );

    const on = await authTraceOn(DEPS, "DEVELOPER");
    expect(on).toEqual({ active: true, forUser: "DEVELOPER", errorsOnly: true, timestamp: "" });

    const args = dispatchMock.mock.calls[0]?.[1] as { args: Record<string, unknown> };
    expect(args.args["errors_only"]).toBe(true);
  });

  it("authTraceOn maps the server's EV_TIMESTAMP when the row includes one", async () => {
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValueOnce(
      dispatchResult([
        { active: true, for_user: "DEVELOPER", errors_only: true, timestamp: "20260915083842" },
      ]),
    );

    const on = await authTraceOn(DEPS, "DEVELOPER");
    expect(on.timestamp).toBe("20260915083842");
  });

  it("authTraceOn trims a stray trailing space off EV_TIMESTAMP (live A4H bug: CONV string() on the numeric ABAP timestamp field renders a trailing blank)", async () => {
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValueOnce(
      dispatchResult([
        { active: true, for_user: "DEVELOPER", errors_only: true, timestamp: "20260915100737 " },
      ]),
    );

    const on = await authTraceOn(DEPS, "DEVELOPER");
    expect(on.timestamp).toBe("20260915100737");
    expect(on.timestamp).toHaveLength(14);
  });

  it("authTraceOff maps the single output row", async () => {
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValueOnce(dispatchResult([{ active: false }]));
    const off = await authTraceOff(DEPS);
    expect(off).toEqual({ active: false });
  });

  it("authTraceStatus maps the single output row", async () => {
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValueOnce(
      dispatchResult([{ active: false, any_active: false, for_user: "", errors_only: false }]),
    );
    const status = await authTraceStatus(DEPS);
    expect(status).toEqual({ active: false, anyActive: false, forUser: "", errorsOnly: false });
  });
});

// ---------------------------------------------------------------------------
// withAuthTrace: switch-off-on-every-path safety net
// ---------------------------------------------------------------------------

describe("withAuthTrace", () => {
  it("switches ON then OFF on a normal successful run, and returns fn's value plus the failed checks", async () => {
    dispatchMock.mockReset();
    dispatchMock
      .mockResolvedValueOnce(dispatchResult([{ active: true, for_user: "DEVELOPER", errors_only: true }])) // on
      .mockResolvedValueOnce(dispatchResult([traceRow()])) // read — read-back happens before switch-off
      .mockResolvedValueOnce(dispatchResult([{ active: false }])); // off

    const fn = vi.fn().mockResolvedValue("fn-result");
    const outcome = await withAuthTrace(DEPS, "DEVELOPER", fn);

    expect(outcome.value).toBe("fn-result");
    expect(outcome.authTrace.ok).toBe(true);
    if (outcome.authTrace.ok) {
      expect(outcome.authTrace.checks).toHaveLength(1);
      expect(outcome.authTrace.usedFallback).toBe(false);
    }
    expect(outcome.switchOffError).toBeUndefined();

    // on, read, off — the read-back happens before the unconditional switch-off.
    expect(dispatchMock).toHaveBeenCalledTimes(3);
    const readCall = dispatchMock.mock.calls[1]?.[1] as { action: string };
    expect(readCall.action).toBe("read");
    const offCall = dispatchMock.mock.calls[2]?.[1] as { action: string };
    expect(offCall.action).toBe("off");
  });

  it("uses the server's own EV_TIMESTAMP from the on action as the read-back window's 'from', not a host-clock timestamp", async () => {
    dispatchMock.mockReset();
    dispatchMock
      .mockResolvedValueOnce(
        dispatchResult([
          { active: true, for_user: "DEVELOPER", errors_only: true, timestamp: "20250101000000" },
        ]),
      ) // on
      .mockResolvedValueOnce(dispatchResult([])) // read — no rows, falls back to su53
      .mockResolvedValueOnce(dispatchResult([su53Row()])) // su53
      .mockResolvedValueOnce(dispatchResult([{ active: false }])); // off

    const fn = vi.fn().mockResolvedValue("fn-result");
    await withAuthTrace(DEPS, "DEVELOPER", fn);

    const readArgs = dispatchMock.mock.calls[1]?.[1] as { args: Record<string, unknown> };
    expect(readArgs.args["from"]).toBe("20250101000000");
    const su53Args = dispatchMock.mock.calls[2]?.[1] as { args: Record<string, unknown> };
    expect(su53Args.args["from"]).toBe("20250101000000");
  });

  it("regression (live A4H bug): a trailing space on on's EV_TIMESTAMP does not kill the read-back — the value reaching 'from' is trimmed to exactly 14 characters and the read-back is actually attempted", async () => {
    dispatchMock.mockReset();
    dispatchMock
      .mockResolvedValueOnce(
        dispatchResult([
          { active: true, for_user: "DEVELOPER", errors_only: true, timestamp: "20260915100737 " },
        ]),
      ) // on — timestamp has the stray trailing blank observed live
      .mockResolvedValueOnce(dispatchResult([traceRow()])) // read — must actually be reached and succeed
      .mockResolvedValueOnce(dispatchResult([{ active: false }])); // off

    const fn = vi.fn().mockResolvedValue("fn-result");
    const outcome = await withAuthTrace(DEPS, "DEVELOPER", fn);

    // The read-back was attempted and succeeded, not skipped or rejected as
    // BAD_INPUT by a 15-character "from" (the live failure mode this
    // regression test guards against).
    expect(outcome.authTrace.ok).toBe(true);
    expect(dispatchMock).toHaveBeenCalledTimes(3);

    const readCall = dispatchMock.mock.calls[1]?.[1] as { action: string; args: Record<string, unknown> };
    expect(readCall.action).toBe("read");
    expect(readCall.args["from"]).toBe("20260915100737");
    expect((readCall.args["from"] as string)).toHaveLength(14);
  });

  it("switches OFF even when fn throws an AbapError, and rethrows that exact error", async () => {
    dispatchMock.mockReset();
    dispatchMock
      .mockResolvedValueOnce(dispatchResult([{ active: true, for_user: "DEVELOPER", errors_only: true }])) // on
      .mockResolvedValueOnce(dispatchResult([traceRow()])) // read
      .mockResolvedValueOnce(dispatchResult([{ active: false }])); // off

    const thrown = new AbapError("BAD_INPUT", "boom");
    const fn = vi.fn().mockRejectedValue(thrown);

    await expect(withAuthTrace(DEPS, "DEVELOPER", fn)).rejects.toBe(thrown);

    expect(dispatchMock).toHaveBeenCalledTimes(3);
    const offCall = dispatchMock.mock.calls[2]?.[1] as { action: string };
    expect(offCall.action).toBe("off");
  });

  it("switches OFF even when fn throws a non-Error value", async () => {
    dispatchMock.mockReset();
    dispatchMock
      .mockResolvedValueOnce(dispatchResult([{ active: true, for_user: "DEVELOPER", errors_only: true }])) // on
      .mockResolvedValueOnce(dispatchResult([traceRow()])) // read
      .mockResolvedValueOnce(dispatchResult([{ active: false }])); // off

    const fn = vi.fn().mockRejectedValue("just a string");

    await expect(withAuthTrace(DEPS, "DEVELOPER", fn)).rejects.toBe("just a string");

    expect(dispatchMock).toHaveBeenCalledTimes(3);
    const offCall = dispatchMock.mock.calls[2]?.[1] as { action: string };
    expect(offCall.action).toBe("off");
  });

  it("switches OFF even when fn throws a dump-shaped error", async () => {
    dispatchMock.mockReset();
    dispatchMock
      .mockResolvedValueOnce(dispatchResult([{ active: true, for_user: "DEVELOPER", errors_only: true }])) // on
      .mockResolvedValueOnce(dispatchResult([traceRow()])) // read
      .mockResolvedValueOnce(dispatchResult([{ active: false }])); // off

    const dumpError = new AbapError("RUNTIME_DUMP", "dumped", { dumpId: "ABCD1234" });
    const fn = vi.fn().mockRejectedValue(dumpError);

    await expect(withAuthTrace(DEPS, "DEVELOPER", fn)).rejects.toBe(dumpError);

    expect(dispatchMock).toHaveBeenCalledTimes(3);
    const offCall = dispatchMock.mock.calls[2]?.[1] as { action: string };
    expect(offCall.action).toBe("off");
  });

  it("switches OFF even when fn fails because the session is dead", async () => {
    dispatchMock.mockReset();
    dispatchMock
      .mockResolvedValueOnce(dispatchResult([{ active: true, for_user: "DEVELOPER", errors_only: true }])) // on
      .mockResolvedValueOnce(dispatchResult([traceRow()])) // read
      .mockResolvedValueOnce(dispatchResult([{ active: false }])); // off

    const deadError = new AbapError("SESSION_DEAD", "connection is dead");
    const fn = vi.fn().mockRejectedValue(deadError);

    await expect(withAuthTrace(DEPS, "DEVELOPER", fn)).rejects.toBe(deadError);

    expect(dispatchMock).toHaveBeenCalledTimes(3);
    const offCall = dispatchMock.mock.calls[2]?.[1] as { action: string };
    expect(offCall.action).toBe("off");
  });

  it("reads back failed checks even when fn throws, switches off exactly once, and the checks are retrievable from the thrown error", async () => {
    dispatchMock.mockReset();
    dispatchMock
      .mockResolvedValueOnce(dispatchResult([{ active: true, for_user: "DEVELOPER", errors_only: true }])) // on
      .mockResolvedValueOnce(dispatchResult([traceRow({ object: "S_TABU_NAM" })])) // read — captured before the throw
      .mockResolvedValueOnce(dispatchResult([{ active: false }])); // off

    const original = new AbapError("BAD_INPUT", "missing authorization somewhere");
    const fn = vi.fn().mockRejectedValue(original);

    let caught: unknown;
    try {
      await withAuthTrace(DEPS, "DEVELOPER", fn);
      throw new Error("expected withAuthTrace to reject");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(original);

    const offCalls = dispatchMock.mock.calls.filter((c) => (c[1] as { action: string }).action === "off");
    expect(offCalls).toHaveLength(1);

    const outcome = authTraceOf(caught);
    expect(outcome).toBeDefined();
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) {
      expect(outcome.checks).toHaveLength(1);
      expect(outcome.checks[0]?.object).toBe("S_TABU_NAM");
      expect(outcome.usedFallback).toBe(false);
    }
  });

  it("when switching ON fails, still runs fn and reports authTrace as unavailable, without ever calling read or off", async () => {
    dispatchMock.mockReset();
    dispatchMock.mockRejectedValueOnce(new AbapError("FLUID_ACTION_FAILED", "on failed")); // on

    const fn = vi.fn().mockResolvedValue("ran-anyway");
    const outcome = await withAuthTrace(DEPS, "DEVELOPER", fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(outcome.value).toBe("ran-anyway");
    expect(outcome.authTrace.ok).toBe(false);
    if (!outcome.authTrace.ok) {
      expect(outcome.authTrace.reason).toContain("unavailable");
    }
    // only the failed "on" call — no read, no "off" was ever attempted
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("when the read-back itself fails, reports authTrace as unavailable but does not mask fn's result, and still switches off", async () => {
    dispatchMock.mockReset();
    dispatchMock
      .mockResolvedValueOnce(dispatchResult([{ active: true, for_user: "DEVELOPER", errors_only: true }])) // on
      .mockRejectedValueOnce(new AbapError("FLUID_ACTION_FAILED", "read failed")) // read
      .mockResolvedValueOnce(dispatchResult([{ active: false }])); // off

    const fn = vi.fn().mockResolvedValue("still-fine");
    const outcome = await withAuthTrace(DEPS, "DEVELOPER", fn);

    expect(outcome.value).toBe("still-fine");
    expect(outcome.authTrace.ok).toBe(false);
    if (!outcome.authTrace.ok) {
      expect(outcome.authTrace.reason).toContain("unavailable");
    }
    const offCalls = dispatchMock.mock.calls.filter((c) => (c[1] as { action: string }).action === "off");
    expect(offCalls).toHaveLength(1);
  });

  it("when switch-OFF itself throws after a successful fn, does not mask fn's result and records the failure", async () => {
    dispatchMock.mockReset();
    dispatchMock
      .mockResolvedValueOnce(dispatchResult([{ active: true, for_user: "DEVELOPER", errors_only: true }])) // on
      .mockResolvedValueOnce(dispatchResult([traceRow()])) // read
      .mockRejectedValueOnce(new AbapError("FLUID_ACTION_FAILED", "off failed")); // off

    const fn = vi.fn().mockResolvedValue("still-fine");
    const outcome = await withAuthTrace(DEPS, "DEVELOPER", fn);

    expect(outcome.value).toBe("still-fine");
    expect(outcome.switchOffError).toContain("off failed");
  });

  it("when switch-OFF itself throws after fn threw, does not mask fn's original thrown error", async () => {
    dispatchMock.mockReset();
    dispatchMock
      .mockResolvedValueOnce(dispatchResult([{ active: true, for_user: "DEVELOPER", errors_only: true }])) // on
      .mockResolvedValueOnce(dispatchResult([traceRow()])) // read
      .mockRejectedValueOnce(new AbapError("FLUID_ACTION_FAILED", "off failed too")); // off

    const original = new AbapError("BAD_INPUT", "the real failure");
    const fn = vi.fn().mockRejectedValue(original);

    let caught: unknown;
    try {
      await withAuthTrace(DEPS, "DEVELOPER", fn);
      throw new Error("expected withAuthTrace to reject");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(original);
    expect((caught as AbapError).message).toBe("the real failure");
    expect(switchOffErrorOf(caught)).toContain("off failed too");
    // the read-back outcome is still attached even though switch-off also failed
    expect(authTraceOf(caught)?.ok).toBe(true);
  });
});
