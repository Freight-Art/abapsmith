# The v2 tool surface

**Status: experimental. Not supported for production use.** v2 exists for
exploration — trying the consolidated surface, low-stakes / non-production
sessions — nothing more. Known v2 defects — an error envelope that drops
failure detail, a search schema overclaiming free-text search, and hint
text naming v1-only tools a v2 client cannot call — are not being fixed
while it holds this status: fixing them would not bring v2 to parity with
v1 (see "Why v2 stayed opt-in" below). `v1` is the supported surface and
the recommended default for anything that matters.

The server ships two MCP tool surfaces. `ABAP_TOOL_SURFACE` selects which one
a running process registers — `"v1"` (default, supported) or `"v2"`
(experimental, opt-in, not for production). Exactly one surface is ever
active per process — no value registers both, since v2 reuses several v1
tool names and dual registration would fail at startup with a
duplicate-tool error.

v1 is 22 narrow tools, one per operation (a few gated behind capability flags
— `abap_transport_release` needs release capability granted, `abap_ui`,
`abap_data_preview` and the write-shaped tools need write mode). v2
consolidates the same functionality into six:

| Tool | Purpose |
|---|---|
| `abap_find` | Search — repository objects, where-used, BOPF business objects, FPM configs, transports |
| `abap_read` | Read one object — source, outline, method body, public contract, BOPF node detail, FPM config |
| `abap_write` | Mutate one object — targeted string splice, whole-method replace, full rewrite, delete, or `dry_run` a preview of any of those |
| `abap_do` | Everything verb-shaped: activate/check/run/test, journal list/show/undo, transport lifecycle, BOPF model edits, enhancement/BAdI operations |
| `abap_debug` | The step debugger — start/step/stack/frame/vars/value/keepalive/stop/status |
| `abap_adt` | Raw ADT REST escape hatch, GET-only |

`abap_write` is registered only in `edit`/`admin` mode — `read`-mode v2 exposes five tools, not six.

## v1 to v2 mapping

| v1 tool | v2 route |
|---|---|
| `abap_search` | `abap_find` (default kind, `where: repository \| usages`) |
| `abap_bopf` | `abap_find` (`kind: "bo"`) / `abap_read` (`view: "bopf"`) / `abap_do` (`bopf_check_refs`) |
| `abap_bopf_edit` | `abap_do` — `bopf_create`, `bopf_add_node`, `bopf_remove_node`, `bopf_add_association`, `bopf_remove_association`, `bopf_add_action`, `bopf_remove_action`, `bopf_add_determination`, `bopf_remove_determination`, `bopf_add_validation`, `bopf_remove_validation`, `bopf_add_query`, `bopf_remove_query`, `bopf_add_alternative_key`, `bopf_remove_alternative_key`, `bopf_set_node_flags`, `bopf_set_association_fields`, `bopf_set_action_fields`, `bopf_set_determination_fields`, `bopf_set_validation_fields`, `bopf_set_query_fields`, `bopf_set_alternative_key_fields`, `bopf_activate` |
| `abap_bopf_delete` | `abap_do` (`bopf_delete`) |
| `abap_bopf_test` | `abap_do` (`bopf_test`) |
| `abap_fpm_read` | `abap_find` (`kind: "fpm"`) / `abap_read` (`view: "fpm"`) |
| `abap_read` | `abap_read` (`view: source \| method \| outline \| contract \| metadata`) |
| `abap_write` | `abap_write` (`edit` splice, `method` replace, `source` rewrite, `mode: "delete"`, `dry_run` preview) |
| `abap_activate` | `abap_do` (`activate`, `check`) |
| `abap_run` | `abap_do` (`run`) |
| `abap_test` | `abap_do` (`test`) |
| `abap_journal` | `abap_do` (`journal_list`, `journal_show`, `undo`) |
| `abap_transport` | `abap_do` (`transport_list`, `transport_show`, `transport_check`, `transport_users`, `transport_create`, `transport_add_user`, `transport_set_owner`, `transport_delete`) |
| `abap_transport_release` | `abap_do` (`transport_release`) |
| `abap_enh` | `abap_do` (`enh_write_description`, `enh_create_spot`, `enh_add_badi_def`, `enh_add_filter_def`, `enh_create_impl`, `enh_set_filter_values`, `enh_exercise`, `enh_discover_hook_anchors`, `enh_create_hook`) |
| `abap_debug` | `abap_debug` (`start`, `step`, `stack`, `keepalive`, `stop`, `status`) |
| `abap_debug_vars` | `abap_debug` (`action: "vars"`) |
| `abap_debug_value` | `abap_debug` (`action: "value"`) |
| `abap_data_preview` | **no v2 route** |
| `abap_open_url` | **no v2 route** |
| `abap_dumps` | **no v2 route** |
| `abap_ui` | **no v2 route** |
| *(none — new in v2)* | `abap_debug` (`action: "frame"` — move the read cursor to a different stack frame; read-only) |
| *(none — new in v2)* | `abap_adt` (raw GET against any `/sap/bc/adt/*` path; non-GET verbs are refused structurally, in every mode, because the safety gate has no way to authorize a mutation against a bare path) |

Four v1 tools have **no** v2 equivalent — `abap_data_preview` (data
preview), `abap_open_url` (browser-URL lookup), `abap_dumps` (dump reading),
`abap_ui` (classic-screen driving) — with no fallback route through the
other six tools.

## Why v2 stayed opt-in

Twenty-some narrow schemas cost real context: every tool's schema is resent
each turn, so tool count taxes the context window and, past some threshold,
the model's tool-picking accuracy. Six tools cuts that considerably — the
combined schema is 87.6% smaller than the twenty-some-tool surface it
replaces.

That schema saving is not, by itself, the deciding factor: v2 is newer and
less exercised than v1, and its known defects (see the status note above)
are argument-handling issues — a wide `z.string()`/`z.record()` field
accepting values its schema advertises but its runtime does not implement,
plus object-type disambiguation. v2 stays opt-in, and `v1` stays the
default, until v2 demonstrates the same reliability as v1 in day-to-day use.
Fixing only the known defects listed above would not by itself be enough to
close that gap.

## When v2 is worth trying anyway

v2's trade-offs point the other way in some workload shapes: when prompt
caching is off, unavailable, or ineffective (a smaller schema matters more
against list-price input); when context, not cost, is the binding
constraint; when many agents share one process (the schema saving scales
with agent count); or for read-only / search-heavy work, where
`abap_find`/`abap_read` hold up best and v2's errors — concentrated in
writes and object-type resolution — matter least.

## What is identical either way

The safety gate and write journal behave identically under both surfaces.
Every v2 handler that mutates state reshapes its call into the exact input a
v1 zod schema already validates, then calls the same core function v1's own
registrar calls — same `SafetyGate.assert`, same journal write. A refused
write or undo costs zero requests under v2 for the same reason as v1:
reshaping and the gate both run before any network call is possible. The
mode ladder, package allowlists, and productive-system lockout behave the
same regardless of surface.
