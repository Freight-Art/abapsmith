/**
 * Tests for `src/tools/bopf.ts` — the MCP tool layer over `src/adt/bopf.ts`
 * and `src/adt/bopf-xml.ts`.
 *
 * `registerBopfTools(mcp, deps)` is not exercised anywhere else in this repo
 * (neither `src/tools/transport.ts` nor `src/tools/debug.ts` — the two other
 * tool modules with test coverage — use the `register*Tool(mcp, deps)`
 * pattern; both export plain functions instead). There is no existing
 * fake-`McpServer` harness to reuse, so this file builds a minimal one: a
 * `registerTool` stub that captures `{config, handler}` per tool name into a
 * `Map`, invoked directly in tests.
 *
 * Everything below the tool layer is real: a real `AbapConnection` against a
 * `FakeAdtServer` session (exactly `test/bopf-client.test.ts`'s `wired()`
 * pattern, reusing its `bopfStore`/`classSourceRoute`/`activationRoute`
 * helpers from `test/helpers/fake-adt.ts`), a real `SafetyGate`, and the real
 * `errorResult` from `src/server.ts`. Only the HTTP socket and the
 * `SessionPool` (a one-line passthrough to the wired connection — this repo
 * has no fake pool of its own to reuse either) are fake. Entirely offline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  FakeAdtServer,
  __resetFakeAdtCounters,
  fakeResponse,
  bopfStore,
  classSourceRoute,
  activationRoute,
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
import { registerBopfTools, type BopfToolDeps } from "../src/tools/bopf.js";

// --------------------------------------------------------------------- fixtures ---

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const fixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

/** ZBOPF_MC5, active, real dangling class refs (ZCL_BOPF_NOPE_ACT/DET/VAL). */
const FX_ACTIVE_DANGLING = fixture("10-model-coverage-final.v4.xml");
/** ZBOPF_PRB1, inactive, root-node-only — the just-created shape. */
const FX_JUST_CREATED = fixture("02-created-zbopf_prb1-root-only.v4.xml");
/** ZBOPF_PRB1, active, after its DDIC structures were added. */
const FX_ACTIVE_AFTER_STRUCTURES = fixture("04-active-after-structures.v4.xml");

/**
 * CONSTRUCTED — no capture of an `ioc:inactiveObjects` document exists
 * anywhere in this repository; see test/activation-preaudit.test.ts for the
 * envelope this follows (`ioc:entry`/`ioc:object`/`ioc:ref` nesting, `ioc:ref`
 * itself in the `ioc` namespace with its attributes in `adtcore`). Names two
 * of ZBOPF_PRB1's own dependents, taken from FX_ACTIVE_AFTER_STRUCTURES: the
 * constants interface ZIF_BOPF_PRB1_C and the root structure ZBOPF_S_ROOT.
 */
const PREAUDIT_ZBOPF_PRB1 = `<?xml version="1.0" encoding="utf-8"?>
<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">
  <ioc:entry><ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
    <ioc:ref adtcore:uri="/sap/bc/adt/oo/interfaces/zif_bopf_prb1_c" adtcore:type="INTF/OI" adtcore:name="ZIF_BOPF_PRB1_C" adtcore:parentUri="/sap/bc/adt/bopf/businessobjects/zbopf_prb1"/>
  </ioc:object></ioc:entry>
  <ioc:entry><ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
    <ioc:ref adtcore:uri="/sap/bc/adt/ddic/structures/zbopf_s_root" adtcore:type="TABL/DS" adtcore:name="ZBOPF_S_ROOT" adtcore:parentUri="/sap/bc/adt/bopf/businessobjects/zbopf_prb1"/>
  </ioc:object></ioc:entry>
</ioc:inactiveObjects>`;

// ----------------------------------------------------------------------- harness ---

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

/** Every request past `connect()`'s own login/probe traffic. */
function callsAfterConnect(server: FakeAdtServer): number {
  return server.calls.length;
}

/** A `SessionPool` that just forwards straight onto one wired connection — this repo has no reusable fake pool. */
function fakePool(conn: AbapConnection): SessionPool {
  return {
    withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    withWrite: <T,>(_op: string, _objectUri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
    reserveDebug: () => {
      throw new Error("reserveDebug: not used by any BOPF tool, and not implemented in this fake.");
    },
  } as unknown as SessionPool;
}

/** Captures `registerTool` calls into a `Map<name, {config, handler}>` instead of talking to a real MCP client. */
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

/** Parses the JSON envelope `errorResult` puts in `content[0].text` on a failure result. */
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
    // Same reasoning as test/bopf-client.test.ts's
    // openGate() — this helper name promises "wide open", so it must also
    // carry the allowCascadeDelete ceiling `deleteBusinessObject` now checks
    // (src/adt/bopf.ts), or every `cascade_ddic: true` tool test below would
    // start refusing before ever reaching the assertions it's testing.
    allowCascadeDelete: true,
  });
const closedGate = (): SafetyGate => new SafetyGate({ readOnly: true, allowPackages: [] });

const fakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({
    kind: "transport",
    required: true,
    mustSupplyCorrNr: true,
    serverWouldFabricate: false,
    ...overrides,
  }) as unknown as TrRequirement;

/** A `$TMP`-shaped local package: `trRequirement` reports `kind: "local"`. */
const localTransport = (): SessionTransport =>
  new SessionTransport({
    allowTransports: ["auto"],
    cts: { trRequirement: vi.fn(async () => fakeReq({ kind: "local" })) },
  });

function depsFor(conn: AbapConnection, opts: { safety?: SafetyGate; transport?: SessionTransport } = {}): BopfToolDeps {
  return {
    pool: fakePool(conn),
    safety: opts.safety ?? openGate(),
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: 30_000 },
    transport: opts.transport ?? localTransport(),
    // This suite exercises abap_bopf_edit/abap_bopf_delete directly, so it
    // needs them registered (registration-time filtering is exercised
    // separately, in test/tools.test.ts).
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

describe("abap_bopf — read modes", () => {
  it('mode "show" (default) returns a compact digest naming the bo, its nodes, and their members', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf", { bo: "ZBOPF_PRB1" });
    const text = okText(result);
    expect(text).toContain("ZBOPF_PRB1");
    expect(text).toContain("ROOT");
    expect(text).toContain("SELECT_ALL");
    expect(text).toContain("LOCK_ROOT");
  });

  it('mode "raw" returns the verbatim v4 XML, routed through buildResponse\'s truncation (ARCH-09 P2 — no longer a raw ok(xml) bypass)', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf", { bo: "ZBOPF_PRB1", mode: "raw" });
    const text = okText(result);
    // Under the cap: the XML itself is still byte-for-byte intact, just wrapped
    // with a header/body-label the way every sibling mode already is.
    expect(text).toContain(FX_JUST_CREATED);
    expect(text).toContain("bo: ZBOPF_PRB1");
    expect(text).toContain("--- XML ---");
  });

  it('show | raw | check_refs without bo refuses with BAD_INPUT, no network call', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf", { mode: "raw" });
    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(callsAfterConnect(server)).toBe(before);
  });

  it('mode "search" calls searchBusinessObjects and reports the hits', async () => {
    const SEARCH_XML =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">` +
      `<adtcore:objectReference adtcore:uri="/sap/bc/adt/bopf/businessobjects/zbopf_prb1" adtcore:type="BOBF" adtcore:name="ZBOPF_PRB1"/>` +
      `</adtcore:objectReferences>`;
    const searchRoute: FakeRoute = (r) =>
      r.method === "GET" && r.path === "/sap/bc/adt/bopf/businessobjects/$search"
        ? fakeResponse(200, SEARCH_XML, { "content-type": "application/xml" })
        : undefined;
    const { conn } = await wired({ routes: [searchRoute] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf", { mode: "search", object_type: "BOBF", query: "ZBOPF*" });
    expect(okText(result)).toContain("ZBOPF_PRB1");
  });

  it('mode "check_refs" reads the model and checks references in one pass, noting unchecked refs when class probes are unrouted', async () => {
    const store = bopfStore({ zbopf_mc5: FX_ACTIVE_DANGLING });
    // No classSourceRoute/ddicProbeRoute wired at all — every class/DDIC
    // probe is genuinely unrouted (not a 404), so checkReferences degrades
    // every one of them to "unchecked" rather than throwing (mirrors
    // bopf-client.test.ts's "never throws" case).
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf", { bo: "ZBOPF_MC5", mode: "check_refs" });
    const text = okText(result);
    expect(text).toMatch(/unchecked/);
    expect(text).not.toMatch(/could not be checked.{0,80}0 reference/);
  });

  it('mode "check_refs" with max_sites honestly discloses a bounded run (ARCH-09 P7)', async () => {
    const store = bopfStore({ zbopf_mc5: FX_ACTIVE_DANGLING });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf", {
      bo: "ZBOPF_MC5",
      mode: "check_refs",
      max_sites: 2,
    });
    const text = okText(result);
    expect(text).toContain("checked 2 of");
    expect(text).toContain("max_sites=2");
    expect(text).toMatch(/totalRefs: 2/);
  });

  it("always asserts the read gate, even though read is never actually refusable", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const gate = openGate();
    const spy = vi.spyOn(gate, "assert");
    const { tools } = await registered(conn, { safety: gate });

    await invoke(tools, "abap_bopf", { bo: "ZBOPF_PRB1" });
    expect(spy).toHaveBeenCalledWith("read");
  });
});

// ===========================================================================

describe("abap_bopf_edit — two-phase safety gate", () => {
  it("a closed write gate refuses at the PREFLIGHT phase, before ensureConnected/any network call", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const before = callsAfterConnect(server);
    const { tools } = await registered(conn, { safety: closedGate() });

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_node_flags",
      node: "ROOT",
      spec: { updateEnabled: false },
    });

    expect(errorPayload(result).error).toBe("READ_ONLY");
    expect(callsAfterConnect(server)).toBe(before);
  });

  it("wantsActivate (operation: activate) asserts BOTH write and activate at preflight, before any network call", async () => {
    // NB: an OPEN gate, not closed — SafetyGate's "activate" policy runs the
    // SAME productive/writesLockedOut/readOnly branches as "write" (there is
    // no activate-specific ceiling), so a closed gate throws on the FIRST
    // assert("write", ...) call and control never reaches assert("activate",
    // ...) at all. To observe BOTH calls actually happening, the gate must
    // not refuse either of them.
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route, activationRoute({})] });
    const gate = openGate();
    const spy = vi.spyOn(gate, "assert");
    const { tools } = await registered(conn, { safety: gate });

    const result = await invoke(tools, "abap_bopf_edit", { bo: "ZBOPF_PRB1", operation: "activate" });

    expect(result.isError).toBeFalsy();
    // corr is now passed explicitly at preflight — nothing is resolved yet,
    // so step 10 defers instead of fabricating an "auto" to judge.
    expect(spy).toHaveBeenCalledWith(
      "write",
      { name: "ZBOPF_PRB1", packageName: undefined, type: "BOBF" },
      { phase: "preflight", corr: { kind: "unresolved" } },
    );
    expect(spy).toHaveBeenCalledWith(
      "activate",
      { name: "ZBOPF_PRB1", packageName: undefined, type: "BOBF" },
      { phase: "preflight", corr: { kind: "unresolved" } },
    );
  });

  it("activate: true (not just operation: activate) also triggers the activate preflight assert", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route, activationRoute({})] });
    const gate = openGate();
    const spy = vi.spyOn(gate, "assert");
    const { tools } = await registered(conn, { safety: gate });

    const result = await invoke(tools, "abap_bopf_edit", { bo: "ZBOPF_PRB1", operation: "set_node_flags", node: "ROOT", spec: { updateEnabled: false }, activate: true });

    expect(result.isError).toBeFalsy();
    // Same explicit-corr shape as above — this preflight assert cannot
    // fabricate an "auto" for step 10 to judge.
    expect(spy).toHaveBeenCalledWith(
      "activate",
      { name: "ZBOPF_PRB1", packageName: undefined, type: "BOBF" },
      { phase: "preflight", corr: { kind: "unresolved" } },
    );
  });

  it("without activate requested, the activate gate is never asserted", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const gate = openGate();
    const spy = vi.spyOn(gate, "assert");
    const { tools } = await registered(conn, { safety: gate });

    await invoke(tools, "abap_bopf_edit", { bo: "ZBOPF_PRB1", operation: "set_node_flags", node: "ROOT", spec: { updateEnabled: false } });

    expect(spy).not.toHaveBeenCalledWith("activate", expect.anything(), expect.anything());
  });
});

// ===========================================================================

describe("abap_bopf_edit — dangling-ref preflight (H2)", () => {
  it('add_action referencing a class with no source at all refuses BOPF_DANGLING_REF, and never locks/writes', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({
      routes: [store.route, classSourceRoute({ name: "ZCL_MISSING", body: undefined })],
    });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_action",
      node: "ROOT",
      name: "MY_ACTION",
      spec: { class: "ZCL_MISSING" },
    });

    expect(errorPayload(result).error).toBe("BOPF_DANGLING_REF");
    const puts = server.calls.slice(before).filter((r) => r.method === "PUT");
    const locks = server.calls.slice(before).filter((r) => r.method === "POST" && r.qs["_action"] === "LOCK");
    expect(puts).toHaveLength(0);
    expect(locks).toHaveLength(0);
    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED); // untouched
  });

  it("allow_dangling_ref: true overrides the refusal and proceeds to write", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({
      routes: [store.route, classSourceRoute({ name: "ZCL_MISSING", body: undefined })],
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_action",
      node: "ROOT",
      name: "MY_ACTION",
      spec: { class: "ZCL_MISSING" },
      allow_dangling_ref: true,
    });

    const text = okText(result);
    expect(text).toMatch(/allowed/);
    expect(store.get("zbopf_prb1")).toContain('bo:name="MY_ACTION"');
  });

  it("a class that exists but lacks the required interface is reported wrong-interface, and still proceeds", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const realButWrongInterface =
      `CLASS zcl_wrong DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_wrong IMPLEMENTATION.\nENDCLASS.`;
    const { conn } = await wired({
      routes: [store.route, classSourceRoute({ name: "ZCL_WRONG", body: realButWrongInterface })],
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_action",
      node: "ROOT",
      name: "MY_ACTION2",
      spec: { class: "ZCL_WRONG" },
    });

    expect(okText(result)).toMatch(/wrong-interface/);
  });
});

// ===========================================================================

describe("abap_bopf_edit — add_alternative_key gate", () => {
  it("refuses without i_know_this_may_not_activate, before any network call", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const before = callsAfterConnect(server);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { keyElements: ["FIELD1"] },
    });

    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(callsAfterConnect(server)).toBe(before);
  });

  it("proceeds once i_know_this_may_not_activate: true is passed", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: {
        uniqueness: "unique",
        dataTypeRef: { name: "ZSORDER_ID", type: "TABL/DS" },
        dataTableTypeRef: { name: "ZTORDER_ID", type: "TTYP/DA" },
        keyElements: ["FIELD1"],
      },
      i_know_this_may_not_activate: true,
      // allow_dangling_ref only keeps this spec off alternativeKeyPreflight's path (FIELD1 isn't
      // a real property on ROOT here) — this test is about the i_know_this_may_not_activate gate,
      // not about dangling refs; see test/bopf-alternative-key-preflight.test.ts for that coverage.
      allow_dangling_ref: true,
    });

    expect(result.isError).toBeFalsy();
    expect(store.get("zbopf_prb1")).toContain('bo:name="ALT1"');
  });
});

// ===========================================================================

describe("abap_bopf_edit — byte-exact write shape", () => {
  it("add_node inserts a new root-level bo:nodes element at the exact position right before </bo:businessObject>, leaving everything else byte-identical", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_node",
      name: "ITEM",
      spec: { parent: "ROOT", rootNode: false, createEnabled: true },
    });
    expect(result.isError).toBeFalsy();

    const idx = FX_JUST_CREATED.indexOf("</bo:businessObject>");
    expect(idx).toBeGreaterThan(0);
    const before = FX_JUST_CREATED.slice(0, idx);
    const after = FX_JUST_CREATED.slice(idx);

    const putBody = store.get("zbopf_prb1")!;
    expect(putBody.startsWith(before)).toBe(true);
    expect(putBody.endsWith(after)).toBe(true);

    const fragment = putBody.slice(before.length, putBody.length - after.length);
    expect(fragment).toContain("<bo:nodes ");
    expect(fragment).toContain('bo:name="ITEM"');
    expect(fragment).toContain('bo:rootNode="false"');
    expect(fragment).toContain('bo:createEnabled="true"');
    expect(fragment.endsWith("</bo:nodes>") || fragment.endsWith("/>")).toBe(true);
  });

  it("set_node_flags patches only the named attributes on the node's own open tag — every other byte is unchanged", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_node_flags",
      node: "ROOT",
      spec: { updateEnabled: false, authorizationCheck: null },
    });
    expect(result.isError).toBeFalsy();

    const expectedXml = FX_JUST_CREATED.replace(' bo:authorizationCheck="false"', "").replace(
      'bo:updateEnabled="true"',
      'bo:updateEnabled="false"',
    );
    expect(store.get("zbopf_prb1")).toBe(expectedXml);
  });

  it("set_node_flags on an unknown node refuses NOT_FOUND (no PUT lands, both lock attempts genuinely unlocked)", async () => {
    // `patchNodeFlags` throws NOT_FOUND synchronously inside `rebuild`, called
    // from `withRelockRetry` (src/adt/relock.ts). NOT_FOUND is not in
    // `defaultRetryable`'s exclusion list, so it is treated as retryable, and
    // neither attempt is `SESSION_DEAD`, so both go through the general step
    // 6 path: `unlock` FIRST (while the ledger entry still exists, so the
    // real UNLOCK request lands), THEN `forgetLock`.
    //
    // This used to be reversed (`forgetLock` before `unlock`) — a real bug:
    // `StatefulSession.unlock` (src/adt/session.ts ~1258-1263) looks the
    // handle up in its own ledger and is a silent no-op once that entry is
    // gone, so with `forgetLock` first the real UNLOCK request was NEVER
    // sent, the lock leaked server-side, and the retry's second `lock()` hit
    // a genuine 423 conflict against the still-held lock — surfacing as
    // LOCKED instead of the expected NOT_FOUND. Now fixed (relock.ts's step
    // 6): both attempts genuinely unlock, so the second `lock()` succeeds
    // cleanly, `rebuild` throws NOT_FOUND again, attempts are exhausted, and
    // NOT_FOUND (annotated with `details.attempts`) is what the caller sees.
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "set_node_flags",
      node: "NOPE",
      spec: { updateEnabled: false },
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("NOT_FOUND");
    expect((payload.details as Record<string, unknown> | undefined)?.attempts).toBe(2);

    const calls = server.calls.slice(before);
    expect(calls.some((r) => r.method === "PUT")).toBe(false);

    const locks = calls.filter((r) => r.method === "POST" && r.qs["_action"] === "LOCK");
    const unlocks = calls.filter((r) => r.method === "POST" && r.qs["_action"] === "UNLOCK");
    // Both retry attempts genuinely locked AND genuinely unlocked — this is
    // exactly what the old bug defeated: `unlocks` was empty before the fix,
    // because `forgetLock`-before-`unlock` made `unlock` a silent no-op.
    expect(locks).toHaveLength(2);
    expect(unlocks).toHaveLength(2);
    expect(server.violations).toEqual([]);

    expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED); // untouched
  });
});

// ===========================================================================

describe("abap_bopf_edit — create_bo and activate", () => {
  it("create_bo requires package, refused before any network call", async () => {
    const store = bopfStore();
    const { conn, server } = await wired({ routes: [store.route] });
    const before = callsAfterConnect(server);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", { bo: "ZBOPF_NEW1", operation: "create_bo" });
    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(callsAfterConnect(server)).toBe(before);
  });

  it("create_bo succeeds against a local package via createBusinessObject", async () => {
    const store = bopfStore();
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn, { transport: localTransport() });

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_NEW1",
      operation: "create_bo",
      package: "$TMP",
      description: "test bo",
    });

    expect(result.isError).toBeFalsy();
    expect(store.has("zbopf_new1")).toBe(true);
  });

  it("create_bo response names the companion constants interface it just created", async () => {
    // FX_JUST_CREATED is the REAL captured shape of a just-created,
    // inactive, root-node-only BO — it already carries
    // bo:constantsInterfaceRef (ZIF_BOPF_PRB1_C). Seeding the store with it
    // means the fresh re-read createBusinessObject does after the create
    // POST returns this exact body, so this test exercises the same
    // "already in scope, just dropped by the response template" gap the
    // issue describes, without needing a live server.
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "create_bo",
      package: "$TMP",
    });

    expect(result.isError).toBeFalsy();
    expect(okText(result)).toMatch(/constantsInterface: ZIF_BOPF_PRB1_C/);
  });

  it('operation: "activate" activates without touching the model body, corroborated by a fresh re-read', async () => {
    const store = bopfStore({ zbopf_mc5: FX_ACTIVE_DANGLING });
    const { conn } = await wired({
      routes: [store.route, activationRoute({})],
    });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", { bo: "ZBOPF_MC5", operation: "activate" });
    expect(okText(result)).toMatch(/Activated successfully/);
  });

  it('operation: "activate" whose phase-one reply carries an ioc:inactiveObjects preaudit document renders a CO-ACTIVATED section naming the dependents SAP dragged in', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    // activationRoute({}) cannot express a two-phase sequence (it answers
    // every activation POST identically), so this is a small local route:
    // phase one (boolean preauditRequested=true, from conn.adt.activate)
    // answers the preaudit body; phase two (string "false", from
    // postActivation in src/adt/activate.ts) answers a clean empty 200 and
    // flips the store to the active fixture, so the fresh re-read afterwards
    // sees adtcore:version="active".
    const preauditRoute: FakeRoute = (r) => {
      if (r.path !== "/sap/bc/adt/activation" || r.method !== "POST") return undefined;
      if (String(r.qs["preauditRequested"]) === "false") {
        store.set("zbopf_prb1", FX_ACTIVE_AFTER_STRUCTURES);
        return fakeResponse(200, "", { "content-length": "0" });
      }
      return fakeResponse(200, PREAUDIT_ZBOPF_PRB1, { "content-type": "application/xml" });
    };
    const { conn } = await wired({ routes: [store.route, preauditRoute] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", { bo: "ZBOPF_PRB1", operation: "activate" });
    const text = okText(result);
    expect(text).toMatch(/CO-ACTIVATED/);
    expect(text).toContain("ZIF_BOPF_PRB1_C");
  });

  it('operation: "activate" with a clean phase-one reply (no preaudit) renders no CO-ACTIVATED section', async () => {
    const store = bopfStore({ zbopf_prb1: FX_ACTIVE_AFTER_STRUCTURES });
    const { conn } = await wired({ routes: [store.route, activationRoute({})] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", { bo: "ZBOPF_PRB1", operation: "activate" });
    expect(okText(result)).not.toMatch(/CO-ACTIVATED/);
  });

  it("add_node without `name` is refused BAD_INPUT before any network call", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const before = callsAfterConnect(server);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", { bo: "ZBOPF_PRB1", operation: "add_node" });
    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(callsAfterConnect(server)).toBe(before);
  });
});

// ===========================================================================

describe("abap_bopf_delete", () => {
  it("dry_run defaults to true: reports without deleting, no LOCK/DELETE calls", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_delete", { bo: "ZBOPF_PRB1" });
    const text = okText(result);
    expect(text).toMatch(/dryRun: true/);
    expect(store.has("zbopf_prb1")).toBe(true);
    expect(server.calls.some((r) => r.method === "DELETE")).toBe(false);
    expect(server.calls.some((r) => r.method === "POST" && r.qs["_action"] === "LOCK")).toBe(false);
  });

  it("dry_run with cascade_ddic: true lists DDIC candidates from the model, without probing their existence", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_delete", { bo: "ZBOPF_PRB1", cascade_ddic: true });
    const text = okText(result);
    expect(text).toMatch(/ZBOPF_D_ROOT|ZBOPF_T_ROOT|ZBOPF_S_ROOT/);
    expect(server.calls.some((r) => r.path.startsWith("/sap/bc/adt/ddic/"))).toBe(false);
  });

  it("armed delete (dry_run: false) without confirm refuses BAD_INPUT, no network call", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const before = callsAfterConnect(server);
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_delete", { bo: "ZBOPF_PRB1", dry_run: false });
    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(callsAfterConnect(server)).toBe(before);
    expect(store.has("zbopf_prb1")).toBe(true);
  });

  it("armed delete with a confirm that does not echo the bo name refuses BAD_INPUT", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_delete", { bo: "ZBOPF_PRB1", dry_run: false, confirm: "WRONG_NAME" });
    expect(errorPayload(result).error).toBe("BAD_INPUT");
    expect(store.has("zbopf_prb1")).toBe(true);
  });

  it("armed delete with a correct (case-insensitive, trimmed) confirm actually deletes", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_delete", { bo: "ZBOPF_PRB1", dry_run: false, confirm: "  zbopf_prb1  " });
    expect(result.isError).toBeFalsy();
    expect(store.has("zbopf_prb1")).toBe(false);
  });

  it("cascade_ddic: true on an armed delete additionally requires confirm_cascade to echo the bo name", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const missing = await invoke(tools, "abap_bopf_delete", {
      bo: "ZBOPF_PRB1",
      dry_run: false,
      confirm: "ZBOPF_PRB1",
      cascade_ddic: true,
    });
    expect(errorPayload(missing).error).toBe("BAD_INPUT");
    expect(store.has("zbopf_prb1")).toBe(true); // still untouched

    const wrong = await invoke(tools, "abap_bopf_delete", {
      bo: "ZBOPF_PRB1",
      dry_run: false,
      confirm: "ZBOPF_PRB1",
      cascade_ddic: true,
      confirm_cascade: "SOMETHING_ELSE",
    });
    expect(errorPayload(wrong).error).toBe("BAD_INPUT");
    expect(store.has("zbopf_prb1")).toBe(true);
  });

  it("a closed delete gate refuses at preflight, before ensureConnected/any network call", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const before = callsAfterConnect(server);
    const { tools } = await registered(conn, { safety: closedGate() });

    const result = await invoke(tools, "abap_bopf_delete", { bo: "ZBOPF_PRB1" });
    expect(errorPayload(result).error).toBe("READ_ONLY");
    expect(callsAfterConnect(server)).toBe(before);
  });

  it("an armed, correctly-confirmed cascade delete still refuses SAFETY_DENIED (and leaves the BO untouched) when the gate lacks allowCascadeDelete — e.g. ABAP_MODE=edit", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    // Wide open for an ordinary write/delete, exactly what `ABAP_MODE=edit`
    // resolves to — but no allowCascadeDelete, the admin-only ceiling.
    const editShapedGate = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
    const { tools } = await registered(conn, { safety: editShapedGate });

    const result = await invoke(tools, "abap_bopf_delete", {
      bo: "ZBOPF_PRB1",
      dry_run: false,
      confirm: "ZBOPF_PRB1",
      cascade_ddic: true,
      confirm_cascade: "ZBOPF_PRB1",
    });
    expect(errorPayload(result).error).toBe("SAFETY_DENIED");
    // Refused whole — not "BO deleted, cascade skipped".
    expect(store.has("zbopf_prb1")).toBe(true);
  });
});

// ===========================================================================

describe("errorResult round-trip sanity", () => {
  it("a raw (non-AbapError) throw from deep inside the wire path still comes back through isAbapError-classified errorResult", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    // No node passed for an operation that requires one — a local, synchronous
    // AbapError (BAD_INPUT), proving the try/catch -> deps.errorResult wiring
    // in the tool handler actually runs for a thrown AbapError, not just for
    // network-shaped failures.
    const result = await invoke(tools, "abap_bopf_edit", { bo: "ZBOPF_PRB1", operation: "add_association" });
    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(typeof payload.message).toBe("string");
  });
});
