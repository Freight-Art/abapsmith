# BOPF

## abap_bopf

Read a BOPF business object model, or search for one.

**Availability**: case 2 — always registered, always a read.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `mode` | enum `show` \| `raw` \| `search` \| `check_refs` | no | `show` | `show`: compact digest. `raw`: verbatim v4 XML. `search`: free-text lookup. `check_refs`: verify class/action references. |
| `bo` | string | required for `show`/`raw`/`check_refs` | — | Business object name, e.g. `"ZBOPF_ORDER"`. |
| `query` | string | `search` only | — | Free-text filter. |
| `object_type` | string | required for `search` | — | e.g. `"BOBF"` — omitting it 400s server-side. |
| `max_results` | number (1–999999) | no | — | Cap on returned hits. |

`mode: "show"`'s digest covers: nodes, refs, associations, actions,
determinations, validations, queries, and alternative keys. `mode:
"check_refs"` reports each reference site as one of: present, missing,
declaration-only, wrong-interface, pending, or unchecked.

## abap_bopf_edit

Apply one structural edit to a BOPF business object (add/remove a node,
association, action, determination, validation, query, alternative key, or
create the BO itself).

**Availability**: case 1 — registered only when `canWrite`.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `bo` | string | yes | — | Business object name. |
| `operation` | enum `create_bo` \| `add_node` \| `remove_node` \| `add_association` \| `remove_association` \| `add_action` \| `remove_action` \| `add_determination` \| `remove_determination` \| `add_validation` \| `remove_validation` \| `add_query` \| `remove_query` \| `add_alternative_key` \| `remove_alternative_key` \| `set_node_flags` \| `activate` | yes | — | The single edit to make. |
| `node` | string | no | — | Existing node the operation targets. |
| `nodeId` | string | no | — | Disambiguator when node name alone is not unique. |
| `name` | string | required except for `create_bo`/`remove_node`/`set_node_flags`/`activate` | — | Name of the new node/association/action/etc. being added, or removed. |
| `spec` | object (free-form) | no | — | Operation-specific fields. `add_node` requires `spec.parent` or `spec.parentNodeId`. `add_alternative_key` requires `spec.uniqueness`, `spec.dataTypeRef`, `spec.dataTableTypeRef`, and `spec.keyElements`. |
| `activate` | boolean | no | — | Also activate after the edit succeeds. |
| `allow_dangling_ref` | boolean | no | — | Proceed even if `spec.class` or a trigger's action doesn't exist yet, or, for `add_alternative_key`, a `spec.keyElements` entry isn't a property of the target node or the node has no `persistentStructureRef`. |
| `i_know_this_may_not_activate` | boolean | required (`true`) for `add_alternative_key` | — | Explicit acknowledgment — the operation is not confirmed to succeed on any node. |
| `package` | string | required for `create_bo` | — | Must be a local (`$TMP`-style) package. |
| `description` | string | `create_bo` only | — | Description of the new BO. |
| `rootNodeName` | string | `create_bo` only | `"ROOT"` | Name for the root node. |

Example (add an action):

```json
{
  "bo": "ZBOPF_DEMO",
  "operation": "add_action",
  "node": "ROOT",
  "name": "RECALCULATE",
  "spec": { "class": "ZCL_DEMO_ORDER_ACTION" }
}
```

Example (add a node):

```json
{
  "bo": "ZBOPF_DEMO",
  "operation": "add_node",
  "name": "ITEM",
  "spec": { "parent": "ROOT", "persistentStructureRef": { "name": "ZBOPF_S_ITEM", "type": "TABL/DS" } }
}
```

Example (add an alternative key):

```json
{
  "bo": "ZBOPF_DEMO",
  "operation": "add_alternative_key",
  "node": "ROOT",
  "name": "ORDER_ID",
  "spec": {
    "uniqueness": "unique",
    "dataTypeRef": { "name": "ZSBOPF_ORDER_ID", "type": "TABL/DS" },
    "dataTableTypeRef": { "name": "ZTBOPF_ORDER_ID", "type": "TTYP/DA" },
    "keyElements": ["ORDER_ID"]
  },
  "i_know_this_may_not_activate": true
}
```

`add_node` needs a parent — `spec.parent` (the parent node's name) or
`spec.parentNodeId` — unless `spec.rootNode: true`. abapsmith writes
`bo:parent` and `bo:parentNodeID` as a matched pair, because BOPF accepts a
node carrying only one of them with a 200 and then discards it. It also
re-reads after the write and fails with `CHECK_FAILED` if the node isn't in
the model, rather than reporting success with an unchanged `nodeCount`.

`add_alternative_key` requires `spec.uniqueness`, `spec.dataTypeRef`,
`spec.dataTableTypeRef` and `spec.keyElements` — all four, no defaults. Every
`bo:alternativeKeys` element in the captured wire XML carries all four; a
partial one made `/BOBF/CL_CONF_MODEL_API_MAP` fail an assertion that took
down the whole ADT session. `spec.uniqueness` is a closed enum —
`"unique"`, `"uniqueIfNotInitial"`, `"notUnique"` — refused client-side like
`category` on determinations/validations/queries. It re-reads after the write
and fails with `CHECK_FAILED` if the key count on that node didn't go up,
rather than reporting success the server discarded.

Before that PUT, `add_alternative_key` also preflights against the
freshly-read model and refuses `BOPF_DANGLING_REF` if either holds: a
`spec.keyElements` entry does not name a property that exists on the target
node (the message lists the properties that DO exist there), or the target
node has no `persistentStructureRef` (no DDIC structure for a key to be a key
of). Both are overridable with `allow_dangling_ref: true`, the same flag
`add_action`/`add_determination`/`add_validation`/`add_query` use for a
missing implementation class. Both refusals are live-confirmed in both
directions — a bogus spec refused, a genuine one allowed through — and
`allow_dangling_ref: true` is confirmed to disable the check, not a blanket
bypass. That confirmation does not extend to the operation itself:
`add_alternative_key` is not known to succeed on any node. The most recent
live attempt, with a complete, enum-valid spec that clears both checks, still
short-dumped the ADT session in `/BOBF/CL_CONF_MODEL_API_MAP` — on inactive
and active business objects alike. This preflight rules out two known-bad
shapes; it does not demonstrate the operation works.

Example (remove a determination):

```json
{
  "bo": "ZTMD_ORDER",
  "operation": "remove_determination",
  "node": "ROOT",
  "name": "RECALC_TOTALS"
}
```

`remove_action`, `remove_determination`, `remove_validation`, `remove_query`
and `remove_alternative_key` take `node` and `name` (both required) plus the
usual optional `activate`. This is also the way out of the state a repeated
`add_action`/`add_determination`/`add_validation`/`add_query`/
`add_alternative_key` leaves a BO in — re-adding under a `name` that already
exists does not replace the existing element, it creates a second one with
the same name, and the BO then fails activation for good. If `name` matches
more than one element on that node, a removal takes the **first one in
document order**; calling the same operation again removes the next, which
is how a duplicate gets unwound one element at a time. Removal re-reads the
model after the write and counts elements of that name on that node: if the
count did not go down, it fails `CHECK_FAILED` naming both counts and sends
no activation request, the same "a BOPF PUT answers 200 whether or not the
server kept what was sent" hazard `add_node`/`add_alternative_key` above
guard against, running in the opposite direction. If no element of that name
exists on the node at all, it fails `NOT_FOUND` and the message lists the
names that DO exist there.

## abap_bopf_delete

Delete a BOPF business object, optionally cascading into its DDIC objects.

**Availability**: case 1 — registered only when `canWrite`.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `bo` | string | yes | — | Business object to delete. |
| `confirm` | string | required when `dry_run:false` | — | Echo `bo` exactly (case-insensitive) to arm the delete. |
| `cascade_ddic` | boolean | no | — | Also delete the DDIC objects this BO generated (its combined table type, combined structure, constants interface). Never deletes `persistentTableRef`/`persistentStructureRef` tables/structures — those are always spared and reported separately. |
| `confirm_cascade` | string | required in addition to `confirm` when `cascade_ddic:true` | — | Echo `bo` exactly again. |
| `dry_run` | boolean | no | `true` | Report what would be deleted without deleting anything. |

Dry run (the default) lists DDIC candidates found in the model without
probing whether they still exist on the server — the armed delete may find
fewer, or report some already absent. An armed delete without `cascade_ddic`
does the same on its DDIC LEFT BEHIND list: it names the generated objects
from the model, not from a read-back, so a listed name (e.g. a BO's
combined table/structure before the BO was ever activated) is not
necessarily an object that exists.

## abap_bopf_test

Run a BOPF business object end to end: create the given node rows, save,
and report what came back.

**Availability**: case 1 — registered only when `canWrite`.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `bo` | string | yes | — | Business object name. Must already be active. |
| `scenario` | object `{nodes, cleanup?}` | yes | — | The rows to create. |
| `scenario.nodes` | array (min 1) of `{node, parentNode?, fields}` | yes | — | `nodes[0]` must be the root node (no `parentNode`); every other entry needs `parentNode` set to an earlier entry's node name. `fields` is a string-to-string map. |
| `scenario.cleanup` | boolean | no | `false` | Delete the created rows and save again, right after create+retrieve. |
| `generate_only` | boolean | no | — | Write and activate the generated test-bridge class without running it; use to set a debugger breakpoint first, then trigger via `abap_debug`. |

Notes: **writes real rows by default** — save is not optional, because
determinations and validations only fire on save. There is no ADT runtime
surface for BOPF, so this generates and executes a throwaway classrun bridge
class that performs the same `MODIFY`+`SAVE` the GUI would.

