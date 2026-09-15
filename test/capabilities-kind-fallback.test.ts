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

  // SHLP/DH and VIEW/DV both dropped out of this list: SHLP/DH gained a
  // `mode: "ddic"` TypeSpec (kind "SHLP"), and VIEW/DV gained one too (kind
  // "VIEW"), alongside TRAN/T (kind "TRAN"), when the classrun-bridge
  // create/catalog-read work landed. `capabilitiesFor("SHLP")` and
  // `capabilitiesFor("VIEW")` now resolve through the ordinary TYPES-kind
  // path exercised by the first test above, not through prefix-guessing —
  // the group word is a real `kind` in types.ts now, no guessing involved.
  // This test still needs REGISTRY codes with a real entry but no
  // `capabilitiesFor`-reachable group word to prove prefix-guessing stays
  // off. ENHO/XH takes VIEW/DV's old place: its own compound kind is
  // "ENHO/XH" (resolved by exact match, not by splitting off the "ENHO"
  // prefix), and there is no bare "ENHO" kind anywhere in types.ts — the
  // sibling ENHO/XHH entry is reached the same compound-exact-match way, not
  // through "ENHO" either — so a bare `capabilitiesFor("ENHO")` still has to
  // return undefined. SUSO/B has neither a TYPES entry nor a
  // capabilitiesFor-reachable kind, so it still belongs here too.
  it("does not prefix-guess: REGISTRY codes with no TYPES kind mapping stay unresolvable by their group word", () => {
    expect(REGISTRY["ENHO/XH"]).toBeDefined();
    expect(REGISTRY["SUSO/B"]).toBeDefined();
    expect(capabilitiesFor("ENHO")).toBeUndefined();
    expect(capabilitiesFor("SUSO")).toBeUndefined();
    // SHLP and VIEW are no longer in this set: SHLP/DH and VIEW/DV both have
    // TYPES kind mappings now.
    expect(capabilitiesFor("SHLP")).toBeDefined();
    expect(capabilitiesFor("SHLP")).toBe(REGISTRY["SHLP/DH"]);
    expect(capabilitiesFor("VIEW")).toBeDefined();
    expect(capabilitiesFor("VIEW")).toBe(REGISTRY["VIEW/DV"]);
  });

  it("normalises case and whitespace, and returns undefined for an unknown word", () => {
    expect(capabilitiesFor("  clas ")).toBe(REGISTRY["CLAS/OC"]);
    expect(capabilitiesFor("NOPE")).toBeUndefined();
    expect(capabilitiesFor(undefined)).toBeUndefined();
    expect(capabilitiesFor("")).toBeUndefined();
  });
});
