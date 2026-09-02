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
- **`VIEW/DV` create is refused for every package; a package is
  deletable, but only while empty.** `VIEW/DV` (classic/DDIC view) create is
  refused client-side, before any ADT traffic, for every package — `$TMP` and
  an omitted `package` (which resolves to `$TMP`) included. `$TMP` was the one
  package ever attempted, and it is refused for what it did, not for failing:
  measured live, a `$TMP` create commits at
  `DDIF_VIEW_PUT`/`DDIF_VIEW_ACTIVATE` but is never registered in TADIR, so
  the resulting view has no `packageRef` and `abap_write mode=delete`/
  `abap_journal mode=undo` both refuse to touch it — clearing one
  needs SE11/SE14, which is also where a new classic view has to be created
  (a CDS view, `DDLS/DF`, is the modern equivalent abapsmith both writes and
  reads). A transportable package is refused for a different reason:
  `RS_CORR_INSERT` rejects the object key itself (`TK103`). The bridge code
  and its recon stay in the tree behind that single refusal.
  `VIEW/DV` and `TRAN/T` do each have a bridge delete
  endpoint (`src/adt/view-delete.ts`, `src/adt/tran-delete.ts`), so
  `resolveWriteTarget` can reach one with a delete — but neither round-trip
  is live-exercised: no live run has ever produced a registered `VIEW/DV`
  for that endpoint to delete, and `TRAN/T`'s `RPY_TRANSACTION_DELETE`
  parameter set is inferred from the create FM's `transaction` parameter
  rather than transcribed from a capture of the delete FM itself, so it is
  not live-verified either. Neither type can be updated at all: the bridge
  implements create and delete only, with no update route for either.
  `DEVC/K` (package) is different:
  `abap_write mode=delete` (or `abap_journal mode=undo` on the create entry)
  loads the package via `CL_PACKAGE_FACTORY=>LOAD_PACKAGE` and calls
  `lo_package->delete( )` over the same classrun bridge the create uses
  (`src/adt/package-delete.ts`), and the create's
  journal entry no longer sets `irreversible: true`
  (`src/adt/package-create.ts`, `src/tools/write.ts`). The delete only ever
  succeeds on a package with no sub-packages and no TADIR objects besides its
  own `R3TR DEVC` row — checked inside the bridge before `DELETE` is called.
  A non-empty package is refused, with what it still contains listed in the
  error (up to 20 rows, flagged if there's more); abapsmith never deletes a
  package's contents on the caller's behalf, so there is no cascade.
  `abap_write`'s tool description and the `software_component` / `base_table`
  / `program` field descriptions say so up front (`src/tools/write.ts`); the
  registry documents it structurally too (`BRIDGE_DELETABLE_TYPES`,
  `src/adt/capabilities.ts`).
- **A failed create can leave an empty object behind.** `writeObject` creates
  the object shell, then PUTs its content in a separate round trip
  (`src/adt/write.ts`). If that PUT is rejected — a syntax error, a 4xx, a
  dropped connection — the shell is not rolled back and no message says one is
  needed; a later create attempt under the same name then reports
  `created: false`, as if it were an ordinary edit of something the caller
  already owned. This remains unresolved.
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
- **No table secondary index (TABL/DI) create or change.** `TABL/DI` is not a
  writable type and there is no other route to create or change a table's
  secondary index through abapsmith. Two in-band routes were tried on
  A4H and both failed: appending a second `define index ...` statement to a
  `TABL/DT` source write is rejected at check time (the table source grammar
  accepts one statement), and `abap_ui` cannot drive SE11's Indexes tab (SE11
  reports CINFO=84, so `press` refuses it). Unlike the SHLP/DH and SUSO/B
  entries above, this one rests on no live ADT recon: nobody has probed the
  table-child resource at
  `/sap/bc/adt/ddic/tables/{table}/indexes/{id}`, so it records abapsmith's
  own reach, not a proven limit of ADT. `abap_write`/`abap_read` with
  `type: "TABL/DI"` now return this specific refusal instead of a generic
  "Unknown object type". Create or change the index by hand in SE11 (the
  table's "Indexes" button) or ADT's table editor — the table itself stays
  writable here as `TABL/DT`, so a table built through abapsmith can be
  indexed afterwards.

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
