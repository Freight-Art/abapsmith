CLASS zcl_zmcp_x_jobs DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run IMPORTING iv_action TYPE string
                                iv_json   TYPE string.

  PRIVATE SECTION.
    CLASS-METHODS do_list      RETURNING VALUE(rv_rc) TYPE i.
    CLASS-METHODS do_show      RETURNING VALUE(rv_rc) TYPE i.
    CLASS-METHODS do_spool     RETURNING VALUE(rv_rc) TYPE i.
    CLASS-METHODS do_schedule  RETURNING VALUE(rv_rc) TYPE i.
    CLASS-METHODS do_cancel    RETURNING VALUE(rv_rc) TYPE i.

    CLASS-METHODS job_row
      IMPORTING is_tbtco       TYPE tbtco
      RETURNING VALUE(rv_json) TYPE string.

    CLASS-METHODS resolve_jobcount
      IMPORTING iv_jobname  TYPE tbtco-jobname
                iv_jobcount TYPE string
      EXPORTING ev_jobcount TYPE tbtco-jobcount
                ev_found    TYPE abap_bool.

    CLASS-METHODS like_pattern
      IMPORTING iv_pattern        TYPE string
      RETURNING VALUE(rv_pattern) TYPE string.

    CLASS-METHODS status_text
      IMPORTING iv_status      TYPE tbtco-status
      RETURNING VALUE(rv_text) TYPE string.

    CLASS-METHODS int_of
      IMPORTING iv_text         TYPE string
      RETURNING VALUE(rv_value) TYPE i.

    CLASS-METHODS clean
      IMPORTING iv_text        TYPE string
      RETURNING VALUE(rv_text) TYPE string.

    CLASS-METHODS js
      IMPORTING iv_text        TYPE clike
      RETURNING VALUE(rv_text) TYPE string.

    CLASS-METHODS bool
      IMPORTING iv_value       TYPE abap_bool
      RETURNING VALUE(rv_text) TYPE string.

    CLASS-METHODS fm_fail
      IMPORTING iv_step  TYPE string
                iv_fm    TYPE string
                iv_subrc TYPE i
                iv_exc   TYPE string.
ENDCLASS.

CLASS zcl_zmcp_x_jobs IMPLEMENTATION.

  METHOD run.
    DATA lv_rc TYPE i.
    zcl_zmcp_fluid_rt=>begin( iv_id = 'jobs' iv_action = iv_action ).
    TRY.
        zcl_zmcp_fluid_rt=>scan( iv_json ).
        CASE iv_action.
          WHEN 'list'.
            lv_rc = do_list( ).
          WHEN 'show'.
            lv_rc = do_show( ).
          WHEN 'spool'.
            lv_rc = do_spool( ).
          WHEN 'schedule'.
            lv_rc = do_schedule( ).
          WHEN 'cancel'.
            lv_rc = do_cancel( ).
          WHEN OTHERS.
            zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'dispatch'
                                    iv_text = |unknown action { iv_action }| ).
            lv_rc = 4.
        ENDCASE.
      CATCH cx_root INTO DATA(lx_err).
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = iv_action
                                iv_text = lx_err->get_text( ) ).
        lv_rc = 8.
    ENDTRY.
    zcl_zmcp_fluid_rt=>end( lv_rc ).
  ENDMETHOD.

  METHOD clean.
    DATA lv_char TYPE c LENGTH 1.
    DATA lv_i    TYPE i.
    rv_text = iv_text.
    DO 32 TIMES.
      lv_i = sy-index - 1.
      CHECK lv_i <> 9 AND lv_i <> 10 AND lv_i <> 13.
      lv_char = cl_abap_conv_in_ce=>uccpi( lv_i ).
      REPLACE ALL OCCURRENCES OF lv_char IN rv_text WITH ' '.
    ENDDO.
  ENDMETHOD.

  METHOD js.
    DATA lv_in TYPE string.
    lv_in = iv_text.
    rv_text = |"{ zcl_zmcp_fluid_rt=>esc( clean( lv_in ) ) }"|.
  ENDMETHOD.

  METHOD bool.
    IF iv_value = abap_true.
      rv_text = 'true'.
    ELSE.
      rv_text = 'false'.
    ENDIF.
  ENDMETHOD.

  METHOD fm_fail.
    DATA lv_id  TYPE string.
    DATA lv_no  TYPE i.
    DATA lv_v1  TYPE sy-msgv1.
    DATA lv_v2  TYPE sy-msgv2.
    DATA lv_v3  TYPE sy-msgv3.
    DATA lv_v4  TYPE sy-msgv4.
    DATA lv_msg TYPE string.
    DATA lt_msgv TYPE string_table.

    lv_id = sy-msgid.
    CONDENSE lv_id.
    lv_no = sy-msgno.
    lv_v1 = sy-msgv1.
    lv_v2 = sy-msgv2.
    lv_v3 = sy-msgv3.
    lv_v4 = sy-msgv4.

    IF lv_id IS NOT INITIAL.
      MESSAGE ID lv_id TYPE 'S' NUMBER lv_no WITH lv_v1 lv_v2 lv_v3 lv_v4 INTO lv_msg.
      APPEND lv_v1 TO lt_msgv.
      APPEND lv_v2 TO lt_msgv.
      APPEND lv_v3 TO lt_msgv.
      APPEND lv_v4 TO lt_msgv.
    ENDIF.

    zcl_zmcp_fluid_rt=>err( iv_kind = 'subrc' iv_step = iv_step iv_subrc = iv_subrc
                            iv_msgid = lv_id iv_msgno = lv_no it_msgv = lt_msgv
                            iv_text = |{ iv_fm } failed: { iv_exc } (sy-subrc { iv_subrc }): { lv_msg }| ).
  ENDMETHOD.

  METHOD int_of.
    DATA lv_text TYPE string.
    lv_text = iv_text.
    CONDENSE lv_text.
    IF lv_text IS INITIAL.
      rv_value = 0.
      RETURN.
    ENDIF.
    TRY.
        rv_value = lv_text.
      CATCH cx_sy_conversion_error.
        rv_value = 0.
    ENDTRY.
  ENDMETHOD.

  METHOD like_pattern.
    rv_pattern = iv_pattern.
    IF rv_pattern IS INITIAL.
      rv_pattern = '*'.
    ENDIF.
    REPLACE ALL OCCURRENCES OF '#' IN rv_pattern WITH '##'.
    REPLACE ALL OCCURRENCES OF '_' IN rv_pattern WITH '#_'.
    REPLACE ALL OCCURRENCES OF '%' IN rv_pattern WITH '#%'.
    REPLACE ALL OCCURRENCES OF '*' IN rv_pattern WITH '%'.
    REPLACE ALL OCCURRENCES OF '+' IN rv_pattern WITH '_'.
  ENDMETHOD.

  METHOD status_text.
    CASE iv_status.
      WHEN 'P'.
        rv_text = 'scheduled'.
      WHEN 'S'.
        rv_text = 'released'.
      WHEN 'Y'.
        rv_text = 'ready'.
      WHEN 'R'.
        rv_text = 'active'.
      WHEN 'Z'.
        rv_text = 'released/suspended'.
      WHEN 'F'.
        rv_text = 'finished'.
      WHEN 'A'.
        rv_text = 'cancelled'.
      WHEN 'X'.
        rv_text = 'unknown'.
      WHEN OTHERS.
        rv_text = ''.
    ENDCASE.
  ENDMETHOD.

  METHOD resolve_jobcount.
    DATA lv_check TYPE tbtco-jobcount.
    DATA lt_tbtco TYPE STANDARD TABLE OF tbtco.
    DATA ls_tbtco TYPE tbtco.

    CLEAR ev_jobcount.
    ev_found = abap_false.

    IF iv_jobcount IS NOT INITIAL.
      SELECT SINGLE jobcount FROM tbtco INTO lv_check
        WHERE authckman = sy-mandt
          AND jobname   = iv_jobname
          AND jobcount  = iv_jobcount.
      IF sy-subrc = 0.
        ev_jobcount = lv_check.
        ev_found = abap_true.
      ENDIF.
      RETURN.
    ENDIF.

    SELECT * FROM tbtco INTO TABLE lt_tbtco
      UP TO 1 ROWS
      WHERE authckman = sy-mandt
        AND jobname   = iv_jobname
      ORDER BY sdldate DESCENDING sdltime DESCENDING.

    READ TABLE lt_tbtco INTO ls_tbtco INDEX 1.
    IF sy-subrc = 0.
      ev_jobcount = ls_tbtco-jobcount.
      ev_found = abap_true.
    ENDIF.
  ENDMETHOD.

  METHOD job_row.
    rv_json =
      |"jobname":{ js( is_tbtco-jobname ) },| &&
      |"jobcount":{ js( is_tbtco-jobcount ) },| &&
      |"status":{ js( is_tbtco-status ) },| &&
      |"status_text":{ js( status_text( is_tbtco-status ) ) },| &&
      |"scheduled_by":{ js( is_tbtco-sdluname ) },| &&
      |"exec_user":{ js( is_tbtco-authcknam ) },| &&
      |"job_class":{ js( is_tbtco-jobclass ) },| &&
      |"periodic":{ bool( xsdbool( is_tbtco-periodic = abap_true ) ) },| &&
      |"sdlstrtdt":{ js( is_tbtco-sdlstrtdt ) },| &&
      |"sdlstrttm":{ js( is_tbtco-sdlstrttm ) },| &&
      |"strtdate":{ js( is_tbtco-strtdate ) },| &&
      |"strttime":{ js( is_tbtco-strttime ) },| &&
      |"enddate":{ js( is_tbtco-enddate ) },| &&
      |"endtime":{ js( is_tbtco-endtime ) },| &&
      |"step_count":{ is_tbtco-stepcount },| &&
      |"exec_server":{ js( is_tbtco-execserver ) }|.
  ENDMETHOD.

  METHOD do_list.
    DATA lv_pattern TYPE string.
    DATA lv_user    TYPE string.
    DATA lv_status  TYPE string.
    DATA lv_from    TYPE tbtco-strtdate.
    DATA lv_to      TYPE tbtco-strtdate.
    DATA lv_max_txt TYPE string.
    DATA lv_max     TYPE i.
    DATA lv_fetch   TYPE i.
    DATA lv_del_from TYPE i.
    DATA lr_user    TYPE RANGE OF tbtco-sdluname.
    DATA lr_status  TYPE RANGE OF tbtco-status.
    DATA lt_tbtco   TYPE STANDARD TABLE OF tbtco.
    DATA ls_tbtco   TYPE tbtco.
    DATA lv_items   TYPE string.
    DATA lv_truncated TYPE abap_bool VALUE abap_false.

    rv_rc = 0.
    lv_pattern = like_pattern( zcl_zmcp_fluid_rt=>s( 'name' ) ).
    lv_user    = zcl_zmcp_fluid_rt=>s( 'user' ).
    lv_status  = zcl_zmcp_fluid_rt=>s( 'status' ).
    lv_from    = zcl_zmcp_fluid_rt=>s( 'from_date' ).
    lv_to      = zcl_zmcp_fluid_rt=>s( 'to_date' ).
    lv_max_txt = zcl_zmcp_fluid_rt=>s( 'max_rows' ).

    IF lv_from IS INITIAL.
      lv_from = '00010101'.
    ENDIF.
    IF lv_to IS INITIAL.
      lv_to = '99991231'.
    ENDIF.
    IF lv_max_txt IS INITIAL.
      lv_max = 100.
    ELSE.
      lv_max = int_of( lv_max_txt ).
    ENDIF.

    IF lv_user IS NOT INITIAL.
      APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_user ) TO lr_user.
    ENDIF.
    IF lv_status IS NOT INITIAL.
      APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_status ) TO lr_status.
    ENDIF.

    IF lv_max > 0.
      lv_fetch = lv_max + 1.
      SELECT * FROM tbtco INTO TABLE lt_tbtco
        UP TO lv_fetch ROWS
        WHERE authckman = sy-mandt
          AND jobname LIKE lv_pattern ESCAPE '#'
          AND sdluname IN lr_user
          AND status IN lr_status
          AND ( ( strtdate <> '00000000' AND strtdate BETWEEN lv_from AND lv_to )
             OR ( strtdate =  '00000000' AND sdlstrtdt BETWEEN lv_from AND lv_to ) )
        ORDER BY sdldate DESCENDING sdltime DESCENDING jobname ASCENDING.
    ELSE.
      SELECT * FROM tbtco INTO TABLE lt_tbtco
        WHERE authckman = sy-mandt
          AND jobname LIKE lv_pattern ESCAPE '#'
          AND sdluname IN lr_user
          AND status IN lr_status
          AND ( ( strtdate <> '00000000' AND strtdate BETWEEN lv_from AND lv_to )
             OR ( strtdate =  '00000000' AND sdlstrtdt BETWEEN lv_from AND lv_to ) )
        ORDER BY sdldate DESCENDING sdltime DESCENDING jobname ASCENDING.
    ENDIF.

    IF lv_max > 0 AND lines( lt_tbtco ) > lv_max.
      lv_truncated = abap_true.
      lv_del_from = lv_max + 1.
      DELETE lt_tbtco FROM lv_del_from.
    ENDIF.

    LOOP AT lt_tbtco INTO ls_tbtco.
      IF lv_items IS NOT INITIAL.
        lv_items = |{ lv_items },|.
      ENDIF.
      lv_items = |{ lv_items }\{{ job_row( ls_tbtco ) }\}|.
    ENDLOOP.

    zcl_zmcp_fluid_rt=>out(
      |\{"count":{ lines( lt_tbtco ) },"truncated":{ bool( lv_truncated ) },"jobs":[{ lv_items }]\}| ).
  ENDMETHOD.

  METHOD do_show.
    DATA lv_jobname    TYPE tbtco-jobname.
    DATA lv_jobcount_s TYPE string.
    DATA lv_jobcount   TYPE tbtco-jobcount.
    DATA lv_found      TYPE abap_bool.
    DATA ls_tbtco      TYPE tbtco.
    DATA lt_tbtcp      TYPE STANDARD TABLE OF tbtcp.
    DATA ls_tbtcp      TYPE tbtcp.
    DATA lv_spool_num  TYPE i.
    DATA lv_spool_id   TYPE string.
    DATA lv_external   TYPE abap_bool.
    DATA lt_log        TYPE STANDARD TABLE OF tbtc5.
    DATA lv_log_lines_s TYPE string.
    DATA lv_log_lines  TYPE i.
    DATA lv_log_head   TYPE abap_bool.
    DATA lv_log_count  TYPE i.
    DATA lv_log_total  TYPE i.
    DATA lv_log_from   TYPE i.
    DATA lv_log_to     TYPE i.
    DATA lv_log_trunc  TYPE abap_bool VALUE abap_false.
    DATA lv_steps      TYPE string.
    DATA lv_log_items  TYPE string.
    DATA lv_subrc      TYPE i.
    DATA lv_exc        TYPE string.

    rv_rc = 0.
    lv_jobname = zcl_zmcp_fluid_rt=>s( 'jobname' ).
    IF lv_jobname IS INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'jobname'
                              iv_text = 'jobname is required' ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    lv_jobcount_s = zcl_zmcp_fluid_rt=>s( 'jobcount' ).
    resolve_jobcount( EXPORTING iv_jobname = lv_jobname iv_jobcount = lv_jobcount_s
                       IMPORTING ev_jobcount = lv_jobcount ev_found = lv_found ).
    IF lv_found = abap_false.
      IF lv_jobcount_s IS NOT INITIAL.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'job'
                                iv_text = |job { lv_jobname } { lv_jobcount_s } not found in client { sy-mandt }| ).
      ELSE.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'job'
                                iv_text = |job { lv_jobname } not found in client { sy-mandt }| ).
      ENDIF.
      rv_rc = 4.
      RETURN.
    ENDIF.

    SELECT SINGLE * FROM tbtco INTO ls_tbtco
      WHERE authckman = sy-mandt AND jobname = lv_jobname AND jobcount = lv_jobcount.

    " TBTCP is cross-client, like TBTCO - it has no MANDT field at all, so
    " there is nothing to filter on; jobname/jobcount already came out of a
    " client-scoped TBTCO row.
    SELECT * FROM tbtcp INTO TABLE lt_tbtcp
      WHERE jobname = lv_jobname AND jobcount = lv_jobcount
      ORDER BY stepcount.

    lv_log_lines_s = zcl_zmcp_fluid_rt=>s( 'log_lines' ).
    IF lv_log_lines_s IS INITIAL.
      lv_log_lines = 200.
    ELSE.
      lv_log_lines = int_of( lv_log_lines_s ).
    ENDIF.
    lv_log_head = zcl_zmcp_fluid_rt=>b( 'log_head' ).

    CALL FUNCTION 'BP_JOBLOG_READ'
      EXPORTING
        client   = sy-mandt
        jobname  = lv_jobname
        jobcount = lv_jobcount
      TABLES
        joblogtbl = lt_log
      EXCEPTIONS
        joblog_does_not_exist = 1
        joblog_is_empty       = 2
        OTHERS                = 3.
    lv_subrc = sy-subrc.
    CASE lv_subrc.
      WHEN 1. lv_exc = 'JOBLOG_DOES_NOT_EXIST'.
      WHEN 2. lv_exc = 'JOBLOG_IS_EMPTY'.
      WHEN OTHERS. lv_exc = 'OTHERS'.
    ENDCASE.
    CASE lv_subrc.
      WHEN 0.
        " ok
      WHEN 1 OR 2.
        CLEAR lt_log.
      WHEN OTHERS.
        fm_fail( iv_step = 'joblog' iv_fm = 'BP_JOBLOG_READ' iv_subrc = lv_subrc iv_exc = lv_exc ).
        rv_rc = 8.
        RETURN.
    ENDCASE.

    lv_log_total = lines( lt_log ).
    IF lv_log_lines > 0 AND lv_log_total > lv_log_lines.
      lv_log_trunc = abap_true.
      IF lv_log_head = abap_true.
        lv_log_from = lv_log_lines + 1.
        DELETE lt_log FROM lv_log_from.
      ELSE.
        lv_log_to = lv_log_total - lv_log_lines.
        DELETE lt_log TO lv_log_to.
      ENDIF.
    ENDIF.
    lv_log_count = lines( lt_log ).

    LOOP AT lt_tbtcp INTO ls_tbtcp.
      lv_spool_num = ls_tbtcp-listident.
      IF lv_spool_num = 0.
        lv_spool_id = ''.
      ELSE.
        lv_spool_id = |{ lv_spool_num }|.
      ENDIF.
      lv_external = xsdbool( ls_tbtcp-xpgflag = abap_true
                           OR ls_tbtcp-xpgprog IS NOT INITIAL
                           OR ls_tbtcp-extcmd  IS NOT INITIAL ).
      IF lv_steps IS NOT INITIAL.
        lv_steps = |{ lv_steps },|.
      ENDIF.
      lv_steps = |{ lv_steps }\{| &&
        |"step":{ js( |{ ls_tbtcp-stepcount }| ) },| &&
        |"program":{ js( ls_tbtcp-progname ) },| &&
        |"variant":{ js( ls_tbtcp-variant ) },| &&
        |"exec_user":{ js( ls_tbtcp-authcknam ) },| &&
        |"status":{ js( ls_tbtcp-status ) },| &&
        |"language":{ js( ls_tbtcp-language ) },| &&
        |"spool_id":{ js( lv_spool_id ) },| &&
        |"external":{ bool( lv_external ) }\}|.
    ENDLOOP.

    LOOP AT lt_log INTO DATA(ls_log).
      IF lv_log_items IS NOT INITIAL.
        lv_log_items = |{ lv_log_items },|.
      ENDIF.
      lv_log_items = |{ lv_log_items }\{| &&
        |"date":{ js( |{ ls_log-enterdate }| ) },| &&
        |"time":{ js( |{ ls_log-entertime }| ) },| &&
        |"type":{ js( ls_log-msgtype ) },| &&
        |"msgid":{ js( ls_log-msgid ) },| &&
        |"msgno":{ js( ls_log-msgno ) },| &&
        |"text":{ js( ls_log-text ) }\}|.
    ENDLOOP.

    zcl_zmcp_fluid_rt=>out(
      |\{{ job_row( ls_tbtco ) },| &&
      |"steps":[{ lv_steps }],| &&
      |"log_count":{ lv_log_count },"log_truncated":{ bool( lv_log_trunc ) },"log":[{ lv_log_items }]\}| ).
  ENDMETHOD.

  METHOD do_spool.
    DATA lv_spool_id_s TYPE string.
    DATA lv_spool_id   TYPE i.
    DATA lv_jobname    TYPE tbtco-jobname.
    DATA lv_jobcount_s TYPE string.
    DATA lv_jobcount   TYPE tbtco-jobcount.
    DATA lv_found      TYPE abap_bool.
    DATA lv_step_s     TYPE string.
    DATA lv_step       TYPE i.
    DATA ls_tbtcp      TYPE tbtcp.
    DATA lt_tbtcp      TYPE STANDARD TABLE OF tbtcp.
    DATA lv_first_s    TYPE string.
    DATA lv_last_s     TYPE string.
    DATA lv_first      TYPE i.
    DATA lv_last       TYPE i.
    DATA lv_max_s      TYPE string.
    DATA lv_max        TYPE i.
    DATA lv_del_from   TYPE i.
    TYPES ty_asci TYPE c LENGTH 255.
    DATA lt_buffer TYPE STANDARD TABLE OF ty_asci WITH EMPTY KEY.
    DATA lv_line   TYPE string.
    DATA lv_lines  TYPE string.
    DATA lv_truncated TYPE abap_bool VALUE abap_false.
    DATA lv_len TYPE i.
    DATA lv_subrc TYPE i.
    DATA lv_exc TYPE string.

    rv_rc = 0.
    lv_spool_id_s = zcl_zmcp_fluid_rt=>s( 'spool_id' ).
    CONDENSE lv_spool_id_s.
    lv_jobname = zcl_zmcp_fluid_rt=>s( 'jobname' ).

    IF lv_spool_id_s IS NOT INITIAL.
      IF lv_spool_id_s CO '0123456789'.
        lv_spool_id = lv_spool_id_s.
      ELSE.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'spool_id'
                                iv_text = |spool_id { lv_spool_id_s } is not numeric| ).
        rv_rc = 4.
        RETURN.
      ENDIF.
    ELSEIF lv_jobname IS NOT INITIAL.
      lv_jobcount_s = zcl_zmcp_fluid_rt=>s( 'jobcount' ).
      resolve_jobcount( EXPORTING iv_jobname = lv_jobname iv_jobcount = lv_jobcount_s
                         IMPORTING ev_jobcount = lv_jobcount ev_found = lv_found ).
      IF lv_found = abap_false.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'job'
                                iv_text = |job { lv_jobname } not found in client { sy-mandt }| ).
        rv_rc = 4.
        RETURN.
      ENDIF.

      lv_step_s = zcl_zmcp_fluid_rt=>s( 'step' ).
      IF lv_step_s IS NOT INITIAL.
        lv_step = int_of( lv_step_s ).
        " TBTCP has no MANDT field (cross-client, like TBTCO); jobname/jobcount
        " already came out of a client-scoped TBTCO row via resolve_jobcount.
        SELECT SINGLE * FROM tbtcp INTO ls_tbtcp
          WHERE jobname = lv_jobname AND jobcount = lv_jobcount
            AND stepcount = lv_step AND listident <> 0.
      ELSE.
        SELECT * FROM tbtcp INTO TABLE lt_tbtcp
          UP TO 1 ROWS
          WHERE jobname = lv_jobname AND jobcount = lv_jobcount
            AND listident <> 0
          ORDER BY stepcount DESCENDING.
        READ TABLE lt_tbtcp INTO ls_tbtcp INDEX 1.
      ENDIF.

      IF sy-subrc <> 0 OR ls_tbtcp-listident = 0.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'spool'
                                iv_text = |job { lv_jobname } produced no spool output| ).
        rv_rc = 4.
        RETURN.
      ENDIF.

      lv_spool_id = ls_tbtcp-listident.
      lv_step = ls_tbtcp-stepcount.
    ELSE.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'args'
                              iv_text = 'give spool_id, or jobname (and optionally step)' ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    lv_first_s = zcl_zmcp_fluid_rt=>s( 'first_line' ).
    IF lv_first_s IS INITIAL.
      lv_first = 1.
    ELSE.
      lv_first = int_of( lv_first_s ).
    ENDIF.
    lv_last_s = zcl_zmcp_fluid_rt=>s( 'last_line' ).
    lv_max_s = zcl_zmcp_fluid_rt=>s( 'max_lines' ).
    IF lv_max_s IS INITIAL.
      lv_max = 1000.
    ELSE.
      lv_max = int_of( lv_max_s ).
    ENDIF.

    IF lv_last_s IS NOT INITIAL.
      lv_last = int_of( lv_last_s ).
      CALL FUNCTION 'RSPO_RETURN_ABAP_SPOOLJOB'
        EXPORTING
          rqident              = lv_spool_id
          first_line           = lv_first
          last_line            = lv_last
        TABLES
          buffer               = lt_buffer
        EXCEPTIONS
          no_such_job          = 1
          not_abap_list        = 2
          job_contains_no_data = 3
          selection_empty      = 4
          no_permission        = 5
          can_not_access       = 6
          read_error           = 7
          OTHERS               = 8.
    ELSE.
      CALL FUNCTION 'RSPO_RETURN_ABAP_SPOOLJOB'
        EXPORTING
          rqident              = lv_spool_id
          first_line           = lv_first
        TABLES
          buffer               = lt_buffer
        EXCEPTIONS
          no_such_job          = 1
          not_abap_list        = 2
          job_contains_no_data = 3
          selection_empty      = 4
          no_permission        = 5
          can_not_access       = 6
          read_error           = 7
          OTHERS               = 8.
    ENDIF.

    lv_subrc = sy-subrc.
    CASE lv_subrc.
      WHEN 1. lv_exc = 'NO_SUCH_JOB'.
      WHEN 2. lv_exc = 'NOT_ABAP_LIST'.
      WHEN 3. lv_exc = 'JOB_CONTAINS_NO_DATA'.
      WHEN 4. lv_exc = 'SELECTION_EMPTY'.
      WHEN 5. lv_exc = 'NO_PERMISSION'.
      WHEN 6. lv_exc = 'CAN_NOT_ACCESS'.
      WHEN 7. lv_exc = 'READ_ERROR'.
      WHEN OTHERS. lv_exc = 'OTHERS'.
    ENDCASE.

    CASE lv_subrc.
      WHEN 0.
        " ok
      WHEN 3 OR 4.
        CLEAR lt_buffer.
      WHEN OTHERS.
        fm_fail( iv_step = 'spool' iv_fm = 'RSPO_RETURN_ABAP_SPOOLJOB' iv_subrc = lv_subrc iv_exc = lv_exc ).
        rv_rc = 8.
        RETURN.
    ENDCASE.

    IF lv_max > 0 AND lines( lt_buffer ) > lv_max.
      lv_truncated = abap_true.
      lv_del_from = lv_max + 1.
      DELETE lt_buffer FROM lv_del_from.
    ENDIF.

    LOOP AT lt_buffer INTO DATA(ls_buffer).
      lv_len = strlen( ls_buffer ).
      lv_line = substring( val = ls_buffer len = lv_len ).
      IF lv_lines IS NOT INITIAL.
        lv_lines = |{ lv_lines },|.
      ENDIF.
      lv_lines = |{ lv_lines }{ js( lv_line ) }|.
    ENDLOOP.

    zcl_zmcp_fluid_rt=>out(
      |\{"spool_id":{ js( |{ lv_spool_id }| ) },| &&
      |"jobname":{ js( lv_jobname ) },"jobcount":{ js( lv_jobcount ) },| &&
      |"step":{ js( |{ lv_step }| ) },| &&
      |"line_count":{ lines( lt_buffer ) },"truncated":{ bool( lv_truncated ) },"lines":[{ lv_lines }]\}| ).
  ENDMETHOD.

  METHOD do_schedule.
    DATA lv_jobname   TYPE tbtco-jobname.
    DATA lv_program   TYPE trdir-name.
    DATA lv_variant   TYPE raldb_vari.
    DATA lv_subc      TYPE trdir-subc.
    DATA lv_start_date TYPE string.
    DATA lv_start_time TYPE string.
    DATA lv_job_class TYPE tbtco-jobclass.
    DATA lv_hold      TYPE abap_bool.
    DATA lv_jobcount  TYPE tbtco-jobcount.
    DATA lv_sdlstrtdt TYPE tbtco-sdlstrtdt.
    DATA lv_sdlstrttm TYPE tbtco-sdlstrttm.
    DATA lv_status    TYPE tbtco-status.
    DATA lv_start_mode TYPE string.
    DATA lv_step_number TYPE tbtcjob-stepcount.
    DATA lv_released  TYPE btcchar1.
    DATA lv_subrc TYPE i.
    DATA lv_exc TYPE string.

    rv_rc = 0.
    lv_jobname = zcl_zmcp_fluid_rt=>s( 'jobname' ).
    IF lv_jobname IS INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'jobname'
                              iv_text = 'jobname is required' ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    lv_program = zcl_zmcp_fluid_rt=>s( 'program' ).
    IF lv_program IS INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'program'
                              iv_text = 'program is required' ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    SELECT SINGLE subc FROM trdir INTO lv_subc WHERE name = lv_program.
    IF sy-subrc <> 0.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'program'
                              iv_text = |program { lv_program } does not exist| ).
      rv_rc = 4.
      RETURN.
    ENDIF.
    IF lv_subc <> '1'.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'program'
                              iv_text = |program { lv_program } is not an executable report (TRDIR-SUBC { lv_subc })| ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    lv_variant = zcl_zmcp_fluid_rt=>s( 'variant' ).
    IF lv_variant IS NOT INITIAL.
      SELECT SINGLE mandt FROM varid INTO @DATA(lv_dummy_mandt)
        WHERE report = @lv_program AND variant = @lv_variant.
      IF sy-subrc <> 0.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'variant'
                                iv_text = |variant { lv_variant } of { lv_program } does not exist| ).
        rv_rc = 4.
        RETURN.
      ENDIF.
    ENDIF.

    lv_start_date = zcl_zmcp_fluid_rt=>s( 'start_date' ).
    IF lv_start_date IS NOT INITIAL.
      IF strlen( lv_start_date ) <> 8 OR lv_start_date CN '0123456789'.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'start_date'
                                iv_text = |start_date { lv_start_date } is not YYYYMMDD| ).
        rv_rc = 4.
        RETURN.
      ENDIF.
    ENDIF.

    lv_start_time = zcl_zmcp_fluid_rt=>s( 'start_time' ).
    IF lv_start_time IS INITIAL.
      lv_start_time = '000000'.
    ENDIF.
    IF strlen( lv_start_time ) <> 6 OR lv_start_time CN '0123456789'.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'start_time'
                              iv_text = |start_time { lv_start_time } is not HHMMSS| ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    lv_job_class = zcl_zmcp_fluid_rt=>s( 'job_class' ).
    IF lv_job_class IS INITIAL.
      lv_job_class = 'C'.
    ENDIF.
    lv_hold = zcl_zmcp_fluid_rt=>b( 'hold' ).

    CALL FUNCTION 'JOB_OPEN'
      EXPORTING
        jobname          = lv_jobname
        jobclass         = lv_job_class
      IMPORTING
        jobcount         = lv_jobcount
      EXCEPTIONS
        cant_create_job  = 1
        invalid_job_data = 2
        jobname_missing  = 3
        OTHERS           = 4.
    lv_subrc = sy-subrc.
    IF lv_subrc <> 0.
      CASE lv_subrc.
        WHEN 1. lv_exc = 'CANT_CREATE_JOB'.
        WHEN 2. lv_exc = 'INVALID_JOB_DATA'.
        WHEN 3. lv_exc = 'JOBNAME_MISSING'.
        WHEN OTHERS. lv_exc = 'OTHERS'.
      ENDCASE.
      fm_fail( iv_step = 'job_open' iv_fm = 'JOB_OPEN' iv_subrc = lv_subrc iv_exc = lv_exc ).
      rv_rc = 8.
      RETURN.
    ENDIF.

    " The step always runs under the calling (technical) user. COMMANDNAME,
    " OPERATINGSYSTEM and the EXTPGM_* parameters are deliberately never set,
    " so the step submitted here can only ever be the ABAP report checked
    " above via TRDIR-SUBC - never an OS command or an external program.
    CALL FUNCTION 'JOB_SUBMIT'
      EXPORTING
        authcknam        = sy-uname
        jobcount         = lv_jobcount
        jobname          = lv_jobname
        report           = lv_program
        variant          = lv_variant
        language         = sy-langu
      IMPORTING
        step_number      = lv_step_number
      EXCEPTIONS
        bad_priparams           = 1
        bad_xpgflags            = 2
        invalid_jobdata         = 3
        jobname_missing         = 4
        job_notex               = 5
        job_submit_failed       = 6
        lock_failed             = 7
        program_missing         = 8
        prog_abap_and_extpg_set = 9
        OTHERS                  = 10.
    lv_subrc = sy-subrc.
    IF lv_subrc <> 0.
      CASE lv_subrc.
        WHEN 1. lv_exc = 'BAD_PRIPARAMS'.
        WHEN 2. lv_exc = 'BAD_XPGFLAGS'.
        WHEN 3. lv_exc = 'INVALID_JOBDATA'.
        WHEN 4. lv_exc = 'JOBNAME_MISSING'.
        WHEN 5. lv_exc = 'JOB_NOTEX'.
        WHEN 6. lv_exc = 'JOB_SUBMIT_FAILED'.
        WHEN 7. lv_exc = 'LOCK_FAILED'.
        WHEN 8. lv_exc = 'PROGRAM_MISSING'.
        WHEN 9. lv_exc = 'PROG_ABAP_AND_EXTPG_SET'.
        WHEN OTHERS. lv_exc = 'OTHERS'.
      ENDCASE.
      fm_fail( iv_step = 'job_submit' iv_fm = 'JOB_SUBMIT' iv_subrc = lv_subrc iv_exc = lv_exc ).
      rv_rc = 8.
      RETURN.
    ENDIF.

    IF lv_start_date IS NOT INITIAL.
      lv_sdlstrtdt = lv_start_date.
      lv_sdlstrttm = lv_start_time.
      CALL FUNCTION 'JOB_CLOSE'
        EXPORTING
          jobcount             = lv_jobcount
          jobname               = lv_jobname
          sdlstrtdt             = lv_sdlstrtdt
          sdlstrttm             = lv_sdlstrttm
          dont_release          = COND #( WHEN lv_hold = abap_true THEN 'X' ELSE space )
        IMPORTING
          job_was_released      = lv_released
        EXCEPTIONS
          cant_start_immediate = 1
          invalid_startdate    = 2
          jobname_missing      = 3
          job_close_failed     = 4
          job_nosteps          = 5
          job_notex            = 6
          lock_failed          = 7
          invalid_target       = 8
          invalid_time_zone    = 9
          OTHERS               = 10.
    ELSE.
      CALL FUNCTION 'JOB_CLOSE'
        EXPORTING
          jobcount             = lv_jobcount
          jobname               = lv_jobname
          strtimmed             = 'X'
          dont_release          = COND #( WHEN lv_hold = abap_true THEN 'X' ELSE space )
        IMPORTING
          job_was_released      = lv_released
        EXCEPTIONS
          cant_start_immediate = 1
          invalid_startdate    = 2
          jobname_missing      = 3
          job_close_failed     = 4
          job_nosteps          = 5
          job_notex            = 6
          lock_failed          = 7
          invalid_target       = 8
          invalid_time_zone    = 9
          OTHERS               = 10.
    ENDIF.
    lv_subrc = sy-subrc.
    IF lv_subrc <> 0.
      CASE lv_subrc.
        WHEN 1. lv_exc = 'CANT_START_IMMEDIATE'.
        WHEN 2. lv_exc = 'INVALID_STARTDATE'.
        WHEN 3. lv_exc = 'JOBNAME_MISSING'.
        WHEN 4. lv_exc = 'JOB_CLOSE_FAILED'.
        WHEN 5. lv_exc = 'JOB_NOSTEPS'.
        WHEN 6. lv_exc = 'JOB_NOTEX'.
        WHEN 7. lv_exc = 'LOCK_FAILED'.
        WHEN 8. lv_exc = 'INVALID_TARGET'.
        WHEN 9. lv_exc = 'INVALID_TIME_ZONE'.
        WHEN OTHERS. lv_exc = 'OTHERS'.
      ENDCASE.
      fm_fail( iv_step = 'job_close' iv_fm = 'JOB_CLOSE' iv_subrc = lv_subrc iv_exc = lv_exc ).
      rv_rc = 8.
      RETURN.
    ENDIF.

    SELECT SINGLE status FROM tbtco INTO lv_status
      WHERE authckman = sy-mandt AND jobname = lv_jobname AND jobcount = lv_jobcount.

    IF lv_hold = abap_true.
      lv_start_mode = 'hold'.
    ELSEIF lv_start_date IS NOT INITIAL.
      lv_start_mode = 'scheduled'.
    ELSE.
      lv_start_mode = 'immediate'.
    ENDIF.

    zcl_zmcp_fluid_rt=>out(
      |\{"jobname":{ js( lv_jobname ) },"jobcount":{ js( lv_jobcount ) },| &&
      |"program":{ js( lv_program ) },"variant":{ js( lv_variant ) },| &&
      |"job_class":{ js( lv_job_class ) },"released":{ bool( xsdbool( lv_released = 'X' ) ) },| &&
      |"status":{ js( lv_status ) },"status_text":{ js( status_text( lv_status ) ) },| &&
      |"step_number":{ lv_step_number },"start_mode":{ js( lv_start_mode ) },| &&
      |"start_date":{ js( lv_start_date ) },"start_time":{ js( lv_start_time ) },| &&
      |"exec_user":{ js( sy-uname ) }\}| ).
  ENDMETHOD.

  METHOD do_cancel.
    DATA lv_jobname    TYPE tbtco-jobname.
    DATA lv_jobcount   TYPE tbtco-jobcount.
    DATA lv_any_owner  TYPE abap_bool.
    DATA lv_status     TYPE tbtco-status.
    DATA lv_sdluname   TYPE tbtco-sdluname.
    DATA lv_authcknam  TYPE tbtco-authcknam.
    DATA lv_mode       TYPE string.
    DATA lv_subrc      TYPE i.
    DATA lv_exc        TYPE string.

    rv_rc = 0.
    lv_jobname  = zcl_zmcp_fluid_rt=>s( 'jobname' ).
    lv_jobcount = zcl_zmcp_fluid_rt=>s( 'jobcount' ).
    IF lv_jobname IS INITIAL OR lv_jobcount IS INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'args'
                              iv_text = 'jobname and jobcount are required' ).
      rv_rc = 4.
      RETURN.
    ENDIF.
    lv_any_owner = zcl_zmcp_fluid_rt=>b( 'any_owner' ).

    SELECT SINGLE status sdluname authcknam FROM tbtco
      INTO (lv_status, lv_sdluname, lv_authcknam)
      WHERE authckman = sy-mandt AND jobname = lv_jobname AND jobcount = lv_jobcount.
    IF sy-subrc <> 0.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'job'
                              iv_text = |job { lv_jobname } { lv_jobcount } not found in client { sy-mandt }| ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    IF lv_any_owner = abap_false AND lv_sdluname <> sy-uname AND lv_authcknam <> sy-uname.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'owner'
                              iv_text = |job { lv_jobname } { lv_jobcount } was scheduled by { lv_sdluname }, | &&
                                        |not { sy-uname }; pass any_owner to override| ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    IF lv_status = 'R'.
      lv_mode = 'abort'.
      CALL FUNCTION 'BP_JOB_ABORT'
        EXPORTING
          jobcount                  = lv_jobcount
          jobname                   = lv_jobname
        EXCEPTIONS
          checking_of_job_has_failed = 1
          job_abort_has_failed       = 2
          job_does_not_exist         = 3
          job_is_not_active          = 4
          no_abort_privilege_given   = 5
          OTHERS                     = 6.
      lv_subrc = sy-subrc.
      IF lv_subrc <> 0.
        CASE lv_subrc.
          WHEN 1. lv_exc = 'CHECKING_OF_JOB_HAS_FAILED'.
          WHEN 2. lv_exc = 'JOB_ABORT_HAS_FAILED'.
          WHEN 3. lv_exc = 'JOB_DOES_NOT_EXIST'.
          WHEN 4. lv_exc = 'JOB_IS_NOT_ACTIVE'.
          WHEN 5. lv_exc = 'NO_ABORT_PRIVILEGE_GIVEN'.
          WHEN OTHERS. lv_exc = 'OTHERS'.
        ENDCASE.
        fm_fail( iv_step = 'cancel' iv_fm = 'BP_JOB_ABORT' iv_subrc = lv_subrc iv_exc = lv_exc ).
        rv_rc = 8.
        RETURN.
      ENDIF.
    ELSEIF lv_status = 'P' OR lv_status = 'S' OR lv_status = 'Y' OR lv_status = 'Z'.
      lv_mode = 'delete'.
      " commitmode space, not the function module's own default 'X': the
      " fluid runtime itself commits on success and rolls back on error, so
      " this call must not commit or roll back on its own.
      CALL FUNCTION 'BP_JOB_DELETE'
        EXPORTING
          jobcount                       = lv_jobcount
          jobname                        = lv_jobname
          commitmode                     = space
        EXCEPTIONS
          cant_delete_event_entry        = 1
          cant_delete_job                = 2
          cant_delete_joblog             = 3
          cant_delete_steps              = 4
          cant_delete_time_entry         = 5
          cant_derelease_successor       = 6
          cant_enq_predecessor           = 7
          cant_enq_successor             = 8
          cant_enq_tbtco_entry           = 9
          cant_update_predecessor        = 10
          cant_update_successor          = 11
          commit_failed                  = 12
          jobcount_missing               = 13
          jobname_missing                = 14
          job_does_not_exist             = 15
          job_is_already_running         = 16
          no_delete_authority            = 17
          OTHERS                         = 18.
      lv_subrc = sy-subrc.
      IF lv_subrc <> 0.
        CASE lv_subrc.
          WHEN 1. lv_exc = 'CANT_DELETE_EVENT_ENTRY'.
          WHEN 2. lv_exc = 'CANT_DELETE_JOB'.
          WHEN 3. lv_exc = 'CANT_DELETE_JOBLOG'.
          WHEN 4. lv_exc = 'CANT_DELETE_STEPS'.
          WHEN 5. lv_exc = 'CANT_DELETE_TIME_ENTRY'.
          WHEN 6. lv_exc = 'CANT_DERELEASE_SUCCESSOR'.
          WHEN 7. lv_exc = 'CANT_ENQ_PREDECESSOR'.
          WHEN 8. lv_exc = 'CANT_ENQ_SUCCESSOR'.
          WHEN 9. lv_exc = 'CANT_ENQ_TBTCO_ENTRY'.
          WHEN 10. lv_exc = 'CANT_UPDATE_PREDECESSOR'.
          WHEN 11. lv_exc = 'CANT_UPDATE_SUCCESSOR'.
          WHEN 12. lv_exc = 'COMMIT_FAILED'.
          WHEN 13. lv_exc = 'JOBCOUNT_MISSING'.
          WHEN 14. lv_exc = 'JOBNAME_MISSING'.
          WHEN 15. lv_exc = 'JOB_DOES_NOT_EXIST'.
          WHEN 16. lv_exc = 'JOB_IS_ALREADY_RUNNING'.
          WHEN 17. lv_exc = 'NO_DELETE_AUTHORITY'.
          WHEN OTHERS. lv_exc = 'OTHERS'.
        ENDCASE.
        fm_fail( iv_step = 'cancel' iv_fm = 'BP_JOB_DELETE' iv_subrc = lv_subrc iv_exc = lv_exc ).
        rv_rc = 8.
        RETURN.
      ENDIF.
    ELSE.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'status'
                              iv_text = |job { lv_jobname } { lv_jobcount } is { status_text( lv_status ) }; | &&
                                        |there is nothing to cancel| ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    zcl_zmcp_fluid_rt=>out(
      |\{"jobname":{ js( lv_jobname ) },"jobcount":{ js( lv_jobcount ) },| &&
      |"mode":{ js( lv_mode ) },"cancelled":true,| &&
      |"status_before":{ js( lv_status ) },"status_before_text":{ js( status_text( lv_status ) ) },| &&
      |"scheduled_by":{ js( lv_sdluname ) }\}| ).
  ENDMETHOD.

ENDCLASS.
