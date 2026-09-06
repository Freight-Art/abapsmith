/**
 * Regression tests for a still-open gap: nothing checked that an
 * `add_alternative_key` payload actually refers to things that exist on the
 * target node before sending it. `alternativeKeyPreflight` (src/tools/bopf.ts)
 * adds two checks, both derivable for free from the model already read:
 *
 * 1. every `spec.keyElements` entry must name a `bo:properties/@bo:name` that
 *    exists on the SAME node. All 3 captured `bo:alternativeKeys` elements in
 *    `test/fixtures/bopf/01-get-demo_sales_order.v4.xml` satisfy this; the
 *    issue's original repro named `TORDER_ID` against a node
 *    (`02-created-zbopf_prb1-root-only.v4.xml`'s ROOT) that has only
 *    KEY/PARENT_KEY/ROOT_KEY.
 * 2. the node must carry a `bo:persistentStructureRef` — both nodes carrying
 *    an alternative key in the capture (ROOT, ITEM) have one; a node without
 *    one has no DDIC structure at all and cannot be activated.
 *
 * NEITHER check is a confirmed cause of the `/BOBF/CL_CONF_MODEL_API_MAP`
 * short dump — that correlation is inferred from the captured wire XML, not
 * reproduced live. Both are overridable with `allow_dangling_ref: true`,
 * same escape hatch `actionRefPreflight` already uses for its own dangling
 * class/action refs.
 *
 * Harness: copied verbatim from `test/bopf-alternative-key-payload.test.ts`
 * — a real `AbapConnection` against a `FakeAdtServer`, a real `SafetyGate`,
 * real `errorResult`. Only the HTTP socket and `SessionPool` are fake.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { FakeAdtServer, __resetFakeAdtCounters, bopfStore, type FakeRoute } from "./helpers/fake-adt.js";
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

// --------------------------------------------------------------------- fixtures ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const fixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

/** ZBOPF_PRB1, inactive, root-node-only. ROOT has properties KEY/PARENT_KEY/ROOT_KEY, no persistentStructureRef. */
const FX_JUST_CREATED = fixture("02-created-zbopf_prb1-root-only.v4.xml");

/**
 * Same fixture with a `bo:persistentStructureRef` spliced onto ROOT — string
 * surgery on the captured fixture text, not a new/modified fixture file. Used
 * only to prove the "everything present" path clears the preflight; not a
 * claim this exact structure name is realistic.
 */
const PERSISTENT_STRUCTURE_REF = '<bo:persistentStructureRef adtcore:type="TABL/DS" adtcore:name="ZBOPF_S_ROOT"/>';
const FX_WITH_STRUCTURE = (() => {
  const marker = '<bo:combinedStructureRef';
  const idx = FX_JUST_CREATED.indexOf(marker);
  if (idx === -1) throw new Error("fixture 02 no longer has bo:combinedStructureRef — update the splice point");
  return FX_JUST_CREATED.slice(0, idx) + PERSISTENT_STRUCTURE_REF + FX_JUST_CREATED.slice(idx);
})();

const COMPLETE_SPEC = {
  uniqueness: "unique",
  dataTypeRef: { name: "ZSORDER_ID", type: "TABL/DS" },
  dataTableTypeRef: { name: "ZTORDER_ID", type: "TTYP/DA" },
  noCheck: true,
};

// ----------------------------------------------------------------------- harness ---
// Copied verbatim from test/bopf-alternative-key-payload.test.ts's harness section.

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

describe("add_alternative_key: keyElements must exist as properties on the target node", () => {
  it("refuses a single non-existent key element with BOPF_DANGLING_REF, naming it and the properties that DO exist, and sends no PUT", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...COMPLETE_SPEC, keyElements: ["TORDER_ID"] },
      i_know_this_may_not_activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BOPF_DANGLING_REF");
    expect(String(payload.message)).toContain("TORDER_ID");
    expect(String(payload.message)).toContain("KEY");
    expect(String(payload.message)).toContain("PARENT_KEY");
    expect(String(payload.message)).toContain("ROOT_KEY");
    const details = payload.details as Record<string, unknown>;
    expect(details.operation).toBe("add_alternative_key");
    expect(details.node).toBe("ROOT");
    expect(details.missing).toEqual(["TORDER_ID"]);
    expect(details.available).toEqual(["KEY", "PARENT_KEY", "ROOT_KEY"]);

    // Refused before any lock/write — no PUT went out, and the fixture is untouched.
    expect(server.calls.slice(before).some((r) => r.method === "PUT")).toBe(false);
    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED);
  });

  it("names ALL missing key elements in one error, not just the first", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...COMPLETE_SPEC, keyElements: ["TORDER_ID", "CUSTOMER_ID", "KEY"] },
      i_know_this_may_not_activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BOPF_DANGLING_REF");
    expect(String(payload.message)).toContain("TORDER_ID");
    expect(String(payload.message)).toContain("CUSTOMER_ID");
    const details = payload.details as Record<string, unknown>;
    // KEY exists on ROOT, so only the two genuinely-missing names are reported.
    expect(details.missing).toEqual(["TORDER_ID", "CUSTOMER_ID"]);

    expect(server.calls.slice(before).some((r) => r.method === "PUT")).toBe(false);
  });
});

describe("add_alternative_key: the target node must have a persistentStructureRef", () => {
  it("refuses a node with no persistentStructureRef even when every key element exists (a live-retry payload: keyElements: [\"KEY\"])", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...COMPLETE_SPEC, keyElements: ["KEY"] },
      i_know_this_may_not_activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BOPF_DANGLING_REF");
    expect(String(payload.message)).toContain("persistentStructureRef");
    expect(String(payload.message)).toContain("ROOT");
    const details = payload.details as Record<string, unknown>;
    expect(details.operation).toBe("add_alternative_key");
    expect(details.node).toBe("ROOT");

    expect(server.calls.slice(before).some((r) => r.method === "PUT")).toBe(false);
    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED);
  });
});

describe("add_alternative_key: allow_dangling_ref: true overrides both checks", () => {
  it("lets a missing key element through to the PUT", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...COMPLETE_SPEC, keyElements: ["TORDER_ID"] },
      i_know_this_may_not_activate: true,
      allow_dangling_ref: true,
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain('bo:name="ALT1"');
    expect(putBody).toContain("TORDER_ID");
  });

  it("lets a missing persistentStructureRef through to the PUT", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...COMPLETE_SPEC, keyElements: ["KEY"] },
      i_know_this_may_not_activate: true,
      allow_dangling_ref: true,
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain('bo:name="ALT1"');
  });
});

describe("add_alternative_key: a node with both preconditions satisfied clears the preflight", () => {
  it("keyElements naming an existing property, on a node with a persistentStructureRef, reaches the PUT", async () => {
    expect(FX_WITH_STRUCTURE).not.toBe(FX_JUST_CREATED);
    expect(FX_WITH_STRUCTURE).toContain(PERSISTENT_STRUCTURE_REF);

    const store = bopfStore({ zbopf_prb1: FX_WITH_STRUCTURE });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...COMPLETE_SPEC, keyElements: ["KEY"] },
      i_know_this_may_not_activate: true,
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain('bo:name="ALT1"');
    expect(putBody).toContain("<bo:keyElements");
  });
});

describe("add_alternative_key preflight does not affect unrelated operations", () => {
  it("add_association on the same structure-less node is unaffected", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_association",
      node: "ROOT",
      name: "MY_ASSOC",
      spec: {},
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain('bo:name="MY_ASSOC"');
  });
});
