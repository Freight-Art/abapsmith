## BOPF

Tools: `abap_bopf` (modes `show`, `raw`, `search`, `check_refs`),
`abap_bopf_edit` (23 operations), `abap_bopf_delete`, `abap_bopf_test`. The
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
| Delegated / dependent object | partial | partial | no | no | n/a | unverified | The fields are wire-composable but nothing composes, validates, or tests them. See below. |
| Representative node | no | no | no | no | n/a | unverified | No modelling, no operation, no refusal. |
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
- **Delegation is half-modelled, and the halves matter.**
  `isDependentObjectNode`, `doEmbeddingName` and `implementationType` are
  written straight through as attribute strings by the element renderers in
  `src/adt/bopf-xml.ts`, and `implementationType` is read back off the wire
  with no enum validation at any layer, so a delegation value is physically
  passable. But nothing in the codebase composes a delegated object,
  validates the value, or tests the path, and the only `DoComposition`
  occurrence in the tree is a read-only demo fixture. Not supported enough
  to use, not refused enough to be honest.
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
