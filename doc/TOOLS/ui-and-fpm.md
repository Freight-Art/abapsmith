# UI & FPM

## abap_fpm_read

Read FPM/FBI (Floorplan Manager) configuration: find configs, or read one's
node tree / full UIBB hierarchy / enqueue locks.

**Availability**: case 1 — registered only when `canWrite`. Every mode
deploys ABAP in order to read, so the tool needs write capability just to
register/function, even though nothing it does changes business data. What
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

**Availability**: case 1 — registered only when `canWrite`. `mode=press`
additionally needs `ABAP_MODE=admin` **and** `ABAP_ALLOW_UI_PRESS=true`,
checked at call time (not at registration). `mode=screen` dispatches
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

Each `screens[]` entry: `program` (string, required), `dynpro` (string,
required, e.g. `"100"` — padded to 4 digits automatically), `okcode`
(string, optional, e.g. `"=ENTR"` or `"/00"`), `cursorField` (string,
optional), `fields` (array of `{name, value}`, optional — screen field name
and value, max 132 chars each).

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

