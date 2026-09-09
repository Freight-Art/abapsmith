/**
 * Live integration test pinning the S13 fix: a fluid PLUGIN can never
 * declare `ZCL_ZMCP_FLUID_RT` in its own manifest — `plugin-loader.ts`'s
 * `namespaceRe()` refuses any object outside the plugin's own
 * `ZCL_ZMCP_X_<ID>` namespace — yet the generated invoker and every plugin
 * body hard-call `zcl_zmcp_fluid_rt=>begin/out/err/end`. Before this slice,
 * nothing deployed the runtime class on a plugin's behalf: a plugin call on
 * a system that had never deployed `ZCL_ZMCP_FLUID_RT` (or had it deleted
 * out-of-band) dumped. The fix is `ensureFluidRuntimeFor(conn, gate, cfg,
 * tool, ctx?)`, exported from `src/adt/fluid/ensure.ts` and called by
 * `dispatch()` (see `src/adt/fluid/dispatch.ts`'s `runDeployAndExecute`)
 * before `ensureFluidTool()` for any tool with `origin === "plugin"` — a
 * no-op for a builtin tool, which already owns the runtime class in its own
 * manifest.
 *
 * Skeleton and idioms copied from `test/integration-fluid-tool.test.ts`:
 * the `liveSuiteSkipReason({ write: true })` gate with a collection-time
 * skip `it`, `loadConfig()` + `new AbapConnection(...)` + `conn.connect()`
 * in `beforeAll`, transcribing the real T000 probe verdict onto a
 * `SafetyGate` via `safety.update(...)`, the `fakeMcp()`/`invoke()`/
 * `okText()` triad driving `registerFluidTool()`'s captured MCP handler
 * directly, and the hand-built `fakePool()` with its one-shot
 * `isSessionDeadFailure(e) -> conn.connect() -> retry once` revive wrapper.
 * The out-of-band delete/reconnect idiom (a stateful ADT session survives
 * only ONE object delete, so every delete gets its own fresh connection or
 * lease) is copied from `test/integration-fluid-runtime.test.ts`'s
 * `deleteInvokerOnce`/`deleteObjectIfPresent`.
 *
 * Rather than pointing the loader at the whole `test/fixtures/fluid-plugins`
 * directory — which also holds `bad-namespace` (deliberately refused) and
 * whatever sibling fixtures other in-flight slices add — this suite uses the
 * `isolatedRoot` symlink trick from `test/fluid-plugin-loader.test.ts` to
 * expose exactly one fixture, `hello`, to `loadFluidTools()`. That keeps this
 * suite immune to what else lives under `fixtures/fluid-plugins/` and to how
 * many plugins it refuses; the only things asserted below are about `hello`
 * itself.
 *
 * LEASES. Three, each scoped to what it needs:
 *  1. `beforeAll`, a short-lived `AbapConnection` used only to force
 *     `ZCL_ZMCP_FLUID_RT` genuinely absent before anything else runs:
 *     `forgetManifest()` first (so `ensureFluidTool`'s registry-cache-trust
 *     fast path — see `ensure.ts`'s doc comment on that short-circuit — can
 *     never report the runtime "present" from a stale local entry instead of
 *     actually checking the server), then a live probe and, if present, a
 *     delete. Shut down immediately after.
 *  2. The suite's main connection (`conn`), opened once in the same
 *     `beforeAll` after lease 1 closes, and reused by every `it` via
 *     `fakePool()`'s revive wrapper — this is the "one connection per file"
 *     the rest of the suite runs on.
 *  3. `afterAll`, one fresh cleanup connection that best-effort deletes the
 *     `hello.ping` invoker and then the plugin body class
 *     `ZCL_ZMCP_X_HELLO`, tolerating (and retrying once past) the
 *     SESSION_DEAD the first of those two deletes causes. `ZCL_ZMCP_FLUID_RT`
 *     is deliberately NEVER deleted here — other live suites sharing this
 *     appliance depend on it existing, and the whole point of the core test
 *     below is to leave it deployed as a side effect of a plugin call.
 *
 * SAFETY: touches only `$ABAPSMITH_FLUID_API` and `ZCL_ZMCP_*` objects
 * (`allowPackages: ["$TMP", FLUID_PACKAGE]`, matching the sibling suites).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { loadConfig, loadEnvFile, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { Journal } from "../src/journal.js";
import type { SessionPool } from "../src/adt/pool.js";
import { authorizeMutation, deleteObject, resolveWriteTarget, NO_JOURNAL } from "../src/adt/write.js";
import { isSessionDeadFailure } from "../src/adt/write-verify.js";
import { errorResult } from "../src/tool-errors.js";
import { systemKey } from "../src/journal.js";
import { FLUID_PACKAGE } from "../src/adt/fluid/package.js";
import { FLUID_RUNTIME_CLASS, fluidRuntimeManifest } from "../src/adt/fluid/abap/runtime.js";
import { invokerName } from "../src/adt/fluid/invoke.js";
import { forgetManifest } from "../src/adt/fluid/registry.js";
import { loadFluidTools, type FluidToolSet } from "../src/adt/fluid/plugin-loader.js";
import { registerFluidTool, type FluidToolDeps } from "../src/tools/fluid.js";
import { liveSuiteSkipReason, skipForApplianceState } from "./live-appliance-state.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fluid-plugins");
const HELLO_DIR = path.join(FIXTURES_DIR, "hello");

loadEnvFile(); // so a .env in the repo root enables the live suite
const notRun = liveSuiteSkipReason({ write: true });
const dw = notRun === undefined ? describe : describe.skip;
// A collection-time skip is counted but never says why; state the reason once, greppably.
if (notRun !== undefined) it("live fluid plugin runtime-dependency suite: not run", (ctx) => skipForApplianceState(ctx, notRun));

// ---------------------------------------------------------------------------
// fakeMcp()/invoke()/okText() triad — copied verbatim from
// test/integration-fluid-tool.test.ts.
// ---------------------------------------------------------------------------

function fakeMcp(): { mcp: McpServer; tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }> } {
  const tools = new Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>();
  const mcp = {
    registerTool: (name: string, _config: unknown, handler: (args: unknown) => Promise<CallToolResult>) => {
      tools.set(name, { handler });
      return {} as unknown;
    },
  } as unknown as McpServer;
  return { mcp, tools };
}

async function invoke(
  tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>,
  args: unknown,
): Promise<CallToolResult> {
  const entry = tools.get("abap_fluid");
  if (!entry) throw new Error('"abap_fluid" was never registered');
  return entry.handler(args);
}

function okText(result: CallToolResult): string {
  if (result.isError) {
    throw new Error(`abap_fluid returned an error result: ${JSON.stringify(result.content)}`);
  }
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error(`abap_fluid returned no text content: ${JSON.stringify(result)}`);
  return first.text;
}

// A fixed root whose only immediate subdirectory is a symlink to the
// checked-in `hello` fixture, so `loadFluidTools()` sees exactly one plugin
// regardless of whatever else lives under `fixtures/fluid-plugins/` — same
// helper as `test/fluid-plugin-loader.test.ts`'s `isolatedRoot`, reimplemented
// here rather than imported since that file's copy is scoped to its own
// per-test `dir`.
async function isolatedHelloRoot(parent: string): Promise<string> {
  const root = path.join(parent, "root-hello");
  await mkdir(root, { recursive: true });
  await symlink(HELLO_DIR, path.join(root, "hello"), "dir");
  return root;
}

dw("live A4H: a plugin call redeploys the fluid runtime class it can never declare itself", () => {
  let conn: AbapConnection;
  let safety: SafetyGate;
  let cfg: Config;
  let tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>;
  let loaded: FluidToolSet;
  let tmpRoot: string;
  const breaker = new AuthCircuitBreaker();
  // Used only by the internal delete/cleanup leases below, never by dispatch()
  // itself — the main flow's `safety` (built from the real T000 probe
  // transcription, same idiom as integration-fluid-tool.test.ts) is what
  // every `it` actually exercises.
  const DELETE_GATE = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"] });

  const assertUsable = () => {
    if (conn.breaker.isTripped) {
      throw new Error(`circuit breaker tripped: ${conn.breaker.info?.message}`);
    }
  };

  /** Same one-shot idiom as every other live fluid suite — never a loop, never used for auth errors. */
  async function withRevive<T>(fn: (c: AbapConnection) => Promise<T>): Promise<T> {
    try {
      return await fn(conn);
    } catch (e) {
      if (!isSessionDeadFailure(e)) throw e;
      await conn.connect();
      return fn(conn);
    }
  }

  function fakePool(): SessionPool {
    return {
      withRead: <T,>(_op: string, fn: (c: AbapConnection) => Promise<T>) => withRevive(fn),
      withWrite: <T,>(_op: string, _objectUri: string | undefined, fn: (c: AbapConnection) => Promise<T>) => withRevive(fn),
      reserveDebug: () => {
        throw new Error("reserveDebug: not used by abap_fluid.");
      },
      primary: () => conn,
      createUnpooledConnection: () => {
        throw new Error("createUnpooledConnection: not used by abap_fluid.");
      },
    } as unknown as SessionPool;
  }

  /**
   * Best-effort delete of one CLAS/OC by name on an already-connected
   * connection, tolerating (and retrying once past) the SESSION_DEAD a prior
   * delete on the same lease causes — the same one-shot idiom used
   * everywhere else in this codebase, never a loop, never used for auth
   * errors. Never throws: a cleanup failure must not mask a real assertion
   * failure, and must not stop the sibling delete after it from running.
   */
  async function deleteIfPresentOnLease(c: AbapConnection, name: string): Promise<void> {
    const attempt = async (): Promise<void> => {
      const probe = await resolveWriteTarget(c, { type: "CLAS/OC", name }, "delete");
      if (!probe.exists) return;
      const authorized = await authorizeMutation(c, DELETE_GATE, "delete", { type: "CLAS/OC", name });
      await deleteObject(c, authorized, { onBeforeImage: NO_JOURNAL });
    };
    try {
      await attempt();
    } catch (e) {
      if (isSessionDeadFailure(e)) {
        try {
          await c.connect();
          await attempt();
          return;
        } catch (e2) {
          console.warn(`afterAll: failed to clean up ${name} after reconnect — remove it by hand if it exists.`, e2);
          return;
        }
      }
      console.warn(`afterAll: failed to clean up ${name} — remove it by hand if it exists.`, e);
    }
  }

  beforeAll(async () => {
    const base = loadConfig();
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "abapsmith-integration-fluid-plugin-"));
    const helloRoot = await isolatedHelloRoot(tmpRoot);

    cfg = {
      ...base,
      readOnly: false,
      allowPackages: ["$TMP", FLUID_PACKAGE],
      allowFluidPlugins: true,
      fluidPlugins: [helloRoot],
    };

    // Lease 1: force ZCL_ZMCP_FLUID_RT genuinely absent before anything else
    // runs. forgetManifest() first so ensureFluidTool's registry-cache-trust
    // fast path (see ensure.ts) cannot later report the runtime "present"
    // from a stale local entry instead of actually checking the server.
    const preConn = new AbapConnection(cfg, { log: () => {}, breaker: new AuthCircuitBreaker() });
    await preConn.connect();
    try {
      await forgetManifest(cfg, systemKey(preConn.cfg), fluidRuntimeManifest.id);
      const probe = await resolveWriteTarget(preConn, { type: "CLAS/OC", name: FLUID_RUNTIME_CLASS }, "delete");
      if (probe.exists) {
        const authorized = await authorizeMutation(preConn, DELETE_GATE, "delete", {
          type: "CLAS/OC",
          name: FLUID_RUNTIME_CLASS,
        });
        await deleteObject(preConn, authorized, { onBeforeImage: NO_JOURNAL });
      }
    } finally {
      await preConn.shutdown("test-end");
    }

    loaded = await loadFluidTools(cfg);

    // Lease 2: the suite's main connection, reused by every `it` below.
    conn = new AbapConnection(cfg, { log: () => {}, breaker });
    // allowNamePrefixes: ["*"] — same rationale as the sibling fluid live
    // suites: FLUID_PACKAGE starts with "$", and both the runtime class and
    // the plugin's own body class live under ZCL_ZMCP_, outside a narrower
    // prefix allowlist.
    safety = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP", FLUID_PACKAGE],
      allowNamePrefixes: ["*"],
    });
    const info = await conn.connect();
    // Mirrors src/server.ts's ensureConnected callback: the T000 probe is
    // the authority, this only transcribes its verdict onto the gate so
    // fluidDisabledReason(cfg, safety) sees the same connected-state fields
    // production would populate.
    safety.update({
      productive: info.roleDetection.role === "productive",
      systemRole: info.systemRole,
      writesLockedOut: info.writesLockedOut,
      lockoutReason: info.roleDetection.reason,
      roleProbeFailure: info.roleDetection.probeFailure,
    });

    const deps: FluidToolDeps = {
      pool: fakePool(),
      cfg,
      safety,
      ensureConnected: async () => {
        if (!conn.isConnected) await conn.connect();
      },
      errorResult,
      toolSet: loaded,
      journal: new Journal(
        { dir: path.join(os.tmpdir(), "abapsmith-integration-fluid-plugin-unused"), enabled: false, maxEntries: 1, maxAgeDays: 1 },
        "TST",
      ),
    };
    const { mcp, tools: registered } = fakeMcp();
    registerFluidTool(mcp, deps);
    tools = registered;
  }, 90_000);

  afterAll(async () => {
    // Lease 3: one fresh connection, best-effort. Never deletes
    // ZCL_ZMCP_FLUID_RT — other live suites sharing this appliance depend on
    // it existing, and the happy path above deliberately leaves it deployed.
    try {
      const cleanupConn = new AbapConnection(cfg, { log: () => {}, breaker: new AuthCircuitBreaker() });
      await cleanupConn.connect();
      try {
        const helloTool = loaded?.tools.get("hello");
        const contract = helloTool?.manifest.contract ?? fluidRuntimeManifest.contract;
        const invoker = invokerName("hello", "ping", {}, contract);
        await deleteIfPresentOnLease(cleanupConn, invoker);
        await deleteIfPresentOnLease(cleanupConn, "ZCL_ZMCP_X_HELLO");
      } finally {
        await cleanupConn.shutdown("test-end");
      }
    } catch (e) {
      console.warn("afterAll: cleanup lease failed entirely — remove ZCL_ZMCP_X_HELLO and its invoker by hand if they exist.", e);
    }
    await conn?.shutdown("test-end");
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  }, 120_000);

  it("loadFluidTools loads exactly the isolated hello fixture as a plugin-origin tool", () => {
    expect(loaded.refused).toEqual([]);
    expect(loaded.tools.size).toBe(1);
    const hello = loaded.tools.get("hello");
    expect(hello).toBeDefined();
    expect(hello?.origin).toBe("plugin");
    expect(hello?.manifest.entry).toBe("ZCL_ZMCP_X_HELLO");
  });

  it("op:\"run\" tool:\"hello\" action:\"ping\" redeploys the missing runtime class and succeeds", async () => {
    assertUsable();

    // Confirm the pre-state this test actually depends on: beforeAll deleted
    // ZCL_ZMCP_FLUID_RT, so the runtime is genuinely absent before dispatch()
    // runs — otherwise this test would not be pinning anything real.
    const before = await withRevive((c) => resolveWriteTarget(c, { type: "CLAS/OC", name: FLUID_RUNTIME_CLASS }, "delete"));
    expect(before.exists, `${FLUID_RUNTIME_CLASS} was not actually deleted — beforeAll setup is broken`).toBe(false);

    const text = okText(await invoke(tools, { op: "run", tool: "hello", action: "ping" }));
    expect(text).toContain("RESULT");
    expect(text).toContain('"reply": "pong"');

    // The runtime class must now exist again — dispatch()'s call to
    // ensureFluidRuntimeFor() before ensureFluidTool() is what put it there,
    // since the "hello" plugin manifest itself can never declare it.
    const after = await withRevive((c) => resolveWriteTarget(c, { type: "CLAS/OC", name: FLUID_RUNTIME_CLASS }, "delete"));
    expect(after.exists, `${FLUID_RUNTIME_CLASS} was not redeployed by the plugin call`).toBe(true);
  }, 180_000);
});
