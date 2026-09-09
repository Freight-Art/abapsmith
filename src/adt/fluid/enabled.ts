import type { Config } from "../../config.js";
import type { SafetyGate } from "../../safety.js";

/** Everything the predicate reads. A full `Config` satisfies it. */
export type FluidConfigFields = Pick<Config, "fluidApi" | "abapMode" | "readOnly">;

export type FluidDisabledReason =
  | { readonly kind: "flag"; readonly field: "ABAP_FLUID_API" }
  | { readonly kind: "read-only"; readonly field:
        | "cfg.abapMode" | "cfg.readOnly"
        | "gate.config.productive" | "gate.config.systemRole"
        | "gate.config.writesLockedOut" | "gate.config.roleProbeFailure" };

/**
 * Checked in order: flag; then the static fields; then, only when `gate` is given,
 * the connected fields. Returns undefined when the fluid API is available.
 */
export function fluidDisabledReason(
  cfg: FluidConfigFields, gate?: SafetyGate,
): FluidDisabledReason | undefined {
  if (cfg.fluidApi === false) return { kind: "flag", field: "ABAP_FLUID_API" };
  if (cfg.abapMode === "read") return { kind: "read-only", field: "cfg.abapMode" };
  if (cfg.readOnly === true) return { kind: "read-only", field: "cfg.readOnly" };
  if (gate !== undefined) {
    const g = gate.config;
    // `=== true`, never `!== false`: these SafetyConfig fields are undefined
    // until connect() has run a probe, and `!== false` would treat that
    // unprobed undefined as a lockout on a perfectly writable system.
    if (g.productive === true) return { kind: "read-only", field: "gate.config.productive" };
    if (g.systemRole === "productive") return { kind: "read-only", field: "gate.config.systemRole" };
    // Checked before writesLockedOut: both come from the same one-way latch
    // and move together, so writesLockedOut is already true whenever a probe
    // failure set it — checking the cause first is the only way this branch
    // is ever reached.
    if (g.roleProbeFailure !== undefined) return { kind: "read-only", field: "gate.config.roleProbeFailure" };
    if (g.writesLockedOut === true) return { kind: "read-only", field: "gate.config.writesLockedOut" };
  }
  return undefined;
}

/** The static half, for capability reporting before connect(). */
export function canUseFluidApi(cfg: FluidConfigFields): boolean {
  return fluidDisabledReason(cfg) === undefined;
}
