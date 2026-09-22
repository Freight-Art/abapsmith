# abap_img_edit

Writes SAP IMG (SPRO) customizing rows: change or delete rows in the base
table behind a resolved maintenance object, and create the customizing
(type `W`) transport request to record them on. It targets the same
activity/object vocabulary as `abap_img` (`doc/TOOLS/abap-img.md`) — a name
found with that tool's `search`/`tree`/`show`/`objects` modes can be passed
straight through here.

**Availability**: unlike `abap_img`, this is a real write and needs
ordinary write access (`ABAP_MODE=edit` or higher). It deploys generated
helper classes to run — see "Mechanism" below — so it is gated as a write
on that deployment, the same way any other bridge-backed tool is. Without
write access, a read-only v1 server does not skip registering
`abap_img_edit` — it registers a mode-locked refusal stub under the same
name instead (case 4 in
[availability-and-capabilities.md](availability-and-capabilities.md)):
still listed with an empty schema, refuses every call `READ_ONLY` without
deploying anything.

## The three things to read before using this

1. **This does not run the view's own SM30 function module.** A row is
   written directly to the resolved base table with a guarded
   `MODIFY`/`DELETE`, not through the generated table-maintenance function
   module SM30 itself uses. That means the view's foreign-key checks,
   fixed-value checks, and table-maintenance-generator events **do not
   run** — only the row data changes. `preview`, `upsert`, and `delete`
   now name what was skipped instead of only asserting that something
   was — see "CHECKS NOT RUN" under "Mechanism" below — but naming a check
   is not running it: no row is refused on account of anything that
   section lists. This is not an oversight: that
   function module needs the view's field catalogue and dynamic row
   layout supplied by the caller, and nothing established how to build
   those outside the SM30 dialog
   itself; generating a guess at that shape would have produced code that
   looks faithful and is wrong in ways this server cannot detect. What
   *does* still happen is the transport bookkeeping SM30 also does: the
   same CTS pair — `TR_OBJECTS_CHECK` then, as of this change,
   `TRINT_OBJECTS_CHECK_AND_INSERT` called with `IV_WITH_DIALOG = 'D'`
   (headless insert; see point 2 below) — records `R3TR VDAT` for the view
   and `R3TR TABU` for each row's base-table key when a maintenance view is
   involved, or `R3TR TABU` alone, with no `VDAT` header, when `master_type`
   resolves to `TABU` for a plain-table target (see the `master_type` row
   under "Parameters"). For a view target this files two rows — an `E071`
   header for the maintenance view (`R3TR VDAT <view>`, `OBJFUNC` `K`) and,
   beneath it, an `E071K` key sub-entry for the base table (`PGMID` `R3TR`,
   `OBJECT` `TABU`, `OBJNAME` = the table, `MASTERTYPE` = the resolved
   master type, `MASTERNAME` = the view, `TABKEY` = the client followed by
   the key, e.g. `001ZTMD`) — measured on the sixth live run (2026-09-06).
   For a plain-table target the `E071K` row's `TABKEY` carries no client
   prefix when the table is client-independent: verified live 2026-09-22, a
   delete of two `BALOBJ` rows on workbench request A4HK900350 filed `R3TR
   TABU BALOBJ` (`OBJFUNC` `K`) on its task, one `E071K` row per key, each
   `TABKEY` unprefixed (e.g. `ZAS_LOG176`). `SORTFLAG` and `LANG` on an
   `E071K` row are left initial (blank) by the function modules; `AS4POS`
   was `000001` in the 2026-09-06 run. The row lands on the request itself
   for a customizing (type `W`) request, or on the request's task for a
   workbench (type `K`) request — ordinary CTS behaviour, not something
   this bridge chooses. See "Transport resolution under
   `ABAP_ALLOW_TRANSPORTS=auto`" below for which request or task a call
   without an explicit `corr_nr` ends up filing against.
2. **The CTS recording call is now `TRINT_OBJECTS_CHECK_AND_INSERT` with
   `IV_WITH_DIALOG = 'D'`, not `TR_OBJECTS_INSERT`.** `TR_OBJECTS_CHECK`,
   `TR_OBJECTS_INSERT`, and `TR_INSERT_REQUEST_WITH_TASKS` were first
   live-proven from this server on a sixth verification run, 2026-09-06 —
   that run also found and fixed a `create_request` defect around a
   missing `SCTS_USER` fill-in, described under the `create_request`
   bullet in "Mechanism" below. `TR_OBJECTS_INSERT` hard-codes
   `IV_WITH_DIALOG = 'X'` and pops SAPLSTRD dynpros 0300 (request choice) /
   0352 (task classification) whenever the chosen request or its task
   needs a dialog decision — in a classrun that raises
   `CX_SY_SEND_DYNPRO_NO_RECEIVER` instead of completing. The 2026-09-06
   run only succeeded because neither dialog was needed that time; it was
   not proof the call was safe in general. The bridge now calls
   `TRINT_OBJECTS_CHECK_AND_INSERT` with `IV_WITH_DIALOG = 'D'` (headless
   insert) instead, which decides without popping a dynpro.
   `IV_WITH_DIALOG = space` is a documented trap, not a stricter mode: it
   returns success but writes nothing at all (check-only) — the bridge
   never passes it. Verified live 2026-09-22 (BALOBJ/A4HK900350, point 1
   above): the new call recorded a real entry, including for a
   client-independent table, which the pre-fix bridge refused outright —
   see "What this does not do" below for what changed there. Still
   unproven from here: `TRINT_OBJECTS_CHECK_AND_INSERT`'s own failure
   paths — `INSERT_FAILED`, `ENQUEUE_FAILED`, an authority or lock
   refusal — none has been forced live yet.
3. **Every generated helper class goes into `$ABAPSMITH_FLUID_API`, never
   `$TMP`.** This is the fluid API's own local package, created on first
   use (super-package `$TMP`, but `$TMP` itself is never a landing spot).
   If it cannot be created, the call is refused with a clear error —
   there is no silent fallback to `$TMP`. `upsert`, `delete`, and
   `create_request` still generate their own statically typed bridge
   classes; `preview` no longer generates a bespoke probe of its own — it
   deploys the shared fluid `img` body class plus a small, content-addressed
   invoker that a repeat call with the same arguments reuses rather than
   regenerating — see "Mechanism" below.

## Mechanism

Target resolution is identical to `abap_img`: an `activity` or `object`
(with optional `kind`) resolves, via the same join `abap_img` uses
(`src/adt/img-resolve.ts`), to one base table. An activity behind several
maintenance objects, or an object spanning several base tables, is refused
with the same ambiguity message `abap_img show`/`objects` would show —
name the object or table explicitly rather than the activity. The resolved
table name is printed upper-cased, the way SAP itself spells it, in the
`confirm` token, the `preview` response header, and the transport-entry
line alike — the `confirm` comparison is case-insensitive regardless, so
nothing about arming a write changes with this.

- **`preview`** — resolves the target and runs the built-in fluid tool
  `img`, action `preview` (body class `ZCL_ZMCP_FLUID_IMG`, deployed into
  `$ABAPSMITH_FLUID_API`), which reads the table's client-dependence
  (`T000`), its delivery class and every column of the table — key and
  non-key alike, in one `DD03L` select ordered by position — and the
  current values of the requested rows. Makes no change. It now runs the same plan
  validation `upsert`/`delete` enforce for real, so a row `preview`
  accepts is a row the armed call will accept too, and vice versa — the
  one exception is `corr_nr`/`confirm`, which `preview` still only reports
  as advisory notes, since nothing is being armed here either way.
- **`upsert`** / **`delete`** — the same checks as `preview`, now enforced:
  delivery class must be `C`, `G`, or `E` (`A`/`L`/`S`/`W` are SAP-delivered
  or system tables and are refused by name); `allow_cross_client: true`
  clears the policy refusal for a client-independent table, and — since the
  2026-09-22 fix — the write actually reaches such a table too, whether it
  is resolved via `activity`/`object` or via the `table` expert escape
  hatch, rather than being refused a second time inside the shared `apply`
  action; see "What this does not do" below for what changed; row count
  must be 1–50; every key field's data type must be char-like
  (`CLNT`/`CHAR`/`NUMC`/`LANG`/`UNIT`/`CUKY`/`DATS`/`TIMS`/`ACCP` — the
  generated code casts the key structure with `ASSIGN ... CASTING TYPE c`,
  which is only sound for these); the table must not be on the same
  deny-list `abap_data_preview` uses (credentials/security, payroll/HR,
  accounting documents, and personal data); and the system's own client-change
  setting (`T000-CCCORACTIV`) must not block customizing changes outright.
  An `upsert` row may name key fields only, with no `values` at all — that
  is legal input, the same way SM30 accepts a new row for a table whose
  every non-key column is optional (e.g. `TB004`, key `BPKIND`, whose only
  non-key columns are seven optional `FELDSTLSTn` field-status lists). If
  the row doesn't already exist it is inserted with the key fields and the
  client field set and every other column left at its initial value; if it
  already exists nothing is written, and the per-row result reports
  `changed: no` with the text `row exists, no value fields to write` — a
  success, not a refusal. `preview`'s prospective-change table shows such a
  row as `key-only row (no value fields); insert if absent, otherwise no
  change` rather than an empty set of fields. An armed `delete` reports the same
  shape of result: `changed: yes` with the result `deleted` for a row that
  existed, and `changed: no` with the result `absent (nothing to delete)` for
  one that didn't. When any row was absent, a note names those rows, states
  nothing was deleted for them and no transport entry was recorded for them, and
  points out that the header's `applied` count is the number of rows the bridge
  processed, not the number actually changed. `confirm` must then exactly
  equal the resolved base table name — not the activity id, not the view
  name — to arm the call; without it, nothing is written. If the client
  requires a recorded change, `corr_nr` (a customizing request or task
  number) is required too. A successful armed call discloses that CTS entry directly, under a
  `TRANSPORT ENTRY RECORDED` section, instead of leaving a caller to look
  up `E071K` separately — there is no tool in this server that reads
  `E071K` directly; `abap_data_preview` takes `{table, object, max_rows,
  where, columns, order_by, distinct}` — a structured filter, never raw SQL
  or a caller-supplied WHERE clause (see `doc/TOOLS/diagnostics.md`). The section prints an
  identity line of the form `R3TR TABU <TABLE> (master <MASTERTYPE>
  <VIEW>)`, above a per-row table whose `tabkey` column carries the
  client and key together (e.g. `001ZTMD`). If the bridge transcript
  carried no `IMGW> CLIENT` line, `tabkey` renders unprefixed (the key
  portion alone) and a note says so, rather than fabricating a client.
  Once armed, the fluid `img` tool's shared `apply` action runs
  (`ZCL_ZMCP_FLUID_IMG`, dispatched through `runImgApply` in
  `src/adt/img-write.ts`): per row, read the before-image, record the CTS
  entry (if `corr_nr` given), `MODIFY`/`DELETE`, `COMMIT WORK AND WAIT`,
  then re-read the after-image. This ported the behavior of a since-retired
  per-call `ZCL_ZMCP_IMG_WAPPLY` generator unchanged; it is described here
  for what actually runs now.
  If the generated class fails to activate, none of that runs: the call
  returns `CHECK_FAILED` with the activation errors, the class name in
  `details.bridgeClass`, and `details.bridgeLeftBehind: true`. The class
  stays in `$ABAPSMITH_FLUID_API`, inactive — harmless, and safe to delete, but
  not cleaned up automatically. No journal entry is written for a failed
  activation, since the journal only records an apply that actually ran on
  the wire, so there is no before-image and nothing to reconcile: nothing
  was written to the target table and no transport entry was filed.
  There is a second failure shape, for when the class does activate and
  run: the apply is judged failed whenever its transcript cannot be fully
  accounted for — a bridge error line (including a caught ABAP runtime
  exception, reported as an `IMGW> ERROR` line naming the exception
  class), no `APPLIED` marker, a row with no after-image, or a delete row
  still present afterward. That answers `CHECK_FAILED` as well, never an
  `ok` with a row's `changed` reported as `unknown`. `details` carries
  `table`, `mode`, `bridgeClass`, `mayHaveExecuted`, `errors`, and
  `reasons`. `mayHaveExecuted` is decided only from transcript markers
  (`WROTE`/`APPLIED`/any after-image line): `true` means some row's own
  `MODIFY`/`DELETE` plausibly went through even though the overall apply
  failed; `false` means no marker shows that any row write even
  started — it is not proof the system is unchanged. Unlike the
  activation-failure case, a journal entry is written here (outcome
  `failed`), because the apply did reach the wire. This failure shape is
  what a live run hit on 2026-09-05: the generated `lt_ko200`/`lt_e071k`
  tables were declared `WITH EMPTY KEY` but passed to `TABLES` formal
  parameters on the CTS function modules, which take the DEFAULT key — a
  runtime type conflict ADT's activation check does not catch. They are
  now declared `WITH DEFAULT KEY` — the sixth live verification run
  (2026-09-06) confirms the fix: the same armed `upsert` that filed a
  real transport entry through both CTS calls hit no such conflict.
- **`create_request`** — the fluid `img` tool's shared `create_request`
  action (`ZCL_ZMCP_FLUID_IMG`, dispatched through
  `runCreateCustomizingRequest` in `src/adt/img-write.ts`) calls
  `TR_INSERT_REQUEST_WITH_TASKS`, passing `IT_USERS` with one row so the
  request gets a task. This ported a since-retired per-call
  `ZCL_ZMCP_CTS_WREQ` generator's behavior unchanged, including the
  history below. `request_type` picks what kind of request is created:
  `customizing` (the default — type `W`, task type `Q`) or `workbench`
  (type `K`, task type `S`); see "Transport resolution under
  `ABAP_ALLOW_TRANSPORTS=auto`" below for why a caller might want a
  workbench request out of a tool whose own writes are customizing rows.
  `IT_USERS`' row type, `SCTS_USER`, is a structure with exactly two
  fields — `USER` (`TR_AS4USER`) and `TYPE` (`TRFUNCTION`), measured from
  DD40L/DD03L — not a plain user-name table; a second live run (against
  that retired generator) that passed a bare `sy-uname` failed to
  activate the bridge (`"SY-UNAME" and the row type of "LT_USERS" are
  incompatible`). The row now fills that
  structure (`USER` = `sy-uname`, `TYPE` = the task type for the chosen
  `request_type`), and the response carries the created task's number and
  its type (`taskType`) alongside the request number. That type can now be
  confirmed independently with `abap_transport operation="show"` on the
  request number — its `TASKS` table carries a `type` column. The sixth
  live verification run (2026-09-06) passed `TYPE = 'Q'` and read back a
  task typed `'Q'` — consistent with the function module honouring the
  value passed, but not decisive on its own: a type-`W` request's task is
  `'Q'` by default regardless of what `TYPE` asks for, so that single
  observation could not tell the two apart. `request_type: "workbench"`
  passes a different `TYPE` (`'S'` on a type-`K` request) and reads it
  back the same way, which is what actually settles the question — see
  "Transport resolution under `ABAP_ALLOW_TRANSPORTS=auto`" below. The request number is reported as soon as it is
  known, before the task check runs; a request that comes back with no task
  is a loud warning carrying the number, not a silent loss. A call whose
  transcript carries an error line, or from which no request number can
  be parsed, is reported as an error (`CHECK_FAILED`) rather than a
  success — the response says a request may nonetheless have been
  created, and how to find it: `abap_transport list` in the customizing
  section, matched on the description passed in, then reuse or delete it.
  A confirmed request is journalled as `transport-create` as soon as its
  number is known, including the task-less warning path; when no number
  can be parsed, a suspected-orphan entry carrying the description is
  journalled instead. This lives here rather than on `abap_transport
  create` because that tool's create is package-driven — it requires a
  package, refuses a local (`$`) one, and checks the package allowlist —
  and none of that is meaningful for a customizing request, which has no
  development class at all.

### Transport resolution under `ABAP_ALLOW_TRANSPORTS=auto`

This only concerns `ABAP_ALLOW_TRANSPORTS=auto`; deny-all
(`ABAP_ALLOW_TRANSPORTS=` empty) and an explicit TRKORR allowlist behave
exactly as they always have — see
[doc/CONFIGURATION/permissions-and-allowlists.md](../CONFIGURATION/permissions-and-allowlists.md).

**A caller-named `corr_nr`** is accepted under `auto` only when it is a
request this session itself created — through this tool's own
`create_request`, or through `abap_transport operation="create"` — the same
session registry (`SessionTransport`, `src/adt/session-transport.ts`)
`abap_write` already consults for its own auto-resolution. Any other
caller-named request is refused, `SAFETY_DENIED`, and the hint now adds:
"Under auto, pass a request this session created (abap_img_edit
mode=create_request or abap_transport create), or omit corr_nr to let this
session resolve one."

**An omitted `corr_nr`** under `auto` no longer refuses when the table
needs a request — the session resolves one, and which kind depends on the
target table's client-dependence:

- A **client-dependent** table gets a customizing request: the one this
  session already created earlier via `create_request` (default
  `request_type`), or a new one if none exists yet, described `abapsmith
  customizing request <date>`.
- A **client-independent** table gets a workbench request instead: the
  session's currently active workbench request, one this session created
  earlier via `create_request request_type=workbench`, or a new one.
  Customizing requests cannot take this entry — CTS refuses to record a
  client-independent table entry on a customizing (type `W`) request with
  TK599 "No task for editing objects can be determined" (verified live
  2026-09-22), so resolving toward a workbench request here is not a
  style choice, it is the only request kind CTS will accept the entry on.

Either way, the response header's `corrNrSource` says what happened —
`caller` (a caller-named request was used, only possible with an explicit
TRKORR allowlist or a session-created request under `auto`), `session-cached`
(an existing session-created request was reused), or `session-created` (a
new request was created for this call) — and the journal entry's
`trSource` records the same thing.

**`preview`** never creates a request, but under `auto` it now says which
one an armed call would use, or would create: "Applying this change would
record on `<REQ>` (`<kind>` request known to this session)" when one
already exists to reuse, or "would create a new `<kind>` request ..." when
none does yet — `<kind>` is `customizing` or `workbench`, following the
same client-dependence rule above.

### CHECKS NOT RUN

`preview`, `upsert`, and `delete` responses all carry a `CHECKS NOT RUN`
section, built for the resolved target table from read-only DDIC lookups —
it does not run any check itself, only reads catalog metadata about what
SM30 would have run. It lists:

- **Maintenance event routines** registered in `TVIMF` for the resolved
  view, the base table itself, and any other view whose first base table
  (`DD26S` `TABPOS` `0001`) is that table — one row per view/event, giving
  the view, the event code, the event's meaning (the `DD07T` text for
  domain `MAINTEVENT`), and the routine name. These are the routines SM30
  calls for this data; this tool does not call any of them.
- **Check tables** (`DD03L` `CHECKTABLE`) of the fields the call writes —
  the foreign keys this tool leaves unverified.
- **Fixed-value violations**: any written value that is not one of its
  field's domain's fixed values (`DD03L` `DOMNAME` → `DD07L`). Such a value
  also surfaces as a note elsewhere in the response, not only in this
  section.

If the metadata read itself fails, the section says so instead of silently
omitting itself.

**Worked example.** This is the case that prompted the section: copying
standard business-partner role `BUP001` into a new `TB003` row carried
`STND_ROLECAT = 'X'` along with it. SM30 refuses that outright — a role
category may have exactly one standard role — because view `V_TB003` has a
maintenance event routine, `V_TB003_CHECK_DEFAULT`, registered against
event `01` ("before saving the data in the database"), and that routine is
what enforces the rule. Before this section existed, `mode=preview` printed
the prospective `SET` line for that row and said nothing else about it.
Now `preview` (and the armed `upsert`) for that same row also prints:

```
--- CHECKS NOT RUN ---
This tool writes the base table directly. The maintenance dialog's own check logic does not run — below is what SM30 would have run for this data.

Maintenance event routines registered in TVIMF (SM30 calls these; this tool does not):
view     | event | when                                     | routine
V_TB003  | 01    | Before saving the data in the database   | V_TB003_CHECK_DEFAULT
V_TB003  | 13    | Exit editing (exit main function module) | V_TB003_RESET_DFLT

Check tables for the fields this call writes (foreign keys not verified):
field        | check_table
ROLECATEGORY | TB003A
```

This section is informational only and never blocks anything: `preview`
writes nothing at all, and the armed `upsert` still writes the row exactly
as given. What changed is that `V_TB003_CHECK_DEFAULT` is now named before
the call is armed, instead of a caller finding out the hard way that SM30
would have refused the row. See "Known limitations" below for what this
section deliberately does not catch.

## Parameters

Every field name below is the literal wire key — pass it exactly as
written, snake_case included.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `mode` | enum `preview` \| `upsert` \| `delete` \| `create_request` | yes | — | Operation to perform. |
| `activity` | string | consultant path: exactly one of `activity`/`object`/`table`, for `preview`/`upsert`/`delete` | — | Same activity id `abap_img show` takes; resolved to its base table, key fields, and client field automatically. Conflicts with `key_fields`/`client_field`. |
| `object` | string | consultant path: exactly one of `activity`/`object`/`table`, for `preview`/`upsert`/`delete` | — | Same object name `abap_img objects` takes. Conflicts with `key_fields`/`client_field`. |
| `kind` | enum `table` \| `view` \| `cluster` \| `transaction` \| `customizing_object` \| `report` | optional, only meaningful with `object` | probed table → view → cluster → transaction → customizing object, first match wins | Which catalog to resolve `object` against. |
| `table` | string | expert escape hatch: exactly one of `activity`/`object`/`table`, for `preview`/`upsert`/`delete` | — | The base DDIC table to read/write directly, bypassing activity/object resolution. Requires `key_fields`. `client_field` is optional; for a client-dependent table the write stamps it from `sy-mandt`, for a client-independent table (DD02L CLIDEP blank) the declared client field is ignored and `allow_cross_client: true` is required — see "What this does not do". |
| `client_field` | string | `table` (expert escape hatch) only | `MANDT` | The table's client field name, e.g. `MANDT`. Conflicts with `activity`/`object`, whose client field is resolved automatically. |
| `key_fields` | array of string | `table` (expert escape hatch) only, at least one entry | — | The table's key field names, in order, excluding the client field. Conflicts with `activity`/`object`, whose key fields are resolved automatically. |
| `rows` | array of `{ key: {...}, values: {...} }` | required for `preview`/`upsert`/`delete` | — | Row key fields and, for `upsert`, the non-key values to write. `values` may be omitted entirely on an `upsert` row — see "Mechanism" for what a key-only row does. `delete` needs only `key`. 1–50 rows per call. |
| `view` | string | optional, for `upsert`/`delete` | resolved view/cluster name (or table, if the resolved target is a table); with `table`, defaults to `table` | The maintenance view or view cluster name recorded on the transport entry. |
| `master_type` | enum `VDAT` \| `CDAT` \| `TABU` | optional, for `upsert`/`delete` | `VDAT` when a view is involved; `TABU` when the resolved target is the table itself, with no maintenance view | The transport entry's object type — `VDAT` for a maintenance view, `CDAT` for a customizing object recorded directly, `TABU` for the plain table. CTS refuses a `VDAT` header naming a plain table outright, with TK323 "<table> is a table, it cannot be accessed as a view" (verified live 2026-09-22 on `BALOBJ`), so pass `TABU` explicitly if you ever override the default toward a view-less target. |
| `language` | string, regex `^[A-Za-z]$` | optional | the server's configured language (`ABAP_LANGUAGE`/`cfg.language`) if set, else `"E"` | Single-character SAP language key (SPRAS) the probe reads DD02L/DD03L texts in — e.g. `"E"` for English, `"D"` for German. A two-character ISO code such as `EN`/`DE` is refused (`BAD_INPUT`) naming the one-character form, not silently mapped — see `doc/TOOLS/abap-img.md`'s `language` row for why. The `preview` response header prints the resolved value. |
| `corr_nr` | string | required when the client's change setting demands a recorded change | — | Customizing request or task to record the write on. Get one via `create_request`, or reuse an existing one. Under `ABAP_ALLOW_TRANSPORTS=auto`, only a request this session itself created (`create_request`, or `abap_transport create`) is accepted here — any other caller-named request is refused; omit `corr_nr` under `auto` instead and let the session resolve one, following the table's client-dependence — see "Transport resolution under `ABAP_ALLOW_TRANSPORTS=auto`" below. |
| `confirm` | string | required to actually apply `upsert`/`delete` | — | Must exactly equal the resolved base table name (case-insensitive) to arm the write. Omitted (or on `preview`) means nothing changes. |
| `allow_cross_client` | boolean | no | `false` | Clears the policy refusal for a client-independent table; without it, a cross-client target is refused outright. As of 2026-09-22 this does make the write possible too, whether the target is resolved via `activity`/`object` or via the `table` expert escape hatch — see "What this does not do". |
| `description` | string, max 60 chars | required for `create_request` | — | Short text for the new customizing (or workbench, see `request_type`) request. |
| `request_type` | enum `customizing` \| `workbench` | optional, for `create_request` only | `customizing` | Kind of request `create_request` makes: `customizing` (type `W`, task type `Q`) or `workbench` (type `K`, task type `S`). Pass `workbench` when the session will need to record a client-independent table — a customizing request's task cannot hold that entry, see "Transport resolution under `ABAP_ALLOW_TRANSPORTS=auto`" below. |
| `owner` | string, regex `^[A-Z0-9_]{1,12}$` | optional for `create_request` | the logged-on user | Request owner. Case-sensitive and not normalized — a wrong-case value is refused, not silently corrected, since a wrong owner on a customizing request cannot be detected after the fact. |

## Worked example

### Consultant path: `activity`/`object`

This is the normal path — resolve by the same activity or object id
`abap_img` already showed you, and let key fields and the client field
come from that resolution. Full sequence: create a request, preview,
arm the write, then delete the row again.

```json
{ "mode": "create_request", "description": "Adjust document type default" }
```

```json
{ "mode": "preview", "activity": "ZACT1", "rows": [{ "key": { "ZFLD": "0001" } }] }
```

```json
{
  "mode": "upsert",
  "activity": "ZACT1",
  "rows": [{ "key": { "ZFLD": "0001" }, "values": { "ZVAL": "NEW VALUE" } }],
  "corr_nr": "A4HK900001",
  "confirm": "ZTAB1"
}
```

```json
{
  "mode": "delete",
  "activity": "ZACT1",
  "rows": [{ "key": { "ZFLD": "0001" } }],
  "corr_nr": "A4HK900001",
  "confirm": "ZTAB1"
}
```

`confirm` is the resolved base table name (`ZTAB1` here), not the
activity id — `preview`'s response names it explicitly so you never have
to guess it. `object: "TB004"` (with or without `kind: "table"`) works
the same way in place of `activity`.

### Expert escape hatch: `table`/`key_fields`/`client_field`

Use this only when you already know the DDIC table shape and want to
bypass activity/object resolution entirely — `key_fields` and
`client_field` are then supplied directly instead of being derived:

```json
{
  "mode": "preview",
  "table": "ZTEST_IMGW",
  "key_fields": ["ZFLD"],
  "client_field": "MANDT",
  "rows": [{ "key": { "ZFLD": "0001" } }]
}
```

```json
{
  "mode": "upsert",
  "table": "ZTEST_IMGW",
  "key_fields": ["ZFLD"],
  "client_field": "MANDT",
  "rows": [{ "key": { "ZFLD": "0001" }, "values": { "ZVAL": "NEW VALUE" } }],
  "corr_nr": "A4HK900001",
  "confirm": "ZTEST_IMGW"
}
```

Every activity id, object name, table name, and field name above is a
placeholder — substitute whatever `abap_img` actually resolved (or, on
the expert path, whatever the real DDIC table looks like). Transport
numbers are placeholders too, in the `A4HK9xxxxx` shape real requests on
this system use.

## What this does not do

- Does not run the target view's own foreign-key checks, fixed-value
  checks, or table-maintenance-generator events — only the row data is
  written, so validation the SM30 dialog would have performed did not
  happen here. See point 1 above. `preview`, `upsert`, and `delete` now
  name what was skipped, under `CHECKS NOT RUN` (see "Mechanism"), but
  naming a check is not running it — no row is ever refused on the basis
  of anything that section lists.
- Does not create an IMG node, activity, or maintenance view.
- Does not maintain any table outside the fixed delivery-class set
  (`C`/`G`/`E`); a SAP-delivered or system table is refused by name.
- **Resolved: a client-independent (cross-client) table used to be refused
  outright even with `allow_cross_client: true`.** Before 2026-09-22, the
  shared `apply` action (`ZCL_ZMCP_FLUID_IMG`) refused every such table
  before touching any row, with "client field MANDT not found" — the
  DD02L client-flag guard compared a boolc string against `abap_bool` and
  always failed for a table with no client field, so `allow_cross_client`
  cleared only the policy refusal and never reached a real write. (A
  now-retired per-call `ZCL_ZMCP_IMG_WAPPLY` generator used to hit the
  same outcome by accident, as an activation failure from
  unconditionally setting a client field that didn't exist.) That guard
  is fixed, and `WI_ORDER` — previously passed as a string
  (`CX_SY_DYN_CALL_ILLEGAL_TYPE`) — is fixed alongside it: a
  client-independent table — through `activity`/`object` or through the
  `table` expert escape hatch — is now genuinely writable, with
  `allow_cross_client: true` still required to clear the policy refusal
  first. Verified live 2026-09-22: a `delete` of two `BALOBJ` rows, made
  through the `table` expert escape hatch (`table: "BALOBJ"`, no
  `client_field` given), filed a real `R3TR TABU BALOBJ` transport entry
  with no client prefix on `TABKEY`. Resolving via `activity`/`object` to a
  client-independent table (no CLNT-typed key field) is accepted the same
  way: all key fields are treated as key fields and the client field
  placeholder is ignored by the bridge — the earlier `BAD_INPUT` "cannot
  write a client-independent table at all" refusal goes away.

## Known limitations

- **Resolved: a cold process's very first call used to refuse outright even
  on a writable system.** With the startup role probe suppressed
  (`ABAP_STARTUP_PROBE=false`), a fresh process's system-role verdict
  starts out unknown, and the `write-lockout` rule refuses any write while
  it is unknown (`SAFETY_DENIED`, "No system-role probe has confirmed this
  system is non-productive yet"). The verdict is only settled — transcribed
  into the safety gate — once some call has connected, and this tool used
  to consult the verdict *before* ever connecting, so a fresh process's
  very first call, even a `preview`, was refused regardless of whether
  writes were actually live. It now connects first when the verdict is
  still unknown, the same way `abap_write` always has, so the first call
  of a fresh process no longer refuses for this reason alone. The
  `write-lockout` rule itself is unchanged and is fail-closed by design —
  this was never a bug in the rule, only in when this tool consulted it.
  If `write-lockout` is seen again, two things are worth knowing: a system
  whose verdict is already settled (e.g. genuinely reports itself
  productive) still refuses without needing another logon — that is the
  rule working as intended, not a regression of this defect; and any one
  connecting read call (from any tool) has always been enough to settle an
  unknown verdict for every write tool afterward, so a repeat of this
  specific failure on a call that is not a process's first is unexpected
  and worth investigating rather than assuming.
- **`preview` can now refuse a row it used to just display.** Now that
  `preview` runs the same plan validation `upsert`/`delete` enforce for
  real (see "Mechanism"), any row that fails that validation — naming a
  value field the table doesn't have, for instance — is refused at
  `preview` too, instead of being shown with the bad field silently
  ignored. This is a consequence of preview and the armed call sharing one
  validator, not a new restriction on what can be written; a row `preview`
  now accepts is a row the armed call will accept as well.
- **`CHECKS NOT RUN` under-reports by design.** The fixed-value check
  skips a blank written value — a blank normally means "not set", not a
  violation — and skips any domain with value ranges (`DD07L` `DOMVALUE_H`
  non-blank) rather than trying to check a value against a range. The
  comparison against a domain's fixed values is also case-insensitive: on
  a live system, a field whose domain has no LOWERCASE flag is upper-cased
  by the ABAP layer before it is ever compared against `DOMVALUE_L`, so a
  value that differs from a fixed value only by case is not reported as a
  violation — this avoids a false positive from a caller writing, say,
  `"x"` into a field whose domain's fixed value is `"X"`. Naming a routine
  (from the `TVIMF` listing) says only that a routine exists and where it
  is registered — it does not say what the routine checks; read it in
  SE80/SE37 if that matters. And the event list is drawn from every
  plausible maintenance view of the table (the resolved view, the table
  itself, and any view whose first base table is that table), so it can
  list a view you are not actually maintaining through. All of these
  choices favor under-reporting over a false alarm.
