# Write & activate

## abap_write

Create, change or delete (`mode=delete`) an ABAP object: saves,
syntax-checks, activates. Locking is handled for you.

**Availability**: the real, functional tool needs `canWrite`. Without it,
a read-only v1 server registers a mode-locked refusal stub under the same
name instead of skipping registration (case 4 in
[availability-and-capabilities.md](availability-and-capabilities.md)):
still listed with an empty schema, refuses every call `READ_ONLY` without
reaching SAP.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `object` | string | yes, unless `objects` is used | — | Object reference. |
| `type` | string | no | — | ADT type, required to create a **new** object, e.g. `CLAS/OC`, `PROG/P`. Not every type creates reliably — see `doc/LIMITATIONS/editing.md`. |
| `source` | string | no (required unless `mode=delete`) | — | Complete new source. |
| `edit` | object `{old_string, new_string, replace_all?}` | no | — | Apply a string replacement to the current source instead of sending a full replacement. |
| `method` | string | no | — | Write one method's source instead of the whole class. The method's line range is resolved against the INACTIVE version's component structure when one exists (a class saved inactive by a failed syntax check), as reported by the object's descriptor, otherwise the active one; the success note says which. A method missing from both is `NOT_FOUND` with `details.available` naming the class's own methods — never the class name. |
| `include` | enum `main` \| `definitions` \| `implementations` \| `macros` \| `testclasses` | no | `main` | `CLAS/OC` only — which class sub-include to write. `testclasses` is the ABAP Unit test include (CCAU). A write REPLACES the whole named include; there is no partial/patch write to an include (`edit`/`method` still target `main` only). |
| `ddic` | object | no | — | Structured create for `DOMA/DD`/`DTEL/DE`/`TTYP/DA` only — alternative to `source` (never both; an empty `source: ""` counts as absent). `DOMA/DD` takes `fixedValues: [{low, high?, text}]` and `valueTable`, and computes `outputLength` from the type unless given. See `abapsmith-create-ddic-objects` for which fields apply to which type. |
| `package` | string | no | `$TMP` | Package for a **new** object. Must be allowlisted. For a new `DEVC/K` this is the SUPERpackage, not a sibling — omitting it would create a ROOT package, which the safety gate refuses. |
| `description` | string | no (required for `TRAN/T`, for any `ddic` create, and for `mode="update"` on `VIEW/DV`, `TRAN/T` or `SHLP/DH`) | — | Short description for a **new** object, or the replacement description on an `update` — `DDIF_VIEW_PUT`/`RPY_TRANSACTION_INSERT`/`DDIF_SHLP_PUT` all replace the description along with everything else, so an update that wants to keep the old text must pass it again. |
| `expect_etag` | string | no | — | Etag from a prior `abap_read`. Write is rejected (`ETAG_CONFLICT`) if the object changed since. Also guards `mode=delete`. |
| `mode` | enum `write` \| `delete` \| `update` | no | `write` | `write` creates (or edits source in place for most types); `delete` removes the object; `update` retargets/replaces an EXISTING `VIEW/DV`, `TRAN/T` or `SHLP/DH` through the classic fluid bridge (`DDIF_VIEW_PUT`, `RPY_TRANSACTION_DELETE`+`RPY_TRANSACTION_INSERT`, `DDIF_SHLP_PUT` — each replaces the WHOLE definition, not a patch) — refused zero-network, no server call, for every other type. |
| `activate` | boolean | no | `true` | Activate after a successful write. |
| `verify` | boolean | no | — | Raise this one call to `verified` mode — reads the object back after a successful write. Raise-only: cannot lower a server `ABAP_VERIFY_WRITES=verified` default. |
| `format` | boolean | no | — | Pretty-print the source before writing. |
| `corr_nr` | string | no | — | Transport request to write into. Omit for `$TMP`-local objects. Never required: for every transportable create — the classic-bridge types `TRAN/T`, `SHLP/DH`, `VIEW/DV`, `TABL/DI` and `DEVC/K` included (they register via `RS_CORR_INSERT`, which needs a request, so the server resolves one) — omitting it takes the same route as a class create: the safety gate judges the write first, with no wire request, then the session resolver reuses a modifiable request this session created or that is attributed to abapsmith for the package, else creates one, and the response's `transport:` field names it. Under `ABAP_ALLOW_TRANSPORTS=auto` a named value is refused (`SAFETY_DENIED`, rule `transport allowlist`, `retryable: false`) regardless of which request — omit the field. Refused for any bridge create into a `$` package. For `mode="update"` on any of the three, `corr_nr` is always optional, never required, regardless of package — the object already exists and is already recorded wherever CTS holds it; a named value is passed through as-is (`corrSource: "named"`), nothing re-derives or requires it. Also refused for a `VIEW/DV`/`TRAN/T`/`SHLP/DH` delete — none of the three delete bridges takes a transport parameter, and none is needed: the delete registers nothing in CTS, so it is judged as a local mutation regardless of `ABAP_ALLOW_TRANSPORTS`. For any other `mode=delete`, a named `corr_nr` that disagrees with the request CTS already records the object in is refused before anything is deleted, pre-lock — see "`mode=delete` and transport requests" below; left unnamed, the request that already holds the object wins the deletion, resolved automatically. A `mode=write`/`edit` naming a different `corr_nr` is never refused this way — the write proceeds under the request CTS already holds, reported rather than silently substituted. |
| `software_component` | string | no | — | `DEVC/K` (package) only: `LOCAL`, or a transportable component (e.g. `HOME`) — the latter needs `corr_nr` unless the package is `$TMP`-local. |
| `package_type` | string | no | `development` | `DEVC/K` only. |
| `transport_layer` | string | no | — | `DEVC/K` only. |
| `base_table` | string | no (required for `VIEW/DV` create or `mode="update"`) | — | `VIEW/DV` — the single base DDIC table. An update REPLACES the whole projection, so it must be repeated even to leave it unchanged. Also accepted for `TABL/DI` create/delete — see "`TABL/DI` addressing" below; there it names the index's base table rather than a view's projection source. |
| `view_fields` | array\<string\> | no (required for `VIEW/DV` create or `mode="update"`) | — | `VIEW/DV` only — the fields to project, in order. Same replace-the-whole-list rule as `base_table` on an update; `DDIF_VIEW_PUT` refuses a view projecting no field at all. |
| `program` | string | no (required for `TRAN/T` create or `mode="update"`) | — | `TRAN/T` only — the existing SUBMIT-only report the transaction starts. On `mode="update"` this retargets an existing transaction to a different (already-existing) program; abapsmith checks the program exists before calling `RPY_TRANSACTION_DELETE`+`RPY_TRANSACTION_INSERT`. |
| `shlp` | object | no (required for `SHLP/DH` create or `mode="update"`) | — | `SHLP/DH` only — the search help's full DD30V/DD32P/DD31V/DD33V shape: `selectionMethod`, `selectionMethodType` (enum `T`\|`V`\|`M`), `dialogType`, `textTable`, `hotKey`, `elementary` (if true, `fields` must carry at least one import and one export parameter; if false, an empty `includes` is now accepted — it activates fine on a real system, so the old "has nothing to collect" refusal was removed), `fields` (array of `{name, dataElement, import?, export?, defaultValue?}`), `includes` (array of `{name}`, other search helps this one includes), `assignments` (array of `{field, includedHelp, includedField, direction}`, `direction` enum `I`\|`E`). Every `assignments[i].field` must name one of this call's own `fields[].name`, and every `assignments[i].includedHelp` must name one of this call's own `includes[].name` (both case-insensitive) — refused `BAD_INPUT` zero-network otherwise, before any server call; see "Search help refusals and DH109" below for why. `selectionMethod`/`selectionMethodType` are both optional — omit both for a collective search help, or for an elementary one driven by a search-help exit instead of a table/view (five standard SAP elementary helps carry a blank DD30V-SELMETHOD this way). An update REPLACES the whole interface/includes/assignments list — nothing already defined carries over; see `SearchHelpParams` in `src/adt/shlp-create.ts`. |
| `confirm_in_use` | boolean | no | — | `SHLP/DH` `mode="delete"` only: required `true` when the search help is still attached to a data element, a table/view field, or included by a collective search help (`DD04L`/`DD35L`/`DD31S` show it in use). Refused zero-network for any other type/mode combination. Only the active version is checked for in-use; an inactive-only leftover (see below) has none of these attachments by definition and never needs it. |
| `confirm_maintenance_dialog` | boolean | no | — | `VIEW/DV` `mode="delete"` only: overrides the bridge's refusal when the view still has a generated SE54 maintenance dialog (`TVDIR`) — deleting the view would leave that dialog broken. The refusal names the specific dialog (function group, area, package, screen) so a caller can read it before passing this. Refused zero-network for any other type/mode combination. |
| `confirm_in_role_menu` | boolean | no | — | `TRAN/T` `mode="delete"` or `mode="update"` (retarget) only: overrides the bridge's refusal when the tcode is already assigned to one or more roles' menus (`AGR_TCODES`). Deleting it removes it from those menus; retargeting it changes what those menu entries launch. The refusal names the specific roles. An SM01 transaction lock is **not** checked either way, by design — see `doc/LIMITATIONS/editing.md`. Refused zero-network for any other type/mode combination. |
| `affects` | object `{name, packageName, masterSystem?, spotName?}` | no (required for `ENHO/XHH`) | — | The object this write's target enhancement binds to. |
| `objects` | array of `{object, type?, affects?}`, 1–10 entries | no | — | Batch form: delete several objects in one call, one at a time, in the order given. `mode=delete` only. Mutually exclusive with `object` — exactly one of the two, never both and never neither. |
| `dry_run` | boolean | no | — | Resolve, read, apply the edit locally and run the safety gate, but return a diff preview instead of writing. Works with `source`, `edit`, `method`, `ddic` and `mode=delete`. Refused with `BAD_INPUT` for `objects`, for `DEVC/K`, and — for every mode, not just create — for the four bridge-only types (`SHLP/DH`, `VIEW/DV`, `TRAN/T`, `TABL/DI`): the dispatch check runs before any create/update/delete branching, so a dry-run `mode="delete"` or `mode="update"` on one of these is refused the same as a create. |

**Search help refusals and DH109**: `DDIF_SHLP_PUT` succeeds and
`DDIF_SHLP_ACTIVATE` then returns `rc = 8` with message `DH109` ("search
help & was not activated") whenever the definition contains a dangling
reference — a `DD31V` include naming a search help that does not exist, a
`DD33V` assignment whose `SUBFIELD` is not an interface parameter of the
included help, or a `DD33V` assignment whose `FIELDNAME` is not an
interface parameter of the help being built. All three shapes leave the
search help stranded as an INACTIVE-ONLY object: a `DD30L` row with
`AS4LOCAL = 'N'`, no active row, plus a `TADIR` entry. Four refusals stop a
caller from creating that leftover: two are zero-network, checked in
`abapsmith` before any server call is made (`assignments[i].field` must be
one of this call's own `fields[].name`; `assignments[i].includedHelp` must
be one of this call's own `includes[].name`); two are server-side, run
inside the generated ABAP BEFORE `RS_CORR_INSERT` so nothing is registered
when they fire (every `DD31V-SUBSHLP` must exist as an active `DD30L` row;
every `DD33V-SUBFIELD` must exist as an active `DD32S` row of its
`SUBSHLP` — a self-referencing assignment, `SUBSHLP = SHLPNAME`, skips this
one check because the definition being built is not in `DD32S` yet). The
server-side pair surfaces as `CHECK_FAILED`. `rc = 4` with message `DH108`
("activated with warnings") is a SUCCESS, not a refusal — a collective help
carrying a selection method, one with no includes, and one with no
fields/assignments all activate that way — and now emits a
`ZMCP-DDIC-NOTE>` line rather than passing silently.

**Inactive-only search helps and `mode="delete"`**: the create/update
"already exists" probe and `abap_read` both stay active-only — an
inactive-only search help (the DH109 leftover above, or one stranded by any
other means) still reads back `NOT_FOUND`. Only the delete path looks at
both states: it probes with `readSearchHelp`'s `{ includeInactive: true }`
option (`src/adt/catalog-read.ts`), which falls back to the `'N'` version
and reports `meta.versionState`, so a failed create's leftover can be
cleaned up with a normal `abap_write { mode: "delete", type: "SHLP/DH" }`
instead of being refused `NOT_FOUND`. The delete bridge then clears both
DDIC states and the `TADIR` entry the same way it does for an active
search help, emitting the same `SHLP-DELETED` / `SHLP-GONE` markers, with a
note explaining the object had no active version.

**`TABL/DI` addressing**: `abap_read` names a table secondary index as
`<TABLE>/<INDEX>` (see `doc/TOOLS/read-and-search.md`'s "Catalog reads"
section, e.g. `abap_read {"object":"ZTAB/Z01","type":"TABL/DI"}`) because
`TABL/DI` has no ADT resource of its own to resolve a bare name against.
`abap_write` now accepts both of the following for `object`, for both
create and `mode=delete`:

- The same parented form, alone: `{"object":"ZTAB/Z01","type":"TABL/DI"}`.
  It is split into base table `ZTAB` and index `Z01`; `base_table` may be
  omitted.
- The bare index name plus `base_table`, unchanged from before:
  `{"object":"Z01","type":"TABL/DI","base_table":"ZTAB"}`.

`base_table` may be given alongside the parented form too, as long as it
agrees with the table named in `object` — abapsmith never silently
prefers one over the other. If the two disagree, or if `object` is a bare
index name with no `base_table` at all, the call is refused `BAD_INPUT`
naming both values (or both accepted forms) rather than guessing.
**Class sub-includes (`include`)**: a `CLAS/OC` has five includes ADT
exposes — `main`, `definitions` (CCDEF), `implementations` (CCIMP),
`macros` (CCMAC) and `testclasses` (CCAU). `include` picks which one this
write targets; omitting it writes `main`. Writing `testclasses` — creating
it when the class has none, or replacing it when it already does — then
`abap_activate`-ing the class, then running `abap_test` against it, then
reading it back with `abap_read include="testclasses"`, was verified live
end to end against SAP A4H, 2026-09-12: create-when-absent, update-when-
present, activation, test execution and read-back all confirmed with real
bytes on the wire (see `test/fixtures/live-captured/` for the class used,
`ZCL_I75_PROBE`, and the `abapsmith-write-abap-unit-tests` skill for the
authoring shape). This is the only supported way to write ABAP Unit tests
through this tool — there is no dedicated "create a test class" mode.

A write always replaces the **entire** named include; there is no way to
append to or patch part of an include, and no way to delete a single
include on its own — ADT exposes no such verb, only delete-the-whole-
class. Asking for `mode=delete` together with `include` is refused with
`BAD_INPUT` before anything is touched, for exactly this reason: deleting
`ZCL_FOO` because you asked to delete its `testclasses` would destroy the
class's main source and its other includes too, and that could not be
undone. To empty an include instead of deleting it, write it with new,
possibly empty (or single-comment-line) content; to delete the whole
class, drop `include` from the call.

Because an include activates together with its class, a syntax error in
`testclasses` (or any other include) blocks activation of the whole
class, not just that include — the class's main logic stops compiling
along with its tests. Read an include before rewriting it: since the
write replaces the whole thing, an `abap_write` with `include` and no
prior `abap_read` of the same include silently discards whatever was
there before. `abap_journal mode=undo` can revert a sub-include write —
see [journal.md](journal.md) for the current, still test-covered-only,
state of that undo path.

**`mode=delete` and transport requests**: SAP records a deletion on the
request that already holds the lock entry for the object — the request
the ADT lock response names — not necessarily the `corr_nr` abapsmith sent
with the `DELETE`. What happens next depends on whether `corr_nr` was named
(by the caller's `corr_nr` argument, or pinned to one request by
`ABAP_ALLOW_TRANSPORTS`) or left for abapsmith to resolve on its own:

- **Named, and CTS already records the object in a different request**:
  the delete is refused before anything is locked. The check runs
  pre-lock, against ADT's own `transportchecks` pre-flight answer — the
  same call the safety gate already makes to learn which request an object
  belongs to — so a mismatch is caught with no enqueue taken and nothing
  journalled. The error is `TRANSPORT_ERROR` with
  `details.reason = "CORR_NR_NOT_HONOURED"`, `details.corrNr` set to what
  the caller named, `details.lockCorrNr` set to the request CTS actually
  records the object in, `details.corrNrHonoured: false`, and
  `details.deleted: false`. The message names both requests and gives the
  two ways forward: delete again with `details.lockCorrNr` as `corr_nr`
  (it is then gated like any other number), or first remove the object's
  entry from that request with `abap_transport` operation `removeObject`
  (needs `ABAP_MODE=admin`; CTS's own duplicate-row check can still refuse
  this once a request holds two or more E071 rows for the object, but
  abapsmith cannot say what reliably produces that — see
  `doc/LIMITATIONS/editing.md`). A second, identical comparison still runs
  under the lock, as a backstop for the rarer case where the lock names a
  request the pre-flight did not — there the lock has already been taken,
  so the refusal message says the lock was released rather than that none
  was taken; the outcome is the same either way, nothing deleted.
  **This is new**: before this fix, this same situation — `corr_nr` named,
  CTS already recording the object elsewhere — never refused at all. The
  delete silently proceeded under the request CTS held, and the caller's
  `corr_nr` was discarded without comment. An agent that names `corr_nr` on
  every delete call will now see a hard `TRANSPORT_ERROR` in a case that
  used to be a silent, unannounced success.
- **Auto-resolved** (no `corr_nr` named; `ABAP_ALLOW_TRANSPORTS=auto` or a
  list): the delete proceeds — nobody chose the number, so refusing helps no
  one. The request the lock names is still re-judged against the safety
  gate's transport allowlist before the delete goes ahead, so a change is
  never recorded on a request the gate never saw (under the default `auto`
  this permits any number). The response header carries
  `corr_nr_honoured: false`, and a note names both numbers: the sent
  `corr_nr` was not used, because the object was locked by the transport
  request CTS actually recorded the deletion on.
- **`dry_run` (delete or write)**: takes no lock and makes no CTS call
  either way, so it cannot tell you which request actually holds the
  object. When the call names a `corr_nr`, the preview note warns that a
  real delete would refuse outright, and that a real write would instead
  proceed and be recorded under whatever request CTS already holds the
  object in. The `transport:` line itself stays the fixed `unresolved (dry
  run makes no transport call)` either way.

The batch delete form (`objects`) never names a `corr_nr` per object, so
every object it deletes can only hit the auto-resolved case above; each
object's line in the rendered `--- OBJECTS ---` body says so when it
applies. abapsmith does not re-read either transport request to confirm
what is actually recorded in it — the response reports what the lock and
the `DELETE` call said, not a follow-up read.

Unlike the delete, a `mode=write`/`edit` (PUT) naming a `corr_nr` other
than the request CTS already records the object in is **not** refused —
it is report-only. A transportable object can only be recorded in the
request that already holds it, so the write proceeds and is recorded
under that request rather than the one asked for, exactly as before. What
changed is that abapsmith no longer pretends the caller's number was
honoured: the response header carries `corr_nr_honoured: false` (the same
key the delete's auto-resolved case uses), and a note names both
requests, replacing the write's ordinary transport note. This is a
deliberate asymmetry, not an oversight: a write's request assignment is a
fact about where the object already lives, and the caller can change
it — with `abap_transport` operation `removeObject`, then retry the
write — while a delete's is not: deleting under a request the caller
never asked for cannot be undone by any later call, so it is refused
instead of reported. `transportDivergence` (`src/adt/write.ts`) is real
and still fires, but it guards a narrower, different case than a
caller-named `corr_nr`: the safety gate's pre-flight judged one request
and the lock then reports a different one, i.e. the object moved between
the two calls. It was never the check that covered a caller-named
`corr_nr`, for write or for delete — confirmed live on A4H, 2026-09-12: an
`edit` write naming a different `corr_nr` succeeded silently under the
request CTS already held, with no mention of the substitution anywhere in
the response.

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
Each message in `details.failure.details.messages` also carries the
offending line's text as it was just sent (`sourceLine`, trimmed, cut at 200
characters) and one line of context each side (`before` / `after`), taken
from the source the call already holds — no second read; messages without a
line position are passed through untouched. The `CHECK_FAILED` hint says the
object is saved inactive and that, for a class, `abap_write method="<NAME>"`
repairs one method against that inactive version, after which
`abap_activate` (or a write with `activate=true`) activates it. A syntax
error that ADT already refuses at save time (a missing period,
`ExceptionResourceScanDuringSaveFailure`) never reaches this state — for a
new object the just-created shell is deleted again and the response says
so; only errors that pass the save and fail the check leave the object
inactive.
Every successful write is journalled (`abap_journal`) and undoable, except
enhancement objects (`ENHO/XH`, `ENHO/XHH`, `ENHS/XS`), which can never be
undone even with `force:true`, and except the bridge routes for `SHLP/DH`,
`VIEW/DV` and `TRAN/T`, whose journalling differs by operation and, for
delete, by type. A `VIEW/DV` or `TRAN/T` **create** is journalled the same
way an ordinary create is — no `irreversible` flag — but `abap_journal
mode=undo` can only reach it when the pre-create read positively confirmed
the object absent beforehand (`beforeCapture: "confirmed-absent"`) and the
create's own read-back found it registered in a package; the create
response's closing note says which applies for that call. A `VIEW/DV` or
`TRAN/T` **delete** is NOT journalled at all: the delete bridge captures no
before-image, so there is nothing `abap_journal` could ever offer to
restore — to bring the object back, create it again with a fresh
`abap_write` call. A `SHLP/DH` **create**, and a `mode="update"` on any of
the three types, are journalled with `irreversible: true` — recorded for
audit and manual comparison only, since none of `DDIF_VIEW_PUT`,
`DDIF_SHLP_PUT` or `RPY_TRANSACTION_DELETE`+`RPY_TRANSACTION_INSERT` has a
"restore the prior definition" primitive to replay, and (for `SHLP/DH`)
`src/adt/undo.ts`'s `vitTypeFor()` has no `SHLP/DH` case regardless —
`abap_journal mode=undo` refuses an irreversible entry outright, even with
`force:true` ("IRREVERSIBLE: this entry can never be undone by any
mechanism, not even force=true.", `src/tools/journal.ts`). A `SHLP/DH`
**delete**, unlike a `VIEW/DV`/`TRAN/T` delete, IS journalled with a real
before-image: the pre-delete existence check doubles as that before-image
(the rendered pseudo-DDL becomes `beforeSource`, `beforeCapture:
"captured"`), but the entry is still marked `irreversible: true`, for two
independent reasons — mechanically, the stored before-image is rendered
pseudo-DDL, not a `DDIF_SHLP_PUT` payload, so there is nothing for undo to
replay; and `vitTypeFor()` has no `SHLP/DH` case, so marking it
irreversible makes `undo.ts`'s `undoBlocker()` refuse cleanly instead of
reaching that gap. The entry exists for audit and manual reconstruction;
reversal is a fresh `abap_write { mode: "write", type: "SHLP/DH" }`, never
`abap_journal mode=undo`. See `doc/LIMITATIONS/editing.md` for the full
breakdown and live-verification notes. The response's `verify:` line
reports which
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

**Dry run (`dry_run`)**: resolves the target, reads the current source,
applies the requested edit locally, and runs the safety gate exactly as
a real write would — then returns a preview instead of writing. The
response carries `system`, `object`, `uri`, `package`, `package_source`,
`mode`, `dry_run: true`, `created` (whether the object would be created),
`expect_etag` (the exact etag the real write would assert), `current_etag`
(the content hash of the object's source as it stands now — the value
to pass back as `expect_etag` on the applied write when the form does not
supply one itself), a `transport:` line, `added`/`removed`/`hunks` diff
counts, `journal: nothing recorded (dry run)`, and a unified diff as the
body. A dry run makes **zero** mutating requests — no lock, PUT, DELETE,
activation, unlock, or CTS call — and nothing is journalled.

The `transport:` line always reads `unresolved (dry run makes no transport
call)` — a dry run never asks CTS for a request and never creates
one. More consequential: the safety gate is consulted twice on a real
write, and a dry run runs only the first check. That first check is at
`authorizeMutation` (`src/adt/write.ts`), with the transport still unresolved,
and a dry run runs it identically; the second happens inside `preflightCorr`
(`src/adt/write.ts`), only once CTS has returned the real request number,
and it is the one that judges that number against the transport allowlist
— a dry run cannot run it without making the CTS call it exists to avoid,
so a preview of a **transportable** write that comes back clean can still
be refused when it is applied. Writes to a `$`-local package resolve no
request and are unaffected.

If the safety gate would refuse the write (package outside the allowlist,
a mode that forbids it, etc.), the dry run returns that refusal instead
of a diff, so a preview never shows a change the caller could not actually
apply. `format: true` works on a dry run — the pretty-printer is a stateless
server call that writes nothing, so the previewed bytes are the bytes a real
write would send. `mode=delete` supports `dry_run` too, but its response shape
differs from a write preview: instead of a diff it returns a `would_delete:
true` header line, the resolved object, uri and package, and the gate verdict,
with no diff body — there is no source to diff against. Its `transport:`
line is the same fixed `unresolved (dry run makes no transport call)` as
the write form, since a delete dry run makes no CTS call either. Whether a
real delete would be undoable depends on whether the write journal is on,
and the response says so directly: either that a real delete would capture
a before-image and be undoable through `abap_journal mode=undo`, or that
the journal is off and a real delete would be irreversible.

The `edit` and `method` forms make the real write assert `expect_etag`
automatically, so a dry run followed by the same call with `dry_run`
dropped is safe as-is. The plain `{object, source}` form does not — the real
write asserts nothing unless the caller passes `expect_etag` explicitly. The
documented workflow for that form: dry-run, read `current_etag` from the
preview (`expect_etag` reads `none (this form asserts no precondition)` for
this form, since nothing supplies one), then repeat the call without
`dry_run` and with that value as `expect_etag`, so the applied write
compares against exactly the bytes previewed.

Three kinds of route refuse `dry_run` with `BAD_INPUT` rather than
half-performing it, because they cannot be evaluated without being
performed: the `objects` batch-delete form (preview one object at a time
instead); the bridge-only types (`SHLP/DH`, `VIEW/DV`, `TRAN/T`, `TABL/DI`)
in every mode they support (create, delete, and — for `SHLP/DH`, `VIEW/DV`,
`TRAN/T` — `update`), which are created, retargeted or removed by
generating and running an ABAP program, leaving nothing to preview short of
doing it; and `DEVC/K` (package create), where a transportable package create must claim
or create its transport request before anything else can be decided.

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
`mode=format`: run the server's own pretty printer over source, either
standalone text or a saved object — see
["mode=format: the pretty printer"](#modeformat-the-pretty-printer) below.

**Availability**: case 2 — always registered. `mode=check` is unconditional
(no lock, works under `ABAP_MODE=read`); `mode=activate` needs `canWrite`
and is refused at call time otherwise, despite the tool being listed.
`mode=format` splits by form: the text form (`source`, no `object`) is
unconditional like `mode=check`; the object form (`object`, no `source`)
needs `canWrite` like `mode=activate`. See
[availability-and-capabilities.md](availability-and-capabilities.md).

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `object` | string | yes, unless `objects` is used or `mode=format` with `source` | — | Object reference. |
| `type` | string | no | — | ADT type hint. |
| `mode` | enum `check` \| `activate` \| `format` | no | `activate` | Check only, check then activate, or pretty-print. |
| `source` | string | no | — | For `mode=check`/`mode=activate`: draft to check. Omitted for `mode=check`, the saved server version is fetched and checked instead — refused with `BAD_INPUT` only when there's genuinely nothing saved to check (object doesn't exist yet, or its type has no `/source/main`). Omitted for `mode=activate`, the saved server version is activated with no pre-flight check. For `mode=format`: text to format directly (mutually exclusive with `object` — exactly one of the two, never both, never neither). |
| `corr_nr` | string | no | — | Transport request to activate into (`mode=activate`) or to write into if the reformatted object changed (`mode=format`, object form only — refused with `BAD_INPUT` on the text form, which writes nothing). |
| `affects` | object | no (required to activate an existing `ENHO/XH`/`ENHS/XS`) | — | The object the enhancement binds to. Refused with `BAD_INPUT` for `mode=format`. |
| `objects` | array of `{object, type?, affects?}`, 1–50 entries | no | — | Batch form: activate several objects through ADT's multi-object activation endpoint instead of one call each. Mutually exclusive with `object`/`type`/`affects`/`corr_nr`/`source`, and `mode=activate` only (no batch syntax check, and refused with `BAD_INPUT` for `mode=format`). |

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
fails the batch.

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
uses. Re-read the object to see its state, then settle the entry by hand with
`abap_journal mode=reconcile` once its outcome is established. An
object in a chunk that was never sent at all, because an earlier chunk
failed first, settles `failed`, with an error saying so.

### mode=format: the pretty printer

`abap_activate mode="format"` runs `POST /sap/bc/adt/abapsource/prettyprinter`
— the server's own pretty printer. It formats layout and keyword case
according to the server's own pretty-printer setting (readable, not writable
here, at `GET /sap/bc/adt/abapsource/prettyprinter/settings`); abapsmith
reads that setting implicitly (the server applies it when asked to format)
and never changes it — `setPrettyPrinterSetting` is never called, and no
parameter in this tool reaches it. Observed live on A4H:
`indentation=true style=keywordUpper keepIdentifier=true` (fixture 962) —
this is one system's configuration, not a guarantee about any other; a
differently configured system will format differently.

Two mutually exclusive forms, selected by which of `object`/`source` is
given:

- **Text form** — `{mode:"format", source}`, no `object`. Stateless: the
  given text is posted to the pretty printer and the formatted text comes
  back. No object is resolved, nothing is locked, nothing is written,
  nothing is activated, and no journal entry is made. Gated as read and
  works even when the server is read-only (`ABAP_MODE=read`). Refuses
  `corr_nr` with `BAD_INPUT`, since there is nothing to write into.
- **Object form** — `{mode:"format", object, type?}`, no `source`. Reads
  the object's saved source, runs it through the same endpoint, and
  compares the result byte-for-byte against what was read. If the
  formatted text is identical, the response reports `changed: false` and
  stops there — no lock, no PUT, no activation, no journal entry, a pure
  read. If the bytes differ, abapsmith computes an etag from the source as
  read and writes the formatted text back through the ordinary
  `abap_write` path with `expect_etag` set to that etag and
  `activate: true` — the same lock, PUT, activate, journal sequence any
  other write goes through. Setting `expect_etag` from the source as read
  closes the read-format-write race: if the object changed on the server
  between the read and the write, the write is rejected with
  `ETAG_CONFLICT` instead of silently overwriting someone else's edit. A
  successful object-form format is journalled and undoable through
  `abap_journal mode=undo`, exactly like any other write.

CRLF line endings in the pretty printer's own response are normalised to LF
before the changed-bytes comparison (fixtures 963 and 964 were both
captured with a CRLF response body) — this is an artefact of the wire
format, not a claim about the object's own line endings.

**Refusals** (`abapActivateFormat`, `src/tools/activate.ts`):

| Input | Result |
|---|---|
| Both `object` and `source` given | `BAD_INPUT` — exactly one, never both. |
| Neither `object` nor `source` given | `BAD_INPUT` — exactly one, never neither. |
| `affects` given | `BAD_INPUT` — not applicable to formatting. |
| `objects` (batch) given | `BAD_INPUT` — no batch form for `mode=format`. |
| `corr_nr` given with the text form | `BAD_INPUT` — the text form writes nothing. |
| `object` does not exist | `NOT_FOUND`. |
| `object` resolves to a properties-shape DDIC type with no ABAP source | `UNSUPPORTED` — there is no source to pretty-print. |

**Evidence.** `live` (A4H, 2026-09-12): the wire protocol itself — the
format request/response shape, keyword-case and layout rewriting, and the
idempotent `changed: false` case (fixtures 963, 964), plus the
system-wide setting read (fixture 962). Still not verified live: the object
form's full write-back path (lock, PUT, activate, journal entry) and the
entire refusal matrix above — both are covered only by
`test/activate-format.test.ts` against an in-process fake ADT server, never
exercised end-to-end against a live system.

Example (text form):

```json
{
  "mode": "format",
  "source": "CLASS zcl_demo DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS run.\nENDCLASS.\nCLASS zcl_demo IMPLEMENTATION.\n  METHOD run.\n  data lv_x type i. lv_x = 1.\n  ENDMETHOD.\nENDCLASS."
}
```

Example (object form):

```json
{
  "mode": "format",
  "object": "ZCL_DEMO_ORDER",
  "type": "CLAS/OC"
}
```

