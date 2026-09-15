# Multi-system: isolation and the one shared lane

This page covers what changes about concurrency, pooling and locking once
more than one system is configured (see
[CONFIGURATION/multi-system.md](../CONFIGURATION/multi-system.md)). The
short version: almost everything below the routing layer is duplicated one
copy per system, with a single, deliberate exception — the debugger.

## One pool per system

Each configured system gets its own connection pool, sized by that
system's own `ABAP_MAX_SESSIONS` / `ABAP_READ_CONCURRENCY` /
`ABAP_WRITE_CONCURRENCY` (which default the same way for every system
unless overridden per entry via `env`; see
[CONFIGURATION/concurrency-and-activation.md](../CONFIGURATION/concurrency-and-activation.md)
for what those variables do for one system). Nothing is shared between
pools — a QAS call queued behind QAS's write-concurrency limit does not
wait on, or compete with, DEV's sessions at all. This also means the
process-wide session ceiling is `N ×` `ABAP_MAX_SESSIONS` summed across
however many systems are configured, not one shared ceiling of
`ABAP_MAX_SESSIONS` split between them — three systems at the default of 5
is up to 15 concurrent ADT sessions from one abapsmith process, each
system still individually capped at the 16-session hard ceiling described
in concurrency-and-activation.md.

Each system's pool also carries its own ADT logon and session cookies, its
own auth circuit breaker (see
[etag-race-and-auth-breaker.md](etag-race-and-auth-breaker.md)) and its
own durable auth latch. A logon failure or an open breaker on QAS has no
effect on DEV's pool — each is its own state machine, keyed only by its
own alias, not by any shared connection identity.

## Per-system role probe and discovery cache

The `/discovery` feature inventory and the T000 client-role probe (used to
populate `safety.systemRole` — see
[TOOLS/system-resource.md](../TOOLS/system-resource.md)) are fetched and
cached once per system, the same as they are for a single-system
deployment, just N times instead of once. A productive client on PRD and a
customizing client on QAS are read independently — nothing infers one
system's role from another's, and nothing shares a discovery cache across
aliases even when two entries happen to point at the same physical SAP
system under different client numbers.

## The object gate: key gains the system

The object gate (see
[object-gate-and-debug-lock.md](object-gate-and-debug-lock.md)) serialises
writes to the same object. Its lock key now includes the target system,
not only the object URI — a write to `ZCL_FOO` on DEV and a write to
`ZCL_FOO` on QAS are different objects as far as the gate is concerned,
and proceed independently, exactly as they should: they are different
ABAP repositories on different systems, and serialising them against each
other would be a false conflict. See
[object-gate-and-debug-lock.md](object-gate-and-debug-lock.md#the-object-gate-key-now-includes-the-system)
for the lock-filename consequence of this key change.

## The exception: one debugger lane for the whole process

Everything above is duplicated per system. The debugger is not: abapsmith
has exactly one debugger lane per process (see
[TOOLS/debugger.md](../TOOLS/debugger.md)), and that lane is shared across
every configured system, not given one copy per alias. Starting a debug
session against QAS while one is already active against DEV does not open
a second, independent lane — it is refused the same way starting a second
debug session against the SAME system is refused, and any subsequent
debugger call is checked against the system the active session actually
belongs to; a call routed at a different system than the active session's
is refused with `SYSTEM_MISMATCH` (see
[TOOLS/debugger.md](../TOOLS/debugger.md#system_mismatch-one-debug-session-for-the-whole-process)).

This is a deliberate simplification, not an oversight: a debugger lane
already carries meaningful per-process state (breakpoints, the active
`DEBUGGEE_ID`, the dedicated hygiene connection — see
[object-gate-and-debug-lock.md](object-gate-and-debug-lock.md#the-debug-arm-lock)),
and running two independent debug sessions against two systems from one
process at once would multiply that state without a corresponding way for
a single calling agent to keep straight which stepped variable belongs to
which system. One lane keeps the failure mode simple: pick one system to
debug at a time, finish or stop it, then debug the other.

## Journal: one directory per system

Each system gets its own journal directory (`ABAP_JOURNAL`, defaulted or
overridden per entry the same way any other setting is — see
[CONFIGURATION/multi-system.md](../CONFIGURATION/multi-system.md#per-entry-keys)),
so a DEV entry and a QAS entry never write undo records into the same
directory unless an operator explicitly points both at the same path.
Doing so is not caught at startup — nothing currently detects two aliases
sharing one journal directory as a misconfiguration — and would mix two
systems' undo history together in one place. This is also the reason
per-system journal directories not colliding in practice is called out as
unproven rather than guaranteed; see
[LIMITATIONS/not-implemented-and-unproven.md](../LIMITATIONS/not-implemented-and-unproven.md#unproven).

Nothing about journal *entries themselves* is new here: each entry has
always carried a `systemKey` (SID, host and client) and undo has always
refused to replay an entry against a system that does not match it — see
`systemMismatchBlocker()` in
[JOURNAL/undo-and-recovery.md](../JOURNAL/undo-and-recovery.md). Multi-system
configuration makes that refusal easier to trigger by accident (two real
systems are one `system` parameter away instead of requiring two separate
server processes), but it does not change the refusal itself.
