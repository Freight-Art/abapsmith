/**
 * BOPF "delegation" operations. Originally this module held four operations
 * (`add_representative_node`, `remove_representative_node`,
 * `embed_dependent_object`, `remove_dependent_object`); a live discovery run
 * against a real SAP system proved three of them describe writes the BOPF
 * ADT endpoint cannot perform — a client-written parentless node is
 * hard-rejected by the /BOBF/ST_CONF_ADT deserializer, representative nodes
 * are minted by the server itself (named REP_<random>) in response to a
 * cross-BO association, and the embedding wire shape is silently rewritten
 * server-side with no known working request. See
 * `doc/CAPABILITIES/bopf.md` for the evidence. Only `remove_dependent_object`
 * survives, plus the refusals in `refuseHandAssembledDelegation` that stop a
 * caller hand-assembling a delegation the endpoint cannot accept.
 */
import { AbapError } from "../adt/errors.js";
import type { BoModel, BoNode, AdtObjectRef } from "../adt/bopf-types.js";
import { scanModel, locate, spliceOut, type Token } from "../adt/bopf-xml.js";
import { classifyNode } from "../adt/bopf-node-kinds.js";

export const DELEGATION_OPERATIONS = ["remove_dependent_object"] as const;
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

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
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

/** Zero-network shape check for the one surviving operation. Throws AbapError BAD_INPUT. */
export function validateDelegationShape(input: DelegationInput): void {
  switch (input.operation) {
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
        `add_association${named} with implementationType "DoComposition" (or a doEmbeddingName) tries to build a ` +
          `dependent-object embedding, and abapsmith cannot create one on this release. That shape was sent to a ` +
          `real system: the PUT answered 200, but the read-back had implementationType rewritten to "Composition" ` +
          `with bo:doEmbeddingName dropped, and activation rejected the "<name>.ROOT" node the pair needs ("Node ` +
          `name contains characters that are not allowed"). No working request shape is known — see ` +
          `doc/CAPABILITIES/bopf.md. remove_dependent_object still removes an embedding that already exists.`,
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
        `add_node${named} with doEmbeddingName set (or isDependentObjectNode: true) builds half of a dependent-object ` +
          `embedding by hand. abapsmith cannot create an embedding on this release, and the other half cannot be ` +
          `written either — see doc/CAPABILITIES/bopf.md.`,
        { operation, name, doEmbeddingName, isDependentObjectNode },
      );
    }
    const hasParent = str(spec.parent) !== undefined || str(spec.parentNodeId) !== undefined;
    if (!hasParent && spec.rootNode !== true) {
      throw new AbapError(
        "BAD_INPUT",
        `add_node${named} with no spec.parent/spec.parentNodeId and rootNode not true is a deliberately parentless ` +
          `node, and BOPF will not accept one: the server rejects a client-written parentless node outright in the ` +
          `/BOBF/ST_CONF_ADT deserializer. Parentless "representative" nodes do exist, but the server mints them ` +
          `itself — add a cross-BO association instead (add_association with spec.targetNodeRef naming ` +
          `OTHER_BO~ROOT and a spec.implementationClassRef), and the server creates a node named REP_<random> ` +
          `alongside it.`,
        { operation, name },
      );
    }
    return;
  }
}

/** Zero-network checks against this BO's freshly re-read model. Throws BAD_INPUT / NOT_FOUND. */
export function delegationModelPreflight(model: BoModel, input: DelegationInput): void {
  switch (input.operation) {
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
export function mutateDelegation(freshXml: string, input: DelegationInput): string {
  const tokens = scanModel(freshXml);
  switch (input.operation) {
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

/** Response notes for the operation: [] for remove_dependent_object, two notes for a cross-BO add_association. */
export function delegationNotes(input: DelegationInput): readonly string[] {
  const spec = input.spec ?? {};
  if (input.operation === "add_association") {
    const targetRef = spec.targetNodeRef;
    let targetName: string | undefined;
    let targetBo: string | undefined;
    if (targetRef && typeof targetRef === "object") {
      const o = targetRef as Record<string, unknown>;
      const name = str(o.name);
      if (name && name.includes("~")) {
        targetName = name;
        targetBo = name.slice(0, name.indexOf("~"));
      } else {
        const uri = str(o.uri);
        if (uri) {
          const hashIdx = uri.indexOf("#");
          const beforeHash = hashIdx >= 0 ? uri.slice(0, hashIdx) : uri;
          const segments = beforeHash.split("/").filter(Boolean);
          targetBo = segments[segments.length - 1];
          targetName = name ?? targetBo;
        }
      }
    }
    if (targetBo && targetBo.toLowerCase() !== input.bo.toLowerCase()) {
      return [
        `Cross-BO association: targetNodeRef names "${targetName}", a node on another business object. Observed on ` +
          `this release: the server answers such a write by minting a representative node of its own, named ` +
          `REP_<random> — the name is server-assigned and cannot be chosen, and a client-written parentless node is ` +
          `rejected outright by the /BOBF/ST_CONF_ADT deserializer. Confirmed live: running remove_association on ` +
          `this cross-BO association removes the minted node too — abap_bopf show's nodeCount fell from 2 to 1 ` +
          `and the node was gone from the read-back.`,
        `Cross-BO associations captured from SAP's own business objects also carry an implementationClassRef (an ` +
          `XBO class such as /BOBF/CL_C_DEMO_CUSTOMER_XBO); without one, activation reported "Association has to ` +
          `have exactly one Attribute Binding". Observed once on this release: activating a business object with a ` +
          `cross-BO association present destroyed the ABAP session with an ASSERTION_FAILED short dump in ` +
          `/BOBF/CL_CONF_MODEL_API_MAP. Neither behaviour is established as a rule.`,
      ];
    }
    return [];
  }
  return [];
}
