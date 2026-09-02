# OData `$metadata` fixtures — **all SYNTHETIC**

Every file in this directory is **hand-written**, not captured. None of it is a
recording of an ADT or OData wire response, and none of it may be presented as
one. Each file also says `SYNTHETIC` in a comment inside itself, so a file that
gets copied out of this directory still carries the label.

## Why there is no live capture here

The A4H appliance this project verifies against went down (logon refused,
HTTP 500) before any OData work could reach it, so no real service binding was
created, no real catalogue lookup was made, and no real EDMX was fetched. The
probe that still needs to be run, once the appliance is back: create a real
OData service binding, perform the catalogue lookup against it, and capture
the live EDMX it returns.

There is a second, permanent reason for the V4 files specifically: this
appliance is SAP_BASIS 754 and **has no OData V4 binding type at all**.
`/sap/bc/adt/businessservices/bindings/bindingtypes` answers with exactly two
entries, both `ODATA`/`V2`, differing only by category (recorded in the
`SRVB/SVB` entry of `src/adt/capabilities.ts`). No V4 binding can be created
there, so no V4 `$metadata` can ever be captured from it, and the V4 branches
of `src/adt/edmx.ts` are INFERENCE from the OASIS OData 4.0 CSDL specification
by construction rather than by accident.

## What each file is for

| file | dialect | exercises |
| --- | --- | --- |
| `SYNTHETIC-v2-metadata.xml` | OData V2 | `sap:` capability attributes on `EntitySet` and `Property`; keys; `MaxLength`/`Precision`/`Scale` facets; navigation resolved through `<Association>`/`<End>` (the indirection that is most of the value of parsing V2); a `FunctionImport` with `m:HttpMethod="POST"`; a **dangling** navigation whose `Relationship` has no association, so the unresolved path is covered. |
| `SYNTHETIC-v4-metadata.xml` | OData V4 | `Capabilities.*Restrictions` records **inline** on one `EntitySet` and in an **external** `<Annotations Target="…">` block for another; `Common.Label`; `NavigationProperty Type="Collection(…)"`; `TopSupported="false"`; an `Action`/`ActionImport` pair and a **bound** `Action` with no import. Aliases are deliberately non-obvious (`Cap.`, `Lbl.`) so that matching on the term's local name is what makes it work. |
| `SYNTHETIC-service-binding.xml` | — | The ADT service binding document: `published`, the `services`/`content`/`serviceDefinition` ingredients, and the `atom:link rel="http://www.sap.com/categories/odatav2"` that names the catalogue endpoint. |
| `SYNTHETIC-service-catalogue.xml` | — | The ADT OData catalogue response: `serviceUrl` given as an **absolute** URL, which is the shape the parser must reduce to a path so the host never reaches a log or an error. |
| `SYNTHETIC-service-binding-unpublished.xml` | — | The same binding with `published="false"` and no catalogue link — the state an agent gets stuck in most often, and the one that must produce `SERVICE_NOT_PUBLISHED` with the publish instruction rather than a generic failure. |

Hostnames in these files are `sap.invalid`, which is reserved by RFC 2606 and
resolves nowhere. No real host, user, client or password appears in any of them.
