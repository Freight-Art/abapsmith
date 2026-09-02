/**
 * `abap_debug` handler: structure only (split rationale in `handlers/find.ts` header).
 * Breakpoint parsing and the debugger driver live in `createDebugRunner` (`src/tools/debug-register.ts`).
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createDebugRunner, type DebugRunResult } from "../../debug-register.js";
import { bareOk, isBareCall, nearest, unknownAction, v2Result, type NextCall, type V2Ok } from "../envelope.js";
import type { V2ToolDeps } from "../runtime.js";
import { v2Error } from "../runtime.js";

/** v2's 9 actions: v1's 6, plus `vars`/`value` folded in from v1's separate tools,
 *  plus `frame` (read-only: moves the read cursor to a different stack frame). */
const ABAP_DEBUG_ACTIONS = [
  "start",
  "step",
  "stack",
  "frame",
  "vars",
  "value",
  "keepalive",
  "stop",
  "status",
] as const;

/**
 * Keyed by `deps` (one per server instance, `src/server.ts`), not a bare
 * singleton — keeps two server instances (e.g. two in one test file) from
 * sharing `debugSessionObjects`/gate/pool wiring, while persisting the
 * runner across calls within one server so stateId tracking survives.
 */
const runners = new WeakMap<V2ToolDeps, ReturnType<typeof createDebugRunner>>();

function runnerFor(deps: V2ToolDeps): ReturnType<typeof createDebugRunner> {
  let runner = runners.get(deps);
  if (!runner) {
    runner = createDebugRunner(deps);
    runners.set(deps, runner);
  }
  return runner;
}

/** Rule 3's concrete follow-up: live stateId -> step/vars suggestions, else a worked `start` example. */
function buildNextCalls(result: DebugRunResult): NextCall[] {
  if (result.stateId !== undefined && !result.dead) {
    return [
      {
        tool: "abap_debug",
        args: { action: "step", stateId: result.stateId, step: "over" },
        why: "Advance to the next statement.",
      },
      {
        tool: "abap_debug",
        args: { action: "vars", stateId: result.stateId },
        why: "Survey variables at the current stop.",
      },
    ];
  }
  return [
    {
      tool: "abap_debug",
      args: { action: "start", run: "ZCL_FOO", breakpoints: ["ZCL_FOO:10"] },
      why: "Start a new debug session.",
    },
  ];
}

export async function handleAbapDebug(args: unknown, deps: V2ToolDeps): Promise<CallToolResult> {
  try {
    if (isBareCall(args)) {
      return v2Result(
        bareOk(
          "abap_debug",
          "abap_debug drives a live ABAP debug session.\n" +
            "action: start | step | stack | frame | vars | value | keepalive | stop | status\n" +
            "Every call after start takes the stateId the start response returned.",
          [
            {
              tool: "abap_debug",
              args: { action: "start", run: "ZCL_FOO", breakpoints: ["ZCL_FOO:10"] },
              why: "Arm breakpoints and start a session.",
            },
          ],
        ),
      );
    }

    const action = (args as { action?: unknown }).action;
    if (typeof action === "string" && !(ABAP_DEBUG_ACTIONS as readonly string[]).includes(action)) {
      return v2Result(
        unknownAction(
          "abap_debug",
          action,
          nearest(action, ABAP_DEBUG_ACTIONS),
          "abap_debug({}) — bare call lists every action.",
          "abap:debugging",
        ),
      );
    }

    const runner = runnerFor(deps);
    const result = await runner.run(args);
    const ok: V2Ok<string> = {
      ok: true,
      tool: "abap_debug",
      data: result.text,
      ...(result.notes.length > 0 ? { notes: result.notes } : {}),
      next: buildNextCalls(result),
    };
    return v2Result(ok);
  } catch (e) {
    return v2Result(
      v2Error("abap_debug", e, [{ tool: "abap_debug", args: {}, why: "Retry with the bare call for guidance." }]),
    );
  }
}
