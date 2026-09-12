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

Search the ABAP repository by name or find where an object is used.

**Availability**: case 2 — always registered, unconditional.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `query` | string | yes | — | Search text. |
| `mode` | enum `objects` \| `where_used` | no | `objects` | Object search vs. where-used analysis. |
| `type` | string | no | — | Restrict to one ADT type. |
| `max` | number (int, positive, ≤200) | no | `50` | Maximum hits to return. |

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

