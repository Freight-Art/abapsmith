/**
 * Multi-system routing (issue #93): the `system` tool parameter, per-system
 * dispatch, and the safety gate evaluating the ROUTED system rather than the
 * default.
 *
 * The headline test is named exactly
 * "refuses a write aimed at a read-mode system even though the default
 * system is admin" — it proves the gate is per-target, not per-process: an
 * admin default system does not widen a read-only sibling, and the refusal
 * costs the sibling's fake transport ZERO requests (same "refused before the
 * wire" discipline `test/tools.test.ts` and `test/server-debug-gate.test.ts`
 * already pin for the single-system case).
 *
 * Mock scaffolding for `abap_write` is copied from `test/tools.test.ts`
 * (same modules, same fakes) — this file needs a real, gated `abap_write`
 * to route between two systems, not a new fake of its own. The debug mock
 * is copied from `test/server-debug-gate.test.ts` for the same reason: the
 * SYSTEM_MISMATCH test needs a real (routed, gated) `abap_debug`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { createServer, type AbapsmithServer, type ServerOptions } from "../src/server.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { AbapError } from "../src/adt/errors.js";
import type { SystemSpec } from "../src/systems/spec.js";
import { DATAPREVIEW_XML, T000_NONPRODUCTIVE } from "./helpers/system-role-fake.js";

// ------------------------------------------------------------- write mocks ---
// Same fakes `test/tools.test.ts` uses for `abap_write` — copied rather than
// imported, because `vi.mock` factories must be local to the file that calls
// them. Trimmed of the comments explaining each fake's own rationale; see
// `test/tools.test.ts` for those.
const adt = vi.hoisted(() => ({
  resolveObject: vi.fn(),
  resolveWriteTarget: vi.fn(),
  writeObject: vi.fn(),
  deleteObject: vi.fn(),
  authorizeMutation: vi.fn(
    async (
      conn: unknown,
      gate: { assert: (op: string, obj: unknown) => void },
      op: string,
      target: unknown,
    ) => {
      const t = (await adt.resolveWriteTarget(conn, target)) as {
        name: string;
        packageName: string;
        type: string;
        superPackage?: string;
        exists?: boolean;
      };
      gate.assert(op, {
        name: t.name,
        packageName: t.packageName,
        type: t.type,
        ...(t.superPackage !== undefined ? { superPackage: t.superPackage } : {}),
        ...(t.exists !== undefined ? { exists: t.exists } : {}),
      });
      return { op, target: t };
    },
  ),
  isPackageType: vi.fn((type?: string) => type === "DEVC/K"),
  createPackage: vi.fn(),
  preflightPackageCorr: vi.fn(),
  createPackageViaBridge: vi.fn(),
  tdevcDiscrepancies: vi.fn(() => [] as string[]),
  assertNoDuplicateDeleteTargets: vi.fn((targets: ReadonlyArray<{ name: string; uri: string }>) => {
    const seen = new Set<string>();
    for (const t of targets) {
      const key = t.uri || t.name.trim().toUpperCase();
      if (seen.has(key)) {
        throw new AbapError("BAD_INPUT", `duplicate object in batch: ${t.name}`, { name: t.name });
      }
      seen.add(key);
    }
  }),
  MAX_DELETE_BATCH: 10,
  PACKAGE_SOFTWARE_COMPONENT_HINT: "Use HOME (or another real software component) for a transportable package.",
  readCurrentSource: vi.fn(async (): Promise<string | undefined> => {
    const last = adt.writeObject.mock.results.at(-1)?.value as Promise<{ etag?: string }> | undefined;
    return (await last)?.etag ?? "";
  }),
  canonicalEtag: vi.fn((s: string) => s),
  checkSource: vi.fn(),
  activateObject: vi.fn(),
  assertNoErrors: vi.fn(),
  parseStartFragment: vi.fn(),
  renderMessages: vi.fn(() => ""),
  renderInactive: vi.fn(() => ""),
  prettyPrintSource: vi.fn(),
  activateObjects: vi.fn(),
  assertBatchActivated: vi.fn(),
  renderBatch: vi.fn(() => ""),
  MAX_ACTIVATION_BATCH: 50,
  runClass: vi.fn(),
  runReport: vi.fn(),
  bridgeClassName: vi.fn(),
  bridgeClassSource: vi.fn(),
  stripListHeader: vi.fn(),
}));

vi.mock("../src/adt/write.js", () => ({
  resolveWriteTarget: adt.resolveWriteTarget,
  authorizeMutation: adt.authorizeMutation,
  writeObject: adt.writeObject,
  deleteObject: adt.deleteObject,
  isPackageType: adt.isPackageType,
  createPackage: adt.createPackage,
  preflightPackageCorr: adt.preflightPackageCorr,
  readCurrentSource: adt.readCurrentSource,
  canonicalEtag: adt.canonicalEtag,
  assertNoDuplicateDeleteTargets: adt.assertNoDuplicateDeleteTargets,
  MAX_DELETE_BATCH: adt.MAX_DELETE_BATCH,
  PACKAGE_SOFTWARE_COMPONENT_HINT: adt.PACKAGE_SOFTWARE_COMPONENT_HINT,
}));
vi.mock("../src/adt/package-create.js", () => ({
  createPackageViaBridge: adt.createPackageViaBridge,
  tdevcDiscrepancies: adt.tdevcDiscrepancies,
}));
vi.mock("../src/adt/activate.js", () => ({
  checkSource: adt.checkSource,
  activateObject: adt.activateObject,
  assertNoErrors: adt.assertNoErrors,
  parseStartFragment: adt.parseStartFragment,
  renderMessages: adt.renderMessages,
  renderInactive: adt.renderInactive,
  prettyPrintSource: adt.prettyPrintSource,
  activateObjects: adt.activateObjects,
  assertBatchActivated: adt.assertBatchActivated,
  renderBatch: adt.renderBatch,
  MAX_ACTIVATION_BATCH: adt.MAX_ACTIVATION_BATCH,
}));
vi.mock("../src/adt/resolve.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/adt/resolve.js")>()),
  resolveObject: adt.resolveObject,
}));
vi.mock("../src/adt/run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/adt/run.js")>()),
  runClass: adt.runClass,
  runReport: adt.runReport,
  bridgeClassName: adt.bridgeClassName,
  bridgeClassSource: adt.bridgeClassSource,
  stripListHeader: adt.stripListHeader,
  BRIDGE_PACKAGE: "$TMP",
}));

// ------------------------------------------------------------- debug mock ---
// Same fake `test/server-debug-gate.test.ts` uses for `abap_debug`.
const debugTool = vi.hoisted(() => ({ abapDebug: vi.fn() }));
vi.mock("../src/tools/debug.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/debug.js")>()),
  abapDebug: debugTool.abapDebug,
}));

// ---------------------------------------------------------------- fixtures ---

/** Counts (and can refuse) every request that would leave the process. */
class CountingClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: (o: HttpClientOptions) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond(o);
  }
}

/**
 * Fail-closed system-role detection (see `test/tools.test.ts` for the full
 * rationale): the fake answers the real captured T000-CCCATEGORY bytes for
 * client 001, so `AbapConnection.connect()` legitimately concludes
 * "nonproductive" rather than write-locking every configured system.
 */
const okResponse = (o?: HttpClientOptions): HttpClientResponse => {
  if (o?.url?.includes("/datapreview/freestyle")) {
    return {
      status: 200,
      statusText: "200",
      body: T000_NONPRODUCTIVE,
      headers: { ...DATAPREVIEW_XML, "x-csrf-token": "TOKEN" },
    } as unknown as HttpClientResponse;
  }
  return {
    status: 200,
    statusText: "200",
    body: "ok",
    headers: { "content-type": "text/plain", "x-csrf-token": "TOKEN" },
  } as unknown as HttpClientResponse;
};

const okClient = () => new CountingClient(okResponse);

/** A transport that must never be reached — proves a refusal costs ZERO requests, not merely a network error. */
const forbiddenClient = () =>
  new CountingClient(() => {
    throw new Error("NETWORK CALL LEAKED: a call refused (or routed elsewhere) must not touch this system");
  });

/** Base config: a fully admin, T000-provably-nonproductive system, distinguished by `sid`/`client`. */
const cfg = (over: Partial<Config> = {}): Config => ({
  ...ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "TST",
    client: "001",
    allowTransports: ["*"],
  }),
  ...over,
});

const adminCfg = (sid: string) => cfg({ sid, readOnly: false, allowPackages: ["$TMP"] });
const readCfg = (sid: string) => cfg({ sid, readOnly: true });

function spec(alias: string, c: Config, isDefault: boolean): SystemSpec {
  return { alias, cfg: c, isDefault, env: {}, source: "test" };
}

interface TwoSystems {
  devClient: CountingClient;
  qasClient: CountingClient;
  opts: ServerOptions;
}

/** DEV is always the default. `devCfg`/`qasCfg` let each test pick admin vs read-only per system. */
function twoSystems(devCfg: Config, qasCfg: Config, devClient = okClient(), qasClient = okClient()): TwoSystems {
  const systems = [spec("DEV", devCfg, true), spec("QAS", qasCfg, false)];
  const opts: ServerOptions = {
    httpClient: devClient, // unused directly (per-system override below); required by ConnectionOptions.
    log: () => {},
    breaker: new AuthCircuitBreaker(),
    systems,
    connectionOptionsFor: (alias) => (alias === "DEV" ? { httpClient: devClient } : { httpClient: qasClient }),
  };
  return { devClient, qasClient, opts };
}

interface Harness {
  srv: AbapsmithServer;
  client: Client;
}

async function harness(opts: ServerOptions, config: Config): Promise<Harness> {
  const srv = createServer(config, opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), srv.mcp.connect(serverTransport)]);
  return { srv, client };
}

interface ToolCallResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

const call = async (h: Harness, name: string, args: Record<string, unknown>) =>
  (await h.client.callTool({ name, arguments: args })) as unknown as ToolCallResult;

const errorOf = (res: ToolCallResult): Record<string, unknown> => {
  expect(res.isError).toBe(true);
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
};

const WRITE_TARGET = {
  spec: {} as never,
  type: "PROG/P",
  name: "ZMCP_DEMO",
  uri: "/sap/bc/adt/programs/programs/zmcp_demo",
  sourceUri: "/sap/bc/adt/programs/programs/zmcp_demo/source/main",
  packageName: "$TMP",
  description: "demo",
};

beforeEach(() => {
  vi.clearAllMocks();
  adt.renderMessages.mockReturnValue("");
  debugTool.abapDebug.mockResolvedValue({
    text: "action: start\nstatus: suspended\nprogram: ZMCP_DEMO\nline: 12\nstateId: S1",
    truncated: false,
    estimatedTokens: 10,
  });
});

// ------------------------------------------------------------------ tests ---

describe("per-system safety gate (the mandated regression)", () => {
  it("refuses a write aimed at a read-mode system even though the default system is admin", async () => {
    const { devClient, qasClient, opts } = twoSystems(adminCfg("DEV"), readCfg("QAS"));
    const h = await harness(opts, opts.systems![0]!.cfg);

    // The refused call: routed to QAS (read-only), even though DEV (the
    // default, admin) is where an un-routed call would land.
    const refused = await call(h, "abap_write", {
      object: "ZMCP_DEMO",
      type: "PROG/P",
      package: "$TMP",
      mode: "delete",
      system: "QAS",
    });
    const err = errorOf(refused);
    expect(err.error).toBe("READ_ONLY");
    // Zero requests to QAS's fake — the gate runs before `ensureConnected()`.
    expect(qasClient.calls).toHaveLength(0);
    expect(adt.resolveWriteTarget).not.toHaveBeenCalled();
    expect(adt.deleteObject).not.toHaveBeenCalled();
    // DEV's fake was never touched by this call either.
    expect(devClient.calls).toHaveLength(0);

    // Same call, no `system` — targets the admin default (DEV) and is NOT
    // refused for a permission reason (it goes through to completion).
    adt.resolveWriteTarget.mockResolvedValue(WRITE_TARGET);
    adt.deleteObject.mockResolvedValue({
      target: WRITE_TARGET,
      deleted: true,
      transport: { status: "local", required: false },
    });
    const ok = await call(h, "abap_write", {
      object: "ZMCP_DEMO",
      package: "$TMP",
      mode: "delete",
    });
    expect(ok.isError).toBeFalsy();
    expect(adt.deleteObject).toHaveBeenCalledTimes(1);
    // The un-routed call touched DEV's fake (the T000 probe + the PUT/whatever
    // the fake write path makes), never QAS's.
    expect(devClient.calls.length).toBeGreaterThan(0);
    expect(qasClient.calls).toHaveLength(0);
  });
});

describe("system param schema presence", () => {
  it("is present on abap_write's schema only when 2+ systems are configured", async () => {
    const { opts } = twoSystems(adminCfg("DEV"), adminCfg("QAS"));
    const multi = await harness(opts, opts.systems![0]!.cfg);
    const { tools: multiTools } = await multi.client.listTools();
    const multiWrite = multiTools.find((t) => t.name === "abap_write");
    expect(multiWrite).toBeDefined();
    const multiProps = (multiWrite!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(multiProps)).toContain("system");

    const single = await harness(
      { httpClient: forbiddenClient(), log: () => {}, breaker: new AuthCircuitBreaker() },
      adminCfg("DEV"),
    );
    const { tools: singleTools } = await single.client.listTools();
    const singleWrite = singleTools.find((t) => t.name === "abap_write");
    expect(singleWrite).toBeDefined();
    const singleProps = (singleWrite!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(singleProps)).not.toContain("system");
  });
});

describe("unknown system alias", () => {
  // `registry.resolve()` throws BEFORE `runInSystem()` even starts — outside
  // the tool handler's own try/catch (which only wraps `original(...)`), so
  // this AbapError propagates out of the registered callback untouched. Per
  // `test/tools.test.ts`'s own note on this exact situation, the SDK turns an
  // exception escaping the callback into a generic "MCP error ..." envelope,
  // not our own JSON error shape — so this asserts on the envelope text
  // directly rather than via `errorOf`'s `JSON.parse`.
  it('refuses system:"NOPE" with UNKNOWN_SYSTEM, listing the configured aliases, before the wire', async () => {
    const { devClient, qasClient, opts } = twoSystems(adminCfg("DEV"), adminCfg("QAS"));
    const h = await harness(opts, opts.systems![0]!.cfg);
    const res = await call(h, "abap_write", {
      object: "ZMCP_DEMO",
      package: "$TMP",
      mode: "delete",
      system: "NOPE",
    });
    expect(res.isError).toBe(true);
    const text = res.content[0]!.text;
    expect(text).toMatch(/"NOPE"/);
    expect(text).toMatch(/not a configured system/);
    expect(text).toMatch(/DEV/);
    expect(text).toMatch(/QAS/);
    expect(devClient.calls).toHaveLength(0);
    expect(qasClient.calls).toHaveLength(0);
  });
});

describe("alias resolution", () => {
  it("is case-insensitive and trims whitespace", async () => {
    const { qasClient, opts } = twoSystems(adminCfg("DEV"), adminCfg("QAS"));
    const h = await harness(opts, opts.systems![0]!.cfg);
    adt.resolveWriteTarget.mockResolvedValue(WRITE_TARGET);
    adt.deleteObject.mockResolvedValue({
      target: WRITE_TARGET,
      deleted: true,
      transport: { status: "local", required: false },
    });
    const res = await call(h, "abap_write", {
      object: "ZMCP_DEMO",
      package: "$TMP",
      mode: "delete",
      system: "  qas  ",
    });
    expect(res.isError).toBeFalsy();
    expect(qasClient.calls.length).toBeGreaterThan(0);
  });

  it("omitting `system` targets the default system", async () => {
    const { devClient, qasClient, opts } = twoSystems(adminCfg("DEV"), adminCfg("QAS"));
    const h = await harness(opts, opts.systems![0]!.cfg);
    adt.resolveWriteTarget.mockResolvedValue(WRITE_TARGET);
    adt.deleteObject.mockResolvedValue({
      target: WRITE_TARGET,
      deleted: true,
      transport: { status: "local", required: false },
    });
    const res = await call(h, "abap_write", { object: "ZMCP_DEMO", package: "$TMP", mode: "delete" });
    expect(res.isError).toBeFalsy();
    expect(devClient.calls.length).toBeGreaterThan(0);
    expect(qasClient.calls).toHaveLength(0);
  });

  it("a routed call touches only the target system's fake", async () => {
    const { devClient, qasClient, opts } = twoSystems(adminCfg("DEV"), adminCfg("QAS"));
    const h = await harness(opts, opts.systems![0]!.cfg);
    adt.resolveWriteTarget.mockResolvedValue(WRITE_TARGET);
    adt.deleteObject.mockResolvedValue({
      target: WRITE_TARGET,
      deleted: true,
      transport: { status: "local", required: false },
    });
    const res = await call(h, "abap_write", {
      object: "ZMCP_DEMO",
      package: "$TMP",
      mode: "delete",
      system: "QAS",
    });
    expect(res.isError).toBeFalsy();
    expect(qasClient.calls.length).toBeGreaterThan(0);
    expect(devClient.calls).toHaveLength(0);
  });
});

describe("locked refusal stubs under routing", () => {
  it("still refuse (no `system` param on the stub) when every configured system is read-only", async () => {
    const { devClient, qasClient, opts } = twoSystems(readCfg("DEV"), readCfg("QAS"));
    const h = await harness(opts, opts.systems![0]!.cfg);
    const { tools } = await h.client.listTools();
    const write = tools.find((t) => t.name === "abap_write");
    expect(write, "abap_write should still be advertised as a locked stub").toBeDefined();
    const props = (write!.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    // Locked stubs have no inputSchema at all — and route.ts only adds
    // `system` to tools that HAVE a schema, so the stub stays schema-free.
    expect(props === undefined || Object.keys(props).length === 0).toBe(true);

    const res = await call(h, "abap_write", { object: "ZMCP_DEMO", package: "$TMP", mode: "delete" });
    const err = errorOf(res);
    expect(err.error).toBe("READ_ONLY");
    expect(devClient.calls).toHaveLength(0);
    expect(qasClient.calls).toHaveLength(0);
  });
});

describe("per-system resources", () => {
  it("registers one abap://{SID}/system resource per configured system", async () => {
    const { opts } = twoSystems(adminCfg("DEV"), adminCfg("QAS"));
    const h = await harness(opts, opts.systems![0]!.cfg);
    const { resources } = await h.client.listResources();
    const names = resources.map((r) => r.name).sort();
    expect(names).toEqual(["system-dev", "system-qas"]);
    const uris = resources.map((r) => r.uri).sort();
    expect(uris).toEqual(["abap://DEV/system", "abap://QAS/system"]);
  });

  it("a single-system server still registers exactly one resource, named \"system\"", async () => {
    const h = await harness(
      { httpClient: forbiddenClient(), log: () => {}, breaker: new AuthCircuitBreaker() },
      adminCfg("DEV"),
    );
    const { resources } = await h.client.listResources();
    expect(resources).toHaveLength(1);
    expect(resources[0]!.name).toBe("system");
  });
});

describe("abap_debug cross-system guard (SYSTEM_MISMATCH)", () => {
  const START_ARGS = {
    action: "start",
    breakpoints: [{ kind: "line", object: "ZMCP_DEMO", line: 12 }],
    run: { object: "ZMCP_DEMO" },
  };

  it("refuses a non-start debug call routed to a different system than the active session, naming both", async () => {
    const { devClient, qasClient, opts } = twoSystems(adminCfg("DEV"), adminCfg("QAS"));
    const h = await harness(opts, opts.systems![0]!.cfg);

    // Start on the default (DEV) — no `system` param.
    const started = await call(h, "abap_debug", START_ARGS);
    expect(started.isError).toBeFalsy();
    expect(devClient.calls.length).toBeGreaterThan(0);

    vi.clearAllMocks();
    // A non-start action routed to QAS must be refused, not silently
    // stepping/inspecting DEV's session over QAS's connection. `stateId` is
    // a required field on `abap_debug_vars`'s own schema — the cross-system
    // guard (`assertSameSystemAsSession`) runs before it is used for
    // anything, but it must still be present to pass schema validation and
    // reach the handler at all.
    const res = await call(h, "abap_debug_vars", { system: "QAS", stateId: "S1" });
    const err = errorOf(res);
    expect(err.error).toBe("SYSTEM_MISMATCH");
    expect(String(err.message)).toMatch(/"DEV"/);
    expect(String(err.message)).toMatch(/"QAS"/);
    expect((err.details as Record<string, unknown>).sessionSystem).toBe("DEV");
    expect((err.details as Record<string, unknown>).requestedSystem).toBe("QAS");
    // Refused before ever touching QAS.
    expect(qasClient.calls).toHaveLength(0);
  });
});
