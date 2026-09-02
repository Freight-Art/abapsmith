/**
 * `ABAP_MODE` — Layer 1 of the 3-layer safety design. See the
 * doc comment at the top of `src/mode.ts` for what this layer does and does
 * not guarantee.
 *
 * Scope: this suite imports `../src/mode.ts` and nothing else from src. It
 * is pure — no env, no connection, no filesystem — matching the "self
 * contained module" design of `src/mode.ts` itself.
 */
import { describe, expect, it } from "vitest";
import {
  capabilitiesForMode,
  isMutatingOperationAllowed,
  parseAbapMode,
  type AbapCapabilities,
  type AbapMode,
  type AbapModeBooleanOverrides,
  type AbapModeOverrides,
} from "../src/mode.js";

describe("parseAbapMode", () => {
  it("accepts the three valid modes", () => {
    expect(parseAbapMode("read")).toBe("read");
    expect(parseAbapMode("edit")).toBe("edit");
    expect(parseAbapMode("admin")).toBe("admin");
  });

  it("is case-insensitive", () => {
    expect(parseAbapMode("READ")).toBe("read");
    expect(parseAbapMode("Edit")).toBe("edit");
    expect(parseAbapMode("ADMIN")).toBe("admin");
    expect(parseAbapMode("aDmIn")).toBe("admin");
  });

  it("trims surrounding whitespace", () => {
    expect(parseAbapMode("  edit  ")).toBe("edit");
    expect(parseAbapMode("\tadmin\n")).toBe("admin");
  });

  it("rejects undefined", () => {
    expect(() => parseAbapMode(undefined)).toThrow(/ABAP_MODE is not set/);
  });

  it("rejects an empty string", () => {
    expect(() => parseAbapMode("")).toThrow(/empty/);
  });

  it("rejects a whitespace-only string", () => {
    expect(() => parseAbapMode("   ")).toThrow(/empty/);
  });

  it("rejects garbage values, naming the offending value", () => {
    expect(() => parseAbapMode("redd")).toThrow(/"redd"/);
    expect(() => parseAbapMode("write")).toThrow(/not a recognised mode/);
    expect(() => parseAbapMode("READWRITE")).toThrow(/not a recognised mode/);
  });

  it("every thrown error is a real Error with a message, not a silent failure", () => {
    for (const bad of [undefined, "", "   ", "bogus"]) {
      let caught: unknown;
      try {
        parseAbapMode(bad);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message.length).toBeGreaterThan(0);
    }
  });
});

describe("capabilitiesForMode('read') — the structural invariant", () => {
  const expectedRead: Omit<AbapCapabilities, "mode"> = {
    allowWrite: false,
    allowActivate: false,
    allowPackages: [],
    allowNamePrefixes: [],
    allowTransports: null,
    allowTransportRelease: false,
    allowTransportDelete: false,
    allowEnhancements: false,
    enhanceTargets: "none",
    enhanceTargetPackages: [],
    allowSourcePlugins: false,
    allowEnhancementDelete: false,
    allowCascadeDelete: false,
    allowRawAdtWrites: false,
    originSystems: [],
    allowDataPreview: false,
  };

  it("with no overrides, denies everything", () => {
    const caps = capabilitiesForMode("read");
    expect(caps).toEqual({ mode: "read", ...expectedRead });
  });

  it("CANNOT be widened by an override that tries to widen every list field", () => {
    const caps = capabilitiesForMode("read", {
      allowPackages: ["*"],
      allowNamePrefixes: ["*"],
      allowTransports: ["*", "auto", "A4HK900001"],
      enhanceTargetPackages: ["*"],
      originSystems: ["EVIL", "SAP"],
    });
    // Still the exact fixed deny-everything set — none of the above took effect.
    expect(caps).toEqual({ mode: "read", ...expectedRead });
  });

  it("read: allowPackages is [] — the all-deny sentinel — no matter what the override asks for", () => {
    // The invariant READ_CAPABILITIES (src/mode.ts) rests on: the permissive
    // edit/admin default must never reach read.
    const overrides: Array<Parameters<typeof capabilitiesForMode>[1]> = [
      undefined,
      {},
      { allowPackages: ["*"] },
      { allowPackages: ["$TMP"] },
      { allowPackages: [] },
    ];
    for (const override of overrides) {
      expect(capabilitiesForMode("read", override).allowPackages).toEqual([]);
    }
  });

  it("an override of an empty object still yields the fixed set (no accidental key leakage)", () => {
    expect(capabilitiesForMode("read", {})).toEqual({ mode: "read", ...expectedRead });
  });
});

describe("capabilitiesForMode('read') — the non-goal: maximally permissive overrides in ALL THREE bags at once still deny everything", () => {
  // Pins the thing the user called out explicitly: read must stay a frozen
  // all-deny set no matter how many levers try to widen it simultaneously.
  const maximalOverrides: AbapModeOverrides = {
    allowPackages: ["*"],
    allowNamePrefixes: ["*"],
    allowTransports: ["*"],
    enhanceTargetPackages: ["*"],
    originSystems: ["*"],
  };
  // Built from a Record keyed by AbapModeBooleanOverrides itself: an 8th field
  // added to that interface later makes this literal fail to typecheck until
  // updated, rather than silently under-covering the new field.
  const maximalBoolOverrides: Record<keyof AbapModeBooleanOverrides, true> = {
    allowTransportRelease: true,
    allowTransportDelete: true,
    allowCascadeDelete: true,
    allowRawAdtWrites: true,
    allowEnhancements: true,
    allowSourcePlugins: true,
    allowEnhancementDelete: true,
  };

  it("deep-equals the plain read baseline even with every list/bool override maxed out", () => {
    const caps = capabilitiesForMode("read", maximalOverrides, {}, maximalBoolOverrides);
    expect(caps).toEqual(capabilitiesForMode("read"));
  });

  it("the one deliberate exception — grants.allowDataPreview IS honoured, alongside every other maxed-out override", () => {
    const caps = capabilitiesForMode(
      "read",
      maximalOverrides,
      { allowDataPreview: true },
      maximalBoolOverrides,
    );
    expect(caps).toEqual(capabilitiesForMode("read", {}, { allowDataPreview: true }));
    expect(caps.allowDataPreview).toBe(true);
  });
});

describe("capabilitiesForMode('edit') — defaults", () => {
  it("matches the exact specified defaults", () => {
    const caps = capabilitiesForMode("edit");
    expect(caps).toEqual({
      mode: "edit",
      allowWrite: true,
      allowActivate: true,
      allowPackages: ["*"],
      allowNamePrefixes: ["*"],
      allowTransports: ["*"],
      allowTransportRelease: false,
      allowTransportDelete: false,
      allowEnhancements: true,
      enhanceTargets: "customer",
      enhanceTargetPackages: [],
      // Same tier as allowEnhancements, not admin-only — see the doc comment
      // on AbapCapabilities.allowSourcePlugins for why: the host object's own
      // package is still independently judged by enhanceTargets ("customer" here), so
      // admin-only added no protection edit-mode's own enhanceTargets ceiling
      // did not already provide.
      allowSourcePlugins: true,
      allowEnhancementDelete: false,
      allowCascadeDelete: false,
      allowRawAdtWrites: false,
      originSystems: [],
      allowDataPreview: false,
    });
  });
});

describe("capabilitiesForMode('admin') — defaults", () => {
  it("matches the exact specified defaults: everything edit has, plus the admin ceilings", () => {
    const caps = capabilitiesForMode("admin");
    expect(caps).toEqual({
      mode: "admin",
      allowWrite: true,
      allowActivate: true,
      allowPackages: ["*"],
      allowNamePrefixes: ["*"],
      allowTransports: ["*"],
      allowTransportRelease: true,
      allowTransportDelete: true,
      allowEnhancements: true,
      enhanceTargets: "sap",
      enhanceTargetPackages: [],
      allowSourcePlugins: true,
      allowEnhancementDelete: true,
      allowCascadeDelete: true,
      allowRawAdtWrites: true,
      originSystems: [],
      allowDataPreview: false,
    });
  });
});

describe("capabilitiesForMode — AbapModeBooleanOverrides (two-way overrides)", () => {
  const modes: AbapMode[] = ["read", "edit", "admin"];

  it("boolOverrides omitted entirely is byte-identical to passing {} explicitly, in every mode", () => {
    for (const mode of modes) {
      expect(capabilitiesForMode(mode)).toEqual(capabilitiesForMode(mode, {}, {}));
      expect(capabilitiesForMode(mode)).toEqual(capabilitiesForMode(mode, {}, {}, {}));
    }
  });

  it("read/edit: {allowEnhancementDelete: false} is byte-identical to omitting the bag — both already deny it by default", () => {
    for (const mode of ["read", "edit"] as const) {
      expect(capabilitiesForMode(mode, {}, {}, { allowEnhancementDelete: false })).toEqual(
        capabilitiesForMode(mode),
      );
    }
  });

  it("admin: {allowEnhancementDelete: false} is NOT byte-identical to omitting — the override is two-way and narrows admin's own default", () => {
    // The old AbapModeUnlocks was widen-only, so an explicit `false` used to be
    // a no-op under admin (`isAdmin || false`). It is a real narrowing now
    // (`false ?? isAdmin` — `??` does not fall through on `false`).
    const base = capabilitiesForMode("admin");
    const narrowed = capabilitiesForMode("admin", {}, {}, { allowEnhancementDelete: false });
    expect(base.allowEnhancementDelete).toBe(true);
    expect(narrowed.allowEnhancementDelete).toBe(false);
    expect(narrowed).toEqual({ ...base, allowEnhancementDelete: false });
  });

  it("read: the override is structurally unreachable — flag=true still produces the exact fixed deny-everything object", () => {
    const withOverride = capabilitiesForMode("read", {}, {}, { allowEnhancementDelete: true });
    expect(withOverride).toEqual(capabilitiesForMode("read"));
    expect(withOverride.allowEnhancementDelete).toBe(false);
    // Nothing else moved either — the whole object, not just this one field,
    // is untouched by the override under read.
    expect(withOverride).toEqual({
      mode: "read",
      allowWrite: false,
      allowActivate: false,
      allowPackages: [],
      allowNamePrefixes: [],
      allowTransports: null,
      allowTransportRelease: false,
      allowTransportDelete: false,
      allowEnhancements: false,
      enhanceTargets: "none",
      enhanceTargetPackages: [],
      allowSourcePlugins: false,
      allowEnhancementDelete: false,
      allowCascadeDelete: false,
      allowRawAdtWrites: false,
      originSystems: [],
      allowDataPreview: false,
    });
  });

  it("edit: the override grants allowEnhancementDelete and changes NOTHING else", () => {
    const base = capabilitiesForMode("edit");
    const widened = capabilitiesForMode("edit", {}, {}, { allowEnhancementDelete: true });
    expect(base.allowEnhancementDelete).toBe(false);
    expect(widened.allowEnhancementDelete).toBe(true);
    expect(widened).toEqual({ ...base, allowEnhancementDelete: true });
  });

  it("admin: {allowEnhancementDelete: true} is a no-op — admin already grants it outright", () => {
    const withOverride = capabilitiesForMode("admin", {}, {}, { allowEnhancementDelete: true });
    expect(withOverride).toEqual(capabilitiesForMode("admin"));
    expect(withOverride.allowEnhancementDelete).toBe(true);
  });

  it("edit: the override composes independently of overrides/grants passed alongside it", () => {
    const caps = capabilitiesForMode(
      "edit",
      { allowPackages: ["ZFOO"] },
      { allowDataPreview: true },
      { allowEnhancementDelete: true },
    );
    expect(caps.allowPackages).toEqual(["ZFOO"]);
    expect(caps.allowDataPreview).toBe(true);
    expect(caps.allowEnhancementDelete).toBe(true);
  });

  it("admin: an explicit false narrows every one of the seven boolean fields, not just allowEnhancementDelete", () => {
    const narrowAll: AbapModeBooleanOverrides = {
      allowTransportRelease: false,
      allowTransportDelete: false,
      allowCascadeDelete: false,
      allowRawAdtWrites: false,
      allowEnhancements: false,
      allowSourcePlugins: false,
      allowEnhancementDelete: false,
    };
    const caps = capabilitiesForMode("admin", {}, {}, narrowAll);
    expect(caps.allowTransportRelease).toBe(false);
    expect(caps.allowTransportDelete).toBe(false);
    expect(caps.allowCascadeDelete).toBe(false);
    expect(caps.allowRawAdtWrites).toBe(false);
    expect(caps.allowEnhancements).toBe(false);
    expect(caps.allowSourcePlugins).toBe(false);
    expect(caps.allowEnhancementDelete).toBe(false);
    // Nothing outside the seven booleans moved.
    expect(caps.allowWrite).toBe(true);
    expect(caps.allowPackages).toEqual(["*"]);
  });

  it("output stays frozen with an override applied", () => {
    expect(
      Object.isFrozen(capabilitiesForMode("edit", {}, {}, { allowEnhancementDelete: true })),
    ).toBe(true);
  });
});

describe("capabilitiesForMode — overrides narrow correctly for edit/admin", () => {
  it("edit: an allowPackages override replaces the default outright — the old always-retained $TMP union is gone", () => {
    // resolvePackages (src/mode.ts) now matches resolveNamePrefixes's replace-outright behaviour.
    const caps = capabilitiesForMode("edit", { allowPackages: ["ZFOO"] });
    expect(caps.allowPackages).toEqual(["ZFOO"]);
    expect(caps.allowPackages).not.toContain("$TMP");
  });

  it("edit/admin: with allowPackages unset, the default is the wildcard ['*'] — a real match-anything, not a literal package", () => {
    // packagePattern() (src/safety.ts) expands "*" to the regex /.*/.
    expect(capabilitiesForMode("edit").allowPackages).toEqual(["*"]);
    expect(capabilitiesForMode("admin").allowPackages).toEqual(["*"]);
  });

  it("edit/admin: an explicitly empty allowPackages override stays empty — deny-all, not the default and not $TMP", () => {
    // src/safety.ts refuses any write when the allowlist is empty.
    expect(capabilitiesForMode("edit", { allowPackages: [] }).allowPackages).toEqual([]);
    expect(capabilitiesForMode("admin", { allowPackages: [] }).allowPackages).toEqual([]);
  });

  it("edit: allowNamePrefixes override replaces the default outright", () => {
    const caps = capabilitiesForMode("edit", { allowNamePrefixes: ["ZFOO_"] });
    expect(caps.allowNamePrefixes).toEqual(["ZFOO_"]);
  });

  it("edit/admin: an explicitly empty allowNamePrefixes override is folded into the ['*'] default — unlike packages/transports, prefixes have no deny-all sentinel", () => {
    expect(capabilitiesForMode("edit", { allowNamePrefixes: [] }).allowNamePrefixes).toEqual(["*"]);
    expect(capabilitiesForMode("admin", { allowNamePrefixes: [] }).allowNamePrefixes).toEqual(["*"]);
  });

  it("contrast: allowPackages: [] and allowTransports: [] stay deny-all while allowNamePrefixes: [] does not", () => {
    const caps = capabilitiesForMode("edit", {
      allowPackages: [],
      allowTransports: [],
      allowNamePrefixes: [],
    });
    expect(caps.allowPackages).toEqual([]);
    expect(caps.allowTransports).toEqual([]);
    expect(caps.allowNamePrefixes).toEqual(["*"]);
  });

  it("edit: allowTransports override replaces the ['*'] default outright — a pinned TRKORR is honoured", () => {
    const caps = capabilitiesForMode("edit", { allowTransports: ["A4HK900001"] });
    expect(caps.allowTransports).toEqual(["A4HK900001"]);
  });

  it("edit: allowTransports override can narrow ['*'] down to [] explicitly", () => {
    const caps = capabilitiesForMode("edit", { allowTransports: [] });
    expect(caps.allowTransports).toEqual([]);
  });

  it("edit: allowTransports override of null explicitly denies all transportable writes", () => {
    const caps = capabilitiesForMode("edit", { allowTransports: null });
    expect(caps.allowTransports).toBeNull();
  });

  it("edit: allowTransports override is taken verbatim — no case-folding or 'auto' retention happens in mode.ts anymore", () => {
    // Case-folding/canonicalisation now lives upstream in src/config.ts's
    // normaliseTransportEntry; capabilitiesForMode itself does zero normalisation.
    expect(capabilitiesForMode("edit", { allowTransports: ["AUTO"] }).allowTransports).toEqual(["AUTO"]);
    expect(capabilitiesForMode("edit", { allowTransports: ["auto", "A4HK900001"] }).allowTransports).toEqual([
      "auto",
      "A4HK900001",
    ]);
  });

  it("admin: allowTransports override replaces the default outright, same as edit", () => {
    const caps = capabilitiesForMode("admin", { allowTransports: ["*"] });
    expect(caps.allowTransports).toEqual(["*"]);
  });

  it("admin: enhanceTargetPackages override is the practical way to actually enable SAP-target enhancement", () => {
    const caps = capabilitiesForMode("admin", { enhanceTargetPackages: ["SBAL"] });
    expect(caps.enhanceTargets).toBe("sap");
    expect(caps.enhanceTargetPackages).toEqual(["SBAL"]);
  });

  it("edit/admin: originSystems override replaces the empty default", () => {
    expect(capabilitiesForMode("edit", { originSystems: ["A4H"] }).originSystems).toEqual(["A4H"]);
    expect(capabilitiesForMode("admin", { originSystems: ["A4H", "PRD"] }).originSystems).toEqual([
      "A4H",
      "PRD",
    ]);
  });

  it("an override CANNOT set a boolean ceiling under edit mode — no such knob exists at the type level", () => {
    // There is no `allowTransportRelease`/`allowSourcePlugins`/etc. property on
    // AbapModeOverrides at all, so this is enforced by TypeScript's excess
    // property check on the object literal below (this file would fail to
    // typecheck, not merely fail at runtime, if such a property existed).
    const caps = capabilitiesForMode("edit", {
      allowPackages: ["ZFOO"],
      // @ts-expect-error -- allowTransportRelease is not a valid override field
      allowTransportRelease: true,
    });
    expect(caps.allowTransportRelease).toBe(false);
  });

  it("runtime confirmation: booleans stay at the mode's own ceiling regardless of what junk properties sneak into a loosely-typed override object", () => {
    // Simulate a caller that bypassed the type system entirely (e.g. an
    // override object built from untyped JSON). Each attempted value below
    // is chosen to DIFFER from edit's own ceiling for that field (widening
    // attempts for the admin-only ones, a NARROWING attempt for
    // allowSourcePlugins — which edit itself now grants — so a coincidental
    // match can't mask a live override path).
    const untypedOverride = {
      allowTransportRelease: true,
      allowSourcePlugins: false,
      allowCascadeDelete: true,
      allowRawAdtWrites: true,
      allowWrite: false,
    } as unknown as Parameters<typeof capabilitiesForMode>[1];
    const caps = capabilitiesForMode("edit", untypedOverride);
    expect(caps.allowTransportRelease).toBe(false);
    expect(caps.allowSourcePlugins).toBe(true); // edit's own ceiling, untouched
    expect(caps.allowCascadeDelete).toBe(false);
    expect(caps.allowRawAdtWrites).toBe(false);
    expect(caps.allowWrite).toBe(true); // edit's own ceiling, untouched
  });
});

describe("capabilitiesForMode — frozen output", () => {
  it("freezes the top-level object for edit and admin", () => {
    expect(Object.isFrozen(capabilitiesForMode("edit"))).toBe(true);
    expect(Object.isFrozen(capabilitiesForMode("admin"))).toBe(true);
  });

  it("freezes the top-level object for read", () => {
    expect(Object.isFrozen(capabilitiesForMode("read"))).toBe(true);
  });

  it("freezes array fields (allowPackages, allowNamePrefixes, allowTransports, enhanceTargetPackages, originSystems)", () => {
    const caps = capabilitiesForMode("admin", { enhanceTargetPackages: ["SBAL"], originSystems: ["A4H"] });
    expect(Object.isFrozen(caps.allowPackages)).toBe(true);
    expect(Object.isFrozen(caps.allowNamePrefixes)).toBe(true);
    expect(Object.isFrozen(caps.allowTransports)).toBe(true);
    expect(Object.isFrozen(caps.enhanceTargetPackages)).toBe(true);
    expect(Object.isFrozen(caps.originSystems)).toBe(true);
  });

  it("a frozen array field cannot be mutated (throws in strict mode / silently no-ops otherwise, either way the source is unaffected)", () => {
    const caps = capabilitiesForMode("edit");
    expect(() => {
      (caps.allowPackages as string[]).push("ZHACK");
    }).toThrow();
    // Re-resolving confirms the frozen attempt above did not leak state.
    expect(capabilitiesForMode("edit").allowPackages).toEqual(["*"]);
  });

  it("read mode's allowTransports (null) survives freezing without throwing", () => {
    expect(capabilitiesForMode("read").allowTransports).toBeNull();
  });
});

describe("isMutatingOperationAllowed", () => {
  const modes: AbapMode[] = ["read", "edit", "admin"];

  it("read mode refuses every mutating operation category", () => {
    const caps = capabilitiesForMode("read");
    for (const op of ["write", "activate", "delete", "execute", "transport"] as const) {
      expect(isMutatingOperationAllowed(caps, op)).toBe(false);
    }
  });

  it("edit and admin both permit write/delete/execute/transport (mirroring SafetyGate's uniform MUTATING_OPS treatment)", () => {
    for (const mode of ["edit", "admin"] as const) {
      const caps = capabilitiesForMode(mode);
      for (const op of ["write", "delete", "execute", "transport"] as const) {
        expect(isMutatingOperationAllowed(caps, op)).toBe(true);
      }
    }
  });

  it("edit and admin both permit activate", () => {
    for (const mode of ["edit", "admin"] as const) {
      expect(isMutatingOperationAllowed(capabilitiesForMode(mode), "activate")).toBe(true);
    }
  });

  it("a hand-built capability set with allowWrite:false but allowActivate:true still separates the two", () => {
    const caps: AbapCapabilities = {
      ...capabilitiesForMode("edit"),
      allowWrite: false,
    };
    expect(isMutatingOperationAllowed(caps, "write")).toBe(false);
    expect(isMutatingOperationAllowed(caps, "activate")).toBe(true);
  });

  it("sanity: all three modes produce a defined result for every op (no throw, no undefined)", () => {
    for (const mode of modes) {
      const caps = capabilitiesForMode(mode);
      for (const op of ["write", "activate", "delete", "execute", "transport"] as const) {
        expect(typeof isMutatingOperationAllowed(caps, op)).toBe("boolean");
      }
    }
  });
});
