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

## What the runtime's argument reader and output escaper actually parse

`zcl_zmcp_fluid_rt`'s `scan` method is the only way an invoker's JSON
arguments reach `s`, `b`, and `n` inside your `run` method, and it parses
much less than JSON:

- `scan` parses exactly one level: a single top-level `{ ... }` object.
  It never recurses into a nested structure.
- A property whose value starts with `"` is read as a string and stored
  under its own path.
- A property whose value starts with `[` is read as an array of strings
  only, stored as `path/0`, `path/1`, … — `n(path)` counts these by
  matching `path/*`.
- Anything else — a bare number, `true`, `false`, `null`, or a nested
  `{`/`[` — falls into an else-branch that copies the raw text up to the
  next top-level `,` or `}` and stores it verbatim as that key's value.
  A number or boolean still reads back usably as text (`s(path)` returns
  `"42"` or `"true"`, and `b(path)` compares that text against the
  literal `'true'`), but a nested object or array is stored as
  unparsed, unusable text — `scan` has no depth tracking past the outer
  object, so it cannot tell where a nested value ends.

`validateFluidSchema`/`validateAgainstSchema` (`manifest.ts`) accept and
validate arbitrary JSON-Schema nesting before any ABAP runs — that
validator and the ABAP-side scanner are two different pieces of code
with two different limits. A schema that validates cleanly can still
hand your `run` method a value it cannot actually read. Keep an
action's `input` shape flat: top-level string properties and arrays of
strings are the only shapes `scan` reads correctly. Flatten anything
else (a nested object, an array of non-strings) into flat string/array
keys before it reaches the manifest schema.

`esc` — the escaping direction, used by `out`/`out_chunk`/`err` to build
the JSON the framework parses back — is narrower still. It performs
exactly six replacements, in this fixed order: backslash, double quote,
CRLF, a bare newline, a bare carriage return, and horizontal tab. No
other control character (`\b`, `\f`, and every other code point below
`U+0020` not already listed) is escaped or stripped by `esc` — it
passes straight through. A value containing one of these can therefore
produce output a strict JSON parser refuses, even though the ABAP side
successfully called `out`. This is not symmetric with `read_string`
(the argument-reading direction), which does understand `\b`, `\f`, and
`\uXXXX` escapes on the way in.

Practical guidance: build `out`/`err` payloads from data whose shape you
control, and strip or replace control characters below `U+0020` other
than tab/CR/LF before handing a string to `esc` if the source might
contain them — table content, message text, and other data an operator
does not fully control are the likely sources.

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
6. Every object name is unique across every loaded tool, built-in or
   plugin — a different rule from step 5, which only checks that a name
   stays inside its own plugin's namespace. A second tool claiming an
   ABAP object name a tool earlier in load order already claimed is
   refused with `FLUID_OBJECT_CONFLICT`, naming both tool ids.
7. `entry` appears in `objects`.
8. Every `source.file` resolves inside the plugin directory — no `..`,
   no symlink escape. Paths are resolved and compared as real paths,
   so a `..` that happens to resolve back inside the directory is
   still refused.
9. Every action's `input` and `output` schema passes the schema
   validator.
10. The static review finds nothing.
11. The source of every object is scanned for two capability classes,
    after the static review passes: a database-write statement or
    `COMMIT WORK`/`ROLLBACK WORK` needs `ABAP_ALLOW_FLUID_PLUGIN_MUTATE`
    on, and a `CALL FUNCTION` needs `ABAP_ALLOW_FLUID_CALL_FM` on —
    either one missing refuses the *whole plugin*, naming the object,
    file, and line the statement was found on. This is a statement-text
    scan, with the same lint-not-sandbox caveat as the static review
    above (see [safety.md](safety.md)), and it gates the plugin as a
    whole rather than the one action that happens to declare a matching
    `category`.

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
an example of a plugin the loader refuses. `fluid-plugins/nr/` is a
full-size, production-shaped plugin (SAP number ranges, six actions,
read/mutate/execute categories, declared `targets`) that can be enabled
as-is by pointing `ABAP_FLUID_PLUGINS` at `<repo>/fluid-plugins`.
`fluid-plugins/jobs/` is a second full-size shipped plugin (background
jobs, five actions, read and mutate categories, one declared `target`)
enabled the same way.

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
nothing more. The capability scan (loader step 11 above) is the same
kind of lint applied to two more statement classes — a database write,
`COMMIT WORK`/`ROLLBACK WORK`, or `CALL FUNCTION` — gated behind
`ABAP_ALLOW_FLUID_PLUGIN_MUTATE`/`ABAP_ALLOW_FLUID_CALL_FM` rather than
prohibited outright. Neither check runs the code or bounds what it can
do once it runs. A plugin runs with the technical user's full SAP
authorisations, exactly as any other ABAP on the system would. The
real controls on what a plugin can do are the SAP authorisation
concept and `ABAP_ALLOW_FLUID_PLUGINS` — not this loader. See
[safety.md](safety.md) for the detail.
