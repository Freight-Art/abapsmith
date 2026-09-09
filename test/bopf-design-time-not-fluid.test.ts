/**
 * Regression guard for S5b: `abap_bopf`/`abap_bopf_edit`/`abap_bopf_delete`
 * are pure ADT REST design-time tools (`src/tools/bopf.ts`, which has zero
 * references to anything under `src/adt/fluid/`) and must stay OFF the
 * fluid API. `bopfBridgeSource`'s BOPF-test-scenario runner
 * (`src/adt/bopf-runtime.ts`) was assessed for a fluid port in this slice
 * and found not portable — see the S5b report — but that assessment must
 * not silently regress into someone routing the design-time CRUD tools
 * through fluid instead. Two things are asserted: no built-in fluid
 * manifest claims one of these ids, and all three tools still produce a
 * REAL successful outcome with `ABAP_FLUID_API` off, driven the same way
 * `test/bopf-tools.test.ts` drives them (`wired()`, `bopfStore`,
 * `systemRoleProbeResponse` answering the T000 system-role probe).
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
import { BUILTIN_FLUID_TOOLS } from "../src/adt/fluid/builtin/index.js";

describe("BUILTIN_FLUID_TOOLS never claims a BOPF design-time id", () => {
  it("no manifest id is bopf, abap_bopf, abap_bopf_edit, or abap_bopf_delete", () => {
    const bannedIds = new Set(["bopf", "abap_bopf", "abap_bopf_edit", "abap_bopf_delete"]);
    const ids = BUILTIN_FLUID_TOOLS.map((t) => t.manifest.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(bannedIds.has(id)).toBe(false);
    }
  });
});

describe("abap_bopf / abap_bopf_edit / abap_bopf_delete work with ABAP_FLUID_API off", () => {
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
      fluidApi: false,
    });

  const openConnections: AbapConnection[] = [];

  beforeEach(() => {
    __resetFakeAdtCounters();
  });

  afterEach(() => {
    for (const conn of openConnections.splice(0)) conn.dispose();
  });

  async function wired(
    options: { routes?: readonly FakeRoute[] } = {},
  ): Promise<{ conn: AbapConnection; server: FakeAdtServer }> {
    const server = new FakeAdtServer({
      transportErrors: "throw",
      routes: [systemRoleRoute, ...(options.routes ?? [])],
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

  function fakeMcp(): { mcp: McpServer; tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }> } {
    const tools = new Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>();
    const mcp = {
      registerTool: (name: string, _config: unknown, handler: (args: unknown) => Promise<CallToolResult>) => {
        tools.set(name, { handler });
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

  async function registered(
    conn: AbapConnection,
  ): Promise<{ tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }> }> {
    const { mcp, tools } = fakeMcp();
    const deps: BopfToolDeps = {
      pool: fakePool(conn),
      safety: openGate(),
      ensureConnected: async () => {},
      errorResult,
      cfg: { maxResponseChars: 30_000 },
      transport: localTransport(),
      registerWrite: true,
    };
    registerBopfTools(mcp, deps);
    return { tools };
  }

  it("ABAP_FLUID_API resolves to false for this suite's Config", () => {
    expect(cfg().fluidApi).toBe(false);
  });

  it("abap_bopf (read) returns a real digest of the model, not merely a non-error", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf", { bo: "ZBOPF_PRB1" });
    const text = okText(result);
    expect(text).toContain("ZBOPF_PRB1");
    expect(text).toContain("ROOT");
  });

  it("abap_bopf_edit create_bo actually creates the object — bopfStore gains it", async () => {
    const store = bopfStore();
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    expect(store.has("zbopf_new1")).toBe(false);
    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_NEW1",
      operation: "create_bo",
      package: "$TMP",
      description: "s5b regression guard",
    });

    expect(result.isError).toBeFalsy();
    expect(store.has("zbopf_new1")).toBe(true);
  });

  it("abap_bopf_delete (armed, confirmed) actually deletes the object — bopfStore loses it", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    expect(store.has("zbopf_prb1")).toBe(true);
    const result = await invoke(tools, "abap_bopf_delete", {
      bo: "ZBOPF_PRB1",
      dry_run: false,
      confirm: "ZBOPF_PRB1",
    });

    expect(result.isError).toBeFalsy();
    expect(store.has("zbopf_prb1")).toBe(false);
  });
});

/**
 * ZBOPF_PRB1, inactive, root-node-only — the real captured shape
 * `test/bopf-tools.test.ts` reuses across its own suite (same fixture file;
 * loaded here directly rather than duplicated inline, since attribute order
 * in this wire format is load-bearing — see `src/adt/bopf-types.ts`).
 */
const FX_JUST_CREATED = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf", "02-created-zbopf_prb1-root-only.v4.xml"),
  "utf8",
);
