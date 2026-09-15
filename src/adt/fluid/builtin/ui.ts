/**
 * Built-in "ui" fluid tool: static, read-only inspection of a classic dynpro
 * screen, reshaped to the fluid body-class contract (`run( iv_action,
 * iv_json )` against `ZCL_ZMCP_FLUID_RT`) instead of the legacy per-call
 * generated bridge class. Input args are read out of `iv_json` via
 * `ZCL_ZMCP_FLUID_RT`'s `scan()`/`s()`.
 *
 * Two actions:
 *   - `screen`: resolves a screen by tcode (via TSTC) or by explicit
 *     program+dynpro, and reads its field list via `RPY_DYNPRO_READ`. Single
 *     JSON object result.
 *   - `fcode`: static trace of one (or every) function code of the resolved
 *     screen's GUI status to the PAI module(s) that handle it, and from
 *     there to the module source. Multi-frame result (see the `fcode`
 *     action's manifest below for the frame `kind`s). This never runs
 *     anything - no `CALL TRANSACTION`, no BDCDATA - it only reads flow
 *     logic, includes and source text.
 *
 * `press` (a BDC `CALL TRANSACTION ... USING` run) is deliberately not
 * ported: its query shape is `screens: [{program, dynpro, okcode, fields:
 * [{name, value}]}]`, an array of objects that `scan()`'s flat path model
 * cannot represent, and it is a mutation unsafe to exercise generically on a
 * shared appliance. The legacy `press` path in `ui-runtime.ts` is untouched.
 */
import type { FluidManifest } from "../manifest.js";
import { FLUID_CONTRACT } from "../manifest.js";
import { FLUID_RUNTIME_CLASS, fluidRuntimeManifest, fluidRuntimeSources } from "../abap/runtime.js";

const RUNTIME_SOURCE = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS);
if (RUNTIME_SOURCE === undefined) {
  throw new Error(`fluidRuntimeSources has no entry for ${FLUID_RUNTIME_CLASS}`);
}

const RUNTIME_OBJECT = fluidRuntimeManifest.objects.find((o) => o.name === FLUID_RUNTIME_CLASS);
if (RUNTIME_OBJECT === undefined) {
  throw new Error(`fluidRuntimeManifest has no entry for ${FLUID_RUNTIME_CLASS}`);
}

const UI_SOURCE = `CLASS zcl_zmcp_fluid_ui DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    CLASS-METHODS run
      IMPORTING
        iv_action TYPE string
        iv_json   TYPE string.

  PRIVATE SECTION.
    " Set by fcode() when the 4000-line src cap was hit; read by run() after
    " the CASE dispatch to decide end()'s iv_truncated. Left initial by
    " screen(), which never truncates.
    CLASS-DATA gv_trunc TYPE string.

    CLASS-METHODS row_json
      IMPORTING
        iv_data        TYPE any
      RETURNING
        VALUE(rv_json) TYPE string.

    " Same RTTI walk as row_json, minus the FNAM name-extraction/wrapping -
    " used for header/flow/status rows, none of which carry an FNAM component.
    CLASS-METHODS flatten_json
      IMPORTING
        iv_data        TYPE any
      RETURNING
        VALUE(rv_json) TYPE string.

    " GUI status/buttons walk (RS_CUA_INTERNAL_FETCH + per-status
    " RS_CUA_GET_STATUS), keyed by program alone. Returns a comma-prefixed
    " run of "key":value pairs to append to the enclosing object, or the
    " empty string when there is nothing to report (see METHOD cua_json).
    CLASS-METHODS cua_json
      IMPORTING
        iv_program     TYPE syrepid
        iv_prog_s      TYPE string
      RETURNING
        VALUE(rv_json) TYPE string.

    " Shared by screen and fcode: resolves either a tcode (via TSTC) or an
    " explicit program+dynpro pair into program/dynpro, plus the TSTC-CINFO
    " classification when resolved by tcode. Calls err() itself and sets
    " ev_ok = abap_false on any failure; the caller just checks ev_ok and
    " RETURNs - the err() frame it already raised will fail the action.
    CLASS-METHODS resolve_target
      IMPORTING
        iv_tcode      TYPE string
        iv_prog_in    TYPE string
        iv_dyn_in     TYPE string
      EXPORTING
        ev_program    TYPE syrepid
        ev_dynpro     TYPE sydynnr
        ev_have_tcode TYPE abap_bool
        ev_cinfo_raw  TYPE tstc-cinfo
        ev_cinfo      TYPE string
        ev_kind       TYPE string
        ev_ok         TYPE abap_bool.

    CLASS-METHODS screen.

    " Static trace: flow logic -> PAI module list -> CUA data -> every
    " include's module index -> source of the PAI-listed modules. Reports
    " raw facts only; matching a function code to a branch inside a module
    " is done in TypeScript (src/adt/ui-fcode.ts) from these frames.
    CLASS-METHODS fcode.

    " Scans one include's already-read source for MODULE ... ENDMODULE
    " spans, emits a "module" frame for every one found (not just PAI
    " modules), and for any module named in it_pai also emits its body via
    " emit_src (subject to the shared 4000-line cap in cv_src_count/cv_trunc).
    CLASS-METHODS scan_modules
      IMPORTING
        iv_include   TYPE string
        it_src       TYPE string_table
        it_pai       TYPE string_table
      CHANGING
        cv_mod_count TYPE i
        cv_src_count TYPE i
        cv_trunc     TYPE string.

    " Emits one "src" frame per line of it_src from iv_from to iv_to
    " inclusive, but only when iv_name is in it_pai, and stops (setting
    " cv_trunc = 'source') once cv_src_count reaches 4000 across the whole
    " fcode run.
    CLASS-METHODS emit_src
      IMPORTING
        iv_include   TYPE string
        it_src       TYPE string_table
        iv_from      TYPE i
        iv_to        TYPE i
        iv_name      TYPE string
        it_pai       TYPE string_table
      CHANGING
        cv_src_count TYPE i
        cv_trunc     TYPE string.

ENDCLASS.


CLASS zcl_zmcp_fluid_ui IMPLEMENTATION.

  METHOD run.
    zcl_zmcp_fluid_rt=>begin( iv_id = 'ui' iv_action = iv_action ).

    TRY.
        zcl_zmcp_fluid_rt=>scan( iv_json ).
        CASE iv_action.
          WHEN 'screen'.
            screen( ).
          WHEN 'fcode'.
            fcode( ).
          WHEN OTHERS.
            zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'dispatch'
              iv_text = |unknown action "{ iv_action }"| ).
        ENDCASE.
      CATCH cx_root INTO DATA(lx_err).
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = iv_action iv_text = lx_err->get_text( ) ).
    ENDTRY.

    IF zcl_zmcp_fluid_rt=>failed( ) = abap_true.
      zcl_zmcp_fluid_rt=>end( iv_rc = 1 ).
    ELSE.
      zcl_zmcp_fluid_rt=>end( iv_rc = 0 iv_truncated = boolc( gv_trunc IS NOT INITIAL ) ).
    ENDIF.
  ENDMETHOD.

  METHOD resolve_target.
    CLEAR: ev_program, ev_dynpro, ev_have_tcode, ev_cinfo_raw, ev_cinfo, ev_kind.
    ev_ok = abap_true.

    IF iv_tcode IS NOT INITIAL.
      SELECT SINGLE pgmna, dypno, cinfo FROM tstc
        WHERE tcode = @iv_tcode
        INTO (@ev_program, @ev_dynpro, @ev_cinfo_raw).
      IF sy-subrc <> 0.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'subrc' iv_step = 'tstc'
          iv_text = |TSTC lookup failed for tcode { iv_tcode }| iv_subrc = sy-subrc ).
        ev_ok = abap_false.
        RETURN.
      ENDIF.
      ev_have_tcode = abap_true.
      ev_cinfo = |{ ev_cinfo_raw }|.
      CASE ev_cinfo_raw.
        WHEN '00'.
          ev_kind = 'dialog transaction (classic dynpro; batch input / press applies)'.
        WHEN '80'.
          ev_kind = 'report transaction (SUBMIT-driven; batch input does NOT apply)'.
        WHEN OTHERS.
          ev_kind = 'unrecognised transaction kind - mechanism not confirmed, do not assume batch input applies'.
      ENDCASE.
    ELSEIF iv_prog_in IS NOT INITIAL AND iv_dyn_in IS NOT INITIAL.
      " dynpro arrives as caller-supplied JSON at runtime rather than a
      " baked ABAP literal, so its digit shape is checked here instead of
      " being left to NUMC's own silently-truncating conversion.
      IF iv_dyn_in CO '0123456789' AND strlen( iv_dyn_in ) BETWEEN 1 AND 4.
        ev_program = iv_prog_in.
        ev_dynpro  = iv_dyn_in.
      ELSE.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
          iv_text = |dynpro "{ iv_dyn_in }" must be 1-4 digits| ).
        ev_ok = abap_false.
        RETURN.
      ENDIF.
    ELSE.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
        iv_text = 'either tcode, or program and dynpro, is required' ).
      ev_ok = abap_false.
      RETURN.
    ENDIF.
  ENDMETHOD.

  METHOD screen.
    DATA(lv_tcode)   = zcl_zmcp_fluid_rt=>s( 'tcode' ).
    DATA(lv_prog_in) = zcl_zmcp_fluid_rt=>s( 'program' ).
    DATA(lv_dyn_in)  = zcl_zmcp_fluid_rt=>s( 'dynpro' ).

    DATA lv_program    TYPE syrepid.
    DATA lv_dynpro     TYPE sydynnr.
    DATA lv_have_tcode TYPE abap_bool.
    DATA lv_cinfo_raw  TYPE tstc-cinfo.
    DATA lv_cinfo      TYPE string.
    DATA lv_kind       TYPE string.

    resolve_target(
      EXPORTING iv_tcode = lv_tcode iv_prog_in = lv_prog_in iv_dyn_in = lv_dyn_in
      IMPORTING ev_program = lv_program ev_dynpro = lv_dynpro ev_have_tcode = lv_have_tcode
                ev_cinfo_raw = lv_cinfo_raw ev_cinfo = lv_cinfo ev_kind = lv_kind ev_ok = DATA(lv_ok) ).
    IF lv_ok = abap_false.
      RETURN.
    ENDIF.

    " lv_program (syrepid) and lv_dynpro (sydynnr) are non-string flat
    " types; ZCL_ZMCP_FLUID_RT=>esc's iv_text is TYPE string passed by
    " reference (the IMPORTING default), which requires an exact type
    " match rather than an implicit conversion, so both are materialised
    " into genuine string locals here before being escaped below.
    DATA lv_prog_s TYPE string.
    DATA lv_dyn_s  TYPE string.
    lv_prog_s = |{ lv_program }|.
    lv_dyn_s  = |{ lv_dynpro }|.

    DATA lv_step TYPE string VALUE 'read'.
    TRY.
        DATA ls_header      TYPE rpy_dyhead.
        DATA lt_fields_list TYPE TABLE OF d021s.
        DATA lt_flow_logic  TYPE TABLE OF rpy_dyflow.
        CLEAR: ls_header, lt_fields_list, lt_flow_logic.
        CALL FUNCTION 'RPY_DYNPRO_READ'
          EXPORTING
            progname = lv_program
            dynnr    = lv_dynpro
          IMPORTING
            header   = ls_header
          TABLES
            flow_logic  = lt_flow_logic
            fields_list = lt_fields_list
          EXCEPTIONS
            cancelled        = 1
            not_found        = 2
            permission_error = 3
            OTHERS           = 4.
        IF sy-subrc <> 0.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'subrc' iv_step = lv_step
            iv_text = |RPY_DYNPRO_READ failed for { lv_program } { lv_dynpro }| iv_subrc = sy-subrc ).
          RETURN.
        ENDIF.

        DATA lv_out TYPE string.
        lv_out = '{'.
        IF lv_have_tcode = abap_true.
          lv_out = lv_out && |"tcode":\\{"tcode":"{ zcl_zmcp_fluid_rt=>esc( lv_tcode ) }"|.
          lv_out = lv_out && |,"program":"{ zcl_zmcp_fluid_rt=>esc( lv_prog_s ) }"|.
          lv_out = lv_out && |,"dynpro":"{ zcl_zmcp_fluid_rt=>esc( lv_dyn_s ) }"|.
          lv_out = lv_out && |,"cinfo":"{ zcl_zmcp_fluid_rt=>esc( lv_cinfo ) }"|.
          lv_out = lv_out && |,"kind":"{ zcl_zmcp_fluid_rt=>esc( lv_kind ) }"|.
          IF lv_cinfo_raw = '00'.
            lv_out = lv_out && ',"bdcApplies":true'.
          ELSEIF lv_cinfo_raw = '80'.
            lv_out = lv_out && ',"bdcApplies":false'.
          ENDIF.
          lv_out = lv_out && '},'.
        ENDIF.
        lv_out = lv_out && |"program":"{ zcl_zmcp_fluid_rt=>esc( lv_prog_s ) }"|.
        lv_out = lv_out && |,"dynpro":"{ zcl_zmcp_fluid_rt=>esc( lv_dyn_s ) }"|.
        lv_out = lv_out && |,"header":{ flatten_json( ls_header ) }|.

        lv_out = lv_out && ',"fields":['.
        LOOP AT lt_fields_list INTO DATA(ls_field).
          IF sy-tabix > 1.
            lv_out = lv_out && ','.
          ENDIF.
          lv_out = lv_out && row_json( ls_field ).
        ENDLOOP.
        lv_out = lv_out && ']'.

        lv_out = lv_out && |,"flowCount":{ lines( lt_flow_logic ) }|.
        lv_out = lv_out && ',"flow":['.
        LOOP AT lt_flow_logic INTO DATA(ls_flow).
          IF sy-tabix > 1.
            lv_out = lv_out && ','.
          ENDIF.
          lv_out = lv_out && flatten_json( ls_flow ).
        ENDLOOP.
        lv_out = lv_out && ']'.

        lv_out = lv_out && cua_json( iv_program = lv_program iv_prog_s = lv_prog_s ).
        lv_out = lv_out && '}'.
        zcl_zmcp_fluid_rt=>out( lv_out ).

      CATCH cx_root INTO DATA(lx_err).
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = lv_step iv_text = lx_err->get_text( ) ).
        RETURN.
    ENDTRY.
  ENDMETHOD.

  METHOD fcode.
    DATA(lv_tcode)    = zcl_zmcp_fluid_rt=>s( 'tcode' ).
    DATA(lv_prog_in)  = zcl_zmcp_fluid_rt=>s( 'program' ).
    DATA(lv_dyn_in)   = zcl_zmcp_fluid_rt=>s( 'dynpro' ).
    DATA(lv_fcode_in) = zcl_zmcp_fluid_rt=>s( 'fcode' ).

    DATA lv_program    TYPE syrepid.
    DATA lv_dynpro     TYPE sydynnr.
    DATA lv_have_tcode TYPE abap_bool.
    DATA lv_cinfo_raw  TYPE tstc-cinfo.
    DATA lv_cinfo      TYPE string.
    DATA lv_kind       TYPE string.

    resolve_target(
      EXPORTING iv_tcode = lv_tcode iv_prog_in = lv_prog_in iv_dyn_in = lv_dyn_in
      IMPORTING ev_program = lv_program ev_dynpro = lv_dynpro ev_have_tcode = lv_have_tcode
                ev_cinfo_raw = lv_cinfo_raw ev_cinfo = lv_cinfo ev_kind = lv_kind ev_ok = DATA(lv_ok) ).
    IF lv_ok = abap_false.
      RETURN.
    ENDIF.

    DATA lv_prog_s TYPE string.
    DATA lv_dyn_s  TYPE string.
    lv_prog_s = |{ lv_program }|.
    lv_dyn_s  = |{ lv_dynpro }|.

    DATA lv_target TYPE string.
    lv_target = |\\{"kind":"target","program":"{ zcl_zmcp_fluid_rt=>esc( lv_prog_s ) }"|.
    lv_target = lv_target && |,"dynpro":"{ zcl_zmcp_fluid_rt=>esc( lv_dyn_s ) }"|.
    lv_target = lv_target && |,"fcode_filter":"{ zcl_zmcp_fluid_rt=>esc( lv_fcode_in ) }"|.
    IF lv_have_tcode = abap_true.
      lv_target = lv_target && |,"tcode":\\{"tcode":"{ zcl_zmcp_fluid_rt=>esc( lv_tcode ) }"|.
      lv_target = lv_target && |,"program":"{ zcl_zmcp_fluid_rt=>esc( lv_prog_s ) }"|.
      lv_target = lv_target && |,"dynpro":"{ zcl_zmcp_fluid_rt=>esc( lv_dyn_s ) }"|.
      lv_target = lv_target && |,"cinfo":"{ zcl_zmcp_fluid_rt=>esc( lv_cinfo ) }"|.
      lv_target = lv_target && |,"kind":"{ zcl_zmcp_fluid_rt=>esc( lv_kind ) }"|.
      IF lv_cinfo_raw = '00'.
        lv_target = lv_target && ',"bdcApplies":true'.
      ELSEIF lv_cinfo_raw = '80'.
        lv_target = lv_target && ',"bdcApplies":false'.
      ENDIF.
      lv_target = lv_target && '}'.
    ENDIF.
    lv_target = lv_target && '}'.
    zcl_zmcp_fluid_rt=>out( lv_target ).

    DATA lv_step TYPE string VALUE 'read'.
    TRY.
        DATA ls_header      TYPE rpy_dyhead.
        DATA lt_fields_list TYPE TABLE OF d021s.
        DATA lt_flow_logic  TYPE TABLE OF rpy_dyflow.
        CLEAR: ls_header, lt_fields_list, lt_flow_logic.
        CALL FUNCTION 'RPY_DYNPRO_READ'
          EXPORTING
            progname = lv_program
            dynnr    = lv_dynpro
          IMPORTING
            header   = ls_header
          TABLES
            flow_logic  = lt_flow_logic
            fields_list = lt_fields_list
          EXCEPTIONS
            cancelled        = 1
            not_found        = 2
            permission_error = 3
            OTHERS           = 4.
        IF sy-subrc <> 0.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'subrc' iv_step = lv_step
            iv_text = |RPY_DYNPRO_READ failed for { lv_program } { lv_dynpro }| iv_subrc = sy-subrc ).
          RETURN.
        ENDIF.

        lv_step = 'flow'.
        DATA lv_in_pai    TYPE abap_bool VALUE abap_false.
        DATA lv_pai_idx   TYPE i VALUE 0.
        DATA lt_pai_names TYPE string_table.
        CLEAR lt_pai_names.

        LOOP AT lt_flow_logic INTO DATA(ls_flow).
          DATA(lv_flow_idx) = sy-tabix.
          DATA(lv_line_raw) = CONV string( ls_flow-line ).
          zcl_zmcp_fluid_rt=>out(
            |\\{"kind":"flow","index":{ lv_flow_idx },"line":"{ zcl_zmcp_fluid_rt=>esc( lv_line_raw ) }"\\}| ).

          DATA(lv_u) = to_upper( lv_line_raw ).
          CONDENSE lv_u.
          IF lv_u CP 'PROCESS *'.
            IF lv_u CS 'AFTER INPUT'.
              lv_in_pai = abap_true.
            ELSE.
              lv_in_pai = abap_false.
            ENDIF.
          ELSEIF lv_in_pai = abap_true.
            DATA lt_w TYPE string_table.
            CLEAR lt_w.
            SPLIT lv_u AT space INTO TABLE lt_w.
            DATA lv_w1 TYPE string.
            CLEAR lv_w1.
            IF lines( lt_w ) >= 1.
              lv_w1 = lt_w[ 1 ].
              " A bare "MODULE." would be malformed, but a same-line
              " "ENDMODULE." (the ordinary case - it takes no operand) has
              " no space before its period, so the trailing period stays
              " attached to the first SPLIT token and must be stripped
              " before comparing, same as the module-name trim below.
              IF strlen( lv_w1 ) > 0 AND substring( val = lv_w1 off = strlen( lv_w1 ) - 1 len = 1 ) = '.'.
                lv_w1 = substring( val = lv_w1 off = 0 len = strlen( lv_w1 ) - 1 ).
              ENDIF.
            ENDIF.
            IF lv_w1 = 'MODULE'.
              DATA lv_mname TYPE string.
              CLEAR lv_mname.
              IF lines( lt_w ) >= 2.
                lv_mname = lt_w[ 2 ].
                IF strlen( lv_mname ) > 0
                   AND substring( val = lv_mname off = strlen( lv_mname ) - 1 len = 1 ) = '.'.
                  lv_mname = substring( val = lv_mname off = 0 len = strlen( lv_mname ) - 1 ).
                ENDIF.
              ENDIF.
              DATA(lv_at_exit) = boolc( lv_u CS 'AT EXIT-COMMAND' ).
              DATA lv_cond TYPE string.
              CLEAR lv_cond.
              IF lv_u CS 'ON CHAIN-REQUEST'.
                lv_cond = 'ON CHAIN-REQUEST'.
              ELSEIF lv_u CS 'ON REQUEST'.
                lv_cond = 'ON REQUEST'.
              ENDIF.
              lv_pai_idx = lv_pai_idx + 1.
              APPEND lv_mname TO lt_pai_names.
              DATA lv_pframe TYPE string.
              lv_pframe = |\\{"kind":"pai_module","index":{ lv_pai_idx }|.
              lv_pframe = lv_pframe && |,"name":"{ zcl_zmcp_fluid_rt=>esc( lv_mname ) }"|.
              lv_pframe = lv_pframe &&
                |,"at_exit":{ COND string( WHEN lv_at_exit = abap_true THEN 'true' ELSE 'false' ) }|.
              lv_pframe = lv_pframe && |,"flow_line":{ lv_flow_idx }|.
              IF lv_cond IS NOT INITIAL.
                lv_pframe = lv_pframe && |,"condition":"{ zcl_zmcp_fluid_rt=>esc( lv_cond ) }"|.
              ENDIF.
              lv_pframe = lv_pframe && '}'.
              zcl_zmcp_fluid_rt=>out( lv_pframe ).
            ENDIF.
          ENDIF.
        ENDLOOP.

        lv_step = 'cua'.
        DATA(lv_cua) = cua_json( iv_program = lv_program iv_prog_s = lv_prog_s ).
        zcl_zmcp_fluid_rt=>out( |\\{"kind":"cua"{ lv_cua }\\}| ).

        lv_step = 'includes'.
        SELECT include FROM d010inc WHERE master = @lv_program INTO TABLE @DATA(lt_inc).

        DATA lt_names TYPE string_table.
        CLEAR lt_names.
        APPEND lv_prog_s TO lt_names.
        LOOP AT lt_inc INTO DATA(lv_inc_raw).
          DATA(lv_inc_s) = CONV string( lv_inc_raw ).
          IF lv_inc_s IS INITIAL.
            CONTINUE.
          ENDIF.
          IF lv_inc_s CS '='.
            CONTINUE.
          ENDIF.
          IF lv_inc_s(1) = '%' OR lv_inc_s(1) = '<'.
            CONTINUE.
          ENDIF.
          APPEND lv_inc_s TO lt_names.
        ENDLOOP.

        DATA lv_inc_count  TYPE i VALUE 0.
        DATA lv_inc_failed TYPE i VALUE 0.
        DATA lv_mod_count  TYPE i VALUE 0.
        DATA lv_src_count  TYPE i VALUE 0.
        DATA lv_trunc      TYPE string.
        CLEAR lv_trunc.

        LOOP AT lt_names INTO DATA(lv_name).
          DATA lt_src TYPE string_table.
          CLEAR lt_src.
          " READ REPORT needs a character-like flat field, not a STRING
          " (same gotcha as ZCL_ZMCP_FLUID_SCAN's source scan).
          DATA lv_prog2 TYPE progname.
          lv_prog2 = lv_name.
          READ REPORT lv_prog2 INTO lt_src.
          IF sy-subrc <> 0.
            lv_inc_failed = lv_inc_failed + 1.
            zcl_zmcp_fluid_rt=>out(
              |\\{"kind":"include","name":"{ zcl_zmcp_fluid_rt=>esc( lv_name ) }",| &&
              |"lines":0,"read_error":"READ REPORT failed (sy-subrc { sy-subrc })"\\}| ).
            CONTINUE.
          ENDIF.
          lv_inc_count = lv_inc_count + 1.
          DATA(lv_lines) = lines( lt_src ).
          zcl_zmcp_fluid_rt=>out(
            |\\{"kind":"include","name":"{ zcl_zmcp_fluid_rt=>esc( lv_name ) }","lines":{ lv_lines }\\}| ).

          scan_modules(
            EXPORTING iv_include = lv_name it_src = lt_src it_pai = lt_pai_names
            CHANGING  cv_mod_count = lv_mod_count cv_src_count = lv_src_count cv_trunc = lv_trunc ).
        ENDLOOP.

        DATA(lv_summary) = |\\{"kind":"summary","program":"{ zcl_zmcp_fluid_rt=>esc( lv_prog_s ) }"|.
        lv_summary = lv_summary && |,"dynpro":"{ zcl_zmcp_fluid_rt=>esc( lv_dyn_s ) }"|.
        lv_summary = lv_summary && |,"includes":{ lv_inc_count }|.
        lv_summary = lv_summary && |,"includes_failed":{ lv_inc_failed }|.
        lv_summary = lv_summary && |,"modules":{ lv_mod_count }|.
        lv_summary = lv_summary && |,"pai_modules":{ lv_pai_idx }|.
        lv_summary = lv_summary && |,"src_lines":{ lv_src_count }|.
        lv_summary = lv_summary && |,"truncated":"{ zcl_zmcp_fluid_rt=>esc( lv_trunc ) }"\\}|.
        zcl_zmcp_fluid_rt=>out( lv_summary ).

        gv_trunc = lv_trunc.

      CATCH cx_root INTO DATA(lx_err).
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = lv_step iv_text = lx_err->get_text( ) ).
        RETURN.
    ENDTRY.
  ENDMETHOD.

  METHOD scan_modules.
    DATA lv_mod_open TYPE abap_bool VALUE abap_false.
    DATA lv_mod_name TYPE string.
    DATA lv_mod_from TYPE i.
    DATA(lv_last) = lines( it_src ).

    LOOP AT it_src INTO DATA(lv_srcline).
      DATA(lv_lno) = sy-tabix.
      DATA(lv_lu)  = to_upper( lv_srcline ).
      CONDENSE lv_lu.
      DATA lt_w TYPE string_table.
      CLEAR lt_w.
      SPLIT lv_lu AT space INTO TABLE lt_w.
      DATA lv_w1 TYPE string.
      CLEAR lv_w1.
      IF lines( lt_w ) >= 1.
        lv_w1 = lt_w[ 1 ].
        " "ENDMODULE." takes no operand, so its trailing period has no
        " preceding space and stays attached to the SPLIT token - strip it
        " before comparing (see the same fix in fcode()'s flow-logic scan).
        IF strlen( lv_w1 ) > 0 AND substring( val = lv_w1 off = strlen( lv_w1 ) - 1 len = 1 ) = '.'.
          lv_w1 = substring( val = lv_w1 off = 0 len = strlen( lv_w1 ) - 1 ).
        ENDIF.
      ENDIF.

      IF lv_mod_open = abap_false.
        IF lv_w1 = 'MODULE'.
          lv_mod_open = abap_true.
          lv_mod_from = lv_lno.
          CLEAR lv_mod_name.
          IF lines( lt_w ) >= 2.
            lv_mod_name = lt_w[ 2 ].
            IF strlen( lv_mod_name ) > 0
               AND substring( val = lv_mod_name off = strlen( lv_mod_name ) - 1 len = 1 ) = '.'.
              lv_mod_name = substring( val = lv_mod_name off = 0 len = strlen( lv_mod_name ) - 1 ).
            ENDIF.
          ENDIF.
        ENDIF.
      ELSE.
        IF lv_w1 = 'ENDMODULE'.
          lv_mod_open = abap_false.
          cv_mod_count = cv_mod_count + 1.
          zcl_zmcp_fluid_rt=>out(
            |\\{"kind":"module","name":"{ zcl_zmcp_fluid_rt=>esc( lv_mod_name ) }",| &&
            |"include":"{ zcl_zmcp_fluid_rt=>esc( iv_include ) }",| &&
            |"line_from":{ lv_mod_from },"line_to":{ lv_lno }\\}| ).
          emit_src(
            EXPORTING iv_include = iv_include it_src = it_src iv_from = lv_mod_from iv_to = lv_lno
                      iv_name = lv_mod_name it_pai = it_pai
            CHANGING  cv_src_count = cv_src_count cv_trunc = cv_trunc ).
        ENDIF.
      ENDIF.
    ENDLOOP.

    IF lv_mod_open = abap_true.
      cv_mod_count = cv_mod_count + 1.
      zcl_zmcp_fluid_rt=>out(
        |\\{"kind":"module","name":"{ zcl_zmcp_fluid_rt=>esc( lv_mod_name ) }",| &&
        |"include":"{ zcl_zmcp_fluid_rt=>esc( iv_include ) }",| &&
        |"line_from":{ lv_mod_from },"line_to":{ lv_last },"unterminated":true\\}| ).
      emit_src(
        EXPORTING iv_include = iv_include it_src = it_src iv_from = lv_mod_from iv_to = lv_last
                  iv_name = lv_mod_name it_pai = it_pai
        CHANGING  cv_src_count = cv_src_count cv_trunc = cv_trunc ).
    ENDIF.
  ENDMETHOD.

  METHOD emit_src.
    READ TABLE it_pai TRANSPORTING NO FIELDS WITH KEY table_line = iv_name.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    IF cv_trunc IS NOT INITIAL.
      RETURN.
    ENDIF.

    DATA lv_j TYPE i.
    lv_j = iv_from.
    WHILE lv_j <= iv_to.
      IF cv_src_count >= 4000.
        cv_trunc = 'source'.
        RETURN.
      ENDIF.
      READ TABLE it_src INTO DATA(lv_line) INDEX lv_j.
      IF sy-subrc = 0.
        zcl_zmcp_fluid_rt=>out(
          |\\{"kind":"src","include":"{ zcl_zmcp_fluid_rt=>esc( iv_include ) }",| &&
          |"line":{ lv_j },"text":"{ zcl_zmcp_fluid_rt=>esc( lv_line ) }"\\}| ).
        cv_src_count = cv_src_count + 1.
      ENDIF.
      lv_j = lv_j + 1.
    ENDWHILE.
  ENDMETHOD.

  METHOD row_json.
    " D021S component names are not hard-relied on beyond FNAM (the field
    " name) - see ui-runtime.ts's module header on why the rest are dumped
    " generically via RTTI rather than addressed by name.
    DATA lv_name  TYPE string.
    DATA lv_parts TYPE string.
    DATA lv_val   TYPE string.
    DATA(lo_type) = cl_abap_typedescr=>describe_by_data( iv_data ).
    IF lo_type->kind = cl_abap_typedescr=>kind_struct.
      DATA(lo_struct) = CAST cl_abap_structdescr( lo_type ).
      LOOP AT lo_struct->components INTO DATA(ls_comp).
        ASSIGN COMPONENT ls_comp-name OF STRUCTURE iv_data TO FIELD-SYMBOL(<fs>).
        IF sy-subrc = 0.
          CLEAR lv_val.
          TRY.
              lv_val = |{ <fs> }|.
            CATCH cx_root.
              CLEAR lv_val.
          ENDTRY.
          IF ls_comp-name = 'FNAM'.
            lv_name = lv_val.
          ENDIF.
          IF lv_parts IS NOT INITIAL.
            lv_parts = lv_parts && ','.
          ENDIF.
          lv_parts = lv_parts &&
            |"{ to_lower( ls_comp-name ) }":"{ zcl_zmcp_fluid_rt=>esc( lv_val ) }"|.
        ENDIF.
      ENDLOOP.
    ENDIF.
    rv_json = |\\{"name":"{ zcl_zmcp_fluid_rt=>esc( lv_name ) }"|.
    IF lv_parts IS NOT INITIAL.
      rv_json = rv_json && |,{ lv_parts }|.
    ENDIF.
    rv_json = rv_json && '}'.
  ENDMETHOD.

  METHOD flatten_json.
    DATA lv_parts TYPE string.
    DATA lv_val   TYPE string.
    DATA(lo_type) = cl_abap_typedescr=>describe_by_data( iv_data ).
    IF lo_type->kind = cl_abap_typedescr=>kind_struct.
      DATA(lo_struct) = CAST cl_abap_structdescr( lo_type ).
      LOOP AT lo_struct->components INTO DATA(ls_comp).
        ASSIGN COMPONENT ls_comp-name OF STRUCTURE iv_data TO FIELD-SYMBOL(<fs>).
        IF sy-subrc = 0.
          CLEAR lv_val.
          TRY.
              lv_val = |{ <fs> }|.
            CATCH cx_root.
              CLEAR lv_val.
          ENDTRY.
          IF lv_parts IS NOT INITIAL.
            lv_parts = lv_parts && ','.
          ENDIF.
          lv_parts = lv_parts &&
            |"{ to_lower( ls_comp-name ) }":"{ zcl_zmcp_fluid_rt=>esc( lv_val ) }"|.
        ENDIF.
      ENDLOOP.
    ENDIF.
    rv_json = |\\{{ lv_parts }\\}|.
  ENDMETHOD.

  METHOD cua_json.
    DATA lt_sta   TYPE STANDARD TABLE OF rsmpe_stat.
    DATA lt_fun   TYPE STANDARD TABLE OF rsmpe_funt.
    DATA lt_men   TYPE STANDARD TABLE OF rsmpe_men.
    DATA lt_mtx   TYPE STANDARD TABLE OF rsmpe_mnlt.
    DATA lt_act   TYPE STANDARD TABLE OF rsmpe_act.
    DATA lt_but   TYPE STANDARD TABLE OF rsmpe_but.
    DATA lt_pfk   TYPE STANDARD TABLE OF rsmpe_pfk.
    DATA lt_set   TYPE STANDARD TABLE OF rsmpe_staf.
    DATA lt_doc   TYPE STANDARD TABLE OF rsmpe_atrt.
    DATA lt_tit   TYPE STANDARD TABLE OF rsmpe_titt.
    DATA lt_biv   TYPE STANDARD TABLE OF rsmpe_buts.
    DATA lt_fkeys TYPE STANDARD TABLE OF rseul_keys.
    CLEAR: lt_sta, lt_fun, lt_men, lt_mtx, lt_act, lt_but, lt_pfk, lt_set, lt_doc, lt_tit, lt_biv, lt_fkeys.
    CLEAR rv_json.
    CALL FUNCTION 'RS_CUA_INTERNAL_FETCH'
      EXPORTING
        program = iv_program
      TABLES
        sta = lt_sta
        fun = lt_fun
        men = lt_men
        mtx = lt_mtx
        act = lt_act
        but = lt_but
        pfk = lt_pfk
        set = lt_set
        doc = lt_doc
        tit = lt_tit
        biv = lt_biv
      EXCEPTIONS
        not_found       = 1
        unknown_version = 2
        OTHERS          = 3.
    IF sy-subrc = 1.
      " NOT_FOUND is a normal outcome (program has no GUI status), not a fault.
      rv_json = |,"noCua":\\{"program":"{ zcl_zmcp_fluid_rt=>esc( iv_prog_s ) }"|.
      rv_json = rv_json && ',"note":"no GUI status defined for this program"}'.
      RETURN.
    ELSEIF sy-subrc <> 0.
      " Any other RS_CUA_INTERNAL_FETCH failure is treated as absent CUA data
      " rather than a fault: every field this method contributes is optional,
      " and err() would fail the whole screen read for what is secondary
      " status/button information alongside an otherwise complete result.
      RETURN.
    ENDIF.

    rv_json = |,"statusCount":{ lines( lt_sta ) }|.
    rv_json = rv_json && ',"statusList":['.
    LOOP AT lt_sta INTO DATA(ls_sta).
      IF sy-tabix > 1.
        rv_json = rv_json && ','.
      ENDIF.
      rv_json = rv_json && flatten_json( ls_sta ).
    ENDLOOP.
    rv_json = rv_json && ']'.

    rv_json = rv_json && |,"functionsCount":{ lines( lt_fun ) }|.
    rv_json = rv_json && ',"functions":['.
    LOOP AT lt_fun INTO DATA(ls_fun).
      IF sy-tabix > 1.
        rv_json = rv_json && ','.
      ENDIF.
      rv_json = rv_json && |\\{"code":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_fun-code ) ) }"|.
      rv_json = rv_json && |,"text":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_fun-fun_text ) ) }"|.
      rv_json = rv_json && |,"type":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_fun-type ) ) }"\\}|.
    ENDLOOP.
    rv_json = rv_json && ']'.

    DATA lv_fkeys_total TYPE i VALUE 0.
    DATA lv_status      TYPE gui_status.
    DATA lv_fkeys_json  TYPE string.
    CLEAR lv_fkeys_json.
    LOOP AT lt_sta INTO ls_sta.
      lv_status = ls_sta-code.
      CLEAR lt_fkeys.
      CALL FUNCTION 'RS_CUA_GET_STATUS'
        EXPORTING
          program = iv_program
          status  = lv_status
        TABLES
          fkeys = lt_fkeys
        EXCEPTIONS
          not_found_program = 1
          not_found_status  = 2
          recursive_menues  = 3
          empty_list        = 4
          not_found_menu    = 5
          OTHERS            = 6.
      IF sy-subrc = 0.
        LOOP AT lt_fkeys INTO DATA(ls_fkey).
          IF ls_fkey-code IS NOT INITIAL.
            IF lv_fkeys_json IS NOT INITIAL.
              lv_fkeys_json = lv_fkeys_json && ','.
            ENDIF.
            lv_fkeys_json = lv_fkeys_json && |\\{"status":"{ zcl_zmcp_fluid_rt=>esc( CONV string( lv_status ) ) }"|.
            lv_fkeys_json = lv_fkeys_json && |,"code":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_fkey-code ) ) }"|.
            lv_fkeys_json = lv_fkeys_json && |,"text":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_fkey-text ) ) }"|.
            lv_fkeys_json = lv_fkeys_json &&
              |,"quickinfo":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_fkey-quickinfo ) ) }"\\}|.
            lv_fkeys_total = lv_fkeys_total + 1.
          ENDIF.
        ENDLOOP.
      ENDIF.
    ENDLOOP.

    rv_json = rv_json && |,"fkeysCount":{ lv_fkeys_total }|.
    rv_json = rv_json && |,"fkeys":[{ lv_fkeys_json }]|.
  ENDMETHOD.

ENDCLASS.
`;

export const uiManifest: FluidManifest = {
  contract: FLUID_CONTRACT,
  id: "ui",
  title: "UI",
  description: "Reads a classic dynpro's field list, resolved by tcode or by program+dynpro.",
  objects: [
    {
      name: FLUID_RUNTIME_CLASS,
      type: "CLAS/OC",
      // same live object as the rt tool's; derived so the two descriptions can't drift apart
      description: RUNTIME_OBJECT.description,
      source: { text: RUNTIME_SOURCE },
    },
    {
      name: "ZCL_ZMCP_FLUID_UI",
      type: "CLAS/OC",
      description: "fluid: dynpro field list and static fcode trace",
      source: { text: UI_SOURCE },
    },
  ],
  entry: "ZCL_ZMCP_FLUID_UI",
  actions: [
    {
      name: "screen",
      category: "read",
      description:
        "Resolves a screen by tcode (via TSTC) or by explicit program+dynpro, and reads its field " +
        "list via RPY_DYNPRO_READ. Give tcode, or both program and dynpro - not both forms.",
      input: {
        type: "object",
        properties: {
          tcode: {
            type: "string",
            maxLength: 20,
            description: "Transaction code to resolve via TSTC. Takes precedence over program/dynpro.",
          },
          program: {
            type: "string",
            maxLength: 40,
            description: "Explicit ABAP program name. Requires dynpro; ignored if tcode is given.",
          },
          dynpro: {
            type: "string",
            maxLength: 4,
            description: "Explicit dynpro number, 1-4 digits. Requires program; ignored if tcode is given.",
          },
        },
      },
      output: {
        type: "object",
        required: ["program", "dynpro", "fields"],
        properties: {
          tcode: {
            type: "object",
            required: ["tcode", "program", "dynpro", "cinfo", "kind"],
            description: "Only present when resolved by tcode. TSTC-derived transaction metadata.",
            properties: {
              tcode: { type: "string", description: "The caller-supplied tcode, as given." },
              program: { type: "string", description: "TSTC-PGMNA for this tcode." },
              dynpro: { type: "string", description: "TSTC-DYPNO for this tcode." },
              cinfo: { type: "string", description: "TSTC-CINFO, raw." },
              kind: { type: "string", description: "Human-readable classification of cinfo." },
              bdcApplies: {
                type: "boolean",
                description: "true for cinfo '00', false for '80', absent otherwise (unconfirmed).",
              },
            },
          },
          program: { type: "string", maxLength: 40, description: "The resolved ABAP program name." },
          dynpro: { type: "string", maxLength: 4, description: "The resolved dynpro number." },
          header: {
            type: "object",
            description: "RPY_DYHEAD, dumped generically as lowercased-component-name:value pairs.",
          },
          fields: {
            type: "array",
            items: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string", description: "The field's D021S-FNAM name." },
              },
              description: "One D021S row per field, dumped generically alongside the derived name.",
            },
            description: "The dynpro's field list, in RPY_DYNPRO_READ's own order.",
          },
          flowCount: { type: "integer", description: "Row count of the flow logic table." },
          flow: {
            type: "array",
            items: { type: "object", description: "One RPY_DYFLOW row, dumped generically." },
            description: "The dynpro's flow logic, in RPY_DYNPRO_READ's own order.",
          },
          statusCount: { type: "integer", description: "Row count of the program's GUI statuses." },
          statusList: {
            type: "array",
            items: { type: "object", description: "One RSMPE_STAT row, dumped generically." },
            description: "The program's GUI statuses, from RS_CUA_INTERNAL_FETCH.",
          },
          functionsCount: { type: "integer", description: "Row count of functions." },
          functions: {
            type: "array",
            items: {
              type: "object",
              required: ["code", "text", "type"],
              properties: {
                code: { type: "string" },
                text: { type: "string" },
                type: { type: "string" },
              },
              description: "One RSMPE_FUNT row, as a fixed {code, text, type} projection.",
            },
            description: "Program-wide function codes, not tied to one status.",
          },
          fkeysCount: { type: "integer", description: "Total FKEY rows emitted, across all statuses." },
          fkeys: {
            type: "array",
            items: {
              type: "object",
              required: ["status", "code", "text", "quickinfo"],
              properties: {
                status: { type: "string" },
                code: { type: "string" },
                text: { type: "string" },
                quickinfo: { type: "string" },
              },
              description: "One RSEUL_KEYS row from RS_CUA_GET_STATUS, empty-code rows dropped.",
            },
            description: "Union of per-status buttons across every status.",
          },
          noCua: {
            type: "object",
            required: ["program", "note"],
            description: "Present when RS_CUA_INTERNAL_FETCH reports no GUI status for this program.",
            properties: {
              program: { type: "string" },
              note: { type: "string" },
            },
          },
        },
      },
    },
    {
      name: "fcode",
      category: "read",
      description:
        "Static trace of a classic dynpro function code: resolves the screen exactly like `screen`, reads its " +
        "flow logic to find the PAI modules for the given (or every) function code, then reads the module " +
        "source out of the program's includes. Runs nothing - no CALL TRANSACTION, no BDCDATA.",
      input: {
        type: "object",
        properties: {
          tcode: {
            type: "string",
            maxLength: 20,
            description: "Transaction code to resolve via TSTC. Takes precedence over program/dynpro.",
          },
          program: {
            type: "string",
            maxLength: 40,
            description: "Explicit ABAP program name. Requires dynpro; ignored if tcode is given.",
          },
          dynpro: {
            type: "string",
            maxLength: 4,
            description: "Explicit dynpro number, 1-4 digits. Requires program; ignored if tcode is given.",
          },
          fcode: {
            type: "string",
            maxLength: 20,
            description: "Not used by the ABAP side - it is only echoed back on the target frame. " +
              "Which function code(s) to trace is decided in TypeScript from the CUA/flow frames below.",
          },
        },
      },
      output: {
        type: "array",
        description:
          "One target frame, one flow frame per flow-logic row, one pai_module frame per PAI module, one cua " +
          "frame, one include frame per scanned include, one module frame per MODULE...ENDMODULE span found in " +
          "any include, one src frame per source line of every PAI-listed module (capped), then one summary frame.",
        items: {
          type: "object",
          required: ["kind"],
          properties: {
            kind: { type: "string", description: "target | flow | pai_module | cua | include | module | src | summary" },
            program: { type: "string", description: "target/summary: the resolved program." },
            dynpro: { type: "string", description: "target/summary: the resolved dynpro." },
            fcode_filter: { type: "string", description: "target: the caller's `fcode` input, verbatim." },
            tcode: {
              type: "object",
              description: "target: present only when resolved by tcode - same shape as screen's tcode object.",
              properties: {
                tcode: { type: "string" },
                program: { type: "string" },
                dynpro: { type: "string" },
                cinfo: { type: "string" },
                kind: { type: "string" },
                bdcApplies: { type: "boolean" },
              },
            },
            index: { type: "integer", description: "flow: 1-based row index. pai_module: 1-based PAI-module index." },
            line: {
              type: "string",
              description: "flow: the verbatim flow-logic LINE text. src: overloaded as an integer - see below.",
            },
            name: { type: "string", description: "pai_module/module: the module name, uppercased." },
            at_exit: { type: "boolean", description: "pai_module: true when the flow line names AT EXIT-COMMAND." },
            condition: { type: "string", description: "pai_module: ON CHAIN-REQUEST or ON REQUEST, when present." },
            flow_line: { type: "integer", description: "pai_module: the flow row index this module came from." },
            include: { type: "string", description: "module/src: the include the module/line was found in." },
            line_from: { type: "integer", description: "module: first source line of the module body." },
            line_to: { type: "integer", description: "module: last source line (ENDMODULE line, or EOF)." },
            unterminated: { type: "boolean", description: "module: true when no ENDMODULE was found before EOF." },
            lines: { type: "integer", description: "include: source line count." },
            read_error: { type: "string", description: "include: present when READ REPORT failed for it." },
            text: { type: "string", description: "src: one verbatim source line." },
            includes: { type: "integer", description: "summary: includes successfully read." },
            includes_failed: { type: "integer", description: "summary: includes READ REPORT failed for." },
            modules: { type: "integer", description: "summary: total MODULE spans found, across all includes." },
            pai_modules: { type: "integer", description: "summary: PAI module count from the flow logic." },
            src_lines: { type: "integer", description: "summary: total src frames emitted." },
            truncated: { type: "string", description: "summary: '' or 'source' when the 4000-line src cap was hit." },
          },
        },
      },
    },
  ],
};

export const uiSources: ReadonlyMap<string, string> = new Map([
  [FLUID_RUNTIME_CLASS, RUNTIME_SOURCE],
  ["ZCL_ZMCP_FLUID_UI", UI_SOURCE],
]);
