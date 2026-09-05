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
   * package — a local create still calls `RS_CORR_INSERT` and registers the
   * view, but with `korrnum = space` (ABAP's SPACE constant), not a transport
   * request (see {@link isLocalPackage}). The caller (`src/tools/write.ts`)
   * resolves it before calling here — from `corr_nr` or via
   * `preflightPackageCorr` — this module never acquires one itself.
   */
  corrNr?: string;
  /** Whether `corrNr` was named by a human or picked by the server (`preflightPackageCorr`'s "named"/"auto") — see `SafetyCorr` (`../safety.js`). */
  corrSource?: "named" | "auto";
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
 * server). A local view still runs `RS_CORR_INSERT` and is registered in
 * TADIR (`VIEW-REGISTERED` tag expected the same as a transportable create),
 * but with `korrnum = space` rather than a TRKORR — proven live on A4H
 * 2026-09-05: a create into `$ZTMD_I09` with `korrnum = space` returned
 * sy-subrc 0 and wrote a TADIR row with devclass `$ZTMD_I09`, and the view
 * was afterwards removed cleanly by the delete bridge. `validate` still
 * refuses a `corrNr` supplied for a local package rather than silently
 * ignoring it — there is no transport request for it to attach to. Delegates
 * to `transports.ts`'s shared `$`-prefix rule rather than re-inlining it.
 */
function isLocalPackage(packageName: string): boolean {
  return isLocalPackageName(packageName);
}

/**
 * The would-be ADT URI of a classic view that does not exist yet — the
 * GET-only collection `capabilities.ts`'s `VIEW/DV.bridgeCreate.adtRest`
 * advertises, synthesized because there is nothing to GET. Only ever used as
 * the transport resolver's target label / `<REF>` on request creation, never
 * sent to a CTS classification check.
 */
export function classicViewUri(viewName: string): string {
  return `/sap/bc/adt/ddic/views/${viewName.trim().toLowerCase()}`;
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

/**
 * No-network check: does this package/corr_nr pairing make sense for a
 * classic view create, on its own terms? A local (`$`-prefixed) package
 * refuses a `corrNr` — it registers with `korrnum = space`, not a transport
 * request, so there is nothing for one to attach to. A supplied `corrNr` must
 * be TRKORR-shaped ({@link isTrkorr}). It does NOT require a `corrNr` for a
 * transportable package — {@link validate} owns that invariant, since the
 * caller may resolve one after this runs. `abapCreateViaBridge`
 * (`src/tools/write.ts`) calls this before its pre-create read, so a bad
 * pair fails before any ADT traffic.
 */
export function assertClassicViewCreateTarget(
  packageName: string,
  corrNr: string | undefined,
): string {
  const validated = assertEnhIdentifier(packageName, "packageName", PACKAGE_RULES);
  const local = isLocalPackage(validated);
  if (local && corrNr !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      `corr_nr ${JSON.stringify(corrNr)} was supplied for local package ${JSON.stringify(validated)}, ` +
        "but a local ($-prefixed) view is registered with korrnum = space rather than on a " +
        "transport request, so there is nothing here for one to attach to.",
      { packageName: validated, corrNr },
    );
  }
  if (corrNr !== undefined) assertCorrNr(corrNr);
  return validated;
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
  const packageName = assertClassicViewCreateTarget(p.packageName, p.corrNr);
  const local = isLocalPackage(packageName);
  // This module never acquires a request itself — the caller resolves one (corr_nr, or
  // preflightPackageCorr) before calling here — but a transportable package must still
  // arrive with one: classicViewFragment can't emit korrnum from an undefined corrNr.
  if (!local && p.corrNr === undefined) {
    throw new AbapError(
      "TRANSPORT_ERROR",
      `packageName ${JSON.stringify(packageName)} is not local ($-prefixed), so this view must be ` +
        "registered in CTS via RS_CORR_INSERT, which requires a transport request — pass corr_nr " +
        "(an ALREADY gate-judged TRKORR, e.g. A4HK900121).",
      { packageName },
      "Via abap_write, pass corr_nr with the TRKORR the safety gate already judged for this write " +
        "(see the abapsmith-put-work-on-a-transport skill).",
    );
  }
  const corrNr = local ? undefined : (p.corrNr as string);
  return { viewName, baseTable, fields, description, packageName, corrNr, corrSource: p.corrSource };
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
 * object key they build (`object`/`object_class = 'DICT'`) uses the 44-char
 * DICT layout {@link dictObjectKey} builds, and registration runs before any
 * dictionary write — both proven live (see the two incidents below). A wrong
 * field/parameter name fails loud (syntax error at activation); a
 * wrong constant or a wrong TABLES-parameter reading fails quiet (a view
 * with no fields), which is why a live run must read the created view back,
 * not just check `sy-subrc`. Full capture text and per-assumption reasoning:
 * the git history.
 *
 * Two live-tested incidents shape this fragment's structure:
 *  - `RS_CORR_INSERT` runs for every package, transportable or local (see
 *    {@link isLocalPackage}) — only the `korrnum` line differs: a
 *    transportable create passes its TRKORR, a local one passes `space`.
 *    Proven live on A4H: a transportable create into ZBOPF_Q1PKG with a
 *    modifiable task succeeded 2026-09-04 (VIEW-REGISTERED/VIEW-PUT/
 *    VIEW-ACTIVATED, the view read back with its fields, a TADIR row
 *    present); a local create into `$ZTMD_I09` with `korrnum = space`
 *    succeeded 2026-09-05 (sy-subrc 0, a TADIR row with devclass
 *    `$ZTMD_I09`, the view then removed cleanly by the delete bridge).
 *  - Two explicit `COMMIT WORK` statements (after PUT, after ACTIVATE) work
 *    around `DDIF_VIEW_PUT` being an uncommitted update-task-style write; a
 *    live run without them reproduced a false success (tags present,
 *    `sy-subrc = 0`, but the view absent on read-back). Registration runs
 *    BEFORE the first of the two, so nothing is committed before it —
 *    confirmed by both live runs above, neither of which left an orphaned
 *    view.
 *
 * NOT GENERATED, deliberately: any SE54/`VIEW_MAINTENANCE_GENERATE`/`SE55`
 * step — see this module's header.
 */
export function classicViewFragment(p: ClassicViewParams): string[] {
  const { viewName, baseTable, fields, description, packageName, corrNr } = validate(p);
  const view = quotedIdentifier(viewName, "viewName");
  const table = quotedIdentifier(baseTable, "baseTable");
  const local = isLocalPackage(packageName);

  const lines: string[] = [];

  lines.push(
    // --- TADIR registration, BEFORE any dictionary write: a key
    //     RS_CORR_INSERT rejects then strands nothing. Runs for every
    //     package; only korrnum differs (TRKORR vs space) below.
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
    // A local ($-prefixed) package has no transport request to name; space is ABAP's SPACE constant, not a quoted literal.
    local ? "            korrnum = space" : `            korrnum = ${abapLiteral(corrNr as string)}`,
    // suppress_dialog = 'X' sets iv_dialog = 'D', suppressing the request-selection dynpro
    // (korrnum alone reaches only iv_order).
    "            suppress_dialog = 'X'",
    "  EXCEPTIONS cancelled = 1 permission_failure = 2 unknown_objectclass = 3 OTHERS = 4.",
    ...subrcCheckFragment("RS_CORR_INSERT", "VIEW-REGISTERED"),
    "",
  );

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
 * `completed`/`hint` for {@link runDdicBridge}'s partial-success reporting:
 * `RS_CORR_INSERT` runs before `DDIF_VIEW_PUT` for every package (see
 * {@link classicViewFragment}), so a later failure can leave either just a
 * TADIR entry, or that plus a committed-but-inactive view. Exported so the
 * shape is testable without a live transcript.
 */
export function viewCreatePartialSuccess(viewName: string): {
  completed: Readonly<Partial<Record<DdicTag, string>>>;
  hint: string;
} {
  return {
    completed: {
      "VIEW-REGISTERED": `RS_CORR_INSERT registered ${viewName} in TADIR — on the transport request for a transportable package, with korrnum = space for a local one — before any dictionary write; no view was created by it.`,
      "VIEW-PUT": `DDIF_VIEW_PUT wrote ${viewName}, and the COMMIT WORK that follows it committed it, inactive.`,
    },
    hint:
      `If VIEW-PUT fired, ${viewName} exists AND is registered — abap_write mode="delete" ` +
      `type="VIEW/DV" can remove it. If only VIEW-REGISTERED fired, no view was written and only ` +
      "the TADIR entry exists — for a transportable package, remove it from the request in " +
      "SE09/SE10, or reuse it by re-running the create into the same request; for a local " +
      "package (korrnum = space) it is registered but not on any request.",
  };
}

/**
 * Create one classic database view: validate, gate the VIEW, generate,
 * deploy, run, assert the transcript. `validate()` (via
 * {@link assertClassicViewCreateTarget}) runs first — `BAD_INPUT`/
 * `TRANSPORT_ERROR` before anything else `ddic-bridge.ts`'s header requires
 * — then {@link assertBridgeMutation} on the VIEW (zero-network, so a
 * refusal leaves no bridge class behind), only then generate ABAP, then
 * {@link runDdicBridge}.
 *
 * `expectTags` is `VIEW-REGISTERED`, `VIEW-PUT`, `VIEW-ACTIVATED` for every
 * package: `RS_CORR_INSERT` registers a local package too (with
 * `korrnum = space`), so registration is expected regardless of
 * {@link isLocalPackage}. Proven live on A4H: a transportable create into
 * ZBOPF_Q1PKG with a task succeeded 2026-09-04; a local create into
 * `$ZTMD_I09` with `korrnum = space` succeeded 2026-09-05 (sy-subrc 0, a
 * TADIR row written, the view then removed cleanly by the delete bridge).
 *
 * `corr`'s `source` reflects however the caller resolved `corrNr` — `"named"`
 * by default (a caller-supplied `corr_nr`), or `"auto"` when the caller
 * passes `corrSource: "auto"` (`preflightPackageCorr` picked the request) —
 * same shape as `package-create.ts`'s `createPackageViaBridge`.
 */
export async function createClassicView(
  conn: AbapConnection,
  gate: SafetyGate,
  params: ClassicViewParams,
): Promise<{ run: RunResult; transcript: DdicTranscript }> {
  const validated = validate(params);
  const { viewName, packageName, corrNr, corrSource } = validated;

  const corr: SafetyCorr | undefined = isLocalPackage(packageName)
    ? undefined
    : { kind: "transport", corrNr: corrNr as string, source: corrSource ?? "named" };

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

  const expectTags: DdicTag[] = ["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"];

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
