# abap_img

Reads SAP IMG (SPRO customizing) catalog entries: activities, their
reference-IMG tree position, and the maintenance objects/tables an activity
or object points at. It is a map of the structure, not a way into it —
`abap_img` reads catalog rows only; it never reads or writes a customizing
entry, creates an IMG node, or generates a maintenance dialog.

**Availability**: registered only when the server can write (`canWrite`).
ADT has no IMG REST route, so every mode runs a fixed, parameterised SELECT
through a generated `IF_OO_ADT_CLASSRUN` bridge class deployed into `$TMP`
— the same mechanism `abap_fpm_read` uses (`deployBridge`/`executeBridge`
in `src/adt/run.ts`). Deploying that bridge is a write on a `CLAS/OC`
object (`src/tools/img.ts` gates it with `deps.safety.assert("write", ...)`
before any network call), so under `ABAP_MODE=read` `SafetyGate.authorize`
returns `READ_ONLY` before any `$TMP` leniency is even considered — the
tool is absent from `tools/list` in read mode, exactly like `abap_fpm_read`.
Every call after the first deploy is still a pure read; the gate is
structural, not a policy call about what the tool does.

## What it reads

Every mode queries catalog tables named in `IMG_CATALOG`
(`src/adt/img-catalog.ts`) — that file is the only thing this tool's bridge
generator consults for table/field names, and it is the one file that
changes when a name is corrected. Per mode (`MODE_CATALOG_TABLES` in
`src/tools/img.ts`):

| Mode | Catalog tables queried |
|---|---|
| `search` | `imgActivity` (`CUS_IMGACH`), `imgActivityText` (`CUS_IMGACT`) |
| `show` | `imgActivity`, `imgStructure` (`SIMGH`), `cusObjectHeader` (`OBJH`), `cusObjectTable` (`OBJSL`) |
| `tree` | `imgNode` (`TTREE`), `imgStructure` (`SIMGH`) |
| `objects` | `cusObjectHeader`, `cusObjectTable`, `ddicTable` (`DD02L`) |

**None of these names has been confirmed against a live SAP system.** The
DDIC-metadata entries (`DD02L`/`DD03L`/view tables/`TSTC`) are marked
`confidence: "high"` in the catalog because they are stable, widely
documented DDIC catalog tables; the IMG-specific entries (`TTREE`,
`SIMGH`, `CUS_IMGACH`, `CUS_IMGACT`, `CUS_ACTOBJ`, `OBJH`, `OBJSL`,
`VCLDIR` and neighbors) are marked `confidence: "low"` and each carries a
note on what would settle it. `IMG_CATALOG_VERIFIED` in the same file is
`false`, and stays `false` until a live discovery run confirms every
entry — at which point that file, and only that file, changes. While it is
`false`, `abap_img` discloses this on every single response
(`src/tools/img.ts`'s `standingNotes()`), naming the specific unconfirmed
tables an empty result was read against: an empty or thin result from a
low-confidence table is evidence the table or field name might be wrong,
not evidence the customizing structure itself is empty.

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
| `offset` | integer, `.int().min(0)` | `search`/`tree` only | `0` | 0-based row offset for paging. |
| `limit` | integer, `.int().min(1)` | `search`/`tree` only | `IMG_PAGE_DEFAULT`, clamped to `IMG_PAGE_MAX` | Max rows to return. |

Every field not valid for the given `mode` is rejected outright
(`BAD_INPUT`, naming the field and the mode) rather than silently ignored —
e.g. `activity` on a `search` call, or `offset` on a `show` call.

## Modes

### search

Find activities whose title or id matches `query`. A term with no `*`
matches as a substring; `*` is an explicit wildcard.

```json
{ "mode": "search", "query": "output determination" }
```

Response header: `mode`, `query`, `language`, `matches`, `total` (when
known), `bridgeClass`, `bridgeRefreshed`. Body is an ACTIVITIES table
(`activity`, `title`, `objects` count, `nodes` count); when the bridge
reported a reference-IMG path for a matched activity, a PATH section lists
it. Paged by `offset`/`limit` — the notes report the page shown and the
`offset` to pass for the next one, never a promise that no more rows exist
beyond it.

### show

Return one activity's reference-IMG path, maintenance objects and tables.

```json
{ "mode": "show", "activity": "SOME_ACTIVITY_ID" }
```

Response header: `mode`, `activity`, `language`, `title`, `path`,
`bridgeClass`, `bridgeRefreshed`. A TABLES section lists each maintenance
object's underlying table (`object`, `table`, `client_dependent`, `via`);
a DOCUMENTATION section lists any linked doc class/name. Body is a
MAINTENANCE OBJECTS table (`kind`, `name`, `title`). When exactly one
table resolves, the notes carry a `next` hint naming `abap_data_preview`
against that table.

### tree

List the reference-IMG node children under `node`, or the root when `node`
is omitted.

```json
{ "mode": "tree", "node": "SOME_NODE_ID" }
```

Response header: `mode`, `node` (or `"(reference-IMG root)"`), `language`,
`count`, `total` (when known), `bridgeClass`, `bridgeRefreshed`. Body is a
NODES table (`node`, `kind`, `children` count, `title`) — one level of
children per call, paged by `offset`/`limit`, not a recursive dump of the
whole subtree.

### objects

Return a view/cluster/table/customizing object's underlying DDIC tables
and fields.

```json
{ "mode": "objects", "object": "SOME_VIEW_OR_TABLE_NAME" }
```

Response header: `mode`, `object`, `kind` (resolved or the `kind` hint
passed in), `language`, `bridgeClass`, `bridgeRefreshed`. A FIELDS section
per resolved table lists its fields (`field`, `key`, `type`, `length`,
`data_element`), sorted by position. Body is a TABLES table (`table`,
`client_dependent`). When exactly one table resolves, the notes carry a
`next` hint naming `abap_data_preview` against that table.

## What it does not do

- Does not read or write a single customizing entry — every mode stops at
  structure (activities, nodes, the maintenance objects/tables behind
  them).
- Does not create an IMG node or activity.
- Does not generate a maintenance dialog (the SE54 view-maintenance
  generator is untouched).
- Accepts no caller-supplied SQL of any kind. Caller values (`query`,
  `activity`, `node`, `object`, `kind`, `language`) reach the generated
  ABAP only as validated, quoted literals inside a WHERE clause the
  generator built — never as a fragment the caller controls.

## Reading the entries

`abap_img` deliberately stops at structure. To read the actual customizing
rows behind a resolved table, use `abap_data_preview` — `show` and
`objects` both name it directly in a `next` hint when exactly one table
resolves. That tool carries its own, separate constraints, named in full
in the hint itself: it is gated by `ABAP_ALLOW_DATA_PREVIEW=true` (off by
default, independent of `ABAP_MODE`); it refuses outright on a system that
reports itself productive or that this server could not prove
non-productive; it has no WHERE filter of any kind — a preview is always
the first N rows of the whole table, `abap_img`'s resolved name
notwithstanding; and it denies a built-in list of tables
(credentials/security, payroll/HR, accounting documents, personal data)
that no setting can shrink, only grow via `ABAP_DATA_PREVIEW_DENY_TABLES`.
See `doc/TOOLS/diagnostics.md`.

## Residue

`src/tools/img.ts` resolves a bridge class name per mode from a
`IMG_BRIDGE_CLASS` map before any network call — one fixed class per mode,
not one shared class, and not one generated per call.
`src/adt/img-bridge.ts` defines that map (`IMG_BRIDGE_CLASS`) and the
package (`IMG_BRIDGE_PACKAGE`): `ZCL_ZMCP_IMG_SEARCH`, `ZCL_ZMCP_IMG_SHOW`,
`ZCL_ZMCP_IMG_TREE`, `ZCL_ZMCP_IMG_OBJECTS`, all in `$TMP`. Every response
header includes `bridgeClass` and `bridgeRefreshed`, consistent with
`deployBridge`'s general behavior elsewhere in this codebase: it rewrites
a class in place, keyed by a content hash, rather than creating a new one
per call, so residue from this tool is bounded at exactly those four
classes regardless of how many times any mode runs. `$TMP` is never
transported, so none of the four ever leaves the system they were
deployed to.

## Limitations

- **The catalog names are unverified.** This is the load-bearing caveat
  for the whole tool: every `confidence: "low"` table/field name in
  `src/adt/img-catalog.ts` is a best guess pending a live discovery run.
  Treat a thin or empty result from a low-confidence table as
  inconclusive, not as proof the IMG has nothing there.
- **No IMG node create, no maintenance-dialog generation.** Both are out
  of scope for this tool; see `doc/CAPABILITIES/absent-entirely.md`.
- **No customizing-entry read or write.** `abap_data_preview` covers
  reading rows, with its own constraints listed above; nothing in this
  server writes a customizing entry.
- **First call per mode is slow.** Like `abap_fpm_read`, the first call
  for a given mode deploys and activates a bridge class before it can run;
  later calls reuse the deployed class and are faster.
