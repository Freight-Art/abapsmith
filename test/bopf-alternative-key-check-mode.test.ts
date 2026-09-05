/**
 * Regression tests: `abap_bopf_edit` refuses, client-side, the alternative-key
 * uniqueness/check-flag combinations that make BOPF's model mapper
 * (`/BOBF/CL_CONF_MODEL_API_MAP`) execute `ASSERT 1 = 0` on its
 * `uniqueness_check` `CASE` and kill the ADT session. The three wire
 * attributes `checkAfterModify`/`checkBeforeSave`/`noCheck` all map onto that
 * one server-side field; only one specific combination per `uniqueness` value
 * has a matching `CASE` arm. The rule enforced by `validateAlternativeKeyCheckMode`
 * (`src/tools/bopf.ts`) was established by measuring which combinations have
 * a matching arm and which fall to `WHEN OTHERS`.
 *
 * `add_alternative_key`'s check runs inside `validateAlternativeKeySpec`,
 * itself inside `validateEditInputShape` — zero-network, ahead of
 * `ensureConnected()`. `set_alternative_key_fields`'s check
 * (`alternativeKeyCheckModePreflight`) runs after the model read, against the
 * EFFECTIVE post-patch state (existing key, spec's fields layered on top),
 * since a patch can introduce the dangerous combination without ever
 * mentioning `uniqueness` itself. Neither check is overridable by
 * `allow_dangling_ref` — the refused combinations have no mapper arm at all,
 * so no override makes them succeed.
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

const DATA_TYPE_REF = { name: "ZSORDER_ID", type: "TABL/DS" };
const DATA_TABLE_TYPE_REF = { name: "ZTORDER_ID", type: "TTYP/DA" };

/** No uniqueness, no check flag — every test below adds those itself. */
const BASE_SPEC = {
  dataTypeRef: DATA_TYPE_REF,
  dataTableTypeRef: DATA_TABLE_TYPE_REF,
  keyElements: ["KEY"],
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

describe("add_alternative_key: uniqueness/check-flag combination is refused client-side, zero-network", () => {
  it('"unique" with no check flag needs exactly one of checkAfterModify or noCheck', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const before = callsAfterConnect(server);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...BASE_SPEC, uniqueness: "unique" },
      i_know_this_may_not_activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("needs exactly one of");
    const details = payload.details as Record<string, unknown>;
    expect(details.operation).toBe("add_alternative_key");
    expect(details.name).toBe("ALT1");
    expect(details.uniqueness).toBe("unique");

    expect(callsAfterConnect(server)).toBe(before);
  });

  it('"uniqueIfNotInitial" with no check flag needs exactly one of checkAfterModify or noCheck', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const before = callsAfterConnect(server);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...BASE_SPEC, uniqueness: "uniqueIfNotInitial" },
      i_know_this_may_not_activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("needs exactly one of");
    const details = payload.details as Record<string, unknown>;
    expect(details.uniqueness).toBe("uniqueIfNotInitial");

    expect(callsAfterConnect(server)).toBe(before);
  });

  it('"uniqueIfNotInitial" with checkBeforeSave: true is refused — checkBeforeSave has no supported arm', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const before = callsAfterConnect(server);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...BASE_SPEC, uniqueness: "uniqueIfNotInitial", checkBeforeSave: true },
      i_know_this_may_not_activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("checkBeforeSave is currently not supported");
    const details = payload.details as Record<string, unknown>;
    expect(details.uniqueness).toBe("uniqueIfNotInitial");
    expect(details.checkBeforeSave).toBe(true);

    expect(callsAfterConnect(server)).toBe(before);
  });

  it('"notUnique" with checkBeforeSave: true is refused too — rule applies on any uniqueness', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const before = callsAfterConnect(server);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...BASE_SPEC, uniqueness: "notUnique", checkBeforeSave: true },
      i_know_this_may_not_activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("checkBeforeSave is currently not supported");
    const details = payload.details as Record<string, unknown>;
    expect(details.uniqueness).toBe("notUnique");
    expect(details.checkBeforeSave).toBe(true);

    expect(callsAfterConnect(server)).toBe(before);
  });

  it("more than one check flag true is refused even though rule 3 would otherwise be satisfied", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const before = callsAfterConnect(server);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...BASE_SPEC, uniqueness: "uniqueIfNotInitial", noCheck: true, checkAfterModify: true },
      i_know_this_may_not_activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("at most one of");
    const details = payload.details as Record<string, unknown>;
    expect(details.noCheck).toBe(true);
    expect(details.checkAfterModify).toBe(true);

    expect(callsAfterConnect(server)).toBe(before);
  });

  it('"notUnique" with checkAfterModify: true is refused — no matching mapper arm', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const before = callsAfterConnect(server);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...BASE_SPEC, uniqueness: "notUnique", checkAfterModify: true },
      i_know_this_may_not_activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("has no matching arm");
    const details = payload.details as Record<string, unknown>;
    expect(details.uniqueness).toBe("notUnique");
    expect(details.checkAfterModify).toBe(true);

    expect(callsAfterConnect(server)).toBe(before);
  });

  it("explicitly-false check flags do not satisfy the exactly-one-of rule", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const before = callsAfterConnect(server);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: {
        ...BASE_SPEC,
        uniqueness: "unique",
        checkAfterModify: false,
        checkBeforeSave: false,
        noCheck: false,
      },
      i_know_this_may_not_activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("needs exactly one of");
    const details = payload.details as Record<string, unknown>;
    expect(details.checkAfterModify).toBe(false);
    expect(details.checkBeforeSave).toBe(false);
    expect(details.noCheck).toBe(false);

    expect(callsAfterConnect(server)).toBe(before);
  });

  it("allow_dangling_ref: true does not bypass the check-mode refusal", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const before = callsAfterConnect(server);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...BASE_SPEC, uniqueness: "unique" },
      i_know_this_may_not_activate: true,
      allow_dangling_ref: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(payload.error).not.toBe("BOPF_DANGLING_REF");
    expect(String(payload.message)).toContain("needs exactly one of");
    const details = payload.details as Record<string, unknown>;
    expect(details.uniqueness).toBe("unique");

    expect(callsAfterConnect(server)).toBe(before);
  });
});

describe("add_alternative_key: check-mode refusal comes after the existing enum/shape checks", () => {
  it("an invalid uniqueness value still refuses with the enum message, not the check-mode one", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const before = callsAfterConnect(server);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...BASE_SPEC, uniqueness: "sometimes" },
      i_know_this_may_not_activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain('"unique"');
    expect(String(payload.message)).toContain('"uniqueIfNotInitial"');
    expect(String(payload.message)).toContain('"notUnique"');
    expect(String(payload.message)).not.toContain("needs exactly one of");

    expect(callsAfterConnect(server)).toBe(before);
  });

  it("a spec missing dataTypeRef still refuses with the missing-fields message, not the check-mode one", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const before = callsAfterConnect(server);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { uniqueness: "unique", dataTableTypeRef: DATA_TABLE_TYPE_REF, keyElements: ["KEY"] },
      i_know_this_may_not_activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("is missing required spec fields");
    expect(String(payload.message)).toContain("dataTypeRef");
    const details = payload.details as Record<string, unknown>;
    expect(details.missing).toEqual(["dataTypeRef"]);

    expect(callsAfterConnect(server)).toBe(before);
  });
});

describe("add_alternative_key: accepted check-flag combinations reach the wire", () => {
  it('"uniqueIfNotInitial" + noCheck: true lands on the wire and in the store', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...BASE_SPEC, uniqueness: "uniqueIfNotInitial", noCheck: true },
      i_know_this_may_not_activate: true,
      allow_dangling_ref: true,
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain('bo:name="ALT1"');
    expect(putBody).toContain('bo:noCheck="true"');
  });

  it('"uniqueIfNotInitial" + checkAfterModify: true succeeds', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...BASE_SPEC, uniqueness: "uniqueIfNotInitial", checkAfterModify: true },
      i_know_this_may_not_activate: true,
      allow_dangling_ref: true,
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain('bo:name="ALT1"');
    expect(putBody).toContain('bo:checkAfterModify="true"');
  });

  it('"notUnique" with no check flag succeeds — rule 3 only applies to unique/uniqueIfNotInitial', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...BASE_SPEC, uniqueness: "notUnique" },
      i_know_this_may_not_activate: true,
      allow_dangling_ref: true,
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain('bo:name="ALT1"');
    expect(putBody).toContain('bo:uniqueness="notUnique"');
  });

  it("a successful add_alternative_key response carries the activation note", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...BASE_SPEC, uniqueness: "notUnique" },
      i_know_this_may_not_activate: true,
      allow_dangling_ref: true,
    });

    const text = okText(result);
    expect(text).toContain("no alternative key added through this tool has been observed to activate");
  });
});

describe("set_alternative_key_fields: check-mode preflight covers the effective post-patch state", () => {
  it("clearing the last check flag with noCheck: null is refused and sends no PUT", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const added = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...BASE_SPEC, uniqueness: "unique", noCheck: true },
      i_know_this_may_not_activate: true,
      allow_dangling_ref: true,
    });
    expect(added.isError).toBeFalsy();
    const afterAdd = store.get("zbopf_prb1")!;

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_alternative_key_fields",
      node: "ROOT",
      name: "ALT1",
      spec: { noCheck: null },
      i_know_this_may_not_activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("needs exactly one of");
    const details = payload.details as Record<string, unknown>;
    expect(details.operation).toBe("set_alternative_key_fields");
    expect(details.name).toBe("ALT1");
    expect(details.uniqueness).toBe("unique");
    expect(details.noCheck).toBeUndefined();
    expect(details.checkAfterModify).toBeUndefined();

    expect(store.get("zbopf_prb1")).toBe(afterAdd);
  });

  it("a uniqueness-only patch is accepted because the key's existing noCheck still satisfies the rule", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const added = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...BASE_SPEC, uniqueness: "unique", noCheck: true },
      i_know_this_may_not_activate: true,
      allow_dangling_ref: true,
    });
    expect(added.isError).toBeFalsy();
    const afterAdd = store.get("zbopf_prb1")!;

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_alternative_key_fields",
      node: "ROOT",
      name: "ALT1",
      spec: { uniqueness: "uniqueIfNotInitial" },
      i_know_this_may_not_activate: true,
    });

    expect(result.isError).toBeFalsy();
    expect(store.get("zbopf_prb1")).not.toBe(afterAdd);
    expect(store.get("zbopf_prb1")).toContain('bo:uniqueness="uniqueIfNotInitial"');
    expect(store.get("zbopf_prb1")).toContain('bo:noCheck="true"');
  });

  it("patching checkBeforeSave: true onto an existing key is refused", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const added = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...BASE_SPEC, uniqueness: "unique", noCheck: true },
      i_know_this_may_not_activate: true,
      allow_dangling_ref: true,
    });
    expect(added.isError).toBeFalsy();
    const afterAdd = store.get("zbopf_prb1")!;

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_alternative_key_fields",
      node: "ROOT",
      name: "ALT1",
      spec: { checkBeforeSave: true },
      i_know_this_may_not_activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("checkBeforeSave is currently not supported");
    const details = payload.details as Record<string, unknown>;
    expect(details.checkBeforeSave).toBe(true);

    expect(store.get("zbopf_prb1")).toBe(afterAdd);
  });

  it("a key name that doesn't exist on the node fails NOT_FOUND, not the check-mode BAD_INPUT", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_alternative_key_fields",
      node: "ROOT",
      name: "NOPE",
      spec: { uniqueness: "unique" },
      i_know_this_may_not_activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("NOT_FOUND");
    expect(String(payload.message)).toContain("no alternative key of that name exists");
  });
});
