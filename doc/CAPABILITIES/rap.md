## RAP

| Entity | Create | Read | Update | Delete | Activate | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Behavior definition (`BDEF/BDO`) | yes | yes | yes | yes | yes | live | Delete works; a blank source read no longer counts as proof the object is there. See the [object row notes](object-types.md#object-row-notes). |
| Behavior implementation class | yes | yes | yes | yes | yes | live | An ordinary `CLAS/OC`; nothing knows it is a behavior pool. |
| Service definition (`SRVD/SRV`) | yes | yes | yes | yes | yes | live | Ordinary source object. |
| Service binding (`SRVB/SVB`) | yes | partial | yes | yes | yes | live | Read needs `format: "raw"`. |
| Service publication | no | n/a | n/a | n/a | n/a | n/a | Structurally refused, not merely unimplemented. |
| OData metadata read (`abap_service`) | n/a | yes | n/a | n/a | n/a | tests | Every fixture is synthetic. See below. |
| Business data over the service | no | no | no | no | n/a | n/a | Structurally refused. |
| Draft handling | no | no | no | no | no | unverified | Not implemented at all. |

- The chain a user walks is DDL source, behavior definition, behavior pool
  class, service definition, service binding — and then publication, which is
  a human step abapsmith will not take.
- Publication and business-data access are refused structurally, not by
  policy: the only runtime URL the stack can build ends in `$metadata`, and
  the runtime GET takes no query string, so there is no entity-row,
  `$filter`, or `$batch` URL to build. An unpublished binding reports that it
  is unpublished and names the publishing step without performing it.
- **A source-comment correction the reader needs.** `src/adt/odata.ts` and
  `src/adt/edmx.ts` describe their OData V2 path as live-verified against a
  live system, citing the live-capture fixture directory. That directory
  contains no EDMX, no `$metadata`, and no service-binding capture. The test
  suite for the same code states plainly that every fixture it reads is
  synthetic and that no live capture exists, and the OData fixture directory
  says the same. Graded `tests` here accordingly. The V4 half is a further
  step removed: the reference system has no V4 binding type at all, so V4
  handling is inference from the specification.
- `doc/TOOLS/abap-service.md` presents V2 and V4 as equally supported, and
  `doc/LIMITATIONS/not-implemented-and-unproven.md` does not list OData in its unproven section — a known
  documentation gap, noted here rather than fixed there.
