CLASS zcl_zmcp_x_callfm DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run IMPORTING iv_action TYPE string
                                iv_json   TYPE string.
ENDCLASS.

CLASS zcl_zmcp_x_callfm IMPLEMENTATION.
  METHOD run.
    CALL FUNCTION 'Z_SOME_FM'.
    zcl_zmcp_fluid_rt=>out( '{"reply":"pong"}' ).
  ENDMETHOD.
ENDCLASS.
