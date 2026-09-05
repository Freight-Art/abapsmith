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
narrowly; unlocking one without removing it is not.** CTS keeps an object
entry locked to its request until the request is released — deleting the
object does not clear the entry, and the child task refuses the same delete
for the same reason: `abap_transport operation=delete` returns
`TRANSPORT_LOCKED` on both. `abap_transport operation=removeObject`
(admin-only ceiling, same as `delete`, plus `confirm`) now drops one such
entry's E071 row(s) and CTS lock. It does not use ADT's Transport Organizer
`removeobject` link (see below) — instead it reaches CTS's own backend the
way `tran-delete`/`view-delete` do, through a generated `$TMP` classrun
calling `TRINT_READ_REQUEST` to find the row and `TR_DELETE_COMM_OBJECT_KEYS`
(`is_e071_delete`, `iv_dialog_flag = space`) to remove it, then
`COMMIT WORK`. This exact route ran live on A4H on 2026-09-04: `sy-subrc = 0`,
the lock cleared, and a subsequent request delete succeeded.

Still missing: the ADT `removeobject` link's own verb and body remain
unverified and are not used — a guessed mutating CTS call is not something to
ship. There is still no way to *unlock* an entry without removing it — no
equivalent of `lockobject`'s inverse exists. And the classrun route has only
been proven live for the one object type removed in the 2026-09-04 run; it
has not been exercised against every object type CTS can lock.

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
request becomes deletable — follow up with `operation=delete`), release the
request (also irreversible), or unlock it by hand in SAPGUI (SE03 "Unlock
Objects (Expert Tool)", then SE09/SE10 to delete). This is a real cost of
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
