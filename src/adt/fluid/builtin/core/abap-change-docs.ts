/**
 * `core.change_docs`: reads the standard SAP change-document trail —
 * `CDHDR` joined to `CDPOS` — directly with Open SQL, rather than by calling
 * function module `CHANGEDOCUMENT_READ`.
 *
 * What was actually observed live on system A4H, 2026-09-15: `core.describe_fm`
 * was called against `CHANGEDOCUMENT_READ` and returned its interface —
 * `OBJECTCLASS` required; `OBJECTID`, `USERNAME`, `TABLENAME`, `TABLEKEY` and
 * `CHANGENUMBER` optional; a `DATE_OF_CHANGE`/`TIME_OF_CHANGE` to
 * `DATE_UNTIL`/`TIME_UNTIL` window; an importing switch named
 * `NOPLUS_ASWILDCARD_INOBJID`; `TABLES EDITPOS TYPE CDRED`; `EXPORTING
 * ET_CDRED_STR TYPE CDRED_STR_TAB`; and the exceptions `NO_POSITION_FOUND`,
 * `WRONG_ACCESS_TO_ARCHIVE`, `TIME_ZONE_CONVERSION_ERROR`. No probe class was
 * ever written, `TCDBUSS` was never read, and the function module was never
 * actually called — none of what follows was executed, only inferred from
 * that interface shape.
 *
 * The inference: this function module would work, but its interface makes
 * wildcard handling of `OBJECTID` depend on a caller-supplied
 * `NOPLUS_ASWILDCARD_INOBJID` switch whose semantics this action would have
 * to mirror to behave consistently, and it appears to signal "nothing
 * matched" through the `NO_POSITION_FOUND` exception rather than an empty
 * result — a shape this action's contract (always `*`/`%`-wildcard patterns,
 * always a clean empty result when nothing matches, never a raised
 * exception) does not want to depend on. The exception's exact trigger
 * conditions were NOT exercised live, so this rests on the interface, not on
 * observed behavior. A direct `SELECT` against `CDHDR`/`CDPOS` sidesteps
 * both concerns and gives this action uniform pattern semantics and a clean
 * empty result on every system, regardless of how any switch happens to be
 * configured there. Issue #114 explicitly allows this direct-`SELECT`
 * alternative.
 *
 * No authorization or deny-list policy lives in this ABAP. `core.change_docs`
 * reads application data indiscriminately, by design — the
 * `ABAP_ALLOW_DATA_PREVIEW` capability flag and the per-table deny-list are
 * both applied entirely in TypeScript: `guardCoreAction` in `core.ts` gates
 * whether the action runs at all, and `applyPositionPolicy` in
 * `src/adt/change-docs.ts` judges every table a returned `CDPOS` row names
 * (via `tabname`) and drops positions the policy denies before anything is
 * shown to a caller. This method has no opinion on any of that; it only
 * reads and reports what `CDHDR`/`CDPOS` actually contain for the given
 * filter and window.
 */
import type { CoreAbapPart } from "./abap-core.js";

export const changeDocsPart: CoreAbapPart = {
  actions: [{ action: "change_docs", method: "do_change_docs" }],
  source: `  METHOD do_change_docs.
    TYPES: BEGIN OF ty_hdr,
             objectclas TYPE cdhdr-objectclas,
             objectid   TYPE cdhdr-objectid,
             changenr   TYPE cdhdr-changenr,
             username   TYPE cdhdr-username,
             udate      TYPE cdhdr-udate,
             utime      TYPE cdhdr-utime,
             tcode      TYPE cdhdr-tcode,
             change_ind TYPE cdhdr-change_ind,
           END OF ty_hdr.
    TYPES: BEGIN OF ty_pos,
             tabname   TYPE cdpos-tabname,
             tabkey    TYPE cdpos-tabkey,
             fname     TYPE cdpos-fname,
             chngind   TYPE cdpos-chngind,
             value_new TYPE cdpos-value_new,
             value_old TYPE cdpos-value_old,
           END OF ty_pos.

    DATA lv_class    TYPE string.
    DATA lv_objid_in TYPE string.
    DATA lv_user_in  TYPE string.
    DATA lv_tcode_in TYPE string.
    DATA lv_objid    TYPE string.
    DATA lv_user     TYPE string.
    DATA lv_tcode    TYPE string.
    DATA lv_since    TYPE string.
    DATA lv_until    TYPE string.
    DATA lv_max      TYPE i.
    DATA lv_probe    TYPE i.
    DATA lv_now_d    TYPE d.
    DATA lv_now_t    TYPE t.
    DATA lv_d_since  TYPE d.
    DATA lv_t_since  TYPE t.
    DATA lv_d_until  TYPE d.
    DATA lv_t_until  TYPE t.
    DATA lt_hdr      TYPE STANDARD TABLE OF ty_hdr WITH EMPTY KEY.
    DATA lt_pos      TYPE STANDARD TABLE OF ty_pos WITH EMPTY KEY.
    DATA lv_truncated TYPE abap_bool.
    DATA lv_truncated_lit     TYPE string.
    DATA lv_udate_s           TYPE string.
    DATA lv_utime_s           TYPE string.
    DATA lv_since_s           TYPE string.
    DATA lv_until_s           TYPE string.
    DATA lv_server_time       TYPE string.
    DATA lv_changes_returned  TYPE i.
    DATA lv_positions_returned TYPE i.

    lv_class = to_upper( s( 'objectclass' ) ).
    IF lv_class IS INITIAL.
      fail( 'objectclass is required' ).
      RETURN.
    ENDIF.

    lv_objid_in = to_upper( s( 'objectid' ) ).
    IF lv_objid_in IS INITIAL.
      lv_objid = '%'.
    ELSE.
      REPLACE ALL OCCURRENCES OF '*' IN lv_objid_in WITH '%'.
      lv_objid = lv_objid_in.
    ENDIF.

    lv_user_in = to_upper( s( 'user' ) ).
    IF lv_user_in IS INITIAL.
      lv_user = '%'.
    ELSE.
      REPLACE ALL OCCURRENCES OF '*' IN lv_user_in WITH '%'.
      lv_user = lv_user_in.
    ENDIF.

    lv_tcode_in = to_upper( s( 'tcode' ) ).
    IF lv_tcode_in IS INITIAL.
      lv_tcode = '%'.
    ELSE.
      REPLACE ALL OCCURRENCES OF '*' IN lv_tcode_in WITH '%'.
      lv_tcode = lv_tcode_in.
    ENDIF.

    lv_max = num( 'max' ).
    IF lv_max <= 0.
      lv_max = 20.
    ENDIF.
    lv_probe = lv_max + 1.

    " One server-time snapshot for both the default window and the summary's
    " server_time, so the two never disagree about "now". since/until are
    " always server time, YYYYMMDDHHMMSS, no time zone conversion.
    GET TIME.
    lv_now_d = sy-datum.
    lv_now_t = sy-uzeit.

    lv_d_until = lv_now_d.
    lv_t_until = lv_now_t.
    lv_until = s( 'until' ).
    IF lv_until IS NOT INITIAL.
      IF strlen( lv_until ) <> 14 OR lv_until CN '0123456789'.
        fail( |until must be 14 digits YYYYMMDDHHMMSS, got "{ lv_until }"| ).
        RETURN.
      ENDIF.
      lv_d_until = lv_until(8).
      lv_t_until = lv_until+8(6).
    ENDIF.

    " Default since is exactly 24 hours before "now": same time of day, the
    " previous calendar day - TYPE D arithmetic already rolls over month and
    " year boundaries correctly, so no timestamp conversion is needed here.
    lv_d_since = lv_now_d - 1.
    lv_t_since = lv_now_t.
    lv_since = s( 'since' ).
    IF lv_since IS NOT INITIAL.
      IF strlen( lv_since ) <> 14 OR lv_since CN '0123456789'.
        fail( |since must be 14 digits YYYYMMDDHHMMSS, got "{ lv_since }"| ).
        RETURN.
      ENDIF.
      lv_d_since = lv_since(8).
      lv_t_since = lv_since+8(6).
    ENDIF.

    " UP TO @lv_probe ROWS fetches one row past lv_max, purely to detect
    " truncation - see the DELETE below, the same probe pattern core.log
    " uses for BAL_DB_SEARCH's result.
    TRY.
        SELECT objectclas, objectid, changenr, username, udate, utime, tcode, change_ind
          FROM cdhdr
          WHERE objectclas = @lv_class
            AND objectid LIKE @lv_objid
            AND username LIKE @lv_user
            AND tcode LIKE @lv_tcode
            AND ( udate > @lv_d_since OR ( udate = @lv_d_since AND utime >= @lv_t_since ) )
            AND ( udate < @lv_d_until OR ( udate = @lv_d_until AND utime <= @lv_t_until ) )
          ORDER BY udate DESCENDING, utime DESCENDING, changenr DESCENDING
          INTO TABLE @lt_hdr
          UP TO @lv_probe ROWS.
      CATCH cx_root INTO DATA(lx_hdr).
        fail( |change-document read failed: { lx_hdr->get_text( ) }| ).
        RETURN.
    ENDTRY.

    lv_truncated = abap_false.
    IF lines( lt_hdr ) > lv_max.
      lv_truncated = abap_true.
      " DELETE ... FROM requires a data object, not an arithmetic expression.
      DELETE lt_hdr FROM lv_probe.
    ENDIF.

    lv_changes_returned = 0.
    lv_positions_returned = 0.

    LOOP AT lt_hdr INTO DATA(ls_hdr).
      lv_changes_returned = lv_changes_returned + 1.

      CLEAR lt_pos.
      TRY.
          SELECT tabname, tabkey, fname, chngind, value_new, value_old
            FROM cdpos
            WHERE objectclas = @ls_hdr-objectclas
              AND objectid = @ls_hdr-objectid
              AND changenr = @ls_hdr-changenr
            INTO TABLE @lt_pos.
        CATCH cx_root INTO DATA(lx_pos).
          fail( |change-document position read failed: { lx_pos->get_text( ) }| ).
          RETURN.
      ENDTRY.

      lv_udate_s = |{ ls_hdr-udate DATE = RAW }|.
      lv_utime_s = |{ ls_hdr-utime TIME = RAW }|.

      zcl_zmcp_fluid_rt=>out(
        |\\{"kind":"header","objectclas":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_hdr-objectclas ) ) }",| &&
        |"objectid":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_hdr-objectid ) ) }",| &&
        |"changenr":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_hdr-changenr ) ) }",| &&
        |"username":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_hdr-username ) ) }",| &&
        |"udate":"{ zcl_zmcp_fluid_rt=>esc( lv_udate_s ) }",| &&
        |"utime":"{ zcl_zmcp_fluid_rt=>esc( lv_utime_s ) }",| &&
        |"tcode":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_hdr-tcode ) ) }",| &&
        |"change_ind":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_hdr-change_ind ) ) }"\\}| ).

      LOOP AT lt_pos INTO DATA(ls_pos).
        lv_positions_returned = lv_positions_returned + 1.
        zcl_zmcp_fluid_rt=>out(
          |\\{"kind":"pos","changenr":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_hdr-changenr ) ) }",| &&
          |"tabname":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_pos-tabname ) ) }",| &&
          |"tabkey":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_pos-tabkey ) ) }",| &&
          |"fname":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_pos-fname ) ) }",| &&
          |"chngind":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_pos-chngind ) ) }",| &&
          |"value_old":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_pos-value_old ) ) }",| &&
          |"value_new":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_pos-value_new ) ) }"\\}| ).
      ENDLOOP.
    ENDLOOP.

    lv_since_s = |{ lv_d_since DATE = RAW }{ lv_t_since TIME = RAW }|.
    lv_until_s = |{ lv_d_until DATE = RAW }{ lv_t_until TIME = RAW }|.
    lv_server_time = |{ lv_now_d DATE = RAW }{ lv_now_t TIME = RAW }|.

    IF lv_truncated = abap_true.
      lv_truncated_lit = 'true'.
    ELSE.
      lv_truncated_lit = 'false'.
    ENDIF.

    zcl_zmcp_fluid_rt=>out(
      |\\{"kind":"summary","changes_returned":{ lv_changes_returned },| &&
      |"positions_returned":{ lv_positions_returned },| &&
      |"truncated":{ lv_truncated_lit },| &&
      |"objectclass":"{ zcl_zmcp_fluid_rt=>esc( lv_class ) }",| &&
      |"objectid":"{ zcl_zmcp_fluid_rt=>esc( lv_objid ) }",| &&
      |"user":"{ zcl_zmcp_fluid_rt=>esc( lv_user ) }",| &&
      |"tcode":"{ zcl_zmcp_fluid_rt=>esc( lv_tcode ) }",| &&
      |"since":"{ zcl_zmcp_fluid_rt=>esc( lv_since_s ) }",| &&
      |"until":"{ zcl_zmcp_fluid_rt=>esc( lv_until_s ) }",| &&
      |"max":{ lv_max },| &&
      |"server_time":"{ zcl_zmcp_fluid_rt=>esc( lv_server_time ) }"\\}| ).
  ENDMETHOD.`,
};
