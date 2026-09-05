/**
 * BOPF whole-model XML engine — byte-splice, not DOM round-trip.
 *
 * Every boolean/enum attribute is `unsettable="true"` (absent ≠
 * present-at-default), GUID re-encoding must never happen (echo exactly what
 * was read), and child order is load-bearing — a parse→build→serialise round
 * trip preserves none of the three. So `scanModel`/`locate`/`insertionPoint`/
 * `splice`/`spliceOut` mutate the raw response bytes in place; nothing here
 * reconstructs a document from a parsed tree. `parseModel` is the one
 * exception: a read-only view over `fast-xml-parser` for `show`/`check_refs`/
 * the runtime generator, never serialised back.
 *
 * The scanner is strict and refuses rather than guesses (see `parsePackageRef`,
 * `src/adt/write.ts:465`) — see the git history for
 * exactly what input shape it was built and tested against.
 *
 * Attribute/child order tables live in `bopf-types.ts`, not here — this file
 * is the mechanism, that file is the (wire-verified) data.
 */

import { randomBytes } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { AbapError } from "./errors.js";
import {
  type AdtObjectRef,
  type AdtVersionType,
  type BoAction,
  type BoAlternativeKey,
  type BoAssociation,
  type BoDetermination,
  type BoDeterminationTrigger,
  type BoModel,
  type BoNode,
  type BoProperty,
  type BoQuery,
  type BoRelation,
  type BoValidation,
  type BoValidationTrigger,
  type BusinessObjectCategoryType,
  type ElementKind,
  ACTION_ATTR_ORDER,
  ACTION_CHILD_ORDER,
  ALTERNATIVE_KEY_ATTR_ORDER,
  ALTERNATIVE_KEY_CHILD_ORDER,
  ASSOCIATION_ATTR_ORDER,
  ASSOCIATION_CHILD_ORDER,
  DETERMINATION_ATTR_ORDER,
  DETERMINATION_CHILD_ORDER,
  DETERMINATION_TRIGGER_ATTR_ORDER,
  GUID_ENCODING,
  KEY_ELEMENT_ATTR_ORDER,
  NODE_ATTR_ORDER,
  NODE_CHILD_ORDER,
  PROPERTY_ATTR_ORDER,
  QUERY_ATTR_ORDER,
  QUERY_CHILD_ORDER,
  RELATION_ATTR_ORDER,
  VALIDATION_ATTR_ORDER,
  VALIDATION_CHILD_ORDER,
  VALIDATION_TRIGGER_ATTR_ORDER,
} from "./bopf-types.js";

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new AbapError(
    "BAD_INPUT",
    `BOPF XML: ${message}`,
    details,
    "The scanner refuses to guess at malformed or unsupported input — fix the source document rather than relying on a silent fallback.",
  );
}

// ---------------------------------------------------------------------------
// The scanner: raw bytes -> a flat, sorted array of element tokens.
// ---------------------------------------------------------------------------

export type TokenShape = "empty" | "container";

/** One token per XML element. `openEnd` is just past `>` (container) or `/>` (empty); `closeEnd` is just past the closing `>`, equal to `openEnd` for an empty element. */
export interface Token {
  readonly kind: TokenShape;
  readonly name: string;
  readonly depth: number;
  readonly attrStart: number;
  readonly openStart: number;
  readonly openEnd: number;
  readonly closeEnd: number;
  readonly attrs: ReadonlyMap<string, string>;
}

const WS = /\s/;
const NAME_RE = /[A-Za-z_][-.\w]*(?::[A-Za-z_][-.\w]*)?/y;

function matchNameAt(s: string, pos: number): string | undefined {
  NAME_RE.lastIndex = pos;
  const m = NAME_RE.exec(s);
  return m ? m[0] : undefined;
}

function skipWs(s: string, pos: number): number {
  let p = pos;
  while (p < s.length && WS.test(s.charAt(p))) p++;
  return p;
}

const PREDEFINED_ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&apos;", "'"],
  ["&quot;", '"'],
];

function decodeEntityAt(xml: string, ampIndex: number): { char: string; next: number } {
  for (const [entity, char] of PREDEFINED_ENTITIES) {
    if (xml.startsWith(entity, ampIndex)) return { char, next: ampIndex + entity.length };
  }
  fail(
    "unsupported entity reference — only the five predefined XML entities (&amp; &lt; &gt; &apos; &quot;) are accepted",
    { at: ampIndex },
  );
}

interface OpenRecord {
  readonly name: string;
  readonly depth: number;
  readonly attrStart: number;
  readonly openStart: number;
  readonly openEnd: number;
  readonly attrs: ReadonlyMap<string, string>;
}

/**
 * Tokenize a BOPF v4 XML document into a flat, document-order array of
 * element tokens. Throws `BAD_INPUT` on anything the ten captures never
 * contain — see the module doc comment. Never partially mutates anything;
 * either the whole document scans, or nothing does.
 */
export function scanModel(xmlText: string): readonly Token[] {
  if (!xmlText.startsWith("<?xml")) fail("document does not start with an XML declaration (`<?xml ... ?>`)");
  const declEnd = xmlText.indexOf("?>", 5);
  if (declEnd === -1) fail("unterminated XML declaration");

  const n = xmlText.length;
  const tokens: Token[] = [];
  const stack: OpenRecord[] = [];
  let i = declEnd + 2;

  while (i < n) {
    const c = xmlText.charAt(i);
    if (c !== "<") {
      if (!WS.test(c)) {
        fail(
          stack.length === 0
            ? "unexpected content outside the root element"
            : "text content is not supported inside BOPF elements (every element here is attribute-only or container-only)",
          { at: i },
        );
      }
      i++;
      continue;
    }

    if (xmlText.startsWith("<!--", i)) fail("XML comments are not supported", { at: i });
    if (xmlText.startsWith("<![CDATA[", i)) fail("CDATA sections are not supported", { at: i });
    if (xmlText.startsWith("<!DOCTYPE", i)) fail("a DOCTYPE declaration is not supported", { at: i });
    if (xmlText.startsWith("<!", i)) fail("unrecognized '<!' construct", { at: i });
    if (xmlText.startsWith("<?", i)) fail("a processing instruction after the XML declaration is not supported", { at: i });

    if (xmlText.startsWith("</", i)) {
      const name = matchNameAt(xmlText, i + 2);
      if (name === undefined) fail("malformed closing tag", { at: i });
      let j = skipWs(xmlText, i + 2 + name.length);
      if (xmlText.charAt(j) !== ">") fail("malformed closing tag: expected '>'", { at: j });
      const closeEnd = j + 1;
      const top = stack.pop();
      if (!top) fail("unexpected closing tag with no matching open element", { at: i, name });
      if (top.name !== name) {
        fail(`mismatched closing tag: expected </${top.name}>, found </${name}>`, { at: i });
      }
      tokens.push({
        kind: "container",
        name: top.name,
        depth: top.depth,
        attrStart: top.attrStart,
        openStart: top.openStart,
        openEnd: top.openEnd,
        closeEnd,
        attrs: top.attrs,
      });
      i = closeEnd;
      continue;
    }

    // Opening or self-closing tag.
    const name = matchNameAt(xmlText, i + 1);
    if (name === undefined) fail("malformed tag: expected an element name", { at: i });
    let j = i + 1 + name.length;
    const attrStart = j;
    const attrs = new Map<string, string>();
    let selfClosing = false;
    for (;;) {
      j = skipWs(xmlText, j);
      if (xmlText.charAt(j) === "/" && xmlText.charAt(j + 1) === ">") {
        selfClosing = true;
        j += 2;
        break;
      }
      if (xmlText.charAt(j) === ">") {
        j += 1;
        break;
      }
      const attrName = matchNameAt(xmlText, j);
      if (attrName === undefined) fail(`unexpected character inside <${name}>`, { at: j });
      j += attrName.length;
      j = skipWs(xmlText, j);
      if (xmlText.charAt(j) !== "=") fail(`expected '=' after attribute "${attrName}"`, { at: j });
      j = skipWs(xmlText, j + 1);
      const quote = xmlText.charAt(j);
      if (quote !== '"' && quote !== "'") fail(`expected a quote to start the value of "${attrName}"`, { at: j });
      j++;
      let value = "";
      for (;;) {
        if (j >= n) fail(`unterminated attribute value for "${attrName}"`, { at: j });
        const vc = xmlText.charAt(j);
        if (vc === quote) {
          j++;
          break;
        }
        if (vc === "<") fail(`raw '<' is not allowed inside the value of "${attrName}"`, { at: j });
        if (vc === "&") {
          const decoded = decodeEntityAt(xmlText, j);
          value += decoded.char;
          j = decoded.next;
          continue;
        }
        value += vc;
        j++;
      }
      if (attrs.has(attrName)) fail(`duplicate attribute "${attrName}"`, { at: j });
      attrs.set(attrName, value);
    }

    if (selfClosing) {
      tokens.push({
        kind: "empty",
        name,
        depth: stack.length,
        attrStart,
        openStart: i,
        openEnd: j,
        closeEnd: j,
        attrs,
      });
    } else {
      stack.push({ name, depth: stack.length, attrStart, openStart: i, openEnd: j, attrs });
    }
    i = j;
  }

  if (stack.length > 0) fail(`unclosed element(s): ${stack.map((s) => s.name).join(", ")}`);
  const roots = tokens.filter((t) => t.depth === 0);
  if (roots.length !== 1) fail(`document must have exactly one root element (found ${roots.length})`);

  tokens.sort((a, b) => a.openStart - b.openStart);
  return tokens;
}

// ---------------------------------------------------------------------------
// Locating elements
// ---------------------------------------------------------------------------

const ELEMENT_TAG: Readonly<Record<ElementKind, string>> = {
  node: "bo:nodes",
  association: "bo:associations",
  action: "bo:actions",
  determination: "bo:determinations",
  validation: "bo:validations",
  query: "bo:queries",
  alternativeKey: "bo:alternativeKeys",
};

/** The six element kinds that live *inside* a `bo:nodes` element. Excludes `"node"` itself — see the module gaps note near `spliceInsertChild`. */
export type ChildElementKind = Exclude<ElementKind, "node">;

function bareName(qualifiedName: string): string {
  const idx = qualifiedName.indexOf(":");
  return idx === -1 ? qualifiedName : qualifiedName.slice(idx + 1);
}

function findNodeToken(tokens: readonly Token[], name: string, nodeId?: string): Token | undefined {
  return tokens.find(
    (t) =>
      t.name === "bo:nodes" &&
      t.attrs.get("bo:name") === name &&
      (nodeId === undefined || t.attrs.get("bo:nodeID") === nodeId),
  );
}

export interface Range {
  readonly start: number;
  readonly end: number;
}

export interface NodeSelector {
  readonly node: string;
  /** Disambiguator when node name alone is not unique. Client-side validation rejects duplicate node names, so this is normally unnecessary. */
  readonly nodeId?: string;
}

export interface ChildSelector extends NodeSelector {
  readonly child: ChildElementKind;
  /** `bo:name` of the child — associations may legitimately be `""`. */
  readonly name: string;
  /** Disambiguator when `name` is not unique among siblings of this kind (association name `""` is not unique — 14 cases in the SAP demo BO). */
  readonly memberId?: string;
}

export type Selector = NodeSelector | ChildSelector;

function isChildSelector(sel: Selector): sel is ChildSelector {
  return "child" in sel;
}

/** Every child element of `kind` directly under `nodeTok`, in document order (`tokens` is scanModel-sorted by `openStart`, so a filter preserves order). Shared by `locate`'s child branch and `listChildNames`. */
function childTokensOfKind(tokens: readonly Token[], nodeTok: Token, kind: ChildElementKind): Token[] {
  const tag = ELEMENT_TAG[kind];
  return tokens.filter(
    (t) => t.name === tag && t.depth === nodeTok.depth + 1 && t.openStart > nodeTok.openStart && t.openStart < nodeTok.closeEnd,
  );
}

/** Find the `Token` for the element a selector names (node or child), or `undefined` if no match. */
export function locateToken(tokens: readonly Token[], sel: Selector): Token | undefined {
  const nodeTok = findNodeToken(tokens, sel.node, sel.nodeId);
  if (!nodeTok) return undefined;
  if (!isChildSelector(sel)) return nodeTok;

  return childTokensOfKind(tokens, nodeTok, sel.child).find(
    (t) => t.attrs.get("bo:name") === sel.name && (sel.memberId === undefined || t.attrs.get("bo:nodeID") === sel.memberId),
  );
}

/**
 * Find the byte range `[start, end)` of the element a selector names, or
 * `undefined` if no match. `range.start`/`range.end` are exactly
 * `token.openStart`/`token.closeEnd` — the whole element, from its `<` to the
 * end of its closing `>` (or its own `/>` if self-closing).
 */
export function locate(tokens: readonly Token[], sel: Selector): Range | undefined {
  const t = locateToken(tokens, sel);
  return t ? { start: t.openStart, end: t.closeEnd } : undefined;
}

/**
 * `bo:name` of every child element of `kind` under the selected node, in
 * document order, duplicates included — a caller unwinding a duplicate-name
 * mess needs to see that a name appears more than once, not a
 * deduplicated set. Empty (not a throw) when the node itself doesn't match —
 * callers needing to distinguish "node missing" from "node has none of this
 * kind" already have `locate`/`findNodeToken` for that.
 */
export function listChildNames(tokens: readonly Token[], sel: NodeSelector, kind: ChildElementKind): readonly string[] {
  const nodeTok = findNodeToken(tokens, sel.node, sel.nodeId);
  if (!nodeTok) return [];
  return childTokensOfKind(tokens, nodeTok, kind).map((t) => t.attrs.get("bo:name") ?? "");
}

// ---------------------------------------------------------------------------
// ST-order-aware insertion points
// ---------------------------------------------------------------------------

type NodeChildTag = (typeof NODE_CHILD_ORDER)[number];

const PLURAL_BARE: Readonly<Record<ChildElementKind, NodeChildTag>> = {
  association: "associations",
  action: "actions",
  determination: "determinations",
  validation: "validations",
  query: "queries",
  alternativeKey: "alternativeKeys",
};

/** Byte offset, inside `nodeTok`, where a new `kind` element belongs per the wire's `xsd:sequence` order (`NODE_CHILD_ORDER`). `nodeTok` must be a container token — promote a self-closing node first (`spliceInsertChild` does this automatically). */
export function insertionPoint(tokens: readonly Token[], nodeTok: Token, kind: ChildElementKind): number {
  if (nodeTok.kind !== "container") {
    fail("cannot compute an insertion point inside a self-closing element — open it first", { node: nodeTok.name });
  }
  const targetBare = PLURAL_BARE[kind];
  const targetIdx = NODE_CHILD_ORDER.indexOf(targetBare);

  let insertAt = nodeTok.openEnd;
  for (const t of tokens) {
    if (t.depth !== nodeTok.depth + 1) continue;
    if (t.openStart <= nodeTok.openStart || t.openStart >= nodeTok.closeEnd) continue;
    const idx = NODE_CHILD_ORDER.indexOf(bareName(t.name) as NodeChildTag);
    if (idx === -1) continue; // not one of the ordered child kinds (shouldn't happen on a well-formed model) — ignore rather than guess where it sorts
    if (idx <= targetIdx) insertAt = t.closeEnd;
    else break; // first strictly-later-ordered sibling — insert right before it
  }
  return insertAt;
}

// ---------------------------------------------------------------------------
// Splice primitives
// ---------------------------------------------------------------------------

/** Insert `text` at byte offset `at`. `splice(xml, p, "")` is a no-op by construction for any valid `p` — this is what the binding acceptance test exercises. */
export function splice(xml: string, at: number, text: string): string {
  if (at < 0 || at > xml.length) fail("splice offset out of range", { at, length: xml.length });
  return xml.slice(0, at) + text + xml.slice(at);
}

/** Remove the byte range `[range.start, range.end)`. */
export function spliceOut(xml: string, range: Range): string {
  if (range.start < 0 || range.end > xml.length || range.start > range.end) {
    fail("splice-out range out of bounds", { range, length: xml.length });
  }
  return xml.slice(0, range.start) + xml.slice(range.end);
}

/** Rewrite a self-closing element's `.../>`  into an empty container `...></name>`, in place. No-op if already a container. */
function promoteToContainer(xml: string, token: Token): string {
  if (token.kind === "container") return xml;
  const tagText = xml.slice(token.openStart, token.openEnd);
  if (!tagText.endsWith("/>")) fail("expected a self-closing tag ending in '/>'", { at: token.openStart });
  const opened = tagText.slice(0, -2) + ">";
  return xml.slice(0, token.openStart) + opened + `</${token.name}>` + xml.slice(token.openEnd);
}

/**
 * Patch `bo:`-prefixed attributes on one element's own open tag, in place;
 * nothing past `token.openEnd` is touched, so the subtree survives
 * byte-for-byte. Keys are BARE names (`"category"`, not `"bo:category"`);
 * every attribute here is `unsettable` on the wire, so `null` REMOVES it
 * rather than writing `"false"`. Attribute order inside a tag is not
 * load-bearing on this wire (element order is).
 */
export function patchOpenTagAttrs(
  xml: string,
  token: Token,
  attrs: ReadonlyMap<string, string | boolean | null>,
): string {
  let openTag = xml.slice(token.openStart, token.openEnd);
  for (const [name, value] of attrs) {
    const attrRe = new RegExp(`\\s+bo:${name}="[^"]*"`);
    if (value === null) {
      openTag = openTag.replace(attrRe, "");
      continue;
    }
    const rendered = ` bo:${name}="${typeof value === "boolean" ? String(value) : escapeAttrValue(value, `bo:${name}`)}"`;
    if (attrRe.test(openTag)) {
      openTag = openTag.replace(attrRe, rendered);
    } else {
      const closesSelf = openTag.endsWith("/>");
      const insertAt = closesSelf ? openTag.length - 2 : openTag.length - 1;
      openTag = openTag.slice(0, insertAt) + rendered + openTag.slice(insertAt);
    }
  }
  return xml.slice(0, token.openStart) + openTag + xml.slice(token.openEnd);
}

/**
 * Insert a pre-rendered `fragment` (from a `render*Element` function below) as a new
 * child of node `nodeName`, respecting ST order; promotes a self-closing node to a
 * container first if needed. Scoped to an *existing* node — whole-document/root
 * composition lives in `bopf.ts` (`createBusinessObject`/`putModel`).
 */
export function spliceInsertChild(
  xml: string,
  tokens: readonly Token[],
  nodeName: string,
  kind: ChildElementKind,
  fragment: string,
  opts?: { nodeId?: string },
): string {
  const nodeTok = findNodeToken(tokens, nodeName, opts?.nodeId);
  if (!nodeTok) fail(`node "${nodeName}" not found`, { node: nodeName });
  if (nodeTok.kind === "empty") {
    const opened = promoteToContainer(xml, nodeTok);
    const insertAt = nodeTok.openEnd - 1; // promoteToContainer only drops the '/' at openEnd-2, so openEnd-1 is right after the new '>'
    return splice(opened, insertAt, fragment);
  }
  const at = insertionPoint(tokens, nodeTok, kind);
  return splice(xml, at, fragment);
}

/** The eight singular ref children of a `bo:nodes` element (`NODE_CHILD_ORDER`'s first eight entries) — distinct from the seven repeating groups `spliceInsertChild`/`ChildElementKind` cover. */
export const NODE_REF_KINDS = [
  "persistentStructureRef",
  "transientStructureRef",
  "combinedStructureRef",
  "combinedTableRef",
  "persistentTableRef",
  "defaultingClassRef",
  "dataAccessClassRef",
  "authorizationClassRef",
] as const;
export type NodeRefKind = (typeof NODE_REF_KINDS)[number];

/**
 * Set (insert or replace), or clear, one `refTag`-named singular ref child of
 * `ownerToken`, respecting `childOrder`'s `xsd:sequence` position. `ref ===
 * null` removes the element if present, no-op if already absent; replacing
 * an existing ref overwrites in place — at most one of each singular ref per
 * owner. `refTag` is the fully `bo:`-prefixed element name; `childOrder`
 * entries are bare names.
 */
export function spliceSetElementRef(
  xml: string,
  tokens: readonly Token[],
  ownerToken: Token,
  refTag: string,
  ref: AdtObjectRef | null,
  childOrder: readonly string[],
): string {
  const existing = tokens.find(
    (t) =>
      t.name === refTag &&
      t.depth === ownerToken.depth + 1 &&
      t.openStart > ownerToken.openStart &&
      t.openStart < ownerToken.closeEnd,
  );

  if (ref === null) {
    return existing ? xml.slice(0, existing.openStart) + xml.slice(existing.closeEnd) : xml;
  }

  const fragment = renderRef(refTag, ref);
  if (existing) {
    return xml.slice(0, existing.openStart) + fragment + xml.slice(existing.closeEnd);
  }

  if (ownerToken.kind === "empty") {
    const opened = promoteToContainer(xml, ownerToken);
    const insertAt = ownerToken.openEnd - 1;
    return splice(opened, insertAt, fragment);
  }

  const targetIdx = childOrder.indexOf(bareName(refTag));
  let insertAt = ownerToken.openEnd;
  for (const t of tokens) {
    if (t.depth !== ownerToken.depth + 1) continue;
    if (t.openStart <= ownerToken.openStart || t.openStart >= ownerToken.closeEnd) continue;
    const idx = childOrder.indexOf(bareName(t.name));
    if (idx === -1) continue;
    if (idx <= targetIdx) insertAt = t.closeEnd;
    else break;
  }
  return splice(xml, insertAt, fragment);
}

/**
 * Set (insert or replace), or clear, one of the eight singular ref children on an
 * existing node — without this, an auto-created ROOT node could never get a
 * `persistentStructureRef` after the fact, and activation always failed
 * (see the git history).
 */
export function spliceSetNodeRef(
  xml: string,
  tokens: readonly Token[],
  nodeName: string,
  refKind: NodeRefKind,
  ref: AdtObjectRef | null,
  opts?: { nodeId?: string },
): string {
  const nodeTok = findNodeToken(tokens, nodeName, opts?.nodeId);
  if (!nodeTok) fail(`node "${nodeName}" not found`, { node: nodeName });
  return spliceSetElementRef(xml, tokens, nodeTok, `bo:${refKind}`, ref, NODE_CHILD_ORDER);
}

// ---------------------------------------------------------------------------
// Rendering — attribute + child order from bopf-types.ts, always echoed IDs
// from the caller (this module never decides whether to mint or reuse one;
// see `mintGuid`).
// ---------------------------------------------------------------------------

/**
 * Every string attribute value this module writes to the wire passes through here
 * (`renderAttrText`/`renderRef` are the only call sites) — the one place to guard
 * against a stringified JS `undefined`/`null` reaching the wire.
 *
 * The literal strings `"undefined"`/`"null"` are refused rather than passed through,
 * even though SAP itself emits a literal `"undefined"` for `DeterminationCategoryType`
 * when a category was never set — callers wanting that should omit `spec.category`
 * (unsettable, so absence already means it), not spell out the string. See
 * the git history for the full rationale.
 */
export function escapeAttrValue(v: string, context?: string): string {
  if (v === "undefined" || v === "null") {
    throw new AbapError(
      "BAD_INPUT",
      `BOPF XML: refusing to write the literal string "${v}" as ${context ?? "an attribute value"} — this is ` +
        "almost always a caller-side bug (a JavaScript undefined/null value that was stringified before being " +
        "sent) rather than an intentional value.",
      { value: v, context },
      "Omit the field entirely instead of sending the string \"undefined\"/\"null\" — BOPF attributes are " +
        "unsettable, so an absent attribute already means \"not set\".",
    );
  }
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

type AttrValue = string | boolean | undefined;

function renderAttrText(order: readonly string[], attrs: Readonly<Record<string, AttrValue>>, prefix: string): string {
  const parts: string[] = [];
  for (const key of order) {
    const v = attrs[key];
    if (v === undefined) continue;
    const s = typeof v === "boolean" ? String(v) : v;
    parts.push(`${prefix}:${key}="${escapeAttrValue(s, `${prefix}:${key}`)}"`);
  }
  return parts.join(" ");
}

const ATTR_ORDER: Readonly<Record<ElementKind, readonly string[]>> = {
  node: NODE_ATTR_ORDER,
  association: ASSOCIATION_ATTR_ORDER,
  action: ACTION_ATTR_ORDER,
  determination: DETERMINATION_ATTR_ORDER,
  validation: VALIDATION_ATTR_ORDER,
  query: QUERY_ATTR_ORDER,
  alternativeKey: ALTERNATIVE_KEY_ATTR_ORDER,
};

/** Generic per-kind renderer; self-closing when `childrenXml` is empty/omitted. Attribute order comes from `bopf-types.ts`'s per-kind table; all attributes are `bo:`-prefixed. */
export function renderElement(
  kind: ElementKind,
  attrs: Readonly<Record<string, AttrValue>>,
  childrenXml?: string,
): string {
  const tag = ELEMENT_TAG[kind];
  const attrText = renderAttrText(ATTR_ORDER[kind], attrs, "bo");
  const open = `<${tag}${attrText ? " " + attrText : ""}`;
  if (!childrenXml) return `${open}/>`;
  return `${open}>${childrenXml}</${tag}>`;
}

/** `adtcore:AdtObjectReference` — every `*Ref` element: `uri` (optional), `type`, `name`, in that order. */
export function renderRef(tag: string, ref: AdtObjectRef): string {
  const parts: string[] = [];
  if (ref.uri !== undefined) parts.push(`adtcore:uri="${escapeAttrValue(ref.uri, `${tag}/@adtcore:uri`)}"`);
  parts.push(`adtcore:type="${escapeAttrValue(ref.type, `${tag}/@adtcore:type`)}"`);
  parts.push(`adtcore:name="${escapeAttrValue(ref.name, `${tag}/@adtcore:name`)}"`);
  return `<${tag} ${parts.join(" ")}/>`;
}

function renderLeaf(tag: string, order: readonly string[], attrs: Readonly<Record<string, AttrValue>>): string {
  const t = renderAttrText(order, attrs, "bo");
  return `<${tag}${t ? " " + t : ""}/>`;
}

export function renderProperty(p: Readonly<Record<string, AttrValue>>): string {
  return renderLeaf("bo:properties", PROPERTY_ATTR_ORDER, p);
}

export function renderKeyElement(name: string): string {
  return renderLeaf("bo:keyElements", KEY_ELEMENT_ATTR_ORDER, { name });
}

export function renderDeterminationTrigger(t: Readonly<Record<string, AttrValue>>): string {
  return renderLeaf("bo:triggers", DETERMINATION_TRIGGER_ATTR_ORDER, t);
}

export function renderValidationTrigger(t: Readonly<Record<string, AttrValue>>): string {
  return renderLeaf("bo:triggers", VALIDATION_TRIGGER_ATTR_ORDER, t);
}

export function renderRelation(r: Readonly<Record<string, AttrValue>>): string {
  return renderLeaf("bo:relations", RELATION_ATTR_ORDER, r);
}

/** GUID minting for a brand-new element. Never used to re-encode an ID read from the wire — always echo those verbatim. */
export function mintGuid(kind: ElementKind): string {
  const bytes = randomBytes(16);
  return GUID_ENCODING[kind] === "base64" ? bytes.toString("base64") : bytes.toString("hex").toUpperCase();
}

// ---- Per-kind assemblers: typed fields in, one fully-formed element out. ----

export interface AssociationFields {
  readonly name: string;
  readonly nodeId?: string;
  readonly xmlName?: string;
  readonly multiplicity?: string;
  readonly implementationType?: string;
  readonly objectModelGenerated?: boolean;
  readonly doEmbeddingName?: string;
  readonly targetNodeRef?: AdtObjectRef;
  readonly implementationClassRef?: AdtObjectRef;
  readonly parameterStructureRef?: AdtObjectRef;
}

/** Child order: `ASSOCIATION_CHILD_ORDER` = targetNodeRef, implementationClassRef, parameterStructureRef. */
export function renderAssociationElement(f: AssociationFields): string {
  const children =
    (f.targetNodeRef ? renderRef("bo:targetNodeRef", f.targetNodeRef) : "") +
    (f.implementationClassRef ? renderRef("bo:implementationClassRef", f.implementationClassRef) : "") +
    (f.parameterStructureRef ? renderRef("bo:parameterStructureRef", f.parameterStructureRef) : "");
  return renderElement(
    "association",
    {
      name: f.name,
      nodeID: f.nodeId,
      implementationType: f.implementationType,
      objectModelGenerated: f.objectModelGenerated,
      xmlName: f.xmlName,
      doEmbeddingName: f.doEmbeddingName,
      multiplicity: f.multiplicity,
    },
    children,
  );
}

export interface ActionFields {
  readonly name: string;
  readonly nodeId?: string;
  readonly xmlName?: string;
  readonly category?: string;
  readonly instanceMultiplicity?: string;
  readonly exportingParameterCategoryType?: string;
  readonly exportParameterLink?: boolean;
  readonly isExtensible?: boolean;
  readonly objectModelGenerated?: boolean;
  readonly implementationClassRef?: AdtObjectRef;
  readonly parameterStructureRef?: AdtObjectRef;
}

/** Child order: `ACTION_CHILD_ORDER` = implementationClassRef, parameterStructureRef. */
export function renderActionElement(f: ActionFields): string {
  const children =
    (f.implementationClassRef ? renderRef("bo:implementationClassRef", f.implementationClassRef) : "") +
    (f.parameterStructureRef ? renderRef("bo:parameterStructureRef", f.parameterStructureRef) : "");
  return renderElement(
    "action",
    {
      name: f.name,
      nodeID: f.nodeId,
      xmlName: f.xmlName,
      exportingParameterCategoryType: f.exportingParameterCategoryType,
      objectModelGenerated: f.objectModelGenerated,
      category: f.category,
      isExtensible: f.isExtensible,
      exportParameterLink: f.exportParameterLink,
      instanceMultiplicity: f.instanceMultiplicity,
    },
    children,
  );
}

export interface DeterminationFields {
  readonly name: string;
  readonly nodeId?: string;
  readonly xmlName?: string;
  readonly category?: string;
  readonly objectModelGenerated?: boolean;
  readonly implementationClassRef?: AdtObjectRef;
  /** Pre-rendered `<bo:triggers .../>` fragments (use `renderDeterminationTrigger`). */
  readonly triggers?: readonly string[];
  /** Pre-rendered `<bo:relations .../>` fragments (use `renderRelation`). */
  readonly relations?: readonly string[];
}

/** Child order: `DETERMINATION_CHILD_ORDER` = implementationClassRef, triggers*, relations*. */
export function renderDeterminationElement(f: DeterminationFields): string {
  const children =
    (f.implementationClassRef ? renderRef("bo:implementationClassRef", f.implementationClassRef) : "") +
    (f.triggers ?? []).join("") +
    (f.relations ?? []).join("");
  return renderElement(
    "determination",
    {
      name: f.name,
      nodeID: f.nodeId,
      xmlName: f.xmlName,
      objectModelGenerated: f.objectModelGenerated,
      category: f.category,
    },
    children,
  );
}

export interface ValidationFields {
  readonly name: string;
  readonly nodeId?: string;
  readonly xmlName?: string;
  readonly category?: string;
  readonly checkBeforeSave?: boolean;
  readonly createNode?: boolean;
  readonly updateNode?: boolean;
  readonly deleteNode?: boolean;
  readonly objectModelGenerated?: boolean;
  readonly implementationClassRef?: AdtObjectRef;
  /** Pre-rendered `<bo:triggers .../>` fragments (use `renderValidationTrigger`). */
  readonly triggers?: readonly string[];
}

/** Child order: `VALIDATION_CHILD_ORDER` = implementationClassRef, triggers*. */
export function renderValidationElement(f: ValidationFields): string {
  const children = (f.implementationClassRef ? renderRef("bo:implementationClassRef", f.implementationClassRef) : "") +
    (f.triggers ?? []).join("");
  return renderElement(
    "validation",
    {
      name: f.name,
      nodeID: f.nodeId,
      xmlName: f.xmlName,
      objectModelGenerated: f.objectModelGenerated,
      category: f.category,
      checkBeforeSave: f.checkBeforeSave,
      createNode: f.createNode,
      updateNode: f.updateNode,
      deleteNode: f.deleteNode,
    },
    children,
  );
}

export interface QueryFields {
  readonly name: string;
  readonly nodeId?: string;
  readonly xmlName?: string;
  readonly category?: string;
  readonly objectModelGenerated?: boolean;
  readonly dataTypeRef?: AdtObjectRef;
  readonly implementationClassRef?: AdtObjectRef;
}

/** Child order: `QUERY_CHILD_ORDER` = dataTypeRef, implementationClassRef, (resultTypeRef/resultTableTypeRef never authored — schema-only). */
export function renderQueryElement(f: QueryFields): string {
  const children =
    (f.dataTypeRef ? renderRef("bo:dataTypeRef", f.dataTypeRef) : "") +
    (f.implementationClassRef ? renderRef("bo:implementationClassRef", f.implementationClassRef) : "");
  return renderElement(
    "query",
    {
      name: f.name,
      nodeID: f.nodeId,
      objectModelGenerated: f.objectModelGenerated,
      xmlName: f.xmlName,
      category: f.category,
    },
    children,
  );
}

export interface AlternativeKeyFields {
  readonly name: string;
  readonly nodeId?: string;
  readonly xmlName?: string;
  readonly uniqueness?: string;
  readonly checkAfterModify?: boolean;
  readonly checkBeforeSave?: boolean;
  readonly noCheck?: boolean;
  readonly objectModelGenerated?: boolean;
  readonly dataTypeRef?: AdtObjectRef;
  readonly dataTableTypeRef?: AdtObjectRef;
  /** `bo:keyElements/@bo:name` values, in document order. */
  readonly keyElements?: readonly string[];
}

/** Child order: `ALTERNATIVE_KEY_CHILD_ORDER` = dataTypeRef, dataTableTypeRef, keyElements*. */
export function renderAlternativeKeyElement(f: AlternativeKeyFields): string {
  const children =
    (f.dataTypeRef ? renderRef("bo:dataTypeRef", f.dataTypeRef) : "") +
    (f.dataTableTypeRef ? renderRef("bo:dataTableTypeRef", f.dataTableTypeRef) : "") +
    (f.keyElements ?? []).map(renderKeyElement).join("");
  return renderElement(
    "alternativeKey",
    {
      name: f.name,
      nodeID: f.nodeId,
      xmlName: f.xmlName,
      objectModelGenerated: f.objectModelGenerated,
      uniqueness: f.uniqueness,
      checkAfterModify: f.checkAfterModify,
      checkBeforeSave: f.checkBeforeSave,
      noCheck: f.noCheck,
    },
    children,
  );
}

export interface NodeFields {
  readonly name: string;
  readonly nodeId?: string;
  readonly parent?: string;
  readonly parentNodeId?: string;
  readonly xmlName?: string;
  readonly doEmbeddingName?: string;
  readonly rootNode?: boolean;
  readonly textNode?: boolean;
  readonly isDependentObjectNode?: boolean;
  readonly createEnabled?: boolean;
  readonly updateEnabled?: boolean;
  readonly deleteEnabled?: boolean;
  readonly authorizationCheck?: boolean;
  readonly isExtensible?: boolean;
  readonly objectModelGenerated?: boolean;
  readonly objectModelObsolete?: boolean;
  readonly persistentStructureRef?: AdtObjectRef;
  readonly transientStructureRef?: AdtObjectRef;
  readonly combinedStructureRef?: AdtObjectRef;
  readonly combinedTableRef?: AdtObjectRef;
  readonly persistentTableRef?: AdtObjectRef;
  readonly defaultingClassRef?: AdtObjectRef;
  readonly dataAccessClassRef?: AdtObjectRef;
  readonly authorizationClassRef?: AdtObjectRef;
  /** Pre-rendered fragments, already correctly ordered within each group (each group's own order is document order, not further sorted here). */
  readonly properties?: readonly string[];
  readonly alternativeKeys?: readonly string[];
  readonly associations?: readonly string[];
  readonly queries?: readonly string[];
  readonly actions?: readonly string[];
  readonly determinations?: readonly string[];
  readonly validations?: readonly string[];
}

/** Child order: `NODE_CHILD_ORDER` — the eight singular refs, then the seven repeating groups. */
export function renderNodeElement(f: NodeFields): string {
  const refs =
    (f.persistentStructureRef ? renderRef("bo:persistentStructureRef", f.persistentStructureRef) : "") +
    (f.transientStructureRef ? renderRef("bo:transientStructureRef", f.transientStructureRef) : "") +
    (f.combinedStructureRef ? renderRef("bo:combinedStructureRef", f.combinedStructureRef) : "") +
    (f.combinedTableRef ? renderRef("bo:combinedTableRef", f.combinedTableRef) : "") +
    (f.persistentTableRef ? renderRef("bo:persistentTableRef", f.persistentTableRef) : "") +
    (f.defaultingClassRef ? renderRef("bo:defaultingClassRef", f.defaultingClassRef) : "") +
    (f.dataAccessClassRef ? renderRef("bo:dataAccessClassRef", f.dataAccessClassRef) : "") +
    (f.authorizationClassRef ? renderRef("bo:authorizationClassRef", f.authorizationClassRef) : "");
  const groups =
    (f.properties ?? []).join("") +
    (f.alternativeKeys ?? []).join("") +
    (f.associations ?? []).join("") +
    (f.queries ?? []).join("") +
    (f.actions ?? []).join("") +
    (f.determinations ?? []).join("") +
    (f.validations ?? []).join("");
  return renderElement(
    "node",
    {
      name: f.name,
      nodeID: f.nodeId,
      parent: f.parent,
      parentNodeID: f.parentNodeId,
      xmlName: f.xmlName,
      doEmbeddingName: f.doEmbeddingName,
      objectModelGenerated: f.objectModelGenerated,
      authorizationCheck: f.authorizationCheck,
      isExtensible: f.isExtensible,
      isDependentObjectNode: f.isDependentObjectNode,
      textNode: f.textNode,
      createEnabled: f.createEnabled,
      updateEnabled: f.updateEnabled,
      deleteEnabled: f.deleteEnabled,
      rootNode: f.rootNode,
      objectModelObsolete: f.objectModelObsolete,
    },
    refs + groups,
  );
}

// ---------------------------------------------------------------------------
// parseModel — read-only view via fast-xml-parser. Never serialised back.
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

type XmlNode = Record<string, unknown>;

function xnode(value: unknown): XmlNode | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as XmlNode) : undefined;
}

/** fast-xml-parser collapses a single child to an object and an empty one to absent. */
function xmany(value: unknown): XmlNode[] {
  if (Array.isArray(value)) return value.filter((v) => !!xnode(v)).map((v) => v as XmlNode);
  const one = xnode(value);
  return one ? [one] : [];
}

function xattr(n: XmlNode | undefined, name: string): string | undefined {
  if (!n) return undefined;
  const v = n[`@_${name}`];
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

function xbool(n: XmlNode | undefined, name: string): boolean | undefined {
  const v = xattr(n, name);
  return v === undefined ? undefined : v === "true";
}

function xref(n: XmlNode | undefined): AdtObjectRef | undefined {
  if (!n) return undefined;
  const type = xattr(n, "type");
  const name = xattr(n, "name");
  if (type === undefined || name === undefined) return undefined;
  const uri = xattr(n, "uri");
  return uri === undefined ? { type, name } : { uri, type, name };
}

function parsePropertyXml(n: XmlNode): BoProperty {
  return {
    name: xattr(n, "name") ?? "",
    enabled: xbool(n, "enabled"),
    readonly: xbool(n, "readonly"),
    mandatory: xbool(n, "mandatory"),
    enabledFinal: xbool(n, "enabledFinal"),
    readonlyFinal: xbool(n, "readonlyFinal"),
    mandatoryFinal: xbool(n, "mandatoryFinal"),
    transientAttribute: xbool(n, "transientAttribute"),
    xmlName: xattr(n, "xmlName"),
  };
}

function parseAlternativeKeyXml(n: XmlNode): BoAlternativeKey {
  return {
    name: xattr(n, "name") ?? "",
    nodeId: xattr(n, "nodeID"),
    xmlName: xattr(n, "xmlName"),
    uniqueness: xattr(n, "uniqueness") as BoAlternativeKey["uniqueness"],
    checkAfterModify: xbool(n, "checkAfterModify"),
    checkBeforeSave: xbool(n, "checkBeforeSave"),
    noCheck: xbool(n, "noCheck"),
    objectModelGenerated: xbool(n, "objectModelGenerated"),
    dataTypeRef: xref(xnode(n.dataTypeRef)),
    dataTableTypeRef: xref(xnode(n.dataTableTypeRef)),
    keyElements: xmany(n.keyElements)
      .map((k) => xattr(k, "name"))
      .filter((v): v is string => v !== undefined),
  };
}

function parseAssociationXml(n: XmlNode): BoAssociation {
  return {
    name: xattr(n, "name") ?? "",
    nodeId: xattr(n, "nodeID"),
    xmlName: xattr(n, "xmlName"),
    multiplicity: xattr(n, "multiplicity") as BoAssociation["multiplicity"],
    implementationType: xattr(n, "implementationType") as BoAssociation["implementationType"],
    objectModelGenerated: xbool(n, "objectModelGenerated"),
    doEmbeddingName: xattr(n, "doEmbeddingName"),
    targetNodeRef: xref(xnode(n.targetNodeRef)),
    implementationClassRef: xref(xnode(n.implementationClassRef)),
    parameterStructureRef: xref(xnode(n.parameterStructureRef)),
  };
}

function parseQueryXml(n: XmlNode): BoQuery {
  return {
    name: xattr(n, "name") ?? "",
    nodeId: xattr(n, "nodeID"),
    xmlName: xattr(n, "xmlName"),
    category: xattr(n, "category") as BoQuery["category"],
    objectModelGenerated: xbool(n, "objectModelGenerated"),
    dataTypeRef: xref(xnode(n.dataTypeRef)),
    implementationClassRef: xref(xnode(n.implementationClassRef)),
  };
}

function parseActionXml(n: XmlNode): BoAction {
  return {
    name: xattr(n, "name") ?? "",
    nodeId: xattr(n, "nodeID"),
    xmlName: xattr(n, "xmlName"),
    category: xattr(n, "category"),
    instanceMultiplicity: xattr(n, "instanceMultiplicity") as BoAction["instanceMultiplicity"],
    exportingMultiplicity: xattr(n, "exportingMultiplicity") as BoAction["exportingMultiplicity"],
    exportingParameterCategoryType: xattr(n, "exportingParameterCategoryType") as BoAction["exportingParameterCategoryType"],
    exportParameterLink: xbool(n, "exportParameterLink"),
    isExtensible: xbool(n, "isExtensible"),
    objectModelGenerated: xbool(n, "objectModelGenerated"),
    implementationClassRef: xref(xnode(n.implementationClassRef)),
    parameterStructureRef: xref(xnode(n.parameterStructureRef)),
  };
}

function parseDeterminationTriggerXml(n: XmlNode): BoDeterminationTrigger {
  return {
    node: xattr(n, "node"),
    association: xattr(n, "association"),
    create: xbool(n, "create"),
    update: xbool(n, "update"),
    delete: xbool(n, "delete"),
    load: xbool(n, "load"),
    determine: xbool(n, "determine"),
  };
}

function parseValidationTriggerXml(n: XmlNode): BoValidationTrigger {
  return {
    node: xattr(n, "node"),
    association: xattr(n, "association"),
    create: xbool(n, "create"),
    update: xbool(n, "update"),
    delete: xbool(n, "delete"),
    check: xbool(n, "check"),
    action: xattr(n, "action"),
  };
}

function parseRelationXml(n: XmlNode): BoRelation {
  return {
    node: xattr(n, "node"),
    determination: xattr(n, "determination"),
    relationType: xattr(n, "relationType") as BoRelation["relationType"],
  };
}

function parseDeterminationXml(n: XmlNode): BoDetermination {
  return {
    name: xattr(n, "name") ?? "",
    nodeId: xattr(n, "nodeID"),
    xmlName: xattr(n, "xmlName"),
    category: xattr(n, "category") as BoDetermination["category"],
    objectModelGenerated: xbool(n, "objectModelGenerated"),
    implementationClassRef: xref(xnode(n.implementationClassRef)),
    triggers: xmany(n.triggers).map(parseDeterminationTriggerXml),
    relations: xmany(n.relations).map(parseRelationXml),
  };
}

function parseValidationXml(n: XmlNode): BoValidation {
  return {
    name: xattr(n, "name") ?? "",
    nodeId: xattr(n, "nodeID"),
    xmlName: xattr(n, "xmlName"),
    category: xattr(n, "category") as BoValidation["category"],
    checkBeforeSave: xbool(n, "checkBeforeSave"),
    createNode: xbool(n, "createNode"),
    updateNode: xbool(n, "updateNode"),
    deleteNode: xbool(n, "deleteNode"),
    objectModelGenerated: xbool(n, "objectModelGenerated"),
    implementationClassRef: xref(xnode(n.implementationClassRef)),
    triggers: xmany(n.triggers).map(parseValidationTriggerXml),
  };
}

function parseNodeXml(n: XmlNode): BoNode {
  return {
    name: xattr(n, "name") ?? "",
    nodeId: xattr(n, "nodeID"),
    parentNodeId: xattr(n, "parentNodeID"),
    parent: xattr(n, "parent"),
    xmlName: xattr(n, "xmlName"),
    doEmbeddingName: xattr(n, "doEmbeddingName"),
    rootNode: xbool(n, "rootNode") ?? false,
    textNode: xbool(n, "textNode") ?? false,
    isDependentObjectNode: xbool(n, "isDependentObjectNode") ?? false,
    createEnabled: xbool(n, "createEnabled") ?? false,
    updateEnabled: xbool(n, "updateEnabled") ?? false,
    deleteEnabled: xbool(n, "deleteEnabled") ?? false,
    authorizationCheck: xbool(n, "authorizationCheck") ?? false,
    isExtensible: xbool(n, "isExtensible") ?? false,
    objectModelGenerated: xbool(n, "objectModelGenerated") ?? false,
    objectModelObsolete: xbool(n, "objectModelObsolete") ?? false,
    persistentStructureRef: xref(xnode(n.persistentStructureRef)),
    transientStructureRef: xref(xnode(n.transientStructureRef)),
    combinedStructureRef: xref(xnode(n.combinedStructureRef)),
    combinedTableRef: xref(xnode(n.combinedTableRef)),
    persistentTableRef: xref(xnode(n.persistentTableRef)),
    defaultingClassRef: xref(xnode(n.defaultingClassRef)),
    dataAccessClassRef: xref(xnode(n.dataAccessClassRef)),
    authorizationClassRef: xref(xnode(n.authorizationClassRef)),
    properties: xmany(n.properties).map(parsePropertyXml),
    alternativeKeys: xmany(n.alternativeKeys).map(parseAlternativeKeyXml),
    associations: xmany(n.associations).map(parseAssociationXml),
    queries: xmany(n.queries).map(parseQueryXml),
    actions: xmany(n.actions).map(parseActionXml),
    determinations: xmany(n.determinations).map(parseDeterminationXml),
    validations: xmany(n.validations).map(parseValidationXml),
  };
}

/**
 * Read-only semantic view of a BOPF model document, for `show` / `check_refs`
 * / the runtime generator. Never round-tripped back to XML — for edits, use
 * the splice engine above on the original bytes.
 */
export function parseModel(xmlText: string): BoModel {
  let parsed: XmlNode;
  try {
    parsed = (xmlParser.parse(xmlText) ?? {}) as XmlNode;
  } catch (e) {
    fail(`could not parse BOPF model XML: ${e instanceof Error ? e.message : String(e)}`);
  }
  const root = xnode(parsed.businessObject);
  if (!root) fail("not a BOPF business object document (no <bo:businessObject> root element)");

  return {
    name: xattr(root, "name") ?? "",
    type: xattr(root, "type") ?? "",
    description: xattr(root, "description"),
    version: xattr(root, "version") as AdtVersionType | undefined,
    masterLanguage: xattr(root, "masterLanguage"),
    masterSystem: xattr(root, "masterSystem"),
    responsible: xattr(root, "responsible"),
    language: xattr(root, "language"),
    objectCategory: xattr(root, "objectCategory") as BusinessObjectCategoryType | undefined,
    isExtensible: xbool(root, "isExtensible"),
    objectModelGenerated: xbool(root, "objectModelGenerated"),
    thirdGenBO: xbool(root, "thirdGenBO"),
    smartValidation: xbool(root, "smartValidation"),
    rapBO: xbool(root, "rapBO"),
    packageRef: xref(xnode(root.packageRef)),
    constantsInterfaceRef: xref(xnode(root.constantsInterfaceRef)),
    nodes: xmany(root.nodes).map(parseNodeXml),
  };
}
