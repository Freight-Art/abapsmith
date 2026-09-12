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
import { AbapError, isAbapError } from "../errors.js";
import { deployBridge, executeBridge, verifyBridgeActivation } from "../run.js";
import { activateObject, assertNoErrors } from "../activate.js";
import { authorizeMutation } from "../write.js";
import { fluidDisabledReason } from "./enabled.js";
import { ensureFluidPackage, FLUID_PACKAGE } from "./package.js";
import {
  anyFluidObjectMissing,
  ensureFluidRuntimeFor,
  ensureFluidTool,
  recoverMissingFluidObject,
} from "./ensure.js";
import { guardCoreAction } from "./builtin/core.js";
import { parseFluidConsole, type FluidBeginFrame, type FluidEndFrame, type FluidTranscript } from "./protocol.js";
import { canonicalArgsJson, invokerName, invokerSource } from "./invoke.js";
import {
  validateAgainstSchema,
  type FluidActionSpec,
  type FluidCategory,
  type LoadedFluidTool,
} from "./manifest.js";
import { truncateText } from "../../truncate.js";

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
  /**
   * Set when a dedicated MCP tool reroutes through `dispatch()` instead of
   * deploying its own bridge — mirrors `DeployBridgeOptions.caller` in run.ts
   * so a `FLUID_API_DISABLED` refusal names the tool the caller actually
   * invoked, not the internal fluid tool/action `dispatch` runs it as.
   */
  readonly caller?: { readonly tool: string; readonly action: string };
}

export interface FluidRunResult {
  readonly tool: string;
  readonly action: string;
  readonly version: string;
  readonly deployed: boolean;
  readonly ms: number;
  readonly truncated: boolean;
  /**
   * Non-fatal transcript oddities, human-readable and never truncated:
   * `transcript.stray` (console output outside the frame grammar) and
   * `transcript.dropped` (a value the frame grammar could not reassemble or
   * parse — protocol.ts only ever produces one alongside an ERR frame, so in
   * practice it reaches the caller through the `FLUID_ACTION_FAILED` error's
   * own details rather than through this field). Empty when the transcript
   * was clean. Never the reason a call fails.
   */
  readonly warnings: readonly string[];
  readonly result: unknown;
}

/**
 * `req.caller`, when set, is who a user-facing refusal names — the MCP tool a
 * reroute answers to, not the internal fluid tool/action `dispatch` runs it
 * as. Absent, every field is exactly what it always was: the fluid tool/action
 * itself, dot-joined for `who` — abap_fluid's own direct calls have no
 * separate caller and must not shift by one character.
 */
function callerAttribution(req: FluidRunRequest): { readonly tool: string; readonly action: string; readonly who: string } {
  return {
    tool: req.caller?.tool ?? req.tool,
    action: req.caller?.action ?? req.action,
    who: req.caller ? `${req.caller.tool} ${req.caller.action}` : `${req.tool}.${req.action}`,
  };
}

/** Mirrors ensure.ts's module-private `fluidDisabledError`, minus tool/object context this check runs before resolving. */
export function dispatchDisabledError(
  reason: NonNullable<ReturnType<typeof fluidDisabledReason>>,
  cfg: Config,
  req: FluidRunRequest,
): AbapError {
  const flagEnabled = cfg.fluidApi !== false;
  const { tool, action, who } = callerAttribution(req);
  const details: Record<string, unknown> = {
    reason: reason.kind,
    ...(reason.kind === "flag" ? {} : { field: reason.field }),
    flag: "ABAP_FLUID_API",
    flagEnabled,
    package: FLUID_PACKAGE,
    tool,
    action,
  };

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

/** Bounds the args JSON recorded in the journal description; truncation is disclosed by `truncateText`. */
const JOURNAL_ARGS_MAX = 500;

/**
 * Journals one fluid mutate action's completion — builtin or plugin alike. No before-image is
 * ever captured (see below), so this is always a bare "it happened" entry rather than a
 * richer, undoable one.
 */
async function journalFluidMutate(
  deps: FluidDeps,
  req: FluidRunRequest,
  sysKey: string,
  origin: LoadedFluidTool["origin"],
): Promise<void> {
  const journal = deps.journal;
  if (!journal) return;

  const argsText = truncateText(canonicalArgsJson(req.args), JOURNAL_ARGS_MAX);

  const object: JournalObjectRef = {
    name: `${req.tool}.${req.action}`,
    type: "FLUID",
    uri: "",
    package: FLUID_PACKAGE,
    description: `fluid ${origin} mutate: ${req.tool}.${req.action} args=${argsText}`,
  };
  const beginInput: JournalBeginInput = {
    operation: "update",
    object,
    existedBefore: true,
    // No before-image exists for whatever ABAP-side state a fluid action touched — this framework
    // never reads it, so "captured"/"failed" would both overstate what is known.
    beforeCapture: "unknown",
    // No generic undo exists for an arbitrary fluid mutate action, builtin or plugin — this
    // framework never captures a before-image for one.
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

/**
 * Force the generated fluid invoker `invokerClassName` to actually
 * (re)activate — bypassing `deployBridge`'s own "nothing to do" shortcut —
 * so a stale generated program gets regenerated before it is run again.
 *
 * Only called from `dispatch`'s recovery path, once, right after
 * `recoverMissingFluidObject` has redeployed whatever fluid body class the
 * invoker depends on. Plain reactivation, the same primitive ensure.ts's own
 * `"inactive"` classification branch uses (`authorizeMutation` +
 * `activateObject` + `assertNoErrors`) — not a rewrite: the invoker's source
 * is unchanged (still the correct, deterministic program for this
 * tool/action/args), only its compiled program was left invalid by the
 * dependency that just came back.
 *
 * A `NOT_FOUND` here means the invoker itself doesn't exist (yet, or ever)
 * on this connection — nothing to force, and no bug: the retry's own
 * `deployBridge` creates it fresh in that case, which activates
 * unconditionally (F6's shortcut only ever applies to an object that already
 * existed unchanged). Anything else propagates: an activation that still
 * fails here is a real, distinct problem (e.g. the dependency `ensureFluidTool`
 * "recovered" is itself still broken), not one this function papers over.
 */
async function forceInvokerRegeneration(deps: FluidDeps, invokerClassName: string): Promise<void> {
  let authorized;
  try {
    authorized = await authorizeMutation(deps.conn, deps.gate, "activate", {
      type: "CLAS/OC",
      name: invokerClassName,
    });
  } catch (e) {
    if (isAbapError(e) && e.code === "NOT_FOUND") return;
    throw e;
  }
  const activation = await activateObject(deps.conn, authorized.target);
  assertNoErrors(activation, {
    what: `Force-regenerate the fluid invoker ${invokerClassName} after recovering its dependency`,
    name: invokerClassName,
  });
}

/**
 * `stray` and `dropped` are informational, not action failures — protocol.md
 * documents both as reported to the caller rather than silently discarded.
 * `dropped` is only ever populated alongside at least one ERR frame
 * (parseFluidConsole's own invariant: an unparseable reassembled value is
 * swallowed as "dropped" instead of thrown only because an ERR frame already
 * explains the failure), so in practice this only ever surfaces a `dropped`
 * entry when called from the `FLUID_ACTION_FAILED` branch below — a
 * transcript with `dropped.length > 0` and `errors.length === 0` cannot
 * occur.
 */
function buildWarnings(transcript: FluidTranscript): readonly string[] {
  const warnings: string[] = [];
  for (const line of transcript.stray) {
    warnings.push(`stray console output: ${line}`);
  }
  for (const d of transcript.dropped) {
    warnings.push(`a value starting at line ${d.lineNumber} could not be parsed and was dropped: ${d.raw}`);
  }
  return warnings;
}

/**
 * Everything about a transcript that identifies it as belonging to this
 * call, independent of whether the deployed build's version matches: ERR
 * frames, a missing END, and a BEGIN naming a different tool/action. A
 * BEGIN.ver mismatch is deliberately not checked here — the caller runs this
 * once against the first transcript and, on a ver mismatch, again against a
 * second transcript from a forced redeploy, so it owns that check itself
 * rather than duplicating this function per attempt.
 */
interface TranscriptIdentity {
  readonly begin: FluidBeginFrame | undefined;
  // Narrowed out of `FluidEndFrame | undefined` below — returned rather than left for the
  // caller to re-check so a `transcript.end.ms` after this call doesn't need its own guard.
  readonly end: FluidEndFrame;
}

function assertTranscriptIdentity(transcript: FluidTranscript, req: FluidRunRequest): TranscriptIdentity {
  // Errors name the caller the way the caller knows itself: a dedicated tool routed through
  // dispatch is reported as that tool, a direct abap_fluid call as `<tool>.<action>`.
  const { tool: attrTool, action: attrAction, who } = callerAttribution(req);
  if (transcript.errors.length > 0) {
    throw new AbapError(
      "FLUID_ACTION_FAILED",
      `${who} reported ${transcript.errors.length} error frame(s).`,
      {
        tool: attrTool,
        action: attrAction,
        frames: transcript.errors,
        warnings: buildWarnings(transcript),
      },
    );
  }
  // Checked only once ERR is ruled out above: a mid-run abort after the invoker's CATCH arm
  // prints ERR but never reaches END must surface as the plugin's own failure, not this.
  if (!transcript.end) {
    throw new AbapError(
      "FLUID_PROTOCOL_ERROR",
      `${who}: the fluid transcript has no END frame and reported no errors — the ` +
        `ABAP side dumped before it could report anything.`,
      { tool: attrTool, action: attrAction },
    );
  }
  const end = transcript.end;

  const begin = transcript.begin;
  if (begin && (begin.id !== req.tool || begin.action !== req.action)) {
    throw new AbapError(
      "FLUID_PROTOCOL_ERROR",
      `${who}: the transcript's BEGIN frame reports ${begin.id}.${begin.action}, not the ` +
        `requested call — a stale invoker class or program buffer served a different action.`,
      { tool: attrTool, action: attrAction, beginId: begin.id, beginAction: begin.action },
    );
  }
  return { begin, end };
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
    const { tool: attrTool, action: attrAction, who } = callerAttribution(req);
    throw new AbapError(
      "BAD_INPUT",
      `${who}: invalid arguments.`,
      { tool: attrTool, action: attrAction, messages: inputErrors },
    );
  }

  assertTargetsAgainstGate(deps.gate, action, req.args, tool.origin);

  await ensureFluidPackage(deps.conn, deps.gate);
  const sysKey = systemKey(deps.conn.cfg);

  // Pure and stable for the whole call, including across the one retry below:
  // no input it depends on (req.tool/action/args, the manifest's contract,
  // entry, version) changes between the first attempt and the recovery
  // retry, so both `runDeployAndExecute` and `forceInvokerRegeneration`
  // (below) must name the exact same generated class.
  const contract = tool.manifest.contract;
  const invokerClassName = invokerName(req.tool, req.action, req.args, contract);

  // Everything the on-disk registry's cached "deployed: true" answer can lie
  // about lives inside this one function: `ensureFluidTool`'s fast path can
  // report every manifest object `"present"` for a tool the server no longer
  // has (see ensure.ts's doc comment on that short-circuit), and the invoker
  // this then builds statically calls the tool's entry class by name — a
  // deploy or an execute against either a vanished body class or a vanished
  // invoker can surface as `NOT_FOUND`, `RUNTIME_DUMP` (a stale, unchanged
  // invoker's compiled program dumps at execution), or `CHECK_FAILED` (a
  // freshly written/reactivated invoker fails its own activation check
  // against the now-dangling reference) depending on `deployBridge`'s F6
  // shortcut — see `anyFluidObjectMissing`'s doc in ensure.ts for the full
  // shape-by-shape breakdown and why the catch below decides on a live
  // existence probe rather than on which of those codes it caught.
  // Deliberately NOT included: `guardCoreAction` and schema validation above
  // (already run, and a `NOT_FOUND` there is about the CALL's own shape, not
  // a deployment fact) and the transcript/output parsing below (local,
  // synchronous, no server round trip — a `NOT_FOUND`-shaped answer from the
  // ABAP body's own application logic, e.g. "no such user-supplied object
  // name", is caught by the invoker's TRY/CATCH and comes back as an ERR
  // frame in `transcript`, not as a thrown `AbapError`, so it can never reach
  // this catch in the first place).
  const runDeployAndExecute = async () => {
    // Both a plugin's ABAP body and its generated invoker hard-call the fluid runtime class by
    // name, but no plugin manifest may declare that class itself (the loader's namespace rule
    // refuses it) — so nothing else ever deploys it for a plugin. No-op for a builtin tool, which
    // already owns the runtime class in its own manifest. Must run before `ensureFluidTool`: the
    // plugin body it deploys next depends on the runtime class already existing.
    await ensureFluidRuntimeFor(deps.conn, deps.gate, deps.cfg, tool, {
      tool: req.tool,
      action: req.action,
      op: "run",
    });

    const ensureResult = await ensureFluidTool(deps.conn, deps.gate, deps.cfg, tool, {
      tool: req.tool,
      action: req.action,
      op: "run",
    });

    const name = invokerClassName;
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

    return { ensureResult, deployedBridge, run };
  };

  // Shared by two independent triggers below: an exception straight out of `runDeployAndExecute`
  // (the catch block right after this) and a BEGIN.ver mismatch on an otherwise-clean transcript
  // (further down, once frame identity is already confirmed). Both need the exact same recovery —
  // forget the registry's cached entry, let `ensureFluidTool` re-classify and redeploy whatever the
  // manifest says should be there, force the generated invoker to recompile against whatever came
  // back, then run the whole deploy+execute range again — so it is written once here rather than
  // twice. Neither caller loops on this; each site calls it at most once per dispatch.
  //
  // The force-regenerate step matters even though `recoverMissingFluidObject` just redeployed:
  // it only touches the fluid BODY classes tracked in the manifest and has no idea the generated
  // invoker even exists. When the invoker itself was left referencing a dependency that just came
  // back (the classic shape: a body class deleted out of band, then restored), it is untouched by
  // that redeploy — `deployBridge`'s own F6 shortcut (see its doc, src/adt/run.ts) skips the
  // activation POST whenever the invoker's source hash is unchanged AND its `adtcore:version`
  // metadata already says "active", both true here since nothing about the invoker's OWN row
  // changed. Left alone, the retry below would call `deployBridge` again, hit that exact same
  // shortcut, skip activation again, and `executeBridge` would re-run the still unregenerated
  // invoker and fail identically a second time. Forcing a real activation here — outside
  // `deployBridge`, after the dependency it needs is back — is what actually gets the invoker's
  // program regenerated against the now-valid dependency before the retry runs it. (When the
  // triggering failure doesn't fit that shape, the retry's own `deployBridge` already activates
  // unconditionally, so this call is a harmless, already-active no-op; see
  // `forceInvokerRegeneration`'s own doc.)
  const redeployAndRetryOnce = async () => {
    await recoverMissingFluidObject(deps.conn, deps.gate, deps.cfg, tool, {
      tool: req.tool,
      action: req.action,
      op: "run",
    });
    await forceInvokerRegeneration(deps, invokerClassName);
    return runDeployAndExecute();
  };

  let ensureResult: Awaited<ReturnType<typeof runDeployAndExecute>>["ensureResult"];
  let deployedBridge: Awaited<ReturnType<typeof runDeployAndExecute>>["deployedBridge"];
  let run: Awaited<ReturnType<typeof runDeployAndExecute>>["run"];
  try {
    ({ ensureResult, deployedBridge, run } = await runDeployAndExecute());
  } catch (e) {
    // Not an `AbapError` at all (a programming defect, a thrown string,
    // whatever) — nothing below can classify it, and paying for a
    // reconnect-plus-probe on something that isn't even a server response
    // would be pure cost for no benefit. Propagate immediately.
    //
    // Also gate on the error's own `code` — a discrete, structured value the
    // error-mapping layer already assigns, not free text prose — before
    // paying for a probe at all. This is deliberately narrower than "any
    // AbapError": `ensureFluidTool`'s own policy checks throw plenty of
    // AbapErrors that have nothing to do with a missing manifest object and
    // must never even be probed, let alone recovered — e.g.
    // `FLUID_OBJECT_CONFLICT` (the object exists, just in a package
    // abapsmith doesn't own: a legitimate, non-retryable refusal) or
    // `FLUID_API_DISABLED` (a feature flag, not a server fact about any
    // object at all). Probing those would be wasted GETs at best and could
    // in principle race a policy refusal against a same-named object
    // appearing/disappearing elsewhere. `NOT_FOUND`, `RUNTIME_DUMP`, and
    // `CHECK_FAILED` are the three shapes `deployBridge`/`executeBridge`
    // actually produce for a genuinely missing dependency (see
    // `anyFluidObjectMissing`'s doc in ensure.ts for the shape-by-shape
    // breakdown) — anything else is either a non-deployment refusal like the
    // two above, or a defect this mechanism has no business papering over.
    if (!isAbapError(e)) throw e;
    if (e.code !== "NOT_FOUND" && e.code !== "RUNTIME_DUMP" && e.code !== "CHECK_FAILED") throw e;

    // A dump-classified response doesn't just kill the local ABAP session
    // the way `run.ts`'s own `invalidateSession` (a same-file, same-request
    // reset of `csrfToken`) suggests — `connection.ts`'s `noteWireResponse`
    // classifies that exact 500-with-dump-markers response ITSELF,
    // independently, and calls `markDead()` on the whole `AbapConnection`:
    // every request on it (`conn.get`, `conn.adt.*`, everything
    // `authorizeMutation`/`writeObject`/`activateObject`/`ensureFluidTool`
    // issue) throws `SESSION_DEAD` from `assertUsable()` until something
    // calls `connect()` again — live-verified by this file's own offline
    // retry-mechanics test, which failed with exactly that `SESSION_DEAD`
    // before this line was added. Every other failure shape below
    // (`NOT_FOUND`, `CHECK_FAILED`) never marks the connection dead, so for
    // those this is a no-op: `connect()`'s `connectUnderLock()` returns
    // immediately, no network call, whenever `this.connected` is still
    // `true`. Must run BEFORE the existence probe below, which needs a live
    // connection to do anything at all.
    await deps.conn.connect();

    // The decision point: was anything the tool's manifest declares actually
    // proven missing on the server just now? This replaces an earlier
    // approach that matched on the failing `AbapError`'s own code and
    // message text — see `anyFluidObjectMissing`'s doc in ensure.ts for why
    // that missed the dominant real-world shape (a fresh/reactivating
    // invoker fails its OWN activation check with `CHECK_FAILED`, not a
    // `RUNTIME_DUMP`, whenever `deployBridge`'s F6 shortcut does not engage —
    // e.g. args never dispatched before on this connection). A `CHECK_FAILED`
    // (or anything else) with every manifest object present is a genuine
    // codegen defect, not a dependency drift, and must propagate unchanged —
    // `anyFluidObjectMissing` answers `false` for exactly that case.
    const missing = await anyFluidObjectMissing(deps.conn, tool);
    if (!missing) throw e;

    // No commit can have happened yet: a failure out of `ensureFluidTool` or
    // `deployBridge` never reaches `executeBridge` at all, and either out of
    // `executeBridge` itself means the classrun POST was refused, or the
    // class dumped, before the ABAP side could commit anything — the
    // invoker's own COMMIT WORK (see the note above `journalFluidMutate`
    // below) cannot have executed. So recovering and re-running the whole
    // range here can never double-commit or double-journal a mutation that
    // already went through.
    // Exactly one retry: this second call sits outside any try/catch of its
    // own, so a failure here — the object is still broken even after
    // recovery — propagates to the caller unchanged rather than looping.
    ({ ensureResult, deployedBridge, run } = await redeployAndRetryOnce());
  }

  let transcript = parseFluidConsole(run.output);
  let identity = assertTranscriptIdentity(transcript, req);

  // A BEGIN.ver mismatch means a build that isn't what the manifest says should be deployed
  // actually ran and reported success — the registry's cached entry lied, or something
  // redeployed a different version out of band. Forgetting and redeploying once via the same
  // machinery as the catch block above, then re-validating the retry's own transcript from
  // scratch (its BEGIN could just as easily fail an identity check as a ver check), is the only
  // way to avoid handing the caller a result that didn't come from the build it names.
  if (identity.begin && identity.begin.ver !== tool.version) {
    const expectedVersion = tool.version;
    ({ ensureResult, deployedBridge, run } = await redeployAndRetryOnce());
    transcript = parseFluidConsole(run.output);
    identity = assertTranscriptIdentity(transcript, req);
    if (identity.begin && identity.begin.ver !== expectedVersion) {
      throw new AbapError(
        "FLUID_PROTOCOL_ERROR",
        `${req.tool}.${req.action}: the BEGIN frame still reports ver ${identity.begin.ver} after forgetting the ` +
          `registry entry and redeploying once — expected ${expectedVersion}.`,
        { tool: req.tool, action: req.action, expected: expectedVersion, got: identity.begin.ver },
      );
    }
  }

  // No ERR frame (checked above) means the invoker's own COMMIT WORK already ran — the mutation
  // is real regardless of what a later, purely local check (output shape) thinks of it, so it
  // must be journalled here rather than after checks that can still throw. This covers BOTH
  // builtin and plugin mutate actions: a builtin mutate reached through the `abap_fluid` MCP tool
  // is journalled here; the legacy owning tools — abap_enh, abap_img_edit, abap_ui, classic-call,
  // customizing-request — call dispatch() WITHOUT a journal and write their own richer entries
  // with before-images, so they are not double-journalled.
  if (action.category === "mutate" && deps.journal) {
    await journalFluidMutate(deps, req, sysKey, tool.origin);
  }

  let result: unknown;
  if (action.output.type === "array") {
    result = transcript.values;
  } else if (action.output.type === undefined) {
    // No declared output shape — the action legitimately emits nothing. An END with zero OUT and
    // zero ERR (both already ruled out as failure above) is success, not a silently-swallowed body.
    if (transcript.values.length !== 0) {
      const { tool: attrTool, action: attrAction, who } = callerAttribution(req);
      throw new AbapError(
        "FLUID_PROTOCOL_ERROR",
        `${who}: expected no output value (void), got ${transcript.values.length}.`,
        { tool: attrTool, action: attrAction, count: transcript.values.length },
      );
    }
    result = undefined;
  } else {
    if (transcript.values.length !== 1) {
      const { tool: attrTool, action: attrAction, who } = callerAttribution(req);
      throw new AbapError(
        "FLUID_PROTOCOL_ERROR",
        `${who}: expected exactly one output value, got ${transcript.values.length}.`,
        { tool: attrTool, action: attrAction, count: transcript.values.length },
      );
    }
    result = transcript.values[0];
  }

  const outputErrors = validateAgainstSchema(result, action.output, "result");
  if (outputErrors.length > 0) {
    const { tool: attrTool, action: attrAction, who } = callerAttribution(req);
    throw new AbapError(
      "FLUID_PROTOCOL_ERROR",
      `${who}: output did not match the declared schema.`,
      { tool: attrTool, action: attrAction, messages: outputErrors },
    );
  }

  return {
    tool: req.tool,
    action: req.action,
    version: tool.version,
    deployed: ensureResult.deployed || deployedBridge.bridgeRefreshed,
    ms: identity.end.ms,
    truncated: identity.end.truncated,
    warnings: buildWarnings(transcript),
    result,
  };
}
