# Debugger

One debug session lane is active per process by default; `ABAP_DEBUG_SESSIONS`
raises how many lanes one process may hold concurrently, but SAP itself still
allows only one active debug listener per SAP user on a system regardless of
that setting — see [`ABAP_DEBUG_SESSIONS`](#abap_debug_sessions) below. With
[more than one system configured](../CONFIGURATION/multi-system.md), this
lane pool is still process-wide, not one copy per system — see
[`SYSTEM_MISMATCH`](#system_mismatch-one-debug-session-for-the-whole-process)
below for what that means for a debug call routed at a different system than
the one currently being debugged.

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
| `stateId` | string | required for `action=step`/`stack`/`frame`/`breakpoints`/`watch` | — | Identifies one stop. The 12-character id printed by the most recent response; the full 64-character digest or any prefix of at least 8 characters is accepted too. A stale id is refused, naming the current one. |
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
object named in `run`), plus the same `condition`/`skipCount`. SAP accepts
an exception breakpoint on a class it cannot find and simply never fires
it (live: an empty `exceptionClass` was answered 200 with nothing armed),
so `start` resolves the class first and refuses with `BAD_INPUT`, naming
it, before any breakpoint request is sent (#152). After arming, an
exception breakpoint the server did not echo back in its response is
reported in the `start` response as `NOT armed`. Each session remembers
which exception classes the server echoed and whether any exception
breakpoint ever suspended the run; a run that ends without that gets a
note at death naming the classes, and a `start` that attaches to a short
dump instead of a live debuggee (`debuggee: PMORTEM` in the header, plus
`dump: <id>` when the listener named one) gets a `POST-MORTEM` note that
names them too. See "Not verified" below for what is still open about
exception breakpoints stopping at the raise.

A statement breakpoint (`kind: "statement"`): `statement` (string, required
— an ABAP statement keyword, e.g. `RAISE`, that fires wherever it occurs),
plus the same `condition`/`skipCount`. Legal values are server-enumerated,
not an enum in this schema: `GET /sap/bc/adt/debugger/breakpoints/statements`
answers roughly 27 KB of rows, so a bad keyword is not caught client-side —
SAP validates it, and refuses it, when the breakpoint is armed.

A statement breakpoint has **no** program/include restriction on the ADT
wire: SAP's request XSLT `TPDA_ADT_BREAKPOINTS_REQUEST` emits only the
`statement` attribute for `KIND=1`, so there is nothing to scope it to an
object with. It therefore fires in the first code anywhere in the system
that executes that statement under this SAP user — very often SAP
framework code, and sometimes an entirely different session's debuggee,
before your own object runs at all. Live examples caught this way while
trying to break on a statement inside a probe class:
`/IWFND/CL_MGW_DEST_FINDER=>RAISE_LOG_EXCEPTION:1200`,
`CL_OO_CLIF_SOURCE=>IF_OO_CLIF_PERSISTENCE_SOURCE~READ_REPORT`, and
`CL_WB_REGISTRY=>IF_WB_OBJTYPE_PROVIDER~GET_OBJTYPE_ACCESS`.

Because of that, `start` now auto-continues past framework stops: when
the first stop's call stack does not touch the object named in `run`,
`start` issues `stepContinue` and waits for the next stop, up to 10 times
(`MAX_FRAMEWORK_AUTO_CONTINUES` in `src/tools/debug.ts`), and returns the
first stop whose stack does touch the run's object. The skipped stops
are listed in a `NOTE:` on the response, so nothing is hidden. If the
bound is reached, or the foreign debuggee ends while being continued,
`start` returns what it has with a note saying so.

The statement catalogue (`GET /sap/bc/adt/debugger/breakpoints/statements`,
418 rows on A4H) lists statement variants as separate entries: `RAISE`,
`RAISE EXCEPTION`, `RAISE EXCEPTION TYPE`, `RAISE EXCEPTION RESUMABLE`,
`RAISE EVENT`, `RAISE SHORTDUMP`, and `RAISE SYSTEM-EXCEPTION` are seven
different catalogue entries, and `statement: "RAISE"` does not match a
`RAISE EXCEPTION TYPE cx_….` in the source. Pick the exact catalogue
entry for the statement you want; an entry that is legal but never
executed is armed successfully and simply never fires.

Practical advice: when you need to be sure you land in your own code,
pair the statement breakpoint with a line or exception breakpoint inside
the target object in the same `start`, then `step: "continue"`.
Live-verified 2026-09-15: a `start` on `ZCL_I89_PROBE3` arming both a
line breakpoint on line 24 and `statement: "RAISE EXCEPTION TYPE"`
suspended at line 24 in `ZCL_I89_PROBE3================CM002`
(`METHOD WORK`), and one `continue` then stopped at line 29 — the
`RAISE EXCEPTION TYPE cx_sy_move_cast_error.` statement — still inside
`ZCL_I89_PROBE3`. Arming the same statement breakpoint alone, on the
other hand, was consumed by three framework stops that `start`
auto-continued past, and that framework debuggee ended before the
probe's own session was caught.

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

### Response size: notes once per session, outside the budget

Every debugger response is clamped to `DEBUG_MAX_CHARS` (30 000,
`src/debug/render.ts`); what is cut is named, never dropped silently.
Since #151 the recurring explanatory notes — what a revisited position
proves, that `frame` moves only the read cursor, what an `OMITTED` or
`UNREQUESTED` variable row means, what a post-mortem attach is — are
printed in full the first time each one applies in a session and as a
one-line reminder that still states the per-call fact (which ids, which
frame, how many visits) afterwards. A state change the caller must
re-read for — a different breakpoint hit, a post-mortem attach — prints
the full text again; hitting the same breakpoint in a loop does not. Notes
are added on top of the budget, so they never displace stack or variable
content. Per-call evidence (watchpoint values, termination evidence,
auto-continue reports) is not shortened.

The `stateId` printed on every stop is the first 12 hex characters of the
session's SHA-256 state digest, and that is the form to write back. The
full 64-character digest is still accepted, as is a prefix of at least 8
characters. A prefix that matches no current state, or is too short, is
refused as a stale id; the refusal names the current short id and carries
both forms in `details.currentStateId` / `details.currentShortStateId`.

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

Verified live 2026-09-15: a watchpoint on `LV_TOTAL` with
`condition: "LV_TOTAL > 3"` did not report the writes that moved the
variable 0→1 and 1→3, and reported the hit at 3→6 — so the condition,
not merely the write, gated the stop.

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

### Connection hygiene: a dedicated connection per debug session

SAP binds a debuggee's ATTACH to the connection's stateful ADT session
(the `sap-contextid`), not just to the debugger identity
(`terminalId`/`ideId`). Inside one abapsmith process the first
`start`→`stop` cycle worked and every later `start` that reused the same
connection failed with HTTP 500 "Debuggee already attached, and it does
not belong to this session", even though a fresh connection at the
identical identity reported `terminateDebuggee` → 404 `noSessionAttached`
and an empty listener poll — so the server side was already clean.

The fix now in place: a debug session gets its **own** `AbapConnection`,
minted from the same configuration and credentials via
`pool.createUnpooledConnection("debug-session")` and owned for the life
of that debug session. It is not a pooled slot, so no other tool ever
shares its `sap-contextid` and no pooled lock guard applies to it. At the
end of the session — a clean `stop`, a force-cleared one, or a failed
`start`'s own cleanup — the connection is dropped and discarded, and the
next `start` mints a fresh one.

What was actually observed: live on 2026-09-15, six consecutive
`start`→`stop` cycles inside a single abapsmith server process against
`ZCL_I89_PROBE3`, mixing exception breakpoints (`CX_SY_ZERODIVIDE`,
`CX_SY_MOVE_CAST_ERROR`), message breakpoints (`00`/`001`/`S`) and line
breakpoints (lines 25 and 39). Every `start` reported `suspended` with
the stack inside `ZCL_I89_PROBE3`; every `stop` reported `dead` /
`terminated_by_caller` in 303-603 ms; no `force: true` was used on any
of them; "Debuggee already attached" did not occur once; and `status`
was `idle` before the first cycle and after the last.

One honest limit: this was measured on A4H with `ABAP_DEBUG_SESSIONS=1`
and a single SAP user. It is evidence that the dedicated connection
removes the repeat-`start` failure on that path, not a proof that no
other route to a stranded debuggee exists — `stop`'s `force: true`
recovery described above still stands.

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
`start` is refused locally as `DEBUG_ALL_LEASES_BUSY`. This now holds at
every lane count, including the default `ABAP_DEBUG_SESSIONS=1`: a
`start` while this process already holds a tracked, live debug session is
refused with `DEBUG_ALL_LEASES_BUSY` (details carry `laneLimit` and the
busy session's `status`), and the message points at
`abap_debug({action:"stop"})`. At `laneLimit` 1 this replaced an older
`UNSUPPORTED` error shape, so a caller that matched on `UNSUPPORTED` for
the busy case must now match on `DEBUG_ALL_LEASES_BUSY`. One carve-out
remains: `UNSUPPORTED` is still what you get when the blocking session is
untracked/leaked (a debuggee left attached at this server's identity with
no lease behind it), because that is not a lease-exhaustion condition and
`stop` alone may not clear it.

But SAP itself still allows only **one active debug listener per SAP
user** on a system: a second `POST /sap/bc/adt/debugger/listeners` for
the same user is refused with `409`/`conflictDetected` (T100 `SY 530`,
"Another session already exists with global debugging scope for user
X") **even when the second request carries a different `terminalId`**
from the holder's — SAP's exclusivity at this scope is keyed on the SAP
user, not on the terminal or IDE id (live:
`test/cassettes/debugger/listener-conflict-409.cassette.json`). So for a
single-`ABAP_USER` deployment, raising `ABAP_DEBUG_SESSIONS` past 1 does not
make a second concurrent debug session possible — it only moves the refusal
from this client (`DEBUG_ALL_LEASES_BUSY`, at the configured limit) to SAP
itself (the `409` above), once that second lane's listener is actually
armed. A second lane only has a chance of working when it authenticates as a
different `ABAP_USER` (a second abapsmith process with its own SAP user).

### `SYSTEM_MISMATCH`: one debug session for the whole process

With [more than one system configured](../CONFIGURATION/multi-system.md),
the debugger is the one part of this server that is NOT duplicated per
system (see
[CONCURRENCY/multi-system-pools.md](../CONCURRENCY/multi-system-pools.md#the-exception-one-debugger-lane-for-the-whole-process)):
its lane pool, sized by `ABAP_DEBUG_SESSIONS` above, is one pool for the
whole process, shared across every configured system rather than given one
copy per alias. Starting a debug session against `QAS` does not leave DEV
free to start its own, independent session at the same time — it competes
for the same lanes, the same way two debug sessions against one system
would.

Once a session is active, every subsequent `abap_debug`, `abap_debug_vars`
or `abap_debug_value` call is checked against the system the active
session actually belongs to (the system named when `action="start"` was
called, or the default system if `system` was omitted then). A call
naming a DIFFERENT system than that is refused with `SYSTEM_MISMATCH`
rather than being allowed to step, inspect or stop a session that belongs
to another system — there being only one debuggee, one call stack and one
set of variables active at a time makes silently redirecting one of these
calls to the wrong system's debuggee actively dangerous, not merely
confusing. The check is skipped only for `action="start"`, since starting
a fresh session is what RECORDS the lane's system going forward, not a
call that could disagree with one.

The refusal names both systems and points at the fix directly: re-issue
the call with `system` set to the session's own system, or stop the
session first (`abap_debug action="stop"`) to free the lane for a
different system. On a single-system server this check can never fire —
there is only one system for `currentSystemAlias()` to ever resolve to, so
nothing can disagree with the active session's system.

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
- Two genuinely concurrent debug sessions is `unverified`. Never
  demonstrated on the appliance, for the per-user exclusivity reason under
  [`ABAP_DEBUG_SESSIONS`](#abap_debug_sessions) above.
- An exception breakpoint ALONE suspending at the `RAISE`, before the
  short dump, is `unverified` and reported not to happen (#152: with only
  an exception breakpoint the listener returned `DBGEE_KIND "PMORTEM"` —
  the dump, not a live debuggee — and paired with a line breakpoint the
  line stopped while the raise never did). The request abapsmith sends is
  attribute-for-attribute the body A4H accepted and echoed as
  `KIND=5.EXCEPTION_CLASS=CX_SY_ZERODIVIDE`
  (`test/cassettes/debugger/bp-set-exception-accepted.cassette.json`,
  pinned by `test/debug-xml-request.test.ts`), so the registration is not
  malformed; why the armed breakpoint does not stop the debuggee could
  not be determined offline. `test/integration-debug.test.ts` carries a
  live case against a `$TMP` probe class `ZCL_AS_DBGEXC` (source in the
  file) that encodes the desired behaviour and skips when the class is
  absent; it has not yet been run live. Until it passes, the way to stop at
  a raise is a line breakpoint on the `RAISE` statement, or a statement
  breakpoint `RAISE EXCEPTION TYPE` paired with a line breakpoint in the
  target object (live-verified above).

## abap_debug_vars

Tier-1 survey of every variable in scope at the current debugger stop.

**Availability**: case 2 — always registered, always a read (`canWrite` not
required).

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `stateId` | string | yes | — | The 12-character id from the most recent start/step/stack response; the full id or a prefix of at least 8 characters is accepted too. |
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
| `stateId` | string | yes | — | The 12-character id from the most recent start/step/stack response; the full id or a prefix of at least 8 characters is accepted too. |
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

