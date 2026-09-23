# abap_enh

Write an existing enhancement object's description (default), or create,
inspect, exercise, activate/deactivate, or delete one.

**Availability**: case 2 — always registered. `discover_hook_anchors` is a
pure read with no gate call. Every other operation is gated on `canWrite`
(`ABAP_MODE=edit`/`admin`); `delete` additionally needs
`ABAP_ALLOW_ENHANCEMENT_DELETE=true`.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `operation` | enum `write_description` \| `create_spot` \| `add_badi_def` \| `add_filter_def` \| `create_impl` \| `set_filter_values` \| `exercise` \| `discover_hook_anchors` \| `create_hook` \| `delete` \| `set_impl_active` | no | `write_description` | The action. |
| `type` | enum of enhancement write types | required for `write_description`/`delete` | — | e.g. `ENHO/XH`, `ENHO/XHH`, `ENHS/XS`. |
| `name` | string | yes | — | Meaning depends on `operation` — see below. |
| `description` | string (max 60 chars) | required for `write_description`/`create_hook` | — | New root description, or (for `create_hook`) the new plug-in's description. |
| `spec` | object (free-form, per-operation fields) | required for most create/hook/exercise/set_impl_active operations | — | Operation-specific fields — see notes. |
| `affects` | object `{name, packageName, masterSystem?, spotName?}` | required for `create_impl`, `set_filter_values`, `exercise`, `write_description`, `delete`, `set_impl_active` | — | The object this enhancement changes the behaviour of. `create_spot`/`add_badi_def`/`add_filter_def` default it to the spot being created or extended; `create_hook` derives it from the host named in `spec` (one read of that host object); `discover_hook_anchors` never uses it. |
| `package` | string | no | `$TMP` | The five fluid ops only — `create_spot`, `add_badi_def`, `add_filter_def`, `create_impl`, `set_filter_values`. Trimmed and uppercased. Given on any other operation → `BAD_INPUT`, zero network. |
| `corr_nr` | string | no | — | `write_description`/`delete`/`set_impl_active` — transport request (unchanged). Also the five fluid ops, when `package` resolves to a transportable (non-`$`) package — see below. A local package with `corr_nr` set on a fluid op → `BAD_INPUT`, zero network. |
| `expect_etag` | string | no | — | `write_description`/`delete`/`set_impl_active` only — compare-before-write. |
| `activate` | boolean | no | see meaning | `write_description` — activate after a changed write, when `activate === true`. The five fluid ops — default `true`; `false` saves without activating. `create_hook` — controlled by `spec.activate`, not this field. `set_impl_active` always activates; this field does not apply to it. |

`name` by operation: `write_description`/`delete`/`set_impl_active` — the
container object's own name (for `set_impl_active`, never the nested
implementation entry's name; use `spec.implName`). `create_spot` — the new
spot name. `add_badi_def`/`add_filter_def` — the already-locked spot name.
`create_impl`/`set_filter_values` — the implementation's own name.
`exercise` — the BAdI definition's name. `create_hook` — the new hook
object's name. Ignored by `discover_hook_anchors`.

Notes: `delete` is irreversible and hard-refused against an `ENHO/XH` with
an active BAdI implementation (deactivate it first via `set_impl_active`).
`set_impl_active` is reversible — call again with the opposite value to
undo.

## Package, transport and activation

`package`, `corr_nr` and `activate` apply only to the five fluid ops —
`create_spot`, `add_badi_def`, `add_filter_def`, `create_impl`,
`set_filter_values`. Each one defaults to `$TMP` when `package` is
omitted. Against a transportable (non-`$`) package, they follow the same
transport rules as `abap_write`: under `ABAP_ALLOW_TRANSPORTS`, a named
`corr_nr` must be on the allowlist; when it is omitted, the session
resolver reuses this session's open request for that package or creates
one (`auto`); an explicitly empty allowlist refuses before any request is
sent. The safety gate's verdict is taken before the resolver is given a
chance to create a request — see [doc/SAFETY/safety-gate.md](../SAFETY/safety-gate.md),
the transport allowlist check.

`add_badi_def`, `add_filter_def` and `set_filter_values` change a spot
or implementation that already exists: pass the `package` it already
lives in (and, for a transportable one, the request rules above apply
again). The call does not look the package up.

`activate: false` saves the object without activating it, for everything
the call creates or changes, with one exception: `add_badi_def`'s marker
interface (`INTF/OI`) is always activated, because the BAdI definition
needs it active. A call made with `activate: false` leaves its object
inactive for review: read it with `abap_read` (`enhancements: true` — an
`ENHS/XS` or `ENHO/XH` has no source), then activate it with
`abap_activate`, which needs the same `affects` the create was judged
against; the response's NOTE spells out both calls.

`exercise` takes none of the three — it creates nothing of the caller's;
its generated bridge class lives in `$ABAPSMITH_FLUID_API`, not in the
caller's package. `create_hook` is unaffected by any of this: it still
lands in `$TMP` unconditionally and its activation is controlled by
`spec.activate`, not by `activate`.

The journal records `affects` exactly as the call used it: the defaulted
spot for `create_spot`/`add_badi_def`/`add_filter_def`, and the derived
host object for `create_hook`.

## Spec field reference (per operation)

Unless noted otherwise, every id-shaped field (`spotName`, `badiName`,
`implName`, `filterName`, `interfaceName`, `hostName`, ...) is capped at 30
characters.

| Operation | Fields (`?` = optional) | Limits |
|---|---|---|
| `create_spot` | `description` | ≤ 60 chars |
| `add_badi_def` | `badiName`, `interfaceName`, `singleUse` (bool), `shortText` | `shortText` ≤ 60 chars |
| `add_filter_def` | `badiName`, `filterName`, `filterType`, `filterText?` | `filterType`: one upper-case letter, e.g. `C`; `filterText` ≤ 255 chars |
| `create_impl` | `spotName`, `badiName`, `implName`, `implClass`, `active` (bool), `description` | `description` ≤ 60 chars |
| `set_filter_values` | `spotName`, `implName`, `filterName`, `filterType`, `compare`, `value` | `filterType` as above; `compare` — see below; `value` ≤ 255 chars |
| `exercise` | `methodName`, `filterName?`, `filterValue?`, `params[]`: `{name, kind?, value?, type?}` | `kind`: `importing` (default) \| `changing` \| `exporting` \| `receiving`, at most one `receiving` entry; `value` required for `importing`/`changing`, forbidden otherwise; `type` required for `changing`/`exporting`/`receiving`, forbidden for `importing` (a namespaced type reference) — rationale below |
| `discover_hook_anchors` | `hostType`, `hostName`, `hostUri` | — |
| `create_hook` | `hostType` (`PROG`/`P` only), `hostName`, `hostUri`, `anchorFullName`, `anchorFullDescription`, `responsible?`, `activate?` (bool) | `anchorFullDescription` ≤ 200 chars; `responsible` ≤ 12 chars |
| `set_impl_active` | `active` (bool), `implName?`, `description?` | `implName` omittable only if the object has exactly one implementation entry; `description` ≤ 60 chars |

`spec.description` (`create_spot`, `create_impl`) becomes the object's root
`adtcore:description`. Both operations require it up front, rather than
leaving it to a follow-up `write_description` call, because SAP's
enhancement PUT handler rejects ANY write against an object whose root
description is empty — `ENHO/XH`, `ENHO/XHH`, `ENHS/XS` alike, including a
write with nothing to do with the description, like `set_impl_active`
(`ENHANCEMENT_DESCRIPTION_REQUIRED`).

`set_impl_active`'s `spec.description` is optional, and different from the
rule above: when given, it is written to the object's root
`adtcore:description` only if the object currently has none. If the object
already carries a different description, the call is refused as `BAD_INPUT`
— use `operation: "write_description"` to change an existing description
instead. `set_impl_active`'s `spec.implName` names the target
`<enho:badiImplementation>` entry (never the top-level `name` field, which
is always the container's own name). It may be omitted only when the object
has exactly one implementation entry; otherwise the call is refused as
`BAD_INPUT`, and the error message names every entry found so the caller can
pick one.

`create_impl`'s filter-presence check: if the BAdI definition
(`spec.badiName`) declares any filters, the response carries a WARNING when
the new implementation has no filter values registered yet — a filter-less
implementation on a filter-dependent, multiple-use BAdI dispatches for ANY
filter value, silently, until `set_filter_values` is called for it.

`create_impl`'s `spec.implClass` is a reference only: `create_impl` records
the class name, it does not generate the class shell SE19 generates. The
response says so explicitly when the class is absent.

`set_filter_values.spec.compare` accepts either spelling of six relations:
symbolic (`=`, `<>`, `<`, `<=`, `>`, `>=`) or the two-letter SELECT-OPTIONS
codes (`EQ`, `NE`, `LT`, `LE`, `GT`, `GE`) — either is accepted and
normalized to the symbolic form before use. Other codes (`CP`, `NP`, `BT`,
`NB`, ...) are refused: only these six have live evidence against SAP's
`BADI_FILTER_COMPARE` domain, so this template declines to guess the rest.

`exercise.spec.params[]` — why the required/forbidden `value`/`type` split
per `kind` exists: an `importing` parameter's value is passed as a literal
directly and needs no local variable. Every other kind (`changing`,
`exporting`, `receiving`) gets a real local `DATA` variable declared and
passed by reference; `changing`/`exporting`/`receiving` are also read back
after the call into the response. `value` is REQUIRED for `importing` and
`changing` (a `changing` local is seeded from it before the call) and
FORBIDDEN for `exporting`/`receiving` — the callee determines those, so a
caller-supplied value would be silently discarded and is refused instead.
`type` is REQUIRED for every kind but `importing` (this tool cannot look up
a BAdI interface method's signature to infer it) and forbidden for
`importing`. At most one `params[]` entry may use `kind:"receiving"`,
because a method has at most one `RETURNING` parameter. Generated calls use
the classic `CALL BADI ref->method [EXPORTING ...] [IMPORTING ...] [CHANGING
...] [RECEIVING ...].` form, never the parenthesized `method( ... )` short
form.

`create_hook` (and every read/write of an `enhoxhh` source-code plug-in)
negotiates its media type instead of hardcoding
`application/vnd.sap.adt.enh.enhoxhh.v2+xml`: abapsmith reads the
`<app:accept>` list of the `/sap/bc/adt/enhancements/enhoxhh` collection
from `/sap/bc/adt/discovery` (cached per connection with the rest of the
discovery inventory) and sends the highest
`application/vnd.sap.adt.enh.enhoxhh.vN+xml` version the server advertises
— A4H 754 offers only v3 and
`text/html`; older releases v2 or v1. When discovery could not be loaded,
it falls back to v2. When the server's discovery offers no `enhoxhh`
collection at all, or one with no `enhoxhh` media type in its accept list,
`create_hook` is refused `UNSUPPORTED` naming
`application/vnd.sap.adt.enh.enhoxhh.v2+xml`, before any request. An HTTP
415 (`SADT_RESOURCE/039`, `ExceptionUnsupportedMediaType`) or HTTP 406
(`SADT_RESOURCE/037`, `ExceptionResourceNotAcceptable`) from the server is
now classified with a hint saying the server does not accept the
enhancement-implementation payload sent / cannot produce the requested
representation, and that reconnecting refreshes the cached discovery
inventory the negotiated version was read from.

`exercise` reports `ENHANCEMENT_NOT_DISPATCHING` — not a false success —
when `GET BADI` returns an unbound handle, meaning `CALL BADI` was never
attempted. This can happen even when the implementation is workbench-active,
its ACTIVE flag is set, and its class is active: SAP ships a runtime
BAdI/enhancement buffer distinct from the design-time metadata buffer (Note
944559).

## Result field: `putVerified`

Only `write_description` and `set_impl_active` responses carry a
`putVerified` field (both go through the same direct-PUT write path). It can
be `false` for the `ENHO/XH` and `ENHS/XS` object types: a live 200 against
each has been observed once, independently confirmed by read-back, but not
the repeated, citable evidence `ENHO/XHH` has, whose PUT success is
confirmed. `putVerified: false` is a caveat on an already-SUCCESS result,
never a failure signal, and the tool's own response text repeats this note
whenever it applies. The six create-family operations (which write from
inside deployed ABAP, not by a direct PUT) and `delete` (a DELETE, not a
PUT) report no `putVerified` field at all — the caveat does not apply to
them. Which ABAP that is differs between them and does not change the point:
five of the six run through the fluid API's shared `ZCL_ZMCP_FLUID_ENH`,
while `exercise` still generates a classrun bridge per call. Neither issues
the PUT whose response `putVerified` reports on, so neither has anything to
report.

Example (exercise a BAdI):

```json
{
  "operation": "exercise",
  "name": "ZDEMO_BADI_ORDER",
  "affects": { "name": "SAPLZDEMO_ORDER", "packageName": "$TMP" },
  "spec": { "methodName": "CHANGE_TOTAL" }
}
```

