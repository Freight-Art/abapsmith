---
name: abapsmith-recover-a-bad-write
description: Reverts an abapsmith write using the local journal, and interprets undo's refusals. Use when a write produced the wrong content, was made to the wrong object, or crashed mid-flight.
---

# Recovering a bad write

**There is no git here.** The local journal is the entire safety net, and it only
covers writes **abapsmith itself performed**. An object someone changed in SE24 has
no before-image — send them to SAP's own version management (SE38/SE24 → Utilities →
Versions). An object abapsmith never wrote has no journal entry to target at all, so
`undo` cannot reach it by any route (`entry` id or `object` name).

`undo` restores the recorded before-image — or, when the entry is a `create`, deletes
the object instead (subject to the Delete-gate below). Those are the only two
outcomes; which one applies is determined by the entry's own `op`, not by a flag.

## Steps

```
journal_list  →  journal_show <entry-id>  →  abap_read the live object  →  decide
```

1. `journal_list` — newest first. Filter by object name. Columns include
   `capture` (undo's delete-gate provenance) and `flags` (`is-undo` / `undone`).
2. `journal_show <entry-id>` — the recorded before-image in full. **`object` is the
   entry id here**, not an object name.
3. `abap_read` the live object and compare by hand.
4. Then either `undo`, or a fresh `abap_write` if the before-image is not what you
   want back.

`journal_list` and `journal_show` are local filesystem reads — zero network, they
work with SAP unreachable.

Target `undo` with `args.entry` (an id) **or** top-level `object` (a name → that
object's most recent undoable entry). The name path skips `activate` and
`transport-*` entries. These are separate parameters, not interchangeable.

## Undo's refusals — read them, do not force past them

**Drift.** The live object no longer matches what abapsmith last wrote. Someone else
edited it. `force: true` overrides and **overwrites their change with no way back**.
`abap_read` first, always.

**Pending / STRANDED.** The process died between the before-image and the outcome.
abapsmith does not know whether the write ever reached the server, so `undo`
refuses outright. Resolve by hand via the steps above.
`bin/abap-journal-reconcile` automates the read-only comparison and classifies the
entry `succeeded` / `failed` / `ambiguous`; with `--apply` it settles the first two
locally. **It never fixes anything** — settling closes bookkeeping, nothing more.

**Delete-gate.** Undoing a `create` means deleting. That is authorised only when
`beforeCapture` is `confirmed-absent`. `captured`, `failed` and `unknown` all refuse
— **not overridable by `force`**.

**Enhancement objects** (`ENHO/*`, `ENHS/*`). Refused unconditionally, both
directions. Real hazards behind this: undeletable phantom objects, TADIR/E071 rows
surviving a "successful" 200 delete. No flag manufactures the missing evidence.

**`transport-release`.** Marked `irreversible`. Never undoable by any mechanism,
`force` included. Other `transport-*` entries are not auto-undone either — reverse
them by hand through the transport actions.

**Class sub-includes.** Undo has not caught up with writes.

- Undoing a write to `definitions` / `implementations` / `macros` / `testclasses` is
  **refused by name**. Replaying it would go through `/source/main` and write your
  unit tests over the class body. Revert by hand: `journal_show` the before-image,
  then `abap_write` it back **with the same `include=`**.
- Undoing a class *delete* restores only `main` — the delete's before-image never
  captured the four local includes. Refused unless `force: true`, and reported as
  `PARTIAL` with the missing includes named, not as a clean success.

## `force` and `activate`

`force: true` only defeats a **drift** refusal. It never defeats the delete-gate, the
irreversible entries, or the enhancement refusal.

`activate` defaults to `true`. Set `false` to leave the object inactive after the
restore.

An `undo` is itself an ordinary journalled write, so it can be undone in turn.

## Journal settings worth knowing

- Location `<ABAP_JOURNAL_DIR or ./.abapsmith/journal>/<SID>/` — per system, so an
  undo cannot be replayed against the wrong box.
- Off only with `ABAP_JOURNAL=off|false|0`. Anything else, including unset, is on.
- Retention: 200 entries / 30 days by default. **An old entry may simply be gone.**
  In-flight entries are never pruned.

## Not this skill

A runtime crash is not a bad write. `abap_dumps` reads SAP's own ST22 feed and has
nothing to do with the journal; reach for it, then `abap_debug`, instead.
