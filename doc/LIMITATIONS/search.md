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
