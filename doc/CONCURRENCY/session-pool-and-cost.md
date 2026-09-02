# Session pool, connection cost & measured numbers

How abapsmith shares one ABAP system, and one technical user, across concurrent
tool calls — the bounded pool of session slots, what establishing a session
actually costs, and measured numbers from a live sandbox.

## Session pool

Every ADT request goes through a bounded pool of stateful session slots, divided into roles:

| Role | Default count | Env | Purpose |
|---|---|---|---|
| read | 2 | `ABAP_READ_CONCURRENCY` | Non-mutating requests |
| write | 2 | `ABAP_WRITE_CONCURRENCY` | Lock → PUT → unlock → activate cycles |
| debug | fixed at 1 in-flight (`DEBUG_CONCURRENCY`), no env knob | — | The single active debug listener/lease |
| **total** | 5 (`ABAP_MAX_SESSIONS`, max 16) | `ABAP_MAX_SESSIONS` | Hard ceiling on live slots |

Role limits are configured independently and are **not** clamped to fit under
`maxSessions`; widening a role limit without widening `maxSessions` to match
makes the slot count, not the role limit, the binding constraint — the server
only warns about the mismatch at startup, it does not refuse it.

A debug reservation is a lease, not a lane: it reserves exactly one slot for
the lifetime of a debug session, and `abapsmith` refuses a second concurrent
debug lease outright — "a second concurrent one is a bug, not a tuning
opportunity." That refusal is in-process only; the cross-process half is
[the debug arm lock](object-gate-and-debug-lock.md#the-debug-arm-lock).

That single lease is also self-triggered only: `start` requires the caller to
supply `run`, and the debuggee identity is hardcoded to the configured user, so
this pool has no notion of arming a listener and waiting for a third party's
session under a different user.

**Exhaustion behavior.** A caller that cannot get a slot is refused, never
starved silently:

- `lease-held` — the pool is held entirely by a debug lease; a debug
  reservation never queues behind anything, and a normal request never
  queues behind a debug lease holding the whole pool either (that would mean
  stalling for up to the debugger's full long-poll timeout).
- `queue-full` — more than `maxQueue` (default 8, not currently exposed as
  an env var) callers are already waiting for a slot.
- `wait-timeout` — the caller waited past `ABAP_SESSION_WAIT_MS` (default
  10 000 ms) for a slot.

All three surface as `SessionBusyError` (`code: "SESSION_BUSY"`), naming the
holder — operation label, how long it has held the slot, and whether it is an
exclusive slot or a debug lease — so a caller can decide whether to retry.

The wait budget is an **absolute deadline**, computed once per call: retrying
internally after discovering a dead slot does not reset the clock, so a
string of corpses cannot turn a bounded wait into an unbounded one.

Everything above is a **per-process** budget. For what happens when more than
one `abapsmith` process points at the same appliance, see
[Several agents, one sandbox](several-agents-one-sandbox.md).

## What a session costs to establish

`connect()` is not one request. It is logon → ADT discovery → system-role
probe, and the pool pays all three every time it mints a slot, because both
caches that could avoid two of them (`Discovery`, `AbapConnection.cachedDetection`)
live on the connection **object** while the pool always mints a new object.

Measured on the sandbox below: ~95 ms of that ~730 ms is the logon — the only
leg that is genuinely a property of *this session*. The other ~635 ms
re-derives facts about the **system** (which ADT collections this release
exposes; whether the client is productive) that are identical for every slot
and do not change while the process runs.

Two consequences follow, and both are visible in any benchmark that times
tool calls:

1. **The cost lands on an arbitrary caller.** `prepare()` runs inside
   `acquire()`, which runs inside the tool call, so whichever call happens to
   mint a slot pays ~730 ms inside its own measured window and every later
   caller on that slot pays none. When the *primary* is re-seated onto a newly
   minted slot the bill moves one step further out — `prepareConnection` is a
   no-op for the pinned slot, so the pool's own `acquire` measures **0 ms** and
   the whole `connect()` is paid by `ensureConnected()` in `src/server.ts`.
2. **The anomalously FAST measurement is the displaced one, not the fast one.**
   A re-seat that adopts an already-connected slot (`seatPrimary` tier 1) costs
   nothing at all, so the call straddling it looks ~10x faster than its
   neighbours. Nothing got faster; somebody else was charged.

Set `ABAP_TIMING_DEBUG=1` to emit the split on stderr — one line per
`connect()` (`timing connect … logon=… discovery=… role=… roleCached=…`), per
slot preparation (`timing prepare …`), and per acquisition (`timing acquire …
warm=…`), plus `connected=`/`prepared=` on the primary re-seat line so the two
tiers above can be told apart. It is off otherwise and changes no behaviour.

## Measured numbers

Captured live against a single-instance ABAP developer sandbox with
`rdisp/wp_no_dia = 7` dialog work processes. These are measurements from one
system under one workload — read them as orders of magnitude that explain the
shipped defaults, not as guarantees for your landscape.

| Measurement | Value | Condition |
|---|---|---|
| Queue delay under DIA pressure | 14 075 ms (one sample) | 5 of 7 DIA work processes held busy by CPU-bound load; the observer's own request queued for a free work process |
| Parallel write cycles | 6/6 succeeded, 0 cross-talk, all locks acquired within a 159 ms window | 6 sessions, 6 distinct objects, full lock→PUT→unlock→activate cycle each, wall clock 1.83 s |
| Parallel reads | 20/20 succeeded, 0 cross-talk; latency min 194 ms / p50 341 ms / p90 893 ms / max 913 ms | 20 concurrent reads across 4 clients, wall clock 928 ms |
| Session fan-out, slowest single call | 153 / 137 / 154 / 299 ms | N = 2 / 4 / 8 / 16 simultaneous logged-on sessions each making one classrun call; no failures at any level |
| Session fan-out, logon time | 462 / 210 / 262 / 321 ms | Same N = 2/4/8/16 runs; N=16 logged on faster than N=2 (warm caches) |
| Passive session expiry | ~32 min (`plugin_auto_logout` 1800 s + 120 s), upper bound only | Idle stateful session holding a lock, then reused; server answers `400 Session Timed Out` (`x-sap-icm-err-id: ICMENOSESSION`); the lock itself is released with the session |
| Long-poll head-of-line blocking, same session | 115 133 ms blocked (of a 120 s listener timeout); 55 148 ms blocked (of a 60 s listener timeout) | A second request issued on the same session as an active debug long-poll listener; it does not kill the listener, it queues behind it to the listener's natural timeout |
| Debug lease cost | 1 dialog work process pinned per suspended debuggee, additive, released on terminate | 60 samples across 3 phases (0/1/2 suspended debuggees) plus an in-run positive control (2 CPU-bound workloads added), unanimous per phase, no histogram spread |
| Small ADT round trip (`GET /ato/settings`) | min 61 / p50 71 / max 115 ms | Warm, already-established session. The unit every row below is quoted in. |
| `connect()` on a FRESH connection object | min 647 / p50 ~730 / max 850 ms | n=15 across three runs. Split below. |
| — logon leg | p50 ~95 ms | One `POST /sap/bc/adt/compatibility/graph`. The only genuinely per-session leg. |
| — ADT discovery leg | p50 ~245 ms | `GET /sap/bc/adt/discovery` alone measures p50 187 ms warm (165 KB), so ~60 ms is parse |
| — system-role leg | p50 ~390 ms | `POST /datapreview/freestyle` (T000) p50 302 ms + `GET /ato/settings` p50 69 ms |
| `connect()` REVIVING the same connection object | min 71 / p50 77 / max 95 ms | n=8. `Discovery` and `cachedDetection` are per-connection caches, so a revival re-logs-on and skips both. **8.6x cheaper than minting a new object for the same system.** |
| Caller-visible cost of a re-seat that MINTS the primary | min 861 / p50 893 / max 943 ms, vs 77 ms warm | n=4. Slot killed, no other live slot, so `seatPrimary` tier 2 mints a PINNED slot — which `prepareConnection` deliberately does not connect — and the next caller's `ensureConnected()` pays the whole `connect()`. The pool's own `acquire` reports **0 ms**. |
| Caller-visible cost of a re-seat that ADOPTS a live slot | min 56 / p50 85 / max 136 ms | n=4, same run, same appliance minute. `seatPrimary` tier 1 adopts a slot `prepareConnection` already logged on, so the re-seat is free — because a *different* caller already paid 718 ms for it. |
