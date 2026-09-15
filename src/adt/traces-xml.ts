/**
 * SAP ADT ABAP-trace (SAT) response parsing — pure functions over response
 * bodies, no socket.
 *
 *   - `GET  /sap/bc/adt/runtime/traces/abaptraces`            → {@link parseTraceRuns}
 *     (also accepts the single-`atom:entry` shape a filtered/`$top=1` query
 *     can return instead of a feed — see `results-entry-one-run.xml`)
 *   - `GET  /sap/bc/adt/runtime/traces/abaptraces/requests`   → {@link parseTraceRequests}
 *   - `GET  …/abaptraces/{id}/hitlist`                        → {@link parseTraceHitList}
 *   - `GET  …/abaptraces/{id}/dbAccesses`                     → {@link parseTraceDbAccesses}
 *   - `GET  …/abaptraces/{id}/statements`                     → {@link parseTraceStatements}
 *
 * Grounded in real captures off an A4H (SAP_BASIS 754) appliance, committed
 * under `test/fixtures/traces/` — see `test/fixtures/traces/README.md` for
 * their provenance, the two leak-scrub substitutions and which three files
 * are trimmed:
 *
 *   - `results-feed-two-runs.xml` — a run list with two entries, one
 *     aggregated (`byCallPosition`), one not.
 *   - `results-entry-one-run.xml` — the same second run, but as a bare
 *     `atom:entry` document rather than a one-entry feed.
 *   - `requests-feed-one.xml`, `requests-feed-created.xml` — a trace
 *     request with its two `atom:author`s (`admin` and `trace` roles).
 *   - `requests-feed-empty.xml` — a `<atom:feed>` with zero entries.
 *   - `hitlist-top12.xml` — 12 hit-list rows, one of them with no
 *     `dbAccessAnchor` (a non-DB call).
 *   - `dbaccesses-trimmed.xml` — 15 `trc:dbAccess` rows over 5 `trc:table`s,
 *     including the synthetic `"<DB Access from Kernel>"` row that carries
 *     no `trc:callingProgram` at all.
 *   - `statements-calltree-top20.xml` — the first 20 rows of a 660-row
 *     call tree, `m:count` given in scientific notation (see below).
 *
 * Two traps specific to this data, both observed live rather than assumed:
 *
 *   1. `m:count="6.6E+2"` — the statement count is scientific notation, not
 *      an integer literal. `Number.parseInt` silently returns `6`. Parsed
 *      with `Number(...)` and rounded; see {@link parseTraceStatements}.
 *   2. `trc:callingProgram` sometimes carries `adtcore:uri`/`adtcore:type`/
 *      `adtcore:name` (a real ADT object), and sometimes only
 *      `objectReferenceQuery` (SAP framework code with no ADT object at all,
 *      e.g. `SAPLHTTP_RUNTIME`). `name`/`type`/`uri` are therefore genuinely
 *      optional on {@link TraceProgramRef} and never emitted as
 *      `undefined`-valued keys — conditional spread throughout, matching the
 *      house idiom in `atc-xml.ts`/`dumps-xml.ts`.
 */

import { XMLParser } from "fast-xml-parser";
import { AbapError } from "./errors.js";
import { PARSE_EXCERPT_MAX, truncateText } from "../truncate.js";

// ----------------------------------------------------------------- parser ---

/**
 * `removeNSPrefix` is `false` — NOT a style choice. A real capture
 * (`dbaccesses-trimmed.xml`'s `trc:table`) shows
 * `<trc:table name="TADIR" type="TRANSP" adtcore:type="TABL/DT"
 * adtcore:name="TADIR"/>`: with `removeNSPrefix: true` the DDIC table class
 * `"TRANSP"` (the un-prefixed `type` attribute) is silently overwritten by
 * `adtcore:type` (`"TABL/DT"`), because both collapse to the same `@_type`
 * key once prefixes are stripped. Attributes are addressed by their full
 * prefixed name (`@_adtcore:name`, `@_trc:role`, …) throughout this module.
 *
 * `parseAttributeValue`/`parseTagValue` are both off, matching `atc-xml.ts`
 * and `dumps-xml.ts`: coercion would silently turn `m:count="6.6E+2"` into a
 * different (still wrong) number, and a zero-padded `client` like `"001"`
 * into `1`. Every number this module returns is converted explicitly.
 */
const tracesXml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: false,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  // `typeof` guard: `jpath` is `string | MatcherView` in fast-xml-parser v5,
  // a string only while default `jPath: true` holds. `isAttribute` matters
  // because attributes share the element jpath space.
  isArray: (_name, jpath, _isLeaf, isAttribute) =>
    !isAttribute && typeof jpath === "string" && REPEATABLE_JPATHS.has(jpath),
});

/**
 * Element paths — namespace prefixes KEPT, per the `removeNSPrefix: false`
 * decision above — that are collections. Each entry was confirmed by
 * driving this exact parser config over the fixtures listed at the module
 * header and logging the `isArray` callback's `jpath` argument; none of
 * these are guessed from tag names.
 */
const REPEATABLE_JPATHS: ReadonlySet<string> = new Set([
  // run list / request list feeds — both `atom:feed.atom:entry`
  "atom:feed.atom:entry",
  // a trace request carries two `atom:author`s (`trc:role="admin"` and
  // `trc:role="trace"`) — see `requests-feed-one.xml`
  "atom:feed.atom:entry.atom:author",
  // hit list rows
  "trc:hitlist.trc:entry",
  // DB access rows and the table dictionary that backs them
  "trc:dbAccesses.trc:dbAccess",
  "trc:dbAccesses.trc:tables.trc:table",
  // call-tree rows
  "trc:statements.trc:statement",
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

/** An attribute's literal value, addressed by its full prefixed name. */
function attr(node: Rec | undefined, name: string): string | undefined {
  const value = node?.[`@_${name}`];
  return typeof value === "string" ? value : undefined;
}

/** An attribute's value, or `""` when absent. */
function attrOrEmpty(node: Rec | undefined, name: string): string {
  return attr(node, name) ?? "";
}

/**
 * An element's text content: a bare string for an attribute-less leaf,
 * `{"#text": …}` for one that carries attributes.
 */
function elementText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  const text = rec?.["#text"];
  return typeof text === "string" ? text : undefined;
}

/** XML boolean. Only the literal `"true"` is true. */
function isXmlTrue(value: string | undefined): boolean {
  return value === "true";
}

/**
 * A number from element text or an attribute value, via `Number(...)` — not
 * `parseInt`, which would truncate rather than reject a non-integer literal
 * (relevant to `trc:grossTime/@percentage` etc, which are genuinely
 * fractional, e.g. `"24.1768"`). Absent/unparseable becomes `0`. Rounding is
 * NOT applied here — only `m:count`'s scientific-notation literal needs
 * that, and it opts in explicitly at its one call site.
 */
function toNumber(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function numAttr(node: Rec | undefined, name: string): number {
  return toNumber(attr(node, name));
}

function numElement(value: unknown): number {
  return toNumber(elementText(value));
}

/** The last `/`-separated segment of a path/URI, or `""` when absent. */
function lastPathSegment(value: string | undefined): string {
  if (value === undefined || value === "") return "";
  const parts = value.split("/");
  return parts[parts.length - 1] ?? "";
}

/**
 * Parse the whole body, or fail with a message that says what was expected.
 * `fast-xml-parser` doesn't throw on most malformed input, it returns
 * something unusable — callers check for their root element instead of
 * trusting a successful parse.
 */
function parseDocument(body: string, what: string): Rec {
  let parsed: unknown;
  try {
    parsed = tracesXml.parse(body);
  } catch (e) {
    throw new AbapError(
      "ADT_ERROR",
      `The trace ${what} response could not be parsed as XML.`,
      { what, detail: e instanceof Error ? e.message : String(e) },
      "The server answered with something other than the expected trace document.",
    );
  }
  const rec = asRecord(parsed);
  if (rec === undefined) {
    throw new AbapError(
      "ADT_ERROR",
      `The trace ${what} response was empty or not a document.`,
      { what, length: body.length },
      "The server answered with something other than the expected trace document.",
    );
  }
  return rec;
}

function missingRoot(what: string, root: string, body: string): AbapError {
  return new AbapError(
    "ADT_ERROR",
    `The trace ${what} response has no <${root}> element.`,
    // truncateText discloses how much was cut, unlike a silent `.slice()`.
    { what, root, preview: truncateText(body, PARSE_EXCERPT_MAX) },
    "This ADT release may describe ABAP traces differently from what this " +
      "client expects; see abap://system for the collections it does publish.",
  );
}

/** `@href` of the `atom:link` bearing `rel`, or `undefined`. */
function linkHref(links: unknown, rel: string): string | undefined {
  for (const raw of asArray(links)) {
    const link = asRecord(raw);
    if (attr(link, "rel") === rel) return attr(link, "href");
  }
  return undefined;
}

/** `atom:link[rel="parent"]/@href`, or `""` when the document carries none. */
function parentId(root: Rec): string {
  return linkHref(root["atom:link"], "parent") ?? "";
}

// ------------------------------------------------------------ program ref ---

/** A calling/called program reference, as it appears on a hit-list, DB-access
 * or call-tree row. */
export interface TraceProgramRef {
  context: string;
  byteCodeOffset: number;
  name?: string;
  type?: string;
  uri?: string;
}

export interface TraceTimeValue {
  time: number;
  percentage: number;
}

/**
 * Parse a `trc:callingProgram` (or, structurally identical,
 * `trc:calledProgram`) node. `adtcore:name`/`adtcore:type`/`adtcore:uri` are
 * present for a real ADT object and absent when the row instead carries only
 * `objectReferenceQuery` (SAP framework code with no ADT object) — see the
 * module header's second trap. `undefined` when the node itself is absent
 * (`trc:calledProgram` is frequently self-closed to `""`, which `asRecord`
 * reports as `undefined`).
 */
function parseProgramRef(node: Rec | undefined): TraceProgramRef | undefined {
  if (node === undefined) return undefined;
  const context = attr(node, "adtcore:context");
  if (context === undefined) return undefined;
  const name = attr(node, "adtcore:name");
  const type = attr(node, "adtcore:type");
  const uri = attr(node, "adtcore:uri");
  return {
    context,
    byteCodeOffset: numAttr(node, "byteCodeOffset"),
    ...(name === undefined || name === "" ? {} : { name }),
    ...(type === undefined || type === "" ? {} : { type }),
    ...(uri === undefined || uri === "" ? {} : { uri }),
  };
}

/** A `trc:calledProgram`/`trc:callingProgram` node, or `undefined` when the
 * element itself is not a record (self-closed to `""`, or absent). */
function programRefNode(parent: Rec, tag: string): Rec | undefined {
  return asRecord(parent[tag]);
}

function timeValue(node: unknown): TraceTimeValue {
  const rec = asRecord(node);
  return { time: numAttr(rec, "time"), percentage: numAttr(rec, "percentage") };
}

// -------------------------------------------------------------- run list ---

/** One `atom:entry` of the trace run feed (or the bare single-entry form). */
export interface TraceRunSummary {
  id: string;
  title: string;
  /** Verbatim ISO string — conversion to `Date` is the caller's. */
  published: string;
  user: string;
  /** `""` when the trace was unscoped (no object bound to the run). */
  objectName: string;
  size: number;
  /** Microseconds. */
  runtime: number;
  runtimeAbap: number;
  runtimeSystem: number;
  runtimeDatabase: number;
  isAggregated: boolean;
  /** Absent on a non-aggregated trace. */
  aggregationKind?: string;
  /** `trc:state/@value`, e.g. `"R"`. */
  state: string;
  /** `trc:state/@text`, e.g. `"Finished"`. */
  stateText: string;
  /** Verbatim, conversion is the caller's. */
  expiration?: string;
  host?: string;
  system?: string;
  /** A 3-char client like `"001"` — kept as a string, never coerced to a number. */
  client?: string;
}

function parseRunEntry(entry: Rec): TraceRunSummary {
  const ext = asRecord(entry["trc:extendedData"]) ?? {};
  const state = asRecord(ext["trc:state"]);
  const aggregationKind = elementText(ext["trc:aggregationKind"]);
  const expiration = elementText(ext["trc:expiration"]);
  const host = elementText(ext["trc:host"]);
  const system = elementText(ext["trc:system"]);
  const client = elementText(ext["trc:client"]);
  return {
    id: elementText(entry["atom:id"]) ?? "",
    title: elementText(entry["atom:title"]) ?? "",
    published: elementText(entry["atom:published"]) ?? "",
    user: elementText(ext["trc:user"]) ?? "",
    objectName: elementText(ext["trc:objectName"]) ?? "",
    size: numElement(ext["trc:size"]),
    runtime: numElement(ext["trc:runtime"]),
    runtimeAbap: numElement(ext["trc:runtimeABAP"]),
    runtimeSystem: numElement(ext["trc:runtimeSystem"]),
    runtimeDatabase: numElement(ext["trc:runtimeDatabase"]),
    isAggregated: isXmlTrue(elementText(ext["trc:isAggregated"])),
    ...(aggregationKind === undefined || aggregationKind === ""
      ? {}
      : { aggregationKind }),
    state: attrOrEmpty(state, "value"),
    stateText: attrOrEmpty(state, "text"),
    ...(expiration === undefined || expiration === "" ? {} : { expiration }),
    ...(host === undefined || host === "" ? {} : { host }),
    ...(system === undefined || system === "" ? {} : { system }),
    ...(client === undefined || client === "" ? {} : { client }),
  };
}

/**
 * Parse `GET /sap/bc/adt/runtime/traces/abaptraces`. Accepts both an
 * `atom:feed` of runs (`results-feed-two-runs.xml`) and a bare `atom:entry`
 * document (`results-entry-one-run.xml`, e.g. a single-run `GET` by id) —
 * the latter returns a one-element array rather than being rejected as
 * "not a feed".
 */
export function parseTraceRuns(xml: string): TraceRunSummary[] {
  const doc = parseDocument(xml, "run list");
  if ("atom:entry" in doc) {
    const entry = asRecord(doc["atom:entry"]);
    return entry === undefined ? [] : [parseRunEntry(entry)];
  }
  if (!("atom:feed" in doc)) {
    throw missingRoot("run list", "atom:feed", xml);
  }
  // A self-closed `<atom:feed/>` parses to `""`, not an object.
  const feed = asRecord(doc["atom:feed"]) ?? {};
  const runs: TraceRunSummary[] = [];
  for (const raw of asArray(feed["atom:entry"])) {
    const entry = asRecord(raw);
    if (entry === undefined) continue;
    runs.push(parseRunEntry(entry));
  }
  return runs;
}

// -------------------------------------------------------------- requests ---

/** One `atom:entry` of the trace request feed. */
export interface TraceRequestSummary {
  id: string;
  title: string;
  description: string;
  published: string;
  /** The `atom:author` whose `trc:role` is `"trace"` — every entry also
   * carries an `"admin"`-role author, deliberately not exposed here. */
  traceUser: string;
  /** Text content of `trc:object`. */
  objectName: string;
  /** Last path segment of `trc:object/@trc:objectTypeId`, e.g. `"url"`. */
  objectType: string;
  /** Last path segment of `trc:processType/@trc:processTypeId`, e.g. `"http"`. */
  processType: string;
  isAggregated: boolean;
  expires?: string;
  maximalExecutions: number;
  completedExecutions: number;
}

/** The `atom:name` of the `atom:author` whose `trc:role` attribute is `role`. */
function authorByRole(authors: unknown, role: string): string {
  for (const raw of asArray(authors)) {
    const author = asRecord(raw);
    if (attr(author, "trc:role") !== role) continue;
    return elementText(author?.["atom:name"]) ?? "";
  }
  return "";
}

function parseRequestEntry(entry: Rec): TraceRequestSummary {
  const ext = asRecord(entry["trc:extendedData"]) ?? {};
  const object = asRecord(ext["trc:object"]);
  const processType = asRecord(ext["trc:processType"]);
  const executions = asRecord(ext["trc:executions"]);
  const expires = elementText(ext["trc:expires"]);
  return {
    id: elementText(entry["atom:id"]) ?? "",
    title: elementText(entry["atom:title"]) ?? "",
    description: elementText(ext["trc:description"]) ?? "",
    published: elementText(entry["atom:published"]) ?? "",
    traceUser: authorByRole(entry["atom:author"], "trace"),
    objectName: elementText(ext["trc:object"]) ?? "",
    objectType: lastPathSegment(attr(object, "trc:objectTypeId")),
    processType: lastPathSegment(attr(processType, "trc:processTypeId")),
    isAggregated: isXmlTrue(elementText(ext["trc:isAggregated"])),
    ...(expires === undefined || expires === "" ? {} : { expires }),
    maximalExecutions: numAttr(executions, "trc:maximal"),
    completedExecutions: numAttr(executions, "trc:completed"),
  };
}

/**
 * Parse `GET /sap/bc/adt/runtime/traces/abaptraces/requests` — including
 * the body a create-`POST` echoes back (`requests-feed-created.xml`), and
 * `requests-feed-empty.xml`'s zero-entry feed, which returns `[]` rather
 * than throwing.
 */
export function parseTraceRequests(xml: string): TraceRequestSummary[] {
  const doc = parseDocument(xml, "request list");
  if (!("atom:feed" in doc)) {
    throw missingRoot("request list", "atom:feed", xml);
  }
  const feed = asRecord(doc["atom:feed"]) ?? {};
  const requests: TraceRequestSummary[] = [];
  for (const raw of asArray(feed["atom:entry"])) {
    const entry = asRecord(raw);
    if (entry === undefined) continue;
    requests.push(parseRequestEntry(entry));
  }
  return requests;
}

// -------------------------------------------------------------- hit list ---

/** One `trc:entry` of a trace's hit list. */
export interface TraceHitEntry {
  /** `@topDownIndex` — the feed is ALREADY sorted by net time descending. */
  rank: number;
  index: number;
  hitCount: number;
  description: string;
  /** `trc:calledProgram/@adtcore:context` — often `""`. */
  calledProgram: string;
  callingProgram?: TraceProgramRef;
  grossTime: TraceTimeValue;
  netTime: TraceTimeValue;
  /** Links this row to a {@link TraceDbAccess} index. Absent on a non-DB row. */
  dbAccessAnchor?: number;
}

function parseHitEntry(node: Rec): TraceHitEntry {
  const callingProgram = parseProgramRef(programRefNode(node, "trc:callingProgram"));
  const dbAccessAnchor = attr(node, "dbAccessAnchor");
  return {
    rank: numAttr(node, "topDownIndex"),
    index: numAttr(node, "index"),
    hitCount: numAttr(node, "hitCount"),
    description: attrOrEmpty(node, "description"),
    calledProgram: attrOrEmpty(programRefNode(node, "trc:calledProgram"), "adtcore:context"),
    ...(callingProgram === undefined ? {} : { callingProgram }),
    grossTime: timeValue(node["trc:grossTime"]),
    netTime: timeValue(node["trc:traceEventNetTime"]),
    ...(dbAccessAnchor === undefined || dbAccessAnchor === ""
      ? {}
      : { dbAccessAnchor: toNumber(dbAccessAnchor) }),
  };
}

/** Parse `GET …/abaptraces/{id}/hitlist`. */
export function parseTraceHitList(xml: string): {
  parentId: string;
  entries: TraceHitEntry[];
} {
  const doc = parseDocument(xml, "hit list");
  const root = asRecord(doc["trc:hitlist"]);
  if (root === undefined) throw missingRoot("hit list", "trc:hitlist", xml);

  const entries: TraceHitEntry[] = [];
  for (const raw of asArray(root["trc:entry"])) {
    const node = asRecord(raw);
    if (node === undefined) continue;
    entries.push(parseHitEntry(node));
  }
  return { parentId: parentId(root), entries };
}

// ---------------------------------------------------------- db accesses ---

/** One `trc:dbAccess` row. */
export interface TraceDbAccess {
  index: number;
  /** May be `"<DB Access from Kernel>"` (XML-escaped in the source). */
  tableName: string;
  /** `"select"` | `"select single"` | `"select count(*)"` | `""` … */
  statement: string;
  /** `"OpenSQL"` | `"EXEC SQL"` | `""`. */
  type: string;
  totalCount: number;
  bufferedCount: number;
  /** `trc:accessTime/@total`. */
  totalTime: number;
  applicationServerTime: number;
  databaseTime: number;
  ratioOfTraceTotal: number;
  callingProgram?: TraceProgramRef;
}

/** One `trc:table` dictionary entry backing a {@link TraceDbAccess}. */
export interface TraceTableInfo {
  name: string;
  /** `trc:table/@type` — `"TRANSP"` etc. NOT `adtcore:type`: see the
   * `removeNSPrefix` collision comment at the top of this module. */
  tableClass: string;
  description: string;
  bufferMode: string;
  package: string;
}

function parseDbAccess(node: Rec): TraceDbAccess {
  const accessTime = asRecord(node["trc:accessTime"]);
  const callingProgram = parseProgramRef(programRefNode(node, "trc:callingProgram"));
  return {
    index: numAttr(node, "index"),
    tableName: attrOrEmpty(node, "tableName"),
    statement: attrOrEmpty(node, "statement"),
    type: attrOrEmpty(node, "type"),
    totalCount: numAttr(node, "totalCount"),
    bufferedCount: numAttr(node, "bufferedCount"),
    totalTime: numAttr(accessTime, "total"),
    applicationServerTime: numAttr(accessTime, "applicationServer"),
    databaseTime: numAttr(accessTime, "database"),
    ratioOfTraceTotal: numAttr(accessTime, "ratioOfTraceTotal"),
    ...(callingProgram === undefined ? {} : { callingProgram }),
  };
}

function parseTableInfo(node: Rec): TraceTableInfo {
  return {
    name: attrOrEmpty(node, "name"),
    // NOT `adtcore:type` — see this module's `removeNSPrefix` comment.
    tableClass: attrOrEmpty(node, "type"),
    description: attrOrEmpty(node, "description"),
    bufferMode: attrOrEmpty(node, "bufferMode"),
    package: attrOrEmpty(node, "adtcore:package"),
  };
}

/** Parse `GET …/abaptraces/{id}/dbAccesses`. */
export function parseTraceDbAccesses(xml: string): {
  parentId: string;
  totalDbTime: number;
  accesses: TraceDbAccess[];
  tables: TraceTableInfo[];
} {
  const doc = parseDocument(xml, "DB accesses");
  const root = asRecord(doc["trc:dbAccesses"]);
  if (root === undefined) throw missingRoot("DB accesses", "trc:dbAccesses", xml);

  const accesses: TraceDbAccess[] = [];
  for (const raw of asArray(root["trc:dbAccess"])) {
    const node = asRecord(raw);
    if (node === undefined) continue;
    accesses.push(parseDbAccess(node));
  }

  const tables: TraceTableInfo[] = [];
  for (const raw of asArray(asRecord(root["trc:tables"])?.["trc:table"])) {
    const node = asRecord(raw);
    if (node === undefined) continue;
    tables.push(parseTableInfo(node));
  }

  return {
    parentId: parentId(root),
    totalDbTime: numAttr(root, "totalDbTime"),
    accesses,
    tables,
  };
}

// ---------------------------------------------------------- call tree ---

/** One `trc:statement` row of a trace's call tree. */
export interface TraceStatementNode {
  index: number;
  id: number;
  callerId: number;
  /** `0` at the root; the call-tree depth. */
  callLevel: number;
  description: string;
  hitCount: number;
  subnodeCount: number;
  callingProgram?: TraceProgramRef;
  grossTime: TraceTimeValue;
  netTime: TraceTimeValue;
}

function parseStatement(node: Rec): TraceStatementNode {
  const callingProgram = parseProgramRef(programRefNode(node, "trc:callingProgram"));
  return {
    index: numAttr(node, "index"),
    id: numAttr(node, "id"),
    callerId: numAttr(node, "callerId"),
    callLevel: numAttr(node, "callLevel"),
    description: attrOrEmpty(node, "description"),
    hitCount: numAttr(node, "hitCount"),
    subnodeCount: numAttr(node, "subnodeCount"),
    ...(callingProgram === undefined ? {} : { callingProgram }),
    grossTime: timeValue(node["trc:grossTime"]),
    netTime: timeValue(node["trc:traceEventNetTime"]),
  };
}

/**
 * Parse `GET …/abaptraces/{id}/statements`. `count` is `trc:statements`'s
 * `m:count` attribute, observed as scientific notation (`"6.6E+2"` on
 * `statements-calltree-top20.xml`, a 20-row page of a 660-row tree) — parsed
 * with `Number(...)` and rounded, not `parseInt`, which would silently
 * return `6`.
 */
export function parseTraceStatements(xml: string): {
  parentId: string;
  count: number;
  statements: TraceStatementNode[];
} {
  const doc = parseDocument(xml, "call tree");
  const root = asRecord(doc["trc:statements"]);
  if (root === undefined) throw missingRoot("call tree", "trc:statements", xml);

  const statements: TraceStatementNode[] = [];
  for (const raw of asArray(root["trc:statement"])) {
    const node = asRecord(raw);
    if (node === undefined) continue;
    statements.push(parseStatement(node));
  }

  return {
    parentId: parentId(root),
    // `Math.round` here, and only here: `m:count`'s scientific-notation
    // literal (`"6.6E+2"`) survives `Number(...)` as `660` already, but
    // rounding guards against a literal landing on a non-integer boundary
    // (e.g. `"6.601E+2"`) — a row count must be a whole number.
    count: Math.round(numAttr(root, "m:count")),
    statements,
  };
}
