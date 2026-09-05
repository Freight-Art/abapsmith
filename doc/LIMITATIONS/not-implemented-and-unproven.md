# Not Implemented and Unproven

## Not implemented

No runtime tracing, no profiling, no package tree navigation, and no
source-code grep across the repository. `abap_search` searches object names
and where-used, not source text.

ATC exists (`abap_atc`) but only as run-and-collect. Exemption proposals,
exemption requests, contact-person lookup and check documentation are
deliberately absent: an agent that can request an ATC exemption is an agent
that can silence a finding instead of fixing it.

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
a generated `$TMP` classrun calling `TRINT_READ_REQUEST` to find the row(s)
and `TR_DELETE_COMM_OBJECT_KEYS` (`is_e071_delete`, `iv_dialog_flag = space`)
to remove them, then `COMMIT WORK`.

`TR_DELETE_COMM_OBJECT_KEYS` calls `TRINT_DELETE_COMM_OBJECT_KEYS`, which
counts the request's E071 rows matching PGMID+OBJECT+OBJ_NAME — not
qualified by activity or AS4POS — before touching anything: zero rows raises
`n_object_entry_doesnt_exist` (`MESSAGE e101(tr)`), two or more raises
`w_duplicate_entry` (`MESSAGE e292(tr)`), and only the exactly-one case
proceeds. E071's primary key is TRKORR+AS4POS, not object identity, so two
rows for the same object on one request are legal — creating an object and
then deleting it under the same request is enough to record both. Censused
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
clear them.** You get into this by creating an object and then deleting it
under the same transport request as `corr_nr`: CTS keeps both the creation's
E071 row and the deletion's, and `TR_DELETE_COMM_OBJECT_KEYS` refuses to
touch either while both are present (above). The request can then never be
deleted through abapsmith: `abap_transport operation=delete` keeps returning
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
equivalent of `lockobject`'s inverse exists. And the classrun route's guard
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
- **`abap_atc` is partially proven, not "the whole of it is unproven."** A
  live run against A4H (`$TMP` PROG `ZMCP_ATC_PROBE2`, captured 2026-08-01
  during abap_atc's live verification and kept as
  `test/fixtures/live-captured/438-atc2-run.xml` and
  `439-atc2-worklist-read.xml`) exercised the real wire protocol and
  confirmed several things that used to be pure inference: the run POST
  really is **synchronous** (the captured response came back after ~13s with
  full results embedded, no polling involved); `worklistId` /
  `worklistTimestamp` and `<info>` really are child elements, not attributes;
  and the worklist read's finding/object attribute names match the parser.
  That same capture is also live proof of a duplicate-note defect: the
  server's run acknowledgement literally contains two byte-identical
  `<info>` nodes (`type=FINDING_STATS`, `description=0,1,0`), independent
  of whether any fix for it has been verified. `doc/TOOLS/abap-atc.md` lists precisely which parts are now grounded in
  that capture and which remain inferred — the attribute-shape `<info>`
  variant this parser also accepts has still never been observed live, and
  neither has `objectSetIsComplete`'s absence, a DELETE endpoint, or
  behaviour on an object type other than PROG.
- **The debugger is single-session.** One reserved debug lease, one live
  session. Concurrent debugging from two agents is not supported and not tested.
