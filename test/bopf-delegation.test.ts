import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseModel, scanModel, locate, type Token } from "../src/adt/bopf-xml.js";
import { classifyNodes } from "../src/adt/bopf-node-kinds.js";
import { AbapError } from "../src/adt/errors.js";
import type { BoModel, BoNode, BoAssociation } from "../src/adt/bopf-types.js";
import {
  isDelegationOperation,
  validateDelegationShape,
  refuseHandAssembledDelegation,
  delegationNetworkPreflight,
  delegationModelPreflight,
  mutateDelegation,
  verifyDelegation,
  delegationNotes,
  type DelegationInput,
  type DelegationSpliceDeps,
} from "../src/tools/bopf-delegation.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const FX_SALES_ORDER = readFileSync(join(FIXTURES, "01-get-demo_sales_order.v4.xml"), "utf8");

// Same logic as the private `insertNodeAtRoot` in src/tools/bopf.ts — duplicated here since it isn't exported.
function testInsertNodeAtRoot(xml: string, tokens: readonly Token[], fragment: string): string {
  const root = tokens.find((t) => t.depth === 0)!;
  const depth1 = tokens.filter((t) => t.depth === 1);
  const insertAt = depth1.length ? Math.max(...depth1.map((t) => t.closeEnd)) : root.openEnd;
  return xml.slice(0, insertAt) + fragment + xml.slice(insertAt);
}
const deps: DelegationSpliceDeps = { insertNodeAtRoot: testInsertNodeAtRoot };

function expectAbapError(fn: () => unknown, code: string, substr: string): void {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof AbapError)) throw e;
    expect(e.code).toBe(code);
    expect(e.message).toContain(substr);
    return;
  }
  throw new Error(`expected to throw AbapError ${code}`);
}

function expectNoLiteralUndefined(fn: () => unknown): void {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof AbapError)) throw e;
    expect(e.message).not.toContain("undefined");
    return;
  }
  throw new Error("expected to throw AbapError");
}

async function expectAbapErrorAsync(fn: () => Promise<unknown>, code: string, substr: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof AbapError)) throw e;
    expect(e.code).toBe(code);
    expect(e.message).toContain(substr);
    return;
  }
  throw new Error(`expected to throw AbapError ${code}`);
}

function makeNode(overrides: Partial<BoNode> & { name: string }): BoNode {
  return {
    rootNode: false,
    textNode: false,
    isDependentObjectNode: false,
    createEnabled: true,
    updateEnabled: true,
    deleteEnabled: true,
    authorizationCheck: false,
    isExtensible: false,
    objectModelGenerated: false,
    objectModelObsolete: false,
    properties: [],
    alternativeKeys: [],
    associations: [],
    queries: [],
    actions: [],
    determinations: [],
    validations: [],
    ...overrides,
  };
}

function makeAssoc(overrides: Partial<BoAssociation> & { name: string }): BoAssociation {
  return { ...overrides };
}

function makeModel(nodes: BoNode[], overrides: Partial<BoModel> = {}): BoModel {
  return { name: "TEST_BO", type: "BOBF", nodes, ...overrides };
}

const BASE_INPUT = { bo: "/BOBF/DEMO_SALES_ORDER" };

describe("isDelegationOperation", () => {
  it("accepts the four delegation operations and rejects everything else", () => {
    expect(isDelegationOperation("add_representative_node")).toBe(true);
    expect(isDelegationOperation("embed_dependent_object")).toBe(true);
    expect(isDelegationOperation("add_node")).toBe(false);
    expect(isDelegationOperation("")).toBe(false);
  });
});

describe("validateDelegationShape", () => {
  it("refuses add_representative_node given a node", () => {
    expectAbapError(
      () =>
        validateDelegationShape({
          ...BASE_INPUT,
          operation: "add_representative_node",
          node: "SOMETHING",
          name: "VENDOR_BO",
          spec: { representedBo: "/BOBF/DEMO_VENDOR" },
        }),
      "BAD_INPUT",
      "does not take node",
    );
  });

  it("refuses add_representative_node with no name", () => {
    expectAbapError(
      () => validateDelegationShape({ ...BASE_INPUT, operation: "add_representative_node", spec: { representedBo: "X" } }),
      "BAD_INPUT",
      "requires name",
    );
  });

  it("refuses add_representative_node with no spec.representedBo", () => {
    expectAbapError(
      () => validateDelegationShape({ ...BASE_INPUT, operation: "add_representative_node", name: "VENDOR_BO" }),
      "BAD_INPUT",
      "requires spec.representedBo",
    );
  });

  it("accepts a well-formed add_representative_node", () => {
    expect(() =>
      validateDelegationShape({
        ...BASE_INPUT,
        operation: "add_representative_node",
        name: "VENDOR_BO",
        spec: { representedBo: "/BOBF/DEMO_VENDOR" },
      }),
    ).not.toThrow();
  });

  it("refuses remove_representative_node with no node", () => {
    expectAbapError(
      () => validateDelegationShape({ ...BASE_INPUT, operation: "remove_representative_node" }),
      "BAD_INPUT",
      "requires node",
    );
  });

  it("refuses embed_dependent_object with no node/name", () => {
    expectAbapError(
      () =>
        validateDelegationShape({
          ...BASE_INPUT,
          operation: "embed_dependent_object",
          name: "ITEM_NOTES",
          spec: { dependentObject: "X" },
          i_know_this_may_not_activate: true,
        }),
      "BAD_INPUT",
      "requires node",
    );
  });

  it("refuses embed_dependent_object with no spec.dependentObject", () => {
    expectAbapError(
      () =>
        validateDelegationShape({
          ...BASE_INPUT,
          operation: "embed_dependent_object",
          node: "ITEM",
          name: "ITEM_NOTES",
          i_know_this_may_not_activate: true,
        }),
      "BAD_INPUT",
      "requires spec.dependentObject",
    );
  });

  it("refuses embed_dependent_object without i_know_this_may_not_activate", () => {
    expectAbapError(
      () =>
        validateDelegationShape({
          ...BASE_INPUT,
          operation: "embed_dependent_object",
          node: "ITEM",
          name: "ITEM_NOTES",
          spec: { dependentObject: "/BOBF/DEMO_NOTES" },
        }),
      "BAD_INPUT",
      "i_know_this_may_not_activate",
    );
  });

  it("accepts a well-formed embed_dependent_object", () => {
    expect(() =>
      validateDelegationShape({
        ...BASE_INPUT,
        operation: "embed_dependent_object",
        node: "ITEM",
        name: "ITEM_NOTES",
        spec: { dependentObject: "/BOBF/DEMO_NOTES" },
        i_know_this_may_not_activate: true,
      }),
    ).not.toThrow();
  });

  it("refuses remove_dependent_object with no node/name", () => {
    expectAbapError(
      () => validateDelegationShape({ ...BASE_INPUT, operation: "remove_dependent_object" }),
      "BAD_INPUT",
      "requires node",
    );
  });

  it("refuses an operation that isn't a delegation operation", () => {
    expectAbapError(
      () => validateDelegationShape({ ...BASE_INPUT, operation: "add_node" }),
      "UNSUPPORTED",
      "not a delegation operation",
    );
  });
});

describe("refuseHandAssembledDelegation", () => {
  it("refuses add_association with implementationType DoComposition", () => {
    expectAbapError(
      () => refuseHandAssembledDelegation("add_association", { implementationType: "DoComposition" }),
      "BAD_INPUT",
      "embed_dependent_object",
    );
  });

  it("names the association when a name is given, and stays coherent without one", () => {
    expectAbapError(
      () => refuseHandAssembledDelegation("add_association", { implementationType: "DoComposition" }, "TO_ITEM"),
      "BAD_INPUT",
      "TO_ITEM",
    );
    expectAbapError(
      () => refuseHandAssembledDelegation("add_association", { implementationType: "DoComposition" }),
      "BAD_INPUT",
      "add_association with implementationType",
    );
    expectNoLiteralUndefined(() => refuseHandAssembledDelegation("add_association", { implementationType: "DoComposition" }));
  });

  it("refuses add_association with a doEmbeddingName even if implementationType is absent", () => {
    expectAbapError(
      () => refuseHandAssembledDelegation("add_association", { doEmbeddingName: "FOO" }),
      "BAD_INPUT",
      "embed_dependent_object",
    );
  });

  it("allows a plain add_association", () => {
    expect(() => refuseHandAssembledDelegation("add_association", { implementationType: "Association" })).not.toThrow();
  });

  it("refuses add_node with doEmbeddingName", () => {
    expectAbapError(
      () => refuseHandAssembledDelegation("add_node", { doEmbeddingName: "FOO" }),
      "BAD_INPUT",
      "embed_dependent_object",
    );
  });

  it("names the embedded node when a name is given, and stays coherent without one", () => {
    expectAbapError(
      () => refuseHandAssembledDelegation("add_node", { doEmbeddingName: "FOO" }, "ITEM_NOTES"),
      "BAD_INPUT",
      "ITEM_NOTES",
    );
    expectAbapError(
      () => refuseHandAssembledDelegation("add_node", { doEmbeddingName: "FOO" }),
      "BAD_INPUT",
      "add_node with doEmbeddingName set",
    );
    expectNoLiteralUndefined(() => refuseHandAssembledDelegation("add_node", { doEmbeddingName: "FOO" }));
  });

  it("refuses add_node with isDependentObjectNode true", () => {
    expectAbapError(
      () => refuseHandAssembledDelegation("add_node", { isDependentObjectNode: true }),
      "BAD_INPUT",
      "embed_dependent_object",
    );
  });

  it("refuses a parentless add_node that isn't rootNode", () => {
    expectAbapError(
      () => refuseHandAssembledDelegation("add_node", {}),
      "BAD_INPUT",
      "add_representative_node",
    );
  });

  it("names the parentless node when a name is given, and stays coherent without one", () => {
    expectAbapError(() => refuseHandAssembledDelegation("add_node", {}, "ITEM"), "BAD_INPUT", "ITEM");
    expectAbapError(
      () => refuseHandAssembledDelegation("add_node", {}),
      "BAD_INPUT",
      "add_node with no spec.parent",
    );
    expectNoLiteralUndefined(() => refuseHandAssembledDelegation("add_node", {}));
  });

  it("allows add_node with a parent", () => {
    expect(() => refuseHandAssembledDelegation("add_node", { parent: "#//bo:businessObject/bo:nodes[@bo:name='ROOT']" })).not.toThrow();
  });

  it("allows add_node with rootNode true", () => {
    expect(() => refuseHandAssembledDelegation("add_node", { rootNode: true })).not.toThrow();
  });

  it("is a no-op for unrelated operations", () => {
    expect(() => refuseHandAssembledDelegation("remove_node", { anything: true })).not.toThrow();
  });
});

describe("delegationNetworkPreflight", () => {
  it("passes add_representative_node when the represented BO reads fine", async () => {
    const readOtherModel = vi.fn(async () => makeModel([]));
    await expect(
      delegationNetworkPreflight(
        { ...BASE_INPUT, operation: "add_representative_node", name: "VENDOR_BO", spec: { representedBo: "/BOBF/DEMO_VENDOR" } },
        readOtherModel,
      ),
    ).resolves.toBeUndefined();
    expect(readOtherModel).toHaveBeenCalledWith("/BOBF/DEMO_VENDOR");
  });

  it("surfaces a failed represented-BO read as BAD_INPUT", async () => {
    const readOtherModel = vi.fn(async () => {
      throw new Error("404");
    });
    await expectAbapErrorAsync(
      () =>
        delegationNetworkPreflight(
          { ...BASE_INPUT, operation: "add_representative_node", name: "VENDOR_BO", spec: { representedBo: "/BOBF/DEMO_VENDOR" } },
          readOtherModel,
        ),
      "BAD_INPUT",
      "could not be read",
    );
  });

  it("passes embed_dependent_object when the dependent object has objectCategory dependentObject", async () => {
    const readOtherModel = vi.fn(async () => makeModel([], { objectCategory: "dependentObject" }));
    await expect(
      delegationNetworkPreflight(
        {
          ...BASE_INPUT,
          operation: "embed_dependent_object",
          node: "ITEM",
          name: "ITEM_NOTES",
          spec: { dependentObject: "/BOBF/DEMO_NOTES" },
          i_know_this_may_not_activate: true,
        },
        readOtherModel,
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses embed_dependent_object when the dependent object has the wrong objectCategory", async () => {
    const readOtherModel = vi.fn(async () => makeModel([], { objectCategory: "businessProcessObject" }));
    await expectAbapErrorAsync(
      () =>
        delegationNetworkPreflight(
          {
            ...BASE_INPUT,
            operation: "embed_dependent_object",
            node: "ITEM",
            name: "ITEM_NOTES",
            spec: { dependentObject: "/BOBF/DEMO_NOTES" },
            i_know_this_may_not_activate: true,
          },
          readOtherModel,
        ),
      "BAD_INPUT",
      "not \"dependentObject\"",
    );
  });

  it("surfaces a failed dependent-object read as BAD_INPUT", async () => {
    const readOtherModel = vi.fn(async () => {
      throw new Error("gone");
    });
    await expectAbapErrorAsync(
      () =>
        delegationNetworkPreflight(
          {
            ...BASE_INPUT,
            operation: "embed_dependent_object",
            node: "ITEM",
            name: "ITEM_NOTES",
            spec: { dependentObject: "/BOBF/DEMO_NOTES" },
            i_know_this_may_not_activate: true,
          },
          readOtherModel,
        ),
      "BAD_INPUT",
      "could not be read",
    );
  });

  it("never reads another BO for remove_representative_node / remove_dependent_object", async () => {
    const readOtherModel = vi.fn(async () => makeModel([]));
    await delegationNetworkPreflight({ ...BASE_INPUT, operation: "remove_representative_node", node: "CUSTOMER_BO" }, readOtherModel);
    await delegationNetworkPreflight({ ...BASE_INPUT, operation: "remove_dependent_object", node: "ROOT", name: "ROOT_LONG_TEXT" }, readOtherModel);
    expect(readOtherModel).not.toHaveBeenCalled();
  });
});

describe("delegationModelPreflight", () => {
  const fxModel = parseModel(FX_SALES_ORDER);

  it("refuses add_representative_node when the node name already exists", () => {
    expectAbapError(
      () => delegationModelPreflight(fxModel, { ...BASE_INPUT, operation: "add_representative_node", name: "ITEM" }),
      "BAD_INPUT",
      "already exists",
    );
  });

  it("accepts add_representative_node with a fresh name", () => {
    expect(() =>
      delegationModelPreflight(fxModel, { ...BASE_INPUT, operation: "add_representative_node", name: "VENDOR_BO" }),
    ).not.toThrow();
  });

  it("refuses remove_representative_node on a node that doesn't exist", () => {
    expectAbapError(
      () => delegationModelPreflight(fxModel, { ...BASE_INPUT, operation: "remove_representative_node", node: "NOPE" }),
      "NOT_FOUND",
      "not found",
    );
  });

  it("refuses remove_representative_node on a standard node, naming remove_node", () => {
    expectAbapError(
      () => delegationModelPreflight(fxModel, { ...BASE_INPUT, operation: "remove_representative_node", node: "ITEM" }),
      "BAD_INPUT",
      "remove_node",
    );
  });

  it("refuses remove_representative_node on a delegated node, naming remove_dependent_object", () => {
    expectAbapError(
      () =>
        delegationModelPreflight(fxModel, { ...BASE_INPUT, operation: "remove_representative_node", node: "ROOT_LONG_TEXT.ROOT" }),
      "BAD_INPUT",
      "remove_dependent_object",
    );
  });

  it("accepts remove_representative_node on an untargeted representative node", () => {
    expect(() =>
      delegationModelPreflight(fxModel, { ...BASE_INPUT, operation: "remove_representative_node", node: "CUSTOMER_BO" }),
    ).not.toThrow();
  });

  it("refuses remove_representative_node when an association still targets it", () => {
    const rep = makeNode({ name: "CUSTOMER_BO" });
    const owner = makeNode({
      name: "ROOT",
      rootNode: true,
      associations: [makeAssoc({ name: "CUSTOMER_ROOT", targetNodeRef: { type: "BOBF", name: "TEST_BO~CUSTOMER_BO" } })],
    });
    const model = makeModel([owner, rep]);
    expectAbapError(
      () => delegationModelPreflight(model, { ...BASE_INPUT, operation: "remove_representative_node", node: "CUSTOMER_BO" }),
      "BAD_INPUT",
      "ROOT.CUSTOMER_ROOT",
    );
  });

  it("refuses embed_dependent_object on a missing parent node", () => {
    expectAbapError(
      () =>
        delegationModelPreflight(fxModel, {
          ...BASE_INPUT,
          operation: "embed_dependent_object",
          node: "NOPE",
          name: "ITEM_NOTES",
        }),
      "NOT_FOUND",
      "not found",
    );
  });

  it("refuses embed_dependent_object when the association name already exists on the parent", () => {
    expectAbapError(
      () =>
        delegationModelPreflight(fxModel, {
          ...BASE_INPUT,
          operation: "embed_dependent_object",
          node: "ITEM",
          name: "ITEM_LONG_TEXT",
        }),
      "BAD_INPUT",
      "already exists",
    );
  });

  it("refuses embed_dependent_object when the <name>.ROOT node already exists", () => {
    const parent = makeNode({ name: "PARENT" });
    const collide = makeNode({ name: "NEWEMB.ROOT" });
    const model = makeModel([parent, collide]);
    expectAbapError(
      () => delegationModelPreflight(model, { ...BASE_INPUT, operation: "embed_dependent_object", node: "PARENT", name: "NEWEMB" }),
      "BAD_INPUT",
      "already exists",
    );
  });

  it("accepts a fresh embed_dependent_object under ITEM", () => {
    expect(() =>
      delegationModelPreflight(fxModel, { ...BASE_INPUT, operation: "embed_dependent_object", node: "ITEM", name: "ITEM_NOTES" }),
    ).not.toThrow();
  });

  it("refuses remove_dependent_object on a missing parent node", () => {
    expectAbapError(
      () =>
        delegationModelPreflight(fxModel, { ...BASE_INPUT, operation: "remove_dependent_object", node: "NOPE", name: "X" }),
      "NOT_FOUND",
      "not found",
    );
  });

  it("refuses remove_dependent_object when no such association exists", () => {
    expectAbapError(
      () =>
        delegationModelPreflight(fxModel, { ...BASE_INPUT, operation: "remove_dependent_object", node: "ITEM", name: "NOPE" }),
      "NOT_FOUND",
      "no association named",
    );
  });

  it("refuses remove_dependent_object when the association isn't DoComposition", () => {
    const parent = makeNode({
      name: "PARENT",
      associations: [makeAssoc({ name: "PLAIN", implementationType: "Association", targetNodeRef: { type: "BOBF", name: "TEST_BO~SOMEWHERE" } })],
    });
    const model = makeModel([parent]);
    expectAbapError(
      () => delegationModelPreflight(model, { ...BASE_INPUT, operation: "remove_dependent_object", node: "PARENT", name: "PLAIN" }),
      "BAD_INPUT",
      "remove_association",
    );
  });

  it("refuses remove_dependent_object when the target node doesn't exist", () => {
    const parent = makeNode({
      name: "PARENT",
      associations: [makeAssoc({ name: "EMB", implementationType: "DoComposition", targetNodeRef: { type: "BOBF", name: "TEST_BO~EMB.ROOT" } })],
    });
    const model = makeModel([parent]);
    expectAbapError(
      () => delegationModelPreflight(model, { ...BASE_INPUT, operation: "remove_dependent_object", node: "PARENT", name: "EMB" }),
      "NOT_FOUND",
      "does not exist",
    );
  });

  it("refuses remove_dependent_object when the target node isn't classified as delegated", () => {
    const root = makeNode({ name: "ROOT", rootNode: true });
    const parent = makeNode({
      name: "PARENT",
      associations: [makeAssoc({ name: "BADEMB", implementationType: "DoComposition", targetNodeRef: { type: "BOBF", name: "TEST_BO~ROOT" } })],
    });
    const model = makeModel([root, parent]);
    expectAbapError(
      () => delegationModelPreflight(model, { ...BASE_INPUT, operation: "remove_dependent_object", node: "PARENT", name: "BADEMB" }),
      "BAD_INPUT",
      "not delegated",
    );
  });

  it("refuses remove_dependent_object when another association also targets the embedded node", () => {
    const root = makeNode({ name: "ROOT", rootNode: true });
    const parent = makeNode({
      name: "PARENT",
      associations: [makeAssoc({ name: "EMB", implementationType: "DoComposition", targetNodeRef: { type: "BOBF", name: "TEST_BO~EMB.ROOT" } })],
    });
    const other = makeNode({
      name: "OTHER",
      associations: [makeAssoc({ name: "ALSO", implementationType: "Association", targetNodeRef: { type: "BOBF", name: "TEST_BO~EMB.ROOT" } })],
    });
    const embNode = makeNode({ name: "EMB.ROOT", parent: "#//bo:businessObject/bo:nodes[@bo:name='ROOT']" });
    const model = makeModel([root, parent, other, embNode]);
    expectAbapError(
      () => delegationModelPreflight(model, { ...BASE_INPUT, operation: "remove_dependent_object", node: "PARENT", name: "EMB" }),
      "BAD_INPUT",
      "OTHER.ALSO",
    );
  });

  it("accepts removing ROOT_LONG_TEXT from ROOT in the fixture", () => {
    expect(() =>
      delegationModelPreflight(fxModel, { ...BASE_INPUT, operation: "remove_dependent_object", node: "ROOT", name: "ROOT_LONG_TEXT" }),
    ).not.toThrow();
  });
});

describe("mutateDelegation — add_representative_node", () => {
  it("renders the exact wire shape observed for a representative node", () => {
    const out = mutateDelegation(
      FX_SALES_ORDER,
      { ...BASE_INPUT, operation: "add_representative_node", name: "VENDOR_BO", spec: { xmlName: "Vendor BO" } },
      deps,
    );
    const m = /<bo:nodes bo:name="VENDOR_BO"[\s\S]*?<\/bo:nodes>/.exec(out);
    expect(m).toBeTruthy();
    const masked = m![0].replace(/bo:nodeID="[^"]*"/, 'bo:nodeID="MASKED"');
    expect(masked).toBe(
      '<bo:nodes bo:name="VENDOR_BO" bo:nodeID="MASKED" bo:xmlName="Vendor BO" bo:objectModelGenerated="false" ' +
        'bo:authorizationCheck="false" bo:isExtensible="false" bo:isDependentObjectNode="false" bo:textNode="false" ' +
        'bo:createEnabled="true" bo:updateEnabled="true" bo:deleteEnabled="true" bo:rootNode="false" ' +
        'bo:objectModelObsolete="false">' +
        '<bo:properties bo:name="KEY" bo:enabled="true" bo:readonly="false" bo:mandatory="false" bo:enabledFinal="false" ' +
        'bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/>' +
        '<bo:properties bo:name="PARENT_KEY" bo:enabled="true" bo:readonly="false" bo:mandatory="false" bo:enabledFinal="false" ' +
        'bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/>' +
        '<bo:properties bo:name="ROOT_KEY" bo:enabled="true" bo:readonly="false" bo:mandatory="false" bo:enabledFinal="false" ' +
        'bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/>' +
        '</bo:nodes>',
    );
  });

  it("parses back with parseModel and classifies as representative", () => {
    const out = mutateDelegation(FX_SALES_ORDER, { ...BASE_INPUT, operation: "add_representative_node", name: "VENDOR_BO" }, deps);
    const model = parseModel(out);
    const kinds = classifyNodes(model);
    expect(kinds.get("vendor_bo")?.kind).toBe("representative");
  });
});

describe("mutateDelegation — remove_representative_node", () => {
  it("removes the node element", () => {
    const out = mutateDelegation(FX_SALES_ORDER, { ...BASE_INPUT, operation: "remove_representative_node", node: "CUSTOMER_BO" }, deps);
    expect(out).not.toContain('bo:name="CUSTOMER_BO"');
    const model = parseModel(out);
    expect(model.nodes.find((n) => n.name === "CUSTOMER_BO")).toBeUndefined();
  });
});

describe("mutateDelegation — embed_dependent_object", () => {
  const input: DelegationInput = {
    ...BASE_INPUT,
    operation: "embed_dependent_object",
    node: "ITEM",
    name: "ITEM_NOTES",
    spec: { dependentObject: "/BOBF/DEMO_NOTES" },
    i_know_this_may_not_activate: true,
  };

  it("writes both halves with the observed wire's case asymmetry, and round-trips through classifyNodes as delegated", () => {
    const out = mutateDelegation(FX_SALES_ORDER, input, deps);
    const model = parseModel(out);

    const newNode = model.nodes.find((n) => n.name === "ITEM_NOTES.ROOT");
    expect(newNode).toBeTruthy();
    expect(newNode!.parentNodeId).toBe("SCiK4Ih7UPzhAAAACkIXLw=="); // ITEM's real bo:nodeID in the fixture

    const itemNode = model.nodes.find((n) => n.name === "ITEM")!;
    const assoc = itemNode.associations.find((a) => a.name === "ITEM_NOTES");
    expect(assoc).toBeTruthy();
    expect(assoc!.implementationType).toBe("DoComposition");
    expect(assoc!.targetNodeRef!.uri).toBe(
      "/sap/bc/adt/bopf/businessobjects/%2fbobf%2fdemo_sales_order#//bo:businessObject/bo:nodes[@bo:name='ITEM_NOTES.ROOT']",
    );
    expect(assoc!.targetNodeRef!.name).toBe("/BOBF/DEMO_SALES_ORDER~ITEM_NOTES.ROOT");

    const kinds = classifyNodes(model);
    const kind = kinds.get("item_notes.root");
    expect(kind?.kind).toBe("delegated");
    expect(kind?.embeddingParent).toBe("ITEM");
    expect(kind?.embeddingAssociation).toBe("ITEM_NOTES");
  });

  it("defaults the implementation class ref to the SAP simple bridge class", () => {
    const out = mutateDelegation(FX_SALES_ORDER, input, deps);
    const model = parseModel(out);
    const assoc = model.nodes.find((n) => n.name === "ITEM")!.associations.find((a) => a.name === "ITEM_NOTES")!;
    expect(assoc.implementationClassRef).toEqual({
      uri: "/sap/bc/adt/oo/classes/%2fbobf%2fcl_c_bopf_2_bopf_simple",
      type: "CLAS/OC",
      name: "/BOBF/CL_C_BOPF_2_BOPF_SIMPLE",
    });
  });
});

describe("mutateDelegation — remove_dependent_object", () => {
  it("removes both halves and leaves the rest of the document byte-identical", () => {
    const tokens = scanModel(FX_SALES_ORDER);
    const assocRange = locate(tokens, { node: "ROOT", child: "association", name: "ROOT_LONG_TEXT" })!;
    const nodeRange = locate(tokens, { node: "ROOT_LONG_TEXT.ROOT" })!;
    const assocText = FX_SALES_ORDER.slice(assocRange.start, assocRange.end);
    const nodeText = FX_SALES_ORDER.slice(nodeRange.start, nodeRange.end);
    expect(assocText).toContain('bo:name="ROOT_LONG_TEXT"');
    expect(nodeText).toContain('bo:name="ROOT_LONG_TEXT.ROOT"');

    const out = mutateDelegation(FX_SALES_ORDER, { ...BASE_INPUT, operation: "remove_dependent_object", node: "ROOT", name: "ROOT_LONG_TEXT" }, deps);

    const expected = FX_SALES_ORDER.replace(assocText, "").replace(nodeText, "");
    expect(out).toBe(expected);

    const model = parseModel(out);
    expect(model.nodes.find((n) => n.name === "ROOT_LONG_TEXT.ROOT")).toBeUndefined();
    expect(model.nodes.find((n) => n.name === "ROOT")!.associations.find((a) => a.name === "ROOT_LONG_TEXT")).toBeUndefined();
  });
});

describe("verifyDelegation", () => {
  it("passes add_representative_node on a genuine before/after pair", () => {
    const before = parseModel(FX_SALES_ORDER);
    const out = mutateDelegation(FX_SALES_ORDER, { ...BASE_INPUT, operation: "add_representative_node", name: "VENDOR_BO" }, deps);
    const after = parseModel(out);
    expect(() =>
      verifyDelegation({ ...BASE_INPUT, operation: "add_representative_node", name: "VENDOR_BO" }, before, after, "J1"),
    ).not.toThrow();
  });

  it("throws CHECK_FAILED naming the node when add_representative_node silently didn't land", () => {
    const before = parseModel(FX_SALES_ORDER);
    const after = parseModel(FX_SALES_ORDER); // unchanged
    expectAbapError(
      () => verifyDelegation({ ...BASE_INPUT, operation: "add_representative_node", name: "VENDOR_BO" }, before, after, "J1"),
      "CHECK_FAILED",
      "J1",
    );
  });

  it("passes remove_representative_node on a genuine before/after pair", () => {
    const before = parseModel(FX_SALES_ORDER);
    const out = mutateDelegation(FX_SALES_ORDER, { ...BASE_INPUT, operation: "remove_representative_node", node: "CUSTOMER_BO" }, deps);
    const after = parseModel(out);
    expect(() =>
      verifyDelegation({ ...BASE_INPUT, operation: "remove_representative_node", node: "CUSTOMER_BO" }, before, after, "J2"),
    ).not.toThrow();
  });

  it("passes embed_dependent_object when both halves land", () => {
    const before = parseModel(FX_SALES_ORDER);
    const input: DelegationInput = { ...BASE_INPUT, operation: "embed_dependent_object", node: "ITEM", name: "ITEM_NOTES" };
    const out = mutateDelegation(FX_SALES_ORDER, { ...input, spec: { dependentObject: "X" }, i_know_this_may_not_activate: true }, deps);
    const after = parseModel(out);
    expect(() => verifyDelegation(input, before, after, "J3")).not.toThrow();
  });

  it("names the missing half when only the association side of embed_dependent_object landed", () => {
    const parent = makeNode({ name: "PARENT" });
    const before = makeModel([parent]);
    const parentAfter = makeNode({
      name: "PARENT",
      associations: [makeAssoc({ name: "EMB", implementationType: "DoComposition", targetNodeRef: { type: "BOBF", name: "TEST_BO~EMB.ROOT" } })],
    });
    const after = makeModel([parentAfter]); // no EMB.ROOT node
    expectAbapError(
      () => verifyDelegation({ ...BASE_INPUT, operation: "embed_dependent_object", node: "PARENT", name: "EMB" }, before, after, "J4"),
      "CHECK_FAILED",
      'the "EMB.ROOT" node',
    );
  });

  it("names the missing half when only the node side of embed_dependent_object landed", () => {
    const parent = makeNode({ name: "PARENT" });
    const before = makeModel([parent]);
    const embNode = makeNode({ name: "EMB.ROOT" });
    const after = makeModel([parent, embNode]); // no association on PARENT
    expectAbapError(
      () => verifyDelegation({ ...BASE_INPUT, operation: "embed_dependent_object", node: "PARENT", name: "EMB" }, before, after, "J5"),
      "CHECK_FAILED",
      'the "EMB" association on "PARENT"',
    );
  });

  it("passes remove_dependent_object on a genuine before/after pair", () => {
    const before = parseModel(FX_SALES_ORDER);
    const out = mutateDelegation(FX_SALES_ORDER, { ...BASE_INPUT, operation: "remove_dependent_object", node: "ROOT", name: "ROOT_LONG_TEXT" }, deps);
    const after = parseModel(out);
    expect(() =>
      verifyDelegation({ ...BASE_INPUT, operation: "remove_dependent_object", node: "ROOT", name: "ROOT_LONG_TEXT" }, before, after, "J6"),
    ).not.toThrow();
  });

  it("throws CHECK_FAILED when remove_dependent_object left the node behind", () => {
    const before = parseModel(FX_SALES_ORDER);
    const after = parseModel(FX_SALES_ORDER); // unchanged
    expectAbapError(
      () =>
        verifyDelegation({ ...BASE_INPUT, operation: "remove_dependent_object", node: "ROOT", name: "ROOT_LONG_TEXT" }, before, after, "J7"),
      "CHECK_FAILED",
      "J7",
    );
  });
});

describe("delegationNotes", () => {
  it("discloses the unwritten representedBo link for add_representative_node", () => {
    const notes = delegationNotes({ ...BASE_INPUT, operation: "add_representative_node", name: "VENDOR_BO", spec: { representedBo: "/BOBF/DEMO_VENDOR" } });
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.join(" ")).toContain("add_association");
  });

  it("discloses that the dependent object is not written to the wire for embed_dependent_object", () => {
    const notes = delegationNotes({
      ...BASE_INPUT,
      operation: "embed_dependent_object",
      node: "ITEM",
      name: "ITEM_NOTES",
      spec: { dependentObject: "/BOBF/DEMO_NOTES" },
      i_know_this_may_not_activate: true,
    });
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.join(" ")).toContain("not written to the wire");
  });

  it("is empty for the two remove operations", () => {
    expect(delegationNotes({ ...BASE_INPUT, operation: "remove_representative_node", node: "CUSTOMER_BO" })).toEqual([]);
    expect(delegationNotes({ ...BASE_INPUT, operation: "remove_dependent_object", node: "ROOT", name: "ROOT_LONG_TEXT" })).toEqual([]);
  });
});
