## BOPF

Tools: `abap_bopf` (modes `show`, `raw`, `search`, `check_refs`),
`abap_bopf_edit` (27 operations), `abap_bopf_delete`, `abap_bopf_test`. The
whole model is read, mutated by byte splice, and written back under a lock;
the XML tree is never round-tripped.

| Entity | Create | Read | Update | Delete | Activate | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Business object | yes | yes | yes | yes | yes | live | Whole-model read, mutate, write back under lock. `create_bo` requires a local package. |
| Node | yes | yes | partial | yes | n/a | live | `add_node` / `remove_node`. `set_node_flags` patches node flags and refs in place; every other child kind now has its own `set_*_fields` operation too. Activation is a property of the business object, not the node. |
| Association | yes | yes | partial | yes | n/a | mixed | `add_association` / `remove_association`. `set_association_fields` patches xmlName, multiplicity, implementationType, doEmbeddingName, objectModelGenerated, targetNodeRef, parameterStructureRef and implementationClassRef in place; renaming (`name`) is refused. Add/remove are live; `set_association_fields` is covered by tests only. |
| Action | yes | yes | partial | yes | n/a | mixed | `add_action` / `remove_action`. Class references are preflighted. `set_action_fields` patches xmlName, category, instanceMultiplicity, exportingParameterCategoryType, exportParameterLink, isExtensible, objectModelGenerated, parameterStructureRef and implementationClassRef in place; renaming (`name`) is refused. Add/remove are live; `set_action_fields` is covered by tests only. |
| Determination | yes | yes | partial | yes | n/a | mixed | `add_determination` / `remove_determination`. `set_determination_fields` patches xmlName, category, objectModelGenerated and implementationClassRef in place; `triggers`, `relations` (write-once — read only inside the original `add_determination` call) and renaming (`name`) are refused. Add/remove are live; `set_determination_fields` is covered by tests only. |
| Validation | yes | yes | partial | yes | n/a | mixed | `add_validation` / `remove_validation`. Trigger action and node are preflighted. `set_validation_fields` patches xmlName, category, checkBeforeSave, createNode, updateNode, deleteNode, objectModelGenerated and implementationClassRef in place; `triggers` (write-once — read only inside the original `add_validation` call) and renaming (`name`) are refused. Add/remove are live; `set_validation_fields` is covered by tests only. |
| Query | yes | yes | partial | yes | n/a | mixed | `add_query` / `remove_query`. `set_query_fields` patches xmlName, category, objectModelGenerated, dataTypeRef and implementationClassRef in place; renaming (`name`) is refused. Add/remove are live; `set_query_fields` is covered by tests only. |
| Alternative key | partial | yes | partial | yes | n/a | mixed | `add_alternative_key` has never been confirmed to succeed on any node, even with a clean preflight, and demands an explicit acknowledgement flag. `set_alternative_key_fields` patches xmlName, uniqueness, checkAfterModify, checkBeforeSave, noCheck, objectModelGenerated, dataTypeRef and dataTableTypeRef in place, and demands the same `i_know_this_may_not_activate: true` acknowledgement as `add_alternative_key`; `keyElements` and renaming (`name`) are refused. Add/remove attempts are live (never confirmed to succeed); `set_alternative_key_fields` is covered by tests only. |
| Delegated / dependent object | yes | yes | no | yes | n/a | unverified | `embed_dependent_object` / `remove_dependent_object` write/remove the association+node pair in one PUT; `dependentObject` is preflighted, never written. See below. |
| Representative node | yes | yes | no | yes | n/a | unverified | `add_representative_node` / `remove_representative_node` write/remove the parentless node; `representedBo` is preflighted, never written. See below. |
| Configuration / customizing | no | no | no | no | n/a | unverified | No read surface and no write surface of any kind. |

- **Patch, don't replace.** Every child kind has its own `set_*_fields`
  operation (`set_node_flags`, `set_association_fields`, `set_action_fields`,
  `set_determination_fields`, `set_validation_fields`, `set_query_fields`,
  `set_alternative_key_fields`) that changes only the fields named in its
  `spec` and leaves everything else on that element — including its child
  elements — untouched. Determination/validation `triggers` and `relations`,
  alternative-key `keyElements`, and `name` on any of the six are not
  patchable this way. `add_*` now refuses to create an element whose kind and
  name already exist on the node, naming the existing one, instead of
  creating a duplicate.
- **Irreversible.** Every BOPF write is journalled irreversible, and undo
  refuses irreversible entries unconditionally — not even with `force`.
- **Delegation and representative nodes are each one operation now, not a
  bag of hand-assembled fields.** `embed_dependent_object` writes both
  halves of a delegated node in a single PUT: the parent-node association
  (`implementationType="DoComposition"`, `doEmbeddingName="<EMB>"`,
  `multiplicity="0_1"` by default, `targetNodeRef` pointing at the host
  BO's own `<EMB>.ROOT`, `implementationClassRef`
  `/BOBF/CL_C_BOPF_2_BOPF_SIMPLE` by default) and the `<EMB>.ROOT` node
  itself (no structure or table refs, all three CUD flags `false`,
  `rootNode="false"`). `remove_dependent_object` reverses it.
  `add_representative_node` writes a parentless, non-root node with no
  structure refs and the fixed `KEY`/`PARENT_KEY`/`ROOT_KEY` properties;
  `remove_representative_node` reverses it. `add_node` and `add_association`
  now refuse a hand-assembled delegation — `add_association` with
  `implementationType: "DoComposition"` or a `doEmbeddingName`, `add_node`
  with a `doEmbeddingName` or `isDependentObjectNode: true` — and name the
  dedicated operation instead; `add_node`'s parentless-node refusal now
  also names `add_representative_node`. `remove_representative_node` and
  `remove_dependent_object` both refuse while any association still
  targets the node being removed. The honest caveat: neither the
  dependent object's name nor the represented BO's name is ever written
  to the host BO's XML, so a post-write re-read can prove the
  node/association pair exists but never prove which object it points
  at — `embed_dependent_object` requires `i_know_this_may_not_activate:
  true` for exactly this reason. `isDependentObjectNode="false"` is
  written on every `<EMB>.ROOT` node as part of the pair, but the flag
  itself does **not** mark delegation on this release — setting it
  through `set_node_flags` alone creates no embedding.
- **Alternative keys.** A preflight exists — key elements must be properties
  of the target node, and the node must have a persistent structure
  reference — but a clean preflight still does not mean the operation will
  succeed, hence the acknowledgement flag.
- **`add_node` auto-creates associations.** On the tested appliance,
  `add_node` also creates the ROOT→child Composition association plus
  `TO_PARENT`/`TO_ROOT` on the child, none of them requested. An explicit
  `add_association` for that same ROOT→child link is discarded server-side
  as a duplicate; `abap_bopf_edit` now catches this via a post-write re-read
  and reports `CHECK_FAILED`, naming the existing association instead of
  claiming success.
- **`abap_bopf` `mode: "show"` labels every node with a kind** — `root`,
  `standard`, `delegated`, or `representative` — derived from the same
  shape rules the write side checks (parentless-and-structureless is
  `representative`; the target node of a parent's `DoComposition`
  association is `delegated`; the actual root node is `root`; everything
  else is `standard`). Associations are annotated too:
  a `DoComposition` implementation type is flagged as a delegation link,
  and a `targetNodeRef` naming a different business object
  (`OTHER_BO~NODE` shape) is flagged as cross-BO.
- **`check_refs` no longer misreports a cross-BO reference as missing.**
  A `targetNodeRef` like `/BOBF/DEMO_CUSTOMER~ROOT` used to come back
  `missing` because the check looked the target up in the host BO's own
  node list — the other business object was never in that list to find.
  It now recognizes the cross-BO shape and reports `unchecked`, with a
  detail naming the other business object, instead of a false `missing`;
  `check_refs` reads one business object and does not fetch another to
  verify it.
