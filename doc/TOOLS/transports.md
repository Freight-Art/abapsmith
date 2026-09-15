# Transports

## abap_transport

Inspect and manage CTS transport requests.

**Availability**: case 2 — always registered. `list`/`show`/`check`/`users`/
`log`/`queue` are unconditional; `create`/`addUser`/`setOwner`/`delete`/
`removeObject` need `canWrite` and are refused at call time otherwise.
`create` additionally checks `package` against the same allowlist ordinary
object writes use, and — for `kind: "copies"` — refuses outright without a
`target`; `delete` and `removeObject` additionally need the admin-only
transport-delete ceiling (`ABAP_MODE=admin` — no legacy flag grants it) plus
`confirm`. `log` and `queue` are plain reads, gated the same as
`list`/`show`/`check`: no admin ceiling, no `confirm`, no dry run, and —
unlike `create`/`addUser`/`setOwner`/`delete`/`removeObject` — neither is
journalled, since neither changes anything on the system.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `operation` | enum `list` \| `show` \| `check` \| `users` \| `create` \| `addUser` \| `setOwner` \| `delete` \| `removeObject` \| `log` \| `queue` | yes | — | Operation to perform. |
| `transport` | string | required for `show`/`addUser`/`setOwner`/`delete`/`removeObject`/`log` | — | Transport request number. |
| `user` | string | no (required for `addUser`/`setOwner`) | — | SAP user name; for `list`, whose requests to show. |
| `object` | string | required for `check`/`removeObject` | — | Object to check (`check`) or remove the entry for (`removeObject`). |
| `package` | string | required for `create` | — | Package (development class) for the new request. |
| `description` | string (max 60 chars) | required for `create` | — | Short text for the new request. |
| `kind` | enum `workbench` \| `copies` | no | `workbench` | Kind of request `create` makes. `copies` makes a transport of copies (see below) and needs `target`. |
| `target` | string | required for `create` when `kind="copies"` | — | Target system for a transport of copies, e.g. `QAS`. Refused without one: a transport of copies with no target cannot be imported anywhere, so abapsmith does not create one. |
| `system` | string | required for `queue` | — | Target system whose import queue (TMS buffer) to read, e.g. `QAS`. |
| `domain` | string | no | — | TMS transport domain, for `queue` only, e.g. `DOMAIN_A4H`. TMS resolves the local domain when omitted. |
| `confirm` | string | no (required to actually delete or removeObject) | — | Echo `transport` exactly (case-insensitive, trimmed) to arm `delete`/`removeObject`. Without it, `delete` is a dry run that shows the request's contents; `removeObject` refuses outright (BAD_INPUT). |

`users` returns the connected system's user list — a candidate list to pick
a user from for `addUser`/`setOwner` — not the request's own task owners.
Read `show`'s `TASKS` table for who actually owns which task.

Notes: ordinary object writes never need this tool — the server creates and
reuses one transport request per session automatically. `delete` is
irreversible once confirmed; the confirm value must match the transport
number exactly, not partially. A `TRANSPORT_LOCKED` refusal can be
permanent: see below.

`removeObject` drops one object's entry (and its CTS lock) from a request or
task — typically an object already deleted from the system, so the holding
request can then itself be deleted; it accepts either a request or a task
number and resolves the actual holder itself. It does not prove the request
becomes deletable — follow up with `delete` to find out. The response's
`objectOnSystem` (`present` | `absent` | `unknown`) says whether the named
object still existed at the moment the entry was removed: removing the entry
drops the CTS lock unconditionally, so a `present` result means a still-live
object just lost the lock that recorded its change and protected it from
being edited under a different request — the object itself is untouched, but
notes on the response call this out.

CTS refuses the underlying call outright when the request's object list
holds two or more E071 rows for the object's PGMID+OBJECT+OBJ_NAME — legal
because E071's key is TRKORR+AS4POS, not object identity. Duplicates have
been observed live, but not reliably produced: a request holding a create
and a delete of the same class, tried live on A4H on 2026-09-12, held one
row, not two, and `removeObject` removed it cleanly (`removedCount: 1`).
`TR_DELETE_COMM_OBJECT_KEYS` (by way of `TRINT_DELETE_COMM_OBJECT_KEYS`)
counts those rows before touching anything and raises `w_duplicate_entry`
(`MESSAGE e292(tr)`) at two or more; exactly one row is the only case that
proceeds. The bridge counts the same rows itself before calling the
function module, so it refuses up front rather than removing one row and
leaving the operation to fail on the next — this surfaces as the terminal
error code `CTS_DUPLICATE_ENTRY`, whose message names the object, the
holder, the row count and the AS4POS values, and whose hint explains the
guard and the manual remedy. A late `TR 292` from the function module itself
maps to the same code. Any other refusal in this family still comes back as
`CHECK_FAILED`, with a `msg=` fragment carrying the `sy-subrc` and, when CTS
set one, the `sy-msg*` T100 message (it can legitimately be blank).

SE03's "Unlock Objects (Expert Tool)" does **not** fix a duplicate-entry
refusal: it clears CTS's TLOCK row and lockflag, not E071 rows, and the
refusal is driven by the E071 row count, not the lock. The only route out is
outside abapsmith: edit the request's object list in SE09/SE10 so at most
one row remains for the object, then retry `removeObject`; or release the
request (irreversible) — neither is something abapsmith can verify will
succeed under a lock. See `doc/LIMITATIONS/not-implemented-and-unproven.md`.

Journalling follows what the ABAP transcript actually proves. `removeObject`
is journalled as `transport-remove-object`; a refusal from
the ABAP side like `CTS_DUPLICATE_ENTRY` that removed nothing is now recorded
straight away with outcome `failed` (description suffixed `— refused,
nothing was removed`), not left `pending` — the transcript names no removed
E071 row, so there is nothing to be unsure about. (A `NOT_FOUND` for an
object that is not on the request comes from the pre-check, before any
journal entry is opened, so it records nothing at all.) Only a removal that
touched at least one row before failing partway through the loop, or a call
whose response was lost entirely (dropped connection, HTTP failure — the
ABAP may have run and answered into thin air), stays `pending` for a human
to resolve with `abap_journal mode=reconcile` once the real outcome is
known — see [doc/JOURNAL/undo-and-recovery.md](../JOURNAL/undo-and-recovery.md#pending-entries-stranded-and-reconcile).

Example (dry-run delete):

```json
{ "operation": "delete", "transport": "A4HK900123" }
```

### `createdByAbapsmith`

`operation=show`, and the `abap_transport_release` dry run, report a
`createdByAbapsmith` header field instead of the old `createdThisSession:
yes|no`. It is resolved in this order:

- No session-ownership record was given to the call — the field is
  omitted entirely. Unchanged from before: the check is opt-in, and a
  direct caller that supplies none gets no claim at all.
- This server process created the request, per its own in-memory record —
  `yes (this server process)`.
- Otherwise the write journal is read for a `transport-create` entry
  filed under the request number — or, when the call named a task number
  that CTS resolved to its parent, under either that task number or the
  parent's — whose `systemKey` matches the connected system and whose
  outcome is not `failed`:
  - Found — `yes (journal entry <id>)`.
  - Journal on, nothing found — `no (not this process; no journal entry
    on <SID>)`.
  - Journal off (`ABAP_JOURNAL=off`) — `unknown — the journal is off`.
  - Journal unreadable — `unknown — the journal could not be read`.
  - No journal supplied to the call — `unknown — no journal was supplied
    to this call`.

This matters because the old note came from process memory alone: a host
that starts a fresh server per call, or any restart, reported every
request abapsmith itself had created as one it did not create. The
journal outlives the process; the in-memory record does not.

Journal evidence does not change what `abap_transport_release`'s
ownership gate checks: the `BAD_INPUT` refusal that demands
`confirm_unowned` still counts only requests created by the running
server process. A request with journal evidence but no in-process record
is reported as `yes (journal entry ...)` and still needs
`confirm_unowned` to be released — both the `show` note and the dry-run
note say so. That split is deliberate: reporting can rely on a record
written earlier, but an irreversible act asks the caller to confirm in
the process that performs it.

Two things deliberately do not count as evidence: a `transport-create`
entry with no `systemKey` (journal directories are namespaced per SID
only, so an entry that does not name its box cannot prove it is this
one), and a `failed` `transport-create` entry (it records a create that
did not land).

### Task type

The `TASKS` table on `operation=show`, and on the release dry run's own
`TASKS` table, gains a `type` column: the raw `tm:type` exactly as CTS
sent it. A details response usually spells it out
(`Development/Correction`, `Unclassified`); the one-letter TRFUNCTION
form is glossed inline instead — `S (development/correction)`, `R
(repair)`, `Q (customizing task)`, `X (unclassified task)`. An empty
value reads `(none)`. No mapping from the spelled-out form back to a
letter is attempted, because the server's exact wording per type is not
established here.

This is what lets `abap_img_edit create_request`'s `taskType: Q` be
checked afterward: until now, `show`'s task list carried number, owner
and status only, with no way to confirm the type of the task that was
created.

When the caller names a task number, CTS answers about its parent
request, and the substitution header (`requested` / `answeredAbout` /
`requestedStatus`) now also carries `requestedType`, the named task's own
type — `not known` when the task is not among the parsed tasks, the same
fallback `requestedStatus` uses.

### Transport of copies

`create` with `kind: "copies"` makes a transport of copies instead of an
ordinary workbench request. It carries a **snapshot** of the named objects
to a `target` system: the originals stay modifiable in this system, under
their own original request, which the copy leaves untouched. A transport of
copies has **no tasks** — there is nothing to add a user to, so `addUser` on
one fails: ADT answers HTTP 400, `TRANSPORT_ERROR "I::000"`,
`exceptionType: ADT_TM_COMMON_EXCEPTION`. Recognise that shape as "wrong
request kind for this verb," not a generic transport error.

`target` is required for `kind: "copies"` and the create is refused without
it — a transport of copies with no target cannot be imported anywhere, so
abapsmith does not create one.

Wire path: `TR_INSERT_REQUEST_WITH_TASKS` with `IV_TYPE='T'`,
`IV_TARGET=<target>`, called through the fluid `classic` bridge (body class
`ZCL_ZMCP_FLUID_CLASSIC`), not ADT — a `<TRFUNCTION>` posted to
`/sap/bc/adt/cts/transports` is silently ignored and the request reads back
as `tm:type="K"` regardless, so ADT cannot create this kind at all (see
`src/adt/customizing-request.ts`).

Gate: identical to ordinary `create` — needs `canWrite`, checks `package`
against the same allowlist, and refuses a `$`-package — and it IS
journalled, as `transport-create`, the same as a workbench request.

Live-proven (A4H, client 001, user DEVELOPER, 2026-09-15):
`TR_INSERT_REQUEST_WITH_TASKS` with `IV_TYPE='T'`, `IV_TARGET='A4H'` really
created request A4HK900168 — `TRFUNCTION='T'`, `TRSTATUS='D'`,
`TARSYSTEM='A4H'`, zero task headers. `operation="show"` rendered it as
`kind: transport-of-copies`, `target: A4H (A4H)`. The request was deleted
again afterwards with `operation="delete"`, which also works on a transport
of copies. **Not proven**: importing a transport of copies into a target
system — i.e. that the snapshot semantics above actually hold once the copy
lands downstream — has never been exercised, since A4H has no downstream
target system to import into. See
[doc/LIMITATIONS/not-implemented-and-unproven.md](../LIMITATIONS/not-implemented-and-unproven.md).

Unrelated quirk noticed while proving this: a request created through the
ordinary ADT `create` path reports `target: no target (local-only system)`
even though TMS does know this system (`A4H`, domain `DOMAIN_A4H`) — ADT's
own request representation just doesn't carry a target for that kind of
request, copies or not.

### Reading the transport log (`operation: "log"`)

Reads a request's transport log: an overview row per target system
(`TRINT_GET_LOG_OVERVIEW`) plus, per system, the `tp` log lines themselves
(`TRINT_GET_LOG_FILE`). Both run through the fluid `classic` bridge, same as
above — the corresponding ADT URLs were never probed and are deliberately
not guessed.

Input: `transport` (the existing field; no new parameter for this op).

`TRINT_GET_LOG_OVERVIEW` answers `sy-subrc 0` even for a request number that
does not exist at all (tried live with `A4HK999999`), returning the same
plausible-looking row as for a real one. abapsmith therefore checks E070
itself before calling it and returns `NOT_FOUND` for a request that isn't
there — this precheck is why the op can be trusted for "does this request
exist," not just for what its log says.

Live-proven (A4H, 2026-09-15): the overview returned one row for every
request kind tried — released, modifiable, task, and a transport of copies
alike — `SYSNAM=DEV`, empty system text, empty RC, `RCTXT="Not yet flagged
for import"`, `MODDATE=00000000`, `MODTIME=000000`. **Not proven**: any
actual log line content. `TRINT_GET_LOG_FILE` returned zero rows for every
request and system tried, because `tp` has never run on this box — A4H is a
single-system landscape with no transport route, so nothing has ever
actually exported. The detail path is exercised only by unit tests against
a fake. Evidence: `mixed`.

### Reading the import queue (`operation: "queue"`)

Reads a target system's TMS import queue — the import buffer
(`TMS_MGR_READ_TRANSPORT_QUEUE`, reading `TMSBUFFER`). Same bridge, same
reasoning as `log` above.

Inputs: `system` (required — the target system, e.g. `QAS`) and `domain`
(optional TMS transport domain, e.g. `DOMAIN_A4H`; TMS resolves the local
domain when omitted).

**The queue is the import buffer, not an import history.** A request that
has already been imported has LEFT the buffer — its absence from `queue`
does not prove the change never arrived. Pair `queue` (what's waiting) with
`log` (what happened) to answer "did my change reach `QAS`?"

Live-proven (A4H, 2026-09-15): `TMS_MGR_READ_TRANSPORT_QUEUE` for `A4H` /
`DOMAIN_A4H` returned `sy-subrc 0` with an EMPTY buffer (zero rows) and a
collection timestamp — nothing has ever been exported from this system. For
a system name TMS does not know (`DEV`, which the transport-route config
table TCESYST still names as a phantom target but TMS's own `TMSCSYS` does
not) it returned `READ_CONFIG_FAILED` with an empty message; abapsmith maps
that to `NOT_FOUND` with a hint that the system is not in this system's TMS
configuration. **Not proven**: a non-empty queue, and the rendering of its
entries — a request has never actually been exported from A4H to observe
this with. That path is exercised only by unit tests. Evidence: `mixed`.

abapsmith deliberately stops at reading the queue: there is no operation to
trigger an import from it. See
[doc/LIMITATIONS/not-implemented-and-unproven.md](../LIMITATIONS/not-implemented-and-unproven.md)
for the reasoning.

## abap_transport_release

Release a transport request. Irreversible — a released request cannot be
recalled and its changes leave this system.

**Availability**: the real, functional tool needs `canReleaseTransport`
(`ABAP_MODE=admin` by default, or `edit` mode with the explicit override
`ABAP_ALLOW_TRANSPORT_RELEASE=true`; legacy path: that same var plus
`ABAP_ALLOW_WRITE=true`). Without it, a read-only v1 server registers a
mode-locked refusal stub under the same name instead of skipping
registration (case 4 in
[availability-and-capabilities.md](availability-and-capabilities.md));
its remediation names `ABAP_MODE=admin` specifically, not `edit`, since
`edit` alone still would not grant release. Split into its own tool
deliberately, so the one irreversible verb is not reachable by
enum-fuzzing `abap_transport`.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `transport` | string | yes | — | Transport request to release. |
| `confirm` | string | no (required to actually release) | — | Echo `transport` exactly to arm the release. Omitted = dry run that shows the request's contents and releases nothing. |

Example (armed release):

```json
{ "transport": "A4HK900123", "confirm": "A4HK900123" }
```

Notes: the dry run's `releasePermitted` is this server's own policy ceiling
and nothing else — it does not predict whether CTS will accept the release.
`releaseBlockedBy` appears only when a modifiable task under the request
holds objects, since that is the condition that actually raises TR/732; a
modifiable task holding no objects is not a blocker and is called out in its
own note instead. Releasing a task number is verified from the task's own
row in the parent request's re-read, since CTS resolves a GET of a task
number to its parent — so a task release now returns a real
`released`/`not released` verdict when that row settles it, and
`COULD NOT VERIFY` remains the answer when the row is missing from the
parent's task list or its status doesn't settle anything either way. For a
task release, `requestedStatus`/`requestedStatusAfter` are the task's own
readings and are what to trust; `parentStatusBefore`/`parentStatusAfter`
describe the parent request instead, and can still read Modifiable after the
task itself released cleanly. `outcome` for a task release is derived from
that same row, so it never reads `unknown` next to a confirmed release.

