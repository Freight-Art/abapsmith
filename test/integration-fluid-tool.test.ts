/**
 * Live integration test for the `abap_fluid` MCP TOOL HANDLER — not
 * `dispatch()`/`ensureFluidTool()` directly (that's
 * `test/integration-fluid-runtime.test.ts`'s job), but the actual
 * `registerFluidTool()` registration and the `CallToolResult` text it
 * produces, exercised end to end against a real A4H appliance the same way
 * an MCP client would call it.
 *
 * Skeleton copied from `test/integration-fluid-run.test.ts` (gating,
 * `beforeAll`/`afterAll` shape, the `isSessionDeadFailure` ->
 * `conn.connect()` -> retry-once cleanup idiom). The
 * `fakeMcp()`/`registered()`-style harness (capture the handler
 * `mcp.registerTool` receives, then call it directly) is adapted from
 * `test/bopf-show-partial-view-caveat.test.ts` and `test/fluid-tool.test.ts`.
 *
 * Runs all seven ops plus the bare catalogue call, in this fixed order,
 * sharing one connection and one `SafetyGate` (module-scope `let`s) so
 * later steps see what earlier steps actually did to the system:
 *
 *  1. bare call            -> catalogue text names the "rt" tool.
 *  2. op:"list"             -> lists "rt" and "run".
 *  3. op:"describe" rt      -> names rt's actions, including "ping".
 *  4. op:"run" rt.ping      -> deploys rt for real, ping succeeds.
 *  5. op:"status"           -> local registry now believes rt is deployed.
 *  6. op:"verify" rt        -> the system confirms rt's objects are "present".
 *  7. op:"remove" rt        -> deletes rt's objects (confirm:"remove").
 *  8. op:"repair" rt, then
 *     one more op:"run" rt.ping -> redeploys rt and proves it works again.
 *  9. op:"status"           -> invoker count for rt matches a direct
 *     listInvokerClasses/probeInvokers probe.
 *  10. op:"repair" tool:"rt" -> prunes only stale rt invokers; asserts
 *     everything staleInvokers doesn't flag (current-version rt, anything
 *     unrelated) survives.
 *
 * Steps 7 and 8 are deliberately last: 7 deletes `ZCL_ZMCP_FLUID_RT`, which
 * (like every ABAP class delete over ADT) kills the stateful session
 * server-side — the next request gets `400 Session Timed Out` /
 * `ICMENOSESSION` (SESSION_DEAD). Nothing in `ensure.ts`'s `absent` branch
 * (which is what step 8's repair hits, since step 7's delete happened in a
 * *prior*, separate tool call — not inside the same `ensureOneObject` call
 * the way the `legacy`/`broken` branches' own revive-on-dead-session
 * handling covers) protects against that, so this suite's own fake
 * `SessionPool` wraps every lease in the same one-shot
 * `isSessionDeadFailure(e) -> conn.connect() -> retry once` idiom used
 * throughout the codebase (`authorizeBridgeTarget`, `deleteOneFluidObject`,
 * this file's own `afterAll`) — never a loop, never used for auth errors.
 * Step 8 MUST leave `ZCL_ZMCP_FLUID_RT` deployed and working, since other
 * live suites/slices sharing this appliance depend on it existing.
 *
 * SAFETY: touches only `$ABAPSMITH_FLUID_API` and `ZCL_ZMCP_*` objects
 * (`allowPackages: ["$TMP", FLUID_PACKAGE]`, matching the sibling suite).
 * Never creates a transport, never touches system settings. `afterAll` does
 * NOT delete `ZCL_ZMCP_FLUID_RT` (step 8 deliberately restores it) — it only
 * closes the connection and, best-effort, deletes the one per-call invoker
 * class (`ZCL_ZMCP_I_xxxxxxxx`) that `rt.ping` with `args: {}` generates
 * (content-hash-addressed, so steps 4 and 8 produce the SAME invoker name —
 * one cleanup covers both), tolerating failures without masking a real one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { Journal } from "../src/journal.js";
import type { SessionPool } from "../src/adt/pool.js";
import { authorizeMutation, deleteObject, NO_JOURNAL } from "../src/adt/write.js";
import { isSessionDeadFailure } from "../src/adt/write-verify.js";
import { errorResult } from "../src/tool-errors.js";
import { FLUID_PACKAGE } from "../src/adt/fluid/package.js";
import { FLUID_RUNTIME_CLASS, fluidRuntimeManifest, fluidRuntimeTool } from "../src/adt/fluid/abap/runtime.js";
import { invokerName } from "../src/adt/fluid/invoke.js";
import { listInvokerClasses, probeInvokers, staleInvokers } from "../src/adt/fluid/invokers.js";
import { BUILTIN_FLUID_TOOLS } from "../src/adt/fluid/builtin/index.js";
import { builtinFluidToolSet, registerFluidTool, type FluidToolDeps } from "../src/tools/fluid.js";
import { liveSuiteSkipReason, skipForApplianceState } from "./live-appliance-state.js";

loadEnvFile(); // so a .env in the repo root enables the live suite
const notRun = liveSuiteSkipReason({ write: true });
const dw = notRun === undefined ? describe : describe.skip;
// A collection-time skip is counted but never says why; state the reason once, greppably.
if (notRun !== undefined) it("live abap_fluid tool handler: suite not run", (ctx) => skipForApplianceState(ctx, notRun));

// ---------------------------------------------------------------------------
// fakeMcp()/registered()/invoke() triad — adapted from
// test/bopf-show-partial-view-caveat.test.ts and test/fluid-tool.test.ts.
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

dw("live A4H abap_fluid tool handler (write path, rt through the MCP tool)", () => {
  let conn: AbapConnection;
  let safety: SafetyGate;
  let tools: Map<string, { handler: (args: unknown) => Promise<CallToolResult> }>;
  const breaker = new AuthCircuitBreaker();

  const assertUsable = () => {
    if (conn.breaker.isTripped) {
      throw new Error(`circuit breaker tripped: ${conn.breaker.info?.message}`);
    }
  };

  /**
   * Same one-shot idiom as `authorizeBridgeTarget`/`deleteOneFluidObject` —
   * never a loop, never used for auth errors — needed here because step 7
   * (remove) deletes `ZCL_ZMCP_FLUID_RT` mid-suite, which kills the ADT
   * session server-side; step 8 (repair) is a brand-new tool call with no
   * way to know a delete just happened, so nothing in production code
   * revives it for that transition — this fake pool has to.
   */
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

  beforeAll(async () => {
    const base = loadConfig();
    conn = new AbapConnection(
      { ...base, readOnly: false, allowPackages: ["$TMP", FLUID_PACKAGE] },
      { log: () => {}, breaker },
    );
    // allowNamePrefixes: ["*"] — same rationale as integration-fluid-run.test.ts:
    // FLUID_PACKAGE starts with "$", and the fluid runtime class lives under
    // ZCL_ZMCP_, both outside a narrower prefix allowlist.
    safety = new SafetyGate({
      readOnly: false,
      allowPackages: ["$TMP", FLUID_PACKAGE],
      allowNamePrefixes: ["*"],
    });
    const info = await conn.connect();
    // Mirrors src/server.ts's ensureConnected callback: the T000 probe is
    // the authority, this only transcribes its verdict onto the gate so
    // fluidDisabledReason(cfg, safety) sees the same connected-state fields
    // production would populate, rather than leaving them permanently
    // undefined (which would silently skip the gate-lockout branch this
    // suite is supposed to exercise for real).
    safety.update({
      productive: info.roleDetection.role === "productive",
      systemRole: info.systemRole,
      writesLockedOut: info.writesLockedOut,
      lockoutReason: info.roleDetection.reason,
      roleProbeFailure: info.roleDetection.probeFailure,
    });

    const cfg = { ...base, readOnly: false, allowPackages: ["$TMP", FLUID_PACKAGE] };
    const deps: FluidToolDeps = {
      pool: fakePool(),
      cfg,
      safety,
      ensureConnected: async () => {
        if (!conn.isConnected) await conn.connect();
      },
      errorResult,
      toolSet: builtinFluidToolSet(BUILTIN_FLUID_TOOLS),
      // `journal` is required on `FluidToolDeps` (test/journal-contract.test.ts) — disabled
      // here since this suite doesn't exercise journalling.
      journal: new Journal(
        { dir: path.join(os.tmpdir(), "abapsmith-integration-fluid-tool-unused"), enabled: false, maxEntries: 1, maxAgeDays: 1 },
        "TST",
      ),
    };
    const { mcp, tools: registered } = fakeMcp();
    registerFluidTool(mcp, deps);
    tools = registered;
  }, 60_000);

  afterAll(async () => {
    // Best-effort: delete the one per-call invoker class rt.ping({}) leaves
    // behind — content-hash-addressed, so steps 4 and 8 (identical args)
    // generate/reuse the same name; one delete covers both. NEVER deletes
    // ZCL_ZMCP_FLUID_RT itself — step 8 deliberately leaves it deployed for
    // other live suites/slices sharing this appliance.
    const invoker = invokerName("rt", "ping", {}, fluidRuntimeManifest.contract);
    try {
      if (conn?.isConnected && !conn.breaker.isTripped) {
        const authorizeAndDelete = async () => {
          const authorized = await authorizeMutation(conn, safety, "delete", { type: "CLAS/OC", name: invoker });
          await deleteObject(conn, authorized, { onBeforeImage: NO_JOURNAL });
        };
        try {
          await authorizeAndDelete();
        } catch (e) {
          if (!isSessionDeadFailure(e)) throw e;
          await conn.connect();
          await authorizeAndDelete();
        }
      }
    } catch (e) {
      // NOT_FOUND (never generated, or already gone) is expected and fine;
      // anything else is logged, never thrown — a cleanup failure must not
      // mask a real assertion failure from the suite itself.
      console.warn(`afterAll: failed to clean up invoker ${invoker} — remove it by hand if it exists.`, e);
    }
    await conn?.shutdown("test-end");
  }, 90_000);

  it("1. bare call returns the catalogue, naming the rt tool", async () => {
    assertUsable();
    const text = okText(await invoke(tools, {}));
    expect(text).toContain("CATALOGUE");
    expect(text).toMatch(/\brt\b/);
    expect(text).toContain(FLUID_PACKAGE);
  }, 60_000);

  it('2. op:"list" lists rt and run', async () => {
    assertUsable();
    const text = okText(await invoke(tools, { op: "list" }));
    expect(text).toContain("TOOLS");
    expect(text).toMatch(/\brt\b/);
    expect(text).toMatch(/\brun\b/);
  }, 60_000);

  it('3. op:"describe" tool:"rt" names rt\'s actions, including ping', async () => {
    assertUsable();
    const text = okText(await invoke(tools, { op: "describe", tool: "rt" }));
    expect(text).toContain("TOOL");
    expect(text).toContain(FLUID_RUNTIME_CLASS);
    expect(text).toContain("ping");
    expect(text).toContain("fail");
  }, 60_000);

  it('4. op:"run" tool:"rt" action:"ping" deploys rt and succeeds', async () => {
    assertUsable();
    const text = okText(await invoke(tools, { op: "run", tool: "rt", action: "ping" }));
    expect(text).toContain("RESULT");
    expect(text).toContain('"pong": true');
    // `builtinFluidToolSet` computes the same content-addressed version
    // `dispatch()` attaches into the ABAP side's ping response — confirms
    // the deployed class really is running the version this suite loaded,
    // not a stale one left over from a previous slice/run.
    expect(text).toContain(`"ver": "${fluidRuntimeTool.version}"`);
  }, 120_000);

  it('5. op:"status" shows rt as deployed in the local registry', async () => {
    assertUsable();
    const text = okText(await invoke(tools, { op: "status" }));
    expect(text).toContain("LOCAL REGISTRY");
    expect(text).toMatch(/\brt\b/);
  }, 60_000);

  it('6. op:"verify" tool:"rt" reports rt\'s objects present', async () => {
    assertUsable();
    const text = okText(await invoke(tools, { op: "verify", tool: "rt" }));
    expect(text).toContain("OBJECTS");
    expect(text).toContain(FLUID_RUNTIME_CLASS);
    expect(text).toContain("present");
  }, 60_000);

  it('7. op:"remove" tool:"rt" confirm:"remove" deletes rt\'s objects', async () => {
    assertUsable();
    const text = okText(await invoke(tools, { op: "remove", tool: "rt", confirm: "remove" }));
    expect(text).toContain("OBJECTS");
    expect(text).toContain(FLUID_RUNTIME_CLASS);
    expect(text).toContain("deleted");
  }, 120_000);

  it('8. op:"repair" tool:"rt" redeploys rt, and a final ping proves it works', async () => {
    assertUsable();
    const repairText = okText(await invoke(tools, { op: "repair", tool: "rt" }));
    expect(repairText).toContain("OBJECTS");
    expect(repairText).toContain(FLUID_RUNTIME_CLASS);
    expect(repairText).toContain("present");

    const pingText = okText(await invoke(tools, { op: "run", tool: "rt", action: "ping" }));
    expect(pingText).toContain("RESULT");
    expect(pingText).toContain('"pong": true');
  }, 180_000);

  it('9. op:"status" reports an invoker count for rt matching a direct probe', async () => {
    assertUsable();
    const names = await withRevive((c) => listInvokerClasses(c));
    const probes = await withRevive((c) => probeInvokers(c, names));
    // Step 8's final ping leaves at least one rt invoker deployed; other
    // slices sharing this appliance may add more, so compare against a
    // fresh probe rather than a hard-coded number.
    const expected = probes.filter((p) => p.toolId === "rt").length;
    expect(expected).toBeGreaterThan(0);

    const text = okText(await invoke(tools, { op: "status" }));
    expect(text).toContain("INVOKER CLASSES");
    const row = /^rt\s+(\d+)\s*$/m.exec(text);
    expect(row).not.toBeNull();
    expect(Number(row?.[1])).toBe(expected);
  }, 60_000);

  it('10. op:"repair" tool:"rt" prunes only stale rt invokers, leaving current and unrelated invokers alone', async () => {
    assertUsable();
    // Re-deploy so a current-version rt invoker is known to exist going in.
    await invoke(tools, { op: "run", tool: "rt", action: "ping" });
    const currentInvoker = invokerName("rt", "ping", {}, fluidRuntimeManifest.contract);

    const before = await withRevive((c) => listInvokerClasses(c));
    const beforeProbes = await withRevive((c) => probeInvokers(c, before));
    expect(before).toContain(currentInvoker);
    // `staleInvokers` is production's own definition of "safe to prune" —
    // this suite has no way to deploy a genuinely stale rt invoker live
    // without shipping a fake one, so nothing here is expected to qualify.
    // The test asserts the safe half: repair's prune pass agrees (nothing
    // pruned) and every invoker seen beforehand, rt's current one included,
    // is still present afterward — the failure mode that matters is
    // deleting an object repair had no business touching.
    const stale = staleInvokers(beforeProbes, "rt", fluidRuntimeTool.version);
    expect(stale).toEqual([]);

    const text = okText(await invoke(tools, { op: "repair", tool: "rt" }));
    expect(text).toContain("STALE INVOKERS");
    expect(text).toContain("(none — no stale invokers found for this tool)");

    const after = await withRevive((c) => listInvokerClasses(c));
    for (const name of before) expect(after).toContain(name);
  }, 120_000);
});
