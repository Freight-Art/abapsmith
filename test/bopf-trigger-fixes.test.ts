/**
 * Regression tests for the second round of BOPF trigger/category fixes,
 * found by a further round of live A4H testing plus a read-only recon
 * against SAP-delivered `/BOBF/DEMO_SALES_ORDER`/`/BOBF/DEMO_PRODUCT`.
 * All fixes live in `src/tools/bopf.ts` (`buildTriggerFragments`,
 * `buildDeterminationFields`) plus `src/adt/bopf-types.ts`/`bopf-xml.ts`
 * (the `action` attribute on `bo:ValidationTrigger`).
 *
 * 1. Determination `category` is now validated against
 *    `DETERMINATION_CATEGORIES` (12 of `DeterminationCategoryType`'s 13
 *    members — `"undefined"` excluded, it is BOPF's own inert default, never
 *    a legitimate request). An OMITTED category still succeeds (it is
 *    legitimate caller input) but now surfaces an explicit response note
 *    warning that the determination will not fire without one.
 * 2. A same-node ("self") trigger now always renders `bo:association` with
 *    the empty-name self-association (`bo:associations[@bo:name='']`) when
 *    the caller omits `association` — never omits the attribute outright.
 *    (This reverses the coordinator's own retracted "defect B": the empty
 *    self-association is BOPF's canonical form, confirmed by the recon, and
 *    must be preserved.)
 * 3. A cross-node trigger (watched node different from the determination/
 *    validation's own node) still requires an explicit `association` — no
 *    safe default exists there — and gets a refusal naming the direction
 *    BOPF expects (association owned by the WATCHED node, pointing back
 *    toward the owner), not the reverse (a downward/composition association
 *    owned by the determination's own node).
 * 4. Multiple `<bo:triggers>` per determination/validation (routine on the
 *    wire) round-trips through `spec.triggers` as an array.
 * 5. `add_validation` triggers support `action` (with `actionNode` for when
 *    the action lives on a different node than the trigger itself) and a
 *    purely action-gated form (`node`/`association` both entirely absent).
 *    `action` on a DETERMINATION trigger is refused client-side —
 *    `bo:DeterminationTrigger` has no such attribute on the wire.
 *
 * Harness: identical to `test/bopf-defect-fixes.test.ts` — a real
 * `AbapConnection` against a `FakeAdtServer`, a real `SafetyGate`, real
 * `errorResult`. Only the HTTP socket and `SessionPool` are fake.
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

/** ZBOPF_PRB1, inactive, with a second (ITEM) node — needed for tests that require two real, distinct nodes. */
const FX_WITH_ITEM = fixture("03-after-put-item-node-and-assoc.v4.xml");

// ----------------------------------------------------------------------- harness ---
// Copied verbatim from test/bopf-defect-fixes.test.ts's harness section.

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

const BO_PREFIX = `${encodeURIComponent("zbopf_prb1")}#//bo:businessObject/bo:nodes[@bo:name='ROOT']`;

// ===========================================================================
// 1. Determination category: validated enum, omission legitimate but noted.
// ===========================================================================

describe("determination category is validated against DeterminationCategoryType, and an omitted category is legitimate but flagged", () => {
  it("rejects the literal string \"undefined\" as a determination category (never a legitimate caller request)", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET",
      spec: { category: "undefined" },
    });

    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(server.calls.slice(before).some((r) => r.method === "PUT")).toBe(false);
    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED);
  });

  it("rejects a validation-only category (\"consistencyCheck\") on a determination client-side — this used to 400 live with ExceptionInvalidData / \"Unexpected Case in Branch\"", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET",
      spec: { category: "consistencyCheck" },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("category");
  });

  it("accepts a real DeterminationCategoryType value (reactDuringSave) and writes it verbatim", async () => {
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
    expect(store.get("zbopf_prb1")).toContain('bo:category="reactDuringSave"');
  });

  it("accepts reactAfterModification too (the other wire-confirmed value)", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET",
      spec: { category: "reactAfterModification" },
    });

    expect(result.isError).toBeFalsy();
    expect(store.get("zbopf_prb1")).toContain('bo:category="reactAfterModification"');
  });

  it("an OMITTED category still succeeds (legitimate caller input — must keep working) but the response carries an explicit note that the determination will not fire without one", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET",
      spec: {},
    });

    const text = okText(result);
    // The new bo:determinations element itself must carry no bo:category
    // attribute at all — never the literal "undefined" string (that would be
    // the client writing it, which is exactly what defect A ruled out: the
    // omission must stay a true omission on OUR side). Scoped to the MY_DET
    // element specifically: the fixture's pre-existing bo:queries/bo:actions
    // elements legitimately carry unrelated bo:category attributes of their
    // own (e.g. bo:category="selectAll"), so a document-wide regex would be
    // a false negative here.
    const putBody = store.get("zbopf_prb1")!;
    // NOTE (incidental fix found while running the full suite): this
    // element's bo:nodeID is a randomly-generated base64 GUID, which contains
    // a literal "/" character on ~30% of runs (base64's alphabet includes
    // "/"). The old regex used `[^/]*` to find the closing `/>`, which broke
    // -- flakily, not deterministically -- whenever the GUID itself contained
    // a "/". `[^>]*` still finds the same self-closing tag (there is no ">"
    // inside a well-formed attribute value) without being tripped up by "/".
    const detElement = putBody.match(/<bo:determinations bo:name="MY_DET"[^>]*\/>/)?.[0];
    expect(detElement).toBeDefined();
    expect(detElement).not.toContain("bo:category=");
    expect(text.toLowerCase()).toContain("category");
    expect(text).toContain("undefined");
  });

  it("an explicitly-supplied category means no omission note is present", async () => {
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

    const text = okText(result);
    expect(text).not.toContain("was omitted");
  });
});

// ===========================================================================
// 2. Self-trigger empty-association default (the un-retracted "defect B").
// ===========================================================================

describe("a same-node (self) trigger always renders the empty-name self-association, never an omitted bo:association", () => {
  it("add_determination: {node: ROOT} with no association on a determination owned by ROOT renders bo:association with an EMPTY name, not an omitted attribute", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET",
      spec: { category: "reactDuringSave", triggers: [{ node: "ROOT", update: true }] },
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain(`bo:node="${BO_PREFIX}"`);
    // The canonical SAP self-trigger shape: an association element WITH an
    // empty name, not a missing attribute.
    expect(putBody).toContain(`bo:association="${BO_PREFIX}/bo:associations[@bo:name='']"`);
  });

  it("add_determination: fully omitting node AND association also defaults to a self-trigger on the determination's own node", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET",
      spec: { category: "reactDuringSave", triggers: [{ create: true }] },
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain(`bo:node="${BO_PREFIX}"`);
    expect(putBody).toContain(`bo:association="${BO_PREFIX}/bo:associations[@bo:name='']"`);
  });

  it("add_validation: the same self-trigger default applies", async () => {
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
    expect(putBody).toContain(`bo:association="${BO_PREFIX}/bo:associations[@bo:name='']"`);
  });

  it("an explicit non-empty association on the determination's own node is still honoured verbatim (not overridden by the self-trigger default)", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET",
      spec: { category: "reactDuringSave", triggers: [{ node: "ROOT", association: "TO_ITEM", create: true }] },
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain(`bo:association="${BO_PREFIX}/bo:associations[@bo:name='TO_ITEM']"`);
    expect(putBody).not.toContain(`bo:associations[@bo:name='']`);
  });
});

// ===========================================================================
// 3. Cross-node trigger direction: association required, direction guidance.
// ===========================================================================

describe("a cross-node trigger (watched node different from the owner) still requires an explicit association, with a direction-aware refusal", () => {
  it("refuses (BAD_INPUT) a cross-node trigger with no association, naming both nodes and explaining the expected direction", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET",
      spec: { category: "reactDuringSave", triggers: [{ node: "ITEM", create: true }] },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("ITEM");
    expect(String(payload.message)).toContain("ROOT");
    expect(server.calls.slice(before).some((r) => r.method === "PUT")).toBe(false);
    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED);
  });

  it("a cross-node trigger WITH an explicit association is built from the watched node's own association, anchored on the watched node — not the owner's downward association", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET",
      spec: { category: "reactDuringSave", triggers: [{ node: "ITEM", association: "TO_PARENT", create: true }] },
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    const itemPrefix = `${encodeURIComponent("zbopf_prb1")}#//bo:businessObject/bo:nodes[@bo:name='ITEM']`;
    expect(putBody).toContain(`bo:node="${itemPrefix}"`);
    expect(putBody).toContain(`bo:association="${itemPrefix}/bo:associations[@bo:name='TO_PARENT']"`);
  });

  it("association without node stays refused (BAD_INPUT) — unchanged, pre-existing behaviour", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET",
      spec: { category: "reactDuringSave", triggers: [{ association: "TO_ITEM", create: true }] },
    });

    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(server.calls.slice(before).some((r) => r.method === "PUT")).toBe(false);
    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED);
  });
});

// ===========================================================================
// 4. Multiple triggers per determination.
// ===========================================================================

describe("multiple <bo:triggers> per determination/validation (routine on the wire, e.g. SAP's ROOT_SET_ADMIN_DATA carries 4)", () => {
  it("all four sibling triggers on one add_determination call are rendered as separate bo:triggers elements", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET",
      spec: {
        category: "reactDuringSave",
        triggers: [
          { node: "ROOT", update: true },
          { node: "ITEM", association: "TO_PARENT", create: true },
          { node: "ITEM_TEXT", association: "TO_ROOT", create: true },
          { node: "ROOT_TEXT", association: "TO_PARENT", update: true },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    const triggerCount = (putBody.match(/<bo:triggers /g) ?? []).length;
    expect(triggerCount).toBe(4);
    expect(putBody).toContain(`bo:associations[@bo:name='']`); // the ROOT self-trigger
    expect(putBody).toContain(`bo:name='ITEM']/bo:associations[@bo:name='TO_PARENT']`);
    expect(putBody).toContain(`bo:name='ITEM_TEXT']/bo:associations[@bo:name='TO_ROOT']`);
    expect(putBody).toContain(`bo:name='ROOT_TEXT']/bo:associations[@bo:name='TO_PARENT']`);
  });
});

// ===========================================================================
// 5. Validation-only bo:action triggers.
// ===========================================================================

describe("add_validation triggers support bo:action (combined with node/association, or purely action-gated); add_determination refuses action", () => {
  it("a combined node+action trigger renders both bo:association (self, on the trigger's own node) and bo:action (on a DIFFERENT node, via actionNode)", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_validation",
      node: "ROOT",
      name: "MY_VAL",
      spec: {
        category: "consistencyCheck",
        // LOCK_ROOT, not a made-up name: `actionRefPreflight` now
        // refuses a trigger action that does not exist on its node, so this
        // must name a real action — FX_JUST_CREATED's auto-generated
        // ROOT.LOCK_ROOT (see the fixture XML) fits, and actionNode omitted
        // still defaults to the validation's own node (ROOT), same as before.
        triggers: [{ node: "ROOT", create: true, update: true, check: true, action: "LOCK_ROOT" }],
      },
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain(`bo:association="${BO_PREFIX}/bo:associations[@bo:name='']"`);
    // actionNode omitted -> defaults to the validation's own node (ROOT).
    expect(putBody).toContain(`bo:action="${BO_PREFIX}/bo:actions[@bo:name='LOCK_ROOT']"`);
  });

  it("actionNode lets the action reference a DIFFERENT node than the trigger's own node (SAP's CHECK_ROOT_SHORT_TEXT shape: validation owned by a non-ROOT node, self-triggered, but action-gated on ROOT)", async () => {
    // Needs two REAL nodes: the tool's own top-level "node" (where the
    // validation attaches) must exist in the BO's node index — unlike a
    // trigger's node/association/action fields, which are opaque XPath
    // string fragments with no existence check. FX_JUST_CREATED is
    // root-only, so this test uses FX_WITH_ITEM (ROOT + ITEM) instead, and
    // models CHECK_ROOT_SHORT_TEXT's shape with ITEM standing in for
    // ROOT_TEXT: validation owned by ITEM, self-triggered on ITEM's own
    // changes, but action-gated on ROOT's (real) LOCK_ROOT action.
    const store = bopfStore({ zbopf_prb1: FX_WITH_ITEM });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_validation",
      node: "ITEM",
      name: "CHECK_ITEM_SHORT_TEXT",
      spec: {
        category: "consistencyCheck",
        triggers: [{ node: "ITEM", create: true, update: true, check: true, action: "LOCK_ROOT", actionNode: "ROOT" }],
      },
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    const itemPrefix = `${encodeURIComponent("zbopf_prb1")}#//bo:businessObject/bo:nodes[@bo:name='ITEM']`;
    expect(putBody).toContain(`bo:node="${itemPrefix}"`);
    expect(putBody).toContain(`bo:association="${itemPrefix}/bo:associations[@bo:name='']"`);
    expect(putBody).toContain(`bo:action="${BO_PREFIX}/bo:actions[@bo:name='LOCK_ROOT']"`);
  });

  it("a purely action-gated trigger (action only, node AND association both entirely absent) omits bo:node/bo:association altogether (SAP's CHECK_DELIVER shape)", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_validation",
      node: "ROOT",
      name: "CHECK_DELIVER",
      // LOCK_ROOT, not a made-up name — see the previous test's comment on
      // `actionRefPreflight`. actionNode omitted defaults to the
      // validation's own node (ROOT), where FX_JUST_CREATED's LOCK_ROOT lives.
      spec: { category: "actionCheck", triggers: [{ action: "LOCK_ROOT" }] },
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    const triggerLine = putBody.match(/<bo:triggers [^>]*\/>/g)!.find((l) => l.includes("LOCK_ROOT"))!;
    expect(triggerLine).not.toContain("bo:node=");
    expect(triggerLine).not.toContain("bo:association=");
    expect(triggerLine).toContain(`bo:action="${BO_PREFIX}/bo:actions[@bo:name='LOCK_ROOT']"`);
  });

  it("add_determination refuses a trigger carrying action client-side — bo:DeterminationTrigger has no such attribute on the wire", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET",
      spec: { category: "reactDuringSave", triggers: [{ node: "ROOT", action: "ARCHIVE" }] },
    });

    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(server.calls.slice(before).some((r) => r.method === "PUT")).toBe(false);
    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED);
  });
});

// ===========================================================================
// 6. A trigger action naming a NON-existent action is refused
//    client-side (BOPF_DANGLING_REF, same mitigation class as spec.class),
//    and a malformed spec.triggers/spec.relations entry is refused rather
//    than silently skipped.
// ===========================================================================

describe("dangling trigger-action refs, and malformed trigger/relation entries are refused rather than silently skipped", () => {
  it("refuses a validation trigger whose action does not exist on its node (BOPF_DANGLING_REF), naming the actions that DO exist", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_validation",
      node: "ROOT",
      name: "MY_VAL",
      spec: { category: "actionCheck", triggers: [{ action: "ZZ_DUMMY_ACTION" }] },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BOPF_DANGLING_REF");
    expect(String(payload.message)).toContain("ZZ_DUMMY_ACTION");
    expect(String(payload.message)).toContain("LOCK_ROOT"); // the action that DOES exist on ROOT
    // Refused BEFORE locking/writing anything -- no PUT went out.
    expect(server.calls.slice(before).some((r) => r.method === "PUT")).toBe(false);
    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED);
  });

  it("allow_dangling_ref: true overrides the trigger-action refusal, same as it does for spec.class", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_validation",
      node: "ROOT",
      name: "MY_VAL",
      allow_dangling_ref: true,
      spec: { category: "actionCheck", triggers: [{ action: "ZZ_DUMMY_ACTION" }] },
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain(`bo:action="${BO_PREFIX}/bo:actions[@bo:name='ZZ_DUMMY_ACTION']"`);
  });

  it("a pure-action validation trigger naming a real action still renders a real bo:triggers element (never silently trigger-less)", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_validation",
      node: "ROOT",
      name: "MY_VAL",
      spec: { category: "actionCheck", triggers: [{ action: "LOCK_ROOT" }] },
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain("<bo:triggers ");
    expect(putBody).toContain(`bo:action="${BO_PREFIX}/bo:actions[@bo:name='LOCK_ROOT']"`);
  });

  it("refuses (BAD_INPUT) a non-object entry in spec.triggers instead of silently skipping it", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET",
      spec: { category: "reactDuringSave", triggers: [{ node: "ROOT", update: true }, "not-an-object"] },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("spec.triggers[1]");
    // Refused before ever writing -- not a partial write with 1 of 2 triggers.
    expect(server.calls.slice(before).some((r) => r.method === "PUT")).toBe(false);
    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED);
  });

  it("refuses (BAD_INPUT) a non-object entry in spec.relations instead of silently skipping it", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET",
      spec: { category: "reactDuringSave", relations: [null] },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("spec.relations[0]");
  });

  it("determination triggers still refuse action, unchanged by these fixes", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_determination",
      node: "ROOT",
      name: "MY_DET",
      spec: { category: "reactDuringSave", triggers: [{ node: "ROOT", action: "LOCK_ROOT" }] },
    });

    expect(errorPayload(result).error).toBe("BAD_INPUT");
  });
});
