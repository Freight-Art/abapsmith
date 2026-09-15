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

/**
 * `abap_debug` actions needing no `execute` gate at THIS layer, for two
 * different reasons:
 *  - pure reads: `stack`/`status`/`frame` (the last only moves the
 *    debugger's read cursor, live-verified against A4H), plus `breakpoints`
 *    and `watch` when `op:"list"` — they report this session's own
 *    bookkeeping, never write anything.
 *  - `keepalive`/`stop`, and `breakpoints`/`watch` for `op:"add"`/`"remove"`:
 *    genuine writes, but ones `debug.ts` itself gates one layer down, via
 *    `assertSessionWrite`, against the object the session actually started
 *    against — re-evaluating the shared SafetyGate there still refuses
 *    add/remove with READ_ONLY on a read-only server.
 * `breakpoints`/`watch` carry no `object` (or `run`) of their own at all —
 * unlike `start`/`step` they take only a `stateId` — so gating them HERE
 * resolved `object` to `undefined` on every call and `deps.safety.assert`
 * denied all four ops outright with "No object supplied for a mutating
 * operation", regardless of op or gate state. Found by live verification
 * against A4H, 2026-09-15: `breakpoints`/`watch` were completely
 * non-functional through the MCP entry point. Exempt list, not gated list:
 * new actions default to GATED.
 */
const DEBUG_UNGATED_ACTIONS: ReadonlySet<string> = new Set([
  "stack",
  "frame",
  "status",
  "keepalive",
  "stop",
  "breakpoints",
  "watch",
]);

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
