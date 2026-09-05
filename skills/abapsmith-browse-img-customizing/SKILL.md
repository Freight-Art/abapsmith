---
name: abapsmith-browse-img-customizing
description: Browses the SAP IMG (SPRO) customizing structure with abap_img — activities, their tree position, and the tables behind them. Use when asked what a customizing activity does, where a setting lives, or which table backs a view/transaction.
---

# Browsing IMG customizing

The IMG (what SPRO opens) is a tree of folders and activities covering every
customizing area of the system. An **activity** is one named unit of
customizing work — a leaf in that tree, not a table. Behind an activity sit
one or more **maintenance objects**: a view, a view cluster, a transaction,
a table, a report, or a generic "customizing object". Behind those sit the
actual **DDIC tables** that hold the customizing rows a functional
consultant would edit through SM30/SPRO. `abap_img` walks this chain —
activity → maintenance object → table — and stops there. It never reads a
row.

## The navigation loop

- **`search`** — you have words or an id; a bare term matches as a
  substring, so plain words work directly. Fastest path when you can guess
  vocabulary ("output determination", "number range").
- **`tree`** — you don't know the vocabulary. Lists one level of
  reference-IMG node children per call; omit `node` for the root. Walk down
  a level at a time.
- **`show`** — you have an activity id (from `search` or `tree`) and want
  its maintenance objects and tables.
- **`objects`** — you already have a view/cluster/table/customizing-object
  name (not an activity id) and want its underlying tables, key fields and
  client-dependence directly, skipping the activity.

`search` and `tree` page via `offset`/`limit`; a response note says whether
more rows follow. `show` and `objects` are not paged — one activity or
object per call.

## The handoff to reading rows

`abap_img` never reads a customizing row — only structure. To read rows
behind a resolved table, use `abap_data_preview` (the tool itself names it
in a `next` hint whenever `show`/`objects` resolves exactly one table).
That tool is a separate, much more restricted surface:

- Registered only when `ABAP_ALLOW_DATA_PREVIEW=true` — off by default.
- Refuses outright on a system that reports itself productive, or that
  cannot be proven otherwise.
- **Has no WHERE filter of any kind.** A preview is always the first N rows
  of the whole table, full stop.
- Denies a built-in list of tables (credentials, payroll/HR, accounting
  documents, personal data) that no setting can shrink.

That "first N rows, no filter" limit means `abap_data_preview` is **useless**
for a table with millions of rows and a targeted question ("find the entry
for company code 1000") — it will hand back an arbitrary early slice, not
the row you want. It answers "what does this table's structure/first rows
look like", not "what is this specific customizing value".

## Worked examples

Search for an activity, confirm its table, then preview rows:

```json
{ "mode": "search", "query": "SOME_CUSTOMIZING_TOPIC" }
{ "mode": "show", "activity": "SOME_ACTIVITY_ID" }
```
then, once `show` resolves exactly one table:
```
abap_data_preview { "table": "SOME_RESOLVED_TABLE" }
```

Browse when you don't know where something lives:

```json
{ "mode": "tree" }
{ "mode": "tree", "node": "SOME_NODE_ID_FROM_PREVIOUS_CALL" }
{ "mode": "show", "activity": "SOME_ACTIVITY_ID_FOUND_IN_TREE" }
```

Jump straight to a known view's tables, skipping the activity entirely:

```json
{ "mode": "objects", "object": "SOME_VIEW_OR_TABLE_NAME" }
```

Every id above is a placeholder — none of these names has been observed
against a real system; substitute whatever `search`/`tree` actually returns.

## The load-bearing caveat

No catalog table or field name `abap_img` queries has been confirmed
against a live SAP system (`IMG_CATALOG_VERIFIED` is `false` in
`src/adt/img-catalog.ts`). Every single response says so, naming the
specific unconfirmed tables it read against. Treat an empty result from a
low-confidence table as **"the name may be wrong"**, not as "the IMG has
nothing there" — check the note block on the response before concluding a
search or tree call found nothing.

## Availability

Absent from `tools/list` under `ABAP_MODE=read`: `abap_img` is read-only in
effect, but its first call per mode deploys and activates a `$TMP` bridge
class, which is itself a write.

`abap_img` and `abap_data_preview` are v1-only — as of this build neither
has a v2 (`abap_do`) action. Check `tools/list` rather than assuming either
is there under `ABAP_TOOL_SURFACE=v2`.
