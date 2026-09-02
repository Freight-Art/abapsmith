# BOPF fixtures

**Live-captured from the A4H appliance during the 2026-08-04 BOPF CRUD probe
session**, committed in `e4aeb44` (the whole directory has not been touched
since: `git log --oneline -- test/fixtures/bopf/` shows a single commit,
`e4aeb44`, for the entire set). Six of the seven bodies are
byte-for-byte as received: single line, no trailing newline, nothing
reformatted or reordered. `05-request-create-payload.v4.xml` is the one
exception: it is 5 lines and ends in a trailing newline. That shape has been
left as captured, like the rest.

The 2026-08-04 date is derived from the fixtures' own `adtcore:createdAt` /
`adtcore:changedAt` attributes, which range from `13:00:58Z` (`02`'s
`createdAt`) to `13:42:26Z` (`10`'s `changedAt`) on that date. Two files don't
carry that evidence directly: `01` is a `GET` of the SAP-shipped
`/BOBF/DEMO_SALES_ORDER`, so its own `createdAt`/`changedAt` (2008/2010)
record when SAP created/changed *that object*, not when this repo captured
the response; `05` is a create request, captured before `ZBOPF_PRB1` existed,
so it carries no `createdAt`/`changedAt` at all. Both are dated by their
membership in this single-commit capture set.

| file | source | what it proves |
| --- | --- | --- |
| `01-get-demo_sales_order.v4.xml` | `GET` of SAP-shipped `/BOBF/DEMO_SALES_ORDER` | A real, fully-built SAP BO model, for coverage/shape comparison against the hand-built `ZBOPF_PRB1` fixtures below. |
| `02-created-zbopf_prb1-root-only.v4.xml` | response right after `create_bo` | `ZBOPF_PRB1`, `$TMP`, `version="inactive"`, root node only. No `persistentStructureRef` on `ROOT` yet. |
| `03-after-put-item-node-and-assoc.v4.xml` | response after the PUT that added the `ITEM` node and its association | `ZBOPF_PRB1`, `version="inactive"`, `ROOT` + `ITEM`. See **Resolved: `03`'s `ITEM` ref slots** below — this file predates `add_node` and does not represent its current behaviour. |
| `04-active-after-structures.v4.xml` | response after activation, once DDIC structures were authored | `ZBOPF_PRB1`, active, `ROOT` + `ITEM`, both nodes carrying `persistentStructureRef`/`combinedStructureRef`/`combinedTableRef`/`persistentTableRef`. |
| `05-request-create-payload.v4.xml` | **captured request body**, not a response | The POST that produced `02`. |
| `06-request-put-payload.v4.xml` | **captured request body**, not a response | The PUT that produced `04` — its own `adtcore:changedAt` (`13:02:07Z`) matches `03`'s, i.e. it was built from the `03` state and adds refs to both `ROOT` and `ITEM`. |
| `10-model-coverage-final.v4.xml` | response, same session | The broadest-coverage `ZBOPF_PRB1` model captured, latest timestamp of the set (`13:41:38Z`/`13:42:26Z`). |

## Resolved: `03`'s `ITEM` ref slots — 2026-08-30

**Settled by a live run against the appliance on 2026-08-30: `add_node`
assigns no DDIC ref slots to a child node, ever. `03`'s three ref slots came
from its own PUT payload, not from server-side auto-assignment. The live
capture reflects current behaviour; `03` does not — it predates `add_node`
and cannot be read as evidence about it.**

The live run created a throwaway BO in `$TMP`, renamed its root node to
`ROOT`, and added a child node `PRB417` via `add_node` supplying **no ref
keys at all** in the spec. The raw v4 XML was read back twice: once right
after the bare `add_node`, and once after an explicit follow-on attempt to
add the ROOT->child Composition association. The two read-backs were
**byte-identical**, 5714 characters each. In that document, the `PRB417`
node element's first child is `<bo:properties>` — there is no
`combinedStructureRef`, `combinedTableRef`, `persistentTableRef`, or
`persistentStructureRef` on it. The elements are absent, not empty:

```
<bo:nodes bo:name="PRB417" bo:nodeID="..." bo:parent="#//bo:businessObject/bo:nodes[@bo:name='ROOT']" ... bo:rootNode="false"><bo:properties bo:name="KEY" ...
```

The **root** node in that same document did carry all three ref slots
(`ZTMD_S_ROOT2`, `ZTMD_T_ROOT2`, `ZTMD_D_ROOT2`), so BOPF's auto-assignment
is real — it is root-only, never child. Activation of `PRB417` corroborated
this independently, producing exactly the three severity-E messages already
described above for a child missing all four slots ("Database table is
missing", "Combined table type is missing", "Combined structure is
missing").

This confirms the "leading explanation" this section used to describe as
unconfirmed: the PUT that produced `03` supplied the refs itself, rather
than relying on server-side defaulting for a child node — because a child
never gets server-side defaulting. `03` and the live-run
captures were never comparable, and neither was wrong; they capture
different inputs (`03`'s PUT sent refs, the live `add_node` calls didn't).

**Unexpected second finding, also settled by this run:** the confound this
section used to flag — that `03`'s PUT added the `ITEM` node *and* the
ROOT->ITEM composition association in one call, so a bare `add_node`
couldn't be compared cleanly against it — turned out not to exist, but not
for the reason expected. A bare `add_node`, with no association requested,
**already causes BOPF to auto-create three associations on its own**: the
ROOT->child Composition (`<bo:associations bo:name="PRB417"
bo:implementationType="Composition" ...>`), plus `TO_PARENT` and `TO_ROOT`
on the child. All three were present at the very first read-back, before
the explicit add-Composition follow-on call was even made. This is not
documented anywhere else in this repo and matters to anything reasoning
about the model shape produced by a bare `add_node`. (The follow-on explicit
`add_association` call in this same run reported success while changing
nothing — a distinct defect, reported separately; not fixed here.)

Fixture `03` has **not** been re-captured or edited: fixture
provenance in this repo is recorded rather than discarded. Only
`test/bopf-node-ddic-guidance.test.ts` (asserting on `persistentTableRef
ZBOPF_D_ITEM` on `03`'s `ITEM` node) uses those disputed-turned-resolved
refs, and it uses `03` only as a fixed captured shape to feed through a
mock PUT response, not as evidence about `add_node`'s behaviour — so no
test change follows from this finding.

<details>
<summary>Original investigation (kept for provenance)</summary>

`03`'s `ITEM` child node carries three generated ref slots:
`bo:combinedStructureRef ZBOPF_S_ITEM`, `bo:combinedTableRef ZBOPF_T_ITEM`,
`bo:persistentTableRef ZBOPF_D_ITEM`. A live capture taken during an earlier probe
run, on the same appliance, of an `add_node` operation showed the
`add_node`'d children carrying **none** of the four ref slots — absent, not
empty. Both captures are `adtcore:version="inactive"`. Both are real captures
of something. Neither has been discarded.

`03` was not produced by `add_node` at all, because `add_node` did not exist
yet. `test/fixtures/bopf/` was committed in a single commit, `e4aeb44`; that
commit's parent, `9876488`, has no BOPF code under `src/` whatsoever — no
`src/tools/bopf.ts`, no `add_node`, nothing (`git ls-tree -r --name-only
9876488 -- src/tools/` and `git grep -i bopf 9876488 -- src/` both come back
empty). The fixtures were produced by standalone probe scripts under
`docs/probes/bopf/`, which have since been deleted from master and survive
only in git history; those scripts spoke ADT REST directly, not through this
repo's `add_node`. So `03` and any `add_node` capture are captures of two
different things, and `03` cannot be evidence about `add_node`'s behaviour
either way.

What has been ruled out: the client does not invent these refs.
`buildNodeFields` (`src/tools/bopf.ts:900`) sets each of `persistentStructureRef`
/ `transientStructureRef` / `combinedStructureRef` / `combinedTableRef` /
`persistentTableRef` only from `ref(spec.<kind>)`, and `ref()`
(`src/tools/bopf.ts:530`) returns `undefined` unless the caller's `spec`
supplied both `name` and `type`; `renderNodeElement`
(`src/adt/bopf-xml.ts:871`) emits each element only when the field is
present. A bare `add_node` (no ref fields in `spec`) therefore PUTs zero ref
children — and this logic is unchanged since `03` was captured: `git log`
on `test/fixtures/bopf/03-after-put-item-node-and-assoc.v4.xml` shows one
commit, `e4aeb44`; `git log -L` on `renderNodeElement` and on
`buildNodeFields` (range `e4aeb44..7ebd87d`) shows the only other touch is
`8aff07f` (2026-08-28), which changes only parent-link/`rootNode` handling —
every `*Ref: ref(spec.*)` line is unchanged context in that diff. So
"abapsmith's PUT payload changed since capture" is ruled out as the cause of
this discrepancy. What is NOT ruled out is whether the PUT that produced
`03` was itself bare — see below.

The leading explanation is not on the appliance side at all: the PUT that
produced `03` likely sent a `spec` with the refs already filled in, rather
than a bare `add_node`-equivalent call — in which case `03` and the earlier
live capture were never comparable, and neither is wrong. `test/fixtures/bopf/`
itself holds captured request bodies for only two of the PUTs (`05`, which
produced `02`; `06`, which produced `04`) — there is no captured request body
for the PUT that produced `03` in the current fixture set. But two now-deleted
files, recoverable from git history rather than the working tree, are partial
records of what that PUT sent, and they **contradict each other**.
`docs/BOPF-LIVE-RECON.md` (at commit `9876488`) documents the Step-4 mutation
as a bare self-closing `<bo:nodes bo:name="ITEM" ... />` element with no ref
children — which would mean the server assigned the three refs itself.
`docs/probes/bopf/build_bo.mjs` (same commit) instead explicitly sends
`combinedStructureRef`, `combinedTableRef` and `persistentTableRef` on the
ITEM node it builds. The repo's own surviving records do not agree, so
neither can be treated as settling the question.

Neither deleted file is a reliable record of the specific PUT that produced
`03`, for two independent reasons. `build_bo.mjs` derives its DDIC name stem
from a truncated form of the BO name (`"Z"+NAME.replace(/^Z/,"").slice(0,8)`),
which for `ZBOPF_PRB1` would emit `ZBOPF_PRB_S_ITEM` — but `03` actually
contains `ZBOPF_S_ITEM`, not that. And `build_bo.mjs`'s own sequence is
create → PUT → activate → read — a single read, taken after activation — so
its captured final read corresponds to `04`, not `03`.

A confound the discussion above doesn't yet account for: `03`'s PUT added the
`ITEM` node *and* the ROOT->ITEM composition association in one call, whereas
`add_node` adds only a node, no association. So even a bare, ref-free
`add_node` call isn't quite the same operation as the PUT that produced `03`,
and a live comparison should isolate the two effects rather than conflate
them.

This is the confound the 2026-08-30 live run (see the resolved finding
above) set out to isolate with a second read-back after an explicit
add-Composition call — and, unexpectedly, found didn't need isolating: a
bare `add_node` already creates that association on its own. See above for
the resolution.

</details>

## Not covered by `check:cassettes`

`npm run check:cassettes` is scoped to `test/cassettes/**/*.cassette.json`
only (see `package.json` and `test/cassettes/cassette-lint.test.ts`). It does
not see this directory, so nothing here applies a staleness window or a byte
check to these fixtures.
