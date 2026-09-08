import { describe, expect, it } from "vitest";
import { loadConfig, resolveStaticCapabilities, type Config } from "../src/config.js";
import { SafetyGate, type SafetyConfig } from "../src/safety.js";
import { canUseFluidApi, fluidDisabledReason } from "../src/adt/fluid/enabled.js";

/** Minimal env that satisfies the required fields, same shape as `test/config-abap-mode.test.ts`. */
const env = (over: Record<string, string> = {}): Record<string, string> => ({
  ABAP_URL: "http://sap.invalid:50000",
  ABAP_USER: "U",
  ABAP_PASSWORD: "p",
  ...over,
});

const writableCfg = (over: Record<string, string> = {}): Config =>
  loadConfig({ env: env({ ABAP_ALLOW_WRITE: "true", ...over }), warn: () => {}, skipDotenv: true });

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
    const cfg = writableCfg({ ABAP_FLUID_API: "false" });
    expect(fluidDisabledReason(cfg)).toEqual({ kind: "flag", field: "ABAP_FLUID_API" });
  });

  it("ABAP_MODE=read", () => {
    const cfg = loadConfig({ env: env({ ABAP_MODE: "read" }), warn: () => {}, skipDotenv: true });
    expect(fluidDisabledReason(cfg)).toEqual({ kind: "read-only", field: "cfg.abapMode" });
  });

  it("writes off (ABAP_ALLOW_WRITE unset, so cfg.readOnly is true)", () => {
    const cfg = loadConfig({ env: env(), warn: () => {}, skipDotenv: true });
    expect(cfg.readOnly).toBe(true);
    expect(fluidDisabledReason(cfg)).toEqual({ kind: "read-only", field: "cfg.readOnly" });
  });

  it("gate.config.productive", () => {
    const cfg = writableCfg();
    const gate = gateOf({ productive: true });
    expect(fluidDisabledReason(cfg, gate)).toEqual({ kind: "read-only", field: "gate.config.productive" });
  });

  it("gate.config.systemRole === 'productive', productive unset", () => {
    const cfg = writableCfg();
    const gate = gateOf({ productive: undefined, systemRole: "productive" });
    expect(fluidDisabledReason(cfg, gate)).toEqual({ kind: "read-only", field: "gate.config.systemRole" });
  });

  it("gate.config.roleProbeFailure set", () => {
    const cfg = writableCfg();
    const gate = gateOf({ writesLockedOut: true, roleProbeFailure: "T000 read failed: 403" });
    expect(fluidDisabledReason(cfg, gate)).toEqual({
      kind: "read-only",
      field: "gate.config.roleProbeFailure",
    });
  });

  it("gate.config.writesLockedOut, roleProbeFailure unset", () => {
    const cfg = writableCfg();
    const gate = gateOf({ writesLockedOut: true, roleProbeFailure: undefined });
    expect(fluidDisabledReason(cfg, gate)).toEqual({
      kind: "read-only",
      field: "gate.config.writesLockedOut",
    });
  });
});

describe("fluidDisabledReason: ordering", () => {
  it("the flag wins over a productive gate", () => {
    const cfg = writableCfg({ ABAP_FLUID_API: "false" });
    const gate = gateOf({ productive: true });
    expect(fluidDisabledReason(cfg, gate)).toEqual({ kind: "flag", field: "ABAP_FLUID_API" });
  });
});

describe("fluidDisabledReason: healthy configs return undefined", () => {
  // Regression guard: changing any `=== true` in enabled.ts to `!== false`
  // would make this test fail, since no gate means no connected fields at all.
  it("no gate, healthy writable config", () => {
    const cfg = writableCfg();
    expect(fluidDisabledReason(cfg)).toBeUndefined();
  });

  // Same guard, exercised through the gate arm with every connected field
  // still unprobed (undefined) rather than absent.
  it("a fresh, unprobed gate does not disable", () => {
    const cfg = writableCfg();
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP"],
      productive: undefined,
      systemRole: undefined,
      writesLockedOut: undefined,
      roleProbeFailure: undefined,
    });
    expect(fluidDisabledReason(cfg, gate)).toBeUndefined();
  });
});

describe("canUseFluidApi", () => {
  it("false when the flag is off", () => {
    const cfg = writableCfg({ ABAP_FLUID_API: "false" });
    expect(canUseFluidApi(cfg)).toBe(false);
  });

  it("false when ABAP_MODE=read", () => {
    const cfg = loadConfig({ env: env({ ABAP_MODE: "read" }), warn: () => {}, skipDotenv: true });
    expect(canUseFluidApi(cfg)).toBe(false);
  });

  it("false when writes are off", () => {
    const cfg = loadConfig({ env: env(), warn: () => {}, skipDotenv: true });
    expect(canUseFluidApi(cfg)).toBe(false);
  });

  it("true on a healthy writable config with the flag on", () => {
    const cfg = writableCfg();
    expect(canUseFluidApi(cfg)).toBe(true);
  });

  it("true on a healthy writable config with the flag unset (defaults on)", () => {
    const cfg = loadConfig({ env: env({ ABAP_ALLOW_WRITE: "true" }), warn: () => {}, skipDotenv: true });
    expect(canUseFluidApi(cfg)).toBe(true);
  });

  it("ignores the connected conditions entirely: no gate parameter exists to pass a productive gate through", () => {
    const cfg = writableCfg();
    expect(canUseFluidApi(cfg)).toBe(true);
    const gate = gateOf({ productive: true });
    expect(fluidDisabledReason(cfg, gate)).toBeDefined();
  });
});

describe("canUseFluidApi matches resolveStaticCapabilities(cfg).canUseFluidApi", () => {
  const matrix: Array<{ name: string; env: Record<string, string> }> = [
    { name: "flag on, edit mode (writable)", env: { ABAP_ALLOW_WRITE: "true" } },
    { name: "flag off, edit mode (writable)", env: { ABAP_ALLOW_WRITE: "true", ABAP_FLUID_API: "false" } },
    { name: "flag on, ABAP_MODE=read", env: { ABAP_MODE: "read" } },
    { name: "flag off, ABAP_MODE=read", env: { ABAP_MODE: "read", ABAP_FLUID_API: "false" } },
    { name: "flag on, legacy read-only (ABAP_ALLOW_WRITE unset)", env: {} },
    { name: "flag off, legacy read-only (ABAP_ALLOW_WRITE unset)", env: { ABAP_FLUID_API: "false" } },
  ];

  for (const { name, env: over } of matrix) {
    it(name, () => {
      const cfg = loadConfig({ env: env(over), warn: () => {}, skipDotenv: true });
      expect(canUseFluidApi(cfg)).toBe(resolveStaticCapabilities(cfg).canUseFluidApi);
    });
  }
});
