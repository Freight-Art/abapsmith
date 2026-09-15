# abap_service

Read the **OData contract** generated behind a RAP service binding (SRVB):
entity sets, key fields, property types and facets, navigation, and the
capability annotations that say which sets may be created, updated, deleted,
searched and paged. Both OData V2 and V4 — both are now live-verified for
reading, not just asserted equal: see "V2 vs V4 is detected, not guessed"
below for the fixtures. The same tool also publishes and unpublishes the
binding itself.

**Availability**: case 2 — always registered, unconditional. `op="read"` is
always allowed by the safety gate: three GETs, no lock, nothing created, so
no per-call gate is imposed that would misrepresent it as a ceiling.
`op="publish"`/`op="unpublish"` are gated per call instead — the tool doesn't
disappear or change shape when the gate is closed, the call is refused with a
reason (see "Publishing and unpublishing" below).

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `binding` | string | yes | — | Service binding (SRVB) name. Not the CDS view and not the SRVD. |
| `op` | enum `read` \| `publish` \| `unpublish` | no | `read` | Which action to perform. |
| `mode` | enum `contract` \| `entity` \| `raw` | no | `contract` | Compressed contract summary, one entity set expanded, or the EDMX verbatim. Applies to the read, including the read that runs automatically after a successful `publish`. |
| `entity` | string | no | — | Entity set or entity type to expand. Required for `mode=entity`; the set name and the type name both resolve. |
| `confirm` | string | no | — | `op="publish"`/`op="unpublish"` only. Must echo `binding` exactly, or the call fails with `BAD_INPUT`. Omitted entirely, the call runs as a **dry run**: nothing changes on the server, the response reports what would happen. Ignored for `op="read"`. |

## It cannot read entity data, and that is structural

There is no mode, parameter or flag that returns business rows: the URL
builder can only ever produce a `…/$metadata` path — asserted by a regex at
two independent layers, the runtime GET takes no query-string parameter at
all, and `.` is excluded from the path character class so `..` cannot be used
to build a different one. Entity CRUD was rejected outright for this server
(parity item P-40): reading and writing business data over OData is a
different product from an ADT development tool.

## How a binding name becomes a `$metadata` URL

The binding document alone is not enough. It carries the ingredients — the
service name, the service version, the service-definition name — and a link
to an ADT service catalogue, but not the runtime URL. So:

1. `GET /sap/bc/adt/businessservices/bindings/<name>` — the binding document.
2. `GET` the catalogue named by the binding's own link, with those
   ingredients as query parameters. This answers with the authoritative
   service URL and the published flag.
3. `GET <service>/$metadata` on `/sap/opu/odata*`, which is a **separate ICF
   hierarchy** from `/sap/bc/adt` — a working ADT session is not by itself
   evidence that this path is reachable.

The absolute URL the catalogue returns is reduced to a path at that
boundary, so the system's host name cannot reach a log, an error message or
a response.

For `op="publish"`/`op="unpublish"`, this chain grows: the same
binding-then-catalogue read runs first (to learn V2 vs V4 and the
servicename/serviceversion to publish), then the POST, then — for
`op="publish"` only — the catalogue and `$metadata` are read again to build
the response. A successful publish is five requests in total: binding,
catalogue (pre-read), POST, catalogue, `$metadata`. `op="unpublish"` stops
after the POST — there is nothing left to read `$metadata` from — so it is
three requests: binding, catalogue, POST.

## The failure you will actually hit

An **unpublished** binding is the common case, not a mistake in the call: the
SRVB exists and is activated, but nothing was ever generated behind
`/sap/opu/odata`, so there is no `$metadata` to read. That returns
`SERVICE_NOT_PUBLISHED` and names the publish step — and, when the safety
gate allows it, that step is now `abap_service op="publish"` on this same
tool, not a step abapsmith refuses to take (see "Publishing and unpublishing"
below). Retrying the read cannot change the answer; publishing can.

The other three are distinguished on purpose, none folded into a generic
fallback: `SERVICE_METADATA_DENIED` (401/403 — a missing `S_SERVICE`
authorization or an inactive SICF node; deliberately **not** `AUTH_FAILED`,
which would trip the auth circuit breaker over a per-service problem),
`SERVICE_METADATA_NOT_FOUND` (404 at the runtime path despite a published
catalogue entry — not a spelling problem), and
`SERVICE_METADATA_UNPARSEABLE` (the body was not EDMX, e.g. an HTML logon
page; the error carries an excerpt of what actually arrived). A fourth,
`SERVICE_PUBLISH_FAILED`, belongs to `op="publish"`/`op="unpublish"` only —
see below.

## Publishing and unpublishing

`op="publish"` and `op="unpublish"` are ordinary gated mutations, not a
special case. `op="publish"` is refused unless the safety gate allows it:
the ceiling is `allowServicePublish` — `ABAP_MODE=admin`, or the legacy
`ABAP_ALLOW_SERVICE_PUBLISH=true` — the same tier as
`allowTransportRelease`. Ordinary write access (`ABAP_MODE=edit`) does not
imply it. A productive system, or a system that could not be proven
non-productive, refuses it with no override, like every other mutation.
`op="unpublish"` is gated the same way.

`confirm` must echo `binding` exactly, or the call fails with `BAD_INPUT`.
Omitting `confirm` is not an error: the call runs as a dry run that changes
nothing on the server and reports what it would do — the way to check
before committing.

### Which bindings can actually be published

`allowServicePublish` is not the only check a publish has to clear. The
binding itself is the object `SafetyGate.authorize("write", …, { publish:
true })` judges, so it also has to pass through the same object-level rules
as any other write — checked in `evaluate()` (`src/safety.ts`) in this
order: the `allowServicePublish` ceiling first, then, once that ceiling is
open, the SAP-namespace check, the package allowlist (`ABAP_ALLOW_PACKAGES`),
and the object-name allowlist, exactly as for `abap_write`.

That has a concrete consequence for the reader most likely to try this
first: the demo bindings shipped on a DMO-based appliance —
`/DMO/UI_TRAVEL_U_V2`, `/DMO/API_TRAVEL_U_V4`, `/DMO/UI_TRAVEL_D_D_O4`,
`/DMO/UI_TRAVEL_O4_CD` — all have names starting with `/`, which is a
registered SAP namespace. Two different refusals follow, depending on
`ABAP_MODE`:

- Anything short of `ABAP_MODE=admin` (and no legacy
  `ABAP_ALLOW_SERVICE_PUBLISH=true`): the `allowServicePublish` ceiling is
  closed, so the call is refused before the binding is even looked at —
  `READ_ONLY`, naming the missing ceiling.
- `ABAP_MODE=admin`: the ceiling is open, so the call reaches the
  object-level checks — and is refused there instead, `SAFETY_DENIED`, with
  the reason `<binding> lives in a reserved SAP namespace.` No override
  lifts this; it is the same un-overridable SAP-namespace rule every write
  is subject to.

Either way, none of the four demo bindings can be published through this
tool. Only a customer-namespace binding (`Z*`/`Y*`, or whatever
`ABAP_ALLOW_NAME_PREFIXES` names) that also lives in a package
`ABAP_ALLOW_PACKAGES` permits can pass both the ceiling and the object
rules. This is deliberate, not an oversight: publishing registers an ICF
node under `/sap/opu/odata*`, so the tool must not be able to change what a
system exposes for an object it is not otherwise allowed to write. The same
applies to `op="unpublish"` — it is gated identically.

A confirmed `op="publish"` POSTs the ADT publish job:
`/sap/bc/adt/businessservices/odatav2/publishjobs?servicename=…&serviceversion=…`
for a V2 binding, `/sap/bc/adt/businessservices/odatav4/publishjobs` for a V4
one. This registers an ICF node under `/sap/opu/odata` or `/sap/opu/odata4`
— a change to what the system exposes outside the developer session, which
is why it carries the admin-only ceiling rather than ordinary write access.
It does not move the P-40 boundary above: a published service becomes
reachable at its own runtime path to any HTTP client, but abapsmith's own
URL builder still only ever produces a `…/$metadata` path — publishing gains
abapsmith no way to read entity rows.

It is journalled *before* the POST, as `service-publish`, with
`irreversible: true` — the same way a transport release is. `abap_journal
mode=undo` refuses the entry outright and names the compensating action:
`abap_service op="unpublish"`.

On success, `op="publish"` runs the ordinary `$metadata` read (`mode`
applies here too, default `contract`) and returns the contract alongside the
URL that became reachable — the service's runtime path and its `$metadata`
path. If that follow-up read fails, the publish is still reported as done,
with the read's error attached as a note; the publish itself is not
retried.

`op="unpublish"` mirrors this: journalled as `service-unpublish` with
`irreversible: true`, compensating action `publish`, same gate, same
`confirm` echo, same dry run when `confirm` is omitted. It does not read
`$metadata` afterwards — there is nothing published left to read.

A publish or unpublish that reaches the server and is refused there —
usually an inactive binding or service definition — or that answers with
`severity=error`, returns `SERVICE_PUBLISH_FAILED`.

**Unverified.** The publish and unpublish POSTs themselves have never been
executed against a live system: this session was not authorised to change
the reference appliance's runtime service surface, so the publish path is
covered by unit tests against fakes only. The endpoints are not invented —
`odatav2/publishjobs` appears in A4H's own ADT discovery document, and
`odatav4/publishjobs`/`unpublishjobs` are linked from A4H's live V4 catalogue
document (fixture 969) — but the endpoint existing is not the same claim as
the call having been made and having worked.

## V2 vs V4 is detected, not guessed

Three independent signals are read: the binding's declared version, the
catalogue link relation, and the EDMX document's own self-description
(`edmx:Edmx@Version`, then `m:DataServiceVersion`, then the structural
tell — an `<Association>` element means V2, a typed `<NavigationProperty>`
means V4). The document wins, because it is the bytes being parsed. A
disagreement between the three is **reported**, not resolved away.

Both chains are live-verified end to end, captured against A4H (client 001,
user DEVELOPER, 2026-09-15): the V2 chain through
`/DMO/UI_TRAVEL_U_V2` — binding, catalogue, `$metadata` (124,245 bytes, 27
entity sets), parsed correctly — and the V4 chain through
`/DMO/UI_TRAVEL_O4_CD` — binding, catalogue,
`/sap/opu/odata4/dmo/ui_travel_o4_cd/srvd/dmo/ui_travel_o4_cd/0001/$metadata`
(52,788 bytes, 4 entity sets, 6 actions, draft navigation), also parsed
correctly. Kept as `test/fixtures/live-captured/965`–`970`. Two bugs were
found and fixed doing this: the binding resource answers 406 to the
`servicebinding.v1+xml` media type the code was sending (A4H advertises
`…v2+xml`), and the V4 catalogue's root element is `odatav4:serviceGroup`,
not the `serviceList` the parser looked for — every published V4 service
used to be misreported as `SERVICE_NOT_PUBLISHED`.

Two more live findings worth knowing: `srvb:published` reads `true` on every
binding on this appliance, including ones the catalogue does not report as
published, and `srvb:allowedAction` on the binding document disagrees with
the catalogue (`PUBLISH` vs `UNPUBLISH`) for `/DMO/UI_TRAVEL_U_V2` — so
neither is a reliable published flag; the catalogue document is the one this
tool believes. A4H does have V4 service bindings
(`/DMO/API_TRAVEL_U_V4`, `/DMO/UI_TRAVEL_D_D_O4`, `/DMO/UI_TRAVEL_O4_CD`) —
contrary to an earlier, now-corrected claim elsewhere in this repo that it
has no V4 binding type.

