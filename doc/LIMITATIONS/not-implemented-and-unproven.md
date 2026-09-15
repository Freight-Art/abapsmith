# Not Implemented and Unproven

## Not implemented

No package tree navigation.

`abap_trace` now covers ABAP runtime tracing (SAT) and, on the reference
release, SQL tracing folded into it as the `sql_trace` flag rather than as
a standalone resource — see [doc/TOOLS/abap-trace.md](../TOOLS/abap-trace.md).
What remains genuinely unproven: the standalone ADT SQL-trace collection at
`/sap/bc/adt/runtime/traces/sqltraces` does not exist as a resource on the
reference release (a GET answers "does not exist," and ADT discovery there
does not advertise `traces.sqltraces`), so the code path for it is exercised
only against fakes and is never called by this tool — do not read
`sql_trace` as proof that the standalone collection works anywhere. There is
also no profiling beyond what a trace's hit list, database-access view and
call tree already give: no sampling profiler, no aggregate-across-runs view,
and no way to compare two traces against each other.

`abap_search mode=source` now scans source text line by line — see
[doc/TOOLS/read-and-search.md](../TOOLS/read-and-search.md) — but it is
narrower than a plain repository grep in several specific ways. There is no
cross-system search: one call always targets the one connected system.
There is no ranking or scoring of hits — every match is returned in scan
order up to the hit cap, not sorted by relevance. A scope is mandatory
(`packages` and/or an `objects` pattern narrower than `*`); a repository-
wide scan is refused, and even within scope there is a fixed 200-object
ceiling, so a package holding more objects than that is only partially
scanned (the response says how many objects the scope actually holds, so
this is disclosed rather than silent). Excluding comments (the default) is
a per-line heuristic — it drops full-line `*`/`"` comments and cuts a line
at the first `"` outside a quoted literal — not a real ABAP tokenizer; its
known blind spot is a `"` inside a `|...|` string template. The scan runs
as a separate built-in fluid tool (`scan`, not a `core` action) specifically
because its `FIND ... PCRE` matching needs a 7.55-or-later kernel; it is
gated behind the fluid API (`ABAP_FLUID_API` on, `ABAP_MODE` not `read`) and
refuses at call time with `FLUID_API_DISABLED` on a system or session
without that. And the end-to-end `abap_search mode=source` call path is
itself unproven live: the scan's ABAP mechanics were verified on A4H via a
standalone probe class, but the reference system runs a released bundle
that predates this feature, so the MCP tool call itself is covered only by
tests against a fake fluid runtime.

ATC (`abap_atc`) runs and collects: one object, several objects in one call,
or a whole package (optionally with its subpackages, expanded client-side).
It also lists check variants and attempts to delete a worklist by id — a
real DELETE, refused with HTTP 405 on this SAP release, not a client-side
choice never to try. Exemption proposals, exemption requests, contact-person
lookup and check documentation are deliberately absent: an agent that can
request an ATC exemption is an agent that can silence a finding instead of
fixing it. There is still no variant create.

**Removing one locked object entry from a transport request — implemented,
guarded against CTS's own duplicate-entry refusal; unlocking one without
removing it is not.** CTS keeps an object entry locked to its request until
the request is released — deleting the object does not clear the entry, and
the child task refuses the same delete for the same reason: `abap_transport
operation=delete` returns `TRANSPORT_LOCKED` on both. `abap_transport
operation=removeObject` (admin-only ceiling, same as `delete`, plus
`confirm`) drops one such entry's E071 row and CTS lock when the request
holds exactly one E071 row for the object's PGMID+OBJECT+OBJ_NAME. It does
not use ADT's Transport Organizer `removeobject` link (see below) — instead
it reaches CTS's own backend the way `tran-delete`/`view-delete` do, through
the fluid API's persistent body class `ZCL_ZMCP_FLUID_CLASSIC` in
`$ABAPSMITH_FLUID_API`, calling `TRINT_READ_REQUEST` to find the row(s)
and `TR_DELETE_COMM_OBJECT_KEYS` (`is_e071_delete`, `iv_dialog_flag = space`)
to remove them, then `COMMIT WORK`.

`TR_DELETE_COMM_OBJECT_KEYS` calls `TRINT_DELETE_COMM_OBJECT_KEYS`, which
counts the request's E071 rows matching PGMID+OBJECT+OBJ_NAME — not
qualified by activity or AS4POS — before touching anything: zero rows raises
`n_object_entry_doesnt_exist` (`MESSAGE e101(tr)`), two or more raises
`w_duplicate_entry` (`MESSAGE e292(tr)`), and only the exactly-one case
proceeds. E071's primary key is TRKORR+AS4POS, not object identity, so two
rows for the same object on one request are legal, and have been observed
live — but the obvious way to try to produce them does not: on A4H
(2026-09-12), a request holding a create and a delete of the same class held
one E071 row, not two, and `removeObject` succeeded with `removedCount: 1`.
abapsmith does not know what reliably produces duplicate rows. Censused
live on A4H, 2026-09-05: two stuck fixture tasks each turned out
to hold exactly two E071 rows for their object (same pgmid/object/obj_name,
activity blank, lockflag X, differing only by AS4POS), no E071K rows, and
one ordinary TLOCK row (`edtflag = X`) apiece — the row count, not the
object's type, is what CTS refuses on. (A single-row entry removed cleanly
in an earlier run; that row no longer exists to re-inspect, so this is
evidence from that earlier run plus the function module's type-agnostic
counting logic, not a fresh side-by-side reconfirmation.) The bridge now
runs this same count itself before calling the function module, so a
duplicate can't leave one row removed and the next refused mid-batch: the
refusal surfaces as a terminal error code, `CTS_DUPLICATE_ENTRY`, naming the
object, the holder, the row count and the AS4POS values; a late `TR 292`
raised by `TR_DELETE_COMM_OBJECT_KEYS` itself maps to the same code. Any
other refusal from the function module still surfaces its `sy-subrc` and,
when CTS set one, the `sy-msg*` T100 message, as a `msg=` fragment on the
`CHECK_FAILED` error — blank `sy-msg*` variables are expected there too,
since `MESSAGE e292(tr)` carries no WITH operands.

**Duplicate E071 entries for one object: no working function-module route to
clear them.** How a request ends up holding two E071 rows for the same
object is not established. The obvious recipe — create an object, then
delete it under the same transport request as `corr_nr` — was tried live on
A4H on 2026-09-12 and produced one E071 row, not two; `removeObject` removed
it cleanly. When a request does hold two rows for one object,
`TR_DELETE_COMM_OBJECT_KEYS` refuses to touch either while both are present
(above). The request can then never be deleted through abapsmith:
`abap_transport operation=delete` keeps returning
`TRANSPORT_LOCKED`, and `operation=removeObject` now refuses up front with
`CTS_DUPLICATE_ENTRY` instead of attempting a call CTS is going to reject.
No supported function-module route removes just one of the two rows:
`TR_DELETE_COMM_OBJECT_KEYS` has no parameter naming which AS4POS to drop,
the duplicate guard inside `TRINT_DELETE_COMM_OBJECT_KEYS` has no bypass
flag, and `TRINT_DELETE_COMM_KEYS` only touches E071K, never E071. SAP ships
a raw Open SQL `DELETE e071` inside one of its own function modules, but it
is unguarded — no lock,
owner or status check, and no E071K cleanup — and abapsmith will not issue
it. The remedy is outside abapsmith: edit the request's object list in
SE09/SE10 so at most one row remains for the object, then retry
`removeObject`; or release the request, which is irreversible. Neither route
is guaranteed to work under a lock — they are outside what this tool
controls, not a promised fix abapsmith can verify.

Still missing: the ADT `removeobject` link's own verb and body remain
unverified and are not used — a guessed mutating CTS call is not something to
ship. There is still no way to *unlock* an entry without removing it — no
equivalent of `lockobject`'s inverse exists. And the removal route's guard
is generic on pgmid+object+obj_name rather than tied to any one object
type; it has not been exercised against every object type CTS can lock.

Confirmed across the fixtures in `test/fixtures/cts/`: every `tm:abap_object`
carries a `removeobject` link (title "Transport Organizer Remove Locked
Object") and a sibling `lockobject` link — `removeobject`'s href is a bare
`/sap/bc/adt/cts/transportrequests/<TRKORR>`, `lockobject`'s is that plus
`/lockobject`. The TRKORR varies: `transport-details-with-objects.xml` uses
the enclosing task (`A4HK900118`); `transport-details-released.xml` uses the
request (`A4HK900125`) for entries under the request, the task (`A4HK900126`)
for the one under the task. Read the TRKORR off the link itself — never
derive it from the request queried. Missing: the verb and body — no
`objectentries` sub-resource in ADT's discovery document, no entry removal in
abap-adt-api. Establishing that contract would still need live probing of a
mutating CTS call — `operation=removeObject` sidesteps it rather than
resolving it.

The ways to clear such a request now: `abap_transport operation=removeObject`
for one entry at a time (admin mode, irreversible, does not itself prove the
request becomes deletable — follow up with `operation=delete` — and does not
work when the request already holds two or more E071 rows for the object,
see above), release the request (also irreversible), or unlock it by hand in
SAPGUI (SE03 "Unlock Objects (Expert Tool)", then SE09/SE10 to delete — SE03
here clears TLOCK and the lockflag, not E071 rows, so it does not by itself
help the duplicate-row case above). This is a real cost of
ordinary sessions: with
`ABAP_ALLOW_PACKAGES` defaulting to `["*"]`, an ordinary write
auto-creates a request only when it cannot adopt an existing one — a
modifiable workbench request owned by the connected user with an
abapsmith-authored description. Adoption means the population grows
roughly once per release cycle rather than once per session, but an
abandoned request still cannot be cleaned up: this slows accumulation, it
does not fix it.

## Unproven

Stated separately from the above because the risk is different: these paths
exist and may work, but have not been exercised against a real system.

- **Transport release** has only been run against a system with no transport
  route. Behaviour on a landscape with a real route — export, transport logs,
  target-system errors — is untested.
- **`abap_transport` `addUser` and `setOwner`** have unit tests but no captured
  wire behaviour from a live system.
- **The Streamable HTTP transport (`ABAP_MCP_TRANSPORT=http`)** has been
  exercised only over a loopback socket in the offline suite
  (`test/mcp-http-transport.test.ts`), against a fake ADT server. It has
  **not** been run as a shared service next to a real SAP system, nor with
  more than two concurrent MCP sessions, nor with a real MCP client other
  than the SDK's own. See
  [doc/CONFIGURATION/transport.md](../CONFIGURATION/transport.md#not-verified).
- **TLS termination by a reverse proxy** in front of the HTTP transport is
  documented but not exercised — abapsmith never speaks TLS on the server
  side, and no proxy configuration is tested or shipped.
- **No resumability.** The HTTP transport is constructed without an
  `EventStore`, so a dropped SSE stream cannot be resumed with
  `Last-Event-ID`; a client that loses its connection must re-`initialize`.
- **Sessions are in-memory only.** A restart drops every `Mcp-Session-Id`,
  and two `abapsmith` processes behind one load balancer do not share
  sessions — there is no sticky-routing support.
- **DNS-rebinding protection** is available in the underlying SDK transport
  but is not wired to any environment variable here — see
  [doc/SAFETY/remote-transport.md](../SAFETY/remote-transport.md).
- **Bearer tokens (`ABAP_MCP_HTTP_TOKEN`) are static.** No rotation,
  expiry, or revocation short of a restart, and no per-token permission
  scoping.
- **Journal attribution under HTTP records the token NAME**, an
  operator-chosen label — it is not an authenticated identity, and an
  unnamed token records only the MCP client's own name. See
  [doc/JOURNAL/journal-format.md](../JOURNAL/journal-format.md).
- **`abap_service` `op="publish"` and `op="unpublish"`** are no longer in
  this category: both were executed against A4H (client 001,
  `ABAP_MODE=admin`, 2026-09-15) for a V2 binding and a V4 binding, each
  followed by a read confirming the resulting live/not-published state. The
  V2 publish's first attempt timed out at the ADT layer (60000 ms,
  `ADT_ERROR`); the `service-publish` journal entry had already been
  written as pending (fail-closed, before the POST), and a re-read showed
  the binding still unpublished, so the timed-out POST had not landed — the
  immediate retry succeeded. See
  [doc/TOOLS/abap-service.md](../TOOLS/abap-service.md) for the full
  account, including the V4 run (no timeout) and the reserved-namespace
  refusal observed on `/DMO/UI_TRAVEL_U_V2`. (The OData metadata read
  itself was already live-verified for both V2 and V4.) The compensating
  action recorded for a publish is an explicit `abap_service op="unpublish"`
  call, not an undo: `abap_journal mode=undo` refuses a
  `service-publish`/`service-unpublish` entry outright (`irreversible:
  true`) and names that call instead of attempting to reverse it.
- **`abap_atc` is now proven well beyond the single-object case, not just
  "partially proven."** The original live run against A4H (`$TMP` PROG
  `ZMCP_ATC_PROBE2`, captured 2026-08-01, kept as
  `test/fixtures/live-captured/438-atc2-run.xml` and
  `439-atc2-worklist-read.xml`) confirmed the run POST really is
  **synchronous** (the captured response came back after ~13s with full
  results embedded, no polling involved); `worklistId` / `worklistTimestamp`
  and `<info>` really are child elements, not attributes; and the worklist
  read's finding/object attribute names match the parser. That same capture
  is also live proof of a duplicate-note defect: the server's run
  acknowledgement literally contains two byte-identical `<info>` nodes
  (`type=FINDING_STATS`, `description=0,1,0`).

  Eight further captures against the same appliance (2026-09-12, issue #78,
  `852`–`859`) settled most of what was previously unproven: a run against
  more than one package in a single request (`853`, two package references
  in one `objectSet`, 23s); a worklist read after several runs have
  accumulated, including three persisted `PACKAGE`-kind object sets and a
  worklist element with no `timestamp` attribute at all (`854`/`855`); a
  genuine zero-findings clean read (`855`, a TABL target, HTTP 200); a
  second check variant producing a genuinely different result set for the
  same object (`856`, 5 findings versus 7); check-variant discovery and
  validation via repository quickSearch (`852`, all 19 real variant names on
  this appliance); and, most operationally important, **both worklist-delete
  paths are now settled, not merely un-attempted**: a real `DELETE` on a
  worklist answers 405 `ExceptionMethodNotSupported` (`857`), and the
  advertised `?action=deleteFindings` action is a confirmed no-op traced to
  a commented-out server-side handler, not just a black-box 200 (`858`).
  `859` also confirms this system's ATC customizing names a default check
  variant, which `op=variants` now surfaces. `doc/TOOLS/abap-atc.md` lists
  precisely which parts are now grounded in these ten captures and which
  remain inferred — the attribute-shape `<info>` variant this parser also
  accepts has still never been observed live, nor has `objectSetIsComplete`
  ever been observed flipping to `false` (a run sent with
  `maximumVerdicts="100"` was observed coming back with 677 findings and
  `objectSetIsComplete` still `"true"`, so `max_findings` is not honored as
  a cap on this release), server-side subpackage expansion (A4H has no
  customer package with subpackages to exercise it against), a true
  `quickfixes` flag (every one observed so far reads false), a successful
  worklist delete on a release that supports DELETE. Object types observed
  live now include PROG, CLAS, INTF, a zero-findings TABL, and a DDLS view
  that produced one error-severity finding (the last three as uncaptured
  observations, not fixtures); a bad object name was also observed
  live — HTTP 200 with an empty worklist, not an ADT error. Still unproven:
  behaviour on a function group target, or an authorization failure
  mid-run.
- **The debugger's own concurrency cap is now configurable, but SAP's
  per-user exclusivity is not something abapsmith can raise.**
  `ABAP_DEBUG_SESSIONS` (default 1, hard-fails outside `1..4`) lets one
  `abapsmith` process hold more than one concurrent debug lease locally,
  capped from below by `ABAP_DEBUG_DIA_BUDGET` — see
  [doc/CONFIGURATION](../CONFIGURATION/concurrency-and-activation.md). That
  only widens this client's own ceiling. SAP allows exactly one active debug
  listener per SAP user on a system: a second `POST
  .../debugger/listeners` for the same user is refused with
  `409`/`conflictDetected` (T100 `SY 530`, "Another session already exists
  with global debugging scope for user X"), even when the refused request
  carries a different `terminalId` from the holder's — verified live against
  A4H, `test/cassettes/debugger/listener-conflict-409.cassette.json`. So
  raising `ABAP_DEBUG_SESSIONS` above 1 for a single-`ABAP_USER` deployment
  does not enable two concurrent debug sessions; it only moves the refusal
  from this client (a local `SessionBusyError`) to SAP itself (the `409`
  above) once the second lane's listener actually arms. A second lane only
  has a chance of working when it authenticates as a genuinely different
  `ABAP_USER` (two `abapsmith` processes, two different users), which has
  not been demonstrated on this appliance; or once a terminal-scoped
  debugging mode (`debuggingMode: "terminal"`) is proven functional — that
  mode is modelled in this repo but has never been shown to work. Concurrent
  debugging from two agents sharing one SAP user is therefore still not
  possible today, regardless of client-side configuration.
- **`abap_trace`'s standalone SQL-trace path.** The dedicated ADT SQL-trace
  collection (`/sap/bc/adt/runtime/traces/sqltraces`) has code behind it in
  this codebase but has never been run against a real system: the reference
  release does not serve that resource at all (a GET answers "does not
  exist," and its ADT discovery document does not advertise
  `traces.sqltraces`). Only `sql_trace` inside the ABAP-trace parameters,
  which feeds the `db` view of an ordinary trace, is verified live.
