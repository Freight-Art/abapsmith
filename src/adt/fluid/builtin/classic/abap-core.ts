/**
 * Assembles the static `ZCL_ZMCP_FLUID_CLASSIC` body class from one
 * `ClassicAbapPart` per operation family (view/transaction/index/package/
 * transport/exists). The class never depends on call arguments — every
 * caller-supplied value is read at runtime out of `iv_json` via `scan()` +
 * the `s()`/`b()`/`n()` accessors, so the deployed source is cacheable by
 * content hash the same way `ZCL_ZMCP_FLUID_RT` is.
 *
 * `scan()` is a single-pass, character-at-a-time JSON reader over the
 * canonical shape `canonicalArgsJson` produces (no whitespace, sorted keys,
 * `undefined` omitted) — no `FIND REGEX`, unlike `run.ts`'s
 * `get_json_string` stopgap. It flattens a top-level object into
 * `path -> raw value` rows (`gt_arg`); a string-array value is flattened to
 * `key/0`, `key/1`, ... rows. `read_string` decodes one JSON string literal
 * (including `\uXXXX`) and is shared by key, scalar-string and
 * array-element decoding.
 *
 * That string-array handling is the ONLY array shape `scan()` understands —
 * it never recurses into an object, so a genuine array of objects is not
 * parsed at all (every per-element property silently reads back empty).
 * `classic`'s manifest (`../classic.ts`) sets `FluidManifest.flatArgs`, so
 * data that is naturally an array of objects — e.g. `shlp-create.ts`'s
 * `buildArgs`, for `fields`/`includes`/`assignments` — is pre-flattened by
 * the dispatcher, via `flattenScanArgs` (`src/adt/fluid/flat-args.ts`),
 * before the args JSON is ever built: the array becomes a bare `key` (the
 * element count, read with `n()`) plus one `key/{i}/{prop}` scalar entry
 * per element property (read with `s()`/`b()`). No individual caller does
 * this flattening itself, and `scan()` itself is not taught to recurse, on
 * purpose — that would touch this shared runtime that every other
 * classic-bridge action depends on, for the sake of one caller's shape.
 *
 * `n()` therefore has to count two different shapes correctly. A plain
 * string array (`abap-view.ts`'s and `abap-index.ts`'s `fields`) produces
 * one `key/{i}` row per element and nothing at the bare `key` — for
 * that shape `n()` counts the `key/*` rows. A `flattenScanArgs`-flattened
 * array of objects produces several `key/{i}/{prop}` rows per element, so
 * counting `key/*` rows would overcount by the property count; instead
 * `flattenScanArgs` states its own length as a plain number at the bare
 * `key`, and `n()` reads that
 * directly when present. `n()` picks the branch by checking whether a
 * digits-only value sits at the bare path, falling back to the row count
 * otherwise.
 */
import { AbapError } from "../../../errors.js";
import { ABAP_SOURCE_LINE_MAX } from "../../../ddic-transcript.js";
import { ECHO_LINE_MAX, truncateForDisplay } from "../../../../truncate.js";

export interface ClassicAbapPart {
  /** Method names this part implements, e.g. ["create_view", "delete_view"] — CASE arms in `run` dispatch to these 1:1. */
  readonly methods: readonly string[];
  /** One or more `METHOD ... ENDMETHOD.` blocks, 2-space indented, matching the class's own style. */
  readonly source: string;
}

const CLASS_NAME = "zcl_zmcp_fluid_classic";

const CORE_METHODS = `  METHOD run.
    CLEAR gt_arg.
    gv_failed = abap_false.
    TRY.
        scan( iv_json ).
        CASE iv_action.
{{CASE_ARMS}}
          WHEN OTHERS.
            fail( |unknown action { iv_action }| ).
        ENDCASE.
      CATCH cx_root INTO DATA(lx_err).
        fail( lx_err->get_text( ) ).
    ENDTRY.
    IF gv_failed = abap_true.
      ROLLBACK WORK.
    ENDIF.
  ENDMETHOD.

  METHOD scan.
    DATA lv_len   TYPE i.
    DATA lv_off   TYPE i.
    DATA lv_ch    TYPE c LENGTH 1.
    DATA lv_key   TYPE string.
    DATA lv_val   TYPE string.
    DATA lv_idx   TYPE i.
    DATA lv_start TYPE i.
    DATA ls_arg   TYPE ty_arg.

    lv_len = strlen( iv_json ).
    IF lv_len < 2.
      RETURN.
    ENDIF.
    lv_off = 1.
    WHILE lv_off < lv_len.
      lv_ch = iv_json+lv_off(1).
      IF lv_ch = '}'.
        RETURN.
      ENDIF.
      lv_key = read_string( EXPORTING iv_json = iv_json CHANGING cv_off = lv_off ).
      lv_off = lv_off + 1.
      lv_ch = iv_json+lv_off(1).
      IF lv_ch = '"'.
        lv_val = read_string( EXPORTING iv_json = iv_json CHANGING cv_off = lv_off ).
        CLEAR ls_arg.
        ls_arg-path = lv_key.
        ls_arg-value = lv_val.
        INSERT ls_arg INTO TABLE gt_arg.
      ELSEIF lv_ch = '['.
        lv_off = lv_off + 1.
        lv_idx = 0.
        lv_ch = iv_json+lv_off(1).
        IF lv_ch <> ']'.
          WHILE lv_off < lv_len.
            lv_val = read_string( EXPORTING iv_json = iv_json CHANGING cv_off = lv_off ).
            CLEAR ls_arg.
            ls_arg-path = |{ lv_key }/{ lv_idx }|.
            ls_arg-value = lv_val.
            INSERT ls_arg INTO TABLE gt_arg.
            lv_idx = lv_idx + 1.
            lv_ch = iv_json+lv_off(1).
            IF lv_ch = ','.
              lv_off = lv_off + 1.
            ELSE.
              EXIT.
            ENDIF.
          ENDWHILE.
        ENDIF.
        lv_off = lv_off + 1.
      ELSE.
        lv_start = lv_off.
        WHILE lv_off < lv_len.
          lv_ch = iv_json+lv_off(1).
          IF lv_ch = ',' OR lv_ch = '}'.
            EXIT.
          ENDIF.
          lv_off = lv_off + 1.
        ENDWHILE.
        lv_val = substring( val = iv_json off = lv_start len = lv_off - lv_start ).
        CLEAR ls_arg.
        ls_arg-path = lv_key.
        ls_arg-value = lv_val.
        INSERT ls_arg INTO TABLE gt_arg.
      ENDIF.
      lv_ch = iv_json+lv_off(1).
      IF lv_ch = ','.
        lv_off = lv_off + 1.
      ELSE.
        RETURN.
      ENDIF.
    ENDWHILE.
  ENDMETHOD.

  METHOD read_string.
    DATA lv_len  TYPE i.
    DATA lv_off  TYPE i.
    DATA lv_ch   TYPE c LENGTH 1.
    DATA lv_esc  TYPE c LENGTH 1.
    DATA lv_hex  TYPE c LENGTH 4.
    DATA lv_x2   TYPE x LENGTH 2.
    DATA lv_xstr TYPE xstring.
    DATA lv_uc   TYPE string.
    DATA lv_crlf TYPE c LENGTH 2.
    DATA lv_cr   TYPE c LENGTH 1.

    lv_crlf = cl_abap_char_utilities=>cr_lf.
    lv_cr = lv_crlf(1).
    lv_len = strlen( iv_json ).
    lv_off = cv_off + 1.
    CLEAR rv_value.
    WHILE lv_off < lv_len.
      lv_ch = iv_json+lv_off(1).
      IF lv_ch = '"'.
        lv_off = lv_off + 1.
        EXIT.
      ELSEIF lv_ch = '\\'.
        lv_off = lv_off + 1.
        lv_esc = iv_json+lv_off(1).
        CASE lv_esc.
          WHEN '"'.
            rv_value = rv_value && '"'.
          WHEN '\\'.
            rv_value = rv_value && '\\'.
          WHEN '/'.
            rv_value = rv_value && '/'.
          WHEN 'b'.
            rv_value = rv_value && cl_abap_char_utilities=>backspace.
          WHEN 'f'.
            rv_value = rv_value && cl_abap_char_utilities=>form_feed.
          WHEN 'n'.
            rv_value = rv_value && cl_abap_char_utilities=>newline.
          WHEN 'r'.
            rv_value = rv_value && lv_cr.
          WHEN 't'.
            rv_value = rv_value && cl_abap_char_utilities=>horizontal_tab.
          WHEN 'u'.
            lv_hex = substring( val = iv_json off = lv_off + 1 len = 4 ).
            lv_x2 = lv_hex.
            lv_xstr = lv_x2.
            CLEAR lv_uc.
            TRY.
                cl_abap_conv_in_ce=>create( input = lv_xstr encoding = 'UTF-16BE' )->read( IMPORTING data = lv_uc ).
              CATCH cx_root.
                lv_uc = '?'.
            ENDTRY.
            rv_value = rv_value && lv_uc.
            lv_off = lv_off + 4.
          WHEN OTHERS.
            rv_value = rv_value && substring( val = iv_json off = lv_off len = 1 ).
        ENDCASE.
        lv_off = lv_off + 1.
      ELSE.
        rv_value = rv_value && substring( val = iv_json off = lv_off len = 1 ).
        lv_off = lv_off + 1.
      ENDIF.
    ENDWHILE.
    cv_off = lv_off.
  ENDMETHOD.

  METHOD s.
    DATA ls_arg TYPE ty_arg.
    CLEAR rv_value.
    READ TABLE gt_arg INTO ls_arg WITH TABLE KEY path = iv_path.
    IF sy-subrc = 0.
      rv_value = ls_arg-value.
    ENDIF.
  ENDMETHOD.

  METHOD b.
    rv_value = boolc( s( iv_path ) = 'true' ).
  ENDMETHOD.

  METHOD n.
    DATA lv_pattern TYPE string.
    DATA lv_exact   TYPE string.
    CLEAR rv_count.
    " A plain string array (abap-view.ts's / abap-index.ts's fields)
    " produces one path/{i} row per element and nothing at the bare path,
    " so it is counted by the wildcard loop below. A pre-flattened array of
    " objects produces several path/{i}/{prop} rows per element, which the
    " wildcard loop would overcount by the property count, so that shape
    " states its own element count as a plain number at the bare path
    " instead. Prefer that exact count when it looks like a genuine
    " digits-only number, so a stray non-numeric value at the bare path can
    " never reach an integer assignment and dump.
    lv_exact = s( iv_path ).
    IF lv_exact IS NOT INITIAL AND lv_exact CO '0123456789'.
      rv_count = lv_exact.
      RETURN.
    ENDIF.
    lv_pattern = |{ iv_path }/*|.
    LOOP AT gt_arg TRANSPORTING NO FIELDS WHERE path CP lv_pattern.
      rv_count = rv_count + 1.
    ENDLOOP.
  ENDMETHOD.

  METHOD line.
    zcl_zmcp_fluid_rt=>out( |"{ zcl_zmcp_fluid_rt=>esc( iv_text ) }"| ).
  ENDMETHOD.

  METHOD fail.
    gv_failed = abap_true.
    line( |ZMCP-DDIC-ERR> { iv_text }| ).
  ENDMETHOD.`;

export function classicBodySource(parts: readonly ClassicAbapPart[]): string {
  const allMethods = parts.flatMap((p) => p.methods);

  const methodDecls = allMethods.map((m) => `    CLASS-METHODS ${m}.`).join("\n");
  const caseArms = allMethods.map((m) => `        WHEN '${m}'.\n          ${m}( ).`).join("\n");
  const bodies = parts.map((p) => p.source).join("\n\n");
  const coreMethods = CORE_METHODS.replace("{{CASE_ARMS}}", caseArms);

  const source = `CLASS ${CLASS_NAME} DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    CLASS-METHODS run
      IMPORTING
        iv_action TYPE string
        iv_json   TYPE string.

  PRIVATE SECTION.
    TYPES: BEGIN OF ty_arg,
             path  TYPE string,
             value TYPE string,
           END OF ty_arg.
    CLASS-DATA gt_arg    TYPE SORTED TABLE OF ty_arg WITH UNIQUE KEY path.
    CLASS-DATA gv_failed TYPE abap_bool.

    CLASS-METHODS scan
      IMPORTING
        iv_json TYPE string.
    CLASS-METHODS read_string
      IMPORTING
        iv_json TYPE string
      CHANGING
        cv_off  TYPE i
      RETURNING
        VALUE(rv_value) TYPE string.
    CLASS-METHODS s
      IMPORTING
        iv_path TYPE string
      RETURNING
        VALUE(rv_value) TYPE string.
    CLASS-METHODS b
      IMPORTING
        iv_path TYPE string
      RETURNING
        VALUE(rv_value) TYPE abap_bool.
    CLASS-METHODS n
      IMPORTING
        iv_path TYPE string
      RETURNING
        VALUE(rv_count) TYPE i.
    CLASS-METHODS line
      IMPORTING
        iv_text TYPE string.
    CLASS-METHODS fail
      IMPORTING
        iv_text TYPE string.
${methodDecls}
ENDCLASS.


CLASS ${CLASS_NAME} IMPLEMENTATION.

${coreMethods}

${bodies}

ENDCLASS.
`;

  source.split("\n").forEach((line, i) => {
    if (line.length > ABAP_SOURCE_LINE_MAX) {
      const excerpt = truncateForDisplay(line, ECHO_LINE_MAX);
      throw new AbapError(
        "CHECK_FAILED",
        `Generated classic body source line ${i + 1} is ${line.length} chars, over ABAP's ` +
          `${ABAP_SOURCE_LINE_MAX}-char class-source limit: ${excerpt}`,
        { line: i + 1, length: line.length, excerpt },
      );
    }
  });

  return source;
}
