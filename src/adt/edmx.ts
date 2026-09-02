/**
 * EDMX / OData `$metadata` parsing — pure functions over a metadata document,
 * no socket.
 *
 * Scope boundary (parity item P-40): this module and `./odata.ts` parse the
 * *shape* of an OData service (entity sets, keys, types, navigation,
 * capabilities) and deliberately cannot build any URL beyond `$metadata` —
 * no entity-set fetch, `$batch`, or `$filter`. Reading business rows through
 * an ADT dev session is a category error, not a missing feature — see
 * the git history for the full rationale.
 *
 * V2 and V4 CSDL differ structurally, not cosmetically: V2 navigation
 * properties resolve their target through a separate `<Association>`
 * element; V4 inlines `Type="Collection(ns.Foo)"`. V2 capabilities are SAP's
 * `sap:creatable`/`sap:updatable`/… attributes; V4 uses OASIS
 * `Capabilities.*` vocabulary annotations, inline or in an external
 * `<Annotations Target=…>` block. Both normalise onto {@link EdmxContract}.
 *
 * Provenance: V2 parsing is LIVE-VERIFIED against an SAP_BASIS 754 appliance
 * (see `test/fixtures/live-captured/`). V4 is INFERENCE from the OASIS CSDL
 * spec, exercised only by SYNTHETIC fixtures — that appliance offers no V4
 * service to verify against. Nothing here should be read as "V4 was tried
 * and works"; see the archive for detail.
 */

import { XMLParser } from "fast-xml-parser";
import { AbapError } from "./errors.js";
import { PARSE_EXCERPT_MAX, truncateText } from "../truncate.js";

// ----------------------------------------------------------------- parser ---

/**
 * Elements that may legitimately repeat, keyed by NAME rather than by jpath
 * (unlike `atc-xml.ts`/`dumps-xml.ts`): every name here repeats at every
 * CSDL path it can occur at, so a jpath set would just be a longer-winded
 * version of the same predicate.
 */
const REPEATABLE_NAMES: ReadonlySet<string> = new Set([
  "Schema",
  "EntityType",
  "ComplexType",
  "EntitySet",
  "Singleton",
  "Property",
  "PropertyRef",
  "NavigationProperty",
  "NavigationPropertyBinding",
  "Association",
  "AssociationSet",
  "End",
  "EntityContainer",
  "FunctionImport",
  "ActionImport",
  "Function",
  "Action",
  "Parameter",
  "Annotations",
  "Annotation",
  "Record",
  "PropertyValue",
  "Collection",
  "PropertyPath",
  "Reference",
  "Include",
  "String",
  "EnumMember",
]);

/**
 * Coercion is OFF (matches `atc-xml.ts`) — load-bearing: `MaxLength="8"`
 * must stay comparable to `MaxLength="Max"`, and `Version="1.0"` must not
 * arrive as the number `1`. `removeNSPrefix` drops `xmlns:*` declarations
 * along with prefixes, so namespace URIs are NOT available for version
 * detection; see {@link detectVersion}.
 */
const edmxXml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (name, _jpath, _isLeaf, isAttribute) => !isAttribute && REPEATABLE_NAMES.has(name),
});

// ------------------------------------------------------------------ model ---

/** Which OData protocol the document describes. */
export type ODataVersion = "V2" | "V4";

/**
 * How the version was established. Reported so a caller can tell a document
 * that SAID what it is from one this parser had to infer from its shape.
 */
export type VersionEvidence =
  | "edmx-version-attribute"
  | "dataservice-version-attribute"
  | "structural-association-element"
  | "structural-navigation-type";

/** One property of an entity or complex type. */
export interface EdmxProperty {
  readonly name: string;
  /** `Edm.String`, `Edm.DateTimeOffset`, … verbatim from the document. */
  readonly type: string;
  /** `false` when the document says `Nullable="false"`. Undefined when unstated. */
  readonly nullable?: boolean;
  readonly maxLength?: string;
  readonly precision?: string;
  readonly scale?: string;
  /** `sap:label` (V2) or `Common.Label` (V4). The human name of the field. */
  readonly label?: string;
  /** Per-property SAP flags, V2 only. Absent values mean "unstated". */
  readonly creatable?: boolean;
  readonly updatable?: boolean;
  readonly sortable?: boolean;
  readonly filterable?: boolean;
  readonly requiredInFilter?: boolean;
  /** `sap:unit` / `sap:text` — the other property this one is described by. */
  readonly unit?: string;
  readonly text?: string;
}

/** A navigation property with its target resolved on both dialects. */
export interface EdmxNavigation {
  readonly name: string;
  /** Target entity type, namespace-qualified as the document spells it. */
  readonly target: string;
  /** `1` / `0..1` / `*` — V4 is normalised onto the same vocabulary. */
  readonly multiplicity?: string;
  /** True when the target could not be resolved (dangling V2 association). */
  readonly unresolved?: boolean;
}

export interface EdmxEntityType {
  readonly name: string;
  readonly label?: string;
  readonly keys: readonly string[];
  readonly properties: readonly EdmxProperty[];
  readonly navigation: readonly EdmxNavigation[];
}

/**
 * What the service says it permits. Every field is tri-state on purpose:
 * `undefined` means the document did not say, which is NOT the same as
 * `true`. A renderer that prints "creatable" for an unstated flag invents
 * a permission.
 */
export interface EdmxCapabilities {
  readonly creatable?: boolean;
  readonly updatable?: boolean;
  readonly deletable?: boolean;
  readonly searchable?: boolean;
  readonly pageable?: boolean;
  readonly countable?: boolean;
  readonly addressable?: boolean;
  readonly requiresFilter?: boolean;
}

export interface EdmxEntitySet {
  readonly name: string;
  /** The entity type this set exposes, namespace-qualified as spelled. */
  readonly entityType: string;
  readonly label?: string;
  readonly capabilities: EdmxCapabilities;
}

export interface EdmxOperationParam {
  readonly name: string;
  readonly type: string;
  readonly mode?: string;
}

/**
 * A function import (V2) or an action/function import (V4). Named `operation`
 * rather than `function` because V4 actions are side-effecting and lumping
 * them under "function" would understate that.
 */
export interface EdmxOperation {
  readonly name: string;
  readonly kind: "function" | "action";
  readonly httpMethod?: string;
  readonly returnType?: string;
  readonly parameters: readonly EdmxOperationParam[];
}

/** The compressed contract. This, not the EDMX, is what an agent is shown. */
export interface EdmxContract {
  readonly version: ODataVersion;
  readonly versionEvidence: VersionEvidence;
  /** First schema namespace in the document, if any. */
  readonly namespace?: string;
  readonly entityContainer?: string;
  readonly entitySets: readonly EdmxEntitySet[];
  readonly entityTypes: readonly EdmxEntityType[];
  readonly operations: readonly EdmxOperation[];
  /** Byte length of the document this was parsed from. */
  readonly rawBytes: number;
}

// ------------------------------------------------------------- primitives ---

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** A repeatable child as an array, whatever the parser produced. */
function list(node: unknown, name: string): Rec[] {
  if (!isRec(node)) return [];
  const v = node[name];
  if (Array.isArray(v)) return v.filter(isRec);
  return isRec(v) ? [v] : [];
}

/** One child element, or undefined. */
function child(node: unknown, name: string): Rec | undefined {
  const l = list(node, name);
  if (l.length > 0) return l[0];
  const v = isRec(node) ? node[name] : undefined;
  return isRec(v) ? v : undefined;
}

function attr(node: unknown, name: string): string | undefined {
  if (!isRec(node)) return undefined;
  const v = node[`@_${name}`];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

/**
 * SAP and OASIS both spell booleans as the strings `"true"`/`"false"`.
 * Anything else — including an attribute that is simply absent — answers
 * `undefined`, so "the document did not say" survives all the way to the
 * renderer instead of being flattened into `false`.
 */
function boolAttr(node: unknown, name: string): boolean | undefined {
  const raw = attr(node, name);
  if (raw === undefined) return undefined;
  const v = raw.toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

/** `Collection(ns.Foo)` → `ns.Foo`; anything else unchanged. */
function unwrapCollection(type: string): { type: string; collection: boolean } {
  const m = /^Collection\((.+)\)$/.exec(type);
  return m?.[1] ? { type: m[1], collection: true } : { type, collection: false };
}

/** Everything after the last `.` — `ZSRV.TravelType` → `TravelType`. */
export function localName(qualified: string): string {
  const cut = qualified.lastIndexOf(".");
  return cut === -1 ? qualified : qualified.slice(cut + 1);
}

// ------------------------------------------------------ version detection ---

/**
 * Which dialect this document is, and on what evidence — detected from the
 * document itself, never guessed from the URL that fetched it. Tries four
 * signals strongest-first (see body) and refuses rather than assumes when
 * none match: a wrong dialect produces a plausible-looking contract with
 * silently missing navigation and capabilities, which is worse than an
 * error.
 */
function detectVersion(
  edmx: Rec,
  schemas: readonly Rec[],
): { version: ODataVersion; evidence: VersionEvidence } {
  const v = attr(edmx, "Version");
  if (v === "4.0") return { version: "V4", evidence: "edmx-version-attribute" };
  if (v === "1.0") return { version: "V2", evidence: "edmx-version-attribute" };

  const ds = child(edmx, "DataServices");
  const dsv = attr(ds, "DataServiceVersion");
  if (dsv?.startsWith("2")) return { version: "V2", evidence: "dataservice-version-attribute" };
  if (dsv?.startsWith("4")) return { version: "V4", evidence: "dataservice-version-attribute" };

  for (const s of schemas) {
    if (list(s, "Association").length > 0) {
      return { version: "V2", evidence: "structural-association-element" };
    }
  }
  for (const s of schemas) {
    for (const t of list(s, "EntityType")) {
      for (const n of list(t, "NavigationProperty")) {
        if (attr(n, "Type") !== undefined) {
          return { version: "V4", evidence: "structural-navigation-type" };
        }
      }
    }
  }

  throw new AbapError(
    "SERVICE_METADATA_UNPARSEABLE",
    "This $metadata document does not identify itself as OData V2 or V4: no edmx Version " +
      "attribute, no DataServiceVersion, no <Association> element and no typed " +
      "<NavigationProperty>.",
    { edmxVersion: v, dataServiceVersion: dsv },
    "Do NOT re-request it — the same bytes will come back. Read it with mode=\"raw\" and " +
      "look at the <edmx:Edmx> root element. If the body is an HTML logon page or an SAP " +
      "error page rather than EDMX, the service runtime rejected the request before the " +
      "OData handler saw it, and the fix is at the ICF/authorization layer, not here.",
  );
}

// -------------------------------------------------------------- V2 dialect ---

/**
 * V2 association index: qualified association name → its two ends keyed by
 * `Role`. Built once to avoid a quadratic per-nav-property linear scan.
 */
type AssociationIndex = Map<string, Map<string, { type: string; multiplicity?: string }>>;

function indexAssociations(schemas: readonly Rec[]): AssociationIndex {
  const idx: AssociationIndex = new Map();
  for (const s of schemas) {
    const ns = attr(s, "Namespace");
    for (const a of list(s, "Association")) {
      const name = attr(a, "Name");
      if (!name) continue;
      const ends = new Map<string, { type: string; multiplicity?: string }>();
      for (const e of list(a, "End")) {
        const role = attr(e, "Role");
        const type = attr(e, "Type");
        if (!role || !type) continue;
        const mult = attr(e, "Multiplicity");
        ends.set(role, { type, ...(mult === undefined ? {} : { multiplicity: mult }) });
      }
      // Indexed under both qualified and bare name so either `Relationship` spelling resolves.
      idx.set(name, ends);
      if (ns) idx.set(`${ns}.${name}`, ends);
    }
  }
  return idx;
}

function v2Navigation(typeNode: Rec, assoc: AssociationIndex): EdmxNavigation[] {
  const out: EdmxNavigation[] = [];
  for (const n of list(typeNode, "NavigationProperty")) {
    const name = attr(n, "Name");
    if (!name) continue;
    const rel = attr(n, "Relationship");
    const toRole = attr(n, "ToRole");
    const end = rel !== undefined && toRole !== undefined ? assoc.get(rel)?.get(toRole) : undefined;
    if (!end) {
      out.push({
        name,
        target: rel ? `(unresolved via ${rel})` : "(unresolved)",
        unresolved: true,
      });
      continue;
    }
    out.push({
      name,
      target: end.type,
      ...(end.multiplicity === undefined ? {} : { multiplicity: end.multiplicity }),
    });
  }
  return out;
}

function v2Property(p: Rec): EdmxProperty | undefined {
  const name = attr(p, "Name");
  if (!name) return undefined;
  return {
    name,
    type: attr(p, "Type") ?? "(untyped)",
    ...opt("nullable", boolAttr(p, "Nullable")),
    ...opt("maxLength", attr(p, "MaxLength")),
    ...opt("precision", attr(p, "Precision")),
    ...opt("scale", attr(p, "Scale")),
    ...opt("label", attr(p, "label")),
    ...opt("creatable", boolAttr(p, "creatable")),
    ...opt("updatable", boolAttr(p, "updatable")),
    ...opt("sortable", boolAttr(p, "sortable")),
    ...opt("filterable", boolAttr(p, "filterable")),
    ...opt("requiredInFilter", boolAttr(p, "required-in-filter")),
    ...opt("unit", attr(p, "unit")),
    ...opt("text", attr(p, "text")),
  };
}

/** `exactOptionalPropertyTypes` makes conditional spreads the only clean way. */
function opt<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function v2Capabilities(set: Rec): EdmxCapabilities {
  return {
    ...opt("creatable", boolAttr(set, "creatable")),
    ...opt("updatable", boolAttr(set, "updatable")),
    ...opt("deletable", boolAttr(set, "deletable")),
    ...opt("searchable", boolAttr(set, "searchable")),
    ...opt("pageable", boolAttr(set, "pageable")),
    ...opt("countable", boolAttr(set, "countable")),
    ...opt("addressable", boolAttr(set, "addressable")),
    ...opt("requiresFilter", boolAttr(set, "requires-filter")),
  };
}

// -------------------------------------------------------------- V4 dialect ---

/**
 * V4 annotation reader for record-shaped `<Annotation>` values. `Term` is
 * compared by LOCAL name (`InsertRestrictions`) since the alias prefix is
 * document-defined (`Capabilities.`, `Org.OData.Capabilities.V1.`, …) and
 * free to change.
 */
function v4RecordFlag(ann: Rec, property: string): boolean | undefined {
  for (const rec of list(ann, "Record")) {
    for (const pv of list(rec, "PropertyValue")) {
      if (attr(pv, "Property") === property) return boolAttr(pv, "Bool");
    }
  }
  return undefined;
}

function v4AnnotationsOf(node: unknown): Rec[] {
  return list(node, "Annotation");
}

function v4Label(node: unknown): string | undefined {
  return v4LabelOf(v4AnnotationsOf(node));
}

/** Label from an already-collected annotation list — split out because an entity set's label can arrive via an external `<Annotations Target=…>` block, not just inline. */
function v4LabelOf(annotations: readonly Rec[]): string | undefined {
  for (const a of annotations) {
    if (localName(attr(a, "Term") ?? "") === "Label") return attr(a, "String");
  }
  return undefined;
}

function v4Capabilities(annotations: readonly Rec[]): EdmxCapabilities {
  let creatable: boolean | undefined;
  let updatable: boolean | undefined;
  let deletable: boolean | undefined;
  let searchable: boolean | undefined;
  let countable: boolean | undefined;
  let pageable: boolean | undefined;
  let requiresFilter: boolean | undefined;

  for (const a of annotations) {
    const term = localName(attr(a, "Term") ?? "");
    switch (term) {
      case "InsertRestrictions":
        creatable = v4RecordFlag(a, "Insertable") ?? creatable;
        break;
      case "UpdateRestrictions":
        updatable = v4RecordFlag(a, "Updatable") ?? updatable;
        break;
      case "DeleteRestrictions":
        deletable = v4RecordFlag(a, "Deletable") ?? deletable;
        break;
      case "SearchRestrictions":
        searchable = v4RecordFlag(a, "Searchable") ?? searchable;
        break;
      case "CountRestrictions":
        countable = v4RecordFlag(a, "Countable") ?? countable;
        break;
      case "FilterRestrictions":
        requiresFilter = v4RecordFlag(a, "RequiresFilter") ?? requiresFilter;
        break;
      // V4 spelling of sap:pageable; first explicit `false` wins over a later `true`.
      case "TopSupported":
      case "SkipSupported": {
        const v = boolAttr(a, "Bool");
        if (v === false) pageable = false;
        else if (v === true && pageable === undefined) pageable = true;
        break;
      }
      default:
        break;
    }
  }
  return {
    ...opt("creatable", creatable),
    ...opt("updatable", updatable),
    ...opt("deletable", deletable),
    ...opt("searchable", searchable),
    ...opt("countable", countable),
    ...opt("pageable", pageable),
    ...opt("requiresFilter", requiresFilter),
  };
}

/**
 * `<Annotations Target="ns.Container/Set">` blocks, indexed by target — SAP's
 * V4 generator emits capability annotations here as often as inline.
 */
function indexV4ExternalAnnotations(schemas: readonly Rec[]): Map<string, Rec[]> {
  const idx = new Map<string, Rec[]>();
  for (const s of schemas) {
    for (const block of list(s, "Annotations")) {
      const target = attr(block, "Target");
      if (!target) continue;
      const anns = v4AnnotationsOf(block);
      if (anns.length === 0) continue;
      idx.set(target, [...(idx.get(target) ?? []), ...anns]);
      // Also indexed by the unqualified `Container/Set` tail, since Target may use either the
      // schema namespace or its alias. Cut at the last dot before `/` — namespaces contain dots too.
      const slash = target.indexOf("/");
      const cut = slash === -1 ? target.lastIndexOf(".") : target.lastIndexOf(".", slash);
      const short = cut === -1 ? target : target.slice(cut + 1);
      if (short !== target) idx.set(short, [...(idx.get(short) ?? []), ...anns]);
    }
  }
  return idx;
}

function v4Navigation(typeNode: Rec): EdmxNavigation[] {
  const out: EdmxNavigation[] = [];
  for (const n of list(typeNode, "NavigationProperty")) {
    const name = attr(n, "Name");
    if (!name) continue;
    const raw = attr(n, "Type");
    if (raw === undefined) {
      out.push({ name, target: "(unresolved)", unresolved: true });
      continue;
    }
    const { type, collection } = unwrapCollection(raw);
    // V4 has no Multiplicity attribute; Collection(...) vs bare type normalises onto V2's vocabulary.
    const multiplicity = collection ? "*" : boolAttr(n, "Nullable") === false ? "1" : "0..1";
    out.push({ name, target: type, multiplicity });
  }
  return out;
}

function v4Property(p: Rec): EdmxProperty | undefined {
  const name = attr(p, "Name");
  if (!name) return undefined;
  return {
    name,
    type: attr(p, "Type") ?? "(untyped)",
    ...opt("nullable", boolAttr(p, "Nullable")),
    ...opt("maxLength", attr(p, "MaxLength")),
    ...opt("precision", attr(p, "Precision")),
    ...opt("scale", attr(p, "Scale")),
    ...opt("label", v4Label(p)),
  };
}

// ------------------------------------------------------------- operations ---

function paramsOf(node: Rec): EdmxOperationParam[] {
  const out: EdmxOperationParam[] = [];
  for (const p of list(node, "Parameter")) {
    const name = attr(p, "Name");
    if (!name) continue;
    out.push({
      name,
      type: attr(p, "Type") ?? "(untyped)",
      ...opt("mode", attr(p, "Mode")),
    });
  }
  return out;
}

/**
 * V2 function imports carry parameters inline; `HttpMethod` says whether
 * calling one is a read or a side effect. abapsmith never calls one — this
 * is contract description, not an invitation.
 */
function v2Operations(container: Rec): EdmxOperation[] {
  const out: EdmxOperation[] = [];
  for (const f of list(container, "FunctionImport")) {
    const name = attr(f, "Name");
    if (!name) continue;
    const method = attr(f, "HttpMethod");
    out.push({
      name,
      kind: method !== undefined && method.toUpperCase() !== "GET" ? "action" : "function",
      ...opt("httpMethod", method),
      ...opt("returnType", attr(f, "ReturnType")),
      parameters: paramsOf(f),
    });
  }
  return out;
}

/**
 * V4 splits an operation's definition (schema `<Action>`/`<Function>`) from
 * its exposure (container `<ActionImport>`/`<FunctionImport>`). Both unbound
 * imports and bound operations are reported — omitting a bound action would
 * understate what the service permits on an entity.
 */
function v4Operations(schemas: readonly Rec[], container: Rec | undefined): EdmxOperation[] {
  const defs = new Map<string, { kind: "action" | "function"; node: Rec }>();
  for (const s of schemas) {
    const ns = attr(s, "Namespace");
    for (const [tag, kind] of [
      ["Action", "action"],
      ["Function", "function"],
    ] as const) {
      for (const node of list(s, tag)) {
        const name = attr(node, "Name");
        if (!name) continue;
        defs.set(name, { kind, node });
        if (ns) defs.set(`${ns}.${name}`, { kind, node });
      }
    }
  }

  const out: EdmxOperation[] = [];
  const seen = new Set<string>();
  for (const [tag, attrName] of [
    ["ActionImport", "Action"],
    ["FunctionImport", "Function"],
  ] as const) {
    for (const imp of list(container, tag)) {
      const name = attr(imp, "Name");
      if (!name) continue;
      const targetRef = attr(imp, attrName);
      const def = targetRef === undefined ? undefined : defs.get(targetRef);
      seen.add(targetRef ?? name);
      out.push({
        name,
        kind: tag === "ActionImport" ? "action" : "function",
        ...opt("returnType", attr(child(def?.node, "ReturnType"), "Type")),
        parameters: def ? paramsOf(def.node) : [],
      });
    }
  }

  // Bound operations have no import; the binding parameter (first) is kept — "bound to what" is the point.
  for (const s of schemas) {
    for (const [tag, kind] of [
      ["Action", "action"],
      ["Function", "function"],
    ] as const) {
      for (const node of list(s, tag)) {
        const name = attr(node, "Name");
        if (!name || seen.has(name)) continue;
        if (boolAttr(node, "IsBound") !== true) continue;
        out.push({
          name,
          kind,
          ...opt("returnType", attr(child(node, "ReturnType"), "Type")),
          parameters: paramsOf(node),
        });
      }
    }
  }
  return out;
}

// -------------------------------------------------------------- entry point ---

/**
 * Parse an EDMX `$metadata` document into the compressed contract. Throws
 * `SERVICE_METADATA_UNPARSEABLE` (never a bare `Error` or generic
 * `ADT_ERROR`) for a body that isn't EDMX — commonly an SAP logon page, an
 * ICF error page, or a JSON metadata document.
 */
export function parseEdmx(body: string): EdmxContract {
  const rawBytes = Buffer.byteLength(body, "utf8");

  let doc: unknown;
  try {
    doc = edmxXml.parse(body);
  } catch (e) {
    throw new AbapError(
      "SERVICE_METADATA_UNPARSEABLE",
      `The service answered with something that is not well-formed XML: ${
        e instanceof Error ? e.message : String(e)
      }`,
      { rawBytes, excerpt: truncateText(body, PARSE_EXCERPT_MAX) },
      "Do NOT retry — a malformed body is not a transient. The excerpt above is what came " +
        "back; an HTML `<html>` root means the ICF layer answered instead of the OData " +
        "handler (logon screen or error page), which is an authorization or SICF problem.",
    );
  }

  const edmx = child(doc, "Edmx");
  if (!edmx) {
    throw new AbapError(
      "SERVICE_METADATA_UNPARSEABLE",
      "The service answered with XML that has no <edmx:Edmx> root element, so it is not an " +
        "OData $metadata document.",
      { rawBytes, excerpt: truncateText(body, PARSE_EXCERPT_MAX) },
      "Do NOT retry — the same bytes will come back. Check the excerpt above: an SAP error " +
        "document (`<error>`) names the real problem in its message element, and an HTML " +
        "root means the request never reached the OData handler.",
    );
  }

  const dataServices = child(edmx, "DataServices");
  const schemas = list(dataServices, "Schema");
  const { version, evidence } = detectVersion(edmx, schemas);

  const containerSchema = schemas.find((s) => list(s, "EntityContainer").length > 0);
  const container = containerSchema ? child(containerSchema, "EntityContainer") : undefined;

  const assoc = version === "V2" ? indexAssociations(schemas) : undefined;
  const externalAnnotations = version === "V4" ? indexV4ExternalAnnotations(schemas) : undefined;

  const entityTypes: EdmxEntityType[] = [];
  for (const s of schemas) {
    for (const t of list(s, "EntityType")) {
      const name = attr(t, "Name");
      if (!name) continue;
      const keys: string[] = [];
      for (const ref of list(child(t, "Key"), "PropertyRef")) {
        const k = attr(ref, "Name");
        if (k) keys.push(k);
      }
      const properties: EdmxProperty[] = [];
      for (const p of list(t, "Property")) {
        const parsed = version === "V2" ? v2Property(p) : v4Property(p);
        if (parsed) properties.push(parsed);
      }
      entityTypes.push({
        name,
        ...opt("label", version === "V2" ? attr(t, "label") : v4Label(t)),
        keys,
        properties,
        navigation: version === "V2" ? v2Navigation(t, assoc ?? new Map()) : v4Navigation(t),
      });
    }
  }

  const containerName = attr(container, "Name");
  const entitySets: EdmxEntitySet[] = [];
  for (const set of list(container, "EntitySet")) {
    const name = attr(set, "Name");
    if (!name) continue;
    const entityType = attr(set, "EntityType") ?? "(untyped)";
    if (version === "V2") {
      entitySets.push({
        name,
        entityType,
        ...opt("label", attr(set, "label")),
        capabilities: v2Capabilities(set),
      });
    } else {
      const inline = v4AnnotationsOf(set);
      const external = [
        ...(externalAnnotations?.get(`${containerName ?? ""}/${name}`) ?? []),
        ...(containerSchema
          ? (externalAnnotations?.get(
              `${attr(containerSchema, "Namespace") ?? ""}.${containerName ?? ""}/${name}`,
            ) ?? [])
          : []),
      ];
      const all = [...inline, ...external];
      entitySets.push({
        name,
        entityType,
        ...opt("label", v4LabelOf(all)),
        capabilities: v4Capabilities(all),
      });
    }
  }

  return {
    version,
    versionEvidence: evidence,
    ...opt("namespace", attr(schemas[0], "Namespace")),
    ...opt("entityContainer", containerName),
    entitySets,
    entityTypes,
    operations: version === "V2" ? v2Operations(container ?? {}) : v4Operations(schemas, container),
    rawBytes,
  };
}

/**
 * Look up by qualified or bare name. Case-insensitive on the bare name only
 * — CSDL itself is case-sensitive, but a typo like `travelset` deserves a
 * match, not a refusal.
 */
export function findEntityType(
  contract: EdmxContract,
  qualifiedOrBare: string,
): EdmxEntityType | undefined {
  const bare = localName(qualifiedOrBare);
  return (
    contract.entityTypes.find((t) => t.name === bare) ??
    contract.entityTypes.find((t) => t.name.toLowerCase() === bare.toLowerCase())
  );
}

/** Same leniency as {@link findEntityType}, for entity sets. */
export function findEntitySet(contract: EdmxContract, name: string): EdmxEntitySet | undefined {
  return (
    contract.entitySets.find((s) => s.name === name) ??
    contract.entitySets.find((s) => s.name.toLowerCase() === name.toLowerCase())
  );
}
