/**
 * `src/adt/fluid/describe.ts` — the three pure renderers of a loaded fluid
 * tool set: `buildFluidDescription` (the MCP tool description / route
 * index), `buildFluidDescribe` (the `op:"describe"` schema payload), and
 * `buildFluidInfoBlock` (the empty-call info block). All three are pure
 * functions of a `FluidToolSet`, so every fixture here is hand-built —
 * no connection, no fake ADT server, no built-in tool ids or action names
 * (another slice adds those; asserting against them would make these tests
 * red for no reason of this slice's own).
 */
import { describe, expect, it } from "vitest";

import { ConfigSchema, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import {
  manifestVersion,
  type FluidActionSpec,
  type FluidManifest,
  type LoadedFluidTool,
} from "../src/adt/fluid/manifest.js";
import type { FluidToolSet, RefusedFluidPlugin } from "../src/adt/fluid/plugin-loader.js";
import {
  buildFluidDescribe,
  buildFluidDescription,
  buildFluidInfoBlock,
} from "../src/adt/fluid/describe.js";

// --- fixtures ---

/**
 * `abapMode` is not a `ConfigSchema` field — `loadConfig` splices it onto
 * `Config` after parsing (see `src/config.ts`) — so `ConfigSchema.parse`
 * would silently strip it from the input object. Apply it after parsing,
 * the same way `loadConfig` does.
 */
function cfg(overrides: Partial<Config> = {}): Config {
  const { abapMode, ...schemaOverrides } = overrides;
  const parsed = ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: false,
    fluidApi: true,
    ...schemaOverrides,
  }) as Config;
  return abapMode !== undefined ? { ...parsed, abapMode } : parsed;
}

const gate = (): SafetyGate =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"] });

const RUN_ACTION: FluidActionSpec = {
  name: "run",
  category: "execute",
  description: "runs the demo action",
  input: { type: "object", properties: { note: { type: "string" } } },
  output: { type: "object" },
};

function makeTool(opts: {
  id: string;
  className: string;
  origin?: "builtin" | "plugin";
  actions?: readonly FluidActionSpec[];
}): LoadedFluidTool {
  const cls = opts.className.toLowerCase();
  const source = `CLASS ${cls} DEFINITION PUBLIC.\nENDCLASS.\nCLASS ${cls} IMPLEMENTATION.\nENDCLASS.`;
  const manifest: FluidManifest = {
    contract: "1.0",
    id: opts.id,
    title: `${opts.id} tool`,
    description: `test fixture for ${opts.id}`,
    objects: [{ name: opts.className, type: "CLAS/OC", description: "demo class", source: { text: source } }],
    entry: opts.className,
    actions: opts.actions ?? [RUN_ACTION],
  };
  const sources = new Map([[opts.className, source]]);
  return {
    manifest,
    origin: opts.origin ?? "builtin",
    sources,
    version: manifestVersion(manifest, sources),
  };
}

function toolSetOf(
  tools: readonly LoadedFluidTool[],
  opts: { refused?: readonly RefusedFluidPlugin[]; warnings?: readonly string[] } = {},
): FluidToolSet {
  return {
    tools: new Map(tools.map((t) => [t.manifest.id, t])),
    refused: opts.refused ?? [],
    warnings: opts.warnings ?? [],
  };
}

/** N actions, all with distinct, easily-greppable names. */
function manyActions(n: number): FluidActionSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `act_${String(i).padStart(3, "0")}`,
    category: (["read", "execute", "mutate"] as const)[i % 3]!,
    description: `action number ${i}`,
    input: { type: "object", properties: { n: { type: "number" } } },
    output: { type: "object", properties: { ok: { type: "boolean" } } },
  }));
}

const TARGETED_ACTION: FluidActionSpec = {
  name: "targeted",
  category: "mutate",
  description: "an action that declares targets",
  input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  output: { type: "object", properties: { name: { type: "string" } } },
  targets: { object: "some_object", package: "$TMP" },
};

// --- 1. route-index completeness ---

describe("buildFluidDescription route index completeness", () => {
  it("includes every action of every tool, with no elision marker, however many actions a tool carries", () => {
    const tools = [
      makeTool({ id: "small", className: "ZCL_ZMCP_X_SMALL", actions: [RUN_ACTION] }),
      makeTool({ id: "big", className: "ZCL_ZMCP_X_BIG", actions: manyActions(40) }),
      makeTool({ id: "mid", className: "ZCL_ZMCP_X_MID", actions: manyActions(5) }),
    ];
    const toolSet = toolSetOf(tools);

    const out = buildFluidDescription(toolSet);

    // Derived from the tool set itself — not a hand-picked subset — so every
    // tool's actions are checked, not just the biggest one's.
    for (const tool of tools) {
      for (const action of tool.manifest.actions) {
        expect(out).toContain(`${action.name} (${action.category})`);
      }
    }
    expect(out).not.toMatch(/\+\d+ more/);
    expect(out).not.toMatch(/…/);
    expect(out).not.toMatch(/and \d+ others?/i);
    expect(out).not.toMatch(/\.\.\./);
  });
});

// --- 2. plugin vs builtin labelling ---

describe("buildFluidDescription origin labelling", () => {
  it("labels a plugin-origin tool (plugin) in the route index, and a builtin-origin tool plainly", () => {
    const builtin = makeTool({ id: "bltn", className: "ZCL_ZMCP_X_BLTN", origin: "builtin" });
    const plugin = makeTool({ id: "plg", className: "ZCL_ZMCP_X_PLG", origin: "plugin" });
    const out = buildFluidDescription(toolSetOf([builtin, plugin]));

    expect(out).toContain("plg (plugin):");
    expect(out).toContain("bltn:");
    expect(out).not.toContain("bltn (plugin)");
  });
});

// --- 3. refused plugins ---

describe("refused plugins", () => {
  const refusal: RefusedFluidPlugin = {
    path: "/plugins/bad-one",
    id: "badone",
    code: "FLUID_MANIFEST_INVALID",
    reason: "fluid-plugin.json failed schema validation: id: invalid",
  };

  it("never appear in the route index", () => {
    const toolSet = toolSetOf([makeTool({ id: "ok", className: "ZCL_ZMCP_X_OK" })], { refused: [refusal] });
    const out = buildFluidDescription(toolSet);
    expect(out).not.toContain("badone");
    expect(out).not.toContain(refusal.path);
  });

  it("appear in buildFluidInfoBlock().refused with path, code and reason", () => {
    const toolSet = toolSetOf([makeTool({ id: "ok", className: "ZCL_ZMCP_X_OK" })], { refused: [refusal] });
    const info = buildFluidInfoBlock({ cfg: cfg(), toolSet });
    expect(info.refused).toEqual([refusal]);
  });
});

// --- 4. buildFluidDescribe coverage ---

describe("buildFluidDescribe coverage", () => {
  const toolA = makeTool({ id: "aaa", className: "ZCL_ZMCP_X_AAA" });
  const toolB = makeTool({ id: "bbb", className: "ZCL_ZMCP_X_BBB", actions: manyActions(3) });
  const toolSet = toolSetOf([toolA, toolB]);

  it("with no toolId, covers every loaded tool", () => {
    const payload = buildFluidDescribe(toolSet);
    expect(payload.tools.map((t) => t.id).sort()).toEqual(["aaa", "bbb"]);
  });

  it("with a toolId, covers exactly that one tool", () => {
    const payload = buildFluidDescribe(toolSet, "bbb");
    expect(payload.tools.map((t) => t.id)).toEqual(["bbb"]);
  });

  it("with an unknown toolId, returns an empty tools array", () => {
    const payload = buildFluidDescribe(toolSet, "does-not-exist");
    expect(payload.tools).toEqual([]);
  });
});

// --- 5. schemas carried verbatim ---

describe("buildFluidDescribe schema fidelity", () => {
  it("carries each action's input and output schema verbatim, targets included", () => {
    const manifestActions = [RUN_ACTION, TARGETED_ACTION];
    const tool = makeTool({ id: "sch", className: "ZCL_ZMCP_X_SCH", actions: manifestActions });
    const toolSet = toolSetOf([tool]);

    const payload = buildFluidDescribe(toolSet, "sch");
    const describedTool = payload.tools[0]!;

    for (let i = 0; i < manifestActions.length; i++) {
      const describedAction = describedTool.actions[i]!;
      expect(describedAction.input).toEqual(tool.manifest.actions[i]!.input);
      expect(describedAction.output).toEqual(tool.manifest.actions[i]!.output);
    }

    const targeted = describedTool.actions.find((a) => a.name === "targeted");
    expect(targeted?.targets).toEqual(TARGETED_ACTION.targets);

    // The non-targeted action must carry no `targets` at all — not an
    // invented empty object — or a generator that always emits `targets: {}`
    // would pass here undetected.
    const untargeted = describedTool.actions.find((a) => a.name === "run");
    expect(untargeted?.targets).toBeUndefined();
  });
});

// --- 6. buildFluidInfoBlock content ---

describe("buildFluidInfoBlock", () => {
  it("reports flag state, package, contract, mode, readOnly and every loaded tool's version and action names", () => {
    const toolA = makeTool({ id: "aaa", className: "ZCL_ZMCP_X_AAA", actions: manyActions(4) });
    const toolB = makeTool({ id: "bbb", className: "ZCL_ZMCP_X_BBB", origin: "plugin" });
    const toolSet = toolSetOf([toolA, toolB]);
    const c = cfg({ fluidApi: true, readOnly: true, abapMode: "read" });

    const info = buildFluidInfoBlock({ cfg: c, toolSet, safety: gate() });

    expect(info.flag).toEqual({ field: "ABAP_FLUID_API", enabled: true });
    expect(info.package).toBe("$ABAPSMITH_FLUID_API");
    expect(info.contract).toBe("1.0");
    expect(info.abapMode).toBe("read");
    expect(info.readOnly).toBe(true);

    const byId = new Map(info.tools.map((t) => [t.id, t]));
    expect(byId.get("aaa")).toEqual({
      id: "aaa",
      origin: "builtin",
      version: manifestVersion(toolA.manifest, toolA.sources),
      actions: toolA.manifest.actions.map((a) => a.name),
    });
    expect(byId.get("bbb")).toEqual({
      id: "bbb",
      origin: "plugin",
      version: manifestVersion(toolB.manifest, toolB.sources),
      actions: toolB.manifest.actions.map((a) => a.name),
    });
  });

  it("reads systemRole/productive/writesLockedOut/roleProbeFailure off a given SafetyGate", () => {
    const toolSet = toolSetOf([makeTool({ id: "aaa", className: "ZCL_ZMCP_X_AAA" })]);
    const g = new SafetyGate({
      readOnly: false,
      allowPackages: ["*"],
      allowNamePrefixes: ["*"],
      systemRole: "development",
      productive: false,
    });

    const info = buildFluidInfoBlock({ cfg: cfg(), toolSet, safety: g });

    expect(info.safety).toEqual({
      systemRole: "development",
      productive: false,
      writesLockedOut: g.config.writesLockedOut,
      roleProbeFailure: g.config.roleProbeFailure,
    });
  });

  it("leaves safety undefined when no SafetyGate is given", () => {
    const toolSet = toolSetOf([makeTool({ id: "aaa", className: "ZCL_ZMCP_X_AAA" })]);
    const info = buildFluidInfoBlock({ cfg: cfg(), toolSet });
    expect(info.safety).toBeUndefined();
  });
});

// --- 7. determinism and ordering ---

describe("determinism and ordering", () => {
  it("buildFluidDescription is byte-identical across repeated calls on the same tool set", () => {
    const toolSet = toolSetOf([
      makeTool({ id: "zzz", className: "ZCL_ZMCP_X_ZZZ", actions: manyActions(10) }),
      makeTool({ id: "aaa", className: "ZCL_ZMCP_X_AAA" }),
      makeTool({ id: "mmm", className: "ZCL_ZMCP_X_MMM", origin: "plugin" }),
    ]);
    expect(buildFluidDescription(toolSet)).toBe(buildFluidDescription(toolSet));
  });

  it("sorts builtins before plugins in the route index regardless of insertion order or id", () => {
    const pluginA = makeTool({ id: "aaa_plugin", className: "ZCL_ZMCP_X_AAAP", origin: "plugin" });
    const builtinZ = makeTool({ id: "zzz_builtin", className: "ZCL_ZMCP_X_ZZZB", origin: "builtin" });
    const toolSet = toolSetOf([pluginA, builtinZ]);

    const out = buildFluidDescription(toolSet);
    const builtinIdx = out.indexOf("zzz_builtin:");
    const pluginIdx = out.indexOf("aaa_plugin (plugin):");
    expect(builtinIdx).toBeGreaterThanOrEqual(0);
    expect(pluginIdx).toBeGreaterThanOrEqual(0);
    expect(builtinIdx).toBeLessThan(pluginIdx);
  });

  it("buildFluidDescribe sorts builtins before plugins the same way", () => {
    const pluginA = makeTool({ id: "aaa_plugin", className: "ZCL_ZMCP_X_AAAP", origin: "plugin" });
    const builtinZ = makeTool({ id: "zzz_builtin", className: "ZCL_ZMCP_X_ZZZB", origin: "builtin" });
    const payload = buildFluidDescribe(toolSetOf([pluginA, builtinZ]));
    expect(payload.tools.map((t) => t.id)).toEqual(["zzz_builtin", "aaa_plugin"]);
  });
});

// --- 8. purity: no connection, no network, tool set alone is enough ---

describe("purity", () => {
  it("buildFluidDescription answers fully from a tool set alone, with no connection argument accepted", () => {
    expect(buildFluidDescription.length).toBe(1);
    const toolSet = toolSetOf([makeTool({ id: "aaa", className: "ZCL_ZMCP_X_AAA" })]);
    const out = buildFluidDescription(toolSet);
    // Not just non-empty: the single argument must actually be the source of the
    // content, or a stub that ignores it and returns any fixed non-empty string
    // would pass here undetected.
    expect(out).toContain("aaa:");
    expect(out).toContain(`${RUN_ACTION.name} (${RUN_ACTION.category})`);
  });

  it("buildFluidDescribe answers fully from a tool set alone, with no toolId argument required", () => {
    const toolSet = toolSetOf([makeTool({ id: "aaa", className: "ZCL_ZMCP_X_AAA" })]);
    const payload = buildFluidDescribe(toolSet);
    expect(payload.tools).toHaveLength(1);
    expect(payload.tools[0]!.actions).toHaveLength(1);
    // Not just shape: the single tool/action must be *this* fixture's, or a stub
    // returning any fixed one-tool/one-action payload would pass here undetected.
    expect(payload.tools[0]!.id).toBe("aaa");
    expect(payload.tools[0]!.actions[0]!.name).toBe(RUN_ACTION.name);
  });
});

// --- empty tool set edge cases (exercised because 1/2/4/6/7 assume >=1 tool) ---

describe("empty tool set", () => {
  it("buildFluidDescription reports no fluid tools are loaded", () => {
    const out = buildFluidDescription(toolSetOf([]));
    expect(out).toContain("No fluid tools are loaded.");
  });

  it("buildFluidDescribe returns an empty tools array", () => {
    expect(buildFluidDescribe(toolSetOf([])).tools).toEqual([]);
  });

  it("buildFluidInfoBlock next points at refused[] when tools are empty but plugins were refused", () => {
    const refusal: RefusedFluidPlugin = {
      path: "/plugins/bad",
      code: "FLUID_PLUGINS_DISABLED",
      reason: "ABAP_ALLOW_FLUID_PLUGINS is off",
    };
    const info = buildFluidInfoBlock({ cfg: cfg(), toolSet: toolSetOf([], { refused: [refusal] }) });
    expect(info.tools).toEqual([]);
    expect(info.next).toMatch(/refused/);
  });
});
