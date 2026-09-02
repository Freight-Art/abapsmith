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
// (name/description/package aside). This builder has never itself been sent
// to a live system — unverified, like everything else this module builds
// until proven otherwise.

const ADTCORE_NS = "http://www.sap.com/adt/core";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

/** Flat, type-agnostic field surface for the three properties-shape DDIC types. Unset fields fall back to the bench-accepted literal for that slot. */
export interface DdicStructuredFields {
  dataType?: string;
  length?: number;
  decimals?: number;
  outputLength?: number;
  lowercase?: boolean;
  signExists?: boolean;
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

const DOMA_FIELDS: ReadonlySet<string> = new Set(["dataType", "length", "decimals", "outputLength", "lowercase", "signExists"]);
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

/** Zero-padded to `width` — DTEL's `dataTypeLength`/`dataTypeDecimals` and TTYP's `length`/`decimals` are `000010`-style in every attested body; DOMA's equivalent slots are not (`doma:length>10`, unpadded) and must keep using {@link num}. */
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
  const outputLength = f.outputLength ?? length;
  const lowercase = f.lowercase ?? false;
  const signExists = f.signExists ?? false;
  return (
    `${XML_DECL}<doma:domain xmlns:doma="http://www.sap.com/dictionary/domain" xmlns:adtcore="${ADTCORE_NS}" ` +
    `adtcore:name="${escapeXmlAttr(name)}" adtcore:type="DOMA/DD" adtcore:description="${escapeXmlAttr(description)}">` +
    `<adtcore:packageRef adtcore:name="${escapeXmlAttr(packageName)}"/>` +
    `<doma:content>` +
    `<doma:typeInformation>${elem("doma:datatype", dataType)}${elem("doma:length", num(length))}${elem("doma:decimals", num(decimals))}</doma:typeInformation>` +
    `<doma:outputInformation>${elem("doma:length", num(outputLength))}${elem("doma:lowercase", String(lowercase))}${elem("doma:signExists", String(signExists))}</doma:outputInformation>` +
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
  const shortLabel = f.shortLabel ?? "Bench";
  const shortLength = f.shortLength ?? 10;
  const mediumLabel = f.mediumLabel ?? "Bench";
  const mediumLength = f.mediumLength ?? 20;
  const longLabel = f.longLabel ?? "Bench";
  const longLength = f.longLength ?? 40;
  const headingLabel = f.headingLabel ?? "Bench";
  const headingLength = f.headingLength ?? 55;
  return (
    `${XML_DECL}<blue:wbobj xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel" xmlns:adtcore="${ADTCORE_NS}" ` +
    `adtcore:name="${escapeXmlAttr(name)}" adtcore:type="DTEL/DE" adtcore:description="${escapeXmlAttr(description)}">` +
    `<adtcore:packageRef adtcore:name="${escapeXmlAttr(packageName)}"/>` +
    `<dtel:dataElement xmlns:dtel="${DATAELEMENT_NS}">` +
    `${elem("dtel:typeKind", typeKind)}${elem("dtel:typeName", typeName)}` +
    `${elem("dtel:dataType", dataType)}${elem("dtel:dataTypeLength", numPadded(length, 6))}${elem("dtel:dataTypeDecimals", numPadded(decimals, 6))}` +
    `${elem("dtel:shortFieldLabel", shortLabel)}${elem("dtel:shortFieldLength", num(shortLength))}${elem("dtel:shortFieldMaxLength", num(DTEL_MAX_LENGTH.short))}` +
    `${elem("dtel:mediumFieldLabel", mediumLabel)}${elem("dtel:mediumFieldLength", num(mediumLength))}${elem("dtel:mediumFieldMaxLength", num(DTEL_MAX_LENGTH.medium))}` +
    `${elem("dtel:longFieldLabel", longLabel)}${elem("dtel:longFieldLength", num(longLength))}${elem("dtel:longFieldMaxLength", num(DTEL_MAX_LENGTH.long))}` +
    `${elem("dtel:headingFieldLabel", headingLabel)}${elem("dtel:headingFieldLength", num(headingLength))}${elem("dtel:headingFieldMaxLength", num(DTEL_MAX_LENGTH.heading))}` +
    `${elem("dtel:searchHelp", "")}${elem("dtel:searchHelpParameter", "")}${elem("dtel:setGetParameter", "")}${elem("dtel:defaultComponentName", "")}` +
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
    `adtcore:name="${escapeXmlAttr(name)}" adtcore:type="TTYP/DA" adtcore:description="${escapeXmlAttr(description)}">` +
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
