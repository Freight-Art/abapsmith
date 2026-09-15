/**
 * `view="lineage"` (issue #106) — `src/adt/cds-lineage.ts`: `parseDdl`
 * (pure DDL parser, over live captures 976-980) and `buildLineage`/
 * `renderLineage` (the async walk and its rendering).
 *
 * `resolveObject` is mocked per-name (a Map keyed by uppercased object
 * name) so the multi-hop test can walk 976 -> 977 -> its base table
 * without needing every association target resolvable; anything not in
 * the map safely resolves as NOT_FOUND, which buildLineage's own
 * try/catch turns into a "not found: ..." leaf rather than a crash.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import { isAbapError } from "../src/adt/errors.js";
import { parseDdl } from "../src/adt/cds-lineage.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const read = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

const SRC_976 = read("976-i106-ddl-zdemo-c-salesorder-tp-d.txt");
const SRC_977 = read("977-i106-ddl-zdemo-i-salesorder-tp-d.txt");
const SRC_978 = read("978-i106-ddl-ars-software-components-scp-vh.txt");
const SRC_979 = read("979-i106-ddl-ars-swc-cust-snapshot-relevant.txt");
const SRC_980 = read("980-i106-ddl-ars-v-flp-swc-vh.txt");

const resolveMap = new Map<string, ResolvedObject>();

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async (_conn: unknown, name: string) => {
    const hit = resolveMap.get(name.toUpperCase());
    if (!hit) {
      const { AbapError } = await import("../src/adt/errors.js");
      throw new AbapError("NOT_FOUND", `${name} not found (test stub)`, { name });
    }
    return hit;
  },
}));

const { buildLineage, renderLineage, LINEAGE_MAX_DEPTH } = await import("../src/adt/cds-lineage.js");

function ddlsObj(name: string, sourceUri: string): ResolvedObject {
  return {
    system: "A4H",
    type: "DDLS/DF",
    kind: "DDLS",
    label: "CDS view",
    name,
    uri: `/sap/bc/adt/ddic/ddl/sources/${name.toLowerCase()}`,
    sourceUri,
    mode: "source",
    activation: "unknown",
    spec: {},
  } as unknown as ResolvedObject;
}

function tableObj(name: string): ResolvedObject {
  return {
    system: "A4H",
    type: "TABL/DT",
    kind: "TABL",
    label: "table",
    name,
    uri: `/sap/bc/adt/ddic/tables/${name.toLowerCase()}`,
    mode: "ddic",
    activation: "unknown",
    spec: {},
  } as unknown as ResolvedObject;
}

async function catchAbapAsync(p: Promise<unknown>): Promise<import("../src/adt/errors.js").AbapError> {
  try {
    await p;
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected an AbapError, but the call resolved normally");
}

beforeEach(() => {
  resolveMap.clear();
});

describe("parseDdl over live captures 976-980", () => {
  it("976: data source ZDEMO_I_SalesOrder_TP_D aliased SalesOrder, one selected association _Item, one key field", () => {
    const parsed = parseDdl(SRC_976);
    expect(parsed.name).toBe("ZDEMO_C_SalesOrder_TP_D");
    expect(parsed.dataSources).toHaveLength(1);
    expect(parsed.dataSources[0]?.target).toBe("ZDEMO_I_SalesOrder_TP_D");
    expect(parsed.dataSources[0]?.alias).toBe("SalesOrder");
    const item = parsed.associations.find((a) => a.name === "_Item");
    expect(item).toBeDefined();
    expect(item?.target).toBe("ZDEMO_C_SalesOrderItem_TP_D");
    expect(item?.selected).toBe(true);
    const key = parsed.fields.find((f) => f.isKey);
    expect(key).toBeDefined();
    expect(key?.sources[0]).toEqual({ alias: "SalesOrder", field: "SalesOrderUUID" });
  });

  it("977: three $projection.-qualified associations, and the exposed alias SalesOrderUUID sourced from SalesOrder.salesorderuuid", () => {
    const parsed = parseDdl(SRC_977);
    expect(parsed.dataSources[0]?.target).toBe("zdemo_soh");
    expect(parsed.dataSources[0]?.alias).toBe("SalesOrder");
    expect(parsed.associations.map((a) => a.name).sort()).toEqual(["_BusinessPartner", "_Item", "_OverallStatus"]);
    const exposed = parsed.fields.find((f) => f.alias?.toUpperCase() === "SALESORDERUUID");
    expect(exposed).toBeDefined();
    expect(exposed?.sources[0]?.alias).toBe("SalesOrder");
  });

  it("978: a union relation to a second data source", () => {
    const parsed = parseDdl(SRC_978);
    const relations = parsed.dataSources.map((d) => d.relation);
    expect(relations).toContain("from");
    expect(relations).toContain("union");
    const union = parsed.dataSources.find((d) => d.relation === "union");
    expect(union?.target).toBe("ARS_SWC_CUST_SNAPSHOT_RELEVANT");
  });

  it("979: a multi-line left outer join ON condition is collapsed to one association/join entry, and the // comment is stripped without corrupting the #relc_type.'C' string literal", () => {
    const parsed = parseDdl(SRC_979);
    const join = parsed.dataSources.find((d) => d.relation === "join");
    expect(join).toBeDefined();
    expect(join?.target).toBe("abap_langu_swcmp");
    expect(join?.joinKind).toMatch(/left outer/);
    const key = parsed.fields.find((f) => f.isKey);
    expect(key?.alias).toBe("software_component");
  });

  it("980: two associations to the same target cvers_ref (a diamond), and the nested coalesce(...) expression stays ONE field with multiple sources", () => {
    const parsed = parseDdl(SRC_980);
    const targets = parsed.associations.map((a) => a.target);
    expect(targets.filter((t) => t === "cvers_ref")).toHaveLength(2);
    expect(parsed.associations.every((a) => a.selected)).toBe(true);
    const descrField = parsed.fields.find((f) => f.alias === "software_component_descr");
    expect(descrField).toBeDefined();
    expect(descrField?.sources.length).toBeGreaterThan(1);
  });
});

describe("parseDdl totality: never throws, unrecognized input classifies as kind=\"unknown\"", () => {
  it.each([["", "empty string"], ["x", "a single unrelated character"], ["this is not DDL at all, just plain prose.", "unrecognized prose"]])(
    "%s -> kind:\"unknown\"",
    (source) => {
      expect(() => parseDdl(source)).not.toThrow();
      const parsed = parseDdl(source);
      expect(parsed.kind).toBe("unknown");
    },
  );
});

describe("buildLineage: depth validation", () => {
  it(`depth > LINEAGE_MAX_DEPTH (${LINEAGE_MAX_DEPTH}) is refused BAD_INPUT naming the imported max, not a hardcoded number`, async () => {
    const root = ddlsObj("ZDEMO_C_SalesOrder_TP_D", "/x/source/main");
    const conn = { cfg: { sid: "A4H" }, get: async () => ({ body: SRC_976, headers: {} }) } as unknown as AbapConnection;
    const err = await catchAbapAsync(buildLineage(conn, root, { depth: LINEAGE_MAX_DEPTH + 1 }));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain(String(LINEAGE_MAX_DEPTH));
  });
});

describe("buildLineage: multi-hop chain 976 -> 977 -> base table zdemo_soh", () => {
  it("stops at the base (non-CDS) table, and renderLineage's tree body shows the relation words \"from\"/\"join\"/\"union\" plus the (table) kind at the leaf", async () => {
    const root976 = ddlsObj("ZDEMO_C_SalesOrder_TP_D", "/976/source/main");
    const obj977 = ddlsObj("ZDEMO_I_SalesOrder_TP_D", "/977/source/main");
    resolveMap.set("ZDEMO_I_SALESORDER_TP_D", obj977);
    resolveMap.set("ZDEMO_SOH", tableObj("zdemo_soh"));

    const conn = {
      cfg: { sid: "A4H" },
      get: async (uri: string) => {
        if (uri === "/976/source/main") return { body: SRC_976, headers: {} };
        if (uri === "/977/source/main") return { body: SRC_977, headers: {} };
        throw new Error(`unexpected readSource uri: ${uri}`);
      },
    } as unknown as AbapConnection;

    const result = await buildLineage(conn, root976, { depth: 3 });
    expect(result.baseTables).toContain("zdemo_soh");
    // sourceReads increments once per CDS node whose source was actually
    // read via readSource: root976 + obj977 = 2 (the base table is not a
    // CDS view, so reaching it does not increment sourceReads again).
    expect(result.sourceReads).toBe(2);

    const rendered = renderLineage(result);
    expect(rendered.body).toMatch(/from zdemo_soh as SalesOrder \(table\)/);
    expect(rendered.header.sourceReads).toBe("2");
  });
});

describe("buildLineage: hand-written cycle renders \"(cycle -> seen above)\"", () => {
  it("a child chain that resolves back to the root's own name is caught as a cycle, not infinitely recursed", async () => {
    // ROOT_VIEW selects from CHILD_VIEW, which selects from ROOT_VIEW again
    // (a hand-written, not fixture-derived, cycle — buildLineage seeds
    // `seen` with the root's own name before expansion, so this loop-back
    // is caught without needing a real multi-object fixture).
    const rootSrc = "define view entity ROOT_VIEW as select from CHILD_VIEW as C {\n  key C.id as id\n}";
    const childSrc = "define view entity CHILD_VIEW as select from ROOT_VIEW as R {\n  key R.id as id\n}";

    const root = ddlsObj("ROOT_VIEW", "/root/source/main");
    const child = ddlsObj("CHILD_VIEW", "/child/source/main");
    resolveMap.set("CHILD_VIEW", child);
    resolveMap.set("ROOT_VIEW", root);

    const conn = {
      cfg: { sid: "A4H" },
      get: async (uri: string) => {
        if (uri === "/root/source/main") return { body: rootSrc, headers: {} };
        if (uri === "/child/source/main") return { body: childSrc, headers: {} };
        throw new Error(`unexpected uri: ${uri}`);
      },
    } as unknown as AbapConnection;

    const result = await buildLineage(conn, root, { depth: 5 });
    const rendered = renderLineage(result);
    expect(rendered.body).toContain("(cycle -> seen above)");
    expect(rendered.notes.join("\n")).toMatch(/cycle -> seen above/);
  });
});

describe("buildLineage: field option", () => {
  it("a missing field is refused BAD_INPUT, listing real field names from the view", async () => {
    const root = ddlsObj("ZDEMO_C_SalesOrder_TP_D", "/976/source/main");
    const conn = { cfg: { sid: "A4H" }, get: async () => ({ body: SRC_976, headers: {} }) } as unknown as AbapConnection;
    const err = await catchAbapAsync(buildLineage(conn, root, { field: "NoSuchField" }));
    expect(err.code).toBe("BAD_INPUT");
    expect(err.message).toContain("NoSuchField");
    expect(err.message).toMatch(/SalesOrderUUID/);
  });
});

describe("buildLineage: node-budget truncation", () => {
  it("a tiny nodeBudget truncates the walk, renders \"--- TRUNCATED ---\", and renderLineage's hints point at resuming past it", async () => {
    const root976 = ddlsObj("ZDEMO_C_SalesOrder_TP_D", "/976/source/main");
    const obj977 = ddlsObj("ZDEMO_I_SalesOrder_TP_D", "/977/source/main");
    resolveMap.set("ZDEMO_I_SALESORDER_TP_D", obj977);
    resolveMap.set("ZDEMO_C_SALESORDERITEM_TP_D", ddlsObj("ZDEMO_C_SalesOrderItem_TP_D", "/item/source/main"));

    const conn = {
      cfg: { sid: "A4H" },
      get: async (uri: string) => {
        if (uri === "/976/source/main") return { body: SRC_976, headers: {} };
        if (uri === "/977/source/main") return { body: SRC_977, headers: {} };
        if (uri === "/item/source/main") return { body: SRC_977, headers: {} }; // any parseable DDL is fine here
        throw new Error(`unexpected uri: ${uri}`);
      },
    } as unknown as AbapConnection;

    const result = await buildLineage(conn, root976, { depth: 5, nodeBudget: 1 });
    expect(result.truncated).toBe(true);
    const rendered = renderLineage(result);
    expect(rendered.body).toMatch(/--- TRUNCATED ---/);
    expect(rendered.hints.join("\n")).toMatch(/Node budget reached/);
  });
});
