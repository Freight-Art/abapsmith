---
name: abapsmith-orient
description: Checks what abapsmith can actually build on this SAP system before any write is attempted. Use at the start of any ABAP task that creates, changes, or deletes an object, or when a write was refused.
---

# Orient before writing

abapsmith writes a **fixed enum of object types**. Most ABAP types are not in it.
Check here before planning any create.

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
- `TABL/DI` — creates a secondary index on an existing table via DD_INDEX_INTERFACE (ACTION='I'); there is no ADT-readable index route at all, so success is proven only by re-reading DD12V/DD17S after COMMIT WORK. The package is the base table's, not the caller's; a transportable package requires corr_nr, a `$` package sets NO_TRANSP_REQUEST='X' and refuses one, the same rule VIEW/DV uses. Change is not supported either. Proven live on A4H 2026-09-05: a non-unique single-field index created in `$TMP`, confirmed by a post-commit DD12V/DD17S re-read. The client-field requirement for a unique index on a client-dependent table, once suspected, is now CONFIRMED live (A4H, 2026-09-05): the generated DD03L guard refuses an omitting create with BAD_INPUT before the FM runs, and an including create succeeds with all three markers. A third live round re-ran both creates the same day and got all three markers again for each — the round-3 delete-path defect below never touched create. Delete: deletes any index it finds in DD12V for the given table by name, not only ones the bridge itself created — no provenance check exists. Unlike the VIEW/DV/TRAN/T deletes, this DELETE takes the same transport pair as create — DD_INDEX_INTERFACE ACTION='D' needs it too. The DD12V pre-check is proven live (2026-09-05: NOT_FOUND for a nonexistent index). The missing mandatory INDEX_FIELDS table parameter is fixed and confirmed deployed live (2026-09-05). A second defect surfaced live: ACTION='D' reports ACTFAILED='X' even when the delete already took effect. The round-2 fix for that — commit regardless, then re-verify via a post-commit DD12V/DD17S re-read — never ran: its own added note line rendered as a 272-character ABAP source line (292 at the longest legal names), over the 255-character class-source limit, so every delete failed the class-source PUT (ADT_ERROR / TooLongLine, SEDI_ADT15) before DD_INDEX_INTERFACE was ever called, and the deployed bridge class silently stayed on its pre-fix body. Fixed again: the fragment's long messages are now built up in a variable across short lines, and every generated bridge class body is now rejected before it is written if any line exceeds 255 characters. Round 4 then ran live (A4H 2026-09-05, $TMP): a non-unique and a unique index were each deleted through the redeployed bridge (INDEX-DELETED-ACTFAILED / INDEX-DELETED / INDEX-GONE), a re-delete returned NOT_FOUND, and the deployed class body read back with no line over 255 — delete is live-proven. ACTFAILED='X' was still set on both deletes that took effect, so the flag is noise, not a result. A base-table delete is not blocked by an index still on it (round 1); a later cleanup deleted a base table while its indexes' DD12V rows may still have existed, and whether the delete cascaded them away or left them orphaned is unverified — at the time abap_data_preview carried no WHERE filter, so a targeted check was not practical. It now takes a structured filter (issue #73), so such a check is possible, but this round's outcome was never re-checked and stays unverified.

**Creatable, but the create site is outside this registry (3).** No `create` field in `REGISTRY` at all — these bypass the `create.verified` gate on purpose (src/adt/capabilities.ts, ~lines 52-57). Not a classrun bridge: each has its own create call.

- `ENHO/XH` — src/adt/enhancement-bridge.ts — createBadiImplementation.
- `ENHO/XHH` — src/adt/enhancement-hook.ts — createHookImplementation (PROG/P host only).
- `ENHS/XS` — src/adt/enhancement-bridge.ts — createEnhancementSpot.

**Writable but NOT creatable (1).** Change an existing one; creating fails.

`DDLA/ADF`

**Not reachable by any write (4).** Do not probe for a write route.

- Readable, not writable (0): _(none)_
- Not readable either (5) — `abap_read` refuses these before any network call, from an `unsupported` entry or a bridge-only create with no read route of any kind (NON_READABLE_TYPES, src/adt/capabilities.ts): `PROG/PS` `PROG/PC` `PROG/PT` `SUSO/B` `TABL/DI`. Registry-wide, not just this bucket: `TABL/DI` — creatable through the bridge above, still unreadable.

<!-- END generated -->

The **Not reachable by any write** bucket is the write-side list: those types have no write route
at all, so searching for a workaround wastes turns — say it is out of scope and stop. The "not
readable either" bullet is the read-side list and registry-wide: some types in it are
bridge-creatable.

## What abap_read refuses outright

`abap_read`'s schema names five types as not readable — `PROG/PS` `PROG/PC`
`PROG/PT` `SUSO/B` `TABL/DI` (`NON_READABLE_TYPES`, `src/adt/capabilities.ts`).

`PROG/PS`, `PROG/PC`, `PROG/PT` and `SUSO/B` are not real ADT object types
on this release — no discovery collection exists for them, so there is no
URI to build. Menu Painter / Screen Painter / SE11-subobject territory.
`TABL/DI` (a table's secondary index) is a real ADT concept but has no
ADT-readable collection at all and no `types.ts` entry — `abap_write` can
create or delete one through the fluid `classic` tool (`corr_nr` follows
its base table's package, never the caller's), but there is no read-back:
an index you just created cannot be read again by abapsmith, ever. For a
readable object, use a CDS view (`DDLS/DF`) instead.

`SHLP/DH`, `VIEW/DV` and `TRAN/T` are NOT in that list: `abap_read` reads
all three. None has an ADT REST collection, but `resolveObject`
(`src/adt/resolve.ts`) routes them through a plain-text catalog `SELECT`
(`src/adt/catalog-read.ts`) instead of refusing, rendering a pseudo-DDL
read for a search help, a classic view, or a transaction — see
`doc/TOOLS/read-and-search.md`. `abap_write` can also create, `mode="update"`,
and delete all three through the same fluid `classic` bridge; see
`doc/TOOLS/write-and-activate.md` and `doc/LIMITATIONS/editing.md`.

## Two write shapes

`source` types take ABAP/DDL text. `properties` types take a **complete XML
descriptor**, and a write REPLACES the whole document — omit a field and you
delete it. Never send a partial descriptor.

## Mode

`read` < `edit` < `admin`. Write tools are absent from `tools/list` in `read`
mode — a missing `abap_write` means the mode is wrong, not the tool.
`abap_fpm_read` is read-only in effect but is absent under `read` too, because
both paths install an ABAP class into `$ABAPSMITH_FLUID_API` — find/outline/app
the fluid `fpm` tool's body class, `locks` a per-call bridge class — and
installing a class is itself a write. `abap_img` is different: it generates no
ABAP and deploys nothing, so it is genuinely present under `read`.
`abap_img_edit` is a real write (it modifies customizing rows directly) and is
absent under `read` like any other write tool. `abap_fluid` is the extreme
case: it is abapsmith's single entry point to the fluid API — functions that
only work by installing generated ABAP into `$ABAPSMITH_FLUID_API` — and even
its read-shaped ops (`list`, `describe`, `status`, `verify`) need write access
to exist at all, so it is unavailable on a read-only or productive system:
absent from `tools/list` under `read` mode, and refusing `FLUID_API_DISABLED`
again if a system that started writable later proves productive or trips the
write lockout. See `doc/TOOLS/abap-fluid.md`.

`ABAP_MODE` is the current way to set this. A legacy `ABAP_ALLOW_WRITE=true`
flag grants ordinary write access too, but only when `ABAP_MODE` itself is
unset — it does not layer on top of an explicit mode.

**Per-feature ceilings are not implied by base write access.** Each is its
own opt-in, checked independently of `ABAP_MODE=edit`/`admin`:

- **Transport release** (`abap_transport_release`) — `ABAP_MODE=admin` by
  default, or `edit` mode plus the explicit override
  `ABAP_ALLOW_TRANSPORT_RELEASE=true`. Legacy path: that same flag plus
  `ABAP_ALLOW_WRITE=true` when `ABAP_MODE` is unset.
- **Transport delete** (`abap_transport` `operation=delete`) — `ABAP_MODE=admin`
  only. There is no legacy flag that grants it; ordinary write access
  (`edit`) never does either.
- **`abap_ui` `mode=press`** — needs `ABAP_MODE=admin` **and** the separate
  `ABAP_ALLOW_UI_PRESS=true`, both checked at call time, not at registration.
- **`abap_dumps` `variables`** — `ABAP_ALLOW_DUMP_VARIABLES=true`, independent
  of `ABAP_MODE` and allowed even under `read`. Enforced twice: the field is
  absent from the advertised schema when off, and refused again at call time
  if it somehow arrives anyway.
- **`abap_data_preview`** — the whole tool is gated by
  `ABAP_ALLOW_DATA_PREVIEW=true`, independent of `ABAP_MODE` and allowed even
  under `read`.

**`confirm` only narrows a ceiling — it never widens one.** Echoing a
transport/request number, or passing `confirm:true`, arms an action that the
server-side ceiling already permits; it cannot substitute for `ABAP_MODE`,
`ABAP_ALLOW_TRANSPORT_RELEASE`, `ABAP_ALLOW_UI_PRESS`, or any other flag. A
`confirm` on a call the ceiling would refuse is refused exactly the same as
if `confirm` had been omitted.

**A system that reports itself productive, or that cannot be proven
otherwise, refuses writes outright.** No flag overrides this lockout — it is
checked in addition to, not instead of, every ceiling above.

## The tool set

Two surfaces ship. **`v1` is the default** — one tool per job:

| Job | Tool |
|---|---|
| Find objects, usages, BOs, FPM configs | `abap_search` |
| Read source or descriptor | `abap_read` |
| Create / change / delete | `abap_write` |
| Activate separately | `abap_activate` |
| Execute a class or report | `abap_run` |
| ABAP Unit | `abap_test` |
| Static checks | `abap_atc` |
| List/apply position-driven quick fixes | `abap_quick_fix` |
| Short dumps | `abap_dumps` |
| Debugger | `abap_debug`, `abap_debug_vars`, `abap_debug_value` |
| History and undo | `abap_journal` |
| Transports | `abap_transport`, `abap_transport_release` |
| BOPF | `abap_bopf`, `abap_bopf_edit`, `abap_bopf_test`, `abap_bopf_delete` |
| Enhancements | `abap_enh` |
| OData service contract | `abap_service` |
| FPM / Web Dynpro (read-only) | `abap_fpm_read` |
| Browse IMG (SPRO) customizing structure | `abap_img` |
| Change IMG (SPRO) customizing values | `abap_img_edit` |
| Table rows | `abap_data_preview` |
| Open in GUI / browser | `abap_ui`, `abap_open_url` |

**`v2`** (`ABAP_TOOL_SURFACE=v2`) is deprecated and will be removed in
release 0.6.0 (issue #76) — do not start new work against it. A model
already talking to a v2 server still needs this mapping, though: it
collapses the same capability into six:
`abap_find`, `abap_read`, `abap_write`, `abap_debug`, `abap_adt`, and `abap_do` —
which absorbs activation, execution, journal, transports, BOPF and enhancements as
*actions*. Call `abap_do({})` for the catalogue. `abap_adt` is a GET-only raw ADT
escape hatch; reach for it last.

**Check `tools/list` rather than assuming.** A name from the wrong surface returns
unknown-tool; `abap_data_preview` and `abap_transport_release` are also gated off by
config even on v1.

## Package decides reversibility

- `$TMP` — no transport, no `corr_nr`. **Never reaches production.**
- Any other package — transportable; `corr_nr` is REQUIRED. See
  `abapsmith-put-work-on-a-transport`.

Default to `$TMP` unless the task says otherwise.

## Where to go next

| Task | Skill |
|---|---|
| Create/change any object | `abapsmith-create-an-object` |
| Domain, data element, table, table type | `abapsmith-create-ddic-objects` |
| CDS + behavior + service binding | `abapsmith-create-a-rap-service` |
| Class, interface, program, function group | `abapsmith-write-abap-source` |
| BAdI, enhancement spot, source plug-in | `abapsmith-enhance-standard-code` |
| BOPF business object | `abapsmith-edit-a-bopf-object` |
| Browse IMG (SPRO) customizing structure | `abapsmith-browse-img-customizing` |
| Change an IMG (SPRO) customizing value | `abapsmith-maintain-img-customizing` |
| Get a transport request, or release one | `abapsmith-put-work-on-a-transport` |
| Undo a wrong write, or read undo's refusals | `abapsmith-recover-a-bad-write` |
| Survey an unfamiliar package or object | `abapsmith-explore-a-package` |
| Run ABAP Unit, and fix what fails | `abapsmith-run-tests-and-fix` |
| ATC findings and quick fixes | `abapsmith-check-code-quality` |
| A run short-dumped or gave a wrong value | `abapsmith-debug-a-failing-run` |

Something failed at runtime: `abapsmith-debug-a-failing-run`.
`abap_debug` only catches breakpoints it triggers itself (`run` is required on
`action:"start"`) under the configured user — it cannot arm a listener and wait
for someone else's session to hit it.
