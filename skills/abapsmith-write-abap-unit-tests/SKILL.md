---
name: abapsmith-write-abap-unit-tests
description: Writes and runs ABAP Unit tests for a class through abap_write, abap_activate and abap_test. Use when adding, changing, or running unit tests for an ABAP class, or when reading coverage for one.
---

# ABAP Unit tests

## Where a test class lives

ABAP Unit tests are not a separate object — they are the `testclasses`
sub-include (CCAU) of the class under test. Write them with:

```
abap_write { object: "ZCL_MY_CLASS", type: "CLAS/OC", include: "testclasses", source: "..." }
```

then activate:

```
abap_activate { object: "ZCL_MY_CLASS", type: "CLAS/OC" }
```

Activating the class activates `testclasses` along with it — there is no
separate activation step for the include. This create-when-absent,
update-when-present, activate, run, read-back path was verified live end
to end against SAP A4H, 2026-09-12: `abap_write` created the include on a
class that had none, `abap_activate` activated it, `abap_test` then ran
the tests inside it, and `abap_read { object, include: "testclasses" }`
read back exactly the bytes written.

Omitting `include` writes `main` instead — the most common mistake here is
writing a test class into `main` by forgetting the parameter. It does not
fail; it just puts the test class in the wrong place, alongside the
production code it is supposed to test.

## The shape of a test class

An ABAP Unit test class has to satisfy the framework's own rules, not just
compile. The shape below is the general ABAP Unit convention combined with
what abapsmith actually observed live on SAP A4H, 2026-09-12, testing a
probe class `ZCL_I75_PROBE` with methods `DOUBLE`, `TRIPLE` and
`NEVER_CALLED`: the test class name `LTCL_PROBE`, its `RISK LEVEL
HARMLESS`, its `DURATION SHORT`, and its two test methods
`DOUBLES_A_POSITIVE` and `TRIPLES_A_POSITIVE` all came from a live-captured
`aunit:runResult` (`test/fixtures/live-captured/853-i75-ut-testrun-coverage.xml`).
The method bodies below are a reconstruction built to match that shape —
their literal source bytes were not themselves captured live. If you
change the parts that were confirmed live (the definition header, `RISK
LEVEL`/`DURATION` keywords, `FOR TESTING` on the methods, the assertion
class), you are guessing, not following evidence.

```abap
CLASS ltcl_probe DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.
  PRIVATE SECTION.
    DATA cut TYPE REF TO zcl_i75_probe.

    METHODS setup.
    METHODS doubles_a_positive FOR TESTING.
    METHODS triples_a_positive FOR TESTING.
ENDCLASS.

CLASS ltcl_probe IMPLEMENTATION.
  METHOD setup.
    cut = NEW zcl_i75_probe( ).
  ENDMETHOD.

  METHOD doubles_a_positive.
    cl_abap_unit_assert=>assert_equals(
      act = cut->double( 3 )
      exp = 6
      msg = 'DOUBLE should double a positive number' ).
  ENDMETHOD.

  METHOD triples_a_positive.
    cl_abap_unit_assert=>assert_equals(
      act = cut->triple( 3 )
      exp = 9
      msg = 'TRIPLE should triple a positive number' ).
  ENDMETHOD.
ENDCLASS.
```

Notes on the shape:

- `DEFINITION FOR TESTING` marks the whole class as ABAP Unit tests, not
  production code.
- `RISK LEVEL` (`HARMLESS` / `DANGEROUS` / `CRITICAL`) and `DURATION`
  (`SHORT` / `MEDIUM` / `LONG`) are optional to the ABAP compiler — a
  `FOR TESTING` class activates fine without either one. The trap is
  worse than a compile error: a test class that does not declare `RISK
  LEVEL HARMLESS` defaults to a risk level above `abap_test`'s default
  `harmless` limit, so its tests are silently skipped and the run grades
  `UNKNOWN (not a pass)` with a tolerable "risk level of test class
  exceeds upper limit" alert — not `PASSED` and not `FAILED`. Verified
  live, SAP A4H, 2026-09-12: a class with no `RISK LEVEL` and no
  `DURATION` was written into `ZCL_I75_PROBE`'s `testclasses` include,
  `abap_write` reported `check: clean` and `activated: true`, and
  `abap_test` then reported `UNKNOWN` with 0 tests run/passed/failed
  (`test/fixtures/live-captured/857-i75-ut-testrun-risk-exceeded.xml`).
  Always declare `RISK LEVEL HARMLESS` unless you mean otherwise, and if
  you do mean otherwise, pass the matching `risk_level` to `abap_test`.
- Only methods marked `FOR TESTING` run as tests. `setup` (no `FOR
  TESTING`) runs before every test method automatically — it is a
  framework hook by name, not a test itself.
- Assertions go through `cl_abap_unit_assert` (`assert_equals`,
  `assert_true`, `assert_bound`, and so on, not raw `IF`/exceptions) — an
  unmet assertion is what makes ADT report the method as failed with a
  message and a stack, rather than just leaving the method's outcome
  ambiguous.

## Running the tests

```
abap_test { object: "ZCL_MY_CLASS", type: "CLAS/OC" }
```

The response reports exactly one of four outcomes: `PASSED`, `FAILED`,
`NO TESTS RAN (not a pass)`, or `UNKNOWN (not a pass)`. **`NO TESTS RAN` is
not the same thing as `PASSED`.** It means nothing was verified — either
there is no `testclasses` include, or activation failed and the class
(tests included) never became active, or every test method there is above
the risk level this run allowed. A `PASSED` after a fresh write is only
meaningful once you have confirmed the write and activation actually
succeeded; a silently-failed activation followed by a test run reports
`NO TESTS RAN`, not a failure, so do not read the absence of `FAILED` as
success.

`risk_level` (`harmless` / `dangerous` / `critical`, default `harmless`,
cumulative from harmless up) gates which test methods run. A test method
declared `RISK LEVEL DANGEROUS` will not run under the default
`risk_level: "harmless"` — it will silently not count toward the outcome,
and if it was the only test method, the run reports `NO TESTS RAN`, not a
skip. Raise `risk_level` explicitly to run it.

## Coverage

Add `coverage: true` to measure statement/branch/procedure coverage
alongside the run — see `doc/TOOLS/execute-and-test.md` for the full shape
of the coverage report. Coverage defaults to reporting
the objects under test; name other objects in `coverage_for` (only
together with `coverage: true` — naming it alone is `BAD_INPUT`) to report
coverage for something the tests exercise indirectly. Coverage is
additive: it never changes whether the run outcome is `PASSED` or
`FAILED`, and a method that ran zero of its statements is listed under
`UNCOVERED METHODS`, not folded into the pass/fail verdict.

## Iterating on a test class

`abap_write` with `include: "testclasses"` **replaces the whole include**,
not just the method you are changing. Read it first:

```
abap_read { object: "ZCL_MY_CLASS", include: "testclasses" }
```

then edit the text you got back and write the whole thing. A write here
has no method-level patch form the way `main` has `method`/`edit` — there
is no way to append or replace one test method in isolation.

Every write is journalled, so a bad rewrite of `testclasses` can be
reverted:

```
abap_journal { mode: "undo", object: "ZCL_MY_CLASS" }
```

This restores a previous version of the include itself — it does not
touch `main` or the class's other includes. Undoing a write that targeted
`testclasses` directly is now confirmed live, against SAP A4H,
2026-09-12, on class `ZCL_I75_UNDO`: a second version of `testclasses` was
written, `abap_journal mode=show` on that entry reported `include:
testclasses` and the include-scoped warning, `abap_journal mode=undo`
reported `action: restore` / `activated: true`, and `abap_read { include:
"testclasses" }` read back exactly the before-image bytes — the read-back
etag equalled the entry's `beforeEtag`
(`sha256:be7abc10f006180d9ffb48eafff05612`).

## Traps

- **You cannot delete a single include on its own.** ADT has no verb for
  it — only delete-the-whole-class exists. `abap_write { mode: "delete",
  include: "testclasses" }` is refused with `BAD_INPUT` before anything is
  touched. To remove tests, write the include with new content that has no
  test methods in it (even a single comment line is enough to empty it
  meaningfully) rather than trying to delete it.
- **A syntax error in `testclasses` blocks activation of the whole
  class**, not just the tests. Since the include activates together with
  its class, broken test code stops the production code in `main` from
  becoming active too, even if `main` itself is correct.
- **Deleting the class deletes its tests along with it.** A class delete
  now also captures all four local includes (`definitions`,
  `implementations`, `macros`, `testclasses`) at delete time, so undoing
  the delete restores the test class along with the rest of the class —
  this restore path is now confirmed live too: on class `ZCL_I75_UNDO`
  (SAP A4H, 2026-09-12), `abap_write mode=delete` produced a journal entry
  with all four parts `beforeCapture: captured`, `abap_journal mode=undo`
  reported `action: recreate`, `restoredIncludes: definitions,
  implementations, macros, testclasses`, `activated: true`, and a
  following `abap_test` on the recreated class ran the restored test class
  and reported PASSED — proof `testclasses` really came back active.
