# Writing a fluid plugin

## Layout

```text
my-plugins/hello/fluid-plugin.json
my-plugins/hello/abap/zcl_zmcp_x_hello.abap
```

`ABAP_FLUID_PLUGINS=/abs/path/my-plugins` — each immediate subdirectory
of a configured root that contains a `fluid-plugin.json` is one plugin.
`ABAP_FLUID_PLUGINS` is a comma-separated list of such roots.

`ABAP_ALLOW_FLUID_PLUGINS` must also be on before anything loads or
runs. The two variables are deliberately separate: naming a path and
consenting to run the operator ABAP found there are different acts.

See [manifest.md](manifest.md) for the manifest format itself — the
fields, the object model, and a complete JSON example.

## The ABAP body class

```abap
CLASS zcl_zmcp_x_myplug DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run IMPORTING iv_action TYPE string
                                iv_json   TYPE string.
ENDCLASS.

CLASS zcl_zmcp_x_myplug IMPLEMENTATION.
  METHOD run.
    DATA lv_rc TYPE i.
    zcl_zmcp_fluid_rt=>begin( iv_id = 'myplug' iv_action = iv_action ).
    TRY.
        CASE iv_action.
          WHEN 'ping'.
            " args: CALL TRANSFORMATION id SOURCE XML iv_json RESULT DATA = ls_args.
            zcl_zmcp_fluid_rt=>out( '{"pong":true}' ).
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

Rules an author keeps to:

- The entry class is static, and its source must never depend on the
  arguments of any particular call — those arrive only through the
  per-call invoker, at `iv_json`, never baked into the class itself.
- Every line of every object must be 255 characters or fewer.
- Output goes only through `zcl_zmcp_fluid_rt` — `out`, `out_chunk`,
  `err`, `end` — never through `WRITE`. `WRITE` output is not part of
  the framed protocol and is not read as a frame.
- Every object name must be inside the plugin's own
  `ZCL_ZMCP_X_<PLUGINID>` / `ZIF_ZMCP_X_<PLUGINID>` namespace.

## What the loader checks, in order

Validated once at startup, and every failure names the plugin and its
path:

1. `fluid-plugin.json` parses as JSON.
2. The envelope validates against the manifest `zod` schema.
3. `contract` major is known — an unknown major refuses the plugin; an
   unknown minor loads it with a warning.
4. `id` matches `/^[a-z][a-z0-9_]{0,11}$/` and is unique across
   built-ins and plugins together.
5. Every object name is inside the plugin's own namespace.
6. `entry` appears in `objects`.
7. Every `source.file` resolves inside the plugin directory — no `..`,
   no symlink escape. Paths are resolved and compared as real paths,
   so a `..` that happens to resolve back inside the directory is
   still refused.
8. Every action's `input` and `output` schema passes the schema
   validator.
9. The static review finds nothing.

Loading happens once, at startup, and never during a request — a
plugin cannot appear mid-session. Any failure refuses that plugin by
name and path rather than skipping it silently: a silently absent tool
is indistinguishable from a typo'd path. One refused plugin does not
block the others — a good plugin under the same configured root still
loads.

## Testing a plugin

- `abap_fluid(op="describe", tool="hello")` proves the plugin loaded
  and shows its schemas.
- `abap_fluid(tool="hello", action="ping", args={})` proves the round
  trip.
- `abap_fluid(op="verify")` proves what is actually deployed on the
  system.

The repository ships `test/fixtures/fluid-plugins/hello/` as a worked,
loadable example, and `test/fixtures/fluid-plugins/bad-namespace/` as
an example of a plugin the loader refuses.

## A `mutate` action

A `mutate` action needs `ABAP_ALLOW_FLUID_PLUGIN_MUTATE` on, and every
call needs a `confirm` argument echoing exactly `<tool>.<action>`. The
action should declare `targets` — JSON Pointers into the arguments —
so the safety gate judges the real object, package and transport the
call acts on, rather than the invoker class's own harmless URI. See
[safety.md](safety.md) for the full ordering these checks run in.

## What a plugin does not get

The static review is a lint, not a sandbox: it catches a 255-character
overrun and a short list of prohibited constructs in the source text,
nothing more. A plugin runs with the technical user's full SAP
authorisations, exactly as any other ABAP on the system would. The
real controls on what a plugin can do are the SAP authorisation
concept and `ABAP_ALLOW_FLUID_PLUGINS` — not this loader. See
[safety.md](safety.md) for the detail.
