/**
 * ATC response parsing — pure functions over response bodies, no socket.
 *
 *   - `GET  /sap/bc/adt/atc/customizing`      → {@link parseAtcCustomizing}
 *   - `POST /sap/bc/adt/atc/runs?worklistId=` → {@link parseAtcRunAck}
 *   - `GET  /sap/bc/adt/atc/worklists/{id}`   → {@link parseAtcWorklist}
 *
 * WARNING — unlike other parsers in `src/adt/`, element/attribute names here
 * are NOT verified against real ATC captures (none exist, in this repo or in
 * `abap-adt-api`). They are grounded only in that library's ATC decoders
 * (`atc.d.ts`, v8.4.1); tests beside this module use hand-written synthetic
 * XML. A few specific spots are weaker still and marked INFERRED at their
 * site. Every field is treated as optional regardless of what that decoder
 * requires, since a parser that throws on an unfamiliar release is worse than
 * one that reports a finding with no `checkTitle`.
 * Full reasoning: the git history.
 *
 * Diverges from the library deliberately: no value coercion (parser options
 * below keep `"0001"` as `"0001"`, not roundtripped through a number; only
 * `priority` is converted, explicitly), and findings are flattened out of
 * `objects/object/findings/finding` by {@link flattenFindings}, kept separate
 * from parsing so the nested shape stays available too.
 */

import { XMLParser } from "fast-xml-parser";
import { AbapError } from "./errors.js";
import { PARSE_EXCERPT_MAX, truncateText } from "../truncate.js";
import {
  parseAtcLocation,
  type AtcLocation,
  type AtcObjectSetRef,
} from "./atc-query.js";

// ----------------------------------------------------------------- parser ---

/**
 * House options (mirrors `dumps-xml.ts:73`). Coercion is off on both
 * switches — zero-padded ids (message id `"0001"`, the worklist id) would
 * otherwise parse as numbers and come back wrong. `isArray` is required, not
 * tidy: fast-xml-parser collapses a one-element list to a bare object, and
 * single-member collections (one object, one finding) are the common case.
 */
const atcXml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  // `typeof` guard: `jpath` is `string | MatcherView` in fast-xml-parser v5,
  // a string only while default `jPath: true` holds. `isAttribute` matters
  // because attributes share the element jpath space.
  isArray: (_name, jpath, _isLeaf, isAttribute) =>
    !isAttribute && typeof jpath === "string" && REPEATABLE_JPATHS.has(jpath),
});

/** Element paths (namespace prefixes already stripped) that are collections. */
const REPEATABLE_JPATHS: ReadonlySet<string> = new Set([
  // customizing
  "customizing.properties.property",
  "customizing.exemption.reasons.reason",
  // run acknowledgement
  "worklistRun.infos.info",
  // worklist
  "worklist.objectSets.objectSet",
  "worklist.objects.object",
  "worklist.objects.object.findings.finding",
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

/** An attribute's literal value. `""` is preserved — see `exemptionKind`. */
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
 * Parse the whole body, or fail with a message that says what was expected.
 * `fast-xml-parser` doesn't throw on most malformed input, it returns
 * something unusable — callers check for their root element instead of
 * trusting a successful parse.
 */
function parseDocument(body: string, what: string): Rec {
  let parsed: unknown;
  try {
    parsed = atcXml.parse(body);
  } catch (e) {
    throw new AbapError(
      "ADT_ERROR",
      `The ATC ${what} response could not be parsed as XML.`,
      { what, detail: e instanceof Error ? e.message : String(e) },
      "The server answered with something other than the expected ATC document.",
    );
  }
  const rec = asRecord(parsed);
  if (rec === undefined) {
    throw new AbapError(
      "ADT_ERROR",
      `The ATC ${what} response was empty or not a document.`,
      { what, length: body.length },
      "The server answered with something other than the expected ATC document.",
    );
  }
  return rec;
}

function missingRoot(what: string, root: string, body: string): AbapError {
  return new AbapError(
    "ADT_ERROR",
    `The ATC ${what} response has no <${root}> element.`,
    // truncateText discloses how much was cut, unlike a silent `.slice()`.
    { what, root, preview: truncateText(body, PARSE_EXCERPT_MAX) },
    "This ADT release may describe ATC differently from what this client expects; " +
      "see abap://system for the collections it does publish.",
  );
}

// ------------------------------------------------------------ customizing ---

/** A `customizing/properties/property` entry. */
export interface AtcProperty {
  readonly name: string;
  readonly value: string;
}

/** A `customizing/exemption/reasons/reason` entry. */
export interface AtcExemptionReason {
  readonly id: string;
  readonly title: string;
  readonly justificationMandatory: boolean;
}

/** The ATC customizing document, reduced to what this client reads from it. */
export interface AtcCustomizing {
  readonly properties: readonly AtcProperty[];
  readonly exemptionReasons: readonly AtcExemptionReason[];
}

/**
 * Parse `GET /sap/bc/adt/atc/customizing`. Only `systemCheckVariant` is
 * actually needed; the rest are kept so the system's other ATC settings can
 * be named in an error message.
 */
export function parseAtcCustomizing(body: string): AtcCustomizing {
  const doc = parseDocument(body, "customizing");
  const root = asRecord(doc["customizing"]);
  if (root === undefined) throw missingRoot("customizing", "customizing", body);

  const properties: AtcProperty[] = [];
  for (const raw of asArray(asRecord(root["properties"])?.["property"])) {
    const node = asRecord(raw);
    const name = attr(node, "name");
    if (name === undefined || name === "") continue;
    properties.push({ name, value: attrOrEmpty(node, "value") });
  }

  const exemptionReasons: AtcExemptionReason[] = [];
  const reasons = asRecord(asRecord(root["exemption"])?.["reasons"])?.["reason"];
  for (const raw of asArray(reasons)) {
    const node = asRecord(raw);
    const id = attr(node, "id");
    if (id === undefined || id === "") continue;
    exemptionReasons.push({
      id,
      title: attrOrEmpty(node, "title"),
      justificationMandatory: isXmlTrue(attr(node, "justificationMandatory")),
    });
  }

  return { properties, exemptionReasons };
}

/**
 * The system's default check variant, or `undefined` when customizing names
 * none — a real answer (unconfigured ATC), not a reason to invent `DEFAULT`
 * and let the server 404 on it.
 */
export function systemCheckVariant(
  customizing: AtcCustomizing,
  property: string,
): string | undefined {
  const found = customizing.properties.find((p) => p.name === property);
  const value = found?.value?.trim();
  return value === undefined || value === "" ? undefined : value;
}

// ---------------------------------------------------------- run acknowledge --

/** An `<info>` on a run acknowledgement — a server remark about the run. */
export interface AtcRunInfo {
  readonly type: string;
  readonly description: string;
}

/** The response to `POST /sap/bc/adt/atc/runs`. */
export interface AtcRunAck {
  /** `worklistRun/worklistId` — the worklist to read findings from. */
  readonly worklistId: string;
  /** `worklistRun/worklistTimestamp`, verbatim; conversion is the caller's. */
  readonly timestamp?: string;
  /** Server remarks. Usually empty; when it is not, it explains a thin result. */
  readonly infos: readonly AtcRunInfo[];
}

/**
 * Parse the run acknowledgement. `worklistId`/`worklistTimestamp` are child
 * elements of `<worklistRun>`, not attributes (grounded via the library's
 * `xmlNode` usage). The id is echoed back rather than derived, so a release
 * answering with a different worklist is trusted over the one that was sent.
 */
export function parseAtcRunAck(body: string): AtcRunAck {
  const doc = parseDocument(body, "run");
  const root = asRecord(doc["worklistRun"]);
  if (root === undefined) throw missingRoot("run", "worklistRun", body);

  const worklistId = elementText(root["worklistId"])?.trim() ?? "";
  const timestamp = elementText(root["worklistTimestamp"])?.trim();

  const infos: AtcRunInfo[] = [];
  for (const raw of asArray(asRecord(root["infos"])?.["info"])) {
    // INFERRED shape (see header) — both element and attribute forms are read
    // rather than risk dropping a server remark over a guess.
    const node = asRecord(raw);
    const type = elementText(node?.["type"]) ?? attr(node, "type") ?? "";
    const description =
      elementText(node?.["description"]) ??
      attr(node, "description") ??
      elementText(raw) ??
      "";
    if (type === "" && description === "") continue;
    infos.push({ type, description });
  }

  return {
    worklistId,
    ...(timestamp === undefined || timestamp === "" ? {} : { timestamp }),
    infos,
  };
}

// ----------------------------------------------------------------- worklist --

/** One ATC finding, as it sits under its object on the wire. */
export interface AtcFinding {
  /** The finding's own ADT URI (the marker resource). */
  readonly uri: string;
  /** Source position, split out of the `location` fragment. */
  readonly location: AtcLocation;
  /** 1 = error, 2 = warning, 3 = information. `0` when absent/unparseable. */
  readonly priority: number;
  readonly checkId: string;
  readonly checkTitle: string;
  readonly messageId: string;
  readonly messageTitle: string;
  /** `""` when the finding carries no exemption; `"A"`/`"I"` are known values. */
  readonly exemptionKind: string;
  readonly exemptionApproval: string;
  /** Present when ATC offers a quick fix; opaque token, not acted on here. */
  readonly quickfixInfo?: string;
}

/** One checked object and everything ATC found in it. */
export interface AtcObject {
  readonly uri: string;
  readonly name: string;
  readonly type: string;
  readonly packageName?: string;
  readonly author?: string;
  readonly objectTypeId?: string;
  readonly findings: readonly AtcFinding[];
}

/** The worklist document. */
export interface AtcWorklist {
  readonly id: string;
  /** `@timestamp` verbatim; conversion to seconds is the caller's. */
  readonly timestamp?: string;
  /** Which object set this read was scoped to, as the server understood it. */
  readonly usedObjectSet?: string;
  /** `false` means ATC stopped early (e.g. `maximumVerdicts` reached); the
   * caller MUST say so, not present a truncated list as clean. */
  readonly objectSetIsComplete: boolean;
  readonly objectSets: readonly AtcObjectSetRef[];
  readonly objects: readonly AtcObject[];
}

/** Parse `GET /sap/bc/adt/atc/worklists/{id}`. */
export function parseAtcWorklist(body: string): AtcWorklist {
  const doc = parseDocument(body, "worklist");
  const root = asRecord(doc["worklist"]);
  if (root === undefined) throw missingRoot("worklist", "worklist", body);

  const objectSets: AtcObjectSetRef[] = [];
  for (const raw of asArray(asRecord(root["objectSets"])?.["objectSet"])) {
    const node = asRecord(raw);
    const name = attr(node, "name");
    if (name === undefined) continue;
    const title = attr(node, "title");
    objectSets.push({
      name,
      kind: attrOrEmpty(node, "kind"),
      ...(title === undefined || title === "" ? {} : { title }),
    });
  }

  const objects: AtcObject[] = [];
  for (const raw of asArray(asRecord(root["objects"])?.["object"])) {
    const node = asRecord(raw);
    if (node === undefined) continue;
    objects.push(parseObject(node));
  }

  const timestamp = attr(root, "timestamp");
  const usedObjectSet = attr(root, "usedObjectSet");
  return {
    id: attrOrEmpty(root, "id"),
    ...(timestamp === undefined || timestamp === "" ? {} : { timestamp }),
    ...(usedObjectSet === undefined || usedObjectSet === ""
      ? {}
      : { usedObjectSet }),
    // Absent means complete — else every release that omits it looks truncated.
    objectSetIsComplete: attr(root, "objectSetIsComplete") === undefined
      ? true
      : isXmlTrue(attr(root, "objectSetIsComplete")),
    objectSets,
    objects,
  };
}

function parseObject(node: Rec): AtcObject {
  const findings: AtcFinding[] = [];
  for (const raw of asArray(asRecord(node["findings"])?.["finding"])) {
    const f = asRecord(raw);
    if (f === undefined) continue;
    findings.push(parseFinding(f));
  }
  const packageName = attr(node, "packageName");
  const author = attr(node, "author");
  const objectTypeId = attr(node, "objectTypeId");
  return {
    uri: attrOrEmpty(node, "uri"),
    name: attrOrEmpty(node, "name"),
    type: attrOrEmpty(node, "type"),
    ...(packageName === undefined || packageName === "" ? {} : { packageName }),
    ...(author === undefined || author === "" ? {} : { author }),
    ...(objectTypeId === undefined || objectTypeId === ""
      ? {}
      : { objectTypeId }),
    findings,
  };
}

function parseFinding(node: Rec): AtcFinding {
  const quickfixInfo = attr(node, "quickfixInfo");
  return {
    uri: attrOrEmpty(node, "uri"),
    location: parseAtcLocation(attr(node, "location")),
    // Absent/unparseable becomes 0, rendered as `prio 0`, not mislabelled an error.
    priority: parsePriority(attr(node, "priority")),
    checkId: attrOrEmpty(node, "checkId"),
    checkTitle: attrOrEmpty(node, "checkTitle"),
    messageId: attrOrEmpty(node, "messageId"),
    messageTitle: attrOrEmpty(node, "messageTitle"),
    exemptionKind: attrOrEmpty(node, "exemptionKind"),
    exemptionApproval: attrOrEmpty(node, "exemptionApproval"),
    ...(quickfixInfo === undefined || quickfixInfo === ""
      ? {}
      : { quickfixInfo }),
  };
}

function parsePriority(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------- flatten ---

/** A finding with its object's identity attached. */
export interface FlatAtcFinding extends AtcFinding {
  readonly objectName: string;
  readonly objectType: string;
  readonly objectUri: string;
  readonly packageName?: string;
}

/**
 * Flatten `objects[].findings[]` into one list, most severe first (priority
 * ascending, then object and line), so a truncated rendering keeps errors
 * over informational notes. Ties break deterministically for stable output.
 */
export function flattenFindings(
  worklist: AtcWorklist,
): readonly FlatAtcFinding[] {
  const out: FlatAtcFinding[] = [];
  for (const obj of worklist.objects) {
    for (const f of obj.findings) {
      out.push({
        ...f,
        objectName: obj.name,
        objectType: obj.type,
        objectUri: obj.uri,
        ...(obj.packageName === undefined ? {} : { packageName: obj.packageName }),
      });
    }
  }
  out.sort((a, b) => {
    // Priority 0 means "the server did not say"; it sorts last rather than
    // first, which is what a naive numeric ascending sort would do.
    const pa = a.priority === 0 ? Number.MAX_SAFE_INTEGER : a.priority;
    const pb = b.priority === 0 ? Number.MAX_SAFE_INTEGER : b.priority;
    if (pa !== pb) return pa - pb;
    if (a.objectName !== b.objectName) {
      return a.objectName < b.objectName ? -1 : 1;
    }
    const la = a.location.line ?? Number.MAX_SAFE_INTEGER;
    const lb = b.location.line ?? Number.MAX_SAFE_INTEGER;
    if (la !== lb) return la - lb;
    if (a.checkId !== b.checkId) return a.checkId < b.checkId ? -1 : 1;
    return a.messageTitle < b.messageTitle ? -1 : a.messageTitle > b.messageTitle ? 1 : 0;
  });
  return out;
}

/** Count of findings by priority, for the response header. */
export interface AtcCounts {
  readonly total: number;
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
  readonly other: number;
  readonly exempted: number;
}

/** Tally {@link flattenFindings} output by priority. */
export function countFindings(
  findings: readonly FlatAtcFinding[],
): AtcCounts {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  let other = 0;
  let exempted = 0;
  for (const f of findings) {
    if (f.priority === 1) errors += 1;
    else if (f.priority === 2) warnings += 1;
    else if (f.priority === 3) infos += 1;
    else other += 1;
    if (f.exemptionKind !== "") exempted += 1;
  }
  return { total: findings.length, errors, warnings, infos, other, exempted };
}
