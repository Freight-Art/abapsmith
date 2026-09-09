/**
 * Built-in "ui" fluid tool: the READ half of `src/adt/ui-runtime.ts`'s screen
 * inspection (its `screen` mode), reshaped to the fluid body-class contract
 * (`run( iv_action, iv_json )` against `ZCL_ZMCP_FLUID_RT`) instead of the
 * legacy per-call generated bridge class. Input args are read out of
 * `iv_json` via `ZCL_ZMCP_FLUID_RT`'s `scan()`/`s()`; the body then looks up
 * TSTC for a tcode target and calls `RPY_DYNPRO_READ` for the dynpro's
 * fields and flow logic.
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

ENDCLASS.


CLASS zcl_zmcp_fluid_ui IMPLEMENTATION.

  METHOD run.
    zcl_zmcp_fluid_rt=>begin( iv_id = 'ui' iv_action = iv_action ).

    IF iv_action <> 'screen'.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'dispatch'
        iv_text = |unknown action "{ iv_action }"| ).
      zcl_zmcp_fluid_rt=>end( 1 ).
      RETURN.
    ENDIF.

    zcl_zmcp_fluid_rt=>scan( iv_json ).
    DATA(lv_tcode)   = zcl_zmcp_fluid_rt=>s( 'tcode' ).
    DATA(lv_prog_in) = zcl_zmcp_fluid_rt=>s( 'program' ).
    DATA(lv_dyn_in)  = zcl_zmcp_fluid_rt=>s( 'dynpro' ).

    DATA lv_step       TYPE string VALUE 'args'.
    DATA lv_program    TYPE syrepid.
    DATA lv_dynpro     TYPE sydynnr.
    DATA lv_have_tcode TYPE abap_bool.
    DATA lv_cinfo_raw  TYPE tstc-cinfo.
    DATA lv_cinfo      TYPE string.
    DATA lv_kind       TYPE string.
    CLEAR: lv_program, lv_dynpro, lv_have_tcode, lv_cinfo_raw, lv_cinfo, lv_kind.

    TRY.
        IF lv_tcode IS NOT INITIAL.
          lv_step = 'tstc'.
          SELECT SINGLE pgmna, dypno, cinfo FROM tstc
            WHERE tcode = @lv_tcode
            INTO (@lv_program, @lv_dynpro, @lv_cinfo_raw).
          IF sy-subrc <> 0.
            zcl_zmcp_fluid_rt=>err( iv_kind = 'subrc' iv_step = lv_step
              iv_text = |TSTC lookup failed for tcode { lv_tcode }| iv_subrc = sy-subrc ).
            zcl_zmcp_fluid_rt=>end( 1 ).
            RETURN.
          ENDIF.
          lv_have_tcode = abap_true.
          lv_cinfo = |{ lv_cinfo_raw }|.
          CASE lv_cinfo_raw.
            WHEN '00'.
              lv_kind = 'dialog transaction (classic dynpro; batch input / press applies)'.
            WHEN '80'.
              lv_kind = 'report transaction (SUBMIT-driven; batch input does NOT apply)'.
            WHEN OTHERS.
              lv_kind = 'unrecognised transaction kind - mechanism not confirmed, do not assume batch input applies'.
          ENDCASE.
        ELSEIF lv_prog_in IS NOT INITIAL AND lv_dyn_in IS NOT INITIAL.
          " dynpro arrives as caller-supplied JSON at runtime rather than a
          " baked ABAP literal, so its digit shape is checked here instead of
          " being left to NUMC's own silently-truncating conversion.
          IF lv_dyn_in CO '0123456789' AND strlen( lv_dyn_in ) BETWEEN 1 AND 4.
            lv_program = lv_prog_in.
            lv_dynpro  = lv_dyn_in.
          ELSE.
            zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = lv_step
              iv_text = |dynpro "{ lv_dyn_in }" must be 1-4 digits| ).
            zcl_zmcp_fluid_rt=>end( 1 ).
            RETURN.
          ENDIF.
        ELSE.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = lv_step
            iv_text = 'either tcode, or program and dynpro, is required' ).
          zcl_zmcp_fluid_rt=>end( 1 ).
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

        lv_step = 'read'.
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
          zcl_zmcp_fluid_rt=>end( 1 ).
          RETURN.
        ENDIF.

        DATA lv_out TYPE string.
        lv_out = '{'.
        IF lv_have_tcode = abap_true.
          lv_out = lv_out && |"tcode":\{"tcode":"{ zcl_zmcp_fluid_rt=>esc( lv_tcode ) }"|.
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
        zcl_zmcp_fluid_rt=>end( 1 ).
        RETURN.
    ENDTRY.

    zcl_zmcp_fluid_rt=>end( 0 ).
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
    rv_json = |\\{{ lv_parts }}|.
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
      rv_json = |,"noCua":\{"program":"{ zcl_zmcp_fluid_rt=>esc( iv_prog_s ) }"|.
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
      rv_json = rv_json && |\{"code":"{ zcl_zmcp_fluid_rt=>esc( ls_fun-code ) }"|.
      rv_json = rv_json && |,"text":"{ zcl_zmcp_fluid_rt=>esc( ls_fun-fun_text ) }"|.
      rv_json = rv_json && |,"type":"{ zcl_zmcp_fluid_rt=>esc( ls_fun-type ) }"}|.
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
            lv_fkeys_json = lv_fkeys_json && |\{"status":"{ zcl_zmcp_fluid_rt=>esc( lv_status ) }"|.
            lv_fkeys_json = lv_fkeys_json && |,"code":"{ zcl_zmcp_fluid_rt=>esc( ls_fkey-code ) }"|.
            lv_fkeys_json = lv_fkeys_json && |,"text":"{ zcl_zmcp_fluid_rt=>esc( ls_fkey-text ) }"|.
            lv_fkeys_json = lv_fkeys_json &&
              |,"quickinfo":"{ zcl_zmcp_fluid_rt=>esc( ls_fkey-quickinfo ) }"}|.
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
      description: "fluid: reads a dynpro's field list via RPY_DYNPRO_READ",
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
  ],
};

export const uiSources: ReadonlyMap<string, string> = new Map([
  [FLUID_RUNTIME_CLASS, RUNTIME_SOURCE],
  ["ZCL_ZMCP_FLUID_UI", UI_SOURCE],
]);
