/**
 * `abap_fluid` — the one MCP tool for the fluid API: deploys small,
 * generated ABAP classes/interfaces into `$ABAPSMITH_FLUID_API` and runs
 * their actions. A "fluid tool" is a `LoadedFluidTool` (manifest + resolved
 * ABAP sources + content-addressed version), loaded once at startup by
 * `loadFluidTools` (built-ins always; plugins only when
 * `ABAP_ALLOW_FLUID_PLUGINS` is on) — see `src/adt/fluid/plugin-loader.ts`.
 *
 * Seven ops (`list`, `describe`, `status`, `verify`, `run`, `repair`,
 * `remove`) plus a bare call (no `op`/`tool`/`action`) that returns the
 * catalogue. `run` is the default op — this is a "do the thing" tool first,
 * an inspection tool second, matching `abap_transport`'s shape.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AbapConnection } from "../adt/connection.js";
import type { SessionPool } from "../adt/pool.js";
import type { Config } from "../config.js";
import type { SafetyGate } from "../safety.js";
import type { Journal } from "../journal.js";
import { systemKey } from "../journal.js";
import { AbapError, isAbapError, describeUnknownError } from "../adt/errors.js";
import { buildResponse, textTable } from "../compact.js";
import { FLUID_CONTRACT, manifestVersion, type LoadedFluidTool } from "../adt/fluid/manifest.js";
import { FLUID_PACKAGE, LEGACY_FLUID_PACKAGES, isReservedFluidName } from "../adt/fluid/package.js";
import { fluidDisabledReason, type FluidDisabledReason } from "../adt/fluid/enabled.js";
import type { FluidBuiltinSource, FluidToolSet } from "../adt/fluid/plugin-loader.js";
import {
  classifyFluidTool,
  ensureFluidRuntimeFor,
  ensureFluidTool,
  type EnsureFluidToolResult,
  type FluidObjectStatus,
} from "../adt/fluid/ensure.js";
import { forgetManifest, readFluidRegistry, type FluidRegistryEntry } from "../adt/fluid/registry.js";
import { dispatch, type FluidRunResult } from "../adt/fluid/dispatch.js";
import { LOG_TOOL_ID, LOG_ACTION } from "../adt/fluid/builtin/log.js";
import { mapLogRows, renderLogRead, auditLogRead, assertLogReadArgsNoWindowConflict } from "../adt/bal-log.js";
import { deleteOneFluidObject, type FluidDeleteTarget } from "../adt/fluid/delete.js";
import {
  probeRetiredBridges,
  reapRetiredBridges,
  RETIRED_BRIDGE_CLASSES,
  type RetiredBridgeProbe,
  type RetiredBridgeReap,
} from "../adt/fluid/retired.js";
import {
  INVOKER_NAME_RE,
  listInvokerClasses,
  probeInvokers,
  pruneInvokers,
  staleInvokers,
  type FluidInvokerProbe,
  type FluidInvokerPrune,
} from "../adt/fluid/invokers.js";
import {
  isDynamicBridgeName,
  listDynamicBridges,
  type DynamicBridgeClass,
} from "../adt/fluid/dynamic-bridges.js";
import {
  buildFluidDescribe,
  buildFluidDescription,
  buildFluidInfoBlock,
  type FluidDescribePayload,
  type FluidDescribeTool,
} from "../adt/fluid/describe.js";

// ------------------------------------------------------------------ schema ---

const FLUID_OPS = ["list", "describe", "status", "verify", "run", "repair", "remove"] as const;
type FluidOp = (typeof FLUID_OPS)[number];

/**
 * Flat, raw-zod-shape input (every field optional, like `data-preview.ts`'s
 * schema) rather than a discriminated union: MCP clients build these calls
 * from a single flat JSON object, and a per-op required-field error from the
 * handler (see `badInput` below) is far more legible to a model than a zod
 * union-mismatch error naming every branch it didn't match.
 */
export const fluidInputSchema = {
  op: z
    .enum(FLUID_OPS)
    .optional()
    .describe(
      'What to do. Defaults to "run" whenever `tool` or `action` is given without `op`; a call ' +
        "with none of `op`/`tool`/`action` returns the catalogue instead (other fields such as " +
        "`args`/`confirm`/`corr_nr`/`scope` do not affect this). list/describe touch no network; " +
        "status reads the local registry plus a best-effort probe of retired pre-fluid bridge " +
        "classes and invoker classes per tool. verify asks the system what is actually deployed. " +
        "run (the default) executes one action, deploying or repairing first if needed. repair " +
        "forces a redeploy (and, with no `tool`, also reaps retired pre-fluid bridge classes; " +
        "with `tool`, prunes its stale invokers). remove deletes abapsmith-owned generated ABAP.",
    ),
  tool: z
    .string()
    .optional()
    .describe(
      "Fluid tool id. Required for describe and run; an optional filter for verify/repair " +
        '(default: every loaded tool); required for remove unless scope is "all".',
    ),
  action: z.string().optional().describe("Action name within `tool`. Required for run."),
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Action-specific arguments for run; the catalogue (bare call or describe) names the keys " +
        "per action.",
    ),
  confirm: z
    .string()
    .optional()
    .describe(
      'Required for remove — pass the literal string "remove". Also forwarded to run, where a ' +
        'plugin action in the "mutate" category may require its own confirm string (the ' +
        "catalogue/describe output for that action says so).",
    ),
  corr_nr: z
    .string()
    .optional()
    .describe("Transport request number, forwarded to run for a mutating action that targets a transportable object."),
  scope: z
    .enum(["tool", "invokers", "all", "dynamic"])
    .optional()
    .describe(
      'remove only. "tool" (default) deletes one tool\'s manifest objects (needs `tool`). ' +
        '"invokers" deletes every generated per-call invoker class ' +
        '(ZCL_ZMCP_I_xxxxxxxx). "dynamic" deletes every generated per-call dynamic-bridge class ' +
        "(the abap_bopf_test/abap_ui/abap_enh/abap_fpm_read/abap_run tool paths that deploy fresh " +
        'ABAP per call — see `status`\'s "dynamic bridges" section). "all" deletes every ' +
        `abapsmith-owned object in ${FLUID_PACKAGE}, which already includes both of the above. ` +
        "The package itself is never deleted.",
    ),
};

const FluidInputSchema = z.object(fluidInputSchema);
type FluidInput = z.infer<typeof FluidInputSchema>;

/**
 * The actual bare-call rule (`op`'s `.describe()` text above must keep
 * saying exactly this): `args`/`confirm`/`corr_nr`/`scope` never make a call
 * non-bare on their own — only `op`, `tool`, or `action` do.
 */
export function isBareFluidCall(a: FluidInput): boolean {
  return a.op === undefined && a.tool === undefined && a.action === undefined;
}

// -------------------------------------------------------------------- deps ---

/**
 * `pool` + `ensureConnected` + `errorResult`, not a held `conn`: connections
 * are leased per request from the `SessionPool` (like every other registrar
 * in `src/tools/`), never held across a call, so a stored `conn` field would
 * already be stale by the time a handler ran. Matches `data-preview.ts`,
 * `transport.ts`, etc. `gate` is named `safety` for the same
 * repo-convention reason (every other `*ToolDeps` interface calls it that).
 */
export interface FluidToolDeps {
  readonly pool: SessionPool;
  readonly cfg: Config;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  /** Loaded once at startup by `loadFluidTools`; never changes mid-session. */
  readonly toolSet: FluidToolSet;
  readonly journal: Journal;
  readonly warn?: (message: string) => void;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

function badInput(message: string, field: string, extra: Record<string, unknown> = {}): AbapError {
  return new AbapError("BAD_INPUT", message, { field, ...extra });
}

function mustGetTool(toolSet: FluidToolSet, id: string): LoadedFluidTool {
  const t = toolSet.tools.get(id);
  if (t) return t;
  const available = [...toolSet.tools.keys()].sort();
  throw badInput(
    `Unknown fluid tool "${id}". Loaded tools: ${available.length ? available.join(", ") : "(none)"}.`,
    "tool",
    { tool: id, available },
  );
}

/**
 * Same shape as `ensure.ts`'s module-private `fluidDisabledError` and
 * `dispatch.ts`'s module-private `dispatchDisabledError` — neither is
 * exported, so this is a deliberate third, op-agnostic copy of the same
 * error shape rather than an import of either module-private helper.
 */
function fluidApiDisabledError(
  reason: FluidDisabledReason,
  ctx: { readonly op: FluidOp | "catalogue"; readonly tool?: string; readonly action?: string },
): AbapError {
  const who =
    ctx.tool !== undefined && ctx.action !== undefined
      ? `${ctx.tool}.${ctx.action}`
      : `abap_fluid(op:"${ctx.op}")`;
  const details: Record<string, unknown> = {
    reason: reason.kind,
    field: reason.field,
    package: FLUID_PACKAGE,
    op: ctx.op,
    ...(ctx.tool !== undefined ? { tool: ctx.tool } : {}),
    ...(ctx.action !== undefined ? { action: ctx.action } : {}),
  };
  if (reason.kind === "flag") {
    return new AbapError(
      "FLUID_API_DISABLED",
      `The fluid API is disabled (ABAP_FLUID_API=false) — ${who} was not run. Nothing was ` +
        "deployed, checked, or changed.",
      details,
      "Set ABAP_FLUID_API=true, or leave it unset (it defaults to enabled), to use the fluid API.",
    );
  }
  return new AbapError(
    "FLUID_API_DISABLED",
    `${who} needs the fluid API, and this connection cannot write (${reason.field}) — there is ` +
      "no read-only subset of the fluid API, since even a check can need to deploy or repair the " +
      "ABAP side first. Nothing ran and nothing was changed.",
    details,
    "Connect with write access (ABAP_ALLOW_WRITE=true, ABAP_MODE not \"read\", off a productive " +
      "system, with a passing role probe) to use any part of the fluid API.",
  );
}

/**
 * At the top of every op: catches connected ceilings
 * (productive system, write lockout, failed role probe) that are unknowable
 * at registration time. Cheap before `ensureConnected()` (zero HTTP), which
 * is what keeps list/describe zero-network while still refusing once the
 * gate already knows (from a PRIOR call's `ensureConnected()` — `safety` is
 * one long-lived object, not reconstructed per call). Called again after
 * `ensureConnected()` for verify/repair/remove — `run` gets that second
 * check for free inside `dispatch()`, which independently re-checks with
 * the now-connected gate; `remove` has no such internal recheck, so its own
 * post-connect call here is the only place that ceiling is enforced. `status`
 * only gets the pre-connect check: its own retired-bridge probe is
 * best-effort (see `renderStatus`) and reports a connect/gate failure inline
 * as `(probe unavailable: ...)` rather than refusing the whole call.
 */
function requireFluidEnabled(deps: FluidToolDeps, ctx: { readonly op: FluidOp | "catalogue"; readonly tool?: string; readonly action?: string }): void {
  const reason = fluidDisabledReason(deps.cfg, deps.safety);
  if (reason) throw fluidApiDisabledError(reason, ctx);
}

// -------------------------------------------------------------- rendering ---

function toolListRows(toolSet: FluidToolSet, opts: { readonly categories: boolean }): Array<Record<string, string>> {
  return [...toolSet.tools.values()]
    .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
    .map((t) => ({
      id: t.manifest.id,
      origin: t.origin,
      version: t.version,
      actions: t.manifest.actions.map((a) => (opts.categories ? `${a.name}:${a.category}` : a.name)).join(", "),
    }));
}

function refusedSection(toolSet: FluidToolSet): Array<{ title: string; content: string }> {
  if (toolSet.refused.length === 0) return [];
  const rows = toolSet.refused.map((r) => ({ path: r.path, id: r.id ?? "", code: r.code, reason: r.reason }));
  return [{ title: "REFUSED PLUGINS", content: textTable(rows, ["path", "id", "code", "reason"]) }];
}

/**
 * The bare-call (`abap_fluid()`) response: everything `buildFluidInfoBlock`
 * exposes, rendered so a misconfigured plugin directory is never invisible —
 * every refused plugin (path, code, reason) appears as a row in the shared
 * REFUSED PLUGINS table, same as `renderList`.
 */
function renderInfoBlock(deps: FluidToolDeps): string {
  const info = buildFluidInfoBlock(deps);
  const rows = info.tools.map((t) => ({
    id: t.id,
    origin: t.origin,
    version: t.version,
    actions: t.actions.join(", "),
  }));
  const usage = [
    "list      — every loaded tool: origin, version, action names+categories (zero network)",
    "describe  — {tool?} one tool, or every loaded tool, in full: objects, entry class, per-action " +
      "input/output schema (zero network)",
    "status    — flag/package/contract, what the LOCAL REGISTRY believes is deployed, plus " +
      "best-effort retired-bridge-class and invoker-count probes",
    "verify    — {tool?} ask the system what is ACTUALLY deployed for one or every loaded tool",
    "run       — {tool, action, args?} the default op: execute one action, deploying/repairing first if needed",
    "repair    — {tool?} force a redeploy of one or every loaded tool (a named `tool` also prunes " +
      "its stale invokers; omitting `tool` reaps retired pre-fluid bridge classes instead)",
    'remove    — {confirm:"remove", tool?, scope?} delete abapsmith-owned generated ABAP',
  ].join("\n");
  const body =
    (rows.length ? textTable(rows, ["id", "origin", "version", "actions"]) : "(no fluid tools loaded)") +
    "\n\nOPS:\n" +
    usage +
    "\n\nNEXT: " +
    info.next;
  return buildResponse({
    header: {
      flag_ABAP_FLUID_API: info.flag.enabled,
      package: info.package,
      contract: info.contract,
      abapMode: info.abapMode ?? "(unset)",
      readOnly: info.readOnly,
      systemRole: info.safety?.systemRole,
      productive: info.safety?.productive,
      writesLockedOut: info.safety?.writesLockedOut,
      roleProbeFailure: info.safety?.roleProbeFailure,
      tools_loaded: info.tools.length,
    },
    sections: refusedSection(deps.toolSet),
    body,
    bodyLabel: "CATALOGUE",
    notes: [...info.warnings],
    maxChars: deps.cfg.maxResponseChars,
  }).text;
}

function renderList(deps: FluidToolDeps): string {
  const rows = toolListRows(deps.toolSet, { categories: true });
  return buildResponse({
    header: {
      tools_loaded: deps.toolSet.tools.size,
      refused: deps.toolSet.refused.length,
    },
    sections: refusedSection(deps.toolSet),
    body: rows.length ? textTable(rows, ["id", "origin", "version", "actions"]) : "(no fluid tools loaded)",
    bodyLabel: "TOOLS",
    notes: [...deps.toolSet.warnings],
    maxChars: deps.cfg.maxResponseChars,
  }).text;
}

function describeToolBody(tool: FluidDescribeTool): string {
  const lines: string[] = [];
  lines.push("OBJECTS:");
  for (const o of tool.objects) {
    const entryTag = o.name === tool.entry ? " [entry]" : "";
    lines.push(`  ${o.name} (${o.type})${entryTag} — ${o.description}`);
  }
  lines.push("");
  lines.push("ACTIONS:");
  for (const a of tool.actions) {
    lines.push(`  ${a.name} [${a.category}] — ${a.description}`);
    lines.push(`    input:  ${JSON.stringify(a.input)}`);
    lines.push(`    output: ${JSON.stringify(a.output)}`);
    if (a.targets) lines.push(`    targets: ${JSON.stringify(a.targets)}`);
  }
  return lines.join("\n");
}

/** One named tool (`op:"describe"` with `tool`) keeps the flat header rendering; every
 * loaded tool (`tool` omitted) gets one section per tool instead — a flat body
 * would blur where one tool's schemas end and the next one's begin. The shape is a
 * function of what was requested, not of how many tools happen to be loaded. */
function renderDescribe(deps: FluidToolDeps, payload: FluidDescribePayload, toolId: string | undefined): string {
  if (toolId !== undefined) {
    const [only] = payload.tools;
    if (only !== undefined) {
      return buildResponse({
        header: {
          tool: only.id,
          title: only.title,
          description: only.description,
          contract: only.contract,
          origin: only.origin,
          version: only.version,
          entry: only.entry,
        },
        body: describeToolBody(only),
        bodyLabel: "TOOL",
        maxChars: deps.cfg.maxResponseChars,
      }).text;
    }
  }

  const sections = payload.tools.map((t) => ({
    title: `${t.id} (${t.origin}, v${t.version})`,
    content: describeToolBody(t),
  }));
  return buildResponse({
    header: { package: payload.package, contract: payload.contract, tools_described: payload.tools.length },
    sections,
    body: payload.tools.length ? "" : "(no fluid tools loaded)",
    bodyLabel: "TOOLS",
    maxChars: deps.cfg.maxResponseChars,
  }).text;
}

const RETIRED_BRIDGE_REPAIR_NOTE =
  'op:"repair" with no `tool` deletes the ones reported "present". A "moved" one is in a ' +
  "package abapsmith does not own and is never touched.";

/**
 * Shared by `status` and `verify` — both report the same ten-class list, one
 * best-effort (status can fail to connect at all), one inside an already-held
 * read lease (verify never fails to probe, since `probeRetiredBridges` itself
 * never throws).
 */
function renderRetiredBridgeSection(
  probes: readonly RetiredBridgeProbe[] | undefined,
  error: string | undefined,
): { title: string; content: string } {
  const title = "RETIRED BRIDGE CLASSES";
  if (error !== undefined) return { title, content: `(probe unavailable: ${error})` };

  const nonAbsent = (probes ?? []).filter((p) => p.state !== "absent");
  if (nonAbsent.length === 0) {
    return {
      title,
      content: `(none — all ${RETIRED_BRIDGE_CLASSES.length} retired pre-fluid bridge classes are gone)`,
    };
  }
  const rows = nonAbsent.map((p) => ({
    name: p.name,
    state: p.state,
    foundIn: p.foundIn ?? "",
    supersededBy: p.supersededBy,
  }));
  return {
    title,
    content: textTable(rows, ["name", "state", "foundIn", "supersededBy"]) + "\n\n" + RETIRED_BRIDGE_REPAIR_NOTE,
  };
}

/**
 * Per-tool invoker counts, keyed by each probe's parsed `toolId` (see
 * `parseInvokerProvenance`) rather than the loaded tool set — an invoker for
 * a tool that has since been unloaded still gets counted and named.
 * Degrades the same way `renderRetiredBridgeSection` does.
 */
function renderInvokerCountsSection(
  probes: readonly FluidInvokerProbe[] | undefined,
  error: string | undefined,
): { title: string; content: string } {
  const title = "INVOKER CLASSES";
  if (error !== undefined) return { title, content: `(probe unavailable: ${error})` };

  const all = probes ?? [];
  if (all.length === 0) return { title, content: "(none — no ZCL_ZMCP_I_* invoker classes exist)" };

  const counts = new Map<string, number>();
  let unattributable = 0;
  for (const p of all) {
    if (p.toolId === undefined) {
      unattributable += 1;
      continue;
    }
    counts.set(p.toolId, (counts.get(p.toolId) ?? 0) + 1);
  }
  const rows = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tool, count]) => ({ tool, invokers: String(count) }));
  const body = rows.length ? textTable(rows, ["tool", "invokers"]) : "(none attributable to a loaded tool id)";
  const unattributableLine = unattributable > 0 ? `\n${unattributable} invoker(s) could not be attributed to a tool.` : "";
  return {
    title,
    content: `${body}${unattributableLine}\nCounting invokers costs one source read per invoker.`,
  };
}

const DYNAMIC_BRIDGE_REMOVE_NOTE =
  'op:"remove" with scope:"dynamic" deletes every one of these; scope:"all" already includes ' +
  "them too, since they are all reserved (ZCL_ZMCP_*) names.";

/**
 * The five tool paths that deploy one generated ABAP bridge class per call
 * (`../adt/fluid/dynamic-bridges.ts`) rather than running a fixed manifest.
 * Degrades the same way `renderRetiredBridgeSection`/`renderInvokerCountsSection`
 * do; grouped by family (not by raw prefix) so the note can name the tool
 * path a caller would otherwise have no way to connect a bare class name to.
 */
function renderDynamicBridgeSection(
  bridges: readonly DynamicBridgeClass[] | undefined,
  error: string | undefined,
): { title: string; content: string } {
  const title = "DYNAMIC BRIDGES";
  if (error !== undefined) return { title, content: `(probe unavailable: ${error})` };

  const all = bridges ?? [];
  if (all.length === 0) return { title, content: "(none — no per-call dynamic-bridge classes exist)" };

  const byLabel = new Map<string, { tool: string; count: number }>();
  for (const b of all) {
    const entry = byLabel.get(b.label);
    if (entry) entry.count += 1;
    else byLabel.set(b.label, { tool: b.tool, count: 1 });
  }
  const rows = [...byLabel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, { tool, count }]) => ({ family: label, tool, count: String(count) }));
  return {
    title,
    content: textTable(rows, ["family", "tool", "count"]) + "\n\n" + DYNAMIC_BRIDGE_REMOVE_NOTE,
  };
}

async function renderStatus(deps: FluidToolDeps): Promise<string> {
  const key = systemKey(deps.cfg);
  const registry = await readFluidRegistry(deps.cfg, key);
  const rows = [...registry.values()]
    .sort((a, b) => a.toolId.localeCompare(b.toolId))
    .map((e: FluidRegistryEntry) => ({
      tool: e.toolId,
      contract: e.contract,
      version: e.version,
      objects: e.objects.join(","),
      deployedAt: e.deployedAt,
    }));

  // Best-effort: the local-registry answer above must still render in full
  // even when there is no connection or either probe fails. The two probes
  // degrade independently — an invoker-probe failure must not discard an
  // already-succeeded retired-bridge probe (or vice versa) — while still
  // sharing the one lease below rather than opening a second connection.
  let retired: readonly RetiredBridgeProbe[] | undefined;
  let invokers: readonly FluidInvokerProbe[] | undefined;
  let dynamicBridges: readonly DynamicBridgeClass[] | undefined;
  let probeError: string | undefined;
  let invokerProbeError: string | undefined;
  let dynamicBridgeProbeError: string | undefined;
  try {
    await deps.ensureConnected();
    const manifestObjectNames = new Set(
      [...deps.toolSet.tools.values()].flatMap((t) => t.manifest.objects.map((o) => o.name.trim().toUpperCase())),
    );
    const probed = await deps.pool.withRead("abap_fluid.status", async (conn) => {
      const retiredProbe = await probeRetiredBridges(conn);
      let invokerProbe: readonly FluidInvokerProbe[] | undefined;
      let invokerErr: string | undefined;
      try {
        const invokerNames = await listInvokerClasses(conn);
        invokerProbe = await probeInvokers(conn, invokerNames);
      } catch (e) {
        invokerErr = describeUnknownError(e);
      }
      let dynamicBridgeProbe: readonly DynamicBridgeClass[] | undefined;
      let dynamicBridgeErr: string | undefined;
      try {
        dynamicBridgeProbe = await listDynamicBridges(conn, manifestObjectNames);
      } catch (e) {
        dynamicBridgeErr = describeUnknownError(e);
      }
      return { retiredProbe, invokerProbe, invokerErr, dynamicBridgeProbe, dynamicBridgeErr };
    });
    retired = probed.retiredProbe;
    invokers = probed.invokerProbe;
    invokerProbeError = probed.invokerErr;
    dynamicBridges = probed.dynamicBridgeProbe;
    dynamicBridgeProbeError = probed.dynamicBridgeErr;
  } catch (e) {
    probeError = describeUnknownError(e);
  }

  return buildResponse({
    header: {
      flag_ABAP_FLUID_API: deps.cfg.fluidApi !== false,
      FLUID_PACKAGE,
      FLUID_CONTRACT,
      abapMode: deps.cfg.abapMode ?? "(unset)",
      readOnly: deps.cfg.readOnly,
      tools_loaded: deps.toolSet.tools.size,
    },
    body: rows.length ? textTable(rows, ["tool", "contract", "version", "objects", "deployedAt"]) : "(nothing recorded for this system)",
    bodyLabel: "LOCAL REGISTRY",
    sections: [
      renderRetiredBridgeSection(retired, probeError),
      renderInvokerCountsSection(invokers, probeError ?? invokerProbeError),
      renderDynamicBridgeSection(dynamicBridges, probeError ?? dynamicBridgeProbeError),
    ],
    notes: [
      "The local registry is what abapsmith BELIEVES is deployed on this system — a cache, not " +
        'an authority. It can be stale or wrong. Use op:"verify" to actually ask the system what ' +
        "is deployed.",
    ],
    maxChars: deps.cfg.maxResponseChars,
  }).text;
}

const VERIFY_STATE_NOTE =
  "States: absent (never deployed), present (matches the manifest and is active), stale " +
  "(deployed but content differs from the manifest), inactive (written but not activated), " +
  "broken (matches the manifest's content but fails a syntax check), foreign (exists, under a " +
  "reserved name, in a package abapsmith does not own), legacy (exists under a reserved name in " +
  `an old fluid package — ${LEGACY_FLUID_PACKAGES.join(" or ")} — and would be relocated on the next run or ` +
  "repair).";

async function runVerify(deps: FluidToolDeps, a: FluidInput): Promise<string> {
  requireFluidEnabled(deps, { op: "verify", tool: a.tool });
  await deps.ensureConnected();
  requireFluidEnabled(deps, { op: "verify", tool: a.tool });

  const targets = a.tool ? [mustGetTool(deps.toolSet, a.tool)] : [...deps.toolSet.tools.values()];
  if (targets.length === 0) throw badInput("No fluid tools are loaded; nothing to verify.", "tool");

  const { byTool, retired } = await deps.pool.withRead("abap_fluid.verify", async (conn) => {
    const out = new Map<string, readonly FluidObjectStatus[]>();
    for (const t of targets) out.set(t.manifest.id, await classifyFluidTool(conn, deps.cfg, t));
    return { byTool: out, retired: await probeRetiredBridges(conn) };
  });

  const rows: Array<Record<string, string>> = [];
  let anyNotPresent = false;
  for (const t of targets) {
    for (const s of byTool.get(t.manifest.id) ?? []) {
      if (s.state !== "present") anyNotPresent = true;
      rows.push({ tool: t.manifest.id, object: s.name, type: s.type, state: s.state, foundIn: s.foundIn ?? "" });
    }
  }

  const notes: string[] = anyNotPresent ? [VERIFY_STATE_NOTE] : [];
  if (retired.some((p) => p.state === "present")) notes.push(RETIRED_BRIDGE_REPAIR_NOTE);

  return buildResponse({
    header: { tools_checked: targets.length },
    body: rows.length ? textTable(rows, ["tool", "object", "type", "state", "foundIn"]) : "(nothing to verify)",
    bodyLabel: "OBJECTS",
    sections: [renderRetiredBridgeSection(retired, undefined)],
    notes,
    maxChars: deps.cfg.maxResponseChars,
  }).text;
}

async function runRun(deps: FluidToolDeps, a: FluidInput): Promise<string> {
  const toolId = a.tool;
  const actionName = a.action;
  if (!toolId) throw badInput("run requires `tool`.", "tool");
  if (!actionName) throw badInput("run requires `action`.", "action");

  requireFluidEnabled(deps, { op: "run", tool: toolId, action: actionName });

  // `log.read` gets one client-side check before any network happens:
  // `last_seconds` combined with `since`/`until` is decidable from `a.args`
  // alone. `logDispatchArgs` (src/adt/bal-log.ts) already does this for
  // callers that build a `BalLogQuery`, but this generic `run` path hands
  // the caller's raw `args` straight to `dispatch()` below, so that check
  // never ran — the caller paid a full round trip to the fluid runtime for
  // a mistake this function could see on its own. Must run before
  // `ensureConnected()`, not just before `dispatch()`: connecting is itself
  // network cost this refusal is supposed to avoid.
  if (toolId === LOG_TOOL_ID && actionName === LOG_ACTION) {
    assertLogReadArgsNoWindowConflict(a.args ?? {});
  }

  await deps.ensureConnected();
  // No second check here: `dispatch()` itself re-checks `fluidDisabledReason(cfg, gate)`
  // as its first statement, with the now-connected gate — see the doc comment above.

  // `objectUri: undefined` — a fluid call touches the tool's manifest objects
  // AND (for a fresh args/contract combination) a freshly generated invoker
  // class; there is no single object to gate the write lease on. Same
  // pattern as `abap_transport`, which is also a multi-object/package-scoped
  // write with no natural single `objectUri`.
  const result: FluidRunResult = await deps.pool.withWrite("abap_fluid.run", undefined, (conn) =>
    dispatch(
      {
        conn,
        cfg: deps.cfg,
        gate: deps.safety,
        tools: deps.toolSet.tools,
        journal: deps.journal,
        ...(deps.warn ? { warn: deps.warn } : {}),
      },
      {
        tool: toolId,
        action: actionName,
        args: a.args ?? {},
        ...(a.confirm !== undefined ? { confirm: a.confirm } : {}),
        ...(a.corr_nr !== undefined ? { corrNr: a.corr_nr } : {}),
      },
    ),
  );

  // `log.read` gets a dedicated render (text tables, one section per log)
  // instead of the generic JSON dump below, plus a stderr audit line naming
  // only what was looked at (object/subobject) and how much came back — see
  // `src/adt/bal-log.ts`. `FluidToolDeps` has no injectable log sink (unlike
  // `DataPreviewToolDeps.log`), so this writes to stderr directly rather
  // than adding one — that field belongs to whoever owns `FluidToolDeps`.
  if (toolId === LOG_TOOL_ID && actionName === LOG_ACTION) {
    const mapped = mapLogRows(Array.isArray(result.result) ? result.result : []);
    const args = a.args ?? {};
    auditLogRead(
      mapped,
      {
        ...(typeof args["object"] === "string" ? { object: args["object"] } : {}),
        ...(typeof args["subobject"] === "string" ? { subobject: args["subobject"] } : {}),
      },
      (m) => void process.stderr.write(m + "\n"),
    );
    return renderLogRead(mapped, {
      ms: result.ms,
      version: result.version,
      deployed: result.deployed,
      maxChars: deps.cfg.maxResponseChars,
    }).text;
  }

  return buildResponse({
    header: {
      tool: result.tool,
      action: result.action,
      version: result.version,
      deployed: result.deployed,
      ms: result.ms,
      truncated: result.truncated,
    },
    body: JSON.stringify(result.result, null, 2),
    bodyLabel: "RESULT",
    maxChars: deps.cfg.maxResponseChars,
  }).text;
}

async function runRepair(deps: FluidToolDeps, a: FluidInput): Promise<string> {
  requireFluidEnabled(deps, { op: "repair", tool: a.tool });
  await deps.ensureConnected();
  requireFluidEnabled(deps, { op: "repair", tool: a.tool });

  const soleTool = a.tool ? mustGetTool(deps.toolSet, a.tool) : undefined;
  const targets = soleTool ? [soleTool] : [...deps.toolSet.tools.values()];
  if (targets.length === 0) throw badInput("No fluid tools are loaded; nothing to repair.", "tool");

  const key = systemKey(deps.cfg);
  const results: EnsureFluidToolResult[] = [];
  // One fresh lease PER tool. The lease-splitting half has precedent —
  // `runRemove`'s per-delete loop below and `reapRetiredBridges`/`pruneInvokers`
  // (`retired.ts`/`invokers.ts`) split for the same reason. The `markDead` half
  // does NOT: this is the only `markDead` caller outside `connection.ts` and
  // `pool.ts`, because those three loops delete through a path that surfaces
  // `SESSION_DEAD` to the pool, and this one does not (see below).
  // `ensureFluidTool`'s "legacy"/"broken" repair branches (`ensure.ts`)
  // delete-then-recreate the object, and a delete kills the ADT session
  // server-side. `LOGON_ENDPOINT_LIFETIME_CEILING` is per connection
  // instance, so sharing one connection across every tool in the batch would
  // wedge partway through once enough tools needed a delete.
  //
  // A separate `withWrite` call per tool is not sufficient on its own:
  // `AdtSessionPool.tryTake` always hands out the warmest idle slot, and
  // `ensure.ts`'s one-shot revive (`writeAndActivateOnce`) heals a
  // delete-killed session on the SAME connection object rather than letting
  // it surface as `SESSION_DEAD` — the one signal the pool's own dead-slot
  // detection (`AdtSessionPool.isSlotDead`) looks for. A connection revived
  // this way looks perfectly alive at `release()` time and goes right back
  // into the idle pool for the next tool's lease to pick up, so its
  // `logonEndpointRequestCount` keeps accumulating across the whole batch
  // exactly as it did before this loop was split. `conn.markDead()` below
  // forces what the pool cannot infer on its own: retire the connection this
  // tool's repair may have revived so the next tool starts a fresh one,
  // mirroring how `AdtSessionPool.seatPrimary` avoids the identical
  // "immortal primary bricks permanently on its Nth revival" failure for the
  // pinned primary connection.
  for (const t of targets) {
    // MUST run before `ensureFluidTool`: its cache short-circuits on a
    // matching registry entry and returns immediately, `deployed: false`,
    // every object hardcoded "present" — no server round trip at all —
    // which is exactly the opposite of what `repair` is for.
    await forgetManifest(deps.cfg, key, t.manifest.id);
    results.push(
      await deps.pool.withWrite("abap_fluid.repair", undefined, async (conn) => {
        // A plugin body compiles against the shared runtime class but cannot declare it
        // (the loader confines plugin objects to their own namespace), so repairing the
        // plugin alone would leave a missing runtime missing. No-op for builtins.
        await ensureFluidRuntimeFor(conn, deps.safety, deps.cfg, t, {
          tool: t.manifest.id,
          action: "(repair)",
          op: "repair",
        });
        const result = await ensureFluidTool(conn, deps.safety, deps.cfg, t, {
          tool: t.manifest.id,
          action: "(repair)",
          op: "repair",
        });
        conn.markDead("abap_fluid.repair: retiring after this tool's ensure pass so the next tool cannot inherit its logon-ceiling budget");
        return result;
      }),
    );
  }

  // Reap (no `tool`) or prune (named `tool`) — never both, and only after
  // every target above has already been ensured: both are cleanup passes
  // over the package as a whole, and running them first would sweep against
  // a not-yet-repaired package. Not a lease constraint (each target above
  // already retires its own connection when its lease ends) — just result
  // ordering.
  let reaped: readonly RetiredBridgeReap[] | undefined;
  let pruned: readonly FluidInvokerPrune[] | undefined;
  let invokerProbeError: string | undefined;
  if (soleTool === undefined) {
    reaped = await reapRetiredBridges(deps.safety, (op, fn) => deps.pool.withWrite(op, undefined, fn));
  } else {
    // Best-effort, like `renderStatus`'s invoker probe: the ensure/redeploy
    // work above has already succeeded and been committed, so a probe
    // failure here must degrade the STALE INVOKERS section rather than
    // throw and discard that already-succeeded repair result. Nothing is
    // pruned when the probe fails.
    try {
      const probes = await deps.pool.withRead("abap_fluid.repair.probe-invokers", async (conn) => {
        const names = await listInvokerClasses(conn);
        return probeInvokers(conn, names);
      });
      const stale = staleInvokers(probes, soleTool.manifest.id, soleTool.version);
      pruned = await pruneInvokers(deps.safety, (op, fn) => deps.pool.withWrite(op, undefined, fn), stale);
    } catch (e) {
      invokerProbeError = describeUnknownError(e);
    }
  }

  const rows: Array<Record<string, string>> = [];
  for (const r of results) {
    for (const s of r.objects) rows.push({ tool: r.toolId, object: s.name, type: s.type, state: s.state });
  }

  const sections = results.map((r) => ({ title: r.toolId, content: `version ${r.version}, deployed: ${r.deployed}` }));
  const notes: string[] = [];
  if (reaped) {
    const reapRows = reaped.map((r) => ({ name: r.name, outcome: r.outcome, foundIn: r.foundIn ?? "", error: r.error ?? "" }));
    sections.push({
      title: "RETIRED BRIDGE CLASSES",
      content: reaped.every((r) => r.outcome === "already-absent")
        ? "(none — nothing retired was left on this system)"
        : textTable(reapRows, ["name", "outcome", "foundIn", "error"]),
    });
  } else {
    notes.push('Retired pre-fluid bridge classes are only reaped by op:"repair" with no `tool`.');
  }
  if (pruned) {
    const pruneRows = pruned.map((p) => ({ name: p.name, outcome: p.outcome, error: p.error ?? "" }));
    sections.push({
      title: "STALE INVOKERS",
      content: pruneRows.length
        ? textTable(pruneRows, ["name", "outcome", "error"])
        : "(none — no stale invokers found for this tool)",
    });
  } else if (invokerProbeError !== undefined) {
    sections.push({ title: "STALE INVOKERS", content: `(probe unavailable: ${invokerProbeError})` });
  }

  return buildResponse({
    header: { tools_repaired: results.length },
    sections,
    body: rows.length ? textTable(rows, ["tool", "object", "type", "state"]) : "(nothing to repair)",
    bodyLabel: "OBJECTS",
    notes,
    maxChars: deps.cfg.maxResponseChars,
  }).text;
}

// -------------------------------------------------------------------- remove ---

type RemoveOutcome = FluidDeleteTarget & { readonly outcome: "deleted" | "already-absent" | "failed"; readonly error?: string };

/**
 * `scope: "tool"` reads the target list straight off the loaded manifest —
 * no server round trip needed. `"invokers"`/`"all"` enumerate the package's
 * actual members via `conn.adt.nodeContents("DEVC/K", FLUID_PACKAGE)` — the
 * external `ADTClient`'s (from the `abap-adt-api` package) own node-listing
 * call, the same one `src/adt/ddic.ts`'s `readPackage` uses (the only other
 * call site in this repo). Anything not `CLAS/OC`/`INTF/OI` is reported as
 * unmappable rather than silently skipped.
 */
async function removeTargets(
  conn: AbapConnection,
  toolSet: FluidToolSet,
  scope: "tool" | "invokers" | "all" | "dynamic",
  toolId: string | undefined,
): Promise<{ targets: readonly FluidDeleteTarget[]; unmappable: ReadonlyArray<{ type: string; name: string }> }> {
  if (scope === "tool") {
    const t = mustGetTool(toolSet, toolId ?? "");
    return { targets: t.manifest.objects.map((o) => ({ type: o.type, name: o.name })), unmappable: [] };
  }

  const listed = await conn.adt.nodeContents("DEVC/K", FLUID_PACKAGE);
  const targets: FluidDeleteTarget[] = [];
  const unmappable: Array<{ type: string; name: string }> = [];
  for (const n of listed.nodes ?? []) {
    const name = n.OBJECT_NAME ?? "";
    const type = n.OBJECT_TYPE ?? "";
    if (!name) continue;
    const wanted =
      scope === "invokers" ? INVOKER_NAME_RE.test(name) : scope === "dynamic" ? isDynamicBridgeName(name) : isReservedFluidName(name);
    if (!wanted) continue;
    if (type === "CLAS/OC" || type === "INTF/OI") {
      targets.push({ type, name });
    } else {
      unmappable.push({ type, name });
    }
  }
  return { targets, unmappable };
}

async function runRemove(deps: FluidToolDeps, a: FluidInput): Promise<string> {
  if (a.confirm !== "remove") {
    throw badInput(
      `remove deletes ABAP objects and requires confirm: "remove" (got ${a.confirm === undefined ? "nothing" : JSON.stringify(a.confirm)}).`,
      "confirm",
    );
  }
  const scope = a.scope ?? "tool";
  if (scope === "tool" && (a.tool === undefined || a.tool === "")) {
    throw badInput('scope "tool" (the default) requires `tool`.', "tool");
  }

  requireFluidEnabled(deps, { op: "remove", tool: a.tool });
  await deps.ensureConnected();
  // No internal recheck downstream for `remove` (unlike `run`/`dispatch`), so this second call
  // is the only place the connected ceiling is enforced for this op.
  requireFluidEnabled(deps, { op: "remove", tool: a.tool });

  const { targets, unmappable } = await deps.pool.withRead("abap_fluid.remove.list", (conn) =>
    removeTargets(conn, deps.toolSet, scope, a.tool),
  );

  // One fresh lease PER delete, same reason as `reapRetiredBridges`
  // (`retired.ts`): deleting a class kills the ADT session server-side, and
  // `LOGON_ENDPOINT_LIFETIME_CEILING` is per connection instance, so a loop
  // of deletes on one held connection dies after a handful. No revive here
  // — each delete already gets its own fresh session.
  const outcomes: RemoveOutcome[] = [];
  for (const target of targets) {
    try {
      const del = await deps.pool.withWrite("abap_fluid.remove", undefined, (conn) =>
        deleteOneFluidObject(conn, deps.safety, target, false),
      );
      outcomes.push({ ...target, outcome: del.deleted === false ? "failed" : "deleted" });
    } catch (e) {
      if (isAbapError(e) && e.code === "NOT_FOUND") {
        outcomes.push({ ...target, outcome: "already-absent" });
      } else {
        outcomes.push({ ...target, outcome: "failed", error: describeUnknownError(e) });
      }
    }
  }

  // Forget the registry entry for any tool any of whose manifest objects was
  // just deleted — otherwise `run`/`verify` would keep trusting a cache
  // entry for ABAP that no longer exists. Local filesystem work, outside
  // any lease.
  const key = systemKey(deps.cfg);
  const deletedNames = new Set(outcomes.filter((o) => o.outcome === "deleted").map((o) => o.name.toUpperCase()));
  for (const t of deps.toolSet.tools.values()) {
    if (t.manifest.objects.some((o) => deletedNames.has(o.name.toUpperCase()))) {
      await forgetManifest(deps.cfg, key, t.manifest.id);
    }
  }

  const rows = outcomes.map((o) => ({ type: o.type, name: o.name, outcome: o.outcome, error: o.error ?? "" }));
  const notes: string[] = [
    `${FLUID_PACKAGE} itself is never deleted: abapsmith's package-delete route deploys its own ` +
      "helper class into the package before deleting it, and generated ABAP refuses to delete a " +
      "non-empty package — a package delete from inside that same package cannot work. Drop it " +
      "manually if you want it gone.",
  ];
  if (unmappable.length) {
    notes.push(
      `${unmappable.length} package member(s) matched the reserved-name filter but are not a ` +
        `class or interface (CLAS/OC or INTF/OI) and were left alone: ` +
        unmappable.map((u) => `${u.name} (${u.type || "unknown type"})`).join(", ") +
        ".",
    );
  }

  return buildResponse({
    header: { scope, tool: a.tool ?? "(n/a)" },
    body: rows.length ? textTable(rows, ["type", "name", "outcome", "error"]) : "(nothing matched this scope)",
    bodyLabel: "OBJECTS",
    notes,
    maxChars: deps.cfg.maxResponseChars,
  }).text;
}

// -------------------------------------------------------------- registration ---

/**
 * Synchronous builtins-only tool set, for callers that cannot await
 * `loadFluidTools` (e.g. a test harness building deps inline). Same
 * construction `loadFluidTools` uses for built-ins
 * (`src/adt/fluid/plugin-loader.ts`), just without the plugin-discovery
 * loop around it.
 */
export function builtinFluidToolSet(builtins: readonly FluidBuiltinSource[]): FluidToolSet {
  const tools = new Map<string, LoadedFluidTool>();
  for (const builtin of builtins) {
    tools.set(builtin.manifest.id, {
      manifest: builtin.manifest,
      origin: "builtin",
      sources: builtin.sources,
      version: manifestVersion(builtin.manifest, builtin.sources),
    });
  }
  return { tools, refused: [], warnings: [] };
}

/** Registers `abap_fluid`. The caller decides whether this runs at all — see `server.ts`. */
export function registerFluidTool(mcp: McpServer, deps: FluidToolDeps): void {
  const description = buildFluidDescription(deps.toolSet);
  mcp.registerTool(
    "abap_fluid",
    {
      title: "Fluid ABAP tool API",
      description,
      inputSchema: fluidInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (rawArgs) => {
      try {
        const a = rawArgs as FluidInput;

        if (isBareFluidCall(a)) {
          requireFluidEnabled(deps, { op: "catalogue" });
          return ok(renderInfoBlock(deps));
        }

        const op: FluidOp = a.op ?? "run";
        switch (op) {
          case "list":
            requireFluidEnabled(deps, { op });
            return ok(renderList(deps));
          case "describe": {
            requireFluidEnabled(deps, { op, tool: a.tool });
            const toolId = a.tool ? a.tool : undefined;
            if (toolId !== undefined) mustGetTool(deps.toolSet, toolId);
            return ok(renderDescribe(deps, buildFluidDescribe(deps.toolSet, toolId), toolId));
          }
          case "status":
            requireFluidEnabled(deps, { op });
            return ok(await renderStatus(deps));
          case "verify":
            return ok(await runVerify(deps, a));
          case "run":
            return ok(await runRun(deps, a));
          case "repair":
            return ok(await runRepair(deps, a));
          case "remove":
            return ok(await runRemove(deps, a));
        }
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}
