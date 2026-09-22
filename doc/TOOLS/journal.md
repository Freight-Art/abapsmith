# abap_journal

List, inspect, undo, or reconcile writes this server has made.

**Availability**: case 2 — always registered. `list`/`show`/`reconcile` are
unconditional and cost zero network calls (pure local file reads/writes — no
connection pool slot is leased, nothing is sent to SAP). `undo` needs
`canWrite`.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `mode` | enum `list` \| `show` \| `undo` \| `reconcile` | no | `list` | Operation. |
| `entry` | string | required for `show`/`undo`/`reconcile` (no `object` fallback for `reconcile`) | — | Journal entry id to show, undo, or reconcile. |
| `object` | string | no | — | Undo the most recent entry for this object instead of naming an entry id. Not accepted by `reconcile` — closing the wrong entry writes a false outcome into the audit trail. |
| `detail` | enum `summary` \| `full` | no | `"summary"` | `show` only. `summary`: header plus a capped diff of before-image → after-image. `full`: the complete before-image, plus the after-image when one was recorded. |
| `limit` | number (1–999999) | no | `20` | `list` only — rows to return. |
| `force` | boolean | no | — | `undo` only — overwrite server-side changes made since the journalled write. |
| `activate` | boolean | no | `true` | `undo` only — also activate after reversing. |
| `outcome` | enum `succeeded` \| `failed` | required for `reconcile` | — | The outcome you assert for a `pending` entry. `pending` is the state being left, so it is not offered. |
| `reason` | string | required for `reconcile` | — | How you established that outcome. Recorded verbatim — the only evidence the entry will ever carry for it. |

`list` columns: `id`, `when`, `op`, `object`, `existed`, `capture`,
`outcome`, `flags`. `flags` includes `reconciled` for an entry closed by hand.

`mode=show` defaults to `detail=summary`: the header (object, type,
operation, request, timestamp, before/after sizes, diff sizes
`diffAdded`/`diffRemoved`/`diffHunks`/`diffChars`) plus a unified diff of
before-image → after-image, capped at about 2,000 characters — truncation is
marked, `[diff truncated: N of M characters shown; detail="full" returns the
complete images]`. `detail=full` returns the complete before-image as
before, plus the after-image when one was recorded. When the entry has no
after-image yet (a `pending` write), the summary says so and points to
`detail=full`. This is render-side only — the entry on disk and everything
`mode=undo`/`mode=reconcile` act on are unchanged by `detail`.

Notes: transport-release entries are never undoable. Other transport-*
entries are not auto-undoable. Activate entries have nothing to reverse.
Enhancement objects (`ENHO/XH`, `ENHO/XHH`, `ENHS/XS`) are **never**
undoable, even with `force:true` — this is a hard rule, not a default.

**Class sub-includes.** A `CLAS/OC` write that targets `include=`
`definitions`/`implementations`/`macros`/`testclasses` now addresses that
include's own document, not the class's `main` source, so `mode=show`
names which include the entry addressed and `mode=undo` restores that
include specifically — it no longer touches `main`. Restoring a previous
`testclasses` version this way is now `live`, confirmed against SAP A4H,
2026-09-12, on class `ZCL_I75_UNDO`: a second version of the `testclasses`
include was written, `mode=show` on that entry reported `include:
testclasses` and the include-scoped warning, `mode=undo` reported `action:
restore` / `activated: true`, and a following `abap_read { include:
"testclasses" }` read back exactly the before-image bytes — the read-back
etag equalled the entry's `beforeEtag`
(`sha256:be7abc10f006180d9ffb48eafff05612`).

`mode=undo` still refuses an entry when replaying it would require
**deleting or recreating a class's own include** — ADT has no verb to
delete a single include of a class, only the whole class, so there is
nothing to replay onto. The refusal names the reason and the alternative:
write a single (possibly comment-only) line into the include to empty it,
rather than trying to remove it.

A `delete` entry for a `CLAS/OC` now records all four local includes
(`definitions`, `implementations`, `macros`, `testclasses`) captured under
the same lock as the delete itself, in the entry's `parts`. `mode=show`
lists them for a class-delete entry (the parts table's columns are
`object`, `package` (when any part has one), `include`, `existed`,
`capture`, `bytes` — the `include` column is what makes the four rows of a
class-delete entry distinguishable), and `mode=undo` restores the class
together with its local helpers and its unit tests — this no longer
reports itself `PARTIAL` and no longer needs `force:true` for that reason
alone. It still reports `PARTIAL` and still needs `force:true`, but only
for whichever of the four includes could not be read at delete time — the
rest are restored normally. This restore path is now `live`, confirmed
against SAP A4H, 2026-09-12, on class `ZCL_I75_UNDO` in package `$TMP`:
`abap_write mode=delete` produced a journal entry with four parts
(`definitions`, `implementations`, `macros`, `testclasses`), all
`beforeCapture: captured`; `mode=show` reported the class warning naming
all four; `mode=undo` reported `action: recreate`, `performed: true`,
`restoredIncludes: definitions, implementations, macros, testclasses`,
`activated: true`; and a following `abap_test` on the recreated class ran
the restored test class and reported PASSED — proof the `testclasses`
include really came back active, which could not happen if only `main`
had been restored.

The first write to an include that does not yet exist is now recorded as
a `create` entry with `confirmed-absent` provenance on its before-image
(abapsmith checked and found nothing there), not as an `update` against a
before-image that hashes an empty string — that was a defect in how these
entries used to be recorded, not a documented behaviour, and this fix
removes it.

`mode=list` flags a `pending` entry older than 5 minutes as STRANDED — nobody
knows whether that write landed. `mode=reconcile` is the escape hatch: once
you have established the real outcome (by reading the object, or otherwise),
`abap_journal mode=reconcile entry=<id> outcome=succeeded|failed
reason="…"` records it and unblocks the entry. This is an **assertion**, not
an observation — the entry gains a `reconciled` field so a later reader can
tell it apart from an outcome abapsmith itself watched happen — and it
refuses an entry that already has a real outcome. Asserting `succeeded`
makes the entry terminal, so `undo` will then replay its before-image: only
assert `succeeded` once the write is known to have landed. For bulk,
evidence-driven reconciliation see `bin/abap-journal-reconcile`.

