/**
 * Regression tests: `abap_bopf_edit operation:"add_alternative_key"`
 * failed 7/7 times live, short-dumping the ADT session 3/7. Three independent
 * hardenings, each covered here:
 *
 * 1. `spec.uniqueness` is a closed 3-value enum (`KeyUniquenessType`,
 *    `src/adt/bopf-types.ts`) now validated client-side via `strEnum` —
 *    an unrecognised value refuses `BAD_INPUT` before any network call
 *    instead of risking the server-side dump an invalid category is known
 *    to cause elsewhere on this surface.
 * 2. `validateAlternativeKeySpec` hard-requires `uniqueness`, `dataTypeRef`,
 *    `dataTableTypeRef`, and `keyElements` — every captured `bo:alternativeKeys`
 *    element on the wire carries all four, and a partial one is what BOPF's
 *    model mapper (`/BOBF/CL_CONF_MODEL_API_MAP`) dumps on.
 * 3. `runBopfEdit` re-reads the model after the PUT and counts alternative
 *    keys of that name/node; an unchanged count throws `CHECK_FAILED` and
 *    skips activation — a BOPF PUT answers 200 whether or not it kept what
 *    was sent.
 *
 * Harness: identical to `test/bopf-tools.test.ts` and
 * `test/bopf-add-node-verify.test.ts` — a real `AbapConnection` against a
 * `FakeAdtServer`, a real `SafetyGate`, real `errorResult`. Only the HTTP
 * socket and `SessionPool` are fake.
 *
 * `COMPLETE_SPEC.keyElements: ["FIELD1"]` names a property that does not
 * exist on `FX_JUST_CREATED`'s ROOT (KEY/PARENT_KEY/ROOT_KEY only, no
 * persistentStructureRef), which is now refused by `alternativeKeyPreflight`
 * (a follow-up hardening — see `test/bopf-alternative-key-preflight.test.ts`
 * for that check's own coverage). The wire-payload/verification tests below
 * are not testing that check, so they pass `allow_dangling_ref: true` to get
 * past it and exercise what they actually pin.
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
  fakeResponse,
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

/** ZBOPF_PRB1, inactive, root-node-only — no alternative keys on ROOT. */
const FX_JUST_CREATED = fixture("02-created-zbopf_prb1-root-only.v4.xml");

const COMPLETE_SPEC = {
  uniqueness: "unique",
  dataTypeRef: { name: "ZSORDER_ID", type: "TABL/DS" },
  dataTableTypeRef: { name: "ZTORDER_ID", type: "TTYP/DA" },
  keyElements: ["FIELD1"],
  noCheck: true,
};

/**
 * Structural short-dump markers `classifySessionFailure` (src/adt/session.ts)
 * checks first, ahead of any content-type/prose tier — same shape a real
 * `/BOBF/CL_CONF_MODEL_API_MAP` dump renders.
 */
const DUMP_BODY =
  `<html><body><div class="errorTextHeader">Short dump</div>` +
  `<div id="msgText">The current ABAP program had to be terminated.</div></body></html>`;

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

/** Same idiom as bopf-add-node-verify.test.ts's `withTempJournal` — a real Journal against a temp dir, for the one test that needs a genuine journalEntryId. */
async function withTempJournal<T>(fn: (journal: Journal) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "abapsmith-bopf-alt-key-payload-"));
  try {
    return await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ===========================================================================

describe("add_alternative_key: spec is validated client-side before any network call", () => {
  it('refuses spec.uniqueness = "sometimes" with BAD_INPUT naming all three allowed values', async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { ...COMPLETE_SPEC, uniqueness: "sometimes" },
      i_know_this_may_not_activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain('"unique"');
    expect(String(payload.message)).toContain('"uniqueIfNotInitial"');
    expect(String(payload.message)).toContain('"notUnique"');

    expect(callsAfterConnect(server)).toBe(before);
  });

  it("refuses a spec missing uniqueness, dataTypeRef, and dataTableTypeRef with BAD_INPUT naming all three", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: { keyElements: ["FIELD1"] },
      i_know_this_may_not_activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("uniqueness");
    expect(String(payload.message)).toContain("dataTypeRef");
    expect(String(payload.message)).toContain("dataTableTypeRef");
    const details = payload.details as Record<string, unknown>;
    expect(details.missing).toEqual(["uniqueness", "dataTypeRef", "dataTableTypeRef"]);

    expect(callsAfterConnect(server)).toBe(before);
  });

  it("refuses a spec missing only keyElements with BAD_INPUT naming it", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);
    const before = callsAfterConnect(server);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: {
        uniqueness: "unique",
        dataTypeRef: COMPLETE_SPEC.dataTypeRef,
        dataTableTypeRef: COMPLETE_SPEC.dataTableTypeRef,
      },
      i_know_this_may_not_activate: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("keyElements");
    const details = payload.details as Record<string, unknown>;
    expect(details.missing).toEqual(["keyElements"]);

    expect(callsAfterConnect(server)).toBe(before);
  });
});

describe("add_alternative_key: wire payload and post-write verification", () => {
  it("a complete spec writes uniqueness, dataTypeRef, dataTableTypeRef, and keyElements onto the wire alongside the key's own name", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: COMPLETE_SPEC,
      i_know_this_may_not_activate: true,
      allow_dangling_ref: true,
    });

    expect(result.isError).toBeFalsy();
    const putBody = store.get("zbopf_prb1")!;
    expect(putBody).toContain("bo:uniqueness");
    expect(putBody).toContain("<bo:dataTypeRef");
    expect(putBody).toContain("<bo:dataTableTypeRef");
    expect(putBody).toContain("<bo:keyElements");
    expect(putBody).toContain('bo:name="ALT1"');
  });

  it("returns CHECK_FAILED, not success, when the server accepts the PUT (200) but the re-read shows no new alternative key — and sends no activation request even with activate: true", async () => {
    // BOPF's own documented lie: 200 on a PUT it silently discarded. Routed
    // BEFORE store.route so the PUT never actually lands in the backing
    // map — the subsequent re-read GET (putModel's own) serves back the
    // untouched, root-only fixture: zero alternative keys named ALT1.
    const discardPutRoute: FakeRoute = (r) =>
      r.method === "PUT" && r.path === `${BOPF_COLLECTION_PATH}/zbopf_prb1` ? EMPTY_200() : undefined;

    await withTempJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
      const { conn, server } = await wired({ routes: [discardPutRoute, store.route] });
      const { tools } = await registered(conn, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "add_alternative_key",
        node: "ROOT",
        name: "ALT1",
        spec: COMPLETE_SPEC,
        i_know_this_may_not_activate: true,
        allow_dangling_ref: true,
        activate: true,
      });

      const payload = errorPayload(result);
      expect(payload.error).toBe("CHECK_FAILED");
      const details = payload.details as Record<string, unknown>;
      expect(details.countBefore).toBe(0);
      expect(details.countAfter).toBe(0);
      expect(typeof details.journalEntryId).toBe("string");
      expect(details.journalEntryId).toBeTruthy();

      expect(store.get("zbopf_prb1")).toBe(FX_JUST_CREATED); // discarded, as BOPF actually did

      const activationCalls = server.calls.filter(
        (r) => r.method === "POST" && r.path.includes("/sap/bc/adt/activation"),
      );
      expect(activationCalls).toHaveLength(0);
    });
  });

  it("a short-dump response to the PUT surfaces as SESSION_DEAD naming add_alternative_key, the bo, node, and key name", async () => {
    const dumpPutRoute: FakeRoute = (r) =>
      r.method === "PUT" && r.path === `${BOPF_COLLECTION_PATH}/zbopf_prb1`
        ? fakeResponse(500, DUMP_BODY, { "content-type": "text/html" })
        : undefined;

    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [dumpPutRoute, store.route] });
    const { tools } = await registered(conn);

    const result = await invoke(tools, "abap_bopf_edit", {
      bo: "ZBOPF_PRB1",
      operation: "add_alternative_key",
      node: "ROOT",
      name: "ALT1",
      spec: COMPLETE_SPEC,
      i_know_this_may_not_activate: true,
      allow_dangling_ref: true,
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("SESSION_DEAD");
    expect(String(payload.message)).toContain("add_alternative_key");

    const details = payload.details as Record<string, unknown>;
    expect(details.tool).toBe("abap_bopf_edit");
    expect(details.operation).toBe("add_alternative_key");
    expect(details.bo).toBe("ZBOPF_PRB1");
    expect(details.node).toBe("ROOT");
    expect(details.name).toBe("ALT1");
    expect(details.kind).toBe("dump");
  });
});
