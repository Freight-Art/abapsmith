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
| `method` | string | no | — | Read one method's source instead of the whole class: its `METHODS` declaration first, then the `METHOD … ENDMETHOD.` body. Resolved against the inactive version's component structure when one exists, then the active one, then up the superclass/interface chain (`foundOn` in the header). With `include="definitions"`, returns the declaration only — the cheap way to learn a signature. With `view="docu"` against a `CLAS` object, selects that method's ABAP Doc comment instead of the class's own SAP documentation — refused against every other `view`. Giving it also opts out of the default outline. See ["Classes: `method=`, `outline=true`, inherited members and the inactive version"](#classes-method-outlinetrue-inherited-members-and-the-inactive-version). |
| `outline` | boolean | no | automatic — see [Large sources](#large-sources-outline-by-default-pattern-and-full) | `true`: the component list with line ranges instead of the source (`CLAS`/`INTF`: ADT component structure; `PROG`/`FUGR`: a statement scan of the text). `false`: the source, even above the default-outline threshold. Omitted: the outline is the default for a `CLAS`/`INTF`/`PROG`/`FUGR` source read above 150 lines or 8000 chars when no narrower parameter is given. For classes, an `INHERITED` section lists the public/protected members of every superclass and interface with the defining object. |
| `full` | boolean | no | — | The whole source even above the default-outline threshold — the same as `outline=false`, named for what it asks. Refused with `BAD_INPUT` together with `outline=true`, `method` or `pattern` (whole vs. part cannot both be honoured), with `UNSUPPORTED` together with any `view` and on the raw/enhancements/DDIC paths. |
| `pattern` | string | no | — | Case-insensitive regex: only the source lines matching it, numbered like `grep -n -C`, with `context` unchanged lines around each match. At most 50 matches per response unless `limit` says otherwise; `offset` is the first line scanned. Empty or invalid → `BAD_INPUT` before any request. Refused with `BAD_INPUT` together with `outline=true`/`method`/`full`, with `UNSUPPORTED` together with any `view`, `format="raw"`, `enhancements=true` and on a DDIC/catalog read. |
| `offset` | number (int, 1–999999) | no | — | 1-based first line to return (with `pattern`: the first line scanned). Giving it also opts out of the default outline. |
| `limit` | number (int, 1–999999) | no | — | Number of lines to return (with `pattern`: the match cap). Giving it also opts out of the default outline. |
| `enhancements` | boolean | no | — | Also report enhancement anchors/implementations on this object. |
| `version` | enum `active` \| `inactive` | no | `active` | Which version to read. |
| `format` | enum `raw` | no | — | Return unprocessed source instead of the rendered/annotated form. |
| `view` | enum `history` \| `diff` \| `definition` \| `lineage` \| `footprint` \| `docu` \| `digest` | no | — | `history`: list the object's version feed (author, date, transport) instead of source/DDIC. `diff`: return unified-diff hunks between two versions — never two full sources. `definition`: element info / go-to-definition for the identifier at `line`/`column` — see ["view=\"definition\": element info and go-to-definition"](#viewdefinition-element-info-and-go-to-definition) below. `lineage`: trace a CDS view's DDL source down to its base tables — see ["view=\"lineage\": CDS view lineage"](#viewlineage-cds-view-lineage) below. `footprint`: scan a PROG/CLAS/FUGR object's own source for database writes and commits — see ["view=\"footprint\": database write footprint"](#viewfootprint-database-write-footprint) below. `docu`: SAP's own documentation for the object (or, with `method=`, one method's ABAP Doc) — see ["view=\"docu\": SAP documentation"](#viewdocu-sap-documentation) below. `digest`: a fixed six-section overview — see ["view=\"digest\": one-page object overview"](#viewdigest-one-page-object-overview) below. Omit for a normal source/DDIC read. |
| `from` | string | `view="diff"` only | released version before `to` | Older side of the diff — a version number (e.g. `"66"`), a transport name, or the literal `"active"` for current source. Refused together with `from_system`/`to_system` — see below. |
| `to` | string | `view="diff"` only | newest released version | Newer side of the diff, same forms as `from`. Refused together with `from_system`/`to_system` — see below. |
| `context` | number (int, 0–20) | no | `3` (`view="diff"`) / `2` (`pattern`) | With `view="diff"`: unchanged context lines per hunk (also honoured by a cross-system diff). With `pattern`: unchanged lines shown around each matching line. Refused with `BAD_INPUT` when neither is given. |
| `from_system` | string | `view="diff"` only, and only with [more than one system configured](../CONFIGURATION/multi-system.md) | the called system | Cross-system diff: compare the object as it is on this system. See [`view="diff"`: same-system versions and cross-system comparison](#viewdiff-same-system-versions-and-cross-system-comparison) below. |
| `to_system` | string | `view="diff"` only, and only with more than one system configured | — | Cross-system diff: the other side of the comparison, e.g. `{"object":"ZCL_FOO","view":"diff","to_system":"QAS"}`. Giving either `from_system` or `to_system` switches the whole request into cross-system mode. |
| `line` | number (int, ≥1) | required with `view="definition"`; refused otherwise | — | 1-based source line — same convention as `abap_quick_fix`. Refused with `UNSUPPORTED` together with `view="history"`/`"diff"`/`"lineage"`/`"footprint"`/`"docu"`/`"digest"`, and refused with `BAD_INPUT` if given with no `view` at all (it would silently be discarded by an ordinary read). |
| `column` | number (int, ≥0) | no | `0` | 0-based column — same convention as `abap_quick_fix`. Only meaningful with `view="definition"`; refused otherwise on the same terms as `line`. |
| `include` | enum `CLASS_INCLUDES` | no | `"main"` | Classes only — which class include to read; applies to the source read and to `view` alike. `"testclasses"` holds ABAP Unit tests; `"main"` never does. Always an explicit, disclosed choice — silently defaulting to `main` would hide changes made in another include. Refused with `UNSUPPORTED` together with `view="footprint"` — footprint scans every include by design, so naming one is refused rather than silently narrowing the scan. Refused with `UNSUPPORTED` together with `view="docu"` or `view="digest"` — `docu` resolves its own documentation target from the object's type and name and has no class-include axis; a digest always reads the class's own main source plus its testclasses include, never a caller-picked one. |
| `types` | string[] | no | — | `DEVC/K` only — filter the package listing to these kind codes, e.g. `["CLAS","DDLS"]`. Refused with `BAD_INPUT` against any other type. |
| `depth` | number (int) | no | `1` (`DEVC/K`); `5` (`view="lineage"`) | `DEVC/K`: how many sub-package levels to list, 1-3, `1` lists only the package itself. `view="lineage"`: how many levels of data source/association to walk, 1-10. Both refuse `BAD_INPUT` above their own maximum — refused, not silently clamped down to it — and both refuse `BAD_INPUT` against any other type/view, since the two maxima differ and a shared schema constraint can't express "3 here, 10 there." |
| `field` | string | no | — | `view="lineage"` only — trace one field back to its base columns instead of rendering the whole data-source/association tree. Refused with `BAD_INPUT` against any other view. |

Notes: response includes an etag (a content hash) — pass it back as
`abap_write`'s `expect_etag` to detect a concurrent change before writing.
`offset`/`limit` page long sources; a truncated response always names how to
fetch the rest. Every read response carries a `size:` header line —
`size: <chars> chars, <lines> lines, truncated=<bool>` — that describes the
response text itself, exactly (it is rendered inside the character budget,
so it counts itself; a `~` prefix would mark the rare case where the two
self-referential counts did not settle — it has not been observed). A function module named without its group — e.g.
`{"type":"FUGR/FF","object":"BUP_ROLES_GET_ALL"}` — resolves on its own: the
exact-name lookup goes out untyped and the group is read off the matching
row's `adtcore:uri`, since neither the name nor `adtcore:packageName` carries
it. This still refuses with `BAD_INPUT` when the search cannot settle the
group — naming every candidate group if more than one function group has a
module by that name, or asking for the group by hand if the search finds
nothing at all, which happens for generated function modules (e.g.
`ENQUEUE_E_TABLE`) that the repository search does not index: say
`"ENQUEUE_E_TABLE in ETABLE"` or `"ETABLE/ENQUEUE_E_TABLE"`.

A whole-object source read of a `PROG/P` reports `fixed_point_arithmetic:
true|false` in the header, read off the program's own descriptor — the
line is omitted when that descriptor could not be read. When the program
has any text symbols or selection texts, the same read also appends a
`TEXT POOL` section listing them, read from the `PROG/PX` textelements
resource — see `doc/TOOLS/write-and-activate.md` for how `abap_write`'s
`text_pool` parameter writes them. A program with no text symbols and no
selection texts gets no such section. List headings (`SELECTION-SCREEN
BEGIN OF SCREEN`/`TAB` frame titles) are not part of the text pool and are
not shown here.

### Large sources: outline by default, `pattern`, and `full`

Issue #148 measured what a plain `abap_read` of a standard class costs: a
10K–31K-character source paged over two or three calls, most of which the
caller never needed. So a source read of a `CLAS`, `INTF`, `PROG` or `FUGR`
object answers with the **outline** instead of the source when the source
is above **150 lines or 8000 characters** (`OUTLINE_DEFAULT_LINES` /
`OUTLINE_DEFAULT_CHARS` in `src/tools/read.ts`) and the call named no part
of it. The response says so: `outline: default (large source)` in the
header, `totalLines`/`totalChars` for the source it stands in for, and a
`NOTE:` naming the threshold, the full line count and every way to get
the text — `method="<NAME>"`, `pattern="<regex>"`, `offset`/`limit`, or
`full=true` for all of it. The etag is the full source's etag, not marked
partial: nothing was cut from a text the caller asked for.

The default does **not** engage — the source is returned as before — when
the call passes `full=true`, `outline=false`, `method`, `include`,
`offset`, `limit` or `pattern`; for any other object kind (DDIC, CDS, catalog
reads); for a source at or under both bounds; and for every `view`. An
explicit `outline=true` is `outline: requested` and works at any size.

What the outline is depends on the kind. `CLAS`/`INTF`: ADT's component
structure (`classMembers`) — name, visibility, implementation line range —
exactly what `outline=true` always returned. `PROG`/`FUGR` have no ADT
component structure, so their outline is a **text scan** of
statement-initial keywords (`REPORT`/`PROGRAM`/`FUNCTION-POOL`, `INCLUDE`,
`FORM`…`ENDFORM`, `FUNCTION`…`ENDFUNCTION`, `MODULE`…`ENDMODULE`, `CLASS`
`DEFINITION`/`IMPLEMENTATION`…`ENDCLASS`, `INTERFACE`, `METHOD`…`ENDMETHOD`,
event blocks, `SELECTION-SCREEN BEGIN OF`), each with its line or line
range, indented by nesting — and the response's `NOTE:` says it is a scan.
Full-line `*` and `"` comments are skipped; a keyword that is not the first
token of a line is not seen. A scan that finds nothing says it found no
such statement, which is a fact about the scan, not a claim that the
program has no components. Other kinds with `outline=true` keep the
"outline is NOT SUPPORTED for …" body for the same reason.

**`pattern`** is `grep -n -C` over the document: every line matching the
case-insensitive regex, prefixed with its absolute line number and `:`,
with `context` (default 2) unchanged lines around it prefixed `-`, and
`--` between non-adjacent groups — so the numbers feed straight into
`offset=`, `abap_quick_fix`'s `line`, or `view="definition"`. The body
label is `MATCHES`; the header carries `pattern`, `context`, `matches`
(every match from `offset` on), `matchesShown`, `scannedFrom`,
`totalLines` and `totalChars`. At most 50 matching lines are shown
(`PATTERN_MAX_MATCHES`; `limit=` overrides); past that the body ends with
`--- TRUNCATED --- <shown> of <total> matching line(s) shown (cap N, raise
with limit=). Continue with offset=<last shown line + 1>, or narrow the
pattern.` — a continuation, not a silent cut. The etag of a pattern read is
marked `partial:`: it never shows the whole text, so a full-source
`abap_write` presenting it is refused exactly like a truncated read's,
while `edit={old_string,new_string}` accepts it. `pattern` composes with
`include` (grep that include) and with `offset`/`limit` as described; it
is refused with `BAD_INPUT` together with `outline=true`, `method` and
`full` (it already narrows the read), and with `UNSUPPORTED` together with
any `view`, `format="raw"`, `enhancements=true` and on DDIC/catalog paths —
each names the clash rather than dropping the filter. An empty or
syntactically invalid regex is `BAD_INPUT` before the object is resolved:
zero requests reach the wire.

**`full=true`** is the explicit way to ask for the whole source of a large
object; it is the same as `outline=false` and exists so the request reads
as what it is. It is refused with `BAD_INPUT` next to anything narrower
(`outline=true`, `method`, `pattern`) and with `UNSUPPORTED` next to a
`view` or on a non-source path.

Offline coverage: `test/read-outline-default.test.ts` (threshold on both
bounds, every opt-out, INTF, non-default kinds, the PROG/FUGR scan and its
empty result, the `full` clashes) and `test/read-pattern.test.ts`
(`grepSource` rendering, context, cap and continuation, zero-wire refusals,
partial etag, pattern over a large class). Live: not run against A4H on
this build — the installed MCP tools run the released bundle, whose
`abap_read` has neither parameter.

### Classes: `method=`, `outline=true`, inherited members and the inactive version

`method=` and `outline=true` share one component lookup (`src/adt/source.ts`,
`classMembersFor` / `readMethod`). Facts a caller can rely on:

- **Which version is resolved.** The object's own descriptor (`GET {uri}`,
  attribute `adtcore:version`) decides, not a blind try of the inactive
  structure first: ADT answers `/objectstructure?version=inactive` with the
  ACTIVE structure, no marker, for an object that has no newer inactive
  version, so asking for it first cannot tell "inactive" from "active" —
  the descriptor is consulted instead. When the object's activation state
  isn't already known this costs one descriptor GET; the inactive structure
  is then requested only when the descriptor reports a newer inactive
  version, falling back to the active structure when that read fails or
  comes back empty. Otherwise, and whenever the descriptor itself can't be
  read, the active structure is used directly. The header's
  `structureVersion` names the version whose line ranges were used, and a
  note says so — and only claims "inactive" — when the descriptor reported
  one. Without this, a class whose last full write failed its syntax check
  (saved inactive, see [`abap_write`](write-and-activate.md#abap_write))
  resolved every `method=` against the stale active line ranges, and a
  method that existed only in the inactive version was `NOT_FOUND`.
- **`method=` walks the inheritance chain.** When the class itself has no such
  member, the walk follows `INHERITING FROM` and `INTERFACES` from the
  definition source, superclass first, then the interfaces, each level's own
  parents after it, and stops at the first hit. The header then carries
  `foundOn: "ZCL_PARENT (superclass of ZCL_CHILD, depth 1)"` (or
  `interface of …`) and `sourceLines` in the defining object's numbering; a
  note repeats that the lines are the defining object's. Private members of a
  superclass are not inherited and are not searched. A parent that cannot be
  read on this system (missing, or not readable in this mode) is skipped and
  listed under `details.unresolved` / a response note rather than aborting the
  read.
- **`NOT_FOUND` lists candidates from the whole chain.** `details.available`
  are the class's own methods, `details.availableInherited` the inherited ones
  as `"NAME (ORIGIN)"`, both preferring names sharing a prefix with the request
  (`GET_` for `GET_COLUMNS`) when the list is cut. Each list is capped at
  `ABAP_AVAILABLE_MEMBERS_MAX` names (default 40; `availableTruncated` /
  `availableInheritedTruncated` say how many were dropped). The class's own
  name is never listed as a member — the interface's `CLAS/OC` self-entry in
  the ADT structure is filtered out, and so is the `CLAS/OCX` "Text
  Elements" entry (`isExternalRef="true"`) that every class's active
  structure carries for itself — which before also made each chain parent's
  own name appear in the outline's `INHERITED` section.
- **Signature first.** A `method=` read returns the `METHODS …` declaration
  (from the definition part, unchained from a `METHODS: a, b.` list) as a
  block ahead of the `METHOD … ENDMETHOD.` body; `blockLines` counts both.
  `method=` together with `include="definitions"` returns the declaration
  alone (`METHOD DECLARATION` body label) — the way to learn a signature
  without reading the class. `method=` with any other `include` is still
  `UNSUPPORTED`, since method bodies live in `main`.
- **`outline=true` shows inherited members.** After the class's own
  components an `INHERITED (…)` section lists the public and protected methods,
  attributes and events declared on its superclasses and interfaces, grouped
  by defining object with its relation and depth, line numbers in that
  object's source. The header's `components` counts the class's own members,
  `inherited` the chain's.

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

### view="diff": same-system versions and cross-system comparison

`view="diff"` answers one of two different questions, depending on which
parameters are given. Giving `from`/`to` (or neither) diffs two VERSIONS of
one object on one system — see the parameter table above for what `from`
and `to` accept. Giving `from_system` and/or `to_system` instead diffs the
CURRENT ACTIVE source of the same object across two different SAP systems.
The two forms are mutually exclusive: `from`/`to` select a point on one
system's version feed, and two independent SAP systems share no such feed
for either to select from — combining them is refused with `BAD_INPUT`,
naming which parameter to drop.

**Cross-system diff is only offered when [more than one system is
configured](../CONFIGURATION/multi-system.md)** — on a single-system
server, `from_system`/`to_system` are not in the tool's schema at all, and
a hand-crafted call carrying them anyway is refused with `BAD_INPUT`
naming the server's one configured system. Giving either `from_system` or
`to_system` (both are optional individually) switches the request into
cross-system mode; `from_system` defaults to the system the call itself was
routed to (the `system` parameter, or the default system when that too is
omitted), so `{"object":"ZCL_FOO","view":"diff","to_system":"QAS"}` alone
is a complete cross-system request — the default system vs. QAS.

What a cross-system diff does NOT do:

- **No shared version feed.** Only current active source is compared —
  never a specific version, a transport, or history — because two
  independent SAP systems have no common version numbering for either side
  of `from`/`to` to name. Those two parameters are refused outright when
  combined with `from_system`/`to_system`.
- **No component-narrowing parameters.** `method`, `outline`, `pattern`,
  `full`, `line`, `column`, `types` and `depth` are all refused together with
  `from_system`/`to_system` — a cross-system diff always compares the
  whole object's current source, never a single method, a source position,
  or a package listing. `include` (class-includes) is the one exception:
  it is honoured on both sides exactly like an ordinary read honours it,
  since comparing e.g. `testclasses` between two systems is a legitimate
  question.
- **No comparing a system against itself.** `from_system` and `to_system`
  resolving to the same alias is refused with `BAD_INPUT` — current active
  source compared against itself would always report no differences, so
  this is treated as a caller mistake rather than answered literally.

**Each side is fetched under its own system's permission and connection.**
A cross-system diff opens a connection to both `from_system` and
`to_system` (in parallel) and asserts a `read` capability against each
side's OWN `SafetyGate` — a `read`-mode system still allows being read as
one side of a diff even when the default system is `admin`; see
[SAFETY/permission-model.md](../SAFETY/permission-model.md#the-mode-ladder-is-per-system).
If the object does not exist on one side, the refusal names which system
it was missing from rather than a bare "not found" — ambiguous the moment
two systems are being compared in one call.

**Header format.** The `from`/`to` fields in a cross-system response read
`ALIAS (SID/client)` for each side, e.g. `QAS (QAS/100)`, rather than the
version label a same-system diff uses — there is no version number to show
in its place.

**TYPE DIFFERS / PACKAGE DIFFERS are findings, not errors.** If the object
resolves to a different ADT type, or a different package, on the two
systems, the response still returns a diff (of whatever source each side
resolved to) and adds a note calling out the mismatch, rather than
refusing outright — the object may legitimately have been recreated under
a different type or moved to a different package on one side, and that is
exactly the kind of drift a cross-system diff exists to surface.

Beyond this, a cross-system diff renders through the same hunk/paging/
truncation machinery as a same-system diff (`DIFF_MAX_HUNKS`, `context`,
`offset`/`limit`), so everything about reading a large diff a page at a
time applies identically to both forms.

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
| `view="definition"` combined with `pattern=...` or `full=true` | `UNSUPPORTED` — `pattern` greps plain source lines and `full` only overrides a source read's default outline; a view renders something else. Same for every other `view`. |
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

### view="lineage": CDS view lineage

`DDLS/DF` only. Traces a CDS view's own DDL source down to the base tables
and other CDS views it selects from and associates to, by reading and
parsing DDL text (`src/adt/cds-lineage.ts`) — not from ADT's own
dependency-graph endpoint, which exists and nests transitively but carries
no association edges and no field lineage (see below, and
[doc/LIMITATIONS/cds-lineage.md](../LIMITATIONS/cds-lineage.md) for the
full finding).

The walk follows two kinds of edge: `from`/`join`/`union` data sources
(always followed, up to `depth`), and associations — but only an
association whose name appears somewhere in the field list body is
followed at all; one that never appears becomes a leaf marked `(not
selected)` without being read. "Appears somewhere in the field list body"
is a textual-mention test, not "used as a projected field" — an
association referenced only inside an expression, such as a `coalesce()`
call, still counts as followed. Pass `field` to trace one output column
back to its base columns instead of rendering the whole tree.

**Refusals** (`assertViewCompatible`/`readLineage`, `src/tools/read.ts`):

| Input | Result |
|---|---|
| `view="lineage"` against a non-`DDLS/DF` object | `UNSUPPORTED` |
| `depth` above 10 | `BAD_INPUT` — refused, not clamped: `depth=N exceeds the maximum for view="lineage" (10)`. |
| `field` given with any other view | `BAD_INPUT` |
| `depth` given with any view other than `lineage` (and not a `DEVC/K` package read) | `BAD_INPUT` |
| `offset`/`limit` | `UNSUPPORTED` — the tree (or field chain) is bounded by `depth`/an internal node budget, not paged by line. |
| `types` | `UNSUPPORTED` — `types` filters a `DEVC/K` package listing; lineage is not a package read. |
| `line`/`column` | `UNSUPPORTED` — lineage's output is a tree across many objects, not a position in one object's source. |
| `format="raw"`, `enhancements=true`, `version="inactive"`, `outline=true`, `method=...`, `from`/`to`/`context` | `UNSUPPORTED`, each with its own reason (a dependency tree has no single XML descriptor, no per-node inactive version, no component list of one object, no method to slice, no version-to-version diff). |

**ADT limitations, documented rather than hidden:**

- **ADT's `graphdata` endpoint is not the source, even though it exists and
  answers with a real tree.** `GET
  /sap/bc/adt/ddic/ddl/dependencies/graphdata?ddlsourceName=` nests
  transitively in one call — captured live against `ARS_V_FLP_SWC_VH`
  (fixture 981, A4H, 2026-09-15) — but its nodes carry no association edges
  and no field-level lineage, so it cannot answer either half of what this
  view needs. It also refused every customer view tried: the same endpoint
  against `ZDEMO_C_SALESORDER_TP_D` answered HTTP 400
  `NoDependencyGraphDataCalculationPossible` (fixture 982). What separates
  an accepted view from a refused one was not established from the two
  views tried.
- **Every CDS-type node is read and parsed, even a depth-limited leaf.** A
  non-CDS target becomes an instant "table" leaf without reading anything —
  its type alone is enough to know the walk stops. A CDS-type target still
  needs its own DDL source read and parsed before the walk can even decide
  it's a leaf, since the node's `kind` (needed to detect a non-recursing
  kind such as `table function` or `abstract entity`) isn't known until
  then. `table function`, `abstract entity`, `custom entity`, `extend
  view`, a parameterised view (`with parameters`), and an unparseable
  source (`kind: "unknown"`) are all leaves the walk does not follow
  further. `with parameters` and `extend view` have no fixture exercising
  either shape.
- **The DDL parser is a line-local heuristic, not a tokenizer.** It
  recognises the CDS keywords and shapes named above by pattern-matching
  source lines; a view written in an unrecognised shape degrades to `kind:
  "unknown"` rather than throwing.
- **A repeated name renders as `(cycle -> seen above)` on a single global
  visited set, so a legitimate diamond looks identical to a real cycle.**
  Fixture 980 (`ARS_V_FLP_SWC_VH`) has two associations, `_session_language`
  and `_english`, both targeting `cvers_ref` — the second arrival marks as
  a cycle even though nothing here is self-referential.
- **`/sap/bc/adt/ddic/ddl/elementmappings` was probed as a field-lineage
  source during implementation and rejected — no fixture backs this.** Four
  parameter spellings all answered HTTP 400 with the same static editor
  metadata, not a per-view mapping. No capture number exists for this
  probe; treat it as an honest implementation-time finding, not a
  reproducible live claim.

**Evidence.** The DDL parser and tree builder are exercised offline
(`tests` in this document set's vocabulary) against five real CDS view
sources: a customer consumption view over another customer view (fixture
976), a base-table leaf with field aliases and associations using
`$projection` (977), a `UNION` of two views (978), a left outer join with a
multi-line `ON` condition (979), and two unexposed associations referenced
only inside an expression (980). `live`: the `graphdata` endpoint's own
shape and its customer-view refusal (fixtures 981/982, A4H, 2026-09-15).
The assembled `abap_read view="lineage"` MCP call has not been exercised
end to end against a live server — the reference system runs a previously
released bundle that predates this feature — so that path is `unverified`,
and no future live run against it is anticipated in this document.

Example — tracing `ARS_V_FLP_SWC_VH` one level down:

```json
{
  "object": "ARS_V_FLP_SWC_VH",
  "type": "DDLS/DF",
  "view": "lineage",
  "depth": 1
}
```

```
view: ARS_V_FLP_SWC_VH
object: ARS_V_FLP_SWC_VH (DDLS/DF)
depth: 1
nodes: 2
baseTables: 0
sourceReads: 2

ARS_V_FLP_SWC_VH (view)
  from ARS_SOFTWARE_COMPONENTS_SCP_VH as swcmp (view entity) (depth limit (1) reached)

Notes:
- Lineage is derived by parsing CDS DDL source text, not from ADT's dependency-graph endpoint
  (that endpoint returns no association edges and no field lineage — see this file's top comment).
- Only associations referenced somewhere in the field list are followed ("(not selected)" marks
  the rest).
- A name repeated anywhere earlier in this walk is shown once and marked "(cycle -> seen above)"
  on later occurrences, even for a legitimate diamond (the same base table reached two different
  ways) — this is a global visited-set, not a strict cycle check.
- Depth 1 of max 10; nodes at the limit are leaves even if the underlying view has further data
  sources.
```

This rendered output is hand-assembled offline from real `parseDdl` output
against fixtures 980 (root) and 978 (child), run through the tool's own
`renderLineage()`, not a live end-to-end capture — the header/body/notes
text is exactly what the code produces, but no live MCP call produced it.
At `depth=1`, `ARS_V_FLP_SWC_VH`'s two associations (`_session_language`,
`_english`, both to `cvers_ref`) would also appear as children; they are
omitted from this example because their target's resolved object type was
never captured live.

### view="footprint": database write footprint

`PROG/P`, `CLAS/OC`, `FUGR/F`, `FUGR/FF` only. Scans every include of the
object's own source for statements that write to the database or commit a
transaction (`src/adt/footprint.ts`) — a static pattern match over
statement text, not a compiler or a call graph. See
[doc/LIMITATIONS/footprint.md](../LIMITATIONS/footprint.md) for the full
list of blind spots (dynamic targets, the internal-table-vs-database-table
keyword-position heuristic and its excluded forms, and the statement kinds
with no live ground truth).

**Refusals** (`assertViewCompatible`/`readFootprint`, `src/tools/read.ts`):

| Input | Result |
|---|---|
| `view="footprint"` against a type outside `PROG/P`, `CLAS/OC`, `FUGR/F`, `FUGR/FF` | `UNSUPPORTED` |
| `include` given with `view="footprint"` | `UNSUPPORTED` — footprint scans every include by design; naming one would hide writes reachable only from the others. |
| `field` given | `BAD_INPUT` |
| `depth` given | `BAD_INPUT` |
| `offset`/`limit` | `UNSUPPORTED` — the occurrence list is grouped by table, not paged by line. |
| `types` | `UNSUPPORTED` |
| `line`/`column` | `UNSUPPORTED` — footprint's output is a scan across all includes, not a position in one of them. |
| `format="raw"`, `enhancements=true`, `version="inactive"`, `outline=true`, `method=...`, `from`/`to`/`context` | `UNSUPPORTED`, each with its own reason (a write scan across every include has no single XML descriptor, no per-include inactive version, no component list, nothing to slice by method, no version-to-version diff). |

**Evidence.** The statement classifier and renderer are exercised offline
(`tests` in this document set's vocabulary) against fixture 983
(`Z_I107_FOOTPRINT`), a report built to carry every recognised statement
form plus two commented-out writes that must not be reported. Running the
real `scanFootprint`/`renderFootprint` functions against that fixture's
source reports all fourteen occurrences and neither commented-out line
(shown below). BOPF modify and `EXEC SQL`/ADBC detection have **no live
ground truth at all** — fixture 983 contains none of the three, so those
patterns are written from documented API shapes, not an observed
occurrence; the tool's own rendered output discloses this for BOPF, and
[doc/LIMITATIONS/footprint.md](../LIMITATIONS/footprint.md) discloses it
for all three. The assembled `abap_read view="footprint"` MCP call has not
been exercised end to end against a live server — the reference system
runs a previously released bundle that predates this feature — so that
path is `unverified`, and no future live run against it is anticipated in
this document.

Example — scanning `Z_I107_FOOTPRINT`:

```json
{
  "object": "Z_I107_FOOTPRINT",
  "type": "PROG/P",
  "view": "footprint"
}
```

```
object: Z_I107_FOOTPRINT (PROG/P)
includes: main
linesScanned: 40
occurrences: 14
commitFound: yes
writesOnlyViaUpdateTask: no

Per-table summary:
table                  occurrences
---------------------  -----------
(unresolved) (GV_TAB)  1
INDX                   1
ZDEMO_SOH              4
(n/a)                  8

Occurrences:
  INDX:
    [export to database] main:34  EXPORT gs_soh TO DATABASE indx(zz) ID 'I107'. (indx(zz))
  ZDEMO_SOH:
    [insert] main:11  INSERT zdemo_soh FROM gs_soh.
    [update] main:12  UPDATE zdemo_soh SET changedby = sy-uname WHERE salesorder = '1'.
    [modify] main:13  MODIFY zdemo_soh FROM TABLE gt_soh.
    [delete] main:14  DELETE FROM zdemo_soh WHERE salesorder = '2'.
  (unresolved / non-table):
    [insert] main:18  INSERT (gv_tab) FROM gs_soh. [unresolved: (GV_TAB)]
    [update task] main:21  CALL FUNCTION 'RFC_SYSTEM_INFO' IN UPDATE TASK. (RFC_SYSTEM_INFO)
    [background task] main:22  CALL FUNCTION 'RFC_SYSTEM_INFO' IN BACKGROUND TASK DESTINATION 'NONE'. (RFC_SYSTEM_INFO)
    [commit] main:26  COMMIT WORK AND WAIT.
    [rollback] main:27  ROLLBACK WORK.
    [commit] main:28  CALL FUNCTION 'BAPI_TRANSACTION_COMMIT' EXPORTING wait = 'X'. (BAPI_TRANSACTION_COMMIT)
    [rollback] main:31  CALL FUNCTION 'BAPI_TRANSACTION_ROLLBACK'. (BAPI_TRANSACTION_ROLLBACK)
    [call transaction] main:35  CALL TRANSACTION 'SE16' AND SKIP FIRST SCREEN. (SE16)
    [submit] main:36  SUBMIT rsusr002 AND RETURN. (RSUSR002)

This object both writes and issues its own COMMIT WORK / BAPI_TRANSACTION_COMMIT — it does not rely
on a caller to commit its writes.

Notes:
- Detection is static pattern matching over statement text, not a compiler or a call graph — it can
  miss a write reached through a macro, dynamic dispatch, or generated code, and it cannot prove a
  write is unreachable.
- INSERT/MODIFY/DELETE share syntax between database tables and internal tables; telling a database
  write from an internal-table operation is a keyword-position heuristic (TABLE/INDEX/TRANSPORTING
  keyword placement), not type information.
- CALL TRANSACTION and SUBMIT are reported because the target MAY write — this scanner cannot know
  whether it actually does without executing it.
- BOPF modify (/BOBF/IF_TRA_SERVICE_MANAGER->MODIFY) is detected by call-site text pattern only;
  unlike every other kind here, there is no live-captured fixture confirming it against a real BOPF
  object.
```

This is the real output of `scanFootprint`/`renderFootprint` run offline
against fixture 983's source text — not a live MCP round trip.

### view="docu": SAP documentation

`view="docu"` reads SAP's own documentation store — `DOKHL` (header),
`DOKIL` (per-language availability index), `DOKTL` (text lines) — for the
object `abap_read` resolved, flattened to plain text. There is no ADT REST
endpoint for this store, so it is read through the built-in `core` fluid
tool's `docu` action (`abap_fluid`'s `core.docu`) rather than through an
ordinary ADT GET — see
[doc/FLUID-API/README.md](../FLUID-API/README.md) and
[abap-fluid.md](abap-fluid.md) for what that action does on the ABAP side
(`DOCU_GET`, then `CONVERT_ITF_TO_ASCII`).

Two independent read paths share this `view`, selected by whether `method`
is given:

- **Without `method`** (the object's own documentation): the object's ADT
  type and name are mapped to a `(id, object)` pair in `DOKHL` by
  `resolveDocuTarget` (`src/adt/docu.ts`):

  | ADT type prefix | doc id | kind |
  |---|---|---|
  | `DTEL` | `DE` | data element |
  | `DOMA` | `DO` | domain |
  | `TABL` | `TB` | table |
  | `CLAS` | `CL` | class |
  | `INTF` | `IF` | interface |
  | `FUNC` | `FU` | function module |
  | `FUGR` | `FU` | function group |
  | `PROG` | `RE` | program |
  | `MSAG` | `NA` | message (see below) |

  A type with no row in this table is refused with `BAD_INPUT`, naming the
  supported list. **Messages are special-cased**: a message class's stored
  documentation object is never just the object name — `parseMessageObject`
  turns a message id/number reference into `DOKHL-OBJECT`'s stored form
  (id concatenated with the number zero-padded to 3 digits, no separator).
  `"ZSD 042"`, `"ZSD042"` and `"ZSD 42"` all resolve to `"ZSD042"`; a
  reference that fits neither the spaced nor the already-merged shape is
  refused with `BAD_INPUT`. This works because `view="docu"`
  short-circuits ordinary ADT object resolution for `MSAG`: a message's
  identity is class + number (`"ZSD 042"`), and the number exists nowhere
  but the caller's own input — ADT's object identity for a message class
  carries only the class, never the number — so `abapRead` builds the
  documentation target straight from the caller's raw `object` string
  instead of resolving it against ADT first. Both the spaced form
  (`abap_read {"type":"MSAG","object":"ZSD 042","view":"docu"}`) and the
  merged spelling (`abap_read {"type":"MSAG","object":"ZSD042","view":"docu"}`)
  work the same way. Live-verified equivalent (`id NA`, object `BM019`, a
  real message long text found in `DOKIL`): 6 lines of Diagnosis/System
  Response/Procedure text returned, `found:true`.

  **IMG activities are addressable.** `src/adt/docu.ts` also exports
  `imgDocuTarget`, which resolves an IMG activity to `id: "HY", object:
  "SIMG" + <activity>` — an IMG activity has no ADT object type of its own
  for `abap_read` to resolve through the ordinary path, so `abapRead`
  special-cases a `type: "SIMG"` input the same way it special-cases
  `MSAG`: it bypasses `resolveObject` entirely and builds the
  documentation target by hand from the caller's raw `object`. Usage:
  `abap_read {"type":"SIMG","object":"<activity id from abap_img
  mode=show>","view":"docu"}`. `type: "SIMG"` combined with any `view`
  other than `"docu"` is refused with `UNSUPPORTED` — there is no ADT
  object of type `SIMG` to read any other way. Live-verified (`id HY`,
  object `SIMGCRM_PRI_GRUKONKONTR`, a real IMG activity found in `DOKIL`):
  39 lines of customizing documentation returned, `found:true` — the live
  confirmation of the `HY`/`SIMG`+name IMG-activity naming rule.

- **With `method`** (CLAS objects only): reads ABAP Doc instead — the
  contiguous `"!`-prefixed comment block immediately above the method's
  `METHODS`/`CLASS-METHODS` declaration in source, the only documentation a
  method itself carries. This never falls back to the class's own DOKHL
  text — a method's ABAP Doc and its class's SAP documentation answer
  different questions. `method` against a non-`CLAS` object is refused with
  `UNSUPPORTED`. This path reads source directly and never calls
  `core.docu` — no fluid tool is dispatched, so it needs no `ABAP_FLUID_API`
  and no `SafetyGate`, and it works under `ABAP_MODE=read` exactly like an
  ordinary source read. `view="docu"` **without** `method` is the one that
  goes through `core.docu` and therefore does need the fluid API — see
  "Gated as a write, not a read" below.

**Language.** There is no `language` input on `abap_read`: the ABAP side
tries the logon language, then `EN`, on its own, and the response reports
which language actually came back and whether that was a fallback, so a
caller never has to guess or ask twice. The response also lists what `DOKIL`
itself has available (`langu:typ:dokstate` per entry) — informational only,
never what `core.docu` used to choose a language, since `DOKIL` can be
stale (see `src/adt/fluid/builtin/core/abap-docu.ts`'s header comment: every
candidate language is tried directly against `DOCU_GET` and the first one
that returns lines wins, regardless of what `DOKIL` claims). Found nothing
in either language tried: the body reads `(no documentation in DE or EN)` or
the equivalent for whichever languages were actually tried.

**Not verbatim.** Documentation is SAP ITF text flattened to plain lines by
`CONVERT_ITF_TO_ASCII` (symbols resolved, formatting tags removed, `/:
INCLUDE` directives expanded) — it is not the verbatim ITF source. This note
is always attached to a non-`method` `docu` response.

**Refusals** (`assertViewCompatible`, `src/tools/read.ts`; wording is
specific to `docu` and never reuses `definition`'s or `digest`'s sentences):

| Input | Result |
|---|---|
| `view="docu"` combined with `format="raw"` | `UNSUPPORTED` — there is no XML descriptor of a documentation object to return. |
| `view="docu"` combined with `enhancements=true` | `UNSUPPORTED` — the enhancement decoders read an ENHO/ENHS document; `docu` reads `DOKHL`/`DOKTL` instead. |
| `view="docu"` combined with `version=` (any value) | `UNSUPPORTED` — `DOKHL`/`DOKTL` is not version-controlled the way ABAP source is; there is no active/inactive pair to select. |
| `view="docu"` combined with `outline=true` | `UNSUPPORTED` — `docu` reads a documentation object, which has no component structure. |
| `view="docu"` combined with `include=` | `UNSUPPORTED` — `docu` resolves its own target from type and name; there is no class-include axis on a documentation read. |
| `view="docu"` combined with `from`/`to`/`context` | `UNSUPPORTED` — a documentation object has no version feed to diff. |
| `view="docu"` combined with `line`/`column` | `UNSUPPORTED` — flattened documentation text has no line/column axis of its own. |
| `method=` against a non-`CLAS` object | `UNSUPPORTED`. |

**Gated as a write, not a read — the one exception.** Every other `view`
(including `docu` WITH `method=`, which stays available under
`ABAP_MODE=read` — see above) stays on `abap_read`'s ordinary
`pool.withRead` path. `docu` WITHOUT `method=` is routed differently,
mirroring `abap_search mode="source"` exactly: `core.docu` has no ADT REST
endpoint, so reaching it means deploying/calling a small generated ABAP
class through the fluid API, the same mechanism `abap_search`'s
`mode="source"` uses to deploy `ZCL_ZMCP_FLUID_SCAN`. Concretely
(`registerReadTools`, `src/tools/read.ts`): a fluid-disabled check first (a
more specific refusal than a generic write-denied would give on a read-only
connection), then a preflight write-target assert against the fluid body
class, then `pool.withWrite`. This needs the fluid API on and `ABAP_MODE`
not `read` — on a read-only server this path fails with `FLUID_API_DISABLED`
rather than the tool disappearing from the list. `core.docu` itself is also
deliberately **not** judged by `guardCoreAction`'s data-preview policy
(`src/adt/fluid/builtin/core.ts`): neither `assertDataPreview` nor
`ABAP_ALLOW_DATA_PREVIEW` applies to it, since it reads SAP's own
documentation text out of `DOKTL`, not application table data.

**Evidence.** `live` (A4H, probe class `ZCL_I109_PROBE`, 2026-09-15): every
`DOCU_GET` and `CONVERT_ITF_TO_ASCII` parameter `core.docu`'s ABAP relies on
— `DOKHL-ID`/`DOKHL-OBJECT` CHAR2/CHAR40 truncation handled by moving the
caller's input through DDIC-typed locals first; `DOCU_GET`'s `sy-subrc = 4`
(`ret_code`) as the "no documentation in this language" signal, with no
automatic fallback of its own; `typ = 'E'` accepted even when `DOKIL` lists
the object as type `T`; and `CONVERT_ITF_TO_ASCII` expanding a 6-line ITF
`BAL_DB_SEARCH` documentation to 36 ASCII lines, resolving `&FUNCTIONALITY&`/
`&USE&` symbols and stripping formatting tags. `imgDocuTarget`'s mapping was
also verified live against `TDCLD`/`DOCU_GET_LANGU_FOR_DISPLAY`.

Beyond that FM-level probe, `core.docu`'s own generated ABAP body was
itself run live on A4H (client 001, user DEVELOPER, 2026-09-15): deployed
to `$TMP` as `ZCL_I109_FLUID_CORE` and activated with zero syntax errors,
after fixing one runtime defect the probe surfaced — `lv_title` was
declared `TYPE string`, which a dynamic `DOCU_GET` call rejects for
`DOKTITLE` (`CX_SY_DYN_CALL_ILLEGAL_TYPE`); `DOCU_GET` declares
`VALUE(doktitle) LIKE dsyst-doktitle`, i.e. `DOKU_TITLE` → domain
`TEXT60` → `CHAR(60)`. Once fixed, four live calls through
`IF_OO_ADT_CLASSRUN` against `ZCL_ZMCP_FLUID_RT` all came back clean, no
`ERR` frame: `{"id":"DE","object":"MANDT"}` → `found:true`, 2 lines (the
empty `title` that came back is genuine upstream data — `DSYST` has no row
for `DOKNAME = 'MANDT'` — not a defect); `{"id":"NA","object":"BM019"}` →
6 lines; `{"id":"HY","object":"SIMGCRM_PRI_GRUKONKONTR"}` → 39 lines; and
`{"id":"DE","object":"ZZ_DOES_NOT_EXIST_I109"}` → `found:false`,
`lines_returned:0`, a clean summary and no dump. The probe object was
deleted afterwards.

The method-ABAP-Doc branch of `view="docu"` was confirmed in a later live
pass, on A4H, 2026-09-15: `abap_read
{"object":"ZCL_I108_RUNPROBE","type":"CLAS/OC","method":"GREET","view":"docu"}`
returned the method's three ABAP Doc lines with no gate and no fluid
dispatch — it had previously failed with `UNSUPPORTED … needs a
SafetyGate`. The probe class was deleted after the run.

Still not observed: the end-to-end `abap_fluid`/`abap_read view="docu"`
MCP call path itself — deploying `ZCL_ZMCP_FLUID_CORE`'s `docu` action
through the released server, dispatching through `dispatch()`, and
rendering the result through `readDocu`/`mapDocuRows` — since the live MCP
server available for this verification runs the previously released
bundle, not this branch; that path is covered by unit tests against fakes
only.

Example — a data element's documentation:

```json
{ "object": "ZDE_FOO", "type": "DTEL/DE", "view": "docu" }
```

Example — one method's ABAP Doc:

```json
{ "object": "ZCL_FOO", "type": "CLAS/OC", "view": "docu", "method": "PROCESS" }
```

### view="digest": one-page object overview

`view="digest"` renders a bounded, one-page overview of a `CLAS/OC`,
`INTF/OI`, `PROG/P`, `FUGR/F`, `FUGR/FF` or `DDLS/DF` object — six fixed
sections, always in this order: **HEADER**, **PUBLIC API**, **DIRECT
DEPENDENCIES**, **TESTS AND CHECKS**, **RECENT HISTORY**, **WHERE TO GO
NEXT**. Any other type is refused with `UNSUPPORTED`, naming the six
supported types. The type check (`isDigestType`, `src/adt/digest.ts`) is
case-insensitive and accepts a bare kind (`"CLAS"`, `"INTF"`, `"PROG"`,
`"DDLS"`) standing in for its one matching type — except `"FUGR"` alone,
which is refused, since it is ambiguous between `FUGR/F` and `FUGR/FF`.

All of the logic deciding what each section says — the dependency scan, the
program-interface scan, the test-class count, the public-API summary — is
pure, I/O-free code in `src/adt/digest.ts` (`scanDependencies`,
`scanProgramInterface`, `countTestClasses`, `summarisePublicApi`,
`buildDigestSections`); `src/tools/read.ts`'s `readDigest` only fetches the
ADT facts those functions need (source, history feed, outline for
CLAS/INTF) and hands them over. Every section is capped at 25 rows
(`DIGEST_MAX_ROWS_PER_SECTION`); a section that overflows is cut with a
`--- TRUNCATED --- <SECTION> cut after 25 of N rows; <full-read-call>` line
naming the call that returns the rest — the same `--- TRUNCATED ---`
convention `abap_search mode=source` and ordinary truncated reads use.

- **HEADER** — type, name, package, description, last-changed fact (with
  its source: `released` history or, absent any released version, the
  active state — the same distinction `view="history"` already draws for
  `$TMP`-style packages with no transport), and activation state.
- **PUBLIC API** — for `CLAS`/`INTF` objects, the outline's public members
  (`summarisePublicApi`): private/protected members are counted, not
  listed, by design — "a digest is a bounded page… must not spend rows on"
  member-level detail a caller can get from `outline=true` directly. For
  `PROG/P`, a line-by-line scan of `PARAMETERS`, `SELECT-OPTIONS` and
  `FORM` declarations, plus a note when `START-OF-SELECTION` is present.
  For `FUGR/FF`, `scanFunctionSignature` (`scanFunctionInterface` is a thin
  wrapper over it returning just the parameters) parses the function
  module's signature statically out of source ADT already returned. It
  tries the NATIVE `FUNCTION <name> IMPORTING ... EXPORTING ... .`
  signature statement first — a live system (A4H) was found to serve every
  function module this way, keywords upper- or lowercase, one parameter
  per line — walked section by section (`IMPORTING`/`EXPORTING`/
  `CHANGING`/`TABLES`/`EXCEPTIONS`/`RAISING`), giving one row per parameter
  with its name, section keyword, typing, and an `(optional)` marker for a
  `DEFAULT`/`OPTIONAL` line. When the statement itself carries no
  parameters, it falls back to the LEGACY form some sources still carry:
  SAP's older generated `*"*"Local Interface:` comment block, parsed the
  same way. A function module whose `FUNCTION` statement was found and
  walked but genuinely declares no parameters at all (e.g. `RFC_PING`, and
  no legacy comment block present either) also renders an empty section,
  but with its own note stating plainly that this is the module's real,
  parameterless signature — not a failed scan. Only when neither shape is
  present at all (a hand-edited or malformed source, or one shaped in a way
  this scan does not recognise) does the section render empty with the
  both-forms-tried note. A truncated `FUGR/FF` PUBLIC API names the call to
  re-read the object's own source (with `type` to disambiguate from the
  function group) as "the rest", not `outline=true` — `outline=true` is
  refused outright for this type, since these rows come from a source scan,
  not an outline scan.

  Verified live against A4H on 2026-09-15, through an MCP server built from
  this branch. `abap_read {"object":"BAL_LOG_MSG_READ","type":"FUGR/FF",
  "view":"digest"}`, PUBLIC API section verbatim:

  ```
  --- PUBLIC API ---
  name                      kind        detail
  ------------------------  ----------  -----------------------
  i_s_msg_handle            IMPORTING   TYPE balmsghndl
  i_langu                   IMPORTING   TYPE sylangu (optional)
  e_s_msg                   EXPORTING   TYPE bal_s_msg
  e_exists_on_db            EXPORTING   TYPE boolean
  e_txt_msgty               EXPORTING   TYPE c
  e_txt_msgid               EXPORTING   TYPE c
  e_txt_detlevel            EXPORTING   TYPE c
  e_txt_probclass           EXPORTING   TYPE c
  e_txt_msg                 EXPORTING   TYPE c
  e_warning_text_not_found  EXPORTING   TYPE boolean
  log_not_found             EXCEPTIONS
  msg_not_found             EXCEPTIONS
  ```

  `STRING_CENTER` renders `STRING IMPORTING TYPE ANY`, `CSTRING EXPORTING
  TYPE ANY` and `TOO_SMALL EXCEPTIONS` the same way. A lowercase-keyword
  source parses identically — `LVC_FIELDCATALOG_MERGE`, which also carries a
  `CHANGING` section and `LIKE` typings:

  ```
  --- PUBLIC API ---
  name                    kind        detail
  ----------------------  ----------  -----------------------------
  i_buffer_active         IMPORTING   type any (optional)
  i_structure_name        IMPORTING   like dd02l-tabname (optional)
  i_client_never_display  IMPORTING   type slis_char_1 (optional)
  i_bypassing_buffer      IMPORTING   type char01 (optional)
  i_internal_tabname      IMPORTING   like dd02l-tabname (optional)
  ct_fieldcat             CHANGING    type lvc_t_fcat
  inconsistent_interface  EXCEPTIONS
  program_error           EXCEPTIONS
  ```

  `BAPI_USER_GET_DETAIL` has a `TABLES` section and overflows the 25-row
  section budget — its last rows and truncation marker, verbatim:

  ```
  parameter       TABLES     like bapiparam (optional)
  profiles        TABLES     like bapiprof (optional)
  activitygroups  TABLES     like bapiagr (optional)
  return          TABLES     like bapiret2
  addtel          TABLES     like bapiadtel (optional)
  addfax          TABLES     like bapiadfax (optional)
  addttx          TABLES     like bapiadttx (optional)
  --- TRUNCATED --- PUBLIC API cut after 25 of 44 rows; abap_read {"object":"BAPI_USER_GET_DETAIL","type":"FUGR/FF"}
  ```

  `RAISING` was confirmed on a throwaway `$TMP` function module written for
  the check (deleted afterwards), whose signature declared
  `RAISING CX_SY_CONVERSION_ERROR CX_SY_ITAB_LINE_NOT_FOUND`:

  ```
  cx_sy_conversion_error     RAISING
  cx_sy_itab_line_not_found  RAISING
  ```

  `RFC_PING` — a function module whose whole source is `FUNCTION RFC_PING.`
  … `ENDFUNCTION.` — renders `(no parameters found by the source scan)` plus
  the parameterless note, verbatim:

  ```
  NOTE: PUBLIC API is empty for RFC_PING: its native "FUNCTION RFC_PING ... ." statement was found and parsed, and it declares no IMPORTING, EXPORTING, CHANGING, TABLES, EXCEPTIONS or RAISING clause at all — this module takes nothing, returns nothing and raises no exception. That is its real signature, not a limitation of this scan.
  ```

  For `DDLS/DF`,
  `scanCdsFields` parses the projected field list out of the `select from
  { ... }` block when it can do so with confidence — resolving `as
  <alias>` and stripping `key`/`@Annotation` prefixes — and falls back to
  an **empty section with an explicit note**, rather than a partial list,
  the moment it meets a cast, a function call, a sub-select, or a bare
  (non-navigated) association in the select list: a wrong field list is
  worse than an empty one, so it gives up on the whole view rather than
  guess. **Only `FUGR/F` (the function group itself) still always renders
  an empty PUBLIC API**, with an explicit note: listing a function group's
  modules needs a search call — there is no `/objectstructure`-style
  listing for a group — and this view deliberately never makes one; use
  `abap_search` to list a group's modules, or point `digest` at one of
  them directly (`FUGR/FF`).
- **DIRECT DEPENDENCIES** — a static regex/token scan of the object's
  source (`scanDependencies`), recognizing `INHERITING FROM`, `INTERFACES`,
  `TYPE REF TO`, a single-token `TYPE <name>` (stops at the first space, so
  `TYPE STANDARD TABLE OF zcl_foo` never gets past `STANDARD`), `CALL
  FUNCTION '...'`, `CALL TRANSACTION '...'`, `SUBMIT`, static `<NAME>=>`
  access, `SELECT ... FROM <table>` (including `SELECT SINGLE`, `FROM <t>
  AS <alias>`, and a joined select's `JOIN <table>`), and `INCLUDE
  <program>.` — never instance `->` access, which cannot be resolved
  statically. `FROM @<itab>` (Open SQL's host-variable escape, reading an
  internal table rather than a database table) is not reported as a
  dependency. The `SELECT`/`JOIN` scan is skipped entirely for `DDLS/DF`
  (CDS) source, where `select from <entity>` is DDL projection syntax, not
  an Open SQL statement. ABAP built-in types and common local-variable name
  prefixes (`lt_`, `ls_`, `lv_`, `lo_`, `lr_`, `gt_`, `gs_`, `gv_`, `go_`,
  `ty_`, `t_`) are filtered out. Each row names a `via` (how the dependency
  was found) and a ready-to-run `abap_read` call for it — a function module
  dependency is offered as `{"object":"<name>","type":"FUGR/FF"}`, a
  transaction as `abap_search {"query":"<name>"}` (there is no registered
  ADT type for a transaction), a `SELECT`/`JOIN` table as
  `{"object":"<name>","type":"TABL/DT"}`, an `INCLUDE` as
  `{"object":"<name>","type":"PROG/I"}`, everything else as a plain
  `{"object":"<name>"}`.
- **TESTS AND CHECKS** — for `CLAS` objects, whether a `testclasses` include
  exists and how many `FOR TESTING` classes it declares
  (statement-joined regex over the include's source, so a `FOR TESTING`
  clause split across lines is still found); for every type, ready-to-run
  `abap_test`/`abap_atc` calls. Tests are never actually run for a digest.
- **RECENT HISTORY** — the 3 most recent version-feed entries, after
  de-duplicating consecutive same-version rows the same way
  `view="history"`'s own rendering does.
- **WHERE TO GO NEXT** — concrete follow-up `abap_read` calls: the full
  source, the full outline (CLAS/INTF only), and the full version history.

**Where-used is deliberately never fetched.** `abap_search
mode="where_used"` walks ADT's `usageReferences` endpoint, which is
unbounded — no limit, no paging, 20+ seconds on a wide fan-in (see
[mode=source's evidence section](#modesource-line-wise-source-text-scan)
above and `abap_search`'s own where-used documentation). A digest names
that call in a note instead of running it: `Where-used is not fetched:
ADT's usageReferences endpoint is unbounded and can take 20+ seconds on
wide fan-in. Run it explicitly with abap_search
{"query":"<name>","mode":"where_used"}.` The issue that requested this
feature also named `abap_read view="footprint"` and `abap_search
mode="call_graph"` — neither exists in this codebase, and this digest never
names either.

**Refusals** (`assertViewCompatible`, `src/tools/read.ts`):

| Input | Result |
|---|---|
| `view="digest"` against a type outside the six supported | `UNSUPPORTED`, naming `CLAS/OC, INTF/OI, PROG/P, FUGR/F, FUGR/FF, DDLS/DF`. |
| `view="digest"` combined with `format="raw"` | `UNSUPPORTED` — a digest is a rendered overview built from several reads, not the object's own current XML descriptor. |
| `view="digest"` combined with `enhancements=true` | `UNSUPPORTED` — the enhancement decoders read an ENHO/ENHS document; a digest summarises the object instead. |
| `view="digest"` combined with `version=` (any value) | `UNSUPPORTED` — a digest always summarises the current active state (falling back to the newest inactive version the way an ordinary read would); active/inactive is not a per-section selector. |
| `view="digest"` combined with `outline=true` | `UNSUPPORTED` — the PUBLIC API section is already built the same way `outline=true` is; asking for both would run that pass twice. |
| `view="digest"` combined with `method=` | `UNSUPPORTED` — a digest is a fixed overview of the object as a whole; the PUBLIC API section already lists every public method. |
| `view="digest"` combined with `include=` | `UNSUPPORTED` — a digest always reads the class's own main source plus its testclasses include, never a caller-picked one. |
| `view="digest"` combined with `from`/`to`/`context` | `UNSUPPORTED` — a digest summarises the current state only, not a comparison between versions. |
| `view="digest"` combined with `line`/`column` | `UNSUPPORTED` — a digest is a fixed overview, not a position lookup. |

**Gated as read, not write.** Unlike `docu`, `digest` stays on the ordinary
`pool.withRead` path throughout — it only reads source, outline and history
through machinery `abap_read` already uses for a plain read, so it needs
nothing beyond what that path already provides, and it remains available
under `ABAP_MODE=read`.

**Evidence.** The section-building logic (`buildDigestSections` and the pure
scan/summary functions it calls) is covered by unit tests against
constructed `DigestInput` fixtures. It was also confirmed live on A4H,
2026-09-15: `abap_read {"object":"STRING_CONVERSIONS","type":"FUGR","view":"digest"}`
was refused with `UNSUPPORTED`: `type="FUGR" is ambiguous for
view="digest": it could mean the whole function group (FUGR/F) or a single
function module (FUGR/FF), and digest needs to know which.` And
`abap_read {"object":"ZCL_I108_VIS_PROBE","type":"CLAS/OC","view":"digest"}`
— a class with one public method, one private method and one interface
implementation — rendered both public rows and `1 private component(s) not
listed`, matching what `outline=true` shows a human. The probe class was
deleted after the run.

Example:

```json
{ "object": "ZCL_FOO", "type": "CLAS/OC", "view": "digest" }
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
unconditional, for all four modes. `mode=objects`, `mode=where_used`, and
`mode=call_graph` are pure reads with no further gate — `call_graph` sits
in the same tier as `objects`/`where_used` because it is built entirely
from a `usageReferences` chain (`callers`) or a source read plus a local
text parse (`callees`), neither of which deploys anything. `mode=source` is
different: it is read-SHAPED (it never changes an object the caller asked
about) but it deploys and runs a generated ABAP class the same way
`abap_fpm_read` does, so it needs the fluid API and takes the write slot —
it does **not** run under `ABAP_MODE=read`, unlike `abap_img`. Concretely,
`mode=source` needs `ABAP_FLUID_API` on and `ABAP_MODE` not `read`; when
either condition fails, the tool stays registered and the call refuses at
run time with `FLUID_API_DISABLED`, naming the gate that is off, rather
than the mode disappearing from the tool list.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `query` | string | yes | — | Name pattern (`mode=objects`), target object (`mode=where_used`/`call_graph`), or literal/regex text (`mode=source`, max 255 characters). |
| `mode` | enum `objects` \| `where_used` \| `source` \| `call_graph` | no | `objects` | Object search, where-used analysis, a source-text scan, or a multi-level caller/callee walk — see ["mode=call_graph: caller/callee tree"](#modecall_graph-callercallee-tree) below. |
| `type` | string | no | — | `mode=objects`/`where_used`/`call_graph` only. Restrict to one ADT type. Refused under `mode=source` — use `types` instead. |
| `direction` | enum `callers` \| `callees` | no | `callers` | `mode=call_graph` only. `callers`: who calls this (via `usageReferences`, same endpoint as `where_used`). `callees`: what this calls (a static text parse of its own source). Refused with `BAD_INPUT` under any other mode. |
| `depth` | number (int, positive) | no | `2` | `mode=call_graph` only. Levels to expand. Max 4 — a `depth` above the max is refused with `BAD_INPUT`, never silently clamped down to it. Refused with `BAD_INPUT` under any other mode. |
| `max` | number (int, positive, ≤200) | no | `50` rows (`objects`/`where_used`), `100` hits (`source`), or `50` children per node (`call_graph`) | Maximum rows/hits/children to return. For `call_graph`, narrowing `query` (not lowering `max`) is what makes a broad call cheaper — see the Evidence paragraph below. |
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

**Output and truncation.** Hits are grouped per object (issue #148 —
38 hits used to cost ~8K characters as one row per hit with the object
name repeated on every row). Each object gets one header line,
`<TYPE> <NAME>  (<n> hits)`, followed by one `  <line>: <text>` row per hit
(text clipped to 120 characters for display). Where an object's hits sit
in includes whose name is not the object's own — a class's method includes,
a function group's includes — an `  include <NAME>` sub-header precedes
that include's rows, since that name is what the `abap_read` follow-up
takes. Line numbers are include-local — for a CLAS/FUGR hit, `line`
counts from the top of the matching include, not from the object. An
object shows at most 20 hits (`SOURCE_PER_OBJECT_HIT_CAP`,
`src/tools/search.ts`); the header then says `(<n> hits, 20 shown)` and a
`  ... <k> more hit(s) in <NAME> not shown (per-object cap 20; narrow
`query`, or scope with objects="<NAME>").` row closes the group, so one
noisy object cannot push every other object's first hit off the page. The
header carries `objectsWithHits` next to `hits`, and a `size:` line for
the response itself. The `NOTE:` lines (include-local numbering, the
text-scan caveat, the `abap_read` follow-up) appear once at the top of the
response, never per hit. Both ways the scan can run out of room are marked
in the body with a `--- TRUNCATED ---` line, never left silent: the hit cap
(`max`, default 100) and the object-scope ceiling (200). Offline coverage:
`test/search-source-grouping.test.ts`.

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

### mode=call_graph: caller/callee tree

Walks multiple levels of callers or callees from one object, instead of the
single level `mode=where_used` and `mode=source` each answer on their own.

`direction="callers"` (the default) chains `usageReferences` fetches one
level at a time — the same endpoint and the same `fetchUsageReferences`
code path `mode=where_used` uses (`src/adt/element-info.ts`), so it
inherits that path's cost profile and its namespace-prefix workaround; see
[doc/LIMITATIONS/search.md](../LIMITATIONS/search.md). `direction="callees"`
answers a different question with a different mechanism: it reads the
object's own source and pattern-matches call sites
(`src/adt/call-sites.ts`) — `CALL FUNCTION`, `CALL METHOD`/functional
method syntax, `PERFORM … IN PROGRAM`, `SUBMIT`, `CALL TRANSACTION` — since
there is no ADT endpoint that answers "what does this object call." A
dynamic target (`CALL FUNCTION lv_name`, `PERFORM (lv_form)`, `SUBMIT
(lv_prog)`, or any `lo_ref->method( )` call through an instance reference,
whose static type cannot be read off the call site) cannot be resolved to
a name from source text alone and is reported unresolved rather than as an
edge.

**Refusals** (`abapSearch`/`assertNoCallGraphOnlyFields`, `src/tools/search.ts`):

| Input | Result |
|---|---|
| `depth` above 4 | `BAD_INPUT` — refused, not clamped: `depth=N exceeds the maximum of 4 for mode="call_graph".` |
| `direction` and/or `depth` given under any mode other than `call_graph` | `BAD_INPUT` — naming the field(s) that would otherwise have been silently discarded. |

**Cost.** A `callers` walk's cost is set by fan-in and depth, not by
`max` — the children-per-node cap is applied after each node's own
complete `usageReferences` fetch, the same fetch-then-filter shape
`mode=where_used` uses, so lowering `max` does not reduce the fetch cost at
any one node. The only measured cost data point is `CL_ABAP_TYPEDESCR`: about
5,896 references at roughly 24 seconds wall-clock on A4H — a single node,
not a whole walk, and the thresholds derived from it
(`HIGH_FAN_IN_REFERENCES`/`SLOW_FETCH_MS`) are disclosed in
`element-info.ts`'s own comment as round numbers, not a fitted curve.
`callees` has no comparable cost concern — one source read plus a
line-by-line regex pass per node, no server-side fan-out.

**Not proof of absence.** An unresolved dynamic callee is not evidence the
call target doesn't exist — `mode=source` is the tool to search for its
literal name instead. Likewise a `FUGR/FF` callee that fails to resolve by
name is not proof that function module doesn't exist: quickSearch does not
index every generated function module (captures 850/851, already
documented in [doc/LIMITATIONS/search.md](../LIMITATIONS/search.md)).

**Evidence.** The `callees` source parser is exercised offline (`tests` in
this document set's vocabulary) against two real `$TMP` probe classes built
for this issue: `ZCL_I105_A` (fixture 974 — a static method call, `CALL
FUNCTION 'RFC_SYSTEM_INFO'`, a `SUBMIT` of a report that does not exist,
and a method call on another class) and `ZCL_I105_B` (fixture 975 — a
`PERFORM … IN PROGRAM` call alongside a static method call). The `callers`
side is exercised offline against real `usageReferences` wire bytes for a
two-object caller cycle (`ZCL_I105_A`/`ZCL_I105_B`, fixtures 971/972 — what
the `(cycle -> seen above)` marker must cut) and a one-caller leaf
(`ZCL_I105_LEAF`, fixture 973). The assembled `abap_search mode=call_graph`
MCP call has not been exercised end to end against a live server — the
reference system runs a previously released bundle that predates this
feature — so that path is `unverified`, and no future live run against it
is anticipated in this document.

Example — walking two levels of callers from `ZCL_I105_LEAF`:

```json
{
  "query": "ZCL_I105_LEAF",
  "type": "CLAS/OC",
  "mode": "call_graph",
  "direction": "callers",
  "depth": 2
}
```

Example — walking what `ZCL_I105_A` calls:

```json
{
  "query": "ZCL_I105_A",
  "type": "CLAS/OC",
  "mode": "call_graph",
  "direction": "callees",
  "depth": 1
}
```

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

