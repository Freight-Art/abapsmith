# abap_service

Read the **OData contract** generated behind a RAP service binding (SRVB):
entity sets, key fields, property types and facets, navigation, and the
capability annotations that say which sets may be created, updated, deleted,
searched and paged. Both OData V2 and V4.

**Availability**: case 2 — always registered, unconditional. Three GETs, no
lock, nothing created; `read` is always allowed by the safety gate, so no
per-call gate is imposed that would misrepresent this as a ceiling.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `binding` | string | yes | — | Service binding (SRVB) name. Not the CDS view and not the SRVD. |
| `mode` | enum `contract` \| `entity` \| `raw` | no | `contract` | Compressed contract summary, one entity set expanded, or the EDMX verbatim. |
| `entity` | string | no | — | Entity set or entity type to expand. Required for `mode=entity`; the set name and the type name both resolve. |

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

## The failure you will actually hit

An **unpublished** binding is the common case, not a mistake in the call: the
SRVB exists and is activated, but nothing was ever generated behind
`/sap/opu/odata`, so there is no `$metadata` to read. That returns
`SERVICE_NOT_PUBLISHED`, names the publish step, and states plainly that this
server will not perform it — publishing is a write, out of scope for a read
tool. Retrying cannot change the answer.

The other three are distinguished on purpose, none folded into a generic
fallback: `SERVICE_METADATA_DENIED` (401/403 — a missing `S_SERVICE`
authorization or an inactive SICF node; deliberately **not** `AUTH_FAILED`,
which would trip the auth circuit breaker over a per-service problem),
`SERVICE_METADATA_NOT_FOUND` (404 at the runtime path despite a published
catalogue entry — not a spelling problem), and
`SERVICE_METADATA_UNPARSEABLE` (the body was not EDMX, e.g. an HTML logon
page; the error carries an excerpt of what actually arrived).

## V2 vs V4 is detected, not guessed

Three independent signals are read: the binding's declared version, the
catalogue link relation, and the EDMX document's own self-description
(`edmx:Edmx@Version`, then `m:DataServiceVersion`, then the structural
tell — an `<Association>` element means V2, a typed `<NavigationProperty>`
means V4). The document wins, because it is the bytes being parsed. A
disagreement between the three is **reported**, not resolved away.

