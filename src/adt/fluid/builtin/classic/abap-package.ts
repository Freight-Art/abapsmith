import type { ClassicAbapPart } from "./abap-core.js";

export const packagePart: ClassicAbapPart = {
  methods: ["create_package", "delete_package"],
  source: `  METHOD create_package.
    DATA: ls_data     TYPE scompkdtln,
          lo_package   TYPE REF TO if_package,
          ls_tdevc     TYPE tdevc,
          lv_packtype  TYPE scompkdtln-packtype VALUE 'D'.
    DATA lv_package TYPE devclass.
    lv_package = s( 'package_name' ).
    DATA(lv_description) = s( 'description' ).
    DATA(lv_software_component) = s( 'software_component' ).
    DATA lv_corr_nr TYPE trkorr.
    lv_corr_nr = s( 'corr_nr' ).
    DATA lv_super TYPE devclass.
    lv_super = s( 'super_package' ).
    DATA(lv_package_type) = s( 'package_type' ).

    " package_type: only "development" (SCOMPKDTLN-PACKTYPE 'D') is exposed by this bridge.
    IF lv_package_type IS NOT INITIAL AND lv_package_type <> 'development'.
      fail( |package_type { lv_package_type } is not supported, only development is exposed| ).
      RETURN.
    ENDIF.

    " --- Constraints proven live on A4H. Do not "simplify" these. ---
    " 2. SCOMPKDTLN has NO DEVLAYER field and no usable COMPONENT field - setting
    "    either fails the syntax check.
    " 3. SCOMPKDTLN-PDEVCLASS is the TRANSPORT LAYER, not the superpackage. Setting
    "    it to a package name silently truncates to 4 characters and short-dumps
    "    with LAYER_INVALID. It is never set here; the transport layer is left to
    "    the transport route configured for the software component.
    " 4. SUPERPACKAGE_IN_TDEVC looks right but is output-only on create - passing it
    "    leaves PARENTCL blank. The parent is attached in a SECOND step below.
    ls_data-devclass = lv_package.
    ls_data-ctext    = lv_description.
    ls_data-as4user  = sy-uname.
    ls_data-dlvunit  = lv_software_component.
    ls_data-korrflag = 'X'.
    ls_data-packtype = lv_packtype.

    " CREATE_NEW_PACKAGE / SAVE / SET_CHANGEABLE raise CLASSIC (non-cx_root)
    " exceptions, invisible to the CATCH cx_root around this whole method
    " (see ddic-bridge.ts) - CALL METHOD ... EXCEPTIONS OTHERS = 1 is the
    " only way to attach EXCEPTIONS at all; functional-call syntax cannot.
    CALL METHOD cl_package_factory=>create_new_package
      EXPORTING
        i_reuse_deleted_object = abap_true
      IMPORTING
        e_package               = lo_package
      CHANGING
        c_package_data           = ls_data
      EXCEPTIONS
        OTHERS                   = 1.
    IF sy-subrc <> 0.
      fail( |Creating package failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
      RETURN.
    ENDIF.

    CALL METHOD lo_package->save
      EXPORTING
        i_transport_request = lv_corr_nr
      EXCEPTIONS
        OTHERS               = 1.
    IF sy-subrc <> 0.
      fail( |Saving package failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
      RETURN.
    ENDIF.

    " i_changeable is transcribed from the IF_PACKAGE signature and is NOT
    " verified live by this change - see this file's header. A wrong name
    " fails the generated class's OWN syntax check at bridge activation,
    " before any mutation runs.
    CALL METHOD lo_package->set_changeable
      EXPORTING
        i_changeable = abap_false
      EXCEPTIONS
        OTHERS       = 1.
    IF sy-subrc <> 0.
      fail( |Making package not changeable failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
      RETURN.
    ENDIF.
    COMMIT WORK.
    line( 'PKG-CREATED' ).

    IF lv_super IS NOT INITIAL.
      " Step 2 - the parent CANNOT be set on create (constraint 4 above); the package
      " is re-loaded and attached here. LOAD_PACKAGE / SET_CHANGEABLE / SAVE /
      " SET_SUPER_PACKAGE_NAME all raise CLASSIC exceptions - see this file's header.
      CALL METHOD cl_package_factory=>load_package
        EXPORTING
          i_package_name = lv_package
        IMPORTING
          e_package      = lo_package
        EXCEPTIONS
          OTHERS         = 1.
      IF sy-subrc <> 0.
        fail( |Loading package failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
        RETURN.
      ENDIF.

      " i_changeable - see the unverified-parameter-name note above.
      CALL METHOD lo_package->set_changeable
        EXPORTING
          i_changeable = abap_true
        EXCEPTIONS
          OTHERS       = 1.
      IF sy-subrc <> 0.
        fail( |Making package changeable failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
        RETURN.
      ENDIF.

      " i_super_package_name is transcribed from the IF_PACKAGE signature and is
      " NOT verified live by this change - see this file's header. A wrong name
      " fails the generated class's OWN syntax check at bridge activation, before
      " any mutation runs.
      CALL METHOD lo_package->set_super_package_name
        EXPORTING
          i_super_package_name = lv_super
        EXCEPTIONS
          OTHERS                = 1.
      IF sy-subrc <> 0.
        fail( |Attaching super package failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
        RETURN.
      ENDIF.

      CALL METHOD lo_package->save
        EXCEPTIONS
          OTHERS = 1.
      IF sy-subrc <> 0.
        fail( |Saving package failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
        RETURN.
      ENDIF.

      CALL METHOD lo_package->set_changeable
        EXPORTING
          i_changeable = abap_false
        EXCEPTIONS
          OTHERS       = 1.
      IF sy-subrc <> 0.
        fail( |Making package not changeable failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
        RETURN.
      ENDIF.
      COMMIT WORK.
      line( 'PKG-PARENT-SET' ).
    ENDIF.

    " A tag alone is not proof: the classrun could report success for a row that
    " was rolled back. Re-read TDEVC and refuse to write PKG-CONFIRMED unless the
    " row is actually there. (This is still the bridge's own stdout -
    " src/tools/write.ts additionally verifies out-of-band.)
    "
    " DLVUNIT and KORRFLAG are reported as EVIDENCE, not judged here. Two
    " reasons. (a) Any RETURN below this point fires AFTER the create already
    " happened, and this bridge does not self-delete on a discrepancy: a hard
    " failure here would leave the package behind while telling the caller the
    " operation failed - strictly worse than handing back the row and letting the TypeScript layer
    " say what it means. (b) The KORRFLAG value TDEVC carries for a
    " transportable package is transcribed from the reporter's run, not
    " independently confirmed, so a mismatch is not reliably a defect. The
    " comparison lives in createPackageViaBridge's caller instead, where it is a
    " loud note rather than a verdict.
    SELECT SINGLE * FROM tdevc INTO @ls_tdevc WHERE devclass = @lv_package.
    IF sy-subrc <> 0.
      fail( |TDEVC has no row for { lv_package } after create| ).
      RETURN.
    ENDIF.
    line( |ZMCP-PKG-TDEVC> DEVCLASS={ ls_tdevc-devclass } PARENTCL={ ls_tdevc-parentcl } DLVUNIT={ ls_tdevc-dlvunit } KORRFLAG={ ls_tdevc-korrflag }| ).
    line( 'PKG-CONFIRMED' ).
  ENDMETHOD.

  METHOD delete_package.
    DATA: ls_tdevc          TYPE tdevc,
          lt_subpkg         TYPE STANDARD TABLE OF tdevc WITH EMPTY KEY,
          ls_subpkg         TYPE tdevc,
          lt_tadir          TYPE STANDARD TABLE OF tadir WITH EMPTY KEY,
          ls_tadir          TYPE tadir,
          lo_package        TYPE REF TO if_package,
          lv_content_count  TYPE i,
          lv_holder         TYPE trkorr,
          lv_strkorr        TYPE trkorr,
          lv_request        TYPE trkorr,
          lv_task           TYPE trkorr.
    DATA lv_package TYPE devclass.
    lv_package = s( 'package_name' ).
    DATA lv_corr_nr TYPE trkorr.
    lv_corr_nr = s( 'corr_nr' ).

    " Step 1 - confirm the package exists; refuse honestly if it does not,
    " rather than treating a delete of a never-existed name as a no-op.
    SELECT SINGLE * FROM tdevc INTO @ls_tdevc WHERE devclass = @lv_package.
    IF sy-subrc <> 0.
      fail( |package { lv_package } does not exist| ).
      RETURN.
    ENDIF.

    " Step 2 - gather emptiness evidence first: sub-packages (TDEVC-PARENTCL)
    " and objects (TADIR-DEVCLASS).
    SELECT * FROM tdevc INTO TABLE @lt_subpkg WHERE parentcl = @lv_package.
    LOOP AT lt_subpkg INTO ls_subpkg.
      lv_content_count = lv_content_count + 1.
      line( |ZMCP-PKG-CONTENT> KIND=SUBPKG PGMID=R3TR OBJECT=DEVC NAME={ ls_subpkg-devclass }| ).
    ENDLOOP.

    SELECT * FROM tadir INTO TABLE @lt_tadir WHERE devclass = @lv_package.
    LOOP AT lt_tadir INTO ls_tadir.
      " The package's own R3TR DEVC row in TADIR is filtered here, in the
      " LOOP, rather than in the SQL WHERE clause, deliberately.
      IF ls_tadir-pgmid = 'R3TR' AND ls_tadir-object = 'DEVC' AND ls_tadir-obj_name = lv_package.
        CONTINUE.
      ENDIF.
      lv_content_count = lv_content_count + 1.
      CLEAR: lv_holder, lv_strkorr, lv_request, lv_task.
      IF ls_tadir-delflag = 'X'.
        " Object is already gone from TADIR's point of view; find the open
        " request/task that actually holds the deletion, so the caller can be
        " told to release it instead of "empty the package".
        SELECT e071~trkorr, e070~strkorr
          FROM e071
          INNER JOIN e070 ON e070~trkorr = e071~trkorr
          WHERE e071~pgmid = @ls_tadir-pgmid
            AND e071~object = @ls_tadir-object
            AND e071~obj_name = @ls_tadir-obj_name
            AND e070~trstatus IN ( 'D', 'L' )
          ORDER BY e071~trkorr DESCENDING
          INTO ( @lv_holder, @lv_strkorr ).
          EXIT.
        ENDSELECT.
        IF lv_holder IS NOT INITIAL.
          IF lv_strkorr IS NOT INITIAL.
            " The E071 row sits on a task; its parent request is the real holder.
            lv_request = lv_strkorr.
            lv_task    = lv_holder.
          ELSE.
            lv_request = lv_holder.
          ENDIF.
        ENDIF.
      ENDIF.
      line( |ZMCP-PKG-CONTENT> KIND=OBJECT PGMID={ ls_tadir-pgmid } OBJECT={ ls_tadir-object } NAME={ ls_tadir-obj_name } DELFLAG={ ls_tadir-delflag } TRKORR={ lv_request } TASK={ lv_task }| ).
    ENDLOOP.

    " Step 3 - delete is only attempted on a provably empty package; any
    " content found above stops here before CL_PACKAGE_FACTORY is touched.
    IF lv_content_count > 0.
      RETURN.
    ENDIF.
    line( 'PKG-EMPTY' ).

    " Step 4 - LOAD_PACKAGE mirrors ./package-create.ts; SAVE takes
    " i_transport_request only when a transport was supplied.
    " LOAD_PACKAGE / SET_CHANGEABLE / DELETE / SAVE all raise CLASSIC
    " (non-cx_root) exceptions, invisible to the CATCH cx_root wrapping this
    " whole method (see ddic-bridge.ts). CALL METHOD ... EXCEPTIONS OTHERS = 1
    " is the only way to attach EXCEPTIONS to a method call - functional-call
    " syntax (e.g. the old \`lo_package->delete( ).\`) cannot carry one at all.
    " A locked package short-dumped through set_changeable live before this
    " guard existed and destroyed the whole tagged transcript.
    CALL METHOD cl_package_factory=>load_package
      EXPORTING
        i_package_name = lv_package
      IMPORTING
        e_package      = lo_package
      EXCEPTIONS
        OTHERS         = 1.
    IF sy-subrc <> 0.
      fail( |Loading package failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
      RETURN.
    ENDIF.

    " i_changeable is transcribed from the IF_PACKAGE signature and is NOT
    " verified live by this change. If the name is wrong, the generated
    " class fails ITS OWN SYNTAX CHECK at bridge activation - caught by
    " deployBridge/verifyBridgeActivation BEFORE any mutation runs. Loud,
    " and safe: nothing is created or deleted on a bad name here.
    CALL METHOD lo_package->set_changeable
      EXPORTING
        i_changeable = abap_true
      EXCEPTIONS
        OTHERS       = 1.
    IF sy-subrc <> 0.
      fail( |Making package changeable failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
      RETURN.
    ENDIF.

    CALL METHOD lo_package->delete
      EXCEPTIONS
        OTHERS = 1.
    IF sy-subrc <> 0.
      fail( |Deleting package failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
      RETURN.
    ENDIF.

    IF lv_corr_nr IS INITIAL.
      CALL METHOD lo_package->save
        EXCEPTIONS
          OTHERS = 1.
    ELSE.
      CALL METHOD lo_package->save
        EXPORTING
          i_transport_request = lv_corr_nr
        EXCEPTIONS
          OTHERS               = 1.
    ENDIF.
    IF sy-subrc <> 0.
      fail( |Saving package failed, sy-subrc={ sy-subrc }, { sy-msgid }{ sy-msgno }| ).
      RETURN.
    ENDIF.
    COMMIT WORK.
    line( 'PKG-DELETED' ).

    " Step 5 - re-read TDEVC because a clean return from IF_PACKAGE~DELETE is
    " not trusted (unverified live); only then write PKG-GONE.
    SELECT SINGLE * FROM tdevc INTO @ls_tdevc WHERE devclass = @lv_package.
    IF sy-subrc = 0.
      fail( |delete of { lv_package } reported no error but the TDEVC row still exists| ).
      RETURN.
    ENDIF.
    line( 'PKG-GONE' ).
  ENDMETHOD.`,
};
