# Tool reference

Full parameter reference for every MCP tool this server registers, split into
one file per tool or tool family so a reader can load just the part they
need. For a one-line-per-tool overview, see the table in the top-level
README; these files are the detail it links to. Ground truth for every table
below is the Zod input schema in `src/tools/*.ts` — parameter names, types,
requiredness and defaults are taken from the schema, not from prose.

## Contents

| File | Covers |
|---|---|
| [availability-and-capabilities.md](availability-and-capabilities.md) | Read this once: how registration-gating differs from per-call gating, and the full `ABAP_MODE`/capability-flag table every other file refers back to. |
| [read-and-search.md](read-and-search.md) | `abap_read`, `abap_search`, `abap_open_url` — reading and locating ABAP objects. |
| [abap-service.md](abap-service.md) | `abap_service` — reading the OData contract (EDMX) behind a RAP service binding. |
| [write-and-activate.md](write-and-activate.md) | `abap_write`, `abap_activate` — creating, changing, deleting and activating ABAP objects. |
| [execute-and-test.md](execute-and-test.md) | `abap_run`, `abap_test` — headless execution and ABAP Unit. |
| [abap-atc.md](abap-atc.md) | `abap_atc` — ABAP Test Cockpit static analysis, including the wire-protocol grounding notes. |
| [abap-quick-fix.md](abap-quick-fix.md) | `abap_quick_fix` — applying ADT position-driven quick fixes as a gated, journalled write, including the wire-protocol grounding notes. |
| [transports.md](transports.md) | `abap_transport`, `abap_transport_release` — inspecting, creating and releasing CTS transport requests. |
| [journal.md](journal.md) | `abap_journal` — listing, inspecting and undoing writes this server has made. |
| [debugger.md](debugger.md) | `abap_debug`, `abap_debug_vars`, `abap_debug_value` — the ABAP debugger driver and variable inspection. |
| [diagnostics.md](diagnostics.md) | `abap_dumps`, `abap_data_preview` — reading ST22 short dumps and previewing DDIC table/view rows. |
| [bopf.md](bopf.md) | `abap_bopf`, `abap_bopf_edit`, `abap_bopf_delete`, `abap_bopf_test` — reading, editing, deleting and exercising BOPF business objects. |
| [enhancements.md](enhancements.md) | `abap_enh` — creating and driving BAdI spots, implementations, filters and hooks. |
| [ui-and-fpm.md](ui-and-fpm.md) | `abap_fpm_read`, `abap_ui` — reading FPM/FBI configuration and driving classic dynpro screens via batch input. |
| [system-resource.md](system-resource.md) | The `abap://{SID}/system` MCP resource. |
