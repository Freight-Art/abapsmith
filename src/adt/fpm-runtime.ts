/**
 * ABAP bridge generation and orchestration for `abap_fpm_read`.
 *
 * FPM/FBI screen configs live as XML in WDY_CONFIG_* tables with no ADT REST
 * read path (writes 405; no read endpoint) — like `bopf-runtime.ts`, this
 * generates a deterministic `IF_OO_ADT_CLASSRUN` ABAP class per query,
 * deploys it to $TMP, and runs it to get a line-prefixed text transcript.
 *
 * Facts below are confirmed against a live A4H sandbox (captured probe
 * runs), not guessed. Full evidence: the git history
 *
 *  - WDY_CONFIG_DATA (component-scope) has no description field; that's in
 *    WDY_CONFIG_DATT (key: config_id/config_type/config_var/langu).
 *    WDY_CONFIG_APPL (application-scope, config_type='02')'s xcontent/content
 *    fields, and WDY_CONFIG_APPT's key, are only weakly inferred.
 *  - CL_WDR_CFG_PERSISTENCE_UTILS=>READ_COMP_CONFIG_FROM_DB is the confirmed
 *    component-scope config reader; delta detection keys off CONFIG_IDPAR
 *    non-blank, not IS_DELTA (confirmed unreliable).
 *  - cl_abap_conv_in_ce's xstring→string decode is for XML_XCONTENT
 *    (XML_CONTENT is always empty).
 *  - TADIR's object-name key is CHAR40: obj_name(32)=config_id,
 *    +32(2)=config_type, +34(6)=config_var. Never use TADIR to ENUMERATE
 *    configs (phantom entries observed) — only as a per-row cross-reference.
 *  - CL_FPM_CFG_HRCHY_BRWSR_ASSIST is the confirmed way to walk an app
 *    config's UIBB hierarchy (mv_mode=2, init_affixes(), load_configuration).
 *    A manual walk of EXPL_DATA_TAB is confirmed wrong for this.
 *
 * Best-effort/unconfirmed spots are flagged again at their point of use
 * below; wrong field names there fail loudly via ABAP syntax check on
 * activation, never silently.
 */
import { createHash } from "node:crypto";

import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import {
  assertPlainName,
  deployBridge,
  ERR_LINE_PREFIX,
  executeBridge,
  MAX_NAME,
  parseBracketFields,
  verifyBridgeActivation,
} from "./run.js";
import type { SafetyGate } from "../safety.js";

// ---------------------------------------------------------------------------
// Query model
// ---------------------------------------------------------------------------

export interface FpmFindQuery {
  mode: "find";
  /** Already-resolved NUMC2 string, e.g. "00" or "02". */
  configType: string;
  /** Component-scope only — caller must not set this together with configType "02". */
  component?: string;
  /** Raw query pattern, `*` wildcard, not yet SQL-escaped. */
  queryPattern?: string;
  package?: string;
}

export interface FpmOutlineQuery {
  mode: "outline";
  configId: string;
  configType: string;
  configVar: string;
}

export interface FpmAppQuery {
  mode: "app";
  configId: string;
  resolve: boolean;
}

export type FpmBridgeQuery = FpmFindQuery | FpmOutlineQuery | FpmAppQuery;

// ---------------------------------------------------------------------------
// Validation (injection defense — every one of these strings is interpolated
// into generated ABAP source text below)
// ---------------------------------------------------------------------------

/** WDY_CONFIG_ID is CHAR32; exported so `fpm-lock.ts`'s GARG field width uses the same constant. */
export const CONFIG_ID_LEN = 32;
const CONFIG_VAR_MAX = 6;

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''");
}

export function assertConfigId(value: string): string {
  const v = assertPlainName(value, "config_id");
  if (v.length > CONFIG_ID_LEN) {
    throw new AbapError(
      "BAD_INPUT",
      `config_id "${value}" is ${v.length} characters long; WDY_CONFIG_ID is CHAR${CONFIG_ID_LEN}.`,
      { value },
    );
  }
  return v;
}

export function assertConfigType(value: string | undefined): string {
  const v = (value ?? "00").trim();
  if (!/^[0-9]{2}$/.test(v)) {
    throw new AbapError(
      "BAD_INPUT",
      `config_type "${value}" must be exactly 2 digits (NUMC2) — e.g. "00" (component) or "02" (application).`,
      { value },
    );
  }
  return v;
}

export function assertConfigVar(value: string | undefined): string {
  const v = (value ?? "").trim();
  if (v === "") return "";
  if (!/^[A-Za-z0-9_]{1,6}$/.test(v) || v.length > CONFIG_VAR_MAX) {
    throw new AbapError(
      "BAD_INPUT",
      `config_var "${value}" must be up to ${CONFIG_VAR_MAX} letters/digits/underscore.`,
      { value },
    );
  }
  return v;
}

export function assertComponent(value: string): string {
  return assertPlainName(value, "component");
}

export function assertPackageFilter(value: string): string {
  return assertPlainName(value, "package");
}

/**
 * Translates a `find` query pattern into a SQL LIKE literal. Charset is
 * narrow (letters/digits/underscore/slash/asterisk); apostrophes are
 * rejected outright, not escaped — this is interpolated into generated ABAP.
 */
export function buildLikePattern(query: string): { literal: string; escapeChar: string } {
  const trimmed = query.trim();
  if (trimmed === "" || !/^[A-Za-z0-9_/*]{1,40}$/.test(trimmed)) {
    throw new AbapError(
      "BAD_INPUT",
      `query "${query}" may only contain letters, digits, underscore, "/" and "*" (wildcard), 1-40 chars.`,
      { value: query },
    );
  }
  const escapeChar = "#";
  // Escape literal underscores (a LIKE metacharacter) before translating the
  // caller's `*` wildcard into SQL's `%`.
  const escaped = trimmed.replace(/_/g, `${escapeChar}_`).replace(/\*/g, "%");
  return { literal: sqlQuote(escaped), escapeChar };
}

/**
 * Throws `BAD_INPUT` on malformed fields for `q`'s mode. Called from
 * `fpmBridgeClassName` for a zero-network preflight refusal, and again
 * inside `findBody`/`outlineBody`/`appBody` when generating source —
 * intentional, cheap redundancy.
 */
function validateQuery(q: FpmBridgeQuery): void {
  switch (q.mode) {
    case "find":
      assertConfigType(q.configType);
      if (q.component) assertComponent(q.component);
      if (q.queryPattern) buildLikePattern(q.queryPattern);
      if (q.package) assertPackageFilter(q.package);
      if (q.configType === "02" && q.component) {
        throw new AbapError(
          "BAD_INPUT",
          'component filter does not apply to application configs (config_type "02") — WDY_CONFIG_APPL has no component column.',
          { component: q.component, configType: q.configType },
        );
      }
      break;
    case "outline":
      assertConfigId(q.configId);
      assertConfigType(q.configType);
      assertConfigVar(q.configVar);
      break;
    case "app":
      assertConfigId(q.configId);
      break;
  }
}

// ---------------------------------------------------------------------------
// Bridge naming
// ---------------------------------------------------------------------------

export const FPM_BRIDGE_CLASS_PREFIX = "ZCL_ZMCP_FPM_";

/**
 * Unlike `bopfBridgeClassName` (hashes a single BO name), FPM queries are
 * multi-parameter, so the class name hashes a canonical serialization of
 * every field — identical queries always produce the same class/source,
 * so repeats don't churn $TMP.
 */
function discriminator(q: FpmBridgeQuery): string {
  switch (q.mode) {
    case "find":
      return JSON.stringify({
        mode: "find",
        configType: q.configType,
        component: q.component ?? "",
        queryPattern: q.queryPattern ?? "",
        package: q.package ?? "",
      });
    case "outline":
      return JSON.stringify({
        mode: "outline",
        configId: q.configId,
        configType: q.configType,
        configVar: q.configVar,
      });
    case "app":
      return JSON.stringify({ mode: "app", configId: q.configId, resolve: q.resolve });
  }
}

export function fpmBridgeClassName(q: FpmBridgeQuery): string {
  validateQuery(q);
  // Hash-prefix width (30-char ABAP object-name limit minus fixed prefix).
  // Named `hashHexLen`, not `budget`, deliberately — see
  // the git history for why (test/no-silent-truncation.test.ts convention).
  const hashHexLen = MAX_NAME - FPM_BRIDGE_CLASS_PREFIX.length;
  const hash = createHash("sha256").update(discriminator(q), "utf8").digest("hex").slice(0, hashHexLen).toUpperCase();
  return `${FPM_BRIDGE_CLASS_PREFIX}${hash}`;
}

// ---------------------------------------------------------------------------
// Transcript protocol
// ---------------------------------------------------------------------------

/** Line prefix for structured output; `ERR_LINE_PREFIX` (from run.ts, "ZMCP-ERR> ") is reused for diagnostics. */
export const FPM_LINE_PREFIX = "FPM> ";

// ---------------------------------------------------------------------------
// ABAP source generation
// ---------------------------------------------------------------------------

function findBody(q: FpmFindQuery): string {
  const configType = assertConfigType(q.configType);
  const isAppl = configType === "02";
  const table = isAppl ? "wdy_config_appl" : "wdy_config_data";
  const textTable = isAppl ? "wdy_config_appt" : "wdy_config_datt";
  const tadirObject = isAppl ? "WDCA" : "WDCC";

  if (isAppl && q.component) {
    throw new AbapError(
      "BAD_INPUT",
      'component filter does not apply to application configs (config_type "02") — WDY_CONFIG_APPL has no component column.',
      { component: q.component, configType },
    );
  }

  const conditions: string[] = [`config_type = '${configType}'`];
  if (q.component) {
    conditions.push(`component = '${sqlQuote(assertComponent(q.component))}'`);
  }
  if (q.queryPattern) {
    const { literal, escapeChar } = buildLikePattern(q.queryPattern);
    conditions.push(`config_id LIKE '${literal}' ESCAPE '${escapeChar}'`);
  }
  const whereClause = `WHERE ${conditions.join(" AND ")}`;
  const selectFields = isAppl
    ? "config_id, config_type, config_var"
    : "config_id, config_type, config_var, component";
  const componentField = isAppl ? "" : "{ ls_row-component }";

  const lines: string[] = [];
  lines.push(`    SELECT ${selectFields}`);
  lines.push(`      FROM ${table}`);
  lines.push(`      ${whereClause}`);
  lines.push(`      INTO TABLE @DATA(lt_rows)`);
  lines.push(`      UP TO 200 ROWS.`);
  lines.push(`    mo_out->write( |${FPM_LINE_PREFIX}COUNT { lines( lt_rows ) }| ).`);
  lines.push(`    LOOP AT lt_rows INTO DATA(ls_row).`);
  lines.push(`      DATA lv_desc TYPE string.`);
  lines.push(`      CLEAR lv_desc.`);
  lines.push(`      SELECT SINGLE description FROM ${textTable}`);
  lines.push(`        WHERE config_id = @ls_row-config_id AND config_type = @ls_row-config_type`);
  lines.push(`          AND config_var = @ls_row-config_var AND langu = @sy-langu`);
  lines.push(`        INTO @lv_desc.`);

  if (q.package) {
    const pkg = sqlQuote(assertPackageFilter(q.package));
    lines.push(`      DATA lv_key40 TYPE c LENGTH 40.`);
    lines.push(`      CLEAR lv_key40.`);
    lines.push(`      lv_key40(32)   = ls_row-config_id.`);
    lines.push(`      lv_key40+32(2) = ls_row-config_type.`);
    lines.push(`      lv_key40+34(6) = ls_row-config_var.`);
    lines.push(`      DATA lv_devclass TYPE devclass.`);
    lines.push(`      CLEAR lv_devclass.`);
    lines.push(`      SELECT SINGLE devclass FROM tadir`);
    lines.push(`        WHERE pgmid = 'R3TR' AND object = '${tadirObject}' AND obj_name = @lv_key40`);
    lines.push(`        INTO @lv_devclass.`);
    lines.push(`      IF lv_devclass <> '${pkg}'.`);
    lines.push(`        CONTINUE.`);
    lines.push(`      ENDIF.`);
    lines.push(
      `      mo_out->write( |${FPM_LINE_PREFIX}CONFIG config_id=[{ ls_row-config_id }] config_type=[{ ls_row-config_type }] config_var=[{ ls_row-config_var }] component=[${componentField}] description=[{ lv_desc }] devclass=[{ lv_devclass }]| ).`,
    );
  } else {
    lines.push(
      `      mo_out->write( |${FPM_LINE_PREFIX}CONFIG config_id=[{ ls_row-config_id }] config_type=[{ ls_row-config_type }] config_var=[{ ls_row-config_var }] component=[${componentField}] description=[{ lv_desc }]| ).`,
    );
  }
  lines.push(`    ENDLOOP.`);
  return lines.join("\n");
}

function outlineBody(q: FpmOutlineQuery): string {
  const configId = sqlQuote(assertConfigId(q.configId));
  const configType = assertConfigType(q.configType);
  const configVar = sqlQuote(assertConfigVar(q.configVar));
  const isAppl = configType === "02";
  const tadirObject = isAppl ? "WDCA" : "WDCC";

  const lines: string[] = [];

  if (isAppl) {
    // WDY_CONFIG_APPL's xcontent/content fields are only weakly inferred;
    // wrong names fail loudly at activation (ABAP syntax check), not silently.
    lines.push(`    DATA lv_xc TYPE xstring.`);
    lines.push(`    CLEAR lv_xc.`);
    lines.push(`    SELECT SINGLE xcontent FROM wdy_config_appl`);
    lines.push(`      WHERE config_id = '${configId}' AND config_type = '02'`);
    lines.push(`        AND config_var = '${configVar}'`);
    lines.push(`      INTO @lv_xc.`);
    lines.push(`    IF sy-subrc <> 0.`);
    lines.push(`      mo_out->write( '${ERR_LINE_PREFIX}wdy_config_appl: no matching row for the given key' ).`);
    lines.push(`    ENDIF.`);
    lines.push(`    DATA lv_txt TYPE string.`);
    lines.push(`    CLEAR lv_txt.`);
    lines.push(`    IF lv_xc IS NOT INITIAL.`);
    lines.push(`      DATA(lo_conv) = cl_abap_conv_in_ce=>create( encoding = 'UTF-8' input = lv_xc ).`);
    lines.push(`      lo_conv->read( IMPORTING data = lv_txt ).`);
    lines.push(`    ENDIF.`);
    lines.push(`    emit_xml( iv_tag = 'XML' iv_text = lv_txt ).`);
    lines.push(``);
    lines.push(`    DATA lv_key40 TYPE c LENGTH 40.`);
    lines.push(`    CLEAR lv_key40.`);
    lines.push(`    lv_key40(32)   = '${configId}'.`);
    lines.push(`    lv_key40+32(2) = '02'.`);
    lines.push(`    lv_key40+34(6) = '${configVar}'.`);
    lines.push(`    DATA lv_devclass TYPE devclass.`);
    lines.push(`    CLEAR lv_devclass.`);
    lines.push(`    SELECT SINGLE devclass FROM tadir`);
    lines.push(`      WHERE pgmid = 'R3TR' AND object = '${tadirObject}' AND obj_name = @lv_key40`);
    lines.push(`      INTO @lv_devclass.`);
    lines.push(
      `    mo_out->write( |${FPM_LINE_PREFIX}META CONFIG_IDPAR=[N/A - application config, delta tracking not implemented for this branch] CONFIG_TYPEPAR=[] CONFIG_VARPAR=[] COMPONENT=[] DEVCLASS=[{ lv_devclass }]| ).`,
    );
  } else {
    lines.push(`    DATA ls_key TYPE wdy_config_key.`);
    lines.push(`    CLEAR ls_key.`);
    lines.push(`    ls_key-config_id   = '${configId}'.`);
    lines.push(`    ls_key-config_type = '${configType}'.`);
    lines.push(`    ls_key-config_var  = '${configVar}'.`);
    lines.push(`    DATA lv_xc TYPE xstring.`);
    lines.push(`    CLEAR lv_xc.`);
    lines.push(`    DATA(ls_ocd) = VALUE wdy_config_data( ).`);
    lines.push(`    TRY.`);
    lines.push(`        cl_wdr_cfg_persistence_utils=>read_comp_config_from_db(`);
    lines.push(`          EXPORTING config_key           = ls_key`);
    lines.push(`          IMPORTING xml_xcontent         = lv_xc`);
    lines.push(`                    original_config_data = ls_ocd ).`);
    lines.push(`      CATCH cx_root INTO DATA(lx1).`);
    lines.push(
      `        mo_out->write( |${ERR_LINE_PREFIX}READ_COMP_CONFIG_FROM_DB FAILED { lx1->get_text( ) }| ).`,
    );
    lines.push(`    ENDTRY.`);
    lines.push(`    DATA lv_txt TYPE string.`);
    lines.push(`    CLEAR lv_txt.`);
    lines.push(`    IF lv_xc IS NOT INITIAL.`);
    lines.push(`      DATA(lo_conv) = cl_abap_conv_in_ce=>create( encoding = 'UTF-8' input = lv_xc ).`);
    lines.push(`      lo_conv->read( IMPORTING data = lv_txt ).`);
    lines.push(`    ENDIF.`);
    lines.push(`    emit_xml( iv_tag = 'XML' iv_text = lv_txt ).`);
    lines.push(``);
    lines.push(`    DATA lv_key40 TYPE c LENGTH 40.`);
    lines.push(`    CLEAR lv_key40.`);
    lines.push(`    lv_key40(32)   = ls_key-config_id.`);
    lines.push(`    lv_key40+32(2) = ls_key-config_type.`);
    lines.push(`    lv_key40+34(6) = ls_key-config_var.`);
    lines.push(`    DATA lv_devclass TYPE devclass.`);
    lines.push(`    CLEAR lv_devclass.`);
    lines.push(`    SELECT SINGLE devclass FROM tadir`);
    lines.push(`      WHERE pgmid = 'R3TR' AND object = '${tadirObject}' AND obj_name = @lv_key40`);
    lines.push(`      INTO @lv_devclass.`);
    lines.push(
      `    mo_out->write( |${FPM_LINE_PREFIX}META CONFIG_IDPAR=[{ ls_ocd-config_idpar }] CONFIG_TYPEPAR=[{ ls_ocd-config_typepar }] CONFIG_VARPAR=[{ ls_ocd-config_varpar }] COMPONENT=[{ ls_ocd-component }] DEVCLASS=[{ lv_devclass }]| ).`,
    );
  }
  return lines.join("\n");
}

function appBody(q: FpmAppQuery): string {
  const configId = sqlQuote(assertConfigId(q.configId));
  const lines: string[] = [];
  lines.push(`    DATA lo_as TYPE REF TO cl_fpm_cfg_hrchy_brwsr_assist.`);
  lines.push(`    CREATE OBJECT lo_as.`);
  lines.push(`    lo_as->mv_mode = 2.`);
  lines.push(`    lo_as->init_affixes( ).`);
  lines.push(`    lo_as->ms_config_key-config_id   = '${configId}'.`);
  lines.push(`    lo_as->ms_config_key-config_type = '02'.`);
  lines.push(`    lo_as->load_configuration( lo_as->mc_level-conf ).`);
  lines.push(``);
  lines.push(`    mo_out->write( |${FPM_LINE_PREFIX}COUNT { lines( lo_as->mt_node_table ) }| ).`);
  // sy-tabix gets clobbered by the callee's own internal LOOP AT (see
  // READ_COMP_CONFIG_FROM_DB below) — an explicit loop-local counter is used
  // instead. See the git history: A4H incident
  // 2026-08-06, 13 of 14 resolved excerpts silently mismatched.
  lines.push(`    DATA lv_node_idx TYPE i.`);
  lines.push(`    CLEAR lv_node_idx.`);
  lines.push(`    LOOP AT lo_as->mt_node_table INTO DATA(ls_node).`);
  lines.push(`      lv_node_idx = lv_node_idx + 1.`);
  lines.push(
    `      mo_out->write( |${FPM_LINE_PREFIX}NODE node_path=[{ ls_node-node_path }] parent_path=[{ ls_node-parent_node_path }] | &&`,
  );
  lines.push(
    `        |is_top=[{ ls_node-is_top_node }] node_name=[{ ls_node-node_name }] description=[{ ls_node-description }] | &&`,
  );
  lines.push(`        |component=[{ ls_node-component_name }] interface_view=[{ ls_node-interface_view }] | &&`);
  lines.push(
    `        |config_id=[{ ls_node-config_id }] config_type=[{ ls_node-config_type }] config_var=[{ ls_node-config_var }] | &&`,
  );
  lines.push(
    `        |target_config_id=[{ ls_node-target_config_id }] is_configurable=[{ ls_node-is_configurable }] | &&`,
  );
  lines.push(`        |is_customized=[{ ls_node-is_customized }] is_enhanced=[{ ls_node-is_enhanced }] | &&`);
  lines.push(`        |is_freestyle_uibb=[{ ls_node-is_freestyle_uibb }] is_leaf=[{ ls_node-is_leaf }]| ).`);

  if (q.resolve) {
    lines.push(``);
    lines.push(`      IF ls_node-component_name IS NOT INITIAL AND ls_node-is_configurable = abap_true.`);
    lines.push(`        DATA ls_rkey TYPE wdy_config_key.`);
    lines.push(`        CLEAR ls_rkey.`);
    lines.push(`        ls_rkey-config_id   = ls_node-config_id.`);
    lines.push(`        ls_rkey-config_type = ls_node-config_type.`);
    lines.push(`        ls_rkey-config_var  = ls_node-config_var.`);
    lines.push(`        DATA lv_rxc TYPE xstring.`);
    lines.push(`        CLEAR lv_rxc.`);
    lines.push(`        TRY.`);
    lines.push(`            cl_wdr_cfg_persistence_utils=>read_comp_config_from_db(`);
    lines.push(`              EXPORTING config_key   = ls_rkey`);
    lines.push(`              IMPORTING xml_xcontent = lv_rxc ).`);
    lines.push(`          CATCH cx_root INTO DATA(lxr).`);
    lines.push(
      `            mo_out->write( |${ERR_LINE_PREFIX}RESOLVE { ls_node-node_path } FAILED { lxr->get_text( ) }| ).`,
    );
    lines.push(`        ENDTRY.`);
    lines.push(`        DATA lv_rtxt TYPE string.`);
    lines.push(`        CLEAR lv_rtxt.`);
    lines.push(`        IF lv_rxc IS NOT INITIAL.`);
    lines.push(`          DATA(lo_rconv) = cl_abap_conv_in_ce=>create( encoding = 'UTF-8' input = lv_rxc ).`);
    lines.push(`          lo_rconv->read( IMPORTING data = lv_rtxt ).`);
    lines.push(`        ENDIF.`);
    lines.push(`        DATA lv_feeder TYPE string.`);
    lines.push(`        DATA lv_bopf TYPE string.`);
    lines.push(`        CLEAR: lv_feeder, lv_bopf.`);
    // Best-effort presence-only heuristic (never regex) — exact FEEDER/BOPF
    // XML encoding has never been observed; reported as a boolean hint only.
    lines.push(`        IF lv_rtxt CS 'FEEDER'.`);
    lines.push(`          lv_feeder = 'X'.`);
    lines.push(`        ENDIF.`);
    lines.push(`        IF lv_rtxt CS '/BOBF/' OR lv_rtxt CS 'BOPF' OR lv_rtxt CS 'BO_KEY'.`);
    lines.push(`          lv_bopf = 'X'.`);
    lines.push(`        ENDIF.`);
    lines.push(
      `        mo_out->write( |${FPM_LINE_PREFIX}RESOLVED node_path=[{ ls_node-node_path }] xml_len=[{ strlen( lv_rtxt ) }] feeder_hint=[{ lv_feeder }] bopf_hint=[{ lv_bopf }]| ).`,
    );
    lines.push(
      `        emit_xml( iv_tag = |XMLEXCERPT_{ lv_node_idx }| iv_text = substring( val = lv_rtxt len = nmin( val1 = strlen( lv_rtxt ) val2 = 300 ) ) ).`,
    );
    lines.push(`      ENDIF.`);
  }

  lines.push(`    ENDLOOP.`);
  return lines.join("\n");
}

/**
 * Generates the bridge class source for `query`. Byte-stable per query so
 * `writeObject` can skip repeat writes.
 */
export function fpmBridgeSource(query: FpmBridgeQuery, className: string): string {
  const cls = assertPlainName(className, "Bridge class name").toLowerCase();

  let body: string;
  switch (query.mode) {
    case "find":
      body = findBody(query);
      break;
    case "outline":
      body = outlineBody(query);
      break;
    case "app":
      body = appBody(query);
      break;
  }

  return `CLASS ${cls} DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
  PRIVATE SECTION.
    DATA mo_out TYPE REF TO if_oo_adt_classrun_out.
    "! Writes iv_text as one or more ${FPM_LINE_PREFIX}<tag>_BEGIN / <tag>C <chunk>
    "! / <tag>_END lines. Real CR/LF inside iv_text is escaped to a literal
    "! two-character \\n sequence first — an embedded raw newline would start
    "! an unprefixed continuation line that the TS-side parser must treat as
    "! a dropped line, never silently absorb.
    METHODS emit_xml
      IMPORTING iv_tag  TYPE string
                iv_text TYPE string.
ENDCLASS.

CLASS ${cls} IMPLEMENTATION.

  METHOD emit_xml.
    DATA lv_esc TYPE string.
    lv_esc = iv_text.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_lf IN lv_esc WITH '\\n'.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>newline IN lv_esc WITH '\\n'.
    mo_out->write( |${FPM_LINE_PREFIX}{ iv_tag }_BEGIN| ).
    DATA lv_off TYPE i.
    DATA lv_len TYPE i.
    lv_off = 0.
    lv_len = strlen( lv_esc ).
    WHILE lv_off < lv_len.
      DATA(lv_chunk_len) = lv_len - lv_off.
      IF lv_chunk_len > 32000.
        lv_chunk_len = 32000.
      ENDIF.
      mo_out->write( |${FPM_LINE_PREFIX}{ iv_tag }C { substring( val = lv_esc off = lv_off len = lv_chunk_len ) }| ).
      lv_off = lv_off + lv_chunk_len.
    ENDWHILE.
    IF lv_len = 0.
      mo_out->write( |${FPM_LINE_PREFIX}{ iv_tag }C | ).
    ENDIF.
    mo_out->write( |${FPM_LINE_PREFIX}{ iv_tag }_END| ).
  ENDMETHOD.

  METHOD if_oo_adt_classrun~main.
*   Generated by abapsmith (abap_fpm_read, mode=${query.mode}). Do not edit —
*   this class is regenerated from src/adt/fpm-runtime.ts whenever its
*   content hash changes. Read-only: no WDY_CONFIG_* row is ever written.
    mo_out = out.
    TRY.
${body}
      CATCH cx_root INTO DATA(lx).
        out->write( |${ERR_LINE_PREFIX}EXCEPTION { cl_abap_classdescr=>get_class_name( lx ) }: { lx->get_text( ) }| ).
    ENDTRY.
  ENDMETHOD.

ENDCLASS.
`;
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

export interface FpmConfigRow {
  configId: string;
  configType: string;
  configVar: string;
  component: string;
  description: string;
  devclass?: string;
}

export interface FpmAppNode {
  nodePath: string;
  parentPath: string;
  isTopNode: boolean;
  nodeName: string;
  description: string;
  componentName: string;
  interfaceView: string;
  configId: string;
  configType: string;
  configVar: string;
  targetConfigId: string;
  isConfigurable: boolean;
  isCustomized: boolean;
  isEnhanced: boolean;
  isFreestyleUibb: boolean;
  isLeaf: boolean;
  resolved?: {
    xmlLen: number;
    feederHint: boolean;
    bopfHint: boolean;
    excerpt?: string;
  };
}

export interface FpmTranscriptResult {
  count?: number;
  configs: FpmConfigRow[];
  outlineXml?: string;
  outlineMeta?: {
    configIdPar: string;
    configTypePar: string;
    configVarPar: string;
    component: string;
    devclass: string;
  };
  appNodes: FpmAppNode[];
  diagnostics: string[];
  droppedLines: number;
}

/**
 * Extracts `<tag>_BEGIN`/`<tag>C <chunk>`/`<tag>_END` XML streams into
 * `finalized`; everything else goes to `rest`, in order. Only one stream is
 * open at a time (emit_xml never interleaves), so a stream missing `_END`
 * contributes nothing.
 */
function parseXmlStreams(transcriptLines: string[]): { finalized: Map<string, string>; rest: string[] } {
  const finalized = new Map<string, string>();
  const rest: string[] = [];
  let openTag: string | undefined;
  let chunks: string[] = [];

  for (const line of transcriptLines) {
    if (openTag === undefined) {
      const m = /^(\S+)_BEGIN$/.exec(line);
      if (m) {
        openTag = m[1];
        chunks = [];
        continue;
      }
      rest.push(line);
      continue;
    }
    if (line === `${openTag}_END`) {
      finalized.set(openTag, chunks.join("").replace(/\\n/g, "\n"));
      openTag = undefined;
      chunks = [];
      continue;
    }
    const chunkPrefix = `${openTag}C `;
    if (line.startsWith(chunkPrefix)) {
      chunks.push(line.slice(chunkPrefix.length));
      continue;
    }
    if (line === `${openTag}C`) {
      continue; // empty chunk with a stripped trailing space
    }
    // Unexpected line while a stream is open — keep it, don't lose it.
    rest.push(line);
  }
  return { finalized, rest };
}

export function parseFpmTranscript(raw: string): FpmTranscriptResult {
  const transcript: string[] = [];
  const diagnostics: string[] = [];
  let droppedLines = 0;

  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith(FPM_LINE_PREFIX)) {
      transcript.push(line.slice(FPM_LINE_PREFIX.length));
    } else if (line.startsWith(ERR_LINE_PREFIX)) {
      diagnostics.push(line.trim());
    } else if (line.trim() === "") {
      // blank unprefixed line — ADT/HTTP framing noise, not counted as dropped
    } else {
      droppedLines++;
    }
  }

  const { finalized, rest } = parseXmlStreams(transcript);

  const configs: FpmConfigRow[] = [];
  const appNodes: FpmAppNode[] = [];
  let outlineMeta: FpmTranscriptResult["outlineMeta"];
  let count: number | undefined;
  let resolveOrdinal = 0;

  for (const line of rest) {
    const spaceIdx = line.indexOf(" ");
    const head = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const remainder = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1);
    const fields = parseBracketFields(remainder);

    switch (head) {
      case "COUNT": {
        const n = Number(remainder.trim());
        if (!Number.isNaN(n)) count = n;
        break;
      }
      case "CONFIG":
        configs.push({
          configId: fields.config_id ?? "",
          configType: fields.config_type ?? "",
          configVar: fields.config_var ?? "",
          component: fields.component ?? "",
          description: fields.description ?? "",
          devclass: fields.devclass,
        });
        break;
      case "META":
        outlineMeta = {
          configIdPar: fields.CONFIG_IDPAR ?? "",
          configTypePar: fields.CONFIG_TYPEPAR ?? "",
          configVarPar: fields.CONFIG_VARPAR ?? "",
          component: fields.COMPONENT ?? "",
          devclass: fields.DEVCLASS ?? "",
        };
        break;
      case "NODE":
        resolveOrdinal++;
        appNodes.push({
          nodePath: fields.node_path ?? "",
          parentPath: fields.parent_path ?? "",
          isTopNode: fields.is_top === "X",
          nodeName: fields.node_name ?? "",
          description: fields.description ?? "",
          componentName: fields.component ?? "",
          interfaceView: fields.interface_view ?? "",
          configId: fields.config_id ?? "",
          configType: fields.config_type ?? "",
          configVar: fields.config_var ?? "",
          targetConfigId: fields.target_config_id ?? "",
          isConfigurable: fields.is_configurable === "X",
          isCustomized: fields.is_customized === "X",
          isEnhanced: fields.is_enhanced === "X",
          isFreestyleUibb: fields.is_freestyle_uibb === "X",
          isLeaf: fields.is_leaf === "X",
        });
        break;
      case "RESOLVED": {
        const target = appNodes[appNodes.length - 1];
        if (target) {
          target.resolved = {
            xmlLen: Number(fields.xml_len ?? "0") || 0,
            feederHint: fields.feeder_hint === "X",
            bopfHint: fields.bopf_hint === "X",
            excerpt: finalized.get(`XMLEXCERPT_${resolveOrdinal}`),
          };
        }
        break;
      }
      default:
        // Unrecognised narration line — not an error, contributes nothing structured.
        break;
    }
  }

  return {
    count,
    configs,
    outlineXml: finalized.get("XML"),
    outlineMeta,
    appNodes,
    diagnostics,
    droppedLines,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface FpmReadResult {
  query: FpmBridgeQuery;
  bridgeClass: string;
  bridgeRefreshed: boolean;
  durationMs: number;
  transcript: FpmTranscriptResult;
  outputComplete: boolean;
  bodyBytes: number;
}

export async function runFpmRead(
  conn: AbapConnection,
  query: FpmBridgeQuery,
  gate: SafetyGate,
): Promise<FpmReadResult> {
  const started = Date.now();
  const className = fpmBridgeClassName(query);
  const source = fpmBridgeSource(query, className);

  const deployed = await deployBridge(conn, gate, {
    className,
    source,
    description: `abapsmith FPM read bridge (mode=${query.mode})`,
    what: "Activation of the generated FPM read bridge",
    hint:
      "The bridge reads FPM/FBI configuration via SAP-standard SELECTs and API calls — a syntax " +
      "error here most likely means one of the referenced fields/methods does not exist exactly as " +
      "assumed on this system (see fpm-runtime.ts's module doc comment for which facts are confirmed " +
      "vs. best-effort).",
    verify: (activation) =>
      verifyBridgeActivation(activation, className, "FPM read bridge", { mode: query.mode }),
  });
  const { bridgeRefreshed } = deployed;

  // F8: running the bridge is a distinct mutating op from write/activate
  // above (POSTs to classrun and executes what's active) — gated separately.
  const run = await executeBridge(conn, gate, deployed);
  const transcript = parseFpmTranscript(run.output);

  return {
    query,
    bridgeClass: className,
    bridgeRefreshed,
    durationMs: Date.now() - started,
    transcript,
    outputComplete: run.outputComplete,
    bodyBytes: run.bodyBytes,
  };
}
