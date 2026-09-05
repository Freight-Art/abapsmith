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
| `delete` | recreate | From the before-image. For a class, only the main include was ever captured — local definitions/implementations/macros/test classes are never restored; the tool reports this as a partial restore, forceable. |
| `delete` of a package (`DEVC/K`) | refused unconditionally, unforceable | A package has no source; its metadata document is captured as the before-image (`beforeKind: "package-metadata"`), but abapsmith does not re-create packages from a journal entry — restoring a before-image means writing it through the ordinary write path, which has no source document to PUT it against. Re-create deliberately with `abap_write type="DEVC/K"`. |
| `activate` | refused | ADT has no deactivate operation. The tool says so and points at the WRITE entry for the same object instead of guessing at an inverse. |
| Transport entries | refused | `transport-release` specifically: a released transport cannot be recalled — create a corrective transport instead. Other transport entries: use `abap_transport` to reverse manually. |
| Enhancement entries (`ENHO/XH`, `ENHO/XHH`, `ENHS/XS`) | refused unconditionally, unforceable | Live testing found undo of enhancement objects unsafe even in principle: a server-refused create can still leave an undeletable phantom object; a server-reported-successful delete can leave TADIR/E071 rows behind with no way to prove removal; a misconfigured transport layer can leave both the request and the package permanently stuck. Recorded for history only — `irreversible: true`. |
| BOPF entries (`abap_bopf_edit` create/update, `abap_bopf_delete`) | refused unconditionally, unforceable | No BOPF-specific branch in `undoBlocker()`: every BOPF entry sets `irreversible: true`, which `undoBlocker()`'s generic catch-all (the same one that refuses enhancement-adjacent entries like `abap_ui` press) refuses before `planUndo` issues any request — `resolveWriteTarget` (`src/adt/write.ts`), which also does not recognise `object.type: "BOBF"`, is never even reached. `irreversible: true` records that honestly in `mode=list`/`mode=show` rather than leaving a caller to discover it only by trying. |

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
