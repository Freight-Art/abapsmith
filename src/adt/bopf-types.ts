/**
 * BOPF whole-model wire format — pure types, enum literals, and attribute/child
 * order tables. No logic. Stable contract for the scanner/renderer/splice engine
 * (`src/adt/bopf-xml.ts`) and the ADT client (`src/adt/bopf.ts`).
 *
 * Every fact (attribute order, child order, GUID split, which attributes exist
 * per element kind) is taken from the BOPF ADT payload schema and cross-checked
 * against captured bytes in `test/fixtures/bopf/`. Where the wire never showed a
 * position, an `UNVERIFIED` note says so rather than silently guessing.
 */

// ---------------------------------------------------------------------------
// Object references (`adtcore:AdtObjectReference` — every `*Ref` element)
// ---------------------------------------------------------------------------

/** Attribute order: `uri`, `type`, `name`. `uri` is omitted when the ref target doesn't exist yet ([WIRE]-confirmed). */
export interface AdtObjectRef {
  readonly uri?: string;
  readonly type: string;
  readonly name: string;
}

export const REF_ATTR_ORDER = ["uri", "type", "name"] as const;

// ---------------------------------------------------------------------------
// Enumeration literals
// ---------------------------------------------------------------------------

/** `[WIRE]`: `0_1`, `0_N`, `1_1`. `1_N` is `[SCHEMA]`-only. */
export type MultiplicityType = "0_1" | "0_N" | "1_1" | "1_N";

/** `[WIRE]`: `Composition`, `DoComposition`, `Association`. `C`, `A` are `[SCHEMA]`-only. */
export type AssociationImplementationType = "Composition" | "DoComposition" | "Association" | "C" | "A";

/** [SCHEMA]-only — never emitted on the wire, not even by SAP's own demo BO. TRAP: do not send it. */
export type AssociationCategoryType = "N" | "P" | "R" | "X";

/** `[WIRE]`: `businessProcessObject` is the only value ever observed. */
export type BusinessObjectCategoryType =
  | "businessProcessObject"
  | "draftObject"
  | "dependentObject"
  | "enhancementBusinessObject";

/** `[WIRE]`: all three observed. */
export type QueryCategoryType = "selectAll" | "selectByElements" | "customQuery";

/** `[WIRE]`: both observed. */
export type ValidationCategoryType = "consistencyCheck" | "actionCheck";

/** `[WIRE]`: `reactAfterModification`, `reactDuringSave`, `undefined` observed; rest are `[SCHEMA]`-only. */
export type DeterminationCategoryType =
  | "reactAfterModification"
  | "calculateTransientAttributes"
  | "calculateTransientSubNodeInstances"
  | "calculateProperties"
  | "reactOnCheckAndDetermine"
  | "reactBeforeSave"
  | "drawNumbersDuringCreate"
  | "drawNumbersDuringSave"
  | "reactDuringSave"
  | "reactAfterSuccessfulSave"
  | "reactAfterCleanupTransaction"
  | "reactAfterFailedSave"
  | "undefined";

/** `[WIRE]`: `2` (multiple) observed. `0` (none), `1` (single) are `[SCHEMA]`-only. */
export type ActionInstanceMultiplicityType = "0" | "1" | "2";

/** `[SCHEMA]`-only in every capture; never observed set to anything but its default. */
export type ExportingMultiplicityType = "0" | "1" | "2" | "3" | "4";

/** `[WIRE]`: `None` is the only value ever observed. */
export type ExportingParameterCategoryType = "None" | "Type" | "Node";

/** `[WIRE]`: `uniqueIfNotInitial` is the only value ever observed. */
export type KeyUniquenessType = "unique" | "uniqueIfNotInitial" | "notUnique";

/** `bo:Binding/@bo:operator` only — NOT `bo:Association.operator` (never on the wire, an element if it existed). */
export type BindingOperatorType = "EQ" | "GE" | "LE" | "GT" | "LT" | "NE";

/** `[WIRE]`: both observed on `bo:relations/@bo:relationType`. */
export type RelationType = "predecessor" | "successor";

/** `adtcore:version`. `[WIRE]`: `active`, `inactive` observed. */
export type AdtVersionType =
  | "active"
  | "inactive"
  | "workingArea"
  | "new"
  | "partlyActive"
  | ""
  | "activeWithInactiveVersion";

/** `bo:actions/@bo:category` — opaque numeric code (`"3"`, `"0"` observed), NOT an enum. TRAP: don't assume it's one. */
export type ActionCategoryCode = string;

// ---------------------------------------------------------------------------
// Element kinds this engine renders/locates, and GUID rendering
// ---------------------------------------------------------------------------

/** The repeating element kinds the splice engine locates/renders/inserts/removes as top-level targets. */
export type ElementKind =
  | "node"
  | "association"
  | "action"
  | "determination"
  | "validation"
  | "query"
  | "alternativeKey";

export type GuidEncoding = "base64" | "hex32";

/**
 * Two renderings of the same 16-byte GUID, split by entity type. Never re-encode
 * an ID read from the wire — echo it back verbatim. Only for minting a fresh ID
 * on an element the engine itself constructs.
 */
export const GUID_ENCODING: Readonly<Record<ElementKind, GuidEncoding>> = {
  node: "base64",
  determination: "base64",
  validation: "base64",
  association: "hex32",
  query: "hex32",
  action: "hex32",
  alternativeKey: "hex32",
};

// ---------------------------------------------------------------------------
// Attribute order tables — one per element kind, wire-verified. Order is
// load-bearing: attribute order in the XML wire format is significant.
// ---------------------------------------------------------------------------

/**
 * `bo:nodes` attribute order. `parent`/`parentNodeID` appear only on non-root nodes.
 * `doEmbeddingName`'s position here is UNVERIFIED — copied from its confirmed
 * position on `bo:associations`; see archive.
 */
export const NODE_ATTR_ORDER = [
  "name",
  "nodeID",
  "parent",
  "parentNodeID",
  "xmlName",
  "doEmbeddingName",
  "objectModelGenerated",
  "authorizationCheck",
  "isExtensible",
  "isDependentObjectNode",
  "textNode",
  "createEnabled",
  "updateEnabled",
  "deleteEnabled",
  "rootNode",
  "objectModelObsolete",
] as const;

/** `bo:associations` attribute order. Wire-confirmed, including `doEmbeddingName` between `xmlName` and `multiplicity`. */
export const ASSOCIATION_ATTR_ORDER = [
  "name",
  "nodeID",
  "implementationType",
  "objectModelGenerated",
  "xmlName",
  "doEmbeddingName",
  "multiplicity",
] as const;

/** `bo:actions` attribute order. `xmlName`, when present, sits right after `nodeID` (wire-confirmed). */
export const ACTION_ATTR_ORDER = [
  "name",
  "nodeID",
  "xmlName",
  "exportingParameterCategoryType",
  "objectModelGenerated",
  "category",
  "isExtensible",
  "exportParameterLink",
  "instanceMultiplicity",
] as const;

/** `bo:determinations` attribute order. Wire-confirmed. */
export const DETERMINATION_ATTR_ORDER = ["name", "nodeID", "xmlName", "objectModelGenerated", "category"] as const;

/** `bo:validations` attribute order. Wire-confirmed. */
export const VALIDATION_ATTR_ORDER = [
  "name",
  "nodeID",
  "xmlName",
  "objectModelGenerated",
  "category",
  "checkBeforeSave",
  "createNode",
  "updateNode",
  "deleteNode",
] as const;

/**
 * `bo:queries` attribute order. Genuinely inconsistent with determinations/validations:
 * `objectModelGenerated` sits BEFORE `xmlName` here — wire-confirmed, not a transcription
 * error. There is no single ordering rule across element kinds; every table here is
 * hardcoded from real bytes.
 */
export const QUERY_ATTR_ORDER = ["name", "nodeID", "objectModelGenerated", "xmlName", "category"] as const;

/** `bo:alternativeKeys` attribute order. Wire-confirmed. */
export const ALTERNATIVE_KEY_ATTR_ORDER = [
  "name",
  "nodeID",
  "xmlName",
  "objectModelGenerated",
  "uniqueness",
  "checkAfterModify",
  "checkBeforeSave",
  "noCheck",
] as const;

/** `bo:properties` attribute order. All eight observed together on every property in every capture. */
export const PROPERTY_ATTR_ORDER = [
  "name",
  "enabled",
  "readonly",
  "mandatory",
  "enabledFinal",
  "readonlyFinal",
  "mandatoryFinal",
  "transientAttribute",
] as const;

/** `bo:DeterminationTrigger` (`bo:triggers` under `bo:determinations`) attribute order. Wire-confirmed. */
export const DETERMINATION_TRIGGER_ATTR_ORDER = [
  "node",
  "association",
  "create",
  "update",
  "delete",
  "load",
  "determine",
] as const;

/**
 * `bo:ValidationTrigger` attribute order, wire-confirmed including `action` trailing
 * after `check`. `action` is validation-trigger-only (never on `bo:DeterminationTrigger`)
 * and can appear ALONE, with `node`/`association` both absent — see archive.
 */
export const VALIDATION_TRIGGER_ATTR_ORDER = [
  "node",
  "association",
  "create",
  "update",
  "delete",
  "check",
  "action",
] as const;

/** `bo:relations` (under `bo:determinations`) attribute order. Wire-confirmed. Has no `bo:name`. */
export const RELATION_ATTR_ORDER = ["node", "determination", "relationType"] as const;

/** `bo:keyElements` (`bo:Field`, under `bo:alternativeKeys`) — only attribute is `bo:name`. */
export const KEY_ELEMENT_ATTR_ORDER = ["name"] as const;

// ---------------------------------------------------------------------------
// Child (containment) order tables — from the payload schema's containment
// outline, cross-checked against captured fixtures.
// ---------------------------------------------------------------------------

/**
 * Child order inside a `bo:nodes` element. `transientStructureRef` was never
 * captured on the wire; its position (after `persistentStructureRef`, before
 * `combinedStructureRef`) is UNVERIFIED, taken from the schema's containment outline.
 */
export const NODE_CHILD_ORDER = [
  "persistentStructureRef",
  "transientStructureRef",
  "combinedStructureRef",
  "combinedTableRef",
  "persistentTableRef",
  "defaultingClassRef",
  "dataAccessClassRef",
  "authorizationClassRef",
  "properties",
  "alternativeKeys",
  "associations",
  "queries",
  "actions",
  "determinations",
  "validations",
] as const;

/** Child order inside a `bo:associations` element. Wire-confirmed. */
export const ASSOCIATION_CHILD_ORDER = ["targetNodeRef", "implementationClassRef", "parameterStructureRef"] as const;

/** Child order inside a `bo:actions` element. Wire-confirmed. */
export const ACTION_CHILD_ORDER = ["implementationClassRef", "parameterStructureRef"] as const;

/** Child order inside a `bo:determinations` element. Wire-confirmed. */
export const DETERMINATION_CHILD_ORDER = ["implementationClassRef", "triggers", "relations"] as const;

/** Child order inside a `bo:validations` element. Wire-confirmed. */
export const VALIDATION_CHILD_ORDER = ["implementationClassRef", "triggers"] as const;

/**
 * Child order inside a `bo:queries` element. `dataTypeRef` before `implementationClassRef`
 * is wire-confirmed only for `dataTypeRef` alone; the relative order of the other three
 * is UNVERIFIED, taken from the schema's own listing order (no capture has more than one).
 */
export const QUERY_CHILD_ORDER = ["dataTypeRef", "implementationClassRef", "resultTypeRef", "resultTableTypeRef"] as const;

/** Child order inside a `bo:alternativeKeys` element. Wire-confirmed. */
export const ALTERNATIVE_KEY_CHILD_ORDER = ["dataTypeRef", "dataTableTypeRef", "keyElements"] as const;

// ---------------------------------------------------------------------------
// Read-view model — output of `parseModel()`. Read-only: never serialised back
// (that's the splice engine's job, working on raw bytes, not this tree).
// ---------------------------------------------------------------------------

export interface BoProperty {
  readonly name: string;
  readonly enabled?: boolean;
  readonly readonly?: boolean;
  readonly mandatory?: boolean;
  readonly enabledFinal?: boolean;
  readonly readonlyFinal?: boolean;
  readonly mandatoryFinal?: boolean;
  readonly transientAttribute?: boolean;
  readonly xmlName?: string;
}

export interface BoDeterminationTrigger {
  readonly node?: string;
  readonly association?: string;
  readonly create?: boolean;
  readonly update?: boolean;
  readonly delete?: boolean;
  readonly load?: boolean;
  readonly determine?: boolean;
}

export interface BoValidationTrigger {
  readonly node?: string;
  readonly association?: string;
  readonly create?: boolean;
  readonly update?: boolean;
  readonly delete?: boolean;
  readonly check?: boolean;
  /** Name-keyed XPath fragment referencing a `bo:actions` element — may live on a DIFFERENT node than `node`/`association` above (`[WIRE]`). May be the only populated field on a purely action-gated trigger. */
  readonly action?: string;
}

export interface BoRelation {
  readonly node?: string;
  readonly determination?: string;
  readonly relationType?: RelationType;
}

export interface BoAssociation {
  /** May legitimately be the empty string (14 cases in the SAP demo BO). */
  readonly name: string;
  /** As-read, hex32-encoded. Never decoded/re-encoded — echo only. */
  readonly nodeId?: string;
  readonly xmlName?: string;
  readonly multiplicity?: MultiplicityType;
  readonly implementationType?: AssociationImplementationType;
  readonly objectModelGenerated?: boolean;
  readonly doEmbeddingName?: string;
  readonly targetNodeRef?: AdtObjectRef;
  readonly implementationClassRef?: AdtObjectRef;
  readonly parameterStructureRef?: AdtObjectRef;
}

export interface BoAction {
  readonly name: string;
  /** As-read, hex32-encoded. */
  readonly nodeId?: string;
  readonly xmlName?: string;
  /** Opaque numeric code (`"3"`, `"0"`), not an enum. */
  readonly category?: ActionCategoryCode;
  readonly instanceMultiplicity?: ActionInstanceMultiplicityType;
  readonly exportingMultiplicity?: ExportingMultiplicityType;
  readonly exportingParameterCategoryType?: ExportingParameterCategoryType;
  readonly exportParameterLink?: boolean;
  readonly isExtensible?: boolean;
  readonly objectModelGenerated?: boolean;
  readonly implementationClassRef?: AdtObjectRef;
  readonly parameterStructureRef?: AdtObjectRef;
}

export interface BoDetermination {
  readonly name: string;
  /** As-read, base64-encoded. */
  readonly nodeId?: string;
  readonly xmlName?: string;
  readonly category?: DeterminationCategoryType;
  readonly objectModelGenerated?: boolean;
  readonly implementationClassRef?: AdtObjectRef;
  readonly triggers: readonly BoDeterminationTrigger[];
  readonly relations: readonly BoRelation[];
}

export interface BoValidation {
  readonly name: string;
  /** As-read, base64-encoded. */
  readonly nodeId?: string;
  readonly xmlName?: string;
  readonly category?: ValidationCategoryType;
  readonly checkBeforeSave?: boolean;
  readonly createNode?: boolean;
  readonly updateNode?: boolean;
  readonly deleteNode?: boolean;
  readonly objectModelGenerated?: boolean;
  readonly implementationClassRef?: AdtObjectRef;
  readonly triggers: readonly BoValidationTrigger[];
}

export interface BoQuery {
  readonly name: string;
  /** As-read, hex32-encoded. */
  readonly nodeId?: string;
  readonly xmlName?: string;
  readonly category?: QueryCategoryType;
  readonly objectModelGenerated?: boolean;
  readonly dataTypeRef?: AdtObjectRef;
  readonly implementationClassRef?: AdtObjectRef;
}

export interface BoAlternativeKey {
  readonly name: string;
  /** As-read, hex32-encoded. */
  readonly nodeId?: string;
  readonly xmlName?: string;
  readonly uniqueness?: KeyUniquenessType;
  readonly checkAfterModify?: boolean;
  readonly checkBeforeSave?: boolean;
  readonly noCheck?: boolean;
  readonly objectModelGenerated?: boolean;
  readonly dataTypeRef?: AdtObjectRef;
  readonly dataTableTypeRef?: AdtObjectRef;
  /** `bo:keyElements/@bo:name` values, in document order. */
  readonly keyElements: readonly string[];
}

export interface BoNode {
  readonly name: string;
  /** As-read, base64-encoded. Required in practice on create; never a durable identifier. */
  readonly nodeId?: string;
  /** Copy of the parent's `nodeId` at read time. Absent on the root node. */
  readonly parentNodeId?: string;
  /** Name-keyed XPath, empty base, e.g. `#//bo:businessObject/bo:nodes[@bo:name='ROOT']`. Absent on the root node. */
  readonly parent?: string;
  readonly xmlName?: string;
  readonly doEmbeddingName?: string;
  readonly rootNode: boolean;
  readonly textNode: boolean;
  readonly isDependentObjectNode: boolean;
  readonly createEnabled: boolean;
  readonly updateEnabled: boolean;
  readonly deleteEnabled: boolean;
  readonly authorizationCheck: boolean;
  readonly isExtensible: boolean;
  readonly objectModelGenerated: boolean;
  readonly objectModelObsolete: boolean;
  readonly persistentStructureRef?: AdtObjectRef;
  readonly transientStructureRef?: AdtObjectRef;
  readonly combinedStructureRef?: AdtObjectRef;
  readonly combinedTableRef?: AdtObjectRef;
  readonly persistentTableRef?: AdtObjectRef;
  readonly defaultingClassRef?: AdtObjectRef;
  readonly dataAccessClassRef?: AdtObjectRef;
  readonly authorizationClassRef?: AdtObjectRef;
  readonly properties: readonly BoProperty[];
  readonly alternativeKeys: readonly BoAlternativeKey[];
  readonly associations: readonly BoAssociation[];
  readonly queries: readonly BoQuery[];
  readonly actions: readonly BoAction[];
  readonly determinations: readonly BoDetermination[];
  readonly validations: readonly BoValidation[];
}

export interface BoModel {
  readonly name: string;
  /** Always `BOBF`. */
  readonly type: string;
  readonly description?: string;
  readonly version?: AdtVersionType;
  readonly masterLanguage?: string;
  readonly masterSystem?: string;
  readonly responsible?: string;
  readonly language?: string;
  readonly objectCategory?: BusinessObjectCategoryType;
  readonly isExtensible?: boolean;
  readonly objectModelGenerated?: boolean;
  readonly thirdGenBO?: boolean;
  readonly smartValidation?: boolean;
  readonly rapBO?: boolean;
  readonly packageRef?: AdtObjectRef;
  readonly constantsInterfaceRef?: AdtObjectRef;
  readonly nodes: readonly BoNode[];
}

// ---------------------------------------------------------------------------
// Referential-integrity checking (backs `bopf.ts`'s `checkReferences`)
// ---------------------------------------------------------------------------

/** Every class-valued ref site's required interface, where the framework enforces one. */
export type RefSiteKind = "class" | "ddic";

/** `bo:*Ref` element names the integrity checker walks. */
export type RefSiteElement =
  | "implementationClassRef"
  | "defaultingClassRef"
  | "dataAccessClassRef"
  | "authorizationClassRef"
  | "persistentStructureRef"
  | "combinedStructureRef"
  | "combinedTableRef"
  | "persistentTableRef"
  | "parameterStructureRef"
  | "dataTypeRef"
  | "dataTableTypeRef"
  | "targetNodeRef";

/** One reference found in the model, located precisely enough to report and to re-find after a fix. */
export interface ClassRefSite {
  /** The element kind that owns this ref (or `"node"` for node-level refs). */
  readonly owner: ElementKind | "node";
  /** The node this ref lives under (or on, for node-level refs). */
  readonly node: string;
  /** Name of the owning association/action/determination/validation/query/alternativeKey, if `owner !== "node"`. */
  readonly member?: string;
  readonly element: RefSiteElement;
  readonly kind: RefSiteKind;
  readonly ref: AdtObjectRef;
  /** Interface the class must implement for its role, when the framework requires one. `[SCHEMA]`/`[WIRE]` derived. */
  readonly requiredInterface?: string;
}

export type RefVerdict = "present" | "missing" | "declaration-only" | "wrong-interface" | "pending" | "unchecked";

/** One `check_refs` result line: a site plus what was found there. */
export interface IntegrityFinding {
  readonly site: ClassRefSite;
  readonly verdict: RefVerdict;
  readonly detail?: string;
}
