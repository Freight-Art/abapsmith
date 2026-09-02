## CDS

| Entity | Create | Read | Update | Delete | Activate | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DDL source (`DDLS/DF`) | yes | yes | yes | yes | yes | live | Full source read and write through the ordinary object path. |
| Metadata extension (`DDLX/EX`) | yes | yes | yes | yes | yes | live | Same path as any source object. |
| Access control (`DCLS`) | no | no | no | no | no | n/a | Not in the registry, not in the type table, not referenced anywhere in the tree. |
| Annotation definition (`DDLA`) | no | no | no | no | no | n/a | Same. |

CDS support is the ordinary source object path and carries no CDS-specific
modelling: abapsmith writes the DDL text, and the server does the rest.
