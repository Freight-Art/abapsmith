# UI & FPM

## abap_fpm_read

Read FPM/FBI (Floorplan Manager) configuration: find configs, or read one's
node tree / full UIBB hierarchy / enqueue locks.

**Availability**: the real, functional tool needs `canWrite`. Every mode
deploys ABAP in order to read, so the tool needs write capability just to
function, even though nothing it does changes business data — but without
`canWrite`, a read-only v1 server registers a mode-locked refusal stub
under the same name rather than skipping registration (case 4 in
[availability-and-capabilities.md](availability-and-capabilities.md)).
What
it deploys differs by mode: `find`/`outline`/`app` run through the fluid API
(`ZCL_ZMCP_FLUID_FPM` plus a content-addressed invoker in
`$ABAPSMITH_FLUID_API`, both reused across calls), while `locks` still
generates a throwaway classrun bridge class per call. The write requirement
is the same either way — it is the deploy, not the mechanism, that demands
it. With `ABAP_FLUID_API=false` the tool stays registered but every mode
refuses at call time with `FLUID_API_DISABLED`, since all of them deploy.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `mode` | enum `find` \| `outline` \| `app` \| `locks` | yes | — | `find`: search configs. `outline`: one config's node tree. `app`: an application config's full UIBB hierarchy. `locks`: who holds enqueue locks on a config. |
| `config_id` | string (max 32) | required for `outline`/`app`/`locks` | — | Configuration ID. |
| `config_type` | string (NUMC2) | no | `"00"` | `00`=component, `02`=application. |
| `config_var` | string (max 6) | no | (blank) | Variant. |
| `component` | string | `find` only | — | Filter by Web Dynpro component. |
| `query` | string | `find` only | — | Config ID pattern, `*` wildcard. |
| `package` | string | `find` only | — | Filter by package. |
| `resolve` | boolean | `app` only | `true` | Expand each UIBB's feeder/BOPF binding. |
| `detail` | enum `compact` \| `full` | no | `"compact"` | Applies to `find`/`app` only. `find`: hoists columns constant across every row into the header instead of repeating them. `app`: omits per-node XML excerpts. Ignored by `outline` and `locks` (already compact). |
| `xml_offset` | integer | no | `0` | `outline` only. 0-based char offset into the XML to start from. |
| `xml_limit` | integer | no | (unbounded) | `outline` only. Max XML chars to return from `xml_offset`. |

Notes: `detail` is render-side only — it never reaches the ABAP query or the
name of the class deployed to run it, so `compact` and `full` cost the same
SAP round trips and never create a second generated class. That is worth
stating precisely, because the fluid invoker `find`/`outline`/`app` now run
through is content-addressed over `{tool, action, args, contract}`: a
parameter that *did* reach the arguments would fork a second invoker class,
and `detail` deliberately does not. It buys a cheaper *response*, not a
cheaper *call*. `mode: "outline"`
and `mode: "locks"` ignore `detail` and say so in a note if it was passed
explicitly.

`xml_offset`/`xml_limit` are the `outline` analogue: also render-side only,
also never reaching the ABAP call. Unlike `detail`, the default (neither
passed) returns the full verbatim XML unchanged — windowing is opt-in. When
a window is applied, the header always reports the *full* `xmlChars`
alongside the window actually returned and the next offset to ask for, so a
bounded read can never be mistaken for the whole document. If the full XML
is returned unwindowed and is large enough to be worth knowing about, a
one-line note names `xml_offset`/`xml_limit` as the lever — paid only on
that call, not on every session's tool schema.

The saving is not uniform across modes: `app` compacts the most, because the
per-node XML excerpts dominate its full payload; `find` compacts the least,
because after compaction most of what remains is already the minimum a
caller needs — one `config_id`/`description` pair per matching row. Every
call is slow regardless of `detail` or `mode`, because reading this data
means deploying, activating and running ABAP. The first call for a given
query is markedly slower than a warm one, and for `find`/`outline`/`app` that
is now a property of the fluid invoker rather than of a per-call bridge: the
invoker is named from a hash of the arguments, so an identical query reuses
an already-activated class and a changed one pays the cold cost again.
`locks`, still on a per-call bridge, pays it every time. Because
`find`'s cost tracks the number of matches rather than the response format,
compact mode does not rescue an unnarrowed query — narrow with
`config_id`/`component`/`package` instead.

## abap_ui

Drive classic dynpro screens via batch input: read a screen's fields/flow
logic/GUI status, or run a scripted transaction.

**Availability**: the real, functional tool needs `canWrite`; without it,
a read-only v1 server registers a mode-locked refusal stub under the same
name instead of skipping registration (case 4 in
[availability-and-capabilities.md](availability-and-capabilities.md)).
`mode=press` additionally needs `ABAP_MODE=admin` **and**
`ABAP_ALLOW_UI_PRESS=true`, checked at call time (not at registration).
`mode=screen` dispatches
through the fluid API's `ui` tool (static body class `ZCL_ZMCP_FLUID_UI`,
action `screen`, plus a content-addressed invoker); `mode=press` still
deploys a per-call generated bridge class. Both are gated on the same
`FLUID_API_DISABLED` refusal, so with `ABAP_FLUID_API=false` `mode=screen`
and `mode=press` both stay registered but refuse at call time.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `mode` | enum `screen` \| `press` | yes | — | `screen`: read one dynpro (discovery, read-only in effect). `press`: run a batch-input script — commits, cannot be rolled back. |
| `tcode` | string | `screen`: alternative to program+dynpro; `press`: required | — | Transaction code. |
| `program` | string | `screen` only, with `dynpro` | — | Program name instead of `tcode`. |
| `dynpro` | string | `screen` only, with `program` | — | Screen number, e.g. `"100"`. |
| `screens` | array of screen-script objects | required for `press` | — | Ordered batch-input script, one entry per dynpro the transaction shows in sequence. |
| `confirm` | boolean | required (must be exactly `true`) for `press` | — | Explicit acknowledgment that `press` commits business data immediately with no dry run. |
| `layout` | boolean | no | `false` | `screen` only. Also render a monospace picture of the screen from the field rows already read. No extra ABAP, no change to the generated bridge class, no extra round trip. Ignored by `mode=press`. |

Each `screens[]` entry: `program` (string, required), `dynpro` (string,
required, e.g. `"100"` — padded to 4 digits automatically), `okcode`
(string, optional, e.g. `"=ENTR"` or `"/00"`), `cursorField` (string,
optional), `fields` (array of `{name, value}`, optional — screen field name
and value, max 132 chars each).

### layout

With `layout: true` on `mode=screen`, the response also carries a monospace
picture of the screen. It is built client-side from the same field rows
`RPY_DYNPRO_READ` already returned, at each element's `D021S` line/column —
nothing extra is deployed or fetched to build it:

- Text and labels are drawn as their text at that position.
- An input-capable field is a run of underscores as wide as the field, e.g.
  `KUNNR ________________`; an output-only field is a run of dots instead.
- A checkbox is `[ ]`, a radio button is `( )`, a pushbutton is `[ Text ]`.
- A frame is a box of `+`/`-`/`|` with its title on the top edge.
- A subscreen area is a labelled box, `[subscreen: AREA_NAME]`, sized to its
  width.
- A table control is a labelled box, `[table control: TC_NAME]`, with one
  header row of its column names.
- A tabstrip is rendered as its tab titles on a single line.
- An element whose type this renderer does not recognise is still drawn,
  never dropped — as `?NAME?` at its position.

Below the grid, a `Buttons` line lists the GUI status's function keys from
`fkeys`, grouped by status:

```
Buttons (STATUS): Execute (ONLI), Cancel (ECAN)
```

Screen height and width come from the `RPY_DYHEAD` header (`lines`,
`columns`). If the grid would exceed the response cap it is cut, and the
cut is marked, the same as any other truncation in this server.

Illustration only, not a captured screen:

```
Customer   ________________________
[ ] Include archived orders
[ Execute ]

Buttons (STATUS_ONLI): Execute (ONLI), Cancel (ECAN)
```

**Fidelity**: this is the design-time layout stored in `RPY_DYNPRO_READ`
(`D021S`), not a runtime screenshot. Text that PBO logic fills in, dynamic
`MODIFY SCREEN` attributes, table-control column widths, and
subscreen/step-loop heights are not present in `D021S` at all, so none of
them are reflected. Positions are approximate; an element that would
overlap another already placed is shifted right to stay visible rather than
drawn on top of it.

Known limitations, established from live captures on A4H — `SAPMSYST`
dynpro `0020` (hand-painted) and a `$TMP` probe report with a generated
selection screen:

- On a generated selection screen, the label text is not in `D021S` at
  all: `D021S-STXT` holds a run of underscores, and the real text is
  filled at PBO from the text pool. Selection-screen labels therefore
  render as the field name in `?NAME?` form, or as a blank run — not as
  their real text. Labels on a hand-painted dynpro, such as `SAPMSYST`
  `0020`, do carry their text.
- `D021S-STXT` stores blanks as underscores, so a genuine underscore
  inside a label is indistinguishable from a space.
- `D021S` carries no height for a frame, a subscreen area, or a step
  loop. A frame's box is drawn down to the line before the next frame, or
  to the last occupied line if there is no next frame — that is an
  inference, not a stored value.
- Table-control column widths are not stored either; the header row is
  drawn with the column titles separated by `|`.

Verification: the `D021S` attribute names, the hexadecimal encoding of its
`RAW(1)` columns, and the element-kind vocabulary were pinned by live
captures on A4H; the rendered picture itself is produced client-side and is
covered by unit tests over those captures, but it has not been compared
against a running SAP GUI screenshot.

Notes: `press` refuses a transaction whose TSTC-CINFO marks it a report
transaction (`'80'`) rather than a dialog transaction (`'00'`) — use
`abap_run` for those instead. `press` has no dry run — `confirm:true` is the
only gate, and it still requires the two server-level flags above. Build a
script iteratively:
call `screen` to see the current fields/status, `press` one step, then
`screen` again. When a script runs out of screens (`sy-subrc=1001`, message
`00 344`), the response names the exact `screen` call that resolves it.

Example (read a screen):

```json
{ "mode": "screen", "tcode": "ZDEMO_ORDER01" }
```

Example (read a screen with the rendered layout):

```json
{ "mode": "screen", "tcode": "ZDEMO_ORDER01", "layout": true }
```

