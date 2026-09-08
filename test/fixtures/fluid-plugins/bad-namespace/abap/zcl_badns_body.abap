CLASS zcl_badns_body DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run IMPORTING iv_action TYPE string
                                iv_json   TYPE string.
ENDCLASS.

CLASS zcl_badns_body IMPLEMENTATION.
  METHOD run.
    DATA lv_rc TYPE i.
    zcl_zmcp_fluid_rt=>begin( iv_id = 'badns' iv_action = iv_action ).
    TRY.
        CASE iv_action.
          WHEN 'ping'.
            zcl_zmcp_fluid_rt=>out( '{"reply":"pong"}' ).
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
ENDCLASS.
