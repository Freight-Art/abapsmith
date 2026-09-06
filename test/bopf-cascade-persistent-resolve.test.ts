/**
 * Pins the two pure/near-pure halves of `cascade_persistent` in
 * `src/adt/bopf.ts`, run before `deleteBusinessObject` ever sees a
 * candidate:
 *  - `resolvePersistentCascadeRequest` — name list -> `DdicCandidate[]`,
 *    no network, refusing names the model doesn't reference under exactly
 *    one `persistentTableRef`/`persistentStructureRef` slot.
 *  - `probeRequestedPersistentTargets` — one GET per resolved candidate to
 *    read back its package and confirm it matches the BO's own.
 *
 * Same harness idiom as `test/bopf-delete-reporting.test.ts` /
 * `test/bopf-cascade-provenance.test.ts`: real `bopf.ts` functions against a
 * `FakeAdtServer`, only the HTTP socket is fake.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeAdtServer, __resetFakeAdtCounters, ddicProbeRoute, type FakeRoute } from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { parseModel } from "../src/adt/bopf-xml.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { resolvePersistentCascadeRequest, probeRequestedPersistentTargets, type DdicCandidate } from "../src/adt/bopf.js";

// --------------------------------------------------------------------- harness ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const fixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

/** ZBOPF_PRB1, active, after its structures/tables were authored — real captured shape. */
const model = parseModel(fixture("04-active-after-structures.v4.xml"));

/**
 * Inline, not a fixture: one node whose table is referenced under BOTH
 * `persistentTableRef` and `combinedTableRef` — the multi-slot refusal
 * needs a name in two different ref slots, which no captured fixture has.
 */
const DUP_SLOT_BO_XML =
  `<?xml version="1.0" encoding="utf-8"?><bo:businessObject adtcore:name="ZBOPF_DUP" adtcore:type="BOBF" ` +
  `xmlns:bo="http://www.sap.com/bopf/bo/BusinessObject" xmlns:adtcore="http://www.sap.com/adt/core">` +
  `<adtcore:packageRef adtcore:name="$TMP"/>` +
  `<bo:nodes bo:name="ROOT" bo:rootNode="true">` +
  `<bo:persistentTableRef adtcore:uri="/sap/bc/adt/ddic/tables/zbopf_d_dup" adtcore:type="TABL/DT" adtcore:name="ZBOPF_D_DUP"/>` +
  `<bo:combinedTableRef adtcore:uri="/sap/bc/adt/ddic/tabletypes/zbopf_d_dup" adtcore:type="TTYP/DA" adtcore:name="ZBOPF_D_DUP"/>` +
  `</bo:nodes></bo:businessObject>`;
const dupSlotModel = parseModel(DUP_SLOT_BO_XML);

/**
 * Inline: two nodes, ROOT and CHILD, whose `persistentTableRef` both point at
 * the SAME table — the multi-site refusal must count this as two sites
 * (one per node) even though it is the same slot name on both, which is the
 * case `ddicRefSitesForName`'s old set-of-slot-names collapsed to one.
 */
const SAME_TABLE_TWO_NODES_XML =
  `<?xml version="1.0" encoding="utf-8"?><bo:businessObject adtcore:name="ZBOPF_SHARED" adtcore:type="BOBF" ` +
  `xmlns:bo="http://www.sap.com/bopf/bo/BusinessObject" xmlns:adtcore="http://www.sap.com/adt/core">` +
  `<adtcore:packageRef adtcore:name="$TMP"/>` +
  `<bo:nodes bo:name="ROOT" bo:rootNode="true">` +
  `<bo:persistentTableRef adtcore:uri="/sap/bc/adt/ddic/tables/zbopf_d_shared" adtcore:type="TABL/DT" adtcore:name="ZBOPF_D_SHARED"/>` +
  `</bo:nodes>` +
  `<bo:nodes bo:name="CHILD" bo:rootNode="false">` +
  `<bo:persistentTableRef adtcore:uri="/sap/bc/adt/ddic/tables/zbopf_d_shared" adtcore:type="TABL/DT" adtcore:name="ZBOPF_D_SHARED"/>` +
  `</bo:nodes></bo:businessObject>`;
const sameTableTwoNodesModel = parseModel(SAME_TABLE_TWO_NODES_XML);

/**
 * Inline: two nodes, ROOT and CHILD, with their OWN distinct
 * `persistentTableRef` tables — proves the multi-site guard does not become
 * over-eager and refuse a name just because its node has siblings.
 */
const DISTINCT_TABLES_TWO_NODES_XML =
  `<?xml version="1.0" encoding="utf-8"?><bo:businessObject adtcore:name="ZBOPF_DISTINCT" adtcore:type="BOBF" ` +
  `xmlns:bo="http://www.sap.com/bopf/bo/BusinessObject" xmlns:adtcore="http://www.sap.com/adt/core">` +
  `<adtcore:packageRef adtcore:name="$TMP"/>` +
  `<bo:nodes bo:name="ROOT" bo:rootNode="true">` +
  `<bo:persistentTableRef adtcore:uri="/sap/bc/adt/ddic/tables/zbopf_d_root3" adtcore:type="TABL/DT" adtcore:name="ZBOPF_D_ROOT3"/>` +
  `</bo:nodes>` +
  `<bo:nodes bo:name="CHILD" bo:rootNode="false">` +
  `<bo:persistentTableRef adtcore:uri="/sap/bc/adt/ddic/tables/zbopf_d_child3" adtcore:type="TABL/DT" adtcore:name="ZBOPF_D_CHILD3"/>` +
  `</bo:nodes></bo:businessObject>`;
const distinctTablesTwoNodesModel = parseModel(DISTINCT_TABLES_TWO_NODES_XML);

const systemRoleRoute: FakeRoute = (r) => (r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined);

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

async function wired(options: { routes?: readonly FakeRoute[] } = {}): Promise<{ conn: AbapConnection; server: FakeAdtServer }> {
  const server = new FakeAdtServer({ transportErrors: "throw", routes: [systemRoleRoute, ...(options.routes ?? [])] });
  const client = server.client("s1");
  const conn = new AbapConnection(cfg(), { httpClient: client, log: () => {}, breaker: new AuthCircuitBreaker() });
  openConnections.push(conn);
  await conn.connect();
  return { conn, server };
}

/** Runs `fn`, asserting it threw an `AbapError` with code BAD_INPUT, and returns it for message assertions. */
function expectBadInput(fn: () => unknown): AbapError {
  let threw: unknown;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  expect(isAbapError(threw)).toBe(true);
  const err = threw as AbapError;
  expect(err.code).toBe("BAD_INPUT");
  return err;
}

/** Same as {@link expectBadInput}, for a rejecting promise. */
async function expectBadInputAsync(p: Promise<unknown>): Promise<AbapError> {
  let threw: unknown;
  try {
    await p;
  } catch (e) {
    threw = e;
  }
  expect(isAbapError(threw)).toBe(true);
  const err = threw as AbapError;
  expect(err.code).toBe("BAD_INPUT");
  return err;
}

const ROOT_TABLE: DdicCandidate = {
  name: "ZBOPF_D_ROOT",
  kind: "table",
  uri: "/sap/bc/adt/ddic/tables/zbopf_d_root",
  type: "TABL/DT",
  refSite: "persistentTableRef",
};

// ------------------------------------------------------------ resolvePersistentCascadeRequest ---

describe("resolvePersistentCascadeRequest", () => {
  it("resolves a root persistentTableRef name to one table candidate", () => {
    const resolved = resolvePersistentCascadeRequest("ZBOPF_PRB1", model, ["ZBOPF_D_ROOT"]);
    expect(resolved).toEqual([ROOT_TABLE]);
  });

  it("matches case-insensitively and trims", () => {
    const resolved = resolvePersistentCascadeRequest("ZBOPF_PRB1", model, ["  zbopf_d_root  "]);
    expect(resolved).toEqual([ROOT_TABLE]);
  });

  it("de-duplicates repeated names differing only in case", () => {
    const resolved = resolvePersistentCascadeRequest("ZBOPF_PRB1", model, ["ZBOPF_D_ROOT", "zbopf_d_root"]);
    expect(resolved).toHaveLength(1);
  });

  it("orders tables before structures regardless of request order", () => {
    const resolved = resolvePersistentCascadeRequest("ZBOPF_PRB1", model, ["/BOBF/S_DEMO_SALES_ORDER_HDR", "ZBOPF_D_ROOT"]);
    expect(resolved.map((c) => c.name)).toEqual(["ZBOPF_D_ROOT", "/BOBF/S_DEMO_SALES_ORDER_HDR"]);
    expect(resolved.map((c) => c.kind)).toEqual(["table", "structure"]);
  });

  it("resolves a non-root node's persistentTableRef too — the walk is not root-only", () => {
    const resolved = resolvePersistentCascadeRequest("ZBOPF_PRB1", model, ["ZBOPF_D_ITEM"]);
    expect(resolved).toEqual([
      {
        name: "ZBOPF_D_ITEM",
        kind: "table",
        uri: "/sap/bc/adt/ddic/tables/zbopf_d_item",
        type: "TABL/DT",
        refSite: "persistentTableRef",
      },
    ]);
  });

  it("refuses a combinedTableRef name (generated, not persistent) and lists the persistent names that ARE referenced", () => {
    const err = expectBadInput(() => resolvePersistentCascadeRequest("ZBOPF_PRB1", model, ["ZBOPF_T_ROOT"]));
    expect(err.message).toContain("ZBOPF_T_ROOT");
    expect(err.message).toContain("ZBOPF_D_ROOT");
    expect(err.message).toContain("/BOBF/S_DEMO_SALES_ORDER_HDR");
    expect(err.message).toContain("ZBOPF_D_ITEM");
    expect(err.message).toContain("/BOBF/S_DEMO_SALES_ORDER_ITM");
  });

  it("refuses a name the model never references at all", () => {
    const err = expectBadInput(() => resolvePersistentCascadeRequest("ZBOPF_PRB1", model, ["ZZZZ_NOT_REFERENCED"]));
    expect(err.message).toContain("ZZZZ_NOT_REFERENCED");
  });

  it("refuses a name referenced under two different ref slots, naming both slots", () => {
    const err = expectBadInput(() => resolvePersistentCascadeRequest("ZBOPF_DUP", dupSlotModel, ["ZBOPF_D_DUP"]));
    expect(err.message).toContain("persistentTableRef");
    expect(err.message).toContain("combinedTableRef");
  });

  it("refuses a name referenced as persistentTableRef by two different nodes, naming both nodes", () => {
    const err = expectBadInput(() =>
      resolvePersistentCascadeRequest("ZBOPF_SHARED", sameTableTwoNodesModel, ["ZBOPF_D_SHARED"]),
    );
    expect(err.message).toContain("ROOT");
    expect(err.message).toContain("CHILD");
  });

  it("resolves both names when two nodes each have their own distinct persistentTableRef", () => {
    const resolved = resolvePersistentCascadeRequest("ZBOPF_DISTINCT", distinctTablesTwoNodesModel, [
      "ZBOPF_D_ROOT3",
      "ZBOPF_D_CHILD3",
    ]);
    expect(resolved.map((c) => c.name)).toEqual(["ZBOPF_D_ROOT3", "ZBOPF_D_CHILD3"]);
    expect(resolved.every((c) => c.kind === "table")).toBe(true);
  });
});

// ------------------------------------------------------------ probeRequestedPersistentTargets ---

describe("probeRequestedPersistentTargets", () => {
  it("present, package matches boPackage: present true, packageName, non-empty document body", async () => {
    const { conn } = await wired({ routes: [ddicProbeRoute({ uri: ROOT_TABLE.uri, exists: true, packageName: "$TMP" })] });

    const [target] = await probeRequestedPersistentTargets(conn, "ZBOPF_PRB1", "$TMP", [ROOT_TABLE]);

    expect(target).toEqual({
      candidate: ROOT_TABLE,
      present: true,
      packageName: "$TMP",
      beforeSource: expect.stringContaining("$TMP"),
    });
  });

  it("404 yields present:false, no throw, no packageName", async () => {
    const { conn } = await wired({ routes: [ddicProbeRoute({ uri: ROOT_TABLE.uri, exists: false })] });

    const [target] = await probeRequestedPersistentTargets(conn, "ZBOPF_PRB1", "$TMP", [ROOT_TABLE]);

    expect(target).toEqual({ candidate: ROOT_TABLE, present: false });
  });

  it("package mismatch throws BAD_INPUT naming both packages, ending 'Nothing was deleted.'", async () => {
    const { conn } = await wired({ routes: [ddicProbeRoute({ uri: ROOT_TABLE.uri, exists: true, packageName: "/BOBF/DEMO" })] });

    const err = await expectBadInputAsync(probeRequestedPersistentTargets(conn, "ZBOPF_PRB1", "$TMP", [ROOT_TABLE]));
    expect(err.message).toContain("/BOBF/DEMO");
    expect(err.message).toContain("$TMP");
    expect(err.message.endsWith("Nothing was deleted.")).toBe(true);
  });

  it("no <adtcore:packageRef> in the document throws BAD_INPUT mentioning packageRef", async () => {
    const { conn } = await wired({ routes: [ddicProbeRoute({ uri: ROOT_TABLE.uri, exists: true })] });

    const err = await expectBadInputAsync(probeRequestedPersistentTargets(conn, "ZBOPF_PRB1", "$TMP", [ROOT_TABLE]));
    expect(err.message).toContain("packageRef");
  });

  it("undefined boPackage throws BAD_INPUT: the BO's own package could not be determined", async () => {
    const { conn } = await wired({ routes: [ddicProbeRoute({ uri: ROOT_TABLE.uri, exists: true, packageName: "$TMP" })] });

    const err = await expectBadInputAsync(probeRequestedPersistentTargets(conn, "ZBOPF_PRB1", undefined, [ROOT_TABLE]));
    expect(err.message).toContain("this BO's own package could not be determined");
  });

  it("blank boPackage throws BAD_INPUT the same way as undefined", async () => {
    const { conn } = await wired({ routes: [ddicProbeRoute({ uri: ROOT_TABLE.uri, exists: true, packageName: "$TMP" })] });

    const err = await expectBadInputAsync(probeRequestedPersistentTargets(conn, "ZBOPF_PRB1", "   ", [ROOT_TABLE]));
    expect(err.message).toContain("this BO's own package could not be determined");
  });

  it("probes with Accept: application/*, never */* — a */* probe would come back with no packageRef and refuse every call", async () => {
    const { conn, server } = await wired({ routes: [ddicProbeRoute({ uri: ROOT_TABLE.uri, exists: true, packageName: "$TMP" })] });

    await probeRequestedPersistentTargets(conn, "ZBOPF_PRB1", "$TMP", [ROOT_TABLE]);

    const calls = server.callsFor((r) => r.method === "GET" && r.path === ROOT_TABLE.uri);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.headers["accept"]).toBe("application/*");
  });
});
