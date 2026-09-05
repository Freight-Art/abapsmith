/**
 * `capabilitiesFor` and `specForType` sit on the same resolution path (see
 * the `capabilitiesFor(opts.type)` refusal branches in src/adt/resolve.ts):
 * an exact-match-only `capabilitiesFor` would skip a refusal the moment a
 * kind maps to a non-readable code.
 */
import { describe, expect, it } from "vitest";
import { REGISTRY, capabilitiesFor } from "../src/adt/capabilities.js";
import { TYPES, specForType } from "../src/adt/types.js";

describe("capabilitiesFor resolves both kinds and types through the same path as specForType, without prefix-guessing", () => {
  it("resolves every TYPES kind and type to the same REGISTRY entry", () => {
    expect(TYPES.length).toBeGreaterThan(20);
    for (const spec of TYPES) {
      const byType = REGISTRY[spec.type as keyof typeof REGISTRY];
      expect(capabilitiesFor(spec.kind)).toBeDefined();
      expect(capabilitiesFor(spec.kind)).toBe(capabilitiesFor(spec.type));
      expect(capabilitiesFor(spec.type)).toBe(byType);
    }
  });

  it("agrees with specForType for every kind that resolves", () => {
    for (const spec of TYPES) {
      const viaSpecForType = specForType(spec.kind);
      if (viaSpecForType === undefined) continue;
      expect(capabilitiesFor(spec.kind)).toBe(
        REGISTRY[viaSpecForType.type as keyof typeof REGISTRY],
      );
    }
  });

  it("resolves a non-prefix kind (STRU -> TABL/DS) through the same path", () => {
    expect(capabilitiesFor("STRU")).toBe(REGISTRY["TABL/DS"]);
    expect(capabilitiesFor("CLAS")).toBe(REGISTRY["CLAS/OC"]);
  });

  it("does not prefix-guess: REGISTRY codes with no TYPES kind mapping stay unresolvable by their group word", () => {
    expect(REGISTRY["SHLP/DH"]).toBeDefined();
    expect(REGISTRY["VIEW/DV"]).toBeDefined();
    expect(REGISTRY["SUSO/B"]).toBeDefined();
    expect(capabilitiesFor("SHLP")).toBeUndefined();
    expect(capabilitiesFor("VIEW")).toBeUndefined();
    expect(capabilitiesFor("SUSO")).toBeUndefined();
  });

  it("normalises case and whitespace, and returns undefined for an unknown word", () => {
    expect(capabilitiesFor("  clas ")).toBe(REGISTRY["CLAS/OC"]);
    expect(capabilitiesFor("NOPE")).toBeUndefined();
    expect(capabilitiesFor(undefined)).toBeUndefined();
    expect(capabilitiesFor("")).toBeUndefined();
  });
});
