/**
 * Zero-network pure functions of the raw tool ARGUMENTS, shared by every
 * gated registrar (write, activate, run, test, debug). A refused write must
 * cost ZERO requests, so neither function may ever grow a resolve round trip.
 *
 * RULE: any registrar whose object `type` can be an enhancement type
 * (`isEnhancementType()`, src/safety.ts — ENHO/ENHS/ENHC/ENHP heads) MUST
 * pass `intent: enhancementPreflightIntent(...)` alongside every
 * `preflight()`-derived `assert()` call — a live A4H incident showed
 * `abap_activate` silently refusing well-formed `affects` because this
 * pairing was skipped in one registrar. See
 * the git history for the full incident and the
 * reasoning behind co-locating these two helpers.
 */
import { enhancementIntentFor, type EnhancedObjectRef } from "../adt/write.js";
import { parseObjectRef } from "../adt/resolve.js";
import { specForType } from "../adt/types.js";
import { isEnhancementType } from "../safety.js";
import type { EnhancementIntent } from "../safety.js";

/**
 * What the gate can know from the raw arguments alone — no connection, no
 * resolution, no network. `package` is only present when the caller named one;
 * the package rules are re-checked against the resolved object inside the tool.
 */
export function preflight(args: { object: string; type?: string; package?: string }): {
  name: string;
  packageName?: string;
  superPackage?: string;
  type?: string;
} {
  const parsed = parseObjectRef(args.object, specForType(args.type));
  const type = args.type ?? parsed.spec?.type;
  // DEVC/K: a package's own package is ITSELF; caller's `package` is the
  // SUPERpackage (ADT's separate `<pak:superPackage>`, not `adtcore:packageRef`).
  // Do not feed superPackage in as packageName — it gates the wrong object
  // (e.g. refuses ZSD_ORDER for sitting under SAP-named parent COURSES).
  // superPackage is passed separately for the package allowlist check.
  // Mirrors resolveWriteTarget's create branch — see archive for full reasoning.
  if (type === "DEVC/K") {
    return {
      name: parsed.name,
      packageName: parsed.name,
      type,
      ...(args.package?.trim() ? { superPackage: args.package.trim().toUpperCase() } : {}),
    };
  }
  return { name: parsed.name, packageName: args.package, type };
}

/**
 * {@link ObjectGate} key for a write, derived from raw arguments alone — the
 * real ADT URI isn't known until the tool resolves it. Upper-cased so
 * `zcl_foo`/`ZCL_FOO` share one gate slot. Deliberately not a `resolve()`
 * round trip: that would show up in every golden wire trace in
 * test/pool-characterization.test.ts. `undefined` (no name) means "take a
 * slot, no gate" — the documented `withWrite` contract. `type` disambiguates
 * `PARENT/NAME` function-module addressing so `FG/FM`, `FM in FG`, and bare
 * `FM` all land on the same gate slot (the bare name), since FM names are
 * system-wide unique.
 */
export function writeGateKey(object: string, type?: string): string | undefined {
  const name = parseObjectRef(object, specForType(type)).name.trim().toUpperCase();
  return name.length > 0 ? name : undefined;
}

/**
 * Builds the {@link EnhancementIntent} for the registrar's zero-network
 * `preflight()` `assert()` call. `undefined` for non-enhancement types, or
 * when `affects` is missing (a missing `affects` must still be refused, by
 * the intent-less branch — not silently skipped).
 *
 * `enhancementPackage: ""` is deliberate: at preflight time the artefact's
 * own package isn't known yet (it may not exist), and `enhancementRules()`
 * never consults it — only `affects`. Mirrors `abap_enh`'s own preflight
 * intent (src/tools/enh.ts).
 *
 * Still re-exported from `src/tools/write.ts` for backward compatibility.
 */
export function enhancementPreflightIntent(pf: {
  name: string;
  type?: string;
  affects?: EnhancedObjectRef;
}): EnhancementIntent | undefined {
  if (!isEnhancementType(pf.type) || !pf.affects) return undefined;
  return enhancementIntentFor({ name: pf.name, type: pf.type ?? "", packageName: "" }, pf.affects);
}
