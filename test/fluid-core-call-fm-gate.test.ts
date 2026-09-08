/**
 * Offline tests for `guardCoreAction`'s `core.call_fm` handling
 * (src/adt/fluid/builtin/core.ts), same shape as
 * fluid-core-select-gate.test.ts: a hand-built `FluidDeps`-shaped object
 * carrying only `cfg` (the guard never touches `gate` for `call_fm`). No
 * AbapConnection, no HTTP.
 *
 * Real behaviour:
 *   - throws SAFETY_DENIED (details.rule ABAP_ALLOW_FLUID_CALL_FM) whenever
 *     `!deps.cfg.allowFluidCallFm` — checked BEFORE the confirm echo, so this
 *     fires regardless of `args.commit`/`req.confirm`.
 *   - once allowed: only `args.commit === true` requires
 *     `req.confirm === "core.call_fm"`; otherwise it's a no-op resolve.
 *   - the BAD_INPUT shape when confirm is wrong/missing is the exact same
 *     shape as dispatch's own plugin-mutate confirm check (field: "confirm",
 *     expected: "core.call_fm", got: <req.confirm or undefined>).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { guardCoreAction } from "../src/adt/fluid/builtin/core.js";
import type { FluidDeps, FluidRunRequest } from "../src/adt/fluid/dispatch.js";
import { isAbapError, type AbapError } from "../src/adt/errors.js";

/** Only `cfg.allowFluidCallFm` is read by the guard for call_fm; `gate` is untouched. */
function makeDeps(opts: { allowFluidCallFm: boolean }): FluidDeps {
  return {
    cfg: { allowFluidCallFm: opts.allowFluidCallFm },
    gate: {},
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

describe("guardCoreAction — core.call_fm — ABAP_ALLOW_FLUID_CALL_FM", () => {
  it("allowFluidCallFm: false throws SAFETY_DENIED naming ABAP_ALLOW_FLUID_CALL_FM, with no confirm and commit absent", async () => {
    const deps = makeDeps({ allowFluidCallFm: false });
    const req: FluidRunRequest = { tool: "core", action: "call_fm", args: { name: "BAPI_FOO" } };

    const err = await catchErr(guardCoreAction(deps, req));

    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.message).toMatch(/ABAP_ALLOW_FLUID_CALL_FM/);
    expect(err.details["rule"]).toBe("ABAP_ALLOW_FLUID_CALL_FM");
  });

  // The flag is checked before the confirm echo, so a correct confirm and commit:true do not help.
  it("allowFluidCallFm: false throws SAFETY_DENIED even with commit: true and a correct confirm", async () => {
    const deps = makeDeps({ allowFluidCallFm: false });
    const req: FluidRunRequest = {
      tool: "core",
      action: "call_fm",
      args: { name: "BAPI_FOO", commit: true },
      confirm: "core.call_fm",
    };

    const err = await catchErr(guardCoreAction(deps, req));

    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details["rule"]).toBe("ABAP_ALLOW_FLUID_CALL_FM");
  });

  it("allowFluidCallFm: false throws SAFETY_DENIED even with a wrong confirm", async () => {
    const deps = makeDeps({ allowFluidCallFm: false });
    const req: FluidRunRequest = {
      tool: "core",
      action: "call_fm",
      args: { name: "BAPI_FOO", commit: true },
      confirm: "nope",
    };

    const err = await catchErr(guardCoreAction(deps, req));

    expect(err.code).toBe("SAFETY_DENIED");
    expect(err.details["rule"]).toBe("ABAP_ALLOW_FLUID_CALL_FM");
  });
});

describe("guardCoreAction — core.call_fm — commit confirm echo (allowFluidCallFm: true)", () => {
  it("commit absent, no confirm -> resolves (read-ish call, no echo required)", async () => {
    const deps = makeDeps({ allowFluidCallFm: true });
    const req: FluidRunRequest = { tool: "core", action: "call_fm", args: { name: "BAPI_FOO" } };

    await expect(guardCoreAction(deps, req)).resolves.toBeUndefined();
  });

  it("commit: false, no confirm -> resolves", async () => {
    const deps = makeDeps({ allowFluidCallFm: true });
    const req: FluidRunRequest = {
      tool: "core",
      action: "call_fm",
      args: { name: "BAPI_FOO", commit: false },
    };

    await expect(guardCoreAction(deps, req)).resolves.toBeUndefined();
  });

  it("commit: true, confirm missing -> throws BAD_INPUT with field/expected naming confirm/core.call_fm", async () => {
    const deps = makeDeps({ allowFluidCallFm: true });
    const req: FluidRunRequest = {
      tool: "core",
      action: "call_fm",
      args: { name: "BAPI_FOO", commit: true },
    };

    const err = await catchErr(guardCoreAction(deps, req));

    expect(err.code).toBe("BAD_INPUT");
    expect(err.details["field"]).toBe("confirm");
    expect(err.details["expected"]).toBe("core.call_fm");
    expect(err.details["got"]).toBeUndefined();
  });

  it("commit: true, confirm: \"wrong\" -> throws BAD_INPUT", async () => {
    const deps = makeDeps({ allowFluidCallFm: true });
    const req: FluidRunRequest = {
      tool: "core",
      action: "call_fm",
      args: { name: "BAPI_FOO", commit: true },
      confirm: "wrong",
    };

    const err = await catchErr(guardCoreAction(deps, req));

    expect(err.code).toBe("BAD_INPUT");
    expect(err.details["field"]).toBe("confirm");
    expect(err.details["expected"]).toBe("core.call_fm");
    expect(err.details["got"]).toBe("wrong");
  });

  it("commit: true, confirm: \"core.call_fm\" -> resolves", async () => {
    const deps = makeDeps({ allowFluidCallFm: true });
    const req: FluidRunRequest = {
      tool: "core",
      action: "call_fm",
      args: { name: "BAPI_FOO", commit: true },
      confirm: "core.call_fm",
    };

    await expect(guardCoreAction(deps, req)).resolves.toBeUndefined();
  });
});

// Proves the guard is actually wired into dispatch(). Wiring a full dispatch()
// fake (fluid-dispatch.test.ts's ~250-line recording-HTTP-client fixture) to
// re-prove what a static read of the source already proves deterministically
// is disproportionate for this one wiring fact, so this asserts statically
// instead: read src/adt/fluid/dispatch.ts off disk and count exactly one
// `guardCoreAction(` call-site occurrence. (The `import { guardCoreAction }`
// line does not match this pattern — nothing follows the identifier there but
// a space, not `(`.)
describe("guardCoreAction — wired into dispatch()", () => {
  const DISPATCH_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "adt", "fluid", "dispatch.ts");

  it("dispatch.ts contains exactly one guardCoreAction( call site", () => {
    const src = readFileSync(DISPATCH_PATH, "utf8");
    const matches = src.match(/guardCoreAction\(/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("that call site is awaited, ahead of input-schema validation and any target/package gate", () => {
    const src = readFileSync(DISPATCH_PATH, "utf8");
    const guardIdx = src.indexOf("guardCoreAction(");
    const validateIdx = src.indexOf("validateAgainstSchema(req.args");
    const ensurePackageIdx = src.indexOf("ensureFluidPackage(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(validateIdx).toBeGreaterThan(-1);
    expect(ensurePackageIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(validateIdx);
    expect(guardIdx).toBeLessThan(ensurePackageIdx);
  });
});
