/**
 * Safety gate, enforced server-side regardless of what the agent believes.
 * Read-only by default; `ABAP_ALLOW_WRITE=true` clears that, but package,
 * namespace and name-prefix rules still apply afterwards.
 *
 * Evaluated in two phases so a refused write costs zero network calls:
 * `preflight` runs on raw tool arguments before the connection is touched,
 * `final` runs once the resolved object's real package is known. Only the
 * package rules are deferred.
 *
 * {@link SafetyGate.evaluateIntent} is a second entry point for enhancement/
 * BAdI creation, where the object actually changed is a string inside
 * generated ABAP rather than a URI — judged on INTENT before any ABAP exists.
 * See the git history for the full original rationale.
 */
import { capabilitiesFor } from "./adt/capabilities.js";
import { AbapError, type AbapErrorCode } from "./adt/errors.js";
import type { ResolvedObject } from "./adt/resolve.js";
import type { SystemRole } from "./adt/connection.js";
import {
  type AbapMode,
  type CapabilityRequirement,
  type EnhanceTargetsValue,
  explainDeniedCapabilities,
  explainDeniedCapability,
  type ModeGovernedCapability,
} from "./mode.js";

/**
 * `analyze` is server-side computation with no customer code execution (syntax
 * check, where-used, activation dry run). It sits outside {@link MUTATING_OPS}
 * on purpose, so `evaluate()` returns early and skips every gate — defensible
 * only while "runs no customer code" holds. See archive for the full rationale.
 */
export type Operation =
  | "read"
  | "analyze"
  | "write"
  | "activate"
  | "delete"
  | "execute"
  | "transport";

/**
 * Membership here is what makes the productive / `writesLockedOut` / read-only /
 * namespace / package / name-prefix checks run at all. A non-member is not
 * "lightly gated", it is **ungated** — `evaluate()` returns `allowed: true`
 * before any of those checks are reached.
 *
 * `abap_test` is deliberately `execute`, not `analyze`: an ABAP Unit test runs
 * arbitrary customer code (its own body plus the full call graph under test),
 * so classing it as `analyze` would both contradict the `abap_run`/`abap_debug`
 * precedent and leave an unrestricted bypass of the object rules (any SAP
 * class, no namespace/package check). Known cost: a read-only deployment
 * cannot run tests at all. See the git history for the full
 * four-point rationale and the recorded counter-argument.
 */
export const MUTATING_OPS: ReadonlySet<Operation> = new Set([
  "write",
  "activate",
  "delete",
  "execute",
  "transport",
]);

/** The subset of {@link Operation} that reaches a mutating verb — i.e. exactly {@link MUTATING_OPS}, expressed as a type instead of a runtime Set so it can gate a generic parameter. */
export type MutatingOperation = Exclude<Operation, "read" | "analyze">;

/** SAP-owned namespaces: anything in `/NS/` form is denied unless the allowlist names it explicitly. */
/**
 * Every single-letter package prefix SAP ships under (A–X except `Y`/`Z`, the
 * customer namespace).
 *
 * FIXED BUG: this list used to omit `D` and `H`, so `isSapPackage("DEVELOPMENT_TOOLS")`
 * / `isSapPackage("HRTIM")` wrongly answered false and the SAP-namespace refusal
 * never fired for them (an object named `ZFOO` in an SAP `H*` package passed
 * every rule). `test/safety.test.ts` now asserts the whole A–X range, not
 * spot examples. See the git history for the considered
 * (and rejected) alternative of inverting this into a predicate.
 */
const SAP_PACKAGE_PREFIXES = [
  "S", // SAP application packages
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "T",
  "U",
  "V",
  "W",
  "X",
];

export interface SafetyConfig {
  readOnly: boolean;
  /** Package patterns with `*` wildcards, e.g. `$TMP`, `Z*`, `ZFOO_*`. */
  allowPackages: string[];
  /**
   * Object-name prefixes a write may target. Defaults to the customer
   * namespace. Checked *after* the namespace and package rules, so it only ever
   * narrows what those already allowed.
   */
  allowNamePrefixes?: string[];
  /**
   * Transport allowlist for transportable writes. Unset ⇒ {@link DEFAULT_TRANSPORTS}
   * (`["*"]`, any caller-named or server-selected request — opt-in like
   * `allowPackages`/`allowNamePrefixes`, not opt-out). Set to a pinned TRKORR
   * (or list) to restrict to exactly those requests; `"auto"` is still a
   * valid explicit entry meaning "server auto-select/auto-create only," and
   * a pinned list does NOT implicitly admit auto-select — it must be named.
   * An explicitly EMPTY array is a deliberate deny-all, not "unset" — mirrors
   * `allowPackages`. `$TMP` and other no-transport packages never reach this
   * check. Independent of `allowPackages` in both directions — see the check
   * ordering in `evaluate()`.
   */
  allowTransports?: string[];
  /**
   * Ceiling (not a floor) for releasing a transport request.
   * `ABAP_ALLOW_WRITE=true` does NOT imply this — both must be true. Still
   * subject to the un-overridable productive/lockout checks like any
   * mutating operation.
   */
  allowTransportRelease?: boolean;
  /**
   * Ceiling for deleting a transport request outright (distinct from
   * releasing one) — same shape as {@link allowTransportRelease}. Under
   * `ABAP_MODE` this is `AbapCapabilities.allowTransportDelete`, admin-mode-only.
   * Before this field existed, delete was gated only by the ordinary
   * `readOnly` ceiling, with no admin-only distinction.
   */
  allowTransportDelete?: boolean;
  /**
   * Ceiling for the BOPF DDIC cascade-delete sweep (`deleteBusinessObject`,
   * `src/adt/bopf.ts`) — deletes the tables/structures/constants-interface a
   * BOPF BO's own delete leaves behind. NOT enforced through `evaluate()`:
   * `deleteBusinessObject` reads this field off `SafetyGate.config` directly
   * and refuses the WHOLE delete (rather than downgrading) when it's off;
   * each DDIC candidate is still separately authorized via
   * `gate.authorize("delete", …)`. Under `ABAP_MODE` this is
   * `AbapCapabilities.allowCascadeDelete`, admin-mode-only (previously the
   * cascade ran under `edit` mode with no extra ceiling).
   */
  allowCascadeDelete?: boolean;
  /** Set when the system reports itself productive — no override. */
  productive?: boolean;
  /**
   * Legacy tri-state view of the role probe, kept for the `abap://…/system`
   * resource and for messages. Do NOT branch the gate on this: `"unknown"` is
   * ambiguous between "probe failed" and "probe not run yet", which is exactly
   * the distinction `writesLockedOut` exists to make. See `toLegacySystemRole`.
   */
  systemRole?: SystemRole;
  /**
   * Fail-closed verdict from `detectSystemRole()`: true when the system is
   * productive OR could not be proven non-productive. No override —
   * `ABAP_ALLOW_WRITE=true` does not clear it. Deliberately separate from
   * `productive`: collapsing the two was the fail-open bug the tri-state
   * `ProductiveRole` exists to prevent from reintroducing itself here.
   */
  writesLockedOut?: boolean;
  /** The evidence behind `writesLockedOut`, quoted verbatim in the refusal. */
  lockoutReason?: string;
  /**
   * Raw cause when the lockout came from a probe that never got an HTTP
   * answer (`SystemRoleDetection.probeFailure`), rather than from an answer
   * that failed to prove the system non-productive. Moves as a unit with
   * `lockoutReason` through {@link update}'s latch.
   */
  roleProbeFailure?: string;
  /**
   * This system's own SID (`Config.sid`/`ABAP_SID`), so {@link SafetyGate.isLocalOrigin}
   * can recognise the server's own content without repeating it in
   * {@link originSystems}. Unset (or the `"UNKNOWN"` placeholder) just means
   * this half of the origin check never fires.
   */
  sid?: string;
  // ---- Enhancement authoring — all four default to the closed state ----
  /**
   * Master switch for enhancement/BAdI authoring (`ABAP_ALLOW_ENHANCEMENTS`).
   * `ABAP_ALLOW_WRITE=true` does **not** imply it: an enhancement changes the
   * behaviour of an object it does not live in, which is a different question
   * from "may this server write at all".
   */
  allowEnhancements?: boolean;
  /**
   * Which *enhanced* objects (the thing being intercepted) may be targeted
   * (`ABAP_ENHANCE_TARGETS`). Unset ⇒ {@link DEFAULT_ENHANCE_TARGETS} = `none`,
   * i.e. refuse everything. `customer` permits only locally-originated,
   * customer-named targets; `sap` additionally permits SAP and partner content
   * — but only for packages named in {@link enhanceTargetPackages}.
   */
  enhanceTargets?: EnhanceTargets;
  /**
   * Packages of the ENHANCED object that `enhanceTargets: "sap"` opts into
   * (`ABAP_ENHANCE_TARGET_PACKAGES`). Same `*`-wildcard shape as
   * {@link allowPackages}. Unset/empty is a deliberate deny-all, mirroring
   * `allowTransports: []`. Independent of `allowPackages`: names packages
   * that may be *enhanced*, never packages that may be *written to*.
   */
  enhanceTargetPackages?: string[];
  /**
   * SIDs whose content counts as locally originated (`ABAP_ORIGIN_SYSTEMS`),
   * IN ADDITION to this system's own SID ({@link sid}) and to an object with
   * no `masterSystem` at all. `adtcore:masterSystem` is a SID string, not a
   * boolean — `masterSystem !== "SAP"` is NOT an ownership test, it waves
   * through partner/third-party originals. See {@link SafetyGate.isLocalOrigin}.
   *
   * Unset ⇒ empty ⇒ no ADDITIONAL origins, deliberately NOT the sole test
   * (unlike every other allowlist here). FIXED BUG: an empty list used to be
   * the sole test, making the origin check unsatisfiable by default and
   * refusing every enhancement target on a fresh install, including this
   * system's own `$TMP` objects. An operator whose system was copied (SID
   * changed, old objects kept the old value) adds the previous SID here.
   */
  originSystems?: string[];

  /**
   * `ABAP_DATA_PREVIEW_DENY_TABLES` — operator ADDITIONS to
   * {@link DEFAULT_PREVIEW_DENY_TABLES}. Additive only: there is no
   * configuration value, here or anywhere, that removes a default entry. A
   * trailing `*` makes an entry a prefix rule. Unset means "defaults only",
   * which is already non-empty — unlike every allowlist above, where unset
   * means "nothing".
   */
  dataPreviewDenyTables?: string[];

  /**
   * `ABAP_ALLOW_DUMP_VARIABLES` — tier-2 opt-in for runtime-error dumps: may
   * a dump return variable CONTENTS at termination (vs. tier 1's error class,
   * program, line, source extract and call stack, always available). Judged
   * by {@link SafetyGate.evaluateDumpVariables}. Unset ⇒ OFF (fail-closed —
   * stakes are live business/personal data). Orthogonal to `readOnly` in
   * both directions: reading a dump is a read.
   */
  allowDumpVariables?: boolean;

  /**
   * Which configuration MECHANISM decided the mode-governed booleans above —
   * not a capability itself, read by nothing that grants or denies.
   *
   * When `ABAP_MODE` is set, `capabilitiesForMode()` (`src/mode.ts`) is the
   * SOLE source of truth for `readOnly`, `allowTransportRelease/Delete`,
   * `allowEnhancements`, `enhanceTargets`, `allowSourcePlugins`,
   * `allowEnhancementDelete`, `allowCascadeDelete`, `allowRawAdtWrites`; the
   * matching legacy env vars are never consulted — except `allowEnhancementDelete`'s
   * (`ABAP_ALLOW_ENHANCEMENT_DELETE`), which IS re-consulted below `admin` as
   * a live opt-in (see `AbapModeUnlocks` in `src/mode.ts`).
   *
   * Without this field a refusal can't say WHY a capability is off, only
   * WHAT it's set to — see {@link explainDeniedCapability}, which turns this
   * into the correct remediation sentence instead of naming a legacy env var
   * that does nothing under `ABAP_MODE`.
   *
   * Unset ⇒ legacy per-flag configuration, which is also what a hand-built
   * `SafetyConfig` (test, embedder) gets by omission.
   */
  abapMode?: AbapMode;
}

/**
 * `ABAP_ENHANCE_TARGETS` — which enhanced objects may be targeted at all.
 * Alias of `src/mode.ts`'s {@link EnhanceTargetsValue} (single source of
 * truth for the three legal values) rather than a fourth
 * independent repetition of the same literal union.
 */
export type EnhanceTargets = EnhanceTargetsValue;

export const DEFAULT_NAME_PREFIXES = ["Z", "Y"];

/**
 * The single token that turns the object-name gate OFF: `ABAP_ALLOW_NAME_PREFIXES=*`.
 *
 * Unlike `allowPackages`/`allowTransports`, an explicitly empty
 * `ABAP_ALLOW_NAME_PREFIXES` also folds to unrestricted: an empty *filter*
 * coherently means "no filter" (unlike an empty allowlist), and a deny-all
 * prefix list would be redundant with `ABAP_MODE=read` anyway.
 *
 * Deliberately does NOT weaken the SAP-owner denial (`isSapNamespace`/
 * `isSapPackage`, checked earlier and unaffected by this token) or switch
 * off per-type overrides (`namePrefixes` in `src/adt/capabilities.ts`,
 * e.g. ENQU/DL's `["EZ","EY"]`, which is the ABAP system's own rule, not
 * this installation's preference). Both pinned by tests in
 * `test/safety.test.ts`. See {@link SafetyGate.namePrefixesForType}.
 */
export const NAME_PREFIX_WILDCARD = "*";

/**
 * Does this prefix list mean "no name restriction at all"?
 *
 * Any `*` entry wins, so `["Z", "*"]` is unrestricted too — a list containing
 * the wildcard cannot coherently mean anything narrower.
 */
export function isUnrestrictedPrefixList(prefixes: readonly string[]): boolean {
  return prefixes.some((p) => p.trim() === NAME_PREFIX_WILDCARD);
}

/**
 * What an UNSET `enhanceTargets` means to the gate itself: refuse. Stated here
 * rather than inherited from whoever built the config, so a hand-built
 * `SafetyConfig` (tests, embedders) that omits the field gets the gate's own
 * considered default instead of accidentally falling through to "anything" —
 * same motivation as {@link DEFAULT_TRANSPORTS} stating its own default, even
 * though that default is permissive where this one is restrictive.
 */
export const DEFAULT_ENHANCE_TARGETS: EnhanceTargets = "none";

/**
 * What an UNSET `allowTransports` means to the gate itself: "any request" —
 * same opt-in convention as `allowPackages`/`allowNamePrefixes` (absent a
 * setting, access is full; setting one applies it as a whitelist). Previously
 * this was `["auto"]` (auto-select/auto-create only, so a *named*
 * pinned TRKORR was refused by default); that inverted the convention every
 * other allowlist in this file follows. `loadConfig()` resolves an unset
 * `ABAP_ALLOW_TRANSPORTS` to this same value, but a hand-built `SafetyGate`
 * (tests, embedders) bypasses that resolution, so the class states its own
 * default rather than inheriting one by accident. `"auto"` remains available
 * as an explicit, narrower choice. An explicitly empty `[]` means deny-all —
 * the two states never collapse into each other.
 */
export const DEFAULT_TRANSPORTS = ["*"];

/**
 * One meaning for a blank `corr_nr` across every tool. `""` — or any
 * all-whitespace string — is not the name of a transport request; a caller
 * templating the field or defaulting it to `""` rather than omitting the key
 * means "I named nothing", which is what an absent value already means.
 *
 * Left un-normalised, `""` survived `??` and got classified `source:"named"`,
 * so the allowlist compared an empty string against its entries, matched
 * nothing, and refused the call `SAFETY_DENIED` — with refusal text blaming
 * transport permissions rather than the empty string that caused it. Only
 * `abap_write` escaped, by stripping the value with a falsy check of its own,
 * so the identical argument wrote on one tool and was refused on another.
 *
 * Deliberately NOT a `.min(1)` schema rejection: `abap_write` has always read
 * `""` as "auto", and tightening it into an error would break callers that
 * work today. The trim also means `" "` cannot smuggle itself past the
 * allowlist as a distinct "named" transport.
 */
export function normalizeCorrNr(corrNr: string | undefined): string | undefined {
  const trimmed = corrNr?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

export type SafetyCorr =
  | { readonly kind: "local" }
  | { readonly kind: "unresolved" }
  | {
      readonly kind: "transport";
      readonly corrNr: string;
      /**
       * `auto`  — the SERVER chose it (session-created / session-cached /
       *           server-pin). Matched by the literal "auto" allowlist entry.
       * `named` — a HUMAN chose it (config-pin / caller). Must appear
       *           literally in ABAP_ALLOW_TRANSPORTS.
       */
      readonly source: "auto" | "named";
    };

export interface SafetyDecision {
  allowed: boolean;
  reason: string;
  rule?: string;
  /** Error code `assert()` throws for this decision. */
  code?: AbapErrorCode;
  /** Replaces the throwing form's default hint when this refusal needs different remediation. */
  hint?: string;
}

/**
 * What the gate needs to know about the object under a mutating operation.
 *
 * `superPackage` is meaningful for a `DEVC/K` target only. A package's own
 * `packageName` is ITSELF (see {@link isSapPackage}), so it is the hierarchy
 * parent — not `packageName` — that names the container such a create lands in,
 * and the package allowlist judges that. Absent/empty means "root package".
 */
export type SafetyTarget = Pick<ResolvedObject, "name"> &
  Partial<Pick<ResolvedObject, "packageName" | "type">> & {
    superPackage?: string;
    /**
     * `false` when the target is known not to exist yet (a create). Undefined
     * in the pre-flight phase, which has spent no request and cannot know —
     * and for `DEVC/K`, which is create-only, undefined is treated as a create.
     */
    exists?: boolean;
  };

/**
 * The single constructor for a {@link SafetyTarget}. Exists because
 * `SafetyTarget` literals were independently hand-assembled at ~15 call
 * sites, which is drift waiting to happen (a field like `superPackage`/
 * `exists` populated at one site and silently forgotten at another, with
 * nothing to catch it since every literal structurally satisfies the type).
 *
 * Does not normalise/validate beyond what `SafetyTarget` requires —
 * `evaluate()`/`enhancementRules()` still trim/upper-case at the point each
 * field is read. Used internally by {@link SafetyGate.evaluateIntent}; other
 * call sites are not yet migrated to it (tracked as a follow-up).
 */
export function safetyTarget(fields: {
  name: string;
  packageName?: string;
  type?: string;
  superPackage?: string;
  exists?: boolean;
}): SafetyTarget {
  return {
    name: fields.name,
    ...(fields.packageName !== undefined ? { packageName: fields.packageName } : {}),
    ...(fields.type !== undefined ? { type: fields.type } : {}),
    ...(fields.superPackage !== undefined ? { superPackage: fields.superPackage } : {}),
    ...(fields.exists !== undefined ? { exists: fields.exists } : {}),
  };
}

export interface EvaluateOptions {
  /**
   * `preflight` (default `final`) skips the package rules when the package is
   * not yet known, so the gate can run before the first network call and still
   * refuse everything it *can* decide statically.
   */
  phase?: "preflight" | "final";
  /**
   * The transport request this call would use, if the caller named one
   * explicitly. Undefined means "let the server auto-select/auto-create" —
   * checked against `SafetyConfig.allowTransports` at step 10, after the
   * package and name-prefix rules. Never consulted for objects that
   * need no transport at all.
   */
  corrNr?: string;
  /**
   * The transport this mutation will ACTUALLY use, three-state:
   *  - `{kind:"transport", corrNr, source}` — resolved; step 10 judges THIS.
   *  - `{kind:"local"}`      — resolved; no transport involved, step 10 skips.
   *  - `{kind:"unresolved"}` — not known yet. Step 10 enforces only what is
   *    decidable without a number (the deny-all case) and defers the rest.
   * Omitted ⇒ back-compatible "caller named nothing / auto-select".
   */
  corr?: SafetyCorr;
  /**
   * `op === "transport"` only: true when this call means RELEASE, not a
   * lesser transport action. Gated by `SafetyConfig.allowTransportRelease`,
   * which `ABAP_ALLOW_WRITE` does not imply.
   */
  release?: boolean;
  /**
   * `op === "transport"` only: true when this call means DELETING the
   * request outright, not a lesser transport action. Gated by
   * `SafetyConfig.allowTransportDelete` — mirrors `release` as its own
   * separate ceiling; neither flag implies the other.
   */
  deleteTransport?: boolean;
  /**
   * The enhancement this mutation is part of. REQUIRED whenever the
   * target's `type` is an enhancement type — see {@link isEnhancementType} and
   * the routing block in `evaluate()`. Supplying it is what lets the gate judge
   * the object being INTERCEPTED, which never appears in the artefact's URI.
   */
  intent?: EnhancementIntent;
}

/**
 * What the gate needs to know about an enhancement BEFORE any ABAP exists.
 * Every field is already held by the calling tool: the bridge route generates
 * a throwaway `$TMP` helper class and POSTs it to `/sap/bc/adt/oo/classrun/…`,
 * so the only object with a URI is that helper, which trivially passes every
 * URI-shaped rule. The enhancement, spot and intercepted SAP object are
 * string arguments inside generated ABAP — judged as an INTENT before
 * generation, or not judged at all.
 */
export interface EnhancementIntent {
  /** The ENHO/ENHS being created — Q1, "what is being written". */
  enhancementName: string;
  /** Where the artefact will live — Q1, checked against `allowPackages`. */
  enhancementPackage: string;
  /**
   * ADT type code of the artefact, e.g. `ENHO/XHH`, `ENHS/XSB`. Defaults to
   * `ENHO/XHH`. A value that is not an enhancement type is REPLACED with the
   * default rather than honoured: honouring it would route the artefact away
   * from the enhancement rules, i.e. fail open on a caller's typo.
   */
  enhancementType?: string;
  /**
   * `adtcore:masterSystem` of the artefact when it already exists (SID string).
   * Present and not in {@link SafetyConfig.originSystems} means this is a
   * REPAIR of somebody else's original — an un-overridable refusal.
   * Only ever populate this from a server-originated GET: read out of a
   * document the client itself just sent, it is the client reading its own
   * input.
   */
  enhancementMasterSystem?: string;
  /** The spot the implementation binds to, when there is one. */
  spotName?: string;
  /** The object being INTERCEPTED — Q2, "what does this change the behaviour of". */
  targetName: string;
  /** Package of the intercepted object — judged against `enhanceTargetPackages`. */
  targetPackage: string;
  /**
   * `adtcore:masterSystem` of the intercepted object (SID string, e.g. `"SAP"`,
   * `"A4H"`). ABSENCE IS EVIDENCE OF LOCAL OWNERSHIP, not a fact to fail
   * closed on: this attribute is populated only once an object has actually
   * left this system, so a `$TMP` object (or anything never transported) has
   * none when read live. See {@link SafetyGate.isLocalOrigin} for the full
   * three-way local-origin test.
   */
  targetMasterSystem?: string;
}

export interface EvaluateIntentOptions extends EvaluateOptions {
  /**
   * Which mutating operation the intent covers. Defaults to `write`. No
   * read-only exemption: verifying an enhancement at runtime is itself a
   * classrun call from the same templates, so it passes through as `execute`.
   * A non-mutating op is refused, since `evaluate()` short-circuits on those.
   */
  op?: Operation;
}

/** Max length of an ABAP object name the enhancement path will substitute. */
const ABAP_IDENTIFIER_MAX = 30;

export interface AbapIdentifierOptions {
  /** Default {@link ABAP_IDENTIFIER_MAX} (30) — `ENHNAME` is CHAR30. */
  maxLength?: number;
  /**
   * Permit a leading `/NS/` registered namespace, e.g. `/DMO/CL_FLIGHT`. The
   * namespace token itself may start with a digit — SAP-generated namespaces
   * do, e.g. `/1BCDWB/`, `/1CN/` — but the object name after it must
   * still start with a letter.
   */
  allowNamespace?: boolean;
  /** Permit a leading `$`, i.e. the local package names `$TMP`, `$FOO`. */
  allowLocal?: boolean;
}

/**
 * Does `name` match ABAP object-name grammar: a letter, then letters, digits
 * and underscores, within `maxLength`? A GRAMMAR check, not an authorization
 * one. Lives here because of what it defends: `src/adt/enhancement-templates.ts`
 * substitutes these identifiers verbatim into ABAP source that gets activated
 * and executed, and the gate cannot read generated source — a period, quote
 * or newline in a name is an ABAP injection, and this is the only defence.
 *
 * Deliberately NOT trimmed: the caller substitutes the string it holds, so
 * silently repairing whitespace here would validate one value and emit a
 * different one.
 */
export function isValidAbapIdentifier(name: string, opts: AbapIdentifierOptions = {}): boolean {
  if (typeof name !== "string") return false;
  const max = opts.maxLength ?? ABAP_IDENTIFIER_MAX;
  if (name.length === 0 || name.length > max) return false;
  let body = name;
  if (opts.allowNamespace) {
    const ns = /^\/[A-Za-z0-9][A-Za-z0-9_]*\//.exec(body);
    if (ns) body = body.slice(ns[0].length);
  }
  if (opts.allowLocal && body.startsWith("$")) body = body.slice(1);
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(body);
}

/**
 * The one rule `src/adt/resolve.ts` and `src/adt/write.ts` both defer to for
 * whether a name can be addressed at all: `$FOO` (local) and `/NS/FOO`
 * (namespaced) are separate grammars, never combined, so this branches on the
 * leading character instead of asking `isValidAbapIdentifier` to allow both
 * at once — that combination silently accepts `/DMO/$FOO`. Length is
 * deliberately uncapped: callers apply their own per-type limit afterwards
 * and need the length-specific error message that produces, not a flat
 * grammar refusal.
 */
export function isAddressableAbapObjectName(name: string): boolean {
  return name.startsWith("$")
    ? isValidAbapIdentifier(name, { allowLocal: true, maxLength: Number.POSITIVE_INFINITY })
    : isValidAbapIdentifier(name, { allowNamespace: true, maxLength: Number.POSITIVE_INFINITY });
}

/**
 * ADT type codes for the enhancement family: `ENHO/*` (implementation),
 * `ENHS/*` (spot / composite spot), `ENHC/*` (composite implementation),
 * `ENHP` (enhancement package). Matched on the head of the type code so an
 * unseen subtype still routes to the enhancement rules — the fail-closed
 * direction.
 */
const ENHANCEMENT_TYPE_HEADS = ["ENHO", "ENHS", "ENHC", "ENHP"];

/** Is this ADT type code an enhancement artefact? See {@link ENHANCEMENT_TYPE_HEADS}. */
export function isEnhancementType(type: string | undefined): boolean {
  if (!type) return false;
  const head = type.trim().toUpperCase().split("/")[0] ?? "";
  return ENHANCEMENT_TYPE_HEADS.includes(head);
}

/**
 * The narrower-than-"off" requirement for the SAP/partner enhancement
 * branch: `enhanceTargets` is a tri-state and `capabilityGranted` treats
 * anything above `"none"` as granted, but this branch needs specifically
 * `"sap"` — reachable from ANY mode via an explicit
 * `ABAP_ENHANCE_TARGETS=sap` override, not just `admin`'s default. Exported
 * so tests can reuse the exact `label`/`legacyRemediation` strings instead of
 * duplicating them.
 */
export const ENHANCE_SAP_TARGET_REQUIREMENT: CapabilityRequirement = {
  capability: "enhanceTargets",
  satisfiedBy: (caps) => caps.enhanceTargets === "sap",
  label: "enhancing SAP or partner content",
  legacyRemediation: "Set ABAP_ENHANCE_TARGETS=sap.",
};

/**
 * `SafetyTarget.type` values that name something to be INVOKED (a
 * transaction code) rather than a repository object. `TCODE` is the only
 * member: a tcode is an SAP-wide invocation identifier, not a
 * customer-development artefact, so `ABAP_ALLOW_NAME_PREFIXES` has no
 * meaningful answer for `SE16`. Membership is deliberate, one-at-a-time.
 *
 * FIXED BUG: `TCODE` used to be declared on `SafetyTarget` and passed by
 * `runPressTool` but read by nothing, so every tcode fell through to the
 * repository-object rules and was refused with unfollowable advice ("widen
 * ABAP_ALLOW_NAME_PREFIXES"). See the `isInvocationTarget` branch in
 * `evaluate()` for the fix.
 */
export const INVOCATION_TARGET_TYPES: ReadonlySet<string> = new Set(["TCODE"]);

/** Is this target's `type` an invocation identifier? See {@link INVOCATION_TARGET_TYPES}. */
export function isInvocationTarget(type: string | undefined): boolean {
  if (!type) return false;
  return INVOCATION_TARGET_TYPES.has(type.trim().toUpperCase());
}

/** Two reason sentences, or just the first when there is no second. */
function join(base: string, extra?: string): string {
  return extra ? `${base} ${extra}` : base;
}

/** `Z*` / `ZFOO_*` / `$TMP` → RegExp. Case-insensitive, anchored. */
export function packagePattern(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function isSapNamespace(name: string): boolean {
  const n = name.trim().toUpperCase();
  if (n.startsWith("/")) return true; // /NS/OBJECT — registered namespace
  return false;
}

/**
 * Is `pkg` an SAP-owned (i.e. not customer) development package?
 *
 * Judged purely by name. For a `DEVC/K` target the caller must pass the
 * package's OWN name, because a package's package is itself — ADT reports
 * `adtcore:packageRef` = the package itself, with the hierarchy parent in a
 * separate `<pak:superPackage>` element. Creating `ZSD_ORDER` beneath the
 * SAP-prefixed `COURSES` is therefore judged on `ZSD_ORDER`; passing the
 * superpackage here would refuse the wrong object.
 */
export function isSapPackage(pkg: string | undefined): boolean {
  if (!pkg) return false;
  const p = pkg.trim().toUpperCase();
  if (p.startsWith("$")) return false; // local objects are the developer's own
  if (p.startsWith("/")) return true;
  if (p.startsWith("Z") || p.startsWith("Y")) return false;
  return SAP_PACKAGE_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * The result of looking for a classic DDIC `@AbapCatalog.sqlViewName`
 * annotation inside CDS DDL source text. See {@link extractSqlViewName}.
 *
 * `"found"` and `"absent"` are the only two outcomes that let a write
 * proceed (the latter to `evaluateDdlsSqlViewName`, which still runs the
 * namespace check on whatever `"found"` returned). `"ambiguous"` and
 * `"unparseable"` both refuse — see that function's doc comment for why a
 * refusal is preferred over a guess.
 */
export type SqlViewNameExtraction =
  | { kind: "absent" }
  | { kind: "found"; value: string }
  | { kind: "ambiguous"; detail: string }
  | { kind: "unparseable"; detail: string };

/** A same-length copy of `raw` with `--` and `/* *&#47;` comments blanked to
 * spaces, plus the `[start, end)` spans (in that same coordinate space) that
 * single-quoted string literals occupy. Comments are never recognised inside
 * a string, and a string is never recognised inside a comment — both need
 * the other's boundaries, so this does both in one pass rather than two that
 * could disagree. `''` is the CDS-DDL escaped literal quote. */
function scanCdsText(raw: string): { cleaned: string; stringSpans: Array<[number, number]> } {
  const out: string[] = [];
  const stringSpans: Array<[number, number]> = [];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const c = raw[i];
    if (c === "'") {
      const start = i;
      i++;
      for (;;) {
        if (i >= n) break; // unterminated — span just runs to EOF
        if (raw[i] === "'") {
          if (raw[i + 1] === "'") {
            i += 2; // escaped literal quote, stay in the string
            continue;
          }
          i++; // closing quote
          break;
        }
        i++;
      }
      stringSpans.push([start, i]);
      out.push(raw.slice(start, i));
      continue;
    }
    if (c === "-" && raw[i + 1] === "-") {
      const start = i;
      while (i < n && raw[i] !== "\n") i++;
      out.push(" ".repeat(i - start));
      continue;
    }
    if (c === "/" && raw[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      out.push(" ".repeat(i - start));
      continue;
    }
    out.push(c ?? "");
    i++;
  }
  return { cleaned: out.join(""), stringSpans };
}

function insideAnyStringSpan(pos: number, spans: readonly [number, number][]): boolean {
  return spans.some(([s, e]) => pos >= s && pos < e);
}

/** Balanced-brace scan for the `}` matching the `{` at `openIndex`, skipping
 * over any brace characters that fall inside a string literal. Returns -1
 * (unterminated) if no matching close is found before EOF. */
function findMatchingBrace(
  text: string,
  openIndex: number,
  stringSpans: readonly [number, number][],
): number {
  let depth = 1;
  let i = openIndex + 1;
  while (i < text.length) {
    if (insideAnyStringSpan(i, stringSpans)) {
      const span = stringSpans.find(([s, e]) => i >= s && i < e);
      i = span ? span[1] : i + 1;
      continue;
    }
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

const DOTTED_SQLVIEWNAME_RE = /@AbapCatalog\s*\.\s*sqlViewName\s*:\s*'((?:[^']|'')*)'/gi;
const NESTED_ABAPCATALOG_HEAD_RE = /@AbapCatalog\s*:\s*\{/gi;
const NESTED_SQLVIEWNAME_RE = /sqlViewName\s*:\s*'((?:[^']|'')*)'/gi;
const SQLVIEWNAME_TOKEN_RE = /sqlviewname/gi;

/**
 * Look for a classic DDIC `@AbapCatalog.sqlViewName` annotation in CDS DDL
 * source text and extract the database view name it names, if any.
 *
 * Deliberately conservative: an unparseable or ambiguous annotation refuses
 * rather than guesses, because a parser that silently misses a legitimate
 * spelling would be a silent bypass — worse than not checking at all. The
 * caller ({@link SafetyGate.evaluateDdlsSqlViewName}) turns anything short of
 * a clean single match into a refusal, never a guess.
 *
 * Handles both spellings (dotted `@AbapCatalog.sqlViewName: 'X'` and nested
 * `@AbapCatalog: { sqlViewName: 'X', ... }`), case-insensitivity, arbitrary
 * whitespace/newlines, `--`/`/* *&#47;` comments (stripped before matching so
 * decoy or hidden text can't fool it), and the `''` escaped literal quote.
 * No annotation at all (e.g. 7.55+ `define view entity`) is `"absent"`,
 * which is allowed to proceed.
 *
 * Refuses (`"ambiguous"`/`"unparseable"`) rather than guesses on: more than
 * one `sqlViewName` occurrence; an occurrence neither recognised form fully
 * captures (detected by comparing token count against successfully-decoded
 * value count); or a captured value containing anything outside
 * `[A-Za-z0-9_/]` after un-escaping `''`.
 */
export function extractSqlViewName(source: string): SqlViewNameExtraction {
  const { cleaned, stringSpans } = scanCdsText(source);

  let tokenCount = 0;
  for (const m of cleaned.matchAll(SQLVIEWNAME_TOKEN_RE)) {
    if (!insideAnyStringSpan(m.index ?? 0, stringSpans)) tokenCount++;
  }
  if (tokenCount === 0) return { kind: "absent" };

  const candidates: string[] = [];

  for (const m of cleaned.matchAll(DOTTED_SQLVIEWNAME_RE)) {
    candidates.push(m[1] ?? "");
  }

  for (const head of cleaned.matchAll(NESTED_ABAPCATALOG_HEAD_RE)) {
    const headIndex = head.index ?? -1;
    if (headIndex < 0) continue;
    const openBrace = headIndex + head[0].length - 1;
    const closeBrace = findMatchingBrace(cleaned, openBrace, stringSpans);
    if (closeBrace < 0) {
      // Unterminated `{` — refuse outright rather than record a stand-in
      // candidate that could coincidentally pass as "found" (silent bypass).
      return {
        kind: "unparseable",
        detail: "an @AbapCatalog: { ... } block was opened but never closed before the source ended.",
      };
    }
    const body = cleaned.slice(openBrace + 1, closeBrace);
    for (const nested of body.matchAll(NESTED_SQLVIEWNAME_RE)) {
      candidates.push(nested[1] ?? "");
    }
  }

  if (candidates.length !== tokenCount) {
    return {
      kind: "unparseable",
      detail:
        `found ${tokenCount} occurrence(s) of "sqlViewName" in the source but could only confidently ` +
        `extract ${candidates.length} value(s) from the recognised @AbapCatalog.sqlViewName (dotted) ` +
        "or @AbapCatalog: { sqlViewName: ... } (nested) forms — the rest use a spelling or structure " +
        "this parser does not recognise.",
    };
  }
  if (candidates.length > 1) {
    return {
      kind: "ambiguous",
      detail: `found ${candidates.length} separate sqlViewName occurrences in one source.`,
    };
  }

  const raw = candidates[0] ?? "";
  const value = raw.replace(/''/g, "'").trim();
  if (!/^[A-Za-z0-9_/]+$/.test(value)) {
    return {
      kind: "unparseable",
      detail: `the captured value ${JSON.stringify(raw)} is empty or contains characters outside A-Z, 0-9, "_" and "/".`,
    };
  }
  return { kind: "found", value: value.toUpperCase() };
}

/**
 * One entry of the data-preview deny-list. `reason` is not decoration:
 * it is quoted verbatim into the refusal, because a model that reads "Password
 * hashes for every user" stops, while a model that reads "denied" retries.
 */
export type PreviewDenyRule = {
  kind: "exact" | "prefix";
  value: string;
  reason: string;
};

/** `PCL` + `"12345"` → five prefix rules sharing one reason. */
function digitPrefixes(head: string, digits: string, reason: string): PreviewDenyRule[] {
  return [...digits].map((d) => ({ kind: "prefix" as const, value: `${head}${d}`, reason }));
}

/**
 * Tables `abap_data_preview` refuses to read — 71 rules in four categories.
 *
 * FAILS OPEN, unlike every other allowlist in this file: empty would mean
 * "everything readable", so this ships non-empty and frozen, and
 * `ABAP_DATA_PREVIEW_DENY_TABLES` is ADDITIVE ONLY — no entry can be removed.
 * It supplements, never replaces, the two real controls (`ABAP_ALLOW_DATA_PREVIEW`
 * off by default, and the row ceiling): it fails open on the ~90,000 tables
 * not listed, on any `Z*` copy of payroll data, and on any DDIC/CDS view over
 * a denied table. The real boundary is `S_TABU_DIS`/`S_TABU_NAM`. Do not
 * describe this list as a security control.
 *
 * Deliberate non-entries, recorded so nobody "fixes" them later: bare `PA`/`PB`
 * prefixes are NOT used (would block `PAT01`/`PAT03` SPAM/SAINT patch tables —
 * hence the digit-anchored `PA0`…`PA9`/`PB0`…`PB9` split below); `T5*` is NOT
 * blocked (thousands of HR *customizing* tables, not personal data);
 * `CDHDR`/`CDPOS` are NOT blocked (change-document lookup is routine
 * debugging — a known gap, not an oversight); `USR` as a PREFIX was rejected
 * in favour of the exact `USR*` entries below (a prefix's blast radius isn't auditable).
 */
export const DEFAULT_PREVIEW_DENY_TABLES: readonly PreviewDenyRule[] = Object.freeze(
  ([
    // ---- 1. Credentials and security (exact) ----
    { kind: "exact", value: "USR02", reason: "Password hashes for every user (BCODE/PASSCODE/PWDSALTEDHASH)." },
    { kind: "exact", value: "USRPWDHISTORY", reason: "Historic password hashes — the same material as USR02, kept longer." },
    { kind: "exact", value: "USH02", reason: "Change history of USR02, including superseded password hashes." },
    { kind: "exact", value: "USH04", reason: "Change history of user authorisation assignments." },
    { kind: "exact", value: "USR04", reason: "User authorisation profile assignments — a map of who can do what." },
    { kind: "exact", value: "UST04", reason: "User-to-profile assignments; the companion index to USR04." },
    { kind: "exact", value: "USR10", reason: "Authorisation profile definitions." },
    { kind: "exact", value: "UST10S", reason: "Contents of single authorisation profiles." },
    { kind: "exact", value: "UST10C", reason: "Contents of composite authorisation profiles." },
    { kind: "exact", value: "RFCDES", reason: "RFC destination definitions, including stored logon credentials." },
    { kind: "exact", value: "RFCATTRIB", reason: "RFC destination attributes — trust relationships and logon settings." },
    { kind: "exact", value: "RSECTAB", reason: "Secure storage (SSFS) entries — the encrypted credential store." },
    { kind: "exact", value: "RSECACTB", reason: "Secure storage access control entries." },
    { kind: "exact", value: "SNCSYSACL", reason: "SNC access control list — which external identities may log on." },
    { kind: "exact", value: "DEVACCESS", reason: "Developer access keys." },
    {
      kind: "exact",
      value: "DBTABLOG",
      // Listed for a structural reason, not a topical one: without it the whole
      // category leaks through one generic table.
      reason:
        "Table change log — holds before/after images of every logged table, USR02 included, and would otherwise be a hole through the rest of this list.",
    },

    // ---- 2. Payroll and HR (digit-anchored prefixes; see non-entries above) ----
    ...digitPrefixes(
      "PA",
      "0123456789",
      "HR master data infotype — salary (0008), bank details (0009), tax, family and medical data.",
    ),
    ...digitPrefixes(
      "PB",
      "0123456789",
      "Applicant master data infotype — the same personal fields as PA*, for recruitment.",
    ),
    ...digitPrefixes(
      "PCL",
      "12345",
      "HR cluster table — PCL2 holds the payroll results themselves.",
    ),
    { kind: "prefix", value: "HRP", reason: "HR planning / org-management infotypes — org units, positions and their holders." },
    { kind: "prefix", value: "PTRV", reason: "Travel expenses — trips, receipts and reimbursement bank details." },
    // Exact, and matched ahead of the HRP prefix by the exact-first pass in
    // `isPreviewTableDenied`, so the refusal names payroll rather than OM.
    { kind: "exact", value: "HRPY_RGDIR", reason: "Payroll results directory — the index into the PCL2 payroll clusters." },

    // ---- 3. Accounting documents (exact) ----
    { kind: "exact", value: "ACDOCA", reason: "Universal Journal line items — every posted financial document." },
    { kind: "exact", value: "ACDOCP", reason: "Universal Journal plan line items." },
    { kind: "exact", value: "BKPF", reason: "Accounting document headers." },
    { kind: "exact", value: "BSEG", reason: "Accounting document line items — amounts, accounts, assignments." },
    { kind: "exact", value: "BSET", reason: "Tax data per accounting document." },
    { kind: "exact", value: "BSID", reason: "Open customer items (classic accounts receivable)." },
    { kind: "exact", value: "BSAD", reason: "Cleared customer items (classic accounts receivable)." },
    { kind: "exact", value: "BSIK", reason: "Open vendor items (classic accounts payable)." },
    { kind: "exact", value: "BSAK", reason: "Cleared vendor items (classic accounts payable)." },
    { kind: "exact", value: "BSIS", reason: "Open G/L account items." },
    { kind: "exact", value: "BSAS", reason: "Cleared G/L account items." },
    { kind: "exact", value: "FAGLFLEXA", reason: "New G/L actual line items." },
    { kind: "exact", value: "FAGLFLEXT", reason: "New G/L totals." },
    { kind: "exact", value: "REGUH", reason: "Payment run settlement data, including payee bank details." },
    { kind: "exact", value: "REGUP", reason: "Payment run line items — which invoices were paid, and when." },
    { kind: "exact", value: "PAYR", reason: "Payment and cheque register." },
    { kind: "exact", value: "BNKA", reason: "Bank master data." },

    // ---- 4. Personal data (prefix + exact) ----
    { kind: "prefix", value: "ADR", reason: "Central address management — ADRC postal addresses, ADR2 telephone, ADR6 e-mail." },
    { kind: "prefix", value: "BUT", reason: "Business partner master — BUT000 names, BUT020 addresses, BUT0BK bank details." },
    { kind: "exact", value: "KNA1", reason: "Customer master — names and addresses." },
    { kind: "exact", value: "KNVK", reason: "Customer contact persons — named individuals with contact details." },
    { kind: "exact", value: "KNBK", reason: "Customer bank details." },
    { kind: "exact", value: "KNVP", reason: "Customer partner functions — who is contacted for what." },
    { kind: "exact", value: "LFA1", reason: "Vendor master — names and addresses." },
    { kind: "exact", value: "LFBK", reason: "Vendor bank details." },
    { kind: "exact", value: "LFB1", reason: "Vendor company-code data — payment terms and bank data." },
    { kind: "exact", value: "USER_ADDR", reason: "Address data of every SAP user — name, telephone, e-mail." },
  ] as PreviewDenyRule[]).map((r) => Object.freeze(r)),
);

/** Reason attached to every operator-supplied entry, so refusals stay legible. */
const OPERATOR_DENY_REASON =
  "Added by the operator via ABAP_DATA_PREVIEW_DENY_TABLES.";

/**
 * Remediation for a lockout caused by a probe that never completed. Names a
 * restart rather than a retry on purpose: the lockout is a one-way latch
 * (`SafetyGate.update`, doc/SAFETY/safety-gate.md "The lockout is a one-way latch"), so
 * re-calling the tool in this process cannot re-run the probe.
 */
const PROBE_FAILURE_HINT =
  "This is not a configuration problem: no flag, allowlist or ABAP_MODE value is involved, and " +
  "none would lift it. The connection to the ABAP system dropped before T000-CCCATEGORY could be " +
  "read, which says nothing about whether the system is productive. The write lockout is a " +
  "one-way latch held for the life of this server process, so retrying the call will not re-run " +
  "the probe — restart the server to probe again, and if it keeps failing, investigate network " +
  "stability between this host and the ABAP system.";

/**
 * One `ABAP_DATA_PREVIEW_DENY_TABLES` entry → a rule. A trailing `*` means
 * prefix (`ZPA*`), anything else is exact. Additive by construction: this
 * produces rules, never removes one, so no operator value can widen the
 * defaults. Empty entries are dropped.
 */
function operatorDenyRule(entry: string): PreviewDenyRule | undefined {
  const v = entry.trim().toUpperCase();
  if (!v) return undefined;
  if (v.endsWith("*")) {
    return { kind: "prefix", value: v.slice(0, -1), reason: OPERATOR_DENY_REASON };
  }
  return { kind: "exact", value: v, reason: OPERATOR_DENY_REASON };
}

function ruleMatches(rule: PreviewDenyRule, candidates: readonly string[]): boolean {
  return rule.kind === "exact"
    ? candidates.includes(rule.value)
    : candidates.some((c) => c.startsWith(rule.value));
}

/**
 * Is `name` on the preview deny-list? Frozen defaults ∪ operator additions.
 *
 * Matching is upper-cased and judges TWO strings: the whole name, and the
 * segment after the last `/`. Without the second, `/ACME/PA0008` sails past the
 * `PA0` prefix and the list fails open on every namespaced copy of an infotype.
 *
 * Exact rules are tested before prefix rules so the refusal quotes the most
 * specific reason (`HRPY_RGDIR` reads as payroll, not as the `HRP` family), and
 * defaults are tested before operator additions so a documented rule wins the
 * attribution.
 */
export function isPreviewTableDenied(
  name: string,
  extra?: readonly string[],
): { denied: boolean; rule?: PreviewDenyRule } {
  const upper = name.trim().toUpperCase();
  if (!upper) return { denied: false };
  const slash = upper.lastIndexOf("/");
  const candidates =
    slash >= 0 && slash < upper.length - 1 ? [upper, upper.slice(slash + 1)] : [upper];

  const rules: PreviewDenyRule[] = [...DEFAULT_PREVIEW_DENY_TABLES];
  for (const entry of extra ?? []) {
    const r = operatorDenyRule(entry);
    if (r) rules.push(r);
  }
  for (const rule of rules) {
    if (rule.kind === "exact" && ruleMatches(rule, candidates)) return { denied: true, rule };
  }
  for (const rule of rules) {
    if (rule.kind === "prefix" && ruleMatches(rule, candidates)) return { denied: true, rule };
  }
  return { denied: false };
}

/**
 * Module-private capability token, never exported, so no code outside this
 * file can construct an `AuthorizedTarget` at compile time. The constructor
 * also checks it at runtime, so an `as unknown as AuthorizedTarget<...>` cast
 * (which TypeScript cannot prevent) still throws when actually constructed —
 * a deliberate bypass is loud, not silent.
 */
const MINT = Symbol("AuthorizedTarget.mint");
type MintToken = typeof MINT;

/**
 * Proof that `op` against `target` has already passed {@link SafetyGate}'s
 * checks — the structural fix for "the gate is an optional parameter":
 * mutating call sites take an `AuthorizedTarget<Op>` instead of
 * `(conn, uri, gate?: SafetyGate)`, so forgetting to gate a call becomes a
 * compile error, not a silent, legal permit.
 *
 * Only constructible via {@link SafetyGate.authorize}/{@link SafetyGate.authorizeIntent},
 * which hold the unexported `MINT`. `target` is generic (`P`) so each call
 * site carries exactly the fields it needs for its wire call.
 */
export class AuthorizedTarget<
  Op extends MutatingOperation = MutatingOperation,
  P extends SafetyTarget = SafetyTarget,
> {
  readonly op: Op;
  readonly target: P;

  constructor(token: MintToken, op: Op, target: P) {
    if (token !== MINT) {
      throw new Error(
        "AuthorizedTarget can only be constructed by SafetyGate.authorize/authorizeIntent " +
          "(src/safety.ts).",
      );
    }
    this.op = op;
    this.target = target;
  }
}

export class SafetyGate {
  /** Audit trail for {@link resetWriteLockout} — see {@link writeLockoutResets}. */
  private readonly lockoutResets: string[] = [];

  constructor(private cfg: SafetyConfig) {}

  /**
   * "Why is this capability off, and what actually turns it on?" — computed
   * from {@link SafetyConfig.abapMode} (the mechanism that made the decision)
   * rather than a hand-written sentence, so it can't say "set ABAP_ALLOW_X"
   * on a server where that var is never read. Refusals about the narrowing
   * override lists (ABAP_ALLOW_PACKAGES, ABAP_ALLOW_TRANSPORTS,
   * ABAP_ALLOW_NAME_PREFIXES, ABAP_ENHANCE_TARGET_PACKAGES,
   * ABAP_ORIGIN_SYSTEMS) deliberately do NOT route through here — those vars
   * are still read under ABAP_MODE, so naming them directly is correct.
   */
  private why(req: ModeGovernedCapability | CapabilityRequirement): {
    cause: string;
    remediation: string;
  } {
    const e = explainDeniedCapability(req, this.cfg.abapMode);
    return { cause: e.cause, remediation: e.remediation };
  }

  /** {@link why} for a refusal that needs more than one capability at once. */
  private whyAll(reqs: ReadonlyArray<ModeGovernedCapability | CapabilityRequirement>): {
    cause: string;
    remediation: string;
  } {
    return explainDeniedCapabilities(reqs, this.cfg.abapMode);
  }

  /**
   * Merge a patch into the live config. Every field is an ordinary overwrite
   * except `writesLockedOut`, which is a ONE-WAY latch: once locked, no
   * `update()` can clear it (a patch carrying `false`/`undefined` leaves it
   * standing and drops the incoming verdict too) — only
   * {@link resetWriteLockout} can. Asymmetric on purpose: staying locked on a
   * real sandbox costs inconvenience; unlocking on real production costs an
   * unauthorised write nothing undoes. Needed here rather than at the call
   * site because `server.ts` re-transcribes the probe verdict after every
   * primary logon, and a re-seated pool connection re-probes from scratch —
   * a later inconclusive/productive verdict must not silently re-open writes
   * process-wide. Detection itself already fails closed (an inconclusive
   * re-probe LOCKS, never opens — `detectSystemRole()`,
   * src/adt/connection.ts); this latch only stops the gate from forgetting a
   * lockout it was already told about. Omitting `writesLockedOut` from a
   * patch is a no-op for it; every other field updates normally.
   */
  update(patch: Partial<SafetyConfig>): void {
    const next = { ...this.cfg, ...patch };
    if (this.cfg.writesLockedOut && !next.writesLockedOut) {
      next.writesLockedOut = true;
      // Latch the WHOLE verdict, not just the boolean: `lockoutReason` is
      // quoted verbatim in the refusal, so leaving contradictory incoming
      // evidence in place would print a refusal that argues against itself.
      // A patch STRICTER than the latched verdict keeps its stricter half.
      if (patch.productive !== true) next.productive = this.cfg.productive;
      if (patch.systemRole !== "productive") next.systemRole = this.cfg.systemRole;
      // `roleProbeFailure` qualifies `lockoutReason`: keeping one while
      // dropping the other prints a cause that does not match the evidence
      // it is explaining, so they latch or fall through together.
      const keepLatched = this.cfg.lockoutReason !== undefined;
      next.lockoutReason = keepLatched ? this.cfg.lockoutReason : patch.lockoutReason;
      next.roleProbeFailure = keepLatched ? this.cfg.roleProbeFailure : patch.roleProbeFailure;
    }
    this.cfg = next;
  }

  /**
   * The one deliberate way to clear a write lockout latched by {@link update}
   * — a named, separate call so clearing a safety verdict is always explicit,
   * never a side effect of a routine merge. `reason` must be non-empty:
   * requiring the caller to write down why makes an accidental call hard to
   * spell. Clears the lockout and its evidence ONLY — does not touch
   * `productive`/`systemRole` (a system PROVEN productive is refused by a
   * separate, un-overridable branch of `evaluate()`). A later `update()` with
   * a fresh verdict can re-latch the lockout normally.
   */
  resetWriteLockout(reason: string): void {
    const why = reason.trim();
    if (!why) {
      throw new Error(
        "resetWriteLockout(reason) requires a non-empty reason — clearing a write lockout is a deliberate act and must be attributable.",
      );
    }
    this.lockoutResets.push(why);
    this.cfg = { ...this.cfg, writesLockedOut: false, lockoutReason: undefined, roleProbeFailure: undefined };
  }

  /**
   * Every reason given to {@link resetWriteLockout}, oldest first — an audit
   * trail of the times this process talked itself out of a safety verdict.
   */
  get writeLockoutResets(): readonly string[] {
    return this.lockoutResets;
  }

  get config(): Readonly<SafetyConfig> {
    return this.cfg;
  }

  /** Object-name prefixes currently in force for types that do not override them. */
  get namePrefixes(): string[] {
    return this.cfg.allowNamePrefixes ?? DEFAULT_NAME_PREFIXES;
  }

  /**
   * The prefix list that judges THIS type's names.
   *
   * The global list (`ABAP_ALLOW_NAME_PREFIXES`, default `["*"]`) is
   * wrong for exactly one type: SAP itself rejects a lock object named
   * `ZRECON_MLK1` (`400 ExceptionResourceCreationFailure`, "Test objects
   * cannot be created in foreign namespaces") and requires `EZRECON_MLK1` —
   * captured live against a real system. A type may declare its own list in
   * `src/adt/capabilities.ts`, which REPLACES the global one for that type
   * (relaxing the global default to include `E` would loosen the gate for
   * all types; intersecting the lists would refuse every lock-object name).
   * The override applies even under the wildcard {@link NAME_PREFIX_WILDCARD}
   * — a per-type list states what the SERVER accepts, not what this
   * installation wants to permit, so `*` cannot silence it; honouring
   * `["EZ","EY"]` under a wildcard turns a wasted round trip into an
   * instant, explained refusal. Types without an override are unaffected —
   * pinned by `test/safety.test.ts`.
   */
  namePrefixesForType(type: string | undefined): string[] {
    const override = capabilitiesFor(type)?.namePrefixes;
    return override && override.length > 0 ? override : this.namePrefixes;
  }

  /**
   * Transport allowlist in force. Unset ⇒ {@link DEFAULT_TRANSPORTS}; an
   * explicitly empty array is preserved as empty, because that is a deliberate
   * deny-all and not an absence of configuration.
   */
  get transportAllowlist(): string[] {
    return this.cfg.allowTransports ?? DEFAULT_TRANSPORTS;
  }

  /** `ABAP_ENHANCE_TARGETS` in force. Unset ⇒ {@link DEFAULT_ENHANCE_TARGETS}. */
  get enhanceTargets(): EnhanceTargets {
    return this.cfg.enhanceTargets ?? DEFAULT_ENHANCE_TARGETS;
  }

  /** Packages that may be ENHANCED. Unset and explicitly empty both mean deny-all. */
  get enhanceTargetPackages(): string[] {
    return this.cfg.enhanceTargetPackages ?? [];
  }

  /**
   * SIDs treated as ADDITIONAL local origin, normalised. Empty ⇒ no
   * additional origins beyond this system's own SID — see
   * {@link isLocalOrigin} for the full predicate; this getter alone is no
   * longer the whole story.
   */
  get originSystems(): string[] {
    return (this.cfg.originSystems ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean);
  }

  /**
   * This server's own SID (`SafetyConfig.sid`, i.e. `ABAP_SID`), normalised,
   * or `undefined` when it is not usably configured. `"UNKNOWN"` — the schema
   * default `loadConfig()` produces when `ABAP_SID` was never set — is
   * treated as unset rather than as a real identity: this value feeds a
   * security predicate ({@link isLocalOrigin}), and a placeholder must never
   * be capable of matching a real `adtcore:masterSystem` by coincidence.
   */
  get ownSid(): string | undefined {
    const s = this.cfg.sid?.trim().toUpperCase();
    return s && s !== "UNKNOWN" ? s : undefined;
  }

  /**
   * Is `masterSystem` (from `adtcore:masterSystem`, e.g.
   * {@link EnhancementIntent.targetMasterSystem}/`.enhancementMasterSystem`)
   * evidence the object counts as LOCAL to this installation? Local if any of:
   * (1) absent — unpopulated for any object that has never left this system
   * ($TMP, untransported package), so absence is positive evidence, not a
   * gap to fail closed on; (2) equals this system's own SID ({@link ownSid});
   * (3) named in `ABAP_ORIGIN_SYSTEMS` (additional trusted origins, e.g. a
   * former SID retained after a copy/refresh) — widens (1)/(2), never the
   * sole test, so an empty list means "no extra origins", not "nothing is
   * local". FIXED BUG: previously `ABAP_ORIGIN_SYSTEMS.includes(masterSystem)`
   * was the sole test, defaulting to `[]` and so refusing every enhancement
   * tool unconditionally out of the box — see
   * the git history for the full incident writeup. A real
   * other system (`"SAP"`, an unlisted partner SID) still fails all three and
   * is still refused or routed through the `sap`/partner opt-in ceiling,
   * unchanged. Test matrix: `test/safety.test.ts`.
   */
  private isLocalOrigin(masterSystem: string | undefined): boolean {
    const ms = masterSystem?.trim().toUpperCase();
    if (!ms) return true;
    if (this.ownSid && ms === this.ownSid) return true;
    return this.originSystems.includes(ms);
  }

  /** Non-throwing evaluation, so tools can explain rather than just fail. */
  evaluate(
    op: Operation,
    obj?: SafetyTarget,
    opts: EvaluateOptions = {},
  ): SafetyDecision {
    if (!MUTATING_OPS.has(op)) return { allowed: true, reason: "read operations are always allowed" };

    // Un-overridable half of the gate, checked BEFORE `readOnly`: these hold
    // even with ABAP_ALLOW_WRITE=true, or they'd just be a default, not a gate.
    if (this.cfg.productive || this.cfg.systemRole === "productive") {
      return {
        allowed: false,
        reason: "System reports itself as productive — writes are forced off with no override.",
        rule: "productive → read-only",
        code: "READ_ONLY",
      };
    }
    if (this.cfg.writesLockedOut) {
      const probeFailure = this.cfg.roleProbeFailure;
      if (probeFailure !== undefined) {
        return {
          allowed: false,
          reason:
            "The system-role probe never got an answer, so this system is unclassified and " +
            `writes are refused. The T000 probe failed below HTTP: ${probeFailure}. That is a ` +
            "dropped connection, not a finding about the system's role.",
          rule: "probe did not complete → read-only (fail closed)",
          code: "ROLE_PROBE_FAILED",
          hint: PROBE_FAILURE_HINT,
        };
      }
      // Not "productive": the T000 probe couldn't PROVE non-productive.
      // `lockoutReason` tells the operator whether to fix a permission, a
      // logon client, or their assumption this is a sandbox.
      return {
        allowed: false,
        reason:
          "This system could not be proven non-productive, so writes are refused. " +
          (this.cfg.lockoutReason ?? "The system-role probe returned no usable evidence.") +
          " A write flag does not override this, and no ABAP_MODE value does either.",
        rule: "unproven → read-only (fail closed)",
        code: "READ_ONLY",
      };
    }
    // Release/delete each need BOTH ABAP_ALLOW_WRITE and their own ceiling
    // flag, never implied by write alone. Split into distinct branches (not
    // one combined condition) so the message names every missing flag —
    // otherwise an operator who sets only the ceiling flag gets refused a
    // second time by the plain read-only branch below with no mention of it.
    // Both carry code READ_ONLY (not SAFETY_DENIED): the taxonomy here is
    // READ_ONLY = a capability switch is off, SAFETY_DENIED = an allowlist
    // didn't match a target. `assertMutationAllowed` (src/debug/transport.ts)
    // enforces only READ_ONLY when called target-less and treats
    // SAFETY_DENIED as undecidable — mislabeling a target-less release as
    // SAFETY_DENIED would let such a caller skip it, fail-open, for the most
    // consequential transport action there is.
    if (op === "transport" && opts.release && this.cfg.readOnly) {
      const why = this.whyAll(["allowWrite", "allowTransportRelease"]);
      return {
        allowed: false,
        reason:
          "Server is running read-only, so releasing a transport request is refused. " +
          `Release needs both of them. ${why.cause} ${why.remediation}`,
        rule: "read-only default (release also needs the transport-allowlist ceiling)",
        code: "READ_ONLY",
      };
    }
    // Delete-ceiling counterpart of the release check above — same shape.
    if (op === "transport" && opts.deleteTransport && this.cfg.readOnly) {
      const why = this.whyAll(["allowWrite", "allowTransportDelete"]);
      return {
        allowed: false,
        reason:
          "Server is running read-only, so deleting a transport request is refused. " +
          `Delete needs both of them. ${why.cause} ${why.remediation}`,
        rule: "read-only default (delete also needs the transport-allowlist ceiling)",
        code: "READ_ONLY",
      };
    }
    if (this.cfg.readOnly) {
      // Reachable only as the plain default — the unproven-system case is
      // already refused above by `writesLockedOut`, not here.
      const why = this.why("allowWrite");
      return {
        allowed: false,
        reason: `Server is running read-only. ${why.cause} ${why.remediation}`,
        rule: "read-only default",
        code: "READ_ONLY",
      };
    }
    // Writes ARE enabled, only the release ceiling is closed.
    if (op === "transport" && opts.release && !this.cfg.allowTransportRelease) {
      const why = this.why("allowTransportRelease");
      return {
        allowed: false,
        reason:
          "Writes are enabled but releasing a transport request is a separate ceiling. " +
          `${why.cause} ${why.remediation}`,
        rule: "transport release ceiling",
        code: "READ_ONLY",
      };
    }
    // Delete-ceiling counterpart of the release check above. Fails closed on
    // undefined `allowTransportDelete` (`!undefined` is `true`), so a
    // hand-built `SafetyConfig` omitting this field is refused, not
    // defaulted open — previously any write-enabled mode could delete a
    // transport request outright since this ceiling didn't exist yet.
    if (op === "transport" && opts.deleteTransport && !this.cfg.allowTransportDelete) {
      const why = this.why("allowTransportDelete");
      return {
        allowed: false,
        reason:
          "Writes are enabled but deleting a transport request is a separate ceiling. " +
          `${why.cause} ${why.remediation}`,
        rule: "transport delete ceiling",
        code: "READ_ONLY",
      };
    }
    if (op === "transport" && !obj) {
      // No object (list/show/create-empty/status/release) means the
      // object-keyed rules below (SAP namespace/package, package allowlist,
      // name-prefix rule, transport allowlist at step 10) have nothing to
      // judge — running them would invent a verdict, and fail-closed here
      // would make `abap_transport list` require a package allowlist.
      // Does NOT weaken `allowTransports: []`: the moment an object actually
      // enters a transport (write/activate/delete with a real target +
      // corrNr), it's refused at step 10 below, unchanged. This is still a
      // mutation gated as one — productive/writesLockedOut/read-only above
      // already ran, so create/delete still needs ABAP_ALLOW_WRITE and
      // release still needs its ceiling flag.
      return {
        allowed: true,
        reason: "Transport-level operation with no object: the object rules (SAP namespace, package, name prefix, transport allowlist) have nothing to judge.",
      };
    }
    if (!obj) {
      return {
        allowed: false,
        reason: "No object supplied for a mutating operation.",
        rule: "no object supplied for mutating operation",
        code: "SAFETY_DENIED",
      };
    }
    if (isSapNamespace(obj.name)) {
      return {
        allowed: false,
        reason: `${obj.name} lives in a reserved SAP namespace.`,
        rule: "SAP namespace denied",
        code: "SAFETY_DENIED",
      };
    }
    // Invocation targets (TCODE, `isInvocationTarget`) skip the
    // repository-object rules below — package allowlist, name-prefix rule,
    // and transport allowlist all judge properties a tcode doesn't have
    // (`SE16` is real and SAP-shipped; no `ABAP_ALLOW_NAME_PREFIXES` value
    // makes it start with `Z`, so this rule used to refuse every standard
    // tcode with unfollowable advice — the live SE16 bug this branch fixes).
    // Placed after `isSapNamespace` on purpose: a namespaced tcode like
    // `/BOFU/SOMETHING` is still denied, categorically, unrelated to this
    // carve-out. Only fires when `isInvocationTarget(obj.type)` — no
    // existing caller sets `type: "TCODE"` for a real repository object, and
    // the productive/lockout/read-only ceilings above already ran.
    if (isInvocationTarget(obj.type)) {
      return {
        allowed: true,
        reason:
          `${obj.name} is an invocation target (${obj.type}), not a repository object: the ` +
          "package allowlist, the customer-namespace name-prefix rule, and the " +
          "transport allowlist all judge properties a transaction code does not have. The " +
          "productive-system, write-lockout and read-only ceilings above already applied, and " +
          "the SAP-namespace check above still refuses a registered namespace tcode.",
      };
    }
    if (isSapPackage(obj.packageName)) {
      return {
        allowed: false,
        reason: `Package ${obj.packageName} is SAP-owned. Modifying it needs an access key and a human.`,
        rule: "SAP namespace denied",
        code: "SAFETY_DENIED",
      };
    }
    // Package rules — deferred in pre-flight when the object's real package
    // isn't known yet. The allowlist judges `packageName` for ordinary
    // objects, but for `DEVC/K` (a package) its own `packageName` is ITSELF
    // (see `isSapPackage`), so a package CREATE must be judged by its
    // `superPackage` instead — judging it by its own (not-yet-existing) name
    // made every create categorically unreachable, for any allowlist. This
    // widens nothing else: the SAP-owner and name-prefix checks below still
    // judge the new package's own name. `exists !== true` scopes this to
    // creates; `op === "write"` on top of that matters because pre-flight
    // never learns `exists` (zero network), so a `DEVC/K` delete also has
    // `exists !== true` and would otherwise misread as a ROOT-package create
    // and get refused with a confusing message instead of the real one
    // (`deleteObject`: packages aren't deleted here).
    const isPackageCreate =
      op === "write" && (obj.type ?? "").trim().toUpperCase() === "DEVC/K" && obj.exists !== true;
    const container = isPackageCreate ? obj.superPackage : obj.packageName;
    const packageKnown = container !== undefined && container !== "";
    // Deferring an ordinary object's package rule in pre-flight (real
    // package not yet resolved) is the point of a two-phase gate. A package
    // CREATE's `superPackage`, though, is always known upfront — derived
    // purely from the caller's own `package` argument, never a network
    // response — so deferring it would let a ROOT create sail through
    // pre-flight and only get caught after spending the resolve GET the
    // two-phase gate exists to avoid. `isPackageCreate` forces this block
    // open on both phases.
    if (isPackageCreate || opts.phase !== "preflight" || packageKnown) {
      if (this.cfg.allowPackages.length === 0) {
        return {
          allowed: false,
          reason: "No package allowlist is configured, so no package may be written to.",
          rule: "writes need an explicit flag AND an allowlist",
          code: "SAFETY_DENIED",
        };
      }
      // `*` is the one allowlist entry meaning "anywhere", so it covers root
      // too; matched as a literal list entry, not via packagePattern(""),
      // which would wrongly match root on an empty-string entry.
      const rootWildcarded =
        isPackageCreate && !packageKnown && this.cfg.allowPackages.some((p) => p.trim() === "*");
      if (isPackageCreate && !packageKnown && !rootWildcarded) {
        return {
          allowed: false,
          reason:
            `${obj.name} would be a ROOT package — it names no superpackage, so it lands in no ` +
            `allowlisted container, and a list of named containers cannot match "no container". ` +
            `The allowlist is [${this.cfg.allowPackages.join(", ")}]. To create a root package the ` +
            `allowlist must contain the explicit wildcard entry: ABAP_ALLOW_PACKAGES='*'.`,
          rule: "package allowlist",
          code: "SAFETY_DENIED",
        };
      }
      // Short-circuits via `||` rather than relying on packagePattern("*")
      // matching "" — keeps this tied to the literal entry above.
      const pkg = container ?? "";
      const matched = rootWildcarded || this.cfg.allowPackages.some((p) => packagePattern(p).test(pkg));
      if (!matched) {
        return {
          allowed: false,
          reason: isPackageCreate
            ? `Superpackage ${pkg} is not in the allowlist [${this.cfg.allowPackages.join(", ")}] — ` +
              `a new package may only be created inside an allowlisted container.`
            : `Package ${pkg || "(unknown)"} is not in the allowlist [${this.cfg.allowPackages.join(", ")}].`,
          rule: "package allowlist",
          code: "SAFETY_DENIED",
        };
      }
    }
    // Name allowlist — last, so it can only narrow what the rules above allowed.
    const name = (obj.name ?? "").trim().toUpperCase();
    // Per-type first, global otherwise — see `namePrefixesForType`. The refusal
    // names the type when the list came from it, so a caller told that
    // `ZMY_LOCK` is out of namespace can see that the rule is ENQU/DL's and not
    // the installation's, and can fix the name instead of the configuration.
    const prefixes = this.namePrefixesForType(obj.type);
    const perType = prefixes !== this.namePrefixes;
    // `*` anywhere in the effective list switches this one rule off — see
    // `NAME_PREFIX_WILDCARD` for why it is a token and not "empty means all",
    // and for the two things it deliberately does not reach. Note that
    // `prefixes` is the PER-TYPE list where one exists, so a global wildcard
    // never lands here for ENQU/DL: the type's own `["EZ","EY"]` is what gets
    // tested, exactly as it would without the wildcard.
    const unrestricted = isUnrestrictedPrefixList(prefixes);
    if (
      !unrestricted &&
      prefixes.length &&
      !prefixes.some((p) => name.startsWith(p.trim().toUpperCase()))
    ) {
      return {
        allowed: false,
        reason:
          `${obj.name} is outside the customer namespace: a write must target a name starting with [${prefixes.join(", ")}]` +
          (perType
            ? `. ${obj.type} names are judged against that list and not the general one ` +
              `[${this.namePrefixes.join(", ")}], because the ABAP system itself refuses ` +
              `the general one for this type — ABAP_ALLOW_NAME_PREFIXES=${NAME_PREFIX_WILDCARD} ` +
              "does not lift it."
            : `. Set ABAP_ALLOW_NAME_PREFIXES to a list that covers it, or to ` +
              `${NAME_PREFIX_WILDCARD} to drop the name rule entirely (SAP-owned objects stay ` +
              "denied either way)."),
        rule: "object-name allowlist",
        code: "SAFETY_DENIED",
      };
    }
    // ---- `SafetyTarget.type` finally participates ----
    // Until this block existed, `type` was declared on SafetyTarget, passed by
    // every caller, and read by NOTHING in the decision path. The gate answered
    // "may this name, in this package, be written?" and never "what does this
    // change?" — a gate satisfied by construction for any object class whose
    // blast radius is not its own URI.
    //
    // The enhancement family is exactly that class. An ENHO named `ZENH_FOO` in
    // `$TMP` is, by name and package, the most harmless object this gate can be
    // shown; what it actually does is inject code into whatever SAP standard
    // object its spot binds to. So when the type says "enhancement", the
    // URI-shaped rules above are declared INSUFFICIENT and an intent is
    // required. No intent ⇒ refusal. This is the only branch that reads `type`,
    // and it only ever narrows.
    //
    // Placed after the name and package rules on purpose: the artefact's own
    // Q1 answers ("may I write this, here?") come first and stand alone, then
    // the intent's Q2 answer ("may I change THAT?") can only narrow them. A
    // permissive ABAP_ENHANCE_TARGETS therefore cannot reach a package
    // ABAP_ALLOW_PACKAGES does not name — the two knobs never widen each other.
    //
    // On an ALLOWED decision the enhancement verdict's own wording is carried
    // into the final reason, so an approval says which object was admitted and
    // on what grounds — "Package $TMP is allowlisted" is true and useless when
    // the interesting fact is that partner content in system PRT was just
    // opted into.
    let enhancementReason: string | undefined;
    if (isEnhancementType(obj.type)) {
      const intent = opts.intent;
      if (!intent) {
        // `phase: "final"` is a call site's own declaration that resolution
        // is complete and the target it is handing the gate is authoritative
        // — see the doc comment on `INTERNAL_GATE_MISUSE` (adt/errors.ts) for
        // the full reasoning. A caller that reaches here has resolved an
        // enhancement-type object and asked the gate to judge it in that
        // authoritative phase without ever building the `EnhancementIntent`
        // its own type requires — the exact bug class (a value available at
        // the call site, silently never used) round 2 of the abap_activate
        // fix exists to make impossible to ship unnoticed again. Anything
        // else (`phase` absent, or explicitly `"preflight"`) is a genuine,
        // ordinary refusal — a caller can legitimately reach `evaluate()`
        // pre-resolution with no `affects` at all, and that stays exactly
        // the `SAFETY_DENIED` refusal below, unchanged.
        if (opts.phase === "final") {
          return {
            allowed: false,
            reason:
              `INTERNAL: the safety gate was asked to judge ${obj.name} (${obj.type}) at ` +
              "phase:\"final\" — a declaration that resolution is complete and this target is " +
              "authoritative — with no EnhancementIntent. That combination is never a legitimate " +
              "user-facing refusal: every enhancement-type target reaching the FINAL phase must " +
              "already have had its EnhancementIntent built from the caller's `affects` (see " +
              "enhancementIntentFor()/enhancementPreflightIntent(), and authorizeMutation() for " +
              "the reference pattern) before this call. This is a wiring defect in abapsmith's own " +
              "code, not a decision about this request — the call site dropped the intent instead " +
              "of building and passing it. Fix the call site; there is no flag that silences this.",
            rule: "gate self-defence: final-phase enhancement target with no intent",
            code: "INTERNAL_GATE_MISUSE",
          };
        }
        return {
          allowed: false,
          reason:
            `${obj.name} is an enhancement object (${obj.type}), whose effect is on an object ` +
            "that does not appear in its own name, package or URI. The gate cannot judge it " +
            "from the artefact alone: supply `affects` — the object this enhancement changes " +
            "the behaviour of (name, packageName, and optionally masterSystem/spotName) — so " +
            "the write can be judged against what it actually touches.",
          rule: "enhancement write needs an intent",
          code: "SAFETY_DENIED",
        };
      }
      const declared = intent.enhancementName.trim().toUpperCase();
      if (declared !== (obj.name ?? "").trim().toUpperCase()) {
        // An intent describing a different artefact than the one being written
        // is how a permitted intent gets reused to authorise something else.
        return {
          allowed: false,
          reason:
            `The supplied enhancement intent describes ${intent.enhancementName}, but this ` +
            `operation targets ${obj.name}. An intent authorises the artefact it names and no other.`,
          rule: "intent/artefact mismatch",
          code: "SAFETY_DENIED",
        };
      }
      const enhancement = this.enhancementRules(intent);
      if (!enhancement.allowed) return enhancement;
      enhancementReason = enhancement.reason;
    }
    // Step 10: transport allowlist — after the package (step 8) and
    // name-prefix (step 9) checks, so those refuse first even when
    // transports are wide open. `ABAP_ALLOW_TRANSPORTS` and
    // `ABAP_ALLOW_PACKAGES` are independent knobs; neither implicitly widens
    // the other.
    const pkgUpper = (obj.packageName ?? "").trim().toUpperCase();
    const needsTransport = packageKnown && pkgUpper !== "" && !pkgUpper.startsWith("$");
    if (needsTransport) {
      // Unset ⇒ DEFAULT_TRANSPORTS (any request); explicitly empty ⇒ deny-all.
      const allowTransports = this.transportAllowlist;
      // No explicit `corr` means caller named nothing via `corrNr`/auto-select.
      // Blank-normalised first: `""` is not the name of a transport, so
      // it must mean "auto" here exactly as it already does on abap_write —
      // otherwise the same argument writes on one tool and is refused
      // SAFETY_DENIED on another, with refusal text blaming the allowlist.
      const namedCorrNr = normalizeCorrNr(opts.corrNr);
      const corr: SafetyCorr = opts.corr ?? {
        kind: "transport",
        corrNr: namedCorrNr ?? "auto",
        source: namedCorrNr === undefined ? "auto" : "named",
      };
      // Deny-all is decidable with no number, so it fires even `unresolved` —
      // keeps the refusal before resolve() can create a stray request.
      if (allowTransports.length === 0) {
        return {
          allowed: false,
          reason:
            `${obj.name} is in package ${obj.packageName}, which needs a transport request, but ` +
            "ABAP_ALLOW_TRANSPORTS is explicitly empty — every transportable write is refused. " +
            "$TMP writes are unaffected.",
          rule: "transport allowlist (fail closed)",
          code: "SAFETY_DENIED",
        };
      }
      // `{kind:"local"}` skips step 10 for a transportable-looking package.
      // Only a call site that knows no CTS call happens may mint it: SAP
      // said so (`corrForMutation` via `transportFromLock`, src/adt/write.ts),
      // or the code path provably issues none (BOPF create, src/adt/bopf.ts;
      // the classic-view/transaction delete bridges, src/adt/view-delete.ts
      // and src/adt/tran-delete.ts, which register nothing in CTS — no
      // RS_CORR_INSERT).
      if (corr.kind === "local") {
        return {
          allowed: true,
          reason: join(
            `${obj.name} resolved to a local (non-transportable) write; the transport allowlist does not apply.`,
            enhancementReason,
          ),
        };
      }
      const normalized = allowTransports.map((t) => t.trim().toUpperCase());
      if (!normalized.includes("*") && corr.kind === "transport") {
        // `server-pin` maps to `"auto"` — a server-imposed selection IS
        // auto-selection. Intended asymmetry: under the default `["auto"]`
        // list this permits it, but under a PINNED list it's still denied
        // ("AUTO" isn't in the list) — a vetted, specific list shouldn't let
        // an auto-selected transport slip through under a different name.
        const requested = corr.corrNr.trim().toUpperCase();
        const ok = normalized.includes(requested) || (corr.source === "auto" && normalized.includes("AUTO"));
        if (!ok) {
          return {
            allowed: false,
            reason:
              `Transport ${corr.corrNr} is not permitted by ABAP_ALLOW_TRANSPORTS ` +
              `[${allowTransports.join(", ")}].`,
            rule: "transport allowlist",
            code: "SAFETY_DENIED",
          };
        }
      }
      // corr.kind === "unresolved" with a non-empty list ⇒ defer to the
      // post-resolution check in preflightCorr.
    }
    return {
      allowed: true,
      reason: join(
        packageKnown
          ? isPackageCreate
            ? `Superpackage ${container} is allowlisted.`
            : `Package ${container} is allowlisted.`
          : "Package check deferred.",
        enhancementReason,
      ),
    };
  }

  /**
   * Gate a table data preview. Non-throwing; {@link assertDataPreview} throws.
   *
   * Not routed through `evaluate("read")`: that returns `{allowed:true}` for
   * every non-mutating op on its first line, which would skip the deny-list
   * and the productive ceiling and let `SELECT * FROM USR02` through on a
   * production system. Every check is written out here instead. Order:
   * productive/unproven ceiling first (un-overridable), then the deny-list.
   * `readOnly` is deliberately NOT checked — a preview is a read, and
   * `ABAP_MODE=read` must not switch it off; whether the feature is enabled
   * at all is `ABAP_ALLOW_DATA_PREVIEW`, decided in capabilities.
   */
  evaluateDataPreview(table: string, extraDeny?: readonly string[]): SafetyDecision {
    const name = table.trim();
    if (!name) {
      return {
        allowed: false,
        reason: "No table name was supplied, so nothing could be judged against the preview deny-list.",
        rule: "data preview",
        code: "SAFETY_DENIED",
      };
    }

    // Un-overridable ceiling, mirroring the write lockout in `evaluate` — same
    // three states, same order, same READ_ONLY code. All three refuse,
    // including a state the write path never considers: no probe has run yet.
    if (this.cfg.productive || this.cfg.systemRole === "productive") {
      return {
        allowed: false,
        reason:
          "System reports itself as productive — reading table contents is refused with no override. " +
          "No flag, including ABAP_ALLOW_DATA_PREVIEW, changes this.",
        rule: "productive → no data preview",
        code: "READ_ONLY",
      };
    }
    if (this.cfg.writesLockedOut) {
      const probeFailure = this.cfg.roleProbeFailure;
      if (probeFailure !== undefined) {
        return {
          allowed: false,
          reason:
            "The system-role probe never got an answer, so this system is unclassified and " +
            `reading table contents is refused. The T000 probe failed below HTTP: ${probeFailure}. ` +
            "That is a dropped connection, not a finding about the system's role.",
          rule: "probe did not complete → no data preview (fail closed)",
          code: "ROLE_PROBE_FAILED",
          hint: PROBE_FAILURE_HINT,
        };
      }
      return {
        allowed: false,
        reason:
          "This system could not be proven non-productive, so reading table contents is refused. " +
          (this.cfg.lockoutReason ?? "The system-role probe returned no usable evidence.") +
          " ABAP_ALLOW_DATA_PREVIEW does not override this.",
        rule: "unproven → no data preview (fail closed)",
        code: "READ_ONLY",
      };
    }
    if (this.cfg.writesLockedOut === undefined) {
      // Stricter than the write path on purpose: `writesLockedOut` is unset
      // only before `server.ts` transcribes the T000 probe's verdict, and a
      // preview (unlike a write) has no `readOnly` backstop for that window.
      // Unclassified is treated as unproven.
      return {
        allowed: false,
        reason:
          "The system role has not been determined on this connection yet, so reading table contents is refused. " +
          "A preview must not run before the system-role probe has proven the system non-productive.",
        rule: "unproven → no data preview (fail closed)",
        code: "READ_ONLY",
      };
    }

    // ---- The deny-list (fails open on anything unlisted — see the constant) ----
    const hit = isPreviewTableDenied(name, extraDeny ?? this.cfg.dataPreviewDenyTables);
    if (hit.denied && hit.rule) {
      const { kind, value, reason } = hit.rule;
      return {
        allowed: false,
        reason:
          `Table ${name.toUpperCase()} is on the data-preview deny-list ` +
          `(${kind} rule "${value}"): ${reason} ` +
          "This is a policy refusal, not a transient error — retrying will not change it. " +
          "The list matches the name as given, case-insensitively, plus the segment after the " +
          "last slash; it does not resolve a view to what it selects from, so a differently-named " +
          "view over the same rows is not caught by this rule.",
        rule: `preview deny-list (${kind} "${value}")`,
        code: "SAFETY_DENIED",
      };
    }

    return {
      allowed: true,
      reason: `Table ${name.toUpperCase()} is not on the data-preview deny-list.`,
    };
  }

  /**
   * Throwing form of {@link evaluateDataPreview}, for the preview tool. The
   * hint states the deny-list cannot be narrowed by any setting, unless the
   * decision carries its own hint.
   */
  assertDataPreview(table: string, extraDeny?: readonly string[]): void {
    const d = this.evaluateDataPreview(table, extraDeny);
    if (d.allowed) return;
    throw new AbapError(
      d.code ?? "SAFETY_DENIED",
      d.reason,
      {
        operation: "read",
        rule: d.rule,
        table: table.trim().toUpperCase(),
      },
      d.hint ??
        ("ABAP_DATA_PREVIEW_DENY_TABLES can only ADD entries to the built-in deny-list; no setting " +
          "removes one. A productive or unclassified system refuses every preview regardless of flags."),
    );
  }

  /**
   * Gate the variable-contents tier of a runtime-error dump read.
   * Non-throwing; {@link assertDumpVariables} throws.
   *
   * Two tiers: tier 1 (error class, program, include, line, timestamp, user,
   * source extract, call stack) is an ordinary read with NO gate anywhere —
   * a diagnostic tool that can't report what crashed isn't safer, it's
   * absent. Tier 2 is locals/work-areas/internal-table VALUES at the moment
   * of termination — the PII surface (customer records, bank details, salary
   * fields on a real system) — and the only thing this method judges.
   *
   * Not routed through `evaluate("read")`, same reasoning as
   * {@link evaluateDataPreview}. Deliberately does NOT check `readOnly` in
   * either direction: a read-only server must still be able to grant this
   * (capability-wise `canWrite === !readOnly`, so gating on it would hand
   * the widest access to the read-only production connection an operator
   * chose to be careful). Also deliberately carries no productive/lockout
   * ceiling — diagnosing production incidents is the point of this feature;
   * the operator's explicit `ABAP_ALLOW_DUMP_VARIABLES` opt-in is the control.
   */
  evaluateDumpVariables(): SafetyDecision {
    if (this.cfg.allowDumpVariables === true) {
      return {
        allowed: true,
        reason:
          "ABAP_ALLOW_DUMP_VARIABLES is set, so variable-bearing dump chapters may be returned.",
      };
    }
    return {
      allowed: false,
      reason:
        "Variable contents are withheld from this dump. The Selected Variables chapter holds the " +
        "live values of locals, work areas and internal tables at the moment of termination, which " +
        "on a system with real users behind it routinely means customer records, bank details and " +
        "salary fields — so it is returned only when an operator has explicitly opted in with " +
        "ABAP_ALLOW_DUMP_VARIABLES=true. That is the configured policy of this server, not a fault " +
        "and not an unfinished feature: retrying, rewording the request or asking for the chapter " +
        "by another name will not change it. Everything else about the dump is unaffected — error " +
        "class, program, include, line, the source extract and the call stack are all still " +
        "readable, and they answer what failed and where without any field values.",
      rule: "dump variables (tier 2) — ABAP_ALLOW_DUMP_VARIABLES",
      code: "DUMP_VARIABLES_DISABLED",
    };
  }

  /**
   * Throwing form of {@link evaluateDumpVariables}, for the dump tool. Carries
   * no dump key, chapter text or variable name in the error — an error
   * payload is as much a transcript as a successful response. The hint also
   * names the two flags that are NOT the answer (`ABAP_ALLOW_WRITE`,
   * `ABAP_MODE=admin`), since reaching for those gets neither the data nor a
   * clearer refusal.
   */
  assertDumpVariables(): void {
    const d = this.evaluateDumpVariables();
    if (d.allowed) return;
    throw new AbapError(
      d.code ?? "DUMP_VARIABLES_DISABLED",
      d.reason,
      {
        operation: "read",
        rule: d.rule,
        tier: "variables",
      },
      "ABAP_ALLOW_DUMP_VARIABLES=true is the only setting that enables this. It is deliberately " +
        "independent of ABAP_ALLOW_WRITE and of ABAP_MODE: a read-only server can grant it, and " +
        "ABAP_MODE=admin does not. Tier-1 dump reading (error class, program, line, source " +
        "extract, call stack) needs no flag at all.",
    );
  }

  /**
   * Gate the classic-DDIC `@AbapCatalog.sqlViewName` a `DDLS/DF` source names,
   * against the same namespace rules that judge the object's own name
   * (`isSapNamespace`, `namePrefixesForType`, `isUnrestrictedPrefixList`).
   * Non-throwing; {@link assertDdlsSqlViewName} throws.
   *
   * Not inside `evaluate()`: that judges `obj.name`, a short structured
   * string; `sqlViewName` must first be parsed out of the write's free-form
   * source, which `evaluate()`'s `SafetyTarget` never carries. Activation
   * creates a real database view at whatever `sqlViewName` says, independent
   * of the DDLS object's own name — so a `Z`-named DDLS could still point
   * activation outside the customer namespace unless this value is checked
   * too. Called from `abapWrite` (src/tools/write.ts), the one place a final
   * DDLS/DF source is known before writing.
   *
   * `extractSqlViewName` is deliberately conservative — refuses rather than
   * guesses on ambiguity. This method turns `"absent"` into an allow (e.g.
   * `define view entity` on 7.55+ has no classic `sqlViewName`) and anything
   * else that isn't `"found"` into a named refusal.
   */
  evaluateDdlsSqlViewName(source: string, obj: { name: string; type?: string }): SafetyDecision {
    const extraction = extractSqlViewName(source);
    if (extraction.kind === "absent") {
      return {
        allowed: true,
        reason:
          "No @AbapCatalog.sqlViewName annotation was found in this source, so there is no " +
          "database-view name to check against the customer namespace.",
      };
    }
    if (extraction.kind === "ambiguous" || extraction.kind === "unparseable") {
      return {
        allowed: false,
        reason:
          `This DDLS source's @AbapCatalog.sqlViewName could not be judged safely: ${extraction.detail} ` +
          "A write is refused rather than letting an unverified database-view name through — " +
          "activation would create that view under whatever name sqlViewName actually names, and " +
          "this gate cannot confirm that name stays inside the customer namespace.",
        rule: `ddls sqlViewName — ${extraction.kind}`,
        code: "SAFETY_DENIED",
      };
    }
    // extraction.kind === "found"
    const value = extraction.value;
    if (isSapNamespace(value)) {
      return {
        allowed: false,
        reason:
          `${obj.name}'s @AbapCatalog.sqlViewName activates a database view named ${value}, which ` +
          "lives in a reserved SAP namespace — the same rule that refuses a registered-namespace " +
          "object name refuses this.",
        rule: "ddls sqlViewName — SAP namespace denied",
        code: "SAFETY_DENIED",
      };
    }
    const prefixes = this.namePrefixesForType(obj.type);
    const unrestricted = isUnrestrictedPrefixList(prefixes);
    if (
      !unrestricted &&
      prefixes.length &&
      !prefixes.some((p) => value.startsWith(p.trim().toUpperCase()))
    ) {
      return {
        allowed: false,
        reason:
          `${obj.name}'s @AbapCatalog.sqlViewName activates a database view named ${value}, which is ` +
          `outside the customer namespace: it must start with [${prefixes.join(", ")}] — the same ` +
          `list that judges ${obj.name} itself. Set ABAP_ALLOW_NAME_PREFIXES to a list that covers ` +
          `it, or to ${NAME_PREFIX_WILDCARD} to drop the name rule entirely (SAP-owned namespaces ` +
          "stay denied either way).",
        rule: "ddls sqlViewName — outside customer namespace",
        code: "SAFETY_DENIED",
      };
    }
    return {
      allowed: true,
      reason: `@AbapCatalog.sqlViewName ${value} is inside the customer namespace.`,
    };
  }

  /**
   * Throwing form of {@link evaluateDdlsSqlViewName}, for the write path.
   */
  assertDdlsSqlViewName(source: string, obj: { name: string; type?: string }): void {
    const d = this.evaluateDdlsSqlViewName(source, obj);
    if (d.allowed) return;
    throw new AbapError(
      d.code ?? "SAFETY_DENIED",
      d.reason,
      {
        operation: "write",
        rule: d.rule,
        object: obj.name,
        type: obj.type,
      },
      "The database view a classic DDIC-based CDS view activates is named by its own " +
        "@AbapCatalog.sqlViewName annotation, not by the DDLS object's own name. This checks that " +
        "annotation against the same customer-namespace rule (ABAP_ALLOW_NAME_PREFIXES) that judges " +
        "the object name itself — point sqlViewName at a name inside the namespace, or make the " +
        "annotation unambiguous and parseable if this was refused for that reason instead.",
    );
  }

  /**
   * Gate an enhancement BEFORE any ABAP is generated.
   *
   * `evaluate()` is URI-shaped — it judges a resolved object's name, package,
   * type — but ADT REST refuses to create enhancement spots/definitions
   * directly, so this feature generates a throwaway `IF_OO_ADT_CLASSRUN`
   * class and POSTs it to `/sap/bc/adt/oo/classrun/…`. The only object with
   * a URI on that route is a `$TMP` helper that passes every rule trivially;
   * the real enhancement/spot/target are ABAP-source string arguments no
   * URI-shaped gate can see. So this gates the INTENT, before generation —
   * before-execution would be too late, since by then the identifiers are
   * already concatenated into a blob of ABAP this gate cannot read.
   *
   * Narrows one route, does not close the channel: `abap_run`'s classrun
   * path (`src/adt/run.ts`, `src/adt/bopf-runtime.ts`) still generates and
   * executes arbitrary ABAP via the same ungated `$TMP`-bridge mechanism —
   * pre-existing, out of scope here, tracked separately.
   *
   * Deny by default: with no `ABAP_ALLOW_ENHANCEMENTS`, `ABAP_ENHANCE_TARGETS`,
   * or `ABAP_ENHANCE_TARGET_PACKAGES`, every intent is refused.
   */
  evaluateIntent(intent: EnhancementIntent, opts: EvaluateIntentOptions = {}): SafetyDecision {
    const op = opts.op ?? "write";
    if (!MUTATING_OPS.has(op)) {
      // No read-only classrun: verifying an enhancement executes generated
      // ABAP just like creating it does, so accepting a non-mutating op here
      // would skip every rule below.
      return {
        allowed: false,
        reason:
          `evaluateIntent was called with the non-mutating operation "${op}". Generating and ` +
          "running ABAP is never a read: pass write, activate, delete, execute or transport.",
        rule: "no read-only classrun exemption",
        code: "SAFETY_DENIED",
      };
    }
    // Grammar first, ahead of allowlists: an injection must be reported as
    // that, not as an allowlist miss inviting a wider allowlist.
    const malformed = this.intentGrammar(intent);
    if (malformed) return malformed;
    // Routed through `evaluate()` rather than duplicating its artefact
    // rules — a second copy is a second thing to forget to update. Type is
    // forced into the enhancement family so the intent-routing block can't
    // be side-stepped by passing/omitting some other type code.
    const artefact: SafetyTarget = safetyTarget({
      name: intent.enhancementName,
      packageName: intent.enhancementPackage,
      type: isEnhancementType(intent.enhancementType) ? intent.enhancementType : "ENHO/XHH",
    });
    return this.evaluate(op, artefact, { ...opts, intent });
  }

  /**
   * ABAP name grammar for every identifier in an intent, or `undefined` if
   * they all pass. These strings are substituted verbatim into generated
   * ABAP (`src/adt/enhancement-templates.ts`); a quote or period is an
   * injection, not a bad name — the gate cannot read generated source, so
   * this is the only defence there is. Checked first, ahead of every
   * allowlist. Empty strings are skipped: emptiness means "not resolved",
   * which the rules below refuse with a more useful message.
   */
  private intentGrammar(i: EnhancementIntent): SafetyDecision | undefined {
    const identifiers: ReadonlyArray<readonly [string, string | undefined, AbapIdentifierOptions]> = [
      ["enhancementName", i.enhancementName, { allowNamespace: true }],
      ["enhancementPackage", i.enhancementPackage, { allowNamespace: true, allowLocal: true }],
      ["spotName", i.spotName, { allowNamespace: true }],
      ["targetName", i.targetName, { allowNamespace: true }],
      ["targetPackage", i.targetPackage, { allowNamespace: true, allowLocal: true }],
    ];
    for (const [field, value, rules] of identifiers) {
      if (value === undefined || value === "") continue;
      if (!isValidAbapIdentifier(value, rules)) {
        return {
          allowed: false,
          reason:
            `Enhancement intent field ${field} = ${JSON.stringify(value)} is not a valid ABAP ` +
            `object name (letter, then letters/digits/underscores, at most ${ABAP_IDENTIFIER_MAX} ` +
            "characters). It would be substituted verbatim into generated ABAP source.",
          rule: "ABAP identifier grammar",
          code: "SAFETY_DENIED",
        };
      }
    }
    return undefined;
  }

  /**
   * The enhancement-specific rules, applied to an intent that has already
   * cleared the artefact's own rules in `evaluate()`. Split out so both entry
   * points — a direct `evaluateIntent()` call and an ordinary `evaluate()` on
   * an object whose `type` is an enhancement — reach the identical decision.
   */
  private enhancementRules(i: EnhancementIntent): SafetyDecision {
    // ---- 1. Grammar, first, on every identifier ----
    const malformed = this.intentGrammar(i);
    if (malformed) return malformed;
    // ---- 2. The master switch ----
    if (this.cfg.allowEnhancements !== true) {
      const why = this.why("allowEnhancements");
      return {
        allowed: false,
        reason:
          `Enhancement authoring is disabled. ${why.cause} ${why.remediation} ` +
          // Names the write flag ONLY under legacy config, where it is the thing
          // that actually decides writes and the operator will grep for it.
          // Under ABAP_MODE the flag decides nothing, so naming it here would be
          // the very misattribution `why` exists to prevent (see the
          // single-mention invariant on legacyOverriddenClause).
          (this.cfg.abapMode === undefined
            ? "ABAP_ALLOW_WRITE=true does not imply it"
            : `ABAP_MODE=${this.cfg.abapMode} granting ordinary writes does not imply it`) +
          ", because an enhancement changes the behaviour of an object it does not live in.",
        rule: "enhancements need an explicit flag",
        code: "ENHANCEMENT_DISABLED",
      };
    }
    // ---- 3. The origin ceiling on the ARTEFACT — no flag opens this ----
    // An enhancement whose own master system isn't one of ours is somebody
    // else's original; changing it is a repair, not an enhancement. Uses
    // `isLocalOrigin`'s three-way test, not bare `masterSystem !== "SAP"`
    // (would wrongly admit partner/third-party originals) or bare
    // `ABAP_ORIGIN_SYSTEMS` membership (used to misfire on this system's OWN
    // artefacts at the empty default — see {@link isLocalOrigin}). Absent
    // `enhancementMasterSystem` (brand-new artefact) never reaches this.
    const artefactOrigin = i.enhancementMasterSystem?.trim().toUpperCase();
    if (artefactOrigin && !this.isLocalOrigin(artefactOrigin)) {
      return {
        allowed: false,
        reason:
          `${i.enhancementName} originates in system ${artefactOrigin}, which is neither this ` +
          `server's own system (${this.ownSid ?? "SID not configured — set ABAP_SID"}) nor named in ` +
          `ABAP_ORIGIN_SYSTEMS [${this.originSystems.join(", ") || "(none configured)"}]. Changing it ` +
          "is a repair of somebody else's original, and no allowlist opens that. If this system was " +
          `copied and ${artefactOrigin} is a former SID of it, add ${artefactOrigin} to ABAP_ORIGIN_SYSTEMS.`,
        rule: "origin ceiling (repair refused)",
        code: "REPAIR_REFUSED",
      };
    }
    // ---- 4. Which enhanced objects may be targeted at all ----
    const targets = this.enhanceTargets;
    if (targets === "none") {
      // Reachable in legacy config (the schema default — an operator set
      // ABAP_ALLOW_ENHANCEMENTS=true and is refused by a variable they never
      // touched) AND under ABAP_MODE, where an operator may
      // explicitly narrow ABAP_ENHANCE_TARGETS=none.
      const why = this.why("enhanceTargets");
      return {
        allowed: false,
        reason: `No object may be enhanced at all. ${why.cause} ${why.remediation}`,
        rule: "enhancement target class",
        code: "ENHANCEMENT_DISABLED",
      };
    }
    // ---- 5. The enhanced object has to actually be known ----
    const targetName = i.targetName?.trim() ?? "";
    const targetPackage = i.targetPackage?.trim() ?? "";
    if (!targetName || !targetPackage) {
      return {
        allowed: false,
        reason:
          "The enhanced object could not be resolved (name and package are both required). " +
          "An enhancement whose target is unknown is refused rather than assumed harmless.",
        rule: "enhanced object unresolved",
        code: "ENHANCEMENT_TARGET_DENIED",
      };
    }
    // ---- 6. Ownership of the enhanced object ----
    // Origin gate principle (also step 3 above): "refuse to modify content
    // mastered in some other system" — judged by `isLocalOrigin`'s
    // three-way test. See its doc comment for the FIXED BUG where an empty
    // ABAP_ORIGIN_SYSTEMS used to make this refuse enh_create_spot
    // unconditionally for every object, including never-transported $TMP.
    const targetOrigin = i.targetMasterSystem?.trim().toUpperCase();
    const local = this.isLocalOrigin(targetOrigin);
    // A locally-originated but SAP-NAMED object (registered namespace or
    // SAP-owned package) is treated as SAP content — name is the stricter
    // signal. Also the safety net for an object with ABSENT masterSystem
    // (read as local) whose package name reveals it isn't really ours.
    const sapNamed = isSapNamespace(targetName) || isSapPackage(targetPackage);
    const ownership: "customer" | "sap" | "partner" = local
      ? sapNamed
        ? "sap"
        : "customer"
      : targetOrigin === "SAP"
        ? "sap"
        : "partner";
    if (ownership === "customer") {
      return {
        allowed: true,
        reason: `${targetName} is locally-originated customer content in ${targetPackage}.`,
      };
    }
    const whose =
      ownership === "sap"
        ? "SAP standard content"
        : `content originating in system ${targetOrigin}, i.e. partner or third-party content`;
    if (targets !== "sap") {
      // See ENHANCE_SAP_TARGET_REQUIREMENT: needs specifically "sap", reachable
      // via an explicit ABAP_ENHANCE_TARGETS=sap override from any mode,
      // not just admin's default — so `capabilityGranted` alone can't state
      // it; the predicate is evaluated against a real `capabilitiesForMode()`
      // result.
      const sapTargets = this.why(ENHANCE_SAP_TARGET_REQUIREMENT);
      return {
        allowed: false,
        reason:
          `${targetName} (package ${targetPackage}) is ${whose}, and the enhancement target ` +
          `class is 'customer'. ${sapTargets.cause} Two things are required and doing only one ` +
          `leaves this refused: (1) ${sapTargets.remediation} (2) add ${targetPackage} to ` +
          "ABAP_ENHANCE_TARGET_PACKAGES, which is an override list and is still read under " +
          "ABAP_MODE." +
          // The ABAP_ORIGIN_SYSTEMS remediation only makes sense when `!local`
          // (targetOrigin is a genuine foreign SID); when `local` is true,
          // targetOrigin may be undefined or this system's own SID, and used
          // to render literally as "adding undefined to ABAP_ORIGIN_SYSTEMS".
          (local
            ? " There is no ABAP_ORIGIN_SYSTEMS fix for this one: the object is already " +
              "locally-originated, and is refused for its SAP-pattern naming or package, not " +
              "for where it comes from."
            : ` If this system was copied and ${targetOrigin} is a former SID of it, adding ` +
              `${targetOrigin} to ABAP_ORIGIN_SYSTEMS is the correct fix instead.`),
        rule: "enhanced object outside ABAP_ENHANCE_TARGETS",
        // Allowlist (target class) did not match.
        code: "ENHANCEMENT_TARGET_DENIED",
      };
    }
    // ---- 7. `sap` is an opt-in PER PACKAGE, never a blanket one ----
    const pkgs = this.enhanceTargetPackages;
    if (pkgs.length === 0) {
      return {
        allowed: false,
        reason:
          `${targetName} is ${whose}, and ABAP_ENHANCE_TARGET_PACKAGES is empty — which is a ` +
          `deny-all, not an absence of configuration. Add ${targetPackage} to it. ` +
          "A 'sap' target class alone enhances nothing.",
        rule: "enhanced-package allowlist (fail closed)",
        // ABAP_ENHANCE_TARGET_PACKAGES failed to match.
        code: "ENHANCEMENT_TARGET_DENIED",
      };
    }
    if (!pkgs.some((p) => packagePattern(p).test(targetPackage))) {
      return {
        allowed: false,
        reason:
          `Package ${targetPackage} (holding ${whose} object ${targetName}) is not in ` +
          `ABAP_ENHANCE_TARGET_PACKAGES [${pkgs.join(", ")}].`,
        rule: "enhanced-package allowlist",
        code: "ENHANCEMENT_TARGET_DENIED",
      };
    }
    return {
      allowed: true,
      reason:
        ownership === "sap"
          ? `${targetName} is SAP standard content in allowlisted package ${targetPackage}.`
          : `${targetName} originates in system ${targetOrigin} (partner content) and its package ` +
            `${targetPackage} is allowlisted.`,
    };
  }

  /**
   * Throwing form of {@link evaluateIntent}, for the bridge call sites that
   * cannot continue. `details` carries BOTH objects — the artefact and what it
   * affects — because a refusal naming only the artefact sends the reader
   * looking at the wrong one.
   */
  assertIntent(intent: EnhancementIntent, opts: EvaluateIntentOptions = {}): void {
    const d = this.evaluateIntent(intent, opts);
    if (d.allowed) return;
    throw new AbapError(
      d.code ?? "SAFETY_DENIED",
      d.reason,
      {
        operation: opts.op ?? "write",
        rule: d.rule,
        artefact: {
          name: intent.enhancementName,
          type: intent.enhancementType ?? "ENHO/XHH",
          package: intent.enhancementPackage,
          masterSystem: intent.enhancementMasterSystem,
        },
        affects: {
          name: intent.targetName,
          package: intent.targetPackage,
          masterSystem: intent.targetMasterSystem,
          resolvedFrom: intent.spotName ? "spot" : "enhancedObject",
        },
        phase: opts.phase ?? "final",
      },
      (this.cfg.abapMode !== undefined
        ? `Enhancement authoring and its target class both come from ABAP_MODE (=${this.cfg.abapMode} ` +
          "here); for SAP or partner content a matching ABAP_ENHANCE_TARGET_PACKAGES entry is " +
          "needed on top, and that one IS still read."
        : "Enhancement authoring needs ABAP_ALLOW_ENHANCEMENTS=true, ABAP_ENHANCE_TARGETS=customer|sap, " +
          "and — for SAP or partner content — a matching ABAP_ENHANCE_TARGET_PACKAGES entry. Each is " +
          "required; none implies another."),
    );
  }

  /** Throwing form for call sites that cannot continue. */
  assert(
    op: Operation,
    obj?: SafetyTarget,
    opts: EvaluateOptions = {},
  ): void {
    const d = this.evaluate(op, obj, opts);
    if (d.allowed) return;
    throw new AbapError(
      d.code ?? (op === "read" ? "SAFETY_DENIED" : "READ_ONLY"),
      d.reason,
      {
        operation: op,
        rule: d.rule,
        object: obj?.name,
        // Type and package travel with the refusal because a reader asking
        // "why was this refused" needs the blast radius, not just the name.
        type: obj?.type,
        package: obj?.packageName,
        phase: opts.phase ?? "final",
      },
      d.hint ??
        (this.cfg.abapMode !== undefined
          ? `Writes come from ABAP_MODE (=${this.cfg.abapMode} here) plus a package allowlist ` +
            "(ABAP_ALLOW_PACKAGES, still read under ABAP_MODE) and a customer-namespace object " +
            "name."
          : "Writes require ABAP_ALLOW_WRITE=true plus a package allowlist (ABAP_ALLOW_PACKAGES, " +
            "which allows every customer package unless set, and refuses every write if set " +
            "empty) and a customer-namespace object name."),
    );
  }

  /**
   * Throwing gate check that also mints the {@link AuthorizedTarget} proof.
   * This is what call sites use INSTEAD OF calling `assert` and then making
   * the wire call with a bare URI/target and a `gate?: SafetyGate` parameter:
   * they call `authorize` first and thread the returned value through to the
   * function that actually calls `conn.post`/`put`/`del`.
   */
  authorize<Op extends MutatingOperation, P extends SafetyTarget>(
    op: Op,
    target: P,
    opts: EvaluateOptions = {},
  ): AuthorizedTarget<Op, P> {
    this.assert(op, target, opts);
    return new AuthorizedTarget(MINT, op, target);
  }

  /** {@link authorize}, for the intent-based (enhancement) route. */
  authorizeIntent<Op extends MutatingOperation, P extends SafetyTarget>(
    op: Op,
    intent: EnhancementIntent,
    target: P,
    opts: EvaluateIntentOptions = {},
  ): AuthorizedTarget<Op, P> {
    this.assertIntent(intent, { ...opts, op });
    return new AuthorizedTarget(MINT, op, target);
  }
}
