/**
 * Shared types for `abap_do`'s dispatch table: one `DoContext` per call, one
 * `DoHandler` per action, merged into `DO_HANDLERS` by `index.ts`.
 */
import type { V2Ok } from "../../envelope.js";
import type { V2ToolDeps } from "../../runtime.js";

/** The v2 call, unpacked; `args` is always `{}` rather than `undefined`. */
export interface DoContext {
  readonly action: string;
  readonly object?: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly confirm?: string;
  readonly dry_run?: boolean;
}

/** One action's implementation; throw on failure, `handlers/do.ts` catches. */
export type DoHandler = (ctx: DoContext, deps: V2ToolDeps) => Promise<V2Ok<string>>;
