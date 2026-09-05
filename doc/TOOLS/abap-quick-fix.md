# abap_quick_fix

Applies an ADT position-driven quick fix — one of the proposals an ABAP IDE
offers at a cursor position — as a gated, journalled write. `mode=list`
enumerates the proposals available at a line/column; `mode=apply` applies
one of them by its proposal id.

**Availability**: registered only when the server can write (`canWrite`,
i.e. not read-only — see `src/config.ts`'s `StaticCapabilities`), exactly
like `abap_atc`. A statically read-only server (`cfg.readOnly`) does not
have this tool registered at all; see the read-only bullet under
`## Refusals` for how a registered server can still refuse a call at
runtime. Every call, including `mode=list`, is additionally gated as a
`write` operation, so `ABAP_ALLOW_PACKAGES` and `ABAP_ALLOW_NAME_PREFIXES`
apply. This is because the evaluation call behind `mode=list` is a POST
that ships the whole object source to the server — it is not a
general-purpose unguarded read — and the resulting read-only refusal
message is mode-neutral, not specific to enumeration.

| Parameter | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `mode` | `"list"` \| `"apply"` | yes | — | enumerate proposals, or apply one |
| `object` | string | yes | — | object name or ADT URI |
| `type` | string | no | inferred | ADT type hint, e.g. `CLAS/OC` |
| `include` | enum | no | `main` | only the main class include is accepted; any other value is refused `BAD_INPUT` before any network call |
| `line` | integer >= 1 | yes | — | 1-based source line of the cursor position |
| `column` | integer >= 0 | no | `0` | 0-based column (UTF-16 code units) |
| `proposal` | string | for `apply` | — | a proposal `id` returned by `mode=list` |
| `expect_etag` | string | no | — | as `abap_write`: refuse if the object changed underneath |
| `dry_run` | boolean | no | `false` | compute the new source, make no lock/PUT/activation and journal nothing |
| `activate` | boolean | no | `true` | activate after the write |

## Two hops on the wire

Listing and applying both start with the same first hop: a `POST` to
`/sap/bc/adt/quickfixes/evaluation?uri=<sourceUri>#start=<line>,<column>`
with the full object source as the body, which returns the proposals
available at that position. `mode=list` stops there. `mode=apply` sends a
second `POST` to the chosen proposal's own URI, which returns the edit
deltas. The server never writes either hop — applying the delta is
abapsmith's own mutation, so it goes through the same lock -> PUT -> unlock
-> check -> activate pipeline as `abap_write`: journalled, and undoable with
`abap_journal mode=undo`.

## Deterministic proposals only

v1 accepts deterministic proposals only. A parameterized proposal — one the
IDE would open a dialog for — is refused `BAD_INPUT`, naming the required
input by the local name of its `userContent` root element (`generateConstructor`
for both `generate_constructor` and `generate_factory_method`). Parameterized
is decided two ways, pinned by `test/quickfix-wire.test.ts`: a non-empty
`userContent` is the server itself handing over the dialog's pre-filled
input document — a structural signal, not a guess — and fixtures 806/811
show why v1 does not just drop it and proceed anyway: hop 2 with an empty
`userContent` does not fail, it silently returns a valid delta for the
no-attributes answer, which on a class that actually has attributes is a
wrong result, not an error. A small fix-type deny-list (currently just
`rename_quickfix`) catches the opposite gap: fixture 802 shows
`rename_quickfix` ships no `userContent` at all, yet fixture 803 shows its
delta under empty input is an identity no-op — absence of `userContent`
does not by itself mean deterministic.

## Empty delta list is a successful no-op

A proposal offered at hop 1 can legitimately return zero edits at hop 2.
That is not an error; it is applied (or dry-run) as no change to the
source, no write.

## Refusals

- **Non-main include**: any `include` other than `main` is refused
  `BAD_INPUT` before any network call.
- **Parameterized proposal**: refused `BAD_INPUT`, naming the parameter —
  see above.
- **Read-only server**: statically (`cfg.readOnly`), the tool is not
  registered at all. On a registered server, `SafetyGate` can still refuse a
  call `READ_ONLY` at runtime (productive, or unprovable non-productive —
  `src/safety.ts`); `explainReadOnlyRefusal` in `src/tools/quickfix.ts` then
  appends why both modes are gated as a write: `mode="list"` posts the whole
  object source too.
- **Package/name-prefix gate**: `mode=list` and `mode=apply` are both gated
  as `write`, so an object outside `ABAP_ALLOW_PACKAGES` /
  `ABAP_ALLOW_NAME_PREFIXES` is refused before either hop runs.

A successful `apply` response carries the journal entry id and the
`abap_journal mode=undo entry=<id>` sentence, because the write goes
through the shared write core.

## Wire protocol: delta ranges

Deltas use their own range shape, distinct from this project's own
`SourceRange` (`src/adt/source.ts`), which is inclusive-end and whole-line
and is deliberately not used here:

- lines are 1-based, columns 0-based (UTF-16 code units);
- ranges are end-exclusive (half-open);
- a range with no `end` is a pure insertion;
- delta units arrive in no guaranteed order — a proposal has been observed
  returning them in descending position order, so an applier must sort by
  position and apply last-to-first;
- all ranges are relative to the original posted source, not to the result
  of an earlier unit in the same delta;
- content newlines in a delta are LF even when the object's own source is
  CRLF.

`src/adt/range-edit.ts`'s `ColumnRange` is already half-open, so mapping a
delta unit onto it needs no arithmetic.

## Wire protocol: what is grounded and what is not

**Grounded**, from 12 recorded captures in
`test/fixtures/live-captured/80x-qf-*` taken against a sandbox appliance and
replayed in `test/quickfix-wire.test.ts`: both hops' URLs, media types
(`application/*` both ways) and request bodies, the response element
shapes, and every delta-range semantic above.

**Not yet grounded**: the end-to-end apply path against a live system. The
offline end-to-end test runs against an in-process fake ADT server
(`test/helpers/fake-adt.ts`), not a real one. A live apply has not been
verified.

**A dead end worth naming so nobody retries it**: the ATC route. An ATC
finding's own quick-fix token could not be used as an entry key, and the
ATC `autoqf` collection rejected every request shape tried (fixtures 800,
801, 807, 808). The entry point is position-driven, not finding-driven.
