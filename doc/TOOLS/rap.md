# abap_rap

Generate a complete RAP stack from an existing transparent table: root CDS
view, projection view, behavior definition(s), the behavior implementation
class, a service definition and an OData V2/V4 service binding — written in
dependency order through the same write path `abap_write` uses, one call.
Names are derived from a single prefix (or given explicitly), fields are
read off the table and mapped automatically, and `dry_run` returns every
generated source plus a field-coverage summary without writing anything.
Publishing the binding is a separate step, unchanged: `abap_service
op="publish"`.

**Availability**: case 4 — a read-only v1 server registers `abap_rap` as a
mode-locked refusal stub instead of skipping it: still listed, refuses
every call `READ_ONLY` before reaching SAP. The real tool needs
`canWrite`, the same ceiling as `abap_write`.

## Parameters

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `table` | string | — | Transparent table (`TABL/DT`) to build the stack from. Required. |
| `package` | string | — | Target package for every generated artifact. Required. |
| `name_prefix` | string | — | Stem the six names are derived from, e.g. `ZAS_BK197` (customer namespace `Z`/`Y` or `/NS/` plus a stem). Required unless `names` supplies every name. |
| `names` | object | — | Explicit overrides: `root_view`, `projection_view`, `behaviour_class`, `service_definition`, `service_binding`, `draft_table`, `root_sql_view`, `projection_sql_view`. Each is optional and replaces the corresponding derived name. |
| `flavour` | enum `managed` \| `unmanaged` | `managed` | Behavior definition style. |
| `draft` | boolean | `false` | Add a draft table, `with draft`/`use draft`, and the five standard draft actions. |
| `service_binding_type` | enum `OData V2` \| `OData V4` | `OData V4` | Binding protocol version; also picks the `_O2`/`_O4` name suffix when the binding name is derived. |
| `include_projection` | boolean | `true` | Generate the projection view and its own behavior definition. `false` exposes the root view directly from the service definition. |
| `cds_form` | enum `entity` \| `classic` | `entity` | `entity` writes `define root view entity` with `provider contract transactional_query`. `classic` writes `define root view` with `@AbapCatalog.sqlViewName` and no provider contract — see "Older releases: `cds_form: \"classic\"`" below. |
| `dry_run` | boolean | `false` | Return every generated source and the consistency summary; write nothing. |
| `corr_nr` | string | — | Transport request, passed through to every write exactly as `abap_write` accepts it. |
| `activate` | boolean | `true` | Activate each artifact after writing it. |

## Derived names

Given `name_prefix: "ZAS_BK197"` (namespace `Z`, stem `AS_BK197`):

| Derived name | Value |
|---|---|
| Root view (`DDLS/DF`, and its `BDEF/BDO`) | `ZI_AS_BK197` |
| Projection view (`DDLS/DF`, and its own `BDEF/BDO`) | `ZC_AS_BK197` |
| Behavior implementation class (`CLAS/OC`) | `ZBP_AS_BK197` |
| Service definition (`SRVD/SRV`) | `ZUI_AS_BK197` |
| Service binding (`SRVB/SVB`) | `ZUI_AS_BK197_O4` (`service_binding_type: "OData V4"`, the default) or `ZUI_AS_BK197_O2` (`"OData V2"`) |
| Draft table (`TABL/DT`, only when `draft: true`) | `ZAS_BK197_D` |

A namespaced prefix (`/NS/BK197`) works the same way, with `/NS/` in place
of `Z`. The service binding name is capped at 26 characters and the draft
table name at 16; a derived name that overflows either limit is refused
`BAD_INPUT` before any request rather than silently truncated — pass the
matching key in `names` to give it an explicit, shorter name instead. Any
key in `names` overrides the corresponding derived name outright (and is
uppercased); the rest are still derived from `name_prefix` as usual, so a
partial `names` object is fine.

## Artifact order

Artifacts are written in this order — a dependency later in the list may
reference one earlier, never the reverse:

| # | Artifact | Type | Name | Written when |
|---|---|---|---|---|
| 1 | Draft table | `TABL/DT` | draft table | `draft: true` |
| 2 | Root view | `DDLS/DF` | root view | always |
| 3 | Root behavior definition | `BDEF/BDO` | root view's name | always |
| 4 | Projection view | `DDLS/DF` | projection view | `include_projection: true` (default) |
| 5 | Projection behavior definition | `BDEF/BDO` | projection view's name | `include_projection: true` |
| 6 | Behavior implementation class — main | `CLAS/OC` | behavior implementation class | always |
| 7 | Behavior implementation class — implementations include | `CLAS/OC` (`include=implementations`) | same name as 6 | always |
| 8 | Service definition | `SRVD/SRV` | service definition | always |
| 9 | Service binding | `SRVB/SVB` | service binding | always |

A behavior definition's name is the CDS view it is attached to, not a name
of its own — the root `BDEF/BDO` and the projection `BDEF/BDO` reuse the
view names from rows 2 and 4.

## What each flavour and `draft` generate

**`managed` (default).** The root behavior definition declares `persistent
table <table>`, `lock master`, `authorization master ( instance )`, and a
`mapping` block with one line per non-client field (CDS alias on the left,
lowercase table field on the right). Every non-client key field is marked
`field ( readonly )`. When the table has a field that looks like a
last-changed timestamp (name matching `LAST_CHANGED_AT`/`LASTCHANGE`/
`…CHANGED_AT`, or type `timestampl`/`abp_lastchange_tstmpl` with "CHANG" in
the name), that field's alias becomes the `etag master`. The implementations
include declares and implements `get_instance_authorizations` on a local
handler class inheriting from `cl_abap_behavior_handler`, with an empty
method body.

**`draft: true`** adds, on top of whichever flavour is chosen: the draft
table (artifact 1, with the standard `%admin` include
`sych_bdl_draft_admin_inc`), `with draft;` and `draft table <draft_table>`
in the root behavior definition, `lock master total etag <etag field>`
(the `etag master` line stays) when a timestamp field was found — draft
needs a total etag, so the summary adds a note when no timestamp field
exists, and the five standard draft actions (`draft action Edit`,
`Activate`, `Discard`, `Resume`, and `draft determine action Prepare`). The
projection behavior definition gets `use draft;` and the matching `use
action` lines. Draft is legal with `flavour: "unmanaged"` too; the summary
then adds a note that the saver/handler must implement draft persistence
itself — generating the draft table and the BDEF draft clauses does not
give an unmanaged implementation draft behavior for free.

**`unmanaged`.** The root behavior definition drops `persistent table` and
`authorization master`; it keeps `lock master`, `etag master`, the
readonly key fields, the mapping, and — with `draft: true` — the same
draft clauses and draft actions as the managed flavour (see above). The
implementations include declares a handler
with empty `create`/`update`/`delete`/`read`/`lock` method skeletons
instead of `get_instance_authorizations`, plus a saver class
(`cl_abap_behavior_saver` subclass) with empty
`finalize`/`check_before_save`/`save`/`cleanup`/`cleanup_finalize`
redefinitions. Nothing is implemented — persistence logic is yours to
write afterwards.

## Client fields are handled implicitly

A field is treated as the client field when its type is `abap.clnt` (or its
name is `MANDT`/`CLIENT`). It is left out of the CDS view entirely (view
entities forbid listing the client field) and out of the behavior
definition's `mapping` block. The consistency summary still reports it, as
`role: "client"`, `"handled implicitly"` — it is accounted for, just not
emitted anywhere.

## `dry_run`

`dry_run: true` runs the same name derivation and field read as a real
call, and the same preflight safety check against every artifact that
would be written — a refusal (read-only mode, a package outside the
allowlist, an SAP-namespace name) is reported the same way, before any
network call, whether or not `dry_run` is set. What differs is after that
gate: no write is attempted. The response contains every generated source
(all nine artifacts, or fewer when `draft`/`include_projection` are off),
the consistency summary (one row per field: name, type, role, CDS alias,
whether it landed in the view and the mapping), and a header field
`writes: 0`. Read it before committing — in particular
`all_fields_covered`, which is `false` when some non-client field ended up
in neither the view nor the mapping.

## Stops at the first failing write

A real run writes artifacts one at a time, in the order above. The first
write that fails stops the whole call: nothing after it is attempted. The
error is `RAP_PARTIAL`, and `details.artifacts` lists every artifact's
status — `written`/`activated` for what already succeeded, `failed` (with
the underlying cause) for the one that broke, and `not attempted` for
everything still queued behind it. Fix the cause and call `abap_rap`
again with the same arguments: names are derived the same way from the
same `name_prefix`/`names`, so the rerun writes the same names in place —
already-written artifacts are simply rewritten, not duplicated or left
orphaned.

## Journal

Every successful write goes through `abap_write`'s own write path, so it
is journalled exactly like a normal `abap_write` call, tagged with the
tool label `abap_rap`. That means one journal entry per written artifact —
except the behavior implementation class, which is two entries (the main
source and the `implementations` include are separate writes, and separate
journal entries). `abap_journal mode=list` shows them in the order they
were written; `abap_journal mode=undo` reverses any one of them exactly as
it would an `abap_write`-produced entry — there is nothing `abap_rap`-
specific about undo. Undoing an early artifact (say, the root view) while
later artifacts still reference it is your call to make; abapsmith does
not sequence undos for you.

## Binding URL and publishing

After the service binding is written and activated, the response reports
`service_binding_url` when it could be resolved — the same binding-to-
catalogue resolution `abap_service` performs. The binding being written
does not make the service reachable: publishing is a separate, gated step,
unchanged from any other binding — `abap_service op="publish"
binding="<service_binding>" confirm="<service_binding>"`. Call it without
`confirm` first for a dry run, then with `confirm` to actually publish; see
[abap-service.md](abap-service.md#publishing-and-unpublishing) for the gate
and the URL it returns.

## Older releases: `cds_form: "classic"`

`cds_form: "entity"` (the default) writes `define root view entity …
provider contract transactional_query …`, the current syntax; A4H
(`SAP_BASIS` 754 or newer) accepts it. Releases before 7.55 reject both
`define … view entity` and `provider contract` as syntax errors. Pass
`cds_form: "classic"` there: it writes `define root view …` (no `entity`,
no provider contract) and adds `@AbapCatalog.sqlViewName: '<name>'` to the
root and projection views, using the `root_sql_view`/`projection_sql_view`
names (derived by truncating the view name to 16 characters, or overridden
via `names`). Nothing else about the stack changes — the behavior
definitions, class, service definition and binding are identical either
way.

## Limitations

- One entity per call. `abap_rap` builds a single root (plus optional
  projection) — it does not compose a multi-node business object.
- No associations or compositions between entities.
- No metadata extension (`DDLX/EX`) and no access control (`DCLS/DL`) are
  generated.
- No managed numbering (no `ObjectID` / early-numbering clauses) and no
  authorization control beyond the bare `authorization master ( instance )`
  line for managed stacks.
- Edit the generated sources afterwards with `abap_write` — for anything
  outside what's listed above (associations, an `DDLX/EX`, numbering,
  additional actions or determinations), write it directly against the
  artifact `abap_rap` created, the same way you would hand-edit any RAP
  object. `abapsmith-create-a-rap-service` covers the per-artifact
  constraints that still apply.

## Worked example

Check first, with `dry_run`:

```json
{
  "table": "ZAS_BK197",
  "package": "$TMP",
  "name_prefix": "ZAS_BK197",
  "draft": true,
  "dry_run": true
}
```

Read `all_fields_covered` and the per-field roles in the response, then run
for real, same arguments minus `dry_run` (add `corr_nr` when the package is
transportable and the server does not pick a request automatically):

```json
{
  "table": "ZAS_BK197",
  "package": "$TMP",
  "name_prefix": "ZAS_BK197",
  "draft": true
}
```
