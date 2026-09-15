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
| `chapters` | string | `show` only | — | Comma-separated chapter names, e.g. `"kap7,kap8,kap11"` — names, not translated titles. |
| `offset` | number (int, 1–999999) | `show` only | — | 1-based first line of the returned chapter text. |
| `variables` | boolean | `show` only, gated | — | Also return Selected Variables — live values of locals/internal tables at termination. Large (~1,100 lines); page with `offset`. Contains real business data. |

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
| `max_rows` | number (int) | no | server ceiling | Rows to return. Clamped to the server's configured ceiling; the clamp is reported in the response. `0` is refused, never read as "unlimited." |
| `where` | array of `{field, op, value}` | no | none — unfiltered read | Conditions are ANDed. `op` is one of `eq, ne, lt, le, gt, ge, like, in, is_null`. `value` is required for every op except `is_null` (which must omit it), and is an array only for `in`. |
| `columns` | array of string | no | every column | Restrict the projection to these fields. |
| `order_by` | array of `{field, direction}` | no | none | `direction` is `asc` (default) or `desc`. |
| `distinct` | boolean | no | `false` | Adds `SELECT DISTINCT`. |

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
the `detail="headers"` default path was exercised. Still not observed: the
`abap_fluid {"tool":"log","action":"read"}` MCP call path through the
released server — dispatching through `dispatch()` and rendering the
result through `renderLogRead`/`auditLogRead` — since the live MCP server
available for this verification runs the previously released bundle, not
this branch; that path is covered only by unit tests against fakes.

