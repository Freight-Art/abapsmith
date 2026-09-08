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
 * `afterAll` deletes the ones it can create (`rt.ping`, `rt.fail`) by
 * computing their deterministic names, best-effort. This file also declares
 * a third, fixture-only tool (`s11_fix2`, body class `ZCL_ZMCP_S11_FIX2`,
 * "S11" tagged to avoid colliding with any other slice's objects on a shared
 * appliance) used to prove the invoker's `CATCH cx_root` wrapper and
 * dispatch's silent-END check end to end, and now also a third action, `ok`
 * — a genuine no-frills success round trip used to pin `dispatch()`'s
 * self-heal after an out-of-band delete (see the self-heal `it` below): the
 * fixture's own body class is deleted directly (bypassing abapsmith
 * entirely, on a fresh connection, same one-delete rule as everywhere else
 * in this file), then dispatched again, proving the stale-registry-vs-
 * missing-object gap actually closes on a real system, not just against the
 * fake ADT in fluid-dispatch.test.ts. Its three invokers and its body class
 * are all deleted in the same `afterAll`, best-effort. Rough count on a cold
 * system: package create/confirm (~3), runtime class deploy+activate+verify
 * (~6), fixture class deploy+activate+verify (~6), five invoker deploy+run
 * cycles (~25, the self-heal test deploys/runs `ok` twice), one extra
 * out-of-band delete (~3), six object deletes in `afterAll` (~18). On a warm
 * system (runtime and fixture classes left in place from a prior run) most
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
import { isAbapError } from "../src/adt/errors.js";
import { fluidRuntimeManifest, fluidRuntimeTool } from "../src/adt/fluid/abap/runtime.js";
import { invokerName } from "../src/adt/fluid/invoke.js";
import { authorizeMutation, deleteObject, resolveWriteTarget } from "../src/adt/write.js";
import { systemKey } from "../src/journal.js";
import { FLUID_CONTRACT, manifestVersion, type FluidManifest, type LoadedFluidTool } from "../src/adt/fluid/manifest.js";
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

/**
 * Fixture-only fluid tool, defined inline (NOT part of BUILTIN_FLUID_TOOLS)
 * to prove two `dispatch.ts` behaviors end to end on the real appliance: (1)
 * `silent` returns normally with neither OUT nor ERR against a non-void
 * output schema, which must surface as FLUID_PROTOCOL_ERROR; (2) `boom`
 * raises CX_SY_ZERODIVIDE — a genuine class-based exception, declared in
 * `RAISING` and explicitly raised rather than left to an undeclared runtime
 * error — which must propagate through the generated invoker's own
 * `TRY. ... CATCH cx_root INTO DATA(lx_err).` wrapper and come back as a
 * parsed ERR frame (FLUID_ACTION_FAILED with the exception text), not a
 * short dump; (3) `ok` returns `{ ok: true }` via a normal OUT frame — a
 * plain, uneventful success, used only as the before/after probe for the
 * out-of-band-deletion self-heal test below (neither `silent` nor `boom`
 * can serve that role: one never reaches a successful OUT, the other always
 * throws). "S11" in every object name keeps this fixture from colliding
 * with any other slice's objects on a shared appliance.
 */
const FIXTURE_CLASS = "ZCL_ZMCP_S11_FIX2";

const FIXTURE_SOURCE = `CLASS zcl_zmcp_s11_fix2 DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    CLASS-METHODS run
      IMPORTING
        iv_action TYPE string
        iv_json   TYPE string
      RAISING
        cx_sy_zerodivide.

ENDCLASS.


CLASS zcl_zmcp_s11_fix2 IMPLEMENTATION.

  METHOD run.
    zcl_zmcp_fluid_rt=>begin( iv_id = 's11_fix2' iv_action = iv_action ).
    CASE iv_action.
      WHEN 'silent'.
* Deliberately emits neither OUT nor ERR before returning — proves dispatch.ts
* raises FLUID_PROTOCOL_ERROR for a non-void action whose body goes silent.
      WHEN 'boom'.
        RAISE EXCEPTION TYPE cx_sy_zerodivide.
      WHEN 'ok'.
        zcl_zmcp_fluid_rt=>out( '{"ok":true}' ).
      WHEN OTHERS.
        zcl_zmcp_fluid_rt=>err( iv_kind = 'exception' iv_step = 'dispatch'
          iv_text = |unknown action "{ iv_action }"| ).
    ENDCASE.
    zcl_zmcp_fluid_rt=>end( 0 ).
  ENDMETHOD.

ENDCLASS.
`;

const fixtureManifest: FluidManifest = {
  contract: FLUID_CONTRACT,
  id: "s11_fix2",
  title: "S11 integration-fix-2 fixture",
  description: "Fixture-only fluid tool proving the silent-END and CATCH-cx_root fixes end to end (slice S11).",
  objects: [
    {
      name: FIXTURE_CLASS,
      type: "CLAS/OC",
      description: "abapsmith S11: silent-END/exception coverage",
      source: { text: FIXTURE_SOURCE },
    },
  ],
  entry: FIXTURE_CLASS,
  actions: [
    {
      name: "silent",
      category: "read",
      description: "Returns normally, emitting neither OUT nor ERR, against a non-void output schema.",
      input: { type: "object", properties: {} },
      output: { type: "object", properties: {} },
    },
    {
      name: "boom",
      category: "read",
      description: "Raises CX_SY_ZERODIVIDE, declared and explicit, to exercise the invoker's CATCH cx_root wrapper.",
      input: { type: "object", properties: {} },
      output: { type: "object", properties: {} },
    },
    {
      name: "ok",
      category: "read",
      description:
        "Returns { ok: true } via a normal OUT frame — a plain success, used as the before/after probe for the out-of-band-deletion self-heal test.",
      input: { type: "object", properties: {} },
      output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    },
  ],
};

const fixtureSources: ReadonlyMap<string, string> = new Map([[FIXTURE_CLASS, FIXTURE_SOURCE]]);

const fixtureTool: LoadedFluidTool = {
  manifest: fixtureManifest,
  origin: "builtin",
  sources: fixtureSources,
  version: manifestVersion(fixtureManifest, fixtureSources),
};

const FIXTURE_TOOLS: ReadonlyMap<string, LoadedFluidTool> = new Map([[fixtureManifest.id, fixtureTool]]);

let conn: AbapConnection;
let cfg: Config;

const assertUsable = (): void => {
  if (conn.breaker.isTripped) {
    throw new Error(`circuit breaker tripped: ${conn.breaker.info?.message}`);
  }
};

async function deleteInvokerOnce(config: Config, name: string): Promise<void> {
  const c = new AbapConnection(config, { log: () => {}, breaker: new AuthCircuitBreaker() });
  await c.connect();
  try {
    const authorized = await authorizeMutation(c, GATE, "delete", { type: "CLAS/OC", name });
    await deleteObject(c, authorized);
  } finally {
    await c.shutdown("test-end");
  }
}

async function deleteObjectIfPresent(config: Config, name: string): Promise<void> {
  try {
    try {
      await deleteInvokerOnce(config, name);
    } catch (e) {
      if (isAbapError(e) && e.code === "SESSION_DEAD") {
        await deleteInvokerOnce(config, name);
      } else {
        throw e;
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[fluid-runtime live] could not delete ${name} — it may be left behind on a ` +
        `SHARED appliance. Remove it by hand (SE80) if so. Cause: ${String(e)}`,
    );
  }
}

async function deleteInvokerIfPresent(config: Config, toolId: string, contract: string, action: string): Promise<void> {
  await deleteObjectIfPresent(config, invokerName(toolId, action, {}, contract));
}

dWrite("live: the fluid API runtime deploys, dispatches, and reports failures on the real appliance", () => {
  beforeAll(async () => {
    cfg = loadConfig();
    conn = new AbapConnection(cfg, { log: () => {}, breaker: new AuthCircuitBreaker() });
    await conn.connect();
  }, 90_000);

  afterAll(async () => {
    if (!conn) return;
    // A stateful session here survives only one object delete, so each invoker (and the fixture body class) gets its own connection and one SESSION_DEAD retry.
    try {
      await deleteInvokerIfPresent(cfg, fluidRuntimeManifest.id, fluidRuntimeManifest.contract, "ping");
      await deleteInvokerIfPresent(cfg, fluidRuntimeManifest.id, fluidRuntimeManifest.contract, "fail");
      await deleteInvokerIfPresent(cfg, fixtureManifest.id, fixtureManifest.contract, "silent");
      await deleteInvokerIfPresent(cfg, fixtureManifest.id, fixtureManifest.contract, "boom");
      await deleteInvokerIfPresent(cfg, fixtureManifest.id, fixtureManifest.contract, "ok");
      await deleteObjectIfPresent(cfg, FIXTURE_CLASS);
    } finally {
      await conn.shutdown("test-end");
    }
  }, 180_000);

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

  it("dispatch()'s s11_fix2.silent action returns normally with neither OUT nor ERR against a non-void output schema, and surfaces as FLUID_PROTOCOL_ERROR", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg, gate: GATE, tools: FIXTURE_TOOLS };
    await expect(
      dispatch(deps, { tool: fixtureManifest.id, action: "silent", args: {} }),
    ).rejects.toMatchObject({ code: "FLUID_PROTOCOL_ERROR" });
  }, 120_000);

  it("dispatch()'s s11_fix2.boom action raises CX_SY_ZERODIVIDE, caught by the invoker's own CATCH cx_root, and surfaces as FLUID_ACTION_FAILED carrying the exception text", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg, gate: GATE, tools: FIXTURE_TOOLS };
    let caught: unknown;
    try {
      await dispatch(deps, { tool: fixtureManifest.id, action: "boom", args: {} });
    } catch (e) {
      caught = e;
    }
    expect(isAbapError(caught)).toBe(true);
    expect(isAbapError(caught) && caught.code).toBe("FLUID_ACTION_FAILED");
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message.length).toBeGreaterThan(0);
  }, 120_000);

  it("dispatch() self-heals when the fixture body class is deleted out-of-band: redeploys it and the retry succeeds", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg, gate: GATE, tools: FIXTURE_TOOLS };

    // Baseline: a clean, successful round trip first, so the on-disk registry
    // records FIXTURE_CLASS as deployed at this exact contract/version before
    // anything is deleted — matching the real-world shape of this bug (the
    // registry is telling the truth right up until something deletes the
    // object out from under it).
    const before = await underApplianceStateWatch("dispatch s11_fix2.ok (baseline)", () =>
      dispatch(deps, { tool: fixtureManifest.id, action: "ok", args: {} }),
    );
    expect(before.result).toEqual({ ok: true });

    // Delete the body class directly via ADT — NOT through abapsmith/dispatch,
    // and NOT through the shared `conn` every other test in this block reuses:
    // this file's own afterAll notes a stateful session here survives only one
    // object delete, so deleteObjectIfPresent (used the same way afterAll uses
    // it on this very class) opens its own fresh connection for the delete.
    await deleteObjectIfPresent(cfg, FIXTURE_CLASS);

    // Confirm it is actually gone before asking dispatch to recover it —
    // otherwise this test would not be pinning anything real.
    const goneCheck = await resolveWriteTarget(conn, { type: "CLAS/OC", name: FIXTURE_CLASS }, "write");
    expect(goneCheck.exists, `${FIXTURE_CLASS} was not actually deleted — test setup is broken`).toBe(false);

    // The registry still says FIXTURE_CLASS is deployed (nothing told it
    // otherwise) — exactly the stale-registry-vs-server-reality gap that
    // dispatch()'s self-heal (ensure.ts's isFluidRedeployableFailure /
    // recoverMissingFluidObject, plus dispatch.ts's forceInvokerRegeneration
    // to get past deployBridge's own unchanged-content shortcut, wired into
    // dispatch.ts's runDeployAndExecute retry) exists to close. A single
    // dispatch() call, with no special handling from the caller, must both
    // succeed and leave the class back in place.
    const after = await underApplianceStateWatch("dispatch s11_fix2.ok (self-heal)", () =>
      dispatch(deps, { tool: fixtureManifest.id, action: "ok", args: {} }),
    );
    expect(after.result).toEqual({ ok: true });

    const restored = await resolveWriteTarget(conn, { type: "CLAS/OC", name: FIXTURE_CLASS }, "write");
    expect(restored.exists, `${FIXTURE_CLASS} was not redeployed by self-heal`).toBe(true);
  }, 180_000);
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
