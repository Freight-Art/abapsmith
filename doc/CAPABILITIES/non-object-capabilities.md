## Non-object capabilities

| Entity | Create | Read | Update | Delete | Activate | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Debugger | n/a | yes | no | n/a | n/a | live | Breakpoints are set and cleared as part of a session; variables can be read but never written, and the frame cursor moves the read position only. |
| Breakpoints | yes | yes | no | yes | n/a | live | Armed only as part of starting a session, deleted only when it ends, and only ones this session created. No standalone list or remove. `skipCount` is accepted by the server and not enforced, so expect a stop on every hit. |
| ABAP Unit | n/a | yes | n/a | n/a | n/a | mixed | Runs existing tests; cannot write or delete them, and never requests coverage. See the outcome breakdown below. |
| ATC | partial | yes | no | no | n/a | mixed | A run creates a server-side worklist as a side effect; there is no worklist delete, no variant create, and exemption management is deliberately absent. |
| Runtime dumps | n/a | yes | n/a | no | n/a | live | Read-only feed with a residence window that cannot be widened. The variables chapter is absent from the schema unless an operator enables it. |
| Object activation | n/a | n/a | n/a | n/a | yes | live | Check-only and activate modes, single and batched. There is no deactivate in ADT, which is why activation can never be undone. |
| Transport requests | yes | yes | partial | yes | n/a | live | Create, add a user, and set an owner. Delete is admin-gated and requires echoing the request identifier. Objects cannot be added or removed directly, and a locked entry cannot be unlocked. |
| Transport release | n/a | yes | n/a | n/a | yes | live | Dry run by default, armed only by echoing the request identifier, and gated separately from ordinary write access. Reports four distinct outcomes and never overstates one. |
| Write journal | yes | yes | no | no | n/a | tests | Entries are written by the tools themselves; the journal is read-only to the user and has no delete. |
| Undo | n/a | n/a | yes | yes | n/a | tests | Reverts one journal entry. Refuses activation, transport release, enhancement, and every irreversible entry, with no override. |
| Object search | n/a | yes | n/a | n/a | n/a | live | Name-pattern and where-used only. There is no source-text search. |
| Where-used | n/a | yes | n/a | n/a | n/a | live | Static only; dynamic calls do not appear. The server ignores every limit parameter, so the whole result set is always fetched and `max` bounds only the display. |
| Data preview | n/a | partial | no | n/a | n/a | mixed | One DDIC table or view per call, off by default, denylisted for sensitive tables, refused on any system that reports itself productive. No free-form SQL surface exists. |
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
- **Search.** Every request goes out untyped and is filtered client side,
  because the server's own type filter drops fields and half-ignores the
  subtype; the fetch window is deliberately wider than the display cap and
  the difference is disclosed. A known server-side description mispairing is
  repaired for two object groups, confirmed on the wire, and flagged but not
  repaired for others.
