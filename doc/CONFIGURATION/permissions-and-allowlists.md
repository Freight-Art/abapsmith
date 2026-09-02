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
| `ABAP_ALLOW_CASCADE_DELETE` | `false` | The BOPF cascading DDIC delete sweep. New variable — previously this capability was reachable only via `ABAP_MODE=admin`, with no legacy lever at all. Now works standalone when `ABAP_MODE` is unset; under `ABAP_MODE` it's a live two-way override — defaults to admin-only, but an explicit value wins either direction. |
| `ABAP_ALLOW_DEBUG_JUMP_TO_LINE` | `false` | Debugger `jumpToLine`: a forced jump that skips statements (and any checks they would have run). Not governed by `ABAP_MODE` — no mode, including `admin`, grants it; this variable is the only lever, in every mode. |
| `ABAP_ALLOW_DATA_PREVIEW` | `false` | Registers `abap_data_preview` at all. Off means the tool does not exist in `tools/list`. Not governed by `ABAP_MODE` — on in every mode when set, including `read`. |
| `ABAP_ALLOW_DUMP_VARIABLES` | `false` | Lets `abap_dumps` return the variable-contents chapter of a runtime-error dump. Not governed by `ABAP_MODE`. |
| `ABAP_ALLOW_UI_PRESS` | `false` | Lets `abap_ui` submit a batch-input script that commits immediately. Requires `ABAP_MODE=admin` as well — neither alone is sufficient. |

Only one legacy variable goes fully dead once `ABAP_MODE` is set:
`ABAP_ALLOW_WRITE`. It is then ignored with a startup warning — `ABAP_MODE`
alone decides writes-at-all. The other six booleans in the table above
(`ABAP_ALLOW_TRANSPORT_RELEASE`, `ABAP_ALLOW_TRANSPORT_DELETE`,
`ABAP_ALLOW_CASCADE_DELETE`, `ABAP_ALLOW_ENHANCEMENTS`,
`ABAP_ALLOW_SOURCE_PLUGINS`, `ABAP_ALLOW_ENHANCEMENT_DELETE`), plus
`ABAP_ENHANCE_TARGETS` (enum-shaped rather than boolean, but the same
philosophy), stay live overrides under `ABAP_MODE`: unset takes the mode's
own default, but an explicit value wins in *either* direction — it can grant
a capability the mode would otherwise withhold, or withdraw one the mode
would otherwise grant. `ABAP_ALLOW_TRANSPORT_DELETE` and
`ABAP_ALLOW_CASCADE_DELETE` are new variable names — before this, both
capabilities were reachable only via `ABAP_MODE=admin`, with no way to reach
either outside a mode at all. `ABAP_ENHANCE_TARGETS` was the last capability
this override machinery could not reach, until support was added — it used to be
silently ignored (with a startup warning) once `ABAP_MODE` was set, the same
way `ABAP_ALLOW_WRITE` still is.

A seventh boolean, `ABAP_ALLOW_RAW_ADT_WRITES`, follows the same two-way-override
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

**The three out-of-band flags** (`ABAP_ALLOW_DATA_PREVIEW`,
`ABAP_ALLOW_DUMP_VARIABLES`, `ABAP_ALLOW_UI_PRESS`) sit outside the mode
ladder on purpose, not by oversight. Each is a read, not a mutation, so
gating it behind write capability would be backwards: `ABAP_MODE=read` would
have to imply the *widest* access to production data, and a write-enabled
sandbox the narrowest. Each one also puts something durable and often
sensitive into the calling model's transcript — table rows, the live
contents of local variables at a crash, or a screen capture from a
transaction — so none of the three is implied by any mode, including
`admin`, and each has to be named explicitly regardless of mode.

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
| `ABAP_ALLOW_PACKAGES` | any package, when writes are on | Package allowlist for writes. Comma/space-separated. Unset = any package. Set = replaces the default outright, so only the listed packages are allowed — this is how you add the restriction, not how you loosen one. Explicitly empty (`ABAP_ALLOW_PACKAGES=`) denies every write. The permissive default means writes can land in live customer packages and, since `ABAP_ALLOW_TRANSPORTS` also defaults to any request, on any transport the caller names; the actual write opt-in is `ABAP_MODE`/`ABAP_ALLOW_WRITE`, not this variable. |
| `ABAP_ALLOW_NAME_PREFIXES` | `*` (any name) | Object-name allowlist. Unset = any name (SAP-owned names/packages, and any per-object-type rule such as `EZ`/`EY` for lock objects, are still refused). Set = replaces the default outright — this is how you *add* the restriction (e.g. back to `Z,Y`), not how you loosen one. Explicitly empty (`ABAP_ALLOW_NAME_PREFIXES=`) is folded into the same `*` default, not a deny-all — see the note below. |
| `ABAP_ALLOW_TRANSPORTS` | `*` (any request) | Transport allowlist. Unset = `*`: any transport request the caller names is accepted, and this session may also auto-select or auto-create one on its own. Set = replaces the default outright: a TRKORR pins every transportable write to that one request (never auto-creates), `auto` narrows to server auto-select/auto-create only (no caller-named requests accepted). Explicitly empty (`ABAP_ALLOW_TRANSPORTS=`) denies every transportable write; `$TMP` writes are unaffected either way. Governs only the request this server itself names on a write — ABAP executed via `abap_run` that names its own transport is unconstrained by this allowlist, see [doc/SAFETY/safety-gate.md](../SAFETY/safety-gate.md). |
| `ABAP_ENHANCE_TARGET_PACKAGES` | `[]` (deny-all) | Package allowlist for the *affected* (enhanced) object, consulted whenever `enhanceTargets` resolves to `sap` — whether that came from `admin`'s own default or from an explicit `ABAP_ENHANCE_TARGETS=sap` widening a non-admin mode. Required in addition: `targets=sap` alone enhances nothing until packages are named here too. |
| `ABAP_ORIGIN_SYSTEMS` | `[]` | SIDs whose content counts as locally originated for enhancement-target judging, e.g. `A4H`. Empty means nothing is local, so every enhance target is judged as SAP/partner content. |
| `ABAP_DATA_PREVIEW_MAX_ROWS` | `100` | Row ceiling for one `abap_data_preview` call. Hard maximum `1000` — an out-of-range value fails startup. |
| `ABAP_DATA_PREVIEW_DENY_TABLES` | `[]` | Additions to the built-in table deny-list. Additive only — nothing here or anywhere removes a built-in entry. |

**`ABAP_ALLOW_TRANSPORTS=` (set but empty) denies every transportable
write**, which is different from leaving the variable unset (`*`). This
is deliberately the opposite convention from `ABAP_ALLOW_NAME_PREFIXES=`,
where an empty value is folded into the unset `*` default on both the
`ABAP_MODE` and legacy paths (`src/mode.ts`'s `resolveNamePrefixes` and
`src/config.ts`'s legacy branch agree). Prefixes have no deny-all sentinel:
"refuse every write" is already expressed by `ABAP_ALLOW_PACKAGES=` or
`ABAP_MODE=read`, so an empty prefix list has nothing distinct to fold to.

**These allowlists govern writes this server makes, not ABAP it executes.**
ABAP run via `abap_run`, `abap_test` or `abap_bopf_test` executes under the
technical user's SAP authorisations and can call CTS APIs directly, naming a
transport request itself; that path passes through none of the checks
above. See [doc/SAFETY/safety-gate.md](../SAFETY/safety-gate.md).
