/**
 * Enhancement / BAdI ADT wire client — XML decode.
 *
 * Read-only: decodes `GET /sap/bc/adt/enhancements/{enhoxh|enhoxhh|enhsxs}/{name}`
 * response bodies into a typed tree. Write helpers further down (root-attribute
 * patch, isActive patch) are narrow and separate — see their own comments.
 *
 * Decoded from four real wire captures, not a spec reading — see
 * `test/fixtures/enhancement/{354,470,343,403,019,021}-*.xml`. Several shape
 * details below are UNVERIFIED (never captured on the wire); each is flagged
 * at its point of use. Full inventory and reasoning:
 * the git history.
 *
 * **Known field trap:** `enho:badiImplementation/enho:filterTree` is DERIVED
 * by the kernel from `FILTER_VALUES` + `FILTER_ROOT` at *read* time — it is
 * not a store. Never serialize it back as a write payload; even the flat
 * representation cannot faithfully round-trip an arbitrary tree (interval/
 * negation/pattern comparators collapse under a naive `{name: value}` API).
 */
import { AbapError } from "./errors.js";
import { XMLParser } from "fast-xml-parser";

// XML parser config matches src/adt/bopf-xml.ts, so namespace-prefix stripping
// behaves uniformly across every ADT wire client in this codebase.

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

type XmlNode = Record<string, unknown>;

// Small typed navigation helpers over the parsed tree, re-implemented rather
// than imported from bopf-xml.ts: this module is read-only and has no need
// for bopf-types.ts's write-path machinery.

/** Narrows a parsed value to a single plain object; use `xmany` when zero-or-more
 *  is expected instead (fast-xml-parser collapses a lone child to an object,
 *  several to an array). */
function xnode(value: unknown): XmlNode | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return undefined;
  if (typeof value !== "object") return undefined;
  return value as XmlNode;
}

/** Normalises "collapsed single child OR array OR absent" into an array. */
function xmany(value: unknown): XmlNode[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.filter((v): v is XmlNode => typeof v === "object" && v !== null);
  }
  if (typeof value === "object") return [value as XmlNode];
  return [];
}

function xattr(n: XmlNode | undefined, name: string): string | undefined {
  if (!n) return undefined;
  const v = n["@_" + name];
  if (v === undefined || v === null) return undefined;
  return String(v);
}

function xbool(n: XmlNode | undefined, name: string): boolean | undefined {
  const v = xattr(n, name);
  if (v === undefined) return undefined;
  return v === "true";
}

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new AbapError(
    "BAD_INPUT",
    `enhancement XML: ${message}`,
    details,
    "The decoder refuses to guess at malformed or unsupported input — fix or re-capture the source document rather than relying on a silent fallback.",
  );
}

function parseXml(xmlText: string, context: string): XmlNode {
  let parsed: XmlNode;
  try {
    parsed = (xmlParser.parse(xmlText) ?? {}) as XmlNode;
  } catch (e) {
    fail(`could not parse ${context} XML: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Shared reference / common-header shapes
// ---------------------------------------------------------------------------

/** A reference to another ADT object. A BAdI *definition* referenced from an
 *  implementation has no REST URI of its own — its `uri` on the wire
 *  (`/sap/bc/adt/vit/wb/object_type/enhsxb/object_name/...`) is a SAP GUI
 *  navigation link, not a fetchable ADT resource. */
export interface EnhObjectRef {
  readonly uri?: string;
  readonly type: string;
  readonly name: string;
}

export interface EnhPackageRef extends EnhObjectRef {
  readonly description?: string;
}

/** Fields common to all three collections' `adtcore:*` root attributes. */
export interface EnhCommonFields {
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly packageRef?: EnhPackageRef;
  readonly responsible?: string;
  readonly masterLanguage?: string;
  readonly masterSystem?: string;
  /** `adtcore:version` — activation status only (`"active"`/`"inactive"`).
   *  ADT's plain-GET response carries no lock indicator (lock state requires
   *  a separate LOCK call), hence no `locked` field here — deliberately, not
   *  a gap. */
  readonly activationStatus?: string;
  readonly language?: string;
  readonly createdAt?: string;
  readonly createdBy?: string;
  readonly changedAt?: string;
  readonly changedBy?: string;
}

function xref(n: XmlNode | undefined): EnhObjectRef | undefined {
  if (!n) return undefined;
  const type = xattr(n, "type");
  const name = xattr(n, "name");
  if (!type || !name) return undefined;
  return { uri: xattr(n, "uri"), type, name };
}

function parseCommon(root: XmlNode): EnhCommonFields {
  const pkgNode = xnode(root.packageRef);
  const packageRef: EnhPackageRef | undefined = pkgNode
    ? {
        uri: xattr(pkgNode, "uri"),
        type: xattr(pkgNode, "type") ?? "",
        name: xattr(pkgNode, "name") ?? "",
        description: xattr(pkgNode, "description"),
      }
    : undefined;
  return {
    name: xattr(root, "name") ?? "",
    type: xattr(root, "type") ?? "",
    description: xattr(root, "description"),
    packageRef,
    responsible: xattr(root, "responsible"),
    masterLanguage: xattr(root, "masterLanguage"),
    masterSystem: xattr(root, "masterSystem"),
    activationStatus: xattr(root, "version"),
    language: xattr(root, "language"),
    createdAt: xattr(root, "createdAt"),
    createdBy: xattr(root, "createdBy"),
    changedAt: xattr(root, "changedAt"),
    changedBy: xattr(root, "changedBy"),
  };
}

// ---------------------------------------------------------------------------
// enhoxh — BAdI implementation
// ---------------------------------------------------------------------------

export interface FilterConditionRead {
  readonly filterName?: string;
  readonly filterType?: string;
  readonly comparator1?: string;
  readonly value1?: string;
  /** Second bound of an interval comparator (`<<`, `<=<`, `<<=`, `<=<=`).
   *  UNVERIFIED on the wire — every captured filter used `=`. Drawn from the
   *  full 14-value `BADI_COMPARATORS` domain. */
  readonly comparator2?: string;
  readonly value2?: string;
}

export interface FilterTreeGroup {
  readonly kind: "and" | "or";
  readonly children: readonly FilterTreeNode[];
}
export interface FilterTreeLeaf {
  readonly kind: "filter";
  readonly condition: FilterConditionRead;
}
/** DERIVED / READ-ONLY — see the module header. Never a write target. */
export type FilterTreeNode = FilterTreeGroup | FilterTreeLeaf;

function parseFilterCondition(n: XmlNode): FilterConditionRead {
  return {
    filterName: xattr(n, "filterName"),
    filterType: xattr(n, "filterType"),
    comparator1: xattr(n, "comparator1"),
    value1: xattr(n, "value1"),
    comparator2: xattr(n, "comparator2"),
    value2: xattr(n, "value2"),
  };
}

/** Collects the `and`/`or`/`filter` children of one tree-container element.
 *  Order below is `and` then `or` then `filter` (fast-xml-parser groups
 *  children by tag name) — if a real document ever mixes sibling kinds at one
 *  level, that grouping may not match the server's actual document order.
 *  UNVERIFIED whether mixed siblings occur. */
function parseFilterTreeChildren(n: XmlNode): FilterTreeNode[] {
  const out: FilterTreeNode[] = [];
  for (const andNode of xmany(n.and)) {
    out.push({ kind: "and", children: parseFilterTreeChildren(andNode) });
  }
  for (const orNode of xmany(n.or)) {
    out.push({ kind: "or", children: parseFilterTreeChildren(orNode) });
  }
  for (const filterNode of xmany(n.filter)) {
    out.push({ kind: "filter", condition: parseFilterCondition(filterNode) });
  }
  return out;
}

function parseFilterTree(n: XmlNode | undefined): FilterTreeNode | undefined {
  if (!n) return undefined;
  const children = parseFilterTreeChildren(n);
  if (children.length === 0) return undefined;
  if (children.length === 1) return children[0];
  // Multiple top-level siblings directly under <filterTree> were never
  // observed; wrap defensively rather than silently dropping data.
  return { kind: "or", children };
}

export interface BadiImplementationEntryRead {
  readonly name: string;
  readonly shortText?: string;
  readonly isExample?: boolean;
  readonly isDefault?: boolean;
  readonly isActive?: boolean;
  readonly isCustomizingSupported?: boolean;
  readonly runtimeBehaviorShorttext?: string;
  readonly enhancementSpot?: EnhObjectRef;
  readonly badiDefinition?: EnhObjectRef;
  readonly implementingClass?: EnhObjectRef;
  /** DERIVED / READ-ONLY — see the module header. Absent (not empty) when no
   *  filter values are set (fixture 354). */
  readonly filterTree?: FilterTreeNode;
}

export interface BadiImplementationRead extends EnhCommonFields {
  /** `enho:contentCommon/@toolType` — observed `"BADI_IMPL"`. */
  readonly toolType?: string;
  readonly adjustmentStatus?: string;
  readonly upgradeFlag?: boolean;
  readonly implementations: readonly BadiImplementationEntryRead[];
}

function parseBadiImplementationEntry(n: XmlNode): BadiImplementationEntryRead {
  return {
    name: xattr(n, "name") ?? "",
    shortText: xattr(n, "shortText"),
    isExample: xbool(n, "isExample"),
    isDefault: xbool(n, "isDefault"),
    isActive: xbool(n, "isActive"),
    isCustomizingSupported: xbool(n, "isCustomizingSupported"),
    runtimeBehaviorShorttext: xattr(n, "runtimeBehaviorShorttext"),
    enhancementSpot: xref(xnode(n.enhancementSpot)),
    badiDefinition: xref(xnode(n.badiDefinition)),
    implementingClass: xref(xnode(n.implementingClass)),
    filterTree: parseFilterTree(xnode(n.filterTree)),
  };
}

/** Decodes a `GET /sap/bc/adt/enhancements/enhoxh/{name}` response body
 *  (Accept: `application/vnd.sap.adt.enh.enho.v1+xml`) into a typed BAdI
 *  implementation. Verified against fixtures 354 and 470. */
export function parseBadiImplementation(xmlText: string): BadiImplementationRead {
  const parsed = parseXml(xmlText, "enhoxh (BAdI implementation)");
  const root = xnode(parsed.objectData);
  if (!root) fail("not an ENHO/XH BAdI implementation document (no <enho:objectData> root element)");
  const common = parseCommon(root);
  const contentCommon = xnode(root.contentCommon);
  const contentSpecific = xnode(root.contentSpecific);
  const badiTech = xnode(contentSpecific?.badiTechnology);
  const implsNode = xnode(badiTech?.badiImplementations);
  const implNodes = implsNode ? xmany(implsNode.badiImplementation) : [];
  return {
    ...common,
    toolType: xattr(contentCommon, "toolType"),
    adjustmentStatus: xattr(contentCommon, "adjustmentStatus"),
    upgradeFlag: xbool(contentCommon, "upgradeFlag"),
    implementations: implNodes.map(parseBadiImplementationEntry),
  };
}

// ---------------------------------------------------------------------------
// enhoxhh — source-code plugin
// ---------------------------------------------------------------------------

export interface EnhUsageRef {
  readonly programId?: string;
  readonly elementUsage?: string;
  readonly upgrade?: boolean;
  readonly automaticTransport?: boolean;
  /** `enho:parent` — a `#///...` fragment pointer to a sibling usage entry
   *  (observed on `LIMU`-kind rows pointing back at their owning `R3TR`
   *  row). Decoded verbatim, not resolved. */
  readonly parent?: string;
  readonly objectReference?: EnhObjectRef;
  readonly mainObjectReference?: EnhObjectRef;
}

export interface HookImplementationRead {
  readonly id?: string;
  readonly spotName?: string;
  readonly programName?: string;
  readonly overwrite?: string;
  readonly method?: string;
  readonly enhMode?: string;
  /** The hook anchor, e.g.
   *  `\PR:CL_SPOT_ENH_TEMPLATE_001======CP\EX:SEU_TEST_CLASS_SPOT_0000001\EI`.
   *  Reads both `full_name` and `fullname`, preferring `full_name` — the only
   *  spelling ever observed on the wire; `fullname` is UNVERIFIED and may be
   *  a stale variant. */
  readonly fullName?: string;
  readonly fullDescription?: string;
  /** `atom:link[rel=enclosure]/@href` — points at the enclosing source
   *  object and offset, e.g.
   *  `/sap/bc/adt/oo/classes/cl_spot_enh_template_001#start=4,80`. */
  readonly enclosureUri?: string;
}

export interface SourceCodePluginRead extends EnhCommonFields {
  /** `abapsource:sourceUri` — relative link to the plugin's own source. */
  readonly sourceUri?: string;
  readonly fixPointArithmetic?: boolean;
  readonly activeUnicodeCheck?: boolean;
  /** `enho:contentCommon/@toolType` — observed `"HOOK_IMPL"`. */
  readonly toolType?: string;
  readonly adjustmentStatus?: string;
  /** Switch-BC-Set gate on this plugin, if any — observed once
   *  (`IBASE_SWITCH_CHECK_IM`). UNVERIFIED whether `enho:reference` can be
   *  absent while `enho:switch` is present, or whether `@state` takes values
   *  other than `"off"`. */
  readonly switchState?: string;
  readonly switchReference?: EnhObjectRef;
  readonly usages: readonly EnhUsageRef[];
  readonly enhancedObject?: EnhObjectRef;
  readonly nextId?: string;
  readonly hookImplementations: readonly HookImplementationRead[];
}

function parseUsageRef(n: XmlNode): EnhUsageRef {
  return {
    programId: xattr(n, "program_id"),
    elementUsage: xattr(n, "element_usage"),
    upgrade: xbool(n, "upgrade"),
    automaticTransport: xbool(n, "automatic_transport"),
    parent: xattr(n, "parent"),
    objectReference: xref(xnode(n.objectReference)),
    mainObjectReference: xref(xnode(n.mainObjectReference)),
  };
}

function parseEnclosureLink(n: XmlNode): string | undefined {
  for (const linkNode of xmany(n.link)) {
    if (xattr(linkNode, "rel") === "enclosure") return xattr(linkNode, "href");
  }
  return undefined;
}

function parseHookImplementation(n: XmlNode): HookImplementationRead {
  return {
    id: xattr(n, "id"),
    spotName: xattr(n, "spotname"),
    programName: xattr(n, "programname"),
    overwrite: xattr(n, "overwrite"),
    method: xattr(n, "method"),
    enhMode: xattr(n, "enhmode"),
    fullName: xattr(n, "full_name") ?? xattr(n, "fullname"),
    fullDescription: xattr(n, "full_description"),
    enclosureUri: parseEnclosureLink(n),
  };
}

/** Decodes a `GET /sap/bc/adt/enhancements/enhoxhh/{name}` response body
 *  (Accept: `application/vnd.sap.adt.enh.enhoxhh.v2+xml`) into a typed
 *  source-code plugin. Verified against fixtures 019 and 021 (a class hook
 *  and a function-module hook respectively). Note the root element is
 *  `<enho:enhancement>`, NOT `<enho:objectData>` — unlike the other two
 *  collections despite sharing the `enho` namespace with `enhoxh`. */
export function parseSourceCodePlugin(xmlText: string): SourceCodePluginRead {
  const parsed = parseXml(xmlText, "enhoxhh (source-code plugin)");
  const root = xnode(parsed.enhancement);
  if (!root) fail("not an ENHO/XHH source-code plugin document (no <enho:enhancement> root element)");
  const common = parseCommon(root);
  const contentCommon = xnode(root.contentCommon);
  const switchNode = xnode(contentCommon?.switch);
  const usagesNode = xnode(contentCommon?.usages);
  const usageNodes = usagesNode ? xmany(usagesNode.referencedObject) : [];
  const contentSpecific = xnode(root.contentSpecific);
  const hookTech = xnode(contentSpecific?.hookTechnology);
  const hookImplNodes = hookTech ? xmany(hookTech.hookImplementation) : [];
  return {
    ...common,
    sourceUri: xattr(root, "sourceUri"),
    fixPointArithmetic: xbool(root, "fixPointArithmetic"),
    activeUnicodeCheck: xbool(root, "activeUnicodeCheck"),
    toolType: xattr(contentCommon, "toolType"),
    adjustmentStatus: xattr(contentCommon, "adjustmentStatus"),
    switchState: xattr(switchNode, "state"),
    switchReference: xref(xnode(switchNode?.reference)),
    usages: usageNodes.map(parseUsageRef),
    enhancedObject: xref(xnode(hookTech?.enhancedObject)),
    nextId: xattr(hookTech, "nextId"),
    hookImplementations: hookImplNodes.map(parseHookImplementation),
  };
}

// ---------------------------------------------------------------------------
// enhsxs — enhancement spot
// ---------------------------------------------------------------------------

export interface BadiFilterDeclarationRead {
  readonly filterName?: string;
  readonly filterType?: string;
  readonly shorttext?: string;
  readonly onlyConstantFilterValues?: boolean;
}

export interface BadiDefinitionEntryRead {
  readonly name: string;
  readonly shorttext?: string;
  readonly singleUse?: boolean;
  readonly useFallbackClass?: boolean;
  readonly filterLimitation?: boolean;
  readonly documentationId?: string;
  readonly interfaceRef?: EnhObjectRef;
  /** Definition-level filter *declarations* (name/type/shorttext) — distinct
   *  from `BadiImplementationEntryRead.filterTree` (implementation-level
   *  filter *values*). Absent (not empty) when the definition declares no
   *  filters (fixture 343). Writability is undetermined by this read-only
   *  module — do not assume it shares `filterTree`'s derivation trap just
   *  because both involve "filters". */
  readonly filters: readonly BadiFilterDeclarationRead[];
}

export interface EnhancementSpotRead extends EnhCommonFields {
  /** `enhs:contentCommon/@toolType` — observed `"BADI_DEF"`. A hook-flavoured
   *  spot's toolType is UNVERIFIED (the one capture attempt returned 500). */
  readonly toolType?: string;
  readonly internal?: boolean;
  readonly badiDefinitions: readonly BadiDefinitionEntryRead[];
}

function parseBadiFilterDeclaration(n: XmlNode): BadiFilterDeclarationRead {
  return {
    filterName: xattr(n, "filterName"),
    filterType: xattr(n, "filterType"),
    shorttext: xattr(n, "shorttext"),
    onlyConstantFilterValues: xbool(n, "onlyConstantFilterValues"),
  };
}

function parseBadiDefinitionEntry(n: XmlNode): BadiDefinitionEntryRead {
  const filtersNode = xnode(n.filters);
  const filterNodes = filtersNode ? xmany(filtersNode.filter) : [];
  return {
    name: xattr(n, "name") ?? "",
    shorttext: xattr(n, "shorttext"),
    singleUse: xbool(n, "singleUse"),
    useFallbackClass: xbool(n, "useFallbackClass"),
    filterLimitation: xbool(n, "filterLimitation"),
    documentationId: xattr(n, "documentationId"),
    interfaceRef: xref(xnode(n.interface)),
    filters: filterNodes.map(parseBadiFilterDeclaration),
  };
}

/** Decodes a `GET /sap/bc/adt/enhancements/enhsxs/{name}` response body
 *  (Accept: `application/vnd.sap.adt.enh.enhs.v1+xml`) into a typed
 *  enhancement spot. Verified against fixtures 343 and 403 — both
 *  `BADI_DEF`-flavoured; a hook-flavoured spot document was never
 *  successfully captured. Degrades to an empty `badiDefinitions` array
 *  rather than throwing when `badiTechnology/badiDefinitions` is absent, so a
 *  differently-shaped spot still yields its common fields — untested on a
 *  real hook spot. */
export function parseEnhancementSpot(xmlText: string): EnhancementSpotRead {
  const parsed = parseXml(xmlText, "enhsxs (enhancement spot)");
  const root = xnode(parsed.objectData);
  if (!root) fail("not an ENHS/XS enhancement spot document (no <enhs:objectData> root element)");
  const common = parseCommon(root);
  const contentCommon = xnode(root.contentCommon);
  const contentSpecific = xnode(root.contentSpecific);
  const badiTech = xnode(contentSpecific?.badiTechnology);
  const defsNode = xnode(badiTech?.badiDefinitions);
  const defNodes = defsNode ? xmany(defsNode.badiDefinition) : [];
  return {
    ...common,
    toolType: xattr(contentCommon, "toolType"),
    internal: xbool(contentCommon, "internal"),
    badiDefinitions: defNodes.map(parseBadiDefinitionEntry),
  };
}

// ---------------------------------------------------------------------------
// Write direction — root-attribute patch only, byte-preserving regex over the
// raw text (never a parse-rebuild-serialise round trip, since the decoder
// above does not fully model `contentSpecific` — same technique as
// `parsePackageRef` in write.ts, for the same reason). Scope is deliberately
// one root-level attribute, `description`: the only field every capture shows
// sitting on the document root outside `contentCommon`/`contentSpecific`, so
// patching it can never touch a filter tree, a usages list, or a
// hook-implementation list. Anything nested is out of scope until a real
// writable model for `contentSpecific` exists.
// ---------------------------------------------------------------------------

/** Attributes `patchEnhancementRootAttribute` is allowed to touch — see the
 *  comment above for why this list has exactly one entry today. */
export type EnhancementRootAttribute = "description";

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Matches the FIRST element's opening tag only (the document root), skipping
 *  an optional `<?xml …?>` prolog — anchored to the document start so a
 *  nested element with a `description`-shaped attribute (e.g. `packageRef`)
 *  can never be the one matched. */
const ROOT_TAG_RE = /^(\s*<\?xml[^>]*\?>\s*)(<[A-Za-z_][\w.-]*:[A-Za-z_][\w.-]*\b)([^>]*?)(\/?)>/;

/**
 * Patches (or inserts) one root-level `adtcore:*` attribute on an enhancement
 * document's OUTERMOST element, leaving every other byte unchanged.
 *
 * Root element accepted: `enho:objectData` (enhoxh), `enho:enhancement`
 * (enhoxhh) or `enhs:objectData` (enhsxs), matched by namespace-agnostic
 * local name so this function need not know which collection called it.
 *
 * Throws `BAD_INPUT` (via `fail`) rather than guessing when the document does
 * not start with a recognisable root tag.
 */
export function patchEnhancementRootAttribute(
  xmlText: string,
  attribute: EnhancementRootAttribute,
  value: string,
): string {
  const m = ROOT_TAG_RE.exec(xmlText);
  if (!m) {
    fail("could not locate a root element to patch (no recognisable opening tag at the start of the document)", {
      attribute,
    });
    throw new Error("unreachable — fail() always throws");
  }
  // All four capturing groups are mandatory in `ROOT_TAG_RE` (none are `(...)?`),
  // so a match always populates them; the `noUncheckedIndexedAccess` widening
  // to `string | undefined` is not a real possibility for this regex.
  const whole = m[0];
  const prolog = m[1]!;
  const tagOpen = m[2]!;
  const attrs = m[3]!;
  const selfClose = m[4]!;
  const localName = tagOpen.replace(/^<[A-Za-z_][\w.-]*:/, "<");
  if (localName !== "<objectData" && localName !== "<enhancement") {
    fail(`unrecognised enhancement document root element "${tagOpen.slice(1)}" — refusing to patch it`, {
      attribute,
      rootTag: tagOpen.slice(1),
    });
  }
  const escaped = escapeXmlAttr(value);
  const attrRe = /(?:^|\s)(adtcore:)?description\s*=\s*(?:"[^"]*"|'[^']*')/;
  const existing = attrRe.exec(attrs);
  let newAttrs: string;
  if (existing) {
    const prefix = existing[1] ?? "";
    newAttrs =
      attrs.slice(0, existing.index) +
      (existing[0].startsWith(" ") ? " " : "") +
      `${prefix}${attribute}="${escaped}"` +
      attrs.slice(existing.index + existing[0].length);
  } else {
    newAttrs = `${attrs} adtcore:${attribute}="${escaped}"`;
  }
  const newTagOpen = `${prolog}${tagOpen}${newAttrs}${selfClose}>`;
  return xmlText.slice(0, m.index) + newTagOpen + xmlText.slice(m.index + whole.length);
}

/** Same attribute shape as `patchEnhancementRootAttribute`'s `attrRe`, but
 *  capturing the value instead of only locating it — reuses `ROOT_TAG_RE`'s
 *  document-start anchor for the same reason (a nested `packageRef`'s own
 *  `description` must never be read as the root's). */
const ROOT_DESCRIPTION_VALUE_RE = /(?:^|\s)(?:adtcore:)?description\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/**
 * Checks an enhancement document's ACTUAL bytes: root, empty, and absent are
 * all "false" — never a content accessor (the value is not unescaped). Checks
 * the literal text about to go over the wire rather than a typed field a
 * caller computed upstream — see `putEnhancementDocument` in
 * `enhancement-write.ts`, where this is enforced.
 *
 * Returns `false` (never throws) when the text does not start with a
 * recognisable root tag — a defensive wire-payload check, not a strict
 * decoder; a malformed document fails at its real parse site instead.
 */
export function hasEnhancementRootDescription(xmlText: string): boolean {
  const m = ROOT_TAG_RE.exec(xmlText);
  if (!m) return false;
  const attrs = m[3] ?? "";
  const valueMatch = ROOT_DESCRIPTION_VALUE_RE.exec(attrs);
  if (!valueMatch) return false;
  const raw = valueMatch[1] ?? valueMatch[2] ?? "";
  return raw.length > 0;
}

// ---------------------------------------------------------------------------
// Write direction — one NESTED attribute: `enho:isActive` on a named
// `enho:badiImplementation` entry (ENHO/XH only). Added so
// `deleteEnhancementObject`'s H8 gate (enhancement-write.ts) — which refuses
// while any implementation's `isActive !== false` — has a way to flip the
// flag first. Same byte-preserving-regex discipline as
// `patchEnhancementRootAttribute`, extended to locate a child element by
// attribute match: scans every `<enho:badiImplementation>` opening tag for
// the one whose `enho:name` matches `implName`, and patches only that tag's
// own attributes — never its children, never a same-named attribute
// elsewhere.
// ---------------------------------------------------------------------------

const BADI_IMPL_TAG_RE = /<enho:badiImplementation\b([^>]*?)(\/?)>/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Patches (or inserts) `enho:isActive` on the ONE `enho:badiImplementation`
 * opening tag whose `enho:name` equals `implName`, leaving every other byte —
 * including that element's own children — untouched. Mirrors
 * `patchEnhancementRootAttribute`'s insert-or-replace logic on a different tag.
 *
 * Throws `BAD_INPUT` (via `fail`) if no matching entry is found.
 */
export function patchBadiImplementationActive(xmlText: string, implName: string, active: boolean): string {
  const nameAttrRe = new RegExp(`(?:^|\\s)enho:name\\s*=\\s*"${escapeRegExp(escapeXmlAttr(implName))}"`);
  BADI_IMPL_TAG_RE.lastIndex = 0;
  let found: { full: string; attrs: string; selfClose: string; index: number } | undefined;
  let m: RegExpExecArray | null;
  while ((m = BADI_IMPL_TAG_RE.exec(xmlText)) !== null) {
    const attrs = m[1] ?? "";
    if (nameAttrRe.test(attrs)) {
      found = { full: m[0], attrs, selfClose: m[2] ?? "", index: m.index };
      break;
    }
  }
  if (!found) {
    fail(`could not locate a <enho:badiImplementation> entry named "${implName}" to patch`, { implName });
    throw new Error("unreachable — fail() always throws");
  }
  const valueStr = active ? "true" : "false";
  const attrRe = /(?:^|\s)(enho:)?isActive\s*=\s*(?:"[^"]*"|'[^']*')/;
  const existing = attrRe.exec(found.attrs);
  let newAttrs: string;
  if (existing) {
    const prefix = existing[1] ?? "";
    newAttrs =
      found.attrs.slice(0, existing.index) +
      (existing[0].startsWith(" ") ? " " : "") +
      `${prefix}isActive="${valueStr}"` +
      found.attrs.slice(existing.index + existing[0].length);
  } else {
    newAttrs = `${found.attrs} enho:isActive="${valueStr}"`;
  }
  const newTag = `<enho:badiImplementation${newAttrs}${found.selfClose}>`;
  return xmlText.slice(0, found.index) + newTag + xmlText.slice(found.index + found.full.length);
}
