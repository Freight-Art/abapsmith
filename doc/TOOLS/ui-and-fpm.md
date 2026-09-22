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
| `resolve` | boolean | `app`/`events` only | `true` | `app`: expand each UIBB's feeder/BOPF binding. `events`: resolve each toolbar event to its handler (`bopf`/`feeder`/`app_controller`/`standard`/`action_impl`/`unresolved`) instead of reporting the raw event wiring only. |
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

`find` rows carry `loadable` (`yes`/`no`), `app_config_id` (the id
`mode=app` accepts — empty when none exists), `component_config_id` and
`reason` (why a row is not loadable). `find`'s default `config_type` `"00"`
lists component configurations (`WDY_CONFIG_DATA`); `mode=app` loads
application configurations (`config_type` `"02"`, `WDY_CONFIG_APPL`). For a
type-02 row the bridge reads the configuration XML and reports the
component and component configuration it references, and checks that this
component configuration exists; for a type-00 row it checks whether an
application configuration with the same id exists. This costs one extra
SELECT per row (plus the XML read for a type-02 row). In compact detail a
column that is constant across all rows (`loadable=yes`, say) hoists into
the `allRows` header line like any other constant column.

`mode=app` accepts either id. When the given id fails to load as an
application configuration, the bridge's internal `resolve` action looks it
up in both `WDY_CONFIG_APPL` and `WDY_CONFIG_DATA` and lists the
application configurations whose XML references it (capped at 20). With
exactly one candidate, the app is loaded from it and the response header
carries `config_id` (the id actually loaded) and `resolvedFrom` (the id
given), with a note explaining the substitution. Otherwise the call fails
`NOT_FOUND`, with `details`: `tried` (the id, `config_type` `"02"`, table),
`existsAsApp`, `existsAsComponent`, `component`, `applicationConfigs`,
`applicationConfigsTruncated`, the original exception frames, and a hint
naming the candidate ids (or, with none, pointing to `mode=find
config_type="02"`). The `app` happy path is still one bridge call; a
resolution failure adds up to two more.

`mode: "locks"` is scoped to one FPM config's own enqueue object and always
requires `config_id`; it was not widened into a generic lock lookup. For
enqueue locks on anything else — a table, a repository object, a user —
`core.locks` (`abap_fluid`) is the generic view: it takes `object`/`table`/
`user` filters (at least one is required) instead of a `config_id`, and its
renderer is not FPM-specific. This is a deliberate split, not an oversight:
`mode: "locks"` stays FPM-specific and keeps `config_id`, and the generic
enqueue read lives only in `core.locks` — see `doc/TOOLS/abap-fluid.md`.

`mode: "events"` traces FPM/FBI toolbar buttons to the code that handles
them, from saved configuration only — nothing is executed. It prints a
VIEWS section between the header and WIRES, one row per UIBB named in the
config, columns `config_id`, `kind`, `feeder_class`, `bo`, `node` — a blank
cell means the configuration names nothing there, not that resolution
failed (an application-controller config or an `FPM_TABBED_UIBB` wrapper,
for example, carries no feeder and no BO/node). Per event it reports, as
EVENTS table columns `config_id`, `kind`, `feeder_class`, `source`,
`element_id`, `text`, `text_key`, `event_id`, `handler`, `detail`: the
source UIBB (config ID, kind, feeder class), the toolbar
element (ID, text, type — button / toggle button / button choice / link to
action), the event ID, and the resolved handler: `bopf` (BO, plus the node
and action it resolved against `/BOBF/OBM_NODE`/`/BOBF/ACT_LIST` when
`resolve:true` — either may come back unconfirmed with a note, and for an
FBI framework event such as `FBI_CREATE`/`FBI_DELETE` the action comes back
unresolved on principle, because the FBI connector maps it internally and
it never appears in `/BOBF/ACT_LIST` or anywhere else in configuration —
and the exact `abap_bopf` call to open the BO), `feeder` (feeder class, plus the
interface-qualified `PROCESS_EVENT` method — e.g.
`IF_FPM_GUIBB_LIST~PROCESS_EVENT` — when the component's GUIBB kind is a
confirmed one, and the exact `abap_read` call to open it), `app_controller`
(the application controller class, plus the exact `abap_read` call),
`standard` (a `CL_FPM_EVENT` `GC_EVENT_*` constant handled by the floorplan
itself), `action_impl` (the ABAP class named in an FBI action's
`ACTION_IMPL`, used when its `ACTION_CONF` is absent or names a config that
was never read), or `unresolved` (a reason plus the raw XML excerpt of the
element that was not understood). It also decodes the application
controller from the application/OVP config and the wires between UIBBs
(source, target, connector class).

`events` discloses four coverage limits on **every** response, because none
of them can be resolved from configuration alone: an application-controller
override can intercept or replace any event listed; personalisation can
rebind toolbar elements at run time; context-based adaptation (CBA) and
configuration deltas are not resolved; and nothing is executed, so no
run-time event is observed. Toolbar/action `TEXT` values marked `Transl="true"`
are keys into `WDY_CONFIG_COMPT`, not labels — confirmed live on A4H via
`abap_data_preview` against `WDY_CONFIG_COMPT`'s `CONFIG_ID`/`CONFIG_TYPE`/
`CONFIG_VAR`/`LANGU`/`TEXT_ID` key, resolving to `DESCRIPTION` (observed:
`30`→"Change", `34`→"Save", `38`→"Read-Only", `42`→"Refresh", `46`→"Cancel",
`12`→"Start"); `WDY_CONFIG_DATT` and `WDY_CONFIG_APPT` were also checked and
do **not** hold these labels. `events` resolves every one it
can and reports the outcome in a note: when resolution succeeds, `text`
holds the resolved label and `textKey` the raw numeric key, preferring the
caller's logon language, then `"E"`, then whatever language is on file for
that key (`WDY_CONFIG_COMPT` has no master/original-language column, so
there is no "the config's original language" step to try in between); when
no `WDY_CONFIG_COMPT` row matches a key at all, `text` falls back to the raw
key and the note says so; when the `WDY_CONFIG_COMPT` read itself fails,
every marked `TEXT` falls back to its raw key and the note names the
failure.

`events` is gated exactly like the other `abap_fpm_read` modes: it needs
`canWrite` because it deploys `ZCL_ZMCP_FLUID_FPM` into
`$ABAPSMITH_FLUID_API`, is absent under `ABAP_MODE=read`, and refuses
`FLUID_API_DISABLED` with `ABAP_FLUID_API=false`. Run live on A4H against
`/BOFU/TEST_FBI_SALES_ORDER_OVP` (config_type `00`), it returned 7 UIBB
views, 8 events and 4 wires (source UIBB, target UIBB, connector class)
plus the application controller class, resolving handlers as `standard`
(floorplan-handled, naming the event) and `bopf` (BO `/BOFU/TEST_SALES_ORDER`,
node `ITEM`, action unresolved — the two events involved, `FBI_CREATE` and
`FBI_DELETE`, are FBI framework events per the limit above). The VIEWS
section on that run:

```
config_id                         kind                      feeder_class                   bo                      node
--------------------------------  ------------------------  -----------------------------  ----------------------  ----
/BOFU/TEST_FBI_SALES_ORDER_OVP    FPM_OVP_COMPONENT
/BOFU/WDCC_FBI_CONTROLLER_NEW     /BOFU/WDC_FBI_CONTROLLER
/BOFU/TEST_SALES_ORDER_MAIN_FORM  FPM_FORM_UIBB             /BOFU/CL_FBI_GUIBB_FORM        /BOFU/TEST_SALES_ORDER  ROOT
/BOFU/TEST_SALES_ORDER_ITEM_LIST  FPM_LIST_UIBB             /BOFU/CL_FBI_GUIBB_LIST        /BOFU/TEST_SALES_ORDER  ITEM
/BOFU/TEST_SALES_ORDER_ITEM_DET   FPM_FORM_UIBB             /BOFU/CL_FBI_GUIBB_FORM
/BOFU/TEST_SALES_ORDER_ALTKEY     FPM_FORM_UIBB             /BOFU/CL_FBI_GUIBB_ALTKEY_FDR  /BOFU/TEST_SALES_ORDER  ROOT
/BOFU/TEST_SALES_ORDER_BOOTSTRAP  FPM_FORM_UIBB             /BOFU/CL_FBI_GUIBB_BOOTSTRAP   /BOFU/TEST_SALES_ORDER  ROOT
```

The two LIST-UIBB events carry their source UIBB's `kind`/`feeder_class`
inline in the EVENTS row, e.g. `/BOFU/TEST_SALES_ORDER_ITEM_LIST |
FPM_LIST_UIBB | /BOFU/CL_FBI_GUIBB_LIST | button_row |
_CFG_BUTTON_ROW_ELEMENT_6 | (no text) | FBI_CREATE | bopf`. Against
`/BOFU/TEST_CUSTOMER_OIF` (11 views, 2 events, 5 wires) it resolved
`feeder` handlers naming the feeder classes and methods —
`/BOFU/CL_FBI_CHDOC_ROOT_MUL` and
`/BOFU/CL_FBI_CHDOC_ROOT_SINGLE`, both method
`IF_FPM_GUIBB_FORM~PROCESS_EVENT`. Its VIEWS section:

```
config_id                      kind                      feeder_class                    bo                        node
-----------------------------  ------------------------  ------------------------------  ------------------------  ----
/BOFU/TEST_CUSTOMER_OIF        FPM_OIF_COMPONENT
/BOFU/TEST_CUST_ROOT_INIT      FPM_FORM_UIBB             /BOFU/CL_FBI_GUIBB_BOOTSTRAP    /BOFU/TEST_CUSTOMER       ROOT
/BOFU/TEST_CUST_ROOT_FORM      FPM_FORM_UIBB             /BOFU/CL_FBI_GUIBB_FORM
/BOFU/PPF_OUTPUT_ROOT          FPM_FORM_UIBB             /BOFU/CL_PPFOC_FBI_GUIBB_FORM   /BOFU/PPF_OUTPUT_CONTENT  ROOT
/BOFU/CHANGE_DOC_ROOT_DUMMY    FPM_FORM_UIBB             /BOFU/CL_FBI_CHDOC_ROOT_MUL
/BOFU/CHANGE_DOC_ROOT_DUMMY_2  FPM_FORM_UIBB             /BOFU/CL_FBI_CHDOC_ROOT_SINGLE
/BOFU/PPF_OUT_CONT_TAB         FPM_TABBED_UIBB
/BOFU/CHANGE_DOC_TAB           FPM_TABBED_UIBB
/BOFU/CHANGE_DOC_TAB_2         FPM_TABBED_UIBB
/BOFU/TEST_CUST_ROOT_KEY       FPM_FORM_UIBB             /BOFU/CL_FBI_GUIBB_ALTKEY_FDR   /BOFU/TEST_CUSTOMER       ROOT
/BOFU/WDCC_FBI_CONTROLLER_NEW  /BOFU/WDC_FBI_CONTROLLER
```

The application-controller row and the three `FPM_TABBED_UIBB` wrapper rows
above have no `feeder_class`/`bo`/`node` — those configs genuinely name none,
which is the blank-cell case described above, not a resolution gap. Adding
`uibb: "/BOFU/TEST_SALES_ORDER_ITEM_LIST"` to the OVP call narrows the views
traced (7 → 2) without changing the event or wire count, because the five
dropped views carried no events and the application/OVP root's own toolbar
stays in the result as one of the retained views. The `WDY_CONFIG_COMPT`
text-resolution path above is confirmed as a table lookup (see the observed
values above), and the resolved-`text` output of `mode=events` itself is
now confirmed end to end: on the same OVP run, all six toolbar keys above
came back resolved in `text` with the raw key in `textKey` (e.g.
`text: "Change"`, `textKey: 30`). A `config_id` naming no configuration at
all fails outright: `{"mode":"events","config_id":"Z_I101_NO_SUCH_CONFIG",
"config_type":"00"}` returned `FLUID_ACTION_FAILED` with an exception frame
at `step: "read_config"` whose text names the config, e.g. `wdy_config_data:
The specified configuration does not yet exist (config
Z_I101_NO_SUCH_CONFIG type 00 var )`.

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
| `tcode` | string | `screen`: alternative to program+dynpro; `press`: required; `fcode`: alternative to program+dynpro | — | Transaction code. Checked against `TSTC` first: a code with no row is refused as `NOT_FOUND` before any bridge class is deployed (see "TSTC pre-check" below). |
| `program` | string | `screen`/`fcode` only, with `dynpro` | — | Program name instead of `tcode`. `press` refuses it (see "press needs tcode" below). |
| `dynpro` | string | `screen`/`fcode` only, with `program` | — | Screen number, e.g. `"100"`. `press` refuses it. |
| `fcode` | string | `fcode` only, optional | (all) | One function code to trace. Omitted means every function code of every GUI status of the program. |
| `screens` | array of screen-script objects | required for `press` | — | Ordered batch-input script, one entry per dynpro the transaction shows in sequence. |
| `confirm` | boolean | required (must be exactly `true`) for `press` | — | Explicit acknowledgment that `press` commits business data immediately with no dry run. |
| `layout` | boolean | no | `false` | `screen` only. Also render a monospace picture of the screen from the field rows already read. No extra ABAP, no change to the generated bridge class, no extra round trip. Ignored by `mode=press`. |
| `detail` | enum `compact` \| `full` | no | `"compact"` | `screen` only. `compact`: one line per field and generated `%_` flow-logic lines collapsed into counted markers (see "Compact screen output" below). `full`: the raw `key=[value]` dump of every `D021S` column and every flow line. Render-side only — same ABAP, same single bridge call. Ignored by `fcode` and `press`. |

Each `screens[]` entry: `program` (string, required), `dynpro` (string,
required, e.g. `"100"` — padded to 4 digits automatically), `okcode`
(string, optional, e.g. `"=ENTR"` or `"/00"`), `cursorField` (string,
optional), `fields` (array of `{name, value}`, optional — screen field name
and value, max 132 chars each).

### Compact screen output (`detail`)

By default (`detail: "compact"`) a `mode=screen` response renders its two
bulky sections in short form; the header counts (`fieldsCount`,
`flowCount`, ...), `HEADER`, `GUI STATUSES`, `FUNCTION CODES`,
`FUNCTION KEYS`, and the optional `LAYOUT` section are the same under both
settings.

`FIELDS` is one line per element:

```
name                      type      len  pos    attrs
------------------------  --------  ---  -----  -------------------
%_P_KUNNR_%_APP_%-TEXT    label     31   2,1    grp3=TXT
T_USER                    io        27   2,4    grp3=COF
%_USER_%_APP_%-OPTI_PUSH  out       40   2,32   flg1=81 grp3=OPU
P_SELSHW                  checkbox  1    37,4   grp3=PAR
SSCRFIELDS-UCOMM          okcode    20   255,1  ltyp=O didx=0012
```

- `type` is one word — `io`, `out`, `label`, `text`, `checkbox`, `radio`,
  `button`, `frame`, `subscreen`, `tabstrip`, `table`, `okcode` (the
  line-`FF` OK-code field), or `fill=X` for a fill code the renderer does
  not know — classified by the same rule the `layout` renderer uses, so
  the two never disagree about what an element is.
- `len` and `pos` (`line,col`) are decimal; the raw rows carry them as hex.
- `attrs` holds only what differs from a plain element: empty columns,
  all-zero `RAW(1)` columns, `flg1=80` (the value on every ordinary input
  field) and an `stxt` that is just an underscore I/O mask are dropped. A
  real screen text is decoded (`_` becomes a space, the `@NN@` icon prefix
  is stripped) and shown first as `text="..."`.

`FLOW LOGIC` keeps every line the developer wrote and folds each maximal
run of generated `%_...` lines (`MODULE %_INIT_PBO.`,
`FIELD %_P_X_%_APP_%-LOW.`, `MODULE %_PAI.`, ...) into one line,
`(N generated %_ flow-logic lines omitted)`, indented like the first line
it replaced. A `CHAIN.`/`ENDCHAIN.` pair whose whole body is generated
folds with it; a `CHAIN` with any user-written line stays, with only the
generated lines inside it folded. The header gains `flowOmitted: N` and a
`NOTE:` line states what was folded and that `detail: "full"` restores the
dump.

A standard report selection screen has around a hundred generated `%_`
elements, each of which the full dump renders as roughly forty
`key=[value]` pairs, so the full response for such a screen ran to about
27,000 characters (#150). `detail: "full"` still produces exactly that
output — the compact renderer is a different function, not a filter over
the dump — for the case where a raw `D021S` value matters.

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

### TSTC pre-check (`NOT_FOUND` for a transaction that does not exist)

Every tcode-addressed call — `screen` or `fcode` with `tcode`, and every
`press` — first runs one freestyle select against `TSTC` on the read lane
(the same `dataPreview` path `abap_data_preview` uses), after the
connection is up and before any bridge class is touched. A code with no
row is refused as a structured error:

```json
{"error":"NOT_FOUND","message":"transaction ZNOPE does not exist","details":{"tcode":"ZNOPE","table":"TSTC","type":"TRAN/T"}}
```

Before #150 the same mistake cost a full fluid-invoker deploy, activation
and classrun — about 20 s on A4H — before the bridge's own
`SELECT SINGLE FROM tstc` failed with an `ADT_ERROR`; the select costs about
a second. For `press`, the row's `CINFO` is also what the report/dialog
check below reads, so a press no longer runs a second, screen-mode bridge
just to learn `CINFO`: it deploys exactly one class, its own BDCDATA
bridge. A `program`+`dynpro` screen read has nothing to look up and skips
the pre-check.

### press needs tcode

`mode=press` with `program`+`dynpro` and no `tcode` is refused before any
network call, as a structured `BAD_INPUT` whose message is exactly
`press needs tcode; program/dynpro is only supported by mode=screen`
(`details` carries the `program`/`dynpro` given). This was decided against
implementing (#150), not deferred: `CALL TRANSACTION` is the only way batch
input reaches a screen, and the two alternatives both fail the tool's
safety properties — `CALL SCREEN` from the ADT classrun bridge has no GUI
session (it dumps with `DYNPRO_SEND_IN_BACKGROUND`) and a class cannot
`CALL SCREEN` a dynpro owned by another program; a generated wrapper
transaction in `$TMP` would be a cross-client `TSTC`/`TADIR` object created
outside the typed safety gate, left behind whenever the press dumps, and a
way around both `UI_PRESS_DENYLIST` and the tcode-level execute gate. Find
the transaction that starts on that dynpro (`mode:"screen"` with the same
`program`/`dynpro` reports it under `tcode` when `TSTC` has one) and press
that.

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
call (object, offset, limit). A module can have more than one top-level
`CASE` on the OK-code field (or a local alias of it) — e.g. a small
pre-dispatch remap `CASE` followed by the real dispatch `CASE` — and every
qualifying one contributes its own matching `WHEN` branch(es); a `CASE` on
something other than the OK-code field — or a lookup-table / dynamic
dispatch — is reported as `unresolved`, naming the module and include, but
never suppresses branches found by another `CASE` in the same module. If a
matched `WHEN` branch reassigns the OK-code field to a new literal
(`MOVE 'X' TO <var>.` or `<var> = 'X'.`), that one hop is followed too: the
branch(es) elsewhere in the module matching the new literal are included as
well, and the renderer prints the remap on the branch row itself, e.g.
`WHEN UPDL — lines 163-167 — via remap UPD -> UPDL at line 128`, together
with a matching `NOTE` line explaining why it was pulled in even though its
own `WHEN` literal doesn't match the requested fcode. Only one hop is followed —
a remap chasing back to itself, or a second remap on the destination branch,
is noted but not chased further. It never silently falls through.

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
filter out the same way). Run live on A4H against
`{"mode":"fcode","tcode":"SM30","fcode":"UPD"}`, `fcode` resolved `SM30` to
`SAPMSVMA`/`0100` and reported `EXIT_COMMAND` and `CHECK_VARIANT` as
`unresolved` (no `CASE` in either module body) alongside `ACTION`, where the
dispatch field `function` was correctly reported as an alias assigned from
`ok_code`, and all three matching `WHEN` branches were found across the
module's two top-level `CASE`s — the pre-dispatch remap (`WHEN UPD` at
127-131, remapping to `UPDL`) and the real dispatch (`WHEN UPD` at 158-162,
`WHEN UPDL` at 163-167 `viaRemap`) — each carrying its own exact
`abap_read` call. That run is what surfaced the alias-dispatch and
multi-`CASE` behaviour described above, and led to fixing both in `fcode`
itself.

Example (read a screen):

```json
{ "mode": "screen", "tcode": "ZDEMO_ORDER01" }
```

Example (read a screen with every raw `D021S` column and every flow line):

```json
{ "mode": "screen", "tcode": "ZDEMO_ORDER01", "detail": "full" }
```

Example (read a screen with the rendered layout):

```json
{ "mode": "screen", "tcode": "ZDEMO_ORDER01", "layout": true }
Example (trace a function code):

```json
{ "mode": "fcode", "program": "SAPMSVMA", "dynpro": "100", "fcode": "BACK" }
```

