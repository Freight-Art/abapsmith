/**
 * Issue #200 special undo kinds — restore behaviour of `src/adt/undo-special.ts`
 * for the three kinds Agent B owns (see tests-split.md): text-pool,
 * bopf-model, enh-impl-active. enh-delete and the activate-delegation cases
 * are covered elsewhere (sibling agents' files).
 *
 * Each block builds one small, self-contained harness (this repo's
 * one-copy-per-test-file convention), copied from:
 *  - text-pool: test/text-pool.test.ts (FakeAdt/connected/authorizeOffline idiom)
 *  - bopf-model: test/bopf-journal.test.ts's wired()/bopfStore() idiom
 *  - enh-impl-active: test/enhancement-tools.test.ts's FakeAdt/connected idiom
 *
 * Entries are produced two ways: hand-built via journal.begin()/finish()
 * (text-pool — cheapest way to get an exact before/after image pair), and
 * by driving the real MCP tool with a real Journal (bopf-model,
 * enh-impl-active — proves the entry undo actually receives is the one the
 * tool really writes). Both patterns are already used by
 * test/bopf-journal.test.ts.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { SafetyGate } from "../src/safety.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrRequirement } from "../src/adt/transports.js";
import type { SessionPool } from "../src/adt/pool.js";
import { Journal, systemKey, type JournalConfig, type JournalEntry } from "../src/journal.js";
import { planUndo, performUndo, type UndoOptions } from "../src/adt/undo.js";
import { errorResult } from "../src/server.js";
import {
  textPoolUri,
  textPoolImage,
  parseTextPoolImage,
  buildSymbolsBody,
  buildSelectionsBody,
  buildHeadingsBody,
  parseSymbols,
  parseSelections,
  parseHeadings,
  type TextPool,
} from "../src/adt/text-pool.js";
import { FakeAdtServer, __resetFakeAdtCounters, bopfStore, type FakeRoute } from "./helpers/fake-adt.js";
import { DATA_PREVIEW_PATH, systemRoleProbeResponse, DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";
import { registerBopfTools, type BopfToolDeps } from "../src/tools/bopf.js";
import { registerEnhancementTools, type EnhToolDeps } from "../src/tools/enh.js";
import { patchEnhancementRootAttribute } from "../src/adt/enhancement-xml.js";

// ===========================================================================
// Shared tiny helpers
// ===========================================================================

const openGate = (extra: Partial<ConstructorParameters<typeof SafetyGate>[0]> = {}): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"], ...extra });

const undoOpts = (gate: SafetyGate, extra: Partial<UndoOptions> = {}): UndoOptions => ({
  gate,
  assertAllowed: (action, target) => gate.authorize(action === "delete" ? "delete" : "write", target as never),
  ...extra,
});

const catchErr = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(() => undefined, (err: unknown) => err);
  expect(isAbapError(e)).toBe(true);
  return e as AbapError;
};

// ===========================================================================
// Item 3 — text-pool undo (src/adt/text-pool.ts kind)
// ===========================================================================

describe("undo — text-pool restore", () => {
  interface Recorded {
    label: string;
    method: string;
    url: string;
    qs: Record<string, string>;
    body?: string;
  }
  type Route = (r: Recorded) => HttpClientResponse | undefined;

  const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
    ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;
  const OK_TEXT = { "content-type": "text/plain" };
  const OK_XML = { "content-type": "application/xml" };
  const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

  class FakeAdt implements HttpClient {
    readonly calls: Recorded[] = [];
    constructor(private readonly route: Route) {}
    async request(o: HttpClientOptions): Promise<HttpClientResponse> {
      const method = (o.method ?? "GET").toUpperCase();
      const qs = (o.qs ?? {}) as Record<string, string>;
      const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
      const rec: Recorded = { label, method, url: o.url, qs, body: o.body };
      this.calls.push(rec);
      const res = this.route(rec);
      if (!res) throw new Error(`FakeAdt: unrouted request ${label}`);
      return res;
    }
  }

  const REPORT = "ZMCP_UNDO_TXT";
  const REPORT_URI = "/sap/bc/adt/programs/programs/zmcp_undo_txt";
  const TEXT_URI = textPoolUri(REPORT);
  const DESCRIPTOR_XML =
    `<?xml version="1.0" encoding="utf-8"?><adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:name="${REPORT}" adtcore:type="PROG/PX" adtcore:masterLanguage="EN"/>`;

  /**
   * A tiny stateful text-pool server: symbols/selections/headings,
   * LOCK/UNLOCK. GET/PUT bodies round-trip through the production
   * buildXBody/parseX codec (src/adt/text-pool.ts) so this fake's wire
   * format is byte-identical to what writeTextPool/readTextPool produce and
   * expect — no hand-invented cassette bytes.
   */
  function textPoolFakeServer(initial: TextPool): { route: Route; get(): TextPool } {
    let state = initial;
    const route: Route = (r) => {
      if (r.url === TEXT_URI && r.method === "GET" && !r.qs._action) return resp(200, DESCRIPTOR_XML, OK_XML);
      if (r.url === TEXT_URI && r.qs._action === "LOCK") {
        return resp(
          200,
          `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
            `<LOCK_HANDLE>H1</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL>` +
            `<IS_LINK_UP/><MODIFICATION_SUPPORT/></DATA></asx:values></asx:abap>`,
          OK_XML,
        );
      }
      if (r.url === TEXT_URI && r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.url === `${TEXT_URI}/source/symbols`) {
        if (r.method === "GET") return resp(200, buildSymbolsBody(state.symbols), OK_TEXT);
        if (r.method === "PUT") {
          state = { ...state, symbols: parseSymbols(r.body ?? "") };
          return resp(200, "", { etag: "SYM1" });
        }
      }
      if (r.url === `${TEXT_URI}/source/selections`) {
        if (r.method === "GET") return resp(200, buildSelectionsBody(state.selectionTexts), OK_TEXT);
        if (r.method === "PUT") {
          state = { ...state, selectionTexts: parseSelections(r.body ?? "") };
          return resp(200, "", { etag: "SEL1" });
        }
      }
      if (r.url === `${TEXT_URI}/source/headings`) {
        if (r.method === "GET") return resp(200, buildHeadingsBody(state.headings), OK_TEXT);
        if (r.method === "PUT") {
          state = { ...state, headings: parseHeadings(r.body ?? "") };
          return resp(200, "", { etag: "HDR1" });
        }
      }
      return undefined;
    };
    return { route, get: () => state };
  }

  function baseRoute(r: Recorded): HttpClientResponse | undefined {
    if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
    if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
    if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
    if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
    return undefined;
  }

  /** resolveWriteTarget's package-discovery GET on the owning PROG/P object. */
  const OBJECT_XML = (name: string, packageName: string): string =>
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<adtcore:objectMetadata xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `adtcore:name="${name}" adtcore:type="PROG/P">` +
    `<adtcore:packageRef adtcore:name="${packageName}"/>` +
    `</adtcore:objectMetadata>`;
  function objectMetaRoute(r: Recorded): HttpClientResponse | undefined {
    if (r.method !== "GET" || r.qs._action) return undefined;
    if (r.url === REPORT_URI) return resp(200, OBJECT_XML(REPORT, "$TMP"), OK_XML);
    return undefined;
  }

  const cfg = (): Config =>
    ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "DEVELOPER",
      password: "secret",
      sid: "A4H",
      client: "001",
      readOnly: false,
    });

  async function connected(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
    const adt = new FakeAdt((r) => baseRoute(r) ?? route(r) ?? objectMetaRoute(r));
    const conn = new AbapConnection(cfg(), { httpClient: adt, log: () => {}, breaker: new AuthCircuitBreaker() });
    await conn.connect();
    adt.calls.length = 0;
    return { conn, adt };
  }

  let dir: string;
  const withJournal = async (fn: (j: Journal) => Promise<void>): Promise<void> => {
    dir = await mkdtemp(join(tmpdir(), "abapsmith-undo-textpool-"));
    try {
      await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  /** Hand-builds a beforeKind:"text-pool" entry, same idiom as bopf-journal.test.ts's refusal test. */
  async function beginTextPoolEntry(
    journal: Journal,
    conn: AbapConnection,
    before: TextPool,
    after: TextPool | undefined,
  ): Promise<JournalEntry> {
    const entry = await journal.begin({
      operation: "update",
      object: { name: REPORT, type: "PROG/PX", uri: REPORT_URI, package: "$TMP" },
      existedBefore: true,
      beforeCapture: "captured",
      beforeSource: textPoolImage(before, "PROG/P"),
      beforeKind: "text-pool",
      systemKey: systemKey(conn.cfg),
      tool: "test",
    });
    expect(entry).toBeDefined();
    await journal.finish(entry!.id, {
      outcome: "succeeded",
      ...(after !== undefined ? { afterSource: textPoolImage(after, "PROG/P") } : {}),
    });
    return (await journal.get(entry!.id))!;
  }

  const BEFORE_POOL: TextPool = { symbols: { A: "Alpha" }, selectionTexts: {}, headings: {} };
  const AFTER_POOL: TextPool = {
    symbols: { A: "Alpha", B: "Beta" },
    selectionTexts: { P_MAT: "Material" },
    headings: { listHeader: "Test List", columnHeaders: [] },
  };

  it("restores the before-image, clearing parts that were empty before (PUT with empty parts), and settles bookkeeping", async () => {
    await withJournal(async (journal) => {
      const server = textPoolFakeServer(AFTER_POOL);
      const { conn, adt } = await connected(server.route);
      const gate = openGate();
      const entry = await beginTextPoolEntry(journal, conn, BEFORE_POOL, AFTER_POOL);

      const plan = await planUndo(conn, journal, entry);
      expect(plan.action).toBe("restore");
      expect(plan.drift.drifted).toBe(false);

      const result = await performUndo(conn, journal, entry, undoOpts(gate, { activate: false }));
      expect(result.performed).toBe(true);

      // Server state now matches the before-image exactly, including the
      // cleared parts (selections/headings were non-empty before this undo).
      expect(server.get()).toEqual(BEFORE_POOL);

      const symbolsPut = adt.calls.find((c) => c.method === "PUT" && c.url === `${TEXT_URI}/source/symbols`);
      const selectionsPut = adt.calls.find((c) => c.method === "PUT" && c.url === `${TEXT_URI}/source/selections`);
      const headingsPut = adt.calls.find((c) => c.method === "PUT" && c.url === `${TEXT_URI}/source/headings`);
      expect(symbolsPut?.body).toContain("A=Alpha");
      expect(symbolsPut?.body).not.toContain("B=Beta");
      // Empty parts really were PUT (not skipped) — buildSelectionsBody({}) is "".
      expect(selectionsPut).toBeDefined();
      expect(selectionsPut?.body).toBe("");
      expect(headingsPut).toBeDefined();

      // New undo entry: undoOf + beforeKind text-pool; original marked undone.
      const entries = await journal.list();
      expect(entries).toHaveLength(2);
      const undoEntry = entries.find((e) => e.id !== entry.id)!;
      expect(undoEntry.undoOf).toBe(entry.id);
      expect(undoEntry.beforeKind).toBe("text-pool");
      const original = await journal.get(entry.id);
      expect(original?.undoneBy).toBe(undoEntry.id);
    });
  });

  it("refuses with ETAG_CONFLICT when the pool drifted from the after-image, proceeds with force", async () => {
    await withJournal(async (journal) => {
      const drifted: TextPool = { symbols: { A: "Alpha", C: "Changed" }, selectionTexts: {}, headings: {} };
      const server = textPoolFakeServer(drifted);
      const { conn, adt } = await connected(server.route);
      const gate = openGate();
      const entry = await beginTextPoolEntry(journal, conn, BEFORE_POOL, AFTER_POOL);

      const err = await catchErr(performUndo(conn, journal, entry, undoOpts(gate, { activate: false })));
      expect(err.code).toBe("ETAG_CONFLICT");
      expect(adt.calls.some((c) => c.method === "PUT")).toBe(false);
      expect(server.get()).toEqual(drifted);

      const result = await performUndo(conn, journal, entry, undoOpts(gate, { activate: false, force: true }));
      expect(result.performed).toBe(true);
      expect(result.forced).toBe(true);
      expect(server.get()).toEqual(BEFORE_POOL);
    });
  });

  it("is a noop when the current pool already matches the before-image", async () => {
    await withJournal(async (journal) => {
      const server = textPoolFakeServer(BEFORE_POOL);
      const { conn, adt } = await connected(server.route);
      const gate = openGate();
      const entry = await beginTextPoolEntry(journal, conn, BEFORE_POOL, AFTER_POOL);

      const plan = await planUndo(conn, journal, entry);
      expect(plan.action).toBe("noop");

      const result = await performUndo(conn, journal, entry, undoOpts(gate, { activate: false }));
      expect(result.performed).toBe(false);
      expect(adt.calls.some((c) => c.method === "PUT")).toBe(false);
      expect(await journal.list()).toHaveLength(1);
      const original = await journal.get(entry.id);
      expect(original?.undoneBy).toBeUndefined();
    });
  });
});

// ===========================================================================
// Item 4 — bopf-model undo (src/adt/bopf.ts / undo-special.ts kind)
// ===========================================================================

describe("undo — bopf-model restore", () => {
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bopf");
  const fixture = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");
  const FX_JUST_CREATED = fixture("02-created-zbopf_prb1-root-only.v4.xml");

  const systemRoleRoute: FakeRoute = (r) =>
    r.path.includes(DATA_PREVIEW_PATH) ? systemRoleProbeResponse("nonproductive") : undefined;

  const activationRoute: FakeRoute = (r) =>
    r.path.includes("/activation") ? { status: 200, body: "", headers: { "content-type": "text/plain" } } : undefined;

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

  async function wired(routes: readonly FakeRoute[]): Promise<{ conn: AbapConnection; server: FakeAdtServer }> {
    const server = new FakeAdtServer({ transportErrors: "throw", routes: [systemRoleRoute, ...routes] });
    const conn = new AbapConnection(cfg(), { httpClient: server.client("s1"), log: () => {}, breaker: new AuthCircuitBreaker() });
    openConnections.push(conn);
    await conn.connect();
    return { conn, server };
  }

  function fakePool(conn: AbapConnection): SessionPool {
    return {
      withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
      withWrite: <T,>(_op: string, _uri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
      reserveDebug: () => {
        throw new Error("reserveDebug: not used here.");
      },
    } as unknown as SessionPool;
  }

  function fakeMcp(): { mcp: McpServer; tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }> } {
    const tools = new Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>();
    const mcp = {
      registerTool: (name: string, _c: unknown, handler: (args: unknown) => Promise<CallToolResult>) => {
        tools.set(name, { handler });
        return {} as unknown;
      },
    } as unknown as McpServer;
    return { mcp, tools };
  }

  async function invoke(tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>, name: string, args: unknown): Promise<CallToolResult> {
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
    ({ kind: "local", required: false, mustSupplyCorrNr: false, serverWouldFabricate: false, ...overrides }) as unknown as TrRequirement;
  const localTransport = (): SessionTransport =>
    new SessionTransport({ allowTransports: ["auto"], cts: { trRequirement: async () => fakeReq() } });

  function depsFor(conn: AbapConnection, journal: Journal): BopfToolDeps {
    return {
      pool: fakePool(conn),
      safety: openGate({ allowPackages: ["$TMP"] }),
      ensureConnected: async () => {},
      errorResult,
      cfg: { maxResponseChars: 30_000 },
      transport: localTransport(),
      registerWrite: true,
      journal,
    };
  }

  let dir: string;
  const withJournal = async (fn: (j: Journal) => Promise<void>): Promise<void> => {
    dir = await mkdtemp(join(tmpdir(), "abapsmith-undo-bopf-"));
    try {
      await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  /** Drives a real add_node through the tool layer to get a genuine beforeKind:"bopf-model" entry. */
  async function addNodeEntry(journal: Journal, conn: AbapConnection, tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>): Promise<JournalEntry> {
    okText(
      await invoke(tools, "abap_bopf_edit", {
        bo: "ZBOPF_PRB1",
        operation: "add_node",
        name: "ITEM",
        spec: { parent: "ROOT", rootNode: false, createEnabled: true },
      }),
    );
    const entries = await journal.list();
    expect(entries).toHaveLength(1);
    return entries[0]!;
  }

  it("performUndo PUTs the before XML inside a stateful session and attempts activation", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
      const { conn, server } = await wired([store.route, activationRoute]);
      const { tools } = await registered(conn, journal);

      const entry = await addNodeEntry(journal, conn, tools);
      expect(entry.beforeKind).toBe("bopf-model");
      expect(entry.undoable).toBe(true);

      const plan = await planUndo(conn, journal, entry);
      expect(plan.drift.drifted).toBe(false);
      expect(plan.action).toBe("restore");

      const gate = openGate({ allowPackages: ["$TMP"] });
      const before = server.calls.length;
      const result = await performUndo(conn, journal, entry, undoOpts(gate, { transport: localTransport() }));
      expect(result.performed).toBe(true);

      // Store is back to root-only, up to the ID/timestamp noise that
      // bopfModelComparable() strips.
      expect(store.get("zbopf_prb1")).not.toContain('bo:name="ITEM"');

      const calls = server.calls.slice(before);
      expect(calls.some((c) => c.method === "PUT")).toBe(true);
      expect(calls.some((c) => c.path.includes("/activation"))).toBe(true);

      const entries = await journal.list();
      const undoEntry = entries.find((e) => e.id !== entry.id)!;
      expect(undoEntry.beforeKind).toBe("bopf-model");
      expect(undoEntry.undoOf).toBe(entry.id);
      expect((await journal.get(entry.id))?.undoneBy).toBe(undoEntry.id);
    });

    async function registered(conn: AbapConnection, journal: Journal): Promise<{ tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }> }> {
      const { mcp, tools } = fakeMcp();
      registerBopfTools(mcp, depsFor(conn, journal));
      return { tools };
    }
  });

  it("is a noop when the model already matches the before-image", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
      const { conn, server } = await wired([store.route, activationRoute]);
      const { mcp, tools } = fakeMcp();
      registerBopfTools(mcp, depsFor(conn, journal));

      const entry = await addNodeEntry(journal, conn, tools);
      // Simulate the model already having been reverted by hand.
      store.set("zbopf_prb1", FX_JUST_CREATED);

      const plan = await planUndo(conn, journal, entry);
      expect(plan.action).toBe("noop");

      const gate = openGate({ allowPackages: ["$TMP"] });
      const before = server.calls.length;
      const result = await performUndo(conn, journal, entry, undoOpts(gate, { transport: localTransport() }));
      expect(result.performed).toBe(false);
      expect(server.calls.slice(before).some((c) => c.method === "PUT")).toBe(false);
      expect(await journal.list()).toHaveLength(1);
    });
  });

  it("refuses with ETAG_CONFLICT when the model drifted since this write, proceeds with force", async () => {
    await withJournal(async (journal) => {
      const store = bopfStore({ zbopf_prb1: FX_JUST_CREATED });
      const { conn, server } = await wired([store.route, activationRoute]);
      const { mcp, tools } = fakeMcp();
      registerBopfTools(mcp, depsFor(conn, journal));

      const entry = await addNodeEntry(journal, conn, tools);
      // A second, independent change lands on the model after this write.
      okText(
        await invoke(tools, "abap_bopf_edit", {
          bo: "ZBOPF_PRB1",
          operation: "add_node",
          name: "ITEM2",
          spec: { parent: "ROOT", rootNode: false, createEnabled: true },
        }),
      );
      const driftedXml = store.get("zbopf_prb1")!;

      const gate = openGate({ allowPackages: ["$TMP"] });
      const err = await catchErr(performUndo(conn, journal, entry, undoOpts(gate, { transport: localTransport() })));
      expect(err.code).toBe("ETAG_CONFLICT");
      expect(store.get("zbopf_prb1")).toBe(driftedXml);

      const result = await performUndo(conn, journal, entry, undoOpts(gate, { transport: localTransport(), force: true }));
      expect(result.performed).toBe(true);
      expect(result.forced).toBe(true);
      expect(store.get("zbopf_prb1")).not.toContain('bo:name="ITEM2"');
      expect(store.get("zbopf_prb1")).not.toContain('bo:name="ITEM"');
    });
  });
});

// ===========================================================================
// Item 6 — enh-impl-active undo (set_impl_active kind)
// ===========================================================================

describe("undo — enh-impl-active restore", () => {
  interface Recorded {
    label: string;
    method: string;
    url: string;
    qs: Record<string, string>;
    body?: string;
  }
  type Route = (r: Recorded) => HttpClientResponse | undefined;

  const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
    ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;
  const OK_XML = { "content-type": "application/xml" };
  const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

  class FakeAdt implements HttpClient {
    readonly calls: Recorded[] = [];
    constructor(private readonly route: Route) {}
    async request(o: HttpClientOptions): Promise<HttpClientResponse> {
      const method = (o.method ?? "GET").toUpperCase();
      const qs = (o.qs ?? {}) as Record<string, string>;
      const label = qs._action ? `${qs._action} ${o.url}` : `${method} ${o.url}`;
      const rec: Recorded = { label, method, url: o.url, qs, body: o.body };
      this.calls.push(rec);
      const res = this.route(rec);
      if (!res) throw new Error(`FakeAdt: unrouted request ${label}`);
      return res;
    }
  }

  const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement");
  const fixture = (name: string): string => readFileSync(join(FIXTURES_DIR, name), "utf8");
  const DISCOVERY_ENHANCEMENTS_XML = fixture("discovery-enhancements.xml");
  const ENHOXH_URI = "/sap/bc/adt/enhancements/enhoxh/ZMCP_ENH_BADI";
  const ENHOXH_XML = fixture("354-enhoxh-no-filter.xml");
  const ENHOXH_XML_WITH_DESC = patchEnhancementRootAttribute(ENHOXH_XML, "description", "ZMCP recon BAdI implementation");
  const LOCK_LOCAL_XML =
    `<?xml version="1.0" encoding="utf-8"?><asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml">` +
    `<asx:values><DATA><LOCK_HANDLE>84895B18717205C738BE52DAB00DC12609C1821F</LOCK_HANDLE><CORRNR/>` +
    `<CORRUSER/><CORRTEXT/><IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/>` +
    `<MODIFICATION_SUPPORT>NoModification</MODIFICATION_SUPPORT><SCOPE_MESSAGES/></DATA></asx:values></asx:abap>`;
  const AFFECTS_SPOT = { name: "ZMCP_SPOT", packageName: "$TMP", masterSystem: "A4H", spotName: "ZMCP_SPOT" };

  function baseRoute(r: Recorded): HttpClientResponse | undefined {
    if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
    if (r.url.endsWith("/discovery")) return resp(200, DISCOVERY_ENHANCEMENTS_XML, OK_XML);
    if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
    if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_NONPRODUCTIVE, DATAPREVIEW_XML);
    return undefined;
  }

  /** A tiny stateful ENHO/XH server tracking one document's current bytes. */
  function enhoxhStore(initialXml: string): { route: Route; current(): string; set(xml: string): void } {
    let current = initialXml;
    let etagCounter = 0;
    const route: Route = (r) => {
      if (r.url !== ENHOXH_URI) return undefined;
      if (r.method === "GET" && !r.qs._action) return resp(200, current, OK_XML);
      if (r.qs._action === "LOCK") return resp(200, LOCK_LOCAL_XML, OK_XML);
      if (r.qs._action === "UNLOCK") return resp(200, "", OK_XML);
      if (r.method === "PUT") {
        current = r.body ?? current;
        etagCounter += 1;
        return resp(200, "", { etag: `SYNETAG${etagCounter}` });
      }
      return undefined;
    };
    return { route, current: () => current, set: (xml: string) => { current = xml; } };
  }
  const activationRoute: Route = (r) =>
    r.url.includes("/activation") ? resp(200, `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun"/>`, OK_XML) : undefined;

  const cfg = (): Config =>
    ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "DEVELOPER",
      password: "secret",
      sid: "A4H",
      client: "001",
      readOnly: false,
    });

  async function connected(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
    const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
    const conn = new AbapConnection(cfg(), { httpClient: adt, log: () => {}, breaker: new AuthCircuitBreaker() });
    await conn.connect();
    adt.calls.length = 0;
    return { conn, adt };
  }

  const fakeReq = (): TrRequirement =>
    ({ kind: "local", mustSupplyCorrNr: false, serverWouldFabricate: false, uri: "", operation: "U", candidates: [], locks: [], messages: [], checkFailed: false, raw: { result: "S", korrflag: "", recording: "" } }) as unknown as TrRequirement;
  const localTransport = (): SessionTransport => new SessionTransport({ allowTransports: ["*"], cts: { trRequirement: async () => fakeReq() } });

  function fakePool(conn: AbapConnection): SessionPool {
    return {
      withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
      withWrite: <T,>(_op: string, _uri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => fn(conn),
      reserveDebug: () => {
        throw new Error("reserveDebug: not used here.");
      },
    } as unknown as SessionPool;
  }

  function fakeMcp(): { mcp: McpServer; tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }> } {
    const tools = new Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>();
    const mcp = {
      registerTool: (name: string, _c: unknown, handler: (args: unknown) => Promise<CallToolResult>) => {
        tools.set(name, { handler });
        return {} as unknown;
      },
    } as unknown as McpServer;
    return { mcp, tools };
  }

  async function invoke(tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>, name: string, args: unknown): Promise<CallToolResult> {
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

  function depsFor(conn: AbapConnection, journal: Journal): EnhToolDeps {
    return {
      pool: fakePool(conn),
      safety: openGate({ allowEnhancements: true, enhanceTargets: "customer", originSystems: ["A4H"] }),
      ensureConnected: async () => {},
      errorResult,
      cfg: { maxResponseChars: 30_000 },
      transport: localTransport(),
      journal,
    };
  }

  let dir: string;
  const withJournal = async (fn: (j: Journal) => Promise<void>): Promise<void> => {
    dir = await mkdtemp(join(tmpdir(), "abapsmith-undo-enh-impl-active-"));
    try {
      await fn(new Journal({ dir, enabled: true, maxEntries: 200, maxAgeDays: 30 }, "A4H"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  /** Drives a real set_impl_active (true -> false) through the tool layer. */
  async function flipToFalse(
    journal: Journal,
    tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>,
  ): Promise<JournalEntry> {
    okText(
      await invoke(tools, "abap_enh", {
        operation: "set_impl_active",
        name: "ZMCP_ENH_BADI",
        spec: { active: false },
        affects: AFFECTS_SPOT,
      }),
    );
    const entries = await journal.list();
    expect(entries).toHaveLength(1);
    return entries[0]!;
  }

  it("flips the flag back to its previous value (implName used) and activates", async () => {
    await withJournal(async (journal) => {
      const store = enhoxhStore(ENHOXH_XML_WITH_DESC);
      const { conn, adt } = await connected((r) => store.route(r) ?? activationRoute(r));
      const { mcp, tools } = fakeMcp();
      registerEnhancementTools(mcp, depsFor(conn, journal));

      const entry = await flipToFalse(journal, tools);
      expect(entry.beforeKind).toBe("enh-impl-active");
      expect(entry.implName).toBe("ZMCP_BADI_I1");
      expect(entry.undoable).toBe(true);

      const plan = await planUndo(conn, journal, entry);
      expect(plan.drift.drifted).toBe(false);

      const gate = openGate({ allowEnhancements: true, enhanceTargets: "customer", originSystems: ["A4H"] });
      const before = adt.calls.length;
      const result = await performUndo(conn, journal, entry, undoOpts(gate, { transport: localTransport() }));
      expect(result.performed).toBe(true);
      // UndoResult.activation is the raw ActivationOutcome (activated/ok/...),
      // not the {attempted,...} shape settle() persists on the journal entry
      // — its presence at all means activation was attempted.
      expect(result.activation).toBeDefined();
      expect(result.activation?.activated).toBe(true);

      expect(store.current()).toContain('enho:name="ZMCP_BADI_I1"');
      expect(store.current()).toMatch(/enho:name="ZMCP_BADI_I1"[^>]*enho:isActive="true"|enho:isActive="true"[^>]*enho:name="ZMCP_BADI_I1"/);

      const calls = adt.calls.slice(before);
      expect(calls.some((c) => c.method === "PUT")).toBe(true);
      expect(calls.some((c) => c.url.includes("/activation"))).toBe(true);

      const entries = await journal.list();
      const undoEntry = entries.find((e) => e.id !== entry.id)!;
      expect(undoEntry.beforeKind).toBe("enh-impl-active");
      expect(undoEntry.implName).toBe("ZMCP_BADI_I1");
      expect(undoEntry.undoOf).toBe(entry.id);
      expect((await journal.get(entry.id))?.undoneBy).toBe(undoEntry.id);
    });
  });

  it("is a noop when the flag is already back at the previous value", async () => {
    await withJournal(async (journal) => {
      const store = enhoxhStore(ENHOXH_XML_WITH_DESC);
      const { conn, adt } = await connected((r) => store.route(r) ?? activationRoute(r));
      const { mcp, tools } = fakeMcp();
      registerEnhancementTools(mcp, depsFor(conn, journal));

      const entry = await flipToFalse(journal, tools);
      // Someone else already flipped it back by hand.
      const restored = store.current().replace('enho:isActive="false"', 'enho:isActive="true"');
      expect(restored).not.toBe(store.current());
      store.set(restored);

      const plan = await planUndo(conn, journal, entry);
      expect(plan.action).toBe("noop");

      const gate = openGate({ allowEnhancements: true, enhanceTargets: "customer", originSystems: ["A4H"] });
      const before = adt.calls.length;
      const result = await performUndo(conn, journal, entry, undoOpts(gate, { transport: localTransport() }));
      expect(result.performed).toBe(false);
      expect(adt.calls.slice(before).some((c) => c.method === "PUT")).toBe(false);
      expect(await journal.list()).toHaveLength(1);
    });
  });

  it("refuses with ETAG_CONFLICT when the implementation entry was renamed/removed since this write", async () => {
    await withJournal(async (journal) => {
      const store = enhoxhStore(ENHOXH_XML_WITH_DESC);
      const { conn, adt } = await connected((r) => store.route(r) ?? activationRoute(r));
      const { mcp, tools } = fakeMcp();
      registerEnhancementTools(mcp, depsFor(conn, journal));

      const entry = await flipToFalse(journal, tools);
      // Independent change: the implementation this entry is about no longer
      // resolves under its recorded implName.
      const renamed = store.current().replace('enho:name="ZMCP_BADI_I1"', 'enho:name="ZMCP_BADI_RENAMED"');
      expect(renamed).not.toBe(store.current());
      store.set(renamed);

      const gate = openGate({ allowEnhancements: true, enhanceTargets: "customer", originSystems: ["A4H"] });
      const before = adt.calls.length;
      const err = await catchErr(performUndo(conn, journal, entry, undoOpts(gate, { transport: localTransport() })));
      expect(err.code).toBe("ETAG_CONFLICT");
      expect(adt.calls.slice(before).every((c) => c.method !== "PUT")).toBe(true);
    });
  });

  it("blocked with 'no longer exists' when the implementation object is gone (404)", async () => {
    await withJournal(async (journal) => {
      const store = enhoxhStore(ENHOXH_XML_WITH_DESC);
      const { conn, adt } = await connected((r) => store.route(r) ?? activationRoute(r));
      const { mcp, tools } = fakeMcp();
      registerEnhancementTools(mcp, depsFor(conn, journal));

      const entry = await flipToFalse(journal, tools);

      // Object is now gone: the reader GET 404s instead of resolving.
      const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
        <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
        <message lang="EN">ZMCP_ENH_BADI does not exist</message><properties/></exc:exception>`;
      const { conn: goneConn, adt: goneAdt } = await connected((r) => {
        if (r.url === ENHOXH_URI && r.method === "GET" && !r.qs._action) {
          return resp(404, NOT_FOUND_XML, OK_XML);
        }
        return activationRoute(r);
      });

      const plan = await planUndo(goneConn, journal, entry);
      expect(plan.undoable).toBe(false);
      expect(plan.blocker).toMatch(/no longer exists/);

      const gate = openGate({ allowEnhancements: true, enhanceTargets: "customer", originSystems: ["A4H"] });
      const err = await catchErr(performUndo(goneConn, journal, entry, undoOpts(gate, { transport: localTransport() })));
      expect(err.message).toMatch(/no longer exists/);
      expect(goneAdt.calls.some((c) => c.method === "PUT")).toBe(false);
    });
  });
});
