# Concurrency

How abapsmith shares one ABAP system, and one technical user, across
concurrent tool calls — the session pool, the cross-process locks layered on
top of it, and where the safety margins actually come from. See
[doc/CONFIGURATION](../CONFIGURATION/README.md) for the environment
variables that tune the values discussed here.

| Part | Covers |
|---|---|
| [session-pool-and-cost.md](session-pool-and-cost.md) | The read/write/debug slot pool, exhaustion behavior, what establishing a session costs, and measured numbers from a live sandbox |
| [object-gate-and-debug-lock.md](object-gate-and-debug-lock.md) | The two sibling cross-process locks: same-object write serialisation and the debug-listener arm lock |
| [etag-race-and-auth-breaker.md](etag-race-and-auth-breaker.md) | The pre-activation etag re-read that narrows the lock-release-to-activate race, and the 401 circuit breaker that protects against account lockout |
| [several-agents-one-sandbox.md](several-agents-one-sandbox.md) | The cross-process hazard when more than one abapsmith process shares an appliance, an incident writeup, and how to check your own footprint |
