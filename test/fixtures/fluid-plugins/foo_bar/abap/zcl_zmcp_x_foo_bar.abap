CLASS zcl_zmcp_x_foo_bar DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run IMPORTING iv_action TYPE string
                                iv_json   TYPE string.
ENDCLASS.

CLASS zcl_zmcp_x_foo_bar IMPLEMENTATION.
  METHOD run.
    zcl_zmcp_fluid_rt=>out( '{"reply":"pong"}' ).
  ENDMETHOD.
ENDCLASS.
