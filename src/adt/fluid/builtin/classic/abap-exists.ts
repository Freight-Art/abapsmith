/**
 * A read-only `exists` check across the four object kinds `classic` mutates,
 * so a caller can probe before create/delete without a dedicated round trip
 * per kind. No `COMMIT WORK` — this method only selects.
 */
import type { ClassicAbapPart } from "./abap-core.js";

export const existsPart: ClassicAbapPart = {
  methods: ["exists"],
  source: `  METHOD exists.
    DATA(lv_kind) = s( 'kind' ).
    DATA(lv_name) = s( 'name' ).
    DATA(lv_base_table) = s( 'base_table' ).
    DATA lv_count TYPE i.
    DATA lv_viewname TYPE dd25l-viewname.
    DATA lv_tcode TYPE tstc-tcode.
    DATA lv_devclass TYPE tdevc-devclass.
    DATA lv_indexname TYPE dd12v-indexname.
    DATA lv_sqltab TYPE tabname.

    CASE lv_kind.
      WHEN 'view'.
        lv_viewname = lv_name.
        SELECT COUNT( * ) FROM dd25l INTO @lv_count WHERE viewname = @lv_viewname.
      WHEN 'transaction'.
        lv_tcode = lv_name.
        SELECT COUNT( * ) FROM tstc INTO @lv_count WHERE tcode = @lv_tcode.
      WHEN 'package'.
        lv_devclass = lv_name.
        SELECT COUNT( * ) FROM tdevc INTO @lv_count WHERE devclass = @lv_devclass.
      WHEN 'index'.
        lv_indexname = lv_name.
        lv_sqltab = lv_base_table.
        SELECT COUNT( * ) FROM dd12v INTO @lv_count
          WHERE sqltab = @lv_sqltab AND indexname = @lv_indexname AND as4local = 'A'.
      WHEN OTHERS.
        fail( |unknown kind { lv_kind }| ).
        RETURN.
    ENDCASE.

    IF lv_count > 0.
      line( 'EXISTS' ).
    ELSE.
      line( 'ABSENT' ).
    ENDIF.
  ENDMETHOD.`,
};
