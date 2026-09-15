/**
 * Search-help (SHLP) create/update/delete for the `classic` fluid bridge —
 * issue #83. Proven live on A4H (NetWeaver 7.54, client 001) on 2026-09-12
 * via a $TMP classrun probe: DDIF_SHLP_PUT followed by DDIF_SHLP_ACTIVATE
 * returned sy-subrc = 0 with message DH107 (search help activated), and a
 * read-back of DD30L/DD31S/DD32S/DD33S showed the definition exactly as
 * put. DD_OBJ_DEL with object_type = 'SHLP' and del_state = 'A' returned
 * sy-subrc = 0 with message DH051. All FM names, parameter names and
 * exception lists below are transcribed from that run - do not "simplify"
 * them.
 *
 * IMPORTANT, learned the hard way live: the global table types DD31VTAB,
 * DD32PTAB and DD33VTAB do NOT exist on this release - declaring a
 * `TABLES` parameter or a local typed from them fails the syntax check.
 * What compiles (and is what the live probe used) is a method-local TYPES
 * declaration: `TYPES tt_dd31v TYPE STANDARD TABLE OF dd31v WITH DEFAULT
 * KEY.` (and the dd32p/dd33v equivalents) inside each METHOD that needs
 * them. This is legal ABAP - a TYPES statement is allowed anywhere DATA is
 * allowed inside a method body - so don't "fix" it back to the global
 * names; they are not there on every release this bridge might run on.
 *
 * create_search_help and update_search_help share the same DD30V/DD31V/
 * DD32P/DD33V fill and the same RS_CORR_INSERT -> DDIF_SHLP_PUT ->
 * COMMIT WORK -> DDIF_SHLP_ACTIVATE -> COMMIT WORK sequence; they differ
 * only in their existence pre-check and the validation/note text tied to
 * "this replaces the whole definition". Written as two separate template
 * strings rather than factored into one shared generator - this file is a
 * static template string, not a place to build indirection; abap-view.ts
 * duplicates create_view/delete_view the same way.
 */
import type { ClassicAbapPart } from "./abap-core.js";

const PUT_LOCALS = `    DATA lv_shlp TYPE dd30l-shlpname.
    lv_shlp = s( 'shlp_name' ).
    DATA(lv_description) = s( 'description' ).
    DATA lv_package TYPE devclass.
    lv_package = s( 'package_name' ).
    DATA(lv_corr) = s( 'corr_nr' ).
    DATA(lv_selmethod) = s( 'selection_method' ).
    DATA(lv_selmtype) = s( 'selection_method_type' ).
    DATA(lv_dialogtype) = s( 'dialog_type' ).
    DATA(lv_texttab) = s( 'text_table' ).
    DATA(lv_hotkey) = s( 'hot_key' ).
    DATA(lv_elementary) = b( 'elementary' ).
    IF lv_dialogtype IS INITIAL.
      lv_dialogtype = 'D'.
    ENDIF.
    DATA(lv_local) = boolc( to_upper( lv_package ) CP '$*' ).
    DATA lv_korrnum TYPE trkorr.
    IF lv_local = abap_true.
      lv_korrnum = space.
    ELSE.
      lv_korrnum = lv_corr.
    ENDIF.

    DATA lv_field_count TYPE i.
    DATA lv_inc_count TYPE i.
    DATA lv_assign_count TYPE i.
    DATA lv_i TYPE i.
    DATA lv_field TYPE string.
    DATA lv_import_any TYPE abap_bool.
    DATA lv_export_any TYPE abap_bool.
    DATA lv_selmethod_count TYPE i.
    DATA lv_fld_count TYPE i.
    DATA lv_rc TYPE sy-subrc.

    " --- validation, before anything is registered (RS_CORR_INSERT) ---

    lv_field_count = n( 'fields' ).
    IF lv_elementary = abap_true.
      DO lv_field_count TIMES.
        lv_i = sy-index.
        IF b( |fields/{ lv_i - 1 }/import| ) = abap_true.
          lv_import_any = abap_true.
        ENDIF.
        IF b( |fields/{ lv_i - 1 }/export| ) = abap_true.
          lv_export_any = abap_true.
        ENDIF.
      ENDDO.
      IF lv_import_any = abap_false OR lv_export_any = abap_false.
        fail( 'a search help needs at least one import and one export parameter' ).
        RETURN.
      ENDIF.
    ENDIF.

    CASE lv_selmtype.
      WHEN 'T'.
        SELECT COUNT( * ) FROM dd02l INTO @lv_selmethod_count WHERE tabname = @lv_selmethod AND as4local = 'A'.
      WHEN 'V'.
        SELECT COUNT( * ) FROM dd25l INTO @lv_selmethod_count WHERE viewname = @lv_selmethod AND as4local = 'A'.
      WHEN OTHERS.
        line( |ZMCP-DDIC-NOTE> selection method type { lv_selmtype } is not checked| ).
        lv_selmethod_count = 1.
    ENDCASE.
    IF lv_selmethod_count = 0.
      fail( |selection method { lv_selmethod } does not exist as a { lv_selmtype }| ).
      RETURN.
    ENDIF.

    IF lv_selmtype = 'T' OR lv_selmtype = 'V'.
      DO lv_field_count TIMES.
        lv_i = sy-index.
        lv_field = s( |fields/{ lv_i - 1 }/name| ).
        CASE lv_selmtype.
          WHEN 'T'.
            SELECT COUNT( * ) FROM dd03l INTO @lv_fld_count
              WHERE tabname = @lv_selmethod AND fieldname = @lv_field AND as4local = 'A'.
          WHEN 'V'.
            SELECT COUNT( * ) FROM dd27s INTO @lv_fld_count
              WHERE viewname = @lv_selmethod AND viewfield = @lv_field AND as4local = 'A'.
        ENDCASE.
        IF lv_fld_count = 0.
          fail( |field { lv_field } is not a field of selection method { lv_selmethod }| ).
          RETURN.
        ENDIF.
      ENDDO.
    ENDIF.

    " --- fill DD30V/DD31V/DD32P/DD33V ---

    DATA ls_dd30v TYPE dd30v.
    CLEAR ls_dd30v.
    ls_dd30v-shlpname   = lv_shlp.
    ls_dd30v-ddlanguage = sy-langu.
    ls_dd30v-ddtext     = lv_description.
    IF lv_elementary = abap_true.
      ls_dd30v-issimple = 'X'.
    ELSE.
      ls_dd30v-issimple = space.
    ENDIF.
    ls_dd30v-selmethod  = lv_selmethod.
    ls_dd30v-selmtype   = lv_selmtype.
    ls_dd30v-texttab    = lv_texttab.
    ls_dd30v-hotkey     = lv_hotkey.
    ls_dd30v-dialogtype = lv_dialogtype.

    TYPES tt_dd31v TYPE STANDARD TABLE OF dd31v WITH DEFAULT KEY.
    DATA lt_dd31v TYPE tt_dd31v.
    DATA ls_dd31v TYPE dd31v.
    lv_inc_count = n( 'includes' ).
    DO lv_inc_count TIMES.
      lv_i = sy-index.
      CLEAR ls_dd31v.
      ls_dd31v-shlpname   = lv_shlp.
      ls_dd31v-subshlp    = s( |includes/{ lv_i - 1 }/name| ).
      ls_dd31v-shposition = |{ lv_i WIDTH = 4 PAD = '0' ALIGN = RIGHT }|.
      ls_dd31v-viashlp    = lv_shlp.
      APPEND ls_dd31v TO lt_dd31v.
    ENDDO.

    TYPES tt_dd32p TYPE STANDARD TABLE OF dd32p WITH DEFAULT KEY.
    DATA lt_dd32p TYPE tt_dd32p.
    DATA ls_dd32p TYPE dd32p.
    DO lv_field_count TIMES.
      lv_i = sy-index.
      CLEAR ls_dd32p.
      ls_dd32p-shlpname   = lv_shlp.
      ls_dd32p-fieldname  = s( |fields/{ lv_i - 1 }/name| ).
      ls_dd32p-flposition = |{ lv_i WIDTH = 4 PAD = '0' ALIGN = RIGHT }|.
      ls_dd32p-rollname   = s( |fields/{ lv_i - 1 }/data_element| ).
      IF b( |fields/{ lv_i - 1 }/import| ) = abap_true.
        ls_dd32p-shlpinput = 'X'.
      ENDIF.
      IF b( |fields/{ lv_i - 1 }/export| ) = abap_true.
        ls_dd32p-shlpoutput = 'X'.
      ENDIF.
      " every field is both selectable and listed, at its own position - proven live 2026-09-12,
      " read-back showed sel/list positions 01, 02, 03 for a 3-field interface.
      ls_dd32p-shlpselpos = |{ lv_i WIDTH = 4 PAD = '0' ALIGN = RIGHT }|.
      ls_dd32p-shlplispos = |{ lv_i WIDTH = 4 PAD = '0' ALIGN = RIGHT }|.
      ls_dd32p-defaultval = s( |fields/{ lv_i - 1 }/default_value| ).
      APPEND ls_dd32p TO lt_dd32p.
    ENDDO.

    TYPES tt_dd33v TYPE STANDARD TABLE OF dd33v WITH DEFAULT KEY.
    DATA lt_dd33v TYPE tt_dd33v.
    DATA ls_dd33v TYPE dd33v.
    lv_assign_count = n( 'assignments' ).
    DO lv_assign_count TIMES.
      lv_i = sy-index.
      CLEAR ls_dd33v.
      ls_dd33v-shlpname   = lv_shlp.
      ls_dd33v-fieldname  = s( |assignments/{ lv_i - 1 }/field| ).
      ls_dd33v-subshlp    = s( |assignments/{ lv_i - 1 }/included_help| ).
      ls_dd33v-subfield   = s( |assignments/{ lv_i - 1 }/included_field| ).
      ls_dd33v-valuedirec = s( |assignments/{ lv_i - 1 }/direction| ).
      APPEND ls_dd33v TO lt_dd33v.
    ENDDO.

    DATA(lv_object) = |SHLP{ lv_shlp WIDTH = 40 ALIGN = LEFT }|.
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
    line( 'SHLP-REGISTERED' ).
`;

const PUT_ACTIVATE = `    CALL FUNCTION 'DDIF_SHLP_PUT'
      EXPORTING name = lv_shlp
                dd30v_wa = ls_dd30v
      TABLES    dd31v_tab = lt_dd31v
                dd32p_tab = lt_dd32p
                dd33v_tab = lt_dd33v
      EXCEPTIONS shlp_not_found = 1 name_inconsistent = 2 shlp_inconsistent = 3
                 put_failure = 4 put_refused = 5 OTHERS = 6.
    IF sy-subrc <> 0.
      fail( |DDIF_SHLP_PUT failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
      RETURN.
    ENDIF.
    line( 'SHLP-PUT' ).

    COMMIT WORK.

    CALL FUNCTION 'DDIF_SHLP_ACTIVATE'
      EXPORTING name = lv_shlp
      IMPORTING rc = lv_rc
      EXCEPTIONS not_found = 1 put_failure = 2 OTHERS = 3.
    IF sy-subrc = 0 AND lv_rc > 4.
      sy-subrc = lv_rc.
    ENDIF.
    IF sy-subrc <> 0.
      fail( |DDIF_SHLP_ACTIVATE failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
      RETURN.
    ENDIF.
    line( 'SHLP-ACTIVATED' ).

    COMMIT WORK.
  ENDMETHOD.`;

// The pre-check reads shlp_name itself, into its own probe local, and runs
// BEFORE PUT_LOCALS - not after. PUT_LOCALS ends with the RS_CORR_INSERT
// call (registering the object in the transport); running the existence
// check after that, as an earlier draft of this file did, would register a
// SHLP object in CTS before failing on "already exists" - a side effect a
// caller who only made a mistake never asked for and was not warned about.
const CREATE_SEARCH_HELP = `  METHOD create_search_help.
    DATA lv_shlp_probe TYPE dd30l-shlpname.
    lv_shlp_probe = s( 'shlp_name' ).
    DATA lv_exists_count TYPE i.
    SELECT COUNT( * ) FROM dd30l INTO @lv_exists_count WHERE shlpname = @lv_shlp_probe AND as4local = 'A'.
    IF lv_exists_count <> 0.
      fail( |search help { lv_shlp_probe } already exists| ).
      RETURN.
    ENDIF.

${PUT_LOCALS}
${PUT_ACTIVATE}`;

// Same discipline as create_search_help above: the "does not exist" check
// only needs lv_shlp_probe, so it is read once, early, ahead of PUT_LOCALS -
// the shared block that ends with the RS_CORR_INSERT/DDIF_SHLP_PUT calls.
const UPDATE_SEARCH_HELP = `  METHOD update_search_help.
    DATA lv_shlp_probe TYPE dd30l-shlpname.
    lv_shlp_probe = s( 'shlp_name' ).
    DATA lv_exists_count TYPE i.
    SELECT COUNT( * ) FROM dd30l INTO @lv_exists_count WHERE shlpname = @lv_shlp_probe AND as4local = 'A'.
    IF lv_exists_count = 0.
      fail( |search help { lv_shlp_probe } does not exist| ).
      RETURN.
    ENDIF.

${PUT_LOCALS}
    line( |ZMCP-DDIC-NOTE> DDIF_SHLP_PUT replaces the whole definition: every interface parameter, | &&
      |include and assignment not passed in this call is removed| ).

${PUT_ACTIVATE}`;

const DELETE_SEARCH_HELP = `  METHOD delete_search_help.
    DATA lv_shlp TYPE dd30l-shlpname.
    lv_shlp = s( 'shlp_name' ).

    DATA ls_dd30l TYPE dd30l.
    DATA lv_dd30l_exists TYPE abap_bool.
    DATA lv_dd30l_count TYPE i.
    DATA lv_tadir_count TYPE i.
    DATA lv_dtel_count TYPE i.
    DATA lv_att_count TYPE i.
    DATA lv_inc_count TYPE i.

    " Step 1: confirm there is something left to delete - same resume-tolerant
    " probe as delete_view: a DD30L row is the normal case; also tolerate DD30L
    " already gone but a TADIR row still present, so a retry can finish a
    " previous delete that crashed between DD_OBJ_DEL and TR_TADIR_INTERFACE.
    SELECT SINGLE * FROM dd30l INTO @ls_dd30l WHERE shlpname = @lv_shlp.
    lv_dd30l_exists = xsdbool( sy-subrc = 0 ).
    IF lv_dd30l_exists = abap_false.
      SELECT COUNT( * ) FROM tadir INTO @lv_tadir_count
        WHERE pgmid = 'R3TR' AND object = 'SHLP' AND obj_name = @lv_shlp.
      IF lv_tadir_count = 0.
        fail( |search help { lv_shlp } does not exist| ).
        RETURN.
      ENDIF.
      line( |ZMCP-DDIC-NOTE> resuming a partial delete of { lv_shlp }: DD30L is already gone, | &&
        |TADIR row remains - finishing the TADIR cleanup only, not repeating DD_OBJ_DEL| ).
    ENDIF.

    " Step 2: where-used guard (issue #83) - a search help can be attached to
    " data elements (DD04L), to individual table/view fields (DD35L), and be
    " included by a collective search help (DD31S, keyed by SUBSHLP). All
    " three tables and their AS4LOCAL = 'A' filter are live-proven live on
    " A4H 2026-09-12 as the right place to look.
    SELECT COUNT( * ) FROM dd04l INTO @lv_dtel_count WHERE shlpname = @lv_shlp AND as4local = 'A'.
    SELECT COUNT( * ) FROM dd35l INTO @lv_att_count WHERE shlpname = @lv_shlp AND as4local = 'A'.
    SELECT COUNT( * ) FROM dd31s INTO @lv_inc_count WHERE subshlp = @lv_shlp AND as4local = 'A'.
    IF lv_dtel_count + lv_att_count + lv_inc_count <> 0.
      IF b( 'confirm_in_use' ) = abap_false.
        fail( |search help { lv_shlp } is in use: { lv_dtel_count } data element(s), | &&
          |{ lv_att_count } field attachment(s), { lv_inc_count } collective search help(s). | &&
          |Pass confirm_in_use to delete it anyway| ).
        RETURN.
      ENDIF.
      line( |ZMCP-DDIC-NOTE> deleting { lv_shlp } despite being in use: { lv_dtel_count } data element(s), | &&
        |{ lv_att_count } field attachment(s), { lv_inc_count } collective search help(s)| ).
    ENDIF.

    " Steps 3-4 (skipped when DD30L is already gone - resuming a half-finished
    " delete): delete the active version, then any inactive one. Each CALL
    " FUNCTION wrapped in its own TRY/CATCH cx_root, labelled, same discipline
    " as delete_view - del_state = 'A' returned message DH051 live on
    " 2026-09-12; both calls use prid = -1, same as delete_view.
    IF lv_dd30l_exists = abap_true.
      TRY.
          CALL FUNCTION 'DD_OBJ_DEL'
            EXPORTING
              object_name = lv_shlp
              object_type = 'SHLP'
              del_state   = 'A'
              prid        = -1
            EXCEPTIONS
              OTHERS      = 1.
        CATCH cx_root INTO DATA(lx_del_a).
          fail( |delete_search_help/dd_obj_del_A raised { lx_del_a->get_text( ) }| ).
          RETURN.
      ENDTRY.
      IF sy-subrc <> 0.
        fail( |DD_OBJ_DEL failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
        RETURN.
      ENDIF.

      TRY.
          CALL FUNCTION 'DD_OBJ_DEL'
            EXPORTING
              object_name = lv_shlp
              object_type = 'SHLP'
              del_state   = 'N'
              prid        = -1
            EXCEPTIONS
              OTHERS      = 1.
        CATCH cx_root INTO DATA(lx_del_n).
          fail( |delete_search_help/dd_obj_del_N raised { lx_del_n->get_text( ) }| ).
          RETURN.
      ENDTRY.
    ENDIF.
    line( 'SHLP-DELETED' ).

    " Step 5: remove the TADIR row - same typed-local truncation guard as
    " delete_view, for the same reason: a generic-typed FM parameter rejected
    " a differently-typed local live, and the fix is a local typed from the
    " parameter's own field, checked for truncation before use.
    DATA lv_tadir_obj TYPE tadir-obj_name.
    lv_tadir_obj = lv_shlp.
    IF lv_tadir_obj <> lv_shlp.
      fail( |delete_search_help/tadir_obj_name_guard: { lv_shlp } does not fit tadir-obj_name without | &&
        |truncation - refusing to risk deleting the wrong TADIR row| ).
      RETURN.
    ENDIF.

    TRY.
        CALL FUNCTION 'TR_TADIR_INTERFACE'
          EXPORTING
            wi_test_modus         = space
            wi_tadir_pgmid        = 'R3TR'
            wi_tadir_object       = 'SHLP'
            wi_tadir_obj_name     = lv_tadir_obj
            wi_delete_tadir_entry = 'X'
          EXCEPTIONS
            OTHERS                = 1.
      CATCH cx_root INTO DATA(lx_tadir).
        fail( |delete_search_help/tr_tadir_interface raised { lx_tadir->get_text( ) }| ).
        RETURN.
    ENDTRY.

    COMMIT WORK.

    " Step 6: prove absence before declaring the search help gone.
    SELECT COUNT( * ) FROM dd30l INTO @lv_dd30l_count WHERE shlpname = @lv_shlp.
    IF lv_dd30l_count <> 0.
      fail( |delete of { lv_shlp } reported no error but DD30L still has a row| ).
      RETURN.
    ENDIF.
    SELECT COUNT( * ) FROM tadir INTO @lv_tadir_count
      WHERE pgmid = 'R3TR' AND object = 'SHLP' AND obj_name = @lv_shlp.
    IF lv_tadir_count <> 0.
      fail( |{ lv_shlp }'s DD30L rows are gone but its TADIR row remains; | &&
        |the DD30L delete worked; likely cause is an object lock from an open transport request (TR022)| ).
      RETURN.
    ENDIF.
    line( 'SHLP-GONE' ).
  ENDMETHOD.`;

export const shlpPart: ClassicAbapPart = {
  methods: ["create_search_help", "update_search_help", "delete_search_help"],
  source: `${CREATE_SEARCH_HELP}\n\n${UPDATE_SEARCH_HELP}\n\n${DELETE_SEARCH_HELP}`,
};
