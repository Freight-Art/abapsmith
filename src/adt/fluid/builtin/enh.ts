/**
 * Built-in "enh" fluid tool: ports five of the six SAP classic-enhancement
 * operations from `src/adt/enhancement-bridge.ts` / `enhancement-templates.ts`
 * onto a single static body class driven by JSON args, instead of legacy's
 * six per-call generated bridge classes with baked-in literals.
 *
 * The sixth legacy operation, `exercise` (binding a BAdI handle and calling
 * one of its methods), is NOT ported here and has no action in this
 * manifest — see the comment above `WHEN OTHERS` in `ENH_SOURCE` below for
 * the full explanation. In short: legacy's exerciseFragment needs
 * `DATA lo_badi TYPE REF TO <badi_name>.`, a compile-time type built from a
 * runtime string, which a body class deployed once (this file's whole
 * design) cannot express, and the only dynamic-dispatch escape hatch
 * (`->(...)`/`=>(...)`) is exactly what `reviewFluidAbap`'s
 * "dynamic-call-method" rule forbids. Shipping an action that can never
 * succeed would be a footgun for any MCP client reading this manifest, so
 * the limitation lives here as documentation instead. The legacy
 * (non-fluid) `abap_enh` tool remains the way to exercise a BAdI.
 *
 * package_name, corr_nr and activate are REQUIRED (not optional) on every
 * mutating action here, matching `classic.ts`'s convention exactly. Declaring
 * `targets.transport` while leaving `corr_nr` optional in the input schema
 * was a lie the dispatch gate caught at runtime: `resolveTargetString`
 * throws BAD_INPUT the instant a caller omits it, so the field was never
 * actually optional in practice.
 *
 * Package/transport handling, the marker-interface precondition (H21) and
 * the joint spot+implementation reactivation (H23) stay in TypeScript, as
 * does every ADT REST call — this file only carries the ABAP-side steps
 * that legacy's bridge classes ran through `cl_enh_factory`/`cl_enh_tool_*`.
 */
import type { FluidManifest } from "../manifest.js";
import { FLUID_CONTRACT } from "../manifest.js";
import { FLUID_RUNTIME_CLASS, fluidRuntimeManifest, fluidRuntimeSources } from "../abap/runtime.js";

const RUNTIME_SOURCE = fluidRuntimeSources.get(FLUID_RUNTIME_CLASS);
if (RUNTIME_SOURCE === undefined) {
  throw new Error(`fluidRuntimeSources has no entry for ${FLUID_RUNTIME_CLASS}`);
}

const RUNTIME_OBJECT = fluidRuntimeManifest.objects.find((o) => o.name === FLUID_RUNTIME_CLASS);
if (RUNTIME_OBJECT === undefined) {
  throw new Error(`fluidRuntimeManifest has no entry for ${FLUID_RUNTIME_CLASS}`);
}

const ENH_SOURCE = `CLASS zcl_zmcp_fluid_enh DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    CLASS-METHODS run
      IMPORTING
        iv_action TYPE string
        iv_json   TYPE string.

ENDCLASS.


CLASS zcl_zmcp_fluid_enh IMPLEMENTATION.

  METHOD run.
    DATA: lv_pkg     TYPE devclass,
          lv_trkorr  TYPE trkorr,
          lo_spot    TYPE REF TO if_enh_spot_tool,
          lo_def     TYPE REF TO cl_enh_tool_badi_def,
          ls_badi    TYPE enh_badi_data,
          ls_filter  TYPE enh_badi_filter,
          lo_enh     TYPE REF TO if_enh_tool,
          lo_impl    TYPE REF TO cl_enh_tool_badi_impl,
          ls_impl    TYPE enh_badi_impl_data,
          lo_tool    TYPE REF TO if_enh_tool,
          lo_obj     TYPE REF TO if_enh_object,
          ls_val     TYPE enh_badiimpl_filter_value,
          ls_root    TYPE enh_badiimpl_filter_root,
          ls_id      TYPE LINE OF enh_badiimpl_filter_id_it,
          lv_filter_check TYPE string.

    zcl_zmcp_fluid_rt=>begin( iv_id = 'enh' iv_action = iv_action ).
    zcl_zmcp_fluid_rt=>scan( iv_json ).

    " package_name/corr_nr are required on every mutating action (see the
    " enh manifest's input schema), so there is no $TMP/space fallback here:
    " dispatch's own schema check (BAD_INPUT) and the target-resolution gate
    " both already refuse the call before this ABAP body ever runs if either
    " is absent. A silent local-package fallback here would only mask that
    " class of bug instead of surfacing it - callers that want $TMP must
    " pass package_name: "$TMP" explicitly, same as classic.ts. TRANSLATE
    " guards against a lowercase devclass slipping past the gate's allowlist
    " check unnoticed. corr_nr legitimately IS an empty string for a $
    " (local) package, so it is only copied into lv_trkorr when non-initial.
    lv_pkg = zcl_zmcp_fluid_rt=>s( 'package_name' ).
    TRANSLATE lv_pkg TO UPPER CASE.
    DATA(lv_corr_arg) = zcl_zmcp_fluid_rt=>s( 'corr_nr' ).
    IF lv_corr_arg IS NOT INITIAL.
      lv_trkorr = lv_corr_arg.
    ENDIF.
    DATA(lv_activate) = zcl_zmcp_fluid_rt=>b( 'activate' ).

    TRY.
        CASE iv_action.
          WHEN 'create_spot'.
            DATA(lv_spot_name) = zcl_zmcp_fluid_rt=>s( 'spot_name' ).
            DATA(lv_description) = zcl_zmcp_fluid_rt=>s( 'description' ).
            IF lv_spot_name IS INITIAL OR lv_description IS INITIAL.
              zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
                iv_text = 'spot_name and description are required' ).
              zcl_zmcp_fluid_rt=>end( 1 ).
              RETURN.
            ENDIF.

            cl_enh_factory=>create_enhancement_spot(
              EXPORTING spot_name = CONV #( lv_spot_name )
                        tooltype  = cl_enh_tool_badi_def=>tooltype
                        dark      = abap_true
              IMPORTING spot      = lo_spot
              CHANGING  trkorr    = lv_trkorr
                        devclass  = lv_pkg ).
            lo_def ?= lo_spot.
            lo_spot->if_enh_object_docu~set_shorttext( CONV #( lv_description ) ).
            lo_spot->if_enh_object~save( EXPORTING run_dark = abap_true
              CHANGING devclass = lv_pkg trkorr = lv_trkorr ).
            IF lv_activate = abap_true.
              lo_spot->if_enh_object~activate( EXPORTING run_dark = abap_true
                CHANGING devclass = lv_pkg trkorr = lv_trkorr ).
            ENDIF.
            lo_spot->if_enh_object~unlock( ).
            zcl_zmcp_fluid_rt=>out( '{"created":true}' ).

          WHEN 'add_badi_def'.
            lv_spot_name = zcl_zmcp_fluid_rt=>s( 'spot_name' ).
            DATA(lv_badi_name) = zcl_zmcp_fluid_rt=>s( 'badi_name' ).
            DATA(lv_interface_name) = zcl_zmcp_fluid_rt=>s( 'interface_name' ).
            DATA(lv_short_text) = zcl_zmcp_fluid_rt=>s( 'short_text' ).
            IF lv_spot_name IS INITIAL OR lv_badi_name IS INITIAL
                OR lv_interface_name IS INITIAL OR lv_short_text IS INITIAL.
              zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
                iv_text = 'spot_name, badi_name, interface_name and short_text are required' ).
              zcl_zmcp_fluid_rt=>end( 1 ).
              RETURN.
            ENDIF.

            lo_spot = cl_enh_factory=>get_enhancement_spot(
              spot_name = CONV #( lv_spot_name ) lock = 'X' run_dark = abap_true ).
            lo_def ?= lo_spot.
            CLEAR ls_badi.
            ls_badi-badi_name = lv_badi_name.
            ls_badi-interface_name = lv_interface_name.
            ls_badi-single_use = zcl_zmcp_fluid_rt=>b( 'single_use' ).
            ls_badi-badi_shorttext = lv_short_text.
            ls_badi-context_mode = 'N'.
            lo_def->add_badi_def( im_badi_def = ls_badi ).
            lo_spot->if_enh_object~save( EXPORTING run_dark = abap_true
              CHANGING devclass = lv_pkg trkorr = lv_trkorr ).
            IF lv_activate = abap_true.
              lo_spot->if_enh_object~activate( EXPORTING run_dark = abap_true
                CHANGING devclass = lv_pkg trkorr = lv_trkorr ).
            ENDIF.
            lo_spot->if_enh_object~unlock( ).
            zcl_zmcp_fluid_rt=>out( '{"added":true}' ).

          WHEN 'add_filter_def'.
            lv_spot_name = zcl_zmcp_fluid_rt=>s( 'spot_name' ).
            lv_badi_name = zcl_zmcp_fluid_rt=>s( 'badi_name' ).
            DATA(lv_filter_name) = zcl_zmcp_fluid_rt=>s( 'filter_name' ).
            DATA(lv_filter_type) = zcl_zmcp_fluid_rt=>s( 'filter_type' ).
            DATA(lv_filter_text) = zcl_zmcp_fluid_rt=>s( 'filter_text' ).
            IF lv_spot_name IS INITIAL OR lv_badi_name IS INITIAL
                OR lv_filter_name IS INITIAL OR lv_filter_type IS INITIAL.
              zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
                iv_text = 'spot_name, badi_name, filter_name and filter_type are required' ).
              zcl_zmcp_fluid_rt=>end( 1 ).
              RETURN.
            ENDIF.

            lo_spot = cl_enh_factory=>get_enhancement_spot(
              spot_name = CONV #( lv_spot_name ) lock = 'X' run_dark = abap_true ).
            lo_def ?= lo_spot.
            ls_badi = lo_def->get_badi_def( badi_name = CONV #( lv_badi_name ) ).
            lo_def->delete_badi_def( badi_name = CONV #( lv_badi_name ) ).
            CLEAR ls_filter.
            ls_filter-filter_name = lv_filter_name.
            ls_filter-filter_type = lv_filter_type.
            ls_filter-filtertext = lv_filter_text.
            APPEND ls_filter TO ls_badi-filters.
            lo_def->add_badi_def( im_badi_def = ls_badi ).
            lo_spot->if_enh_object~save( EXPORTING run_dark = abap_true
              CHANGING devclass = lv_pkg trkorr = lv_trkorr ).
            IF lv_activate = abap_true.
              lo_spot->if_enh_object~activate( EXPORTING run_dark = abap_true
                CHANGING devclass = lv_pkg trkorr = lv_trkorr ).
            ENDIF.
            lo_spot->if_enh_object~unlock( ).
            zcl_zmcp_fluid_rt=>out( '{"added":true}' ).

          WHEN 'create_impl'.
            DATA(lv_enh_name) = zcl_zmcp_fluid_rt=>s( 'enh_name' ).
            lv_spot_name = zcl_zmcp_fluid_rt=>s( 'spot_name' ).
            lv_badi_name = zcl_zmcp_fluid_rt=>s( 'badi_name' ).
            DATA(lv_impl_name) = zcl_zmcp_fluid_rt=>s( 'impl_name' ).
            DATA(lv_impl_class) = zcl_zmcp_fluid_rt=>s( 'impl_class' ).
            lv_description = zcl_zmcp_fluid_rt=>s( 'description' ).
            DATA(lv_active) = zcl_zmcp_fluid_rt=>b( 'active' ).
            IF lv_enh_name IS INITIAL OR lv_spot_name IS INITIAL OR lv_badi_name IS INITIAL
                OR lv_impl_name IS INITIAL OR lv_impl_class IS INITIAL OR lv_description IS INITIAL.
              zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
                iv_text = 'enh_name, spot_name, badi_name, impl_name, impl_class and description are required' ).
              zcl_zmcp_fluid_rt=>end( 1 ).
              RETURN.
            ENDIF.

            cl_enh_factory=>create_enhancement(
              EXPORTING enhname     = CONV #( lv_enh_name )
                        enhtype     = 'IMPL'
                        enhtooltype = cl_enh_tool_badi_impl=>tooltype
                        dark        = abap_true
              IMPORTING enhancement = lo_enh
              CHANGING  trkorr      = lv_trkorr
                        devclass    = lv_pkg ).
            lo_impl ?= lo_enh.
            lo_impl->set_spot_name( CONV #( lv_spot_name ) ).
            lo_impl->if_enh_object_docu~set_shorttext( CONV #( lv_description ) ).
            CLEAR ls_impl.
            ls_impl-spot_name = lv_spot_name.
            ls_impl-badi_name = lv_badi_name.
            ls_impl-impl_name = lv_impl_name.
            ls_impl-impl_class = lv_impl_class.
            ls_impl-active = lv_active.
            lo_impl->add_implementation( im_implementation = ls_impl ).
            lo_enh->if_enh_object~save( EXPORTING run_dark = abap_true
              CHANGING devclass = lv_pkg trkorr = lv_trkorr ).
            IF lv_activate = abap_true.
              lo_enh->if_enh_object~activate( EXPORTING run_dark = abap_true
                CHANGING devclass = lv_pkg trkorr = lv_trkorr ).
            ENDIF.
            lo_enh->if_enh_object~unlock( ).

            " Diagnostic only, mirrors legacy badiFilterCheckFragment: never fails create_impl.
            CLEAR: lv_filter_check, lo_spot, lo_def, ls_badi.
            TRY.
                lo_spot = cl_enh_factory=>get_enhancement_spot(
                  spot_name = CONV #( lv_spot_name ) lock = 'X' run_dark = abap_true ).
                lo_def ?= lo_spot.
                ls_badi = lo_def->get_badi_def( badi_name = CONV #( lv_badi_name ) ).
                IF ls_badi-filters IS NOT INITIAL.
                  lv_filter_check = 'has_filters'.
                ELSE.
                  lv_filter_check = 'no_filters'.
                ENDIF.
              CATCH cx_root.
                lv_filter_check = 'inconclusive'.
            ENDTRY.
            IF lo_spot IS BOUND.
              TRY.
                  lo_spot->if_enh_object~unlock( ).
                CATCH cx_root.
              ENDTRY.
            ENDIF.

            DATA(lv_impl_json) = |\\{"created":true,"impl_added":true,"filter_check":"| &&
              zcl_zmcp_fluid_rt=>esc( lv_filter_check ) && |"\\}|.
            zcl_zmcp_fluid_rt=>out( lv_impl_json ).

          WHEN 'set_filter_values'.
            lv_enh_name = zcl_zmcp_fluid_rt=>s( 'enh_name' ).
            lv_impl_name = zcl_zmcp_fluid_rt=>s( 'impl_name' ).
            lv_filter_name = zcl_zmcp_fluid_rt=>s( 'filter_name' ).
            lv_filter_type = zcl_zmcp_fluid_rt=>s( 'filter_type' ).
            DATA(lv_compare_raw) = zcl_zmcp_fluid_rt=>s( 'compare' ).
            DATA(lv_value) = zcl_zmcp_fluid_rt=>s( 'value' ).
            IF lv_enh_name IS INITIAL OR lv_impl_name IS INITIAL OR lv_filter_name IS INITIAL
                OR lv_filter_type IS INITIAL OR lv_compare_raw IS INITIAL.
              zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
                iv_text = 'enh_name, impl_name, filter_name, filter_type, compare and value are required' ).
              zcl_zmcp_fluid_rt=>end( 1 ).
              RETURN.
            ENDIF.

            DATA(lv_compare) = lv_compare_raw.
            CASE lv_compare_raw.
              WHEN 'EQ'. lv_compare = '='.
              WHEN 'NE'. lv_compare = '<>'.
              WHEN 'LT'. lv_compare = '<'.
              WHEN 'LE'. lv_compare = '<='.
              WHEN 'GT'. lv_compare = '>'.
              WHEN 'GE'. lv_compare = '>='.
            ENDCASE.
            IF lv_compare <> '=' AND lv_compare <> '<>' AND lv_compare <> '<'
                AND lv_compare <> '<=' AND lv_compare <> '>' AND lv_compare <> '>='.
              zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'args'
                iv_text = 'compare must be one of = <> < <= > >= or EQ/NE/LT/LE/GT/GE' ).
              zcl_zmcp_fluid_rt=>end( 1 ).
              RETURN.
            ENDIF.

            lo_tool = cl_enh_factory=>get_enhancement(
              enhancement_id = CONV #( lv_enh_name ) lock = 'X' run_dark = abap_true ).
            lo_impl ?= lo_tool.
            lo_obj ?= lo_tool.
            ls_impl = lo_impl->get_implementation( impl_name = CONV #( lv_impl_name ) ).
            lo_impl->delete_implementation( impl_name = CONV #( lv_impl_name ) ).
            CLEAR: ls_impl-filters, ls_impl-filter_values, ls_impl-filter_root, ls_impl-filter_tree.
            CLEAR ls_val.
            ls_val-id = 1.
            ls_val-filter_name = lv_filter_name.
            ls_val-filter_type = lv_filter_type.
            ls_val-compare = lv_compare.
            ls_val-filter_char_value1 = lv_value.
            APPEND ls_val TO ls_impl-filter_values.
            CLEAR ls_id.
            ls_id-id = 1.
            CLEAR ls_root.
            ls_root-root = 1.
            APPEND ls_id TO ls_root-filters.
            APPEND ls_root TO ls_impl-filter_root.
            lo_impl->add_implementation( im_implementation = ls_impl ).
            lo_obj->save( EXPORTING run_dark = abap_true
              CHANGING devclass = lv_pkg trkorr = lv_trkorr ).
            IF lv_activate = abap_true.
              lo_obj->activate( EXPORTING run_dark = abap_true
                CHANGING devclass = lv_pkg trkorr = lv_trkorr ).
            ENDIF.
            lo_obj->unlock( ).
            zcl_zmcp_fluid_rt=>out( '{"replaced":true}' ).

          " There is deliberately no WHEN 'exercise'. arm here. Legacy's
          " exerciseFragment (see enhancement-templates.ts) binds a BAdI
          " handle by declaring DATA lo_badi TYPE REF TO <badi_name> - a
          " compile-time type built from a runtime string. That works for
          " legacy because it generates one fresh, per-call bridge class per
          " badi_name and compiles the literal type name straight into it.
          " This class is deployed once and shared by every call, so it has
          " no badi_name to compile in; the only ways to bind and call a
          " handle whose type is known only at runtime - an instance
          " reference immediately followed by a parenthesized, computed
          " method name, the same via a class reference, or a CALL METHOD
          " whose method name is itself a parenthesized variable - are all
          " dynamic dispatch, and reviewFluidAbap's "dynamic-call-method"
          " rule forbids every one of them from ever being deployed through
          " this tool. So "exercise a BAdI handle from a static fluid body"
          " is not a missing feature to add later: it is provably
          " unimplementable under this tool's own static-review contract.
          " Exercising a BAdI implementation remains a job for the legacy
          " (non-fluid) abap_enh tool, whose generated bridge class can
          " still write that TYPE REF TO literally because it is
          " regenerated per call.

          WHEN OTHERS.
            zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'dispatch'
              iv_text = |unknown action "{ iv_action }"| ).
            zcl_zmcp_fluid_rt=>end( 1 ).
            RETURN.
        ENDCASE.

      CATCH cx_root INTO DATA(lx_err).
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = iv_action iv_text = lx_err->get_text( ) ).
        zcl_zmcp_fluid_rt=>end( 1 ).
        RETURN.
    ENDTRY.

    zcl_zmcp_fluid_rt=>end( 0 ).
  ENDMETHOD.

ENDCLASS.
`;

export const enhManifest: FluidManifest = {
  contract: FLUID_CONTRACT,
  id: "enh",
  title: "Enhancement spots",
  description: "Creates and edits classic BAdI enhancement spots and implementations.",
  objects: [
    {
      name: FLUID_RUNTIME_CLASS,
      type: "CLAS/OC",
      // same live object as the rt tool's; derived so the two descriptions can't drift apart
      description: RUNTIME_OBJECT.description,
      source: { text: RUNTIME_SOURCE },
    },
    {
      name: "ZCL_ZMCP_FLUID_ENH",
      type: "CLAS/OC",
      description: "fluid: BAdI enhancement spot/implementation operations",
      source: { text: ENH_SOURCE },
    },
  ],
  entry: "ZCL_ZMCP_FLUID_ENH",
  actions: [
    {
      name: "create_spot",
      category: "mutate",
      description: "Creates, saves, activates and unlocks a new BAdI enhancement spot.",
      targets: { object: "/spot_name", package: "/package_name", transport: "/corr_nr" },
      input: {
        type: "object",
        required: ["spot_name", "description", "package_name", "corr_nr", "activate"],
        properties: {
          spot_name: { type: "string", maxLength: 30, description: "New spot's ENHNAME." },
          description: { type: "string", maxLength: 60, description: "Root object short text." },
          package_name: { type: "string", maxLength: 30, description: "Target package (devclass)." },
          corr_nr: {
            type: "string",
            maxLength: 10,
            description: "Transport request. Empty string for a $ (local) package.",
          },
          activate: { type: "boolean", description: "Activate after save; false leaves the spot inactive." },
        },
      },
      output: {
        type: "object",
        required: ["created"],
        properties: { created: { type: "boolean" } },
      },
    },
    {
      name: "add_badi_def",
      category: "mutate",
      description:
        "Adds a BAdI definition to an existing spot. Assumes the marker interface named by " +
        "interface_name already exists (INTERFACES if_badi_interface) - callers must create it first.",
      targets: { object: "/spot_name", package: "/package_name", transport: "/corr_nr" },
      input: {
        type: "object",
        required: [
          "spot_name",
          "badi_name",
          "interface_name",
          "single_use",
          "short_text",
          "package_name",
          "corr_nr",
          "activate",
        ],
        properties: {
          spot_name: { type: "string", maxLength: 30 },
          badi_name: { type: "string", maxLength: 30 },
          interface_name: { type: "string", maxLength: 30, description: "Pre-existing marker interface." },
          single_use: { type: "boolean" },
          short_text: { type: "string", maxLength: 60 },
          package_name: { type: "string", maxLength: 30, description: "Target package (devclass)." },
          corr_nr: {
            type: "string",
            maxLength: 10,
            description: "Transport request. Empty string for a $ (local) package.",
          },
          activate: { type: "boolean", description: "Activate after save; false leaves the spot inactive." },
        },
      },
      output: {
        type: "object",
        required: ["added"],
        properties: { added: { type: "boolean" } },
      },
    },
    {
      name: "add_filter_def",
      category: "mutate",
      description: "Adds a filter definition to an existing BAdI definition on a spot.",
      targets: { object: "/spot_name", package: "/package_name", transport: "/corr_nr" },
      input: {
        type: "object",
        required: ["spot_name", "badi_name", "filter_name", "filter_type", "package_name", "corr_nr", "activate"],
        properties: {
          spot_name: { type: "string", maxLength: 30 },
          badi_name: { type: "string", maxLength: 30 },
          filter_name: { type: "string", maxLength: 30 },
          filter_type: { type: "string", maxLength: 1, description: "Single-letter domain filter type code." },
          filter_text: { type: "string", maxLength: 60 },
          package_name: { type: "string", maxLength: 30, description: "Target package (devclass)." },
          corr_nr: {
            type: "string",
            maxLength: 10,
            description: "Transport request. Empty string for a $ (local) package.",
          },
          activate: { type: "boolean", description: "Activate after save; false leaves the spot inactive." },
        },
      },
      output: {
        type: "object",
        required: ["added"],
        properties: { added: { type: "boolean" } },
      },
    },
    {
      name: "create_impl",
      category: "mutate",
      description:
        "Creates a BAdI implementation object bound to a spot, saves/activates/unlocks it, then " +
        "reports (best-effort, never fails the create) whether the target BAdI has filters defined.",
      targets: { object: "/enh_name", package: "/package_name", transport: "/corr_nr" },
      input: {
        type: "object",
        required: [
          "enh_name",
          "spot_name",
          "badi_name",
          "impl_name",
          "impl_class",
          "active",
          "description",
          "package_name",
          "corr_nr",
          "activate",
        ],
        properties: {
          enh_name: { type: "string", maxLength: 30, description: "New implementation's ENHNAME." },
          spot_name: { type: "string", maxLength: 30 },
          badi_name: { type: "string", maxLength: 30 },
          impl_name: { type: "string", maxLength: 30 },
          impl_class: { type: "string", maxLength: 30, description: "Implementing class, e.g. a BAdI handler." },
          active: { type: "boolean" },
          description: { type: "string", maxLength: 60 },
          package_name: { type: "string", maxLength: 30, description: "Target package (devclass)." },
          corr_nr: {
            type: "string",
            maxLength: 10,
            description: "Transport request. Empty string for a $ (local) package.",
          },
          activate: { type: "boolean", description: "Activate after save; false leaves the implementation inactive." },
        },
      },
      output: {
        type: "object",
        required: ["created", "impl_added", "filter_check"],
        properties: {
          created: { type: "boolean" },
          impl_added: { type: "boolean" },
          filter_check: { type: "string", enum: ["has_filters", "no_filters", "inconclusive"] },
        },
      },
    },
    {
      name: "set_filter_values",
      category: "mutate",
      description:
        "Replaces a BAdI implementation's filter value with a single row (id 1) matching one " +
        "filter_name, then saves/activates/unlocks via the implementation's if_enh_object handle. " +
        "Does not perform legacy's joint spot+implementation ADT reactivation - callers that need " +
        "that stronger guarantee must still request it over ADT REST afterward.",
      targets: { object: "/enh_name", package: "/package_name", transport: "/corr_nr" },
      input: {
        type: "object",
        required: [
          "enh_name",
          "impl_name",
          "filter_name",
          "filter_type",
          "compare",
          "value",
          "package_name",
          "corr_nr",
          "activate",
        ],
        properties: {
          enh_name: { type: "string", maxLength: 30, description: "Implementation's ENHNAME." },
          impl_name: { type: "string", maxLength: 30 },
          filter_name: { type: "string", maxLength: 30 },
          filter_type: { type: "string", maxLength: 1 },
          compare: { type: "string", maxLength: 2, description: "= <> < <= > >= or EQ/NE/LT/LE/GT/GE." },
          value: { type: "string", maxLength: 255 },
          package_name: { type: "string", maxLength: 30, description: "Target package (devclass)." },
          corr_nr: {
            type: "string",
            maxLength: 10,
            description: "Transport request. Empty string for a $ (local) package.",
          },
          activate: { type: "boolean", description: "Activate after save; false leaves the implementation inactive." },
        },
      },
      output: {
        type: "object",
        required: ["replaced"],
        properties: { replaced: { type: "boolean" } },
      },
    },
  ],
};

export const enhSources: ReadonlyMap<string, string> = new Map([
  [FLUID_RUNTIME_CLASS, RUNTIME_SOURCE],
  ["ZCL_ZMCP_FLUID_ENH", ENH_SOURCE],
]);
