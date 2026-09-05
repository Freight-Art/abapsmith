/**
 * Wiring tests for BOPF delegation: `src/tools/bopf-delegation.ts` (the
 * `add_representative_node` / `remove_representative_node` /
 * `embed_dependent_object` / `remove_dependent_object` engine, already unit
 * tested in isolation in `test/bopf-delegation.test.ts`) is exercised here
 * end to end through `abap_bopf_edit`/`abap_bopf`, the same way
 * `test/bopf-add-node-verify.test.ts` exercises `add_node`. Nothing here
 * re-tests the engine's own logic; every test would fail with an
 * "unsupported operation"/schema-rejection/unchanged-digest shape if the
 * wiring in `src/tools/bopf.ts` (schema enum, `validateEditInputShape`,
 * `mutateModel`, `runBopfEdit`'s preflight/verify/notes, `buildShowResponse`)
 * were reverted.
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
import { registerBopfTools, type BopfToolDeps } from "../src/tools/bopf.js";
import { BOPF_HANDLERS } from "../src/tools/v2/handlers/do/bopf.js";
import { ABAP_DO_ACTIONS } from "../src/tools/v2/catalogue.js";

// --------------------------------------------------------------------- fixtures ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const fixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

/** ZBOPF_PRB1, inactive, root-node-only. ROOT's bo:nodeID is GiJj4KTjH+GkgJER+Cx2UA==. */
const FX_JUST_CREATED = fixture("02-created-zbopf_prb1-root-only.v4.xml");
const ROOT_NODE_ID = "GiJj4KTjH+GkgJER+Cx2UA==";

/** Same bytes, renamed — a plausible represented BO. objectCategory stays "businessProcessObject" (irrelevant to add_representative_node, which imposes no category requirement). */
const FX_REPRESENTED_BO = FX_JUST_CREATED.replace('adtcore:name="ZBOPF_PRB1"', 'adtcore:name="ZBOPF_CUST"');

/** Same bytes, renamed, with objectCategory swapped to "dependentObject" — the one category embed_dependent_object accepts. */
const FX_DEPENDENT_OK = FX_JUST_CREATED.replace('adtcore:name="ZBOPF_PRB1"', 'adtcore:name="ZBOPF_DEPO"').replace(
  'bo:objectCategory="businessProcessObject"',
  'bo:objectCategory="dependentObject"',
);

/** Same bytes, renamed, category left as the default "businessProcessObject" — must be refused by embed_dependent_object. */
const FX_WRONG_CATEGORY = FX_JUST_CREATED.replace('adtcore:name="ZBOPF_PRB1"', 'adtcore:name="ZBOPF_WRONGCAT"');

/**
 * Hand-built (not a captured fixture — no captured model exercises delegation
 * yet), styled after real captured attribute shapes (see
 * `test/fixtures/bopf/10-model-coverage-final.v4.xml`'s association/ref
 * syntax): ROOT plus a parentless "CUSTREF" node (representative — no
 * `bo:parent`, only KEY/PARENT_KEY/ROOT_KEY properties), a cross-BO
 * association to "OTHERBO~ROOT", and a same-BO DoComposition pair
 * (ROOT's "ITEMS_EMB" association + the "ITEMS_EMB.ROOT" child it embeds) —
 * the exact wire shape `mutateEmbedDependentObject` writes. Feeds the one
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

describe("embed_dependent_object: schema/shape refusals happen before any network call", () => {
  it("refuses BAD_INPUT without i_know_this_may_not_activate: true, and issues no PUT", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED, zbopf_depo: FX_DEPENDENT_OK });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "embed_dependent_object",
      node: "ROOT",
      name: "ITEMS_EMB",
      spec: { dependentObject: "ZBOPF_DEPO" },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("i_know_this_may_not_activate");

    const calls = server.calls.slice(before);
    expect(calls.some((r) => r.method === "PUT")).toBe(false);
    // Zero-network shape check runs before ensureConnected's own preflight reads too.
    expect(calls.some((r) => r.method === "GET" && r.path.includes("zbopf_depo"))).toBe(false);
    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED);
  });

  it("refuses BAD_INPUT when the dependent object's objectCategory is not \"dependentObject\", before any PUT to the host", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED, zbopf_wrongcat: FX_WRONG_CATEGORY });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "embed_dependent_object",
      node: "ROOT",
      name: "ITEMS_EMB",
      spec: { dependentObject: "ZBOPF_WRONGCAT" },
      i_know_this_may_not_activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("ZBOPF_WRONGCAT");
    expect(String(payload.message)).toContain("objectCategory");

    const calls = server.calls.slice(before);
    expect(calls.some((r) => r.method === "PUT")).toBe(false);
    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED);
  });
});

describe("embed_dependent_object: a genuine write puts the real association+node pair on the wire", () => {
  it("writes the DoComposition association (with the default implementationClassRef) plus the \"<name>.ROOT\" node carrying the parent's real bo:nodeID, and discloses the wire-fact note", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED, zbopf_depo: FX_DEPENDENT_OK });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "embed_dependent_object",
      node: "ROOT",
      name: "ITEMS_EMB",
      spec: { dependentObject: "ZBOPF_DEPO" },
      i_know_this_may_not_activate: true,
    });

    const text = okText(result);
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain('bo:name="ITEMS_EMB.ROOT"');
    expect(putBody).toContain(`bo:parentNodeID="${ROOT_NODE_ID}"`);
    expect(putBody).toContain(`bo:parent="#//bo:businessObject/bo:nodes[@bo:name='ROOT']"`);
    expect(putBody).toContain('bo:implementationType="DoComposition"');
    expect(putBody).toContain('bo:doEmbeddingName="ITEMS_EMB"');
    // Default implementationClassRef (spec.implementationClassRef not given).
    expect(putBody).toContain('adtcore:uri="/sap/bc/adt/oo/classes/%2fbobf%2fcl_c_bopf_2_bopf_simple"');
    expect(putBody).toContain('adtcore:name="/BOBF/CL_C_BOPF_2_BOPF_SIMPLE"');
    // Neither the dependent object's name nor a link to it appears anywhere on the wire.
    expect(putBody).not.toContain("ZBOPF_DEPO");

    // delegationNotes' disclosure is surfaced in the response text.
    expect(text).toContain("ZBOPF_DEPO");
    expect(text).toContain("never names the dependent object");
  });

  it("writes a caller-supplied implementationClassRef instead of the default", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED, zbopf_depo: FX_DEPENDENT_OK });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "embed_dependent_object",
      node: "ROOT",
      name: "ITEMS_EMB",
      spec: {
        dependentObject: "ZBOPF_DEPO",
        implementationClassRef: { uri: "/sap/bc/adt/oo/classes/zcl_custom_embed", type: "CLAS/OC", name: "ZCL_CUSTOM_EMBED" },
      },
      i_know_this_may_not_activate: true,
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain('adtcore:name="ZCL_CUSTOM_EMBED"');
    expect(putBody).not.toContain("/BOBF/CL_C_BOPF_2_BOPF_SIMPLE");
  });

  it("reports CHECK_FAILED with the HOUSE_SENTENCE when the PUT is accepted (200) but a re-read shows the pair absent, and sends no activation request", async () => {
    const discardPutRoute: FakeRoute = (r) =>
      r.method === "PUT" && r.path === `${BOPF_COLLECTION_PATH}/zbopf_prb1` ? EMPTY_200() : undefined;

    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED, zbopf_depo: FX_DEPENDENT_OK });
    const { conn, server } = await wired({ routes: [discardPutRoute, store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "embed_dependent_object",
      node: "ROOT",
      name: "ITEMS_EMB",
      spec: { dependentObject: "ZBOPF_DEPO" },
      i_know_this_may_not_activate: true,
      activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("CHECK_FAILED");
    expect(String(payload.message)).toContain(
      "A BOPF PUT answers 200 whether or not the server kept what was sent, and nothing was activated.",
    );
    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED); // discarded, as BOPF actually did

    const activationCalls = server.calls.filter((r) => r.method === "POST" && r.path.includes("/sap/bc/adt/activation"));
    expect(activationCalls).toHaveLength(0);
  });
});

describe("remove_dependent_object: round trip against a genuinely embedded pair", () => {
  it("removes both the association and the \"<name>.ROOT\" node written by a prior embed_dependent_object", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED, zbopf_depo: FX_DEPENDENT_OK });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const embedResult = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "embed_dependent_object",
      node: "ROOT",
      name: "ITEMS_EMB",
      spec: { dependentObject: "ZBOPF_DEPO" },
      i_know_this_may_not_activate: true,
    });
    expect(embedResult.isError).toBeFalsy();
    expect(store.get("zbopf_prb1")).toContain('bo:name="ITEMS_EMB.ROOT"');

    const removeResult = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "remove_dependent_object",
      node: "ROOT",
      name: "ITEMS_EMB",
    });

    expect(removeResult.isError).toBeFalsy();
    const finalBody = store.get("zbopf_prb1")!;
    expect(finalBody).not.toContain("ITEMS_EMB.ROOT");
    expect(finalBody).not.toContain('bo:name="ITEMS_EMB"');
  });
});

describe("add_representative_node: shape refusals and a genuine write", () => {
  it("refuses BAD_INPUT when node is given — a representative node has no parent", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED, zbopf_cust: FX_REPRESENTED_BO });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_representative_node",
      node: "ROOT",
      name: "CUST_REF",
      spec: { representedBo: "ZBOPF_CUST" },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("does not take node");
    expect(server.calls.slice(before).some((r) => r.method === "PUT")).toBe(false);
  });

  it("refuses BAD_INPUT when spec.representedBo cannot be read, before any PUT to the host", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_representative_node",
      name: "CUST_REF",
      spec: { representedBo: "ZBOPF_NOPE" },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("ZBOPF_NOPE");
    expect(server.calls.slice(before).some((r) => r.method === "PUT")).toBe(false);
    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED);
  });

  it("writes a parentless node with exactly the KEY/PARENT_KEY/ROOT_KEY properties, no bo:parent/bo:parentNodeID, and discloses the cross-BO-association wire fact", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED, zbopf_cust: FX_REPRESENTED_BO });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_representative_node",
      name: "CUST_REF",
      spec: { representedBo: "ZBOPF_CUST" },
    });

    const text = okText(result);
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain('bo:name="CUST_REF"');
    expect(putBody).not.toContain('bo:parentNodeID');
    // Isolate the CUST_REF node element and check its own bo:parent attribute is absent
    // (bo:parent appears on OTHER elements as an XPath-target keyword too, but not literally
    // as an attribute of this node — a plain substring check on the node's own open tag).
    const openTag = putBody.slice(putBody.indexOf('<bo:nodes bo:name="CUST_REF"'), putBody.indexOf(">", putBody.indexOf('<bo:nodes bo:name="CUST_REF"')) + 1);
    expect(openTag).not.toContain("bo:parent=");
    expect(putBody.match(/bo:name="KEY"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(putBody).toContain('bo:name="PARENT_KEY"');
    expect(putBody).toContain('bo:name="ROOT_KEY"');

    expect(text).toContain("ZBOPF_CUST");
    expect(text).toContain("deliberately NOT written to the node");
  });

  it("refuses BAD_INPUT on a duplicate name via the model preflight, before any PUT", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED, zbopf_cust: FX_REPRESENTED_BO });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_representative_node",
      name: "ROOT", // already exists
      spec: { representedBo: "ZBOPF_CUST" },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("already exists");
    expect(server.calls.slice(before).some((r) => r.method === "PUT")).toBe(false);
  });
});

describe("remove_representative_node: refuses a non-representative node and round-trips a real one", () => {
  it("refuses BAD_INPUT naming remove_node when the target is classified \"root\", not representative", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED, zbopf_cust: FX_REPRESENTED_BO });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "remove_representative_node",
      node: "ROOT",
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("remove_node");
  });

  it("removes a representative node it just added", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED, zbopf_cust: FX_REPRESENTED_BO });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const addResult = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_representative_node",
      name: "CUST_REF",
      spec: { representedBo: "ZBOPF_CUST" },
    });
    expect(addResult.isError).toBeFalsy();
    expect(store.get("zbopf_prb1")).toContain('bo:name="CUST_REF"');

    const removeResult = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "remove_representative_node",
      node: "CUST_REF",
    });
    expect(removeResult.isError).toBeFalsy();
    expect(store.get("zbopf_prb1")).not.toContain('bo:name="CUST_REF"');
  });
});

describe("add_node/add_association refuse a hand-assembled delegation, naming the proper operation", () => {
  it("add_node with doEmbeddingName set is refused, naming embed_dependent_object", async () => {
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
    expect(String(payload.message)).toContain("embed_dependent_object");
    expect(server.calls.slice(before).some((r) => r.method === "PUT")).toBe(false);
  });

  it("add_association with implementationType DoComposition is refused, naming embed_dependent_object", async () => {
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
    expect(String(payload.message)).toContain("embed_dependent_object");
    expect(server.calls.slice(before).some((r) => r.method === "PUT")).toBe(false);
  });

  it("add_node with neither spec.parent/spec.parentNodeId nor rootNode: true is refused, naming add_representative_node", async () => {
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
    expect(String(payload.message)).toContain("add_representative_node");
    expect(server.calls.slice(before).some((r) => r.method === "PUT")).toBe(false);
  });
});

describe("unknown spec keys are rejected per delegation operation (pins OPERATION_FIELDS)", () => {
  it("add_representative_node rejects an unknown spec key", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED, zbopf_cust: FX_REPRESENTED_BO });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_representative_node",
      name: "CUST_REF",
      spec: { representedBo: "ZBOPF_CUST", bogusKey: "x" },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("bogusKey");
    // representedBo must be ACCEPTED (only bogusKey is unrecognised) — otherwise this test
    // would pass merely because the operation itself is unrecognised pre-wiring, flagging
    // every spec key as unknown, representedBo included.
    expect(String(payload.message)).not.toContain("spec.representedBo is not a recognised field");
  });

  it("embed_dependent_object rejects an unknown spec key", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED, zbopf_depo: FX_DEPENDENT_OK });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "embed_dependent_object",
      node: "ROOT",
      name: "ITEMS_EMB",
      spec: { dependentObject: "ZBOPF_DEPO", bogusKey: "x" },
      i_know_this_may_not_activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("bogusKey");
    expect(String(payload.message)).not.toContain("spec.dependentObject is not a recognised field");
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
  });
});

describe("v2 catalogue/handler wiring: the 4 new bopf_* actions are present with one handler each", () => {
  it("BOPF_HANDLERS has all 4 new actions, and ABAP_DO_ACTIONS' bopf group lists them too", () => {
    const newActions = [
      "bopf_add_representative_node",
      "bopf_remove_representative_node",
      "bopf_embed_dependent_object",
      "bopf_remove_dependent_object",
    ];
    for (const action of newActions) {
      expect(BOPF_HANDLERS.has(action)).toBe(true);
    }
    const catalogueActionNames = new Set(ABAP_DO_ACTIONS.map((a) => a.action));
    for (const action of newActions) {
      expect(catalogueActionNames.has(action)).toBe(true);
    }
  });
});
