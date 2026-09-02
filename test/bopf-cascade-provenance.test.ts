/**
 * `cascade_ddic` provenance: does `deleteBusinessObject` (`src/adt/bopf.ts`)
 * correctly tell apart DDIC objects this BO GENERATED from DDIC objects an
 * AUTHOR merely REFERENCED.
 *
 * Before this split, every one of `persistentTableRef`/`combinedTableRef`/
 * `persistentStructureRef`/`combinedStructureRef` was walked into one
 * undifferentiated candidate list and cascade-deleted alike. A live dry run
 * against a throwaway `$TMP` BO listed `ZTMD_S_BO_ROOT`/`ZTMD_S_BO_ITEM` —
 * course fixtures living in a DIFFERENT package (`ZTMD_COURSES`), referenced
 * by the throwaway BO but never created by it — as deletion candidates.
 * Nothing was deleted (dry run), but the candidate list crossed a package
 * boundary without comment, and an armed cascade would have deleted them for
 * real with no `abap_journal` undo available (this server never wrote them).
 *
 * `collectDdicCascadeCandidates` (`src/adt/bopf.ts`) now splits every
 * candidate by which ref slot it arrived on:
 *  - `generated` (cascade-deleted): `combinedStructureRef`, `combinedTableRef`,
 *    `model.constantsInterfaceRef`.
 *  - `referenced` (never deleted, reported as `ddicSpared`):
 *    `persistentStructureRef`, `persistentTableRef`.
 *
 * Same harness idiom as `test/bopf-client.test.ts`: real `bopf.ts` functions
 * against a `FakeAdtServer`, only the HTTP socket is fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FakeAdtServer, __resetFakeAdtCounters, bopfStore, ddicProbeRoute, type FakeRoute } from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { parseModel } from "../src/adt/bopf-xml.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import type { SessionPool } from "../src/adt/pool.js";
import { errorResult } from "../src/server.js";
import { bopfUri, deleteBusinessObject, collectDdicCascadeCandidates, ddicSparedReason } from "../src/adt/bopf.js";
import { registerBopfTools, type BopfToolDeps } from "../src/tools/bopf.js";

// --------------------------------------------------------------------- harness ---

const openGate = (): SafetyGate =>
  new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowTransportRelease: true,
    allowCascadeDelete: true,
  });

function mintDelete(name: string, packageName = "$TMP"): { authorized: ReturnType<SafetyGate["authorize"]>; gate: SafetyGate } {
  const gate = openGate();
  return { authorized: gate.authorize("delete", { name, packageName, type: "BOBF" }), gate };
}

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
const fixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

/** ZBOPF_PRB1, active, after its structures/tables were authored — real captured shape. */
const FX_PRB1_ACTIVE_STRUCTURES = fixture("04-active-after-structures.v4.xml");

/**
 * ZBOPF_PRB1 immediately after `create_bo`, root node only — real captured
 * shape. `buildCreateBody` (`src/adt/bopf.ts`) sends no DDIC refs at all, yet
 * the root node already carries `persistentTableRef` `ZBOPF_D_ROOT`: BOPF
 * auto-assigned it. This is the fixture the spared-reason fix turns on.
 */
const FX_JUST_CREATED = fixture("02-created-zbopf_prb1-root-only.v4.xml");

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

// ===========================================================================

describe("collectDdicCascadeCandidates: classification of fixture 04's real refs", () => {
  it("splits ZBOPF_PRB1's refs by ref site: SAP-owned persistentStructureRef spared, BO-generated combined refs and the constants interface cascaded", () => {
    const model = parseModel(FX_PRB1_ACTIVE_STRUCTURES);
    const { generated, referenced } = collectDdicCascadeCandidates(model);

    const generatedNames = generated.map((c) => c.name).sort();
    const referencedNames = referenced.map((c) => c.name).sort();

    // The exact shape reported live: /BOBF/S_DEMO_SALES_ORDER_HDR is an
    // SAP-delivered structure this BO certainly did not create, arriving via
    // persistentStructureRef — it must be spared, not offered for deletion.
    expect(generatedNames).not.toContain("/BOBF/S_DEMO_SALES_ORDER_HDR");
    expect(referencedNames).toContain("/BOBF/S_DEMO_SALES_ORDER_HDR");
    expect(referencedNames).toContain("/BOBF/S_DEMO_SALES_ORDER_ITM");

    // ZBOPF_S_ROOT / ZBOPF_T_ROOT — named after the BO, arriving via
    // combinedStructureRef/combinedTableRef — ARE deletion candidates.
    expect(generatedNames).toContain("ZBOPF_S_ROOT");
    expect(generatedNames).toContain("ZBOPF_T_ROOT");
    expect(generatedNames).toContain("ZBOPF_S_ITEM");
    expect(generatedNames).toContain("ZBOPF_T_ITEM");

    // persistentTableRef (ZBOPF_D_ROOT/ZBOPF_D_ITEM) is spared too, even
    // though it is genuinely this BO's own generated table in this fixture —
    // the split is by ref SLOT, not by content, deliberately: an orphaned
    // table is recoverable by hand, a wrongly deleted foreign object is not.
    expect(referencedNames).toContain("ZBOPF_D_ROOT");
    expect(referencedNames).toContain("ZBOPF_D_ITEM");
    expect(generatedNames).not.toContain("ZBOPF_D_ROOT");

    // Constants interface: genuinely generated, still cascaded.
    const constantsCandidate = generated.find((c) => c.kind === "constants-interface");
    expect(constantsCandidate?.name).toBe("ZIF_BOPF_PRB1_C");
    expect(constantsCandidate?.refSite).toBe("constantsInterfaceRef");

    expect(generated).toHaveLength(5);
    expect(referenced).toHaveLength(4);

    for (const c of referenced) {
      expect(["persistentStructureRef", "persistentTableRef"]).toContain(c.refSite);
    }
    for (const c of generated) {
      expect(["combinedStructureRef", "combinedTableRef", "constantsInterfaceRef"]).toContain(c.refSite);
    }
  });
});

// ===========================================================================

describe("the provenance-reason fix does not touch the generated/referenced sparing behaviour, only the stated reason for it", () => {
  it("persistentTableRef/persistentStructureRef are never classified as generated, on fixture 02 (just-created, root only) or fixture 04 (active, with structures)", () => {
    for (const fx of [FX_JUST_CREATED, FX_PRB1_ACTIVE_STRUCTURES]) {
      const { generated, referenced } = collectDdicCascadeCandidates(parseModel(fx));
      expect(generated.some((c) => c.refSite === "persistentTableRef" || c.refSite === "persistentStructureRef")).toBe(false);
      expect(referenced.length).toBeGreaterThan(0);
      for (const c of referenced) {
        expect(["persistentTableRef", "persistentStructureRef"]).toContain(c.refSite);
      }
    }
  });

  it("an armed cascade delete on fixture 02 (root-only, just created) still never deletes ZBOPF_D_ROOT and still reports it spared", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({
      routes: [
        store.route,
        ddicProbeRoute({ uri: "/sap/bc/adt/ddic/tabletypes/zbopf_t_root", exists: true }),
        ddicProbeRoute({ uri: "/sap/bc/adt/oo/interfaces/zif_bopf_prb1_c", exists: true }),
      ],
    });

    const result = await conn.withStatefulSession(async (session) => {
      const { authorized, gate } = mintDelete("ZBOPF_PRB1");
      return deleteBusinessObject(conn, session, "ZBOPF_PRB1", authorized, gate, { cascadeDdic: true });
    });

    expect(result.ddic.some((d) => d.name === "ZBOPF_D_ROOT")).toBe(false);
    const spared = result.ddicSpared.find((d) => d.name === "ZBOPF_D_ROOT");
    expect(spared).toBeDefined();
  });
});

// ===========================================================================

describe("ddicSparedReason: the stated reason no longer claims provenance the model doesn't record", () => {
  it("the reason for ZBOPF_D_ROOT's auto-assigned persistentTableRef (fixture 02, captured right after create_bo, which sends no DDIC refs) does not claim the object was not generated by this BO", () => {
    const { referenced } = collectDdicCascadeCandidates(parseModel(FX_JUST_CREATED));
    const root = referenced.find((c) => c.name === "ZBOPF_D_ROOT");
    expect(root?.refSite).toBe("persistentTableRef");

    const reason = ddicSparedReason(root!.refSite);
    // create_bo sends no DDIC refs (buildCreateBody) yet this fixture already
    // carries persistentTableRef ZBOPF_D_ROOT — BOPF auto-assigned it. The
    // the old reason text claimed the opposite; it must not anymore.
    expect(reason).not.toContain("not generated by this BO");
    expect(reason).not.toMatch(/generated by this BO/);
    expect(reason).toContain("does not record");
  });
});

// ===========================================================================

describe("armed cascade_ddic delete: generated candidates deleted, referenced candidates never even requested", () => {
  it("issues DELETE for every generated candidate, issues NO request at all for the persistent ones, and still deletes the BO itself", async () => {
    const store = bopfStore({ zbopf_prb1: FX_PRB1_ACTIVE_STRUCTURES });
    const generatedRoutes = [
      "/sap/bc/adt/ddic/structures/zbopf_s_root",
      "/sap/bc/adt/ddic/tabletypes/zbopf_t_root",
      "/sap/bc/adt/ddic/structures/zbopf_s_item",
      "/sap/bc/adt/ddic/tabletypes/zbopf_t_item",
      "/sap/bc/adt/oo/interfaces/zif_bopf_prb1_c",
    ];
    // Deliberately NO routes for the referenced (spared) URIs below — if the
    // fix regresses and the cascade probes/deletes one of these, the fake
    // server throws "Unrouted request" and this test fails loudly rather
    // than silently passing.
    const referencedUris = [
      "/sap/bc/adt/ddic/structures/%2fbobf%2fs_demo_sales_order_hdr",
      "/sap/bc/adt/ddic/structures/%2fbobf%2fs_demo_sales_order_itm",
      "/sap/bc/adt/ddic/tables/zbopf_d_root",
      "/sap/bc/adt/ddic/tables/zbopf_d_item",
    ];
    const { conn, server } = await wired({
      routes: [store.route, ...generatedRoutes.map((uri) => ddicProbeRoute({ uri, exists: true }))],
    });

    const result = await conn.withStatefulSession(async (session) => {
      const { authorized, gate } = mintDelete("ZBOPF_PRB1");
      return deleteBusinessObject(conn, session, "ZBOPF_PRB1", authorized, gate, { cascadeDdic: true });
    });

    expect(result.boDeleted).toBe(true);
    const boDeletes = server.callsFor((r) => r.method === "DELETE" && r.path === bopfUri("ZBOPF_PRB1"));
    expect(boDeletes).toHaveLength(1);

    expect(result.ddic).toHaveLength(5);
    expect(result.ddic.every((d) => d.existed && d.deleted)).toBe(true);
    for (const uri of generatedRoutes) {
      const deletes = server.callsFor((r) => r.method === "DELETE" && r.path === uri);
      expect(deletes).toHaveLength(1);
    }
    // Regression guard: the constants interface is genuinely generated
    // and is still swept.
    expect(result.ddic.some((d) => d.name === "ZIF_BOPF_PRB1_C" && d.kind === "constants-interface" && d.deleted)).toBe(true);

    // No request of any method landed on any referenced (spared) URI.
    for (const uri of referencedUris) {
      expect(server.callsFor((r) => r.path === uri)).toEqual([]);
    }

    // Every spared object is reported by name with its reason — never
    // dropped, never summarised as a bare count.
    expect(result.ddicSpared).toHaveLength(4);
    const byName = new Map(result.ddicSpared.map((d) => [d.name, d]));
    expect(byName.get("/BOBF/S_DEMO_SALES_ORDER_HDR")?.reason).toBe(
      "referenced via persistentStructureRef — the model does not record whether this BO generated it, so it is not deleted",
    );
    expect(byName.get("/BOBF/S_DEMO_SALES_ORDER_ITM")?.reason).toBe(
      "referenced via persistentStructureRef — the model does not record whether this BO generated it, so it is not deleted",
    );
    expect(byName.get("ZBOPF_D_ROOT")?.reason).toBe(
      "referenced via persistentTableRef — the model does not record whether this BO generated it, so it is not deleted",
    );
    expect(byName.get("ZBOPF_D_ITEM")?.reason).toBe(
      "referenced via persistentTableRef — the model does not record whether this BO generated it, so it is not deleted",
    );
  });
});

// ===========================================================================

describe("cascade ceiling and batching, unaffected by the generated/referenced split", () => {
  it("cascadeDdic:true without the allowCascadeDelete ceiling still refuses the WHOLE delete, zero HTTP calls", async () => {
    const noCascadeGate = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
    const authorized = noCascadeGate.authorize("delete", { name: "ZBOPF_PRB1", packageName: "$TMP", type: "BOBF" });
    const store = bopfStore({ zbopf_prb1: FX_PRB1_ACTIVE_STRUCTURES });
    const { conn, server } = await wired({ routes: [store.route] });

    const before = server.calls.length;
    await expect(
      conn.withStatefulSession(async (session) =>
        deleteBusinessObject(conn, session, "ZBOPF_PRB1", authorized, noCascadeGate, { cascadeDdic: true }),
      ),
    ).rejects.toMatchObject({ code: "SAFETY_DENIED" });

    expect(server.calls.slice(before)).toEqual([]);
    expect(store.has("zbopf_prb1")).toBe(true); // untouched — refused before the BO's own delete too
  });

  it("all 5 generated candidates for fixture 04 run through the same ≤5-per-batch loop as before the split (exactly one full batch)", async () => {
    // The enumeration before the split offered 9 undifferentiated candidates for
    // this BO's shape, which is what originally motivated the >5 batching
    // test in bopf-client.test.ts. After the split, only 5 of those 9 are
    // ever cascade-deleted, which happens to land exactly on the batch-size
    // boundary — this proves the (unmodified) `.slice(i, i+5)` loop in
    // `deleteBusinessObject` still runs a full batch correctly post-fix, but
    // does NOT re-prove the >1-batch code path; that would need either a
    // hand-built model with more than 5 generated refs (no real capture has
    // one) or a synthetic BoModel bypassing readModel/parseModel entirely.
    // Flagged, not silently dropped — the batching loop itself is untouched
    // by this change.
    const store = bopfStore({ zbopf_prb1: FX_PRB1_ACTIVE_STRUCTURES });
    const generatedRoutes = [
      "/sap/bc/adt/ddic/structures/zbopf_s_root",
      "/sap/bc/adt/ddic/tabletypes/zbopf_t_root",
      "/sap/bc/adt/ddic/structures/zbopf_s_item",
      "/sap/bc/adt/ddic/tabletypes/zbopf_t_item",
      "/sap/bc/adt/oo/interfaces/zif_bopf_prb1_c",
    ];
    const { conn } = await wired({
      routes: [store.route, ...generatedRoutes.map((uri) => ddicProbeRoute({ uri, exists: true }))],
    });

    const result = await conn.withStatefulSession(async (session) => {
      const { authorized, gate } = mintDelete("ZBOPF_PRB1");
      return deleteBusinessObject(conn, session, "ZBOPF_PRB1", authorized, gate, { cascadeDdic: true });
    });

    expect(result.ddic).toHaveLength(5);
    expect(result.ddic.every((d) => d.deleted)).toBe(true);
  });
});

// ===========================================================================
// Tool-level harness for the dry-run preview text, which is only reachable
// through `abap_bopf_delete` (`buildDryRunDeleteResponse` in
// `src/tools/bopf.ts` is not exported). Same idiom as `test/bopf-tools.test.ts`.

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

const fakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({ kind: "transport", required: true, mustSupplyCorrNr: true, serverWouldFabricate: false, ...overrides }) as unknown as TrRequirement;

const localTransport = (): SessionTransport =>
  new SessionTransport({ allowTransports: ["auto"], cts: { trRequirement: vi.fn(async () => fakeReq({ kind: "local" })) } });

function depsFor(conn: AbapConnection): BopfToolDeps {
  return {
    pool: fakePool(conn),
    safety: openGate(),
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: 30_000 },
    transport: localTransport(),
    registerWrite: true,
  };
}

async function registeredTools(
  conn: AbapConnection,
): Promise<{ tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }> }> {
  const { mcp, tools } = fakeMcp();
  registerBopfTools(mcp, depsFor(conn));
  return { tools };
}

// ===========================================================================

describe("abap_bopf_delete dry_run preview: referenced DDIC is disclosed as spared, not offered as a candidate", () => {
  it("cascade_ddic dry run lists only generated refs under DDIC CANDIDATES and lists /BOBF/S_DEMO_SALES_ORDER_HDR, ZBOPF_D_ROOT etc. under DDIC SPARED instead", async () => {
    const store = bopfStore({ zbopf_prb1: FX_PRB1_ACTIVE_STRUCTURES });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", { bo: "ZBOPF_PRB1", cascade_ddic: true });
    const text = okText(result);

    const candidatesSection = text.split("DDIC CANDIDATES")[1]?.split("DDIC SPARED")[0] ?? "";
    const sparedSection = text.split("DDIC SPARED")[1] ?? "";

    // Generated (combinedStructureRef/combinedTableRef/constantsInterfaceRef)
    // — still offered as deletion candidates.
    expect(candidatesSection).toContain("ZBOPF_S_ROOT");
    expect(candidatesSection).toContain("ZBOPF_T_ROOT");
    expect(candidatesSection).toContain("ZIF_BOPF_PRB1_C");

    // Referenced (persistentStructureRef/persistentTableRef) — no longer
    // offered as candidates...
    expect(candidatesSection).not.toContain("/BOBF/S_DEMO_SALES_ORDER_HDR");
    expect(candidatesSection).not.toContain("ZBOPF_D_ROOT");
    expect(candidatesSection).not.toContain("ZBOPF_D_ITEM");

    // ...disclosed separately as spared, with a reason naming the ref site.
    expect(sparedSection).toContain("/BOBF/S_DEMO_SALES_ORDER_HDR");
    expect(sparedSection).toContain("ZBOPF_D_ROOT");
    expect(sparedSection).toContain("persistentStructureRef");
    expect(sparedSection).toContain("persistentTableRef");

    expect(text).toMatch(/ddicCandidateCount: 5/);
    expect(text).toMatch(/ddicSparedCount: 4/);

    // Still a dry run: no DDIC probe of any kind.
    expect(store.has("zbopf_prb1")).toBe(true);
  });
});
