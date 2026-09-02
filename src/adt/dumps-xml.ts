/**
 * ST22 runtime-dump response parsing — pure functions over response bodies.
 *
 *   - `/sap/bc/adt/runtime/dumps`         → `parseDumpFeed`      (Atom feed)
 *   - `/sap/bc/adt/runtime/dump/{key}`    → `parseDumpDetail`    (`dump:dump`)
 *   - `.../dump/{key}/formatted`          → `sliceDumpChapters`  (plain text)
 *   - `/sap/bc/adt/feeds`                 → `parseFeedsCatalog`  (Atom feed)
 *
 * Established against bodies captured off A4H (`test/fixtures/dumps/`). Non-obvious
 * points, each guarded below — see the git history for the
 * measured evidence:
 *
 *   1. The dump key is an opaque, fixed-width, already-percent-encoded 70-char
 *      record. Never decode/re-encode/trim/collapse it — each was tried and 404s.
 *   2. `atom:summary` (~13 KB escaped-HTML mini-dump per entry, 91% of feed bytes)
 *      is never read.
 *   3. Categories match by `@label`, chapters by `@name` — never by position/`@title`.
 *   4. `line` is not monotonic in document order (grouped by `categoryOrder`), so
 *      offset arithmetic sorts explicitly first. See `dumpChapterExtents`.
 *   5. A self-closing `<atom:feed/>` (the `$queryCheck` response) parses to the
 *      string `""`, not an object — every entry point tolerates that.
 *
 * `feed:extendedData` is parsed, not derived: an attribute's permitted operators
 * are not a function of its data type (e.g. `user` allows only equals/notEquals).
 */

import { XMLParser } from "fast-xml-parser";
import { DUMPS_FEED_PATH } from "./dumps-query.js";
import { AbapError } from "./errors.js";

// ----------------------------------------------------------------- parser ---

/**
 * House options (mirrors `datapreview.ts:104`) plus an `isArray` predicate
 * covering every repeatable element in these four documents.
 *
 * `parseTagValue`/`parseAttributeValue` are both off: on, they'd type-coerce
 * wire strings (e.g. zero-padded `"001"` → `1`) — see archive for the specific
 * fields hit. `isArray` is required because a one-element list collapses to a
 * bare object otherwise, and every collection here can legally have one member.
 */
const dumpsXml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  // `typeof jpath === "string"` guards the v5 `string | MatcherView` type (holds
  // under default `jPath: true`). `isAttribute` excludes attributes, which share
  // the element jpath space (`feed.entry.link` vs `feed.entry.link.href`).
  isArray: (_name, jpath, _isLeaf, isAttribute) =>
    !isAttribute && typeof jpath === "string" && REPEATABLE_JPATHS.has(jpath),
});

/**
 * Element paths (namespace prefixes stripped) that are collections.
 *
 * `feed.entry.extendedData.*` appears at two depths on purpose: the operator
 * list under `dataTypes`/`attributes` is a list of `@id`-only references,
 * distinct from the top-level list of definitions.
 */
const REPEATABLE_JPATHS: ReadonlySet<string> = new Set([
  // dumps feed + feeds catalog
  "feed.entry",
  "feed.link",
  "feed.entry.link",
  "feed.entry.category",
  // dump detail
  "dump.links.link",
  "dump.chapters.chapter",
  // feed:extendedData contract
  "feed.entry.extendedData.operators.operator",
  "feed.entry.extendedData.dataTypes.dataType",
  "feed.entry.extendedData.dataTypes.dataType.operators.operator",
  "feed.entry.extendedData.attributes.attribute",
  "feed.entry.extendedData.attributes.attribute.operators.operator",
  "feed.entry.extendedData.queryVariants.queryVariant",
]);

// ------------------------------------------------------------- primitives ---

type Rec = Record<string, unknown>;

/** An element node, or `undefined` for a leaf/absent/self-closing-to-`""` one. */
function asRecord(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

/** A configured-repeatable element, tolerating both the array and the collapse. */
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

/**
 * An attribute's literal value. Unlike `attrString` in `datapreview.ts`, `""` is
 * returned as `""`, not folded to `undefined` — `dump:dump/@exception=""` is a
 * normal classic runtime error, not a missing value.
 */
function attr(node: Rec | undefined, name: string): string | undefined {
  const value = node?.[`@_${name}`];
  return typeof value === "string" ? value : undefined;
}

/** An attribute's value, or `""` when absent — for fields that are always present. */
function attrOrEmpty(node: Rec | undefined, name: string): string {
  return attr(node, name) ?? "";
}

/** An element's text: bare string leaf, or `{ "#text": ... }` when it has attributes. */
function elementText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  const text = rec?.["#text"];
  return typeof text === "string" ? text : undefined;
}

/** XML boolean (only literal `"true"` is true). Local, not `isAbapTrue` from
 * `connection.ts` — this module stays free of the transport layer. */
function isXmlTrue(value: string | undefined): boolean {
  return value === "true";
}

/** A non-negative integer attribute, or `undefined` when absent/unparseable. */
function intAttr(node: Rec | undefined, name: string): number | undefined {
  const raw = attr(node, name);
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** A query-string parameter of a (possibly relative) href. */
function hrefParam(href: string | undefined, name: string): string | undefined {
  if (href === undefined) return undefined;
  const q = href.indexOf("?");
  if (q < 0) return undefined;
  return new URLSearchParams(href.slice(q + 1)).get(name) ?? undefined;
}

// --------------------------------------------------------- ADT URI + keys ---

/** Path prefix of a dump detail resource. The key is everything after it. */
export const DUMP_DETAIL_PATH_PREFIX = "/sap/bc/adt/runtime/dump/";

/** Path of the dumps feed in the `/feeds` catalog. Owned by `dumps-query.ts`;
 * re-exported so callers of `parseFeedsCatalog` can reach it from one module. */
export { DUMPS_FEED_PATH } from "./dumps-query.js";

/**
 * Decoded length of a dump key: `ts(14) + host(32) + user(12) + client(3) +
 * modno(9)`. Host, user and modno are space-padded to width, which is where
 * the `%20` runs come from and why the key cannot be normalised.
 */
export const DUMP_KEY_DECODED_LENGTH = 70;

/** How a link's URI must be treated. */
export type DumpLinkKind =
  /** A server-relative ADT path — the only kind that is safe to request. */
  | "adt-path"
  /** An `adt://{SID}/…` reference; strip the scheme+SID to get a path. */
  | "adt-uri"
  /** An absolute `http(s)://` URL naming the appliance's internal hostname —
   * unroutable except from the appliance itself, and must never be followed. */
  | "external-url";

const ADT_SCHEME_RE = /^adt:\/\/[^/]*/;

/** Classify a link URI without altering it. */
export function dumpLinkKind(uri: string): DumpLinkKind {
  if (ADT_SCHEME_RE.test(uri)) return "adt-uri";
  if (/^https?:\/\//i.test(uri)) return "external-url";
  return "adt-path";
}

/** Strip a leading `adt://{SID}`, leaving a server-relative path. The remainder
 * (percent encoding, `%20` runs, `#start=` fragment) is returned byte for byte;
 * a non-`adt://` URI is returned unchanged. */
export function stripAdtScheme(uri: string): string {
  return uri.replace(ADT_SCHEME_RE, "");
}

/**
 * The opaque dump key from a detail path, exactly as received (still
 * percent-encoded, `%20` runs intact — no decode/trim/re-encode). Every
 * normalisation tried against the live appliance 404s; see module header
 * point 1. `undefined` when the path is not a dump detail path.
 */
export function dumpKeyFromDetailPath(path: string): string | undefined {
  if (!path.startsWith(DUMP_DETAIL_PATH_PREFIX)) return undefined;
  const key = path.slice(DUMP_DETAIL_PATH_PREFIX.length);
  return key === "" ? undefined : key;
}

/**
 * The decoded, fixed-width form of a key — for display and field extraction
 * only. Never send this, and never re-encode it: see `dumpKeyFromDetailPath`.
 */
export function decodeDumpKey(key: string): string {
  return decodeURIComponent(key);
}

/** The five fixed-width fields of a decoded dump key. */
export interface DumpKeyFields {
  /** `yyyyMMddHHmmss`, UTC, as the server writes it. */
  timestamp: string;
  /** Application server instance, e.g. `a4hsandbox_A4H_00`. */
  serverInstance: string;
  user: string;
  /** Three digits, zero-padded — `"001"`, never `1`. */
  client: string;
  /** Internal mode number, right-aligned in its field. */
  modeNumber: string;
}

/**
 * Split a decoded key into its fields, by offset (not delimiter — host/user
 * are space-padded). `undefined` unless the key is exactly
 * `DUMP_KEY_DECODED_LENGTH` characters.
 */
export function parseDumpKeyFields(key: string): DumpKeyFields | undefined {
  const decoded = decodeDumpKey(key);
  if (decoded.length !== DUMP_KEY_DECODED_LENGTH) return undefined;
  return {
    timestamp: decoded.slice(0, 14),
    serverInstance: decoded.slice(14, 46).trimEnd(),
    user: decoded.slice(46, 58).trimEnd(),
    client: decoded.slice(58, 61),
    modeNumber: decoded.slice(61, 70).trim(),
  };
}

// ------------------------------------------------------ exception bodies ---

/** An `exc:exception` envelope — ADT's error body for 4xx on these resources. */
export interface AdtExceptionEnvelope {
  /** e.g. `com.sap.adt`, `com.sap.adt.runtime.dump`. */
  namespace: string;
  /** e.g. `notFound`, `ExceptionInvalidData`, `ExceptionResourceNotAcceptable`. */
  type: string;
  message: string;
}

/** Recognise an ADT exception envelope, or `undefined`. Without this, a 404/406
 * body parses to a detail object full of empty strings — a silent, wrong success. */
export function parseAdtExceptionEnvelope(body: string): AdtExceptionEnvelope | undefined {
  let doc: Rec;
  try {
    doc = dumpsXml.parse(body) as Rec;
  } catch {
    return undefined;
  }
  return exceptionFromDoc(doc);
}

function exceptionFromDoc(doc: Rec): AdtExceptionEnvelope | undefined {
  const exc = asRecord(doc.exception);
  if (exc === undefined) return undefined;
  return {
    namespace: attrOrEmpty(asRecord(exc.namespace), "id"),
    type: attrOrEmpty(asRecord(exc.type), "id"),
    message: elementText(exc.message) ?? "",
  };
}

function refuseExceptionEnvelope(doc: Rec, what: string): void {
  const exc = exceptionFromDoc(doc);
  if (exc === undefined) return;
  throw new AbapError(
    "ADT_ERROR",
    `Expected ${what} but the body is an ADT exception envelope: ${exc.type} — ${exc.message}`,
    { exceptionType: exc.type, exceptionNamespace: exc.namespace },
    "This is a server error body, not a payload. Check the HTTP status of the " +
      "response the body came from rather than the parse.",
  );
}

// ------------------------------------------------------------- dump feed ---

/** One `atom:entry` of the dumps feed, with the 13 KB summary left behind. */
export interface DumpFeedEntry {
  /** The opaque, still-encoded key. Carry verbatim — never decode-and-re-encode. */
  key: string;
  /** `/sap/bc/adt/runtime/dump/{key}` — the detail resource. */
  detailPath: string;
  /** `atom:author/atom:name`. The `atom:author/atom:uri` sibling is discarded. */
  user: string;
  /** `atom:category[@label="ABAP runtime error"]/@term`, e.g. `CONVT_NO_NUMBER`. */
  runtimeError: string;
  /** `atom:category[@label="Terminated ABAP program"]/@term` — for a class, the
   * generated `NAME==========CP` pool, not the class name. */
  terminatedProgram: string;
  /** `atom:title` — the runtime error's short text. */
  title: string;
  published: string;
  updated: string;
  /** `atom:id` — the SAP GUI `/vit/` path. Traceability only: 404s over HTTP,
   * not a usable key. */
  guiPath: string;
  /** `rel="alternate"` — a `sapgui` deep link, not fetchable over ADT. */
  sapGuiUri?: string;
}

/** A parsed `/sap/bc/adt/runtime/dumps` page. */
export interface DumpFeed {
  /** `atom:contributor/atom:name` — the system ID. Empty on a `$queryCheck`. */
  systemId: string;
  title: string;
  updated: string;
  /** Feed-level `rel="self"` href, relative, with `$` as `%24`. */
  selfHref?: string;
  /** Feed-level `rel="next"` href. **Absent on the last page.** */
  nextHref?: string;
  /** `from=` on the self link — the newest timestamp on this page. */
  newestTimestamp?: string;
  /** `to=` on the next link — the cursor for the following page. */
  oldestTimestamp?: string;
  /** True exactly when a `rel="next"` link is present. */
  hasMore: boolean;
  entries: DumpFeedEntry[];
}

const CATEGORY_LABEL_RUNTIME_ERROR = "ABAP runtime error";
const CATEGORY_LABEL_TERMINATED_PROGRAM = "Terminated ABAP program";

/** `@term` of the single `atom:category` bearing `label`. */
function categoryTerm(categories: unknown, label: string): string {
  for (const raw of asArray(categories)) {
    const cat = asRecord(raw);
    if (attr(cat, "label") === label) return attrOrEmpty(cat, "term");
  }
  return "";
}

/** `@href` of the first `atom:link` bearing `rel`, or `undefined`. */
function linkHref(links: unknown, rel: string): string | undefined {
  for (const raw of asArray(links)) {
    const link = asRecord(raw);
    if (attr(link, "rel") === rel) return attr(link, "href");
  }
  return undefined;
}

/**
 * Parse a dumps feed page. Tolerates the empty-feed and self-closing-feed
 * shapes (see module header point 5) — both yield an empty `entries` array
 * rather than a throw.
 */
export function parseDumpFeed(body: string): DumpFeed {
  const doc = dumpsXml.parse(body) as Rec;
  refuseExceptionEnvelope(doc, "an ABAP dumps feed");
  if (!("feed" in doc)) {
    throw new AbapError(
      "BAD_INPUT",
      "Not an Atom feed: no root <atom:feed> element.",
      { rootElements: Object.keys(doc).filter((k) => k !== "?xml") },
      "This parser reads /sap/bc/adt/runtime/dumps responses.",
    );
  }
  // `<atom:feed/>` self-closes to "", not to an object — hence `?? {}`.
  const feed = asRecord(doc.feed) ?? {};

  const selfHref = linkHref(feed.link, "self");
  const nextHref = linkHref(feed.link, "next");

  const entries: DumpFeedEntry[] = [];
  for (const raw of asArray(feed.entry)) {
    const entry = asRecord(raw);
    if (entry === undefined) continue;

    // rel="self" is the detail URL. Its type="text/plain" is a lie — the
    // resource serves vnd.sap.adt.runtime.dump.v1+xml — so nothing keys off it.
    const detailPath = stripAdtScheme(linkHref(entry.link, "self") ?? "");
    const key = dumpKeyFromDetailPath(detailPath);
    if (key === undefined) continue;

    const alternate = linkHref(entry.link, "alternate");
    entries.push({
      key,
      detailPath,
      user: elementText(asRecord(entry.author)?.name) ?? "",
      // By @label, never by position: the two categories are order-stable in
      // the capture but nothing in Atom says they must be.
      runtimeError: categoryTerm(entry.category, CATEGORY_LABEL_RUNTIME_ERROR),
      terminatedProgram: categoryTerm(entry.category, CATEGORY_LABEL_TERMINATED_PROGRAM),
      title: elementText(entry.title) ?? "",
      published: elementText(entry.published) ?? "",
      updated: elementText(entry.updated) ?? "",
      guiPath: elementText(entry.id) ?? "",
      ...(alternate === undefined ? {} : { sapGuiUri: alternate }),
      // entry.summary is deliberately not read: ~13 KB of escaped HTML per
      // entry, 91% of the feed's bytes, and a duplicate of the detail.
    });
  }

  const newest = hrefParam(selfHref, "from");
  const oldest = hrefParam(nextHref, "to");
  return {
    systemId: elementText(asRecord(feed.contributor)?.name) ?? "",
    title: elementText(feed.title) ?? "",
    updated: elementText(feed.updated) ?? "",
    ...(selfHref === undefined ? {} : { selfHref }),
    ...(nextHref === undefined ? {} : { nextHref }),
    ...(newest === undefined ? {} : { newestTimestamp: newest }),
    ...(oldest === undefined ? {} : { oldestTimestamp: oldest }),
    hasMore: nextHref !== undefined,
    entries,
  };
}

// ----------------------------------------------------------- dump detail ---

/** One `dump:link`. Note the attribute names: `relation`/`uri`, not `rel`/`href`. */
export interface DumpLink {
  /** As received — either a bare token or an absolute relation URI. */
  relation: string;
  /** The bare token, with the SAP relation-URI prefix removed if present. */
  relationToken: string;
  uri: string;
  /** Frequently `""` (both captured `termination` links). Not a discriminator. */
  contentType: string;
  kind: DumpLinkKind;
}

/** One `dump:chapter`. */
export interface DumpChapter {
  /** Stable identifier, e.g. `kap10`. Match on this, never on `title` — `kap10`
   * is "Selected Variables" here, "Chosen Variables" elsewhere. */
  name: string;
  /** Human-readable, release- and language-dependent. Display only. */
  title: string;
  /** Grouping label, e.g. `ABAP Developer View`. */
  category: string;
  /** 1-based line offset into the `/formatted` body — the chapter's banner line. */
  line: number;
  /** Display order within the dump. **Not document order.** */
  chapterOrder: number;
  /** Grouping order. Document order follows *this*, which is why `line` jumps. */
  categoryOrder: number;
}

/** Where a dump terminated, resolved to something `abap_read` can consume. */
export interface DumpTerminationTarget {
  /** e.g. `/sap/bc/adt/oo/classes/zcl_x/source/main`. */
  path: string;
  /** The `#start=` fragment, when present. */
  line?: number;
}

/** A parsed `dump:dump` document. */
export interface DumpDetail {
  title: string;
  /** The runtime error id, e.g. `SAPSQL_PARSE_ERROR`. */
  error: string;
  author: string;
  /** Class-based exception, e.g. `CX_SY_DYNAMIC_OSQL_SEMANTICS`. `""` for classic
   * non-class-based errors — normal, not a failure. */
  exception: string;
  /** For a class, the generated `NAME==========CP` pool. */
  terminatedProgram: string;
  serverInstance: string;
  /** ISO-8601 UTC. `systemDate`/`systemTime` are the same instant, localised. */
  datetime: string;
  systemDate: string;
  systemTime: string;
  links: DumpLink[];
  chapters: DumpChapter[];
  /** Path of the `/formatted` body, from `relation="contents"`. */
  formattedPath?: string;
  /** Where execution stopped — the actionable link. */
  termination?: DumpTerminationTarget;
}

/** Prefix SAP puts in front of *some* of the dump relation tokens. */
const DUMP_RELATION_PREFIX = "http://www.sap.com/adt/relations/runtime/dump/";

/** Reduce a relation to its bare token. The server mixes bare tokens (`contents`,
 * `self`, `alternate`) and absolute relation URIs (`unformatted`, `summary`,
 * `termination`, `http`) within one document, so both forms must match. */
function relationToken(relation: string): string {
  return relation.startsWith(DUMP_RELATION_PREFIX)
    ? relation.slice(DUMP_RELATION_PREFIX.length)
    : relation;
}

/** Find a dump link by bare relation token, matching both encodings. The
 * `/formatted` body's token is `contents` — there's no `.../formatted` relation. */
export function findDumpLink(links: readonly DumpLink[], token: string): DumpLink | undefined {
  return links.find((l) => l.relationToken === token);
}

/** Parse a `dump:dump` detail document. Every root attribute is returned even
 * when empty — `exception=""` is a normal classic runtime error, not an error. */
export function parseDumpDetail(body: string): DumpDetail {
  const doc = dumpsXml.parse(body) as Rec;
  refuseExceptionEnvelope(doc, "an ABAP dump detail");
  const dump = asRecord(doc.dump);
  if (dump === undefined) {
    throw new AbapError(
      "BAD_INPUT",
      "Not an ABAP dump detail: no root <dump:dump> element.",
      { rootElements: Object.keys(doc).filter((k) => k !== "?xml") },
      "This parser reads application/vnd.sap.adt.runtime.dump.v1+xml bodies. A " +
        "text/plain request to the same URL is answered with HTTP 406.",
    );
  }

  const links: DumpLink[] = [];
  for (const raw of asArray(asRecord(dump.links)?.link)) {
    const node = asRecord(raw);
    const relation = attrOrEmpty(node, "relation");
    const uri = attrOrEmpty(node, "uri");
    links.push({
      relation,
      relationToken: relationToken(relation),
      uri,
      contentType: attrOrEmpty(node, "contentType"),
      kind: dumpLinkKind(uri),
    });
  }

  const chapters: DumpChapter[] = [];
  for (const raw of asArray(asRecord(dump.chapters)?.chapter)) {
    const node = asRecord(raw);
    const name = attrOrEmpty(node, "name");
    const line = intAttr(node, "line");
    if (line === undefined) {
      // Strict here, lenient on the two order fields below: `line` is the only
      // attribute slicing depends on, so a missing one must not slice silently wrong.
      throw new AbapError(
        "BAD_INPUT",
        `Dump chapter '${name}' has no usable line offset (line=${String(attr(node, "line"))}).`,
        { chapter: name },
        "The line attribute is the 1-based offset of the chapter's banner in the " +
          "/formatted body; without it the chapter cannot be located.",
      );
    }
    chapters.push({
      name,
      title: attrOrEmpty(node, "title"),
      category: attrOrEmpty(node, "category"),
      line,
      chapterOrder: intAttr(node, "chapterOrder") ?? 0,
      categoryOrder: intAttr(node, "categoryOrder") ?? 0,
    });
  }

  const contents = findDumpLink(links, "contents");
  const termination = findDumpLink(links, "termination");
  const target = termination === undefined ? undefined : terminationTarget(termination.uri);

  return {
    title: attrOrEmpty(dump, "title"),
    error: attrOrEmpty(dump, "error"),
    author: attrOrEmpty(dump, "author"),
    exception: attrOrEmpty(dump, "exception"),
    terminatedProgram: attrOrEmpty(dump, "terminatedProgram"),
    serverInstance: attrOrEmpty(dump, "serverInstance"),
    datetime: attrOrEmpty(dump, "datetime"),
    systemDate: attrOrEmpty(dump, "systemDate"),
    systemTime: attrOrEmpty(dump, "systemTime"),
    links,
    chapters,
    ...(contents === undefined ? {} : { formattedPath: stripAdtScheme(contents.uri) }),
    ...(target === undefined ? {} : { termination: target }),
  };
}

/** Split a `termination` URI into an ADT path and a line. The server resolves
 * the object type itself, so this never has to guess it from `terminatedProgram`
 * (the unhelpful generated `==========CP` pool name for a class). */
function terminationTarget(uri: string): DumpTerminationTarget | undefined {
  const path = stripAdtScheme(uri);
  if (path === "") return undefined;
  const hash = path.indexOf("#");
  if (hash < 0) return { path };
  const start = new URLSearchParams(path.slice(hash + 1)).get("start");
  const line = start === null ? Number.NaN : Number.parseInt(start, 10);
  return {
    path: path.slice(0, hash),
    ...(Number.isFinite(line) ? { line } : {}),
  };
}

// --------------------------------------------------------- chapter slices ---

/** The chapters worth reading by default — termination point, source extract,
 * system fields, call stack. `kap10` (Selected Variables) is deliberately absent:
 * on the captured pair it alone is ~60% of the body. */
export const TIER1_CHAPTER_NAMES: readonly string[] = ["kap7", "kap8", "kap9", "kap11"];

/** `kap10` — the large, variable-contents chapter. Named so callers can gate it. */
export const VARIABLES_CHAPTER_NAME = "kap10";

/** A chapter's half-open extent in the `/formatted` body, 0-based. */
export interface DumpChapterExtent {
  chapter: DumpChapter;
  /** Index of the chapter's banner line. */
  start: number;
  /** Exclusive end — the next chapter's banner, or the end of the body. */
  end: number;
}

/**
 * Resolve every chapter to a line range over a `/formatted` body of
 * `totalLines` lines. The explicit sort by `line` (not document/`chapterOrder`)
 * is required — document order follows `categoryOrder`, so naive pairing
 * produces negative-length extents. Clamped to the body so a mismatched
 * chapter table (wrong dump's `/formatted`) yields empty slices, not a throw
 * or wrong text.
 */
export function dumpChapterExtents(
  chapters: readonly DumpChapter[],
  totalLines: number,
): DumpChapterExtent[] {
  const sorted = [...chapters].sort((a, b) => a.line - b.line || a.chapterOrder - b.chapterOrder);
  const clamp = (n: number): number => Math.min(Math.max(n, 0), Math.max(totalLines, 0));
  return sorted.map((chapter, i) => {
    const next = sorted[i + 1];
    const start = clamp(chapter.line - 1);
    const end = clamp(next === undefined ? totalLines : next.line - 1);
    return { chapter, start, end: Math.max(start, end) };
  });
}

/**
 * The concatenated text of the named chapters, in line order. `line` is
 * 1-based, so a chapter's banner is `lines[line - 1]`. Names no chapter
 * carries are ignored (chapter sets differ by release).
 */
export function sliceDumpChapters(
  chapters: readonly DumpChapter[],
  formatted: string,
  names: Iterable<string>,
): string {
  const wanted = new Set(names);
  if (wanted.size === 0) return "";
  const lines = formatted.split("\n");
  const parts: string[] = [];
  for (const extent of dumpChapterExtents(chapters, lines.length)) {
    if (!wanted.has(extent.chapter.name)) continue;
    parts.push(lines.slice(extent.start, extent.end).join("\n"));
  }
  return parts.join("\n");
}

// -------------------------------------------------- feeds catalog + contract ---

/** A `feed:operator` definition: the full form, with operand count and label. */
export interface FeedOperatorDef {
  id: string;
  numberOfOperands: number;
  /** e.g. `RELATIONAL`. */
  kind: string;
  label: string;
}

/** A `feed:dataType` and the operators it permits *in general*. */
export interface FeedDataTypeDef {
  id: string;
  label: string;
  /** Operator ids. A per-attribute list may be narrower — see `FeedAttributeDef`. */
  operatorIds: string[];
}

/** A queryable `feed:attribute` and the operators it actually permits. */
export interface FeedAttributeDef {
  id: string;
  dataTypeId: string;
  label: string;
  /** Not derivable from `dataTypeId` (e.g. `user` is a string but permits only
   * equals/notEquals, unlike other strings). This list is the authority. */
  operatorIds: string[];
}

/** A ready-made query the client may offer. */
export interface FeedQueryVariant {
  queryString: string;
  title: string;
  isDefault: boolean;
}

/** The parsed `feed:extendedData` contract of one catalog entry. */
export interface FeedExtendedData {
  /** Suggested poll interval, e.g. `{ value: 5, unit: "minutes" }`. */
  refresh?: { value: number; unit: string };
  /** Server page size — `50` for dumps. Absent on entries that do not page. */
  pageSize?: number;
  notificationEnabled: boolean;
  operators: FeedOperatorDef[];
  dataTypes: FeedDataTypeDef[];
  attributes: FeedAttributeDef[];
  /** Whether a `$query` must be supplied. Wire text, so `"false"` → `false`. */
  queryIsObligatory: boolean;
  /** Maximum nesting depth of a `$query` expression. */
  queryDepth?: number;
  queryVariants: FeedQueryVariant[];
}

/** One entry of `/sap/bc/adt/feeds`. */
export interface FeedCatalogEntry {
  /** `atom:id` — the feed's own path. The reliable identifier. */
  id: string;
  title: string;
  /** `atom:content/@src`. Same path as `id` on every captured entry. */
  contentSrc?: string;
  /** `rel="alternate"`. There is **no `rel="self"`** on these entries. */
  alternateHref?: string;
  /** The date the feed was *defined* (2011-08-25 for dumps), not of anything in
   * it — never read freshness from this. */
  published: string;
  updated: string;
  extendedData?: FeedExtendedData;
}

/** A parsed `/sap/bc/adt/feeds` catalog. */
export interface FeedCatalog {
  systemId: string;
  title: string;
  updated: string;
  entries: FeedCatalogEntry[];
}

/** `@id` of every `feed:operator` reference in a `feed:operators` container. */
function operatorRefIds(container: unknown): string[] {
  const ids: string[] = [];
  for (const raw of asArray(asRecord(container)?.operator)) {
    const id = attr(asRecord(raw), "id");
    if (id !== undefined && id !== "") ids.push(id);
  }
  return ids;
}

function parseExtendedData(node: Rec): FeedExtendedData {
  const intervalNode = asRecord(asRecord(node.refresh)?.interval);
  const intervalValue = intAttr(intervalNode, "value");
  const intervalUnit = attr(intervalNode, "unit");
  const pageSize = intAttr(asRecord(node.paging), "size");
  const queryDepthText = elementText(node.queryDepth);
  const queryDepth =
    queryDepthText === undefined ? Number.NaN : Number.parseInt(queryDepthText, 10);

  const operators: FeedOperatorDef[] = [];
  for (const raw of asArray(asRecord(node.operators)?.operator)) {
    const op = asRecord(raw);
    operators.push({
      id: attrOrEmpty(op, "id"),
      numberOfOperands: intAttr(op, "numberOfOperands") ?? 0,
      kind: attrOrEmpty(op, "kind"),
      label: elementText(op?.label) ?? "",
    });
  }

  const dataTypes: FeedDataTypeDef[] = [];
  for (const raw of asArray(asRecord(node.dataTypes)?.dataType) as unknown[]) {
    const dt = asRecord(raw);
    dataTypes.push({
      id: attrOrEmpty(dt, "id"),
      label: elementText(dt?.label) ?? "",
      operatorIds: operatorRefIds(dt?.operators),
    });
  }

  const attributes: FeedAttributeDef[] = [];
  for (const raw of asArray(asRecord(node.attributes)?.attribute)) {
    const at = asRecord(raw);
    attributes.push({
      id: attrOrEmpty(at, "id"),
      dataTypeId: attrOrEmpty(asRecord(at?.dataType), "id"),
      label: elementText(at?.label) ?? "",
      operatorIds: operatorRefIds(at?.operators),
    });
  }

  const queryVariants: FeedQueryVariant[] = [];
  for (const raw of asArray(asRecord(node.queryVariants)?.queryVariant)) {
    const qv = asRecord(raw);
    queryVariants.push({
      queryString: attrOrEmpty(qv, "queryString"),
      title: attrOrEmpty(qv, "title"),
      isDefault: isXmlTrue(attr(qv, "isDefault")),
    });
  }

  return {
    ...(intervalValue === undefined
      ? {}
      : { refresh: { value: intervalValue, unit: intervalUnit ?? "" } }),
    ...(pageSize === undefined ? {} : { pageSize }),
    notificationEnabled: isXmlTrue(attr(asRecord(node.notification), "isEnabled")),
    operators,
    dataTypes,
    attributes,
    queryIsObligatory: isXmlTrue(elementText(node.queryIsObligatory)),
    ...(Number.isFinite(queryDepth) ? { queryDepth } : {}),
    queryVariants,
  };
}

/** Parse `/sap/bc/adt/feeds`. */
export function parseFeedsCatalog(body: string): FeedCatalog {
  const doc = dumpsXml.parse(body) as Rec;
  refuseExceptionEnvelope(doc, "the ADT feeds catalog");
  const feed = asRecord(doc.feed) ?? {};

  const entries: FeedCatalogEntry[] = [];
  for (const raw of asArray(feed.entry)) {
    const entry = asRecord(raw);
    if (entry === undefined) continue;
    const contentSrc = attr(asRecord(entry.content), "src");
    const alternateHref = linkHref(entry.link, "alternate");
    const ed = asRecord(entry.extendedData);
    entries.push({
      id: elementText(entry.id) ?? "",
      title: elementText(entry.title) ?? "",
      ...(contentSrc === undefined ? {} : { contentSrc }),
      ...(alternateHref === undefined ? {} : { alternateHref }),
      published: elementText(entry.published) ?? "",
      updated: elementText(entry.updated) ?? "",
      ...(ed === undefined ? {} : { extendedData: parseExtendedData(ed) }),
    });
  }

  return {
    systemId: elementText(asRecord(feed.contributor)?.name) ?? "",
    title: elementText(feed.title) ?? "",
    updated: elementText(feed.updated) ?? "",
    entries,
  };
}

/** Locate the dumps feed in the catalog — the capability probe. Matches `atom:id`
 * or `atom:content/@src` only; never `rel="self"` — catalog entries carry only
 * `rel="alternate"`, so that matcher finds nothing even when the feature exists. */
export function findDumpsFeedEntry(catalog: FeedCatalog): FeedCatalogEntry | undefined {
  return catalog.entries.find((e) => e.id === DUMPS_FEED_PATH || e.contentSrc === DUMPS_FEED_PATH);
}
