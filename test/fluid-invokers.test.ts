/**
 * Pure unit tests for src/adt/fluid/invokers.ts, plus lease-discipline tests
 * for pruneInvokers driven by a fake FluidLease and a mocked
 * deleteOneFluidObject (../src/adt/fluid/delete.js) — no FakeAdtServer, no
 * network. Parser fixtures are generated from the real `invokerSource`
 * (src/adt/fluid/invoke.ts) rather than hand-written ABAP, same idiom as
 * test/fluid-invoke.test.ts's `baseArgs`, so a change to the emitted marker
 * lines breaks this test instead of silently breaking production parsing.
 */
import { describe, expect, it, vi } from "vitest";

import {
  canonicalArgsJson,
  invokerName,
  invokerSource,
  type InvokerSourceArgs,
} from "../src/adt/fluid/invoke.js";
import { AbapError } from "../src/adt/errors.js";
import { SafetyGate } from "../src/safety.js";
import type { FluidLease } from "../src/adt/fluid/retired.js";
import type { FluidInvokerProbe, FluidInvokerPrune } from "../src/adt/fluid/invokers.js";

const VERSION = "deadbeef";
const CONTRACT = "1.0";
const TOOL_ID = "demo_tool";
const ACTION = "run_it";
const ARGS = { b: 2, a: 1 };

function baseArgs(overrides: Partial<InvokerSourceArgs> = {}): InvokerSourceArgs {
  const toolId = overrides.toolId ?? TOOL_ID;
  const action = overrides.action ?? ACTION;
  const argsJson = overrides.argsJson ?? canonicalArgsJson(ARGS);
  const contract = overrides.contract ?? CONTRACT;
  const version = overrides.version ?? VERSION;
  const name = overrides.name ?? invokerName(toolId, action, argsJson, contract);
  return {
    entry: "ZCL_DEMO_ENTRY",
    toolId,
    action,
    argsJson,
    version,
    contract,
    commit: false,
    ...overrides,
    name,
  };
}

const deleteMock = vi.fn();

vi.mock("../src/adt/fluid/delete.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/fluid/delete.js")>()),
  deleteOneFluidObject: (...args: unknown[]) => deleteMock(...args),
}));

const { INVOKER_NAME_RE, parseInvokerProvenance, staleInvokers, pruneInvokers } = await import(
  "../src/adt/fluid/invokers.js"
);

// --- parser -----------------------------------------------------------------

describe("parseInvokerProvenance", () => {
  it("recovers toolId, action, version and contract from a real invokerSource output", () => {
    const source = invokerSource(baseArgs());
    expect(parseInvokerProvenance(source)).toEqual({
      toolId: TOOL_ID,
      action: ACTION,
      version: VERSION,
      contract: CONTRACT,
    });
  });

  it("round-trips a commit:true (mutate-category) invoker, whose source carries the extra COMMIT/ROLLBACK lines", () => {
    const source = invokerSource(baseArgs({ commit: true }));
    expect(source).toContain("COMMIT WORK AND WAIT");
    expect(source).toContain("ROLLBACK WORK");
    expect(parseInvokerProvenance(source)).toEqual({
      toolId: TOOL_ID,
      action: ACTION,
      version: VERSION,
      contract: CONTRACT,
    });
  });

  it("returns an empty object for a hand-edited, unparseable source, without throwing", () => {
    const source = "CLASS zcl_whatever DEFINITION.\nENDCLASS.\nCLASS zcl_whatever IMPLEMENTATION.\nENDCLASS.\n";
    let threw = false;
    let result: unknown;
    try {
      result = parseInvokerProvenance(source);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toEqual({});
  });

  it("returns an empty object for an empty source, without throwing", () => {
    expect(parseInvokerProvenance("")).toEqual({});
  });

  it("does not report a version when the attach line's version literal is not valid 8-hex, but still parses the other fields", () => {
    const source = invokerSource(baseArgs());
    // VERSION is lowercase hex; the parser's VERSION_RE requires lowercase,
    // so uppercasing just the quoted literal in the attach() call produces a
    // source whose version is present but not confidently parseable —
    // exactly the "half-parsed" case that must not leak through.
    const mutated = source.replace(`iv_ver = '${VERSION}'`, `iv_ver = '${VERSION.toUpperCase()}'`);
    expect(mutated).not.toBe(source);
    const provenance = parseInvokerProvenance(mutated);
    expect(provenance.version).toBeUndefined();
    expect(provenance.toolId).toBe(TOOL_ID);
    expect(provenance.action).toBe(ACTION);
    expect(provenance.contract).toBe(CONTRACT);
  });
});

// --- name pattern -------------------------------------------------------------

describe("INVOKER_NAME_RE", () => {
  it("matches a name produced by the real invokerName", () => {
    const name = invokerName(TOOL_ID, ACTION, ARGS, CONTRACT);
    expect(INVOKER_NAME_RE.test(name)).toBe(true);
  });

  it("rejects the fluid runtime class's own name", () => {
    expect(INVOKER_NAME_RE.test("ZCL_ZMCP_FLUID_RT")).toBe(false);
  });

  it("rejects a bare ZCL_ZMCP_I_ prefix with no suffix", () => {
    expect(INVOKER_NAME_RE.test("ZCL_ZMCP_I_")).toBe(false);
  });

  it("rejects a ZCL_ZMCP_I_ prefix with a too-short hex suffix", () => {
    expect(INVOKER_NAME_RE.test("ZCL_ZMCP_I_1234567")).toBe(false);
  });

  it("rejects a ZCL_ZMCP_I_ prefix with a non-hex suffix of the right length", () => {
    expect(INVOKER_NAME_RE.test("ZCL_ZMCP_I_ZZZZZZZZ")).toBe(false);
  });
});

// --- staleness ----------------------------------------------------------------

function probe(overrides: Partial<FluidInvokerProbe> = {}): FluidInvokerProbe {
  return { name: "ZCL_ZMCP_I_AAAAAAAA", toolId: "t1", action: "a", version: "11111111", ...overrides };
}

describe("staleInvokers", () => {
  it("selects an invoker whose parsed toolId matches and whose parsed version differs from current", () => {
    const p = probe({ toolId: "t1", version: "11111111" });
    expect(staleInvokers([p], "t1", "22222222").map((x) => x.name)).toEqual([p.name]);
  });

  it("does not select an invoker of a different tool", () => {
    const p = probe({ toolId: "other-tool", version: "11111111" });
    expect(staleInvokers([p], "t1", "22222222")).toEqual([]);
  });

  it("does not select an invoker with no parsed version", () => {
    const p = probe({ toolId: "t1", version: undefined });
    expect(staleInvokers([p], "t1", "22222222")).toEqual([]);
  });

  it("does not select an invoker that failed to probe (error set, no version)", () => {
    const p: FluidInvokerProbe = { name: "ZCL_ZMCP_I_BBBBBBBB", toolId: "t1", error: "boom" };
    expect(staleInvokers([p], "t1", "22222222")).toEqual([]);
  });

  it("does not select an invoker whose parsed version equals the current version", () => {
    const p = probe({ toolId: "t1", version: "22222222" });
    expect(staleInvokers([p], "t1", "22222222")).toEqual([]);
  });
});

// --- pruneInvokers: lease discipline -------------------------------------------

const gate = (): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"] });

function makeLease(): { lease: FluidLease; opNames: string[] } {
  const opNames: string[] = [];
  const fakeConn = {} as never;
  const lease: FluidLease = (async (op: string, fn: (conn: never) => unknown) => {
    opNames.push(op);
    return fn(fakeConn);
  }) as FluidLease;
  return { lease, opNames };
}

function invokers(n: number): FluidInvokerProbe[] {
  return Array.from({ length: n }, (_, i) => probe({ name: `ZCL_ZMCP_I_${String(i).padStart(8, "0")}` }));
}

describe("pruneInvokers — lease discipline", () => {
  it("takes exactly one lease per delete, never a shared connection across deletes", async () => {
    // More than five: LOGON_ENDPOINT_LIFETIME_CEILING (src/adt/connection.ts)
    // is 5 and per connection instance — this is precisely the shape a
    // single-lease loop over N invokers exhausts.
    const N = 7;
    const probes = invokers(N);
    deleteMock.mockResolvedValue({ deleted: true });
    const { lease, opNames } = makeLease();

    const results = await pruneInvokers(gate(), lease, probes);

    expect(results).toHaveLength(N);
    for (const r of results) expect(r.outcome).toBe("deleted");
    const leaseCount = opNames.length;
    expect(leaseCount).toBe(N);
    for (const op of opNames) expect(op).toBe("abap_fluid.repair.prune-invoker");
  });

  it("reports NOT_FOUND as already-absent, another error as failed with its message, and keeps processing the rest", async () => {
    const A = probe({ name: "ZCL_ZMCP_I_AAAAAAAA" });
    const B = probe({ name: "ZCL_ZMCP_I_BBBBBBBB" });
    const C = probe({ name: "ZCL_ZMCP_I_CCCCCCCC" });
    const D = probe({ name: "ZCL_ZMCP_I_DDDDDDDD" });

    deleteMock.mockImplementation(async (_conn: unknown, _gate: unknown, target: { name: string }) => {
      if (target.name === A.name) return { deleted: true };
      if (target.name === B.name) throw new AbapError("NOT_FOUND", `${B.name} does not exist`);
      if (target.name === C.name) throw new Error("server exploded");
      if (target.name === D.name) return { deleted: true };
      throw new Error(`unexpected target ${target.name}`);
    });

    const { lease } = makeLease();
    let threw = false;
    let results: readonly FluidInvokerPrune[] = [];
    try {
      results = await pruneInvokers(gate(), lease, [A, B, C, D]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    const byName = new Map(results.map((r) => [r.name, r]));
    expect(byName.get(A.name)?.outcome).toBe("deleted");
    expect(byName.get(B.name)?.outcome).toBe("already-absent");
    expect(byName.get(C.name)?.outcome).toBe("failed");
    expect(byName.get(C.name)?.error).toBeTruthy();
    expect(byName.get(C.name)?.error).toContain("server exploded");
    // D comes after C's failure in the probe list — the loop did not abort on C.
    expect(byName.get(D.name)?.outcome).toBe("deleted");
  });
});
