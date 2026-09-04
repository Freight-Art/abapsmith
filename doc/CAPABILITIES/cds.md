## CDS

| Entity | Create | Read | Update | Delete | Activate | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DDL source (`DDLS/DF`) | yes | yes | yes | yes | yes | live | Full source read and write through the ordinary object path. |
| Metadata extension (`DDLX/EX`) | yes | yes | yes | yes | yes | live | Same path as any source object. |
| Access control (`DCLS/DL`) | yes | yes | yes | yes | yes | live | Source read and write through the ordinary object path; create and delete are live-verified. |
| Annotation definition (`DDLA/ADF`) | no | yes | yes | no | yes | live | Source read and write through the ordinary object path; create is refused by the server (SAP-only object type), delete unverified. |

CDS support is the ordinary source object path and carries no CDS-specific
modelling: abapsmith writes the DDL text, and the server does the rest.
