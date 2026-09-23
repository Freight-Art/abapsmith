# Undo, drift detection, and recovery

For the on-disk record these operate on, see [Journal format and what gets
recorded](journal-format.md).

## Undo semantics

Undo is an ordinary write carrying old text — same lock → PUT → unlock →
activate recipe, same safety gate, and journalled itself (an undo can be
undone). What it does depends on the original operation:

| Original operation | Undo action | Notes |
|---|---|---|
| `create` | delete | Only when `beforeCapture === "confirmed-absent"` — a positively-observed 404, not a guess from a failed read. Not forceable: there is no flag that manufactures missing evidence. |
| `update` | restore | Puts the recorded before-image back, then re-activates. |
| `delete` | recreate | From the before-image. For a class, all four local includes (definitions, implementations, macros, test classes) are captured under the same lock as the delete and recorded in the entry's `parts`, alongside the main source; recreate restores all of them, so this is no longer a partial restore and no longer needs `force: true` for that reason. It still reports a partial restore, forceable, for whichever of the four includes could not be read at delete time — the rest are restored normally regardless. This capture-and-restore path is now `live`, confirmed against SAP A4H, 2026-09-12, on class `ZCL_I75_UNDO`: `abap_write mode=delete` produced a journal entry with all four parts `beforeCapture: captured`, `mode=show` named all four in the class warning, `mode=undo` reported `action: recreate`, `performed: true`, `restoredIncludes: definitions, implementations, macros, testclasses`, `activated: true`, and a following `abap_test` on the recreated class ran the restored test class and reported PASSED — proof `testclasses` really came back active, not just `main`. |
| `delete` of a package (`DEVC/K`) | refused unconditionally, unforceable | A package has no source; its metadata document is captured as the before-image (`beforeKind: "package-metadata"`), but abapsmith does not re-create packages from a journal entry — restoring a before-image means writing it through the ordinary write path, which has no source document to PUT it against. Re-create deliberately with `abap_write type="DEVC/K"`. |
| `activate` | undo of the preceding write | Runs the undo of the latest earlier succeeded write entry (`create`/`update`/`delete`) for the same object in the same journal, which restores its before-image and re-activates; both entries are then marked undone. Refused, with the reason, when no such entry exists or it was already undone. ADT itself still has no deactivate operation — this replays the write that came before, it does not flip the object back to inactive on its own. |
| Transport entries | refused | `transport-release` specifically: a released transport cannot be recalled — create a corrective transport instead. Other transport entries: use `abap_transport` to reverse manually. |
| Enhancement entries (`ENHO/XH`, `ENHO/XHH`, `ENHS/XS`) | mixed | Undo of `create_spot`/`create_impl`/`create_hook` deletes the object, but only when the before-state was confirmed-absent — `create_spot`/`create_impl` now read the object before creating, so a 404 is the evidence, and an existing object refuses the create itself. Before deleting, a where-used check runs; any object referencing it blocks the undo and is named; a failed where-used call refuses (fail closed); an active BAdI implementation blocks the undo too, named. Requires enhancement delete to be enabled (`ABAP_MODE=admin` or `ABAP_ALLOW_ENHANCEMENT_DELETE`). `set_impl_active` entries record the implementation's previous active state; undo sets it back. `add_badi_def`, `add_filter_def`, `set_filter_values`, `write_description`, and enhancement `delete` stay not undoable — recorded for history only. |
| BOPF entries (`abap_bopf_edit`, `abap_bopf_delete`) | mixed | An `abap_bopf_edit update` entry (`beforeKind: "bopf-model"`) records the previous model XML; undo PUTs it back and re-activates. BOPF re-mints node IDs on every PUT and activation, so undo maps the before-image's node IDs to the live model's by element name before the PUT, and its drift check ignores node IDs and change timestamps. The restored model matches the before-image at model level, not byte-for-byte. `create_bo` and `abap_bopf_delete` stay not undoable — both use non-atomic APIs, and their entries say so at write time. |
| `abap_write text_pool` entries (`beforeKind: "text-pool"`, object `PROG/PX`/`CLAS/OCX`/`FUGR/PX`) | restore | Records the complete previous text pool as the before-image, plus a read-back after-image. Undo writes the complete previous pool back — keys added by the write are removed — drift-checked against the after-image. Text pool entries written before this behaviour shipped carry no before-image and stay refused. |

## Drift detection

Before undoing anything, the server is re-read and compared against what the
journal expects — in both directions: the object may have been changed
since, or deleted (or, for an undo-of-delete, recreated).

The comparison uses a **content hash of canonicalized source**
(`fingerprint`), not the raw server etag, for three reasons found live:
ADT's metadata etag and source etag are different values with no single
"this object" identity; the source etag moves on activation even though no
source changed, which would cry drift after every activate; and the server
strips trailing newlines and folds line endings on the wire, so raw bytes
never round-trip — canonicalizing before hashing is the same equality the
ABAP system itself implements. The raw server etag is still captured and
reported alongside, as corroborating evidence only.

On a mismatch, undo is **refused** with `ETAG_CONFLICT`, carrying both the
expected and actual fingerprints (and etags) in the error details — nothing
is written. `force: true` is the only bypass, and a forced undo is itself
journalled like any other write, so the override is traceable after the
fact.

One case is deliberately *not* treated as drift: if the server already
matches the before-image (someone else already reverted it) or, for
undo-of-create, the object is already gone, the plan resolves to a no-op —
reporting success for a write that was never sent, rather than either an
error or a silent no-network "success."

## Retention

Defaults: **200 entries** (`ABAP_JOURNAL_MAX_ENTRIES`) or **30 days**
(`ABAP_JOURNAL_MAX_AGE_DAYS`), whichever prunes more. Verified against
`src/journal.ts`'s `DEFAULT_MAX_ENTRIES = 200` and
`DEFAULT_MAX_AGE_DAYS = 30` — matches the task brief's expected figures.

Pruning drops entries beyond the count cap or older than the age cap, except
entries still in flight are never dropped regardless of age or position.
The index is rewritten via a unique tmp file plus atomic rename. A
following blob sweep deletes any before/after blob whose id is not in the
surviving index, the in-memory in-flight set, or the on-disk in-flight
registry — the on-disk registry specifically protects a blob written a
moment ago by a `begin()` still in progress, which is otherwise
indistinguishable from an orphan by file age alone.

`ABAP_JOURNAL=off` (or `false`/`0`) disables the journal entirely — no
history, no undo, and every write becomes as unrecoverable as it would be
without abapsmith at all.

## Recovery walkthrough

1. **Find the entry.**
   ```
   abap_journal mode=list object=ZCL_MY_CLASS
   ```
   Lists recent writes to that object (or omit `object` for everything, newest
   first), each row showing id, operation, whether the object existed before,
   before-image provenance, outcome, and whether it has already been undone.

2. **Inspect it.**
   ```
   abap_journal mode=show entry=<id>
   ```
   Shows the full before/after images recorded for that entry — no network
   call, pure local read, works even with the ABAP system unreachable.

3. **Undo it.**
   ```
   abap_journal mode=undo entry=<id>
   ```
   Re-reads the live object, checks for drift, and if clean, restores (or
   deletes, or recreates) and re-activates. If the object changed since the
   original write, this refuses with `ETAG_CONFLICT` naming both the
   expected and actual content hashes — read the object, decide
   deliberately, and re-run with `force: true` only if overwriting the other
   change is really what you want.

`list` and `show` never touch the network. Only `undo` is a write, and it is
gated exactly like any other write tool.

## Pending entries, STRANDED, and reconcile

`mode=list` flags a `pending` entry older than 5 minutes as STRANDED: the
before-image was written and the outcome never was, which is what a crash
mid-write looks like — nobody knows whether that write landed, and `undo`
refuses a pending entry outright rather than guess.

A `transport-remove-object` entry now means this literally: a `removeObject`
call that CTS cleanly refused (`CTS_DUPLICATE_ENTRY`, `NOT_FOUND` — nothing
was removed) settles `failed` immediately, not `pending`. Only a removal
that touched at least one E071 row before failing, or a call whose response
was lost outright (dropped connection, HTTP failure — the ABAP may have run
and answered into thin air), stays `pending`. So a pending
transport-remove-object entry is no longer a false alarm from an ordinary
refusal — it is a genuinely unresolved write, worth chasing.

Once you have established what actually happened to a pending entry — by
reading the object (`abap_read`) and comparing it against `abap_journal
mode=show`, or by other means — close it by hand:

```json
{ "mode": "reconcile", "entry": "20260731T134500123Z-a1b2c3", "outcome": "failed", "reason": "re-read ZTMD_I26_P1: source matches the before-image, nothing changed" }
```

`reconcile` is a **local** operation: no network call, no pool lease, no
safety gate, nothing sent to SAP, and no SAP object or transport request is
touched. It **deletes nothing** — the journal is append-only, so the
before-image and every earlier line for the entry stay on disk; reconcile
appends one patch line. It refuses an entry that is not `pending` (closing
an already-observed outcome would destroy the only observed fact the entry
carries), an unknown id, an empty `reason`, or a missing/invalid `outcome`.
There is deliberately no `object` fallback for `entry`: guessing which
stranded entry was meant and writing a false outcome into the audit trail is
worse than refusing.

The result is recorded as an **assertion**, not an observation — the entry
gains a `reconciled` field (`at`, `reason`, `by?`) so a later reader can
always tell a stated outcome from one abapsmith watched happen; `mode=list`
shows it in `flags`, `mode=show` shows it as its own header field plus a
note. Reconciling to `succeeded` makes the entry terminal, which means
`mode=undo` will no longer refuse it for being `pending` and will replay its
before-image — only assert `succeeded` once it is established that the write
actually landed.

`bin/abap-journal-reconcile` is the bulk counterpart: it probes the live
system itself and classifies pending entries from observed evidence,
settling them with `--apply`. Reach for it first, for entries whose live
source can settle the question on its own; reach for `mode=reconcile` for
the single entry the probe cannot settle and a human has resolved by hand.
