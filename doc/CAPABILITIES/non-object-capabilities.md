## Non-object capabilities

| Entity | Create | Read | Update | Delete | Activate | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Debugger | n/a | yes | no | n/a | n/a | live | Breakpoints and watchpoints are set and cleared as part of a session, including while a debuggee is already suspended; variables can be read but never written, and the frame cursor moves the read position only. Session concurrency is client-configurable (`ABAP_DEBUG_SESSIONS`), but SAP still allows only one active debug listener per SAP user on a system. |
| Breakpoints | yes | yes | no | yes | n/a | live | Line, exception, statement and message kinds, mixable in one call; armed at `start` or added later while stopped (`action="breakpoints"` `op="add"`, additive — never touches a breakpoint this session did not create). `op="list"` is a client-side record of what this session armed, not a server read — `GET .../debugger/breakpoints` answers `200` with a zero-byte body regardless of what is actually armed. `op="remove"` is by id, restricted to ids this session created. `skipCount` is accepted by the server and not enforced, so expect a stop on every hit. |
| Watchpoints | yes | yes | no | yes | n/a | mixed | Variable-path watch with an optional ABAP-expression condition; add/list/remove while stopped (`action="watch"`). A create response echoes only the newly created watchpoint, never the session's full list. A hit surfaces inside a step response as `reachedWatchpoints`, carrying only the new value — the old value needs a follow-up `op="list"`. This tool never modifies a watchpoint (a modify retires the addressed id and issues a new one), so ids it holds stay valid for the session's whole lifetime. `live`: create/list/get/modify/delete, the 400 on a missing variable name, the 404 on an unknown id, and a hit reported on `stepContinue`. `unverified`: a condition actually gating a stop (accepted and stored, but never isolated as the cause of a hit) and `reachedWatchpoints` on an *attach* response (every captured attach stopped on a line breakpoint instead). |
| ABAP Unit | yes | yes | yes | n/a | yes | mixed | Runs existing tests: PASSED/FAILED/NO TESTS RAN/UNKNOWN, never collapsing "nothing ran" into a pass — see the outcome breakdown below. Test classes are created and updated through `abap_write` (`include="testclasses"`), not through `abap_test` itself; verified live end to end — write, activate, run, read-back — against SAP A4H, 2026-09-12. A single class include cannot be deleted on its own (ADT has no such verb), only emptied by writing new content over it. There is no activate verb for the include itself: `abap_activate` on the owning class activates `testclasses` along with it, confirmed live, SAP A4H, 2026-09-12. Also selects and runs the test carriers a changed set puts at risk (`scope: "impacted"`) via where-used, instead of one named object — graded `mixed` because of this: see the impacted-scope breakdown below. |
| ABAP Unit coverage | n/a | yes | n/a | n/a | n/a | mixed | Opt-in (`coverage: true` on `abap_test`), scoped with `coverage_for`. The wire protocol — coverage negotiation on the run, the covered-objects roster, the coverage query, an untouched object's zero-summary response with no per-node breakdown — is `live` (SAP A4H, 2026-09-12; `test/fixtures/live-captured/852`–`856-i75-*`). abapsmith's own report rendering is now `live` too, end to end: `abap_test { object: "ZCL_I75_UNDO", type: "CLAS/OC", coverage: true }` against SAP A4H, 2026-09-12, returned outcome PASSED, tests 1, passed 1, the header `coverage: statement 2/2 (100%), branch 1/1 (100%), procedure 1/1 (100%)` line, a `COVERAGE` section with a class row and a per-method row for `DOUBLE`, and an `ALSO TOUCHED` list of 15 framework objects plus a `… and 19 more (truncated)` line — so the focus set, the header ratio line, the per-class/per-method table, and `ALSO TOUCHED` with its cap are confirmed as rendered MCP tool output, not just wire protocol. Still `tests`-only, exercised only against the live-captured fixtures, not yet observed live as rendered output: the `UNCOVERED METHODS` section, the `not measured by this run` / `not touched by this run` / `not queried` wordings, and `coverage_for` naming an object other than the one under test. See [execute-and-test.md](../TOOLS/execute-and-test.md). |
| ATC | partial | yes | no | partial | n/a | mixed | A run creates a server-side worklist as a side effect; there is no variant create, and exemption management is deliberately absent. Worklist delete IS attempted (both directly and via `auto_cleanup`) but this release's server refuses every attempt with HTTP 405, so the worklist persists — a caching strategy limits the litter. |
| Quick fixes | no | yes | yes | no | yes | mixed | Position-driven only, not finding-driven — the ATC route was tried and rejected. Deterministic proposals only; a parameterized one is refused `BAD_INPUT`. Listing is gated as a write because it posts the whole object source. |
| Runtime dumps | n/a | yes | n/a | no | n/a | live | Read-only feed with a residence window that cannot be widened. The variables chapter is absent from the schema unless an operator enables it. |
| Runtime trace (SAT) | yes | yes | n/a | yes | n/a | mixed | Scoped to one connected user and one object; `op=run` creates a trace request, executes the object, waits for and reads the trace, then deletes the request, while `op=start` leaves that cleanup to the caller — a fully consumed request is not cleaned up by the server on its own. `view="tree"` is refused up front against an aggregated trace rather than sent to fail server-side. Read views are `hitlist`, `db` (statement kind, table, counts and time — not full SQL text), and `tree`. The standalone SQL-trace collection (`/sap/bc/adt/runtime/traces/sqltraces`) does not exist as a resource on the reference release and is `unverified`; SQL access on that release is read only through the `db` view of the same trace. Refused outright on a cloud tenant, where ADT discovery does not offer `traces.abaptraces`. |
| Object activation | n/a | n/a | n/a | n/a | yes | live | Check-only and activate modes, single and batched. There is no deactivate in ADT, which is why activation can never be undone. |
| Pretty printer | n/a | yes | yes | n/a | yes | mixed | `abap_activate mode="format"`. Text form (`source`, no `object`) is a stateless reformat — no lock, no write, no journal entry, gated as read, works even in read-only mode. Object form (`object`, no `source`) reads the saved source, reformats it, and writes it back with `activate: true` through the ordinary journalled write path only if the bytes actually changed; an unchanged reformat reports `changed: false` and takes no lock, no PUT and no activation. Reads the server's own pretty-printer setting and never changes it — `setPrettyPrinterSetting` is never called. See the note below. |
| Element info / definition lookup | n/a | yes | n/a | n/a | n/a | mixed | `abap_read view="definition"`. Given a 1-based line and 0-based column, answers what/where for the identifier there: kind, name, visibility, level, ABAP type, declaring location (with a copy-pasteable `abap_read` call), signature or components, short text and ABAP Doc; for an interface method, the implementing classes via where-used, from either a use site or the interface's own declaration. Gated as read even though every endpoint is a POST, because none of it returns anything `abap_write` could act on. See the note below. |
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
| Call graph (`abap_search mode=call_graph`) | n/a | yes | n/a | n/a | n/a | mixed | Walks callers (via `usageReferences`, same wire path and cost profile as `mode=where_used`) or callees (a static source-text parse, `src/adt/call-sites.ts`) to `depth` levels, default 2, max 4 — a `depth` above the max is refused (`BAD_INPUT`), never silently clamped. The parser/renderer chain (`parseCallSites`, callee grouping, callers-tree assembly) is `tests`: exercised offline against captures 974/975 (real `ZCL_I105_A`/`ZCL_I105_B` source) and 971-973 (real `usageReferences` wire bytes for a caller cycle and a leaf). The assembled `abap_search mode=call_graph` MCP call itself is `unverified` end to end — the reference MCP server runs a previously released bundle that predates this feature, so there is no live round trip through the actual tool dispatch, and none is anticipated until a new bundle ships. See [doc/LIMITATIONS/search.md](../LIMITATIONS/search.md) for cost and blind-spot detail (dynamic dispatch is never resolvable from source text). |
| Database write footprint (`abap_read view=footprint`) | n/a | yes | n/a | n/a | n/a | mixed | `PROG/P`, `CLAS/OC`, `FUGR/F`, `FUGR/FF` only — scans every include by source-text pattern matching for Open SQL writes, update/background-task RFC calls, commit/rollback, BOPF modify, `EXEC SQL`/ADBC, `EXPORT…TO DATABASE`, `CALL TRANSACTION`, `SUBMIT`. The scanner/renderer chain (`scanFootprint`, `renderFootprint`) is `tests`: exercised offline against capture 983, a real report source built to exercise every recognised form. BOPF modify and `EXEC SQL`/ADBC detection have **no live ground truth at all** — capture 983 contains none of the three, so those patterns are written from documented API shapes, not from an observed occurrence; this is disclosed in the tool's own rendered notes for BOPF and in [doc/LIMITATIONS/footprint.md](../LIMITATIONS/footprint.md) for all three. The assembled `abap_read view=footprint` MCP call itself is `unverified` end to end, same reasoning as the call-graph row above — the reference server predates this feature and no live run is anticipated until it ships. |
| Application log (BAL) reads | n/a | yes | n/a | n/a | n/a | mixed | `abap_fluid {"tool":"log","action":"read"}`. Header search plus, on request, message detail, via `BAL_GLB_MEMORY_REFRESH`/`BAL_DB_SEARCH`/`BAL_DB_LOAD`/`BAL_LOG_MSG_READ` — not the nonexistent `BAL_LOG_READ` the requesting issue named. `detail="messages"` can itself write to the database (`BAL_DB_LOAD` converts an old-format log in place via `BAL_DB_SAVE_OLD_VERSIONS`), so it is not provably side-effect-free even though this is a "read" action; message text is application data and may carry business data, so it is disclosed as such, never assumed safe to log. See the note below. |
| SAP documentation reads | n/a | yes | n/a | n/a | n/a | mixed | `abap_read view="docu"` (or, with `method=`, a method's own ABAP Doc). Reads `DOKHL`/`DOKIL`/`DOKTL` through the built-in `core` fluid tool's `docu` action — there is no ADT REST endpoint for this store. Flattened to plain text (`CONVERT_ITF_TO_ASCII`), not the verbatim ITF source. Deliberately excluded from `core`'s data-preview policy: it reads SAP's own documentation text, not application table data. See the note below. |
| Object digest (one-page overview) | n/a | partial | n/a | n/a | n/a | mixed | `abap_read view="digest"`, for `CLAS/OC`, `INTF/OI`, `PROG/P`, `FUGR/F`, `FUGR/FF`, `DDLS/DF` only. Six fixed sections built from existing read/outline/history calls, capped at 25 rows per section. `partial`: PUBLIC API renders a real function-module signature for `FUGR/FF` and, when the select list is parseable with confidence, a CDS field list for `DDLS/DF`; only `FUGR/F` (the group itself) still renders an empty PUBLIC API, since listing a group's modules needs a search call this view deliberately does not make. Where-used is deliberately never fetched (unbounded ADT endpoint); the digest names the `abap_search mode="where_used"` call instead of running it. See the note below. |

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
- **Impacted scope (`scope: "impacted"` on `abap_test`).** Selecting a
  changed object as its own carrier (`changed directly`) and the two
  distinct empty outcomes — `NO CHANGED OBJECTS` (nothing to select
  against) and `NO IMPACTED TESTS FOUND` (consumers examined, none carries
  a test class) — are `live` (SAP A4H, client 001, user DEVELOPER,
  2026-09-15), on `ZCL_I111_USER` (has a `testclasses` include with
  `ltcl_user`) and `ZCL_I111_LIB` (no test class), both in `$TMP`:
  `changed: ["ZCL_I111_USER"]` selected and ran that class for real
  (`outcome: PASSED`, `tests: 1`, `passed: 1`); `changed: ["ZCL_I111_LIB"]`
  returned `NO IMPACTED TESTS FOUND (not a pass)`; both names given together
  deduplicated to the single carrier; and the `caps: per-object 20,
  carriers 10` header disclosure appeared on both outcomes.
  `NO CHANGED OBJECTS` is backed by its own live evidence, not inferred
  from the other outcome: `changed: []` returned `NO CHANGED OBJECTS (not
  a pass)` with body `No changed objects were given — nothing was run.`,
  and, separately, `since: "<an ISO timestamp>"` against an empty journal
  returned the same outcome with body `The journal held no writes for
  this system since <timestamp> — nothing was run.` — so the
  journal-derived changed-set path (the `since` filter, the system
  filter, and its distinct provenance note) is confirmed live as reaching
  the journal and reporting its provenance. Not yet observed live: that
  same journal path actually selecting a non-empty changed set — every
  live `since` run so far has hit an empty journal. The where-used
  consumer half of the feature is `tests`-only: this appliance's where-used
  index has never been built — report `SAPRSEUB` has never run, so
  `WBCROSSGT`/`CROSS` are empty and the ADT `usageReferences` endpoint
  answers zero rows for every object tried, including SAP-standard ones
  (`CL_ABAP_UNIT_ASSERT`) — so `consumersExamined` was 0 in every live run
  above. Finding consumers, the per-object consumer cap (20), the total
  carrier cap (10), and the `--- TRUNCATED ---` naming of unexamined
  consumers therefore have unit-test coverage over fakes only; on a system
  with a built where-used index the consumer half behaves as those tests
  specify, but that has not been observed live. Also refused, as a
  deliberate limitation rather than an oversight: `auth_trace: true`
  combined with `scope: "impacted"` — client-side `BAD_INPUT`, verified
  live, message `auth_trace is not supported for scope="impacted": it
  would switch the trace on and off once per carrier and would be
  silently ignored otherwise.` See
  [execute-and-test.md](../TOOLS/execute-and-test.md#impacted-scope-scope-changed-since).
- **Authorization trace (`auth_trace` on `abap_run`/`abap_test`/
  `abap_bopf_test`).** The whole feature is now verified live end to end,
  through the real `abap_run` and `abap_test` tool code paths (SAP A4H,
  client 001, user DEVELOPER, 2026-09-15): `abap_run { object:
  "ZCL_I111_USER", auth_trace: true }` returned a normal successful run
  with header `auth_trace: no failed checks`; `abap_test` on the same
  object with `auth_trace: true` returned `outcome: PASSED`, `tests: 1`,
  `passed: 1` and `auth_trace: no failed checks`, confirming the trace
  doesn't disturb the run's own verdict; a deliberately failing check, from
  a `$TMP` probe class (`ZCL_I112_FAILCHK`) doing an `AUTHORITY-CHECK`
  against an authorization object that does not exist, produced a real
  `FAILED AUTH CHECKS` section with the object/field=value/rc/program/line
  line format and the `[SU53 fallback]` provenance tag, all confirmed as
  rendered tool output (the reported object name came back truncated to
  `Z_I112_NOP`, a CHAR10 SU53-buffer artifact of the source data, not a
  bug); and the switch-off was confirmed by a follow-up status read
  returning `active: false`. Not verified live: `SUAUTH_READ_TRACE_VALUES`,
  the kernel-trace read itself — it returned zero rows on this appliance
  even with the trace active and a check failing inside the window, so
  every failed check actually observed, including the one above, came from
  the SU53 fallback; no `[trace]`-tagged line has ever been seen. The
  kernel-trace read path has unit-test coverage over fakes only. It reads
  the trace and changes no authorization, role or profile. Also refused,
  deliberately: `auth_trace: true` together with `scope: "impacted"` on
  `abap_test` — `BAD_INPUT`, verified live. See
  [execute-and-test.md](../TOOLS/execute-and-test.md#authorization-trace-auth_trace).
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
  conflict, and both breakpoint accept and reject. Statement and message
  breakpoint kinds, watchpoint create/list/get/modify/delete, arming or
  removing a breakpoint while a debuggee is already suspended, and a
  watchpoint hit reported as `reachedWatchpoints` on a `stepContinue`
  response are all live-verified against A4H (2026-09-12). Two exceptions
  among steps: the run-to-line and jump-to-line step kinds have no live
  capture, and jump-to-line is disabled by default behind both an
  environment flag and a per-call confirmation echo. Also unverified: a
  *conditional* watchpoint actually gating a stop (the condition is accepted
  and stored, but a hit was never isolated as caused by it, as opposed to an
  unconditional watchpoint on the same variable hitting first);
  `reachedWatchpoints` on an *attach* response (every captured attach
  stopped on a line breakpoint instead, so this shape is inferred from the
  parser's tolerance, not observed); and two concurrent debug sessions
  actually working — SAP refuses a second listener for the same SAP user
  with `409`/`conflictDetected` even when the refused request carries a
  different `terminalId` (`test/cassettes/debugger/listener-conflict-409.cassette.json`),
  so `ABAP_DEBUG_SESSIONS` above 1 only raises this client's own cap, never
  SAP's per-user exclusivity. The debugger is read-only with respect to
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
- **Pretty printer.** `POST /sap/bc/adt/abapsource/prettyprinter` is the only
  endpoint involved — `live` (A4H, 2026-09-12): the request/response shape,
  keyword-case and layout rewriting, CRLF-to-LF normalisation before the
  changed-bytes comparison, and the idempotent (`changed: false`) case
  (fixtures 963, 964). The system's own pretty-printer setting was read once
  and observed as `indentation=true style=keywordUpper keepIdentifier=true`
  (fixture 962) — that is one system's configuration, not a guarantee about
  any other. `unverified` live: the object form's full write-back path
  (lock, PUT, activate, journal entry) and the entire refusal matrix
  (`object`+`source` together, neither, `affects`, batch `objects`, `corr_nr`
  on the text form, a nonexistent object, a properties-shape DDIC type with
  no ABAP source) — all covered only by `test/activate-format.test.ts`
  against a fake ADT server, never exercised against a live one.
- **Element info / definition lookup.** Three ADT endpoints, each grounded
  in real A4H captures (2026-09-12, `test/fixtures/live-captured/` 952-958,
  960, 961): `codecompletion/elementinfo` for the identifier at a position,
  `navigation/target?filter=definition` for where it is declared, and
  `usageReferences` for an interface method's implementers. Two ADT quirks
  are `live`-observed, not inferred: a function module (`FUGR/FF`) resolves
  to name and type only — no visibility, signature or documentation —
  confirmed against `RFC_PING` (fixture 957), so an empty signature there
  is that limitation, not "no parameters"; and a position with nothing
  resolvable answers HTTP 200 in one of two wire shapes: fixture 960's
  well-formed document naming no element, or — live-observed A4H,
  2026-09-15 — a zero-byte 200 body at a genuinely blank line, which used
  to surface as `ADT_ERROR` and is now reported exactly like fixture 960's;
  there is no fixture file for the zero-byte case since there are no bytes
  to pin, the same reason capture 898 is already omitted. Either way it is
  reported as a fact about the position, not an error. The implementer list
  is where-used-based, so dynamic dispatch is invisible to it, and it is
  capped for display (`IMPLEMENTATIONS_DISPLAY_MAX` in `src/tools/read.ts`)
  with truncation marked; fixture 961's two-implementer capture alone took
  close to ten seconds, which is why a slow-fetch note is attached above a
  disclosed threshold rather than assumed fast.

  `live` (A4H, 2026-09-15), a second tranche: the implementer list was
  previously always empty — `IMPLEMENTED BY` rendered "(no implementing
  classes found)" for a real two-implementer case — because the installed
  `abap-adt-api@8.4.1` parses the where-used answer through the hardcoded
  namespace path `usageReferences:referencedObject` (capital `R`), while
  A4H answers with the lowercase `usagereferences:` prefix, so the vendor
  parser returned nothing; abapsmith now issues the `usageReferences` POST
  itself and parses it prefix-agnostically, accepting either prefix, and
  the same fixture (961) now yields both implementers — a
  vendor-library defect worked around locally. A position that IS a
  variable's own declaration used to raise an uncaught error: ADT answers
  the navigation-target request with HTTP 400, exception type
  `NavigationFailure`, T100 key `ED`/`263`, message "Definition location
  found; where-used list may be possible" — captured against
  `CL_ABAP_TYPEDESCR`'s `data ABSOLUTE_NAME type ABAP_ABSTYPENAME read-only
  .` line. It is now reported the same way as the pre-existing "declaration
  site undecidable" case: no "declared at" line, worded as such, with the
  header fields, signature, doc and implementers still answered.
  `IMPLEMENTED BY` now also runs from the interface's own declaration line,
  not only from a use site whose navigation target resolves into the
  interface — at the declaration line ADT names no navigation target, so
  the section used to be skipped there. Separately, a callable element with
  no parameters now renders an explicit `SIGNATURE (none)` instead of
  omitting the section.

  `unverified` live: the full refusal matrix in `assertViewCompatible`
  (`view="definition"` combined with `format="raw"`, `enhancements=true`,
  `version="inactive"`, `outline=true`, `method=...`, or
  `from`/`to`/`context`; missing `line`; `line`/`column` against
  `view="history"`/`"diff"` or with no `view` at all; a non-source object;
  `line` past the end of the source) — covered only by
  `test/read-definition.test.ts` against a fake connection. Also unverified
  live: the rendering of the three paths fixed on 2026-09-15 — the
  declaration-itself wording, `SIGNATURE (none)`, and `IMPLEMENTED BY`
  reached from an interface's own declaration — has not been re-run end to
  end against a live server; those are covered only by
  `test/read-definition.test.ts` and `test/element-info-wire.test.ts`
  against fake connections.
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
- **Application log (BAL) reads.** BAL has no single "read everything"
  function module — the issue that requested this tool named
  `BAL_LOG_READ`, which does not exist under that name on a current system.
  `log.read` instead drives the documented search/load/read pipeline:
  `BAL_GLB_MEMORY_REFRESH` clears session BAL memory first (a log read
  earlier in the same session could otherwise come back with zero
  messages), `BAL_DB_SEARCH` finds headers matching the filter,
  `BAL_DB_LOAD` (`detail="messages"` only, `i_lock_handling = 0`, no
  enqueue — "a read action has no business taking a lock") loads a found
  log's messages, and `BAL_LOG_MSG_READ` renders each message's text. With
  neither an absolute nor a relative time window given, the window defaults
  to the last hour (`DEFAULT_LOG_WINDOW_SECONDS = 3600`) rather than
  scanning a table that can span years. `abap_run`, `abap_test`,
  `abap_bopf_test` and `abap_ui mode="press"` each append a note (not a
  hint — a hint would only render inside a truncated/windowed response,
  and this line must reach the caller every time) pointing back at the
  `log.read` call most likely to explain what the executed code did —
  `abap_run`/`abap_bopf_test`/`abap_ui` round their own measured duration
  up (plus 5s slack); `abap_test` measures no duration of its own, so its
  note names the fluid tool's one-hour default instead and says so
  plainly. Every call writes one stderr audit line naming only what was
  looked at and how much came back — object, subobject, log count, message
  count — mirroring `abap_data_preview`'s own audit line shape, never
  message text. `detail="messages"` returns message text and its
  `msgv1`..`msgv4` variables verbatim: application data written by the
  logging program, not abapsmith's own output, and disclosed as possibly
  carrying business data. `live` (A4H, probe class `ZCL_I108_PROBE`,
  2026-09-15): every IMPORTING/EXPORTING/TABLES/EXCEPTIONS parameter these
  four function modules rely on — `BAL_DB_SEARCH` returned 5 headers for a
  90-day window, `BAL_DB_LOAD` with `i_lock_handling = 0` against one of
  those headers returned 440 message handles, `BAL_LOG_MSG_READ` given one
  of those handles returned `e_s_msg` plus the rendered `e_txt_msg`.
  Beyond that FM-level probe, the `log` fluid tool's own generated ABAP body
  was itself run live on A4H (client 001, user DEVELOPER, 2026-09-15):
  deployed to `$TMP` as `ZCL_I108_FLUID_LOG`, activated with zero syntax
  errors, and driven through `IF_OO_ADT_CLASSRUN` against the real
  `ZCL_ZMCP_FLUID_RT` — a `detail="headers"` call honoured both
  `last_seconds` and `max`, returning five log rows and a summary row with
  no `ERR` frame. A later pass on the same day closed the remaining gaps:
  `detail="messages"` and the end-to-end `abap_fluid
  {"tool":"log","action":"read"}` MCP call path itself — dispatching
  through `dispatch()` and rendering the result through
  `renderLogRead`/`auditLogRead` — were both run live on A4H through an MCP
  server started from this worktree's `dist/` (this branch's build, not
  the released bundle); see [diagnostics.md](../TOOLS/diagnostics.md) for
  the verbatim output. The correlation line itself was also confirmed live
  that day: `abap_run` on a `$TMP` class renders `NOTE: Application log
  (BAL) entries this execution may have written: ... "last_seconds":6 ...`
  on a normal, non-truncated response, and `abap_test` renders its own
  one-hour-default variant the same way.
- **SAP documentation reads.** There is no ADT REST endpoint for `DOKHL`/
  `DOKIL`/`DOKTL`, so `view="docu"` (without `method=`) is read through the
  built-in `core` fluid tool's `docu` action, deploying/calling a generated
  ABAP class the same way `abap_search mode="source"` deploys its own
  fluid tool — needing the fluid API and a write-capable pool slot even
  though the caller is only asking to read. `method=` against a `CLAS`
  object is the one exception: it reads a method's ABAP Doc straight from
  source (the contiguous `"!`-prefixed comment block above its
  `METHODS`/`CLASS-METHODS` declaration) and never touches the fluid path
  or the class's own DOKHL text — a method's own doc and its class's doc
  answer different questions. `core.docu` is deliberately excluded from
  `guardCoreAction`'s data-preview policy (`src/adt/fluid/builtin/core.ts`):
  neither `assertDataPreview` nor `ABAP_ALLOW_DATA_PREVIEW` applies, since
  it reads SAP's own documentation text out of `DOKTL`, not application
  table data. The object type/kind is mapped to a `(id, object)` DOKHL key
  (data element, domain, table, class, interface, function module/group,
  program, message class); a message reference is parsed into DOKHL's
  merged `<id><number>` form (`"ZSD 042"`, `"ZSD042"` and `"ZSD 42"` all
  resolve the same way); there is no `language` input — the ABAP side tries
  the logon language, then EN, on its own, and reports which language and
  whether it fell back. An IMG activity is addressed the same way: since it
  has no ADT object type of its own to resolve through the ordinary path,
  `type: "SIMG"` bypasses object resolution and builds the documentation
  target by hand via `imgDocuTarget` (`src/adt/docu.ts`, mapping to `id:
  "HY", object: "SIMG" + <activity>`, verified live against
  `TDCLD`/`DOCU_GET_LANGU_FOR_DISPLAY`) — `abap_read
  {"type":"SIMG","object":"<activity id>","view":"docu"}`; `type: "SIMG"`
  with any other view is refused. The text returned is SAP ITF
  documentation flattened to plain lines
  by `CONVERT_ITF_TO_ASCII`, not the verbatim ITF source. `live` (A4H,
  probe class `ZCL_I109_PROBE`, 2026-09-15): every `DOCU_GET`/
  `CONVERT_ITF_TO_ASCII` parameter relied on, including the CHAR2/CHAR40
  truncation handling on `DOKHL-ID`/`DOKHL-OBJECT`, `DOCU_GET`'s
  `sy-subrc = 4` no-fallback-of-its-own behaviour, `typ = 'E'` accepted
  even when `DOKIL` lists the object as type `T`, and a 6-line ITF
  `BAL_DB_SEARCH` documentation expanding to 36 ASCII lines. Beyond that
  FM-level probe, `core.docu`'s own generated ABAP body was itself run
  live on A4H (client 001, user DEVELOPER, 2026-09-15): deployed to `$TMP`
  as `ZCL_I109_FLUID_CORE` and activated with zero syntax errors after
  fixing one runtime defect (`lv_title` needed `DOKTITLE`'s DDIC type, not
  `string`, for the dynamic `DOCU_GET` call). Four live calls through
  `IF_OO_ADT_CLASSRUN` against `ZCL_ZMCP_FLUID_RT` all returned clean, no
  `ERR` frame, including the live confirmation of the `HY`/`SIMG`+name
  IMG-activity naming rule (39 lines for `SIMGCRM_PRI_GRUKONKONTR`) and a
  clean not-found result for a nonexistent object. `unverified` live: the
  end-to-end `abap_fluid`/`abap_read view="docu"` MCP call path itself —
  through the released server, not this branch — has not been exercised;
  it is covered only by unit tests against fakes.
- **Object digest.** All section-building logic (`scanDependencies`,
  `scanProgramInterface`, `countTestClasses`, `summarisePublicApi`,
  `buildDigestSections` in `src/adt/digest.ts`) is pure and I/O-free;
  `readDigest` (`src/tools/read.ts`) only fetches the ADT facts those
  functions need — version history, source, and (CLAS/INTF only) the
  outline — through the same machinery an ordinary read already uses, so
  it stays on `pool.withRead` under `ABAP_MODE=read`, unlike `view="docu"`.
  Where-used is deliberately never fetched: `abap_search mode="where_used"`
  walks ADT's unbounded `usageReferences` endpoint (no limit, no paging,
  20+ seconds on a wide fan-in), so the digest names that call in a note
  instead of running it. The issue that requested this feature also named
  `abap_read view="footprint"` and `abap_search mode="call_graph"`; neither
  exists in this codebase and neither is ever named in a digest's output.
  PUBLIC API renders a real signature for `FUGR/FF`: parsed first from the
  NATIVE `FUNCTION <name> IMPORTING ... .` signature statement — a live
  system (A4H) was found to serve every function module this way,
  keywords upper- or lowercase — with the older ADT-generated
  `*"*"Local Interface:` comment block parsed as a fallback for sources
  that carry only that form. Either way it yields parameter name, section
  keyword, typing, and an `(optional)` marker. A function module whose
  native `FUNCTION` statement was found and walked but genuinely declares
  no parameters at all (e.g. `RFC_PING`) also renders an empty section, but
  with its own note stating this is the module's real, parameterless
  signature, not a failed scan; the section renders empty with a note
  naming both forms tried only when neither shape is present at all. It
  also renders PUBLIC API, when the select list can be parsed with confidence,
  for `DDLS/DF` (the projected field list) — falling back to an empty
  section with an explicit note when it can't (a cast, function call,
  sub-select, or bare association in the select list makes it give up on
  the whole view rather than return a partial list).
  Only `FUGR/F` (the function group itself) still always renders an empty
  PUBLIC API, with an explicit note: listing a group's modules needs a
  search call this view deliberately does not make.
  `tests`-only: the section-building logic is covered by unit tests against
  constructed fixtures, not live captures. `mixed` overall because the
  individual ADT calls `readDigest` composes (`listRevisions`, `readSource`,
  `classMembers`) are each independently live-verified elsewhere in this
  document (see the Object read and Element info rows); what has not been
  exercised live is the digest assembly and rendering itself, or the
  end-to-end `abap_read view="digest"` call path.
