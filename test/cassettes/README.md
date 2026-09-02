# Cassettes

## What a cassette is

A cassette is a single committed JSON file recording **one real HTTP
exchange genuinely captured against the live A4H SAP sandbox appliance**:
the exact request that went out over the wire and the exact response that
came back. Cassettes exist to replace the hand-authored mock ADT server
(`test/helpers/fake-adt.ts`) as the source of truth for what a real ADT
endpoint actually does — that fake has drifted from the real wire protocol
before, and drift there has caused real bugs. Going forward, the fake is
meant to be *generated* from cassettes rather than hand-maintained.

The format is defined by the zod schema in `schema.ts` (`CassetteSchema`,
exported type `Cassette`). Every field:

- `id` — must equal the file's own slug (see naming convention below).
- `recordedAt` — ISO 8601 timestamp with an explicit offset, from the
  capture harness (or, for a transcribed source, the best timestamp the
  source document actually supports — see `source.notes` when it is
  approximate).
- `recordedDurationMs` *(optional)* — real wall-clock duration of the
  exchange, when known. Especially meaningful for long-poll endpoints
  (e.g. a debugger listener that genuinely blocked for several seconds).
- `appliance` — `sid`, `client`, and (optional) `kernelRelease`,
  `kernelPatchLevel`, `server` at capture time. Recorded per cassette,
  not assumed constant, because A4H's build can change across a rebuild.
- `source` — provenance:
  - `type`: `"live-capture-raw"` for a cassette transcribed directly from a
    raw capture artifact (a `*.meta.json` + body-file pair, or equivalent),
    or `"live-capture-transcribed"` for a cassette transcribed from a
    human-readable rendering of a raw capture embedded in prose
    documentation (e.g. a fenced code block in a `docs/*.md` file that
    itself cites a raw capture file).
  - `citation`: exact path(s) to the primary source file(s), or a doc
    section reference precise enough for someone to go find the same bytes.
  - `notes`: free-text — redaction decisions, filename/content
    discrepancies, anything a reader needs to trust (or correctly distrust)
    this cassette.
- `request` — `method`, `path` (path + query string, no scheme/host),
  `headers`, `body` (`null` when absent, e.g. most GETs).
- `response` — `status`, `headers`, `body` (`null` for a genuinely empty
  body).

## Directory layout

```
test/cassettes/<category>/<slug>.cassette.json
```

`category` groups cassettes by the ADT sub-API the request path belongs to
— `debugger` (`/sap/bc/adt/debugger/...`), `classes`
(`/sap/bc/adt/oo/classes/...`), `programs` (`/sap/bc/adt/programs/...`),
`datapreview` (`/sap/bc/adt/datapreview/...`). A path that does not fit one
of those four gets its own category named after its own sub-API segment
(e.g. `classrun` for `/sap/bc/adt/oo/classrun/...`) rather than being
shoehorned into an unrelated one — extend the set deliberately, don't force
a fit.

## Staleness window

`registry.ts` exports `STALENESS_WINDOW_DAYS = 90` and a pure
`isStale(cassette, now?)` helper. A4H is an expendable, periodically-rebuilt
experimental sandbox — its kernel release/patch level (and potentially
finer wire-protocol details) can change across a rebuild with no signal to
this repo, and this project has already shipped real defects from
fake/wire drift within weeks of active development. 90 days forces
roughly-quarterly re-verification — inside a typical SAP support-package
cadence — without demanding a fresh live capture on every commit, because
live A4H access is exclusive and contended among concurrent agents, and
re-recording a cassette means deliberately scheduling a live session, not
something that happens as a side effect of unrelated work.

## Adding a new cassette

1. It must come from a genuine live capture against the real appliance —
   never hand-written content that merely looks plausible. If you captured
   it yourself, save the raw request/response bytes first (e.g. alongside
   `test/fixtures/live-captured/`, following that directory's
   `*.meta.json` + body-file convention), then transcribe from that file,
   not from memory.
2. Cite the exact provenance in `source.citation` — a path, or a doc
   section precise enough that someone else can find the same bytes.
3. Redact real secrets (`Authorization`, `Cookie`, `Set-Cookie` values) with
   an obvious placeholder like `<redacted-session-cookie>`; if the primary
   source already redacted a value, preserve its placeholder as-is rather
   than inventing a new one. Note any redaction you personally performed in
   `source.notes`.
4. Run it against `test/cassettes/cassette-lint.test.ts` (added by a
   follow-up task) before committing.

**Do not hand-write cassette content that wasn't actually captured from the
real appliance.** This format exists specifically to prevent that failure
mode — a plausible-looking fabricated exchange is worse than no fixture at
all, because it looks exactly as trustworthy as a real one until something
in production disagrees with it.
