# Classes and interfaces (`CLAS/OC`, `INTF/OI`)

Read after `SKILL.md` when writing a class, an interface, or ABAP Unit tests.

## Class sub-includes

ADT exposes exactly five: `main`, `definitions`, `implementations`, `macros`,
`testclasses`. Pass `include:` on `abap_read` and `abap_write`.

- Omitting `include` addresses `main`.
- **ABAP Unit tests live in `testclasses`.** Writing them into `main` is the
  common mistake — it does not fail, it just puts them in the wrong place.
- Any include but `main` on a non-class throws `UNSUPPORTED`. It is **not**
  silently answered with the main source.

Prefer `method` (replace one `METHOD…ENDMETHOD`) over resending the class. It
re-reads and supplies the etag for you:

```
abap_write { object, method, source }
```

`method` resolves the method's line range against the inactive version when
one exists (the state a class is left in after a failed syntax check), so a
`method` write is the repair path after `CHECK_FAILED`; the response says
which version it used. Before writing a call to a method, learn its
signature with `abap_read { object, method, include: "definitions" }` — not
by reading the class.

## Source that saves, then is refused or fails

- A comment line outside `METHOD … ENDMETHOD` or the DEFINITION part makes ADT refuse the
  whole class: `OO_SOURCE_BASED 12`, *"unknown comments which can't be stored"*, no line number.
  Comments go inside a method or inside `CLASS … DEFINITION`.
- `TYPE string` on a formal parameter refuses a `C(10)` actual; `TYPE i` refuses an `N(6)`.
  Declare helper formals `TYPE clike` (`N(n)` is character-like too) and copy into a `string`
  or `i` local inside the method. `VALUE(…)` changes the passing mode, not the rule.
- A class that is called by generated code (a fluid plugin body, a classrun bridge) must keep
  its signature stable: rename nothing the caller addresses without rewriting the caller.

## Running and testing

`abap_run` executes an `IF_OO_ADT_CLASSRUN` class and captures `out->write` output.
`abap_test` runs the tests in `testclasses` and reports each method's verdict; it says
NO TESTS RAN when the include has no test class, which is not a pass.

`abap_run` in class mode captures only what the class writes through
`out->write( )` (the `IF_OO_ADT_CLASSRUN` `out` parameter). Classic `WRITE` /
`WRITE:` statements in a class produce no console output there — an empty
result after `WRITE` is not a failure of the run; move the output to
`out->write( )` instead. Verified live on A4H, 2026-09-22.
