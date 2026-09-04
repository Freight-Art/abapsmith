/**
 * Regression tests: `MEMBER_CHECK_BY_OP` had no entry for `add_association`,
 * `add_action`, `add_determination`, `add_validation`, or `add_query` — only
 * `add_alternative_key` and the `remove_*` operations were verified against
 * a post-PUT re-read. A BOPF PUT answers 200 whether or not the server kept
 * what was sent, so each of those five reported success even when the
 * element it claimed to add was never actually on the node.
 *
 * `add_association` gets an extra wrinkle: `add_node` auto-creates a
 * ROOT→child Composition association (plus TO_PARENT/TO_ROOT on the child),
 * so a subsequent explicit `add_association` for that same link is discarded
 * server-side as a duplicate. When the re-read shows an existing association
 * with the same `implementationType` and resolved target node, the
 * `CHECK_FAILED` names it instead of reporting a bare miss.
 *
 * Harness: identical to `test/bopf-add-node-verify.test.ts` and
 * `test/bopf-remove-operations.test.ts` — a real `AbapConnection` against a
 * `FakeAdtServer`, a real `SafetyGate`, real `errorResult`. Only the HTTP
 * socket and `SessionPool` are fake.
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

// --------------------------------------------------------------------- fixtures ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const fixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

/**
 * ZBOPF_PRB1, inactive, one node (ROOT). ROOT already carries two queries
 * (SELECT_ALL, SELECT_BY_ELEMENTS) and one action (LOCK_ROOT) from creation —
 * no associations, determinations, or validations (see
 * test/bopf-remove-operations.test.ts's fixture comment). Member names below
 * avoid those three pre-existing names.
 */
const FX_JUST_CREATED = fixture("02-created-zbopf_prb1-root-only.v4.xml");

/**
 * ZBOPF_PRB1 with a second node ITEM, and a ROOT→ITEM Composition
 * association named "ITEM" (bo:targetNodeRef name "ZBOPF_PRB1~ITEM", uri
 * ending `bo:nodes[@bo:name='ITEM']`) — the auto-created link `add_node`
 * leaves behind, and the shape `add_association` collides with.
 */
const FX_ITEM_ASSOC = fixture("03-after-put-item-node-and-assoc.v4.xml");
const ITEM_TARGET_REF = {
  name: "ZBOPF_PRB1~ITEM",
  type: "BOBF",
  uri: "/sap/bc/adt/bopf/businessobjects/zbopf_prb1#//bo:businessObject/bo:nodes[@bo:name='ITEM']",
};

// ----------------------------------------------------------------------- harness ---
// Copied verbatim from test/bopf-remove-operations.test.ts's harness section.

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

/**
 * BOPF's own documented lie: 200 on a PUT it silently discarded. Routed
 * BEFORE `store.route` so the PUT never actually lands in the backing map —
 * the subsequent re-read GET (putModel's own) serves back the untouched
 * fixture, so the model shows no trace of the requested add.
 */
const discardPutRoute: FakeRoute = (r) =>
  r.method === "PUT" && r.path === `${BOPF_COLLECTION_PATH}/zbopf_prb1` ? EMPTY_200() : undefined;

// ===========================================================================

interface AddCase {
  readonly operation: string;
  readonly name: string;
  readonly spec: Record<string, unknown>;
}

const ADD_TABLE: readonly AddCase[] = [
  { operation: "add_association", name: "TO_ITEM", spec: {} },
  { operation: "add_action", name: "MY_ACTION", spec: {} },
  { operation: "add_determination", name: "MY_DET", spec: { category: "reactDuringSave" } },
  { operation: "add_validation", name: "MY_VAL", spec: { category: "consistencyCheck" } },
  { operation: "add_query", name: "MY_QUERY", spec: { category: "selectAll" } },
];

describe("each of the five add_* operations is verified against a re-read, not just the PUT's 200", () => {
  it.each(ADD_TABLE.map((c) => [c.operation, c] as const))(
    "%s: a discarded PUT reports CHECK_FAILED naming the operation, member, and node — after actually attempting the PUT",
    async (_op, c) => {
      const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
      const { conn, server } = await wired({ routes: [discardPutRoute, store.route] });
      const { tools } = await registered(conn);

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: c.operation,
        node: "ROOT",
        name: c.name,
        spec: c.spec,
      });

      const payload = errorPayload(result);
      expect(payload.error).toBe("CHECK_FAILED");
      const message = String(payload.message);
      expect(message).toContain(c.operation);
      expect(message).toContain(c.name);
      expect(message).toContain("ROOT");

      // Proves this is a post-write check, not a pre-flight refusal: the PUT
      // genuinely went out, and the store kept the pre-write bytes because
      // discardPutRoute answered it before store.route ever saw it.
      const puts = server.calls.filter((r) => r.method === "PUT" && r.path === `${BOPF_COLLECTION_PATH}/zbopf_prb1`);
      expect(puts).toHaveLength(1);
      expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED);
    },
  );
});

// ===========================================================================

describe("a genuine add_* is unaffected by the new check", () => {
  it("add_association succeeds when the PUT actually lands", async () => {
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
    expect(store.get("zbopf_prb1")).toContain('bo:name="MY_ASSOC"');
  });

  it("add_determination succeeds when the PUT actually lands", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET",
      spec: { category: "reactDuringSave" },
    });

    expect(result.isError).toBeFalsy();
    expect(store.get("zbopf_prb1")).toContain('bo:name="MY_DET"');
  });
});

// ===========================================================================

describe("add_association: a discarded duplicate names the existing equivalent association", () => {
  it('CHECK_FAILED for a Composition→ITEM request matching the pre-existing "ITEM" association mentions "already present", "duplicate", and the existing name', async () => {
    const store = bopfStore({ zbopf_prb1: FX_ITEM_ASSOC });
    const { conn } = await wired({ routes: [discardPutRoute, store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_association",
      node: "ROOT",
      name: "TO_ITEM",
      spec: { implementationType: "Composition", targetNodeRef: ITEM_TARGET_REF },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("CHECK_FAILED");
    const message = String(payload.message);
    expect(message).toContain("already present");
    expect(message).toContain("duplicate");
    expect(message).toContain("ITEM");

    const details = payload.details as Record<string, unknown>;
    const equivalent = details.existingEquivalent as Record<string, unknown>;
    expect(equivalent.name).toBe("ITEM");
    expect(equivalent.implementationType).toBe("Composition");
    expect(equivalent.targetNode).toBe("ITEM");

    expect(store.get("zbopf_prb1")).toBe(FX_ITEM_ASSOC);
  });

  it("a request with a non-matching implementationType/target gets the plain CHECK_FAILED, not the duplicate wording", async () => {
    const store = bopfStore({ zbopf_prb1: FX_ITEM_ASSOC });
    const { conn } = await wired({ routes: [discardPutRoute, store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_association",
      node: "ROOT",
      name: "TO_ITEM2",
      spec: { implementationType: "Association", targetNodeRef: ITEM_TARGET_REF },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("CHECK_FAILED");
    const message = String(payload.message);
    expect(message).not.toContain("already present");
    expect((payload.details as Record<string, unknown>).existingEquivalent).toBeUndefined();

    expect(store.get("zbopf_prb1")).toBe(FX_ITEM_ASSOC);
  });
});
