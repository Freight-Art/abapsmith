# Function groups and modules (`FUGR/F`, `FUGR/FF`, `FUGR/I`)

Read after `SKILL.md` when creating or changing a function group, a function
module, or a group include — or when calling a module from your own code.

## Naming

A function module is a child of its **group**, not of a package. It has no
`packageRef` of its own. Name it one of these two ways:

```
object: "function module Z_MY_FM in ZMY_GROUP"
{ "object": "ZMY_GROUP/Z_MY_FM", "type": "FUGR/FF" }
```

A bare `"ZMY_GROUP/Z_MY_FM"` with no `type` is **refused** — the whole string reads
as one object name. `abap_search { query, type: "FUGR/FF" }` shows the group of a
module you only know by name.

A group include (`FUGR/I`) is addressed as `GROUP/L<GROUP><suffix>`, e.g.
`ZMY_GROUP/LZMY_GROUPF01`; the group must already exist.

## The group

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

## Module signatures

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

## Transport: a module goes into its group's request

A function module has no package of its own — it inherits the group's. Before
this was handled, omitting `package` on a create resolved to `$TMP` and sent
the POST with no `corrNr`; CTS refused it with 403 `CTS_WBO_API/019`,
*"Object LIMU REPS L<GROUP>UXX is already locked in request <req> of user
<user>"* — the group's generated `L<GROUP>UXX` include, which every module
create touches, was already locked by whatever request created the group.

The create path now reads the group's own package with one GET before
writing, and uses that: transportchecks answers `KORRFLAG X` naming the
request that holds the lock, and the POST carries that request as `corrNr`.
**Omit `package`, or pass the group's own package** — passing a different one
is refused `BAD_INPUT`, not moved. The write response's `transport:` line
reports the request actually used, and `package_source: container` confirms
it came from the group, not from the caller or a resolver guess.

If a create still comes back `CTS_WBO_API/019` — most likely because the
caller forced a `corr_nr` other than the one already holding the lock — it is
classified `TRANSPORT_LOCKED`, with `details.holdingRequest` naming the
request to retry with as `corr_nr`, plus `details.holdingUser` and
`details.lockedObject`.

## Remote-enabled modules

`abap_write { ..., "remote_enabled": true }` (`FUGR/FF` only) sets the
module's processing type to `rfc` (Remote-Enabled Module); `false` sets it
back to `normal`. It is a separate descriptor PUT under the same lock and
transport as the source write, so a `remote_enabled` change alone — with a
byte-identical source — still takes the lock and writes something.
**Omitting the parameter leaves the processing type untouched.**

Verify it with `abap_read` on the module: the header prints `processing_type`
and `remote_enabled: yes|no`. A module called with `CALL FUNCTION ...
DESTINATION` or `STARTING NEW TASK` must be remote-enabled first — calling a
`normal` module that way dumps `CALL_FUNCTION_NOT_REMOTE` at run time, not at
activation.

## Calling a module from your code

`CALL FUNCTION` actuals are not checked against the module's parameter types at
activation. A mismatch dumps at run time as `CX_SY_DYN_CALL_ILLEGAL_TYPE`. Declare
each actual with the formal's own type — `TYPE <table>-<field>` or the DDIC element the
module declares — after reading the interface (`abap_read` the module, or
`abap_fluid tool=core action=describe_fm`).
