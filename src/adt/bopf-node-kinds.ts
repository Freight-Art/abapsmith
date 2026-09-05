/**
 * Pure classification of a parsed `BoModel`'s nodes and associations — no network.
 * `src/adt/bopf.ts`'s `checkReferences` uses `isCrossBoTarget` so a cross-BO association is not reported as dangling.
 */
import type { BoModel, BoNode, BoAssociation } from "./bopf-types.js";

export type BoNodeKind = "root" | "standard" | "delegated" | "representative";
export type BoAssociationKind = "composition" | "do-composition" | "cross-bo" | "association";

export interface NodeKind {
  readonly kind: BoNodeKind;
  /** delegated: name of the DoComposition association that targets this node. */
  readonly embeddingAssociation?: string;
  /** delegated: the node carrying that association. */
  readonly embeddingParent?: string;
  /** delegated: `bo:doEmbeddingName` off that association, when it carries one. */
  readonly doEmbeddingName?: string;
  /** delegated: the dependent object, when a ref on the pair names a BO other than the host. The host XML normally does not name one. */
  readonly dependentObject?: string;
}

export interface AssociationKind {
  readonly kind: BoAssociationKind;
  /** cross-bo: the BO named left of `~` on targetNodeRef. */
  readonly targetBo?: string;
  /** the node named right of `~`, or the bare name when there is no `~`. */
  readonly targetNode?: string;
}

/** Split on the LAST `~` — matches `resolveTargetNodeName`'s bare-name resolution in src/tools/bopf.ts. */
export function splitTargetNodeRef(name: string | undefined): { bo?: string; node?: string } {
  if (!name) return {};
  const tilde = name.lastIndexOf("~");
  if (tilde < 0) return { node: name };
  return { bo: name.slice(0, tilde), node: name.slice(tilde + 1) };
}

export function isCrossBoTarget(model: BoModel, name: string | undefined): boolean {
  const { bo } = splitTargetNodeRef(name);
  return bo !== undefined && bo.toLowerCase() !== model.name.toLowerCase();
}

export function classifyAssociation(model: BoModel, assoc: BoAssociation): AssociationKind {
  const targetName = assoc.targetNodeRef?.name;
  const { bo: targetBo, node: targetNode } = splitTargetNodeRef(targetName);
  const type = (assoc.implementationType ?? "").toLowerCase();

  const crossBo = isCrossBoTarget(model, targetName);
  const bo = crossBo ? targetBo : undefined;

  if (type === "docomposition") return { kind: "do-composition", targetBo: bo, targetNode };
  if (type === "composition") return { kind: "composition", targetBo: bo, targetNode };
  if (crossBo) return { kind: "cross-bo", targetBo, targetNode };
  return { kind: "association", targetNode };
}

/** Keyed by node name, lower-cased. One pass over the model. */
export function classifyNodes(model: BoModel): ReadonlyMap<string, NodeKind> {
  const embeddings = new Map<string, { assoc: BoAssociation; parent: BoNode; dependentObject?: string }>();
  for (const parent of model.nodes) {
    for (const assoc of parent.associations) {
      const kind = classifyAssociation(model, assoc);
      if (kind.kind !== "do-composition" || !kind.targetNode) continue;
      const targetRef = splitTargetNodeRef(assoc.targetNodeRef?.name);
      const dependentObject =
        targetRef.bo && targetRef.bo.toLowerCase() !== model.name.toLowerCase() ? targetRef.bo : undefined;
      embeddings.set(kind.targetNode.toLowerCase(), { assoc, parent, dependentObject });
    }
  }

  const result = new Map<string, NodeKind>();
  for (const node of model.nodes) {
    const key = node.name.toLowerCase();
    if (node.rootNode === true) {
      result.set(key, { kind: "root" });
      continue;
    }
    const embedding = embeddings.get(key);
    if (embedding) {
      // The DoComposition link alone is necessary and sufficient; the dotted name, missing structure ref, and parent are consequences, not requirements.
      result.set(key, {
        kind: "delegated",
        embeddingAssociation: embedding.assoc.name,
        embeddingParent: embedding.parent.name,
        ...(embedding.assoc.doEmbeddingName ? { doEmbeddingName: embedding.assoc.doEmbeddingName } : {}),
        ...(embedding.dependentObject ? { dependentObject: embedding.dependentObject } : {}),
      });
      continue;
    }
    if (!node.parent && !node.persistentStructureRef) {
      result.set(key, { kind: "representative" });
      continue;
    }
    result.set(key, { kind: "standard" });
  }
  return result;
}

/** Digest suffix, no parentheses; caller appends `" (" + s + ")"` only when non-empty. */
export function describeNodeKind(k: NodeKind): string {
  switch (k.kind) {
    case "root":
      return "root";
    case "standard":
      return "";
    case "representative":
      return "representative";
    case "delegated": {
      const base = `delegated via ${k.embeddingParent}.${k.embeddingAssociation}`;
      return k.dependentObject ? `${base} -> ${k.dependentObject}` : base;
    }
  }
}

/** Short digest marker, no parentheses; caller wraps as needed. */
export function describeAssociationKind(k: AssociationKind): string {
  switch (k.kind) {
    case "association":
      return "";
    case "composition":
      return "composition";
    case "do-composition":
      return "do-composition";
    case "cross-bo":
      if (!k.targetBo) return "";
      return k.targetNode ? `-> ${k.targetBo}~${k.targetNode}` : `-> ${k.targetBo}`;
  }
}

/** Single node; O(model). Use classifyNodes for a whole digest. */
export function classifyNode(model: BoModel, node: BoNode): NodeKind {
  return classifyNodes(model).get(node.name.toLowerCase()) ?? { kind: "standard" };
}
