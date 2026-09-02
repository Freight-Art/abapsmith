/**
 * Enhancement/BAdI CREATE templates.
 *
 * ADT REST `POST` has no working route for enhancement spots (`ENHS/XS`),
 * BAdI definitions, or implementations (`ENHO/XH`) — only source-code
 * plug-ins (`ENHO/XHH`). The only route that works is server-side ABAP
 * driving `CL_ENH_FACTORY`/`CL_ENH_TOOL_BADI_DEF`/`CL_ENH_TOOL_BADI_IMPL`
 * over the same `IF_OO_ADT_CLASSRUN` bridge pattern as `./run.ts` and
 * `./bopf-runtime.ts`. Live evidence: the git history.
 *
 * This module is a CLOSED set of six named templates — {@link createSpotFragment},
 * {@link addBadiDefFragment}, {@link addFilterDefFragment}, {@link createImplFragment},
 * {@link setFilterValuesFragment}, {@link exerciseFragment} — each taking a
 * TYPED parameter object, never a free-form ABAP string or a name-keyed
 * lookup. `./enhancement-bridge.ts` calls these six directly by TS
 * identifier — every substituted identifier is validated first
 * ({@link assertEnhIdentifier}, wrapping `../safety.ts`'s
 * `isValidAbapIdentifier`); free text goes through {@link assertAbapText}
 * then {@link abapLiteral}.
 *
 * Hazard invariants baked into the generated code (archive has the incidents
 * behind each):
 *  - {@link addBadiDefFragment} hardcodes `context_mode = 'N'` — omitting it
 *    500s on activation ("Definition of the referenced BAdI is inconsistent").
 *  - {@link markerInterfaceSource} hardcodes `INTERFACES if_badi_interface.`
 *    first — without it, activation returns HTTP 200 with a failing
 *    checklist, which `./enhancement-bridge.ts` treats as an error via
 *    `assertNoErrors`.
 *  - {@link setFilterValuesFragment} only ever writes `filter_values` +
 *    `filter_root`, never the derived `filters` field (writing it directly
 *    round-trips to nothing on reload).
 *  - Spot + implementation must be reactivated together in one
 *    `POST /sap/bc/adt/activation` call — enforced in
 *    `./enhancement-bridge.ts`'s `activateSpotAndImplementation`.
 */
import { AbapError } from "./errors.js";
import { isValidAbapIdentifier, type AbapIdentifierOptions } from "../safety.js";

// ---------------------------------------------------------------------------
// Identifier / text validation
// ---------------------------------------------------------------------------

/**
 * Validates `value` as a bare ABAP identifier (`../safety.ts`
 * `isValidAbapIdentifier`) or throws `BAD_INPUT`. The only function here
 * that clears a string for unquoted embedding.
 */
export function assertEnhIdentifier(
  value: string,
  what: string,
  opts: AbapIdentifierOptions = {},
): string {
  if (typeof value !== "string" || !isValidAbapIdentifier(value, opts)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} ${JSON.stringify(value)} is not a valid ABAP object name (a letter, then letters, ` +
        `digits and underscores only, max ${opts.maxLength ?? 30} characters` +
        `${opts.allowNamespace ? "; a leading /NAMESPACE/ is allowed" : ""}` +
        `${opts.allowLocal ? "; a leading $ is allowed" : ""}).`,
      { what, value },
      "This value is substituted verbatim into generated ABAP source that is then activated and " +
        "executed — a period, a quote, or a newline is refused outright, not escaped or stripped.",
    );
  }
  return value;
}

/**
 * Validates `value` as an ABAP type REFERENCE (the RHS of `TYPE`), not an
 * object name: a bare or `/NAMESPACE/`-qualified type name, optionally
 * followed by exactly one `-COMPONENT` suffix (`MARA-MATNR`,
 * `/DMO/S_FLIGHT-CARRID`) — namespaced types are ordinary for SAP-delivered
 * interfaces. Still refuses everything {@link assertEnhIdentifier} refuses:
 * the value lands verbatim in generated ABAP source that is activated and
 * executed, so this is a differently-SHAPED grammar, not a looser one.
 */
export function assertEnhTypeRef(value: string, what: string): string {
  const parts = typeof value === "string" ? value.split("-") : [];
  const [head, component, ...extra] = parts;
  const valid =
    typeof value === "string" &&
    extra.length === 0 &&
    isValidAbapIdentifier(head ?? "", { allowNamespace: true, maxLength: 30 }) &&
    (component === undefined || isValidAbapIdentifier(component, { maxLength: 30 }));
  if (!valid) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} ${JSON.stringify(value)} is not a valid ABAP type reference (a plain or ` +
        "/NAMESPACE/-qualified type name, max 30 characters per part, optionally followed by exactly " +
        'one -COMPONENT suffix, e.g. "STRING", "/DMO/S_FLIGHT-CARRID").',
      { what, value },
      "This value is substituted verbatim into generated ABAP source that is then activated and " +
        "executed — a period, a quote, or a newline is refused outright, not escaped or stripped.",
    );
  }
  return value;
}

const CONTROL_CHAR_CODES: readonly number[] = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127];
const CONTROL_CHAR_RE = new RegExp(
  "[" + CONTROL_CHAR_CODES.map((c) => String.fromCharCode(c)).join("") + "]",
);

/**
 * Validates free text for an ABAP literal: rejects non-strings, anything
 * over `maxLen`, and control characters (a raw newline would corrupt the
 * generated source's line structure). Does not escape quotes — see
 * {@link abapLiteral}.
 */
export function assertAbapText(value: string, what: string, maxLen = 60): string {
  if (typeof value !== "string") {
    throw new AbapError("BAD_INPUT", `${what} must be a string.`, { what });
  }
  if (value.length > maxLen) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} is ${value.length} characters, longer than the ${maxLen}-character limit.`,
      { what, length: value.length, maxLen },
    );
  }
  if (CONTROL_CHAR_RE.test(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} contains a control character (newline, carriage return, or similar) — refused, not stripped.`,
      { what },
    );
  }
  return value;
}

/** Wraps a validated value in single quotes for embedding as an ABAP string literal, doubling embedded quotes (the standard ABAP `''` escape) — mirrors `bopf-runtime.ts`'s `fieldValue.replace(/'/g, "''")` convention. */
export function abapLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** `abap_true`/`abap_false` for a validated boolean — never a string the caller controls. */
function abapBool(value: boolean): string {
  return value ? "abap_true" : "abap_false";
}

// Only operators with live evidence; SAP's BADI_FILTER_COMPARE domain likely
// has more (BT, CP, NP…) — unlisted ones are refused, not guessed.
const FILTER_COMPARE_OPERATORS = new Set(["=", "<>", "<", "<=", ">", ">="]);

// abap_run's ranges.option (../tools/run.ts) uses SELECT-OPTIONS two-letter
// codes (EQ/NE/LT/LE/GT/GE) for the same six relations; this maps both
// spellings to the symbolic form the generated ABAP needs. CP/NP/BT/NB are
// deliberately excluded (no live evidence).
const FILTER_COMPARE_ALIASES: Readonly<Record<string, string>> = {
  EQ: "=",
  NE: "<>",
  LT: "<",
  LE: "<=",
  GT: ">",
  GE: ">=",
};

function assertFilterCompare(value: string): string {
  const alias = typeof value === "string" ? FILTER_COMPARE_ALIASES[value] : undefined;
  const normalized = alias ?? value;
  if (!FILTER_COMPARE_OPERATORS.has(normalized)) {
    throw new AbapError(
      "BAD_INPUT",
      `compare ${JSON.stringify(value)} is not one of the operators this codebase has live evidence ` +
        `for: ${[...FILTER_COMPARE_OPERATORS].join(", ")} (or their abap_run-style two-letter spellings ` +
        `${Object.keys(FILTER_COMPARE_ALIASES).join(", ")}).`,
      { value, allowed: [...FILTER_COMPARE_OPERATORS, ...Object.keys(FILTER_COMPARE_ALIASES)] },
      "Only '=' has been captured live. Other BADI_FILTER_COMPARE domain " +
        "values (e.g. CP, NP, BT, NB) may exist on the server but are not verified here — this " +
        "template refuses rather than guess their exact codes.",
    );
  }
  return normalized;
}

// Grammar check only (a bare uppercase letter can't inject anything) — only
// 'C' is evidenced live.
function assertFilterTypeCode(value: string, what: string): string {
  if (typeof value !== "string" || !/^[A-Z]$/.test(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} ${JSON.stringify(value)} must be a single uppercase letter (e.g. "C" — the only value ` +
        "captured live).",
      { what, value },
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Template 1/6 — create-spot
// ---------------------------------------------------------------------------

export interface CreateSpotParams {
  /** New enhancement spot's technical name. CHAR30 (`ENHNAME`). */
  spotName: string;
  /**
   * Root `adtcore:description` — REQUIRED. SAP's enhancement PUT rejects any
   * write against an object with an empty root description, so a spot
   * created without one would be unwritable from the moment it exists (see
   * {@link CreateImplParams.description} for the ENHO/XH twin of this rule).
   */
  description: string;
}

/**
 * `CL_ENH_FACTORY=>CREATE_ENHANCEMENT_SPOT(...)` — verified live
 * (`"SPOT-OBJECT-CREATED"`). `dark = abap_true` matches `run.ts`/
 * `bopf-runtime.ts`'s own bridges. Produces `lo_spot`/`lo_def`; save/
 * activate/unlock happen in `./enhancement-bridge.ts`'s shared epilogue.
 *
 * CAUTION: the `set_shorttext` call below is weaker evidence than
 * {@link createImplFragment}'s equivalent — no fixture has captured a live
 * spot-creation run exercising it. See archive. Needs a live run to confirm.
 */
export function createSpotFragment(p: CreateSpotParams): string[] {
  const spotName = assertEnhIdentifier(p.spotName, "spotName");
  const description = assertAbapText(p.description, "description", 60);
  return [
    "cl_enh_factory=>create_enhancement_spot(",
    `  EXPORTING spot_name = ${abapLiteral(spotName)}`,
    "            tooltype  = cl_enh_tool_badi_def=>tooltype",
    "            dark      = abap_true",
    "  IMPORTING spot      = lo_spot",
    "  CHANGING  trkorr    = lv_trkorr",
    "            devclass  = lv_pkg ).",
    "out->write( 'SPOT-OBJECT-CREATED' ).",
    "lo_def ?= lo_spot.",
    `lo_spot->if_enh_object_docu~set_shorttext( ${abapLiteral(description)} ).`,
  ];
}

// ---------------------------------------------------------------------------
// Template 2/6 — add-badi-def
// ---------------------------------------------------------------------------

export interface AddBadiDefParams {
  /** BAdI definition name. CHAR30. */
  badiName: string;
  /** Marker interface name — MUST already exist with `INTERFACES if_badi_interface.`. */
  interfaceName: string;
  /** `single_use`/multi-use. Fixture 342 used `single_use = abap_true`. */
  singleUse: boolean;
  /** Short description. */
  shortText: string;
}

/**
 * `LO_DEF->ADD_BADI_DEF(...)` — verified live (`"BADI-DEF-ADDED"`).
 * `context_mode = 'N'` is hardcoded — required to avoid a 500 on activation,
 * see module header. Assumes `lo_spot`/`lo_def` already hold a locked spot;
 * `./enhancement-bridge.ts` owns that choreography.
 */
export function addBadiDefFragment(p: AddBadiDefParams): string[] {
  const badiName = assertEnhIdentifier(p.badiName, "badiName");
  const interfaceName = assertEnhIdentifier(p.interfaceName, "interfaceName");
  const shortText = assertAbapText(p.shortText, "shortText", 60);
  return [
    "CLEAR ls_badi.",
    `ls_badi-badi_name      = ${abapLiteral(badiName)}.`,
    `ls_badi-interface_name = ${abapLiteral(interfaceName)}.`,
    `ls_badi-single_use     = ${abapBool(p.singleUse)}.`,
    `ls_badi-badi_shorttext = ${abapLiteral(shortText)}.`,
    // Hardcoded — omitting this 500s on activation, confirmed live (see module header).
    "ls_badi-context_mode = 'N'.",
    "lo_def->add_badi_def( im_badi_def = ls_badi ).",
    "out->write( 'BADI-DEF-ADDED' ).",
  ];
}

// ---------------------------------------------------------------------------
// Template 3/6 — add-filter-def
// ---------------------------------------------------------------------------

export interface AddFilterDefParams {
  /** Which BAdI definition (on the already-locked spot) this filter is declared on. */
  badiName: string;
  /** Filter attribute name — `ENH_BADI_FILTER-FILTER_NAME` (`ENHBADIFILTERNAME`). */
  filterName: string;
  /**
   * Filter value's ABAP type category, e.g. `"C"` — `ENH_BADI_FILTER-FILTER_TYPE`
   * (`BADI_FILTER_TYPE`). Only a bare uppercase letter is accepted (see
   * `assertFilterTypeCode`'s doc comment — the full domain is unverified).
   */
  filterType: string;
  /** Optional short description — `ENH_BADI_FILTER-FILTERTEXT` (`ENHSHORTTEXT255`). */
  filterText?: string;
}

/**
 * Declares that a BAdI definition SUPPORTS filtering on a named attribute —
 * prerequisite to {@link setFilterValuesFragment} (which sets what an
 * IMPLEMENTATION filters *to*). Field names verified against a live DDIC
 * catalog query on `ENH_BADI_FILTER`.
 *
 * CAUTION: unlike the other five templates, no live end-to-end
 * create-then-activate round trip exercises this table — the field names are
 * confirmed, the append pattern is inferred by analogy. See archive.
 */
export function addFilterDefFragment(p: AddFilterDefParams): string[] {
  const badiName = assertEnhIdentifier(p.badiName, "badiName");
  const filterName = assertEnhIdentifier(p.filterName, "filterName", { maxLength: 30 });
  const filterType = assertFilterTypeCode(p.filterType, "filterType");
  const filterText = p.filterText === undefined ? "" : assertAbapText(p.filterText, "filterText", 255);
  return [
    `ls_badi = lo_def->get_badi_def( badi_name = ${abapLiteral(badiName)} ).`,
    `lo_def->delete_badi_def( badi_name = ${abapLiteral(badiName)} ).`,
    "CLEAR ls_filter.",
    `ls_filter-filter_name = ${abapLiteral(filterName)}.`,
    `ls_filter-filter_type = ${abapLiteral(filterType)}.`,
    `ls_filter-filtertext  = ${abapLiteral(filterText)}.`,
    "APPEND ls_filter TO ls_badi-filters.",
    "lo_def->add_badi_def( im_badi_def = ls_badi ).",
    "out->write( 'FILTER-DEF-ADDED' ).",
  ];
}

// ---------------------------------------------------------------------------
// Template 4/6 — create-impl
// ---------------------------------------------------------------------------

export interface CreateImplParams {
  /** New `ENHO/XH` object's technical name (the enhancement, `enh_object`). CHAR30. */
  enhName: string;
  /** Which spot this implementation binds to. */
  spotName: string;
  /** Which BAdI definition on that spot. */
  badiName: string;
  /** This implementation's own name. */
  implName: string;
  /**
   * ABAP class implementing the BAdI's marker interface's contract. Must
   * already exist — this operation records the reference, it does not
   * generate the class shell the way SE19 does.
   */
  implClass: string;
  /** Active on creation? Fixture 353 used `abap_true`. */
  active: boolean;
  /**
   * Root `adtcore:description` — REQUIRED. SAP's `enhoxh` PUT rejects any
   * write against an object with an empty root description (HTTP 400
   * `ExceptionInvalidData`, "The description is missing" —
   * `enhancement-write.ts`'s `assertDescriptionWillBePresent`), so an object
   * created without one would be unwritable — including un-deactivatable —
   * from the moment it exists.
   */
  description: string;
}

/**
 * `CL_ENH_FACTORY=>CREATE_ENHANCEMENT(...)` then `ADD_IMPLEMENTATION(...)` —
 * verified live (`"ENHO-OBJECT-CREATED"` / `"IMPL-ADDED"`). `impl_class`
 * must already exist and implement the marker interface's contract — out of
 * scope here (create it with `abap_write` like any other class).
 *
 * CAUTION: `set_shorttext` placement follows abapGit's
 * `zcl_abapgit_object_enho_badi` precedent but is not independently
 * live-verified by this codebase. See archive. Needs a live run to confirm.
 */
export function createImplFragment(p: CreateImplParams): string[] {
  const enhName = assertEnhIdentifier(p.enhName, "enhName");
  const spotName = assertEnhIdentifier(p.spotName, "spotName");
  const badiName = assertEnhIdentifier(p.badiName, "badiName");
  const implName = assertEnhIdentifier(p.implName, "implName");
  const implClass = assertEnhIdentifier(p.implClass, "implClass");
  const description = assertAbapText(p.description, "description", 60);
  return [
    "cl_enh_factory=>create_enhancement(",
    `  EXPORTING enhname     = ${abapLiteral(enhName)}`,
    "            enhtype     = 'IMPL'",
    "            enhtooltype = cl_enh_tool_badi_impl=>tooltype",
    "            dark        = abap_true",
    "  IMPORTING enhancement = lo_enh",
    "  CHANGING  trkorr      = lv_trkorr",
    "            devclass    = lv_pkg ).",
    "out->write( 'ENHO-OBJECT-CREATED' ).",
    "lo_impl ?= lo_enh.",
    `lo_impl->set_spot_name( ${abapLiteral(spotName)} ).`,
    // abapGit-precedent placement, not independently live-verified — see doc comment above.
    `lo_impl->if_enh_object_docu~set_shorttext( ${abapLiteral(description)} ).`,
    "CLEAR ls_impl.",
    `ls_impl-spot_name  = ${abapLiteral(spotName)}.`,
    `ls_impl-badi_name  = ${abapLiteral(badiName)}.`,
    `ls_impl-impl_name  = ${abapLiteral(implName)}.`,
    `ls_impl-impl_class = ${abapLiteral(implClass)}.`,
    `ls_impl-active     = ${abapBool(p.active)}.`,
    "lo_impl->add_implementation( im_implementation = ls_impl ).",
    "out->write( 'IMPL-ADDED' ).",
  ];
}

// ---------------------------------------------------------------------------
// Template 5/6 — set-filter-values
// ---------------------------------------------------------------------------

export interface SetFilterValuesParams {
  /** Which implementation this filter value applies to. */
  implName: string;
  /** Which filter attribute (declared via add-filter-def) this value narrows. */
  filterName: string;
  /** Type category — same domain as {@link AddFilterDefParams.filterType}. */
  filterType: string;
  /** Comparison operator — see `FILTER_COMPARE_OPERATORS`. */
  compare: string;
  /** The literal value, as text. Embedded via `filter_char_value1` (fixture 469's field). */
  value: string;
}

/**
 * Writes ONLY `filter_values` + `filter_root` — never the derived `filters`
 * field (writing it directly round-trips to nothing; `filters` is
 * recomputed server-side by `CALCULATE_FILTER_CONDITION`). Verified live
 * (`"VALUE id=1 name=[FLT] c1=[ALPHA]"`).
 *
 * The `delete_implementation` call before `add_implementation` is REQUIRED:
 * `IF_ENH_TOOL_BADI_IMPL` has no in-place "modify filter values" op.
 * Skipping it fails live with "Error while creating the enhancement
 * implementation" — see archive.
 */
export function setFilterValuesFragment(p: SetFilterValuesParams): string[] {
  const implName = assertEnhIdentifier(p.implName, "implName");
  const filterName = assertEnhIdentifier(p.filterName, "filterName", { maxLength: 30 });
  const filterType = assertFilterTypeCode(p.filterType, "filterType");
  const compare = assertFilterCompare(p.compare);
  const value = assertAbapText(p.value, "value", 255);
  return [
    `ls_impl = lo_impl->get_implementation( impl_name = ${abapLiteral(implName)} ).`,
    // Required — no in-place "modify" op; skipping this fails live. See doc comment above.
    `lo_impl->delete_implementation( impl_name = ${abapLiteral(implName)} ).`,
    // filters (derived field) is never assigned anywhere in this file.
    "CLEAR: ls_impl-filters, ls_impl-filter_values, ls_impl-filter_root, ls_impl-filter_tree.",
    "CLEAR ls_val.",
    "ls_val-id                 = 1.",
    `ls_val-filter_name        = ${abapLiteral(filterName)}.`,
    `ls_val-filter_type        = ${abapLiteral(filterType)}.`,
    `ls_val-compare            = ${abapLiteral(compare)}.`,
    `ls_val-filter_char_value1 = ${abapLiteral(value)}.`,
    "APPEND ls_val TO ls_impl-filter_values.",
    "CLEAR ls_id.",
    "ls_id-id = 1.",
    "CLEAR ls_root.",
    "ls_root-root = 1.",
    "APPEND ls_id TO ls_root-filters.",
    "APPEND ls_root TO ls_impl-filter_root.",
    "lo_impl->add_implementation( im_implementation = ls_impl ).",
    "out->write( 'IMPL-REPLACED' ).",
  ];
}

// ---------------------------------------------------------------------------
// Template 6/6 — exercise
// ---------------------------------------------------------------------------

/**
 * Which formal-parameter direction a {@link ExerciseParam} targets, and
 * which `CALL BADI` clause it lands in:
 *  - `"importing"` (default): callee reads it; call-site `EXPORTING`.
 *    Passed as a bare literal.
 *  - `"changing"`: callee reads and writes; call-site `CHANGING`.
 *  - `"exporting"`: callee writes it (nothing to seed); call-site
 *    `IMPORTING` (direction names are from the callee's POV) — confirmed
 *    legal `CALL BADI` syntax; OBSERVED live for EXPORTING+CHANGING
 *    together, INFERRED for IMPORTING alone.
 *  - `"receiving"`: targets a method's single `RETURNING` parameter via
 *    `RECEIVING`. At most one param may use this. UNVERIFIED live.
 *
 * Every kind but `"importing"` needs a real local variable, not a literal —
 * ABAP refuses a literal for any formal parameter the callee can write to
 * (see {@link exerciseFragment} for the declare/seed/pass/read-back
 * mechanism). `CALL BADI` only accepts the classic keyword form, never
 * `ref->method(...)`.
 */
export type ExerciseParamKind = "importing" | "changing" | "exporting" | "receiving";

export interface ExerciseParam {
  /** Named scalar argument to the exercised method — identifier-validated, never free ABAP. */
  name: string;
  /** Direction — see {@link ExerciseParamKind}. Defaults to `"importing"`. */
  kind?: ExerciseParamKind;
  /**
   * Seed value, embedded as an ABAP literal. REQUIRED for
   * `"importing"`/`"changing"`, FORBIDDEN for `"exporting"`/`"receiving"`
   * (the callee determines those; a caller value would be silently
   * discarded, so this refuses it instead).
   */
  value?: string;
  /**
   * ABAP type of the formal parameter, e.g. `"STRING"`. REQUIRED for every
   * kind other than `"importing"` (a local `DATA lv_<name> TYPE <type>.` is
   * declared for those — this tool cannot infer the type from a BAdI
   * interface signature, so it requires the caller to state it explicitly
   * rather than guess). FORBIDDEN for `"importing"`.
   */
  type?: string;
}

export interface ExerciseParams {
  /** BAdI DEFINITION's name — the generated handle type is named after the definition, not the spot or marker interface. */
  badiName: string;
  /** Method to invoke on the handle — validated the same as any other identifier. */
  methodName: string;
  /** Filter field to test, required together with `filterValue` (both or neither). */
  filterName?: string;
  /** Optional `FILTERS` clause value, single-quote-escaped. Required together with `filterName`. */
  filterValue?: string;
  /** Named scalar parameters passed to the method — a closed shape, not free-form ABAP. */
  params: readonly ExerciseParam[];
}

/**
 * `GET BADI ... [FILTERS ...]. CALL BADI ...->method [EXPORTING ...]
 * [CHANGING ...] [RECEIVING ...].` — the runtime-verification/witness path.
 * Verified live: a filtered-out call correctly raises rather than silently
 * matching, once filter-value and filter-scope reactivation are honoured.
 *
 * This is a CLASSRUN INVOCATION like the other five templates —
 * `./enhancement-bridge.ts` gates it through `SafetyGate.assertIntent(...,
 * { op: "execute" })`, never treated as "just reading".
 */
export function exerciseFragment(p: ExerciseParams): string[] {
  const badiName = assertEnhIdentifier(p.badiName, "badiName");
  const methodName = assertEnhIdentifier(p.methodName, "methodName", { maxLength: 30 });

  const params = p.params.map((param, i) => {
    const label = `params[${i}]`;
    const rawKind = param.kind ?? "importing";
    if (
      rawKind !== "importing" &&
      rawKind !== "changing" &&
      rawKind !== "exporting" &&
      rawKind !== "receiving"
    ) {
      throw new AbapError(
        "BAD_INPUT",
        `${label}.kind ${JSON.stringify(param.kind)} must be one of "importing", "changing", ` +
          '"exporting", "receiving" (or omitted, which defaults to "importing").',
        { what: `${label}.kind`, value: param.kind },
      );
    }
    const kind: ExerciseParamKind = rawKind;
    const name = assertEnhIdentifier(param.name, `${label}.name`, { maxLength: 30 });

    // Only "importing" is a bare literal; other kinds need a local variable (see ExerciseParamKind doc).
    const needsLocal = kind !== "importing";
    const needsValue = kind === "importing" || kind === "changing";

    if (needsValue) {
      if (typeof param.value !== "string") {
        throw new AbapError(
          "BAD_INPUT",
          `${label} (kind "${kind}") requires a string "value" to seed it with — "${kind}" parameters ` +
            "are readable by the caller-supplied literal before the call.",
          { what: `${label}.value`, kind },
        );
      }
    } else if (param.value !== undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `${label} (kind "${kind}") must not supply "value" — the callee fully determines this ` +
          "parameter's value; a caller-supplied seed would be silently discarded, so this refuses it " +
          "instead of accepting input that has no effect.",
        { what: `${label}.value`, kind },
      );
    }

    if (needsLocal) {
      if (typeof param.type !== "string" || param.type.length === 0) {
        throw new AbapError(
          "BAD_INPUT",
          `${label} (kind "${kind}") requires an explicit "type" naming the ABAP type of the formal ` +
            "parameter (e.g. \"STRING\", \"ZDE_MY_TYPE\") — this tool cannot look up a BAdI interface " +
            "method's signature, so it cannot infer the type on its own, and a wrong guess would fail " +
            "to compile rather than fail loudly. State the type explicitly.",
          { what: `${label}.type`, kind },
        );
      }
    } else if (param.type !== undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `${label} (kind "importing") must not supply "type" — importing parameters are passed as a ` +
          "literal directly; no local variable is declared for them, so there is nothing to type.",
        { what: `${label}.type`, kind },
      );
    }

    return {
      name,
      kind,
      value: needsValue ? assertAbapText(param.value as string, `${label}.value`, 255) : undefined,
      type: needsLocal ? assertEnhTypeRef(param.type as string, `${label}.type`) : undefined,
    };
  });

  // ABAP is case-insensitive: fold to uppercase before dedup, or two
  // spellings of the same param collide on the same generated lv_ local.
  const seenNames = new Set<string>();
  for (const param of params) {
    const key = param.name.toUpperCase();
    if (seenNames.has(key)) {
      throw new AbapError(
        "BAD_INPUT",
        `params[].name ${JSON.stringify(param.name)} is supplied more than once (ABAP identifiers are ` +
          "case-insensitive) — each formal parameter can be assigned at most once in a single CALL BADI.",
        { what: "params[].name", value: param.name },
      );
    }
    seenNames.add(key);
  }

  const receivingParams = params.filter((param) => param.kind === "receiving");
  if (receivingParams.length > 1) {
    throw new AbapError(
      "BAD_INPUT",
      `at most one params[] entry may use kind "receiving" — a method has at most one RETURNING ` +
        `parameter, so CALL BADI's RECEIVING clause can only ever target one. Got ${receivingParams.length}: ` +
        `${receivingParams.map((param) => param.name).join(", ")}.`,
      { what: "params[].kind", count: receivingParams.length },
    );
  }

  const lines: string[] = [`DATA lo_badi TYPE REF TO ${badiName}.`];
  const hasFilterName = p.filterName !== undefined;
  const hasFilterValue = p.filterValue !== undefined;
  if (hasFilterName !== hasFilterValue) {
    throw new AbapError(
      "BAD_INPUT",
      "exercise: filterName and filterValue must be given together (both or neither) — " +
        "a filter value with no filter field name has nothing to substitute into `GET BADI ... FILTERS`.",
      { filterName: p.filterName, filterValue: p.filterValue },
    );
  }
  if (hasFilterName && hasFilterValue) {
    const filterName = assertEnhIdentifier(p.filterName as string, "filterName", { maxLength: 30 });
    const filterValue = assertAbapText(p.filterValue as string, "filterValue", 255);
    lines.push(`GET BADI lo_badi FILTERS ${filterName} = ${abapLiteral(filterValue)}.`);
  } else {
    lines.push("GET BADI lo_badi.");
  }

  // Declare locals before the call (ABAP requires DATA before use), seed
  // "changing" via assignment (MOVE semantics, not DATA...VALUE — literal-
  // compatibility for non-character types is unverified). exporting/
  // receiving locals stay at their initial value.
  const localVar = (name: string): string => `lv_${name.toLowerCase()}`;
  for (const param of params) {
    if (!param.type) continue;
    lines.push(`DATA ${localVar(param.name)} TYPE ${param.type}.`);
  }
  for (const param of params) {
    if (param.kind !== "changing") continue;
    lines.push(`${localVar(param.name)} = ${abapLiteral(param.value as string)}.`);
  }

  // CALL BADI only accepts the classic keyword form; clause order
  // (EXPORTING, IMPORTING, CHANGING, RECEIVING) matches ABAP keyword docs.
  const asLiteralArg = (param: { name: string; value?: string }): string =>
    `${param.name} = ${abapLiteral(param.value as string)}`;
  const asVarArg = (param: { name: string }): string => `${param.name} = ${localVar(param.name)}`;
  const importingArgs = params.filter((param) => param.kind === "importing").map(asLiteralArg);
  const exportingArgs = params.filter((param) => param.kind === "exporting").map(asVarArg);
  const changingArgs = params.filter((param) => param.kind === "changing").map(asVarArg);
  const firstReceivingParam = receivingParams[0];
  const receivingArg = firstReceivingParam ? asVarArg(firstReceivingParam) : undefined;
  const callParts: string[] = [];
  if (importingArgs.length > 0) callParts.push(`EXPORTING ${importingArgs.join(" ")}`);
  if (exportingArgs.length > 0) callParts.push(`IMPORTING ${exportingArgs.join(" ")}`);
  if (changingArgs.length > 0) callParts.push(`CHANGING ${changingArgs.join(" ")}`);
  if (receivingArg) callParts.push(`RECEIVING ${receivingArg}`);
  const call =
    callParts.length > 0
      ? `CALL BADI lo_badi->${methodName} ${callParts.join(" ")}.`
      : `CALL BADI lo_badi->${methodName}.`;

  // CALL BADI on an unbound multi-use handle is a silent no-op (SAP keyword
  // docs; also SAP Note 944559 stale-buffer scenario) — without this check,
  // `exercise` printed EXERCISED after a call that did nothing, confirmed
  // live via debugger (`GET BADI` left `objectref -> 0x0` despite the impl
  // being workbench-active). See archive.
  //
  // After a successful call, read non-importing locals back via a string
  // template — the clearest evidence a real implementation ran. Line shape
  // `RESULT>NAME=value` passes through parseEnhancementTranscript's
  // unrecognized-line fallback harmlessly.
  const bodyLines = [`  ${call}`, "  out->write( 'EXERCISED' )."];
  for (const param of params) {
    if (!param.type) continue;
    bodyLines.push(`  out->write( |RESULT>${param.name}={ ${localVar(param.name)} }| ).`);
  }
  lines.push("IF lo_badi IS BOUND.", ...bodyLines, "ELSE.", "  out->write( 'NOT-BOUND' ).", "ENDIF.");
  return lines;
}

// ---------------------------------------------------------------------------
// Marker interface — not one of the six, but this module's home for that
// invariant
// ---------------------------------------------------------------------------

/**
 * Minimal `INTF/OI` source, generated only when no existing object has this
 * name (never overwrites a caller's own interface). `INTERFACES
 * if_badi_interface.` is hardcoded first — required for activation, see
 * module header.
 */
export function markerInterfaceSource(interfaceName: string): string {
  const name = assertEnhIdentifier(interfaceName, "interfaceName");
  return [
    `INTERFACE ${name} PUBLIC.`,
    "  INTERFACES if_badi_interface.",
    "ENDINTERFACE.",
  ].join("\n");
}
