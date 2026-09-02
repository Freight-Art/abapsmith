/**
 * Regression tests for three defects found by live testing against a real
 * SAP A4H system, all traced to `src/tools/bopf.ts` (`abap_bopf_edit`):
 *
 * 1. CRITICAL — `add_validation` short-dumps the ABAP session. Root cause:
 *    nothing validated `spec.category` against `ValidationCategoryType`'s
 *    closed, wire-confirmed enumeration (`consistencyCheck` | `actionCheck`)
 *    before splicing it onto the
 *    wire — an unrecognised category reaching BOPF's kernel-side generator
 *    during activation is a plausible, cheap explanation for an uncaught
 *    dump. Fixed by `strEnum` refusing client-side (BAD_INPUT) before any
 *    lock is taken.
 * 2. HIGH — `add_determination`/`add_validation` triggers never actually
 *    attach. Root cause: `bo:triggers/@bo:node` and `@bo:association` are
 *    NOT bare names — they are name-keyed XPath fragments anchored on the
 *    owning BO's own percent-encoded name (`[WIRE]`-confirmed). The old code sent the caller's bare node
 *    name straight through, which the server cannot resolve. Fixed by
 *    `boNodeRef`/`boAssociationRef`/`boDeterminationRef` building the real
 *    reference while keeping the tool's own input surface (bare names)
 *    unchanged for callers.
 * 3. MED — the literal JS string `"undefined"` (and `"null"`) could reach a
 *    wire payload as a literal XML attribute value. Fixed structurally: the
 *    one place every attribute value passes through before hitting the wire
 *    (`escapeAttrValue` in `bopf-xml.ts`, and its hand-rolled sibling
 *    `xmlEscape` in `bopf.ts`'s `buildCreateBody`) now refuses those two
 *    literal strings outright (BAD_INPUT) rather than escaping-and-passing
 *    them through.
 *
 * Harness: identical to `test/bopf-tools.test.ts` — a real `AbapConnection`
 * against a `FakeAdtServer`, a real `SafetyGate`, real `errorResult`. Only
 * the HTTP socket and `SessionPool` are fake.
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

/** ZBOPF_PRB1, inactive, root-node-only — the just-created shape (same fixture bopf-tools.test.ts uses). */
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
// Defect 1 (CRITICAL): add_validation short-dumps A4H — invalid category.
// ===========================================================================

describe("defect 1: add_validation category is validated client-side against the closed wire enumeration", () => {
  it('rejects an unrecognised category (e.g. "undefined", "reactAfterModification" — a determination-only value) with BAD_INPUT naming the two legal values, before any lock is taken', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_validation",
      node: "ROOT",
      name: "MY_VALIDATION",
      spec: { category: "reactAfterModification" },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("category");
    expect(String(payload.message)).toContain("consistencyCheck");
    expect(String(payload.message)).toContain("actionCheck");

    const calls = server.calls.slice(before);
    expect(calls.some((r) => r.method === "PUT")).toBe(false);
    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED); // untouched
  });

  it('rejects the literal string "undefined" as category', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_validation",
      node: "ROOT",
      name: "MY_VALIDATION",
      spec: { category: "undefined" },
    });

    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED); // untouched
  });

  it("accepts either legal category (consistencyCheck, actionCheck) and writes it verbatim", async () => {
    for (const category of ["consistencyCheck", "actionCheck"]) {
      const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
      const { conn } = await wired({ routes: [store.route] });
      const { tools } = await registered(conn);

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "add_validation",
        node: "ROOT",
        name: "MY_VALIDATION",
        spec: { category },
      });

      expect(result.isError).toBeFalsy();
      expect(store.get("zbopf_prb1")).toContain(`bo:category="${category}"`);
    }
  });

  it("add_query's category is validated the same way (selectAll, selectByElements, customQuery)", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const bad = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_query",
      node: "ROOT",
      name: "MY_QUERY",
      spec: { category: "bogus" },
    });
    expect(errorPayload(bad).error).toBe("BAD_INPUT");

    const good = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_query",
      node: "ROOT",
      name: "MY_QUERY2",
      spec: { category: "selectAll" },
    });
    expect(good.isError).toBeFalsy();
    expect(store.get("zbopf_prb1")).toContain('bo:category="selectAll"');
  });
});

// ===========================================================================
// Defect 2 (HIGH): add_determination/add_validation triggers never attach.
// ===========================================================================

describe("defect 2: determination/validation triggers are written as resolvable node/association references, not bare names", () => {
  it("add_determination with a node-based trigger writes bo:node as the full name-keyed XPath reference, not the bare node name", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET",
      spec: { triggers: [{ node: "ROOT", create: true, update: true }] },
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    // The old (broken) shape was literally bo:node="ROOT" — never resolvable.
    expect(putBody).not.toContain('bo:node="ROOT"');
    expect(putBody).toContain("<bo:triggers ");
    expect(putBody).toContain(`bo:node="${encodeURIComponent("zbopf_prb1")}#//bo:businessObject/bo:nodes[@bo:name='ROOT']"`);
    expect(putBody).toContain('bo:create="true"');
    expect(putBody).toContain('bo:update="true"');
  });

  it("add_validation with a node-based trigger gets the same reference treatment", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_validation",
      node: "ROOT",
      name: "MY_VAL",
      spec: { category: "consistencyCheck", triggers: [{ node: "ROOT", check: true }] },
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain(`bo:node="${encodeURIComponent("zbopf_prb1")}#//bo:businessObject/bo:nodes[@bo:name='ROOT']"`);
    expect(putBody).toContain('bo:check="true"');
  });

  it("a trigger naming an association also nests it under the owning node's predicate", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET2",
      spec: { triggers: [{ node: "ROOT", association: "TO_ITEM", create: true }] },
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain(
      `bo:association="${encodeURIComponent("zbopf_prb1")}#//bo:businessObject/bo:nodes[@bo:name='ROOT']/bo:associations[@bo:name='TO_ITEM']"`,
    );
  });

  it("a trigger with association but no node is refused client-side (BAD_INPUT) rather than silently dropped or sent malformed", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET3",
      spec: { triggers: [{ association: "TO_ITEM", create: true }] },
    });

    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(server.calls.slice(before).some((r) => r.method === "PUT")).toBe(false);
    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED); // untouched — no silent partial write
  });

  it("relations get the same node/determination reference treatment", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET4",
      spec: { relations: [{ node: "ROOT", determination: "OTHER_DET", relationType: "predecessor" }] },
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain(
      `bo:determination="${encodeURIComponent("zbopf_prb1")}#//bo:businessObject/bo:nodes[@bo:name='ROOT']/bo:determinations[@bo:name='OTHER_DET']"`,
    );
    expect(putBody).toContain('bo:relationType="predecessor"');
  });
});

// ===========================================================================
// Defect 3 (MED): literal "undefined"/"null" reaching a wire payload.
// ===========================================================================

describe('defect 3: literal "undefined"/"null" strings can never reach a wire payload as attribute values', () => {
  it('add_determination refuses spec.xmlName: "undefined" (BAD_INPUT), no partial write lands', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET",
      spec: { xmlName: "undefined" },
    });

    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(server.calls.slice(before).some((r) => r.method === "PUT")).toBe(false);
    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED);
  });

  it('add_action refuses spec.xmlName: "null"', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_action",
      node: "ROOT",
      name: "MY_ACTION",
      spec: { xmlName: "null" },
    });

    expect(errorPayload(result).error).toBe("BAD_INPUT");
  });

  it('a legitimate string that merely CONTAINS "undefined" (not an exact match) is unaffected', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_action",
      node: "ROOT",
      name: "MY_ACTION",
      spec: { xmlName: "UNDEFINED_BEHAVIOR_CHECK" },
    });

    expect(result.isError).toBeFalsy();
    expect(store.get("zbopf_prb1")).toContain('bo:xmlName="UNDEFINED_BEHAVIOR_CHECK"');
  });

  it("regression sweep: a representative write of every add_* operation never emits a literal undefined/null attribute value on success, and refuses BAD_INPUT rather than writing one otherwise", async () => {
    const specs: ReadonlyArray<{ operation: string; name: string; spec: Record<string, unknown> }> = [
      { operation: "add_action", name: "A1", spec: { xmlName: "undefined" } },
      { operation: "add_determination", name: "D1", spec: { category: "undefined" } },
      { operation: "add_validation", name: "V1", spec: { category: "undefined" } },
      { operation: "add_query", name: "Q1", spec: { xmlName: "null" } },
      { operation: "add_association", name: "AS1", spec: { multiplicity: "undefined" } },
      { operation: "add_alternative_key", name: "AK1", spec: { uniqueness: "null" } },
    ];

    for (const { operation, name, spec } of specs) {
      const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
      const { conn } = await wired({ routes: [store.route] });
      const { tools } = await registered(conn);

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation,
        node: "ROOT",
        name,
        spec,
      });

      // Every case above is refused (either by the enum guard or the
      // structural undefined/null guard) — none of them should ever reach
      // a successful write. If this ever starts succeeding for some
      // operation, the assertion below is what would catch a literal
      // "undefined"/"null" leaking onto the wire.
      if (result.isError) {
        expect(errorPayload(result).error).toBe("BAD_INPUT");
      } else {
        const putBody = store.get("zbopf_prb1")!;
        expect(putBody).not.toMatch(/="undefined"/);
        expect(putBody).not.toMatch(/="null"/);
      }
    }
  });
});

// ===========================================================================
// Defect 4: abap_bopf_delete's final authorize() fabricated a "transport"
// corr for a delete that can never actually resolve one.
// ===========================================================================

describe("defect 4: abap_bopf_delete's final authorize() defers instead of judging a fabricated transport", () => {
  it("a pinned ABAP_ALLOW_TRANSPORTS (not \"*\"/\"auto\") no longer refuses SAFETY_DENIED for a delete against a non-$ package", async () => {
    // Package must be non-$ (needsTransport, safety.ts:1677) and the allowlist
    // must be pinned to something other than "*"/"auto" — under the default
    // ["*"] this branch short-circuits before corr.kind is ever consulted
    // and the test would pass identically with or without the fix.
    const transportable = FX_JUST_CREATED.replace('adtcore:name="$TMP"', 'adtcore:name="ZBOPF_PKG"');
    const store = bopfStore({ zbopf_prb1: transportable });
    const { conn, server } = await wired({ routes: [store.route] });
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["ZBOPF_*"],
      allowTransports: ["ZTMK900123"],
    });
    const { tools } = await registered(conn, { safety: gate });
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_delete", {
      bo: "ZBOPF_PRB1",
      confirm: "ZBOPF_PRB1",
      dry_run: false,
    });

    expect(result.isError).toBeFalsy();
    expect(store.has("zbopf_prb1")).toBe(false);
    expect(server.calls.slice(before).some((r) => r.method === "DELETE")).toBe(true);
  });
});
