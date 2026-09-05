/**
 * BOPF "delegation" operations: nodes that stand in for another BO
 * (`representative`) and dependent objects embedded via a DoComposition
 * association pair (`delegated`). Split out of `bopf.ts` to avoid a cycle —
 * `bopf.ts` will import from here, so this file imports nothing from it and
 * re-declares the handful of local helpers it needs.
 *
 * Wire fact this whole module exists to respect: the host BO's XML never
 * names the BO a representative node stands in for, nor the dependent
 * object a delegated node embeds. Both operations therefore validate a BO
 * name over the network but deliberately do not write it — see
 * `delegationNotes`.
 */
import { AbapError } from "../adt/errors.js";
import type { BoModel, BoNode, AdtObjectRef } from "../adt/bopf-types.js";
import {
  scanModel,
  locate,
  spliceOut,
  spliceInsertChild,
  renderNodeElement,
  renderAssociationElement,
  renderProperty,
  mintGuid,
  type Token,
  type NodeFields,
  type AssociationFields,
} from "../adt/bopf-xml.js";
import { classifyNode } from "../adt/bopf-node-kinds.js";

export const DELEGATION_OPERATIONS = [
  "add_representative_node",
  "remove_representative_node",
  "embed_dependent_object",
  "remove_dependent_object",
] as const;
export type DelegationOperation = (typeof DELEGATION_OPERATIONS)[number];

export function isDelegationOperation(op: string): op is DelegationOperation {
  return (DELEGATION_OPERATIONS as readonly string[]).includes(op);
}

/** Structural subset of `BopfEditInput` (src/tools/bopf.ts) — declared here to keep this module free of a cycle. */
export interface DelegationInput {
  readonly bo: string;
  readonly operation: string;
  readonly node?: string;
  readonly nodeId?: string;
  readonly name?: string;
  readonly spec?: Record<string, unknown>;
  readonly i_know_this_may_not_activate?: boolean;
}

const DEFAULT_EMBED_IMPL_CLASS_REF: AdtObjectRef = {
  uri: "/sap/bc/adt/oo/classes/%2fbobf%2fcl_c_bopf_2_bopf_simple",
  type: "CLAS/OC",
  name: "/BOBF/CL_C_BOPF_2_BOPF_SIMPLE",
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function ref(v: unknown): AdtObjectRef | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const name = str(o.name);
  const type = str(o.type);
  if (!name || !type) return undefined;
  const uri = str(o.uri);
  return uri ? { uri, type, name } : { type, name };
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Same resolution order as `resolveTargetNodeName` in src/tools/bopf.ts, duplicated to avoid an import cycle. */
function resolveTargetNodeName(target: AdtObjectRef | undefined): string | undefined {
  if (!target) return undefined;
  if (target.uri) {
    const m = /bo:nodes\[@bo:name='([^']*)'\]\s*$/.exec(target.uri);
    if (m) return m[1];
  }
  const tilde = target.name.lastIndexOf("~");
  return tilde >= 0 ? target.name.slice(tilde + 1) : target.name;
}

function findModelNode(model: BoModel, name: string): BoNode | undefined {
  const wanted = name.toLowerCase();
  return model.nodes.find((n) => n.name.toLowerCase() === wanted);
}

function nodeNameList(model: BoModel): string {
  return model.nodes.map((n) => n.name).join(", ");
}

function requireInputNode(input: DelegationInput): string {
  if (!input.node) {
    throw new AbapError("BAD_INPUT", `${input.operation} requires node.`, { operation: input.operation });
  }
  return input.node;
}

function requireInputName(input: DelegationInput): string {
  if (!input.name) {
    throw new AbapError("BAD_INPUT", `${input.operation} requires name.`, { operation: input.operation });
  }
  return input.name;
}

/** Zero-network shape check for the four operations. Throws AbapError BAD_INPUT. */
export function validateDelegationShape(input: DelegationInput): void {
  const spec = input.spec ?? {};
  switch (input.operation) {
    case "add_representative_node": {
      requireInputName(input);
      if (input.node !== undefined) {
        throw new AbapError(
          "BAD_INPUT",
          `add_representative_node does not take node — a representative node has no parent (it stands in for ` +
            `another BO, not a child of one). Name the new node with "name".`,
          { operation: input.operation, node: input.node },
        );
      }
      if (!str(spec.representedBo)) {
        throw new AbapError(
          "BAD_INPUT",
          `add_representative_node requires spec.representedBo (the BO this node will stand in for).`,
          { operation: input.operation },
        );
      }
      return;
    }
    case "remove_representative_node":
      requireInputNode(input);
      return;
    case "embed_dependent_object": {
      requireInputNode(input);
      requireInputName(input);
      if (!str(spec.dependentObject)) {
        throw new AbapError(
          "BAD_INPUT",
          `embed_dependent_object requires spec.dependentObject (the dependent object BO being embedded).`,
          { operation: input.operation },
        );
      }
      if (input.i_know_this_may_not_activate !== true) {
        throw new AbapError(
          "BAD_INPUT",
          `embed_dependent_object requires i_know_this_may_not_activate: true — this writes the exact wire shape ` +
            `observed for an embedding (an association plus a "<name>.ROOT" node), but the host BO's XML never names ` +
            `the dependent object anywhere, so a 200 plus a matching read-back is not confirmed to create a working ` +
            `embedding server-side.`,
          { operation: input.operation },
        );
      }
      return;
    }
    case "remove_dependent_object":
      requireInputNode(input);
      requireInputName(input);
      return;
    default:
      throw new AbapError("UNSUPPORTED", `"${input.operation}" is not a delegation operation.`, {
        operation: input.operation,
      });
  }
}

/** Refuses a delegation hand-assembled through add_node/add_association and names the proper operation. Throws BAD_INPUT. */
export function refuseHandAssembledDelegation(operation: string, spec: Record<string, unknown>, name?: string): void {
  // `name` is the element's own name (input.name), so a caller adding several nodes in one
  // session still learns which one was refused.
  const named = name ? ` "${name}"` : "";
  if (operation === "add_association") {
    const implementationType = str(spec.implementationType);
    const doEmbeddingName = str(spec.doEmbeddingName);
    if ((implementationType && implementationType.toLowerCase() === "docomposition") || doEmbeddingName !== undefined) {
      throw new AbapError(
        "BAD_INPUT",
        `add_association${named} with implementationType "DoComposition" (or a doEmbeddingName) builds half of an embedding ` +
          `— the pair is the association plus a matching "<name>.ROOT" node, and BOPF silently discards a bare ` +
          `association written alone. Use embed_dependent_object instead.`,
        { operation, name, implementationType, doEmbeddingName },
      );
    }
    return;
  }
  if (operation === "add_node") {
    const doEmbeddingName = str(spec.doEmbeddingName);
    const isDependentObjectNode = spec.isDependentObjectNode === true;
    if (doEmbeddingName !== undefined || isDependentObjectNode) {
      throw new AbapError(
        "BAD_INPUT",
        `add_node${named} with doEmbeddingName set (or isDependentObjectNode: true) builds half of an embedding by hand — ` +
          `use embed_dependent_object instead, which writes both the association and the node together.`,
        { operation, name, doEmbeddingName, isDependentObjectNode },
      );
    }
    const hasParent = str(spec.parent) !== undefined || str(spec.parentNodeId) !== undefined;
    if (!hasParent && spec.rootNode !== true) {
      throw new AbapError(
        "BAD_INPUT",
        `add_node${named} with no spec.parent/spec.parentNodeId and rootNode not true is a deliberately parentless node ` +
          `— that is add_representative_node, not add_node. BOPF answers 200 and silently discards a node it cannot ` +
          `place, rather than rejecting it.`,
        { operation, name },
      );
    }
    return;
  }
}

/** Reads the represented BO / dependent object through the injected callback and checks it. No-op for the operations that need no other BO. */
export async function delegationNetworkPreflight(
  input: DelegationInput,
  readOtherModel: (bo: string) => Promise<BoModel>,
): Promise<void> {
  const spec = input.spec ?? {};
  if (input.operation === "add_representative_node") {
    const representedBo = str(spec.representedBo) ?? "";
    try {
      await readOtherModel(representedBo);
    } catch (e) {
      throw new AbapError(
        "BAD_INPUT",
        `add_representative_node: represented BO "${representedBo}" could not be read (${describeError(e)}) — the ` +
          `cross-BO association you add next would dangle against a BO that isn't there.`,
        { operation: input.operation, representedBo },
      );
    }
    return; // no category requirement — a representative node can stand in for any BO
  }
  if (input.operation === "embed_dependent_object") {
    const dependentObject = str(spec.dependentObject) ?? "";
    let model: BoModel;
    try {
      model = await readOtherModel(dependentObject);
    } catch (e) {
      throw new AbapError(
        "BAD_INPUT",
        `embed_dependent_object: dependent object "${dependentObject}" could not be read (${describeError(e)}).`,
        { operation: input.operation, dependentObject },
      );
    }
    if (model.objectCategory !== "dependentObject") {
      throw new AbapError(
        "BAD_INPUT",
        `embed_dependent_object: "${dependentObject}" has objectCategory "${model.objectCategory ?? "(none)"}", not ` +
          `"dependentObject" — only a BO created as a dependent object can be embedded this way.`,
        { operation: input.operation, dependentObject, objectCategory: model.objectCategory },
      );
    }
    return;
  }
  // remove_representative_node / remove_dependent_object need no other BO.
}

/** Zero-network checks against this BO's freshly re-read model. Throws BAD_INPUT / NOT_FOUND. */
export function delegationModelPreflight(model: BoModel, input: DelegationInput): void {
  switch (input.operation) {
    case "add_representative_node": {
      const name = requireInputName(input);
      if (findModelNode(model, name)) {
        throw new AbapError(
          "BAD_INPUT",
          `node "${name}" already exists on ${model.name} — BOPF answers 200 and silently discards a duplicate.`,
          { bo: model.name, node: name },
        );
      }
      return;
    }
    case "remove_representative_node": {
      const nodeName = requireInputNode(input);
      const node = findModelNode(model, nodeName);
      if (!node) {
        throw new AbapError(
          "NOT_FOUND",
          `node "${nodeName}" not found on ${model.name}. Nodes present: ${nodeNameList(model)}.`,
          { bo: model.name, node: nodeName },
        );
      }
      const kind = classifyNode(model, node);
      if (kind.kind !== "representative") {
        const pointer = kind.kind === "delegated" ? "remove_dependent_object" : "remove_node";
        throw new AbapError(
          "BAD_INPUT",
          `node "${node.name}" is classified as "${kind.kind}", not a representative node — use ${pointer} instead.`,
          { bo: model.name, node: node.name, kind: kind.kind },
        );
      }
      const offenders: string[] = [];
      for (const n of model.nodes) {
        for (const a of n.associations) {
          if ((resolveTargetNodeName(a.targetNodeRef) ?? "").toLowerCase() === node.name.toLowerCase()) {
            offenders.push(`${n.name}.${a.name}`);
          }
        }
      }
      if (offenders.length) {
        throw new AbapError(
          "BAD_INPUT",
          `association(s) still target node "${node.name}": ${offenders.join(", ")} — remove those first.`,
          { bo: model.name, node: node.name, offenders },
        );
      }
      return;
    }
    case "embed_dependent_object": {
      const nodeName = requireInputNode(input);
      const emb = requireInputName(input);
      const parent = findModelNode(model, nodeName);
      if (!parent) {
        throw new AbapError(
          "NOT_FOUND",
          `node "${nodeName}" not found on ${model.name}. Nodes present: ${nodeNameList(model)}.`,
          { bo: model.name, node: nodeName },
        );
      }
      if (parent.associations.some((a) => a.name.toLowerCase() === emb.toLowerCase())) {
        throw new AbapError(
          "BAD_INPUT",
          `association "${emb}" already exists on node "${parent.name}" — BOPF answers 200 and silently discards a duplicate.`,
          { bo: model.name, node: parent.name, name: emb },
        );
      }
      const embNodeName = `${emb}.ROOT`;
      if (findModelNode(model, embNodeName)) {
        throw new AbapError(
          "BAD_INPUT",
          `node "${embNodeName}" already exists on ${model.name} — BOPF answers 200 and silently discards a duplicate.`,
          { bo: model.name, node: embNodeName },
        );
      }
      return;
    }
    case "remove_dependent_object": {
      const nodeName = requireInputNode(input);
      const emb = requireInputName(input);
      const parent = findModelNode(model, nodeName);
      if (!parent) {
        throw new AbapError(
          "NOT_FOUND",
          `node "${nodeName}" not found on ${model.name}. Nodes present: ${nodeNameList(model)}.`,
          { bo: model.name, node: nodeName },
        );
      }
      const assoc = parent.associations.find((a) => a.name.toLowerCase() === emb.toLowerCase());
      if (!assoc) {
        throw new AbapError(
          "NOT_FOUND",
          `no association named "${emb}" on node "${parent.name}". Associations present: ` +
            `${parent.associations.map((a) => a.name).join(", ")}.`,
          { bo: model.name, node: parent.name, name: emb },
        );
      }
      if ((assoc.implementationType ?? "").toLowerCase() !== "docomposition") {
        throw new AbapError(
          "BAD_INPUT",
          `association "${emb}" on node "${parent.name}" has implementationType "${assoc.implementationType}", not ` +
            `DoComposition — this is not an embedding; use remove_association instead.`,
          { bo: model.name, node: parent.name, name: emb, implementationType: assoc.implementationType },
        );
      }
      const targetName = resolveTargetNodeName(assoc.targetNodeRef);
      if (!targetName) {
        throw new AbapError(
          "BAD_INPUT",
          `association "${emb}" on node "${parent.name}" has no resolvable targetNodeRef — cannot find the embedded node.`,
          { bo: model.name, node: parent.name, name: emb },
        );
      }
      const targetNode = findModelNode(model, targetName);
      if (!targetNode) {
        throw new AbapError(
          "NOT_FOUND",
          `embedded node "${targetName}" (named by association "${emb}"'s targetNodeRef) does not exist on ${model.name}.`,
          { bo: model.name, node: parent.name, name: emb, targetName },
        );
      }
      const kind = classifyNode(model, targetNode);
      if (kind.kind !== "delegated") {
        throw new AbapError(
          "BAD_INPUT",
          `node "${targetNode.name}" is classified as "${kind.kind}", not delegated — association "${emb}" does not ` +
            `look like a real embedding.`,
          { bo: model.name, node: targetNode.name, kind: kind.kind },
        );
      }
      const offenders: string[] = [];
      for (const n of model.nodes) {
        for (const a of n.associations) {
          if (n === parent && a.name.toLowerCase() === emb.toLowerCase()) continue;
          if ((resolveTargetNodeName(a.targetNodeRef) ?? "").toLowerCase() === targetNode.name.toLowerCase()) {
            offenders.push(`${n.name}.${a.name}`);
          }
        }
      }
      if (offenders.length) {
        throw new AbapError(
          "BAD_INPUT",
          `other association(s) still target node "${targetNode.name}": ${offenders.join(", ")} — remove those first.`,
          { bo: model.name, node: targetNode.name, offenders },
        );
      }
      return;
    }
  }
}

export interface DelegationSpliceDeps {
  /** `insertNodeAtRoot` from src/tools/bopf.ts — appends a new top-level `<bo:nodes>` after the last depth-1 element. */
  readonly insertNodeAtRoot: (xml: string, tokens: readonly Token[], fragment: string) => string;
}

function findDepth1Node(tokens: readonly Token[], name: string, nodeId: string | undefined): Token | undefined {
  return tokens.find(
    (t) =>
      t.name === "bo:nodes" &&
      t.depth === 1 &&
      t.attrs.get("bo:name") === name &&
      (nodeId === undefined || t.attrs.get("bo:nodeID") === nodeId),
  );
}

function mutateAddRepresentativeNode(freshXml: string, tokens: readonly Token[], input: DelegationInput, deps: DelegationSpliceDeps): string {
  const name = requireInputName(input);
  const spec = input.spec ?? {};
  const properties = ["KEY", "PARENT_KEY", "ROOT_KEY"].map((propName) =>
    renderProperty({
      name: propName,
      enabled: true,
      readonly: false,
      mandatory: false,
      enabledFinal: false,
      readonlyFinal: false,
      mandatoryFinal: false,
      transientAttribute: false,
    }),
  );
  const fields: NodeFields = {
    name,
    nodeId: mintGuid("node"),
    xmlName: str(spec.xmlName),
    objectModelGenerated: false,
    authorizationCheck: false,
    isExtensible: false,
    isDependentObjectNode: false,
    textNode: false,
    createEnabled: true,
    updateEnabled: true,
    deleteEnabled: true,
    rootNode: false,
    objectModelObsolete: false,
    properties,
  };
  return deps.insertNodeAtRoot(freshXml, tokens, renderNodeElement(fields));
}

function mutateRemoveRepresentativeNode(freshXml: string, tokens: readonly Token[], input: DelegationInput): string {
  const nodeName = requireInputNode(input);
  const range = locate(tokens, { node: nodeName, nodeId: input.nodeId });
  if (!range) {
    throw new AbapError("NOT_FOUND", `node "${nodeName}" not found while removing it.`, { node: nodeName });
  }
  return spliceOut(freshXml, range);
}

function mutateEmbedDependentObject(
  freshXml: string,
  tokens: readonly Token[],
  input: DelegationInput,
  deps: DelegationSpliceDeps,
): string {
  const parentName = requireInputNode(input);
  const emb = requireInputName(input);
  const spec = input.spec ?? {};

  const parentTok = findDepth1Node(tokens, parentName, input.nodeId);
  if (!parentTok) {
    throw new AbapError("NOT_FOUND", `parent node "${parentName}" not found while embedding "${emb}".`, {
      node: parentName,
    });
  }
  const parentNodeId = parentTok.attrs.get("bo:nodeID");
  if (!parentNodeId) {
    throw new AbapError(
      "BAD_INPUT",
      `parent node "${parentName}" has no bo:nodeID on the wire — the embedded node's bo:parentNodeID must be ` +
        `written together with it, and there is nothing to copy.`,
      { node: parentName },
    );
  }

  const xmlName = str(spec.xmlName);
  const embNodeName = `${emb}.ROOT`;
  const nodeFields: NodeFields = {
    name: embNodeName,
    nodeId: mintGuid("node"),
    parent: `#//bo:businessObject/bo:nodes[@bo:name='${parentName}']`,
    parentNodeId,
    xmlName,
    objectModelGenerated: false,
    authorizationCheck: false,
    isExtensible: false,
    isDependentObjectNode: false,
    textNode: false,
    createEnabled: false,
    updateEnabled: false,
    deleteEnabled: false,
    rootNode: false,
    objectModelObsolete: false,
  };
  let xml = deps.insertNodeAtRoot(freshXml, tokens, renderNodeElement(nodeFields));

  const tokens2 = scanModel(xml);
  const multiplicity = str(spec.multiplicity) ?? "0_1";
  const implementationClassRef = ref(spec.implementationClassRef) ?? DEFAULT_EMBED_IMPL_CLASS_REF;
  const targetUri =
    `/sap/bc/adt/bopf/businessobjects/${encodeURIComponent(input.bo.toLowerCase()).toLowerCase()}` +
    `#//bo:businessObject/bo:nodes[@bo:name='${embNodeName}']`;
  const assocFields: AssociationFields = {
    name: emb,
    nodeId: mintGuid("association"),
    implementationType: "DoComposition",
    objectModelGenerated: false,
    xmlName,
    doEmbeddingName: emb,
    multiplicity,
    targetNodeRef: { uri: targetUri, type: "BOBF", name: `${input.bo.toUpperCase()}~${embNodeName}` },
    implementationClassRef,
  };
  xml = spliceInsertChild(xml, tokens2, parentName, "association", renderAssociationElement(assocFields), {
    nodeId: input.nodeId,
  });
  return xml;
}

function mutateRemoveDependentObject(freshXml: string, tokens: readonly Token[], input: DelegationInput): string {
  const parentName = requireInputNode(input);
  const emb = requireInputName(input);

  const assocRange = locate(tokens, { node: parentName, nodeId: input.nodeId, child: "association", name: emb });
  if (!assocRange) {
    throw new AbapError(
      "NOT_FOUND",
      `association "${emb}" not found on node "${parentName}" while removing the embedding.`,
      { node: parentName, name: emb },
    );
  }
  const targetRefTok = tokens.find(
    (t) => t.name === "bo:targetNodeRef" && t.openStart > assocRange.start && t.openStart < assocRange.end,
  );
  const embNodeName = resolveTargetNodeName(
    targetRefTok
      ? { uri: targetRefTok.attrs.get("adtcore:uri"), type: "", name: targetRefTok.attrs.get("adtcore:name") ?? "" }
      : undefined,
  );
  if (!embNodeName) {
    throw new AbapError(
      "NOT_FOUND",
      `association "${emb}" on node "${parentName}" has no resolvable targetNodeRef — cannot find the embedded node to remove.`,
      { node: parentName, name: emb },
    );
  }

  let xml = spliceOut(freshXml, assocRange);
  const tokens2 = scanModel(xml);
  const nodeRange = locate(tokens2, { node: embNodeName });
  if (!nodeRange) {
    throw new AbapError(
      "NOT_FOUND",
      `embedded node "${embNodeName}" not found after removing association "${emb}" from "${parentName}".`,
      { node: embNodeName, association: emb },
    );
  }
  xml = spliceOut(xml, nodeRange);
  return xml;
}

/** Applies one delegation operation to freshly re-read bytes. Pure. */
export function mutateDelegation(freshXml: string, input: DelegationInput, deps: DelegationSpliceDeps): string {
  const tokens = scanModel(freshXml);
  switch (input.operation) {
    case "add_representative_node":
      return mutateAddRepresentativeNode(freshXml, tokens, input, deps);
    case "remove_representative_node":
      return mutateRemoveRepresentativeNode(freshXml, tokens, input);
    case "embed_dependent_object":
      return mutateEmbedDependentObject(freshXml, tokens, input, deps);
    case "remove_dependent_object":
      return mutateRemoveDependentObject(freshXml, tokens, input);
    default:
      throw new AbapError("UNSUPPORTED", `"${input.operation}" is not a delegation operation.`, {
        operation: input.operation,
      });
  }
}

function countNodesNamed(model: BoModel, name: string): number {
  const wanted = name.toLowerCase();
  return model.nodes.filter((n) => n.name.toLowerCase() === wanted).length;
}

function countAssociationsNamed(model: BoModel, nodeName: string, assocName: string): number {
  const wantedNode = nodeName.toLowerCase();
  const wantedAssoc = assocName.toLowerCase();
  return model.nodes
    .filter((n) => n.name.toLowerCase() === wantedNode)
    .flatMap((n) => n.associations)
    .filter((a) => a.name.toLowerCase() === wantedAssoc).length;
}

const HOUSE_SENTENCE = "A BOPF PUT answers 200 whether or not the server kept what was sent, and nothing was activated.";

/** Post-write re-read verification. Throws AbapError CHECK_FAILED in the house wording. */
export function verifyDelegation(
  input: DelegationInput,
  before: BoModel,
  after: BoModel,
  journalEntryId: string | undefined,
): void {
  const entryId = journalEntryId ?? "(none)";
  switch (input.operation) {
    case "add_representative_node": {
      const name = input.name ?? "";
      const countBefore = countNodesNamed(before, name);
      const countAfter = countNodesNamed(after, name);
      if (countAfter <= countBefore) {
        throw new AbapError(
          "CHECK_FAILED",
          `add_representative_node "${name}" on ${before.name}: the PUT was accepted (journalEntryId ${entryId}) ` +
            `but a fresh re-read shows ${countAfter} node(s) named "${name}" after the write, versus ${countBefore} ` +
            `before — the node was not actually added. ${HOUSE_SENTENCE}`,
          { bo: before.name, node: name, countBefore, countAfter, journalEntryId },
        );
      }
      return;
    }
    case "remove_representative_node": {
      const name = input.node ?? "";
      const countBefore = countNodesNamed(before, name);
      const countAfter = countNodesNamed(after, name);
      if (countAfter >= countBefore) {
        throw new AbapError(
          "CHECK_FAILED",
          `remove_representative_node "${name}" on ${before.name}: the PUT was accepted (journalEntryId ${entryId}) ` +
            `but a fresh re-read shows ${countAfter} node(s) named "${name}" after the write, versus ${countBefore} ` +
            `before — the node was not actually removed. ${HOUSE_SENTENCE}`,
          { bo: before.name, node: name, countBefore, countAfter, journalEntryId },
        );
      }
      return;
    }
    case "embed_dependent_object": {
      const parent = input.node ?? "";
      const emb = input.name ?? "";
      const embNodeName = `${emb}.ROOT`;
      const nodeCountBefore = countNodesNamed(before, embNodeName);
      const nodeCountAfter = countNodesNamed(after, embNodeName);
      const assocCountBefore = countAssociationsNamed(before, parent, emb);
      const assocCountAfter = countAssociationsNamed(after, parent, emb);
      const nodeMissing = nodeCountAfter <= nodeCountBefore;
      const assocMissing = assocCountAfter <= assocCountBefore;
      if (nodeMissing || assocMissing) {
        const missing = [
          nodeMissing ? `the "${embNodeName}" node` : undefined,
          assocMissing ? `the "${emb}" association on "${parent}"` : undefined,
        ]
          .filter((x): x is string => x !== undefined)
          .join(" and ");
        throw new AbapError(
          "CHECK_FAILED",
          `embed_dependent_object "${emb}" on ${before.name} node "${parent}": the PUT was accepted ` +
            `(journalEntryId ${entryId}) but a fresh re-read shows ${missing} did not land — node count ` +
            `${nodeCountBefore} -> ${nodeCountAfter}, association count ${assocCountBefore} -> ${assocCountAfter}. ${HOUSE_SENTENCE}`,
          { bo: before.name, node: parent, name: emb, nodeCountBefore, nodeCountAfter, assocCountBefore, assocCountAfter, journalEntryId },
        );
      }
      return;
    }
    case "remove_dependent_object": {
      const parent = input.node ?? "";
      const emb = input.name ?? "";
      const beforeParent = findModelNode(before, parent);
      const beforeAssoc = beforeParent?.associations.find((a) => a.name.toLowerCase() === emb.toLowerCase());
      const embNodeName = (beforeAssoc ? resolveTargetNodeName(beforeAssoc.targetNodeRef) : undefined) ?? `${emb}.ROOT`;
      const nodeCountBefore = countNodesNamed(before, embNodeName);
      const nodeCountAfter = countNodesNamed(after, embNodeName);
      const assocCountBefore = countAssociationsNamed(before, parent, emb);
      const assocCountAfter = countAssociationsNamed(after, parent, emb);
      const nodeRemains = nodeCountAfter >= nodeCountBefore;
      const assocRemains = assocCountAfter >= assocCountBefore;
      if (nodeRemains || assocRemains) {
        const remaining = [
          assocRemains ? `the "${emb}" association on "${parent}"` : undefined,
          nodeRemains ? `the "${embNodeName}" node` : undefined,
        ]
          .filter((x): x is string => x !== undefined)
          .join(" and ");
        throw new AbapError(
          "CHECK_FAILED",
          `remove_dependent_object "${emb}" on ${before.name} node "${parent}": the PUT was accepted ` +
            `(journalEntryId ${entryId}) but a fresh re-read shows ${remaining} still present — node count ` +
            `${nodeCountBefore} -> ${nodeCountAfter}, association count ${assocCountBefore} -> ${assocCountAfter}. ${HOUSE_SENTENCE}`,
          { bo: before.name, node: parent, name: emb, nodeCountBefore, nodeCountAfter, assocCountBefore, assocCountAfter, journalEntryId },
        );
      }
      return;
    }
  }
}

/** Response notes for the operation. Never empty for embed_dependent_object / add_representative_node. */
export function delegationNotes(input: DelegationInput): readonly string[] {
  const spec = input.spec ?? {};
  switch (input.operation) {
    case "add_representative_node": {
      const representedBo = str(spec.representedBo) ?? "<REPRESENTED_BO>";
      return [
        `The wire carries no link from a representative node to the BO it represents — "${representedBo}" was ` +
          `checked for existence and deliberately NOT written to the node. Add the cross-BO association yourself: ` +
          `abap_bopf_edit add_association on the node that should carry the link, with spec.implementationType: ` +
          `"Association" and spec.targetNodeRef: { name: "${representedBo}~ROOT", type: "BOBF" }. Observed captures ` +
          `of real cross-BO associations also carry a spec.implementationClassRef (e.g. ` +
          `/BOBF/CL_C_DEMO_CUSTOMER_XBO for /BOBF/DEMO_CUSTOMER~ROOT) — BOPF may require one too.`,
      ];
    }
    case "embed_dependent_object": {
      const dependentObject = str(spec.dependentObject) ?? "<DEPENDENT_OBJECT>";
      return [
        `The host BO's XML never names the dependent object anywhere, so a 200 plus a read-back showing the ` +
          `association/node pair does NOT prove the dependent object is really embedded. spec.dependentObject ` +
          `("${dependentObject}") was checked to exist and to have objectCategory "dependentObject" but is ` +
          `deliberately not written to the wire — activation and a runtime check are the only way to confirm the ` +
          `embedding actually works.`,
      ];
    }
    default:
      return [];
  }
}
