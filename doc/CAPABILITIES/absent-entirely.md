## Absent entirely

Things a reader might expect and will not find here:

- BOPF configuration/customizing — no read surface and no write surface of
  any kind, no modelling, no operation, no refusal message, just absence.
- RAP draft handling — not implemented at all.
- ATC exemption creation and check-variant creation — deliberately absent:
  an agent that can request an ATC exemption is an agent that can silence a
  finding instead of fixing it.
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
- Creating custom IMG nodes or activities, and generating a maintenance
  dialog (SE54) — `abap_img` navigates the structure only, and
  `abap_img_edit` writes rows, not nodes or dialogs.
- Maintaining a customizing entry through the view's own SM30-generated
  table-maintenance function module — its foreign-key checks, fixed-value
  checks, and table-maintenance-generator events — is still absent, and for a
  specific reason: that function module needs the view's field catalogue
  and dynamic row layout supplied by the caller, and nothing established
  how to build those outside the SM30 dialog itself. Guessing at that shape
  would have produced generated code that looks faithful and is wrong in
  ways this server cannot detect, so `abap_img_edit` writes the resolved
  base table directly instead — a guarded `MODIFY`/`DELETE`, recorded on a
  transport through the same CTS calls SM30 itself uses, but without the
  view's own validation running.
