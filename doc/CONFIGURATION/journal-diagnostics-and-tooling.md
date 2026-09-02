# Journal, debugger identity, diagnostics & tool surface

## Journal

| Variable | Default | Effect |
|---|---|---|
| `ABAP_JOURNAL` | on | Set to `off`/`false`/`0` to disable. Anything else, including unset, leaves it on. |
| `ABAP_JOURNAL_DIR` | `<cwd>/.abapsmith/journal` | Root directory; a `<SID>` subdirectory is added underneath, so two systems never share a journal. |
| `ABAP_JOURNAL_MAX_ENTRIES` | `200` | Retention: keep the newest N entries. |
| `ABAP_JOURNAL_MAX_AGE_DAYS` | `30` | Retention: drop anything older than this. |
| `ABAP_ACTOR` | unset | Who to record as `actor` on each new journal entry — an operator/agent identity, not a tool name. Read once at startup; wins over the MCP client's `clientInfo.name`, which is resolved per-connection instead, since it isn't known that early. Unset AND no client identity reachable means the entry simply has no `actor` (never a placeholder). Operator-supplied and untracked (`.abapsmith/journal/**`), so treat it like the source it sits beside — do not put a real hostname/username/email in it. |
| `ABAP_STATE_DIR` | `<cwd>/.abapsmith` | Home of the cross-process journal-index lockfile and the durable auth latch. Two terminals must resolve to the same directory to protect each other. |
| `ABAP_LOCK_WAIT_MS` | `5000` | How long to wait for the cross-process journal-index lock. The value actually enforced at runtime (`resolveLockWaitMs` in `src/state-dir.ts`) accepts `100`–`120000` and silently falls back to the default outside that range — this differs from the config-schema copy of the same field (`src/config.ts`), which only rejects non-positive values at startup and is otherwise unused. |

## Debugger identity

| Variable | Default | Effect |
|---|---|---|
| `ABAP_TERMINAL_ID` | derived | Stable terminal id for the debugger. Must be exactly 32 uppercase hex characters (SYSUUID_C32) if set — lowercase names a different session. |
| `ABAP_IDE_ID` | derived | Stable IDE id for the debugger. Same format constraint. Makes two processes distinguishable to SAP — it does not grant a second concurrent global-scope debug session. |
| `ABAP_CROSS_PROCESS_DEBUG_LOCK` | `true` | Whether arming a debug listener takes a cross-process lockfile on this `(URL, client, user)`'s single debugger slot. Set to `false`/`0`/`no`/`off` to fall back to the in-process guards only. Independent of `ABAP_CROSS_PROCESS_OBJECT_LOCK` — a different resource with a different failure mode. **On by default — this is a live behaviour change for every existing deployment**, since a version without the lock silently had no cross-process protection at all. Read through the config schema, like `ABAP_CROSS_PROCESS_OBJECT_LOCK` in [concurrency-and-activation.md](concurrency-and-activation.md#session-pool--concurrency). |
| `ABAP_DEBUG_LOCK_WAIT_MS` | `1500` | How long `armListener()` waits for that lock before failing with `DEBUG_SESSION_LOCKED_CROSS_PROCESS`. Same accepted range (`200`–`30000`) and soft-fallback-on-invalid behaviour as `ABAP_OBJECT_LOCK_WAIT_MS` in [concurrency-and-activation.md](concurrency-and-activation.md#session-pool--concurrency) — falls back to the default silently rather than failing startup, unlike most numeric fields. Read through the config schema and reported by the startup config report. |

When either is unset, the server derives it deterministically from
`SID:USER:terminalId` / `SID:USER:ideId`. Two processes with the same
`ABAP_SID` and `ABAP_USER` and no explicit id therefore derive the **same**
identity and SAP cannot tell them apart. Set both explicitly for any
deployment that runs more than one abapsmith process against the same user.
Setting `ABAP_TERMINAL_ID` equal to `ABAP_IDE_ID` is also wrong — it collapses
the pair SAP uses to distinguish sessions.

For how the cross-process debug lock actually behaves at runtime — key,
timeout, crash recovery — see
[the debug arm lock](../CONCURRENCY/object-gate-and-debug-lock.md#the-debug-arm-lock)
in doc/CONCURRENCY.

## Diagnostics

| Variable | Default | Effect |
|---|---|---|
| `ABAP_MAX_RESPONSE_CHARS` | `47100` | Hard cap on a single tool response (~15k tokens at 3.14 chars/token — the same `DEFAULT_MAX_CHARS` `src/compact.ts` derives, not a second literal). Maximum accepted value is `200000`; anything higher is refused at startup, because one response that large crowds out the agent's whole context window. Truncation is always marked, never silent. |
| `ABAPSMITH_BODY_DUMP_DIR` | unset | When set, raw ADT error bodies and oversized diagnostic payloads are written here as files instead of into a tool response. Gitignore it — bodies contain customer data and ABAP source. |

## Write verification

| Variable | Default | Effect |
|---|---|---|
| `ABAP_VERIFY_WRITES` | `speculative` | `speculative`: a write that was created and activated without error is treated as sufficient. `verified`: the object is read back and confirmed after a successful write. |

This switch governs caller-facing guidance — the skill procedures and
post-write hints that prescribe an `abap_read` after a write — plus, in
`verified` mode, one server-side read-back on the success path. It does
**not** govern the classrun-bridge create verification or the post-DELETE
confirmation (both in `src/adt/write-verify.ts`): those stay on in both
modes because their own success responses cannot prove persistence, so
there is nothing "speculative" to opt into for them.

Verification on the FAILURE path is unconditional in both modes too. A
write that reports failure while the object actually exists leaves
permanent residue, because no cleanup runs for a reported failure — success
is the common path and is where `speculative` mode saves work, while a
reported failure is rare enough that verifying it is nearly free.

A per-call `verify` field on `abap_write` can raise a single call to
`verified`, but can never lower one below the configured mode.

## Tool surface

| Variable | Default | Effect |
|---|---|---|
| `ABAP_TOOL_SURFACE` | `v1` | `v1` (the full individual-tool registrar set) or `v2` (six consolidated tools, far fewer schema tokens). Orthogonal to `ABAP_MODE`: this decides which tools are advertised, the mode decides what they may do. |

**`v2` is experimental and is not supported for production use.** It exists
for trying the consolidated surface out — exploration, low-stakes,
non-production sessions — not for anything you depend on. Known v2 defects
are **not being fixed** while v2 holds this status — see
`doc/TOOL-SURFACE-V2/README.md` for details. `v1` is the supported surface and the
recommended default. There is no `both` value: `v2`'s consolidated tools
reuse `v1` tool names verbatim, so registering both surfaces in one process
throws at startup.
