## Absent entirely

Things a reader might expect and will not find here:

- BOPF configuration/customizing — no read surface and no write surface of
  any kind, no modelling, no operation, no refusal message, just absence.
- RAP draft handling — not implemented at all.
- Source-text search — `abap_search` covers object names and where-used
  only, never source content.
- ATC exemption creation and check-variant creation — deliberately absent:
  an agent that can request an ATC exemption is an agent that can silence a
  finding instead of fixing it.
- ABAP Unit coverage measurement — never requested.
- Test authoring through `abap_test` — the tool runs existing tests; it does
  not write or delete them.
- Web Dynpro, FPM and Fiori UI automation — `abap_ui` drives classic dynpro
  only.
- Writing debugger variables — the underlying set-value verb is left
  unexposed by deliberate design.
- Deactivation of an activated object — ADT itself has no deactivate
  operation, so nothing here can offer one.
- ABAP Messaging Channels (`SAMC`) and ABAP Push Channels (`SAPC`) — config XML
  at `uc_object_type_group/{samc|sapc}`; vendor Accept header, `/source/main` is
  asXML not ABAP text; fits neither `abap_read` nor `format: "raw"` (unverified
  write shape). Probed A4H 2026-09-04, omitted.
