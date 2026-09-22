# Function groups and modules

`abap_write`/`abap_read` handling specific to `FUGR/F` (group), `FUGR/FF`
(module) and `FUGR/I` (group include). For naming rules, the group-first
create order's mechanics, the TOP-include/`UXX` shape and module-signature
grammar, see
[skills/abapsmith-write-abap-source/function-modules.md](../../skills/abapsmith-write-abap-source/function-modules.md)
— this file does not repeat it.

## Create order and the group's transport request

A function module has no package of its own — it lives in its group's. The
group must exist first; a module create against a missing group returns
`500 ExceptionResourceCreationFailure`.

Before the fix in #171, a module create with no `package` resolved to
`$TMP` and sent the create POST with no `corrNr`. CTS refused it with 403
`CTS_WBO_API/019` — the group's generated `L<GROUP>UXX` include, which every
module create touches, was already locked by the request the group itself
was created in.

The create path now reads the group's own `adtcore:packageRef` with one GET
before writing, and uses that package: transportchecks answers `KORRFLAG X`
naming the request that holds the lock, and the POST carries that request as
`corrNr`. The write response's `transport:` line reports the request
actually used, and `package_source: container` says the package was read off
the group rather than supplied by the caller or picked by the usual
per-session resolver. A `package` argument that disagrees with the group's
own package is refused `BAD_INPUT` — abapsmith does not move the module to a
different package.

## `remote_enabled`

| Parameter | Type | Applies to | Effect |
|---|---|---|---|
| `remote_enabled` | boolean, optional | `FUGR/FF` only (`BAD_INPUT`, zero-network, for every other type and for `mode=delete`) | `true` sets the module's processing type to `rfc` (Remote-Enabled Module); `false` sets it to `normal`. Omitted, the processing type is left untouched. |

The wire mechanism: after the source PUT, under the same lock and transport,
abapsmith PUTs a minimal `<fmodule:abapFunctionModule
fmodule:processingType="rfc|normal">` descriptor (`Content-Type:
application/vnd.sap.adt.functions.fmodules.v3+xml`) to the module's own URI,
then unlocks and activates as usual. No ABAP bridge is involved, and the
descriptor PUT leaves an inactive version behind like any other change.

A `remote_enabled` change alone, against a byte-identical source, still
takes the lock and writes the descriptor — it is not skipped as a no-op. The
write response prints `processing_type: rfc|normal` whenever it is known,
plus a note when the call changed it.

## Reading the processing type

`abap_read` of a `FUGR/FF` (plain source read) prints `processing_type` and
`remote_enabled: yes|no` in the header, from one extra GET of the module
descriptor. An RFC module also reads back `fmodule:rfcScope="notClassified"`
and `fmodule:rfcVersion="any"` — SAP's own defaults; abapsmith does not set
either.

## Errors

- **`BAD_INPUT`** — `remote_enabled` on a type other than `FUGR/FF`, or on
  `mode=delete`; a `package` that disagrees with the group's own package on a
  module create.
- **`TRANSPORT_LOCKED`** — a module create that still hits
  `CTS_WBO_API/019` (most likely a caller-forced `corr_nr` other than the
  one already holding the lock). `details.classifiedBy:
  "cts-object-locked-in-other-request"`, with `details.holdingRequest`,
  `details.holdingUser` and `details.lockedObject`, and a hint naming the
  request to pass as `corr_nr`.

## Verified live

A4H, 2026-09-22: group `ZAS_FG171` / modules `ZAS_FM_ONE`, `ZAS_FM_TWO`,
`ZAS_FM_RFC`, in a transportable package (request left open, objects deleted
afterwards).
