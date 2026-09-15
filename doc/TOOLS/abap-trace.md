# abap_trace

Run and read an ABAP runtime trace (SAT — the trace ADT itself calls
"ABAP Trace", the successor to transaction SAT/SE30) over
`/sap/bc/adt/runtime/traces/abaptraces`. A trace is scoped to the connected
technical user and to one object's execution: it records what that one
matching request did — statements, database access, call depth, time — not
a system-wide sample.

**Availability**: always registered, gated per call. `op=list` and
`op=read` are unconditional reads. `op=start`, `op=run`, and `op=delete`
need `canWrite` (`ABAP_MODE=edit` or `admin`) — the same rule that gates
`abap_write`.

## Parameters

`op` picks one of five operations; which other keys apply depends on it.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `op` | enum `start` \| `run` \| `list` \| `read` \| `delete` | no | `run` | Which operation to perform. |
| `object` | string | for `start`/`run` | — | The object to scope the trace to and, for `run`, to execute. |
| `type` | string | no | — | ADT type hint, e.g. `CLAS/OC`, when ambiguous. |
| `id` | string | for `read`/`delete` | — | Trace run id or trace request id. |
| `kind` | enum `runs` \| `requests` | `list` only | `runs` | List recorded trace runs, or outstanding trace requests. |
| `view` | enum `hitlist` \| `db` \| `tree` | `read` only | `hitlist` | Which shape to read a trace back in. |
| `top` | integer | no | `20`, max `100` | Hit-list rows to return, ranked by net time. |
| `depth` | integer | no | `4`, max `12` | Call-tree flattening depth. |
| `description` | string | no | `"abapsmith trace"` | Free-text label on the trace request. SAP's own field is short; a longer value is refused, not silently cut. |
| `aggregate` | boolean | no | `true` | Collapse repeated call events together. See "`tree` needs `aggregate=false`" below. |
| `sql_trace` | boolean | no | `true` | Include database access — what fills the `db` view. |
| `db_events` | boolean | no | `true` | Record database-event statements. |
| `procedural_units` | boolean | no | `true` | Record procedural-unit (form/function/method) boundaries. |
| `internal_tables` | boolean | no | `false` | Also record internal-table operations. Off by default — it is the flag most likely to inflate an already large trace. |
| `max_size_kb` | integer | no | `30720`, max `102400` | Trace file size ceiling on the server. |
| `max_seconds` | integer | no | `600`, max `1800` | How long the trace request stays armed waiting for a matching execution. |
| `executions` | integer | no | `1`, max `5` | `op=start` only — how many matching executions the trace request stays armed for before it is used up. `op=run` always arms a request for exactly one execution; passing `executions` to `run` is refused `BAD_INPUT`. |

Passing a key an `op` does not use is refused `BAD_INPUT` rather than
silently ignored, in line with how `abap_atc` treats the same shape of
mistake.

## Operations

**`op=start`** — create a trace request for the connected user, scoped to
one object. Nothing executes as a result of this call; the *next* execution
of that object that matches the request is what gets recorded. Use this
when you want to trigger the traced execution yourself, outside abapsmith
(SAPGUI, a batch job, a different session). By default the request is armed
for one execution; pass `executions` to raise that, up to `5`.

```json
{ "op": "start", "object": "ZCL_SLOW", "type": "CLAS/OC" }
```

```json
{ "op": "start", "object": "ZCL_SLOW", "type": "CLAS/OC", "executions": 3 }
```

**`op=run`** (default) — the one-call path: create a trace request, execute
the object through the existing `abap_run` path, wait for the trace to
finish, read it back, then delete the request it created. Most callers want
this rather than `start`.

```json
{ "op": "run", "object": "ZCL_SLOW", "type": "CLAS/OC" }
```

**`op=list`** — list trace runs (`kind="runs"`, the default) or outstanding
trace requests (`kind="requests"`). A run row carries id, object, timestamp,
size, and state; a request row carries the same shape for a request that
has not yet been consumed, or that was consumed but never deleted (see
below).

```json
{ "op": "list" }
```

```json
{ "op": "list", "kind": "requests" }
```

**`op=read`** — read one trace by `id`, in one of three views.

```json
{ "op": "read", "id": "<32-hex id>", "view": "hitlist" }
```

```json
{ "op": "read", "id": "<32-hex id>", "view": "db" }
```

```json
{ "op": "read", "id": "<32-hex id>", "view": "tree", "depth": 6 }
```

**`op=delete`** — delete a trace run, or a trace request, by `id`.

```json
{ "op": "delete", "id": "<32-hex id>" }
```

## Views for `op=read`

- **`hitlist`** (default) — the top `top` entries ranked by net time: gross
  time, net time, and hit count per entry.
- **`db`** — one row per database access: table, statement kind, access
  count, total time, and database time, followed by the table list itself
  (DDIC table class and buffering mode). The statement KIND is reported —
  `select`, `select single`, `select count(*)`, and a kernel pseudo-row —
  never the full SQL statement text. This ADT endpoint does not return
  statement text at all; do not read the `db` view as if it did.
- **`tree`** — the call tree, flattened to `depth` levels.

## `tree` needs `aggregate=false`

An aggregated trace (`aggregate=true`, the default) has already collapsed
the individual call events together, so there is no call tree left to walk.
Asking for `view="tree"` on a trace recorded with `aggregate=true` is
refused by this tool before any request goes to SAP — the underlying ADT
call would otherwise answer HTTP 400
`invalidRequestForAggregatedTraces`. Verified live. Record a trace with
`aggregate: false` when you know you will want the `tree` view.

## A trace is scoped to one user and one object, but still records everything the dispatch touched

Scoping a trace to one object does not scope its *contents* to that
object's own code. It records the whole server-side dispatch that
executed the request, including framework code beneath it. Measured on
A4H: tracing a four-statement `$TMP` class produced **1161 hit-list
entries, about 790 KB**, most of it ADT framework code running beneath the
executed class. This is why the hit list is ranked and capped, and why
`top` and `depth` exist — read the ranked top instead of the raw total.

## Trace requests: cleanup is the caller's job for `start`, automatic for `run`

`op=run` deletes the trace request it created once the trace has been
read. `op=start` does not — the request it creates is left for the caller
to delete with `op=delete`.

A fully consumed trace request is not cleaned up by the server on its own.
A request that had already recorded its execution (`maximal=1,
completed=1`) was observed staying in the `list kind="requests"` output.
Verified live. If you use `op=start`, delete the request yourself once you
have read the resulting trace.

## Leaving a request unscoped captures unrelated traffic

The trace request is pinned to the executed object's classrun URL. Without
that scoping, the next ADT call from any client — including abapsmith's
own subsequent calls — is what consumes the request's allowed executions,
not the object you meant to trace. Verified live. There is no way to arm a
trace request without naming the object it applies to.

## SQL trace

On the reference system (A4H, SAP_BASIS 754) SQL tracing is available only
as the `sql_trace` flag inside the ABAP-trace parameters — on by default,
and what fills the `db` view above. The standalone ADT SQL-trace
collection at `/sap/bc/adt/runtime/traces/sqltraces` (the ADT counterpart
of ST05) is **unverified**: a GET on it answers "Resource
`/sap/bc/adt/runtime/traces/sqltraces` does not exist," and the ADT
discovery document served on A4H does not advertise `traces.sqltraces` at
all. Code exists in this codebase for that path, but it has only been
exercised against fakes, never against a real system, and this tool does
not expose it. Use `sql_trace` on `op=start`/`op=run` and the `db` view on
`op=read` for database access; do not expect a separate SQL-trace
resource on this release.

## Cloud / ABAP Environment

**Unverified**: no SAP BTP ABAP Environment (Steampunk) tenant has ever
been available to this project, so nothing below is observed against a
real cloud system. What is checkable in this codebase: every entry point
in `src/adt/traces.ts` calls
`conn.discovery.assertSupported("traces.abaptraces", …)` first, and
`assertSupported` (`src/adt/discovery.ts`) only throws `UNSUPPORTED` when
discovery has loaded and the collection is known to be absent — an
unknown or not-yet-loaded inventory does not block the call, and the
server's own 404 is what actually decides. So *if* a cloud tenant's
discovery document omits `/sap/bc/adt/runtime/traces/abaptraces`,
`abap_trace` would refuse with `UNSUPPORTED` and there is no fallback
path — but whether a real tenant omits it is an expectation, not
something this project has observed.

## Journalling

Creating a trace request and deleting a trace are both journalled as
**irreversible** — there is no undo for either. A deleted trace run or
trace request is gone; a created trace request that is later deleted
cannot be brought back to consume the same execution again.

## Verified

The following was exercised live on A4H (SAP_BASIS 754 SP0007, client
001), 2026-09-15: trace-request creation; a scoped trace run over a `$TMP`
class; a hit-list read; a database-access read; a call-tree read on a
non-aggregated trace; listing runs; listing requests; deleting a run; and
deleting a request. The standalone SQL-trace collection
(`/sap/bc/adt/runtime/traces/sqltraces`) is **unverified**, for the reason
given above — it does not exist as a resource on this release, and this
tool never calls it.
