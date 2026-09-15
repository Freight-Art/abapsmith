# OData `$metadata` fixtures

The `SYNTHETIC-*.xml` files in this directory are **hand-written**, not
captured — each still says `SYNTHETIC` in a comment inside itself, so a copy
made from this directory still carries the label. They exist to exercise
edge cases the live services below do not have, such as a dangling
navigation `Relationship` with no association, and an external
`Annotations Target=…` block. For what the wire actually looks like, see
`test/fixtures/live-captured/` captures `965`–`970` (below).

## Live captures now exist

A4H (SAP_BASIS 754) is reachable, and the full OData service-contract chain
— service binding → ADT catalogue → `$metadata` — was captured byte-exact
from it on 2026-09-15, for both OData V2 and OData V4. The captures live in
`test/fixtures/live-captured/`, described in that directory's `INDEX.md` and
listed in `ledger.tsv`:

| n | file | proves |
| --- | --- | --- |
| `965` | `965-i82-service-binding-v2.xml` | ADT service binding document for `/DMO/UI_TRAVEL_U_V2` (OData V2) |
| `966` | `966-i82-service-catalogue-v2.xml` | ADT OData V2 catalogue lookup for the same service |
| `967` | `967-i82-metadata-v2.xml` | the real OData V2 `$metadata` EDMX for the same service |
| `968` | `968-i82-service-binding-v4.xml` | ADT service binding document for `/DMO/UI_TRAVEL_O4_CD` (OData V4) |
| `969` | `969-i82-service-catalogue-v4.xml` | ADT OData V4 catalogue lookup for the same service |
| `970` | `970-i82-metadata-v4.xml` | the real OData V4 `$metadata` EDMX for the same service |

Three things this project previously got wrong or left unverified are now
settled by those captures:

- **The binding resource needs the v2 media type.** `GET
  /sap/bc/adt/businessservices/bindings/{name}` with a v1-only Accept header
  answers `406 ExceptionResourceNotAcceptable`; the request must carry
  `application/vnd.sap.adt.businessservices.servicebinding.v2+xml` (see
  `965` and `968`).
- **A4H does have OData V4 service bindings.** This directory's README used
  to claim the appliance "has no OData V4 binding type at all," reasoning
  from `/sap/bc/adt/businessservices/bindings/bindingtypes` listing only
  `ODATA`/`V2`. That claim was wrong: this appliance has V4 bindings,
  including `/DMO/API_TRAVEL_U_V4`, `/DMO/UI_TRAVEL_D_D_O4` and
  `/DMO/UI_TRAVEL_O4_CD` (`srvb:binding srvb:version="V4"`); `968` reads the
  binding document for the last of these, and `969`/`970` complete its
  catalogue lookup and `$metadata` fetch.
- **Both the V2 and V4 `$metadata` documents are fetchable, and were
  fetched.** `967` and `970` are the real EDMX bytes, not fixtures inferred
  from documentation.

`969` also settles a shape question: the V4 catalogue's root element is
`odatav4:serviceGroup`, with `published="true"` as a root attribute, not a
`serviceList` with a `published` attribute per service the way the V2
catalogue (`966`) is shaped.

Not covered: no publish or unpublish request was made against the
appliance, so the publish job's own wire bytes remain unverified. See the
`test/fixtures/live-captured/INDEX.md` entry for these captures for the
full detail, including the disagreement between `965`'s
`srvb:allowedAction="PUBLISH"` and `966`'s `allowedAction="UNPUBLISH"` for
the same service.

## What each `SYNTHETIC-*.xml` file is for

| file | dialect | exercises |
| --- | --- | --- |
| `SYNTHETIC-v2-metadata.xml` | OData V2 | `sap:` capability attributes on `EntitySet` and `Property`; keys; `MaxLength`/`Precision`/`Scale` facets; navigation resolved through `<Association>`/`<End>` (the indirection that is most of the value of parsing V2); a `FunctionImport` with `m:HttpMethod="POST"`; a **dangling** navigation whose `Relationship` has no association, so the unresolved path is covered. |
| `SYNTHETIC-v4-metadata.xml` | OData V4 | `Capabilities.*Restrictions` records **inline** on one `EntitySet` and in an **external** `<Annotations Target="…">` block for another; `Common.Label`; `NavigationProperty Type="Collection(…)"`; `TopSupported="false"`; an `Action`/`ActionImport` pair and a **bound** `Action` with no import. Aliases are deliberately non-obvious (`Cap.`, `Lbl.`) so that matching on the term's local name is what makes it work. |
| `SYNTHETIC-service-binding.xml` | — | The ADT service binding document: `published`, the `services`/`content`/`serviceDefinition` ingredients, and the `atom:link rel="http://www.sap.com/categories/odatav2"` that names the catalogue endpoint. |
| `SYNTHETIC-service-catalogue.xml` | — | The ADT OData catalogue response: `serviceUrl` given as an **absolute** URL, which is the shape the parser must reduce to a path so the host never reaches a log or an error. |
| `SYNTHETIC-service-binding-unpublished.xml` | — | The same binding with `published="false"` and no catalogue link — the state an agent gets stuck in most often, and the one that must produce `SERVICE_NOT_PUBLISHED` with the publish instruction rather than a generic failure. |

These edge cases (the dangling navigation, the external annotation block,
the absolute `serviceUrl`, the unpublished binding) do not occur in the six
live services above, which is why the synthetic files stay: they are still
hand-written, still exercise cases the live captures do not, and are still
labelled `SYNTHETIC` both in this table and inside each file.

Hostnames in these files are `sap.invalid`, which is reserved by RFC 2606
and resolves nowhere. No real host, user, client or password appears in any
of them.
