---
name: abapsmith-explore-a-package
description: Maps an unfamiliar ABAP package or object with abap_search and abap_read — what is in it, what calls what, and what changed. Use when asked to survey, understand, or find your way around code you did not write.
---

# Exploring a package

Read-only. Nothing here writes to the system — this is `abap_search` and
`abap_read` only, chained in the order below.

## The pipeline

1. `abap_search mode="objects"` — find the package by name pattern.
2. `abap_read` the package itself, `type: "DEVC/K"` — lists its direct contents.
3. `abap_read` a class of interest with `outline: true` — its component list.
4. `abap_read` one method by name — `method:` — instead of the whole class.
5. `abap_search mode="where_used"` — who calls this object.
6. `abap_read view="history"` / `view="diff"` — what changed and when.

## Live transcript (A4H, 2026-09-12)

Everything in this section was observed against reference system A4H on that
date. Numbers, note text and behaviour below are what the server actually sent.

**a. A broad sweep discloses its own cost.**
`abap_search { "query": "Z*", "type": "DEVC", "max": 30 }` returned 6 customer
packages, plus `serverHits: 300`, `droppedByTypeFilter: 294`, `fetchMax: 300`,
an `UNDER-REPORTED` note, and a `--- TRUNCATED ---` marker. `max` bounds what is
**shown**, not what is **fetched** — the server's own type filter is not
trusted, so filtering happens client-side after a wide untyped fetch.
**Narrowing the query — not lowering `max` — is what makes a call cheaper.** A
broad `Z*` sweep costs the same whatever `max` you pass.

**b. Reading a package works, and it is the fastest way to see what is in one.**
`abap_read { "object": "$TMP", "type": "DEVC/K" }` returned the package's
direct ADT node contents: `objects: 391`, `subPackages: 1`, `mode: ddic`, an
etag, an "OBJECTS BY TYPE" count table (`CLAS/OC 5`, `PROG/P 3`, `TABL/DT 1`,
…), then a name/description listing. Two notes came with it: "a package is
not a DDIC object: this is its direct node contents, not pseudo-DDL", and "1
sub-package(s) are listed but NOT expanded — their contents are not included
here. Read each sub-package to see them." A package read is **one level
deep**; recurse by hand for sub-packages. A separate read of a real customer
package returned `objects: 0` with the note "the ADT node structure returned
no objects. This is what the server sent, not a rendering failure." — an
empty package listing is an answer, not a failure.

**c. Observed defect worth a warning.** In that `$TMP` listing the
`description` column was misaligned against the `name` column by one row:
`ZCL_I72_RUNNER` printed carrying the description "Class ZCL_I72_PROBE",
`ZCL_I72_SCAN` carrying "Class ZCL_I72_RUNNER", and so on down the block. This
was an observed, reproducible-looking shift on A4H on that date — not a
proven general defect. The practical rule: **do not trust the description
column of a listing to belong to the row it is printed beside** — confirm by
reading the object. `abap_search` carries its own explicit `DESCRIPTIONS MAY
BE MIS-PAIRED` warning for the same class of problem (see
`src/tools/search.ts`), so this is a known hazard in listings generally, not
a one-off.

**d. Outline row count and component count are different numbers.**
`abap_read { "object": "CL_ADT_REST_RESOURCE", "type": "CLAS/OC", "outline": true }`
returned `components: 39` but an outline of only **8** rows, each
`NAME [public|protected|private instance] lines N-M`. The component count and
the outline row count mean different things — the outline lists what is
implemented, with its line ranges. Use those line ranges, or `method:`, to
read one method instead of the whole class.

**e. Where-used on a wide target is slow, and can still come back empty.**
`abap_search { "mode": "where_used", "query": "ZIF_APACK_MANIFEST", "max": 10 }`
took **19.2 seconds to return zero references**. The response said so itself:
"ADT's usageReferences endpoint has no server-side limit, so the entire set is
enumerated and transferred before `max` is applied. The cost is set by the
target's fan-in, not by `max` — lowering `max` would not have made this call
cheaper." Budget for that: a where-used on a widely-referenced object is a
slow call, and a fast way to get nothing is to ask about a narrower object.
Where-used is also **static**: dynamic calls (`CALL FUNCTION lv_name`,
`PERFORM (lv_form)`, `SUBMIT (lv_prog)`) do not appear, and those are blind
spots, not absences.

**f. A `$TMP` object can have no history at all.**
`abap_read { "object": "ZCL_I92_PROBE", "type": "CLAS/OC", "view": "history" }`
on a `$TMP` class written and activated three times returned `versions: 1`,
`released: 0`. SAP writes a version row **on transport release or upgrade
import, never on local activation**, so a `$TMP` / local object accumulates no
history no matter how often it is edited. `00000` is the ACTIVE pseudo-version
and serves the object's *current* source rather than a snapshot; `99999` is
INACTIVE. **Neither is history**, and with no predecessor there is nothing for
`view: "diff"` to compare against. Also: ADT versions each class **include**
separately, so a change made in `testclasses` does not appear in `main`'s
history — re-run with the `include` you care about. The raw feed is also
noisy and unsorted (one captured A4H feed returned 68 entries, of which about
60 were the same ACTIVE row); the tool de-duplicates by version number and
sorts newest-first, so what you see is already cleaned up. An empty
transport/author/date column is the feed's own silence, not a lookup failure.

## Refusals and limits

- Responses are capped and **truncation is always marked** — a
  `--- TRUNCATED ---` marker or a `response:` line with `truncated`/`hasMore`
  means you are looking at part of the answer. Never treat a truncated list as
  complete.
- `include: "testclasses"` is how you see a class's unit tests; they are not
  in `main`.
- An `etag` from a read is what you pass as a later write's `expect_etag`,
  which is how you find out someone else changed the object underneath you.
- `view: "diff"` needs a `from`/`to` and something to compare — see (f) above
  for the case where there is nothing to diff against at all.
- Reads are unaffected by `ABAP_MODE`; this whole skill works on a read-only
  server.

## How to prove it

A survey is proven by naming objects and line ranges you actually read back,
not by a plausible summary. When a listing and a read disagree — as the
misaligned description column above shows they can — the read of the object
wins.

## Not this skill

Creating anything is `abapsmith-create-an-object` (or `abapsmith-orient` to
check what abapsmith can build first). Customizing structure (SPRO) is
`abapsmith-browse-img-customizing`. Table rows need `abap_data_preview`,
which is off by default.
