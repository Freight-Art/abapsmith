/**
 * Pins the seven FLUID_* error codes added in src/adt/errors.ts: all terminal
 * (never auto-retried), and the deliberate no-caps decision that killed
 * FLUID_INPUT_TOO_LARGE stays dead.
 */
import { describe, expect, it } from "vitest";
import { AbapError, RETRYABILITY, defaultRetryable } from "../src/adt/errors.js";

const FLUID_CODES = [
  "FLUID_API_DISABLED",
  "FLUID_PLUGINS_DISABLED",
  "FLUID_PLUGIN_MUTATE_DISABLED",
  "FLUID_OBJECT_CONFLICT",
  "FLUID_MANIFEST_INVALID",
  "FLUID_ACTION_FAILED",
  "FLUID_PROTOCOL_ERROR",
] as const;

describe("FLUID_* error codes", () => {
  it.each(FLUID_CODES)("%s is classified terminal and never defaults retryable", (code) => {
    expect(RETRYABILITY[code]).toBe("terminal");
    expect(defaultRetryable(code)).toBe(false);
  });

  it("AbapError.toJSON() carries FLUID_API_DISABLED's details through unchanged", () => {
    const details = {
      reason: "read-only" as const,
      flag: "ABAP_FLUID_API",
      flagEnabled: true,
      package: "ZFOO",
      tool: "abap_fluid_deploy",
    };
    const err = new AbapError(
      "FLUID_API_DISABLED",
      "the fluid API is disabled on this connection",
      details,
      "the system is read-only; no flag change fixes that",
    );
    const json = err.toJSON();
    expect(json["error"]).toBe("FLUID_API_DISABLED");
    expect(json["retryable"]).toBe(false);
    expect(json["details"]).toEqual(details);
    expect((json["details"] as typeof details).reason).toBe("read-only");
  });

  it("FLUID_INPUT_TOO_LARGE was deleted by a deliberate no-caps decision and must not come back", () => {
    const keys = Object.keys(RETRYABILITY);
    expect(keys).not.toContain("FLUID_INPUT_TOO_LARGE");

    const fluidKeys = keys.filter((k) => k.startsWith("FLUID_")).sort();
    expect(fluidKeys).toEqual(
      [
        "FLUID_ACTION_FAILED",
        "FLUID_API_DISABLED",
        "FLUID_MANIFEST_INVALID",
        "FLUID_OBJECT_CONFLICT",
        "FLUID_PLUGINS_DISABLED",
        "FLUID_PLUGIN_MUTATE_DISABLED",
        "FLUID_PROTOCOL_ERROR",
      ].sort(),
    );
  });
});
