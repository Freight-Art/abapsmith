/**
 * `ddicEnumerated` on `DeleteBusinessObjectResult`.
 *
 * Before this field existed, `deleteBusinessObject` returned `ddic: []` and
 * `ddicSpared: []` both when a caller never asked for `cascade_ddic` (the
 * model was never even read) and when a cascade genuinely ran and found
 * nothing to sweep — two opposite situations with byte-identical output.
 * A live-captured test run hit exactly this: a delete with `opts: {}` came back
 * looking clean while an orphaned constants interface sat on the server
 * unmentioned, and the only reason it was caught was a caller independently
 * re-deriving BOPF's naming convention and checking by hand.
 *
 * `ddicEnumerated` is `true` only when the model walk in
 * `deleteBusinessObject` (`src/adt/bopf.ts`) actually happened AND produced
 * a `BoModel` — never merely from `opts.cascadeDdic` being set, since the
 * walk can still fail (`readModel` throwing) after the flag was on.
 *
 * Same harness idiom as `test/bopf-cascade-provenance.test.ts` /
 * `test/bopf-client.test.ts`: real `bopf.ts` functions against a
 * `FakeAdtServer`, only the HTTP socket is fake.
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
  bopfStore,
  ddicProbeRoute,
  defaultBopfCreateBody,
  fakeResponse,
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
import { bopfUri, deleteBusinessObject } from "../src/adt/bopf.js";
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
// Same idiom as test/bopf-delete-reporting.test.ts: real registerBopfTools/runBopfDelete
// against a fake pool that just runs the given connection inline.

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

/**
 * A {@link FakeRoute} for the BOPF model URI that answers the FIRST
 * `GET` (v4 Accept) with `xml`, and every subsequent one with a `500`
 * `exc:exception` — reproducing "the model read that seeds `currentModelRead`
 * (used for the safety gate / journal before-image) succeeds, but
 * `deleteBusinessObject`'s OWN internal re-read for DDIC enumeration
 * (`src/adt/bopf.ts`'s `readModel` inside its `try`/bare `catch`) fails".
 * Same "count the Nth call and flip" idiom as
 * `flakyReadBackRoute` in `test/bopf-delete-reporting.test.ts`, applied to
 * the BO model URI instead of a DDIC candidate URI. Deliberately silent
 * (`undefined`) for non-GET methods so `bopfStore`'s own route — placed
 * after this one — still handles LOCK/PUT/DELETE on the same path.
 */
function flakyModelReadRoute(uri: string, xml: string): FakeRoute {
  let getCount = 0;
  return (r) => {
    if (r.path !== uri || r.method !== "GET") return undefined;
    const accept = String(r.headers["accept"] ?? "");
    if (!accept.includes("bopf.businessobjects.v4")) return undefined;
    getCount += 1;
    if (getCount === 1) {
      return fakeResponse(200, xml, { "content-type": "application/vnd.sap.ap.adt.bopf.businessobjects.v4+xml; charset=utf-8" });
    }
    return fakeResponse(500, `<exc:exception><type id="ExceptionSystemError"/></exc:exception>`, { "content-type": "application/xml" });
  };
}

// ===========================================================================

describe("ddicEnumerated: false whenever the model walk never happened", () => {
  it("no cascade_ddic: ddicEnumerated is false, ddic/ddicSpared are empty, and no model-read GET is issued at all", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn, server } = await wired({ routes: [store.route] });

    const result = await conn.withStatefulSession(async (session) => {
      const { authorized, gate } = mintDelete("ZBOPF_PRB1");
      return deleteBusinessObject(conn, session, "ZBOPF_PRB1", authorized, gate);
    });

    expect(result.boDeleted).toBe(true);
    expect(result.ddic).toEqual([]);
    expect(result.ddicSpared).toEqual([]);
    expect(result.ddicEnumerated).toBe(false);

    // The property ddicEnumerated relies on: a non-cascading delete spends no GET on
    // the BO's model at all — the model URI only sees LOCK/DELETE traffic.
    const modelGets = server.callsFor((r) => r.method === "GET" && r.path === bopfUri("ZBOPF_PRB1"));
    expect(modelGets).toEqual([]);
  });

  it("cascade_ddic:true but readModel throws (BO not present to read): ddicEnumerated is still false, not derived from opts.cascadeDdic alone", async () => {
    // Empty store: the BO exists for LOCK/DELETE purposes (bopfStore's
    // DELETE handler is a no-op delete-if-present, not a 404), but its GET
    // 404s, so readModel throws and the cascade degrades — the same catch
    // block deleteBusinessObject already has for "can't enumerate what
    // can't be read". A naive fix sets ddicEnumerated from opts.cascadeDdic
    // alone and gets this case wrong.
    const store = bopfStore();
    const { conn, server } = await wired({ routes: [store.route] });

    const result = await conn.withStatefulSession(async (session) => {
      const { authorized, gate } = mintDelete("ZBOPF_PRB1");
      return deleteBusinessObject(conn, session, "ZBOPF_PRB1", authorized, gate, { cascadeDdic: true });
    });

    expect(result.boDeleted).toBe(true);
    expect(result.ddic).toEqual([]);
    expect(result.ddicSpared).toEqual([]);
    expect(result.ddicEnumerated).toBe(false);

    const modelGets = server.callsFor((r) => r.method === "GET" && r.path === bopfUri("ZBOPF_PRB1"));
    expect(modelGets).toHaveLength(1);
  });
});

// ===========================================================================

describe("ddicEnumerated: true whenever the model walk actually ran, whatever it found", () => {
  it("cascade_ddic:true on a BO with companions: ddicEnumerated is true alongside a non-empty ddicSpared", async () => {
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

    expect(result.boDeleted).toBe(true);
    expect(result.ddicEnumerated).toBe(true);
    expect(result.ddicSpared.length).toBeGreaterThan(0);
    expect(result.ddicSpared.some((d) => d.name === "ZBOPF_D_ROOT")).toBe(true);
  });
});

// ===========================================================================
// Tool-layer: `abap_bopf_delete`'s rendered response text must surface
// `ddicEnumerated`. `buildDeleteResultResponse` in
// `src/tools/bopf.ts` used to read only the caller's `cascadeDdic` INPUT
// flag, never `result.ddicEnumerated` — so a cascade that was requested but
// whose internal `readModel` threw rendered byte-identically to a cascade
// that genuinely ran and found nothing: `ddicCount: 0` etc. with no other
// signal, exactly the same complaint as above, displaced from the flag-off
// path (fixed above) to the read-failure path.

describe("abap_bopf_delete surfaces ddicEnumerated in the rendered response", () => {
  it("cascade_ddic: true, model read succeeds, nothing found: response states ddicEnumerated: true and shows the zero counts", async () => {
    const store = bopfStore({ zbopf_prb1: defaultBopfCreateBody("ZBOPF_PRB1") });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", {
      bo: "ZBOPF_PRB1",
      dry_run: false,
      confirm: "ZBOPF_PRB1",
      cascade_ddic: true,
      confirm_cascade: "ZBOPF_PRB1",
    });
    const text = okText(result);

    expect(store.has("zbopf_prb1")).toBe(false);
    expect(text).toMatch(/boDeleted: true/);
    expect(text).toMatch(/cascadeDdic: true/);
    expect(text).toMatch(/ddicEnumerated: true/);
    expect(text).toMatch(/ddicCount: 0/);
    expect(text).toMatch(/ddicDeletedCount: 0/);
    expect(text).toMatch(/ddicUnverifiedCount: 0/);
    expect(text).toMatch(/ddicSparedCount: 0/);
    // A genuine empty cascade carries no "never enumerated" note.
    expect(text.toLowerCase()).not.toMatch(/never happened|could not be re-read|not evidence of a clean sweep/);
  });

  it("cascade_ddic: true, deleteBusinessObject's own readModel throws: response states ddicEnumerated: false, drops the four zero counts, and carries a note", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({
      routes: [flakyModelReadRoute(bopfUri("ZBOPF_PRB1"), FX_JUST_CREATED), store.route],
    });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", {
      bo: "ZBOPF_PRB1",
      dry_run: false,
      confirm: "ZBOPF_PRB1",
      cascade_ddic: true,
      confirm_cascade: "ZBOPF_PRB1",
    });
    const text = okText(result);

    // The BO delete itself still succeeded — only the DDIC enumeration failed.
    expect(store.has("zbopf_prb1")).toBe(false);
    expect(text).toMatch(/boDeleted: true/);
    expect(text).toMatch(/cascadeDdic: true/);
    expect(text).toMatch(/ddicEnumerated: false/);

    // The old bug: these four would print as misleading zeros. Now dropped
    // entirely — same "no count for a measurement that never happened"
    // idiom already used for the no-cascade path below.
    expect(text).not.toContain("ddicCount");
    expect(text).not.toContain("ddicDeletedCount");
    expect(text).not.toContain("ddicUnverifiedCount");
    expect(text).not.toContain("ddicSparedCount");

    expect(text).toContain("NOTE:");
    expect(text.toLowerCase()).toMatch(/not evidence of a clean sweep/);
  });

  it("cascade_ddic: false: unchanged behaviour — ddicEnumerated is not rendered at all, DDIC LEFT BEHIND rendering intact", async () => {
    const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn } = await wired({ routes: [store.route] });
    const { tools } = await registeredTools(conn);

    const result = await invoke(tools, "abap_bopf_delete", { bo: "ZBOPF_PRB1", dry_run: false, confirm: "ZBOPF_PRB1" });
    const text = okText(result);

    expect(text).toMatch(/cascadeDdic: false/);
    expect(text).not.toContain("ddicEnumerated");
    expect(text).toContain("DDIC LEFT BEHIND");
    expect(text).toContain("ZIF_BOPF_PRB1_C");
    expect(text).toMatch(/ddicLeftBehindCount: [1-9]\d*/);
  });
});

// ===========================================================================

describe("a failed enumeration cannot be read as a clean sweep", () => {
  it("the 'never enumerated' response text differs from — and is not confusable with — the genuine empty-cascade response text", async () => {
    // A: cascade genuinely ran, found nothing.
    const storeA = bopfStore({ zbopf_prb1: defaultBopfCreateBody("ZBOPF_PRB1") });
    const { conn: connA } = await wired({ routes: [storeA.route] });
    const { tools: toolsA } = await registeredTools(connA);
    const textA = okText(
      await invoke(toolsA, "abap_bopf_delete", {
        bo: "ZBOPF_PRB1",
        dry_run: false,
        confirm: "ZBOPF_PRB1",
        cascade_ddic: true,
        confirm_cascade: "ZBOPF_PRB1",
      }),
    );

    // B: cascade never ran — deleteBusinessObject's own readModel threw
    // AFTER runBopfDelete's separate currentModelRead already succeeded
    // (the gate/journal read), so the BO delete still lands.
    const storeB = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
    const { conn: connB } = await wired({
      routes: [flakyModelReadRoute(bopfUri("ZBOPF_PRB1"), FX_JUST_CREATED), storeB.route],
    });
    const { tools: toolsB } = await registeredTools(connB);
    const textB = okText(
      await invoke(toolsB, "abap_bopf_delete", {
        bo: "ZBOPF_PRB1",
        dry_run: false,
        confirm: "ZBOPF_PRB1",
        cascade_ddic: true,
        confirm_cascade: "ZBOPF_PRB1",
      }),
    );

    // The core requirement: the two are not the same text, and B in
    // particular cannot be mistaken for "cascade ran, found nothing" — it
    // must positively assert that the enumeration did not happen, not merely
    // omit evidence that it did.
    expect(textA).not.toBe(textB);
    expect(textA).toMatch(/ddicEnumerated: true/);
    expect(textA).toMatch(/ddicCount: 0/);
    expect(textB).toMatch(/ddicEnumerated: false/);
    expect(textB).not.toMatch(/ddicCount: 0/);
    expect(textB).not.toContain("ddicCount");
    expect(textB).toContain("NOTE:");
    expect(textB.toLowerCase()).toMatch(/not evidence of a clean sweep/);
  });
});
