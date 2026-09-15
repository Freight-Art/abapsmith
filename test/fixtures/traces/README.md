# ADT abaptraces fixtures

**Live-captured from A4H (SAP_BASIS 754 SP0007 / S4FND 104), client 001, user
DEVELOPER, on 2026-09-15**, via raw `GET`s and one `POST` against
`/sap/bc/adt/runtime/traces/abaptraces`. The traced object was a throwaway
`$TMP` class `ZCL_I77_PROBE` implementing `IF_OO_ADT_CLASSRUN`, which issued
`SELECT * FROM tadir UP TO 200 ROWS` five times, `SELECT SINGLE mandt FROM
t000` three times and `SELECT COUNT(*) FROM dd02l` twice. The class and every
trace run and trace request were deleted from A4H afterwards.

Nothing in these files was reformatted, re-indented or "tidied" — a tidied
capture is no longer a capture. `cp` is the only tool that touched them after
capture, apart from the two substitutions below.

## Two deliberate deviations from byte-for-byte, and why

`scripts/check-no-leaks.mjs` rejects any SAP demo-appliance hostname carrying
the four-letter naming prefix used by SAP's own NPL Developer Edition image,
except the one instance already public in third-party sample code
(`vhcalnplci`), and it rejects any host under SAP's internal corporate
intranet domain except `people.wdf.sap.corp` (SAP's own ADT feed hardcodes
that one). So exactly two substitutions were applied, and nothing else was
changed:

- the appliance hostname in `<trc:host>` → `APPSRV00`
- the SAP-internal intranet host (`intranet` under that same corporate
  domain) inside the `<atom:uri>` of the trace-request authors →
  `example.invalid`

`people.wdf.sap.corp` appears in the trace-run author URIs and is left
verbatim — SAP's own feed hardcodes it and the leak guard exempts it.

## Which files are trimmed, and by how much

Five files are complete responses. Three were cut down because the full
capture is far too large to commit. Trimming removed whole `<trc:…>` elements
from the end only; no element was edited.

- `hitlist-top12.xml` — first 12 of **1161** `<trc:entry>` elements (full body
  790 KB)
- `dbaccesses-trimmed.xml` — 15 of **63** `<trc:dbAccess>` elements (the first
  6, plus every row for TADIR/T000/DD02L) and 5 of **39** `<trc:table>`
  elements (full body 43 KB)
- `statements-calltree-top20.xml` — first 20 of **660** `<trc:statement>`
  elements (full body 616 KB). Its `m:count` attribute still reads `6.6E+2`,
  i.e. the ORIGINAL 660 — the count attribute is not rewritten by the trim,
  and a parser must cope with that scientific-notation literal.

If you add a hand-written file here, say **SYNTHETIC** in a header comment
inside the file itself. None of the eight files below is synthetic.

| file | endpoint | what it proves |
| --- | --- | --- |
| `results-feed-two-runs.xml` | `GET /sap/bc/adt/runtime/traces/abaptraces?user=DEVELOPER` | A two-run feed carrying one aggregated (`aggregationKind="byCallPosition"`) and one non-aggregated run, so the optional `aggregationKind` is exercised both ways. |
| `results-entry-one-run.xml` | `GET …/abaptraces/{id}` | The SAME payload shape delivered as a bare `<atom:entry>` rather than a feed. |
| `requests-feed-one.xml` | `GET …/abaptraces/requests?user=DEVELOPER` | One request, with the TWO `atom:author` elements distinguished only by `trc:role` (`admin` vs `trace`), and `<trc:executions trc:maximal="1" trc:completed="1"/>`: a fully-consumed request is still listed, it does not disappear on its own. |
| `requests-feed-empty.xml` | same GET, after every request was deleted | A feed with no `<atom:entry>` at all. |
| `requests-feed-created.xml` | `POST …/abaptraces/requests` | The create call answers with a request feed, not a bare id. |
| `hitlist-top12.xml` | `GET …/{id}/hitlist?withSystemEvents=false` | Already sorted by net time descending (`@topDownIndex` 1..n); `@dbAccessAnchor` cross-links a row to a `dbAccess` index; `<trc:callingProgram>` appears both with `adtcore:uri`/`type`/`name` and, for SAP framework code, with only `objectReferenceQuery`. |
| `dbaccesses-trimmed.xml` | `GET …/{id}/dbAccesses?withSystemEvents=false` | Table, statement kind, counts and times per access; includes the kernel pseudo-row whose `tableName` is the XML-escaped `<DB Access from Kernel>`; and `<trc:table>` rows carrying BOTH `type="TRANSP"` (the DDIC table class) and `adtcore:type="TABL/DT"`, which is why a parser here must not strip namespace prefixes. |
| `statements-calltree-top20.xml` | `GET …/{id}/statements` with `Accept: application/vnd.sap.adt.runtime.traces.abaptraces.aggcalltree+xml, application/xml` | The call tree, `callLevel` giving depth and `callerId` the parent. This endpoint is only available for a trace created with `aggregate=false`: for an aggregated trace the same GET returns HTTP 400 with `com.sap.adt.communicationFramework.subType: invalidRequestForAggregatedTraces`. |

None of these eight files is synthetic.
