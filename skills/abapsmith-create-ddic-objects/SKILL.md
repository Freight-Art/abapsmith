---
name: abapsmith-create-ddic-objects
description: Creates domains, data elements, table types, tables, structures, message classes, and lock objects in the right order with the right payload shape. Use for any DDIC dictionary object.
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
both. Which fields apply where: `dataType`/`length`/`decimals` apply to all
three; `typeKind`/`typeName` are `DTEL/TTYP` only; `shortLabel`/`mediumLabel`/
`longLabel`/`headingLabel` (and their `…Length` counterparts) are `DTEL`
only; `outputLength`/`lowercase`/`signExists` are `DOMA` only. Any other
field name is refused by the schema itself. It only emits element sets
proven in a PUT body a live system accepted; anything not proven there (fixed
values, a value table ref, `primaryKey`, `initialRowCount`, a settable
`rangeType`, `typeKind: "rangeTypeOnDataelement"`, …) is refused — drop to
`source` for those. `ddic: {}` alone reproduces the grounded body's defaults.
This path is unverified — it has never itself been sent to a live system —
so treat a rejection as informative and fall back to `source` below.

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
not a length complaint. In every live capture, the `<dtel:*FieldLength>` value
equals the actual character length of the matching label — worth imitating,
though the server has not been observed enforcing it.

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
