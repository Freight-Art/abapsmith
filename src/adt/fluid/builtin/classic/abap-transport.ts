import type { ClassicAbapPart } from "./abap-core.js";

/**
 * Ports `transportEntryRemoveFragment` (`src/adt/transport-entry-remove.ts`).
 *
 * `lv_trkorr` (the `trkorr` argument) is read once via `s( 'trkorr' )` and
 * then only ever consumed, never reassigned — the old fragment's `lv_trkorr`
 * was reused as the mutable `LOOP AT lt_candidates INTO lv_trkorr` cursor,
 * which cannot share a name with a value bound by inline `DATA(...)`. That
 * cursor is `lv_cursor` here; behaviour is unchanged, only the local name.
 */
export const transportPart: ClassicAbapPart = {
  methods: ["remove_transport_entry"],
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
          lv_positions  TYPE string.

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

    " Step 4: CTS refuses a removal when 2+ E071 rows share pgmid+object+obj_name.
    LOOP AT lt_rows INTO ls_e071.
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
      ENDLOOP.
      IF lv_n >= 2.
        fail( |duplicate E071 entries for { ls_e071-pgmid } { ls_e071-object } { ls_e071-obj_name } on { lv_holder }: { lv_n } rows at AS4POS { lv_positions }| ).
        RETURN.
      ENDIF.
    ENDLOOP.

    " Step 5: remove every collected row.
    LOOP AT lt_rows INTO ls_e071.
      CALL FUNCTION 'TR_DELETE_COMM_OBJECT_KEYS'
        EXPORTING iv_dialog_flag = space is_e071_delete = ls_e071
        CHANGING cs_request = ls_req
        EXCEPTIONS OTHERS = 1.
      lv_subrc = sy-subrc.
      MOVE-CORRESPONDING sy TO ls_msg.
      IF lv_subrc <> 0.
        lv_msgtext = |{ ls_msg-msgty } { ls_msg-msgid } { ls_msg-msgno } v1={ ls_msg-msgv1 } v2={ ls_msg-msgv2 } v3={ ls_msg-msgv3 } v4={ ls_msg-msgv4 }|.
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
  ENDMETHOD.`,
};
