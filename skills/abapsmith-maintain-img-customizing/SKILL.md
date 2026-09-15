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
   required and what to pass as `confirm`. `preview` now checks a row the
   same way the armed call does, so a row it accepts here is one `upsert`/
   `delete` will accept too — including refusing a row it would once have
   just shown you, for example one naming a value field the table doesn't
   have.
4. **Arm the change.** `mode: "upsert"` (or `"delete"`) with the same
   target and rows, the new `values`, a `corr_nr` if one was called for, and
   `confirm` set to exactly the base table name the preview named — not
   the activity id, not the view name. Without a matching `confirm`,
   nothing is written. If this step fails and the error says the generated
   class was left behind and is safe to delete, nothing was written and no
   transport entry was filed — fix whatever the error describes and retry.
   If instead the error warns that the request may already have executed
   and the response was lost, do not retry blindly: re-run `preview` (or
   check the rows directly) to see whether the change already went through
   before doing anything else. A third shape: if the error says the write
   could not be confirmed, check `mayHaveExecuted` in the error's
   details — `true` means re-read the rows before touching anything
   further; `false` means no marker showed a write even starting, but
   re-read the rows anyway rather than trusting that. Either way, the tool
   itself now refuses to report an unconfirmed write as a success.
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
task number (plus the task's type, `taskType`) under it — `corr_nr` uses
the request number either way. If the response instead warns that the
request has no task, that number is still what you'd pass as `corr_nr`,
but whether a request with no task actually accepts recorded rows is not
established from here. Treat it as untrustworthy: add a task to the
request, or delete it and create another, before relying on it for
anything beyond your own immediate write.

If `create_request` itself comes back as an error, don't just retry it —
a request may already have been created before the error happened. Look
for it first with `abap_transport list` in the customizing section,
matching the description you passed, and reuse or delete what you find
before creating another.

If the client's setting blocks customizing changes outright, the write is
refused before it gets anywhere near `confirm` — no request number fixes
that.

## Removing a recorded entry from the request

A customizing write files two rows on the request: an `E071` header for
the **maintenance view**, and an `E071K` key sub-entry beneath it for the
base table you actually wrote. `abap_transport`'s `removeObject`
operation resolves the object you name against a request's `E071` header
rows only — so if you need to back a row out of the request (say the
`upsert` that filed it was a mistake), pass the **view name**, not the
base table name: `abap_transport {"operation": "removeObject", "transport":
"<request>", "object": "V_TB004", "confirm": "<request>"}`, not
`"object": "TB004"`. Naming the table (or a text-table variant like
`TB004T`) answers `NOT_FOUND` — correctly: there is no `E071` header
entry for the table itself, only the `E071K` sub-entry beneath the
view's. Removing the view's header entry takes that `E071K` sub-entry
with it. The view name to pass is the same one `abap_img_edit` resolved
and reported — `view` in your call, or the name `show`/`preview` named.

## Language

If you pass `language` (on `preview`/`upsert`/`delete`, to control what
language DD02L/DD03L texts come back in), use the one-character SAP
language key — `E` for English, `D` for German — not the two-letter ISO
code (`EN`, `DE`) you'd type into most other systems. A two-letter value
is refused outright rather than guessed at, because mapping ISO codes to
SAP keys is installation-specific customizing, not something this tool
can assume. Leave `language` unset unless you have a reason to change
it — the default is already the single-letter SAP key.

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

## Adding a row with nothing else to set

Some customizing tables have no required columns beyond the key — every
other column is optional, so the SM30 equivalent of "add this entry" is
typing in just the key and leaving the rest blank. `TB004` (Business
Partner types, key `BPKIND`) is like this: its only non-key columns are
seven optional field-status-list fields.

For a table like that, an `upsert` row can name `key` alone and omit
`values` entirely. If the row doesn't already exist, it's inserted with
the key (and the client) set and everything else left at its initial
value — the same result SM30 gives you for a bare new entry. If the row
already exists, nothing is changed, and the per-row result reads
`changed: no` with the text `row exists, no value fields to write`. Read
that as success: the row was already there, and there was nothing this
call was asked to set on it.

This only makes sense on a table where every non-key column really is
optional — check with `abap_img show`/`objects` (or SM30 itself) first.
The tool has no notion of a "required" non-key column and will not stop
you from sending a key-only row to a table that genuinely needs a value
set — that judgement is the consultant's to make, not something this
validation catches.

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

This is now proven by live runs from this server, not just partly.
Creating a customizing request (`create_request`) has been tried live
here twice: a first run's defect meant a task-less request's number
nearly went unreported, which is why the guidance above tells you to
watch for a task-less warning and to check `abap_transport list` after an
error rather than just retrying; a sixth verification run, on
2026-09-06, created a real type-`W` request carrying a type-`Q` task,
with no such defect. Recording a change onto that request (the transport
bookkeeping behind `upsert`/`delete`) has now been tried live too: that
same run's armed `upsert` on `TB004` called the same two CTS function
modules SM30 and the rest of CTS call constantly, filed a real transport
entry, and a later `delete` of the same row succeeded as well, adding no
second key row. A clean-looking `upsert`/`delete` response is no longer
just "the call completed without an error" — the response itself now
discloses the transport entry it filed (see
`doc/TOOLS/abap-img-edit.md` for the exact shape). It's still worth
checking the request's contents yourself (or asking whoever manages
transports) before relying on it moving anything to QA correctly — this
server's disclosure is not a QA-side review, just no longer the only
source of truth about what was recorded.

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
is absent from `tools/list` under `read`, unlike `abap_img` itself.

A call can also be refused with `write-lockout` ("No system-role probe
has confirmed this system is non-productive yet") if nothing has yet
confirmed the system is non-productive — this is the safety gate working
as intended on a genuinely unconfirmed or productive system, not a bug to
work around. In the ordinary case it clears itself: any earlier call that
connects (a read, or an earlier `abap_img_edit` call) settles the
verdict, so seeing it persist across multiple calls on a system you
believe is non-productive is worth raising rather than retrying blindly.

## Where this fits

| Task | Skill |
|---|---|
| Just looking, not changing anything | `abapsmith-browse-img-customizing` |
| Read the current rows without changing them | `abap_data_preview`, via `abapsmith-browse-img-customizing` |
| Get a transport for non-customizing objects, or release one | `abapsmith-put-work-on-a-transport` |
