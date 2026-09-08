/**
 * Live integration test for the fluid API's built-in `img` tool
 * (`src/adt/fluid/builtin/img.ts`, entry class `ZCL_ZMCP_FLUID_IMG`) — slice
 * S4 of the IMG family's move onto the fluid API. `img.preview` is the one
 * action this file exercises: a read-only probe of a client-dependent
 * customizing table whose ABAP body reproduces `imgProbeSource`'s transcript
 * grammar and is parsed by the unchanged `parseImgWriteTranscript`, both from
 * `src/adt/img-write-bridge.ts`.
 *
 * The offline suites can only prove the manifest shape (`fluid-manifest.
 * test.ts`-style validation) and the TS-side transcript parser
 * (`img-write-bridge.test.ts`) against hand-written fixture text. They
 * cannot prove that SAP actually accepts and activates
 * `ZCL_ZMCP_FLUID_IMG` in `$ABAPSMITH_FLUID_API`, that the dynamic
 * read-only probe it generates actually runs and returns rows for a real
 * DDIC table, or that what comes back over the `ZMCP-H>` fluid console
 * frames is well-formed `IMGW>` transcript text end to end — a mismatch
 * between the generated ABAP's output and this repo's parser grammar shows
 * up nowhere except a live round trip. This file proves that, live, with
 * one read-only dispatch call.
 *
 * TARGET TABLE. `T005` (countries) is a client-dependent (`clidep = X`)
 * customizing table (delivery class `C`) present on a bare ABAP Platform
 * appliance, unlike ERP application tables such as `T001`, which A4H
 * lacks entirely; `LAND1` is its only non-client key field. The row
 * queried (`LAND1 = 'DE'`) may or may not exist — this suite asserts only
 * that exactly one before-image outcome was recorded for it, never which.
 *
 * SAFETY: gated behind BOTH `ABAP_URL` and write access being configured
 * (`ABAP_MODE=edit`/`admin`, or legacy `ABAP_ALLOW_WRITE=true` — see
 * `test/helpers/live-write-gate.ts`), same as `integration-fluid-run.test.ts`
 * — even a read-only fluid action can need to deploy or repair the ABAP side
 * first, so there is no read-only subset of the fluid API to gate on
 * instead. This suite writes exactly two throwaway classes into
 * `$ABAPSMITH_FLUID_API`: the tool's own entry class `ZCL_ZMCP_FLUID_IMG`
 * (deployed by `ensureFluidTool`, content-addressed and reused by any other
 * slice/process that dispatches `img` on this system) and one generated
 * invoker class (`ZCL_ZMCP_I_` + 8 hex, content-addressed by tool/action/
 * args — `dispatch()` itself never deletes it, see `src/adt/fluid/invoke.ts`
 * `invokerName`/`src/adt/fluid/dispatch.ts`). `afterAll` deletes both,
 * independently and best-effort, since a cleanup failure must not mask a
 * real one and must not be conflated with it either. Neither
 * `$ABAPSMITH_FLUID_API` nor `ZCL_ZMCP_FLUID_RT` is ever deleted here —
 * other slices depend on both being present on the appliance.
 *
 * Concurrency note: another slice may be deploying the fluid package or
 * other fluid tools onto the same appliance at the same time, so
 * `$ABAPSMITH_FLUID_API` already existing (and already containing other
 * tools/invokers) is expected and must not fail this suite —
 * `ensureFluidPackage`/`ensureFluidTool` are memoized/idempotent.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { loadConfig, loadEnvFile, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { authorizeMutation, deleteObject } from "../src/adt/write.js";
import { isSessionDeadFailure } from "../src/adt/write-verify.js";
import { dispatch, type FluidDeps } from "../src/adt/fluid/dispatch.js";
import { manifestVersion, type LoadedFluidTool } from "../src/adt/fluid/manifest.js";
import { invokerName } from "../src/adt/fluid/invoke.js";
import { imgManifest, imgSources } from "../src/adt/fluid/builtin/img.js";
import { parseImgWriteTranscript } from "../src/adt/img-write-bridge.js";
import { FLUID_PACKAGE } from "../src/adt/fluid/package.js";
import { liveSuiteSkipReason, skipForApplianceState } from "./live-appliance-state.js";

loadEnvFile(); // so a .env in the repo root enables the live suite
const notRun = liveSuiteSkipReason({ write: true });
const dw = notRun === undefined ? describe : describe.skip;
// A collection-time skip is counted but never says why; state the reason once, greppably.
if (notRun !== undefined) it("live fluid img: suite not run", (ctx) => skipForApplianceState(ctx, notRun));

const IMG_ARGS = { table: "T005", keyFields: ["LAND1"], rows: [{ LAND1: "DE" }] };

dw("live A4H fluid img tool (read-only preview against T005)", () => {
  let conn: AbapConnection;
  let cfg: Config;
  const breaker = new AuthCircuitBreaker();

  // allowNamePrefixes: ["*"] — FLUID_PACKAGE starts with "$", not "Z"/"Y", and
  // ensureFluidPackage/ensureFluidTool gate their creates by that name; matches
  // what the server runs with under ABAP_MODE=edit (src/mode.ts
  // EDIT_NAME_PREFIX_DEFAULT), same idiom as integration-fluid-run.test.ts.
  const GATE = new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP", FLUID_PACKAGE],
    allowNamePrefixes: ["*"],
  });

  const tools: ReadonlyMap<string, LoadedFluidTool> = new Map([
    [
      "img",
      {
        manifest: imgManifest,
        origin: "builtin" as const,
        sources: imgSources,
        version: manifestVersion(imgManifest, imgSources),
      },
    ],
  ]);

  const assertUsable = () => {
    if (conn.breaker.isTripped) {
      throw new Error(`circuit breaker tripped: ${conn.breaker.info?.message}`);
    }
  };

  beforeAll(async () => {
    cfg = { ...loadConfig(), readOnly: false, allowPackages: ["$TMP", FLUID_PACKAGE] };
    conn = new AbapConnection(cfg, { log: () => {}, breaker });
    await conn.connect();
  }, 60_000);

  afterAll(async () => {
    // Best-effort: delete the tool's entry class and the generated invoker —
    // each independently, neither throws, one reconnect-and-retry on
    // SESSION_DEAD (deleting a class tears down the ABAP session server-side)
    // — same idiom as integration-fluid-run.test.ts's `cleanup`.
    const cleanup = async (name: string) => {
      const authorizeAndDelete = async () => {
        const authorized = await authorizeMutation(conn, GATE, "delete", {
          type: "CLAS/OC",
          name,
        });
        await deleteObject(conn, authorized);
      };
      try {
        if (conn?.isConnected && !conn.breaker.isTripped) {
          try {
            await authorizeAndDelete();
          } catch (e) {
            if (!isSessionDeadFailure(e)) throw e;
            await conn.connect();
            await authorizeAndDelete();
          }
        }
      } catch (e) {
        console.warn(`afterAll: failed to clean up ${name} — remove it by hand.`, e);
      }
    };
    const invokerClass = invokerName("img", "preview", IMG_ARGS, imgManifest.contract);
    await cleanup(imgManifest.entry);
    await cleanup(invokerClass);
    await conn?.shutdown("test-end");
  }, 120_000);

  it("img.preview against T005/LAND1=DE returns a well-formed IMGW transcript", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg, gate: GATE, tools };

    const result = await dispatch(deps, {
      tool: "img",
      action: "preview",
      args: IMG_ARGS,
    });

    expect(result.tool).toBe("img");
    expect(result.action).toBe("preview");
    expect(Array.isArray(result.result)).toBe(true);
    const lines = result.result as unknown[];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(typeof line).toBe("string");

    const parsed = parseImgWriteTranscript((lines as string[]).join("\n"));

    // Load-bearing: any divergence between the generated ABAP's output and
    // parseImgWriteTranscript's grammar shows up here and nowhere else.
    expect(parsed.errors).toEqual([]);
    expect(parsed.droppedLines).toBe(0);

    expect(parsed.client).not.toBeNull();

    expect(parsed.table).not.toBeNull();
    expect(parsed.table!.table.toUpperCase()).toBe("T005");
    expect(parsed.table!.deliveryClass.length).toBeGreaterThan(0);

    expect(parsed.fields.length).toBeGreaterThan(1);
    expect(
      parsed.fields.some((f) => f.field.toUpperCase() === "LAND1" && f.key === true),
    ).toBe(true);

    // Never assert whether DE exists: BABSENT is a legitimate outcome.
    // Assert only that exactly one before-image outcome was recorded for row 1.
    const row1Present = parsed.before.some((v) => v.row === 1);
    const row1Absent = parsed.beforeAbsent.some((v) => v.row === 1);
    expect(row1Present).not.toBe(row1Absent);

    expect(parsed.probed).toBe(true);
  }, 180_000);
});
