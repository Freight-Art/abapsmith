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
association, action, determination, validation, query, or alternative
key; remove an embedded dependent object; or create the BO itself). A
representative node is not created directly — see the `add_association`
recipe below.

**Availability**: case 1 — registered only when `canWrite`.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `bo` | string | yes | — | Business object name. |
| `operation` | enum `create_bo` \| `add_node` \| `remove_node` \| `add_association` \| `remove_association` \| `add_action` \| `remove_action` \| `add_determination` \| `remove_determination` \| `add_validation` \| `remove_validation` \| `add_query` \| `remove_query` \| `add_alternative_key` \| `remove_alternative_key` \| `set_node_flags` \| `set_association_fields` \| `set_action_fields` \| `set_determination_fields` \| `set_validation_fields` \| `set_query_fields` \| `set_alternative_key_fields` \| `remove_dependent_object` \| `activate` | yes | — | The single edit to make. |
| `node` | string | no | — | Existing node the operation targets. |
| `nodeId` | string | no | — | Disambiguator when node name alone is not unique. |
| `name` | string | required except for `create_bo`/`remove_node`/`set_node_flags`/`activate` | — | Name of the new node/association/action/etc. being added, or removed. |
| `spec` | object (free-form) | no | — | Operation-specific fields. `add_node` requires `spec.parent` or `spec.parentNodeId`. `add_alternative_key` requires `spec.uniqueness`, `spec.dataTypeRef`, `spec.dataTableTypeRef`, and `spec.keyElements`. |
| `activate` | boolean | no | — | Also activate after the edit succeeds. |
| `allow_dangling_ref` | boolean | no | — | Proceed even if `spec.class` or a trigger's action doesn't exist yet, or, for `add_alternative_key`, a `spec.keyElements` entry isn't a property of the target node or the node has no `persistentStructureRef`. Does not bypass the `checkAfterModify`/`checkBeforeSave`/`noCheck` refusals below — those are refused unconditionally. |
| `i_know_this_may_not_activate` | boolean | required (`true`) for `add_alternative_key`/`set_alternative_key_fields` | — | Explicit acknowledgment — the key element writes, but a business object carrying one has not been observed to activate. |
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

`create_bo` always sends the root `bo:nodes` element with an explicit
non-empty `bo:name` (`rootNodeName`, default `"ROOT"`). An unnamed root has
been observed on objects that landed from a create whose session died
mid-request — a partially-processed create the client cannot prevent, only
detect. BOPF generates the `Z*_C` constants interface from the root node
name at create time and never regenerates it, so an unnamed root is
permanently unactivatable and renaming it afterward does not repair the
interface. If the object that lands has an unnamed root, or no root node at
all, `create_bo` refuses with `BOPF_CREATE_UNUSABLE` instead of reporting
success; the business object still exists and must be removed with
`abap_bopf_delete` before retrying, and the journal entry id of the create
is in the error details. A root node that exists under a different non-empty
name is reported as a discrepancy note, not refused. See
`test/bopf-create-recovery.test.ts`.

`add_node` needs a parent — `spec.parent` (the parent node's name) or
`spec.parentNodeId` — unless `spec.rootNode: true`. abapsmith writes
`bo:parent` and `bo:parentNodeID` as a matched pair, because BOPF accepts a
node carrying only one of them with a 200 and then discards it. Neither
given, and `spec.rootNode` not `true`, is refused before anything is
sent — a live discovery run found a client-written parentless node is
hard-rejected by the server (`An error occurred when deserializing in the
simple transformation program /BOBF/ST_CONF_ADT`), so `add_node` cannot
build that shape at all; the refusal instead names the `add_association`
cross-BO recipe below, which gets a representative node minted by the
server. `add_node` also refuses `spec.doEmbeddingName` or
`spec.isDependentObjectNode: true` (there is no operation left that
creates a delegated embedding — see `remove_dependent_object` below for
the removal side), and `add_association` likewise refuses
`spec.implementationType: "DoComposition"` or a `spec.doEmbeddingName`.
`add_node` also re-reads after the write and fails with `CHECK_FAILED` if
the node isn't in the model, rather than reporting success with an
unchanged `nodeCount`.

`add_alternative_key` requires `spec.uniqueness`, `spec.dataTypeRef`,
`spec.dataTableTypeRef` and `spec.keyElements` — all four, no defaults. Every
`bo:alternativeKeys` element in the captured wire XML carries all four; a
partial one made `/BOBF/CL_CONF_MODEL_API_MAP` fail an assertion that took
down the whole ADT session. `spec.uniqueness` is a closed enum —
`"unique"`, `"uniqueIfNotInitial"`, `"notUnique"` — refused client-side like
`category` on determinations/validations/queries. `spec.checkAfterModify`,
`spec.checkBeforeSave` and `spec.noCheck` all map onto the one server-side
`uniqueness_check` field BOPF's model mapper switches on, so at most one may
be `true`; `checkBeforeSave: true` is refused outright, on any uniqueness,
because the mapper's own arm for it is `ASSERT 1 = 0. " currently not
supported`. With `uniqueness: "unique"` or `"uniqueIfNotInitial"`, exactly
one of `noCheck: true` or `checkAfterModify: true` is required — the
mapper's arms for those two uniqueness values have no case for an initial
`uniqueness_check` and fall into `WHEN OTHERS. ASSERT 1 = 0.`, which is the
short dump. With `uniqueness: "notUnique"`, `checkAfterModify: true` is
refused (that arm has no case for it either); `noCheck: true` or no check
flag at all is accepted, since that arm's case list includes the blank
value. All of this is refused client-side, before any HTTP request, as
`BAD_INPUT`, and none of it is overridable with `allow_dangling_ref`. It
re-reads after the write and fails with `CHECK_FAILED` if the key count on
that node didn't go up, rather than reporting success the server discarded.

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
bypass. The write itself is now live-confirmed to succeed: with a check flag
that clears the rules above, the key lands on the node, on a business object
in `$TMP` with a real structure reference, on both a DDIC structure borrowed
from an SAP demo object and a purpose-built one. Without a check flag, or
with an incompatible one, the same session-killing short dump in
`/BOBF/CL_CONF_MODEL_API_MAP` was reproduced, which is what the refusals
above now stop before the PUT is even sent. What remains open is
activation, not the write: no business object carrying a key added this way
has been observed to activate — see `i_know_this_may_not_activate` above and
the alternative-key row in `doc/CAPABILITIES/bopf.md`.

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
invalid alternative-key payload. The same check-mode rule as
`add_alternative_key` applies — `checkBeforeSave: true` refused, at most one
of `checkAfterModify`/`checkBeforeSave`/`noCheck`, and a required flag
matching `uniqueness` — but it is checked against the EFFECTIVE post-patch
state: the attributes already on the element as read from the server, with
this patch applied on top. Patching `uniqueness` to `"unique"` on a key that
already carries `noCheck="true"` is fine; clearing the last check flag on
such a key (`noCheck: null` with nothing else set) is refused the same as
creating that shape from scratch would be. The write is live-confirmed to
succeed once the effective state clears those rules; the operation is not
confirmed to leave the business object able to activate. Patchable per kind: association
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

There is no operation that writes a representative node or an embedded
dependent object directly. A live discovery run against a real SAP system
found that the write shapes the former `add_representative_node` and
`embed_dependent_object` operations sent do not survive the server, so
both were removed (along with `remove_representative_node`, which had
nothing left to remove). What still works for each:

**Representative node — get one via a cross-BO `add_association`.** A
plain `Association` on the node that should carry the link —
`spec.implementationType: "Association"`, `spec.targetNodeRef` naming
another BO's node, and `spec.implementationClassRef` naming an XBO class
— answers 200, and the server mints a parentless, non-root node alongside
it, named `REP_<random>` (observed `REP_TYVJRJ3REEP6DKVELQE77P7WKA`),
carrying only the fixed `KEY`/`PARENT_KEY`/`ROOT_KEY` properties — the
same shape `abap_bopf show` labels `representative`. The node name is
server-assigned and cannot be chosen. Confirmed live: issuing
`remove_association` against the cross-BO association removes the
minted node too — `nodeCount` fell from 2 to 1 and the node was gone
from the read-back. There is no dedicated create or remove for it.
`abap_bopf_edit` emits two notes on such a write recording this
recipe, including the observation (once, not confirmed as a rule) that
activating a BO with a cross-BO association present destroyed the ABAP
session with a short dump.

```json
{ "bo": "ZBOPF_DEMO", "operation": "add_association", "node": "ROOT", "name": "TO_CUSTOMER",
  "spec": { "implementationType": "Association",
            "targetNodeRef": { "name": "/BOBF/DEMO_CUSTOMER~ROOT", "type": "BOBF" },
            "implementationClassRef": { "name": "/BOBF/CL_C_DEMO_CUSTOMER_XBO", "type": "CLAS/OC" } } }
```

**Embedded dependent object — removal only.** `remove_dependent_object`
deletes the parent-node association and the embedded node in one PUT, and
refuses while any other association still targets the node being removed.
There is no operation to create an embedding on this release. Three
request shapes were tried live and all three failed — the server rewrote
the first, threw at the `/BOBF/ST_CONF_ADT` deserializer on the second,
and answered 200 while silently discarding the third — see
`doc/CAPABILITIES/bopf.md` for the bytes and the read-backs.

Example (remove a dependent-object embedding):

```json
{
  "bo": "ZBOPF_DEMO",
  "operation": "remove_dependent_object",
  "node": "ROOT",
  "name": "TEXT"
}
```

## abap_bopf_delete

Delete a BOPF business object, optionally cascading into its DDIC objects.

**Availability**: case 1 — registered only when `canWrite`.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `bo` | string | yes | — | Business object to delete. |
| `confirm` | string | required when `dry_run:false` | — | Echo `bo` exactly (case-insensitive) to arm the delete. |
| `cascade_ddic` | boolean | no | — | Also delete the DDIC objects this BO generated (its combined table type, combined structure, constants interface). By default never deletes `persistentTableRef`/`persistentStructureRef` tables/structures — those are spared and reported separately unless named in `cascade_persistent`. |
| `confirm_cascade` | string | required in addition to `confirm` when `cascade_ddic:true` | — | Echo `bo` exactly again. |
| `cascade_persistent` | array of string | no | — | Exact DDIC names (case-insensitive) to delete despite being `persistentTableRef`/`persistentStructureRef`. Requires `cascade_ddic:true` (extends the cascade, doesn't replace it) and, on an armed delete, `confirm_cascade`. |
| `dry_run` | boolean | no | `true` | Report what would be deleted without deleting anything. |

Dry run (the default) lists DDIC candidates found in the model without
probing whether they still exist on the server — the armed delete may find
fewer, or report some already absent. An armed delete without `cascade_ddic`
does the same on its DDIC LEFT BEHIND list: it names the generated objects
from the model, not from a read-back, so a listed name (e.g. a BO's
combined table/structure before the BO was ever activated) is not
necessarily an object that exists.

`cascade_persistent` is the explicit, name-by-name opt-out from sparing
`persistentTableRef`/`persistentStructureRef` — it extends `cascade_ddic`,
it does not replace it. Every name is validated before anything is deleted;
any single failure refuses the whole call, having deleted nothing: the name
must be a `persistentTableRef` or `persistentStructureRef` this BO's model
actually references (an unreferenced name is refused, and the refusal lists
the names that are referenced); a name referenced from more than one site is
refused, counting each node separately so the same name on two different
nodes is refused even under the same ref slot, since deleting it would
break the other reference; the
object's package is read from its own ADT document and must equal the
business object's package, so a `/BOBF/*` demo structure shared by other
BOs, or anything else living elsewhere, is refused; a document with no
`<adtcore:packageRef adtcore:name>` is refused rather than guessed at.
Each resolved name is then asserted against the safety gate at `phase:
"preflight"`, before the business object's own authorization, the write
session, and the journal entry; a name in a reserved SAP namespace
(anything starting with `/`) is refused there regardless of the package
allowlist, and identically on a dry run, so a preview can never promise a
delete the armed call could not perform. Most of these refusals throw
`BAD_INPUT`; the safety-gate refusal throws its own code instead
(`SAFETY_DENIED`). Names are compared upper-cased.

Requested objects are deleted last — after the business object itself and
after the generated cascade candidates, tables before structures — and
reported under their own `DDIC DELETED ON REQUEST` section, using the same
per-object `existed=`/`deleted=`/`reason=` shape as `DDIC CASCADE RESULTS`
(`deleted` is `true` only once a read-back confirms the object is gone,
`unverified` when the read-back couldn't confirm it). Every name in
`cascade_persistent` is also filtered out of the `DDIC SPARED (provenance
unknown — never deleted)` section and out of the `ddicSparedCount` header
key, on both the dry run and the armed response, so an object never appears
simultaneously as spared and as deleted on request. A `dry_run` previews
the same section with `would delete`. Unlike the auto-enumerated
candidates, which a dry run deliberately does not existence-probe (a round
trip per candidate is not worth paying on a preview), the names in
`cascade_persistent` ARE probed on a dry run — the same probe is what
establishes the package, and a preview that hides a refusal the armed call
would hit is worse than the round trip. The write-journal entry for the
delete records each requested object as an entry `part`, with a
before-image captured from that probe, so `abap_journal show` lists them
under `ALSO TOUCHED` (the entry is still `irreversible: true` — a BOPF
delete can never be undone).

This is the fix for the throwaway-BO case: `abap_bopf_edit create_bo`
assigns a root node's `persistentTableRef` by defaulting (e.g.
`ZTMD_D_ROOT` for a root node named `ROOT`), and before `cascade_persistent`
that table needed a second, manual `abap_write mode: delete` once the BO
itself was gone.

```json
{ "bo": "ZTMD_DEMO", "confirm": "ZTMD_DEMO", "cascade_ddic": true,
  "confirm_cascade": "ZTMD_DEMO", "cascade_persistent": ["ZTMD_D_ROOT"],
  "dry_run": false }
```

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

