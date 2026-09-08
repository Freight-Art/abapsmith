/**
 * Offline tests for `guardCoreAction`'s `core.select` handling
 * (src/adt/fluid/builtin/core.ts). Drives the guard directly with a
 * hand-built `FluidDeps`-shaped object carrying only the two fields the
 * guard reads: `cfg` and `gate`. No AbapConnection, no HTTP.
 *
 * Real behaviour (read the guard's own source, not the spec prose — the
 * order below is what the code does):
 *   - non-`core` tool -> returns immediately.
 *   - `select` with a non-string/empty `args.table` -> returns immediately
 *     (schema validation, run right after the guard by dispatch(), reports
 *     BAD_INPUT for that).
 *   - `select` with a valid table -> calls `deps.gate.assertDataPreview(table)`
 *     FIRST, propagating whatever it throws, and only THEN checks
 *     `deps.cfg.allowDataPreview`. The data-preview policy judges the table,
 *     not a new core-specific policy, and it is judged before the capability
 *     flag — so a test of the flag alone must use a permissive gate.
 *   - `describe_fm` -> no-op.
 */
import { describe, expect, it, vi } from "vitest";
import { guardCoreAction } from "../src/adt/fluid/builtin/core.js";
import type { FluidDeps, FluidRunRequest } from "../src/adt/fluid/dispatch.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";

/** Only `cfg.allowDataPreview` and `gate.assertDataPreview` are read by the guard. */
function makeDeps(opts: {
  allowDataPreview: boolean;
  assertDataPreview: (table: string, extraDeny?: readonly string[]) => void;
}): FluidDeps {
  return {
    cfg: { allowDataPreview: opts.allowDataPreview },
    gate: { assertDataPreview: opts.assertDataPreview },
  } as unknown as FluidDeps;
}

async function catchErr(p: Promise<unknown>): Promise<AbapError> {
  try {
    await p;
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected a rejection");
}

describe("guardCoreAction — core.select", () => {
  it("allowDataPreview: false throws SAFETY_DENIED naming ABAP_ALLOW_DATA_PREVIEW, with a permissive gate isolating the flag", async () => {
    const assertDataPreview = vi.fn(); // permissive: never throws
    const deps = makeDeps({ allowDataPreview: false, assertDataPreview });
    const req: FluidRunRequest = { tool: "core", action: "select", args: { table: "ANY_TABLE" } };

    const err = await catchErr(guardCoreAction(deps, req));

    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toMatch(/ABAP_ALLOW_DATA_PREVIEW/);
    expect(err.details["rule"]).toBe("ABAP_ALLOW_DATA_PREVIEW");
    // the gate is still consulted first, even though the flag is what ultimately denies here
    expect(assertDataPreview).toHaveBeenCalledWith("ANY_TABLE");
  });

  it("allowDataPreview: false throws SAFETY_DENIED regardless of which table is named", async () => {
    const assertDataPreview = vi.fn();
    const deps = makeDeps({ allowDataPreview: false, assertDataPreview });
    const req: FluidRunRequest = { tool: "core", action: "select", args: { table: "T000" } };

    const err = await catchErr(guardCoreAction(deps, req));

    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details["rule"]).toBe("ABAP_ALLOW_DATA_PREVIEW");
  });

  // The order in the real code is gate-first: deps.gate.assertDataPreview(table) runs and can
  // throw BEFORE deps.cfg.allowDataPreview is even looked at. This differs from the spec's prose
  // ordering; the real code is authoritative and this test pins it.
  it("with allowDataPreview: true, propagates whatever the gate's assertDataPreview throws for a deny-listed table", async () => {
    const denyErr = new AbapError(
      "SAFETY_DENIED",
      "USR02 is deny-listed for data preview.",
      { rule: "data-preview-deny-list", table: "USR02" },
    );
    const assertDataPreview = vi.fn(() => {
      throw denyErr;
    });
    const deps = makeDeps({ allowDataPreview: true, assertDataPreview });
    const req: FluidRunRequest = { tool: "core", action: "select", args: { table: "USR02" } };

    await expect(guardCoreAction(deps, req)).rejects.toBe(denyErr);
    expect(assertDataPreview).toHaveBeenCalledWith("USR02");
  });

  it("with allowDataPreview: true and a permissive gate, resolves", async () => {
    const assertDataPreview = vi.fn();
    const deps = makeDeps({ allowDataPreview: true, assertDataPreview });
    const req: FluidRunRequest = { tool: "core", action: "select", args: { table: "T000" } };

    await expect(guardCoreAction(deps, req)).resolves.toBeUndefined();
    expect(assertDataPreview).toHaveBeenCalledWith("T000");
  });

  // Documents the real early-return: an empty/non-string table skips the gate entirely and lets
  // dispatch()'s schema validation (which runs right after the guard) report BAD_INPUT instead.
  it("with a missing/non-string table, returns without consulting the gate at all", async () => {
    const assertDataPreview = vi.fn();
    const deps = makeDeps({ allowDataPreview: false, assertDataPreview });
    const req: FluidRunRequest = { tool: "core", action: "select", args: {} };

    await expect(guardCoreAction(deps, req)).resolves.toBeUndefined();
    expect(assertDataPreview).not.toHaveBeenCalled();
  });
});

describe("guardCoreAction — no-op cases", () => {
  it("is a no-op for a different tool id ({ tool: \"rt\", action: \"ping\" })", async () => {
    const assertDataPreview = vi.fn();
    const deps = makeDeps({ allowDataPreview: false, assertDataPreview });
    const req: FluidRunRequest = { tool: "rt", action: "ping", args: {} };

    await expect(guardCoreAction(deps, req)).resolves.toBeUndefined();
    expect(assertDataPreview).not.toHaveBeenCalled();
  });

  it("is a no-op for core.describe_fm", async () => {
    const assertDataPreview = vi.fn();
    const deps = makeDeps({ allowDataPreview: false, assertDataPreview });
    const req: FluidRunRequest = { tool: "core", action: "describe_fm", args: { name: "BAPI_FOO" } };

    await expect(guardCoreAction(deps, req)).resolves.toBeUndefined();
    expect(assertDataPreview).not.toHaveBeenCalled();
  });
});
