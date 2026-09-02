#!/usr/bin/env node
/**
 * abapsmith entry point — stdio MCP server.
 *
 * stdout belongs to the MCP transport. Everything diagnostic goes to stderr.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AbapConnection } from "./adt/connection.js";
import { AuthCircuitBreaker } from "./adt/circuit-breaker.js";
import { loadConfig, redactConfigSecrets } from "./config.js";
import { shutdownAllDebugSessions } from "./debug/session.js";
import { createServer } from "./server.js";
import { registerShutdownHandler } from "./shutdown-hook.js";
import { shutdownDebugTools } from "./tools/debug.js";

/** The two members of the primary connection this file needs. */
type ShutdownArmable = Pick<AbapConnection, "onShutdown" | "offShutdown">;

/**
 * Arms `cleanup` to run before process exit (SIGINT/SIGTERM/beforeExit),
 * re-targeting it onto whichever `AbapConnection` the pool currently holds as
 * primary rather than caching one at startup — the pool re-seats primary at
 * runtime, and a cleanup left on a retired connection is dropped, stranding a
 * suspended debuggee on an ADT dialog work process. Must be registered before
 * `server.start()` so it becomes subscriber #0 on the shared shutdown hook,
 * ahead of any connection's own `process.exit`. Full rationale (including why
 * a plain second subscriber on the shared hook doesn't work) is archived in
 * the git history.
 *
 * @returns the shared hook's unregister function.
 */
export function armDebugShutdown(
  server: { readonly connection: ShutdownArmable },
  cleanup: () => Promise<void> | void,
): () => void {
  let armed: ShutdownArmable | undefined;
  return registerShutdownHandler("abapsmith/debug-shutdown", () => {
    const conn = server.connection;
    // Sync subscribers are re-invoked on every signal; re-arming the same
    // object would queue the cleanup twice.
    if (conn === armed) return;
    armed?.offShutdown(cleanup);
    armed = conn;
    conn.onShutdown(cleanup);
  });
}

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.stderr.write(
      "\nSet ABAP_URL, ABAP_USER and ABAP_PASSWORD (a .env file in the working " +
        "directory is picked up automatically).\n",
    );
    process.exit(1);
  }

  process.stderr.write(
    `[abapsmith] config (secrets redacted; host, user and SID are not): ${JSON.stringify(redactConfigSecrets(cfg))}\n`,
  );

  // Sole circuit breaker instance for the process; forConfig() replays any
  // existing lockout for these credentials at zero request cost.
  const server = createServer(cfg, { breaker: AuthCircuitBreaker.forConfig(cfg) });
  // Must precede server.start() — see armDebugShutdown.
  armDebugShutdown(server, async () => {
    // Synchronous and first: closes the debug trigger connection before any
    // await above it could reject and skip this. Never throws.
    shutdownDebugTools();
    await shutdownAllDebugSessions((m) => process.stderr.write(`${m}\n`));
    await server.mcp.close();
  });

  await server.start();
}

/**
 * True only when this module is the program node was asked to run — guards
 * `main()` from firing on import (e.g. under a test runner). `realpathSync`
 * resolves the `bin` symlink to the same path as the compiled entry.
 */
function invokedAsProgram(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsProgram()) {
  main().catch((e) => {
    process.stderr.write(`[abapsmith] fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(1);
  });
}
