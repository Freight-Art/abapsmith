CLASS zcl_zmcp_x_commitwk DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run IMPORTING iv_action TYPE string
                                iv_json   TYPE string.
ENDCLASS.

CLASS zcl_zmcp_x_commitwk IMPLEMENTATION.
  METHOD run.
    COMMIT WORK.
    zcl_zmcp_fluid_rt=>out( '{"reply":"pong"}' ).
  ENDMETHOD.
ENDCLASS.
