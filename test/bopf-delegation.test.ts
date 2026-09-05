import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseModel, scanModel, locate, type Token } from "../src/adt/bopf-xml.js";
import { AbapError } from "../src/adt/errors.js";
import type { BoModel, BoNode, BoAssociation } from "../src/adt/bopf-types.js";
import {
  isDelegationOperation,
  validateDelegationShape,
  refuseHandAssembledDelegation,
  delegationModelPreflight,
  mutateDelegation,
  verifyDelegation,
  delegationNotes,
  type DelegationInput,
} from "../src/tools/bopf-delegation.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const FX_SALES_ORDER = readFileSync(join(FIXTURES, "01-get-demo_sales_order.v4.xml"), "utf8");

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
  it("accepts only remove_dependent_object; the three removed names and unrelated operations are false", () => {
    expect(isDelegationOperation("remove_dependent_object")).toBe(true);
    expect(isDelegationOperation("add_representative_node")).toBe(false);
    expect(isDelegationOperation("remove_representative_node")).toBe(false);
    expect(isDelegationOperation("embed_dependent_object")).toBe(false);
    expect(isDelegationOperation("add_node")).toBe(false);
    expect(isDelegationOperation("")).toBe(false);
  });
});

describe("validateDelegationShape", () => {
  it("refuses remove_dependent_object with no node", () => {
    expectAbapError(
      () => validateDelegationShape({ ...BASE_INPUT, operation: "remove_dependent_object", name: "ITEM_NOTES" }),
      "BAD_INPUT",
      "requires node",
    );
  });

  it("refuses remove_dependent_object with no name", () => {
    expectAbapError(
      () => validateDelegationShape({ ...BASE_INPUT, operation: "remove_dependent_object", node: "ROOT" }),
      "BAD_INPUT",
      "requires name",
    );
  });

  it("accepts a well-formed remove_dependent_object", () => {
    expect(() =>
      validateDelegationShape({ ...BASE_INPUT, operation: "remove_dependent_object", node: "ROOT", name: "ROOT_LONG_TEXT" }),
    ).not.toThrow();
  });

  it("throws UNSUPPORTED for each of the three removed operation names", () => {
    for (const operation of ["add_representative_node", "remove_representative_node", "embed_dependent_object"]) {
      expectAbapError(
        () => validateDelegationShape({ ...BASE_INPUT, operation }),
        "UNSUPPORTED",
        "not a delegation operation",
      );
    }
  });

  it("throws UNSUPPORTED for a non-delegation operation", () => {
    expectAbapError(
      () => validateDelegationShape({ ...BASE_INPUT, operation: "add_node" }),
      "UNSUPPORTED",
      "not a delegation operation",
    );
  });
});

describe("refuseHandAssembledDelegation", () => {
  it("refuses add_association with implementationType DoComposition, citing the observed rewrite", () => {
    expectAbapError(
      () => refuseHandAssembledDelegation("add_association", { implementationType: "DoComposition" }),
      "BAD_INPUT",
      "Composition",
    );
    expectAbapError(
      () => refuseHandAssembledDelegation("add_association", { implementationType: "DoComposition" }),
      "BAD_INPUT",
      "doc/CAPABILITIES/bopf.md",
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
      "dependent-object embedding",
    );
  });

  it("allows a plain add_association", () => {
    expect(() => refuseHandAssembledDelegation("add_association", { implementationType: "Association" })).not.toThrow();
  });

  it("refuses add_node with doEmbeddingName", () => {
    expectAbapError(
      () => refuseHandAssembledDelegation("add_node", { doEmbeddingName: "FOO" }),
      "BAD_INPUT",
      "dependent-object",
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
      "dependent-object",
    );
  });

  it("refuses a parentless add_node that isn't rootNode, naming add_association and REP_", () => {
    expectAbapError(() => refuseHandAssembledDelegation("add_node", {}), "BAD_INPUT", "add_association");
    expectAbapError(() => refuseHandAssembledDelegation("add_node", {}), "BAD_INPUT", "REP_");
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

describe("delegationModelPreflight — remove_dependent_object", () => {
  const fxModel = parseModel(FX_SALES_ORDER);

  it("refuses on a missing parent node", () => {
    expectAbapError(
      () =>
        delegationModelPreflight(fxModel, { ...BASE_INPUT, operation: "remove_dependent_object", node: "NOPE", name: "X" }),
      "NOT_FOUND",
      "not found",
    );
  });

  it("refuses when no association of that name exists", () => {
    expectAbapError(
      () =>
        delegationModelPreflight(fxModel, { ...BASE_INPUT, operation: "remove_dependent_object", node: "ITEM", name: "NOPE" }),
      "NOT_FOUND",
      "no association named",
    );
  });

  it("refuses when the association isn't DoComposition, naming remove_association", () => {
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

  it("refuses when the targetNodeRef is unresolvable", () => {
    const parent = makeNode({
      name: "PARENT",
      associations: [makeAssoc({ name: "EMB", implementationType: "DoComposition" })],
    });
    const model = makeModel([parent]);
    expectAbapError(
      () => delegationModelPreflight(model, { ...BASE_INPUT, operation: "remove_dependent_object", node: "PARENT", name: "EMB" }),
      "BAD_INPUT",
      "no resolvable targetNodeRef",
    );
  });

  it("refuses when the target node is absent", () => {
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

  it("refuses when the target node isn't classified delegated", () => {
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

  it("refuses when another association still targets the embedded node", () => {
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

describe("mutateDelegation", () => {
  it("remove_dependent_object removes both halves and leaves the rest of the document byte-identical", () => {
    const tokens = scanModel(FX_SALES_ORDER);
    const assocRange = locate(tokens, { node: "ROOT", child: "association", name: "ROOT_LONG_TEXT" })!;
    const nodeRange = locate(tokens, { node: "ROOT_LONG_TEXT.ROOT" })!;
    const assocText = FX_SALES_ORDER.slice(assocRange.start, assocRange.end);
    const nodeText = FX_SALES_ORDER.slice(nodeRange.start, nodeRange.end);
    expect(assocText).toContain('bo:name="ROOT_LONG_TEXT"');
    expect(nodeText).toContain('bo:name="ROOT_LONG_TEXT.ROOT"');

    const out = mutateDelegation(FX_SALES_ORDER, { ...BASE_INPUT, operation: "remove_dependent_object", node: "ROOT", name: "ROOT_LONG_TEXT" });

    const expected = FX_SALES_ORDER.replace(assocText, "").replace(nodeText, "");
    expect(out).toBe(expected);

    const model = parseModel(out);
    expect(model.nodes.find((n) => n.name === "ROOT_LONG_TEXT.ROOT")).toBeUndefined();
    expect(model.nodes.find((n) => n.name === "ROOT")!.associations.find((a) => a.name === "ROOT_LONG_TEXT")).toBeUndefined();
  });

  it("throws UNSUPPORTED for any other operation", () => {
    expectAbapError(
      () => mutateDelegation(FX_SALES_ORDER, { ...BASE_INPUT, operation: "add_representative_node", name: "VENDOR_BO" }),
      "UNSUPPORTED",
      "not a delegation operation",
    );
  });
});

describe("verifyDelegation", () => {
  it("passes remove_dependent_object on a genuine before/after pair", () => {
    const before = parseModel(FX_SALES_ORDER);
    const out = mutateDelegation(FX_SALES_ORDER, { ...BASE_INPUT, operation: "remove_dependent_object", node: "ROOT", name: "ROOT_LONG_TEXT" });
    const after = parseModel(out);
    expect(() =>
      verifyDelegation({ ...BASE_INPUT, operation: "remove_dependent_object", node: "ROOT", name: "ROOT_LONG_TEXT" }, before, after, "J1"),
    ).not.toThrow();
  });

  it("throws CHECK_FAILED naming the node when only the node half was left behind", () => {
    // Association half removed (PARENT after has none named EMB); the EMB.ROOT node
    // itself, though, is still present in "after" — the incomplete-removal case.
    const parentBefore = makeNode({
      name: "PARENT",
      associations: [makeAssoc({ name: "EMB", implementationType: "DoComposition", targetNodeRef: { type: "BOBF", name: "TEST_BO~EMB.ROOT" } })],
    });
    const embNode = makeNode({ name: "EMB.ROOT" });
    const before = makeModel([parentBefore, embNode]);
    const parentAfter = makeNode({ name: "PARENT" }); // association gone
    const after = makeModel([parentAfter, embNode]); // node still present
    expectAbapError(
      () => verifyDelegation({ ...BASE_INPUT, operation: "remove_dependent_object", node: "PARENT", name: "EMB" }, before, after, "J2"),
      "CHECK_FAILED",
      "A BOPF PUT answers 200 whether or not the server kept what was sent, and nothing was activated.",
    );
    expectAbapError(
      () => verifyDelegation({ ...BASE_INPUT, operation: "remove_dependent_object", node: "PARENT", name: "EMB" }, before, after, "J2"),
      "CHECK_FAILED",
      'the "EMB.ROOT" node',
    );
  });

  it("throws CHECK_FAILED naming the association when only the association half was left behind", () => {
    // Node half removed (EMB.ROOT absent from "after"); the association on PARENT,
    // though, is still present — the incomplete-removal case, other direction.
    const parent = makeNode({
      name: "PARENT",
      associations: [makeAssoc({ name: "EMB", implementationType: "DoComposition", targetNodeRef: { type: "BOBF", name: "TEST_BO~EMB.ROOT" } })],
    });
    const embNode = makeNode({ name: "EMB.ROOT" });
    const before = makeModel([parent, embNode]);
    const after = makeModel([parent]); // node gone, association untouched
    expectAbapError(
      () => verifyDelegation({ ...BASE_INPUT, operation: "remove_dependent_object", node: "PARENT", name: "EMB" }, before, after, "J3"),
      "CHECK_FAILED",
      'the "EMB" association on "PARENT"',
    );
  });
});

describe("delegationNotes", () => {
  it("returns the two cross-BO notes for an add_association naming another BO via targetNodeRef.name", () => {
    const notes = delegationNotes({
      ...BASE_INPUT,
      bo: "TEST_BO",
      operation: "add_association",
      name: "TO_OTHER",
      spec: { targetNodeRef: { name: "OTHER_BO~ROOT", type: "BOBF" } },
    });
    expect(notes.length).toBe(2);
    expect(notes.join(" ")).toContain("REP_");
    expect(notes.join(" ")).toContain("server-assigned");
  });

  it("returns the two cross-BO notes for an add_association identified only by targetNodeRef.uri", () => {
    const notes = delegationNotes({
      ...BASE_INPUT,
      bo: "TEST_BO",
      operation: "add_association",
      name: "TO_OTHER",
      spec: {
        targetNodeRef: {
          uri: "/sap/bc/adt/bopf/businessobjects/other_bo#//bo:businessObject/bo:nodes[@bo:name='ROOT']",
          type: "BOBF",
        },
      },
    });
    expect(notes.length).toBe(2);
    expect(notes.join(" ")).toContain("REP_");
    expect(notes.join(" ")).toContain("server-assigned");
  });

  it("reports the ASSERTION_FAILED short dump as an observation, not a rule", () => {
    const notes = delegationNotes({
      ...BASE_INPUT,
      bo: "TEST_BO",
      operation: "add_association",
      name: "TO_OTHER",
      spec: { targetNodeRef: { name: "OTHER_BO~ROOT", type: "BOBF" } },
    });
    const second = notes[1] ?? "";
    expect(second).toContain("ASSERTION_FAILED");
    expect(second).toContain("Observed once on this release");
    expect(second).toContain("Neither behaviour is established as a rule");
  });

  it("returns [] for an add_association targeting a node on the same BO", () => {
    const notes = delegationNotes({
      ...BASE_INPUT,
      bo: "TEST_BO",
      operation: "add_association",
      name: "TO_ITEM",
      spec: { targetNodeRef: { name: "TEST_BO~ITEM", type: "BOBF" } },
    });
    expect(notes).toEqual([]);
  });

  it("returns [] for remove_dependent_object and for unrelated operations", () => {
    expect(delegationNotes({ ...BASE_INPUT, operation: "remove_dependent_object", node: "ROOT", name: "ROOT_LONG_TEXT" })).toEqual([]);
    expect(delegationNotes({ ...BASE_INPUT, operation: "add_node", name: "FOO" })).toEqual([]);
  });
});
