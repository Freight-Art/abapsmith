## CDS

| Entity | Create | Read | Update | Delete | Activate | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DDL source (`DDLS/DF`) | yes | yes | yes | yes | yes | live | Full source read and write through the ordinary object path. |
| Metadata extension (`DDLX/EX`) | yes | yes | yes | yes | yes | live | Same path as any source object. |
| Access control (`DCLS/DL`) | yes | yes | yes | yes | yes | live | Source read and write through the ordinary object path; create and delete are live-verified. |
| Annotation definition (`DDLA/ADF`) | no | yes | yes | no | yes | live | Source read and write through the ordinary object path; create is refused by the server (SAP-only object type), delete unverified. |
| CDS lineage (`abap_read view=lineage`) | n/a | yes | n/a | n/a | n/a | mixed | `DDLS/DF` only, optional `field` to trace one column to its base columns; `depth` default 5, max 10 — refused (`BAD_INPUT`), never clamped, above the max. Built by reading and parsing each view's own DDL text (`src/adt/cds-lineage.ts`), not from ADT's `graphdata` dependency-graph endpoint — that endpoint nests transitively and was captured live (981), but carries no association edges and no field lineage, and refused every customer view tried with `NoDependencyGraphDataCalculationPossible` (982); see [doc/LIMITATIONS/cds-lineage.md](../LIMITATIONS/cds-lineage.md) for the full finding. The DDL parser/tree builder is `tests`: exercised offline against captures 976-980 (five real customer and standard CDS views — consumption view over another view, base-table leaf with field aliases, a `UNION` of two views, a left outer join, and unexposed associations referenced only inside an expression). `with parameters` and `extend view` parsing has no capture exercising either shape. The assembled `abap_read view=lineage` MCP call itself is `unverified` end to end — the reference server runs a previously released bundle that predates this feature, and no live run is anticipated until it ships. |

CDS support is the ordinary source object path and carries no CDS-specific
modelling: abapsmith writes the DDL text, and the server does the rest.
