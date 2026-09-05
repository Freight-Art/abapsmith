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
- **Read** — `no` when the type has no `TypeSpec` in `src/adt/types.ts`, so no
  URI can be built for it at all; `yes` when the spec's `mode` is `source`, or
  when `mode` is `ddic` and `ddicStrategy(kind)` is not `unsupported`;
  otherwise `partial`, meaning a non-default read mode is required
  (`format: "raw"` or `enhancements: true`).
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
| `SHLP/DH` | Search help | no | no | no | no | no | tests |
| `VIEW/DV` | Classic view | partial | no | no | partial | no | unverified |
| `TRAN/T` | Transaction | partial | no | no | partial | no | unverified |
| `PROG/PS` | Screen (dynpro) | no | no | no | no | no | tests |
| `PROG/PC` | GUI status (CUA status) | no | no | no | no | no | tests |
| `PROG/PT` | GUI title (titlebar) | no | no | no | no | no | tests |
| `SUSO/B` | Authorization object | no | no | no | no | no | tests |
| `TABL/DI` | Table secondary index | partial | no | no | partial | no | unverified |

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
- `VIEW/DV` and `TRAN/T` — create and delete only, both through a generated
  `IF_OO_ADT_CLASSRUN` bridge class. There is no `TypeSpec` for either, so
  `abap_read` cannot build a URI and there is no read-back at all: after
  creating one you cannot ask abapsmith what it looks like. There is no
  source write either, so an existing one cannot be changed — only deleted
  and recreated. Their `bridgeCreate.limits` text states this, and a test
  requires it to. For `TRAN/T`, a transportable package requires `corr_nr`
  for the create, and a `$` package (`$TMP` included) refuses one and
  registers with `korrnum = space` instead. For `VIEW/DV`, a transportable
  package resolves a transport request the same way a `DEVC/K` create
  does — the caller's `corr_nr` if given, or else one picked or created
  under `ABAP_ALLOW_TRANSPORTS`; a `$` package (`$TMP` included) still
  refuses a `corr_nr` and registers with `korrnum = space` instead.
  The created view lands in TADIR either way, so the delete
  bridge can remove it afterwards — proven live on A4H, 2026-09-04
  (a transportable package, with `corr_nr`) and 2026-09-05 (a
  `$`-prefixed package: view registered with `korrnum = space`, then deleted,
  VIEW-DELETED / VIEW-GONE). For `TRAN/T`, only `RPY_TRANSACTION_INSERT`'s
  signature was read live on A4H 2026-09-05 — `transport_number` is optional
  and forwarded verbatim to `RS_CORR_INSERT` as `korrnum`, and
  `suppress_corr_insert` defaults to space so registration always runs. No
  create into a transportable package has been run; a `$`-package transaction
  was created and deleted live on 2026-09-05 (TRAN-DELETED / TRAN-GONE).
  Because neither delete bridge issues an `RS_CORR_INSERT`, the delete records
  nothing in CTS: any entry the object already had on a transport request
  (typically from its create) survives the delete, and the safety gate judges
  the delete itself as a local mutation rather than against
  `ABAP_ALLOW_TRANSPORTS`.
  `TABL/DI` (a table's secondary index) is a third bridge-only type with no
  read route — ADT REST has no index collection at all — so creation goes
  through `DD_INDEX_INTERFACE` too. A non-unique, one-field create in `$TMP`
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
  on both deletes while every read-back was empty; what the flag means is
  still not established beyond "not that the rows survived". Deleting the base table
  was not blocked live by a surviving index (round 1); a later cleanup
  deleted a base table while its indexes' `DD12V` rows may still have
  existed, and whether the delete cascaded them away or left them orphaned
  is unverified — `abap_data_preview` has no `WHERE` filter, so a targeted
  `DD12V` check was not practical. The transportable-package path is
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
- `SHLP/DH`, `PROG/PS`, `PROG/PC`, `PROG/PT`, `SUSO/B` — carry an
  `unsupported` entry: no read, no write, no URI. Each states a reason
  established by live reconnaissance — 404s on every collection, 405s on
  every write verb, content-free VIT stubs — so the `tests` in their
  Evidence column grades the refusal the tests pin, not the recon behind it.
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
