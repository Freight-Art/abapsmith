# API surface and data integrity

Why some decisions look odd from the outside. Each entry states the rejected
alternative and what decided it. See also [Safety and concurrency
design](safety-and-concurrency.md) for the session- and auth-level notes.

## Nothing is installed on the ABAP system

**Instead of:** shipping a `Z` ICF service or ABAP-side helper package that the
server calls.

A server-side component would reach object types ADT cannot, and other tools in
this space do exactly that. It also means an installation, a transport, a
version-skew problem between the Node and ABAP sides, and a change to the
system you're trying to be careful with.

This server installs nothing. Where ADT's REST surface has no endpoint —
report execution, BOPF runtime, FPM configuration reads, some enhancement
operations — it generates a **throwaway `$TMP` classrun bridge**
(`IF_OO_ADT_CLASSRUN`), runs it, and reads its list output. The bridge is an
ordinary object in the same namespace and package the safety gate already
governs, so it inherits every existing control instead of needing new ones.

The cost is honest: bridge execution is slower than a native endpoint, cold
execution slower still, and anything the bridge cannot express is simply
unreachable.

## Tool schemas are treated as a budget

Tool count is a first-class constraint: every schema is re-sent with every
request and competes with the ABAP source you actually want in context.

Measured on real `tools/list` payloads:

| Surface | Tools | Schema |
|---|---|---|
| Reference point: a large MCP server | 147 | ≈ 40k tokens |
| Reference point | 100 | ≈ 14k tokens |
| Consolidated surface, early | 2 | 2,374 B |
| Consolidated surface | 5 | 4,467 B |
| Consolidated surface | 6 | 5,999 B |

The original design target was ~13 tools at ~4k of schema. **Those two halves
turned out not to be simultaneously achievable**, and the descriptions won:

1. The 40k figure was the actual problem. Landing anywhere near 10k already buys
   back most of it; squeezing further trades against a per-response cap that a
   single class read can consume in one call.
2. **A compressed description costs more than it saves, because the failure mode
   is a wrong tool call** — a round trip, a model turn, and on a write path a
   real change to a real system. `abap_journal` is the sharpest case: its
   description spends bytes explaining why an undo gets refused and what `force`
   does. A model that does not understand the refusal simply retries with
   `force: true`, which is precisely the silent data loss the refusal exists to
   prevent. Those bytes are cheaper by orders of magnitude.
3. The `mode`-discriminator trick has a floor. Folding unrelated operations
   behind one schema makes every parameter conditionally required, which models
   handle badly, and the disambiguating prose costs more than the saved
   envelope.

There is deliberately no pinned byte total or ceiling enforcing this any more —
`test/tools.test.ts` tried that, and a hard number that fails the build on
every unrelated prose edit just gets prose trimmed to fit it, which is the
wrong trade every time. What stayed: a test prints the per-tool schema
breakdown on every run, so growth is visible rather than discovered later, and
new prose must still answer "does a model make a worse call without this?"
rather than "is this nice to have?".

See [doc/TOOL-SURFACE-V2](../TOOL-SURFACE-V2/README.md) for the consolidated surface and
why it is still opt-in.

## Drift is detected by content fingerprint, not by the server's etag

**Instead of:** storing the etag ADT returns after a write and comparing it on
undo.

ADT provably does not return the bytes you sent — the server reformats. An etag
comparison would therefore report drift on writes where nothing changed, and the
recorded etag says nothing about content anyone else wrote since.

The journal records a canonical content hash of what the object looked like when
the server left it, re-reads the object at undo time, and compares hashes. A
mismatch refuses the undo and prints both hashes. See [doc/JOURNAL § Drift
detection](../JOURNAL/undo-and-recovery.md#drift-detection).

## Truncation has no off switch

**Instead of:** a `full: true` parameter for callers who want everything.

Every response goes through one builder and one elide function, and there is no
API surface that can suppress the marker. Silent truncation is the failure mode
worth engineering against: a model that receives a truncated class with no
marker will confidently reason about code that is not there. Every truncation is
marked and names the call that fetches the rest.

## FPM configuration is read-only

The classrun-bridge write path was built, found to silently alter a
meaningful share of rows on round-trip with zero errors raised, and
rejected. Full details in [doc/LIMITATIONS §
Editing](../LIMITATIONS/editing.md#fpm--web-dynpro-configuration-is-read-only-deliberately).

## Writes replace whole source

**Instead of:** a patch or string-replacement primitive matching a coding
agent's native edit tool.

ABAP objects are locked, written and activated as units, and a partial write
that fails activation leaves an object in a state no local diff describes.
Whole-source replacement with `expect_etag` gives one comparison point that is
easy to reason about. This is a real ergonomic cost and is listed as a
limitation, not defended as ideal.
