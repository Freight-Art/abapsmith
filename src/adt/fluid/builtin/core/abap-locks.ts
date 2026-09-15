/**
 * `core.locks`: a read-only SM12-shaped view over the enqueue table via
 * `ENQUEUE_READ`. There is no release action here, and there never will be
 * one — `core` is a generic read surface, and a `DEQUEUE` path would let an
 * ad-hoc fluid action release a lock it has no way to know is safe to
 * release. `fpm-lock.ts` builds a whole self-identification feature (MINE
 * vs FOREIGN, GUSR vs GUNAME, wildcard-fill detection) before it will ever
 * call `DEQUEUE` against one specific, known lock object — that is not
 * something a three-argument generic filter can approximate safely for an
 * arbitrary SM12 lock. If a caller needs to release a lock, that has to be
 * a deliberate, named, audited action, not a side door through `core`.
 *
 * `ENQUEUE_READ` is called with `gclient`, `gname`, `garg` and `guname` all
 * explicit `space` — see `fpm-lock.ts`'s own `read_locks`, whose doc comment
 * records the trap this mirrors: `GUNAME` defaults to `SY-UNAME` and
 * `GCLIENT` to `SY-MANDT` when omitted, so a naive call only ever sees the
 * calling user's own locks in the current client. Passing `space`
 * explicitly is what makes every user's locks in every client visible.
 * `object`/`table`/`user` filtering therefore happens entirely client-side
 * in this method, against the unfiltered result, using the `CP` pattern
 * operator (`*` wildcard, exact match when the caller passes none):
 * `ENQUEUE_READ`'s own `GARG` filter is exact-match only and does not do
 * prefix/wildcard matching server-side (confirmed live against A4H in
 * `fpm-lock.ts`: `GARGNOWC = 'X'` changed nothing), so there is no
 * server-side shortcut available to take instead.
 *
 * `object`, `table` and `user` are uppercased before filtering. `object`
 * matches against `SEQG3-GNAME` OR `SEQG3-GOBJ`; `table` matches against
 * `SEQG3-GARG`; `user` matches against `SEQG3-GUNAME`. These field names do
 * not line up with the argument names, because SEQG3's own naming does not
 * describe what the fields hold: `GNAME` is the lock's primary table name,
 * `GOBJ` is the lock object name (only some lock objects fill it), and
 * `GARG` is the lock argument — the client plus the key values, which is
 * where a repository object's own name actually shows up for the locks ADT
 * takes (issue #116's example is `table=*ZTAB*` matching a `GARG` that
 * contains `ZTAB`). `object` is checked against both `GNAME` and `GOBJ`
 * because which of the two a given lock object populates varies, and
 * matching either is what makes the argument usable without the caller
 * having to know which field their particular lock object fills. SM12's own
 * fields are conventionally upper case, and a caller typing a table or user
 * name in whatever case they normally use should not get a silent no-match.
 * None of this field-population behavior was verified live; it follows from
 * SEQG3's own field definitions. At least one of the three is required: an
 * unfiltered dump of the whole enqueue table is rarely what anyone actually
 * wants, and the `max` clamp (default 50) downstream does not make an
 * accidental whole-table read cheap, just short.
 *
 * `SEQG3`'s diagnostic `GT*` fields (`GTCODE`/`GTHOST`/`GTDATE`/`GTTIME`/
 * `GTWP`/`GTSYSNR`/`GTUSEC`) are not part of every release's DDIC
 * definition of `SEQG3`. Referencing an absent one via static component
 * access (`ls_enq-gtcode`) would fail ABAP *activation*, not just return
 * blank, so their presence is probed once via `cl_abap_structdescr` and
 * read only through dynamic `ASSIGN COMPONENT ... OF STRUCTURE`, which
 * resolves the component at runtime instead of compile time.
 *
 * `garg` is emitted exactly as `ENQUEUE_READ` returns it, wildcard fill
 * character and all — this method has no idea what lock object it is
 * looking at, so it cannot decode a `GARG` the way `fpm-lock.ts`'s
 * FPM-specific `parseGarg` segment logic does; that layout (configId /
 * configType / configVar byte offsets) is specific to the `WDY_CONFIG`
 * lock-key scheme FPM uses and does not generalise to an arbitrary SM12
 * lock over some other object or table. `enqueue-read.ts` (the TypeScript
 * side of this action) only ever does the generic, layout-independent
 * substitution of the observed wildcard-fill character for display.
 */
import type { CoreAbapPart } from "./abap-core.js";

export const locksPart: CoreAbapPart = {
  actions: [{ action: "locks", method: "do_locks" }],
  source: `  METHOD do_locks.
    DATA lv_object    TYPE string.
    DATA lv_table     TYPE string.
    DATA lv_user      TYPE string.
    DATA lv_max_locks       TYPE i.
    DATA lv_read      TYPE i.
    DATA lv_matched   TYPE i.
    DATA lv_kept      TYPE i.
    DATA lv_trunc     TYPE abap_bool.
    DATA lv_first     TYPE abap_bool.
    DATA lv_json      TYPE string.
    DATA lv_gtval     TYPE string.
    DATA lv_now_d     TYPE d.
    DATA lv_now_t     TYPE t.
    DATA lv_server    TYPE string.
    DATA lv_lk_number TYPE i.
    DATA lv_lk_subrc  TYPE sy-subrc.
    DATA lt_enq       TYPE STANDARD TABLE OF seqg3 WITH DEFAULT KEY.
    DATA ls_enq       TYPE seqg3.
    DATA lo_type      TYPE REF TO cl_abap_typedescr.
    DATA lo_struct    TYPE REF TO cl_abap_structdescr.
    DATA ls_comp      TYPE abap_compdescr.
    TYPES: BEGIN OF ty_opt,
             comp    TYPE string,
             key     TYPE string,
             present TYPE abap_bool,
           END OF ty_opt.
    DATA lt_opt TYPE STANDARD TABLE OF ty_opt WITH DEFAULT KEY.
    DATA ls_opt TYPE ty_opt.
    FIELD-SYMBOLS <lv_gt> TYPE any.

    lv_object = to_upper( s( 'object' ) ).
    lv_table  = to_upper( s( 'table' ) ).
    lv_user   = to_upper( s( 'user' ) ).
    lv_max_locks    = num( 'max' ).
    IF lv_object IS INITIAL AND lv_table IS INITIAL AND lv_user IS INITIAL.
      fail( 'at least one of object, table or user is required' ).
      RETURN.
    ENDIF.
    IF lv_max_locks <= 0.
      lv_max_locks = 50.
    ENDIF.

    CLEAR ls_opt.
    ls_opt-comp = 'GTCODE'.
    ls_opt-key  = 'tcode'.
    APPEND ls_opt TO lt_opt.
    CLEAR ls_opt.
    ls_opt-comp = 'GTHOST'.
    ls_opt-key  = 'host'.
    APPEND ls_opt TO lt_opt.
    CLEAR ls_opt.
    ls_opt-comp = 'GTDATE'.
    ls_opt-key  = 'date'.
    APPEND ls_opt TO lt_opt.
    CLEAR ls_opt.
    ls_opt-comp = 'GTTIME'.
    ls_opt-key  = 'time'.
    APPEND ls_opt TO lt_opt.
    CLEAR ls_opt.
    ls_opt-comp = 'GTWP'.
    ls_opt-key  = 'wp'.
    APPEND ls_opt TO lt_opt.
    CLEAR ls_opt.
    ls_opt-comp = 'GTSYSNR'.
    ls_opt-key  = 'sysnr'.
    APPEND ls_opt TO lt_opt.
    CLEAR ls_opt.
    ls_opt-comp = 'GTUSEC'.
    ls_opt-key  = 'usec'.
    APPEND ls_opt TO lt_opt.

    cl_abap_typedescr=>describe_by_name(
      EXPORTING  p_name         = 'SEQG3'
      RECEIVING  p_descr_ref    = lo_type
      EXCEPTIONS type_not_found = 1
                 OTHERS         = 2 ).
    IF sy-subrc = 0 AND lo_type->kind = cl_abap_typedescr=>kind_struct.
      lo_struct ?= lo_type.
      LOOP AT lo_struct->components INTO ls_comp.
        READ TABLE lt_opt INTO ls_opt WITH KEY comp = ls_comp-name.
        IF sy-subrc = 0.
          ls_opt-present = abap_true.
          MODIFY lt_opt FROM ls_opt INDEX sy-tabix TRANSPORTING present.
        ENDIF.
      ENDLOOP.
    ENDIF.

    lv_json = '{"kind":"meta"'.
    lv_json = lv_json && |,"object":"{ zcl_zmcp_fluid_rt=>esc( lv_object ) }"|.
    lv_json = lv_json && |,"table":"{ zcl_zmcp_fluid_rt=>esc( lv_table ) }"|.
    lv_json = lv_json && |,"user":"{ zcl_zmcp_fluid_rt=>esc( lv_user ) }"|.
    lv_json = lv_json && |,"max":{ lv_max_locks }|.
    lv_json = lv_json && ',"fields_present":['.
    lv_first = abap_true.
    LOOP AT lt_opt INTO ls_opt WHERE present = abap_true.
      IF lv_first = abap_false.
        lv_json = lv_json && ','.
      ENDIF.
      lv_first = abap_false.
      lv_json = lv_json && |"{ ls_opt-key }"|.
    ENDLOOP.
    lv_json = lv_json && ']}'.
    zcl_zmcp_fluid_rt=>out( lv_json ).

    CALL FUNCTION 'ENQUEUE_READ'
      EXPORTING
        gclient               = space
        gname                 = space
        garg                  = space
        guname                = space
      IMPORTING
        number                = lv_lk_number
        subrc                 = lv_lk_subrc
      TABLES
        enq                   = lt_enq
      EXCEPTIONS
        communication_failure = 1
        system_failure        = 2
        OTHERS                = 3.
    IF sy-subrc <> 0.
      fail( |ENQUEUE_READ failed subrc={ sy-subrc }| ).
      RETURN.
    ENDIF.

    lv_read    = lines( lt_enq ).
    lv_matched = 0.
    lv_kept    = 0.
    LOOP AT lt_enq INTO ls_enq.
      " object can land in either GNAME or GOBJ depending on which the lock
      " object populates - matching either is what lets the caller find "the
      " lock on this object" without knowing which field their particular
      " lock object fills.
      IF lv_object IS NOT INITIAL AND NOT ( ls_enq-gname CP lv_object OR ls_enq-gobj CP lv_object ).
        CONTINUE.
      ENDIF.
      IF lv_table IS NOT INITIAL AND NOT ls_enq-garg CP lv_table.
        CONTINUE.
      ENDIF.
      IF lv_user IS NOT INITIAL AND NOT ls_enq-guname CP lv_user.
        CONTINUE.
      ENDIF.
      lv_matched = lv_matched + 1.
      IF lv_kept >= lv_max_locks.
        CONTINUE.
      ENDIF.
      lv_kept = lv_kept + 1.

      lv_json = '{"kind":"lock"'.
      lv_json = lv_json && |,"gname":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_enq-gname ) ) }"|.
      lv_json = lv_json && |,"gobj":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_enq-gobj ) ) }"|.
      lv_json = lv_json && |,"garg":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_enq-garg ) ) }"|.
      lv_json = lv_json && |,"gmode":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_enq-gmode ) ) }"|.
      lv_json = lv_json && |,"guname":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_enq-guname ) ) }"|.
      lv_json = lv_json && |,"gclient":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_enq-gclient ) ) }"|.
      lv_json = lv_json && |,"gusr":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_enq-gusr ) ) }"|.
      lv_json = lv_json && |,"gusrvb":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_enq-gusrvb ) ) }"|.
      lv_json = lv_json && |,"guse":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_enq-guse ) ) }"|.
      lv_json = lv_json && |,"gusevb":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_enq-gusevb ) ) }"|.
      LOOP AT lt_opt INTO ls_opt WHERE present = abap_true.
        ASSIGN COMPONENT ls_opt-comp OF STRUCTURE ls_enq TO <lv_gt>.
        IF sy-subrc = 0.
          lv_gtval = <lv_gt>.
          lv_json = lv_json && |,"{ ls_opt-key }":"{ zcl_zmcp_fluid_rt=>esc( lv_gtval ) }"|.
        ENDIF.
      ENDLOOP.
      lv_json = lv_json && '}'.
      zcl_zmcp_fluid_rt=>out( lv_json ).
    ENDLOOP.

    IF lv_matched > lv_kept.
      lv_trunc = abap_true.
    ELSE.
      lv_trunc = abap_false.
    ENDIF.

    lv_now_d = sy-datum.
    lv_now_t = sy-uzeit.
    lv_server = |{ lv_now_d DATE = RAW }{ lv_now_t TIME = RAW }|.

    lv_json = '{"kind":"summary"'.
    lv_json = lv_json && |,"locks_read":{ lv_read }|.
    lv_json = lv_json && |,"matched":{ lv_matched }|.
    lv_json = lv_json && |,"kept":{ lv_kept }|.
    IF lv_trunc = abap_true.
      lv_json = lv_json && ',"truncated":true'.
    ELSE.
      lv_json = lv_json && ',"truncated":false'.
    ENDIF.
    lv_json = lv_json && |,"server_time":"{ lv_server }"|.
    lv_json = lv_json && '}'.
    zcl_zmcp_fluid_rt=>out( lv_json ).
  ENDMETHOD.`,
};
