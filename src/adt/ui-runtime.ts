/**
 * ABAP bridge generation for `abap_ui` — headless classic dynpro driving
 * (discovery + batch-input "press") via generated `IF_OO_ADT_CLASSRUN`
 * bridge classes written/activated in $TMP and run in a fresh session, same
 * pattern as `fpm-runtime.ts`/`ddic-bridge.ts`. No ADT REST endpoint reaches
 * TSTC, the screen-painter reader FMs, CUA status, or CALL TRANSACTION, so
 * this drives them via a generated class instead.
 *
 * Two modes:
 *  - `screen` (read-only): resolves a tcode via TSTC (or takes an explicit
 *    program+dynpro), reads fields/flow logic via `RPY_DYNPRO_READ` and GUI
 *    status ("buttons") via a two-call `RS_CUA_INTERNAL_FETCH` +
 *    `RS_CUA_GET_STATUS` sequence (see below for why).
 *  - `press` (mutating — COMMITS): builds `BDCDATA` from an ordered screen
 *    list and runs `CALL TRANSACTION ... MODE 'N' UPDATE 'S' MESSAGES INTO`,
 *    decoding every message and detecting the "ran out of scripted screens"
 *    signal (`sy-subrc = 1001` + message `00 344`) as a structured result.
 *
 * Full FM signatures, RTTI confirmations, and measured timings are recorded
 * in the git history. Load-bearing constraints
 * kept live at their point of use below:
 *  - `RS_CUA_GET_STATUS`'s STATUS is not optional in practice — confirmed
 *    live against 4 programs; a blank STATUS silently returns 0 buttons
 *    (`sy-subrc = 2`), it does not fall back to a default. Always call it
 *    per-status, via `RS_CUA_INTERNAL_FETCH`'s enumeration first.
 *  - `RPY_STATUS_READ` does not exist on the target system; never use it.
 *  - Never emit `WITHOUT AUTHORITY-CHECK` — SAP's own authority check
 *    inside the driven transaction is the real security boundary.
 *  - `D021S`/`RPY_DYHEAD`/`RPY_DYFLOW` component names are unconfirmed, so
 *    rows are dumped generically via `flatten_any` (RTTI) rather than named.
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

/** Either a tcode (resolved server-side via TSTC) or an explicit program+dynpro. */
export type UiScreenTarget =
  | { readonly by: "tcode"; readonly tcode: string }
  | { readonly by: "program"; readonly program: string; readonly dynpro: string };

/** Mode 1 — read-only discovery: fields, flow logic and GUI status ("buttons") of one dynpro. */
export interface UiScreenQuery {
  readonly mode: "screen";
  readonly target: UiScreenTarget;
}

/** One `FNAM`/`FVAL` pair — an ordinary screen field being set. */
export interface UiBdcField {
  readonly fieldName: string;
  readonly value: string;
}

/** One scripted dynpro: where the BDC data starts a screen, and what it sets on it. */
export interface UiBdcScreen {
  readonly program: string;
  readonly dynpro: string;
  /** Sets `BDC_OKCODE`. Conventionally starts with `=` for a function code — not enforced, only documented. */
  readonly okCode?: string;
  /** Sets `BDC_CURSOR` — the field name (optionally with a `(nn)` table-control row suffix) to position the cursor on. */
  readonly cursorField?: string;
  readonly fields: readonly UiBdcField[];
}

/** Mode 2 — batch input: runs `CALL TRANSACTION` and COMMITS. */
export interface UiPressQuery {
  readonly mode: "press";
  readonly tcode: string;
  readonly screens: readonly UiBdcScreen[];
}

export type UiBridgeQuery = UiScreenQuery | UiPressQuery;

// ---------------------------------------------------------------------------
// Validation (injection defense — every one of these strings is interpolated
// into generated ABAP source text below)
// ---------------------------------------------------------------------------

/** `TSTC-TCODE` is CHAR20. */
export const TCODE_MAX = 20;
/** Program (repository object) names, matching `assertPlainName`'s own ABAP_NAME ceiling exactly — not a stricter, independently-live check. */
export const PROGRAM_MAX = 40;
/** `D021S-FNAM`-class dynpro field name width. */
export const FIELD_NAME_MAX = 132;
/** `BDCDATA-FVAL` width — every field value (including the OK-code and the cursor field name) ultimately lands in this CHAR132 column. */
export const FIELD_VALUE_MAX = 132;

/** Doubles every embedded `'` so a caller-supplied value can never break out of its ABAP literal. Applied to every interpolated value, even quote-free ones. */
export function escapeAbapLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Raw (unescaped) chars per chunk for {@link abapLiteralAssignmentLines}.
 * Chunking on the raw value (not the escaped text) avoids ever splitting a
 * doubled `''` pair. 90 raw chars doubles to at most 180 escaped chars per
 * line, comfortably under ADT's 255-char source-line ceiling.
 */
const ABAP_LITERAL_CHUNK_RAW = 90;

/** Builds `rawValue` (quote-escaped) into `targetVar` via `CLEAR` + repeated `&&`-append, chunked to stay under ADT's 255-char line limit regardless of length. */
export function abapLiteralAssignmentLines(targetVar: string, rawValue: string, indent = "    "): string[] {
  const lines: string[] = [`${indent}CLEAR ${targetVar}.`];
  for (let i = 0; i < rawValue.length; i += ABAP_LITERAL_CHUNK_RAW) {
    const chunk = rawValue.slice(i, i + ABAP_LITERAL_CHUNK_RAW);
    lines.push(`${indent}${targetVar} = ${targetVar} && '${escapeAbapLiteral(chunk)}'.`);
  }
  return lines;
}

export function assertTcode(value: string): string {
  const v = assertPlainName(value, "transaction code");
  if (v.length > TCODE_MAX) {
    throw new AbapError(
      "BAD_INPUT",
      `tcode "${value}" is ${v.length} characters long; TSTC-TCODE is CHAR${TCODE_MAX}.`,
      { value },
    );
  }
  return v;
}

export function assertProgramName(value: string): string {
  const v = assertPlainName(value, "program name");
  if (v.length > PROGRAM_MAX) {
    throw new AbapError(
      "BAD_INPUT",
      `program name "${value}" is ${v.length} characters long; program names are max ${PROGRAM_MAX}.`,
      { value },
    );
  }
  return v;
}

/** Normalises a dynpro number to its 4-digit `D020S-DNUM` form — `"100"` -> `"0100"`, so an unpadded screen number never silently addresses the wrong dynpro. */
export function assertDynpro(value: string): string {
  const trimmed = value.trim();
  if (!/^[0-9]{1,4}$/.test(trimmed)) {
    throw new AbapError(
      "BAD_INPUT",
      `dynpro "${value}" must be 1-4 digits (a numeric screen number).`,
      { value },
    );
  }
  return trimmed.padStart(4, "0");
}

const FIELD_NAME_RE = /^[A-Za-z0-9_\-/().]{1,132}$/;

/** Validates a dynpro field name (`D021S-FNAM`-class): letters, digits, `_`, `-` (structure separator), `/` (namespaces), `()`/`.` (table-control row index, e.g. `..._MASSN-KUNNR(01)`). No `'` or whitespace. */
export function assertFieldName(value: string): string {
  const v = value.trim();
  if (!FIELD_NAME_RE.test(v)) {
    throw new AbapError(
      "BAD_INPUT",
      `field name "${value}" is not a plausible dynpro field name (letters, digits, _ - / ( ) . only, 1-${FIELD_NAME_MAX} chars).`,
      { value },
    );
  }
  return v;
}

/**
 * Refuses control characters in a value bound for a generated ABAP literal.
 * Not a security boundary ({@link escapeAbapLiteral} already closes the
 * injection hole) — quote-doubling does nothing about a CR/LF, which would
 * physically split the generated source line and turn into an opaque ADT
 * activation error. This converts that into a `BAD_INPUT` naming the field.
 * Every other character, including `'`, stays legal (`O'BRIEN` must work).
 */
function assertNoControlChars(value: string, what: string): void {
  // eslint-disable-next-line no-control-regex
  const m = /[\x00-\x08\x0A-\x1F\x7F]/.exec(value);
  if (m) {
    const code = m[0].charCodeAt(0);
    throw new AbapError(
      "BAD_INPUT",
      `${what} contains a control character (0x${code.toString(16).padStart(2, "0")}) at ` +
        `offset ${m.index}. Values are embedded in generated ABAP string literals; a newline ` +
        `or control character would split the generated source line and fail activation.`,
      // No value echo: offset + charCode locate the problem without writing raw control bytes into the error detail.
      { offset: m.index, charCode: code, length: value.length },
    );
  }
}

/** Validates an ordinary field VALUE (free text; empty is legitimate — it clears a field). `BDCDATA-FVAL` is CHAR132, so an over-long value is refused here rather than silently truncated inside ABAP. */
export function assertFieldValue(value: string): string {
  if (value.length > FIELD_VALUE_MAX) {
    throw new AbapError(
      "BAD_INPUT",
      `field value is ${value.length} characters long; BDCDATA-FVAL is CHAR${FIELD_VALUE_MAX}.`,
      { length: value.length },
    );
  }
  assertNoControlChars(value, "field value");
  return value;
}

/** Validates an OK-code value (the `BDC_OKCODE` field's `FVAL`) — same width as any other field value, but must not be empty. */
export function assertOkCode(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new AbapError("BAD_INPUT", "OK-code must not be empty.", { value });
  }
  if (trimmed.length > FIELD_VALUE_MAX) {
    throw new AbapError(
      "BAD_INPUT",
      `OK-code "${value}" is ${trimmed.length} characters long; BDCDATA-FVAL is CHAR${FIELD_VALUE_MAX}.`,
      { value },
    );
  }
  assertNoControlChars(trimmed, "OK-code");
  return trimmed;
}

/** Runs every field-level validator for `q`'s mode, throwing `BAD_INPUT` on anything malformed. Called both from `uiBridgeClassName` (zero-network preflight) and again inside `screenBody`/`pressBody`. */
function validateQuery(q: UiBridgeQuery): void {
  switch (q.mode) {
    case "screen":
      if (q.target.by === "tcode") {
        assertTcode(q.target.tcode);
      } else {
        assertProgramName(q.target.program);
        assertDynpro(q.target.dynpro);
      }
      break;
    case "press": {
      assertTcode(q.tcode);
      if (q.screens.length === 0) {
        throw new AbapError("BAD_INPUT", "press requires at least one screen.", {});
      }
      for (const screen of q.screens) {
        assertProgramName(screen.program);
        assertDynpro(screen.dynpro);
        if (screen.okCode !== undefined) assertOkCode(screen.okCode);
        if (screen.cursorField !== undefined) assertFieldName(screen.cursorField);
        for (const f of screen.fields) {
          assertFieldName(f.fieldName);
          assertFieldValue(f.value);
        }
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Bridge naming
// ---------------------------------------------------------------------------

export const UI_BRIDGE_CLASS_PREFIX = "ZCL_ZMCP_UI_";

/**
 * Class name is a hash of every query field (like `fpmBridgeClassName`), so
 * identical queries reuse the same deployed class. This only affects the
 * DEPLOY step's cost — `executeBridge` always runs the class regardless of
 * whether the PUT was skipped, so a repeated `press` still performs its
 * `CALL TRANSACTION` every call.
 */
function discriminator(q: UiBridgeQuery): string {
  switch (q.mode) {
    case "screen":
      return JSON.stringify({ mode: "screen", target: q.target });
    case "press":
      return JSON.stringify({ mode: "press", tcode: q.tcode, screens: q.screens });
  }
}

export function uiBridgeClassName(q: UiBridgeQuery): string {
  validateQuery(q);
  const hashHexLen = MAX_NAME - UI_BRIDGE_CLASS_PREFIX.length;
  const hash = createHash("sha256").update(discriminator(q), "utf8").digest("hex").slice(0, hashHexLen).toUpperCase();
  return `${UI_BRIDGE_CLASS_PREFIX}${hash}`;
}

// ---------------------------------------------------------------------------
// Transcript protocol
// ---------------------------------------------------------------------------

/** Line prefix for structured output; `ERR_LINE_PREFIX` (from run.ts, "ZMCP-ERR> ") is reused for diagnostics. */
export const UI_LINE_PREFIX = "UI> ";

/**
 * Cap on per-status `RS_CUA_GET_STATUS` calls in screen mode (~32ms warm each;
 * ~674ms total for SAPLSETB's 21 statuses — see archive). When exceeded, the
 * transcript's STATUS_LOOP line reports `capped=1`; callers must disclose it.
 */
export const UI_STATUS_LOOP_CAP = 30;

/**
 * Cap on total FKEY rows emitted across all statuses. Added after
 * `buildResponse`'s char budget silently dropped rows past the header's
 * count on a real transcript (SAPLSVIM: header said 778, body had 442 — see
 * archive) — capping at the source avoids the transport doing it silently.
 * When hit, the transcript's FKEY_CAP line reports `capped=1`; callers must
 * disclose it, same as {@link UI_STATUS_LOOP_CAP}.
 */
export const UI_FKEY_ROW_CAP = 350;

/** ADT's PUT rejects a source line over this length with `ExceptionResourceBadRequest`/`TooLongLine`. */
const ABAP_MAX_LINE_LEN = 255;

function assertNoOverlongLines(source: string, className: string): void {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i]!.length;
    if (len > ABAP_MAX_LINE_LEN) {
      throw new AbapError(
        "BAD_INPUT",
        `Generated ABAP source for ${className} has a line of ${len} characters at line ${i + 1}, ` +
          `over ADT's ${ABAP_MAX_LINE_LEN}-character limit (ExceptionResourceBadRequest / TooLongLine).`,
        { className, line: i + 1, length: len },
        "This is a defensive check that should never fire — every caller-supplied value is " +
          "either charset-restricted (names) or chunked via abapLiteralAssignmentLines (values) " +
          "before reaching here. If it does fire, something upstream of it changed.",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// ABAP source generation — screen (mode 1)
// ---------------------------------------------------------------------------

function screenBody(q: UiScreenQuery): string {
  const lines: string[] = [];
  lines.push(`    DATA lv_program TYPE syrepid.`);
  lines.push(`    DATA lv_dynpro TYPE sydynnr.`);
  lines.push(`    CLEAR: lv_program, lv_dynpro.`);

  if (q.target.by === "tcode") {
    const tcode = escapeAbapLiteral(assertTcode(q.target.tcode));
    lines.push(`    DATA lv_cinfo TYPE tstc-cinfo.`);
    lines.push(`    CLEAR lv_cinfo.`);
    lines.push(`    SELECT SINGLE pgmna, dypno, cinfo`);
    lines.push(`      FROM tstc`);
    lines.push(`      WHERE tcode = '${tcode}'`);
    lines.push(`      INTO (@lv_program, @lv_dynpro, @lv_cinfo).`);
    lines.push(`    IF sy-subrc <> 0.`);
    lines.push(
      `      out->write( |${ERR_LINE_PREFIX}TSTC lookup failed for tcode ${tcode}, sy-subrc={ sy-subrc } (tcode probably does not exist)| ).`,
    );
    lines.push(`      RETURN.`);
    lines.push(`    ENDIF.`);
    lines.push(`    DATA lv_kind TYPE string.`);
    lines.push(`    CLEAR lv_kind.`);
    lines.push(`    CASE lv_cinfo.`);
    lines.push(`      WHEN '00'.`);
    lines.push(`        lv_kind = 'dialog transaction (classic dynpro; batch input / press applies)'.`);
    lines.push(`      WHEN '80'.`);
    lines.push(`        lv_kind = 'report transaction (SUBMIT-driven; batch input does NOT apply)'.`);
    lines.push(`      WHEN OTHERS.`);
    lines.push(
      `        lv_kind = 'unrecognised transaction kind - mechanism not confirmed, do not assume batch input applies'.`,
    );
    lines.push(`    ENDCASE.`);
    lines.push(
      `    mo_out->write( |${UI_LINE_PREFIX}TCODE tcode=[${tcode}] program=[{ lv_program }] dynpro=[{ lv_dynpro }] cinfo=[{ lv_cinfo }] kind=[{ lv_kind }]| ).`,
    );
  } else {
    const program = escapeAbapLiteral(assertProgramName(q.target.program));
    const dynpro = escapeAbapLiteral(assertDynpro(q.target.dynpro));
    lines.push(`    lv_program = '${program}'.`);
    lines.push(`    lv_dynpro = '${dynpro}'.`);
  }

  lines.push(`    mo_out->write( |${UI_LINE_PREFIX}RESOLVED program=[{ lv_program }] dynpro=[{ lv_dynpro }]| ).`);

  // D021S/RPY_DYHEAD/RPY_DYFLOW component names are unconfirmed, so every
  // row is dumped generically via flatten_any() rather than named.
  lines.push(`    DATA ls_header TYPE rpy_dyhead.`);
  // A TABLES parameter declared `LIKE <struct>` types the ROW, not the
  // table, so both need `TYPE TABLE OF` — lt_flow_logic previously shipped
  // as a bare `TYPE rpy_dyflow` and failed activation every call; the
  // invariant test in test/ui-runtime.test.ts now checks every TABLES-bound
  // variable (see archive for the incident).
  lines.push(`    DATA lt_fields_list TYPE TABLE OF d021s.`);
  lines.push(`    DATA lt_flow_logic TYPE TABLE OF rpy_dyflow.`);
  lines.push(`    CLEAR: ls_header, lt_fields_list, lt_flow_logic.`);
  lines.push(`    CALL FUNCTION 'RPY_DYNPRO_READ'`);
  lines.push(`      EXPORTING`);
  lines.push(`        progname = lv_program`);
  lines.push(`        dynnr    = lv_dynpro`);
  lines.push(`      IMPORTING`);
  lines.push(`        header   = ls_header`);
  lines.push(`      TABLES`);
  lines.push(`        flow_logic  = lt_flow_logic`);
  lines.push(`        fields_list = lt_fields_list`);
  lines.push(`      EXCEPTIONS`);
  lines.push(`        cancelled        = 1`);
  lines.push(`        not_found        = 2`);
  lines.push(`        permission_error = 3`);
  lines.push(`        OTHERS           = 4.`);
  lines.push(`    IF sy-subrc <> 0.`);
  lines.push(
    `      out->write( |${ERR_LINE_PREFIX}RPY_DYNPRO_READ failed, sy-subrc={ sy-subrc } (1=cancelled 2=not_found 3=permission_error 4=other)| ).`,
  );
  lines.push(`    ELSE.`);
  lines.push(`      mo_out->write( |${UI_LINE_PREFIX}HEADER { flatten_any( ls_header ) }| ).`);
  lines.push(`      mo_out->write( |${UI_LINE_PREFIX}COUNT_FIELDS { lines( lt_fields_list ) }| ).`);
  lines.push(`      LOOP AT lt_fields_list INTO DATA(ls_field).`);
  lines.push(`        mo_out->write( |${UI_LINE_PREFIX}FIELD { flatten_any( ls_field ) }| ).`);
  lines.push(`      ENDLOOP.`);
  lines.push(`      mo_out->write( |${UI_LINE_PREFIX}COUNT_FLOW { lines( lt_flow_logic ) }| ).`);
  lines.push(`      LOOP AT lt_flow_logic INTO DATA(ls_flow).`);
  lines.push(`        mo_out->write( |${UI_LINE_PREFIX}FLOW { flatten_any( ls_flow ) }| ).`);
  lines.push(`      ENDLOOP.`);
  lines.push(`    ENDIF.`);

  // GUI status/buttons — two-step approach (see module header for why).
  // Keyed by PROGRAM alone, so it always runs even if the read above failed.
  lines.push(`    IF lv_program IS NOT INITIAL.`);
  lines.push(`      DATA lt_sta TYPE STANDARD TABLE OF rsmpe_stat.`);
  lines.push(`      DATA lt_fun TYPE STANDARD TABLE OF rsmpe_funt.`);
  lines.push(`      DATA lt_men TYPE STANDARD TABLE OF rsmpe_men.`);
  lines.push(`      DATA lt_mtx TYPE STANDARD TABLE OF rsmpe_mnlt.`);
  lines.push(`      DATA lt_act TYPE STANDARD TABLE OF rsmpe_act.`);
  lines.push(`      DATA lt_but TYPE STANDARD TABLE OF rsmpe_but.`);
  lines.push(`      DATA lt_pfk TYPE STANDARD TABLE OF rsmpe_pfk.`);
  lines.push(`      DATA lt_set TYPE STANDARD TABLE OF rsmpe_staf.`);
  lines.push(`      DATA lt_doc TYPE STANDARD TABLE OF rsmpe_atrt.`);
  lines.push(`      DATA lt_tit TYPE STANDARD TABLE OF rsmpe_titt.`);
  lines.push(`      DATA lt_biv TYPE STANDARD TABLE OF rsmpe_buts.`);
  lines.push(`      DATA lt_fkeys TYPE STANDARD TABLE OF rseul_keys.`);
  lines.push(
    `      CLEAR: lt_sta, lt_fun, lt_men, lt_mtx, lt_act, lt_but, lt_pfk, lt_set, lt_doc, lt_tit, lt_biv, lt_fkeys.`,
  );
  lines.push(`      CALL FUNCTION 'RS_CUA_INTERNAL_FETCH'`);
  lines.push(`        EXPORTING`);
  lines.push(`          program = lv_program`);
  lines.push(`        TABLES`);
  lines.push(`          sta = lt_sta`);
  lines.push(`          fun = lt_fun`);
  lines.push(`          men = lt_men`);
  lines.push(`          mtx = lt_mtx`);
  lines.push(`          act = lt_act`);
  lines.push(`          but = lt_but`);
  lines.push(`          pfk = lt_pfk`);
  lines.push(`          set = lt_set`);
  lines.push(`          doc = lt_doc`);
  lines.push(`          tit = lt_tit`);
  lines.push(`          biv = lt_biv`);
  lines.push(`        EXCEPTIONS`);
  lines.push(`          not_found       = 1`);
  lines.push(`          unknown_version = 2`);
  lines.push(`          OTHERS          = 3.`);
  lines.push(`      IF sy-subrc = 1.`);
  lines.push(
    `        mo_out->write( |${UI_LINE_PREFIX}NOCUA program=[{ lv_program }] note=[no GUI status defined for this program]| ).`,
  );
  lines.push(`      ELSEIF sy-subrc <> 0.`);
  lines.push(
    `        out->write( |${ERR_LINE_PREFIX}RS_CUA_INTERNAL_FETCH failed, sy-subrc={ sy-subrc } (1=not_found 2=unknown_version 3=other)| ).`,
  );
  lines.push(`      ELSE.`);
  lines.push(`        mo_out->write( |${UI_LINE_PREFIX}COUNT_STATUS { lines( lt_sta ) }| ).`);
  lines.push(`        LOOP AT lt_sta INTO DATA(ls_sta).`);
  lines.push(`          mo_out->write( |${UI_LINE_PREFIX}STATUS { flatten_any( ls_sta ) }| ).`);
  lines.push(`        ENDLOOP.`);
  lines.push(`        mo_out->write( |${UI_LINE_PREFIX}COUNT_FUNCTIONS { lines( lt_fun ) }| ).`);
  lines.push(`        LOOP AT lt_fun INTO DATA(ls_fun).`);
  lines.push(
    `          mo_out->write( |${UI_LINE_PREFIX}FUNCTION code=[{ ls_fun-code }] text=[{ ls_fun-fun_text }] type=[{ ls_fun-type }]| ).`,
  );
  lines.push(`        ENDLOOP.`);
  lines.push(`        DATA lv_status_done TYPE i VALUE 0.`);
  lines.push(`        DATA lv_status_capped TYPE abap_bool VALUE abap_false.`);
  lines.push(`        DATA lv_fkeys_total TYPE i VALUE 0.`);
  lines.push(`        DATA lv_fkeys_capped TYPE abap_bool VALUE abap_false.`);
  // GUI_STATUS, not a bare CHAR40: STATUS is untyped (TYPE ANY), and only
  // the GUI_STATUS form was confirmed live — do not pass ls_sta-code directly.
  lines.push(`        DATA lv_status TYPE gui_status.`);
  lines.push(`        LOOP AT lt_sta INTO ls_sta.`);
  lines.push(`          IF lv_status_done >= ${UI_STATUS_LOOP_CAP}.`);
  lines.push(`            lv_status_capped = abap_true.`);
  lines.push(`            EXIT.`);
  lines.push(`          ENDIF.`);
  lines.push(`          lv_status = ls_sta-code.`);
  lines.push(`          CLEAR lt_fkeys.`);
  lines.push(`          CALL FUNCTION 'RS_CUA_GET_STATUS'`);
  lines.push(`            EXPORTING`);
  lines.push(`              program = lv_program`);
  lines.push(`              status  = lv_status`);
  lines.push(`            TABLES`);
  lines.push(`              fkeys = lt_fkeys`);
  lines.push(`            EXCEPTIONS`);
  lines.push(`              not_found_program = 1`);
  lines.push(`              not_found_status  = 2`);
  lines.push(`              recursive_menues  = 3`);
  lines.push(`              empty_list        = 4`);
  lines.push(`              not_found_menu    = 5`);
  lines.push(`              OTHERS            = 6.`);
  lines.push(`          IF sy-subrc = 0.`);
  lines.push(`            LOOP AT lt_fkeys INTO DATA(ls_fkey).`);
  // status= is attributed from lv_status (sent to the FM), not
  // RSEUL_KEYS-STATUS (unverified whether the FM populates it). Empty-CODE
  // rows (unassigned function-key slots) are dropped.
  lines.push(`              IF ls_fkey-code IS NOT INITIAL.`);
  // Stops EMITTING at the cap but keeps walking lt_sta/lt_fkeys, so
  // lv_fkeys_total (and COUNT_FKEYS) always equals rows actually written,
  // never rows encountered — see UI_FKEY_ROW_CAP's doc comment.
  lines.push(`                IF lv_fkeys_total < ${UI_FKEY_ROW_CAP}.`);
  lines.push(
    `                  mo_out->write( |${UI_LINE_PREFIX}FKEY status=[{ lv_status }] code=[{ ls_fkey-code }] text=[{ ls_fkey-text }] quickinfo=[{ ls_fkey-quickinfo }]| ).`,
  );
  lines.push(`                  lv_fkeys_total = lv_fkeys_total + 1.`);
  lines.push(`                ELSE.`);
  lines.push(`                  lv_fkeys_capped = abap_true.`);
  lines.push(`                ENDIF.`);
  lines.push(`              ENDIF.`);
  lines.push(`            ENDLOOP.`);
  lines.push(`          ENDIF.`);
  lines.push(`          lv_status_done = lv_status_done + 1.`);
  lines.push(`        ENDLOOP.`);
  lines.push(`        mo_out->write( |${UI_LINE_PREFIX}COUNT_FKEYS { lv_fkeys_total }| ).`);
  lines.push(
    `        mo_out->write( |${UI_LINE_PREFIX}FKEY_CAP emitted=[{ lv_fkeys_total }] capped=[{ lv_fkeys_capped }]| ).`,
  );
  lines.push(
    `        mo_out->write( |${UI_LINE_PREFIX}STATUS_LOOP done=[{ lv_status_done }] total=[{ lines( lt_sta ) }] capped=[{ lv_status_capped }]| ).`,
  );
  lines.push(`      ENDIF.`);
  lines.push(`    ENDIF.`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// ABAP source generation — press (mode 2)
// ---------------------------------------------------------------------------

/** Emits a screen-START `BDCDATA` row: PROGRAM/DYNPRO/DYNBEGIN='X'; FNAM/FVAL stay empty. Together with {@link bdcFieldLines}, the only two places that append to `lt_bdc`. */
function bdcScreenStartLines(program: string, dynpro: string): string[] {
  const p = escapeAbapLiteral(program);
  const d = escapeAbapLiteral(dynpro);
  return [`    APPEND VALUE #( program = '${p}' dynpro = '${d}' dynbegin = 'X' ) TO lt_bdc.`];
}

/** Emits a field-SET `BDCDATA` row: FNAM/FVAL only, DYNBEGIN stays space. `rawValue` is routed through `abapLiteralAssignmentLines` via `lv_fval` rather than interpolated directly, so it can't exceed the 255-char ADT line limit. */
function bdcFieldLines(fnam: string, rawValue: string): string[] {
  const f = escapeAbapLiteral(fnam);
  return [...abapLiteralAssignmentLines("lv_fval", rawValue, "    "), `    APPEND VALUE #( fnam = '${f}' fval = lv_fval ) TO lt_bdc.`];
}

function pressBody(q: UiPressQuery): string {
  const tcode = escapeAbapLiteral(assertTcode(q.tcode));
  const lines: string[] = [];
  lines.push(`    DATA lt_bdc TYPE STANDARD TABLE OF bdcdata.`);
  lines.push(`    DATA lt_msgcoll TYPE STANDARD TABLE OF bdcmsgcoll.`);
  lines.push(`    DATA lv_fval TYPE string.`);
  lines.push(`    CLEAR: lt_bdc, lt_msgcoll, lv_fval.`);

  for (const screen of q.screens) {
    const program = assertProgramName(screen.program);
    const dynpro = assertDynpro(screen.dynpro);
    lines.push(...bdcScreenStartLines(program, dynpro));
    if (screen.cursorField !== undefined) {
      lines.push(...bdcFieldLines("BDC_CURSOR", assertFieldName(screen.cursorField)));
    }
    for (const f of screen.fields) {
      lines.push(...bdcFieldLines(assertFieldName(f.fieldName), assertFieldValue(f.value)));
    }
    if (screen.okCode !== undefined) {
      lines.push(...bdcFieldLines("BDC_OKCODE", assertOkCode(screen.okCode)));
    }
  }

  lines.push(``);
  lines.push(`    " NEVER add WITHOUT AUTHORITY-CHECK here — SAP's own authority check inside`);
  lines.push(`    " the driven transaction is the real security boundary for this bridge.`);
  lines.push(`    CALL TRANSACTION '${tcode}' USING lt_bdc MODE 'N' UPDATE 'S'`);
  lines.push(`                          MESSAGES INTO lt_msgcoll.`);
  lines.push(`    " sy-subrc here is CALL TRANSACTION's own MESSAGES-table-specific code, NOT`);
  lines.push(`    " the plain 0/1/2/3 range documented for a bare CALL TRANSACTION (no MESSAGES`);
  lines.push(`    " table): 1001 specifically means "ran out of batch input data for a dynpro"`);
  lines.push(`    " — see the 00/344 message decoded below (TS-side: UiTranscriptResult.press.stalled).`);
  lines.push(`    mo_out->write( |${UI_LINE_PREFIX}SUBRC { sy-subrc }| ).`);
  lines.push(`    mo_out->write( |${UI_LINE_PREFIX}ROWCOUNT { lines( lt_bdc ) }| ).`);
  lines.push(`    LOOP AT lt_msgcoll INTO DATA(ls_msg).`);
  lines.push(`      DATA lv_msgtext TYPE string.`);
  lines.push(`      CLEAR lv_msgtext.`);
  lines.push(`      MESSAGE ID ls_msg-msgid TYPE ls_msg-msgtyp NUMBER ls_msg-msgnr`);
  lines.push(`        WITH ls_msg-msgv1 ls_msg-msgv2 ls_msg-msgv3 ls_msg-msgv4`);
  lines.push(`        INTO lv_msgtext.`);
  lines.push(`      mo_out->write( |${UI_LINE_PREFIX}MSG msgtyp=[{ ls_msg-msgtyp }] msgid=[{ ls_msg-msgid }] | &&`);
  lines.push(`        |msgnr=[{ ls_msg-msgnr }] msgv1=[{ ls_msg-msgv1 }] msgv2=[{ ls_msg-msgv2 }] | &&`);
  lines.push(`        |msgv3=[{ ls_msg-msgv3 }] msgv4=[{ ls_msg-msgv4 }] text=[{ lv_msgtext }]| ).`);
  lines.push(`    ENDLOOP.`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Full bridge source
// ---------------------------------------------------------------------------

/** Generates the full bridge class source for `query`. Byte-stable per query (no timestamps/counters) so `writeObject` can skip an unchanged PUT. */
export function uiBridgeSource(query: UiBridgeQuery, className: string): string {
  const cls = assertPlainName(className, "Bridge class name").toLowerCase();
  validateQuery(query);

  const body = query.mode === "screen" ? screenBody(query) : pressBody(query);

  const source = `CLASS ${cls} DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
  PRIVATE SECTION.
    DATA mo_out TYPE REF TO if_oo_adt_classrun_out.
    "! Flattens any elementary value or flat structure into a single
    "! \`NAME=[value] \` bracket-formatted line via RTTI, instead of naming a
    "! structure's components ahead of time — see this file's module header
    "! for why D021S/RPY_DYHEAD/RPY_DYFLOW are handled this way. A single
    "! unconvertible component (e.g. an unexpected nested structure) is
    "! caught locally and reported as \`(unconvertible)\` rather than losing
    "! the rest of the dump.
    METHODS flatten_any
      IMPORTING iv_data        TYPE any
      RETURNING VALUE(rv_text) TYPE string.
ENDCLASS.

CLASS ${cls} IMPLEMENTATION.

  METHOD flatten_any.
    DATA(lo_type) = cl_abap_typedescr=>describe_by_data( iv_data ).
    IF lo_type->kind = cl_abap_typedescr=>kind_struct.
      DATA(lo_struct) = CAST cl_abap_structdescr( lo_type ).
      LOOP AT lo_struct->components INTO DATA(ls_comp).
        ASSIGN COMPONENT ls_comp-name OF STRUCTURE iv_data TO FIELD-SYMBOL(<fs>).
        IF sy-subrc = 0.
          TRY.
              rv_text = rv_text && |{ ls_comp-name }=[{ <fs> }] |.
            CATCH cx_root.
              rv_text = rv_text && |{ ls_comp-name }=[(unconvertible)] |.
          ENDTRY.
        ENDIF.
      ENDLOOP.
    ELSE.
      TRY.
          rv_text = |VALUE=[{ iv_data }]|.
        CATCH cx_root.
          rv_text = |VALUE=[(unconvertible)]|.
      ENDTRY.
    ENDIF.
  ENDMETHOD.

  METHOD if_oo_adt_classrun~main.
*   Generated by abapsmith (abap_ui, mode=${query.mode}). Do not edit — this
*   class is regenerated from src/adt/ui-runtime.ts whenever its content
*   hash changes.
    mo_out = out.
    TRY.
${body}
      CATCH cx_root INTO DATA(lx).
        out->write( |${ERR_LINE_PREFIX}EXCEPTION { cl_abap_classdescr=>get_class_name( lx ) }: { lx->get_text( ) }| ).
    ENDTRY.
  ENDMETHOD.

ENDCLASS.
`;

  assertNoOverlongLines(source, className);
  return source;
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

/** One decoded `BDCMSGCOLL` row from a `press` run. */
export interface UiMessage {
  msgType: string;
  msgId: string;
  msgNumber: string;
  msgv1: string;
  msgv2: string;
  msgv3: string;
  msgv4: string;
  /** Built ABAP-side via `MESSAGE ... INTO` — see the module header for why not `MESSAGE_TEXT_BUILD`. */
  text: string;
}

/**
 * The `sy-subrc = 1001` + message `00 344` "ran out of scripted screens"
 * signal, decoded into the program/dynpro the script needs next.
 * `program`/`dynpro` come from `MSGV1`/`MSGV2`, not from the locale-dependent
 * decoded text.
 */
export interface UiStalledAt {
  program: string;
  dynpro: string;
  /** Plain-language next step naming the `screen` call that would resolve it. */
  hint: string;
}

/** `press`-mode result: the `CALL TRANSACTION` outcome. */
export interface UiPressResult {
  subrc: number;
  rowCount?: number;
  messages: UiMessage[];
  stalled?: UiStalledAt;
}

/**
 * `screen`-mode result: everything read off one dynpro. `header`/`fields`/
 * `flow`/`statusList` are raw `NAME=value` maps off `flatten_any`.
 * `functions`/`fkeys` are a fixed, narrow projection instead — a full RTTI
 * dump measured ~600 rows / ~7,000 pairs on SAPLSETB, risking
 * `buildResponse`'s maxChars budget.
 */
export interface UiTranscriptResult {
  tcode?: {
    tcode: string;
    program: string;
    dynpro: string;
    cinfo: string;
    kind: string;
    /** `true` for cinfo `'00'`, `false` for `'80'`, `undefined` for anything else (mechanism not confirmed). */
    bdcApplies?: boolean;
  };
  resolved?: { program: string; dynpro: string };
  header?: Record<string, string>;
  fieldsCount?: number;
  fields: Record<string, string>[];
  flowCount?: number;
  flow: Record<string, string>[];
  statusCount?: number;
  statusList: Record<string, string>[];
  /** Program-wide function codes from `fun` (not tied to one status). Fixed `{code, text, type}` projection off `RSMPE_FUNT`, not `flatten_any` (that table alone measured 176 rows on a real program). */
  functionsCount?: number;
  functions: Record<string, string>[];
  /**
   * Union of per-status buttons across up to {@link UI_STATUS_LOOP_CAP}
   * statuses. Fixed `{status, code, text, quickinfo}` projection off
   * `RSEUL_KEYS`; `status` is attributed from the loop variable sent to
   * RS_CUA_GET_STATUS, not `RSEUL_KEYS-STATUS` (unverified whether that FM
   * populates it). Empty-`code` rows are dropped. `fkeysCount` totals across
   * all statuses, not per status.
   */
  fkeysCount?: number;
  fkeys: Record<string, string>[];
  /** Capped per-status RS_CUA_GET_STATUS loop summary. When `capped`, `fkeys` is incomplete — callers must disclose this. */
  statusLoop?: { done: number; total: number; capped: boolean };
  /**
   * {@link UI_FKEY_ROW_CAP} row-cap summary — a separate fact from
   * `statusLoop`: that says whether every status got a lookup, this says
   * whether every found button was reported (either, both, or neither can be
   * true; SAPLSVIM trips both — see archive). When `capped`, `fkeys` is
   * incomplete — callers must disclose this.
   */
  fkeyCap?: { emitted: number; capped: boolean };
  /** Set when RS_CUA_INTERNAL_FETCH returned sy-subrc=1 (NOT_FOUND) — normal for a program with no GUI status, not an error. */
  noCua?: { program: string; note: string };
  press?: UiPressResult;
  diagnostics: string[];
  droppedLines: number;
}

export function parseUiTranscript(raw: string): UiTranscriptResult {
  const diagnostics: string[] = [];
  let droppedLines = 0;
  const tagged: string[] = [];

  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith(UI_LINE_PREFIX)) {
      tagged.push(line.slice(UI_LINE_PREFIX.length));
    } else if (line.startsWith(ERR_LINE_PREFIX)) {
      diagnostics.push(line.trim());
    } else if (line.trim() === "") {
      // blank line — framing noise, not counted as dropped
    } else {
      droppedLines++;
    }
  }

  const result: UiTranscriptResult = {
    fields: [],
    flow: [],
    statusList: [],
    functions: [],
    fkeys: [],
    diagnostics,
    droppedLines,
  };

  const messages: UiMessage[] = [];
  let subrc: number | undefined;
  let rowCount: number | undefined;

  for (const line of tagged) {
    const spaceIdx = line.indexOf(" ");
    const head = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const remainder = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1);
    const fields = parseBracketFields(remainder);

    switch (head) {
      case "TCODE": {
        const cinfo = fields.cinfo ?? "";
        result.tcode = {
          tcode: fields.tcode ?? "",
          program: fields.program ?? "",
          dynpro: fields.dynpro ?? "",
          cinfo,
          kind: fields.kind ?? "",
          bdcApplies: cinfo === "00" ? true : cinfo === "80" ? false : undefined,
        };
        break;
      }
      case "RESOLVED":
        result.resolved = { program: fields.program ?? "", dynpro: fields.dynpro ?? "" };
        break;
      case "HEADER":
        result.header = fields;
        break;
      case "COUNT_FIELDS": {
        const n = Number(remainder.trim());
        if (!Number.isNaN(n)) result.fieldsCount = n;
        break;
      }
      case "FIELD":
        result.fields.push(fields);
        break;
      case "COUNT_FLOW": {
        const n = Number(remainder.trim());
        if (!Number.isNaN(n)) result.flowCount = n;
        break;
      }
      case "FLOW":
        result.flow.push(fields);
        break;
      case "COUNT_STATUS": {
        const n = Number(remainder.trim());
        if (!Number.isNaN(n)) result.statusCount = n;
        break;
      }
      case "STATUS":
        result.statusList.push(fields);
        break;
      case "COUNT_FUNCTIONS": {
        const n = Number(remainder.trim());
        if (!Number.isNaN(n)) result.functionsCount = n;
        break;
      }
      case "FUNCTION":
        result.functions.push(fields);
        break;
      case "COUNT_FKEYS": {
        const n = Number(remainder.trim());
        if (!Number.isNaN(n)) result.fkeysCount = n;
        break;
      }
      case "FKEY":
        result.fkeys.push(fields);
        break;
      case "FKEY_CAP": {
        const emitted = Number(fields.emitted ?? "");
        const capped = fields.capped === "X" || fields.capped === "1" || fields.capped === "true";
        if (!Number.isNaN(emitted)) {
          result.fkeyCap = { emitted, capped };
        }
        break;
      }
      case "STATUS_LOOP": {
        const done = Number(fields.done ?? "");
        const total = Number(fields.total ?? "");
        const capped = fields.capped === "X" || fields.capped === "1" || fields.capped === "true";
        if (!Number.isNaN(done) && !Number.isNaN(total)) {
          result.statusLoop = { done, total, capped };
        }
        break;
      }
      case "NOCUA":
        result.noCua = { program: fields.program ?? "", note: fields.note ?? "" };
        break;
      case "SUBRC": {
        const n = Number(remainder.trim());
        if (!Number.isNaN(n)) subrc = n;
        break;
      }
      case "ROWCOUNT": {
        const n = Number(remainder.trim());
        if (!Number.isNaN(n)) rowCount = n;
        break;
      }
      case "MSG":
        messages.push({
          msgType: fields.msgtyp ?? "",
          msgId: fields.msgid ?? "",
          msgNumber: fields.msgnr ?? "",
          msgv1: fields.msgv1 ?? "",
          msgv2: fields.msgv2 ?? "",
          msgv3: fields.msgv3 ?? "",
          msgv4: fields.msgv4 ?? "",
          text: fields.text ?? "",
        });
        break;
      default:
        // Unrecognised narration line — not an error, contributes nothing structured.
        break;
    }
  }

  if (subrc !== undefined) {
    const stallMsg = messages.find((m) => m.msgId === "00" && m.msgNumber === "344");
    const stalled: UiStalledAt | undefined =
      subrc === 1001 && stallMsg
        ? {
            program: stallMsg.msgv1,
            dynpro: stallMsg.msgv2,
            hint:
              `Ran out of scripted screens at program=${stallMsg.msgv1} dynpro=${stallMsg.msgv2}. ` +
              `Call abap_ui with mode="screen", program="${stallMsg.msgv1}", dynpro="${stallMsg.msgv2}" ` +
              "to learn that screen's fields and buttons, then extend the screens array and press again.",
          }
        : undefined;
    result.press = {
      subrc,
      ...(rowCount !== undefined ? { rowCount } : {}),
      messages,
      ...(stalled ? { stalled } : {}),
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface UiBridgeResult {
  query: UiBridgeQuery;
  bridgeClass: string;
  bridgeRefreshed: boolean;
  durationMs: number;
  transcript: UiTranscriptResult;
  outputComplete: boolean;
  bodyBytes: number;
}

/**
 * Deploys (if needed) and runs the UI bridge for `query`, returning the
 * parsed transcript. Mirrors `runFpmRead`'s shape: `deployBridge` +
 * `executeBridge` do all write/activate/execute gating on the generated
 * $TMP bridge class itself.
 *
 * No second, domain-level safety gate is added for `press`'s
 * `CALL TRANSACTION`: unlike `ddic-bridge.ts`'s `assertBridgeMutation`
 * (which gates one named, newly-created DDIC object), a driven transaction's
 * blast radius is unbounded and not expressible as one `SafetyTarget` — the
 * tcode driven is typically a standard SAP transaction, not a Z-namespace
 * object the allowlist vocabulary reasons about. The bridge never emits
 * `WITHOUT AUTHORITY-CHECK`, so SAP's own authorization checks inside the
 * driven transaction remain the enforcement point; the `execute` gate on
 * the bridge class itself is what stands between an untrusted caller and
 * running this bridge at all.
 */
export async function runUiBridge(
  conn: AbapConnection,
  query: UiBridgeQuery,
  gate: SafetyGate,
): Promise<UiBridgeResult> {
  const started = Date.now();
  const className = uiBridgeClassName(query);
  const source = uiBridgeSource(query, className);

  const deployed = await deployBridge(conn, gate, {
    className,
    source,
    description: `abapsmith UI bridge (mode=${query.mode})`,
    what: "Activation of the generated UI bridge",
    hint:
      query.mode === "screen"
        ? "The bridge reads dynpro/status metadata via RPY_DYNPRO_READ and RS_CUA_GET_STATUS — a " +
          "syntax error here is unlikely to be about caller input (program/dynpro/tcode are " +
          "validated and charset-restricted before any ABAP is generated) and more likely points " +
          "at this module's own template (see ui-runtime.ts's module header for what is confirmed " +
          "vs. best-effort)."
        : "The bridge builds a BDCDATA table and runs CALL TRANSACTION — a syntax error here is " +
          "unlikely to be about caller input (every field/program/dynpro/OK-code is validated " +
          "before a line of ABAP is generated) and more likely points at this module's own template.",
    verify: (activation) => verifyBridgeActivation(activation, className, "UI bridge", { mode: query.mode }),
  });
  const { bridgeRefreshed } = deployed;

  const run = await executeBridge(conn, gate, deployed);
  const transcript = parseUiTranscript(run.output);

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
