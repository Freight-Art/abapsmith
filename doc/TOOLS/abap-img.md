# abap_img

Reads SAP IMG (SPRO customizing) catalog entries: activities, their
reference-IMG tree position, and the maintenance objects/tables an activity
or object points at. It is a map of the structure, not a way into it —
`abap_img` reads catalog rows only; it never reads or writes a customizing
entry, creates an IMG node, or generates a maintenance dialog. Changing a
customizing entry is `abap_img_edit`'s job — see `doc/TOOLS/abap-img-edit.md`.

**Mechanism**: ADT has no IMG REST route and no free-form SQL route either.
Every mode sends a fixed, catalog-driven `SELECT` — table and field names
taken only from `IMG_CATALOG` (`src/adt/img-catalog.ts`), never from caller
text — to the ADT freestyle data-preview endpoint
(`POST /sap/bc/adt/datapreview/freestyle`, `src/adt/img-query.ts`). No ABAP
is generated, nothing is deployed, and no object is created. Caller values
(`query`, `activity`, `node`, `object`, `kind`, `language`) reach the
statement only as length/charset-checked literals substituted into a WHERE
clause the server built (`assertSqlValue`, `assertInList`); a caller can
never supply or influence SQL syntax itself.

**Availability**: because nothing is deployed and nothing is written,
`abap_img` needs no write access at all and is registered under
`ABAP_MODE=read`. This is a change from the previous, now-removed mechanism
(a generated `IF_OO_ADT_CLASSRUN` bridge class deployed to `$TMP`, gated as
a write like `abap_fpm_read`) — that mechanism required write access purely
to deploy the bridge, even though every call after the first was itself a
pure read; the freestyle endpoint has no such requirement.

## What it reads

Every mode queries catalog tables named in `IMG_CATALOG`
(`src/adt/img-catalog.ts`) — that file is the only thing the query builders
in `src/adt/img-query.ts` consult for table/field names, and it is the one
file that changes when a name is corrected.

**Catalog confidence.** Every entry in `IMG_CATALOG` is `confidence: "high"`,
measured against a live system on 2026-09-05 (`IMG_CATALOG_VERIFIED` is
`true`). Two earlier, wrong guesses at the tree tables (`imgNode`,
`imgStructure`) have been removed from the catalog entirely, not merely
demoted — the real tree tables (`imgTreeNode`/`TNODEIMG`,
`imgTreeNodeText`/`TNODEIMGT`, `imgTreeNodeRef`/`TNODEIMGR`,
`treeDirectory`/`TTREE`) are what every tree query actually uses.
`lowConfidenceTables()` returns an empty list today — kept as a live
regression check, so a future low-confidence entry is still caught there
rather than only in prose.

## Parameters

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `mode` | enum `search` \| `show` \| `tree` \| `objects` | yes | — | `search`: find activities by title/id text. `show`: one activity's reference-IMG path, maintenance objects and tables. `tree`: the reference-IMG node children under a node. `objects`: a view/cluster/table/customizing object's underlying DDIC tables and fields. |
| `query` | string | `search` only | — | A term with no `*` matches as a substring of the title or id; `*` is an explicit wildcard, and `"*"` alone matches everything. |
| `activity` | string | required for `show` | — | IMG activity id to display. |
| `node` | string | `tree` only | reference-IMG root | Reference-IMG node to list children of; omit for the root. |
| `object` | string | required for `objects` | — | A view, view cluster, table, or customizing-object name (not an activity id). |
| `kind` | enum `view` \| `cluster` \| `transaction` \| `table` \| `report` \| `customizing_object` \| `unknown` | `objects` only, optional | — | Hint for what kind `object` is, used when the name is ambiguous. |
| `language` | string, regex `^[A-Za-z]{1,2}$` | no | the server's configured language (`ABAP_LANGUAGE`/`cfg.language`) if set, else `"E"` | Language code for description/text lookups. |
| `after` | string | `search`/`tree` only | unset (first page) | Opaque keyset cursor from a previous response's paging note. The freestyle endpoint has no `OFFSET`, so paging is forward-only by key, not by position. |
| `limit` | integer, `.int().min(1)` | `search`/`tree` only | `IMG_PAGE_DEFAULT`, clamped to `IMG_PAGE_MAX` | Max rows to return. |

Every field not valid for the given `mode` is rejected outright
(`BAD_INPUT`, naming the field and the mode) rather than silently ignored —
e.g. `activity` on a `search` call, or `after` on a `show` call.

## Modes

### search

Find activities whose title or id matches `query`. A term with no `*`
matches as a substring; `*` is an explicit wildcard.

```json
{ "mode": "search", "query": "output determination" }
```

Body is an ACTIVITIES table (`activity`, `title`, `objects` count, `nodes`
count). Paged by `after`/`limit` — the notes carry the cursor to pass as
`after` for the next page, never a promise that no more rows exist beyond
it.

### show

Return one activity's reference-IMG path, maintenance objects and tables.

```json
{ "mode": "show", "activity": "SOME_ACTIVITY_ID" }
```

A TABLES section lists each maintenance object's underlying table
(`object`, `table`, `client_dependent`, `delivery_class`, `via`); a DOCUMENTATION section
lists each linked activity and its documentation id (`activity: docId`).
Body is a MAINTENANCE OBJECTS table (`kind`, `name`, `title`). When exactly
one table resolves, the notes carry a `next` hint naming `abap_data_preview`
against that table — see "Reading and changing the entries" below for how
to then change it with `abap_img_edit`. An activity behind several
maintenance objects, or an object spanning several base tables, is
ordinary — not an error; the notes then explain the ambiguity in words
("this activity maintains N distinct objects — ... — a write must name one
explicitly") rather than guessing.

### tree

List the reference-IMG node children under `node`, or the root when `node`
is omitted.

```json
{ "mode": "tree", "node": "SOME_NODE_ID" }
```

Body is a NODES table (`node`, `kind`, `children` count, `title`) — one
level of children per call, paged by `after`/`limit`, not a recursive dump
of the whole subtree. The header's `treeId` names the tree the returned
nodes actually belong to; it is `null` only when the root probe found
nothing. Some tree nodes are REF mounts pointing into a different tree —
following one of those redirects `treeId` away from whatever the caller
passed in (or the probed default), which is expected, not an error: the
listed children genuinely live in the mounted tree.

**Finding the root.** The reference-IMG tree has no mnemonic id — `TTREE.ID`
is a GUID that differs per system, and a `WHERE id IN ('SIMG', 'IMG', ...)`
probe against well-known candidates returned zero rows. The root is instead
found by matching the English title text "SAP Customizing Implementation
Guide" against `TNODEIMGT` (`IMG_TREE_TEXT_PROBE`, `src/adt/img-catalog.ts`).
**This means `tree` finds nothing — not an error, an empty result — on a
system whose customizing text is not in English.** If a `tree` call with no
`node` comes back empty, that is the first thing to suspect, not a broken
catalog table.

Child order within a level follows `TNODEIMG.BROTHER_ID`, which names a
node's *previous* sibling, not its next one — the first child is the one
whose own `BROTHER_ID` is blank. The chain is walked by the server; a
caller never needs to reconstruct it, but a result that looks out of order
against a hand-built expectation is not necessarily wrong.

### objects

Return a view/cluster/table/customizing object's underlying DDIC tables
and fields.

```json
{ "mode": "objects", "object": "SOME_VIEW_OR_TABLE_NAME" }
```

A FIELDS section per resolved table lists its fields (`field`, `key`,
`type`, `length`, `data_element`), sorted by position. Body is a TABLES
table (`table`, `client_dependent`, `delivery_class`). **Read `client_dependent` and the
table's delivery class before assuming a change is safe**: a
client-dependent table's rows are scoped to one client, so a change there
does not cross clients; a client-independent one does. Only tables with
delivery class `C`, `G`, or `E` are writable at all through `abap_img_edit`
— `A`/`L`/`S`/`W` are SAP-delivered or system tables and are refused there
regardless of what this mode shows. When exactly one table resolves, the
notes carry the same `next` hint naming `abap_data_preview` as `show`.

## What it does not do

- Does not read or write a single customizing entry — every mode stops at
  structure (activities, nodes, the maintenance objects/tables behind
  them). Use `abap_data_preview` to read rows, `abap_img_edit` to change
  them.
- Does not create an IMG node or activity.
- Does not generate a maintenance dialog (the SE54 view-maintenance
  generator is untouched).
- Generates no ABAP, deploys nothing, and creates no object of any kind.
- Accepts no caller-supplied SQL of any kind. Caller values reach the
  statement only as validated, quoted literals substituted into a WHERE
  clause the server built — never as a fragment the caller controls.

## Reading and changing the entries

`abap_img` deliberately stops at structure.

- To **read** the actual customizing rows behind a resolved table, use
  `abap_data_preview` — `show` and `objects` both name it directly in a
  `next` hint when exactly one table resolves. That tool carries its own,
  separate constraints, named in full in the hint itself: it is gated by
  `ABAP_ALLOW_DATA_PREVIEW=true` (off by default, independent of
  `ABAP_MODE`); it refuses outright on a system that reports itself
  productive or that this server could not prove non-productive; it has no
  WHERE filter of any kind — a preview is always the first N rows of the
  whole table, `abap_img`'s resolved name notwithstanding; and it denies a
  built-in list of tables (credentials/security, payroll/HR, accounting
  documents, and personal data) that no setting can shrink, only grow via
  `ABAP_DATA_PREVIEW_DENY_TABLES`. See `doc/TOOLS/diagnostics.md`.
- To **change** a resolved table's rows, use `abap_img_edit` — see
  `doc/TOOLS/abap-img-edit.md`. It targets the same activity/object
  vocabulary as this tool, so a name found with `search`/`tree`/`show` can
  be passed straight through.

## Limitations

- **`tree` finds nothing on a non-English-customizing-text system** — see
  "Finding the root" above.
- **The two earlier wrong-guess tree-table entries are gone from the
  catalog**, not merely unused — see "Catalog confidence" above.
- **No IMG node create, no maintenance-dialog generation.** Both are out
  of scope for this tool; see `doc/CAPABILITIES/absent-entirely.md`.
- **No customizing-entry read here.** `abap_data_preview` covers reading
  rows, with its own constraints listed above.
