/**
 * ADT position-driven source intelligence: "what is this identifier", "where
 * is it declared", and "who implements this interface method" — three read-only
 * endpoints, no write.
 *
 *   1. `POST /sap/bc/adt/abapsource/codecompletion/elementinfo?uri=<sourceUri>
 *      #start=<line>,<column>`, body = the raw object source, headers
 *      `{"Content-Type":"text/plain","Accept":"application/*"}`. Answers
 *      `application/vnd.sap.adt.elementinfo+xml` — `abapsource:elementInfo`,
 *      described in {@link parseElementInfo}'s doc comment.
 *   2. `POST /sap/bc/adt/navigation/target?uri=<sourceUri>#start=L,C;end=L,C2
 *      &filter=definition`, same headers and body. Answers `application/xml`:
 *      a single `adtcore:objectReference adtcore:uri="…"` naming the
 *      declaration site — see {@link parseNavigationTarget}.
 *   3. `POST /sap/bc/adt/repository/informationsystem/usageReferences?uri=…`
 *      at an interface method's declaration — the implementing classes are
 *      among the rows it returns, see {@link implementationsFrom}. This IS
 *      reimplemented here (wire call in {@link findImplementations}, parsing
 *      in {@link parseUsageReferences}), not left to `abap-adt-api`'s own
 *      `conn.adt.usageReferences()`: that vendor function's answer-reading
 *      path is broken for this endpoint (hardcodes the capitalised
 *      `usageReferences:` namespace prefix; A4H sends the lowercase
 *      `usagereferences:` prefix throughout, fixture 961) and always returns
 *      an empty array against a real A4H response — live-confirmed 2026-09-15,
 *      see {@link parseUsageReferences}'s doc comment.
 *
 * Every wire fact below is measured against `test/fixtures/live-captured/`
 * 952-…-961-… (`i91-*`), not inferred from a spec — each fixture's `.meta.json` `note`
 * carries the corroborating detail. This module never calls
 * `setPrettyPrinterSetting` or anything else that mutates the server.
 *
 * Position convention (matches `range-edit.ts`'s header, load-bearing):
 * line 1-based, column 0-based UTF-16 code units.
 */
import { XMLParser } from "fast-xml-parser";
import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import { adtExceptionInfo, type ErrorContext, translateAdtError } from "./session.js";
import { PARSE_EXCERPT_MAX, truncateText } from "../truncate.js";

export interface SourcePosition {
  readonly line: number;
  readonly column: number;
}

export const ELEMENT_INFO_URL = "/sap/bc/adt/abapsource/codecompletion/elementinfo";
export const NAVIGATION_TARGET_URL = "/sap/bc/adt/navigation/target";
export const USAGE_REFERENCES_URL = "/sap/bc/adt/repository/informationsystem/usageReferences";
/** Both endpoints' `Accept` — fixtures 952-958. Their `Content-Type` is always `text/plain`, not this. */
export const ELEMENT_INFO_MEDIA_TYPE = "application/*";

const CONTENT_TYPE_TEXT_PLAIN = "text/plain";

// ------------------------------------------------------------------ parsing --

/**
 * One instance serves `elementInfo` and `objectReference` documents alike —
 * neither `isArray` predicate below can fire on the other's tags. Options
 * copied verbatim from `quickfix.ts`'s `quickfixXml` so attribute prefixing
 * and entity handling match the rest of the codebase; `trimValues:false` is
 * kept for the same reason it's kept there (harmless here, since nothing
 * parsed by this module carries load-bearing surrounding whitespace, but
 * consistency beats a narrower option set).
 *
 * `isArray` matches by trailing jpath segments rather than one fixed depth,
 * because `elementInfo` nests: a method/function-module parameter (952, 956)
 * or a structure component (954) is itself an `elementInfo`, and there is no
 * captured example of it nesting twice, but nothing rules it out. Matching
 * `"…elementInfo.elementInfo"` (not just `"elementInfo.elementInfo"`) keeps
 * that generic without also matching the document root, whose own jpath is
 * the bare string `"elementInfo"`.
 */
const elementInfoXml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  isArray: (_name, jpath, _isLeaf, isAttribute) =>
    !isAttribute &&
    typeof jpath === "string" &&
    (jpath.endsWith("properties.entry") ||
      jpath.endsWith("elementInfo.documentation") ||
      jpath.endsWith("elementInfo.elementInfo")),
});

/**
 * Where-used documents get their OWN parser instance rather than reusing
 * `elementInfoXml`: neither of that parser's `isArray` predicates can ever
 * fire on this document (it has no `properties.entry`, `elementInfo.documentation`
 * or `elementInfo.elementInfo` path), but a where-used answer DOES need
 * `referencedObject` array-coerced — a one-row answer must not collapse to a
 * bare object — which `elementInfoXml` does not do. `removeNSPrefix: true`
 * is the load-bearing option here: it is what makes {@link parseUsageReferences}
 * immune to A4H answering with the lowercase `usagereferences:` namespace
 * prefix while `abap-adt-api`'s own (broken) reader hardcodes the capitalised
 * `usageReferences:` — both collapse to the same unprefixed tag/attribute
 * names, so either spelling parses identically (see the two 961 tests in
 * `test/element-info-wire.test.ts` asserting exactly that).
 */
const usageReferencesXml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  isArray: (_name, jpath, _isLeaf, isAttribute) =>
    !isAttribute && typeof jpath === "string" && jpath.endsWith("referencedObjects.referencedObject"),
});

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : undefined;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function attr(node: Rec | undefined, name: string): string | undefined {
  const value = node?.[`@_${name}`];
  return typeof value === "string" ? value : undefined;
}

/** Element text: a bare string for an attribute-less leaf, `{"#text": …}` for one with attributes, `""` for self-closing — same three shapes `quickfix.ts`'s `elementText` handles (a self-closing `<entry key="abapType"/>`, fixture 954, is the case that matters here). */
function elementText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  const rec = asRecord(value);
  if (rec === undefined) return undefined;
  const text = rec["#text"];
  return typeof text === "string" ? text : "";
}

function parseXmlDocument(body: string, what: string, ctx: ErrorContext, parser: XMLParser = elementInfoXml): Rec {
  let parsed: unknown;
  try {
    parsed = parser.parse(body);
  } catch (e) {
    throw new AbapError(
      "ADT_ERROR",
      `The ${what} response could not be parsed as XML.`,
      { operation: ctx.operation, uri: ctx.uri, what, detail: e instanceof Error ? e.message : String(e) },
      "The server answered with something other than the expected document.",
    );
  }
  const rec = asRecord(parsed);
  if (rec === undefined) {
    throw new AbapError(
      "ADT_ERROR",
      `The ${what} response was empty or not a document.`,
      { operation: ctx.operation, uri: ctx.uri, what, length: body.length },
      "The server answered with something other than the expected document.",
    );
  }
  return rec;
}

/** One `abapsource:elementInfo` element, root or nested. */
export interface ElementInfoEntry {
  /** `adtcore:type`. Absent on a nested structure component (fixture 954). */
  readonly type?: string;
  /** `adtcore:name`. Absent ONLY on the "no element at this position" answer (960). */
  readonly name?: string;
  /** `abapsource:properties` as key → value. A self-closing entry maps to "". */
  readonly properties: Readonly<Record<string, string>>;
  /** `documentation rel="shorttext"`, plain text, entity-decoded. */
  readonly shortText?: string;
  /** `documentation rel="abapdoc"`, the raw HTML, entity-decoded once. */
  readonly abapDoc?: string;
  /** Nested `elementInfo`: method/FM parameters, or structure components. */
  readonly children: readonly ElementInfoEntry[];
}

/**
 * `<abapsource:properties/>` (fixture 957, a function module) parses to the
 * empty string, not a record — the same "childless self-closing tag is a
 * string" shape `quickfix.ts` documents for `<qf:evaluationResults/>` — so
 * `asRecord` returning `undefined` there is the legitimate empty-properties
 * case, not a parse failure. A present `<abapsource:entry key="…"/>` with no
 * text (954's `abapType` on `TY_ROW` itself) maps its key to `""`.
 */
function parseProperties(value: unknown): Record<string, string> {
  const rec = asRecord(value);
  if (rec === undefined) return {};
  const result: Record<string, string> = {};
  for (const raw of asArray(rec["entry"])) {
    const entryNode = asRecord(raw);
    const key = attr(entryNode, "key");
    if (key === undefined) continue;
    result[key] = elementText(raw) ?? "";
  }
  return result;
}

/** First `documentation` child whose `rel` matches, or `undefined` — an `elementInfo` node carries at most one of each `rel` in every captured fixture. */
function findDocumentation(node: Rec, rel: "shorttext" | "abapdoc"): string | undefined {
  for (const raw of asArray(node["documentation"])) {
    const docNode = asRecord(raw);
    if (attr(docNode, "rel") !== rel) continue;
    return elementText(raw) ?? "";
  }
  return undefined;
}

function parseElementInfoNode(raw: unknown): ElementInfoEntry {
  const node = asRecord(raw) ?? {};
  const type = attr(node, "type");
  const name = attr(node, "name");
  const shortText = findDocumentation(node, "shorttext");
  const abapDoc = findDocumentation(node, "abapdoc");
  const children = asArray(node["elementInfo"]).map(parseElementInfoNode);
  return {
    ...(type !== undefined ? { type } : {}),
    ...(name !== undefined ? { name } : {}),
    properties: parseProperties(node["properties"]),
    ...(shortText !== undefined ? { shortText } : {}),
    ...(abapDoc !== undefined ? { abapDoc } : {}),
    children,
  };
}

/** `<sourceUri>#start=<line>,<column>`. */
export function elementInfoFragmentUri(sourceUri: string, pos: SourcePosition): string {
  return `${sourceUri}#start=${pos.line},${pos.column}`;
}

/** The unresolved-position answer: `isUnresolved()` true, no children, no name/type. Returned, never thrown, for both shapes {@link hasNoElementAtAll} recognises. */
const UNRESOLVED_ELEMENT_INFO: ElementInfoEntry = { properties: {}, children: [] };

/**
 * True when a parsed elementinfo document carries no `<abapsource:elementInfo>`
 * element AT ALL — as opposed to one with a *different*, unrecognised root
 * element, which is still a real parse failure and must still throw.
 *
 * Two live shapes collapse to this:
 *  - an empty (`""`) or whitespace-only body — live-confirmed 2026-09-15
 *    against A4H, `/sap/bc/adt/oo/classes/cl_abap_typedescr/source/main
 *    #start=6,0` (a blank line): HTTP 200, a ZERO-BYTE body (`byteLength: 0`,
 *    sha256 of the empty string). No fixture file exists for this one —
 *    there are no bytes to pin — the same reason the repo already has no
 *    capture 898.
 *  - a body that parses to a document whose only keys are the XML
 *    declaration (`"?xml"`) and/or a whitespace-only `"#text"` — i.e. a
 *    declaration with no element after it at all, e.g.
 *    `'<?xml version="1.0" encoding="utf-8"?>'` on its own.
 *
 * Deliberately narrow: a document with a real, different root (an
 * `<exc:exception>` envelope, say) has OTHER keys besides `?xml`/`#text`, so
 * this returns `false` for it and `parseElementInfo` still throws — this
 * function's whole job is telling "nothing was sent" apart from "something
 * else was sent", not softening every missing-root case into an answer.
 */
function hasNoElementAtAll(body: string, doc: Rec): boolean {
  if (body.trim() === "") return true;
  return Object.keys(doc).every((key) => {
    if (key === "?xml") return true;
    if (key === "#text") return typeof doc[key] !== "string" || (doc[key] as string).trim() === "";
    return false;
  });
}

/**
 * Parses an elementinfo document. Throws `AbapError` on unparseable XML
 * (excerpt-truncated, like `quickfix.ts`'s `missingRoot`), or on a document
 * with some OTHER, unrecognised root element — but NOT on either of the two
 * "nothing resolvable here" shapes: fixture 960's well-formed, nameless
 * `<abapsource:elementInfo>`, or a zero-byte/declaration-only 200 body (see
 * {@link hasNoElementAtAll}). Both answer {@link UNRESOLVED_ELEMENT_INFO} (or
 * the 960 shape's own parsed equivalent), not a throw; see {@link isUnresolved}.
 */
export function parseElementInfo(xml: string, ctx: ErrorContext): ElementInfoEntry {
  const doc = parseXmlDocument(xml, "element info", ctx);
  const rootValue = doc["elementInfo"];
  if (rootValue === undefined) {
    if (hasNoElementAtAll(xml, doc)) return UNRESOLVED_ELEMENT_INFO;
    throw new AbapError(
      "ADT_ERROR",
      `The element info response has no <abapsource:elementInfo> element.`,
      { operation: ctx.operation, uri: ctx.uri, preview: truncateText(xml, PARSE_EXCERPT_MAX) },
      "This ADT release may answer element info differently from what this client expects.",
    );
  }
  return parseElementInfoNode(rootValue);
}

/**
 * True when the server resolved nothing at that position — no `adtcore:name`
 * on the (possibly synthetic) root. Two shapes reach here, both HTTP 200:
 * fixture 960's well-formed `<abapsource:elementInfo>` with no `adtcore:name`
 * (a blank-ish position that still names an element context), and a
 * zero-byte/declaration-only body (live-confirmed 2026-09-15, a genuinely
 * blank line — see {@link hasNoElementAtAll}), which `parseElementInfo` maps
 * to the same nameless, childless entry rather than throwing.
 */
export function isUnresolved(info: ElementInfoEntry): boolean {
  return info.name === undefined;
}

/**
 * Wire fetch: posts the whole object source (never a snippet — matches
 * `evaluateQuickFixes`'s convention in `quickfix.ts`) and parses the answer.
 * `Content-Type: text/plain` + `Accept: application/*` on both this and
 * {@link findDefinitionTarget} — fixtures 952-960.
 */
export async function fetchElementInfo(
  conn: AbapConnection,
  sourceUri: string,
  pos: SourcePosition,
  source: string,
): Promise<ElementInfoEntry> {
  const ctx: ErrorContext = { operation: "element info", uri: sourceUri };
  let body: string;
  try {
    ({ body } = await conn.post(ELEMENT_INFO_URL, {
      headers: { "Content-Type": CONTENT_TYPE_TEXT_PLAIN, Accept: ELEMENT_INFO_MEDIA_TYPE },
      qs: { uri: elementInfoFragmentUri(sourceUri, pos) },
      body: source,
    }));
  } catch (e) {
    throw translateAdtError(e, ctx);
  }
  return parseElementInfo(body, ctx);
}

// --------------------------------------------------------------- navigation --

export interface DefinitionTarget {
  /** The object/source URI, fragment stripped. */
  readonly uri: string;
  /** 1-based, from the `#start=` fragment when present. */
  readonly line?: number;
  /** 0-based, same fragment. */
  readonly column?: number;
}

const FRAGMENT_RE = /^(.*)#start=(\d+),(\d+)(?:;end=\d+,\d+)?$/;

/** Splits an `…/source/main#start=8,10` URI (fixture 958). Returns `{uri}` alone when there is no fragment. */
export function splitFragmentUri(uri: string): DefinitionTarget {
  const m = FRAGMENT_RE.exec(uri);
  if (!m) return { uri };
  return { uri: m[1]!, line: Number(m[2]), column: Number(m[3]) };
}

/**
 * Parses `adtcore:objectReference`. `undefined` when the document names no
 * target — an `<adtcore:objectReference/>` with no `adtcore:uri`. NOT the
 * same as a missing/wrong root element, which is a parse failure (thrown),
 * since every captured answer (958) carries the root; only the *attribute*
 * naming the target is documented as ever being absent.
 */
export function parseNavigationTarget(xml: string, ctx: ErrorContext): DefinitionTarget | undefined {
  const doc = parseXmlDocument(xml, "navigation target", ctx);
  const rootValue = doc["objectReference"];
  if (rootValue === undefined) {
    throw new AbapError(
      "ADT_ERROR",
      `The navigation target response has no <adtcore:objectReference> element.`,
      { operation: ctx.operation, uri: ctx.uri, preview: truncateText(xml, PARSE_EXCERPT_MAX) },
      "This ADT release may answer navigation targets differently from what this client expects.",
    );
  }
  const uri = attr(asRecord(rootValue), "uri");
  return uri === undefined ? undefined : splitFragmentUri(uri);
}

/**
 * Live-observed but uncaptured (no response body saved): `filter=implementation`
 * on an interface-method call raised an ADT error whose message was exactly
 * "Navigation target undecidable: More than one implementation exists" — SAP
 * declining to name a target rather than answering an empty document. Matched
 * on this one phrase, corroborating-only in spirit but the only evidence that
 * exists for it; not extended to any other ADT_ERROR text since none of those
 * are known to mean "no target", only "something else went wrong". Still the
 * only evidence for tier 3 of {@link noTargetReasonFor} below: unlike the
 * ED263 capture, this exception was never dumped with its `.properties`, so
 * there is no T100 key to match on instead.
 *
 * Compare the OTHER, fully-captured "no target" shape, live-confirmed
 * 2026-09-15 against A4H at `/sap/bc/adt/oo/classes/cl_abap_typedescr/source
 * /main#start=21,7;end=21,20` (`  data ABSOLUTE_NAME type ABAP_ABSTYPENAME
 * read-only .`), reproduced identically at lines 23 and 27 — a position that
 * IS a variable's own declaration:
 *   - constructor `AdtErrorException`, `err: 400`
 *   - `type: "NavigationFailure"`, `namespace: "com.sap.adt"`
 *   - `properties: { "T100KEY-ID": "ED", "T100KEY-NO": "263" }`
 *   - `message`/`localizedMessage`: "Definition location found; where-used
 *     list may be possible"
 *   - no response body at all
 * That one IS matched on the T100 key (`noTargetReasonFor`'s tier 1), not on
 * this message text, per this repo's own rule (`isLockConflict`'s doc
 * comment in `session.ts`: "match on T100KEY, never on prose") — the message
 * string is capture-specific prose with no guarantee of surviving an ADT
 * patch, the T100 key is the stable identifier SAP itself assigns the
 * message class/number.
 */
const NAVIGATION_UNDECIDABLE_RE = /undecidable/i;

/** Why ADT declined to name a navigation target. */
export type NoTargetReason = "declaration-itself" | "undecidable" | "unnamed";

/** Result of the navigation-target lookup: a target, or the reason there is none. */
export interface NavigationLookup {
  readonly target?: DefinitionTarget;
  readonly noTargetReason?: NoTargetReason;
}

/**
 * Classifies a thrown navigation-target exception as a known "no target"
 * shape, or `undefined` if it is not one (caller must rethrow `translated`
 * in that case — this function never decides that something should be
 * swallowed, only what it means when {@link findDefinitionTarget} already
 * decided to).
 *
 * Tiers, in order, each corroborating a distinct piece of live evidence (see
 * {@link NAVIGATION_UNDECIDABLE_RE}'s doc comment for both captures in full):
 *   1. `T100KEY-ID: "ED"` + `T100KEY-NO: "263"` on the raw exception — the
 *      live-captured ED263 key, the strongest evidence here.
 *   1b. `T100KEY-ID: "SEDI_ADT"` + `T100KEY-NO: "2"`, or
 *      `type === "ExceptionMultipleNavigationTargets"` — the live-captured
 *      shape (A4H, 2026-09-15, HTTP 422) of "more than one implementation"
 *      at an interface method's own declaration; also not prose-matching.
 *   2. `type === "NavigationFailure"` AND the translated message matches
 *      {@link NAVIGATION_UNDECIDABLE_RE} — the type corroborates the message
 *      when both happen to be available.
 *   3. The translated message alone matches {@link NAVIGATION_UNDECIDABLE_RE}
 *      when no type is available to corroborate with — this is the
 *      "undecidable" case's ENTIRE evidence (see above), so this tier keeps
 *      `findDefinitionTarget`'s original message-only behaviour intact for
 *      it rather than tightening it into requiring a type this exception was
 *      never observed carrying.
 * Anything else returns `undefined`, and the caller rethrows.
 */
export function noTargetReasonFor(e: unknown, translated: AbapError): NoTargetReason | undefined {
  const info = adtExceptionInfo(e);
  if (info?.properties["T100KEY-ID"] === "ED" && info.properties["T100KEY-NO"] === "263") {
    return "declaration-itself";
  }
  // Live-captured 2026-09-15 against A4H at an interface's own `METHODS run`
  // declaration with two implementing classes: `err: 422`,
  // `type: "ExceptionMultipleNavigationTargets"`, `properties:
  // {"T100KEY-ID": "SEDI_ADT", "T100KEY-NO": "2"}`, message "Navigation
  // target undecidable: More than one implementation exists". Keyed on the
  // T100 key, like ED263; the type is corroborating only.
  if (info?.properties["T100KEY-ID"] === "SEDI_ADT" && info.properties["T100KEY-NO"] === "2") {
    return "undecidable";
  }
  if (info?.type === "ExceptionMultipleNavigationTargets") {
    return "undecidable";
  }
  if (info?.type === "NavigationFailure" && NAVIGATION_UNDECIDABLE_RE.test(translated.message)) {
    return "undecidable";
  }
  if (info?.type === undefined && NAVIGATION_UNDECIDABLE_RE.test(translated.message)) {
    return "undecidable";
  }
  return undefined;
}

/**
 * `filter=definition` only — `filter=implementation` is unusable for an
 * interface method (see {@link NAVIGATION_UNDECIDABLE_RE}'s doc comment);
 * {@link findImplementations} is the where-used-based replacement for that
 * case. A `noTargetReason` result (no `target`) means ADT declined to name a
 * target, which is a fact about the position, not a failure — everything
 * else still throws. Three ways that happens:
 *   - `parseNavigationTarget` returned `undefined` (root present, no
 *     `adtcore:uri`) → `"unnamed"`.
 *   - the wire call itself threw ED263 ("you are already at the
 *     declaration") → `"declaration-itself"`.
 *   - the wire call threw the "undecidable" shape → `"undecidable"`.
 * See {@link noTargetReasonFor} for how the thrown-exception cases are told
 * apart.
 */
export async function findDefinitionTarget(
  conn: AbapConnection,
  sourceUri: string,
  range: { readonly line: number; readonly startColumn: number; readonly endColumn: number },
  source: string,
): Promise<NavigationLookup> {
  const ctx: ErrorContext = { operation: "navigation target", uri: sourceUri };
  const fragment = `${sourceUri}#start=${range.line},${range.startColumn};end=${range.line},${range.endColumn}`;
  let body: string;
  try {
    ({ body } = await conn.post(NAVIGATION_TARGET_URL, {
      headers: { "Content-Type": CONTENT_TYPE_TEXT_PLAIN, Accept: ELEMENT_INFO_MEDIA_TYPE },
      qs: { uri: fragment, filter: "definition" },
      body: source,
    }));
  } catch (e) {
    const translated = translateAdtError(e, ctx);
    const noTargetReason = noTargetReasonFor(e, translated);
    if (noTargetReason !== undefined) return { noTargetReason };
    throw translated;
  }
  const target = parseNavigationTarget(body, ctx);
  return target !== undefined ? { target } : { noTargetReason: "unnamed" };
}

// -------------------------------------------------------------- identifiers --

/** ABAP identifier characters, including the two this codebase's other tokenisers tend to forget: `~` (interface component selector, e.g. `zif_x~process`) and `/` (namespace delimiter, e.g. `/namespace/obj`). */
const ABAP_IDENTIFIER_CHAR = /[A-Za-z0-9_/~]/;

/** The ABAP identifier token covering `column`, for building the navigation range. `undefined` when the position is not on an identifier, or the line does not exist. Pure and offline — no relation to `range-edit.ts`'s line splitting beyond sharing its line/column convention; this function only reads, so it uses a plain `\r\n|\n` split rather than that module's "phantom last line" bookkeeping. */
export function identifierAt(
  source: string,
  pos: SourcePosition,
): { readonly text: string; readonly startColumn: number; readonly endColumn: number } | undefined {
  if (!Number.isInteger(pos.line) || pos.line < 1) return undefined;
  const lineText = source.split(/\r\n|\n/)[pos.line - 1];
  if (lineText === undefined) return undefined;
  if (!Number.isInteger(pos.column) || pos.column < 0 || pos.column >= lineText.length) return undefined;
  if (!ABAP_IDENTIFIER_CHAR.test(lineText[pos.column]!)) return undefined;

  let start = pos.column;
  while (start > 0 && ABAP_IDENTIFIER_CHAR.test(lineText[start - 1]!)) start--;
  let end = pos.column + 1;
  while (end < lineText.length && ABAP_IDENTIFIER_CHAR.test(lineText[end]!)) end++;

  return { text: lineText.slice(start, end), startColumn: start, endColumn: end };
}

// ------------------------------------------------------------ implementers --

export interface ImplementingMethod {
  readonly className: string;
  /** The implementing component, e.g. `ZIF_I91_PROBE~PROCESS`. */
  readonly methodName: string;
  /** The row's own `uri`, verbatim. */
  readonly uri: string;
  readonly packageName?: string;
}

function recordString(rec: Rec, key: string): string | undefined {
  const value = rec[key];
  return typeof value === "string" ? value : undefined;
}

/** Last non-empty path segment, uppercased — a fallback only used when no sibling row names the class (see {@link implementationsFrom}); not itself confirmed against a live capture, since fixture 961 always has that sibling row. */
function classNameFromUri(uri: string | undefined): string | undefined {
  if (uri === undefined) return undefined;
  const segments = uri.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  return last ? last.toUpperCase() : undefined;
}

/**
 * Byte-for-byte the body `abap-adt-api@8.4.1`'s own `usageReferences`
 * function sends (`node_modules/abap-adt-api/build/api/syntax.js`) and that
 * fixture 961's capture actually used — 229 bytes, confirmed against that
 * fixture's own `.meta.json` `requestBodyBytes`. Reproduced verbatim,
 * including the vendor's own odd indentation (two then four then two
 * spaces): the SERVER accepts this shape fine (fixture 961 got a 200 back
 * from it), so only the vendor's READ of the answer is wrong, not this
 * request. The lowercase `usagereferences` prefix here is irrelevant to
 * whether the server understands it — {@link parseUsageReferences} parses
 * the ANSWER prefix-agnostically regardless of what this request declares.
 */
const USAGE_REFERENCES_REQUEST_BODY = `<?xml version="1.0" encoding="ASCII"?>
  <usagereferences:usageReferenceRequest xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences">
    <usagereferences:affectedObjects/>
  </usagereferences:usageReferenceRequest>`;

/**
 * Parses a where-used (`usageReferences`) answer into the flat row shape
 * {@link implementationsFrom} expects and that `abap-adt-api`'s own
 * `usageReferences()` used to be the sole source of. Reimplemented here
 * because that vendor function's answer-reading path is broken for this
 * endpoint: it looks up the document via the hardcoded, case-sensitive path
 * `"usageReferences:usageReferenceResult" / "usageReferences:referencedObjects"
 * / "usageReferences:referencedObject"` (capital `R`), but A4H's actual wire
 * bytes declare and use the lowercase prefix `usagereferences` throughout —
 * `xmlns:usagereferences=` and every `<usagereferences:…>` tag (fixture 961).
 * Fed fixture 961 directly, that vendor function returns an EMPTY array, not
 * the two implementers the fixture carries (confirmed with a throwaway
 * script against the installed package) — live-confirmed as the root cause
 * of `abap_read`'s "no implementing classes found" answer 2026-09-15 against
 * `ZCL_V91_PROBE`, which does have two implementers.
 *
 * `usageReferencesXml`'s `removeNSPrefix: true` is what makes this immune to
 * either prefix spelling: both `usagereferences:referencedObject` and the
 * vendor's expected `usageReferences:referencedObject` collapse to the same
 * unprefixed `referencedObject` tag, and `adtcore:name` collapses to the
 * attribute `@_name` regardless of which element declared the `adtcore`
 * prefix. See the two 961 tests in `test/element-info-wire.test.ts` that
 * feed both spellings through this function and assert identical rows.
 *
 * Root (`usageReferenceResult`) missing ⇒ throws `AbapError("ADT_ERROR", …)`,
 * same convention as {@link parseElementInfo} / {@link parseNavigationTarget}.
 * Root present but `referencedObjects` absent or empty ⇒ `[]` — a legitimate
 * "nothing uses this" answer, not a failure.
 */
export function parseUsageReferences(xml: string, ctx: ErrorContext): Record<string, unknown>[] {
  const doc = parseXmlDocument(xml, "usage references", ctx, usageReferencesXml);
  const rootValue = doc["usageReferenceResult"];
  if (rootValue === undefined) {
    throw new AbapError(
      "ADT_ERROR",
      `The usage references response has no <usagereferences:usageReferenceResult> element.`,
      { operation: ctx.operation, uri: ctx.uri, preview: truncateText(xml, PARSE_EXCERPT_MAX) },
      "This ADT release may answer where-used differently from what this client expects.",
    );
  }
  const root = asRecord(rootValue);
  const referencedObjects = asRecord(root?.["referencedObjects"]);
  if (referencedObjects === undefined) return [];

  const rows: Record<string, unknown>[] = [];
  for (const raw of asArray(referencedObjects["referencedObject"])) {
    const row = asRecord(raw);
    if (row === undefined) continue;
    const adtObject = asRecord(row["adtObject"]) ?? {};
    const packageRefNode = asRecord(adtObject["packageRef"]);
    const packageRef: Record<string, unknown> = {};
    const packageName = attr(packageRefNode, "name");
    const packageUri = attr(packageRefNode, "uri");
    const packageType = attr(packageRefNode, "type");
    if (packageName !== undefined) packageRef["adtcore:name"] = packageName;
    if (packageUri !== undefined) packageRef["adtcore:uri"] = packageUri;
    if (packageType !== undefined) packageRef["adtcore:type"] = packageType;

    const rowUri = attr(row, "uri");
    const parentUri = attr(row, "parentUri");
    const adtName = attr(adtObject, "name");
    const adtType = attr(adtObject, "type");

    rows.push({
      ...(rowUri !== undefined ? { uri: rowUri } : {}),
      ...(parentUri !== undefined ? { parentUri } : {}),
      ...(adtName !== undefined ? { "adtcore:name": adtName } : {}),
      ...(adtType !== undefined ? { "adtcore:type": adtType } : {}),
      packageRef,
      objectIdentifier: elementText(row["objectIdentifier"]) ?? "",
    });
  }
  return rows;
}

/**
 * Implementing classes of an interface method, read off a where-used result.
 * Pure — takes the parsed rows {@link parseUsageReferences} produces
 * (structurally an index-signature record: `uri`, `parentUri`,
 * `"adtcore:name"`, `"adtcore:type"`, `packageRef: {"adtcore:name": string,
 * …}` — the same flat shape `abap-adt-api`'s own, but broken, `usageReferences()`
 * used to be the sole source of, per its `syntax.js`) so it is testable
 * without a wire. UNCHANGED by the switch away from that vendor function:
 * only where the rows come from moved, not their shape.
 *
 * A row is an implementer, not a caller, exactly when its own
 * `"adtcore:name"` equals `<INTERFACE>~<METHOD>` (case-insensitively) —
 * fixture 961: two rows share that name (`ZCL_I91_PROBE`,
 * `ZCL_I91_PROBE2`), while the row named plainly `RUN` is a caller. Grouping
 * rows (`CLAS/OC`, `DEVC/K`) never match this shape, so no separate type
 * check is needed to exclude them.
 *
 * `className` is read off the SIBLING row whose own `uri` equals this row's
 * `parentUri` — that sibling is the class's own `referencedObject` entry
 * (fixture 961: `uri="/sap/bc/adt/oo/classes/zcl_i91_probe"`, `"adtcore:name":
 * "ZCL_I91_PROBE"`) and carries the real-cased name; the implementer row
 * itself never does. `classNameFromUri`'s path-segment fallback only fires
 * if that sibling is ever missing, which has not been observed live.
 */
export function implementationsFrom(
  refs: readonly Record<string, unknown>[],
  interfaceName: string,
  methodName: string,
): ImplementingMethod[] {
  const wanted = `${interfaceName}~${methodName}`.toUpperCase();

  const nameByUri = new Map<string, string>();
  for (const ref of refs) {
    const uri = recordString(ref, "uri");
    const name = recordString(ref, "adtcore:name");
    if (uri !== undefined && name !== undefined) nameByUri.set(uri, name);
  }

  const results: ImplementingMethod[] = [];
  for (const ref of refs) {
    const name = recordString(ref, "adtcore:name");
    if (name === undefined || name.toUpperCase() !== wanted) continue;
    const uri = recordString(ref, "uri");
    if (uri === undefined) continue;
    const parentUri = recordString(ref, "parentUri");
    const className = (parentUri !== undefined ? nameByUri.get(parentUri) : undefined) ?? classNameFromUri(parentUri);
    if (className === undefined) continue;

    const packageRefValue = ref["packageRef"];
    const packageRef = asRecord(packageRefValue);
    const packageName = packageRef !== undefined ? recordString(packageRef, "adtcore:name") : undefined;

    results.push({
      className,
      methodName: name,
      uri,
      ...(packageName !== undefined ? { packageName } : {}),
    });
  }
  return results;
}

/**
 * Where-used at the interface method's declaration, filtered to implementers.
 * DELIBERATELY UNBOUNDED like `whereUsed` in `src/tools/search.ts` — ADT's
 * `usageReferences` endpoint ignores every limit parameter. Returns the fetch
 * wall-clock so the caller can disclose the cost — fixture 961's own capture
 * took nearly 10 seconds for a two-implementer toy example.
 *
 * Does the wire call itself (`conn.post`, exactly like {@link findDefinitionTarget}),
 * rather than going through `conn.adt.usageReferences()` — see
 * {@link parseUsageReferences}'s doc comment for why that vendor function's
 * answer-reading path cannot be trusted here.
 *
 * This also retires a quirk that used to live in this doc comment: the
 * vendor wrapper built its position fragment as `line && column ? … : url`,
 * so a `pos.column` of exactly `0` was falsy and silently degraded that call
 * to an unscoped, whole-object where-used — a bug this module could not work
 * around while the wire call belonged to a dependency it didn't own. Now
 * that the call is made here (`fragment` below, built with `pos !==
 * undefined`, never a truthiness check), that quirk is simply gone: column 0
 * is a normal, fully-scoped position like any other.
 */
export async function findImplementations(
  conn: AbapConnection,
  interfaceSourceUri: string,
  pos: SourcePosition | undefined,
  interfaceName: string,
  methodName: string,
): Promise<{ readonly implementations: ImplementingMethod[]; readonly fetchMs: number; readonly totalReferences: number }> {
  const ctx: ErrorContext = {
    operation: "usage references",
    uri: interfaceSourceUri,
    name: `${interfaceName}~${methodName}`,
  };
  const fragment = pos !== undefined ? `${interfaceSourceUri}#start=${pos.line},${pos.column}` : interfaceSourceUri;
  const startedAt = Date.now();
  let body: string;
  try {
    ({ body } = await conn.post(USAGE_REFERENCES_URL, {
      headers: { "Content-Type": "application/*", Accept: "application/*" },
      qs: { uri: fragment },
      body: USAGE_REFERENCES_REQUEST_BODY,
    }));
  } catch (e) {
    throw translateAdtError(e, ctx);
  }
  const fetchMs = Date.now() - startedAt;
  const refs = parseUsageReferences(body, ctx);
  return {
    implementations: implementationsFrom(refs, interfaceName, methodName),
    fetchMs,
    totalReferences: refs.length,
  };
}
