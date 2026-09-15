# Execute & test

Running and unit-testing ABAP objects. For static analysis, see
[abap_atc](abap-atc.md).

## abap_run

Execute a class (via `IF_OO_ADT_CLASSRUN`) or a report, headlessly, and
capture its output.

**Availability**: the real, functional tool needs `canWrite`. Without it,
a read-only v1 server registers a mode-locked refusal stub under the same
name instead of skipping registration (case 4 in
[availability-and-capabilities.md](availability-and-capabilities.md)):
still listed with an empty schema, refuses every call `READ_ONLY` without
reaching SAP.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `object` | string | yes | — | Class or report to run. |
| `mode` | enum `class` \| `report` \| `auto` | no | `auto` | Force one execution style or let the server infer it. |
| `parameters` | array\<object\> | no | — | Report mode only — selection-screen parameters. |
| `auth_trace` | boolean | no | `false` | Switch on the SAP authorization trace for the executing user around this run and read back failed authority checks afterward. See "Authorization trace" below. Never runs in read mode. |

Each `parameters[]` entry: `name` (string, required), `type` (enum `char` \|
`int` \| `packed` \| `date`, optional), `value` (string, optional),
`ranges` (array of `{sign?, option?, low, high?}`, optional; `sign` is `I`/
`E`, `option` is one of `EQ NE GT LT GE LE CP NP BT NB`).

Notes: uses a real write session but leases a **read** slot from the
connection pool — deliberate, since it doesn't hold an ABAP enqueue lock.
Report mode generates a bridge class in `$ABAPSMITH_FLUID_API`, named after
the report being run and rewritten only when its content changes; it
cannot render interactive lists or ALV grids (headless only). Both `class`
and `report` execution deploy a generated bridge, so with
`ABAP_FLUID_API=false` `abap_run` stays registered but refuses at call time
with `FLUID_API_DISABLED` (`deployBridge`, `src/adt/run.ts:1088-1101`). Runs
in a fresh session each time to avoid stale-class caching. The ABAP that runs
here executes under the connected technical user's SAP authorisations:
`ABAP_ALLOW_PACKAGES`, `ABAP_ALLOW_NAME_PREFIXES` and `ABAP_ALLOW_TRANSPORTS`
constrain only the writes this server itself issues, not what executed ABAP
does — see [safety-gate.md](../SAFETY/safety-gate.md).

Example:

```json
{
  "object": "ZCL_DEMO_ORDER",
  "mode": "class"
}
```

### Authorization trace (`auth_trace`)

`auth_trace: true` on `abap_run`, `abap_test` or `abap_bopf_test` wraps the
run: switches SAP's authorization trace (`SUAUTH_SYSTEM_TRACE_FOR_AUTH`) on,
scoped to the connected user, runs the object exactly as it would run
without the flag, reads back the failed authority checks for that user and
time window, and switches the trace back off — on every path, including a
dump inside the run or a session that dies mid-flight. Never runs in read
mode (`ABAP_MODE=read`): switching the trace on is itself a write to the
target system, even though the read-back changes no authorization, role or
profile.

The header always carries an `auth_trace` field, never a silent absence:
`"no failed checks"` when the trace ran clean, or `"unavailable: <reason>"`
when it could not be switched on or read back at all. Either way the run's
own PASSED/FAILED/RESULT verdict is unaffected.

Failed checks render as a `FAILED AUTH CHECKS` section, one line per check,
each ending in a provenance tag: `[trace]` for a check read from the kernel
trace (`SUAUTH_READ_TRACE_VALUES`), `[SU53 fallback]` for one read from the
SU53 buffer (`SUSR_USER_SU53_READ`) instead. The kernel trace is tried
first; the SU53 fallback is used only when it comes back with zero rows for
the window — the line always says which one actually produced it.

**Evidence.** The entire feature is now verified live end to end (SAP A4H,
client 001, user DEVELOPER, 2026-09-15), through the real `abap_run` and
`abap_test` tool code paths, not just the wire protocol:

- `abap_run { object: "ZCL_I111_USER", auth_trace: true }` returned a
  normal successful run with the header field `auth_trace: no failed
  checks`.
- `abap_test { object: "ZCL_I111_USER", auth_trace: true }` returned
  `outcome: PASSED`, `tests: 1`, `passed: 1` **and** `auth_trace: no failed
  checks` — the trace does not disturb the run's own verdict.
- A deliberately failing check was then captured. A `$TMP` probe class
  `ZCL_I112_FAILCHK` doing `AUTHORITY-CHECK OBJECT 'Z_I112_NOPE' ID 'ACTVT'
  FIELD '03'` (an authorization object that does not exist, so the check
  always fails with `sy-subrc = 12`) was run with `auth_trace: true`. It
  produced, verbatim:

  ```
  auth_trace: 1 failed check(s)

  --- FAILED AUTH CHECKS ---
  Z_I112_NOP ACTVT=03 rc=12 at ZCL_I112_FAILCHK==============CM001 line 7 [SU53 fallback]
  ```

  So the `FAILED AUTH CHECKS` section, the object/field=value/rc/program/
  line line format, and the `[SU53 fallback]` provenance tag are all
  confirmed as real rendered tool output, not just narrated. (Note
  `Z_I112_NOP`: the SU53 buffer's object column is CHAR10, so the
  11-character name `Z_I112_NOPE` comes back truncated — a property of the
  source data SU53 hands back, not a bug in this tool.)
- The switch-off was confirmed: a follow-up status read returned
  `active: false`.

**Not** verified live: `SUAUTH_READ_TRACE_VALUES`, the kernel-trace read
itself — it returned zero rows on this appliance even with the trace active
and a check failing inside the window. Every failed check actually
observed, including the one above, came from the SU53 fallback; no
`[trace]`-tagged line has ever been seen. The kernel-trace read path has
unit-test coverage over fakes only.

A hard-won live finding along the way: `CALL FUNCTION` type-checks its
parameters at **runtime**, not at syntax-check or unit-test time, so two
defects in the generated ABAP got past both and were only caught by
executing it — passing a `string` into a `XUBNAME` parameter raised
`CX_SY_DYN_CALL_ILLEGAL_TYPE`, and a packed `TIMESTAMP` rendering with a
trailing blank broke the read-back's strict 14-character validation.

## abap_test

Run ABAP Unit tests for an object and report pass/fail with messages.

**Availability**: the real, functional tool needs `canWrite`. Without it,
a read-only v1 server registers a mode-locked refusal stub under the same
name instead of skipping registration (case 4 in
[availability-and-capabilities.md](availability-and-capabilities.md)):
still listed with an empty schema, refuses every call `READ_ONLY` without
reaching SAP.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `object` | string | required for `scope: "object"` (the default) | — | Object to test. Refused (`BAD_INPUT`) if given together with `scope: "impacted"` — that path selects its own carriers. |
| `type` | string | no | — | ADT type hint. |
| `scope` | enum `object` \| `impacted` | no | `object` | `object`: run one named object's tests, unchanged. `impacted`: select and run the test carriers a changed set puts at risk via where-used, instead of one named object. See "Impacted scope" below. |
| `changed` | array\<string\> | no | — | Explicit changed-object names for `scope: "impacted"` — skips the journal. Mutually exclusive with `since` (`BAD_INPUT` if both given). Refused (`BAD_INPUT`) together with `scope: "object"`, where it would be silently ignored. |
| `since` | string (ISO-8601 timestamp) | no | — | For `scope: "impacted"`: use journal writes to this system since this timestamp instead of the current session. Mutually exclusive with `changed`. Refused (`BAD_INPUT`) together with `scope: "object"`, and if it isn't a timestamp `Date.parse` can read. |
| `risk_level` | enum `harmless` \| `dangerous` \| `critical` | no | `harmless` | Which risk-level test methods to run, cumulative from harmless up. |
| `coverage` | boolean | no | `false` | Also measure statement/branch/procedure coverage and report it per class and per method. Not supported with `scope: "impacted"` (`BAD_INPUT`). |
| `coverage_for` | array\<string\> | no | — | Objects to report coverage for. Default: the objects under test. Ignored unless `coverage` is `true`; giving it without `coverage: true` is `BAD_INPUT`, raised before any request is sent, because a silently-uncovered run would otherwise look like an oversight rather than a mistake. Not supported with `scope: "impacted"` (`BAD_INPUT`). |
| `auth_trace` | boolean | no | `false` | Switch on the SAP authorization trace for the executing user around this run and read back failed authority checks afterward. See [Authorization trace](#authorization-trace-auth_trace) above. Never runs in read mode. Refused (`BAD_INPUT`) together with `scope: "impacted"` — a deliberate limitation, verified live: `auth_trace is not supported for scope="impacted": it would switch the trace on and off once per carrier and would be silently ignored otherwise.` |

Notes: four outcomes, only one of which is a pass. `PASSED` — tests ran and
all succeeded. `FAILED` — at least one assertion failed. `NO TESTS RAN` —
the object has no test methods at this risk level; **this is not a pass**,
it is the absence of evidence. `UNKNOWN` — the run could not be graded; also
not a pass. Coverage never changes this outcome: a coverage-retrieval
failure is reported as a `NOTE` and the PASSED/FAILED/NO TESTS RAN/UNKNOWN
verdict above it is unaffected. `scope: "impacted"` adds two further
not-a-pass outcomes of its own — see "Impacted scope" below.

### Impacted scope (`scope`, `changed`, `since`)

`scope: "impacted"` runs no single named object. It builds a changed-object
set, treats each changed object as a candidate carrier in its own right
(reason `changed directly`), and additionally narrows each one's
where-used consumers to CLAS/PROG/FUGR, probing each kept consumer for a
test class; a consumer that carries one is selected too (reason
`uses <changed object>`). Every selected carrier then runs through the same
POST/parse/render path as `scope: "object"`, and `SELECTION` (which carriers
were picked and why) is always reported separately from `RESULTS` (what
each selected carrier's run actually returned).

The changed set: an explicit `changed` list skips the journal entirely. With
no `changed`, it comes from this server's local write journal, filtered to
the connected system and — by default — the current session; `since` (an
ISO-8601 timestamp) filters by time instead of the session. `changed` and
`since` are mutually exclusive, and both are refused together with
`object`/`coverage`/`coverage_for`, none of which apply to this scope.
`auth_trace` is refused here too, but for a different reason: not because
it doesn't apply, but because switching the trace on and off once per
selected carrier would be ambiguous at best, and applying it only once for
the whole call would be silently ignored — verified live, message:
`auth_trace is not supported for scope="impacted": it would switch the
trace on and off once per carrier and would be silently ignored
otherwise.`

Caps: at most 20 where-used consumers are probed per changed object, and at
most 10 carriers are ever selected and run in total — both numbers appear
in the header's `caps:` field on every response, with a note when either
one actually bit. A consumer left unprobed because of either cap is never
silently dropped: it is named on a `--- TRUNCATED ---` line (grouped by the
changed object it came from, or, if the carrier cap was reached first,
named as a changed object whose consumers were never even looked at) — an
unexamined consumer may carry a test that did not run.

Two empty outcomes look similar but mean different things, and **neither is
a pass**: `NO CHANGED OBJECTS` — the changed set itself was empty (no
`changed` given and nothing in the journal for the window), so nothing was
even selected against. `NO IMPACTED TESTS FOUND` — the changed set was
non-empty and consumers were examined, but not one of the changed objects
or their consumers carries a test class, so nothing was run.

Where-used is static, the same caveat as the [where-used
row](../CAPABILITIES/non-object-capabilities.md): a consumer reached only
through a dynamic call (`CALL FUNCTION lv_name`, `PERFORM (lv_form)`,
`SUBMIT (lv_prog)`) never appears in the rows this selection is built from,
so a test class reachable only that way is not part of the selection.

**Evidence.** Verified live (SAP A4H, client 001, user DEVELOPER,
2026-09-15) on `ZCL_I111_USER` (has a `testclasses` include with
`ltcl_user`) and `ZCL_I111_LIB` (no test class), both in `$TMP`:
`changed: ["ZCL_I111_USER"]` selected that class as `changed directly` and
ran ABAP Unit for real (`outcome: PASSED`, `tests: 1`, `passed: 1`);
`changed: ["ZCL_I111_LIB"]` returned `NO IMPACTED TESTS FOUND (not a pass)`
with body `NO IMPACTED TESTS FOUND — 1 changed object(s), 0 consumer(s)
examined, none carries a test class`; both names given together
deduplicated to the single carrier; and `caps: per-object 20, carriers 10`
appeared in the header on both the populated and the empty outcome.
`NO CHANGED OBJECTS` is now backed by its own live evidence too, not
inferred from the outcome above: `changed: []` returned `NO CHANGED
OBJECTS (not a pass)` with body `No changed objects were given — nothing
was run.`, and, separately, `since: "<an ISO timestamp>"` against an empty
journal returned the same outcome with body `The journal held no writes
for this system since <timestamp> — nothing was run.` — so the
journal-derived changed-set path (the `since` filter, the system filter,
and its distinct provenance note) is confirmed live as reaching the
journal and reporting its provenance. Not yet observed live: that same
journal path actually selecting a **non-empty** changed set — every live
`since` run so far has hit an empty journal.

**Not** verified live: consumer discovery itself. On this appliance the
where-used index has never been built — report `SAPRSEUB` has never run, so
`WBCROSSGT`/`CROSS` are empty and ADT's `usageReferences` endpoint answers
zero rows for every object tried, including SAP-standard ones
(`CL_ABAP_UNIT_ASSERT`) — so `consumersExamined` was 0 in every live run
above. Finding consumers, the per-object consumer cap, the total carrier
cap, and the `--- TRUNCATED ---` naming therefore have unit-test coverage
over fakes only; on a system with a built where-used index the behaviour is
what those tests specify, but that has not been observed live.

### Coverage (`coverage`, `coverage_for`)

Setting `coverage: true` instruments the whole ABAP Unit run and measures
statement, branch and procedure coverage (verified live against SAP A4H,
2026-09-12; wire capture: `test/fixtures/live-captured/852`–`856-i75-*`).
This is slower than a plain run and is opt-in.

The report rendering itself — not just the wire protocol behind it — is
now confirmed live too: `abap_test { object: "ZCL_I75_UNDO", type:
"CLAS/OC", coverage: true }` against SAP A4H, 2026-09-12, returned outcome
PASSED, tests 1, passed 1, the header `coverage: statement 2/2 (100%),
branch 1/1 (100%), procedure 1/1 (100%)` line, a `COVERAGE` section with a
class row and a per-method row for `DOUBLE`, and an `ALSO TOUCHED` list of
15 framework objects plus a `… and 19 more (truncated)` line — so the
focus set, the header ratio line, the per-class/per-method table, and
`ALSO TOUCHED` with its cap are all confirmed as rendered MCP tool output,
not just fixture-driven. Still `tests`-only, exercised only against the
fixtures shown below: the `UNCOVERED METHODS` section, the `not measured
by this run` / `not touched by this run` / `not queried` wordings, and
`coverage_for` naming an object other than the one under test.

By default the report covers the objects under test, not everything the
run touched — ABAP Unit test runs typically execute code in dozens of
framework classes (SAP kernel/runtime classes, `CL_ABAP_UNIT_ASSERT`, and
so on) that abapsmith did not write and the caller almost never wants
measured. Name any object in `coverage_for` to point the report at it
instead — useful when the tests under one class exercise another object
indirectly. (This `coverage_for`-names-another-object path is `tests`-only
— see above.)

Coverage adds:

- a `coverage` header field: the summed statement/branch/procedure ratio
  across every object actually reported on, e.g.
  `statement 5/8 (63%), branch 3/5 (60%), procedure 2/3 (67%)`. Omitted
  from the header entirely (not printed as `not reported`) when nothing
  was measured.
- a `COVERAGE` body section: one line per reported object with its own
  ratios, indented child lines for its methods.
- `UNCOVERED METHODS`: methods with statement total > 0 but 0 executed —
  ABAP Unit ran, but nothing in the method ran. `tests`-only: not yet
  observed live as rendered output.
- `COVERAGE NOT REPORTED FOR`: methods ADT's coverage query returned with
  no statement figures at all. `tests`-only: not yet observed live as
  rendered output.
- `ALSO TOUCHED`: the rest of the objects the run's coverage trace saw,
  named but not measured — name one of these in `coverage_for` to get its
  numbers. Capped at 15 entries with a `… and N more (truncated)` line
  past that; the focus set actually *queried* for numbers is capped at 10
  objects, because a query over the full covered-objects roster (16–35
  objects on a typical run) timed out against a real system at the 60s
  HTTP timeout. Objects skipped for this reason are named in a `NOTE`,
  not silently dropped.

An object ADT never executed answers with a ratio total of 0 and no
per-method breakdown at all — abapsmith reports this as **"not measured
by this run"**, never as `0%`. A ratio ADT didn't report at all renders as
`not reported`; a ratio whose total is 0 (nothing to execute) renders as
`n/a`. These three are distinct and are not interchangeable in the output:
a `0%` line means ADT reported executable statements and none of them
ran, which is a different fact from "this was never touched."

Percentages render as `statement 5/8 (63%)` — executed/total, rounded.

Example — `ZCL_I75_PROBE` has three public methods, `DOUBLE` and `TRIPLE`
called from its ABAP Unit tests, `NEVER_CALLED` left uncalled:

```json
{
  "object": "ZCL_I75_PROBE",
  "type": "CLAS/OC",
  "coverage": true
}
```

```
system: A4H
object: CLAS/OC ZCL_I75_PROBE
outcome: PASSED
riskLevel: harmless
tests: 2
passed: 2
failed: 0
coverage: statement 5/8 (63%), branch 3/5 (60%), procedure 2/3 (67%)

--- RESULTS ---
PASSED  LTCL_PROBE [risk harmless]: DOUBLES_A_POSITIVE, TRIPLES_A_POSITIVE

COVERAGE
ZCL_I75_PROBE  statement 5/8 (63%)  branch 3/5 (60%)  procedure 2/3 (67%)
  DOUBLE  statement 2/2 (100%)  branch 1/1 (100%)  procedure 1/1 (100%)
  NEVER_CALLED  statement 0/2 (0%)  branch 0/1 (0%)  procedure 0/1 (0%)
  TRIPLE  statement 3/4 (75%)  branch 2/3 (67%)  procedure 1/1 (100%)

UNCOVERED METHODS (0 of their statements ran):
  ZCL_I75_PROBE->NEVER_CALLED  (0/2 statements)

ALSO TOUCHED (not reported on — name one in coverage_for to measure it):
  CL_ABAP_BEHV_CONTRACTS (CLAS/OC, SABP_BEHV)
  CL_ABAP_INTFDESCR (CLAS/OC, SABP_RTTI)
  CL_ABAP_OBJECTDESCR (CLAS/OC, SABP_RTTI)
  CL_ABAP_SOFT_REFERENCE (CLAS/OC, SABP_LEGACY)
  CL_ABAP_SWITCH (CLAS/OC, SABP_ENHANCEMENT)
  CL_ABAP_TYPEDESCR (CLAS/OC, SABP_RTTI)
  CL_ABAP_UNIT_ASSERT (CLAS/OC, SABP_UNIT_CORE_API)
  CL_AUCV_TASK (CLAS/OC, S_AUNIT_COVERAGE)
  CL_AUNIT_CORE_RT_FACTORY (CLAS/OC, SABP_UNIT_CORE_RUNTIME)
  CL_AUNIT_PROG_BYTE_CODE_SVC (CLAS/OC, SABP_UNIT_CORE_RUNTIME)
  CL_AUNIT_TEST_CLASS (CLAS/OC, SABP_UNIT_CORE_RUNTIME)
  CL_AUNIT_TEST_CLASS_DECORATOR (CLAS/OC, SABP_UNIT_CORE_API)
  CL_FTG_RUNTIME_STATE (CLAS/OC, S_FEATURE_TOGGLES_API)
  RS_ABAP_BEHV_CTRL_LOAD (PROG/P, SABP_BEHV)
  SABP_UNIT_SBOX (FUGR/F, SABP_UNIT_CORE_RUNTIME)
```

Real numbers, captured live on this probe class: class-level statement
5/8, branch 3/5, procedure 2/3; `DOUBLE` statement 2/2; `TRIPLE` statement
3/4; `NEVER_CALLED` statement 0/2. The 16-object roster above (1 focus
object + 15 `ALSO TOUCHED`) is the exact live-captured roster for this
run — most of it is SAP framework code the ABAP Unit runtime itself
touches, not code under test.

