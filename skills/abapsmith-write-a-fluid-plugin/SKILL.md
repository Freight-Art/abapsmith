---
name: abapsmith-write-a-fluid-plugin
description: Adds a new fluid tool to abapsmith as an operator-installed plugin, without changing abapsmith's source. Use when asked to add, extend, or package a custom fluid tool or action.
---

# Writing a fluid plugin

A plugin is a directory: `<root>/<id>/fluid-plugin.json` plus `.abap` files.
Copy `test/fixtures/fluid-plugins/hello/` and change it. Full reference:
`doc/FLUID-API/authoring.md` and `manifest.md`. You write the files; the
operator enables them.

## What you cannot guess

- The entry class is static and exposes `run( iv_action TYPE string, iv_json TYPE string )`.
  Call arguments arrive only in `iv_json`; never bake them into the source.
- All I/O goes through `zcl_zmcp_fluid_rt`: `begin( iv_id iv_action )`, `scan( iv_json )`,
  then `s( 'key' )` string, `b( 'key' )` bool, `n( 'key' )` array length (items at `key/0`…);
  output with `out( json )` / `out_chunk`, `err( iv_kind iv_step iv_text )`, `end( rc )`.
  Never `WRITE`. Escape interpolated values with `esc`, which handles only `\ " CRLF LF CR TAB`.
- `scan` reads **one flat level**: top-level strings and arrays of strings. A nested object
  passes the TypeScript schema check and arrives as unusable text. Keep `input` flat.
- Every object name must be `ZCL_ZMCP_X_<ID>*` or `ZIF_ZMCP_X_<ID>*`; `id` matches
  `/^[a-z][a-z0-9_]{0,11}$/` and is unique across built-ins and plugins.
- Lines ≤ 255 characters. `objects[].description` ≤ 60 characters. Types `CLAS/OC`, `INTF/OI`.
- `category` is `read`, `execute` or `mutate`. A `mutate` action should declare `targets`
  (JSON Pointers into its args: `object`, `package`, `transport`); without them nothing is
  gate-asserted. Each `mutate` call needs `confirm: "<tool>.<action>"`.
- Refused outright by static review: `CALL 'SYSTEM'`, `EXEC SQL`, `INSERT REPORT`,
  `GENERATE SUBROUTINE POOL`, `CALL FUNCTION … DESTINATION`, `SUBMIT … VIA JOB`,
  dynamic `CALL METHOD (…)`.
- Refused unless flagged: a DB write or `COMMIT/ROLLBACK WORK` needs
  `ABAP_ALLOW_FLUID_PLUGIN_MUTATE`; any `CALL FUNCTION` needs `ABAP_ALLOW_FLUID_CALL_FM`.
  A missing flag refuses the **whole plugin**, naming the line.

## Enabling is the operator's step

Plugins load **once at startup**; none can appear mid-session. Tell the user to set these in
the MCP server env and restart it:

| Variable | Value |
|---|---|
| `ABAP_FLUID_PLUGINS` | comma-separated absolute roots |
| `ABAP_ALLOW_FLUID_PLUGINS` | `true` — consent; a path alone is not consent |
| `ABAP_ALLOW_FLUID_PLUGIN_MUTATE` / `ABAP_ALLOW_FLUID_CALL_FM` | only if the plugin needs them |

Then `abap_fluid(op="describe", tool="<id>")` proves it loaded, a first `run` deploys the
objects into `$ABAPSMITH_FLUID_API`, and `op="verify"` shows what is on the system. Load
failures are reported by name and path, never skipped: `FLUID_MANIFEST_INVALID`,
`FLUID_OBJECT_CONFLICT` (name already claimed), `FLUID_PLUGINS_DISABLED` (consent off).

`abap_fluid` exists on the default v1 surface only; v2 (`abap_do`) has no fluid entry point.
Read-only mode or a productive system disables the whole fluid API, plugins included.
