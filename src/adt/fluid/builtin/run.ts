/**
 * Built-in "run" fluid tool: submits a classic ABAP report and streams its
 * captured list output back one line per `OUT` frame. The ABAP driver is
 * adapted from `bridgeClassSource` in `src/adt/run.ts` (SUBMIT ... EXPORTING
 * LIST TO MEMORY, then LIST_FROM_MEMORY / LIST_TO_ASCI), reshaped to the
 * fluid body-class contract (`run( iv_action, iv_json )` against
 * `ZCL_ZMCP_FLUID_RT`) instead of `IF_OO_ADT_CLASSRUN`.
 */
import type { FluidManifest } from "../manifest.js";
import { FLUID_CONTRACT } from "../manifest.js";

const RUN_SOURCE = `CLASS zcl_zmcp_fluid_run DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    CLASS-METHODS run
      IMPORTING
        iv_action TYPE string
        iv_json   TYPE string.

  PRIVATE SECTION.
    CLASS-METHODS get_json_string
      IMPORTING
        iv_json         TYPE string
        iv_name         TYPE string
      RETURNING
        VALUE(rv_value) TYPE string.

ENDCLASS.


CLASS zcl_zmcp_fluid_run IMPLEMENTATION.

  METHOD run.
    zcl_zmcp_fluid_rt=>begin( iv_id = 'run' iv_action = iv_action ).

    IF iv_action <> 'report'.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'dispatch'
        iv_text = |unknown action "{ iv_action }"| ).
      zcl_zmcp_fluid_rt=>end( 1 ).
      RETURN.
    ENDIF.

    DATA(lv_report)  = get_json_string( iv_json = iv_json iv_name = 'report' ).
    DATA(lv_variant) = get_json_string( iv_json = iv_json iv_name = 'variant' ).

    IF lv_report IS INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
        iv_text = 'report is required' ).
      zcl_zmcp_fluid_rt=>end( 1 ).
      RETURN.
    ENDIF.

    TYPES ty_txt_line TYPE c LENGTH 1023.
    DATA: lt_list TYPE TABLE OF abaplist,
          lt_txt  TYPE TABLE OF ty_txt_line,
          lv_step TYPE string VALUE 'submit'.

    TRY.
        IF lv_variant IS NOT INITIAL.
          SUBMIT (lv_report) USING SELECTION-SET lv_variant AND RETURN EXPORTING LIST TO MEMORY.
        ELSE.
          SUBMIT (lv_report) AND RETURN EXPORTING LIST TO MEMORY.
        ENDIF.

        IF sy-subrc <> 0.
          " Not fatal: a report ending via MESSAGE/LEAVE can set sy-subrc <> 0
          " while still leaving a good list in memory (bridgeClassSource, src/adt/run.ts).
          zcl_zmcp_fluid_rt=>err( iv_kind = 'subrc' iv_step = lv_step
            iv_text = |SUBMIT { lv_report } set sy-subrc = { sy-subrc }| ).
        ENDIF.

        lv_step = 'capture'.

        CALL FUNCTION 'LIST_FROM_MEMORY'
          TABLES
            listobject = lt_list
          EXCEPTIONS
            not_found  = 1
            OTHERS     = 2.
        IF sy-subrc <> 0.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'subrc' iv_step = lv_step
            iv_text = |LIST_FROM_MEMORY sy-subrc = { sy-subrc }| ).
          zcl_zmcp_fluid_rt=>end( 1 ).
          RETURN.
        ENDIF.

        CALL FUNCTION 'LIST_TO_ASCI'
          EXPORTING
            list_index = -1
          TABLES
            listobject = lt_list
            listasci   = lt_txt
          EXCEPTIONS
            empty_list         = 1
            list_index_invalid = 2
            OTHERS             = 3.
        IF sy-subrc <> 0.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'subrc' iv_step = lv_step
            iv_text = |LIST_TO_ASCI sy-subrc = { sy-subrc }| ).
          zcl_zmcp_fluid_rt=>end( 1 ).
          RETURN.
        ENDIF.

      CATCH cx_root INTO DATA(lx_run).
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = lv_step iv_text = lx_run->get_text( ) ).
        zcl_zmcp_fluid_rt=>end( 1 ).
        RETURN.
    ENDTRY.

    LOOP AT lt_txt INTO DATA(lv_line).
      zcl_zmcp_fluid_rt=>out( |{ lv_line }| ).
    ENDLOOP.

    zcl_zmcp_fluid_rt=>end( 0 ).
  ENDMETHOD.

  METHOD get_json_string.
    " Stopgap for a top-level JSON string scalar until the runtime class
    " exposes JSON helpers; does not handle nested objects or arrays.
    DATA(lv_pattern) = |"| && iv_name && |":"([^"]*)"|.
    FIND REGEX lv_pattern IN iv_json SUBMATCHES rv_value.
    IF sy-subrc <> 0.
      CLEAR rv_value.
    ENDIF.
  ENDMETHOD.

ENDCLASS.
`;

export const runManifest: FluidManifest = {
  contract: FLUID_CONTRACT,
  id: "run",
  title: "Run",
  description: "Runs a classic ABAP report and captures its list output.",
  objects: [
    {
      name: "ZCL_ZMCP_FLUID_RUN",
      type: "CLAS/OC",
      description: "fluid: runs a classic ABAP report, captures its list",
      source: { text: RUN_SOURCE },
    },
  ],
  entry: "ZCL_ZMCP_FLUID_RUN",
  actions: [
    {
      name: "report",
      category: "execute",
      description:
        "Runs a classic ABAP report (optionally with a selection variant) and returns its " +
        "captured list output, one line per element.",
      input: {
        type: "object",
        required: ["report"],
        properties: {
          report: { type: "string", maxLength: 30, description: "The PROG name to SUBMIT." },
          variant: { type: "string", maxLength: 14, description: "An existing selection-screen variant name." },
        },
      },
      output: {
        type: "array",
        items: { type: "string" },
        description: "One captured list line per element.",
      },
    },
  ],
};

export const runSources: ReadonlyMap<string, string> = new Map([["ZCL_ZMCP_FLUID_RUN", RUN_SOURCE]]);
