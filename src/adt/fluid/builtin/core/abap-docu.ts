/**
 * `core.docu`: reads SAP's own documentation — `DOKHL`/`DOKIL`/`DOKTL`, via
 * the `DOCU_GET` function module — for one documentation object, and
 * flattens its ITF source to plain text with `CONVERT_ITF_TO_ASCII`, the
 * same function module SAP's own `DOCU_GET_WITH_CONVERT` calls to do the
 * flattening.
 *
 * Every function-module signature below (`DOCU_GET`'s IMPORTING/TABLES/
 * EXCEPTIONS parameters, `CONVERT_ITF_TO_ASCII`'s EXPORTING/IMPORTING/
 * TABLES parameters) was VERIFIED LIVE on system A4H (probe class
 * ZCL_I109_PROBE, 2026-09-15). What was observed there, and is relied on
 * here:
 *   - `DOKHL-ID` / `DOKHL-OBJECT` are CHAR 2 / CHAR 40. Passing a longer
 *     string straight into `DOCU_GET`'s `ID` parameter truncates and
 *     dumps rather than failing cleanly, so the caller's input is moved
 *     through DDIC-typed local variables first — that gets ABAP's own,
 *     non-dumping truncation instead of a runtime error.
 *   - `DOCU_GET` does not fall back across languages by itself:
 *     `sy-subrc = 4` (its `ret_code` exception) is exactly what comes back
 *     when the object has no documentation in the requested language, so
 *     `do_docu` tries each candidate language itself, in order, and stops
 *     at the first one that returns any lines.
 *   - Passing `typ = 'E'` to `DOCU_GET` is safe even when `DOKIL` lists the
 *     object as type `T`: both a `TB` and a `DDFTX` documentation object
 *     returned `doktyp = 'E'` regardless.
 *   - `CONVERT_ITF_TO_ASCII` resolves `&FUNCTIONALITY&` -> "Functionality"
 *     and `&USE&` -> "Use", strips `<DS:TX.X>...</>` / `<AB>...</>`
 *     formatting tags, and expands `/: INCLUDE ...` directives — a
 *     `BAL_DB_SEARCH` documentation with 6 ITF lines expanded to 36 ASCII
 *     lines.
 *
 * `core.docu` reads documentation text out of `DOKTL`, not application
 * table data, so it is deliberately NOT judged by `guardCoreAction`'s
 * data-preview policy: neither `assertDataPreview` nor
 * `ABAP_ALLOW_DATA_PREVIEW` has anything to say about SAP's own
 * documentation text.
 */
import type { CoreAbapPart } from "./abap-core.js";

export const docuPart: CoreAbapPart = {
  actions: [{ action: "docu", method: "do_docu" }],
  source: `  METHOD do_docu.
    DATA lv_id_in       TYPE string.
    DATA lv_object_in   TYPE string.
    DATA lv_langu_in    TYPE string.
    DATA lv_id          TYPE dokhl-id.
    DATA lv_object      TYPE dokhl-object.
    DATA lv_try         TYPE dokil-langu.
    DATA lv_req_langu   TYPE dokil-langu.
    DATA lv_langu_used  TYPE dokil-langu.
    DATA lt_cand        TYPE STANDARD TABLE OF dokil-langu WITH DEFAULT KEY.
    DATA lv_found       TYPE abap_bool.
    DATA lv_state       TYPE dokhl-dokstate.
    " DDIC-typed (LIKE dsyst-doktitle, CHAR 60 via data element DOKU_TITLE),
    " not string: DOCU_GET is called dynamically below, and a dynamic call
    " rejects a generic string actual for a fixed-length character
    " IMPORTING parameter - observed live on A4H as
    " CX_SY_DYN_CALL_ILLEGAL_TYPE until this was DDIC-typed.
    DATA lv_title       TYPE dsyst-doktitle.
    DATA lv_typ         TYPE dokhl-typ.
    DATA ls_head        TYPE thead.
    DATA lt_line        TYPE TABLE OF tline.
    DATA lt_ascii       TYPE tdtab_c132.
    DATA lv_avail       TYPE string.
    DATA lv_avail_item  TYPE string.
    DATA lv_afirst      TYPE abap_bool.
    DATA lv_found_lit   TYPE string.
    DATA lv_fallback_lit TYPE string.
    DATA lv_json        TYPE string.
    DATA lv_text        TYPE string.
    DATA lv_lines       TYPE i.

    lv_id_in = to_upper( s( 'id' ) ).
    " Doc object names for the kinds core.docu supports (data elements,
    " domains, tables, classes, interfaces, function groups, programs,
    " message classes, IMG activities) are stored upper case in
    " DOKHL-OBJECT, so upper-casing the caller's input matches SAP's own
    " convention rather than silently missing a lower-case match.
    lv_object_in = to_upper( s( 'object' ) ).
    lv_langu_in  = to_upper( s( 'language' ) ).
    IF lv_id_in IS INITIAL OR lv_object_in IS INITIAL.
      fail( 'id and object are required' ).
      RETURN.
    ENDIF.
    " DDIC-typed, not string: see this file's header comment on why a
    " longer literal moved straight into DOCU_GET's ID would dump.
    lv_id     = lv_id_in.
    lv_object = lv_object_in.

    SELECT langu, typ, dokstate FROM dokil
      INTO TABLE @DATA(lt_avail)
      WHERE id = @lv_id AND object = @lv_object
      ORDER BY langu, typ.

    IF lv_langu_in IS NOT INITIAL.
      lv_try = lv_langu_in.
      APPEND lv_try TO lt_cand.
    ENDIF.
    lv_try = sy-langu.
    READ TABLE lt_cand TRANSPORTING NO FIELDS WITH KEY table_line = lv_try.
    IF sy-subrc <> 0.
      APPEND lv_try TO lt_cand.
    ENDIF.
    lv_try = 'E'.
    READ TABLE lt_cand TRANSPORTING NO FIELDS WITH KEY table_line = lv_try.
    IF sy-subrc <> 0.
      APPEND lv_try TO lt_cand.
    ENDIF.
    READ TABLE lt_cand INTO lv_req_langu INDEX 1.

    " lt_avail (DOKIL) only feeds the "available" report field below - it is
    " never consulted to pick which candidate to try, because DOKIL can be
    " stale and DOCU_GET already reports a language miss cheaply and
    " reliably via sy-subrc = 4 (ret_code). Trying every candidate through
    " DOCU_GET and keeping the first hit covers both the case where DOKIL
    " is accurate and the case where it is not.
    CLEAR lv_langu_used.
    lv_found = abap_false.
    LOOP AT lt_cand INTO lv_try.
      CLEAR lt_line.
      CALL FUNCTION 'DOCU_GET'
        EXPORTING  id                = lv_id
                   langu             = lv_try
                   object            = lv_object
                   typ               = 'E'
        IMPORTING  dokstate          = lv_state
                   doktitle          = lv_title
                   head              = ls_head
                   doktyp            = lv_typ
        TABLES     line              = lt_line
        EXCEPTIONS no_docu_on_screen = 1
                   no_docu_self_def  = 2
                   no_docu_temp      = 3
                   ret_code          = 4
                   OTHERS            = 5.
      IF sy-subrc = 0 AND lines( lt_line ) > 0.
        lv_langu_used = lv_try.
        lv_found = abap_true.
        EXIT.
      ENDIF.
    ENDLOOP.

    IF lv_found = abap_true.
      " CONVERT_ITF_TO_ASCII is what DOCU_GET_WITH_CONVERT itself calls to
      " flatten ITF to plain text; see this file's header comment for what
      " was observed live. core.docu never caps the number of lines here -
      " any truncation of the result is the TypeScript caller's job in
      " buildResponse, not this ABAP.
      CALL FUNCTION 'CONVERT_ITF_TO_ASCII'
        EXPORTING  formatwidth      = 100
                   language         = ls_head-tdspras
                   replace_symbols  = 'X'
                   replace_sapchars = 'X'
        IMPORTING  c_datatab        = lt_ascii
        TABLES     itf_lines        = lt_line
        EXCEPTIONS OTHERS           = 0.
    ENDIF.

    lv_avail = ''.
    lv_afirst = abap_true.
    LOOP AT lt_avail INTO DATA(ls_avail).
      IF lv_afirst = abap_false.
        lv_avail = lv_avail && ','.
      ENDIF.
      lv_afirst = abap_false.
      lv_avail_item = |{ ls_avail-langu }:{ ls_avail-typ }:{ ls_avail-dokstate }|.
      lv_avail = lv_avail && |"{ zcl_zmcp_fluid_rt=>esc( lv_avail_item ) }"|.
    ENDLOOP.

    IF lv_found = abap_true.
      lv_found_lit = 'true'.
    ELSE.
      lv_found_lit = 'false'.
    ENDIF.
    IF lv_found = abap_true AND lv_langu_used <> lv_req_langu.
      lv_fallback_lit = 'true'.
    ELSE.
      lv_fallback_lit = 'false'.
    ENDIF.

    " esc( ) is declared IMPORTING iv_text TYPE string; a DDIC C(n) actual
    " (lv_id and the other DDIC-typed locals below) is not assignable to a
    " string formal in a functional call, so each one is CONV-wrapped first.
    lv_json = |\\{"kind":"docu","id":"{ zcl_zmcp_fluid_rt=>esc( CONV string( lv_id ) ) }",|.
    lv_json = lv_json && |"object":"{ zcl_zmcp_fluid_rt=>esc( CONV string( lv_object ) ) }",|.
    lv_json = lv_json && |"found":{ lv_found_lit },|.
    lv_json = lv_json && |"language":"{ zcl_zmcp_fluid_rt=>esc( CONV string( lv_langu_used ) ) }",|.
    lv_json = lv_json && |"requested_language":"{ zcl_zmcp_fluid_rt=>esc( CONV string( lv_req_langu ) ) }",|.
    lv_json = lv_json && |"fallback_used":{ lv_fallback_lit },|.
    lv_json = lv_json && |"title":"{ zcl_zmcp_fluid_rt=>esc( CONV string( lv_title ) ) }",|.
    lv_json = lv_json && |"doktyp":"{ zcl_zmcp_fluid_rt=>esc( CONV string( lv_typ ) ) }",|.
    lv_json = lv_json && |"dokstate":"{ zcl_zmcp_fluid_rt=>esc( CONV string( lv_state ) ) }",|.
    lv_json = lv_json && |"flattened":true,|.
    lv_json = lv_json && |"available":[{ lv_avail }]\\}|.
    zcl_zmcp_fluid_rt=>out( lv_json ).

    lv_lines = 0.
    IF lv_found = abap_true.
      LOOP AT lt_ascii INTO DATA(lv_ascii).
        lv_text = lv_ascii.
        lv_json = |\\{"kind":"line","text":"{ zcl_zmcp_fluid_rt=>esc( lv_text ) }"\\}|.
        zcl_zmcp_fluid_rt=>out( lv_json ).
        lv_lines = lv_lines + 1.
      ENDLOOP.
    ENDIF.

    lv_json = |\\{"kind":"summary","lines_returned":{ lv_lines }\\}|.
    zcl_zmcp_fluid_rt=>out( lv_json ).
  ENDMETHOD.`,
};
