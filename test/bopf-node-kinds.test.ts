/**
 * `src/adt/bopf-node-kinds.ts` — node/association classification against the
 * real captured `/BOBF/DEMO_SALES_ORDER` fixture, plus the `check_refs`
 * false-alarm fix it feeds in `src/adt/bopf.ts`'s `evaluateTargetNodeRef`.
 *
 * The fixture is the pin for every classification assertion below — no
 * hand-built XML for those cases.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseModel } from "../src/adt/bopf-xml.js";
import { checkReferences, collectRefSites } from "../src/adt/bopf.js";
import {
  splitTargetNodeRef,
  isCrossBoTarget,
  classifyAssociation,
  classifyNodes,
  classifyNode,
  describeNodeKind,
  describeAssociationKind,
  type NodeKind,
  type AssociationKind,
} from "../src/adt/bopf-node-kinds.js";
import type { BoAssociation } from "../src/adt/bopf-types.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { FakeAdtServer, __resetFakeAdtCounters } from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import type { FakeRoute } from "./helpers/fake-adt.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const FX_SALES_ORDER = readFileSync(join(FIXTURES, "01-get-demo_sales_order.v4.xml"), "utf8");

const model = parseModel(FX_SALES_ORDER);
const node = (name: string) => {
  const n = model.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`fixture has no node ${name}`);
  return n;
};

describe("classifyNodes — node kinds off the real /BOBF/DEMO_SALES_ORDER fixture", () => {
  const kinds = classifyNodes(model);

  it("ROOT is root", () => {
    expect(kinds.get("root")?.kind).toBe("root");
  });

  it("ITEM, ROOT_TEXT, ITEM_TEXT are standard", () => {
    expect(kinds.get("item")?.kind).toBe("standard");
    expect(kinds.get("root_text")?.kind).toBe("standard");
    expect(kinds.get("item_text")?.kind).toBe("standard");
  });

  it("ROOT_LONG_TEXT.ROOT is delegated, embedded by ROOT_LONG_TEXT on ROOT, with no dependent object named", () => {
    const k = kinds.get("root_long_text.root");
    expect(k?.kind).toBe("delegated");
    expect(k?.embeddingAssociation).toBe("ROOT_LONG_TEXT");
    expect(k?.embeddingParent).toBe("ROOT");
    expect(k?.doEmbeddingName).toBe("ROOT_LONG_TEXT");
    // The host XML never names the dependent object anywhere on this pair.
    expect(k?.dependentObject).toBeUndefined();
  });

  it("ITEM_LONG_TEXT.ROOT is delegated, embedded on ITEM", () => {
    const k = kinds.get("item_long_text.root");
    expect(k?.kind).toBe("delegated");
    expect(k?.embeddingAssociation).toBe("ITEM_LONG_TEXT");
    expect(k?.embeddingParent).toBe("ITEM");
  });

  it("CUSTOMER_BO and PRODUCT_BO are representative", () => {
    expect(kinds.get("customer_bo")?.kind).toBe("representative");
    expect(kinds.get("product_bo")?.kind).toBe("representative");
  });

  it("classifyNode agrees with classifyNodes for a single lookup", () => {
    expect(classifyNode(model, node("ROOT")).kind).toBe("root");
    expect(classifyNode(model, node("CUSTOMER_BO")).kind).toBe("representative");
  });
});

describe("corroborating wire facts on the fixture (not classification gates)", () => {
  it("both delegated nodes are non-CUD, not flagged isDependentObjectNode, and carry no persistentStructureRef", () => {
    for (const name of ["ROOT_LONG_TEXT.ROOT", "ITEM_LONG_TEXT.ROOT"]) {
      const n = node(name);
      expect(n.createEnabled).toBe(false);
      expect(n.updateEnabled).toBe(false);
      expect(n.deleteEnabled).toBe(false);
      expect(n.isDependentObjectNode).toBe(false);
      expect(n.persistentStructureRef).toBeUndefined();
    }
  });

  it("both representative nodes have no parent, no persistentStructureRef, and exactly KEY/PARENT_KEY/ROOT_KEY properties", () => {
    for (const name of ["CUSTOMER_BO", "PRODUCT_BO"]) {
      const n = node(name);
      expect(n.parent).toBeUndefined();
      expect(n.persistentStructureRef).toBeUndefined();
      expect(n.properties.map((p) => p.name)).toEqual(["KEY", "PARENT_KEY", "ROOT_KEY"]);
    }
  });
});

describe("classifyAssociation", () => {
  const assocOn = (nodeName: string, assocName: string) => {
    const a = node(nodeName).associations.find((x) => x.name === assocName);
    if (!a) throw new Error(`fixture node ${nodeName} has no association ${assocName}`);
    return a;
  };

  it("ROOT_LONG_TEXT (DoComposition) classifies do-composition", () => {
    expect(classifyAssociation(model, assocOn("ROOT", "ROOT_LONG_TEXT")).kind).toBe("do-composition");
  });

  it("ITEM (ROOT's composition to ITEM) classifies composition", () => {
    expect(classifyAssociation(model, assocOn("ROOT", "ITEM")).kind).toBe("composition");
  });

  it("CUSTOMER_ROOT classifies cross-bo, targeting /BOBF/DEMO_CUSTOMER~ROOT", () => {
    const k = classifyAssociation(model, assocOn("ROOT", "CUSTOMER_ROOT"));
    expect(k.kind).toBe("cross-bo");
    expect(k.targetBo).toBe("/BOBF/DEMO_CUSTOMER");
    expect(k.targetNode).toBe("ROOT");
  });

  it("implementationType 'C' is not mapped to composition — [SCHEMA]-only value, never seen on the wire", () => {
    const sameBoAssoc: BoAssociation = { name: "X", implementationType: "C", targetNodeRef: { type: "BOBF", name: "ITEM" } };
    expect(classifyAssociation(model, sameBoAssoc).kind).toBe("association");

    const crossBoAssoc: BoAssociation = {
      name: "Y",
      implementationType: "C",
      targetNodeRef: { type: "BOBF", name: "/BOBF/DEMO_CUSTOMER~ROOT" },
    };
    const k = classifyAssociation(model, crossBoAssoc);
    expect(k.kind).toBe("cross-bo");
    expect(k.targetBo).toBe("/BOBF/DEMO_CUSTOMER");
  });

  it("a DoComposition targeting another BO still reports do-composition and carries targetBo", () => {
    const assoc: BoAssociation = {
      name: "EMB",
      implementationType: "DoComposition",
      targetNodeRef: { type: "BOBF", name: "/BOBF/DEMO_CUSTOMER~ROOT" },
    };
    const k = classifyAssociation(model, assoc);
    expect(k.kind).toBe("do-composition");
    expect(k.targetBo).toBe("/BOBF/DEMO_CUSTOMER");
    expect(k.targetNode).toBe("ROOT");
  });
});

describe("splitTargetNodeRef", () => {
  it("undefined and empty string yield {}", () => {
    expect(splitTargetNodeRef(undefined)).toEqual({});
    expect(splitTargetNodeRef("")).toEqual({});
  });

  it("no ~ yields { node: name }", () => {
    expect(splitTargetNodeRef("ROOT")).toEqual({ node: "ROOT" });
  });

  it("splits on the last ~", () => {
    expect(splitTargetNodeRef("/BOBF/DEMO_CUSTOMER~ROOT")).toEqual({
      bo: "/BOBF/DEMO_CUSTOMER",
      node: "ROOT",
    });
  });
});

describe("isCrossBoTarget", () => {
  it("true only when the BO half differs from the host, case-insensitively", () => {
    expect(isCrossBoTarget(model, "/BOBF/DEMO_CUSTOMER~ROOT")).toBe(true);
    expect(isCrossBoTarget(model, `${model.name}~ROOT`)).toBe(false);
    expect(isCrossBoTarget(model, model.name.toLowerCase() + "~ROOT")).toBe(false);
    expect(isCrossBoTarget(model, "ROOT")).toBe(false);
    expect(isCrossBoTarget(model, undefined)).toBe(false);
  });
});

describe("describeNodeKind", () => {
  const cases: Array<[string, NodeKind, string]> = [
    ["root", { kind: "root" }, "root"],
    ["standard", { kind: "standard" }, ""],
    ["representative", { kind: "representative" }, "representative"],
    [
      "delegated, no dependent object",
      { kind: "delegated", embeddingParent: "ROOT", embeddingAssociation: "ROOT_LONG_TEXT" },
      "delegated via ROOT.ROOT_LONG_TEXT",
    ],
    [
      "delegated, with dependent object",
      {
        kind: "delegated",
        embeddingParent: "ROOT",
        embeddingAssociation: "EMB",
        dependentObject: "/BOBF/DEMO_CUSTOMER",
      },
      "delegated via ROOT.EMB -> /BOBF/DEMO_CUSTOMER",
    ],
  ];

  it.each(cases)("%s", (_label, k, expected) => {
    expect(describeNodeKind(k)).toBe(expected);
  });
});

describe("describeAssociationKind", () => {
  const cases: Array<[string, AssociationKind, string]> = [
    ["association", { kind: "association" }, ""],
    ["composition", { kind: "composition" }, "composition"],
    ["do-composition", { kind: "do-composition" }, "do-composition"],
    [
      "cross-bo with targetBo and targetNode",
      { kind: "cross-bo", targetBo: "/BOBF/DEMO_CUSTOMER", targetNode: "ROOT" },
      "-> /BOBF/DEMO_CUSTOMER~ROOT",
    ],
    ["cross-bo with targetBo only", { kind: "cross-bo", targetBo: "/BOBF/DEMO_CUSTOMER" }, "-> /BOBF/DEMO_CUSTOMER"],
    ["cross-bo with neither", { kind: "cross-bo" }, ""],
  ];

  it.each(cases)("%s", (_label, k, expected) => {
    expect(describeAssociationKind(k)).toBe(expected);
  });
});

// --------------------------------------------------------------- check_refs ---

/**
 * Same harness idiom as `test/bopf-client.test.ts`'s `wired()`: a real
 * `AbapConnection` over a `FakeAdtServer` socket. The cross-BO targetNodeRef
 * site never needs HTTP (evaluateTargetNodeRef returns before any request),
 * so zero routes beyond the login/system-role probe are wired.
 */
const systemRoleRoute: FakeRoute = (r) =>
  r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined;

const cfg = (): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
  });

const openConnections: AbapConnection[] = [];

beforeEach(() => {
  __resetFakeAdtCounters();
});

afterEach(() => {
  for (const conn of openConnections.splice(0)) conn.dispose();
});

async function wired(): Promise<{ conn: AbapConnection }> {
  const server = new FakeAdtServer({ transportErrors: "throw", routes: [systemRoleRoute] });
  const client = server.client("s1");
  const conn = new AbapConnection(cfg(), {
    httpClient: client,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  openConnections.push(conn);
  await conn.connect();
  return { conn };
}

describe("check_refs: cross-BO targetNodeRef is unchecked, not a false 'missing'", () => {
  it("collectRefSites finds the CUSTOMER_ROOT site and isCrossBoTarget agrees it is cross-BO", () => {
    const sites = collectRefSites(model);
    const site = sites.find((s) => s.element === "targetNodeRef" && s.member === "CUSTOMER_ROOT");
    expect(site).toBeDefined();
    expect(isCrossBoTarget(model, site!.ref.name)).toBe(true);
  });

  it("checkReferences reports unchecked (not missing) for CUSTOMER_ROOT's targetNodeRef", async () => {
    const { conn } = await wired();
    const findings = await checkReferences(conn, model);
    const finding = findings.find((f) => f.site.element === "targetNodeRef" && f.site.member === "CUSTOMER_ROOT");
    expect(finding).toBeDefined();
    expect(finding?.verdict).toBe("unchecked");
    expect(finding?.detail).toContain("/BOBF/DEMO_CUSTOMER");
  });

  it("same-BO targetNodeRefs are unaffected — TO_ROOT on ITEM still resolves present with zero routes", async () => {
    const { conn } = await wired();
    const findings = await checkReferences(conn, model);
    const sameBo = findings.filter(
      (f) => f.site.element === "targetNodeRef" && !isCrossBoTarget(model, f.site.ref.name),
    );
    expect(sameBo.length).toBeGreaterThan(0);
    expect(sameBo.every((f) => f.verdict === "present")).toBe(true);
  });
});
