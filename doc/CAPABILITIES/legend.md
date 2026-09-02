## Legend

Two marker sets, fixed and used everywhere in this document set. No file
below invents its own vocabulary.

### Capability markers

| Marker | Meaning |
| --- | --- |
| `yes` | Supported through a normal tool call. |
| `partial` | Reachable, but only under a stated restriction. Every `partial` cell has a matching note that says what the restriction is. |
| `no` | Not reachable through any tool. |
| `n/a` | The operation does not exist for this thing. |

### Evidence markers

| Marker | Meaning |
| --- | --- |
| `live` | Exercised against a real SAP system, with captured bytes or a dated source citation. |
| `tests` | Covered by tests only. Fixtures are synthetic, hand-written, or derived by editing another capture. |
| `mixed` | Sub-paths differ. The note says which are `live` and which are `tests`. |
| `unverified` | No evidence either way. Not a claim that it is broken. |
| `n/a` | The row claims no capability, so there is nothing to grade. |

A success path that was only ever produced by editing a captured failure is
not `live`, however confident the code looks. Where that is the case, the
note attached to that row says so explicitly.

### Framework and non-object table columns

Every framework table (BOPF, CDS, RAP, FPM and FBI) and the non-object
capabilities table carry the same eight columns: `Entity`, `Create`, `Read`,
`Update`, `Delete`, `Activate`, `Evidence`, `Notes`. Every row fills every
column.
