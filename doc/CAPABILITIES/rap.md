## RAP

| Entity | Create | Read | Update | Delete | Activate | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Behavior definition (`BDEF/BDO`) | yes | yes | yes | yes | yes | live | Delete works; a blank source read no longer counts as proof the object is there. See the [object row notes](object-types.md#object-row-notes). |
| Behavior implementation class | yes | yes | yes | yes | yes | live | An ordinary `CLAS/OC`; nothing knows it is a behavior pool. |
| Service definition (`SRVD/SRV`) | yes | yes | yes | yes | yes | live | Ordinary source object. |
| Service binding (`SRVB/SVB`) | yes | partial | yes | yes | yes | live | Read needs `format: "raw"`. |
| Service publication | yes | n/a | n/a | yes | n/a | tests | Gated on `ABAP_MODE=admin` (or legacy `ABAP_ALLOW_SERVICE_PUBLISH=true`) plus a `confirm` echo of the binding name; without `confirm` the call is a dry run. `op="publish"` (Create) POSTs the ADT publish job, `op="unpublish"` (Delete) reverses it — the POST itself is unit-tested against fakes, not executed against the reference system. |
| OData metadata read (`abap_service`) | n/a | yes | n/a | n/a | n/a | live | Live-verified for both V2 and V4: binding → catalogue → `$metadata` captured against A4H, client 001, 2026-09-15 (fixtures 965–970). See below. |
| Business data over the service | no | no | no | no | n/a | n/a | Structurally refused. |
| Draft handling | no | no | no | no | no | unverified | Not implemented at all. |

- The chain a user walks is DDL source, behavior definition, behavior pool
  class, service definition, service binding, and then publication —
  `abap_service op="publish"`, gated behind the admin-only
  `allowServicePublish` ceiling and a `confirm` echo of the binding name. See
  [doc/TOOLS/abap-service.md](../TOOLS/abap-service.md).
- Business-data access is refused structurally, not by policy: the only
  runtime URL the stack can build ends in `$metadata`, and the runtime GET
  takes no query string, so there is no entity-row, `$filter`, or `$batch`
  URL to build.
- Publication is no longer refused structurally. `op="publish"` and
  `op="unpublish"` are gated the way `abap_transport operation="release"` is:
  the admin-only `allowServicePublish` ceiling (`ABAP_MODE=admin`, or legacy
  `ABAP_ALLOW_SERVICE_PUBLISH=true`), plus a `confirm` echo of the binding
  name — without it the call is a dry run that changes nothing. A productive
  system, or one that could not be proven non-productive, still refuses it
  with no override, like every other mutation. An `op="read"` against an
  unpublished binding still reports `SERVICE_NOT_PUBLISHED` and names the
  publish step rather than performing it on its own.
- The `allowServicePublish` ceiling is not the only gate a publish has to
  clear: the binding is itself the object the safety gate judges, so it also
  has to pass the same SAP-namespace check and package allowlist
  (`ABAP_ALLOW_PACKAGES`) as any other write. A4H's demo bindings
  (`/DMO/UI_TRAVEL_U_V2` and the rest) live in the SAP namespace and are
  refused there even under `ABAP_MODE=admin`; only a `Z*`/`Y*` binding in an
  allowlisted package can be published through this tool. See
  [doc/TOOLS/abap-service.md](../TOOLS/abap-service.md) for the check order
  and the exact refusal each case produces.
- **The source-comment correction this file used to carry is resolved.**
  `src/adt/odata.ts` and `src/adt/edmx.ts` used to describe their OData V2
  path as live-verified while no V2 capture actually existed, and separately
  claimed the reference system has no V4 binding type at all — also false:
  A4H has three V4 service bindings (`/DMO/API_TRAVEL_U_V4`,
  `/DMO/UI_TRAVEL_D_D_O4`, `/DMO/UI_TRAVEL_O4_CD`). The two claims were wrong
  in opposite directions — one claimed evidence that did not exist, the
  other denied a capability that did. Both the V2 and the V4 chain are now
  captured live (see the table row above and fixtures 965–970), so the
  source comments and this note are corrected together; the current grades
  can be trusted.
- `doc/TOOLS/abap-service.md` documents the publish/unpublish parameters,
  the gate, the `confirm` echo, the dry run, the journal entries and the new
  `SERVICE_PUBLISH_FAILED` error code.
  `doc/LIMITATIONS/not-implemented-and-unproven.md` carries the one
  remaining gap: the publish/unpublish POST itself has never been executed
  against a live system.
