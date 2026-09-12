# abap_atc

Run ABAP Test Cockpit (ATC) static analysis over one object, several
objects, or a whole package, and return the findings: severity, source
line, which check fired, and its message.

**Availability**: gated per call as an `execute` operation (so
`ABAP_ALLOW_PACKAGES` and `ABAP_ALLOW_NAME_PREFIXES` apply) once
`canWrite` is on. Without `canWrite`, a read-only v1 server does not run
the real tool — instead it registers a mode-locked refusal stub under the
same name (case 4 in
[availability-and-capabilities.md](availability-and-capabilities.md)):
still listed, empty schema, refuses every call `READ_ONLY` without
reaching SAP. See "Why an ATC run is gated as a write" below — the reason
is not that ATC changes your code, because it does not.

## Parameters

`op` picks one of three operations; which other keys apply depends on it.
Passing a key `op` does not use is refused `BAD_INPUT` rather than silently
ignored.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `op` | enum `run` \| `variants` \| `delete_worklist` | no | `run` | Which operation to perform. |
| `object` | string | for `op=run`, one of `object`/`objects`/`package` | — | Single object to check. `op=run` only. |
| `objects` | string[] | for `op=run`, one of `object`/`objects`/`package` | — | Several objects to check in one run. `op=run` only. Max 50. |
| `package` | string | for `op=run`, one of `object`/`objects`/`package` | — | Package to check. `op=run` only. |
| `include_subpackages` | boolean | no | `false` | With `package`, also check its subpackages. Only valid together with `package`. |
| `type` | string | no | — | ADT type hint, e.g. `CLAS/OC`, when ambiguous. `op=run` only. |
| `variant` | string | no | system check variant | ATC check variant to run. `op=run` only. |
| `max_findings` | integer | no | `100` | ATC's `maximumVerdicts`. Clamped to 1..500. `op=run` only. |
| `include_exempted` | boolean | no | `false` | Include findings someone has already exempted. `op=run` only. |
| `severity` | enum `error` \| `warning` \| `info` | no | `info` | Lowest severity to report, cumulative. Filters the REPORT only — ATC still runs every check in the variant. `op=run` only. |
| `auto_cleanup` | boolean | no | `false` | Attempt to delete the worklist after reading findings. `op=run` only. On this server this is a documented refusal, not a guarantee — see "Worklists persist" below. |
| `worklist_id` | string | required for `op=delete_worklist` | — | Worklist id to delete. Only valid with `op=delete_worklist`. |

`max_findings` is sent to ADT as `maximumVerdicts`, but observed live during
issue #78 (a ~77-class package run, not itself saved as a fixture) it did
not cap the result on this release: a run sent with `maximumVerdicts="100"`
still came back with 677 findings in the worklist, and
`atcworklist:objectSetIsComplete` stayed `"true"` rather than flipping to
flag an incomplete result. Do not rely on `max_findings` to bound a large
run's output — the response's own `maxChars` truncation is what actually
does that.

Mutual-exclusion rules for `op=run`: exactly one of `object`, `objects`,
`package` — zero or more than one is `BAD_INPUT`. `include_subpackages` is
`BAD_INPUT` without `package`. `objects` must be non-empty and at most 50
entries. `op=variants` takes no key beyond `op` itself — it is a bare
repository search with nothing to shape. `op=delete_worklist` takes only
`worklist_id`.

## What this is actually worth

Nothing here computes anything SAP does not already compute — ATC ships with
the system, it is free, and every ABAP developer already has it in ADT. The
one thing this adds is that **it runs without an IDE**: SAP's ATC integration
is otherwise reachable only while an Eclipse session is open, so CI, a
pre-commit hook and an unattended agent have no other way in. That is the
entire proposition.

## One tool, not ten

ATC's ADT surface covers worklists, runs, exemption proposals, exemption
requests, contact persons, documentation and user lookup; SAP's own MCP
server exposes roughly one tool per endpoint. This exposes one, which does
the whole loop across three operations. Exemption management in particular
is deliberately absent: an agent that can request an ATC exemption is an
agent that can silence a finding instead of fixing it.

## Operations

**`op=run`** (default) — resolve the scope, run the checks, return
findings.

```json
{ "object": "ZCL_MY_CLASS" }
```

```json
{ "objects": ["ZCL_ONE", "ZCL_TWO", "Z_MY_REPORT"] }
```

```json
{ "package": "Z_MY_PACKAGE", "include_subpackages": true }
```

Every target — the one `object`, every element of `objects`, or every
package the `include_subpackages` walk discovers — is resolved and
authorized as `execute` separately; nothing is authorized by proxy for a
sibling. A `package` run without `include_subpackages` checks only objects
directly in that package (client-side `nodeContents("DEVC/K", …)` walk, not
a server-side recursive check — see "Wire protocol" below for what that
walk has and has not been exercised against).

**`op=variants`** — list this system's ATC check variants.

```json
{ "op": "variants" }
```

Returns a NAME/DESCRIPTION/PACKAGE table, in the server's own order, plus a
DEFAULT column when the system's ATC customizing default could be read (see
"Reading the result" below). No object-level `execute` assert happens here
— listing variants touches and creates nothing, and the tool is registered
only under `ABAP_MODE=edit|admin` in the first place.

**`op=delete_worklist`** — attempt to delete one worklist by id.

```json
{ "op": "delete_worklist", "worklist_id": "466F46C806601FE1ABD8175DD6788069" }
```

This is a real DELETE attempt, not a no-op. On this SAP release it always
comes back refused:

```
worklist: 466F46C806601FE1ABD8175DD6788069
deleted: false
status: 405
cache_cleared: false

Worklist 466F46C806601FE1ABD8175DD6788069 was NOT deleted — the server
refused (HTTP 405): ExceptionMethodNotSupported: Resource controller does
not support method DELETE. This client kept its cached worklist id, so the
next run reuses this same, still-undeleted worklist.
```

A release that does support DELETE would just work through the same call
and return `deleted: true`.

## Reading the result

- **A clean result is clean FOR THAT VARIANT**, not a statement that the
  object is correct. A different variant runs different checks, and the
  response says so on every empty result.
- **`INCOMPLETE:`** means ATC stopped early, normally at the `max_findings`
  cap. There are more findings than are listed. This is not a clean result.
- **`UNSCOPED:`** means the server named no `LAST_RUN` object set for the
  worklist, so the findings are the WHOLE worklist and may include an earlier
  run's results against source that has since changed. Treat line numbers
  with suspicion when you see it.
- **A run over more than one object groups the findings by object**, one
  block per object with its own count and table, instead of one flat table —
  triggered by more than one target, or defensively by findings that
  themselves name more than one object (e.g. an unscoped read spanning
  earlier runs). A single-object run keeps the flat table.
- **The FIX column** appears only when at least one shown finding advertises
  a quick fix; when it appears, `manual`/`automatic`/`pseudo`/`ai` marks
  which kind(s) ATC advertises for that finding (only `automatic` applies
  without review) — pass the finding to `abap_quick_fix` to inspect or apply
  it. When no shown finding advertises a fix at all, the response says so
  explicitly instead of adding an empty column: `abap_quick_fix` has nothing
  to apply. Do not confuse this with each finding's separate
  `quickfixInfo` token used by `abap_quick_fix` internally — a different,
  always-present pairing concept.
- **A `DOCS` section** lists each distinct check's documentation link, one
  line per check id, when the server sent one.
- **A package-scoped or 10+-object run carries a TIMEOUT RISK note.** ATC
  runs synchronously; a large scope can exceed `ABAP_TIMEOUT_MS` (default
  60000ms) before the server finishes. If the call times out, the worklist
  it created still exists on the server (see below) and a retry reuses it
  rather than losing the run. Raise `ABAP_TIMEOUT_MS` for package-scoped
  runs.
- **If a run actually exceeds `ABAP_TIMEOUT_MS` before the server answers**,
  the call fails with an `ADT_ERROR` whose message names the configured
  `ABAP_TIMEOUT_MS=<value>` alongside the raw transport timeout, instead of
  the bare, unclassified "timeout of N ms exceeded" this used to surface.
  Its hint is explicit about what is and is not known: it is unknown whether
  the run finished on the server, but the worklist it posted to persists
  (this server cannot delete ATC worklists) and accumulates findings across
  every run made into it, so a later call over the same scope and check
  variant reuses that same worklist and will include anything the timed-out
  run did manage to record. The hint suggests raising `ABAP_TIMEOUT_MS`, or
  narrowing the scope — fewer `objects`, a `types` filter, or a smaller
  package — so the run finishes inside the current timeout.
- **A caller-named `variant` is used UNVALIDATED only when this client could
  not read the check-variant list to confirm it exists** — the note then
  names the variant and states the reason the list read failed (e.g. a
  transport error), not "we didn't check." When the list read succeeds, an
  unknown variant name is refused `BAD_INPUT` before any run happens; the
  server itself does not reject an unknown variant at worklist creation (it
  creates a real worklist for one anyway), so this client validates instead.
- Every response names the worklist id it used and whether it created or
  reused it, and — when `auto_cleanup` was set — whether the delete attempt
  succeeded. See "Worklists persist" below.
- `op=variants` marks one row `DEFAULT` when this system's ATC customizing
  names a default check variant (a separate GET, cached per connection, that
  the `op=run` default-variant path already performs); if that customizing
  read fails, the listing still renders — nothing is marked DEFAULT, and the
  note says why.

## Why an ATC run is gated as a write

Because it leaves state behind. ATC has no stateless "check this and tell me"
endpoint: findings live in a **worklist**, a persistent server-side row
created by its own POST. So the run is classified `execute`, which also
carries the package-allowlist and name-prefix rules — without them this tool
could aim unbounded server-side check work at SAP-standard packages on a
system the operator scoped this server away from. The honest cost: **a
read-only deployment cannot run ATC at all** — headless CI needs
`ABAP_MODE=edit` and an allowlisted package.

## Worklists persist — the server refuses to delete them, this client does not choose not to try

A `DELETE` on the worklist resource IS attempted, both directly
(`op=delete_worklist`) and via `auto_cleanup` after a run's findings are
read. On this release SAP's server answers **405**
`ExceptionMethodNotSupported`, "Resource controller does not support method
DELETE", for every attempt. ADT discovery also advertises a
`?action=deleteFindings` action on the worklist resource; this client
deliberately never calls it, because it is a documented no-op rather than a
working cleanup path — server-side, `CL_SATC_ADT_RES_WORKLIST->post`
returns immediately for a URI carrying a worklist id, and the
`lcl_handler_delete_findings` implementation in its CCIMP include is
commented out in its entirety on this release. Calling an action known to
do nothing would be pretending to clean up.

So on this release, worklists genuinely accumulate and nothing here can
remove them. To limit the litter, the worklist id is cached **per
connection and per check variant**: a long-lived session creates ONE
worklist per variant however many objects it checks. A **failed** delete
(the normal case here) deliberately KEEPS the cached id, so the next run
reuses the same still-undeleted worklist instead of minting a new one every
time; only a **successful** delete forgets the cached id, so the next run
creates a fresh one. `runAtcCheck`'s cleanup step always runs AFTER
findings have been read, so a refusal never loses a run's results.

## Wire protocol: what is grounded and what is inferred

**Two rounds of live capture back this tool.** The first, against A4H on
2026-08-01, ran one object (a `$TMP` PROG, `ZMCP_ATC_PROBE2`, seeded with a
`BREAK-POINT` statement so the run had a real SLIN finding), kept as
`test/fixtures/live-captured/438-atc2-run.xml` (the run acknowledgement) and
`439-atc2-worklist-read.xml` (the worklist read). The second, against the
same appliance on 2026-09-12 for issue #78, added eight more captures
(`886`–`893`) covering check-variant discovery, a two-package run, worklist
reads after several runs have accumulated, a zero-findings read, a second
check variant, and both worklist-delete paths. Nine of the ten are replayed
in the test suite (`test/atc-xml.test.ts`, `test/atc-query.test.ts`,
`test/atc.test.ts`, `test/tools-atc.test.ts`), not just narrated in docs;
the tenth, `892` (the `?action=deleteFindings` no-op), is recorded as
evidence of that no-op but has no code path to exercise it, since this
client never calls that action — see "Worklists persist" above.

Grounded in a live capture — confirmed against real bytes, not just inferred
from library source:

- the run POST really is **synchronous**: `438`'s captured response came
  back ~13s after the request with full worklist contents embedded, no
  polling; `887`'s two-package run took 23s on a re-run, and a separate,
  uncaptured run of one ~77-class package took 134s;
- `worklistId` / `worklistTimestamp` and `<info>` are child ELEMENTS, not
  attributes, on the run acknowledgement (`438`);
- the worklist read's `usedObjectSet` / `objectSetIsComplete` are attributes
  on `<worklist>`, and finding/object attribute names match the parser
  (`438`/`439`);
- `<info>` CAN repeat: `438`'s run acknowledgement carries two
  byte-identical `<info type="FINDING_STATS">0,1,0</info>` nodes;
- **a single `objectSet` accepts more than one object reference, and a
  PACKAGE reference is accepted by the synchronous run body** even though
  the underlying `SATC_RUN_REQ` simple transformation has no package field
  of its own (`887`: two package URIs in one run request, reproduced
  byte-for-byte in `test/atc-query.test.ts`);
- **a worklist read can be scoped by `usedObjectSet` to a numeric
  `LAST_RUN` id**, and the response's own echoed `usedObjectSet` attribute —
  not the request parameter — is what a caller should trust as authoritative
  (`888`);
- **a worklist accumulates object sets across runs rather than replacing
  them**: `888` and `889` both show three accumulated `PACKAGE`-kind sets
  registered alongside `ALL` and `LAST_RUN`, one per package ever run into
  that worklist;
- **`worklistTimestamp` is genuinely optional on the wire**, not just
  omittable in some encoding: `888`'s `<atcworklist:worklist>` element
  carries no timestamp attribute at all;
- **a zero-findings run reads back as a clean shape, not an error**: `889`
  (a TABL target) returns HTTP 200 with empty `objects`/`infos` lists;
- **a different check variant genuinely changes the result set**, not just
  its label: `890` reads 5 findings for the same object (`PROG Z_TMP_DEL`)
  under `ABAP_CLOUD_READINESS`; the capture's own sidecar note records 7
  findings for that same object under the system default
  `ZABAP_CLOUD_DEVELOPMENT`, an observation rather than a separate capture;
- **the check-variant listing** comes from a repository `quickSearch`
  (`objectType=CHKV`), not a dedicated ATC collection — a plain GET on
  `/sap/bc/adt/atc/checkvariants` answers 400 `uriMappingError` on this
  release. `886` records the exact URL (parameter order included) and all
  19 real variant names/descriptions on this appliance;
- **the server does not reject an unknown check-variant name at worklist
  creation** — `POST …/worklists?checkVariant=<nonsense>` answers 200 and
  creates a real worklist anyway, so this client validates a caller-supplied
  variant against the `886` listing itself before ever using it (observed
  live while producing the `886`–`893` set; this specific nonsense-variant
  probe was not itself saved as a fixture);
- **`DELETE` on a worklist resource answers 405**, `ExceptionMethodNotSupported`
  ("Resource controller does not support method DELETE",
  `T100KEY-ID SADT_RESOURCE`, `T100KEY-NO 010`, `T100KEY-V1 DELETE`) — `891`.
  A `PUT` on the same resource also answered 405 but that attempt was not
  itself captured;
- **the advertised `?action=deleteFindings` action is a no-op**: `892`
  answers 200 with a zero-byte body, and the worklist's findings are
  unchanged afterward — traced to a commented-out CCIMP handler on this
  release, not just observed as a black box;
- **this system's ATC customizing names a default check variant**,
  `ZABAP_CLOUD_DEVELOPMENT` — `893`, the first captured customizing
  document (prior parser tests for this shape were synthetic);
- **every `quickfixes` flag observed so far reads `false`**: `888` shows 29
  findings each carrying a full `manual`/`automatic`/`pseudo`/`aiBasedQF`/
  `ai_enabled` block, every flag false — a statement about these particular
  findings on this system, not proof the flags are never true elsewhere (see
  inferred list below).

Also grounded in `abap-adt-api` v8.4.1's ATC client source
(`build/api/atc.js` and the io-ts decoders in `atc.d.ts`), for the parts no
live capture exercised:

- the four paths and their `Accept` headers, including the inconsistent
  `application/atc.worklist.v1+xml` (no `vnd.sap.`) for the worklist read;
- the `<atc:run>` request body's shape, reproduced byte-for-byte including
  its tab indentation (the `438` and `887` request bodies both match this).

INFERRED, and what a further live run must settle:

1. **The `objectSet.kind` vocabulary.** `LAST_RUN` and `PACKAGE` are the
   only values observed anywhere in the library or the captures. If a
   release names the last-run set something else, this client falls back to
   the unscoped read and reports `UNSCOPED:` — correct but degraded.
2. **`<info>`'s attribute shape.** Every live capture has only ever shown
   the child-element shape; the attribute shape this parser also reads
   defensively has still never been observed.
3. **That the server accepts back the whole-second timestamp** it round-trips
   through `Date`. Inherited from the library, unverified.
4. **The check-variant name grammar this client enforces before splicing a
   name into a URL** (a leading `/` allowed, otherwise an identifier, max 30
   characters). No observed variant name has violated it — three of `886`'s
   19 real names sit exactly at the 30-character boundary without exceeding it
   — but a legitimate longer or differently-shaped name would show up as a
   `BAD_INPUT` the server would actually have accepted. Still unverified in
   either direction.
5. **Server-side subpackage expansion.** `include_subpackages` is expanded
   client-side (`nodeContents("DEVC/K", …)`, breadth-first, capped at 50
   packages / 8 levels deep) because the synchronous run body has no native
   `includeSubpackages` field — only the separate, poll-based
   `SATC_RUN_REQ_2` API reportedly has one, and that lifecycle is out of
   scope here. A4H has no customer package with subpackages to exercise the
   recursive walk against, so it is proven only against `$TMP` (which also
   has none, so it returns just the root) and hand-written fakes in the test
   suite.
6. **A run that hits `max_findings`.** Partly settled, partly contradicted.
   Observed live (not itself saved as a fixture): a run sent with
   `maximumVerdicts="100"` came back with 677 findings and
   `atcworklist:objectSetIsComplete` still `"true"` — on this release the
   server does not honour `maximumVerdicts` as a cap, and did not flag that
   result as incomplete. Still genuinely unobserved: whether
   `objectSetIsComplete` is ever emitted `"false"` at all on this release,
   i.e. any run where `INCOMPLETE:` actually fires against real server
   output.
7. **A DDIC object that actually produces findings has now been observed**
   (not capture-backed): a run over `DDLS/DF` `Z_I78_CDS`, a `$TMP` CDS view
   since deleted, returned 1 error-severity finding, and `INTF/OI` and
   `CLAS/OC` runs were also observed live (empty findings, and 8 findings
   including a `TOOL_FAILURE` note, respectively) — `889`'s TABL target
   remains the only captured zero-findings shape. **A bad object name has
   also been observed** (not capture-backed): the run answered HTTP 200
   with an empty worklist, not an ADT error — so the error path there is
   "no error, just nothing," not a thrown exception. Still unverified: a
   function group target, an authorization failure mid-run, priority values
   outside 1/2/3, a true `quickfixes` flag, a non-empty `exemptionKind`, and
   `objectTypeId`'s presence rule (present on `439`/`800`, absent on
   `888`/`890`, reason unknown).
8. **A successful worklist delete.** Every observed attempt on this release
   refuses with 405; whether `deleted: true`/`cacheCleared: true` actually
   behaves as coded on a release that supports DELETE has never been
   exercised.
