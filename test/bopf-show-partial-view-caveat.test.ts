/**
 * `abap_bopf` mode "show" carries a fixed NOTE caveating that the digest is
 * structural only, config/customizing has no read/write surface at all.
 * Minimal harness copied from `test/bopf-tools.test.ts` (not exported there).
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
import type { SessionPool } from "../src/adt/pool.js";
import { errorResult } from "../src/server.js";
import { registerBopfTools, type BopfToolDeps } from "../src/tools/bopf.js";

const FX_JUST_CREATED = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf", "02-created-zbopf_prb1-root-only.v4.xml"),
  "utf8",
);

const CAVEAT =
  "This digest covers the business object's structural definition only (nodes, associations, actions, " +
  "determinations, validations, queries, alternative keys). It does not include BOPF configuration/" +
  "customizing — abapsmith has no read surface and no write surface of any kind for it.";

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

async function wired(routes: readonly FakeRoute[] = []): Promise<{ conn: AbapConnection }> {
  const server = new FakeAdtServer({ transportErrors: "throw", routes: [systemRoleRoute, ...routes] });
  const client = server.client("s1");
  const conn = new AbapConnection(cfg(), { httpClient: client, log: () => {}, breaker: new AuthCircuitBreaker() });
  openConnections.push(conn);
  await conn.connect();
  return { conn };
}

function fakePool(conn: AbapConnection): SessionPool {
  return {
    withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    withWrite: <T,>(_op: string, _objectUri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    reserveDebug: () => {
      throw new Error("reserveDebug: not used by abap_bopf read.");
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

async function registered(conn: AbapConnection): Promise<Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>> {
  const { mcp, tools } = fakeMcp();
  const deps: BopfToolDeps = {
    pool: fakePool(conn),
    safety: new SafetyGate({ readOnly: false, allowPackages: ["*"] }),
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: 30_000 },
    registerWrite: false,
  } as BopfToolDeps;
  registerBopfTools(mcp, deps);
  return tools;
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

describe("abap_bopf show — partial-view caveat", () => {
  it('mode "show" carries the config/customizing caveat as a NOTE line, alongside the usual digest', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired([store.route]);
    const tools = await registered(conn);

    const text = okText(await invoke(tools, "abap_bopf", { bo: "ZBOPF_PRB1" }));
    expect(text).toContain(CAVEAT);
    expect(text.split("\n")).toContainEqual(`NOTE: ${CAVEAT}`);
    expect(text).toContain("ZBOPF_PRB1");
    expect(text).toContain("ROOT");
  });

  it('mode "raw" does not carry the show-only caveat', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired([store.route]);
    const tools = await registered(conn);

    const text = okText(await invoke(tools, "abap_bopf", { bo: "ZBOPF_PRB1", mode: "raw" }));
    expect(text).not.toContain(CAVEAT);
  });
});
