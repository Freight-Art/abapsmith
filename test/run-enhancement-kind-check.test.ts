/**
 * `abapRun` (src/tools/run.ts) used to call `gate.authorize("execute", {...obj})`
 * immediately after `resolveObject`, BEFORE the `mode:"auto"`
 * CLAS/PROG-or-UNSUPPORTED kind check. `abapRun` is reachable with any
 * resolvable object name, including an enhancement type (a caller can
 * legally ask to "run" an ENHO/XH or ENHS/XS name) — so that object would
 * reach the gate with no `intent`, hit the intent-based gate's "supply
 * `affects`" refusal
 * (a parameter `abap_run` has no concept of and never reads), and never get
 * the tool's own, correct, purpose-built "not executable ... only classes
 * ... and reports ... can be run" refusal, which was shadowed dead code for
 * this input shape.
 *
 * The fix reorders: the kind check (and the explicit-mode-disagreement
 * BAD_INPUT checks) now run BEFORE `gate.authorize`. By the time the gate
 * call is reached, `obj.kind` is proven to be exactly "CLAS" or "PROG" —
 * every other kind already threw above — so an enhancement type can
 * structurally never reach the gate call at all. This file proves that
 * directly: `resolveObject` is stubbed (same pattern as
 * test/open-url.test.ts and test/read-search.test.ts) to resolve to an
 * ENHO/XH object, and the gate handed to `abapRun` is a "poison" gate whose
 * `authorize`/`assert` throw if called — so a passing test is only possible
 * if the gate is never consulted at all, not merely that it would have
 * refused correctly.
 *
 * No test file in this repository previously called `abapRun` at all
 * (confirmed by grepping test/ for "abapRun(" before adding this file) —
 * test/run.test.ts only exercises `runClass`/`runReport`/etc. from
 * src/adt/run.ts directly. This file is narrowly scoped to the ordering fix,
 * not a general `abapRun` test suite.
 */
import { describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import type { SafetyGate } from "../src/safety.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";

const stub = { object: {} as ResolvedObject };

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => stub.object,
}));

const { abapRun } = await import("../src/tools/run.js");

function resolved(over: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    system: "A4H",
    type: "ENHO/XH",
    kind: "ENHO",
    label: "BAdI implementation",
    name: "ZENH_BADI_RUN",
    uri: "/sap/bc/adt/enhancements/enhoxhh/zenh_badi_run",
    packageName: "$TMP",
    mode: "source",
    activation: "unknown",
    spec: {},
    ...over,
  } as unknown as ResolvedObject;
}

/** Throws if `authorize` or `assert` is ever called — proof the gate was never consulted. */
function poisonGate(): SafetyGate {
  return {
    authorize: () => {
      throw new Error("poisonGate.authorize() was called — the enhancement object reached the gate");
    },
    assert: () => {
      throw new Error("poisonGate.assert() was called — the enhancement object reached the gate");
    },
  } as unknown as SafetyGate;
}

const conn = {} as AbapConnection;

describe("abapRun: the kind check runs BEFORE the gate call, so an enhancement-type target never reaches it", () => {
  it("mode=auto: an ENHO/XH object is refused UNSUPPORTED with the 'not executable' wording, and the gate is never consulted", async () => {
    stub.object = resolved({ type: "ENHO/XH", kind: "ENHO" });
    const err = await abapRun(conn, { object: "ZENH_BADI_RUN" }, 50_000, poisonGate()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isAbapError(err)).toBe(true);
    const e = err as AbapError;
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.message).toMatch(/not executable/);
    expect(e.message).not.toMatch(/supply `affects`/);
    expect(e.message).not.toMatch(/SAFETY_DENIED/);
  });

  it("mode=auto: an ENHS/XS object gets the same treatment (not just ENHO/XH)", async () => {
    stub.object = resolved({ type: "ENHS/XS", kind: "ENHS", name: "ZENH_SPOT_RUN" });
    const err = await abapRun(conn, { object: "ZENH_SPOT_RUN" }, 50_000, poisonGate()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isAbapError(err)).toBe(true);
    expect((err as AbapError).code).toBe("UNSUPPORTED");
  });

  it("mode=\"class\" explicitly requested against an ENHO/XH object is BAD_INPUT, not a gate refusal — also short-circuits before the gate", async () => {
    stub.object = resolved({ type: "ENHO/XH", kind: "ENHO" });
    const err = await abapRun(conn, { object: "ZENH_BADI_RUN", mode: "class" }, 50_000, poisonGate()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isAbapError(err)).toBe(true);
    expect((err as AbapError).code).toBe("BAD_INPUT");
  });

  it("control: a genuine CLAS object still reaches the gate (poisonGate now correctly throws, proving the gate IS consulted for the legitimate case)", async () => {
    stub.object = resolved({ type: "CLAS/OC", kind: "CLAS", name: "ZCL_RUNNABLE" });
    await expect(abapRun(conn, { object: "ZCL_RUNNABLE" }, 50_000, poisonGate())).rejects.toThrow(
      /poisonGate\.authorize\(\) was called/,
    );
  });
});
