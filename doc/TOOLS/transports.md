# Transports

## abap_transport

Inspect and manage CTS transport requests.

**Availability**: case 2 — always registered. `list`/`show`/`check`/`users`
are unconditional; `create`/`addUser`/`setOwner`/`delete` need `canWrite`
and are refused at call time otherwise. `create` additionally checks
`package` against the same allowlist ordinary object writes use.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `operation` | enum `list` \| `show` \| `check` \| `users` \| `create` \| `addUser` \| `setOwner` \| `delete` | yes | — | Operation to perform. |
| `transport` | string | required for `show`/`addUser`/`setOwner`/`delete` | — | Transport request number. |
| `user` | string | no (required for `addUser`/`setOwner`) | — | SAP user name; for `list`, whose requests to show. |
| `object` | string | required for `check` | — | Object to check. |
| `package` | string | required for `create` | — | Package (development class) for the new request. |
| `description` | string (max 60 chars) | required for `create` | — | Short text for the new request. |
| `confirm` | string | no (required to actually delete) | — | Echo `transport` exactly (case-insensitive, trimmed) to arm `delete`. Without it, `delete` is a dry run that shows the request's contents. |

Notes: ordinary object writes never need this tool — the server creates and
reuses one transport request per session automatically. `delete` is
irreversible once confirmed; the confirm value must match the transport
number exactly, not partially.

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
parent's task list or its status doesn't settle anything either way.

