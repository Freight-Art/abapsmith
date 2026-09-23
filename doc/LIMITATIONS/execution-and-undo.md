# Execution and Undo

## Execution

- **Reports run through a generated classrun bridge.** That handles list output.
  It cannot handle ALV, interactive lists, or anything that expects a GUI.
- **ALV output cannot be verified.** `CL_SALV_TABLE->DISPLAY()` is rendered by
  SAPGUI; no MCP surface can screenshot it. This is a property of the object,
  not a gap here.
- **Captured output can be truncated unreliably.** `abap_run` reports a
  `droppedLines` count that is both non-actionable when it fires correctly
  (there is no way to retrieve what was dropped) and unreliable about whether it
  should fire at all — it has been observed firing when no visible content was
  missing. Treat it as a hint, not a measurement.
- **Cold bridge execution is slow.** The first run of a freshly activated
  classrun bridge is markedly slower than the second, consistent with ABAP's
  load-and-generate cycle. Observed once, not systematically measured.
- **`core.eval` running a caller-supplied ABAP snippet is not a sandbox.**
  It used to be true that abapsmith had no way to run ad hoc,
  caller-authored ABAP at all — every execution path ran a fixed,
  abapsmith-authored class. That limitation is gone as of `core.eval`,
  behind `ABAP_ALLOW_FLUID_EVAL` (off by default, not implied by any
  `ABAP_MODE`). What replaces it is not a sandbox: the static review and
  capability scan reject a handful of named statements — they do not
  confine the code, do not stop a `SELECT` against any table the
  connected user may read, do not stop a write when
  `ABAP_ALLOW_FLUID_PLUGIN_MUTATE` is also on, and do not limit runtime or
  memory. The real boundary is the SAP user's own authorisations. See
  [doc/FLUID-API/safety.md](../FLUID-API/safety.md).

## Undo

- **Local, bounded, partial.** The journal lives on the machine running the
  server, keeps 200 entries / 30 days by default, and covers `abap_write`,
  `abap_transport`, the enhancement tools, `abap_activate`, and the BOPF writes
  (`abap_bopf_edit` create/update and `abap_bopf_delete`). It does **not** cover
  `abap_fpm_read mode:"locks"` — the one FPM path that mutates anything, and it
  writes through a generated classrun, so there is no before/after image
  abapsmith controls and its changes are real and not undoable here. The other
  FPM modes dispatch against the reused fluid `fpm` body class and only read.
- **Journalled does not mean undoable.** Every new journal entry carries
  `undoable` (bool) and `undoBlocker` (reason, `""` when undoable), computed
  when the entry is written; a stored `undoable: false` is always refused,
  and a stored `true` never skips a live check (system, drift, existence,
  dependency) — undo stays fail-closed either way. `abap_bopf_edit update`
  entries (`beforeKind: "bopf-model"`) record the previous model XML and are
  undoable — undo PUTs it back and re-activates, though BOPF's PUT re-mints
  node GUIDs, so the restored model matches the before-image at model
  level, not byte-for-byte. `create_bo` and `abap_bopf_delete` stay
  `undoable: false`: both use non-atomic APIs, so their entries say so at
  write time rather than letting a caller find out by trying.
  `add_badi_def`, `add_filter_def`, `set_filter_values`,
  `write_description`, and enhancement `delete` are likewise
  `undoable: false` for good — a server-refused create can still leave an
  undeletable phantom object, a server-reported-successful delete can leave
  TADIR/E071 rows behind with no way to prove removal. `create_spot`,
  `create_impl`, `create_hook` and `set_impl_active`, by contrast, are
  undoable: the first three delete the object when the before-state was
  confirmed-absent (guarded by a where-used check and an
  active-implementation check), and `set_impl_active` sets the previous
  active state back. See `doc/JOURNAL/undo-and-recovery.md`'s table for the
  authoritative per-tool breakdown. Changing a child element in place, with
  a `set_*_fields` operation, no longer requires the remove-then-re-add
  dance to get there — which matters precisely because a failed re-add of
  the removed element could not have been undone either.
- **No server-side version integration.** The journal is not connected to the
  ABAP version database, and undo does not create a version.
- **Not an audit log.** It records what this server did, for undo. It is not
  tamper-evident, and it does not see changes made by anyone else — it detects
  them at undo time and refuses, which is a different thing.
- **`activate` undo replays the preceding write, not a deactivate.** ADT
  still has no deactivate operation. Undoing an `activate` entry instead
  undoes the latest earlier succeeded write entry (`create`/`update`/
  `delete`) for the same object in the same journal, which restores its
  before-image and re-activates; both entries are then marked undone.
  Refused, with the reason, when no such entry exists or it was already
  undone — the tool says so rather than guessing at a compensating action.
