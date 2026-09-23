/**
 * `../src/adt/fluid/dynamic-bridges.ts` (the classifier/lister for the five
 * per-call generated-ABAP bridge families) plus its wiring into
 * `abap_fluid`'s `status` section and `remove`'s `scope:"dynamic"` sweep
 * (`../src/tools/fluid.ts`). Stub-`AbapConnection` idiom throughout (see
 * `test/ddic.test.ts`), not a full FakeAdt/HTTP harness: `listDynamicBridges`
 * and `removeTargets` only ever call `conn.adt.nodeContents`, and
 * `renderStatus`'s other two probes (`probeRetiredBridges`/`probeInvokers`)
 * degrade safely through `resolveWriteTarget`'s own error handling when
 * `conn.get` throws, so a minimal stub never crashes a full `status` call.
 *
 * Also covers the `op` field's bare-call describe text
 * (`fluidInputSchema.op.description`), which must keep stating the real rule
 * `isBareFluidCall` implements rather than the field list it used to name.
 *
 * The last section is the exception: a full FakeAdt/HTTP harness driving a
 * real `AdtSessionPool` and real `AbapConnection`s, since it is about pool
 * slot reuse and `AbapConnection`'s connection-lifetime logon ceiling, which
 * a bare `adt.nodeContents` stub cannot exercise.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { routeSystemRoleProbe } from "./helpers/system-role-fake.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { Journal } from "../src/journal.js";
import { createSessionPool, type SessionPool } from "../src/adt/pool.js";
import { AbapError } from "../src/adt/errors.js";
import { errorResult } from "../src/server.js";
import {
  registerFluidTool,
  isBareFluidCall,
  fluidInputSchema,
  type FluidToolDeps,
} from "../src/tools/fluid.js";
import { ensureFluidTool, resetFluidEnsureState } from "../src/adt/fluid/ensure.js";
import { FLUID_PACKAGE, resetFluidPackageMemo } from "../src/adt/fluid/package.js";
import {
  manifestVersion,
  type FluidActionSpec,
  type FluidManifest,
  type LoadedFluidTool,
} from "../src/adt/fluid/manifest.js";
import type { FluidToolSet } from "../src/adt/fluid/plugin-loader.js";
import {
  DYNAMIC_BRIDGE_FAMILIES,
  classifyDynamicBridgeName,
  isDynamicBridgeName,
  listDynamicBridges,
} from "../src/adt/fluid/dynamic-bridges.js";
import { BRIDGE_CLASS as ENH_BRIDGE_CLASS } from "../src/adt/enhancement-bridge.js";
import { deleteOneFluidObject } from "../src/adt/fluid/delete.js";

// ============================================================================
// stub AbapConnection — no HTTP, just `adt.nodeContents` (+ a throwing `get`
// for the status tests, so `probeRetiredBridges`/`probeInvokers` degrade
// instead of crashing; see file header).
// ============================================================================

interface Node {
  OBJECT_NAME: string;
  OBJECT_TYPE: string;
}

function nodeContentsConn(nodes: readonly Node[] | (() => readonly Node[])): AbapConnection {
  return {
    cfg: { sid: "A4H" },
    get: async () => {
      throw new Error("stub conn: no source read implemented");
    },
    adt: {
      nodeContents: async () => ({ nodes: typeof nodes === "function" ? nodes() : nodes }),
    },
  } as unknown as AbapConnection;
}

// ============================================================================
// 1. classifyDynamicBridgeName / isDynamicBridgeName — pure, no conn
// ============================================================================

describe("classifyDynamicBridgeName / isDynamicBridgeName", () => {
  it("matches each of the five families by name", () => {
    // The enhancement family's own name(s) are read from BRIDGE_CLASS itself
    // rather than hardcoded here: it names whichever operations still
    // generate a per-call bridge, and that set is enhancement-bridge.ts's
    // call, not this test's.
    const enhCases: ReadonlyArray<[string, string]> = Object.values(ENH_BRIDGE_CLASS).map((name) => [
      name,
      "Enhancement exercise bridges",
    ]);
    const cases: ReadonlyArray<[string, string]> = [
      ["ZCL_ZMCP_BO_A1B2C3D4", "BOPF test bridges"],
      ["ZCL_ZMCP_UI_A1B2C3D4", "UI press bridges"],
      ...enhCases,
      ["ZCL_ZMCP_FPMLK_A1B2C3D4", "FPM lock-mode bridges"],
      ["ZCL_ZMCP_RUN_A1B2C3D4", "Run report bridges"],
    ];
    for (const [name, label] of cases) {
      const family = classifyDynamicBridgeName(name);
      expect(family?.label).toBe(label);
      expect(isDynamicBridgeName(name)).toBe(true);
    }
  });

  it("is case-insensitive and trims surrounding whitespace, like the reserved-name check it sits beside", () => {
    expect(classifyDynamicBridgeName("  zcl_zmcp_bo_a1b2c3d4  ")?.label).toBe("BOPF test bridges");
  });

  it("excludes a fluid invoker class (ZCL_ZMCP_I_xxxxxxxx), which is not a dynamic bridge", () => {
    expect(classifyDynamicBridgeName("ZCL_ZMCP_I_A1B2C3D4")).toBeUndefined();
    expect(isDynamicBridgeName("ZCL_ZMCP_I_A1B2C3D4")).toBe(false);
  });

  it("excludes a static fluid body/runtime class even though it shares the ZCL_ZMCP_ prefix", () => {
    expect(classifyDynamicBridgeName("ZCL_ZMCP_FLUID_CORE")).toBeUndefined();
    expect(isDynamicBridgeName("ZCL_ZMCP_FLUID_CORE")).toBe(false);
  });

  it("excludes a name matching none of the five families", () => {
    expect(classifyDynamicBridgeName("ZCL_SOME_UNRELATED_CLASS")).toBeUndefined();
    expect(isDynamicBridgeName("ZFOO_BAR")).toBe(false);
  });

  it("keeps the closed family table at exactly five entries, one per dynamic-bridge tool path", () => {
    expect(DYNAMIC_BRIDGE_FAMILIES).toHaveLength(5);
    const tools = DYNAMIC_BRIDGE_FAMILIES.map((f) => f.tool);
    expect(new Set(tools).size).toBe(5);
  });
});

// ============================================================================
// 2. listDynamicBridges — stub conn, no HTTP
// ============================================================================

describe("listDynamicBridges", () => {
  it("returns only CLAS/OC members that classify into one of the five families", async () => {
    const conn = nodeContentsConn([
      { OBJECT_NAME: "ZCL_ZMCP_BO_A1B2C3D4", OBJECT_TYPE: "CLAS/OC" },
      { OBJECT_NAME: "ZCL_ZMCP_UI_A1B2C3D4", OBJECT_TYPE: "CLAS/OC" },
      { OBJECT_NAME: "ZCL_ZMCP_I_DEADBEEF", OBJECT_TYPE: "CLAS/OC" }, // invoker, excluded
      { OBJECT_NAME: "ZFOO_BAR", OBJECT_TYPE: "CLAS/OC" }, // unrelated, excluded
      { OBJECT_NAME: "ZCL_ZMCP_UI_A1B2C3D5", OBJECT_TYPE: "PROG/P" }, // right name, wrong type
    ]);

    const bridges = await listDynamicBridges(conn);

    expect(bridges.map((b) => b.name).sort()).toEqual(["ZCL_ZMCP_BO_A1B2C3D4", "ZCL_ZMCP_UI_A1B2C3D4"]);
  });

  it("excludes names in the caller-supplied `exclude` set (a loaded tool's own manifest object)", async () => {
    const conn = nodeContentsConn([
      { OBJECT_NAME: "ZCL_ZMCP_BO_A1B2C3D4", OBJECT_TYPE: "CLAS/OC" },
      { OBJECT_NAME: "ZCL_ZMCP_BO_MANIFESTOBJ", OBJECT_TYPE: "CLAS/OC" },
    ]);

    const bridges = await listDynamicBridges(conn, new Set(["ZCL_ZMCP_BO_MANIFESTOBJ"]));

    expect(bridges.map((b) => b.name)).toEqual(["ZCL_ZMCP_BO_A1B2C3D4"]);
  });

  it("propagates a nodeContents failure rather than swallowing it (caller degrades, per its own doc comment)", async () => {
    const conn = {
      cfg: { sid: "A4H" },
      adt: {
        nodeContents: async () => {
          throw new Error("boom: nodeContents unavailable");
        },
      },
    } as unknown as AbapConnection;

    await expect(listDynamicBridges(conn)).rejects.toThrow("boom: nodeContents unavailable");
  });
});

// ============================================================================
// helper triad — cfg/gate/tool builders, fakeMcp()/registered()/invoke()
// (self-contained per file, modeled on test/fluid-tool.test.ts /
// test/bopf-show-partial-view-caveat.test.ts)
// ============================================================================

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-fluid-dynbridge-"));
  resetFluidEnsureState();
  resetFluidPackageMemo();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function cfg(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
    fluidApi: true,
    stateDir: tmp,
    ...overrides,
  });
}

const gate = (): SafetyGate => new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"] });

const RUN_ACTION: FluidActionSpec = {
  name: "run",
  category: "execute",
  description: "runs the demo action",
  input: { type: "object", properties: {} },
  output: { type: "object" },
};

function makeTool(opts: { id: string; className: string }): LoadedFluidTool {
  const cls = opts.className.toLowerCase();
  const source = `CLASS ${cls} DEFINITION PUBLIC.\nENDCLASS.\nCLASS ${cls} IMPLEMENTATION.\nENDCLASS.`;
  const manifest: FluidManifest = {
    contract: "1.0",
    id: opts.id,
    title: `${opts.id} tool`,
    description: `test fixture for ${opts.id}`,
    objects: [{ name: opts.className, type: "CLAS/OC", description: "demo class", source: { text: source } }],
    entry: opts.className,
    actions: [RUN_ACTION],
  };
  const sources = new Map([[opts.className, source]]);
  return { manifest, origin: "builtin", sources, version: manifestVersion(manifest, sources) };
}

function toolSetOf(...tools: readonly LoadedFluidTool[]): FluidToolSet {
  return { tools: new Map(tools.map((t) => [t.manifest.id, t])), refused: [], warnings: [] };
}

type RegisteredTool = { handler: (args: unknown) => Promise<CallToolResult>; config: unknown };

function fakeMcp(): { mcp: McpServer; tools: Map<string, RegisteredTool> } {
  const tools = new Map<string, RegisteredTool>();
  const mcp = {
    registerTool: (name: string, config: unknown, handler: (args: unknown) => Promise<CallToolResult>) => {
      tools.set(name, { handler, config });
      return {} as unknown;
    },
  } as unknown as McpServer;
  return { mcp, tools };
}

const disabledJournal = new Journal(
  { dir: path.join(os.tmpdir(), "abapsmith-fluid-dynbridge-unused"), enabled: false, maxEntries: 1, maxAgeDays: 1 },
  "TST",
);

function registered(deps: Partial<FluidToolDeps> & Pick<FluidToolDeps, "toolSet">): Map<string, RegisteredTool> {
  const { mcp, tools } = fakeMcp();
  const full: FluidToolDeps = {
    pool: deps.pool ?? ({} as unknown as SessionPool),
    cfg: deps.cfg ?? cfg(),
    safety: deps.safety ?? gate(),
    ensureConnected: deps.ensureConnected ?? (async () => {}),
    errorResult,
    toolSet: deps.toolSet,
    journal: deps.journal ?? disabledJournal,
    ...(deps.warn ? { warn: deps.warn } : {}),
  };
  registerFluidTool(mcp, full);
  return tools;
}

async function invoke(tools: Map<string, RegisteredTool>, args: unknown): Promise<CallToolResult> {
  const entry = tools.get("abap_fluid");
  if (!entry) throw new Error('"abap_fluid" was never registered');
  return entry.handler(args);
}

function okText(result: CallToolResult): string {
  expect(result.isError).toBeFalsy();
  const part = result.content[0];
  if (!part || part.type !== "text") throw new Error("expected a text content part");
  return part.text;
}

function readLeasePool(conn: AbapConnection): SessionPool {
  return {
    withRead: (_op: string, fn: (c: AbapConnection) => Promise<unknown>) => fn(conn),
    withWrite: () => {
      throw new Error("unexpected withWrite: this pool only serves a read-only status probe");
    },
    reserveDebug: () => {
      throw new Error("reserveDebug: not used here");
    },
  } as unknown as SessionPool;
}

// ============================================================================
// 3. abap_fluid op:"status" — the "DYNAMIC BRIDGES" section
// ============================================================================

describe('abap_fluid — op:"status", DYNAMIC BRIDGES section', () => {
  it(
    "lists a populated probe grouped by family with a per-family count, names the tool path, " +
      "carries the remove note, and excludes a manifest object even when its name collides with a family prefix",
    async () => {
      const tool = makeTool({ id: "demo", className: "ZCL_ZMCP_DEMO" });
      const conn = nodeContentsConn([
        { OBJECT_NAME: "ZCL_ZMCP_BO_A1B2C3D4", OBJECT_TYPE: "CLAS/OC" },
        { OBJECT_NAME: "ZCL_ZMCP_BO_MANIFESTCOLLIDE", OBJECT_TYPE: "CLAS/OC" },
        { OBJECT_NAME: "ZCL_ZMCP_UI_A1B2C3D4", OBJECT_TYPE: "CLAS/OC" },
        { OBJECT_NAME: "ZCL_ZMCP_ENH_EXEC", OBJECT_TYPE: "CLAS/OC" },
        { OBJECT_NAME: "ZCL_ZMCP_FPMLK_A1B2C3D4", OBJECT_TYPE: "CLAS/OC" },
        { OBJECT_NAME: "ZCL_ZMCP_RUN_A1B2C3D4", OBJECT_TYPE: "CLAS/OC" },
        { OBJECT_NAME: "ZCL_ZMCP_I_DEADBEEF", OBJECT_TYPE: "CLAS/OC" },
      ]);
      // The tool's own manifest names ZCL_ZMCP_DEMO, but a second manifest
      // object deliberately shares a dynamic-bridge prefix to prove the
      // exclude set (not just the family match) is what keeps it out.
      (tool.manifest.objects as { name: string; type: string; description: string; source: { text: string } }[]).push({
        name: "ZCL_ZMCP_BO_MANIFESTCOLLIDE",
        type: "CLAS/OC",
        description: "manifest object that happens to collide with a dynamic-bridge prefix",
        source: { text: "CLASS zcl_zmcp_bo_manifestcollide DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_zmcp_bo_manifestcollide IMPLEMENTATION.\nENDCLASS." },
      });

      const tools = registered({ toolSet: toolSetOf(tool), pool: readLeasePool(conn) });
      const text = okText(await invoke(tools, { op: "status" }));

      expect(text).toContain("DYNAMIC BRIDGES");
      expect(text).toContain("BOPF test bridges");
      expect(text).toContain("abap_bopf_test");
      expect(text).toContain("Enhancement exercise bridges");
      expect(text).toContain("FPM lock-mode bridges");
      expect(text).toContain("Run report bridges");
      expect(text).toContain("UI press bridges");
      expect(text).toContain('op:"remove" with scope:"dynamic"');
      // Exactly 1 BOPF row, not 2 — proves ZCL_ZMCP_BO_MANIFESTCOLLIDE was excluded.
      const bopfLine = text.split("\n").find((l) => l.includes("BOPF test bridges"));
      expect(bopfLine).toBeDefined();
      expect(bopfLine).toMatch(/\b1\b/);
    },
  );

  it("reports the section as empty when no dynamic-bridge classes exist", async () => {
    const tool = makeTool({ id: "demo", className: "ZCL_ZMCP_DEMO" });
    const conn = nodeContentsConn([]);
    const tools = registered({ toolSet: toolSetOf(tool), pool: readLeasePool(conn) });

    const text = okText(await invoke(tools, { op: "status" }));

    expect(text).toContain("DYNAMIC BRIDGES");
    expect(text).toContain("(none — no per-call dynamic-bridge classes exist)");
  });

  it(
    "degrades the DYNAMIC BRIDGES section independently: an invoker-list success followed by a " +
      "dynamic-bridge nodeContents failure still renders the rest of status",
    async () => {
      const tool = makeTool({ id: "demo", className: "ZCL_ZMCP_DEMO" });
      let call = 0;
      const conn = {
        cfg: { sid: "A4H" },
        get: async () => {
          throw new Error("stub conn: no source read implemented");
        },
        adt: {
          nodeContents: async () => {
            call += 1;
            if (call === 1) return { nodes: [] }; // invoker listing: none
            throw new Error("boom: dynamic-bridge nodeContents unavailable");
          },
        },
      } as unknown as AbapConnection;
      const tools = registered({ toolSet: toolSetOf(tool), pool: readLeasePool(conn) });

      const result = await invoke(tools, { op: "status" });

      expect(result.isError).toBeFalsy();
      const text = okText(result);
      expect(text).toContain("DYNAMIC BRIDGES");
      expect(text).toContain("(probe unavailable: boom: dynamic-bridge nodeContents unavailable)");
      // The invoker section (probed first, and it succeeded) must not have been discarded.
      expect(text).toContain("INVOKER CLASSES");
      expect(text).toContain("(none — no ZCL_ZMCP_I_* invoker classes exist)");
    },
  );

  it("takes exactly one read lease for the whole status probe (all three probes share it)", async () => {
    const tool = makeTool({ id: "demo", className: "ZCL_ZMCP_DEMO" });
    const conn = nodeContentsConn([{ OBJECT_NAME: "ZCL_ZMCP_BO_A1B2C3D4", OBJECT_TYPE: "CLAS/OC" }]);
    const readOps: string[] = [];
    const pool: SessionPool = {
      withRead: (op: string, fn: (c: AbapConnection) => Promise<unknown>) => {
        readOps.push(op);
        return fn(conn);
      },
      withWrite: () => {
        throw new Error("unexpected withWrite for op:\"status\"");
      },
      reserveDebug: () => {
        throw new Error("reserveDebug: not used here");
      },
    } as unknown as SessionPool;
    const tools = registered({ toolSet: toolSetOf(tool), pool });

    okText(await invoke(tools, { op: "status" }));

    expect(readOps).toEqual(["abap_fluid.status"]);
  });
});

// ============================================================================
// 4. abap_fluid op:"remove" scope:"dynamic" — sweep + lease discipline
// ============================================================================

describe('abap_fluid — op:"remove", scope:"dynamic"', () => {
  it(
    "deletes only the classified dynamic-bridge classes, one fresh write lease per object " +
      "(7 objects would exceed LOGON_ENDPOINT_LIFETIME_CEILING (5) on a single held connection), " +
      "leaving invokers/unrelated names/wrong-typed matches alone or reported as unmappable",
    async () => {
      const conn = nodeContentsConn([
        { OBJECT_NAME: "ZCL_ZMCP_BO_A1B2C3D4", OBJECT_TYPE: "CLAS/OC" },
        { OBJECT_NAME: "ZCL_ZMCP_UI_A1B2C3D4", OBJECT_TYPE: "CLAS/OC" },
        { OBJECT_NAME: "ZCL_ZMCP_ENH_EXEC", OBJECT_TYPE: "CLAS/OC" },
        { OBJECT_NAME: "ZCL_ZMCP_FPMLK_A1B2C3D4", OBJECT_TYPE: "CLAS/OC" },
        { OBJECT_NAME: "ZCL_ZMCP_RUN_A1B2C3D4", OBJECT_TYPE: "CLAS/OC" },
        { OBJECT_NAME: "ZCL_ZMCP_I_DEADBEEF", OBJECT_TYPE: "CLAS/OC" }, // invoker, not swept by scope:"dynamic"
        { OBJECT_NAME: "ZFOO_BAR", OBJECT_TYPE: "CLAS/OC" }, // unrelated, not reserved
        { OBJECT_NAME: "ZCL_ZMCP_UI_WEIRD", OBJECT_TYPE: "PROG/P" }, // dynamic-bridge name, unmappable type
      ]);
      const writeOps: string[] = [];
      const pool: SessionPool = {
        withRead: (_op: string, fn: (c: AbapConnection) => Promise<unknown>) => fn(conn),
        withWrite: (op: string) => {
          writeOps.push(op);
          return Promise.reject(new AbapError("NOT_FOUND", "fixture: withWrite stub, no real delete attempted", {}));
        },
        reserveDebug: () => {
          throw new Error("reserveDebug: not used by abap_fluid remove");
        },
      } as unknown as SessionPool;
      const tools = registered({ toolSet: toolSetOf(), pool, ensureConnected: async () => {} });

      const text = okText(await invoke(tools, { op: "remove", scope: "dynamic", confirm: "remove" }));

      expect(writeOps.length).toBe(5);
      expect(writeOps.every((op) => op === "abap_fluid.remove")).toBe(true);
      expect(text).toContain("ZCL_ZMCP_BO_A1B2C3D4");
      expect(text).toContain("ZCL_ZMCP_UI_A1B2C3D4");
      expect(text).toContain("ZCL_ZMCP_ENH_EXEC");
      expect(text).toContain("ZCL_ZMCP_FPMLK_A1B2C3D4");
      expect(text).toContain("ZCL_ZMCP_RUN_A1B2C3D4");
      expect(text).not.toContain("ZCL_ZMCP_I_DEADBEEF");
      expect(text).not.toContain("ZFOO_BAR");
      expect(text).toContain("ZCL_ZMCP_UI_WEIRD (PROG/P)");
    },
  );

  it('requires confirm:"remove" exactly like every other scope', async () => {
    const conn = nodeContentsConn([]);
    const tools = registered({ toolSet: toolSetOf(), pool: readLeasePool(conn) });

    const result = await invoke(tools, { op: "remove", scope: "dynamic" });

    expect(result.isError).toBe(true);
  });
});

// ============================================================================
// 5. scope:"all" already covers dynamic bridges (ZCL_ZMCP_* reserved names)
// ============================================================================

describe('abap_fluid — op:"remove", scope:"all" already covers dynamic bridges', () => {
  it("sweeps the same five dynamic-bridge classes as scope:\"dynamic\" would, via the reserved-name filter alone", async () => {
    const fiveDynamicBridges: Node[] = [
      { OBJECT_NAME: "ZCL_ZMCP_BO_A1B2C3D4", OBJECT_TYPE: "CLAS/OC" },
      { OBJECT_NAME: "ZCL_ZMCP_UI_A1B2C3D4", OBJECT_TYPE: "CLAS/OC" },
      { OBJECT_NAME: "ZCL_ZMCP_ENH_EXEC", OBJECT_TYPE: "CLAS/OC" },
      { OBJECT_NAME: "ZCL_ZMCP_FPMLK_A1B2C3D4", OBJECT_TYPE: "CLAS/OC" },
      { OBJECT_NAME: "ZCL_ZMCP_RUN_A1B2C3D4", OBJECT_TYPE: "CLAS/OC" },
    ];
    // Confirm every dynamic-bridge family prefix is itself a reserved
    // (ZCL_ZMCP_*/ZIF_ZMCP_*) name — the structural reason scope:"all" needs
    // no dynamic-bridge-specific logic of its own.
    for (const n of fiveDynamicBridges) {
      expect(isDynamicBridgeName(n.OBJECT_NAME)).toBe(true);
      expect(n.OBJECT_NAME.toUpperCase().startsWith("ZCL_ZMCP_")).toBe(true);
    }

    async function countWriteLeases(scope: "dynamic" | "all"): Promise<number> {
      const conn = nodeContentsConn(fiveDynamicBridges);
      const writeOps: string[] = [];
      const pool: SessionPool = {
        withRead: (_op: string, fn: (c: AbapConnection) => Promise<unknown>) => fn(conn),
        withWrite: (op: string) => {
          writeOps.push(op);
          return Promise.reject(new AbapError("NOT_FOUND", "fixture", {}));
        },
        reserveDebug: () => {
          throw new Error("reserveDebug: not used by abap_fluid remove");
        },
      } as unknown as SessionPool;
      const tools = registered({ toolSet: toolSetOf(), pool, ensureConnected: async () => {} });
      okText(await invoke(tools, { op: "remove", scope, confirm: "remove" }));
      return writeOps.length;
    }

    const dynamicCount = await countWriteLeases("dynamic");
    const allCount = await countWriteLeases("all");

    expect(dynamicCount).toBe(5);
    expect(allCount).toBe(5);
  });
});

// ============================================================================
// 6. bare-call describe text must state isBareFluidCall's real rule
// ============================================================================

describe("abap_fluid — op field describe text vs. isBareFluidCall's actual rule", () => {
  it("does not claim args/confirm/corr_nr/scope affect bare-call detection (the old, wrong text did)", () => {
    const text = fluidInputSchema.op.description ?? "";
    expect(text).not.toMatch(/tool\/action\/args\/confirm\/corr_nr\/scope/);
  });

  it("names op/tool/action as the fields that decide it", () => {
    const text = fluidInputSchema.op.description ?? "";
    expect(text).toContain("`op`");
    expect(text).toContain("`tool`");
    expect(text).toContain("`action`");
  });

  it("isBareFluidCall treats args/confirm/corr_nr/scope as irrelevant — only op/tool/action decide bareness", () => {
    expect(isBareFluidCall({})).toBe(true);
    expect(isBareFluidCall({ args: { x: 1 } })).toBe(true);
    expect(isBareFluidCall({ confirm: "remove" })).toBe(true);
    expect(isBareFluidCall({ corr_nr: "X" })).toBe(true);
    expect(isBareFluidCall({ scope: "all" })).toBe(true);
    expect(isBareFluidCall({ tool: "demo" })).toBe(false);
    expect(isBareFluidCall({ action: "run" })).toBe(false);
    expect(isBareFluidCall({ op: "list" })).toBe(false);
  });

  it(
    "end-to-end: a call carrying only args/confirm/corr_nr/scope (no op/tool/action) still returns " +
      "the catalogue, not a run attempt, matching isBareFluidCall/the describe text and contradicting " +
      "the old text's claim",
    async () => {
      const tool = makeTool({ id: "demo", className: "ZCL_ZMCP_DEMO" });
      const tools = registered({ toolSet: toolSetOf(tool) });

      const text = okText(
        await invoke(tools, { args: { note: "x" }, confirm: "remove", corr_nr: "X", scope: "all" }),
      );

      const lines = text.split("\n").filter((l) => l.length > 0);
      expect(lines[lines.length - 1]).toMatch(/^NEXT:/); // the bare-call catalogue's own trailing line
    },
  );
});

// ============================================================================
// 7. abap_fluid — op:"repair" batch vs. LOGON_ENDPOINT_LIFETIME_CEILING
// (sibling-agent Finding B: the whole-batch repair loop must retire each
// tool's connection, not just take a separate lease per tool)
// ============================================================================

interface Recorded {
  label: string;
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

type Route = (r: Recorded) => HttpClientResponse | undefined;

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
  get logins(): number {
    return this.calls.filter((c) => c.url.includes(LOGIN_URL)).length;
  }
}

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };
const LOGIN_URL = "compatibility/graph";

const LOCK_XML = (handle = "H1") =>
  `<asx:abap version="1.0" xmlns:asx="http://www.sap.com/abapxml"><asx:values><DATA>` +
  `<LOCK_HANDLE>${handle}</LOCK_HANDLE><CORRNR/><CORRUSER/><CORRTEXT/>` +
  `<IS_LOCAL>X</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT/>` +
  `</DATA></asx:values></asx:abap>`;

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  return undefined;
}

const classUri = (name: string): string => `/sap/bc/adt/oo/classes/${name.toLowerCase()}`;
const classSrc = (name: string): string => `${classUri(name)}/source/main`;
const CLS_COLLECTION = "/sap/bc/adt/oo/classes";
const PKG_URI = "/sap/bc/adt/packages/%24abapsmith_fluid_api";
const PACKAGES = "/sap/bc/adt/packages";

const notFoundXml = (name: string): string =>
  `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
  `<namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>` +
  `<message lang="EN">${name} does not exist</message><properties/></exc:exception>`;

const PACKAGE_XML = (name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<pak:package xmlns:pak="http://www.sap.com/adt/packages" ` +
  `xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${name}" adtcore:type="DEVC/K">` +
  `<adtcore:packageRef adtcore:name="${name}" adtcore:type="DEVC/K"/>` +
  `<pak:superPackage/>` +
  `</pak:package>`;

function classDocXml(className: string, opts: { mainVersion?: string; packageName?: string } = {}): string {
  const root = "active";
  const main = opts.mainVersion ?? root;
  const pkg = opts.packageName ?? "$TMP";
  const ver = (v: string) => ` adtcore:version="${v}"`;
  const inc = (type: string, version: string) =>
    `<class:include class:includeType="${type}" ` +
    `abapsource:sourceUri="${type === "main" ? "source/main" : `includes/${type}`}" ` +
    `adtcore:name="" adtcore:type="CLAS/I"${ver(version)}/>`;
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<class:abapClass adtcore:name="${className}" adtcore:type="CLAS/OC"${ver(root)} ` +
    `xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core" ` +
    `xmlns:abapsource="http://www.sap.com/adt/abapsource">` +
    `<adtcore:packageRef adtcore:name="${pkg}"/>` +
    inc("definitions", "active") +
    inc("implementations", "active") +
    inc("macros", "active") +
    inc("main", main) +
    `</class:abapClass>`
  );
}

const CHECKRUN_CLEAN =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:atom="http://www.w3.org/2005/Atom"/>`;

interface ObjState {
  exists: boolean;
  packageName: string;
  source?: string;
  active: boolean;
}

function makeStore(entries: Record<string, Partial<ObjState>>): Record<string, ObjState> {
  const store: Record<string, ObjState> = {};
  for (const [name, e] of Object.entries(entries)) {
    store[name.toUpperCase()] = { exists: false, packageName: "$TMP", active: false, ...e };
  }
  return store;
}

/**
 * Serves the package/class/checkrun/activation/lock choreography
 * `ensureFluidTool` needs, over every class in `store`, plus a catch-all 404
 * for any other `oo/classes` GET: `reapRetiredBridges`'s probe (run
 * unconditionally by the whole-batch `repair` path, since it uses
 * `resolveWriteTarget` against its own fixed twelve names) checks names none
 * of which this fixture ever seeds, so they must read back as "does not
 * exist" rather than "unrouted request".
 */
function fluidRoute(store: Record<string, ObjState>): Route {
  return (r) => {
    if (r.url === PKG_URI && r.method === "GET") return resp(200, PACKAGE_XML(FLUID_PACKAGE), OK_XML);
    if (r.url === PACKAGES && r.method === "POST") return resp(200, "", OK_TEXT);

    if (r.url === CLS_COLLECTION && r.method === "POST") {
      const m = /adtcore:name="([^"]+)"/.exec(r.body ?? "");
      const name = (m?.[1] ?? "").toUpperCase();
      const prior = store[name];
      store[name] = { exists: true, packageName: FLUID_PACKAGE, source: prior?.source, active: false };
      return resp(200, "", OK_TEXT);
    }

    if (r.url.startsWith("/sap/bc/adt/checkruns") && r.method === "POST") return resp(200, CHECKRUN_CLEAN, OK_XML);
    if (r.url === "/sap/bc/adt/activation" && r.method === "POST") {
      const m = /adtcore:name="([^"]+)"/.exec(r.body ?? "");
      const name = (m?.[1] ?? "").toUpperCase();
      const st = store[name];
      if (st) st.active = true;
      return resp(200, "", OK_TEXT);
    }

    for (const [name, st] of Object.entries(store)) {
      const uri = classUri(name);
      const src = classSrc(name);
      if (r.url === uri && r.method === "GET" && !r.qs._action) {
        if (!st.exists) return resp(404, notFoundXml(name), OK_XML);
        return resp(
          200,
          classDocXml(name, { packageName: st.packageName, mainVersion: st.active ? "active" : "inactive" }),
          OK_XML,
        );
      }
      if (r.url === src && r.method === "GET") {
        if (!st.exists || st.source === undefined) return resp(404, notFoundXml(name), OK_XML);
        return resp(200, st.source, OK_TEXT);
      }
      if (r.url === uri && r.qs._action === "LOCK") return resp(200, LOCK_XML(), OK_XML);
      if (r.url === uri && r.qs._action === "UNLOCK") return resp(200, "", OK_TEXT);
      if (r.url === src && r.method === "PUT") {
        st.source = r.body ?? "";
        st.exists = true;
        st.active = false;
        return resp(200, "", OK_TEXT);
      }
      if (r.url === uri && r.method === "DELETE") {
        st.exists = false;
        st.source = undefined;
        return resp(200, "", OK_TEXT);
      }
    }
    if (r.url.startsWith(`${CLS_COLLECTION}/`) && r.method === "GET" && !r.qs._action) {
      const name = r.url.slice(CLS_COLLECTION.length + 1).toUpperCase();
      return resp(404, notFoundXml(name), OK_XML);
    }
    return undefined;
  };
}

/**
 * Live capture shape, same as `fluid-ensure.test.ts`'s own
 * `ICMENOSESSION_RESPONSE`: a 400 whose body fails to parse as ADT XML.
 */
const ICMENOSESSION_RESPONSE = (): HttpClientResponse =>
  resp(400, "Session Timed Out — ICM: no session (not XML)", {
    "content-type": "text/html",
    "x-sap-icm-err-id": "ICMENOSESSION",
    "sap-err-id": "ICMENOSESSION",
  });

/**
 * `fluidRoute`, but the class-path GET for any name in `classNames` dies once
 * with the session-death shape, the first time it is asked for after that
 * same class has been deleted — generalizes `fluid-ensure.test.ts`'s
 * single-class `fluidRouteSessionDies` to a whole batch, since this
 * section's point is what happens when several tools in the same repair
 * batch each need exactly one revive.
 */
function fluidRouteDies(store: Record<string, ObjState>, classNames: readonly string[]): Route {
  const inner = fluidRoute(store);
  const deletedOnce = new Set<string>();
  const diedOnce = new Set<string>();
  return (r) => {
    const del = classNames.find((n) => r.method === "DELETE" && r.url === classUri(n));
    if (del) {
      deletedOnce.add(del);
      return inner(r);
    }
    const dying = classNames.find(
      (n) => deletedOnce.has(n) && !diedOnce.has(n) && r.url === classUri(n) && r.method === "GET" && !r.qs._action,
    );
    if (dying) {
      diedOnce.add(dying);
      return ICMENOSESSION_RESPONSE();
    }
    return inner(r);
  };
}

async function connected(route: Route): Promise<{ conn: AbapConnection; adt: FakeAdt }> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(cfg(), {
    httpClient: routeSystemRoleProbe(adt, { answer: "nonproductive" }),
    log: () => {},
    breaker: new AuthCircuitBreaker(),
  });
  await conn.connect();
  return { conn, adt };
}

function sourceFor(name: string): string {
  const cls = name.toLowerCase();
  return `CLASS ${cls} DEFINITION PUBLIC.\nENDCLASS.\nCLASS ${cls} IMPLEMENTATION.\nENDCLASS.`;
}

/** One legacy object per name, sitting in `$TMP` (`ensureFluidTool`'s "legacy" repair branch: relocate into `FLUID_PACKAGE`). */
function legacyStore(names: readonly string[]): Record<string, ObjState> {
  return makeStore(
    Object.fromEntries(names.map((n) => [n, { exists: true, packageName: "$TMP", source: sourceFor(n), active: true }])),
  );
}

function legacyTool(name: string): LoadedFluidTool {
  return makeTool({ id: name, className: name });
}

const LEGACY_NAMES = ["ZCL_ZMCP_LEGACY01", "ZCL_ZMCP_LEGACY02", "ZCL_ZMCP_LEGACY03", "ZCL_ZMCP_LEGACY04", "ZCL_ZMCP_LEGACY05"];

describe('abap_fluid — op:"repair" batch vs. LOGON_ENDPOINT_LIFETIME_CEILING (Finding B)', () => {
  it(
    "counterfactual: sharing ONE connection across 5 legacy tools genuinely breaches the ceiling " +
      "(proves the described bug is real, not merely plausible)",
    async () => {
      const store = legacyStore(LEGACY_NAMES);
      const { conn } = await connected(fluidRouteDies(store, LEGACY_NAMES));

      let succeeded = 0;
      let caught: unknown;
      for (const name of LEGACY_NAMES) {
        try {
          const result = await ensureFluidTool(conn, gate(), cfg(), legacyTool(name), {
            tool: name,
            action: "(repair)",
            op: "repair",
          });
          expect(result.deployed).toBe(true);
          succeeded += 1;
        } catch (e) {
          caught = e;
          break;
        }
      }

      // 1 login for connect() + 4 revives (one per successfully relocated
      // tool) reaches the ceiling (5) exactly on the 5th tool's own revive.
      expect(succeeded).toBe(4);
      expect(caught).toBeInstanceOf(AbapError);
      const err = caught as AbapError;
      expect(err.code).toBe("LOGON_CEILING");
      expect(err.details?.reason).toBe("logon-ceiling-exceeded");
    },
  );

  it(
    'fixed: the real runRepair (whole batch, no `tool`) retires each tool\'s connection after its ' +
      "own ensure pass, so 5 legacy tools mint 5 distinct connections and no connection's logins " +
      "approach the ceiling",
    async () => {
      const store = legacyStore(LEGACY_NAMES);
      const route = fluidRouteDies(store, LEGACY_NAMES);
      const created: FakeAdt[] = [];
      const pool = createSessionPool({
        cfg: cfg(),
        breaker: new AuthCircuitBreaker(),
        createConnection: (poolCfg, poolOpts) => {
          const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
          created.push(adt);
          return new AbapConnection(poolCfg, {
            httpClient: routeSystemRoleProbe(adt, { answer: "nonproductive" }),
            breaker: poolOpts.breaker,
          });
        },
        prepareConnection: async (conn) => {
          await conn.connect();
        },
      });

      const tools = registered({
        toolSet: toolSetOf(...LEGACY_NAMES.map(legacyTool)),
        pool,
        cfg: cfg(),
      });

      const text = okText(await invoke(tools, { op: "repair" }));

      for (const name of LEGACY_NAMES) {
        expect(text).toContain(`version ${legacyTool(name).version}, deployed: true`);
      }

      // One connection per tool's own ensure pass, plus one more for the
      // reap pass runRepair always runs afterward for a whole-batch repair
      // (its own probe lease, since reapRetiredBridges never shares a
      // connection with the tool loop either).
      expect(created.length).toBe(LEGACY_NAMES.length + 1);
      for (const adt of created) expect(adt.logins).toBeLessThanOrEqual(2);
      const totalLogins = created.reduce((n, adt) => n + adt.logins, 0);
      expect(totalLogins).toBe(2 * LEGACY_NAMES.length + 1);

      await pool.shutdown("test done");
    },
  );
});

// ============================================================================
// 8. abap_fluid — op:"remove" delete-loop lease discipline vs.
// LOGON_ENDPOINT_LIFETIME_CEILING (sibling-agent follow-up to Finding B):
// every delete's own post-delete verify read-back revives the session once
// (see delete.ts's doc comment — deleting a class kills the session, so
// the read-back that confirms it is gone is what actually hits
// ICMENOSESSION), so a sweep of 6+ targets is the same shape that broke the
// pre-fix `repair` batch. Unlike `repair` before its fix, `remove` already
// took one fresh `withWrite` lease per target from the start (see the
// comment at its call site, fluid.ts ~863) — this section checks empirically
// whether that alone is enough, or whether it also needs `runRepair`'s
// explicit `conn.markDead()`.
// ============================================================================

/**
 * `fluidRouteDies`, but keyed to the CONTENT read (`classSrc`) rather than
 * the class-doc GET (`classUri`) `fluidRouteDies` dies on. `classSrc` is
 * what `deleteObject`'s post-delete `verifyObjectDeleted` read-back actually
 * requests for a CLAS/OC target — see `contentUri`/`usesObjectUriForContent`
 * in `src/adt/write.ts`, which route CLAS/OC to `t.sourceUri`, not the
 * object URI `fluidRouteDies` targets. Same one-shot-per-name death shape
 * otherwise.
 */
function fluidRouteDiesOnContentRead(store: Record<string, ObjState>, classNames: readonly string[]): Route {
  const inner = fluidRoute(store);
  const deletedOnce = new Set<string>();
  const diedOnce = new Set<string>();
  return (r) => {
    const del = classNames.find((n) => r.method === "DELETE" && r.url === classUri(n));
    if (del) {
      deletedOnce.add(del);
      return inner(r);
    }
    const dying = classNames.find(
      (n) => deletedOnce.has(n) && !diedOnce.has(n) && r.url === classSrc(n) && r.method === "GET",
    );
    if (dying) {
      diedOnce.add(dying);
      return ICMENOSESSION_RESPONSE();
    }
    return inner(r);
  };
}

/** One pre-existing object per name, ready to delete. */
function deletableStore(names: readonly string[]): Record<string, ObjState> {
  return makeStore(
    Object.fromEntries(
      names.map((n) => [n, { exists: true, packageName: FLUID_PACKAGE, source: sourceFor(n), active: true }]),
    ),
  );
}

/**
 * A single tool whose manifest lists every one of `names` as its own
 * object, so `scope:"tool"` deletes all of them straight off the manifest —
 * no `nodeContents` round trip needed (see `removeTargets`'s own doc
 * comment), which keeps this fixture to the class CRUD `fluidRoute` already
 * serves.
 */
function makeMultiObjectTool(id: string, names: readonly string[]): LoadedFluidTool {
  // Explicit, not asserted away: an empty `names` would mint a manifest with
  // no `entry` object, which `noUncheckedIndexedAccess` correctly flags at
  // `names[0]` — a `names[0]!`/`as string` here would silence exactly the
  // check that would catch a fixture built from an empty list.
  const first = names[0];
  if (first === undefined) {
    throw new Error(`makeMultiObjectTool(${id}): names must be non-empty (a fluid manifest needs an entry object)`);
  }
  const sources = new Map(names.map((n) => [n, sourceFor(n)]));
  const manifest: FluidManifest = {
    contract: "1.0",
    id,
    title: `${id} tool`,
    description: `test fixture for ${id}`,
    objects: names.map((n) => ({
      name: n,
      type: "CLAS/OC" as const,
      description: "demo class",
      source: { text: sourceFor(n) },
    })),
    entry: first,
    actions: [RUN_ACTION],
  };
  return { manifest, origin: "builtin", sources, version: manifestVersion(manifest, sources) };
}

const DELETE_NAMES = [
  "ZCL_ZMCP_BO_D0000001",
  "ZCL_ZMCP_BO_D0000002",
  "ZCL_ZMCP_BO_D0000003",
  "ZCL_ZMCP_BO_D0000004",
  "ZCL_ZMCP_BO_D0000005",
  "ZCL_ZMCP_BO_D0000006",
  "ZCL_ZMCP_BO_D0000007",
];

describe('abap_fluid — op:"remove" delete-loop lease discipline vs. LOGON_ENDPOINT_LIFETIME_CEILING', () => {
  it(
    "counterfactual: deleting 7 objects on ONE shared connection (bypassing the pool's per-lease " +
      "isolation entirely) already reaches the ceiling — same hazard shape as Finding B's repair " +
      "counterfactual, confirming the danger `remove`'s per-target lease exists to avoid is real",
    async () => {
      const store = deletableStore(DELETE_NAMES);
      const { conn } = await connected(fluidRouteDiesOnContentRead(store, DELETE_NAMES));

      const results: Array<{ name: string; deleted: boolean | "unverified" }> = [];
      let caught: unknown;
      for (const name of DELETE_NAMES) {
        try {
          const del = await deleteOneFluidObject(conn, gate(), { type: "CLAS/OC", name }, false);
          results.push({ name, deleted: del.deleted });
        } catch (e) {
          caught = e;
          break;
        }
      }

      // Observed, not assumed (this replaced an earlier, wrong hand-guess —
      // see the comment above the `it` name): 1 login for the initial
      // `connect()` in `connected()`, then one hidden revive per delete's
      // post-delete verify (`probeObjectPresence`'s internal `conn.connect()`
      // on the ICMENOSESSION this fixture's one-shot content-read death
      // simulates). Deletes 1-4 each cost one revive, taking the shared
      // connection's logon count from 1 to 4 — every one of those verifies
      // succeeds outright, so all four report `deleted: true`. Delete 5's own
      // revive is the one that would be the connection's 5th logon: that is
      // exactly `LOGON_ENDPOINT_LIFETIME_CEILING`, so `AbapConnection.connect()`
      // itself refuses it and self-marks the connection dead — but
      // `probeObjectPresence`/`verifyObjectDeleted` absorb that refusal
      // internally (documented never-throws contract), so delete 5 itself
      // still reports as a degraded `"unverified"` outcome, not a thrown
      // error. The connection is now permanently condemned, though
      // ("can never log on again" — there is no revive left to absorb), so
      // delete 6 — the next one to actually touch that same connection —
      // throws the condemned/`SESSION_DEAD` error straight out of
      // `deleteOneFluidObject`, and the loop stops there. This IS the
      // counterfactual: reusing one connection across a whole delete batch
      // does not just quietly degrade a couple of results, it eventually
      // hard-fails the batch outright — exactly the hazard shape `remove`'s
      // per-target lease (see the next test) exists to avoid.
      expect(caught).toBeDefined();
      const err = caught as { code?: string; details?: { condemned?: boolean } };
      expect(err.code).toBe("SESSION_DEAD");
      expect(err.details?.condemned).toBe(true);
      expect(results.length).toBe(5);
      expect(results.filter((r) => r.deleted === true).length).toBe(4);
      expect(results.filter((r) => r.deleted === "unverified").length).toBe(1);
      expect(results[4]?.deleted).toBe("unverified");
    },
  );

  it(
    "fixed-shape (no fix needed): the real runRemove sweeps the same 7 targets past the ceiling " +
      "cleanly through the pool — every target reports \"deleted\", the pool mints a fresh " +
      "connection once the shared one nears the ceiling on its own (no explicit `conn.markDead()` " +
      "call anywhere in runRemove, unlike the fixed runRepair), and no connection's own login " +
      "count is ever let past LOGON_ENDPOINT_LIFETIME_CEILING",
    async () => {
      const store = deletableStore(DELETE_NAMES);
      const route = fluidRouteDiesOnContentRead(store, DELETE_NAMES);
      const created: FakeAdt[] = [];
      const pool = createSessionPool({
        cfg: cfg(),
        breaker: new AuthCircuitBreaker(),
        createConnection: (poolCfg, poolOpts) => {
          const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
          created.push(adt);
          return new AbapConnection(poolCfg, {
            httpClient: routeSystemRoleProbe(adt, { answer: "nonproductive" }),
            breaker: poolOpts.breaker,
          });
        },
        prepareConnection: async (conn) => {
          await conn.connect();
        },
      });

      const tool = makeMultiObjectTool("multidel", DELETE_NAMES);
      const tools = registered({ toolSet: toolSetOf(tool), pool, cfg: cfg() });

      const text = okText(
        await invoke(tools, { op: "remove", scope: "tool", tool: "multidel", confirm: "remove" }),
      );

      for (const name of DELETE_NAMES) {
        expect(text).toContain(name);
      }
      expect(text).not.toContain("failed");

      // Observed, not guessed: with a pool-backed run (unlike the shared-
      // connection counterfactual above), the pool mints a fresh connection
      // for every one of the 7 targets — `created.length` is exactly 7, each
      // logging in exactly twice (1 initial `connect()` + 1 hidden revive
      // from that target's own one-shot post-delete verify death). No
      // connection's login count ever gets anywhere near
      // `LOGON_ENDPOINT_LIFETIME_CEILING` (5); the highest observed is 2.
      // This is a stronger result than "at least one rollover" — it shows
      // `runRemove`'s per-target lease keeps every connection's lifetime
      // login count pinned far below the ceiling, not just under it.
      expect(created.length).toBe(DELETE_NAMES.length);
      for (const adt of created) expect(adt.logins).toBe(2);

      await pool.shutdown("test done");
    },
  );
});
