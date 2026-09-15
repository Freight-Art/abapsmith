#!/usr/bin/env node
/**
 * abapsmith entry point.
 *
 * Under the default `ABAP_MCP_TRANSPORT=stdio`, stdout belongs to the MCP
 * transport and everything diagnostic goes to stderr. Under
 * `ABAP_MCP_TRANSPORT=http` (`src/mcp-http.ts`) stdout carries nothing at
 * all — MCP travels over the HTTP listener instead — but every diagnostic
 * still goes to stderr, unconditionally, for both transports.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AbapConnection } from "./adt/connection.js";
import { AuthCircuitBreaker } from "./adt/circuit-breaker.js";
import { BUILTIN_FLUID_TOOLS } from "./adt/fluid/builtin/index.js";
import { loadFluidTools } from "./adt/fluid/plugin-loader.js";
import { loadConfig, redactConfigSecrets, type Config } from "./config.js";
import { shutdownAllDebugSessions } from "./debug/session.js";
import { createServer } from "./server.js";
import { registerShutdownHandler } from "./shutdown-hook.js";
import { loadSystems, type SystemSpec } from "./systems/spec.js";
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
  let cfg: Config;
  // `loadSystems()` returns `undefined` when none of the multi-system env
  // vars (ABAP_SYSTEMS / ABAP_SYSTEM_<ALIAS>_*) are set — that is the cue to
  // fall back to the single-system `loadConfig()` path, unchanged. When it
  // does return, every validation problem across every system has already
  // been folded into ONE thrown Error, so the catch block below handles both
  // sources the same way.
  let systems: readonly SystemSpec[] | undefined;
  try {
    systems = loadSystems();
    if (systems === undefined) {
      cfg = loadConfig();
    } else {
      const def = systems.find((s) => s.isDefault);
      if (def === undefined) {
        // Not reachable: loadSystems() guarantees exactly one `isDefault`
        // entry in any list it returns. Written as an explicit check rather
        // than a `!` assertion to stay honest under noUncheckedIndexedAccess,
        // same discipline as SystemRegistry.all().
        throw new Error("loadSystems() returned no default system.");
      }
      cfg = def.cfg;
    }
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.stderr.write(
      "\nSet ABAP_URL, ABAP_USER and ABAP_PASSWORD (a .env file in the working " +
        "directory is picked up automatically), or configure ABAP_SYSTEMS / " +
        "ABAP_SYSTEM_<ALIAS>_* for a multi-system deployment.\n",
    );
    process.exit(1);
  }

  process.stderr.write(
    `[abapsmith] config (secrets redacted; host, user and SID are not): ${JSON.stringify(redactConfigSecrets(cfg))}\n`,
  );
  if (systems !== undefined) {
    // One additional line per non-default system — the default's line above
    // already covers it. Same redaction rule, so a fleet's stderr output
    // never leaks more than a single-system deployment's already does.
    for (const s of systems) {
      if (s.isDefault) continue;
      process.stderr.write(
        `[abapsmith] config [${s.alias}] (secrets redacted; host, user and SID are not): ` +
          `${JSON.stringify(redactConfigSecrets(s.cfg))}\n`,
      );
    }
  }

  // Plugin discovery is filesystem work and async, and `createServer` is
  // synchronous by design (it is the composition root, not an I/O step) — so
  // the tool set is resolved here, once, before registration.
  const fluidToolSet = await loadFluidTools(cfg, BUILTIN_FLUID_TOOLS);
  for (const r of fluidToolSet.refused) {
    process.stderr.write(`[abapsmith] fluid plugin refused (${r.code}): ${r.path} — ${r.reason}\n`);
  }
  for (const w of fluidToolSet.warnings) {
    process.stderr.write(`[abapsmith] fluid plugin warning: ${w}\n`);
  }

  // Sole circuit breaker instance for the process; forConfig() replays any
  // existing lockout for these credentials at zero request cost.
  const server = createServer(cfg, { breaker: AuthCircuitBreaker.forConfig(cfg), fluidToolSet, systems });
  // Must precede server.start() — see armDebugShutdown.
  armDebugShutdown(server, async () => {
    // Synchronous and first: closes the debug trigger connection before any
    // await above it could reject and skip this. Never throws.
    shutdownDebugTools();
    await shutdownAllDebugSessions((m) => process.stderr.write(`${m}\n`));
    // `closeClients()`, not `server.mcp.close()`: under `ABAP_MCP_TRANSPORT=http`
    // there are N per-session `McpServer`s plus the HTTP listener besides the
    // one default server this file can see as `server.mcp` — closing only
    // that one would leave the port bound and every other session's
    // transport open past process shutdown.
    await server.closeClients();
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
