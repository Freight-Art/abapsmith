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
| [rap.md](rap.md) | `abap_rap` — generating a complete RAP stack (CDS views, behavior definitions, class, service definition, service binding) from an existing table. |
| [write-and-activate.md](write-and-activate.md) | `abap_write`, `abap_activate` — creating, changing, deleting and activating ABAP objects. |
| [function-modules.md](function-modules.md) | `abap_write`/`abap_read` on `FUGR/F`/`FUGR/FF`/`FUGR/I` — the group's transport request and `remote_enabled`. |
| [execute-and-test.md](execute-and-test.md) | `abap_run`, `abap_test` — headless execution and ABAP Unit. |
| [abap-atc.md](abap-atc.md) | `abap_atc` — ABAP Test Cockpit static analysis, including the wire-protocol grounding notes. |
| [abap-quick-fix.md](abap-quick-fix.md) | `abap_quick_fix` — applying ADT position-driven quick fixes as a gated, journalled write, including the wire-protocol grounding notes. |
| [transports.md](transports.md) | `abap_transport`, `abap_transport_release` — inspecting, creating and releasing CTS transport requests. |
| [journal.md](journal.md) | `abap_journal` — listing, inspecting and undoing writes this server has made. |
| [debugger.md](debugger.md) | `abap_debug`, `abap_debug_vars`, `abap_debug_value` — the ABAP debugger driver and variable inspection. |
| [diagnostics.md](diagnostics.md) | `abap_dumps`, `abap_data_preview` — reading ST22 short dumps and previewing DDIC table/view rows. |
| [abap-trace.md](abap-trace.md) | `abap_trace` — ABAP runtime trace (SAT) over ADT: starting, running, listing, reading and deleting traces and trace requests, plus the SQL-trace (`db` view) it folds in. |
| [abap-img.md](abap-img.md) | `abap_img` — navigating the IMG (SPRO) customizing structure read-only: activities, nodes, and the views and tables behind them. |
| [abap-img-edit.md](abap-img-edit.md) | `abap_img_edit` — writing IMG (SPRO) customizing rows behind a resolved maintenance object, and creating the customizing request to record them on. |
| [bopf.md](bopf.md) | `abap_bopf`, `abap_bopf_edit`, `abap_bopf_delete`, `abap_bopf_test` — reading, editing, deleting and exercising BOPF business objects. |
| [enhancements.md](enhancements.md) | `abap_enh` — creating and driving BAdI spots, implementations, filters and hooks. |
| [ui-and-fpm.md](ui-and-fpm.md) | `abap_fpm_read`, `abap_ui` — reading FPM/FBI configuration and driving classic dynpro screens via batch input. |
| [system-resource.md](system-resource.md) | The `abap://{SID}/system` MCP resource. |
| [abap-fluid.md](abap-fluid.md) | `abap_fluid` — the single entry point to the fluid API: deploying and running generated ABAP tools that install into `$ABAPSMITH_FLUID_API`. |

## The `system` parameter

With [more than one system configured](../CONFIGURATION/multi-system.md),
every tool in this reference gains one more, optional parameter not
listed in the tables below: `system`, naming which configured system's
alias the call targets. It is omitted from every per-tool table in this
folder because it is not specific to any one tool — it behaves identically
everywhere it appears, so it is documented once, here, instead of being
repeated in each file.

`system` accepts one of the configured aliases (the same string used as
the key in `ABAP_SYSTEMS`'s `systems` map, or in
`ABAP_SYSTEM_<ALIAS>_*`). Omitting it targets the default system. Naming
an alias that is not configured is refused with `UNKNOWN_SYSTEM`, listing
the aliases that actually are. **On a single-system server, `system` is not
in any tool's schema at all** — the parameter only exists once there is
more than one system to choose between, so a single-system deployment's
tool schemas, `tools/list` output and context cost are byte-for-byte what
they were before this feature existed.

`system` selects which system's connection, session pool and permission
gate a call runs against — see
[SAFETY/permission-model.md](../SAFETY/permission-model.md#the-mode-ladder-is-per-system)
for how the permission decision is made per call rather than process-wide,
and
[CONCURRENCY/multi-system-pools.md](../CONCURRENCY/multi-system-pools.md)
for what is isolated per system versus what stays a single, process-wide
resource (the debugger lane, in particular — see
[debugger.md](debugger.md#system_mismatch-one-debug-session-for-the-whole-process)).
`abap_read`'s `view="diff"` additionally has its own pair of
system-naming parameters, `from_system`/`to_system`, for comparing an
object ACROSS two systems in one call rather than targeting one system for
the whole call — see
[read-and-search.md](read-and-search.md#viewdiff-same-system-versions-and-cross-system-comparison).
