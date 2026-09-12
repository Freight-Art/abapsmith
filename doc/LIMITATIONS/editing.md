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
- **No search-help (SHLP/DH) write.** No dedicated ADT collection exists — not
  gated, not broken, simply absent from the server's own routing table.
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
- **`VIEW/DV` cannot be read back or changed once created; a package is
  deletable, but only while empty.** `VIEW/DV` (classic/DDIC view) is
  created through a generated `IF_OO_ADT_CLASSRUN` bridge (`RS_CORR_INSERT`
  then `DDIF_VIEW_PUT` then `DDIF_VIEW_ACTIVATE`, see
  `src/adt/view-create.ts`). A transportable package resolves a transport
  request the same way a `DEVC/K` create does — the caller's `corr_nr` if
  given, or else one picked or created under `ABAP_ALLOW_TRANSPORTS`; a
  `$` package (`$TMP` included) still refuses a `corr_nr` and registers
  with `korrnum = space` instead — proven live on A4H, 2026-09-04
  (a transportable package, with `corr_nr`) and 2026-09-05 (a
  `$`-prefixed package: `RS_CORR_INSERT` registered the view with
  `korrnum = space`, then the delete bridge removed it). `TRAN/T`'s create
  still requires an explicit `corr_nr` for a transportable package:
  `RPY_TRANSACTION_INSERT`'s signature was read live on
  A4H 2026-09-05 and forwards `transport_number` verbatim to
  `RS_CORR_INSERT` as `korrnum`, but no create into a transportable
  package has been run. What does not change: there is no
  ADT-readable collection for a classic view, so a view just created cannot
  be read back by abapsmith, ever — SE11/SE14 is the only way to inspect
  one. There is no update route either: only delete and recreate.
  `VIEW/DV` and `TRAN/T` do each have a bridge delete
  endpoint (`src/adt/view-delete.ts`, `src/adt/tran-delete.ts`), so
  `resolveWriteTarget` can reach one with a delete. `VIEW/DV`'s round-trip is
  live-exercised: abapsmith's own create registers every view in TADIR, and a
  view that `RS_CORR_INSERT` registered in a `$`-prefixed package was deleted
  cleanly on A4H 2026-09-05 (VIEW-DELETED / VIEW-GONE). `TRAN/T`'s
  `RPY_TRANSACTION_DELETE` parameter set is inferred from the create FM's
  `transaction` parameter rather than transcribed from a capture of the
  delete FM itself, so it is not live-verified. Neither type can be
  updated at all: the bridge implements create and delete only, with no
  update route for either. Neither delete bridge issues an `RS_CORR_INSERT`
  or passes a transport request, so a delete of either type registers
  nothing in CTS: whatever entry the object already had on a request
  (typically from its create) survives the delete and must be removed
  separately with `abap_transport` operation `"removeObject"`, which needs
  ABAP_MODE=admin — and which CTS can refuse outright once the request
  already holds two or more E071 rows for the object; abapsmith cannot say
  what reliably produces that duplication (see
  `doc/LIMITATIONS/not-implemented-and-unproven.md`), leaving the entry, its
  lock, and (for `VIEW/DV`) its TADIR row in place. That is also why the
  safety gate judges these two
  deletes as local mutations rather than against `ABAP_ALLOW_TRANSPORTS` —
  see `doc/SAFETY/safety-gate.md`.
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
- **No authorization-object (SUSO/B) write; ADT itself still has no read
  route.** Confirmed by live reconnaissance: `SUSO/B` is a real, registered
  ADT object type, but no ADT collection exists for reading or writing
  one — the only route that answers a `GET` at all is the generic VIT
  bridge, and it returns a basic-properties stub (name/description/package)
  with no field list and no permission values, not a usable read of the
  object's actual content. `abap_read {"object":"<NAME>","type":"SUSO/B"}`
  answers reads a different way: it renders the object's DEFINITION —
  class, text, fields, data elements, check tables, fixed values, permitted
  activities — from eight DDIC catalog tables (`TOBJ`, `TOBJT`, `TOBCT`,
  `TACTZ`, `TACTT`, `AUTHX`, `DD04L`, `DD07V`), not from an ADT object
  resource, and never from an `AGR_*` or `UST*` table — this is the
  object's definition, not a list of who holds it. See
  [doc/SAFETY/data-access-and-credentials.md](../SAFETY/data-access-and-credentials.md)
  for that boundary. Write is unaffected: SU21 is still the only way to
  edit an authorization object.
- **No table secondary index (TABL/DI) change; create and delete are
  bridge-only.** A live probe on A4H 2026-09-05 confirmed there is no ADT
  REST route for indexes at all — every route under a table 404s. Creation
  and deletion instead run through `DD_INDEX_INTERFACE` via a classrun
  bridge (see `src/adt/capabilities.ts`); the bridge cannot update an
  existing index — drop and recreate instead. There is still no ADT
  read-back for `TABL/DI`, but `abap_read {"object":"<TABLE>/<INDEX>","type":"TABL/DI"}`
  now renders one from a `DD12V`/`DD17S` catalog read, and a `TABL/DT` read
  grew an `indexes` section listing every secondary index found the same
  way. Create is live-proven and
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
  delete is live-proven in `$TMP`. `ACTFAILED` itself is no longer the
  question: the create and delete bridges now run a definitive post-write
  `DD12V`/`DD17S` re-read (`src/adt/index-read.ts`), and the response
  reports what that re-read found — `verified` plus `index_present`/
  `index_active` — instead of the bridge's own claim. `ACTFAILED` is not
  surfaced to the caller at all any more, for either operation; a re-read
  that itself fails to run is reported as "not verified" with a reason,
  never inferred from the flag. Live-observed regression: a delete's
  response `markers` field used to join the raw transcript tags verbatim,
  so `INDEX-DELETED-ACTFAILED` still reached the caller there even though
  nothing else in the response mentioned `ACTFAILED` — now filtered out of
  `markers` too (`callerVisibleIndexTags`, `src/adt/index-create.ts`); the
  underlying transcript still records the raw tag as evidence, it is only
  the caller-visible field that omits it. The same re-read resolves whether a
  base-table delete cascades its secondary indexes away or leaves them
  orphaned: `abap_write`'s `TABL/DT` delete now reads the table's indexes
  immediately beforehand and reports what it found in the response, rather
  than leaving that outcome to a later, unfiltered `abap_data_preview`
  check. SE11 (the table's "Indexes" button) remains the only way to
  inspect one directly outside abapsmith; the table itself stays writable
  here as `TABL/DT`.

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
