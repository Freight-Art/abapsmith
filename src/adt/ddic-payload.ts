/**
 * Root identity and known-accepted skeleton for the three XML-only DDIC
 * properties-shape writes — `DOMA/DD`, `DTEL/DE`, `TTYP/DA`.
 *
 * A live A/B sweep found 33 writes of these three types rejected — one
 * object took 8 attempts — because SAP's PUT handler names only the NEXT
 * missing element per rejection, so a caller composing the descriptor by
 * hand adds one element per round trip. Worse, one live `DTEL/DE` write
 * bound its inner `<dataElement>` to the wrong namespace (the root
 * `<blue:wbobj>` element's own namespace, reused by mistake) and the server
 * ACCEPTED it — `ok:true, created:true, activated:true` — while silently
 * producing a data element with no type at all (`abap.(0)`, length 0);
 * nothing surfaced the corruption short of a read-back.
 *
 * `ddicDescriptorSkeleton` gives a caller a complete, known-accepted
 * document to start from instead of guessing. `assertDdicDescriptorShape`
 * is a zero-network pre-send check on the one thing cheap to verify without
 * a real XML parser — the root element's identity, and for `DTEL/DE`, the
 * inner element's namespace — so the two failure classes above are caught
 * before anything is sent, not after an 8th rejection or a silent write.
 *
 * Deliberately NOT a schema: which child elements a descriptor needs varies
 * with `typeKind`, and the known cases aren't uniform enough to encode — e.g.
 * a `rangeTypeOnDataelement` row type was REJECTED at
 * activation ("The row type must be a structure for ranges table types"),
 * not accepted with or without `<ttyp:builtInType>`. Since the full
 * required-child set per `typeKind` isn't known, a guessed schema risks
 * refusing payloads nothing has actually ruled out. The skeleton, not a
 * schema, is what carries known-good shapes.
 */
import { AbapError } from "./errors.js";

const DATAELEMENT_NS = "http://www.sap.com/adt/dictionary/dataelements";

/** `NAME` is replaced with the object name — see {@link ddicDescriptorSkeleton}. */
const DOMA_SKELETON =
  '<?xml version="1.0" encoding="utf-8"?><doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="NAME" adtcore:type="DOMA/DD" adtcore:description="TODO one-line description" adtcore:masterLanguage="EN" adtcore:language="EN"><adtcore:packageRef adtcore:name="$TMP"/><doma:content><doma:typeInformation><doma:datatype>CHAR</doma:datatype><doma:length>000010</doma:length><doma:decimals>000000</doma:decimals></doma:typeInformation><doma:outputInformation><doma:length>000010</doma:length><doma:style>00</doma:style><doma:conversionExit/><doma:signExists>false</doma:signExists><doma:lowercase>false</doma:lowercase><doma:ampmFormat>false</doma:ampmFormat></doma:outputInformation><doma:valueInformation><doma:valueTableRef/><doma:appendExists>false</doma:appendExists><doma:fixValues/></doma:valueInformation></doma:content></doma:domain>';

const DTEL_SKELETON =
  '<?xml version="1.0" encoding="utf-8"?><blue:wbobj xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="NAME" adtcore:type="DTEL/DE" adtcore:description="TODO one-line description" adtcore:masterLanguage="EN" adtcore:language="EN"><adtcore:packageRef adtcore:name="$TMP"/><dtel:dataElement xmlns:dtel="http://www.sap.com/adt/dictionary/dataelements"><dtel:typeKind>domain</dtel:typeKind><dtel:typeName>ZDOM_EXAMPLE</dtel:typeName><dtel:dataType>CHAR</dtel:dataType><dtel:dataTypeLength>000010</dtel:dataTypeLength><dtel:dataTypeDecimals>000000</dtel:dataTypeDecimals><dtel:shortFieldLabel>Short</dtel:shortFieldLabel><dtel:shortFieldLength>05</dtel:shortFieldLength><dtel:shortFieldMaxLength>10</dtel:shortFieldMaxLength><dtel:mediumFieldLabel>Medium label</dtel:mediumFieldLabel><dtel:mediumFieldLength>12</dtel:mediumFieldLength><dtel:mediumFieldMaxLength>20</dtel:mediumFieldMaxLength><dtel:longFieldLabel>Long label</dtel:longFieldLabel><dtel:longFieldLength>10</dtel:longFieldLength><dtel:longFieldMaxLength>40</dtel:longFieldMaxLength><dtel:headingFieldLabel>Heading</dtel:headingFieldLabel><dtel:headingFieldLength>07</dtel:headingFieldLength><dtel:headingFieldMaxLength>55</dtel:headingFieldMaxLength><dtel:searchHelp/><dtel:searchHelpParameter/><dtel:setGetParameter/><dtel:defaultComponentName/><dtel:deactivateInputHistory>false</dtel:deactivateInputHistory><dtel:changeDocument>false</dtel:changeDocument><dtel:leftToRightDirection>false</dtel:leftToRightDirection><dtel:deactivateBIDIFiltering>false</dtel:deactivateBIDIFiltering></dtel:dataElement></blue:wbobj>';

const TTYP_SKELETON =
  '<?xml version="1.0" encoding="utf-8"?><ttyp:tableType xmlns:ttyp="http://www.sap.com/dictionary/tabletype" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="NAME" adtcore:type="TTYP/DA" adtcore:description="TODO one-line description" adtcore:masterLanguage="EN" adtcore:language="EN"><adtcore:packageRef adtcore:name="$TMP"/><ttyp:rowType><ttyp:typeKind>dictionaryType</ttyp:typeKind><ttyp:typeName>ZS_EXAMPLE</ttyp:typeName><ttyp:builtInType><ttyp:dataType>STRU</ttyp:dataType><ttyp:length>000000</ttyp:length><ttyp:decimals>000000</ttyp:decimals></ttyp:builtInType><ttyp:rangeType/></ttyp:rowType><ttyp:initialRowCount>00000</ttyp:initialRowCount><ttyp:accessType>standard</ttyp:accessType><ttyp:primaryKey ttyp:isVisible="true" ttyp:isEditable="true"><ttyp:definition>standard</ttyp:definition><ttyp:kind>nonUnique</ttyp:kind><ttyp:components ttyp:isVisible="false"/><ttyp:alias/></ttyp:primaryKey></ttyp:tableType>';

interface DdicRootIdentity {
  readonly localName: string;
  readonly namespace: string;
  readonly skeleton: string;
}

/**
 * Root local name + namespace URI, verified against live wire bytes:
 * `test/fixtures/live-captured/844-live-dtel-s-carr-id.xml` and
 * `845-live-doma-s-carr-id.xml` for `DOMA/DD`/`DTEL/DE`; the live
 * `GET /sap/bc/adt/ddic/tabletypes/zoth_t_note_k` body pinned as `TTYP_XML`
 * in `test/ddic.test.ts` for `TTYP/DA`.
 */
const DDIC_SHAPES: Readonly<Record<string, DdicRootIdentity>> = {
  "DOMA/DD": {
    localName: "domain",
    namespace: "http://www.sap.com/dictionary/domain",
    skeleton: DOMA_SKELETON,
  },
  "DTEL/DE": {
    localName: "wbobj",
    namespace: "http://www.sap.com/wbobj/dictionary/dtel",
    skeleton: DTEL_SKELETON,
  },
  "TTYP/DA": {
    localName: "tableType",
    namespace: "http://www.sap.com/dictionary/tabletype",
    skeleton: TTYP_SKELETON,
  },
};

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

/** A string second argument to `replace` treats `$&`/`` $` ``/`$'`/`$1` specially — a replacer function does not. */
function renderSkeleton(shape: DdicRootIdentity, name: string): string {
  return shape.skeleton.replace('adtcore:name="NAME"', () => `adtcore:name="${escapeXmlAttr(name)}"`);
}

/**
 * The complete known-accepted document for `type`, with `adtcore:name` set
 * to `name` — or `undefined` for any type that isn't one of the three
 * XML-only DDIC types. Values other than the name (description, lengths,
 * the example domain/structure names) are placeholders the caller must
 * still fill in for a real object.
 */
export function ddicDescriptorSkeleton(type: string, name: string): string | undefined {
  const shape = DDIC_SHAPES[type];
  if (!shape) return undefined;
  return renderSkeleton(shape, name);
}

const XML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const ROOT_TAG_RE = /<([A-Za-z_][\w.-]*)(?::([A-Za-z_][\w.-]*))?\b[^>]*>/;
const DATA_ELEMENT_TAG_RE = /<(?:([A-Za-z_][\w.-]*):)?dataElement\b[^>]*>/;
const XMLNS_ATTR_RE = /(?:^|\s)xmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** `xmlns:PFX="URI"` / `xmlns="URI"` declared on one element's own open tag, keyed by prefix (`""` = default). */
function collectXmlns(tagText: string): Record<string, string> {
  const map: Record<string, string> = {};
  XMLNS_ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = XMLNS_ATTR_RE.exec(tagText)) !== null) {
    map[m[1] ?? ""] = m[2] ?? m[3] ?? "";
  }
  return map;
}

function resolvePrefix(prefix: string | undefined, map: Record<string, string>): string | undefined {
  return map[prefix ?? ""];
}

function throwRootMismatch(
  type: string,
  name: string,
  expected: DdicRootIdentity,
  foundLocalName: string,
  foundNamespace: string | undefined,
): never {
  const skeleton = renderSkeleton(expected, name);
  const foundNsText =
    foundNamespace !== undefined ? `"${foundNamespace}"` : "(no namespace could be resolved for its prefix)";
  throw new AbapError(
    "BAD_INPUT",
    `The XML for ${type} ${name} has root element <${foundLocalName}> bound to namespace ` +
      `${foundNsText}, but a ${type} descriptor's root must be <${expected.localName}> bound ` +
      `to namespace "${expected.namespace}".`,
    {
      name,
      type,
      foundLocalName,
      ...(foundNamespace !== undefined ? { foundNamespace } : {}),
      expectedLocalName: expected.localName,
      expectedNamespace: expected.namespace,
      ddicSkeleton: skeleton,
    },
    "No write was sent and no lock was taken — the object is untouched. SAP's PUT handler names " +
      "only the next missing element per rejection, so guessing the root element/namespace one " +
      `round trip at a time can take many attempts. Start from this known-accepted skeleton ` +
      `instead:\n${skeleton}`,
  );
}

function throwDataElementNamespaceMismatch(expected: DdicRootIdentity, name: string, foundNamespace: string): never {
  const skeleton = renderSkeleton(expected, name);
  throw new AbapError(
    "BAD_INPUT",
    `The XML for DTEL/DE ${name} binds its inner <dataElement> element to namespace ` +
      `"${foundNamespace}" instead of "${DATAELEMENT_NS}".`,
    {
      name,
      type: "DTEL/DE",
      foundInnerNamespace: foundNamespace,
      expectedInnerNamespace: DATAELEMENT_NS,
      ddicSkeleton: skeleton,
    },
    "No write was sent and no lock was taken — the object is untouched. This is not a shape " +
      "SAP's PUT handler rejects — it is ACCEPTED (ok:true, created:true, activated:true) and " +
      "produces a data element with no type at all (abap.(0), length 0), with nothing to " +
      "signal the corruption until a later read-back. That is why abapsmith refuses this " +
      "locally rather than sending it. A " +
      `common cause is reusing the root <blue:wbobj> element's own namespace ` +
      `("http://www.sap.com/wbobj/dictionary/dtel") on the inner element instead of its own, ` +
      `distinct namespace. Bind <dataElement> to "${DATAELEMENT_NS}", as in this ` +
      `known-accepted skeleton:\n${skeleton}`,
  );
}

/**
 * Throws `AbapError("BAD_INPUT")` when `xml`'s root element identity (and,
 * for `DTEL/DE`, its inner `<dataElement>` namespace) is PROVABLY wrong for
 * `type`; returns silently otherwise.
 *
 * Fails open on anything it cannot resolve without a real XML parser — an
 * unknown `type`, no root tag found, a root/inner prefix this document never
 * binds, no `<dataElement>` in a `DTEL/DE` payload — because a guess here
 * would either block a legitimate write this function doesn't understand or
 * give false confidence about a document it never actually checked.
 *
 * No check on which CHILD elements a descriptor must contain, or in what
 * order — see this module's doc comment for why: the required child set is
 * known to vary by `typeKind`, and {@link ddicDescriptorSkeleton} — not a
 * guessed schema — is what carries that information to the caller.
 */
export function assertDdicDescriptorShape(type: string, name: string, xml: string): void {
  const expected = DDIC_SHAPES[type];
  if (!expected) return;

  const stripped = xml.replace(XML_COMMENT_RE, "");
  const rootMatch = ROOT_TAG_RE.exec(stripped);
  if (!rootMatch) return;

  const rootTag = rootMatch[0];
  if (rootMatch[1] === undefined) return;
  const rootPrefix = rootMatch[2] !== undefined ? rootMatch[1] : undefined;
  const rootLocalName = rootMatch[2] !== undefined ? rootMatch[2] : rootMatch[1];
  const rootNsMap = collectXmlns(rootTag);

  if (rootLocalName !== expected.localName) {
    throwRootMismatch(type, name, expected, rootLocalName, resolvePrefix(rootPrefix, rootNsMap));
  }

  const rootNs = resolvePrefix(rootPrefix, rootNsMap);
  if (rootNs === undefined) return;
  if (rootNs !== expected.namespace) {
    throwRootMismatch(type, name, expected, rootLocalName, rootNs);
  }

  if (type !== "DTEL/DE") return;

  const deMatch = DATA_ELEMENT_TAG_RE.exec(stripped);
  if (!deMatch) return;

  const deTag = deMatch[0];
  const dePrefix = deMatch[1];
  const extendedMap = { ...rootNsMap, ...collectXmlns(deTag) };
  const deNs = resolvePrefix(dePrefix, extendedMap);
  if (deNs === undefined) return;
  if (deNs !== DATAELEMENT_NS) throwDataElementNamespaceMismatch(expected, name, deNs);
}

// ---------------------------------------------------------------------------
// Structured input: build one of the three descriptors above
// from typed fields instead of hand-composed XML, without inventing shape.
//
// Element set and order are lifted verbatim from PUT bodies a live system
// accepted for DOMA/DTEL/TTYP; acceptance for these three types is asserted in
// src/adt/capabilities.ts's `create` comments for that sweep — there is
// no committed sweep-log artifact, so that comment (not a log file) is the
// citation for "accepted". Every default below is the literal value those
// bodies used, so `ddic: {}` reproduces the grounded document byte-for-byte
// (name/description/package aside) — with one deliberate addition, the root
// language attributes, see ROOT_LANGUAGE_ATTRS.
//
// Live-verified on A4H (NetWeaver 7.54, client 001), 2026-09-16, through this
// builder's own output sent via the `source` route (#144/#145):
//   - DTEL/DE ZAS_DTEL_TEST in $TMP: the body WITHOUT `adtcore:masterLanguage`
//     was accepted, but every `<dtel:*FieldLabel>` came back empty on the
//     read-back (CHECK_FAILED / VALUE_DISCARDED, object left inactive). The
//     byte-identical body with `adtcore:masterLanguage="EN"` added to the root
//     activated, and the read-back held all four labels and the `*FieldLength`
//     values 10/20/40/55 unchanged.
//   - DOMA/DD ZAS_DOMA_ST (CHAR 1, three fixed values) and ZAS_DOMA_AMT
//     (DEC 13,3) and DTEL/DE ZAS_DTEL_LBL: see test/integration-ddic-structured.test.ts.

const ADTCORE_NS = "http://www.sap.com/adt/core";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

/**
 * Root attributes every builder emits. `adtcore:masterLanguage` is what makes
 * the server KEEP language-dependent texts (DTEL field labels, DOMA fixed-value
 * texts): without it the PUT is accepted and the texts are silently discarded —
 * reproduced live for DTEL/DE on 2026-09-16 (see the module note above) and
 * for DOMA/DD earlier (`assertDomaMasterLanguage` in src/tools/write.ts refuses
 * exactly that document zero-network). `adtcore:language` is what every live
 * GET carries next to it and what the three static skeletons above send.
 */
const ROOT_LANGUAGE_ATTRS = 'adtcore:masterLanguage="EN" adtcore:language="EN"';

/** DD07L-DOMVALUE_L / DOMVALUE_H are CHAR10 — a raw DTEL/DE read of DOMVALUE_L on A4H, 2026-09-16, returned dataType CHAR, dataTypeLength 000010. */
const FIX_VALUE_MAX_LEN = 10;
/** DD07T-DDTEXT is AS4TEXT, CHAR60 — a raw DTEL/DE read of AS4TEXT on A4H, 2026-09-16, returned dataType CHAR, dataTypeLength 000060. */
const FIX_VALUE_TEXT_MAX_LEN = 60;

/** One `<doma:fixValue>` row — see {@link DdicStructuredFields.fixedValues}. */
export interface DdicFixedValue {
  /** Single value, or the lower bound of an interval when `high` is given. An empty string is a legal key (XFELD's second row is `<doma:low/>` "Nein"). */
  low: string;
  /** Upper bound of an interval; omitted for a single value. */
  high?: string;
  /** Text shown for the value — DD07T-DDTEXT, at most 60 characters. */
  text: string;
}

/** Flat, type-agnostic field surface for the three properties-shape DDIC types. Unset fields fall back to the bench-accepted literal for that slot. */
export interface DdicStructuredFields {
  dataType?: string;
  length?: number;
  decimals?: number;
  /**
   * DOMA/DD only. When omitted it is computed per data type — see
   * {@link defaultDomaOutputLength}; a caller's value always wins.
   */
  outputLength?: number;
  lowercase?: boolean;
  signExists?: boolean;
  /**
   * DOMA/DD only. Rendered as the `<doma:valueInformation>` /
   * `<doma:fixValues>` block whose shape is lifted from live GETs of XFELD and
   * AS4LOCAL (A4H, 2026-09-16): one `<doma:fixValue>` per row with `low`,
   * `high` and `text` children in that order. `<doma:position>` is left out —
   * the server numbers the rows. Each `low`/`high` is refused above
   * {@link FIX_VALUE_MAX_LEN} characters and above the domain's own `length`;
   * `text` above {@link FIX_VALUE_TEXT_MAX_LEN}. An empty array emits the
   * empty `<doma:fixValues/>` the accepted skeleton carries.
   */
  fixedValues?: DdicFixedValue[];
  /**
   * DOMA/DD only. Value table (DD01L-ENTITYTAB), rendered as
   * `<doma:valueTableRef adtcore:uri="/sap/bc/adt/ddic/tables/<name>"
   * adtcore:type="TABL/DT" adtcore:name="<NAME>"/>` — the exact triple a live
   * GET of S_CARR_ID returns for SCARR
   * (test/fixtures/live-captured/845-live-doma-s-carr-id.xml). Uppercased;
   * whether the table exists and has a key field on this domain is checked by
   * the server's own activation, not here.
   */
  valueTable?: string;
  typeKind?: DdicTypeKind;
  typeName?: string;
  shortLabel?: string;
  shortLength?: number;
  mediumLabel?: string;
  mediumLength?: number;
  longLabel?: string;
  longLength?: number;
  headingLabel?: string;
  headingLength?: number;
  /**
   * Search help attached to this data element — DD04L-SHLPNAME. Must name an
   * existing, active SHLP/DH; this builder does not verify that (zero-network,
   * like the rest of the module) — the server's own DTEL activation is what
   * actually checks the reference. Uppercased and refused above 30 characters
   * (DD04L-SHLPNAME is CHAR30, live-verified via DD03L on A4H, 2026-09-15 — see
   * {@link SHLP_NAME_MAX_LEN}). Omitted still emits an empty
   * `<dtel:searchHelp/>`, matching every accepted body's own shape.
   */
  searchHelp?: string;
  /**
   * The search help's OWN interface parameter (DD32P-FIELDNAME) this data
   * element binds to — DD04L-SHLPFIELD. Not the data element's own name.
   * Meaningless without a search help to belong to, and refused when given
   * without {@link DdicStructuredFields.searchHelp}. Uppercased and refused
   * above 30 characters (DD04L-SHLPFIELD is CHAR30, live-verified the same way
   * as `searchHelp` above).
   */
  searchHelpParameter?: string;
}

/** The three legal `ddic.typeKind` values — see {@link DdicStructuredFields.typeKind}. */
export const DDIC_TYPE_KINDS = ["domain", "predefinedAbapType", "dictionaryType"] as const;
export type DdicTypeKind = (typeof DDIC_TYPE_KINDS)[number];

function isDdicTypeKind(s: string): s is DdicTypeKind {
  return (DDIC_TYPE_KINDS as readonly string[]).includes(s);
}

/** Loud rejection for a `ddic.typeKind` v2 sends as a bare string (Rule 1) — mirrors assertClassInclude (src/adt/types.ts). */
export function assertDdicTypeKind(requested: string): DdicTypeKind {
  if (isDdicTypeKind(requested)) return requested;
  throw new AbapError(
    "BAD_INPUT",
    `ddic.typeKind "${requested}" is not one of the accepted values.`,
    { requested, allowed: [...DDIC_TYPE_KINDS] },
    `Use one of: ${DDIC_TYPE_KINDS.join(", ")}.`,
  );
}

const DOMA_FIELDS: ReadonlySet<string> = new Set([
  "dataType",
  "length",
  "decimals",
  "outputLength",
  "lowercase",
  "signExists",
  "fixedValues",
  "valueTable",
]);
const DTEL_FIELDS: ReadonlySet<string> = new Set([
  "typeKind",
  "typeName",
  "dataType",
  "length",
  "decimals",
  "shortLabel",
  "shortLength",
  "mediumLabel",
  "mediumLength",
  "longLabel",
  "longLength",
  "headingLabel",
  "headingLength",
  "searchHelp",
  "searchHelpParameter",
]);
const TTYP_FIELDS: ReadonlySet<string> = new Set(["typeKind", "typeName", "dataType", "length", "decimals"]);

const STRUCTURED_FIELDS_BY_TYPE: Readonly<Record<string, ReadonlySet<string>>> = {
  "DOMA/DD": DOMA_FIELDS,
  "DTEL/DE": DTEL_FIELDS,
  "TTYP/DA": TTYP_FIELDS,
};

function escapeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Self-closes on empty text, matching how the bench bodies render their empty slots (e.g. `<dtel:typeName/>`). */
function elem(tag: string, value: string): string {
  return value === "" ? `<${tag}/>` : `<${tag}>${escapeXmlText(value)}</${tag}>`;
}

function num(n: number): string {
  return String(Math.trunc(n));
}

/** Zero-padded to `width` — DTEL's `dataTypeLength`/`dataTypeDecimals` and TTYP's `length`/`decimals` are `000010`-style in every attested body, and DTEL's `*FieldLength` is two digits (`03`, `07` in live GETs of MANDT and in the skeleton); DOMA's type/output slots are not (`doma:length>10`, unpadded) and must keep using {@link num}. */
function numPadded(n: number, width: number): string {
  return String(Math.trunc(n)).padStart(width, "0");
}

/** `*FieldMaxLength` is a fixed constant per label, not derived from the caller's `*Length` — capture 844 and the static skeleton both show it independent of (and unequal to) `*FieldLength`. */
const DTEL_MAX_LENGTH = {
  short: 10,
  medium: 20,
  long: 40,
  heading: 55,
} as const;

type DtelLabelSlot = keyof typeof DTEL_MAX_LENGTH;

/**
 * `<dtel:*FieldLength>` is the label's display width (DD04T's SCRLEN1..3 /
 * SCRLEN4 for heading): a designer-chosen number of columns between the
 * label's own length and the slot's fixed maximum — MANDT stores 10 for the
 * 7-character "Mandant" and 03 for the heading "Mdt" (live GET, A4H,
 * 2026-09-16). The server stores whatever is sent without checking, so this is
 * the only place a label longer than its slot, or a width the label cannot fit
 * in, gets caught. Refuses rather than truncates, for the reason
 * {@link normalizeShlpIdentifier} gives.
 */
function dtelLabel(
  slot: DtelLabelSlot,
  label: string,
  requestedLength: number | undefined,
  name: string,
): { label: string; length: number } {
  const max = DTEL_MAX_LENGTH[slot];
  if (label.length > max) {
    throw new AbapError(
      "BAD_INPUT",
      `ddic.${slot}Label "${label}" is ${label.length} characters, longer than the ${max}-character ` +
        `maximum of the ${slot} field label (DD04T).`,
      { name, type: "DTEL/DE", field: `${slot}Label`, value: label, length: label.length, maxLength: max },
      `Shorten ddic.${slot}Label to ${max} characters or fewer.`,
    );
  }
  const length = requestedLength ?? max;
  if (!Number.isInteger(length) || length < Math.max(1, label.length) || length > max) {
    throw new AbapError(
      "BAD_INPUT",
      `ddic.${slot}Length ${length} is not a usable display width for the ${slot} field label "${label}" — ` +
        `it must be a whole number from ${Math.max(1, label.length)} (the label's own length) to ${max}.`,
      { name, type: "DTEL/DE", field: `${slot}Length`, value: length, labelLength: label.length, maxLength: max },
      `Drop ddic.${slot}Length to get the slot's maximum (${max}), or give a value between the label's length and ${max}.`,
    );
  }
  return { label, length };
}

/** Numeric domain types whose external display needs room for the decimal separator and the sign. */
const DOMA_DECIMAL_TYPES: ReadonlySet<string> = new Set(["DEC", "CURR", "QUAN"]);

/**
 * Output length the ABAP Dictionary itself proposes for a domain when the
 * caller gives none: DEC/CURR/QUAN need one column for the decimal separator
 * (when there are decimals) and one for the sign (when `signExists`); DATS
 * displays as 10 (`DD.MM.YYYY`), TIMS as 8 (`HH:MM:SS`); everything else
 * (CHAR, NUMC, CLNT, LANG, UNIT, CUKY, …) displays as many columns as it is
 * long. Exported for the offline tests; a caller's `outputLength` always wins.
 */
export function defaultDomaOutputLength(dataType: string, length: number, decimals: number, signExists: boolean): number {
  const type = dataType.toUpperCase();
  if (DOMA_DECIMAL_TYPES.has(type)) return length + (decimals > 0 ? 1 : 0) + (signExists ? 1 : 0);
  if (type === "DATS") return 10;
  if (type === "TIMS") return 8;
  return length;
}

function fixedValueBound(
  which: "low" | "high",
  value: string,
  index: number,
  domainLength: number,
  name: string,
): string {
  const cap = Math.min(FIX_VALUE_MAX_LEN, domainLength);
  if (value.length > cap) {
    const reason =
      value.length > FIX_VALUE_MAX_LEN
        ? `longer than DD07L-DOMVALUE_${which === "low" ? "L" : "H"}'s ${FIX_VALUE_MAX_LEN}-character limit`
        : `longer than the domain's own length of ${domainLength}`;
    throw new AbapError(
      "BAD_INPUT",
      `ddic.fixedValues[${index}].${which} "${value}" is ${value.length} characters, ${reason}.`,
      { name, type: "DOMA/DD", field: `fixedValues[${index}].${which}`, value, length: value.length, maxLength: cap },
      `Shorten the value to ${cap} characters or fewer, or raise ddic.length.`,
    );
  }
  return value;
}

function renderFixValue(v: DdicFixedValue, index: number, domainLength: number, name: string): string {
  const low = fixedValueBound("low", v.low, index, domainLength, name);
  const high = v.high === undefined ? "" : fixedValueBound("high", v.high, index, domainLength, name);
  if (v.text.length > FIX_VALUE_TEXT_MAX_LEN) {
    throw new AbapError(
      "BAD_INPUT",
      `ddic.fixedValues[${index}].text "${v.text}" is ${v.text.length} characters, longer than ` +
        `DD07T-DDTEXT's ${FIX_VALUE_TEXT_MAX_LEN}-character limit.`,
      {
        name,
        type: "DOMA/DD",
        field: `fixedValues[${index}].text`,
        value: v.text,
        length: v.text.length,
        maxLength: FIX_VALUE_TEXT_MAX_LEN,
      },
      `Shorten the text to ${FIX_VALUE_TEXT_MAX_LEN} characters or fewer.`,
    );
  }
  // Child order low, high, text is the live order (XFELD/AS4LOCAL GETs); `high` is
  // always present, self-closed when empty, as in every live row.
  return `<doma:fixValue>${elem("doma:low", low)}${elem("doma:high", high)}${elem("doma:text", v.text)}</doma:fixValue>`;
}

function renderValueTableRef(valueTable: string | undefined, name: string): string {
  if (valueTable === undefined) return "<doma:valueTableRef/>";
  const table = valueTable.trim().toUpperCase();
  if (table === "" || !/^[A-Z0-9_/]{1,30}$/.test(table)) {
    throw new AbapError(
      "BAD_INPUT",
      `ddic.valueTable "${valueTable}" is not a table name (DD01L-ENTITYTAB is CHAR30: letters, digits, "_" and "/").`,
      { name, type: "DOMA/DD", field: "valueTable", value: valueTable },
      "Give the name of an existing transparent table, or drop ddic.valueTable.",
    );
  }
  return (
    `<doma:valueTableRef adtcore:uri="/sap/bc/adt/ddic/tables/${escapeXmlAttr(table.toLowerCase())}" ` +
    `adtcore:type="TABL/DT" adtcore:name="${escapeXmlAttr(table)}"/>`
  );
}

/**
 * DD04L-SHLPNAME and DD04L-SHLPFIELD are both CHAR30 — live-verified via DD03L
 * (TABNAME='DD04L', FIELDNAME IN ('SHLPNAME','SHLPFIELD')) on A4H, 2026-09-15:
 * both rows returned DATATYPE=CHAR, LENG=30. Not the same read as the
 * element-shape capture below (a raw DTEL/DE GET), but the same system/date.
 */
const SHLP_NAME_MAX_LEN = 30;

/**
 * Uppercases and length-checks a `ddic.searchHelp`/`ddic.searchHelpParameter`
 * value against {@link SHLP_NAME_MAX_LEN} — both are ABAP object/parameter
 * names (DD04L-SHLPNAME, DD04L-SHLPFIELD), so this follows the same
 * trim-then-uppercase convention other DDIC/CTS identifiers get elsewhere in
 * this codebase (e.g. `program.trim().toUpperCase()` for TRAN/T's `program`
 * and `resolveShlpPackage`'s package-name normalisation, both in
 * src/tools/write.ts) rather than sending the value byte-for-byte as given.
 * Refuses rather than truncates on overflow — silently cutting the value down
 * would send something other than what the caller asked for, the exact class
 * of silent corruption this module's own header comment warns about.
 */
function normalizeShlpIdentifier(value: string, field: "searchHelp" | "searchHelpParameter", type: string, name: string): string {
  const column = field === "searchHelp" ? "DD04L-SHLPNAME" : "DD04L-SHLPFIELD";
  const normalized = value.trim().toUpperCase();
  if (normalized.length > SHLP_NAME_MAX_LEN) {
    throw new AbapError(
      "BAD_INPUT",
      `ddic.${field} "${value}" is ${normalized.length} characters, longer than ${column}'s ` +
        `${SHLP_NAME_MAX_LEN}-character limit.`,
      { name, type, field, value, length: normalized.length, maxLength: SHLP_NAME_MAX_LEN },
      `Shorten ddic.${field} to ${SHLP_NAME_MAX_LEN} characters or fewer.`,
    );
  }
  return normalized;
}

/** Every key present with a defined value must be in `allowed` for `type` — anything else is either ungrounded or belongs to a different type. */
function rejectStrayFields(type: string, name: string, fields: DdicStructuredFields, allowed: ReadonlySet<string>): void {
  const stray = Object.keys(fields).filter(
    (k) => (fields as Record<string, unknown>)[k] !== undefined && !allowed.has(k),
  );
  if (stray.length > 0) {
    throw new AbapError(
      "BAD_INPUT",
      `ddic.${stray[0]} does not apply to ${type} — either no accepted PUT body has ever used it, ` +
        `or it belongs to a different DDIC type.`,
      { name, type, strayFields: stray, allowedFields: [...allowed] },
      "Drop this field, or if you need it, compose raw XML via `source` instead — `ddic` only " +
        "covers the element set proven to be accepted on a live system.",
    );
  }
}

function buildDoma(name: string, description: string, packageName: string, f: DdicStructuredFields): string {
  const dataType = f.dataType ?? "CHAR";
  const length = f.length ?? 10;
  const decimals = f.decimals ?? 0;
  const lowercase = f.lowercase ?? false;
  const signExists = f.signExists ?? false;
  const outputLength = f.outputLength ?? defaultDomaOutputLength(dataType, length, decimals, signExists);
  // The valueInformation block is only emitted when there is something to put in
  // it: the bench-accepted body has none, and `injectEmptyFixValues`
  // (src/tools/write.ts) leaves a document without the block alone. Its child
  // order — valueTableRef, appendExists, fixValues — is the live order.
  const fixRows = (f.fixedValues ?? []).map((v, i) => renderFixValue(v, i, length, name)).join("");
  const valueInformation =
    f.fixedValues === undefined && f.valueTable === undefined
      ? ""
      : `<doma:valueInformation>${renderValueTableRef(f.valueTable, name)}${elem("doma:appendExists", "false")}` +
        // No rows: the skeleton's self-closing `<doma:fixValues/>`, byte for byte.
        (fixRows === "" ? "<doma:fixValues/>" : `<doma:fixValues>${fixRows}</doma:fixValues>`) +
        `</doma:valueInformation>`;
  return (
    `${XML_DECL}<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" xmlns:adtcore="${ADTCORE_NS}" ` +
    `adtcore:name="${escapeXmlAttr(name)}" adtcore:type="DOMA/DD" adtcore:description="${escapeXmlAttr(description)}" ${ROOT_LANGUAGE_ATTRS}>` +
    `<adtcore:packageRef adtcore:name="${escapeXmlAttr(packageName)}"/>` +
    `<doma:content>` +
    `<doma:typeInformation>${elem("doma:datatype", dataType)}${elem("doma:length", num(length))}${elem("doma:decimals", num(decimals))}</doma:typeInformation>` +
    // signExists BEFORE lowercase — the live child order (skeleton above, every
    // GET). Sent the other way round, A4H activated `ZAS_DOMA_V1` (DEC 13,3,
    // signExists true) with `signExists` stored FALSE and no message
    // (2026-09-16); the same body with signExists first kept it. The bench
    // body had both flags false, which is why its order never showed this.
    `<doma:outputInformation>${elem("doma:length", num(outputLength))}${elem("doma:signExists", String(signExists))}${elem("doma:lowercase", String(lowercase))}</doma:outputInformation>` +
    valueInformation +
    `</doma:content></doma:domain>`
  );
}

function buildDtel(name: string, description: string, packageName: string, f: DdicStructuredFields): string {
  const typeKind = f.typeKind ?? "predefinedAbapType";
  if (typeKind !== "domain" && typeKind !== "predefinedAbapType") {
    throw new AbapError(
      "BAD_INPUT",
      `ddic.typeKind "${typeKind}" is not valid for DTEL/DE — only "domain" or "predefinedAbapType" is grounded.`,
      { name, type: "DTEL/DE", typeKind },
      'Use "domain" or "predefinedAbapType", or compose raw XML via `source`.',
    );
  }
  const typeName = f.typeName ?? "";
  const dataType = f.dataType ?? "CHAR";
  const length = f.length ?? 10;
  const decimals = f.decimals ?? 0;
  // "Bench" is the literal label text from the body a live system accepted —
  // not a tasteful default, just what's grounded. Don't "improve" it without new evidence.
  const short = dtelLabel("short", f.shortLabel ?? "Bench", f.shortLength, name);
  const medium = dtelLabel("medium", f.mediumLabel ?? "Bench", f.mediumLength, name);
  const long = dtelLabel("long", f.longLabel ?? "Bench", f.longLength, name);
  const heading = dtelLabel("heading", f.headingLabel ?? "Bench", f.headingLength, name);
  if (f.searchHelpParameter !== undefined && f.searchHelp === undefined) {
    throw new AbapError(
      "BAD_INPUT",
      `ddic.searchHelpParameter was given without ddic.searchHelp for DTEL/DE ${name} — a parameter ` +
        "with no search help to belong to is meaningless: DD04L-SHLPFIELD has nothing to attach to " +
        "without DD04L-SHLPNAME, and the server would accept the write while silently dropping it.",
      { name, type: "DTEL/DE", searchHelpParameter: f.searchHelpParameter },
      "Add `ddic.searchHelp` (the search help name this parameter belongs to), or drop " +
        "`ddic.searchHelpParameter`.",
    );
  }
  const searchHelp = f.searchHelp !== undefined ? normalizeShlpIdentifier(f.searchHelp, "searchHelp", "DTEL/DE", name) : "";
  const searchHelpParameter =
    f.searchHelpParameter !== undefined
      ? normalizeShlpIdentifier(f.searchHelpParameter, "searchHelpParameter", "DTEL/DE", name)
      : "";
  return (
    `${XML_DECL}<blue:wbobj xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel" xmlns:adtcore="${ADTCORE_NS}" ` +
    `adtcore:name="${escapeXmlAttr(name)}" adtcore:type="DTEL/DE" adtcore:description="${escapeXmlAttr(description)}" ${ROOT_LANGUAGE_ATTRS}>` +
    `<adtcore:packageRef adtcore:name="${escapeXmlAttr(packageName)}"/>` +
    `<dtel:dataElement xmlns:dtel="${DATAELEMENT_NS}">` +
    `${elem("dtel:typeKind", typeKind)}${elem("dtel:typeName", typeName)}` +
    `${elem("dtel:dataType", dataType)}${elem("dtel:dataTypeLength", numPadded(length, 6))}${elem("dtel:dataTypeDecimals", numPadded(decimals, 6))}` +
    `${elem("dtel:shortFieldLabel", short.label)}${elem("dtel:shortFieldLength", numPadded(short.length, 2))}${elem("dtel:shortFieldMaxLength", num(DTEL_MAX_LENGTH.short))}` +
    `${elem("dtel:mediumFieldLabel", medium.label)}${elem("dtel:mediumFieldLength", numPadded(medium.length, 2))}${elem("dtel:mediumFieldMaxLength", num(DTEL_MAX_LENGTH.medium))}` +
    `${elem("dtel:longFieldLabel", long.label)}${elem("dtel:longFieldLength", numPadded(long.length, 2))}${elem("dtel:longFieldMaxLength", num(DTEL_MAX_LENGTH.long))}` +
    `${elem("dtel:headingFieldLabel", heading.label)}${elem("dtel:headingFieldLength", numPadded(heading.length, 2))}${elem("dtel:headingFieldMaxLength", num(DTEL_MAX_LENGTH.heading))}` +
    // Element identity, values and order (searchHelp, searchHelpParameter, setGetParameter,
    // defaultComponentName) are live-captured, not guessed: a raw read of DTEL/DE PBUNAM
    // (package SPAK_TOOL) on A4H (NetWeaver 7.54, client 001), 2026-09-15, returned inside
    // <dtel:dataElement> exactly `<dtel:searchHelp>USER_ADDR</dtel:searchHelp>
    // <dtel:searchHelpParameter>BNAME</dtel:searchHelpParameter>` in this order, and DD04L for
    // ROLLNAME='PBUNAM' holds SHLPNAME=USER_ADDR, SHLPFIELD=BNAME — so these two elements map to
    // those two catalog columns. The assembled write path has been sent live with these two
    // slots EMPTY (ZAS_DTEL_TEST / ZAS_DTEL_LBL, 2026-09-16); a non-empty search help through
    // `ddic` has not itself been sent to a live system.
    `${elem("dtel:searchHelp", searchHelp)}${elem("dtel:searchHelpParameter", searchHelpParameter)}${elem("dtel:setGetParameter", "")}${elem("dtel:defaultComponentName", "")}` +
    `${elem("dtel:deactivateInputHistory", "false")}${elem("dtel:changeDocument", "false")}` +
    `${elem("dtel:leftToRightDirection", "false")}${elem("dtel:deactivateBIDIFiltering", "false")}` +
    `</dtel:dataElement></blue:wbobj>`
  );
}

function buildTtyp(name: string, description: string, packageName: string, f: DdicStructuredFields): string {
  const typeKind = f.typeKind ?? "dictionaryType";
  if (typeKind !== "dictionaryType") {
    throw new AbapError(
      "BAD_INPUT",
      `ddic.typeKind "${typeKind}" is not valid for TTYP/DA — only "dictionaryType" is grounded. ` +
        `A live activation rejected "rangeTypeOnDataelement" rather than accepting it.`,
      { name, type: "TTYP/DA", typeKind },
      'Use "dictionaryType", or compose raw XML via `source`.',
    );
  }
  // "SYST" is the literal row type name from the body a live system accepted —
  // not a tasteful default, just what's grounded. Don't "improve" it without new evidence.
  const typeName = f.typeName ?? "SYST";
  const dataType = f.dataType ?? "STRU";
  const length = f.length ?? 0;
  const decimals = f.decimals ?? 0;
  return (
    `${XML_DECL}<ttyp:tableType xmlns:ttyp="http://www.sap.com/dictionary/tabletype" xmlns:adtcore="${ADTCORE_NS}" ` +
    `adtcore:name="${escapeXmlAttr(name)}" adtcore:type="TTYP/DA" adtcore:description="${escapeXmlAttr(description)}" ${ROOT_LANGUAGE_ATTRS}>` +
    `<adtcore:packageRef adtcore:name="${escapeXmlAttr(packageName)}"/>` +
    `<ttyp:rowType>` +
    `${elem("ttyp:typeKind", typeKind)}${elem("ttyp:typeName", typeName)}` +
    `<ttyp:builtInType>${elem("ttyp:dataType", dataType)}${elem("ttyp:length", numPadded(length, 6))}${elem("ttyp:decimals", numPadded(decimals, 6))}</ttyp:builtInType>` +
    `<ttyp:rangeType/>` +
    `</ttyp:rowType></ttyp:tableType>`
  );
}

/**
 * Builds a DOMA/DD, DTEL/DE, or TTYP/DA descriptor from `fields` instead of
 * hand-composed XML. Throws `AbapError("BAD_INPUT")` for any type outside
 * the three, or for a field that isn't grounded for `type` — see the
 * `*_FIELDS` sets above. Never writes anything; the caller sends the
 * returned string exactly as it would send hand-composed `source`, so it
 * still passes through {@link assertDdicDescriptorShape} downstream.
 */
export function buildStructuredDdicDescriptor(
  type: string,
  name: string,
  description: string,
  packageName: string,
  fields: DdicStructuredFields,
): string {
  const allowed = STRUCTURED_FIELDS_BY_TYPE[type];
  if (!allowed) {
    throw new AbapError(
      "BAD_INPUT",
      `\`ddic\` structured input only covers DOMA/DD, DTEL/DE, TTYP/DA — not ${type}.`,
      { name, type },
      "Drop `ddic` and compose raw XML via `source` for this type.",
    );
  }
  rejectStrayFields(type, name, fields, allowed);
  if (type === "DOMA/DD") return buildDoma(name, description, packageName, fields);
  if (type === "DTEL/DE") return buildDtel(name, description, packageName, fields);
  return buildTtyp(name, description, packageName, fields);
}
