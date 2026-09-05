## BOPF

Tools: `abap_bopf` (modes `show`, `raw`, `search`, `check_refs`),
`abap_bopf_edit` (21 operations), `abap_bopf_delete`, `abap_bopf_test`. The
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
| Delegated / dependent object | yes | yes | no | yes | n/a | unverified | `embed_dependent_object` / `remove_dependent_object` write/remove the association+node pair in one PUT; `dependentObject` is preflighted, never written. See below. |
| Representative node | yes | yes | no | yes | n/a | unverified | `add_representative_node` / `remove_representative_node` write/remove the parentless node; `representedBo` is preflighted, never written. See below. |
| Configuration / customizing | no | no | no | no | n/a | unverified | No read surface and no write surface of any kind. |

- **No update, anywhere but nodes.** Every child entity has an add and a
  remove and nothing in between. Re-adding an existing name does not replace
  it, it creates a duplicate. `set_node_flags` is the sole exception and it
  only reaches node flags.
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
