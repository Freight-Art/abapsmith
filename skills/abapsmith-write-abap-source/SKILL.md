---
name: abapsmith-write-abap-source
description: Writes ABAP source for classes, interfaces, programs, function groups and function modules, and enhancement implementations. Use when writing ABAP code rather than a dictionary object. Read the per-type file next to it for the object you are writing.
---

# ABAP source objects

`CLAS/OC` `INTF/OI` `PROG/P` `FUGR/F` `FUGR/FF` `ENHO/XHH` — all `source`
shape. `PROG/I` and `FUGR/I` (includes) are also `source` shape and are
creatable and deletable.

Read the file for the object type you are about to write, in this directory:

| Writing | Read |
|---|---|
| Class or interface (`CLAS/OC`, `INTF/OI`), ABAP Unit tests | `classes.md` |
| Function group, function module, group include (`FUGR/F`, `FUGR/FF`, `FUGR/I`) | `function-modules.md` |
| Report or include (`PROG/P`, `PROG/I`) | `programs.md` |
| Enhancement implementation (`ENHO/XHH`) | `enhancements.md` |

## Preview an edit before writing

Dry-run first when you want to see the diff before it lands: `abap_write`
resolves the target, reads the current source, applies `edit`/`method`/`source`
locally, and runs the safety gate — then returns a diff instead of writing.

```
abap_write { object, method, source, dry_run: true }
```

Read the diff. `edit` and `method` already supply the write's etag
automatically, so dropping `dry_run` and repeating the same call is enough
for those two forms. A plain `{object, source}` rewrite does not — pass the
preview's `current_etag` back explicitly as `expect_etag`:

```
abap_write { object, source, expect_etag }
```

That makes the applied write compare-before-write against exactly the bytes
previewed, not whatever the object holds by the time the call lands.

## Learn a signature without reading the class

To learn a method's signature, use `method=` with `include="definitions"`;
do not read the full class:

```
abap_read { object: "CL_SALV_COLUMNS_TABLE", method: "GET_COLUMNS", include: "definitions" }
```

That returns the `METHODS …` declaration alone. `method=` without `include`
returns the declaration first, then the body. Both find members declared on
a superclass or interface and report `foundOn`; `outline=true` lists those
inherited members in their own section. A `NOT_FOUND` lists candidate names
from the whole chain — read it before guessing another name.

## After CHECK_FAILED

A full write whose syntax check fails is saved INACTIVE, not discarded. Fix
the reported lines (each message quotes the offending line with one line of
context) with `abap_write { object, method, source }` — `method=` resolves
against the inactive version, so no re-read is needed — then `abap_activate`.
Rewriting the whole class again also works; reading the active source back
does not, since it predates the failed write.

## Statements that activate cleanly and fail at run time

These are not caught by the syntax check in any object type:

- Positional `SELECT … INTO TABLE` with a select list in a different order than the target
  structure gives shifted or empty fields, silently. Use `INTO CORRESPONDING FIELDS OF TABLE`.
- `CO` / `CN` / `strlen` on a fixed-length `C(n)` field count the trailing blanks; do character
  tests on a `STRING` local after `CONDENSE … NO-GAPS`.
- `CALL FUNCTION` actuals are not checked against the module's types at activation; see
  `function-modules.md`.

## Verify

Activation returns 200 even on failure — check `chkl:messages` for `type: "E"`,
free in the response. The read-back is `verified`-mode only. Full checklist:
`abapsmith-create-an-object`.
