/**
 * `abap_read` cross-system `view="diff"` (`from_system`/`to_system`, issue
 * #93) — `registerReadTools`'s `resolveCrossSystemSides`/`runCrossSystemDiff`
 * (src/tools/read.ts, src/tools/read-systems.ts).
 *
 * Registrar-level harness, not `createServer()`: `resolveCrossSystemSides`'s
 * "only one system configured" `BAD_INPUT` branch is unreachable through a
 * real single-system `createServer()` build, because `crossSystemInputSchema`
 * (`from_system`/`to_system`) is only spliced into the registered schema when
 * `deps.multiSystem` is true, and zod silently strips unrecognised keys — a
 * real single-system server's schema never even declares the fields, so the
 * handler never sees them. `createServer()` always keeps `multiSystem` and
 * `systems` in lockstep; this file deliberately decouples them (mirrors
 * `test/activate-affects-preflight.test.ts`'s direct-registrar pattern) to
 * exercise that one guard as a focused unit test of the registrar itself.
 *
 * `resolveObject`/`readSource` (`src/adt/resolve.js`/`src/adt/source.js`) are
 * mocked so no network is ever touched; `diffSources`/`renderHunks`
 * (`src/diff.ts`) and `buildReadResponse` (`src/tools/read.ts`) run for
 * real, so the rendered header/body text is the actual production output,
 * not a stand-in.
 *
 * `SafetyGate.evaluate()` (src/safety.ts ~line 1327) unconditionally allows
 * every `"read"` op (`if (!MUTATING_OPS.has(op)) return { allowed: true, ... }`),
 * so "each side gated by its own SafetyGate" cannot be proven by a genuine
 * denial — instead, each side gets its own spy `safety.assert` fake, and the
 * test proves the CORRECT per-alias gate object is the one consulted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadTools, type ReadToolDeps, type ReadSystemSide } from "../src/tools/read.js";
import { errorResult } from "../src/server.js";
import { ConfigSchema, type Config } from "../src/config.js";
import type { SessionPool } from "../src/adt/pool.js";
import type { SafetyGate } from "../src/safety.js";

const adt = vi.hoisted(() => ({
  resolveObject: vi.fn(),
  readSource: vi.fn(),
}));
// Only `resolveObject`/`readSource` are faked — everything else in these
// modules (pure helpers) stays real, same pattern as test/tools.test.ts.
vi.mock("../src/adt/resolve.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/adt/resolve.js")>()),
  resolveObject: adt.resolveObject,
}));
vi.mock("../src/adt/source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/adt/source.js")>()),
  readSource: adt.readSource,
}));

const cfg = (over: Partial<Config> = {}): Config => ({
  ...ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "TESTUSER",
    password: "secret",
    sid: "DEV",
    client: "100",
    allowTransports: ["*"],
  }),
  ...over,
});

/** One conn-identity per fake side — how the shared mocks tell sides apart. */
interface FakeConn {
  readonly __alias: string;
}

interface FakeSide extends ReadSystemSide {
  readonly assertSpy: ReturnType<typeof vi.fn>;
  readonly ensureConnectedSpy: ReturnType<typeof vi.fn>;
  readonly conn: FakeConn;
}

function fakeSide(alias: string, sid: string, client: string): FakeSide {
  const assertSpy = vi.fn();
  const ensureConnectedSpy = vi.fn(async () => {});
  const conn: FakeConn = { __alias: alias };
  const pool: SessionPool = {
    withRead: (async (_op: string, fn: (c: unknown) => unknown) => fn(conn)) as SessionPool["withRead"],
    withWrite: (async () => {
      throw new Error("not exercised by cross-system diff tests");
    }) as SessionPool["withWrite"],
  } as unknown as SessionPool;
  return {
    alias,
    cfg: cfg({ sid, client }),
    pool,
    safety: { assert: assertSpy } as unknown as SafetyGate,
    ensureConnected: ensureConnectedSpy,
    assertSpy,
    ensureConnectedSpy,
    conn,
  };
}

/** Programs the shared `resolveObject`/`readSource` mocks by conn identity. */
function wireSides(sides: Record<string, { obj: Record<string, unknown>; source: string }>): void {
  const lookup = (alias: string): { obj: Record<string, unknown>; source: string } => {
    const entry = sides[alias];
    if (!entry) throw new Error(`test harness: no wired side data for "${alias}"`);
    return entry;
  };
  adt.resolveObject.mockImplementation(async (conn: FakeConn) => lookup(conn.__alias).obj);
  adt.readSource.mockImplementation(async (conn: FakeConn) => ({ source: lookup(conn.__alias).source }));
}

function systemsOf(sides: Record<string, ReadSystemSide>, defaultAlias: string): NonNullable<ReadToolDeps["systems"]> {
  return {
    aliases: Object.keys(sides),
    resolve: (alias?: string) => {
      const s = sides[alias ?? defaultAlias];
      if (!s) throw new Error(`test harness: no fake side registered for "${alias}"`);
      return s;
    },
  };
}

function baseDeps(over: Partial<ReadToolDeps> = {}): ReadToolDeps {
  return {
    pool: {
      withRead: async () => {
        throw new Error("default (non-routed) pool not exercised by cross-system diff tests");
      },
      withWrite: async () => {
        throw new Error("not exercised");
      },
    } as unknown as SessionPool,
    safety: { assert: vi.fn() } as unknown as SafetyGate,
    ensureConnected: async () => {},
    errorResult,
    cfg: cfg({ sid: "DEV" }),
    multiSystem: true,
    ...over,
  };
}

function harness(deps: ReadToolDeps) {
  const server = new McpServer({ name: "read-cross-system-probe", version: "0.0.0" });
  registerReadTools(server, deps);
  const call = async (args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "read-cross-system-probe", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const res = await client.callTool({ name: "abap_read", arguments: args });
    const first = Array.isArray(res.content) ? res.content[0] : undefined;
    const text = first && typeof first === "object" && "text" in first ? String((first as { text: unknown }).text) : "";
    return { text, isError: res.isError === true };
  };
  const schemaKeys = async (): Promise<string[]> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "read-cross-system-probe", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "abap_read");
    const props = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    return Object.keys(props);
  };
  return { call, schemaKeys };
}

interface ErrorPayload {
  error: string;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

function errorOf(res: { text: string; isError: boolean }): ErrorPayload {
  expect(res.isError).toBe(true);
  return JSON.parse(res.text) as ErrorPayload;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("abap_read cross-system diff: schema presence", () => {
  it("from_system/to_system are advertised only when the server is multi-system", async () => {
    const dev = fakeSide("DEV", "D01", "100");
    const qas = fakeSide("QAS", "Q01", "200");
    const multi = harness(baseDeps({ multiSystem: true, systems: systemsOf({ DEV: dev, QAS: qas }, "DEV") }));
    const single = harness(baseDeps({ multiSystem: false, systems: undefined }));

    const multiKeys = await multi.schemaKeys();
    const singleKeys = await single.schemaKeys();

    expect(multiKeys).toContain("from_system");
    expect(multiKeys).toContain("to_system");
    expect(singleKeys).not.toContain("from_system");
    expect(singleKeys).not.toContain("to_system");
  });
});

describe("abap_read cross-system diff: happy path", () => {
  it("diffs the current active source of the same object on two systems", async () => {
    const dev = fakeSide("DEV", "D01", "100");
    const qas = fakeSide("QAS", "Q01", "200");
    wireSides({
      DEV: {
        obj: { type: "CLAS/OC", name: "ZCL_FOO", system: "D01", packageName: "ZPKG" },
        source: "A\nB\nC\n",
      },
      QAS: {
        obj: { type: "CLAS/OC", name: "ZCL_FOO", system: "Q01", packageName: "ZPKG" },
        source: "A\nX\nC\n",
      },
    });
    const { call } = harness(baseDeps({ systems: systemsOf({ DEV: dev, QAS: qas }, "DEV") }));

    const res = await call({ object: "ZCL_FOO", view: "diff", from_system: "DEV", to_system: "QAS" });

    expect(res.isError).toBe(false);
    expect(res.text).toMatch(/object: ZCL_FOO/);
    expect(res.text).toMatch(/view: diff/);
    expect(res.text).toMatch(/from: DEV \(D01\/100\)/);
    expect(res.text).toMatch(/to: QAS \(Q01\/200\)/);
    expect(res.text).toMatch(/added: 1/);
    expect(res.text).toMatch(/removed: 1/);
    expect(res.text).toMatch(/hunks: 1/);
    expect(res.text).toMatch(/package: ZPKG/);

    // Both sides opened their own connection and asserted their OWN gate —
    // proving per-side wiring, not merely that the default side ran twice.
    expect(dev.ensureConnectedSpy).toHaveBeenCalledTimes(1);
    expect(qas.ensureConnectedSpy).toHaveBeenCalledTimes(1);
    expect(dev.assertSpy).toHaveBeenCalledWith("read");
    expect(qas.assertSpy).toHaveBeenCalledWith("read");
    expect(adt.resolveObject).toHaveBeenCalledTimes(2);
    expect(adt.readSource).toHaveBeenCalledTimes(2);
  });

  it("reports different packages on each side distinctly when they differ", async () => {
    const dev = fakeSide("DEV", "D01", "100");
    const qas = fakeSide("QAS", "Q01", "200");
    wireSides({
      DEV: { obj: { type: "CLAS/OC", name: "ZCL_FOO", system: "D01", packageName: "ZPKG_DEV" }, source: "A\n" },
      QAS: { obj: { type: "CLAS/OC", name: "ZCL_FOO", system: "Q01", packageName: "ZPKG_QAS" }, source: "A\n" },
    });
    const { call } = harness(baseDeps({ systems: systemsOf({ DEV: dev, QAS: qas }, "DEV") }));

    const res = await call({ object: "ZCL_FOO", view: "diff", from_system: "DEV", to_system: "QAS" });

    expect(res.isError).toBe(false);
    expect(res.text).toMatch(/fromPackage: ZPKG_DEV/);
    expect(res.text).toMatch(/toPackage: ZPKG_QAS/);
    expect(res.text).not.toMatch(/^package: /m);
  });

  it("reports 'no differences' when the object is line-for-line identical on both sides", async () => {
    const dev = fakeSide("DEV", "D01", "100");
    const qas = fakeSide("QAS", "Q01", "200");
    wireSides({
      DEV: { obj: { type: "CLAS/OC", name: "ZCL_FOO", system: "D01", packageName: "ZPKG" }, source: "A\nB\nC\n" },
      QAS: { obj: { type: "CLAS/OC", name: "ZCL_FOO", system: "Q01", packageName: "ZPKG" }, source: "A\nB\nC\n" },
    });
    const { call } = harness(baseDeps({ systems: systemsOf({ DEV: dev, QAS: qas }, "DEV") }));

    const res = await call({ object: "ZCL_FOO", view: "diff", from_system: "DEV", to_system: "QAS" });

    expect(res.isError).toBe(false);
    expect(res.text).toMatch(/added: 0/);
    expect(res.text).toMatch(/removed: 0/);
    expect(res.text).toMatch(/no differences: CLAS\/OC ZCL_FOO is line-for-line identical on/);
  });
});

describe("abap_read cross-system diff: refusals", () => {
  it("refuses when the server has only one configured system", async () => {
    // Deliberately decoupled from a real build: multiSystem true (so the
    // schema still declares the fields) but systems undefined (so the
    // runtime guard fires) — see this file's doc comment.
    const { call } = harness(baseDeps({ multiSystem: true, systems: undefined, cfg: cfg({ sid: "DEV" }) }));

    const res = await call({ object: "ZCL_FOO", view: "diff", from_system: "DEV", to_system: "QAS" });

    const err = errorOf(res);
    expect(err.error).toBe("BAD_INPUT");
    expect(err.message).toMatch(/only one configured system \(DEV\)/);
    expect(err.details).toMatchObject({ object: "ZCL_FOO", system: "DEV" });
    expect(adt.resolveObject).not.toHaveBeenCalled();
  });

  it("refuses when view is omitted", async () => {
    const dev = fakeSide("DEV", "D01", "100");
    const qas = fakeSide("QAS", "Q01", "200");
    const { call } = harness(baseDeps({ systems: systemsOf({ DEV: dev, QAS: qas }, "DEV") }));

    const res = await call({ object: "ZCL_FOO", from_system: "DEV", to_system: "QAS" });

    const err = errorOf(res);
    expect(err.error).toBe("BAD_INPUT");
    expect(err.message).toMatch(/no view was requested/);
    expect(adt.resolveObject).not.toHaveBeenCalled();
  });

  it('refuses when view is set to something other than "diff"', async () => {
    const dev = fakeSide("DEV", "D01", "100");
    const qas = fakeSide("QAS", "Q01", "200");
    const { call } = harness(baseDeps({ systems: systemsOf({ DEV: dev, QAS: qas }, "DEV") }));

    const res = await call({ object: "ZCL_FOO", view: "history", from_system: "DEV", to_system: "QAS" });

    const err = errorOf(res);
    expect(err.error).toBe("BAD_INPUT");
    expect(err.message).toMatch(/view="history" was requested instead/);
    expect(adt.resolveObject).not.toHaveBeenCalled();
  });

  it("refuses when `from` (a version selector) is combined with cross-system params", async () => {
    const dev = fakeSide("DEV", "D01", "100");
    const qas = fakeSide("QAS", "Q01", "200");
    const { call } = harness(baseDeps({ systems: systemsOf({ DEV: dev, QAS: qas }, "DEV") }));

    const res = await call({ object: "ZCL_FOO", view: "diff", from: "active", from_system: "DEV", to_system: "QAS" });

    const err = errorOf(res);
    expect(err.error).toBe("BAD_INPUT");
    expect(err.message).toMatch(/from selects a version on one system's history feed/);
    expect(adt.resolveObject).not.toHaveBeenCalled();
  });

  it("refuses when `to` (a version selector) is combined with cross-system params", async () => {
    const dev = fakeSide("DEV", "D01", "100");
    const qas = fakeSide("QAS", "Q01", "200");
    const { call } = harness(baseDeps({ systems: systemsOf({ DEV: dev, QAS: qas }, "DEV") }));

    const res = await call({ object: "ZCL_FOO", view: "diff", to: "active", from_system: "DEV", to_system: "QAS" });

    const err = errorOf(res);
    expect(err.error).toBe("BAD_INPUT");
    expect(err.message).toMatch(/to selects a version on one system's history feed/);
    expect(adt.resolveObject).not.toHaveBeenCalled();
  });

  it("refuses when from_system and to_system both name the same system", async () => {
    const dev = fakeSide("DEV", "D01", "100");
    const { call } = harness(baseDeps({ systems: systemsOf({ DEV: dev }, "DEV") }));

    const res = await call({ object: "ZCL_FOO", view: "diff", from_system: "DEV", to_system: "DEV" });

    const err = errorOf(res);
    expect(err.error).toBe("BAD_INPUT");
    expect(err.message).toMatch(/from_system and to_system both resolved to "DEV"/);
    expect(adt.resolveObject).not.toHaveBeenCalled();
  });

  it.each([
    ["method", { method: "GET_FOO" }],
    ["outline", { outline: true }],
    ["line", { line: 3 }],
    ["column", { column: 0 }],
    ["types", { types: ["CLAS"] }],
    ["depth", { depth: 2 }],
  ] as const)("refuses when %s is combined with a cross-system request", async (param, extra) => {
    const dev = fakeSide("DEV", "D01", "100");
    const qas = fakeSide("QAS", "Q01", "200");
    const { call } = harness(baseDeps({ systems: systemsOf({ DEV: dev, QAS: qas }, "DEV") }));

    const res = await call({ object: "ZCL_FOO", view: "diff", from_system: "DEV", to_system: "QAS", ...extra });

    const err = errorOf(res);
    expect(err.error).toBe("BAD_INPUT");
    expect(err.message).toMatch(new RegExp(`^${param} is not meaningful for a cross-system diff`));
    expect(adt.resolveObject).not.toHaveBeenCalled();
  });
});

describe("abap_read cross-system diff: NOT_FOUND names which side", () => {
  it("names the missing side and sets details.system when the object is missing from one system only", async () => {
    const dev = fakeSide("DEV", "D01", "100");
    const qas = fakeSide("QAS", "Q01", "200");
    wireSides({
      DEV: { obj: { type: "CLAS/OC", name: "ZCL_FOO", system: "D01", packageName: "ZPKG" }, source: "A\n" },
      QAS: { obj: {}, source: "" },
    });
    // QAS's resolveObject throws NOT_FOUND instead of returning — override
    // the blanket wireSides() implementation for QAS's conn identity only.
    const { AbapError } = await import("../src/adt/errors.js");
    adt.resolveObject.mockImplementation(async (conn: FakeConn) => {
      if (conn.__alias === "QAS") {
        throw new AbapError("NOT_FOUND", "ZCL_FOO not found", { name: "ZCL_FOO" });
      }
      return { type: "CLAS/OC", name: "ZCL_FOO", system: "D01", packageName: "ZPKG" };
    });
    const { call } = harness(baseDeps({ systems: systemsOf({ DEV: dev, QAS: qas }, "DEV") }));

    const res = await call({ object: "ZCL_FOO", view: "diff", from_system: "DEV", to_system: "QAS" });

    const err = errorOf(res);
    expect(err.error).toBe("NOT_FOUND");
    expect(err.message).toMatch(/ZCL_FOO was not found on QAS/);
    expect(err.details).toMatchObject({ system: "QAS" });
  });
});
