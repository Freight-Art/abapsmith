/**
 * Built-in "ui" fluid tool: the READ half of `src/adt/ui-runtime.ts`'s screen
 * inspection (its `screen` mode), reshaped to the fluid body-class contract
 * (`run( iv_action, iv_json )` against `ZCL_ZMCP_FLUID_RT`) instead of the
 * legacy per-call generated bridge class. Input args are read out of
 * `iv_json` via `ZCL_ZMCP_FLUID_RT`'s `scan()`/`s()`, mirroring `screenBody`'s
 * TSTC lookup and `RPY_DYNPRO_READ` call.
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

    DATA lv_step    TYPE string VALUE 'args'.
    DATA lv_program TYPE syrepid.
    DATA lv_dynpro  TYPE sydynnr.
    CLEAR: lv_program, lv_dynpro.

    TRY.
        IF lv_tcode IS NOT INITIAL.
          lv_step = 'tstc'.
          SELECT SINGLE pgmna, dypno FROM tstc
            WHERE tcode = @lv_tcode
            INTO (@lv_program, @lv_dynpro).
          IF sy-subrc <> 0.
            zcl_zmcp_fluid_rt=>err( iv_kind = 'subrc' iv_step = lv_step
              iv_text = |TSTC lookup failed for tcode { lv_tcode }| iv_subrc = sy-subrc ).
            zcl_zmcp_fluid_rt=>end( 1 ).
            RETURN.
          ENDIF.
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
        lv_out = |\\{"program":"{ zcl_zmcp_fluid_rt=>esc( lv_program ) }"|.
        lv_out = lv_out && |,"dynpro":"{ zcl_zmcp_fluid_rt=>esc( lv_dynpro ) }"|.
        lv_out = lv_out && ',"fields":['.
        LOOP AT lt_fields_list INTO DATA(ls_field).
          IF sy-tabix > 1.
            lv_out = lv_out && ','.
          ENDIF.
          lv_out = lv_out && row_json( ls_field ).
        ENDLOOP.
        lv_out = lv_out && ']}'.
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
          program: { type: "string", maxLength: 40, description: "The resolved ABAP program name." },
          dynpro: { type: "string", maxLength: 4, description: "The resolved dynpro number." },
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
        },
      },
    },
  ],
};

export const uiSources: ReadonlyMap<string, string> = new Map([
  [FLUID_RUNTIME_CLASS, RUNTIME_SOURCE],
  ["ZCL_ZMCP_FLUID_UI", UI_SOURCE],
]);
