/**
 * Assembles the static `ZCL_ZMCP_FLUID_CORE` body class from one
 * `CoreAbapPart` per action family (select/describe_fm/call_fm). Same
 * `scan()`-into-`gt_arg` design as `classic/abap-core.ts`'s
 * `ZCL_ZMCP_FLUID_CLASSIC`, extended one step: a JSON object value (used
 * only by `core.call_fm`'s `params`) is flattened too, as `key/subkey`
 * rows, alongside the existing string/array/scalar handling. Nested objects
 * hold scalars only — `core.call_fm`'s `params` is a flat map of parameter
 * name to string value, never a deeper structure.
 *
 * Unlike `ClassicAbapPart`, an action's name need not equal its method name
 * (`select` -> `do_select`, `describe_fm` -> `do_describe_fm`, `call_fm` ->
 * `do_call_fm`) — `CoreAbapPart.actions` carries both.
 *
 * `run` never carries a `submit` action and never will: `core` reads and
 * calls what already exists on the target system (a table, a function
 * module) — it does not accept and activate caller-supplied ABAP source
 * the way a generated invoker or a plugin body class does.
 */
import { AbapError } from "../../../errors.js";
import { ABAP_SOURCE_LINE_MAX } from "../../../ddic-transcript.js";
import { ECHO_LINE_MAX, truncateForDisplay } from "../../../../truncate.js";

export interface CoreAbapPart {
  /** action name -> private method name, e.g. { action: "select", method: "do_select" } */
  readonly actions: readonly { readonly action: string; readonly method: string }[];
  /** One or more `METHOD ... ENDMETHOD.` blocks, 2-space indented, matching the class's own style. */
  readonly source: string;
}

const CLASS_NAME = "zcl_zmcp_fluid_core";

const CORE_METHODS = `  METHOD run.
    CLEAR gt_arg.
    gv_failed = abap_false.
    gv_step = iv_action.
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
    DATA lv_sub   TYPE string.
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
      ELSEIF lv_ch = '{'.
        lv_off = lv_off + 1.
        lv_ch = iv_json+lv_off(1).
        IF lv_ch <> '}'.
          WHILE lv_off < lv_len.
            lv_sub = read_string( EXPORTING iv_json = iv_json CHANGING cv_off = lv_off ).
            lv_off = lv_off + 1.
            lv_ch = iv_json+lv_off(1).
            IF lv_ch = '"'.
              lv_val = read_string( EXPORTING iv_json = iv_json CHANGING cv_off = lv_off ).
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
            ENDIF.
            CLEAR ls_arg.
            ls_arg-path = |{ lv_key }/{ lv_sub }|.
            ls_arg-value = lv_val.
            INSERT ls_arg INTO TABLE gt_arg.
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
            rv_value = rv_value && lv_esc.
        ENDCASE.
        lv_off = lv_off + 1.
      ELSE.
        rv_value = rv_value && lv_ch.
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
    CLEAR rv_count.
    lv_pattern = |{ iv_path }/*|.
    LOOP AT gt_arg TRANSPORTING NO FIELDS WHERE path CP lv_pattern.
      rv_count = rv_count + 1.
    ENDLOOP.
  ENDMETHOD.

  METHOD num.
    DATA lv_raw TYPE string.
    CLEAR rv_value.
    lv_raw = s( iv_path ).
    IF lv_raw IS INITIAL.
      RETURN.
    ENDIF.
    TRY.
        rv_value = lv_raw.
      CATCH cx_root.
        CLEAR rv_value.
    ENDTRY.
  ENDMETHOD.

  METHOD keys.
    DATA lv_pattern TYPE string.
    DATA lv_plen    TYPE i.
    FIELD-SYMBOLS <ls_arg> TYPE ty_arg.
    CLEAR rt_keys.
    lv_pattern = |{ iv_prefix }/*|.
    lv_plen = strlen( iv_prefix ) + 1.
    LOOP AT gt_arg ASSIGNING <ls_arg> WHERE path CP lv_pattern.
      APPEND substring( val = <ls_arg>-path off = lv_plen ) TO rt_keys.
    ENDLOOP.
  ENDMETHOD.

  METHOD str.
    CLEAR rv_text.
    TRY.
        rv_text = iv_value.
      CATCH cx_root.
        CLEAR rv_text.
    ENDTRY.
  ENDMETHOD.

  METHOD to_json.
    DATA lo_type   TYPE REF TO cl_abap_typedescr.
    DATA lo_struct TYPE REF TO cl_abap_structdescr.
    DATA lv_first  TYPE abap_bool.
    DATA ls_comp   TYPE abap_compdescr.
    FIELD-SYMBOLS <lv_any> TYPE any.
    FIELD-SYMBOLS <lt_any> TYPE ANY TABLE.

    CLEAR rv_json.
    lo_type = cl_abap_typedescr=>describe_by_data( iv_data ).
    CASE lo_type->kind.
      WHEN cl_abap_typedescr=>kind_elem.
        rv_json = |"{ zcl_zmcp_fluid_rt=>esc( str( iv_data ) ) }"|.
      WHEN cl_abap_typedescr=>kind_struct.
        lo_struct ?= lo_type.
        rv_json = '{'.
        lv_first = abap_true.
        LOOP AT lo_struct->components INTO ls_comp.
          ASSIGN COMPONENT ls_comp-name OF STRUCTURE iv_data TO <lv_any>.
          IF sy-subrc <> 0.
            CONTINUE.
          ENDIF.
          IF lv_first = abap_false.
            rv_json = rv_json && ','.
          ENDIF.
          lv_first = abap_false.
          rv_json = rv_json && |"{ zcl_zmcp_fluid_rt=>esc( ls_comp-name ) }":| && to_json( <lv_any> ).
        ENDLOOP.
        rv_json = rv_json && '}'.
      WHEN cl_abap_typedescr=>kind_table.
        ASSIGN iv_data TO <lt_any>.
        rv_json = '['.
        lv_first = abap_true.
        LOOP AT <lt_any> ASSIGNING <lv_any>.
          IF lv_first = abap_false.
            rv_json = rv_json && ','.
          ENDIF.
          lv_first = abap_false.
          rv_json = rv_json && to_json( <lv_any> ).
        ENDLOOP.
        rv_json = rv_json && ']'.
      WHEN OTHERS.
        rv_json = 'null'.
    ENDCASE.
  ENDMETHOD.

  METHOD fm_params.
    DATA lv_func TYPE rs38l-name.
    DATA ls_par  TYPE ty_par.
    CLEAR rt_par.
    lv_func = iv_func.
    SELECT paramtype, parameter, structure, optional, defaultval
      FROM fupararef
      INTO TABLE @DATA(lt_raw)
      WHERE funcname = @lv_func
        AND r3state  = 'A'
      ORDER BY paramtype, pposition.
    LOOP AT lt_raw INTO DATA(ls_raw).
      CLEAR ls_par.
      ls_par-name     = ls_raw-parameter.
      ls_par-ptype    = ls_raw-paramtype.
      ls_par-typename = ls_raw-structure.
      ls_par-optional = boolc( ls_raw-optional = 'X' ).
      ls_par-defval   = ls_raw-defaultval.
      APPEND ls_par TO rt_par.
    ENDLOOP.
  ENDMETHOD.

  METHOD fail.
    gv_failed = abap_true.
    zcl_zmcp_fluid_rt=>err( iv_kind = 'action'
                            iv_step = gv_step
                            iv_text = iv_text ).
  ENDMETHOD.`;

export function coreBodySource(parts: readonly CoreAbapPart[]): string {
  const allActions = parts.flatMap((p) => p.actions);

  const methodDecls = allActions.map((a) => `    CLASS-METHODS ${a.method}.`).join("\n");
  const caseArms = allActions.map((a) => `        WHEN '${a.action}'.\n          ${a.method}( ).`).join("\n");
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
    TYPES: BEGIN OF ty_par,
             name     TYPE string,
             ptype    TYPE string,
             typename TYPE string,
             optional TYPE abap_bool,
             defval   TYPE string,
           END OF ty_par.
    TYPES ty_par_tab TYPE STANDARD TABLE OF ty_par WITH DEFAULT KEY.

    CLASS-DATA gt_arg    TYPE SORTED TABLE OF ty_arg WITH UNIQUE KEY path.
    CLASS-DATA gv_failed TYPE abap_bool.
    CLASS-DATA gv_step   TYPE string.

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
    CLASS-METHODS num
      IMPORTING
        iv_path TYPE string
      RETURNING
        VALUE(rv_value) TYPE i.
    CLASS-METHODS n
      IMPORTING
        iv_path TYPE string
      RETURNING
        VALUE(rv_count) TYPE i.
    CLASS-METHODS keys
      IMPORTING
        iv_prefix TYPE string
      RETURNING
        VALUE(rt_keys) TYPE string_table.
    CLASS-METHODS str
      IMPORTING
        iv_value TYPE any
      RETURNING
        VALUE(rv_text) TYPE string.
    CLASS-METHODS to_json
      IMPORTING
        iv_data TYPE any
      RETURNING
        VALUE(rv_json) TYPE string.
    CLASS-METHODS fm_params
      IMPORTING
        iv_func TYPE string
      RETURNING
        VALUE(rt_par) TYPE ty_par_tab.
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
        `Generated core body source line ${i + 1} is ${line.length} chars, over ABAP's ` +
          `${ABAP_SOURCE_LINE_MAX}-char class-source limit: ${excerpt}`,
        { line: i + 1, length: line.length, excerpt },
      );
    }
  });

  return source;
}
