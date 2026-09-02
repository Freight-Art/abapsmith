/**
 * `abap_bopf_delete` reporting honesty.
 *
 * Two separate defects motivated this file, both about a delete tool
 * asserting cleanliness it did not actually achieve:
 *
 *  (a) `ddicCount: 0` in the delete-result response used to look IDENTICAL
 *      whether `cascade_ddic` was never requested (no cascade ran at all —
 *      generated DDIC objects like the auto-generated constants interface
 *      are still sitting on the server) or a requested cascade genuinely
 *      found nothing to sweep. A live delete of a throwaway `$TMP` BO
 *      reported `boDeleted: true, ddicCount: 0` while leaving the generated
 *      constants interface (e.g. `ZIF_W3B_BOPF_011_C`) behind — a cleanup
 *      tool asserting cleanliness it did not achieve.
 *
 *  (b) `deleted: true` on a DDIC cascade candidate used to be asserted
 *      purely from the DELETE HTTP call resolving, never verified via a
 *      read-back — unlike `deleteObject` in `src/adt/write.ts`, which
 *      already uses the tri-state `deleted: boolean | "unverified"`
 *      pattern this file's fix adopts for `src/adt/bopf.ts` too.
 *
 * Same harness idiom as `test/bopf-cascade-provenance.test.ts` /
 * `test/bopf-client.test.ts`: real `bopf.ts`/`tools/bopf.ts` functions
 * against a `FakeAdtServer`, only the HTTP socket is fake.
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
  ddicProbeRoute,
  EMPTY_200,
  missingLockHandle400,
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
import { deleteBusinessObject } from "../src/adt/bopf.js";
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

/** ZBOPF_PRB1, root-only, just after create — real captured shape. Only generated DDIC candidate: ZIF_BOPF_PRB1_C. */
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

// ------------------------------------------------------------- tool-level harness ---

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

// --------------------------------------------------------- custom read-back routes ---

/**
 * A DDIC probe route that behaves exactly like `ddicProbeRoute` for the
 * FIRST GET (existence, before the delete) but — unlike the shared helper —
 * NEVER flips to absent after a successful DELETE: the read-back GET that
 * `deleteDdicCandidate` issues right after the DELETE keeps answering `200`,
 * reproducing "DELETE returned success but the object still reads back"
 * without weakening `ddicProbeRoute`'s own state discipline.
 */
function staleReadBackRoute(uri: string): FakeRoute {
  return (r) => {
    if (r.path !== uri) return undefined;
    const accept = String(r.headers["accept"] ?? "");
    if (accept !== "*/*") return undefined;
    if (r.method === "GET") {
      return fakeResponse(200, `<tabl:table xmlns:tabl="http://www.sap.com/wbobj/tables"/>`, { "content-type": "application/xml" });
    }
    if (r.method === "DELETE") {
      const handle = r.qs["lockHandle"];
      if (typeof handle !== "string" || handle === "") return missingLockHandle400();
      return EMPTY_200();
    }
    return undefined;
  };
}

/**
 * A DDIC probe route whose first GET (existence probe) succeeds, whose
 * DELETE succeeds, but whose SECOND GET (the post-delete read-back) fails
 * with a non-404 error — reproducing "the read-back itself failed for a
 * reason that says nothing about whether the delete worked".
 */
function flakyReadBackRoute(uri: string): FakeRoute {
  let getCount = 0;
  return (r) => {
    if (r.path !== uri) return undefined;
    const accept = String(r.headers["accept"] ?? "");
    if (accept !== "*/*") return undefined;
    if (r.method === "GET") {
      getCount += 1;
      if (getCount === 1) {
        return fakeResponse(200, `<tabl:table xmlns:tabl="http://www.sap.com/wbobj/tables"/>`, { "content-type": "application/xml" });
      }
      return fakeResponse(500, `<exc:exception><type id="ExceptionSystemError"/></exc:exception>`, { "content-type": "application/xml" });
    }
    if (r.method === "DELETE") {
      const handle = r.qs["lockHandle"];
      if (typeof handle !== "string" || handle === "") return missingLockHandle400();
      return EMPTY_200();
    }
    return undefined;
  };
}

// ===========================================================================

describe("armed delete with no cascade_ddic names what it leaves behind, instead of a bare ddicCount: 0", () => {
  it("deletes the BO, but names ZIF_BOPF_PRB1_C as left behind and states cascadeDdic: false plainly", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", { bo: "ZBOPF_PRB1", dry_run: false, confirm: "ZBOPF_PRB1" });
    const text = okText(result);

    expect(store.has("zbopf_prb1")).toBe(false);
    expect(text).toMatch(/boDeleted: true/);
    expect(text).toMatch(/cascadeDdic: false/);
    expect(text).toContain("ZIF_BOPF_PRB1_C");
    expect(text).toContain("DDIC LEFT BEHIND");

    // The old bug: ddicCount: 0 with nothing else DDIC-related printed reads
    // as "cascade ran, found nothing". Now that's fixed two ways: ddicCount
    // (and the other cascade-result counts, always trivially 0 here since no
    // cascade ran) are dropped from the header entirely rather than printed
    // as a misleading 0, and the one count that means something in this mode
    // — ddicLeftBehindCount — is printed with its real, nonzero value.
    expect(text).not.toContain("ddicCount");
    expect(text).not.toContain("ddicDeletedCount");
    expect(text).not.toContain("ddicUnverifiedCount");
    expect(text).not.toContain("ddicSparedCount");
    expect(text).toMatch(/ddicLeftBehindCount: [1-9]\d*/);
    const linesAroundDdicCount = text.split("\n").filter((l) => l.includes("ddic") || l.toLowerCase().includes("left behind"));
    expect(linesAroundDdicCount.length).toBeGreaterThan(1);

    // No DDIC HTTP call of any kind — nothing was actually swept, matching
    // the plain "cascadeDdic: false" the header now states.
    // (No DDIC route was even wired, so an accidental probe would have
    // thrown "Unrouted request" and failed this test outright.)
  });
});

// ===========================================================================

describe("dry run with no cascade_ddic names the generated objects that would remain", () => {
  it("lists ZIF_BOPF_PRB1_C under DDIC NOT SWEPT even though cascade_ddic was never requested", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", { bo: "ZBOPF_PRB1" });
    const text = okText(result);

    expect(text).toMatch(/dryRun: true/);
    expect(text).toMatch(/cascadeDdic: false/);
    expect(text).toContain("DDIC NOT SWEPT");
    expect(text).toContain("ZIF_BOPF_PRB1_C");
    expect(store.has("zbopf_prb1")).toBe(true);

    // Follow-up: with cascadeDdic false, ddicCandidateCount/ddicSparedCount
    // would misleadingly imply "these would be deleted" — the header should carry
    // only the one count that means something in this mode.
    expect(text).not.toContain("ddicCandidateCount");
    expect(text).not.toContain("ddicSparedCount");
    expect(text).toMatch(/ddicWouldRemainCount: \d+/);
  });
});

// ===========================================================================

describe("deleteDdicCandidate read-back verification", () => {
  it("DELETE succeeds and the read-back 404s: deleted: true", async () => {
    const uri = "/sap/bc/adt/oo/interfaces/zif_bopf_prb1_c";
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route, ddicProbeRoute({ uri, exists: true })] });

    const result = await conn.withStatefulSession(async (session) => {
      const { authorized, gate } = mintDelete("ZBOPF_PRB1");
      return deleteBusinessObject(conn, session, "ZBOPF_PRB1", authorized, gate, { cascadeDdic: true });
    });

    const constants = result.ddic.find((d) => d.name === "ZIF_BOPF_PRB1_C");
    expect(constants?.existed).toBe(true);
    expect(constants?.deleted).toBe(true);
    expect(constants?.reason).toBeUndefined();
  });

  it("DELETE succeeds but a read-back of the same URI still finds the object: deleted: \"unverified\", with a reason (custom route, not a weakened ddicProbeRoute)", async () => {
    const uri = "/sap/bc/adt/oo/interfaces/zif_bopf_prb1_c";
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route, staleReadBackRoute(uri)] });

    const result = await conn.withStatefulSession(async (session) => {
      const { authorized, gate } = mintDelete("ZBOPF_PRB1");
      return deleteBusinessObject(conn, session, "ZBOPF_PRB1", authorized, gate, { cascadeDdic: true });
    });

    const constants = result.ddic.find((d) => d.name === "ZIF_BOPF_PRB1_C");
    expect(constants?.existed).toBe(true);
    expect(constants?.deleted).toBe("unverified");
    expect(constants?.reason).toBeDefined();
    expect(constants?.reason).toMatch(/read-back|205|stale/i);

    // The DELETE itself really did land — this is not the "delete failed"
    // path (that reports deleted: false with a "delete failed:" reason).
    const deletes = server.callsFor((r) => r.method === "DELETE" && r.path === uri);
    expect(deletes).toHaveLength(1);
    // At least two GETs against this URI: the existence probe, plus the
    // post-delete read-back.
    const gets = server.callsFor((r) => r.method === "GET" && r.path === uri);
    expect(gets.length).toBeGreaterThanOrEqual(2);
  });

  it("DELETE succeeds but the read-back itself fails with something other than 404: deleted: \"unverified\", not true", async () => {
    const uri = "/sap/bc/adt/oo/interfaces/zif_bopf_prb1_c";
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route, flakyReadBackRoute(uri)] });

    const result = await conn.withStatefulSession(async (session) => {
      const { authorized, gate } = mintDelete("ZBOPF_PRB1");
      return deleteBusinessObject(conn, session, "ZBOPF_PRB1", authorized, gate, { cascadeDdic: true });
    });

    const constants = result.ddic.find((d) => d.name === "ZIF_BOPF_PRB1_C");
    expect(constants?.existed).toBe(true);
    expect(constants?.deleted).toBe("unverified");
    expect(constants?.deleted).not.toBe(true);
    expect(constants?.reason).toBeDefined();
  });
});

// ===========================================================================

describe("no-cascade reporting does not assert existence it never probed", () => {
  it("armed delete without cascade_ddic: does not claim the left-behind objects still exist, states existence was not probed", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", { bo: "ZBOPF_PRB1", dry_run: false, confirm: "ZBOPF_PRB1" });
    const text = okText(result);

    // Live evidence (follow-up): on an unactivated BO, BOPF
    // reserves combinedTableRef/combinedStructureRef names at create time
    // but only materializes those DDIC objects on activation. A no-cascade
    // delete never probes, so it must not claim these names still exist —
    // two of the three named here (ZTMD_T_ROOT2, ZTMD_S_ROOT2 in the live
    // case; ZBOPF_T_ROOT, ZBOPF_S_ROOT here) genuinely did not.
    expect(text).not.toContain("still exist");
    expect(text.toLowerCase()).toMatch(/not probed|not checked|read from the (bo's )?model/);
    expect(text).toContain("ZIF_BOPF_PRB1_C");
    expect(text).toMatch(/ddicLeftBehindCount: [1-9]\d*/);
    expect(text).not.toContain("ddicCount: 0");
  });
});

describe("dry-run reporting does not assert existence it never probed", () => {
  it("dry run without cascade_ddic: does not claim the DDIC NOT SWEPT objects would remain, states existence was not probed", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", { bo: "ZBOPF_PRB1" });
    const text = okText(result);

    expect(text).not.toContain("would remain");
    expect(text.toLowerCase()).toMatch(/not probed|not checked|read from the (bo's )?model/);
    expect(text).toContain("ZIF_BOPF_PRB1_C");
    expect(text).toMatch(/ddicWouldRemainCount: \d+/);
  });
});

describe("armed abap_bopf_delete tool response surfaces the unverified count", () => {
  it("cascade_ddic delete where the constants interface read-back is stale reports ddicUnverifiedCount: 1 and a NOTE", async () => {
    const uri = "/sap/bc/adt/oo/interfaces/zif_bopf_prb1_c";
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route, staleReadBackRoute(uri)] });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", {
      bo: "ZBOPF_PRB1",
      dry_run: false,
      confirm: "ZBOPF_PRB1",
      cascade_ddic: true,
      confirm_cascade: "ZBOPF_PRB1",
    });
    const text = okText(result);

    expect(text).toMatch(/cascadeDdic: true/);
    expect(text).toMatch(/ddicUnverifiedCount: 1/);
    expect(text).toMatch(/deleted=unverified/);
    expect(text).toContain("NOTE:");
  });
});
