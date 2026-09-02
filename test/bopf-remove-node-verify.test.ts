/**
 * Regression tests: `abap_bopf_edit` operations `remove_node`
 * and `remove_association` reported success without verifying the removal
 * landed. The fix that added `MEMBER_CHECK_BY_OP` deliberately left both out
 * and flagged them as the follow-up.
 *
 * Two fixes:
 *
 * 1. `remove_node` on the BO's root node is refused BAD_INPUT before any
 *    network call — a BO has exactly one root, and BOPF discards a
 *    root-node removal server-side while still answering 200 (the issue's
 *    own repro: `remove_node` on `ROOT` returns `ok`, `abap_bopf show`
 *    still lists `ROOT`).
 * 2. `remove_node` (any non-root target) now re-reads the model after the
 *    PUT and fails CHECK_FAILED if the node count did not go down, same
 *    pattern as `add_node` and the five `remove_*` member kinds already
 *    verify. `remove_association` is folded into the existing
 *    `MEMBER_CHECK_BY_OP` table, since it already takes node + name like
 *    the other five removals.
 *
 * Harness: identical to `test/bopf-add-node-verify.test.ts` and
 * `test/bopf-remove-operations.test.ts` — a real `AbapConnection` against a
 * `FakeAdtServer`, a real `SafetyGate`, real `errorResult`. Only the HTTP
 * socket and `SessionPool` are fake.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { EMPTY_200, FakeAdtServer, __resetFakeAdtCounters, activationRoute, bopfStore, BOPF_COLLECTION_PATH, type FakeRoute } from "./helpers/fake-adt.js";
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

/** ZBOPF_PRB1, inactive, root-node-only (ROOT, bo:rootNode="true"). */
const FX_JUST_CREATED = fixture("02-created-zbopf_prb1-root-only.v4.xml");

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

/** Same idiom as bopf-add-node-verify.test.ts's `withTempJournal` — a real Journal against a temp dir, for the tests that need a genuine journalEntryId. */
async function withTempJournal<T>(fn: (journal: Journal) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "abapsmith-bopf-remove-node-verify-"));
  try {
    return await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Adds a non-root ITEM node under ROOT via a genuine add_node call, and returns the resulting wire XML, for tests that need a removable non-root node as their starting state. */
async function seedWithItemNode(): Promise<string> {
  const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
  const { conn } = await wired({ routes: [store.route] });
  const { tools } = await registered(conn);
  const added = await invoke(tools, "abap_bopf_edit", {
    bo: "ZBOPF_PRB1",
    operation: "add_node",
    name: "ITEM",
    spec: { parent: "ROOT" },
  });
  expect(added.isError).toBeFalsy();
  return store.get("zbopf_prb1")!;
}

/** Adds an association named TO_ITEM on ROOT via a genuine add_association call, and returns the resulting wire XML. */
async function seedWithAssociation(): Promise<string> {
  const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
  const { conn } = await wired({ routes: [store.route] });
  const { tools } = await registered(conn);
  const added = await invoke(tools, "abap_bopf_edit", {
    bo: "ZBOPF_PRB1",
    operation: "add_association",
    node: "ROOT",
    name: "TO_ITEM",
    spec: {},
  });
  expect(added.isError).toBeFalsy();
  return store.get("zbopf_prb1")!;
}

// ===========================================================================

describe("remove_node: refuses the BO's root node before any PUT", () => {
  it("returns BAD_INPUT naming the node and the BO, with zero PUT calls and the model untouched", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "remove_node",
      node: "ROOT",
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("ROOT");
    expect(String(payload.message)).toContain("abap_bopf_delete");
    const details = payload.details as Record<string, unknown>;
    expect(details.node).toBe("ROOT");
    expect(details.bo).toBe("ZBOPF_PRB1");

    const calls = server.calls.slice(before);
    expect(calls.some((r) => r.method === "PUT")).toBe(false);
    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED); // untouched
  });

  it("matches the root node's name case-insensitively", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "remove_node",
      node: "root",
    });

    expect(errorPayload(result).error).toBe("BAD_INPUT");
    const calls = server.calls.slice(before);
    expect(calls.some((r) => r.method === "PUT")).toBe(false);
  });
});

describe("remove_node: a non-root removal is verified against a re-read, not just the PUT's 200", () => {
  it("returns CHECK_FAILED, not success, when the server accepts the PUT (200) but the re-read still shows the node — with countBefore/countAfter/journalEntryId, and sends no activation request even with activate: true", async () => {
    const seededXml = await seedWithItemNode();

    await withTempJournal(async (journal) => {
      // BOPF's own documented lie: 200 on a PUT it silently
      // discarded. Routed BEFORE store.route so the PUT never lands in the
      // backing map — the subsequent re-read GET (putModel's own) serves
      // back the untouched, pre-removal XML with ITEM still present.
      const discardPutRoute: FakeRoute = (r) =>
        r.method === "PUT" && r.path === `${BOPF_COLLECTION_PATH}/zbopf_prb1` ? EMPTY_200() : undefined;

      const store = bopfStore({ zbopf_prb1: seededXml });
      const { conn, server } = await wired({ routes: [discardPutRoute, store.route, activationRoute({})] });
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "remove_node",
        node: "ITEM",
        activate: true,
      });

      const payload = errorPayload(result);
      expect(payload.error).toBe("CHECK_FAILED");
      expect(String(payload.message)).toContain("ITEM");

      const details = payload.details as Record<string, unknown>;
      expect(details.nodeCountBefore).toBe(1);
      expect(details.nodeCountAfter).toBe(1);
      expect(typeof details.journalEntryId).toBe("string");
      expect(details.journalEntryId).toBeTruthy();

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.id).toBe(details.journalEntryId);

      expect(store.get("zbopf_prb1")).toBe(seededXml); // discarded, as BOPF actually did

      const activationCalls = server.calls.filter((r) => r.method === "POST" && r.path.includes("/sap/bc/adt/activation"));
      expect(activationCalls).toHaveLength(0);
    });
  });

  it("a genuine successful remove_node still succeeds, and the node is actually gone", async () => {
    const seededXml = await seedWithItemNode();
    expect(seededXml).toContain('bo:name="ITEM"');

    const store = bopfStore({ zbopf_prb1: seededXml });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "remove_node",
      node: "ITEM",
    });

    const text = okText(result);
    expect(text).toContain("nodeCount: 1");
    expect(store.get("zbopf_prb1")).not.toContain('bo:name="ITEM"');
  });
});

describe("remove_association: verified against a re-read via MEMBER_CHECK_BY_OP", () => {
  it("returns CHECK_FAILED, not success, when the server accepts the PUT (200) but the re-read still shows the association — with countBefore/countAfter/journalEntryId, and sends no activation request even with activate: true", async () => {
    const seededXml = await seedWithAssociation();

    await withTempJournal(async (journal) => {
      const discardPutRoute: FakeRoute = (r) =>
        r.method === "PUT" && r.path === `${BOPF_COLLECTION_PATH}/zbopf_prb1` ? EMPTY_200() : undefined;

      const store = bopfStore({ zbopf_prb1: seededXml });
      const { conn, server } = await wired({ routes: [discardPutRoute, store.route, activationRoute({})] });
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "remove_association",
        node: "ROOT",
        name: "TO_ITEM",
        activate: true,
      });

      const payload = errorPayload(result);
      expect(payload.error).toBe("CHECK_FAILED");
      expect(String(payload.message)).toContain("TO_ITEM");

      const details = payload.details as Record<string, unknown>;
      expect(details.countBefore).toBe(1);
      expect(details.countAfter).toBe(1);
      expect(typeof details.journalEntryId).toBe("string");
      expect(details.journalEntryId).toBeTruthy();

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.id).toBe(details.journalEntryId);

      expect(store.get("zbopf_prb1")).toBe(seededXml); // discarded, as BOPF actually did

      const activationCalls = server.calls.filter((r) => r.method === "POST" && r.path.includes("/sap/bc/adt/activation"));
      expect(activationCalls).toHaveLength(0);
    });
  });

  it("a genuine successful remove_association still succeeds, and the association is actually gone", async () => {
    const seededXml = await seedWithAssociation();
    expect(seededXml).toContain('bo:associations bo:name="TO_ITEM"');

    const store = bopfStore({ zbopf_prb1: seededXml });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "remove_association",
      node: "ROOT",
      name: "TO_ITEM",
    });

    expect(result.isError).toBeFalsy();
    expect(store.get("zbopf_prb1")).not.toContain('bo:name="TO_ITEM"');
  });
});
