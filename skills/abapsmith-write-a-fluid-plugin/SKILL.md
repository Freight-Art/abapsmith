---
name: abapsmith-write-a-fluid-plugin
description: Adds a new fluid tool to abapsmith as an operator-installed plugin, without changing abapsmith's source. Use when asked to add, extend, or package a custom fluid tool or action.
---

# Writing a fluid plugin

A plugin is one directory the operator points abapsmith at. It becomes a
tool under `abap_fluid` with no MCP registration. You write the files, the
operator enables them, then you verify.

```
1 choose id/actions → 2 manifest → 3 body class → 4 check on the system → 5 self-check → 6 hand off → 7 verify
```

## 1. Choose the id and the actions

- `id`: `/^[a-z][a-z0-9_]{0,11}$/`, unique across built-ins (`classic core enh fpm img rt run ui`)
  and other plugins.
- One action per thing the caller can ask for. `category` is `read`, `execute` or `mutate`.
  `mutate` is anything that writes to the database or commits.
- Input shape must be **flat**: top-level strings and arrays of strings only. The ABAP-side
  argument reader parses one level; a nested object passes the TypeScript schema check and
  arrives in ABAP as unusable text. Flatten before it reaches the schema.

## 2. Write `<root>/<id>/fluid-plugin.json`

Start from `test/fixtures/fluid-plugins/hello/fluid-plugin.json`; the format is in
`doc/FLUID-API/manifest.md`. Non-obvious constraints:

- `contract` is `"1.0"`.
- `objects[]` is deploy order. Types `CLAS/OC` or `INTF/OI` only. `description` ≤ 60 characters.
- Every object name must be `ZCL_ZMCP_X_<ID>*` or `ZIF_ZMCP_X_<ID>*`. Anything else is refused.
- `entry` names the class the invoker calls; it must be in `objects`.
- A `mutate` action should declare `targets` — JSON Pointers into its own args naming
  `object`, `package`, `transport` — so the safety gate judges the real target. Without
  `targets` the action is not gate-asserted at all.

## 3. Write the body class

Start from `test/fixtures/fluid-plugins/hello/abap/zcl_zmcp_x_hello.abap`. The contract the
framework expects, which is not standard ABAP:

- The entry class is static with `CLASS-METHODS run IMPORTING iv_action TYPE string iv_json TYPE string`.
  Its source never depends on a call's arguments; those arrive only in `iv_json`.
- Frame every run with `zcl_zmcp_fluid_rt=>begin( iv_id = '<id>' iv_action = iv_action )` first and
  `zcl_zmcp_fluid_rt=>end( lv_rc )` last, `rc` 0 on success.
- Read arguments with `zcl_zmcp_fluid_rt=>scan( iv_json )`, then `s( 'key' )` for a string,
  `b( 'key' )` for a boolean, `n( 'key' )` for an array length with items at `key/0`, `key/1`, …
- Emit results only with `out( '<json>' )` or `out_chunk`; report failure with
  `err( iv_kind = 'exception' iv_step = '<step>' iv_text = '<text>' )` and a non-zero rc.
  `WRITE` output is not read as a frame.
- Escape values you interpolate into JSON with `esc( )`. It handles only backslash, quote,
  CRLF, LF, CR and tab; strip other control characters yourself.
- Every line ≤ 255 characters.
- Never `COMMIT WORK` in the body. The invoker commits after a `mutate` action and rolls back
  when `rc` is non-zero; an `execute` action's database changes persist only with the request's
  implicit commit. Do not claim otherwise in a manifest description.

## 4. Syntax-check a scratch copy before the class is finished

Plugins deploy only through the server, so check the source yourself: rename the class to
`ZCL_<SOMETHING>_CHK`, `abap_write` it into `$TMP`, `abap_activate`, fix, repeat — after the first
method, not after the last. Delete the scratch class before handing off. The ABAP traps that
pass this check and fail at run time are in `abapsmith-write-abap-source`.

## 5. Self-check against the loader before handing off

The loader refuses the whole plugin, naming the file and line, on any of these:

- A prohibited statement: `CALL 'SYSTEM'`, `EXEC SQL`, `INSERT REPORT`, `GENERATE SUBROUTINE POOL`,
  `CALL FUNCTION … DESTINATION`, `SUBMIT … VIA JOB`, dynamic `CALL METHOD (…)`.
- A DB write or `COMMIT WORK`/`ROLLBACK WORK` without `ABAP_ALLOW_FLUID_PLUGIN_MUTATE` on.
- Any `CALL FUNCTION` without `ABAP_ALLOW_FLUID_CALL_FM` on.
- An object name colliding with one another loaded tool already claims (`FLUID_OBJECT_CONFLICT`).
- A `source.file` that resolves outside the plugin directory.

Note which of the two flags the plugin needs; step 6 must ask for them.

## 6. Hand off to the operator — you cannot enable it

Plugins load **once at server startup**, never mid-session. Tell the user to set these in the
MCP server's env and restart it:

| Variable | Value |
|---|---|
| `ABAP_FLUID_PLUGINS` | comma-separated absolute roots; each subdirectory with a `fluid-plugin.json` is one plugin |
| `ABAP_ALLOW_FLUID_PLUGINS` | `true` — consent to run the ABAP there; the path alone is not consent |
| `ABAP_ALLOW_FLUID_PLUGIN_MUTATE` | `true` if step 5 found a DB write or commit, or any action is `mutate` (the gate checks it per call) |
| `ABAP_ALLOW_FLUID_CALL_FM` | `true` only if step 5 found `CALL FUNCTION` |

Read-only mode or a productive system disables the fluid API entirely, plugins included.
`abap_fluid` is abapsmith's single entry point to the fluid API — functions
that only work by installing generated ABAP into `$ABAPSMITH_FLUID_API` —
and even its read-shaped ops (`list`, `describe`, `status`, `verify`) need
write access to exist at all: the whole tool is absent from `tools/list`
under `ABAP_MODE=read`, and it refuses `FLUID_API_DISABLED` again if a
system that started writable later proves productive or trips the write
lockout. See `doc/TOOLS/abap-fluid.md`.

## 7. Verify after the restart

1. `abap_fluid(op="list")` — the id is present. If not, the same output lists it under
   `refused[]` with path, error code and reason. Then `op="describe", tool="<id>"` to confirm
   the schemas match what you wrote.
2. `abap_fluid(tool="<id>", action="<read action>", args={…})` — first call deploys the objects
   into `$ABAPSMITH_FLUID_API`, then runs. A `mutate` call also needs `confirm: "<id>.<action>"`.
3. `abap_fluid(op="verify", tool="<id>")` — what is actually on the system.

Any source change after the restart needs another restart: `op="repair"` re-deploys the loaded
version only. Batch every fix from one verify round, syntax-check them as in step 4, then ask
for one restart.

`FLUID_PLUGINS_DISABLED` means the path is set but consent is off. `FLUID_ACTION_FAILED` is
your own `err` frame; the text is what you passed.
