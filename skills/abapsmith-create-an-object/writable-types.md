# Writable and readable types

This is the generated capability table for `abap_write`, `abap_read`, `abap_activate` and delete — every type abapsmith can create, change, delete or read, straight from the registry (`src/adt/capabilities.ts`). The router, `abapsmith-orient`, points here.

## The writable set

<!-- BEGIN generated: scripts/gen-capability-table.mjs -->

**Creatable and writable (23).** Everything else is not.

- `CLAS/OC` — write shape `source`, delete: yes
- `INTF/OI` — write shape `source`, delete: yes
- `PROG/P` — write shape `source`, delete: yes
- `PROG/I` — write shape `source`, delete: yes
- `FUGR/F` — write shape `source`, delete: yes
- `FUGR/FF` — write shape `source`, delete: yes
- `FUGR/I` — write shape `source`, delete: yes
- `DDLS/DF` — write shape `source`, delete: yes
- `DDLX/EX` — write shape `source`, delete: yes
- `DCLS/DL` — write shape `source`, delete: yes
- `SRVD/SRV` — write shape `source`, delete: yes
- `BDEF/BDO` — write shape `source`, delete: yes
- `XSLT/VT` — write shape `source`, delete: yes
- `TYPE/DG` — write shape `source`, delete: yes
- `DRUL/DRL` — write shape `source`, delete: yes
- `TABL/DT` — write shape `source`, delete: yes
- `TABL/DS` — write shape `source`, delete: yes
- `DTEL/DE` — write shape `properties`, delete: yes
- `DOMA/DD` — write shape `properties`, delete: yes
- `TTYP/DA` — write shape `properties`, delete: yes
- `MSAG/N` — write shape `properties`, delete: yes
- `ENQU/DL` — write shape `properties`, delete: yes
- `SRVB/SVB` — write shape `properties`, delete: yes

**Bridge-only create types (5).** ADT REST has no usable create for these, so abapsmith runs them over the fluid `classic` tool's shared `ZCL_ZMCP_FLUID_CLASSIC` body class in `$ABAPSMITH_FLUID_API`, not a throwaway per-call `$TMP` classrun. Whether it can also update an EXISTING object, and whether it can delete one — and so whether the create is reversible — differs per type; see each bullet.

- `DEVC/K` — `software_component: "LOCAL"` goes over ADT REST; anything else needs the bridge and a transport request. Delete works only on an EMPTY package — no sub-packages, no TADIR objects. Delete: runs over the same bridge (src/adt/package-delete.ts) the create uses, gated by the same empty-package limit noted above; the create's journal entry no longer marks itself irreversible; but IF_PACKAGE~DELETE's failure behaviour is not itself live-verified.
- `SHLP/DH` — builds an elementary (one interface) or collective (DD31S includes of other search helps) search help via RS_CORR_INSERT then DDIF_SHLP_PUT then DDIF_SHLP_ACTIVATE; an elementary help needs at least one import AND one export interface field, checked zero-network before dispatch. `update_search_help` REPLACES the whole definition — any field, include or assignment not passed again is removed. There is no ADT REST read or write route for a search help at all (every mutating verb 404s), but src/adt/catalog-read.ts reads one back through plain-text DD30L/DD30T/DD32S/DD31S/DD33S catalog SELECTs, so success is not proven by transcript markers alone. Proven live on A4H 2026-09-12, $TMP only: DDIF_SHLP_PUT + DDIF_SHLP_ACTIVATE returned DH107, and a catalog read-back matched what was put. A transportable package requires corr_nr; a `$` package refuses one and registers with korrnum = space — same pairing rule as VIEW/DV and TRAN/T. The transportable path has NOT itself been run live. Delete: DD_OBJ_DEL (del_state 'A' then 'N') clears DD30L, then TR_TADIR_INTERFACE clears the TADIR row — the same two-call pattern VIEW/DV's delete uses, with the same open-transport-request-lock caveat (TR_TADIR_INTERFACE's TADIR delete fails under a lock this path does not clear). Guarded by a where-used check the other two bridge deletes do not have: attached to a data element (DD04L), a table/view field (DD35L), or included by a collective search help (DD31S) refuses the delete unless the caller passes confirm_in_use — all three checked live on A4H 2026-09-12. No corr_nr is accepted. Proven live on A4H 2026-09-12, $TMP only: DD_OBJ_DEL returned DH051, TR_TADIR_INTERFACE removed the TADIR row, and a post-delete re-read proved absence (SHLP-DELETED / SHLP-GONE).
- `VIEW/DV` — builds a single-table database view (DD25V class 'D') via RS_CORR_INSERT then DDIF_VIEW_PUT then DDIF_VIEW_ACTIVATE; no joins, no SE54 maintenance dialog. A transportable package resolves a transport request the same way a DEVC/K create does — the caller's corr_nr, or else one picked or created under ABAP_ALLOW_TRANSPORTS; a `$` package refuses a corr_nr and registers with korrnum = space instead. There is no ADT REST read route (405 on every mutating verb, empty discovery collection), but src/adt/catalog-read.ts reads DD25L/DD25T/DD26S/DD27S/TVDIR back through plain-text catalog SELECTs, so success is not proven by transcript markers alone. Proven live on A4H: 2026-09-04 into a transportable package with a corr_nr; 2026-09-05, RS_CORR_INSERT registered one in a `$` package with korrnum = space (sy-subrc 0, TADIR row), then removed by the delete bridge. Changing an EXISTING view is also supported now (`update_view`, DDIF_VIEW_PUT again — REPLACES the whole definition, so an omitted field is dropped), proven live 2026-09-12 (message D0322, field count 2 to 3). Delete: abapsmith's own create registers every view in TADIR, so the delete bridge (src/adt/view-delete.ts) always has one to act on. Proven live on A4H 2026-09-05: a bridge-created view in a `$`-prefixed package was removed cleanly, VIEW-DELETED / VIEW-GONE.
- `TRAN/T` — creates a REPORT transaction (dynpro 1000) starting an existing program, via RPY_TRANSACTION_INSERT. Retargeting an EXISTING transaction to a different program is also supported now (`update_transaction`: RPY_TRANSACTION_DELETE then re-INSERT under one RS_CORR_INSERT registration, refused unless confirm_in_role_menu is passed when the tcode is already in a role menu; an SM01 lock is NOT checked either way, by design), proven live 2026-09-12 (message EU075, program confirmed changed on read-back). A transportable package requires corr_nr; a `$` package refuses one and registers with korrnum = space instead. RPY_TRANSACTION_INSERT's signature was read live on A4H 2026-09-05: transport_number is optional and forwarded verbatim to RS_CORR_INSERT as korrnum, and suppress_corr_insert defaults to space so the registration always runs. No live create into a transportable package has been run. Delete: the bridge calls RPY_TRANSACTION_DELETE, whose parameter set was captured live on A4H 2026-09-12 (IN TRANSACTION TSTC-TCODE required, TRANSPORT_NUMBER, SUPPRESS_AUTHORITY_CHECK, SUPPRESS_CORR_INSERT, SUPPRESS_CORR_CHECK; exceptions NOT_EXCECUTED — SAP's own misspelling — and OBJECT_NOT_FOUND) — not inferred from RPY_TRANSACTION_INSERT's `transaction` parameter name, as this entry previously read. Guarded by the same where-used check as retargeting: a tcode already assigned to one or more roles' menus (AGR_TCODES) refuses the delete unless the caller passes confirm_in_role_menu; an SM01 transaction lock is NOT checked either way. Live-verified once, 2026-09-05: TRAN-DELETED / TRAN-GONE with a post-delete re-read proving absence. Whether RPY_TRANSACTION_DELETE itself calls RS_CORR_INSERT (the way RPY_TRANSACTION_INSERT does) is still unknown, so deleting a transaction out of a TRANSPORTABLE package may plausibly hit a headless-dynpro failure; no transport handling is attempted here either way.
- `TABL/DI` — creates a secondary index on an existing table via DD_INDEX_INTERFACE (ACTION='I'); there is no ADT-readable index route at all, so success is proven only by re-reading DD12V/DD17S after COMMIT WORK. The package is the base table's, not the caller's; a transportable package requires corr_nr, a `$` package sets NO_TRANSP_REQUEST='X' and refuses one, the same rule VIEW/DV uses. Change is not supported either. Proven live on A4H 2026-09-05: a non-unique single-field index created in `$TMP`, confirmed by a post-commit DD12V/DD17S re-read. The client-field requirement for a unique index on a client-dependent table, once suspected, is now CONFIRMED live (A4H, 2026-09-05): the generated DD03L guard refuses an omitting create with BAD_INPUT before the FM runs, and an including create succeeds with all three markers. A third live round re-ran both creates the same day and got all three markers again for each — the round-3 delete-path defect below never touched create. Delete: deletes any index it finds in DD12V for the given table by name, not only ones the bridge itself created — no provenance check exists. Unlike the VIEW/DV/TRAN/T deletes, this DELETE takes the same transport pair as create — DD_INDEX_INTERFACE ACTION='D' needs it too. The DD12V pre-check is proven live (2026-09-05: NOT_FOUND for a nonexistent index). The missing mandatory INDEX_FIELDS table parameter is fixed and confirmed deployed live (2026-09-05). A second defect surfaced live: ACTION='D' reports ACTFAILED='X' even when the delete already took effect. The round-2 fix for that — commit regardless, then re-verify via a post-commit DD12V/DD17S re-read — never ran: its own added note line rendered as a 272-character ABAP source line (292 at the longest legal names), over the 255-character class-source limit, so every delete failed the class-source PUT (ADT_ERROR / TooLongLine, SEDI_ADT15) before DD_INDEX_INTERFACE was ever called, and the deployed bridge class silently stayed on its pre-fix body. Fixed again: the fragment's long messages are now built up in a variable across short lines, and every generated bridge class body is now rejected before it is written if any line exceeds 255 characters. Round 4 then ran live (A4H 2026-09-05, $TMP): a non-unique and a unique index were each deleted through the redeployed bridge (INDEX-DELETED-ACTFAILED / INDEX-DELETED / INDEX-GONE), a re-delete returned NOT_FOUND, and the deployed class body read back with no line over 255 — delete is live-proven. ACTFAILED is no longer surfaced to the caller at all, for either create or delete: the response instead carries a definitive `verified` boolean plus `index_present`/`index_active` from a fresh post-write DD12V/DD17S re-read (src/adt/index-read.ts's verifySecondaryIndex), and a re-read that itself fails to run is reported as not verified, with a reason, never inferred from ACTFAILED. A base-table delete is not blocked by an index still on it (round 1); abap_write's TABL/DT delete now reads the table's indexes immediately before deleting it and reports what it found, so the cascade-or-orphan question is answered from that pre-delete state rather than left to an unfiltered abap_data_preview check. The index is also independently readable at any time: abap_read {"object":"<TABLE>/<INDEX>","type":"TABL/DI"} renders it from the same two catalog tables.

**Creatable, but the create site is outside this registry (3).** No `create` field in `REGISTRY` at all — these bypass the `create.verified` gate on purpose (src/adt/capabilities.ts, ~lines 52-57). Not a classrun bridge: each has its own create call.

- `ENHO/XH` — src/adt/enhancement-bridge.ts — createBadiImplementation.
- `ENHO/XHH` — src/adt/enhancement-hook.ts — createHookImplementation (PROG/P host only).
- `ENHS/XS` — src/adt/enhancement-bridge.ts — createEnhancementSpot.

**Writable but NOT creatable (1).** Change an existing one; creating fails.

`DDLA/ADF`

**Not reachable by any write (4).** Do not probe for a write route.

- Readable, not writable (0): _(none)_
- Readable through the catalog route, not writable (2) — no ADT resource exists for these at all; `abap_read` renders them read-only from catalog tables instead (`catalogRead`, src/adt/capabilities.ts), not an ordinary ADT read: `SUSO/B` `TABL/DI`.
- Not readable either (3) — `abap_read` refuses these before any network call, from an `unsupported` entry or a bridge-only create with no read route of any kind (NON_READABLE_TYPES, src/adt/capabilities.ts): `PROG/PS` `PROG/PC` `PROG/PT`.

<!-- END generated -->

### Deleting a package

A package (`DEVC/K`) delete only succeeds against an empty package — no
sub-packages, no TADIR objects. An object already deleted but not yet
released still counts as present: TADIR's DELFLAG marks it pending removal,
it does not remove the TADIR entry, so the package isn't empty yet as far
as the delete check is concerned. When everything left in the package is in
that state, the delete answers the classified error code
`TRANSPORT_PENDING`, naming the request (and task) whose release would
actually empty the package (verified live 2026-09-22 on ZAS_PKG184). A
DELFLAG object whose E071 row was removed from its request is listed as
"awaiting release of a request this server could not find — no open E071
row"; it still blocks the delete. abapsmith never releases a request for you to
make a delete succeed — release is a separate, irreversible action the
caller takes deliberately, through `abap_transport_release`.

The **Not reachable by any write** bucket is the write-side list: those types have no write route
at all, so searching for a workaround wastes turns — say it is out of scope and stop. The "not
readable either" bullet is the read-side list and registry-wide, not bucket-scoped: it can name
bridge-creatable types too, and today lists none of them — everything writable is also readable,
through an ordinary ADT read, the `mode: "ddic"` catalog route (`SHLP/DH`, `VIEW/DV`, `TRAN/T`)
or a `catalogRead` render (`TABL/DI`).

## What abap_read refuses outright

`abap_read`'s schema names three types as not readable — `PROG/PS` `PROG/PC`
`PROG/PT` (`NON_READABLE_TYPES`, `src/adt/capabilities.ts`).

`PROG/PS` and `PROG/PC` are not real ADT object types on this release — no
discovery collection exists for them, so there is no URI to build. Menu
Painter / Screen Painter territory.

`PROG/PT` is real, but it names the program's GUI title (`SET TITLEBAR`,
Menu Painter/SE41) — not the text pool — and it stays unwritable and
unreadable, same as `PROG/PS`/`PROG/PC`. The text pool (text symbols and
selection texts) is a different resource entirely and is not in this
refusal list: it is written through `abap_write`'s `text_pool` parameter
and read as a `TEXT POOL` section of a `PROG/P` whole-object read — see
["Program text pool and Fixed Point Arithmetic"](#program-text-pool-and-fixed-point-arithmetic)
below and `doc/TOOLS/write-and-activate.md`.

Five more types look the same at a glance — no `TypeSpec` or no ADT
resource — but are NOT refused, through two different catalog routes.

`SHLP/DH`, `VIEW/DV` and `TRAN/T` have no ADT REST collection either, but
`resolveObject` (`src/adt/resolve.ts`) routes them through a plain-text
catalog `SELECT` (`src/adt/catalog-read.ts`) instead of refusing, rendering
a pseudo-DDL read for a search help, a classic view, or a transaction — see
`doc/TOOLS/read-and-search.md`. `abap_write` can also create, `mode="update"`,
and delete all three through the fluid `classic` bridge (collective search
helps included); see `doc/TOOLS/write-and-activate.md` and
`doc/LIMITATIONS/editing.md`.

`SUSO/B` and `TABL/DI` carry a `catalogRead` entry instead, and `abap_read`
dispatches them straight to a read-only render built from DDIC catalog
tables before `resolveObject` is ever reached.
`abap_read {"object":"S_TABU_NAM","type":"SUSO/B"}` renders an authorization
object's definition — its fields, data elements, check tables, fixed values
and permitted activities — never who holds it: no `AGR_*`/`UST*` table is
read, under any option. `SUSO/B` is read-only; `SU21` (SAPGUI) is the only
way to edit one.
`abap_read {"object":"<TABLE>/<INDEX>","type":"TABL/DI"}` renders one
secondary index from `DD12V`/`DD17S`; a plain `TABL/DT` read also gains an
`indexes` section listing every secondary index found the same way.
`abap_write` can create and delete a `TABL/DI` through the bridge (`corr_nr`
follows its base table's package, never the caller's). Both are read-only
catalog renders, so both work under `ABAP_MODE=read`.

## Two write shapes

`source` types take ABAP/DDL text. `properties` types take a **complete XML
descriptor**, and a write REPLACES the whole document — omit a field and you
delete it. Never send a partial descriptor.

## Program text pool and Fixed Point Arithmetic

`PROG/P` create now sends `abapsource:fixPointArithmetic="true"` in the ADT
create payload by default (before: no attribute at all, which left Fixed
Point Arithmetic off and broke things like `SELECT … INTO TABLE @DATA(lt)`
combined with `lines( )` arithmetic, and decimal handling generally). Opt
out with `abap_write`'s `fixed_point_arithmetic: false`, `PROG/P` only —
named against any other type it is `BAD_INPUT` before any request. A plain
whole-object `abap_read` of a `PROG/P` reports `fixed_point_arithmetic:
true|false` in the header; the line is omitted when the descriptor could
not be read.

`PROG/PT` is the GUI title, not the text pool — see above. The text pool
(text symbols and selection texts) is written through `abap_write`'s
`text_pool` parameter on type `PROG/P`, and read as a `TEXT POOL` section
of a `PROG/P` whole-object read when the program has any. Full parameter
shape, limits, the write flow and the response fields are in
`doc/TOOLS/write-and-activate.md`; the read-side section is in
`doc/TOOLS/read-and-search.md`.

```json
{
  "object": "ZDEMO_REPORT",
  "type": "PROG/P",
  "text_pool": {
    "symbols": { "001": "Hello" },
    "selection_texts": { "P_X": "Parameter X" }
  }
}
```
