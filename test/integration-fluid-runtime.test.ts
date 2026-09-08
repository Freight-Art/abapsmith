/**
 * LIVE test for the fluid API's own runtime: the one manifest
 * (`fluidRuntimeTool`, id `"rt"`) every generated invoker attaches to for its
 * console protocol. Everything else in the fluid API — plugin manifests,
 * generated invokers, the registry cache — sits on top of this working
 * end to end on a real system: `ensureFluidPackage` actually creating
 * `$ABAPSMITH_FLUID_API`, `ensureFluidTool` actually deploying and activating
 * `ZCL_ZMCP_FLUID_RT`, and `dispatch()` actually round-tripping a console
 * transcript through it, both for success (`ping`) and for a reported
 * failure (`fail`). Every offline fluid test (fluid-ensure.test.ts,
 * fluid-dispatch.test.ts, …) fakes the wire; only this file proves SAP itself
 * accepts the generated ABAP and answers the `ZMCP-H>` protocol the way
 * protocol.ts expects.
 *
 * GATING. Two independent `describe` blocks, both requiring `ABAP_URL`
 * (`liveSuiteSkipReason`), split on write access (`ABAP_MODE=edit`/`admin`,
 * or legacy `ABAP_ALLOW_WRITE=true` — see `test/helpers/live-write-gate.ts`):
 * the write-mode block (package creation, tool deploy, `ping`, `fail`) runs
 * only when write access IS configured; the read-mode block (`ABAP_MODE=read`
 * refuses before any request) runs only when it is NOT — each block's
 * collection-time skip states which. The orchestrator launches this file
 * once per mode, so on any one run exactly one of the two blocks executes
 * and the other reports skipped — never both, never neither. Both gates are
 * deliberately independent of `vitest.config.ts`'s `LIVE_INTEGRATION_TESTS`
 * list, which only decides whether `VITEST_LIVE=1` collects this file at
 * all — belt and braces, matching every other live suite in this repo.
 *
 * BUDGET. Two objects: the package `$ABAPSMITH_FLUID_API` (created once,
 * ever — `ensureFluidPackage` memoizes per system per process, so every call
 * after the first in ANY suite this process runs is free) and the class
 * `ZCL_ZMCP_FLUID_RT` in it. Both are the framework's own runtime, not
 * per-test scaffolding, and are deliberately left in place afterward — a
 * later run finds them already `present` and does no further writes. Each
 * `dispatch()` call generates one small invoker class
 * (`ZCL_ZMCP_I_` + 8 hex, content-addressed by tool/action/args); this file's
 * `afterAll` deletes the two it can create (`ping`, `fail`) by computing
 * their deterministic names, best-effort. Rough count on a cold system:
 * package create/confirm (~3), runtime class deploy+activate+verify (~6),
 * `ping` invoker deploy+run (~5), `fail` invoker deploy+run (~5), two invoker
 * deletes (~6). On a warm system (both left in place from a prior run) most
 * of that collapses to reads, well under half.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { loadConfig, loadEnvFile, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { liveWriteConfigured } from "./helpers/live-write-gate.js";
import { dispatch, type FluidDeps } from "../src/adt/fluid/dispatch.js";
import { ensureFluidPackage, FLUID_PACKAGE } from "../src/adt/fluid/package.js";
import { ensureFluidTool } from "../src/adt/fluid/ensure.js";
import { forgetManifest, readFluidRegistry } from "../src/adt/fluid/registry.js";
import { fluidRuntimeManifest, fluidRuntimeTool } from "../src/adt/fluid/abap/runtime.js";
import { invokerName } from "../src/adt/fluid/invoke.js";
import { authorizeMutation, deleteObject, resolveWriteTarget } from "../src/adt/write.js";
import { systemKey } from "../src/journal.js";
import type { LoadedFluidTool } from "../src/adt/fluid/manifest.js";
import { liveSuiteSkipReason, skipForApplianceState, underApplianceStateWatch } from "./live-appliance-state.js";

loadEnvFile();

const writeNotRun = liveSuiteSkipReason({ write: true });
const dWrite = writeNotRun === undefined ? describe : describe.skip;
// A collection-time skip is counted but never says why; state the reason once, greppably.
if (writeNotRun !== undefined) it("live fluid runtime: write suite not run", (ctx) => skipForApplianceState(ctx, writeNotRun));

const readNotRun =
  liveSuiteSkipReason() ??
  (liveWriteConfigured()
    ? "write access is configured — the ABAP_MODE=read refusal case only runs in a read-mode process"
    : undefined);
const dRead = readNotRun === undefined ? describe : describe.skip;
if (readNotRun !== undefined) it("live fluid runtime: read-mode refusal case not run", (ctx) => skipForApplianceState(ctx, readNotRun));

/** Fluid targets its own generated objects, not caller-named ones — nothing narrower to scope this to. */
const GATE = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowNamePrefixes: ["*"] });

const TOOLS: ReadonlyMap<string, LoadedFluidTool> = new Map([[fluidRuntimeManifest.id, fluidRuntimeTool]]);

let conn: AbapConnection;
let cfg: Config;

const assertUsable = (): void => {
  if (conn.breaker.isTripped) {
    throw new Error(`circuit breaker tripped: ${conn.breaker.info?.message}`);
  }
};

async function deleteInvokerIfPresent(action: string): Promise<void> {
  const name = invokerName(fluidRuntimeManifest.id, action, {}, fluidRuntimeManifest.contract);
  try {
    const authorized = await authorizeMutation(conn, GATE, "delete", { type: "CLAS/OC", name });
    await deleteObject(conn, authorized);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[fluid-runtime live] could not delete generated invoker ${name} — it may be left behind on a ` +
        `SHARED appliance. Remove it by hand (SE80) if so. Cause: ${String(e)}`,
    );
  }
}

dWrite("live: the fluid API runtime deploys, dispatches, and reports failures on the real appliance", () => {
  beforeAll(async () => {
    cfg = loadConfig();
    conn = new AbapConnection(cfg, { log: () => {}, breaker: new AuthCircuitBreaker() });
    await conn.connect();
  }, 90_000);

  afterAll(async () => {
    if (!conn) return;
    await deleteInvokerIfPresent("ping");
    await deleteInvokerIfPresent("fail");
    await conn.shutdown("test-end");
  }, 90_000);

  it("ensureFluidPackage creates $ABAPSMITH_FLUID_API under $TMP, and a second call issues no requests", async () => {
    assertUsable();
    await underApplianceStateWatch("ensureFluidPackage", () => ensureFluidPackage(conn, GATE));

    // `resolveWriteTarget` does not echo `superPackage` back for an object that
    // already exists (only on the not-yet-exists branch), so `$TMP` placement
    // is a property of `createFluidPackage`'s own request (see package.ts),
    // not something re-derivable from a read here — `exists` is what a live
    // run can actually confirm.
    const resolved = await resolveWriteTarget(conn, { type: "DEVC/K", name: FLUID_PACKAGE }, "write");
    expect(resolved.exists, `${FLUID_PACKAGE} was not created`).toBe(true);

    const before = conn.requestCount;
    await underApplianceStateWatch("ensureFluidPackage cache hit", () => ensureFluidPackage(conn, GATE));
    expect(
      conn.requestCount,
      "a second ensureFluidPackage call for the same system must be a pure in-process cache hit",
    ).toBe(before);
  }, 120_000);

  it("ensureFluidTool deploys and activates ZCL_ZMCP_FLUID_RT cold, and records the registry entry once", async () => {
    assertUsable();
    const sysKey = systemKey(conn.cfg);
    await forgetManifest(cfg, sysKey, fluidRuntimeManifest.id);

    const result = await underApplianceStateWatch("ensureFluidTool", () =>
      ensureFluidTool(conn, GATE, cfg, fluidRuntimeTool, {
        tool: fluidRuntimeManifest.id,
        action: "ping",
        op: "run",
      }),
    );

    expect(result.objects).toHaveLength(1);
    for (const obj of result.objects) {
      expect(obj.state, `${obj.name} did not end up present`).toBe("present");
    }

    const registry = await readFluidRegistry(cfg, sysKey);
    const entry = registry.get(fluidRuntimeManifest.id);
    expect(entry, "ensureFluidTool did not write a registry entry for the runtime").toBeDefined();
    expect(entry?.version).toBe(fluidRuntimeTool.version);
    expect(entry?.contract).toBe(fluidRuntimeManifest.contract);
  }, 120_000);

  it("dispatch()'s round trip of rt.ping returns a parsed BEGIN/OUT/END sequence with the expected version", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg, gate: GATE, tools: TOOLS };
    const result = await underApplianceStateWatch("dispatch rt.ping", () =>
      dispatch(deps, { tool: fluidRuntimeManifest.id, action: "ping", args: {} }),
    );
    expect(result.version).toBe(fluidRuntimeTool.version);
    expect(result.result).toEqual({ pong: true, ver: fluidRuntimeTool.version });
  }, 120_000);

  it("dispatch()'s rt.fail action surfaces a parsed ERR frame as FLUID_ACTION_FAILED", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg, gate: GATE, tools: TOOLS };
    await expect(
      dispatch(deps, { tool: fluidRuntimeManifest.id, action: "fail", args: {} }),
    ).rejects.toMatchObject({ code: "FLUID_ACTION_FAILED" });
  }, 120_000);
});

dRead("live: with ABAP_MODE=read, dispatch refuses the fluid API before any request", () => {
  beforeAll(async () => {
    cfg = loadConfig();
    conn = new AbapConnection(cfg, { log: () => {}, breaker: new AuthCircuitBreaker() });
    await conn.connect();
  }, 90_000);

  afterAll(async () => {
    if (!conn) return;
    await conn.shutdown("test-end");
  }, 90_000);

  it("refuses with FLUID_API_DISABLED and issues zero requests", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg, gate: GATE, tools: TOOLS };
    const before = conn.requestCount;
    await expect(
      dispatch(deps, { tool: fluidRuntimeManifest.id, action: "ping", args: {} }),
    ).rejects.toMatchObject({ code: "FLUID_API_DISABLED" });
    expect(conn.requestCount).toBe(before);
  }, 60_000);
});
