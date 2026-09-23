import type { ClassicAbapPart } from "./abap-core.js";

const SOURCE = `  METHOD create_transaction.
    DATA lv_tcode TYPE tstc-tcode.
    lv_tcode = s( 'tcode' ).
    DATA lv_description TYPE tstct-ttext.
    lv_description = s( 'description' ).
    DATA lv_package TYPE devclass.
    lv_package = s( 'package_name' ).
    DATA(lv_corr_nr) = s( 'corr_nr' ).
    DATA(lv_local) = boolc( to_upper( lv_package ) CP '$*' ).
    DATA lv_transport TYPE trkorr.
    IF lv_local = abap_true.
      lv_transport = space.
    ELSE.
      lv_transport = lv_corr_nr.
    ENDIF.

    " issue #214: transaction_type now selects among RPY_TRANSACTION_INSERT's
    " four reachable shapes - 'R' report, 'D' dialog, 'P' parameter (also how
    " an OO transaction with transaction model is stored - see
    " tran-create.ts's header), 'V' variant. There is no 'O' branch in the
    " FM itself - never send it.
    DATA lv_type TYPE stran_type.
    lv_type = s( 'transaction_type' ).
    IF lv_type <> 'R' AND lv_type <> 'D' AND lv_type <> 'P' AND lv_type <> 'V'.
      fail( |transaction_type { lv_type } must be one of R (report), D (dialog), | &&
        |P (parameter), V (variant)| ).
      RETURN.
    ENDIF.

    DATA lv_program TYPE tstc-pgmna.
    lv_program = s( 'program' ).

    " RPY_TRANSACTION_INSERT's DYNPRO is TYPE d020s-dnum (CHAR4), not
    " tstc-dypno (NUMC4) - a NUMC local here raises CX_SY_DYN_CALL_ILLEGAL_TYPE.
    " Report kind ignores dynpro anyway (always starts on 1000).
    DATA lv_dynpro TYPE d020s-dnum.
    IF lv_type = 'R'.
      lv_dynpro = '1000'.
    ELSEIF s( 'dynpro' ) IS NOT INITIAL.
      lv_dynpro = s( 'dynpro' ).
    ENDIF.

    " called_transaction/transaction_type/variant also fail with
    " CX_SY_DYN_CALL_ILLEGAL_TYPE if left as s()'s inferred TYPE string -
    " RPY_TRANSACTION_INSERT's VALUE() parameters reject a STRING actual.
    DATA lv_called TYPE tstc-tcode.
    lv_called = s( 'called_transaction' ).
    DATA lv_skip TYPE char01.
    lv_skip = COND char01( WHEN b( 'skip_first_screen' ) = abap_true THEN 'X' ELSE space ).
    DATA lv_variant TYPE tcvariant.
    lv_variant = s( 'variant' ).
    DATA lv_cl_indep TYPE char01.
    lv_cl_indep = COND char01( WHEN b( 'cross_client_variant' ) = abap_true THEN 'X' ELSE space ).

    " TSTCP screen-field assignments (parameter transactions) or the fixed
    " CLASS/METHOD/UPDATE_MODE triple (OO with transaction model, sent by
    " tran-create.ts's transactionInsertArgs as transaction_type 'P' against
    " called_transaction 'OS_APPLICATION') - same n()/DO...TIMES shape
    " abap-shlp.ts's fields/includes/assignments tables use.
    DATA lt_params TYPE STANDARD TABLE OF rsparam WITH DEFAULT KEY.
    DATA lv_param_count TYPE i.
    DATA lv_i TYPE i.
    lv_param_count = n( 'parameters' ).
    DO lv_param_count TIMES.
      lv_i = sy-index.
      APPEND VALUE #( field = s( |parameters/{ lv_i - 1 }/field| )
                       value = s( |parameters/{ lv_i - 1 }/value| ) ) TO lt_params.
    ENDDO.

    CALL FUNCTION 'RPY_TRANSACTION_INSERT'
      EXPORTING transaction             = lv_tcode
                program                 = lv_program
                dynpro                  = lv_dynpro
                language                = sy-langu
                development_class       = lv_package
                transport_number        = lv_transport
                transaction_type        = lv_type
                shorttext               = lv_description
                called_transaction      = lv_called
                called_transaction_skip = lv_skip
                variant                 = lv_variant
                cl_independend          = lv_cl_indep
      TABLES param_values = lt_params
      EXCEPTIONS cancelled = 1 already_exist = 2 permission_error = 3
                 name_not_allowed = 4 name_conflict = 5 illegal_type = 6
                 object_inconsistent = 7 db_access_error = 8 OTHERS = 9.
    IF sy-subrc <> 0.
      DATA lv_exc TYPE string.
      CASE sy-subrc.
        WHEN 1. lv_exc = 'cancelled'.
        WHEN 2. lv_exc = 'already_exist'.
        WHEN 3. lv_exc = 'permission_error'.
        WHEN 4. lv_exc = 'name_not_allowed'.
        WHEN 5. lv_exc = 'name_conflict'.
        WHEN 6. lv_exc = 'illegal_type'.
        WHEN 7. lv_exc = 'object_inconsistent'.
        WHEN 8. lv_exc = 'db_access_error'.
        WHEN OTHERS. lv_exc = 'unknown'.
      ENDCASE.
      DATA lv_msg TYPE string.
      IF sy-msgid IS NOT INITIAL.
        MESSAGE ID sy-msgid TYPE 'S' NUMBER sy-msgno
          WITH sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4 INTO lv_msg.
      ENDIF.
      fail( |RPY_TRANSACTION_INSERT failed, sy-subrc={ sy-subrc } ({ lv_exc }): { lv_msg }| ).
      RETURN.
    ENDIF.
    line( 'TRAN-CREATED' ).

    COMMIT WORK.
  ENDMETHOD.

  METHOD update_transaction.
    DATA ls_tstc TYPE tstc.
    DATA lv_tcode TYPE tstc-tcode.
    lv_tcode = s( 'tcode' ).
    DATA lv_program TYPE tstc-pgmna.
    lv_program = s( 'program' ).
    DATA lv_description TYPE tstct-ttext.
    lv_description = s( 'description' ).
    DATA lv_package TYPE devclass.
    lv_package = s( 'package_name' ).
    DATA(lv_corr_nr) = s( 'corr_nr' ).
    DATA(lv_local) = boolc( to_upper( lv_package ) CP '$*' ).
    DATA lv_korrnum TYPE trkorr.
    IF lv_local = abap_true.
      lv_korrnum = space.
    ELSE.
      lv_korrnum = lv_corr_nr.
    ENDIF.

    " Step 1: confirm the transaction exists - update_transaction retargets
    " an existing transaction, it does not create one (create_transaction
    " already covers that case and refuses a tcode that already exists).
    SELECT SINGLE * FROM tstc INTO @ls_tstc WHERE tcode = @lv_tcode.
    IF sy-subrc <> 0.
      fail( |transaction { lv_tcode } does not exist| ).
      RETURN.
    ENDIF.

    " Step 2 (issue #83): role-menu guard. Retargeting a transaction that is
    " already assigned to one or more roles' menus (AGR_TCODES, keyed by
    " AGR_NAME/TCODE - proven live on A4H 2026-09-12) changes what those
    " roles' menu entries launch, without touching the roles themselves.
    " Honesty note: an SM01 transaction lock is NOT checked anywhere in this
    " method - if { lv_tcode } is locked in SM01, RPY_TRANSACTION_DELETE and
    " RPY_TRANSACTION_INSERT below still run and TSTC is still updated; SM01
    " only affects whether end users can start the transaction, not whether
    " this bridge can redefine it.
    DATA lt_agr_tcodes TYPE STANDARD TABLE OF agr_tcodes WITH DEFAULT KEY.
    DATA ls_agr_tcodes TYPE agr_tcodes.
    DATA lv_agr_count TYPE i.
    DATA lv_agr_list TYPE string.
    " No caps of any kind: this project forbids silent truncation in
    " generated ABAP, so every matching role is selected and lv_agr_list
    " below is the complete membership, not a sample of it.
    SELECT * FROM agr_tcodes INTO TABLE @lt_agr_tcodes WHERE tcode = @lv_tcode.
    lv_agr_count = lines( lt_agr_tcodes ).
    IF lv_agr_count <> 0.
      CLEAR lv_agr_list.
      LOOP AT lt_agr_tcodes INTO ls_agr_tcodes.
        IF lv_agr_list IS INITIAL.
          lv_agr_list = ls_agr_tcodes-agr_name.
        ELSE.
          lv_agr_list = |{ lv_agr_list }, { ls_agr_tcodes-agr_name }|.
        ENDIF.
      ENDLOOP.
      IF b( 'confirm_in_role_menu' ) = abap_false.
        fail( |transaction { lv_tcode } is in { lv_agr_count } role menu(s) ({ lv_agr_list }); | &&
          |retargeting it changes what those menu entries launch. An SM01 lock is not checked either way. | &&
          |Pass confirm_in_role_menu to proceed anyway| ).
        RETURN.
      ENDIF.
      line( |ZMCP-DDIC-NOTE> retargeting { lv_tcode } despite it being in { lv_agr_count } role menu(s) | &&
        |({ lv_agr_list }) - an SM01 transaction lock is not checked here either| ).
    ENDIF.

    " Step 3: register the change once, up front, so both the delete and the
    " re-insert below happen inside the same transport request.
    DATA(lv_object) = lv_tcode.
    CALL FUNCTION 'RS_CORR_INSERT'
      EXPORTING object = lv_object
                object_class = 'TRAN'
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
    line( 'TRAN-REGISTERED' ).

    " Step 4: RPY_TRANSACTION_DELETE's real signature (proven live on A4H
    " 2026-09-12) also exports SUPPRESS_CORR_INSERT and SUPPRESS_CORR_CHECK
    " (both 'X' here: RS_CORR_INSERT already registered the object above -
    " leaving these off makes the FM insert its own transport-request
    " prompt, which a headless classrun cannot answer). Its "nothing to
    " delete" exception is named NOT_EXCECUTED in the FM itself (that
    " spelling is the FM's, not a typo introduced here).
    CALL FUNCTION 'RPY_TRANSACTION_DELETE'
      EXPORTING transaction          = lv_tcode
                suppress_corr_insert = 'X'
                suppress_corr_check  = 'X'
      EXCEPTIONS not_exececuted = 1
                 OTHERS         = 2.
    IF sy-subrc <> 0.
      fail( |RPY_TRANSACTION_DELETE failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
      RETURN.
    ENDIF.

    " Step 5: re-insert against the new program. dynpro is hardcoded to
    " '1000' here for the same reason create_transaction hardcodes it: it is
    " ignored by RPY_TRANSACTION_INSERT when transaction_type = 'R' (a
    " report transaction has no dynpro of its own to start on).
    CALL FUNCTION 'RPY_TRANSACTION_INSERT'
      EXPORTING transaction       = lv_tcode
                program           = lv_program
                dynpro            = '1000'
                language          = sy-langu
                development_class = lv_package
                transport_number  = lv_korrnum
                transaction_type  = 'R'
                shorttext         = lv_description
      EXCEPTIONS cancelled = 1 already_exist = 2 permission_error = 3
                 name_not_allowed = 4 name_conflict = 5 illegal_type = 6
                 object_inconsistent = 7 db_access_error = 8 OTHERS = 9.
    IF sy-subrc <> 0.
      fail( |RPY_TRANSACTION_INSERT failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
      RETURN.
    ENDIF.

    COMMIT WORK.

    " Step 6: prove it, rather than trust either FM's own success signal -
    " re-read TSTC and check PGMNA actually points at the new program.
    SELECT SINGLE * FROM tstc INTO @ls_tstc WHERE tcode = @lv_tcode.
    IF sy-subrc <> 0 OR ls_tstc-pgmna <> lv_program.
      fail( |retarget of { lv_tcode } reported no error but TSTC-PGMNA is | &&
        |{ ls_tstc-pgmna }, not { lv_program }| ).
      RETURN.
    ENDIF.
    line( 'TRAN-RETARGETED' ).
  ENDMETHOD.

  METHOD delete_transaction.
    DATA ls_tstc TYPE tstc.
    DATA lv_tcode TYPE tstc-tcode.
    lv_tcode = s( 'tcode' ).
    DATA lv_package TYPE devclass.
    lv_package = s( 'package_name' ).
    DATA(lv_corr_nr) = s( 'corr_nr' ).
    DATA(lv_local) = boolc( to_upper( lv_package ) CP '$*' ).
    DATA lv_korrnum TYPE trkorr.
    lv_korrnum = lv_corr_nr.

    " Step 1: confirm the transaction exists.
    SELECT SINGLE * FROM tstc INTO @ls_tstc WHERE tcode = @lv_tcode.
    IF sy-subrc <> 0.
      fail( |transaction { lv_tcode } does not exist| ).
      RETURN.
    ENDIF.

    " Step 1a (issue #202): a transportable package needs a transport
    " request the same way create/update do - RPY_TRANSACTION_DELETE has no
    " suppress-dialog-only path for its own SAPLSTRD 0300 transport-request
    " popup, so without corr_nr a headless run would hang there.
    IF lv_local = abap_false AND lv_corr_nr IS INITIAL.
      fail( |transaction { lv_tcode } is in transportable package { lv_package }; deleting it needs | &&
        |a transport request (SAPLSTRD 0300) - pass corr_nr| ).
      RETURN.
    ENDIF.

    " Step 1b (issue #83): role-menu guard - same check and same honest
    " SM01-not-checked note as update_transaction's Step 2; deleting a
    " transaction that is in one or more roles' menus removes it from those
    " menus too (a role menu entry pointing at a deleted transaction fails
    " when a user tries to launch it).
    DATA lt_agr_tcodes TYPE STANDARD TABLE OF agr_tcodes WITH DEFAULT KEY.
    DATA ls_agr_tcodes TYPE agr_tcodes.
    DATA lv_agr_count TYPE i.
    DATA lv_agr_list TYPE string.
    " No caps of any kind: this project forbids silent truncation in
    " generated ABAP, so every matching role is selected and lv_agr_list
    " below is the complete membership, not a sample of it.
    SELECT * FROM agr_tcodes INTO TABLE @lt_agr_tcodes WHERE tcode = @lv_tcode.
    lv_agr_count = lines( lt_agr_tcodes ).
    IF lv_agr_count <> 0.
      CLEAR lv_agr_list.
      LOOP AT lt_agr_tcodes INTO ls_agr_tcodes.
        IF lv_agr_list IS INITIAL.
          lv_agr_list = ls_agr_tcodes-agr_name.
        ELSE.
          lv_agr_list = |{ lv_agr_list }, { ls_agr_tcodes-agr_name }|.
        ENDIF.
      ENDLOOP.
      IF b( 'confirm_in_role_menu' ) = abap_false.
        fail( |transaction { lv_tcode } is in { lv_agr_count } role menu(s) ({ lv_agr_list }); | &&
          |deleting it removes it from those role menus. An SM01 lock is not checked either way. | &&
          |Pass confirm_in_role_menu to proceed anyway| ).
        RETURN.
      ENDIF.
      line( |ZMCP-DDIC-NOTE> deleting { lv_tcode } despite it being in { lv_agr_count } role menu(s) | &&
        |({ lv_agr_list }) - an SM01 transaction lock is not checked here either| ).
    ENDIF.

    DATA lv_del_msg TYPE string.
    IF lv_local = abap_false.
      " Step 2a (issue #202): register the delete in CTS first, same shape
      " as update_transaction's Step 3 (RS_CORR_INSERT), but with no MODE
      " - this call only needs to attach the object to the request, not
      " insert-or-update its master record the way a retarget's re-insert
      " does.
      CALL FUNCTION 'RS_CORR_INSERT'
        EXPORTING object = lv_tcode
                  object_class = 'TRAN'
                  devclass = lv_package
                  master_language = sy-langu
                  global_lock = 'X'
                  korrnum = lv_korrnum
                  suppress_dialog = 'X'
        EXCEPTIONS cancelled = 1 permission_failure = 2 unknown_objectclass = 3 OTHERS = 4.
      IF sy-subrc <> 0.
        fail( |RS_CORR_INSERT failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
        RETURN.
      ENDIF.
      line( 'TRAN-REGISTERED' ).

      " Step 2b: delete via RPY_TRANSACTION_DELETE - the transport is
      " already registered above, so suppress_corr_insert/suppress_corr_check
      " are both 'X', same reasoning as update_transaction's Step 4.
      CALL FUNCTION 'RPY_TRANSACTION_DELETE'
        EXPORTING transaction          = lv_tcode
                  transport_number     = lv_korrnum
                  suppress_corr_insert = 'X'
                  suppress_corr_check  = 'X'
        EXCEPTIONS not_excecuted = 1
                   object_not_found = 2
                   OTHERS = 3.
    ELSE.
      " Step 2: delete via RPY_TRANSACTION_DELETE - local package, no
      " transport at all.
      CALL FUNCTION 'RPY_TRANSACTION_DELETE'
        EXPORTING transaction = lv_tcode
        EXCEPTIONS not_excecuted = 1
                   object_not_found = 2
                   OTHERS = 3.
    ENDIF.
    IF sy-subrc <> 0.
      IF sy-msgid IS NOT INITIAL.
        MESSAGE ID sy-msgid TYPE 'S' NUMBER sy-msgno
          WITH sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4 INTO lv_del_msg.
      ENDIF.
      fail( |RPY_TRANSACTION_DELETE failed, sy-subrc={ sy-subrc }: { lv_del_msg }| ).
      RETURN.
    ENDIF.
    line( 'TRAN-DELETED' ).

    " Step 3: commit.
    COMMIT WORK.

    " Step 4: prove absence.
    SELECT SINGLE * FROM tstc INTO @ls_tstc WHERE tcode = @lv_tcode.
    IF sy-subrc = 0.
      fail( |delete of { lv_tcode } reported no error but the TSTC row still exists| ).
      RETURN.
    ENDIF.
    line( 'TRAN-GONE' ).
  ENDMETHOD.`;

export const tranPart: ClassicAbapPart = {
  methods: ["create_transaction", "update_transaction", "delete_transaction"],
  source: SOURCE,
};
