/**
 * `core.select`: an ad-hoc Open SQL `SELECT` over one table or view, field
 * list and WHERE condition both caller-supplied and both bound dynamically.
 * No default row count, no clamp, no ceiling in this file — `max_rows`
 * (`0` when omitted) is passed straight into `UP TO @lv_max ROWS`, and ABAP's
 * own rule for that construct is that `0` means "no restriction". Any
 * ceiling on what `core.select` may read lives entirely in TypeScript, in
 * `core.ts`'s `guardCoreAction` (`deps.gate.assertDataPreview`) and the
 * `ABAP_ALLOW_DATA_PREVIEW` capability check next to it — this ABAP never
 * re-implements any part of that policy.
 */
import type { CoreAbapPart } from "./abap-core.js";

export const selectPart: CoreAbapPart = {
  actions: [{ action: "select", method: "do_select" }],
  source: `  METHOD do_select.
    DATA lv_table  TYPE string.
    DATA lv_where  TYPE string.
    DATA lv_max    TYPE i.
    DATA lv_cnt    TYPE i.
    DATA lv_idx    TYPE i.
    DATA lv_fld    TYPE string.
    DATA lt_fields TYPE string_table.
    DATA lv_flds   TYPE string.
    DATA lv_json   TYPE string.
    DATA lv_first  TYPE abap_bool.
    DATA lo_type   TYPE REF TO cl_abap_typedescr.
    DATA lo_struct TYPE REF TO cl_abap_structdescr.
    DATA ls_comp   TYPE abap_compdescr.
    DATA lr_tab    TYPE REF TO data.
    FIELD-SYMBOLS <lt_rows> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_row>  TYPE any.
    FIELD-SYMBOLS <lv_any>  TYPE any.

    lv_table = to_upper( s( 'table' ) ).
    lv_where = s( 'where' ).
    lv_max   = num( 'max_rows' ).
    IF lv_table IS INITIAL.
      fail( 'table is required' ).
      RETURN.
    ENDIF.

    cl_abap_typedescr=>describe_by_name(
      EXPORTING  p_name         = lv_table
      RECEIVING  p_descr_ref    = lo_type
      EXCEPTIONS type_not_found = 1
                 OTHERS         = 2 ).
    IF sy-subrc <> 0.
      fail( |unknown table or view { lv_table }| ).
      RETURN.
    ENDIF.
    IF lo_type->kind <> cl_abap_typedescr=>kind_struct.
      fail( |{ lv_table } is not a flat table or view| ).
      RETURN.
    ENDIF.
    lo_struct ?= lo_type.

    lv_cnt = n( 'fields' ).
    IF lv_cnt = 0.
      LOOP AT lo_struct->components INTO ls_comp.
        APPEND ls_comp-name TO lt_fields.
      ENDLOOP.
      lv_flds = '*'.
    ELSE.
      lv_idx = 0.
      WHILE lv_idx < lv_cnt.
        lv_fld = to_upper( s( |fields/{ lv_idx }| ) ).
        READ TABLE lo_struct->components TRANSPORTING NO FIELDS WITH KEY name = lv_fld.
        IF sy-subrc <> 0.
          fail( |{ lv_table } has no field { lv_fld }| ).
          RETURN.
        ENDIF.
        APPEND lv_fld TO lt_fields.
        IF lv_flds IS INITIAL.
          lv_flds = lv_fld.
        ELSE.
          lv_flds = |{ lv_flds },{ lv_fld }|.
        ENDIF.
        lv_idx = lv_idx + 1.
      ENDWHILE.
    ENDIF.

    CREATE DATA lr_tab TYPE STANDARD TABLE OF (lv_table).
    ASSIGN lr_tab->* TO <lt_rows>.

    TRY.
        IF lv_where IS INITIAL.
          SELECT (lv_flds) FROM (lv_table) INTO CORRESPONDING FIELDS OF TABLE @<lt_rows> UP TO @lv_max ROWS.
        ELSE.
          SELECT (lv_flds) FROM (lv_table) INTO CORRESPONDING FIELDS OF TABLE @<lt_rows> UP TO @lv_max ROWS WHERE (lv_where).
        ENDIF.
      CATCH cx_root INTO DATA(lx_sel).
        fail( |select on { lv_table } failed: { lx_sel->get_text( ) }| ).
        RETURN.
    ENDTRY.

    LOOP AT <lt_rows> ASSIGNING <ls_row>.
      lv_json = '{'.
      lv_first = abap_true.
      LOOP AT lt_fields INTO lv_fld.
        ASSIGN COMPONENT lv_fld OF STRUCTURE <ls_row> TO <lv_any>.
        IF sy-subrc <> 0.
          CONTINUE.
        ENDIF.
        IF lv_first = abap_false.
          lv_json = lv_json && ','.
        ENDIF.
        lv_first = abap_false.
        lv_json = lv_json && |"{ zcl_zmcp_fluid_rt=>esc( lv_fld ) }":| && to_json( <lv_any> ).
      ENDLOOP.
      lv_json = lv_json && '}'.
      zcl_zmcp_fluid_rt=>out( lv_json ).
    ENDLOOP.
  ENDMETHOD.`,
};
