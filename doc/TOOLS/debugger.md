# Debugger

One debug session lane is active per process by default; `ABAP_DEBUG_SESSIONS`
raises how many lanes one process may hold concurrently, but SAP itself still
allows only one active debug listener per SAP user on a system regardless of
that setting — see [`ABAP_DEBUG_SESSIONS`](#abap_debug_sessions) below.

## abap_debug

ABAP debugger driver: arm breakpoints, run a target program on a separate
connection, step, inspect the stack, and stop.

**Availability**: case 2 — always registered. `stack`, `frame`, `status`,
`keepalive`, `stop`, and `breakpoints`/`watch` with `op="list"` are ungated
(read-only, or a client-side record of what this session already armed).
`start`, `step`, and `breakpoints`/`watch` with `op="add"`/`"remove"` are
gated on `canWrite` (they arm, remove, or advance a live debuggee).

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `action` | enum `start` \| `step` \| `stack` \| `frame` \| `breakpoints` \| `watch` \| `keepalive` \| `stop` \| `status` | yes | — | What to do. |
| `breakpoints` | array of line/exception/statement/message breakpoint objects | required for `action=start` and for `action=breakpoints` `op=add` | — | At least one entry. Kinds may mix within one array. Validated against SAP before anything is armed. |
| `run` | object `{object, mode?}` | required for `action=start` | — | Program to trigger, on a separate connection. `mode`: `class` \| `report` \| `auto`, default `auto`. |
| `step` | enum `into` \| `over` \| `return` \| `continue` \| `runToLine` \| `jumpToLine` | required for `action=step` | — | How to advance. `continue` may end the session. `jumpToLine` is disabled by default. |
| `toLine` | number (int, 1–999999) | required for `step=runToLine`/`jumpToLine` | — | 1-based target line in the current frame's own source. |
| `stateId` | string | required for `action=step`/`stack`/`frame`/`breakpoints`/`watch` | — | Identifies one stop. A stale id is refused, naming the current one. |
| `frame` | number (int, ≥1) | required for `action=frame` | — | 1-based stack position to move the read cursor to. |
| `op` | enum `list` \| `add` \| `remove` | no | `list` for `action=breakpoints`; for `action=watch`, `add` when `variable` is given, else `list` | `action=breakpoints`/`watch` only — which operation to perform. |
| `id` | string | required for `op=remove` | — | `action=breakpoints`/`watch` only — the id to remove; restricted to an id this session owns. |
| `variable` | string | required for `action=watch` `op=add` | — | Variable path to watch, same syntax `abap_debug_value` accepts. Presence selects `op=add`. |
| `condition` | string (≤255 chars) | no | — | `action=watch` `op=add` only — ABAP boolean expression; the watchpoint only suspends when it evaluates true. Distinct from the per-breakpoint `condition` nested inside `breakpoints[]` entries below, which conditions a breakpoint instead. |
| `confirm` | string | no (required for `step=jumpToLine`) | — | Must literally be `"jumpToLine"`. Also needs `ABAP_ALLOW_DEBUG_JUMP_TO_LINE=true`. |
| `force` | boolean | no | — | `action=stop` only — also force-terminate a debuggee this server's own identity left attached after an unclean exit. |

A line breakpoint (`kind: "line"`): `object` (string, required — any form
`abap_read`/`abap_run` accept: a bare name, `class ZCL_FOO`, a raw ADT URI;
resolved server-side to a source URI), `line` (number, int, 1–999999,
required — 1-based; SAP may snap it to the nearest executable statement, in
which case the `start` response reports the corrected line), plus shared
`condition` (string, ≤255 chars, optional — an ABAP boolean expression, e.g.
`sy-tabix = 500` or `lv_name = 'FOO'`; validated server-side when armed,
refused if SAP cannot parse it) and `skipCount` (int, ≥0, ≤1000000, optional
— e.g. `skipCount: 9` breaks on the 10th hit, `0` (default) breaks on every
hit; accepted but not enforced server-side, every hit still suspends).

An exception breakpoint (`kind: "exception"`): `exceptionClass` (string,
required — fires wherever that exception is raised, not only inside the
object named in `run`), plus the same `condition`/`skipCount`.

A statement breakpoint (`kind: "statement"`): `statement` (string, required
— an ABAP statement keyword, e.g. `RAISE`, that fires wherever it occurs),
plus the same `condition`/`skipCount`. Legal values are server-enumerated,
not an enum in this schema: `GET /sap/bc/adt/debugger/breakpoints/statements`
answers roughly 27 KB of rows, so a bad keyword is not caught client-side —
SAP validates it, and refuses it, when the breakpoint is armed.

A message breakpoint (`kind: "message"`): `msgId` (string, required —
message class, e.g. `00`), `msgNo` (string, required — message number, e.g.
`"008"`; a string rather than a number because a leading zero is
significant and must survive), `msgTy` (string, required — message type
letter, e.g. `E`), plus the same `condition`/`skipCount`.

Kinds may be mixed in one `breakpoints` array, at `start` or at
`action="breakpoints"` `op="add"`. Breakpoint ids are server-assigned and
encode the kind numerically — line `KIND=0`, statement `KIND=1`, exception
`KIND=5`, message `KIND=12` — so an id cannot be predicted client-side; a
line breakpoint posted as a source URI (`…#start=<line>`) additionally comes
back resolved to an include+line form (live example: `#start=11` on
`ZCL_I89_PROBE`'s class-main source came back as
`INCLUDE=ZCL_I89_PROBE=================CM001.LINE_NR=5`,
`test/fixtures/live-captured/904-bp-set-line-i89-probe.xml`), while an
exception or message breakpoint's id is fully determined by its own fields
(live: `test/fixtures/live-captured/903-bp-set-exception-accepted.xml`,
`902-bp-set-message-accepted.xml`). "Break when `CX_SY_ZERODIVIDE` is raised
anywhere in this run" is therefore one call:

```json
{
  "action": "start",
  "run": { "object": "ZCL_DEMO_ORDER", "mode": "class" },
  "breakpoints": [{ "kind": "exception", "exceptionClass": "CX_SY_ZERODIVIDE" }]
}
```

What each action does: `start` arms the breakpoints, triggers the run on a
separate connection, and waits for it to hit one — returning the stack and a
full variable survey at that first stop. `step` advances execution and
returns the new stop's stack and variable survey, or — if the program ran to
completion instead — the captured output in place of a survey. `stack`
re-fetches just the call stack for the given `stateId`, with no variable
survey. `frame` returns the newly-selected frame's own variable survey, in
addition to moving the read cursor. `breakpoints` lists, adds, or removes
this session's own armed breakpoints without restarting it (see below).
`watch` adds, lists, or removes watchpoints on this session (see below).
`keepalive` resets the idle timer on a suspended/caught session without
stepping. `stop` is idempotent — safe to call with no session active — and
returns the target program's captured output; it also best-effort releases a
debug listener left armed by an earlier process instance when this process
has no session of its own to route the stop through (separate from `force`,
which instead clears an ATTACHED/suspended debuggee). `status` reports the
current session's status with no network calls and no side effects.

Only `ABAP_DEBUG_SESSIONS` debug sessions (default 1) may be active per
process at a time — a `start` beyond that count is refused. (For what a
session's variables and frames support — read vs. write — see the Debugger
row in `doc/CAPABILITIES/non-object-capabilities.md`.)

### `action="breakpoints"` — manage armed breakpoints without restarting

`op="add"` takes the same `breakpoints` array as `start` and works while the
debuggee is suspended (live: `test/fixtures/live-captured/916-bp-add-while-stopped.xml`).
It is additive: the POST carries no `syncScope`, so it never deletes another
session's or Eclipse's breakpoints — only what this call itself adds.

`op="list"` (the default) reports only the breakpoints THIS session armed,
and cannot do otherwise: `GET /sap/bc/adt/debugger/breakpoints` answers `200`
with a **zero-byte body** (live: `test/fixtures/live-captured/917-bp-list-while-stopped.txt`,
`925-bp-list-after-cleanup.txt`), so ADT offers no server-side read of the
armed external breakpoint set at all — this tool's own in-memory record is
the only source of truth it has, and it cannot detect a breakpoint SAP
silently dropped or renumbered.

`op="remove"` deletes by `id` and refuses an id this session does not own.

Inspect the stack, then add a breakpoint without restarting:

```json
{ "action": "stack", "stateId": "<stateId>" }
```

```json
{
  "action": "breakpoints",
  "op": "add",
  "stateId": "<stateId>",
  "breakpoints": [{ "kind": "line", "object": "ZCL_DEMO_ORDER", "line": 21 }]
}
```

### `action="watch"` — watchpoints

`op="add"` (the default when `variable` is given) takes `variable` — the
same variable-path syntax `abap_debug_value` accepts — and an optional
`condition`, and reports the watchpoint's current value. `op="list"` reports
this session's own watchpoints, each with its old and new value. `op="remove"`
deletes by `id`, restricted to an id this session owns.

A watchpoint hit itself arrives on the **STEP response**, as
`reachedWatchpoints` — but that shape carries only the NEW value (`id`,
`variableName`, `currentValue`; no `oldValue`), so the old value is read back
separately, from the watchpoint resource, right after the stop; the response
labels it accordingly ("…, was `X` (read back from the watchpoint resource
after the stop)").

Watchpoint ids are small, reused integers, not stable handles: a modify
(`PUT`) retires the id it addressed and the server hands back a different
one, and a freed id is reused by the next create (live:
`test/fixtures/live-captured/940-watchpoint-modify-condition.xml`,
`941-watchpoint-list-after-modify.xml`, `942-watchpoint-create-duplicate.xml`
— a `PUT` on id `1` returned id `3`, and a later create re-used the
now-freed id `1`). This tool never issues that modify (only creates, lists,
and removes), so within one session's life an id it returns to you stays
valid until you `op="remove"` it yourself.

Two failure shapes are captured. Creating a watchpoint with no `variable`
answers `400` (`ExceptionParameterNotFound`, T100 `SADT_RESOURCE 017`; live:
`test/cassettes/debugger/watchpoint-create-missing-variable-400.cassette.json`).
Addressing an unknown id answers `404` (`AdtFailed`, T100 `TPDA_ADT 013`;
live: `test/cassettes/debugger/watchpoint-get-unknown-id-404.cassette.json`).

```json
{
  "action": "watch",
  "stateId": "<stateId>",
  "variable": "LV_TOTAL",
  "condition": "LV_TOTAL > 3"
}
```

### `action="stop"` — cleanup timing and forced clearing

Exception, statement, and message breakpoints are armed against the **SAP
user**, not against the debugged object or this session — they can outlive
the session that created them and, left behind, can catch an unrelated later
run under the same SAP user. `stop` (and `action="breakpoints"` `op="remove"`)
deletes only the breakpoints this session itself created; it cannot see or
remove one created by a different session, IDE, or an earlier, uncleanly
terminated process instance.

Deleting one breakpoint (`DELETE /sap/bc/adt/debugger/breakpoints/{id}`) has
been measured at 2.1-2.9s once the session is no longer attached to a live
debuggee (as opposed to well under a second while still attached). `stop`
issues one such `DELETE` per breakpoint this session armed, so it can
legitimately take several seconds, scaling with how many breakpoints are
still armed at the time it's called — this is normal, not a hang.

If `stop`'s response reports `Cleanup timed out on: ... — may still be armed
on the server`, the breakpoint delete(s) did not finish in time and the
underlying request may still be in flight or the breakpoint may still be
armed. When that happens on an active session's `stop`, calling
`abap_debug({action: "stop", force: true})` also force-clears a debuggee left
attached at this server's identity, on top of the ordinary cleanup — use it
to recover before starting a new session against the same target.

### Connection hygiene: the stateful ADT session is dropped after every debug session

SAP binds a debuggee's ATTACH to the connection's stateful ADT session (the
`sap-contextid`), not just to the debugger identity (`terminalId`/`ideId`).
Live-verified 2026-09-15 against A4H: inside one abapsmith process, the FIRST
`start`→`stop` cycle works, and every later `start` on the SAME connection
then fails with HTTP 500 "Debuggee already attached", even though a fresh
connection at the identical identity reports `terminateDebuggee` → 404
`noSessionAttached` and an empty 8-second listener poll — proof the server
side is already clean. To avoid this, the connection's stateful ADT session
is dropped after every debug session ends (a clean `stop`, a force-cleared
one, or a failed `start`'s own cleanup), so the next `start` always attaches
under a fresh ABAP session.

### `ABAP_DEBUG_SESSIONS`

`ABAP_DEBUG_SESSIONS` (default 1) sets how many concurrent debug leases
(lanes) one abapsmith **process** holds, capped from below by
`floor(ABAP_DEBUG_DIA_BUDGET / 2)` — each debug session pins 2 dialog work
processes (the suspended debuggee, plus the separate trigger connection).
Each lane has its own listener identity (`terminalId`/`ideId`) and its own
cross-process arm-lock file; lane 0 is byte-identical to the pre-lane
behaviour, so leaving this setting unset changes nothing.

Raising it only raises this **client's own local cap**. Once every
configured lane in this process is already held by a lease, a further
`start` is refused locally as `DEBUG_ALL_LEASES_BUSY`. But SAP itself still
allows only **one active debug listener per SAP user** on a system: a second
`POST /sap/bc/adt/debugger/listeners` for the same user is refused with
`409`/`conflictDetected` (T100 `SY 530`, "Another session already exists
with global debugging scope for user X") **even when the second request
carries a different `terminalId`** from the holder's — SAP's exclusivity at
this scope is keyed on the SAP user, not on the terminal or IDE id (live:
`test/cassettes/debugger/listener-conflict-409.cassette.json`). So for a
single-`ABAP_USER` deployment, raising `ABAP_DEBUG_SESSIONS` past 1 does not
make a second concurrent debug session possible — it only moves the refusal
from this client (`DEBUG_ALL_LEASES_BUSY`, at the configured limit) to SAP
itself (the `409` above), once that second lane's listener is actually
armed. A second lane only has a chance of working when it authenticates as a
different `ABAP_USER` (a second abapsmith process with its own SAP user).

Notes: a session mid-execution is single-flight — only one caller drives it.
`frame` only moves the read cursor; it never affects what the next `step`
runs. `jumpToLine` can skip code the program's state depends on, including
authorization checks — use deliberately; contrast with `step=runToLine`,
which resumes and stops at `toLine` in the *current* program (run-to-cursor)
without skipping anything between the current position and `toLine`.
`skipCount` is still sent to SAP even though it is not enforced; it may be
honored on SAP releases other than the one this was verified against (A4H),
but there is no way from the client side to tell which behavior a given
system has, so don't rely on it — use `step:"continue"` to skip past hits
you don't want to stop on instead. `run`'s captured output is not available
immediately after `start` returns — it surfaces later, once the debuggee
either ends the session via `step:"continue"` running to completion, or the
session is stopped. Force-terminating (`force:true` on `stop`) ends the
debuggee mid-execution; it is never automatic, and it can only reach a
debuggee this server's own identity produced, not another session's.

Example (start):

```json
{
  "action": "start",
  "run": { "object": "ZCL_DEMO_ORDER", "mode": "class" },
  "breakpoints": [{ "kind": "line", "object": "ZCL_DEMO_ORDER", "line": 12 }]
}
```

### Not verified

- `reachedWatchpoints` on an *attach* response is `unverified`. It is parsed
  for symmetry with the step response, but the attach capture
  (`test/fixtures/live-captured/908-attach-i89.xml`) contains none, because
  that stop was a line breakpoint, not a watchpoint hit.
- A *conditional* watchpoint actually gating a stop is `unverified`. A
  condition was accepted, stored, and echoed back verbatim, but in the
  capture run the unconditional watchpoint on the same variable fired first
  (`test/fixtures/live-captured/944-step-continue-conditional-watchpoint.xml`),
  so a condition was never isolated as the cause of a hit.
- Two genuinely concurrent debug sessions is `unverified`. Never
  demonstrated on the appliance, for the per-user exclusivity reason under
  [`ABAP_DEBUG_SESSIONS`](#abap_debug_sessions) above.

## abap_debug_vars

Tier-1 survey of every variable in scope at the current debugger stop.

**Availability**: case 2 — always registered, always a read (`canWrite` not
required).

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `stateId` | string | yes | — | From the most recent start/step/stack response. |
| `scope` | enum `all` \| `locals` \| `parameters` \| `globals` | no | `all` | Narrow the survey. |
| `filter` | string | no | — | Case-insensitive substring match on variable name. |

Complex values render as compact stubs, each naming the exact
`abap_debug_value` call to drill into it — nothing is silently dropped.

## abap_debug_value

Tier-2 drill-in: render one variable path in full detail, with a row window
for tables.

**Availability**: case 2 — always registered, always a read.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `stateId` | string | yes | — | From the most recent start/step/stack response. |
| `path` | string | yes | — | Variable path, e.g. `LT_ITEMS[42]-MATNR` or `SY-SUBRC`. Field symbols keep their angle brackets. |
| `from` | number (int, 1–999999) | no | `1` | Tables only — 1-based first row. |
| `count` | number (int, positive, ≤200) | no | `20` | Tables only — rows to return. Page with `from` for more. |
| `depth` | number (int, 1–999999) | no | `3` | Max nesting depth for structures/objects. |

The tool never silently truncates a value: everything cut to fit the
response budget is named with an exact retrieval call — a row window via
`from`/`count`, or nesting via `depth`. Paths are typically read off
`abap_debug_vars`' REACHABLE block (or a prior `abap_debug_value` call's own
hints) rather than hand-constructed; a field-symbol root keeps the same
spelling it has in source, e.g. after
`LOOP ... ASSIGNING FIELD-SYMBOL(<ls_item>)`. `count` requests one `<ID>`
element per row from SAP and renders one block per row in the response, so
both the request and the response are bounded by the same value — this is
why there's a hard ceiling (`MAX_TABLE_ROWS`) rather than an unbounded
fetch.

