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
| `affects` | object `{name, packageName, masterSystem?, spotName?}` | required for every operation except `discover_hook_anchors` | — | The object this enhancement changes the behaviour of. |
| `corr_nr` | string | no | — | `write_description`/`delete`/`set_impl_active` only — transport request. |
| `expect_etag` | string | no | — | `write_description`/`delete`/`set_impl_active` only — compare-before-write. |
| `activate` | boolean | no | — | `write_description` only — also activate after a changed write. |

`name` by operation: `write_description`/`delete`/`set_impl_active` — the
container object's own name (for `set_impl_active`, never the nested
implementation entry's name; use `spec.implName`). `create_spot` — the new
spot name. `add_badi_def`/`add_filter_def` — the already-locked spot name.
`create_impl`/`set_filter_values` — the implementation's own name.
`exercise` — the BAdI definition's name. `create_hook` — the new hook
object's name. Ignored by `discover_hook_anchors`.

Notes: the six create-family operations (`create_spot`, `add_badi_def`,
`add_filter_def`, `create_impl`, `set_filter_values`, `exercise`) always
land in `$TMP` and always activate — there is no non-activating create.
`delete` is irreversible and hard-refused against an `ENHO/XH` with an
active BAdI implementation (deactivate it first via `set_impl_active`).
`set_impl_active` is reversible — call again with the opposite value to
undo.

## Spec field reference (per operation)

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
whenever it applies. The six create-family operations (which write via a
generated classrun bridge, not a direct PUT) and `delete` (a DELETE, not a
PUT) report no `putVerified` field at all — the caveat does not apply to
them.

Example (exercise a BAdI):

```json
{
  "operation": "exercise",
  "name": "ZDEMO_BADI_ORDER",
  "affects": { "name": "SAPLZDEMO_ORDER", "packageName": "$TMP" },
  "spec": { "methodName": "CHANGE_TOTAL" }
}
```

