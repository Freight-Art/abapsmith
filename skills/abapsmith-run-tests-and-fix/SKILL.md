---
name: abapsmith-run-tests-and-fix
description: Runs ABAP Unit with abap_test and turns a failure into a fix. Use when asked to run tests for a class or package, when a test failed, or when a change needs proving.
---

# Running tests and fixing what fails

`abap_test` reports one of four outcomes: `PASSED`, `FAILED`, `NO TESTS RAN`,
`UNKNOWN`. **Only `PASSED` is a pass.** `NO TESTS RAN` and `UNKNOWN` both mean
"you have learned nothing" — the first is the absence of test methods at the
risk level you asked for, the second is a run SAP returned but could not be
graded. Neither is green, whatever the response text reads like.

## Steps

```
abap_read include="testclasses"  →  abap_test  →  read the failure location  →
abap_write (include="testclasses" or main)  →  abap_test again
```

1. `abap_read { "object": "ZCL_FOO", "type": "CLAS/OC", "include": "testclasses" }`
   — see whether tests exist at all, and get real line numbers before you need
   them.
2. `abap_test { "object": "ZCL_FOO", "type": "CLAS/OC" }` — run them.
3. On `FAILED`, the result names an include and a line — read that include
   with `abap_read`, don't guess from the main source.
4. Fix the test or the code, whichever is wrong (see below).
5. `abap_write` the fix, then `abap_test` again to prove it.

## Live transcript (A4H, 2026-09-12, throwaway `$TMP` class `ZCL_I92_PROBE`, since deleted)

Running `abap_test { "object": "ZCL_I92_PROBE", "type": "CLAS/OC" }` against a
class with **no testclasses include at all** returned `outcome: UNKNOWN (not a
pass)`, `tests: 0`, with the note: "RESULT NOT GRADED. The run result contained
no test methods and no noTestClasses alert, so it is not known whether
anything ran." On this system, "there are no tests" surfaced as **UNKNOWN**,
not `NO TESTS RAN` — that distinction is about what SAP's result document
said, not about what you asked for. Either way, not a pass.

Every run also carried: "Only tests up to risk level \"harmless\" ran.
Higher-risk tests, if any exist, were not executed and their absence is not a
pass." Widen with `risk_level: "dangerous"` or `"critical"` (cumulative from
harmless) only when the task says so — dangerous and critical tests are
allowed to change data.

After writing one deliberately wrong test, the run returned `outcome:
FAILED`, `tests: 1`, `passed: 0`, `failed: 1`:

```
FAILED  LTCL_DIVIDE->HALVES (3.38s)
    critical failedAssertion: Critical Assertion Error: 'Halves: ASSERT_EQUALS'
      Different values
        Expected [2] Actual [3]
    at include testclasses line 12 — Include: <ZCL_I92_PROBE=================CCAU> Line: <12> (HALVES)
```

Two things from that line: the position is `include testclasses line 12`,
and that line number matches what `abap_read { "include": "testclasses" }`
returns — read that include, don't guess. The `...CCAU` name is SAP's own
generated include name for a class's test include (what SE24/ST22 would show
you); it is not something you pass to any abapsmith tool.

The test was wrong, not the code: it expected `10 / 4` to equal `2`. **ABAP
integer division rounds; it does not truncate.** `10 / 4` on a type `i` is
`3`. Before changing production code to satisfy a red test, check that the
expectation itself is right.

The fix was applied with the splice form:

```
abap_write { "object": "ZCL_I92_PROBE", "type": "CLAS/OC", "include": "testclasses", "edit": { "old_string": "...", "new_string": "..." } }
```

and the re-run then returned `outcome: PASSED`, `tests: 1`, `passed: 1`.
`abap_write` with `include: "testclasses"` activates the class by default
(`activate` defaults to `true`), so there is no separate `abap_activate` step
before the next `abap_test` call.

## Refusals

**`abap_test` needs write access even though it changes no source.** It is
gated the same as any mutation: `ABAP_MODE=edit|admin` and the package
allowlist. On a read-only server it is not skipped — it is still listed in
`tools/list`, under an empty schema, and refuses every call `READ_ONLY`
without reaching SAP.

**`NO TESTS RAN` or `UNKNOWN`.** Re-read the testclasses include and confirm
the class really is `FOR TESTING` with `RISK LEVEL` and `DURATION` declared,
and that at least one method inside it is `FOR TESTING`. An empty or
malformed test include is indistinguishable from "no tests" until you look.

**Undo.** A write to `testclasses` is journalled like any other write, but
`abap_journal mode=undo` **refuses it by name** — replaying it would go
through `/source/main` and write your tests over the class body. See
`abapsmith-recover-a-bad-write`: revert by hand instead, `journal_show` the
before-image, then `abap_write` it back with the same `include="testclasses"`.

## How to prove it

The proof is a second `abap_test` call returning `outcome: PASSED` with a
non-zero `tests` count. There is no `PASSED`-adjacent wording with `tests: 0`
— that combination doesn't exist. A green `abap_activate mode="check"` proves
the source parses; it is a syntax check, not a test run, and proves nothing
about behaviour.

There is **no coverage measurement**. `abap_test` reports verdicts per method,
not which lines a passing test touched — don't promise one.

## Not this skill

A runtime short dump from `abap_run` is not a test failure — route to
`abapsmith-debug-a-failing-run`. Static findings with no execution at all are
`abapsmith-check-code-quality`. Writing the class in the first place, before
there is anything to test, is `abapsmith-write-abap-source`.
