/**
 * v2 dependency bag (`V2ToolDeps`) and the v2 error funnel (`v2Error`).
 *
 * `V2ToolDeps` is the union of every v1 registrar's dependency bag, grown
 * once so work packages wiring `abap_find`/`abap_read`/`abap_write`/
 * `abap_do`/`abap_debug`/`abap_adt` never need to touch `src/server.ts`
 * again. Handlers use only the slice they need.
 *
 * `v2Error` exists because `deps.errorResult` (v1's failure funnel) returns
 * a `CallToolResult` with no `next` field, which Rule 3 (`envelope.ts`)
 * requires on every response. It type-checks fine either way, so this is
 * not caught by the compiler — v2 handlers must call `v2Error`, never
 * `deps.errorResult`, in their `catch` blocks.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SessionTransport } from "../../adt/session-transport.js";
import { describeUnknownError, isAbapError } from "../../adt/errors.js";
import type { SessionPool } from "../../adt/pool.js";
import type { Config } from "../../config.js";
import type { Journal } from "../../journal.js";
import type { AbapMode } from "../../mode.js";
import type { SafetyGate } from "../../safety.js";
import type { DebugToolDeps } from "../debug.js";
import type { NextCall, V2Err } from "./envelope.js";

/** Dependency bag every v2 handler receives; see file header. */
export interface V2ToolDeps {
  readonly pool: SessionPool;
  readonly safety: SafetyGate;
  readonly ensureConnected: () => Promise<void>;
  /** v1 failure funnel, kept for parity. v2 handlers must NOT call this
   *  directly in `catch` blocks — use {@link v2Error} instead. */
  readonly errorResult: (e: unknown) => CallToolResult;
  readonly journal: Journal;
  readonly transport: SessionTransport;
  readonly debugDeps: DebugToolDeps;
  readonly warn: (msg: string) => void;
  readonly cfg: Pick<
    Config,
    | "maxResponseChars"
    | "allowEnhancements"
    | "allowSourcePlugins"
    | "allowEnhancementDelete"
    | "user"
    | "verifyWrites"
  > & {
    readonly abapMode: AbapMode;
  };
}

/**
 * v2 error funnel every handler's `catch` block must use instead of
 * `deps.errorResult` (see file header). Builds a `V2Err` from an
 * `AbapError`'s code/message, or `ADT_ERROR` for anything else — same
 * classification as `src/server.ts`'s `errorResult`, minus v1-only
 * envelope/summary/budget machinery. `next` is a required parameter and
 * field, so Rule 3 holds on the failure path by construction.
 */
export function v2Error(tool: string, e: unknown, next: readonly NextCall[]): V2Err {
  if (isAbapError(e)) {
    return {
      ok: false,
      tool,
      error: e.code,
      message: e.message,
      ...(e.hint !== undefined ? { hint: e.hint } : {}),
      retryable: e.retryable,
      next,
    };
  }
  const described = describeUnknownError(e);
  return {
    ok: false,
    tool,
    error: "ADT_ERROR",
    message: typeof described === "string" && described ? described : `Unknown failure (${typeof e})`,
    retryable: undefined, // cause not classified, no claim
    next,
  };
}
