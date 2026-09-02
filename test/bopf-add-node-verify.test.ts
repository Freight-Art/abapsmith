/**
 * Regression tests: `abap_bopf_edit operation:"add_node"` was
 * a silent no-op. It returned success, `activated: true`, and a
 * `journalEntryId`, while reporting the PRE-call `nodeCount` — no node was
 * ever created. Two causes:
 *
 * 1. The payload was wrong. Every captured non-root `<bo:nodes>` element
 *    carries `bo:parent="#//bo:businessObject/bo:nodes[@bo:name='ROOT']"`
 *    (a name-keyed XPath fragment with an EMPTY base) together with
 *    `bo:parentNodeID="<the parent's bo:nodeID>"` as a matched pair (see
 *    `test/fixtures/bopf/06-request-put-payload.v4.xml`). The old code
 *    passed `spec.parent` through verbatim and never derived
 *    `bo:parentNodeID` at all — BOPF answers 200 and silently discards a
 *    node it can't place.
 * 2. Nothing verified the result. `putModel` already re-GETs after the PUT,
 *    so the server's own contradiction (`nodeCount` unchanged) was in hand
 *    at the moment success was reported.
 *
 * Harness: identical to `test/bopf-tools.test.ts` — a real `AbapConnection`
 * against a `FakeAdtServer`, a real `SafetyGate`, real `errorResult`. Only
 * the HTTP socket and `SessionPool` are fake.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { Journal } from "../src/journal.js";
import { registerBopfTools, type BopfToolDeps } from "../src/tools/bopf.js";

// --------------------------------------------------------------------- fixtures ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const fixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

/** ZBOPF_PRB1, inactive, root-node-only. ROOT's bo:nodeID is GiJj4KTjH+GkgJER+Cx2UA==. */
const FX_JUST_CREATED = fixture("02-created-zbopf_prb1-root-only.v4.xml");
const ROOT_NODE_ID = "GiJj4KTjH+GkgJER+Cx2UA==";

// ----------------------------------------------------------------------- harness ---
// Copied verbatim from test/bopf-tools.test.ts's harness section.

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

function depsFor(
  conn: AbapConnection,
  opts: { safety?: SafetyGate; transport?: SessionTransport; journal?: Journal } = {},
): BopfToolDeps {
  return {
    pool: fakePool(conn),
    safety: opts.safety ?? openGate(),
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: 30_000 },
    transport: opts.transport ?? localTransport(),
    registerWrite: true,
    ...(opts.journal ? { journal: opts.journal } : {}),
  };
}

async function registered(
  conn: AbapConnection,
  opts: { safety?: SafetyGate; transport?: SessionTransport; journal?: Journal } = {},
): Promise<{ tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>; deps: BopfToolDeps }> {
  const { mcp, tools } = fakeMcp();
  const deps = depsFor(conn, opts);
  registerBopfTools(mcp, deps);
  return { tools, deps };
}

/** Same idiom as test/bopf-journal.test.ts's `withJournal` — a real Journal against a temp dir, for the one test that needs a genuine journalEntryId. */
async function withTempJournal<T>(fn: (journal: Journal) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "abapsmith-bopf-add-node-verify-"));
  try {
    return await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ===========================================================================

describe("add_node: parent resolution puts the matched bo:parent/bo:parentNodeID pair on the wire", () => {
  it('resolves spec.parent: "ROOT" against the model, writing the empty-base XPath fragment and the parent\'s real bo:nodeID together, plus bo:rootNode="false"', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_node",
      name: "ITEM",
      spec: { parent: "ROOT" },
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain(`bo:parent="#//bo:businessObject/bo:nodes[@bo:name='ROOT']"`);
    expect(putBody).toContain(`bo:parentNodeID="${ROOT_NODE_ID}"`);
    expect(putBody).toContain('bo:rootNode="false"');
  });

  it("resolves from spec.parentNodeId alone (the exact repro shape), producing the same matched pair", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_node",
      name: "ITEM",
      spec: { parentNodeId: ROOT_NODE_ID },
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain(`bo:parent="#//bo:businessObject/bo:nodes[@bo:name='ROOT']"`);
    expect(putBody).toContain(`bo:parentNodeID="${ROOT_NODE_ID}"`);
  });

  it("refuses BAD_INPUT when neither spec.parent nor spec.parentNodeId is given and spec.rootNode is not true, before any PUT", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_node",
      name: "ITEM",
      spec: {},
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("ITEM");

    const calls = server.calls.slice(before);
    expect(calls.some((r) => r.method === "PUT")).toBe(false);
    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED); // untouched
  });

  it("refuses NOT_FOUND when spec.parent names a node absent from the model, before any PUT (both relock-retry attempts genuinely unlocked)", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_node",
      name: "ITEM",
      spec: { parent: "NOPE" },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("NOT_FOUND");
    // NOT_FOUND is retryable (src/adt/relock.ts's defaultRetryable excludes
    // only SAFETY_DENIED/BAD_INPUT/LOCKED), so withRelockRetry spends both
    // attempts before giving up — same shape as bopf-tools.test.ts's
    // "set_node_flags on an unknown node refuses NOT_FOUND" test.
    expect((payload.details as Record<string, unknown> | undefined)?.attempts).toBe(2);

    const calls = server.calls.slice(before);
    expect(calls.some((r) => r.method === "PUT")).toBe(false);
    const locks = calls.filter((r) => r.method === "POST" && r.qs["_action"] === "LOCK");
    const unlocks = calls.filter((r) => r.method === "POST" && r.qs["_action"] === "UNLOCK");
    expect(locks).toHaveLength(2);
    expect(unlocks).toHaveLength(2);

    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED); // untouched
  });
});

describe("add_node: the write is verified against a re-read, not just the PUT's 200", () => {
  it("returns CHECK_FAILED, not success, when the server accepts the PUT (200) but the re-read shows the node absent and nodeCount unchanged — and sends no activation request even with activate: true", async () => {
    // BOPF's own documented lie: 200 on a PUT it silently discarded.
    // Route this BEFORE store.route so the PUT never actually lands in the
    // backing map — the subsequent re-read GET (putModel's own) then serves
    // back the untouched, root-only fixture: nodeCount 1, no ITEM node.
    const discardPutRoute: FakeRoute = (r) =>
      r.method === "PUT" && r.path === `${BOPF_COLLECTION_PATH}/zbopf_prb1` ? EMPTY_200() : undefined;

    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [discardPutRoute, store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_node",
      name: "ITEM",
      spec: { parent: "ROOT" },
      activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("CHECK_FAILED");
    expect(String(payload.message)).toContain("ITEM");
    expect(String(payload.message)).toContain("1");

    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED); // discarded, as BOPF actually did

    const activationCalls = server.calls.filter(
      (r) => r.method === "POST" && r.path.includes("/sap/bc/adt/activation"),
    );
    expect(activationCalls).toHaveLength(0);
  });

  it("reports CHECK_FAILED with the before/after counts and the journalEntryId when the PUT is accepted but the node is absent, instead of the success-with-nodeCount-1 that was reported before this fix", async () => {
    // Same discarding PUT as case E, but with no activate: true in play at
    // all — isolates the verification itself from the activation-skip
    // assertion above. Pre-fix, this exact call (no activate) returned a
    // SUCCESS with nodeCount: 1 — the unchanged pre-call count — which is
    // the defect being fixed here. A real journal is wired (unlike the rest of
    // this file) because the PUT genuinely landed a journal entry before the
    // verification threw, and that id must survive onto the error's details.
    await withTempJournal(async (journal) => {
      const discardPutRoute: FakeRoute = (r) =>
        r.method === "PUT" && r.path === `${BOPF_COLLECTION_PATH}/zbopf_prb1` ? EMPTY_200() : undefined;

      const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
      const { conn } = await wired({ routes: [discardPutRoute, store.route] });
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "add_node",
        name: "ITEM",
        spec: { parent: "ROOT" },
      });

      const payload = errorPayload(result);
      expect(payload.error).toBe("CHECK_FAILED");
      expect(String(payload.message)).toContain("ITEM");

      const details = payload.details as Record<string, unknown>;
      expect(details.nodeCountBefore).toBe(0);
      expect(details.nodeCountAfter).toBe(0);
      expect(typeof details.journalEntryId).toBe("string");
      expect(details.journalEntryId).toBeTruthy();

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.id).toBe(details.journalEntryId);

      expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED); // discarded, as BOPF actually did
    });
  });

  it("a genuinely successful add_node reports the post-write nodeCount in the response header", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_node",
      name: "ITEM",
      spec: { parent: "ROOT" },
    });

    const text = okText(result);
    expect(text).toContain("nodeCount: 2");
    expect(store.get("zbopf_prb1")).toContain('bo:name="ITEM"');
  });
});
