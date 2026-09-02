# Availability & capabilities — read this once

Two independent things gate a tool: whether it appears in `tools/list` at
all, and whether a given call is refused at runtime. A tool falls into
exactly one of three cases:

1. **Registration-gated — absent from `tools/list` entirely.** The
   registrar for these tools is only called when a capability is on; when it
   is off the tool does not exist as far as a client can see, it is not
   present-and-refusing. `abap_write`, `abap_run`, `abap_test`,
   `abap_fpm_read`, `abap_bopf_test`, `abap_ui`, `abap_atc`, `abap_bopf_edit`
   and `abap_bopf_delete` need `canWrite`; `abap_transport_release` additionally
   needs `canReleaseTransport`; `abap_data_preview` needs `canPreviewData`.
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

Every mutating call is additionally checked against `ABAP_ALLOW_PACKAGES`
and `ABAP_ALLOW_NAME_PREFIXES` (which packages/object names a write may
touch), and against a productive-system lockout that no flag overrides.

