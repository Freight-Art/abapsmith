## BOPF

Tools: `abap_bopf` (modes `show`, `raw`, `search`, `check_refs`),
`abap_bopf_edit` (24 operations), `abap_bopf_delete`, `abap_bopf_test`. The
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
| Delegated / dependent object | no | yes | no | yes | n/a | mixed | `remove_dependent_object` deletes the parent-node association and the embedded node in one PUT when a genuine `DoComposition` embedding already exists; its guard against removing the wrong association was exercised live and refused correctly. There is no operation that creates an embedding on this release. See below. |
| Representative node | no | yes | no | no | n/a | live | Minted by the server as a side effect of a cross-BO `add_association`, named `REP_<random>`; observed live that it disappears from the read-back once the association is gone, so `remove_association` should remove it (not itself exercised against a minted node). Nothing creates or removes it directly. See below. |
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
- **A representative node is a side effect of `add_association`, never a
  direct write.** A live discovery run proved that a client-written
  parentless node is hard-rejected by the server: the exact response was
  `An error occurred when deserializing in the simple transformation
  program /BOBF/ST_CONF_ADT`, reproduced three times (combined with an
  association, alone with a stale server-minted node present, and alone
  on a clean baseline), with nothing committed and no lock stranded. This
  is what the former `add_representative_node` operation sent, so it
  could never have worked, and it has been removed. What does work:
  adding a plain cross-BO `add_association` — `spec.implementationType:
  "Association"`, `spec.targetNodeRef` naming another BO's node (e.g.
  `{ name: "/BOBF/DEMO_CUSTOMER~ROOT", type: "BOBF" }`), and
  `spec.implementationClassRef` naming an XBO class — answers 200, and
  the read-back contains a node the client never sent: a parentless,
  non-root node named `REP_<random>` (observed
  `REP_TYVJRJ3REEP6DKVELQE77P7WKA` and
  `REP_TYVJRJ3REEP6DKVEMU4P7PSWKA`), carrying exactly the fixed
  `KEY`/`PARENT_KEY`/`ROOT_KEY` properties — the same shape `show`
  already classifies as `representative`. The name is server-assigned
  and cannot be chosen. Observed live: with the cross-BO association
  absent from the payload, the server does not keep the minted node
  either, so `remove_association` should remove it — the operation
  itself was not exercised against a minted node in the discovery run.
  There is no dedicated remove for it either.
  `abap_bopf_edit` emits two notes on such a write recording exactly
  this recipe and the short-dump observation below. `add_node` and
  `add_association` still refuse a hand-assembled delegation —
  `add_association` with `implementationType: "DoComposition"` or a
  `doEmbeddingName`, `add_node` with a `doEmbeddingName` or
  `isDependentObjectNode: true` — naming the dedicated recipe instead;
  `add_node`'s parentless-node refusal (neither `spec.parent` nor
  `spec.parentNodeId` given, and `rootNode` not `true`) now names the
  `add_association` cross-BO recipe above, since there is no
  `add_representative_node` operation to point to any more.
  `remove_dependent_object` still reverses an existing dependent-object
  embedding — the parent-node association and the embedded node, in one
  PUT — refusing while any other association still targets the node
  being removed, but nothing in `abap_bopf_edit` can create that
  embedding any more; see "Why embedding creation was removed" below.
  `isDependentObjectNode="false"` still does not mark delegation on this
  release — setting it through `set_node_flags` alone creates no
  embedding.
- **Observed once, not a rule: activating a BO with a cross-BO
  association present destroyed the ABAP session** with an
  `ASSERTION_FAILED` short dump in `/BOBF/CL_CONF_MODEL_API_MAP`. It was
  not retried, and the tool's own hint says such a dump is deterministic
  in the payload — treat it as a hazard to expect, not a confirmed rule.
  Separately unproven: whether the `implementationClassRef` above
  substitutes for the "Association has to have exactly one Attribute
  Binding" activation demand that appeared when the class was absent;
  the run that supplied the class short-dumped before any activation
  message came back.
- **Why embedding creation was removed.** `embed_dependent_object` was
  removed by the same live run. Sending a `DoComposition` association
  plus a matching `<name>.ROOT` node answered 200, but the read-back had
  `bo:implementationType` rewritten to `Composition` and
  `bo:doEmbeddingName` dropped; activation separately rejected the
  dotted node name (`Node name contains characters that are not
  allowed`) — even though SAP's own `/BOBF/DEMO_SALES_ORDER` contains
  exactly such a node (`ROOT_LONG_TEXT.ROOT`). So the shape a GET returns
  is the server's own output, not a legal input. A second live run then
  tried the two remaining candidate shapes, and **both failed** — the
  negative is settled for this endpoint on this release, not a gap
  waiting on evidence:
  - *Verbatim transplant* — SAP's own `ROOT_LONG_TEXT` association and
    node bytes, copied out of `/BOBF/DEMO_SALES_ORDER` and sent back
    unchanged except for the host URIs, the parent nodeID, and re-minted
    nodeIDs, in one PUT. **Threw at `/BOBF/ST_CONF_ADT`** — the same
    deserializer error a parentless node gives, even though this node
    was correctly parented, so that error is not specific to parentless
    nodes. Nothing persisted; the BO re-activated unchanged.
  - *Target-the-DO* — one association only, no node, `DoComposition`
    with `targetNodeRef` naming the dependent object's own root
    (`/BOBF/DEMO_TEXT_COLLECTION~ROOT`) rather than a local
    `<name>.ROOT`, on the theory that the server mints the proxy node
    the way it demonstrably mints `REP_*` nodes above. **Answered 200
    with an empty body and silently discarded the association** — the
    read-back has no `bo:associations` at all and no minted node; only
    the version flipped to inactive. This is worse than the rewrite
    above: no diagnostic is surfaced anywhere.
  So a `DoComposition` embedding cannot be created through this endpoint
  in any shape tried, and the operation is not reinstatable without a
  different endpoint. What is still untested is a *two-step* PUT
  (association first, node second) and isolating which part of the
  transplant the deserializer objects to — neither promises anything.
  Everything established is recorded here, not in any external report.
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
