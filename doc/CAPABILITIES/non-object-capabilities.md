## Non-object capabilities

| Entity | Create | Read | Update | Delete | Activate | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Debugger | n/a | yes | no | n/a | n/a | live | Breakpoints are set and cleared as part of a session; variables can be read but never written, and the frame cursor moves the read position only. |
| Breakpoints | yes | yes | no | yes | n/a | live | Armed only as part of starting a session, deleted only when it ends, and only ones this session created. No standalone list or remove. `skipCount` is accepted by the server and not enforced, so expect a stop on every hit. |
| ABAP Unit | n/a | yes | n/a | n/a | n/a | mixed | Runs existing tests; cannot write or delete them, and never requests coverage. See the outcome breakdown below. |
| ATC | partial | yes | no | no | n/a | mixed | A run creates a server-side worklist as a side effect; there is no worklist delete, no variant create, and exemption management is deliberately absent. |
| Quick fixes | no | yes | yes | no | yes | mixed | Position-driven only, not finding-driven — the ATC route was tried and rejected. Deterministic proposals only; a parameterized one is refused `BAD_INPUT`. Listing is gated as a write because it posts the whole object source. |
| Runtime dumps | n/a | yes | n/a | no | n/a | live | Read-only feed with a residence window that cannot be widened. The variables chapter is absent from the schema unless an operator enables it. |
| Object activation | n/a | n/a | n/a | n/a | yes | live | Check-only and activate modes, single and batched. There is no deactivate in ADT, which is why activation can never be undone. |
| Transport requests | yes | yes | partial | yes | n/a | live | Create, add a user, and set an owner. Delete is admin-gated and requires echoing the request identifier. Objects cannot be added or removed directly, and a locked entry cannot be unlocked. |
| Transport release | n/a | yes | n/a | n/a | yes | live | Dry run by default, armed only by echoing the request identifier, and gated separately from ordinary write access. Reports four distinct outcomes and never overstates one. |
| Write journal | yes | yes | no | no | n/a | tests | Entries are written by the tools themselves; the journal is read-only to the user and has no delete. |
| Undo | n/a | n/a | yes | yes | n/a | tests | Reverts one journal entry. Refuses activation, transport release, enhancement, and every irreversible entry, with no override. |
| Object search | n/a | yes | n/a | n/a | n/a | live | Name-pattern and where-used only. There is no source-text search. |
| Where-used | n/a | yes | n/a | n/a | n/a | live | Static only; dynamic calls do not appear. The server ignores every limit parameter, so the whole result set is always fetched and `max` bounds only the display. |
| Data preview | n/a | partial | no | n/a | n/a | mixed | One DDIC table or view per call, off by default, denylisted for sensitive tables, refused on any system that reports itself productive. No free-form SQL surface exists for callers — the catalog-driven SELECTs the IMG structure tool assembles server-side are not a caller-facing SQL surface either, since a caller never supplies or influences the statement text. |
| IMG (customizing) navigation | no | partial | no | no | n/a | tests | Navigates the IMG structure only — activities, nodes, and the views/tables behind them — via the ADT freestyle data-preview endpoint, with SQL assembled server-side from a fixed catalog in `src/adt/img-catalog.ts`; every table in the catalog is measured against a live system and `IMG_CATALOG_VERIFIED` is `true`. Generates no ABAP and deploys nothing, so it runs under `ABAP_MODE=read`. Reading the customizing entries themselves is `abap_data_preview`'s job; changing them is `abap_img_edit`'s. |
| IMG (customizing) write | no | partial | yes | yes | n/a | mixed | Writes a resolved base table's rows directly (a guarded `MODIFY`/`DELETE`), not through the view's own SM30-generated maintenance function module — its field-catalogue/dynamic-row-layout requirement was never established outside the SM30 dialog. Transport bookkeeping goes through the same CTS pair (`TR_OBJECTS_CHECK`/`TR_OBJECTS_INSERT`) SM30 itself uses, still interface-only knowledge, never called from here; `create_request` makes the type-`W` request via `TR_INSERT_REQUEST_WITH_TASKS`, called once from here on 2026-09-05 and confirmed working (a first-run defect with no task and a lost request number is why the tool now reports the number before checking for a task). Restricted to delivery classes `C`/`G`/`E`, at most 50 rows per call, and an armed write needs an exact `confirm` echo of the base table name. Generated helper classes go into the dedicated `$ZMCP_HELPERS` package, never `$TMP`. |
| Running code | n/a | n/a | n/a | n/a | yes | live | Classes implementing the classrun interface, and classic reports through a generated bridge class. No interactive output. |
| UI automation | n/a | yes | n/a | n/a | yes | mixed | Classic dynpro only, driven by generated batch input. Pressing commits immediately with no dry run and no rollback. |
| Service and OData exposure | no | yes | no | no | n/a | tests | Metadata introspection only. Publication and business data are structurally refused. |
| Object read | n/a | yes | n/a | n/a | n/a | live | Source, outline, method slice, raw properties, enhancements, version history, and diff. |

- **ABAP Unit outcome grading — this is the whole point of the evidence
  column, so it is not smoothed over here.** The run reports one of four
  outcomes and never collapses "nothing ran" into "everything passed." Of the
  four: the no-tests-ran outcome is `live`, captured from a real run; the
  failed outcome is `live`, captured from a real run; the per-method pass
  verdict is `live`, observed inside that same failure capture; but the
  run-level all-passed outcome has never been observed live at all — it
  exists only in a test that manufactures it by stripping the alerts element
  out of the captured failure. The unknown outcome has never been observed
  live either and is built entirely from hand-written hypothetical
  documents.
- **ATC.** The run acknowledgement is live-captured, and from it the
  following are confirmed: the run POST is synchronous rather than polled;
  the worklist identifier, its timestamp and the info blocks are child
  elements rather than attributes; the used-object-set and completeness
  flags are attributes on the worklist element; and an info block can
  repeat. Everything beyond that single object, single variant, single run
  is not confirmed — no DDIC object, no class, no second variant, no
  zero-findings run, and no error path. The worklist-read capture exists in
  the tree but is not wired into any test, so findings parsing is covered by
  synthetic documents only.
- **Quick fixes.** Both wire hops — the position-based evaluation POST and
  the per-proposal delta POST — are grounded in 12 live captures against a
  sandbox appliance, replayed in `test/quickfix-wire.test.ts`: URLs, media
  types, request bodies, response shapes, and every delta-range semantic
  (1-based lines, 0-based columns, end-exclusive ranges, unsorted units, LF
  content newlines regardless of the object's own line ending). The
  end-to-end apply path — lock, PUT, unlock, activate, journal — is tested
  only against an in-process fake ADT server, not a live one. Determinism
  filtering is code-verified against the same captures, not live-applied: a
  non-empty `userContent` is the server's own pre-filled dialog input, and
  fixtures 806/811 show hop 2 still returns a valid but no-attributes delta
  if that input is dropped — a wrong result, not an error — while a
  fix-type deny-list catches the opposite gap, `rename_quickfix`, which
  ships no `userContent` at all (802) yet whose empty-input delta is an
  identity no-op (803).
- **Debugger.** The most thoroughly live-covered area: real cassettes exist
  for token fetch, stack read, listener hit, attach bootstrap, listener
  conflict, and both breakpoint accept and reject. Two exceptions: the
  run-to-line and jump-to-line step kinds have no live capture, and
  jump-to-line is disabled by default behind both an environment flag and a
  per-call confirmation echo. The debugger is read-only with respect to
  variables by deliberate design; the underlying set-value verb is left
  unexposed.
- **Activation.** Batched activation resolves and authorises every object
  before activating any, so one refusal refuses the whole set. Batches are
  chunked because a single large DDIC batch has been observed to take a live
  system down. A two-phase handshake co-activates dependents that are still
  inactive, and the result is cross-checked against the object's own version
  history rather than trusted from an empty response. One corner is honest
  about itself: the still-inactive verification path is inferred from a
  revision kind and has never been measured live.
- **Journal and undo.** The journal records writes, transport operations,
  activation, enhancement operations, and BOPF writes; it does not record
  FPM reads or BOPF activation. Undo can delete a create, restore an update,
  and recreate a delete. `force` overrides drift, and nothing else — it
  cannot manufacture the positive absence evidence a create-undo needs, and
  it does not override the enhancement, transport-release, activation,
  cross-system, class-include, or irreversible refusals. A class delete only
  ever recorded the main source, so local definitions, implementations,
  macros and test classes are not restored and the undo reports itself
  partial. Undo has no committed live capture at all — its only live contact
  is an opt-in integration test that is skipped unless a live system is
  configured — which is why it is graded `tests` while the operations it
  reverses are graded `live`.
- **UI automation.** Discovery is read-only in effect but still deploys a
  throwaway bridge class. A press runs a transaction with scripted batch
  input, commits, and cannot be rolled back; it is gated on admin mode plus a
  separate opt-in flag plus an exact confirmation, and a denylist covers
  operating-system command, user and role administration, client
  administration, ad-hoc report execution, transport administration, and
  table maintenance. The denylist is a guardrail and not a security boundary,
  and there is no override for it. Before every press the transaction's own
  type is read, and a press against a report transaction is refused, because
  a transaction call there runs the report directly and ignores the scripted
  input. That precheck's own evidence is graded honestly: it is
  code-verified, with no live observation of the refusal. Every press is
  journalled irreversible with no captured before-state.
- **Data preview.** The split matters: the CSRF token refresh and retry, and
  the extra-row signal used to say "more rows exist," are backed by real
  captures; the name validation, gating, and refusal policy are code and
  test coverage only.
- **IMG navigation.** ADT has no IMG REST route, so `abap_img` sends fixed,
  catalog-driven `SELECT`s to the ADT freestyle data-preview endpoint —
  table and field names come only from `IMG_CATALOG`
  (`src/adt/img-catalog.ts`), never from caller text, and no ABAP is
  generated or deployed. Because nothing is deployed, the tool needs no
  write access and registers under `ABAP_MODE=read`. Every table it
  actually queries is `confidence: "high"`, measured against a live system.
  The reference-IMG tree root is found by matching English title text,
  since the tree has no mnemonic id — a system
  whose customizing text is not English will see `tree` return nothing at
  the root, which is a text-match miss, not a broken catalog table.
- **IMG write.** `abap_img_edit` writes a resolved base table's rows
  directly with a guarded `MODIFY`/`DELETE`, not through the view's own
  SM30-generated table-maintenance function module — building that
  module's required field-catalogue/dynamic-row-layout input outside the
  SM30 dialog itself was never established, so none of the view's own
  foreign-key checks, fixed-value checks, or table-maintenance-generator
  events run. Transport bookkeeping still goes through the same CTS pair
  (`TR_OBJECTS_CHECK`/`TR_OBJECTS_INSERT`) SM30 itself uses; both remain
  interface-only knowledge here, read from the system's own catalogue and
  never called from this server. `create_request` makes the type-`W`
  request via `TR_INSERT_REQUEST_WITH_TASKS`, which is different: it was
  called from here once, on 2026-09-05, and succeeded, creating a real
  request. That first call omitted `IT_USERS`, so the request came back
  with no task and its number was lost before being printed — the reason
  `create_request` now reports the number before checking for a task. A
  second live call, on 2026-09-06, passed `IT_USERS` as a bare `sy-uname`
  row and failed to activate outright: the row type, `SCTS_USER`, is a
  two-field structure (`USER`/`TR_AS4USER`, `TYPE`/`TRFUNCTION`, measured
  from DD40L/DD03L), not a plain user-name table. `IT_USERS` now fills
  that structure, and the response carries the created task's number and
  its type (`taskType`) alongside the request number. Still unproven from
  here: whether the function module honours the `TYPE` value passed, and
  every failure path. Generated helper classes go into the dedicated,
  non-transportable `$ZMCP_HELPERS` package, never `$TMP`, created on
  first use with no silent fallback if that fails.
- **Search.** Every request goes out untyped and is filtered client side,
  because the server's own type filter drops fields and half-ignores the
  subtype; the fetch window is deliberately wider than the display cap and
  the difference is disclosed. A known server-side description mispairing is
  repaired for two object groups, confirmed on the wire, and flagged but not
  repaired for others.
