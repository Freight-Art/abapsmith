/**
 * Adds the `system` tool parameter and routes each call to the system it
 * names, for every tool registered AFTER this runs.
 *
 * Modelled on `stripSchemaKeyOnConnect` (src/server.ts): rebind one SDK
 * method on this `McpServer` instance so every later registrar gets the
 * behaviour for free, with zero changes to the ~25 registrar call sites in
 * `src/tools/*.ts`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runInSystem } from "./current.js";
import type { SystemRegistry } from "./registry.js";

/**
 * A schema'd tool's raw input shape (a record of Zod schemas — what every
 * `registerXTools` in this codebase passes as `inputSchema`, never a
 * pre-built `z.object(...)`). Kept local and minimal rather than importing
 * the SDK's own `ZodRawShapeCompat` — this module only ever adds one key to
 * the record and never inspects the rest of it.
 */
type RawShape = Record<string, unknown>;

/** The two callback arities `registerTool` accepts, discriminated by whether `inputSchema` is present. */
type SchemaCallback = (args: Record<string, unknown>, extra: unknown) => unknown;
type SchemalessCallback = (extra: unknown) => unknown;

/**
 * Rebinds `mcp.registerTool` so every tool registered afterward gains an
 * optional `system` input parameter and dispatches through
 * `registry.resolve()` / `runInSystem()`.
 *
 * No-op when `registry.size <= 1` — a single-system server never adds the
 * parameter and never wraps a callback, so its schema bytes and dispatch
 * path are BYTE-IDENTICAL to the pre-#93 server. This is the mechanism that
 * keeps `test/tools.test.ts`'s whole-surface schema-size assertions passing
 * unchanged for single-system deployments.
 *
 * Must run before any `registerXTools(mcp, ...)` call — `mcp.registerTool`
 * is rebound in place, so only calls made after this point are wrapped.
 */
export function installSystemRouting(mcp: McpServer, registry: SystemRegistry): void {
  if (registry.size <= 1) return;

  // The SDK's `registerTool` is generic over the input/output schema types
  // (`ZodRawShapeCompat | AnySchema`), which this wrapper deliberately
  // widens to a plain `Record<string, unknown>` so it can add one key
  // without importing the SDK's internal schema-compat types. One cast here,
  // at the boundary, rather than one at every call below — same trade-off
  // `stripSchemaKeyOnConnect` makes for `mcp.connect` further down in
  // server.ts.
  const rawRegisterTool = mcp.registerTool.bind(mcp) as unknown as (
    name: string,
    config: { inputSchema?: RawShape; [key: string]: unknown },
    cb: SchemaCallback | SchemalessCallback,
  ) => ReturnType<McpServer["registerTool"]>;
  const systemParamDescription = `SAP system alias, e.g. "QAS". Defaults to ${registry.default.alias}.`;

  mcp.registerTool = ((
    name: string,
    config: { inputSchema?: RawShape; [key: string]: unknown },
    cb: SchemaCallback | SchemalessCallback,
  ) => {
    const hasSchema = config.inputSchema !== undefined;

    if (!hasSchema) {
      // Locked refusal stubs (src/tools/locked.ts) have no inputSchema and
      // stay schema-free — there is no `system` argument to read, so these
      // always resolve via `registry.resolve(undefined)` (current routed
      // system, or the default).
      const original = cb as SchemalessCallback;
      const wrapped: SchemalessCallback = (extra) => {
        const ctx = registry.resolve(undefined);
        return runInSystem(ctx.alias, () => original(extra));
      };
      return rawRegisterTool(name, config, wrapped);
    }

    const wrappedInputSchema: RawShape = {
      ...config.inputSchema,
      system: z.string().optional().describe(systemParamDescription),
    };
    const original = cb as SchemaCallback;
    const wrapped: SchemaCallback = (args, extra) => {
      const { system, ...rest } = args;
      // Thrown `AbapError("UNKNOWN_SYSTEM", ...)` propagates out of the
      // handler untouched — the SDK turns it into the standard `isError`
      // envelope exactly like any other handler-thrown error.
      const ctx = registry.resolve(typeof system === "string" ? system : undefined);
      // Wraps the call that RETURNS the promise, not an `await` — so every
      // continuation the handler schedules (including ones that outlive
      // this synchronous frame) stays attributed to `ctx.alias` in
      // `AsyncLocalStorage`.
      return runInSystem(ctx.alias, () => original(rest, extra));
    };
    return rawRegisterTool(name, { ...config, inputSchema: wrappedInputSchema }, wrapped);
  }) as typeof mcp.registerTool;
}
