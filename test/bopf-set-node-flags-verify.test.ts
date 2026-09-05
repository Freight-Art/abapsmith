/**
 * Regression tests: `abap_bopf_edit operation:"set_node_flags"` was a silent
 * no-op just like `add_node`/`remove_node` before their own verification was
 * added — the PUT's 200 was trusted without a re-read diff, so a flag, a
 * rename, or a ref BOPF quietly discarded never surfaced. Verifies every
 * flag key and `*Ref` key present in `spec` against the fresh re-read that
 * follows the PUT, per-field rather than all-or-nothing.
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

import {
  EMPTY_200,
  FakeAdtServer,
  __resetFakeAdtCounters,
  activationRoute,
  bopfStore,
  BOPF_COLLECTION_PATH,
  type FakeRoute,
} from "./helpers/fake-adt.js";
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

/** ZBOPF_PRB1, inactive, root-node-only. ROOT is create/update/deleteEnabled, not authorizationCheck/textNode. */
const FX_JUST_CREATED = fixture("02-created-zbopf_prb1-root-only.v4.xml");

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
  const dir = await mkdtemp(join(tmpdir(), "abapsmith-bopf-set-node-flags-verify-"));
  try {
    return await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Same BEFORE-store.route trick as bopf-add-node-verify.test.ts: the PUT never lands in the backing map, so the following re-read GET serves back the fixture untouched. */
const discardPutRoute: FakeRoute = (r) =>
  r.method === "PUT" && r.path === `${BOPF_COLLECTION_PATH}/zbopf_prb1` ? EMPTY_200() : undefined;

// ===========================================================================

describe("set_node_flags: a PUT the server discards is reported as CHECK_FAILED, not success", () => {
  it("a dropped boolean flag is reported, activation is skipped even with activate: true, and the journalEntryId in details is the journal's own", async () => {
    await withTempJournal(async (journal) => {
      // activationRoute is wired so that, on pre-fix code (which has no
      // verification and would proceed straight to activation), the call
      // fails cleanly as "isError should have been true but wasn't" rather
      // than as an unrelated unrouted-activation-request error.
      const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
      const { conn, server } = await wired({ routes: [discardPutRoute, store.route, activationRoute({})] });
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "set_node_flags",
        node: "ROOT",
        spec: { updateEnabled: false },
        activate: true,
      });

      const payload = errorPayload(result);
      expect(payload.error).toBe("CHECK_FAILED");
      expect(String(payload.message)).toContain("updateEnabled: sent false, read back true");

      const details = payload.details as Record<string, unknown>;
      expect(details.mismatches).toEqual([{ field: "updateEnabled", sent: false, readBack: true }]);
      expect(details.bo).toBe("ZBOPF_PRB1");
      expect(details.node).toBe("ROOT");

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(details.journalEntryId).toBe(entries[0]!.id);

      const activationCalls = server.calls.filter(
        (r) => r.method === "POST" && r.path.includes("/sap/bc/adt/activation"),
      );
      expect(activationCalls).toHaveLength(0);

      expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED); // discarded, as BOPF actually did
    });
  });

  it("a dropped rename is reported against the node's old name", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [discardPutRoute, store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_node_flags",
      node: "ROOT",
      spec: { name: "ORDERROOT" },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("CHECK_FAILED");
    expect(String(payload.message)).toContain("name: sent ORDERROOT, read back ROOT");
    const details = payload.details as Record<string, unknown>;
    expect((details.mismatches as Array<Record<string, unknown>>)[0]!.field).toBe("name");
  });

  it("a dropped persistentStructureRef is reported — the repair the tool's own dangling-ref hint prescribes", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [discardPutRoute, store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_node_flags",
      node: "ROOT",
      spec: { persistentStructureRef: { name: "ZTMD_S_ROOT", type: "TABL/DS" } },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("CHECK_FAILED");
    expect(String(payload.message)).toContain("persistentStructureRef: sent ZTMD_S_ROOT (TABL/DS), read back absent");
  });

  it("a dropped clear (null) is reported with the ref that is still there", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [discardPutRoute, store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_node_flags",
      node: "ROOT",
      spec: { combinedStructureRef: null },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("CHECK_FAILED");
    expect(String(payload.message)).toContain("combinedStructureRef: sent cleared, read back ZBOPF_S_ROOT (TABL/DS)");
  });

  it("checks per field, not all-or-nothing: a field the server DID keep is not reported alongside one it dropped", async () => {
    // Prime the store with updateEnabled already false, so only textNode is
    // actually dropped by the discarding PUT — proves the check does not
    // just flag every sent field once any one of them mismatches.
    const variant = FX_JUST_CREATED.replace('bo:updateEnabled="true"', 'bo:updateEnabled="false"');
    expect(variant).not.toBe(FX_JUST_CREATED); // guards against a fixture reshape making this test vacuous

    const store = bopfStore({ zbopf_prb1: variant });
    const { conn } = await wired({ routes: [discardPutRoute, store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_node_flags",
      node: "ROOT",
      spec: { updateEnabled: false, textNode: true },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("CHECK_FAILED");
    expect(String(payload.message)).toContain("did not keep 1 of the field(s) sent");
    expect(String(payload.message)).toContain("textNode: sent true, read back false");
    expect(String(payload.message)).not.toContain("updateEnabled");
    const details = payload.details as Record<string, unknown>;
    expect((details.mismatches as unknown[]).length).toBe(1);
  });
});

describe("set_node_flags: a write the server actually keeps succeeds, with the change on the wire", () => {
  it("a boolean flag that sticks succeeds and is on the PUT body", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_node_flags",
      node: "ROOT",
      spec: { updateEnabled: false },
    });

    okText(result);
    expect(store.get("zbopf_prb1")).toContain('bo:updateEnabled="false"');
  });

  it("a rename that sticks succeeds and is on the PUT body", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_node_flags",
      node: "ROOT",
      spec: { name: "ORDERROOT" },
    });

    okText(result);
    expect(store.get("zbopf_prb1")).toContain('bo:name="ORDERROOT"');
  });

  it("a persistentStructureRef that sticks succeeds and is on the PUT body", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_node_flags",
      node: "ROOT",
      spec: { persistentStructureRef: { name: "ZBOPF_S_ROOT", type: "TABL/DS" } },
    });

    okText(result);
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain("<bo:persistentStructureRef");
    expect(putBody).toContain('adtcore:name="ZBOPF_S_ROOT"');
  });

  it("clearing a flag that reads back as its unsettable-absent false is not reported as a mismatch", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_node_flags",
      node: "ROOT",
      spec: { authorizationCheck: null },
    });

    okText(result);
    expect(store.get("zbopf_prb1")).not.toContain("bo:authorizationCheck=");
  });

  it("an empty spec succeeds — the verification does not fire when nothing was sent", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_node_flags",
      node: "ROOT",
      spec: {},
    });

    okText(result);
    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED);
  });
});
