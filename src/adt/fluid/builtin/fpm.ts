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
    CLASS-METHODS find.
    CLASS-METHODS outline.
    CLASS-METHODS app.

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
        zcl_zmcp_fluid_rt=>out(
          |\\{"config_id":"{ zcl_zmcp_fluid_rt=>esc( lv_aid ) }",| &&
          |"config_type":"{ zcl_zmcp_fluid_rt=>esc( lv_atype ) }",| &&
          |"config_var":"{ zcl_zmcp_fluid_rt=>esc( lv_avar ) }","component":"",| &&
          |"description":"{ zcl_zmcp_fluid_rt=>esc( lv_desc ) }",| &&
          |"devclass":"{ zcl_zmcp_fluid_rt=>esc( lv_devclass ) }"\\}| ).
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
        zcl_zmcp_fluid_rt=>out(
          |\\{"config_id":"{ zcl_zmcp_fluid_rt=>esc( lv_did ) }",| &&
          |"config_type":"{ zcl_zmcp_fluid_rt=>esc( lv_dtype ) }",| &&
          |"config_var":"{ zcl_zmcp_fluid_rt=>esc( lv_dvar ) }",| &&
          |"component":"{ zcl_zmcp_fluid_rt=>esc( lv_dcomp ) }",| &&
          |"description":"{ zcl_zmcp_fluid_rt=>esc( lv_desc2 ) }",| &&
          |"devclass":"{ zcl_zmcp_fluid_rt=>esc( lv_devclass2 ) }"\\}| ).
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

    DATA lv_key40 TYPE c LENGTH 40.
    CLEAR lv_key40.
    lv_key40(32)   = lv_config_id.
    lv_key40+32(2) = lv_config_type.
    lv_key40+34(6) = lv_config_var.

    DATA(lv_xml)            = ||.
    DATA(lv_config_idpar)   = ||.
    DATA(lv_config_typepar) = ||.
    DATA(lv_config_varpar)  = ||.
    DATA(lv_component)      = ||.
    DATA(lv_devclass)       = ||.

    IF lv_config_type = '02'.
      DATA lv_xc TYPE xstring.
      CLEAR lv_xc.
      SELECT SINGLE xcontent FROM wdy_config_appl
        WHERE config_id = @lv_config_id AND config_type = '02' AND config_var = @lv_config_var
        INTO @lv_xc.
      IF sy-subrc <> 0.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'subrc' iv_step = 'select' iv_subrc = sy-subrc
          iv_text = 'wdy_config_appl: no matching row for the given key' ).
        RETURN.
      ENDIF.
      IF lv_xc IS NOT INITIAL.
        DATA(lo_conv) = cl_abap_conv_in_ce=>create( encoding = 'UTF-8' input = lv_xc ).
        lo_conv->read( IMPORTING data = lv_xml ).
      ENDIF.
      lv_config_idpar = 'N/A - application config, delta tracking not implemented'.
      SELECT SINGLE devclass FROM tadir
        WHERE pgmid = 'R3TR' AND object = 'WDCA' AND obj_name = @lv_key40
        INTO @lv_devclass.
    ELSE.
      DATA ls_key TYPE wdy_config_key.
      CLEAR ls_key.
      ls_key-config_id   = lv_config_id.
      ls_key-config_type = lv_config_type.
      ls_key-config_var  = lv_config_var.
      DATA lv_xc2 TYPE xstring.
      CLEAR lv_xc2.
      DATA(ls_ocd) = VALUE wdy_config_data( ).
      TRY.
          cl_wdr_cfg_persistence_utils=>read_comp_config_from_db(
            EXPORTING config_key           = ls_key
            IMPORTING xml_xcontent         = lv_xc2
                      original_config_data = ls_ocd ).
        CATCH cx_root INTO DATA(lx1).
          zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'read_comp_config_from_db'
            iv_text = lx1->get_text( ) ).
          RETURN.
      ENDTRY.
      IF lv_xc2 IS NOT INITIAL.
        DATA(lo_conv2) = cl_abap_conv_in_ce=>create( encoding = 'UTF-8' input = lv_xc2 ).
        lo_conv2->read( IMPORTING data = lv_xml ).
      ENDIF.
      lv_config_idpar   = ls_ocd-config_idpar.
      lv_config_typepar = ls_ocd-config_typepar.
      lv_config_varpar  = ls_ocd-config_varpar.
      lv_component      = ls_ocd-component.
      SELECT SINGLE devclass FROM tadir
        WHERE pgmid = 'R3TR' AND object = 'WDCC' AND obj_name = @lv_key40
        INTO @lv_devclass.
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

ENDCLASS.
`;

export const fpmManifest: FluidManifest = {
  contract: FLUID_CONTRACT,
  id: "fpm",
  title: "FPM",
  description: "Reads FPM/FBI screen configuration data: component/app config search, config XML, and app UIBB hierarchy.",
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
          required: ["config_id", "config_type", "config_var", "component", "description", "devclass"],
          properties: {
            config_id: { type: "string", maxLength: CONFIG_ID_LEN },
            config_type: { type: "string", maxLength: 2 },
            config_var: { type: "string", maxLength: 6 },
            component: { type: "string" },
            description: { type: "string" },
            devclass: { type: "string" },
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
  ],
};

export const fpmSources: ReadonlyMap<string, string> = new Map([
  [FLUID_RUNTIME_CLASS, RUNTIME_SOURCE],
  ["ZCL_ZMCP_FLUID_FPM", FPM_SOURCE],
]);
