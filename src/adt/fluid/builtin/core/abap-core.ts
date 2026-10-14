/**
 * Assembles the static `ZCL_ZMCP_FLUID_CORE` body class from one
 * `CoreAbapPart` per action family (select/describe_fm/call_fm). Same
 * `scan()`-into-`gt_arg` design as `classic/abap-core.ts`'s
 * `ZCL_ZMCP_FLUID_CLASSIC`, extended one step: a JSON object value (used
 * only by `core.call_fm`'s `params`) is flattened too, as `key/subkey`
 * rows, alongside the existing string/array/scalar handling. Nested objects
 * hold scalars only — `core.call_fm`'s `params` is a flat map of parameter
 * name to string value, never a deeper structure. A structured parameter's
 * value is that structure's own JSON object text, which `fill_struct` below
 * re-reads with the same `scan()` (see `abap-fm.ts`).
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
    DATA lv_cname  TYPE string.
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
          lv_cname = ls_comp-name.
          rv_json = rv_json && |"{ zcl_zmcp_fluid_rt=>esc( lv_cname ) }":| && to_json( <lv_any> ).
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
  ENDMETHOD.

  METHOD concrete_type.
    " CREATE DATA TYPE (...) cannot instantiate a generic ABAP type
    " (FUPARAREF sometimes gives one, e.g. CLIKE for a generically typed FM
    " parameter) - only a concrete type works. Substitute a concrete
    " character/byte stand-in for the well-known generic names; anything
    " else is a real (non-generic) type name and passes through untouched.
    DATA lv_upper TYPE string.
    lv_upper = to_upper( iv_type ).
    CASE lv_upper.
      WHEN 'ANY' OR 'DATA' OR 'SIMPLE' OR 'CLIKE' OR 'CSEQUENCE' OR 'C'.
        rv_type = 'string'.
      WHEN 'XSEQUENCE' OR 'X'.
        rv_type = 'xstring'.
      WHEN OTHERS.
        rv_type = iv_type.
    ENDCASE.
  ENDMETHOD.

  METHOD set_elem.
    " Converts one JSON scalar (already unescaped to a string) into one
    " elementary target by the target's own RTTI type. A value that does not
    " fit is reported in ev_error, never silently truncated or rounded.
    DATA lo_elem TYPE REF TO cl_abap_elemdescr.
    DATA lv_v    TYPE string.
    DATA lv_re   TYPE string.
    DATA lv_len  TYPE i.
    DATA lv_int  TYPE string.
    DATA lv_dec  TYPE string.
    DATA lv_dlen TYPE i.
    DATA lv_xs   TYPE xstring.

    CLEAR ev_error.
    lo_elem ?= cl_abap_typedescr=>describe_by_data( cv_target ).
    TRY.
        CASE lo_elem->type_kind.
          WHEN cl_abap_typedescr=>typekind_char.
            lv_len = lo_elem->length / cl_abap_char_utilities=>charsize.
            IF lv_len = 1 AND iv_value = 'true'.
              cv_target = 'X'.
            ELSEIF lv_len = 1 AND iv_value = 'false'.
              CLEAR cv_target.
            ELSEIF strlen( iv_value ) > lv_len.
              ev_error = |value is { strlen( iv_value ) } characters, the component holds { lv_len }|.
            ELSE.
              cv_target = iv_value.
            ENDIF.
          WHEN cl_abap_typedescr=>typekind_string.
            cv_target = iv_value.
          WHEN cl_abap_typedescr=>typekind_num.
            lv_len = lo_elem->length / cl_abap_char_utilities=>charsize.
            lv_v = condense( iv_value ).
            IF lv_v IS INITIAL OR lv_v = 'null'.
              CLEAR cv_target.
            ELSEIF lv_v CN '0123456789' OR strlen( lv_v ) > lv_len.
              ev_error = |value { lv_v } is not at most { lv_len } digits|.
            ELSE.
              cv_target = lv_v.
            ENDIF.
          WHEN cl_abap_typedescr=>typekind_date.
            lv_v = condense( iv_value ).
            IF strlen( lv_v ) = 10 AND lv_v+4(1) = '-' AND lv_v+7(1) = '-'.
              lv_v = lv_v(4) && lv_v+5(2) && lv_v+8(2).
            ENDIF.
            IF lv_v IS INITIAL OR lv_v = 'null' OR lv_v = '00000000'.
              CLEAR cv_target.
            ELSEIF strlen( lv_v ) <> 8 OR lv_v CN '0123456789'
                OR lv_v+4(2) < '01' OR lv_v+4(2) > '12'
                OR lv_v+6(2) < '01' OR lv_v+6(2) > '31'.
              ev_error = |value { lv_v } is not a date in YYYYMMDD form|.
            ELSE.
              cv_target = lv_v.
            ENDIF.
          WHEN cl_abap_typedescr=>typekind_time.
            lv_v = condense( iv_value ).
            IF strlen( lv_v ) = 8 AND lv_v+2(1) = ':' AND lv_v+5(1) = ':'.
              lv_v = lv_v(2) && lv_v+3(2) && lv_v+6(2).
            ENDIF.
            IF lv_v IS INITIAL OR lv_v = 'null'.
              CLEAR cv_target.
            ELSEIF strlen( lv_v ) <> 6 OR lv_v CN '0123456789'
                OR lv_v(2) > '24' OR lv_v+2(2) > '59' OR lv_v+4(2) > '59'.
              ev_error = |value { lv_v } is not a time in HHMMSS form|.
            ELSE.
              cv_target = lv_v.
            ENDIF.
          WHEN cl_abap_typedescr=>typekind_packed
            OR cl_abap_typedescr=>typekind_float
            OR cl_abap_typedescr=>typekind_decfloat16
            OR cl_abap_typedescr=>typekind_decfloat34
            OR cl_abap_typedescr=>typekind_int
            OR cl_abap_typedescr=>typekind_int1
            OR cl_abap_typedescr=>typekind_int2
            OR '8'.
            " '8' is TYPEKIND_INT8, written as its literal so the class does
            " not depend on the constant existing on older releases.
            lv_v = condense( iv_value ).
            IF lv_v IS INITIAL OR lv_v = 'null'.
              CLEAR cv_target.
              RETURN.
            ENDIF.
            lv_v = shift_left( val = lv_v sub = '+' ).
            CASE lo_elem->type_kind.
              WHEN cl_abap_typedescr=>typekind_packed.
                lv_re = '[-+]?[0-9]+(\\.[0-9]+)?'.
              WHEN cl_abap_typedescr=>typekind_float
                OR cl_abap_typedescr=>typekind_decfloat16
                OR cl_abap_typedescr=>typekind_decfloat34.
                lv_re = '[-+]?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?'.
              WHEN OTHERS.
                lv_re = '[-+]?[0-9]+'.
            ENDCASE.
            IF NOT matches( val = lv_v regex = lv_re ).
              ev_error = |value { iv_value } is not a number|.
              RETURN.
            ENDIF.
            IF lo_elem->type_kind = cl_abap_typedescr=>typekind_packed.
              SPLIT lv_v AT '.' INTO lv_int lv_dec.
              lv_dlen = strlen( lv_dec ).
              WHILE lv_dlen > lo_elem->decimals AND substring( val = lv_dec off = lv_dlen - 1 len = 1 ) = '0'.
                lv_dlen = lv_dlen - 1.
              ENDWHILE.
              IF lv_dlen > lo_elem->decimals.
                ev_error = |value { lv_v } has more than { lo_elem->decimals } decimals|.
                RETURN.
              ENDIF.
            ENDIF.
            cv_target = lv_v.
          WHEN cl_abap_typedescr=>typekind_hex
            OR cl_abap_typedescr=>typekind_xstring.
            lv_v = to_upper( condense( iv_value ) ).
            IF lv_v IS INITIAL OR lv_v = 'NULL'.
              CLEAR cv_target.
            ELSEIF lv_v CN '0123456789ABCDEF' OR strlen( lv_v ) MOD 2 <> 0.
              ev_error = |value { iv_value } is not an even-length hex string|.
            ELSEIF lo_elem->type_kind = cl_abap_typedescr=>typekind_hex
               AND strlen( lv_v ) / 2 > lo_elem->length.
              ev_error = |hex value is { strlen( lv_v ) / 2 } bytes, the component holds { lo_elem->length }|.
            ELSE.
              lv_xs = lv_v.
              cv_target = lv_xs.
            ENDIF.
          WHEN OTHERS.
            ev_error = |elementary type kind { lo_elem->type_kind } is not supported|.
        ENDCASE.
      CATCH cx_root.
        ev_error = |value { iv_value } does not fit the component type|.
    ENDTRY.
  ENDMETHOD.

  METHOD fill_struct.
    " Fills cs_data from a JSON object text, keyed by component name. Reads
    " the object with the same scan() as every other argument, into a
    " private copy of gt_arg that is swapped back before returning. scan()
    " goes one object level deep, so a component that is itself a flat
    " structure works (NAME/SUBNAME rows); anything deeper, and any table or
    " reference component, is refused in ev_error. An unknown component name
    " is an error, never ignored.
    DATA lt_save    LIKE gt_arg.
    DATA lt_obj     LIKE gt_arg.
    DATA ls_obj     TYPE ty_arg.
    DATA lo_type    TYPE REF TO cl_abap_typedescr.
    DATA lo_struct  TYPE REF TO cl_abap_structdescr.
    DATA lv_top     TYPE string.
    DATA lv_sub     TYPE string.
    DATA lv_unknown TYPE string.
    DATA lv_err     TYPE string.
    FIELD-SYMBOLS <lv_comp> TYPE any.
    FIELD-SYMBOLS <lv_part> TYPE any.

    CLEAR ev_error.
    lt_save = gt_arg.
    CLEAR gt_arg.
    TRY.
        scan( shift_left( val = iv_json sub = \` \` ) ).
      CATCH cx_root.
        gt_arg = lt_save.
        ev_error = 'value is not a well-formed JSON object'.
        RETURN.
    ENDTRY.
    lt_obj = gt_arg.
    gt_arg = lt_save.

    lo_struct ?= cl_abap_typedescr=>describe_by_data( cs_data ).

    LOOP AT lt_obj INTO ls_obj.
      SPLIT ls_obj-path AT '/' INTO lv_top lv_sub.
      lv_top = to_upper( lv_top ).
      READ TABLE lo_struct->components TRANSPORTING NO FIELDS WITH KEY name = lv_top.
      IF sy-subrc <> 0 AND NOT lv_unknown CS | { lv_top } |.
        lv_unknown = lv_unknown && | { lv_top } |.
      ENDIF.
    ENDLOOP.
    IF lv_unknown IS NOT INITIAL.
      ev_error = |unknown component(s){ condense( lv_unknown ) } (core.describe_fm lists the components)|.
      RETURN.
    ENDIF.

    LOOP AT lt_obj INTO ls_obj.
      SPLIT ls_obj-path AT '/' INTO lv_top lv_sub.
      lv_top = to_upper( lv_top ).
      lv_sub = to_upper( lv_sub ).
      IF ls_obj-value = 'null'.
        CONTINUE.
      ENDIF.
      ASSIGN COMPONENT lv_top OF STRUCTURE cs_data TO <lv_comp>.
      IF sy-subrc <> 0.
        ev_error = |unknown component { lv_top }|.
        RETURN.
      ENDIF.
      lo_type = cl_abap_typedescr=>describe_by_data( <lv_comp> ).
      CASE lo_type->kind.
        WHEN cl_abap_typedescr=>kind_elem.
          IF lv_sub IS NOT INITIAL.
            ev_error = |component { lv_top } is not a structure, but was sent as an object or array|.
            RETURN.
          ENDIF.
          set_elem( EXPORTING iv_value = ls_obj-value
                    IMPORTING ev_error = lv_err
                    CHANGING  cv_target = <lv_comp> ).
          IF lv_err IS NOT INITIAL.
            ev_error = |component { lv_top }: { lv_err }|.
            RETURN.
          ENDIF.
        WHEN cl_abap_typedescr=>kind_struct.
          IF lv_sub IS INITIAL.
            ev_error = |component { lv_top } is a structure, send it as a JSON object|.
            RETURN.
          ENDIF.
          ASSIGN COMPONENT lv_sub OF STRUCTURE <lv_comp> TO <lv_part>.
          IF sy-subrc <> 0.
            ev_error = |unknown component { lv_top }-{ lv_sub }|.
            RETURN.
          ENDIF.
          lo_type = cl_abap_typedescr=>describe_by_data( <lv_part> ).
          IF lo_type->kind <> cl_abap_typedescr=>kind_elem.
            ev_error = |component { lv_top }-{ lv_sub } is itself a structure or table, which is nested deeper than core.call_fm supports (two levels, elementary leaves)|.
            RETURN.
          ENDIF.
          set_elem( EXPORTING iv_value = ls_obj-value
                    IMPORTING ev_error = lv_err
                    CHANGING  cv_target = <lv_part> ).
          IF lv_err IS NOT INITIAL.
            ev_error = |component { lv_top }-{ lv_sub }: { lv_err }|.
            RETURN.
          ENDIF.
        WHEN OTHERS.
          ev_error = |component { lv_top } is a table or reference, which core.call_fm cannot fill from JSON|.
          RETURN.
      ENDCASE.
    ENDLOOP.
  ENDMETHOD.

  METHOD comp_json.
    " The component list of a structure type as a JSON array of
    " {name,type,length,decimals}, or '' when iv_type is not a structure.
    " length is in characters for C/N/D/T, digits for P, bytes otherwise.
    DATA lo_type   TYPE REF TO cl_abap_typedescr.
    DATA lo_struct TYPE REF TO cl_abap_structdescr.
    DATA ls_comp   TYPE abap_compdescr.
    DATA lv_type   TYPE string.
    DATA lv_tname  TYPE string.
    DATA lv_len    TYPE i.
    DATA lv_first  TYPE abap_bool.
    DATA lv_cname  TYPE string.

    CLEAR rv_json.
    IF iv_type IS INITIAL.
      RETURN.
    ENDIF.
    lv_type = concrete_type( iv_type ).
    cl_abap_typedescr=>describe_by_name(
      EXPORTING  p_name       = lv_type
      RECEIVING  p_descr_ref  = lo_type
      EXCEPTIONS type_not_found = 1
                 OTHERS         = 2 ).
    IF sy-subrc <> 0 OR lo_type IS NOT BOUND OR lo_type->kind <> cl_abap_typedescr=>kind_struct.
      RETURN.
    ENDIF.
    lo_struct ?= lo_type.
    rv_json = '['.
    lv_first = abap_true.
    LOOP AT lo_struct->components INTO ls_comp.
      CASE ls_comp-type_kind.
        WHEN 'C'.
          lv_tname = 'CHAR'.
        WHEN 'N'.
          lv_tname = 'NUMC'.
        WHEN 'D'.
          lv_tname = 'DATS'.
        WHEN 'T'.
          lv_tname = 'TIMS'.
        WHEN 'P'.
          lv_tname = 'DEC'.
        WHEN 'I'.
          lv_tname = 'INT4'.
        WHEN 'b'.
          lv_tname = 'INT1'.
        WHEN 's'.
          lv_tname = 'INT2'.
        WHEN '8'.
          lv_tname = 'INT8'.
        WHEN 'F'.
          lv_tname = 'FLTP'.
        WHEN 'X'.
          lv_tname = 'RAW'.
        WHEN 'g'.
          lv_tname = 'STRING'.
        WHEN 'y'.
          lv_tname = 'RAWSTRING'.
        WHEN 'a'.
          lv_tname = 'DECFLOAT16'.
        WHEN 'e'.
          lv_tname = 'DECFLOAT34'.
        WHEN 'u' OR 'v'.
          lv_tname = 'STRUCTURE'.
        WHEN 'h'.
          lv_tname = 'TABLE'.
        WHEN OTHERS.
          lv_tname = ls_comp-type_kind.
      ENDCASE.
      lv_len = ls_comp-length.
      IF ls_comp-type_kind = 'C' OR ls_comp-type_kind = 'N'
         OR ls_comp-type_kind = 'D' OR ls_comp-type_kind = 'T'.
        lv_len = lv_len / cl_abap_char_utilities=>charsize.
      ELSEIF ls_comp-type_kind = 'P'.
        lv_len = lv_len * 2 - 1.
      ENDIF.
      IF lv_first = abap_false.
        rv_json = rv_json && ','.
      ENDIF.
      lv_first = abap_false.
      lv_cname = ls_comp-name.
      rv_json = rv_json && |\\{"name":"{ zcl_zmcp_fluid_rt=>esc( lv_cname ) }",|.
      rv_json = rv_json && |"type":"{ lv_tname }","length":{ lv_len },|.
      rv_json = rv_json && |"decimals":{ ls_comp-decimals }\\}|.
    ENDLOOP.
    rv_json = rv_json && ']'.
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
    CLASS-METHODS concrete_type
      IMPORTING
        iv_type TYPE string
      RETURNING
        VALUE(rv_type) TYPE string.
    CLASS-METHODS set_elem
      IMPORTING
        iv_value  TYPE string
      EXPORTING
        ev_error  TYPE string
      CHANGING
        cv_target TYPE any.
    CLASS-METHODS fill_struct
      IMPORTING
        iv_json  TYPE string
      EXPORTING
        ev_error TYPE string
      CHANGING
        cs_data  TYPE any.
    CLASS-METHODS comp_json
      IMPORTING
        iv_type TYPE string
      RETURNING
        VALUE(rv_json) TYPE string.
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
