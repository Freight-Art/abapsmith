# Write & activate

## abap_write

Create, change or delete (`mode=delete`) an ABAP object: saves,
syntax-checks, activates. Locking is handled for you.

**Availability**: case 1 — registered only when `canWrite`.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `object` | string | yes, unless `objects` is used | — | Object reference. |
| `type` | string | no | — | ADT type, required to create a **new** object, e.g. `CLAS/OC`, `PROG/P`. Not every type creates reliably — see `doc/LIMITATIONS/editing.md`. |
| `source` | string | no (required unless `mode=delete`) | — | Complete new source. |
| `edit` | object `{old_string, new_string, replace_all?}` | no | — | Apply a string replacement to the current source instead of sending a full replacement. |
| `method` | string | no | — | Write one method's source instead of the whole class. |
| `ddic` | object | no | — | Structured create for `DOMA/DD`/`DTEL/DE`/`TTYP/DA` only — alternative to `source` (never both). See `abapsmith-create-ddic-objects` for which fields apply to which type. |
| `package` | string | no | `$TMP` | Package for a **new** object. Must be allowlisted. For a new `DEVC/K` this is the SUPERpackage, not a sibling — omitting it would create a ROOT package, which the safety gate refuses. |
| `description` | string | no (required for `TRAN/T`, and for any `ddic` create) | — | Short description for a **new** object. |
| `expect_etag` | string | no | — | Etag from a prior `abap_read`. Write is rejected (`ETAG_CONFLICT`) if the object changed since. Also guards `mode=delete`. |
| `mode` | enum `write` \| `delete` | no | `write` | Write or delete the object. |
| `activate` | boolean | no | `true` | Activate after a successful write. |
| `verify` | boolean | no | — | Raise this one call to `verified` mode — reads the object back after a successful write. Raise-only: cannot lower a server `ABAP_VERIFY_WRITES=verified` default. |
| `format` | boolean | no | — | Pretty-print the source before writing. |
| `corr_nr` | string | no | — | Transport request to write into. Omit for `$TMP`-local objects. |
| `software_component` | string | no | — | `DEVC/K` (package) only: `LOCAL`, or a transportable component (e.g. `HOME`) — the latter needs `corr_nr` unless the package is `$TMP`-local. |
| `package_type` | string | no | `development` | `DEVC/K` only. |
| `transport_layer` | string | no | — | `DEVC/K` only. |
| `base_table` | string | no | — | `VIEW/DV` only — base DDIC table. Unreachable today: a `VIEW/DV` create is refused for every package. |
| `view_fields` | array\<string\> | no | — | `VIEW/DV` only — fields to expose. Unreachable today, same refusal as `base_table`. |
| `program` | string | no (required for `TRAN/T`) | — | `TRAN/T` only — program the transaction starts. |
| `affects` | object `{name, packageName, masterSystem?, spotName?}` | no (required for `ENHO/XHH`) | — | The object this write's target enhancement binds to. |
| `objects` | array of `{object, type?, affects?}`, 1–10 entries | no | — | Batch form: delete several objects in one call, one at a time, in the order given. `mode=delete` only. Mutually exclusive with `object` — exactly one of the two, never both and never neither. |

**Batch delete (`objects`)**: there is **no server-side batch-delete
endpoint** — unlike `abap_activate`'s `objects`, which posts to ADT's own
multi-object activation service, this is a client-side loop issuing the exact
same per-object `lock → GET → DELETE` sequence a single-object delete issues,
one object at a time, each fully awaited (including its journal write) before
the next begins. **Nothing is saved on the wire.** What it saves is model
turns — one tool call instead of N — not HTTP round trips and not server load.

- **Ordering is caller-owned.** Objects are deleted in exactly the order given;
  abapsmith does not reorder by name, type or dependency, so list dependents
  before the things they depend on.
- **The cap is 10**, deliberately not the same as `abap_activate`'s 50. Delete
  has no server-side fan-out hazard, so the cap is not about throughput; it is
  about blast radius. A bad activation is repaired by re-activating the right
  source, a bad delete only by reading a journal entry back — and only if
  journalling was on and the caller notices in time. 10 is small enough that a
  caller can still sanity-check the set by eye.
- **The two passes have opposite failure semantics, and that is a contract.**
  Pass 1 resolves, authorises and package-checks **every** entry before
  anything is deleted, and is **all-or-nothing**: one bad entry — unknown or
  ambiguous type, a `DEVC/K` package, a duplicate — aborts the whole call
  before any deletion or journalling, and the response is an ordinary single
  error (`isError: true`), with **no** per-object breakdown. An entry that
  does not exist is the one exception: it is reported per-entry as `already
  absent` (a no-op, not an error) and does not stop the rest of the batch.
  Pass 2 — the deletes themselves — is **best-effort per object**: a failure on
  object *k* does not stop *k+1*, and objects already deleted stay deleted —
  but any leftover-undeleted object now also fails the call: the
  response is a `CHECK_FAILED` error (`isError: true`) carrying a per-object
  breakdown in `details.perObject` and the rendered `--- OBJECTS ---` body,
  naming every `ok`/`FAILED` object and, for each one that succeeded, its
  `journalEntry` id for individual undo.
  A caller therefore cannot tell which pass failed from `isError` alone — both
  set it — it must look for the per-object breakdown: **absent** means Pass 1
  aborted and nothing happened; **present** means Pass 2 ran and some objects
  are already deleted and not rolled back.
- **Every object actually deleted gets its own journal entry with its own
  before-image** — never one aggregate entry for the batch — so a batch that
  dies partway still leaves a truthful, individually-undoable record.

Notes: the syntax check runs after the save and before activation — a
failing check skips activation and returns messages with real source line
numbers, so an activation failure never masquerades as a silent HTTP 200.
Every successful write is journalled (`abap_journal`) and undoable, except
enhancement objects (`ENHO/XH`, `ENHO/XHH`, `ENHS/XS`), which can never be
undone even with `force:true`. The response's `verify:` line reports which
mode applied: `speculative (not read back)`, `speculative — matched a
read-back taken before activation, not after` (speculative mode on a write
the CONCLUSIVE note settled — the pre-activation content gate did read the
object, so the field must not claim otherwise), `verified — confirmed present
via <source>`, or `verified — NOT confirmed (see NOTE)` — the last does
**not** retract the reported success (an index can lag a fresh create), it
means confirm the object yourself before building on it. See
`ABAP_VERIFY_WRITES` and this table's `verify` parameter in
[doc/CONFIGURATION/journal-diagnostics-and-tooling.md § Write verification](../CONFIGURATION/journal-diagnostics-and-tooling.md#write-verification). This `verify:` line is unrelated to the boolean
`verified` field on `TRAN/T`/`DEVC/K` bridge-create responses —
that one is an always-on check unaffected by either mode, because those
particular creates' own success responses cannot prove persistence.

Example:

```json
{
  "object": "ZCL_DEMO_ORDER",
  "type": "CLAS/OC",
  "package": "$TMP",
  "description": "Demo order handler",
  "source": "CLASS zcl_demo_order DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS get_total RETURNING VALUE(rv_total) TYPE p.\nENDCLASS.\nCLASS zcl_demo_order IMPLEMENTATION.\n  METHOD get_total.\n    rv_total = 0.\n  ENDMETHOD.\nENDCLASS."
}
```

## abap_activate

`mode=check`: syntax check of saved or unsaved source, no lock.
`mode=activate`: check then activate. Inactive objects do not run.

**Availability**: case 2 — always registered. `mode=check` is unconditional
(no lock, works under `ABAP_MODE=read`); `mode=activate` needs `canWrite`
and is refused at call time otherwise, despite the tool being listed.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `object` | string | yes, unless `objects` is used | — | Object reference. |
| `type` | string | no | — | ADT type hint. |
| `mode` | enum `check` \| `activate` | no | `activate` | Check only, or check then activate. |
| `source` | string | no | — | Draft to check. Omitted for `mode=check`, the saved server version is fetched and checked instead — refused with `BAD_INPUT` only when there's genuinely nothing saved to check (object doesn't exist yet, or its type has no `/source/main`). Omitted for `mode=activate`, the saved server version is activated with no pre-flight check. |
| `corr_nr` | string | no | — | Transport request to activate into. |
| `affects` | object | no (required to activate an existing `ENHO/XH`/`ENHS/XS`) | — | The object the enhancement binds to. |
| `objects` | array of `{object, type?, affects?}`, 1–50 entries | no | — | Batch form: activate several objects through ADT's multi-object activation endpoint instead of one call each. Mutually exclusive with `object`/`type`/`affects`/`corr_nr`/`source`, and `mode=activate` only (no batch syntax check). |

**Batch activation (`objects`)**: sends the object list to ADT's own
multi-object activation endpoint, rather than one `abap_activate` call per
object — but not necessarily in a single POST. Classic ABAP Dictionary types
(domains, data elements, tables, structures, table types, and a few other
structured-XML DDIC kinds) route through SAP's own DDIC mass-activation
utility, which fans a large batch out into a burst of server-side async RFCs
that can exhaust the target system's dialog work processes; to
bound that, the object list is split by type into smaller chunks and POSTed
sequentially, invisibly to the caller — see the "Batch activation" section of
[doc/CONFIGURATION/concurrency-and-activation.md § Batch activation](../CONFIGURATION/concurrency-and-activation.md#batch-activation) for the chunk sizes and how to tune them. Classes,
programs, interfaces, function groups, CDS and the like are not subject to
this and travel in much larger chunks (in practice, one). Every object across
the WHOLE list is resolved and authorised BEFORE any of them is activated —
if even one is refused by the safety gate (package not allowed, `$TMP`
boundary, etc.), **nothing is activated**, not even the objects that would
individually have been fine, and not even objects that would have landed in a
different chunk. The response messages the server does return are attributed
back to the object they name (by `href`, falling back to `objDescr`) across
every chunk, not just the one it came from; anything that cannot be tied to
one specific object is reported separately as `(unattributed)` and still
fails the batch. `abap_do`'s `activate` action does not expose this form — it
is v1-`abap_activate` (and the v1 tool surface generally) only.

**Batch activation and the journal**: a batch writes one journal entry per
object before any chunk's POST goes out, and because the chunks are POSTed
sequentially, those entries can legitimately disagree about the outcome. A
chunk that already answered clean has activated its objects — ADT has no
deactivate operation — so a later chunk failing does not make them inactive
again: their entries settle `succeeded` while the failing chunk's settle
`failed`. An object whose chunk POST never answered at all is a genuinely
unknown outcome; the journal's `pending | succeeded | failed` model has no
value for "done, outcome unproven", so that entry is deliberately left
`pending` and a warning is written to stderr instead of recording something
the call did not establish — the same convention `abap_transport_release`
uses. Re-read the object to see its state, and settle the entry by hand. An
object in a chunk that was never sent at all, because an earlier chunk
failed first, settles `failed`, with an error saying so.

