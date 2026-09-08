/**
 * The single entry point that runs one fluid tool action: enable/gate
 * checks, input validation, the safety gate over the action's OWN declared
 * targets (before any invoker exists), the ensure/deploy/execute
 * choreography, and transcript parsing. Every other fluid module is a piece
 * this one assembles — nothing here talks to `HttpClient` directly.
 */
import type { AbapConnection } from "../connection.js";
import type { Config } from "../../config.js";
import type { Operation, SafetyGate } from "../../safety.js";
import { safetyTarget } from "../../safety.js";
import type { Journal, JournalBeginInput, JournalObjectRef } from "../../journal.js";
import { systemKey } from "../../journal.js";
import { AbapError } from "../errors.js";
import { deployBridge, executeBridge, verifyBridgeActivation } from "../run.js";
import { fluidDisabledReason } from "./enabled.js";
import { ensureFluidPackage, FLUID_PACKAGE } from "./package.js";
import { ensureFluidTool } from "./ensure.js";
import { guardCoreAction } from "./builtin/core.js";
import { forgetManifest } from "./registry.js";
import { parseFluidConsole } from "./protocol.js";
import { canonicalArgsJson, invokerName, invokerSource } from "./invoke.js";
import {
  validateAgainstSchema,
  type FluidActionSpec,
  type FluidCategory,
  type LoadedFluidTool,
} from "./manifest.js";

export interface FluidDeps {
  readonly conn: AbapConnection;
  readonly cfg: Config;
  readonly gate: SafetyGate;
  readonly tools: ReadonlyMap<string, LoadedFluidTool>;
  readonly journal?: Journal;
  readonly warn?: (message: string) => void;
}

export interface FluidRunRequest {
  readonly tool: string;
  readonly action: string;
  readonly args: unknown;
  readonly confirm?: string;
  readonly corrNr?: string;
}

export interface FluidRunResult {
  readonly tool: string;
  readonly action: string;
  readonly version: string;
  readonly deployed: boolean;
  readonly ms: number;
  readonly truncated: boolean;
  readonly result: unknown;
}

/** Mirrors ensure.ts's module-private `fluidDisabledError`, minus tool/object context this check runs before resolving. */
function dispatchDisabledError(
  reason: NonNullable<ReturnType<typeof fluidDisabledReason>>,
  cfg: Config,
  req: FluidRunRequest,
): AbapError {
  const flagEnabled = cfg.fluidApi !== false;
  const details: Record<string, unknown> = {
    reason: reason.kind,
    ...(reason.kind === "flag" ? {} : { field: reason.field }),
    flag: "ABAP_FLUID_API",
    flagEnabled,
    package: FLUID_PACKAGE,
    tool: req.tool,
    action: req.action,
  };

  const who = `${req.tool}.${req.action}`;

  const message =
    reason.kind === "flag"
      ? `The fluid API is disabled (ABAP_FLUID_API=false). ${who} was not run — nothing was ` +
        `deployed, checked, or changed.`
      : `${who} needs the fluid API, and this connection is read-only (${reason.field}). There is ` +
        `no read-only subset of the fluid API — even a check can need to deploy or repair the ABAP ` +
        `side first, so nothing ran and nothing was changed.`;

  const hint =
    reason.kind === "flag"
      ? "Set ABAP_FLUID_API=true (or leave it unset — it defaults to enabled) to use the fluid API. " +
        "The ordinary write ceilings (ABAP_ALLOW_WRITE, ABAP_MODE, the productive-system lockout, " +
        "ABAP_ALLOW_PACKAGES) still apply on top once it is."
      : "Connect with write access (ABAP_ALLOW_WRITE=true, ABAP_MODE not \"read\", and off a " +
        "productive system) to use any part of the fluid API.";

  return new AbapError("FLUID_API_DISABLED", message, details, hint);
}

type PointerResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/** RFC 6901. `~1`/`~0` decode in that order — the reverse would mangle a token containing a literal `~1`. */
function resolvePointer(doc: unknown, pointer: string): PointerResult {
  if (pointer === "") return { ok: true, value: doc };
  if (!pointer.startsWith("/")) return { ok: false };
  const tokens = pointer.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = doc;
  for (const token of tokens) {
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= cur.length) return { ok: false };
      cur = cur[Number(token)];
    } else if (cur !== null && typeof cur === "object") {
      if (!Object.prototype.hasOwnProperty.call(cur, token)) return { ok: false };
      cur = (cur as Record<string, unknown>)[token];
    } else {
      return { ok: false };
    }
  }
  return { ok: true, value: cur };
}

function resolveTargetString(args: unknown, pointer: string, field: string): string {
  const r = resolvePointer(args, pointer);
  if (!r.ok || typeof r.value !== "string") {
    throw new AbapError(
      "BAD_INPUT",
      `action target "${field}" (pointer "${pointer}") did not resolve to a string in args.`,
      { field, pointer },
    );
  }
  return r.value;
}

function gateOpForCategory(category: FluidCategory): Operation {
  switch (category) {
    case "read":
      return "read";
    case "execute":
      return "execute";
    case "mutate":
      return "write";
  }
}

/**
 * Resolves the action's declared targets out of `args` and hands them to the
 * gate BEFORE any invoker exists — the generated invoker's own URI (a class
 * in $ABAPSMITH_FLUID_API) is always harmless, so checking it instead of the
 * action's real targets would defeat the whole point of gating fluid calls.
 */
function assertTargetsAgainstGate(
  gate: SafetyGate,
  action: FluidActionSpec,
  args: unknown,
  origin: LoadedFluidTool["origin"],
): void {
  const targets = action.targets;
  if (!targets) return;
  const resolvedObject = targets.object !== undefined ? resolveTargetString(args, targets.object, "object") : undefined;
  const resolvedPackage = targets.package !== undefined ? resolveTargetString(args, targets.package, "package") : undefined;
  const resolvedTransport =
    targets.transport !== undefined ? resolveTargetString(args, targets.transport, "transport") : undefined;
  const target = safetyTarget({
    name: resolvedObject ?? resolvedPackage ?? "",
    ...(resolvedPackage !== undefined ? { packageName: resolvedPackage } : {}),
  });
  // `corr: "local"` only binds for a builtin tool — a plugin manifest cannot self-declare its
  // way past the transport allowlist by claiming an action registers nothing in CTS.
  const corr = targets.corr === "local" && origin === "builtin" ? ({ kind: "local" } as const) : undefined;
  gate.assert(gateOpForCategory(action.category), target, {
    ...(resolvedTransport !== undefined ? { corrNr: resolvedTransport } : {}),
    ...(corr !== undefined ? { corr } : {}),
  });
}

async function journalFluidMutate(
  deps: FluidDeps,
  req: FluidRunRequest,
  sysKey: string,
): Promise<void> {
  const journal = deps.journal;
  if (!journal) return;

  const object: JournalObjectRef = {
    name: `${req.tool}.${req.action}`,
    type: "FLUID",
    uri: "",
    package: FLUID_PACKAGE,
    description: `fluid plugin mutate: ${req.tool}.${req.action}`,
  };
  const beginInput: JournalBeginInput = {
    operation: "update",
    object,
    existedBefore: true,
    // No before-image exists for whatever ABAP-side state a plugin action touched — this framework
    // never reads it, so "captured"/"failed" would both overstate what is known.
    beforeCapture: "unknown",
    // No generic undo exists for an arbitrary plugin mutate action.
    irreversible: true,
    systemKey: sysKey,
    ...(req.corrNr !== undefined ? { corrNr: req.corrNr } : {}),
    trSource: "caller",
    tool: req.tool,
  };

  let entry;
  try {
    entry = await journal.begin(beginInput);
  } catch (e) {
    deps.warn?.(
      `[abapsmith] WARNING: ${req.tool}.${req.action} — the mutation DID happen but could NOT be journalled: ${(e as Error).message}.`,
    );
    return;
  }
  if (!entry) return;

  try {
    const settled = await journal.settle(entry.id, { outcome: "succeeded" });
    if (!settled.settled) {
      deps.warn?.(
        `[abapsmith] WARNING: ${req.tool}.${req.action} — journal entry ${entry.id} could not be settled (${settled.reason}).`,
      );
    }
  } catch (e) {
    deps.warn?.(
      `[abapsmith] WARNING: ${req.tool}.${req.action} — journal entry ${entry.id} could not be settled (${(e as Error).message}).`,
    );
  }
}

export async function dispatch(deps: FluidDeps, req: FluidRunRequest): Promise<FluidRunResult> {
  const disabled = fluidDisabledReason(deps.cfg, deps.gate);
  if (disabled) throw dispatchDisabledError(disabled, deps.cfg, req);

  const tool = deps.tools.get(req.tool);
  if (!tool) {
    throw new AbapError(
      "BAD_INPUT",
      `Unknown fluid tool "${req.tool}". Available tools: ${[...deps.tools.keys()].sort().join(", ") || "(none)"}.`,
      { field: "tool", tool: req.tool, available: [...deps.tools.keys()].sort() },
    );
  }
  const action = tool.manifest.actions.find((a) => a.name === req.action);
  if (!action) {
    const available = tool.manifest.actions.map((a) => a.name).sort();
    throw new AbapError(
      "BAD_INPUT",
      `Unknown action "${req.action}" for fluid tool "${req.tool}". Available actions: ${available.join(", ") || "(none)"}.`,
      { field: "action", tool: req.tool, action: req.action, available },
    );
  }

  if (tool.origin === "plugin") {
    if (!deps.cfg.allowFluidPlugins) {
      throw new AbapError(
        "FLUID_PLUGINS_DISABLED",
        `Plugin fluid tools are disabled (ABAP_ALLOW_FLUID_PLUGINS=false). ${req.tool}.${req.action} was not run.`,
        { tool: req.tool, action: req.action },
      );
    }
    if (action.category === "mutate") {
      if (!deps.cfg.allowFluidPluginMutate) {
        throw new AbapError(
          "FLUID_PLUGIN_MUTATE_DISABLED",
          `Mutating plugin fluid actions are disabled (ABAP_ALLOW_FLUID_PLUGIN_MUTATE=false). ` +
            `${req.tool}.${req.action} was not run.`,
          { tool: req.tool, action: req.action },
        );
      }
      const expectedConfirm = `${req.tool}.${req.action}`;
      if (req.confirm !== expectedConfirm) {
        throw new AbapError(
          "BAD_INPUT",
          `${req.tool}.${req.action} mutates state and requires confirm: ${JSON.stringify(expectedConfirm)} ` +
            `(got ${req.confirm === undefined ? "nothing" : JSON.stringify(req.confirm)}).`,
          { field: "confirm", expected: expectedConfirm, got: req.confirm },
        );
      }
    }
  }

  // Built-in `core` carries policy the manifest cannot express: `select` is judged by the
  // data-preview policy, `call_fm` by ABAP_ALLOW_FLUID_CALL_FM plus a per-call confirm echo.
  // One call site, one builtin — deliberately not a generic per-builtin hook.
  await guardCoreAction(deps, req);

  const inputErrors = validateAgainstSchema(req.args, action.input, "args");
  if (inputErrors.length > 0) {
    throw new AbapError(
      "BAD_INPUT",
      `${req.tool}.${req.action}: invalid arguments.`,
      { tool: req.tool, action: req.action, messages: inputErrors },
    );
  }

  assertTargetsAgainstGate(deps.gate, action, req.args, tool.origin);

  await ensureFluidPackage(deps.conn, deps.gate);
  const sysKey = systemKey(deps.conn.cfg);
  const ensureResult = await ensureFluidTool(deps.conn, deps.gate, deps.cfg, tool, {
    tool: req.tool,
    action: req.action,
    op: "run",
  });

  const contract = tool.manifest.contract;
  const name = invokerName(req.tool, req.action, req.args, contract);
  const argsJson = canonicalArgsJson(req.args);
  const source = invokerSource({
    name,
    entry: tool.manifest.entry,
    toolId: req.tool,
    action: req.action,
    argsJson,
    version: tool.version,
    contract,
    commit: action.category === "mutate",
  });

  const deployedBridge = await deployBridge(deps.conn, deps.gate, {
    className: name,
    source,
    description: `fluid invoker for ${req.tool}.${req.action}`,
    packageName: FLUID_PACKAGE,
    what: `Activation of the generated fluid invoker ${name}`,
    verify: (activation) => verifyBridgeActivation(activation, name, "fluid invoker"),
  });
  const run = await executeBridge(deps.conn, deps.gate, deployedBridge);

  const transcript = parseFluidConsole(run.output);
  if (transcript.errors.length > 0) {
    throw new AbapError(
      "FLUID_ACTION_FAILED",
      `${req.tool}.${req.action} reported ${transcript.errors.length} error frame(s).`,
      { tool: req.tool, action: req.action, frames: transcript.errors },
    );
  }
  // Checked only once ERR is ruled out above: a mid-run abort after the invoker's CATCH arm
  // prints ERR but never reaches END must surface as the plugin's own failure, not this.
  if (!transcript.end) {
    throw new AbapError(
      "FLUID_PROTOCOL_ERROR",
      `${req.tool}.${req.action}: the fluid transcript has no END frame and reported no errors — the ` +
        `ABAP side dumped before it could report anything.`,
      { tool: req.tool, action: req.action },
    );
  }

  const begin = transcript.begin;
  if (begin && (begin.id !== req.tool || begin.action !== req.action)) {
    throw new AbapError(
      "FLUID_PROTOCOL_ERROR",
      `${req.tool}.${req.action}: the transcript's BEGIN frame reports ${begin.id}.${begin.action}, not the ` +
        `requested call — a stale invoker class or program buffer served a different action.`,
      { tool: req.tool, action: req.action, beginId: begin.id, beginAction: begin.action },
    );
  }
  // Checked only once identity is confirmed above — ver is meaningless to act on when the BEGIN
  // frame may belong to an entirely different call.
  if (begin && begin.ver !== tool.version) {
    await forgetManifest(deps.cfg, sysKey, tool.manifest.id);
  }

  // No ERR frame (checked above) means the invoker's own COMMIT WORK already ran — the mutation
  // is real regardless of what a later, purely local check (output shape) thinks of it, so it
  // must be journalled here rather than after checks that can still throw.
  if (tool.origin === "plugin" && action.category === "mutate" && deps.journal) {
    await journalFluidMutate(deps, req, sysKey);
  }

  let result: unknown;
  if (action.output.type === "array") {
    result = transcript.values;
  } else {
    if (transcript.values.length !== 1) {
      throw new AbapError(
        "FLUID_PROTOCOL_ERROR",
        `${req.tool}.${req.action}: expected exactly one output value, got ${transcript.values.length}.`,
        { tool: req.tool, action: req.action, count: transcript.values.length },
      );
    }
    result = transcript.values[0];
  }

  const outputErrors = validateAgainstSchema(result, action.output, "result");
  if (outputErrors.length > 0) {
    throw new AbapError(
      "FLUID_PROTOCOL_ERROR",
      `${req.tool}.${req.action}: output did not match the declared schema.`,
      { tool: req.tool, action: req.action, messages: outputErrors },
    );
  }

  return {
    tool: req.tool,
    action: req.action,
    version: tool.version,
    deployed: ensureResult.deployed || deployedBridge.bridgeRefreshed,
    ms: transcript.end.ms,
    truncated: transcript.end.truncated,
    result,
  };
}
