---
name: abapsmith-write-abap-source
description: Writes ABAP source for classes, interfaces, programs, function groups and function modules — sub-includes, function module signatures, and how to name a module. Use when writing ABAP code rather than a dictionary object.
---

# ABAP source objects

`CLAS/OC` `INTF/OI` `PROG/P` `FUGR/F` `FUGR/FF` — all `source` shape.
`PROG/I` and `FUGR/I` (includes) are also `source` shape and are creatable
and deletable. Address a `FUGR/I` as `GROUP/L<GROUP><suffix>`, e.g.
`ZMY_GROUP/LZMY_GROUPF01` — the function group must already exist first. A
`PROG/I` cannot be deleted while a program still `INCLUDE`s it.

## Class sub-includes

ADT exposes exactly five: `main`, `definitions`, `implementations`, `macros`,
`testclasses`. Pass `include:` on `abap_read` and `abap_write`.

- Omitting `include` addresses `main`.
- **ABAP Unit tests live in `testclasses`.** Writing them into `main` is the
  common mistake — it does not fail, it just puts them in the wrong place.
- Any include but `main` on a non-class throws `UNSUPPORTED`. It is **not**
  silently answered with the main source.

Prefer `method` (replace one `METHOD…ENDMETHOD`) over resending the class. It
re-reads and supplies the etag for you.

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

## Function groups and modules

A function module is a child of its **group**, not of a package. It has no
`packageRef` of its own.

**Name it one of these two ways:**

```
object: "function module Z_MY_FM in ZMY_GROUP"
{ "object": "ZMY_GROUP/Z_MY_FM", "type": "FUGR/FF" }
```

A bare `"ZMY_GROUP/Z_MY_FM"` with no `type` is **refused** — the whole string reads
as one object name.

**Create the group first.** A module create against a missing group returns
`500 ExceptionResourceCreationFailure` — *"Function group X does not exist"*. That
500 is not transient; retrying will not help.

**The group is active on creation.** No activation step, no state transition. A
generic create-then-activate flow must tolerate activation being a no-op here.

**A group's `/source/main` is the TOP-include list**, not a place for code:

```abap
INCLUDE LZMY_GROUPTOP.
INCLUDE LZMY_GROUPUXX.
```

**Both lines are required.** `L<GROUP>UXX` is the generated include that pulls in
the function module bodies. Writing only the `TOP` line produces a group that
reports written, activated and active while every call to its modules dumps
`CX_SY_DYN_CALL_ILLEGAL_FUNC` / `CALL_FUNCTION_NOT_ACTIVE`. abapsmith
refuses that shape with `BAD_INPUT` before sending anything — a group that lists
its `L<GROUP>U01`, `U02`, … implementation includes individually instead of
`UXX` is accepted.

Real global declarations belong in `L<GROUP>TOP`, which is not a writable target here.

## Function module signatures

Three shapes look plausible. **One works.**

❌ The SE37 `*"` local-interface comment block — **rejected at PUT**,
`400 ExceptionResourceScanDuringSaveFailure`, *"Parameter comment blocks are not
allowed."* This is what SE37 displays and what most ABAP material shows. It cannot
be saved over ADT.

❌ A properties/XML PUT of the signature — no such mechanism. A module's own URI
returns metadata only; there is no parameter schema to PUT.

✅ A structured `FUNCTION` header in the source itself, plain ABAP, no comment prefix:

```abap
FUNCTION Z_MY_FM
  IMPORTING
    VALUE(IV_NAME) TYPE STRING
  EXPORTING
    VALUE(EV_GREETING) TYPE STRING
  EXCEPTIONS
    NAME_EMPTY.

  IF iv_name IS INITIAL.
    RAISE name_empty.
  ENDIF.
  ev_greeting = |Hello, { iv_name }!|.
ENDFUNCTION.
```

`CHANGING` / `TABLES` / `RAISING` follow the same grammar.

A new module starts **inactive** and needs its own activation. The group never
needs re-activating because a module changed.

## Enhancement implementations (ENHO/XHH)

`abap_write`'s `source` for `ENHO/XHH` must be the **whole**
`ENHANCEMENT <n>. ... ENDENHANCEMENT.` skeleton, not just the statements you
want inside it — a bare statement list is rejected. The **named** form
(`ENHANCEMENT-POINT`/`ENHANCEMENT <n> ZFOO.`) is rejected too; only the
positional `ENHANCEMENT <n>.` header is accepted.

Safest shape: `abap_read` the object first, keep its `ENHANCEMENT <n>.` /
`ENDENHANCEMENT.` header and footer lines byte-for-byte, and edit only what's
between them. Enhancement objects can never be undone via `abap_journal
mode=undo`, even with `force: true`, so there is no safety net for a
mis-shaped rewrite the way there is for other object types.

## Verify

Activation returns 200 even on failure — check `chkl:messages` for `type: "E"`,
free in the response. The read-back is `verified`-mode only. Full checklist:
`abapsmith-create-an-object`.
