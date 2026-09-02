# Write journal

There is no git for ABAP, so abapsmith keeps its own local, append-only
journal of every mutation it makes — a before/after image of each write,
recorded before the write is attempted, so a crashed or unwanted change can
be inspected and undone.

| Part | Covers |
|---|---|
| [Journal format and what gets recorded](journal-format.md) | On-disk layout (`index.jsonl`, blobs, in-flight markers), entry fields, and exactly which tools and operations get journalled |
| [Undo, drift detection, and recovery](undo-and-recovery.md) | What undo does per operation type, how drift against the live server is detected and refused, retention/pruning, and a walkthrough of finding, inspecting, and undoing an entry |
