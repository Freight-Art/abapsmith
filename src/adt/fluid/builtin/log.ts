/**
 * Built-in "log" fluid tool: reads SAP application log (BAL/SLG1) headers
 * and, on request, their messages.
 *
 * Issue #108 names `BAL_LOG_READ` as the function module to call. That
 * function module does not exist under that name on a current system (BAL
 * has never had a single-call "read everything" entry point) — the
 * documented API is a search/load/read pipeline: `BAL_DB_SEARCH` finds log
 * headers matching a filter, `BAL_DB_LOAD` loads a found log's messages into
 * session memory and returns a handle per message, and `BAL_LOG_MSG_READ`
 * reads one message by handle, rendering its message-class text. This tool
 * uses that pipeline.
 *
 * Every FM signature below was verified live on system A4H (probe class
 * ZCL_I108_PROBE, 2026-09-15): `BAL_DB_SEARCH` returned 5 headers for a
 * 90-day window; `BAL_DB_LOAD` called with `i_lock_handling = 0` against one
 * of those headers returned 440 message handles; `BAL_LOG_MSG_READ` given
 * one of those handles returned `e_s_msg` plus the rendered `e_txt_msg`. Do
 * not change a parameter name or type below without re-verifying live —
 * BAL's function modules are old enough that several very similarly named
 * variants exist (e.g. `BAL_DB_LOAD` vs `BAL_DB_SEARCH_AND_LOAD`) and only
 * the ones actually probed are known-good here.
 *
 * `BAL_DB_LOAD` can itself write to the database: when it loads a log
 * stored in an old on-disk format it converts it in place via
 * `BAL_DB_SAVE_OLD_VERSIONS`. That makes `detail=messages` on such a system
 * not provably free of database side effects even though this is a "read"
 * action — recorded here rather than papered over.
 */
import type { FluidManifest, LoadedFluidTool } from "../manifest.js";
import { FLUID_CONTRACT, manifestVersion } from "../manifest.js";
import { FLUID_RUNTIME_CLASS, fluidRuntimeManifest, fluidRuntimeSources } from "../abap/runtime.js";

export const LOG_TOOL_ID = "log";
export const LOG_ACTION = "read";
export const LOG_ENTRY_CLASS = "ZCL_ZMCP_FLUID_LOG";

const RUNTIME_SOURCE = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS);
if (RUNTIME_SOURCE === undefined) {
  throw new Error(`fluidRuntimeSources has no entry for ${FLUID_RUNTIME_CLASS}`);
}

const RUNTIME_OBJECT = fluidRuntimeManifest.objects.find((o) => o.name === FLUID_RUNTIME_CLASS);
if (RUNTIME_OBJECT === undefined) {
  throw new Error(`fluidRuntimeManifest has no entry for ${FLUID_RUNTIME_CLASS}`);
}

const LOG_SOURCE = `CLASS zcl_zmcp_fluid_log DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    CLASS-METHODS run
      IMPORTING
        iv_action TYPE string
        iv_json   TYPE string.

  PRIVATE SECTION.
    CLASS-DATA gv_trunc TYPE abap_bool.

    CLASS-METHODS do_read.
    " ZCL_ZMCP_FLUID_RT=>n( iv_path ) counts array/object elements addressed
    " as <path>/0, <path>/1, ... - it is not a scalar number reader and
    " returns 0 for a plain scalar like {"max":5}. Read the scalar as a
    " string via s( ) and convert it here instead.
    CLASS-METHODS num
      IMPORTING iv_path        TYPE string
      RETURNING VALUE(rv_value) TYPE i.

ENDCLASS.


CLASS zcl_zmcp_fluid_log IMPLEMENTATION.

  METHOD run.
    zcl_zmcp_fluid_rt=>begin( iv_id = 'log' iv_action = iv_action ).

    TRY.
        zcl_zmcp_fluid_rt=>scan( iv_json ).
        CASE iv_action.
          WHEN 'read'.
            do_read( ).
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

  METHOD num.
    DATA lv_raw TYPE string.
    CLEAR rv_value.
    lv_raw = zcl_zmcp_fluid_rt=>s( iv_path ).
    IF lv_raw IS INITIAL.
      RETURN.
    ENDIF.
    TRY.
        rv_value = lv_raw.
      CATCH cx_root.
        CLEAR rv_value.
    ENDTRY.
  ENDMETHOD.

  METHOD do_read.
    CLEAR gv_trunc.

    DATA(lv_object)       = to_upper( zcl_zmcp_fluid_rt=>s( 'object' ) ).
    DATA(lv_subobject)    = to_upper( zcl_zmcp_fluid_rt=>s( 'subobject' ) ).
    DATA(lv_extnumber)    = zcl_zmcp_fluid_rt=>s( 'extnumber' ).
    DATA(lv_user)         = zcl_zmcp_fluid_rt=>s( 'user' ).
    DATA(lv_since)        = zcl_zmcp_fluid_rt=>s( 'since' ).
    DATA(lv_until)        = zcl_zmcp_fluid_rt=>s( 'until' ).
    DATA(lv_tcode)        = to_upper( zcl_zmcp_fluid_rt=>s( 'tcode' ) ).
    DATA(lv_program)      = to_upper( zcl_zmcp_fluid_rt=>s( 'program' ) ).
    DATA(lv_max)          = num( 'max' ).
    DATA(lv_last_seconds) = num( 'last_seconds' ).
    DATA(lv_detail)       = zcl_zmcp_fluid_rt=>s( 'detail' ).

    IF lv_detail IS INITIAL.
      lv_detail = 'headers'.
    ENDIF.
    IF lv_detail <> 'headers' AND lv_detail <> 'messages'.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'input' iv_step = 'read'
        iv_text = |unknown detail "{ lv_detail }" - expected headers or messages| ).
      RETURN.
    ENDIF.

    IF lv_last_seconds > 0 AND ( lv_since IS NOT INITIAL OR lv_until IS NOT INITIAL ).
      zcl_zmcp_fluid_rt=>err( iv_kind = 'input' iv_step = 'read'
        iv_text = 'last_seconds cannot be combined with since or until' ).
      RETURN.
    ENDIF.

    IF lv_user IS INITIAL.
      lv_user = sy-uname.
    ENDIF.

    " One server-time snapshot for both the default window and the summary's
    " server_time, so the two never disagree about "now".
    GET TIME.
    DATA(lv_now_d) = sy-datum.
    DATA(lv_now_t) = sy-uzeit.

    DATA lv_from_d TYPE d.
    DATA lv_from_t TYPE t.
    DATA lv_to_d   TYPE d.
    DATA lv_to_t   TYPE t.
    CLEAR: lv_from_d, lv_from_t, lv_to_d, lv_to_t.

    IF lv_last_seconds > 0.
      lv_to_d = lv_now_d.
      lv_to_t = lv_now_t.
      DATA lv_ts TYPE timestamp.
      CLEAR lv_ts.
      CONVERT DATE lv_now_d TIME lv_now_t INTO TIME STAMP lv_ts TIME ZONE sy-zonlo.
      lv_ts = cl_abap_tstmp=>subtractsecs( tstmp = lv_ts secs = lv_last_seconds ).
      CONVERT TIME STAMP lv_ts TIME ZONE sy-zonlo INTO DATE lv_from_d TIME lv_from_t.
    ELSEIF lv_since IS INITIAL AND lv_until IS INITIAL.
      " No window given at all: default to the last hour, ending now.
      lv_to_d = lv_now_d.
      lv_to_t = lv_now_t.
      DATA lv_ts_default TYPE timestamp.
      CLEAR lv_ts_default.
      CONVERT DATE lv_now_d TIME lv_now_t INTO TIME STAMP lv_ts_default TIME ZONE sy-zonlo.
      lv_ts_default = cl_abap_tstmp=>subtractsecs( tstmp = lv_ts_default secs = 3600 ).
      CONVERT TIME STAMP lv_ts_default TIME ZONE sy-zonlo INTO DATE lv_from_d TIME lv_from_t.
    ELSE.
      IF lv_since IS NOT INITIAL.
        IF strlen( lv_since ) <> 14 OR lv_since CN '0123456789'.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'input' iv_step = 'read'
            iv_text = |since must be 14 digits YYYYMMDDHHMMSS, got "{ lv_since }"| ).
          RETURN.
        ENDIF.
        lv_from_d = lv_since(8).
        lv_from_t = lv_since+8(6).
      ENDIF.
      " until omitted while since is given: no upper bound but "now", so the
      " window still closes rather than reaching into the future.
      IF lv_until IS NOT INITIAL.
        IF strlen( lv_until ) <> 14 OR lv_until CN '0123456789'.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'input' iv_step = 'read'
            iv_text = |until must be 14 digits YYYYMMDDHHMMSS, got "{ lv_until }"| ).
          RETURN.
        ENDIF.
        lv_to_d = lv_until(8).
        lv_to_t = lv_until+8(6).
      ELSE.
        lv_to_d = lv_now_d.
        lv_to_t = lv_now_t.
      ENDIF.
    ENDIF.

    DATA ls_filter TYPE bal_s_lfil.
    CLEAR ls_filter.

    DATA lt_obj_r  TYPE bal_r_obj.
    DATA lt_sub_r  TYPE bal_r_sub.
    DATA lt_extn_r TYPE bal_r_extn.
    DATA lt_user_r TYPE bal_r_user.
    DATA lt_tcde_r TYPE bal_r_tcde.
    DATA lt_prog_r TYPE bal_r_prog.
    CLEAR: lt_obj_r, lt_sub_r, lt_extn_r, lt_user_r, lt_tcde_r, lt_prog_r.

    IF lv_object IS NOT INITIAL.
      IF lv_object CA '*+'.
        APPEND VALUE #( sign = 'I' option = 'CP' low = lv_object ) TO lt_obj_r.
      ELSE.
        APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_object ) TO lt_obj_r.
      ENDIF.
    ENDIF.
    IF lv_subobject IS NOT INITIAL.
      IF lv_subobject CA '*+'.
        APPEND VALUE #( sign = 'I' option = 'CP' low = lv_subobject ) TO lt_sub_r.
      ELSE.
        APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_subobject ) TO lt_sub_r.
      ENDIF.
    ENDIF.
    IF lv_extnumber IS NOT INITIAL.
      IF lv_extnumber CA '*+'.
        APPEND VALUE #( sign = 'I' option = 'CP' low = lv_extnumber ) TO lt_extn_r.
      ELSE.
        APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_extnumber ) TO lt_extn_r.
      ENDIF.
    ENDIF.
    IF lv_tcode IS NOT INITIAL.
      IF lv_tcode CA '*+'.
        APPEND VALUE #( sign = 'I' option = 'CP' low = lv_tcode ) TO lt_tcde_r.
      ELSE.
        APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_tcode ) TO lt_tcde_r.
      ENDIF.
    ENDIF.
    IF lv_program IS NOT INITIAL.
      IF lv_program CA '*+'.
        APPEND VALUE #( sign = 'I' option = 'CP' low = lv_program ) TO lt_prog_r.
      ELSE.
        APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_program ) TO lt_prog_r.
      ENDIF.
    ENDIF.
    " '*' means every user: no ALUSER range line at all, matching the plain
    " "omitted" case rather than a pattern match on the literal '*'.
    IF lv_user <> '*'.
      APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_user ) TO lt_user_r.
    ENDIF.

    ls_filter-object    = lt_obj_r.
    ls_filter-subobject = lt_sub_r.
    ls_filter-extnumber = lt_extn_r.
    ls_filter-aluser    = lt_user_r.
    ls_filter-altcode   = lt_tcde_r.
    ls_filter-alprog    = lt_prog_r.
    ls_filter-date_time-date_from = lv_from_d.
    ls_filter-date_time-time_from = lv_from_t.
    ls_filter-date_time-date_to   = lv_to_d.
    ls_filter-date_time-time_to   = lv_to_t.

    " Ask for one more than the caller's ceiling so truncation is detected
    " without ever silently dropping rows the caller didn't ask to cap.
    DATA(lv_req) = 0.
    IF lv_max > 0.
      lv_req = lv_max + 1.
    ENDIF.
    ls_filter-max_nr_logs = lv_req.

    " BAL_DB_LOAD silently skips a log already held in this session's BAL
    " memory, so that memory is cleared first - otherwise a log read earlier
    " in the same session (e.g. by a prior call in this same work process)
    " could come back with zero messages instead of its real ones.
    CALL FUNCTION 'BAL_GLB_MEMORY_REFRESH'
      EXCEPTIONS
        OTHERS = 0.

    DATA lt_hdr TYPE balhdr_t.
    CLEAR lt_hdr.
    CALL FUNCTION 'BAL_DB_SEARCH'
      EXPORTING
        i_s_log_filter     = ls_filter
      IMPORTING
        e_t_log_header     = lt_hdr
      EXCEPTIONS
        log_not_found      = 1
        no_filter_criteria = 2
        OTHERS             = 3.
    DATA(lv_search_subrc) = sy-subrc.
    " subrc = 1 (log_not_found) is not an error - it means zero logs matched;
    " fall through so the trailing summary row still goes out.
    IF lv_search_subrc = 2 OR lv_search_subrc = 3.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'subrc' iv_step = 'search' iv_subrc = lv_search_subrc
        iv_text = 'BAL_DB_SEARCH failed' ).
      RETURN.
    ENDIF.

    IF lv_max > 0 AND lines( lt_hdr ) > lv_max.
      gv_trunc = abap_true.
      " DELETE ... FROM requires a data object, not an arithmetic expression.
      DATA(lv_cut_from) = lv_max + 1.
      DELETE lt_hdr FROM lv_cut_from.
    ENDIF.

    DATA(lv_logs_returned)     = 0.
    DATA(lv_messages_returned) = 0.

    LOOP AT lt_hdr INTO DATA(ls_hdr).
      lv_logs_returned = lv_logs_returned + 1.
      DATA(lv_lognr_s) = |{ ls_hdr-lognumber }|.

      DATA(lv_msg_total_s)   = |{ CONV i( ls_hdr-msg_cnt_al ) }|.
      DATA(lv_msg_abort_s)   = |{ CONV i( ls_hdr-msg_cnt_a ) }|.
      DATA(lv_msg_error_s)   = |{ CONV i( ls_hdr-msg_cnt_e ) }|.
      DATA(lv_msg_warning_s) = |{ CONV i( ls_hdr-msg_cnt_w ) }|.
      DATA(lv_msg_info_s)    = |{ CONV i( ls_hdr-msg_cnt_i ) }|.
      DATA(lv_msg_success_s) = |{ CONV i( ls_hdr-msg_cnt_s ) }|.
      DATA(lv_aldate_s)      = |{ ls_hdr-aldate DATE = RAW }|.
      DATA(lv_altime_s)      = |{ ls_hdr-altime TIME = RAW }|.

      zcl_zmcp_fluid_rt=>out(
        |\\{"kind":"log","lognumber":"{ zcl_zmcp_fluid_rt=>esc( lv_lognr_s ) }",| &&
        " esc( ) is declared IMPORTING iv_text TYPE string; a DDIC C(n)
        " actual (ls_hdr's components below) is not assignable to a string
        " formal in a functional call, so each one is CONV-wrapped first.
        |"object":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_hdr-object ) ) }",| &&
        |"subobject":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_hdr-subobject ) ) }",| &&
        |"extnumber":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_hdr-extnumber ) ) }",| &&
        |"aldate":"{ zcl_zmcp_fluid_rt=>esc( lv_aldate_s ) }",| &&
        |"altime":"{ zcl_zmcp_fluid_rt=>esc( lv_altime_s ) }",| &&
        |"aluser":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_hdr-aluser ) ) }",| &&
        |"alprog":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_hdr-alprog ) ) }",| &&
        |"altcode":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_hdr-altcode ) ) }",| &&
        |"almode":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_hdr-almode ) ) }",| &&
        |"probclass":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_hdr-probclass ) ) }",| &&
        |"msg_total":{ lv_msg_total_s },"msg_abort":{ lv_msg_abort_s },| &&
        |"msg_error":{ lv_msg_error_s },"msg_warning":{ lv_msg_warning_s },| &&
        |"msg_info":{ lv_msg_info_s },"msg_success":{ lv_msg_success_s }\\}| ).

      IF lv_detail = 'messages'.
        DATA lt_one TYPE balhdr_t.
        CLEAR lt_one.
        APPEND ls_hdr TO lt_one.

        DATA lt_hndl TYPE bal_t_msgh.
        CLEAR lt_hndl.

        " i_lock_handling = 0 means no enqueue at all for this load (verified
        " live by reading LSBAL_DBF11 form READ_BALDAT) - a read action has
        " no business taking a lock. See the header comment above for the
        " one way this call can still write to the database.
        CALL FUNCTION 'BAL_DB_LOAD'
          EXPORTING
            i_t_log_header         = lt_one
            i_do_not_load_messages = space
            i_lock_handling        = 0
          IMPORTING
            e_t_msg_handle         = lt_hndl
          EXCEPTIONS
            no_logs_specified      = 1
            log_not_found          = 2
            log_already_loaded     = 3
            OTHERS                 = 4.
        DATA(lv_load_subrc) = sy-subrc.

        IF lv_load_subrc = 2 OR lv_load_subrc = 3.
          " This one log's messages could not be loaded; its header row
          " already went out, so the read continues with the next log.
        ELSEIF lv_load_subrc <> 0.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'subrc' iv_step = 'load' iv_subrc = lv_load_subrc
            iv_text = 'BAL_DB_LOAD failed' ).
          RETURN.
        ELSE.
          LOOP AT lt_hndl INTO DATA(ls_hndl).
            DATA ls_msg TYPE bal_s_msg.
            DATA lv_txt TYPE string.
            CLEAR: ls_msg, lv_txt.

            CALL FUNCTION 'BAL_LOG_MSG_READ'
              EXPORTING
                i_s_msg_handle = ls_hndl
              IMPORTING
                e_s_msg        = ls_msg
                e_txt_msg      = lv_txt
              EXCEPTIONS
                log_not_found  = 1
                msg_not_found  = 2
                OTHERS         = 3.
            IF sy-subrc <> 0.
              CONTINUE.
            ENDIF.

            lv_messages_returned = lv_messages_returned + 1.
            DATA(lv_msgno_s)    = |{ CONV i( ls_hndl-msgnumber ) }|.
            DATA(lv_detlevel_s) = |{ CONV i( ls_msg-detlevel ) }|.

            " ls_msg-context-value (the raw content of an arbitrary application
            " structure attached to the message) is real business data and is
            " never emitted below - only its type name, context_tabname, is.
            zcl_zmcp_fluid_rt=>out(
              |\\{"kind":"msg","lognumber":"{ zcl_zmcp_fluid_rt=>esc( lv_lognr_s ) }",| &&
              |"msgnumber":{ lv_msgno_s },| &&
              |"msgty":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_msg-msgty ) ) }",| &&
              |"msgid":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_msg-msgid ) ) }",| &&
              |"msgno":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_msg-msgno ) ) }",| &&
              |"msgv1":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_msg-msgv1 ) ) }",| &&
              |"msgv2":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_msg-msgv2 ) ) }",| &&
              |"msgv3":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_msg-msgv3 ) ) }",| &&
              |"msgv4":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_msg-msgv4 ) ) }",| &&
              |"text":"{ zcl_zmcp_fluid_rt=>esc( lv_txt ) }",| &&
              |"detlevel":{ lv_detlevel_s },| &&
              |"probclass":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_msg-probclass ) ) }",| &&
              |"context_tabname":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_msg-context-tabname ) ) }"\\}| ).
          ENDLOOP.
        ENDIF.
      ENDIF.
    ENDLOOP.

    DATA(lv_since_resolved) = |{ lv_from_d DATE = RAW }{ lv_from_t TIME = RAW }|.
    DATA(lv_until_resolved) = |{ lv_to_d DATE = RAW }{ lv_to_t TIME = RAW }|.
    DATA(lv_server_time)    = |{ lv_now_d DATE = RAW }{ lv_now_t TIME = RAW }|.

    " Report the filter as actually applied - '*' collapses back to "no
    " user filter" so the caller can tell the two cases apart.
    DATA(lv_user_applied) = lv_user.
    IF lv_user_applied = '*'.
      CLEAR lv_user_applied.
    ENDIF.

    DATA(lv_trunc_json) = 'false'.
    IF gv_trunc = abap_true.
      lv_trunc_json = 'true'.
    ENDIF.

    DATA(lv_logs_returned_s)     = |{ lv_logs_returned }|.
    DATA(lv_messages_returned_s) = |{ lv_messages_returned }|.
    DATA(lv_max_s)               = |{ lv_max }|.

    zcl_zmcp_fluid_rt=>out(
      |\\{"kind":"summary","logs_returned":{ lv_logs_returned_s },| &&
      |"messages_returned":{ lv_messages_returned_s },| &&
      |"truncated":{ lv_trunc_json },| &&
      |"detail":"{ zcl_zmcp_fluid_rt=>esc( lv_detail ) }",| &&
      |"since":"{ zcl_zmcp_fluid_rt=>esc( lv_since_resolved ) }",| &&
      |"until":"{ zcl_zmcp_fluid_rt=>esc( lv_until_resolved ) }",| &&
      |"user":"{ zcl_zmcp_fluid_rt=>esc( lv_user_applied ) }",| &&
      |"max":{ lv_max_s },| &&
      |"server_time":"{ zcl_zmcp_fluid_rt=>esc( lv_server_time ) }"\\}| ).
  ENDMETHOD.

ENDCLASS.
`;

export const logManifest: FluidManifest = {
  contract: FLUID_CONTRACT,
  id: LOG_TOOL_ID,
  title: "Application log reader",
  description: "Reads application log (BAL/SLG1) headers and messages.",
  objects: [
    {
      name: FLUID_RUNTIME_CLASS,
      type: "CLAS/OC",
      description: RUNTIME_OBJECT.description,
      source: { text: RUNTIME_SOURCE },
    },
    {
      name: LOG_ENTRY_CLASS,
      type: "CLAS/OC",
      description: "fluid: application log (BAL) reader",
      source: { text: LOG_SOURCE },
    },
  ],
  entry: LOG_ENTRY_CLASS,
  actions: [
    {
      name: LOG_ACTION,
      category: "read",
      description:
        "Reads application log (BAL/SLG1) headers, and with detail=messages the message texts. " +
        "Message text and its variables are application data and may contain business data - " +
        "request detail=messages only when you need it.",
      input: {
        type: "object",
        properties: {
          object: {
            type: "string",
            maxLength: 20,
            description: "BALHDR-OBJECT. `*` and `+` make it a pattern.",
          },
          subobject: {
            type: "string",
            maxLength: 20,
            description: "BALHDR-SUBOBJECT. `*` and `+` make it a pattern.",
          },
          extnumber: {
            type: "string",
            maxLength: 100,
            description: "External number, pattern allowed.",
          },
          user: {
            type: "string",
            maxLength: 12,
            description: "Defaults to the connected user. Pass `*` for every user.",
          },
          since: {
            type: "string",
            maxLength: 14,
            description: "Server-time lower bound, YYYYMMDDHHMMSS.",
          },
          until: {
            type: "string",
            maxLength: 14,
            description: "Server-time upper bound, YYYYMMDDHHMMSS.",
          },
          last_seconds: {
            type: "integer",
            minimum: 0,
            description: "Window ending now, computed on the server. Mutually exclusive with since/until.",
          },
          tcode: {
            type: "string",
            maxLength: 20,
            description: "Transaction code, pattern allowed.",
          },
          program: {
            type: "string",
            maxLength: 40,
            description: "Program name, pattern allowed.",
          },
          max: {
            type: "integer",
            minimum: 0,
            description:
              "Log limit. Omitted or 0 means no limit; abapsmith's caller applies the default and marks truncation.",
          },
          detail: {
            type: "string",
            enum: ["headers", "messages"],
            description: "`headers` (default) or `messages`.",
          },
        },
      },
      output: {
        type: "array",
        description: "One row per log header, per message, and one trailing summary row.",
        items: { type: "object" },
      },
    },
  ],
};

export const logSources: ReadonlyMap<string, string> = new Map([
  [FLUID_RUNTIME_CLASS, RUNTIME_SOURCE],
  [LOG_ENTRY_CLASS, LOG_SOURCE],
]);

export const logTool: LoadedFluidTool = {
  manifest: logManifest,
  origin: "builtin",
  sources: logSources,
  version: manifestVersion(logManifest, logSources),
};
