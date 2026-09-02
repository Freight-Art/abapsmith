# abap_journal

List, inspect, or undo writes this server has made.

**Availability**: case 2 — always registered. `list`/`show` are
unconditional and cost zero network calls (pure local file reads — no
connection pool slot is leased). `undo` needs `canWrite`.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `mode` | enum `list` \| `show` \| `undo` | no | `list` | Operation. |
| `entry` | string | required for `show`/`undo` unless `object` given | — | Journal entry id to show or undo. |
| `object` | string | no | — | Undo the most recent entry for this object instead of naming an entry id. |
| `limit` | number (1–999999) | no | `20` | `list` only — rows to return. |
| `force` | boolean | no | — | `undo` only — overwrite server-side changes made since the journalled write. |
| `activate` | boolean | no | `true` | `undo` only — also activate after reversing. |

`list` columns: `id`, `when`, `op`, `object`, `existed`, `capture`,
`outcome`, `flags`.

Notes: transport-release entries are never undoable. Other transport-*
entries are not auto-undoable. Activate entries have nothing to reverse.
Enhancement objects (`ENHO/XH`, `ENHO/XHH`, `ENHS/XS`) are **never**
undoable, even with `force:true` — this is a hard rule, not a default.

