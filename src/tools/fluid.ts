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
import { isSessionDeadFailure } from "../adt/write-verify.js";
import { authorizeMutation, deleteObject, NO_JOURNAL } from "../adt/write.js";
import {
  FLUID_CONTRACT,
  manifestVersion,
  type FluidObjectType,
  type LoadedFluidTool,
} from "../adt/fluid/manifest.js";
import { FLUID_PACKAGE, LEGACY_FLUID_PACKAGES, isReservedFluidName } from "../adt/fluid/package.js";
import { fluidDisabledReason, type FluidDisabledReason } from "../adt/fluid/enabled.js";
import type { FluidBuiltinSource, FluidToolSet } from "../adt/fluid/plugin-loader.js";
import {
  classifyFluidTool,
  ensureFluidTool,
  type EnsureFluidToolResult,
  type FluidObjectStatus,
} from "../adt/fluid/ensure.js";
import { forgetManifest, readFluidRegistry, type FluidRegistryEntry } from "../adt/fluid/registry.js";
import { dispatch, type FluidRunResult } from "../adt/fluid/dispatch.js";

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
      'What to do. Defaults to "run" whenever tool/action/args/confirm/corr_nr/scope is given; a ' +
        "call with none of those returns the catalogue instead. list/describe/status touch no " +
        "network. verify asks the system what is actually deployed. run (the default) executes " +
        "one action, deploying or repairing first if needed. repair forces a redeploy. remove " +
        "deletes abapsmith-owned generated ABAP.",
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
    .enum(["tool", "invokers", "all"])
    .optional()
    .describe(
      'remove only. "tool" (default) deletes one tool\'s manifest objects (needs `tool`). ' +
        '"invokers" deletes every generated per-call invoker class ' +
        "(ZCL_ZMCP_I_xxxxxxxx). \"all\" deletes every abapsmith-owned object in " +
        `${FLUID_PACKAGE}. The package itself is never deleted.`,
    ),
};

const FluidInputSchema = z.object(fluidInputSchema);
type FluidInput = z.infer<typeof FluidInputSchema>;

/** Generated per-call invoker class names — `INVOKER_NAME_RE` in `src/adt/fluid/invoke.ts` is not exported, so this is a deliberate duplicate, case-insensitively. */
const INVOKER_NAME_RE = /^ZCL_ZMCP_I_[0-9A-F]{8}$/i;

// -------------------------------------------------------------------- deps ---

/**
 * Deviates from the S2 brief's sketch (`{ conn, cfg, gate, toolSet }`):
 * connections are leased per request from the `SessionPool` (like every
 * other registrar in `src/tools/`), never held across a call, so `conn`
 * would be stale by the time the handler ran — hence `pool` +
 * `ensureConnected` + `errorResult`, matching `data-preview.ts`,
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
 * `dispatch.ts`'s module-private `dispatchDisabledError` — those two files
 * are outside my file set (other agents own `ensure.ts`; `dispatch.ts` is
 * S2 core, not mine to edit either), so this is a deliberate third,
 * op-agnostic copy of the same error shape rather than an import of either
 * module-private helper (neither is exported).
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
 * At the top of every op, per the brief: catches connected ceilings
 * (productive system, write lockout, failed role probe) that are unknowable
 * at registration time. Cheap before `ensureConnected()` (zero HTTP), which
 * is what keeps list/describe/status zero-network while still refusing once
 * the gate already knows (from a PRIOR call's `ensureConnected()` — `safety`
 * is one long-lived object, not reconstructed per call). Called again after
 * `ensureConnected()` for verify/repair/remove — `run` gets that second
 * check for free inside `dispatch()`, which independently re-checks with
 * the now-connected gate; `remove` has no such internal recheck, so its own
 * post-connect call here is the only place that ceiling is enforced.
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

function renderCatalogue(deps: FluidToolDeps): string {
  const rows = toolListRows(deps.toolSet, { categories: false });
  const usage = [
    "list      — every loaded tool: origin, version, action names+categories (zero network)",
    "describe  — {tool} one tool in full: objects, entry class, per-action input/output schema (zero network)",
    "status    — flag/package/contract, and what the LOCAL REGISTRY believes is deployed (zero network)",
    "verify    — {tool?} ask the system what is ACTUALLY deployed for one or every loaded tool",
    "run       — {tool, action, args?} the default op: execute one action, deploying/repairing first if needed",
    "repair    — {tool?} force a redeploy of one or every loaded tool",
    'remove    — {confirm:"remove", tool?, scope?} delete abapsmith-owned generated ABAP',
  ].join("\n");
  const firstId = rows[0]?.id;
  const next = firstId
    ? `NEXT: abap_fluid({op:"describe",tool:"${firstId}"}) — one tool's actions, inputs and objects`
    : "NEXT: no fluid tools are loaded — check ABAP_FLUID_PLUGINS / ABAP_ALLOW_FLUID_PLUGINS if you expected any.";
  const body =
    (rows.length ? textTable(rows, ["id", "origin", "version", "actions"]) : "(no fluid tools loaded)") +
    "\n\nOPS:\n" +
    usage +
    "\n\n" +
    next;
  return buildResponse({
    header: {
      package: FLUID_PACKAGE,
      contract: FLUID_CONTRACT,
      flag_ABAP_FLUID_API: deps.cfg.fluidApi !== false,
      tools_loaded: deps.toolSet.tools.size,
    },
    sections: refusedSection(deps.toolSet),
    body,
    bodyLabel: "CATALOGUE",
    notes: [...deps.toolSet.warnings],
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

function describeToolBody(tool: LoadedFluidTool): string {
  const lines: string[] = [];
  lines.push("OBJECTS:");
  for (const o of tool.manifest.objects) {
    const entryTag = o.name === tool.manifest.entry ? " [entry]" : "";
    lines.push(`  ${o.name} (${o.type})${entryTag} — ${o.description}`);
  }
  lines.push("");
  lines.push("ACTIONS:");
  for (const a of tool.manifest.actions) {
    lines.push(`  ${a.name} [${a.category}] — ${a.description}`);
    lines.push(`    input:  ${JSON.stringify(a.input)}`);
    lines.push(`    output: ${JSON.stringify(a.output)}`);
    if (a.targets) lines.push(`    targets: ${JSON.stringify(a.targets)}`);
  }
  return lines.join("\n");
}

function renderDescribe(deps: FluidToolDeps, tool: LoadedFluidTool): string {
  return buildResponse({
    header: {
      tool: tool.manifest.id,
      title: tool.manifest.title,
      description: tool.manifest.description,
      contract: tool.manifest.contract,
      origin: tool.origin,
      version: tool.version,
      entry: tool.manifest.entry,
    },
    body: describeToolBody(tool),
    bodyLabel: "TOOL",
    maxChars: deps.cfg.maxResponseChars,
  }).text;
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

  const byTool = await deps.pool.withRead("abap_fluid.verify", async (conn) => {
    const out = new Map<string, readonly FluidObjectStatus[]>();
    for (const t of targets) out.set(t.manifest.id, await classifyFluidTool(conn, deps.cfg, t));
    return out;
  });

  const rows: Array<Record<string, string>> = [];
  let anyNotPresent = false;
  for (const t of targets) {
    for (const s of byTool.get(t.manifest.id) ?? []) {
      if (s.state !== "present") anyNotPresent = true;
      rows.push({ tool: t.manifest.id, object: s.name, type: s.type, state: s.state, foundIn: s.foundIn ?? "" });
    }
  }

  return buildResponse({
    header: { tools_checked: targets.length },
    body: rows.length ? textTable(rows, ["tool", "object", "type", "state", "foundIn"]) : "(nothing to verify)",
    bodyLabel: "OBJECTS",
    notes: anyNotPresent ? [VERIFY_STATE_NOTE] : [],
    maxChars: deps.cfg.maxResponseChars,
  }).text;
}

async function runRun(deps: FluidToolDeps, a: FluidInput): Promise<string> {
  const toolId = a.tool;
  const actionName = a.action;
  if (!toolId) throw badInput("run requires `tool`.", "tool");
  if (!actionName) throw badInput("run requires `action`.", "action");

  requireFluidEnabled(deps, { op: "run", tool: toolId, action: actionName });
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

  const targets = a.tool ? [mustGetTool(deps.toolSet, a.tool)] : [...deps.toolSet.tools.values()];
  if (targets.length === 0) throw badInput("No fluid tools are loaded; nothing to repair.", "tool");

  const key = systemKey(deps.cfg);
  const results: EnsureFluidToolResult[] = [];
  await deps.pool.withWrite("abap_fluid.repair", undefined, async (conn) => {
    for (const t of targets) {
      // MUST run before `ensureFluidTool`: its cache short-circuits on a
      // matching registry entry and returns immediately, `deployed: false`,
      // every object hardcoded "present" — no server round trip at all —
      // which is exactly the opposite of what `repair` is for.
      await forgetManifest(deps.cfg, key, t.manifest.id);
      results.push(
        await ensureFluidTool(conn, deps.safety, deps.cfg, t, {
          tool: t.manifest.id,
          action: "(repair)",
          op: "repair",
        }),
      );
    }
  });

  const rows: Array<Record<string, string>> = [];
  for (const r of results) {
    for (const s of r.objects) rows.push({ tool: r.toolId, object: s.name, type: s.type, state: s.state });
  }

  return buildResponse({
    header: { tools_repaired: results.length },
    sections: results.map((r) => ({ title: r.toolId, content: `version ${r.version}, deployed: ${r.deployed}` })),
    body: rows.length ? textTable(rows, ["tool", "object", "type", "state"]) : "(nothing to repair)",
    bodyLabel: "OBJECTS",
    maxChars: deps.cfg.maxResponseChars,
  }).text;
}

// -------------------------------------------------------------------- remove ---

interface RemoveTarget {
  readonly type: FluidObjectType;
  readonly name: string;
}

type RemoveOutcome = RemoveTarget & { readonly outcome: "deleted" | "already-absent" | "failed"; readonly error?: string };

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
  scope: "tool" | "invokers" | "all",
  toolId: string | undefined,
): Promise<{ targets: readonly RemoveTarget[]; unmappable: ReadonlyArray<{ type: string; name: string }> }> {
  if (scope === "tool") {
    const t = mustGetTool(toolSet, toolId ?? "");
    return { targets: t.manifest.objects.map((o) => ({ type: o.type, name: o.name })), unmappable: [] };
  }

  const listed = await conn.adt.nodeContents("DEVC/K", FLUID_PACKAGE);
  const targets: RemoveTarget[] = [];
  const unmappable: Array<{ type: string; name: string }> = [];
  for (const n of listed.nodes ?? []) {
    const name = n.OBJECT_NAME ?? "";
    const type = n.OBJECT_TYPE ?? "";
    if (!name) continue;
    const wanted = scope === "invokers" ? INVOKER_NAME_RE.test(name) : isReservedFluidName(name);
    if (!wanted) continue;
    if (type === "CLAS/OC" || type === "INTF/OI") {
      targets.push({ type, name });
    } else {
      unmappable.push({ type, name });
    }
  }
  return { targets, unmappable };
}

/**
 * Deleting an ABAP class kills the ADT session server-side (the next
 * request on it gets `400 Session Timed Out` / `ICMENOSESSION`), so every
 * delete after the first must survive that. Same one-shot
 * revive-and-retry-once idiom as `authorizeBridgeTarget` in `src/adt/run.ts`
 * and the `"legacy"`/`"broken"` branches of `ensureOneObject` in
 * `src/adt/fluid/ensure.ts` (both confirmed reference implementations) —
 * never a loop, exactly one `conn.connect()` and one retry.
 */
async function deleteOneFluidObject(
  conn: AbapConnection,
  gate: SafetyGate,
  target: RemoveTarget,
  reviveOnDeadSession: boolean,
): Promise<{ deleted: boolean | "unverified" }> {
  const attempt = async () => {
    const authorized = await authorizeMutation(conn, gate, "delete", { type: target.type, name: target.name });
    // NO_JOURNAL: abapsmith's own generated scaffolding, not user content —
    // same idiom as `ensureFluidPackage`/`deployBridge`.
    return deleteObject(conn, authorized, { onBeforeImage: NO_JOURNAL });
  };
  if (!reviveOnDeadSession) return attempt();
  try {
    return await attempt();
  } catch (e) {
    if (!isSessionDeadFailure(e)) throw e;
    await conn.connect();
    return attempt();
  }
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

  const key = systemKey(deps.cfg);
  const { outcomes, unmappable } = await deps.pool.withWrite("abap_fluid.remove", undefined, async (conn) => {
    const { targets, unmappable } = await removeTargets(conn, deps.toolSet, scope, a.tool);
    const outcomes: RemoveOutcome[] = [];
    let reviveOnDeadSession = false;
    for (const target of targets) {
      try {
        const del = await deleteOneFluidObject(conn, deps.safety, target, reviveOnDeadSession);
        reviveOnDeadSession = true; // a delete just happened; the NEXT request on this session may hit SESSION_DEAD
        outcomes.push({ ...target, outcome: del.deleted === false ? "failed" : "deleted" });
      } catch (e) {
        if (isAbapError(e) && e.code === "NOT_FOUND") {
          outcomes.push({ ...target, outcome: "already-absent" });
        } else {
          outcomes.push({ ...target, outcome: "failed", error: describeUnknownError(e) });
        }
        reviveOnDeadSession = false; // no delete was actually sent — nothing to revive from
      }
    }

    // Forget the registry entry for any tool any of whose manifest objects
    // was just deleted — otherwise `run`/`verify` would keep trusting a
    // cache entry for ABAP that no longer exists.
    const deletedNames = new Set(outcomes.filter((o) => o.outcome === "deleted").map((o) => o.name.toUpperCase()));
    for (const t of deps.toolSet.tools.values()) {
      if (t.manifest.objects.some((o) => deletedNames.has(o.name.toUpperCase()))) {
        await forgetManifest(deps.cfg, key, t.manifest.id);
      }
    }

    return { outcomes, unmappable };
  });

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
  mcp.registerTool(
    "abap_fluid",
    {
      title: "Fluid ABAP tool API",
      description:
        "Deploys and runs small, generated ABAP tools inside $ABAPSMITH_FLUID_API. Each fluid " +
        "tool is a manifest naming one or more generated ABAP classes/interfaces and the actions " +
        "they expose; this call deploys them on first use and re-verifies them on every call. " +
        "op: list/describe/status (zero network) inspect what is loaded and what is believed " +
        "deployed; verify asks the system directly; run (the default) executes one action, " +
        "deploying or repairing first if needed; repair forces a redeploy; remove deletes " +
        "abapsmith-owned generated ABAP. Call with no arguments for the catalogue of loaded " +
        "tools and their actions.",
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
        const isBareCall = a.op === undefined && a.tool === undefined && a.action === undefined;

        if (isBareCall) {
          requireFluidEnabled(deps, { op: "catalogue" });
          return ok(renderCatalogue(deps));
        }

        const op: FluidOp = a.op ?? "run";
        switch (op) {
          case "list":
            requireFluidEnabled(deps, { op });
            return ok(renderList(deps));
          case "describe": {
            requireFluidEnabled(deps, { op, tool: a.tool });
            if (!a.tool) throw badInput("describe requires `tool`.", "tool");
            return ok(renderDescribe(deps, mustGetTool(deps.toolSet, a.tool)));
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
