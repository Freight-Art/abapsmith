/**
 * Built-in "authtrace" fluid tool: SU53/kernel authorization-trace bridge.
 * Wraps three function modules behind one static `ZCL_ZMCP_FLUID_AUTHTRACE`
 * body class, modeled directly on `src/adt/fluid/builtin/run.ts` and
 * `src/adt/fluid/builtin/scan.ts` (same `begin`/`scan`/`s`/`b`/`err`/`end`/
 * `out`/`esc` calling convention against the shared `ZCL_ZMCP_FLUID_RT`
 * runtime).
 *
 * Every function-module signature, parameter name, and behavioural quirk
 * used below was observed live on an A4H system (see the classrun probe
 * findings this tool was built from), not guessed from documentation:
 *
 *  - `SUAUTH_SYSTEM_TRACE_FOR_AUTH` (status/on/off): `IV_FUNCTION` 0/1/2,
 *    `ES_RETURN` is a zeroed BAPIRET2 on every call (success is signalled by
 *    `EV_AUTH_ACTIVE`, never by a message), and the trace is USER-SCOPED
 *    (`IV_AUTH_FOR_USER`) on this release.
 *  - `SUAUTH_READ_TRACE_VALUES` (read, `IV_FUNCTION = 'USTC'`): observed to
 *    return zero rows on A4H even with the trace active and genuinely
 *    failing checks inside the window; the code below must not assume it
 *    ever returns rows. `IV_ST01_USER` is passed through even though the
 *    FM's internal 'USTC' path does not appear to honour it as a filter —
 *    it is still the documented/only user-scoping parameter this action has
 *    to offer, and passing it is harmless.
 *  - `SUSR_USER_SU53_READ` (su53): observed to return every failing check in
 *    the requested window, not merely "the last one" — the SU53 buffer, not
 *    a single-slot cache. `USR07_EXT-OBJCT` is CHAR10 and truncates long
 *    auth-object names; `RC` is passed through as observed from the failing
 *    `AUTHORITY-CHECK` (live capture: `sy-subrc = 12` read back as `rc =
 *    12`) — no general sy-subrc-to-rc mapping is documented or assumed here,
 *    only what was actually seen. `P_TCODE` is empty for ADT/classrun
 *    execution (no transaction code involved).
 *
 * `read` and `su53` intentionally emit the SAME row shape (origin/object/
 * rc/reason/fields/program/line/tcode/timestamp) so `src/adt/authtrace.ts`
 * can treat a kernel-trace row and an SU53 fallback row identically apart
 * from provenance.
 *
 * Observed live on A4H (2026-09-15): `on`'s `EV_TIMESTAMP` came back as
 * `"20260915100737 "` — 15 characters, with a trailing space — because
 * `lv_ts TYPE timestamp` is a packed/numeric type and `CONV string( lv_ts )`
 * renders its sign position as a literal trailing blank; a fixed-length
 * CHARACTER field assigned to a string does NOT have this problem (the
 * assignment itself drops trailing blanks). `read` and `su53` both reject a
 * `from` whose `strlen( ) <> 14`, so that stray blank made the read-back
 * half of this tool (and `withAuthTrace` in `src/adt/authtrace.ts`, which
 * feeds `on`'s timestamp straight through as `from`) fail every time on a
 * real system. `on`, `read`, and `su53` each `CONDENSE` every numeric/packed
 * value (`timestamp`, plus `rc`/`line` in `read`/`su53`) right before it is
 * embedded in the JSON for exactly this reason — do not remove those
 * `CONDENSE` calls or add a new numeric emission site without one.
 *
 * IMPORTANT — CALL FUNCTION type-checks EXPORTING parameters at RUNTIME, not
 * at syntax-check/activation time. `zcl_zmcp_fluid_rt=>s( )` returns
 * `TYPE string`, while `IV_AUTH_FOR_USER` (SUAUTH_SYSTEM_TRACE_FOR_AUTH),
 * `IV_ST01_USER` (SUAUTH_READ_TRACE_VALUES), and `IV_BNAME`
 * (SUSR_USER_SU53_READ) are all `TYPE xubname` (CHAR12). Passing the raw
 * string straight through compiles and activates cleanly, then raises
 * `CX_SY_DYN_CALL_ILLEGAL_TYPE` the moment the FM call actually executes —
 * observed live on A4H, action `on` (the first path that reached a
 * `string`-typed CALL FUNCTION parameter; `read`/`su53` have the identical
 * defect, just not yet observed because `on` failed first). `on`, `read`,
 * and `su53` each move the raw string into an `xubname` local (`lv_user_n`)
 * before the call for exactly this reason — do not "simplify" that back to
 * passing the string directly.
 */
import type { FluidManifest } from "../manifest.js";
import { FLUID_CONTRACT } from "../manifest.js";
import { FLUID_RUNTIME_CLASS, fluidRuntimeManifest, fluidRuntimeSources } from "../abap/runtime.js";

export const AUTHTRACE_TOOL_ID = "authtrace";
export const AUTHTRACE_ENTRY_CLASS = "ZCL_ZMCP_FLUID_AUTHTRACE";

export const AUTHTRACE_ACTION_STATUS = "status";
export const AUTHTRACE_ACTION_ON = "on";
export const AUTHTRACE_ACTION_OFF = "off";
export const AUTHTRACE_ACTION_READ = "read";
export const AUTHTRACE_ACTION_SU53 = "su53";

const RUNTIME_SOURCE = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS);
if (RUNTIME_SOURCE === undefined) {
  throw new Error(`fluidRuntimeSources has no entry for ${FLUID_RUNTIME_CLASS}`);
}

const RUNTIME_OBJECT = fluidRuntimeManifest.objects.find((o) => o.name === FLUID_RUNTIME_CLASS);
if (RUNTIME_OBJECT === undefined) {
  throw new Error(`fluidRuntimeManifest has no entry for ${FLUID_RUNTIME_CLASS}`);
}

const AUTHTRACE_SOURCE = `CLASS zcl_zmcp_fluid_authtrace DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    CLASS-METHODS run
      IMPORTING
        iv_action TYPE string
        iv_json   TYPE string.

  PRIVATE SECTION.
    CLASS-METHODS status.
    CLASS-METHODS on.
    CLASS-METHODS off.
    CLASS-METHODS read.
    CLASS-METHODS su53.

    CLASS-METHODS pack_fields
      IMPORTING
        is_row          TYPE any
        it_field_comp   TYPE string_table
        it_val_comp     TYPE string_table
      RETURNING
        VALUE(rv_text)  TYPE string.

    CLASS-METHODS trace_field_comps
      RETURNING VALUE(rt_comp) TYPE string_table.
    CLASS-METHODS trace_val_comps
      RETURNING VALUE(rt_comp) TYPE string_table.
    CLASS-METHODS su53_field_comps
      RETURNING VALUE(rt_comp) TYPE string_table.
    CLASS-METHODS su53_val_comps
      RETURNING VALUE(rt_comp) TYPE string_table.

ENDCLASS.


CLASS zcl_zmcp_fluid_authtrace IMPLEMENTATION.

  METHOD run.
    zcl_zmcp_fluid_rt=>begin( iv_id = 'authtrace' iv_action = iv_action ).

    TRY.
        zcl_zmcp_fluid_rt=>scan( iv_json ).
        CASE iv_action.
          WHEN 'status'.
            status( ).
          WHEN 'on'.
            on( ).
          WHEN 'off'.
            off( ).
          WHEN 'read'.
            read( ).
          WHEN 'su53'.
            su53( ).
          WHEN OTHERS.
            zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'dispatch'
              iv_text = |unknown action "{ iv_action }"| ).
        ENDCASE.
      CATCH cx_root INTO DATA(lx_err).
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = iv_action iv_text = lx_err->get_text( ) ).
    ENDTRY.

    IF zcl_zmcp_fluid_rt=>failed( ) = abap_true.
      zcl_zmcp_fluid_rt=>end( iv_rc = 1 ).
    ELSE.
      zcl_zmcp_fluid_rt=>end( iv_rc = 0 ).
    ENDIF.
  ENDMETHOD.

  METHOD status.
    DATA lv_active      TYPE char01.
    DATA lv_any         TYPE char01.
    DATA lv_for_user    TYPE xubname.
    DATA lv_errors_only TYPE char01.
    DATA lv_moduser     TYPE xubname.
    DATA lv_ts          TYPE timestamp.
    DATA ls_return      TYPE bapiret2.

    CALL FUNCTION 'SUAUTH_SYSTEM_TRACE_FOR_AUTH'
      EXPORTING
        iv_function         = 0
      IMPORTING
        ev_auth_active      = lv_active
        ev_any_active       = lv_any
        ev_auth_for_user    = lv_for_user
        ev_auth_errors_only = lv_errors_only
        ev_moduser          = lv_moduser
        ev_timestamp        = lv_ts
        es_return           = ls_return.

    zcl_zmcp_fluid_rt=>out(
      |\\{"active":{ COND string( WHEN lv_active = 'X' THEN 'true' ELSE 'false' ) },| &&
      |"any_active":{ COND string( WHEN lv_any = 'X' THEN 'true' ELSE 'false' ) },| &&
      |"for_user":"{ zcl_zmcp_fluid_rt=>esc( CONV string( lv_for_user ) ) }",| &&
      |"errors_only":{ COND string( WHEN lv_errors_only = 'X' THEN 'true' ELSE 'false' ) }\\}| ).
  ENDMETHOD.

  METHOD on.
    DATA(lv_user) = zcl_zmcp_fluid_rt=>s( 'user' ).
    IF lv_user IS INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args' iv_text = 'user is required' ).
      RETURN.
    ENDIF.

    " CALL FUNCTION type-checks actual-vs-formal parameters at RUNTIME, not
    " at syntax-check/activation time, so a mismatch compiles clean and only
    " blows up when executed (CX_SY_DYN_CALL_ILLEGAL_TYPE, observed live on
    " A4H). zcl_zmcp_fluid_rt=>s( ) returns TYPE string; SUAUTH_SYSTEM_
    " TRACE_FOR_AUTH's IV_AUTH_FOR_USER is TYPE xubname (CHAR12), so the
    " string must be moved into a properly typed local first. Do not
    " simplify this back to passing lv_user directly.
    DATA lv_user_n TYPE xubname.
    lv_user_n = lv_user.

    " errors_only defaults to true when the key is absent from the request
    " JSON; scan()/s() cannot distinguish "omitted" from "false" by itself,
    " so an empty raw value is treated as "not supplied" here.
    DATA(lv_eo_raw) = zcl_zmcp_fluid_rt=>s( 'errors_only' ).
    " IV_AUTH_ERRORS_ONLY is TYPE char01, not abap_bool; use a local typed to
    " match the formal parameter rather than relying on char01/abap_bool
    " flat-type compatibility.
    DATA lv_errors_only TYPE char01.
    lv_errors_only = COND abap_bool( WHEN lv_eo_raw IS INITIAL THEN abap_true ELSE boolc( lv_eo_raw = 'true' ) ).

    DATA lv_active      TYPE char01.
    DATA lv_for_user    TYPE xubname.
    DATA lv_eo_out      TYPE char01.
    DATA lv_ts          TYPE timestamp.
    DATA ls_return      TYPE bapiret2.

    CALL FUNCTION 'SUAUTH_SYSTEM_TRACE_FOR_AUTH'
      EXPORTING
        iv_function         = 1
        iv_auth_for_user    = lv_user_n
        iv_auth_errors_only = lv_errors_only
      IMPORTING
        ev_auth_active      = lv_active
        ev_auth_for_user    = lv_for_user
        ev_auth_errors_only = lv_eo_out
        ev_timestamp        = lv_ts
        es_return           = ls_return.

    " ev_timestamp is the SAP application server's own clock (observed live
    " on A4H), not the MCP host's — callers should prefer it over a
    " host-clock timestamp for the read-back window to avoid silently
    " narrowing/zeroing that window on host/SAP clock skew.
    "
    " lv_ts is TYPE timestamp — a packed/numeric type, not a fixed-length
    " CHARACTER field — so CONV string( ) on it does NOT drop a trailing
    " blank the way it does for a CHAR field; the sign position renders as a
    " literal trailing blank (observed live: "20260915100737 ", 15 chars,
    " not 14). CONDENSE strips it so this stays the clean 14-digit value the
    " read/su53 actions require (both reject a "from" whose strlen <> 14).
    DATA(lv_ts_s) = CONV string( lv_ts ).
    CONDENSE lv_ts_s.

    zcl_zmcp_fluid_rt=>out(
      |\\{"active":{ COND string( WHEN lv_active = 'X' THEN 'true' ELSE 'false' ) },| &&
      |"for_user":"{ zcl_zmcp_fluid_rt=>esc( CONV string( lv_for_user ) ) }",| &&
      |"errors_only":{ COND string( WHEN lv_eo_out = 'X' THEN 'true' ELSE 'false' ) },| &&
      |"timestamp":"{ zcl_zmcp_fluid_rt=>esc( lv_ts_s ) }"\\}| ).
  ENDMETHOD.

  METHOD off.
    DATA lv_active TYPE char01.
    DATA ls_return TYPE bapiret2.

    CALL FUNCTION 'SUAUTH_SYSTEM_TRACE_FOR_AUTH'
      EXPORTING
        iv_function    = 2
      IMPORTING
        ev_auth_active = lv_active
        es_return      = ls_return.

    zcl_zmcp_fluid_rt=>out(
      |\\{"active":{ COND string( WHEN lv_active = 'X' THEN 'true' ELSE 'false' ) }\\}| ).
  ENDMETHOD.

  METHOD read.
    DATA(lv_user) = zcl_zmcp_fluid_rt=>s( 'user' ).
    DATA(lv_from) = zcl_zmcp_fluid_rt=>s( 'from' ).
    DATA(lv_to)   = zcl_zmcp_fluid_rt=>s( 'to' ).

    IF lv_user IS INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args' iv_text = 'user is required' ).
      RETURN.
    ENDIF.
    IF lv_from IS INITIAL OR strlen( lv_from ) <> 14.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
        iv_text = 'from is required and must be 14 digits (YYYYMMDDHHMMSS)' ).
      RETURN.
    ENDIF.

    DATA lv_tst_from TYPE timestamp.
    DATA lv_tst_to   TYPE timestamp.

    TRY.
        lv_tst_from = lv_from.
      CATCH cx_root.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
          iv_text = |from "{ lv_from }" is not a valid YYYYMMDDHHMMSS timestamp| ).
        RETURN.
    ENDTRY.

    IF lv_to IS INITIAL OR lv_to = 'now'.
      GET TIME STAMP FIELD lv_tst_to.
    ELSE.
      IF strlen( lv_to ) <> 14.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
          iv_text = 'to must be 14 digits (YYYYMMDDHHMMSS) or "now"' ).
        RETURN.
      ENDIF.
      TRY.
          lv_tst_to = lv_to.
        CATCH cx_root.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
            iv_text = |to "{ lv_to }" is not a valid YYYYMMDDHHMMSS timestamp| ).
          RETURN.
      ENDTRY.
    ENDIF.

    DATA lt_data  TYPE suauthtrace_data_t.
    DATA lt_error TYPE bapirettab.
    DATA lv_utc   TYPE char01.
    DATA lv_sysid TYPE sysysid.
    DATA lv_mandt TYPE symandt.
    DATA lv_host  TYPE syhost.

    " Same runtime type-check hazard as METHOD on (CX_SY_DYN_CALL_ILLEGAL_
    " TYPE): SUAUTH_READ_TRACE_VALUES's IV_ST01_USER is TYPE xubname, not
    " string. lv_tst_from/lv_tst_to are already TYPE timestamp locals above,
    " matching IV_ST01_TST_FROM/IV_ST01_TST_TO, so only the user needs this.
    DATA lv_user_n TYPE xubname.
    lv_user_n = lv_user.

    CALL FUNCTION 'SUAUTH_READ_TRACE_VALUES'
      EXPORTING
        iv_function         = 'USTC'
        iv_st01_user        = lv_user_n
        iv_st01_tst_from    = lv_tst_from
        iv_st01_tst_to      = lv_tst_to
      IMPORTING
        et_st01_data        = lt_data
        ev_st01_data_in_utc = lv_utc
        et_error            = lt_error
        ev_sysid            = lv_sysid
        ev_mandt            = lv_mandt
        ev_host             = lv_host.

    LOOP AT lt_data INTO DATA(ls_row).
      DATA(lv_fields) = pack_fields(
        is_row        = ls_row
        it_field_comp = trace_field_comps( )
        it_val_comp   = trace_val_comps( ) ).
      " rc/abappos/timestamp are numeric/packed fields, not fixed-length
      " CHARACTER fields, so converting them to string does NOT drop a
      " trailing sign blank the way a CHAR-to-string assignment does (see
      " METHOD on for the live-observed example). CONDENSE strips it so
      " "timestamp" stays a clean 14-digit value — su53/read both reject a
      " "from" whose strlen <> 14, and a stray blank here would poison any
      " later read-back seeded from this row's timestamp.
      DATA(lv_rc_s) = |{ ls_row-rc }|.
      CONDENSE lv_rc_s.
      DATA(lv_line_s) = |{ ls_row-abappos }|.
      CONDENSE lv_line_s.
      DATA(lv_ts_s) = CONV string( ls_row-timestamp ).
      CONDENSE lv_ts_s.
      zcl_zmcp_fluid_rt=>out(
        |\\{"origin":"trace",| &&
        |"object":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_row-object ) ) }",| &&
        |"rc":"{ zcl_zmcp_fluid_rt=>esc( lv_rc_s ) }",| &&
        |"reason":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_row-reason ) ) }",| &&
        |"fields":"{ zcl_zmcp_fluid_rt=>esc( lv_fields ) }",| &&
        |"program":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_row-abapprog ) ) }",| &&
        |"line":"{ zcl_zmcp_fluid_rt=>esc( lv_line_s ) }",| &&
        |"tcode":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_row-tcode ) ) }",| &&
        |"timestamp":"{ zcl_zmcp_fluid_rt=>esc( lv_ts_s ) }"\\}| ).
    ENDLOOP.
  ENDMETHOD.

  METHOD su53.
    DATA(lv_user) = zcl_zmcp_fluid_rt=>s( 'user' ).
    DATA(lv_from) = zcl_zmcp_fluid_rt=>s( 'from' ).

    IF lv_user IS INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args' iv_text = 'user is required' ).
      RETURN.
    ENDIF.
    IF lv_from IS INITIAL OR strlen( lv_from ) <> 14.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
        iv_text = 'from is required and must be 14 digits (YYYYMMDDHHMMSS)' ).
      RETURN.
    ENDIF.

    DATA lv_from_tsl TYPE timestampl.

    TRY.
        lv_from_tsl = lv_from.
      CATCH cx_root.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
          iv_text = |from "{ lv_from }" is not a valid YYYYMMDDHHMMSS timestamp| ).
        RETURN.
    ENDTRY.

    DATA lt_ext       TYPE usr07_ext_tt.
    DATA ls_return    TYPE bapiret2.
    DATA lt_rfc_error TYPE bapirettab.

    " Same runtime type-check hazard as METHOD on (CX_SY_DYN_CALL_ILLEGAL_
    " TYPE): SUSR_USER_SU53_READ's IV_BNAME is TYPE xubname, not string.
    " lv_from_tsl is already a TYPE timestampl local above, matching
    " IV_FROM, so only the user needs this.
    DATA lv_user_n TYPE xubname.
    lv_user_n = lv_user.

    CALL FUNCTION 'SUSR_USER_SU53_READ'
      EXPORTING
        iv_bname     = lv_user_n
        iv_from      = lv_from_tsl
      IMPORTING
        et_usr07_ext = lt_ext
        es_return    = ls_return
        et_rfc_error = lt_rfc_error.

    LOOP AT lt_ext INTO DATA(ls_row).
      DATA(lv_fields) = pack_fields(
        is_row        = ls_row
        it_field_comp = su53_field_comps( )
        it_val_comp   = su53_val_comps( ) ).
      " Same numeric/packed CONDENSE need as METHOD read: rc/abapline/
      " timestamp are not fixed-length CHARACTER fields, so a stray sign
      " blank from converting them to string is not automatically stripped
      " the way it is for object/reason/program/tcode below.
      DATA(lv_rc_s) = |{ ls_row-rc }|.
      CONDENSE lv_rc_s.
      DATA(lv_line_s) = |{ ls_row-abapline }|.
      CONDENSE lv_line_s.
      DATA(lv_ts_s) = CONV string( ls_row-timestamp ).
      CONDENSE lv_ts_s.
      zcl_zmcp_fluid_rt=>out(
        |\\{"origin":"su53",| &&
        |"object":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_row-objct ) ) }",| &&
        |"rc":"{ zcl_zmcp_fluid_rt=>esc( lv_rc_s ) }",| &&
        |"reason":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_row-reason ) ) }",| &&
        |"fields":"{ zcl_zmcp_fluid_rt=>esc( lv_fields ) }",| &&
        |"program":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_row-abapprog ) ) }",| &&
        |"line":"{ zcl_zmcp_fluid_rt=>esc( lv_line_s ) }",| &&
        |"tcode":"{ zcl_zmcp_fluid_rt=>esc( CONV string( ls_row-p_tcode ) ) }",| &&
        |"timestamp":"{ zcl_zmcp_fluid_rt=>esc( lv_ts_s ) }"\\}| ).
    ENDLOOP.
  ENDMETHOD.

  METHOD pack_fields.
    " Packs the non-empty FIELDn/VALn (or FIELn/VALnn) pairs of one trace/SU53
    " row into "NAME=VALUE" pairs joined by ", ". Component names are resolved
    " dynamically so the same helper serves both structures, whose field-name
    " schemes differ (FIELD1..FIELD10/VAL1..VAL10 vs FIEL1..FIEL9,FIEL0/
    " VAL01..VAL10). Assigning a fixed-length character component to a string
    " target already strips its trailing blanks, so no separate rtrim is
    " needed here.
    DATA lv_idx TYPE i.
    CLEAR rv_text.
    lv_idx = 0.
    LOOP AT it_field_comp INTO DATA(lv_fcomp).
      lv_idx = lv_idx + 1.
      READ TABLE it_val_comp INDEX lv_idx INTO DATA(lv_vcomp).
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.

      ASSIGN COMPONENT lv_fcomp OF STRUCTURE is_row TO FIELD-SYMBOL(<lv_fval>).
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      DATA(lv_fname) = CONV string( <lv_fval> ).
      IF lv_fname IS INITIAL.
        CONTINUE.
      ENDIF.

      ASSIGN COMPONENT lv_vcomp OF STRUCTURE is_row TO FIELD-SYMBOL(<lv_vval>).
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      DATA(lv_fvalue) = CONV string( <lv_vval> ).

      IF rv_text IS NOT INITIAL.
        rv_text = rv_text && ', '.
      ENDIF.
      rv_text = rv_text && lv_fname && '=' && lv_fvalue.
    ENDLOOP.
  ENDMETHOD.

  METHOD trace_field_comps.
    rt_comp = VALUE #(
      ( \`FIELD1\` ) ( \`FIELD2\` ) ( \`FIELD3\` ) ( \`FIELD4\` ) ( \`FIELD5\` )
      ( \`FIELD6\` ) ( \`FIELD7\` ) ( \`FIELD8\` ) ( \`FIELD9\` ) ( \`FIELD10\` ) ).
  ENDMETHOD.

  METHOD trace_val_comps.
    rt_comp = VALUE #(
      ( \`VAL1\` ) ( \`VAL2\` ) ( \`VAL3\` ) ( \`VAL4\` ) ( \`VAL5\` )
      ( \`VAL6\` ) ( \`VAL7\` ) ( \`VAL8\` ) ( \`VAL9\` ) ( \`VAL10\` ) ).
  ENDMETHOD.

  METHOD su53_field_comps.
    rt_comp = VALUE #(
      ( \`FIEL1\` ) ( \`FIEL2\` ) ( \`FIEL3\` ) ( \`FIEL4\` ) ( \`FIEL5\` )
      ( \`FIEL6\` ) ( \`FIEL7\` ) ( \`FIEL8\` ) ( \`FIEL9\` ) ( \`FIEL0\` ) ).
  ENDMETHOD.

  METHOD su53_val_comps.
    rt_comp = VALUE #(
      ( \`VAL01\` ) ( \`VAL02\` ) ( \`VAL03\` ) ( \`VAL04\` ) ( \`VAL05\` )
      ( \`VAL06\` ) ( \`VAL07\` ) ( \`VAL08\` ) ( \`VAL09\` ) ( \`VAL10\` ) ).
  ENDMETHOD.

ENDCLASS.
`;

const STATUS_ROW_SCHEMA = {
  type: "object",
  required: ["active", "any_active", "for_user", "errors_only"],
  properties: {
    active: { type: "boolean", description: "Whether the auth trace is currently active." },
    any_active: { type: "boolean", description: "Whether any auth trace (for any user) is active." },
    for_user: { type: "string", description: "The user the active trace is scoped to, if any." },
    errors_only: { type: "boolean", description: "Whether the active trace records only failed checks." },
  },
} as const;

const ON_ROW_SCHEMA = {
  type: "object",
  required: ["active", "for_user", "errors_only"],
  properties: {
    active: { type: "boolean" },
    for_user: { type: "string" },
    errors_only: { type: "boolean" },
    timestamp: {
      type: "string",
      description:
        "Server timestamp (YYYYMMDDHHMMSS, UTC) from SUAUTH_SYSTEM_TRACE_FOR_AUTH's EV_TIMESTAMP; " +
        "prefer this over a host-clock timestamp to avoid clock skew.",
    },
  },
} as const;

const OFF_ROW_SCHEMA = {
  type: "object",
  required: ["active"],
  properties: {
    active: { type: "boolean" },
  },
} as const;

const CHECK_ROW_SCHEMA = {
  type: "object",
  required: ["origin", "object", "rc", "reason", "fields", "program", "line", "tcode", "timestamp"],
  properties: {
    origin: { type: "string", enum: ["trace", "su53"], description: '"trace" (kernel trace) or "su53" (SU53 buffer fallback).' },
    object: { type: "string", description: "Authorization object checked (SU53's OBJCT is CHAR10 and truncates long names)." },
    rc: { type: "string", description: "Result code (domain values on the trace path: 0/4/12/40)." },
    reason: { type: "string" },
    fields: { type: "string", description: 'Non-empty field/value pairs as "NAME=VALUE", joined by ", ".' },
    program: { type: "string" },
    line: { type: "string" },
    tcode: { type: "string", description: "Empty for ADT/classrun execution (no transaction code)." },
    timestamp: { type: "string" },
  },
} as const;

export const authtraceManifest: FluidManifest = {
  contract: FLUID_CONTRACT,
  id: AUTHTRACE_TOOL_ID,
  title: "Authorization trace",
  description: "Switches the SU53/kernel authorization trace on or off, and reads back failed authority checks.",
  objects: [
    {
      name: FLUID_RUNTIME_CLASS,
      type: "CLAS/OC",
      // same live object as the rt tool's; derived so the two descriptions can't drift apart
      description: RUNTIME_OBJECT.description,
      source: { text: RUNTIME_SOURCE },
    },
    {
      name: AUTHTRACE_ENTRY_CLASS,
      type: "CLAS/OC",
      description: "fluid: SU53/kernel authorization trace bridge",
      source: { text: AUTHTRACE_SOURCE },
    },
  ],
  entry: AUTHTRACE_ENTRY_CLASS,
  actions: [
    {
      name: AUTHTRACE_ACTION_STATUS,
      category: "read",
      description: "Reads the current authorization trace status.",
      input: { type: "object" },
      output: { type: "array", items: STATUS_ROW_SCHEMA, description: "Exactly one row." },
    },
    {
      name: AUTHTRACE_ACTION_ON,
      category: "execute",
      description: "Switches the authorization trace on for one user.",
      input: {
        type: "object",
        required: ["user"],
        properties: {
          user: { type: "string", maxLength: 12, description: "XUBNAME to trace (the trace is user-scoped on this release)." },
          errors_only: { type: "boolean", description: "Record only failed checks. Defaults to true when omitted." },
        },
      },
      output: { type: "array", items: ON_ROW_SCHEMA, description: "Exactly one row." },
    },
    {
      name: AUTHTRACE_ACTION_OFF,
      category: "execute",
      description: "Switches the authorization trace off.",
      input: { type: "object" },
      output: { type: "array", items: OFF_ROW_SCHEMA, description: "Exactly one row." },
    },
    {
      name: AUTHTRACE_ACTION_READ,
      category: "read",
      description:
        "Reads back failed authority checks from the kernel authorization trace (SUAUTH_READ_TRACE_VALUES, " +
        "IV_FUNCTION='USTC'). Observed to return zero rows on at least one system even while the trace is " +
        "active; callers should fall back to the su53 action when this returns nothing.",
      input: {
        type: "object",
        required: ["user", "from"],
        properties: {
          user: { type: "string", maxLength: 12 },
          from: { type: "string", maxLength: 14, description: "YYYYMMDDHHMMSS, exactly 14 digits." },
          to: { type: "string", maxLength: 14, description: 'YYYYMMDDHHMMSS, exactly 14 digits, or "now" (default).' },
        },
      },
      output: { type: "array", items: CHECK_ROW_SCHEMA },
    },
    {
      name: AUTHTRACE_ACTION_SU53,
      category: "read",
      description:
        "Reads back failed authority checks from the SU53 buffer (SUSR_USER_SU53_READ). This is the whole " +
        "buffer for the window requested, not just the single most-recent failed check; the system may cap " +
        "or overwrite older entries, so treat this as a fallback, not a full audit trail.",
      input: {
        type: "object",
        required: ["user", "from"],
        properties: {
          user: { type: "string", maxLength: 12 },
          from: { type: "string", maxLength: 14, description: "YYYYMMDDHHMMSS, exactly 14 digits; converted to TIMESTAMPL." },
        },
      },
      output: { type: "array", items: CHECK_ROW_SCHEMA },
    },
  ],
};

export const authtraceSources: ReadonlyMap<string, string> = new Map([
  [FLUID_RUNTIME_CLASS, RUNTIME_SOURCE],
  [AUTHTRACE_ENTRY_CLASS, AUTHTRACE_SOURCE],
]);
