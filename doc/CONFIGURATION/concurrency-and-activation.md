# Session pool, concurrency & batch activation

## Session pool & concurrency

| Variable | Default | Effect |
|---|---|---|
| `ABAP_MAX_SESSIONS` | `5` | Total pooled ADT sessions. Hard ceiling `16` — out of range fails startup. |
| `ABAP_READ_CONCURRENCY` | `2` | Concurrent read-lane operations. No upper bound, not clamped to `ABAP_MAX_SESSIONS`. |
| `ABAP_WRITE_CONCURRENCY` | `2` | Concurrent write-lane operations. Same caveat as above. |
| `ABAP_SERIALISE_SAME_OBJECT_WRITES` | unset (= on) | Three-state. Unset: same-object writes serialise in-process and across processes. `false`: no serialisation at all. `true`: identical to unset. |
| `ABAP_CROSS_PROCESS_OBJECT_LOCK` | `true` | Whether the same-object write lock uses a cross-process lockfile or falls back to in-process only. Read through the config schema (parsed, validated, reported by the startup config report). |
| `ABAP_OBJECT_LOCK_WAIT_MS` | `1500` | How long a write waits for the cross-process object lock before failing closed. Accepted range `200`–`30000`; out-of-range or unparseable falls back to the default silently rather than failing startup — a deliberate soft-fallback carried into the schema, not the fail-startup behaviour most other numeric fields have. Read through the config schema and reported by the startup config report. |
| `ABAP_SESSION_IDLE_MS` | `300000` | Idle time after which a pooled session is presumed stale and discarded. |
| `ABAP_SESSION_WAIT_MS` | `10000` | Max time a call queues for a free pool slot before failing closed with `SESSION_BUSY`. |
| `ABAP_DEBUG_DIA_BUDGET` | `2` | Dialog work processes the debugger may assume it can pin. `0` or `1` disables debugging (kill switch). Raising it does not enable a second concurrent debug session — debug concurrency is hard-pinned at 1. |

If `ABAP_READ_CONCURRENCY + ABAP_WRITE_CONCURRENCY + 1` (the reserved debug
lease) exceeds `ABAP_MAX_SESSIONS`, the server logs a warning and starts
anyway — the lanes just contend for the smaller number of real slots.

**`ABAP_SERIALISE_SAME_OBJECT_WRITES=` (set but empty) is an opt-out, not a
no-op.** Any value that is not `1`/`true`/`yes`/`on` — including the empty
string — reads as `false` and disables the write-serialisation gate. Only a
genuinely unset variable reaches the safe default.

For how the session pool and the object gate actually behave at runtime —
roles, exhaustion, cross-process locking — see
[doc/CONCURRENCY](../CONCURRENCY/README.md).

## Batch activation

`abap_activate`'s `objects` (batch) form POSTs the whole set to
`/sap/bc/adt/activation` in one call, but internally splits it into smaller
sub-requests ("chunks") by object type before sending. **This is a
server-side blast-radius control, not a client concurrency setting** — see
`isFanoutProneType` and `MAX_ACTIVATION_BATCH` in `src/adt/activate.ts` for
the full incident writeup. In short: activating a batch of
classic ABAP Dictionary objects (domains, data elements, tables, structures,
table types, and a conservative penumbra of other structured-XML DDIC types)
makes SAP run its own `RADMASUTC`/`DD_ACT_INFOS_C3` mass-activation utility,
which fires a burst of LOOPBACK asynchronous RFCs to invalidate the DD buffer
cache across application servers — each one needs a free dialog work process
on the *target* system, which is the same system. A single batch of 47 such
objects exhausted a 7-dialog-work-process appliance and took it down, while
every client-side concurrency setting above was respected the entire time.
Classes, programs, interfaces, function groups, CDS views and the other
compiled-source types do not go through this utility and are not subject to
the same fan-out.

| Variable | Default | Effect |
|---|---|---|
| `ABAP_MAX_DDIC_ACTIVATION_BATCH` | `5` | Objects-per-request cap for the fan-out-prone (classic DDIC) half of a batch. Sized for a 7-dialog-work-process appliance. Hard ceiling `50`. Raise only if you know the target's free dialog work process capacity comfortably clears the new value — never on the reasoning "our own concurrency is only 1". |
| `ABAP_MAX_SAFE_ACTIVATION_BATCH` | `50` | Objects-per-request cap for everything else (classes, programs, interfaces, function groups, CDS, …). Matches `MAX_ACTIVATION_BATCH` — one chunk covers the largest batch this server accepts. Hard ceiling `200`. |

Both are chunk sizes for the HTTP requests `activateObjects` issues, not the
overall size of an `objects` array — that array-length ceiling is the fixed
constant `MAX_ACTIVATION_BATCH` (`50`) and is not itself configurable, so a
single caller cannot expand the total blast radius of one MCP call just by
raising a chunk size. Chunks are always sent strictly sequentially, never
concurrently.
