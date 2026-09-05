# Journal format and what gets recorded

There is no git for ABAP. Every mutation abapsmith makes goes through a local,
append-only journal first, so it can be inspected and undone.

> **The journal holds before-images of real ABAP source.** `.abapsmith/` is
> gitignored for exactly that reason. If you relocate it with
> `ABAP_JOURNAL_DIR`, the new path must not be committed, synced, or backed
> up anywhere your ABAP source should not go — it is as sensitive as a
> checkout of the objects it covers.

## On-disk layout

```
<ABAP_JOURNAL_DIR>/<SID>/
  index.jsonl        append-only, one JSON record per line
  blobs/              before/after-image content, byte-exact
  .inflight/           in-flight markers, one file per open entry
```

- Root defaults to `<cwd>/.abapsmith/journal`; `<SID>` is the connected
  system id run through a safe-filename transform (non-alphanumeric → `_`,
  uppercased; `UNKNOWN` if unset).
- `.inflight/` is a **sibling** of `index.jsonl` and `blobs/`, not nested
  inside `blobs/` — a hard invariant: blob files are read indiscriminately
  elsewhere (e.g. scanning for accidentally-captured credentials), so an
  in-flight marker must never be mistaken for content.
- Blobs are written byte-exact UTF-8 — never trimmed, never normalized. That
  is deliberate: it is what undo restores, and the server does not hand back
  the exact bytes it was sent (CRLF folding, trailing-whitespace/newline
  stripping), so the raw blob is the only faithful record of what was there.

Each `index.jsonl` line is either a full `JournalEntry` or a **patch record**
updating an earlier entry by `id`. Writes are journalled in two phases: the
entry is appended before the mutation is attempted, and a patch line —
`{id, outcome, error?, activation?, corrNr?, after?}` — is appended after it
settles (`src/journal.ts:1321-1329`, `settleInner()`). This makes a crashed
write recoverable, but means a consumer must reduce the file by `id`,
applying patches over entries rather than treating every line as complete.
Patch lines are routine, not an edge case — every settled write produces
one; how many are outstanding at any moment depends on how recently
`prune()` last ran, since pruning rewrites the file with patches merged
back into their entries. A patch line carries no `objectName`, `objectType`,
or `timestamp` of its own.

The fields below are for the full-entry line; a patch line carries only the
subset named above.

| Field | Meaning |
|---|---|
| `id`, `ts`, `system`, `systemKey` | Identity and timestamp; `systemKey` (SID+host+client) is the strong identity check, `system` (SID label) the weak fallback for older entries |
| `operation` | `create` \| `update` \| `delete` \| `activate` \| `transport-*` |
| `object` | type, name, uri, package, description |
| `existedBefore` | whether the object existed before this write |
| `beforeCapture` | `captured` \| `confirmed-absent` \| `failed` \| `unknown` — provenance of `existedBefore`, see [Undo semantics](undo-and-recovery.md#undo-semantics) below |
| `beforeKind` | present only when `before` is not the object's own source — `"package-metadata"` for a package (`DEVC/K`) delete. The entry preserves the package's metadata document, and undo will not replay it. |
| `before` / `after` | `{ etag, fingerprint, bytes, blob?, serverEtag? }` — raw etag and canonical fingerprint, both kept, for different jobs (see [Drift detection](undo-and-recovery.md#drift-detection)) |
| `outcome` | `pending` \| `succeeded` \| `failed` |
| `undoOf` / `undoneBy` | links between an entry and the entry that later undid it |
| `irreversible` | set when no mechanism can undo this entry at all, even with `force` |
| `actor` | who made the change — `ABAP_ACTOR` if set, else the MCP client's `clientInfo.name` if the transport handed one over, else **absent**. Never a placeholder: an entry with no known actor simply omits the field, and `abap_journal mode=list` drops the `actor` column entirely on a page where nothing has one. See `ABAP_ACTOR` in [doc/CONFIGURATION § Journal, diagnostics, and tooling](../CONFIGURATION/journal-diagnostics-and-tooling.md). |
| `sessionId` / `sessionIdSource` | which conversation made the change — a different question from `actor`, split into its own field. Set from the MCP transport's own session identity when it supplies one (`sessionIdSource: "transport"`); today the only transport this server constructs is stdio, which supplies none, so in practice this is always a UUID generated once per server process (`sessionIdSource: "process"`) — for stdio, one process is one client connection, so that id genuinely identifies "this conversation". Not a `mode=list` column (a rarely-read opaque id is better as a selector than as width) — filter with `abap_journal mode=list session=<id>`, or `session=current` for this running server's own session. |

## What is journalled

| Journalled | Not journalled |
|---|---|
| `abap_write` (create/update/delete) | FPM tools |
| `abap_transport` (create / add-user / set-owner / release) | `abap_bopf_edit operation:"activate"` (no mutation of the BO's own model — see below) |
| `abap_enh`: 9 of its 11 operations (see below) | `abap_enh`'s `discover_hook_anchors` (read-only) and `exercise` (mutates no ADT object of its own) |
| `abap_activate` and `abap_do action=activate` — single and batch | — |
| BOPF writes (`abap_bopf_edit` create/update, `abap_bopf_delete`) | — |

`abap_write`'s inline activation (the default, unless called with
`activate:false`) is folded into that same create/update entry — it is not a
separate `operation: "activate"` record. Standalone activation, via
`abap_activate` or `abap_do action=activate`, is the table's own last row above.

BOPF tools mutate through ordinary ADT REST verbs: `createBusinessObject`/
`putModel`/`deleteBusinessObject` (`src/adt/bopf.ts`) POST/PUT/DELETE against
`/sap/bc/adt/bopf/businessobjects/{name}` under a lock handle — the same
shape as `abap_write`'s own mutations, so there is a real before/after image
to record. Every BOPF create, model edit, and delete is journalled, with a
before-image captured from the freshest read available at each site: pre-lock
for create (nothing to reread); post-lock, the bytes `putModel`'s `mutate`
callback actually received, for update; the read immediately preceding the
delete's own lock, for delete (see `src/tools/bopf.ts` for per-site
reasoning). `abap_bopf_edit operation:"activate"` on its own writes nothing
to the BO's model (it only calls the activation service), so it stays
unjournalled the same way `abap_write`'s own no-op paths do.

FPM tools write through generated classruns on the server — real mutations,
but not ones abapsmith performed by PUTting source it controls, so there is
no before/after image to record and no undo path.

Activation is recorded as history, never for undo. A batch activation writes
one entry **per object**, not one entry for the call, because
`abap_journal`'s `object=` filter matches an entry's own object and would
otherwise answer "what happened to this object?" with silence for every
member of the batch but one. Every activation entry carries
`irreversible: true`: ADT has no deactivate operation, so undo refuses it
(see [Undo semantics](undo-and-recovery.md#undo-semantics)), and the flag says so wherever entries are displayed
rather than only where undo is attempted.

`abap_enh` journals 9 of its 11 operations — every one that creates or
mutates a real `ENHO/XH`/`ENHO/XHH`/`ENHS/XS` object: `write_description`,
`set_impl_active`, `delete` (which never route through the classrun bridge),
plus `create_spot`, `add_badi_def`, `add_filter_def`, `create_impl`,
`set_filter_values`, and `create_hook` (which do). The remaining two are
legitimately unjournalled, not gaps: `discover_hook_anchors` is read-only —
nothing to record; `exercise` runs an existing BAdI's method for
diagnostic/testing purposes and mutates no ADT object of its own — the same
footing as `abap_run`, never journalled either.

`set_filter_values` is the one `abap_enh` operation that writes **two**
entries — the "one entry per object" rule above applied to a single POST
rather than to a batch. Changing a BAdI filter is not finished when the
implementation is saved: it needs a second, *joint* re-activation of the
spot **and** the implementation together (`activateSpotAndImplementation` in
`src/adt/enhancement-bridge.ts`, one POST to `/sap/bc/adt/activation`
carrying both object references — the "H23" step). That POST changes which
code the system executes for two objects, so it gets an `update` entry for
the implementation (carrying the usual inline `activation:` outcome) and a
separate `operation: "activate"` entry naming the **spot** (`ENHS/XS`), both
`irreversible: true`. Without the second entry, `abap_journal object=<spot>`
answered "what happened to this spot?" with silence even though abapsmith
had just re-activated it — the exact failure the batch-activation rule above
exists to prevent.

This is a deliberate, narrow exception to the "inline activation is folded
into the create/update entry" convention above: it holds when the activation acts on *the same object* the entry already
names; here the joint POST reaches a **second** object that no other entry
names, so folding it in would lose it. `src/adt/` does not journal
(`src/adt/undo.ts`, the revert engine, is the single deliberate exception):
the bridge takes a REQUIRED `onBeforeActivation` hook fired immediately
before the POST, and `src/tools/enh.ts` supplies it from inside
`withJournalledMutation`, so the entry is on disk before the wire call
happens and a hook that throws aborts the activation unrecorded and
therefore unperformed.

For how these entries are undone, see [Undo, drift detection, and
recovery](undo-and-recovery.md).
