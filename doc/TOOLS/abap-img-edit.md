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
on that deployment, the same way any other bridge-backed tool is.

## The three things to read before using this

1. **This does not run the view's own SM30 function module.** A row is
   written directly to the resolved base table with a guarded
   `MODIFY`/`DELETE`, not through the generated table-maintenance function
   module SM30 itself uses. That means the view's foreign-key checks,
   fixed-value checks, and table-maintenance-generator events **do not
   run** — only the row data changes. This is not an oversight: that
   function module needs the view's field catalogue and dynamic row
   layout supplied by the caller, and nothing established how to build
   those outside the SM30 dialog
   itself; generating a guess at that shape would have produced code that
   looks faithful and is wrong in ways this server cannot detect. What
   *does* still happen is the transport bookkeeping SM30 also does: the
   same CTS pair (`TR_OBJECTS_CHECK` then `TR_OBJECTS_INSERT`, function
   group `SAPLSTRD`) records `R3TR VDAT` for the view and `R3TR TABU` for
   each row's base-table key. Measured on the sixth live run (2026-09-06):
   this actually files two rows, not one — an `E071` header for the
   maintenance view (`R3TR VDAT <view>`, `OBJFUNC` `K`) and, beneath it,
   an `E071K` key sub-entry for the base table (`PGMID` `R3TR`, `OBJECT`
   `TABU`, `OBJNAME` = the table, `MASTERTYPE` = the resolved master type,
   `MASTERNAME` = the view, `TABKEY` = the client followed by the key,
   e.g. `001ZTMD`). `SORTFLAG` and `LANG` on that `E071K` row were both
   left initial (blank) by the function modules; `AS4POS` was `000001`.
   The row lands on the request itself, not on a task beneath it.
2. **`TR_OBJECTS_CHECK`, `TR_OBJECTS_INSERT`, and
   `TR_INSERT_REQUEST_WITH_TASKS` are now all live-proven from this
   server**, as of a sixth verification run on 2026-09-06.
   `TR_INSERT_REQUEST_WITH_TASKS` (used by `create_request`) was called
   from here first on 2026-09-05, and returned `sy-subrc = 0`, creating a
   real type-`W` customizing request. That first call did not pass
   `IT_USERS`, so the request came back with no task, and the generated
   code printed its error and returned before printing the request
   number — the number was lost and the request left orphaned. That
   defect is why `create_request` now has the shape described below. A
   second live call did pass `IT_USERS`, as a bare `sy-uname` row, and
   failed to activate outright — see the `create_request` bullet under
   "Mechanism" for the `SCTS_USER` structure that call was missing. With
   that structure filled in, the sixth run's call succeeded: it passed
   `TYPE = 'Q'` and the request came back carrying a task with
   `TASKTYPE = 'Q'`. That is consistent with the function module
   honouring the value passed, but not proof of it — a type-`W`
   request's task defaults to `'Q'` regardless of what `TYPE` asks for,
   so this call cannot distinguish the two; only passing a different
   `TYPE` and reading it back would settle it. `TR_OBJECTS_CHECK`
   and `TR_OBJECTS_INSERT` were proven the same run: an armed key-only
   `upsert` on `TB004` (view `V_TB004`, master type `VDAT`) called both
   successfully and filed a real transport entry, and a later `delete` of
   the same row also succeeded and added no second key row. Still
   unproven from here: every failure path on either CTS FM
   (`INSERT_FAILED`, `ENQUEUE_FAILED`, an authority or lock refusal).
3. **Every generated helper class goes into `$ZMCP_HELPERS`, never
   `$TMP`.** This is a dedicated, non-transportable local package created
   on first use (super-package `$TMP`, but `$TMP` itself is never a
   landing spot). If it cannot be created, the call is refused with a
   clear error — there is no silent fallback to `$TMP`.

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

- **`preview`** — resolves the target and runs `ZCL_ZMCP_IMG_WPROBE`, a
  generated helper that reads the table's client-dependence (`T000`), its
  DD02L/DD03L shape (delivery class, key fields), and the current values
  of the requested rows. Makes no change. It now runs the same plan
  validation `upsert`/`delete` enforce for real, so a row `preview`
  accepts is a row the armed call will accept too, and vice versa — the
  one exception is `corr_nr`/`confirm`, which `preview` still only reports
  as advisory notes, since nothing is being armed here either way.
- **`upsert`** / **`delete`** — the same checks as `preview`, now enforced:
  delivery class must be `C`, `G`, or `E` (`A`/`L`/`S`/`W` are SAP-delivered
  or system tables and are refused by name); `allow_cross_client: true`
  clears the policy refusal for a client-independent table, but this tool
  still cannot actually write one — see "What this does not do" below;
  row count must be 1–50; every key field's data type must be char-like
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
  change` rather than an empty set of fields. `confirm` must then exactly
  equal the resolved base table name — not the activity id, not the view
  name — to arm the call; without it, nothing is written. If the client
  requires a recorded change, `corr_nr` (a customizing request or task
  number) is required too. Once armed, `ZCL_ZMCP_IMG_WAPPLY` runs: per
  row, read the before-image, record the CTS entry (if `corr_nr` given),
  `MODIFY`/`DELETE`, `COMMIT WORK AND WAIT`, then re-read the after-image.
  A successful armed call discloses that CTS entry directly, under a
  `TRANSPORT ENTRY RECORDED` section, instead of leaving a caller to look
  up `E071K` separately — there is no tool in this server that reads
  `E071K` directly; `abap_data_preview` takes a bare `{table, object,
  max_rows}`, no WHERE clause or SQL of any kind. The section prints an
  identity line of the form `R3TR TABU <TABLE> (master <MASTERTYPE>
  <VIEW>)`, above a per-row table whose `tabkey` column carries the
  client and key together (e.g. `001ZTMD`). If the bridge transcript
  carried no `IMGW> CLIENT` line, `tabkey` renders unprefixed (the key
  portion alone) and a note says so, rather than fabricating a client.
  If the generated class fails to activate, none of that runs: the call
  returns `CHECK_FAILED` with the activation errors, the class name in
  `details.bridgeClass`, and `details.bridgeLeftBehind: true`. The class
  stays in `$ZMCP_HELPERS`, inactive — harmless, and safe to delete, but
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
- **`create_request`** — generates `ZCL_ZMCP_CTS_WREQ`, which calls
  `TR_INSERT_REQUEST_WITH_TASKS` to create a type-`W` (customizing)
  request, passing `IT_USERS` with one row so the request gets a task.
  `IT_USERS`' row type, `SCTS_USER`, is a structure with exactly two
  fields — `USER` (`TR_AS4USER`) and `TYPE` (`TRFUNCTION`), measured from
  DD40L/DD03L — not a plain user-name table; a second live run that
  passed a bare `sy-uname` failed to activate the bridge (`"SY-UNAME" and
  the row type of "LT_USERS" are incompatible`). The row now fills that
  structure (`USER` = `sy-uname`, `TYPE` = `'Q'`, the customizing task
  type), and the response carries the created task's number and its type
  (`taskType`) alongside the request number. The sixth live verification
  run (2026-09-06) passed `TYPE = 'Q'` and read back a task typed `'Q'`
  — consistent with the function module honouring the value passed, but
  not decisive: a type-`W` request's task is `'Q'` by default regardless
  of what `TYPE` asks for, so this single observation cannot tell the
  two apart. Only passing a different `TYPE` and reading it back would
  settle it. The request number is reported as soon as it is known,
  before the task check runs; a request that comes back with no task is a
  loud warning carrying the number, not a silent loss. A call whose
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

## Parameters

Every field name below is the literal wire key — pass it exactly as
written, snake_case included.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `mode` | enum `preview` \| `upsert` \| `delete` \| `create_request` | yes | — | Operation to perform. |
| `activity` | string | consultant path: exactly one of `activity`/`object`/`table`, for `preview`/`upsert`/`delete` | — | Same activity id `abap_img show` takes; resolved to its base table, key fields, and client field automatically. Conflicts with `key_fields`/`client_field`. |
| `object` | string | consultant path: exactly one of `activity`/`object`/`table`, for `preview`/`upsert`/`delete` | — | Same object name `abap_img objects` takes. Conflicts with `key_fields`/`client_field`. |
| `kind` | enum `table` \| `view` \| `cluster` \| `transaction` \| `customizing_object` \| `report` | optional, only meaningful with `object` | probed table → view → cluster → transaction → customizing object, first match wins | Which catalog to resolve `object` against. |
| `table` | string | expert escape hatch: exactly one of `activity`/`object`/`table`, for `preview`/`upsert`/`delete` | — | The base DDIC table to read/write directly, bypassing activity/object resolution. Requires `key_fields`. `client_field` is optional but the write always sets it from `sy-mandt`, so a genuinely client-independent table cannot be written this way — see "What this does not do". |
| `client_field` | string | `table` (expert escape hatch) only | `MANDT` | The table's client field name, e.g. `MANDT`. Conflicts with `activity`/`object`, whose client field is resolved automatically. |
| `key_fields` | array of string | `table` (expert escape hatch) only, at least one entry | — | The table's key field names, in order, excluding the client field. Conflicts with `activity`/`object`, whose key fields are resolved automatically. |
| `rows` | array of `{ key: {...}, values: {...} }` | required for `preview`/`upsert`/`delete` | — | Row key fields and, for `upsert`, the non-key values to write. `values` may be omitted entirely on an `upsert` row — see "Mechanism" for what a key-only row does. `delete` needs only `key`. 1–50 rows per call. |
| `view` | string | optional, for `upsert`/`delete` | resolved view/cluster name (or table, if the resolved target is a table); with `table`, defaults to `table` | The maintenance view or view cluster name recorded on the transport entry. |
| `master_type` | enum `VDAT` \| `CDAT` | optional, for `upsert`/`delete` | `VDAT` | The transport entry's object type — `VDAT` for a maintenance view, `CDAT` for a customizing object recorded directly. |
| `language` | string, regex `^[A-Za-z]$` | optional | the server's configured language (`ABAP_LANGUAGE`/`cfg.language`) if set, else `"E"` | Single-character SAP language key (SPRAS) the probe reads DD02L/DD03L texts in — e.g. `"E"` for English, `"D"` for German. A two-character ISO code such as `EN`/`DE` is refused (`BAD_INPUT`) naming the one-character form, not silently mapped — see `doc/TOOLS/abap-img.md`'s `language` row for why. The `preview` response header prints the resolved value. |
| `corr_nr` | string | required when the client's change setting demands a recorded change | — | Customizing request or task to record the write on. Get one via `create_request`, or reuse an existing one. |
| `confirm` | string | required to actually apply `upsert`/`delete` | — | Must exactly equal the resolved base table name (case-insensitive) to arm the write. Omitted (or on `preview`) means nothing changes. |
| `allow_cross_client` | boolean | no | `false` | Clears the policy refusal for a client-independent table; without it, a cross-client target is refused outright. Does not make the write possible — see "What this does not do". |
| `description` | string, max 60 chars | required for `create_request` | — | Short text for the new customizing request. |
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
  happen here. See point 1 above.
- Does not create an IMG node, activity, or maintenance view.
- Does not maintain any table outside the fixed delivery-class set
  (`C`/`G`/`E`); a SAP-delivered or system table is refused by name.
- **Cannot actually write a client-independent (cross-client) table**,
  `allow_cross_client: true` notwithstanding: the generated
  `ZCL_ZMCP_IMG_WAPPLY` unconditionally sets the table's client field from
  `sy-mandt`, and a genuinely client-independent table has no client field
  for it to set — the class fails to activate. `allow_cross_client` only
  clears the policy refusal; it does not make the write possible. Maintain
  a client-independent table by hand (SM30/SM34) instead.

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
