/**
 * Wiring tests for BOPF delegation: `src/tools/bopf-delegation.ts` (the
 * surviving `remove_dependent_object` engine, plus the
 * `refuseHandAssembledDelegation` refusals, already unit tested in
 * isolation in `test/bopf-delegation.test.ts`) is exercised here end to end
 * through `abap_bopf_edit`/`abap_bopf`, the same way
 * `test/bopf-add-node-verify.test.ts` exercises `add_node`. Nothing here
 * re-tests the engine's own logic; every test would fail with an
 * "unsupported operation"/schema-rejection/unchanged-digest shape if the
 * wiring in `src/tools/bopf.ts` (schema enum, `validateEditInputShape`,
 * `mutateModel`, `runBopfEdit`'s preflight/verify/notes, `buildShowResponse`)
 * were reverted.
 *
 * `add_representative_node`, `remove_representative_node` and
 * `embed_dependent_object` were removed from the product: a live discovery
 * run against a real SAP system found the BOPF ADT endpoint cannot perform
 * those writes (see `src/tools/bopf-delegation.ts`'s doc comment and
 * `doc/CAPABILITIES/bopf.md`). This file pins that they are genuinely gone
 * from the tool surface.
 *
 * Harness: identical to `test/bopf-add-node-verify.test.ts` — a real
 * `AbapConnection` against a `FakeAdtServer`, a real `SafetyGate`, real
 * `errorResult`. Only the HTTP socket and `SessionPool` are fake.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { EMPTY_200, FakeAdtServer, __resetFakeAdtCounters, bopfStore, BOPF_COLLECTION_PATH, type FakeRoute } from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import type { SessionPool } from "../src/adt/pool.js";
import { errorResult } from "../src/server.js";
import { registerBopfTools, bopfEditInputSchema, type BopfToolDeps } from "../src/tools/bopf.js";
import { BOPF_HANDLERS } from "../src/tools/v2/handlers/do/bopf.js";
import { ABAP_DO_ACTIONS } from "../src/tools/v2/catalogue.js";

// --------------------------------------------------------------------- fixtures ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const fixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

/** ZBOPF_PRB1, inactive, root-node-only. ROOT's bo:nodeID is GiJj4KTjH+GkgJER+Cx2UA==. */
const FX_JUST_CREATED = fixture("02-created-zbopf_prb1-root-only.v4.xml");

/**
 * Hand-built (not a captured fixture — no captured model exercises delegation
 * yet), styled after real captured attribute shapes (see
 * `test/fixtures/bopf/10-model-coverage-final.v4.xml`'s association/ref
 * syntax): ROOT plus a parentless "CUSTREF" node (representative — no
 * `bo:parent`, only KEY/PARENT_KEY/ROOT_KEY properties), a cross-BO
 * association to "OTHERBO~ROOT", and a same-BO DoComposition pair
 * (ROOT's "ITEMS_EMB" association + the "ITEMS_EMB.ROOT" child it embeds) —
 * the wire shape a real dependent-object embedding takes.
 * abapsmith cannot create one — `embed_dependent_object` was removed as
 * unimplementable (see `doc/CAPABILITIES/bopf.md`); this fixture exists only
 * so the read side can be shown to classify such a model. Feeds the one
 * `mode:"show"` digest test below.
 */
const FX_SHOW_DIGEST =
  `<?xml version="1.0" encoding="utf-8"?><bo:businessObject bo:objectCategory="businessProcessObject" ` +
  `bo:isExtensible="false" bo:objectModelGenerated="false" adtcore:name="ZBOPF_DELEG" adtcore:type="BOBF" ` +
  `adtcore:version="active" adtcore:description="delegation digest fixture" ` +
  `xmlns:bo="http://www.sap.com/bopf/bo/BusinessObject" xmlns:adtcore="http://www.sap.com/adt/core">` +
  `<adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/%24tmp" adtcore:type="DEVC/K" adtcore:name="$TMP"/>` +
  `<bo:nodes bo:name="ROOT" bo:nodeID="ROOTNODEID0000000A==" bo:xmlName="Root" bo:objectModelGenerated="false" ` +
  `bo:authorizationCheck="false" bo:isExtensible="false" bo:isDependentObjectNode="false" bo:textNode="false" ` +
  `bo:createEnabled="true" bo:updateEnabled="true" bo:deleteEnabled="true" bo:rootNode="true" ` +
  `bo:objectModelObsolete="false">` +
  `<bo:properties bo:name="KEY" bo:enabled="true" bo:readonly="false" bo:mandatory="false" bo:enabledFinal="false" ` +
  `bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/>` +
  `<bo:associations bo:name="TO_CUSTREF" bo:nodeID="ASSOC10000000000A==" bo:implementationType="Association" ` +
  `bo:objectModelGenerated="false" bo:xmlName="To CUSTREF" bo:multiplicity="0_1">` +
  `<bo:targetNodeRef adtcore:uri="/sap/bc/adt/bopf/businessobjects/zbopf_deleg#//bo:businessObject/bo:nodes[@bo:name='CUSTREF']" ` +
  `adtcore:type="BOBF" adtcore:name="CUSTREF"/></bo:associations>` +
  `<bo:associations bo:name="TO_OTHER" bo:nodeID="ASSOC20000000000A==" bo:implementationType="Association" ` +
  `bo:objectModelGenerated="false" bo:xmlName="To Other" bo:multiplicity="0_1">` +
  `<bo:targetNodeRef adtcore:uri="/sap/bc/adt/bopf/businessobjects/otherbo#//bo:businessObject/bo:nodes[@bo:name='ROOT']" ` +
  `adtcore:type="BOBF" adtcore:name="OTHERBO~ROOT"/></bo:associations>` +
  `<bo:associations bo:name="ITEMS_EMB" bo:nodeID="ASSOC30000000000A==" bo:implementationType="DoComposition" ` +
  `bo:objectModelGenerated="false" bo:xmlName="Items Emb" bo:doEmbeddingName="ITEMS_EMB" bo:multiplicity="0_N">` +
  `<bo:targetNodeRef adtcore:uri="/sap/bc/adt/bopf/businessobjects/zbopf_deleg#//bo:businessObject/bo:nodes[@bo:name='ITEMS_EMB.ROOT']" ` +
  `adtcore:type="BOBF" adtcore:name="ZBOPF_DELEG~ITEMS_EMB.ROOT"/>` +
  `<bo:implementationClassRef adtcore:uri="/sap/bc/adt/oo/classes/%2fbobf%2fcl_c_bopf_2_bopf_simple" ` +
  `adtcore:type="CLAS/OC" adtcore:name="/BOBF/CL_C_BOPF_2_BOPF_SIMPLE"/></bo:associations>` +
  `</bo:nodes>` +
  `<bo:nodes bo:name="CUSTREF" bo:nodeID="CUSTREFNODEID000A==" bo:xmlName="Customer Ref" ` +
  `bo:objectModelGenerated="false" bo:authorizationCheck="false" bo:isExtensible="false" ` +
  `bo:isDependentObjectNode="false" bo:textNode="false" bo:createEnabled="true" bo:updateEnabled="true" ` +
  `bo:deleteEnabled="true" bo:rootNode="false" bo:objectModelObsolete="false">` +
  `<bo:properties bo:name="KEY" bo:enabled="true" bo:readonly="false" bo:mandatory="false" bo:enabledFinal="false" ` +
  `bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/>` +
  `<bo:properties bo:name="PARENT_KEY" bo:enabled="true" bo:readonly="false" bo:mandatory="false" ` +
  `bo:enabledFinal="false" bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/>` +
  `<bo:properties bo:name="ROOT_KEY" bo:enabled="true" bo:readonly="false" bo:mandatory="false" ` +
  `bo:enabledFinal="false" bo:readonlyFinal="false" bo:mandatoryFinal="false" bo:transientAttribute="false"/>` +
  `</bo:nodes>` +
  `<bo:nodes bo:name="ITEMS_EMB.ROOT" bo:nodeID="EMBNODEID0000000A==" ` +
  `bo:parent="#//bo:businessObject/bo:nodes[@bo:name='ROOT']" bo:parentNodeID="ROOTNODEID0000000A==" ` +
  `bo:xmlName="Items Emb Root" bo:objectModelGenerated="false" bo:authorizationCheck="false" ` +
  `bo:isExtensible="false" bo:isDependentObjectNode="false" bo:textNode="false" bo:createEnabled="false" ` +
  `bo:updateEnabled="false" bo:deleteEnabled="false" bo:rootNode="false" bo:objectModelObsolete="false"/>` +
  `</bo:businessObject>`;

// ----------------------------------------------------------------------- harness ---
// Copied verbatim from test/bopf-add-node-verify.test.ts's harness section.

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

async function wired(
  options: { routes?: readonly FakeRoute[]; catchAll?: FakeRoute } = {},
): Promise<{ conn: AbapConnection; server: FakeAdtServer }> {
  const server = new FakeAdtServer({
    transportErrors: "throw",
    routes: [systemRoleRoute, ...(options.routes ?? [])],
    ...(options.catchAll ? { catchAll: options.catchAll } : {}),
  });
  const client = server.client("s1");
  const conn = new AbapConnection(cfg(), {
    httpClient: client,
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  openConnections.push(conn);
  await conn.connect();
  return { conn, server };
}

function callsAfterConnect(server: FakeAdtServer): number {
  return server.calls.length;
}

function fakePool(conn: AbapConnection): SessionPool {
  return {
    withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    withWrite: <T,>(_op: string, _objectUri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    reserveDebug: () => {
      throw new Error("reserveDebug: not used by any BOPF tool, and not implemented in this fake.");
    },
  } as unknown as SessionPool;
}

function fakeMcp(): { mcp: McpServer; tools: Map<string, { config: unknown; handler: (args: unknown) => Promise<CallToolResult> }> } {
  const tools = new Map<string, { config: unknown; handler: (args: unknown) => Promise<CallToolResult> }>();
  const mcp = {
    registerTool: (name: string, config: unknown, handler: (args: unknown) => Promise<CallToolResult>) => {
      tools.set(name, { config, handler });
      return {} as unknown;
    },
  } as unknown as McpServer;
  return { mcp, tools };
}

async function invoke(
  tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>,
  name: string,
  args: unknown,
): Promise<CallToolResult> {
  const entry = tools.get(name);
  if (!entry) throw new Error(`tool "${name}" was never registered`);
  return entry.handler(args);
}

function errorPayload(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBe(true);
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return JSON.parse(text.text) as Record<string, unknown>;
}

function okText(result: CallToolResult): string {
  expect(result.isError).toBeFalsy();
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return text.text;
}

const openGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowTransportRelease: true,
    allowCascadeDelete: true,
  });

const fakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({
    kind: "transport",
    required: true,
    mustSupplyCorrNr: true,
    serverWouldFabricate: false,
    ...overrides,
  }) as unknown as TrRequirement;

const localTransport = (): SessionTransport =>
  new SessionTransport({
    allowTransports: ["auto"],
    cts: { trRequirement: async () => fakeReq({ kind: "local" }) },
  });

function depsFor(conn: AbapConnection, opts: { safety?: SafetyGate; transport?: SessionTransport } = {}): BopfToolDeps {
  return {
    pool: fakePool(conn),
    safety: opts.safety ?? openGate(),
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: 30_000 },
    transport: opts.transport ?? localTransport(),
    registerWrite: true,
  };
}

async function registered(
  conn: AbapConnection,
  opts: { safety?: SafetyGate; transport?: SessionTransport } = {},
): Promise<{ tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>; deps: BopfToolDeps }> {
  const { mcp, tools } = fakeMcp();
  const deps = depsFor(conn, opts);
  registerBopfTools(mcp, deps);
  return { tools, deps };
}

// ===========================================================================
describe("remove_dependent_object: happy path against a genuine embedding", () => {
  it("removes both the ITEMS_EMB association and the ITEMS_EMB.ROOT node, and a re-read follows the PUT", async () => {
    const store = bopfStore({ zbopf_deleg: FX_SHOW_DIGEST });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_DELEG",
      operation: "remove_dependent_object",
      node: "ROOT",
      name: "ITEMS_EMB",
    });

    expect(result.isError).toBeFalsy();
    const finalBody = store.get("zbopf_deleg")!;
    expect(finalBody).not.toContain('bo:name="ITEMS_EMB.ROOT"');
    expect(finalBody).not.toContain('bo:name="ITEMS_EMB"');
    // The other two associations and the CUSTREF node are untouched.
    expect(finalBody).toContain('bo:name="TO_CUSTREF"');
    expect(finalBody).toContain('bo:name="TO_OTHER"');
    expect(finalBody).toContain('bo:name="CUSTREF"');

    // putModel's own re-read: a GET on the entry path after the PUT, not just the PUT's 200.
    const putIdx = server.calls.findIndex(
      (r) => r.method === "PUT" && r.path === `${BOPF_COLLECTION_PATH}/zbopf_deleg`,
    );
    expect(putIdx).toBeGreaterThanOrEqual(0);
    const rereadAfterPut = server.calls
      .slice(putIdx + 1)
      .some((r) => r.method === "GET" && r.path === `${BOPF_COLLECTION_PATH}/zbopf_deleg`);
    expect(rereadAfterPut).toBe(true);
  });
});

describe("remove_dependent_object: CHECK_FAILED when the server discards the PUT", () => {
  it("reports CHECK_FAILED with the house sentence when the PUT answers 200 but a re-read shows the pair unchanged, and sends no activation request", async () => {
    const discardPutRoute: FakeRoute = (r) =>
      r.method === "PUT" && r.path === `${BOPF_COLLECTION_PATH}/zbopf_deleg` ? EMPTY_200() : undefined;

    const store = bopfStore({ zbopf_deleg: FX_SHOW_DIGEST });
    const { conn, server } = await wired({ routes: [discardPutRoute, store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_DELEG",
      operation: "remove_dependent_object",
      node: "ROOT",
      name: "ITEMS_EMB",
      activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("CHECK_FAILED");
    expect(String(payload.message)).toContain(
      "A BOPF PUT answers 200 whether or not the server kept what was sent, and nothing was activated.",
    );
    expect(String(payload.message)).toContain("ITEMS_EMB");
    expect(store.get("zbopf_deleg")).toBe(FX_SHOW_DIGEST); // discarded, as BOPF actually did

    const activationCalls = server.calls.filter((r) => r.method === "POST" && r.path.includes("/sap/bc/adt/activation"));
    expect(activationCalls).toHaveLength(0);
  });
});

describe("remove_dependent_object: refuses a non-embedding", () => {
  it("refuses BAD_INPUT naming remove_association when the target association is a plain Association, not DoComposition, and sends no PUT", async () => {
    const store = bopfStore({ zbopf_deleg: FX_SHOW_DIGEST });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_DELEG",
      operation: "remove_dependent_object",
      node: "ROOT",
      name: "TO_CUSTREF",
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("remove_association");
    expect(server.calls.slice(before).some((r) => r.method === "PUT")).toBe(false);
  });
});

describe("add_node/add_association refuse a hand-assembled delegation, naming the proper operation", () => {
  it("add_node with doEmbeddingName set is refused, before any network call", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_node",
      name: "SNEAKY.ROOT",
      spec: { parent: "ROOT", doEmbeddingName: "SNEAKY" },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("dependent-object");
    expect(server.calls.length).toBe(before);
  });

  it("add_association with implementationType DoComposition is refused, before any network call", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_association",
      node: "ROOT",
      name: "SNEAKY",
      spec: { implementationType: "DoComposition", targetNodeRef: { name: "SNEAKY.ROOT", type: "BOBF" } },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("remove_dependent_object still removes an embedding");
    expect(server.calls.length).toBe(before);
  });

  it("add_node with neither spec.parent/spec.parentNodeId nor rootNode: true is refused, naming add_association and REP_, before any network call", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_node",
      name: "ORPHAN",
      spec: {},
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("add_association");
    expect(String(payload.message)).toContain("REP_");
    expect(server.calls.length).toBe(before);
  });
});

describe("the three removed operations are gone from the tool surface", () => {
  // The fake MCP harness (`fakeMcp()` above) stores the raw handler and calls it directly —
  // unlike the real McpServer.registerTool, it does not itself validate `args` against
  // `inputSchema` before invoking the handler. So the thing that actually protects a live
  // server (rejection before the handler runs, hence before any network call) is the zod
  // enum on the exported schema itself; that is what these assertions pin, read off the
  // schema rather than hardcoded, per the request driving this test.
  const removedOperations = ["add_representative_node", "remove_representative_node", "embed_dependent_object"];

  it("none of the three removed operation names are options on bopfEditInputSchema.operation", () => {
    const options: readonly string[] = bopfEditInputSchema.operation.options;
    for (const op of removedOperations) {
      expect(options).not.toContain(op);
    }
    expect(options).toContain("remove_dependent_object");
  });

  it("bopfEditInputSchema.operation.safeParse rejects each removed operation name", () => {
    for (const op of removedOperations) {
      expect(bopfEditInputSchema.operation.safeParse(op).success).toBe(false);
    }
    expect(bopfEditInputSchema.operation.safeParse("remove_dependent_object").success).toBe(true);
  });
});

describe("unknown spec keys are rejected for remove_dependent_object (pins OPERATION_FIELDS = NO_SPEC_FIELDS)", () => {
  it("any spec key at all is rejected, before any network call", async () => {
    const store = bopfStore({ zbopf_deleg: FX_SHOW_DIGEST });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_DELEG",
      operation: "remove_dependent_object",
      node: "ROOT",
      name: "ITEMS_EMB",
      spec: { bogusKey: "x" },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("bogusKey");
    expect(server.calls.length).toBe(before);
  });
});

describe("the two cross-BO add_association notes reach the caller", () => {
  it("a genuine cross-BO add_association succeeds and the response carries both the REP_ note and the ASSERTION_FAILED observation", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_association",
      node: "ROOT",
      name: "TO_OTHER",
      spec: { targetNodeRef: { name: "OTHERBO~ROOT", type: "BOBF" } },
    });

    const text = okText(result);
    expect(store.get("zbopf_prb1")).toContain('bo:name="TO_OTHER"');
    expect(text).toContain("REP_<random>");
    expect(text).toContain("server-assigned and cannot be chosen");
    expect(text).toContain("ASSERTION_FAILED");
    expect(text).toContain("/BOBF/CL_CONF_MODEL_API_MAP");
  });
});

describe("abap_bopf show: node/association digests carry the delegation-kind annotations", () => {
  it("annotates a representative node, a delegated node, root, and both a cross-BO and a do-composition association", async () => {
    const nsKey = "zbopf_deleg";
    const store = bopfStore({ [nsKey]: FX_SHOW_DIGEST });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf", { bo: "ZBOPF_DELEG" });
    const text = okText(result);

    expect(text).toContain("NODE ROOT (root)");
    expect(text).toContain("NODE CUSTREF (representative)");
    expect(text).toContain("NODE ITEMS_EMB.ROOT (delegated via ROOT.ITEMS_EMB)");
    expect(text).toContain("TO_OTHER (-> OTHERBO~ROOT)");
    expect(text).toContain("ITEMS_EMB (do-composition)");
    // TO_CUSTREF is a plain same-BO association — no parenthetical marker at all.
    expect(text).toMatch(/associations:.*\bTO_CUSTREF\b(?!\s*\()/);

    // SHOW_NOTES' updated wording: the server mints REP_<random> nodes itself; abapsmith
    // cannot create one directly (the old wording named add_representative_node instead).
    expect(text).toContain("REP_<random>");
    expect(text).toContain("abapsmith cannot create one of these");
  });
});

describe("v2 catalogue/handler wiring: bopf_remove_dependent_object is present, the three removed actions are not", () => {
  it("BOPF_HANDLERS and the ABAP_DO_ACTIONS bopf group both list bopf_remove_dependent_object and neither lists a removed action", () => {
    const removedActions = ["bopf_add_representative_node", "bopf_remove_representative_node", "bopf_embed_dependent_object"];

    expect(BOPF_HANDLERS.has("bopf_remove_dependent_object")).toBe(true);
    for (const action of removedActions) {
      expect(BOPF_HANDLERS.has(action)).toBe(false);
    }

    const bopfGroupActions = ABAP_DO_ACTIONS.filter((a) => a.group === "bopf");
    const bopfGroupActionNames = new Set(bopfGroupActions.map((a) => a.action));
    expect(bopfGroupActionNames.has("bopf_remove_dependent_object")).toBe(true);
    for (const action of removedActions) {
      expect(bopfGroupActionNames.has(action)).toBe(false);
    }

    // Verified by direct count (background claimed 27; confirmed independently here).
    expect(bopfGroupActions.length).toBe(27);
  });
});
