# Several MCP sessions, one session pool

`ABAP_MCP_TRANSPORT=http` lets one process serve more than one MCP client
at once, over the SDK's Streamable HTTP transport. This is what is
per-session and what is per-process when that happens, and what it costs
you against the budgets described in
[session-pool-and-cost.md](session-pool-and-cost.md).

## Per session

- The `McpServer` instance — its own tool registry, its own protocol state.
- The `Mcp-Session-Id`, minted by the SDK on that session's `initialize`.
  Two things end that session: an explicit `DELETE` carrying that
  `Mcp-Session-Id`, and the process shutting down. A client that merely
  disconnects leaves its session — and its share of anything the session
  holds — live on the server until then. Pinned by
  `test/mcp-http-transport.test.ts`.
- Journal attribution: `actor`/`sessionId` for a write made inside this
  session are resolved from the `AsyncLocalStorage` context bound around
  that request (`src/mcp-session.ts`, `runInMcpSession`) — see
  [doc/JOURNAL/journal-format.md](../JOURNAL/journal-format.md).

## Per process

Everything expensive and stateful is shared by every session in the
process, not duplicated per session:

- One `AdtSessionPool` — the read, write, and debug lanes described in
  [session-pool-and-cost.md](session-pool-and-cost.md), and the env vars
  that size them (`ABAP_MAX_SESSIONS`, `ABAP_READ_CONCURRENCY`,
  `ABAP_WRITE_CONCURRENCY`, `ABAP_DEBUG_SESSIONS`).
- One `SafetyGate`.
- One `Journal`, writing into one journal directory.
- One state directory (`ABAP_STATE_DIR`).
- One circuit breaker (the 401 auth breaker described in
  [etag-race-and-auth-breaker.md](etag-race-and-auth-breaker.md)).
- One debug lease.

## The consequence

N MCP sessions do NOT get N ADT sessions. `ABAP_MAX_SESSIONS` (default 5)
and `ABAP_READ_CONCURRENCY`/`ABAP_WRITE_CONCURRENCY` (2/2 by default) are
still the ceiling for the whole process, not per session. A busy second MCP
session competing for a pool slot gets the same `SessionBusyError` codes
documented in [session-pool-and-cost.md](session-pool-and-cost.md#session-pool)
— `lease-held`, `queue-full`, `wait-timeout` — that a busy stdio process
would produce for a second concurrent tool call. Running `http` does not
raise the pool's capacity; it only lets more callers compete for the same
capacity.

**The debug lease.** `resolveDebugSessionLimit(cfg)` — 1 by default — is
process-wide, so one MCP session holding a debug lease blocks every other
MCP session's `abap_debug start` the same way it would block a second
concurrent stdio process. SAP itself adds a second, harder ceiling on top
of that: exactly one active debug listener per SAP user on the system,
regardless of how many MCP sessions or abapsmith processes are asking — see
[session-pool-and-cost.md](session-pool-and-cost.md#session-pool) for the
`409`/`conflictDetected` behaviour this produces.

**The cross-process object gate.** `ABAP_CROSS_PROCESS_OBJECT_LOCK` (see
[object-gate-and-debug-lock.md](object-gate-and-debug-lock.md)) still
serialises writes to the same object. Two MCP sessions inside one `http`
process writing the same object hit that same gate — it does not
distinguish "two sessions, one process" from "two processes", because it
was built to serialise on the object, not on the caller.

## How this relates to several-agents-one-sandbox

[several-agents-one-sandbox.md](several-agents-one-sandbox.md) describes the
hazard of more than one `abapsmith` **process** pointed at the same
appliance: nothing coordinates pool size across processes, so DIA demand
can multiply per process. The `http` transport is the alternative to that
hazard, not another instance of it: N MCP sessions inside one `http`
process share the one connection pool and the one journal that document
describes wanting — the multi-process failure mode it walks through does
not apply within a single `http` process, because there is only one pool to
exhaust, one journal to consult, and one set of `ABAP_MAX_SESSIONS`/
`ABAP_READ_CONCURRENCY`/`ABAP_WRITE_CONCURRENCY` limits governing all of
it. Running several agents against one appliance as several MCP sessions on
one `http` server, instead of as several separate `abapsmith` processes, is
what removes the cross-process coordination gap that document describes.

## Sizing guidance

If you expect N concurrent developers on one `http` process, raise
`ABAP_MAX_SESSIONS`/`ABAP_READ_CONCURRENCY`/`ABAP_WRITE_CONCURRENCY`
deliberately rather than leaving the single-conversation stdio defaults in
place — and read the measured numbers in
[session-pool-and-cost.md](session-pool-and-cost.md#measured-numbers)
first, since they are what those defaults are sized against. This guidance
is **unverified** at multi-developer scale: every measurement in that file
was taken with one caller at a time against a single sandbox appliance, and
the `http` transport itself has only been run with a small number of
concurrent MCP sessions in the offline test suite (see
[doc/CONFIGURATION/transport.md](../CONFIGURATION/transport.md#not-verified)).
Nothing here has been measured with several real developers driving one
`http` process at once.
