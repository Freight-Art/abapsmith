/**
 * ADT position-driven quick fixes: two HTTP hops, no write.
 *
 *   1. `POST /sap/bc/adt/quickfixes/evaluation?uri=<sourceUri>#start=L,C`
 *      body = the raw object source. Answers `qf:evaluationResults`, the
 *      menu of fixes available at that position.
 *   2. `POST <proposal.uri>` (verbatim, one of the evaluation's own
 *      `adtcore:uri`s). Answers `qf:proposalResult` > `deltas` > `unit`s —
 *      column-precise edits against the SAME source that was posted in hop 1.
 *
 * Every wire fact below is measured against `test/fixtures/live-captured/`
 * 800-811 (`qf-*`), not inferred from a spec — full detail lives in the git
 * history and in each fixture's `.meta.json` `note`.
 *
 * Delta semantics (load-bearing, see `range-edit.ts`'s header for the
 * applier side): line 1-based, column 0-based, range half-open/end-exclusive.
 * No `;end=` means a zero-width insertion, not malformed (805, 811). Empty
 * `<content/>` is a deletion (810). `<deltas/>` with no units is a legitimate
 * no-op (809). Units are NOT sorted — 810 has them descending; every range is
 * relative to the ORIGINAL posted source, never to a partially-applied one.
 * `ColumnRange` (`range-edit.ts`) is therefore a 1:1 map of the wire values,
 * no arithmetic — deliberately NOT `SourceRange`/`parseFragmentRange`
 * (`source.ts`), which are inclusive-end and round up to a whole line, which
 * would delete text a fix never touched.
 *
 * This module only builds requests and parses responses — it never calls
 * `applyRangeEdits` and never touches the write pipeline.
 */
import { XMLParser } from "fast-xml-parser";
import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import { type ErrorContext, translateAdtError } from "./session.js";
import type { ColumnRange, RangeEdit } from "./range-edit.js";
import { PARSE_EXCERPT_MAX, truncateText } from "../truncate.js";

const QUICKFIX_EVALUATION_URL = "/sap/bc/adt/quickfixes/evaluation";
/** Both hops use this exact media type on both `Content-Type` and `Accept` — fixtures 801-811. */
const QUICKFIX_MEDIA_TYPE = "application/*";

export interface QuickFixProposal {
  /** Last path segment of `uri`, e.g. "unimplemented_methods". */
  readonly id: string;
  /** Hop-2 POST target, verbatim from `adtcore:uri`. */
  readonly uri: string;
  /** `adtcore:type`, e.g. "add_unimplemented_method". */
  readonly type: string;
  /** `adtcore:name`. */
  readonly title: string;
  /** `adtcore:description` with HTML tags stripped and entities decoded. */
  readonly description: string;
  readonly parameterized: boolean;
  /** What the caller would have to supply, when known. */
  readonly parameter?: string;
  /** Decoded `userContent` document, when present. */
  readonly userContent?: string;
}

export interface QuickFixPosition {
  readonly line: number;
  readonly column: number;
}

/**
 * Fix types known to need interaction despite carrying no `userContent`.
 * `rename_quickfix` (fixture 802) has none, yet its own description says the
 * rename wizard opens on cross-unit usage, and fixture 803's hop-2 delta —
 * posted with an empty `userContent` — is an IDENTITY no-op: four units each
 * replacing `lv_text` with `lv_text`. Absence of `userContent` is therefore
 * not proof a fix is parameter-free; only this list and a present
 * `userContent` are. The label is what a caller must still supply.
 */
const INTERACTIVE_QUICKFIX_PARAMETER_LABELS: Readonly<Record<string, string>> = {
  rename_quickfix: "new name",
};
export const INTERACTIVE_QUICKFIX_TYPES: ReadonlySet<string> = new Set(
  Object.keys(INTERACTIVE_QUICKFIX_PARAMETER_LABELS),
);

export function quickFixFragmentUri(sourceUri: string, pos: QuickFixPosition): string {
  return `${sourceUri}#start=${pos.line},${pos.column}`;
}

function escapeXmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&apos;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the hop-2 proposal request body. Element structure, the
 * `adtcore:objectReference`/`adtcore:uri` attribute, and an empty
 * `userContent` all match fixture 805's recorded `requestBody` byte for
 * byte; indentation is cosmetic. `userContent` is only ever sent empty in
 * every captured fixture — 811 shows the server producing a full valid
 * delta for a parameterised fix even when the prefilled `userContent` it
 * offered in hop 1 is not echoed back — so omitting the argument reproduces
 * the recorded default-fix behaviour.
 */
export function buildProposalRequest(
  source: string,
  sourceUri: string,
  pos: QuickFixPosition,
  userContent?: string,
): string {
  const ref = `${sourceUri}#start=${pos.line},${pos.column}`;
  const uc = userContent ? escapeXmlText(userContent) : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `  <quickfixes:proposalRequest xmlns:quickfixes="http://www.sap.com/adt/quickfixes"\n` +
    `     xmlns:adtcore="http://www.sap.com/adt/core">\n` +
    `    <input>\n` +
    `      <content>${escapeXmlText(source)}</content>\n` +
    `      <adtcore:objectReference adtcore:uri="${escapeXmlText(ref)}"/>\n` +
    `    </input>\n` +
    `    <userContent>${uc}</userContent>\n` +
    `  </quickfixes:proposalRequest>`
  );
}

// ------------------------------------------------------------------ parsing --

/**
 * One instance serves both response shapes. `trimValues:false` is required
 * for `parseProposalDeltas` — `<content>`'s leading/trailing whitespace and
 * newlines are load-bearing (fixture 805's two leading spaces). It does not
 * hurt `parseEvaluationResults`: `adtcore:description` is trimmed again after
 * its HTML tags are stripped, so any surrounding whitespace this option
 * leaves in place (fixture 804's `generate_class_constructor` entry has a
 * leading space and two trailing spaces) is removed there anyway.
 */
const quickfixXml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  isArray: (_name, jpath, _isLeaf, isAttribute) =>
    !isAttribute &&
    typeof jpath === "string" &&
    (jpath === "evaluationResults.evaluationResult" || jpath === "proposalResult.deltas.unit"),
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

function attrOrEmpty(node: Rec | undefined, name: string): string {
  return attr(node, name) ?? "";
}

/** Element text: a bare string for an attribute-less leaf, `{"#text": …}` for one with attributes, `""` for self-closing. */
function elementText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  const rec = asRecord(value);
  if (rec === undefined) return undefined;
  const text = rec["#text"];
  return typeof text === "string" ? text : "";
}

function parseXmlDocument(body: string, what: string): Rec {
  let parsed: unknown;
  try {
    parsed = quickfixXml.parse(body);
  } catch (e) {
    throw new AbapError(
      "ADT_ERROR",
      `The ${what} response could not be parsed as XML.`,
      { what, detail: e instanceof Error ? e.message : String(e) },
      "The server answered with something other than the expected quick-fix document.",
    );
  }
  const rec = asRecord(parsed);
  if (rec === undefined) {
    throw new AbapError(
      "ADT_ERROR",
      `The ${what} response was empty or not a document.`,
      { what, length: body.length },
      "The server answered with something other than the expected quick-fix document.",
    );
  }
  return rec;
}

function missingRoot(what: string, root: string, body: string): AbapError {
  return new AbapError(
    "ADT_ERROR",
    `The ${what} response has no <${root}> element.`,
    { what, root, preview: truncateText(body, PARSE_EXCERPT_MAX) },
    "This ADT release may answer quick fixes differently from what this client expects.",
  );
}

/**
 * `<p>Creates <b>x</b>.</p><p>Also y.</p>` → `Creates x. Also y.`. Entities are
 * already decoded by the XML parser itself. Tags become a space, not empty,
 * so adjacent block elements don't run together; the space is then dropped
 * again before punctuation (inline `<b>lcl</b>.` must not become `lcl .`).
 * Collapsing to one space also keeps an embedded newline from breaking
 * textTable's row alignment.
 */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

/** Last non-empty path segment, e.g. ".../quickfixes/unimplemented_methods" → "unimplemented_methods". */
function lastPathSegment(uri: string): string {
  const segments = uri.split("/").filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? uri;
}

/** First element tag after any `<?xml ...?>` prolog, namespace prefix stripped. */
const ROOT_ELEMENT_RE = /^\s*(?:<\?[^>]*\?>\s*)?<(?:[\w.-]+:)?([\w.-]+)/;

/**
 * What the caller would have to supply, named mechanically off the wire
 * rather than guessed from prose. A present `userContent` is the server's
 * own pre-filled input document for the dialog it would otherwise open
 * (fixtures 804/811: root `generateConstructor` for both
 * `generate_factory_method` and `generate_constructor`) — its root element's
 * local name says what shape of document is needed. `rename_quickfix` has no
 * `userContent` at all (fixture 802), so its deny-list entry carries a fixed
 * label instead.
 */
function deriveParameter(type: string, userContent: string | undefined): string | undefined {
  if (userContent) {
    const m = ROOT_ELEMENT_RE.exec(userContent);
    if (m) return m[1];
  }
  return INTERACTIVE_QUICKFIX_PARAMETER_LABELS[type];
}

/** Parse hop 1's `qf:evaluationResults`. */
export function parseEvaluationResults(xml: string): QuickFixProposal[] {
  const doc = parseXmlDocument(xml, "quick-fix evaluation");
  const rootValue = doc["evaluationResults"];
  // A childless <qf:evaluationResults/> parses as "" (a string), not a
  // record — that IS the legitimate zero-results shape (fixture 801), so
  // only a genuinely absent key is treated as a wrong-root failure.
  if (rootValue === undefined) throw missingRoot("quick-fix evaluation", "qf:evaluationResults", xml);
  const root = asRecord(rootValue) ?? {};

  const results: QuickFixProposal[] = [];
  for (const raw of asArray(root["evaluationResult"])) {
    const node = asRecord(raw);
    if (node === undefined) continue;
    const ref = asRecord(node["objectReference"]);
    const uri = attrOrEmpty(ref, "uri");
    if (uri === "") continue;
    const type = attrOrEmpty(ref, "type");
    const title = attrOrEmpty(ref, "name");
    const description = stripHtml(attrOrEmpty(ref, "description"));

    const rawUserContent = elementText(node["userContent"]);
    const userContent = rawUserContent !== undefined && rawUserContent.trim() !== "" ? rawUserContent : undefined;

    const parameterized = userContent !== undefined || INTERACTIVE_QUICKFIX_TYPES.has(type);
    const parameter = deriveParameter(type, userContent);

    results.push({
      id: lastPathSegment(uri),
      uri,
      type,
      title,
      description,
      parameterized,
      ...(parameter !== undefined ? { parameter } : {}),
      ...(userContent !== undefined ? { userContent } : {}),
    });
  }
  return results;
}

const DELTA_FRAGMENT_RE = /#start=(\d+),(\d+)(?:;end=(\d+),(\d+))?$/;

/**
 * `.../source/main#start=9,0` → zero-width insertion at (9,0) (fixture 805);
 * `.../source/main#start=5,4;end=5,16` → replacement of that half-open span
 * (fixture 806). No arithmetic — the wire values ARE the `ColumnRange`.
 */
export function parseDeltaFragment(uri: string): ColumnRange {
  const m = DELTA_FRAGMENT_RE.exec(uri);
  if (!m) {
    throw new AbapError(
      "UNSUPPORTED",
      `Quick-fix delta URI carries no usable "#start=line,column" fragment.`,
      { uri },
      "This client only applies quick-fix deltas that carry a column-precise start (and optional end) fragment.",
    );
  }
  const start = { line: Number(m[1]), column: Number(m[2]) };
  const end =
    m[3] !== undefined && m[4] !== undefined
      ? { line: Number(m[3]), column: Number(m[4]) }
      : { line: start.line, column: start.column };
  return { start, end };
}

/** Path portion of an ADT URI, before any `#` fragment. */
function uriPath(uri: string): string {
  const i = uri.indexOf("#");
  return i === -1 ? uri : uri.slice(0, i);
}

/**
 * Parse hop 2's `qf:proposalResult`. `expectedSourceUri` guards against a
 * unit that edits a second document: a single-object write cannot apply
 * that, and silently dropping the unit would produce a half-applied fix, so
 * this throws instead. `qf:proposalResult` also carries a
 * `variableSourceStates` element (echoed selection state for a follow-up
 * request) — abapsmith has no follow-up request to feed it, so it is read
 * nowhere in this module; it also carries a `<selection>` element (fixture
 * 805: `#start=10,0` vs. the delta's own `#start=9,0`) that is post-fix
 * cursor placement, not a second edit.
 */
export function parseProposalDeltas(xml: string, expectedSourceUri: string): RangeEdit[] {
  const doc = parseXmlDocument(xml, "quick-fix proposal");
  const root = asRecord(doc["proposalResult"]);
  if (root === undefined) throw missingRoot("quick-fix proposal", "qf:proposalResult", xml);

  const edits: RangeEdit[] = [];
  for (const raw of asArray(asRecord(root["deltas"])?.["unit"])) {
    const node = asRecord(raw);
    if (node === undefined) continue;
    const ref = asRecord(node["objectReference"]);
    const uri = attrOrEmpty(ref, "uri");
    const path = uriPath(uri);
    if (path !== expectedSourceUri) {
      throw new AbapError(
        "UNSUPPORTED",
        `A quick-fix delta unit targets a different object than the one being fixed.`,
        { expectedSourceUri, unitUri: uri },
        "This fix edits more than one document. Applying it as a single-object write would " +
          "silently drop the edit to the other document, so the whole fix was refused instead.",
      );
    }
    const content = elementText(node["content"]) ?? "";
    edits.push({ range: parseDeltaFragment(uri), content });
  }
  return edits;
}

// -------------------------------------------------------------------- wire --

/**
 * Hop 1: evaluate which quick fixes apply at `pos` in `source`. The request
 * body is the raw full source, no XML wrapper (fixture 801/802/804); the
 * fragment goes in the `uri` query parameter, which `AbapConnection` URL-
 * encodes on the way out.
 */
export async function evaluateQuickFixes(
  conn: AbapConnection,
  sourceUri: string,
  source: string,
  pos: QuickFixPosition,
): Promise<QuickFixProposal[]> {
  const ctx: ErrorContext = { operation: "quickfix evaluation", uri: sourceUri };
  let body: string;
  try {
    ({ body } = await conn.post(QUICKFIX_EVALUATION_URL, {
      headers: { "Content-Type": QUICKFIX_MEDIA_TYPE, Accept: QUICKFIX_MEDIA_TYPE },
      qs: { uri: quickFixFragmentUri(sourceUri, pos) },
      body: source,
    }));
  } catch (e) {
    throw translateAdtError(e, ctx);
  }
  return parseEvaluationResults(body);
}

/**
 * Hop 2: fetch one proposal's delta. Posts to `proposal.uri` verbatim — that
 * URI IS the fix, chosen by hop 1, not a fixed collection endpoint.
 */
export async function fetchQuickFixDelta(
  conn: AbapConnection,
  proposal: QuickFixProposal,
  req: { sourceUri: string; source: string; position: QuickFixPosition },
): Promise<readonly RangeEdit[]> {
  const ctx: ErrorContext = { operation: "quickfix proposal", uri: proposal.uri, name: proposal.title };
  const requestBody = buildProposalRequest(req.source, req.sourceUri, req.position);
  let body: string;
  try {
    ({ body } = await conn.post(proposal.uri, {
      headers: { "Content-Type": QUICKFIX_MEDIA_TYPE, Accept: QUICKFIX_MEDIA_TYPE },
      body: requestBody,
    }));
  } catch (e) {
    throw translateAdtError(e, ctx);
  }
  return parseProposalDeltas(body, req.sourceUri);
}
