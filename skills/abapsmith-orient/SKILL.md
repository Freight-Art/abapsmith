---
name: abapsmith-orient
description: Checks what abapsmith can actually build on this SAP system before any write is attempted. Use at the start of any ABAP task that creates, changes, or deletes an object, or when a write was refused.
---

# Orient before writing

abapsmith writes a **fixed enum of object types**. Most ABAP types are not in it.
Check here before planning any create.

## The writable set

<!-- BEGIN generated: scripts/gen-capability-table.mjs -->

**Creatable and writable (22).** Everything else is not.

- `CLAS/OC` — write shape `source`, delete: yes
- `INTF/OI` — write shape `source`, delete: yes
- `PROG/P` — write shape `source`, delete: yes
- `PROG/I` — write shape `source`, delete: yes
- `FUGR/F` — write shape `source`, delete: yes
- `FUGR/FF` — write shape `source`, delete: yes
- `FUGR/I` — write shape `source`, delete: yes
- `DDLS/DF` — write shape `source`, delete: yes
- `DDLX/EX` — write shape `source`, delete: yes
- `DCLS/DL` — write shape `source`, delete: yes
- `SRVD/SRV` — write shape `source`, delete: yes
- `BDEF/BDO` — write shape `source`, delete: no
- `XSLT/VT` — write shape `source`, delete: yes
- `TYPE/DG` — write shape `source`, delete: yes
- `DRUL/DRL` — write shape `source`, delete: yes
- `TABL/DT` — write shape `source`, delete: yes
- `TABL/DS` — write shape `source`, delete: yes
- `DTEL/DE` — write shape `properties`, delete: yes
- `DOMA/DD` — write shape `properties`, delete: yes
- `TTYP/DA` — write shape `properties`, delete: yes
- `MSAG/N` — write shape `properties`, delete: yes
- `SRVB/SVB` — write shape `properties`, delete: yes

**Bridge-only create types (3).** ADT REST has no usable create for these, so abapsmith generates a throwaway `IF_OO_ADT_CLASSRUN` class into `$TMP` and runs it. The bridge never updates an existing object. Whether it can delete one — and so whether the create is reversible — differs per type; see each bullet. A bullet marked **create REFUSED** creates nothing at all: the bridge is described but abapsmith will not run it, in any package (1 of 3 today).

- `DEVC/K` — `software_component: "LOCAL"` goes over ADT REST; anything else needs the bridge and a transport request. Delete works only on an EMPTY package — no sub-packages, no TADIR objects. Delete: runs over the same bridge (src/adt/package-delete.ts) the create uses, gated by the same empty-package limit noted above; the create's journal entry no longer marks itself irreversible; but IF_PACKAGE~DELETE's failure behaviour is not itself live-verified.
- `VIEW/DV` — **create REFUSED** — the bridge would build a single-table database view (DD25V class 'D'); no joins, no SE54 maintenance dialog. It is never run: the create is refused client-side, before any ADT traffic, for every package — $TMP and an omitted `package` included. A transportable package fails RS_CORR_INSERT (TK103); $TMP is the one package ever attempted, and it lands an active view unregistered in TADIR, so undeletable and unundoable here. Create the view in SE11/SE14, or use a CDS view (DDLS/DF). Change is not supported either. Delete: a bridge delete endpoint exists (src/adt/view-delete.ts), but no live run has ever produced a registered view for it to delete, and abapsmith no longer creates one — unexercised, not proven.
- `TRAN/T` — creates a REPORT transaction (dynpro 1000) starting an existing program; change is still not supported. Delete: the bridge calls RPY_TRANSACTION_DELETE, but its parameter set is inferred from RPY_TRANSACTION_INSERT's `transaction` parameter, not transcribed from a capture of the delete FM itself — not live-verified, and whether it registers in TADIR/transport is unknown.

**Creatable, but the create site is outside this registry (3).** No `create` field in `REGISTRY` at all — these bypass the `create.verified` gate on purpose (src/adt/capabilities.ts, ~lines 52-57). Not a classrun bridge: each has its own create call.

- `ENHO/XH` — src/adt/enhancement-bridge.ts — createBadiImplementation.
- `ENHO/XHH` — src/adt/enhancement-hook.ts — createHookImplementation (PROG/P host only).
- `ENHS/XS` — src/adt/enhancement-bridge.ts — createEnhancementSpot.

**Writable but NOT creatable (2).** Change an existing one; creating fails.

`DDLA/ADF` `ENQU/DL`

**Not reachable by any write (6).** Do not probe for a write route.

- Readable, not writable (0): _(none)_
- Not readable either (6) — `abap_read` refuses these with UNSUPPORTED, from the same `unsupported` entry in src/adt/capabilities.ts: `SHLP/DH` `PROG/PS` `PROG/PC` `PROG/PT` `SUSO/B` `TABL/DI`

<!-- END generated -->

A type in either bullet above has **no write route at all**. Searching for a workaround wastes
turns. Say it is out of scope and stop.

## What abap_read refuses outright

`abap_read` refuses eight types before any network call, without probing:
`SHLP/DH` `VIEW/DV` `TRAN/T` `PROG/PS` `PROG/PC` `PROG/PT` `SUSO/B` `TABL/DI`.

Six of these are not real ADT object types on this release — no discovery
collection exists for them, so there is no URI to build. Menu Painter /
Screen Painter / SE11-subobject territory.

`VIEW/DV` and `TRAN/T` are different: real ADT concepts, but with no
ADT-readable collection to resolve a URI against. `abap_write` can create a
transaction through the classrun bridge, but there is no read-back — a
transaction you just created cannot be read again by abapsmith, ever. A
classic view cannot be created either: that bridge exists but is refused for
every package, `$TMP` included, so `VIEW/DV` is neither readable nor
creatable here. Use SE11/SE14, or a CDS view (`DDLS/DF`).

## Two write shapes

`source` types take ABAP/DDL text. `properties` types take a **complete XML
descriptor**, and a write REPLACES the whole document — omit a field and you
delete it. Never send a partial descriptor.

## Mode

`read` < `edit` < `admin`. Write tools are absent from `tools/list` in `read`
mode — a missing `abap_write` means the mode is wrong, not the tool.

`ABAP_MODE` is the current way to set this. A legacy `ABAP_ALLOW_WRITE=true`
flag grants ordinary write access too, but only when `ABAP_MODE` itself is
unset — it does not layer on top of an explicit mode.

**Per-feature ceilings are not implied by base write access.** Each is its
own opt-in, checked independently of `ABAP_MODE=edit`/`admin`:

- **Transport release** (`abap_transport_release`) — `ABAP_MODE=admin` by
  default, or `edit` mode plus the explicit override
  `ABAP_ALLOW_TRANSPORT_RELEASE=true`. Legacy path: that same flag plus
  `ABAP_ALLOW_WRITE=true` when `ABAP_MODE` is unset.
- **Transport delete** (`abap_transport` `operation=delete`) — `ABAP_MODE=admin`
  only. There is no legacy flag that grants it; ordinary write access
  (`edit`) never does either.
- **`abap_ui` `mode=press`** — needs `ABAP_MODE=admin` **and** the separate
  `ABAP_ALLOW_UI_PRESS=true`, both checked at call time, not at registration.
- **`abap_dumps` `variables`** — `ABAP_ALLOW_DUMP_VARIABLES=true`, independent
  of `ABAP_MODE` and allowed even under `read`. Enforced twice: the field is
  absent from the advertised schema when off, and refused again at call time
  if it somehow arrives anyway.
- **`abap_data_preview`** — the whole tool is gated by
  `ABAP_ALLOW_DATA_PREVIEW=true`, independent of `ABAP_MODE` and allowed even
  under `read`.

**`confirm` only narrows a ceiling — it never widens one.** Echoing a
transport/request number, or passing `confirm:true`, arms an action that the
server-side ceiling already permits; it cannot substitute for `ABAP_MODE`,
`ABAP_ALLOW_TRANSPORT_RELEASE`, `ABAP_ALLOW_UI_PRESS`, or any other flag. A
`confirm` on a call the ceiling would refuse is refused exactly the same as
if `confirm` had been omitted.

**A system that reports itself productive, or that cannot be proven
otherwise, refuses writes outright.** No flag overrides this lockout — it is
checked in addition to, not instead of, every ceiling above.

## The tool set

Two surfaces ship. **`v1` is the default** — one tool per job:

| Job | Tool |
|---|---|
| Find objects, usages, BOs, FPM configs | `abap_search` |
| Read source or descriptor | `abap_read` |
| Create / change / delete | `abap_write` |
| Activate separately | `abap_activate` |
| Execute a class or report | `abap_run` |
| ABAP Unit | `abap_test` |
| Static checks | `abap_atc` |
| Short dumps | `abap_dumps` |
| Debugger | `abap_debug`, `abap_debug_vars`, `abap_debug_value` |
| History and undo | `abap_journal` |
| Transports | `abap_transport`, `abap_transport_release` |
| BOPF | `abap_bopf`, `abap_bopf_edit`, `abap_bopf_test`, `abap_bopf_delete` |
| Enhancements | `abap_enh` |
| OData service contract | `abap_service` |
| FPM / Web Dynpro (read-only) | `abap_fpm_read` |
| Table rows | `abap_data_preview` |
| Open in GUI / browser | `abap_ui`, `abap_open_url` |

**`v2`** (`ABAP_TOOL_SURFACE=v2`) collapses the same capability into six:
`abap_find`, `abap_read`, `abap_write`, `abap_debug`, `abap_adt`, and `abap_do` —
which absorbs activation, execution, journal, transports, BOPF and enhancements as
*actions*. Call `abap_do({})` for the catalogue. `abap_adt` is a GET-only raw ADT
escape hatch; reach for it last.

**Check `tools/list` rather than assuming.** A name from the wrong surface returns
unknown-tool; `abap_data_preview` and `abap_transport_release` are also gated off by
config even on v1.

## Package decides reversibility

- `$TMP` — no transport, no `corr_nr`. **Never reaches production.**
- Any other package — transportable; `corr_nr` is REQUIRED. See
  `abapsmith-put-work-on-a-transport`.

Default to `$TMP` unless the task says otherwise.

## Where to go next

| Task | Skill |
|---|---|
| Create/change any object | `abapsmith-create-an-object` |
| Domain, data element, table, table type | `abapsmith-create-ddic-objects` |
| CDS + behavior + service binding | `abapsmith-create-a-rap-service` |
| Class, interface, program, function group | `abapsmith-write-abap-source` |
| BAdI, enhancement spot, source plug-in | `abapsmith-enhance-standard-code` |
| BOPF business object | `abapsmith-edit-a-bopf-object` |
| Get a transport request, or release one | `abapsmith-put-work-on-a-transport` |
| Undo a wrong write, or read undo's refusals | `abapsmith-recover-a-bad-write` |

Something failed at runtime: `abap_dumps` for the short dump, then `abap_debug`.
`abap_debug` only catches breakpoints it triggers itself (`run` is required on
`action:"start"`) under the configured user — it cannot arm a listener and wait
for someone else's session to hit it.
