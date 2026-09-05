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

## Undo

- **Local, bounded, partial.** The journal lives on the machine running the
  server, keeps 200 entries / 30 days by default, and covers `abap_write`,
  `abap_transport`, the enhancement tools, `abap_activate`, and the BOPF writes
  (`abap_bopf_edit` create/update and `abap_bopf_delete`). It does **not** cover
  the FPM tools, which write through generated classruns — there is no
  before/after image abapsmith controls, so their changes are real and not
  undoable here.
- **Journalled does not mean undoable.** BOPF writes were excluded from the
  journal entirely until journalling was added for them — unlike FPM, the BOPF tools
  mutate through ordinary ADT REST verbs, so there is a real before-image to
  record. But those entries are written with `irreversible: true`, and undo
  refuses every irreversible entry (`undoBlocker()`'s catch-all,
  `src/adt/undo.ts:297`), as it does for activation entries. So BOPF changes are **recorded for history, and still not
  undoable** — the record exists to tell you what happened, not to reverse it.
  See `doc/JOURNAL/undo-and-recovery.md`'s table for the authoritative per-tool breakdown.
  Changing a child element in place, with a `set_*_fields` operation, no
  longer requires the remove-then-re-add dance to get there — which matters
  precisely because a failed re-add of the removed element could not have
  been undone either.
- **No server-side version integration.** The journal is not connected to the
  ABAP version database, and undo does not create a version.
- **Not an audit log.** It records what this server did, for undo. It is not
  tamper-evident, and it does not see changes made by anyone else — it detects
  them at undo time and refuses, which is a different thing.
- **`activate` cannot be undone.** ADT has no deactivate. The tool says so
  rather than guessing at a compensating action.
