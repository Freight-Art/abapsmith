# Read & search

Reading and locating ABAP objects. For the OData contract behind a RAP
service binding, see [abap_service](abap-service.md) instead.

## abap_read

Read the source, metadata or outline of an ABAP object.

**Availability**: case 2 — always registered, unconditional (a pure read).

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `object` | string | yes | — | Object reference: bare name, `"class ZCL_FOO"`, or a raw ADT URI. |
| `type` | string | no | — | ADT type hint, e.g. `CLAS/OC`, to disambiguate a bare name. |
| `method` | string | no | — | Read one method's source instead of the whole class. |
| `outline` | boolean | no | — | Return the structural outline (members/methods) instead of full source. |
| `offset` | number (int, 1–999999) | no | — | 1-based first line to return. |
| `limit` | number (int, 1–999999) | no | — | Number of lines to return. |
| `enhancements` | boolean | no | — | Also report enhancement anchors/implementations on this object. |
| `version` | enum `active` \| `inactive` | no | `active` | Which version to read. |
| `format` | enum `raw` | no | — | Return unprocessed source instead of the rendered/annotated form. |
| `view` | enum `history` \| `diff` \| `definition` | no | — | `history`: list the object's version feed (author, date, transport) instead of source/DDIC. `diff`: return unified-diff hunks between two versions — never two full sources. `definition`: element info / go-to-definition for the identifier at `line`/`column` — see ["view=\"definition\": element info and go-to-definition"](#viewdefinition-element-info-and-go-to-definition) below. Omit for a normal source/DDIC read. |
| `from` | string | `view="diff"` only | released version before `to` | Older side of the diff — a version number (e.g. `"66"`), a transport name, or the literal `"active"` for current source. |
| `to` | string | `view="diff"` only | newest released version | Newer side of the diff, same forms as `from`. |
| `context` | number (int, 0–20) | no | `3` | `view="diff"` only — unchanged context lines per hunk. |
| `line` | number (int, ≥1) | required with `view="definition"`; refused otherwise | — | 1-based source line — same convention as `abap_quick_fix`. Refused with `BAD_INPUT` together with `view="history"`/`"diff"`, and refused with `BAD_INPUT` if given with no `view` at all (it would silently be discarded by an ordinary read). |
| `column` | number (int, ≥0) | no | `0` | 0-based column — same convention as `abap_quick_fix`. Only meaningful with `view="definition"`; refused otherwise on the same terms as `line`. |
| `include` | enum `CLASS_INCLUDES` | no | `"main"` | Classes only — which class include to read; applies to the source read and to `view` alike. `"testclasses"` holds ABAP Unit tests; `"main"` never does. Always an explicit, disclosed choice — silently defaulting to `main` would hide changes made in another include. |
| `types` | string[] | no | — | `DEVC/K` only — filter the package listing to these kind codes, e.g. `["CLAS","DDLS"]`. Refused with `BAD_INPUT` against any other type. |
| `depth` | number (int, 1–3) | no | `1` | `DEVC/K` only — how many sub-package levels to list. `1` lists only the package itself. Refused with `BAD_INPUT` against any other type. |

Notes: response includes an etag (a content hash) — pass it back as
`abap_write`'s `expect_etag` to detect a concurrent change before writing.
`offset`/`limit` page long sources; a truncated response always names how to
fetch the rest. A function module named without its group — e.g.
`{"type":"FUGR/FF","object":"BUP_ROLES_GET_ALL"}` — resolves on its own: the
exact-name lookup goes out untyped and the group is read off the matching
row's `adtcore:uri`, since neither the name nor `adtcore:packageName` carries
it. This still refuses with `BAD_INPUT` when the search cannot settle the
group — naming every candidate group if more than one function group has a
module by that name, or asking for the group by hand if the search finds
nothing at all, which happens for generated function modules (e.g.
`ENQUEUE_E_TABLE`) that the repository search does not index: say
`"ENQUEUE_E_TABLE in ETABLE"` or `"ETABLE/ENQUEUE_E_TABLE"`.

### `SHLP/DH`, `VIEW/DV`, `TRAN/T`: catalog reads, not ADT source

Search helps, classic (DDIC) views and transactions have no ADT-readable
collection — a GET against any of them 404s or returns a content-free stub.
`abap_read` reaches all three a different way: a plain-text `SELECT` against
the underlying catalog tables, issued over the ADT freestyle data-preview
endpoint and rendered as pseudo-DDL (`src/adt/catalog-query.ts` builds the
SQL, `src/adt/catalog-read.ts` runs it and renders the result). This is not
the classic fluid bridge that `abap_write` uses for these three types — it
needs no generated `IF_OO_ADT_CLASSRUN` class, so it works under
`ABAP_MODE=read` as well as `edit`/`admin`.

Each type reads from its own set of tables and renders its own section
layout:

- **`SHLP/DH` (search help)** — header from `DD30L`/`DD30T` (selection
  method, selection method type, text table, hot key, dialog type,
  elementary vs. collective); `PARAMETERS` from `DD32S`; `INCLUDES` (for a
  collective help) from `DD31S`; `ASSIGNMENTS` from `DD33S`; plus two
  DDL-only sections not returned as separate structured sections —
  `USED BY DATA ELEMENTS` from `DD04L` and `INCLUDED BY` from `DD31S`
  (which other collective help includes this one). `DD33S-VALUEDIREC` is
  decoded from the fixed values of domain `VALUEDIREC`, read live from
  `DD07V` on A4H (`I` import, `C` copy, `E` export), with a provenance note;
  a code outside that set prints as-is and adds a note flagging it. DDIC writes a `DD31S` row
  pointing an elementary search help at its own interface (`SUBSHLP` =
  `SHLPNAME`, `SHPOSITION` `0001`) even when the caller defined no includes
  at all — measured live on A4H 2026-09-15 on a freshly created elementary
  search help with two interface fields and no includes/assignments, and
  confirmed as DDIC's general representation (not a write-path artifact) by
  reading `DD31S` for five standard SAP elementary search helps
  (`/UI2/GROUPS_SH`, `/AIF/MESSAGE_CLID_SHLP`, `/UI5/PURPOSE`,
  `/BA1/F4_FX_RATETYPE`, `/AIF/FILEDIALOG`), each with exactly that one
  self-row. `abap_read` filters that row out of `INCLUDES`, `INCLUDED BY`
  and the `includeCount` summary field — it is not an include relationship
  — and adds a note when it does so; `ASSIGNMENTS` rows are left alone,
  since there is no equivalent evidence for what a self-referencing `DD33S`
  row would mean.
- **`VIEW/DV` (classic view)** — header from `DD25L`/`DD25T` (root table,
  aggregate type, view class, read-only flag, view grant, application
  class, master language) plus `TVDIR` (package and screen, when a
  generated SE54 maintenance dialog exists for the view — absent
  otherwise); `BASE TABLES` from `DD26S` (including any foreign-key join);
  `FIELDS` from `DD27S` (view field, data element, source table/field, key
  and read-only flags).
- **`TRAN/T` (transaction)** — header from `TSTC`/`TSTCT` (program, initial
  screen, class info, message area) plus a parsed `PARAMETERS` block from
  `TSTCP` (a report transaction shows `STARTS:`; a parameter/variant
  transaction shows the raw `TSTCP-PARAM` string and its parsed
  assignments); `AUTHORIZATION` from `TSTCA`; `ASSIGNED TO ROLES` from
  `AGR_TCODES`. This is strictly more than the old generic-VIT-bridge read
  ever returned (no call parameters, no authorization checks, no role-menu
  membership), and it works in every `ABAP_MODE`, unlike the fluid bridge
  `abap_write` needs for creating or changing a transaction.

**Caps and truncation.** Every detail list (`PARAMETERS`/`INCLUDES`/
`ASSIGNMENTS`/`USED BY DATA ELEMENTS`/`INCLUDED BY` for `SHLP/DH`;
`BASE TABLES`/`FIELDS` for `VIEW/DV`; `AUTHORIZATION`/`ASSIGNED TO ROLES`
for `TRAN/T`) is capped at 200 rows; the description-text query (one row per
language) is capped at 50. Hitting either cap always adds a note naming what
was capped — abapsmith never truncates a list silently. Header/detail
single-row lookups are capped at exactly one row, since there is only ever
one meaningful row to find.

**Not verified end to end.** These queries were run directly against A4H
(NetWeaver 7.54, client 001) and returned real column lists and sample
rows, so the SQL and the rendering are grounded in live data. The assembled
`abap_read` code path itself — dispatch through `resolveObject` into
`readSearchHelp`/`readClassicView`/`readTransaction` — has not been
exercised against a live MCP server, because the server this project talks
to runs a previously released bundle, not this working tree. Treat the read
side as implemented against live-captured data, not live-verified end to
end.

### view="definition": element info and go-to-definition

Given `line` (1-based) and `column` (0-based, default 0), `view="definition"`
answers what the identifier at that position is and where it comes from,
using three ADT endpoints (`src/adt/element-info.ts`):
`codecompletion/elementinfo` for the identifier itself,
`navigation/target?filter=definition` for its declaration site, and — for
an interface method only — `usageReferences` (where-used) for the classes
that implement it.

The response can carry up to five parts:

- Header fields: `element` (name), `kind`, `visibility`, `level`,
  `abapType`.
- **DEFINITION**: the declaring location as a URI plus line/column, and a
  literal, copy-pasteable `abap_read {"object":"...","type":"..."}` call
  for it. Only class and interface targets get the object/type filled in;
  other target kinds still report the location, without a guessed call.
- **SIGNATURE** (methods, function modules) or **COMPONENTS** (structured
  types): a table of parameters or fields. A callable with no parameters —
  an interface method, a class method, or a function module (every one,
  see the FUGR/FF bullet below) — renders SIGNATURE as `(none)` rather than
  omitting the section.
- **DOC**: short text and ABAP Doc for the identifier, if any.
- **IMPLEMENTED BY** (interface methods only): the implementing classes,
  from a where-used lookup — see below. Reached either from a use site
  whose navigation target resolves into the interface, or directly from
  the interface's own method declaration — see below.

**Position convention.** `line` is 1-based and `column` is 0-based — the
same convention `abap_quick_fix` uses. This differs from `offset`/`limit`
elsewhere in this table, which page whole lines of a normal read.

**Refusals** (`assertViewCompatible`, `src/tools/read.ts`):

| Input | Result |
|---|---|
| `view="definition"` combined with `format="raw"` | `UNSUPPORTED` |
| `view="definition"` combined with `enhancements=true` | `UNSUPPORTED` |
| `view="definition"` combined with `version="inactive"` | `UNSUPPORTED` (`version="active"` is allowed — a no-op) |
| `view="definition"` combined with `outline=true` | `UNSUPPORTED` |
| `view="definition"` combined with `method=...` | `UNSUPPORTED` |
| `view="definition"` combined with `from`/`to`/`context` | `UNSUPPORTED` |
| `view="definition"` with no `line` | `BAD_INPUT` — a definition lookup is position-driven; without a line there is no element to resolve. |
| `line`/`column` given with `view="history"` or `view="diff"` | `UNSUPPORTED` |
| `line`/`column` given with no `view` at all | `BAD_INPUT` — an ordinary read would otherwise silently discard them. |
| `view="definition"` against a non-source object (nothing to resolve a position in) | `UNSUPPORTED` |
| `line` past the end of the object's source | `BAD_INPUT` |

**Gated as read, not write**, even though `codecompletion/elementinfo`
takes a POST carrying the whole object source. Every one of the three
endpoints is ADT's own read-only "what/where is this" surface, and none of
it returns anything `abap_write` could act on — unlike `abap_quick_fix`,
whose purpose is to produce an edit `abap_write` applies, and which is
gated write for exactly that reason. The POST body here is an artefact of
the wire protocol, not evidence of a side effect.

**ADT limitations, documented rather than hidden:**

- **Function modules resolve to name and type only.** For a `FUGR/FF`
  target, ADT's element info returns no visibility, no signature and no
  documentation — verified live against `RFC_PING` (fixture 957). An empty
  SIGNATURE section for a function module is this limitation, not "no
  parameters."
- **A position with nothing resolvable is a successful answer, not an
  error.** ADT answers HTTP 200 either way, in one of two wire shapes:
  fixture 960's well-formed element-info document that names no element at
  all, or a zero-byte 200 body at a genuinely blank line (live-observed
  A4H, 2026-09-15). There is no fixture file for the zero-byte case —
  there are no bytes to pin, the same reason capture 898 is omitted from
  the repository. Either shape, abapsmith reports "no resolvable element
  at line L, column C" — a fact about the position, not a lookup failure.
- **A declaration site can go unreported for three different reasons, and
  the rest of the response still resolves.** The DEFINITION section can
  come back with no "declared at" line because: the position asked about
  IS the declaration itself, which ADT reports as HTTP 400,
  `NavigationFailure`, T100 key `ED`/`263`, "Definition location found;
  where-used list may be possible" (live-captured against
  `CL_ABAP_TYPEDESCR`'s `data ABSOLUTE_NAME …` line, A4H 2026-09-15);
  more than one implementation exists, so the declaration site is
  undecidable from this position (HTTP 422,
  `ExceptionMultipleNavigationTargets`, T100 key `SEDI_ADT`/`2`,
  "Navigation target undecidable: More than one implementation exists" —
  live-captured at an interface's own `METHODS` line with two implementing
  classes, A4H 2026-09-15); or ADT returned a target document that
  names no URI. All three are reported as prose in the DEFINITION section,
  not as an error — the header fields, SIGNATURE/COMPONENTS, DOC and
  IMPLEMENTED BY sections are all still answered from the element-info
  call, which is unaffected; only the "declared at" line is missing.
- **IMPLEMENTED BY runs from either of two starting points.** (a) A use
  site whose navigation target resolves into the interface — e.g. reading
  a class that calls `zif_x~run` through an interface reference, where the
  element info at `run` resolves to `INTF/IO` and the navigation target
  names the interface. (b) The object being read IS the interface
  (`INTF/OI`) — at the interface's own `METHODS run` declaration line, ADT
  names no navigation target (the position already is the declaration, see
  the ED263 case above), so there is nothing to navigate to; the
  where-used lookup runs anyway, using the position asked about as the
  declaration site. (b) is the natural "who implements this?" question
  asked from the one place navigation cannot answer it.
- **The implementer list is where-used-based, so it is static-analysis
  only.** `CALL FUNCTION lv_name`, `PERFORM (lv_form)`, `SUBMIT (lv_prog)`
  and other dynamic dispatch do not appear — the same blind spot
  `abap_search mode=where_used` has.
- **The implementer list is capped for display**
  (`IMPLEMENTATIONS_DISPLAY_MAX = 50` in `src/tools/read.ts`); truncation is
  marked in the response, never silent. ADT's `usageReferences` endpoint
  itself ignores every limit parameter, so the complete result set is
  always fetched before the cap is applied — fixture 961's capture, a
  two-implementer toy example, still took close to ten seconds; a
  cost-disclosure note is attached when the fetch is slow or the reference
  count is large.

**Not on the v2 tool surface.** `abap_read`'s v2 schema
(`abapReadInputSchema`, `src/tools/v2/schemas.ts`) does not expose
`view="definition"`, `line`, `column`, or `type` — its `view` values are
`source | contract | method | diff | metadata | outline | bopf | fpm`. v2's
own `diff` view is a separate, unimplemented concept, not the same thing as
v1's `view="diff"`.

**Evidence.** `live` (A4H, 2026-09-12): the three wire endpoints
themselves — `elementinfo` for an interface method call, an attribute, a
type, a local variable, a class's own method, and a function-module name
literal (fixtures 952-957); `navigation/target?filter=definition`
(fixture 958); the no-resolvable-element answer (fixture 960); and
`usageReferences` for an interface method's implementers (fixture 961).
`live` (A4H, 2026-09-15), a second pass: `usageReferences` returns no
implementers when read through `abap-adt-api`'s own vendor
`usageReferences()` parser — the namespace-prefix defect (capitalised
`usageReferences:` expected, lowercase `usagereferences:` actually sent)
that motivated parsing where-used locally instead; the zero-byte 200 body
at a blank line; and the `NavigationFailure` / ED263 answer at a position
that is itself a declaration, captured against `CL_ABAP_TYPEDESCR`'s `data
ABSOLUTE_NAME …` line. Still not verified live: the full refusal matrix
above, and the rendering of the three paths fixed on 2026-09-15 — the
declaration-itself wording, `SIGNATURE (none)`, and `IMPLEMENTED BY`
reached from an interface's own declaration — which are `tests`-only,
covered by `test/read-definition.test.ts` and `test/element-info-wire.test.ts`
against a fake connection, and have not themselves been re-run end to end
against a live server.

Example — resolving what `lo_probe->process( )` is and where it comes from:

```json
{
  "object": "ZCL_I91_PROBE",
  "type": "CLAS/OC",
  "view": "definition",
  "line": 35,
  "column": 25
}
```

Example — asking IMPLEMENTED BY directly at the interface's own method
declaration (entry point (b) above), rather than from a use site:

```json
{
  "object": "ZIF_MY_PROBE",
  "type": "INTF/OI",
  "view": "definition",
  "line": 3,
  "column": 11
}
```

### Package reads (`DEVC/K`)

`abap_read {"object":"ZSD","type":"DEVC/K"}` reads a package: its header,
then its contents (the ADT repository nodestructure, not DDIC pseudo-DDL —
a package is not a DDIC object). The response's `meta` carries the header
fields read from `GET /sap/bc/adt/packages/<name>` — `package_type`,
`description`, `super_package`, `software_component`, `transport_layer`,
`application_component`, `responsible` — plus `objects` (row count after any
`types` filter) and, when the package has direct sub-packages,
`sub_packages` (count). If the header read fails, those seven fields come
back `undefined` and a note says so explicitly: they are UNKNOWN, not
confirmed absent, and the node listing itself is unaffected.

The body has up to two extra sections ahead of the row listing:

- `OBJECTS BY TYPE` — a two-column count of rows by ADT type code (e.g.
  `CLAS/OC`, `DDLS/DF`), sorted by type.
- `SUB-PACKAGES` — the package's direct (depth-1) sub-packages, name and
  description.

Below those, the row listing itself: one row per object directly under the
package (and, at `depth` > 1, under its expanded sub-packages), each with
`type`, `name`, `description` and, when `depth` > 1, the `package` it came
from. Rows are sorted by type then name — never by package — so `offset`/
`limit` paging stays stable across calls regardless of which sub-package a
row came from.

`description` is never read from the node structure endpoint's own
`DESCRIPTION` column: live-verified (issue #74, `test/fixtures/live-captured/`
captures 884/885) that once a package's node list contains a `DEVC/K`
sub-package row, the wire's `DESCRIPTION` values are misaligned against the
`OBJECT_NAME` they are serialised next to — not by a constant offset, and
that misalignment is invisible from a single row, so it cannot be corrected
by re-shifting. Instead, every description is resolved by an exact
`(type, name)` key lookup against
`GET /sap/bc/adt/repository/informationsystem/search
?operation=quickSearch&query=<pattern>&packageName=<pkg>`, scoped by name
rather than pulled a whole package at a time: the names actually being
rendered under each package are grouped by their first character, and one
request is issued per distinct group (`query=Z*`, `query=B*`, …), merging
every group's results into the same keyed `(type, name)` map. This exists
because a single `query=*` per package hit its own `maxResults` cap on large
packages — `$TMP` has 11128 objects system-wide under that packageName — and
left the great majority of a 389-row rendered listing with an empty
description; scoping each request to one starting character of the rows
actually being shown keeps each request small and fast (live-verified
against `$TMP`: `query=Z*` returned 243 entries in 2.9s, correctly resolving
`ZTESTAI`) without giving up coverage. Only the rows actually being
rendered — never rows a `types` filter or paging discarded — drive the
groups. If a package's rendered rows span more distinct starting characters
than a bounded cap (issue #74: `PACKAGE_DESCRIPTION_GROUP_CAP`, in the low
tens), the fan-out is capped and a single broader `query=*` request is used
instead, noted in the output; this keeps the number of requests bounded
rather than open-ended. Each group's request is independent and individually
non-fatal — one group's failure never empties another group's descriptions
— and every request still carries its own bounded `maxResults` cap (retuned
down for these narrower, per-prefix queries). A row that lookup can't
resolve — because it genuinely has no description, or its group's request
failed or was capped — renders an **empty** description, never a guessed or
positional value, and a note counts how many rows that affected and names
which group(s), if any, failed. A description lookup failure is never fatal
to the read; the listing still renders in full with empty descriptions in
the affected group(s) only.

These requests are not all fired at once: at most 2 are in flight
concurrently (across every package touched by one `abap_read`, not just
within one package's own groups), and the header fetch runs to completion
first rather than alongside them. This was tightened after a live run
against `$TMP` (16 groups) fired all of them concurrently and 8 came back
`SessionBusyError` — the ADT session queue serialises requests per
connection, and 2 matches the connection pool's own default read
concurrency.

`types` restricts the listing to given kind codes (matched against the ADT
type, e.g. `"CLAS"` matches `CLAS/OC`) before counting or paging. A `types`
value that matches nothing produces a note explaining that a zero match does
not prove the package has none of that kind — the code may be mistyped —
and suggests comparing against an unfiltered read or `abap_search`.

`depth` (1–3, default 1) recurses into sub-packages breadth-first, one
nodestructure round trip per sub-package per level; level 1 (the package
itself) is free of that cost. The recursion is capped at 25 total
nodestructure round trips across the whole call (independent of `depth`):
if the cap is reached before every sub-package at the requested depth has
been expanded, a note lists which sub-packages were NOT expanded — they are
not hidden, just not descended into — each with the `abap_read` call to
fetch it directly. `depth` and `types` are both refused with `BAD_INPUT`
against any type other than `DEVC/K`.

An empty package (no contents at any level reached) answers with the ADT
node structure endpoint's actual wire behavior: HTTP 200 with a **zero-byte
body**, not a 404 and not an empty XML document (live-verified,
`test/fixtures/live-captured/INDEX.md` captures 854, 877-881). abapsmith
reports this as "no contents", not as an error.

To open a row, read it directly: `abap_read {"object":"<name>","type":"<type>"}`.
`PARENT_NAME` is empty on every row at package level, so no row needs
parenting information to open. A `FUGR/F` row is a function group; one of
its modules is read as `abap_read {"object":"<GROUP>/<MODULE>","type":"FUGR/FF"}`
— naming guidance only, not a claim about what shape a function group takes
at package level: none of the committed live nodestructure captures
(852, 853, 855) contain a `FUGR` row of any kind, so that shape has not
itself been observed.

Package reads are available under `ABAP_MODE=read` (read-only; the header
and nodestructure requests never deploy or write anything).

### Catalog reads (`SUSO/B`, `TABL/DI`)

Two types have no ADT object resource of their own, so `abap_read` renders
them directly from DDIC catalog tables instead of resolving a URI. Because
there is no source/outline/history/raw-XML axis to apply to a catalog
render, every parameter other than `object`, `type`, `offset` and `limit`
is refused with `BAD_INPUT` against either of them (naming the parameter
that was dropped, not silently discarding it) — this includes `types` and
`depth`, which are `DEVC/K`-only.

- **`SUSO/B` (authorization object)** — `abap_read {"object":"S_TABU_NAM","type":"SUSO/B"}`
  renders the object's DEFINITION from eight catalog tables (`TOBJ`,
  `TOBJT`, `TOBCT`, `TACTZ`, `TACTT`, `AUTHX`, `DD04L`, `DD07V`): class,
  text, its fields with each field's data element and check table, fixed
  values, and permitted activities. This is **not** a list of who holds the
  object — no `AGR_*` (role) or `UST*` (user authorization) table is ever
  read, regardless of any option passed. `SUSO/B` cannot be written by
  abapsmith; `SU21` is the only way to edit one. See
  [doc/SAFETY/data-access-and-credentials.md](../SAFETY/data-access-and-credentials.md)
  for the full boundary.
- **`TABL/DI` (table secondary index)** — named as `<TABLE>/<INDEX>`, e.g.
  `abap_read {"object":"ZTAB/Z01","type":"TABL/DI"}`. Renders one secondary
  index from `DD12V`/`DD17S`: its unique/non-unique flag, active/inactive
  status, and ordered field list. A name that doesn't split into exactly
  two non-empty `<TABLE>/<INDEX>` parts is refused `BAD_INPUT` with a hint
  to use that form; an index that DD12V has zero rows for is a definitive
  `NOT_FOUND` (HTTP 200, 0 rows), not a refused read. Not sure of a table's
  index id? `abap_read {"object":"<TABLE>","type":"TABL/DT"}` now appends
  an `indexes` section listing every secondary index found this way, before
  you need to name one.

Both catalog reads are available under `ABAP_MODE=read`: nothing is
deployed or written, only targeted, validated `WHERE`-filtered `SELECT`s
against catalog tables.

## abap_search

Search the ABAP repository by name, find where an object is used, or scan
source text line by line.

**Availability**: the tool itself is case 2 — always registered,
unconditional, for all three modes. `mode=objects` and `mode=where_used`
are pure reads with no further gate. `mode=source` is different: it is
read-SHAPED (it never changes an object the caller asked about) but it
deploys and runs a generated ABAP class the same way `abap_fpm_read` does,
so it needs the fluid API and takes the write slot — it does **not** run
under `ABAP_MODE=read`, unlike `abap_img`. Concretely, `mode=source` needs
`ABAP_FLUID_API` on and `ABAP_MODE` not `read`; when either condition
fails, the tool stays registered and the call refuses at run time with
`FLUID_API_DISABLED`, naming the gate that is off, rather than the mode
disappearing from the tool list.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `query` | string | yes | — | Name pattern (`mode=objects`), target object (`mode=where_used`), or literal/regex text (`mode=source`, max 255 characters). |
| `mode` | enum `objects` \| `where_used` \| `source` | no | `objects` | Object search, where-used analysis, or a source-text scan. |
| `type` | string | no | — | `mode=objects`/`where_used` only. Restrict to one ADT type. Refused under `mode=source` — use `types` instead. |
| `max` | number (int, positive, ≤200) | no | `50` rows (`objects`/`where_used`) or `100` hits (`source`) | Maximum rows/hits to return. |
| `packages` | array of string | no | — | `mode=source` only. Package scope (TADIR-DEVCLASS). Required unless `objects` narrows the scope instead. |
| `include_subpackages` | boolean | no | `false` | `mode=source` only. Also scan every package transitively under `packages` (walks TDEVC-PARENTCL). |
| `objects` | string | no | — | `mode=source` only. Object-name pattern, `*` wildcard (e.g. `"ZCL_MY_*"`). A bare `"*"` does not count as a scope by itself. Alternative to, or combined with, `packages`. |
| `types` | array of string | no | all five | `mode=source` only. Which object types to scan: `PROG`, `CLAS`, `INTF`, `FUGR`, `DDLS`. |
| `regex` | boolean | no | `false` | `mode=source` only. Treat `query` as a PCRE pattern instead of a literal substring. |
| `case_sensitive` | boolean | no | `false` | `mode=source` only. |
| `include_comments` | boolean | no | `false` | `mode=source` only. Also match inside comments (see below). |

Notes: for `mode=where_used`, ADT's `usageReferences` endpoint ignores every
known limit parameter and always returns the complete result set
server-side — sometimes several MB and 10-20+ seconds. `max` is applied
client-side, after the full fetch, so lowering it does not reduce the fetch
cost; only a narrower `query` or `type` does. `mode=objects` renders its
usual four columns (type, name, package, description) unless at least one
displayed row has a parent container in its ADT URI — a FUGR/FF function
module or a FUGR/I function-group include — in which case a fifth `group`
column is added, and the response carries a hint that `group` is the
function group the row lives in while `package` remains the row's own
package, not its group.

### mode=source: line-wise source-text scan

There is no ADT full-text search endpoint. `mode=source` runs as a separate
built-in fluid tool (`scan`, entry class `ZCL_ZMCP_FLUID_SCAN` — see
[doc/FLUID-API/README.md](../FLUID-API/README.md)): it reads TADIR for the
object scope, resolves each object's includes, `READ REPORT`s them, and
matches line by line with `FIND ... PCRE`. It is a separate fluid tool
rather than a fourth `core` action specifically because `FIND ... PCRE`
needs a 7.55-or-later kernel; keeping it out of `ZCL_ZMCP_FLUID_CORE` means
an older system loses only `scan`, not `core.select`/`describe_fm`/`call_fm`.

**Scope is mandatory.** Pass `packages`, an `objects` pattern narrower than
`*`, or both — a repository-wide scan is refused with `BAD_INPUT`. There is
also a fixed ceiling of 200 objects in scope; the response reports how many
objects the scope actually holds, so a scope that exceeds the ceiling is
visible rather than silently under-scanned.

**Types.** `types` accepts any of `PROG`, `CLAS`, `INTF`, `FUGR`, `DDLS`
(default: all five). This is `mode=source`'s counterpart to `type`, which
`mode=source` refuses outright.

**Regex semantics.** With `regex: true`, `query` is an ordinary PCRE
pattern: a literal space matches a space, and `#` matches a literal `#`.
That is not what ABAP's `FIND ... PCRE` does on its own — it compiles with
the extended (`x`) flag on by default, under which a space in the pattern
is ignored and `#` starts a pattern comment, so a pattern like `FUNCTION B`
would fail to match `FUNCTION BRF_FLIGHT_BOOKING_ADD_SINGLE.`. To keep
`regex: true` behaving as plain PCRE, the tool prefixes every caller
pattern with `(?-x)` before handing it to `FIND`. A caller who wants
extended mode anyway can still turn it back on by starting their own
pattern with `(?x)`.

**Comment handling.** With `include_comments=false` (the default), the match
runs against the "code part" of each line — a per-line heuristic that drops
a full-line `*`/`"` comment and cuts the line at the first `"` found outside
a quoted literal. The row's `text` column always shows the raw line
regardless of this setting. The heuristic's known blind spot is a `"`
character inside a `|...|` string template. DDLS/CDS sources are always
matched in full text, comments included, since CDS comment syntax is not
ABAP comment syntax and the heuristic does not apply to it.

**Output and truncation.** One row per matching line: object type, object
name, include name, line number, and line text (each line clipped to 120
characters for display). Line numbers are include-local — for a CLAS/FUGR
hit, `line` counts from the top of the matching include (a method's own
program, not the class as a whole), not from the object. The response names
a concrete `abap_read` follow-up (with `offset`/`limit`, or `method=` for a
class hit inside a method include) to fetch the surrounding source. Both
ways this can run out of room are marked in the response body with a
`--- TRUNCATED ---` line, never left silent: the hit cap (`max`, default
100) and the object-scope ceiling (200).

**When to use `where_used` vs. `source`.** `where_used` reads ADT's
reference index and is the right tool for "what uses this object" — it is
complete for static usage but blind to dynamic calls (`CALL FUNCTION
lv_name`, `PERFORM (lv_form)`, `SUBMIT (lv_prog)`). `source` is a text scan
and is the right tool for anything that carries no registered reference:
literals, dynamic call names, message texts, comments, or a search for text
that isn't tied to one object at all.

**Evidence.** On system A4H (client 001, user DEVELOPER, 2026-09-12), the
complete generated `ZCL_ZMCP_FLUID_SCAN` body was deployed to package
`$TMP` under an issue-scoped name, activated after a clean syntax check,
and executed through the shared fluid runtime `ZCL_ZMCP_FLUID_RT`,
returning the real wire frames. That run covered: literal search over CLAS
includes, with hits reported per include and include-local line numbers;
regex search, including a pattern containing a space; FUGR include
resolution (11 includes resolved for one group, none skipped, bare include
names such as `LBRF_FLIGHT_UTILSU01` reported); DDLS/CDS sources read from
DDDDLSRC; package scope with `include_subpackages` expanding over
TDEVC-PARENTCL; the hit cap and the object ceiling, each reported on the
summary row as `truncated: "hits"` / `truncated: "objects"` with an honest
`objects_total` (33) against `objects_scanned` (3); and the comment
heuristic — querying `MESSAGE-ID` with `include_comments: false` returned 0
hits, and with `include_comments: true` returned the one trailing-comment
line. All of that is `live`.

Still not verified live: the end-to-end `abap_search mode=source` MCP
path — dispatching through `dispatch()` to a deployed `scan` tool on a
server running this build. The live MCP server runs the previously
released bundle, not this worktree's code, so that path is covered by unit
tests only (`tests` in this document's vocabulary), not by a live capture.

## abap_open_url

Get a browser-openable URL for an ABAP object, an ABAP keyword, or a Web
Dynpro application.

**Availability**: case 2 — always registered, unconditional.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `object` | string | one of object/keyword/webdynpro required | — | Object reference — routes to the ADT source HTML view, plus an `adt://` deep link if `ABAP_SID` is configured. |
| `type` | string | no | — | ADT type hint, only meaningful together with `object`. |
| `line` | number (int, positive) | no | — | Line to deep-link to, only meaningful together with `object`. |
| `keyword` | string (regex `^[A-Za-z0-9_]{1,80}$`) | one of object/keyword/webdynpro required | — | Routes to the public ABAP keyword documentation page. No auth needed. |
| `webdynpro` | string (regex `^[A-Za-z0-9_/]{1,80}$`) | one of object/keyword/webdynpro required | — | Web Dynpro application name — routes to its launch URL. Needs Basic auth and a browser User-Agent to actually load. |

Exactly one of `object`, `keyword`, `webdynpro` is required; the schema
refuses zero or more than one.

