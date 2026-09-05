/**
 * `abap_bopf_edit operation:"create_bo"` reported `SESSION_DEAD`
 * for business objects it had already created server-side — the inverse of
 * the sibling defect where a success was reported as a failure.
 *
 * Root cause: `createBusinessObject`'s own non-atomic-create recovery
 * (`src/adt/bopf.ts`) re-GETs on the SAME connection that just failed. When
 * the failure IS `SESSION_DEAD`, that re-GET dies too, is swallowed, and the
 * original `SESSION_DEAD` surfaces with no `recovered: true` — recovery is
 * structurally unable to fire for the one error class that most needs it.
 * `runBopfEdit`'s `create_bo` branch now catches a `SESSION_DEAD` from
 * `pool.withWrite` and re-reads on `pool.withRead` — a DIFFERENT pool slot,
 * since the one that died is retired.
 *
 * Harness: unlike every other `bopf-*.test.ts` file, this one drives a REAL
 * `AdtSessionPool` (not the single-shared-connection `fakePool()` passthrough
 * those files use) against a real `FakeAdtServer`, so that a `SESSION_DEAD`
 * genuinely retires one slot and the recovery read genuinely lands on a
 * second, independently-minted session (`FakeAdtServer.client()` mints a
 * fresh `contextId`/`csrfToken` pair per call). `bopfStore()`'s backing map
 * is shared across every session built against the same server instance, so
 * a fresh session's GET can see what an earlier, now-dead session's POST
 * wrote — the same real-world shape as "the create landed, the response
 * didn't". Proven directly in the tests below via `FakeRequest.sessionId`,
 * not just inferred from a passing assertion.
 *
 * The `SESSION_DEAD` simulated here is `session.ts`'s `sessionDeadError`
 * variant (a genuine per-request classification from a short-dump-shaped
 * response), not `connection.ts`'s `condemned` `connectionDeadError`.
 * That matters for `eligibleForDeadSlotReplay`
 * (`src/adt/pool.ts`): a write's own automatic replay is gated on
 * `elapsedMs <= DEAD_ON_ARRIVAL_MS` (500ms) unless the error is condemned.
 * A fake HTTP round trip is normally sub-millisecond, which would make the
 * pool itself silently retry the whole `withWrite` callback before this
 * file's new recovery code ever ran, confounding every assertion below. The
 * dying-create route therefore adds a real ~600ms delay before answering —
 * genuine wall-clock time against the pool's own default `Date.now()` clock,
 * not a stubbed one — so the write is provably ineligible for the pool's own
 * replay and the ONLY thing that can turn the scenario into a success is
 * `runBopfEdit`'s own recovery path.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  FakeAdtServer,
  __resetFakeAdtCounters,
  bopfStore,
  defaultBopfCreateBody,
  fakeResponse,
  activationRoute,
  BOPF_COLLECTION_PATH,
  type BopfStore,
  type FakeRoute,
} from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { AdtSessionPool } from "../src/adt/pool.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import { errorResult } from "../src/server.js";
import { Journal, type JournalConfig } from "../src/journal.js";
import { bopfUri } from "../src/adt/bopf.js";
import { registerBopfTools, type BopfToolDeps } from "../src/tools/bopf.js";

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
    // Keeps the pool's write-gate a no-op in this offline suite instead of
    // touching the real filesystem's cross-process lock directory.
    serialiseSameObjectWrites: false,
  });

const openPools: AdtSessionPool[] = [];

beforeEach(() => {
  __resetFakeAdtCounters();
});

afterEach(async () => {
  for (const p of openPools.splice(0)) await p.shutdown("test cleanup").catch(() => undefined);
});

interface PoolHarness {
  readonly pool: AdtSessionPool;
  readonly server: FakeAdtServer;
}

/**
 * A real `AdtSessionPool` over a real `FakeAdtServer`: each slot the pool
 * mints gets its OWN `server.client()` session (own contextId/csrfToken), so
 * a dead-slot-retire-and-reacquire is the genuine thing, not a fake standing
 * in for it.
 */
function poolHarness(routes: readonly FakeRoute[] = []): PoolHarness {
  const server = new FakeAdtServer({
    transportErrors: "throw",
    routes: [systemRoleRoute, ...routes],
  });
  const pool = new AdtSessionPool({
    cfg: cfg(),
    breaker: new AuthCircuitBreaker(),
    log: () => {},
    createConnection: (c, o) => new AbapConnection(c, { ...o, httpClient: server.client() }),
    prepareConnection: async (c) => {
      await c.connect();
    },
  });
  openPools.push(pool);
  return { pool, server };
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

const openGate = (): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransportRelease: true, allowCascadeDelete: true });

const fakeReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({ kind: "local", required: false, mustSupplyCorrNr: false, serverWouldFabricate: false, ...overrides }) as unknown as TrRequirement;

const localTransport = (): SessionTransport =>
  new SessionTransport({ allowTransports: ["auto"], cts: { trRequirement: async () => fakeReq() } });

function depsFor(pool: AdtSessionPool, opts: { journal?: Journal } = {}): BopfToolDeps {
  return {
    pool,
    safety: openGate(),
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: 30_000 },
    transport: localTransport(),
    registerWrite: true,
    ...(opts.journal ? { journal: opts.journal } : {}),
  };
}

async function registered(
  pool: AdtSessionPool,
  opts: { journal?: Journal } = {},
): Promise<{ tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }> }> {
  const { mcp, tools } = fakeMcp();
  registerBopfTools(mcp, depsFor(pool, opts));
  return { tools };
}

let dir: string;
const jcfg = (): JournalConfig => ({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 });

const withJournal = async (fn: (j: Journal) => Promise<void>): Promise<void> => {
  dir = await mkdtemp(join(tmpdir(), "abapsmith-bopf-create-recovery-"));
  try {
    await fn(new Journal(jcfg(), "A4H"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Structural short-dump markers `classifySessionFailure` (src/adt/session.ts) checks first. */
const DUMP_BODY =
  `<html><body><div class="errorTextHeader">Short dump</div>` +
  `<div id="msgText">The current ABAP program had to be terminated.</div></body></html>`;

/**
 * Intercepts the create POST and answers a genuine `SESSION_DEAD` after a
 * real ~600ms delay (see module header). `landed: true` writes the object
 * into `store` first, modelling "the create actually took, only the
 * response was lost"; `landed: false` leaves it absent.
 */
function dyingCreateRoute(store: BopfStore, opts: { landed: boolean }): FakeRoute {
  return async (r) => {
    if (r.method !== "POST" || r.path !== BOPF_COLLECTION_PATH) return undefined;
    const name = /adtcore:name="([^"]+)"/.exec(r.body ?? "")?.[1];
    if (opts.landed && name) store.set(name, defaultBopfCreateBody(name));
    await new Promise((resolve) => setTimeout(resolve, 600));
    return fakeResponse(500, DUMP_BODY, { "content-type": "text/html" });
  };
}

/**
 * Intercepts the create POST and answers a plain (non-dump, non-SESSION_DEAD)
 * server error, instantly — models an ordinary failed create unrelated to
 * session death.
 */
function genericFailingCreateRoute(store: BopfStore, opts: { landed: boolean }): FakeRoute {
  return (r) => {
    if (r.method !== "POST" || r.path !== BOPF_COLLECTION_PATH) return undefined;
    const name = /adtcore:name="([^"]+)"/.exec(r.body ?? "")?.[1];
    if (opts.landed && name) store.set(name, defaultBopfCreateBody(name));
    return fakeResponse(500, `<exc:exception><type id="ExceptionSystemError"/></exc:exception>`, {
      "content-type": "application/xml",
    });
  };
}

/**
 * A `bo:businessObject` body with ONE explicit root `bo:nodes` element,
 * `rootName` substituted verbatim into `bo:name` (an empty string produces
 * exactly the `bo:name=""` shape the root-node-verification defect below is about). Unlike
 * `defaultBopfCreateBody` (no `bo:nodes` at all), this is what's needed to
 * exercise `createBoRootNodeNotes` (`src/tools/bopf.ts`), which reads
 * `model.nodes.find((n) => n.rootNode)`.
 */
function bodyWithRootNode(name: string, rootName: string): string {
  const upper = name.toUpperCase();
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<bo:businessObject xmlns:bo="http://www.sap.com/wbobj/bopf/business_object" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${upper}" adtcore:type="BOBF" ` +
    `adtcore:version="inactive" adtcore:description="created by bopfStore">` +
    `<adtcore:packageRef adtcore:name="$TMP"/>` +
    `<bo:nodes bo:name="${rootName}" bo:nodeID="Um9vdA==" bo:xmlName="${rootName || "Root"}" ` +
    `bo:objectModelGenerated="false" bo:authorizationCheck="false" bo:isExtensible="false" ` +
    `bo:isDependentObjectNode="false" bo:textNode="false" bo:createEnabled="true" ` +
    `bo:updateEnabled="true" bo:deleteEnabled="true" bo:rootNode="true" bo:objectModelObsolete="false"/>` +
    `</bo:businessObject>`
  );
}

/**
 * Same shape as `dyingCreateRoute` above, but seeds the store with a
 * caller-supplied body instead of always `defaultBopfCreateBody` — needed
 * to model the root-node-verification scenario, where what "landed" server-side has a
 * root node BOPF itself named (or failed to name), not the generic
 * no-nodes-at-all default.
 */
function dyingCreateRouteWithBody(store: BopfStore, bodyFor: (name: string) => string): FakeRoute {
  return async (r) => {
    if (r.method !== "POST" || r.path !== BOPF_COLLECTION_PATH) return undefined;
    const name = /adtcore:name="([^"]+)"/.exec(r.body ?? "")?.[1];
    if (name) store.set(name, bodyFor(name));
    await new Promise((resolve) => setTimeout(resolve, 600));
    return fakeResponse(500, DUMP_BODY, { "content-type": "text/html" });
  };
}

// ===========================================================================

describe("abap_bopf_edit create_bo — recovering from a SESSION_DEAD on the create POST", () => {
  it("the create landed server-side; a fresh pool slot confirms it — recovered: true, no activation sent, journal succeeded", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore();
      // A route for the activation POST is deliberately included here, even
      // though it must never be called: without it, a wrongful activation
      // attempt during recovery would hit "Unrouted request" and fail the
      // whole `invoke` call before the `activationCalls` assertion below
      // ever ran — masking the exact regression this test exists to catch.
      const { pool, server } = poolHarness([
        dyingCreateRoute(store, { landed: true }),
        store.route,
        activationRoute({ uri: bopfUri("ZQ364NEW") }),
      ]);
      const { tools } = await registered(pool, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZQ364NEW",
        operation: "create_bo",
        package: "$TMP",
        activate: true,
      });

      const text = okText(result);
      expect(text).toContain(
        "The write session died (SESSION_DEAD) after the create request was sent; a fresh session re-read " +
          "confirms the object exists and is usable. No activation was attempted on this call — the session " +
          "that died cannot be trusted to have sent one, even if activate was requested.",
      );
      expect(store.has("zq364new")).toBe(true);

      const activationCalls = server.calls.filter(
        (r) => r.method === "POST" && r.path.includes("/sap/bc/adt/activation"),
      );
      expect(activationCalls).toHaveLength(0);

      const postCall = server.calls.find((r) => r.method === "POST" && r.path === BOPF_COLLECTION_PATH);
      const getCall = server.calls.find(
        (r) => r.method === "GET" && r.path === `${BOPF_COLLECTION_PATH}/zq364new`,
      );
      expect(postCall).toBeDefined();
      expect(getCall).toBeDefined();
      // The discriminating proof: the recovery GET rode a DIFFERENT pool
      // slot (a different minted session) than the POST that died on.
      expect(getCall!.sessionId).not.toBe(postCall!.sessionId);

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.outcome).toBe("succeeded");
      expect(entries[0]!.object.name).toBe("ZQ364NEW");
      expect(entries[0]!.existedBefore).toBe(false);
      expect(entries[0]!.beforeCapture).toBe("confirmed-absent");
      expect(entries[0]!.irreversible).toBe(true);
    });
  }, 15_000);

  it("the create genuinely did not land; the ORIGINAL SESSION_DEAD is rethrown, not masked as NOT_FOUND, journal failed", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore();
      const { pool, server } = poolHarness([dyingCreateRoute(store, { landed: false }), store.route]);
      const { tools } = await registered(pool, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZQ364GONE",
        operation: "create_bo",
        package: "$TMP",
      });

      const payload = errorPayload(result);
      expect(payload.error).toBe("SESSION_DEAD");
      expect(store.has("zq364gone")).toBe(false);

      const getCall = server.calls.find(
        (r) => r.method === "GET" && r.path === `${BOPF_COLLECTION_PATH}/zq364gone`,
      );
      expect(getCall).toBeDefined(); // the recovery attempt genuinely happened...

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.outcome).toBe("failed"); // ...and still failed honestly.
    });
  }, 15_000);
});

describe("abap_bopf_edit create_bo — a non-SESSION_DEAD create failure is left to the existing same-connection recovery", () => {
  it("a generic create failure that never landed is not retried on a fresh pool slot", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore();
      const { pool, server } = poolHarness([genericFailingCreateRoute(store, { landed: false }), store.route]);
      const { tools } = await registered(pool, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZQ364BAD",
        operation: "create_bo",
        package: "$TMP",
      });

      const payload = errorPayload(result);
      expect(payload.error).not.toBe("SESSION_DEAD");

      // Exactly one GET: `createBusinessObject`'s own same-connection
      // non-atomic-create recovery. A pool-level recovery firing here too
      // (the "recover on any error" mutation) would show up as a second one.
      const getCalls = server.calls.filter(
        (r) => r.method === "GET" && r.path === `${BOPF_COLLECTION_PATH}/zq364bad`,
      );
      expect(getCalls).toHaveLength(1);

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.outcome).toBe("failed");
    });
  });
});

describe("abap_bopf_edit create_bo — ordinary happy path is unaffected by the restructure", () => {
  it("creates and sends activation normally; journal entry succeeded", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore();
      const { pool, server } = poolHarness([store.route, activationRoute({ uri: bopfUri("ZQ364OK") })]);
      const { tools } = await registered(pool, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZQ364OK",
        operation: "create_bo",
        package: "$TMP",
        activate: true,
      });

      const text = okText(result);
      expect(text).not.toMatch(/SESSION_DEAD/);
      expect(store.has("zq364ok")).toBe(true);

      const activationCalls = server.calls.filter(
        (r) => r.method === "POST" && r.path.includes("/sap/bc/adt/activation"),
      );
      expect(activationCalls.length).toBeGreaterThan(0);

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.outcome).toBe("succeeded");
      expect(entries[0]!.object.name).toBe("ZQ364OK");
    });
  });
});

/**
 * A `create_bo` SESSION_DEAD recovery (the suite above)
 * used to report `recovered: true` — a plain success — even when the object
 * that landed server-side has a root node BOPF itself auto-named `""`
 * instead of the caller's `rootNodeName`. That empty name is baked into the
 * generated `Z*_C` constants interface AT CREATE TIME and the interface is
 * never regenerated, so the BO can never activate — and renaming the root
 * node afterward does NOT repair it (live-observed, see
 * `doc/analysis/irreversible-operations.md`). `createBoRootNodeNotes`
 * (`src/tools/bopf.ts`) compares `effectiveRootNodeName(createRequest)`
 * against the actual root node on every create_bo return path — recovered
 * or not — and reports the mismatch instead of a bare success.
 */
describe("abap_bopf_edit create_bo — root node verification against what was actually requested", () => {
  it("an empty-named root surviving a SESSION_DEAD recovery is reported as unactivatable, with the delete-and-recreate remedy", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore();
      const { pool } = poolHarness([
        dyingCreateRouteWithBody(store, (name) => bodyWithRootNode(name, "")),
        store.route,
        activationRoute({ uri: bopfUri("ZQ424BAD") }),
      ]);
      const { tools } = await registered(pool, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZQ424BAD",
        operation: "create_bo",
        package: "$TMP",
        rootNodeName: "ITEM",
      });

      const text = okText(result);
      expect(text).toContain('requested root node "ITEM"');
      expect(text).toContain('bo:name=""');
      expect(text).toContain("UNNAMED");
      expect(text).toContain("can never be activated");
      expect(text).toContain('abap_bopf_delete "ZQ424BAD", then create it again');
      expect(text).toContain("residue that must be cleaned up");
      // Renaming is live-disproven as a repair (see doc/analysis/irreversible-operations.md)
      // — the note must say so explicitly, not merely omit a rename suggestion.
      expect(text).toContain("Renaming the root node afterward does NOT repair the interface");
    });
  }, 15_000);

  it("no false positive: a root node named exactly as requested produces no unactivatable/discrepancy warning", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zq424ok: bodyWithRootNode("ZQ424OK", "ROOT") });
      const { pool } = poolHarness([store.route, activationRoute({ uri: bopfUri("ZQ424OK") })]);
      const { tools } = await registered(pool, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZQ424OK",
        operation: "create_bo",
        package: "$TMP",
      });

      const text = okText(result);
      expect(text).not.toContain("UNNAMED");
      expect(text).not.toContain("could not be confirmed");
      expect(text).not.toContain("actually created is named");
    });
  });

  it("a root node present but named differently from what was requested is reported as a discrepancy, not a bare success", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zq424diff: bodyWithRootNode("ZQ424DIFF", "HEADER") });
      const { pool } = poolHarness([store.route]);
      const { tools } = await registered(pool, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZQ424DIFF",
        operation: "create_bo",
        package: "$TMP",
        rootNodeName: "ITEM",
      });

      const text = okText(result);
      expect(text).toContain('requested root node "ITEM"');
      expect(text).toContain('actually created is named "HEADER"');
      // Must not be confused with the empty-name/unactivatable case.
      expect(text).not.toContain("UNNAMED");
    });
  });

  it("SESSION_DEAD recovery, no false positive: the landed root node IS named as requested — still reads as a clean success", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore();
      const { pool } = poolHarness([
        dyingCreateRouteWithBody(store, (name) => bodyWithRootNode(name, "ROOT")),
        store.route,
      ]);
      const { tools } = await registered(pool, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZQ424REC",
        operation: "create_bo",
        package: "$TMP",
      });

      const text = okText(result);
      expect(text).toContain("Treated as a successful create.");
      expect(text).not.toContain("NOT a clean create");
      expect(text).not.toContain("UNNAMED");
      expect(text).not.toContain("actually created is named");
    });
  }, 15_000);

  it("SESSION_DEAD recovery, no silent success over a lost name: the landed root node came back unnamed", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore();
      const { pool } = poolHarness([
        dyingCreateRouteWithBody(store, (name) => bodyWithRootNode(name, "")),
        store.route,
      ]);
      const { tools } = await registered(pool, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZQ424LOST",
        operation: "create_bo",
        package: "$TMP",
      });

      const text = okText(result);
      expect(text).not.toContain("Treated as a successful create.");
      expect(text).toContain("NOT a clean create: the root node did not come back as requested");
    });
  }, 15_000);

  it("a clean live create's actual root node name is observable directly via the rootNode: header; the unnamed case renders rootNode: (unnamed)", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zq424hdr: bodyWithRootNode("ZQ424HDR", "HEADER") });
      const { pool } = poolHarness([store.route]);
      const { tools } = await registered(pool, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZQ424HDR",
        operation: "create_bo",
        package: "$TMP",
        rootNodeName: "ITEM",
      });

      const text = okText(result);
      expect(text).toContain("rootNode: HEADER");
      expect(text).toContain('actually created is named "HEADER"');

      const unnamedStore = bopfStore({ zq424unn: bodyWithRootNode("ZQ424UNN", "") });
      const { pool: unnamedPool } = poolHarness([unnamedStore.route]);
      const { tools: unnamedTools } = await registered(unnamedPool, { journal });

      const unnamedResult = await invoke(unnamedTools, "abap_bopf_edit", {
        bo: "ZQ424UNN",
        operation: "create_bo",
        package: "$TMP",
        rootNodeName: "ITEM",
      });

      expect(okText(unnamedResult)).toContain("rootNode: (unnamed)");
    });
  });
});
