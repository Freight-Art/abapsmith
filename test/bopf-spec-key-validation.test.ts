/**
 * `src/tools/bopf-spec-keys.ts` — pure unit tests, no server/connection: the
 * validator is zero-network by design, so it's exercised directly against
 * plain `spec` objects.
 *
 * Two silent-discard defects were found in `abap_bopf_edit`: an
 * unknown/misspelled `spec` key is never read and never rejected (e.g.
 * `spec.create` on `add_node`, meant `createEnabled`), and a known key given
 * the wrong JS shape is silently dropped by `str()`/`bool()`/`ref()` (e.g.
 * `spec.implementationClassRef: "ZCL_X"`, a bare string where `ref()` needs
 * `{ name, type }`). These tests cover both classes across every operation.
 */
import { describe, expect, it } from "vitest";
import { isAbapError } from "../src/adt/errors.js";
import { validateSpecKeys } from "../src/tools/bopf-spec-keys.js";

function expectBadInput(fn: () => unknown): unknown {
  let threw: unknown;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  expect(threw).toBeDefined();
  expect(isAbapError(threw)).toBe(true);
  if (isAbapError(threw)) expect(threw.code).toBe("BAD_INPUT");
  return threw;
}

function expectOk(operation: string, spec: Record<string, unknown>): void {
  expect(() => validateSpecKeys(operation, spec)).not.toThrow();
}

describe("unknown key: the live-reported add_node case", () => {
  it('rejects spec.create/update/delete on add_node, naming createEnabled/updateEnabled/deleteEnabled', () => {
    for (const [bad, right] of [
      ["create", "createEnabled"],
      ["update", "updateEnabled"],
      ["delete", "deleteEnabled"],
    ] as const) {
      const e = expectBadInput(() => validateSpecKeys("add_node", { [bad]: true }));
      const message = (e as Error).message;
      expect(message).toContain(`spec.${bad}`);
      expect(message).toContain(right);
    }
  });

  it("case-insensitive exact match is also suggested", () => {
    const e = expectBadInput(() => validateSpecKeys("add_node", { XmlName: "FOO" }));
    expect((e as Error).message).toContain("xmlName");
  });

  it("an unknown key with no unique near-miss lists the accepted keys but makes no guess", () => {
    const e = expectBadInput(() => validateSpecKeys("add_node", { bogusFieldNoRelation: true }));
    const message = (e as Error).message;
    expect(message).toContain("spec.bogusFieldNoRelation");
    expect(message).not.toContain("Did you mean");
  });
});

describe("wrong shape: object refs given a bare string", () => {
  it("add_determination: implementationClassRef given a bare string is refused, naming the required {name,type} shape", () => {
    const e = expectBadInput(() =>
      validateSpecKeys("add_determination", { implementationClassRef: "ZCL_X" }),
    );
    const message = (e as Error).message;
    expect(message).toContain("spec.implementationClassRef");
    expect(message).toContain('"name"');
    expect(message).toContain('"type"');
    expect(message).toContain("ZCL_X");
  });

  it("add_node: persistentStructureRef given a bare string is refused", () => {
    const e = expectBadInput(() => validateSpecKeys("add_node", { persistentStructureRef: "ZTMD_S_ROOT" }));
    const message = (e as Error).message;
    expect(message).toContain("spec.persistentStructureRef");
    expect(message).toContain('"name"');
    expect(message).toContain('"type"');
  });

  it("a ref object missing type is refused naming what's missing", () => {
    const e = expectBadInput(() => validateSpecKeys("add_node", { persistentStructureRef: { name: "ZTMD_S_ROOT" } }));
    expect((e as Error).message).toContain("missing required field(s) type");
  });

  it("a boolean field given a string is refused", () => {
    const e = expectBadInput(() => validateSpecKeys("add_node", { createEnabled: "true" }));
    expect((e as Error).message).toMatch(/spec\.createEnabled must be a boolean, got string/);
  });
});

describe("add_determination.implementationClassRef / class acceptance", () => {
  it("accepts a full {name,type} ref", () => {
    expectOk("add_determination", { implementationClassRef: { name: "ZCL_X", type: "CLAS/OC" } });
  });

  it("accepts the bare class-name fallback", () => {
    expectOk("add_determination", { class: "ZCL_X" });
  });
});

describe("operations that accept no spec keys at all", () => {
  const zeroSpecOps = [
    "create_bo",
    "activate",
    "remove_node",
    "remove_association",
    "remove_action",
    "remove_determination",
    "remove_validation",
    "remove_query",
    "remove_alternative_key",
  ];

  it("reject any spec key", () => {
    for (const op of zeroSpecOps) {
      const e = expectBadInput(() => validateSpecKeys(op, { anything: 1 }));
      expect((e as Error).message).toContain("spec.anything");
    }
  });

  it("accept an empty spec", () => {
    for (const op of zeroSpecOps) {
      expectOk(op, {});
    }
  });

  it("remove_determination rejects any spec key specifically", () => {
    expectBadInput(() => validateSpecKeys("remove_determination", { name: "X" }));
  });
});

describe("create_bo: package/description/rootNodeName are top-level arguments, not spec fields", () => {
  it('spec: {package: "$TMP"} is refused, and the message says where package actually goes', () => {
    const e = expectBadInput(() => validateSpecKeys("create_bo", { package: "$TMP" }));
    const message = (e as Error).message;
    expect(message).toContain("spec.package");
    expect(message).toContain("top-level");
    expect(message).toContain("create_bo");
  });

  it("same for description and rootNodeName", () => {
    expectBadInput(() => validateSpecKeys("create_bo", { description: "hi" }));
    expectBadInput(() => validateSpecKeys("create_bo", { rootNodeName: "ROOT" }));
  });
});

describe("set_node_flags: nullable flags/refs, non-nullable name", () => {
  it("accepts null for a boolean flag", () => {
    expectOk("set_node_flags", { createEnabled: null });
  });

  it("accepts null for a ref key", () => {
    expectOk("set_node_flags", { persistentStructureRef: null });
  });

  it("accepts name as a string", () => {
    expectOk("set_node_flags", { name: "NEWNAME" });
  });

  it("rejects null for name — name is not nullable", () => {
    expectBadInput(() => validateSpecKeys("set_node_flags", { name: null }));
  });

  it("still rejects a bare string ref even though null would have been fine", () => {
    const e = expectBadInput(() => validateSpecKeys("set_node_flags", { persistentStructureRef: "ZTMD_S_ROOT" }));
    expect((e as Error).message).toContain('"name"');
  });

  it("rejects an unknown key", () => {
    expectBadInput(() => validateSpecKeys("set_node_flags", { create: true }));
  });
});

describe("triggers and relations: nested unknown-key and wrong-shape checks", () => {
  it("a trigger entry with an unknown key is refused naming the index", () => {
    const e = expectBadInput(() =>
      validateSpecKeys("add_determination", { triggers: [{ node: "ROOT" }, { bogusTriggerField: true }] }),
    );
    expect((e as Error).message).toContain("spec.triggers[1].bogusTriggerField");
  });

  it("a relation entry with an unknown key is refused naming the index", () => {
    const e = expectBadInput(() =>
      validateSpecKeys("add_determination", { relations: [{ node: "ROOT", bogusRelationField: true }] }),
    );
    expect((e as Error).message).toContain("spec.relations[0].bogusRelationField");
  });

  it("a trigger entry with the wrong shape for a known field is refused", () => {
    const e = expectBadInput(() =>
      validateSpecKeys("add_determination", { triggers: [{ node: "ROOT", create: "yes" }] }),
    );
    expect((e as Error).message).toContain("spec.triggers[0].create");
  });

  it("determination triggers tolerate \"action\" as a key (buildTriggerFragments itself refuses it) rather than flagging it unknown", () => {
    expectOk("add_determination", { triggers: [{ action: "DO_SOMETHING" }] });
  });

  it("validation triggers accept action, check, load/determine are NOT accepted on validation triggers", () => {
    expectOk("add_validation", { triggers: [{ action: "DO_SOMETHING", check: true }] });
    const e = expectBadInput(() => validateSpecKeys("add_validation", { triggers: [{ load: true }] }));
    expect((e as Error).message).toContain("spec.triggers[0].load");
  });

  it("relations are only accepted on add_determination, not add_validation", () => {
    const e = expectBadInput(() =>
      validateSpecKeys("add_validation", { relations: [{ node: "ROOT" }] }),
    );
    expect((e as Error).message).toContain("spec.relations");
  });

  it("a non-object trigger/relation entry is left alone here (buildTriggerFragments/buildRelationFragments refuse it with their own message)", () => {
    expectOk("add_determination", { triggers: [null] });
    expectOk("add_determination", { relations: ["not-an-object"] });
  });
});

describe("set_*_fields: recognised-but-refused keys", () => {
  it("set_determination_fields.triggers is refused as write-once, naming remove_determination/add_determination", () => {
    const e = expectBadInput(() => validateSpecKeys("set_determination_fields", { triggers: [{ node: "ROOT" }] }));
    const message = (e as Error).message;
    expect(message).toContain("spec.triggers");
    expect(message).toContain("write-once");
    expect(message).toContain("remove_determination");
    expect(message).toContain("add_determination");
  });

  it("set_determination_fields.relations is refused as write-once, naming remove_determination/add_determination", () => {
    const e = expectBadInput(() =>
      validateSpecKeys("set_determination_fields", { relations: [{ node: "ROOT" }] }),
    );
    const message = (e as Error).message;
    expect(message).toContain("spec.relations");
    expect(message).toContain("write-once");
    expect(message).toContain("remove_determination");
    expect(message).toContain("add_determination");
  });

  it("set_validation_fields.triggers is refused as write-once, naming remove_validation/add_validation", () => {
    const e = expectBadInput(() => validateSpecKeys("set_validation_fields", { triggers: [{ node: "ROOT" }] }));
    const message = (e as Error).message;
    expect(message).toContain("spec.triggers");
    expect(message).toContain("write-once");
    expect(message).toContain("remove_validation");
    expect(message).toContain("add_validation");
  });

  it("set_alternative_key_fields.keyElements is refused (not write-once wording), naming remove_alternative_key/add_alternative_key", () => {
    const e = expectBadInput(() =>
      validateSpecKeys("set_alternative_key_fields", { keyElements: ["FIELD1"] }),
    );
    const message = (e as Error).message;
    expect(message).toContain("spec.keyElements");
    expect(message).not.toContain("write-once");
    expect(message).toContain("cannot be changed in place");
    expect(message).toContain("remove_alternative_key");
    expect(message).toContain("add_alternative_key");
  });

  it("name is refused on every set_*_fields operation, naming the matching remove_*/add_* pair", () => {
    const removeAddByOp: Record<string, [string, string]> = {
      set_association_fields: ["remove_association", "add_association"],
      set_action_fields: ["remove_action", "add_action"],
      set_determination_fields: ["remove_determination", "add_determination"],
      set_validation_fields: ["remove_validation", "add_validation"],
      set_query_fields: ["remove_query", "add_query"],
      set_alternative_key_fields: ["remove_alternative_key", "add_alternative_key"],
    };
    for (const [op, [removeOp, addOp]] of Object.entries(removeAddByOp)) {
      const e = expectBadInput(() => validateSpecKeys(op, { name: "RENAMED" }));
      const message = (e as Error).message;
      expect(message).toContain("spec.name");
      expect(message).toContain("not supported");
      expect(message).toContain(removeOp);
      expect(message).toContain(addOp);
    }
  });

  it("a bare-string ref is still refused on a set_*_fields operation", () => {
    const e = expectBadInput(() =>
      validateSpecKeys("set_association_fields", { implementationClassRef: "ZCL_X" }),
    );
    const message = (e as Error).message;
    expect(message).toContain("spec.implementationClassRef");
    expect(message).toContain('"name"');
    expect(message).toContain('"type"');
  });

  it("a wrong-typed value is still refused on a set_*_fields operation", () => {
    const e = expectBadInput(() => validateSpecKeys("set_action_fields", { exportParameterLink: "true" }));
    expect((e as Error).message).toMatch(/spec\.exportParameterLink must be a boolean or null, got string/);
  });

  it("a genuinely unknown key is still reported as unrecognised, not swallowed by the refused-field check", () => {
    const e = expectBadInput(() => validateSpecKeys("set_query_fields", { bogusFieldNoRelation: true }));
    const message = (e as Error).message;
    expect(message).toContain("spec.bogusFieldNoRelation");
    expect(message).toContain("not a recognised field");
  });
});

describe("fully-populated valid specs for every operation that takes one", () => {
  it("add_node", () => {
    expectOk("add_node", {
      xmlName: "ZROOT",
      doEmbeddingName: "ROOT_EMB",
      rootNode: true,
      textNode: false,
      isDependentObjectNode: false,
      createEnabled: true,
      updateEnabled: true,
      deleteEnabled: true,
      authorizationCheck: false,
      isExtensible: false,
      objectModelGenerated: false,
      objectModelObsolete: false,
      persistentStructureRef: { name: "ZTMD_S_ROOT", type: "TABL/DS" },
      transientStructureRef: { name: "ZTMD_S_ROOT_T", type: "TABL/DS" },
      combinedStructureRef: { name: "ZTMD_S_ROOT_C", type: "TABL/DS" },
      combinedTableRef: { name: "ZTMD_T_ROOT_C", type: "TTYP/DA" },
      persistentTableRef: { name: "ZTMD_ROOT", type: "TABL/DT" },
      defaultingClassRef: { name: "ZCL_DEFAULT", type: "CLAS/OC" },
      dataAccessClassRef: { name: "ZCL_DAC", type: "CLAS/OC" },
      authorizationClassRef: { name: "ZCL_AUTH", type: "CLAS/OC" },
      parent: "ROOT",
      parentNodeId: "0001",
    });
  });

  it("add_association", () => {
    expectOk("add_association", {
      xmlName: "TO_ITEM",
      multiplicity: "0_N",
      implementationType: "Association",
      objectModelGenerated: false,
      doEmbeddingName: "ITEM_EMB",
      targetNodeRef: { name: "ITEM", type: "BOBF/BON" },
      implementationClassRef: { name: "ZCL_ASSOC", type: "CLAS/OC" },
      parameterStructureRef: { name: "ZTMD_S_PARAM", type: "TABL/DS" },
    });
  });

  it("add_action", () => {
    expectOk("add_action", {
      xmlName: "DO_IT",
      category: "01",
      instanceMultiplicity: "2",
      exportingParameterCategoryType: "Type",
      exportParameterLink: false,
      isExtensible: false,
      objectModelGenerated: false,
      implementationClassRef: { name: "ZCL_ACTION", type: "CLAS/OC" },
      parameterStructureRef: { name: "ZTMD_S_PARAM", type: "TABL/DS" },
    });
  });

  it("add_determination", () => {
    expectOk("add_determination", {
      xmlName: "MY_DET",
      category: "reactDuringSave",
      objectModelGenerated: false,
      implementationClassRef: { name: "ZCL_DET", type: "CLAS/OC" },
      triggers: [{ node: "ROOT", association: "TO_ITEM", create: true, update: true, delete: false, load: true, determine: true }],
      relations: [{ node: "ROOT", determination: "OTHER_DET", relationType: "predecessor" }],
    });
  });

  it("add_validation", () => {
    expectOk("add_validation", {
      xmlName: "MY_VAL",
      category: "consistencyCheck",
      checkBeforeSave: true,
      createNode: true,
      updateNode: true,
      deleteNode: false,
      objectModelGenerated: false,
      implementationClassRef: { name: "ZCL_VAL", type: "CLAS/OC" },
      triggers: [{ node: "ROOT", check: true, action: "DO_IT", actionNode: "ROOT" }],
    });
  });

  it("add_query", () => {
    expectOk("add_query", {
      xmlName: "SEL_ALL",
      category: "selectAll",
      objectModelGenerated: false,
      dataTypeRef: { name: "ZTMD_S_QUERY", type: "TABL/DS" },
      implementationClassRef: { name: "ZCL_QUERY", type: "CLAS/OC" },
    });
  });

  it("add_alternative_key", () => {
    expectOk("add_alternative_key", {
      xmlName: "ALT_KEY",
      uniqueness: "unique",
      checkAfterModify: true,
      checkBeforeSave: false,
      noCheck: false,
      objectModelGenerated: false,
      dataTypeRef: { name: "ZSORDER_ID", type: "TABL/DS" },
      dataTableTypeRef: { name: "ZTORDER_ID", type: "TTYP/DA" },
      keyElements: ["FIELD1", "FIELD2"],
    });
  });

  it("set_node_flags", () => {
    expectOk("set_node_flags", {
      name: "RENAMED",
      rootNode: true,
      textNode: false,
      isDependentObjectNode: null,
      createEnabled: true,
      updateEnabled: null,
      deleteEnabled: false,
      authorizationCheck: true,
      isExtensible: false,
      objectModelGenerated: false,
      objectModelObsolete: null,
      persistentStructureRef: { name: "ZTMD_S_ROOT", type: "TABL/DS" },
      transientStructureRef: null,
      combinedStructureRef: null,
      combinedTableRef: null,
      persistentTableRef: null,
      defaultingClassRef: null,
      dataAccessClassRef: null,
      authorizationClassRef: null,
    });
  });

  it("set_association_fields", () => {
    expectOk("set_association_fields", {
      xmlName: "TO_ITEM_V2",
      multiplicity: "0_N",
      implementationType: "Association",
      doEmbeddingName: "ITEM_EMB",
      objectModelGenerated: false,
      targetNodeRef: { name: "ITEM", type: "BOBF/BON" },
      parameterStructureRef: { name: "ZTMD_S_PARAM", type: "TABL/DS" },
      implementationClassRef: { name: "ZCL_ASSOC", type: "CLAS/OC" },
    });
  });

  it("set_action_fields", () => {
    expectOk("set_action_fields", {
      xmlName: "DO_IT_V2",
      category: "01",
      instanceMultiplicity: "1",
      exportingParameterCategoryType: "Type",
      exportParameterLink: false,
      isExtensible: false,
      objectModelGenerated: false,
      parameterStructureRef: { name: "ZTMD_S_PARAM", type: "TABL/DS" },
      implementationClassRef: { name: "ZCL_ACTION", type: "CLAS/OC" },
    });
  });

  it("set_determination_fields", () => {
    expectOk("set_determination_fields", {
      xmlName: "MY_DET_V2",
      category: "reactDuringSave",
      objectModelGenerated: false,
      implementationClassRef: { name: "ZCL_DET", type: "CLAS/OC" },
    });
  });

  it("set_validation_fields", () => {
    expectOk("set_validation_fields", {
      xmlName: "MY_VAL_V2",
      category: "consistencyCheck",
      checkBeforeSave: true,
      createNode: true,
      updateNode: true,
      deleteNode: false,
      objectModelGenerated: false,
      implementationClassRef: { name: "ZCL_VAL", type: "CLAS/OC" },
    });
  });

  it("set_query_fields", () => {
    expectOk("set_query_fields", {
      xmlName: "SEL_ALL_V2",
      category: "selectAll",
      objectModelGenerated: false,
      dataTypeRef: { name: "ZTMD_S_QUERY", type: "TABL/DS" },
      implementationClassRef: { name: "ZCL_QUERY", type: "CLAS/OC" },
    });
  });

  it("set_alternative_key_fields", () => {
    expectOk("set_alternative_key_fields", {
      xmlName: "ALT_KEY_V2",
      uniqueness: "unique",
      checkAfterModify: true,
      checkBeforeSave: false,
      noCheck: false,
      objectModelGenerated: false,
      dataTypeRef: { name: "ZSORDER_ID", type: "TABL/DS" },
      dataTableTypeRef: { name: "ZTORDER_ID", type: "TTYP/DA" },
    });
  });

  it("set_*_fields: null clears any unsettable attribute or ref", () => {
    expectOk("set_association_fields", { xmlName: null, objectModelGenerated: null, targetNodeRef: null });
    expectOk("set_action_fields", { category: null, exportParameterLink: null, implementationClassRef: null });
    expectOk("set_determination_fields", { xmlName: null, implementationClassRef: null });
    expectOk("set_validation_fields", { checkBeforeSave: null, implementationClassRef: null });
    expectOk("set_query_fields", { xmlName: null, dataTypeRef: null });
    expectOk("set_alternative_key_fields", { uniqueness: null, dataTableTypeRef: null });
  });
});

describe("errors are always AbapError BAD_INPUT", () => {
  it.each([
    ["add_node", { create: true }],
    ["add_determination", { implementationClassRef: "ZCL_X" }],
    ["create_bo", { package: "$TMP" }],
    ["remove_action", { anything: 1 }],
    ["set_node_flags", { name: null }],
  ] as const)("%s / %o", (operation, spec) => {
    const e = expectBadInput(() => validateSpecKeys(operation, spec as Record<string, unknown>));
    expect((e as Error).name).toBe("AbapError");
  });
});

describe("enum-valued spec fields are checked against the model's value sets", () => {
  // Value/meaning pairs copied verbatim from the BOPF_ENUM_FIELDS tables (issue #153).
  const MULTIPLICITY = [
    ["0_1", "optional to-one: at most one target instance"],
    ["0_N", "optional to-many: any number of target instances"],
    ["1_1", "mandatory to-one: exactly one target instance"],
    ["1_N", "mandatory to-many: at least one target instance (schema-only, never observed on the wire)"],
  ] as const;
  const IMPLEMENTATION_TYPE = [
    ["Composition", "parent-child composition: the target node is a child of the source node"],
    ["DoComposition", "composition to a delegated (dependent) object"],
    ["Association", "cross-node or cross-BO association resolved by the association class"],
    ["C", "schema short form of Composition (not observed on the wire)"],
    ["A", "schema short form of Association (not observed on the wire)"],
  ] as const;
  const INSTANCE_MULTIPLICITY = [
    ["0", "static: runs without a node instance (SC_ACT_CARD_STATIC)"],
    ["1", "single instance: exactly one node instance per call (SC_ACT_CARD_ONE)"],
    ["2", "multiple instances: any number of node instances per call (SC_ACT_CARD_MANY; what SAP's own actions use)"],
  ] as const;
  const EXPORTING_PARAMETER_CATEGORY_TYPE = [
    ["None", "the action exports nothing"],
    ["Type", "the action exports data of the DDIC type named in parameterStructureRef"],
    ["Node", "the action exports instances of a node"],
  ] as const;
  const DETERMINATION_CATEGORY = [
    ["reactAfterModification", "runs after instances of the trigger node are created/updated/deleted"],
    ["calculateTransientAttributes", "fills transient attributes when instances are loaded or changed"],
    ["calculateTransientSubNodeInstances", "fills transient sub-node instances when the parent is loaded"],
    ["calculateProperties", "computes field/action/association properties (enabled, read-only, mandatory)"],
    ["reactOnCheckAndDetermine", "runs when the consumer calls check-and-determine"],
    ["reactBeforeSave", "runs at the start of the save sequence, before validations"],
    ["drawNumbersDuringCreate", "draws numbers for new instances at creation time"],
    ["drawNumbersDuringSave", "draws numbers for new instances during save"],
    ["reactDuringSave", "runs during the save sequence after validations"],
    ["reactAfterSuccessfulSave", "runs after the database commit succeeded"],
    ["reactAfterCleanupTransaction", "runs when the transaction is cleaned up (after commit or rollback)"],
    ["reactAfterFailedSave", "runs after the save failed"],
  ] as const;
  const VALIDATION_CATEGORY = [
    ["consistencyCheck", "checks the trigger node's instances and reports messages; runs on check-and-determine and during save"],
    ["actionCheck", "decides whether the trigger action may run on the given instances"],
  ] as const;
  const QUERY_CATEGORY = [
    ["selectAll", "returns every instance of the node"],
    ["selectByElements", "filters instances by node attributes passed as selection parameters (generated implementation)"],
    ["customQuery", "implemented by the query class"],
  ] as const;
  const UNIQUENESS = [
    ["unique", "key values must be unique across all instances"],
    ["uniqueIfNotInitial", "unique unless the key value is initial (what SAP's own keys use)"],
    ["notUnique", "no uniqueness enforced (a plain secondary access path)"],
  ] as const;
  const RELATION_TYPE = [
    ["predecessor", "the named determination runs before this one"],
    ["successor", "the named determination runs after this one"],
  ] as const;

  function expectEnumRejected(
    operation: string,
    spec: Record<string, unknown>,
    path: string,
    value: string,
    allowed: readonly (readonly [string, string])[],
  ): void {
    const e = expectBadInput(() => validateSpecKeys(operation, spec));
    const message = (e as Error).message;
    expect(message).toContain(`${path} "${value}" is not one of`);
    for (const [v, meaning] of allowed) {
      expect(message).toContain(`"${v}" (${meaning})`);
    }
    if (isAbapError(e)) {
      const issues = e.details.issues as ReadonlyArray<{ allowed: readonly string[] }>;
      expect(issues[0]!.allowed).toEqual(allowed.map(([v]) => v));
    }
  }

  it('add_association: spec.multiplicity "2_N" is rejected, listing the four allowed values', () => {
    expectEnumRejected("add_association", { multiplicity: "2_N" }, "spec.multiplicity", "2_N", MULTIPLICITY);
  });

  it('add_association: spec.implementationType "Comp" is rejected, listing the five allowed values', () => {
    expectEnumRejected(
      "add_association",
      { implementationType: "Comp" },
      "spec.implementationType",
      "Comp",
      IMPLEMENTATION_TYPE,
    );
  });

  it('add_action: spec.instanceMultiplicity "1_1" is rejected (the reported live case)', () => {
    expectEnumRejected(
      "add_action",
      { class: "ZCL_X", instanceMultiplicity: "1_1" },
      "spec.instanceMultiplicity",
      "1_1",
      INSTANCE_MULTIPLICITY,
    );
  });

  it('add_action: spec.exportingParameterCategoryType "none" is rejected (wrong case)', () => {
    expectEnumRejected(
      "add_action",
      { class: "ZCL_X", exportingParameterCategoryType: "none" },
      "spec.exportingParameterCategoryType",
      "none",
      EXPORTING_PARAMETER_CATEGORY_TYPE,
    );
  });

  it('add_determination: spec.category "afterModify" is rejected', () => {
    expectEnumRejected(
      "add_determination",
      { class: "ZCL_X", category: "afterModify" },
      "spec.category",
      "afterModify",
      DETERMINATION_CATEGORY,
    );
  });

  it('add_determination: spec.relations[0].relationType "before" is rejected', () => {
    expectEnumRejected(
      "add_determination",
      { class: "ZCL_X", relations: [{ node: "ROOT", determination: "OTHER_DET", relationType: "before" }] },
      "spec.relations[0].relationType",
      "before",
      RELATION_TYPE,
    );
  });

  it('add_validation: spec.category "check" is rejected', () => {
    expectEnumRejected("add_validation", { class: "ZCL_X", category: "check" }, "spec.category", "check", VALIDATION_CATEGORY);
  });

  it('add_query: spec.category "selectByKey" is rejected', () => {
    expectEnumRejected("add_query", { class: "ZCL_X", category: "selectByKey" }, "spec.category", "selectByKey", QUERY_CATEGORY);
  });

  it('add_alternative_key: spec.uniqueness "uniq" is rejected', () => {
    expectEnumRejected("add_alternative_key", { uniqueness: "uniq" }, "spec.uniqueness", "uniq", UNIQUENESS);
  });

  it('set_action_fields: spec.instanceMultiplicity "1_1" is rejected', () => {
    expectEnumRejected(
      "set_action_fields",
      { instanceMultiplicity: "1_1" },
      "spec.instanceMultiplicity",
      "1_1",
      INSTANCE_MULTIPLICITY,
    );
  });

  it('set_association_fields: spec.multiplicity "9" is rejected', () => {
    expectEnumRejected("set_association_fields", { multiplicity: "9" }, "spec.multiplicity", "9", MULTIPLICITY);
  });

  it('set_determination_fields: spec.category "undefined" is rejected — the allowed list omits it', () => {
    expectEnumRejected(
      "set_determination_fields",
      { category: "undefined" },
      "spec.category",
      "undefined",
      DETERMINATION_CATEGORY,
    );
  });

  it("valid enum values pass", () => {
    expectOk("add_action", { class: "ZCL_X", instanceMultiplicity: "2", exportingParameterCategoryType: "None" });
  });

  it("set_action_fields.instanceMultiplicity accepts null (clears the field)", () => {
    expectOk("set_action_fields", { instanceMultiplicity: null });
  });

  it("a non-string value for an enum field gets the type message, not the enum message", () => {
    const e = expectBadInput(() => validateSpecKeys("add_action", { class: "ZCL_X", instanceMultiplicity: 2 }));
    const message = (e as Error).message;
    expect(message).toContain("must be a string, got number");
    expect(message).not.toContain("is not one of");
  });
});
