---
name: abapsmith-write-a-fluid-plugin
description: Writes a fluid API plugin — a manifest plus an ABAP body class — that adds a new tool to abapsmith without touching its source, and explains how the operator enables it. Use when asked to add, extend, or package a custom fluid tool or action.
---

# Writing a fluid plugin

A plugin is a directory the operator points abapsmith at. It adds a tool
reachable through `abap_fluid` with **no MCP registration and no change
to abapsmith**. You write the files; the operator consents and restarts.
Full reference: `doc/FLUID-API/` (manifest, protocol, authoring, safety).

`abap_fluid` exists on the default v1 tool surface only. The v2 surface
(`ABAP_TOOL_SURFACE=v2`) has no fluid entry point — `abap_do` does not
route to plugins — so a plugin cannot be called from v2 at all.

## Layout

```text
<root>/<id>/fluid-plugin.json
<root>/<id>/abap/zcl_zmcp_x_<id>.abap
```

Each immediate subdirectory of a configured root that holds a
`fluid-plugin.json` is one plugin. Copy from the shipped example
`test/fixtures/fluid-plugins/hello/`.

## Manifest

```json
{
  "contract": "1.0",
  "id": "hello",
  "title": "Hello fluid plugin",
  "description": "Replies to ping.",
  "objects": [
    { "name": "ZCL_ZMCP_X_HELLO", "type": "CLAS/OC", "description": "fluid: hello body",
      "source": { "file": "abap/zcl_zmcp_x_hello.abap" } }
  ],
  "entry": "ZCL_ZMCP_X_HELLO",
  "actions": [
    { "name": "ping", "category": "read", "description": "Replies with a fixed string.",
      "input": { "type": "object", "properties": { "name": { "type": "string" } } },
      "output": { "type": "object", "required": ["reply"],
                  "properties": { "reply": { "type": "string" } } } }
  ]
}
```

- `id`: `/^[a-z][a-z0-9_]{0,11}$/`, unique across built-ins and plugins.
- `objects[]`: deploy order. Types `CLAS/OC` or `INTF/OI`. `description` ≤ 60 chars.
- Every object name **must** be `ZCL_ZMCP_X_<ID>*` / `ZIF_ZMCP_X_<ID>*`.
- `entry`: the class whose `run( iv_action, iv_json )` the invoker calls.
- `category`: `read`, `execute`, or `mutate`. A `mutate` action should declare
  `targets` (JSON Pointers into its args, e.g.
  `{"object": "/name", "package": "/package", "transport": "/corr_nr"}`)
  so the safety gate judges the real object — without them nothing is gate-asserted.

## Body class

```abap
CLASS zcl_zmcp_x_hello DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run IMPORTING iv_action TYPE string
                                iv_json   TYPE string.
ENDCLASS.

CLASS zcl_zmcp_x_hello IMPLEMENTATION.
  METHOD run.
    DATA lv_rc TYPE i.
    zcl_zmcp_fluid_rt=>begin( iv_id = 'hello' iv_action = iv_action ).
    TRY.
        zcl_zmcp_fluid_rt=>scan( iv_json ).
        CASE iv_action.
          WHEN 'ping'.
            DATA(lv_name) = zcl_zmcp_fluid_rt=>s( 'name' ).
            zcl_zmcp_fluid_rt=>out( |\{"reply":"pong { zcl_zmcp_fluid_rt=>esc( lv_name ) }"\}| ).
          WHEN OTHERS.
            zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'dispatch'
                                    iv_text = |unknown action { iv_action }| ).
            lv_rc = 4.
        ENDCASE.
      CATCH cx_root INTO DATA(lx_err).
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = iv_action
                                iv_text = lx_err->get_text( ) ).
        lv_rc = 8.
    ENDTRY.
    zcl_zmcp_fluid_rt=>end( lv_rc ).
  ENDMETHOD.
ENDCLASS.
```

Rules:

- Source is static. Call arguments arrive only via `iv_json`; never bake them in.
- Read args with `scan` then `s( 'key' )` (string), `b( 'key' )` (bool),
  `n( 'key' )` (array length; items at `key/0`, `key/1`, …).
  **`scan` reads one flat level**: top-level strings and arrays of strings only.
  Keep `input` schemas flat — a nested object validates on the TypeScript side
  but arrives as unusable text in ABAP.
- Output only through `out`, `out_chunk`, `err`, `end`. Never `WRITE`.
- Escape values you interpolate into JSON with `esc`. It handles `\ " CRLF LF CR TAB`
  only; strip other control characters yourself.
- Every line ≤ 255 characters.
- Prohibited (static review refuses the plugin): `CALL 'SYSTEM'`, `EXEC SQL`,
  `INSERT REPORT`, `GENERATE SUBROUTINE POOL`, `CALL FUNCTION … DESTINATION`,
  `SUBMIT … VIA JOB`, dynamic `CALL METHOD (…)`.
- Gated by flag: any DB write or `COMMIT/ROLLBACK WORK` needs
  `ABAP_ALLOW_FLUID_PLUGIN_MUTATE`; any `CALL FUNCTION` needs
  `ABAP_ALLOW_FLUID_CALL_FM`. Either missing refuses the **whole plugin**.

## Enabling — operator step, not yours

Loading happens **once at startup**. A plugin cannot appear mid-session.
The operator sets, in the MCP server env, then restarts the server:

| Variable | Value |
|---|---|
| `ABAP_FLUID_PLUGINS` | comma-separated absolute roots, e.g. `/abs/my-plugins` |
| `ABAP_ALLOW_FLUID_PLUGINS` | `true` — consent to run the ABAP found there |
| `ABAP_ALLOW_FLUID_PLUGIN_MUTATE` | `true` only if a `mutate` action or DB write exists |
| `ABAP_ALLOW_FLUID_CALL_FM` | `true` only if the source contains `CALL FUNCTION` |

Tell the user exactly which of these to set. Both first two are required;
naming a path is not consent. Read-only mode (`ABAP_MODE=read`, a productive
system, or a write lockout) disables the whole fluid API, plugins included.

## Verify after restart

```
abap_fluid(op="list")                              → tool id present
abap_fluid(op="describe", tool="hello")            → schemas as authored
abap_fluid(tool="hello", action="ping", args={})   → round trip; deploys on first call
abap_fluid(op="verify", tool="hello")              → what is actually on the system
```

Objects deploy into `$ABAPSMITH_FLUID_API` on first use; no separate install.
A `mutate` call additionally needs `confirm: "<tool>.<action>"`.

## Refusals

Every load failure names the plugin and path; nothing is skipped silently.
`FLUID_MANIFEST_INVALID` — schema, id, namespace, `entry`, source path, or
action schema. `FLUID_OBJECT_CONFLICT` — object name already claimed by
another tool. `FLUID_PLUGINS_DISABLED` — path set but consent flag off.
`FLUID_PROTOCOL_ERROR` — a line over 255 or a bad frame.
`FLUID_ACTION_FAILED` — your `err` frame at run time.
