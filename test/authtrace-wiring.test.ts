/**
 * Issue #112 — wiring `auth_trace` into the three executing tools
 * (`abap_run`, `abap_test`, `abap_bopf_test`). `src/adt/authtrace.ts` itself
 * is unit-tested in `test/authtrace.test.ts` and is not re-tested here; this
 * file only proves the tool layer wires it correctly: the header/section/
 * notes rendering, the read-only refusal, and — the single most important
 * property — that the trace is switched OFF on every path, including a
 * throw from the wrapped run.
 *
 * Same fake-dispatch idiom as `test/authtrace.test.ts`: `dispatch()`
 * (`src/adt/fluid/dispatch.js`) is mocked so `withAuthTrace`'s real logic
 * runs, but nothing here ever touches a live ABAP system. The actual
 * execution engines each tool wraps (`resolveObject`/`checkActivation`/
 * `runClass` for `abap_run`; `resolveObject`/`parseRunResult` for
 * `abap_test`; the BOPF bridge runner for `abap_bopf_test`) are stubbed the
 * same way `test/impacted-test-tool.test.ts` stubs `resolveObject` and
 * `test/bopf-test-scenario-keys.test.ts` stubs `BopfTestDeps` — by name, not
 * by simulating a wire protocol.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import type { RunResult } from "../src/adt/run.js";
import type { AunitRunResult } from "../src/adt/aunit.js";
import type { BopfTestResult } from "../src/adt/bopf-runtime.js";
import type { BoModel } from "../src/adt/bopf-types.js";
import type { SessionPool } from "../src/adt/pool.js";
import type { BopfTestDeps } from "../src/tools/bopf-test.js";
import { SafetyGate } from "../src/safety.js";
import { isAbapError, AbapError } from "../src/adt/errors.js";
import { FLUID_PACKAGE } from "../src/adt/fluid/package.js";

// ---------------------------------------------------------------------------
// Mocks — same idiom as test/authtrace.test.ts (dispatch) plus
// test/impacted-test-tool.test.ts (resolveObject-by-name).
// ---------------------------------------------------------------------------

const dispatchMock = vi.fn();
vi.mock("../src/adt/fluid/dispatch.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/fluid/dispatch.js")>()),
  dispatch: (...args: unknown[]) => dispatchMock(...args),
}));

const resolveObjectMock = vi.fn();
const checkActivationMock = vi.fn();
vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: (...args: unknown[]) => resolveObjectMock(...args),
  checkActivation: (...args: unknown[]) => checkActivationMock(...args),
}));

const runClassMock = vi.fn();
vi.mock("../src/adt/run.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/run.js")>()),
  runClass: (...args: unknown[]) => runClassMock(...args),
}));

const parseRunResultMock = vi.fn();
vi.mock("../src/adt/aunit.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/aunit.js")>()),
  parseRunResult: (...args: unknown[]) => parseRunResultMock(...args),
}));

const runBopfTestBridgeMock = vi.fn();
vi.mock("../src/adt/bopf-runtime.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/bopf-runtime.js")>()),
  runBopfTest: (...args: unknown[]) => runBopfTestBridgeMock(...args),
}));

const { abapRun } = await import("../src/tools/run.js");
const { abapTest } = await import("../src/tools/test.js");
const { runBopfTest } = await import("../src/tools/bopf-test.js");
const { AUNIT_TESTRUNS_URL } = await import("../src/adt/aunit.js");

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function gate(readOnly = false): SafetyGate {
  return new SafetyGate({ readOnly, allowPackages: ["$TMP"] });
}

function resolvedObj(overrides: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    system: "A4H",
    type: "CLAS/OC",
    kind: "CLAS",
    label: "Class",
    name: "ZCL_PROBE",
    uri: "/sap/bc/adt/oo/classes/zcl_probe",
    packageName: "$TMP",
    mode: "source",
    ...overrides,
  } as unknown as ResolvedObject;
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

function dispatchResult(result: unknown): { result: unknown } {
  return { result };
}

/** on -> read(rows) -> off : a run whose kernel trace found `count` failed check(s). */
function scriptChecksFound(count: number): void {
  const rows = Array.from({ length: count }, (_, i) => traceRow({ object: `S_TABU_NAM_${i}` }));
  dispatchMock
    .mockResolvedValueOnce(dispatchResult([{ active: true, for_user: "DEVELOPER", errors_only: true }])) // on
    .mockResolvedValueOnce(dispatchResult(rows)) // read
    .mockResolvedValueOnce(dispatchResult([{ active: false }])); // off
}

/** on -> read([]) -> su53([]) -> off : a genuinely clean run (SU53 buffer empty too). */
function scriptClean(): void {
  dispatchMock
    .mockResolvedValueOnce(dispatchResult([{ active: true, for_user: "DEVELOPER", errors_only: true }])) // on
    .mockResolvedValueOnce(dispatchResult([])) // read
    .mockResolvedValueOnce(dispatchResult([])) // su53
    .mockResolvedValueOnce(dispatchResult([{ active: false }])); // off
}

/** on fails outright: fn still runs, outcome is `{ok:false}`, no read/off ever attempted. */
function scriptSwitchOnFails(): void {
  dispatchMock.mockRejectedValueOnce(new AbapError("FLUID_ACTION_FAILED", "on failed"));
}

function offCallCount(): number {
  return dispatchMock.mock.calls.filter((c) => (c[1] as { action: string }).action === "off").length;
}

beforeEach(() => {
  dispatchMock.mockReset();
  resolveObjectMock.mockReset().mockResolvedValue(resolvedObj());
  checkActivationMock.mockReset().mockResolvedValue("active-is-current");
  runClassMock.mockReset();
  parseRunResultMock.mockReset();
  runBopfTestBridgeMock.mockReset();
});

const RUN_CONN = { cfg: { user: "DEVELOPER", sid: "A4H" } } as unknown as AbapConnection;

const RUN_RESULT_OK: RunResult = {
  mode: "class",
  object: "ZCL_PROBE",
  output: "hello from probe",
  lines: 1,
  durationMs: 12,
  droppedLines: 0,
  bodyBytes: 42,
  outputComplete: true,
};

// ---------------------------------------------------------------------------
// abap_run
// ---------------------------------------------------------------------------

describe("abap_run: auth_trace wiring", () => {
  it("absent -> no trace call at all, response unchanged", async () => {
    runClassMock.mockResolvedValueOnce(RUN_RESULT_OK);
    const res = await abapRun(RUN_CONN, { object: "ZCL_PROBE" }, 20000, gate());
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(res.text).not.toContain("auth_trace");
    expect(res.text).not.toContain("FAILED AUTH CHECKS");
  });

  it("true, clean trace -> header says no failed checks, no section", async () => {
    scriptClean();
    runClassMock.mockResolvedValueOnce(RUN_RESULT_OK);
    const res = await abapRun(RUN_CONN, { object: "ZCL_PROBE", auth_trace: true }, 20000, gate());
    expect(res.text).toContain("auth_trace: no failed checks");
    expect(res.text).not.toContain("FAILED AUTH CHECKS");
    expect(offCallCount()).toBe(1);
  });

  it("true, checks found -> section rendered, header states count", async () => {
    scriptChecksFound(2);
    runClassMock.mockResolvedValueOnce(RUN_RESULT_OK);
    const res = await abapRun(RUN_CONN, { object: "ZCL_PROBE", auth_trace: true }, 20000, gate());
    expect(res.text).toContain("auth_trace: 2 failed check(s)");
    expect(res.text).toContain("--- FAILED AUTH CHECKS ---");
    expect(res.text).toContain("S_TABU_NAM_0");
    expect(res.text).toContain("S_TABU_NAM_1");
    expect(offCallCount()).toBe(1);
  });

  it("true, switch-on fails -> run still happens, header says unavailable with reason", async () => {
    scriptSwitchOnFails();
    runClassMock.mockResolvedValueOnce(RUN_RESULT_OK);
    const res = await abapRun(RUN_CONN, { object: "ZCL_PROBE", auth_trace: true }, 20000, gate());
    expect(runClassMock).toHaveBeenCalledTimes(1);
    expect(res.text).toMatch(/auth_trace: unavailable: /);
    // on failed outright — read/off were never attempted, per withAuthTrace's own contract.
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("true, run THROWS -> trace still switched off, error still propagates", async () => {
    scriptChecksFound(1);
    const boom = new AbapError("ADT_ERROR", "classrun blew up");
    runClassMock.mockRejectedValueOnce(boom);
    await expect(
      abapRun(RUN_CONN, { object: "ZCL_PROBE", auth_trace: true }, 20000, gate()),
    ).rejects.toBe(boom);
    // The single most important assertion: switched off even though the run threw.
    expect(offCallCount()).toBe(1);
    expect(isAbapError(boom)).toBe(true);
    if (isAbapError(boom)) {
      expect(boom.details["failedAuthChecks"]).toBeDefined();
    }
  });

  it("true in read mode -> refused, run never happened", async () => {
    await expect(
      abapRun(RUN_CONN, { object: "ZCL_PROBE", auth_trace: true }, 20000, gate(true)),
    ).rejects.toMatchObject({ code: "SAFETY_DENIED" });
    expect(resolveObjectMock).not.toHaveBeenCalled();
    expect(runClassMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// abap_test
// ---------------------------------------------------------------------------

function testConn(post: (...args: unknown[]) => Promise<{ status: number; body: string }>): AbapConnection {
  return { cfg: { user: "DEVELOPER", sid: "A4H" }, post } as unknown as AbapConnection;
}

const AUNIT_OK: AunitRunResult = {
  outcome: "passed",
  programs: [],
  otherAlerts: [],
  total: 3,
  passed: 3,
  failed: 0,
  unknown: 0,
};

describe("abap_test: auth_trace wiring", () => {
  const postOk = async () => ({ status: 200, body: "<run/>" });

  it("absent -> no trace call at all, response unchanged", async () => {
    parseRunResultMock.mockReturnValueOnce(AUNIT_OK);
    const res = await abapTest(testConn(postOk), { object: "ZCL_PROBE" }, 20000, gate());
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(res.text).not.toContain("auth_trace");
    expect(res.text).not.toContain("FAILED AUTH CHECKS");
  });

  it("true, clean trace -> header says no failed checks, no section", async () => {
    scriptClean();
    parseRunResultMock.mockReturnValueOnce(AUNIT_OK);
    const res = await abapTest(testConn(postOk), { object: "ZCL_PROBE", auth_trace: true }, 20000, gate());
    expect(res.text).toContain("auth_trace: no failed checks");
    expect(res.text).not.toContain("FAILED AUTH CHECKS");
    expect(offCallCount()).toBe(1);
  });

  it("true, checks found -> section rendered, header states count", async () => {
    scriptChecksFound(3);
    parseRunResultMock.mockReturnValueOnce(AUNIT_OK);
    const res = await abapTest(testConn(postOk), { object: "ZCL_PROBE", auth_trace: true }, 20000, gate());
    expect(res.text).toContain("auth_trace: 3 failed check(s)");
    expect(res.text).toContain("--- FAILED AUTH CHECKS ---");
    expect(offCallCount()).toBe(1);
  });

  it("true, switch-on fails -> run still happens, header says unavailable with reason", async () => {
    scriptSwitchOnFails();
    parseRunResultMock.mockReturnValueOnce(AUNIT_OK);
    const postSpy = vi.fn(postOk);
    const res = await abapTest(testConn(postSpy), { object: "ZCL_PROBE", auth_trace: true }, 20000, gate());
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(res.text).toMatch(/auth_trace: unavailable: /);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("true, run THROWS -> trace still switched off, error still propagates", async () => {
    scriptChecksFound(1);
    const boom = new AbapError("ADT_ERROR", "AUnit run answered HTTP 500");
    const postThrows = async () => {
      throw boom;
    };
    await expect(
      abapTest(testConn(postThrows), { object: "ZCL_PROBE", auth_trace: true }, 20000, gate()),
    ).rejects.toBe(boom);
    expect(offCallCount()).toBe(1);
    expect(boom.details["failedAuthChecks"]).toBeDefined();
  });

  it("true in read mode -> refused, run never happened", async () => {
    const postSpy = vi.fn(postOk);
    await expect(
      abapTest(testConn(postSpy), { object: "ZCL_PROBE", auth_trace: true }, 20000, gate(true)),
    ).rejects.toMatchObject({ code: "SAFETY_DENIED" });
    expect(resolveObjectMock).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("scope=\"impacted\" refuses auth_trace before any request", async () => {
    const postSpy = vi.fn(postOk);
    await expect(
      abapTest(
        testConn(postSpy),
        { scope: "impacted", changed: ["ZCL_PROBE"], auth_trace: true },
        20000,
        gate(),
      ),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(postSpy).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// abap_bopf_test
// ---------------------------------------------------------------------------

const BO_MODEL: BoModel = {
  name: "ZBOPF_ORDER",
  type: "BOBF",
  version: "active",
  nodes: [],
};

const BOPF_RESULT_OK: BopfTestResult = {
  bo: "ZBOPF_ORDER",
  bridgeClass: "ZMCP_BOPF_TEST_BRIDGE",
  bridgeRefreshed: false,
  constantsInterface: "ZIF_BOPF_ORDER_C",
  durationMs: 10,
  generateOnly: false,
  rejected: false,
  errors: 0,
  warnings: 0,
  rowsWritten: 1,
};

const ROOT_ROW = { node: "ROOT", fields: { ORDER_ID: "MCP0001" } };

/** `runBopfTest`'s preflight writes the generated test bridge into FLUID_PACKAGE, not $TMP. */
function bopfGate(readOnly = false): SafetyGate {
  return new SafetyGate({ readOnly, allowPackages: ["$TMP", FLUID_PACKAGE] });
}

function bopfDeps(overrides: Partial<BopfTestDeps> = {}): BopfTestDeps {
  const conn = { cfg: { user: "DEVELOPER", sid: "A4H" } } as unknown as AbapConnection;
  return {
    pool: {
      withWrite: async (_tool: string, _key: string, cb: (conn: AbapConnection) => Promise<unknown>) => cb(conn),
      withRead: () => {
        throw new Error("unexpected pool.withRead call");
      },
      reserveDebug: () => {
        throw new Error("unexpected pool.reserveDebug call");
      },
    } as unknown as SessionPool,
    safety: bopfGate(),
    ensureConnected: async () => {},
    errorResult: (e) => {
      throw e;
    },
    cfg: { maxResponseChars: 20000 },
    readModel: async () => BO_MODEL,
    ...overrides,
  };
}

function bopfArgs(overrides: Record<string, unknown> = {}): unknown {
  return { bo: "ZBOPF_ORDER", scenario: { nodes: [ROOT_ROW] }, ...overrides };
}

describe("abap_bopf_test: auth_trace wiring", () => {
  it("absent -> no trace call at all, response unchanged", async () => {
    runBopfTestBridgeMock.mockResolvedValueOnce(BOPF_RESULT_OK);
    const result = await runBopfTest(bopfDeps(), bopfArgs());
    const text = (result.content[0] as { text: string }).text;
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(text).not.toContain("auth_trace");
    expect(text).not.toContain("FAILED AUTH CHECKS");
  });

  it("true, clean trace -> header says no failed checks, no section", async () => {
    scriptClean();
    runBopfTestBridgeMock.mockResolvedValueOnce(BOPF_RESULT_OK);
    const result = await runBopfTest(bopfDeps(), bopfArgs({ auth_trace: true }));
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("auth_trace: no failed checks");
    expect(text).not.toContain("FAILED AUTH CHECKS");
    expect(offCallCount()).toBe(1);
  });

  it("true, checks found -> section rendered, header states count", async () => {
    scriptChecksFound(2);
    runBopfTestBridgeMock.mockResolvedValueOnce(BOPF_RESULT_OK);
    const result = await runBopfTest(bopfDeps(), bopfArgs({ auth_trace: true }));
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("auth_trace: 2 failed check(s)");
    expect(text).toContain("--- FAILED AUTH CHECKS ---");
    expect(offCallCount()).toBe(1);
  });

  it("true, switch-on fails -> run still happens, header says unavailable with reason", async () => {
    scriptSwitchOnFails();
    runBopfTestBridgeMock.mockResolvedValueOnce(BOPF_RESULT_OK);
    const result = await runBopfTest(bopfDeps(), bopfArgs({ auth_trace: true }));
    const text = (result.content[0] as { text: string }).text;
    expect(runBopfTestBridgeMock).toHaveBeenCalledTimes(1);
    expect(text).toMatch(/auth_trace: unavailable: /);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("true, run THROWS -> trace still switched off, error still propagates", async () => {
    scriptChecksFound(1);
    const boom = new AbapError("ADT_ERROR", "bridge run blew up");
    runBopfTestBridgeMock.mockRejectedValueOnce(boom);
    await expect(runBopfTest(bopfDeps(), bopfArgs({ auth_trace: true }))).rejects.toBe(boom);
    // The single most important assertion: switched off even though the run threw.
    expect(offCallCount()).toBe(1);
    expect(boom.details["failedAuthChecks"]).toBeDefined();
  });

  it("true in read mode -> refused, run never happened", async () => {
    await expect(
      runBopfTest(bopfDeps({ safety: gate(true) }), bopfArgs({ auth_trace: true })),
    ).rejects.toMatchObject({ code: "SAFETY_DENIED" });
    expect(runBopfTestBridgeMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: the trace is switched off on EVERY path, for every tool.
// ---------------------------------------------------------------------------

describe("auth_trace is switched off on every path (cross-tool guarantee)", () => {
  it("abap_run: off fires on success and on throw alike", async () => {
    scriptChecksFound(0);
    runClassMock.mockResolvedValueOnce(RUN_RESULT_OK);
    await abapRun(RUN_CONN, { object: "ZCL_PROBE", auth_trace: true }, 20000, gate());
    expect(offCallCount()).toBe(1);

    dispatchMock.mockReset();
    scriptChecksFound(0);
    runClassMock.mockRejectedValueOnce(new AbapError("ADT_ERROR", "boom"));
    await expect(
      abapRun(RUN_CONN, { object: "ZCL_PROBE", auth_trace: true }, 20000, gate()),
    ).rejects.toBeInstanceOf(AbapError);
    expect(offCallCount()).toBe(1);
  });

  it("abap_test: off fires on success and on throw alike", async () => {
    scriptChecksFound(0);
    parseRunResultMock.mockReturnValueOnce(AUNIT_OK);
    await abapTest(testConn(async () => ({ status: 200, body: "<run/>" })), { object: "ZCL_PROBE", auth_trace: true }, 20000, gate());
    expect(offCallCount()).toBe(1);

    dispatchMock.mockReset();
    scriptChecksFound(0);
    await expect(
      abapTest(
        testConn(async () => {
          throw new AbapError("ADT_ERROR", "boom");
        }),
        { object: "ZCL_PROBE", auth_trace: true },
        20000,
        gate(),
      ),
    ).rejects.toBeInstanceOf(AbapError);
    expect(offCallCount()).toBe(1);
  });

  it("abap_bopf_test: off fires on success and on throw alike", async () => {
    scriptChecksFound(0);
    runBopfTestBridgeMock.mockResolvedValueOnce(BOPF_RESULT_OK);
    await runBopfTest(bopfDeps(), bopfArgs({ auth_trace: true }));
    expect(offCallCount()).toBe(1);

    dispatchMock.mockReset();
    scriptChecksFound(0);
    runBopfTestBridgeMock.mockRejectedValueOnce(new AbapError("ADT_ERROR", "boom"));
    await expect(runBopfTest(bopfDeps(), bopfArgs({ auth_trace: true }))).rejects.toBeInstanceOf(AbapError);
    expect(offCallCount()).toBe(1);
  });
});
