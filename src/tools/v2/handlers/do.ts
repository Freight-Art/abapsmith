/**
 * `abap_do` handler — same split/contract as `handlers/find.ts`. Recognised
 * actions dispatch through `DO_HANDLERS` (from the six `handlers/do/` group
 * modules); each returns `V2Ok<string>` or throws, and this function's
 * try/catch is the single `v2Error` funnel for the tool (exception
 * documented in `do/enhancements.ts`'s header).
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ABAP_DO_SKILL, actionsForMode, findAction, renderCatalogue } from "../catalogue.js";
import { firstN, isBareCall, nearest, unknownAction, v2Result, type NextCall } from "../envelope.js";
import type { V2ToolDeps } from "../runtime.js";
import { v2Error } from "../runtime.js";
import { DO_HANDLERS } from "./do/index.js";
import type { DoContext } from "./do/types.js";

/** SDK args arrive as an untyped bag (Rule 1); re-narrowed by hand, same convention as `RawDebugArgs` in `src/tools/debug-register.ts`. */
type RawDoArgs = {
  action?: string;
  object?: string;
  args?: Record<string, unknown>;
  confirm?: string;
  dry_run?: boolean;
};

function representativeDoCalls(deps: V2ToolDeps): NextCall[] {
  return firstN(actionsForMode(deps.cfg.abapMode), 3).map((entry) => ({
    tool: "abap_do",
    args: { action: entry.action },
    why: entry.summary,
  }));
}

export async function handleAbapDo(args: unknown, deps: V2ToolDeps): Promise<CallToolResult> {
  const mode = deps.cfg.abapMode;
  try {
    if (isBareCall(args)) {
      return v2Result({
        ok: true,
        tool: "abap_do",
        data: renderCatalogue(mode),
        next: representativeDoCalls(deps),
      });
    }
    const a = args as RawDoArgs;
    const given = a.action ?? "";
    const eligible = actionsForMode(mode);
    const entry = eligible.find((e) => e.action === given);

    if (entry === undefined) {
      const names = eligible.map((e) => e.action);
      const base = unknownAction(
        "abap_do",
        given,
        nearest(given, names, 3),
        `abap_do({}) lists all ${eligible.length} actions in this mode`,
        ABAP_DO_SKILL,
      );
      // Exists globally but needs a higher mode: same error code, message
      // explains why instead of implying a typo.
      const globalEntry = findAction(given);
      if (globalEntry !== undefined) {
        return v2Result({
          ...base,
          message: `"${given}" needs ${globalEntry.minMode} mode or higher; this server is running in ${mode} mode.`,
        });
      }
      return v2Result(base);
    }

    const handler = DO_HANDLERS.get(entry.action);
    if (handler === undefined) {
      // Unreachable in practice (DO_HANDLERS keyset == ABAP_DO_ACTIONS,
      // asserted by an invariant test) — kept as a structured UNKNOWN_ACTION
      // rather than a crash if that invariant is ever broken.
      const names = eligible.map((e) => e.action);
      return v2Result(
        unknownAction(
          "abap_do",
          entry.action,
          nearest(entry.action, names, 3),
          `abap_do({}) lists all ${eligible.length} actions in this mode`,
          ABAP_DO_SKILL,
        ),
      );
    }

    const ctx: DoContext = {
      action: entry.action,
      object: a.object,
      args: a.args ?? {},
      confirm: a.confirm,
      dry_run: a.dry_run,
    };
    const result = await handler(ctx, deps);
    return v2Result(result);
  } catch (e) {
    return v2Result(
      v2Error("abap_do", e, [{ tool: "abap_do", args: {}, why: "Retry with the bare call to list the catalogue." }]),
    );
  }
}
