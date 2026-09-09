/**
 * Live integration test for the fluid API's built-in `img` tool
 * (`src/adt/fluid/builtin/img.ts`, entry class `ZCL_ZMCP_FLUID_IMG`) — slice
 * S4/S12 of the IMG family's move onto the fluid API. Every pin below goes
 * through the `abap_img_edit` entry points a real MCP call actually uses —
 * `runImgProbe`/`runCreateCustomizingRequest` (`src/adt/img-write.ts`) — not
 * raw `dispatch()`, so a mismatch between what those wrappers claim to
 * return (`ImgProbeResult`/`CustomizingRequestResult`) and what dispatch
 * actually hands back shows up here, not just in the transcript grammar.
 *
 * - `img.preview` (via `runImgProbe`): a read-only probe of a
 *   client-dependent customizing table whose ABAP body lives in
 *   `ZCL_ZMCP_FLUID_IMG` (`src/adt/fluid/builtin/img.ts`) and emits the same
 *   `IMGW>` transcript grammar the retired per-call `imgProbeSource`
 *   generator used to (that generator is deleted; the grammar itself is
 *   unchanged), parsed by `parseImgWriteTranscript` in
 *   `src/adt/img-write-bridge.ts`, which still owns plan validation and
 *   transcript parsing for this tool. Run
 *   three times with the identical plan, once per `abap_img_edit` caller
 *   action (`"preview"`, `"upsert"`, `"delete"`) — the three modes that, in
 *   production, all reach this same fluid action before an armed upsert/
 *   delete ever writes (`runImgProbe`'s own doc comment). The three calls
 *   dispatch identical tool/action/args, so `dispatch()`'s content-addressed
 *   invoker (`src/adt/fluid/invoke.ts`) is deployed once and reused for all
 *   three — `caller.action` only changes what a `FLUID_API_DISABLED`
 *   refusal would report, never the class deployed or the plan executed.
 * - `img.create_request` (via `runCreateCustomizingRequest`): creates a real
 *   type-`W` customizing transport request via
 *   `TR_INSERT_REQUEST_WITH_TASKS`, parsed by
 *   `parseCustomizingRequestTranscript` (`src/adt/customizing-request.ts`),
 *   then deletes the request again in `afterAll` via `trDelete`
 *   (`src/adt/transports.ts`) so the appliance carries no residue.
 *
 * `img.apply` — the third fluid action, which upserts/deletes rows in a real
 * customizing table under a transport — is DELIBERATELY NOT exercised live
 * here, and so neither is `runImgApply`. Unlike `create_request` (whose only
 * durable effect, a throwaway transport header, is cleanly provable-
 * deletable via `trDelete`) or `preview` (no durable effect at all), `apply`
 * would mutate live customizing data on a shared appliance that other
 * slices/suites run against concurrently, and this repo has no established,
 * safe, known-idempotent customizing row for that purpose — restoring the
 * exact before-image after the test would itself be an unproven live write.
 * `img.apply`'s TS-side contract (`validateApplyPlan`, `IMGW_MAX_ROWS`) and
 * transcript parsing (`parseImgWriteTranscript`) are covered offline in
 * `test/img-write-bridge.test.ts`/`test/img-write.test.ts` against the
 * generalized fake in `test/helpers/fluid-img-fake.ts`, and its reroute
 * through `dispatch()` is covered offline (content-hash-aware, action-keyed)
 * in `test/img-edit-tool.test.ts`; only a real appliance round trip is out
 * of scope here, and that gap is called out in this slice's report rather
 * than papered over with an unsafe write.
 *
 * It is worth being exact about how wide that gap actually is, because it is
 * narrower than "img.apply is unproven live" suggests. All three actions
 * live in ONE class — `src/adt/fluid/builtin/img.ts` emits a single
 * `zcl_zmcp_fluid_img` source, and `imgManifest.entry` names it for
 * `preview`, `create_request` and `apply` alike. ABAP activation is
 * whole-class: SAP will not activate `zcl_zmcp_fluid_img` unless the `apply`
 * method compiles too. So the two pins below already prove, live, that
 * `apply`'s ABAP is syntactically valid and activates on a real system,
 * along with the shared `iv_json` argument decoding and `ZMCP-H>` framing it
 * uses. What is NOT proven live is only `apply`'s own runtime behaviour: that
 * its dynamic INSERT/MODIFY/DELETE against a real customizing table does what
 * the transcript claims, under a real transport. That is the residual gap,
 * and it is a behavioural one, not a "does this even deploy" one.
 *
 * The offline suites can only prove the manifest shape (`fluid-manifest.
 * test.ts`-style validation) and the TS-side transcript parsers against
 * hand-written fixture text. They cannot prove that SAP actually accepts
 * and activates `ZCL_ZMCP_FLUID_IMG` in `$ABAPSMITH_FLUID_API`, that the
 * dynamic ABAP it generates actually runs and returns real data, or that
 * what comes back over the `ZMCP-H>` fluid console frames is well-formed
 * transcript text end to end — a mismatch between the generated ABAP's
 * output and this repo's parser grammar shows up nowhere except a live
 * round trip. This file proves that, live, with dispatch calls for both
 * actions above.
 *
 * TARGET TABLE (preview). `T005` (countries) is a client-dependent
 * (`clidep = X`) customizing table (delivery class `C`) present on a bare
 * ABAP Platform appliance, unlike ERP application tables such as `T001`,
 * which A4H lacks entirely; `LAND1` is its only non-client key field. The
 * row queried (`LAND1 = 'DE'`) may or may not exist — this suite asserts
 * only that exactly one before-image outcome was recorded for it, never
 * which.
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
 * invoker class per distinct action/args pair (`ZCL_ZMCP_I_` + 8 hex,
 * content-addressed by tool/action/args — `dispatch()` itself never deletes
 * it, see `src/adt/fluid/invoke.ts` `invokerName`/`src/adt/fluid/dispatch.ts`).
 * It also creates exactly one real customizing request (`create_request`,
 * below). `afterAll` deletes every one of these, independently and
 * best-effort, since a cleanup failure must not mask a real one and must not
 * be conflated with it either. Neither `$ABAPSMITH_FLUID_API` nor
 * `ZCL_ZMCP_FLUID_RT` is ever deleted here — other slices depend on both
 * being present on the appliance.
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
import { invokerName } from "../src/adt/fluid/invoke.js";
import { imgManifest } from "../src/adt/fluid/builtin/img.js";
import { runImgProbe, runCreateCustomizingRequest, type ImgProbeResult } from "../src/adt/img-write.js";
import type { ImgProbePlan } from "../src/adt/img-write-bridge.js";
import type { CustomizingRequestPlan } from "../src/adt/customizing-request.js";
import { authorizeCeiling, isTrkorr, trDelete } from "../src/adt/transports.js";
import { FLUID_PACKAGE } from "../src/adt/fluid/package.js";
import { liveSuiteSkipReason, skipForApplianceState } from "./live-appliance-state.js";

loadEnvFile(); // so a .env in the repo root enables the live suite
const notRun = liveSuiteSkipReason({ write: true });
const dw = notRun === undefined ? describe : describe.skip;
// A collection-time skip is counted but never says why; state the reason once, greppably.
if (notRun !== undefined) it("live fluid img: suite not run", (ctx) => skipForApplianceState(ctx, notRun));

const PROBE_PLAN: ImgProbePlan = {
  table: "T005",
  clientField: "MANDT",
  keyFields: ["LAND1"],
  rows: [{ key: { LAND1: "DE" }, values: {} }],
  language: "E",
};
// What runImgProbe actually sends dispatch() as args — needed here only to compute the same
// content-hash invoker name afterAll cleans up; PROBE_PLAN carries strictly more (clientField,
// language) that runImgProbe never forwards to the fluid action itself.
const PROBE_DISPATCH_ARGS = {
  table: PROBE_PLAN.table,
  keyFields: PROBE_PLAN.keyFields,
  rows: PROBE_PLAN.rows.map((row) => row.key),
};
const CREATE_REQUEST_DESCRIPTION = "abapsmith fluid img live test (safe to delete)";
const CREATE_REQUEST_PLAN: CustomizingRequestPlan = { description: CREATE_REQUEST_DESCRIPTION };

dw("live A4H fluid img tool (preview against T005, create_request)", () => {
  let conn: AbapConnection;
  let cfg: Config;
  let createdRequest: string | undefined;
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

  // `create_request` declares `targets: {}` (img.ts): a type-W request is filed against no
  // package, so assertTargetsAgainstGate always falls to the package allowlist's fail-closed
  // "unknown package" branch unless that allowlist is wildcarded — same reasoning as img.ts's
  // own comment on the action, and the same convention test/img-write.test.ts uses offline.
  const CREATE_REQUEST_GATE = new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowNamePrefixes: ["*"],
  });

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
    // One invoker for all three preview/upsert/delete calls below — same tool/action/args, so
    // dispatch()'s content-addressed invoker (src/adt/fluid/invoke.ts) is identical across them.
    const previewInvoker = invokerName("img", "preview", PROBE_DISPATCH_ARGS, imgManifest.contract);
    const createRequestInvoker = invokerName("img", "create_request", CREATE_REQUEST_PLAN, imgManifest.contract);
    await cleanup(imgManifest.entry);
    await cleanup(previewInvoker);
    await cleanup(createRequestInvoker);

    // Best-effort, independent of the class cleanup above and of each other's success: a
    // customizing request is not a class, has no name-prefix/package gate, and trDelete proves
    // deletion itself (before/after probe) rather than trusting the DELETE response — see its
    // own doc comment in src/adt/transports.ts.
    if (createdRequest !== undefined) {
      try {
        if (conn?.isConnected && !conn.breaker.isTripped) {
          const proof = authorizeCeiling(GATE, "transport");
          const result = await trDelete(conn, createdRequest, proof);
          if (!result.deleted) {
            console.warn(
              `afterAll: customizing request ${createdRequest} was not confirmed deleted — remove it by hand.`,
              result,
            );
          }
        }
      } catch (e) {
        console.warn(`afterAll: failed to delete customizing request ${createdRequest} — remove it by hand.`, e);
      }
    }

    await conn?.shutdown("test-end");
  }, 120_000);

  // Load-bearing shared assertions for the mapped ImgProbeResult shape (runImgProbe,
  // src/adt/img-write.ts) — any divergence between what dispatch() actually returns and what
  // runImgProbe claims to hand back (transcript, bridgeClass, outputComplete, bodyBytes) shows up
  // here, not just against the fake in test/img-write.test.ts.
  const assertProbeResultShape = (probe: ImgProbeResult) => {
    expect(probe.plan).toBe(PROBE_PLAN);
    expect(probe.bridgeClass).toBe(imgManifest.entry);
    expect(typeof probe.bridgeRefreshed).toBe("boolean");
    expect(typeof probe.durationMs).toBe("number");
    expect(probe.outputComplete).toBe(true);
    expect(typeof probe.bodyBytes).toBe("number");
    expect(probe.bodyBytes).toBeGreaterThan(0);

    const parsed = probe.transcript;
    expect(parsed.errors).toEqual([]);
    expect(parsed.droppedLines).toBe(0);
    expect(parsed.client).not.toBeNull();
    expect(parsed.table).not.toBeNull();
    expect(parsed.table!.table.toUpperCase()).toBe("T005");
    expect(parsed.table!.deliveryClass.length).toBeGreaterThan(0);
    expect(parsed.fields.length).toBeGreaterThan(1);
    expect(parsed.fields.some((f) => f.field.toUpperCase() === "LAND1" && f.key === true)).toBe(true);

    // Never assert whether DE exists: BABSENT is a legitimate outcome.
    // Assert only that exactly one before-image outcome was recorded for row 1.
    const row1Present = parsed.before.some((v) => v.row === 1);
    const row1Absent = parsed.beforeAbsent.some((v) => v.row === 1);
    expect(row1Present).not.toBe(row1Absent);

    expect(parsed.probed).toBe(true);
  };

  it.each(["preview", "upsert", "delete"] as const)(
    "abap_img_edit %s mode routes img.preview through runImgProbe with a well-formed IMGW transcript",
    async (callerAction) => {
      assertUsable();
      const probe = await runImgProbe(conn, GATE, PROBE_PLAN, cfg, callerAction);
      assertProbeResultShape(probe);
    },
    180_000,
  );

  it("abap_img_edit create_request mode routes img.create_request through runCreateCustomizingRequest", async () => {
    assertUsable();
    const result = await runCreateCustomizingRequest(conn, CREATE_REQUEST_GATE, CREATE_REQUEST_PLAN, cfg);

    expect(result.plan).toBe(CREATE_REQUEST_PLAN);
    expect(result.bridgeClass).toBe(imgManifest.entry);
    expect(typeof result.bridgeRefreshed).toBe("boolean");
    expect(typeof result.durationMs).toBe("number");
    expect(result.outputComplete).toBe(true);
    expect(typeof result.bodyBytes).toBe("number");
    expect(result.bodyBytes).toBeGreaterThan(0);

    const parsed = result.transcript;
    // Load-bearing: any divergence between the generated ABAP's output and
    // parseCustomizingRequestTranscript's grammar shows up here and nowhere else.
    expect(parsed.errors).toEqual([]);
    expect(parsed.request).toBeDefined();
    expect(isTrkorr(parsed.request)).toBe(true);

    // Recorded here (not just at the end of the test) so a later assertion
    // failure still leaves afterAll able to delete the real request it created.
    createdRequest = parsed.request;

    // Every type-W request this bridge creates gets exactly one outcome for its task —
    // a real type-Q task, or an explicit NO_TASK warning — never both, never neither
    // (parseCustomizingRequestTranscript's own doc comment).
    const hasTask = parsed.task !== undefined;
    const noTaskWarned = parsed.warnings.some((w) => w.includes("NO_TASK"));
    expect(hasTask).not.toBe(noTaskWarned);
    if (hasTask) {
      expect(isTrkorr(parsed.task)).toBe(true);
      expect(parsed.taskType).toBe("Q");
    }
  }, 180_000);
});
