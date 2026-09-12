/**
 * Built-in "scan" fluid tool: line-wise source-text search over a
 * package/name scope (PROG, CLAS, INTF, FUGR, DDLS).
 *
 * This is a separate tool rather than a fourth `core` action because the
 * match itself needs `FIND PCRE`, a syntax addition only available from
 * kernel/release 7.55 onwards (the deprecated `FIND REGEX`/`cl_abap_matcher`
 * POSIX path is not an option: both raise the deprecated-POSIX warning,
 * which would make the class activate with warnings). Putting `source` in
 * `ZCL_ZMCP_FLUID_CORE` would make that class's own actions
 * (`select`/`describe_fm`/`call_fm`, none of which need PCRE) fail
 * activation on a pre-7.55 system too. Isolating the PCRE dependency in its
 * own body class means only `scan` is lost on such a system, not the whole
 * `core` tool.
 *
 * Every mechanism below (include resolution per object type, the FUGR
 * prefix-overmatch guard, the `#`/`_`/`%`/`*` LIKE-escaping idiom, the
 * subpackage walk over TDEVC-PARENTCL) was verified live on system A4H
 * (probe class ZCL_I72_PROBE, 2026-09-12); see the inline comments below for
 * what was actually observed, not merely assumed from documentation.
 */
import type { FluidManifest } from "../manifest.js";
import { FLUID_CONTRACT } from "../manifest.js";
import { FLUID_RUNTIME_CLASS, fluidRuntimeManifest, fluidRuntimeSources } from "../abap/runtime.js";

export const SCAN_TOOL_ID = "scan";
export const SCAN_ACTION = "source";
export const SCAN_ENTRY_CLASS = "ZCL_ZMCP_FLUID_SCAN";

const RUNTIME_SOURCE = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS);
if (RUNTIME_SOURCE === undefined) {
  throw new Error(`fluidRuntimeSources has no entry for ${FLUID_RUNTIME_CLASS}`);
}

const RUNTIME_OBJECT = fluidRuntimeManifest.objects.find((o) => o.name === FLUID_RUNTIME_CLASS);
if (RUNTIME_OBJECT === undefined) {
  throw new Error(`fluidRuntimeManifest has no entry for ${FLUID_RUNTIME_CLASS}`);
}

const SCAN_SOURCE = `CLASS zcl_zmcp_fluid_scan DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    CLASS-METHODS run
      IMPORTING
        iv_action TYPE string
        iv_json   TYPE string.

  PRIVATE SECTION.
    CLASS-DATA gv_trunc    TYPE string.
    CLASS-DATA gv_query    TYPE string.
    CLASS-DATA gv_regex    TYPE abap_bool.
    CLASS-DATA gv_case     TYPE abap_bool.
    CLASS-DATA gv_comments TYPE abap_bool.
    CLASS-DATA gv_max_hits TYPE i.
    CLASS-DATA gv_pattern  TYPE string.

    CLASS-METHODS source.

    CLASS-METHODS num
      IMPORTING
        iv_path         TYPE string
      RETURNING
        VALUE(rv_value) TYPE i.

    CLASS-METHODS code_part
      IMPORTING
        iv_line        TYPE string
      RETURNING
        VALUE(rv_text) TYPE string.

    CLASS-METHODS esc_like
      IMPORTING
        iv_raw         TYPE string
      RETURNING
        VALUE(rv_pat)  TYPE string.

    CLASS-METHODS fugr_includes
      IMPORTING
        iv_group       TYPE string
      RETURNING
        VALUE(rt_inc)  TYPE string_table.

    CLASS-METHODS scan_lines
      IMPORTING
        iv_otype TYPE string
        iv_oname TYPE string
        iv_inc   TYPE string
        it_src   TYPE string_table
      CHANGING
        cv_stop  TYPE abap_bool
        cv_hits  TYPE i.

ENDCLASS.


CLASS zcl_zmcp_fluid_scan IMPLEMENTATION.

  METHOD run.
    zcl_zmcp_fluid_rt=>begin( iv_id = 'scan' iv_action = iv_action ).

    TRY.
        zcl_zmcp_fluid_rt=>scan( iv_json ).
        CASE iv_action.
          WHEN 'source'.
            source( ).
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
      zcl_zmcp_fluid_rt=>end( iv_rc = 0 iv_truncated = boolc( gv_trunc IS NOT INITIAL ) ).
    ENDIF.
  ENDMETHOD.

  METHOD num.
    DATA(lv_raw) = zcl_zmcp_fluid_rt=>s( iv_path ).
    TRY.
        rv_value = lv_raw.
      CATCH cx_root.
        CLEAR rv_value.
    ENDTRY.
  ENDMETHOD.

  METHOD code_part.
    CLEAR rv_text.
    IF iv_line IS INITIAL.
      RETURN.
    ENDIF.
    IF iv_line(1) = '*'.
      RETURN.
    ENDIF.

    DATA(lv_len) = strlen( iv_line ).
    DATA(lv_i) = 0.
    WHILE lv_i < lv_len AND iv_line+lv_i(1) = ' '.
      lv_i = lv_i + 1.
    ENDWHILE.
    IF lv_i < lv_len AND iv_line+lv_i(1) = '"'.
      RETURN.
    ENDIF.

    " Walks the line looking for a comment-starting '"' outside a string
    " literal, toggling an "inside literal" flag on every unqualified '.
    " Approximation: a '"' inside a |...| string template is read here as a
    " comment start, same blind spot as elsewhere in this codebase's
    " lightweight ABAP source heuristics.
    DATA(lv_inside) = abap_false.
    DATA(lv_cut) = lv_len.
    DATA(lv_j) = 0.
    WHILE lv_j < lv_len.
      DATA(lv_ch) = iv_line+lv_j(1).
      IF lv_ch = ''''.
        IF lv_inside = abap_true.
          lv_inside = abap_false.
        ELSE.
          lv_inside = abap_true.
        ENDIF.
      ELSEIF lv_ch = '"' AND lv_inside = abap_false.
        lv_cut = lv_j.
        EXIT.
      ENDIF.
      lv_j = lv_j + 1.
    ENDWHILE.
    rv_text = substring( val = iv_line len = lv_cut ).
  ENDMETHOD.

  METHOD esc_like.
    rv_pat = iv_raw.
    REPLACE ALL OCCURRENCES OF '#' IN rv_pat WITH '##'.
    REPLACE ALL OCCURRENCES OF '_' IN rv_pat WITH '#_'.
    REPLACE ALL OCCURRENCES OF '%' IN rv_pat WITH '#%'.
  ENDMETHOD.

  METHOD fugr_includes.
    " Live-verified on A4H: group /DMO/TRAVEL_UPDATE_TASK has includes
    " /DMO/LTRAVEL_UPDATE_TASK$01, ...TOP, ...U01 and main program
    " /DMO/SAPLTRAVEL_UPDATE_TASK - for a namespaced group the namespace
    " comes first, before the L/SAPL marker, not after it.
    CLEAR rt_inc.
    DATA lv_ns TYPE string.
    DATA lv_rest TYPE string.
    CLEAR: lv_ns, lv_rest.
    lv_rest = iv_group.

    IF iv_group IS NOT INITIAL AND iv_group(1) = '/'.
      DATA(lv_nsoff) = find( val = iv_group sub = '/' off = 1 ).
      IF lv_nsoff >= 0.
        lv_ns   = substring( val = iv_group len = lv_nsoff + 1 ).
        lv_rest = substring( val = iv_group off = lv_nsoff + 1 ).
      ENDIF.
    ENDIF.

    DATA(lv_lprefix)   = lv_ns && 'L' && lv_rest.
    DATA(lv_saplname)  = lv_ns && 'SAPL' && lv_rest.
    DATA(lv_pat)       = esc_like( lv_lprefix ) && '%'.
    DATA(lv_group_pat) = esc_like( iv_group ) && '%'.

    " Prefix over-match guard: L<this group>% also matches a sibling group
    " whose name extends this one (e.g. group ZFG's "LZFG%" also matches
    " ZFGX's includes). When more than one FUGR object shares this prefix,
    " accept only prognames whose remainder is exactly 3 characters (TOP,
    " UXX, U01, $01, F01, ...) - the shape every generated include name has.
    " Trade-off, stated plainly: under the strict rule, a hand-made include
    " with a longer name on a group that has a prefix-sharing sibling is not
    " scanned.
    DATA(lv_sibling_count) = 0.
    SELECT COUNT( * ) FROM tadir
      WHERE pgmid = 'R3TR' AND object = 'FUGR' AND obj_name LIKE @lv_group_pat ESCAPE '#'
      INTO @lv_sibling_count.

    SELECT progname FROM reposrc
      WHERE progname LIKE @lv_pat ESCAPE '#' AND r3state = 'A'
      INTO TABLE @DATA(lt_fpg).

    DATA(lv_prefix_len) = strlen( lv_lprefix ).
    LOOP AT lt_fpg INTO DATA(ls_fpg).
      DATA(lv_pname) = |{ ls_fpg-progname }|.
      IF lv_sibling_count > 1.
        DATA(lv_remainder_len) = strlen( lv_pname ) - lv_prefix_len.
        IF lv_remainder_len = 3.
          APPEND lv_pname TO rt_inc.
        ENDIF.
      ELSE.
        APPEND lv_pname TO rt_inc.
      ENDIF.
    ENDLOOP.

    " The main program is added separately; step 7 (READ REPORT) skips it
    " when it has no source of its own.
    APPEND lv_saplname TO rt_inc.
  ENDMETHOD.

  METHOD scan_lines.
    DATA lv_no TYPE i.
    DATA lv_off TYPE i.
    CLEAR: lv_no, lv_off.

    LOOP AT it_src INTO DATA(lv_line).
      lv_no = sy-tabix.
      DATA(lv_text) = lv_line.
      IF gv_comments = abap_false AND iv_otype <> 'DDLS'.
        lv_text = code_part( lv_line ).
        IF lv_text IS INITIAL.
          CONTINUE.
        ENDIF.
      ENDIF.

      DATA(lv_hit) = abap_false.
      IF gv_regex = abap_true.
        IF gv_case = abap_true.
          FIND PCRE gv_pattern IN lv_text MATCH OFFSET lv_off.
        ELSE.
          FIND PCRE gv_pattern IN lv_text IGNORING CASE MATCH OFFSET lv_off.
        ENDIF.
        IF sy-subrc = 0.
          lv_hit = abap_true.
        ENDIF.
      ELSE.
        " find( case = ... ) only accepts a constant, not a variable (live
        " syntax check on A4H: "GV_CASE is not a constant"), so the two
        " cases are spelled out.
        IF gv_case = abap_true.
          lv_off = find( val = lv_text sub = gv_query case = abap_true ).
        ELSE.
          lv_off = find( val = lv_text sub = gv_query case = abap_false ).
        ENDIF.
        IF lv_off >= 0.
          lv_hit = abap_true.
        ENDIF.
      ENDIF.

      IF lv_hit = abap_true.
        cv_hits = cv_hits + 1.
        DATA(lv_no_s) = |{ lv_no }|.
        zcl_zmcp_fluid_rt=>out(
          |\\{"kind":"hit","obj_type":"{ zcl_zmcp_fluid_rt=>esc( iv_otype ) }",| &&
          |"obj_name":"{ zcl_zmcp_fluid_rt=>esc( iv_oname ) }",| &&
          |"include":"{ zcl_zmcp_fluid_rt=>esc( iv_inc ) }",| &&
          |"line":{ lv_no_s },| &&
          |"text":"{ zcl_zmcp_fluid_rt=>esc( lv_line ) }"\\}| ).
        IF cv_hits >= gv_max_hits.
          gv_trunc = 'hits'.
          cv_stop = abap_true.
          EXIT.
        ENDIF.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD source.
    DATA(lv_query)    = zcl_zmcp_fluid_rt=>s( 'query' ).
    DATA(lv_regex)    = zcl_zmcp_fluid_rt=>b( 'regex' ).
    DATA(lv_case)     = zcl_zmcp_fluid_rt=>b( 'case_sensitive' ).
    DATA(lv_comments) = zcl_zmcp_fluid_rt=>b( 'include_comments' ).
    DATA(lv_inc_sub)  = zcl_zmcp_fluid_rt=>b( 'include_subpackages' ).
    DATA(lv_objects)  = zcl_zmcp_fluid_rt=>s( 'objects' ).
    DATA(lv_max_hits)    = num( 'max_hits' ).
    DATA(lv_max_objects) = num( 'max_objects' ).

    IF lv_query IS INITIAL.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args' iv_text = 'query is required' ).
      RETURN.
    ENDIF.
    IF lv_max_hits <= 0.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
        iv_text = 'max_hits must be greater than zero' ).
      RETURN.
    ENDIF.
    IF lv_max_objects <= 0.
      zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
        iv_text = 'max_objects must be greater than zero' ).
      RETURN.
    ENDIF.

    IF lv_regex = abap_true.
      TRY.
          " ABAP's FIND PCRE compiles with the extended (x) flag ON by
          " default - live-verified on A4H: pattern 'FUNCTION B' does NOT
          " match 'FUNCTION BRF_...', while '(?-x)FUNCTION B' does. Under x,
          " literal spaces are ignored and '#' starts a pattern comment, so
          " every caller pattern is prefixed with (?-x) to get the ordinary
          " PCRE the caller expects. A caller who wants extended mode can
          " still ask for it with a leading (?x).
          gv_pattern = |(?-x){ lv_query }|.
          FIND PCRE gv_pattern IN 'x'.
        CATCH cx_root INTO DATA(lx_pcre).
          zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
            iv_text = |invalid regex pattern "{ lv_query }": { lx_pcre->get_text( ) }| ).
          RETURN.
      ENDTRY.
    ENDIF.

    " types: empty list means all five.
    DATA lt_type_r TYPE RANGE OF tadir-object.
    CLEAR lt_type_r.
    DATA(lv_ntypes) = zcl_zmcp_fluid_rt=>n( 'types' ).
    IF lv_ntypes = 0.
      APPEND VALUE #( sign = 'I' option = 'EQ' low = 'PROG' ) TO lt_type_r.
      APPEND VALUE #( sign = 'I' option = 'EQ' low = 'CLAS' ) TO lt_type_r.
      APPEND VALUE #( sign = 'I' option = 'EQ' low = 'INTF' ) TO lt_type_r.
      APPEND VALUE #( sign = 'I' option = 'EQ' low = 'FUGR' ) TO lt_type_r.
      APPEND VALUE #( sign = 'I' option = 'EQ' low = 'DDLS' ) TO lt_type_r.
    ELSE.
      DO lv_ntypes TIMES.
        DATA(lv_ti_s) = |{ sy-index - 1 }|.
        DATA(lv_type) = to_upper( zcl_zmcp_fluid_rt=>s( |types/{ lv_ti_s }| ) ).
        IF lv_type <> 'PROG' AND lv_type <> 'CLAS' AND lv_type <> 'INTF' AND lv_type <> 'FUGR' AND lv_type <> 'DDLS'.
          zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
            iv_text = |unknown type "{ lv_type }" - expected PROG, CLAS, INTF, FUGR or DDLS| ).
          RETURN.
        ENDIF.
        APPEND VALUE #( sign = 'I' option = 'EQ' low = lv_type ) TO lt_type_r.
      ENDDO.
    ENDIF.

    " packages, with optional transitive subpackage expansion over
    " TDEVC-PARENTCL (live-verified: TDEVC-PARENTCL = 'SABP_DEMOS' returns
    " SABAP_DEMOS_CDS_FLIGHT, SABAP_DEMOS_SQL_CHESS).
    TYPES: BEGIN OF ty_pkg,
             devclass TYPE tdevc-devclass,
           END OF ty_pkg.
    DATA lt_seen     TYPE STANDARD TABLE OF ty_pkg WITH EMPTY KEY.
    DATA lt_current  TYPE STANDARD TABLE OF ty_pkg WITH EMPTY KEY.
    DATA lt_children TYPE STANDARD TABLE OF ty_pkg WITH EMPTY KEY.
    CLEAR: lt_seen, lt_current, lt_children.

    DATA(lv_npkg) = zcl_zmcp_fluid_rt=>n( 'packages' ).
    DO lv_npkg TIMES.
      DATA(lv_pi_s) = |{ sy-index - 1 }|.
      APPEND VALUE ty_pkg( devclass = zcl_zmcp_fluid_rt=>s( |packages/{ lv_pi_s }| ) ) TO lt_seen.
    ENDDO.
    DATA(lv_has_pkg) = xsdbool( lt_seen IS NOT INITIAL ).

    IF lv_inc_sub = abap_true AND lt_seen IS NOT INITIAL.
      lt_current = lt_seen.
      DO.
        IF lt_current IS INITIAL.
          EXIT.
        ENDIF.
        " Guard against an empty driver table before FOR ALL ENTRIES - an
        " empty lt_current is already excluded by the check just above, kept
        " here too since the loop reassigns lt_current every iteration.
        CLEAR lt_children.
        SELECT devclass FROM tdevc
          FOR ALL ENTRIES IN @lt_current
          WHERE parentcl = @lt_current-devclass
          INTO TABLE @lt_children.
        CLEAR lt_current.
        LOOP AT lt_children INTO DATA(ls_child).
          READ TABLE lt_seen WITH KEY devclass = ls_child-devclass TRANSPORTING NO FIELDS.
          IF sy-subrc <> 0.
            APPEND ls_child TO lt_seen.
            APPEND ls_child TO lt_current.
          ENDIF.
        ENDLOOP.
      ENDDO.
    ENDIF.

    DATA lt_pkg_r TYPE RANGE OF tadir-devclass.
    CLEAR lt_pkg_r.
    LOOP AT lt_seen INTO DATA(ls_seen).
      APPEND VALUE #( sign = 'I' option = 'EQ' low = ls_seen-devclass ) TO lt_pkg_r.
    ENDLOOP.

    " object-name scope: '*' -> '%', escaped the same way builtin/fpm.ts's
    " find action escapes its query pattern.
    DATA(lv_has_obj) = xsdbool( lv_objects IS NOT INITIAL ).
    DATA(lv_objpat) = lv_objects.
    IF lv_has_obj = abap_true.
      lv_objpat = esc_like( lv_objpat ).
      REPLACE ALL OCCURRENCES OF '*' IN lv_objpat WITH '%'.
    ENDIF.

    " Scope query: total first, honestly, then the fetch capped at
    " max_objects + 1 so the ceiling is detected without reading a scope
    " that may be far larger than the caller's ceiling.
    DATA(lv_total) = 0.
    SELECT COUNT( * ) FROM tadir
      WHERE pgmid = 'R3TR' AND object IN @lt_type_r AND delflag = @abap_false
        AND ( @lv_has_pkg = @abap_false OR devclass IN @lt_pkg_r )
        AND ( @lv_has_obj = @abap_false OR obj_name LIKE @lv_objpat ESCAPE '#' )
      INTO @lv_total.

    DATA(lv_fetch) = lv_max_objects + 1.
    TYPES: BEGIN OF ty_obj,
             object   TYPE tadir-object,
             obj_name TYPE tadir-obj_name,
           END OF ty_obj.
    DATA lt_obj TYPE STANDARD TABLE OF ty_obj WITH EMPTY KEY.
    CLEAR lt_obj.
    SELECT object, obj_name FROM tadir
      WHERE pgmid = 'R3TR' AND object IN @lt_type_r AND delflag = @abap_false
        AND ( @lv_has_pkg = @abap_false OR devclass IN @lt_pkg_r )
        AND ( @lv_has_obj = @abap_false OR obj_name LIKE @lv_objpat ESCAPE '#' )
      ORDER BY object, obj_name
      INTO TABLE @lt_obj
      UP TO @lv_fetch ROWS.

    IF lines( lt_obj ) > lv_max_objects.
      DATA(lv_from_idx) = lv_max_objects + 1.
      DELETE lt_obj FROM lv_from_idx.
      gv_trunc = 'objects'.
    ENDIF.

    gv_query    = lv_query.
    gv_regex    = lv_regex.
    gv_case     = lv_case.
    gv_comments = lv_comments.
    gv_max_hits = lv_max_hits.

    DATA(lv_stop)              = abap_false.
    DATA(lv_hits)              = 0.
    DATA(lv_objects_scanned)   = 0.
    DATA(lv_includes_scanned)  = 0.
    DATA(lv_includes_skipped)  = 0.

    LOOP AT lt_obj INTO DATA(ls_obj).
      IF lv_stop = abap_true.
        EXIT.
      ENDIF.
      lv_objects_scanned = lv_objects_scanned + 1.

      DATA(lv_otype) = |{ ls_obj-object }|.
      DATA(lv_oname) = |{ ls_obj-obj_name }|.

      IF lv_otype = 'DDLS'.
        " No include for a DDLS/CDS source - it is scanned as itself, and
        " always matched in full: CDS comments are not ABAP comments, so
        " code_part()'s heuristic does not apply to this branch.
        DATA(lv_ddl) = ||.
        SELECT SINGLE source FROM ddddlsrc WHERE ddlname = @lv_oname AND as4local = 'A' INTO @lv_ddl.
        IF sy-subrc <> 0.
          lv_includes_skipped = lv_includes_skipped + 1.
          CONTINUE.
        ENDIF.
        " An inline @DATA(...) target is a syntax error on SPLIT ... INTO
        " TABLE (hit live) - lt_ddl_src must be declared beforehand.
        DATA lt_ddl_src TYPE TABLE OF string.
        CLEAR lt_ddl_src.
        " DDDDLSRC stores CRLF line ends (live-verified on A4H: splitting
        " on newline alone leaves a trailing CR on every hit text).
        REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_lf
          IN lv_ddl WITH cl_abap_char_utilities=>newline.
        SPLIT lv_ddl AT cl_abap_char_utilities=>newline INTO TABLE lt_ddl_src.
        lv_includes_scanned = lv_includes_scanned + 1.
        scan_lines(
          EXPORTING
            iv_otype = lv_otype
            iv_oname = lv_oname
            iv_inc   = lv_oname
            it_src   = lt_ddl_src
          CHANGING
            cv_stop  = lv_stop
            cv_hits  = lv_hits ).
        CONTINUE.
      ENDIF.

      DATA lt_inc TYPE string_table.
      CLEAR lt_inc.
      CASE lv_otype.
        WHEN 'PROG'.
          APPEND lv_oname TO lt_inc.
        WHEN 'CLAS'.
          TRY.
              " get_all_class_includes takes SEOCLSNAME (C(30)), not a
              " string - live syntax check on A4H rejects lv_oname here.
              DATA lv_clsname TYPE seoclsname.
              lv_clsname = lv_oname.
              DATA(lt_all) = cl_oo_classname_service=>get_all_class_includes( lv_clsname ).
              LOOP AT lt_all INTO DATA(lv_ci).
                APPEND lv_ci TO lt_inc.
              ENDLOOP.
            CATCH cx_root.
              " No includes could be resolved for this class; it contributes
              " zero includes rather than failing the whole scan.
          ENDTRY.
        WHEN 'INTF'.
          DATA(lv_ipat) = esc_like( |{ lv_oname WIDTH = 30 PAD = '=' }| ) && '%'.
          SELECT progname FROM reposrc
            WHERE progname LIKE @lv_ipat ESCAPE '#' AND r3state = 'A'
            INTO TABLE @DATA(lt_ipg).
          LOOP AT lt_ipg INTO DATA(ls_ipg).
            APPEND |{ ls_ipg-progname }| TO lt_inc.
          ENDLOOP.
        WHEN 'FUGR'.
          lt_inc = fugr_includes( lv_oname ).
      ENDCASE.

      LOOP AT lt_inc INTO DATA(lv_incname).
        IF lv_stop = abap_true.
          EXIT.
        ENDIF.
        DATA lt_src TYPE TABLE OF string.
        CLEAR lt_src.
        " READ REPORT needs a character-like flat field, not a STRING
        " (live syntax check on A4H).
        DATA lv_prog TYPE progname.
        lv_prog = lv_incname.
        READ REPORT lv_prog INTO lt_src.
        IF sy-subrc <> 0.
          lv_includes_skipped = lv_includes_skipped + 1.
          CONTINUE.
        ENDIF.
        lv_includes_scanned = lv_includes_scanned + 1.
        scan_lines(
          EXPORTING
            iv_otype = lv_otype
            iv_oname = lv_oname
            iv_inc   = lv_incname
            it_src   = lt_src
          CHANGING
            cv_stop  = lv_stop
            cv_hits  = lv_hits ).
      ENDLOOP.
    ENDLOOP.

    DATA(lv_total_s)          = |{ lv_total }|.
    DATA(lv_scanned_s)        = |{ lv_objects_scanned }|.
    DATA(lv_inc_scanned_s)    = |{ lv_includes_scanned }|.
    DATA(lv_inc_skipped_s)    = |{ lv_includes_skipped }|.
    DATA(lv_hits_s)           = |{ lv_hits }|.
    zcl_zmcp_fluid_rt=>out(
      |\\{"kind":"summary","objects_total":{ lv_total_s },| &&
      |"objects_scanned":{ lv_scanned_s },| &&
      |"includes_scanned":{ lv_inc_scanned_s },| &&
      |"includes_skipped":{ lv_inc_skipped_s },| &&
      |"hits":{ lv_hits_s },| &&
      |"truncated":"{ zcl_zmcp_fluid_rt=>esc( gv_trunc ) }"\\}| ).
  ENDMETHOD.

ENDCLASS.
`;

export const scanManifest: FluidManifest = {
  contract: FLUID_CONTRACT,
  id: "scan",
  title: "Source scan",
  description: "Scans ABAP source text of the objects in a named scope, line by line.",
  objects: [
    {
      name: FLUID_RUNTIME_CLASS,
      type: "CLAS/OC",
      description: RUNTIME_OBJECT.description,
      source: { text: RUNTIME_SOURCE },
    },
    {
      name: SCAN_ENTRY_CLASS,
      type: "CLAS/OC",
      description: "fluid: line-wise source scan over a package/name scope",
      source: { text: SCAN_SOURCE },
    },
  ],
  entry: SCAN_ENTRY_CLASS,
  actions: [
    {
      name: SCAN_ACTION,
      category: "read",
      description: "Reads each object's source line by line and returns the lines that match.",
      input: {
        type: "object",
        required: ["query", "max_hits", "max_objects"],
        properties: {
          query: {
            type: "string",
            maxLength: 255,
            description: "Literal substring, or a PCRE pattern when regex is true.",
          },
          regex: { type: "boolean", description: "Treat query as a PCRE pattern instead of a literal substring." },
          case_sensitive: { type: "boolean", description: "Default false." },
          include_comments: { type: "boolean", description: "Also match comment text. Default false." },
          packages: {
            type: "array",
            items: { type: "string", maxLength: 30 },
            description: "Package scope (TADIR-DEVCLASS).",
          },
          include_subpackages: {
            type: "boolean",
            description: "Walk TDEVC-PARENTCL down from each named package.",
          },
          objects: {
            type: "string",
            maxLength: 40,
            description: "Object-name scope, '*' wildcard. Combined with packages by AND.",
          },
          types: {
            type: "array",
            items: { type: "string", maxLength: 4 },
            description: "TADIR object types: PROG CLAS INTF FUGR DDLS. Omit for all five.",
          },
          max_hits: {
            type: "integer",
            minimum: 1,
            description: "Scanning stops at this many hits and the result says so.",
          },
          max_objects: {
            type: "integer",
            minimum: 1,
            description: "Object ceiling; the result reports how many objects the scope really holds.",
          },
        },
      },
      output: {
        type: "array",
        description: 'One kind="hit" row per matching line, then exactly one final kind="summary" row.',
        items: {
          type: "object",
          required: ["kind"],
          properties: {
            kind: { type: "string" },
            obj_type: { type: "string" },
            obj_name: { type: "string" },
            include: { type: "string" },
            line: { type: "integer" },
            text: { type: "string" },
            objects_total: { type: "integer" },
            objects_scanned: { type: "integer" },
            includes_scanned: { type: "integer" },
            includes_skipped: { type: "integer" },
            hits: { type: "integer" },
            truncated: { type: "string" },
          },
        },
      },
    },
  ],
};

export const scanSources: ReadonlyMap<string, string> = new Map([
  [FLUID_RUNTIME_CLASS, RUNTIME_SOURCE],
  [SCAN_ENTRY_CLASS, SCAN_SOURCE],
]);
