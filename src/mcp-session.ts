/**
 * Per-MCP-session attribution, carried in an `AsyncLocalStorage`.
 *
 * `Journal.setClientActor()`/`setClientSession()` (src/journal.ts) are
 * process-global mutable state — correct for stdio, where one process IS
 * one conversation, but wrong the moment one process serves several MCP
 * sessions at once: session B's `initialize` would overwrite session A's
 * identity, and every journal entry written after that point (for EITHER
 * session) would be misattributed. `src/mcp-http.ts` runs every request for
 * a given session inside `runInMcpSession(entry.ctx, ...)`, so
 * `Journal.begin()` (src/journal.ts) can read `currentMcpSession()` instead
 * of the process-wide fields whenever one is present.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface McpSessionContext {
  /**
   * The transport's own session id (`Mcp-Session-Id`). Mutable: the SDK
   * mints it while handling the `initialize` request, which happens AFTER
   * this object is constructed (`src/mcp-http.ts`'s `onsessioninitialized`
   * callback sets it in place).
   */
  sessionId?: string;
  /**
   * Who authenticated to abapsmith — the NAME of the matched
   * `ABAP_MCP_HTTP_TOKEN` entry (`src/mcp-http-auth.ts`), when that entry
   * was named. Absent when the presented token was an unnamed one, or when
   * no token was required at all.
   */
  caller?: string;
  /** Client name from the MCP `initialize` handshake (`getClientVersion()?.name`). */
  client?: string;
}

const store = new AsyncLocalStorage<McpSessionContext>();

/** Runs `fn` with `ctx` as the ambient `McpSessionContext` for every synchronous and awaited step inside it. */
export function runInMcpSession<T>(ctx: McpSessionContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/** The ambient `McpSessionContext` for the code currently running, or `undefined` outside any `runInMcpSession` call (e.g. under stdio). */
export function currentMcpSession(): McpSessionContext | undefined {
  return store.getStore();
}

/**
 * Who a journal entry written under `ctx` should be attributed to: the
 * authenticated CALLER wins over the client-reported tool/app NAME, because
 * a caller identity was verified (a bearer token matched) while a client
 * name is just whatever the connecting tool self-reports. `undefined` —
 * never a placeholder — when neither is known.
 */
export function mcpSessionActor(ctx: McpSessionContext): string | undefined {
  return ctx.caller ?? ctx.client;
}
