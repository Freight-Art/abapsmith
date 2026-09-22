/**
 * Built-in "fpm" fluid tool: read-only access to FPM/FBI screen configs,
 * reimplementing the read path of `src/adt/fpm-runtime.ts` (`findBody`,
 * `outlineBody`, `appBody`) as one statically-deployed body class instead of
 * a class generated per call. Table/API choices (WDY_CONFIG_DATA/APPL,
 * their _DATT/_APPT text tables, TADIR as a per-row devclass cross-
 * reference, CL_WDR_CFG_PERSISTENCE_UTILS=>READ_COMP_CONFIG_FROM_DB,
 * CL_FPM_CFG_HRCHY_BRWSR_ASSIST) are unchanged from the legacy bridge; see
 * fpm-runtime.ts's header for the sandbox evidence behind them.
 *
 * Two adaptations from the legacy per-call generation model:
 *
 *  - `find`'s LIKE pattern (legacy: `buildLikePattern`, baked into the
 *    generated SELECT as a literal) is rebuilt in ABAP at call time, since a
 *    static body class receives its query as data (`iv_json`), not source
 *    text: `_`->`#_`, `*`->`%`, bound via a host variable with
 *    `LIKE ... ESCAPE '#'`.
 *  - `outline`'s XML no longer streams through the legacy `<tag>_BEGIN` /
 *    `<tag>C` / `<tag>_END` dialect (`emit_xml`); it goes out as one JSON
 *    value via `out_chunk` fragments closed by a trailing `out('')`, which
 *    `protocol.ts` reassembles into a single string before dispatch parses
 *    it — chunking is a wire-size concern only, invisible to the caller.
 *
 * `dispatch()` fails the whole action on any ERR frame, regardless of
 * `end()`'s rc, so the legacy per-item "log and keep going" diagnostics
 * can't be ported as `err()` calls without turning them into whole-action
 * failures. `outline`'s not-found case (a single requested key) is
 * therefore a genuine `err()` failure here, sharper than legacy's silent
 * empty-XML result. `app`'s per-node resolve failure (one node out of a
 * whole tree) stays non-fatal: it's reported in that node's own
 * `resolve_error` field, with no `err()` call, so the rest of the tree
 * still comes back.
 */
import type { FluidManifest } from "../manifest.js";
import { FLUID_CONTRACT } from "../manifest.js";
import { FLUID_RUNTIME_CLASS, fluidRuntimeManifest, fluidRuntimeSources } from "../abap/runtime.js";

/** WDY_CONFIG_ID's length (CHAR32); re-exported from fpm-runtime.ts for existing callers. */
export const CONFIG_ID_LEN = 32;

const RUNTIME_SOURCE = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS);
if (RUNTIME_SOURCE === undefined) {
  throw new Error(`fluidRuntimeSources has no entry for ${FLUID_RUNTIME_CLASS}`);
}

const RUNTIME_OBJECT = fluidRuntimeManifest.objects.find((o) => o.name === FLUID_RUNTIME_CLASS);
if (RUNTIME_OBJECT === undefined) {
  throw new Error(`fluidRuntimeManifest has no entry for ${FLUID_RUNTIME_CLASS}`);
}

const FPM_SOURCE = `CLASS zcl_zmcp_fluid_fpm DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    CLASS-METHODS run
      IMPORTING
        iv_action TYPE string
        iv_json   TYPE string.

  PRIVATE SECTION.
    TYPES: BEGIN OF ty_ref,
             component   TYPE string,
             config_id   TYPE string,
             config_type TYPE string,
             config_var  TYPE string,
             ref_node    TYPE string,
           END OF ty_ref,
           tt_ref TYPE STANDARD TABLE OF ty_ref WITH EMPTY KEY.

    " Issue #101 Defect 3: FOR ALL ENTRIES requires the itab field and the DB
    " column to have the same type AND length - ty_ref's STRING components
    " (built for XML-derived values of unknown length) do not qualify against
    " WDY_CONFIG_COMPT's fixed-length key fields, so this driver table is
    " typed directly off that table's own key components instead.
    TYPES: BEGIN OF ty_text_cfg,
             config_id   TYPE wdy_config_compt-config_id,
             config_type TYPE wdy_config_compt-config_type,
             config_var  TYPE wdy_config_compt-config_var,
           END OF ty_text_cfg,
           tt_text_cfg TYPE STANDARD TABLE OF ty_text_cfg WITH EMPTY KEY.

    CLASS-METHODS find.
    CLASS-METHODS outline.
    CLASS-METHODS app.
    CLASS-METHODS events.
    CLASS-METHODS resolve.

    CLASS-METHODS read_config
      IMPORTING iv_config_id      TYPE string
                iv_config_type    TYPE string
                iv_config_var     TYPE string
      EXPORTING ev_xml            TYPE string
                ev_component      TYPE string
                ev_devclass       TYPE string
                ev_config_idpar   TYPE string
                ev_config_typepar TYPE string
                ev_config_varpar  TYPE string
                ev_error          TYPE string.

    CLASS-METHODS parse_doc
      IMPORTING iv_xml         TYPE string
      RETURNING VALUE(ro_root) TYPE REF TO if_ixml_element.

    CLASS-METHODS child_text
      IMPORTING io_parent      TYPE REF TO if_ixml_element
                iv_name        TYPE string
      RETURNING VALUE(rv_text) TYPE string.

    CLASS-METHODS norm_id
      IMPORTING iv         TYPE string
      RETURNING VALUE(rv)  TYPE string.

    CLASS-METHODS walk_refs
      IMPORTING io_node     TYPE REF TO if_ixml_element
                iv_ref_node TYPE string
      CHANGING  ct_refs     TYPE tt_ref.

    CLASS-METHODS walk_bo
      IMPORTING io_node TYPE REF TO if_ixml_element
      CHANGING  ct_bo   TYPE string_table.

ENDCLASS.


CLASS zcl_zmcp_fluid_fpm IMPLEMENTATION.

  METHOD run.
    zcl_zmcp_fluid_rt=>begin( iv_id = 'fpm' iv_action = iv_action ).

    TRY.
        zcl_zmcp_fluid_rt=>scan( iv_json ).
        CASE iv_action.
          WHEN 'find'.
            find( ).
          WHEN 'outline'.
            outline( ).
          WHEN 'app'.
            app( ).
          WHEN 'events'.
            events( ).
          WHEN 'resolve'.
            resolve( ).
          WHEN OTHERS.
            zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'dispatch'
              iv_text = |unknown action "{ iv_action }"| ).
        ENDCASE.
      CATCH cx_root INTO DATA(lx_err).
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = iv_action iv_text = lx_err->get_text( ) ).
    ENDTRY.

    IF zcl_zmcp_fluid_rt=>failed( ) = abap_true.
      zcl_zmcp_fluid_rt=>end( 1 ).
    ELSE.
      zcl_zmcp_fluid_rt=>end( 0 ).
    ENDIF.
  ENDMETHOD.

  METHOD find.
    DATA(lv_config_type) = zcl_zmcp_fluid_rt=>s( 'config_type' ).
    IF lv_config_type IS INITIAL.
      lv_config_type = '00'.
    ENDIF.
    DATA(lv_component) = zcl_zmcp_fluid_rt=>s( 'component' ).
    DATA(lv_query)      = zcl_zmcp_fluid_rt=>s( 'query' ).
    DATA(lv_package)    = zcl_zmcp_fluid_rt=>s( 'package' ).

    IF lv_config_type = '02' AND lv_component IS NOT INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
        iv_text = 'component does not apply to application configs (config_type 02)' ).
      RETURN.
    ENDIF.

    DATA(lv_has_component) = xsdbool( lv_component IS NOT INITIAL ).
    DATA(lv_has_query)     = xsdbool( lv_query IS NOT INITIAL ).
    DATA(lv_has_package)   = xsdbool( lv_package IS NOT INITIAL ).

    DATA(lv_pattern) = lv_query.
    REPLACE ALL OCCURRENCES OF '_' IN lv_pattern WITH '#_'.
    REPLACE ALL OCCURRENCES OF '*' IN lv_pattern WITH '%'.

    IF lv_config_type = '02'.
      SELECT config_id, config_type, config_var
        FROM wdy_config_appl
        WHERE config_type = @lv_config_type
          AND ( @lv_has_query = @abap_false OR config_id LIKE @lv_pattern ESCAPE '#' )
        INTO TABLE @DATA(lt_appl).
      LOOP AT lt_appl INTO DATA(ls_appl).
        DATA(lv_desc) = ||.
        SELECT SINGLE description FROM wdy_config_appt
          WHERE config_id = @ls_appl-config_id AND config_type = @ls_appl-config_type
            AND config_var = @ls_appl-config_var AND langu = @sy-langu
          INTO @lv_desc.
        DATA lv_key40 TYPE c LENGTH 40.
        CLEAR lv_key40.
        lv_key40(32)   = ls_appl-config_id.
        lv_key40+32(2) = ls_appl-config_type.
        lv_key40+34(6) = ls_appl-config_var.
        DATA(lv_devclass) = ||.
        SELECT SINGLE devclass FROM tadir
          WHERE pgmid = 'R3TR' AND object = 'WDCA' AND obj_name = @lv_key40
          INTO @lv_devclass.
        IF lv_has_package = abap_true AND lv_devclass <> lv_package.
          CONTINUE.
        ENDIF.
        " esc() takes TYPE string by reference; a DDIC-typed struct field must
        " be materialised into a string first, or activation fails.
        DATA(lv_aid)   = |{ ls_appl-config_id }|.
        DATA(lv_atype) = |{ ls_appl-config_type }|.
        DATA(lv_avar)  = |{ ls_appl-config_var }|.

        " An application config's XCONTENT references the one
        " component config mode=app actually resolves and loads - decode it
        " (same pattern as read_config's '02' branch) and pull the first
        " <Component Name="..." ConfId="..."/> out with PCRE, anchored on
        " <Component so the outer <Application ConfId="..."> is not matched.
        DATA(lv_comp_name)   = ||.
        DATA(lv_comp_confid) = ||.
        DATA lv_axc TYPE xstring.
        CLEAR lv_axc.
        SELECT SINGLE xcontent FROM wdy_config_appl
          WHERE config_id = @ls_appl-config_id AND config_type = @ls_appl-config_type
            AND config_var = @ls_appl-config_var
          INTO @lv_axc.
        IF sy-subrc = 0 AND lv_axc IS NOT INITIAL.
          DATA(lo_aconv) = cl_abap_conv_in_ce=>create( encoding = 'UTF-8' input = lv_axc ).
          DATA(lv_axml) = ||.
          lo_aconv->read( IMPORTING data = lv_axml ).
          FIND PCRE '<Component[^>]*\\bName="([^"]*)"' IN lv_axml SUBMATCHES lv_comp_name.
          FIND PCRE '<Component[^>]*\\bConfId="([^"]*)"' IN lv_axml SUBMATCHES lv_comp_confid.
        ENDIF.

        DATA(lv_loadable) = abap_true.
        DATA(lv_reason)   = ||.
        IF lv_comp_confid IS NOT INITIAL.
          DATA(lv_exists_comp) = ||.
          SELECT SINGLE config_id FROM wdy_config_data
            WHERE config_id = @lv_comp_confid AND config_type = '00'
            INTO @lv_exists_comp.
          IF sy-subrc <> 0.
            lv_loadable = abap_false.
            lv_reason = |references component configuration { lv_comp_confid } which does not exist in WDY_CONFIG_DATA|.
          ENDIF.
        ENDIF.
        DATA(lv_loadable_s) = COND string( WHEN lv_loadable = abap_true THEN 'true' ELSE 'false' ).

        zcl_zmcp_fluid_rt=>out(
          |\\{"config_id":"{ zcl_zmcp_fluid_rt=>esc( lv_aid ) }",| &&
          |"config_type":"{ zcl_zmcp_fluid_rt=>esc( lv_atype ) }",| &&
          |"config_var":"{ zcl_zmcp_fluid_rt=>esc( lv_avar ) }",| &&
          |"component":"{ zcl_zmcp_fluid_rt=>esc( lv_comp_name ) }",| &&
          |"description":"{ zcl_zmcp_fluid_rt=>esc( lv_desc ) }",| &&
          |"devclass":"{ zcl_zmcp_fluid_rt=>esc( lv_devclass ) }",| &&
          |"loadable":{ lv_loadable_s },| &&
          |"app_config_id":"{ zcl_zmcp_fluid_rt=>esc( lv_aid ) }",| &&
          |"component_config_id":"{ zcl_zmcp_fluid_rt=>esc( lv_comp_confid ) }",| &&
          |"reason":"{ zcl_zmcp_fluid_rt=>esc( lv_reason ) }"\\}| ).
      ENDLOOP.
    ELSE.
      SELECT config_id, config_type, config_var, component
        FROM wdy_config_data
        WHERE config_type = @lv_config_type
          AND ( @lv_has_component = @abap_false OR component = @lv_component )
          AND ( @lv_has_query = @abap_false OR config_id LIKE @lv_pattern ESCAPE '#' )
        INTO TABLE @DATA(lt_data).
      LOOP AT lt_data INTO DATA(ls_data).
        DATA(lv_desc2) = ||.
        SELECT SINGLE description FROM wdy_config_datt
          WHERE config_id = @ls_data-config_id AND config_type = @ls_data-config_type
            AND config_var = @ls_data-config_var AND langu = @sy-langu
          INTO @lv_desc2.
        DATA lv_key40b TYPE c LENGTH 40.
        CLEAR lv_key40b.
        lv_key40b(32)   = ls_data-config_id.
        lv_key40b+32(2) = ls_data-config_type.
        lv_key40b+34(6) = ls_data-config_var.
        DATA(lv_devclass2) = ||.
        SELECT SINGLE devclass FROM tadir
          WHERE pgmid = 'R3TR' AND object = 'WDCC' AND obj_name = @lv_key40b
          INTO @lv_devclass2.
        IF lv_has_package = abap_true AND lv_devclass2 <> lv_package.
          CONTINUE.
        ENDIF.
        DATA(lv_did)   = |{ ls_data-config_id }|.
        DATA(lv_dtype) = |{ ls_data-config_type }|.
        DATA(lv_dvar)  = |{ ls_data-config_var }|.
        DATA(lv_dcomp) = |{ ls_data-component }|.

        " mode=app loads application configs (config_type 02),
        " never component configs (config_type 00) directly - tell the
        " caller which application config (if any) references this one, or
        " why this id is not loadable by mode=app at all.
        DATA(lv_dapp_config_id) = ||.
        DATA(lv_dloadable) = abap_true.
        DATA(lv_dreason)   = ||.
        IF lv_dtype = '00'.
          DATA(lv_dexists_app) = ||.
          SELECT SINGLE config_id FROM wdy_config_appl
            WHERE config_id = @ls_data-config_id AND config_type = '02'
            INTO @lv_dexists_app.
          IF sy-subrc = 0.
            lv_dapp_config_id = lv_dexists_app.
          ELSE.
            lv_dloadable = abap_false.
            lv_dreason = |component configuration (config_type 00); mode=app loads application configurations (config_type 02) - pass this id to mode=app anyway and it resolves the application configuration that references it|.
          ENDIF.
        ELSE.
          lv_dloadable = abap_false.
          lv_dreason = |config_type { lv_dtype } is not loadable by mode=app|.
        ENDIF.
        DATA(lv_dloadable_s) = COND string( WHEN lv_dloadable = abap_true THEN 'true' ELSE 'false' ).

        zcl_zmcp_fluid_rt=>out(
          |\\{"config_id":"{ zcl_zmcp_fluid_rt=>esc( lv_did ) }",| &&
          |"config_type":"{ zcl_zmcp_fluid_rt=>esc( lv_dtype ) }",| &&
          |"config_var":"{ zcl_zmcp_fluid_rt=>esc( lv_dvar ) }",| &&
          |"component":"{ zcl_zmcp_fluid_rt=>esc( lv_dcomp ) }",| &&
          |"description":"{ zcl_zmcp_fluid_rt=>esc( lv_desc2 ) }",| &&
          |"devclass":"{ zcl_zmcp_fluid_rt=>esc( lv_devclass2 ) }",| &&
          |"loadable":{ lv_dloadable_s },| &&
          |"app_config_id":"{ zcl_zmcp_fluid_rt=>esc( lv_dapp_config_id ) }",| &&
          |"component_config_id":"{ zcl_zmcp_fluid_rt=>esc( lv_did ) }",| &&
          |"reason":"{ zcl_zmcp_fluid_rt=>esc( lv_dreason ) }"\\}| ).
      ENDLOOP.
    ENDIF.
  ENDMETHOD.

  METHOD outline.
    DATA(lv_config_id) = zcl_zmcp_fluid_rt=>s( 'config_id' ).
    DATA(lv_config_type) = zcl_zmcp_fluid_rt=>s( 'config_type' ).
    IF lv_config_type IS INITIAL.
      lv_config_type = '00'.
    ENDIF.
    DATA(lv_config_var) = zcl_zmcp_fluid_rt=>s( 'config_var' ).

    IF lv_config_id IS INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args' iv_text = 'config_id is required' ).
      RETURN.
    ENDIF.

    read_config(
      EXPORTING iv_config_id      = lv_config_id
                iv_config_type    = lv_config_type
                iv_config_var     = lv_config_var
      IMPORTING ev_xml            = DATA(lv_xml)
                ev_component      = DATA(lv_component)
                ev_devclass       = DATA(lv_devclass)
                ev_config_idpar   = DATA(lv_config_idpar)
                ev_config_typepar = DATA(lv_config_typepar)
                ev_config_varpar  = DATA(lv_config_varpar)
                ev_error          = DATA(lv_error) ).

    IF lv_error IS NOT INITIAL.
      " Same two failure shapes as before the read_config refactor: a
      " WDY_CONFIG_APPL miss is always subrc 4 (SELECT SINGLE found nothing),
      " and read_comp_config_from_db failures are always the exception shape.
      " lv_config_type is already known here, so which branch ran doesn't
      " need to come back from read_config to reproduce the original err().
      IF lv_config_type = '02'.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'subrc' iv_step = 'select' iv_subrc = 4 iv_text = lv_error ).
      ELSE.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'read_comp_config_from_db' iv_text = lv_error ).
      ENDIF.
      RETURN.
    ENDIF.

    DATA(lv_json) =
      |\\{"config_id":"{ zcl_zmcp_fluid_rt=>esc( lv_config_id ) }",| &&
      |"config_type":"{ zcl_zmcp_fluid_rt=>esc( lv_config_type ) }",| &&
      |"config_var":"{ zcl_zmcp_fluid_rt=>esc( lv_config_var ) }",| &&
      |"xml":"{ zcl_zmcp_fluid_rt=>esc( lv_xml ) }","meta":\\{| &&
      |"config_idpar":"{ zcl_zmcp_fluid_rt=>esc( lv_config_idpar ) }",| &&
      |"config_typepar":"{ zcl_zmcp_fluid_rt=>esc( lv_config_typepar ) }",| &&
      |"config_varpar":"{ zcl_zmcp_fluid_rt=>esc( lv_config_varpar ) }",| &&
      |"component":"{ zcl_zmcp_fluid_rt=>esc( lv_component ) }",| &&
      |"devclass":"{ zcl_zmcp_fluid_rt=>esc( lv_devclass ) }"\\}\\}|.
    zcl_zmcp_fluid_rt=>out_chunk( lv_json ).
    zcl_zmcp_fluid_rt=>out( '' ).
  ENDMETHOD.

  METHOD app.
    DATA(lv_config_id) = zcl_zmcp_fluid_rt=>s( 'config_id' ).
    DATA(lv_resolve)    = zcl_zmcp_fluid_rt=>b( 'resolve' ).

    IF lv_config_id IS INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args' iv_text = 'config_id is required' ).
      RETURN.
    ENDIF.

    DATA lo_as TYPE REF TO cl_fpm_cfg_hrchy_brwsr_assist.
    CREATE OBJECT lo_as.
    lo_as->mv_mode = 2.
    lo_as->init_affixes( ).
    lo_as->ms_config_key-config_id   = lv_config_id.
    lo_as->ms_config_key-config_type = '02'.
    TRY.
        lo_as->load_configuration( lo_as->mc_level-conf ).
      CATCH cx_root INTO DATA(lx_load).
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'load_configuration'
          iv_text = lx_load->get_text( ) ).
        RETURN.
    ENDTRY.

    LOOP AT lo_as->mt_node_table INTO DATA(ls_node).
      DATA(lv_resolved_json) = ||.
      " esc()/out() take TYPE string by reference; every DDIC-typed node field
      " used below is materialised into a string first, or activation fails.
      DATA(lv_npath)   = |{ ls_node-node_path }|.
      DATA(lv_nparent) = |{ ls_node-parent_node_path }|.
      DATA(lv_nname)   = |{ ls_node-node_name }|.
      DATA(lv_ndesc)   = |{ ls_node-description }|.
      DATA(lv_ncomp)   = |{ ls_node-component_name }|.
      DATA(lv_niv)     = |{ ls_node-interface_view }|.
      DATA(lv_ncfgid)  = |{ ls_node-config_id }|.
      DATA(lv_ncfgtyp) = |{ ls_node-config_type }|.
      DATA(lv_ncfgvar) = |{ ls_node-config_var }|.
      DATA(lv_ntarget) = |{ ls_node-target_config_id }|.
      DATA(lv_ntop)  = COND string( WHEN ls_node-is_top_node = abap_true THEN 'true' ELSE 'false' ).
      DATA(lv_ncfg)  = COND string( WHEN ls_node-is_configurable = abap_true THEN 'true' ELSE 'false' ).
      DATA(lv_ncust) = COND string( WHEN ls_node-is_customized = abap_true THEN 'true' ELSE 'false' ).
      DATA(lv_nenh)  = COND string( WHEN ls_node-is_enhanced = abap_true THEN 'true' ELSE 'false' ).
      DATA(lv_nfree) = COND string( WHEN ls_node-is_freestyle_uibb = abap_true THEN 'true' ELSE 'false' ).
      DATA(lv_nleaf) = COND string( WHEN ls_node-is_leaf = abap_true THEN 'true' ELSE 'false' ).

      IF lv_resolve = abap_true AND ls_node-component_name IS NOT INITIAL
          AND ls_node-is_configurable = abap_true.
        DATA ls_rkey TYPE wdy_config_key.
        CLEAR ls_rkey.
        ls_rkey-config_id   = ls_node-config_id.
        ls_rkey-config_type = ls_node-config_type.
        ls_rkey-config_var  = ls_node-config_var.
        DATA lv_rxc TYPE xstring.
        CLEAR lv_rxc.
        DATA(lv_resolve_err) = ||.
        TRY.
            cl_wdr_cfg_persistence_utils=>read_comp_config_from_db(
              EXPORTING config_key   = ls_rkey
              IMPORTING xml_xcontent = lv_rxc ).
          CATCH cx_root INTO DATA(lxr).
            lv_resolve_err = lxr->get_text( ).
        ENDTRY.
        IF lv_resolve_err IS NOT INITIAL.
          lv_resolved_json = |,"resolve_error":"{ zcl_zmcp_fluid_rt=>esc( lv_resolve_err ) }"|.
        ELSE.
          DATA(lv_rtxt) = ||.
          IF lv_rxc IS NOT INITIAL.
            DATA(lo_rconv) = cl_abap_conv_in_ce=>create( encoding = 'UTF-8' input = lv_rxc ).
            lo_rconv->read( IMPORTING data = lv_rtxt ).
          ENDIF.
          DATA(lv_feeder) = abap_false.
          DATA(lv_bopf)   = abap_false.
          IF lv_rtxt CS 'FEEDER'.
            lv_feeder = abap_true.
          ENDIF.
          IF lv_rtxt CS '/BOBF/' OR lv_rtxt CS 'BOPF' OR lv_rtxt CS 'BO_KEY'.
            lv_bopf = abap_true.
          ENDIF.
          DATA(lv_excerpt) = substring( val = lv_rtxt len = nmin( val1 = strlen( lv_rtxt ) val2 = 300 ) ).
          DATA(lv_feeder_s) = COND string( WHEN lv_feeder = abap_true THEN 'true' ELSE 'false' ).
          DATA(lv_bopf_s)   = COND string( WHEN lv_bopf = abap_true THEN 'true' ELSE 'false' ).
          lv_resolved_json =
            |,"resolved":\\{"xml_len":{ strlen( lv_rtxt ) },| &&
            |"feeder_hint":{ lv_feeder_s },"bopf_hint":{ lv_bopf_s },| &&
            |"excerpt":"{ zcl_zmcp_fluid_rt=>esc( lv_excerpt ) }"\\}|.
        ENDIF.
      ENDIF.

      zcl_zmcp_fluid_rt=>out(
        |\\{"node_path":"{ zcl_zmcp_fluid_rt=>esc( lv_npath ) }",| &&
        |"parent_path":"{ zcl_zmcp_fluid_rt=>esc( lv_nparent ) }",| &&
        |"is_top_node":{ lv_ntop },| &&
        |"node_name":"{ zcl_zmcp_fluid_rt=>esc( lv_nname ) }",| &&
        |"description":"{ zcl_zmcp_fluid_rt=>esc( lv_ndesc ) }",| &&
        |"component_name":"{ zcl_zmcp_fluid_rt=>esc( lv_ncomp ) }",| &&
        |"interface_view":"{ zcl_zmcp_fluid_rt=>esc( lv_niv ) }",| &&
        |"config_id":"{ zcl_zmcp_fluid_rt=>esc( lv_ncfgid ) }",| &&
        |"config_type":"{ zcl_zmcp_fluid_rt=>esc( lv_ncfgtyp ) }",| &&
        |"config_var":"{ zcl_zmcp_fluid_rt=>esc( lv_ncfgvar ) }",| &&
        |"target_config_id":"{ zcl_zmcp_fluid_rt=>esc( lv_ntarget ) }",| &&
        |"is_configurable":{ lv_ncfg },| &&
        |"is_customized":{ lv_ncust },| &&
        |"is_enhanced":{ lv_nenh },| &&
        |"is_freestyle_uibb":{ lv_nfree },| &&
        |"is_leaf":{ lv_nleaf }| &&
        lv_resolved_json && |\\}| ).
    ENDLOOP.
  ENDMETHOD.

  METHOD resolve.
    " Given one config_id, report whether it is an application
    " config (mode=app's own table), a component config, or both, and -
    " when it is a component config - which application config(s) reference
    " it, so mode=app can resolve a component id to the application id it
    " actually needs without a second round trip from the caller.
    DATA(lv_config_id) = zcl_zmcp_fluid_rt=>s( 'config_id' ).
    IF lv_config_id IS INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args' iv_text = 'config_id is required' ).
      RETURN.
    ENDIF.

    DATA(lv_exists_app_id) = ||.
    SELECT SINGLE config_id FROM wdy_config_appl
      WHERE config_id = @lv_config_id AND config_type = '02'
      INTO @lv_exists_app_id.
    DATA(lv_exists_as_app) = xsdbool( sy-subrc = 0 ).

    DATA(lv_comp_var) = ||.
    DATA(lv_comp)     = ||.
    SELECT SINGLE config_var, component FROM wdy_config_data
      WHERE config_id = @lv_config_id AND config_type = '00'
      INTO ( @lv_comp_var, @lv_comp ).
    DATA(lv_exists_as_component) = xsdbool( sy-subrc = 0 ).

    DATA(lv_apps_json) = ||.
    DATA(lv_count)     = 0.
    DATA(lv_truncated) = abap_false.

    IF lv_exists_as_component = abap_true.
      " config_id is not a PCRE metacharacter source: assertConfigId/
      " ABAP_NAME on the TypeScript side already restrict it to letters,
      " digits, underscore and slash, so it embeds into the pattern below
      " with no escaping.
      DATA(lv_pat) = '<Component[^>]*\\bConfId="' && lv_config_id && '"'.
      SELECT config_id, config_var, application, xcontent FROM wdy_config_appl
        WHERE config_type = '02'
        INTO TABLE @DATA(lt_appl2).
      LOOP AT lt_appl2 INTO DATA(ls_appl2).
        DATA(lv_atxt) = ||.
        IF ls_appl2-xcontent IS NOT INITIAL.
          DATA(lo_bconv) = cl_abap_conv_in_ce=>create( encoding = 'UTF-8' input = ls_appl2-xcontent ).
          lo_bconv->read( IMPORTING data = lv_atxt ).
        ENDIF.
        FIND PCRE lv_pat IN lv_atxt.
        IF sy-subrc = 0.
          IF lv_count >= 20.
            lv_truncated = abap_true.
            EXIT.
          ENDIF.
          lv_count = lv_count + 1.
          DATA(lv_aid2)  = |{ ls_appl2-config_id }|.
          DATA(lv_aapp2) = |{ ls_appl2-application }|.
          DATA(lv_avar2) = |{ ls_appl2-config_var }|.
          IF lv_apps_json IS NOT INITIAL.
            lv_apps_json = lv_apps_json && |,|.
          ENDIF.
          lv_apps_json = lv_apps_json &&
            |\\{"config_id":"{ zcl_zmcp_fluid_rt=>esc( lv_aid2 ) }",| &&
            |"application":"{ zcl_zmcp_fluid_rt=>esc( lv_aapp2 ) }",| &&
            |"config_var":"{ zcl_zmcp_fluid_rt=>esc( lv_avar2 ) }"\\}|.
        ENDIF.
      ENDLOOP.
    ENDIF.

    DATA(lv_eapp_s)  = COND string( WHEN lv_exists_as_app = abap_true THEN 'true' ELSE 'false' ).
    DATA(lv_ecomp_s) = COND string( WHEN lv_exists_as_component = abap_true THEN 'true' ELSE 'false' ).
    DATA(lv_trunc_s) = COND string( WHEN lv_truncated = abap_true THEN 'true' ELSE 'false' ).

    zcl_zmcp_fluid_rt=>out(
      |\\{"config_id":"{ zcl_zmcp_fluid_rt=>esc( lv_config_id ) }",| &&
      |"exists_as_app":{ lv_eapp_s },| &&
      |"exists_as_component":{ lv_ecomp_s },| &&
      |"component":"{ zcl_zmcp_fluid_rt=>esc( lv_comp ) }",| &&
      |"component_config_var":"{ zcl_zmcp_fluid_rt=>esc( lv_comp_var ) }",| &&
      |"application_configs":[{ lv_apps_json }],| &&
      |"truncated":{ lv_trunc_s }\\}| ).
  ENDMETHOD.

  METHOD read_config.
    " Shared by outline() and events(): reads one WDY_CONFIG_DATA/APPL row's
    " XML body plus its component/devclass metadata. Never calls err() -
    " on failure it sets ev_error and returns, so a caller can decide for
    " itself whether a miss is fatal (outline: yes) or per-item (events:
    " a "child" config frame with "read_error", the walk carries on).
    CLEAR: ev_xml, ev_component, ev_devclass,
           ev_config_idpar, ev_config_typepar, ev_config_varpar, ev_error.

    DATA lv_key40 TYPE c LENGTH 40.
    CLEAR lv_key40.
    lv_key40(32)   = iv_config_id.
    lv_key40+32(2) = iv_config_type.
    lv_key40+34(6) = iv_config_var.

    IF iv_config_type = '02'.
      DATA lv_xc TYPE xstring.
      CLEAR lv_xc.
      SELECT SINGLE xcontent FROM wdy_config_appl
        WHERE config_id = @iv_config_id AND config_type = '02' AND config_var = @iv_config_var
        INTO @lv_xc.
      IF sy-subrc <> 0.
        ev_error = |wdy_config_appl: no matching row for config { iv_config_id } type { iv_config_type } var { iv_config_var }|.
      ELSE.
        IF lv_xc IS NOT INITIAL.
          DATA(lo_conv) = cl_abap_conv_in_ce=>create( encoding = 'UTF-8' input = lv_xc ).
          lo_conv->read( IMPORTING data = ev_xml ).
        ENDIF.
        ev_config_idpar = 'N/A - application config, delta tracking not implemented'.
        SELECT SINGLE devclass FROM tadir
          WHERE pgmid = 'R3TR' AND object = 'WDCA' AND obj_name = @lv_key40
          INTO @ev_devclass.
      ENDIF.
    ELSE.
      DATA ls_key TYPE wdy_config_key.
      CLEAR ls_key.
      ls_key-config_id   = iv_config_id.
      ls_key-config_type = iv_config_type.
      ls_key-config_var  = iv_config_var.
      DATA lv_xc2 TYPE xstring.
      CLEAR lv_xc2.
      DATA(ls_ocd) = VALUE wdy_config_data( ).
      DATA(lv_rc_err) = ||.
      TRY.
          cl_wdr_cfg_persistence_utils=>read_comp_config_from_db(
            EXPORTING config_key           = ls_key
            IMPORTING xml_xcontent         = lv_xc2
                      original_config_data = ls_ocd ).
        CATCH cx_root INTO DATA(lx1).
          lv_rc_err = lx1->get_text( ).
      ENDTRY.
      IF lv_rc_err IS NOT INITIAL.
        ev_error = |wdy_config_data: { lv_rc_err } (config { iv_config_id } type { iv_config_type } var { iv_config_var })|.
      ELSE.
        IF lv_xc2 IS NOT INITIAL.
          DATA(lo_conv2) = cl_abap_conv_in_ce=>create( encoding = 'UTF-8' input = lv_xc2 ).
          lo_conv2->read( IMPORTING data = ev_xml ).
        ENDIF.
        ev_config_idpar   = ls_ocd-config_idpar.
        ev_config_typepar = ls_ocd-config_typepar.
        ev_config_varpar  = ls_ocd-config_varpar.
        ev_component      = ls_ocd-component.
        SELECT SINGLE devclass FROM tadir
          WHERE pgmid = 'R3TR' AND object = 'WDCC' AND obj_name = @lv_key40
          INTO @ev_devclass.
      ENDIF.
    ENDIF.
  ENDMETHOD.

  METHOD parse_doc.
    " Generic IF_IXML parse of one config's XML text, used only to walk the
    " document for referenced configs / BO names - never to re-derive
    " anything read_config already returned as a DB field. Any parse
    " failure (malformed/empty XML) is silent: ro_root stays unbound and
    " callers simply find no references, they never see err().
    CLEAR ro_root.
    IF iv_xml IS INITIAL.
      RETURN.
    ENDIF.
    TRY.
        DATA(lo_ixml)   = cl_ixml=>create( ).
        DATA(lo_sf)     = lo_ixml->create_stream_factory( ).
        DATA(lo_is)     = lo_sf->create_istream_string( string = iv_xml ).
        DATA(lo_doc)    = lo_ixml->create_document( ).
        DATA(lo_parser) = lo_ixml->create_parser(
          stream_factory = lo_sf
          istream        = lo_is
          document       = lo_doc ).
        DATA(lv_rc) = lo_parser->parse( ).
        lo_is->close( ).
        IF lv_rc = 0.
          ro_root = lo_doc->get_root_element( ).
        ENDIF.
      CATCH cx_root.
        CLEAR ro_root.
    ENDTRY.
  ENDMETHOD.

  METHOD child_text.
    " First direct-child element named iv_name; blank when absent. Never
    " descends into grandchildren - config XML Items are sparse (a missing
    " leaf just means "blank"), so "not found" and "found but empty" are
    " the same answer here on purpose.
    rv_text = ||.
    IF io_parent IS BOUND.
      DATA(lv_found) = abap_false.
      DATA(lo_child) = io_parent->get_first_child( ).
      WHILE lo_child IS BOUND AND lv_found = abap_false.
        IF lo_child->get_type( ) = if_ixml_node=>co_node_element.
          DATA(lo_el) = CAST if_ixml_element( lo_child ).
          IF lo_el->get_name( ) = iv_name.
            rv_text = lo_el->get_value( ).
            lv_found = abap_true.
          ENDIF.
        ENDIF.
        IF lv_found = abap_false.
          lo_child = lo_child->get_next( ).
        ENDIF.
      ENDWHILE.
    ENDIF.
  ENDMETHOD.

  METHOD norm_id.
    " Case-insensitive, trailing-blank-insensitive compare key for
    " config_id/config_type/config_var values pulled out of DDIC C fields
    " (which arrive space-padded) versus caller-supplied strings (which
    " don't).
    rv = to_upper( iv ).
    DATA(lv_len) = strlen( rv ).
    WHILE lv_len > 0 AND substring( val = rv off = lv_len - 1 len = 1 ) = \` \`.
      lv_len = lv_len - 1.
    ENDWHILE.
    rv = substring( val = rv len = lv_len ).
  ENDMETHOD.

  METHOD walk_refs.
    " Generic recursive walk collecting every Item with a non-blank direct
    " CONFIG_ID child, anywhere in the tree - the shape (UIBB, WIRE, ACTION,
    " APP_SPECIFIC_CC, ...) is only known by which Node the Item sits
    " under, so ref_node is threaded through as "the Name of the nearest
    " Node ancestor", updated only when a Node element is entered.
    IF io_node IS BOUND.
      DATA(lo_child) = io_node->get_first_child( ).
      WHILE lo_child IS BOUND.
        IF lo_child->get_type( ) = if_ixml_node=>co_node_element.
          DATA(lo_el) = CAST if_ixml_element( lo_child ).
          DATA(lv_name) = lo_el->get_name( ).
          IF lv_name = 'Node'.
            DATA(lv_node_name) = lo_el->get_attribute( name = 'Name' ).
            walk_refs( EXPORTING io_node = lo_el iv_ref_node = lv_node_name CHANGING ct_refs = ct_refs ).
          ELSEIF lv_name = 'Item'.
            DATA(lv_cfg_id) = child_text( io_parent = lo_el iv_name = 'CONFIG_ID' ).
            IF lv_cfg_id IS NOT INITIAL.
              APPEND VALUE ty_ref(
                component   = child_text( io_parent = lo_el iv_name = 'COMPONENT' )
                config_id   = lv_cfg_id
                config_type = child_text( io_parent = lo_el iv_name = 'CONFIG_TYPE' )
                config_var  = child_text( io_parent = lo_el iv_name = 'CONFIG_VAR' )
                ref_node    = iv_ref_node ) TO ct_refs.
            ENDIF.
            walk_refs( EXPORTING io_node = lo_el iv_ref_node = iv_ref_node CHANGING ct_refs = ct_refs ).
          ELSE.
            walk_refs( EXPORTING io_node = lo_el iv_ref_node = iv_ref_node CHANGING ct_refs = ct_refs ).
          ENDIF.
        ENDIF.
        lo_child = lo_child->get_next( ).
      ENDWHILE.
    ENDIF.
  ENDMETHOD.

  METHOD walk_bo.
    " Generic recursive walk collecting distinct BOPF BO names, two shapes:
    " an element literally named BO with non-blank text (FBI VIEW HEADER),
    " or an Item with direct children NAME=BO / VALUE=<bo> (GUIBB
    " PARAMETER). Dedup keeps the SELECTs below to one round trip per BO.
    IF io_node IS BOUND.
      DATA(lo_child) = io_node->get_first_child( ).
      WHILE lo_child IS BOUND.
        IF lo_child->get_type( ) = if_ixml_node=>co_node_element.
          DATA(lo_el) = CAST if_ixml_element( lo_child ).
          DATA(lv_name) = lo_el->get_name( ).
          IF lv_name = 'BO'.
            DATA(lv_bo_val) = lo_el->get_value( ).
            IF lv_bo_val IS NOT INITIAL.
              READ TABLE ct_bo TRANSPORTING NO FIELDS WITH KEY table_line = lv_bo_val.
              IF sy-subrc <> 0.
                APPEND lv_bo_val TO ct_bo.
              ENDIF.
            ENDIF.
          ENDIF.
          IF lv_name = 'Item'.
            DATA(lv_pname) = child_text( io_parent = lo_el iv_name = 'NAME' ).
            IF lv_pname = 'BO'.
              DATA(lv_pval) = child_text( io_parent = lo_el iv_name = 'VALUE' ).
              IF lv_pval IS NOT INITIAL.
                READ TABLE ct_bo TRANSPORTING NO FIELDS WITH KEY table_line = lv_pval.
                IF sy-subrc <> 0.
                  APPEND lv_pval TO ct_bo.
                ENDIF.
              ENDIF.
            ENDIF.
          ENDIF.
          walk_bo( EXPORTING io_node = lo_el CHANGING ct_bo = ct_bo ).
        ENDIF.
        lo_child = lo_child->get_next( ).
      ENDWHILE.
    ENDIF.
  ENDMETHOD.

  METHOD events.
    DATA(lv_config_id) = zcl_zmcp_fluid_rt=>s( 'config_id' ).
    DATA(lv_config_type) = zcl_zmcp_fluid_rt=>s( 'config_type' ).
    IF lv_config_type IS INITIAL.
      lv_config_type = '00'.
    ENDIF.
    DATA(lv_config_var) = zcl_zmcp_fluid_rt=>s( 'config_var' ).
    DATA(lv_uibb)     = zcl_zmcp_fluid_rt=>s( 'uibb' ).
    DATA(lv_resolve)  = zcl_zmcp_fluid_rt=>b( 'resolve' ).

    IF lv_config_id IS INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args' iv_text = 'config_id is required' ).
      RETURN.
    ENDIF.

    read_config(
      EXPORTING iv_config_id   = lv_config_id
                iv_config_type = lv_config_type
                iv_config_var  = lv_config_var
      IMPORTING ev_xml         = DATA(lv_root_xml)
                ev_component   = DATA(lv_root_component)
                ev_devclass    = DATA(lv_root_devclass)
                ev_error       = DATA(lv_root_error) ).

    IF lv_root_error IS NOT INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'read_config' iv_text = lv_root_error ).
      RETURN.
    ENDIF.

    DATA(lv_root_json) =
      |\\{"kind":"config","role":"root",| &&
      |"config_id":"{ zcl_zmcp_fluid_rt=>esc( lv_config_id ) }",| &&
      |"config_type":"{ zcl_zmcp_fluid_rt=>esc( lv_config_type ) }",| &&
      |"config_var":"{ zcl_zmcp_fluid_rt=>esc( lv_config_var ) }",| &&
      |"component":"{ zcl_zmcp_fluid_rt=>esc( lv_root_component ) }",| &&
      |"devclass":"{ zcl_zmcp_fluid_rt=>esc( lv_root_devclass ) }",| &&
      |"xml":"{ zcl_zmcp_fluid_rt=>esc( lv_root_xml ) }"\\}|.
    zcl_zmcp_fluid_rt=>out_chunk( lv_root_json ).
    zcl_zmcp_fluid_rt=>out( '' ).

    " Driver table for the WDY_CONFIG_COMPT text-id lookup below (issue #101
    " Defect 3): one (config_id, config_type, config_var) tuple per config
    " actually read, root included, so a toolbar button's numeric TEXT
    " (Transl="true") can be resolved no matter which config declared it.
    DATA(lt_text_cfg) = VALUE tt_text_cfg(
      ( config_id = lv_config_id config_type = lv_config_type config_var = lv_config_var ) ).

    DATA(lt_refs) = VALUE tt_ref( ).
    DATA(lo_root_el) = parse_doc( lv_root_xml ).
    IF lo_root_el IS BOUND.
      walk_refs( EXPORTING io_node = lo_root_el iv_ref_node = '' CHANGING ct_refs = lt_refs ).
    ENDIF.

    " A reference's CONFIG_TYPE child is often just absent (component-scope
    " is the default everywhere), so default it the same way the root's own
    " config_type is defaulted, before it's used as a compare/dedup key -
    " otherwise a blank-vs-"00" mismatch would stop the root-exclusion
    " check below from recognizing a reference back at the root.
    LOOP AT lt_refs ASSIGNING FIELD-SYMBOL(<ls_ref_norm>).
      IF <ls_ref_norm>-config_type IS INITIAL.
        <ls_ref_norm>-config_type = '00'.
      ENDIF.
    ENDLOOP.

    " Dedup on config_id+config_type+config_var, first-seen order; drop any
    " tuple that is really just the root's own key (a WIRE or ACTION can
    " legitimately point back at the config that declares it).
    DATA(lt_dedup) = VALUE tt_ref( ).
    LOOP AT lt_refs INTO DATA(ls_ref).
      IF norm_id( ls_ref-config_id ) = norm_id( lv_config_id )
          AND norm_id( ls_ref-config_type ) = norm_id( lv_config_type )
          AND norm_id( ls_ref-config_var ) = norm_id( lv_config_var ).
        CONTINUE.
      ENDIF.
      READ TABLE lt_dedup TRANSPORTING NO FIELDS
        WITH KEY config_id = ls_ref-config_id config_type = ls_ref-config_type config_var = ls_ref-config_var.
      IF sy-subrc = 0.
        CONTINUE.
      ENDIF.
      APPEND ls_ref TO lt_dedup.
    ENDLOOP.

    DATA(lt_bo) = VALUE string_table( ).
    IF lo_root_el IS BOUND.
      walk_bo( EXPORTING io_node = lo_root_el CHANGING ct_bo = lt_bo ).
    ENDIF.

    DATA(lv_configs_read)    = 0.
    DATA(lv_configs_failed)  = 0.
    DATA(lv_configs_skipped) = 0.
    DATA(lv_trunc)           = ||.
    DATA(lv_count)           = 0.

    LOOP AT lt_dedup INTO DATA(ls_child).
      lv_count = lv_count + 1.
      IF lv_count > 40.
        lv_trunc = 'configs'.
        EXIT.
      ENDIF.

      DATA(lv_child_type) = ls_child-config_type.
      IF lv_child_type IS INITIAL.
        lv_child_type = '00'.
      ENDIF.

      IF lv_uibb IS NOT INITIAL AND norm_id( ls_child-config_id ) <> norm_id( lv_uibb ).
        lv_configs_skipped = lv_configs_skipped + 1.
        zcl_zmcp_fluid_rt=>out(
          |\\{"kind":"config","role":"child",| &&
          |"ref_node":"{ zcl_zmcp_fluid_rt=>esc( ls_child-ref_node ) }",| &&
          |"config_id":"{ zcl_zmcp_fluid_rt=>esc( ls_child-config_id ) }",| &&
          |"config_type":"{ zcl_zmcp_fluid_rt=>esc( lv_child_type ) }",| &&
          |"config_var":"{ zcl_zmcp_fluid_rt=>esc( ls_child-config_var ) }",| &&
          |"component":"{ zcl_zmcp_fluid_rt=>esc( ls_child-component ) }",| &&
          |"skipped":"uibb-filter"\\}| ).
        CONTINUE.
      ENDIF.

      read_config(
        EXPORTING iv_config_id   = ls_child-config_id
                  iv_config_type = lv_child_type
                  iv_config_var  = ls_child-config_var
        IMPORTING ev_xml         = DATA(lv_child_xml)
                  ev_component   = DATA(lv_child_component)
                  ev_devclass    = DATA(lv_child_devclass)
                  ev_error       = DATA(lv_child_error) ).

      IF lv_child_error IS NOT INITIAL.
        lv_configs_failed = lv_configs_failed + 1.
        zcl_zmcp_fluid_rt=>out(
          |\\{"kind":"config","role":"child",| &&
          |"ref_node":"{ zcl_zmcp_fluid_rt=>esc( ls_child-ref_node ) }",| &&
          |"config_id":"{ zcl_zmcp_fluid_rt=>esc( ls_child-config_id ) }",| &&
          |"config_type":"{ zcl_zmcp_fluid_rt=>esc( lv_child_type ) }",| &&
          |"config_var":"{ zcl_zmcp_fluid_rt=>esc( ls_child-config_var ) }",| &&
          |"component":"{ zcl_zmcp_fluid_rt=>esc( ls_child-component ) }",| &&
          |"read_error":"{ zcl_zmcp_fluid_rt=>esc( lv_child_error ) }"\\}| ).
        CONTINUE.
      ENDIF.

      lv_configs_read = lv_configs_read + 1.
      APPEND VALUE ty_text_cfg( config_id = ls_child-config_id config_type = lv_child_type
                                config_var = ls_child-config_var ) TO lt_text_cfg.
      DATA(lv_child_json) =
        |\\{"kind":"config","role":"child",| &&
        |"ref_node":"{ zcl_zmcp_fluid_rt=>esc( ls_child-ref_node ) }",| &&
        |"config_id":"{ zcl_zmcp_fluid_rt=>esc( ls_child-config_id ) }",| &&
        |"config_type":"{ zcl_zmcp_fluid_rt=>esc( lv_child_type ) }",| &&
        |"config_var":"{ zcl_zmcp_fluid_rt=>esc( ls_child-config_var ) }",| &&
        |"component":"{ zcl_zmcp_fluid_rt=>esc( lv_child_component ) }",| &&
        |"devclass":"{ zcl_zmcp_fluid_rt=>esc( lv_child_devclass ) }",| &&
        |"xml":"{ zcl_zmcp_fluid_rt=>esc( lv_child_xml ) }"\\}|.
      zcl_zmcp_fluid_rt=>out_chunk( lv_child_json ).
      zcl_zmcp_fluid_rt=>out( '' ).

      DATA(lo_child_el) = parse_doc( lv_child_xml ).
      IF lo_child_el IS BOUND.
        walk_bo( EXPORTING io_node = lo_child_el CHANGING ct_bo = lt_bo ).
      ENDIF.
    ENDLOOP.

    " Issue #101 Defect 3: a toolbar/button-row TEXT marked Transl="true" is
    " a WDY_CONFIG_COMPT text_id, not a label - resolve every text_id that
    " belongs to any config actually read above in one shot. Unconditional
    " (not gated by resolve=true): unlike the BOPF/fpm_event catalogues this
    " is a targeted, bounded read (one row per config already in hand), not
    " an extra whole-system fetch.
    DATA(lv_text_ids) = 0.
    IF lt_text_cfg IS NOT INITIAL.
      TRY.
          SELECT config_id, config_type, config_var, langu, text_id, description
            FROM wdy_config_compt
            FOR ALL ENTRIES IN @lt_text_cfg
            WHERE config_id = @lt_text_cfg-config_id
              AND config_type = @lt_text_cfg-config_type
              AND config_var = @lt_text_cfg-config_var
            INTO TABLE @DATA(lt_texts).
          LOOP AT lt_texts INTO DATA(ls_text).
            lv_text_ids = lv_text_ids + 1.
            zcl_zmcp_fluid_rt=>out(
              |\\{"kind":"text_id",| &&
              |"config_id":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_text-config_id ) ) }",| &&
              |"config_type":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_text-config_type ) ) }",| &&
              |"config_var":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_text-config_var ) ) }",| &&
              |"langu":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_text-langu ) ) }",| &&
              |"text_id":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_text-text_id ) ) }",| &&
              |"description":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_text-description ) ) }"\\}| ).
          ENDLOOP.
        CATCH cx_root INTO DATA(lx_text).
          zcl_zmcp_fluid_rt=>out(
            |\\{"kind":"text_id_error","text":"{ zcl_zmcp_fluid_rt=>esc( lx_text->get_text( ) ) }"\\}| ).
      ENDTRY.
    ENDIF.

    DATA(lv_bopf_nodes)   = 0.
    DATA(lv_bopf_actions) = 0.
    DATA(lv_fpm_events)   = 0.

    IF lv_resolve = abap_true.
      TRY.
          " CL_FPM_EVENT's GC_EVENT_* constants are read straight from the class's
          " own DDIC component definition rather than resolved dynamically: ATTVALUE
          " holds the constant's literal source text (quotes and all), e.g.
          " 'FPM_ADAPT_CONTEXT', so the surrounding quotes and any doubled ''
          " escapes are stripped in ABAP before the value is used.
          SELECT cmpname, attvalue FROM seocompodf
            WHERE clsname = 'CL_FPM_EVENT'
            INTO TABLE @DATA(lt_fpm_const).
          LOOP AT lt_fpm_const INTO DATA(ls_fpm_const).
            IF NOT ls_fpm_const-cmpname CP 'GC_EVENT_*'.
              CONTINUE.
            ENDIF.
            DATA(lv_raw_val) = CONV string( ls_fpm_const-attvalue ).
            DATA lv_raw_len TYPE i.
            lv_raw_len = strlen( lv_raw_val ).
            DATA(lv_event_id) = lv_raw_val.
            IF lv_raw_len >= 2 AND substring( val = lv_raw_val len = 1 ) = \`'\`
                AND substring( val = lv_raw_val off = lv_raw_len - 1 len = 1 ) = \`'\`.
              lv_event_id = substring( val = lv_raw_val off = 1 len = lv_raw_len - 2 ).
            ENDIF.
            REPLACE ALL OCCURRENCES OF \`''\` IN lv_event_id WITH \`'\`.
            lv_fpm_events = lv_fpm_events + 1.
            zcl_zmcp_fluid_rt=>out(
              |\\{"kind":"fpm_event","name":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_fpm_const-cmpname ) ) }",| &&
              |"event_id":"{ zcl_zmcp_fluid_rt=>esc( lv_event_id ) }"\\}| ).
          ENDLOOP.
        CATCH cx_root INTO DATA(lx_fpm_ev).
          zcl_zmcp_fluid_rt=>out(
            |\\{"kind":"fpm_event_error","text":"{ zcl_zmcp_fluid_rt=>esc( lx_fpm_ev->get_text( ) ) }"\\}| ).
      ENDTRY.

      DATA(lv_bo_count) = 0.
      LOOP AT lt_bo INTO DATA(lv_bo).
        lv_bo_count = lv_bo_count + 1.
        IF lv_bo_count > 10.
          lv_trunc = COND #( WHEN lv_trunc IS INITIAL THEN 'bopf' ELSE lv_trunc ).
          EXIT.
        ENDIF.

        TRY.
            SELECT node_name, node_key, bo_key FROM /bobf/obm_node
              WHERE name = @lv_bo AND version = '00000'
              INTO TABLE @DATA(lt_nodes).
            LOOP AT lt_nodes INTO DATA(ls_node).
              lv_bopf_nodes = lv_bopf_nodes + 1.
              DATA(lv_nn) = |{ ls_node-node_name }|.
              DATA(lv_nk) = |{ ls_node-node_key }|.
              DATA(lv_bk) = |{ ls_node-bo_key }|.
              zcl_zmcp_fluid_rt=>out(
                |\\{"kind":"bopf_node","bo":"{ zcl_zmcp_fluid_rt=>esc( lv_bo ) }",| &&
                |"node_name":"{ zcl_zmcp_fluid_rt=>esc( lv_nn ) }",| &&
                |"node_key":"{ zcl_zmcp_fluid_rt=>esc( lv_nk ) }",| &&
                |"bo_key":"{ zcl_zmcp_fluid_rt=>esc( lv_bk ) }"\\}| ).
            ENDLOOP.
          CATCH cx_root INTO DATA(lx_bo1).
            zcl_zmcp_fluid_rt=>out(
              |\\{"kind":"bopf_error","bo":"{ zcl_zmcp_fluid_rt=>esc( lv_bo ) }",| &&
              |"text":"{ zcl_zmcp_fluid_rt=>esc( lx_bo1->get_text( ) ) }"\\}| ).
        ENDTRY.

        TRY.
            SELECT act_name, act_key, node_key, act_class, act_cat FROM /bobf/act_list
              WHERE name = @lv_bo AND version = '00000'
              INTO TABLE @DATA(lt_acts).
            LOOP AT lt_acts INTO DATA(ls_act).
              lv_bopf_actions = lv_bopf_actions + 1.
              DATA(lv_an)   = |{ ls_act-act_name }|.
              DATA(lv_ak)   = |{ ls_act-act_key }|.
              DATA(lv_ank)  = |{ ls_act-node_key }|.
              DATA(lv_ac)   = |{ ls_act-act_class }|.
              DATA(lv_acat) = |{ ls_act-act_cat }|.
              zcl_zmcp_fluid_rt=>out(
                |\\{"kind":"bopf_action","bo":"{ zcl_zmcp_fluid_rt=>esc( lv_bo ) }",| &&
                |"act_name":"{ zcl_zmcp_fluid_rt=>esc( lv_an ) }",| &&
                |"act_key":"{ zcl_zmcp_fluid_rt=>esc( lv_ak ) }",| &&
                |"node_key":"{ zcl_zmcp_fluid_rt=>esc( lv_ank ) }",| &&
                |"act_class":"{ zcl_zmcp_fluid_rt=>esc( lv_ac ) }",| &&
                |"act_cat":"{ zcl_zmcp_fluid_rt=>esc( lv_acat ) }"\\}| ).
            ENDLOOP.
          CATCH cx_root INTO DATA(lx_bo2).
            zcl_zmcp_fluid_rt=>out(
              |\\{"kind":"bopf_error","bo":"{ zcl_zmcp_fluid_rt=>esc( lv_bo ) }",| &&
              |"text":"{ zcl_zmcp_fluid_rt=>esc( lx_bo2->get_text( ) ) }"\\}| ).
        ENDTRY.
      ENDLOOP.
    ENDIF.

    zcl_zmcp_fluid_rt=>out(
      |\\{"kind":"summary","configs_read":{ lv_configs_read },| &&
      |"configs_failed":{ lv_configs_failed },"configs_skipped":{ lv_configs_skipped },| &&
      |"bopf_nodes":{ lv_bopf_nodes },"bopf_actions":{ lv_bopf_actions },| &&
      |"fpm_events":{ lv_fpm_events },"text_ids":{ lv_text_ids },| &&
      |"logon_langu":"{ zcl_zmcp_fluid_rt=>esc( CONV string( sy-langu ) ) }",| &&
      |"truncated":"{ zcl_zmcp_fluid_rt=>esc( lv_trunc ) }"\\}| ).
  ENDMETHOD.

ENDCLASS.
`;

export const fpmManifest: FluidManifest = {
  contract: FLUID_CONTRACT,
  id: "fpm",
  title: "FPM",
  description: "Reads FPM/FBI screen configuration data: component/app config search, config XML, app UIBB hierarchy, and event/BOPF tracing.",
  objects: [
    {
      name: FLUID_RUNTIME_CLASS,
      type: "CLAS/OC",
      description: RUNTIME_OBJECT.description,
      source: { text: RUNTIME_SOURCE },
    },
    {
      name: "ZCL_ZMCP_FLUID_FPM",
      type: "CLAS/OC",
      description: "fluid: reads FPM/FBI screen configuration data",
      source: { text: FPM_SOURCE },
    },
  ],
  entry: "ZCL_ZMCP_FLUID_FPM",
  actions: [
    {
      name: "find",
      category: "read",
      description: "Searches WDY_CONFIG_DATA (component-scope) or WDY_CONFIG_APPL (application-scope) for configs.",
      input: {
        type: "object",
        properties: {
          config_type: {
            type: "string",
            maxLength: 2,
            description: "NUMC2: '00' component-scope (default) or '02' application-scope.",
          },
          component: {
            type: "string",
            maxLength: 30,
            description: "Component-scope only; filters WDY_CONFIG_DATA-COMPONENT.",
          },
          query: {
            type: "string",
            maxLength: 40,
            description: "config_id LIKE pattern; '*' is a wildcard. Letters/digits/underscore/slash only.",
          },
          package: {
            type: "string",
            maxLength: 30,
            description: "Devclass filter, cross-referenced per row via TADIR (object WDCC/WDCA).",
          },
        },
      },
      output: {
        type: "array",
        description: "Every matching config row; abapsmith imposes no row cap here.",
        items: {
          type: "object",
          // loadable/app_config_id/component_config_id/reason are optional in the
          // schema so the TS side keeps rendering rows from a bridge without them.
          required: ["config_id", "config_type", "config_var", "component", "description", "devclass"],
          properties: {
            config_id: { type: "string", maxLength: CONFIG_ID_LEN },
            config_type: { type: "string", maxLength: 2 },
            config_var: { type: "string", maxLength: 6 },
            component: { type: "string" },
            description: { type: "string" },
            devclass: { type: "string" },
            loadable: {
              type: "boolean",
              description: "Cheap existence check only: true when mode=app is expected to be able to load this row (see app_config_id/component_config_id).",
            },
            app_config_id: {
              type: "string",
              description: "config_id to pass to mode=app; empty when nothing loadable was found for this row.",
            },
            component_config_id: {
              type: "string",
              description: "The component config (WDY_CONFIG_DATA, config_type 00) this row resolves to or is.",
            },
            reason: {
              type: "string",
              description: "Why loadable is false; empty when loadable is true.",
            },
          },
        },
      },
    },
    {
      name: "outline",
      category: "read",
      description: "Reads one config's XML plus its delta/package metadata.",
      input: {
        type: "object",
        required: ["config_id"],
        properties: {
          config_id: { type: "string", maxLength: CONFIG_ID_LEN },
          config_type: {
            type: "string",
            maxLength: 2,
            description: "NUMC2: '00' component-scope (default) or '02' application-scope.",
          },
          config_var: { type: "string", maxLength: 6 },
        },
      },
      output: {
        type: "object",
        required: ["config_id", "config_type", "config_var", "xml", "meta"],
        properties: {
          config_id: { type: "string" },
          config_type: { type: "string" },
          config_var: { type: "string" },
          xml: { type: "string", description: "Decoded UTF-8 config XML; empty when the config has none." },
          meta: {
            type: "object",
            required: ["config_idpar", "config_typepar", "config_varpar", "component", "devclass"],
            properties: {
              config_idpar: { type: "string" },
              config_typepar: { type: "string" },
              config_varpar: { type: "string" },
              component: { type: "string" },
              devclass: { type: "string" },
            },
          },
        },
      },
    },
    {
      name: "app",
      category: "read",
      description: "Walks an application config's UIBB node hierarchy via CL_FPM_CFG_HRCHY_BRWSR_ASSIST.",
      input: {
        type: "object",
        required: ["config_id"],
        properties: {
          config_id: { type: "string", maxLength: CONFIG_ID_LEN },
          resolve: {
            type: "boolean",
            description: "Also read each configurable node's own config XML for FEEDER/BOPF hints.",
          },
        },
      },
      output: {
        type: "array",
        description: "One entry per node in the hierarchy.",
        items: {
          type: "object",
          required: [
            "node_path",
            "parent_path",
            "is_top_node",
            "node_name",
            "description",
            "component_name",
            "interface_view",
            "config_id",
            "config_type",
            "config_var",
            "target_config_id",
            "is_configurable",
            "is_customized",
            "is_enhanced",
            "is_freestyle_uibb",
            "is_leaf",
          ],
          properties: {
            node_path: { type: "string" },
            parent_path: { type: "string" },
            is_top_node: { type: "boolean" },
            node_name: { type: "string" },
            description: { type: "string" },
            component_name: { type: "string" },
            interface_view: { type: "string" },
            config_id: { type: "string" },
            config_type: { type: "string" },
            config_var: { type: "string" },
            target_config_id: { type: "string" },
            is_configurable: { type: "boolean" },
            is_customized: { type: "boolean" },
            is_enhanced: { type: "boolean" },
            is_freestyle_uibb: { type: "boolean" },
            is_leaf: { type: "boolean" },
            resolved: {
              type: "object",
              description: "Present only when resolve=true and this node was successfully re-read.",
              properties: {
                xml_len: { type: "integer" },
                feeder_hint: { type: "boolean" },
                bopf_hint: { type: "boolean" },
                excerpt: { type: "string", maxLength: 300 },
              },
            },
            resolve_error: {
              type: "string",
              description: "Present only when resolve=true and this node's re-read raised an exception.",
            },
          },
        },
      },
    },
    {
      name: "resolve",
      category: "read",
      description:
        "Given one config_id, reports whether it exists as an application config (WDY_CONFIG_APPL) and/or a component config (WDY_CONFIG_DATA), and which application config(s) reference it as a component config.",
      input: {
        type: "object",
        required: ["config_id"],
        properties: {
          config_id: { type: "string", maxLength: CONFIG_ID_LEN },
        },
      },
      output: {
        type: "object",
        required: [
          "config_id",
          "exists_as_app",
          "exists_as_component",
          "component",
          "component_config_var",
          "application_configs",
          "truncated",
        ],
        properties: {
          config_id: { type: "string" },
          exists_as_app: { type: "boolean" },
          exists_as_component: { type: "boolean" },
          component: { type: "string" },
          component_config_var: { type: "string" },
          application_configs: {
            type: "array",
            description: "Application configs (config_type 02) whose XCONTENT references this config_id as a component config; only populated when exists_as_component is true.",
            items: {
              type: "object",
              required: ["config_id", "application", "config_var"],
              properties: {
                config_id: { type: "string" },
                application: { type: "string" },
                config_var: { type: "string" },
              },
            },
          },
          truncated: {
            type: "boolean",
            description: "true when more than 20 referencing application configs exist and the list was capped.",
          },
        },
      },
    },
    {
      name: "events",
      category: "read",
      description:
        "Traces FPM/FBI event wiring for a config: reads its XML plus every config it references (toolbars, wires, sub-views), and optionally the standard FPM event catalogue and any referenced BOPF BO's node/action catalogue.",
      input: {
        type: "object",
        required: ["config_id"],
        properties: {
          config_id: { type: "string", maxLength: CONFIG_ID_LEN },
          config_type: {
            type: "string",
            maxLength: 2,
            description: "NUMC2: '00' component-scope (default) or '02' application-scope.",
          },
          config_var: { type: "string", maxLength: 6 },
          uibb: {
            type: "string",
            description: "Restrict referenced-config reads to this config_id (case-insensitive); others are reported as skipped, not read.",
          },
          resolve: {
            type: "boolean",
            description: "Also emit the standard CL_FPM_EVENT catalogue and, for every BOPF BO name found in the read configs, its /BOBF/OBM_NODE and /BOBF/ACT_LIST rows.",
          },
        },
      },
      output: {
        type: "array",
        description:
          'One kind="config" row for the root and each referenced config read or skipped, then kind="text_id"/"text_id_error" rows (WDY_CONFIG_COMPT lookup for every config read, unconditional), then (if resolve=true) kind="fpm_event"/"fpm_event_error" and kind="bopf_node"/"bopf_action"/"bopf_error" rows, then exactly one final kind="summary" row.',
        items: {
          type: "object",
          required: ["kind"],
          properties: {
            kind: {
              type: "string",
              enum: [
                "config",
                "text_id",
                "text_id_error",
                "fpm_event",
                "fpm_event_error",
                "bopf_node",
                "bopf_action",
                "bopf_error",
                "summary",
              ],
            },
            role: { type: "string", description: 'config rows only: "root" or "child".' },
            ref_node: { type: "string", description: "child config rows only: the Name of the Node the referencing Item sat under." },
            config_id: { type: "string" },
            config_type: { type: "string" },
            config_var: { type: "string" },
            component: { type: "string" },
            devclass: { type: "string" },
            xml: { type: "string", description: "Decoded UTF-8 config XML; present on successfully read config rows." },
            skipped: { type: "string", description: 'child config rows only: "uibb-filter" when excluded by the uibb input.' },
            read_error: { type: "string", description: "child config rows only: set instead of xml when the re-read failed." },
            langu: { type: "string", description: "text_id rows only: WDY_CONFIG_COMPT-LANGU, SAP's 1-char legacy language code (e.g. E, D), not ISO." },
            text_id: { type: "string", description: 'text_id rows only: WDY_CONFIG_COMPT-TEXT_ID, the same numeric key a Transl="true" TEXT element holds.' },
            description: { type: "string", description: "text_id rows only: WDY_CONFIG_COMPT-DESCRIPTION, the resolved label for text_id/langu." },
            name: { type: "string", description: "fpm_event rows only: the CL_FPM_EVENT constant name, e.g. GC_EVENT_OPEN_POPUP." },
            event_id: { type: "string", description: "fpm_event rows only: the constant's string value." },
            bo: { type: "string", description: "bopf_node/bopf_action/bopf_error rows: the BOPF BO name." },
            node_name: { type: "string" },
            node_key: { type: "string" },
            bo_key: { type: "string" },
            act_name: { type: "string" },
            act_key: { type: "string" },
            act_class: { type: "string" },
            act_cat: { type: "string" },
            text: { type: "string", description: "fpm_event_error/bopf_error/text_id_error rows only: the caught exception's text." },
            configs_read: { type: "integer" },
            configs_failed: { type: "integer" },
            configs_skipped: { type: "integer" },
            bopf_nodes: { type: "integer" },
            bopf_actions: { type: "integer" },
            fpm_events: { type: "integer" },
            text_ids: { type: "integer", description: "summary row only: count of text_id rows emitted." },
            logon_langu: { type: "string", description: "summary row only: SY-LANGU, the calling user's logon language (1-char legacy code) used to pick text_id rows." },
            truncated: { type: "string", description: 'summary row only: "" | "configs" | "bopf".' },
          },
        },
      },
    },
  ],
};

export const fpmSources: ReadonlyMap<string, string> = new Map([
  [FLUID_RUNTIME_CLASS, RUNTIME_SOURCE],
  ["ZCL_ZMCP_FLUID_FPM", FPM_SOURCE],
]);
