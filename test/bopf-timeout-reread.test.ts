/**
 * Issue #154: `abap_bopf_edit create_bo`/`activate` regularly outran the
 * 60s client default (`ABAP_TIMEOUT_MS`) against a live system. BOPF gets
 * its own longer per-family timeout (`ABAP_BOPF_TIMEOUT_MS`,
 * `cfg.bopfTimeoutMs`), and a client-side timeout no longer surfaces bare —
 * the tool layer re-reads the object on a fresh pool slot, polling, and
 * reports what it actually finds instead of guessing from the lost
 * response.
 *
 * Harness copied from test/bopf-create-recovery.test.ts: a real
 * `AdtSessionPool` over a real `FakeAdtServer`, so a re-read genuinely rides
 * a different minted session than the request that timed out. A transport
 * timeout is modelled the same way test/atc.test.ts does: a route that
 * THROWS an `ECONNABORTED`-tagged error rather than returning a response.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClientOptions } from "abap-adt-api/build/AdtHTTP.js";
// A VALUE import: the real class `AxiosHttpClient` wraps a client-side abort
// in (see `test/helpers/fake-adt.ts`'s own header for the same pattern).
import { HttpClientException } from "abap-adt-api/build/AdtHTTP.js";

import {
  FakeAdtServer,
  __resetFakeAdtCounters,
  bopfStore,
  type BopfStore,
  type FakeRoute,
  BOPF_COLLECTION_PATH,
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

// `sleep` is a new, optional `BopfRunDeps` field (issue #154) that the
// timeout re-read loop calls between polling attempts — a no-op here so the
// suite doesn't burn 6 * 5s of real wall-clock time per case.
function depsFor(pool: AdtSessionPool, opts: { journal?: Journal } = {}): BopfToolDeps {
  return {
    pool,
    safety: openGate(),
    ensureConnected: async () => {},
    errorResult,
    cfg: { maxResponseChars: 30_000 },
    transport: localTransport(),
    registerWrite: true,
    sleep: async () => {},
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
  dir = await mkdtemp(join(tmpdir(), "abapsmith-bopf-timeout-reread-"));
  try {
    await fn(new Journal(jcfg(), "A4H"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/**
 * Mirrors `AxiosHttpClient.request`'s own catch (see
 * node_modules/abap-adt-api/build/AxiosHttpClient.js): a real client-side
 * abort is an `AxiosError` (`code: "ECONNABORTED"`, no `.response`), which
 * that catch re-wraps into `new HttpClientException(error.message,
 * error.code, error.status, this.config, options, response, error)` — status
 * and response both `undefined`. `AdtHTTP._request`'s own catch then runs
 * this through `fromException` -> `fromError`, which (since it IS an
 * `HttpClientException` with no `.response`) produces `new
 * AdtHttpException(error)`, whose `status` getter reads `this.parent.status
 * || 0` = `0`. A plain `Object.assign(new Error(...), {code})` is NOT an
 * `HttpClientException` instance, so it takes a different, earlier branch in
 * `fromException` (`AdtErrorException.create(500, ...)`) — a shape a real
 * timeout never has. `options` should be the intercepted request's own
 * `.options` (the `HttpClientException.request` field) when the caller has
 * it, so the synthetic exception mirrors the real one as closely as
 * possible.
 */
function timeoutError(options: HttpClientOptions = {}): HttpClientException {
  const cause = Object.assign(new Error("timeout of 180000ms exceeded"), { code: "ECONNABORTED" });
  return new HttpClientException("timeout of 180000ms exceeded", "ECONNABORTED", undefined, {}, options, undefined, cause);
}

/** Intercepts the create POST and throws a transport timeout instead of answering. Never touches the store itself. */
function createTimeoutRoute(): FakeRoute {
  return (r) => {
    if (r.method !== "POST" || r.path !== BOPF_COLLECTION_PATH) return undefined;
    throw timeoutError(r.options);
  };
}

/**
 * Intercepts the activation POST and throws a transport timeout. When
 * `landsActive` is true, the store is updated to `adtcore:version="active"`
 * FIRST — modelling "the activation genuinely reached the server and
 * completed, only the response was lost" — mirroring how
 * `dyingCreateRoute` in bopf-create-recovery.test.ts models a landed create.
 */
function activationTimeoutRoute(store: BopfStore, name: string, opts: { landsActive: boolean }): FakeRoute {
  return (r) => {
    if (r.method !== "POST" || r.path !== "/sap/bc/adt/activation") return undefined;
    if (opts.landsActive) store.set(name, bopfBodyWithVersion(name, "active"));
    throw timeoutError(r.options);
  };
}

/** Same shape as bopf-create-recovery.test.ts's `bodyWithRootNode`, but with a caller-chosen `adtcore:version`. */
function bopfBodyWithVersion(name: string, version: "inactive" | "active"): string {
  const upper = name.toUpperCase();
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<bo:businessObject xmlns:bo="http://www.sap.com/wbobj/bopf/business_object" ` +
    `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${upper}" adtcore:type="BOBF" ` +
    `adtcore:version="${version}" adtcore:description="created by bopfStore">` +
    `<adtcore:packageRef adtcore:name="$TMP"/>` +
    `<bo:nodes bo:name="ROOT" bo:nodeID="Um9vdA==" bo:xmlName="Root" ` +
    `bo:objectModelGenerated="false" bo:authorizationCheck="false" bo:isExtensible="false" ` +
    `bo:isDependentObjectNode="false" bo:textNode="false" bo:createEnabled="true" ` +
    `bo:updateEnabled="true" bo:deleteEnabled="true" bo:rootNode="true" bo:objectModelObsolete="false"/>` +
    `</bo:businessObject>`
  );
}

// --------------------------------------------------------------- create_bo: timeout ---

describe("abap_bopf_edit create_bo — the create POST timed out client-side", () => {
  it("the object was already there server-side — recovered, no activation attempted, journal succeeded", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zas_bo_t: bopfBodyWithVersion("ZAS_BO_T", "inactive") });
      const { pool, server } = poolHarness([createTimeoutRoute(), store.route]);
      const { tools } = await registered(pool, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZAS_BO_T",
        operation: "create_bo",
        package: "$TMP",
      });

      const text = okText(result);
      expect(text).toContain("completed on the server after the client timeout");
      expect(text).toContain("No activation was attempted");

      const activationCalls = server.calls.filter(
        (r) => r.method === "POST" && r.path.includes("/sap/bc/adt/activation"),
      );
      expect(activationCalls).toHaveLength(0);

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.outcome).toBe("succeeded");
    });
  });

  it("the object never landed — TIMEOUT after 6 re-read attempts, retryable, journal failed", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore();
      const { pool } = poolHarness([createTimeoutRoute(), store.route]);
      const { tools } = await registered(pool, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZAS_BO_GONE",
        operation: "create_bo",
        package: "$TMP",
      });

      const payload = errorPayload(result);
      expect(payload.error).toBe("TIMEOUT");
      expect(payload.retryable).toBe(true);
      expect(String(payload.message)).toContain("found no business object");
      expect(String(payload.hint)).toContain("Retry create_bo");
      const details = payload.details as Record<string, unknown>;
      expect(details.rereadAttempts).toBe(6);

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.outcome).toBe("failed");
    });
  });
});

// ----------------------------------------------------------- create_bo activate:true ---

describe("abap_bopf_edit create_bo activate:true — the activation POST timed out client-side", () => {
  it("the create landed normally; the re-read shows version active — recovered success", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore();
      const { pool, server } = poolHarness([
        activationTimeoutRoute(store, "ZAS_BO_ACT", { landsActive: true }),
        store.route,
      ]);
      const { tools } = await registered(pool, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZAS_BO_ACT",
        operation: "create_bo",
        package: "$TMP",
        activate: true,
      });

      const text = okText(result);
      expect(text).toContain("completed on the server after the client timeout");
      expect(text).toContain("version active");

      const postCall = server.calls.find((r) => r.method === "POST" && r.path === BOPF_COLLECTION_PATH);
      expect(postCall).toBeDefined();
    });
  });

  it("the create landed normally but the re-read still shows inactive — TIMEOUT, not retryable, journal already succeeded", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore();
      const { pool } = poolHarness([
        activationTimeoutRoute(store, "ZAS_BO_STUCK", { landsActive: false }),
        store.route,
      ]);
      const { tools } = await registered(pool, { journal });

      const result = await invoke(tools, "abap_bopf_edit", {
        bo: "ZAS_BO_STUCK",
        operation: "create_bo",
        package: "$TMP",
        activate: true,
      });

      const payload = errorPayload(result);
      expect(payload.error).toBe("TIMEOUT");
      expect(payload.retryable).toBe(false);
      expect(String(payload.message)).toContain("was created, but its activation");
      expect(String(payload.hint)).toContain('operation: "activate"');

      const entries = await journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.outcome).toBe("succeeded");
    });
  });
});

// ------------------------------------------------------- operation:"activate" alone ---

describe('abap_bopf_edit operation:"activate" — the activation POST timed out client-side on an existing BO', () => {
  it("the re-read shows version active — recovered success", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zas_bo_std: bopfBodyWithVersion("ZAS_BO_STD", "inactive") });
      const { pool } = poolHarness([
        activationTimeoutRoute(store, "ZAS_BO_STD", { landsActive: true }),
        store.route,
      ]);
      const { tools } = await registered(pool, { journal });

      const result = await invoke(tools, "abap_bopf_edit", { bo: "ZAS_BO_STD", operation: "activate" });

      const text = okText(result);
      expect(text).toContain("completed on the server after the client timeout");
    });
  });

  it("the re-read still shows inactive — TIMEOUT, retryable, hint says try again", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zas_bo_std2: bopfBodyWithVersion("ZAS_BO_STD2", "inactive") });
      const { pool } = poolHarness([
        activationTimeoutRoute(store, "ZAS_BO_STD2", { landsActive: false }),
        store.route,
      ]);
      const { tools } = await registered(pool, { journal });

      const result = await invoke(tools, "abap_bopf_edit", { bo: "ZAS_BO_STD2", operation: "activate" });

      const payload = errorPayload(result);
      expect(payload.error).toBe("TIMEOUT");
      expect(payload.retryable).toBe(true);
      expect(String(payload.hint)).toContain("again");
    });
  });
});

// ------------------------------------------------------------- per-request timeout ---

describe("per-request timeout stamping (issue #154)", () => {
  it("create_bo's collection POST carries the bopf family timeout; the recovery GET does not", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zas_bo_t2: bopfBodyWithVersion("ZAS_BO_T2", "inactive") });
      const { pool, server } = poolHarness([createTimeoutRoute(), store.route]);
      const { tools } = await registered(pool, { journal });

      await invoke(tools, "abap_bopf_edit", { bo: "ZAS_BO_T2", operation: "create_bo", package: "$TMP" });

      const postCall = server.calls.find((r) => r.method === "POST" && r.path === BOPF_COLLECTION_PATH);
      expect(postCall?.options.timeout).toBe(180_000);

      const getCall = server.calls.find(
        (r) => r.method === "GET" && r.path === `${BOPF_COLLECTION_PATH}/zas_bo_t2`,
      );
      expect(getCall?.options.timeout).toBeUndefined();
    });
  });

  it("activation POST carries the bopf family timeout", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore();
      const { pool, server } = poolHarness([
        activationTimeoutRoute(store, "ZAS_BO_T3", { landsActive: true }),
        store.route,
      ]);
      const { tools } = await registered(pool, { journal });

      await invoke(tools, "abap_bopf_edit", {
        bo: "ZAS_BO_T3",
        operation: "create_bo",
        package: "$TMP",
        activate: true,
      });

      const activationCall = server.calls.find(
        (r) => r.method === "POST" && r.path.includes("/sap/bc/adt/activation"),
      );
      expect(activationCall?.options.timeout).toBe(180_000);
    });
  });
});

describe("AbapConnection.withRequestTimeout — direct unit coverage", () => {
  it("stamps options.timeout on requests inside the frame; a following unwrapped request has none", async () => {
    const { pool, server } = poolHarness([]);
    const conn = await pool.withRead("test", async (c) => c);

    // `pool.withRead`'s connection warm-up (`connect()`) issues its own
    // discovery request before this test's calls run — index from each
    // call's own starting count rather than `.find()`/`.at(-1)` over the
    // whole log, so an earlier unrelated discovery hit can't be mistaken for
    // the one this test just made.
    const beforeWrapped = server.calls.length;
    await conn.withRequestTimeout(1234, () => conn.get("/sap/bc/adt/discovery"));
    const wrapped = server.calls.slice(beforeWrapped).find((r) => r.path.endsWith("/discovery"));
    expect(wrapped?.options.timeout).toBe(1234);

    const beforeUnwrapped = server.calls.length;
    await conn.get("/sap/bc/adt/discovery");
    const unwrapped = server.calls.slice(beforeUnwrapped).find((r) => r.path.endsWith("/discovery"));
    expect(unwrapped?.options.timeout).toBeUndefined();
  });
});
