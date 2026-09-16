---
name: abapsmith-create-ddic-objects
description: Creates domains, data elements, table types, tables, structures, message classes, lock objects, and search helps in the right order with the right payload shape. Use for any DDIC dictionary object.
---

# DDIC objects

Two payload shapes, and DDIC is where they diverge hardest.

| Shape | Types | Body |
|---|---|---|
| `source` | `TABL/DT` `TABL/DS` | DDL text |
| `properties` | `DOMA/DD` `DTEL/DE` `TTYP/DA` `MSAG/N` `ENQU/DL` | complete XML descriptor |

`ENQU/DL` create: name must start with `EZ`/`EY`; the XML root is the
lowercase `<enqu:lockobject>` element in namespace
`http://www.sap.com/adt/ddic/enqu`, with minimal content
`primaryTable/{tableName, lockMode}`.

**`SHLP/DH` (search help) is a third, unrelated shape** — not `source`, not
`properties`. There is no ADT-writable collection for a search help at all
(every mutating REST verb 404s, the same gap `VIEW/DV` and `TRAN/T` have),
so `abap_write` reaches it through the classic fluid bridge instead of a
PUT: pass a structured `shlp` object (never `source`), see "`SHLP/DH`
(search help)" below and `doc/TOOLS/write-and-activate.md`.

## Order matters

Build bottom-up and **activate each level before referencing it**:

```
domain → data element → structure/table → table type
```

A PUT accepts a reference to an inactive or nonexistent object without complaint.
It fails at **activation**, with a message naming the referenced object, not
yours. **PUT silent, activate loud.**

## properties-shape: `ddic` fields, or read then imitate

`abap_write`'s `ddic` field builds the descriptor for you, for `DOMA/DD`,
`DTEL/DE`, `TTYP/DA` only — pass typed fields (`dataType`, `length`,
`typeKind`, `typeName`, the DTEL label fields, …) instead of `source`, never
both (an empty `source: ""` next to `ddic` is treated as absent). Which
fields apply where: `dataType`/`length`/`decimals` apply to all three;
`typeKind`/`typeName` are `DTEL/TTYP` only; `shortLabel`/`mediumLabel`/
`longLabel`/`headingLabel` (and their `…Length` counterparts) are `DTEL`
only; `outputLength`/`lowercase`/`signExists`/`fixedValues`/`valueTable` are
`DOMA` only. Any other field name is refused by the schema itself.

Live-verified on A4H (NetWeaver 7.54) on 2026-09-16 — objects created through
`ddic`, activated, read back with every value intact, deleted: a `DTEL/DE`
with all four labels (`ZAS_DTEL_LBL`), a `CHAR 1` domain with three fixed
values (`ZAS_DOMA_ST`), a `DEC 13,3` signed amount domain (`ZAS_DOMA_AMT`).
The builder puts `adtcore:masterLanguage="EN"` on the root itself, so the
label / fixed-value-text discard described under "Per-type traps" cannot
happen through `ddic`. Still refused, because never proven in a PUT body:
`primaryKey`, `initialRowCount`, a settable `rangeType`, `typeKind:
"rangeTypeOnDataelement"` — drop to `source` for those. `ddic: {}` alone
reproduces the grounded body's defaults.

`DOMA/DD` specifics: `fixedValues: [{low, high?, text}]` renders the
`<doma:fixValues>` block in the order given (`low`/`high` at most 10
characters — `DD07L-DOMVALUE_L` — and within the domain length; `text` at most
60; the server numbers the rows). `valueTable: "SCARR"` renders the
`<doma:valueTableRef>` triple; the server checks the table exists at
activation. `outputLength` defaults to the Dictionary's own proposal — `DEC`/
`CURR`/`QUAN`: `length` + 1 if `decimals` > 0 + 1 if `signExists`; `DATS` 10;
`TIMS` 8; everything else `length` — and a caller's value wins. `DTEL/DE`
specifics: labels over 10/20/40/55 characters are refused before sending
(never truncated); `*Length` defaults to that maximum and must be at least the
label's own length.

For anything `ddic` doesn't cover, there is no helper that builds the XML
from a field list — compose the whole descriptor:

1. `abap_read { object: <SAP-delivered example>, type, format: "raw" }`
   — examples: domain `XFELD`, data element `MANDT`, table type `STRING_TABLE`,
   lock object `E_ADRCITY`, message class `SY`.
2. Copy its root element, namespace, and attribute set. Substitute your name,
   package, content.
3. `abap_write { object, type, source: <the XML> }`.

**Root element and namespace** — guessing these wrong was the single largest
cost in a live sweep:

| type | root element | root namespace |
|---|---|---|
| `DOMA/DD` | `doma:domain` | `http://www.sap.com/dictionary/domain` |
| `DTEL/DE` | `blue:wbobj` | `http://www.sap.com/wbobj/dictionary/dtel` |
| `TTYP/DA` | `ttyp:tableType` | `http://www.sap.com/dictionary/tabletype` |

Wrong guesses observed live for `TTYP/DA`: namespace
`http://www.sap.com/adt/dictionary/tabletypes`, namespace
`http://www.sap.com/wbobj/dictionary/ttyp`, and root local name
`ttyp:tabletype` (lowercase `t`).

**A write replaces the whole document.** Omit an element and you delete it. Never
send a partial descriptor. `format: true` is refused for these types.

`format: "raw"` offsets address **characters**, not lines — these documents are one
unbroken line. Large classes (`SY` ≈ 320K chars) page; the response gives the next
offset.

## Per-type traps

**`DOMA/DD`** — Fixed values live in
`<doma:valueInformation><doma:fixValues>`, each a `<doma:fixValue>` with
`<doma:low>`, `<doma:high/>` and `<doma:text>`. Keep that child order.
`<doma:position>` is optional — omit it and the server numbers them. An empty
`<doma:low/>` is a legal key, not junk to clean up.

**Always include `<doma:fixValues/>`, even when the domain has none.** A
`<doma:valueInformation>` that omits it is rejected at PUT, naming the missing
`fixValues` element and its position in the document; it belongs last inside
`<doma:valueInformation>`, after `<doma:valueTableRef>` / `<doma:appendExists>` if
present. `abap_write` now injects the empty element when it's missing, so
the failure is no longer reachable through abapsmith — but a hand-composed payload
should still carry it, since the read-then-imitate examples do.

**Fixed-value texts need `adtcore:masterLanguage` on the root element.** Omit it
and every `<doma:text>` is silently discarded — the write still reports
`activated: true`, no message, no error, and the read-back shows `<doma:text/>`.
The codes survive; only the descriptions vanish.

```
<doma:domain … adtcore:masterLanguage="EN" adtcore:name="ZDOM_X" …>
```

There's no response signal for this one — in `speculative` mode, trust a clean
write once `masterLanguage` is on the root rather than spending a read-back to
chase it; in `verified` mode, or if you have a specific reason to doubt it,
`abap_read` and check `<doma:text>`. Either way, an empty `<doma:text>` means
**add `masterLanguage` and re-write** — the same payload then persists the
text, and this repairs an already-written domain.

Do not conclude the server drops fixed-value text. It does not. `abap_read` may
attach a note saying the text "has been observed to fail to persist on some
systems" — that note is symptom-only and fires on exactly this missing-attribute
case. Treat it as a prompt to check `masterLanguage`, not as a diagnosis.

**`<doma:signExists>` must come before `<doma:lowercase>`** inside
`<doma:outputInformation>` (the order every live GET and the skeleton below
carry: `length`, `style`, `conversionExit`, `signExists`, `lowercase`,
`ampmFormat`). Sent the other way round, a `DEC 13,3` domain with
`signExists=true` activated on A4H with `signExists` stored `false` — no
message, no error (live, 2026-09-16). `abap_write`'s read-back guard now
reports a flag sent `true` and stored `false` as `CHECK_FAILED` /
`VALUE_DISCARDED`; `ddic` emits the right order.

The output length is not free-form: for `DEC`/`CURR`/`QUAN` it is `length`
plus one for the decimal separator when `decimals` > 0 plus one for the sign
when `signExists`; `DATS` is 10 and `TIMS` is 8. A `DEC 13,3` signed domain
with `<doma:outputInformation><doma:length>000015</doma:length>` activated
clean; `ddic` computes this unless `outputLength` is given.

**`DTEL/DE`** — References a domain. Create *and activate* the domain first.

The root is `<blue:wbobj>` in `http://www.sap.com/wbobj/dictionary/dtel`, but
the inner `<dtel:dataElement>` must declare its own, different namespace:
`xmlns:dtel="http://www.sap.com/adt/dictionary/dataelements"`. Reusing the
root's namespace on the inner element does not fail — the write returns
`ok: true`, `created: true`, `activated: true`, every success signal — and
produces a data element with no type at all (`type: abap.(0); built-in: length
0` on read-back) instead of the domain reference. Live-observed, cost 3 calls
plus an unrelated wrong diagnosis before it was spotted. `abap_write` now
refuses this before sending when it can resolve the inner element's namespace
and finds it wrong, staying silent rather than guessing when it
can't — so a hand-composed payload should still carry the correct inner
namespace.

`<dtel:searchHelp/>`, `<dtel:searchHelpParameter/>`, `<dtel:setGetParameter/>`
and `<dtel:defaultComponentName/>` are required as empty elements even when
unused — omitting them is rejected naming `searchHelp`. This alone accounted
for 7 rejections in the sweep.

`shortFieldLabel` is capped at 10 characters. Over-length is rejected with an
opaque simple-transformation deserialization error naming `SBD_DATAELEMENT`,
not a length complaint. `<dtel:*FieldLength>` is a two-digit display width
(`05`, `03`), not the label's character count: live, `MANDT` reads back
`shortFieldLength` 10 for the 7-character "Mandant" and `headingFieldLength`
03 for "Mdt". Keep it at least the label's length and at most the slot's
`*FieldMaxLength` (10/20/40/55); the server has not been observed enforcing
either.

**Field labels need `adtcore:masterLanguage` on the root element**, exactly as
fixed-value texts do on a domain. Without it the PUT is accepted, all four
`<dtel:*FieldLabel>` elements are stored empty, and the object stays
inactive — `abap_write`'s pre-activation read-back reports it as
`CHECK_FAILED` / `VALUE_DISCARDED` naming the four label elements, and the
hint says to add the attribute and send the same document again (live,
`ZAS_DTEL_TEST` on A4H, 2026-09-16: the byte-identical body with
`adtcore:masterLanguage="EN"` activated with every label intact). The
skeleton below carries it.

**`TTYP/DA`** — `<ttyp:rowType>` children are **order-sensitive**: `typeKind`,
`typeName`, `builtInType` (`dataType`, `length`, `decimals`), `rangeType`. Wrong
order = hard 400. Row-type existence is checked only at activation
(*"Row type X is not active or does not exist"* → fix the row type, not your XML).

A rejection names only the *next* missing element, so adding one element per
retry is a loop — one live object took 7 rejections that way (an initial
root-element rejection on `tableType`, then missing-child rejections for
`typeKind`, `builtInType`, `dataType`, `length`, `decimals`, `rangeType`, in
that order) before the 8th write succeeded. Start from the skeleton below
instead — `abap_write` now returns the skeleton with the rejection.

**`TABL/DT` / `TABL/DS`** — DDL grammar `define table zname { … }` /
`define structure zname { … }`, not SE11 field lists. Embed with `include <name>;`,
not `.INCLUDE TYPE`. `@AbapCatalog.enhancementCategory` is **mandatory** — omitting
it is rejected at PUT. Structures carry no `key` / `not null`.

**`MSAG/N`** — Never activates; it is active from creation. Validation is eager at
PUT (bad number, short text over 73 chars → 400). Element is `<mc:messages>`
plural even for one message. Do not send `mc:documented` — server-computed.
**Long text lives at a separate sub-resource** and is not written by the
class-level PUT — the PUT will not warn you. Do not promise it round-trips.

**`ENQU/DL`** — Names must start with `EZ`/`EY`, not `Z`/`Y`. The XML root must be
the lowercase `<enqu:lockobject>` element in namespace
`http://www.sap.com/adt/ddic/enqu` — the camelCase `<enqu:lockObject>` in
`http://www.sap.com/dictionary/lockobject` some older callers send is refused.
`enqu:content` children are order-sensitive (`allowRFC?`, `primaryTable`
(`tableName`, `lockMode`), `secondaryTables?`, `lockParameters?`,
`lockModules?`); omitting `lockMode` 400s. Lock parameters must be key fields
of the primary/secondary table — a non-key field passes PUT and fails
activation. Lock mode `O` is illegal on this system; `X` is verified. The
server auto-injects an implied key-field lock parameter on read-back — that extra
parameter is normal, not corruption.

**`MSAG/N` and `ENQU/DL` cannot be read in default mode** — `abap_read` throws
`UNSUPPORTED`. Use `format: "raw"`; a raw read of an existing lock object such
as `E_TABLE` shows the canonical shape.

## `SHLP/DH` (search help)

Not `source`, not `properties`. There is no ADT REST collection for a search
help at all — every mutating verb 404s — so `abap_write` builds it through
the classic fluid bridge (`RS_CORR_INSERT` → `DDIF_SHLP_PUT` →
`DDIF_SHLP_ACTIVATE`) from a structured `shlp` field, never `source` and
never `ddic`:

- `selectionMethod` — the table or view the help selects from. Optional:
  omit it (or pass `""`) for a collective search help, or for an elementary
  one driven by a search-help exit instead of a table/view — both are
  normal; several standard SAP elementary helps (e.g. `/UI2/GROUPS_SH`)
  carry a blank DD30V-SELMETHOD this way.
- `selectionMethodType` — enum `T` (table) | `V` (view) | `M`
  (structure/other). Only meaningful alongside a non-empty
  `selectionMethod`; omit it too when `selectionMethod` is omitted.
- `dialogType`, `textTable`, `hotKey`.
- `elementary` — boolean. If `true`, `fields` must carry at least one
  `import` field AND at least one `export` field — checked zero-network,
  before the bridge is dispatched at all, no server round trip spent on it.
  If `false`, `includes` may be empty: a collective search help with no
  includes activates fine live (`DH108`, "activated with warnings", a
  success), so the old "has nothing to collect" refusal for this case was
  removed.
- `fields` — array of `{ name, dataElement, import?, export?, defaultValue? }`.
- `includes` — array of `{ name }`, other search helps this one includes
  (a collective search help — `elementary: false` with one or more
  `includes` entries — assembles several elementary helps under one hood).
  No longer required to be non-empty when `elementary: false`.
- `assignments` — array of `{ field, includedHelp, includedField, direction }`,
  `direction` enum `I` (import) | `E` (export); wires an included help's
  fields back to the outer interface. Four refusals guard against building
  an object that fails activation with `DH109` ("search help & was not
  activated") and gets left behind as an INACTIVE-ONLY object (a `DD30L`
  row with `AS4LOCAL = 'N'`, no active row, plus a `TADIR` entry). Two run
  zero-network before the bridge is dispatched (`BAD_INPUT`): every
  `assignments[i].field` must be one of this call's own `fields[].name`,
  and every `assignments[i].includedHelp` must be one of this call's own
  `includes[].name` (case-insensitive). Two more run server-side, generated
  into the ABAP that runs before `RS_CORR_INSERT` so nothing is registered
  when they fire (`CHECK_FAILED`): every `DD31V-SUBSHLP` (from `includes`)
  must already exist as an active search help, and every `DD33V-SUBFIELD`
  (from `assignments[i].includedField`) must be an interface parameter of
  the included help it is assigned against — except when an assignment's
  `includedHelp` names the search help being built itself
  (`SUBSHLP = SHLPNAME`), which skips that one check because the
  definition being built is not in `DD32S` yet. See "Search help refusals
  and DH109" in `doc/TOOLS/write-and-activate.md` for the full picture,
  including why `rc = 4` / `DH108` is a success, not a refusal.

See `SearchHelpParams` in `src/adt/shlp-create.ts` for the exact shape.

**A write replaces the whole definition here too**, same rule as the XML
shapes above: `mode="update"` (action `update_search_help`) re-sends the
entire `shlp` object, and any field, include or assignment not repeated is
dropped, not merged. Requires `shlp` and `description` again in full;
refuses `activate: false` (`DDIF_SHLP_ACTIVATE` runs inside the same bridge
call) and refuses `confirm_in_role_menu` (that guard belongs to `TRAN/T`
only).

**corr_nr pairs with the package, like `TRAN/T`, not like `VIEW/DV`.** A
transportable (non-`$`) package requires `corr_nr` — omitting it is
`TRANSPORT_ERROR`; a `$`-prefixed package refuses one outright. Neither
create nor update ever auto-resolves a transport request the way `VIEW/DV`
does. `mode="update"` never needs `corr_nr`, regardless of package.

**Delete is guarded by a where-used check the other two bridge deletes
(`VIEW/DV`, `TRAN/T`) do not have.** `DD_OBJ_DEL` (then
`TR_TADIR_INTERFACE` to drop the TADIR row) refuses when `DD04L` shows the
search help attached to a data element, `DD35L` shows it on an individual
table/view field, or `DD31S` shows it included by a collective search
help — pass `confirm_in_use: true` to override once you've read what it's
attached to. Delete accepts no `corr_nr` at all (same rule as `VIEW/DV` and
`TRAN/T` delete).

**Delete also reaches an INACTIVE-ONLY search help** — one left behind by
a `DH109` failure (above) or stranded by any other means. The create/update
"already exists" probe and `abap_read` both stay active-only, so an
inactive-only search help still reads back `NOT_FOUND` there; only the
delete path checks both states, probing with `readSearchHelp`'s
`{ includeInactive: true }` option (`src/adt/catalog-read.ts`), which falls
back to the `'N'` version. A plain `abap_write { mode: "delete", type:
"SHLP/DH" }` cleans one of these up the same way it deletes an active
search help — same `SHLP-DELETED`/`SHLP-GONE` markers, both DDIC states and
the `TADIR` entry cleared — with a note that the object had no active
version.

**Reading one back is a catalog read, not an ADT REST GET** — `abap_read`
renders pseudo-DDL from plain-text `DD30L`/`DD30T`/`DD32S`/`DD31S`/`DD33S`
`SELECT`s (`src/adt/catalog-read.ts`), the same mechanism `VIEW/DV` and
`TRAN/T` reads use. `DD33S-VALUEDIREC` is now decoded against domain
`VALUEDIREC`'s fixed values instead of printed as its raw stored code
(falling back to the raw code for any value outside that set), and the
`DD31S` row DDIC writes pointing an elementary search help at its own
interface (`SUBSHLP = SHLPNAME`) is suppressed instead of being listed as
an include of itself — see `doc/TOOLS/read-and-search.md`.

**Attaching a search help to a data element is a `DTEL/DE` field, not a
`SHLP/DH` one.** There is no `SHLP/DH`-side call that wires the two
together — instead, `abap_write` on the data element carries `ddic.searchHelp`
and `ddic.searchHelpParameter` (`DD04L-SHLPNAME` / `DD04L-SHLPFIELD`):

```
abap_write {
  object: "ZDE_EXAMPLE", type: "DTEL/DE",
  ddic: { searchHelp: "ZSH_EXAMPLE", searchHelpParameter: "FIELDNAME" }
}
```

`searchHelp` must name an existing, active `SHLP/DH` — not checked before
send, the same zero-network discipline the rest of `ddic` follows; the
server's own DTEL activation is what actually validates the reference.
`searchHelpParameter` is the search help's OWN interface parameter
(`DD32P-FIELDNAME`), not the data element's own name, and is refused with
`BAD_INPUT` when given without `searchHelp` — a parameter with no search
help to belong to is meaningless (`buildDtel`, `src/adt/ddic-payload.ts`).
Both values are trimmed and upper-cased before send; either one longer than
30 characters is refused with `BAD_INPUT` rather than silently truncated
(`normalizeShlpIdentifier`) — 30 is `DD04L-SHLPNAME`/`DD04L-SHLPFIELD`'s own
column length (`DD03L`, both `CHAR30`). Omitting both emits both elements
empty, which is how an unattached data element looks.

Proven live on A4H (NetWeaver 7.54, client 001), 2026-09-15: `abap_read
PBUNAM DTEL/DE format=raw` returned
`<dtel:searchHelp>USER_ADDR</dtel:searchHelp><dtel:searchHelpParameter>BNAME</dtel:searchHelpParameter>`,
matching that data element's `DD04L` row (`SHLPNAME=USER_ADDR`,
`SHLPFIELD=BNAME`); `MANDT` has both elements empty. **Not verified**: no
`DTEL/DE` write carrying these two fields has itself been sent to a live
system — the attachment is implemented and unit-tested only. See
`doc/TOOLS/write-and-activate.md` for the `ddic` field table.

Every create, and a `mode="update"`, is journalled `irreversible: true`
(there is no "put the old interface back" primitive to replay, and
`abap_journal mode=undo`'s bridge-create branch has no case for `SHLP/DH`
regardless). Delete IS journalled too, with a real before-image — the
pre-delete existence check doubles as it, so the entry carries the
rendered pseudo-DDL as `beforeSource` — but it is still marked
`irreversible: true`: that stored form is pseudo-DDL, not a
`DDIF_SHLP_PUT` payload, so there is nothing to mechanically replay, and
`abap_journal mode=undo` still has no `SHLP/DH` case to reach it through
either way. The entry is kept for audit and manual reconstruction;
reversal is a fresh `abap_write { mode: "write", type: "SHLP/DH" }`, never
`abap_journal mode=undo`. See `doc/LIMITATIONS/editing.md` and
`doc/TOOLS/write-and-activate.md` for the full undo/journal picture.

Proven live on A4H (NetWeaver 7.54, client 001), 2026-09-12, `$TMP` only:
create returned `DH107` from `DDIF_SHLP_ACTIVATE`; delete returned `DH051`
from `DD_OBJ_DEL`, with `TR_TADIR_INTERFACE` removing the TADIR row and a
post-delete re-read confirming absence.

Follow-up round, same system, 2026-09-15, `$TMP` only: all three `DH109`
shapes above were reproduced (through a temporary `$TMP` probe class,
outside abapsmith's own bridge) and each left the described inactive-only
`DD30L`/`TADIR` footprint; all four refusals fired correctly, before any
object was registered, against a payload built to trip each one; and the
inactive-only leftover forced by the probe class read back `NOT_FOUND`
through `abap_read`, then deleted cleanly (`SHLP-DELETED`/`SHLP-GONE`)
through abapsmith's own `mode="delete"`, with a follow-up `DD30L` check
finding zero rows in either state. Elementary and collective creates,
reads, updates and deletes were also re-run through abapsmith's own tool
surface in this round. See `doc/LIMITATIONS/editing.md` for the full
transcript, including the collective-payload-shape variants that were
ruled out as the cause. **Not verified**: any write into a transportable
(non-`$TMP`) package for this type; an SM01-style lock check (there isn't
one, by design, same as `TRAN/T`).

## Skeletons

Known-accepted documents — substitute your name, description, package and
content. One unbroken line each, matching how `abap_read` returns them; do not
reformat or pretty-print.

**`DOMA/DD`**

```
<?xml version="1.0" encoding="utf-8"?><doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZDOM_EXAMPLE" adtcore:type="DOMA/DD" adtcore:description="TODO one-line description" adtcore:masterLanguage="EN" adtcore:language="EN"><adtcore:packageRef adtcore:name="$TMP"/><doma:content><doma:typeInformation><doma:datatype>CHAR</doma:datatype><doma:length>000010</doma:length><doma:decimals>000000</doma:decimals></doma:typeInformation><doma:outputInformation><doma:length>000010</doma:length><doma:style>00</doma:style><doma:conversionExit/><doma:signExists>false</doma:signExists><doma:lowercase>false</doma:lowercase><doma:ampmFormat>false</doma:ampmFormat></doma:outputInformation><doma:valueInformation><doma:valueTableRef/><doma:appendExists>false</doma:appendExists><doma:fixValues/></doma:valueInformation></doma:content></doma:domain>
```

**`DTEL/DE`**

```
<?xml version="1.0" encoding="utf-8"?><blue:wbobj xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZDE_EXAMPLE" adtcore:type="DTEL/DE" adtcore:description="TODO one-line description" adtcore:masterLanguage="EN" adtcore:language="EN"><adtcore:packageRef adtcore:name="$TMP"/><dtel:dataElement xmlns:dtel="http://www.sap.com/adt/dictionary/dataelements"><dtel:typeKind>domain</dtel:typeKind><dtel:typeName>ZDOM_EXAMPLE</dtel:typeName><dtel:dataType>CHAR</dtel:dataType><dtel:dataTypeLength>000010</dtel:dataTypeLength><dtel:dataTypeDecimals>000000</dtel:dataTypeDecimals><dtel:shortFieldLabel>Short</dtel:shortFieldLabel><dtel:shortFieldLength>05</dtel:shortFieldLength><dtel:shortFieldMaxLength>10</dtel:shortFieldMaxLength><dtel:mediumFieldLabel>Medium label</dtel:mediumFieldLabel><dtel:mediumFieldLength>12</dtel:mediumFieldLength><dtel:mediumFieldMaxLength>20</dtel:mediumFieldMaxLength><dtel:longFieldLabel>Long label</dtel:longFieldLabel><dtel:longFieldLength>10</dtel:longFieldLength><dtel:longFieldMaxLength>40</dtel:longFieldMaxLength><dtel:headingFieldLabel>Heading</dtel:headingFieldLabel><dtel:headingFieldLength>07</dtel:headingFieldLength><dtel:headingFieldMaxLength>55</dtel:headingFieldMaxLength><dtel:searchHelp/><dtel:searchHelpParameter/><dtel:setGetParameter/><dtel:defaultComponentName/><dtel:deactivateInputHistory>false</dtel:deactivateInputHistory><dtel:changeDocument>false</dtel:changeDocument><dtel:leftToRightDirection>false</dtel:leftToRightDirection><dtel:deactivateBIDIFiltering>false</dtel:deactivateBIDIFiltering></dtel:dataElement></blue:wbobj>
```

**`TTYP/DA`**

```
<?xml version="1.0" encoding="utf-8"?><ttyp:tableType xmlns:ttyp="http://www.sap.com/dictionary/tabletype" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZTT_EXAMPLE" adtcore:type="TTYP/DA" adtcore:description="TODO one-line description" adtcore:masterLanguage="EN" adtcore:language="EN"><adtcore:packageRef adtcore:name="$TMP"/><ttyp:rowType><ttyp:typeKind>dictionaryType</ttyp:typeKind><ttyp:typeName>ZS_EXAMPLE</ttyp:typeName><ttyp:builtInType><ttyp:dataType>STRU</ttyp:dataType><ttyp:length>000000</ttyp:length><ttyp:decimals>000000</ttyp:decimals></ttyp:builtInType><ttyp:rangeType/></ttyp:rowType><ttyp:initialRowCount>00000</ttyp:initialRowCount><ttyp:accessType>standard</ttyp:accessType><ttyp:primaryKey ttyp:isVisible="true" ttyp:isEditable="true"><ttyp:definition>standard</ttyp:definition><ttyp:kind>nonUnique</ttyp:kind><ttyp:components ttyp:isVisible="false"/><ttyp:alias/></ttyp:primaryKey></ttyp:tableType>
```

**`ENQU/DL`**

```
<?xml version="1.0" encoding="UTF-8"?><enqu:lockobject xmlns:enqu="http://www.sap.com/adt/ddic/enqu" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="EZLOCK_EXAMPLE" adtcore:type="ENQU/DL" adtcore:description="TODO one-line description"><adtcore:packageRef adtcore:name="$TMP"/><enqu:content><enqu:primaryTable><enqu:tableName>ZTABLE_EXAMPLE</enqu:tableName><enqu:lockMode>E</enqu:lockMode></enqu:primaryTable></enqu:content></enqu:lockobject>
```

## Verify

Activation returns 200 even when it failed — check `chkl:messages` for
`type: "E"`, free in the response. The read-back is `verified`-mode only.
Full checklist: `abapsmith-create-an-object`.
