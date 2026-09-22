/**
 * Built-in "img" fluid tool: previews and writes an IMG (SPRO customizing)
 * table's DDIC shape and named rows, and creates the customizing transport
 * requests to record those writes in. Its three actions — `preview`,
 * `apply`, `create_request` — and every `IMGW>`/`ZMCP-DDIC-ERR>`/`CTSW>`
 * transcript line they emit are ported from the former `imgProbeSource`/
 * `imgApplySource`/`customizingRequestSource` per-call class generators
 * (all now deleted — `imgProbeSource` lived in `src/adt/img-write-bridge.ts`,
 * which still owns plan validation and transcript parsing for this tool but
 * no longer generates any ABAP), whose `parseImgWriteTranscript`/
 * `parseCustomizingRequestTranscript` this tool's output is meant to keep
 * parsing unchanged. It differs from those generators in exactly one way: table/field/row arguments are ordinary
 * fluid action arguments read at ABAP runtime (via a small JSON-XML/sXML
 * parser and genuinely dynamic `CREATE DATA`/`SELECT`/`MODIFY`/`DELETE ...
 * (...)`, plus RTTI-built key structures for the CTS TABKEY), not TypeScript
 * values baked into a freshly generated class per call — so DD02L/DD03L/the
 * row SELECT and the row MODIFY/DELETE read a host variable instead of a
 * literal table name, and the class is shipped once rather than
 * regenerated. Reshaped to the fluid body-class contract
 * (`run( iv_action, iv_json )` against `ZCL_ZMCP_FLUID_RT`) instead of
 * `IF_OO_ADT_CLASSRUN`, following `run.ts`.
 */
import type { FluidManifest } from "../manifest.js";
import { FLUID_CONTRACT } from "../manifest.js";
import { FLUID_RUNTIME_CLASS, fluidRuntimeManifest, fluidRuntimeSources } from "../abap/runtime.js";

const RUNTIME_SOURCE = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS);
if (RUNTIME_SOURCE === undefined) {
  throw new Error(`fluidRuntimeSources has no entry for ${FLUID_RUNTIME_CLASS}`);
}

const RUNTIME_OBJECT = fluidRuntimeManifest.objects.find((o) => o.name === FLUID_RUNTIME_CLASS);
if (RUNTIME_OBJECT === undefined) {
  throw new Error(`fluidRuntimeManifest has no entry for ${FLUID_RUNTIME_CLASS}`);
}

const IMG_SOURCE = `CLASS zcl_zmcp_fluid_img DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    CLASS-METHODS run
      IMPORTING
        iv_action TYPE string
        iv_json   TYPE string.

  PRIVATE SECTION.
    TYPES: BEGIN OF ty_node,
             path  TYPE string,
             value TYPE string,
           END OF ty_node.

    TYPES ty_strings TYPE STANDARD TABLE OF string WITH DEFAULT KEY.

    CLASS-DATA gt_node TYPE STANDARD TABLE OF ty_node WITH DEFAULT KEY.

    CLASS-METHODS parse_json
      IMPORTING
        iv_json TYPE string
      RAISING
        cx_sxml_error.

    CLASS-METHODS jget
      IMPORTING
        iv_path         TYPE string
      RETURNING
        VALUE(rv_value) TYPE string.

    CLASS-METHODS path_exists
      IMPORTING
        iv_path         TYPE string
      RETURNING
        VALUE(rv_found) TYPE abap_bool.

    CLASS-METHODS path_has_prefix
      IMPORTING
        iv_prefix       TYPE string
      RETURNING
        VALUE(rv_found) TYPE abap_bool.

    CLASS-METHODS count_scalar_array
      IMPORTING
        iv_path         TYPE string
      RETURNING
        VALUE(rv_count) TYPE i.

    CLASS-METHODS count_object_array
      IMPORTING
        iv_path         TYPE string
      RETURNING
        VALUE(rv_count) TYPE i.

    CLASS-METHODS probe
      IMPORTING
        iv_table     TYPE string
        iv_key_count TYPE i
        iv_row_count TYPE i
      RETURNING
        VALUE(rv_ok) TYPE abap_bool.

    CLASS-METHODS is_ddic_name
      IMPORTING
        iv_name      TYPE string
      RETURNING
        VALUE(rv_ok) TYPE abap_bool.

    CLASS-METHODS is_user_name
      IMPORTING
        iv_name      TYPE string
      RETURNING
        VALUE(rv_ok) TYPE abap_bool.

    CLASS-METHODS create_request
      IMPORTING
        iv_description TYPE string
        iv_owner       TYPE string
      RETURNING
        VALUE(rv_ok)   TYPE abap_bool.

    CLASS-METHODS values_field_names
      IMPORTING
        iv_prefix       TYPE string
      RETURNING
        VALUE(rt_names) TYPE ty_strings.

    CLASS-METHODS apply
      IMPORTING
        iv_table        TYPE string
        iv_client_field TYPE string
        iv_key_count    TYPE i
        iv_row_count    TYPE i
        iv_op           TYPE string
        iv_corr         TYPE string
        iv_view         TYPE string
        iv_master_type  TYPE string
        iv_exp_delclass TYPE string
        iv_exp_clidep   TYPE abap_bool
      RETURNING
        VALUE(rv_ok)    TYPE abap_bool.

    CLASS-METHODS cts_record
      IMPORTING
        iv_table       TYPE string
        iv_corr        TYPE string
        iv_row         TYPE i
        iv_view        TYPE string
        iv_master_type TYPE string
        iv_tabkey      TYPE string
      RETURNING
        VALUE(rv_ok)   TYPE abap_bool.

    CLASS-METHODS emit
      IMPORTING
        iv_line TYPE string.

ENDCLASS.


CLASS zcl_zmcp_fluid_img IMPLEMENTATION.

  METHOD run.
    DATA lx_json         TYPE REF TO cx_root.
    DATA lv_table        TYPE string.
    DATA lv_key_count    TYPE i.
    DATA lv_row_count    TYPE i.
    DATA lv_probe_ok     TYPE abap_bool.
    DATA lv_description  TYPE string.
    DATA lv_owner        TYPE string.
    DATA lv_request_ok   TYPE abap_bool.
    DATA lv_client_field TYPE string.
    DATA lv_op           TYPE string.
    DATA lv_corr         TYPE string.
    DATA lv_view         TYPE string.
    DATA lv_master_type  TYPE string.
    DATA lv_exp_delclass TYPE string.
    DATA lv_exp_clidep_s TYPE string.
    DATA lv_exp_clidep   TYPE abap_bool.
    DATA lv_apply_ok     TYPE abap_bool.

    zcl_zmcp_fluid_rt=>begin( iv_id = 'img' iv_action = iv_action ).

    CASE iv_action.
      WHEN 'preview'.
        TRY.
            parse_json( iv_json ).
          CATCH cx_root INTO lx_json.
            zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args' iv_text = lx_json->get_text( ) ).
            zcl_zmcp_fluid_rt=>end( 1 ).
            RETURN.
        ENDTRY.

        lv_table     = jget( 'table' ).
        lv_key_count = count_scalar_array( 'keyFields' ).
        lv_row_count = count_object_array( 'rows' ).

        IF lv_table IS INITIAL.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args' iv_text = 'table is required' ).
          zcl_zmcp_fluid_rt=>end( 1 ).
          RETURN.
        ENDIF.

        IF lv_key_count = 0.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
            iv_text = 'keyFields must have at least one entry' ).
          zcl_zmcp_fluid_rt=>end( 1 ).
          RETURN.
        ENDIF.

        IF lv_row_count = 0.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
            iv_text = 'rows must have at least one entry' ).
          zcl_zmcp_fluid_rt=>end( 1 ).
          RETURN.
        ENDIF.

        lv_probe_ok = probe( iv_table = lv_table iv_key_count = lv_key_count
          iv_row_count = lv_row_count ).

        IF lv_probe_ok = abap_false.
          zcl_zmcp_fluid_rt=>end( 1 ).
          RETURN.
        ENDIF.

        zcl_zmcp_fluid_rt=>end( 0 ).

      WHEN 'create_request'.
        zcl_zmcp_fluid_rt=>scan( iv_json ).
        lv_description = zcl_zmcp_fluid_rt=>s( 'description' ).
        lv_owner       = zcl_zmcp_fluid_rt=>s( 'owner' ).

        IF lv_description IS INITIAL.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
            iv_text = 'description is required' ).
          zcl_zmcp_fluid_rt=>end( 1 ).
          RETURN.
        ENDIF.

        IF lv_owner IS NOT INITIAL AND is_user_name( lv_owner ) = abap_false.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
            iv_text = |invalid owner "{ lv_owner }"| ).
          zcl_zmcp_fluid_rt=>end( 1 ).
          RETURN.
        ENDIF.

        lv_request_ok = create_request( iv_description = lv_description iv_owner = lv_owner ).

        IF lv_request_ok = abap_false.
          zcl_zmcp_fluid_rt=>end( 1 ).
          RETURN.
        ENDIF.

        zcl_zmcp_fluid_rt=>end( 0 ).

      WHEN 'apply'.
        TRY.
            parse_json( iv_json ).
          CATCH cx_root INTO lx_json.
            zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args' iv_text = lx_json->get_text( ) ).
            zcl_zmcp_fluid_rt=>end( 1 ).
            RETURN.
        ENDTRY.

        lv_table        = jget( 'table' ).
        lv_client_field = jget( 'clientField' ).
        lv_key_count    = count_scalar_array( 'keyFields' ).
        lv_row_count    = count_object_array( 'rows' ).
        lv_op           = jget( 'op' ).
        lv_corr         = jget( 'corrNr' ).
        lv_view         = jget( 'view' ).
        lv_master_type  = jget( 'masterType' ).
        lv_exp_delclass = jget( 'expectedDeliveryClass' ).
        lv_exp_clidep_s = jget( 'expectedClientDependent' ).
        lv_exp_clidep   = boolc( lv_exp_clidep_s = 'true' ).

        IF lv_table IS INITIAL OR lv_client_field IS INITIAL OR lv_key_count = 0
            OR lv_row_count = 0 OR lv_op IS INITIAL OR lv_view IS INITIAL OR lv_master_type IS INITIAL
            OR lv_exp_delclass IS INITIAL.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
            iv_text = 'table, clientField, keyFields, rows, op, view, masterType and ' &&
              'expectedDeliveryClass are required' ).
          zcl_zmcp_fluid_rt=>end( 1 ).
          RETURN.
        ENDIF.

        IF lv_op <> 'upsert' AND lv_op <> 'delete'.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
            iv_text = |op must be "upsert" or "delete", got "{ lv_op }"| ).
          zcl_zmcp_fluid_rt=>end( 1 ).
          RETURN.
        ENDIF.

        IF lv_master_type <> 'VDAT' AND lv_master_type <> 'CDAT' AND lv_master_type <> 'TABU'.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
            iv_text = |masterType must be "VDAT", "CDAT" or "TABU", got "{ lv_master_type }"| ).
          zcl_zmcp_fluid_rt=>end( 1 ).
          RETURN.
        ENDIF.

        lv_apply_ok = apply( iv_table = lv_table iv_client_field = lv_client_field
          iv_key_count = lv_key_count iv_row_count = lv_row_count
          iv_op = lv_op iv_corr = lv_corr iv_view = lv_view iv_master_type = lv_master_type
          iv_exp_delclass = lv_exp_delclass iv_exp_clidep = lv_exp_clidep ).

        IF lv_apply_ok = abap_false.
          zcl_zmcp_fluid_rt=>end( 1 ).
          RETURN.
        ENDIF.

        zcl_zmcp_fluid_rt=>end( 0 ).

      WHEN OTHERS.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'dispatch'
          iv_text = |unknown action "{ iv_action }"| ).
        zcl_zmcp_fluid_rt=>end( 1 ).
        RETURN.
    ENDCASE.
  ENDMETHOD.

  METHOD parse_json.
    TYPES: BEGIN OF ty_ctx,
             kind  TYPE c LENGTH 1,
             count TYPE i,
           END OF ty_ctx.

    DATA lt_path        TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    DATA lt_ctx         TYPE STANDARD TABLE OF ty_ctx WITH DEFAULT KEY.
    DATA lv_path        TYPE string.
    DATA lv_parent_path TYPE string.
    DATA lv_seg         TYPE string.
    DATA lv_kind        TYPE c LENGTH 1.
    DATA lv_name        TYPE string.

    CLEAR gt_node.

    DATA(lo_reader) = cl_sxml_string_reader=>create( cl_abap_codepage=>convert_to( iv_json ) ).

    DO.
      DATA(lo_node) = lo_reader->read_next_node( ).
      IF lo_node IS NOT BOUND.
        EXIT.
      ENDIF.

      CASE lo_node->type.
        WHEN if_sxml_node=>co_nt_element_open.
          DATA(lo_open) = CAST if_sxml_open_element( lo_node ).
          CLEAR lv_name.
          LOOP AT lo_open->get_attributes( ) INTO DATA(lo_attr).
            IF lo_attr->qname-name = 'name'.
              lv_name = lo_attr->get_value( ).
            ENDIF.
          ENDLOOP.

          IF lines( lt_ctx ) = 0.
            CLEAR lv_seg.
          ELSE.
            ASSIGN lt_ctx[ lines( lt_ctx ) ] TO FIELD-SYMBOL(<ls_parent>).
            IF <ls_parent>-kind = 'A'.
              lv_seg = |{ <ls_parent>-count }|.
              <ls_parent>-count = <ls_parent>-count + 1.
            ELSE.
              lv_seg = lv_name.
            ENDIF.
          ENDIF.

          IF lines( lt_path ) = 0.
            lv_path = lv_seg.
          ELSE.
            lv_parent_path = lt_path[ lines( lt_path ) ].
            IF lv_seg IS INITIAL.
              lv_path = lv_parent_path.
            ELSEIF lv_parent_path IS INITIAL.
              lv_path = lv_seg.
            ELSE.
              lv_path = |{ lv_parent_path }/{ lv_seg }|.
            ENDIF.
          ENDIF.
          APPEND lv_path TO lt_path.

          IF lo_open->qname-name = 'object'.
            lv_kind = 'O'.
          ELSEIF lo_open->qname-name = 'array'.
            lv_kind = 'A'.
          ELSE.
            lv_kind = 'V'.
          ENDIF.
          APPEND VALUE ty_ctx( kind = lv_kind count = 0 ) TO lt_ctx.

        WHEN if_sxml_node=>co_nt_value.
          DATA(lo_val) = CAST if_sxml_value_node( lo_node ).
          APPEND VALUE ty_node( path = lt_path[ lines( lt_path ) ] value = lo_val->get_value( ) ) TO gt_node.

        WHEN if_sxml_node=>co_nt_element_close.
          DELETE lt_path INDEX lines( lt_path ).
          DELETE lt_ctx INDEX lines( lt_ctx ).

        WHEN OTHERS.
          " no JSON data on any other node type (e.g. a processing instruction)
      ENDCASE.
    ENDDO.
  ENDMETHOD.

  METHOD jget.
    READ TABLE gt_node INTO DATA(ls_node) WITH KEY path = iv_path.
    IF sy-subrc = 0.
      rv_value = ls_node-value.
    ELSE.
      CLEAR rv_value.
    ENDIF.
  ENDMETHOD.

  METHOD path_exists.
    READ TABLE gt_node TRANSPORTING NO FIELDS WITH KEY path = iv_path.
    rv_found = boolc( sy-subrc = 0 ).
  ENDMETHOD.

  METHOD path_has_prefix.
    DATA lv_plen TYPE i.
    lv_plen = strlen( iv_prefix ).
    rv_found = abap_false.
    LOOP AT gt_node INTO DATA(ls_node).
      IF strlen( ls_node-path ) > lv_plen AND ls_node-path(lv_plen) = iv_prefix.
        rv_found = abap_true.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD count_scalar_array.
    DATA lv_i TYPE i.
    rv_count = 0.
    DO 1001 TIMES.
      lv_i = sy-index - 1.
      IF path_exists( |{ iv_path }/{ lv_i }| ) = abap_false.
        EXIT.
      ENDIF.
      rv_count = rv_count + 1.
    ENDDO.
  ENDMETHOD.

  METHOD count_object_array.
    DATA lv_i TYPE i.
    rv_count = 0.
    DO 1001 TIMES.
      lv_i = sy-index - 1.
      IF path_has_prefix( |{ iv_path }/{ lv_i }/| ) = abap_false.
        EXIT.
      ENDIF.
      rv_count = rv_count + 1.
    ENDDO.
  ENDMETHOD.

  METHOD values_field_names.
    DATA lv_plen TYPE i.
    lv_plen = strlen( iv_prefix ).
    CLEAR rt_names.
    LOOP AT gt_node INTO DATA(ls_node).
      IF strlen( ls_node-path ) > lv_plen AND ls_node-path(lv_plen) = iv_prefix.
        APPEND ls_node-path+lv_plen TO rt_names.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD probe.
    DATA lv_table_upper TYPE tabname.
    DATA lv_table_lower TYPE string.
    DATA lv_mandt        TYPE mandt.
    DATA lv_cccategory   TYPE t000-cccategory.
    DATA lv_cccoractiv   TYPE t000-cccoractiv.
    DATA lv_delclass     TYPE dd02l-contflag.
    DATA lv_clidep       TYPE dd02l-clidep.
    DATA lt_fld          TYPE STANDARD TABLE OF dd03l WITH DEFAULT KEY.
    DATA ls_fld          TYPE dd03l.
    DATA lr_wa           TYPE REF TO data.
    FIELD-SYMBOLS <fs_wa> TYPE any.
    DATA lo_descr        TYPE REF TO cl_abap_typedescr.
    DATA lo_struct       TYPE REF TO cl_abap_structdescr.
    DATA ls_comp         TYPE abap_componentdescr.
    DATA lt_comp         TYPE cl_abap_structdescr=>component_table.
    FIELD-SYMBOLS <fs_val> TYPE any.
    DATA lv_fval         TYPE string.
    DATA lx_sel          TYPE REF TO cx_root.
    DATA lv_ri           TYPE i.
    DATA lv_row_ok       TYPE abap_bool.
    DATA lv_kf           TYPE i.
    DATA lv_fld_name     TYPE string.
    DATA lv_fld_val      TYPE string.
    DATA lt_where        TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    DATA lv_subrc        TYPE sy-subrc.

    rv_ok = abap_true.

    lv_table_upper = to_upper( iv_table ).
    lv_table_lower = to_lower( iv_table ).

    IF is_ddic_name( iv_table ) = abap_false.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
        iv_text = |invalid table name "{ iv_table }"| ).
      rv_ok = abap_false.
      RETURN.
    ENDIF.

    SELECT SINGLE mandt, cccategory, cccoractiv FROM t000
      INTO (@lv_mandt, @lv_cccategory, @lv_cccoractiv)
      WHERE mandt = @sy-mandt.
    IF sy-subrc <> 0.
      emit( |ZMCP-DDIC-ERR> T000 read failed for client { sy-mandt }| ).
      RETURN.
    ENDIF.
    emit( |IMGW> CLIENT mandt=[{ lv_mandt }] cccategory=[{ lv_cccategory }] cccoractiv=[{ lv_cccoractiv }]| ).
    IF lv_cccoractiv = '2'.
      emit( |ZMCP-DDIC-ERR> T000-CCCORACTIV = 2 for client { sy-mandt }: client-dependent customizing | &&
        |changes are blocked outright in this client.| ).
      RETURN.
    ENDIF.

    SELECT SINGLE contflag, clidep FROM dd02l
      INTO (@lv_delclass, @lv_clidep)
      WHERE tabname = @lv_table_upper AND as4local = 'A'.
    IF sy-subrc <> 0.
      emit( |ZMCP-DDIC-ERR> DD02L read failed for { lv_table_lower }| ).
      RETURN.
    ENDIF.
    emit( |IMGW> TABLE table=[{ lv_table_lower }] delclass=[{ lv_delclass }] clidep=[{ lv_clidep }]| ).

    SELECT position, fieldname, keyflag, datatype, leng, rollname FROM dd03l
      INTO CORRESPONDING FIELDS OF TABLE @lt_fld
      WHERE tabname = @lv_table_upper AND as4local = 'A'
      ORDER BY position.
    IF sy-subrc <> 0.
      emit( |ZMCP-DDIC-ERR> DD03L returned no fields for { lv_table_lower }| ).
      RETURN.
    ENDIF.
    LOOP AT lt_fld INTO ls_fld.
      IF ls_fld-fieldname(1) = '.'.
        CONTINUE.
      ENDIF.
      emit( |IMGW> FLD table=[{ lv_table_lower }] field=[{ ls_fld-fieldname }] key=[{ ls_fld-keyflag }] | &&
        |type=[{ ls_fld-datatype }] len=[{ ls_fld-leng }] rollname=[{ ls_fld-rollname }]| ).
    ENDLOOP.

    DO iv_key_count TIMES.
      lv_kf = sy-index - 1.
      lv_fld_name = jget( |keyFields/{ lv_kf }| ).
      IF is_ddic_name( lv_fld_name ) = abap_false.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
          iv_text = |invalid key field name "{ lv_fld_name }"| ).
        rv_ok = abap_false.
        RETURN.
      ENDIF.
    ENDDO.

    DO iv_row_count TIMES.
      lv_ri = sy-index - 1.
      REFRESH lt_where.
      DO iv_key_count TIMES.
        lv_kf = sy-index - 1.
        lv_fld_name = jget( |keyFields/{ lv_kf }| ).
        lv_fld_val = jget( |rows/{ lv_ri }/{ lv_fld_name }| ).
        REPLACE ALL OCCURRENCES OF '''' IN lv_fld_val WITH ''''''.
        IF lv_kf > 0.
          APPEND 'AND' TO lt_where.
        ENDIF.
        APPEND |{ to_lower( lv_fld_name ) } = '{ lv_fld_val }'| TO lt_where.
      ENDDO.

      lv_row_ok = abap_true.
      lv_subrc = 4.
      CLEAR lr_wa.
      TRY.
          CREATE DATA lr_wa TYPE (lv_table_upper).
          ASSIGN lr_wa->* TO <fs_wa>.
          SELECT SINGLE * FROM (lv_table_upper) INTO @<fs_wa> WHERE (lt_where).
          lv_subrc = sy-subrc.
        CATCH cx_root INTO lx_sel.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'row'
            iv_text = |row { lv_ri + 1 }: { lx_sel->get_text( ) }| ).
          lv_row_ok = abap_false.
      ENDTRY.

      IF lv_row_ok = abap_false.
        CONTINUE.
      ENDIF.

      IF lv_subrc <> 0.
        emit( |IMGW> BABSENT row=[{ lv_ri + 1 }]| ).
      ELSE.
        lo_descr = cl_abap_typedescr=>describe_by_data( <fs_wa> ).
        lo_struct = CAST cl_abap_structdescr( lo_descr ).
        lt_comp = lo_struct->get_components( ).
        LOOP AT lt_comp INTO ls_comp.
          ASSIGN COMPONENT ls_comp-name OF STRUCTURE <fs_wa> TO <fs_val>.
          IF sy-subrc <> 0.
            CONTINUE.
          ENDIF.
          lv_fval = |{ <fs_val> }|.
          emit( |IMGW> BVAL row=[{ lv_ri + 1 }] field=[{ ls_comp-name }] len=[{ strlen( lv_fval ) }] | &&
            |value=[{ lv_fval }]| ).
        ENDLOOP.
      ENDIF.
    ENDDO.

    emit( |IMGW> PROBED rows=[{ iv_row_count }]| ).
  ENDMETHOD.

  METHOD is_ddic_name.
    DATA lv_len TYPE i.
    lv_len = strlen( iv_name ).
    rv_ok = boolc( lv_len > 0 AND lv_len <= 30 AND
      iv_name co 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_/' ).
  ENDMETHOD.

  METHOD is_user_name.
    DATA lv_len TYPE i.
    lv_len = strlen( iv_name ).
    rv_ok = boolc( lv_len > 0 AND lv_len <= 12 AND
      iv_name co 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_' ).
  ENDMETHOD.

  METHOD create_request.
    DATA ls_request_header TYPE trwbo_request_header.
    DATA lt_task_headers   TYPE trwbo_request_headers.
    DATA ls_task_header    TYPE trwbo_request_header.
    DATA lt_users          TYPE scts_users.
    DATA ls_user           TYPE scts_user.
    DATA lv_msg            TYPE string.
    DATA lv_exc            TYPE string.
    DATA lv_text           TYPE as4text.

    rv_ok = abap_true.
    lv_text = iv_description.

    ls_user-user = sy-uname.
    ls_user-type = 'Q'.
    INSERT ls_user INTO TABLE lt_users.

    IF iv_owner IS NOT INITIAL.
      CALL FUNCTION 'TR_INSERT_REQUEST_WITH_TASKS'
        EXPORTING
          iv_type           = 'W'
          iv_text           = lv_text
          iv_owner          = iv_owner
          it_users          = lt_users
        IMPORTING
          es_request_header = ls_request_header
          et_task_headers   = lt_task_headers
        EXCEPTIONS
          insert_failed     = 1
          enqueue_failed    = 2
          OTHERS            = 3.
    ELSE.
      CALL FUNCTION 'TR_INSERT_REQUEST_WITH_TASKS'
        EXPORTING
          iv_type           = 'W'
          iv_text           = lv_text
          it_users          = lt_users
        IMPORTING
          es_request_header = ls_request_header
          et_task_headers   = lt_task_headers
        EXCEPTIONS
          insert_failed     = 1
          enqueue_failed    = 2
          OTHERS            = 3.
    ENDIF.

    IF sy-subrc <> 0.
      CASE sy-subrc.
        WHEN 1.
          lv_exc = 'INSERT_FAILED'.
        WHEN 2.
          lv_exc = 'ENQUEUE_FAILED'.
        WHEN OTHERS.
          lv_exc = 'OTHERS'.
      ENDCASE.
      MESSAGE ID sy-msgid TYPE sy-msgty NUMBER sy-msgno
        WITH sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4 INTO lv_msg.
      emit( |CTSW> ERROR exception=[{ lv_exc }] len=[{ strlen( lv_msg ) }] value=[{ lv_msg }]| ).
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'create_request'
        iv_text = |{ lv_exc }: { lv_msg }| ).
      rv_ok = abap_false.
      RETURN.
    ENDIF.

    IF ls_request_header-trkorr IS INITIAL.
      emit( |CTSW> ERROR exception=[NO_REQUEST] len=[0] value=[]| ).
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'create_request'
        iv_text = 'no request number returned' ).
      rv_ok = abap_false.
      RETURN.
    ENDIF.

    emit( |CTSW> REQUEST len=[{ strlen( ls_request_header-trkorr ) }] value=[{ ls_request_header-trkorr }]| ).

    READ TABLE lt_task_headers INTO ls_task_header INDEX 1.
    IF sy-subrc <> 0.
      emit( |CTSW> WARN code=[NO_TASK] len=[{ strlen( ls_request_header-trkorr ) }] | &&
        |value=[{ ls_request_header-trkorr }]| ).
    ELSE.
      emit( |CTSW> TASK len=[{ strlen( ls_task_header-trkorr ) }] value=[{ ls_task_header-trkorr }]| ).
      emit( |CTSW> TASKTYPE len=[{ strlen( ls_task_header-trfunction ) }] | &&
        |value=[{ ls_task_header-trfunction }]| ).
    ENDIF.
  ENDMETHOD.

  METHOD apply.
    DATA lv_table_upper   TYPE tabname.
    DATA lv_table_lower   TYPE string.
    DATA lv_mandt         TYPE mandt.
    DATA lv_cccategory    TYPE t000-cccategory.
    DATA lv_cccoractiv    TYPE t000-cccoractiv.
    DATA lv_delclass      TYPE dd02l-contflag.
    DATA lv_clidep        TYPE dd02l-clidep.
    DATA lr_wa            TYPE REF TO data.
    FIELD-SYMBOLS <fs_wa> TYPE any.
    DATA lo_descr         TYPE REF TO cl_abap_typedescr.
    DATA lo_struct        TYPE REF TO cl_abap_structdescr.
    DATA ls_comp          TYPE abap_componentdescr.
    DATA lt_comp          TYPE cl_abap_structdescr=>component_table.
    DATA lt_key_comp      TYPE cl_abap_structdescr=>component_table.
    FIELD-SYMBOLS <fs_val> TYPE any.
    DATA lv_fval          TYPE string.
    DATA lx_sel           TYPE REF TO cx_root.
    DATA lv_ri            TYPE i.
    DATA lv_row_ok        TYPE abap_bool.
    DATA lv_kf            TYPE i.
    DATA lv_fld_name      TYPE string.
    DATA lv_fld_val       TYPE string.
    DATA lt_where         TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    DATA lv_subrc         TYPE sy-subrc.
    DATA lo_key_struct    TYPE REF TO cl_abap_structdescr.
    DATA lr_key           TYPE REF TO data.
    FIELD-SYMBOLS <fs_key> TYPE any.
    FIELD-SYMBOLS <key_c>  TYPE c.
    DATA lv_tabkey        TYPE string.
    DATA lv_has_client    TYPE abap_bool.
    DATA lv_cts_ok        TYPE abap_bool.
    DATA lt_val_names     TYPE ty_strings.
    DATA lv_val_name      TYPE string.

    rv_ok = abap_true.

    IF is_ddic_name( iv_table ) = abap_false.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
        iv_text = |invalid table name "{ iv_table }"| ).
      rv_ok = abap_false.
      RETURN.
    ENDIF.

    IF is_ddic_name( iv_client_field ) = abap_false.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
        iv_text = |invalid client field name "{ iv_client_field }"| ).
      rv_ok = abap_false.
      RETURN.
    ENDIF.

    DO iv_key_count TIMES.
      lv_kf = sy-index - 1.
      lv_fld_name = jget( |keyFields/{ lv_kf }| ).
      IF is_ddic_name( lv_fld_name ) = abap_false.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
          iv_text = |invalid key field name "{ lv_fld_name }"| ).
        rv_ok = abap_false.
        RETURN.
      ENDIF.
    ENDDO.

    lv_table_upper = to_upper( iv_table ).
    lv_table_lower = to_lower( iv_table ).

    SELECT SINGLE mandt, cccategory, cccoractiv FROM t000
      INTO (@lv_mandt, @lv_cccategory, @lv_cccoractiv)
      WHERE mandt = @sy-mandt.
    IF sy-subrc <> 0.
      emit( |ZMCP-DDIC-ERR> T000 read failed for client { sy-mandt }| ).
      rv_ok = abap_false.
      RETURN.
    ENDIF.
    emit( |IMGW> CLIENT mandt=[{ lv_mandt }] cccategory=[{ lv_cccategory }] cccoractiv=[{ lv_cccoractiv }]| ).
    IF lv_cccoractiv = '2'.
      emit( |ZMCP-DDIC-ERR> T000-CCCORACTIV = 2 for client { sy-mandt }: client-dependent customizing | &&
        |changes are blocked outright in this client.| ).
      rv_ok = abap_false.
      RETURN.
    ENDIF.

    SELECT SINGLE contflag, clidep FROM dd02l
      INTO (@lv_delclass, @lv_clidep)
      WHERE tabname = @lv_table_upper AND as4local = 'A'.
    IF sy-subrc <> 0.
      emit( |ZMCP-DDIC-ERR> DD02L read failed for { lv_table_lower }| ).
      rv_ok = abap_false.
      RETURN.
    ENDIF.

    IF lv_delclass <> iv_exp_delclass OR xsdbool( lv_clidep = 'X' ) <> iv_exp_clidep.
      emit( |ZMCP-DDIC-ERR> DD02L for { lv_table_lower } changed since the probe | &&
        |(delclass=[{ lv_delclass }] clidep=[{ lv_clidep }]): re-probe before applying.| ).
      rv_ok = abap_false.
      RETURN.
    ENDIF.

    TRY.
        CREATE DATA lr_wa TYPE (lv_table_upper).
        ASSIGN lr_wa->* TO <fs_wa>.
        lo_descr = cl_abap_typedescr=>describe_by_data( <fs_wa> ).
        lo_struct = CAST cl_abap_structdescr( lo_descr ).
        lt_comp = lo_struct->get_components( ).
      CATCH cx_root INTO lx_sel.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'apply'
          iv_text = |failed to describe table { lv_table_lower }: { lx_sel->get_text( ) }| ).
        rv_ok = abap_false.
        RETURN.
    ENDTRY.

    REFRESH lt_key_comp.
    DO iv_key_count TIMES.
      lv_kf = sy-index - 1.
      lv_fld_name = to_upper( jget( |keyFields/{ lv_kf }| ) ).
      READ TABLE lt_comp INTO ls_comp WITH KEY name = lv_fld_name.
      IF sy-subrc <> 0.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'apply'
          iv_text = |key field "{ lv_fld_name }" not found on { lv_table_lower }| ).
        rv_ok = abap_false.
        RETURN.
      ENDIF.
      APPEND ls_comp TO lt_key_comp.
    ENDDO.

    READ TABLE lt_comp INTO ls_comp WITH KEY name = to_upper( iv_client_field ).
    IF sy-subrc = 0.
      lv_has_client = abap_true.
    ELSEIF iv_exp_clidep = abap_true.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'apply'
        iv_text = |client field "{ iv_client_field }" not found on { lv_table_lower } — DD02L marks this | &&
          |table client-dependent, but it has no such component, so it cannot be client-stamped. | &&
          |Check client_field, or the table's key, before retrying.| ).
      rv_ok = abap_false.
      RETURN.
    ELSE.
      lv_has_client = abap_false.
    ENDIF.

    TRY.
        lo_key_struct = cl_abap_structdescr=>create( lt_key_comp ).
        CREATE DATA lr_key TYPE HANDLE lo_key_struct.
        ASSIGN lr_key->* TO <fs_key>.
        ASSIGN <fs_key> TO <key_c> CASTING TYPE c.
      CATCH cx_root INTO lx_sel.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'apply'
          iv_text = |failed to build key structure for { lv_table_lower }: { lx_sel->get_text( ) }| ).
        rv_ok = abap_false.
        RETURN.
    ENDTRY.

    DO iv_row_count TIMES.
      lv_ri = sy-index - 1.

      REFRESH lt_where.
      DO iv_key_count TIMES.
        lv_kf = sy-index - 1.
        lv_fld_name = jget( |keyFields/{ lv_kf }| ).
        lv_fld_val = jget( |rows/{ lv_ri }/key/{ lv_fld_name }| ).

        ASSIGN COMPONENT to_upper( lv_fld_name ) OF STRUCTURE <fs_key> TO <fs_val>.
        IF sy-subrc = 0.
          <fs_val> = lv_fld_val.
        ENDIF.

        REPLACE ALL OCCURRENCES OF '''' IN lv_fld_val WITH ''''''.
        IF lv_kf > 0.
          APPEND 'AND' TO lt_where.
        ENDIF.
        APPEND |{ to_lower( lv_fld_name ) } = '{ lv_fld_val }'| TO lt_where.
      ENDDO.
      IF lv_has_client = abap_true.
        lv_tabkey = |{ sy-mandt }{ <key_c> }|.
      ELSE.
        lv_tabkey = |{ <key_c> }|.
      ENDIF.

      lv_row_ok = abap_true.
      lv_subrc = 4.
      CLEAR lr_wa.
      TRY.
          CREATE DATA lr_wa TYPE (lv_table_upper).
          ASSIGN lr_wa->* TO <fs_wa>.
          SELECT SINGLE * FROM (lv_table_upper) INTO @<fs_wa> WHERE (lt_where).
          lv_subrc = sy-subrc.
        CATCH cx_root INTO lx_sel.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'row'
            iv_text = |row { lv_ri + 1 }: { lx_sel->get_text( ) }| ).
          lv_row_ok = abap_false.
      ENDTRY.

      IF lv_row_ok = abap_false.
        rv_ok = abap_false.
        RETURN.
      ENDIF.

      IF lv_subrc <> 0.
        emit( |IMGW> BABSENT row=[{ lv_ri + 1 }]| ).
        CLEAR <fs_wa>.
      ELSE.
        lo_descr = cl_abap_typedescr=>describe_by_data( <fs_wa> ).
        lo_struct = CAST cl_abap_structdescr( lo_descr ).
        lt_comp = lo_struct->get_components( ).
        LOOP AT lt_comp INTO ls_comp.
          ASSIGN COMPONENT ls_comp-name OF STRUCTURE <fs_wa> TO <fs_val>.
          IF sy-subrc <> 0.
            CONTINUE.
          ENDIF.
          lv_fval = |{ <fs_val> }|.
          emit( |IMGW> BVAL row=[{ lv_ri + 1 }] field=[{ ls_comp-name }] len=[{ strlen( lv_fval ) }] | &&
            |value=[{ lv_fval }]| ).
        ENDLOOP.
      ENDIF.

      IF iv_corr IS NOT INITIAL.
        lv_cts_ok = cts_record( iv_table = lv_table_lower iv_corr = iv_corr iv_row = lv_ri + 1
          iv_view = iv_view iv_master_type = iv_master_type iv_tabkey = lv_tabkey ).
        IF lv_cts_ok = abap_false.
          rv_ok = abap_false.
          RETURN.
        ENDIF.
      ENDIF.

      IF lv_has_client = abap_true.
        ASSIGN COMPONENT to_upper( iv_client_field ) OF STRUCTURE <fs_wa> TO <fs_val>.
        IF sy-subrc = 0.
          <fs_val> = sy-mandt.
        ENDIF.
      ENDIF.

      IF iv_op = 'upsert'.
        IF lv_subrc <> 0.
          DO iv_key_count TIMES.
            lv_kf = sy-index - 1.
            lv_fld_name = jget( |keyFields/{ lv_kf }| ).
            lv_fld_val = jget( |rows/{ lv_ri }/key/{ lv_fld_name }| ).
            ASSIGN COMPONENT to_upper( lv_fld_name ) OF STRUCTURE <fs_wa> TO <fs_val>.
            IF sy-subrc = 0.
              <fs_val> = lv_fld_val.
            ENDIF.
          ENDDO.
        ENDIF.

        lt_val_names = values_field_names( |rows/{ lv_ri }/values/| ).
        LOOP AT lt_val_names INTO lv_val_name.
          IF to_upper( lv_val_name ) = to_upper( iv_client_field ).
            CONTINUE.
          ENDIF.
          ASSIGN COMPONENT to_upper( lv_val_name ) OF STRUCTURE <fs_wa> TO <fs_val>.
          IF sy-subrc <> 0.
            zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'row'
              iv_text = |row { lv_ri + 1 }: { lv_table_lower } has no field "{ lv_val_name }"| ).
            rv_ok = abap_false.
            RETURN.
          ENDIF.
          <fs_val> = jget( |rows/{ lv_ri }/values/{ lv_val_name }| ).
        ENDLOOP.

        TRY.
            MODIFY (lv_table_upper) FROM <fs_wa>.
            lv_subrc = sy-subrc.
          CATCH cx_root INTO lx_sel.
            zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'row'
              iv_text = |row { lv_ri + 1 }: { lx_sel->get_text( ) }| ).
            rv_ok = abap_false.
            RETURN.
        ENDTRY.
        IF lv_subrc <> 0.
          emit( |ZMCP-DDIC-ERR> MODIFY failed for row { lv_ri + 1 } on { lv_table_lower }, | &&
            |sy-subrc={ lv_subrc }| ).
          rv_ok = abap_false.
          RETURN.
        ENDIF.
        emit( |IMGW> WROTE row=[{ lv_ri + 1 }]| ).

      ELSE.
        DO iv_key_count TIMES.
          lv_kf = sy-index - 1.
          lv_fld_name = jget( |keyFields/{ lv_kf }| ).
          lv_fld_val = jget( |rows/{ lv_ri }/key/{ lv_fld_name }| ).
          ASSIGN COMPONENT to_upper( lv_fld_name ) OF STRUCTURE <fs_wa> TO <fs_val>.
          IF sy-subrc = 0.
            <fs_val> = lv_fld_val.
          ENDIF.
        ENDDO.

        TRY.
            DELETE (lv_table_upper) FROM <fs_wa>.
            lv_subrc = sy-subrc.
          CATCH cx_root INTO lx_sel.
            zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'row'
              iv_text = |row { lv_ri + 1 }: { lx_sel->get_text( ) }| ).
            rv_ok = abap_false.
            RETURN.
        ENDTRY.
        IF lv_subrc <> 0.
          emit( |ZMCP-DDIC-ERR> DELETE failed for row { lv_ri + 1 } on { lv_table_lower }, | &&
            |sy-subrc={ lv_subrc }| ).
          rv_ok = abap_false.
          RETURN.
        ENDIF.
        emit( |IMGW> WROTE row=[{ lv_ri + 1 }]| ).
      ENDIF.
    ENDDO.

    COMMIT WORK AND WAIT.

    DO iv_row_count TIMES.
      lv_ri = sy-index - 1.
      REFRESH lt_where.
      DO iv_key_count TIMES.
        lv_kf = sy-index - 1.
        lv_fld_name = jget( |keyFields/{ lv_kf }| ).
        lv_fld_val = jget( |rows/{ lv_ri }/key/{ lv_fld_name }| ).
        REPLACE ALL OCCURRENCES OF '''' IN lv_fld_val WITH ''''''.
        IF lv_kf > 0.
          APPEND 'AND' TO lt_where.
        ENDIF.
        APPEND |{ to_lower( lv_fld_name ) } = '{ lv_fld_val }'| TO lt_where.
      ENDDO.

      CLEAR lr_wa.
      lv_row_ok = abap_true.
      lv_subrc = 4.
      TRY.
          CREATE DATA lr_wa TYPE (lv_table_upper).
          ASSIGN lr_wa->* TO <fs_wa>.
          SELECT SINGLE * FROM (lv_table_upper) INTO @<fs_wa> WHERE (lt_where).
          lv_subrc = sy-subrc.
        CATCH cx_root INTO lx_sel.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'row'
            iv_text = |row { lv_ri + 1 } (after-image): { lx_sel->get_text( ) }| ).
          lv_row_ok = abap_false.
      ENDTRY.

      IF lv_row_ok = abap_false.
        CONTINUE.
      ENDIF.

      IF lv_subrc <> 0.
        emit( |IMGW> AABSENT row=[{ lv_ri + 1 }]| ).
      ELSE.
        lo_descr = cl_abap_typedescr=>describe_by_data( <fs_wa> ).
        lo_struct = CAST cl_abap_structdescr( lo_descr ).
        lt_comp = lo_struct->get_components( ).
        LOOP AT lt_comp INTO ls_comp.
          ASSIGN COMPONENT ls_comp-name OF STRUCTURE <fs_wa> TO <fs_val>.
          IF sy-subrc <> 0.
            CONTINUE.
          ENDIF.
          lv_fval = |{ <fs_val> }|.
          emit( |IMGW> AVAL row=[{ lv_ri + 1 }] field=[{ ls_comp-name }] len=[{ strlen( lv_fval ) }] | &&
            |value=[{ lv_fval }]| ).
        ENDLOOP.
      ENDIF.
    ENDDO.

    emit( |IMGW> APPLIED rows=[{ iv_row_count }]| ).
  ENDMETHOD.

  METHOD cts_record.
    DATA ls_ko200      TYPE ko200.
    DATA lt_ko200      TYPE tredt_objects.
    DATA ls_e071k      TYPE e071k.
    DATA lt_e071k      TYPE tredt_keys.
    DATA lv_wi_order   TYPE trkorr.
    DATA lv_we_order   TYPE trkorr.
    DATA lv_we_task    TYPE trkorr.
    DATA lx_cts        TYPE REF TO cx_root.
    DATA lo_exc_type   TYPE REF TO cl_abap_typedescr.
    DATA lv_exc_class  TYPE string.
    DATA lv_exc_text   TYPE string.
    DATA lv_view_upper TYPE string.
    DATA lv_msg        TYPE string.

    rv_ok = abap_true.
    lv_view_upper = to_upper( iv_view ).
    lv_wi_order = iv_corr.

    ls_ko200-pgmid    = 'R3TR'.
    ls_ko200-object   = iv_master_type.
    ls_ko200-obj_name = lv_view_upper.
    ls_ko200-objfunc  = 'K'.
    APPEND ls_ko200 TO lt_ko200.

    ls_e071k-pgmid      = 'R3TR'.
    ls_e071k-object     = 'TABU'.
    ls_e071k-objname    = to_upper( iv_table ).
    ls_e071k-mastertype = iv_master_type.
    ls_e071k-mastername = lv_view_upper.
    ls_e071k-viewname   = lv_view_upper.
    ls_e071k-objfunc    = ' '.
    ls_e071k-tabkey     = iv_tabkey.
    APPEND ls_e071k TO lt_e071k.

    TRY.
        CALL FUNCTION 'TR_OBJECTS_CHECK'
          EXPORTING
            iv_no_standard_editor   = 'X'
            iv_no_show_option       = 'X'
          TABLES
            wt_ko200                = lt_ko200
            wt_e071k                = lt_e071k
          EXCEPTIONS
            cancel_edit_other_error = 1
            show_only_other_error   = 2
            OTHERS                  = 3.
        IF sy-subrc <> 0.
          MESSAGE ID sy-msgid TYPE sy-msgty NUMBER sy-msgno
            WITH sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4 INTO lv_msg.
          emit( |ZMCP-DDIC-ERR> TR_OBJECTS_CHECK failed for row { iv_row } on { iv_table }, | &&
            |sy-subrc={ sy-subrc }: { lv_msg }| ).
          rv_ok = abap_false.
          RETURN.
        ENDIF.

        " TR_OBJECTS_INSERT forces iv_with_dialog = 'X' and pops SAPLSTRD dynpros
        " (request choice, task classification) that a classrun cannot answer;
        " 'D' is the headless insert mode (space would only check).
        CALL FUNCTION 'TRINT_OBJECTS_CHECK_AND_INSERT'
          EXPORTING
            iv_order              = lv_wi_order
            iv_with_dialog        = 'D'
            iv_no_standard_editor = 'X'
            iv_no_show_option     = 'X'
          IMPORTING
            ev_order              = lv_we_order
            ev_task               = lv_we_task
          CHANGING
            ct_ko200              = lt_ko200
            ct_e071k              = lt_e071k
          EXCEPTIONS
            OTHERS                = 1.
        IF sy-subrc <> 0.
          MESSAGE ID sy-msgid TYPE sy-msgty NUMBER sy-msgno
            WITH sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4 INTO lv_msg.
          emit( |ZMCP-DDIC-ERR> TRINT_OBJECTS_CHECK_AND_INSERT failed for row { iv_row } on { iv_table }, | &&
            |sy-subrc={ sy-subrc } { sy-msgid }{ sy-msgno }: { lv_msg }| ).
          rv_ok = abap_false.
          RETURN.
        ENDIF.

      CATCH cx_sy_dyn_call_illegal_type cx_sy_dyn_call_param_missing INTO lx_cts.
        lo_exc_type = cl_abap_typedescr=>describe_by_object_ref( lx_cts ).
        lv_exc_class = lo_exc_type->get_relative_name( ).
        lv_exc_text = lx_cts->get_text( ).
        emit( |IMGW> ERROR class=[{ lv_exc_class }] len=[{ strlen( lv_exc_text ) }] value=[{ lv_exc_text }]| ).
        rv_ok = abap_false.
        RETURN.
      CATCH cx_root INTO lx_cts.
        lo_exc_type = cl_abap_typedescr=>describe_by_object_ref( lx_cts ).
        lv_exc_class = lo_exc_type->get_relative_name( ).
        lv_exc_text = lx_cts->get_text( ).
        emit( |IMGW> ERROR class=[{ lv_exc_class }] len=[{ strlen( lv_exc_text ) }] value=[{ lv_exc_text }]| ).
        rv_ok = abap_false.
        RETURN.
    ENDTRY.

    emit( |IMGW> TRKEY row=[{ iv_row }] trkorr=[{ iv_corr }] order_len=[{ strlen( lv_we_order ) }] | &&
      |order=[{ lv_we_order }] task_len=[{ strlen( lv_we_task ) }] task=[{ lv_we_task }] | &&
      |len=[{ strlen( iv_tabkey ) }] value=[{ iv_tabkey }]| ).
  ENDMETHOD.

  METHOD emit.
    zcl_zmcp_fluid_rt=>out( |"{ zcl_zmcp_fluid_rt=>esc( iv_line ) }"| ).
  ENDMETHOD.

ENDCLASS.
`;

export const imgManifest: FluidManifest = {
  contract: FLUID_CONTRACT,
  id: "img",
  title: "IMG write",
  description:
    "Previews and writes an IMG (SPRO customizing) table's rows, and creates the customizing " +
    "transport requests to record those writes in.",
  objects: [
    {
      name: FLUID_RUNTIME_CLASS,
      type: "CLAS/OC",
      // same live object as the rt tool's; derived so the two descriptions can't drift apart
      description: RUNTIME_OBJECT.description,
      source: { text: RUNTIME_SOURCE },
    },
    {
      name: "ZCL_ZMCP_FLUID_IMG",
      type: "CLAS/OC",
      description: "fluid: previews and writes an IMG table's rows",
      source: { text: IMG_SOURCE },
    },
  ],
  entry: "ZCL_ZMCP_FLUID_IMG",
  actions: [
    {
      name: "preview",
      category: "read",
      description:
        "Reads the client's customizing flags (T000), the table's DDIC header (DD02L) and field " +
        "catalog (DD03L), and the current before-image of each named row; writes nothing.",
      targets: { object: "/table" },
      input: {
        type: "object",
        required: ["table", "keyFields", "rows"],
        properties: {
          table: { type: "string", maxLength: 30, description: "The DDIC table name to preview, e.g. T001." },
          keyFields: {
            type: "array",
            items: { type: "string", maxLength: 30 },
            description: "The table's key field names, excluding the client field, in the order used to look up each row.",
          },
          rows: {
            type: "array",
            items: { type: "object" },
            description: "One entry per row; each is a flat map of key field name to key value.",
          },
        },
      },
      output: {
        type: "array",
        items: { type: "string" },
        description: "One IMGW>/ZMCP-DDIC-ERR> transcript line per element.",
      },
    },
    {
      name: "create_request",
      category: "mutate",
      description:
        "Creates a customizing (type W) transport request via TR_INSERT_REQUEST_WITH_TASKS, with a " +
        "type-Q task recorded for the logon user.",
      input: {
        type: "object",
        required: ["description"],
        properties: {
          description: {
            type: "string",
            maxLength: 60,
            description: "Short text (AS4TEXT) for the new request.",
          },
          owner: {
            type: "string",
            maxLength: 12,
            description: "Request owner; defaults to the logon user when omitted.",
          },
        },
      },
      output: {
        type: "array",
        items: { type: "string" },
        description: "One CTSW> transcript line per element.",
      },
      // Empty on purpose, not omitted: a customizing (type W) request is not filed against any
      // package (see img-edit.ts's own module doc comment on why create_request lives here rather
      // than under abap_transport), and the request number this mints does not exist until
      // TR_INSERT_REQUEST_WITH_TASKS returns it, so there is no object name to point at either.
      // `{}` still routes this "mutate" action through assertTargetsAgainstGate (dispatch.ts) rather
      // than skipping gate.assert entirely (`if (!targets) return`) — it gets the productive-system/
      // write-lockout/read-only ceilings, and, with no package known, falls to the package
      // allowlist's fail-closed "unknown package" branch unless ABAP_ALLOW_PACKAGES is wildcarded.
      targets: {},
    },
    {
      name: "apply",
      category: "mutate",
      description:
        "Re-reads DD02L to guard against drift since the probe, then upserts or deletes the named rows " +
        "via a dynamic MODIFY/DELETE, recording each in the given transport when corrNr is supplied, and " +
        "dumps a before- and after-image of every row around a COMMIT WORK AND WAIT.",
      // `transport: "/corrNr"` is declared for documentation and future-proofing, but it does NOT
      // arm the SafetyGate's transport allowlist (safety.ts step 10): that check only runs inside
      // `needsTransport`, which requires a KNOWN package, and this action declares no `package`
      // pointer — the probe never reads TADIR-DEVCLASS, so no plan field carries the table's real
      // package. Adding one would mean a new network read this slice does not make. Residual gap,
      // not fixed here: report to the slice owner rather than pretend this pointer enforces
      // anything by itself.
      targets: { object: "/table", transport: "/corrNr" },
      input: {
        type: "object",
        required: [
          "table",
          "clientField",
          "keyFields",
          "rows",
          "op",
          "expectedDeliveryClass",
          "expectedClientDependent",
          "view",
          "masterType",
        ],
        properties: {
          table: { type: "string", maxLength: 30, description: "The DDIC table name to write, e.g. T005." },
          clientField: {
            type: "string",
            maxLength: 30,
            description: "The table's client field name; always set from sy-mandt, never from row data.",
          },
          keyFields: {
            type: "array",
            items: { type: "string", maxLength: 30 },
            description: "The table's key field names, excluding the client field, in the order used to look up each row.",
          },
          rows: {
            type: "array",
            items: {
              type: "object",
              required: ["key", "values"],
              properties: {
                key: { type: "object", description: "Key field name to key value, for every keyFields entry." },
                values: { type: "object", description: "Non-key field name to new value, for an upsert." },
              },
            },
            description: "One entry per row to upsert or delete.",
          },
          op: { type: "string", enum: ["upsert", "delete"], description: "Whether to upsert or delete every row." },
          corrNr: {
            type: "string",
            description: "Transport request/task number; when supplied, every row is recorded against it via the CTS.",
          },
          expectedDeliveryClass: {
            type: "string",
            maxLength: 1,
            description: "DD02L-CONTFLAG as read at probe time; the apply aborts if a live re-read disagrees.",
          },
          expectedClientDependent: {
            type: "boolean",
            description: "DD02L-CLIDEP as read at probe time; the apply aborts if a live re-read disagrees.",
          },
          view: {
            type: "string",
            description: "The maintenance view/object recording this write in the CTS (KO200-OBJ_NAME, E071K-MASTERNAME/VIEWNAME).",
          },
          masterType: {
            type: "string",
            enum: ["VDAT", "CDAT", "TABU"],
            description: "KO200/E071K-OBJECT/MASTERTYPE: VDAT for a maintenance view, CDAT for a customizing object, TABU for a table maintained directly (no maintenance view).",
          },
        },
      },
      output: {
        type: "array",
        items: { type: "string" },
        description: "One IMGW>/ZMCP-DDIC-ERR> transcript line per element.",
      },
    },
  ],
};

export const imgSources: ReadonlyMap<string, string> = new Map([
  [FLUID_RUNTIME_CLASS, RUNTIME_SOURCE],
  ["ZCL_ZMCP_FLUID_IMG", IMG_SOURCE],
]);
