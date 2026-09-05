---
name: abapsmith-edit-a-bopf-object
description: Creates and edits BOPF business objects — nodes, associations, actions, determinations, validations, keys — and gets them to activate. Use for any abap_bopf_edit work.
---

# BOPF business objects

The highest error rate on this server. Every trap below is a **200 that means
failure**.

Every step below is an `operation` of **`abap_bopf_edit`** on the default v1
surface. On v2 the same operations are actions of **`abap_do`** — same names, same
shapes, one tool instead of four. Check `tools/list` before assuming which.

## Sequence

```
bopf_create
  → bopf_set_node_flags   ← not optional, see below
  → bopf_add_node / add_association / add_action /
    add_determination / add_validation / add_query /
    add_representative_node / embed_dependent_object
  → bopf_activate
```

`bopf_check_refs` and `bopf_test` run any time. So do the nine `bopf_remove_*`
operations — `remove_node` / `remove_representative_node` (`node` only) and
`remove_association` / `remove_action` / `remove_determination` /
`remove_validation` / `remove_query` / `remove_alternative_key` /
`remove_dependent_object` (`node` + `name`), see Deleting below. `bopf_delete`
is terminal and admin-only.

## A fresh BO cannot activate until you set node flags

`bopf_create`'s auto-generated ROOT node has **none of its structural refs set**.
Activation fails with *"Data structure is missing"*. `bopf_set_node_flags` with
`spec.persistentStructureRef` is the only repair. Do this immediately after create.
It re-reads after the write and fails `CHECK_FAILED` — naming the field, the
value sent, and the value read back — if the server didn't keep a flag, ref,
or rename, so a successful call here means the ref actually stuck.
Address the node by **name** (`"ROOT"`); the raw nodeId string 404s.

`spec` also accepts `combinedStructureRef`/`combinedTableRef`/`persistentTableRef`/
`transientStructureRef`/`defaultingClassRef`/`dataAccessClassRef`/
`authorizationClassRef`, each `{ name, type[, uri] }` or `null` to clear. It also
sets the 10 boolean node flags and can rename a node via `spec.name`. Any ref or
flag can be cleared with `null`.

## Two naming rules that cost a round trip each

- The persistent structure's name may **not** carry `_` in position 2 or 3 —
  `ZS_BOP_A` is rejected (DDIC `DT101`); `ZSBOP_A` is fine.
- **`KEY` is reserved by BOPF** as a node field name. DDIC accepts it; BOPF
  refuses at activation. Name it `ID` or `KEY_ID`.

## Create is not atomic

A `bopf_create` that reports 500 or 400 **may still have created the object**.
abapsmith re-GETs on any throw:

- Response says `recovered: true` → **the object exists. Do not re-issue the create.**
- No `recovered` note → genuinely failed.

Never retry a create blind.

`bopf_create` and `bopf_delete` **refuse every transportable package.** Local /
`$TMP` only. Do not look for a flag to override it.

## Adding elements

- `bopf_add_node` needs a parent: **`spec.parent`** (the parent node's plain
  name) or **`spec.parentNodeId`**, either one — abapsmith resolves the other
  half from the model and writes both `bo:parent`/`bo:parentNodeID`, since BOPF
  200s and drops a node carrying only one of them. Neither given, without
  `spec.rootNode: true`, is refused before anything is sent — and now, if
  neither is given, the refusal also names `bopf_add_representative_node` as
  the operation for a genuinely parentless node. `add_node` and
  `add_association` both refuse a hand-assembled delegation attempt —
  `implementationType: "DoComposition"` or a `doEmbeddingName` anywhere in
  the spec — and name `bopf_embed_dependent_object` instead; there is no way
  to build a delegated node through the generic operations any more.
  `add_node` re-reads after the write and fails if the node isn't there, so
  success means it exists.
- `bopf_add_representative_node` (`name` = the new node's name,
  `spec.representedBo` required, `spec.xmlName` optional) creates a
  parentless, non-root node with no structure refs and exactly the
  properties `KEY`, `PARENT_KEY`, `ROOT_KEY`, all three CUD flags `true`.
  `representedBo` is preflighted — it must resolve to a real business
  object — but it is **not written anywhere on the node**; it exists only
  to stop the operation naming a business object that doesn't exist. The
  actual cross-BO link is a separate step: `bopf_add_association` on
  whatever node needs the reference, with `spec.implementationType:
  "Association"` and `spec.targetNodeRef: { name:
  "/BOBF/DEMO_CUSTOMER~ROOT", type: "BOBF" }` naming the represented BO's
  own root node — real captures of that association also carry a
  `spec.implementationClassRef` naming a generated `*_XBO` class, and BOPF
  may require one too. Worked sequence:
  ```
  add_representative_node(name: "CUSTOMER_REF", spec: { representedBo: "/BOBF/DEMO_CUSTOMER" })
    → add_association(node: "ROOT", name: "TO_CUSTOMER",
        spec: { implementationType: "Association",
                targetNodeRef: { name: "/BOBF/DEMO_CUSTOMER~ROOT", type: "BOBF" } })
  ```
- `bopf_embed_dependent_object` (`node` = the parent node, `name` = the
  embedding name `<EMB>`, `spec.dependentObject` required, `spec.xmlName`
  optional, `spec.multiplicity` defaults to `0_1`,
  `spec.implementationClassRef` defaults to
  `/BOBF/CL_C_BOPF_2_BOPF_SIMPLE`) writes both halves of a delegated node
  in one PUT: a `DoComposition` association on the parent plus a
  `<EMB>.ROOT` node. `dependentObject` is preflighted with a `readModel`
  that must report `objectCategory: "dependentObject"`, so an object that
  isn't really a dependent object is refused before anything is sent.
  Because the host BO's XML never names the dependent object, a 200 plus a
  matching re-read still cannot confirm the embedding actually works, so
  this operation also requires `i_know_this_may_not_activate: true` — refused
  before anything is sent without it. Worked sequence:
  ```
  embed_dependent_object(node: "ROOT", name: "TEXT",
    spec: { dependentObject: "/BOBF/DEMO_TEXT_COLLECTION" },
    i_know_this_may_not_activate: true)
  ```
  One more thing this operation cannot give you: `isDependentObjectNode` is
  written `false` on the generated `<EMB>.ROOT` node as part of the normal
  shape, and setting it to `true` yourself through `bopf_set_node_flags`
  does **not** create an embedding — the flag doesn't mark delegation on
  this release. The post-write re-read confirms the node/association pair
  exists, nothing more.
- `bopf_add_determination`/`bopf_add_validation` cannot attach a trigger later.
  `spec.triggers` is read only inside the original `add_determination`/
  `add_validation` call — get it right or delete and recreate. Every other
  field on a determination/validation no longer needs that dance:
  `bopf_set_determination_fields`/`bopf_set_validation_fields` can repair
  `category`, `xmlName`, and the rest afterward. Each entry is
  `{ node?, association?, actionNode?, action?, create?, update?, delete?,
  load?/determine?, check? }`: `node` is the WATCHED node (may differ from this
  rule's own node), `association` lives on that watched node and points back
  toward this rule's node — never a downward one. Omitting both `node` and
  `association` makes a self-trigger. `action` is validation-only (a
  determination's trigger rejects it outright); it names a trigger action on
  `actionNode` (defaults to this rule's own node), and a trigger can carry only
  `action` for a purely action-gated form. `create`/`update`/`delete` apply to
  both kinds; `load`/`determine` are determination-only, `check` is
  validation-only. A trigger `action` that doesn't exist on its node is refused
  as a dangling ref (`allow_dangling_ref` override, same as class refs).
  `bopf_add_determination` alone also takes `spec.relations`: `{ node
  (required — the node both determinations live on), determination?,
  relationType? }`, used to order determinations relative to each other.
- `bopf_add_determination.spec.category` should always be set explicitly.
  Omitted, BOPF defaults it server-side to the literal string `"undefined"` and
  the determination's triggers silently never fire — no error, no activation
  failure, just inert. Valid determination categories: `reactAfterModification`,
  `calculateTransientAttributes`, `calculateTransientSubNodeInstances`,
  `calculateProperties`, `reactOnCheckAndDetermine`, `reactBeforeSave`,
  `drawNumbersDuringCreate`, `drawNumbersDuringSave`, `reactDuringSave`,
  `reactAfterSuccessfulSave`, `reactAfterCleanupTransaction`,
  `reactAfterFailedSave`. `consistencyCheck`/`actionCheck` are
  `bopf_add_validation`-only categories — not valid on a determination.
- **Class references are never checked** — not at PUT, not at activation, not at
  runtime. A dangling or wrong-interface `implementationClassRef` silently never
  fires. abapsmith preflights that the class source exists and throws
  `BOPF_DANGLING_REF`. `allow_dangling_ref: true` accepts the risk; it does not
  fix anything.
- `bopf_add_alternative_key` needs the complete shape — `uniqueness` (`unique`
  / `uniqueIfNotInitial` / `notUnique`), `dataTypeRef`, `dataTableTypeRef` and
  `keyElements`, all four. A partial one **used to take down the whole ADT
  session** with an assertion inside BOPF's model mapper; a missing field is
  now refused before anything is sent. `i_know_this_may_not_activate: true` is
  still required. It re-reads after the write and fails `CHECK_FAILED` if the
  key isn't there, so success means it exists.
  **Working order matters**: every `keyElements` name must already be a field
  on the target node, and the node needs a `persistentStructureRef`, before
  you call this — both are now preflighted and refused as `BOPF_DANGLING_REF`
  (override: `allow_dangling_ref: true`), so in practice set
  `persistentStructureRef` via `bopf_set_node_flags` before adding the key.
  Confirmed: the structure's fields appear as node properties as soon as
  `persistentStructureRef` is assigned, not only at activation — measured
  before and after activating a fresh BO with the ref set while still
  inactive; the property list did not change. This preflight only stops a
  request shaped like the known session-killing repro — a complete,
  enum-valid spec that clears both checks has still short-dumped the ADT
  session. `add_alternative_key` is not confirmed to succeed on any node.

## Changing elements in place

`bopf_set_association_fields` / `bopf_set_action_fields` /
`bopf_set_determination_fields` / `bopf_set_validation_fields` /
`bopf_set_query_fields` / `bopf_set_alternative_key_fields` mirror
`bopf_set_node_flags`: address by `node` + `name`, pass only the fields that
need to change in `spec`, and everything else on that element — attributes,
refs, and every child element — is left byte-for-byte alone. `null` clears an
attribute or a ref, same as `bopf_set_node_flags`. On the five kinds with an
implementation class (association, action, determination, validation,
query), `spec.class`/`spec.implementationClass` (a bare class name) works as
a shorthand for `implementationClassRef`, wrapped as `CLAS/OC` exactly as
the matching `bopf_add_*` accepts it; an explicit `implementationClassRef`
wins, and `implementationClassRef: null` clears it.
`bopf_set_alternative_key_fields` has no implementation class, so neither
applies there — and, like `bopf_add_alternative_key`, it requires
`i_know_this_may_not_activate: true`, because a patch's attributes go
through the same `/BOBF/CL_CONF_MODEL_API_MAP` model mapper that has
short-dumped the ADT session on an invalid alternative-key payload, and the
operation is not confirmed to succeed on any node. Each re-reads after the
write and fails `CHECK_FAILED` if a named field didn't stick or a second
element with that name turned up.

Not patchable this way: `spec.triggers`/`spec.relations` on a determination
and `spec.triggers` on a validation (still write-once, see above), an
alternative key's `spec.keyElements`, and `name` on any of the six —
renaming would orphan the XPath fragments that triggers and relations embed.

`bopf_add_association`/`add_action`/`add_determination`/`add_validation`/
`add_query`/`add_alternative_key` now refuse up front, before
sending anything, when an element of that kind and name already exists on
the target node — naming the existing one instead of creating a duplicate.

## Never author a payload

There is no per-node or per-element endpoint — a PUT replaces the **entire** model.
abapsmith does GET-mutate-PUT under lock inside the handler. Use the per-element
operations; never hand-build model XML.

## Verify

**Activation always returns 200**, including on failure. Read
`chkl:messages/@type` — any `E` means it failed, free in the response. A clean
activation with no `E` messages needs no re-GET — same success-path trust as
`abapsmith-create-an-object`'s `speculative` mode; re-GET and confirm
`adtcore:version="active"` yourself only if you have a specific reason to
doubt it.

**`bopf_test` writes real rows.** It is not a dry run unless `scenario.cleanup` is
set. Its `save()` can set `ev_rejected='X'` — nothing persisted — while the call
returns 200 and raises nothing. Check the rejection note, not the absence of an
error. `generate_only: true` builds the bridge without running it.

## Deleting

`bopf_delete` leaves BOPF's **generated DDIC objects behind** — roughly 7 tables,
table types and structures plus a constants interface for a 2-node BO. Orphans
collide with a later create using the same naming pattern. Use `cascade_ddic` +
`confirm_cascade` to remove them. `dry_run` defaults to `true`, so a bare call
only reports.

To remove one element instead of the whole BO: `bopf_remove_node` (`node`
only) and `bopf_remove_association` (`node` + `name`) remove those two
kinds. `remove_node` on the BO's root node is refused — that's a whole-BO
delete, use `bopf_delete` instead. `remove_action` / `remove_determination` / `remove_validation` /
`remove_query` / `remove_alternative_key` (`node` + `name`) cover the other
five. If `name` matches more than one element on that node, these five take
the **first one in document order** — call the same operation again for the
next. They re-read after the write and fail `CHECK_FAILED`, naming both
counts, if the count on that node didn't go down, and fail `NOT_FOUND`,
listing what IS there, if nothing by that name exists.

`bopf_remove_representative_node` (`node` only) and
`bopf_remove_dependent_object` (`node` + `name` — the parent node and the
embedding name) remove the pairs `add_representative_node` and
`embed_dependent_object` create. Both refuse while any association still
targets the node being removed — remove that association first. Both run
the same post-write re-read as every other `remove_*` operation.

**Duplicate-name symptom**: a BO that stops activating because it carries two
elements of the same kind and name. Re-adding under an existing `name`
through `add_action`/`add_determination`/`add_validation`/`add_query`/
`add_alternative_key` is now refused up front, naming the existing element,
so this can no longer be created through the tool — but a duplicate that
already exists on the server-side model (created before this refusal, or by
some other route) still needs clearing. Fix: call the matching `remove_*`
once per duplicate. Each call only takes the first match in document order,
so it takes two calls to clear one duplicate pair.
