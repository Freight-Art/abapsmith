# Debugger

One debug session may be active at a time, server-wide.

## abap_debug

ABAP debugger driver: arm breakpoints, run a target program on a separate
connection, step, inspect the stack, and stop.

**Availability**: case 2 — always registered. `stack`, `frame`, `status`,
`keepalive`, `stop` are ungated (read-only or risk-reducing). `start` and
`step` are gated on `canWrite` (they advance a live debuggee).

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `action` | enum `start` \| `step` \| `stack` \| `frame` \| `keepalive` \| `stop` \| `status` | yes | — | What to do. |
| `breakpoints` | array of line/exception breakpoint objects | required for `action=start` | — | At least one entry. Validated against SAP before anything is armed. |
| `run` | object `{object, mode?}` | required for `action=start` | — | Program to trigger, on a separate connection. `mode`: `class` \| `report` \| `auto`, default `auto`. |
| `step` | enum `into` \| `over` \| `return` \| `continue` \| `runToLine` \| `jumpToLine` | required for `action=step` | — | How to advance. `continue` may end the session. `jumpToLine` is disabled by default. |
| `toLine` | number (int, 1–999999) | required for `step=runToLine`/`jumpToLine` | — | 1-based target line in the current frame's own source. |
| `stateId` | string | required for `action=step`/`stack`/`frame` | — | Identifies one stop. A stale id is refused, naming the current one. |
| `frame` | number (int, ≥1) | required for `action=frame` | — | 1-based stack position to move the read cursor to. |
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

What each action does: `start` arms the breakpoints, triggers the run on a
separate connection, and waits for it to hit one — returning the stack and a
full variable survey at that first stop. `step` advances execution and
returns the new stop's stack and variable survey, or — if the program ran to
completion instead — the captured output in place of a survey. `stack`
re-fetches just the call stack for the given `stateId`, with no variable
survey. `frame` returns the newly-selected frame's own variable survey, in
addition to moving the read cursor. `keepalive` resets the idle timer on a
suspended/caught session without stepping. `stop` is idempotent — safe to
call with no session active — and returns the target program's captured
output; it also best-effort releases a debug listener left armed by an
earlier process instance when this process has no session of its own to
route the stop through (separate from `force`, which instead clears an
ATTACHED/suspended debuggee). `status` reports the current session's status
with no network calls and no side effects.

Only one debug session may be active per process at a time — a second
`start` is refused. (For what a session's variables and frames support —
read vs. write — see the Debugger row in `doc/CAPABILITIES/non-object-capabilities.md`.)

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

