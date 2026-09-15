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
| `method` | string | no | — | Read one method's source instead of the whole class. With `view="docu"` against a `CLAS` object, selects that method's ABAP Doc comment instead of the class's own SAP documentation — refused against every other `view`. |
| `outline` | boolean | no | — | Return the structural outline (members/methods) instead of full source. |
| `offset` | number (int, 1–999999) | no | — | 1-based first line to return. |
| `limit` | number (int, 1–999999) | no | — | Number of lines to return. |
| `enhancements` | boolean | no | — | Also report enhancement anchors/implementations on this object. |
| `version` | enum `active` \| `inactive` | no | `active` | Which version to read. |
| `format` | enum `raw` | no | — | Return unprocessed source instead of the rendered/annotated form. |
| `view` | enum `history` \| `diff` \| `definition` \| `docu` \| `digest` | no | — | `history`: list the object's version feed (author, date, transport) instead of source/DDIC. `diff`: return unified-diff hunks between two versions — never two full sources. `definition`: element info / go-to-definition for the identifier at `line`/`column` — see ["view=\"definition\": element info and go-to-definition"](#viewdefinition-element-info-and-go-to-definition) below. `docu`: SAP's own documentation for the object (or, with `method=`, one method's ABAP Doc) — see ["view=\"docu\": SAP documentation"](#viewdocu-sap-documentation) below. `digest`: a fixed six-section overview — see ["view=\"digest\": one-page object overview"](#viewdigest-one-page-object-overview) below. Omit for a normal source/DDIC read. |
| `from` | string | `view="diff"` only | released version before `to` | Older side of the diff — a version number (e.g. `"66"`), a transport name, or the literal `"active"` for current source. |
| `to` | string | `view="diff"` only | newest released version | Newer side of the diff, same forms as `from`. |
| `context` | number (int, 0–20) | no | `3` | `view="diff"` only — unchanged context lines per hunk. |
| `line` | number (int, ≥1) | required with `view="definition"`; refused otherwise | — | 1-based source line — same convention as `abap_quick_fix`. Refused with `UNSUPPORTED` together with `view="history"`/`"diff"`/`"docu"`/`"digest"`, and refused with `BAD_INPUT` if given with no `view` at all (it would silently be discarded by an ordinary read). |
| `column` | number (int, ≥0) | no | `0` | 0-based column — same convention as `abap_quick_fix`. Only meaningful with `view="definition"`; refused otherwise on the same terms as `line`. |
| `include` | enum `CLASS_INCLUDES` | no | `"main"` | Classes only — which class include to read; applies to the source read and to `view` alike. `"testclasses"` holds ABAP Unit tests; `"main"` never does. Always an explicit, disclosed choice — silently defaulting to `main` would hide changes made in another include. Refused with `UNSUPPORTED` together with `view="docu"` or `view="digest"` — `docu` resolves its own documentation target from the object's type and name and has no class-include axis; a digest always reads the class's own main source plus its testclasses include, never a caller-picked one. |
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
  `core.docu`.

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
(including `docu` WITH `method=`) stays on `abap_read`'s ordinary
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

**Not on the v2 tool surface.** Same as `view="definition"` above: v2's
`abapReadInputSchema` (`src/tools/v2/schemas.ts`) does not expose
`view="docu"`, `view="digest"`, or `method` on this axis — its `view`
values are `source | contract | method | diff | metadata | outline | bopf |
fpm`, a disjoint vocabulary from v1's.

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

Not observed by that run: the method-ABAP-Doc branch of `view="docu"` — it
reads class source directly in TypeScript and never touches `core.docu`
(see above), so this probe exercised nothing on that path either way.
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
  For `FUGR/FF`, `scanFunctionInterface` parses the function module's
  signature statically out of ADT-generated source: SAP's own
  `*"*"Local Interface:` comment block, walked section by section
  (`IMPORTING`/`EXPORTING`/`CHANGING`/`TABLES`/`EXCEPTIONS`), giving one row
  per parameter with its name, section keyword, typing, and an
  `(optional)` marker for a `DEFAULT`/`OPTIONAL` line. If the source
  carries no such block (a hand-edited or malformed source), the section
  renders empty with an explicit note saying so. For `DDLS/DF`,
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

**Not on the v2 tool surface** — see the note under `view="docu"` above;
the same applies here.

**Evidence.** The section-building logic (`buildDigestSections` and the pure
scan/summary functions it calls) is `tests`-only: covered by unit tests
against constructed `DigestInput` fixtures, not by a live capture. **Not yet
verified live**: an end-to-end `abap_read view="digest"` call against a real
object on a live server — the ADT calls it composes (`listRevisions`,
`readSource`, `classMembers`) are each independently exercised elsewhere in
this document's evidence sections, but the digest assembly itself has not
been run against a live server on this branch.

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

