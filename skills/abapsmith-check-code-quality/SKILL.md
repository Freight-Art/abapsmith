---
name: abapsmith-check-code-quality
description: Runs ATC static checks with abap_atc and lists or applies ADT quick fixes with abap_quick_fix. Use when asked to review, clean up, or check an object for findings before it is transported.
---

# Checking code quality

**This is not a second opinion.** `abap_atc` runs SAP's own ABAP Test Cockpit
— the same Code Inspector every ABAP developer already has in Eclipse. It
computes nothing SAP does not already compute. The one thing it adds is
running without an IDE, which is what makes it usable from here at all.

## Pipeline

```
abap_activate mode=check  →  abap_atc  →  abap_quick_fix mode=list  →  abap_quick_fix mode=apply  →  abap_atc again
```

1. `abap_activate { "object": "ZCL_FOO", "type": "CLAS/OC", "mode": "check" }`
   — a syntax check, cheap and instant, no lock, no worklist, available even
   read-only. Do this first regardless of what ATC says; a syntax error is a
   different problem (see "Not this skill" below).
2. `abap_atc { "object": "ZCL_FOO", "type": "CLAS/OC" }` — findings with
   severity, `object:line`, which check fired, and its message.
3. Pick one finding and enumerate proposals at its position:
   `abap_quick_fix { "mode": "list", "object": "ZCL_FOO", "type": "CLAS/OC", "line": 42, "column": 3 }`.
4. Apply one by id: `abap_quick_fix { "mode": "apply", "object": "ZCL_FOO", "type": "CLAS/OC", "line": 42, "column": 3, "proposal": "<id-from-list>" }`.
5. Run `abap_atc` again with the **same `variant`** against the same object.
   That second run, not the absence of an error from `apply`, is the proof
   the finding is gone.

Read the flagged source with `abap_read` before touching anything — the
finding's line and message are not always the whole story.

## What "clean" means, and does not

A clean `abap_atc` result is clean **for that variant**, nothing more. A
different variant runs different checks and can find things this one
missed. Exemptions (marking a finding as accepted rather than fixed) are
deliberately not supported by this tool — an agent that can request an
exemption is an agent that can silence a finding instead of fixing it.

## Live transcript: A4H, 2026-09-12, `ZCL_I92_PROBE` ($TMP, since deleted)

This is one system on one day, not a claim about every system.

`abap_atc { "object": "ZCL_I92_PROBE", "type": "CLAS/OC" }` failed:
`ADT_ERROR` — `"timeout of 60000ms exceeded"`, `adt.status: 0`,
`summary: "ADT returned HTTP 0."`, `details.operation: "atc.createWorklist"`,
`details.uri: "/sap/bc/adt/atc/worklists?checkVariant=ZABAP_CLOUD_DEVELOPMENT"`.

Retried with `"variant": "DEFAULT"` — same timeout, now at
`checkVariant=DEFAULT`. Retried again with `"severity": "error"` — same
timeout a third time. All three attempts died at **worklist creation**; the
tool never reached the findings stage, so no finding was ever produced and
nothing was learned about the class.

The system itself was fine in the same session: `abap_activate { "object": "ZCL_I92_PROBE", "type": "CLAS/OC", "mode": "check" }`
on the same class returned `result: clean` immediately, run between the
failed ATC attempts. So the timeout sits in the ATC/Code-Inspector backend
on that appliance — **not** the network, not the credentials, not the
connection.

`abap_quick_fix { "mode": "list", "object": "ZCL_I92_PROBE", "type": "CLAS/OC", "line": 18, "column": 10 }`
timed out the same way, with `details.operation: "quickfix evaluation"` and
`details.uri: "/sap/bc/adt/oo/classes/zcl_i92_probe/source/main"`. Both
tools POST the object for evaluation to the same backend, so **if `abap_atc`
times out, expect `abap_quick_fix mode="list"` to time out too.**

The error's own hint says "do not retry unchanged." Here that held in a
different sense: retrying did not help, and neither did changing the
variant. **Probe first** — run one `abap_atc` against a single small class
before planning work around ATC findings — and if the backend does not
answer, fall back to `abap_activate mode="check"` plus reading the source
with `abap_read`.

One more thing worth a line: on that appliance the system default variant
resolved to `ZABAP_CLOUD_DEVELOPMENT` (it also turns up as a `CHKV/TYP`
object when listing `$TMP`). That is the ABAP-Cloud-readiness variant, so a
"clean" answer there answers a cloud-readiness question, not a general
code-quality one. Pass `variant` explicitly for a different question.

## Refusals

- **Both tools are write-gated.** `abap_atc` is gated as `execute` because
  creating a worklist is a server-side side effect. `abap_quick_fix` is
  gated as `write` in **both** modes, because `mode="list"` POSTs the whole
  object source for evaluation — it only looks read-only. On a read-only
  server both still appear in `tools/list`, but as locked stubs
  (`MODE_LOCKED_TOOLS`, `src/tools/locked.ts`) that refuse every call
  `READ_ONLY` with a message naming what unlocks them, without reaching SAP
  — that beats a bare "tool not found" that looks like a typo. Both tools
  also require the object's package to pass the allowlist.
- **Parameterized proposals are refused.** `abap_quick_fix` applies
  deterministic proposals only. One the IDE would open a dialog for is
  refused `BAD_INPUT`, naming the required input, rather than guessed at.
- **`include` must be `main`.** Any other value is refused `BAD_INPUT`
  before any network call — quick fixes never target a sub-include.
- **`INCOMPLETE:`** on an `abap_atc` result means the run stopped early,
  most likely at the `max_findings` cap. There are more findings than
  listed; this is not a clean result.
- **`UNSCOPED:`** means the server named no `LAST_RUN` object set for the
  worklist, so the findings are the whole worklist and may include an
  earlier run's results against source that has since changed. Treat line
  numbers with suspicion when this shows up.
- **An empty quick-fix delta is a successful no-op**, not a failure. A
  proposal can legitimately resolve to zero edits.

## How to prove it

An applied quick fix goes through the same journalled `abap_write` pipeline
as any other mutation, so it shows up in `abap_journal` and can be reverted
with `abap_journal { "mode": "undo", "entry": "<id>" }`. Proof that a
finding is actually gone is a second `abap_atc` run against the same object
with the same `variant` — not just the absence of an error from `apply`.
`abap_quick_fix { "mode": "apply", ..., "dry_run": true }` previews the
resulting source with no PUT, no lock, no activation, and no journal entry —
use it to see the delta before committing to it.

## Not this skill

A syntax error belongs to `abap_activate`, not here — run `mode="check"`
first and fix that before ATC findings matter. A failing ABAP Unit test is
`abapsmith-run-tests-and-fix`. A runtime short dump is
`abapsmith-debug-a-failing-run`.
