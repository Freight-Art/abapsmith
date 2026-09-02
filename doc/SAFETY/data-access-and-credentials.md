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
  silent omission.
- **`USR` as a prefix was rejected** in favour of exact `USR*` entries: an exact
  list is auditable, a prefix's blast radius is not.

Matching is upper-cased and judges two strings — the whole name and the segment
after the last `/`. Without the second, `/ACME/PA0008` sails past the `PA0`
prefix and the list fails open on every namespaced copy of an infotype.

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
