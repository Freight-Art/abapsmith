/**
 * Live integration test for the built-in `ui` fluid tool
 * (`src/adt/fluid/builtin/ui.ts`, entry class `ZCL_ZMCP_FLUID_UI`) — the READ
 * half of the legacy `ui-runtime.ts` screen inspection, reshaped onto the
 * fluid body-class contract. `ui.screen` is the one action this file
 * exercises: it resolves a classic dynpro (by tcode via TSTC, or by explicit
 * program+dynpro) and reads its field list via `RPY_DYNPRO_READ`.
 *
 * The offline suites (fluid-manifest.test.ts-style validation, any
 * ui.ts-focused unit test) can only prove the manifest shape and hand-written
 * fixture parsing. They cannot prove SAP actually accepts and activates
 * `ZCL_ZMCP_FLUID_UI` in `$ABAPSMITH_FLUID_API`, that a live TSTC lookup and
 * `RPY_DYNPRO_READ` call really produce a well-formed transcript, or — most
 * importantly — that the action's failure arm really reports failure at the
 * ABAP layer (a body whose CATCH/error branch forgets `zcl_zmcp_fluid_rt=>err`
 * would read as success). This file proves all three, live:
 *
 *  1. `ensureFluidTool` deploys and activates `ZCL_ZMCP_FLUID_RT` (also
 *     redeployed here since its source changed this slice — expected, not a
 *     defect) and `ZCL_ZMCP_FLUID_UI` into `$ABAPSMITH_FLUID_API` — read back
 *     independently over ADT, not just trusted from `ensureFluidTool`'s own
 *     return value.
 *  2. `screen` resolved by `tcode: "SE16"` — a dialog transaction present on
 *     every ABAP system, including a bare ABAP Platform appliance — returns a
 *     non-empty program, dynpro and field list, every field carrying a name.
 *  3. The same dynpro, re-resolved by the `program`+`dynpro` form using
 *     exactly the values step 2 returned (never a hardcoded program name),
 *     comes back self-consistent: same program, same dynpro, same field
 *     count.
 *  4. `screen` given a tcode that cannot exist (`ZZZZNOPE`) is reported as a
 *     genuine failure — `dispatch()` rejects with `FLUID_ACTION_FAILED` —
 *     not silently as success.
 *
 * SAFETY: gated behind BOTH `ABAP_URL` and write access being configured
 * (`ABAP_MODE=edit`/`admin`, or legacy `ABAP_ALLOW_WRITE=true` — see
 * `test/helpers/live-write-gate.ts`) — `screen` is read-only, but even a
 * read-only fluid action can need to deploy or repair the ABAP side first,
 * so there is no read-only subset of the fluid API to gate on instead. This
 * suite writes only into `$ABAPSMITH_FLUID_API`: the tool's own entry class
 * `ZCL_ZMCP_FLUID_UI` (deployed by `ensureFluidTool`, content-addressed and
 * reused by any other slice/process that dispatches `ui` on this system) and
 * up to three generated invoker classes (`ZCL_ZMCP_I_` + 8 hex,
 * content-addressed by tool/action/args — one per distinct args object used
 * below). Nothing is ever written to `$TMP` or any other package — `screen`
 * never mutates ABAP state. `afterAll` deletes the entry class and every
 * invoker it can compute the name for, each independently, best-effort, with
 * its own fresh `AbapConnection` per delete (deleting a class tears down the
 * ABAP session server-side, so reusing one connection across deletes is not
 * safe) — same idiom as `test/integration-fluid-runtime.test.ts`'s
 * `deleteInvokerOnce`/`deleteInvokerIfPresent`. Neither `$ABAPSMITH_FLUID_API`
 * nor `ZCL_ZMCP_FLUID_RT` is ever deleted here — other slices depend on both
 * being present on the appliance.
 *
 * Concurrency note: another slice may be deploying its own fluid tool onto
 * the same appliance at the same time, so `$ABAPSMITH_FLUID_API` already
 * existing (and already holding other tools' objects) is expected — no
 * assertion here may require it to be empty.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { loadConfig, loadEnvFile, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { isAbapError } from "../src/adt/errors.js";
import { dispatch, type FluidDeps } from "../src/adt/fluid/dispatch.js";
import { ensureFluidTool } from "../src/adt/fluid/ensure.js";
import { FLUID_PACKAGE } from "../src/adt/fluid/package.js";
import { manifestVersion, type LoadedFluidTool } from "../src/adt/fluid/manifest.js";
import { invokerName } from "../src/adt/fluid/invoke.js";
import { uiManifest, uiSources } from "../src/adt/fluid/builtin/ui.js";
import { authorizeMutation, deleteObject } from "../src/adt/write.js";
import { parsePackageRef } from "../src/adt/package-ref.js";
import { forgetManifest } from "../src/adt/fluid/registry.js";
import { systemKey } from "../src/journal.js";
import { liveSuiteSkipReason, skipForApplianceState } from "./live-appliance-state.js";

loadEnvFile(); // so a .env in the repo root enables the live suite
const notRun = liveSuiteSkipReason({ write: true });
const dw = notRun === undefined ? describe : describe.skip;
// A collection-time skip is counted but never says why; state the reason once, greppably.
if (notRun !== undefined) it("live ui fluid tool: suite not run", (ctx) => skipForApplianceState(ctx, notRun));

const UI_TOOL_ID = "ui";
const UI_BODY_CLASS = "ZCL_ZMCP_FLUID_UI";
// SE16 is a dialog transaction present on every ABAP system, including a bare
// ABAP Platform appliance, and reading its dynpro is strictly read-only.
const SCREEN_ARGS = { tcode: "SE16" };
// Cannot exist as a real tcode: TSTC lookup must fail and the action must
// report a genuine failure, not silently succeed.
const BAD_SCREEN_ARGS = { tcode: "ZZZZNOPE" };

dw("live A4H ui fluid tool ($ABAPSMITH_FLUID_API, read-only screen inspection)", () => {
  let conn: AbapConnection;
  let cfg: Config;
  const breaker = new AuthCircuitBreaker();

  // allowNamePrefixes: ["*"] — FLUID_PACKAGE starts with "$", not "Z"/"Y", same
  // reasoning as test/integration-fluid-img.test.ts's GATE.
  const GATE = new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP", FLUID_PACKAGE],
    allowNamePrefixes: ["*"],
  });

  const uiTool: LoadedFluidTool = {
    manifest: uiManifest,
    origin: "builtin" as const,
    sources: uiSources,
    version: manifestVersion(uiManifest, uiSources),
  };
  const tools: ReadonlyMap<string, LoadedFluidTool> = new Map([[UI_TOOL_ID, uiTool]]);

  // Filled in by the "second input form" test once step 2's program/dynpro
  // are known — used only by afterAll to compute that call's invoker name.
  let secondFormArgs: { program: string; dynpro: string } | undefined;

  const assertUsable = () => {
    if (conn.breaker.isTripped) {
      throw new Error(`circuit breaker tripped: ${conn.breaker.info?.message}`);
    }
  };

  /** Independent read-back: whatever ensureFluidTool claims, ask the server directly. */
  const readClassPackage = async (className: string): Promise<string | undefined> => {
    const r = await conn.get(`/sap/bc/adt/oo/classes/${className.toLowerCase()}`, {
      headers: { Accept: "application/*" },
    });
    return parsePackageRef(r.body)?.toUpperCase();
  };

  const readClassIsActive = async (className: string): Promise<boolean> => {
    const r = await conn.get(`/sap/bc/adt/oo/classes/${className.toLowerCase()}`, {
      headers: { Accept: "application/*" },
    });
    const m = /<class:abapClass\b[^>]*\sadtcore:version="([^"]+)"/.exec(r.body);
    return m?.[1] === "active";
  };

  beforeAll(async () => {
    cfg = { ...loadConfig(), readOnly: false, allowPackages: ["$TMP", FLUID_PACKAGE] };
    conn = new AbapConnection(cfg, { log: () => {}, breaker });
    await conn.connect();
    // Drop any stale registry entry left by a previous run's afterAll (e.g. a
    // crash before cleanup, or an older suite version that didn't forget the
    // manifest). Without this, ensureFluidTool's on-disk short-circuit would
    // report ZCL_ZMCP_FLUID_UI as already "present" and skip deploying it,
    // even though this suite's own afterAll deletes that class every run.
    await forgetManifest(cfg, systemKey(conn.cfg), UI_TOOL_ID);
  }, 60_000);

  afterAll(async () => {
    // Best-effort: delete the tool's entry class and every generated invoker
    // this suite can have created — each independently, its own fresh
    // AbapConnection (deleting a class tears the ABAP session down
    // server-side, so a subsequent request on the same connection is exactly
    // where SESSION_DEAD would surface; a new connection per delete sidesteps
    // that rather than retrying into it) — same idiom as
    // test/integration-fluid-runtime.test.ts's deleteInvokerOnce.
    const deleteOnce = async (name: string): Promise<void> => {
      const c = new AbapConnection(cfg, { log: () => {}, breaker: new AuthCircuitBreaker() });
      await c.connect();
      try {
        const authorized = await authorizeMutation(c, GATE, "delete", { type: "CLAS/OC", name });
        await deleteObject(c, authorized);
      } finally {
        await c.shutdown("test-end");
      }
    };
    const deleteIfPresent = async (name: string): Promise<void> => {
      try {
        try {
          await deleteOnce(name);
        } catch (e) {
          if (isAbapError(e) && e.code === "SESSION_DEAD") {
            await deleteOnce(name);
          } else {
            throw e;
          }
        }
      } catch (e) {
        console.warn(`afterAll: failed to clean up ${name} — remove it by hand.`, e);
      }
    };

    const invokerNames = [
      invokerName(UI_TOOL_ID, "screen", SCREEN_ARGS, uiManifest.contract),
      invokerName(UI_TOOL_ID, "screen", BAD_SCREEN_ARGS, uiManifest.contract),
      ...(secondFormArgs
        ? [invokerName(UI_TOOL_ID, "screen", secondFormArgs, uiManifest.contract)]
        : []),
    ];
    for (const name of invokerNames) await deleteIfPresent(name);
    await deleteIfPresent(UI_BODY_CLASS);

    // Drop the registry entry now that ZCL_ZMCP_FLUID_UI is actually gone
    // from the appliance: leaving it behind would make the NEXT run's
    // ensureFluidTool trust the stale "present" entry and skip redeploying a
    // class that no longer exists, producing "Type ... is unknown" failures.
    // Best-effort and wrapped so a failure here never masks a real test
    // failure from the block above.
    try {
      await forgetManifest(cfg, systemKey(conn.cfg), UI_TOOL_ID);
    } catch (e) {
      console.warn(`afterAll: failed to forget registry entry for ${UI_TOOL_ID} — remove it by hand.`, e);
    }

    await conn?.shutdown("test-end");
  }, 180_000);

  it("deploys the ui body through ensure/dispatch and it is really active in the fluid package", async () => {
    assertUsable();
    const result = await ensureFluidTool(conn, GATE, cfg, uiTool, {
      tool: UI_TOOL_ID,
      action: "screen",
      op: "run",
    });

    expect(result.objects.map((o) => o.state)).toEqual(["present", "present"]);

    const pkg = await readClassPackage(UI_BODY_CLASS);
    expect(pkg).toBe(FLUID_PACKAGE);
    expect(await readClassIsActive(UI_BODY_CLASS)).toBe(true);
  }, 120_000);

  it("ui.screen resolved by tcode SE16 returns a non-empty program, dynpro and field list", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg, gate: GATE, tools };

    const result = await dispatch(deps, { tool: UI_TOOL_ID, action: "screen", args: SCREEN_ARGS });

    expect(result.tool).toBe(UI_TOOL_ID);
    expect(result.action).toBe("screen");

    const out = result.result as {
      tcode?: { tcode: string; program: string; dynpro: string; cinfo: string; kind: string; bdcApplies?: boolean };
      program: string;
      dynpro: string;
      header?: Record<string, string>;
      fields: readonly { name: string }[];
      flowCount?: number;
      flow?: readonly Record<string, string>[];
      statusCount?: number;
      statusList?: readonly Record<string, string>[];
      functionsCount?: number;
      functions?: readonly { code: string; text: string; type: string }[];
      fkeysCount?: number;
      fkeys?: readonly { status: string; code: string; text: string; quickinfo: string }[];
      statusLoop?: { done: number; total: number; capped: boolean };
      fkeyCap?: { emitted: number; capped: boolean };
      noCua?: { program: string; note: string };
    };
    expect(typeof out.program).toBe("string");
    expect(out.program.length).toBeGreaterThan(0);
    expect(typeof out.dynpro).toBe("string");
    expect(out.dynpro.length).toBeGreaterThan(0);
    expect(Array.isArray(out.fields)).toBe(true);
    expect(out.fields.length).toBeGreaterThan(0);
    for (const field of out.fields) {
      expect(typeof field.name).toBe("string");
      expect(field.name.length).toBeGreaterThan(0);
    }

    // Resolved by tcode: `tcode` must be present, self-consistent with the
    // top-level program/dynpro, and carry a `kind` classified from TSTC-CINFO.
    expect(out.tcode).toBeDefined();
    expect(out.tcode?.tcode).toBe("SE16");
    expect(out.tcode?.program).toBe(out.program);
    expect(out.tcode?.dynpro).toBe(out.dynpro);
    expect(typeof out.tcode?.cinfo).toBe("string");
    expect(["dialog", "report", "unrecognised"]).toContain(out.tcode?.kind);

    // `header` is always emitted (unconditional in the ABAP body), even if empty.
    expect(out.header).toBeDefined();
    expect(typeof out.header).toBe("object");

    // Flow logic is always emitted alongside fields.
    expect(typeof out.flowCount).toBe("number");
    expect(Array.isArray(out.flow)).toBe(true);
    expect(out.flow?.length).toBe(out.flowCount);

    // CUA fetch (RS_CUA_INTERNAL_FETCH) has exactly two normal outcomes for a
    // live dialog transaction's dynpro: a GUI status was found (statusList/
    // functions/fkeys populated) or none was (noCua) — never both, never neither.
    const hasCua = out.statusCount !== undefined;
    const hasNoCua = out.noCua !== undefined;
    expect(hasCua !== hasNoCua).toBe(true);
    if (hasCua) {
      expect(Array.isArray(out.statusList)).toBe(true);
      expect(out.statusList?.length).toBe(out.statusCount);
      expect(typeof out.functionsCount).toBe("number");
      expect(Array.isArray(out.functions)).toBe(true);
      expect(out.functions?.length).toBe(out.functionsCount);
      for (const fn of out.functions ?? []) {
        expect(typeof fn.code).toBe("string");
        expect(typeof fn.text).toBe("string");
        expect(typeof fn.type).toBe("string");
      }
      expect(typeof out.fkeysCount).toBe("number");
      expect(Array.isArray(out.fkeys)).toBe(true);
      expect(out.fkeys?.length).toBe(out.fkeysCount);
      for (const fkey of out.fkeys ?? []) {
        expect(typeof fkey.status).toBe("string");
        expect(typeof fkey.code).toBe("string");
        expect(fkey.code.length).toBeGreaterThan(0);
      }
      expect(out.statusLoop).toBeDefined();
      expect(typeof out.statusLoop?.done).toBe("number");
      expect(typeof out.statusLoop?.total).toBe("number");
      expect(typeof out.statusLoop?.capped).toBe("boolean");
      expect(out.fkeyCap).toBeDefined();
      expect(typeof out.fkeyCap?.emitted).toBe("number");
      expect(typeof out.fkeyCap?.capped).toBe("boolean");
    } else {
      expect(out.noCua?.program).toBe(out.program);
      expect(typeof out.noCua?.note).toBe("string");
    }

    // Step 3 below re-resolves this exact program/dynpro through the second
    // input form — never a hardcoded program name — and afterAll needs the
    // same args object to compute that call's invoker name for cleanup.
    secondFormArgs = { program: out.program, dynpro: out.dynpro };
    const first = out;

    const second = await dispatch(deps, {
      tool: UI_TOOL_ID,
      action: "screen",
      args: secondFormArgs,
    });
    const out2 = second.result as {
      tcode?: unknown;
      program: string;
      dynpro: string;
      fields: readonly { name: string }[];
    };
    expect(out2.program).toBe(first.program);
    expect(out2.dynpro).toBe(first.dynpro);
    expect(out2.fields.length).toBe(first.fields.length);
    // Resolved directly by program+dynpro: no TSTC lookup, so no `tcode` object.
    expect(out2.tcode).toBeUndefined();
  }, 180_000);

  it("ui.screen given a tcode that cannot exist is reported as a genuine failure, not silently as success", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg, gate: GATE, tools };

    await expect(
      dispatch(deps, { tool: UI_TOOL_ID, action: "screen", args: BAD_SCREEN_ARGS }),
    ).rejects.toMatchObject({ code: "FLUID_ACTION_FAILED" });
  }, 120_000);
});
