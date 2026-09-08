/**
 * `core.describe_fm` and `core.call_fm`: read a function module's interface
 * out of `FUPARAREF` (via `fm_params` in `abap-core.ts`) and, for
 * `call_fm`, actually invoke it — no `DESTINATION`, so the call runs in the
 * caller's own system under the technical user's own authorisations. This
 * is not a sandbox: `core.call_fm` does not and cannot bound what a called
 * function module does once invoked, any more than SAP's own authorisation
 * concept already does. Static review specifically forbids `CALL FUNCTION`
 * paired with `DESTINATION` in one statement (`static-review.ts`'s
 * `call-function-destination` rule) — this file's one `CALL FUNCTION` has no
 * `DESTINATION`, which is the point, not an oversight.
 *
 * `FUPARAREF-PARAMTYPE` names a parameter from the function module's own
 * definition (`I`mporting, `E`xporting, `C`hanging, `T`ables, e`X`ception),
 * which is the FM AUTHOR's point of view. Every value `core` prints is
 * relabeled to the CALLER's point of view instead — the inversion is the
 * classic trap here:
 *   FUPARAREF `I` (the FM's IMPORTING param, i.e. what the FM author reads
 *     coming in)   -> `core` reports `"in"`  (the caller supplies it)
 *   FUPARAREF `E` (the FM's EXPORTING param, i.e. what the FM author writes
 *     going out)   -> `core` reports `"out"` (the caller receives it)
 *   FUPARAREF `C`  -> `core` reports `"changing"`
 *   FUPARAREF `T`  -> `core` reports `"tables"`
 *   FUPARAREF `X`  -> `core` reports `"exception"`
 *
 * `core.call_fm`'s `params` binds only against FUPARAREF `I` and `C`
 * parameters (`abap_func_exporting` / `abap_func_changing` in the RTTI
 * parameter-table sense — ABAP's own function-call binding table is
 * likewise named from the FM's perspective). Every `E`/`C`/`T` parameter
 * with a resolvable type is bound too, as `abap_func_importing` /
 * `abap_func_changing` / `abap_func_tables`, so the results can be read
 * back and reported.
 */
import type { CoreAbapPart } from "./abap-core.js";

export const fmPart: CoreAbapPart = {
  actions: [
    { action: "describe_fm", method: "do_describe_fm" },
    { action: "call_fm", method: "do_call_fm" },
  ],
  source: `  METHOD do_describe_fm.
    DATA lv_name  TYPE string.
    DATA lv_func  TYPE rs38l-name.
    DATA lt_par   TYPE ty_par_tab.
    DATA ls_par   TYPE ty_par.
    DATA lv_json  TYPE string.
    DATA lv_props TYPE string.
    DATA lv_req   TYPE string.
    DATA lv_exc   TYPE string.
    DATA lv_kind  TYPE string.
    DATA lv_first TYPE abap_bool.
    DATA lv_pfirst TYPE abap_bool.
    DATA lv_rfirst TYPE abap_bool.
    DATA lv_efirst TYPE abap_bool.

    lv_name = to_upper( s( 'name' ) ).
    IF lv_name IS INITIAL.
      fail( 'name is required' ).
      RETURN.
    ENDIF.
    lv_func = lv_name.
    SELECT SINGLE funcname FROM tfdir INTO @DATA(lv_chk) WHERE funcname = @lv_func.
    IF sy-subrc <> 0.
      fail( |unknown function module { lv_name }| ).
      RETURN.
    ENDIF.

    lt_par = fm_params( lv_name ).

    lv_json = |\\{"name":"{ zcl_zmcp_fluid_rt=>esc( lv_name ) }","parameters":[|.
    lv_first = abap_true.
    lv_props = ''.
    lv_pfirst = abap_true.
    lv_req = ''.
    lv_rfirst = abap_true.
    lv_exc = ''.
    lv_efirst = abap_true.

    LOOP AT lt_par INTO ls_par.
      CASE ls_par-ptype.
        WHEN 'I'.
          lv_kind = 'in'.
        WHEN 'E'.
          lv_kind = 'out'.
        WHEN 'C'.
          lv_kind = 'changing'.
        WHEN 'T'.
          lv_kind = 'tables'.
        WHEN OTHERS.
          lv_kind = 'exception'.
      ENDCASE.

      IF ls_par-ptype = 'X'.
        IF lv_efirst = abap_false.
          lv_exc = lv_exc && ','.
        ENDIF.
        lv_efirst = abap_false.
        lv_exc = lv_exc && |"{ zcl_zmcp_fluid_rt=>esc( ls_par-name ) }"|.
        CONTINUE.
      ENDIF.

      IF lv_first = abap_false.
        lv_json = lv_json && ','.
      ENDIF.
      lv_first = abap_false.
      lv_json = lv_json && |\\{"kind":"{ lv_kind }",| .
      lv_json = lv_json && |"name":"{ zcl_zmcp_fluid_rt=>esc( ls_par-name ) }",|.
      lv_json = lv_json && |"type":"{ zcl_zmcp_fluid_rt=>esc( ls_par-typename ) }",|.
      lv_json = lv_json && |"optional":"{ ls_par-optional }",|.
      lv_json = lv_json && |"default":"{ zcl_zmcp_fluid_rt=>esc( ls_par-defval ) }"\\}|.

      IF ls_par-ptype = 'I' OR ls_par-ptype = 'C'.
        IF lv_pfirst = abap_false.
          lv_props = lv_props && ','.
        ENDIF.
        lv_pfirst = abap_false.
        lv_props = lv_props && |"{ zcl_zmcp_fluid_rt=>esc( ls_par-name ) }":|.
        lv_props = lv_props && |\\{"type":"string","description":"{ lv_kind }, type |.
        lv_props = lv_props && |{ zcl_zmcp_fluid_rt=>esc( ls_par-typename ) }"\\}|.
        IF ls_par-optional = abap_false.
          IF lv_rfirst = abap_false.
            lv_req = lv_req && ','.
          ENDIF.
          lv_rfirst = abap_false.
          lv_req = lv_req && |"{ zcl_zmcp_fluid_rt=>esc( ls_par-name ) }"|.
        ENDIF.
      ENDIF.
    ENDLOOP.

    lv_json = lv_json && |],"exceptions":[{ lv_exc }],|.
    lv_json = lv_json && |"params_schema":\\{"type":"object","properties":\\{{ lv_props }\\},|.
    lv_json = lv_json && |"required":[{ lv_req }]\\}\\}|.
    zcl_zmcp_fluid_rt=>out( lv_json ).
  ENDMETHOD.

  METHOD do_call_fm.
    DATA lv_name  TYPE string.
    DATA lv_func  TYPE rs38l-name.
    DATA lt_par   TYPE ty_par_tab.
    DATA ls_par   TYPE ty_par.
    DATA lt_keys  TYPE string_table.
    DATA lv_key   TYPE string.
    DATA lv_val   TYPE string.
    DATA lt_ptab  TYPE abap_func_parmbind_tab.
    DATA ls_ptab  TYPE abap_func_parmbind.
    DATA lt_etab  TYPE abap_func_excpbind_tab.
    DATA ls_etab  TYPE abap_func_excpbind.
    DATA lr_data  TYPE REF TO data.
    DATA lv_type  TYPE string.
    DATA lv_json  TYPE string.
    DATA lv_kind  TYPE string.
    FIELD-SYMBOLS <lv_any> TYPE any.

    lv_name = to_upper( s( 'name' ) ).
    IF lv_name IS INITIAL.
      fail( 'name is required' ).
      RETURN.
    ENDIF.
    lv_func = lv_name.
    SELECT SINGLE funcname FROM tfdir INTO @DATA(lv_chk) WHERE funcname = @lv_func.
    IF sy-subrc <> 0.
      fail( |unknown function module { lv_name }| ).
      RETURN.
    ENDIF.

    lt_par = fm_params( lv_name ).
    lt_keys = keys( 'params' ).

    LOOP AT lt_keys INTO lv_key.
      lv_key = to_upper( lv_key ).
      READ TABLE lt_par INTO ls_par WITH KEY name = lv_key.
      IF sy-subrc <> 0 OR ( ls_par-ptype <> 'I' AND ls_par-ptype <> 'C' ).
        fail( |{ lv_name } has no input parameter { lv_key }| ).
        RETURN.
      ENDIF.
      IF ls_par-typename IS INITIAL.
        fail( |parameter { lv_key } of { lv_name } is untyped; core.call_fm cannot bind it| ).
        RETURN.
      ENDIF.
      lv_type = ls_par-typename.
      TRY.
          CREATE DATA lr_data TYPE (lv_type).
        CATCH cx_root.
          fail( |cannot create a value of type { lv_type } for parameter { lv_key }| ).
          RETURN.
      ENDTRY.
      ASSIGN lr_data->* TO <lv_any>.
      lv_val = s( |params/{ lv_key }| ).
      TRY.
          <lv_any> = lv_val.
        CATCH cx_root.
          fail( |value for { lv_key } does not fit type { lv_type }| ).
          RETURN.
      ENDTRY.
      CLEAR ls_ptab.
      ls_ptab-name = lv_key.
      IF ls_par-ptype = 'I'.
        ls_ptab-kind = abap_func_exporting.
      ELSE.
        ls_ptab-kind = abap_func_changing.
      ENDIF.
      ls_ptab-value = lr_data.
      INSERT ls_ptab INTO TABLE lt_ptab.
    ENDLOOP.

    LOOP AT lt_par INTO ls_par.
      IF ls_par-ptype <> 'E' AND ls_par-ptype <> 'T'.
        CONTINUE.
      ENDIF.
      IF ls_par-typename IS INITIAL.
        CONTINUE.
      ENDIF.
      READ TABLE lt_ptab TRANSPORTING NO FIELDS WITH TABLE KEY name = ls_par-name.
      IF sy-subrc = 0.
        CONTINUE.
      ENDIF.
      lv_type = ls_par-typename.
      TRY.
          IF ls_par-ptype = 'T'.
            CREATE DATA lr_data TYPE STANDARD TABLE OF (lv_type).
          ELSE.
            CREATE DATA lr_data TYPE (lv_type).
          ENDIF.
        CATCH cx_root.
          CONTINUE.
      ENDTRY.
      CLEAR ls_ptab.
      ls_ptab-name = ls_par-name.
      IF ls_par-ptype = 'T'.
        ls_ptab-kind = abap_func_tables.
      ELSE.
        ls_ptab-kind = abap_func_importing.
      ENDIF.
      ls_ptab-value = lr_data.
      INSERT ls_ptab INTO TABLE lt_ptab.
    ENDLOOP.

    CLEAR ls_etab.
    ls_etab-name = 'OTHERS'.
    ls_etab-value = 1.
    INSERT ls_etab INTO TABLE lt_etab.

    TRY.
        CALL FUNCTION lv_name
          PARAMETER-TABLE lt_ptab
          EXCEPTION-TABLE lt_etab.
      CATCH cx_root INTO DATA(lx_call).
        fail( |{ lv_name } raised { lx_call->get_text( ) }| ).
        RETURN.
    ENDTRY.
    IF sy-subrc <> 0.
      fail( |{ lv_name } returned exception subrc { sy-subrc }| ).
      RETURN.
    ENDIF.

    IF b( 'commit' ) = abap_true.
      COMMIT WORK AND WAIT.
    ENDIF.

    LOOP AT lt_ptab INTO ls_ptab.
      IF ls_ptab-kind = abap_func_exporting.
        CONTINUE.
      ENDIF.
      CASE ls_ptab-kind.
        WHEN abap_func_importing.
          lv_kind = 'out'.
        WHEN abap_func_changing.
          lv_kind = 'changing'.
        WHEN OTHERS.
          lv_kind = 'tables'.
      ENDCASE.
      ASSIGN ls_ptab-value->* TO <lv_any>.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      lv_json = |\\{"name":"{ zcl_zmcp_fluid_rt=>esc( ls_ptab-name ) }",|.
      lv_json = lv_json && |"kind":"{ lv_kind }","value":| && to_json( <lv_any> ) && '}'.
      zcl_zmcp_fluid_rt=>out( lv_json ).
    ENDLOOP.
  ENDMETHOD.`,
};
