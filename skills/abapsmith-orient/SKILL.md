---
name: abapsmith-orient
description: Checks what abapsmith can actually build on this SAP system before any write is attempted. Use at the start of any ABAP task that creates, changes, or deletes an object, or when a write was refused.
---

# Orient before writing

abapsmith writes a **fixed enum of object types**. Most ABAP types are not in it.
Check here before planning any create. "Where is X used?" or "what does this
button do?" is not a write question at all — that is `abapsmith-research-code`.

Task names a package? Read it first with `abap_read {"object":"<PKG>","type":"DEVC/K"}`
before searching or guessing object names — see `abapsmith-explore-a-package`.

## What can be written

`abap_write` accepts a fixed set of types — creating, changing, deleting and
activating each work differently per type. The full generated table (every
type: write shape, delete support, and what `abap_read` refuses) is in
`skills/abapsmith-create-an-object/writable-types.md`. `abap_read` refuses
`PROG/PS`, `PROG/PC` and `PROG/PT` outright — no ADT resource exists for
them on this release. Any refusal names the writable list itself in
`details.writable`.

## Mode

`read` < `edit` < `admin`. Write tools are absent from `tools/list` in `read`
mode — a missing `abap_write` means the mode is wrong, not the tool.

`ABAP_MODE` is the current way to set this. A legacy `ABAP_ALLOW_WRITE=true`
flag grants ordinary write access too, but only when `ABAP_MODE` itself is
unset — it does not layer on top of an explicit mode.

**Per-feature ceilings are not implied by base write access.** Each is its
own opt-in, checked independently of `ABAP_MODE=edit`/`admin`, and documented
in its own area skill: `ABAP_ALLOW_TRANSPORT_RELEASE`, `ABAP_ALLOW_UI_PRESS`,
`ABAP_ALLOW_DUMP_VARIABLES`, `ABAP_ALLOW_DATA_PREVIEW`.

**`confirm` only narrows a ceiling — it never widens one.** Echoing a
transport/request number, or passing `confirm:true`, arms an action that the
server-side ceiling already permits; it cannot substitute for `ABAP_MODE` or
any per-feature flag. A `confirm` on a call the ceiling would refuse is
refused exactly the same as if `confirm` had been omitted.

**A system that reports itself productive, or that cannot be proven
otherwise, refuses writes outright.** No flag overrides this lockout — it is
checked in addition to, not instead of, every ceiling above.

## The tool set

One tool per job:

| Job | Tool |
|---|---|
| Find objects, usages, BOs, FPM configs | `abap_search` |
| Read source or descriptor | `abap_read` |
| Create / change / delete | `abap_write` |
| Activate separately | `abap_activate` |
| Execute a class or report | `abap_run` |
| ABAP Unit | `abap_test` |
| Static checks | `abap_atc` |
| List/apply position-driven quick fixes | `abap_quick_fix` |
| Short dumps | `abap_dumps` |
| Debugger | `abap_debug`, `abap_debug_vars`, `abap_debug_value` |
| History and undo | `abap_journal` |
| Transports | `abap_transport`, `abap_transport_release` |
| BOPF | `abap_bopf`, `abap_bopf_edit`, `abap_bopf_test`, `abap_bopf_delete` |
| Enhancements | `abap_enh` |
| OData service contract | `abap_service` |
| FPM / Web Dynpro (read-only) | `abap_fpm_read` |
| Browse IMG (SPRO) customizing structure | `abap_img` |
| Change IMG (SPRO) customizing values | `abap_img_edit` |
| Table rows | `abap_data_preview` |
| Open in GUI / browser | `abap_ui`, `abap_open_url` |

## Package decides reversibility

- `$TMP` — no transport. **Never reaches production.**
- Any other package — transportable; the transport request is resolved per
  `ABAP_ALLOW_TRANSPORTS` (omit `corr_nr` under the default `auto`), see
  `abapsmith-put-work-on-a-transport`.

Default to `$TMP` unless the task says otherwise.

## Where to go next

| Task | Skill |
|---|---|
| Create/change any object | `abapsmith-create-an-object` |
| Domain, data element, table, table type | `abapsmith-create-ddic-objects` |
| CDS + behavior + service binding | `abapsmith-create-a-rap-service` |
| Class, interface, program, function group | `abapsmith-write-abap-source` |
| Write or run ABAP Unit tests | `abapsmith-write-abap-unit-tests` |
| BAdI, enhancement spot, source plug-in | `abapsmith-enhance-standard-code` |
| BOPF business object | `abapsmith-edit-a-bopf-object` |
| Browse IMG (SPRO) customizing structure | `abapsmith-browse-img-customizing` |
| Change an IMG (SPRO) customizing value | `abapsmith-maintain-img-customizing` |
| Add a custom fluid tool/plugin | `abapsmith-write-a-fluid-plugin` |
| Get a transport request, or release one | `abapsmith-put-work-on-a-transport` |
| Undo a wrong write, or read undo's refusals | `abapsmith-recover-a-bad-write` |
| Survey an unfamiliar package or object | `abapsmith-explore-a-package` |
| Where is X used, or what does this button do | `abapsmith-research-code` |
| Run ABAP Unit, and fix what fails | `abapsmith-run-tests-and-fix` |
| ATC findings and quick fixes | `abapsmith-check-code-quality` |
| A run short-dumped or gave a wrong value | `abapsmith-debug-a-failing-run` |
