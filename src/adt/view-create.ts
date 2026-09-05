/**
 * # Classic DDIC view (`VIEW/DV`) creation, through the classrun bridge
 *
 * `./ddic-bridge.ts`'s module header is the contract this file implements;
 * read it first. ADT REST is GET-only for `VIEW/DV`, but SE11's own view
 * editor writes one through ordinary function modules (`DDIF_VIEW_PUT` +
 * `DDIF_VIEW_ACTIVATE`, function group `SDIC`), callable from a generated
 * `IF_OO_ADT_CLASSRUN` class. This module builds that class's body and hands
 * it to {@link runDdicBridge}.
 *
 * Only `DDIF_VIEW_PUT`'s parameter names and exception list were ever
 * captured live (no field of `DD25V`/`DD26V`/`DD27P` was seen filled, and
 * `DDIF_VIEW_ACTIVATE`'s signature was never captured at all). Everything
 * beyond that is marked `ASSUMPTION:` at its point of use and unconfirmed
 * against a live system. Full capture and reasoning:
 * the git history.
 *
 * No SE54/table-maintenance dialog is generated, deliberately:
 * `VIEW_MAINTENANCE_GENERATE` is an interactive-only wizard (`CALL
 * TRANSACTION 'SE55'`) with no headless equivalent inside
 * `IF_OO_ADT_CLASSRUN`. `capabilities.ts`'s `VIEW/DV` entry states the same
 * limit to callers.
 *
 * {@link createClassicView} gates on the VIEW itself via
 * {@link assertBridgeMutation} before generating any source —
 * `deployBridge`'s own gate only judges the bridge class, never the view or
 * its package.
 */

import { TERMINAL_REFUSAL_NOTE } from "./capabilities.js";
import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { AbapIdentifierOptions, SafetyCorr, SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import {
  DDIC_BRIDGE_CLASS,
  assertBridgeMutation,
  ddicBridgeSource,
  runDdicBridge,
  subrcCheckFragment,
  type DdicTag,
  type DdicTranscript,
} from "./ddic-bridge.js";
import { abapLiteral, assertAbapText, assertEnhIdentifier } from "./enhancement-templates.js";
import { isLocalPackageName, isTrkorr } from "./transports.js";

// ---------------------------------------------------------------------------
// Parameters and limits
// ---------------------------------------------------------------------------

export interface ClassicViewParams {
  /** The view to create, e.g. ZTM_V_CARRIER. */
  viewName: string;
  /** Its single base table. */
  baseTable: string;
  /** Base-table fields to project, in order. Must be non-empty. */
  fields: readonly string[];
  /** DD25V-DDTEXT. */
  description: string;
  /** DEVCLASS. */
  packageName: string;
  /**
   * An ALREADY gate-judged TRKORR. `validate()`/`classicViewFragment` require
   * it for a transportable (non-`$`-prefixed) package (`RS_CORR_INSERT` needs
   * one to register the view in CTS) and refuse it for a local, `$`-prefixed
   * package (see {@link isLocalPackage}). `createClassicView` itself reaches
   * no package at all today — see
   * {@link assertClassicViewCreateSupported} — so this matters only to
   * direct `classicViewFragment` callers. Not routing here isn't a fix in
   * itself: no package, including `$TMP`, is known to produce a working
   * create. Auto-acquiring a request for this path is
   * deliberately deferred until one is — do not add it here.
   */
  corrNr?: string;
}

/** `DDOBJNAME`/`TABNAME`/`FIELDNAME` are all CHAR30 — the same ceiling `assertEnhIdentifier` defaults to. */
const VIEW_NAME_MAX = 30;

/** `DD25V-DDTEXT` is `AS4TEXT`, CHAR60. */
const VIEW_TEXT_MAX = 60;

/** Keeps the zero-padded `DD27P-OBJPOS` position (4 numeric chars) inside `0001`-`9999`; see {@link classicViewFragment}. */
const MAX_VIEW_FIELDS = 249;

/** `RS_CORR_INSERT`'s `object` for `object_class = 'DICT'` is a 44-char key: 4-char transport object type, then the name in 40. A bare name lands its first 4 characters in the type field (TK103). */
const DICT_KEY_NAME_LENGTH = 40;
function dictObjectKey(viewName: string): string {
  return `VIEW${viewName.padEnd(DICT_KEY_NAME_LENGTH)}`;
}

/**
 * Local (non-transportable) package: ANY `$`-prefixed package, per
 * {@link isLocalPackageName} (`safety.ts:1677`/`transport.ts:876`'s rule, not
 * just `$TMP`), compared case-insensitively (`$tmp` == `$TMP` to the
 * server). A local view skips RS_CORR_INSERT/CTS registration entirely (no
 * `VIEW-REGISTERED` tag expected) — `validate` refuses a `corrNr` supplied
 * for one rather than silently ignoring it. Delegates to `transports.ts`'s
 * shared `$`-prefix rule rather than re-inlining it.
 *
 * `createClassicView` no longer attempts ANY package — see
 * {@link MEASURED_PACKAGE}/{@link assertClassicViewCreateSupported} — but
 * "is this local" is still the right question for whether the fragment emits
 * `RS_CORR_INSERT`, so the two predicates stay separate. A transportable
 * package now gets the fixed DICT key shape and registration-before-PUT
 * ordering below, unproven live; `$TMP` lands an active view unregistered in
 * TADIR, undeletable and unundoable.
 */
function isLocalPackage(packageName: string): boolean {
  return isLocalPackageName(packageName);
}

/**
 * The one package a classic-view create was ever attempted into, and the one
 * whose failure is therefore MEASURED rather than inferred — see
 * {@link assertClassicViewCreateSupported}'s `$TMP` branch for what the
 * measurement found. Deliberately narrower than {@link isLocalPackage}:
 * whether a package is local is settled by SAP semantics (any `$`-prefix),
 * whereas this is a statement about evidence. Nothing is attempted today, so
 * this constant now only selects which refusal reason is honest.
 */
const MEASURED_PACKAGE = "$TMP";

/** Is this the one package whose create was actually measured (see {@link MEASURED_PACKAGE})? */
function isMeasuredPackage(packageName: string): boolean {
  return packageName.trim().toUpperCase() === MEASURED_PACKAGE;
}

/**
 * Refuses a classic view create client-side, before any ADT traffic, for
 * EVERY package — `$TMP` included, and an omitted `package` with it, since
 * `src/tools/write.ts` defaults that to `$TMP`. The three branches differ
 * only in which reason is honest for the package named (see
 * {@link MEASURED_PACKAGE}); all three refuse, which is what makes the shared
 * opening sentence true read literally.
 *
 * `$TMP` used to be let through. It was closed because it did not fail — it
 * SUCCEEDED, at creating an object neither `abap_write mode=delete` nor
 * `abap_journal mode=undo` can then remove.
 */
export function assertClassicViewCreateSupported(packageName: string): void {
  const validated = assertEnhIdentifier(packageName, "packageName", PACKAGE_RULES);
  const opening =
    `No retry will succeed for package ${JSON.stringify(validated)} or any other: abapsmith ` +
    "cannot create a classic view for any package, so create it in SE11/SE14 by hand instead. ";
  if (isMeasuredPackage(validated)) {
    throw new AbapError(
      "UNSUPPORTED",
      opening +
        "$TMP is not the exception, and omitting `package` (which resolves to $TMP) does not " +
        "reach one: it is the one package a create was ever attempted into, and the attempt is " +
        "refused now because of what it did, not what it failed to do. Measured 2026-08-30, a " +
        "$TMP create lands ACTIVE but unregistered in TADIR, so the view carries no packageRef, " +
        "so abap_write mode=delete refuses it (PACKAGE_UNKNOWN) and abap_journal mode=undo " +
        "refuses it non-overridably too. Succeeding at minting an object abapsmith is then " +
        `obliged to refuse to remove is not a working create. ${TERMINAL_REFUSAL_NOTE}`,
      { packageName: validated },
      "No retry will succeed. Create the view in SE11/SE14, or use a CDS view (DDLS/DF) — the " +
        "modern equivalent, which abapsmith both writes and reads.",
    );
  }
  if (isLocalPackageName(validated)) {
    throw new AbapError(
      "UNSUPPORTED",
      opening +
        "It is local (`$`-prefixed) but not $TMP, so the object-key rejection a transportable " +
        "package hits is not the obstacle here — a local package is never registered in CTS at " +
        "all, and no TADIR-registration call is generated for it. This package itself has never " +
        "been tried — that is untried, not measured — and $TMP, the one package that WAS tried, " +
        "is refused too: measured 2026-08-30, a $TMP create lands active but unregistered in " +
        "TADIR, so it carries no packageRef, so abap_write mode=delete refuses it " +
        "(PACKAGE_UNKNOWN) and abap_journal mode=undo refuses it non-overridably. Trying this " +
        `package would risk minting another orphan abapsmith cannot clear. ${TERMINAL_REFUSAL_NOTE}`,
      { packageName: validated },
      "No retry will succeed. A stranded view needs SE11/SE14 to clear by hand.",
    );
  }
  throw new AbapError(
    "UNSUPPORTED",
    opening +
      "It is not $TMP. Two obstacles a transportable create hit live are now addressed in the " +
      "generated ABAP, and neither is proven: RS_CORR_INSERT rejected the bare view name as its " +
      "object key (object_class = 'DICT', sy-subrc=1, TK103 \"This syntax cannot be used for an " +
      "object name\") and is now handed the 44-character DICT key that parameter reads, and it now " +
      "runs BEFORE DDIF_VIEW_PUT rather than after its COMMIT WORK, so a rejected registration can " +
      "no longer strand the active, packageRef-less view earlier attempts left behind. Both are " +
      "read off the function module's source, not measured, so the create stays refused until a " +
      "live run shows it working. $TMP is not an escape from any of this, and is no longer " +
      "attempted at all: measured 2026-08-30, a $TMP create lands active but unregistered in " +
      "TADIR, so it carries no packageRef, so abap_write mode=delete refuses it " +
      `(PACKAGE_UNKNOWN) and abap_journal mode=undo refuses it non-overridably too. ${TERMINAL_REFUSAL_NOTE}`,
    { packageName: validated },
    "No retry will succeed. A stranded view — from either path — needs SE11/SE14 to clear by hand.",
  );
}

/**
 * A validated identifier, as an ABAP string literal. Re-asserts at the point
 * of embedding rather than trusting the caller already did — same shape as
 * `enhancement-bridge.ts`'s `assertQuotedLiteral` — so a future call site
 * can't forget.
 */
function quotedIdentifier(value: string, what: string, opts: AbapIdentifierOptions = {}): string {
  return abapLiteral(assertEnhIdentifier(value, what, { maxLength: VIEW_NAME_MAX, ...opts }));
}

/** Package identifier rules, shared between `validate` and {@link quotedIdentifier} so the two can't disagree on what counts as local (`allowLocal` for the leading `$`). */
const PACKAGE_RULES: AbapIdentifierOptions = { maxLength: VIEW_NAME_MAX, allowLocal: true };

/**
 * `corrNr`, validated as an ALREADY gate-judged TRKORR — same grammar and
 * shape as `package-create.ts`'s `assertCorrNr`, reusing `transports.ts`'s
 * `isTrkorr` rather than inventing a second one.
 */
function assertCorrNr(value: string): string {
  if (!isTrkorr(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `corr_nr ${JSON.stringify(value)} is not a transport request/task number this system would ` +
        "issue (e.g. A4HK900121). This module never acquires a request on its own — the caller " +
        "must hand it one that has already been judged by the safety gate.",
      { what: "corrNr", value },
    );
  }
  return value;
}

/** Every caller string validated once, so the fragment can never see a raw one. */
function validate(p: ClassicViewParams): ClassicViewParams {
  const viewName = assertEnhIdentifier(p.viewName, "viewName", { maxLength: VIEW_NAME_MAX });
  const baseTable = assertEnhIdentifier(p.baseTable, "baseTable", { maxLength: VIEW_NAME_MAX });
  if (!Array.isArray(p.fields) || p.fields.length === 0) {
    throw new AbapError(
      "BAD_INPUT",
      "fields must be a non-empty list of base-table field names — a classic view projecting no " +
        "field at all is not a view SE11 or DDIF_VIEW_PUT would accept.",
      { viewName, baseTable },
    );
  }
  if (p.fields.length > MAX_VIEW_FIELDS) {
    throw new AbapError(
      "BAD_INPUT",
      `fields has ${p.fields.length} entries, more than the ${MAX_VIEW_FIELDS} this bridge generates. ` +
        "DD27P-OBJPOS is a 4-character numeric position and this bridge fills it by zero-padding a " +
        "1-based index, so every generated position must stay inside 0001-9999.",
      { viewName, count: p.fields.length, max: MAX_VIEW_FIELDS },
    );
  }
  const fields = p.fields.map((f, i) =>
    assertEnhIdentifier(f, `fields[${i}]`, { maxLength: VIEW_NAME_MAX }),
  );
  const description = assertAbapText(p.description, "description", VIEW_TEXT_MAX);
  // allowLocal for any $-prefixed package; embedded in RS_CORR_INSERT like every other identifier here.
  const packageName = assertEnhIdentifier(p.packageName, "packageName", PACKAGE_RULES);

  const local = isLocalPackage(packageName);
  if (local && p.corrNr !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      `corr_nr ${JSON.stringify(p.corrNr)} was supplied for local package ${JSON.stringify(packageName)}, ` +
        "but a local ($-prefixed) view is never registered in CTS at all — RS_CORR_INSERT is not " +
        "generated for it — so there is nothing here for a transport request to attach to.",
      { viewName, baseTable, packageName, corrNr: p.corrNr },
    );
  }
  if (!local && p.corrNr === undefined) {
    throw new AbapError(
      "TRANSPORT_ERROR",
      `packageName ${JSON.stringify(packageName)} is not local ($-prefixed), so this view must be ` +
        "registered in CTS via RS_CORR_INSERT, which requires a transport request — pass corr_nr " +
        "(an ALREADY gate-judged TRKORR, e.g. A4HK900121).",
      { viewName, baseTable, packageName },
      "Via abap_write, pass corr_nr with the TRKORR the safety gate already judged for this write " +
        "(see the abapsmith-put-work-on-a-transport skill).",
    );
  }
  const corrNr = local ? undefined : assertCorrNr(p.corrNr as string);
  return { viewName, baseTable, fields, description, packageName, corrNr };
}

// ---------------------------------------------------------------------------
// The generated ABAP
// ---------------------------------------------------------------------------

/**
 * The `DATA` declarations {@link classicViewFragment} assumes exist. Bare
 * declarations with NO leading `DATA` keyword — `ddicBridgeSource` prepends
 * it.
 *
 * ASSUMPTION (unconfirmed live): `DD25V`/`DD26V`/`DD27P` are valid `TYPE`s
 * for work areas here, and `lv_rc TYPE sy-subrc` is an acceptable receiver
 * for `DDIF_VIEW_ACTIVATE`'s `rc` assigned back to `sy-subrc`. A wrong type
 * is a syntax error `deployBridge`'s `assertNoErrors` catches before
 * anything executes.
 */
export const VIEW_DATA_LINES: readonly string[] = [
  "ls_dd25v TYPE dd25v.",
  "ls_dd26v TYPE dd26v.",
  "lt_dd26v TYPE STANDARD TABLE OF dd26v.",
  "ls_dd27p TYPE dd27p.",
  "lt_dd27p TYPE STANDARD TABLE OF dd27p.",
  "lv_rc TYPE sy-subrc.",
];

/**
 * The closed ABAP fragment that creates, registers and activates one classic
 * database view. Exported for the generator/parser drift test — every
 * `out->write( 'TAG' )` it emits must be a tag `parseDdicTranscript`
 * recognises.
 *
 * Built from validated identifiers only ({@link quotedIdentifier}, and
 * `assertAbapText` + `abapLiteral` for the description) — no caller string is
 * ever concatenated raw.
 *
 * Only `DDIF_VIEW_PUT`'s parameter names and exception list were captured
 * live; everything else here — DD25V/DD26V/DD27P field names and constants,
 * which TABLES parameter carries which payload, `DDIF_VIEW_ACTIVATE`'s
 * signature — is an unconfirmed ASSUMPTION. `RS_CORR_INSERT`'s parameters
 * were read off the live function group `SCOR` and confirmed live; the
 * object key they build (`object`/`object_class = 'DICT'`) now uses the
 * 44-char DICT layout {@link dictObjectKey} builds, and registration now
 * runs before any dictionary write — both unproven live (see
 * {@link assertClassicViewCreateSupported}). A wrong
 * field/parameter name fails loud (syntax error at activation); a
 * wrong constant or a wrong TABLES-parameter reading fails quiet (a view
 * with no fields), which is why a live run must read the created view back,
 * not just check `sy-subrc`. Full capture text and per-assumption reasoning:
 * the git history.
 *
 * Two live-tested incidents shape this fragment's structure:
 *  - `RS_CORR_INSERT` is generated ONLY for a transportable (non-`$`-prefixed)
 *    package (see {@link isLocalPackage}). `createClassicView` itself attempts
 *    no package at all today ({@link assertClassicViewCreateSupported}
 *    refuses every one), so this branch is exercised only by direct
 *    `classicViewFragment` callers — it stays because it records what the
 *    generated ABAP must look like the day a create is attempted again.
 *  - Two explicit `COMMIT WORK` statements (after PUT, after ACTIVATE) work
 *    around `DDIF_VIEW_PUT` being an uncommitted update-task-style write; a
 *    live run without them reproduced a false success (tags present,
 *    `sy-subrc = 0`, but the view absent on read-back). Registration now runs
 *    BEFORE the first of the two, so nothing is committed before it. This fix
 *    is itself still UNTESTED in isolation — `write.ts`'s `abapCreateViaBridge`
 *    read-back is what actually catches it if it fails.
 *
 * NOT GENERATED, deliberately: any SE54/`VIEW_MAINTENANCE_GENERATE`/`SE55`
 * step — see this module's header.
 */
export function classicViewFragment(p: ClassicViewParams): string[] {
  const { viewName, baseTable, fields, description, packageName, corrNr } = validate(p);
  const view = quotedIdentifier(viewName, "viewName");
  const table = quotedIdentifier(baseTable, "baseTable");

  const lines: string[] = [];

  if (!isLocalPackage(packageName)) {
    lines.push(
      // --- TADIR/transport registration, BEFORE any dictionary write: a key
      //     RS_CORR_INSERT rejects then strands nothing. Skipped for any
      //     local ($-prefixed) package — see isLocalPackage's doc comment;
      //     do not make this unconditional without new live evidence.
      "CALL FUNCTION 'RS_CORR_INSERT'",
      // ABAP drops a text-field literal's trailing blanks; the formal
      // parameter (DDOBJNAME, CHAR44) re-pads to its declared length, so the
      // literal emitted here and the key SAP actually reads are the same
      // 44-byte layout.
      `  EXPORTING object = ${abapLiteral(dictObjectKey(viewName))}`,
      "            object_class = 'DICT'",
      `            devclass = ${quotedIdentifier(packageName, "packageName", PACKAGE_RULES)}`,
      "            master_language = sy-langu",
      "            mode = 'INSERT'",
      // Selects R3TR/VIEW registration over the LIMU/VIED sub-object variant.
      "            global_lock = 'X'",
      // suppress_dialog = 'X' sets iv_dialog = 'D', suppressing the request-selection dynpro
      // (korrnum alone reaches only iv_order).
      `            korrnum = ${abapLiteral(corrNr as string)}`,
      "            suppress_dialog = 'X'",
      "  EXCEPTIONS cancelled = 1 permission_failure = 2 unknown_objectclass = 3 OTHERS = 4.",
      ...subrcCheckFragment("RS_CORR_INSERT", "VIEW-REGISTERED"),
      "",
    );
  }

  lines.push(
    // --- DD25V: the view header (field names/constants are ASSUMPTIONS, see doc comment above).
    "CLEAR ls_dd25v.",
    `ls_dd25v-viewname   = ${view}.`,
    // 'V' = view (as opposed to a maintenance/help aggregate).
    "ls_dd25v-aggtype    = 'V'.",
    `ls_dd25v-roottab    = ${table}.`,
    // 'D' = database view. 'R' = read-only access.
    "ls_dd25v-viewclass  = 'D'.",
    "ls_dd25v-viewgrant  = 'R'.",
    "ls_dd25v-ddlanguage = sy-langu.",
    `ls_dd25v-ddtext     = ${abapLiteral(description)}.`,
    "",
    // --- DD26V: the base table (ONE row — single-table projections only; see capabilities.ts's VIEW/DV limits).
    "CLEAR lt_dd26v. CLEAR ls_dd26v.",
    `ls_dd26v-viewname = ${view}.`,
    `ls_dd26v-tabname  = ${table}.`,
    "ls_dd26v-tabpos   = '0001'.",
    "APPEND ls_dd26v TO lt_dd26v.",
    "",
    // --- DD27P: one row per projected field, in the caller's order.
    "CLEAR lt_dd27p.",
  );

  fields.forEach((field, index) => {
    const quoted = quotedIdentifier(field, `fields[${index}]`);
    // 1-based, zero-padded to DD27P-OBJPOS's 4 chars; validate() caps count so it can't overflow.
    const objpos = String(index + 1).padStart(4, "0");
    lines.push(
      "CLEAR ls_dd27p.",
      `ls_dd27p-viewname  = ${view}.`,
      `ls_dd27p-objpos    = '${objpos}'.`,
      `ls_dd27p-viewfield = ${quoted}.`,
      `ls_dd27p-tabname   = ${table}.`,
      `ls_dd27p-fieldname = ${quoted}.`,
      "APPEND ls_dd27p TO lt_dd27p.",
    );
  });

  lines.push(
    "",
    // --- The PUT. Parameter and exception names are the captured ones.
    "CALL FUNCTION 'DDIF_VIEW_PUT'",
    `  EXPORTING name = ${view}`,
    "            dd25v_wa = ls_dd25v",
    "  TABLES    dd26v_tab = lt_dd26v",
    "            dd27p_tab = lt_dd27p",
    "  EXCEPTIONS view_not_found = 1 name_inconsistent = 2 view_inconsistent = 3",
    "             put_failure = 4 put_refused = 5 OTHERS = 6.",
    // sy-subrc, not an exception CATCH cx_root sees — subrcCheckFragment gates the success tag on it.
    ...subrcCheckFragment("DDIF_VIEW_PUT", "VIEW-PUT"),
    "",
    // Commits the staged PUT before ACTIVATE touches it — see doc comment above (false-success
    // incident). Registration (above, if generated) already ran before this, so nothing is
    // stranded if a later step fails.
    "COMMIT WORK.",
  );

  lines.push(
    "",
    // --- Activation. `rc > 4` means "not activated" without raising; folded into sy-subrc so subrcCheckFragment sees it too.
    "CALL FUNCTION 'DDIF_VIEW_ACTIVATE'",
    `  EXPORTING name = ${view}`,
    "  IMPORTING rc = lv_rc",
    "  EXCEPTIONS not_found = 1 put_failure = 2 OTHERS = 3.",
    "IF sy-subrc = 0 AND lv_rc > 4. sy-subrc = lv_rc. ENDIF.",
    ...subrcCheckFragment("DDIF_VIEW_ACTIVATE", "VIEW-ACTIVATED"),
    "",
    // No implicit commit on classrun return — same reasoning as the COMMIT WORK above.
    "COMMIT WORK.",
  );

  return lines;
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/**
 * `completed`/`hint` for {@link runDdicBridge}'s partial-success reporting on
 * a transportable create: `RS_CORR_INSERT` now runs before `DDIF_VIEW_PUT`
 * (see {@link classicViewFragment}), so a later failure can leave either just
 * a TADIR/transport entry, or that plus a committed-but-inactive view.
 * Exported so the shape is testable without a live transcript.
 */
export function viewCreatePartialSuccess(viewName: string): {
  completed: Readonly<Partial<Record<DdicTag, string>>>;
  hint: string;
} {
  return {
    completed: {
      "VIEW-REGISTERED": `RS_CORR_INSERT registered ${viewName} in TADIR and on the transport request, before any dictionary write — no view was created by it.`,
      "VIEW-PUT": `DDIF_VIEW_PUT wrote ${viewName}, and the COMMIT WORK that follows it committed it, inactive.`,
    },
    hint:
      `If VIEW-PUT fired, ${viewName} exists AND is registered — abap_write mode="delete" ` +
      `type="VIEW/DV" can remove it. If only VIEW-REGISTERED fired, no view was written and only ` +
      "the TADIR/transport entry exists — remove it from the request in SE09/SE10, or reuse it by " +
      "re-running the create into the same request.",
  };
}

/**
 * Create one classic database view: refuse EVERY package
 * (see {@link assertClassicViewCreateSupported}), validate, gate the VIEW,
 * generate, deploy, run, assert the transcript. Everything past the refusal
 * is unreachable from the tool surface today and is kept deliberately: the
 * generated ABAP and its choreography are the record of the recon, and the
 * refusal is one policy call to lift once a `$TMP` create can be registered
 * in TADIR. {@link assertClassicViewCreateSupported}
 * runs first and BEFORE `validate()` — deliberately ahead of `validate()`'s
 * own `TRANSPORT_ERROR` for a missing `corr_nr`, so a refused caller is told
 * the create is unsupported rather than sent to acquire a transport request
 * that cannot help. Then `validate()` (`BAD_INPUT` before anything else
 * `ddic-bridge.ts`'s header requires), then {@link assertBridgeMutation} on
 * the VIEW (zero-network, so a refusal leaves no bridge class behind), only
 * then generate ABAP, then {@link runDdicBridge}.
 *
 * `expectTags` mirrors the fragment: `VIEW-REGISTERED` is expected exactly
 * when {@link isLocalPackage} says `RS_CORR_INSERT` is generated, computed
 * from the same predicate so the two cannot drift. (No package reaches this
 * line today, but it is the right predicate for the question regardless of
 * which one eventually does.)
 *
 * `corr`'s `source` is always `"named"`, never `"auto"` — unlike
 * `package-create.ts`, this module never auto-creates a request itself.
 */
export async function createClassicView(
  conn: AbapConnection,
  gate: SafetyGate,
  params: ClassicViewParams,
): Promise<{ run: RunResult; transcript: DdicTranscript }> {
  assertClassicViewCreateSupported(params.packageName);
  const validated = validate(params);
  const { viewName, packageName, corrNr } = validated;

  const corr: SafetyCorr | undefined = isLocalPackage(packageName)
    ? undefined
    : { kind: "transport", corrNr: corrNr as string, source: "named" };

  // Gate on the domain object itself — deployBridge only judges the bridge class, never this view/package.
  // activate: true because DDIF_VIEW_ACTIVATE runs inside the same bridge execution.
  assertBridgeMutation(
    gate,
    { type: "VIEW/DV", name: viewName, packageName },
    { activate: true, ...(corr !== undefined ? { corr } : {}) },
  );

  const source = ddicBridgeSource(
    DDIC_BRIDGE_CLASS.createView,
    VIEW_DATA_LINES,
    classicViewFragment(validated),
  );

  const expectTags: DdicTag[] = isLocalPackage(packageName)
    ? ["VIEW-PUT", "VIEW-ACTIVATED"]
    : ["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"];

  const partial = viewCreatePartialSuccess(viewName);
  return runDdicBridge(conn, gate, {
    className: DDIC_BRIDGE_CLASS.createView,
    source,
    description: `abapsmith create-classic-view bridge (${viewName})`,
    what: `Creating classic view ${viewName}`,
    expectTags,
    completed: partial.completed,
    partialHint: partial.hint,
  });
}
