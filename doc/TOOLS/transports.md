# Transports

## abap_transport

Inspect and manage CTS transport requests.

**Availability**: case 2 — always registered. `list`/`show`/`check`/`users`
are unconditional; `create`/`addUser`/`setOwner`/`delete`/`removeObject` need
`canWrite` and are refused at call time otherwise. `create` additionally
checks `package` against the same allowlist ordinary object writes use;
`delete` and `removeObject` additionally need the admin-only transport-delete
ceiling (`ABAP_MODE=admin` — no legacy flag grants it) plus `confirm`.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `operation` | enum `list` \| `show` \| `check` \| `users` \| `create` \| `addUser` \| `setOwner` \| `delete` \| `removeObject` | yes | — | Operation to perform. |
| `transport` | string | required for `show`/`addUser`/`setOwner`/`delete`/`removeObject` | — | Transport request number. |
| `user` | string | no (required for `addUser`/`setOwner`) | — | SAP user name; for `list`, whose requests to show. |
| `object` | string | required for `check`/`removeObject` | — | Object to check (`check`) or remove the entry for (`removeObject`). |
| `package` | string | required for `create` | — | Package (development class) for the new request. |
| `description` | string (max 60 chars) | required for `create` | — | Short text for the new request. |
| `confirm` | string | no (required to actually delete or removeObject) | — | Echo `transport` exactly (case-insensitive, trimmed) to arm `delete`/`removeObject`. Without it, `delete` is a dry run that shows the request's contents; `removeObject` refuses outright (BAD_INPUT). |

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
because E071's key is TRKORR+AS4POS, not object identity, so creating an
object and then deleting it under the same request records two rows for it.
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

