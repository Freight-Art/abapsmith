/**
 * Ports `classicViewFragment` (`../../../view-create.ts`) and
 * `viewDeleteFragment` (`../../../view-delete.ts`) onto the static fluid
 * body class contract: every caller-supplied value that the old generators
 * baked in as an ABAP literal is now read at runtime via `s()`/`n()`.
 */
import type { ClassicAbapPart } from "./abap-core.js";

// lv_object stays inferred `string` (DATA(...)) — ddobjname (CHAR30) would truncate the 44-char DICT key for a view name over 26 chars.
const SOURCE = `  METHOD create_view.
    DATA lv_view TYPE dd25l-viewname.
    lv_view = s( 'view_name' ).
    DATA(lv_table) = s( 'base_table' ).
    DATA(lv_desc) = s( 'description' ).
    DATA lv_package TYPE devclass.
    lv_package = s( 'package_name' ).
    DATA(lv_corr) = s( 'corr_nr' ).
    DATA(lv_local) = boolc( to_upper( lv_package ) CP '$*' ).
    DATA(lv_object) = |VIEW{ lv_view WIDTH = 40 ALIGN = LEFT }|.

    DATA ls_dd25v TYPE dd25v.
    DATA ls_dd26v TYPE dd26v.
    DATA lt_dd26v TYPE STANDARD TABLE OF dd26v.
    DATA ls_dd27p TYPE dd27p.
    DATA lt_dd27p TYPE STANDARD TABLE OF dd27p.
    DATA lv_rc TYPE sy-subrc.
    DATA lv_n TYPE i.
    DATA lv_i TYPE i.
    DATA lv_field TYPE string.
    DATA lv_korrnum TYPE trkorr.

    IF lv_local = abap_true.
      lv_korrnum = space.
    ELSE.
      lv_korrnum = lv_corr.
    ENDIF.

    CALL FUNCTION 'RS_CORR_INSERT'
      EXPORTING object = lv_object
                object_class = 'DICT'
                devclass = lv_package
                master_language = sy-langu
                mode = 'INSERT'
                global_lock = 'X'
                korrnum = lv_korrnum
                suppress_dialog = 'X'
      EXCEPTIONS cancelled = 1 permission_failure = 2 unknown_objectclass = 3 OTHERS = 4.
    IF sy-subrc <> 0.
      fail( |RS_CORR_INSERT failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
      RETURN.
    ENDIF.
    line( 'VIEW-REGISTERED' ).

    CLEAR ls_dd25v.
    ls_dd25v-viewname   = lv_view.
    ls_dd25v-aggtype    = 'V'.
    ls_dd25v-roottab    = lv_table.
    ls_dd25v-viewclass  = 'D'.
    ls_dd25v-viewgrant  = 'R'.
    ls_dd25v-ddlanguage = sy-langu.
    ls_dd25v-ddtext     = lv_desc.

    CLEAR lt_dd26v.
    CLEAR ls_dd26v.
    ls_dd26v-viewname = lv_view.
    ls_dd26v-tabname  = lv_table.
    ls_dd26v-tabpos   = '0001'.
    APPEND ls_dd26v TO lt_dd26v.

    CLEAR lt_dd27p.
    lv_n = n( 'fields' ).
    DO lv_n TIMES.
      lv_i = sy-index.
      lv_field = s( |fields/{ lv_i - 1 }| ).
      CLEAR ls_dd27p.
      ls_dd27p-viewname  = lv_view.
      ls_dd27p-objpos    = |{ lv_i WIDTH = 4 PAD = '0' ALIGN = RIGHT }|.
      ls_dd27p-viewfield = lv_field.
      ls_dd27p-tabname   = lv_table.
      ls_dd27p-fieldname = lv_field.
      APPEND ls_dd27p TO lt_dd27p.
    ENDDO.

    CALL FUNCTION 'DDIF_VIEW_PUT'
      EXPORTING name = lv_view
                dd25v_wa = ls_dd25v
      TABLES    dd26v_tab = lt_dd26v
                dd27p_tab = lt_dd27p
      EXCEPTIONS view_not_found = 1 name_inconsistent = 2 view_inconsistent = 3
                 put_failure = 4 put_refused = 5 OTHERS = 6.
    IF sy-subrc <> 0.
      fail( |DDIF_VIEW_PUT failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
      RETURN.
    ENDIF.
    line( 'VIEW-PUT' ).

    COMMIT WORK.

    CALL FUNCTION 'DDIF_VIEW_ACTIVATE'
      EXPORTING name = lv_view
      IMPORTING rc = lv_rc
      EXCEPTIONS not_found = 1 put_failure = 2 OTHERS = 3.
    IF sy-subrc = 0 AND lv_rc > 4.
      sy-subrc = lv_rc.
    ENDIF.
    IF sy-subrc <> 0.
      fail( |DDIF_VIEW_ACTIVATE failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
      RETURN.
    ENDIF.
    line( 'VIEW-ACTIVATED' ).

    COMMIT WORK.
  ENDMETHOD.

  METHOD delete_view.
    DATA lv_view TYPE dd25l-viewname.
    lv_view = s( 'view_name' ).

    DATA ls_dd25l TYPE dd25l.
    DATA lv_dd25l_exists TYPE abap_bool.
    DATA lv_dd25l_count TYPE i.
    DATA lv_tadir_count TYPE i.

    " Step 1: confirm there is something left to delete. A DD25L row is the
    " normal case; also tolerate DD25L already gone but a TADIR row still
    " present - a previous delete that crashed after DD_OBJ_DEL durably
    " committed but before TR_TADIR_INTERFACE ran - so a retry can finish
    " the job instead of being refused forever as "does not exist".
    SELECT SINGLE * FROM dd25l INTO @ls_dd25l WHERE viewname = @lv_view.
    lv_dd25l_exists = xsdbool( sy-subrc = 0 ).
    IF lv_dd25l_exists = abap_false.
      SELECT COUNT( * ) FROM tadir INTO @lv_tadir_count
        WHERE pgmid = 'R3TR' AND object = 'VIEW' AND obj_name = @lv_view.
      IF lv_tadir_count = 0.
        fail( |view { lv_view } does not exist| ).
        RETURN.
      ENDIF.
      line( |ZMCP-DDIC-NOTE> resuming a partial delete of { lv_view }: DD25L is already gone, | &&
        |TADIR row remains - finishing the TADIR cleanup only, not repeating DD_OBJ_DEL| ).
    ENDIF.

    " Steps 2-3 (skipped when DD25L is already gone - resuming a half-
    " finished delete): delete the active version, then any inactive one
    " (no inactive row is normal). Each CALL FUNCTION is wrapped in its own
    " TRY/CATCH cx_root: an uncaught class-based exception from inside a
    " statically-named CALL FUNCTION can only originate from the callee's
    " own implementation, and previously propagated all the way to run's
    " generic catch-all, reporting only the exception's generic text with
    " no indication of which step raised it - each CATCH here labels the
    " step with a distinct, greppable delete_view/... string.
    " del_state = 'A' and del_state = 'N' both use prid = -1 - proven live
    " on 2026-09-04 and again on 2026-09-08, when instrumentation added
    " here turned an unattributable CX_SY_DYN_CALL_ILLEGAL_TYPE into a
    " precise diagnosis: both DD_OBJ_DEL calls completed, and the failure
    " was entirely in the next step, TR_TADIR_INTERFACE (see Step 4) - not
    " in DD_OBJ_DEL as a since-disproven prid=0 experiment had assumed.
    IF lv_dd25l_exists = abap_true.
      TRY.
          CALL FUNCTION 'DD_OBJ_DEL'
            EXPORTING
              object_name = lv_view
              object_type = 'VIEW'
              del_state   = 'A'
              prid        = -1
            EXCEPTIONS
              OTHERS      = 1.
        CATCH cx_root INTO DATA(lx_del_a).
          fail( |delete_view/dd_obj_del_A raised { lx_del_a->get_text( ) }| ).
          RETURN.
      ENDTRY.
      IF sy-subrc <> 0.
        fail( |DD_OBJ_DEL failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
        RETURN.
      ENDIF.

      TRY.
          CALL FUNCTION 'DD_OBJ_DEL'
            EXPORTING
              object_name = lv_view
              object_type = 'VIEW'
              del_state   = 'N'
              prid        = -1
            EXCEPTIONS
              OTHERS      = 1.
        CATCH cx_root INTO DATA(lx_del_n).
          fail( |delete_view/dd_obj_del_N raised { lx_del_n->get_text( ) }| ).
          RETURN.
      ENDTRY.
    ENDIF.
    line( 'VIEW-DELETED' ).

    " Step 4: remove the TADIR row (wi_test_modus = space, or this no-ops).
    " Live on 2026-09-08, passing lv_view (TYPE dd25l-viewname) directly as
    " WI_TADIR_OBJ_NAME raised: "The function call of TR_TADIR_INTERFACE
    " failed; a field may have been assigned to the parameter
    " WI_TADIR_OBJ_NAME whose type is not compatible with this parameter."
    " The fix is to pass a local typed from the parameter's own field
    " (tadir-obj_name) instead of lv_view's unrelated dd25l-viewname type.
    " What is NOT established offline: whether the two fields differ in
    " width, or the rejection came from something else about how the
    " parameter is typed (e.g. a generic/structure-bound interface that
    " checks the actual type at the call boundary even though the FM name
    " here is static) - this repo has no DDIC catalogue to check either
    " field against, and an earlier draft of this comment asserted both
    " fields were CHAR30 and the same width - that claim was unfounded and
    " has been withdrawn. The IF below does not depend on knowing the
    " answer: it compares the typed local back against
    " lv_view and fails loudly on any mismatch, so if truncation (or any
    " other silent corruption of the value) does occur, the tool refuses
    " instead of deleting the wrong TADIR row.
    DATA lv_tadir_obj TYPE tadir-obj_name.
    lv_tadir_obj = lv_view.
    IF lv_tadir_obj <> lv_view.
      fail( |delete_view/tadir_obj_name_guard: { lv_view } does not fit tadir-obj_name without truncation - | &&
        |refusing to risk deleting the wrong TADIR row| ).
      RETURN.
    ENDIF.

    TRY.
        CALL FUNCTION 'TR_TADIR_INTERFACE'
          EXPORTING
            wi_test_modus         = space
            wi_tadir_pgmid        = 'R3TR'
            wi_tadir_object       = 'VIEW'
            wi_tadir_obj_name     = lv_tadir_obj
            wi_delete_tadir_entry = 'X'
          EXCEPTIONS
            OTHERS                = 1.
      CATCH cx_root INTO DATA(lx_tadir).
        fail( |delete_view/tr_tadir_interface raised { lx_tadir->get_text( ) }| ).
        RETURN.
    ENDTRY.

    " Step 5: commit.
    COMMIT WORK.

    " Step 6: re-read DD25L, then TADIR, before declaring the view gone.
    SELECT COUNT( * ) FROM dd25l INTO @lv_dd25l_count WHERE viewname = @lv_view.
    IF lv_dd25l_count <> 0.
      fail( |delete of { lv_view } reported no error but DD25L still has a row| ).
      RETURN.
    ENDIF.
    SELECT COUNT( * ) FROM tadir INTO @lv_tadir_count
      WHERE pgmid = 'R3TR' AND object = 'VIEW' AND obj_name = @lv_view.
    IF lv_tadir_count <> 0.
      fail( |{ lv_view }'s DD25L rows are gone but its TADIR row remains; | &&
        |the DD25L delete worked; likely cause is an object lock from an open transport request (TR022)| ).
      RETURN.
    ENDIF.
    line( 'VIEW-GONE' ).
  ENDMETHOD.`;

export const viewPart: ClassicAbapPart = { methods: ["create_view", "delete_view"], source: SOURCE };
