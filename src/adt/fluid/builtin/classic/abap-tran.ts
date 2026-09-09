import type { ClassicAbapPart } from "./abap-core.js";

const SOURCE = `  METHOD create_transaction.
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
    DATA lv_transport TYPE trkorr.
    IF lv_local = abap_true.
      lv_transport = space.
    ELSE.
      lv_transport = lv_corr_nr.
    ENDIF.

    CALL FUNCTION 'RPY_TRANSACTION_INSERT'
      EXPORTING transaction       = lv_tcode
                program           = lv_program
                dynpro            = '1000'
                language          = sy-langu
                development_class = lv_package
                transport_number  = lv_transport
                transaction_type  = 'R'
                shorttext         = lv_description
      EXCEPTIONS cancelled = 1 already_exist = 2 permission_error = 3
                 name_not_allowed = 4 name_conflict = 5 illegal_type = 6
                 object_inconsistent = 7 db_access_error = 8 OTHERS = 9.
    IF sy-subrc <> 0.
      fail( |RPY_TRANSACTION_INSERT failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
      RETURN.
    ENDIF.
    line( 'TRAN-CREATED' ).

    COMMIT WORK.
  ENDMETHOD.

  METHOD delete_transaction.
    DATA ls_tstc TYPE tstc.
    DATA lv_tcode TYPE tstc-tcode.
    lv_tcode = s( 'tcode' ).

    " Step 1: confirm the transaction exists.
    SELECT SINGLE * FROM tstc INTO @ls_tstc WHERE tcode = @lv_tcode.
    IF sy-subrc <> 0.
      fail( |transaction { lv_tcode } does not exist| ).
      RETURN.
    ENDIF.

    " Step 2: delete via RPY_TRANSACTION_DELETE.
    CALL FUNCTION 'RPY_TRANSACTION_DELETE'
      EXPORTING transaction = lv_tcode
      EXCEPTIONS OTHERS = 1.
    IF sy-subrc <> 0.
      fail( |RPY_TRANSACTION_DELETE failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
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

export const tranPart: ClassicAbapPart = { methods: ["create_transaction", "delete_transaction"], source: SOURCE };
