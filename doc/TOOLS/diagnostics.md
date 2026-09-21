# Diagnostics

## abap_dumps

Read ABAP runtime errors (ST22 short dumps) from the system's dump
repository — not the exception text of a run this server just triggered.

**Availability**: case 3 — always registered; the `variables` field is only
advertised when `ABAP_ALLOW_DUMP_VARIABLES=true`, but is enforced on every
call regardless of advertisement.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `mode` | enum `list` \| `show` | no | `list` | Filter the dump feed, or return one dump. |
| `key` | string | required for `show` | — | Key exactly as a list row printed it — do not trim or re-encode; internal spaces are significant. |
| `query` | string | `list` only | — | Server-side FQL filter, e.g. `and ( equals ( user , DEVELOPER ) , equals ( runtimeError , MESSAGE_TYPE_X ) )`. One `and(...)`/`or(...)` wrapper is mandatory, max 2 levels. Validated locally before sending. |
| `from` | string | `list` only | — | Oldest dump to include, `YYYYMMDDHHMMSS`, server local time. |
| `to` | string | `list` only | — | Newest dump to include, `YYYYMMDDHHMMSS`. |
| `max` | number (int, 1–100) | `list` only | (server default) | Rows to request. Each requested row costs roughly 12 KB on the wire. |
| `section` | string, one of `analysis`\|`source`\|`variables`\|`stack`\|`environment`\|`all` | `show` only | — | Which chapter text to return instead of the default summary. Alternative to `chapters` — passing both is `BAD_INPUT`. |
| `chapters` | string | `show` only | — | Comma-separated chapter names, e.g. `"kap7,kap8,kap11"` — names, not translated titles. Alternative to `section`. |
| `offset` | number (int, 1–999999) | `show` only | — | 1-based first line of the returned chapter text. Only meaningful together with `section`, `chapters`, or `section:"all"` — on the default summary (neither given) it is `BAD_INPUT`, since the summary is not a window onto anything. |
| `variables` | boolean | `show` only, gated | — | Also return Selected Variables — live values of locals/internal tables at termination. Large (~1,100 lines); page with `offset`. Contains real business data. Same gate as `section:"variables"`. |

Notes: the feed reaches back a fixed residence window only (server-defined,
short) — an empty list means nothing in that window matched, never "nothing
failed." The server answers an unrecognized filter with HTTP 200 and the
full unfiltered feed rather than an error, so this tool validates filters
itself before sending — a client-side refusal is the only way to tell a
caller which attributes the feed actually serves, since the server answers
both an unrecognized attribute and a genuine syntax error with the same
opaque HTTP 400. `mode=list`'s feed never reports a total count
(`$inlinecount` is inert on it): when exactly `max` rows come back, that is
evidence there are almost certainly more, not proof of a complete set.

### `mode="show"` defaults to a summary (#149)

With neither `section` nor `chapters` (nor `variables`) given, `show` no
longer returns chapter text at all — it returns a distilled summary, capped
at 3,000 characters (`buildResponse` marks any cut the same way it marks
any other truncation):

- the header's `error`/`exception` fields — the runtime error and the
  exception class;
- SHORT TEXT;
- SOURCE LINE (kap7, kap8) — include (or program), line, the enclosing
  procedure, and the failing statement, read from "where terminated" and the
  source extract;
- ERROR ANALYSIS (kap3), prose cleaned up and trimmed to ~450 characters;
- HOW TO CORRECT (kap4), trimmed to ~260 characters and cut before SAP's
  "if you cannot solve the problem yourself" support boilerplate;
- the top 5 call-stack frames (kap11), innermost first;
- a note listing every chapter this dump has (name and title), so the next
  call can name what it wants.

Use `section` to get chapter text instead — verbatim, not summarised:

| `section` | Chapters |
|---|---|
| `analysis` | kap0, kap3, kap4, kap28 |
| `source` | kap7, kap8 |
| `variables` | kap10 (gated — see below) |
| `stack` | kap11, kap22 |
| `environment` | kap5, kap6, kap6a, kap9, kap14 |
| `all` | kap7, kap8, kap9, kap11 — the full set `show` returned by default before this change |

`section` and `chapters` are alternatives, not additive — passing both is
`BAD_INPUT`. `section:"variables"` is gated exactly like `variables:true`:
refused as `DUMP_VARIABLES_DISABLED` unless the operator set
`ABAP_ALLOW_DUMP_VARIABLES=true`. `offset` pages chapter text; it has
nothing to page on the summary, so `offset` without `section`, `chapters`,
or `section:"all"` is `BAD_INPUT`.

## abap_data_preview

Read a bounded number of rows from a DDIC table or view. Use this tool for
row contents; use `abap_read` for the structure/metadata of the same entity.

**Availability**: case 1 — registered only when `canPreviewData`
(`ABAP_ALLOW_DATA_PREVIEW=true`, independent of `ABAP_MODE` — allowed even
under `read`).

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `table` | string | one of table/object required | — | DDIC entity name, e.g. `"T000"` or `"/ACME/TAB"`. Must be a bare identifier, not a query. |
| `object` | string | alias for `table` | — | Same as `table`; `table` wins if both are given. |
| `mode` | enum `preview` \| `snapshot` \| `diff` | no | `"preview"` | `preview`: the read documented below, unchanged. `snapshot`: the same read, saved to disk under an id for a later `diff`. `diff`: re-reads the snapshot's own selection and reports what changed since it was taken. See "Snapshot and diff" below. |
| `snapshot_id` | string | required for `mode: "diff"`, refused otherwise | — | The id returned by a prior `mode: "snapshot"` call. |
| `ttl_hours` | number (int, positive) | no | operator ceiling | Only valid with `mode: "snapshot"` — refused otherwise. How long the snapshot may be diffed against before it expires and is pruned. Clamped down (never up) to `ABAP_DATA_SNAPSHOT_TTL_HOURS`. |
| `max_rows` | number (int) | no | server ceiling | Rows to return. Clamped to the server's configured ceiling; the clamp is reported in the response. `0` is refused, never read as "unlimited." |
| `where` | array of `{field, op, value}` | no | none — unfiltered read | Conditions are ANDed. `op` is one of `eq, ne, lt, le, gt, ge, like, in, is_null`. `value` is required for every op except `is_null` (which must omit it), and is an array only for `in`. |
| `columns` | array of string | no | every column | Restrict the projection to these fields. |
| `order_by` | array of `{field, direction}` | no | none | `direction` is `asc` (default) or `desc`. |
| `distinct` | boolean | no | `false` | Adds `SELECT DISTINCT`. |
| `format` | enum `table` \| `abap_value` \| `test_double` | no | `table` | How the fetched rows are rendered. |
| `mask` | array of string | no | none | Field names to blank in the output only, applied at render time after the read. |

`mode: "diff"` forbids `table`/`object`/`where`/`columns`/`order_by`/
`distinct`/`max_rows` — a diff always re-reads the snapshot's own recorded
selection, never a caller-supplied one, so setting any of those alongside
`snapshot_id` is refused as `BAD_INPUT`.

This tool still takes no SQL text from a caller. `where`/`columns`/`order_by`
are a structured filter, built from field names and typed values, not a
query string — there is no way to pass a raw `WHERE` clause or expression.

### Two shapes of request

An **unfiltered call** (none of `where`, `columns`, `order_by`, `distinct`
set) is unchanged from before: one POST to the `ddic` endpoint
(`/sap/bc/adt/datapreview/ddic?ddicEntityName=…&rowNumber=N`), which returns
N+1 rows — the extra row is the server's own signal that more rows exist,
not an off-by-one.

A **filtered call** (any of those four fields set) issues two requests.
First, a one-row probe against the same `ddic` endpoint, used only to obtain
the entity's authoritative column list — include-flattened, with the true
wire type code per column; the probe's rows are discarded. Second, a
compiled Open SQL `SELECT` against
`/sap/bc/adt/datapreview/freestyle?rowNumber=N`, built from that column list
plus `where`/`columns`/`order_by`/`distinct`.

### Validation is against the server's column list, not the DDIC source

Field names in `where`, `columns`, and `order_by` are checked against the
column list the probe returned, not against what `abap_read` reports for the
same entity's DDIC source. Table TB003 is the reason this matters:
`abap_read` reports 6 fields plus an `include si_tb003aba`, while the
preview endpoint's own column list has 7 entries, including `BPVIEW`, which
comes from that include. Validating against the DDIC source would refuse a
valid field — and it has no answer at all for a DDIC view or a CDS view,
neither of which has a "source field list" in the same sense. An unknown
field or a malformed `value` is refused with `BAD_INPUT`. An unknown `op` never
reaches the tool: the input schema lists the accepted operators as an enum, so
the MCP client sees a schema validation error naming them (observed live).
Cost differs: an unknown operator or a malformed shape is caught before any
request — zero wire cost; an unknown field is only known after the probe, so
it costs that one request.

### Values are typed literals, never concatenated text

Each `value` is rendered as a typed literal, chosen from the column's wire
type code — never pasted into the statement as text:

- Integer types: unquoted.
- Packed/float types: quoted — an unquoted decimal is a syntax error on this
  release.
- `D` (date): accepts `YYYYMMDD` or `YYYY-MM-DD`, normalised and quoted.
- `T` (time): accepts `HHMMSS` or `HH:MM:SS`, normalised and quoted.
- Everything else: quoted, with an embedded single quote doubled.

`= 'Walldorf''s'` compiles and returns zero rows rather than injecting
anything into the statement — proven live, not just asserted.

`like` takes an SQL pattern: `%` matches any run of characters, `_` matches
exactly one, and `#` is the escape character (so `#%` means a literal `%`,
not "any character then percent"). The statement is rendered with
`ESCAPE '#'`.

### Refusals decided before the wire call

Three checks run before the freestyle request is issued:

- `like` on a field whose wire type is not character-like — the server's own
  message is "A LIKE condition can only be used with character-like fields."
- `distinct: true` together with an `order_by` field that is absent from
  `columns` — the server's wording for that shape is "is missing in the
  SELECT list," reported by this tool before the statement is ever compiled.
- A `where` condition on the client field — refused with the compiler's own
  reasoning, "Client handling is performed by the compiler": the read is
  already scoped to the logon client, so naming it again is redundant, not
  extra-narrowing.

Ordering by a column that is not in `columns` is fine as long as `distinct`
is not set.

### No offset, no paging parameter

The freestyle endpoint has no offset/paging parameter, filtered or not.
Paging is keyset only: order by a key field, and add a `gt` condition on the
last value seen on the previous page.

### What the response carries

The response echoes the rendered `SELECT` it sent and, when the server
supplies one, the server's own `executedQueryString`. On the filtered path
only, the response also carries the server's `totalRows` — the true number
of matching rows, independent of the `max_rows` cap.

### format

`format` chooses how the rows already fetched are rendered. It runs after
the read completes — it never changes what is fetched, how it is filtered,
or how many rows come back.

- **`table`** (default) — unchanged: the usual text table.
- **`abap_value`** — the rows as one typed ABAP literal for the entity's
  line type, preceded by the `TYPES` line:

  ```abap
  TYPES ty_rows TYPE STANDARD TABLE OF t000 WITH EMPTY KEY.
  DATA(lt_rows) = VALUE ty_rows(
    ( mandt = '000' mtext = 'SAP AG' )
    ( mandt = '001' mtext = 'A''s client' )
  ).
  ```

  One row per `( ... )` group, with every field named explicitly. Fields
  appear in the `columns` order when `columns` was given, DDIC order
  otherwise. Character-like types (`C`, `N`, `STRING`, `CLNT`, `LANG`,
  `UNIT`, `CUKY`) are quoted, with an embedded `'` doubled. `D` and `T`
  render as `'YYYYMMDD'` / `'HHMMSS'`. `NUMC` is kept as a quoted string,
  never converted to a number — its leading zeros are significant, and they
  are not always present on the wire: live, `DD02L-AS4VERS` came back
  `0000` but `SEOCLASSDF-VERSION` came back `1`. Integers are bare. Packed
  and float values render in ABAP literal form (`'12.50'`). ADT's data
  preview renders a negative numeric with a *trailing* minus rather than a
  leading one — live `TCURR-UKURS` came back as `0.94000-` — and the
  renderer moves the sign to the front so the emitted literal is valid ABAP:
  `'-0.94000'`. An empty cell is omitted from the group unless the field is
  a key field, but in practice this exception rarely fires: every live
  capture had ADT report `keyAttribute="false"` for every column, including
  genuine primary keys (`DD02L-TABNAME`, `TCURR-MANDT`), so the preview
  metadata on this system does not mark key fields and a caller should not
  rely on the key exception to guarantee a field is emitted. The response
  carries a note saying so whenever a cell was omitted. Every emitted line
  stays at or under 255 characters; a row group too long for one line wraps
  across lines rather than being cut.

  Verified live on A4H (client 001, user DEVELOPER, 2026-09-15) via
  `abap_data_preview`: `C` and `N` (DD02L), `D` and `T` (DD02L
  AS4DATE/AS4TIME), `P` (TCURR UKURS/FFACT/TFACT, including the negative
  trailing-sign case above), and INT1 — which arrives on the wire as a
  lower-case `b` (SEOCLASSDF DURATION_TYPE/RISK_LEVEL). **Unverified**:
  `I`/`INT4`/`INT8` and the hexadecimal family `X`/`RAW`/`RAWSTRING` — no
  readable basis table on A4H exposed a column of those types, so those
  literal paths are covered by unit tests over synthesised column metadata
  only, not by a live capture.

- **`test_double`** — the same literal, wrapped in a paste-ready fixture
  snippet. This is a *partial* snippet, not a complete test class: it emits
  a leading comment saying exactly that, then the `CLASS-DATA` declaration
  and the `class_setup`/`class_teardown` method bodies, for the caller to
  paste into an existing `CLASS ltc_... DEFINITION ... FOR TESTING RISK
  LEVEL HARMLESS` class — it does not emit the `CLASS ... DEFINITION` /
  `IMPLEMENTATION` wrapper itself:

  ```abap
  " Paste into your test class. Requires CLASS ... FOR TESTING RISK LEVEL HARMLESS.
  CLASS-DATA go_osql TYPE REF TO if_osql_test_environment.

  METHOD class_setup.
    go_osql = cl_osql_test_environment=>create( VALUE #( ( 'T000' ) ) ).
    TYPES ty_rows TYPE STANDARD TABLE OF t000 WITH EMPTY KEY.
    DATA(lt_rows) = VALUE ty_rows(
      ( mandt = '000' mtext = 'SAP AG' )
    ).
    go_osql->insert_test_data( lt_rows ).
  ENDMETHOD.

  METHOD class_teardown.
    go_osql->destroy( ).
  ENDMETHOD.
  ```

  `abap_data_preview` only ever reads an Open SQL entity — a transparent
  table, a database view, or a CDS view — so that is always the fixture
  kind it emits: `cl_osql_test_environment` doubles a database entity. For
  a structure or a table type there is no Open SQL entity behind the read,
  so there is nothing to double and the literal stands alone with no
  fixture wrapper — `cl_abap_testdouble` doubles a class or an interface,
  not a table.

### mask

`mask` names fields to blank in the output only, applied at render time
after the read — the row is fetched in full first, so a `where` or
`order_by` condition on a masked field still works normally; only the
rendered output is redacted. Character-like fields become the constant
`'MASKED'`; every other type becomes its initial value. The response lists
which fields were actually masked.

A name in `mask` that does not match a column of the entity is refused with
`BAD_INPUT` rather than silently ignored — a mask that quietly does nothing
is a data leak, not a no-op.

### Policy

A fixture built with `format: "test_double"` (or the plain literal from
`format: "abap_value"`) is a copy of production rows, so its governing
policy is exactly `abap_data_preview`'s own — there is no separate path
around it. `ABAP_ALLOW_DATA_PREVIEW` decides whether the tool is registered
at all; `safety.assertDataPreview` runs against the deny-list before the
read, unaffected by `format` or `mask`; the row ceiling
(`ABAP_DATA_PREVIEW_MAX_ROWS`) applies unchanged. `format` is applied to
rows already fetched, so a deny-listed table yields no rows in any format —
there is no rendering path that reaches data the read itself refused.

### Worked examples

```json
{
  "table": "TB003",
  "where": [{ "field": "ROLECATEGORY", "op": "eq", "value": "BUP001" }],
  "columns": ["ROLE", "ROLECATEGORY"],
  "order_by": [{ "field": "ROLE" }]
}
```

An unknown field is refused before the freestyle request is even built:

```json
{ "table": "TB003", "where": [{ "field": "NOT_A_REAL_FIELD", "op": "eq", "value": "X" }] }
```
→ `BAD_INPUT`: `NOT_A_REAL_FIELD` is not a column the preview endpoint
reports for `TB003`.

### Verification status

The SQL layer above — every literal-rendering rule, `LIKE … ESCAPE '#'`
including an escaped wildcard, `IN (...)` including a list wrapped across
lines, `IS NULL`, `SELECT DISTINCT` with and without a projection,
multi-field `ORDER BY … ASCENDING/DESCENDING`, and the three pre-wire
refusals — was live-verified on A4H (SAP NetWeaver AS ABAP 7.5x appliance,
client 001) on 2026-09-12: each shape was written into a `$TMP` report and
syntax-checked and executed through ADT. Filtering TB003 on
`ROLECATEGORY = 'BUP001'` returned exactly one row. The filtered HTTP
exchange through abapsmith's own code — the probe request, the freestyle
request, and the response shape this tool actually returns to a caller — is
**unverified**: the MCP server available for that verification run was the
released bundle, not this branch, and no released tool exposes arbitrary
freestyle SQL, so the round trip could not be captured as a cassette.

Requests against a deny-listed table are refused before any network call —
unchanged, and this applies to filtered and unfiltered calls alike;
deny-listed tables fall into four categories — credentials/security,
payroll/HR, accounting documents, and personal data. Not every DDIC entity
kind qualifies for a preview at all: help views, structures, append
structures, CDS table functions, abstract entities, and parameterised CDS
views (any CDS view that declares parameters) are refused, with the refusal
message naming the actual kind at call time.

`format: "abap_value"`/`"test_double"` reproduces values, not the DDIC
type: a field whose ABAP literal form abapsmith cannot determine is emitted
as a quoted string and may need a cast by hand.

### Snapshot and diff

`mode: "snapshot"` runs the same read documented above — same policy, same
gates, same refusals — and, instead of only rendering it, also saves the
result to disk under a generated `snapshot_id` (`snap_` plus 32 hex
characters). `mode: "diff"` takes a `snapshot_id`, re-reads the table using
that snapshot's own recorded selection (table, filter, projection, row
cap — never anything the `diff` caller passes), and reports what changed.

The data-preview deny-list is checked at **both** ends, not just at
snapshot time: `diff` re-runs the same `ABAP_ALLOW_DATA_PREVIEW`/deny-list
check the original snapshot passed, because the deny-list can grow between
the two calls (an operator can add an entry at any time) and a snapshot
taken when a table was allowed must not become a back door to it later. If
the table has since been denied, `diff` refuses just as a fresh preview of
that table would.

The row ceiling (`max_rows`, clamped to `ABAP_DATA_PREVIEW_MAX_ROWS`)
applies independently on both sides of a diff: the snapshot side reports
`more_rows_exist` if the original read was clamped, and the diff's own
re-read reports it again for the post-change state. A diff computed while
either side was clamped is a diff of what was visible, not necessarily of
the whole table, and the response says so rather than implying completeness.

**Row matching.** Rows are matched between the two reads on the table's
DDIC primary key whenever the snapshot's own selection has one. If the
snapshot used a `columns` projection, key completeness cannot be
established from the projected column list alone, and the response is
explicit that the match key is incomplete rather than guessing: `diff`
falls back to matching on every column that was actually selected. A row
edited only in a column outside that fallback key then does not read as
"changed" — it surfaces as a delete on the old values plus an insert of the
new ones, because there is no complete key left to recognize it as the same
row. This is a structural limit of matching on full-row identity when the
key is not known, not a bug in the diff.

**Expiry.** A snapshot's `ttl_hours` (if given) is clamped down — never up —
to the operator ceiling `ABAP_DATA_SNAPSHOT_TTL_HOURS` (default 24 hours);
there is no "keep forever" spelling for a store that holds business data. An
expired snapshot is pruned, and `diff`-ing it is refused with
`SNAPSHOT_EXPIRED` naming when it was taken and when it expired — this is a
terminal refusal: a deleted snapshot cannot be recovered, and the only next
step is taking a fresh one.

**Storage.** Snapshot files live under `ABAP_STATE_DIR`, in
`snapshots/<system>/` (keyed by system: sid, URL and client), written with
file mode `0600`. This is a separate store from the journal: a snapshot is
never written into the journal directory, and it does not surface through
`abap_journal` or a journal export — the two features share no files and no
listing.

`abap_run`, `abap_test`, `abap_bopf_test`, and `abap_ui mode="press"` can
also take a `snapshot_ids` argument to diff automatically against snapshots
taken before the call — see `doc/TOOLS/execute-and-test.md`.

## abap_fluid log.read

Read application log (BAL/SLG1) headers and, on request, their messages.
This is not a dedicated MCP tool — it is the built-in `log` fluid tool's one
action, reached through `abap_fluid {"tool":"log","action":"read","args":{...}}`.
See [abap-fluid.md](abap-fluid.md) for the wire contract shared by every
fluid tool and [../FLUID-API/README.md](../FLUID-API/README.md) for the
built-in tool list.

**Availability**: same as `abap_fluid` itself (case 3-style: absent entirely
when `ABAP_FLUID_API` is off; a mode-locked refusal stub on a read-only v1
server; otherwise the real tool, subject to the runtime
`FLUID_API_DISABLED` checks). There is no separate flag for `log` — it needs
nothing `core` or `scan` do not already need.

BAL has no single "read everything" function module. The issue that
requested this tool named `BAL_LOG_READ`, which does not exist under that
name on a current system; `log.read` instead drives the documented
search/load/read pipeline:

1. `BAL_GLB_MEMORY_REFRESH` — clears this session's BAL memory first, so a
   log already loaded earlier in the same work process (by a prior call)
   cannot come back with zero messages instead of its real ones.
2. `BAL_DB_SEARCH` — finds log headers matching the filter (object,
   subobject, extnumber, user, tcode, program, a date/time window).
3. `BAL_DB_LOAD` (`detail="messages"` only, `i_lock_handling = 0`, no
   enqueue) — loads one found log's messages into session memory and
   returns a handle per message.
4. `BAL_LOG_MSG_READ` — reads one message by handle, rendering its
   message-class text (`e_txt_msg`).

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `object` | string | no | — | `BALHDR-OBJECT`. `*`/`+` make it a pattern. |
| `subobject` | string | no | — | `BALHDR-SUBOBJECT`. `*`/`+` make it a pattern. |
| `extnumber` | string | no | — | External number. `*`/`+` make it a pattern. |
| `user` | string | no | connected user | Pass `*` for every user. |
| `since` | string | no | — | Server-time lower bound, `YYYYMMDDHHMMSS`. |
| `until` | string | no | — | Server-time upper bound, `YYYYMMDDHHMMSS`. |
| `last_seconds` | integer | no | — | Window ending now, computed server-side. Mutually exclusive with `since`/`until`. |
| `tcode` | string | no | — | Transaction code. Pattern allowed. |
| `program` | string | no | — | Program name. Pattern allowed. |
| `max` | integer | no | `20` | Log limit (`DEFAULT_LOG_MAX`). |
| `detail` | enum `headers` \| `messages` | no | `headers` | `messages` also fetches each matched log's message rows. |

With neither an absolute window (`since`/`until`) nor a relative one
(`last_seconds`) given, the window defaults to the last hour
(`DEFAULT_LOG_WINDOW_SECONDS = 3600`, in `src/adt/bal-log.ts`) — otherwise an
unqualified call would ask BAL to scan a table that can span years on a live
system.

`last_seconds` combined with `since` or `until` is refused before any
network call: `bal-log.ts`'s `assertLogReadArgsNoWindowConflict` rejects the
combination client-side as `BAD_INPUT`, called from `runRun` in
`src/tools/fluid.ts` before it connects. The ABAP side (`log.ts`'s
`do_read`) still carries its own `last_seconds cannot be combined with since
or until` check too, as a backstop for a caller that reaches it some other
way.

### Business data warning

`detail="messages"` returns message text and its variables (`msgv1`..`msgv4`)
verbatim. These are application data written by the logging program, not
abapsmith's own output, and may contain business data — request
`detail="messages"` only when needed, the same caution `abap_dumps`'
`variables` field carries.

### Audit line

Every `log.read` call writes one stderr line naming only what was looked at
and how much came back — never message text or any other field:

```
[abapsmith] audit: abap_fluid log.read object=ZFOO subobject=* logs=3 messages=0
```

This mirrors `abap_data_preview`'s own audit line (table name and row count,
never row data) — the same shape applied to a different data source.

### `BAL_DB_LOAD` write-back caveat

`BAL_DB_LOAD` can itself write to the database: when it loads a log stored
in an old on-disk format, it converts it in place via
`BAL_DB_SAVE_OLD_VERSIONS`. That makes `detail="messages"` on such a system
not provably free of database side effects, even though this is a "read"
action — recorded here rather than papered over. `detail="headers"` (the
default) never calls `BAL_DB_LOAD` and is not subject to this.

### Correlation hints from other tools

`abap_run`, `abap_test`, `abap_bopf_test`, and `abap_ui mode="press"` each
append a hint pointing at the `log.read` call most likely to explain what
the executed code did behind the scenes. `abap_run`, `abap_bopf_test`, and
`abap_ui mode="press"` measure the run's own `durationMs` and round it up to
the next whole second plus 5 seconds of slack, since `last_seconds` is
resolved on the server clock and a log entry can land just after the
measured duration but before the log query runs, e.g.:

```
Application log (BAL) entries this execution may have written: abap_fluid
{"tool":"log","action":"read","args":{"last_seconds":47,"detail":"messages"}}
— last_seconds is measured on the server clock, so it covers this run.
```

`abap_test` measures no duration of its own (there is nothing in an ABAP
Unit run result to round up), so its hint names the fluid tool's own
one-hour default instead of a measured window, and says so plainly:

```
Application log (BAL) entries this run may have written: abap_fluid
{"tool":"log","action":"read","args":{"last_seconds":3600,"detail":"messages"}}
— a default one-hour window; this tool does not measure its own run time,
so narrow it yourself if the system is busy.
```

### Worked example

```json
{ "tool": "log", "action": "read", "args": { "object": "ZFOO", "last_seconds": 3600, "detail": "messages" } }
```

### Verification status

The four function-module signatures above (`BAL_GLB_MEMORY_REFRESH`,
`BAL_DB_SEARCH`, `BAL_DB_LOAD`, `BAL_LOG_MSG_READ` — every
IMPORTING/EXPORTING/TABLES/EXCEPTIONS parameter this tool relies on) were
verified live on system A4H (probe class `ZCL_I108_PROBE`, 2026-09-15):
`BAL_DB_SEARCH` returned 5 headers for a 90-day window; `BAL_DB_LOAD` called
with `i_lock_handling = 0` against one of those headers returned 440 message
handles; `BAL_LOG_MSG_READ` given one of those handles returned `e_s_msg`
plus the rendered `e_txt_msg`.

Beyond that FM-level probe, the `log` fluid tool's own generated ABAP body
was itself run live on A4H (client 001, user DEVELOPER, 2026-09-15):
deployed to `$TMP` as `ZCL_I108_FLUID_LOG`, activated with zero syntax
errors, and driven through `IF_OO_ADT_CLASSRUN` against the real
`ZCL_ZMCP_FLUID_RT`. Called with `{"detail":"headers","last_seconds":864000,
"user":"*","max":5}` it returned five `{"kind":"log",...}` rows and one
`{"kind":"summary",...}` row, no `ERR` frame — `last_seconds` and `max`
were both honoured (`max:5`, five rows returned, `truncated:true`).
Activation left two non-blocking warnings, both `cl_abap_tstmp=>subtractsecs`
rounding `TZNTSTMPL` to `TIMESTAMP` (two call sites). The probe object was
deleted afterwards.

Not observed by that run: `detail="messages"` was never called live — only
the `detail="headers"` default path was exercised in that pass. That gap was
closed on the same day: `detail="messages"` and the `abap_fluid
{"tool":"log","action":"read"}` MCP call path itself — dispatching through
`dispatch()` and rendering the result through
`renderLogRead`/`auditLogRead` — were both exercised live on A4H on
2026-09-15, through an MCP server started from this worktree's `dist/`
(this branch's build, not the released bundle).

`detail="messages"` verbatim live output, called through `abap_fluid`
itself:

```
$ abap_fluid {"tool":"log","action":"read","args":{"detail":"messages","object":"/UIF/LREP","last_seconds":864000,"max":1}}
tool: log
action: read
logs: 1
messages: 88
detail: messages
since: 20260905111848
until: 20260915111848
user: DEVELOPER
server_time: 20260915111848
ms: 89
version: 3a7033a5
deployed: true
truncated: true

NOTE: Message text and its variables (msgv1..msgv4) are application data written by the logging program, not abapsmith's own output, and may contain business data.
NOTE: Not every matching log was returned (max=1). Raise max, or narrow the window with since/until, to see a different slice.

--- LOG 00000000000000020406 /UIF/LREP ---
extnumber       user       date      time    program   tcode  total  abort  error  warning  info  success
--------------  ---------  --------  ------  --------  -----  -----  -----  -----  -------  ----  -------
20260909091224  DEVELOPER  20260909  091224  SAPMSSYC         88     0      0      0        88    0

no  type  message  text                                                       level  context
--  ----  -------  ---------------------------------------------------------  -----  -------
1   I     BL001    LRep load consistency check                                1
2   I     BL001    Start of LRep provider version consistency check           1
...
88  I     BL001    End of load consistency check                              1
```

The `...` above stands for 85 further message rows and is not the tool's
own truncation marker; the `text` column is also narrower here than in the
real output, which sizes it to the longest message on that log — both are
this page's formatting, not something the tool does.

The client-side refusal for a conflicting window was confirmed the same
day, on the same branch build:

```
$ abap_fluid {"tool":"log","action":"read","args":{"last_seconds":60,"since":"20260915000000"}}
{"error":"BAD_INPUT","message":"log.read: last_seconds cannot be combined with since or until.","hint":"Name the window one way: pass last_seconds alone, or since/until alone.","retryable":true,"details":{"lastSeconds":60,"since":"20260915000000"}}
```

