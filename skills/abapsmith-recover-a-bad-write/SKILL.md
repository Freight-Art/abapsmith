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
refuses outright. This is now a stronger signal than it used to be: a
`transport-remove-object` entry no longer goes `pending` for an ordinary clean
refusal (`CTS_DUPLICATE_ENTRY`, `NOT_FOUND` settle `failed` immediately, since
the ABAP transcript proves nothing was removed) — a pending entry means the
removal genuinely touched something before failing, or the response was lost
outright. Resolve by hand via the steps above, then close it:

```
abap_journal mode=reconcile entry=<id> outcome=succeeded|failed reason="how you established this"
```

This is a **local** call only — no network, nothing sent to SAP, nothing deleted
(the before-image and every earlier line stay on disk). It records your finding as
an assertion, not an observation, and it refuses an entry that already has a real
outcome. **Reconciling to `succeeded` makes the entry terminal and undoable** — `undo`
will then replay its before-image — so only assert `succeeded` once the write is
known to have landed. `bin/abap-journal-reconcile` automates the read-only
comparison and classifies pending entries in bulk `succeeded` / `failed` /
`ambiguous`; with `--apply` it settles the ones it can from observed evidence.
`mode=reconcile` is the single-entry counterpart for whatever it leaves
`ambiguous`. **Neither ever fixes anything on SAP** — settling closes bookkeeping,
nothing more.

**Delete-gate.** Undoing a `create` means deleting. That is authorised only when
`beforeCapture` is `confirmed-absent`. `captured`, `failed` and `unknown` all refuse
— **not overridable by `force`**.

**Enhancement objects** (`ENHO/*`, `ENHS/*`). Mixed. Undo of a `create_spot` /
`create_impl` / `create_hook` entry deletes the object, but only when the
before-state was confirmed-absent (a 404 read before the create, not a guess),
and only after a where-used check finds nothing referencing it and no active
BAdI implementation blocks it — either one refuses, named, and a failed
where-used call refuses too (fail closed). Requires enhancement delete to be
enabled (`ABAP_MODE=admin` or `ABAP_ALLOW_ENHANCEMENT_DELETE`). A
`set_impl_active` entry records the implementation's previous active state,
so undo sets it back directly. `add_badi_def`, `add_filter_def`,
`set_filter_values`, `write_description`, and enhancement `delete` stay
refused unconditionally, both directions — real hazards behind that: an
undeletable phantom object, TADIR/E071 rows surviving a "successful" 200
delete. No flag manufactures missing evidence.

**`transport-release`.** Marked `irreversible`. Never undoable by any mechanism,
`force` included. Other `transport-*` entries are not auto-undone either — reverse
them by hand through the transport actions.

**Class sub-includes.**

- Undoing a write that **restores** a previous version of `definitions` /
  `implementations` / `macros` / `testclasses` now works: it replays back onto that
  same include, not onto `/source/main`, so it cannot overwrite the class body.
  Confirmed live against SAP A4H, 2026-09-12, on class `ZCL_I75_UNDO`: a second
  version of `testclasses` was written, `abap_journal mode=show` on that entry
  reported `include: testclasses` and the include-scoped warning, `abap_journal
  mode=undo` reported `action: restore` / `activated: true`, and `abap_read
  { include: "testclasses" }` read back exactly the before-image bytes — the
  read-back etag equalled the entry's `beforeEtag`
  (`sha256:be7abc10f006180d9ffb48eafff05612`).
- Undoing a write that would **delete or recreate** the class's own include is
  still refused. ADT has no verb that deletes one include on its own, so there is
  nothing for undo to replay that operation onto. The alternative is the same one
  a fresh write uses: empty the include by writing a single comment line into it
  with `abap_write` and the same `include=`.
- Undoing a class *delete* now records all four local includes (`definitions`,
  `implementations`, `macros`, `testclasses`), captured under the same lock as the
  delete itself, so its recreate is no longer partial for that reason. It can still
  come back `PARTIAL` and need `force: true`, but now only for whichever of the
  four includes could not be read at delete time — not for all of them by default.

## `force` and `activate`

`force: true` only defeats a **drift** refusal. It never defeats the delete-gate, a
stored `undoable: false` entry, or the live checks an enhancement or `activate`
undo still runs (where-used, active implementation, or no preceding write to undo).

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
