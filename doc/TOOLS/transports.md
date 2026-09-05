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
notes on the response call this out. CTS can refuse the underlying call
outright: observed live for a `R3TR TABL` deletion entry (a DDIC table
created and then deleted under the same request), where
`TR_DELETE_COMM_OBJECT_KEYS` returns a non-zero `sy-subrc` and the entry and
its lock stay. The resulting `CHECK_FAILED` error carries a `msg=` fragment
with that `sy-subrc` and, when CTS set one, the `sy-msg*` T100 message (it
can legitimately be blank), plus a hint naming the remaining manual route:
SE03 "Unlock Objects (Expert Tool)" for the request, then delete the entry in
SE09/SE10; or release the request (irreversible). There is no route through
abapsmith that clears this kind of entry — see
`doc/LIMITATIONS/not-implemented-and-unproven.md`.

Example (dry-run delete):

```json
{ "operation": "delete", "transport": "A4HK900123" }
```

## abap_transport_release

Release a transport request. Irreversible — a released request cannot be
recalled and its changes leave this system.

**Availability**: case 1 — registered only when `canReleaseTransport`
(`ABAP_MODE=admin` by default, or `edit` mode with the explicit override
`ABAP_ALLOW_TRANSPORT_RELEASE=true`; legacy path: that same var plus
`ABAP_ALLOW_WRITE=true`). Split into its own tool deliberately, so the one
irreversible verb is not reachable by enum-fuzzing `abap_transport`.

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

