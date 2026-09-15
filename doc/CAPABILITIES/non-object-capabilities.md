## Non-object capabilities

| Entity | Create | Read | Update | Delete | Activate | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Debugger | n/a | yes | no | n/a | n/a | live | Breakpoints are set and cleared as part of a session; variables can be read but never written, and the frame cursor moves the read position only. |
| Breakpoints | yes | yes | no | yes | n/a | live | Armed only as part of starting a session, deleted only when it ends, and only ones this session created. No standalone list or remove. `skipCount` is accepted by the server and not enforced, so expect a stop on every hit. |
| ABAP Unit | yes | yes | yes | n/a | yes | live | Runs existing tests: PASSED/FAILED/NO TESTS RAN/UNKNOWN, never collapsing "nothing ran" into a pass — see the outcome breakdown below. Test classes are created and updated through `abap_write` (`include="testclasses"`), not through `abap_test` itself; verified live end to end — write, activate, run, read-back — against SAP A4H, 2026-09-12. A single class include cannot be deleted on its own (ADT has no such verb), only emptied by writing new content over it. There is no activate verb for the include itself: `abap_activate` on the owning class activates `testclasses` along with it, confirmed live, SAP A4H, 2026-09-12. |
| ABAP Unit coverage | n/a | yes | n/a | n/a | n/a | mixed | Opt-in (`coverage: true` on `abap_test`), scoped with `coverage_for`. The wire protocol — coverage negotiation on the run, the covered-objects roster, the coverage query, an untouched object's zero-summary response with no per-node breakdown — is `live` (SAP A4H, 2026-09-12; `test/fixtures/live-captured/852`–`856-i75-*`). abapsmith's own report rendering is now `live` too, end to end: `abap_test { object: "ZCL_I75_UNDO", type: "CLAS/OC", coverage: true }` against SAP A4H, 2026-09-12, returned outcome PASSED, tests 1, passed 1, the header `coverage: statement 2/2 (100%), branch 1/1 (100%), procedure 1/1 (100%)` line, a `COVERAGE` section with a class row and a per-method row for `DOUBLE`, and an `ALSO TOUCHED` list of 15 framework objects plus a `… and 19 more (truncated)` line — so the focus set, the header ratio line, the per-class/per-method table, and `ALSO TOUCHED` with its cap are confirmed as rendered MCP tool output, not just wire protocol. Still `tests`-only, exercised only against the live-captured fixtures, not yet observed live as rendered output: the `UNCOVERED METHODS` section, the `not measured by this run` / `not touched by this run` / `not queried` wordings, and `coverage_for` naming an object other than the one under test. See [execute-and-test.md](../TOOLS/execute-and-test.md). |
| ATC | partial | yes | no | partial | n/a | mixed | A run creates a server-side worklist as a side effect; there is no variant create, and exemption management is deliberately absent. Worklist delete IS attempted (both directly and via `auto_cleanup`) but this release's server refuses every attempt with HTTP 405, so the worklist persists — a caching strategy limits the litter. |
| Quick fixes | no | yes | yes | no | yes | mixed | Position-driven only, not finding-driven — the ATC route was tried and rejected. Deterministic proposals only; a parameterized one is refused `BAD_INPUT`. Listing is gated as a write because it posts the whole object source. |
| Runtime dumps | n/a | yes | n/a | no | n/a | live | Read-only feed with a residence window that cannot be widened. The variables chapter is absent from the schema unless an operator enables it. |
| Runtime trace (SAT) | yes | yes | n/a | yes | n/a | mixed | Scoped to one connected user and one object; `op=run` creates a trace request, executes the object, waits for and reads the trace, then deletes the request, while `op=start` leaves that cleanup to the caller — a fully consumed request is not cleaned up by the server on its own. `view="tree"` is refused up front against an aggregated trace rather than sent to fail server-side. Read views are `hitlist`, `db` (statement kind, table, counts and time — not full SQL text), and `tree`. The standalone SQL-trace collection (`/sap/bc/adt/runtime/traces/sqltraces`) does not exist as a resource on the reference release and is `unverified`; SQL access on that release is read only through the `db` view of the same trace. Refused outright on a cloud tenant, where ADT discovery does not offer `traces.abaptraces`. |
| Object activation | n/a | n/a | n/a | n/a | yes | live | Check-only and activate modes, single and batched. There is no deactivate in ADT, which is why activation can never be undone. |
| Transport requests | yes | yes | partial | yes | n/a | live | Create, add a user, and set an owner. Delete is admin-gated and requires echoing the request identifier. Objects cannot be added or removed directly, and a locked entry cannot be unlocked. |
| Transport release | n/a | yes | n/a | n/a | yes | live | Dry run by default, armed only by echoing the request identifier, and gated separately from ordinary write access. Reports four distinct outcomes and never overstates one. |
| Write journal | yes | yes | no | no | n/a | tests | Entries are written by the tools themselves; the journal is read-only to the user and has no delete. |
| Undo | n/a | n/a | yes | yes | n/a | mixed | Reverts one journal entry. Refuses activation, transport release, enhancement, and every irreversible entry, with no override. Class-delete recreate (with its four sub-includes) and sub-include-targeted restore are `live` (SAP A4H, 2026-09-12); ordinary `main`-source restore and create-delete are `tests`-only. See the "Journal and undo" note below. |
| Object search | n/a | yes | n/a | n/a | n/a | live | Name-pattern search only; where-used and source-text search are separate rows below. |
| Where-used | n/a | yes | n/a | n/a | n/a | live | Static only; dynamic calls do not appear. The server ignores every limit parameter, so the whole result set is always fetched and `max` bounds only the display. |
| Source search | n/a | partial | n/a | n/a | n/a | mixed | Line-wise text scan (`abap_search mode=source`) over PROG/CLAS/INTF/FUGR/DDLS source, via the built-in `scan` fluid tool. `partial`, not `yes`: a scope (`packages` and/or a narrower-than-`*` `objects` pattern) is mandatory, a fixed 200-object ceiling applies, and it needs the fluid API (`ABAP_FLUID_API` on, `ABAP_MODE` not `read`) — a repository-wide, ungated scan is not reachable. Excludes comments by default (a per-line heuristic, not a parser). `live` (A4H, 2026-09-12): literal and regex line matching (including a spaced pattern), FUGR include resolution, DDLS/CDS reads, package/subpackage scope, the hit-cap/object-ceiling truncation report, and the comment heuristic. `tests`-only: the `abap_search mode=source` MCP dispatch path itself, since the live server runs a released bundle that predates this feature. |
| Data preview | n/a | partial | no | n/a | n/a | mixed | One DDIC table or view per call, off by default, denylisted for sensitive tables, refused on any system that reports itself productive. No free-form SQL surface exists for callers — the catalog-driven SELECTs the IMG structure tool assembles server-side are not a caller-facing SQL surface either, since a caller never supplies or influences the statement text. |
| IMG (customizing) navigation | no | partial | no | no | n/a | tests | Navigates the IMG structure only — activities, nodes, and the views/tables behind them — via the ADT freestyle data-preview endpoint, with SQL assembled server-side from a fixed catalog in `src/adt/img-catalog.ts`; every table in the catalog is measured against a live system and `IMG_CATALOG_VERIFIED` is `true`. Generates no ABAP and deploys nothing, so it runs under `ABAP_MODE=read`. Reading the customizing entries themselves is `abap_data_preview`'s job; changing them is `abap_img_edit`'s. |
| Package (DEVC/K) navigation | no | yes | no | no | n/a | mixed | `abap_read {"object":"<PKG>","type":"DEVC/K"}` returns the package header (type, description, super package, software component, transport layer, application component, responsible) plus its node contents: a per-type object count, direct sub-packages, and the object rows themselves, each opened with an ordinary `abap_read`. `types` filters the rows to given kind codes; `depth` (1-3, default 1) recurses into sub-packages breadth-first, capped at 25 nodestructure round trips total, with a note naming any sub-package the cap left unexpanded. `offset`/`limit` page the row listing. An empty package answers HTTP 200 with a zero-byte body, reported as "no contents," not as an error. See the note below. |
| IMG (customizing) write | no | partial | yes | yes | n/a | mixed | Writes a resolved base table's rows directly (a guarded `MODIFY`/`DELETE`), not through the view's own SM30-generated maintenance function module — its field-catalogue/dynamic-row-layout requirement was never established outside the SM30 dialog. Transport bookkeeping goes through the same CTS pair (`TR_OBJECTS_CHECK`/`TR_OBJECTS_INSERT`) SM30 itself uses, still interface-only knowledge, never called from here; `create_request` makes the type-`W` request via `TR_INSERT_REQUEST_WITH_TASKS`, called once from here on 2026-09-05 and confirmed working (a first-run defect with no task and a lost request number is why the tool now reports the number before checking for a task). Restricted to delivery classes `C`/`G`/`E`, at most 50 rows per call, and an armed write needs an exact `confirm` echo of the base table name. Generated helper classes go into the dedicated `$ABAPSMITH_FLUID_API` package, never `$TMP`. |
| Running code | n/a | n/a | n/a | n/a | yes | live | Classes implementing the classrun interface, and classic reports through a generated bridge class. No interactive output. |
| UI automation | n/a | yes | n/a | n/a | yes | mixed | Classic dynpro only, driven by generated batch input. Pressing commits immediately with no dry run and no rollback. |
| Service and OData exposure | no | yes | no | no | n/a | tests | Metadata introspection only. Publication and business data are structurally refused. |
| Object read | n/a | yes | n/a | n/a | n/a | live | Source, outline, method slice, raw properties, enhancements, version history, and diff. |

- **ABAP Unit outcome grading — this is the whole point of the evidence
  column, so it is not smoothed over here.** The run reports one of four
  outcomes and never collapses "nothing ran" into "everything passed." Of the
  four: the no-tests-ran outcome is `live`, captured from a real run; the
  failed outcome is `live`, captured from a real run; the per-method pass
  verdict is `live`, observed inside that same failure capture; the
  run-level all-passed outcome is now `live` too — captured against
  `ZCL_I75_PROBE` on SAP A4H, 2026-09-12
  (`test/fixtures/live-captured/852-i75-ut-testrun-allpass.xml`), replacing
  the earlier test that only manufactured this outcome by stripping the
  alerts element out of the captured failure. The unknown outcome itself has
  two paths and they grade differently: the "a program came back with no
  test methods and no `noTestClasses` alert" path is now `live` too —
  captured against `ZCL_I75_PROBE` on SAP A4H, 2026-09-12, where a test
  class with no declared `RISK LEVEL` defaulted above the run's risk-level
  limit and every method was skipped
  (`test/fixtures/live-captured/857-i75-ut-testrun-risk-exceeded.xml`); the
  "test methods came back carrying XML the parser cannot grade" path
  (`unknown > 0`) has still never been observed live and remains built
  entirely from hand-written hypothetical documents.
- **ATC.** Ten live captures back this tool; nine are replayed in tests, not
  just narrated in docs, and the tenth records a no-op this client has no
  code path to exercise. The first pair (2026-08-01, one object) established the
  basics: the run POST is synchronous rather than polled; the worklist
  identifier, its timestamp and the info blocks are child elements rather
  than attributes; the used-object-set and completeness flags are attributes
  on the worklist element; an info block can repeat. Eight more captures
  (2026-09-12, issue #78) settled most of what that first pair left open: a
  single run request accepts several object references including package
  references, so a package or multi-object run works over the same
  synchronous API; a worklist read can be scoped to a numeric `LAST_RUN` id,
  and accumulates separate object sets across repeated runs rather than
  replacing them; `worklistTimestamp` is genuinely optional on the wire; a
  zero-findings run reads back as a clean 200, not an error; a different
  check variant produces a genuinely different result set (5 findings versus
  7 for the same object under two variants); check-variant discovery goes
  through a repository quickSearch, not a dedicated ATC endpoint (that one
  answers 400); and — the two most operationally important results — a
  `DELETE` on a worklist is genuinely attempted and answers 405 on this
  release, and the advertised `deleteFindings` action is a confirmed no-op
  (traced to a commented-out server-side handler, not just observed as a
  black box). Still unconfirmed: the attribute-shape `<info>` variant, a run
  that actually hits `max_findings`, server-side subpackage expansion (no
  customer package with subpackages exists on A4H to exercise it against), a
  true `quickfixes` flag (every one observed so far reads false), a
  successful worklist delete on a release that supports it, and behaviour on
  an object type or error path this issue's runs did not hit.
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
  cross-system, class-include, or irreversible refusals. A class delete now
  also captures its four local includes (definitions, implementations,
  macros, test classes) under the same lock as the delete, in the entry's
  `parts`, so undoing it restores those too — it no longer reports itself
  partial for that reason. It still reports `PARTIAL` and still needs
  `force:true`, but only for whichever of the four includes could not be
  read at delete time. This capture-and-restore path, and undoing a write
  that targeted a class sub-include directly, are now `live`, confirmed
  against SAP A4H, 2026-09-12, on class `ZCL_I75_UNDO` in package `$TMP`:
  `abap_write mode=delete` on the class produced a journal entry with all
  four parts (`definitions`, `implementations`, `macros`, `testclasses`),
  every one `beforeCapture: captured`; `abap_journal mode=show` reported
  the class warning naming all four; `abap_journal mode=undo` reported
  `action: recreate`, `performed: true`,
  `restoredIncludes: definitions, implementations, macros, testclasses`,
  and `activated: true`; and a following `abap_test` on the recreated
  class ran the restored test class and reported PASSED — proof the
  `testclasses` include really came back active, which could not happen if
  only `main` had been restored. Separately, a second version of the
  `testclasses` include was written directly (`abap_write include:
  "testclasses"`); `abap_journal mode=show` on that entry reported
  `include: testclasses` and the include-scoped warning; `abap_journal
  mode=undo` reported `action: restore` / `activated: true`; and
  `abap_read { include: "testclasses" }` read back exactly the
  before-image bytes, its etag equal to the entry's `beforeEtag`
  (`sha256:be7abc10f006180d9ffb48eafff05612`). Undo's other paths —
  restoring an ordinary `main`-source update, and deleting a `create` —
  have no committed live capture yet; their only live contact remains an
  opt-in integration test that is skipped unless a live system is
  configured, which is why the row above is graded `mixed` rather than
  `live`.
- **UI automation.** Discovery is read-only in effect but still writes — it
  dispatches against the reused fluid body class `ZCL_ZMCP_FLUID_UI` plus a
  content-addressed invoker. A press runs a transaction with scripted batch
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
- **Package navigation.** `readPackage` (`src/adt/ddic.ts`) used to be
  UNSUPPORTED; it now reads the ADT repository nodestructure endpoint
  (`POST /sap/bc/adt/repository/nodestructure?parent_type=DEVC%2FK&parent_name=<NAME>`)
  plus the package's own header (`GET /sap/bc/adt/packages/<lowercase-name>`).
  Folder nodes the wire sends for every DEVC sub-kind (`DEVC/P`, `DEVC/I`,
  `DEVC/N`, `DEVC/XS`, `DEVC/KI`, `DEVC/OC`, `DEVC/VT`) come back with an
  empty `OBJECT_NAME`/`OBJECT_URI` and are dropped; a real sub-package is a
  `DEVC/K` row with a name, matched exactly rather than by a `DEVC` prefix
  match, so a future folder-kind addition cannot be misread as a
  sub-package. `withShortDescriptions=true` still leaves a sub-package's own
  `DESCRIPTION` empty on the wire — reported as-is, not filled in. Deleting
  a package still only works while it is empty (graded on the object-types
  table's own `DEVC/K` row, not here). Evidence is `mixed`: the underlying
  nodestructure and package-header wire behavior is live-verified against
  A4H, 2026-09-12 (`test/fixtures/live-captured/INDEX.md`, captures
  852-857, 876-883 — including the zero-byte-body-on-empty-package shape,
  captures 854 and 877-881), but the `abap_read` route itself — dispatch,
  `types`/`depth` filtering, the 25-expansion cap, paging — has only been
  exercised through cassette-replay tests on this branch, not end to end
  against a live system.
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
  non-transportable `$ABAPSMITH_FLUID_API` package, never `$TMP`, created on
  first use with no silent fallback if that fails.
- **Search.** Every request goes out untyped and is filtered client side,
  because the server's own type filter drops fields and half-ignores the
  subtype; the fetch window is deliberately wider than the display cap and
  the difference is disclosed. A known server-side description mispairing is
  repaired for two object groups, confirmed on the wire, and flagged but not
  repaired for others.
- **Source search.** `mode=source` has no ADT endpoint behind it — it
  deploys and runs the built-in `scan` fluid tool (entry class
  `ZCL_ZMCP_FLUID_SCAN`), which reads TADIR for the object scope, resolves
  includes per object type, and matches lines with `FIND ... PCRE`. Kept as
  a separate fluid tool (not a fourth `core` action) because that PCRE
  dependency needs a 7.55-or-later kernel; an older system then loses only
  `scan`, not `core`'s other actions. `FIND ... PCRE` on ABAP compiles with
  the extended (`x`) flag on by default, which strips spaces and treats `#`
  as a comment marker, so the tool prefixes every `regex: true` pattern
  with `(?-x)`; a caller pattern that itself starts with `(?x)` turns
  extended mode back on. A scope (`packages` and/or an `objects` pattern
  narrower than `*`) is mandatory and a 200-object ceiling applies, both
  disclosed rather than silent.

  The `live` sub-path: on A4H (client 001, user DEVELOPER, 2026-09-12), the
  complete `ZCL_ZMCP_FLUID_SCAN` body was deployed to `$TMP` under an
  issue-scoped name, activated after a clean syntax check, and run through
  `ZCL_ZMCP_FLUID_RT`, returning real wire frames, covering: literal search
  over CLAS includes with include-local line numbers; regex search,
  including a pattern containing a space; FUGR include resolution (11
  includes resolved for one group, none skipped, bare include names such as
  `LBRF_FLIGHT_UTILSU01` reported); DDLS/CDS sources read from DDDDLSRC;
  package scope with `include_subpackages` expanding over TDEVC-PARENTCL;
  the hit cap and object ceiling, each reported as `truncated: "hits"` /
  `truncated: "objects"` with an honest `objects_total` (33) against
  `objects_scanned` (3); and the comment heuristic, where `MESSAGE-ID` with
  `include_comments: false` returned 0 hits and with `include_comments:
  true` returned the one trailing-comment line.

  The `tests`-only sub-path: the end-to-end `abap_search mode=source` MCP
  call — dispatching through `dispatch()` to a deployed `scan` tool on a
  server running this build — is exercised only by unit tests against a
  fake fluid runtime, because the live MCP server runs the previously
  released bundle, not this worktree's code.
- **Runtime trace (SAT).** `op=start`, a scoped trace run over a `$TMP`
  class, a hit-list read, a database-access read, a call-tree read on a
  non-aggregated trace, listing runs, listing requests, and deleting both
  a run and a request were all exercised live against A4H (SAP_BASIS 754
  SP0007, client 001), 2026-09-15 — see
  [doc/TOOLS/abap-trace.md](../TOOLS/abap-trace.md) for the numbers
  (a four-statement class produced 1161 hit-list entries, about 790 KB,
  mostly framework code beneath it). The standalone SQL-trace collection
  at `/sap/bc/adt/runtime/traces/sqltraces` is `unverified`: it does not
  exist as a resource on the reference release (a GET answers "does not
  exist" and ADT discovery there does not advertise
  `traces.sqltraces`), so it is exercised only against fakes and never
  called by this tool. On that release, SQL access is read through the
  `sql_trace`-fed `db` view of the ABAP trace itself, which reports
  statement kind, table, counts and time, never full SQL statement text.
