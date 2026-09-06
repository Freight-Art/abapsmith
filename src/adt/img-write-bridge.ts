/**
 * IMG (SPRO customizing) row write. Reading the IMG catalog no longer needs
 * a generated bridge (`src/adt/img-read.ts` reads straight through the
 * freestyle data-preview endpoint), but writing still does — ADT has no IMG
 * REST route, only classic function-module plumbing — so this module keeps
 * the generated `IF_OO_ADT_CLASSRUN` class delivery mechanism, touching a
 * base customizing table's own data rather than a catalog table. Deployed
 * into `HELPER_PACKAGE` (`src/adt/helper-package.ts`), not `$TMP` — the
 * owner rule for bridge/helper classes going forward.
 *
 * Two fixed classes: `ZCL_ZMCP_IMG_WPROBE` (read-only: T000 flags, the base
 * table's DD02L/DD03L shape, before-image rows for caller-supplied keys) and
 * `ZCL_ZMCP_IMG_WAPPLY` (writes: records the CTS transport key, then
 * MODIFY/DELETEs rows, commits, and re-reads the after-image).
 *
 * Every statement below is STATICALLY typed ABAP: table and field names are
 * baked into the generated source at TypeScript-generation time
 * (`DATA ls_wa TYPE t001.`, `ls_wa-butxt = '...'.`, `MODIFY t001 FROM
 * ls_wa.`) — never `CREATE DATA ... TYPE (lv_tab)` or `MODIFY (lv_tab)`.
 * This is the whole safety argument: a wrong field name is a syntax error
 * at class activation, before a single row is touched; a wrong data type is
 * a syntax error too, not a silent truncation of whatever the caller typed.
 * Each row is unrolled into its own block of generated statements (not a
 * runtime loop over a shared work area) precisely so that which fields a
 * given row assigns is fixed at generation time, not decided by data at
 * runtime — the one place that would otherwise tempt something dynamic.
 *
 * Neither `img-resolve.ts` nor `img-write-policy.ts` is imported here — this
 * module only generates ABAP source and parses its transcript; the caller
 * plan (table, keys, rows) is expected to already be resolved and allowed by
 * those modules elsewhere.
 */

import { AbapError } from "./errors.js";
import { ddicBridgeSource, DDIC_ERR_PREFIX } from "./ddic-bridge.js";
import { ERR_LINE_PREFIX, parseBracketFields } from "./run.js";
import { abapLiteral, assertAbapText } from "./enhancement-templates.js";
import { assertTrkorr } from "./transports.js";
import { assertImgLanguage } from "./img-query.js";

export const IMGW_LINE_PREFIX = "IMGW> ";

/** Fixed class names — never generated or caller-influenced. */
export const IMGW_BRIDGE_CLASS = {
  probe: "ZCL_ZMCP_IMG_WPROBE",
  apply: "ZCL_ZMCP_IMG_WAPPLY",
} as const;

export const IMGW_MAX_ROWS = 50;

/**
 * The CTS bookkeeping call this module generates. Measured 2026-09-05
 * against a live A4H appliance's `FUPARAREF` for function group `SAPLSTRD` —
 * `confidence: "high"`. Repointing after a future finding is a one-object
 * edit: this record, nothing that calls it.
 *
 * Two calls, in order: `TR_OBJECTS_CHECK` then `TR_OBJECTS_INSERT` — the
 * insert FM's own long text requires the check FM to have already run for
 * an object being edited for the first time, and both wrap
 * `TRINT_OBJECTS_CHECK_AND_INSERT` with `iv_with_dialog = 'X'`, so both are
 * dialog-capable and both need the two suppressor flags to run headless in
 * a classrun. The objects table is `wt_ko200` (`TABLES`, type `KO200` —
 * `INCLUDE E071` plus `AUTHOR`/`DEVCLASS`/`GENFLAG`/`MASTERLANG`/
 * `OPERATION`/`EDTFLAG`), not `E071` itself; the keys table is `wt_e071k`
 * (`TABLES`, type `E071K`). `wi_order` only exists on the insert FM — the
 * check FM has no order parameter to check against.
 *
 * `TR_APPEND_TO_COMM_OBJS_KEYS` also exists (was one of the three
 * candidates considered before this run) but its own long text calls it
 * obsolete, so it is deliberately not used here.
 */
export const CTS_INSERT_FM = Object.freeze({
  checkFm: "TR_OBJECTS_CHECK",
  insertFm: "TR_OBJECTS_INSERT",
  params: Object.freeze({
    order: "wi_order",
    noStandardEditor: "iv_no_standard_editor",
    noShowOption: "iv_no_show_option",
    objects: "wt_ko200",
    keys: "wt_e071k",
    /**
     * `TR_OBJECTS_INSERT`-only exports (`TRKORR`-typed): CTS may record the
     * object into a *task* beneath the requested order rather than the
     * order itself, so `weOrder`/`weTask` are what was actually chosen, not
     * necessarily what `order` (`wi_order`) above asked for. Not present on
     * `TR_OBJECTS_CHECK` — that FM never files anything, so it has nothing
     * to report back.
     */
    weOrder: "we_order",
    weTask: "we_task",
  }),
  exceptions: Object.freeze({
    cancelEditOtherError: "cancel_edit_other_error",
    showOnlyOtherError: "show_only_other_error",
  }),
  confidence: "high",
  note:
    "UNPROVEN FROM HERE: TR_OBJECTS_CHECK and TR_OBJECTS_INSERT are ordinary, heavily-used standard " +
    "SAP function modules — SM30 and the rest of CTS call them constantly — but this server has never " +
    "itself called either one, on this or any system. What was read live on 2026-09-05 is FUPARAREF " +
    "(parameter lists), DOKTL (long texts), the FMs' own source, and real E071/E071K rows — not a " +
    "successful or failed call from here. The parameter names, types and the check-then-insert " +
    "ordering here are read from the system's own dictionaries, not confirmed by a call this server " +
    "has made; the first time this generated code actually runs is also the first time this server " +
    "learns whether its own call is accepted — a runtime refusal on authority, lock, or request type " +
    "is unproven territory from this server's side, which is exactly why the exception names and " +
    "sy-msg* capture below exist. Measured shape: objects table is WT_KO200 (type KO200), not " +
    "WT_E071/E071; TR_OBJECTS_CHECK must run before TR_OBJECTS_INSERT; IV_NO_STANDARD_EDITOR and " +
    "IV_NO_SHOW_OPTION must both be 'X' on both calls to suppress the dialog; both raise " +
    "CANCEL_EDIT_OTHER_ERROR and SHOW_ONLY_OTHER_ERROR, the latter carrying the real reason in " +
    "sy-msg*. TR_APPEND_TO_COMM_OBJS_KEYS also exists but its own long text calls it obsolete — " +
    "deliberately not used.",
} as const);

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

export interface ImgWriteField {
  readonly field: string;
  readonly key: boolean;
  readonly dataType: string;
}

export interface ImgWriteRow {
  readonly key: Readonly<Record<string, string>>;
  readonly values: Readonly<Record<string, string>>;
}

export interface ImgProbePlan {
  readonly table: string;
  readonly clientField: string;
  readonly keyFields: readonly string[];
  readonly rows: readonly ImgWriteRow[];
  readonly language: string;
}

export interface ImgApplyPlan extends ImgProbePlan {
  readonly op: "upsert" | "delete";
  readonly fields: readonly ImgWriteField[];
  readonly corrNr?: string;
  /**
   * DD02L-CONTFLAG / CLIDEP as read at probe time. Not in the brief's
   * original sketch of this interface — added because generation rule 6
   * ("abort if the delivery class or client dependence changed since the
   * probe") needs something from the probe to compare the apply-time re-read
   * against, and nothing else in this plan carries it. Which classes are
   * actually writable (C/G/E) is `img-write-policy.ts`'s call, made before
   * this plan is ever built; this module only detects DRIFT from what that
   * decision was made against.
   */
  readonly expectedDeliveryClass: string;
  readonly expectedClientDependent: boolean;
  /**
   * The maintenance view recording this write in the CTS: the `KO200`
   * header row's `OBJ_NAME` and the `E071K` row's `MASTERNAME`/`VIEWNAME`
   * (see {@link CTS_INSERT_FM}). Required — there is no other name to put
   * there for an SM30-style customizing write.
   */
  readonly view: string;
  /**
   * `KO200`/`E071K`'s `OBJECT`/`MASTERTYPE`: `VDAT` for a maintenance view
   * (the common case — `V_TB001` in the measured evidence), `CDAT` for a
   * customizing object recorded directly (`/AIF/ACTIONS` in the measured
   * evidence).
   */
  readonly masterType: "VDAT" | "CDAT";
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const DDIC_IDENTIFIER_RE = /^[A-Za-z0-9_/]{1,30}$/;

function assertDdicIdentifier(value: string, what: string): string {
  if (typeof value !== "string" || !DDIC_IDENTIFIER_RE.test(value)) {
    throw new AbapError(
      "BAD_INPUT",
      `${what} ${JSON.stringify(value)} must be 1-30 characters of letters, digits, underscore or "/".`,
      { what, value },
    );
  }
  return value;
}

/**
 * A row field value is embedded as an ABAP string literal via
 * {@link abapLiteral} (quote-doubling only), never inside a `|...{ }...|`
 * template — so the one thing that can actually corrupt the generated
 * source is a raw control character (a literal newline breaks the line the
 * assignment sits on; ABAP has no escape for it inside `'...'`).
 * {@link assertAbapText} is `enhancement-templates.ts`'s existing check for
 * exactly this, reused rather than re-implemented; the length cap here is
 * this module's own, not that function's default.
 */
function assertRowValue(value: string, what: string): string {
  return assertAbapText(value, what, 200);
}

function assertSingleCharCode(value: string, what: string): string {
  const v = (value ?? "").trim();
  if (!/^[A-Za-z0-9]{0,4}$/.test(v)) {
    throw new AbapError("BAD_INPUT", `${what} ${JSON.stringify(value)} is not a plain DDIC code.`, { what, value });
  }
  return v;
}

export function validateProbePlan(p: ImgProbePlan): void {
  assertDdicIdentifier(p.table, "table");
  const clientField = assertDdicIdentifier(p.clientField, "clientField").toUpperCase();
  assertImgLanguage(p.language);

  if (p.keyFields.length < 1) {
    throw new AbapError("BAD_INPUT", `${p.table} needs at least one key field.`, { table: p.table });
  }
  const keyFieldsUpper = p.keyFields.map((f) => assertDdicIdentifier(f, "keyField").toUpperCase());
  if (keyFieldsUpper.includes(clientField)) {
    throw new AbapError(
      "BAD_INPUT",
      `key_fields must not include the client field ${p.clientField} — it always comes from sy-mandt, never from the caller.`,
      { clientField: p.clientField },
    );
  }
  const dupKey = keyFieldsUpper.find((f, i) => keyFieldsUpper.indexOf(f) !== i);
  if (dupKey) {
    throw new AbapError("BAD_INPUT", `key_fields lists ${dupKey} more than once.`, { field: dupKey });
  }

  if (p.rows.length < 1) {
    throw new AbapError("BAD_INPUT", "at least one row is required.", {});
  }
  if (p.rows.length > IMGW_MAX_ROWS) {
    throw new AbapError(
      "BAD_INPUT",
      `${p.rows.length} rows exceeds the ${IMGW_MAX_ROWS}-row limit for one call.`,
      { count: p.rows.length },
    );
  }

  p.rows.forEach((row, i) => {
    const keyNames = Object.keys(row.key).map((k) => k.toUpperCase());
    for (const kf of keyFieldsUpper) {
      if (!keyNames.includes(kf)) {
        throw new AbapError(
          "BAD_INPUT",
          `row ${i} does not supply key field ${kf} — every key field must be named, a delete can never widen its own key.`,
          { row: i, field: kf },
        );
      }
    }
    for (const name of Object.keys(row.key)) {
      const upper = name.toUpperCase();
      if (upper === clientField) {
        throw new AbapError(
          "BAD_INPUT",
          `row ${i} supplies a value for the client field ${name} — it always comes from sy-mandt, never from the caller.`,
          { row: i, field: name },
        );
      }
      if (!keyFieldsUpper.includes(upper)) {
        throw new AbapError(
          "BAD_INPUT",
          `row ${i} names key field ${name}, which is not one of this plan's key_fields.`,
          { row: i, field: name },
        );
      }
      assertRowValue(row.key[name]!, `row ${i} key ${name}`);
    }
  });
}

export function validateApplyPlan(p: ImgApplyPlan): void {
  validateProbePlan(p);
  const clientField = assertDdicIdentifier(p.clientField, "clientField").toUpperCase();

  if (p.op !== "upsert" && p.op !== "delete") {
    throw new AbapError("BAD_INPUT", `op must be "upsert" or "delete".`, { op: p.op });
  }

  assertSingleCharCode(p.expectedDeliveryClass, "expectedDeliveryClass");
  if (typeof p.expectedClientDependent !== "boolean") {
    throw new AbapError("BAD_INPUT", "expectedClientDependent must be a boolean.", {});
  }

  assertDdicIdentifier(p.view, "view");
  if (p.masterType !== "VDAT" && p.masterType !== "CDAT") {
    throw new AbapError("BAD_INPUT", `master_type must be "VDAT" or "CDAT".`, { masterType: p.masterType });
  }

  const fieldNamesUpper = new Set<string>();
  for (const f of p.fields) {
    const name = assertDdicIdentifier(f.field, "field").toUpperCase();
    if (name === clientField) {
      throw new AbapError(
        "BAD_INPUT",
        `field ${f.field} is the client field — it always comes from sy-mandt, and cannot be declared as a writable field.`,
        { field: f.field },
      );
    }
    fieldNamesUpper.add(name);
  }

  if (p.corrNr !== undefined) {
    assertTrkorr(p.corrNr, "imgApplyPlan");
  }

  p.rows.forEach((row, i) => {
    const valueNames = Object.keys(row.values);
    // A zero-value-field upsert row is legal: SM30 itself accepts a key-only row on a table whose
    // every non-key column is optional (e.g. TB004, key BPKIND, seven optional FELDSTLSTn lists) —
    // if the row is absent it is inserted with just the key (and client) set and everything else
    // left initial; if it is already present, upserting it with no values is a no-op. There is
    // nothing here for this validator to reject.
    for (const name of valueNames) {
      const upper = name.toUpperCase();
      if (upper === clientField) {
        throw new AbapError(
          "BAD_INPUT",
          `row ${i} supplies a value for the client field ${name} — it always comes from sy-mandt, never from the caller.`,
          { row: i, field: name },
        );
      }
      if (!fieldNamesUpper.has(upper)) {
        throw new AbapError(
          "BAD_INPUT",
          `row ${i} names value field ${name}, which is not declared in this plan's fields.`,
          { row: i, field: name },
        );
      }
      assertRowValue(row.values[name]!, `row ${i} value ${name}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Shared ABAP fragments
// ---------------------------------------------------------------------------

/** T000 fields actually confirmed live elsewhere in this codebase (`system-role.ts`'s `T000_QUERY`) — MANDT, CCCATEGORY, CCCORACTIV. No fourth field is added on the strength of an example alone. */
const T000_FIELDS = { mandt: "mandt", cccategory: "cccategory", cccoractiv: "cccoractiv" } as const;

const DD02L_FIELDS = { table: "tabname", delclass: "contflag", clidep: "clidep", active: "as4local" } as const;

/**
 * RTTI dump of every component of `ls_wa` (a work area statically typed off
 * the real table) — the one place this module inspects field names it did
 * not itself declare, and only to format OUTPUT. It does not touch the
 * SELECT/MODIFY/DELETE targets, which stay literal table/field names decided
 * at generation time; RTTI here never drives what gets read or written.
 * `lo_descr`/`lo_struct`/`ls_comp`/`<fs_val>`/`lv_fval` are declared once,
 * at the top of the generated method, and reused by plain assignment on
 * every call of this fragment — inline `DATA(...)`/`FIELD-SYMBOL(...)`
 * cannot be redeclared in the same scope, and this fragment is emitted once
 * per row, sometimes twice per row (before- and after-image).
 */
function dumpRowFragment(tag: "BVAL" | "AVAL", rowLiteral: number): string[] {
  return [
    "lo_descr = cl_abap_typedescr=>describe_by_data( ls_wa ).",
    "lo_struct = CAST cl_abap_structdescr( lo_descr ).",
    "lt_comp = lo_struct->get_components( ).",
    "LOOP AT lt_comp INTO ls_comp.",
    "  ASSIGN COMPONENT ls_comp-name OF STRUCTURE ls_wa TO <fs_val>.",
    "  IF sy-subrc <> 0.",
    "    CONTINUE.",
    "  ENDIF.",
    "  lv_fval = |{ <fs_val> }|.",
    `  out->write( |${IMGW_LINE_PREFIX}${tag} row=[${rowLiteral}] field=[{ ls_comp-name }] | &&`,
    "    |len=[{ strlen( lv_fval ) }] value=[{ lv_fval }]| ).",
    "ENDLOOP.",
  ];
}

/** `T000` read + emit, common to both classes. Aborts (writes a `ZMCP-DDIC-ERR>` line and `RETURN`s) on `CCCORACTIV = '2'` — SAP's own "client-dependent customizing blocked outright in this client" state. This is a narrow ABAP-side backstop, not a substitute for the fuller `img-write-policy.ts` evaluation that runs before this bridge is ever deployed. */
function clientCheckFragment(): string[] {
  return [
    `SELECT SINGLE ${T000_FIELDS.mandt}, ${T000_FIELDS.cccategory}, ${T000_FIELDS.cccoractiv} FROM t000`,
    `  INTO (@DATA(lv_mandt), @DATA(lv_cccategory), @DATA(lv_cccoractiv))`,
    `  WHERE ${T000_FIELDS.mandt} = @sy-mandt.`,
    "IF sy-subrc <> 0.",
    `  out->write( |${DDIC_ERR_PREFIX} T000 read failed for client { sy-mandt }| ).`,
    "  RETURN.",
    "ENDIF.",
    `out->write( |${IMGW_LINE_PREFIX}CLIENT mandt=[{ lv_mandt }] cccategory=[{ lv_cccategory }] cccoractiv=[{ lv_cccoractiv }]| ).`,
    "IF lv_cccoractiv = '2'.",
    `  out->write( |${DDIC_ERR_PREFIX} T000-CCCORACTIV = 2 for client { sy-mandt }: client-dependent customizing changes are blocked outright in this client.| ).`,
    "  RETURN.",
    "ENDIF.",
  ];
}

/** `DD02L` read + emit for `table`. Returns the body lines and the two local variable names the caller reads to see the just-fetched values (for the apply side's TOCTOU comparison). */
function ddicTableCheckFragment(tableLower: string, tableLit: string): string[] {
  return [
    `SELECT SINGLE ${DD02L_FIELDS.delclass}, ${DD02L_FIELDS.clidep} FROM dd02l`,
    `  INTO (@DATA(lv_delclass), @DATA(lv_clidep))`,
    `  WHERE ${DD02L_FIELDS.table} = '${tableLit}' AND ${DD02L_FIELDS.active} = 'A'.`,
    "IF sy-subrc <> 0.",
    `  out->write( |${DDIC_ERR_PREFIX} DD02L read failed for ${tableLower}| ).`,
    "  RETURN.",
    "ENDIF.",
    `out->write( |${IMGW_LINE_PREFIX}TABLE table=[${tableLower}] delclass=[{ lv_delclass }] clidep=[{ lv_clidep }]| ).`,
  ];
}

function whereOnKeys(keyFields: readonly string[], row: ImgWriteRow): string {
  return keyFields.map((f) => `${f.toLowerCase()} = ${abapLiteral(row.key[f]!)}`).join(" AND ");
}

// ---------------------------------------------------------------------------
// PROBE
// ---------------------------------------------------------------------------

export function imgProbeSource(p: ImgProbePlan): string {
  validateProbePlan(p);
  const tableLower = p.table.toLowerCase();
  const tableLit = p.table.toUpperCase();

  const body: string[] = [
    "DATA lo_descr TYPE REF TO cl_abap_typedescr.",
    "DATA lo_struct TYPE REF TO cl_abap_structdescr.",
    "DATA ls_comp TYPE abap_componentdescr.",
    "DATA lt_comp TYPE cl_abap_structdescr=>component_table.",
    "FIELD-SYMBOLS <fs_val> TYPE any.",
    "DATA lv_fval TYPE string.",
    `DATA ls_wa TYPE ${tableLower}.`,
    // Declared once here, not inline in the per-key-field loop below: that loop runs once per
    // key field, so an inline @DATA(...) declaration on the SELECT would be a duplicate
    // declaration for any table with more than one key field (every text table, e.g. TB004T).
    // Measured live 2026-09-06: activation of the generated probe failed with
    // `"LV_KEY_FLAG" was already declared.` on exactly this shape.
    "DATA lv_key_flag TYPE dd03l-keyflag.",
    "DATA lv_key_type TYPE dd03l-datatype.",
    "DATA lv_key_len TYPE dd03l-leng.",
    "DATA lv_key_roll TYPE dd03l-rollname.",
    "",
    ...clientCheckFragment(),
    "",
    ...ddicTableCheckFragment(tableLower, tableLit),
    "",
  ];

  for (const kf of p.keyFields) {
    const kfLit = kf.toUpperCase();
    body.push(
      // CLEARed before every SELECT so a key field not found in DD03L (sy-subrc <> 0, which
      // the IF below already guards) cannot leave a previous field's values behind to be
      // printed under this field's name — defensive, since the guard already prevents it.
      "CLEAR: lv_key_flag, lv_key_type, lv_key_len, lv_key_roll.",
      `SELECT SINGLE keyflag, datatype, leng, rollname FROM dd03l`,
      `  INTO (@lv_key_flag, @lv_key_type, @lv_key_len, @lv_key_roll)`,
      `  WHERE tabname = '${tableLit}' AND fieldname = '${kfLit}' AND as4local = 'A'.`,
      "IF sy-subrc = 0.",
      `  out->write( |${IMGW_LINE_PREFIX}FLD table=[${tableLower}] field=[${kf.toLowerCase()}] key=[{ lv_key_flag }] | &&`,
      `    |type=[{ lv_key_type }] len=[{ lv_key_len }] rollname=[{ lv_key_roll }]| ).`,
      "ENDIF.",
      "",
    );
  }

  p.rows.forEach((row, i) => {
    const rowNo = i + 1;
    body.push(
      "CLEAR ls_wa.",
      `SELECT SINGLE * FROM ${tableLower} INTO @ls_wa WHERE ${whereOnKeys(p.keyFields, row)}.`,
      "IF sy-subrc <> 0.",
      `  out->write( |${IMGW_LINE_PREFIX}BABSENT row=[${rowNo}]| ).`,
      "ELSE.",
      ...dumpRowFragment("BVAL", rowNo).map((l) => "  " + l),
      "ENDIF.",
      "",
    );
  });

  body.push(`out->write( |${IMGW_LINE_PREFIX}PROBED rows=[${p.rows.length}]| ).`);

  return ddicBridgeSource(IMGW_BRIDGE_CLASS.probe, [], body);
}

// ---------------------------------------------------------------------------
// APPLY
// ---------------------------------------------------------------------------

/**
 * Records the CTS key for one row via {@link CTS_INSERT_FM}, immediately
 * before the caller writes that row — generation rule 6's ordering. Emitted
 * only when `corrNr` is given; a plan with no `corrNr` skips CTS bookkeeping
 * entirely rather than guessing a transport, and the row write proceeds (or
 * is refused by the real system if one turns out to be required).
 *
 * `KO200` header (one row: `PGMID R3TR`, `OBJECT` = `masterType`, `OBJ_NAME`
 * = `view`, `OBJFUNC K`) plus one `E071K` row per row written (`PGMID
 * R3TR`, `OBJECT TABU`, `OBJNAME` = base table, `MASTERTYPE` = `masterType`,
 * `MASTERNAME`/`VIEWNAME` = `view`, `OBJFUNC` blank) — the shape SM30 itself
 * records for view-maintained customizing, per the measured evidence in
 * {@link CTS_INSERT_FM}.
 *
 * The key structure (`ls_key`) is typed off the table's own key fields only
 * — client excluded — and cast to a character string with `ASSIGN ...
 * CASTING TYPE c`; this cast is sound only when every component of
 * `ls_key` is character-like (CHAR/NUMC/CLNT/LANG/UNIT/...): a `P` or `X`
 * component would cast to raw bytes, not the padded text SAP expects in
 * `TABKEY`. This module does not check key field data types — that check
 * belongs to `img-write-policy.ts` (rule 8 there), run before a plan ever
 * reaches this generator. `TABKEY` itself is `sy-mandt` (client) followed by
 * the cast key: `ls_key` never carries the client field, so nothing here
 * would double it.
 *
 * `TR_OBJECTS_CHECK` runs first — required before an object's first edit —
 * then `TR_OBJECTS_INSERT`; both take the same suppressor flags and both
 * name `CANCEL_EDIT_OTHER_ERROR`/`SHOW_ONLY_OTHER_ERROR` as distinct
 * exceptions so a lock conflict's real reason (`sy-msg*`) survives into the
 * transcript instead of being collapsed into a bare `sy-subrc`.
 *
 * `TR_OBJECTS_INSERT` also exports `WE_ORDER`/`WE_TASK` — what CTS actually
 * recorded the object under, which may be a task beneath the requested
 * order rather than the order itself. Both are captured (`lv_we_order`,
 * `lv_we_task`, declared once by the caller, typed `trkorr` — this file's
 * existing convention for a transport number, e.g. `transport-entry-remove.ts`)
 * and appended to the `TRKEY` transcript line alongside the requested
 * number, each behind its own `len=[n] value=[...]` guard — the same
 * discipline the line's existing `value=[...]` already uses — so a
 * divergence between requested and recorded is visible to a caller
 * re-reading the request afterward, rather than assumed away.
 *
 * Both `CALL FUNCTION`s are wrapped in one `TRY`/`ENDTRY`, catching
 * `cx_sy_dyn_call_illegal_type`/`cx_sy_dyn_call_param_missing` (a
 * `TABLES`-formal-vs-actual mismatch — measured live 2026-09-06 against
 * `wt_ko200`/`wt_e071k` declared `WITH EMPTY KEY`, see the `lt_ko200`/
 * `lt_e071k` declarations in `imgApplySource`) ahead of a generic `cx_root`
 * catch, so a runtime failure here becomes its own attributed `IMGW> ERROR`
 * transcript line instead of only the unattributed `ZMCP-DDIC-ERR>` line
 * `ddicBridgeSource`'s outer `CATCH cx_root` already prints for anything
 * uncaught. `lx_cts`/`lo_exc_type`/`lv_exc_class`/`lv_exc_text` are declared
 * once in `imgApplySource`'s `body`, not here — this fragment runs once per
 * row, and an inline `CATCH ... INTO DATA(lx)` would be a duplicate
 * declaration on a second row.
 */
function ctsRecordFragment(
  tableLower: string,
  tableLit: string,
  corrNr: string,
  rowNo: number,
  view: string,
  masterType: "VDAT" | "CDAT",
): string[] {
  const corrLit = abapLiteral(corrNr);
  const viewLit = view.toUpperCase();
  const P = CTS_INSERT_FM.params;
  const X = CTS_INSERT_FM.exceptions;

  const errorLines = (fm: string): string[] => [
    "IF sy-subrc <> 0.",
    `  out->write( |${DDIC_ERR_PREFIX} ${fm} failed for row ${rowNo} on ${tableLower}, sy-subrc={ sy-subrc } | &&`,
    `    |msgid=[{ sy-msgid }] msgty=[{ sy-msgty }] msgno=[{ sy-msgno }] msgv1=[{ sy-msgv1 }] | &&`,
    `    |msgv2=[{ sy-msgv2 }] msgv3=[{ sy-msgv3 }] msgv4=[{ sy-msgv4 }]| ).`,
    "  RETURN.",
    "ENDIF.",
  ];

  // Sets lv_exc_class/lv_exc_text and writes one IMGW> ERROR line, using the len=[n] value=[...]
  // discipline every row-carrying tag in this module already uses (a get_text() can itself
  // contain "]"). `mismatch` prefixes a wording that names this as a function-module interface
  // problem — true of both caught classes: CX_SY_DYN_CALL_ILLEGAL_TYPE and
  // CX_SY_DYN_CALL_PARAM_MISSING are both raised by CALL FUNCTION for a caller/callee interface
  // disagreement, which is exactly what a WITH EMPTY KEY vs. TABLES-formal conflict is. The
  // cx_root catch below gets no such claim — it may be nothing to do with the interface at all.
  const dynCallErrorLines = (wording: "mismatch" | "generic"): string[] => [
    "  lo_exc_type = cl_abap_typedescr=>describe_by_object_ref( lx_cts ).",
    "  lv_exc_class = lo_exc_type->get_relative_name( ).",
    wording === "mismatch"
      ? "  lv_exc_text = |function-module interface mismatch: { lx_cts->get_text( ) }|."
      : "  lv_exc_text = lx_cts->get_text( ).",
    `  out->write( |${IMGW_LINE_PREFIX}ERROR class=[{ lv_exc_class }] len=[{ strlen( lv_exc_text ) }] | &&`,
    "    |value=[{ lv_exc_text }]| ).",
    "  RETURN.",
  ];

  return [
    "CLEAR ls_ko200.",
    "ls_ko200-pgmid = 'R3TR'.",
    `ls_ko200-object = '${masterType}'.`,
    `ls_ko200-obj_name = '${viewLit}'.`,
    "ls_ko200-objfunc = 'K'.",
    "REFRESH lt_ko200.",
    "APPEND ls_ko200 TO lt_ko200.",
    "CLEAR ls_e071k.",
    "ls_e071k-pgmid = 'R3TR'.",
    "ls_e071k-object = 'TABU'.",
    `ls_e071k-objname = '${tableLit}'.`,
    `ls_e071k-mastertype = '${masterType}'.`,
    `ls_e071k-mastername = '${viewLit}'.`,
    `ls_e071k-viewname = '${viewLit}'.`,
    "ls_e071k-objfunc = ' '.",
    "ASSIGN ls_key TO <key_c> CASTING TYPE c.",
    "ls_e071k-tabkey = |{ sy-mandt }{ <key_c> }|.",
    "REFRESH lt_e071k.",
    "APPEND ls_e071k TO lt_e071k.",
    // TRY/CATCH added so a TABLES-formal/actual mismatch — measured live 2026-09-06 on this very
    // pair of calls — surfaces as its own tagged IMGW> ERROR line instead of only the generic,
    // unattributed ZMCP-DDIC-ERR> line the outer CATCH cx_root in ddicBridgeSource already prints.
    "TRY.",
    `    CALL FUNCTION '${CTS_INSERT_FM.checkFm}'`,
    "      EXPORTING",
    `        ${P.noStandardEditor} = 'X'`,
    `        ${P.noShowOption}     = 'X'`,
    "      TABLES",
    `        ${P.objects} = lt_ko200`,
    `        ${P.keys}    = lt_e071k`,
    "      EXCEPTIONS",
    `        ${X.cancelEditOtherError} = 1`,
    `        ${X.showOnlyOtherError}   = 2`,
    "        OTHERS = 3.",
    ...errorLines(CTS_INSERT_FM.checkFm).map((l) => "  " + l),
    `    CALL FUNCTION '${CTS_INSERT_FM.insertFm}'`,
    "      EXPORTING",
    `        ${P.order}            = ${corrLit}`,
    `        ${P.noStandardEditor} = 'X'`,
    `        ${P.noShowOption}     = 'X'`,
    "      IMPORTING",
    `        ${P.weOrder} = lv_we_order`,
    `        ${P.weTask} = lv_we_task`,
    "      TABLES",
    `        ${P.objects} = lt_ko200`,
    `        ${P.keys}    = lt_e071k`,
    "      EXCEPTIONS",
    `        ${X.cancelEditOtherError} = 1`,
    `        ${X.showOnlyOtherError}   = 2`,
    "        OTHERS = 3.",
    ...errorLines(CTS_INSERT_FM.insertFm).map((l) => "  " + l),
    "  CATCH cx_sy_dyn_call_illegal_type cx_sy_dyn_call_param_missing INTO lx_cts.",
    ...dynCallErrorLines("mismatch"),
    "  CATCH cx_root INTO lx_cts.",
    ...dynCallErrorLines("generic"),
    "ENDTRY.",
    `out->write( |${IMGW_LINE_PREFIX}TRKEY row=[${rowNo}] trkorr=[${corrNr}] | &&`,
    `  |order_len=[{ strlen( lv_we_order ) }] order=[{ lv_we_order }] | &&`,
    `  |task_len=[{ strlen( lv_we_task ) }] task=[{ lv_we_task }] | &&`,
    `  |len=[{ strlen( <key_c> ) }] value=[{ <key_c> }]| ).`,
  ];
}

export function imgApplySource(p: ImgApplyPlan): string {
  validateApplyPlan(p);
  const tableLower = p.table.toLowerCase();
  const tableLit = p.table.toUpperCase();
  const fieldByName = new Map(p.fields.map((f) => [f.field.toUpperCase(), f]));

  const keyDataLines = p.keyFields.map((kf) => `  ${kf.toLowerCase()} TYPE ${tableLower}-${kf.toLowerCase()},`);

  const body: string[] = [
    "DATA lo_descr TYPE REF TO cl_abap_typedescr.",
    "DATA lo_struct TYPE REF TO cl_abap_structdescr.",
    "DATA ls_comp TYPE abap_componentdescr.",
    "DATA lt_comp TYPE cl_abap_structdescr=>component_table.",
    "FIELD-SYMBOLS <fs_val> TYPE any.",
    "DATA lv_fval TYPE string.",
    `DATA ls_wa TYPE ${tableLower}.`,
    "DATA: BEGIN OF ls_key,",
    ...keyDataLines,
    "END OF ls_key.",
    "FIELD-SYMBOLS <key_c> TYPE c.",
    "DATA ls_ko200 TYPE ko200.",
    // wt_ko200/wt_e071k (CTS_INSERT_FM.params.objects/keys) are TABLES formal parameters on
    // TR_OBJECTS_CHECK/TR_OBJECTS_INSERT — a classic TABLES formal is a standard table with the
    // DEFAULT key, and passing a WITH EMPTY KEY actual there is a runtime type conflict
    // (CALL_FUNCTION_CONFLICT_TAB_TYP, catchable as CX_SY_DYN_CALL_ILLEGAL_TYPE) that ADT's
    // activation syntax check does not catch. Measured live 2026-09-06: ZCL_ZMCP_IMG_WAPPLY
    // activated and ran, then threw exactly this exception ("not handled locally or declared in
    // a RAISING clause") at the TR_OBJECTS_CHECK call, before any row was written. WITH DEFAULT
    // KEY is the standard fix for a TABLES actual; not itself re-verified live as of this change.
    "DATA lt_ko200 TYPE STANDARD TABLE OF ko200 WITH DEFAULT KEY.",
    "DATA ls_e071k TYPE e071k.",
    "DATA lt_e071k TYPE STANDARD TABLE OF e071k WITH DEFAULT KEY.",
    "DATA lv_we_order TYPE trkorr.",
    "DATA lv_we_task TYPE trkorr.",
    // Declared once here, not inside ctsRecordFragment: that fragment is emitted once per row, so
    // an inline DATA(lx)-style CATCH declaration would be a duplicate-declaration syntax error on
    // any plan with more than one row. describe_by_object_ref/get_relative_name (not
    // cl_abap_classdescr=>get_class_name) is used to name the caught exception at runtime — the
    // oldest, most-certain RTTI path, chosen because this branch has already lost two live rounds
    // to unverified SAP API names.
    "DATA lx_cts TYPE REF TO cx_root.",
    "DATA lo_exc_type TYPE REF TO cl_abap_typedescr.",
    "DATA lv_exc_class TYPE string.",
    "DATA lv_exc_text TYPE string.",
    "",
    ...clientCheckFragment(),
    "",
    ...ddicTableCheckFragment(tableLower, tableLit),
    `IF lv_delclass <> '${p.expectedDeliveryClass.toUpperCase()}' OR boolc( lv_clidep = 'X' ) <> '${p.expectedClientDependent ? "X" : ""}'.`,
    `  out->write( |${DDIC_ERR_PREFIX} DD02L for ${tableLower} changed since the probe (delclass/clidep) — re-probe before applying.| ).`,
    "  RETURN.",
    "ENDIF.",
    "",
  ];

  // Per-row: before-image, CTS record, MODIFY/DELETE.
  p.rows.forEach((row, i) => {
    const rowNo = i + 1;
    body.push("CLEAR ls_key.");
    for (const kf of p.keyFields) {
      body.push(`ls_key-${kf.toLowerCase()} = ${abapLiteral(row.key[kf]!)}.`);
    }
    body.push(
      "CLEAR ls_wa.",
      `SELECT SINGLE * FROM ${tableLower} INTO @ls_wa WHERE ${whereOnKeys(p.keyFields, row)}.`,
    );

    if (p.op === "upsert") {
      body.push(
        "IF sy-subrc <> 0.",
        `  out->write( |${IMGW_LINE_PREFIX}BABSENT row=[${rowNo}]| ).`,
        "  CLEAR ls_wa.",
        ...p.keyFields.map((kf) => `  ls_wa-${kf.toLowerCase()} = ls_key-${kf.toLowerCase()}.`),
        "ELSE.",
        ...dumpRowFragment("BVAL", rowNo).map((l) => "  " + l),
        "ENDIF.",
        `ls_wa-${p.clientField.toLowerCase()} = sy-mandt.`,
      );
      if (p.corrNr !== undefined) {
        body.push(...ctsRecordFragment(tableLower, tableLit, p.corrNr, rowNo, p.view, p.masterType));
      }
      // Only the fields THIS row named — never the whole plan's field list, and
      // never built from scratch: ls_wa already carries the before-image (or, if
      // absent, just the key + client set above), so every other field the
      // caller did not name is preserved unchanged.
      for (const [name, value] of Object.entries(row.values)) {
        const field = fieldByName.get(name.toUpperCase());
        if (!field) continue; // validated already; unreachable
        body.push(`ls_wa-${field.field.toLowerCase()} = ${abapLiteral(value)}.`);
      }
      body.push(
        `MODIFY ${tableLower} FROM ls_wa.`,
        "IF sy-subrc <> 0.",
        `  out->write( |${DDIC_ERR_PREFIX} MODIFY failed for row ${rowNo} on ${tableLower}, sy-subrc={ sy-subrc }| ).`,
        "  RETURN.",
        "ENDIF.",
        // Marks this row's own MODIFY as done (sy-subrc 0) — not that the batch committed.
        // COMMIT WORK AND WAIT runs only after every row in the plan reaches here.
        `out->write( |${IMGW_LINE_PREFIX}WROTE row=[${rowNo}]| ).`,
      );
    } else {
      body.push(
        "IF sy-subrc <> 0.",
        `  out->write( |${IMGW_LINE_PREFIX}BABSENT row=[${rowNo}]| ).`,
        "ELSE.",
        ...dumpRowFragment("BVAL", rowNo).map((l) => "  " + l),
      );
      if (p.corrNr !== undefined) {
        body.push(...ctsRecordFragment(tableLower, tableLit, p.corrNr, rowNo, p.view, p.masterType).map((l) => "  " + l));
      }
      body.push(
        // Key work area only — DELETE FROM never widens the key with a WHERE clause.
        `  ls_wa-${p.clientField.toLowerCase()} = sy-mandt.`,
        ...p.keyFields.map((kf) => `  ls_wa-${kf.toLowerCase()} = ls_key-${kf.toLowerCase()}.`),
        `  DELETE ${tableLower} FROM ls_wa.`,
        "  IF sy-subrc <> 0.",
        `    out->write( |${DDIC_ERR_PREFIX} DELETE failed for row ${rowNo} on ${tableLower}, sy-subrc={ sy-subrc }| ).`,
        "    RETURN.",
        "  ENDIF.",
        // Same marker as the upsert side, same caveat: this row's own DELETE returned sy-subrc 0;
        // COMMIT WORK AND WAIT (below, after all rows) is what actually commits it.
        `  out->write( |${IMGW_LINE_PREFIX}WROTE row=[${rowNo}]| ).`,
        "ENDIF.",
      );
    }
    body.push("");
  });

  body.push("COMMIT WORK AND WAIT.", "");

  // Second pass: after-image.
  p.rows.forEach((row, i) => {
    const rowNo = i + 1;
    body.push(
      "CLEAR ls_wa.",
      `SELECT SINGLE * FROM ${tableLower} INTO @ls_wa WHERE ${whereOnKeys(p.keyFields, row)}.`,
      "IF sy-subrc <> 0.",
      `  out->write( |${IMGW_LINE_PREFIX}AABSENT row=[${rowNo}]| ).`,
      "ELSE.",
      ...dumpRowFragment("AVAL", rowNo).map((l) => "  " + l),
      "ENDIF.",
      "",
    );
  });

  body.push(`out->write( |${IMGW_LINE_PREFIX}APPLIED rows=[${p.rows.length}]| ).`);

  return ddicBridgeSource(IMGW_BRIDGE_CLASS.apply, [], body);
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface ImgWriteClientRow {
  mandt: string;
  cccategory: string;
  cccoractiv: string;
}

export interface ImgWriteTableRow {
  table: string;
  deliveryClass: string;
  clientDependent: boolean;
}

export interface ImgWriteFieldRow {
  table: string;
  field: string;
  key: boolean;
  dataType: string;
  length: string;
  dataElement: string;
}

export interface ImgWriteValueRow {
  row: number;
  field: string;
  len: number;
  value: string;
}

export interface ImgWriteAbsentRow {
  row: number;
}

export interface ImgWriteTrKeyRow {
  row: number;
  trkorr: string;
  len: number;
  value: string;
  /**
   * `WE_ORDER`/`WE_TASK` as `TR_OBJECTS_INSERT` actually reported them —
   * absent on an older-shaped line (before these two fields existed) or on
   * any line the generated ABAP happened to emit without them. Not the same
   * as `trkorr` above: CTS may have filed the object under a task beneath
   * the requested order rather than the order itself, so a caller comparing
   * `trkorr` against `recordedOrder`/`recordedTask` is how that divergence
   * is meant to be noticed.
   */
  recordedOrder?: string;
  recordedTask?: string;
}

export interface ImgWriteTranscript {
  client: ImgWriteClientRow | null;
  table: ImgWriteTableRow | null;
  fields: ImgWriteFieldRow[];
  before: ImgWriteValueRow[];
  beforeAbsent: ImgWriteAbsentRow[];
  trkeys: ImgWriteTrKeyRow[];
  after: ImgWriteValueRow[];
  afterAbsent: ImgWriteAbsentRow[];
  notes: string[];
  errors: string[];
  /**
   * Row numbers (1-based, same convention as every other row number in this
   * file) for which the generated ABAP's own `MODIFY`/`DELETE` returned
   * `sy-subrc 0` — i.e. an `IMGW> WROTE row=[n]` line was seen. This is NOT
   * proof the batch committed: `COMMIT WORK AND WAIT` runs only after every
   * row in the plan reaches its own `WROTE`, and the `APPLIED` marker is
   * emitted only after that commit. A caller that sees `wrote` entries but
   * no `applied` knows some row's write plausibly went through — via a
   * `sy-subrc 0` MODIFY/DELETE — even though the overall apply failed
   * somewhere after that (a later row, the commit, or the after-image read);
   * it does not know whether that write survived the commit or a rollback.
   */
  wrote: number[];
  droppedLines: number;
  probed: boolean;
  applied: number | null;
  raw: string;
}

/**
 * `len=[N]` before `value=[...]` on every row-carrying tag (BVAL/AVAL/TRKEY/
 * ERROR): a customizing field value — or an ABAP exception's `get_text( )` —
 * can itself contain `]`, which would otherwise confuse the lazy
 * `parseBracketFields` bracket match, and can carry significant trailing
 * blanks that a transport layer between the ABAP `out->write` and this
 * parser might strip.
 *
 * Deviation from a literal "slice exactly N characters after `value=[`": if
 * trailing blanks were in fact stripped upstream, that naive slice would
 * run past the real value and eat the closing `]` as data. This checks
 * whether the character at the declared length is the expected `]` first;
 * if not, it falls back to the last `]` on the line and right-pads to `len`
 * with spaces, recovering the stripped blanks instead of corrupting the
 * value. Confirmed against both a clean and a stripped-trailing-blanks case
 * in this module's own tests.
 *
 * Also returns `rest`: whatever follows the consumed `len=[...] value=[...]`
 * block. TRKEY chains this to pull further `len=[...] value=[...]`-shaped
 * fields (`order_len=`/`order=`, `task_len=`/`task=`) off the front of the
 * line before the final (and, unlike those two, mandatory) `value=[...]` —
 * ordered that way so the line's last field stays the one this function's
 * own trailing-blank fallback above already knows how to recover.
 */
function extractLenPrefixedValue(
  afterHead: string,
  fieldsRe: RegExp,
): { fields: string[]; value: string; rest: string } | null {
  const m = fieldsRe.exec(afterHead);
  if (!m) return null;
  const len = Number(m[m.length - 1]);
  if (Number.isNaN(len) || len < 0) return null;
  const tail = afterHead.slice(m[0].length);
  let raw: string;
  let consumed: number;
  if (tail.length > len && tail[len] === "]") {
    raw = tail.slice(0, len);
    consumed = len + 1;
  } else {
    const lastBracket = tail.lastIndexOf("]");
    if (lastBracket === -1) return null;
    raw = tail.slice(0, lastBracket).padEnd(len, " ");
    consumed = lastBracket + 1;
  }
  return { fields: m.slice(1), value: raw, rest: tail.slice(consumed) };
}

const VAL_RE = /^row=\[(\d+)\] field=\[([A-Za-z0-9_/]{1,30})\] len=\[(\d+)\] value=\[/;
const TRKEY_HEAD_RE = /^row=\[(\d+)\] trkorr=\[([A-Za-z0-9]{1,12})\] /;
const TRKEY_ORDER_RE = /^order_len=\[(\d+)\] order=\[/;
const TRKEY_TASK_RE = /^task_len=\[(\d+)\] task=\[/;
const TRKEY_VALUE_RE = /^len=\[(\d+)\] value=\[/;
const ABSENT_RE = /^row=\[(\d+)\]$/;
/** `get_relative_name( )`'s own charset: ABAP class/interface names, letters/digits/underscore/slash (a namespace) up to 60 chars — deliberately wider than this file's 30-char DDIC_IDENTIFIER_RE cap, since a standard exception class name is not a DDIC identifier this module generated. */
const ERROR_RE = /^class=\[([A-Za-z0-9_/]{1,60})\] len=\[(\d+)\] value=\[/;

export function parseImgWriteTranscript(text: string): ImgWriteTranscript {
  const result: ImgWriteTranscript = {
    client: null,
    table: null,
    fields: [],
    before: [],
    beforeAbsent: [],
    trkeys: [],
    after: [],
    afterAbsent: [],
    notes: [],
    errors: [],
    wrote: [],
    droppedLines: 0,
    probed: false,
    applied: null,
    raw: text,
  };

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith(IMGW_LINE_PREFIX)) {
      const rest = line.slice(IMGW_LINE_PREFIX.length);
      const spaceIdx = rest.indexOf(" ");
      const head = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
      const remainder = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1);

      switch (head) {
        case "CLIENT": {
          const fields = parseBracketFields(remainder);
          if (fields.mandt === undefined || fields.cccategory === undefined || fields.cccoractiv === undefined) {
            result.droppedLines++;
            break;
          }
          result.client = { mandt: fields.mandt, cccategory: fields.cccategory, cccoractiv: fields.cccoractiv };
          break;
        }
        case "TABLE": {
          const fields = parseBracketFields(remainder);
          if (fields.table === undefined || fields.delclass === undefined || fields.clidep === undefined) {
            result.droppedLines++;
            break;
          }
          result.table = { table: fields.table, deliveryClass: fields.delclass, clientDependent: fields.clidep === "X" };
          break;
        }
        case "FLD": {
          const fields = parseBracketFields(remainder);
          if (
            fields.table === undefined ||
            fields.field === undefined ||
            fields.key === undefined ||
            fields.type === undefined ||
            fields.len === undefined ||
            fields.rollname === undefined
          ) {
            result.droppedLines++;
            break;
          }
          result.fields.push({
            table: fields.table,
            field: fields.field,
            key: fields.key === "X",
            dataType: fields.type,
            length: fields.len,
            dataElement: fields.rollname,
          });
          break;
        }
        case "BVAL":
        case "AVAL": {
          const parsed = extractLenPrefixedValue(remainder, VAL_RE);
          if (!parsed) {
            result.droppedLines++;
            break;
          }
          const [rowRaw, field, lenRaw] = parsed.fields;
          const row = Number(rowRaw);
          const len = Number(lenRaw);
          const entry: ImgWriteValueRow = { row, field: field!, len, value: parsed.value };
          (head === "BVAL" ? result.before : result.after).push(entry);
          break;
        }
        case "BABSENT":
        case "AABSENT": {
          const m = ABSENT_RE.exec(remainder);
          if (!m) {
            result.droppedLines++;
            break;
          }
          const entry: ImgWriteAbsentRow = { row: Number(m[1]) };
          (head === "BABSENT" ? result.beforeAbsent : result.afterAbsent).push(entry);
          break;
        }
        case "WROTE": {
          const m = ABSENT_RE.exec(remainder);
          if (!m) {
            result.droppedLines++;
            break;
          }
          result.wrote.push(Number(m[1]));
          break;
        }
        case "ERROR": {
          const parsed = extractLenPrefixedValue(remainder, ERROR_RE);
          if (!parsed) {
            result.droppedLines++;
            break;
          }
          const [exClass] = parsed.fields;
          result.errors.push(`${exClass}: ${parsed.value}`);
          break;
        }
        case "TRKEY": {
          const headM = TRKEY_HEAD_RE.exec(remainder);
          if (!headM) {
            result.droppedLines++;
            break;
          }
          const row = Number(headM[1]);
          const trkorr = headM[2]!;
          let rest = remainder.slice(headM[0].length);

          // Optional order/task pair — an older-shaped line, or one missing
          // these two fields, simply skips straight to the mandatory
          // len=[...] value=[...] below.
          let recordedOrder: string | undefined;
          let recordedTask: string | undefined;
          const orderParsed = extractLenPrefixedValue(rest, TRKEY_ORDER_RE);
          if (orderParsed) {
            recordedOrder = orderParsed.value;
            rest = orderParsed.rest.replace(/^ /, "");
            const taskParsed = extractLenPrefixedValue(rest, TRKEY_TASK_RE);
            if (taskParsed) {
              recordedTask = taskParsed.value;
              rest = taskParsed.rest.replace(/^ /, "");
            }
          }

          const valParsed = extractLenPrefixedValue(rest, TRKEY_VALUE_RE);
          if (!valParsed) {
            result.droppedLines++;
            break;
          }
          const entry: ImgWriteTrKeyRow = {
            row,
            trkorr,
            len: Number(valParsed.fields[0]),
            value: valParsed.value,
          };
          if (recordedOrder !== undefined) entry.recordedOrder = recordedOrder;
          if (recordedTask !== undefined) entry.recordedTask = recordedTask;
          result.trkeys.push(entry);
          break;
        }
        case "NOTE": {
          const fields = parseBracketFields(remainder);
          if (fields.text === undefined) {
            result.droppedLines++;
            break;
          }
          result.notes.push(fields.text);
          break;
        }
        case "PROBED": {
          const fields = parseBracketFields(remainder);
          if (fields.rows === undefined || Number.isNaN(Number(fields.rows))) {
            result.droppedLines++;
            break;
          }
          result.probed = true;
          break;
        }
        case "APPLIED": {
          const fields = parseBracketFields(remainder);
          const n = Number(fields.rows);
          if (fields.rows === undefined || Number.isNaN(n)) {
            result.droppedLines++;
            break;
          }
          result.applied = n;
          break;
        }
        default:
          result.droppedLines++;
      }
    } else if (line.startsWith(DDIC_ERR_PREFIX)) {
      result.errors.push(line.slice(DDIC_ERR_PREFIX.length).trim());
    } else if (line.startsWith(ERR_LINE_PREFIX)) {
      result.errors.push(line.slice(ERR_LINE_PREFIX.length).trim());
    } else if (line.trim() === "") {
      // blank — ignored
    } else {
      result.droppedLines++;
    }
  }

  return result;
}
