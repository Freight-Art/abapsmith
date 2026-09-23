# Why the v2 tool surface was removed

Why some decisions look odd from the outside. This entry states what was
tried, what it measured, and what decided against it. See also [API surface
and data integrity](api-and-data-integrity.md) for the schema-size argument
that motivated trying it in the first place.

## What v2 was

`ABAP_TOOL_SURFACE=v2` was an opt-in alternative MCP tool surface: six
consolidated tools in place of v1's roughly twenty-two narrow ones, each one
per operation. Exactly one surface was ever registered per process — v2
reused several v1 tool names verbatim, so registering both would have thrown
at startup on a duplicate-tool error.

| v1 tool (examples) | v2 route |
|---|---|
| `abap_search` | `abap_find` |
| `abap_read`, `abap_bopf` (read side), `abap_fpm_read` (read side) | `abap_read` (`view: source \| method \| outline \| contract \| metadata \| bopf \| fpm`) |
| `abap_write` | `abap_write` (splice, method replace, source rewrite, delete, `dry_run`) |
| `abap_activate`, `abap_run`, `abap_test`, `abap_journal`, `abap_transport`, `abap_transport_release`, `abap_enh`, `abap_bopf_edit`, `abap_bopf_delete`, `abap_bopf_test` | `abap_do` (verb-shaped: activate/check/run/test, journal list/show/undo, transport lifecycle, BOPF model edits, enhancement/BAdI operations) |
| `abap_debug`, `abap_debug_vars`, `abap_debug_value` | `abap_debug` (start/step/stack/frame/vars/value/keepalive/stop/status) |
| *(none — new in v2)* | `abap_adt` (raw ADT REST escape hatch, GET-only) |

`abap_write` was registered only in `edit`/`admin` mode, so a `read`-mode v2
server exposed five tools, not six.

## Why it existed

Tool count is a real cost: every schema is resent with every `tools/list`
call, and it competes with the ABAP source a caller actually wants in
context. Measured on real `tools/list` payloads, the combined v2 schema was
87.6% smaller than the twenty-some-tool surface it replaced. That reduction
was the entire argument for building it.

## What the A/B actually measured

A live paired A/B ran the two surfaces against statistically identical
successful work — the same tasks, completed either way. It measured v2 at
+6.6% more expensive and +142% more tool errors than v1, for that same
successful work. The schema-size saving did not translate into cheaper or
more reliable sessions; a smaller `tools/list` payload was outweighed by more
retries and wrong calls on the write and object-type-resolution paths. This
is one A/B run, not a repeated series, and the two figures are its result,
not a general law about consolidated schemas.

## Why it was removed

v2 never reached v1's reliability, and the way it was operated meant it
never had a path to close that gap. The surface was frozen by policy — no
new tool routes, no defect fixes — so known defects (an error envelope that
dropped failure detail, a search schema overclaiming free-text search, hint
text naming v1-only tools a v2 client could not call) went unrepaired for as
long as v2 existed. Four v1 tools never had a v2 route at all —
`abap_data_preview`, `abap_open_url`, `abap_dumps`, `abap_ui` — and every v1
tool added after v2 shipped (`abap_atc`, `abap_quick_fix`, `abap_img`,
`abap_img_edit`, `abap_fluid`, `abap_service`) widened that gap further,
since each one landed only on v1. A hand-maintained parallel surface loses
to the one that keeps getting the new work, and a frozen surface with a
measured reliability deficit had no route back to parity.

## What survived, and what was dropped on purpose

`abap_debug action="frame"` — moving the read cursor to a different stack
frame — was v2's one genuinely new capability. It was ported to v1's
`abap_debug` rather than lost, so removing v2 cost nothing here. The edit
primitive that v1's `abap_write` uses for targeted string splices lived at
`src/tools/v2/edit.ts` despite the path — it was never part of the v2
surface — and now lives at `src/tools/edit.ts`.

Two things were dropped rather than ported. `abap_adt`, the raw ADT REST
escape hatch, was deliberately not carried into v1: v1's tools already cover
its GET-only use cases through typed operations, and a bare-path escape
hatch is exactly the kind of surface the safety gate cannot reason about (no
way to authorize a mutation against an arbitrary path). `abap_read
view="contract"` also existed only on v2, with no v1 equivalent.

That second drop left `src/bin/contract.ts`, its `@abaplint/core`
dependency and the second `scripts/bundle.mjs` entry point without a caller;
#229 removed all three.

## What a future consolidation must prove before it is attempted again

Schema size alone is not sufficient justification, based on this result. A
future attempt at a consolidated surface should not proceed without:

- A route for every currently shipped tool, each with a test proving parity
  with its v1 (narrow-tool) behavior — not just coverage of the tools that
  existed when the consolidation was designed.
- Routes derived mechanically from the same registrars that produce the
  narrow surface, rather than hand-maintained in a second location — so that
  adding a new tool cannot silently skip the consolidated surface the way
  six tools added after v2 shipped did.
- A measured error rate no worse than the narrow surface's, on the same task
  set, not merely a smaller `tools/list` payload. Schema size is an input to
  cost and reliability, not a proxy for either.
- A migration story that does not reuse existing tool names. v2 reused v1's
  names verbatim, which is why the two surfaces could never be registered in
  the same process — a design that forecloses running both side by side
  forecloses measuring one against the other without a hard cutover.
