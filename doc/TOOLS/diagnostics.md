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
| `format` | enum `table` \| `abap_value` \| `test_double` | no | `table` | How the fetched rows are rendered. |
| `mask` | array of string | no | none | Field names to blank in the output only, applied at render time after the read. |

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
