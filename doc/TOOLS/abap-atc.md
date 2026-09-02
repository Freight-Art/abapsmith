# abap_atc

Run ABAP Test Cockpit (ATC) static analysis on one object and return the
findings: severity, source line, which check fired, and its message.

**Availability**: case 1 — registered only when `canWrite`, and gated per
call as an `execute` operation (so `ABAP_ALLOW_PACKAGES` and
`ABAP_ALLOW_NAME_PREFIXES` apply). A read-only server does not have this tool
at all. See "Why an ATC run is gated as a write" below — the reason is not
that ATC changes your code, because it does not.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `object` | string | yes | — | Object to check. |
| `type` | string | no | — | ADT type hint, e.g. `CLAS/OC`. |
| `variant` | string | no | system check variant | ATC check variant to run. Variants are system-specific SCI objects. |
| `max_findings` | integer | no | `100` | ATC's `maximumVerdicts`. Clamped to 1..500. |
| `include_exempted` | boolean | no | `false` | Include findings someone has already exempted. |
| `severity` | enum `error` \| `warning` \| `info` | no | `info` | Lowest severity to report, cumulative. Filters the REPORT only — ATC still runs every check in the variant. |

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
the whole loop. Exemption management in particular is deliberately absent: an
agent that can request an ATC exemption is an agent that can silence a finding
instead of fixing it.

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
- Every response names the worklist id it used and whether it created or
  reused it — see below.

## Why an ATC run is gated as a write

Because it leaves state behind. ATC has no stateless "check this and tell me"
endpoint: findings live in a **worklist**, a persistent server-side row
created by its own POST. So the run is classified `execute`, which also
carries the package-allowlist and name-prefix rules — without them this tool
could aim unbounded server-side check work at SAP-standard packages on a
system the operator scoped this server away from. The honest cost: **a
read-only deployment cannot run ATC at all** — headless CI needs
`ABAP_MODE=edit` and an allowlisted package.

`abap-adt-api` exposes no delete for a worklist and neither does ADT as far
as anything readable from this client goes. `DELETE
/sap/bc/adt/atc/worklists/{id}` is the obvious guess from the POST/GET pair
and is **deliberately not attempted** — an unverified DELETE against a
resource this client does not understand is an experiment, not a cleanup.
Instead, the worklist id is cached per connection and per check variant, so a
long-lived session creates ONE worklist per variant however many objects it
checks.

## Wire protocol: what is grounded and what is inferred

**Part of this feature has been exercised against a live SAP system,** via a
run captured against A4H on 2026-08-01 (a `$TMP` PROG, `ZMCP_ATC_PROBE2`,
seeded with a `BREAK-POINT` statement so the run had a real SLIN finding to
report) and kept in the repo as
`test/fixtures/live-captured/438-atc2-run.xml` (the run acknowledgement) and
`439-atc2-worklist-read.xml` (the worklist read). That capture is also where
a duplicated `<info>` node in the run acknowledgement comes
from. Beyond that one object/variant/run, the rest of the surface is still
untested live — no DDIC object, no class, no second variant, no
zero-findings run, no error path.

Grounded in the live capture (438/439) — confirmed against real bytes, not
just inferred from library source:

- the run POST really is **synchronous**: the captured response came back
  ~13s after the request with full worklist contents embedded, no polling;
- `worklistId` / `worklistTimestamp` and `<info>` are child ELEMENTS, not
  attributes, on the run acknowledgement;
- the worklist read's `usedObjectSet` / `objectSetIsComplete` are attributes
  on `<worklist>`, and finding/object attribute names match the parser;
- `<info>` CAN repeat: the captured run acknowledgement carries two
  byte-identical `<info type="FINDING_STATS">0,1,0</info>` nodes, which is
  the duplicate-note defect described above.

Also grounded in `abap-adt-api` v8.4.1's ATC client source
(`build/api/atc.js` and the io-ts decoders in `atc.d.ts`), for the parts the
live capture above did not exercise:

- the four paths and their `Accept` headers, including the inconsistent
  `application/atc.worklist.v1+xml` (no `vnd.sap.`) for the worklist read;
- the `<atc:run>` request body's shape, reproduced byte-for-byte including
  its tab indentation (the captured request body matches this).

INFERRED, and what a further live run must settle:

1. **The `objectSet.kind` vocabulary.** `LAST_RUN` is the only value that
   appears anywhere in the library or in the one live capture. If a release
   names the last-run set something else, this client falls back to the
   unscoped read and reports `UNSCOPED:` — correct but degraded.
2. **`<info>`'s attribute shape.** The live capture only ever showed the
   child-element shape; the attribute shape this parser also reads
   defensively has still never been observed.
3. **Which fields are optional beyond what one run showed.** The library's
   decoder marks nearly everything required; this parser treats every field
   as optional and reports missing ones as missing. Only the fields present
   in the 438/439 capture are confirmed present in practice.
4. **That the server accepts back the whole-second timestamp** it round-trips
   through `Date`. Inherited from the library, unverified.
5. **That no DELETE exists.** Unprovable offline. If a live probe finds one,
   the worklist caching becomes an optimisation rather than the litter control
   it currently is.
6. **The check-variant name grammar.** This client refuses anything that is
   not an identifier (a leading `/` is allowed for namespaced names) before
   splicing it into a URL. A legitimate variant name this pattern rejects
   would show up as a `BAD_INPUT` that the server would have accepted.
7. **Behaviour on object types other than PROG**, and on a run that returns
   zero findings, an error, or hits `max_findings`. All still unverified.

