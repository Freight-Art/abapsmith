# API surface and data integrity

Why some decisions look odd from the outside. Each entry states the rejected
alternative and what decided it. See also [Safety and concurrency
design](safety-and-concurrency.md) for the session- and auth-level notes.

## Installed objects live in a local package, not a transport

**Instead of:** shipping a `Z` ICF service or transportable ABAP-side helper
package that the server calls — or leaving every object type ADT can't reach
permanently unreachable.

abapsmith installs persistent, versioned ABAP classes — the fluid API's static
body classes (see `doc/TOOLS/abap-fluid.md`; `abap_fluid op=list` enumerates
every one currently loaded) plus a per-call invoker class for each distinct
call — in the local package `$ABAPSMITH_FLUID_API`, created on first use of a
function that needs one (`src/adt/fluid/package.ts:14`, `:57-70`;
`src/adt/fluid/dispatch.ts:302-322`). The package is non-transportable
(`softwareComponent: "LOCAL"`) and sits under superpackage `$TMP`.

The boundary moved rather than disappeared: instead of a shipped, transportable
package on one side or an unreachable capability on the other, there is now a
small, named, versioned, removable set of local objects. No transport is
created or required — the package can't hold one. No ICF service is registered,
no RFC destination created, no background job scheduled. Only objects under
abapsmith's own reserved name prefixes (`ZCL_ZMCP_`, `ZIF_ZMCP_`,
`src/adt/fluid/package.ts:23`) are ever written, and only inside a `$`-prefixed
local package, which the existing safety gate already governs by its own name-
and package-allowlist rules. The cost is honest: an installation step, a
version-skew surface between the Node and ABAP sides that the contract version
and the manifest version check exist to catch, and objects that accumulate —
invoker classes are never deleted automatically.

Two levers bound it. `ABAP_FLUID_API=false` (default is on) stops any generated
bridge from deploying or running in `$ABAPSMITH_FLUID_API` — and with it the
package's own first-use creation — refused as `FLUID_API_DISABLED` at the
shared `deployBridge`/`dispatch` chokepoint (`src/adt/run.ts:1088-1101`,
`src/adt/fluid/dispatch.ts:227-228`); plain writes gated by
`canWrite`/`!cfg.readOnly` still go through. `abap_fluid(op="remove")` deletes
what's already there, but only the objects — it never deletes the
`$ABAPSMITH_FLUID_API` package itself (`src/tools/fluid.ts:804-807`):
abapsmith's own package-delete route has to deploy a helper class into a
package before it can delete it, and the generated ABAP refuses to delete a
non-empty package, so deleting this package from inside itself can't work — the
operator drops the empty package by hand. Same for `$ZMCP_HELPERS`, the other
package abapsmith created — no code path deletes it either. `$TMP` is
different: SAP's own standard local package, not abapsmith's; only the leftover
`ZCL_ZMCP_*` objects inside it are abapsmith's concern. See
`doc/FLUID-API/README.md` and `doc/TOOLS/abap-fluid.md` for what gets installed
and how removal is scoped.

Where ADT's REST surface has no endpoint, abapsmith runs its own ABAP in
`$ABAPSMITH_FLUID_API` and reads the framed output, in one of two shapes. FPM
configuration reads, `abap_ui` screen discovery, IMG customizing writes and the
enhancement create family dispatch against a **static body class** reused
across calls, rewritten only when its content changes, reached through an
invoker class named by a hash of `{tool, action, args, contract}`
(`src/adt/fluid/invoke.ts:51-54`) — invokers are content-addressed and
accumulate, one per distinct argument shape. Report execution, BOPF runtime,
`abap_ui press`, `abap_enh exercise` and `abap_fpm_read mode:"locks"` still
generate a **per-call classrun bridge** (`IF_OO_ADT_CLASSRUN`) named from what
they run, so identical calls reuse a class and distinct ones add another.
Either way the generated object is an ordinary one in the namespace and package
the safety gate already governs, so it inherits every existing control instead
of needing new ones; `abap_fluid(op="status")` lists both kinds. Nothing is a
throwaway `$TMP` classrun torn down after the call any more.

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

A consolidated, six-tool alternative surface built on this same schema-size
argument was tried as an opt-in and later removed; see [Why the v2 tool
surface was removed](tool-surface-v2.md) for what it measured and why the
schema saving was not enough on its own.

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
