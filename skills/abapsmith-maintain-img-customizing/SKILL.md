---
name: abapsmith-maintain-img-customizing
description: Changes SAP IMG (SPRO) customizing values with abap_img_edit — preview an activity's current settings, then arm a change on a transport request. Use when asked to set, update, or remove a customizing value for an IMG activity, not to write ABAP code.
---

# Maintaining IMG customizing

This is for changing a **customizing value** behind an SPRO activity — the
kind of thing a functional consultant would otherwise open SM30 or the
activity's own maintenance screen for. It is not for writing ABAP, and it
is not the SM30 screen itself; read "What this is not" below before using
it on anything that matters.

You do not need to know a DDIC table name to use this. You need: the IMG
activity (or the maintenance view/transaction it opens), and the values
you want the affected row(s) to have.

## The workflow

1. **Find the activity.** Use `abap_img` exactly as in
   `abapsmith-browse-img-customizing` — `search` by words, or `tree` if you
   only know roughly where it sits in SPRO.
2. **See what it maintains.** `abap_img show` on the activity id names the
   maintenance object(s) (a view, view cluster, transaction, or table) and,
   for each, the underlying base table, whether it's client-dependent, and
   its delivery class. If the activity maintains more than one object, or
   the object spans more than one table, you'll be told so — name the
   object or table explicitly instead of the activity.
3. **Preview.** `abap_img_edit` with `mode: "preview"` and the same
   `activity`/`object` you just resolved, plus the row(s) you're
   interested in (by key). This makes no change — it shows the current
   values and tells you, in advance, whether a customizing request will be
   required and what to pass as `confirm`.
4. **Arm the change.** `mode: "upsert"` (or `"delete"`) with the same
   target and rows, the new `values`, a `corr_nr` if one was called for, and
   `confirm` set to exactly the base table name the preview named — not
   the activity id, not the view name. Without a matching `confirm`,
   nothing is written.
5. **Verify.** Re-run `preview` (or `abap_data_preview` against the
   resolved table) and check the after-image matches what you intended.
   Don't take a success response as the last word — see "What this is
   not" below.

## Customizing requests

Whether you need one depends on the client's own change-recording setting
— the same one that governs whether SM30 prompts you for a transport. When
it does, get a request number with `abap_img_edit`'s `mode:
"create_request"` (a short description, max 60 characters) and pass it as
`corr_nr` on the armed write. This is a genuine type-`W` customizing
request, transportable to QA/production the normal way — it does not live
on `abap_transport create`, because that path is for package-based
development objects and a customizing request has no package.

A successful `create_request` gives you back both a request number and a
task number under it — `corr_nr` uses the request number either way. If
the response instead warns that the request has no task, that number is
still what you'd pass as `corr_nr`, but whether a request with no task
actually accepts recorded rows is not established from here. Treat it as
untrustworthy: add a task to the request, or delete it and create
another, before relying on it for anything beyond your own immediate
write.

If `create_request` itself comes back as an error, don't just retry it —
a request may already have been created before the error happened. Look
for it first with `abap_transport list` in the customizing section,
matching the description you passed, and reuse or delete what you find
before creating another.

If the client's setting blocks customizing changes outright, the write is
refused before it gets anywhere near `confirm` — no request number fixes
that.

## Client-dependent vs. cross-client

`abap_img show`/`objects` names each table's client-dependence. A
client-dependent table's rows only affect the client you're working in — a
cross-client (client-independent) one affects every client on the system.
This tool cannot actually write a cross-client table at all: the generated
apply class always sets the table's client field from `sy-mandt`, and a
genuinely client-independent table has no client field for it to set, so
the class fails to activate. `allow_cross_client: true` only clears this
tool's own policy refusal — it does not make the write work. Maintain a
cross-client table by hand (SM30/SM34) instead.

## Never touch a SAP-delivered entry

Only tables in the customizing delivery classes (`C`, `G`, `E`) can be
written at all — anything SAP ships and maintains itself (delivery classes
`A`, `L`, `S`, `W`: application tables, system tables) is refused by name,
the same rule SM30 itself enforces by locking those entries down. If
`abap_img objects` shows a delivery class outside `C`/`G`/`E` for the
table you're after, stop — there is no override, and there shouldn't be:
that's SAP's own content, not a customer's.

## What this is not

This is **not** the SM30 maintenance screen. A row is written directly to
the base table with a guarded update — the screen's own checks (foreign-key
lookups, allowed-value checks, and anything the view's table-maintenance
generator would otherwise trigger, like a dependent recalculation) do
**not** run. In practice this means: it will happily write a value SM30's
own dropdown would have refused to offer you, if that value happens to
satisfy every check *this* tool applies. For anything where you're not
certain the value is valid on its own terms, check with SM30 (or ask
someone who owns that customizing area) before relying on a write made
this way — especially the first few times.

It is also only partly proven by a live run from this server. Creating a
customizing request (`create_request`) has been tried live here once, and
succeeded — but a first-run defect meant a task-less request's number
nearly went unreported, which is why the guidance above tells you to
watch for a task-less warning and to check `abap_transport list` after an
error rather than just retrying. Recording a change onto that request
(the transport bookkeeping behind `upsert`/`delete`) has not been tried
live from here: it calls ordinary, heavily-used standard SAP function
modules that SM30 and the rest of CTS call constantly, but this server
has only ever read their interfaces from the system's own catalogue, not
confirmed them by a call made from here. Treat a clean-looking
`upsert`/`delete` response as "the call completed without an error", not
as independent confirmation the request now holds what you expect; check
the request's contents (or ask whoever manages transports) before
relying on it moving anything to QA correctly.

## Worked example

`abap_img` calls first, to find and confirm the target:

```json
{ "mode": "search", "query": "document type defaults" }
{ "mode": "show", "activity": "ZACT1" }
```

then, once `show` resolves exactly one table, `abap_img_edit` calls —
`activity`/`object` in, never a raw table name, unless you already know
the DDIC shape (see "Never touch a SAP-delivered entry" for why a table
outside `C`/`G`/`E` is refused regardless):

```json
{ "mode": "preview", "activity": "ZACT1", "rows": [{ "key": { "ZFLD": "0001" } }] }
```

if a request is called for:

```json
{ "mode": "create_request", "description": "Adjust document type default" }
```

Check the response for a task number alongside the request number before
using it — a task-less warning means that number is what you'd pass as
`corr_nr`, but whether a request with no task actually accepts recorded
rows isn't established from here, so add a task first (or delete the
request and create another); an error means look for the request with
`abap_transport list` before creating another. Then arm the write, with
`confirm` set to the base table name `preview` named (`ZTAB1` here, not
the activity id):

```json
{
  "mode": "upsert",
  "activity": "ZACT1",
  "rows": [{ "key": { "ZFLD": "0001" }, "values": { "ZVAL": "NEW VALUE" } }],
  "corr_nr": "A4HK900001",
  "confirm": "ZTAB1"
}
```

and, to remove a row the same way:

```json
{
  "mode": "delete",
  "activity": "ZACT1",
  "rows": [{ "key": { "ZFLD": "0001" } }],
  "corr_nr": "A4HK900001",
  "confirm": "ZTAB1"
}
```

Every activity id, table name, field name, and transport number above is
a placeholder — none of these has been observed against a real system;
substitute whatever `abap_img` actually resolved. If you already know the
target table's key fields and client field, `table`/`key_fields`/
`client_field` can replace `activity`/`object` on any `abap_img_edit`
call above — see `doc/TOOLS/abap-img-edit.md` for that expert path.

## Availability

`abap_img_edit` is a real write and needs `ABAP_MODE=edit` or higher — it
is absent from `tools/list` under `read`, unlike `abap_img` itself. It is
v1-only — as of this build it has no v2 (`abap_do`) action. Check
`tools/list` before assuming it exists under `ABAP_TOOL_SURFACE=v2`.

## Where this fits

| Task | Skill |
|---|---|
| Just looking, not changing anything | `abapsmith-browse-img-customizing` |
| Read the current rows without changing them | `abap_data_preview`, via `abapsmith-browse-img-customizing` |
| Get a transport for non-customizing objects, or release one | `abapsmith-put-work-on-a-transport` |
