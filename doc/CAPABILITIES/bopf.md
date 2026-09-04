## BOPF

Tools: `abap_bopf` (modes `show`, `raw`, `search`, `check_refs`),
`abap_bopf_edit` (17 operations), `abap_bopf_delete`, `abap_bopf_test`. The
whole model is read, mutated by byte splice, and written back under a lock;
the XML tree is never round-tripped.

| Entity | Create | Read | Update | Delete | Activate | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Business object | yes | yes | yes | yes | yes | live | Whole-model read, mutate, write back under lock. `create_bo` requires a local package. |
| Node | yes | yes | partial | yes | n/a | live | `add_node` / `remove_node`. `set_node_flags` is the only update any BOPF child entity has. Activation is a property of the business object, not the node. |
| Association | yes | yes | no | yes | n/a | live | `add_association` / `remove_association`. No update operation exists. |
| Action | yes | yes | no | yes | n/a | live | `add_action` / `remove_action`. Class references are preflighted. |
| Determination | yes | yes | no | yes | n/a | live | `add_determination` / `remove_determination`. |
| Validation | yes | yes | no | yes | n/a | live | `add_validation` / `remove_validation`. Trigger action and node are preflighted. |
| Query | yes | yes | no | yes | n/a | live | `add_query` / `remove_query`. |
| Alternative key | partial | yes | no | yes | n/a | unverified | `add_alternative_key` has never been confirmed to succeed on any node, even with a clean preflight, and demands an explicit acknowledgement flag. |
| Delegated / dependent object | partial | partial | no | no | n/a | unverified | The fields are wire-composable but nothing composes, validates, or tests them. See below. |
| Representative node | no | no | no | no | n/a | unverified | No modelling, no operation, no refusal. |
| Configuration / customizing | no | no | no | no | n/a | unverified | No read surface and no write surface of any kind. |

- **No update, anywhere but nodes.** Every child entity has an add and a
  remove and nothing in between. Re-adding an existing name does not replace
  it, it creates a duplicate. `set_node_flags` is the sole exception and it
  only reaches node flags.
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
