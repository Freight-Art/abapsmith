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
   each row's base-table key.
2. **This server has never itself called any of the function modules this
   tool relies on.** `TR_OBJECTS_CHECK`, `TR_OBJECTS_INSERT`, and
   `TR_INSERT_REQUEST_WITH_TASKS` (used by `create_request`) are ordinary,
   heavily-used SAP function modules — SM30 and the CTS call them
   routinely — but abapsmith has only ever read their interfaces from the
   system's own function-module catalogue, never proven them by a run from
   here. Every response says "not proven" rather than implying otherwise
   anywhere this matters.
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
name the object or table explicitly rather than the activity.

- **`preview`** — resolves the target and runs `ZCL_ZMCP_IMG_WPROBE`, a
  generated helper that reads the table's client-dependence (`T000`), its
  DD02L/DD03L shape (delivery class, key fields), and the current values
  of the requested rows. Makes no change. Everything `upsert`/`delete`
  would refuse as a hard error is reported here too, but as advisory notes
  — `corr_nr`/`confirm` requirements included — never as a refusal, since
  nothing is being armed.
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
  `confirm` must then exactly equal the resolved base table name — not the
  activity id, not the view name — to arm the call; without it, nothing is
  written. If the client requires a recorded change, `corr_nr` (a
  customizing request or task number) is required too. Once armed,
  `ZCL_ZMCP_IMG_WAPPLY` runs: per row, read the before-image, record the
  CTS entry (if `corr_nr` given), `MODIFY`/`DELETE`, `COMMIT WORK AND WAIT`,
  then re-read the after-image.
- **`create_request`** — generates `ZCL_ZMCP_CTS_WREQ`, which calls
  `TR_INSERT_REQUEST_WITH_TASKS` to create a type-`W` (customizing)
  request. This lives here rather than on `abap_transport create` because
  that tool's create is package-driven — it requires a package, refuses a
  local (`$`) one, and checks the package allowlist — and none of that is
  meaningful for a customizing request, which has no development class at
  all.

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
| `rows` | array of `{ key: {...}, values: {...} }` | required for `preview`/`upsert`/`delete` | — | Row key fields and, for `upsert`, the non-key values to write. `delete` needs only `key`. 1–50 rows per call. |
| `view` | string | optional, for `upsert`/`delete` | resolved view/cluster name (or table, if the resolved target is a table); with `table`, defaults to `table` | The maintenance view or view cluster name recorded on the transport entry. |
| `master_type` | enum `VDAT` \| `CDAT` | optional, for `upsert`/`delete` | `VDAT` | The transport entry's object type — `VDAT` for a maintenance view, `CDAT` for a customizing object recorded directly. |
| `language` | string, regex `^[A-Za-z]{1,2}$` | optional | `EN` | Language the probe reads DD02L/DD03L texts in. |
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
- Row-write behavior is not live-proven — see point 2 above.
