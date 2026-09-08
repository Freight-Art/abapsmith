/**
 * Live integration test for the built-in `fpm` fluid tool
 * (`src/adt/fluid/builtin/fpm.ts`, entry class `ZCL_ZMCP_FLUID_FPM`) — the
 * READ half of the legacy `fpm-runtime.ts` FPM/FBI screen-config inspection
 * (`findBody`/`outlineBody`/`appBody`), reshaped onto the fluid body-class
 * contract. `find`, `outline` and `app` are the three actions this file
 * exercises.
 *
 * HONESTY CONSTRAINT — read this before reading the assertions below. The
 * target is a bare ABAP Platform appliance (A4H). It carries the
 * WDY_CONFIG_* tables (Web Dynpro ABAP ships as part of SAP_BASIS) but is
 * very unlikely to hold any real FPM/FBI application configuration — no
 * Fiori/FBI app was ever customized on it. So this suite does NOT assert
 * that `find` returns any rows, and does NOT assert that any particular
 * config exists. What it proves instead is the TRANSPORT and the ERROR
 * CONTRACT:
 *
 *  1. `ensureFluidTool` deploys and activates `ZCL_ZMCP_FLUID_RT` (also
 *     redeployed here since its source changed this slice — expected, not a
 *     defect) and `ZCL_ZMCP_FLUID_FPM` into `$ABAPSMITH_FLUID_API` — read
 *     back independently over ADT, not just trusted from `ensureFluidTool`'s
 *     own return value.
 *  2. `find` with a broad wildcard query round-trips: `dispatch()` resolves
 *     (does not reject), the result is an array — possibly EMPTY, since a
 *     bare appliance may legitimately have zero matching configs, and this
 *     suite treats that as success, not as something to work around — and,
 *     only if the array is non-empty, every element validates against the
 *     action's own declared output schema via `validateAgainstSchema`. This
 *     exercises deploy, dispatch, the ABAP LIKE-pattern rebuild
 *     (`_`->`#_`, `*`->`%`, `ESCAPE '#'`) and the JSON frame round trip
 *     end-to-end without depending on the appliance having any content.
 *  3. `outline` given a `config_id` that cannot exist is reported as a
 *     genuine failure — `dispatch()` rejects with `FLUID_ACTION_FAILED` —
 *     not silently as success. This is the assertion that matters most: a
 *     body whose error arm forgets `zcl_zmcp_fluid_rt=>err` reads as success
 *     at the ABAP layer, and only a live run catches that.
 *  4. `app` given the same nonexistent `config_id` likewise rejects with
 *     `FLUID_ACTION_FAILED` — `app`'s `config_id` is required, and the
 *     appliance is not expected to have any application config under that
 *     id — so all three actions are exercised at least once.
 *
 * What this suite CANNOT prove on a bare appliance: `outline`'s `out_chunk`
 * fragment-reassembly path (its XML payload is emitted via out_chunk/out('')
 * pairs that `protocol.ts` stitches back into one string before dispatch
 * parses it) is only exercised when a config with non-trivial XML actually
 * exists to be read. A system carrying real FPM configurations would additionally
 * assert that `outline` on a real `config_id` returns non-empty `xml` and
 * self-consistent `meta`, and that `app` on a real application config's
 * `config_id` returns a non-empty node array. This suite does not invent
 * that content.
 *
 * SAFETY: gated behind BOTH `ABAP_URL` and write access being configured
 * (`ABAP_MODE=edit`/`admin`, or legacy `ABAP_ALLOW_WRITE=true` — see
 * `test/helpers/live-write-gate.ts`) — `find`/`outline`/`app` are read-only,
 * but even a read-only fluid action can need to deploy or repair the ABAP
 * side first, so there is no read-only subset of the fluid API to gate on
 * instead. This suite writes only into `$ABAPSMITH_FLUID_API`: the tool's
 * own entry class `ZCL_ZMCP_FLUID_FPM` (deployed by `ensureFluidTool`,
 * content-addressed and reused by any other slice/process that dispatches
 * `fpm` on this system) and up to three generated invoker classes
 * (`ZCL_ZMCP_I_` + 8 hex, content-addressed by tool/action/args — one per
 * distinct args object used below). Nothing is ever written to `$TMP` or
 * any other package, and no WDY_CONFIG_* row is ever touched — all three
 * actions are strictly read-only. `afterAll` deletes the entry class and
 * every invoker it can compute the name for, each independently,
 * best-effort, with its own fresh `AbapConnection` per delete (deleting a
 * class tears down the ABAP session server-side, so reusing one connection
 * across deletes is not safe) — same idiom as
 * `test/integration-fluid-runtime.test.ts`'s
 * `deleteInvokerOnce`/`deleteInvokerIfPresent`, copied here via
 * `test/integration-fluid-ui.test.ts`. Neither `$ABAPSMITH_FLUID_API` nor
 * `ZCL_ZMCP_FLUID_RT` is ever deleted here — other slices depend on both
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
import { manifestVersion, validateAgainstSchema, type LoadedFluidTool } from "../src/adt/fluid/manifest.js";
import { invokerName } from "../src/adt/fluid/invoke.js";
import { fpmManifest, fpmSources } from "../src/adt/fluid/builtin/fpm.js";
import { authorizeMutation, deleteObject } from "../src/adt/write.js";
import { parsePackageRef } from "../src/adt/package-ref.js";
import { forgetManifest } from "../src/adt/fluid/registry.js";
import { systemKey } from "../src/journal.js";
import { liveSuiteSkipReason, skipForApplianceState } from "./live-appliance-state.js";

loadEnvFile(); // so a .env in the repo root enables the live suite
const notRun = liveSuiteSkipReason({ write: true });
const dw = notRun === undefined ? describe : describe.skip;
// A collection-time skip is counted but never says why; state the reason once, greppably.
if (notRun !== undefined) it("live fpm fluid tool: suite not run", (ctx) => skipForApplianceState(ctx, notRun));

const FPM_TOOL_ID = "fpm";
const FPM_BODY_CLASS = "ZCL_ZMCP_FLUID_FPM";
// Broad wildcard, component-scope (config_type defaults to "00"): matches
// anything, but may legitimately match nothing on a bare appliance — the
// point is the round trip, not the row count.
const FIND_ARGS = { query: "*" };
// Cannot exist as a real config_id (32-char field, this is well inside
// bounds but not a plausible customized name): the DB lookup must miss and
// the action must report a genuine failure, not silently succeed.
const BAD_CONFIG_ID = "ZZZZ_NO_SUCH_CFG";
const OUTLINE_ARGS = { config_id: BAD_CONFIG_ID };
const APP_ARGS = { config_id: BAD_CONFIG_ID };

dw("live A4H fpm fluid tool ($ABAPSMITH_FLUID_API, read-only FPM/FBI config inspection)", () => {
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

  const fpmTool: LoadedFluidTool = {
    manifest: fpmManifest,
    origin: "builtin" as const,
    sources: fpmSources,
    version: manifestVersion(fpmManifest, fpmSources),
  };
  const tools: ReadonlyMap<string, LoadedFluidTool> = new Map([[FPM_TOOL_ID, fpmTool]]);

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
    // report ZCL_ZMCP_FLUID_FPM as already "present" and skip deploying it,
    // even though this suite's own afterAll deletes that class every run.
    await forgetManifest(cfg, systemKey(conn.cfg), FPM_TOOL_ID);
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
      invokerName(FPM_TOOL_ID, "find", FIND_ARGS, fpmManifest.contract),
      invokerName(FPM_TOOL_ID, "outline", OUTLINE_ARGS, fpmManifest.contract),
      invokerName(FPM_TOOL_ID, "app", APP_ARGS, fpmManifest.contract),
    ];
    for (const name of invokerNames) await deleteIfPresent(name);
    await deleteIfPresent(FPM_BODY_CLASS);

    // Drop the registry entry now that ZCL_ZMCP_FLUID_FPM is actually gone
    // from the appliance: leaving it behind would make the NEXT run's
    // ensureFluidTool trust the stale "present" entry and skip redeploying a
    // class that no longer exists, producing "Type ... is unknown" failures.
    // Best-effort and wrapped so a failure here never masks a real test
    // failure from the block above.
    try {
      await forgetManifest(cfg, systemKey(conn.cfg), FPM_TOOL_ID);
    } catch (e) {
      console.warn(`afterAll: failed to forget registry entry for ${FPM_TOOL_ID} — remove it by hand.`, e);
    }

    await conn?.shutdown("test-end");
  }, 180_000);

  it("deploys the fpm body through ensure/dispatch and it is really active in the fluid package", async () => {
    assertUsable();
    const result = await ensureFluidTool(conn, GATE, cfg, fpmTool, {
      tool: FPM_TOOL_ID,
      action: "find",
      op: "run",
    });

    expect(result.objects.map((o) => o.state)).toEqual(["present", "present"]);

    const pkg = await readClassPackage(FPM_BODY_CLASS);
    expect(pkg).toBe(FLUID_PACKAGE);
    expect(await readClassIsActive(FPM_BODY_CLASS)).toBe(true);
  }, 120_000);

  it("fpm.find with a broad wildcard round-trips: succeeds, returns an array, and any rows validate against the schema", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg, gate: GATE, tools };

    const result = await dispatch(deps, { tool: FPM_TOOL_ID, action: "find", args: FIND_ARGS });

    expect(result.tool).toBe(FPM_TOOL_ID);
    expect(result.action).toBe("find");

    const rows = result.result as readonly unknown[];
    expect(Array.isArray(rows)).toBe(true);
    // NOT asserting rows.length > 0: a bare ABAP Platform appliance is very
    // unlikely to have any customized FPM/FBI config, and an empty result
    // here is a legitimate outcome, not a failure to work around. When rows
    // ARE present, every one of them must be well-formed per the action's
    // own declared output schema.
    const spec = fpmManifest.actions.find((a) => a.name === "find");
    expect(spec).toBeDefined();
    for (const row of rows) {
      const problems = validateAgainstSchema(row, spec!.output.items!, "find[]");
      expect(problems).toEqual([]);
    }
  }, 120_000);

  it("fpm.outline given a config_id that cannot exist is reported as a genuine failure, not silently as success", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg, gate: GATE, tools };

    await expect(
      dispatch(deps, { tool: FPM_TOOL_ID, action: "outline", args: OUTLINE_ARGS }),
    ).rejects.toMatchObject({ code: "FLUID_ACTION_FAILED" });
  }, 120_000);

  it("fpm.app given a config_id that cannot exist is reported as a genuine failure, not silently as success", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg, gate: GATE, tools };

    await expect(
      dispatch(deps, { tool: FPM_TOOL_ID, action: "app", args: APP_ARGS }),
    ).rejects.toMatchObject({ code: "FLUID_ACTION_FAILED" });
  }, 120_000);
});
