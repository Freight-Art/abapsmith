import { describe, expect, it } from "vitest";
import { SafetyGate, type SafetyConfig } from "../src/safety.js";
import { canUseFluidApi, fluidDisabledReason, type FluidConfigFields } from "../src/adt/fluid/enabled.js";

const cfg = (over: Partial<FluidConfigFields> = {}): FluidConfigFields =>
  ({ fluidApi: true, abapMode: "edit", readOnly: false, ...over });

/** A gate whose SafetyConfig fields are all explicitly set to their non-triggering value. */
const gateOf = (patch: Partial<SafetyConfig> = {}): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP"],
    productive: false,
    systemRole: "development",
    writesLockedOut: false,
    roleProbeFailure: undefined,
    ...patch,
  });

describe("fluidDisabledReason: one field per cause", () => {
  it("flag off", () => {
    expect(fluidDisabledReason(cfg({ fluidApi: false }))).toEqual({ kind: "flag", field: "ABAP_FLUID_API" });
  });

  it("ABAP_MODE=read", () => {
    expect(fluidDisabledReason(cfg({ abapMode: "read" }))).toEqual({
      kind: "read-only",
      field: "cfg.abapMode",
    });
  });

  it("cfg.readOnly is true", () => {
    expect(fluidDisabledReason(cfg({ readOnly: true }))).toEqual({
      kind: "read-only",
      field: "cfg.readOnly",
    });
  });

  it("gate.config.productive", () => {
    const gate = gateOf({ productive: true });
    expect(fluidDisabledReason(cfg(), gate)).toEqual({ kind: "read-only", field: "gate.config.productive" });
  });

  it("gate.config.systemRole === 'productive', productive unset", () => {
    const gate = gateOf({ productive: undefined, systemRole: "productive" });
    expect(fluidDisabledReason(cfg(), gate)).toEqual({ kind: "read-only", field: "gate.config.systemRole" });
  });

  it("gate.config.roleProbeFailure set", () => {
    const gate = gateOf({ writesLockedOut: true, roleProbeFailure: "T000 read failed: 403" });
    expect(fluidDisabledReason(cfg(), gate)).toEqual({
      kind: "read-only",
      field: "gate.config.roleProbeFailure",
    });
  });

  it("gate.config.writesLockedOut, roleProbeFailure unset", () => {
    const gate = gateOf({ writesLockedOut: true, roleProbeFailure: undefined });
    expect(fluidDisabledReason(cfg(), gate)).toEqual({
      kind: "read-only",
      field: "gate.config.writesLockedOut",
    });
  });
});

describe("fluidDisabledReason: ordering", () => {
  it("the flag wins over a productive gate", () => {
    const gate = gateOf({ productive: true });
    expect(fluidDisabledReason(cfg({ fluidApi: false }), gate)).toEqual({
      kind: "flag",
      field: "ABAP_FLUID_API",
    });
  });
});

describe("fluidDisabledReason: healthy configs return undefined", () => {
  // Regression guard: changing any `=== true` in enabled.ts to `!== false`
  // would make this test fail, since no gate means no connected fields at all.
  it("no gate, healthy writable config", () => {
    expect(fluidDisabledReason(cfg())).toBeUndefined();
  });

  // Same guard, exercised through the gate arm with every connected field
  // still unprobed (undefined) rather than absent.
  it("a fresh, unprobed gate does not disable", () => {
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      productive: undefined,
      systemRole: undefined,
      writesLockedOut: undefined,
      roleProbeFailure: undefined,
    });
    expect(fluidDisabledReason(cfg(), gate)).toBeUndefined();
  });
});

describe("canUseFluidApi", () => {
  it("false when the flag is off", () => {
    expect(canUseFluidApi(cfg({ fluidApi: false }))).toBe(false);
  });

  it("false when ABAP_MODE=read", () => {
    expect(canUseFluidApi(cfg({ abapMode: "read" }))).toBe(false);
  });

  it("false when writes are off", () => {
    expect(canUseFluidApi(cfg({ readOnly: true }))).toBe(false);
  });

  it("true on a healthy writable config with the flag on", () => {
    expect(canUseFluidApi(cfg())).toBe(true);
  });

  it("ignores the connected conditions entirely: no gate parameter exists to pass a productive gate through", () => {
    expect(canUseFluidApi(cfg())).toBe(true);
    const gate = gateOf({ productive: true });
    expect(fluidDisabledReason(cfg(), gate)).toBeDefined();
  });
});

describe("canUseFluidApi: truth table over its three fields", () => {
  // The env-to-resolveStaticCapabilities().canUseFluidApi half of this seam is
  // pinned in test/config-abap-mode.test.ts's "config: resolveStaticCapabilities.canUseFluidApi"
  // block (~line 1235); it can't be pulled in here without tripping the probe guard.
  const rows: Array<[boolean, FluidConfigFields["abapMode"], boolean, boolean]> = [
    [true, "edit", false, true],
    [false, "edit", false, false],
    [true, "read", false, false],
    [false, "read", false, false],
    [true, "edit", true, false],
    [false, "edit", true, false],
  ];

  for (const [fluidApi, abapMode, readOnly, expected] of rows) {
    it(`fluidApi=${fluidApi} abapMode=${abapMode} readOnly=${readOnly}`, () => {
      expect(canUseFluidApi(cfg({ fluidApi, abapMode, readOnly }))).toBe(expected);
    });
  }
});
