/**
 * REFUSAL ATTRIBUTION — a refusal must never name a cause that is not the
 * actual cause.
 *
 * ## The defect class this closes
 *
 * The server has two configuration layers. When `ABAP_MODE` is UNSET the legacy
 * per-flag `ABAP_ALLOW_*` variables decide every capability. When `ABAP_MODE`
 * is SET, `capabilitiesForMode()` is the sole source of truth and those
 * variables are never read at all.
 *
 * The live incident: an operator running `ABAP_MODE=edit` with
 * `ABAP_ALLOW_ENHANCEMENTS=true` and `ABAP_ALLOW_ENHANCEMENT_DELETE=true` was
 * told, verbatim, that deleting an enhancement "needs BOTH
 * ABAP_ALLOW_ENHANCEMENTS=true and ABAP_ALLOW_ENHANCEMENT_DELETE=true". Both
 * were set. Neither was read. The real cause was `ABAP_MODE=edit`, and the
 * message named the one lever that could not possibly help. `src/config.ts`
 * warned about exactly this on stderr — a channel no MCP caller ever sees —
 * so the correct text and the wrong text lived in two places and only the
 * wrong one was reachable.
 *
 * That is a CLASS, not a bug: *any* refusal quoting a mode-governed legacy
 * variable is potentially misattributed, and the next capability added walks
 * straight back into it. So this file pins the class, not the string:
 * it iterates `MODE_GOVERNED_CAPABILITIES` and asserts the property for every
 * entry, present and future. A capability added to that table with a
 * hand-written refusal message fails here on the day it lands.
 *
 * ## The property, exactly
 *
 * The honest message under `ABAP_MODE` *does* name the legacy variable — to
 * rule it OUT ("Setting X will NOT work: ABAP_MODE overrides it"), which is
 * the single most useful sentence for the operator who already set it. So
 * "must not contain the name" is too blunt, and "must not read like an
 * instruction" is unfalsifiable. Instead `src/mode.ts` funnels every such
 * mention through `legacyOverriddenClause()`, and this file subtracts exactly
 * the clauses that function produces and asserts that NO mode-governed
 * variable name survives. Exact check, no regex guessing at intent.
 *
 * ## What is deliberately NOT covered
 *
 * Variables that are NOT mode-governed must keep being named, and a future
 * reader "fixing" one of them would be introducing a defect, not removing one:
 *
 *   - `ABAP_ALLOW_DATA_PREVIEW`, `ABAP_ALLOW_DUMP_VARIABLES`,
 *     `ABAP_ALLOW_DEBUG_JUMP_TO_LINE` — read in every mode; `ABAP_MODE` has no
 *     opinion about them.
 *   - the `AbapModeOverrides` list vars (`ABAP_ALLOW_PACKAGES`,
 *     `ABAP_ALLOW_NAME_PREFIXES`, `ABAP_ALLOW_TRANSPORTS`,
 *     `ABAP_ENHANCE_TARGET_PACKAGES`, `ABAP_ORIGIN_SYSTEMS`) — still honoured
 *     UNDER `ABAP_MODE`, because they only ever narrow. Telling an operator to
 *     edit one of those while a mode is set is correct advice.
 *
 * Both groups are asserted absent from `MODE_GOVERNED_LEGACY_ENV_VARS` below,
 * so the guard cannot quietly grow to cover them.
 *
 * Imports `../src/safety.js`, `../src/mode.js` and `../src/adt/*` only — no
 * `ConfigSchema.parse`/`loadConfig`/`new AbapConnection`, so this suite builds
 * no connection config and needs no entry on
 * `test/system-role-probe-guard.test.ts`'s PROBE_ALLOWLIST.
 */
import { describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { deleteEnhancementObject } from "../src/adt/enhancement-write.js";
import {
  type AbapCapabilities,
  type AbapMode,
  type AbapModeBooleanOverrides,
  capabilitiesForMode,
  capabilityGranted,
  ENHANCE_TARGETS_OVERRIDE_VALUES,
  explainDeniedCapabilities,
  explainDeniedCapability,
  legacyOverriddenClause,
  legacyUnlockClause,
  lowestModeGranting,
  MODE_GOVERNED_CAPABILITIES,
  MODE_GOVERNED_LEGACY_ENV_VARS,
  type ModeGovernedCapability,
} from "../src/mode.js";
import { ENHANCE_SAP_TARGET_REQUIREMENT, SafetyGate } from "../src/safety.js";

const MODES: readonly AbapMode[] = ["read", "edit", "admin"];

const CAPABILITIES = Object.keys(MODE_GOVERNED_CAPABILITIES) as ModeGovernedCapability[];

/**
 * Remove every sanctioned "this variable is inert" clause, then report which
 * mode-governed variable names are still mentioned. Anything this returns is a
 * hand-written mention, i.e. the defect.
 *
 * A mode-governed legacy variable has two possible sanctioned shapes today:
 * `legacyOverriddenClause` ("will NOT work") for the ordinary case, and
 * `legacyUnlockClause` ("also works, without raising the mode") for the eight
 * capabilities with a live override slot below their granting mode — seven
 * booleans via `AbapModeBooleanOverrides`, plus the enum `enhanceTargets` via
 * `AbapModeOverrides.enhanceTargets`, whose unlock clause names the actual
 * granting VALUE (`"sap"`/`"customer"`) rather than a nonexistent `=true`, and
 * whose SAP/partner branch in `src/safety.ts` additionally asks with a
 * narrower, custom label (`ENHANCE_SAP_TARGET_REQUIREMENT`). All variants are
 * stripped here, for every capability/mode(/value) combination, derived from
 * `MODE_GOVERNED_CAPABILITIES` rather than hand-listing which pair is special
 * — a string that never appears in `text` is a no-op to strip.
 *
 * Deliberately walks ALL legacy env vars in the table, not just
 * `MODE_GOVERNED_LEGACY_ENV_VARS` — that export now means something narrower
 * (only the two vars with no override slot at all, see its own doc comment in
 * src/mode.ts), and this guard's job is catching ANY mode-governed variable
 * name leaking in unsanctioned, overridable or not.
 */
const ALL_LEGACY_ENV_VARS: readonly string[] = CAPABILITIES.map(
  (c) => MODE_GOVERNED_CAPABILITIES[c].legacyEnvVar,
).filter((v): v is string => v !== null);

function unsanctionedMentions(text: string): string[] {
  let stripped = text;
  for (const v of ALL_LEGACY_ENV_VARS) {
    stripped = stripped.split(legacyOverriddenClause(v)).join(" ");
  }
  for (const cap of CAPABILITIES) {
    const info = MODE_GOVERNED_CAPABILITIES[cap];
    if (info.legacyEnvVar === null) continue;
    for (const mode of MODES) {
      if (cap === "enhanceTargets") {
        // Enum, not boolean: legacyUnlockClause's value is whichever
        // ABAP_ENHANCE_TARGETS setting actually grants it, never "true" — see
        // ENHANCE_TARGETS_OVERRIDE_VALUES (src/mode.ts).
        for (const value of ENHANCE_TARGETS_OVERRIDE_VALUES) {
          stripped = stripped
            .split(legacyUnlockClause(info.legacyEnvVar, mode, info.label, value))
            .join(" ");
        }
      } else {
        stripped = stripped.split(legacyUnlockClause(info.legacyEnvVar, mode, info.label)).join(" ");
      }
    }
  }
  // `src/safety.ts`'s SAP/partner branch asks a requirement narrower than
  // "enhanceTargets is off" (specifically "sap", via a custom label) — see
  // ENHANCE_SAP_TARGET_REQUIREMENT. Only "sap" ever satisfies it, so only
  // that value's clause needs stripping here.
  const enhanceTargetsEnvVar = MODE_GOVERNED_CAPABILITIES.enhanceTargets.legacyEnvVar;
  if (enhanceTargetsEnvVar !== null && ENHANCE_SAP_TARGET_REQUIREMENT.label !== undefined) {
    for (const mode of MODES) {
      stripped = stripped
        .split(
          legacyUnlockClause(enhanceTargetsEnvVar, mode, ENHANCE_SAP_TARGET_REQUIREMENT.label, "sap"),
        )
        .join(" ");
    }
  }
  return ALL_LEGACY_ENV_VARS.filter((v) => stripped.includes(v));
}

/** cause + remediation, the two halves that reach a caller as reason + hint. */
function fullText(e: { cause: string; remediation: string }): string {
  return `${e.cause} ${e.remediation}`;
}

/**
 * Would setting `cap`'s {@link AbapModeBooleanOverrides} field flip it from
 * denied to granted under `mode`? Mirrors `src/mode.ts`'s private
 * `overrideWouldGrant` by calling the same public `capabilitiesForMode` with
 * and without the override, rather than hand-listing which (capability,
 * mode) pairs qualify — there are seven overridable capabilities now, and
 * this test does not assume which ones.
 */
function wouldUnlock(cap: ModeGovernedCapability, mode: AbapMode): boolean {
  if (capabilityGranted(capabilitiesForMode(mode), cap)) return false;
  const unlocked = { [cap]: true } as AbapModeBooleanOverrides;
  return capabilityGranted(capabilitiesForMode(mode, {}, {}, unlocked), cap);
}

// ---------------------------------------------------------------------------
// 0. The table itself — scope of the guard
// ---------------------------------------------------------------------------

describe("the mode-governed table defines the scope of this guard", () => {
  it("covers every capability whose value differs across modes", () => {
    // Any capability that read/edit/admin disagree about is mode-governed by
    // definition and MUST be in the table — otherwise its refusals are outside
    // this guard and free to misattribute. (`allowActivate` rides on
    // `allowWrite` and has no refusal text of its own; `allowDataPreview` is
    // identical in every mode by construction, see its doc comment.)
    const varying = (Object.keys(capabilitiesForMode("admin")) as (keyof AbapCapabilities)[]).filter(
      (k) => {
        if (k === "mode") return false;
        const vals = MODES.map((m) => JSON.stringify(capabilitiesForMode(m)[k]));
        return new Set(vals).size > 1;
      },
    );
    // The `AbapModeOverrides` fields vary across modes too, but they are the
    // one group whose env vars stay LIVE under ABAP_MODE (they only narrow), so
    // naming them in a refusal is correct advice and they are out of scope by
    // definition — see the third assertion in this describe.
    const OVERRIDABLE: readonly string[] = [
      "allowPackages",
      "allowNamePrefixes",
      "allowTransports",
      "enhanceTargetPackages",
      "originSystems",
    ];
    const uncovered = varying.filter(
      (k) =>
        !(k in MODE_GOVERNED_CAPABILITIES) && k !== "allowActivate" && !OVERRIDABLE.includes(k),
    );
    expect(uncovered).toEqual([]);
  });

  it("does NOT claim the non-mode-governed flags — a message naming those is correct", () => {
    for (const v of [
      "ABAP_ALLOW_DATA_PREVIEW",
      "ABAP_ALLOW_DUMP_VARIABLES",
      "ABAP_ALLOW_DEBUG_JUMP_TO_LINE",
    ]) {
      expect(MODE_GOVERNED_LEGACY_ENV_VARS).not.toContain(v);
    }
  });

  it("does NOT claim the narrowing override lists — those are still read under ABAP_MODE", () => {
    for (const v of [
      "ABAP_ALLOW_PACKAGES",
      "ABAP_ALLOW_NAME_PREFIXES",
      "ABAP_ALLOW_TRANSPORTS",
      "ABAP_ENHANCE_TARGET_PACKAGES",
      "ABAP_ORIGIN_SYSTEMS",
    ]) {
      expect(MODE_GOVERNED_LEGACY_ENV_VARS).not.toContain(v);
    }
  });
});

// ---------------------------------------------------------------------------
// 1. THE class assertion, over every capability × every mode
// ---------------------------------------------------------------------------

describe("under a set ABAP_MODE, no refusal instructs the caller to set a legacy flag", () => {
  for (const cap of CAPABILITIES) {
    const info = MODE_GOVERNED_CAPABILITIES[cap];
    for (const mode of MODES) {
      // Only the DENIED combinations are refusals. A granted one produces no
      // message at all.
      if (capabilityGranted(capabilitiesForMode(mode), cap)) continue;

      it(`${cap} denied under ABAP_MODE=${mode}: names the mode, rules the flag out`, () => {
        const e = explainDeniedCapability(cap, mode);
        const text = fullText(e);

        // (a) It blames the thing that actually decided.
        expect(e.decidedBy).toBe("mode");
        expect(e.cause).toContain(`ABAP_MODE=${mode}`);

        // (b) It never tells the reader to set the inert variable.
        expect(unsanctionedMentions(text)).toEqual([]);
        if (info.legacyEnvVar !== null) {
          expect(text).not.toMatch(new RegExp(`Set ${info.legacyEnvVar}`));
          // The one sanctioned mention is present. For a capability with a
          // live AbapModeBooleanOverrides lever under this mode, that
          // mention says the flag ALSO works; for every other capability it
          // says the flag will NOT work — derived, not hand-listed, via
          // wouldUnlock().
          if (wouldUnlock(cap, mode)) {
            expect(text).toContain(legacyUnlockClause(info.legacyEnvVar, mode, info.label));
            expect(text).not.toContain(legacyOverriddenClause(info.legacyEnvVar));
          } else {
            expect(text).toContain(legacyOverriddenClause(info.legacyEnvVar));
          }
        }

        // (c) It names the lever that DOES work, derived from the ladder rather
        // than hand-written, so a re-tiered capability moves the text with it.
        const granting = lowestModeGranting(cap);
        if (granting !== undefined) {
          expect(e.grantingMode).toBe(granting);
          expect(text).toContain(`ABAP_MODE=${granting}`);
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 1b. enhanceTargets specifically: ENHANCE_TARGETS_OVERRIDE_VALUES is
//     least-privilege-first, and .find() must not silently over-grant
// ---------------------------------------------------------------------------

/**
 * Pins the ORDER of `ENHANCE_TARGETS_OVERRIDE_VALUES`, not just its contents.
 *
 * `legacyClauseFor` → `enhanceTargetsGrantingValue` picks the FIRST candidate
 * in that array satisfying the caller's predicate. For the generic "is
 * enhanceTargets off" predicate (the one every plain `enhanceTargets` denial
 * uses — e.g. an operator on ABAP_MODE=edit who narrowed
 * ABAP_ENHANCE_TARGETS=none via the override), BOTH "customer" and "sap"
 * satisfy it, so array order alone decides which value the operator is told
 * to set. Listing "sap" first would recommend the widest grant for a reader
 * who may only need "customer" — over-granting relative to what actually
 * unblocks them. This test fails immediately if that order regresses.
 *
 * The SAP/partner-specific requirement (`ENHANCE_SAP_TARGET_REQUIREMENT`) is
 * unaffected by the order: its `satisfiedBy` is `=== "sap"` specifically, so
 * "customer" never satisfies it regardless of scan position. Pinned here too,
 * so a future reader touching the array order has both outcomes in one place.
 */
describe("ENHANCE_TARGETS_OVERRIDE_VALUES is least-privilege-first", () => {
  it("a generic enhanceTargets denial under ABAP_MODE=edit recommends customer, not sap", () => {
    const e = explainDeniedCapability("enhanceTargets", "edit");
    expect(e.remediation).toContain("ABAP_ENHANCE_TARGETS=customer");
    expect(e.remediation).not.toContain("ABAP_ENHANCE_TARGETS=sap");
  });

  it("the SAP/partner-specific requirement under ABAP_MODE=edit still recommends sap", () => {
    const e = explainDeniedCapability(ENHANCE_SAP_TARGET_REQUIREMENT, "edit");
    expect(e.remediation).toContain("ABAP_ENHANCE_TARGETS=sap");
    expect(e.remediation).not.toContain("ABAP_ENHANCE_TARGETS=customer");
  });
});

describe("under legacy config (ABAP_MODE unset), the refusal DOES name the flag", () => {
  for (const cap of CAPABILITIES) {
    const info = MODE_GOVERNED_CAPABILITIES[cap];
    it(`${cap}: ${info.legacyEnvVar ?? "no legacy variable"}`, () => {
      const e = explainDeniedCapability(cap, undefined);
      const text = fullText(e);
      expect(e.decidedBy).toBe("legacy");
      // The inverse of the assertion above: here the variable really is the
      // lever, so a message that failed to name it would be the same defect
      // pointing the other way.
      if (info.legacyEnvVar !== null) {
        expect(text).toContain(info.legacyEnvVar);
        expect(text).toMatch(new RegExp(`Set ${info.legacyEnvVar}`));
      } else {
        // No legacy variable exists — it must say so and point at ABAP_MODE
        // rather than inventing a flag name.
        expect(text).toMatch(/no legacy environment variable|ABAP_MODE/);
      }
      // Never the mode-overrides clause: nothing is overriding anything here.
      for (const v of MODE_GOVERNED_LEGACY_ENV_VARS) {
        expect(text).not.toContain(legacyOverriddenClause(v));
      }
    });
  }
});

describe("multi-capability refusals ('needs BOTH') obey the same property", () => {
  // The exact shape of the original incident: two flags named at once.
  const PAIRS: ReadonlyArray<readonly [ModeGovernedCapability, ModeGovernedCapability]> = [
    ["allowEnhancements", "allowEnhancementDelete"],
    ["allowWrite", "allowTransportRelease"],
    ["allowWrite", "allowTransportDelete"],
    ["allowEnhancements", "allowSourcePlugins"],
  ];
  for (const pair of PAIRS) {
    for (const mode of MODES) {
      if (pair.every((c) => capabilityGranted(capabilitiesForMode(mode), c))) continue;
      it(`${pair.join(" + ")} under ABAP_MODE=${mode}`, () => {
        const text = fullText(explainDeniedCapabilities(pair, mode));
        expect(unsanctionedMentions(text)).toEqual([]);
        // One mode value clears both — never two separate flag instructions.
        expect(text).not.toMatch(/needs BOTH/);
      });
    }
  }

  it("legacy config keeps the 'neither implies the other' advice", () => {
    const text = fullText(
      explainDeniedCapabilities(["allowEnhancements", "allowEnhancementDelete"], undefined),
    );
    expect(text).toContain("Set ABAP_ALLOW_ENHANCEMENTS=true");
    expect(text).toContain("Set ABAP_ALLOW_ENHANCEMENT_DELETE=true");
  });
});

// ---------------------------------------------------------------------------
// 2. End-to-end: the real refusal paths, not just the helper
// ---------------------------------------------------------------------------

/**
 * A gate configured exactly as `server.ts` configures it from a mode — the
 * capabilities come from `capabilitiesForMode()`, so these are the real
 * mode-derived refusals and not a hand-picked config that happens to deny.
 */
function gateForMode(mode: AbapMode, patch: Record<string, unknown> = {}): SafetyGate {
  const caps = capabilitiesForMode(mode, {
    allowPackages: ["$TMP", "Z*"],
    allowNamePrefixes: ["Z", "$"],
    originSystems: ["A4H"],
  });
  return new SafetyGate({
    readOnly: !caps.allowWrite,
    allowPackages: [...caps.allowPackages],
    allowNamePrefixes: [...caps.allowNamePrefixes],
    allowTransports: caps.allowTransports === null ? [] : [...caps.allowTransports],
    allowTransportRelease: caps.allowTransportRelease,
    allowTransportDelete: caps.allowTransportDelete,
    allowEnhancements: caps.allowEnhancements,
    enhanceTargets: caps.enhanceTargets,
    enhanceTargetPackages: [...caps.enhanceTargetPackages],
    originSystems: [...caps.originSystems],
    allowCascadeDelete: caps.allowCascadeDelete,
    // Non-productive and probe-proven, so the system-role gate never fires and
    // every refusal below is genuinely the mode gate talking.
    productive: false,
    writesLockedOut: false,
    systemRole: "sandbox",
    sid: "A4H",
    abapMode: mode,
    ...patch,
  });
}

const target = { name: "ZCL_ORDER", packageName: "ZSD", type: "CLAS/OC" };

const intent = {
  enhancementName: "ZENH_ORDER",
  enhancementPackage: "$TMP",
  spotName: "ZSPOT_ORDER",
  targetName: "ZCL_ORDER",
  targetPackage: "ZSD",
  targetMasterSystem: "A4H",
};

describe("SafetyGate refusals carry the same attribution end to end", () => {
  for (const mode of MODES) {
    it(`every mode-gate refusal under ABAP_MODE=${mode} is attributed to the mode`, () => {
      const g = gateForMode(mode);
      const decisions = [
        g.evaluate("write", target),
        g.evaluate("delete", target),
        g.evaluate("transport", target, { release: true }),
        g.evaluate("transport", target, { deleteTransport: true }),
        g.evaluateIntent(intent),
        g.evaluateIntent({ ...intent, targetPackage: "SAPMV45A", targetMasterSystem: "SAP" }),
      ];
      const refusals = decisions.filter((d) => !d.allowed);
      // Sanity: `read` denies everything, `admin` still denies the SAP-target
      // intent only via packages, so there is always something to inspect
      // except where the mode legitimately allows all of it.
      for (const d of refusals) {
        expect(unsanctionedMentions(d.reason)).toEqual([]);
      }
    });
  }

  it("ABAP_MODE=edit refusing enhancement work never re-recommends the flags that are already set", () => {
    // The incident, replayed at the gate: edit grants enhancements but not the
    // SAP target class, and edit grants writes but not release/delete.
    const g = gateForMode("edit");
    const sapIntent = g.evaluateIntent({
      ...intent,
      targetPackage: "SAPMV45A",
      targetMasterSystem: "SAP",
    });
    expect(sapIntent.allowed).toBe(false);
    expect(unsanctionedMentions(sapIntent.reason)).toEqual([]);
    expect(sapIntent.reason).toContain("ABAP_MODE=admin");
    // ABAP_ENHANCE_TARGET_PACKAGES is an OVERRIDE list, still read under a
    // mode, so naming it here is correct and must survive the strip.
    expect(sapIntent.reason).toContain("ABAP_ENHANCE_TARGET_PACKAGES");

    const release = g.evaluate("transport", target, { release: true });
    expect(release.allowed).toBe(false);
    expect(unsanctionedMentions(release.reason)).toEqual([]);
    expect(release.reason).toContain("ABAP_MODE=admin");
  });

  it("legacy config at the gate still names the flags (the inverse case)", () => {
    // No abapMode on the gate → legacy configuration → the flags ARE the lever.
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP", "Z*"],
      productive: false,
      writesLockedOut: false,
    });
    const d = g.evaluateIntent(intent);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/Set ABAP_ALLOW_ENHANCEMENTS=true/);
  });
});

describe("deleteEnhancementObject — the refusal that started this", () => {
  // The gate and connection are never reached: the capability check runs before
  // any network call, which is what makes this assertable offline.
  const conn = null as unknown as AbapConnection;
  const gate = null as unknown as SafetyGate;

  it("under ABAP_MODE=edit it blames the mode, not the two flags the operator set", async () => {
    await expect(
      deleteEnhancementObject(
        conn,
        gate,
        { type: "ENHO/XH", name: "ZENH_ORDER" },
        { allowEnhancementDelete: false, abapMode: "edit" },
      ),
    ).rejects.toMatchObject({
      code: "ENHANCEMENT_DISABLED",
      details: { decidedBy: "mode", abapMode: "edit" },
    });

    const err = await deleteEnhancementObject(
      conn,
      gate,
      { type: "ENHO/XH", name: "ZENH_ORDER" },
      { allowEnhancementDelete: false, abapMode: "edit" },
    ).catch((e: unknown) => e as { message: string; hint?: string });

    const text = `${err.message} ${err.hint ?? ""}`;
    expect(unsanctionedMentions(text)).toEqual([]);
    expect(text).toContain("ABAP_MODE=edit");
    expect(text).toContain("ABAP_MODE=admin");
    // `allowEnhancementDelete` has a live AbapModeBooleanOverrides lever, so
    // under ABAP_MODE=edit the honest sentence is now that the flag ALSO
    // works (legacyUnlockClause), not that it is inert
    // (legacyOverriddenClause) — the incident's own flag was correct all
    // along; only ABAP_MODE=edit alone did not grant it yet.
    expect(text).toContain(
      legacyUnlockClause(
        "ABAP_ALLOW_ENHANCEMENT_DELETE",
        "edit",
        MODE_GOVERNED_CAPABILITIES.allowEnhancementDelete.label,
      ),
    );
    expect(text).not.toContain(legacyOverriddenClause("ABAP_ALLOW_ENHANCEMENT_DELETE"));
  });

  it("under legacy config it still names ABAP_ALLOW_ENHANCEMENT_DELETE as the lever", async () => {
    const err = await deleteEnhancementObject(
      conn,
      gate,
      { type: "ENHO/XH", name: "ZENH_ORDER" },
      { allowEnhancementDelete: false },
    ).catch((e: unknown) => e as { message: string; hint?: string; details?: unknown });

    const text = `${err.message} ${err.hint ?? ""}`;
    expect(text).toMatch(/Set ABAP_ALLOW_ENHANCEMENT_DELETE=true/);
    expect(text).not.toContain("ABAP_MODE overrides it");
    expect(err.details).toMatchObject({ decidedBy: "legacy" });
  });
});
