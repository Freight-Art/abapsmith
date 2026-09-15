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
 *   3. `usageReferences` (via `conn.adt.usageReferences`, `abap-adt-api`'s own
 *      wire client, not reimplemented here) at an interface method's
 *      declaration — the implementing classes are among the rows it returns,
 *      see {@link implementationsFrom}.
 *
 * Every wire fact below is measured against `test/fixtures/live-captured/`
 * 891-…-900-… (`i91-*`), not inferred from a spec — each fixture's `.meta.json` `note`
 * carries the corroborating detail. This module never calls
 * `setPrettyPrinterSetting` or anything else that mutates the server.
 *
 * Position convention (matches `range-edit.ts`'s header, load-bearing):
 * line 1-based, column 0-based UTF-16 code units.
 */
import { XMLParser } from "fast-xml-parser";
import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import { type ErrorContext, translateAdtError } from "./session.js";
import { PARSE_EXCERPT_MAX, truncateText } from "../truncate.js";

export interface SourcePosition {
  readonly line: number;
  readonly column: number;
}

export const ELEMENT_INFO_URL = "/sap/bc/adt/abapsource/codecompletion/elementinfo";
export const NAVIGATION_TARGET_URL = "/sap/bc/adt/navigation/target";
/** Both endpoints' `Accept` — fixtures 891-897. Their `Content-Type` is always `text/plain`, not this. */
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
 * because `elementInfo` nests: a method/function-module parameter (891, 895)
 * or a structure component (893) is itself an `elementInfo`, and there is no
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

/** Element text: a bare string for an attribute-less leaf, `{"#text": …}` for one with attributes, `""` for self-closing — same three shapes `quickfix.ts`'s `elementText` handles (a self-closing `<entry key="abapType"/>`, fixture 893, is the case that matters here). */
function elementText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  const rec = asRecord(value);
  if (rec === undefined) return undefined;
  const text = rec["#text"];
  return typeof text === "string" ? text : "";
}

function parseXmlDocument(body: string, what: string, ctx: ErrorContext): Rec {
  let parsed: unknown;
  try {
    parsed = elementInfoXml.parse(body);
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
  /** `adtcore:type`. Absent on a nested structure component (fixture 893). */
  readonly type?: string;
  /** `adtcore:name`. Absent ONLY on the "no element at this position" answer (899). */
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
 * `<abapsource:properties/>` (fixture 896, a function module) parses to the
 * empty string, not a record — the same "childless self-closing tag is a
 * string" shape `quickfix.ts` documents for `<qf:evaluationResults/>` — so
 * `asRecord` returning `undefined` there is the legitimate empty-properties
 * case, not a parse failure. A present `<abapsource:entry key="…"/>` with no
 * text (893's `abapType` on `TY_ROW` itself) maps its key to `""`.
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

/**
 * Parses an elementinfo document. Throws `AbapError` on unparseable XML
 * (excerpt-truncated, like `quickfix.ts`'s `missingRoot`) — but NOT on a
 * resolved-to-nothing answer (899), which is a well-formed
 * `<abapsource:elementInfo>` with no `adtcore:name`; see {@link isUnresolved}.
 */
export function parseElementInfo(xml: string, ctx: ErrorContext): ElementInfoEntry {
  const doc = parseXmlDocument(xml, "element info", ctx);
  const rootValue = doc["elementInfo"];
  if (rootValue === undefined) {
    throw new AbapError(
      "ADT_ERROR",
      `The element info response has no <abapsource:elementInfo> element.`,
      { operation: ctx.operation, uri: ctx.uri, preview: truncateText(xml, PARSE_EXCERPT_MAX) },
      "This ADT release may answer element info differently from what this client expects.",
    );
  }
  return parseElementInfoNode(rootValue);
}

/** True when the server resolved nothing at that position (no `adtcore:name`) — fixture 899, HTTP 200 either way. */
export function isUnresolved(info: ElementInfoEntry): boolean {
  return info.name === undefined;
}

/**
 * Wire fetch: posts the whole object source (never a snippet — matches
 * `evaluateQuickFixes`'s convention in `quickfix.ts`) and parses the answer.
 * `Content-Type: text/plain` + `Accept: application/*` on both this and
 * {@link findDefinitionTarget} — fixtures 891-899.
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

/** Splits an `…/source/main#start=8,10` URI (fixture 897). Returns `{uri}` alone when there is no fragment. */
export function splitFragmentUri(uri: string): DefinitionTarget {
  const m = FRAGMENT_RE.exec(uri);
  if (!m) return { uri };
  return { uri: m[1]!, line: Number(m[2]), column: Number(m[3]) };
}

/**
 * Parses `adtcore:objectReference`. `undefined` when the document names no
 * target — an `<adtcore:objectReference/>` with no `adtcore:uri`. NOT the
 * same as a missing/wrong root element, which is a parse failure (thrown),
 * since every captured answer (897) carries the root; only the *attribute*
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
 * are known to mean "no target", only "something else went wrong".
 */
const NAVIGATION_UNDECIDABLE_RE = /undecidable/i;

/**
 * `filter=definition` only — `filter=implementation` is unusable for an
 * interface method (see {@link NAVIGATION_UNDECIDABLE_RE}'s doc comment);
 * {@link findImplementations} is the where-used-based replacement for that
 * case. `undefined` when ADT declines to name a target, which is a fact
 * about the position, not a failure — everything else still throws.
 */
export async function findDefinitionTarget(
  conn: AbapConnection,
  sourceUri: string,
  range: { readonly line: number; readonly startColumn: number; readonly endColumn: number },
  source: string,
): Promise<DefinitionTarget | undefined> {
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
    if (NAVIGATION_UNDECIDABLE_RE.test(translated.message)) return undefined;
    throw translated;
  }
  return parseNavigationTarget(body, ctx);
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

/** Last non-empty path segment, uppercased — a fallback only used when no sibling row names the class (see {@link implementationsFrom}); not itself confirmed against a live capture, since fixture 900 always has that sibling row. */
function classNameFromUri(uri: string | undefined): string | undefined {
  if (uri === undefined) return undefined;
  const segments = uri.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  return last ? last.toUpperCase() : undefined;
}

/**
 * Implementing classes of an interface method, read off a where-used result.
 * Pure — takes the parsed rows (`conn.adt.usageReferences()`'s own
 * `UsageReference[]`, structurally an index-signature record: `uri`,
 * `parentUri`, `"adtcore:name"`, `"adtcore:type"`, `packageRef: {"adtcore:name":
 * string, …}`, per `abap-adt-api`'s `syntax.js`) so it is testable without a
 * wire.
 *
 * A row is an implementer, not a caller, exactly when its own
 * `"adtcore:name"` equals `<INTERFACE>~<METHOD>` (case-insensitively) —
 * fixture 900: two rows share that name (`ZCL_I91_PROBE`,
 * `ZCL_I91_PROBE2`), while the row named plainly `RUN` is a caller. Grouping
 * rows (`CLAS/OC`, `DEVC/K`) never match this shape, so no separate type
 * check is needed to exclude them.
 *
 * `className` is read off the SIBLING row whose own `uri` equals this row's
 * `parentUri` — that sibling is the class's own `referencedObject` entry
 * (fixture 900: `uri="/sap/bc/adt/oo/classes/zcl_i91_probe"`, `"adtcore:name":
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
 * wall-clock so the caller can disclose the cost — fixture 900's own capture
 * took nearly 10 seconds for a two-implementer toy example.
 *
 * Quirk read off `abap-adt-api`'s `syntax.js` (not wire-verified, since no
 * capture exercises it): the vendor wrapper builds the position fragment as
 * `line && column ? … : url`, so a `pos.column` of exactly `0` is falsy and
 * silently degrades this call to an unscoped, whole-object where-used. This
 * module cannot work around a check inside a dependency it doesn't own; a
 * declaration at column 0 is the one position `pos` should be avoided for.
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
  const startedAt = Date.now();
  let refs: readonly Record<string, unknown>[];
  try {
    const raw =
      pos !== undefined
        ? await conn.adt.usageReferences(interfaceSourceUri, pos.line, pos.column)
        : await conn.adt.usageReferences(interfaceSourceUri);
    refs = raw as unknown as readonly Record<string, unknown>[];
  } catch (e) {
    throw translateAdtError(e, ctx);
  }
  const fetchMs = Date.now() - startedAt;
  return {
    implementations: implementationsFrom(refs, interfaceName, methodName),
    fetchMs,
    totalReferences: refs.length,
  };
}
