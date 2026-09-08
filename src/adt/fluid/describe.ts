/**
 * Everything that describes a loaded fluid tool set in text or structured
 * form: the MCP tool description built at registration time, the full
 * per-tool schema payload behind `op:"describe"`, and the empty-call info
 * block. All three are pure functions of a `FluidToolSet` (plus, for the
 * info block, the handful of `Config`/`SafetyGate` fields it reports) — no
 * network, no connection, so the tool description can be built at startup
 * before `connect()` ever runs.
 */
import type { SystemRole } from "../connection.js";
import type { Config } from "../../config.js";
import type { SafetyGate } from "../../safety.js";
import {
  FLUID_CONTRACT,
  type FluidActionSpec,
  type FluidCategory,
  type FluidJsonSchema,
  type FluidObjectType,
  type FluidTargets,
  type LoadedFluidTool,
} from "./manifest.js";
import { FLUID_PACKAGE } from "./package.js";
import type { FluidToolSet, RefusedFluidPlugin } from "./plugin-loader.js";

/** Builtins first (by id), then plugins (by id) — the one ordering every rendering below shares. */
function sortedTools(toolSet: FluidToolSet): readonly LoadedFluidTool[] {
  const byId = (a: LoadedFluidTool, b: LoadedFluidTool) => a.manifest.id.localeCompare(b.manifest.id);
  const all = [...toolSet.tools.values()];
  return [
    ...all.filter((t) => t.origin === "builtin").sort(byId),
    ...all.filter((t) => t.origin === "plugin").sort(byId),
  ];
}

function toolLabel(t: LoadedFluidTool): string {
  return t.origin === "plugin" ? `${t.manifest.id} (plugin)` : t.manifest.id;
}

function actionToken(a: FluidActionSpec): string {
  return `${a.name} (${a.category})`;
}

const WRAP_WIDTH = 96;
const CONTINUATION_INDENT = "    ";

/**
 * `<label>: name (category), name (category), ...`, wrapping onto indented
 * continuation lines only between tokens — never inside one, never dropping
 * one. Every action is included; there is no truncation here.
 */
function renderToolActionsLine(label: string, actions: readonly FluidActionSpec[]): string {
  const lines: string[] = [];
  let current = `  ${label}:`;
  let firstOnLine = true;
  for (const action of actions) {
    const token = actionToken(action);
    const candidate = firstOnLine ? `${current} ${token}` : `${current}, ${token}`;
    if (!firstOnLine && candidate.length > WRAP_WIDTH) {
      lines.push(current);
      current = `${CONTINUATION_INDENT}${token}`;
    } else {
      current = candidate;
    }
    firstOnLine = false;
  }
  lines.push(current);
  return lines.join("\n");
}

function exampleValueFor(schema: FluidJsonSchema | undefined): unknown {
  if (!schema) return "value";
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  switch (schema.type) {
    case "string":
      return "value";
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "object":
      return {};
    case "array":
      return [];
    default:
      return "value";
  }
}

/** Up to two plausible arg keys from an action's input schema, or `{}` when it declares none. */
function exampleArgs(action: FluidActionSpec): Record<string, unknown> {
  const props = action.input.properties;
  if (!props) return {};
  const args: Record<string, unknown> = {};
  for (const key of Object.keys(props).slice(0, 2)) {
    args[key] = exampleValueFor(props[key]);
  }
  return args;
}

/**
 * The generated `abap_fluid` MCP tool description. The route index
 * (`tools.actions`) is complete by construction: every loaded tool and every
 * one of its actions is rendered, in full, every time — a plugin operator who
 * installs forty actions gets a forty-action description, not a truncated
 * one. Refused plugins never loaded a tool, so they never appear here.
 */
export function buildFluidDescription(toolSet: FluidToolSet): string {
  const tools = sortedTools(toolSet);
  const header =
    `abap_fluid — SAP functions that run through abapsmith-installed ABAP (package ${FLUID_PACKAGE}). ` +
    "ops: run (default), list, describe, status, verify, repair, remove.\n" +
    "abap_fluid() with no arguments: flag state, package, loaded tools, what to call next.";

  if (tools.length === 0) {
    return `${header}\nNo fluid tools are loaded.`;
  }

  const actionLines = tools.map((t) => renderToolActionsLine(toolLabel(t), t.manifest.actions)).join("\n");
  const lines = [header, "tools.actions (category):", actionLines];

  const firstTool = tools[0];
  const firstAction = firstTool?.manifest.actions[0];
  if (firstTool !== undefined && firstAction !== undefined) {
    const args = exampleArgs(firstAction);
    lines.push(
      `abap_fluid(tool="${firstTool.manifest.id}", action="${firstAction.name}", args=${JSON.stringify(args)})`,
    );
    lines.push(`abap_fluid(op="describe", tool="${firstTool.manifest.id}")  — full input/output schemas for one tool`);
  }

  return lines.join("\n");
}

export interface FluidDescribeObject {
  readonly name: string;
  readonly type: FluidObjectType;
  readonly description: string;
}

export interface FluidDescribeAction {
  readonly name: string;
  readonly category: FluidCategory;
  readonly description: string;
  /** The manifest's own schema object, passed through verbatim — never re-derived or cloned. */
  readonly input: FluidJsonSchema;
  /** Same as `input`: verbatim, so describe can never drift from what `validateAgainstSchema` enforces. */
  readonly output: FluidJsonSchema;
  readonly targets?: FluidTargets;
}

export interface FluidDescribeTool {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly contract: string;
  readonly origin: "builtin" | "plugin";
  readonly version: string;
  readonly entry: string;
  readonly objects: readonly FluidDescribeObject[];
  readonly actions: readonly FluidDescribeAction[];
}

export interface FluidDescribePayload {
  readonly package: string;
  readonly contract: string;
  readonly tools: readonly FluidDescribeTool[];
}

function toDescribeAction(a: FluidActionSpec): FluidDescribeAction {
  return {
    name: a.name,
    category: a.category,
    description: a.description,
    input: a.input,
    output: a.output,
    ...(a.targets !== undefined ? { targets: a.targets } : {}),
  };
}

function toDescribeTool(t: LoadedFluidTool): FluidDescribeTool {
  return {
    id: t.manifest.id,
    title: t.manifest.title,
    description: t.manifest.description,
    contract: t.manifest.contract,
    origin: t.origin,
    version: t.version,
    entry: t.manifest.entry,
    objects: t.manifest.objects.map((o) => ({ name: o.name, type: o.type, description: o.description })),
    actions: t.manifest.actions.map(toDescribeAction),
  };
}

/**
 * `op:"describe"` payload: every loaded tool when `toolId` is omitted, just
 * that one when given. An unknown `toolId` gets an empty `tools` array —
 * the caller (`src/tools/fluid.ts`) is the one that validates and raises
 * `BAD_INPUT`, not this module.
 */
export function buildFluidDescribe(toolSet: FluidToolSet, toolId?: string): FluidDescribePayload {
  const tools =
    toolId === undefined
      ? sortedTools(toolSet)
      : (() => {
          const t = toolSet.tools.get(toolId);
          return t ? [t] : [];
        })();

  return {
    package: FLUID_PACKAGE,
    contract: FLUID_CONTRACT,
    tools: tools.map(toDescribeTool),
  };
}

/** Everything the info block reads off `Config`. A full `Config` satisfies it. */
export type FluidInfoConfigFields = Pick<Config, "fluidApi" | "abapMode" | "readOnly">;

/**
 * Structural, not `import type { FluidToolDeps }`: `src/adt/` never imports
 * from `src/tools/` (same rule `FluidConfigFields`/`FluidLoaderConfig`/
 * `FluidRegistryConfig` follow). `FluidToolDeps` — whose `safety` is
 * required, not optional — is assignable to this unchanged.
 */
export interface FluidInfoDeps {
  readonly cfg: FluidInfoConfigFields;
  readonly safety?: SafetyGate;
  readonly toolSet: FluidToolSet;
}

export interface FluidInfoToolSummary {
  readonly id: string;
  readonly origin: "builtin" | "plugin";
  readonly version: string;
  readonly actions: readonly string[];
}

/** As far as `SafetyGate.config` actually exposes it — `undefined` when no gate was given at all. */
export interface FluidInfoSafety {
  readonly systemRole: SystemRole | undefined;
  readonly productive: boolean | undefined;
  readonly writesLockedOut: boolean | undefined;
  readonly roleProbeFailure: string | undefined;
}

export interface FluidInfoBlock {
  readonly flag: { readonly field: "ABAP_FLUID_API"; readonly enabled: boolean };
  readonly package: string;
  readonly contract: string;
  readonly abapMode: Config["abapMode"];
  readonly readOnly: boolean;
  readonly safety: FluidInfoSafety | undefined;
  readonly tools: readonly FluidInfoToolSummary[];
  readonly refused: readonly RefusedFluidPlugin[];
  readonly warnings: readonly string[];
  readonly next: string;
}

/**
 * The empty-call (`abap_fluid()` with no arguments) info block: flag state,
 * package, contract, abap mode, read-only ceiling, whatever the safety gate
 * exposes about the system role and write lockout, every loaded tool, and —
 * the reason this exists — every REFUSED plugin, so an operator's
 * misconfigured plugin directory is never silently invisible.
 */
export function buildFluidInfoBlock(deps: FluidInfoDeps): FluidInfoBlock {
  const tools: FluidInfoToolSummary[] = sortedTools(deps.toolSet).map((t) => ({
    id: t.manifest.id,
    origin: t.origin,
    version: t.version,
    actions: t.manifest.actions.map((a) => a.name),
  }));

  const g = deps.safety?.config;
  const safety: FluidInfoSafety | undefined =
    g === undefined
      ? undefined
      : {
          systemRole: g.systemRole,
          productive: g.productive,
          writesLockedOut: g.writesLockedOut,
          roleProbeFailure: g.roleProbeFailure,
        };

  const firstTool = tools[0];
  const next =
    firstTool !== undefined
      ? `abap_fluid(op="describe", tool="${firstTool.id}") — full input/output schemas for one tool`
      : deps.toolSet.refused.length > 0
        ? "No fluid tools are loaded, and one or more plugins were refused — see refused[] for why."
        : "No fluid tools are loaded — check ABAP_FLUID_PLUGINS / ABAP_ALLOW_FLUID_PLUGINS if you expected any.";

  return {
    flag: { field: "ABAP_FLUID_API", enabled: deps.cfg.fluidApi !== false },
    package: FLUID_PACKAGE,
    contract: FLUID_CONTRACT,
    abapMode: deps.cfg.abapMode,
    readOnly: deps.cfg.readOnly,
    safety,
    tools,
    refused: deps.toolSet.refused,
    warnings: deps.toolSet.warnings,
    next,
  };
}
