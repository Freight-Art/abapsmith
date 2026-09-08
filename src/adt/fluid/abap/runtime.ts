import { FLUID_CONTRACT, manifestVersion } from "../manifest.js";
import type { FluidManifest, LoadedFluidTool } from "../manifest.js";

export const FLUID_RUNTIME_CLASS = "ZCL_ZMCP_FLUID_RT";

const FLUID_RUNTIME_SOURCE = `CLASS zcl_zmcp_fluid_rt DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    CONSTANTS c_prefix TYPE string VALUE 'ZMCP-H>'.

    CLASS-METHODS attach
      IMPORTING io_out      TYPE REF TO if_oo_adt_classrun_out
                iv_ver      TYPE string
                iv_contract TYPE string.

    CLASS-METHODS begin
      IMPORTING iv_id     TYPE string
                iv_action TYPE string.

    CLASS-METHODS out
      IMPORTING iv_json TYPE string.

    CLASS-METHODS out_chunk
      IMPORTING iv_json TYPE string.

    CLASS-METHODS err
      IMPORTING iv_kind  TYPE string
                iv_step  TYPE string
                iv_text  TYPE string
                iv_subrc TYPE i            OPTIONAL
                iv_msgid TYPE string       OPTIONAL
                iv_msgno TYPE i            OPTIONAL
                it_msgv  TYPE string_table OPTIONAL.

    CLASS-METHODS end
      IMPORTING iv_rc        TYPE i
                iv_truncated TYPE abap_bool DEFAULT abap_false.

    CLASS-METHODS failed
      RETURNING VALUE(rv_failed) TYPE abap_bool.

    CLASS-METHODS esc
      IMPORTING iv_text        TYPE string
      RETURNING VALUE(rv_text) TYPE string.

    CLASS-METHODS run
      IMPORTING iv_action TYPE string
                iv_json   TYPE string.

  PRIVATE SECTION.
    CONSTANTS c_line_max TYPE i VALUE 800.

    CLASS-DATA go_out      TYPE REF TO if_oo_adt_classrun_out.
    CLASS-DATA gv_ver      TYPE string.
    CLASS-DATA gv_contract TYPE string.
    CLASS-DATA gv_begun    TYPE abap_bool.
    CLASS-DATA gv_ended    TYPE abap_bool.
    CLASS-DATA gv_open     TYPE abap_bool.
    CLASS-DATA gv_bytes    TYPE i.
    CLASS-DATA gv_errors   TYPE i.
    CLASS-DATA gv_t0       TYPE i.

    CLASS-METHODS emit
      IMPORTING iv_line TYPE string.

    CLASS-METHODS split
      IMPORTING iv_json  TYPE string
                iv_frame TYPE string DEFAULT 'OUTE'.

    CLASS-METHODS has_break
      IMPORTING iv_json        TYPE string
      RETURNING VALUE(rv_yes)  TYPE abap_bool.
ENDCLASS.


CLASS zcl_zmcp_fluid_rt IMPLEMENTATION.

  METHOD attach.
    go_out      = io_out.
    gv_ver      = iv_ver.
    gv_contract = iv_contract.
    " a body class may re-attach itself mid-run (the invoker already opened the
    " frame); only initialise per-run state when no frame is currently open, so
    " a re-attach can neither let a second BEGIN onto the wire nor zero out an
    " error already recorded (which would turn a failed run into a COMMIT).
    IF gv_begun = abap_false OR gv_ended = abap_true.
      gv_begun  = abap_false.
      gv_ended  = abap_false.
      gv_open   = abap_false.
      gv_bytes  = 0.
      gv_errors = 0.
      GET RUN TIME FIELD gv_t0.
    ENDIF.
  ENDMETHOD.

  METHOD emit.
    IF go_out IS BOUND.
      go_out->write( iv_line ).
    ENDIF.
  ENDMETHOD.

  METHOD esc.
    DATA lv_crlf TYPE c LENGTH 2.
    DATA lv_cr   TYPE c LENGTH 1.
    rv_text = iv_text.
    REPLACE ALL OCCURRENCES OF '\\' IN rv_text WITH '\\\\'.
    REPLACE ALL OCCURRENCES OF '"' IN rv_text WITH '\\"'.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_lf IN rv_text WITH '\\n'.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>newline IN rv_text WITH '\\n'.
    lv_crlf = cl_abap_char_utilities=>cr_lf.
    lv_cr = lv_crlf(1).
    REPLACE ALL OCCURRENCES OF lv_cr IN rv_text WITH '\\r'.
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>horizontal_tab IN rv_text WITH '\\t'.
  ENDMETHOD.

  METHOD begin.
    DATA lv_json TYPE string.
    " the invoker opens the frame before it enters its TRY, so a body class
    " that throws before its own begin( ) still yields ERR after a BEGIN.
    IF gv_begun = abap_true.
      RETURN.
    ENDIF.
    gv_begun = abap_true.
    lv_json = |\\{"id":"{ esc( iv_id ) }","ver":"{ esc( gv_ver ) }"|.
    lv_json = lv_json && |,"action":"{ esc( iv_action ) }"|.
    lv_json = lv_json && |,"contract":"{ esc( gv_contract ) }"\\}|.
    emit( |{ c_prefix }BEGIN { lv_json }| ).
  ENDMETHOD.

  METHOD has_break.
    IF iv_json CA cl_abap_char_utilities=>cr_lf.
      rv_yes = abap_true.
    ELSE.
      rv_yes = abap_false.
    ENDIF.
  ENDMETHOD.

  METHOD split.
    DATA lv_off   TYPE i.
    DATA lv_len   TYPE i.
    DATA lv_take  TYPE i.
    DATA lv_full  TYPE i.
    DATA lv_part  TYPE string.
    DATA lv_frame TYPE string.
    lv_len = strlen( iv_json ).
    lv_off = 0.
    WHILE lv_off < lv_len.
      lv_take = lv_len - lv_off.
      IF lv_take > c_line_max.
        lv_take = c_line_max.
      ENDIF.
      lv_full = lv_take.
      " a console line's trailing blanks are not reliably preserved, so never
      " end a fragment on one; the next fragment carries it instead. an
      " all-blank window has no non-blank char to back off to, so take it whole.
      WHILE lv_take > 1 AND substring( val = iv_json off = lv_off + lv_take - 1 len = 1 ) = \` \`.
        lv_take = lv_take - 1.
      ENDWHILE.
      IF lv_take = 1 AND substring( val = iv_json off = lv_off len = 1 ) = \` \`.
        lv_take = lv_full.
      ENDIF.
      IF lv_off + lv_take >= lv_len.
        lv_frame = iv_frame.
      ELSE.
        lv_frame = 'OUTC'.
      ENDIF.
      lv_part = substring( val = iv_json off = lv_off len = lv_take ).
      emit( |{ c_prefix }{ lv_frame } { lv_part }| ).
      lv_off = lv_off + lv_take.
    ENDWHILE.
  ENDMETHOD.

  METHOD out.
    DATA lv_len TYPE i.
    IF has_break( iv_json ) = abap_true.
      err( iv_kind = 'message' iv_step = 'out'
           iv_text = 'action output contains a raw CR or LF and was suppressed' ).
      RETURN.
    ENDIF.
    lv_len = strlen( iv_json ).
    gv_bytes = gv_bytes + lv_len.
    IF lv_len > c_line_max.
      split( iv_json ).
      gv_open = abap_false.
    ELSEIF gv_open = abap_true.
      emit( |{ c_prefix }OUTE { iv_json }| ).
      gv_open = abap_false.
    ELSE.
      emit( |{ c_prefix }OUT { iv_json }| ).
    ENDIF.
  ENDMETHOD.

  METHOD out_chunk.
    IF has_break( iv_json ) = abap_true.
      err( iv_kind = 'message' iv_step = 'out_chunk'
           iv_text = 'action output contains a raw CR or LF and was suppressed' ).
      RETURN.
    ENDIF.
    gv_bytes = gv_bytes + strlen( iv_json ).
    gv_open = abap_true.
    split( iv_json = iv_json iv_frame = 'OUTC' ).
  ENDMETHOD.

  METHOD err.
    DATA lv_json TYPE string.
    DATA lv_msgv TYPE string.
    DATA lv_kind TYPE string.
    gv_errors = gv_errors + 1.
    lv_kind = iv_kind.
    TRANSLATE lv_kind TO LOWER CASE.
    IF lv_kind <> 'subrc' AND lv_kind <> 'exception' AND lv_kind <> 'message'.
      lv_kind = 'exception'.
    ENDIF.
    lv_json = |\\{"kind":"{ esc( lv_kind ) }","step":"{ esc( iv_step ) }"|.
    IF iv_subrc IS SUPPLIED.
      lv_json = lv_json && |,"subrc":{ iv_subrc }|.
    ENDIF.
    IF iv_msgid IS NOT INITIAL.
      lv_json = lv_json && |,"msgid":"{ esc( iv_msgid ) }"|.
    ENDIF.
    IF iv_msgno IS SUPPLIED.
      lv_json = lv_json && |,"msgno":{ iv_msgno }|.
    ENDIF.
    LOOP AT it_msgv INTO DATA(lv_v).
      IF sy-tabix > 1.
        lv_msgv = lv_msgv && ','.
      ENDIF.
      lv_msgv = lv_msgv && |"{ esc( lv_v ) }"|.
    ENDLOOP.
    IF lv_msgv IS NOT INITIAL.
      lv_json = lv_json && |,"msgv":[{ lv_msgv }]|.
    ENDIF.
    lv_json = lv_json && |,"text":"{ esc( iv_text ) }"\\}|.
    emit( |{ c_prefix }ERR { lv_json }| ).
  ENDMETHOD.

  METHOD end.
    DATA lv_now   TYPE i.
    DATA lv_ms    TYPE i.
    DATA lv_rc    TYPE i.
    DATA lv_trunc TYPE string.
    IF gv_ended = abap_true.
      RETURN.
    ENDIF.
    gv_ended = abap_true.
    GET RUN TIME FIELD lv_now.
    lv_ms = ( lv_now - gv_t0 ) / 1000.
    IF lv_ms < 0.
      lv_ms = 0.
    ENDIF.
    lv_rc = iv_rc.
    IF lv_rc = 0 AND gv_errors > 0.
      lv_rc = 8.
    ENDIF.
    IF iv_truncated = abap_true.
      lv_trunc = 'true'.
    ELSE.
      lv_trunc = 'false'.
    ENDIF.
    emit( |{ c_prefix }END \\{"rc":{ lv_rc },"outBytes":{ gv_bytes },"truncated":{ lv_trunc },"ms":{ lv_ms }\\}| ).
  ENDMETHOD.

  METHOD failed.
    rv_failed = boolc( gv_errors > 0 ).
  ENDMETHOD.

  METHOD run.
    DATA lv_rc TYPE i.
    begin( iv_id = 'rt' iv_action = iv_action ).
    CASE iv_action.
      WHEN 'ping'.
        out( |\\{"pong":true,"ver":"{ esc( gv_ver ) }"\\}| ).
      WHEN 'fail'.
        err( iv_kind = 'exception'
             iv_step = 'fail'
             iv_text = 'the fail action always reports this error' ).
        lv_rc = 4.
      WHEN OTHERS.
        err( iv_kind = 'exception'
             iv_step = 'dispatch'
             iv_text = |unknown action { iv_action }| ).
        lv_rc = 4.
    ENDCASE.
    end( lv_rc ).
  ENDMETHOD.

ENDCLASS.
`;

export const fluidRuntimeManifest: FluidManifest = {
  contract: FLUID_CONTRACT,
  id: "rt",
  title: "Fluid API runtime",
  description: "Console protocol runtime shared by generated fluid tools",
  objects: [
    {
      name: FLUID_RUNTIME_CLASS,
      type: "CLAS/OC",
      description: "abapsmith fluid API console protocol runtime",
      source: { text: FLUID_RUNTIME_SOURCE },
    },
  ],
  entry: FLUID_RUNTIME_CLASS,
  actions: [
    {
      name: "ping",
      category: "read",
      description: "Proves the round trip and echoes the deployed version.",
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: { pong: { type: "boolean" }, ver: { type: "string" } },
        required: ["pong", "ver"],
      },
    },
    {
      name: "fail",
      category: "read",
      description: "Always reports an error frame, so the error path can be verified end to end.",
      input: { type: "object", properties: {} },
      output: { type: "object", properties: {} },
    },
  ],
};

export const fluidRuntimeSources: ReadonlyMap<string, string> = new Map([
  [FLUID_RUNTIME_CLASS, FLUID_RUNTIME_SOURCE],
]);

export const fluidRuntimeTool: LoadedFluidTool = {
  manifest: fluidRuntimeManifest,
  origin: "builtin",
  sources: fluidRuntimeSources,
  version: manifestVersion(fluidRuntimeManifest, fluidRuntimeSources),
};
