---
name: abapsmith-debug-a-failing-run
description: Turns a failed ABAP run into a diagnosis — the ST22 short dump with abap_dumps, then a live breakpoint with abap_debug. Use when a class or report short-dumped, raised an unexpected exception, or produced the wrong value.
---

# Debugging a failing run

**There is no post-mortem state.** Read every variable you need BEFORE you step
over the statement that fails. Once it faults, the exception propagates, the
debuggee finishes, and the session is gone — there is no going back to look.

## The pipeline

```
abap_run (fails)  →  abap_dumps mode="list" (tight from/to)  →  abap_dumps mode="show" key=<verbatim>
  →  abap_read the real source line  →  abap_debug action="start" (line breakpoint)  →  inspect  →  abap_debug action="stop"
```

## Live transcript (A4H, 2026-09-12)

Observed against a throwaway `$TMP` class `ZCL_I92_PROBE` (since deleted): `main`
called a `divide` method with a zero denominator.

**a. `abap_run { "object": "ZCL_I92_PROBE", "mode": "class" }`** returned error
`RUNTIME_DUMP`:

`"ZCL_I92_PROBE short-dumped: Division by 0 (type I or INT8) (Message 20260912144130vhcala4hci_A4H_00 DEVELOPER 001)"`

The ICF error page carries **only** the exception short text — no dump id, no
call stack, no source position, no server time — and any output the program
wrote before the dump is lost. **But** that message string embeds the server
timestamp (`20260912144130`), instance, user and client. Use that timestamp
directly as your `from`/`to` window instead of guessing — the server's clock,
not yours, is what the feed is indexed by.

**b. `abap_dumps { "mode": "list", "from": "20260912144000", "to": "20260912144300" }`**
returned exactly one row (`when / user / error / program / short_text / key`),
plus `window_start: 20260905000000`. **The feed has no page cursor** — to go
further back, call again with `to=` the oldest timestamp already seen. The
whole feed stops at the **8-day residence window**, which no bound can widen.
An empty list means "no dumps in the last 8 days matching this filter", never
"nothing failed".

**c. The key came back URL-encoded.** Verbatim:

`20260912144130vhcala4hci_A4H_00%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20DEVELOPER%20%20%20001%20%20%20%20%20%20%20%205`

Copy it **exactly** — `%20` runs and trailing digit included. Do not decode
it, trim it, or rebuild it from the columns; internal spacing is significant
and the trailing digit is part of the key.

**d. `abap_dumps { "mode": "show", "key": "<that key verbatim>" }`** returned
`error: COMPUTE_INT_ZERODIVIDE`, `exception: CX_SY_ZERODIVIDE`,
`program: ZCL_I92_PROBE=================CP`, `chapters_shown: kap7,kap8,kap9,kap11`
(the default set: where terminated, source extract, system fields, call
stack), plus a full chapter index (`name / line / title / category`).
**Select chapters by name (`kap7`, `kap8`, …), never by title** — titles are
translated.

Two things from that response worth acting on:

- "Terminated in `ZCL_I92_PROBE=================CP` line 19 — read it with
  `abap_read object:"/sap/bc/adt/oo/classes/zcl_i92_probe/source/main#start=19"`"
  — it maps SAP's generated include back to a real source position for you.
- "Fetched 208 KB of `/formatted` to return 4 chapter(s) of 2082 line(s).
  Chapter slicing saves context, not bandwidth: every `show` call fetches the
  whole body, so ask for the chapters you need in ONE call rather than one
  chapter at a time." **Batch `chapters` in a single call.**

The "Active Calls/Events" chapter gives the stack in SAP's **generated
include names** (`ZCL_I92_PROBE=================CM001` line 3 was method
`DIVIDE`), not main-source line numbers. Those names are for reading, not for
passing to any abapsmith tool.

`kap10` "Selected Variables" was listed in the index but is only returned
with `"variables": true`, which requires the operator to have set
`ABAP_ALLOW_DUMP_VARIABLES`. Those are real business data and land
permanently in the transcript.

**e. `abap_debug { "action": "start", "breakpoints": [{ "kind": "line", "object": "ZCL_I92_PROBE", "line": 19 }], "run": { "object": "ZCL_I92_PROBE", "mode": "class" } }`**
returned `status: suspended`, a `stateId`, a STACK section, **and a VARIABLES
block inline in the same response** (`IV_DEN: 0`, `IV_NUM: 10`, `RV_RES: 0`,
`LV_UNUSED:`). The breakpoint is given in ordinary main-source line numbering;
the response echoes `line: 19` together with the generated `include` SAP
resolved it into. The start response already answers most simple questions —
a separate variables call is often unnecessary.

The `stateId` in that response is 12 hex characters — write it back as
printed. The full 64-character digest is accepted too, as is any prefix of
at least 8 characters; nothing is gained by quoting the long form. A stale
id is refused with the current one named in the message. Explanatory `NOTE:` paragraphs (what a revisited
position proves, what `OMITTED` means, what a post-mortem attach is) are
printed in full once per session and as a one-line reminder afterwards —
read them the first time; the reminder still carries the per-call fact.

Observed detail: the stack printed frames `#13` down to `#4` and then jumped
straight to `#2`. Frame numbers are SAP's own and are **not** a dense `1..n`
list — do not assume contiguity when picking a frame.

**f. `abap_debug_value { "stateId": "...", "path": "IV_DEN" }`** returned
`IV_DEN: 0`. An unknown path returns empty rather than an error, so a blank
answer means "check the path", not "the variable is empty".

**g. The surprise that justifies this skill.** `abap_debug { "action": "step", "stateId": "...", "step": "over" }`
on the faulting statement returned: `status: dead`,
`deathReason: debuggee_finished`, `terminationKind: session_ended`,
`triggerOutcome: short_dumped`. The response carried no exception class name,
so it is confirmed only as a session-gone condition and **not** confirmed as
an exception. `triggerOutcome` comes from the trigger run, not from the debug
session's own evidence — the two signals are independent and can disagree.

That step also produced a **second** ST22 dump — a run that dies under the
debugger still dumps, so your dump window will contain more than one
candidate row. Treat each row as a candidate, not the answer.

**h. `abap_debug { "action": "stop" }`** after a dead session returned
`status: idle`, "No active debug session (nothing to stop)". Calling `stop`
unconditionally when you are done is harmless and is the right habit.

## Refusals to expect

- **One debug session per process**, plus a cross-process arm lock keyed on
  `(url, client, user)` — a second process arming a listener fails fast as
  `DEBUG_SESSION_LOCKED_CROSS_PROCESS`, naming the holder's pid/host/start time.
  It never queues.
- **Listener conflict.** A 409 when a different `(terminalId, ideId)` holds
  the listener for the same SAP user — `ABAP_TERMINAL_ID` / `ABAP_IDE_ID`, 32
  uppercase hex, and the two must differ from each other.
- **Idle timeout, 300 seconds, not configurable by env.** Send
  `action: "keepalive"` within five minutes of a suspended session, or lose it.
- `abap_debug` only catches breakpoints **it triggers itself** — `run` is
  required on `action: "start"`, under the configured user. It cannot arm a
  listener and wait for someone else's session.
- **An exception breakpoint on a class that does not exist** is refused
  before anything is armed (`BAD_INPUT`, naming the class) — SAP would
  accept it and never fire it. One the server accepted but did not echo
  back is reported in the `start` response as `NOT armed`.
- **An exception breakpoint stops at the `RAISE` only when a handler for
  the exception exists up the stack** (live-verified: a caught `RAISE`
  suspends at the raise; an uncaught one, and a real division by zero, go
  straight to the runtime error and `start` attaches to the dump —
  `debuggee: PMORTEM`, with a `POST-MORTEM` note naming the class). The
  `start` response says so whenever an exception breakpoint is armed, and
  a run that ends without one firing says so at death. To stop before an
  uncaught raise, use a line breakpoint on the `RAISE` statement, or the
  statement breakpoint `RAISE EXCEPTION TYPE` paired with a line breakpoint
  in the target object.
- **Variables are read-only by design** — there is no "set variable".
- `frame` moves the read cursor only — it does not unwind or re-execute anything.
- `skipCount` is accepted and sent to SAP but **not enforced** — use
  `step: "continue"` instead.
- `jumpToLine` is double-gated: server `ABAP_ALLOW_DEBUG_JUMP_TO_LINE=true`
  plus `confirm: "jumpToLine"`.
- `"Debuggee already attached"` — the escape hatch is
  `abap_debug { "action": "stop", "force": true }`.

## How to prove it

A diagnosis is proven by a value read at a stop (`abap_debug_value`, or the
`start` response's inline VARIABLES block) or by a dump chapter — not by
inference from the short text alone. The ICF short text and the ST22 dump can
be the only two records of the same failure, and the first is much poorer.

## Tool set

`abap_debug_vars` and `abap_debug_value` are separate tools from
`abap_debug`. `abap_debug`'s own action set is
`start | step | stack | frame | keepalive | stop | status`.

## Not this skill

A bad write you made is `abapsmith-recover-a-bad-write` (the journal, not
ST22). A failing unit test is `abapsmith-run-tests-and-fix`. Static findings
are `abapsmith-check-code-quality`. Code that runs correctly but slowly —
no dump, no exception — is a job for `abap_trace` (SAT runtime trace), not
this skill: it records hit-list, database-access and call-tree views of one
scoped execution instead of stepping through it live.
