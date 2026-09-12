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
| `object` | string | yes | — | Object to test. |
| `type` | string | no | — | ADT type hint. |
| `risk_level` | enum `harmless` \| `dangerous` \| `critical` | no | `harmless` | Which risk-level test methods to run, cumulative from harmless up. |
| `coverage` | boolean | no | `false` | Also measure statement/branch/procedure coverage and report it per class and per method. |
| `coverage_for` | array\<string\> | no | — | Objects to report coverage for. Default: the objects under test. Ignored unless `coverage` is `true`; giving it without `coverage: true` is `BAD_INPUT`, raised before any request is sent, because a silently-uncovered run would otherwise look like an oversight rather than a mistake. |

Notes: four outcomes, only one of which is a pass. `PASSED` — tests ran and
all succeeded. `FAILED` — at least one assertion failed. `NO TESTS RAN` —
the object has no test methods at this risk level; **this is not a pass**,
it is the absence of evidence. `UNKNOWN` — the run could not be graded; also
not a pass. Coverage never changes this outcome: a coverage-retrieval
failure is reported as a `NOTE` and the PASSED/FAILED/NO TESTS RAN/UNKNOWN
verdict above it is unaffected.

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

