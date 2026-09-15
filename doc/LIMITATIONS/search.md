# Search

- **ADT's quickSearch mis-pairs `adtcore:description`.** Observed in
  `test/fixtures/live-captured/451-ver-quicksearch-any.xml`, re-captured
  byte-identically 19 days later as `812-p0-quicksearch-t000-repro.xml`:
  table `T000` carries another row's description. Rule, checked
  against per-object ground truth rather than inferred: within a type group
  (before `/`, e.g. `TABL`), rows are emitted ordered by (sub-type, name),
  but descriptions are applied in that group's name-ascending order. 13
  exact matches across 3 datasets, 2 type groups, confirm it: `T000`
  (capture 812; truth 814-816) 3 of 4 TABL rows; `ZTMC*` (capture 836; truth
  837-843) all 7 TABL rows, 4 of which the server had mis-paired; `RS*`
  (capture 824; truth 829-831) 3 PROG rows. `T000_RFC` matches
  semantically, not byte-for-byte: right description on the right row, but
  the search index string differs in case and wording from the DDL
  `@EndUserText.label` in capture 817 — a text-source mismatch, not a
  pairing error. 3 exact matches (captures 824/825; truth 832-834) confirm
  FUGR arrives already correct. Likely cause: one text table per type group
  (e.g. DD02T covers both `TABL/DT` and `TABL/DS`) read separately and
  joined positionally. `abap_search mode=objects`
  (`src/adt/search-descriptions.ts`) repairs `TABL` and `PROG` — each backed
  by a capture plus ground truth — and discloses it via a `DESCRIPTIONS
  RE-PAIRED` note plus `descriptionsRepaired` header field. `FUGR` is
  excluded despite passing every structural precondition the repair checks.
  Any other multi-sub-type group with the same shape (order matches the
  defect model, repair would be non-identity) is left untouched and
  disclosed instead via `DESCRIPTIONS MAY BE MIS-PAIRED` /
  `descriptionsSuspect`. Both notes point at `abap_read` to confirm.
  `where_used` uses a different ADT endpoint and is untouched.

- **ADT's quickSearch `objectType` filter is not trusted for completeness.**
  Its sub-type half is ignored server-side: captures
  `818-p2-quicksearch-t000-tabl-dt` and `819-p2-quicksearch-t000-tabl-ds`
  are byte-identical despite asking for `TABL/DT` and `TABL/DS`
  respectively. Typed responses also drop `adtcore:description` and
  `adtcore:packageName` — every untyped capture this repo holds (812, 824,
  825, 836) carries `packageName` on every row and a description wherever
  the object has one, but the two typed captures above carry neither. And a
  type-filtered `abap_search {"query":"ZTMD_*","type":"ENHS/XS"}` has been
  observed to omit `ZTMD_ES_HW17`, a match the strictly narrower
  `{"query":"ZTMD_ES_*","type":"ENHS/XS"}` returns, with no marker of any
  kind in the response. We did not establish the server-side
  mechanism — only that the row was never sent. Because of this,
  `abap_search mode=objects` (`src/tools/search.ts`) never sends
  `objectType`: it always asks quickSearch untyped, widening the fetch
  window when the caller gave a `type` (`max * 10`, capped at 1000 — wire-
  verified honoured by captures `827-p0c-quicksearch-cl-star-max1000` and
  `828-p0c-quicksearch-cl-star-max5000`), and filters by type locally. If
  that widened window comes back full, the response discloses it in the
  body itself (a `--- TRUNCATED ---` line, not just a note) rather than
  presenting the list as complete. Because `objectType` is never
  sent, the server no longer sees `type` at all and so no longer rejects
  one that does not exist. `abap_search` therefore validates `type` itself,
  before the call, and refuses an unrecognised value with `BAD_INPUT`
  naming the accepted values. Previously that typo came back
  as an ADT `ExceptionInvalidData`; without the local check it would have
  come back as an ordinary empty result set, which is worse. The check is
  on the type GROUP, not on exact registry membership: a sub-type
  `src/adt/types.ts` does not list is accepted when its group is listed
  (`ENHS/XB` is accepted, `ANY` is not), because honouring an unlisted
  sub-type is the point of the local filter above.

- **`objectType=FUGR` narrows to function groups, not to "everything filed
  under FUGR".** Captures `847-i64-quicksearch-fm-objecttype-fugr` (query
  `BUP_ROLES_GET_ALL`, `objectType=FUGR`) comes back empty, while
  `849-i64-quicksearch-group-objecttype-fugr` (query `BUDA`, the module's own
  function group, same `objectType=FUGR`) finds it as `FUGR/F`; the untyped
  `846-i64-quicksearch-fm-untyped` finds the module itself. So `FUGR` selects
  function GROUPS only. `objectType=FUGR/FF` does return the module
  (`848-i64-quicksearch-fm-objecttype-fugrff`), narrowing the claim in the
  bullet above: that capture carries `adtcore:packageName` and drops only
  `adtcore:description`, unlike the older typed captures 818/819, which drop
  both — the captures don't say why, only that FUGR/FF differs from TABL
  here. `objectType=FUGR/I` was observed to match nothing at all. Because of
  this, `searchExact` in `src/adt/resolve.ts` sends no `objectType` for a
  type whose spec has a `parentPath` (`FUGR/FF`, `FUGR/I`) and filters by
  type locally instead — which is also what lets `abap_read
  {"type":"FUGR/FF","object":"BUP_ROLES_GET_ALL"}` recover the group from
  `adtcore:uri` on an untyped hit. Separately, capture
  `850-i64-quicksearch-generated-fm-missing` (query `ENQUEUE_E_TABLE`,
  untyped) comes back empty even though
  `851-i64-fmodule-generated-read-200` reads that same module at
  `/sap/bc/adt/functions/groups/etable/fmodules/enqueue_e_table` with a plain
  200: quickSearch does not index generated function modules at all, so a
  search miss for a `FUGR/FF` name is not proof of absence — the reason
  `src/adt/write-verify.ts` keeps `FUGR/FF` in its search-blind set.

- **`mode=source` has no ADT endpoint to sit on, and that shapes its
  limits.** ADT offers no full-text search over source, so the scan
  (`src/adt/source-scan.ts`, dispatched through the built-in `scan` fluid
  tool in `src/adt/fluid/builtin/scan.ts`) reads TADIR for the object scope,
  resolves each object's includes, `READ REPORT`s them, and matches lines
  with `FIND ... PCRE` — one call per scope, not a server-side index. A
  scope is mandatory (`packages` and/or an `objects` pattern narrower than
  `*`); an unscoped, repository-wide call is refused `BAD_INPUT` rather than
  attempted and left to time out. A fixed ceiling of 200 objects applies
  even within a valid scope, and the response discloses the scope's real
  object count so a scope that exceeds the ceiling is visible, not silently
  truncated. Excluding comments (`include_comments=false`, the default) is a
  per-line heuristic (`code_part()` in the generated ABAP) — it drops a
  full-line `*`/`"` comment and cuts a line at the first `"` outside a
  quoted literal — not a real tokenizer; a `"` inside a `|...|` string
  template is its known blind spot, and DDLS/CDS source is always matched
  in full text because CDS comments are not ABAP comments. The scan is a
  separate fluid tool (`scan`) rather than a fourth action on
  `ZCL_ZMCP_FLUID_CORE` specifically because `FIND ... PCRE` needs kernel
  7.55+; isolating it means a pre-7.55 system loses only `scan`, not
  `core.select`/`describe_fm`/`call_fm`. It also needs the fluid API
  (`ABAP_FLUID_API` on, `ABAP_MODE` not `read`), unlike `mode=objects` and
  `mode=where_used`, which stay pure reads; without the fluid API the call
  refuses with `FLUID_API_DISABLED` rather than the mode disappearing from
  the tool list. Evidence is mixed: the scan's ABAP mechanics (include
  resolution, function-group include naming, DDLS retrieval, the TADIR/TDEVC
  queries, `FIND ... PCRE` matching) were verified live on A4H (2026-09-12)
  via a standalone probe class, but the end-to-end `abap_search mode=source`
  MCP call has not been exercised against a live system — the reference
  system runs a released bundle that predates this feature — so that path
  is covered only by tests against a fake fluid runtime.

- **`abap-adt-api`'s `usageReferences` parser reads a hardcoded, wrong-case
  namespace prefix, and A4H never sends that case.** The vendor library's
  parser looks for the capitalised path `usageReferences:referencedObject`
  and does not strip or case-fold namespace prefixes before matching; A4H
  sends `usagereferences:` (lowercase) throughout its `usageReferences`
  response, confirmed in the raw wire bytes of captures 961 and 973. Left
  as-is, every caller going through the vendor parser gets zero results
  back from a system that actually has some. This was live-confirmed again
  on 2026-09-15: `abap_search
  {"query":"ZCL_I105_LEAF","mode":"where_used","type":"CLAS"}` answered
  `referencesTotal: 0`, while capture 973's own wire bytes — the exact
  response that call received — carry `numberOfResults="2"` in plain sight.
  `element-info.ts` already worked around this locally for
  `view="definition"`'s IMPLEMENTED BY section; `whereUsed` in
  `src/tools/search.ts` had not, and now goes through the same
  `fetchUsageReferences` helper `element-info.ts` uses, so there is one
  parsing path instead of two. What this does **not** establish: whether
  other ABAP systems send the capitalised prefix the vendor library
  expects — only A4H was observed, and only A4H is what every capture above
  is from.

- **`mode=call_graph`'s cost is set by fan-in and depth, not by `max`, and
  its `callees` side is a static parse with real blind spots.** Walking
  `callers` chains `usageReferences` fetches — the same defect and the same
  `fetchUsageReferences` code path documented in the bullet above — so a
  caller-side call graph's cost grows with each node's own fan-in at every
  level of the walk, not with the `max` children-per-node cap. The only
  measured data point for that cost is `CL_ABAP_TYPEDESCR`: about 5,896
  references at roughly 24 seconds wall-clock on A4H (see
  `element-info.ts`'s `HIGH_FAN_IN_REFERENCES`/`SLOW_FETCH_MS` thresholds,
  disclosed in that file's own comment as heuristic round numbers, not a
  fitted cost curve — there is no second measured point to fit one to).
  `callees` is answered a different way: a static text parse of the
  object's own source (`src/adt/call-sites.ts`), not an index and not a
  call graph in the compiler sense. Dynamic dispatch is never resolvable
  from source text alone — `CALL FUNCTION lv_name`, `PERFORM (lv_form)`,
  `SUBMIT (lv_prog)`, and `lo_ref->method( )` (an instance reference call,
  since the variable's static type cannot be read off the call site) all
  become unresolved entries rather than edges; `mode=source` is the tool to
  search for a dynamic target's literal name instead. A `FUGR/FF` callee
  that fails to resolve by name is not proof that function module does not
  exist — quickSearch does not index every generated function module, the
  same limitation captures 850/851 already document above for
  `mode=objects`.
