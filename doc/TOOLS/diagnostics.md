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

There is deliberately no free-form filter/WHERE parameter anywhere on this
tool. Requests against a deny-listed table are refused before any network
call; deny-listed tables fall into four categories — credentials/security,
payroll/HR, accounting documents, and personal data. Not every DDIC entity
kind qualifies for a preview at all: help views, structures, append
structures, CDS table functions, abstract entities, and parameterised CDS
views (any CDS view that declares parameters) are refused, with the refusal
message naming the actual kind at call time.

