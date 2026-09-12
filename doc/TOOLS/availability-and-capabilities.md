# Availability & capabilities — read this once

Two independent things gate a tool: whether it appears in `tools/list` at
all, and whether a given call is refused at runtime. This page is about the
**v1** tool surface (`ABAP_TOOL_SURFACE=v1`, the default) — v1 tool names
throughout. See
[TOOL-SURFACE-V2/README.md](../TOOL-SURFACE-V2/README.md) for how v2
answers the same questions; it is structurally different, not just a
renaming, so its rules are not repeated here. A v1 tool falls into exactly
one of four cases:

1. **Registration-gated — absent from `tools/list` entirely.** The
   registrar for these tools is only called when a capability is on; when it
   is off the tool does not exist as far as a client can see, it is not
   present-and-refusing. `abap_data_preview` needs `canPreviewData`, with no
   stub of any kind standing in for it (its gate is the out-of-band
   `ABAP_ALLOW_DATA_PREVIEW` flag, not a mode ceiling — see case 4 below for
   why that keeps it out of this server's locked-stub machinery).
   `abap_fluid` needs `cfg.fluidApi && !cfg.readOnly && cfg.abapMode !== "read"`
   (`cfg.canUseFluidApi`, `src/config.ts:1632`, registered at
   `src/server.ts:708-719`); with `ABAP_FLUID_API=false` specifically, that
   holds regardless of mode, and `abap_fluid` (real tool or stub) is absent
   entirely — the one case below does not reach it either, since its stub
   is only offered while `cfg.fluidApi` stays truthy.
2. **Always registered, gated per call.** The tool is always in
   `tools/list`; some or all of its operations are refused at call time
   depending on capability. `abap_read`, `abap_search`, `abap_open_url`,
   `abap_transport` (list/show/check/users are unconditional; create/addUser/
   setOwner/delete need write), `abap_bopf` (pure read), `abap_activate`
   (`mode=check` is unconditional; `mode=activate` needs write),
   `abap_journal` (list/show are unconditional local reads; undo needs
   write), `abap_enh` (`discover_hook_anchors` is a pure read with no gate
   call; every other operation is gated, and `delete` additionally needs
   `ABAP_ALLOW_ENHANCEMENT_DELETE`), `abap_debug`/`abap_debug_vars`/
   `abap_debug_value` (stack/frame/status/keepalive/stop are ungated;
   start/step need write) all fall here.
3. **Schema-varies, not registration.** `abap_dumps` is always registered.
   Its `variables` field is advertised in the JSON Schema only when
   `ABAP_ALLOW_DUMP_VARIABLES` is on, but the handler enforces the same
   permission on every call regardless of whether the field was advertised —
   a hand-crafted request for `variables` against an unadvertised schema is
   still refused, not silently honoured.
4. **Registered as a locked stub — listed, self-describing, refuses on
   call, reaches nothing.** (`src/tools/locked.ts`, issue #63.) On a v1
   server that is read-only end to end (`cfg.readOnly === true`), the tools
   whose only ungated mode would otherwise put them in case 1 —
   `abap_write`, `abap_run`, `abap_test`, `abap_atc`, `abap_quick_fix`,
   `abap_ui`, `abap_fpm_read`, `abap_img_edit`, `abap_bopf_test`,
   `abap_bopf_edit`, `abap_bopf_delete`, `abap_transport_release`, and
   `abap_fluid` (only while `ABAP_FLUID_API` stays on — see case 1 above
   for when it drops out even here) — are **not** skipped. Each is
   registered under its real name with an empty input schema (no
   parameters to validate or advertise) and a description stating it is
   LOCKED, why, and which `ABAP_MODE` unlocks it. Calling one returns a
   structured `READ_ONLY` refusal: `"<tool> is registered but locked at
   this permission level. ABAP_MODE=read does not grant writes. Nothing was
   sent to the SAP system."`, a hint naming the unlocking mode (`Set
   ABAP_MODE=edit.`; `admin` for `abap_transport_release`), and details
   `{tool, locked: true, abapMode, requiresMode, capabilities}`. The
   handler holds no pool, connection or `SafetyGate` reference at all — it
   is structurally as incapable of reaching SAP as an absent tool would be;
   only what a read-only server can *say* about these tools changed, not
   what it can *do*. `test/mode-locked-tools.test.ts` pins that the v1
   tool-*name* set is now identical between `read` and `admin` mode (given
   the same out-of-band flags), specifically so a newly added write-gated
   tool cannot silently repeat the old "tool not found" gap; the same suite
   also pins that a read-mode `tools/list` is still strictly smaller in
   bytes than admin's, since a locked stub's schema carries no parameters.
   Before this, a caller asking for one of these on a read-only server got
   `MCP error -32602: Tool <name> not found` — indistinguishable from a
   typo, with no hint that raising `ABAP_MODE` was the fix; that gap is
   what this case closes. v2 has no equivalent of this case: `abap_do`
   already answers "what would unlock this" structurally through each
   action's `minMode`, and `abap_write` stays genuinely absent from v2's
   `tools/list` under `read` mode (v2's own case 1).

Capabilities come from `ABAP_MODE` (`read` \| `edit` \| `admin`, resolved by
`capabilitiesForMode()` in `src/mode.ts`) plus independent opt-in flags that
layer on top:

| Capability | Granted by |
|---|---|
| `canWrite` | `ABAP_MODE=edit` or `admin` (legacy: `ABAP_ALLOW_WRITE=true`) |
| activate | same as `canWrite` — `mode=edit`/`admin` also grants activation |
| transports (create/addUser/setOwner/delete) | same as `canWrite` |
| `canReleaseTransport` | `ABAP_MODE=admin` by default, or `edit` mode with the explicit override (legacy: `ABAP_ALLOW_TRANSPORT_RELEASE=true`, on top of `ABAP_ALLOW_WRITE=true`) |
| enhancement writes (create/hook/set_impl_active) | `ABAP_MODE=edit` or `admin` (legacy: `ABAP_ALLOW_ENHANCEMENTS=true`) |
| enhancement `delete` | `ABAP_MODE=admin`, or `edit` mode with the explicit override (legacy: `ABAP_ALLOW_ENHANCEMENT_DELETE=true`, in addition to enhancements being on) |
| `canPreviewData` | `ABAP_ALLOW_DATA_PREVIEW=true` — independent of mode, allowed even under `read` |
| `variables` field on `abap_dumps` | `ABAP_ALLOW_DUMP_VARIABLES=true` — independent of mode, allowed even under `read` |
| `abap_ui` `mode=press` | `ABAP_MODE=admin` **and** `ABAP_ALLOW_UI_PRESS=true`, checked at call time, not at registration |
| `step="jumpToLine"` on `abap_debug` | `ABAP_ALLOW_DEBUG_JUMP_TO_LINE=true` **and** a per-call `confirm:"jumpToLine"` |
| `abap_fluid` registered as the real tool (vs. a locked stub, case 4 above) | `ABAP_FLUID_API=true` (default) **and** `cfg.readOnly === false` **and** `ABAP_MODE !== "read"` — all three checked at registration, and re-checked at call time by `fluidDisabledReason` (`src/adt/fluid/enabled.ts:18-39`) |

Every mutating call is additionally checked against `ABAP_ALLOW_PACKAGES`
and `ABAP_ALLOW_NAME_PREFIXES` (which packages/object names a write may
touch), and against a productive-system lockout that no flag overrides.

`ABAP_FLUID_API=false` reaches past `abap_fluid`'s own registration: it also
refuses the bridge-backed operations of several already-shipped tools at
call time — see
[CONFIGURATION/permissions-and-allowlists.md](../CONFIGURATION/permissions-and-allowlists.md)
for the full list.

Once registered, every `abap_fluid` op re-checks four further ceilings that
are only knowable after `connect()` has run its role probe (a productive
system, its system role, a failed role probe, and the write-lockout latch) —
see [SAFETY/permission-model.md](../SAFETY/permission-model.md) for the
exact fields and their order. The per-op ceilings `ABAP_ALLOW_FLUID_PLUGINS`,
`ABAP_ALLOW_FLUID_PLUGIN_MUTATE` and `ABAP_ALLOW_FLUID_CALL_FM` are
documented in
[CONFIGURATION/permissions-and-allowlists.md](../CONFIGURATION/permissions-and-allowlists.md).
`abap_fluid` is additive: no existing tool's availability changed, no tool
was hidden, renamed or unregistered, and `ABAP_TOOL_SURFACE` is unchanged.
(This predates case 4 above and describes `abap_fluid`'s own introduction,
not the locked-stub mechanism — that one genuinely does put a new
registration under an existing tool's name on a read-only v1 server.)

