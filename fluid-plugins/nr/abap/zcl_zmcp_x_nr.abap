CLASS zcl_zmcp_x_nr DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run IMPORTING iv_action TYPE string
                                iv_json   TYPE string.

  PRIVATE SECTION.
    TYPES: BEGIN OF ty_text,
             text       TYPE string,
             text_short TYPE string,
           END OF ty_text.
    TYPES tt_tnrot TYPE STANDARD TABLE OF tnrot.

    CLASS-METHODS do_list        RETURNING VALUE(rv_rc) TYPE i.
    CLASS-METHODS do_describe    RETURNING VALUE(rv_rc) TYPE i.
    CLASS-METHODS do_create      RETURNING VALUE(rv_rc) TYPE i.
    CLASS-METHODS do_set_interval RETURNING VALUE(rv_rc) TYPE i.
    CLASS-METHODS do_get_next    RETURNING VALUE(rv_rc) TYPE i.
    CLASS-METHODS do_delete      RETURNING VALUE(rv_rc) TYPE i.

    CLASS-METHODS obj_fields
      IMPORTING is_tnro        TYPE tnro
                is_text        TYPE ty_text
      RETURNING VALUE(rv_json) TYPE string.

    CLASS-METHODS find_text
      IMPORTING iv_object     TYPE tnro-object
                iv_lang       TYPE sy-langu
                it_tnrot      TYPE tt_tnrot
      RETURNING VALUE(rs_text) TYPE ty_text.

    CLASS-METHODS condense_up
      IMPORTING iv_text        TYPE string
      RETURNING VALUE(rv_text) TYPE string.

    CLASS-METHODS lpad_zero
      IMPORTING iv_value       TYPE string
                iv_target      TYPE i
      RETURNING VALUE(rv_value) TYPE string.

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

CLASS zcl_zmcp_x_nr IMPLEMENTATION.

  METHOD run.
    DATA lv_rc TYPE i.
    zcl_zmcp_fluid_rt=>begin( iv_id = 'nr' iv_action = iv_action ).
    TRY.
        zcl_zmcp_fluid_rt=>scan( iv_json ).
        CASE iv_action.
          WHEN 'list'.
            lv_rc = do_list( ).
          WHEN 'describe'.
            lv_rc = do_describe( ).
          WHEN 'create'.
            lv_rc = do_create( ).
          WHEN 'set_interval'.
            lv_rc = do_set_interval( ).
          WHEN 'get_next'.
            lv_rc = do_get_next( ).
          WHEN 'delete'.
            lv_rc = do_delete( ).
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


  METHOD condense_up.
    rv_text = iv_text.
    TRANSLATE rv_text TO UPPER CASE.
    CONDENSE rv_text NO-GAPS.
  ENDMETHOD.

  METHOD lpad_zero.
    rv_value = iv_value.
    WHILE strlen( rv_value ) < iv_target.
      rv_value = |0{ rv_value }|.
    ENDWHILE.
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

  METHOD find_text.
    DATA ls_row TYPE tnrot.
    CLEAR rs_text.
    READ TABLE it_tnrot INTO ls_row WITH KEY object = iv_object langu = iv_lang.
    IF sy-subrc <> 0.
      READ TABLE it_tnrot INTO ls_row WITH KEY object = iv_object.
    ENDIF.
    IF sy-subrc = 0.
      rs_text-text = ls_row-txt.
      rs_text-text_short = ls_row-txtshort.
    ENDIF.
  ENDMETHOD.

  METHOD obj_fields.
    DATA lv_pct    TYPE string.
    DATA lv_buf    TYPE string.
    DATA lv_bufsz  TYPE string.
    DATA lv_year   TYPE abap_bool.

    lv_pct = is_tnro-percentage.
    CONDENSE lv_pct.
    REPLACE ',' IN lv_pct WITH '.'.
    lv_buf = is_tnro-buffer.
    lv_bufsz = is_tnro-noivbuffer.
    CONDENSE lv_bufsz.
    IF is_tnro-yearind = 'X'.
      lv_year = abap_true.
    ELSE.
      lv_year = abap_false.
    ENDIF.

    rv_json = |"object":{ js( is_tnro-object ) },"text":{ js( is_text-text ) }|
           && |,"text_short":{ js( is_text-text_short ) },"domain":{ js( is_tnro-domlen ) }|
           && |,"percentage":{ js( lv_pct ) },"buffer":{ js( lv_buf ) },"buffer_size":{ js( lv_bufsz ) }|
           && |,"year_dependent":{ bool( lv_year ) },"subobject_element":{ js( is_tnro-dtelsobj ) }|.
  ENDMETHOD.


  METHOD do_list.
    DATA lv_pattern TYPE string.
    DATA lv_lang    TYPE sy-langu.
    DATA lv_max_txt TYPE string.
    DATA lv_max     TYPE i.
    DATA lt_tnro    TYPE STANDARD TABLE OF tnro.
    DATA lt_tnrot   TYPE tt_tnrot.
    DATA ls_tnro    TYPE tnro.
    DATA ls_text    TYPE ty_text.
    DATA lv_json    TYPE string.
    DATA lv_items   TYPE string.
    DATA lv_count   TYPE i.

    rv_rc = 0.
    lv_pattern = zcl_zmcp_fluid_rt=>s( 'pattern' ).
    IF lv_pattern IS INITIAL.
      lv_pattern = '*'.
    ENDIF.
    lv_lang = zcl_zmcp_fluid_rt=>s( 'language' ).
    IF lv_lang IS INITIAL.
      lv_lang = sy-langu.
    ENDIF.
    lv_max_txt = zcl_zmcp_fluid_rt=>s( 'max_rows' ).

    TRY.
        IF lv_max_txt IS INITIAL.
          lv_max = 0.
        ELSE.
          lv_max = lv_max_txt.
        ENDIF.
      CATCH cx_sy_conversion_error.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'args'
                                iv_text = |max_rows { lv_max_txt } is not a number| ).
        rv_rc = 4.
        RETURN.
    ENDTRY.

    REPLACE ALL OCCURRENCES OF '#' IN lv_pattern WITH '##'.
    REPLACE ALL OCCURRENCES OF '_' IN lv_pattern WITH '#_'.
    REPLACE ALL OCCURRENCES OF '%' IN lv_pattern WITH '#%'.
    REPLACE ALL OCCURRENCES OF '*' IN lv_pattern WITH '%'.
    REPLACE ALL OCCURRENCES OF '+' IN lv_pattern WITH '_'.

    IF lv_max > 0.
      SELECT object domlen percentage buffer noivbuffer yearind dtelsobj
        FROM tnro INTO CORRESPONDING FIELDS OF TABLE lt_tnro
        UP TO lv_max ROWS
        WHERE object LIKE lv_pattern ESCAPE '#'
        ORDER BY object.
    ELSE.
      SELECT object domlen percentage buffer noivbuffer yearind dtelsobj
        FROM tnro INTO CORRESPONDING FIELDS OF TABLE lt_tnro
        WHERE object LIKE lv_pattern ESCAPE '#'
        ORDER BY object.
    ENDIF.

    IF lt_tnro IS NOT INITIAL.
      SELECT object langu txt txtshort FROM tnrot INTO CORRESPONDING FIELDS OF TABLE lt_tnrot
        FOR ALL ENTRIES IN lt_tnro WHERE object = lt_tnro-object.
    ENDIF.

    lv_items = ''.
    lv_count = 0.
    LOOP AT lt_tnro INTO ls_tnro.
      lv_count = lv_count + 1.
      ls_text = find_text( iv_object = ls_tnro-object iv_lang = lv_lang it_tnrot = lt_tnrot ).
      IF lv_count > 1.
        lv_items = lv_items && ','.
      ENDIF.
      lv_items = lv_items && |\{{ obj_fields( is_tnro = ls_tnro is_text = ls_text ) }\}|.
    ENDLOOP.

    lv_json = |\{"count":{ lv_count },"objects":[{ lv_items }]\}|.
    zcl_zmcp_fluid_rt=>out( lv_json ).
  ENDMETHOD.


  METHOD do_describe.
    DATA lv_object  TYPE tnro-object.
    DATA lv_lang    TYPE sy-langu.
    DATA ls_tnro    TYPE tnro.
    DATA lt_tnrot   TYPE tt_tnrot.
    DATA ls_text    TYPE ty_text.
    DATA lv_package TYPE string.
    DATA ls_tadir   TYPE tadir.
    DATA lt_nriv    TYPE STANDARD TABLE OF nriv.
    DATA ls_nriv    TYPE nriv.
    DATA lv_json    TYPE string.
    DATA lv_items   TYPE string.
    DATA lv_count   TYPE i.
    DATA lv_ext     TYPE abap_bool.

    rv_rc = 0.
    lv_object = condense_up( zcl_zmcp_fluid_rt=>s( 'object' ) ).
    lv_lang = zcl_zmcp_fluid_rt=>s( 'language' ).
    IF lv_lang IS INITIAL.
      lv_lang = sy-langu.
    ENDIF.

    IF lv_object IS INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'args' iv_text = 'object is required' ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    SELECT SINGLE object domlen percentage buffer noivbuffer yearind dtelsobj
      FROM tnro INTO CORRESPONDING FIELDS OF ls_tnro WHERE object = lv_object.
    IF sy-subrc <> 0.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'lookup'
                              iv_text = |object { lv_object } not found| ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    SELECT object langu txt txtshort FROM tnrot INTO CORRESPONDING FIELDS OF TABLE lt_tnrot WHERE object = lv_object.
    ls_text = find_text( iv_object = lv_object iv_lang = lv_lang it_tnrot = lt_tnrot ).

    lv_package = ''.
    SELECT SINGLE devclass FROM tadir INTO ls_tadir-devclass
      WHERE pgmid = 'R3TR' AND object = 'NROB' AND obj_name = lv_object.
    IF sy-subrc = 0.
      lv_package = ls_tadir-devclass.
      CONDENSE lv_package.
    ENDIF.

    SELECT * FROM nriv INTO TABLE lt_nriv WHERE object = lv_object
      ORDER BY subobject nrrangenr toyear.
    lv_count = lines( lt_nriv ).

    lv_items = ''.
    LOOP AT lt_nriv INTO ls_nriv.
      IF sy-tabix > 1.
        lv_items = lv_items && ','.
      ENDIF.
      IF ls_nriv-externind = 'X'.
        lv_ext = abap_true.
      ELSE.
        lv_ext = abap_false.
      ENDIF.
      lv_items = lv_items
        && |\{"subobject":{ js( ls_nriv-subobject ) },"nrrangenr":{ js( ls_nriv-nrrangenr ) }|
        && |,"toyear":{ js( ls_nriv-toyear ) },"fromnumber":{ js( ls_nriv-fromnumber ) }|
        && |,"tonumber":{ js( ls_nriv-tonumber ) },"nrlevel":{ js( ls_nriv-nrlevel ) }|
        && |,"external":{ bool( lv_ext ) }\}|.
    ENDLOOP.

    lv_json = |\{{ obj_fields( is_tnro = ls_tnro is_text = ls_text ) }|
           && |,"package":{ js( lv_package ) },"interval_count":{ lv_count }|
           && |,"intervals":[{ lv_items }]\}|.
    zcl_zmcp_fluid_rt=>out( lv_json ).
  ENDMETHOD.


  METHOD do_create.
    DATA lv_object      TYPE tnro-object.
    DATA lv_text        TYPE string.
    DATA lv_text_short  TYPE string.
    DATA lv_domain      TYPE tnro-domlen.
    DATA lv_package     TYPE string.
    DATA lv_corr        TYPE string.
    DATA lv_pct_txt     TYPE string.
    DATA lv_bufsize_txt TYPE string.
    DATA lv_buffer_off  TYPE abap_bool.
    DATA lv_year        TYPE abap_bool.
    DATA ls_tnro        TYPE tnro.
    DATA ls_tnrot       TYPE tnrot.
    DATA lv_check       TYPE tnro-object.
    DATA lv_ret         TYPE sy-msgty.
    DATA lt_errors      TYPE STANDARD TABLE OF inoer.
    DATA ls_error       TYPE inoer.
    DATA lv_subrc       TYPE i.
    DATA lv_exc         TYPE string.
    DATA lv_msgtext     TYPE string.
    DATA lv_errtext     TYPE string.
    DATA lt_warnings    TYPE string_table.
    DATA lv_order       TYPE e070-trkorr.
    DATA ls_ko200       TYPE ko200.
    DATA lv_we_order    TYPE e070-trkorr.
    DATA lv_we_task     TYPE e070-trkorr.
    DATA lv_json        TYPE string.
    DATA lv_wjson       TYPE string.
    DATA lv_first       TYPE abap_bool.
    DATA lv_tadir_objname   TYPE tadir-obj_name.
    DATA lv_tadir_devclass  TYPE tadir-devclass.
    DATA lv_tadir_srcsystem TYPE tadir-srcsystem.

    rv_rc = 0.
    lv_object = condense_up( zcl_zmcp_fluid_rt=>s( 'object' ) ).
    lv_text = zcl_zmcp_fluid_rt=>s( 'text' ).
    lv_domain = condense_up( zcl_zmcp_fluid_rt=>s( 'domain' ) ).
    lv_package = condense_up( zcl_zmcp_fluid_rt=>s( 'package' ) ).
    lv_corr = condense_up( zcl_zmcp_fluid_rt=>s( 'corr_nr' ) ).
    lv_text_short = zcl_zmcp_fluid_rt=>s( 'text_short' ).
    lv_pct_txt = zcl_zmcp_fluid_rt=>s( 'percentage' ).
    lv_buffer_off = zcl_zmcp_fluid_rt=>b( 'buffer_off' ).
    lv_bufsize_txt = zcl_zmcp_fluid_rt=>s( 'buffer_size' ).
    lv_year = zcl_zmcp_fluid_rt=>b( 'year_dependent' ).

    IF lv_object IS INITIAL OR lv_text IS INITIAL OR lv_domain IS INITIAL OR lv_package IS INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'args'
                              iv_text = 'object, text, domain and package are required' ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    IF lv_text_short IS INITIAL.
      lv_text_short = lv_text.
      IF strlen( lv_text_short ) > 20.
        lv_text_short = substring( val = lv_text_short off = 0 len = 20 ).
      ENDIF.
    ENDIF.
    IF lv_pct_txt IS INITIAL.
      lv_pct_txt = '10'.
    ENDIF.
    IF lv_bufsize_txt IS INITIAL.
      lv_bufsize_txt = '10'.
    ENDIF.

    IF lv_package(1) <> '$' AND lv_corr IS INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'args'
                              iv_text = 'corr_nr is required for a transportable package' ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    CLEAR ls_tnro.
    ls_tnro-object = lv_object.
    ls_tnro-domlen = lv_domain.
    IF lv_year = abap_true.
      ls_tnro-yearind = 'X'.
    ENDIF.

    TRY.
        ls_tnro-percentage = lv_pct_txt.
        IF lv_buffer_off = abap_true.
          ls_tnro-buffer = space.
          ls_tnro-noivbuffer = 0.
        ELSE.
          ls_tnro-buffer = 'X'.
          ls_tnro-noivbuffer = lv_bufsize_txt.
        ENDIF.
      CATCH cx_sy_conversion_error.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'args'
                                iv_text = 'percentage or buffer_size is not a number' ).
        rv_rc = 4.
        RETURN.
    ENDTRY.

    SELECT SINGLE object FROM tnro INTO lv_check WHERE object = lv_object.
    IF sy-subrc = 0.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'lookup'
                              iv_text = |object { lv_object } already exists| ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    CLEAR ls_tnrot.
    ls_tnrot-langu = sy-langu.
    ls_tnrot-object = lv_object.
    ls_tnrot-txt = lv_text.
    ls_tnrot-txtshort = lv_text_short.

    CALL FUNCTION 'NUMBER_RANGE_OBJECT_UPDATE'
      EXPORTING
        indicator         = 'I'
        object_attributes = ls_tnro
        object_text       = ls_tnrot
      IMPORTING
        returncode        = lv_ret
      TABLES
        errors            = lt_errors
      EXCEPTIONS
        object_already_exists     = 1
        object_attributes_missing = 2
        object_not_found          = 3
        object_text_missing       = 4
        wrong_indicator            = 5
        error_message                = 6
        OTHERS                        = 7.
    lv_subrc = sy-subrc.
    IF lv_subrc <> 0.
      CASE lv_subrc.
        WHEN 1. lv_exc = 'OBJECT_ALREADY_EXISTS'.
        WHEN 2. lv_exc = 'OBJECT_ATTRIBUTES_MISSING'.
        WHEN 3. lv_exc = 'OBJECT_NOT_FOUND'.
        WHEN 4. lv_exc = 'OBJECT_TEXT_MISSING'.
        WHEN 5. lv_exc = 'WRONG_INDICATOR'.
        WHEN 6. lv_exc = 'ERROR_MESSAGE'.
        WHEN OTHERS. lv_exc = 'OTHERS'.
      ENDCASE.
      fm_fail( iv_step = 'object_update' iv_fm = 'NUMBER_RANGE_OBJECT_UPDATE'
               iv_subrc = lv_subrc iv_exc = lv_exc ).
      rv_rc = 8.
      RETURN.
    ENDIF.

    IF lv_ret = 'E' OR lv_ret = 'A'.
      lv_errtext = ''.
      LOOP AT lt_errors INTO ls_error.
        CLEAR lv_msgtext.
        IF ls_error-msgid IS NOT INITIAL.
          MESSAGE ID ls_error-msgid TYPE 'S' NUMBER ls_error-msgnumber
            WITH ls_error-msgvar1 ls_error-msgvar2 ls_error-msgvar3 ls_error-msgvar4
            INTO lv_msgtext.
        ENDIF.
        IF lv_errtext IS NOT INITIAL.
          lv_errtext = lv_errtext && '; '.
        ENDIF.
        lv_errtext = lv_errtext && lv_msgtext.
      ENDLOOP.
      IF lv_errtext IS INITIAL.
        lv_errtext = 'NUMBER_RANGE_OBJECT_UPDATE reported an error'.
      ENDIF.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'object_update' iv_text = lv_errtext ).
      rv_rc = 4.
      RETURN.
    ELSEIF lv_ret = 'W'.
      LOOP AT lt_errors INTO ls_error.
        CLEAR lv_msgtext.
        IF ls_error-msgid IS NOT INITIAL.
          MESSAGE ID ls_error-msgid TYPE 'S' NUMBER ls_error-msgnumber
            WITH ls_error-msgvar1 ls_error-msgvar2 ls_error-msgvar3 ls_error-msgvar4
            INTO lv_msgtext.
          APPEND lv_msgtext TO lt_warnings.
        ENDIF.
      ENDLOOP.
    ENDIF.

    lv_tadir_objname = lv_object.
    lv_tadir_devclass = lv_package.
    lv_tadir_srcsystem = sy-sysid.
    CALL FUNCTION 'TR_TADIR_INTERFACE'
      EXPORTING
        wi_test_modus      = space
        wi_tadir_pgmid      = 'R3TR'
        wi_tadir_object     = 'NROB'
        wi_tadir_obj_name   = lv_tadir_objname
        wi_tadir_devclass   = lv_tadir_devclass
        wi_tadir_masterlang = sy-langu
        wi_tadir_author     = sy-uname
        wi_tadir_srcsystem  = lv_tadir_srcsystem
      EXCEPTIONS
        error_message = 1
        OTHERS        = 2.
    lv_subrc = sy-subrc.
    IF lv_subrc <> 0.
      IF lv_subrc = 1.
        lv_exc = 'ERROR_MESSAGE'.
      ELSE.
        lv_exc = 'OTHERS'.
      ENDIF.
      fm_fail( iv_step = 'tadir' iv_fm = 'TR_TADIR_INTERFACE' iv_subrc = lv_subrc iv_exc = lv_exc ).
      rv_rc = 8.
      RETURN.
    ENDIF.

    IF lv_package(1) <> '$'.
      CLEAR ls_ko200.
      ls_ko200-pgmid = 'R3TR'.
      ls_ko200-object = 'NROB'.
      ls_ko200-obj_name = lv_object.
      ls_ko200-devclass = lv_package.
      lv_order = lv_corr.
      CALL FUNCTION 'TR_OBJECT_INSERT'
        EXPORTING
          wi_order              = lv_order
          wi_ko200               = ls_ko200
          iv_no_standard_editor = 'X'
          iv_no_show_option     = 'X'
        IMPORTING
          we_order = lv_we_order
          we_task  = lv_we_task
        EXCEPTIONS
          cancel_edit_other_error = 1
          show_only_other_error    = 2
          error_message               = 3
          OTHERS                        = 4.
      lv_subrc = sy-subrc.
      IF lv_subrc <> 0.
        CASE lv_subrc.
          WHEN 1. lv_exc = 'CANCEL_EDIT_OTHER_ERROR'.
          WHEN 2. lv_exc = 'SHOW_ONLY_OTHER_ERROR'.
          WHEN 3. lv_exc = 'ERROR_MESSAGE'.
          WHEN OTHERS. lv_exc = 'OTHERS'.
        ENDCASE.
        fm_fail( iv_step = 'transport' iv_fm = 'TR_OBJECT_INSERT' iv_subrc = lv_subrc iv_exc = lv_exc ).
        rv_rc = 8.
        RETURN.
      ENDIF.
    ENDIF.

    CALL FUNCTION 'NUMBER_RANGE_OBJECT_CLOSE'
      EXPORTING
        object = lv_object
      EXCEPTIONS
        object_not_initialized = 1
        error_message              = 2
        OTHERS                        = 3.
    lv_subrc = sy-subrc.
    IF lv_subrc <> 0.
      IF lv_subrc = 1.
        lv_exc = 'OBJECT_NOT_INITIALIZED'.
      ELSEIF lv_subrc = 2.
        lv_exc = 'ERROR_MESSAGE'.
      ELSE.
        lv_exc = 'OTHERS'.
      ENDIF.
      fm_fail( iv_step = 'close' iv_fm = 'NUMBER_RANGE_OBJECT_CLOSE' iv_subrc = lv_subrc iv_exc = lv_exc ).
      rv_rc = 8.
      RETURN.
    ENDIF.

    lv_wjson = ''.
    lv_first = abap_true.
    LOOP AT lt_warnings INTO lv_msgtext.
      IF lv_first = abap_false.
        lv_wjson = lv_wjson && ','.
      ENDIF.
      lv_first = abap_false.
      lv_wjson = lv_wjson && js( lv_msgtext ).
    ENDLOOP.

    lv_json = |\{"object":{ js( lv_object ) },"created":true,"package":{ js( lv_package ) }|
           && |,"transport":{ js( lv_corr ) },"warnings":[{ lv_wjson }]\}|.
    zcl_zmcp_fluid_rt=>out( lv_json ).
  ENDMETHOD.


  METHOD do_set_interval.
    DATA lv_object      TYPE tnro-object.
    DATA lv_subobject    TYPE inriv-subobject.
    DATA lv_nrrangenr    TYPE inriv-nrrangenr.
    DATA lv_toyear       TYPE inriv-toyear.
    DATA lv_from         TYPE inriv-fromnumber.
    DATA lv_to           TYPE inriv-tonumber.
    DATA lv_from_s       TYPE string.
    DATA lv_to_s         TYPE string.
    DATA lv_external     TYPE abap_bool.
    DATA lv_level_txt    TYPE string.
    DATA lv_have_level   TYPE abap_bool.
    DATA lv_nrlevel      TYPE inriv-nrlevel.
    DATA ls_tnro         TYPE tnro.
    DATA lv_leng         TYPE dd01l-leng.
    DATA lv_leng_i       TYPE i.
    DATA lv_subrc        TYPE i.
    DATA lv_exc          TYPE string.
    DATA lt_list         TYPE STANDARD TABLE OF inriv.
    DATA ls_row          TYPE inriv.
    DATA lv_found        TYPE abap_bool.
    DATA lv_mode         TYPE string.
    DATA lt_upd          TYPE STANDARD TABLE OF inriv.
    DATA lt_updx         TYPE STANDARD TABLE OF inriv.
    DATA ls_error        TYPE inrer.
    DATA lv_err_occ      TYPE c LENGTH 1.
    DATA lv_warn_occ     TYPE c LENGTH 1.
    DATA lt_warnings     TYPE string_table.
    DATA lv_failed       TYPE abap_bool.
    DATA lv_changed      TYPE abap_bool.
    DATA lv_msgtext      TYPE string.
    DATA lv_json         TYPE string.
    DATA lv_wjson        TYPE string.
    DATA lv_first        TYPE abap_bool.

    rv_rc = 0.
    lv_failed = abap_false.
    lv_changed = abap_true.

    lv_object = condense_up( zcl_zmcp_fluid_rt=>s( 'object' ) ).
    lv_subobject = condense_up( zcl_zmcp_fluid_rt=>s( 'subobject' ) ).
    lv_nrrangenr = condense_up( zcl_zmcp_fluid_rt=>s( 'nrrangenr' ) ).
    lv_toyear = zcl_zmcp_fluid_rt=>s( 'toyear' ).
    IF lv_toyear IS INITIAL.
      lv_toyear = '0000'.
    ENDIF.
    lv_from_s = zcl_zmcp_fluid_rt=>s( 'fromnumber' ).
    CONDENSE lv_from_s NO-GAPS.
    lv_to_s = zcl_zmcp_fluid_rt=>s( 'tonumber' ).
    CONDENSE lv_to_s NO-GAPS.
    lv_external = zcl_zmcp_fluid_rt=>b( 'external' ).
    lv_level_txt = zcl_zmcp_fluid_rt=>s( 'nrlevel' ).
    lv_have_level = boolc( lv_level_txt IS NOT INITIAL ).

    IF lv_object IS INITIAL OR lv_nrrangenr IS INITIAL
       OR zcl_zmcp_fluid_rt=>s( 'fromnumber' ) IS INITIAL
       OR zcl_zmcp_fluid_rt=>s( 'tonumber' ) IS INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'args'
        iv_text = 'object, nrrangenr, fromnumber and tonumber are required' ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    IF strlen( lv_from_s ) > 20 OR strlen( lv_to_s ) > 20.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'args'
        iv_text = 'fromnumber and tonumber must not exceed 20 characters' ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    IF lv_have_level = abap_true.
      TRY.
          lv_nrlevel = lv_level_txt.
        CATCH cx_sy_conversion_error.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'args'
            iv_text = |nrlevel { lv_level_txt } is not a number| ).
          rv_rc = 4.
          RETURN.
      ENDTRY.
    ENDIF.

    SELECT SINGLE * FROM tnro INTO ls_tnro WHERE object = lv_object.
    IF sy-subrc <> 0.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'lookup'
                              iv_text = |object { lv_object } not found| ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    IF lv_external = abap_false.
      SELECT SINGLE leng FROM dd01l INTO lv_leng
        WHERE domname = ls_tnro-domlen AND as4local = 'A'.
      IF sy-subrc = 0.
        lv_leng_i = lv_leng.
        IF lv_from_s IS NOT INITIAL AND lv_from_s CO '0123456789' AND strlen( lv_from_s ) < lv_leng_i.
          lv_from_s = lpad_zero( iv_value = lv_from_s iv_target = lv_leng_i ).
        ENDIF.
        IF lv_to_s IS NOT INITIAL AND lv_to_s CO '0123456789' AND strlen( lv_to_s ) < lv_leng_i.
          lv_to_s = lpad_zero( iv_value = lv_to_s iv_target = lv_leng_i ).
        ENDIF.
      ENDIF.
    ENDIF.
    lv_from = lv_from_s.
    lv_to = lv_to_s.

    CALL FUNCTION 'NUMBER_RANGE_ENQUEUE'
      EXPORTING object = lv_object
      EXCEPTIONS
        foreign_lock     = 1
        object_not_found = 2
        system_failure    = 3
        error_message        = 4
        OTHERS                = 5.
    lv_subrc = sy-subrc.
    IF lv_subrc <> 0.
      CASE lv_subrc.
        WHEN 1. lv_exc = 'FOREIGN_LOCK'.
        WHEN 2. lv_exc = 'OBJECT_NOT_FOUND'.
        WHEN 3. lv_exc = 'SYSTEM_FAILURE'.
        WHEN 4. lv_exc = 'ERROR_MESSAGE'.
        WHEN OTHERS. lv_exc = 'OTHERS'.
      ENDCASE.
      fm_fail( iv_step = 'enqueue' iv_fm = 'NUMBER_RANGE_ENQUEUE' iv_subrc = lv_subrc iv_exc = lv_exc ).
      rv_rc = 8.
      RETURN.
    ENDIF.

    CALL FUNCTION 'NUMBER_RANGE_INTERVAL_LIST'
      EXPORTING
        object    = lv_object
        subobject = lv_subobject
      TABLES interval = lt_list
      EXCEPTIONS
        nr_range_nr1_not_found      = 1
        nr_range_nr1_not_intern     = 2
        nr_range_nr2_must_be_space  = 3
        nr_range_nr2_not_extern     = 4
        nr_range_nr2_not_found      = 5
        object_not_found              = 6
        subobject_must_be_space       = 7
        subobject_not_found           = 8
        error_message                    = 9
        OTHERS                            = 10.
    lv_subrc = sy-subrc.
    IF lv_subrc <> 0.
      CASE lv_subrc.
        WHEN 1. lv_exc = 'NR_RANGE_NR1_NOT_FOUND'.
        WHEN 2. lv_exc = 'NR_RANGE_NR1_NOT_INTERN'.
        WHEN 3. lv_exc = 'NR_RANGE_NR2_MUST_BE_SPACE'.
        WHEN 4. lv_exc = 'NR_RANGE_NR2_NOT_EXTERN'.
        WHEN 5. lv_exc = 'NR_RANGE_NR2_NOT_FOUND'.
        WHEN 6. lv_exc = 'OBJECT_NOT_FOUND'.
        WHEN 7. lv_exc = 'SUBOBJECT_MUST_BE_SPACE'.
        WHEN 8. lv_exc = 'SUBOBJECT_NOT_FOUND'.
        WHEN 9. lv_exc = 'ERROR_MESSAGE'.
        WHEN OTHERS. lv_exc = 'OTHERS'.
      ENDCASE.
      fm_fail( iv_step = 'interval_list' iv_fm = 'NUMBER_RANGE_INTERVAL_LIST'
               iv_subrc = lv_subrc iv_exc = lv_exc ).
      lv_failed = abap_true.
      rv_rc = 8.
    ENDIF.

    IF lv_failed = abap_false.
      lv_found = abap_false.
      LOOP AT lt_list INTO ls_row WHERE nrrangenr = lv_nrrangenr AND toyear = lv_toyear.
        lv_found = abap_true.
        EXIT.
      ENDLOOP.

      IF lv_found = abap_true.
        lv_mode = 'update'.
        ls_row-procind = 'U'.
        ls_row-fromnumber = lv_from.
        ls_row-tonumber = lv_to.
        IF lv_external = abap_true.
          ls_row-externind = 'X'.
        ELSE.
          CLEAR ls_row-externind.
        ENDIF.
        IF lv_have_level = abap_true.
          ls_row-nrlevel = lv_nrlevel.
        ENDIF.
      ELSE.
        lv_mode = 'insert'.
        CLEAR ls_row.
        ls_row-subobject = lv_subobject.
        ls_row-nrrangenr = lv_nrrangenr.
        ls_row-toyear = lv_toyear.
        ls_row-fromnumber = lv_from.
        ls_row-tonumber = lv_to.
        ls_row-procind = 'I'.
        IF lv_external = abap_true.
          ls_row-externind = 'X'.
        ENDIF.
        IF lv_have_level = abap_true.
          ls_row-nrlevel = lv_nrlevel.
        ELSE.
          ls_row-nrlevel = 0.
        ENDIF.
      ENDIF.
      CLEAR lt_upd.
      APPEND ls_row TO lt_upd.

      CALL FUNCTION 'NUMBER_RANGE_INTERVAL_UPDATE'
        EXPORTING
          object    = lv_object
          subobject = lv_subobject
        IMPORTING
          error           = ls_error
          error_occured   = lv_err_occ
          warning_occured = lv_warn_occ
        TABLES
          error_iv = lt_updx
          interval = lt_upd
        EXCEPTIONS
          object_not_found = 1
          error_message        = 2
          OTHERS                 = 3.
      lv_subrc = sy-subrc.
      IF lv_subrc <> 0.
        IF lv_subrc = 1.
          lv_exc = 'OBJECT_NOT_FOUND'.
        ELSEIF lv_subrc = 2.
          lv_exc = 'ERROR_MESSAGE'.
        ELSE.
          lv_exc = 'OTHERS'.
        ENDIF.
        fm_fail( iv_step = 'interval_update' iv_fm = 'NUMBER_RANGE_INTERVAL_UPDATE'
                 iv_subrc = lv_subrc iv_exc = lv_exc ).
        lv_failed = abap_true.
        rv_rc = 8.
      ELSEIF lv_err_occ = 'X'.
        CLEAR lv_msgtext.
        MESSAGE ID 'NR' TYPE 'S' NUMBER ls_error-msgnr INTO lv_msgtext.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'interval_update'
          iv_text = |{ lv_msgtext } (field { ls_error-fieldname })| ).
        lv_failed = abap_true.
        rv_rc = 4.
      ELSE.
        IF lv_warn_occ = 'X'.
          APPEND |NUMBER_RANGE_INTERVAL_UPDATE reported a warning for { lv_object }| TO lt_warnings.
        ENDIF.
      ENDIF.
    ENDIF.

    IF lv_failed = abap_false.
      CALL FUNCTION 'NUMBER_RANGE_UPDATE_CLOSE'
        EXPORTING object = lv_object
        EXCEPTIONS
          no_changes_made         = 1
          object_not_initialized  = 2
          error_message               = 3
          OTHERS                        = 4.
      lv_subrc = sy-subrc.
      IF lv_subrc = 1.
        lv_changed = abap_false.
      ELSEIF lv_subrc <> 0.
        IF lv_subrc = 2.
          lv_exc = 'OBJECT_NOT_INITIALIZED'.
        ELSEIF lv_subrc = 3.
          lv_exc = 'ERROR_MESSAGE'.
        ELSE.
          lv_exc = 'OTHERS'.
        ENDIF.
        fm_fail( iv_step = 'update_close' iv_fm = 'NUMBER_RANGE_UPDATE_CLOSE'
                 iv_subrc = lv_subrc iv_exc = lv_exc ).
        lv_failed = abap_true.
        rv_rc = 8.
      ENDIF.
    ENDIF.

    CALL FUNCTION 'NUMBER_RANGE_DEQUEUE'
      EXPORTING object = lv_object
      EXCEPTIONS
        object_not_found = 1
        error_message        = 2
        OTHERS                 = 3.

    IF lv_failed = abap_true.
      RETURN.
    ENDIF.

    lv_wjson = ''.
    lv_first = abap_true.
    LOOP AT lt_warnings INTO lv_msgtext.
      IF lv_first = abap_false.
        lv_wjson = lv_wjson && ','.
      ENDIF.
      lv_first = abap_false.
      lv_wjson = lv_wjson && js( lv_msgtext ).
    ENDLOOP.

    lv_json = |\{"object":{ js( lv_object ) },"subobject":{ js( lv_subobject ) }|
      && |,"nrrangenr":{ js( lv_nrrangenr ) },"toyear":{ js( lv_toyear ) },"mode":{ js( lv_mode ) }|
      && |,"changed":{ bool( lv_changed ) },"fromnumber":{ js( ls_row-fromnumber ) }|
      && |,"tonumber":{ js( ls_row-tonumber ) },"nrlevel":{ js( ls_row-nrlevel ) }|
      && |,"external":{ bool( lv_external ) },"warnings":[{ lv_wjson }]\}|.
    zcl_zmcp_fluid_rt=>out( lv_json ).
  ENDMETHOD.


  METHOD do_get_next.
    DATA lv_object        TYPE inri-object.
    DATA lv_nrrangenr     TYPE inri-nrrangenr.
    DATA lv_subobject     TYPE string.
    DATA lv_toyear        TYPE inri-toyear.
    DATA lv_quantity      TYPE inri-quantity.
    DATA lv_ignore_buffer TYPE string.
    DATA lv_number        TYPE c LENGTH 20.
    DATA lv_quantity_out  TYPE inri-quantity.
    DATA lv_returncode    TYPE inri-returncode.
    DATA lv_subrc         TYPE i.
    DATA lv_exc           TYPE string.
    DATA lv_rc_text       TYPE string.
    DATA lv_json          TYPE string.

    rv_rc = 0.
    lv_object = condense_up( zcl_zmcp_fluid_rt=>s( 'object' ) ).
    lv_nrrangenr = condense_up( zcl_zmcp_fluid_rt=>s( 'nrrangenr' ) ).
    lv_subobject = zcl_zmcp_fluid_rt=>s( 'subobject' ).
    lv_toyear = zcl_zmcp_fluid_rt=>s( 'toyear' ).
    IF lv_toyear IS INITIAL.
      lv_toyear = '0000'.
    ENDIF.
    lv_quantity = zcl_zmcp_fluid_rt=>s( 'quantity' ).
    IF lv_quantity IS INITIAL.
      lv_quantity = '1'.
    ENDIF.
    IF zcl_zmcp_fluid_rt=>b( 'ignore_buffer' ) = abap_true.
      lv_ignore_buffer = 'X'.
    ELSE.
      lv_ignore_buffer = space.
    ENDIF.

    IF lv_object IS INITIAL OR lv_nrrangenr IS INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'args'
                              iv_text = 'object and nrrangenr are required' ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    CALL FUNCTION 'NUMBER_GET_NEXT'
      EXPORTING
        nr_range_nr   = lv_nrrangenr
        object        = lv_object
        quantity      = lv_quantity
        subobject     = lv_subobject
        toyear        = lv_toyear
        ignore_buffer = lv_ignore_buffer
      IMPORTING
        number     = lv_number
        quantity   = lv_quantity_out
        returncode = lv_returncode
      EXCEPTIONS
        interval_not_found      = 1
        number_range_not_intern = 2
        object_not_found         = 3
        quantity_is_0            = 4
        quantity_is_not_1        = 5
        interval_overflow        = 6
        buffer_overflow           = 7
        error_message               = 8
        OTHERS                        = 9.
    lv_subrc = sy-subrc.
    IF lv_subrc <> 0.
      CASE lv_subrc.
        WHEN 1. lv_exc = 'INTERVAL_NOT_FOUND'.
        WHEN 2. lv_exc = 'NUMBER_RANGE_NOT_INTERN'.
        WHEN 3. lv_exc = 'OBJECT_NOT_FOUND'.
        WHEN 4. lv_exc = 'QUANTITY_IS_0'.
        WHEN 5. lv_exc = 'QUANTITY_IS_NOT_1'.
        WHEN 6. lv_exc = 'INTERVAL_OVERFLOW'.
        WHEN 7. lv_exc = 'BUFFER_OVERFLOW'.
        WHEN 8. lv_exc = 'ERROR_MESSAGE'.
        WHEN OTHERS. lv_exc = 'OTHERS'.
      ENDCASE.
      fm_fail( iv_step = 'get_next' iv_fm = 'NUMBER_GET_NEXT' iv_subrc = lv_subrc iv_exc = lv_exc ).
      rv_rc = 8.
      RETURN.
    ENDIF.

    CASE lv_returncode.
      WHEN ' '.
        lv_rc_text = 'ok'.
      WHEN '1'.
        lv_rc_text = 'number is in the critical (warning percentage) area'.
      WHEN '2'.
        lv_rc_text = 'last number of the interval was drawn'.
      WHEN '3'.
        lv_rc_text = 'fewer numbers available than requested; quantity reduced'.
      WHEN OTHERS.
        lv_rc_text = ''.
    ENDCASE.

    lv_json = |\{"object":{ js( lv_object ) },"nrrangenr":{ js( lv_nrrangenr ) }|
      && |,"number":{ js( lv_number ) },"quantity":{ js( lv_quantity_out ) }|
      && |,"returncode":{ js( lv_returncode ) },"returncode_text":{ js( lv_rc_text ) }\}|.
    zcl_zmcp_fluid_rt=>out( lv_json ).
  ENDMETHOD.


  METHOD do_delete.
    DATA lv_object           TYPE tnro-object.
    DATA lv_package          TYPE string.
    DATA lv_corr             TYPE string.
    DATA lv_with_intervals   TYPE abap_bool.
    DATA lv_force            TYPE abap_bool.
    DATA ls_tnro             TYPE tnro.
    DATA lv_tadir_found      TYPE abap_bool.
    DATA ls_tadir            TYPE tadir.
    DATA lv_eff_package      TYPE string.
    DATA lt_nriv             TYPE STANDARD TABLE OF nriv.
    DATA ls_nriv             TYPE nriv.
    DATA lv_iv_count         TYPE i.
    DATA lv_used_count       TYPE i.
    DATA lv_used_list        TYPE string.
    DATA lv_subrc            TYPE i.
    DATA lv_exc              TYPE string.
    DATA lv_failed           TYPE abap_bool.
    DATA lt_list             TYPE STANDARD TABLE OF inriv.
    DATA ls_row              TYPE inriv.
    DATA lt_upd              TYPE STANDARD TABLE OF inriv.
    DATA lt_updx             TYPE STANDARD TABLE OF inriv.
    DATA ls_error            TYPE inrer.
    DATA lv_err_occ          TYPE c LENGTH 1.
    DATA lv_warn_occ         TYPE c LENGTH 1.
    DATA lv_msgtext          TYPE string.
    DATA lv_json             TYPE string.
    DATA lv_intervals_deleted TYPE i.
    DATA lv_order            TYPE e070-trkorr.
    DATA ls_ko200            TYPE ko200.
    DATA lv_we_order         TYPE e070-trkorr.
    DATA lv_we_task          TYPE e070-trkorr.
    DATA lt_subobj           TYPE STANDARD TABLE OF inriv-subobject.
    DATA lv_sub              TYPE inriv-subobject.
    DATA lv_tadir_objname    TYPE tadir-obj_name.
    DATA lv_tadir_devclass   TYPE tadir-devclass.

    rv_rc = 0.
    lv_failed = abap_false.
    lv_intervals_deleted = 0.

    lv_object = condense_up( zcl_zmcp_fluid_rt=>s( 'object' ) ).
    lv_package = condense_up( zcl_zmcp_fluid_rt=>s( 'package' ) ).
    lv_corr = condense_up( zcl_zmcp_fluid_rt=>s( 'corr_nr' ) ).
    lv_with_intervals = zcl_zmcp_fluid_rt=>b( 'with_intervals' ).
    lv_force = zcl_zmcp_fluid_rt=>b( 'force' ).

    IF lv_object IS INITIAL OR lv_package IS INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'args'
                              iv_text = 'object and package are required' ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    SELECT SINGLE * FROM tnro INTO ls_tnro WHERE object = lv_object.
    IF sy-subrc <> 0.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'lookup'
                              iv_text = |object { lv_object } not found| ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    CLEAR ls_tadir.
    lv_tadir_found = abap_false.
    SELECT SINGLE * FROM tadir INTO ls_tadir
      WHERE pgmid = 'R3TR' AND object = 'NROB' AND obj_name = lv_object.
    IF sy-subrc = 0.
      lv_tadir_found = abap_true.
      lv_eff_package = ls_tadir-devclass.
      CONDENSE lv_eff_package.
      IF lv_eff_package <> lv_package.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'args'
          iv_text = |object { lv_object } is in package { lv_eff_package }, not { lv_package }| ).
        rv_rc = 4.
        RETURN.
      ENDIF.
    ELSE.
      IF lv_package(1) <> '$'.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'args'
          iv_text = |object { lv_object } has no TADIR entry; package must start with $| ).
        rv_rc = 4.
        RETURN.
      ENDIF.
      lv_eff_package = lv_package.
    ENDIF.

    IF lv_eff_package(1) <> '$' AND lv_corr IS INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'args'
                              iv_text = 'corr_nr is required for a transportable package' ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    SELECT * FROM nriv INTO TABLE lt_nriv WHERE object = lv_object.
    lv_iv_count = lines( lt_nriv ).

    IF lv_iv_count > 0 AND lv_with_intervals = abap_false.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'args'
        iv_text = |object { lv_object } has { lv_iv_count } interval(s); pass with_intervals=true| ).
      rv_rc = 4.
      RETURN.
    ENDIF.

    IF lv_iv_count > 0.
      lv_used_count = 0.
      lv_used_list = ''.
      LOOP AT lt_nriv INTO ls_nriv WHERE nrlevel <> 0.
        lv_used_count = lv_used_count + 1.
        IF lv_used_list IS NOT INITIAL.
          lv_used_list = lv_used_list && ', '.
        ENDIF.
        lv_used_list = lv_used_list
          && |{ ls_nriv-subobject }/{ ls_nriv-nrrangenr }/{ ls_nriv-toyear }|.
      ENDLOOP.
      IF lv_used_count > 0 AND lv_force = abap_false.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'args'
          iv_text = |object { lv_object } has used interval(s) { lv_used_list }; pass force=true| ).
        rv_rc = 4.
        RETURN.
      ENDIF.
    ENDIF.

    IF lv_iv_count > 0.
      CALL FUNCTION 'NUMBER_RANGE_ENQUEUE'
        EXPORTING object = lv_object
        EXCEPTIONS
          foreign_lock     = 1
          object_not_found = 2
          system_failure     = 3
          error_message        = 4
          OTHERS                 = 5.
      lv_subrc = sy-subrc.
      IF lv_subrc <> 0.
        CASE lv_subrc.
          WHEN 1. lv_exc = 'FOREIGN_LOCK'.
          WHEN 2. lv_exc = 'OBJECT_NOT_FOUND'.
          WHEN 3. lv_exc = 'SYSTEM_FAILURE'.
          WHEN 4. lv_exc = 'ERROR_MESSAGE'.
          WHEN OTHERS. lv_exc = 'OTHERS'.
        ENDCASE.
        fm_fail( iv_step = 'enqueue' iv_fm = 'NUMBER_RANGE_ENQUEUE' iv_subrc = lv_subrc iv_exc = lv_exc ).
        rv_rc = 8.
        RETURN.
      ENDIF.

      CLEAR lt_subobj.
      LOOP AT lt_nriv INTO ls_nriv.
        APPEND ls_nriv-subobject TO lt_subobj.
      ENDLOOP.
      SORT lt_subobj.
      DELETE ADJACENT DUPLICATES FROM lt_subobj.

      LOOP AT lt_subobj INTO lv_sub.
        CLEAR lt_list.
        CALL FUNCTION 'NUMBER_RANGE_INTERVAL_LIST'
          EXPORTING
            object    = lv_object
            subobject = lv_sub
          TABLES interval = lt_list
          EXCEPTIONS
            nr_range_nr1_not_found      = 1
            nr_range_nr1_not_intern     = 2
            nr_range_nr2_must_be_space  = 3
            nr_range_nr2_not_extern     = 4
            nr_range_nr2_not_found      = 5
            object_not_found              = 6
            subobject_must_be_space       = 7
            subobject_not_found           = 8
            error_message                     = 9
            OTHERS                             = 10.
        lv_subrc = sy-subrc.
        IF lv_subrc <> 0.
          CASE lv_subrc.
            WHEN 1. lv_exc = 'NR_RANGE_NR1_NOT_FOUND'.
            WHEN 2. lv_exc = 'NR_RANGE_NR1_NOT_INTERN'.
            WHEN 3. lv_exc = 'NR_RANGE_NR2_MUST_BE_SPACE'.
            WHEN 4. lv_exc = 'NR_RANGE_NR2_NOT_EXTERN'.
            WHEN 5. lv_exc = 'NR_RANGE_NR2_NOT_FOUND'.
            WHEN 6. lv_exc = 'OBJECT_NOT_FOUND'.
            WHEN 7. lv_exc = 'SUBOBJECT_MUST_BE_SPACE'.
            WHEN 8. lv_exc = 'SUBOBJECT_NOT_FOUND'.
            WHEN 9. lv_exc = 'ERROR_MESSAGE'.
            WHEN OTHERS. lv_exc = 'OTHERS'.
          ENDCASE.
          fm_fail( iv_step = 'interval_list' iv_fm = 'NUMBER_RANGE_INTERVAL_LIST'
                   iv_subrc = lv_subrc iv_exc = lv_exc ).
          lv_failed = abap_true.
          rv_rc = 8.
          EXIT.
        ENDIF.

        CLEAR lt_upd.
        LOOP AT lt_list INTO ls_row.
          ls_row-procind = 'D'.
          CLEAR ls_row-nrlevel.
          APPEND ls_row TO lt_upd.
        ENDLOOP.
        lv_intervals_deleted = lv_intervals_deleted + lines( lt_upd ).

        CLEAR lt_updx.
        CLEAR ls_error.
        CLEAR lv_err_occ.
        CLEAR lv_warn_occ.
        CALL FUNCTION 'NUMBER_RANGE_INTERVAL_UPDATE'
          EXPORTING
            object    = lv_object
            subobject = lv_sub
          IMPORTING
            error           = ls_error
            error_occured   = lv_err_occ
            warning_occured = lv_warn_occ
          TABLES
            error_iv = lt_updx
            interval = lt_upd
          EXCEPTIONS
            object_not_found = 1
            error_message        = 2
            OTHERS                 = 3.
        lv_subrc = sy-subrc.
        IF lv_subrc <> 0.
          IF lv_subrc = 1.
            lv_exc = 'OBJECT_NOT_FOUND'.
          ELSEIF lv_subrc = 2.
            lv_exc = 'ERROR_MESSAGE'.
          ELSE.
            lv_exc = 'OTHERS'.
          ENDIF.
          fm_fail( iv_step = 'interval_update' iv_fm = 'NUMBER_RANGE_INTERVAL_UPDATE'
                   iv_subrc = lv_subrc iv_exc = lv_exc ).
          lv_failed = abap_true.
          rv_rc = 8.
          EXIT.
        ELSEIF lv_err_occ = 'X'.
          CLEAR lv_msgtext.
          MESSAGE ID 'NR' TYPE 'S' NUMBER ls_error-msgnr INTO lv_msgtext.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'message' iv_step = 'interval_update'
            iv_text = |{ lv_msgtext } (field { ls_error-fieldname })| ).
          lv_failed = abap_true.
          rv_rc = 4.
          EXIT.
        ENDIF.

        CALL FUNCTION 'NUMBER_RANGE_UPDATE_CLOSE'
          EXPORTING object = lv_object
          EXCEPTIONS
            no_changes_made         = 1
            object_not_initialized  = 2
            error_message               = 3
            OTHERS                        = 4.
        lv_subrc = sy-subrc.
        IF lv_subrc = 1.
          CLEAR lv_subrc.
        ELSEIF lv_subrc <> 0.
          IF lv_subrc = 2.
            lv_exc = 'OBJECT_NOT_INITIALIZED'.
          ELSEIF lv_subrc = 3.
            lv_exc = 'ERROR_MESSAGE'.
          ELSE.
            lv_exc = 'OTHERS'.
          ENDIF.
          fm_fail( iv_step = 'update_close' iv_fm = 'NUMBER_RANGE_UPDATE_CLOSE'
                   iv_subrc = lv_subrc iv_exc = lv_exc ).
          lv_failed = abap_true.
          rv_rc = 8.
          EXIT.
        ENDIF.
      ENDLOOP.

      CALL FUNCTION 'NUMBER_RANGE_DEQUEUE'
        EXPORTING object = lv_object
        EXCEPTIONS
          object_not_found = 1
          error_message        = 2
          OTHERS                 = 3.
    ENDIF.

    IF lv_failed = abap_true.
      RETURN.
    ENDIF.

    CALL FUNCTION 'NUMBER_RANGE_OBJECT_DELETE'
      EXPORTING
        object       = lv_object
        ohne_tp_flag = 'X'
      EXCEPTIONS
        delete_not_allowed = 1
        object_not_found      = 2
        wrong_indicator          = 3
        error_message               = 4
        OTHERS                        = 5.
    lv_subrc = sy-subrc.
    IF lv_subrc <> 0.
      CASE lv_subrc.
        WHEN 1. lv_exc = 'DELETE_NOT_ALLOWED'.
        WHEN 2. lv_exc = 'OBJECT_NOT_FOUND'.
        WHEN 3. lv_exc = 'WRONG_INDICATOR'.
        WHEN 4. lv_exc = 'ERROR_MESSAGE'.
        WHEN OTHERS. lv_exc = 'OTHERS'.
      ENDCASE.
      fm_fail( iv_step = 'object_delete' iv_fm = 'NUMBER_RANGE_OBJECT_DELETE'
               iv_subrc = lv_subrc iv_exc = lv_exc ).
      rv_rc = 8.
      RETURN.
    ENDIF.

    IF lv_tadir_found = abap_true.
      IF lv_eff_package(1) = '$'.
        lv_tadir_objname = lv_object.
        lv_tadir_devclass = lv_eff_package.
        CALL FUNCTION 'TR_TADIR_INTERFACE'
          EXPORTING
            wi_test_modus         = space
            wi_tadir_pgmid         = 'R3TR'
            wi_tadir_object        = 'NROB'
            wi_tadir_obj_name      = lv_tadir_objname
            wi_tadir_devclass      = lv_tadir_devclass
            wi_delete_tadir_entry = 'X'
          EXCEPTIONS
            error_message = 1
            OTHERS        = 2.
        lv_subrc = sy-subrc.
        IF lv_subrc <> 0.
          IF lv_subrc = 1.
            lv_exc = 'ERROR_MESSAGE'.
          ELSE.
            lv_exc = 'OTHERS'.
          ENDIF.
          fm_fail( iv_step = 'tadir_delete' iv_fm = 'TR_TADIR_INTERFACE'
                   iv_subrc = lv_subrc iv_exc = lv_exc ).
          rv_rc = 8.
          RETURN.
        ENDIF.
      ELSE.
        CLEAR ls_ko200.
        ls_ko200-pgmid = 'R3TR'.
        ls_ko200-object = 'NROB'.
        ls_ko200-obj_name = lv_object.
        ls_ko200-devclass = lv_eff_package.
        lv_order = lv_corr.
        CALL FUNCTION 'TR_OBJECT_INSERT'
          EXPORTING
            wi_order              = lv_order
            wi_ko200               = ls_ko200
            iv_no_standard_editor = 'X'
            iv_no_show_option     = 'X'
          IMPORTING
            we_order = lv_we_order
            we_task  = lv_we_task
          EXCEPTIONS
            cancel_edit_other_error = 1
            show_only_other_error    = 2
            error_message                = 3
            OTHERS                         = 4.
        lv_subrc = sy-subrc.
        IF lv_subrc <> 0.
          CASE lv_subrc.
            WHEN 1. lv_exc = 'CANCEL_EDIT_OTHER_ERROR'.
            WHEN 2. lv_exc = 'SHOW_ONLY_OTHER_ERROR'.
            WHEN 3. lv_exc = 'ERROR_MESSAGE'.
            WHEN OTHERS. lv_exc = 'OTHERS'.
          ENDCASE.
          fm_fail( iv_step = 'transport' iv_fm = 'TR_OBJECT_INSERT' iv_subrc = lv_subrc iv_exc = lv_exc ).
          rv_rc = 8.
          RETURN.
        ENDIF.

        lv_tadir_objname = lv_object.
        lv_tadir_devclass = lv_eff_package.
        CALL FUNCTION 'TR_TADIR_INTERFACE'
          EXPORTING
            wi_test_modus    = space
            wi_tadir_pgmid    = 'R3TR'
            wi_tadir_object   = 'NROB'
            wi_tadir_obj_name = lv_tadir_objname
            wi_tadir_devclass = lv_tadir_devclass
            iv_delflag         = 'X'
          EXCEPTIONS
            error_message = 1
            OTHERS        = 2.
        lv_subrc = sy-subrc.
        IF lv_subrc <> 0.
          IF lv_subrc = 1.
            lv_exc = 'ERROR_MESSAGE'.
          ELSE.
            lv_exc = 'OTHERS'.
          ENDIF.
          fm_fail( iv_step = 'tadir_delflag' iv_fm = 'TR_TADIR_INTERFACE'
                   iv_subrc = lv_subrc iv_exc = lv_exc ).
          rv_rc = 8.
          RETURN.
        ENDIF.
      ENDIF.
    ENDIF.

    lv_json = |\{"object":{ js( lv_object ) },"deleted":true,"intervals_deleted":{ lv_intervals_deleted }|
           && |,"package":{ js( lv_eff_package ) },"transport":{ js( lv_corr ) }\}|.
    zcl_zmcp_fluid_rt=>out( lv_json ).
  ENDMETHOD.

ENDCLASS.
