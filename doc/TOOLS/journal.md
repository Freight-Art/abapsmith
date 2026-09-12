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
| `limit` | number (1–999999) | no | `20` | `list` only — rows to return. |
| `force` | boolean | no | — | `undo` only — overwrite server-side changes made since the journalled write. |
| `activate` | boolean | no | `true` | `undo` only — also activate after reversing. |
| `outcome` | enum `succeeded` \| `failed` | required for `reconcile` | — | The outcome you assert for a `pending` entry. `pending` is the state being left, so it is not offered. |
| `reason` | string | required for `reconcile` | — | How you established that outcome. Recorded verbatim — the only evidence the entry will ever carry for it. |

`list` columns: `id`, `when`, `op`, `object`, `existed`, `capture`,
`outcome`, `flags`. `flags` includes `reconciled` for an entry closed by hand.

Notes: transport-release entries are never undoable. Other transport-*
entries are not auto-undoable. Activate entries have nothing to reverse.
Enhancement objects (`ENHO/XH`, `ENHO/XHH`, `ENHS/XS`) are **never**
undoable, even with `force:true` — this is a hard rule, not a default.

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

