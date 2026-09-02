# Safety, sessions, and concurrency

Why some decisions look odd from the outside. Each entry states the rejected
alternative and what decided it. See also [API surface and data
integrity](api-and-data-integrity.md) for the tool-surface and write-path notes.

## Role detection is tri-state, and inconclusive means no

**Instead of:** a boolean `isProductive`.

A boolean collapses "proven safe" and "unknown" into the same `false`. That is
the fail-open bug the type exists to make unrepresentable: the one case where
the server has no idea what it is talking to would be the case it granted write
access to. `inconclusive` is treated exactly like `productive`.

The write lockout is also a **one-way latch** — no later verdict re-opens
writes, because the pooled primary connection is re-seatable and re-probes from
scratch. The costs of being wrong are asymmetric: staying locked on a sandbox
costs inconvenience and prints the evidence; unlocking on production costs an
unauthorised write that no restart undoes. Details in [doc/SAFETY §
Safety gate](../SAFETY/safety-gate.md).

## Authorisation is a type, not a parameter

**Instead of:** passing an optional `gate?: SafetyGate` to mutating functions.

An optional parameter makes "forgot to gate this call" a silent, legal permit.
Mutating call sites take an `AuthorizedTarget<Op>` instead, which only
`SafetyGate.authorize()` can mint, so forgetting is a compile error. A runtime
token check backs it up, so a deliberate `as unknown as` cast throws rather than
passing quietly.

## A 401 trips the breaker on the first failure

**Instead of:** retrying authentication a few times, as most HTTP clients do.

SAP's `login/fails_to_user_lock` commonly defaults to 5. A retry loop against a
stale password does not recover the connection; it locks the account, usually a
shared technical user, and now nobody can work. One failure, one latch, no
retry. The same reasoning removed lock/unlock tools entirely — no agent should
be able to leave someone clearing SM12 by hand.

The productive-system probe carries the same invariant: exactly one POST, no
retry, deliberately routed around the CSRF-resend path that would turn one POST
into two.

## Sessions are never health-probed

**Instead of:** a cheap "are you still alive?" round trip before using a pooled
session.

A probe on a session with an outstanding long poll is head-of-line blocked for
the remainder of that poll — measured at roughly 55 s and 115 s. The pool
therefore has no confirmation round trips and no health probes; session death is
classified from the failure that actually occurs, in three tiers, starting with
the `ICMENOSESSION` header at any status. See [doc/CONCURRENCY §
Session pool and cost](../CONCURRENCY/session-pool-and-cost.md).

## Re-locking is not idempotent, so the lock ledger is explicit

A same-session re-`LOCK` returns the same `403` as a genuine foreign conflict,
and nothing in the response distinguishes them. The session therefore keeps its
own lock ledger and short-circuits a re-lock rather than asking the server, and
releases newest-first on teardown without throwing.

## The debugger is read-only by construction

**Instead of:** exposing variable and stack-position writes, which the underlying
protocol supports and which are implemented at three internal layers.

They are simply not exposed, and four endpoints throw unconditionally because
they were observed to short-dump the system. A debugger that can write
variables in a live session is a much larger blast radius than one that reads,
and reading is what an agent needs to diagnose.

It is also self-triggered only: `run` is required on `action:"start"`, so it
cannot arm a breakpoint and wait for a session it did not itself launch, and
the debuggee identity is hardcoded to the configured user (`requestUser:
params.cfg.user`), so it cannot listen for another user's session either.

## Dangerous endpoints are unreachable, not just unused

The HTTP guard denies the `relwithignlock` / `relobjigchkatc` endpoint family and
the `ignorelocks` / `ignoreatc` query parameters at both socket sinks, after up
to three percent-decode rounds and RFC 3986 dot-segment removal. Not calling
them would be enough until someone builds a URL from a tool argument; this way
the URL cannot be constructed at all.
