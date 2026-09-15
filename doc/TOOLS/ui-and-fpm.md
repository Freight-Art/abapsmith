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
| `mode` | enum `find` \| `outline` \| `app` \| `locks` \| `events` | yes | — | `find`: search configs. `outline`: one config's node tree. `app`: an application config's full UIBB hierarchy. `locks`: who holds enqueue locks on a config. `events`: trace toolbar buttons to the handler code, from saved configuration only. |
| `config_id` | string (max 32) | required for `outline`/`app`/`locks`/`events` | — | Configuration ID. |
| `config_type` | string (NUMC2) | no | `"00"` | `00`=component, `02`=application. |
| `config_var` | string (max 6) | no | (blank) | Variant. |
| `component` | string | `find` only | — | Filter by Web Dynpro component. |
| `query` | string | `find` only | — | Config ID pattern, `*` wildcard. |
| `package` | string | `find` only | — | Filter by package. |
| `uibb` | string | `events` only | — | Restrict tracing to one UIBB, by its configuration ID. Omit to trace every UIBB in the config. |
| `resolve` | boolean | `app`/`events` only | `true` | `app`: expand each UIBB's feeder/BOPF binding. `events`: resolve each toolbar event to its handler (`bopf`/`feeder`/`app_controller`/`standard`/`unresolved`) instead of reporting the raw event wiring only. |
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

`mode: "events"` traces FPM/FBI toolbar buttons to the code that handles
them, from saved configuration only — nothing is executed. Per event it
reports: the source UIBB (config ID, kind, feeder class), the toolbar
element (ID, text, type — button / toggle button / button choice / link to
action), the event ID, and the resolved handler: `bopf` (BO, node, action,
plus the exact `abap_bopf` call to open it), `feeder` (feeder class and
method, plus the exact `abap_read` call), `app_controller` (the application
controller class, plus the exact `abap_read` call), `standard` (a
`CL_FPM_EVENT` `GC_EVENT_*` constant handled by the floorplan itself), or
`unresolved` (a reason plus the raw XML excerpt of the element that was not
understood). It also decodes the application controller from the
application/OVP config, the wires between UIBBs (source, target, connector
class), and each FBI view's BO and node.

`events` discloses four coverage limits on **every** response, because none
of them can be resolved from configuration alone: an application-controller
override can intercept or replace any event listed; personalisation can
rebind toolbar elements at run time; context-based adaptation (CBA) and
configuration deltas are not resolved; and nothing is executed, so no
run-time event is observed. Toolbar `TEXT` values are often a bare number —
a key into `WDY_CONFIG_DATT`/`WDY_CONFIG_APPT` — and this mode does not
resolve them, and says so.

`events` is gated exactly like the other `abap_fpm_read` modes: it needs
`canWrite` because it deploys `ZCL_ZMCP_FLUID_FPM` into
`$ABAPSMITH_FLUID_API`, is absent under `ABAP_MODE=read`, and refuses
`FLUID_API_DISABLED` with `ABAP_FLUID_API=false`. **This mode is unverified
against a live system**: it has not yet been run against a live SAP server.

Example (trace a config's toolbar events):

```json
{ "mode": "events", "config_id": "/BOFU/TEST_FBI_SALES_ORDER_OVP", "config_type": "00" }
```

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
and `mode=press` both stay registered but refuse at call time. `mode=fcode`
is gated exactly like `mode=screen` — it needs `canWrite` only because it
deploys `ZCL_ZMCP_FLUID_UI` into `$ABAPSMITH_FLUID_API`, and it too refuses
`FLUID_API_DISABLED` with `ABAP_FLUID_API=false`.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `mode` | enum `screen` \| `press` \| `fcode` | yes | — | `screen`: read one dynpro (discovery, read-only in effect). `press`: run a batch-input script — commits, cannot be rolled back. `fcode`: trace a classic dynpro function code to the ABAP that handles it, by static analysis only — read-only in effect, executes nothing. |
| `tcode` | string | `screen`: alternative to program+dynpro; `press`: required; `fcode`: alternative to program+dynpro | — | Transaction code. |
| `program` | string | `screen`/`fcode` only, with `dynpro` | — | Program name instead of `tcode`. |
| `dynpro` | string | `screen`/`fcode` only, with `program` | — | Screen number, e.g. `"100"`. |
| `fcode` | string | `fcode` only, optional | (all) | One function code to trace. Omitted means every function code of every GUI status of the program. |
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

**`fcode` must never be confused with `press`.** `fcode` executes nothing —
no `CALL TRANSACTION`, no batch input, no commit — so it needs no `confirm`
and needs neither `ABAP_MODE=admin` nor `ABAP_ALLOW_UI_PRESS`. It is gated
exactly like `mode=screen` (`canWrite`, because it deploys `ZCL_ZMCP_FLUID_UI`
into `$ABAPSMITH_FLUID_API`). `press`, by contrast, commits business data
immediately with no dry run, and needs `ABAP_MODE=admin` **and**
`ABAP_ALLOW_UI_PRESS=true` **and** `confirm:true` — three separate gates
checked at call time, not at registration.

Per function code, `fcode` reports: the GUI status(es) it appears in and its
button text; the PAI modules in flow-logic order with `AT EXIT-COMMAND`
flagged; for each module, the include and line range where it is
implemented; and inside that module, the `WHEN` branch(es) whose literal(s)
match, with their line range and the first outgoing calls (`PERFORM`,
`CALL FUNCTION`, `CALL METHOD`/`->`, `CALL TRANSACTION`,
`LEAVE TO TRANSACTION`, `SUBMIT`). Every hit carries the exact `abap_read`
call (object, offset, limit). A `CASE` on something other than the OK-code
field — or a lookup-table / dynamic dispatch — is reported as `unresolved`,
naming the module and include; it never silently falls through.

The module/include resolution goes through `D010INC` plus a `READ REPORT`
scan of each include it finds there, not a source scan of the main program:
observed live on A4H (2026-09-15, with the tools shipped before this mode
existed — see `skills/abapsmith-research-code/SKILL.md`'s live transcript),
`abap_search {"mode":"source","query":"MODULE action.","objects":"SAPMSVMA","types":["PROG"]}`
scanned only the module pool itself (`includesScanned: 1`) and did not
follow its `INCLUDE` statements — those are separate `PROG/I` objects, found
by reading `D010INC` for the program (`MASTER = SAPMSVMA` returned 13 rows on
A4H, of which only two, `MSVMAF01` and `MSVMAO01`, were real includes; the
rest were generated entries such as `%_CABAP`, `<SYSINI>`, and
`CX_ROOT=======================CU`, which `fcode`'s own `D010INC` scan must
filter out the same way). **`fcode` is unverified against a live system**:
it has not yet been run against a live SAP server.

Example (read a screen):

```json
{ "mode": "screen", "tcode": "ZDEMO_ORDER01" }
```

Example (trace a function code):

```json
{ "mode": "fcode", "program": "SAPMSVMA", "dynpro": "100", "fcode": "BACK" }
```

