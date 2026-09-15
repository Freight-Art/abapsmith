/**
 * # Search help (`SHLP/DH`) create/update — through the fluid `classic` tool
 *
 * ADT REST 404s on every verb for the search-help collection on this
 * release — see `capabilities.ts`'s `SHLP/DH` entry — so SE11's own search
 * help editor writes one the same way SE11's view editor does: ordinary
 * function modules (`DDIF_SHLP_PUT` + `DDIF_SHLP_ACTIVATE`, registered via
 * `RS_CORR_INSERT`). This module validates and gates the request, then hands
 * the validated values to {@link runClassicAction} (`./classic-call.ts`),
 * which runs them as the `create_search_help` / `update_search_help` action
 * of the fluid `classic` tool. The ABAP itself lives in
 * `src/adt/fluid/builtin/classic/abap-shlp.ts`.
 *
 * Proven live on A4H (NetWeaver 7.54, client 001) 2026-09-12, in `$TMP`
 * only: `DDIF_SHLP_PUT` followed by `DDIF_SHLP_ACTIVATE` returned
 * `sy-subrc = 0` with message DH107, and a read-back of
 * DD30L/DD31S/DD32S/DD33S showed the definition exactly as put. The
 * transportable (non-`$TMP`) path runs the identical FM sequence with a real
 * `korrnum` but has NOT itself been run against a live system — see
 * `abap-shlp.ts`'s module doc.
 *
 * `packageName` here is a {@link ServerPackage} — server-resolved, not a
 * caller-supplied string — for both create AND update, unlike
 * `view-create.ts`'s `ClassicViewParams` (plain `string`): the caller
 * (`src/tools/write.ts`) resolves the package from a server read before
 * calling either function here, the same way it must for
 * {@link deleteSearchHelpViaBridge} and for `view-delete.ts`'s delete. This
 * module is zero-network and cannot verify a bare string itself.
 *
 * `create_search_help` and `update_search_help` differ only in their
 * existence pre-check inside `abap-shlp.ts` — both run the identical
 * `RS_CORR_INSERT` -> `DDIF_SHLP_PUT` -> `COMMIT WORK` ->
 * `DDIF_SHLP_ACTIVATE` -> `COMMIT WORK` sequence and emit the identical
 * three tags, `SHLP-REGISTERED`, `SHLP-PUT`, `SHLP-ACTIVATED`. `DDIF_SHLP_PUT`
 * is an uncommitted, update-task-style write, same as `DDIF_VIEW_PUT` —
 * `abap-shlp.ts`'s two `COMMIT WORK` statements exist for the same reason
 * `abap-view.ts`'s do.
 */

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { SafetyCorr, SafetyGate } from "../safety.js";
import type { RunResult } from "./run.js";
import { assertBridgeMutation } from "./bridge-mutation.js";
import type { DdicTag, DdicTranscript } from "./ddic-transcript.js";
import { runClassicAction } from "./classic-call.js";
import { assertAbapText, assertEnhIdentifier } from "./enhancement-templates.js";
import { isLocalPackageName, isTrkorr } from "./transports.js";
import { assertServerPackage, type ServerPackage } from "./resolved-package.js";

// ---------------------------------------------------------------------------
// Parameters and limits
// ---------------------------------------------------------------------------

/** One DD32P interface field. */
export interface SearchHelpField {
  /** DD32P-FIELDNAME. */
  name: string;
  /** DD32P-ROLLNAME, a data element. */
  dataElement: string;
  /** Whether this field is an import parameter (DD32P-SHLPINPUT). */
  import?: boolean;
  /** Whether this field is an export parameter (DD32P-SHLPOUTPUT). */
  export?: boolean;
  /** Optional DD32P-DEFAULTVAL. */
  defaultValue?: string;
}

/** One DD31V included search help. */
export interface SearchHelpInclude {
  /** The included search help's name (DD31V-SUBSHLP). */
  name: string;
}

/** One DD33V field assignment between an included search help and this one's interface. */
export interface SearchHelpAssignment {
  /** This search help's field (DD33V-FIELDNAME). */
  field: string;
  /** The included search help's name (DD33V-SUBSHLP). */
  includedHelp: string;
  /** The included search help's field (DD33V-SUBFIELD). */
  includedField: string;
  /** DD33V-VALUEDIREC: `"I"` import into, `"E"` export from the included help — the only two values `abap-shlp.ts` accepts. */
  direction: string;
}

export interface SearchHelpParams {
  /** The search help to create/update, e.g. ZTM_SH_CARRIER. */
  shlpName: string;
  /** DD30V-DDTEXT. */
  description: string;
  /** Server-resolved (`./resolved-package.ts`) — this module is zero-network and cannot verify it itself. */
  packageName: ServerPackage;
  /**
   * An ALREADY gate-judged TRKORR. Required for a transportable
   * (non-`$`-prefixed) package, refused for a local one — same rule
   * `view-create.ts`'s `corrNr` documents.
   */
  corrNr?: string;
  /** Whether `corrNr` was named by a human or picked by the server — see `SafetyCorr` (`../safety.js`). */
  corrSource?: "named" | "auto";
  /**
   * Table or view the search help selects from (DD30V-SELMETHOD). Omit or
   * pass `""` for a collective search help (DD30V-ISSIMPLE = space), or for
   * an elementary one driven by a search-help exit instead of a table/view —
   * both are normal: five standard SAP elementary helps measured live on
   * A4H 2026-09-15 (e.g. `/UI2/GROUPS_SH`) carry a blank DD30V-SELMETHOD.
   */
  selectionMethod?: string;
  /**
   * Selection method type (DD30V-SELMTYPE): `"T"` (table), `"V"` (view) or
   * `"M"` — the only three this module accepts before dispatch. Only
   * meaningful alongside a non-blank `selectionMethod`; omit or pass `""`
   * when `selectionMethod` is blank too.
   */
  selectionMethodType?: string;
  /** DD30V-DIALOGTYPE. `abap-shlp.ts` defaults this to `"D"` when omitted/empty. */
  dialogType?: string;
  /** Optional text table (DD30V-TEXTTAB). */
  textTable?: string;
  /** Optional single-character hotkey (DD30V-HOTKEY). */
  hotKey?: string;
  /** Whether this is an elementary search help (DD30V-ISSIMPLE). If true, `fields` must carry at least one import and one export parameter. */
  elementary: boolean;
  /** Interface fields (DD32P), in order. `update_search_help` replaces the whole interface. */
  fields: readonly SearchHelpField[];
  /** Other search helps included by this one (DD31V), in order. `update_search_help` replaces the whole list. */
  includes?: readonly SearchHelpInclude[];
  /** Field assignments (DD33V). `update_search_help` replaces the whole list. */
  assignments?: readonly SearchHelpAssignment[];
}

/** `DD30L-SHLPNAME`/`DD32P-FIELDNAME`/`DD31V-SUBSHLP` etc. are all CHAR30. */
const SHLP_NAME_MAX = 30;

/** `DD30V-DDTEXT` is CHAR60, same width as a classic view's DD25V-DDTEXT. */
const SHLP_TEXT_MAX = 60;

/** DD32P-DEFAULTVAL's real width was not captured live; this is a conservative ceiling, not a measured one. */
const DEFAULT_VALUE_MAX = 132;

/** DD30V-SELMTYPE values this module checks before dispatch — `abap-shlp.ts` itself tolerates any value, logging a note for anything outside `T`/`V`. `"M"` (search help as its own selection method) is accepted here but not specially validated by the ABAP either. */
const SELECTION_METHOD_TYPES = new Set(["T", "V", "M"]);

/** DD33V-VALUEDIREC values `abap-shlp.ts` was written against — see `SearchHelpAssignment.direction`. */
const ASSIGNMENT_DIRECTIONS = new Set(["I", "E"]);

/** Package identifier rules — same shape as `view-create.ts`'s `PACKAGE_RULES`. */
const PACKAGE_RULES = { maxLength: SHLP_NAME_MAX, allowLocal: true };

/**
 * `corrNr`, validated as an ALREADY gate-judged TRKORR — same grammar as
 * `view-create.ts`'s own copy of this check.
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
 * search help create/update, on its own terms? Same rule as
 * {@link assertClassicViewCreateTarget} in `view-create.ts`: a local
 * (`$`-prefixed) package refuses a `corrNr`; a supplied `corrNr` must be
 * TRKORR-shaped. It does NOT require a `corrNr` for a transportable package —
 * `validate` below owns that invariant.
 */
export function assertSearchHelpTarget(packageName: string, corrNr: string | undefined): string {
  const validated = assertEnhIdentifier(packageName, "packageName", PACKAGE_RULES);
  const local = isLocalPackageName(validated);
  if (local && corrNr !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      `corr_nr ${JSON.stringify(corrNr)} was supplied for local package ${JSON.stringify(validated)}, ` +
        "but a local ($-prefixed) search help is registered with korrnum = space rather than on a " +
        "transport request, so there is nothing here for one to attach to.",
      { packageName: validated, corrNr },
    );
  }
  if (corrNr !== undefined) assertCorrNr(corrNr);
  return validated;
}

interface ValidatedSearchHelp {
  shlpName: string;
  description: string;
  packageName: string;
  corrNr?: string;
  corrSource?: "named" | "auto";
  selectionMethod: string;
  selectionMethodType: string;
  dialogType?: string;
  textTable?: string;
  hotKey?: string;
  elementary: boolean;
  fields: readonly SearchHelpField[];
  includes: readonly SearchHelpInclude[];
  assignments: readonly SearchHelpAssignment[];
}

/**
 * Every caller string validated once, so the fluid action can never see a
 * raw one. Exported alongside {@link buildArgs} only so
 * `test/classic-bridge-wire-format.test.ts` can drive the exact
 * `validate()` -> `buildArgs()` sequence `createSearchHelp`/
 * `updateSearchHelp` run before dispatch, and capture the real `args`
 * object, without standing up a fake ABAP connection all the way through
 * `dispatch()`.
 */
export function validate(packageNameStr: string, p: SearchHelpParams): ValidatedSearchHelp {
  const shlpName = assertEnhIdentifier(p.shlpName, "shlpName", { maxLength: SHLP_NAME_MAX });
  const description = assertAbapText(p.description, "description", SHLP_TEXT_MAX);
  const packageName = assertSearchHelpTarget(packageNameStr, p.corrNr);
  const local = isLocalPackageName(packageName);
  if (!local && p.corrNr === undefined) {
    throw new AbapError(
      "TRANSPORT_ERROR",
      `packageName ${JSON.stringify(packageName)} is not local ($-prefixed), so this search help must ` +
        "be registered in CTS via RS_CORR_INSERT, which requires a transport request — pass corr_nr " +
        "(an ALREADY gate-judged TRKORR, e.g. A4HK900121).",
      { packageName },
      "Via abap_write, pass corr_nr with the TRKORR the safety gate already judged for this write " +
        "(see the abapsmith-put-work-on-a-transport skill).",
    );
  }
  const corrNr = local ? undefined : p.corrNr;

  // Blank means "none": a collective search help has no selection method at all
  // (DD30V-SELMETHOD empty), and plenty of standard SAP elementary helps have a
  // blank one too, driven by a search-help exit instead — see the module doc on
  // `SearchHelpParams.selectionMethod`. `undefined` and `""` are both "none";
  // anything else is validated as a real ABAP object name, same as before.
  const selectionMethodGiven = p.selectionMethod !== undefined && p.selectionMethod !== "";
  const selectionMethod = selectionMethodGiven
    ? assertEnhIdentifier(p.selectionMethod as string, "selectionMethod", { maxLength: SHLP_NAME_MAX })
    : "";

  let selectionMethodType: string;
  if (!selectionMethodGiven) {
    if (p.selectionMethodType !== undefined && p.selectionMethodType !== "") {
      throw new AbapError(
        "BAD_INPUT",
        `selectionMethodType ${JSON.stringify(p.selectionMethodType)} was given but selectionMethod ` +
          "was not — DD30V-SELMTYPE only means something alongside a selection method; leave both " +
          "blank for a collective search help, or an elementary one driven by a search-help exit.",
        { what: "selectionMethodType", value: p.selectionMethodType },
      );
    }
    selectionMethodType = "";
  } else {
    if (typeof p.selectionMethodType !== "string" || !SELECTION_METHOD_TYPES.has(p.selectionMethodType)) {
      throw new AbapError(
        "BAD_INPUT",
        `selectionMethodType ${JSON.stringify(p.selectionMethodType)} must be one of ` +
          `${[...SELECTION_METHOD_TYPES].join(", ")} — abap-shlp.ts only special-cases "T" (table) and "V" ` +
          '(view) existence checks, and does not check anything else against the server.',
        { what: "selectionMethodType", value: p.selectionMethodType },
      );
    }
    selectionMethodType = p.selectionMethodType;
  }

  const dialogType =
    p.dialogType === undefined ? undefined : assertAbapText(p.dialogType, "dialogType", 1);
  const textTable =
    p.textTable === undefined ? undefined : assertEnhIdentifier(p.textTable, "textTable", { maxLength: SHLP_NAME_MAX });
  const hotKey = p.hotKey === undefined ? undefined : assertAbapText(p.hotKey, "hotKey", 1);

  if (typeof p.elementary !== "boolean") {
    throw new AbapError("BAD_INPUT", "elementary must be a boolean.", { what: "elementary" });
  }

  if (!Array.isArray(p.fields)) {
    throw new AbapError("BAD_INPUT", "fields must be an array.", { what: "fields" });
  }
  const fields = p.fields.map((f, i) => {
    const name = assertEnhIdentifier(f.name, `fields[${i}].name`, { maxLength: SHLP_NAME_MAX });
    const dataElement = assertEnhIdentifier(f.dataElement, `fields[${i}].dataElement`, { maxLength: SHLP_NAME_MAX });
    const defaultValue =
      f.defaultValue === undefined ? undefined : assertAbapText(f.defaultValue, `fields[${i}].defaultValue`, DEFAULT_VALUE_MAX);
    return {
      name,
      dataElement,
      import: f.import === true,
      export: f.export === true,
      ...(defaultValue !== undefined ? { defaultValue } : {}),
    };
  });

  if (p.elementary) {
    if (fields.length === 0) {
      throw new AbapError(
        "BAD_INPUT",
        "fields must be non-empty for an elementary search help (DD30V-ISSIMPLE = 'X') — DDIF_SHLP_PUT " +
          "needs at least one import and one export parameter.",
        { shlpName },
      );
    }
    if (!fields.some((f) => f.import) || !fields.some((f) => f.export)) {
      throw new AbapError(
        "BAD_INPUT",
        "an elementary search help needs at least one field marked import and at least one marked " +
          "export — abap-shlp.ts refuses this at runtime too, but this fails before any network call.",
        { shlpName, fields },
      );
    }
  }

  const includes = (p.includes ?? []).map((inc, i) => ({
    name: assertEnhIdentifier(inc.name, `includes[${i}].name`, { maxLength: SHLP_NAME_MAX }),
  }));

  if (!p.elementary && includes.length === 0) {
    throw new AbapError(
      "BAD_INPUT",
      "includes must be a non-empty array when elementary: false — a collective search help with " +
        "no included helps has nothing to collect.",
      { what: "includes", elementary: false },
    );
  }

  const assignments = (p.assignments ?? []).map((a, i) => {
    const field = assertEnhIdentifier(a.field, `assignments[${i}].field`, { maxLength: SHLP_NAME_MAX });
    const includedHelp = assertEnhIdentifier(a.includedHelp, `assignments[${i}].includedHelp`, { maxLength: SHLP_NAME_MAX });
    const includedField = assertEnhIdentifier(a.includedField, `assignments[${i}].includedField`, { maxLength: SHLP_NAME_MAX });
    if (typeof a.direction !== "string" || !ASSIGNMENT_DIRECTIONS.has(a.direction)) {
      throw new AbapError(
        "BAD_INPUT",
        `assignments[${i}].direction ${JSON.stringify(a.direction)} must be one of ` +
          `${[...ASSIGNMENT_DIRECTIONS].join(", ")} (DD33V-VALUEDIREC).`,
        { what: `assignments[${i}].direction`, value: a.direction },
      );
    }
    return { field, includedHelp, includedField, direction: a.direction };
  });

  return {
    shlpName,
    description,
    packageName,
    corrNr,
    corrSource: p.corrSource,
    selectionMethod,
    selectionMethodType,
    dialogType,
    textTable,
    hotKey,
    elementary: p.elementary,
    fields,
    includes,
    assignments,
  };
}

/**
 * Builds the fluid action's `args` object from validated params, omitting
 * undefined keys — `runClassicAction`'s contract. `fields`, `includes` and
 * `assignments` are handed over here as the honest, caller-facing NESTED
 * arrays of objects the `classic` manifest declares (and validates
 * against) — the flat `key/{i}/{prop}` wire shape `abap-shlp.ts` actually
 * reads is produced downstream, in the dispatcher, by `flattenScanArgs`
 * (`src/adt/fluid/flat-args.ts`), because the `classic` manifest sets
 * `flatArgs: true`. This function must not pre-flatten: the dispatcher
 * validates `args` against the declared (nested) schema before flattening,
 * so a flattened object here would fail validation with e.g.
 * "args.fields: must be an array".
 */
export function buildArgs(v: ValidatedSearchHelp): Record<string, unknown> {
  return {
    shlp_name: v.shlpName,
    description: v.description,
    package_name: v.packageName,
    corr_nr: v.corrNr ?? "",
    selection_method: v.selectionMethod,
    selection_method_type: v.selectionMethodType,
    ...(v.dialogType !== undefined ? { dialog_type: v.dialogType } : {}),
    ...(v.textTable !== undefined ? { text_table: v.textTable } : {}),
    ...(v.hotKey !== undefined ? { hot_key: v.hotKey } : {}),
    elementary: v.elementary,
    fields: v.fields.map((f) => ({
      name: f.name,
      data_element: f.dataElement,
      import: f.import ?? false,
      export: f.export ?? false,
      ...(f.defaultValue !== undefined ? { default_value: f.defaultValue } : {}),
    })),
    includes: v.includes.map((inc) => ({ name: inc.name })),
    assignments: v.assignments.map((a) => ({
      field: a.field,
      included_help: a.includedHelp,
      included_field: a.includedField,
      direction: a.direction,
    })),
  };
}

const SHLP_EXPECT_TAGS: DdicTag[] = ["SHLP-REGISTERED", "SHLP-PUT", "SHLP-ACTIVATED"];

function corrOf(local: boolean, corrNr: string | undefined, corrSource: "named" | "auto" | undefined): SafetyCorr | undefined {
  return local ? undefined : { kind: "transport", corrNr: corrNr as string, source: corrSource ?? "named" };
}

/**
 * Create one search help: validate, gate the SHLP, then dispatch
 * `create_search_help` and assert the transcript. Same ordering discipline
 * as {@link createClassicView} in `view-create.ts`: `validate()` first
 * (`BAD_INPUT`/`TRANSPORT_ERROR` before anything else), then
 * {@link assertBridgeMutation} zero-network, only then
 * {@link runClassicAction}.
 */
export async function createSearchHelp(
  conn: AbapConnection,
  gate: SafetyGate,
  params: SearchHelpParams,
): Promise<{ run: RunResult; transcript: DdicTranscript }> {
  assertServerPackage(params.packageName, `search help ${params.shlpName}`);
  const v = validate(params.packageName.name, params);
  const local = isLocalPackageName(v.packageName);

  assertBridgeMutation(
    gate,
    { type: "SHLP/DH", name: v.shlpName, packageName: v.packageName },
    { activate: true, ...(corrOf(local, v.corrNr, v.corrSource) !== undefined ? { corr: corrOf(local, v.corrNr, v.corrSource)! } : {}) },
  );

  return runClassicAction(conn, gate, {
    action: "create_search_help",
    args: buildArgs(v),
    what: `Creating search help ${v.shlpName}`,
    expectTags: SHLP_EXPECT_TAGS,
  });
}

/**
 * Update an EXISTING search help: same validation and gating discipline as
 * {@link createSearchHelp}, dispatching `update_search_help` instead.
 * `DDIF_SHLP_PUT` replaces the whole definition — `abap-shlp.ts`'s
 * `update_search_help` method emits a `ZMCP-DDIC-NOTE>` line saying so, and
 * every interface parameter, include and assignment the caller wants to keep
 * must be passed again here.
 */
export async function updateSearchHelp(
  conn: AbapConnection,
  gate: SafetyGate,
  params: SearchHelpParams,
): Promise<{ run: RunResult; transcript: DdicTranscript }> {
  assertServerPackage(params.packageName, `search help ${params.shlpName}`);
  const v = validate(params.packageName.name, params);
  const local = isLocalPackageName(v.packageName);

  assertBridgeMutation(
    gate,
    { type: "SHLP/DH", name: v.shlpName, packageName: v.packageName },
    { activate: true, ...(corrOf(local, v.corrNr, v.corrSource) !== undefined ? { corr: corrOf(local, v.corrNr, v.corrSource)! } : {}) },
  );

  return runClassicAction(conn, gate, {
    action: "update_search_help",
    args: buildArgs(v),
    what: `Updating search help ${v.shlpName}`,
    expectTags: SHLP_EXPECT_TAGS,
  });
}
