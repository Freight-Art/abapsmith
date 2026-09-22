/**
 * Zero-network shape/key validator for `abap_bopf_edit`'s `spec` object.
 *
 * `src/tools/bopf.ts`'s `str()`/`bool()`/`ref()`/`strArray()` helpers each
 * turn an unreadable value into `undefined` rather than an error — that's
 * correct for genuinely OMITTED fields, but it also means a key the builders
 * never look at (misspelled, invented) and a key they DO look at but whose
 * value isn't the shape those helpers accept (a bare string where `ref()`
 * needs `{ name, type }`) both come out looking identical to "not set" —
 * silently. Two live incidents traced to exactly this: `spec.create`
 * on `add_node` (meant `createEnabled`) and `spec.implementationClassRef`/
 * `spec.persistentStructureRef` given as bare strings, both accepted and
 * discarded.
 *
 * This module is the reusable check for both failure modes, driven by a
 * per-operation table of the keys each builder in `bopf.ts` actually reads
 * (traced by grep, not guessed). It also checks enum membership for the
 * spec fields whose values are a closed set (multiplicity, category codes,
 * uniqueness, ...) — see `BOPF_ENUM_FIELDS` — reporting every accepted
 * value with its meaning so a wrong guess doesn't need a second round trip
 * to the docs. `category` on `add_action`/`set_action_fields` stays a plain
 * string: `ActionCategoryCode` is an opaque numeric code, not a closed enum.
 *
 * Called from `validateEditInputShape` in `bopf.ts`, before any lock or
 * network call.
 */
import { AbapError } from "../adt/errors.js";
import type {
  MultiplicityType,
  AssociationImplementationType,
  ActionInstanceMultiplicityType,
  ExportingParameterCategoryType,
  DeterminationCategoryType,
  ValidationCategoryType,
  QueryCategoryType,
  KeyUniquenessType,
  RelationType,
} from "../adt/bopf-types.js";

type Shape = "string" | "stringOrNull" | "boolean" | "booleanOrNull" | "ref" | "refOrNull" | "stringArray" | "objectArray";

type FieldTable = Readonly<Record<string, Shape>>;

/** One accepted enum value and its human-readable meaning, surfaced verbatim in a mismatch message. */
export interface EnumValue {
  readonly value: string;
  readonly meaning: string;
}

/** An enum-valued spec field. `"enumOrNull"` is the `set_*_fields` counterpart of `"enum"` — `null` clears the field, same as `stringOrNull`. */
export interface EnumShape {
  readonly kind: "enum" | "enumOrNull";
  readonly values: readonly EnumValue[];
}

/** A field table entry: either a plain shape, or an enum descriptor. */
export type SpecFieldSpec = Shape | EnumShape;

type SpecFieldTableInternal = Readonly<Record<string, SpecFieldSpec>>;

/** The plain `Shape` an enum descriptor dispatches as for non-enum-aware callers (`patchChildFields` et al. in `bopf.ts`). */
export function baseShape(spec: SpecFieldSpec): Shape {
  if (typeof spec === "string") return spec;
  return spec.kind === "enum" ? "string" : "stringOrNull";
}

/** For `src/tools/bopf.ts` to drive its own attribute-vs-ref-child dispatch off this module's whitelist instead of duplicating it. */
export type SpecShape = Shape;
export type SpecFieldTable = SpecFieldTableInternal;

interface Issue {
  readonly message: string;
  readonly detail: Record<string, unknown>;
}

/**
 * Builds a table's values into `readonly EnumValue[]`, in table order.
 * `exclude` drops members that are valid on the wire-level union but make no
 * sense as an accepted input (e.g. `DeterminationCategoryType`'s
 * `"undefined"`, which leaves the determination inert).
 */
function enumOf<K extends string>(
  table: Readonly<Record<K, string>>,
  opts?: { readonly exclude?: readonly string[] },
): readonly EnumValue[] {
  const exclude = new Set(opts?.exclude ?? []);
  return (Object.keys(table) as K[])
    .filter((k) => !exclude.has(k))
    .map((k) => ({ value: k, meaning: table[k] }));
}

const MULTIPLICITY_MEANINGS = {
  "0_1": "optional to-one: at most one target instance",
  "0_N": "optional to-many: any number of target instances",
  "1_1": "mandatory to-one: exactly one target instance",
  "1_N": "mandatory to-many: at least one target instance (schema-only, never observed on the wire)",
} satisfies Readonly<Record<MultiplicityType, string>>;

const IMPLEMENTATION_TYPE_MEANINGS = {
  Composition: "parent-child composition: the target node is a child of the source node",
  DoComposition: "composition to a delegated (dependent) object",
  Association: "cross-node or cross-BO association resolved by the association class",
  C: "schema short form of Composition (not observed on the wire)",
  A: "schema short form of Association (not observed on the wire)",
} satisfies Readonly<Record<AssociationImplementationType, string>>;

const INSTANCE_MULTIPLICITY_MEANINGS = {
  "0": "static: runs without a node instance (SC_ACT_CARD_STATIC)",
  "1": "single instance: exactly one node instance per call (SC_ACT_CARD_ONE)",
  "2": "multiple instances: any number of node instances per call (SC_ACT_CARD_MANY; what SAP's own actions use)",
} satisfies Readonly<Record<ActionInstanceMultiplicityType, string>>;

const EXPORTING_PARAMETER_CATEGORY_TYPE_MEANINGS = {
  None: "the action exports nothing",
  Type: "the action exports data of the DDIC type named in parameterStructureRef",
  Node: "the action exports instances of a node",
} satisfies Readonly<Record<ExportingParameterCategoryType, string>>;

/** All 13 union members, including `"undefined"` — the enum passed to `add_determination`/`set_determination_fields` EXCLUDES it: it leaves the determination inert, so it is not an accepted input. */
const DETERMINATION_CATEGORY_MEANINGS = {
  reactAfterModification: "runs after instances of the trigger node are created/updated/deleted",
  calculateTransientAttributes: "fills transient attributes when instances are loaded or changed",
  calculateTransientSubNodeInstances: "fills transient sub-node instances when the parent is loaded",
  calculateProperties: "computes field/action/association properties (enabled, read-only, mandatory)",
  reactOnCheckAndDetermine: "runs when the consumer calls check-and-determine",
  reactBeforeSave: "runs at the start of the save sequence, before validations",
  drawNumbersDuringCreate: "draws numbers for new instances at creation time",
  drawNumbersDuringSave: "draws numbers for new instances during save",
  reactDuringSave: "runs during the save sequence after validations",
  reactAfterSuccessfulSave: "runs after the database commit succeeded",
  reactAfterCleanupTransaction: "runs when the transaction is cleaned up (after commit or rollback)",
  reactAfterFailedSave: "runs after the save failed",
  undefined: "leaves the determination inert — not a usable value, schema-only",
} satisfies Readonly<Record<DeterminationCategoryType, string>>;

const VALIDATION_CATEGORY_MEANINGS = {
  consistencyCheck:
    "checks the trigger node's instances and reports messages; runs on check-and-determine and during save",
  actionCheck: "decides whether the trigger action may run on the given instances",
} satisfies Readonly<Record<ValidationCategoryType, string>>;

const QUERY_CATEGORY_MEANINGS = {
  selectAll: "returns every instance of the node",
  selectByElements: "filters instances by node attributes passed as selection parameters (generated implementation)",
  customQuery: "implemented by the query class",
} satisfies Readonly<Record<QueryCategoryType, string>>;

const UNIQUENESS_MEANINGS = {
  unique: "key values must be unique across all instances",
  uniqueIfNotInitial: "unique unless the key value is initial (what SAP's own keys use)",
  notUnique: "no uniqueness enforced (a plain secondary access path)",
} satisfies Readonly<Record<KeyUniquenessType, string>>;

const RELATION_TYPE_MEANINGS = {
  predecessor: "the named determination runs before this one",
  successor: "the named determination runs after this one",
} satisfies Readonly<Record<RelationType, string>>;

/** Every enum-valued spec field's accepted values, keyed by field name — the single source of truth `shapeIssue`'s enum branch reports from. */
export const BOPF_ENUM_FIELDS: Readonly<
  Record<
    | "multiplicity"
    | "implementationType"
    | "instanceMultiplicity"
    | "exportingParameterCategoryType"
    | "determinationCategory"
    | "validationCategory"
    | "queryCategory"
    | "uniqueness"
    | "relationType",
    readonly EnumValue[]
  >
> = {
  multiplicity: enumOf(MULTIPLICITY_MEANINGS),
  implementationType: enumOf(IMPLEMENTATION_TYPE_MEANINGS),
  instanceMultiplicity: enumOf(INSTANCE_MULTIPLICITY_MEANINGS),
  exportingParameterCategoryType: enumOf(EXPORTING_PARAMETER_CATEGORY_TYPE_MEANINGS),
  determinationCategory: enumOf(DETERMINATION_CATEGORY_MEANINGS, { exclude: ["undefined"] }),
  validationCategory: enumOf(VALIDATION_CATEGORY_MEANINGS),
  queryCategory: enumOf(QUERY_CATEGORY_MEANINGS),
  uniqueness: enumOf(UNIQUENESS_MEANINGS),
  relationType: enumOf(RELATION_TYPE_MEANINGS),
};

const NO_SPEC_FIELDS: FieldTable = {};

/** `create_bo`'s package/description/rootNodeName are top-level `abap_bopf_edit` arguments, never spec fields. */
const TOP_LEVEL_CREATE_BO_ARGS = new Set(["package", "description", "rootNodeName"]);

/** `classRefFromSpec` (bopf.ts): `implementationClassRef` (a full ref) wins; `class`/`implementationClass` (a bare name) is the fallback. All three read on every add_association/add_action/add_determination/add_validation/add_query. */
const CLASS_REF_FIELDS: FieldTable = {
  implementationClassRef: "ref",
  class: "string",
  implementationClass: "string",
};

/** `buildNodeFields` + `resolveParentLink` (bopf.ts). */
const ADD_NODE_FIELDS: FieldTable = {
  xmlName: "string",
  doEmbeddingName: "string",
  rootNode: "boolean",
  textNode: "boolean",
  isDependentObjectNode: "boolean",
  createEnabled: "boolean",
  updateEnabled: "boolean",
  deleteEnabled: "boolean",
  authorizationCheck: "boolean",
  isExtensible: "boolean",
  objectModelGenerated: "boolean",
  objectModelObsolete: "boolean",
  persistentStructureRef: "ref",
  transientStructureRef: "ref",
  combinedStructureRef: "ref",
  combinedTableRef: "ref",
  persistentTableRef: "ref",
  defaultingClassRef: "ref",
  dataAccessClassRef: "ref",
  authorizationClassRef: "ref",
  parent: "string",
  parentNodeId: "string",
};

/** `buildAssociationFields` (bopf.ts). */
const ADD_ASSOCIATION_FIELDS: SpecFieldTableInternal = {
  xmlName: "string",
  multiplicity: { kind: "enum", values: BOPF_ENUM_FIELDS.multiplicity },
  implementationType: { kind: "enum", values: BOPF_ENUM_FIELDS.implementationType },
  objectModelGenerated: "boolean",
  doEmbeddingName: "string",
  targetNodeRef: "ref",
  parameterStructureRef: "ref",
  ...CLASS_REF_FIELDS,
};

/** `buildActionFields` (bopf.ts). `category` is `str()`, not `strEnum()` — `ActionCategoryCode` is an opaque numeric string, not a closed enum. */
const ADD_ACTION_FIELDS: SpecFieldTableInternal = {
  xmlName: "string",
  category: "string",
  instanceMultiplicity: { kind: "enum", values: BOPF_ENUM_FIELDS.instanceMultiplicity },
  exportingParameterCategoryType: { kind: "enum", values: BOPF_ENUM_FIELDS.exportingParameterCategoryType },
  exportParameterLink: "boolean",
  isExtensible: "boolean",
  objectModelGenerated: "boolean",
  parameterStructureRef: "ref",
  ...CLASS_REF_FIELDS,
};

/** `buildDeterminationFields` (bopf.ts). `triggers`/`relations` shape checked at the array level here; each entry is checked separately (see `DETERMINATION_TRIGGER_FIELDS`/`RELATION_FIELDS`). */
const ADD_DETERMINATION_FIELDS: SpecFieldTableInternal = {
  xmlName: "string",
  category: { kind: "enum", values: BOPF_ENUM_FIELDS.determinationCategory },
  objectModelGenerated: "boolean",
  triggers: "objectArray",
  relations: "objectArray",
  ...CLASS_REF_FIELDS,
};

/** `buildValidationFields` (bopf.ts). No `relations` — only `buildDeterminationFields` reads that. */
const ADD_VALIDATION_FIELDS: SpecFieldTableInternal = {
  xmlName: "string",
  category: { kind: "enum", values: BOPF_ENUM_FIELDS.validationCategory },
  checkBeforeSave: "boolean",
  createNode: "boolean",
  updateNode: "boolean",
  deleteNode: "boolean",
  objectModelGenerated: "boolean",
  triggers: "objectArray",
  ...CLASS_REF_FIELDS,
};

/** `buildQueryFields` (bopf.ts). */
const ADD_QUERY_FIELDS: SpecFieldTableInternal = {
  xmlName: "string",
  category: { kind: "enum", values: BOPF_ENUM_FIELDS.queryCategory },
  objectModelGenerated: "boolean",
  dataTypeRef: "ref",
  ...CLASS_REF_FIELDS,
};

/** `buildAlternativeKeyFields` (bopf.ts). Whether these are jointly REQUIRED is `validateAlternativeKeySpec`'s job, not this module's — this only checks shape for whatever is present. */
const ADD_ALTERNATIVE_KEY_FIELDS: SpecFieldTableInternal = {
  xmlName: "string",
  uniqueness: { kind: "enum", values: BOPF_ENUM_FIELDS.uniqueness },
  checkAfterModify: "boolean",
  checkBeforeSave: "boolean",
  noCheck: "boolean",
  objectModelGenerated: "boolean",
  dataTypeRef: "ref",
  dataTableTypeRef: "ref",
  keyElements: "stringArray",
};

/**
 * `patchNodeFlags` (bopf.ts): `NODE_FLAG_NAMES`/`NODE_REF_KINDS` (both from
 * `../adt/bopf-xml.js`) plus `spec.name`. Every flag/ref is `unsettable` on
 * the wire, so `null` CLEARS it — the only operation where that's true.
 * `name`, unlike the flags/refs, is NOT nullable: `patchNodeFlags` only acts
 * on it when `typeof spec.name === "string"`, silently skipping any other
 * type rather than clearing anything.
 */
const SET_NODE_FLAGS_FIELDS: FieldTable = {
  name: "string",
  rootNode: "booleanOrNull",
  textNode: "booleanOrNull",
  isDependentObjectNode: "booleanOrNull",
  createEnabled: "booleanOrNull",
  updateEnabled: "booleanOrNull",
  deleteEnabled: "booleanOrNull",
  authorizationCheck: "booleanOrNull",
  isExtensible: "booleanOrNull",
  objectModelGenerated: "booleanOrNull",
  objectModelObsolete: "booleanOrNull",
  persistentStructureRef: "refOrNull",
  transientStructureRef: "refOrNull",
  combinedStructureRef: "refOrNull",
  combinedTableRef: "refOrNull",
  persistentTableRef: "refOrNull",
  defaultingClassRef: "refOrNull",
  dataAccessClassRef: "refOrNull",
  authorizationClassRef: "refOrNull",
};

/** bopf.ts's set_association_fields patch path: attribute fields via `patchOpenTagAttrs`, ref fields via `spliceSetElementRef` — every one `unsettable`, so `null` clears it. No `name` (see `RECOGNISED_BUT_REFUSED_FIELDS`). */
const SET_ASSOCIATION_FIELDS: SpecFieldTableInternal = {
  xmlName: "stringOrNull",
  multiplicity: { kind: "enumOrNull", values: BOPF_ENUM_FIELDS.multiplicity },
  implementationType: { kind: "enumOrNull", values: BOPF_ENUM_FIELDS.implementationType },
  doEmbeddingName: "stringOrNull",
  objectModelGenerated: "booleanOrNull",
  targetNodeRef: "refOrNull",
  parameterStructureRef: "refOrNull",
  implementationClassRef: "refOrNull",
  class: "string",
  implementationClass: "string",
};

/** bopf.ts's set_action_fields patch path. No `name` (see `RECOGNISED_BUT_REFUSED_FIELDS`). */
const SET_ACTION_FIELDS: SpecFieldTableInternal = {
  xmlName: "stringOrNull",
  category: "stringOrNull",
  instanceMultiplicity: { kind: "enumOrNull", values: BOPF_ENUM_FIELDS.instanceMultiplicity },
  exportingParameterCategoryType: { kind: "enumOrNull", values: BOPF_ENUM_FIELDS.exportingParameterCategoryType },
  exportParameterLink: "booleanOrNull",
  isExtensible: "booleanOrNull",
  objectModelGenerated: "booleanOrNull",
  parameterStructureRef: "refOrNull",
  implementationClassRef: "refOrNull",
  class: "string",
  implementationClass: "string",
};

/** bopf.ts's set_determination_fields patch path. `triggers`/`relations` are write-once (see `DETERMINATION_WRITE_ONCE_MESSAGES`); no `name` (see `RECOGNISED_BUT_REFUSED_FIELDS`). */
const SET_DETERMINATION_FIELDS: SpecFieldTableInternal = {
  xmlName: "stringOrNull",
  category: { kind: "enumOrNull", values: BOPF_ENUM_FIELDS.determinationCategory },
  objectModelGenerated: "booleanOrNull",
  implementationClassRef: "refOrNull",
  class: "string",
  implementationClass: "string",
};

/** bopf.ts's set_validation_fields patch path. `triggers` is write-once (see `VALIDATION_WRITE_ONCE_MESSAGES`); no `name` (see `RECOGNISED_BUT_REFUSED_FIELDS`). */
const SET_VALIDATION_FIELDS: SpecFieldTableInternal = {
  xmlName: "stringOrNull",
  category: { kind: "enumOrNull", values: BOPF_ENUM_FIELDS.validationCategory },
  checkBeforeSave: "booleanOrNull",
  createNode: "booleanOrNull",
  updateNode: "booleanOrNull",
  deleteNode: "booleanOrNull",
  objectModelGenerated: "booleanOrNull",
  implementationClassRef: "refOrNull",
  class: "string",
  implementationClass: "string",
};

/** bopf.ts's set_query_fields patch path. No `name` (see `RECOGNISED_BUT_REFUSED_FIELDS`). */
const SET_QUERY_FIELDS: SpecFieldTableInternal = {
  xmlName: "stringOrNull",
  category: { kind: "enumOrNull", values: BOPF_ENUM_FIELDS.queryCategory },
  objectModelGenerated: "booleanOrNull",
  dataTypeRef: "refOrNull",
  implementationClassRef: "refOrNull",
  class: "string",
  implementationClass: "string",
};

/** bopf.ts's set_alternative_key_fields patch path. `keyElements` is refused, not write-once-worded (see `KEY_ELEMENTS_REFUSED_MESSAGE`); no `class`/`implementationClass` — an alternative key has no implementation class. No `name` (see `RECOGNISED_BUT_REFUSED_FIELDS`). */
const SET_ALTERNATIVE_KEY_FIELDS: SpecFieldTableInternal = {
  xmlName: "stringOrNull",
  uniqueness: { kind: "enumOrNull", values: BOPF_ENUM_FIELDS.uniqueness },
  checkAfterModify: "booleanOrNull",
  checkBeforeSave: "booleanOrNull",
  noCheck: "booleanOrNull",
  objectModelGenerated: "booleanOrNull",
  dataTypeRef: "refOrNull",
  dataTableTypeRef: "refOrNull",
};

/** The six `set_*_fields` operations' whitelists, keyed by operation name — exported so `bopf.ts` can drive attribute-vs-ref-child dispatch off this single source of truth instead of a second, independently-maintained list. */
export const SET_CHILD_FIELD_TABLES: Readonly<Record<string, SpecFieldTable>> = {
  set_association_fields: SET_ASSOCIATION_FIELDS,
  set_action_fields: SET_ACTION_FIELDS,
  set_determination_fields: SET_DETERMINATION_FIELDS,
  set_validation_fields: SET_VALIDATION_FIELDS,
  set_query_fields: SET_QUERY_FIELDS,
  set_alternative_key_fields: SET_ALTERNATIVE_KEY_FIELDS,
};

const OPERATION_FIELDS: Readonly<Record<string, SpecFieldTableInternal>> = {
  create_bo: NO_SPEC_FIELDS,
  add_node: ADD_NODE_FIELDS,
  remove_node: NO_SPEC_FIELDS,
  add_association: ADD_ASSOCIATION_FIELDS,
  remove_association: NO_SPEC_FIELDS,
  add_action: ADD_ACTION_FIELDS,
  remove_action: NO_SPEC_FIELDS,
  add_determination: ADD_DETERMINATION_FIELDS,
  remove_determination: NO_SPEC_FIELDS,
  add_validation: ADD_VALIDATION_FIELDS,
  remove_validation: NO_SPEC_FIELDS,
  add_query: ADD_QUERY_FIELDS,
  remove_query: NO_SPEC_FIELDS,
  add_alternative_key: ADD_ALTERNATIVE_KEY_FIELDS,
  remove_alternative_key: NO_SPEC_FIELDS,
  set_node_flags: SET_NODE_FLAGS_FIELDS,
  remove_dependent_object: NO_SPEC_FIELDS,
  ...SET_CHILD_FIELD_TABLES,
  activate: NO_SPEC_FIELDS,
};

/**
 * `buildTriggerFragments` (bopf.ts). `action` is validation-only on the wire
 * (`bo:ValidationTrigger` has `bo:action`, `bo:DeterminationTrigger` doesn't)
 * and `buildTriggerFragments` already refuses it on a determination with its
 * own BAD_INPUT — listed here as accepted so THIS module doesn't also reject
 * it as an unknown key and produce a second, redundant error.
 */
const DETERMINATION_TRIGGER_FIELDS: FieldTable = {
  node: "string",
  association: "string",
  actionNode: "string",
  action: "string",
  create: "boolean",
  update: "boolean",
  delete: "boolean",
  load: "boolean",
  determine: "boolean",
};

/** `buildTriggerFragments` (bopf.ts), validation branch: no `load`/`determine` — those are determination-only. */
const VALIDATION_TRIGGER_FIELDS: FieldTable = {
  node: "string",
  association: "string",
  actionNode: "string",
  action: "string",
  create: "boolean",
  update: "boolean",
  delete: "boolean",
  check: "boolean",
};

/** `buildRelationFragments` (bopf.ts). */
const RELATION_FIELDS: SpecFieldTableInternal = {
  node: "string",
  determination: "string",
  relationType: { kind: "enum", values: BOPF_ENUM_FIELDS.relationType },
};

/** remove_* / add_* pair for each `set_*_fields` operation's rename-refusal message below. */
const REMOVE_ADD_FOR_SET_OP: Readonly<Record<string, readonly [remove: string, add: string]>> = {
  set_association_fields: ["remove_association", "add_association"],
  set_action_fields: ["remove_action", "add_action"],
  set_determination_fields: ["remove_determination", "add_determination"],
  set_validation_fields: ["remove_validation", "add_validation"],
  set_query_fields: ["remove_query", "add_query"],
  set_alternative_key_fields: ["remove_alternative_key", "add_alternative_key"],
};

/** A determination/validation trigger and a relation reference their target by name as an embedded XPath fragment, so an in-place rename would silently orphan them. */
function nameRenameRefusedMessage(operation: string): string {
  const pair = REMOVE_ADD_FOR_SET_OP[operation];
  const removeOp = pair ? pair[0] : "remove_*";
  const addOp = pair ? pair[1] : "add_*";
  return (
    `spec.name on ${operation} is not supported: renaming is refused because a determination/validation ` +
    `trigger and a relation reference the element by name as an embedded XPath fragment, and a rename would ` +
    `silently orphan them. To rename, call ${removeOp} then ${addOp} again under the new name.`
  );
}

/** `triggers`/`relations` are write-once: BOPF reads a determination's triggers/relations only inside the original add_determination call. */
const DETERMINATION_WRITE_ONCE_MESSAGES: Readonly<Record<string, string>> = {
  triggers:
    `spec.triggers on set_determination_fields is write-once: BOPF reads a determination's triggers only ` +
    `inside the original add_determination call, never on a later set_determination_fields. To change a ` +
    `trigger, call remove_determination then add_determination again with the full definition, including ` +
    `the corrected triggers.`,
  relations:
    `spec.relations on set_determination_fields is write-once: BOPF reads a determination's relations only ` +
    `inside the original add_determination call, never on a later set_determination_fields. To change a ` +
    `relation, call remove_determination then add_determination again with the full definition, including ` +
    `the corrected relations.`,
};

/** `triggers` is write-once: BOPF reads a validation's triggers only inside the original add_validation call. */
const VALIDATION_WRITE_ONCE_MESSAGES: Readonly<Record<string, string>> = {
  triggers:
    `spec.triggers on set_validation_fields is write-once: BOPF reads a validation's triggers only inside ` +
    `the original add_validation call, never on a later set_validation_fields. To change a trigger, call ` +
    `remove_validation then add_validation again with the full definition, including the corrected triggers.`,
};

/** `keyElements` can't be patched in place — an alternative key's elements are fixed at creation. */
const KEY_ELEMENTS_REFUSED_MESSAGE =
  `spec.keyElements on set_alternative_key_fields cannot be changed in place: an alternative key's key ` +
  `elements are fixed when the key is created. To change them, call remove_alternative_key then ` +
  `add_alternative_key again with the full corrected key.`;

/** Per-operation keys recognised but always refused, with a message explaining why and how to do it instead — checked in `validateTopLevelFields` before the unknown-key branch. */
const RECOGNISED_BUT_REFUSED_FIELDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  set_association_fields: { name: nameRenameRefusedMessage("set_association_fields") },
  set_action_fields: { name: nameRenameRefusedMessage("set_action_fields") },
  set_determination_fields: {
    ...DETERMINATION_WRITE_ONCE_MESSAGES,
    name: nameRenameRefusedMessage("set_determination_fields"),
  },
  set_validation_fields: {
    ...VALIDATION_WRITE_ONCE_MESSAGES,
    name: nameRenameRefusedMessage("set_validation_fields"),
  },
  set_query_fields: { name: nameRenameRefusedMessage("set_query_fields") },
  set_alternative_key_fields: {
    keyElements: KEY_ELEMENTS_REFUSED_MESSAGE,
    name: nameRenameRefusedMessage("set_alternative_key_fields"),
  },
};

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

/**
 * The exact case the issue names: `ref(v)` needs `{ name, type }`, and a
 * bare string (`spec.implementationClassRef: "ZCL_MY_DET"`) or an object
 * missing one of the two required members is silently dropped by it. The
 * message shows the concrete fix, not just the failure.
 */
function refShapeIssue(path: string, value: unknown): Issue | undefined {
  if (typeof value === "string") {
    return {
      message:
        `${path} = ${JSON.stringify(value)} is a bare string, not an object ref. It must be ` +
        `{ "name": "...", "type": "..." } — most likely { "name": ${JSON.stringify(value)}, "type": "..." }.`,
      detail: { path, value },
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      message: `${path} must be an object ref { "name": "...", "type": "..." }, got ${describeType(value)}.`,
      detail: { path, value },
    };
  }
  const o = value as Record<string, unknown>;
  const nameOk = typeof o.name === "string" && o.name.trim() !== "";
  const typeOk = typeof o.type === "string" && o.type.trim() !== "";
  if (nameOk && typeOk) return undefined;
  const missing = [nameOk ? undefined : "name", typeOk ? undefined : "type"].filter(
    (x): x is string => x !== undefined,
  );
  return {
    message:
      `${path} is missing required field(s) ${missing.join(" and ")} — got ${safeJson(value)}. Required shape: ` +
      `{ "name": "...", "type": "..." }.`,
    detail: { path, value, missing },
  };
}

/**
 * Enum mismatch: reports every accepted value with its meaning so a wrong
 * guess doesn't need a second round trip to the docs. A single-issue call
 * this message IS the whole `BAD_INPUT` message (see `validateSpecKeys`).
 */
function enumShapeIssue(path: string, spec: EnumShape, value: unknown): Issue | undefined {
  if (spec.kind === "enumOrNull" && value === null) return undefined;
  if (typeof value !== "string") {
    const kindText = spec.kind === "enumOrNull" ? "a string or null" : "a string";
    return { message: `${path} must be ${kindText}, got ${describeType(value)}.`, detail: { path, value } };
  }
  if (spec.values.some((v) => v.value === value)) return undefined;
  return {
    message: `${path} "${value}" is not one of ${spec.values.map((v) => `"${v.value}" (${v.meaning})`).join(", ")}.`,
    detail: { path, value, allowed: spec.values.map((v) => v.value) },
  };
}

function shapeIssue(path: string, spec: SpecFieldSpec, value: unknown): Issue | undefined {
  if (typeof spec !== "string") return enumShapeIssue(path, spec, value);
  const shape = spec;
  switch (shape) {
    case "string":
      return typeof value === "string"
        ? undefined
        : { message: `${path} must be a string, got ${describeType(value)}.`, detail: { path, value } };
    case "boolean":
      return typeof value === "boolean"
        ? undefined
        : { message: `${path} must be a boolean, got ${describeType(value)}.`, detail: { path, value } };
    case "booleanOrNull":
      return value === null || typeof value === "boolean"
        ? undefined
        : { message: `${path} must be a boolean or null, got ${describeType(value)}.`, detail: { path, value } };
    case "stringOrNull":
      return value === null || typeof value === "string"
        ? undefined
        : { message: `${path} must be a string or null, got ${describeType(value)}.`, detail: { path, value } };
    case "ref":
      return refShapeIssue(path, value);
    case "refOrNull":
      return value === null ? undefined : refShapeIssue(path, value);
    case "stringArray": {
      if (!Array.isArray(value)) {
        return { message: `${path} must be an array of strings, got ${describeType(value)}.`, detail: { path, value } };
      }
      if (value.length === 0) {
        return { message: `${path} must be a non-empty array of strings.`, detail: { path, value } };
      }
      const badIndex = value.findIndex((x) => typeof x !== "string");
      if (badIndex !== -1) {
        return {
          message: `${path}[${badIndex}] must be a string, got ${describeType(value[badIndex])}.`,
          detail: { path, index: badIndex, value: value[badIndex] },
        };
      }
      return undefined;
    }
    case "objectArray":
      return Array.isArray(value)
        ? undefined
        : { message: `${path} must be an array, got ${describeType(value)}.`, detail: { path, value } };
  }
}

/**
 * Deterministic near-miss rule, not a fuzzy edit-distance engine: a
 * case-insensitive exact match (typo'd casing), or the unknown key being a
 * case-insensitive prefix of exactly one accepted key (or vice versa) —
 * covers `create`/`update`/`delete` -> `createEnabled`/`updateEnabled`/
 * `deleteEnabled`, the live-reported case. Declines to guess when more than
 * one accepted key matches, rather than pick arbitrarily.
 */
function suggestKey(unknownKey: string, accepted: readonly string[]): string | undefined {
  const lower = unknownKey.toLowerCase();
  const exact = accepted.filter((k) => k.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const related = accepted.filter((k) => {
    const kl = k.toLowerCase();
    return kl.startsWith(lower) || lower.startsWith(kl);
  });
  return related.length === 1 ? related[0] : undefined;
}

function unknownTopLevelIssue(operation: string, key: string, accepted: readonly string[]): Issue {
  if (operation === "create_bo" && TOP_LEVEL_CREATE_BO_ARGS.has(key)) {
    return {
      message:
        `spec.${key} is not read by create_bo — "${key}" is a top-level abap_bopf_edit argument, not a spec ` +
        `field. Pass it as { "operation": "create_bo", "${key}": ... } directly, not inside spec.`,
      detail: { operation, key, topLevelArgument: true },
    };
  }
  const suggestion = suggestKey(key, accepted);
  const acceptedText = accepted.length ? accepted.join(", ") : "none — this operation accepts no spec fields at all";
  return {
    message:
      `spec.${key} is not a recognised field for operation "${operation}". Accepted spec field(s): ${acceptedText}.` +
      (suggestion ? ` Did you mean "${suggestion}"?` : ""),
    detail: { operation, key, accepted, ...(suggestion ? { suggestion } : {}) },
  };
}

function validateTopLevelFields(operation: string, spec: Record<string, unknown>): Issue[] {
  const table = OPERATION_FIELDS[operation] ?? NO_SPEC_FIELDS;
  const accepted = Object.keys(table);
  const refused = RECOGNISED_BUT_REFUSED_FIELDS[operation];
  const issues: Issue[] = [];
  for (const key of Object.keys(spec)) {
    const refusedMessage = refused?.[key];
    if (refusedMessage !== undefined) {
      issues.push({ message: refusedMessage, detail: { operation, key, refused: true } });
      continue;
    }
    const shape = table[key];
    if (shape === undefined) {
      issues.push(unknownTopLevelIssue(operation, key, accepted));
      continue;
    }
    const problem = shapeIssue(`spec.${key}`, shape, spec[key]);
    if (problem) issues.push(problem);
  }
  return issues;
}

/**
 * Non-object entries (`null`, a string, ...) are left alone here —
 * `buildTriggerFragments`/`buildRelationFragments` already refuse those
 * outright with their own BAD_INPUT naming the index; duplicating that
 * check would just produce two errors for one problem.
 */
function validateArrayEntries(
  pathBase: string,
  entryLabel: string,
  entries: readonly unknown[],
  table: SpecFieldTableInternal,
): Issue[] {
  const accepted = Object.keys(table);
  const issues: Issue[] = [];
  entries.forEach((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const obj = entry as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const path = `${pathBase}[${i}].${key}`;
      const shape = table[key];
      if (shape === undefined) {
        issues.push({
          message: `${path} is not a recognised field on a ${entryLabel} entry. Accepted field(s): ${accepted.join(", ")}.`,
          detail: { path, key, index: i, accepted },
        });
        continue;
      }
      const problem = shapeIssue(path, shape, obj[key]);
      if (problem) issues.push(problem);
    }
  });
  return issues;
}

/**
 * Validates `spec`'s keys and value shapes for one `abap_bopf_edit`
 * operation, against exactly what `src/tools/bopf.ts`'s builders read.
 * Zero network — safe to call before any lock/preflight. Throws
 * `AbapError("BAD_INPUT", ...)` naming every problem found (not just the
 * first) so a caller who misspelled two fields doesn't need two round
 * trips; returns normally when spec is clean.
 */
export function validateSpecKeys(operation: string, spec: Record<string, unknown>): void {
  const issues = validateTopLevelFields(operation, spec);

  if (operation === "add_determination" || operation === "add_validation") {
    const triggerTable = operation === "add_determination" ? DETERMINATION_TRIGGER_FIELDS : VALIDATION_TRIGGER_FIELDS;
    if (Array.isArray(spec.triggers)) {
      issues.push(...validateArrayEntries("spec.triggers", "trigger", spec.triggers, triggerTable));
    }
  }
  if (operation === "add_determination" && Array.isArray(spec.relations)) {
    issues.push(...validateArrayEntries("spec.relations", "relation", spec.relations, RELATION_FIELDS));
  }

  if (issues.length === 0) return;

  const message =
    issues.length === 1
      ? issues[0]!.message
      : `${issues.length} problems found in spec for operation "${operation}": ` +
        issues.map((iss, i) => `(${i + 1}) ${iss.message}`).join(" ");

  const suggested = issues.find((iss) => typeof iss.detail.suggestion === "string");
  const hint = suggested ? `Rename the field to "${suggested.detail.suggestion as string}" and retry.` : undefined;

  throw new AbapError("BAD_INPUT", message, { operation, issues: issues.map((iss) => iss.detail) }, hint);
}
