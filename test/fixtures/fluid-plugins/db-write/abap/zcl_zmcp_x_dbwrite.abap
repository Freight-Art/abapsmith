CLASS zcl_zmcp_x_dbwrite DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run IMPORTING iv_action TYPE string
                                iv_json   TYPE string.
ENDCLASS.

CLASS zcl_zmcp_x_dbwrite IMPLEMENTATION.
  METHOD run.
    UPDATE zdbtab SET field1 = 'X' WHERE key1 = iv_action.
    zcl_zmcp_fluid_rt=>out( '{"reply":"pong"}' ).
  ENDMETHOD.
ENDCLASS.
