# Data Access and Credentials

## The data-preview deny-list is not a security control

`abap_data_preview` ships with a frozen deny-list of about seventy rules in four
categories: credentials and security tables (`USR02`, `USRPWDHISTORY`, `RFCDES`,
`RSECTAB`, `DEVACCESS`, `DBTABLOG`), payroll and HR (`PA0`…`PA9`, `PB0`…`PB9`,
`PCL1`…`PCL5`, `HRP*`, `PTRV*`, `HRPY_RGDIR`), accounting documents (`ACDOCA`,
`BKPF`, `BSEG`, the `BS*` open/cleared item tables, `REGUH`, `REGUP`, `PAYR`,
`BNKA`), and personal data (`ADR*`, `BUT*`, `KNA1`, `LFA1`, bank-detail tables,
`USER_ADDR`).

`ABAP_DATA_PREVIEW_DENY_TABLES` is **additive only**. There is no code path that
removes a default entry, and none may be added.

**It fails open, which inverts every other list in this file.** Every other
allowlist here fails closed — empty means nothing is permitted. This is a
deny-list, so anything not named is readable: the roughly ninety thousand tables
not listed, every `Z*` copy of payroll data, and any DDIC or CDS **view** over a
denied table, which has a different name and reads the same bytes.

The real boundary is the technical user's `S_TABU_DIS` / `S_TABU_NAM`
authorisations. The deny-list is a supplement to the two controls that actually
bound this feature — off by default, and the row ceiling. Do not present it to
anyone as a security control.

The structured `where`/`columns`/`order_by`/`distinct` filter on
`abap_data_preview` does not widen this boundary. A filtered read reaches the
same entity through the same technical user under the same `S_TABU_DIS` /
`S_TABU_NAM` authorisations as an unfiltered one — a filter only narrows
which rows of an already-readable entity come back, it does not unlock a
table the user could not otherwise read. What does change is mechanism: a
filtered read compiles an Open SQL statement instead of naming an entity by
itself, so the safety-relevant property shifts to how that statement is
built — every field identifier in it comes from the server's own
column-metadata probe (see `doc/TOOLS/diagnostics.md`), and every value is
rendered as a typed literal, never caller text pasted into the statement.
No caller-supplied text reaches the compiled statement unescaped. The
deny-list, the productive-system refusal, and the row ceiling all still run
before any request goes out, filtered or not.

### Deliberate non-entries

Recorded so nobody "fixes" them later:

- **Bare `PA` / `PB` prefixes are not used.** They would block `PAT01` and
  `PAT03` (SPAM/SAINT patch tables), which developers read routinely. Hence the
  digit-anchored split.
- **`T5*` is not blocked.** It is thousands of HR *customizing* tables — wage-type
  valuation, payroll periods — which are configuration, not personal data, and
  are read constantly during development.
- **`CDHDR` / `CDPOS` are not blocked.** Change documents do carry old and new
  field values, but "who changed this and when" is one of the most common
  legitimate debugging questions on the platform. This is a known gap, not a
  silent omission. `core.change_docs` (`abap_fluid`) closes half of it at the
  position level: it judges `CDHDR`/`CDPOS` themselves before reading, then
  judges every table a returned `CDPOS` row actually names — a change
  document naming a denied table still appears, but that position is
  dropped and counted, never shown (`applyPositionPolicy`,
  `src/adt/change-docs.ts`). That per-referenced-table pass exists only in
  `core.change_docs`. A plain `abap_data_preview` read of `CDPOS` itself is
  unaffected by it and remains an unfiltered read of `CDPOS`'s own columns
  (including its old/new value fields) — `CDHDR`/`CDPOS` are still not on
  the deny-list, and reading them directly still is not blocked.
- **`USR` as a prefix was rejected** in favour of exact `USR*` entries: an exact
  list is auditable, a prefix's blast radius is not.

Matching is upper-cased and judges two strings — the whole name and the segment
after the last `/`. Without the second, `/ACME/PA0008` sails past the `PA0`
prefix and the list fails open on every namespaced copy of an infotype.

## Catalog reads (SUSO/B, TABL/DI) do not go through the deny-list gate

`abap_read {"object":"<NAME>","type":"SUSO/B"}` and
`abap_read {"object":"<TABLE>/<INDEX>","type":"TABL/DI"}` read DDIC catalog
tables — `TOBJ`, `TOBJT`, `TOBCT`, `TACTZ`, `TACTT`, `AUTHX`, `DD04L`,
`DD07V` for `SUSO/B`; `DD12V`, `DD17S` for `TABL/DI` — through the same
freestyle data-preview wire endpoint `abap_data_preview` uses, but neither
calls `safety.assertDataPreview`, the gate this file describes above, and
neither consults `ABAP_DATA_PREVIEW_DENY_TABLES`. This is deliberate, not an
oversight, and the reasoning is not new: `src/adt/catalog-select.ts`
(`runCatalogSelect`, the SQL builder both reads share) states it directly —
`assertDataPreview`'s gate exists for `abap_data_preview`, which hands a
caller-named table's first N rows straight through with no filter at all
and denies a built-in list of tables carrying credentials, payroll and
financial-document business data. Every table these two catalog reads touch
is repository or authorization-CONCEPT metadata, read with a validated,
targeted `WHERE` assembled server-side, never a caller-named table dumped
wholesale. It is the same distinction `src/adt/img-read.ts` already draws
for the IMG catalog (`src/tools/img.ts`'s `runImgReadTool` calls only
`safety.assert("read")`, never `assertDataPreview`, for exactly this
reason) — this mirrors that decision rather than inventing a new one. Both
reads deploy nothing and write nothing, so both run under `ABAP_MODE=read`.

## SUSO/B renders a definition, never who holds it

`abap_read {"object":"S_TABU_NAM","type":"SUSO/B"}` renders an
authorization object's DEFINITION from the catalog tables above — its
class, text, fields (each with its data element and check table), fixed
values, and permitted activities. It is not, and cannot be turned into, a
list of who holds the object:

- abapsmith never reads an `AGR_*` (role) or `UST*` (user authorization)
  table, through this render or through any other tool. No parameter or
  option changes this.
- There is no write support for `SUSO/B`, and none is planned. `SU21`, a
  SAPGUI transaction outside abapsmith's reach, is the only way to create or
  change an authorization object.

See [doc/LIMITATIONS/editing.md](../LIMITATIONS/editing.md) for the write
side of this boundary and [doc/TOOLS/read-and-search.md](../TOOLS/read-and-search.md)
for the read's parameters and response shape.

## Credentials and lockout

- The password is never logged, never echoed in an error, and never included in
  a tool response.
- **A 401 trips a process-wide circuit breaker on the first failure** and is
  never retried. A retry loop against a stale password locks the SAP user;
  `login/fails_to_user_lock` commonly defaults to 5. The trip is also written
  to `auth-latch.json` under `ABAP_STATE_DIR`, so that N terminals cannot each
  spend a logon attempt against that counter — which means a restart does not
  clear it: a fresh process replays the file and re-latches. That durable entry
  expires on its own 15 minutes after the first failure; deleting the file
  clears it for every terminal at once.
- There are no lock or unlock tools. No agent can leave you clearing SM12 by
  hand.
- The debugger can read variables but exposes no surface for writing one.

## What this is not

- **Not a substitute for SAP authorisations.** Everything above constrains what
  this server will attempt. What it can actually do is bounded by the technical
  user's profile. Give that user the least privilege that works, on a system you
  would not mind an agent making mistakes on.
- **Not an audit log.** The write journal records what this server did, locally,
  for undo. It is not tamper-evident and it does not see changes made by anyone
  else.
- **Not a sandbox.** `abap_run`, `abap_test` and `abap_bopf_test` execute real
  ABAP on the target system with the technical user's rights. `abap_bopf_test`
  writes real rows.
- **Not protection against a productive system you misconfigured into
  `nonproductive`.** Detection reads what the system reports about itself.

See also [doc/CONFIGURATION/](../CONFIGURATION/README.md) for every setting
named here, and [doc/LIMITATIONS/](../LIMITATIONS/README.md) for what is
unproven or unimplemented.
