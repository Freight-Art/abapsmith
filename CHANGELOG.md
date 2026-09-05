# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/). It is
pre-1.0, so the usual semver caveat applies: minor versions may still contain
breaking changes to configuration or tool schemas. No version has been
tagged or published yet; everything below has landed since `package.json`
was last set to `0.3.0`.

## [Unreleased]

### Added

- Release procedure in CONTRIBUTING.md (version bump in both manifests, CHANGELOG section, bundle rebuild, `vX.Y.Z` tag, GitHub release) and a README note on pinning the marketplace to a release tag for rollbacks.
- Core MCP server over ADT (`/sap/bc/adt/*`): connect, read source and DDIC
  (rendered as pseudo-DDL), fuzzy object resolution, and repository search.
- Write path: create, change, delete, activate, and run ABAP objects and
  classes, with `abap_test` for ABAP Unit. Writes are opt-in and restricted
  to `$TMP` by default.
- `ABAP_MODE` — a single-variable permission ladder (`read` / `edit` /
  `admin`) that supersedes the earlier per-capability `ABAP_ALLOW_*` flags,
  which remain as legacy inputs the server now warns about and ignores.
- `ABAP_VERIFY_WRITES` — two write-verification modes: `speculative` (the
  new default) treats a write that created and activated without error as
  sufficient, with no read-back on success; `verified` reads the object
  back after a successful write, reported as a `verify:` line. A per-call
  `verify: true` on `abap_write` raises one call to `verified`, raise-only
  — it cannot lower a server-configured `verified`. Failure-path
  verification is unaffected and runs in both modes, as does the
  always-on verification of classrun-bridge creates (`VIEW/DV`, `TRAN/T`)
  and the post-delete confirmation.
- Local write journal with `abap_journal` (`list` / `show` / `undo`),
  before-images, retention limits, and drift detection for undo targets that
  changed underneath the server.
- Live ADT step debugger (`abap_debug`, `abap_debug_vars`,
  `abap_debug_value`): attach, step, inspect the call stack and variables,
  with a context-budgeted variable renderer and `ABAP_ALLOW_DEBUG_JUMP_TO_LINE`
  gating forced jumps separately from ordinary stepping.
- CTS transport support (`abap_transport`, `abap_transport_release`): list,
  show, check, manage users, create, and release, with dry-run-by-default
  deletes and release.
- Session pooling and concurrency controls: bounded pool, read/write lanes,
  a reserved debug lease, and cross-process advisory locking so concurrent
  writes to the same object serialize instead of racing.
- BOPF CRUD (`abap_bopf`, `abap_bopf_edit`, `abap_bopf_delete`,
  `abap_bopf_test`): business objects, nodes, associations, and
  determinations, including dangling-reference checks and cascading DDIC
  delete.
- Enhancement framework support (`abap_enh`): BAdI definitions and
  implementations, enhancement spots, filter values, and ENHO/XHH
  source-code plug-ins, gated by customer- vs. SAP-owned target rules.
- `abap_dumps` — read ST22 runtime errors, with a two-tier gate
  (`ABAP_ALLOW_DUMP_VARIABLES`) before variable contents are disclosed, and
  correlation with `abap_run` failures.
- `abap_data_preview` — read table rows behind `ABAP_ALLOW_DATA_PREVIEW`, a
  built-in deny-list (credentials/security tables, payroll/HR, accounting
  documents, personal data), and a row ceiling.
- `abap_ui` — a headless classic-dynpro driver: screen reconnaissance
  (fields, flow logic, GUI status) and batch-input transaction driving
  behind `ABAP_ALLOW_UI_PRESS`.
- `abap_fpm_read` — read FPM/FBI screen configurations, content with no
  native ADT read endpoint.
- `abap_open_url` — build browser or Eclipse (`adt://`) deep links for an
  object, ABAP keyword documentation, or a Web Dynpro app.
- DDIC object creation for `VIEW`/`DV` and `TRAN`/`T` via a generated
  classrun bridge, for object types with no direct ADT create endpoint (see
  Fixed, below, for how the create side of this held up under later live
  testing).
- Response compaction and truncation: a single compactor with an explicit,
  always-marked truncation boundary, so no tool response is silently cut.
- The tri-state productive/non-productive/inconclusive system-role probe
  (fail-closed on inconclusive), evaluated before any connection is opened
  — later hardened further, see Security.
- Claude Code plugin packaging: topic-oriented skills covering BAdI/BOPF
  traps, DDIC write shapes, transport status, and debugger grammar. (The
  skill set itself was later replaced — see Changed.)
- An experimental consolidated tool surface (`ABAP_TOOL_SURFACE=v2`, six
  tools instead of the full per-tool set); kept opt-in after a live A/B
  found it more expensive and error-prone than `v1` at equivalent work.
- Offline test suite built on captured cassettes and fixtures (literal
  bytes from a real ABAP system), plus `check:leaks` to guard against
  committed secrets or live hostnames.
- Two `AbapErrorCode` values, `CONNECT_FAILED` (the host was never reached
  — refused socket, DNS failure, timeout, TLS) and `SYSTEM_UNAVAILABLE`
  (the system answered 5xx and is refusing everyone), so a caller can tell
  "fix the credential", "fix the network" and "wait for the system" apart
  by branching rather than by reading prose.
- `ABAP_STARTUP_PROBE` (default `true`) — the server authenticates once
  before printing its "ready" banner; on failure the banner prints the
  classified code, message and hint instead of blocking startup.
- `abap_atc` — ABAP Test Cockpit static analysis, run-and-collect in one
  tool. Registered only when the server can write, since a run creates a
  persistent worklist row on the server. As first shipped, its wire
  protocol was derived from a third-party ADT client library's source
  rather than confirmed live; a captured live run later grounded
  several specific elements of it — see Changed.
- `CONTRIBUTING.md`, `SECURITY.md`, and `CODE_OF_CONDUCT.md`.
- Pull-request and issue templates.
- `npm run lint:hints` (`scripts/lint-hint-params.mjs`) — a compiler-API
  lint that fails the build when a tool's caller-facing hint text names a
  parameter in camelCase while the schema actually accepts snake_case, the
  exact class of drift behind several of the hint-text fixes below.
- `ABAP_SESSION_COOKIE` — an alternative to `ABAP_PASSWORD`: connect with
  a pre-established session cookie instead of a password. Exactly one of
  `ABAP_PASSWORD` or `ABAP_SESSION_COOKIE` must be set; both or neither is
  a startup configuration error. The cookie is applied to every outgoing
  request by abapsmith's own HTTP layer, since the underlying ADT client
  library clears its cookie jar on every login and re-login and so cannot
  have a cookie seeded through it, and is redacted everywhere
  `ABAP_PASSWORD` already was (startup banner, error-capture dumps, the
  journal, the system-status resource, connect-failure messages). Not
  exercised against a live SAP system — the available test system does
  not support this authentication style, so cookie-mode auth is covered
  by unit tests only.
- `abap_write mode=delete` now accepts a batch `objects` array (up to 10
  objects per call), validating the whole set before deleting anything and
  journalling each delete individually; the continue-past-failure behavior
  for a partially-failing batch has not itself been live-verified.
- All five class sub-includes (CCDEF/CCIMP/CCMAC/CCAU/testclasses) are now
  writable via `abap_write`'s new `include` parameter, notably making ABAP
  Unit test classes (CCAU) writable for the first time. Undo of an include
  write is refused, since replaying it through the ordinary undo path would
  overwrite the class's main body instead.
- `abap_activate` mutations are now recorded in the journal — previously an
  activation changed which code version an ABAP system executes and left
  no audit trail at all. A static tripwire now catches any future mutation
  site that forgets to journal.
- `abap_service` — OData `$metadata`/EDMX introspection (entity sets, keys,
  typed properties, navigation, function/action imports) for both V2 and
  V4 services, resolving the service-binding → catalogue → `$metadata`
  chain. It never returns entity row data, only the contract shape,
  and reports four distinguishable error codes in place of one generic
  fallback. Test fixtures are synthetic — no live OData call has backed
  this tool yet.
- `abap_activate` gained a batch `objects` form, activating multiple ABAP
  objects in one ADT call instead of one call per object.
- `abap_write` now refuses a full-source rewrite when the caller's most
  recent read of that object was truncated, preventing a silent deletion
  of the unread tail.
- `abap_write` gained `dry_run` — resolves, reads, and applies the edit
  locally, runs the safety gate, and returns a diff and the `expect_etag` a
  real write would assert. Its gate check matches a real write, but the
  post-CTS transport-allowlist check can't run on a preview, so a clean
  transportable dry run can still be refused. Refused with `BAD_INPUT` for
  the `objects` batch-delete form, bridge-only creates, and `DEVC/K`.
- `SRVB`/`SVB` (RAP service binding) authoring support.
- The cross-process advisory object lock now also covers the debugger's
  breakpoint-arming path, closing a race where two processes could collide
  over the same object via the debugger.
- `abap_read` gained `view="history"` and `view="diff"` for object version
  history and diffing, live-verified against a real system: availability
  is checked per-object rather than gated on the discovery document,
  `$TMP`/local objects (which have no released history) are explicitly
  reported rather than silently diffed against themselves, and version ids
  are read from the content URL rather than a field that was stripping
  zero-padding.
- `BDEF`/`BDO` (RAP behavior definitions) are now authorable, supporting
  only `unmanaged` implementations — `implementation managed` is a known
  SAP-side gap. abapsmith's own create/write/activate path for this type
  had not itself been exercised against a live system as of this change.
- `DDLX`/`EX` and `SRVD`/`SRV` are now authorable, live-verified with two
  consecutive clean create → activate → read → delete runs for both types.
- BOPF create/update/delete (`abap_bopf_edit`, `abap_bopf_delete`) are now
  recorded in the journal — previously these mutations left no audit trail
  at all. Undo of a BOPF entry remains structurally refused.
- `abap_enh`'s journalled-mutation coverage was expanded from 3 of 11
  operations to 9 of 11; enhancement-implementation activation, which
  mutates a second object (the enhancement spot) in the same request, is
  now also journalled instead of activating live with no audit record.
- abapsmith can now create a **transportable** `DEVC/K` package via a
  generated classrun bridge, and delete one (empty packages only — the
  ABAP side gathers sub-package/TADIR evidence first and refuses in
  TypeScript if anything is inside), which also makes undo-of-package-
  create reversible instead of a permanent operation. Creating a
  root-level package (naming no superpackage) is now possible under an
  explicit `*` wildcard package allowlist. `IF_PACKAGE~DELETE`'s general
  failure behavior, and specifically whether a transportable package
  delete is correctly recorded against the named transport, were not
  fully live-verified — a live run found the named transport does **not**
  receive the deletion, and this gap is disclosed in the tool's response
  rather than fixed.
- `abap_fpm_read` responses are now compact by default for the `find` and
  `app` operations (`detail: "compact" | "full"`, default `"compact"`) —
  offline fixture measurements sized to match previously-observed live
  payloads suggest roughly 3.2x smaller responses for `app` and 1.7x for
  `find`; this ratio itself has not been confirmed against a live system.
  `detail` has no effect on `outline` or `locks`.
- Bridge delete and `abap_journal mode=undo` were added for `TRAN`/`T`
  and `VIEW`/`DV`. A `$TMP` classic-view create registers the view in
  TADIR (`RS_CORR_INSERT` with `korrnum = space`), so it reads back with
  a package reference and both `abap_write mode=delete` and `abap_journal
  mode=undo` reach it; a view that reads back with no `<adtcore:packageRef>`
  is still refused `SAFETY_DENIED` / `PACKAGE_UNKNOWN` on both routes,
  deliberately. This corrects the entry's own earlier wording, which said
  the `$TMP` round trip could not be reached — superseded by later live
  runs within this same effort.
- Journal entries can now record an `actor` (from `ABAP_ACTOR` or the MCP
  client's declared name) and a `sessionId` distinguishing concurrent
  conversations against the same system; `abap_journal mode=list` gained
  matching `actor`/`session` filters (`session="current"` selects this
  process). Absent, never a placeholder, on entries written before this
  change.
- A successful `DEVC/K` package delete now surfaces the classrun
  transcript markers that back its `deleted: true` result, instead of
  discarding them silently.
- Five new `remove_*` BOPF operations, each verifying the element count
  actually decreased after the call.
- `abap_read` on DDIC data elements now includes each field's length, when
  the source descriptor supplies it.
- `abap_write` (both the v1 and v2 tool surfaces) accepts an optional
  structured `ddic` object for `DOMA/DD`, `DTEL/DE`, and `TTYP/DA` writes,
  as an alternative to hand-composing the XML `source` payload. The
  generated XML element set and ordering is derived from the same
  fixtures used to verify create for these three types, and rejects any
  field not grounded there; a raw `source` write is unaffected. Two
  shape mistakes in the structured builder — unpadded numeric length/
  decimal slots on `DTEL`/`TTYP`, and a max-length derived from the
  caller's own length instead of the fixed values the fixtures show —
  were found and corrected by review within the same change before it
  merged.
- `TABL/DI` (a transparent table's secondary index) can now be created and
  deleted through a generated classrun bridge calling
  `DD_INDEX_INTERFACE` — there is no ADT REST route for indexes at all,
  so there is no read and no change, only drop and recreate. The index's
  package is the base table's, resolved by reading the table over ADT,
  never the caller's; a caller-supplied `package` is only checked for
  agreement. A transportable package requires `corr_nr` for both create
  and delete, unlike the `VIEW/DV`/`TRAN/T` deletes, which refuse one —
  `DD_INDEX_INTERFACE`'s delete takes a transport parameter too. The
  create is never `verified` and never journalled: there is no resource
  to read an index back from and so no undo path, only an explicit
  delete. A non-unique create and a unique create with the base table's
  client field were both proven live on A4H in a `$TMP` package, across
  two live rounds; omitting the client field is refused `BAD_INPUT` before
  the FM runs. The delete originally omitted `DD_INDEX_INTERFACE`'s
  mandatory `INDEX_FIELDS` parameter; fixed and confirmed deployed. A
  delete can still report `ACTFAILED` even after it already took effect;
  the fix for that — commit regardless, then re-verify via a post-commit
  `DD12V`/`DD17S` re-read — turned out to never run: its own added message
  line exceeded ABAP's 255-character source-line limit, so every delete
  failed the class-source PUT before `DD_INDEX_INTERFACE` was ever called,
  leaving the deployed bridge class on its pre-fix body. The
  `ACTFAILED`-tolerant read-back had therefore never executed live. Fixed
  again — the long messages are now built up in a variable across short
  lines, and every generated bridge class body is now rejected before it
  is written if any line exceeds 255 characters — and a fourth live round
  then deleted a non-unique and a unique index through the redeployed
  bridge, with `NOT_FOUND` on a re-delete: delete is live-proven in `$TMP`.
  `ACTFAILED` is still set on a delete that took effect. A later cleanup
  deleted a base table whose indexes' catalog rows may still have existed;
  whether the delete cascaded them away or left them orphaned is
  unverified. The transportable-package path is unexercised.
- Four new `abap_bopf_edit` operations — `add_representative_node` /
  `remove_representative_node` for cross-BO representative nodes, and
  `embed_dependent_object` / `remove_dependent_object` for delegated
  dependent-object nodes — bringing the operation total to 27, each with
  the same post-write re-read verification as the rest. `abap_bopf`
  `mode: "show"` now labels every node with a kind (`root` / `standard` /
  `delegated` / `representative`) and flags associations that are
  do-compositions or cross-BO.
- Six new `set_*_fields` BOPF operations (`set_association_fields`,
  `set_action_fields`, `set_determination_fields`, `set_validation_fields`,
  `set_query_fields`, `set_alternative_key_fields`), patching an existing
  child element in place: only the fields named in `spec` change, and every
  other attribute and every child element of the target element is
  preserved byte-for-byte. `null` clears an attribute or a ref, as
  `set_node_flags` already did. Each re-reads after the write and fails
  `CHECK_FAILED` if a named field did not stick.
- `abap_quick_fix` — lists and applies ADT position-driven quick fixes
  (`mode: "list"` / `mode: "apply"`), routed through the same journalled
  write pipeline as `abap_write` and undoable. `mode: "list"` is itself
  gated as a write because it posts the whole object source; v1 accepts
  deterministic proposals only, refusing a parameterized one `BAD_INPUT`.

### Changed

- The committed plugin bundle labels its modules with paths inside the repository (`node_modules/...`) instead of the build machine's real dependency directory; a test now fails if a label escapes the repository again. The ignore list no longer carries the project's former working-directory name.
- Two source comments caught up with the code: `abap_ui`'s deps type now takes `allowUiPress` straight from `Config` instead of describing the `ABAP_ALLOW_UI_PRESS` flag as not yet implemented, and the `BDEF/BDO` skeleton-create note no longer refers to the development process that captured it.
- `VIEW/DV` create into a transportable package resolves a transport
  request the same way a `DEVC/K` create does — `preflightPackageCorr`
  honours the caller's `corr_nr` when given, or else picks or creates one
  under `ABAP_ALLOW_TRANSPORTS`, gated before the write proceeds. The
  resolver's own refusals surface as `TRANSPORT_ERROR` (policy disabled, or
  no usable request), `TRANSPORT_LOCKED` (a request pinned elsewhere), or
  `BAD_INPUT` (a malformed number). A `$` package still refuses a `corr_nr`
  (`BAD_INPUT`).
- `abap_debug`'s `breakpoints` schema states the shared `condition`/`skipCount`
  guidance once at the array level instead of once per union branch, trimming
  the largest single property in the `tools/list` payload by about a third with
  no validator change. The facts that left the schema now live in
  `doc/TOOLS/debugger.md`; a test pins the property's size ceiling.
- A failed connect is now classified instead of being labelled
  `AUTH_FAILED` unconditionally: 401/403 map to `AUTH_FAILED`, 5xx to
  `SYSTEM_UNAVAILABLE`, and anything unidentified to `ADT_ERROR` — never
  silently back to `AUTH_FAILED`. Previously an outage that was refusing
  everyone was reported as "your credentials were rejected".
- Renamed the forensic body-dump environment variable to
  `ABAPSMITH_BODY_DUMP_DIR` (from an earlier working name for the
  project), with no fallback to the old name.
- `doc/TESTING/README.md` and `CONTRIBUTING.md` no longer claim that setting
  `ABAP_URL` can turn `npm test` into a live run — the live suites are
  excluded at config level on a separate variable, and no offline test
  reads the ABAP URL from the environment.
- `ABAP_MODE` is now the primary way to grant write, transport-release,
  and enhancement capability; the older per-flag `ABAP_ALLOW_WRITE`,
  `ABAP_ALLOW_TRANSPORT_RELEASE`, `ABAP_ALLOW_ENHANCEMENTS`,
  `ABAP_ENHANCE_TARGETS`, and `ABAP_ALLOW_SOURCE_PLUGINS` variables are
  ignored (with a startup warning) once `ABAP_MODE` is set.
- MCP tool registration is now gated statically on capability: a tool with
  no ungated mode is absent from `tools/list` entirely rather than
  present-and-refusing.
- Project renamed from its original working name to `abapsmith` as part of
  open-source preparation.
- The 12 topic-oriented skills bundled with the Claude Code plugin were
  replaced with 9 task-oriented skills, chosen against benchmarked
  outcomes rather than topic coverage — changing what guidance an agent
  driving abapsmith actually sees.
- The v2 tool surface's experimental, not-for-production status is now
  stated unmissably in both documentation and runtime behavior; `v1`
  remains the shipped default.
- The ADT discovery inventory is now shared across pooled connections
  instead of being re-fetched per connection, cutting a measured ~450ms of
  per-call latency to near zero after the first connect.
- Documented that `DDLS`/`DF` (CDS views) only support classic
  `@AbapCatalog.sqlViewName`/`define view` syntax on the ABAP release this
  project targets — `DEFINE VIEW ENTITY`, `DEFINE CUSTOM ENTITY`, and
  `AS PROJECTION ON` require a newer release and will fail. No runtime
  release detection was added.
- README gained a worked first-session walkthrough and a stated maturity
  level; its example configuration was corrected from an inline password
  to the safer env-file pattern the project's own tooling already used.
- Corrected a stale claim that no part of the ATC wire protocol had ever
  been exercised live — an earlier capture had already grounded several
  specific elements (run-POST synchronicity, worklist-id shape, finding
  attribute names) that were previously pure inference from library
  source. A separately-reported duplicate-info-note defect in ATC output
  was fixed the same day.
- Documented that abapsmith supports HTTP Basic authentication only.
- Documented that `abap_debug` can only catch breakpoints it triggers
  itself via `action:"start"`, under the configured user — it cannot
  arm-and-wait for another session or user to hit a breakpoint. Removed
  dead watchpoint-endpoint code that was never called.
- Cross-process locking and batch-activation tuning env vars moved into
  the validated config schema, so they now appear in the effective-
  configuration report instead of being invisible; the underlying
  behavior is unchanged.
- Tool descriptions and refusal hints that told the calling agent to set
  `ABAP_ALLOW_WRITE` — a lever that does nothing under `ABAP_MODE`-based
  deployments — now correctly name `ABAP_MODE=edit|admin`, and runtime
  refusal hints report the lever actually in force.
- `ABAP_ALLOW_TRANSPORTS` set by the operator now actually **replaces**
  the allowed-transports list under `ABAP_MODE=edit`/`admin`, instead of
  being silently intersected with an `["auto"]`-only ceiling — previously
  pinning a real transport request produced a deny-all refusal even
  though the operator had set exactly what the error hinted at. Several
  previously admin-only behaviors (including transport-delete and
  cascade-delete) are now independently togglable via new env vars that
  override the mode default in either direction. abapsmith now warns at
  startup if an override variable is set where it would be silently
  ignored, or if an `ABAP_ALLOW_*` variable name is unrecognized.
- `ABAP_ALLOW_PACKAGES` now defaults to `["*"]` (any customer package is
  writable) instead of `["$TMP"]`. An explicitly empty list still means
  deny-all. **This is a genuine widening of default write scope, not a
  bug fix** — operators who were relying on the previous implicit
  "`$TMP` only" default should now set `ABAP_ALLOW_PACKAGES` explicitly if
  they want that restriction. The startup message no longer falsely
  claims that nothing can be transported under the new default.
- `ABAP_ALLOW_TRANSPORTS`, `ABAP_ALLOW_PACKAGES`, and related write-scope
  refusals now render every object type the write path actually accepts,
  and the generated capability table no longer lists `DEVC/K`, `VIEW/DV`,
  and `TRAN/T` as unreachable by any write when they are in fact
  bridge-creatable.
- Transport auto-selection (`ABAP_ALLOW_TRANSPORTS=auto`) now reuses a
  request this server itself created (matched by owner and its own
  description) instead of minting a new one on every cold start whenever
  more than one candidate matches.
- MCP instructions and refusal text no longer claim the write-package
  allowlist "defaults to `$TMP`" — the real default is now rendered from
  resolved configuration so the two can't drift apart again.
- doc/SAFETY/safety-gate.md (and the v2 tool catalogue) now state explicitly that ABAP
  executed via `abap_run` is **not** bound by this server's transport,
  package, or name allowlists — `abap_run` can execute any object and
  construct a transport number at runtime. This was previously true but
  undocumented.
- `AVAILABLE_MEMBERS_MAX` (the near-miss suggestion list for an unresolved
  name) was cut from 60 to 12, ranked by edit distance to the requested
  name, so a one-character typo now surfaces the intended match at the
  top instead of being buried in a long alphabetical list. The default
  response-size ceiling was lowered from 60,000 to roughly 47,100
  characters, and the configurable override is now clamped at 200,000
  rather than left unbounded.
- `deployBridge` skips a redundant activation request on a warm bridge
  no-op when a prior read already proved everything active;
  `abap_fpm_read mode="outline"` gained opt-in paging over its previously
  unpageable raw XML; `abap_debug`/`abap_enh` tool-schema descriptions
  were trimmed to reduce `tools/list` token cost, with the displaced
  reference material moved into `doc/TOOLS/`.
- The six `add_*` BOPF operations for association/action/determination/
  validation/query/alternative-key now refuse a `name` that already exists
  on the target node, instead of silently creating a second element with
  that name.
- `TRAN/T` create now threads a transport request through to
  `RPY_TRANSACTION_INSERT`'s `transport_number` parameter, mirroring
  `VIEW/DV`'s package rule: a transportable package requires `corr_nr`
  (`TRANSPORT_ERROR` without one), and a `$` package refuses one
  (`BAD_INPUT`) and registers with `korrnum = space`. The FM's signature
  was read live on A4H 2026-09-05, confirming `transport_number` is
  forwarded verbatim to `RS_CORR_INSERT` as `korrnum`; no live create into
  a transportable package has been run yet.
- The live suites `integration-undo` and `integration-fpm-lock` now pair
  their whole-file `describe.skip` with a `liveSuiteSkipReason` case stating
  why, under the greppable `APPLIANCE STATE:` prefix, instead of just
  reporting "skipped" with no reason; the documented live-suite surface in
  `CONTRIBUTING.md` and `doc/TESTING/README.md` was also corrected against
  `LIVE_INTEGRATION_TESTS` in `vitest.config.ts`.
- Three `abap_bopf_edit` operations — `add_representative_node`,
  `remove_representative_node`, `embed_dependent_object` — are removed
  after a live discovery run against a real SAP system proved the write
  shapes they sent do not survive the endpoint: a client-written
  parentless node is hard-rejected by the deserializer
  (`/BOBF/ST_CONF_ADT`), and a `DoComposition` association plus embedded
  node comes back with its `implementationType` rewritten to
  `Composition` and its `doEmbeddingName` dropped, with the resulting
  node name then refused at activation. A representative node is now
  obtained the way the server actually produces one: a plain cross-BO
  `add_association` (an `Association` `spec.targetNodeRef` naming
  another BO's node, plus a `spec.implementationClassRef` naming an XBO
  class) causes the server to mint a parentless node itself, named
  `REP_<random>`; confirmed live that `remove_association` removes it
  too — `nodeCount` fell from 2 to 1 and the node was gone from the
  read-back.
  There is no replacement for creating an embedded dependent object.
  `remove_dependent_object` is unchanged, its refusal path having been
  exercised correctly against the live system, as are the `abap_bopf`
  `show` node-kind labels (`root` / `standard` / `delegated` /
  `representative`) and `check_refs`'s `unchecked` verdict for cross-BO
  references. `abap_bopf_edit` now has 24 operations (was 27) and the v2
  `abap_do` catalogue 52 actions (was 55), 27 of them in the `bopf` group
  (was 30). A second live run then tried both remaining candidate
  embedding shapes and both failed as well — a byte-verbatim transplant
  of SAP's own `ROOT_LONG_TEXT` embedding threw at the same
  `/BOBF/ST_CONF_ADT` deserializer even with the node correctly
  parented, and an association naming the dependent object's own root
  answered 200 with the association silently discarded — so the removal
  is a settled negative for this endpoint on this release, not a gap
  waiting on evidence. See `doc/CAPABILITIES/bopf.md`.
- `abap_bopf_edit operation:"create_bo"` now refuses with a new terminal
  error code, `BOPF_CREATE_UNUSABLE`, when the landed root node is unnamed
  (`bo:name=""`) or missing outright, instead of reporting success over an
  object that can never be activated — BOPF generates the `Z*_C` constants
  interface from the root node name at create time and never regenerates it,
  so renaming the root afterward doesn't help. The object still exists
  server-side (the journal still records `succeeded`, naming that entry's id;
  remedy: `abap_bopf_delete` then recreate), and no activation request is
  sent even with `activate: true`. A differently-named, non-empty root is
  still only a discrepancy note. See `test/bopf-create-recovery.test.ts`.
- Documentation, code comments and registry notes no longer name the appliance's transportable test package; they say "a transportable package" instead.
- `abap_transport operation=removeObject` now detects up front when the
  request already holds two or more E071 rows for the object's
  PGMID+OBJECT+OBJ_NAME — legal under E071's TRKORR+AS4POS key, and typically
  the result of creating an object and then deleting it under the same
  request — and refuses with a new terminal error code, `CTS_DUPLICATE_ENTRY`,
  naming the object, the holder, the row count and the AS4POS values, instead
  of letting a partial removal run into `TR_DELETE_COMM_OBJECT_KEYS`'s own
  `w_duplicate_entry` refusal (`MESSAGE e292(tr)`) mid-batch; a late `TR 292`
  from the function module itself maps to the same code. Any other refusal in
  this family still surfaces the CTS `sy-subrc` and, when CTS set one, the
  `sy-msg*` T100 message as a `msg=` fragment on the `CHECK_FAILED` error,
  instead of swallowing them. The response also reports `objectOnSystem`
  (`present`/`absent`/`unknown`) for the entry's object, since removing the
  entry drops CTS's lock unconditionally and a `present` result means a
  still-live object just lost the lock protecting it. Read live on A4H,
  2026-09-05: both stuck fixture tasks held exactly two E071 rows apiece for
  their object, and no supported function-module call removes just one of
  them — the remedy is outside abapsmith (edit the request's object list in
  SE09/SE10, or release the request) — see
  `doc/LIMITATIONS/not-implemented-and-unproven.md`.

### Fixed

- The generated capability table's "not readable either" line is now derived
  registry-wide from the same predicate as `NON_READABLE_TYPES`, so it names all
  eight non-readable types (it previously missed `VIEW/DV` and `TRAN/T`, the two a
  caller is most likely to try to read back after a bridge create). A census
  test pins the table to the constant so the drift cannot recur silently.
- Correctness fixes found during a live-verification campaign against a
  real ABAP system: activation no longer silently drops an `affects`
  intent, the FPM lock path no longer treats a failed lock acquisition as
  held, the debugger reports how a debuggee actually ended instead of
  guessing, enhancement writes were fixed across several parameter and
  encoding issues, BOPF bridge identifiers no longer collide across
  multi-node scenarios, and DDIC fixed-value texts on domains are no
  longer reported as written when they weren't.
- `abap_write` now verifies `VIEW`/`DV` and `TRAN`/`T` creates by reading
  them back rather than trusting the classrun bridge's own report.
- `abap_ui` enumerates GUI statuses so screen mode returns real buttons.
- Credential handling: rejected credentials now latch process-wide
  instead of continuing to burn logon attempts, and a `401` trips a
  one-shot circuit breaker with no retry.
- Enhancement-object naming and encoding: namespace-prefixed BAdI/BOPF
  names are correctly percent-encoded; `PROG/PT` (GUI titles) is refused
  by name alongside `PROG/PS` and `PROG/PC`.
- Where-used fetch is honestly capped after live-verifying no server-side
  limit exists on the endpoint.
- `abap_read` (and `abap_bopf_edit`/`abap_bopf_delete`) stopped emitting a
  `structuredContent` block that carried only counters — an MCP client
  that prefers `structuredContent` over `content` when both are present
  got the counters and zero lines of ABAP source. Source now travels in
  `content` only, with a `response: complete (...)` header line carrying
  the facts `structuredContent` used to hold. A static contract test now
  guards against this defect coming back in a third tool.
- The XML parser was silently coercing DDIC fixed values on read — e.g.
  stripping the leading zero from `"01"` to `"1"`; the write path was
  already correct. Left uncaught, an agent that read `1` and wrote back
  `'1'` would never match a field actually storing `01`.
- `DOMA`/`DD` writes are now rejected-then-retried-correctly by always
  including an empty fixed-values element — SAP rejects the write payload
  without it, even for domains with no fixed values, live-confirmed
  12 for 12.
- `TABL`/`DI` (table secondary index) is now registered as an explicitly
  unsupported type in the capability tables; previously it was absent
  from every capability bucket, so a caller could only discover it was
  uncreatable after three failed calls.
- The debugger's raw long-poll/CSRF transport now honors
  `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`, matching the rest of the tool —
  previously a debug session behind a proxy could reach ABAP when other
  tools could not, or vice versa.
- `abap_activate mode=check` with no `source` now reads and checks the
  object's saved server source instead of always refusing; it still
  refuses fast for genuinely nonexistent objects or unsupported types.
- `DOMA`/`DD` writes missing the `masterLanguage` attribute silently
  dropped every fixed-value description while still reporting
  `activated:true` with no warning, live-verified 7 for 7. Such writes
  are now refused with a clear error instead.
- A blank transport-number string was previously treated as a real
  transport request, producing a confusing "named transport" refusal
  instead of correctly being treated as no transport supplied. Fixed
  across `abap_activate`, `abap_enh`, `abap_write`, and the v2 surface.
- Reads of unsupported explicit object types previously fell through to a
  generic, under-explained `NOT_FOUND` even though write already refused
  them cleanly; read now runs the same capability check up front.
- Journal entries written by `abap_write`, `abap_ui`, `abap_bopf`, and
  `abap_enh` now all carry a system key (SID, origin, client), so undo's
  cross-system safety check can use a strong comparison instead of a
  weak SID-only fallback that cannot tell two systems sharing a SID apart.
- Two independent session-death classifiers could disagree about the
  same response, risking a duplicated write on replay; wire-level
  evidence of death now outranks weaker message-prose evidence, and a
  connection marked condemned can no longer have a write replayed on it.
- `CREATE` and `DELETE` capability claims now carry a verified/unverified
  tri-state, live-swept against a real system. `ENQU/DL` create was
  downgraded to unverified after the one genuine live create failure
  found in the sweep; the three types originally suspected broken
  (`DTEL/DE`, `MSAG/N`, `TABL/DT`) all created cleanly and were not
  downgraded. `ENQU/DL` create and delete were re-verified live on
  2026-09-05 once the real cause of those failures was found: the
  descriptor's root element must be the lowercase `enqu:lockobject` in
  namespace `http://www.sap.com/adt/ddic/enqu`, not the camelCase
  `enqu:lockObject` in `http://www.sap.com/dictionary/lockobject` the
  earlier attempts sent, so both flags are `true` again and `abap_write`
  now refuses a wrong root element up front. `BDEF/BDO` delete was
  downgraded from verified-deletable to false after delete was found to
  report success while leaving the object readable, reproduced 3 times;
  the automatic rollback-on-failed-create path now respects this same
  gate.
- Fixed a pooled connection that could leak an ABAP enqueue lock and
  never get swept — the leak-detection hook is now actually wired at
  session construction, and any detected leak now drops the whole
  session, live-verified by confirming a second connection can re-lock
  the object afterward.
- A pooled session that died as a side effect of one caller's request no
  longer hands the raw error straight to the next, unrelated caller —
  reads now always safely replay on a fresh session, and writes replay
  only when the failure arrived implausibly fast.
- When a create's follow-up write is rejected, abapsmith now rolls back
  the orphaned object it just created — previously only a fraction of
  refusal paths triggered rollback. The response now honestly reports
  whether the rollback succeeded, failed, or was deliberately not
  attempted, live-verified with a before/after transcript.
- `SUSO/B` (authorization objects) confirmed via live reconnaissance to
  be a real ADT object type with no usable read/write collection;
  registered as explicitly unsupported, naming SU21 as the alternative.
- The debugger's raw HTTPS long-poll/CSRF transport now honors the
  insecure-TLS override, matching the rest of the tool — previously
  every ordinary tool worked against a private-CA/self-signed system
  while the debugger tools failed with an opaque TLS error.
- A single large DDIC batch activation had taken down a shared appliance,
  because the underlying mass-activation utility fans one request out
  into an uncontrolled burst of internal calls. Classic DDIC types
  (domains, data elements, tables, etc.) now travel in small chunks
  (default 5, configurable) while classes/programs/interfaces/CDS keep
  full batching.
- Fixed undo's drift probe reading the wrong URI, which made undo-of-
  create silently no-op (reporting success while leaving the object on
  the server) for packages and every properties-shape type. Package
  creates are now correctly marked irreversible in the tool's own
  response (packages have since gained a real, limited delete path for
  empty packages — see Added).
- A `$`-named local package (`DEVC/K`) can be deleted via `abap_write
  mode=delete`, its create undone via `abap_journal mode=undo` — both
  previously failed `SAFETY_DENIED` / `PACKAGE_UNKNOWN`. It reads back
  with no `<adtcore:packageRef>` element, and the gate resolves an
  existing package to itself; one fix covers both, since delete and
  undo share the same target-resolution step. The delete bridge also
  rejected `$`-prefixed names as `BAD_INPUT` — fixed. Empty packages
  only, unchanged; the package-create response's claim about these
  routes is now accurate, having promised two that failed.
- Corrected a false claim that `abap_write` has no surgical string edit —
  it has long supported targeted `edit` (unique-match splice) and
  `method` (single method-block replace) fields; clarified that the
  underlying write is still always a whole-document replace under the
  hood.
- Corrected a false claim, baked into both a doc comment and a live error
  message, that a BOPF business object's constants-interface reference is
  assigned only at first activation — a captured fixture shows it is
  already populated on a freshly created, never-activated object.
- Error response envelopes are no longer pretty-printed as JSON, which
  previously meant a caller reading only the first line saw just `{` and
  lost the entire diagnostic; this also recovers roughly 10% of response
  budget.
- `abap_bopf create_bo`'s response now surfaces the generated constants-
  interface name instead of omitting it.
- Several generic ADT/CTS error fallback paths previously reached the
  caller with no hint at all; they now carry honest hints stating the
  error wasn't diagnosed, pointing to where the verbatim SAP text lives,
  and forbidding blind retry. `abap_activate` was also incorrectly
  annotated as non-destructive even though it is irreversible — corrected.
- Fixed undo-of-create on properties-shape objects (`DOMA/DD`, `DTEL/DE`,
  `TTYP/DA`, `ENQU/DL`, etc.) falsely reporting drift and refusing —
  activation rewrites version metadata inside the descriptor, but the
  journal was fingerprinting the pre-activation response; it now
  re-settles the fingerprint after a successful activation.
- Object and write-target resolution no longer trusts a naming-
  convention-derived type (e.g. a `ZCL_*`-style name) as evidence of what
  an object actually is — both now probe the server first and return
  `NOT_FOUND`/`BAD_INPUT` instead of silently guessing and possibly
  acting on the wrong object type. Several caller-facing tool
  descriptions and hints that had drifted from actual behavior (bounding
  vs. fetching rows, a costly BOPF escape hatch undersold as routine,
  camelCase hints for snake_case parameters) were corrected in the same
  pass. The debugger now distinguishes a normal debuggee-ended session
  from a raw forwarded exception message; a leaked bridge class after a
  failed write now discloses a "safe to delete" hint; a timed-out
  debugger cleanup step is now surfaced in the response instead of
  silently dropped to a log.
- `abap_write` refusals now advertise every type the tool actually
  accepts — a hand-maintained list had drifted and omitted create-only or
  bridge-only types.
- A transport request released by another process mid-session is now
  detected and healed in-process instead of failing every subsequent
  write until restart, and the underlying error gets a specific
  classification instead of a generic "not recognised" message.
- `abap_bopf_edit`/`abap_bopf_test` now reject misspelled or malformed
  spec keys client-side, naming the nearest legal field, instead of
  silently discarding them. `remove_node` refuses to remove a root node.
  `create_bo` no longer reports session-dead for an object that was
  actually created. `cascade_ddic` no longer deletes DDIC objects a BO
  merely references (as opposed to generated), since those can be shared
  with other business objects.
- `$`-prefixed object names (`$TMP` and other local packages) can now be
  addressed by name on both the read/resolve and write paths — previously
  they could pass an early gate and be refused later on write, or be
  refused outright on read.
- Activation now completes ADT's two-phase handshake instead of
  misreading a non-empty intermediate check-list as failure — previously
  no object with co-required dependents in a transportable package could
  be activated at all. Co-activated objects are now disclosed in the
  response. Verification switched from that intermediate document's
  emptiness to the object's actual version history, fixing false failure
  results on function groups. The joint BAdI spot and
  implementation activation path completes the same handshake, fixing a
  case where it could self-contradictorily report itself both failed and
  succeeded.
- A BAdI enhancement write missing its required wrapper statements now
  gets an error naming that specific omission instead of a confusing,
  unrelated SAP message; `create_impl` now reports whether the
  implementing class actually exists rather than assuming so because it
  was named in the request. (The wrapper syntax as first documented in
  this fix was itself wrong and rejected by SAP; a later commit in the
  same change corrected it after live testing.)
- Fixed `PARENT/NAME` splitting at the wrong slash when a namespace is
  involved, which could silently resolve to a different object than
  named, or wrongly refuse a valid namespaced reference. The container
  name is now validated with the same rule as the object name.
- A raw ADT URI addressing a sub-object (e.g. a table index) now gets a
  specific error naming the target and sub-part, instead of a generic
  "unrecognised URI".
- Fixed existence-checking for bridge-created `TRAN/T` and `VIEW/DV`
  objects: the bridge always answers success, even for objects that were
  never actually created, so existence and registration checks had been
  conflated and `abap_journal mode=undo` could never run for these types.
  They are now checked separately.
- Reading an absent object's source where the endpoint answers with a
  server error instead of a clean "not found" now returns `NOT_FOUND`
  once a follow-up read confirms absence, instead of an unclassified
  error telling the caller not to retry.
- Markup from scraped ICF/ICM error pages is now stripped from
  diagnostic error text — previously the real error message could be
  buried in hundreds of characters of raw markup. A raw non-classified
  throw carrying a dead session now gets a reconnect hint in one more
  code path.
- `ABAP_ENHANCE_TARGETS` can now override the `ABAP_MODE` default in
  either direction — previously silently ignored once `ABAP_MODE` was
  set. An explicitly empty value is now a config-time error rather than a
  silent alias for "none".
- DDIC XML-only writes (`DOMA`/`DTEL`/`TTYP`) are now checked against a
  known-accepted skeleton before sending, catching provably-wrong root
  elements or namespaces client-side; one specific malformation was
  previously silently accepted and produced a data element with no type.
- A lock failure occurring after a create's write already landed is now
  verified and reported accurately instead of inviting a same-name retry
  that would collide; the stranded server-side lock from that failed
  attempt is now dropped.
- BOPF delete/create reporting now states only what was actually
  verified: a no-cascade delete explicitly says generated DDIC was left
  behind rather than implying it doesn't exist, the delete probe also
  checks the generated constants interface, and the reason given for a
  spared DDIC reference is now accurate rather than assumed.
- BOPF delete now distinguishes "cascade delete never requested" from
  "cascade ran, found nothing" — both previously reported an identical
  empty list.
- `add_alternative_key` now preflights against BOPF's own model and
  refuses (overridably) a key referencing a nonexistent field or a node
  with no persistent structure, catching malformed requests before they
  can crash a live session. This does not make the underlying operation
  itself reliable for every input — a fully valid payload can still
  short-dump SAP-side.
- A dropped or failed system-role probe (e.g. connection lost mid-check)
  now reports a distinct "probe failed, restart" error instead of being
  folded into the same refusal as a genuine policy decision.
- `where_used` now discloses when its underlying fetch was expensive
  (many references or several seconds), since the server enumerates and
  transfers the whole reference set before any limit is applied.
- A zero-hit repository search is no longer read as proof an object
  doesn't exist. Create-verification, delete-verification, and batch-
  delete reporting all downgrade a search-miss to indeterminate/
  unverified instead of confirmed-absent, and batch delete now separately
  counts confirmed vs. unverified deletions rather than counting
  unverified ones as successes.
- Delete verification no longer infers absence from a repository search
  on a type it doesn't index, a server error on a type whose content
  endpoint doesn't otherwise 404 for missing objects, or a dead-session
  read failure — each case now requires an actual observed absence or
  degrades to indeterminate, with one safe reconnect-and-retry.
- Batch delete now reports an error whenever any object in the batch was
  left undeleted, not only when every object failed — previously a
  partially-failed batch returned a plain success envelope.
- A batch delete where every object failed now sets the MCP error flag
  instead of returning a success envelope.
- `AUTH_CIRCUIT_OPEN` no longer tells operators that restarting the
  server clears the auth latch — it's durable on disk and a fresh process
  replays it immediately. The hint now names the actual latch file, TTL,
  and remaining time.
- BOPF write/activate/delete and bridge-create now judge one real
  transport decision per mutation instead of fabricating a placeholder
  "auto" transport that could be wrongly refused under a pinned transport
  allowlist.
- Read/search now accepts SAP-generated namespaces starting with a digit;
  write paths are unaffected — namespaced objects still cannot be written
  through this server. `abap_enh operation:"exercise"`'s parameter-type
  field now validates as a proper type reference instead of the stricter
  object-name grammar.
- A batch delete where every object failed now sets the MCP error flag
  instead of an ok envelope; a batch where some but not all objects
  failed is reported precisely (already listed above) — both fixes
  together close out the batch-delete honesty work.
- A BOPF delete with `cascade_ddic: true` whose internal DDIC walk failed
  partway through previously rendered identically to a delete that walked
  the whole tree and genuinely found nothing to clean up. The response
  now reports whether the walk actually ran, and suppresses the DDIC
  counts entirely when it didn't, with a note that a missing walk is not
  evidence of a clean sweep.
- `abap_bopf create_bo`'s recovery from a session death mid-create re-read
  the object and reported `recovered: true` without ever comparing the
  result to what was requested. A live run found the recovered object's
  root node came back with an empty name instead of the one the caller
  asked for; BOPF bakes that empty name into the generated constants
  interface at create time, so the object could never be activated, and
  renaming the root afterward does not repair the interface. `create_bo`
  now verifies the root node on every return path and reports an
  unnamed root as unactivatable (naming `abap_bopf_delete` as the
  remedy), a differing name as a discrepancy, and a missing root as
  unconfirmed, instead of a bare success.
- A session death classified from a response that actually resolved with
  a 2xx could previously be applied immediately even though the call had
  already committed server-side, discarding a real, successful result by
  throwing a session-dead error out of the same code path that was
  meant to restore state afterward. Such a death is now deferred and
  applied at the next request boundary instead of being allowed to
  overwrite a result the server already committed. A death from a
  genuinely failed (non-2xx) response is unaffected and still applied
  immediately.
- `abap_bopf` `mode: "check_refs"` used to report a cross-BO
  `targetNodeRef` (e.g. `/BOBF/DEMO_CUSTOMER~ROOT`) as `missing`, because
  it looked the target up in the host business object's own node list.
  It now reports `unchecked`, with a detail naming the other business
  object, instead of a false `missing` — `check_refs` reads one business
  object and does not fetch another to verify it.
- `abap_read` reported an absent `BDEF/BDO` as an empty success: this
  type's `/source/main` answers 200 with an empty body once the object is
  gone, indistinguishable from a genuinely (if oddly) empty source. A
  blank `BDEF/BDO` source read is now confirmed against the object's own
  URI before being reported absent in the post-delete read-back; the
  post-create read-back instead falls through to the repository search
  on a blank body rather than trusting it alone. The registry's
  `delete: false` for this type, which rested on the earlier misread, is
  corrected to `true`.
- A pinned `ABAP_ALLOW_TRANSPORTS` previously refused every `VIEW/DV`/
  `TRAN/T` bridge delete outright, because the gate synthesized an `auto`
  transport request for a call that passes none; both delete bridges now
  present the mutation as local, so the transport allowlist no longer
  blocks them (an explicit deny-all still does), and the delete response
  now flags any transport-request entry the object's create left behind
  for `abap_transport removeObject` to clean up.
- `abap_bopf_edit operation:"add_alternative_key"`/`"set_alternative_key_fields"`
  now refuse the `checkAfterModify`/`checkBeforeSave`/`noCheck` combinations
  that made BOPF's model mapper assert and take down the ADT session; `unique`/
  `uniqueIfNotInitial` now require exactly one of `noCheck`/`checkAfterModify`.

### Security

- SafetyGate's customer-namespace enforcement for `DDLS`/`DF` (CDS views)
  only checked the view's own object name, not its embedded database-view-
  name annotation — a customer-namespaced CDS view could activate an
  underlying database view name outside the customer namespace. Both are
  now checked against the same namespace guard.
- The startup probe that decides whether a connected SAP system is safe
  to write to no longer treats an unrecognized system client-category
  value as evidence that the system is non-productive. The classifier
  previously accepted anything other than the literal "production" code
  as proof of a non-productive client, so an unfamiliar or malformed
  category code could let a system that should have been refused as
  productive through as writable. It now allowlists the known
  non-productive category codes by inclusion and reports "inconclusive"
  for anything else; "inconclusive" fails closed and is treated the same
  as a confirmed-productive system by the write gate.
