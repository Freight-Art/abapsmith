# CDS lineage

- **ADT's own dependency-graph endpoint exists, nests transitively, and is
  still not used as the lineage source.** `GET
  /sap/bc/adt/ddic/ddl/dependencies/graphdata?ddlsourceName=` answers 200 for
  a standard view with a real nested tree — one `abapsource:elementInfo`
  node per data source, `TYPE` (`CDS_VIEW`/`CDS_VIEW_ENTITY`/`TABLE`/
  `SELECT`/`UNION`), `RELATION` (`FROM`/`INNER_JOIN`/`LEFT_OUTER_JOIN`/
  `UNION`/`SELECT`), `ENTITY_NAME`, `NODE_NAME`, `DB_EXISTS` — captured live
  against `ARS_V_FLP_SWC_VH` (capture 981, A4H, 2026-09-15). But the tree it
  returns carries no association edges and no field-level lineage: nothing
  in it says which field an output column came from, or which associations
  a view exposes. Lineage in this tool needs both, so `graphdata` cannot be
  the sole source regardless of the next finding.
  The same endpoint refused every customer view tried:
  `ZDEMO_C_SALESORDER_TP_D` answered HTTP 400
  `NoDependencyGraphDataCalculationPossible` (capture 982, same session).
  What separates a view `graphdata` accepts from one it refuses was **not
  established** — only that A4H accepted a standard SAP view and rejected
  the one customer view actually tried. `cds-lineage.ts` therefore reads and
  parses DDL source directly for every node, standard or customer, rather
  than branching on object origin.

- **`/sap/bc/adt/ddic/ddl/elementmappings` was probed as a field-lineage
  source and rejected — this finding has no retained fixture.** During
  implementation, four parameter spellings against this endpoint were tried
  by hand against a live A4H session; all four came back HTTP 400, and the
  response body in every case was the same static field/annotation
  catalogue for the view's own editor metadata, not a per-view source-column
  mapping. No capture number backs this: the probe session's responses were
  not saved to `test/fixtures/live-captured/`, and nothing in this
  repository's source, tests, or fixtures references `elementmappings`
  today (confirmed by a repository-wide search — zero matches). Treat this
  as an honest implementation-time finding, not a live-verified,
  reproducible claim: the endpoint's shape and its rejection are believed
  true from that session, but nobody can replay the bytes.

- **Lineage is a source-text parse, one `readSource` per CDS node, with the
  consequences that implies.** `buildLineage` (`src/adt/cds-lineage.ts`)
  walks data sources and associations by reading and parsing each CDS
  view's own DDL text (`parseDdl`) — there is no compiled dependency index
  behind it. Concretely:
  - A node whose source cannot be read (deleted, no authorization, a
    transient failure) becomes a leaf marked `not found: <error>` — the
    walk does not fail, it stops at that one branch.
  - `parseDdl` is a line-local heuristic, not a tokenizer or a CDS grammar
    parser: it recognises `define view`/`view entity`/`root view
    entity`/`transient view entity`/`table function`/`abstract
    entity`/`custom entity`/`extend view`, `from`/`join`/`union` data
    sources, `association … to … on …` blocks, and top-level field
    references, all by pattern-matching source lines. It does not track
    nested parentheses, multi-statement continuations beyond what its
    patterns expect, or comment syntax beyond what `parseDdl`'s own header
    comment documents. A view written in a shape the patterns don't cover
    degrades to `kind: "unknown"` rather than throwing — which itself
    becomes a non-recursing leaf.
  - `table function`, `abstract entity`, `custom entity`, `extend view`,
    and `unknown` are all treated as leaves: the walk does not follow their
    own data sources, even when the underlying object has some. A
    parameterised view (`with parameters`) is also a leaf for the same
    reason — lineage does not resolve parameter bindings, so decomposing
    further would be guessing.
  - A non-CDS target (anything not `DDLS/DF`) becomes an instant "table"
    leaf without reading anything — the object type alone is enough to know
    the walk stops there. A CDS-type target, even one that will turn out to
    be a depth-limited leaf, still requires a full `readSource` + `parseDdl`
    first, because the node's `kind` (needed to render it, and to decide
    whether it's a non-recursing kind) isn't known until the source is
    parsed.

- **An association counts as "selected" on any textual mention in the field
  list, including inside an expression — not only when used as a bare
  top-level field.** `parseDdl`'s `selected` flag is a regex word-boundary
  test against the *entire* field-list body text, not a structural check for
  "is this association projected as one of the view's own fields." Fixture
  980 (`ARS_V_FLP_SWC_VH`) demonstrates the distinction directly: it
  declares two associations, `_session_language` and `_english`, both
  target `cvers_ref`, and both are referenced only inside a `coalesce(...)`
  call in a computed field's expression — neither is ever exposed as a bare
  top-level field. Running `parseDdl` against the real fixture text still
  reports `"selected": true` for both, because the word-boundary test finds
  `_session_language` and `_english` inside the `coalesce(...)` text.
  Whatever a view's original design intent was, this tool's lineage walk
  follows any association whose name appears anywhere in the field list
  body — a coarser rule than "used as a projected field," and the reason a
  `(not selected)` marker in a rendered lineage tree means "the name never
  appears in the field list at all," not "never returned to a consumer."

- **The two associations above also illustrate the "diamond vs. cycle"
  ambiguity documented in `buildLineage`'s own code comment.** Both
  `_session_language` and `_english` point at the same target,
  `cvers_ref`. `buildLineage` tracks visited names in one global set for
  the whole walk, not per branch, so the second arrival at `cvers_ref`
  renders as `(cycle -> seen above)` regardless of whether it is a true
  cycle (the same node reachable from itself) or a legitimate diamond (two
  different associations that happen to name the same target). This tool
  does not distinguish the two cases — a rendered "cycle" marker on a
  fan-in node is not proof of a real cyclical CDS reference.

- **Table functions, parameterised views, custom entities, and metadata
  extensions were never exercised by a captured fixture.** No capture in
  this issue's set uses `with parameters` or `extend view`, so their
  leaf-stopping behaviour above is implemented from `parseDdl`'s own
  pattern rules and unit tests, not confirmed against a live view of either
  shape.
