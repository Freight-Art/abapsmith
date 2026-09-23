# Permissions & allowlists

`ABAP_MODE` sets the ceiling on what a session may do; the allowlists below
narrow *where* it may do it. The two work together — the mode ladder's
"Package default" column and the package allowlist govern the same
decision from opposite directions.

## Permissions

| Variable | Default | Effect |
|---|---|---|
| `ABAP_MODE` | unset | `read` \| `edit` \| `admin`. The single-variable permission default — an absolute ceiling only under `read`; see below. |
| `ABAP_ALLOW_WRITE` | `false` | Legacy: enables write/delete/activate/run. Ignored (with a startup warning) once `ABAP_MODE` is set. |
| `ABAP_ALLOW_TRANSPORT_RELEASE` | `false` | Releasing a transport request. Legacy lever when `ABAP_MODE` is unset; under `ABAP_MODE` it's a live two-way override — defaults to admin-only, but an explicit value wins either direction. |
| `ABAP_ALLOW_ENHANCEMENTS` | `false` | Enhancement read/edit/activate/delete master switch. Legacy lever when `ABAP_MODE` is unset; under `ABAP_MODE` it's a live two-way override — defaults on from `edit` upward, but an explicit value wins either direction. |
| `ABAP_ENHANCE_TARGETS` | `none` | `none` \| `customer` \| `sap` — which *affected* objects an enhancement write may target. Legacy lever when `ABAP_MODE` is unset; under `ABAP_MODE` it's a live override that replaces the mode's own default (`customer` for `edit`, `sap` for `admin`) outright, in either direction — an `edit` operator may widen to `sap`, an `admin` operator may narrow to `customer` or `none`. Explicitly empty (`ABAP_ENHANCE_TARGETS=`) is a config-time error naming the three legal values, not a silent alias for `none` — unlike the list-shaped allowlists below, this enum already has `none` as an explicit spelling for deny-all. |
| `ABAP_ALLOW_SOURCE_PLUGINS` | `false` | Creating `enhoxhh` source-code-plugin hooks. Legacy lever when `ABAP_MODE` is unset; under `ABAP_MODE` it's a live two-way override — defaults on from `edit` upward (not admin-only), but an explicit value wins either direction. |
| `ABAP_ALLOW_ENHANCEMENT_DELETE` | `false` | Deleting an existing enhancement object outright. Legacy lever when `ABAP_MODE` is unset; under `ABAP_MODE` it's a live two-way override — defaults to admin-only, but an explicit value wins either direction. |
| `ABAP_ALLOW_TRANSPORT_DELETE` | `false` | Deleting a transport request outright (distinct from releasing one). New variable — previously this capability was reachable only via `ABAP_MODE=admin`, with no legacy lever at all. Now works standalone when `ABAP_MODE` is unset; under `ABAP_MODE` it's a live two-way override — defaults to admin-only, but an explicit value wins either direction. |
| `ABAP_ALLOW_SERVICE_PUBLISH` | `false` | `abap_service` `op="publish"`/`op="unpublish"` — registering or removing the ICF node behind a RAP service binding. Legacy lever when `ABAP_MODE` is unset; under `ABAP_MODE` it's a live two-way override — defaults to admin-only, but an explicit value wins either direction. Ordinary write access (`ABAP_MODE=edit`) does not imply it, the same tier as `ABAP_ALLOW_TRANSPORT_RELEASE`. Each call additionally needs a matching per-call `confirm` echo of the binding name; without it the call is a dry run. |
| `ABAP_ALLOW_CASCADE_DELETE` | `false` | The BOPF cascading DDIC delete sweep. New variable — previously this capability was reachable only via `ABAP_MODE=admin`, with no legacy lever at all. Now works standalone when `ABAP_MODE` is unset; under `ABAP_MODE` it's a live two-way override — defaults to admin-only, but an explicit value wins either direction. |
| `ABAP_ALLOW_DEBUG_JUMP_TO_LINE` | `false` | Debugger `jumpToLine`: a forced jump that skips statements (and any checks they would have run). Not governed by `ABAP_MODE` — no mode, including `admin`, grants it; this variable is the only lever, in every mode. |
| `ABAP_ALLOW_DATA_PREVIEW` | `false` | Registers `abap_data_preview` at all. Off means the tool does not exist in `tools/list`. Not governed by `ABAP_MODE` — on in every mode when set, including `read`. |
| `ABAP_ALLOW_DUMP_VARIABLES` | `false` | Lets `abap_dumps` return the variable-contents chapter of a runtime-error dump. Not governed by `ABAP_MODE`. |
| `ABAP_ALLOW_UI_PRESS` | `false` | Lets `abap_ui` submit a batch-input script that commits immediately. Requires `ABAP_MODE=admin` as well — neither alone is sufficient. |
| `ABAP_ALLOW_FLUID_PLUGINS` | `false` | Ceiling for loading any `ABAP_FLUID_PLUGINS` entry at all. Out-of-band: does not widen `ABAP_MODE`, and setting it cannot make a productive or write-locked-out system writable. |
| `ABAP_ALLOW_FLUID_PLUGIN_MUTATE` | `false` | Allows a loaded fluid plugin action whose category is `mutate`. Not implied by `ABAP_ALLOW_FLUID_PLUGINS`. Same out-of-band ceiling — does not widen `ABAP_MODE`, and cannot make a productive or write-locked-out system writable. Also enforced at plugin load time: a source scan (`scanFluidCapabilities`, `src/adt/fluid/static-review.ts`) refuses to load any plugin object whose ABAP contains a database write (`UPDATE`/`INSERT`/`MODIFY`/`DELETE` against a table, not an internal table) or `COMMIT WORK`/`ROLLBACK WORK`, unless this flag is on. |
| `ABAP_ALLOW_FLUID_CALL_FM` | `false` | Allows the built-in `core.call_fm` fluid action, which calls an arbitrary function module under the connected technical user's own SAP authorisations. Same out-of-band ceiling as the two rows above. Also enforced at plugin load time: the same source scan refuses to load any plugin object whose ABAP contains `CALL FUNCTION` in any form, unless this flag is on. |
| `ABAP_ALLOW_FLUID_EVAL` | `false` | Allows the built-in `core.eval` fluid action, which runs a caller-supplied ABAP snippet as the body of one generated method under the connected technical user's own SAP authorisations. Off in every mode, including `admin` — no `ABAP_MODE` value turns it on. Independent of `ABAP_ALLOW_FLUID_PLUGINS` and `ABAP_ALLOW_FLUID_PLUGIN_MUTATE`. Each call still needs a per-call `confirm: "core.eval"` echo, and the supplied lines still go through the static review and capability scan on every call — a lint, not a sandbox; see `doc/FLUID-API/safety.md`. |

Only one legacy variable goes fully dead once `ABAP_MODE` is set:
`ABAP_ALLOW_WRITE`. It is then ignored with a startup warning — `ABAP_MODE`
alone decides writes-at-all. The other seven booleans in the table above
(`ABAP_ALLOW_TRANSPORT_RELEASE`, `ABAP_ALLOW_TRANSPORT_DELETE`,
`ABAP_ALLOW_CASCADE_DELETE`, `ABAP_ALLOW_SERVICE_PUBLISH`,
`ABAP_ALLOW_ENHANCEMENTS`, `ABAP_ALLOW_SOURCE_PLUGINS`,
`ABAP_ALLOW_ENHANCEMENT_DELETE`), plus `ABAP_ENHANCE_TARGETS` (enum-shaped
rather than boolean, but the same philosophy), stay live overrides under
`ABAP_MODE`: unset takes the mode's own default, but an explicit value wins
in *either* direction — it can grant a capability the mode would otherwise
withhold, or withdraw one the mode would otherwise grant.
`ABAP_ALLOW_TRANSPORT_DELETE` and `ABAP_ALLOW_CASCADE_DELETE` are new
variable names — before this, both capabilities were reachable only via
`ABAP_MODE=admin`, with no way to reach either outside a mode at all.
`ABAP_ALLOW_SERVICE_PUBLISH` is likewise new, gating the publish/unpublish
operations added to `abap_service`. `ABAP_ENHANCE_TARGETS` was the last
capability this override machinery could not reach, until support was
added — it used to be silently ignored (with a startup warning) once
`ABAP_MODE` was set, the same way `ABAP_ALLOW_WRITE` still is.

An eighth boolean, `ABAP_ALLOW_RAW_ADT_WRITES`, follows the same two-way-override
shape (default admin-only) but has no `Config` field and no consumer yet — the
`abap_adt` tool it will gate does not exist in this codebase. It is omitted
from the table above because setting it currently does nothing observable;
see `cfg.capabilities.allowRawAdtWrites` in `src/mode.ts` for where it is
computed and frozen, ready for that tool to read once it lands.

The mode ladder:

| Mode | Write / activate / run | Package default | Transports | Release / transport delete | Enhancements |
|---|---|---|---|---|---|
| `read` | no — structurally, no override can change this | — | — | no | no |
| `edit` | yes | `*` (any) | default: `*` (any caller-named request, and may auto-create) | default: no | default: customer-owned targets, plus source plug-ins |
| `admin` | yes | `*` (any) | default: `*` (any caller-named request, and may auto-create) | default: yes | default: customer + SAP-original (needs `ABAP_ENHANCE_TARGET_PACKAGES` too) |

Everything in the last three columns is each mode's *default*, not a ceiling
— `ABAP_ALLOW_TRANSPORTS` can narrow (e.g. pin to one TRKORR, or `auto` for
server-select/create only) transports under either mode, the seven boolean
overrides above can widen or narrow
release/delete/enhancement capability the same way, and `ABAP_ENHANCE_TARGETS`
can widen or narrow *which* objects an enhancement may target the same way
(e.g. `edit` + `ABAP_ENHANCE_TARGETS=sap` reaches SAP-original targets without
`admin`; `admin` + `ABAP_ENHANCE_TARGETS=customer` narrows away from its own
`sap` default). `read` is the only row that is a true ceiling: nothing
overrides it.

An `ABAP_ALLOW_*` variable whose name this server doesn't recognise — most
often a typo of one of the ones above — used to be a silent no-op: the
intended restriction or grant just never applied. Startup now checks every
`ABAP_ALLOW_*` name against the real set and warns on anything unrecognised,
regardless of `ABAP_MODE` or the value given.

**Three of the booleans in the table above** (`ABAP_ALLOW_DATA_PREVIEW`,
`ABAP_ALLOW_DUMP_VARIABLES`, `ABAP_ALLOW_UI_PRESS`) sit outside the mode
ladder for a disclosure reason, not by oversight. Each is a read, not a
mutation, so gating it behind write capability would be backwards:
`ABAP_MODE=read` would have to imply the *widest* access to production
data, and a write-enabled sandbox the narrowest. Each one also puts
something durable and often sensitive into the calling model's transcript —
table rows, the live contents of local variables at a crash, or a screen
capture from a transaction — so none of the three is implied by any mode,
including `admin`, and each has to be named explicitly regardless of mode.

`ABAP_ALLOW_FLUID_PLUGINS`, `ABAP_ALLOW_FLUID_PLUGIN_MUTATE` and
`ABAP_ALLOW_FLUID_CALL_FM` are out-of-band for a different reason: they gate
the fluid API surface (`abap_fluid`), not a disclosure risk, and none of the
three is implied by another. Unlike `ABAP_ALLOW_WRITE`, `ABAP_ALLOW_ENHANCEMENTS`
and `ABAP_ALLOW_UI_PRESS`, none of the fluid settings emits a startup warning
when enabled — `loadConfig` has no warn block for any of them.

`ABAP_FLUID_API` (default **true**) and `ABAP_FLUID_PLUGINS` (default `[]`)
are not `ABAP_ALLOW_*` variables and do not belong in the tables above.
`ABAP_FLUID_API` is a feature flag, not a ceiling: it is deliberately not
named `ABAP_ALLOW_FLUID_API`, because an `ALLOW` name that defaults to on is
a contradiction (`src/config.ts:728-734`) — it only ever narrows. Off, it
disables `abap_fluid`'s registration entirely (`src/server.ts:708-719`).
Its reach does not stop there: with `ABAP_FLUID_API=false` and an otherwise
write-capable session —

- `abap_fluid` is not registered at all — genuinely absent, not a locked
  stub. (On a v1 server that is read-only for a *mode* reason instead —
  `ABAP_MODE=read` or legacy read-only config — with `ABAP_FLUID_API` left
  on, `abap_fluid` is not absent: it is registered as a mode-locked refusal
  stub under its real name; see
  [TOOLS/availability-and-capabilities.md](../TOOLS/availability-and-capabilities.md)'s
  case 4. The two are independent gates on the same tool name — this
  bullet is specifically about the flag being off, not about read-only.)
- these stay registered but refuse at call time with `FLUID_API_DISABLED`:
  `abap_fpm_read`, `abap_ui` (`mode=screen` and `mode=press`),
  `abap_bopf_test`, `abap_run` report/class execution, `abap_img_edit` apply
  and its CTS create-request path, `abap_enh`'s six create_* operations
  (create_spot, add_badi_def, add_filter_def, create_impl,
  set_filter_values, exercise), and the classic-call family —
  `abap_transport` `removeObject`, view-delete, tran-delete, package-create
  and package-delete;
- the one-time creation of `$ABAPSMITH_FLUID_API` never happens on any of
  those paths;
- everything else is gated by `canWrite`/`!cfg.readOnly`, not by this flag,
  and is unaffected: `abap_write`, `abap_activate`,
  `abap_bopf`/`abap_bopf_edit`/`abap_bopf_delete`, the transport tools,
  `abap_enh`'s write_description, delete, set_impl_active, create_hook and
  discover_hook_anchors, and the read-only `abap_img`.

Every bridge deploy goes through `deployBridge` (`src/adt/run.ts:1088-1101`)
or `dispatch` (`src/adt/fluid/dispatch.ts:227-228`), both of which check
`fluidDisabledReason` before any I/O — that is the chokepoint behind all of
the above.

`ABAP_FLUID_PLUGINS` is a path list (which plugin files to load), not a
permission — `ABAP_ALLOW_FLUID_PLUGINS` above is the permission that governs
whether any of those paths may load at all.

## Allowlists

Overrides. All five keep working alongside `ABAP_MODE`, replacing its default
outright rather than intersecting with it — for `ABAP_ALLOW_PACKAGES`,
`ABAP_ALLOW_NAME_PREFIXES` and `ABAP_ALLOW_TRANSPORTS`, that default is
already any-package/any-name/any-request, so in practice only narrowing is
possible (see each row).

**`ABAP_ALLOW_PACKAGES` is a whitelist when set, and full access when it is
not.** Leaving it unset does not mean "no restriction beyond the mode" in
some softer sense — it means every package is reachable, including live
customer packages, the moment writes are on at all (`ABAP_MODE`/
`ABAP_ALLOW_WRITE`). Setting it is the only way to narrow that down to a
named list; there is no way to use it to *loosen* access.

| Variable | Default | Effect |
|---|---|---|
| `ABAP_ALLOW_PACKAGES` | any package, when writes are on | Package allowlist for writes. Comma/space-separated. Unset = any package. Set = replaces the default outright, so only the listed packages are allowed — this is how you add the restriction, not how you loosen one. Explicitly empty (`ABAP_ALLOW_PACKAGES=`) denies every write. The permissive default means writes can land in live customer packages and, since `ABAP_ALLOW_TRANSPORTS` also defaults to any request, on any transport the caller names; the actual write opt-in is `ABAP_MODE`/`ABAP_ALLOW_WRITE`, not this variable. Governs only the package this server itself names on a write — ABAP executed via `abap_run` can create objects in any package the technical user may write, unconstrained by this allowlist, see [doc/SAFETY/safety-gate.md](../SAFETY/safety-gate.md). |
| `ABAP_ALLOW_NAME_PREFIXES` | `*` (any name) | Object-name allowlist. Unset = any name (SAP-owned names/packages, and any per-object-type rule such as `EZ`/`EY` for lock objects, are still refused). Set = replaces the default outright — this is how you *add* the restriction (e.g. back to `Z,Y`), not how you loosen one. Explicitly empty (`ABAP_ALLOW_NAME_PREFIXES=`) is folded into the same `*` default, not a deny-all — see the note below. Governs only the object name this server itself names on a write — ABAP executed via `abap_run` can create objects under any name the technical user may write, unconstrained by this allowlist, see [doc/SAFETY/safety-gate.md](../SAFETY/safety-gate.md). |
| `ABAP_ALLOW_TRANSPORTS` | `*` (any request) | Transport allowlist. Unset = `*`: any transport request the caller names is accepted, and this session may also auto-select or auto-create one on its own. Set = replaces the default outright: a TRKORR pins every transportable write to that one request (never auto-creates), `auto` narrows to server auto-select/auto-create: a caller-named request is accepted only when it is a request this session created, or (on `abap_write`'s main path) a modifiable request already attributed to abapsmith for the same package — exactly the requests auto would pick itself — and refused otherwise (a terminal `SAFETY_DENIED` whose hint lists the acceptable requests, or says to omit `corr_nr`); an omitted `corr_nr` reuses a modifiable request this session created or that is attributed to abapsmith for the package, else creates one — for every transportable create, the classic-bridge types (`VIEW/DV`, `TRAN/T`, `SHLP/DH`, `TABL/DI`, `DEVC/K`) included, though those accept only the session-created case, not the attributed-request one (#208). Explicitly empty (`ABAP_ALLOW_TRANSPORTS=`) denies every transportable write; `$TMP` writes are unaffected either way. Governs only the request this server itself names on a write — ABAP executed via `abap_run` that names its own transport is unconstrained by this allowlist, see [doc/SAFETY/safety-gate.md](../SAFETY/safety-gate.md). `abap_img_edit` follows the same `auto` rule: a `corr_nr` naming a request this session itself created (via `abap_img_edit mode=create_request` or `abap_transport create`) is accepted, any other caller-named request is refused, and an omitted `corr_nr` is resolved by the session — see [doc/TOOLS/abap-img-edit.md](../TOOLS/abap-img-edit.md#transport-resolution-under-abap_allow_transportsauto). |
| `ABAP_ENHANCE_TARGET_PACKAGES` | `[]` (deny-all) | Package allowlist for the *affected* (enhanced) object, consulted whenever `enhanceTargets` resolves to `sap` — whether that came from `admin`'s own default or from an explicit `ABAP_ENHANCE_TARGETS=sap` widening a non-admin mode. Required in addition: `targets=sap` alone enhances nothing until packages are named here too. |
| `ABAP_ORIGIN_SYSTEMS` | `[]` | SIDs whose content counts as locally originated for enhancement-target judging, e.g. `A4H`. Empty means nothing is local, so every enhance target is judged as SAP/partner content. |
| `ABAP_DATA_PREVIEW_MAX_ROWS` | `100` | Row ceiling for one `abap_data_preview` call. Hard maximum `1000` — an out-of-range value fails startup. |
| `ABAP_DATA_SNAPSHOT_TTL_HOURS` | `24` | Ceiling on how long a `abap_data_preview mode="snapshot"` may be diffed against before it expires and is pruned. A caller's own `ttl_hours` is clamped DOWN to this value when it exceeds it, never raised up to it — there is no "keep forever" spelling for a store that holds business data. Hard maximum `8760` (one year) — an out-of-range value fails startup. |
| `ABAP_DATA_PREVIEW_DENY_TABLES` | `[]` | Additions to the built-in table deny-list. Additive only — nothing here or anywhere removes a built-in entry. |

**`ABAP_ALLOW_TRANSPORTS=` (set but empty) denies every transportable
write**, which is different from leaving the variable unset (`*`). This
is deliberately the opposite convention from `ABAP_ALLOW_NAME_PREFIXES=`,
where an empty value is folded into the unset `*` default on both the
`ABAP_MODE` and legacy paths (`src/mode.ts`'s `resolveNamePrefixes` and
`src/config.ts`'s legacy branch agree). Prefixes have no deny-all sentinel:
"refuse every write" is already expressed by `ABAP_ALLOW_PACKAGES=` or
`ABAP_MODE=read`, so an empty prefix list has nothing distinct to fold to.

A pinned `ABAP_ALLOW_TRANSPORTS` does not block a `VIEW/DV`/`TRAN/T`/
`SHLP/DH` bridge delete (`src/adt/view-delete.ts`, `src/adt/tran-delete.ts`,
`src/adt/shlp-delete.ts`): the delete bridges pass no transport request and
issue no `RS_CORR_INSERT` of their own, so abapsmith names no request for
the allowlist to judge and the safety gate treats the delete as a local
mutation. An explicitly empty `ABAP_ALLOW_TRANSPORTS=` still refuses all
three deletes, since that deny-all check runs first. Because the delete
records nothing in CTS, whatever entry the object already had on a
transport request (typically from its create) survives the delete; remove
it separately with `abap_transport` operation
`"removeObject"` — but that operation is itself gated by the admin-only
transport-delete ceiling, so it needs `ABAP_MODE=admin`.

**The fluid API package.** Fluid calls install their generated ABAP into
`$ABAPSMITH_FLUID_API`, created on first use under superpackage `$TMP`
(`src/adt/fluid/package.ts:14-70`). A narrow `ABAP_ALLOW_PACKAGES` must
include **both** names, because the create and every write after it are
judged against different values: the one-time package create is judged
against its superpackage, `$TMP`, and every ordinary object write afterwards
is judged against the package's own name, `$ABAPSMITH_FLUID_API`. Missing
either one refuses fluid calls at the package gate.

A narrow `ABAP_ALLOW_NAME_PREFIXES` such as `Z,Y` refuses the **cold**
creation of `$ABAPSMITH_FLUID_API`: the object-name allowlist judges the new
package's own name, and `$ABAPSMITH_FLUID_API` starts with neither `Z` nor
`Y`. This is deliberate and test-pinned (`test/fluid-package.test.ts:237-275`).
The fix is a one-time widening of the prefix list, or creating the package
another way; once the package exists, the prefix rule is never consulted for
it again.

The retired class `ZCL_ZMCP_IMG_WPROBE` sits in the legacy helper package
(`$ZMCP_HELPERS`), so `abap_fluid(op="repair")` can only delete it if that
package is also in `ABAP_ALLOW_PACKAGES`. Otherwise the reap reports it as
`failed`, carrying whatever error the delete returned — there is no bespoke
message naming the allowlist as the cause.

**These allowlists govern writes this server makes, not ABAP it executes.**
ABAP run via `abap_run`, `abap_test` or `abap_bopf_test` executes under the
technical user's SAP authorisations and can call CTS APIs directly, naming a
transport request itself; that path passes through none of the checks
above. See [doc/SAFETY/safety-gate.md](../SAFETY/safety-gate.md).
