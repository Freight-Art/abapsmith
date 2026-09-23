---
name: abapsmith-create-a-rap-service
description: Builds a RAP stack — CDS view, behavior definition, service definition, service binding — in the correct order. Use when creating or extending an OData service from ABAP RAP artifacts.
---

# RAP service

All five artifacts are creatable here. The chain is order-locked.

```
DDLS/DF   CDS view              source
  ↓
BDEF/BDO  behavior definition   source
  ↓
CLAS/OC   behavior pool         source
  ↓
SRVD/SRV  service definition    source
  ↓
SRVB/SVB  service binding       properties (XML)
  ↓
PUBLISH   abap_service op="publish"   admin-gated, confirm required
```

`DDLX/EX` (metadata extension) is optional and hangs off the CDS view.
`DCLS/DL` (access control) is also creatable here and is optional.

Activate each artifact before writing the next. A later artifact referencing an
inactive earlier one passes PUT and fails activation.

## Generate the whole stack with abap_rap

For a single-entity RAP service off one existing table, `abap_rap` builds
the whole chain above in one call — root view, projection view, behavior
definition(s), the behavior class, service definition and service binding —
with names derived from one prefix and fields mapped automatically. Run it
with `dry_run: true` first and read the consistency summary (field
coverage, the etag/draft fields it found) before writing anything; then run
it again for real. On a release that rejects `define view entity`
(see "Per-artifact constraints" below), pass `cds_form: "classic"`.
Publishing is still a separate step through `abap_service op="publish"`
(see "Publishing" below) — `abap_rap` does not publish. Full parameter
reference: [doc/TOOLS/rap.md](../../doc/TOOLS/rap.md).

## Before you create a BDEF

**`BDEF/BDO` delete works.** A raw lock plus DELETE against a live-created
behavior definition is confirmed: the object was left absent from repository
search and from the object URI itself. Clean up with `abap_write mode=delete`;
that tool-surface path has not yet been exercised end to end.

## Per-artifact constraints

**`DDLS/DF`** — Write classic `define view NAME as select from …`. `define view
entity` is a newer-release form; where the `ENTITY` keyword is rejected, fall back
to the classic form rather than hunting for a syntax error. Service definitions
likewise use `define service NAME { expose …; }` — no `definition` keyword.

For a `DDLX/EX` extension to activate, the view text must carry
`@Metadata.allowExtensions: true`. Otherwise: *"Annotation 'Metadata.allowExtensions'
missing"*.

**`BDEF/BDO`** — A `managed;` behavior definition over a classic CDS root view
backed by a persistent table was created and activated live on this release, so
`managed` is not off-limits on premises; do not assume `unmanaged` is the only
option. On 7.56+ BDEF strict mode the bare `implementation {managed|unmanaged};`
header is obsolete and is a syntax error — a known limitation, not worked around
here.

**`SRVD/SRV`** — May expose only DDIC-based CDS views, CDS projection views, or
custom entities. An **abstract** CDS entity activates cleanly and then short-dumps
at publish time — the failure lands far from the cause.

**`SRVB/SVB`** — properties-shape: send the complete XML descriptor, not source.

**Do not guess this XML.** `abap_search` for an existing `SRVB/SVB`, read it with
`abap_read { format: "raw" }` (the default read is refused for this type), and
copy its shape. Guessing costs several failed writes and can kill the session.

Three things the descriptor must carry:

- `adtcore:description` — omit it and the create is rejected with *"The
  description is missing"*.
- `<adtcore:packageRef adtcore:name="$TMP"/>` **inside the XML**. The top-level
  `package` write argument is not enough for this type.
- Name limit 26 characters.

**V4 SRVB creation from scratch works too.** The XML shape above was first
exercised for V2; on 2026-09-15 a V4 binding (`ZV82_SB4`) was created from
scratch through `abap_write` against A4H the same way, then published — see
"Publishing" below. Copy an existing V4 binding's XML (`abap_search` +
`abap_read { format: "raw" }`) the same way as for V2; the three
requirements above (`adtcore:description`, `packageRef` inside the XML,
26-character name limit) apply to both.

## Publishing

Activating a binding does not create an OData service — publishing is a
separate step. Asking for `$metadata` on an unpublished binding returns
`SERVICE_NOT_PUBLISHED` — the binding name is correct, only the publish step
is missing.

Publish with `abap_service op="publish" binding="<name>" confirm="<name>"`.
This needs `ABAP_MODE=admin` (the `allowServicePublish` ceiling — ordinary
write access does not grant it), and `confirm` must echo the binding name
exactly. Call it once without `confirm` first: that runs as a dry run,
changes nothing, and reports what publishing would do — check this before
committing.

On success it returns the same contract `abap_service` always returns
(entity sets, keys, navigation, CRUD/search/page permissions) plus the URL
that became reachable — the service's runtime path and its `$metadata`
path. Report that URL; do not just say "published".

Publish has been run live on A4H, 2026-09-15, for both V2 and V4 bindings,
each confirmed by a follow-up read. It can time out at the ADT layer on a
slow appliance (a V2 publish there hit a 60s HTTP timeout on the first
attempt) without telling you whether the POST landed. To find out: re-read
the binding first (`abap_service op="read"` or the automatic post-publish
read) — a live `$metadata` means it landed, `SERVICE_NOT_PUBLISHED` means it
did not. Either way, retrying `op="publish"` is safe: `abap_service` is
marked idempotent, since publishing an already-published binding re-asserts
the same end state rather than accumulating.

To take it back, call `abap_service op="unpublish"` the same way — same
gate, same `confirm` echo. There is no undo for either direction:
`abap_journal mode=undo` refuses a publish or unpublish entry outright and
points at the opposite call instead of attempting to reverse it.

Before writing a client, a Fiori app, or a test against the service, call
`abap_service` (`op="read"`, the default) first — it reads the live OData
contract without guessing field names from the CDS view.

## Teardown order

Deleting a `SRVD/SRV` fails with `SDDIC_ADT_SRVD207` (*"Service Definition &1 is
still used"*) while any binding references it. Correct order:

```
unpublish binding (abap_service op="unpublish") → delete SRVB → delete SRVD → delete BDEF → delete DDLS
```

Every artifact in the chain is deletable.

## Verify

Activation returns 200 even on failure — check `chkl:messages` for `type: "E"` on
every artifact. Full checklist: `abapsmith-create-an-object`.
