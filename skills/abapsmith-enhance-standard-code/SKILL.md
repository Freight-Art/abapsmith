---
name: abapsmith-enhance-standard-code
description: Creates BAdI spots, definitions, implementations, filters, and source-code plug-in hooks with abap_enh. Use when enhancing SAP standard code rather than writing your own object.
---

# Enhancements and BAdIs

Two unrelated sequences. Pick one; do not mix them.

Each step is an `operation` of **`abap_enh`** on the default v1 surface; on v2 they
are actions of **`abap_do`**. A plug-in's own source body goes through `abap_write`
on either surface, never through the enhancement tool.

**Classic BAdI**

```
enh_create_spot → enh_add_badi_def → [enh_add_filter_def]
  → enh_create_impl → enh_set_filter_values → enh_exercise
```

**Source-code plug-in hook**

```
enh_discover_hook_anchors → enh_create_hook
```

`anchorFullName` must come from `discover_hook_anchors`. Never construct it.
`create_hook` supports a **`PROG/P` host only**.

## `spec` identifier grammar

`badiName`, `spotName`, `enhName`, `implName`, `implClass`, `interfaceName`,
`methodName`, `filterName`, `params[].name`: a letter, then letters/digits/
underscores, max 30 chars. No namespace, no leading `$`.

`params[].type` is a type reference, not an object name, and follows a
different rule: same 30-char grammar per part, but a leading `/NAMESPACE/` is
allowed and one `-COMPONENT` suffix is allowed — e.g. `STRING`,
`/DMO/S_FLIGHT-CARRID`, `MARA-MATNR`. `TYPE REF TO`/`LINE OF`/`TABLE OF` forms
are refused; give the plain type name SAP would resolve, not ABAP syntax.

## Hard boundaries

- **Every create lands in `$TMP`.** All seven create operations, hooks included.
  There is no package argument that changes this. A BAdI that must ship cannot be
  built here — say so instead of trying.
- **Creates are not atomic.** A call that throws may still have created a locked,
  empty shell. Check whether the object exists before retrying; a blind retry
  compounds the mess.
- **Never GET an enhancement through the wrong subtype collection.** `ENHO/XH` vs
  `ENHO/XHH` vs `ENHS/XS` — a wrong guess dumps a work process and **kills the ADT
  session**; the next call returns *"Session Timed Out"*. Resolve the subtype
  first. Never sweep sibling collections after a 404.
- **`corr_nr: ""`** — present but empty — makes SAP fabricate both a request and a
  task. Omit it or supply a real one.
- **`enh_create_impl` does not create `implClass`.** SE19 generates the implementing
  class shell; this does not. Write the class yourself with `abap_write` (CLAS/OC),
  implementing the BAdI's marker interface, and activate it — otherwise the
  implementation names a class that is not there and nothing dispatches.

## Calling what you built

`GET BADI` types the handle against the **BAdI definition name**
(`add_badi_def`'s `badiName`) — never the marker interface, never the spot.

```abap
DATA lo_badi TYPE REF TO ztm_bd_hw011b.   " definition name
GET BADI lo_badi.
CALL BADI lo_badi->change_data CHANGING ct_data = ct_data.
```

Wrong type → **compile** error: `"LO_BADI" is not a valid BAdI handle here.` No
debugger will explain it; retype the one `DATA` statement. Do not conclude the
implementation is uncallable.

## Filters — the silent one

An implementation with **no filter values on a filter-dependent, multiple-use
BAdI fires for every call site in the system**, and reads back completely
healthy. Nothing warns you.

Always follow `enh_create_impl` with `enh_set_filter_values` when the definition
declares filters. Check the definition's filters first.

A single-use BAdI raises `CX_BADI_NOT_IMPLEMENTED` on a wrong filter — a real
signal. A multiple-use BAdI silently does nothing.

## Read-modify-write, always

All pre/post/overwrite exit bodies of one class enhancement live in **one blob**.
Editing one exit rewrites all of them — no per-exit URI, no lock conflict to warn
you. GET, mutate, PUT. Never author a payload from scratch.

## Two activation axes

`enho:active="X"` = switched on at runtime. `adtcore:version` = whether an inactive
revision exists. Check **both**; two of the four combinations look active on a
careless single-attribute read but are inert. Never branch on
`enho:runtimeBehaviorShorttext` — it is localised prose, not an enum.

## Verify

Activation returns **200 with errors inside `chkl:messages`**. A missing
`INTERFACES if_badi_interface.` on a marker interface fails exactly this way.
Always read the messages, not the status code.

A multi-use BAdI's marker interface may declare only `IMPORTING`/`CHANGING`
parameters, and the check covers the whole interface, not just the new method.
