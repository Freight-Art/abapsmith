## Object types

This lists every ABAP object type abapsmith has a registry entry for, with
what it can and cannot do to each. The table below is derived mechanically
from `src/adt/capabilities.ts` and `src/adt/types.ts` and is pinned by
`test/capability-matrix-doc.test.ts`: a registry change that is not
reflected here fails the suite. See [legend.md](legend.md) for what `yes`,
`partial`, `no`, `n/a`, `live`, `tests`, `mixed` and `unverified` mean.

### How the object rows are derived

- **Create** — `yes` when the type is in `VERIFIED_CREATABLE_TYPES`; `no` when
  it is in `BRIDGE_CREATE_REFUSED_TYPES` (empty today — see the precedence
  rule this set enforces when it isn't), which wins over the bridge rule
  below — the bridge is implemented and described, but abapsmith refuses to
  run it for any package, so nothing is created;
  `partial` when it is in `BRIDGE_CREATABLE_TYPES` (creation goes through a
  generated `IF_OO_ADT_CLASSRUN` bridge class, not ADT REST); `partial` when
  it has an out-of-registry create site (the enhancement types, which
  `abap_enh` creates without a registry `create` field); otherwise `no`.
- **Read** — `yes` when the registry entry carries a `catalogRead` field
  (`src/adt/capabilities.ts`): `abap_read` dispatches on the explicit `type`
  hint before `resolveObject` runs, and sends these straight to a
  catalog-table render, so they are readable even though `resolveObject`
  itself would refuse them. Otherwise `no` when the type has no `TypeSpec`
  in `src/adt/types.ts`, so no URI can be built for it at all; `yes` when the
  spec's `mode` is `source`, or when `mode` is `ddic` and `ddicStrategy(kind)`
  is not `unsupported`; otherwise `partial`, meaning a non-default read mode
  is required (`format: "raw"` or `enhancements: true`). Two types, `SUSO/B`
  and `TABL/DI`, have no `TypeSpec` and no ADT REST URI at all — the
  structural condition the fallback rule above tests — yet both read `yes`
  through the `catalogRead` rule instead. See their notes below.
- **Update** — `yes` when the registry entry has a `write` field, which is
  what `abap_write` needs to resolve a change target; otherwise `no`.
- **Delete** — `yes` when the type is in `DELETABLE_TYPES`; `partial` when it
  is in `BRIDGE_DELETABLE_TYPES`; `partial` when it is one of the three
  enhancement types, which `abap_enh` deletes on a path the registry has no
  field for; otherwise `no`.
- **Activate** — `yes` when `activate` is `true`; `n/a` when it is `false`,
  which the registry uses for types that are born active; otherwise `no`.
- **Evidence** — `live` when the registry carries a live-verification flag,
  which includes a flag set to `false`: the registry uses `false` to mean
  "tried against a live system and does not reliably work," so a `false` is
  itself live evidence and the note says which way it went. Otherwise
  `unverified` when the row claims any write route, and `tests` when the row
  claims none, because a pure refusal row is exactly what the tests pin.

The `unverified` marker means the registry carries no live-verification flag
for that type — nothing more. It is not a claim that the type is known
broken; it is an honest absence of evidence either way.

Two facts the registry alone cannot express, because they are hand-maintained
inputs to this derivation rather than registry fields:

- `scripts/gen-capability-table.mjs` exports `OUT_OF_REGISTRY_CREATE`, naming
  the three enhancement create sites the registry has no `create` field for.
- Enhancement delete has no registry footprint at all. `deleteEnhancementObject`
  in `src/adt/enhancement-write.ts` really deletes `ENHO/XH`, `ENHO/XHH` and
  `ENHS/XS`, but none of the three appears in `DELETABLE_TYPES` or
  `BRIDGE_DELETABLE_TYPES`, and `abap_write` with `op: "delete"` refuses them.
  The `partial` in those cells comes from a hand-maintained list in the guard
  test, labelled as such.

### Table

| Type | Object | Create | Read | Update | Delete | Activate | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `CLAS/OC` | Class | yes | yes | yes | yes | yes | live |
| `INTF/OI` | Interface | yes | yes | yes | yes | yes | live |
| `PROG/P` | Program | yes | yes | yes | yes | yes | live |
| `PROG/I` | Include | yes | yes | yes | yes | yes | live |
| `FUGR/F` | Function group | yes | yes | yes | yes | yes | live |
| `FUGR/FF` | Function module | yes | yes | yes | yes | yes | live |
| `FUGR/I` | Function group include | yes | yes | yes | yes | yes | live |
| `DDLS/DF` | CDS view / DDL source | yes | yes | yes | yes | yes | live |
| `DDLX/EX` | Metadata extension | yes | yes | yes | yes | yes | live |
| `DCLS/DL` | CDS access control | yes | yes | yes | yes | yes | live |
| `DDLA/ADF` | Annotation definition | no | yes | yes | no | yes | live |
| `SRVD/SRV` | Service definition | yes | yes | yes | yes | yes | live |
| `BDEF/BDO` | Behavior definition | yes | yes | yes | yes | yes | live |
| `XSLT/VT` | Transformation | yes | yes | yes | yes | yes | live |
| `TYPE/DG` | Type group | yes | yes | yes | yes | yes | live |
| `DRUL/DRL` | Dependency rule | yes | yes | yes | yes | yes | live |
| `ENHO/XH` | BAdI implementation | partial | partial | no | partial | yes | tests |
| `ENHO/XHH` | Enhancement source plug-in | partial | yes | yes | partial | no | unverified |
| `ENHS/XS` | Enhancement spot | partial | partial | no | partial | yes | tests |
| `TABL/DT` | Database table | yes | yes | yes | yes | yes | live |
| `TABL/DS` | Structure | yes | yes | yes | yes | yes | live |
| `DTEL/DE` | Data element | yes | yes | yes | yes | yes | live |
| `DOMA/DD` | Domain | yes | yes | yes | yes | yes | live |
| `TTYP/DA` | Table type | yes | yes | yes | yes | yes | live |
| `MSAG/N` | Message class | yes | partial | yes | yes | n/a | live |
| `ENQU/DL` | Lock object | yes | partial | yes | yes | yes | live |
| `DEVC/K` | Package | yes | yes | no | partial | no | live |
| `SRVB/SVB` | Service binding | yes | partial | yes | yes | yes | live |
| `SHLP/DH` | Search help | partial | yes | no | partial | no | live |
| `VIEW/DV` | Classic view | partial | yes | no | partial | no | unverified |
| `TRAN/T` | Transaction | partial | yes | no | partial | no | unverified |
| `PROG/PS` | Screen (dynpro) | no | no | no | no | no | tests |
| `PROG/PC` | GUI status (CUA status) | no | no | no | no | no | tests |
| `PROG/PT` | GUI title (titlebar) | no | no | no | no | no | tests |
| `SUSO/B` | Authorization object | no | yes | no | no | no | tests |
| `TABL/DI` | Table secondary index | partial | yes | no | partial | no | unverified |

The `Object` column values are the registry `label` fields, unreworded.

### Object row notes

- `BDEF/BDO` — create and delete are both `yes`. A raw lock-plus-DELETE left a
  live-created behavior definition absent from repository search and from
  the object URI itself, though `.../source/main` still answered 200 with an
  empty body. The registry marks the type `blankSourceOnAbsence`, so the
  read path checks the object URI itself before reporting present or
  absent whenever the source body comes back blank. Create was exercised
  end to end through `abap_write` (table → CDS root
  view → `managed;` BDEF), coming back `created: true, activated: true`.
- `ENQU/DL` — create and delete are both live-verified, 2026-09-05, on A4H
  (`EZTMD_I30` in `$TMP` over table `T000`): create returned 201 (object
  `inactive`), and delete (LOCK with accessMode=MODIFY, then DELETE with the
  lock handle) returned 200, confirmed by a read-back showing the object
  gone. The earlier create failures were the XML root element, not the
  content: it must be lowercase `<enqu:lockobject>` in namespace
  `http://www.sap.com/adt/ddic/enqu`, not the camelCase `<enqu:lockObject>`
  in `http://www.sap.com/dictionary/lockobject` older callers sent. Names
  are restricted to the `EZ` and `EY` prefixes.
- `DCLS/DL` — reads, create, update, activate and delete are all
  live-verified, 2026-09-04, on A4H in `$TMP` (`ZTMD_DCL_01`): create via
  abap-adt-api's vendor `CreatableTypes` entry (creationPath
  `acm/dcl/sources`, not a hand-built skeleton) → source PUT → read back
  verbatim → PUT with activate → activated clean, read back verbatim →
  delete, confirmed by a NOT_FOUND read afterwards. The entry carries a
  `mediaType` because the object URI 406s without it.
- `DDLA/ADF` — reads are proven live: ADT discovery advertises
  `/sap/bc/adt/ddic/ddla/sources`, and a `GET
  .../ddic/ddla/sources/endusertext/source/main` returned 200 (`DEMOANNO` in
  package SABAPDEMOS). Update is supported — `abap_write` resolves a change
  target — but unexercised: no write has run live yet. Create is
  live-disproven, not merely untested: a 2026-09-04 A4H probe refused both
  `abap_write` (creating `ZTMD_ANNO_01` in `$TMP`) and a raw `POST
  .../ddic/ddla/sources` with the vendor body, both `403
  ExceptionNoAnnotationDefinitionAuthorization`, "You are not authorized to
  create Annotation Definitions" — from an admin user that creates every
  other type, so annotation definitions are a SAP-only object type on this
  system. Delete stays `"unverified"`: create never succeeded, so delete was
  never once reachable to test. The entry carries a `mediaType` because the
  object URI 406s without it.
- `MSAG/N` — activation is `n/a` because a message class is born active.
  Reading needs `format: "raw"`; a single raw document has been observed in
  the hundreds of thousands of characters, so the read is windowed by
  character count rather than by line.
- `DEVC/K` — a package can be created (through both an ADT create and a
  bridge create) and can be deleted, but only while empty, and it can never
  be rewritten: there is no `write` field, so `abap_write` cannot resolve a
  change target for one. The REST (LOCAL) create is live-verified,
  2026-09-04 on A4H: a root package created over ADT REST landed live, was
  read back, was searchable, and was deleted through abapsmith.
- `SHLP/DH`, `VIEW/DV` and `TRAN/T` — create, update and delete through a
  generated `IF_OO_ADT_CLASSRUN` bridge class; read through a plain-text
  catalog `SELECT` instead (`src/adt/catalog-query.ts`,
  `src/adt/catalog-read.ts`), not through ADT REST or the bridge. There is
  no `TypeSpec.write` for any of the three, so `abap_write`'s `mode="write"`
  (create) and `mode="delete"` reach them through `bridgeCreate`/
  `bridgeDelete` instead of the registry's normal `write` field — that is
  why the Update column above is `no` even though `mode="update"` exists
  for all three: the derivation keys on `TypeSpec.write`, which none of the
  three has, and `mode="update"` for `SHLP/DH`/`VIEW/DV`/`TRAN/T` REPLACES
  the whole definition (every field/include/assignment not passed is
  dropped) rather than patching it the way a `write`-field type's PUT does.
  `SHLP/DH` delete refuses when the search help is still attached to a data
  element (`DD04L`), an individual field (`DD35L`), or included by a
  collective search help (`DD31S`), unless `confirm_in_use`. `VIEW/DV`
  delete refuses when `TVDIR` shows a generated SE54 maintenance dialog for
  it, unless `confirm_maintenance_dialog`. `TRAN/T` delete and retarget
  (`mode="update"`) refuse when `AGR_TCODES` lists the tcode in a role's
  menu, unless `confirm_in_role_menu`. None of the three checks an SM01
  transaction lock either way. For all three, a transportable
  package resolves a transport request the same way a `DEVC/K` or class
  create does — the caller's `corr_nr` if given and permitted, or else one
  reused or created under `ABAP_ALLOW_TRANSPORTS` (`corr_nr` is never
  required; under `auto` naming one is refused, and the response's
  `transport:` field says which request was used); a `$` package (`$TMP`
  included) refuses a `corr_nr` and registers with `korrnum = space`
  instead. The gate verdict precedes the first wire request, so a refused
  create resolves and creates nothing. The created view lands in TADIR either way, so the delete
  bridge can remove it afterwards — proven live on A4H, 2026-09-04
  (a transportable package, with `corr_nr`) and 2026-09-05 (a
  `$`-prefixed package: view registered with `korrnum = space`, then deleted,
  VIEW-DELETED / VIEW-GONE). For `TRAN/T`, `RPY_TRANSACTION_INSERT`'s
  signature was read live on A4H 2026-09-05 — `transport_number` is optional
  and forwarded verbatim to `RS_CORR_INSERT` as `korrnum`, and
  `suppress_corr_insert` defaults to space so registration always runs; and
  `RPY_TRANSACTION_DELETE`'s signature was captured live on A4H 2026-09-12
  (used by both plain delete and retarget) — `IN TRANSACTION TSTC-TCODE`
  (required), `TRANSPORT_NUMBER RGLIF-TRKORR`,
  `SUPPRESS_AUTHORITY_CHECK`/`SUPPRESS_CORR_INSERT`/`SUPPRESS_CORR_CHECK`
  (all `CHAR1`), exceptions `NOT_EXCECUTED` (SAP's own misspelling) and
  `OBJECT_NOT_FOUND` — this entry previously called it inferred; it is not.
  `TRAN/T` create supports five shapes, chosen with `kind` (#214): `report`
  (the default — `program`, dynpro fixed at `1000`), `dialog` (`program` plus
  a `screen` dynpro), `parameter` (`target_transaction`, `parameters`,
  `skip_first_screen`), `variant` (`target_transaction`, `variant`, optional
  `cross_client_variant`), and `oo` (`class`, `method`, optional
  `update_mode`). `oo` is stored the way SE93 stores an OO transaction WITH
  the transaction model — a `parameter` transaction on `OS_APPLICATION`
  carrying `TSTCP` `/*OS_APPLICATION CLASS=...;METHOD=...;UPDATE_MODE=...;`
  — because that is the only OO shape `RPY_TRANSACTION_INSERT` can build. An
  OO transaction WITHOUT the transaction model (`TSTCP`
  `\CLASS=...\METHOD=...`, including a class local to a program) has no
  `RPY_TRANSACTION_INSERT` branch at all, so abapsmith cannot create or
  retarget one — it is read-only, reachable only through `abap_read`.
  `abap_read type=TRAN/T` reports `KIND`, `TARGET`, `SKIP FIRST SCREEN`, the
  parameter list, `VARIANT`/`CROSS-CLIENT`, and
  `CLASS`/`METHOD`/`UPDATE MODE`/`TRANSACTION MODEL`, decoding every `TSTCP`
  encoding SE93 writes, both the OO-with-model shape above and the
  read-only OO-without-model one. `mode="update"` still retargets report
  transactions only.
  No create into a transportable package has been run for any of the three;
  a `$`-package transaction was created and deleted live on 2026-09-05
  (TRAN-DELETED / TRAN-GONE), and a `$TMP` search help, view and transaction
  were each taken through create/update/delete (search help also through a
  collective-help create and a where-used check) live on 2026-09-12 — see
  `doc/LIMITATIONS/editing.md` for the message numbers and counts.
  `VIEW/DV`'s delete bridge still issues no `RS_CORR_INSERT`: a `VIEW/DV`
  delete records nothing in CTS, so any entry the view already had on a
  transport request (typically from its create) survives the delete, and the
  safety gate judges the delete itself as a local mutation rather than
  against `ABAP_ALLOW_TRANSPORTS`; it also takes no `corr_nr` at all — its
  bridge has no transport parameter. `TRAN/T` delete is different (#202):
  the bridge now passes the transport request to `RPY_TRANSACTION_DELETE`,
  which registers it via `RS_CORR_INSERT` itself, with the request-choice
  dialog suppressed — the SAPLSTRD 0300 popup that used to break a delete of
  a transportable-package transaction never appears. Without `corr_nr` the
  request is picked the same way a `TRAN/T` create picks one, under the
  session resolver / `ABAP_ALLOW_TRANSPORTS`; a named `corr_nr` is judged
  under the normal transport allowlist rules, the same as a create; a
  `corr_nr` named against a `$TMP` (or other `$`-package) transaction is
  refused, same as a create into a `$` package. Batch delete (`objects` on
  `abap_write`) accepts `TRAN/T` entries the same way — each one resolved and
  gated like a single delete, one bridge call per entry, not journalled; the
  other bridge-only types in a batch (`VIEW/DV`, `SHLP/DH`, `TABL/DI`) are
  refused `BAD_INPUT` naming the entry. Both update routes journal the pre-update
  rendered pseudo-DDL as a before-image, but the entry is `irreversible:
  true`: it is for audit and manual comparison only, not automatic undo —
  `abap_journal mode=undo` refuses it outright.
  `TABL/DI` (a table's secondary index) is a bridge-only type distinct from
  the three above: ADT REST has no index collection at all, so creation and
  deletion go through `DD_INDEX_INTERFACE`, and it is readable through a
  DIFFERENT route than `SHLP/DH`/`VIEW/DV`/`TRAN/T` — not the `mode: "ddic"`
  catalog SELECTs of `src/adt/catalog-read.ts`, but a `catalogRead` registry
  entry that sends `abap_read {"object": "<TABLE>/<INDEX>", "type":
  "TABL/DI"}` to a render built from `DD12V`/`DD17S`, the same two catalog
  tables the create and delete bridges now re-read after every write to
  confirm `verified`. A `TABL/DT` read also grew a `SECONDARY INDEXES`
  section listing every secondary index found this way, and a bare
  `<TABLE>` read with `type: "TABL/DI"` now lists every secondary index the
  table has — `indexes: 0` and an empty section for a table with none,
  rather than an error. As with `SUSO/B` below, the Read
  column reads `yes` for `TABL/DI` even though there is no `TypeSpec` and no
  ADT REST URI: `catalogRead` is what makes it readable despite that. The
  `DD12V`/`DD17S` reads behind this render were captured live against A4H,
  2026-09-12 (`test/fixtures/live-captured/INDEX.md`, captures 858-860); the
  `abap_read` route itself has not been exercised end to end against a live
  system on this branch. A non-unique, one-field create in `$TMP`
  was proven live on A4H 2026-09-05, confirmed by a post-COMMIT re-read of
  `DD12V` (`AS4LOCAL = 'A'`) and `DD17S`. A unique index on a client-dependent
  table needing that table's client field, once only suspected, is now
  CONFIRMED live (A4H, 2026-09-05, re-demonstrated in a third round the same
  day): including the field succeeds, omitting it is refused `BAD_INPUT` by a
  generated `DD03L` guard before the FM runs. The delete's `DD12V` pre-check
  correctly returned `NOT_FOUND` for a nonexistent index, and the earlier
  omission of `DD_INDEX_INTERFACE`'s mandatory `INDEX_FIELDS` table parameter
  is fixed and confirmed deployed. A second delete defect — `ACTFAILED='X'`
  reported even though the delete had already taken effect — got a fix that
  was itself broken: the fix's own added note line rendered as a
  272-character ABAP source line (292 at the longest legal names), over the
  255-character class-source limit, so every delete failed the class-source
  PUT (`ADT_ERROR` / `TooLongLine`) before `DD_INDEX_INTERFACE` was ever
  called, and the deployed bridge class silently stayed on its pre-fix body.
  The `ACTFAILED`-tolerant re-read by `DD12V`/`DD17S` therefore never ran
  live until the fix was fixed: the long messages are now built up in
  a variable across short lines, and every generated bridge class body is
  checked for a line over 255 characters before it is written, so this
  defect class cannot recur in any bridge. A fourth live round the same day
  then deleted both a non-unique and a unique index through the redeployed
  bridge (`INDEX-DELETED-ACTFAILED` / `INDEX-DELETED` / `INDEX-GONE`), a
  re-delete returned `NOT_FOUND`, and the deployed class body read back with
  no line over 255 — so delete is live-proven in `$TMP`. `ACTFAILED` was set
  on both deletes while every read-back was empty, and what the flag means
  was not established beyond "not that the rows survived" at the time of
  that round. That question is now moot: the bridge's response no longer
  reports `ACTFAILED` to the caller at all, for either create or delete —
  `verified`, `index_present` and `index_active` come from a definitive
  post-write `DD12V`/`DD17S` re-read instead, and a re-read that itself
  fails to run is reported as "not verified" with a reason, never inferred
  from `ACTFAILED`. Deleting the base table was not blocked live by a
  surviving index (round 1). Whether a base-table delete cascades its
  indexes away or orphans their `DD12V` rows is resolved the same way going
  forward: `abap_write`'s `TABL/DT` delete now reads the table's indexes
  with `index-read.ts` immediately before deleting it and reports what it
  found in the response, rather than leaving the outcome to a later,
  unfiltered `abap_data_preview` check. The transportable-package path is
  unexercised.
- `ENHO/XH`, `ENHO/XHH`, `ENHS/XS` — created and deleted by `abap_enh`, not
  by `abap_write`; `abap_write` with `op: "delete"` refuses all three.
  Enhancement writes are double-gated on the `allowEnhancements` and
  `allowEnhancementDelete` configuration, and a delete is refused outright
  when any BAdI implementation involved is still active. Reading `ENHO/XH`
  and `ENHS/XS` needs `enhancements: true`. Every enhancement mutation is
  journalled irreversible and undo refuses it unconditionally, with no
  `force` override.
- `ENHO/XHH` create is restricted to a `PROG/P` host by literal string
  equality. Hook anchors on a class are discoverable, but creating a hook
  implementation on one is refused; a function group would be refused the
  same way.
- `PROG/PS`, `PROG/PC`, `PROG/PT` — carry an `unsupported` entry: no read,
  no write, no URI. Each states a reason established by live
  reconnaissance — 404s on every collection, 405s on every write verb,
  content-free VIT stubs — so the `tests` in their Evidence column grades the
  refusal the tests pin, not the recon behind it. `SHLP/DH` no longer
  belongs on this list: it has `bridgeCreate` and `bridgeDelete` entries
  instead of `unsupported`, and its Evidence column is `unverified` (a write
  route is claimed), not `tests` — see the `SHLP/DH`, `VIEW/DV` and `TRAN/T`
  entry above.
- `SUSO/B` — also carries an `unsupported` entry (no URI, no write; `SU21`,
  a SAPGUI transaction outside abapsmith's reach, is the only way to edit an
  authorization object), but unlike the three above it is not read-blind:
  `catalogRead` sends `abap_read {"object": "<NAME>", "type": "SUSO/B"}`
  (e.g. `S_TABU_NAM`) to a render built from eight DDIC catalog tables
  (`TOBJ`, `TOBJT`, `TOBCT`, `TACTZ`, `TACTT`, `AUTHX`, `DD04L`, `DD07V`),
  each read with a validated, targeted `WHERE` rather than through an ADT
  object resource — so the Read column above reads `yes`, even though there
  is no `TypeSpec` and no URI `resolveObject` can hand back: `catalogRead`
  is exactly what makes the type readable despite that. The render is the
  authorization object's DEFINITION — class,
  text, fields, data elements, check tables, fixed values, permitted
  activities — never who holds it: abapsmith reads no `AGR_*` (role) or
  `UST*` (user authorization) table, under any option. The wire reads behind
  this render were captured live against A4H, 2026-09-12
  (`test/fixtures/live-captured/INDEX.md`, captures 861-875); the
  `abap_read` route itself has not been exercised end to end against a live
  system on this branch.
- `PROG/I` — `create.verified` and `delete` are both `true`, live-verified
  full cycle on A4H 2026-09-04: create, check, activate, re-write, read-back,
  delete. Create goes through the vendor `CreatableTypes` route, not a
  hand-built skeleton; an include is package-parented and tied to its host
  program only by the host's own `INCLUDE <name>.` statement, not by
  anything in the create body. Delete is refused by the server (403
  `ExceptionResourceDeletionFailure`) while any program still `INCLUDE`s it.
- `FUGR/I` — `create.verified` and `delete` are both `true`, live-verified
  full cycle on A4H 2026-09-04, including an arbitrary non-`F01`/`TOP`/`UXX`
  suffix. It is container-parented: the caller passes the full
  `L<GROUP><suffix>` include name as `GROUP/LGROUPSUFFIX` (name plus the
  group as container), since a bare 3-char suffix (the vendor row's
  `maxLen: 3` hint) is refused live while the full name validates OK. The
  function group must already exist first — create against a missing group
  500s `ExceptionResourceCreationFailure`. Its `["LZ","LY"]` name-prefix
  override is server-derived, like `ENQU/DL`'s `["EZ","EY"]`: SAP derives
  the group from the include name, so a customer `Z…`/`Y…` group's include
  necessarily begins `LZ`/`LY`.
- `XSLT/VT` — the registry path was corrected from `/sap/bc/adt/xslt/sources/`
  (404 live) to `/sap/bc/adt/xslt/transformations/` (200, including
  `.../source/main` with real source; 2026-09-04) — the old path failed every
  read, so this row's Read was wrongly `yes` until now. `create.verified` and
  `delete` are both `true`: the create skeleton needed a fix to match — a raw
  POST to `/sap/bc/adt/xslt/transformations` 400d until the namespace was
  singular (`.../adt/transformation`) and 400d again (InvalidTransformationValue)
  until the root also carried `trans:transformationType="XSLTProgram"`; with
  both fixes the POST returned 200 and the object read back afterwards. See
  this type's REGISTRY comment in capabilities.ts for the exact server
  messages.
- `TYPE/DG` — create, update, activate, read-back and delete are all
  live-verified through abapsmith on A4H, 2026-09-04, full cycle on `ZTMDY`
  ($TMP): `abap_write` create (skeleton POST then source PUT, `check:
  clean`, activated), a second `abap_write` update adding a `CONSTANTS`
  line (changed, activated), `abap_read` returning both lines, then
  `abap_write mode=delete` and a read confirming `NOT_FOUND`. Create goes
  through a hand-built skeleton POST, the same mechanism `BDEF/BDO` and
  `XSLT/VT` use — root `atypgr:abapTypeGroup`, namespace
  `http://www.sap.com/adt/ddic/typegroups`, POST
  `/sap/bc/adt/ddic/typegroups` with Content-Type
  `application/vnd.sap.adt.ddic.typegroups.v2+xml`, since abap-adt-api has
  no `CreatableTypes` row for type groups. Type-group names are capped at
  5 characters and may not contain underscores (server: 403 "Do not use
  underscores in type group names", confirmed again on the negative test
  `ZTMD_TG_01`); `src/adt/write.ts` enforces both pre-flight, at zero wire
  cost.
- `DRUL/DRL` — same evidence shape as `TYPE/DG`, full cycle live through
  abapsmith on A4H, 2026-09-04, on `ZTMD_DRUL_02` ($TMP): `abap_write`
  create with the rule source and `activate: false` (`check: clean`,
  source landed on the create PUT), then `abap_write` with the same source
  (`changed: false`, activated), `abap_read` returning the 4-line rule,
  then `abap_write mode=delete` and a read confirming `NOT_FOUND`. Create
  goes through a hand-built skeleton POST — same reasoning as `TYPE/DG`, no
  `CreatableTypes` row — but a different shape: root `blue:blueSource`,
  namespace `http://www.sap.com/wbobj/blue`, POST
  `/sap/bc/adt/ddic/drul/sources` with Content-Type
  `application/vnd.sap.adt.ddic.drul.v1+xml`. The created source is empty,
  so the caller PUTs the `DEFINE FILTER DEPENDENCY RULE …` text afterwards.
- `SRVB/SVB` — reading needs `format: "raw"`; create, activate, read-back and
  delete over the ADT business-services binding path are live-verified. This
  is a different path from the OData metadata read described under RAP,
  which is not.
