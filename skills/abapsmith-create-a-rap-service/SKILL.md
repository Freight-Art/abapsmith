---
name: abapsmith-create-a-rap-service
description: Builds a RAP stack — CDS view, behavior definition, service definition, service binding — in the correct order. Use when creating or extending an OData service from ABAP RAP artifacts.
---

# RAP service

All five artifacts are creatable here. The chain is order-locked.

```
DDLS/DF   CDS view              source
  ↓
BDEF/BDO  behavior definition   source   ← cannot be deleted
  ↓
CLAS/OC   behavior pool         source
  ↓
SRVD/SRV  service definition    source
  ↓
SRVB/SVB  service binding       properties (XML)
  ↓
PUBLISH — a human does this, not abapsmith
```

`DDLX/EX` (metadata extension) is optional and hangs off the CDS view.
`DCLS/DL` (access control) is also creatable here and is optional.

Activate each artifact before writing the next. A later artifact referencing an
inactive earlier one passes PUT and fails activation.

## Before you create a BDEF

**`BDEF/BDO` delete is disproven.** A created behavior definition could not be
removed through abapsmith — DELETE reported success twice and the object was still
there. Say so before creating one in a real package. There is no cleanup path.

## Per-artifact constraints

**`DDLS/DF`** — Write classic `define view NAME as select from …`. `define view
entity` is a newer-release form; where the `ENTITY` keyword is rejected, fall back
to the classic form rather than hunting for a syntax error. Service definitions
likewise use `define service NAME { expose …; }` — no `definition` keyword.

For a `DDLX/EX` extension to activate, the view text must carry
`@Metadata.allowExtensions: true`. Otherwise: *"Annotation 'Metadata.allowExtensions'
missing"*.

**`BDEF/BDO`** — On-prem supports `implementation unmanaged` only; `managed` is not
possible on premises. On 7.56+ BDEF strict mode the bare
`implementation {managed|unmanaged};` header is obsolete and is a syntax error —
a known limitation, not worked around here.

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

**OData V2 only** on this release; there is no V4 binding type to offer.

## Publishing

abapsmith **never publishes**. Activating a binding does not create an OData
service. Asking for `$metadata` on an unpublished binding returns
`SERVICE_NOT_PUBLISHED` — the binding name is correct, the publish step is missing.

Tell the user to publish in ADT. Do not report the service as available until they have.

Before writing a client, a Fiori app, or a test against the service, call
`abap_service` first — it reads the live OData contract (entity sets, keys,
navigation, CRUD/search/page permissions) and doubles as the publish check
above, without guessing field names from the CDS view.

## Teardown order

Deleting a `SRVD/SRV` fails with `SDDIC_ADT_SRVD207` (*"Service Definition &1 is
still used"*) while any binding references it. Correct order:

```
unpublish binding (human) → delete SRVB → delete SRVD → delete DDLS
```

The `BDEF/BDO` in the middle cannot be deleted at all.

## Verify

Activation returns 200 even on failure — check `chkl:messages` for `type: "E"` on
every artifact. Full checklist: `abapsmith-create-an-object`.
