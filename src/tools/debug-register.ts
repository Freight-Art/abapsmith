/**
 * MCP registration for `abap_debug`, `abap_debug_vars`, `abap_debug_value`.
 *
 * Deliberately separate from `debug.ts`: `test/server-debug-gate.test.ts`
 * mocks `abapDebug` via `vi.mock("../src/tools/debug.js")`, which cannot
 * intercept a module calling its own export — registering from here keeps
 * the mock boundary where the test needs it. Full rationale archived in
 * the git history.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AbapError } from "../adt/errors.js";
import type { SessionPool } from "../adt/pool.js";
import type { Config } from "../config.js";
import type { SafetyGate } from "../safety.js";
import {
  abapDebug,
  abapDebugValue,
  abapDebugVars,
  debugInputSchema,
  debugValueInputSchema,
  debugVarsInputSchema,
  type DebugInput,
  type DebugToolDeps,
  type DebugValueInput,
  type DebugVarsInput,
} from "./debug.js";
import { preflight } from "./preflight.js";
import { parseBreakpoints } from "./v2/breakpoints.js";

/**
 * `abap_debug` actions needing no `execute` gate at this layer: reads
 * (`stack`/`status`/`frame`), `keepalive` (idle timer only), and `stop`
 * (risk-reducing). `frame` only moves the debugger's read cursor
 * (live-verified against A4H); `keepalive`/`stop` are instead gated one
 * layer down in `debug.ts`, against the object the session actually started
 * against. Exempt list, not gated list: new actions default to GATED.
 */
const DEBUG_UNGATED_ACTIONS: ReadonlySet<string> = new Set(["stack", "frame", "status", "keepalive", "stop"]);

/** Extracts `stateId: <id>` from a rendered debug response header, if present (absent when the session just died). */
function stateIdOfResponse(text: string): string | undefined {
  return /^stateId: (.+)$/m.exec(text)?.[1]?.trim();
}

export interface DebugRegistrationDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly cfg: Pick<Config, "maxResponseChars">;
  readonly debugDeps: DebugToolDeps;
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/**
 * Registers `abap_debug`, `abap_debug_vars` and `abap_debug_value`. One
 * session per process; only `abap_debug` mutates.
 */
export function registerDebugTools(mcp: McpServer, deps: DebugRegistrationDeps): void {
  /**
   * stateId → object the session started against. `step` carries only a
   * stateId, but the gate needs a real object; server-lifetime, re-keyed
   * after each successful step.
   */
  const debugSessionObjects = new Map<string, string>();

  mcp.registerTool(
    "abap_debug",
    {
      description:
        "ABAP debugger driver: arm breakpoints, run a program, step, inspect the stack. One " +
        "session at a time; variables read-only, frames observe-only.",
      inputSchema: debugInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const a = args as { action?: string; run?: { object: string }; stateId?: string };
        // step is as consequential as start; unknown actions are gated by default.
        if (!DEBUG_UNGATED_ACTIONS.has(a.action ?? "")) {
          const object =
            a.action === "step"
              ? a.stateId
                ? debugSessionObjects.get(a.stateId)
                : undefined
              : a.run?.object;
          // Missing/stale object reaches the gate as undefined and is denied there.
          deps.safety.assert("execute", object ? preflight({ object }) : undefined, {
            phase: "preflight",
          });
        }
        await deps.ensureConnected();
        const primary = deps.pool.primary();
        const res = await abapDebug(primary, args as DebugInput, deps.cfg.maxResponseChars, deps.debugDeps, deps.safety);
        // start seeds the stateId→object map; step carries it forward.
        const nextStateId = stateIdOfResponse(res.text);
        if (a.action === "start" && a.run?.object && nextStateId) {
          debugSessionObjects.set(nextStateId, a.run.object);
        } else if (a.action === "step" && a.stateId) {
          const carried = debugSessionObjects.get(a.stateId);
          debugSessionObjects.delete(a.stateId); // the previous stop is gone
          if (carried && nextStateId) debugSessionObjects.set(nextStateId, carried);
        }
        // Session over: clear the map (dead sessions report "status: dead").
        if (a.action === "stop" || /^status: dead$/m.test(res.text)) debugSessionObjects.clear();
        return ok(res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );

  mcp.registerTool(
    "abap_debug_vars",
    {
      description:
        "Survey of every variable in scope at a debugger stop; complex values come back as " +
        "abap_debug_value stubs.",
      inputSchema: debugVarsInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        deps.safety.assert("read");
        const res = await abapDebugVars(args as DebugVarsInput, deps.cfg.maxResponseChars);
        return ok(res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );

  mcp.registerTool(
    "abap_debug_value",
    {
      description:
        "Tier-2 drill-in: render one variable path in detail, with a row window for tables.",
      inputSchema: debugValueInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        deps.safety.assert("read");
        const res = await abapDebugValue(args as DebugValueInput, deps.cfg.maxResponseChars);
        return ok(res.text);
      } catch (e) {
        return deps.errorResult(e);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// v2: createDebugRunner mirrors registerDebugTools's dispatch but returns a
// plain result (framework-agnostic; no v2/runtime or v2/envelope imports) —
// src/tools/v2/handlers/debug.ts wraps it into a V2Response.
//
// Folds v1's abap_debug_vars/abap_debug_value into action values (K7) and
// drops run.mode (K6, defaults to run.ts's "auto"), deliberately deviating
// from bin/abap-guard's spec — see archive for full rationale.
// ---------------------------------------------------------------------------

const CORE_ACTIONS = ["start", "step", "stack", "frame", "keepalive", "stop", "status"] as const;
type CoreAction = (typeof CORE_ACTIONS)[number];
function isCoreAction(v: string): v is CoreAction {
  return (CORE_ACTIONS as readonly string[]).includes(v);
}

const STEP_KINDS = ["into", "over", "return", "continue", "runToLine", "jumpToLine"] as const;
type StepKind = (typeof STEP_KINDS)[number];
function isStepKind(v: string): v is StepKind {
  return (STEP_KINDS as readonly string[]).includes(v);
}

const SCOPE_KINDS = ["all", "locals", "parameters", "globals"] as const;
type ScopeKind = (typeof SCOPE_KINDS)[number];
function isScopeKind(v: string): v is ScopeKind {
  return (SCOPE_KINDS as readonly string[]).includes(v);
}

export interface DebugRunnerDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  readonly cfg: Pick<Config, "maxResponseChars">;
  readonly debugDeps: DebugToolDeps;
}

export interface DebugRunResult {
  readonly text: string;
  /** Disclosures from `parseBreakpoints` (action="start" only); [] otherwise. */
  readonly notes: readonly string[];
  /** The stateId the caller should use for its next call, if any. */
  readonly stateId?: string;
  /** True once the session has ended (stop, or the debuggee ran to completion). */
  readonly dead: boolean;
}

interface RawDebugArgs {
  action?: string;
  stateId?: string;
  run?: string;
  breakpoints?: string[];
  step?: string;
  toLine?: number;
  frame?: number;
  confirm?: string;
  path?: string;
  scope?: string;
  filter?: string;
  from?: number;
  count?: number;
  depth?: number;
}

/**
 * Builds a v2 dispatcher for `abap_debug`. Call once per server instance;
 * the returned `run` closes over its own `debugSessionObjects` map.
 */
export function createDebugRunner(deps: DebugRunnerDeps): { run(rawArgs: unknown): Promise<DebugRunResult> } {
  const debugSessionObjects = new Map<string, string>();

  async function run(rawArgs: unknown): Promise<DebugRunResult> {
    const a = (rawArgs ?? {}) as RawDebugArgs;
    const action = a.action ?? "";

    // vars/value folded from v1 (K7): read-only, no connection needed.
    if (action === "vars" || action === "value") {
      deps.safety.assert("read");

      if (action === "vars") {
        if (a.stateId === undefined) {
          throw new AbapError("BAD_INPUT", 'action="vars" requires stateId.');
        }
        let scopeKind: ScopeKind | undefined;
        if (a.scope !== undefined) {
          if (!isScopeKind(a.scope)) {
            throw new AbapError(
              "BAD_INPUT",
              `Unknown scope "${a.scope}" — expected all, locals, parameters, or globals.`,
            );
          }
          scopeKind = a.scope;
        }
        const res = await abapDebugVars(
          {
            stateId: a.stateId,
            ...(scopeKind !== undefined ? { scope: scopeKind } : {}),
            ...(a.filter !== undefined ? { filter: a.filter } : {}),
          },
          deps.cfg.maxResponseChars,
        );
        return { text: res.text, notes: [], stateId: a.stateId, dead: false };
      }

      // action === "value"
      if (a.stateId === undefined || a.path === undefined) {
        throw new AbapError("BAD_INPUT", 'action="value" requires stateId and path.');
      }
      const res = await abapDebugValue(
        {
          stateId: a.stateId,
          path: a.path,
          ...(a.from !== undefined ? { from: a.from } : {}),
          ...(a.count !== undefined ? { count: a.count } : {}),
          ...(a.depth !== undefined ? { depth: a.depth } : {}),
        },
        deps.cfg.maxResponseChars,
      );
      return { text: res.text, notes: [], stateId: a.stateId, dead: false };
    }

    if (!isCoreAction(action)) {
      // Defence in depth: handlers/debug.ts should already reject unknown actions.
      throw new AbapError("BAD_INPUT", `Unknown abap_debug action "${action}".`);
    }

    let stepKind: StepKind | undefined;
    if (action === "step" && a.step !== undefined) {
      if (!isStepKind(a.step)) {
        throw new AbapError(
          "BAD_INPUT",
          `Unknown step "${a.step}" — expected into, over, return, continue, runToLine, or jumpToLine.`,
        );
      }
      stepKind = a.step;
    }

    let notes: readonly string[] = [];
    let breakpoints: DebugInput["breakpoints"];
    if (action === "start" && a.breakpoints !== undefined) {
      const parsed = parseBreakpoints(a.breakpoints);
      breakpoints = parsed.breakpoints;
      notes = parsed.notes;
    }

    // Same gate policy as registerDebugTools; only start/step advance a live debuggee.
    if (!DEBUG_UNGATED_ACTIONS.has(action)) {
      const object = action === "step" ? (a.stateId ? debugSessionObjects.get(a.stateId) : undefined) : a.run;
      deps.safety.assert("execute", object ? preflight({ object }) : undefined, { phase: "preflight" });
    }

    await deps.ensureConnected();
    const primary = deps.pool.primary();

    const input: DebugInput = {
      action,
      ...(a.stateId !== undefined ? { stateId: a.stateId } : {}),
      ...(breakpoints !== undefined ? { breakpoints } : {}),
      ...(action === "start" && a.run !== undefined ? { run: { object: a.run } } : {}),
      ...(stepKind !== undefined ? { step: stepKind } : {}),
      ...(a.toLine !== undefined ? { toLine: a.toLine } : {}),
      ...(action === "frame" && a.frame !== undefined ? { frame: a.frame } : {}),
      ...(a.confirm !== undefined ? { confirm: a.confirm } : {}),
    };

    const res = await abapDebug(primary, input, deps.cfg.maxResponseChars, deps.debugDeps, deps.safety);

    // Same stateId→object tracking as registerDebugTools above.
    const nextStateId = stateIdOfResponse(res.text);
    if (action === "start" && a.run !== undefined && nextStateId) {
      debugSessionObjects.set(nextStateId, a.run);
    } else if (action === "step" && a.stateId) {
      const carried = debugSessionObjects.get(a.stateId);
      debugSessionObjects.delete(a.stateId);
      if (carried && nextStateId) debugSessionObjects.set(nextStateId, carried);
    }
    const dead = action === "stop" || /^status: dead$/m.test(res.text);
    if (dead) debugSessionObjects.clear();

    return { text: res.text, notes, ...(nextStateId !== undefined ? { stateId: nextStateId } : {}), dead };
  }

  return { run };
}
