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
| `view` | enum `history` \| `diff` | no | — | `history`: list the object's version feed (author, date, transport) instead of source/DDIC. `diff`: return unified-diff hunks between two versions — never two full sources. Omit for a normal source/DDIC read. |
| `from` | string | `view="diff"` only | released version before `to` | Older side of the diff — a version number (e.g. `"66"`), a transport name, or the literal `"active"` for current source. |
| `to` | string | `view="diff"` only | newest released version | Newer side of the diff, same forms as `from`. |
| `context` | number (int, 0–20) | no | `3` | `view="diff"` only — unchanged context lines per hunk. |
| `include` | enum `CLASS_INCLUDES` | no | `"main"` | Classes only — which class include to read; applies to the source read and to `view` alike. `"testclasses"` holds ABAP Unit tests; `"main"` never does. Always an explicit, disclosed choice — silently defaulting to `main` would hide changes made in another include. |

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

