/**
 * `ABAP_MODE` — the single-env-var permission tier.
 *
 * Resolves `ABAP_MODE` (`"read"`|`"edit"`|`"admin"`) ONCE at startup into a
 * frozen {@link AbapCapabilities} object. Layer 1 of a 3-layer safety design:
 *   1. THIS FILE — env var → capability ceiling.
 *   2. `AuthorizedTarget` structural gate (landing separately) — type-level
 *      proof a mutating call was authorized; consumes whatever Layer 1
 *      decided but this file doesn't implement or know about it.
 *   3. `PreToolUse` hook — a standalone script outside this Node process,
 *      deliberately NOT importing this module (see "Decoupling" below).
 *
 * `capabilitiesForMode()` decides whether an operation is even ATTEMPTED,
 * not whether a specific target is safe — fine-grained per-target checks
 * (package/name/transport allowlists) stay in `src/safety.ts`'s
 * `SafetyGate`, unaffected by this module.
 *
 * **Hard invariant: `read` mode never mutates, structurally.**
 * `capabilitiesForMode("read", …)` early-returns a fixed all-deny object
 * before `overrides`/`boolOverrides` are read at all, for every possible
 * argument — see the early return in the function body. The separate
 * `grants` argument ({@link AbapModeGrants}) IS consulted under `read`, but
 * can only switch on strictly non-mutating capabilities (today: data preview).
 *
 * Decoupling: the `PreToolUse` hook conceptually wants the same answer this
 * file computes but is a separate script that does not import this module —
 * if its notion of what a mode permits changes, it must be changed there too.
 */

/** The three permission tiers `ABAP_MODE` may select. */
export type AbapMode = "read" | "edit" | "admin";

/**
 * The legal values of `ABAP_ENHANCE_TARGETS` / {@link AbapCapabilities.enhanceTargets}
 * — single source of truth. `src/config.ts` reads this array for both the
 * zod schema enum and its own hand-rolled validation/error-message text
 * rather than repeating the three literals a third time; adding a tier is a
 * one-line change here.
 */
export const ENHANCE_TARGETS_VALUES = ["none", "customer", "sap"] as const;

/** The three legal values of `ABAP_ENHANCE_TARGETS` / {@link AbapCapabilities.enhanceTargets}. */
export type EnhanceTargetsValue = (typeof ENHANCE_TARGETS_VALUES)[number];

/**
 * Frozen result of resolving `ABAP_MODE` (plus optional overrides) into a
 * concrete permission set. Nothing here reaches the wire directly — it is
 * the ceiling `src/safety.ts` (and later Layer 2) judges operations against.
 */
export interface AbapCapabilities {
  /** The mode this capability set was resolved from. */
  readonly mode: AbapMode;
  /** Any source write reaches the wire at all. */
  readonly allowWrite: boolean;
  /** Activation reaches the wire. */
  readonly allowActivate: boolean;
  /** Package allowlist for writes. `*`-wildcard shape, matching `src/safety.ts`. */
  readonly allowPackages: readonly string[];
  /** Object name-prefix allowlist. */
  readonly allowNamePrefixes: readonly string[];
  /** Transport allowlist. `null` = deny all transportable writes. */
  readonly allowTransports: readonly string[] | null;
  /** Releasing a transport request. Defaults to admin-only; two-way overridable — see {@link AbapModeBooleanOverrides}. */
  readonly allowTransportRelease: boolean;
  /** Transport delete/setOwner/addUser-class operations. Defaults to admin-only; two-way overridable. */
  readonly allowTransportDelete: boolean;
  /** BAdI/enhancement-spot source writes. Defaults on from edit upward; two-way overridable. */
  readonly allowEnhancements: boolean;
  /** Which *enhanced* (affected) objects may be targeted. */
  readonly enhanceTargets: EnhanceTargetsValue;
  /** Package allowlist for the *enhanced* (affected) object, consulted when `enhanceTargets === "sap"`. */
  readonly enhanceTargetPackages: readonly string[];
  /**
   * Creating `enhoxhh` source-plugin hooks. Defaults on from `edit` upward
   * (NOT admin-only) — the host object is already policed via
   * `enhanceTargets`/`enhanceTargetPackages` in `createHookImplementation`'s
   * `gate.authorizeIntent` call. Two-way overridable — see
   * {@link AbapModeBooleanOverrides}.
   */
  readonly allowSourcePlugins: boolean;
  /**
   * Deleting an existing `ENHO/XH(H)`/`ENHS/XS` object outright. Independent
   * of `allowEnhancements`. Irreversible (undo refused unconditionally, see
   * `src/adt/undo.ts`), so defaults admin-only, same as `allowCascadeDelete`
   * — but two-way overridable via {@link AbapModeBooleanOverrides}. An
   * override does NOT bypass the unconditional active-BAdI-implementation
   * delete refusal in `deleteEnhancementObject`
   * (`src/adt/enhancement-write.ts`); this field only decides whether the
   * delete PATH is attempted at all.
   */
  readonly allowEnhancementDelete: boolean;
  /** Cascade DDIC delete. Defaults to admin-only; two-way overridable. */
  readonly allowCascadeDelete: boolean;
  /**
   * Non-GET `abap_adt` passthrough. Defaults to admin-only; two-way
   * overridable. No consumer yet — the `abap_adt` tool does not exist in
   * this codebase; computed and frozen here ready for that tool to read
   * once it lands.
   */
  readonly allowRawAdtWrites: boolean;
  /** SIDs whose content counts as locally originated for enhancement-target judging. */
  readonly originSystems: readonly string[];
  /**
   * DDIC table/view row preview (`abap_data_preview`). The ONE field here
   * that is not a mutation ceiling — a preview is a read, so its value comes
   * from the operator's `ABAP_ALLOW_DATA_PREVIEW` grant
   * ({@link AbapModeGrants}), not from `mode`. `true` in EVERY mode
   * (`read` included) when the operator set it; `read` must not force it
   * off. Grants no write/activate/transport, and the deny-list plus
   * productive-system ceiling in `src/safety.ts` still judge every table.
   */
  readonly allowDataPreview: boolean;
}

/**
 * Narrower overrides {@link capabilitiesForMode} accepts — allowlist- or
 * enum-replacement-shaped fields, each REPLACING the mode default outright
 * (not merged, not a ceiling) when the operator sets it. Boolean ceilings
 * have their own, separate two-way bag — see {@link AbapModeBooleanOverrides}.
 * Enforced at the type level via excess-property checks on object literals.
 */
export interface AbapModeOverrides {
  readonly allowPackages?: readonly string[];
  readonly allowNamePrefixes?: readonly string[];
  readonly allowTransports?: readonly string[] | null;
  readonly enhanceTargets?: EnhanceTargetsValue;
  readonly enhanceTargetPackages?: readonly string[];
  readonly originSystems?: readonly string[];
}

/**
 * Non-mutating capabilities the operator switches on independently of
 * `ABAP_MODE` — a separate bag from {@link AbapModeOverrides} because it
 * WIDENS (honoured even under `read`), whereas overrides may only narrow.
 * Merging the two would put a widening knob inside the structure whose job
 * is to prove no widening knob exists. Anything added here in future must be
 * strictly non-mutating and correct to honour even under `read`.
 */
export interface AbapModeGrants {
  /**
   * `ABAP_ALLOW_DATA_PREVIEW`. Off unless the operator explicitly set it; on
   * in every mode when they did. See `AbapCapabilities.allowDataPreview`.
   */
  readonly allowDataPreview?: boolean;
}

/**
 * Two-way overrides for every boolean capability: unset takes the
 * mode-derived default, `true` grants, `false` denies. Structurally
 * unreachable under `read` — the same early-return in
 * {@link capabilitiesForMode} that shields {@link AbapModeOverrides} shields
 * this bag too, so none of these fields is ever consulted there.
 */
export interface AbapModeBooleanOverrides {
  readonly allowTransportRelease?: boolean;
  readonly allowTransportDelete?: boolean;
  readonly allowCascadeDelete?: boolean;
  readonly allowRawAdtWrites?: boolean;
  readonly allowEnhancements?: boolean;
  readonly allowSourcePlugins?: boolean;
  readonly allowEnhancementDelete?: boolean;
}

/**
 * Resolve `ABAP_MODE` from a raw env string.
 *
 * Throws for every invalid input — unset, empty/whitespace, or anything not
 * `"read"`/`"edit"`/`"admin"` case-insensitively. No silent fallback: what an
 * unset `ABAP_MODE` means (e.g. fall back to legacy per-flag config) is the
 * caller's decision, not a default baked in here — quietly returning
 * `undefined` for both "unset" and "typo'd garbage" would let a misspelled
 * `ABAP_MODE=redd` fall through unnoticed.
 */
export function parseAbapMode(raw: string | undefined): AbapMode | undefined {
  if (raw === undefined) {
    throw new Error(
      'ABAP_MODE is not set. Valid values are "read", "edit", or "admin" (case-insensitive). ' +
        "This function does not apply a default for an unset value — the caller decides what " +
        "an unset ABAP_MODE means (e.g. falling back to legacy per-flag config).",
    );
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error(
      'ABAP_MODE is set but empty (or whitespace-only). Valid values are "read", "edit", or ' +
        '"admin" (case-insensitive).',
    );
  }
  const lower = trimmed.toLowerCase();
  if (lower === "read" || lower === "edit" || lower === "admin") {
    return lower;
  }
  throw new Error(
    `ABAP_MODE=${JSON.stringify(raw)} is not a recognised mode. Valid values are "read", "edit", ` +
      'or "admin" (case-insensitive).',
  );
}

/** `edit`/`admin` mode's transport DEFAULT — any caller-named request. Not a ceiling; see {@link resolveTransports}. */
const EDIT_TRANSPORT_DEFAULT: readonly string[] = ["*"];

/**
 * `edit` mode's package default: match-anything. `*` is expanded to `.*` by
 * `packagePattern` in `src/safety.ts`. See {@link resolvePackages}.
 */
const EDIT_PACKAGE_DEFAULT: readonly string[] = ["*"];

/** `edit`/`admin` mode's object-name-prefix default: match-anything. See {@link resolveNamePrefixes}. */
const EDIT_NAME_PREFIX_DEFAULT: readonly string[] = ["*"];

/**
 * Resolve the effective `allowPackages` list. Unset takes
 * {@link EDIT_PACKAGE_DEFAULT}; an override replaces it outright, no
 * `$TMP` union; `[]` stays deny-all.
 */
function resolvePackages(override: readonly string[] | undefined): readonly string[] {
  return override === undefined ? [...EDIT_PACKAGE_DEFAULT] : [...override];
}

/**
 * Resolve the effective `allowNamePrefixes` list. Unset or explicitly `[]`
 * both take {@link EDIT_NAME_PREFIX_DEFAULT} — unlike packages/transports,
 * where `[]` is a real deny-all, an empty prefix list has no distinct
 * meaning to fold to (`ABAP_ALLOW_PACKAGES=`/`ABAP_MODE=read` already cover
 * deny-all-writes), and this mirrors `src/config.ts`'s legacy-path fold
 * Any other override, including `["*"]`, replaces the default outright.
 */
function resolveNamePrefixes(override: readonly string[] | undefined): readonly string[] {
  return override === undefined || override.length === 0
    ? [...EDIT_NAME_PREFIX_DEFAULT]
    : [...override];
}

/**
 * Resolve the effective `allowTransports` list. Unset ⇒ `["*"]`
 * ({@link EDIT_TRANSPORT_DEFAULT}, any caller-named request); an override
 * REPLACES it outright — not a ceiling — so `["auto"]` narrows back down to
 * auto-select/auto-create only; `[]` and `null` both stay deny-all.
 */
function resolveTransports(
  override: readonly string[] | null | undefined,
): readonly string[] | null {
  if (override === undefined) return [...EDIT_TRANSPORT_DEFAULT];
  if (override === null) return null;
  return [...override];
}

/**
 * Resolve the effective `enhanceTargets` value. Unset ⇒ the mode
 * default (`"sap"` for admin, `"customer"` otherwise); an override REPLACES
 * that default outright, in EITHER direction — an `edit` operator may widen
 * to `"sap"`, an `admin` operator may narrow to `"customer"` or `"none"`.
 * A mode is a default, not a ceiling: this mirrors every other list-shaped
 * field above, none of which treat the mode-derived value as a maximum.
 */
function resolveEnhanceTargets(
  override: EnhanceTargetsValue | undefined,
  isAdmin: boolean,
): EnhanceTargetsValue {
  return override ?? (isAdmin ? "sap" : "customer");
}

/**
 * Resolve the effective `enhanceTargetPackages` list. Unrestricted ceiling,
 * default `[]` (deny-all, mirroring `ABAP_ENHANCE_TARGET_PACKAGES`). The one
 * override an `admin` operator actually needs: `enhanceTargets: "sap"`
 * enhances nothing until a package is named here too (`src/safety.ts`).
 */
function resolveEnhanceTargetPackages(override: readonly string[] | undefined): readonly string[] {
  return override === undefined ? [] : [...override];
}

/**
 * Resolve the effective `originSystems` list.
 *
 * Unrestricted ceiling, same shape as {@link resolveEnhanceTargetPackages}:
 * default `[]` (nothing counts as locally originated), override replaces it
 * outright when supplied.
 */
function resolveOriginSystems(override: readonly string[] | undefined): readonly string[] {
  return override === undefined ? [] : [...override];
}

/** `Object.freeze` the capability object AND every array-valued field on it. */
function freezeCapabilities(caps: AbapCapabilities): AbapCapabilities {
  Object.freeze(caps.allowPackages);
  Object.freeze(caps.allowNamePrefixes);
  // `Object.freeze(null)` is a documented no-op per spec (freezing a non-object
  // simply returns it), so this is safe to call unconditionally.
  Object.freeze(caps.allowTransports);
  Object.freeze(caps.enhanceTargetPackages);
  Object.freeze(caps.originSystems);
  return Object.freeze(caps);
}

/**
 * The fixed, all-deny `read`-mode capability set. Declared once at module
 * scope so there is exactly one literal in this file that could ever
 * accidentally enable a `read`-mode capability.
 */
const READ_CAPABILITIES: AbapCapabilities = freezeCapabilities({
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

/**
 * `read` mode with the one non-mutating grant switched on — see
 * {@link AbapModeGrants}. Built by spreading {@link READ_CAPABILITIES} and
 * overwriting one boolean, so every mutating field still traces to the
 * single all-deny literal.
 */
const READ_CAPABILITIES_WITH_PREVIEW: AbapCapabilities = freezeCapabilities({
  ...READ_CAPABILITIES,
  allowDataPreview: true,
});

/**
 * Pure, total function: resolve a validated {@link AbapMode} plus optional
 * overrides into a frozen capability set.
 *
 * `mode === "read"` ignores `overrides`/`boolOverrides` ENTIRELY (enforced
 * via an early return, not an empty-merge, so a maintainer editing a merge
 * helper cannot accidentally widen it) and always returns all-deny for
 * every mutating field — the safety invariant the whole design rests on.
 *
 * `grants` IS consulted under `read` — it can only switch on strictly
 * non-mutating capabilities (today: data preview), so it never touches the
 * invariant above; it selects between two frozen constants, never merges.
 *
 * List-shaped fields (`allowPackages`/`allowNamePrefixes`/`allowTransports`/
 * `enhanceTargetPackages`/`originSystems`) and the enum-shaped `enhanceTargets`
 * all take a mode-derived default when unset and an override that REPLACES
 * outright otherwise — see each `resolve*` helper above. Boolean fields work
 * the same way but two-way — see {@link AbapModeBooleanOverrides}.
 */
export function capabilitiesForMode(
  mode: AbapMode,
  overrides: AbapModeOverrides = {},
  grants: AbapModeGrants = {},
  boolOverrides: AbapModeBooleanOverrides = {},
): AbapCapabilities {
  if (mode === "read") {
    // Structural invariant: nothing below this line runs for "read".
    // `overrides`/`boolOverrides` are never consulted — see the file-level
    // doc comment. `grants.allowDataPreview` only picks between two frozen
    // all-deny constants; it cannot introduce a value.
    return grants.allowDataPreview === true ? READ_CAPABILITIES_WITH_PREVIEW : READ_CAPABILITIES;
  }

  const isAdmin = mode === "admin";

  const allowPackages = resolvePackages(overrides.allowPackages);
  const allowNamePrefixes = resolveNamePrefixes(overrides.allowNamePrefixes);
  const allowTransports = resolveTransports(overrides.allowTransports);
  const enhanceTargetPackages = resolveEnhanceTargetPackages(overrides.enhanceTargetPackages);
  const originSystems = resolveOriginSystems(overrides.originSystems);

  return freezeCapabilities({
    mode,
    allowWrite: true,
    allowActivate: true,
    allowPackages,
    allowNamePrefixes,
    allowTransports,
    allowTransportRelease: boolOverrides.allowTransportRelease ?? isAdmin,
    allowTransportDelete: boolOverrides.allowTransportDelete ?? isAdmin,
    allowEnhancements: boolOverrides.allowEnhancements ?? true,
    enhanceTargets: resolveEnhanceTargets(overrides.enhanceTargets, isAdmin),
    enhanceTargetPackages,
    allowSourcePlugins: boolOverrides.allowSourcePlugins ?? true,
    allowEnhancementDelete: boolOverrides.allowEnhancementDelete ?? isAdmin,
    allowCascadeDelete: boolOverrides.allowCascadeDelete ?? isAdmin,
    allowRawAdtWrites: boolOverrides.allowRawAdtWrites ?? isAdmin,
    originSystems,
    // Operator's grant, identically in every mode — see AbapModeGrants.
    allowDataPreview: grants.allowDataPreview === true,
  });
}

/**
 * Coarse mutating-operation categories. Intentionally NOT imported from
 * `src/safety.ts`'s `Operation` type (which also includes `"read"`/
 * `"analyze"`) — this file is self-contained, see decoupling above.
 */
export type CoarseMutatingOperation = "write" | "activate" | "delete" | "execute" | "transport";

/**
 * Coarse predicate: does this capability set permit *any* instance of this
 * operation category at all? Mirrors `SafetyGate.evaluate()`: `write`/
 * `delete`/`execute`/`transport` are gated uniformly via `allowWrite`;
 * `activate` has its own boolean (`allowActivate`). Finer-grained ceilings
 * (`allowCascadeDelete`, `allowTransportRelease`, …) are NOT checked here —
 * that stays in `SafetyGate`.
 *
 * **Not wired into the `activate` call path.** `src/tools/activate.ts`
 * gates via `SafetyGate`'s `readOnly` ceiling today, not through this
 * function — `allowActivate` never diverges from `allowWrite` in any mode
 * this codebase supports, so wiring it in today would be a no-op. The real
 * Layer 1 → Layer 2 wiring (flattening `capabilitiesForMode()` onto
 * `Config`/`SafetyGate`, as already done for `allowTransportRelease` etc.)
 * is a separate, larger change, tracked alongside `allowRawAdtWrites` and
 * the `abap_adt` tool landing.
 */
export function isMutatingOperationAllowed(
  caps: AbapCapabilities,
  op: CoarseMutatingOperation,
): boolean {
  switch (op) {
    case "write":
    case "delete":
    case "execute":
    case "transport":
      return caps.allowWrite;
    case "activate":
      return caps.allowActivate;
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}

// ===========================================================================
// Why a denied capability was denied — the ONE place that answers it
// ===========================================================================
//
// Incident: a refusal once told an operator to set ABAP_ALLOW_ENHANCEMENTS
// and ABAP_ALLOW_ENHANCEMENT_DELETE, who had already set both — because
// under ABAP_MODE, capabilitiesForMode() is the sole source of truth and the
// env var is never read. The refusal string and config.ts's (correct, but
// stderr-only) deprecation warning were two independent copies of the same
// fact, and they drifted. Full incident text: the git history.
//
// Fix: keep ONE copy. {@link MODE_GOVERNED_CAPABILITIES} is the single table
// of which capabilities ABAP_MODE decides outright; config.ts's warning list
// (`MODE_GOVERNED_LEGACY_ENV_VARS`) derives from it. The mode that WOULD
// grant a capability is never hand-written — {@link lowestModeSatisfying}
// computes it by calling capabilitiesForMode() itself.
//
// NOT in the table: allowDataPreview, allowDumpVariables,
// allowDebugJumpToLine (never mode-governed — config.ts always reads their
// env vars regardless of ABAP_MODE); allowActivate (mode-derived but no
// legacy var; its refusals ride the allowWrite entry); the list-shaped vars
// ABAP_ALLOW_PACKAGES/ABAP_ALLOW_NAME_PREFIXES/ABAP_ALLOW_TRANSPORTS/
// ABAP_ENHANCE_TARGET_PACKAGES/ABAP_ORIGIN_SYSTEMS (still live as
// AbapModeOverrides in every mode, so naming them stays correct).
//
// The seven boolean capabilities plus enhanceTargets stay IN the
// table but are not fully dead once ABAP_MODE is set: the seven booleans are
// re-consulted via AbapModeBooleanOverrides, and enhanceTargets via its
// AbapModeOverrides field, each a live, two-way (or, for enhanceTargets,
// three-way) lever. explainDeniedCapability/explainDeniedCapabilities
// compute, per call, whether the override would change the outcome
// (legacyUnlockClause vs legacyOverriddenClause) rather than hand-carving
// capabilities out.

/**
 * The capabilities whose value `ABAP_MODE` decides OUTRIGHT when it is set —
 * i.e. exactly those for which the legacy env var below is not consulted at
 * all. Constrained to `keyof AbapCapabilities` so a typo cannot name a field
 * that does not exist (it would be `Extract`ed away and then fail the
 * exhaustive `Record` below).
 */
export type ModeGovernedCapability = Extract<
  keyof AbapCapabilities,
  | "allowWrite"
  | "allowTransportRelease"
  | "allowTransportDelete"
  | "allowEnhancements"
  | "enhanceTargets"
  | "allowSourcePlugins"
  | "allowEnhancementDelete"
  | "allowCascadeDelete"
  | "allowRawAdtWrites"
>;

/** What {@link MODE_GOVERNED_CAPABILITIES} records about one capability. */
export interface ModeGovernedCapabilityInfo {
  /**
   * Env var that decides this capability when `ABAP_MODE` is UNSET, or
   * `null` when no legacy var exists (ceilings added alongside `ABAP_MODE`).
   */
  readonly legacyEnvVar: string | null;
  /** Human-readable name of the capability, for use inside a sentence. */
  readonly label: string;
  /**
   * Remediation sentence for LEGACY config (`ABAP_MODE` unset). `null` when
   * no legacy var exists — {@link explainDeniedCapability} says so instead.
   */
  readonly legacyRemediation: string | null;
  /** Whether this capability's env var is a live two-way override under ABAP_MODE (see AbapModeBooleanOverrides). */
  readonly modeOverridable: boolean;
}

/**
 * THE table. Ordered to match the sequence `src/config.ts` warns in, because
 * that warning list is derived from this one — see
 * {@link MODE_GOVERNED_LEGACY_ENV_VARS}.
 */
export const MODE_GOVERNED_CAPABILITIES: Readonly<
  Record<ModeGovernedCapability, ModeGovernedCapabilityInfo>
> = Object.freeze({
  allowWrite: {
    legacyEnvVar: "ABAP_ALLOW_WRITE",
    label: "writes",
    legacyRemediation:
      "Set ABAP_ALLOW_WRITE=true (ABAP_ALLOW_PACKAGES is optional — it narrows the default, which is every package).",
    modeOverridable: false,
  },
  allowTransportRelease: {
    legacyEnvVar: "ABAP_ALLOW_TRANSPORT_RELEASE",
    label: "releasing a transport request",
    legacyRemediation: "Set ABAP_ALLOW_TRANSPORT_RELEASE=true.",
    modeOverridable: true,
  },
  allowEnhancements: {
    legacyEnvVar: "ABAP_ALLOW_ENHANCEMENTS",
    label: "enhancement authoring",
    legacyRemediation: "Set ABAP_ALLOW_ENHANCEMENTS=true.",
    modeOverridable: true,
  },
  enhanceTargets: {
    legacyEnvVar: "ABAP_ENHANCE_TARGETS",
    label: "enhancing any object",
    legacyRemediation:
      "Set ABAP_ENHANCE_TARGETS=customer for your own objects, or =sap plus a matching " +
      "ABAP_ENHANCE_TARGET_PACKAGES entry for SAP standard objects.",
    modeOverridable: true,
  },
  allowSourcePlugins: {
    legacyEnvVar: "ABAP_ALLOW_SOURCE_PLUGINS",
    label: "creating source-code plug-in (enhoxhh) hooks",
    legacyRemediation: "Set ABAP_ALLOW_SOURCE_PLUGINS=true.",
    modeOverridable: true,
  },
  allowEnhancementDelete: {
    legacyEnvVar: "ABAP_ALLOW_ENHANCEMENT_DELETE",
    label: "deleting an existing enhancement object",
    legacyRemediation: "Set ABAP_ALLOW_ENHANCEMENT_DELETE=true.",
    modeOverridable: true,
  },
  allowTransportDelete: {
    legacyEnvVar: "ABAP_ALLOW_TRANSPORT_DELETE",
    label: "deleting a transport request",
    legacyRemediation: "Set ABAP_ALLOW_TRANSPORT_DELETE=true.",
    modeOverridable: true,
  },
  allowCascadeDelete: {
    legacyEnvVar: "ABAP_ALLOW_CASCADE_DELETE",
    label: "the BOPF cascading DDIC delete",
    legacyRemediation: "Set ABAP_ALLOW_CASCADE_DELETE=true.",
    modeOverridable: true,
  },
  allowRawAdtWrites: {
    legacyEnvVar: "ABAP_ALLOW_RAW_ADT_WRITES",
    label: "non-GET abap_adt passthrough",
    legacyRemediation: "Set ABAP_ALLOW_RAW_ADT_WRITES=true.",
    modeOverridable: true,
  },
});

/**
 * Legacy env vars that go DEAD (fully, not just overridable) when `ABAP_MODE`
 * is set — today just `ABAP_ALLOW_WRITE`/`ABAP_ENHANCE_TARGETS`.
 * `src/config.ts`'s "X is set but ignored" warning iterates this.
 */
export const MODE_GOVERNED_LEGACY_ENV_VARS: readonly string[] = Object.freeze(
  Object.values(MODE_GOVERNED_CAPABILITIES)
    .filter((info) => info.legacyEnvVar !== null && !info.modeOverridable)
    .map((info) => info.legacyEnvVar as string),
);

/**
 * Every env var `capabilitiesForMode` ignores outright under `read` — the
 * override and allowlist levers. `ABAP_ALLOW_DATA_PREVIEW` is deliberately
 * absent: it is a grant, honoured in every mode.
 */
export const MODE_OVERRIDE_ENV_VARS: readonly string[] = Object.freeze([
  "ABAP_ALLOW_PACKAGES",
  "ABAP_ALLOW_NAME_PREFIXES",
  "ABAP_ALLOW_TRANSPORTS",
  "ABAP_ENHANCE_TARGET_PACKAGES",
  "ABAP_ORIGIN_SYSTEMS",
  ...Object.values(MODE_GOVERNED_CAPABILITIES)
    .filter((i) => i.modeOverridable && i.legacyEnvVar !== null)
    .map((i) => i.legacyEnvVar as string),
]);

/**
 * Is this capability granted by a resolved capability set? Boolean fields
 * answer directly; `enhanceTargets` is tri-state — `"none"` is itself a
 * refusal, so anything above it counts as granted.
 */
export function capabilityGranted(
  caps: AbapCapabilities,
  cap: ModeGovernedCapability,
): boolean {
  if (cap === "enhanceTargets") return caps.enhanceTargets !== "none";
  return caps[cap];
}

/** The three tiers in ascending order of permission. */
const MODE_LADDER: readonly AbapMode[] = ["read", "edit", "admin"];

/**
 * The lowest `ABAP_MODE` whose resolved capability set satisfies
 * `predicate`, or `undefined` if none does. The anti-drift mechanism: the
 * answer is computed by calling {@link capabilitiesForMode} itself, not read
 * off a hand-written table — a re-tiered capability updates every message
 * that names it automatically. Evaluated with no overrides/grants/
 * boolOverrides — this is each mode's OWN default, not what an override
 * could push it to (see {@link overrideWouldGrant} for that question).
 */
export function lowestModeSatisfying(
  predicate: (caps: AbapCapabilities) => boolean,
): AbapMode | undefined {
  return MODE_LADDER.find((m) => predicate(capabilitiesForMode(m)));
}

/** {@link lowestModeSatisfying} for a plain capability. */
export function lowestModeGranting(cap: ModeGovernedCapability): AbapMode | undefined {
  return lowestModeSatisfying((caps) => capabilityGranted(caps, cap));
}

/**
 * A requirement narrower than "the capability is off" — today only
 * `enhanceTargets`: `capabilityGranted` treats anything above `"none"` as
 * granted, but the SAP/partner branch (`src/safety.ts`) needs specifically
 * `"sap"` (`admin`-only). Rather than adding a pseudo-capability key to
 * {@link MODE_GOVERNED_CAPABILITIES}, the call site supplies the narrower
 * predicate, still evaluated against a real `capabilitiesForMode()` result.
 */
export interface CapabilityRequirement {
  readonly capability: ModeGovernedCapability;
  /** Defaults to {@link capabilityGranted} for `capability`. */
  readonly satisfiedBy?: (caps: AbapCapabilities) => boolean;
  /** Overrides the table's `label` when the requirement is narrower. */
  readonly label?: string;
  /** Overrides the table's `legacyRemediation` when the requirement is narrower. */
  readonly legacyRemediation?: string;
}

/** The structured answer to "why is this off, and what actually turns it on?". */
export interface DeniedCapabilityExplanation {
  readonly capability: ModeGovernedCapability;
  /** Which mechanism decided it: the mode, or the legacy per-flag config. */
  readonly decidedBy: "mode" | "legacy";
  /** The mode in force, when there is one. */
  readonly abapMode?: AbapMode;
  /** The lowest mode that would satisfy the requirement, when one exists. */
  readonly grantingMode?: AbapMode;
  /** The legacy env var for this capability, or `null` when none exists. */
  readonly legacyEnvVar: string | null;
  /** Human-readable name of what was denied, e.g. `"writes"`. */
  readonly label: string;
  /** One sentence naming the actual cause. Safe to put in a `reason`. */
  readonly cause: string;
  /** One sentence naming the action that actually works. Safe to put in a `hint`. */
  readonly remediation: string;
}

/**
 * The single sanctioned way to name a mode-governed legacy env var in a
 * message while `ABAP_MODE` is set — exists purely to rule that variable
 * OUT. Funnelling every such mention through this (or
 * {@link legacyUnlockClause}) makes "does any mode-governed variable name
 * survive stripping both clauses?" a mechanical test — the original defect
 * was a refusal telling an operator to set a variable they'd already set.
 * Do not hand-write a sentence naming one of these variables elsewhere.
 */
export function legacyOverriddenClause(envVar: string): string {
  // No `=true`: ABAP_ENHANCE_TARGETS is an enum, not a boolean, and one clause
  // that is accurate for every variable beats two that are accurate for some.
  return `Setting ${envVar} will NOT work: ABAP_MODE overrides it.`;
}

/**
 * Capabilities with a live override slot — a {@link AbapModeBooleanOverrides}
 * field for the seven booleans, or the {@link AbapModeOverrides.enhanceTargets}
 * field for the one enum — derived from {@link MODE_GOVERNED_CAPABILITIES}
 * rather than listed a second time.
 */
const MODE_OVERRIDABLE_CAPABILITIES: ReadonlySet<ModeGovernedCapability> = new Set(
  (Object.keys(MODE_GOVERNED_CAPABILITIES) as ModeGovernedCapability[]).filter(
    (c) => MODE_GOVERNED_CAPABILITIES[c].modeOverridable,
  ),
);

/**
 * `enhanceTargets` candidate override values worth probing for
 * {@link enhanceTargetsGrantingValue} — `"none"` is excluded because no
 * `satisfiedBy` predicate asking "why was this denied" is ever satisfied by
 * the deny-all value, so probing it can never change the answer. Exported so
 * tests (e.g. `test/refusal-attribution.test.ts`) can strip every possible
 * {@link legacyUnlockClause} value for this capability without hand-listing
 * them a second time.
 *
 * ORDER IS SIGNIFICANT: {@link enhanceTargetsGrantingValue} uses `.find()`,
 * so the first entry that satisfies the caller's predicate wins. Least
 * privilege first — `"customer"` before `"sap"` — so a generic "is
 * enhanceTargets off" predicate (satisfied by either value) recommends the
 * narrower one, not the widest. This cannot change the answer for a
 * predicate narrower than that (e.g. specifically `=== "sap"`), since only
 * one candidate ever satisfies it regardless of scan order.
 */
export const ENHANCE_TARGETS_OVERRIDE_VALUES: readonly EnhanceTargetsValue[] = ["customer", "sap"];

/**
 * Which `ABAP_ENHANCE_TARGETS` override value (if any) would make `satisfiedBy`
 * true under `mode`? Unlike the boolean capabilities, `enhanceTargets` has no
 * single "true" to try — {@link overrideWouldGrant}'s `{ [cap]: true }` shape
 * does not typecheck for it — so each candidate value is tried against a real
 * `capabilitiesForMode()` result via {@link AbapModeOverrides.enhanceTargets}.
 */
function enhanceTargetsGrantingValue(
  mode: AbapMode,
  satisfiedBy: (caps: AbapCapabilities) => boolean,
): EnhanceTargetsValue | undefined {
  return ENHANCE_TARGETS_OVERRIDE_VALUES.find((value) =>
    satisfiedBy(capabilitiesForMode(mode, { enhanceTargets: value }, {}, {})),
  );
}

/**
 * Would setting `cap`'s env var change whether `caps` (resolved under `mode`)
 * satisfies `satisfiedBy`? `false` outside {@link MODE_OVERRIDABLE_CAPABILITIES}
 * or under `read` (structurally, via `capabilitiesForMode`'s own early
 * return). No already-granted short-circuit: the override is two-way (or, for
 * `enhanceTargets`, three-way), so a capability the mode grants by default
 * can still be off (operator narrowed it) — in exactly that case the old
 * short-circuit answered "no effect", the reverse of the truth.
 */
function overrideWouldGrant(
  cap: ModeGovernedCapability,
  mode: AbapMode,
  satisfiedBy: (caps: AbapCapabilities) => boolean,
): boolean {
  if (!MODE_OVERRIDABLE_CAPABILITIES.has(cap)) return false;
  if (cap === "enhanceTargets") return enhanceTargetsGrantingValue(mode, satisfiedBy) !== undefined;
  return satisfiedBy(
    capabilitiesForMode(mode, {}, {}, { [cap]: true } as AbapModeBooleanOverrides),
  );
}

/**
 * Mirror of {@link legacyOverriddenClause} for the one case where the legacy
 * var IS a live lever rather than a dead one under `ABAP_MODE`. `value`
 * defaults to `"true"` for the boolean capabilities; `enhanceTargets` passes
 * its actual granting value (`"sap"`/`"customer"`) so the sentence names the
 * value that really works rather than a nonexistent `=true`.
 */
export function legacyUnlockClause(
  envVar: string,
  mode: AbapMode,
  label: string,
  value: string = "true",
): string {
  const setClause = value === "true" ? "this flag" : "that";
  return (
    `Setting ${envVar}=${value} also works, without raising the mode: ABAP_MODE=${mode} permits ` +
    `${label} once ${setClause} is set.`
  );
}

/**
 * Pick {@link legacyOverriddenClause} or {@link legacyUnlockClause} for
 * `cap`'s legacy env var — the one call site both explain* functions route
 * through, so they cannot drift into picking differently for the same input.
 * Takes the caller's actual `satisfiedBy` (rather than re-deriving the
 * generic {@link capabilityGranted} predicate) so a requirement narrower than
 * "the capability is off" — e.g. specifically `enhanceTargets === "sap"` —
 * is answered against the predicate that was actually asked, not a broader
 * stand-in that could say "unlock" for a value that would not satisfy it.
 */
function legacyClauseFor(
  cap: ModeGovernedCapability,
  envVar: string,
  mode: AbapMode,
  label: string,
  satisfiedBy: (caps: AbapCapabilities) => boolean,
): string {
  if (cap === "enhanceTargets") {
    const grantingValue = enhanceTargetsGrantingValue(mode, satisfiedBy);
    return grantingValue !== undefined
      ? legacyUnlockClause(envVar, mode, label, grantingValue)
      : legacyOverriddenClause(envVar);
  }
  return overrideWouldGrant(cap, mode, satisfiedBy)
    ? legacyUnlockClause(envVar, mode, label)
    : legacyOverriddenClause(envVar);
}

/**
 * Explain a denied mode-governed capability accurately for the
 * configuration ACTUALLY in force.
 *
 * @param abapMode `Config.abapMode` — `undefined` means legacy per-flag
 * configuration, the only case where the legacy env var really is the lever.
 *
 * Under `ABAP_MODE` it says which mode denied it, which mode grants it, and
 * that setting the legacy variable will NOT work — the original bug this
 * fixed was telling an operator to set a variable they'd already set.
 */
export function explainDeniedCapability(
  req: ModeGovernedCapability | CapabilityRequirement,
  abapMode: AbapMode | undefined,
): DeniedCapabilityExplanation {
  const request: CapabilityRequirement = typeof req === "string" ? { capability: req } : req;
  const cap = request.capability;
  const info = MODE_GOVERNED_CAPABILITIES[cap];
  const label = request.label ?? info.label;
  const legacyRemediation = request.legacyRemediation ?? info.legacyRemediation;
  const satisfiedBy = request.satisfiedBy ?? ((caps: AbapCapabilities) => capabilityGranted(caps, cap));
  const grantingMode = lowestModeSatisfying(satisfiedBy);

  if (abapMode === undefined) {
    // Legacy per-flag configuration. The env var IS the lever — say so.
    const cause =
      info.legacyEnvVar !== null
        ? `${info.legacyEnvVar} does not enable ${label}, and ABAP_MODE is not set, so that ` +
          "variable is what decides it."
        : `${label} has no legacy environment variable — it exists only under ABAP_MODE, and ` +
          "ABAP_MODE is not set, so it is off.";
    const remediation =
      legacyRemediation ??
      (grantingMode !== undefined
        ? `Switch this server to ABAP_MODE=${grantingMode}; there is no legacy environment ` +
          `variable that enables ${label}.`
        : `Nothing enables ${label} on this build.`);
    return {
      capability: cap,
      decidedBy: "legacy",
      grantingMode,
      legacyEnvVar: info.legacyEnvVar,
      label,
      cause,
      remediation,
    };
  }

  // ABAP_MODE is set: capabilitiesForMode() is the sole source of truth,
  // except for capabilities in MODE_OVERRIDABLE_CAPABILITIES, handled by
  // legacyClauseFor below.
  const cause = `ABAP_MODE=${abapMode} does not grant ${label}.`;
  let remediation: string;
  if (grantingMode === undefined) {
    remediation = `No ABAP_MODE value grants ${label}.`;
  } else if (grantingMode === abapMode) {
    // Defensive: the mode layer says yes, so something narrower refused. Never
    // tell the reader to change a setting that is already correct.
    remediation =
      `ABAP_MODE=${abapMode} already grants ${label} at the mode layer, so this refusal came ` +
      "from a narrower rule — changing ABAP_MODE will not lift it.";
  } else {
    remediation = `Set ABAP_MODE=${grantingMode}.`;
  }
  // The one place a mode-governed legacy var may be named while ABAP_MODE is set.
  if (info.legacyEnvVar !== null) {
    remediation += ` ${legacyClauseFor(cap, info.legacyEnvVar, abapMode, label, satisfiedBy)}`;
  }
  return {
    capability: cap,
    decidedBy: "mode",
    abapMode,
    grantingMode,
    legacyEnvVar: info.legacyEnvVar,
    label,
    cause,
    remediation,
  };
}

/** `["a", "b", "c"]` → `"a, b and c"`. */
function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * {@link explainDeniedCapability} for a refusal needing SEVERAL capabilities
 * at once (the "needs BOTH" family). Under legacy config this is the
 * individual explanations run together. Under `ABAP_MODE` one mode value
 * decides all of them, so the reader is told that one mode rather than a
 * list of steps that no longer exist.
 */
export function explainDeniedCapabilities(
  reqs: ReadonlyArray<ModeGovernedCapability | CapabilityRequirement>,
  abapMode: AbapMode | undefined,
): { readonly cause: string; readonly remediation: string } {
  const parts = reqs.map((r) => explainDeniedCapability(r, abapMode));
  if (abapMode === undefined) {
    return {
      cause: parts.map((p) => p.cause).join(" "),
      remediation: parts.map((p) => p.remediation).join(" "),
    };
  }
  const cause = `ABAP_MODE=${abapMode} does not grant ${joinAnd(parts.map((p) => p.label))}.`;
  // Highest of the individual answers, computed off the ladder — never
  // hard-coded, so a re-tiered capability moves this sentence with it.
  const modes = parts.map((p) => p.grantingMode);
  const highest = modes.includes(undefined)
    ? undefined
    : MODE_LADDER.reduce<AbapMode | undefined>(
        (acc, m) => (modes.includes(m) ? m : acc),
        undefined,
      );
  const step =
    highest === undefined
      ? `No single ABAP_MODE value grants ${joinAnd(parts.map((p) => p.label))}.`
      : highest === abapMode
        ? `ABAP_MODE=${abapMode} already grants ${joinAnd(parts.map((p) => p.label))} at the ` +
          "mode layer, so this refusal came from a narrower rule — changing ABAP_MODE will not " +
          "lift it."
        : `Set ABAP_MODE=${highest} — one value covers all of them.`;
  // No caller ever puts `enhanceTargets` (or any other narrower
  // CapabilityRequirement) in a multi-capability list — this default,
  // generic `capabilityGranted` predicate is exact for every capability that
  // actually reaches here. Verified by review, not assumed: every
  // production call site (src/safety.ts's whyAll, src/adt/enhancement-hook.ts,
  // src/tools/enh.ts x2) types its list as `ModeGovernedCapability[]`, which
  // structurally excludes CapabilityRequirement objects; the one test call
  // site (test/refusal-attribution.test.ts) is typed the same way. If a
  // future caller passes a CapabilityRequirement here, this line is wrong
  // for it — the fix would be threading a per-item satisfiedBy through, the
  // way `legacyClauseFor`'s single-capability sibling already does.
  const clauses = parts
    .filter((p): p is typeof p & { legacyEnvVar: string } => p.legacyEnvVar !== null)
    .map((p) =>
      legacyClauseFor(p.capability, p.legacyEnvVar, abapMode, p.label, (caps) =>
        capabilityGranted(caps, p.capability),
      ),
    );
  return { cause, remediation: [step, ...clauses].join(" ") };
}
