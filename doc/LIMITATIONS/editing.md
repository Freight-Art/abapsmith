# Editing

- **Wire PUT is whole-document; the tool surface is narrower than that.**
  `abap_write` accepts a targeted `edit` (`{old_string, new_string,
  replace_all?}` — splices a unique substring match; an ambiguous or missing
  match is refused, not guessed) or a `method` field (replaces one method's
  `METHOD ... ENDMETHOD` block) instead of sending full `source`. Either way
  the server assembles a complete replacement string and PUTs the whole
  document to ADT — there is still no patch/diff format and no line-range
  write; `edit`/`method` narrow what the caller holds and reasons about, not
  what goes over the wire. `expect_etag` gives compare-before-write so a
  concurrent change is caught rather than clobbered.
- **No deactivate.** There is no operation that returns an active object to
  inactive. Matters most for enhancements: an implementation flagged as
  needing an SPAU/SPDD upgrade adjustment cannot be deactivated (SAP refuses
  with `XT465`), so it cannot be deleted, and neither can the spot containing
  it. The server won't set `enho:adjustmentStatus` itself to force the write
  through — that would assert an adjustment nobody performed. SE19 is the
  remedy, and SE19 is SAPGUI.
- **No dedicated ADT collection for search-help (`SHLP/DH`).** Not gated,
  not broken, simply absent from the server's own routing table — same as
  `VIEW/DV` and `TRAN/T` below. abapsmith reaches all three through a
  plain-text catalog read (`src/adt/catalog-query.ts`, `src/adt/catalog-read.ts`)
  and a classic fluid bridge for create/update/delete
  (`src/adt/fluid/builtin/classic/abap-shlp.ts`, `abap-view.ts`, `abap-tran.ts`);
  see the entry below for what each route actually covers.
- **`abap_img_edit` still writes past the maintenance view's own check
  logic, but now says what it wrote past.** A customizing row is applied
  with a plain `MODIFY`/`DELETE` on the resolved base table, not through
  the view's generated table-maintenance function module, so the
  foreign-key checks, fixed-value checks, and maintenance-event routines
  SM30 would run on that data never run here — a row SM30 would refuse can
  still go in. `preview`, `upsert`, and `delete` responses now carry a
  `CHECKS NOT RUN` section naming what was skipped for that write: the
  `TVIMF` maintenance event routines registered for the relevant views,
  the check tables of the fields being written, and any value that isn't
  one of its domain's fixed values — see `doc/TOOLS/abap-img-edit.md` for
  what it lists and its deliberate gaps. That section is a read-only DDIC
  lookup, not a second check: it changes what a caller can see before
  arming the call, not what the tool will do. It still never refuses a row
  on the grounds it lists, and it still does not run the view's
  maintenance function module or `VIEW_MAINTENANCE_CALL`.
- **`SHLP/DH`, `VIEW/DV` and `TRAN/T` are read as rendered pseudo-DDL,
  created and updated through a classic fluid bridge, and deleted through
  the same bridge; none of the three has an ADT-native read or write
  collection.** Reading goes through a different route than writing:
  `abap_read` issues plain-text `SELECT`s against the underlying catalog
  tables over the ADT freestyle data-preview endpoint
  (`src/adt/catalog-query.ts`, `src/adt/catalog-read.ts`) and renders the
  result as pseudo-DDL — `SHLP/DH` from `DD30L`/`DD30T`/`DD31S`/`DD32S`/
  `DD33S` (plus `DD04L` for where-used), `VIEW/DV` from
  `DD25L`/`DD25T`/`DD26S`/`DD27S`/`TVDIR`, `TRAN/T` from
  `TSTC`/`TSTCT`/`TSTCP`/`TSTCA`/`AGR_TCODES`. This route needs no fluid
  bridge, so it works under `ABAP_MODE=read`, and each detail list is
  capped (200 rows for parameter/field/authorization/role lists, 50 for
  description texts) with a truncation note whenever a cap is hit — see
  `doc/TOOLS/read-and-search.md`. `DD33S-VALUEDIREC` is rendered as its raw
  code; abapsmith has not decoded its value set.
  Writing goes through the generated `IF_OO_ADT_CLASSRUN` bridge instead
  (`RS_CORR_INSERT` then `DDIF_SHLP_PUT`/`DDIF_VIEW_PUT`/
  `RPY_TRANSACTION_INSERT`, then activation where one exists — a
  transaction has none), because none of the three has a writable ADT
  collection either. A transportable package resolves a transport request
  the same way a `DEVC/K` create does — the caller's `corr_nr` if given,
  or else one picked or created under `ABAP_ALLOW_TRANSPORTS` for
  `VIEW/DV`; `TRAN/T` and `SHLP/DH` both require an explicit `corr_nr` for
  a transportable package, and refuse the create/update otherwise. A `$`
  package (`$TMP` included) refuses a `corr_nr` for all three and
  registers with `korrnum = space` instead — proven live on A4H,
  2026-09-04 (`VIEW/DV`, a transportable package, with `corr_nr`) and
  2026-09-05 (`VIEW/DV`, a `$`-prefixed package: `RS_CORR_INSERT`
  registered the view with `korrnum = space`, then the delete bridge
  removed it).
  `mode="update"` (`update_view` / `update_transaction` / `SHLP/DH`'s own
  update path) replaces the WHOLE definition, not a field at a time: for
  `VIEW/DV`, `DDIF_VIEW_PUT` re-registers the full field list and text;
  for `TRAN/T`, `updateTransaction` calls `RPY_TRANSACTION_DELETE` then
  re-`RPY_TRANSACTION_INSERT`s against the new program, inside one
  `RS_CORR_INSERT` registration; for `SHLP/DH`, `updateSearchHelp` re-PUTs
  the whole parameter/include/assignment set. `RPY_TRANSACTION_DELETE`'s
  parameter set was captured live on A4H (NetWeaver 7.54, client 001)
  2026-09-12 — earlier documentation here called it inferred from the
  create FM's `transaction` parameter; that is no longer the case:
  `IN TRANSACTION TSTC-TCODE` (required), `TRANSPORT_NUMBER RGLIF-TRKORR`,
  `SUPPRESS_AUTHORITY_CHECK`/`SUPPRESS_CORR_INSERT`/`SUPPRESS_CORR_CHECK`
  (all `CHAR1`), exceptions `NOT_EXCECUTED` (SAP's own misspelling, not a
  typo introduced here) and `OBJECT_NOT_FOUND`.
  Delete is guarded against breaking something that still points at the
  object, overridable per call: `SHLP/DH` delete refuses if
  `DD04L`/`DD35L`/`DD31S` show it still in use, unless `confirm_in_use`;
  `VIEW/DV` delete refuses if `TVDIR` holds a generated maintenance dialog
  for it (the dialog is named in the refusal), unless
  `confirm_maintenance_dialog`; `TRAN/T` delete and retarget
  (`mode="update"`) refuse if `AGR_TCODES` lists the transaction in a
  role's menu (the roles are named in the refusal), unless
  `confirm_in_role_menu`. None of the three checks an SM01 transaction
  lock either way — abapsmith has not verified where this release records
  one, and makes no guess.
  All three update routes journal the pre-update rendered pseudo-DDL as a
  before-image (`beforeSource`, `src/tools/write.ts`), but the journal
  entry is written `irreversible: true`: it is kept for audit and manual
  comparison only, not automatic undo — `abap_journal mode=undo` refuses
  an irreversible entry outright, even with `force=true`
  (`src/tools/journal.ts`), because the stored form is rendered text, not
  a payload `DDIF_VIEW_PUT`/`DDIF_SHLP_PUT`/`RPY_TRANSACTION_INSERT` could
  replay.
  Create and delete journal differently by type. A `VIEW/DV` or `TRAN/T`
  **create** is journalled the same way an ordinary create is (no
  `irreversible` flag), reachable by `abap_journal mode=undo` only when
  the pre-create read positively confirmed the object absent beforehand
  and the create's own read-back found it registered in a package. A
  `VIEW/DV` or `TRAN/T` **delete** is NOT journalled at all: the delete
  bridge captures no before-image. A `SHLP/DH` **create** is journalled
  `irreversible: true`, the same as an update. A `SHLP/DH` **delete**,
  unlike `VIEW/DV`'s and `TRAN/T`'s, IS journalled with a real
  before-image — the pre-delete existence read doubles as it, so the
  entry's `beforeSource` is the rendered pseudo-DDL — but it is still
  `irreversible: true`: that stored form is not a `DDIF_SHLP_PUT`
  payload, so undo has nothing to replay, and `src/adt/undo.ts`'s
  `vitTypeFor()` has no `SHLP/DH` case regardless. Reversal for any
  irreversible entry is a fresh `abap_write` call, never
  `abap_journal mode=undo`. See `doc/TOOLS/write-and-activate.md` for the
  full picture stated in one place.
  Live verification for all three types stayed inside `$TMP` on A4H,
  2026-09-12: a search-help elementary create (`DDIF_SHLP_ACTIVATE` rc0,
  message `DH107`), a text-and-field update (read-back showed the added
  field), a collective search help (`ZSH_I83_COLL`, a `DD31S` include row
  plus a `DD33S` assignment row), a where-used check reading `dd04l=0`/
  `dd35l=0`/`dd31s=2`, and a delete (`DD_OBJ_DEL` state `A`, message
  `DH051`, then state `N`, then `TR_TADIR_INTERFACE`; `DD30L`/TADIR empty
  afterwards); a classic view (`ZV_I83_PROBE` over `T000`) taken through
  create, read-back, update, read-back and delete (the update's
  `DDIF_VIEW_PUT` returned `D0322`, activation `rc0`, field count went
  2→3, text v1→v2; delete returned `MC691`, `DD25L`/TADIR empty
  afterwards; a live `TVDIR` read found `V_T006I` with a
  maintenance-dialog row — function group area `0SME`, package `SZME`,
  screen `0100` — while `ZV_I83_PROBE` had none, which is what the
  maintenance-dialog guard checks for); and a transaction (`ZI83_TC`)
  taken through create, retarget and delete (the retarget's
  `RPY_TRANSACTION_DELETE` returned message `EU075`, and the read-back
  showed the new program; separately, for `transaction_type='R'` the
  `dynpro` parameter is ignored — `0390` was passed in but `TSTC-DYPNO`
  came back `1000`, and no `TSTCP` row was created for the report
  transaction; a live `AGR_TCODES` read found 9 rows for `SM30` and none
  for `ZI83_TC`). What was NOT run live: a write into a transportable
  (non-`$TMP`) package, for any of the three types, in any mode — the
  `corr_nr`/transport-request path is implemented and unit-tested, not
  live-verified. Issues #83, #84 and #85 each asked for a
  transportable-package run; none was done. Reads were exercised as raw
  catalog `SELECT`s against A4H (real column lists and sample rows feed
  the fixtures), but the assembled `abap_read` code path itself could not
  be run live in this working tree — the MCP server this project talks to
  runs a released bundle, not this tree — so treat the read side as
  implemented against live-captured data, not live-verified end to end.
  `VIEW/DV` and `TRAN/T` do each have a bridge delete
  endpoint (`src/adt/view-delete.ts`, `src/adt/tran-delete.ts`), so
  `resolveWriteTarget` can reach one with a delete. `VIEW/DV`'s create
  round-trip is also live-exercised outside the 2026-09-12 run above:
  abapsmith's own create registers every view in TADIR, and a view that
  `RS_CORR_INSERT` registered in a `$`-prefixed package was deleted
  cleanly on A4H 2026-09-05 (`VIEW-DELETED` / `VIEW-GONE`).
  Neither delete bridge issues an `RS_CORR_INSERT`
  or passes a transport request, so a delete of any of the three registers
  nothing in CTS: whatever entry the object already had on a request
  (typically from its create) survives the delete and must be removed
  separately with `abap_transport` operation `"removeObject"`, which needs
  ABAP_MODE=admin — and which CTS can refuse outright once the request
  already holds two or more E071 rows for the object; abapsmith cannot say
  what reliably produces that duplication (see
  `doc/LIMITATIONS/not-implemented-and-unproven.md`), leaving the entry, its
  lock, and (for `VIEW/DV`) its TADIR row in place. That is also why the
  safety gate judges these deletes as local mutations rather than against
  `ABAP_ALLOW_TRANSPORTS` — see `doc/SAFETY/safety-gate.md`.
  `DEVC/K` (package) is different:
  `abap_write mode=delete` (or `abap_journal mode=undo` on the create entry)
  loads the package via `CL_PACKAGE_FACTORY=>LOAD_PACKAGE` and calls
  `lo_package->delete( )` over the same classrun bridge the create uses
  (`src/adt/package-delete.ts`), and the create's
  journal entry no longer sets `irreversible: true`
  (`src/adt/package-create.ts`, `src/tools/write.ts`). The delete only ever
  succeeds on a package with no sub-packages and no TADIR objects besides its
  own `R3TR DEVC` row — checked inside the bridge before `DELETE` is called.
  A non-empty package is refused, with everything it still contains listed in
  the error, no matter how many rows; abapsmith never deletes a package's
  contents on the caller's behalf, so there is no cascade.
  `abap_write`'s tool description and the `software_component` / `base_table`
  / `program` field descriptions say so up front (`src/tools/write.ts`); the
  registry documents it structurally too (`BRIDGE_DELETABLE_TYPES`,
  `src/adt/capabilities.ts`).
- **A delete is refused, pre-lock, when the `corr_nr` you name is not the
  request that already holds the object; a write is not.** SAP's CTS
  records a change against the request that holds the object's lock entry
  — a second request cannot take over that entry — so naming a different
  `corr_nr` on a delete cannot redirect where the deletion lands, only
  whether it happens at all. `src/adt/write.ts` checks this against ADT's
  own `transportchecks` pre-flight answer before any lock is taken: a
  named `corr_nr` that disagrees is refused outright (`TRANSPORT_ERROR`,
  `details.reason: CORR_NR_NOT_HONOURED`, `details.corrNr`,
  `details.lockCorrNr`, `details.deleted: false`), with no enqueue and no
  journal entry — a second, identical check still sits under the lock as a
  backstop for the rarer case the pre-flight missed, and that one reports
  the lock as released rather than never taken. Left unnamed, the delete
  still proceeds under the request that already holds the object, reported
  with `corr_nr_honoured: false` and both numbers named. `mode=write`/
  `edit` (PUT) does not refuse this way at all: a transportable object can
  only be recorded where CTS already holds it, so a write naming a
  different `corr_nr` proceeds and is recorded there anyway, with the
  response reporting `corr_nr_honoured: false` instead of refusing — see
  `doc/TOOLS/write-and-activate.md` § "`mode=delete` and transport
  requests" for the full asymmetry. Before this fix neither path refused
  anything: observed live on A4H during v0.4.0 general verification, an
  object created under one request was deleted with a second, empty
  request passed as `corr_nr`, and `abap_transport show` afterwards found
  the object's row on the creating request and nothing on the other, with
  no error and no mention of the substitution — that run is why the
  refusal above now exists. Splitting create and delete across two
  requests still will not move where the deletion lands, for the same
  reason. The `removeObject` remedy for separating the two can still be
  refused by CTS's own duplicate-row check (`TRINT_DELETE_COMM_OBJECT_KEYS`
  raises `w_duplicate_entry` at two or more E071 rows for the object — see
  `doc/LIMITATIONS/not-implemented-and-unproven.md`), but abapsmith cannot
  say what reliably produces the duplication: a create immediately
  followed by a delete of the same object on one request, once assumed to
  be the recipe, was tried live on A4H, 2026-09-12, and did not reproduce
  it — the two rows had already collapsed into one, and `removeObject`
  succeeded with `removedCount: 1`.
- **A failed create can still leave an empty object behind, but not silently.**
  `writeObject` creates the object shell, then PUTs its content in a separate
  round trip (`src/adt/write.ts`). A rejected PUT goes through
  `reportCreatePutRejection`, which releases the lock, attempts a rollback
  DELETE of the shell, and says in the refusal whether the shell was removed or
  was left in place and why. Rollback is deliberately skipped when the
  rejection is not a confirmed content rejection (only `BAD_INPUT` and
  `CHECK_FAILED` are — a transport-level failure could have landed after the
  server already committed), when the session that held the lock is dead, and
  for the properties-shape types whose create POST already carried the full
  payload (`TTYP/DA`, `ENQU/DL`); it can also fail on its own. In those cases
  the object does survive, and a later create attempt under the same name
  reports `created: false`, as if it were an ordinary edit of something the
  caller already owned.
- **CDS view syntax depends on the target release, and this server does not
  check it.** DDLS source is opaque text handed to ADT verbatim (see the
  `DDLS/DF` entry in `src/adt/types.ts`), so a syntax mismatch is caught by
  ADT itself, not by this server, and shows up as an activation error rather
  than a refusal. `DEFINE VIEW ENTITY`, `DEFINE CUSTOM ENTITY`,
  `EXTEND VIEW ENTITY` and `AS PROJECTION ON` all require ABAP 7.55+. This
  project's A4H target is 7.54 (SAP_BASIS 754 SP0007, S/4HANA 1909), where
  only the classic `@AbapCatalog.sqlViewName: '...'` + `define view` form
  activates, and `define root view` additionally needs
  `@AbapCatalog.preserveKey: true` when a BDEF is defined on it — confirmed
  live during the RAP live-acceptance run.
- **A registry `create` entry does not by itself mean creation is proven.**
  `create` has only ever meant "this type has a wired creation recipe" — a
  vendor `CreatableTypes` entry or a hand-built request — not "this type
  reliably creates." `create.verified` (`src/adt/capabilities.ts`) records
  the actual confidence as a tri-state: `true` (a live create has actually
  succeeded through abapsmith's own tool surface), `false` (tried live and
  does not reliably work), or `"unverified"` (never tried). Only `true`
  opens the gate — `writeObject` refuses (`UNSUPPORTED`) a create for any
  type not marked `verified: true` rather than attempting it and letting it
  fail live.
- **No authorization-object (SUSO/B) read or write.** Confirmed by live
  reconnaissance: `SUSO/B` is a real, registered ADT
  object type, but no ADT collection exists for reading or writing one — the
  only route that answers a `GET` at all is the generic VIT bridge, and it
  returns a basic-properties stub (name/description/package) with no field
  list and no permission values, not a usable read of the object's actual
  content. SU21 is the only way to view or edit an authorization object.
- **No table secondary index (TABL/DI) change or read; create and delete are
  bridge-only.** A live probe on A4H 2026-09-05 confirmed there is no ADT
  REST route for indexes at all — every route under a table 404s. Creation
  and deletion instead run through `DD_INDEX_INTERFACE` via a classrun
  bridge (see `src/adt/capabilities.ts`); the bridge cannot update an
  existing index — drop and recreate instead — and there is no read-back
  for `TABL/DI` through abapsmith either way. Create is live-proven and
  unaffected by anything below: a non-unique index and a unique index that
  includes the base table's client field both succeed, an omitting create
  is refused `BAD_INPUT` before the FM runs, and a third live round the
  same day reran both and got the same result. A delete can report
  `ACTFAILED` even after it already took effect; the fix for that — commit
  regardless, then re-verify via `DD12V`/`DD17S` — never ran live, because
  the fix's own added message rendered as a source line over the
  255-character ABAP limit, so every delete failed the class-source PUT
  before `DD_INDEX_INTERFACE` was ever called and the deployed bridge
  class stayed on its pre-fix body. That was fixed again, with a line-length
  guard on every generated bridge class body, not just this one, and a
  fourth live round the same day deleted both a non-unique and a unique
  index through the redeployed bridge and got `NOT_FOUND` on a re-delete —
  delete is live-proven in `$TMP`. `ACTFAILED` still comes back set on a
  delete that took effect, so treat the flag as noise, not a result. Deleting the
  base table is not blocked by a surviving secondary index; a later
  cleanup deleted a base table whose indexes' catalog rows may still have
  existed, and whether they were cascaded away or orphaned is unverified —
  there is nothing to read back either way. At the time of that cleanup
  (2026-09-05), `abap_data_preview` also had no way to target a specific
  index's catalog row even if there had been something to read; that is no
  longer the limiting factor — `abap_data_preview` now takes a structured
  `where` filter (see `doc/TOOLS/diagnostics.md`), so a query like
  `{"table":"DD12V","where":[{"field":"SQLTAB","op":"eq","value":"<table>"}]}`
  is now practical. It still cannot answer this specific open question,
  because `DD12V`/`DD17S` were never re-read after that cleanup and no
  index name from it was recorded to look for. SE11 (the table's "Indexes"
  button) is the only way to inspect one directly; the table itself stays
  writable here as `TABL/DT`.

## FPM / Web Dynpro configuration is read-only, deliberately

`abap_fpm_read` reads FPM and Web Dynpro configurations. There is no matching
write tool, and this is a decision rather than a backlog item.

ADT REST answers `405` to every write verb on these objects, confirmed at the
routing layer: the server's own `discovery.xml` advertises no create media type
for these collections, unlike sibling Web Dynpro collections that do. The
alternative — a classrun bridge driving `WDY_CONFIG_DATA` / `WDY_CONFIG_APPL`
directly — was built and rejected: it silently altered a meaningful share of
rows on round-trip, with no parse or render error announcing it, no
transactional undo, and only advisory locking.

A write path that silently corrupts data, with nothing raising an error, is
worse than no write path. A test guards the absence: the day a tool by that
name is registered, it fails, forcing the guard and the documentation
explaining the absence to be revisited together.
