/**
 * `abap_bopf_delete`'s `cascade_persistent` opt-in.
 *
 * `cascade_ddic` sweeps a BO's GENERATED DDIC companions (combinedTableRef /
 * combinedStructureRef / constantsInterfaceRef) but always spares the
 * REFERENCED ones (persistentTableRef / persistentStructureRef), since the
 * model gives no way to tell whether this BO created them. `cascade_persistent`
 * is the explicit, name-by-name override: each name must resolve against the
 * model, live in the BO's own package (probed just before the delete), and
 * not be referenced under more than one ref slot — and it requires
 * `cascade_ddic: true` since it extends that cascade rather than replacing it.
 *
 * Every scenario below goes through the registered `abap_bopf_delete` (and,
 * for the journal case, `abap_journal`) tool only — never `src/adt/bopf.ts`
 * directly — so this file stays a proof of tool-level behaviour independent
 * of how the resolve/probe helpers are implemented internally.
 *
 * Harness copied from `test/bopf-delete-reporting.test.ts`
 * (wired/fakePool/fakeMcp/invoke/okText/depsFor) and, for the journal test,
 * `test/bopf-journal.test.ts`'s `withJournal`/`journalEntryIdInText` idiom.
 * Fixture: `04-active-after-structures.v4.xml` — BO `ZBOPF_PRB1` in `$TMP`,
 * ROOT node referencing `ZBOPF_D_ROOT` (table) / `/BOBF/S_DEMO_SALES_ORDER_HDR`
 * (structure), ITEM node referencing `ZBOPF_D_ITEM` / `/BOBF/S_DEMO_SALES_ORDER_ITM`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FakeAdtServer, __resetFakeAdtCounters, bopfStore, ddicProbeRoute, type FakeRoute } from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import type { SessionPool } from "../src/adt/pool.js";
import { errorResult } from "../src/server.js";
import { bopfUri } from "../src/adt/bopf.js";
import { registerBopfTools, type BopfToolDeps } from "../src/tools/bopf.js";
import { registerJournalTools, type JournalToolDeps } from "../src/tools/journal.js";
import { Journal, type JournalConfig } from "../src/journal.js";

// --------------------------------------------------------------------- harness ---

const openGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowTransportRelease: true,
    allowCascadeDelete: true,
  });

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const fixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

const BO = "ZBOPF_PRB1";
const FX = fixture("04-active-after-structures.v4.xml");

const URI_D_ROOT = "/sap/bc/adt/ddic/tables/zbopf_d_root";
const URI_D_ITEM = "/sap/bc/adt/ddic/tables/zbopf_d_item";
const URI_S_HDR = "/sap/bc/adt/ddic/structures/%2fbobf%2fs_demo_sales_order_hdr";
const URI_T_ROOT = "/sap/bc/adt/ddic/tabletypes/zbopf_t_root";
const URI_T_ITEM = "/sap/bc/adt/ddic/tabletypes/zbopf_t_item";
const URI_S_ROOT = "/sap/bc/adt/ddic/structures/zbopf_s_root";
const URI_S_ITEM = "/sap/bc/adt/ddic/structures/zbopf_s_item";
const URI_CONST_IF = "/sap/bc/adt/oo/interfaces/zif_bopf_prb1_c";

/** The generated sweep's five candidates — always probed when cascade_ddic is armed. */
const generatedCandidateRoutes = (): FakeRoute[] =>
  [URI_T_ROOT, URI_T_ITEM, URI_S_ROOT, URI_S_ITEM, URI_CONST_IF].map((uri) => ddicProbeRoute({ uri, exists: true }));

const BO2 = "ZBOPF_PRB2";
const URI2_D = "/sap/bc/adt/ddic/tables/zbopf_d_prb2";
const URI2_S = "/sap/bc/adt/ddic/structures/zbopf_s_prb2";
const URI2_T_GEN = "/sap/bc/adt/ddic/tabletypes/zbopf_t_prb2";
const URI2_S_GEN = "/sap/bc/adt/ddic/structures/zbopf_sg_prb2";
const URI2_CONST_IF = "/sap/bc/adt/oo/interfaces/zif_bopf_prb2_c";

/**
 * Inline, not a fixture: a root node whose persistentTableRef/
 * persistentStructureRef are ordinary Z* names in $TMP. FX's only
 * persistentStructureRefs are /BOBF/* names, which the reserved-namespace
 * rule refuses outright — there is no fixture-based way to pin "a requested
 * structure actually gets DELETEd" ordering against it.
 */
const PERSISTENT_TARGETS_BO_XML =
  `<?xml version="1.0" encoding="utf-8"?><bo:businessObject adtcore:name="${BO2}" adtcore:type="BOBF" ` +
  `xmlns:bo="http://www.sap.com/bopf/bo/BusinessObject" xmlns:adtcore="http://www.sap.com/adt/core">` +
  `<adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/%24tmp" adtcore:type="DEVC/K" adtcore:name="$TMP"/>` +
  `<bo:constantsInterfaceRef adtcore:uri="${URI2_CONST_IF}" adtcore:type="INTF/OI" adtcore:name="ZIF_BOPF_PRB2_C"/>` +
  `<bo:nodes bo:name="ROOT" bo:rootNode="true">` +
  `<bo:persistentTableRef adtcore:uri="${URI2_D}" adtcore:type="TABL/DT" adtcore:name="ZBOPF_D_PRB2"/>` +
  `<bo:persistentStructureRef adtcore:uri="${URI2_S}" adtcore:type="TABL/DS" adtcore:name="ZBOPF_S_PRB2"/>` +
  `<bo:combinedTableRef adtcore:uri="${URI2_T_GEN}" adtcore:type="TTYP/DA" adtcore:name="ZBOPF_T_PRB2"/>` +
  `<bo:combinedStructureRef adtcore:uri="${URI2_S_GEN}" adtcore:type="TABL/DS" adtcore:name="ZBOPF_SG_PRB2"/>` +
  `</bo:nodes></bo:businessObject>`;

const systemRoleRoute: FakeRoute = (r) => (r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined);

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

async function wired(options: { routes?: readonly FakeRoute[] } = {}): Promise<{ conn: AbapConnection; server: FakeAdtServer }> {
  const server = new FakeAdtServer({ transportErrors: "throw", routes: [systemRoleRoute, ...(options.routes ?? [])] });
  const client = server.client("s1");
  const conn = new AbapConnection(cfg(), { httpClient: client, log: () => {}, breaker: new AuthCircuitBreaker() });
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
    primary: () => conn,
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

function errorPayload(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBe(true);
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content part");
  return JSON.parse(text.text) as Record<string, unknown>;
}

const fakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({ kind: "transport", required: true, mustSupplyCorrNr: true, serverWouldFabricate: false, ...overrides }) as unknown as TrRequirement;

const localTransport = (): SessionTransport =>
  new SessionTransport({ allowTransports: ["auto"], cts: { trRequirement: vi.fn(async () => fakeReq({ kind: "local" })) } });

function depsFor(conn: AbapConnection, opts: { journal?: Journal } = {}): BopfToolDeps {
  return {
    pool: fakePool(conn),
    safety: openGate(),
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: 30_000 },
    transport: localTransport(),
    registerWrite: true,
    ...(opts.journal ? { journal: opts.journal } : {}),
  };
}

async function registeredTools(
  conn: AbapConnection,
  opts: { journal?: Journal } = {},
): Promise<{ tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }> }> {
  const { mcp, tools } = fakeMcp();
  registerBopfTools(mcp, depsFor(conn, opts));
  if (opts.journal) {
    const journalDeps: JournalToolDeps = {
      pool: fakePool(conn),
      safety: openGate(),
      ensureConnected: async () => {},
      errorResult,
      cfg: { maxResponseChars: 30_000 },
      journal: opts.journal,
    };
    registerJournalTools(mcp, journalDeps);
  }
  return { tools };
}

// ------------------------------------------------------------------ journal harness ---

let dir: string;
const jcfg = (): JournalConfig => ({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 });
const withJournal = async (fn: (j: Journal) => Promise<void>): Promise<void> => {
  dir = await mkdtemp(join(tmpdir(), "abapsmith-bopf-cascade-persistent-"));
  try {
    await fn(new Journal(jcfg(), "A4H"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

function journalEntryIdInText(result: CallToolResult): string | undefined {
  const first = result.content[0];
  if (!first || first.type !== "text") return undefined;
  return /^journalEntryId: (\S+)$/m.exec(first.text)?.[1];
}

// ===========================================================================

describe("cascade_persistent without cascade_ddic is refused before any request", () => {
  it("armed call: BAD_INPUT, zero requests recorded", async () => {
    const store = bopfStore({ zbopf_prb1: FX });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registeredTools(conn);
    const before = server.calls.length;

    const result = await invoke(tools, "abap_bopf_delete", {
      bo: BO,
      dry_run: false,
      confirm: BO,
      cascade_persistent: ["ZBOPF_D_ROOT"],
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("cascade_persistent requires cascade_ddic: true");
    expect(server.calls.length).toBe(before);
  });

  it("dry run: same refusal, same zero-request guarantee", async () => {
    const store = bopfStore({ zbopf_prb1: FX });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registeredTools(conn);
    const before = server.calls.length;

    const result = await invoke(tools, "abap_bopf_delete", {
      bo: BO,
      cascade_persistent: ["ZBOPF_D_ROOT"],
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("cascade_persistent requires cascade_ddic: true");
    expect(server.calls.length).toBe(before);
  });
});

describe("dry run previews DDIC DELETED ON REQUEST", () => {
  it("names the requested object as would-delete, still lists the un-requested referenced objects as spared, deletes nothing", async () => {
    const store = bopfStore({ zbopf_prb1: FX });
    const { conn, server } = await wired({
      routes: [store.route, ddicProbeRoute({ uri: URI_D_ROOT, exists: true, packageName: "$TMP" })],
    });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", {
      bo: BO,
      cascade_ddic: true,
      cascade_persistent: ["ZBOPF_D_ROOT"],
    });
    const text = okText(result);

    expect(text).toContain("--- DDIC DELETED ON REQUEST ---");
    expect(text).toMatch(/table\s+ZBOPF_D_ROOT\s+\/sap\/bc\/adt\/ddic\/tables\/zbopf_d_root\s+existed=true\s+would delete/);
    expect(text).toMatch(/ddicRequestedCount: 1/);

    // DDIC SPARED still lists the objects that were NOT named.
    expect(text).toContain("--- DDIC SPARED (provenance unknown — never deleted) ---");
    expect(text).toContain("ZBOPF_D_ITEM");
    expect(text).toContain("/BOBF/S_DEMO_SALES_ORDER_HDR");
    expect(text).toContain("/BOBF/S_DEMO_SALES_ORDER_ITM");

    expect(server.callsFor((r) => r.method === "DELETE")).toHaveLength(0);
  });
});

describe("cascade_persistent name matching is case-insensitive", () => {
  it("a lowercase name resolves to the model's own casing", async () => {
    const store = bopfStore({ zbopf_prb1: FX });
    const { conn } = await wired({
      routes: [store.route, ddicProbeRoute({ uri: URI_D_ROOT, exists: true, packageName: "$TMP" })],
    });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", {
      bo: BO,
      cascade_ddic: true,
      cascade_persistent: ["zbopf_d_root"],
    });
    const text = okText(result);

    expect(text).toContain("--- DDIC DELETED ON REQUEST ---");
    expect(text).toMatch(/table\s+ZBOPF_D_ROOT\s+\/sap\/bc\/adt\/ddic\/tables\/zbopf_d_root\s+existed=true\s+would delete/);
  });
});

describe("cascade_persistent naming an object the model does not reference", () => {
  it("refuses BAD_INPUT naming the objects that ARE referenced, deletes nothing", async () => {
    const store = bopfStore({ zbopf_prb1: FX });
    const { conn, server } = await wired({ routes: [store.route] });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", {
      bo: BO,
      cascade_ddic: true,
      cascade_persistent: ["ZBOPF_D_NOPE"],
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("ZBOPF_D_NOPE");
    expect(String(payload.message)).toContain("ZBOPF_D_ROOT");
    expect(String(payload.message)).toContain("ZBOPF_D_ITEM");
    expect(server.callsFor((r) => r.method === "DELETE")).toHaveLength(0);
  });
});

describe("cascade_persistent naming an object that lives in a different package", () => {
  it("refuses BAD_INPUT naming both packages, deletes nothing", async () => {
    const store = bopfStore({ zbopf_prb1: FX });
    const { conn, server } = await wired({
      routes: [store.route, ddicProbeRoute({ uri: URI_S_HDR, exists: true, packageName: "/BOBF/DEMO" })],
    });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", {
      bo: BO,
      cascade_ddic: true,
      cascade_persistent: ["/BOBF/S_DEMO_SALES_ORDER_HDR"],
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("/BOBF/DEMO");
    expect(String(payload.message)).toContain("$TMP");
    expect(server.callsFor((r) => r.method === "DELETE")).toHaveLength(0);
  });
});

describe("cascade_persistent probe whose document carries no <adtcore:packageRef>", () => {
  it("refuses BAD_INPUT, deletes nothing", async () => {
    const store = bopfStore({ zbopf_prb1: FX });
    const { conn, server } = await wired({
      routes: [store.route, ddicProbeRoute({ uri: URI_D_ROOT, exists: true })],
    });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", {
      bo: BO,
      cascade_ddic: true,
      cascade_persistent: ["ZBOPF_D_ROOT"],
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("BAD_INPUT");
    expect(String(payload.message)).toContain("no single, unambiguous");
    expect(server.callsFor((r) => r.method === "DELETE")).toHaveLength(0);
  });
});

describe("armed delete order: BO, then the generated cascade, then cascade_persistent last", () => {
  it("pins the DELETE sequence via the recorded request order", async () => {
    const store = bopfStore({ zbopf_prb1: FX });
    const { conn, server } = await wired({
      routes: [store.route, ...generatedCandidateRoutes(), ddicProbeRoute({ uri: URI_D_ROOT, exists: true, packageName: "$TMP" })],
    });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", {
      bo: BO,
      dry_run: false,
      confirm: BO,
      cascade_ddic: true,
      confirm_cascade: BO,
      cascade_persistent: ["ZBOPF_D_ROOT"],
    });
    const text = okText(result);
    expect(text).toMatch(/boDeleted: true/);
    expect(text).toMatch(/table\s+ZBOPF_D_ROOT\s+existed=true\s+deleted=true/);

    const deletes = server.callsFor((r) => r.method === "DELETE").map((r) => r.path);
    const boIdx = deletes.indexOf(bopfUri(BO));
    const generatedIdx = [URI_T_ROOT, URI_T_ITEM, URI_S_ROOT, URI_S_ITEM, URI_CONST_IF].map((u) => deletes.indexOf(u));
    const requestedIdx = deletes.indexOf(URI_D_ROOT);

    expect(boIdx).toBeGreaterThanOrEqual(0);
    for (const idx of generatedIdx) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeGreaterThan(boIdx);
    }
    expect(requestedIdx).toBeGreaterThanOrEqual(0);
    expect(requestedIdx).toBeGreaterThan(Math.max(...generatedIdx));
  });
});

// `/BOBF/S_DEMO_SALES_ORDER_HDR` starts with "/" — `isSapNamespace` (src/safety.ts)
// unconditionally refuses ANY object whose name starts with "/", regardless of
// `allowPackages`. `assertRequestedTargetsGate` now runs this check on every
// present cascade_persistent target BEFORE deps.safety.authorize, before the
// write session, and before the journal entry — so naming a /BOBF/ object
// refuses the WHOLE call, business object included, rather than deleting the
// BO and only then reporting the structure as deleted=false.
describe("cascade_persistent naming a /BOBF/ object is refused up front, before anything is deleted", () => {
  it("armed call: SAFETY_DENIED naming the namespace and the object; zero DELETEs recorded — the business object itself is never touched", async () => {
    const store = bopfStore({ zbopf_prb1: FX });
    const { conn, server } = await wired({
      routes: [
        store.route,
        ddicProbeRoute({ uri: URI_D_ROOT, exists: true, packageName: "$TMP" }),
        ddicProbeRoute({ uri: URI_S_HDR, exists: true, packageName: "$TMP" }),
      ],
    });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", {
      bo: BO,
      dry_run: false,
      confirm: BO,
      cascade_ddic: true,
      confirm_cascade: BO,
      cascade_persistent: ["ZBOPF_D_ROOT", "/BOBF/S_DEMO_SALES_ORDER_HDR"],
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("SAFETY_DENIED");
    expect(String(payload.message)).toContain("/BOBF/S_DEMO_SALES_ORDER_HDR");
    expect(String(payload.message)).toContain("reserved SAP namespace");

    expect(server.callsFor((r) => r.method === "DELETE")).toEqual([]);
  });

  it("dry run: the identical refusal — a preview can no longer promise a delete the armed path could never perform", async () => {
    const store = bopfStore({ zbopf_prb1: FX });
    const { conn, server } = await wired({
      routes: [
        store.route,
        ddicProbeRoute({ uri: URI_D_ROOT, exists: true, packageName: "$TMP" }),
        ddicProbeRoute({ uri: URI_S_HDR, exists: true, packageName: "$TMP" }),
      ],
    });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", {
      bo: BO,
      dry_run: true,
      cascade_ddic: true,
      cascade_persistent: ["ZBOPF_D_ROOT", "/BOBF/S_DEMO_SALES_ORDER_HDR"],
    });

    const payload = errorPayload(result);
    expect(payload.error).toBe("SAFETY_DENIED");
    expect(String(payload.message)).toContain("/BOBF/S_DEMO_SALES_ORDER_HDR");
    expect(String(payload.message)).toContain("reserved SAP namespace");

    expect(server.callsFor((r) => r.method === "DELETE")).toEqual([]);
  });
});

// Both `buildDryRunDeleteResponse` and `buildDeleteResultResponse` exclude
// every cascade_persistent name (trimmed + upper-cased) from DDIC SPARED, the
// non-cascade spared NOTE, and the `ddicSparedCount` header key — a name
// can't legitimately be both "would delete" and "provenance unknown, never
// deleted" in the same response.
describe("cascade_persistent naming a genuinely deletable object is never double-listed under DDIC SPARED", () => {
  it("armed: ZBOPF_D_ROOT appears only under DDIC DELETED ON REQUEST; ddicSparedCount drops from 4 to 3", async () => {
    const store = bopfStore({ zbopf_prb1: FX });
    const { conn } = await wired({
      routes: [store.route, ...generatedCandidateRoutes(), ddicProbeRoute({ uri: URI_D_ROOT, exists: true, packageName: "$TMP" })],
    });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", {
      bo: BO,
      dry_run: false,
      confirm: BO,
      cascade_ddic: true,
      confirm_cascade: BO,
      cascade_persistent: ["ZBOPF_D_ROOT"],
    });
    const text = okText(result);

    const requestedSection = (text.split("--- DDIC DELETED ON REQUEST ---")[1] ?? "").split("---")[0];
    expect(requestedSection).toContain("ZBOPF_D_ROOT");

    const sparedSection = (text.split("--- DDIC SPARED (provenance unknown — never deleted) ---")[1] ?? "").split("---")[0];
    expect(sparedSection).not.toContain("ZBOPF_D_ROOT");
    expect(sparedSection).toContain("ZBOPF_D_ITEM");
    expect(sparedSection).toContain("/BOBF/S_DEMO_SALES_ORDER_HDR");
    expect(sparedSection).toContain("/BOBF/S_DEMO_SALES_ORDER_ITM");

    expect(text).toMatch(/ddicSparedCount: 3/);
  });

  it("dry run: the same exclusion from DDIC SPARED and the same reduced ddicSparedCount", async () => {
    const store = bopfStore({ zbopf_prb1: FX });
    const { conn } = await wired({
      routes: [store.route, ddicProbeRoute({ uri: URI_D_ROOT, exists: true, packageName: "$TMP" })],
    });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", {
      bo: BO,
      cascade_ddic: true,
      cascade_persistent: ["ZBOPF_D_ROOT"],
    });
    const text = okText(result);

    const requestedSection = (text.split("--- DDIC DELETED ON REQUEST ---")[1] ?? "").split("---")[0];
    expect(requestedSection).toContain("ZBOPF_D_ROOT");

    const sparedSection = (text.split("--- DDIC SPARED (provenance unknown — never deleted) ---")[1] ?? "").split("---")[0];
    expect(sparedSection).not.toContain("ZBOPF_D_ROOT");
    expect(sparedSection).toContain("ZBOPF_D_ITEM");
    expect(sparedSection).toContain("/BOBF/S_DEMO_SALES_ORDER_HDR");
    expect(sparedSection).toContain("/BOBF/S_DEMO_SALES_ORDER_ITM");

    expect(text).toMatch(/ddicSparedCount: 3/);
  });
});

// FX's persistentStructureRef targets are both /BOBF/* names, now refused
// outright by the reserved-namespace gate above — so a table+structure
// ordering case needs a model whose referenced objects are actually
// deletable. PERSISTENT_TARGETS_BO_XML supplies one.
describe("armed delete order with two genuinely deletable cascade_persistent targets", () => {
  it("pins the DELETE sequence: BO, then generated candidates, then the requested table, then the requested structure", async () => {
    const store = bopfStore({ zbopf_prb2: PERSISTENT_TARGETS_BO_XML });
    const { conn, server } = await wired({
      routes: [
        store.route,
        ddicProbeRoute({ uri: URI2_T_GEN, exists: true }),
        ddicProbeRoute({ uri: URI2_S_GEN, exists: true }),
        ddicProbeRoute({ uri: URI2_CONST_IF, exists: true }),
        ddicProbeRoute({ uri: URI2_D, exists: true, packageName: "$TMP" }),
        ddicProbeRoute({ uri: URI2_S, exists: true, packageName: "$TMP" }),
      ],
    });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", {
      bo: BO2,
      dry_run: false,
      confirm: BO2,
      cascade_ddic: true,
      confirm_cascade: BO2,
      cascade_persistent: ["ZBOPF_D_PRB2", "ZBOPF_S_PRB2"],
    });
    const text = okText(result);
    expect(text).toMatch(/boDeleted: true/);
    expect(text).toMatch(/table\s+ZBOPF_D_PRB2\s+existed=true\s+deleted=true/);
    expect(text).toMatch(/structure\s+ZBOPF_S_PRB2\s+existed=true\s+deleted=true/);

    const deletes = server.callsFor((r) => r.method === "DELETE").map((r) => r.path);
    expect(deletes).toEqual([bopfUri(BO2), URI2_T_GEN, URI2_S_GEN, URI2_CONST_IF, URI2_D, URI2_S]);
  });
});

describe("armed delete where the requested object's probe 404s", () => {
  it("reports existed=false deleted=false with a reason, attempts no DELETE on it, BO delete still succeeds", async () => {
    const store = bopfStore({ zbopf_prb1: FX });
    const { conn, server } = await wired({
      routes: [store.route, ...generatedCandidateRoutes(), ddicProbeRoute({ uri: URI_D_ITEM, exists: false })],
    });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", {
      bo: BO,
      dry_run: false,
      confirm: BO,
      cascade_ddic: true,
      confirm_cascade: BO,
      cascade_persistent: ["ZBOPF_D_ITEM"],
    });
    const text = okText(result);
    expect(text).toMatch(/boDeleted: true/);
    expect(store.has("zbopf_prb1")).toBe(false);
    expect(text).toMatch(/table\s+ZBOPF_D_ITEM\s+existed=false\s+deleted=false\s+reason=/);

    expect(server.callsFor((r) => r.method === "DELETE" && r.path === URI_D_ITEM)).toHaveLength(0);
  });
});

describe("cascade_persistent journal integration", () => {
  it("abap_journal show renders ALSO TOUCHED naming the cascade_persistent target", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX });
      const { conn } = await wired({
        routes: [store.route, ...generatedCandidateRoutes(), ddicProbeRoute({ uri: URI_D_ROOT, exists: true, packageName: "$TMP" })],
      });
      const { tools } = await registeredTools(conn, { journal });

      const deleteResult = await invoke(tools, "abap_bopf_delete", {
        bo: BO,
        dry_run: false,
        confirm: BO,
        cascade_ddic: true,
        confirm_cascade: BO,
        cascade_persistent: ["ZBOPF_D_ROOT"],
      });
      okText(deleteResult);
      const entryId = journalEntryIdInText(deleteResult);
      expect(entryId).toBeDefined();

      const entry = await journal.get(entryId!);
      expect(entry?.parts?.length).toBe(1);

      const showResult = await invoke(tools, "abap_journal", { mode: "show", entry: entryId });
      const text = okText(showResult);
      expect(text).toContain("--- ALSO TOUCHED (1) ---");
      expect(text).toContain("ZBOPF_D_ROOT");
    });
  });

  it("a delete with no cascade_persistent records an entry with no parts at all — no ALSO TOUCHED section", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX });
      const { conn } = await wired({ routes: [store.route] });
      const { tools } = await registeredTools(conn, { journal });

      const deleteResult = await invoke(tools, "abap_bopf_delete", { bo: BO, dry_run: false, confirm: BO });
      okText(deleteResult);
      const entryId = journalEntryIdInText(deleteResult);
      expect(entryId).toBeDefined();

      const entry = await journal.get(entryId!);
      expect(entry?.parts).toBeUndefined();

      const showResult = await invoke(tools, "abap_journal", { mode: "show", entry: entryId });
      const text = okText(showResult);
      expect(text).not.toContain("ALSO TOUCHED");
    });
  });
});
