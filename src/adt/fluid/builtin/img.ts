/**
 * Built-in "img" fluid tool: a read-only preview of an IMG (SPRO customizing)
 * table's DDIC shape and named rows. The probe algorithm — T000 client flags,
 * a DD02L header read, a DD03L field-catalog dump, and a before-image read of
 * each caller-named row — and every `IMGW>`/`ZMCP-DDIC-ERR>` transcript line
 * it emits are ported from `imgProbeSource` in `src/adt/img-write-bridge.ts`,
 * whose `parseImgWriteTranscript` this tool's output is meant to keep
 * parsing unchanged. It differs from that generator in exactly one way: the
 * table name, key fields and rows are ordinary fluid action arguments read
 * at ABAP runtime (via a small JSON-XML/sXML parser and genuinely dynamic
 * `CREATE DATA`/`SELECT ... FROM (...)`), not TypeScript values baked into a
 * freshly generated class per call — so DD02L/DD03L/the row SELECT read a
 * host variable instead of a literal table name, and the class is shipped
 * once rather than regenerated. Reshaped to the fluid body-class contract
 * (`run( iv_action, iv_json )` against `ZCL_ZMCP_FLUID_RT`) instead of
 * `IF_OO_ADT_CLASSRUN`, following `run.ts`. Writes nothing.
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

    CONSTANTS c_max_rows TYPE i VALUE 50.

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

    CLASS-METHODS emit
      IMPORTING
        iv_line TYPE string.

ENDCLASS.


CLASS zcl_zmcp_fluid_img IMPLEMENTATION.

  METHOD run.
    zcl_zmcp_fluid_rt=>begin( iv_id = 'img' iv_action = iv_action ).

    IF iv_action <> 'preview'.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'dispatch'
        iv_text = |unknown action "{ iv_action }"| ).
      zcl_zmcp_fluid_rt=>end( 1 ).
      RETURN.
    ENDIF.

    TRY.
        parse_json( iv_json ).
      CATCH cx_root INTO DATA(lx_json).
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args' iv_text = lx_json->get_text( ) ).
        zcl_zmcp_fluid_rt=>end( 1 ).
        RETURN.
    ENDTRY.

    DATA(lv_table)     = jget( 'table' ).
    DATA(lv_key_count) = count_scalar_array( 'keyFields' ).
    DATA(lv_row_count) = count_object_array( 'rows' ).

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

    IF lv_row_count > c_max_rows.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
        iv_text = |{ lv_row_count } rows exceeds the { c_max_rows }-row limit for one call| ).
      zcl_zmcp_fluid_rt=>end( 1 ).
      RETURN.
    ENDIF.

    DATA(lv_probe_ok) = probe( iv_table = lv_table iv_key_count = lv_key_count
      iv_row_count = lv_row_count ).

    IF lv_probe_ok = abap_false.
      zcl_zmcp_fluid_rt=>end( 1 ).
      RETURN.
    ENDIF.

    zcl_zmcp_fluid_rt=>end( 0 ).
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

  METHOD emit.
    zcl_zmcp_fluid_rt=>out( |"{ zcl_zmcp_fluid_rt=>esc( iv_line ) }"| ).
  ENDMETHOD.

ENDCLASS.
`;

export const imgManifest: FluidManifest = {
  contract: FLUID_CONTRACT,
  id: "img",
  title: "IMG preview",
  description: "Read-only preview of an IMG (SPRO customizing) table's DDIC shape and named rows.",
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
      description: "fluid: previews an IMG table's DDIC shape and rows",
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
  ],
};

export const imgSources: ReadonlyMap<string, string> = new Map([
  [FLUID_RUNTIME_CLASS, RUNTIME_SOURCE],
  ["ZCL_ZMCP_FLUID_IMG", IMG_SOURCE],
]);
