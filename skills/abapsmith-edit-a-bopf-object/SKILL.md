---
name: abapsmith-edit-a-bopf-object
description: Creates and edits BOPF business objects — nodes, associations, actions, determinations, validations, keys — and gets them to activate. Use for any abap_bopf_edit work.
---

# BOPF business objects

The highest error rate on this server. Every trap below is a **200 that means
failure**.

Every step below is an `operation` of **`abap_bopf_edit`**.

## Sequence

```
bopf_create
  → bopf_set_node_flags   ← not optional, see below
  → bopf_add_node / add_association / add_action /
    add_determination / add_validation / add_query
  → bopf_activate
```

A representative node is not on this list — it is minted by the server as
a side effect of `bopf_add_association`, see below.

`bopf_check_refs` and `bopf_test` run any time. So do the eight
`bopf_remove_*` operations — `remove_node` (`node` only) and
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

`bopf_create` and `bopf_activate` can each take over a minute on a larger
model. Both run under `ABAP_BOPF_TIMEOUT_MS` (default 180000 ms), not the
general `ABAP_TIMEOUT_MS`; on a client timeout abapsmith re-reads the
object on a fresh session (up to 6 reads, 5 seconds apart) and reports
success with a "completed on the server after the client timeout" note when
the re-read finds what it expects, or `TIMEOUT` — `retryable: false` once
the create is confirmed to have landed, `retryable: true` otherwise — when
it doesn't.

## Adding elements

Every closed enum below (`multiplicity`, `implementationType`,
`instanceMultiplicity`, `exportingParameterCategoryType`, determination/
validation/query `category`, `relationType`, alternative-key `uniqueness`)
is checked before anything is sent: an out-of-set value is refused
client-side as `BAD_INPUT`, listing every accepted value and its meaning —
none of the operations below reach the server with an invalid enum value.
If a spec is malformed in some other way that only the server catches,
BOPF answers with `ExceptionInvalidData` and an `XML_PATH`; abapsmith
decodes that path into the element this call touched and the candidate
fields on it, and surfaces both in the error's hint text plus
`error.details.specElement` — you don't have to read raw `bo:nodes(10)`
XPath fragments to find what's wrong.

- `bopf_add_node` needs a parent: **`spec.parent`** (the parent node's plain
  name) or **`spec.parentNodeId`**, either one — abapsmith resolves the other
  half from the model and writes both `bo:parent`/`bo:parentNodeID`, since BOPF
  200s and drops a node carrying only one of them. Neither given, without
  `spec.rootNode: true`, is refused before anything is sent — a
  client-written parentless node is hard-rejected by the server
  (`An error occurred when deserializing in the simple transformation
  program /BOBF/ST_CONF_ADT`), confirmed live three separate ways, so
  `add_node` cannot build that shape at all. The refusal names the
  `add_association` cross-BO recipe below instead. Two more hand-assembly
  guardrails stay: `add_association` refuses `implementationType:
  "DoComposition"` or any `doEmbeddingName`, and `add_node` refuses
  `doEmbeddingName` or `isDependentObjectNode: true` anywhere in the
  spec — there is no operation left that creates a delegated node; use
  `bopf_remove_dependent_object` only to remove one that already exists.
  `add_node` re-reads after the write and fails if the node isn't there, so
  success means it exists.
- `bopf_add_association`'s `spec.multiplicity` is a closed enum: `0_1`
  (optional to-one: at most one target instance), `0_N` (optional to-many:
  any number of target instances), `1_1` (mandatory to-one: exactly one
  target instance), `1_N` (mandatory to-many: at least one target instance;
  schema-only, never observed on the wire). `spec.implementationType` is
  likewise closed: `Composition` (parent-child composition — the target
  node is a child of the source node), `DoComposition` (composition to a
  delegated/dependent object — refused here, see above), `Association`
  (cross-node or cross-BO association resolved by the association class —
  what the representative-node recipe below uses), plus the schema short
  forms `C`/`A` for `Composition`/`Association` (not observed on the wire).
  An out-of-set value on either is refused `BAD_INPUT` before anything is
  sent, listing every accepted value and its meaning.
- `bopf_add_action`'s `spec.instanceMultiplicity` is a closed enum, from
  `/BOBF/IF_CONF_C` on the live system: `0` (static: runs without a node
  instance), `1` (single instance: exactly one node instance per call), `2`
  (multiple instances: any number of node instances per call — what SAP's
  own actions use). `spec.exportingParameterCategoryType` is likewise
  closed: `None` (the action exports nothing), `Type` (exports data of the
  DDIC type named in `parameterStructureRef`), `Node` (exports instances of
  a node). `spec.category` on an action is NOT an enum — it's an opaque
  numeric code (`ActionCategoryCode`) and is never checked. Full example:
  ```
  add_action(node: "ROOT", name: "RECALCULATE",
    spec: { xmlName: "RECALCULATE", category: "0", instanceMultiplicity: "2",
            exportingParameterCategoryType: "None", exportParameterLink: false,
            isExtensible: false, objectModelGenerated: false,
            parameterStructureRef: { name: "ZBOPF_S_RECALC_PARAMS", type: "TABL/DS" },
            implementationClassRef: { name: "ZCL_DEMO_ORDER_ACTION", type: "CLAS/OC" } })
  ```
- **Representative node — no create operation, get one from
  `bopf_add_association`.** Add a plain cross-BO association on the node
  that should carry the link: `spec.implementationType: "Association"`,
  `spec.targetNodeRef: { name: "/BOBF/DEMO_CUSTOMER~ROOT", type: "BOBF" }`
  naming the other BO's root node, and `spec.implementationClassRef`
  naming an XBO class (e.g. `/BOBF/CL_C_DEMO_CUSTOMER_XBO`). The server
  mints a parentless, non-root node alongside it, named `REP_<random>`
  (observed `REP_TYVJRJ3REEP6DKVELQE77P7WKA`) — no structure refs, just
  the fixed `KEY`/`PARENT_KEY`/`ROOT_KEY` properties, the same shape
  `abap_bopf show` labels `representative`. The name is server-assigned
  and cannot be chosen or predicted. Confirmed live:
  `bopf_remove_association` removes it too — the node count fell from
  2 to 1 once the association was gone. No dedicated create or remove
  exists for it.
  ```
  add_association(node: "ROOT", name: "TO_CUSTOMER",
    spec: { implementationType: "Association",
            targetNodeRef: { name: "/BOBF/DEMO_CUSTOMER~ROOT", type: "BOBF" },
            implementationClassRef: { name: "/BOBF/CL_C_DEMO_CUSTOMER_XBO", type: "CLAS/OC" } })
  ```
  Observed once, not a confirmed rule: activating a BO with such a
  cross-BO association present destroyed the ABAP session with an
  `ASSERTION_FAILED` short dump in `/BOBF/CL_CONF_MODEL_API_MAP`. Treat it
  as a hazard, not something proven deterministic — it was not retried.
- **Embedded dependent object — removal only, no create operation.**
  `bopf_remove_dependent_object` (`node` + `name`) deletes an existing
  embedding's parent-node association and node in one PUT, and refuses
  while any other association still targets the node being removed. There
  is no way to create an embedding through abapsmith on this release: a
  live discovery run found the write shape the removed
  `embed_dependent_object` operation sent gets rewritten by the server
  (`bo:implementationType` came back `Composition` with
  `bo:doEmbeddingName` dropped) and the resulting node name is rejected at
  activation. A second run tried the two remaining candidate shapes — a
  byte-verbatim transplant of SAP's own `ROOT_LONG_TEXT` embedding, and a
  `DoComposition` association naming the dependent object's own root — and
  both failed too: the first threw at the `/BOBF/ST_CONF_ADT` deserializer,
  the second answered 200 and silently discarded the association. Do not
  attempt to hand-assemble one with `add_node` / `add_association` — both
  refuse the shape outright, see above.
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
  `relationType` is a closed enum: `predecessor` (the named determination
  runs before this one) or `successor` (the named determination runs after
  this one).
- `bopf_add_determination.spec.category` should always be set explicitly.
  Omitted, BOPF defaults it server-side to the literal string `"undefined"` and
  the determination's triggers silently never fire — no error, no activation
  failure, just inert. Valid determination categories: `reactAfterModification`
  (runs after instances of the trigger node are created/updated/deleted),
  `calculateTransientAttributes` (fills transient attributes when instances
  are loaded or changed), `calculateTransientSubNodeInstances` (fills
  transient sub-node instances when the parent is loaded),
  `calculateProperties` (computes field/action/association properties —
  enabled, read-only, mandatory), `reactOnCheckAndDetermine` (runs when the
  consumer calls check-and-determine), `reactBeforeSave` (runs at the start
  of the save sequence, before validations), `drawNumbersDuringCreate`
  (draws numbers for new instances at creation time), `drawNumbersDuringSave`
  (draws numbers for new instances during save), `reactDuringSave` (runs
  during the save sequence after validations), `reactAfterSuccessfulSave`
  (runs after the database commit succeeded), `reactAfterCleanupTransaction`
  (runs when the transaction is cleaned up, after commit or rollback), and
  `reactAfterFailedSave` (runs after the save failed). `consistencyCheck`
  (checks the trigger node's instances and reports messages; runs on
  check-and-determine and during save) and `actionCheck` (decides whether
  the trigger action may run on the given instances) are
  `bopf_add_validation`-only categories — not valid on a determination. An
  out-of-set `category` on either kind is refused client-side as
  `BAD_INPUT`, listing every accepted value and its meaning; `"undefined"`
  is in the type but refused for exactly the reason above.
- **Class references are never checked** — not at PUT, not at activation, not at
  runtime. A dangling or wrong-interface `implementationClassRef` silently never
  fires. abapsmith preflights that the class source exists and throws
  `BOPF_DANGLING_REF`. `allow_dangling_ref: true` accepts the risk; it does not
  fix anything.
- `bopf_add_alternative_key` needs the complete shape — `uniqueness`,
  `dataTypeRef`, `dataTableTypeRef` and `keyElements`, all four. `uniqueness`
  is a closed enum: `unique` (key values must be unique across all
  instances), `uniqueIfNotInitial` (unique unless the key value is initial —
  what SAP's own keys use), `notUnique` (no uniqueness enforced, a plain
  secondary access path). An out-of-set value is refused client-side as
  `BAD_INPUT`, listing every accepted value and its meaning. A partial shape
  **used to take down the whole ADT session** with an assertion inside
  BOPF's model mapper; a missing field is now refused before anything is
  sent. `i_know_this_may_not_activate: true` is still required. It re-reads
  after the write and fails `CHECK_FAILED` if the key isn't there, so
  success means it exists.
  **Working order matters**: every `keyElements` name must already be a field
  on the target node, and the node needs a `persistentStructureRef`, before
  you call this — both are now preflighted and refused as `BOPF_DANGLING_REF`
  (override: `allow_dangling_ref: true`), so in practice set
  `persistentStructureRef` via `bopf_set_node_flags` before adding the key.
  Confirmed: the structure's fields appear as node properties as soon as
  `persistentStructureRef` is assigned, not only at activation — measured
  before and after activating a fresh BO with the ref set while still
  inactive; the property list did not change.
  **Pass exactly one check flag, chosen by `uniqueness`:**
  ```text
  { "uniqueness": "unique",            "noCheck": true }              // accepted, not live-tested
  { "uniqueness": "unique",            "checkAfterModify": true }     // accepted, not live-tested
  { "uniqueness": "uniqueIfNotInitial", "noCheck": true }             // live-confirmed to write
  { "uniqueness": "uniqueIfNotInitial", "checkAfterModify": true }    // live-confirmed to write
  { "uniqueness": "notUnique" }                                       // live-confirmed to write
  { "uniqueness": "notUnique",         "noCheck": true }              // accepted, not live-tested
  ```
  `checkBeforeSave: true` is refused outright on any `uniqueness` — that arm
  of BOPF's model mapper is `ASSERT 1 = 0. " currently not supported`. Two of
  `checkAfterModify`/`checkBeforeSave`/`noCheck` set `true` together is
  refused — they map onto one server-side field. On `unique`/
  `uniqueIfNotInitial`, omitting the check flag entirely is refused, not
  defaulted, because the mapper's arms for those two values have no case for
  a blank one and fall into `WHEN OTHERS. ASSERT 1 = 0.` — that assert is the
  short dump. On `notUnique`, `checkAfterModify: true` is refused (no case
  for it there either); no flag at all is fine. All of this is refused
  client-side before any request is sent, and `allow_dangling_ref` does not
  bypass it — there is no override, because the only thing an override could
  do is let a caller kill their own session.
  **The write itself is confirmed live**: with a compatible check flag, the
  key element lands on the node — on `$TMP` business objects, on both a DDIC
  structure borrowed from an SAP demo object and a purpose-built one. What is
  NOT confirmed is activation: no business object carrying a key added this
  way has been observed to activate. A `TABL/DS` `dataTypeRef` draws a
  severity-E `"Data Type of Alternative Key <NAME> is not of type 'Data
  element'"` message on `bo:dataTypeRef` at activation time; a `DTEL/DE`
  `dataTypeRef` draws no message, but the business object then activates
  with `activated: false` and zero activation messages — removing the key
  and activating again succeeds. `i_know_this_may_not_activate: true` is
  required for exactly this reason: the element writes, the business object
  then does not activate. `unique` + `noCheck: true` has not been exercised;
  one line of the mapper's `CASE` for the `unique` branch, read during a live
  investigation, suggests it is silently rewritten to internal number
  allocation instead of taking the flag at face value.

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
wins, and `implementationClassRef: null` clears it. The same enum checks as
the `bopf_add_*` calls apply here — `multiplicity`, `implementationType`,
`instanceMultiplicity`, `exportingParameterCategoryType`, `category`
(determination/validation/query, not action) and
`uniqueness` are all still closed enums with the same accepted values and
meanings listed above, and an out-of-set value is still refused client-side
as `BAD_INPUT` before any request is sent, whether the call is an `add_*`
or a `set_*_fields`. `null` is accepted on these to clear the field where
the field itself is optional.
`bopf_set_alternative_key_fields` has no implementation class, so neither
applies there — and, like `bopf_add_alternative_key`, it requires
`i_know_this_may_not_activate: true`, because a patch's attributes go
through the same `/BOBF/CL_CONF_MODEL_API_MAP` model mapper that has
short-dumped the ADT session on an invalid alternative-key payload. The same
check-flag rule applies (`checkBeforeSave: true` refused; at most one of
`checkAfterModify`/`checkBeforeSave`/`noCheck`; a required flag on `unique`/
`uniqueIfNotInitial`; `checkAfterModify` refused on `notUnique`), but it is
checked against the EFFECTIVE post-patch state — the element's attributes as
read from the server, with this patch applied on top. Patching `uniqueness`
to `"unique"` on a key that already carries `noCheck="true"` is fine;
sending `noCheck: null` to clear the last check flag on that same key is
refused, same as building that shape from scratch would be. The write is
confirmed live once the effective state clears those rules; activation is
not confirmed, same as `bopf_add_alternative_key` above. Each re-reads after
the write and fails `CHECK_FAILED` if a named field didn't stick or a second
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
only reports. `cascade_ddic` still spares a node's auto-defaulted
`persistentTableRef`/`persistentStructureRef` — e.g. the `ZTMD_D_ROOT` table
`create_bo` defaults onto a root node named `ROOT` — since abapsmith has no
provenance to tell a defaulted table from a foreign structure the BO merely
points at. Pass `cascade_persistent: ["ZTMD_D_ROOT"]` on the same call to
remove those too; the `create_bo`/`add_node` response already names the exact
one to pass. See `abap_bopf_delete` in `doc/TOOLS/bopf.md` for the validation
rules.

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

`bopf_remove_dependent_object` (`node` + `name` — the parent node and the
embedding name) removes an existing dependent-object embedding — the
parent-node association and its node, in one call. It refuses while any
other association still targets the node being removed — remove that
association first. It runs the same post-write re-read as every other
`remove_*` operation. A representative node has no dedicated remove:
removing the link with `bopf_remove_association` takes the server-minted
node with it — confirmed live, the node count fell from 2 to 1 once the
association was gone. See Adding elements above.

**Duplicate-name symptom**: a BO that stops activating because it carries two
elements of the same kind and name. Re-adding under an existing `name`
through `add_action`/`add_determination`/`add_validation`/`add_query`/
`add_alternative_key` is now refused up front, naming the existing element,
so this can no longer be created through the tool — but a duplicate that
already exists on the server-side model (created before this refusal, or by
some other route) still needs clearing. Fix: call the matching `remove_*`
once per duplicate. Each call only takes the first match in document order,
so it takes two calls to clear one duplicate pair.
