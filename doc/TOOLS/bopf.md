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
determinations, validations, queries, and alternative keys. Every node is
labeled with a kind — `root`, `standard`, `delegated`, or `representative`
— and every association that is a do-composition or that targets another
business object is flagged as such. `mode: "check_refs"` reports each
reference site as one of: present, missing, declaration-only,
wrong-interface, pending, or unchecked — a cross-BO `targetNodeRef` (e.g.
`/BOBF/DEMO_CUSTOMER~ROOT`) reports `unchecked`, naming the other business
object, rather than a false `missing`, because `check_refs` reads one
business object and does not fetch another to verify it.

## abap_bopf_edit

Apply one structural edit to a BOPF business object (add/remove a node,
association, action, determination, validation, query, alternative key,
representative node, or embedded dependent object, or create the BO
itself).

**Availability**: case 1 — registered only when `canWrite`.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `bo` | string | yes | — | Business object name. |
| `operation` | enum `create_bo` \| `add_node` \| `remove_node` \| `add_association` \| `remove_association` \| `add_action` \| `remove_action` \| `add_determination` \| `remove_determination` \| `add_validation` \| `remove_validation` \| `add_query` \| `remove_query` \| `add_alternative_key` \| `remove_alternative_key` \| `set_node_flags` \| `set_association_fields` \| `set_action_fields` \| `set_determination_fields` \| `set_validation_fields` \| `set_query_fields` \| `set_alternative_key_fields` \| `add_representative_node` \| `remove_representative_node` \| `embed_dependent_object` \| `remove_dependent_object` \| `activate` | yes | — | The single edit to make. |
| `node` | string | no | — | Existing node the operation targets. |
| `nodeId` | string | no | — | Disambiguator when node name alone is not unique. |
| `name` | string | required except for `create_bo`/`remove_node`/`set_node_flags`/`remove_representative_node`/`activate` | — | Name of the new node/association/action/etc. being added, or removed. |
| `spec` | object (free-form) | no | — | Operation-specific fields. `add_node` requires `spec.parent` or `spec.parentNodeId`. `add_alternative_key` requires `spec.uniqueness`, `spec.dataTypeRef`, `spec.dataTableTypeRef`, and `spec.keyElements`. `add_representative_node` requires `spec.representedBo`. `embed_dependent_object` requires `spec.dependentObject`. |
| `activate` | boolean | no | — | Also activate after the edit succeeds. |
| `allow_dangling_ref` | boolean | no | — | Proceed even if `spec.class` or a trigger's action doesn't exist yet, or, for `add_alternative_key`, a `spec.keyElements` entry isn't a property of the target node or the node has no `persistentStructureRef`. |
| `i_know_this_may_not_activate` | boolean | required (`true`) for `add_alternative_key`/`set_alternative_key_fields` and `embed_dependent_object` | — | Explicit acknowledgment — the operation is not confirmed to succeed on any node (`add_alternative_key`/`set_alternative_key_fields`), or the wire never names what was embedded so a matching re-read cannot confirm it (`embed_dependent_object`). |
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
node carrying only one of them with a 200 and then discards it. Neither
given, and `spec.rootNode` not `true`, is refused before anything is
sent — that shape (a deliberately parentless node) is `add_representative_node`,
not `add_node`. `add_node` also refuses `spec.doEmbeddingName` or
`spec.isDependentObjectNode: true` (that pair of fields is
`embed_dependent_object`'s job), and `add_association` likewise refuses
`spec.implementationType: "DoComposition"` or a `spec.doEmbeddingName`, in
both cases naming the dedicated operation instead. `add_node` also
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
usual optional `activate`. `add_action`/`add_determination`/`add_validation`/
`add_query`/`add_alternative_key`/`add_association` now refuse up front,
before sending anything, when an element of that kind and name
already exists on the target node — `BAD_INPUT`, naming the existing
element — so a fresh duplicate can no longer be created through the tool.
`remove_*` is still the way to unwind a duplicate that already exists on the
server-side model (from before this refusal, or from any other route). If
`name` matches more than one element on that node, a removal takes the **first one in
document order**; calling the same operation again removes the next, which
is how a duplicate gets unwound one element at a time. Removal re-reads the
model after the write and counts elements of that name on that node: if the
count did not go down, it fails `CHECK_FAILED` naming both counts and sends
no activation request, the same "a BOPF PUT answers 200 whether or not the
server kept what was sent" hazard `add_node`/`add_alternative_key` above
guard against, running in the opposite direction. If no element of that name
exists on the node at all, it fails `NOT_FOUND` and the message lists the
names that DO exist there.

`set_node_flags` takes `node` (no `name`) and a `spec` of fields for that
node: boolean flags (`rootNode`, `textNode`, `isDependentObjectNode`,
`createEnabled`, `updateEnabled`, `deleteEnabled`, `authorizationCheck`,
`isExtensible`, `objectModelGenerated`, `objectModelObsolete`) where `null`
clears the attribute rather than writing `false`, the eight singular object
refs (`persistentStructureRef`, `transientStructureRef`,
`combinedStructureRef`, `combinedTableRef`, `persistentTableRef`,
`defaultingClassRef`, `dataAccessClassRef`, `authorizationClassRef`) where
`null` means the ref must be gone, and an optional `spec.name` that renames
the node. It re-reads after the write — locating the node by the new name
when `spec.name` was sent, otherwise by `node` (`nodeId` disambiguates a
duplicate name) — and fails `CHECK_FAILED` if any flag, ref, or the rename
did not stick, naming each mismatched field with the value sent and the
value read back; refs are compared on name and type, case-insensitively. No
activation request is sent on a `CHECK_FAILED`.

`set_association_fields` / `set_action_fields` / `set_determination_fields` /
`set_validation_fields` / `set_query_fields` / `set_alternative_key_fields`
each take `node` and `name` (both required, to locate the existing element)
plus a `spec` of the fields to change; every field left out of `spec`, and
every child element the target already has, is preserved byte-for-byte —
the element is patched in place, not re-rendered. `null` clears an
attribute or a ref, as with `set_node_flags`. On the five kinds with an
implementation class (association, action, determination, validation,
query), `spec.class`/`spec.implementationClass` (a bare class name) is
accepted as a shorthand for `implementationClassRef`, wrapped as a `CLAS/OC`
ref exactly as the matching `add_*` does; an explicit
`spec.implementationClassRef` wins over either, and
`spec.implementationClassRef: null` clears it. `set_alternative_key_fields`
has no implementation class, so neither shorthand applies there — and, like
`add_alternative_key`, it requires `i_know_this_may_not_activate: true`: a
patch's attributes go through the same BOPF model mapper
(`/BOBF/CL_CONF_MODEL_API_MAP`) that has short-dumped the ADT session on an
invalid alternative-key payload, and the operation is not confirmed to
succeed on any node. Patchable per kind: association
— `xmlName`, `multiplicity`, `implementationType`, `doEmbeddingName`,
`objectModelGenerated`, `targetNodeRef`, `parameterStructureRef`,
`implementationClassRef`; action — `xmlName`, `category`,
`instanceMultiplicity`, `exportingParameterCategoryType`,
`exportParameterLink`, `isExtensible`, `objectModelGenerated`,
`parameterStructureRef`, `implementationClassRef`; determination —
`xmlName`, `category`, `objectModelGenerated`, `implementationClassRef`;
validation — `xmlName`, `category`, `checkBeforeSave`, `createNode`,
`updateNode`, `deleteNode`, `objectModelGenerated`,
`implementationClassRef`; query — `xmlName`, `category`,
`objectModelGenerated`, `dataTypeRef`, `implementationClassRef`; alternative
key — `xmlName`, `uniqueness`, `checkAfterModify`, `checkBeforeSave`,
`noCheck`, `objectModelGenerated`, `dataTypeRef`, `dataTableTypeRef`. Each
re-reads after the write and fails `CHECK_FAILED` if a named field did not
stick or a second element of that name appeared. Refused with their own
message, before anything is sent: a determination's `triggers`/`relations`
and a validation's `triggers` (write-once — read only inside the original
`add_determination`/`add_validation` call), an alternative key's
`keyElements` (not changeable in place), and `name` on any of the six
(renaming would orphan the XPath fragments that triggers and relations
embed). A call whose `spec` names no field from that kind's patchable list
is refused with `BAD_INPUT` before anything is sent, listing that
operation's patchable fields. `set_action_fields`/`set_determination_fields`/
`set_validation_fields`/`set_query_fields` run the same dangling-class-ref
preflight as their `add_*` counterparts: a class name that has no source
artifact refuses with `BOPF_DANGLING_REF` unless `allow_dangling_ref: true`.

`add_representative_node` writes a deliberately parentless, non-root node —
no structure refs, just the fixed `KEY`/`PARENT_KEY`/`ROOT_KEY` properties
and all three CUD flags `true` — that stands in for another business
object. It takes `name` (the new node's name), refuses `node` outright, and
requires `spec.representedBo`, which is checked for existence over the
network but **never written to the node**: the wire carries no link from a
representative node to the BO it represents. The link is a separate step —
add a cross-BO `add_association` afterward, with `spec.implementationType:
"Association"` and `spec.targetNodeRef: { name: "<REPRESENTED_BO>~ROOT",
type: "BOBF" }` (real captures also carry a `spec.implementationClassRef`
naming a generated `*_XBO` class). `remove_representative_node` takes
`node` only (no `name`) and refuses while any association still targets the
node being removed.

Example (add a representative node, then link it):

```json
{ "bo": "ZBOPF_DEMO", "operation": "add_representative_node", "name": "CUSTOMER_REF",
  "spec": { "representedBo": "/BOBF/DEMO_CUSTOMER" } }
```
```json
{ "bo": "ZBOPF_DEMO", "operation": "add_association", "node": "ROOT", "name": "TO_CUSTOMER",
  "spec": { "implementationType": "Association",
            "targetNodeRef": { "name": "/BOBF/DEMO_CUSTOMER~ROOT", "type": "BOBF" } } }
```

`embed_dependent_object` writes both halves of a delegated node in one PUT:
a `"<name>.ROOT"` child node under the given `node` (all three CUD flags
`false`, `rootNode: false`) and, on that same parent, a `DoComposition`
association (`doEmbeddingName` and `name` both the embedding name,
`spec.multiplicity` defaulting to `"0_1"`, `spec.implementationClassRef`
defaulting to `/BOBF/CL_C_BOPF_2_BOPF_SIMPLE`) whose `targetNodeRef` points
at that same new `"<name>.ROOT"` node on the host BO — not at the dependent
object. `spec.dependentObject` is checked over the network (it must exist
and have `objectCategory: "dependentObject"`) but, like
`representedBo` above, is never written to the wire — the host BO's XML
never names the dependent object anywhere. Because a 200 plus a matching
re-read cannot confirm which object ended up embedded, or that it works at
all, this operation requires `i_know_this_may_not_activate: true`.
`remove_dependent_object` takes `node` and `name` and refuses while any
other association still targets the node being removed.

Example (embed a dependent object):

```json
{
  "bo": "ZBOPF_DEMO",
  "operation": "embed_dependent_object",
  "node": "ROOT",
  "name": "TEXT",
  "spec": { "dependentObject": "/BOBF/DEMO_TEXT_COLLECTION" },
  "i_know_this_may_not_activate": true
}
```

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

