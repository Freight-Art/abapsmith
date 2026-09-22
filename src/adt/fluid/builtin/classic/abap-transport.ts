import type { ClassicAbapPart } from "./abap-core.js";

/**
 * Ports `transportEntryRemoveFragment` (`src/adt/transport-entry-remove.ts`).
 *
 * `lv_trkorr` (the `trkorr` argument) is read once via `s( 'trkorr' )` and
 * then only ever consumed, never reassigned — the old fragment's `lv_trkorr`
 * was reused as the mutable `LOOP AT lt_candidates INTO lv_trkorr` cursor,
 * which cannot share a name with a value bound by inline `DATA(...)`. That
 * cursor is `lv_cursor` here; behaviour is unchanged, only the local name.
 *
 * `remove_transport_entry` step 4 no longer refuses when the holder's E071
 * rows for the object hold 2+ rows sharing pgmid+object+obj_name (issue
 * #184: legal, since E071's key is TRKORR+AS4POS, not object identity —
 * SAP's own DDIC delete recording can append such a row). It collapses each
 * such group to the row with the lowest AS4POS, deleting the surplus E071
 * rows directly and reporting each collapsed group via a
 * `ZMCP-TREN-DEDUP` line, before calling `TR_DELETE_COMM_OBJECT_KEYS` on
 * what remains.
 *
 * `read_transport_log`, `read_import_queue` and `create_transport_of_copies`
 * (issue #88, "Transport landscape support") were added the same way: no raw
 * ADT call exists for any of the three (see the "why not ADT" comments on
 * their TypeScript wrappers, `src/adt/transport-log.ts` /
 * `transport-queue.ts` / `transport-copies.ts`), so all three go through
 * this classic bridge's `TRINT_GET_LOG_OVERVIEW`/`TRINT_GET_LOG_FILE`,
 * `TMS_MGR_READ_TRANSPORT_QUEUE` and `TR_INSERT_REQUEST_WITH_TASKS` calls,
 * live-verified on A4H client 001 on 2026-09-15 — see each method's own
 * comments for what was actually observed.
 */
export const transportPart: ClassicAbapPart = {
  methods: ["remove_transport_entry", "read_transport_log", "read_import_queue", "create_transport_of_copies"],
  source: `  METHOD remove_transport_entry.
    DATA lv_trkorr TYPE trkorr.
    lv_trkorr = s( 'trkorr' ).
    DATA lv_object TYPE e071-obj_name.
    lv_object = s( 'object_name' ).
    DATA: ls_req        TYPE trwbo_request,
          ls_e071       TYPE e071,
          lt_rows       TYPE STANDARD TABLE OF e071 WITH EMPTY KEY,
          lt_candidates TYPE STANDARD TABLE OF trkorr WITH EMPTY KEY,
          lt_tasks      TYPE STANDARD TABLE OF trkorr WITH EMPTY KEY,
          lv_cursor     TYPE trkorr,
          lv_holder     TYPE trkorr,
          lv_check      TYPE trkorr,
          lv_subrc      TYPE sy-subrc,
          ls_msg        TYPE symsg,
          lv_msgtext    TYPE string,
          lv_readerr    TYPE string,
          ls_other      TYPE e071,
          lv_n          TYPE i,
          lv_positions  TYPE string,
          lt_surplus    TYPE STANDARD TABLE OF e071 WITH EMPTY KEY,
          ls_surplus    TYPE e071,
          lv_key        TYPE string,
          lv_prev_key   TYPE string.

    " Step 1: resolve which of trkorr or its tasks holds the entry.
    APPEND lv_trkorr TO lt_candidates.
    SELECT trkorr FROM e070 INTO TABLE @lt_tasks WHERE strkorr = @lv_trkorr.
    APPEND LINES OF lt_tasks TO lt_candidates.
    CLEAR lv_holder.
    LOOP AT lt_candidates INTO lv_cursor.
      CLEAR ls_req.
      ls_req-h-trkorr = lv_cursor.
      CALL FUNCTION 'TRINT_READ_REQUEST'
        EXPORTING iv_read_e070 = 'X' iv_read_e07t = 'X' iv_read_e070c = 'X' iv_read_e070m = 'X'
                  iv_read_objs_keys = 'X' iv_read_attributes = 'X'
        CHANGING  cs_request = ls_req
        EXCEPTIONS OTHERS = 1.
      lv_subrc = sy-subrc.
      MOVE-CORRESPONDING sy TO ls_msg.
      IF lv_subrc <> 0.
        lv_readerr = |{ lv_cursor } sy-subrc={ lv_subrc } msg={ ls_msg-msgty } { ls_msg-msgid } { ls_msg-msgno } v1={ ls_msg-msgv1 } v2={ ls_msg-msgv2 } v3={ ls_msg-msgv3 } v4={ ls_msg-msgv4 }|.
        CONTINUE.
      ENDIF.
      CLEAR lt_rows.
      LOOP AT ls_req-objects INTO ls_e071 WHERE obj_name = lv_object.
        APPEND ls_e071 TO lt_rows.
      ENDLOOP.
      IF lines( lt_rows ) > 0.
        lv_holder = lv_cursor.
        EXIT.
      ENDIF.
    ENDLOOP.

    " Step 2: refuse if no candidate carried the entry.
    IF lv_holder IS INITIAL.
      IF lv_readerr IS INITIAL.
        fail( |no entry for { lv_object } on { lv_trkorr } or its tasks| ).
      ELSE.
        fail( |no entry for { lv_object } on { lv_trkorr } or its tasks; last TRINT_READ_REQUEST failure: { lv_readerr }| ).
      ENDIF.
      RETURN.
    ENDIF.

    " Step 3: name the resolved holder.
    line( |ZMCP-TREN-HOLDER { lv_holder }| ).

    " Step 4: 2+ E071 rows can share pgmid+object+obj_name (E071's key is
    " TRKORR+AS4POS, so this is legal) — collapse each such group to the row
    " with the lowest AS4POS. Surplus rows are collected here, into a table
    " lt_rows is not being read from, and only deleted afterwards.
    SORT lt_rows BY pgmid object obj_name as4pos.
    CLEAR lv_prev_key.
    LOOP AT lt_rows INTO ls_e071.
      lv_key = |{ ls_e071-pgmid }/{ ls_e071-object }/{ ls_e071-obj_name }|.
      IF lv_key = lv_prev_key.
        CONTINUE.
      ENDIF.
      lv_prev_key = lv_key.
      lv_n = 0.
      CLEAR lv_positions.
      LOOP AT lt_rows INTO ls_other WHERE pgmid = ls_e071-pgmid AND object = ls_e071-object
                                      AND obj_name = ls_e071-obj_name.
        lv_n = lv_n + 1.
        IF lv_positions IS INITIAL.
          lv_positions = |{ ls_other-as4pos }|.
        ELSE.
          lv_positions = |{ lv_positions },{ ls_other-as4pos }|.
        ENDIF.
        IF ls_other-as4pos <> ls_e071-as4pos.
          APPEND ls_other TO lt_surplus.
        ENDIF.
      ENDLOOP.
      IF lv_n >= 2.
        line( |ZMCP-TREN-DEDUP { ls_e071-pgmid } { ls_e071-object } { ls_e071-obj_name } { lv_n } AS4POS { lv_positions }| ).
      ENDIF.
    ENDLOOP.

    LOOP AT lt_surplus INTO ls_surplus.
      DELETE FROM e071 WHERE trkorr = @lv_holder AND as4pos = @ls_surplus-as4pos.
      lv_subrc = sy-subrc.
      IF lv_subrc <> 0.
        ROLLBACK WORK.
        fail( |could not collapse duplicate E071 row { ls_surplus-pgmid } { ls_surplus-object } { ls_surplus-obj_name } at AS4POS { ls_surplus-as4pos } on { lv_holder }, sy-subrc={ lv_subrc }| ).
        RETURN.
      ENDIF.
      " E071K is keyed by TRKORR+PGMID+OBJECT+OBJNAME+its own AS4POS, not by the
      " E071 position, and the surviving E071 row still covers the object's key
      " rows; TR_DELETE_COMM_OBJECT_KEYS drops them with that row in step 5.
      DELETE ls_req-objects WHERE as4pos = ls_surplus-as4pos.
      DELETE lt_rows WHERE as4pos = ls_surplus-as4pos.
    ENDLOOP.

    " Step 5: remove every remaining (unique) row.
    LOOP AT lt_rows INTO ls_e071.
      CALL FUNCTION 'TR_DELETE_COMM_OBJECT_KEYS'
        EXPORTING iv_dialog_flag = space is_e071_delete = ls_e071
        CHANGING cs_request = ls_req
        EXCEPTIONS OTHERS = 1.
      lv_subrc = sy-subrc.
      MOVE-CORRESPONDING sy TO ls_msg.
      IF lv_subrc <> 0.
        lv_msgtext = |{ ls_msg-msgty } { ls_msg-msgid } { ls_msg-msgno } v1={ ls_msg-msgv1 } v2={ ls_msg-msgv2 } v3={ ls_msg-msgv3 } v4={ ls_msg-msgv4 }|.
        IF lt_surplus IS NOT INITIAL.
          ROLLBACK WORK.
        ENDIF.
        fail( |TR_DELETE_COMM_OBJECT_KEYS failed for { ls_e071-pgmid } { ls_e071-object } { ls_e071-obj_name }, sy-subrc={ lv_subrc }, msg={ lv_msgtext }| ).
        RETURN.
      ENDIF.
      line( |ZMCP-TREN-ROW { ls_e071-pgmid } { ls_e071-object } { ls_e071-obj_name }| ).
    ENDLOOP.

    " Step 6: one success tag for the whole batch.
    line( 'TREN-REMOVED' ).

    " Step 7: commit.
    COMMIT WORK AND WAIT.

    " Step 8: prove absence.
    SELECT SINGLE trkorr FROM e071 INTO @lv_check WHERE trkorr = @lv_holder AND obj_name = @lv_object.
    IF sy-subrc = 0.
      fail( |removal of { lv_object } reported no error but a row is still there| ).
      RETURN.
    ENDIF.
    line( 'TREN-GONE' ).
  ENDMETHOD.

  METHOD read_transport_log.
    DATA lv_trkorr TYPE trkorr.
    lv_trkorr = s( 'trkorr' ).
    DATA: ls_e070          TYPE e070,
          lt_ovw           TYPE scts_log_overviews,
          ls_ovw           TYPE scts_log_overview,
          lt_log           TYPE trlogs,
          ls_log           TYPE trlog,
          lv_i             TYPE i,
          lv_sev           TYPE string,
          lv_cls           TYPE string,
          lv_num           TYPE string,
          lv_rc            TYPE string,
          lv_with_targets  TYPE flag VALUE 'X',
          lv_logsys        TYPE tmssysnam.

    " Step 1: TRINT_GET_LOG_OVERVIEW answers with sy-subrc 0 even for a
    " request number that does not exist at all - proven live 2026-09-15 on
    " A4H with A4HK999999, which came back with the SAME "not yet flagged
    " for import" row a real, un-imported request gets. Without checking
    " E070 first, a typo'd request number would silently produce a
    " confident but meaningless answer instead of a refusal.
    SELECT SINGLE * FROM e070 INTO @ls_e070 WHERE trkorr = @lv_trkorr.
    IF sy-subrc <> 0.
      fail( |no such request { lv_trkorr }| ).
      RETURN.
    ENDIF.

    " Step 2.
    line( |ZMCP-TRLG-REQ { lv_trkorr } { ls_e070-trfunction } { ls_e070-trstatus }| ).

    " Step 3: one row per system this request was, or will be, imported to.
    " IV_WITH_TRANSPORT_TARGETS is carried in a typed FLAG local (its own
    " default is already 'X') rather than the bare literal 'X' - this
    " method never dumped live, but every actual in this class is a typed
    " local under one uniform rule, so this one follows suit too.
    CALL FUNCTION 'TRINT_GET_LOG_OVERVIEW'
      EXPORTING
        iv_request                = lv_trkorr
        iv_with_transport_targets = lv_with_targets
      IMPORTING
        et_log_overview           = lt_ovw.

    LOOP AT lt_ovw INTO ls_ovw.
      " A row with no SYSNAM names nothing to read a log for.
      IF ls_ovw-sysnam IS INITIAL.
        CONTINUE.
      ENDIF.
      lv_i = lv_i + 1.
      " Live on A4H 2026-09-15: every overview row came back with RC EMPTY
      " ("not yet flagged for import"), so a raw { ls_ovw-rc } would leave
      " two consecutive spaces in the fixed-token line below and drop a
      " token the TS regex requires - same "-" placeholder fix as
      " SEVERITY/CLASS/NUMBER below.
      IF ls_ovw-rc IS INITIAL.
        lv_rc = '-'.
      ELSE.
        lv_rc = ls_ovw-rc.
      ENDIF.
      " Fixed-token line: only space-free fields. SYSTXT/RCTXT carry free
      " text that can itself contain spaces, so each gets its own trailing-
      " text line instead of a slot on this one. DATE/TIME = RAW: a plain
      " { ls_ovw-moddate }/{ ls_ovw-modtime } embed is converted to the
      " CURRENT USER's date/time format (e.g. "15.09.2026", "10:37:44"),
      " not the wire form "20260915"/"103744" the TS side parses - the
      " wire protocol must not depend on whose user profile is running.
      line( |ZMCP-TRLG-SYS { lv_i } { ls_ovw-sysnam } { lv_rc } | &&
            |{ ls_ovw-moddate DATE = RAW } { ls_ovw-modtime TIME = RAW } { ls_ovw-sortidx }| ).
      line( |ZMCP-TRLG-SYSTXT { lv_i } { ls_ovw-systxt }| ).
      line( |ZMCP-TRLG-RCTXT { lv_i } { ls_ovw-rctxt }| ).

      " Step 4: TRINT_GET_LOG_FILE has already fetched every log line this
      " system returned into lt_log before this LOOP ever runs, so every
      " line is emitted here - no cap. compact.ts is the single layer that
      " discloses truncation; capping here would only destroy rows a step
      " before the layer that would have reported the cut.
      CLEAR lt_log.
      " IV_SYSTEM is TMSSYSNAM on this FM's own signature - carried in
      " lv_logsys rather than passing ls_ovw-sysnam straight through, so
      " every CALL FUNCTION actual in this class is a local typed with the
      " FM's own parameter type, not a struct field of unverified type.
      lv_logsys = ls_ovw-sysnam.
      CALL FUNCTION 'TRINT_GET_LOG_FILE'
        EXPORTING
          iv_request  = lv_trkorr
          iv_system   = lv_logsys
        IMPORTING
          et_log_file = lt_log.

      LOOP AT lt_log INTO ls_log.
        " SEVERITY/CLASS/NUMBER are space-free; LINE is the trailing free
        " text. A "-" placeholder stands in for an initial SEVERITY or
        " CLASS so the token count never varies - the TS regex depends on
        " always finding the same number of tokens before the free text.
        IF ls_log-severity IS INITIAL.
          lv_sev = '-'.
        ELSE.
          lv_sev = ls_log-severity.
        ENDIF.
        IF ls_log-class IS INITIAL.
          lv_cls = '-'.
        ELSE.
          lv_cls = ls_log-class.
        ENDIF.
        IF ls_log-number IS INITIAL.
          lv_num = '-'.
        ELSE.
          lv_num = ls_log-number.
        ENDIF.
        line( |ZMCP-TRLG-LINE { lv_i } { lv_sev } { lv_cls } { lv_num } { ls_log-line }| ).
      ENDLOOP.
    ENDLOOP.

    " Step 5: read-only throughout - no COMMIT, no ROLLBACK.
    line( |ZMCP-TRLG-COUNT { lv_i }| ).
    line( 'TRLG-READ' ).
  ENDMETHOD.

  METHOD read_import_queue.
    DATA: lv_system TYPE tmscsys-sysnam,
          lv_domain TYPE tmscsys-domnam.
    lv_system = s( 'system' ).
    TRANSLATE lv_system TO UPPER CASE.
    lv_domain = s( 'domain' ).
    TRANSLATE lv_domain TO UPPER CASE.

    " Step 1.
    IF lv_system IS INITIAL.
      fail( |system is required| ).
      RETURN.
    ENDIF.

    DATA: lt_buf       TYPE STANDARD TABLE OF tmsbuffer WITH EMPTY KEY,
          ls_buf       TYPE tmsbuffer,
          lv_date      TYPE sy-datum,
          lv_time      TYPE sy-uzeit,
          lv_flag      TYPE stms_flag,
          lv_off       TYPE stms_flag,
          ls_exception TYPE stmscalert,
          lv_subrc     TYPE sy-subrc,
          lv_domout    TYPE string,
          lv_flagout   TYPE string,
          lv_bufpos    TYPE string,
          lv_rowtrkorr TYPE string,
          lv_impflg    TYPE string,
          lv_maxrc     TYPE string,
          lv_trfunc    TYPE string,
          lv_owner     TYPE string,
          lv_tarcli    TYPE string.

    " Step 2: IV_CLEAR_LOCKS, IV_UPDATE_CACHE and IV_MONITOR all default to
    " 'X' in this FM's OWN signature and are not reads - clearing TMS locks
    " and rewriting the TMS cache are side effects an operation documented
    " as read-only must not perform, so all six are forced to SPACE here.
    " LV_OFF is declared TYPE stms_flag and never assigned, so its initial
    " value (SPACE) is what travels. The live hit on A4H 2026-09-15 was an
    " untyped ABAP string (from s(...)) bound to one of these typed
    " STMS_FLAG formals - exactly what CX_SY_DYN_CALL_ILLEGAL_TYPE punishes
    " in CALL FUNCTION - so every actual here, including this SPACE-valued
    " one, is a typed local under the same rule.
    CALL FUNCTION 'TMS_MGR_READ_TRANSPORT_QUEUE'
      EXPORTING
        iv_system           = lv_system
        iv_domain           = lv_domain
        iv_collect_data     = lv_off
        iv_read_locks       = lv_off
        iv_clear_locks      = lv_off
        iv_update_cache     = lv_off
        iv_monitor          = lv_off
        iv_verbose          = lv_off
      IMPORTING
        ev_collect_date     = lv_date
        ev_collect_time     = lv_time
        ev_collect_flag     = lv_flag
        es_exception        = ls_exception
      TABLES
        tt_buffer           = lt_buf
      EXCEPTIONS
        read_config_failed  = 1
        OTHERS              = 2.
    lv_subrc = sy-subrc.

    " Step 3: the live READ_CONFIG_FAILED on this box came back with an
    " EMPTY ES_EXCEPTION, so this message must still read sensibly blank.
    IF lv_subrc <> 0.
      fail( |cannot read the import queue of { lv_system }: subrc={ lv_subrc } | &&
            |msg={ sy-msgid } { sy-msgno } v1={ sy-msgv1 } | &&
            |exc-msg={ ls_exception-msgid } { ls_exception-msgno } v1={ ls_exception-msgv1 }| ).
      RETURN.
    ENDIF.

    " Step 4: a blank domain/flag is emitted as "-" so the token count
    " never varies.
    IF lv_domain IS INITIAL.
      lv_domout = '-'.
    ELSE.
      " Plain assignment (c TYPE -> string) keeps the fixed-length field's
      " trailing blanks verbatim, which would leave extra spaces inside the
      " fixed-token ZMCP-TRQU-HEAD line below; routing it through a string
      " template embed instead trims them, same as every other char-typed
      " field emitted on this line.
      lv_domout = |{ lv_domain }|.
    ENDIF.
    IF lv_flag IS INITIAL.
      lv_flagout = '-'.
    ELSE.
      lv_flagout = lv_flag.
    ENDIF.
    " DATE/TIME = RAW: see the matching comment in read_transport_log - a
    " plain { lv_date }/{ lv_time } embed is user-profile-formatted, not
    " the wire form "00000000"/"000000" the TS side checks for "never
    " collected".
    line( |ZMCP-TRQU-HEAD { lv_system } { lv_domout } { lv_date DATE = RAW } { lv_time TIME = RAW } | &&
          |{ lv_flagout } { lines( lt_buf ) }| ).

    " Step 5: one pair of lines per buffer row - TMS_MGR_READ_TRANSPORT_QUEUE
    " has already fetched every row into lt_buf before this LOOP runs, so no
    " cap here; compact.ts is the layer that discloses truncation. Every
    " space-free token that can legitimately come back initial is
    " substituted with "-" for the same fixed-token-count reason as above.
    LOOP AT lt_buf INTO ls_buf.
      IF ls_buf-bufpos IS INITIAL.
        lv_bufpos = '-'.
      ELSE.
        lv_bufpos = ls_buf-bufpos.
      ENDIF.
      IF ls_buf-trkorr IS INITIAL.
        lv_rowtrkorr = '-'.
      ELSE.
        lv_rowtrkorr = ls_buf-trkorr.
      ENDIF.
      IF ls_buf-impflg IS INITIAL.
        lv_impflg = '-'.
      ELSE.
        lv_impflg = ls_buf-impflg.
      ENDIF.
      IF ls_buf-maxrc IS INITIAL.
        lv_maxrc = '-'.
      ELSE.
        lv_maxrc = ls_buf-maxrc.
      ENDIF.
      IF ls_buf-trfunc IS INITIAL.
        lv_trfunc = '-'.
      ELSE.
        lv_trfunc = ls_buf-trfunc.
      ENDIF.
      IF ls_buf-owner IS INITIAL.
        lv_owner = '-'.
      ELSE.
        lv_owner = ls_buf-owner.
      ENDIF.
      IF ls_buf-tarcli IS INITIAL.
        lv_tarcli = '-'.
      ELSE.
        lv_tarcli = ls_buf-tarcli.
      ENDIF.
      line( |ZMCP-TRQU-ROW { lv_bufpos } { lv_rowtrkorr } { lv_impflg } { lv_maxrc } { lv_trfunc } { lv_owner } { lv_tarcli }| ).
      line( |ZMCP-TRQU-TEXT { lv_bufpos } { ls_buf-text }| ).
    ENDLOOP.

    " Step 6: read-only - no COMMIT.
    line( 'TRQU-READ' ).
  ENDMETHOD.

  METHOD create_transport_of_copies.
    DATA: lv_type        TYPE trfunction VALUE 'T',
          lv_description TYPE as4text,
          lv_owner       TYPE as4user,
          lv_target      TYPE tr_target,
          lv_devclass    TYPE devclass.
    lv_description = s( 'description' ).
    lv_target = s( 'target' ).
    TRANSLATE lv_target TO UPPER CASE.
    lv_devclass = s( 'devclass' ).
    TRANSLATE lv_devclass TO UPPER CASE.
    lv_owner = sy-uname.

    " Step 1: a transport of copies created with no target system can never
    " be imported anywhere, so abapsmith refuses to create one at all
    " rather than leaving an orphaned request behind for a human to find.
    IF lv_description IS INITIAL.
      fail( |description is required| ).
      RETURN.
    ENDIF.
    IF lv_target IS INITIAL.
      fail( |target is required - a transport of copies with no target system can never be imported| ).
      RETURN.
    ENDIF.
    IF lv_devclass IS INITIAL.
      fail( |devclass is required| ).
      RETURN.
    ENDIF.

    DATA: ls_header    TYPE trwbo_request_header,
          lt_tasks     TYPE trwbo_request_headers,
          lv_subrc     TYPE sy-subrc,
          ls_e070      TYPE e070,
          lv_tarsystem TYPE string.

    " Step 2: IT_USERS and ET_TASK_HEADERS are ORDINARY parameters on this
    " FM, not TABLES parameters - calling them with a TABLES clause
    " short-dumps with "Type conflict during a function module call" (hit
    " live 2026-09-15); neither is passed here at all, since this bridge
    " needs no extra users and reads the tasks back from ET_TASK_HEADERS.
    " Every actual below is a local typed with the FM's OWN parameter type
    " (TRFUNCTION/AS4TEXT/AS4USER/TR_TARGET/DEVCLASS), never the bare result
    " of s(...) - an inline declaration that infers string, bound straight
    " to one of these fixed-length typed formals, is what raised
    " CX_SY_DYN_CALL_ILLEGAL_TYPE live on A4H 2026-09-15.
    CALL FUNCTION 'TR_INSERT_REQUEST_WITH_TASKS'
      EXPORTING
        iv_type           = lv_type
        iv_text           = lv_description
        iv_owner          = lv_owner
        iv_target         = lv_target
        iv_devclass       = lv_devclass
      IMPORTING
        es_request_header = ls_header
        et_task_headers   = lt_tasks
      EXCEPTIONS
        insert_failed     = 1
        enqueue_failed    = 2
        OTHERS            = 3.
    lv_subrc = sy-subrc.
    IF lv_subrc <> 0.
      fail( |TR_INSERT_REQUEST_WITH_TASKS failed, sy-subrc={ lv_subrc }, | &&
            |msg={ sy-msgid } { sy-msgno } v1={ sy-msgv1 } v2={ sy-msgv2 } v3={ sy-msgv3 } v4={ sy-msgv4 }| ).
      RETURN.
    ENDIF.

    " Step 3: mirrors the type-W defect in doc/CAPABILITIES/non-object-capabilities.md
    " row 27 - a reported success with no allocated number is not a no-op,
    " it is CTS lying about what it did.
    IF ls_header-trkorr IS INITIAL.
      fail( |CTS reported success but allocated no request number| ).
      RETURN.
    ENDIF.

    " Step 4.
    COMMIT WORK AND WAIT.

    " Step 5: a tag alone is not proof - re-read E070 for the allocated
    " number to prove it is really there rather than trusting the FM's own
    " success report alone. If the re-read finds nothing, the caller still
    " learns the number that was allocated, even though the operation as a
    " whole failed.
    SELECT SINGLE * FROM e070 INTO @ls_e070 WHERE trkorr = @ls_header-trkorr.
    IF sy-subrc <> 0.
      fail( |TR_INSERT_REQUEST_WITH_TASKS allocated { ls_header-trkorr } but E070 has no row for it| ).
      RETURN.
    ENDIF.
    IF ls_e070-tarsystem IS INITIAL.
      lv_tarsystem = '-'.
    ELSE.
      lv_tarsystem = ls_e070-tarsystem.
    ENDIF.
    " Live on A4H 2026-09-15: TRFUNCTION='T', TRSTATUS='D', TARSYSTEM='A4H',
    " ZERO task headers - a transport of copies has no tasks.
    line( |ZMCP-TRTC-CREATED { ls_e070-trkorr } { ls_e070-trfunction } { ls_e070-trstatus } { lv_tarsystem } { ls_e070-as4user } { lines( lt_tasks ) }| ).

    " Step 6.
    line( 'TRTC-CREATED' ).
  ENDMETHOD.`,
};
