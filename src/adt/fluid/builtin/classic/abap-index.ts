import type { ClassicAbapPart } from "./abap-core.js";

const CREATE_INDEX = `  METHOD create_index.
    DATA lv_index_name TYPE dd12v-indexname.
    lv_index_name = s( 'index_name' ).
    DATA lv_base_table TYPE tabname.
    lv_base_table = s( 'base_table' ).
    DATA lv_description TYPE dd12v-ddtext.
    lv_description = s( 'description' ).
    DATA(lv_corr_nr) = s( 'corr_nr' ).
    DATA(lv_unique) = b( 'unique' ).
    DATA lv_no_transp_request TYPE abap_bool.
    DATA lv_transport_number TYPE trkorr.
    DATA lt_fields TYPE STANDARD TABLE OF ddfldnam WITH DEFAULT KEY.
    DATA lv_actfailed TYPE ddrefstruc-flag.
    DATA lv_dd12v_count TYPE i.
    DATA lv_dd12v_any TYPE i.
    DATA lv_dd17s_count TYPE i.
    DATA lv_client_field TYPE dd03l-fieldname.
    DATA lv_field_count TYPE i.
    DATA lv_i TYPE i.

    IF lv_corr_nr IS INITIAL.
      lv_no_transp_request = abap_true.
    ELSE.
      lv_transport_number = lv_corr_nr.
    ENDIF.

    lv_field_count = n( 'fields' ).
    DO lv_field_count TIMES.
      lv_i = sy-index.
      APPEND VALUE #( name = s( |fields/{ lv_i - 1 }| ) ) TO lt_fields.
    ENDDO.

    " a unique secondary index on a client-dependent table must carry the client field, or
    " activation fails; confirmed live 2026-09-05 (round 2) as the cause of the ACTFAILED seen in
    " round 1 on a unique index over a client-dependent table.
    IF lv_unique = abap_true.
      SELECT SINGLE fieldname FROM dd03l INTO @lv_client_field
        WHERE tabname = @lv_base_table AND as4local = 'A' AND datatype = 'CLNT'.
      IF sy-subrc = 0 AND lv_client_field IS NOT INITIAL.
        READ TABLE lt_fields TRANSPORTING NO FIELDS WITH KEY name = lv_client_field.
        IF sy-subrc <> 0.
          fail( |unique index { lv_index_name } on { lv_base_table } omits the client field { lv_client_field }| ).
          RETURN.
        ENDIF.
      ENDIF.
    ENDIF.

    CALL FUNCTION 'DD_INDEX_INTERFACE'
      EXPORTING
        table_name          = lv_base_table
        index_name          = lv_index_name
        action              = 'I'
        shorttext           = lv_description
        activate            = 'X'
        unique              = lv_unique
        no_transp_request   = lv_no_transp_request
        transport_number    = lv_transport_number
      IMPORTING
        actfailed = lv_actfailed
      TABLES
        index_fields = lt_fields
      EXCEPTIONS
        cancelled = 1
        already_exist = 2
        permission_error = 3
        name_not_allowed = 4
        db_access_error = 5
        basetab_error = 6
        not_exist = 7
        OTHERS = 8.
    IF sy-subrc <> 0.
      fail( |DD_INDEX_INTERFACE insert failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
      RETURN.
    ENDIF.

    " DD_INDEX_INTERFACE exports no activation log; the cheapest evidence of what a failed
    " activation left behind is a DD12V row count with no AS4LOCAL filter at all.
    IF lv_actfailed = 'X'.
      SELECT COUNT( * ) FROM dd12v INTO @lv_dd12v_any
        WHERE sqltab = @lv_base_table AND indexname = @lv_index_name.
      fail( |DD_INDEX_INTERFACE insert reported ACTFAILED = 'X' for { lv_index_name } on { lv_base_table }; |
         && |DD12V rows for this pair after the failure, any AS4LOCAL: { lv_dd12v_any }| ).
      RETURN.
    ENDIF.
    line( 'INDEX-CREATED' ).

    COMMIT WORK.

    " Compared to 0, not <> 1 — DD12V carries DDLANGUAGE, so more than one row is possible.
    SELECT COUNT( * ) FROM dd12v INTO @lv_dd12v_count
      WHERE sqltab = @lv_base_table AND indexname = @lv_index_name AND as4local = 'A'.
    IF lv_dd12v_count = 0.
      fail( |{ lv_index_name } on { lv_base_table } not found active (AS4LOCAL = 'A') in DD12V after commit| ).
      RETURN.
    ENDIF.
    line( 'INDEX-ACTIVE' ).

    " Compared with <, not <> — a floor, not an exact match, since DD17S has not been established
    " to hold exactly one row per index field.
    SELECT COUNT( * ) FROM dd17s INTO @lv_dd17s_count
      WHERE sqltab = @lv_base_table AND indexname = @lv_index_name.
    IF lv_dd17s_count < lv_field_count.
      fail( |expected at least { lv_field_count } DD17S field row(s) for { lv_index_name } on { lv_base_table }, |
         && |got { lv_dd17s_count }| ).
      RETURN.
    ENDIF.
    line( 'INDEX-FIELDS' ).
  ENDMETHOD.`;

const DELETE_INDEX = `  METHOD delete_index.
    DATA lv_index_name TYPE dd12v-indexname.
    lv_index_name = s( 'index_name' ).
    DATA lv_base_table TYPE tabname.
    lv_base_table = s( 'base_table' ).
    DATA(lv_corr_nr) = s( 'corr_nr' ).
    DATA lv_no_transp_request TYPE abap_bool.
    DATA lv_transport_number TYPE trkorr.
    DATA lt_fields TYPE STANDARD TABLE OF ddfldnam WITH DEFAULT KEY.
    DATA lv_actfailed TYPE ddrefstruc-flag.
    DATA lv_dd12v_count TYPE i.
    DATA lv_dd12v_active TYPE i.
    DATA lv_dd17s_count TYPE i.
    DATA lv_msg TYPE string.

    IF lv_corr_nr IS INITIAL.
      lv_no_transp_request = abap_true.
    ELSE.
      lv_transport_number = lv_corr_nr.
    ENDIF.

    " a delete of a pair that never existed is a refusal, not a no-op. DD12V carries DDLANGUAGE,
    " so an index with no short text in the executing language could read as absent here —
    " refusing instead of deleting.
    SELECT COUNT( * ) FROM dd12v INTO @lv_dd12v_count
      WHERE sqltab = @lv_base_table AND indexname = @lv_index_name.
    IF lv_dd12v_count = 0.
      fail( |index { lv_index_name } on { lv_base_table } does not exist| ).
      RETURN.
    ENDIF.

    " DD_INDEX_INTERFACE requires INDEX_FIELDS for every ACTION, content or not; omitting it
    " failed live on 2026-09-05 with "the mandatory parameter INDEX_FIELDS was not filled".
    CALL FUNCTION 'DD_INDEX_INTERFACE'
      EXPORTING
        table_name          = lv_base_table
        index_name          = lv_index_name
        action              = 'D'
        activate            = 'X'
        no_transp_request   = lv_no_transp_request
        transport_number    = lv_transport_number
      IMPORTING
        actfailed = lv_actfailed
      TABLES
        index_fields = lt_fields
      EXCEPTIONS
        cancelled = 1
        already_exist = 2
        permission_error = 3
        name_not_allowed = 4
        db_access_error = 5
        basetab_error = 6
        not_exist = 7
        OTHERS = 8.
    IF sy-subrc <> 0.
      fail( |DD_INDEX_INTERFACE delete failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
      RETURN.
    ENDIF.

    " unconditional even when ACTFAILED = 'X'. Live 2026-09-05: on both a non-unique and a unique
    " index, ACTFAILED = 'X' fired while the DD12V row was already gone, meaning the catalog
    " change had already taken effect before this classrun's own commit point. ACTFAILED alone no
    " longer decides anything below; it only flags the read-back as worth a note.
    COMMIT WORK.

    " read back all three signals before deciding — same discipline as the create side, now
    " applied to ACTFAILED too instead of trusting it as fatal.
    SELECT COUNT( * ) FROM dd12v INTO @lv_dd12v_count
      WHERE sqltab = @lv_base_table AND indexname = @lv_index_name.
    SELECT COUNT( * ) FROM dd12v INTO @lv_dd12v_active
      WHERE sqltab = @lv_base_table AND indexname = @lv_index_name AND as4local = 'A'.
    SELECT COUNT( * ) FROM dd17s INTO @lv_dd17s_count
      WHERE sqltab = @lv_base_table AND indexname = @lv_index_name.

    " the read-back decides, not ACTFAILED. All-zero is success even when ACTFAILED = 'X' fired
    " (live 2026-09-05: the FM's own failure report lagged behind a catalog change that had
    " already committed); any row surviving is still a real failure either way. Each message is
    " built into lv_msg across several short lines and written once — never split across line()
    " calls, since parseDdicTranscript keeps only the LAST ZMCP-DDIC-ERR> line.
    IF lv_dd12v_count <> 0 OR lv_dd12v_active <> 0 OR lv_dd17s_count <> 0.
      lv_msg = |delete of { lv_index_name } on { lv_base_table } left rows behind after commit |.
      lv_msg = lv_msg && |(DD12V any: { lv_dd12v_count }, DD12V active: { lv_dd12v_active }, |.
      lv_msg = lv_msg && |DD17S: { lv_dd17s_count }); DD_INDEX_INTERFACE delete ACTFAILED = '{ lv_actfailed }'|.
      fail( lv_msg ).
      RETURN.
    ENDIF.
    IF lv_actfailed = 'X'.
      lv_msg = |ZMCP-DDIC-NOTE> DD_INDEX_INTERFACE delete reported ACTFAILED = 'X' for { lv_index_name } on |
             && |{ lv_base_table }, |.
      lv_msg = lv_msg && |but the post-commit read-back found it gone (DD12V any: { lv_dd12v_count }, |.
      lv_msg = lv_msg && |DD12V active: { lv_dd12v_active }, DD17S: { lv_dd17s_count }) — treating as deleted|.
      line( lv_msg ).
      line( 'INDEX-DELETED-ACTFAILED' ).
    ENDIF.
    line( 'INDEX-DELETED' ).
    line( 'INDEX-GONE' ).
  ENDMETHOD.`;

export const indexPart: ClassicAbapPart = {
  methods: ["create_index", "delete_index"],
  source: `${CREATE_INDEX}\n\n${DELETE_INDEX}`,
};
