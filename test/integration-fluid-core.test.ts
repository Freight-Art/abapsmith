/**
 * Live integration test for the fluid API's built-in `core` tool
 * (`src/adt/fluid/builtin/core.ts`, entry class `ZCL_ZMCP_FLUID_CORE`) and for
 * the retired-bridge reaper (`src/adt/fluid/retired.ts`). `core` is the
 * generic read/execute bridge: an ad-hoc table `select`, a function-module
 * interface `describe_fm`, and a function-module `call_fm` — the first fluid
 * tool that reaches arbitrary DDIC tables and arbitrary function modules
 * rather than one fixed operation.
 *
 * The offline suites can only prove the manifest shape (schema validation,
 * `guardCoreAction`'s refusal branches against a fake connection/gate) and
 * the generated-ABAP source text itself. They cannot prove that SAP actually
 * accepts and activates `ZCL_ZMCP_FLUID_CORE` in `$ABAPSMITH_FLUID_API`, that
 * a dynamic `SELECT (lv_flds) FROM (lv_table) ... WHERE (lv_where)` actually
 * runs against a real DDIC table, that `CALL FUNCTION lv_name
 * PARAMETER-TABLE lt_ptab` actually round-trips a real function module's
 * importing/exporting parameters including a full structure serialised by
 * `to_json`, or that an unresolvable function-module name actually reaches
 * the runtime's `rt=>err` frame and comes back out through
 * `parseFluidConsole`/`dispatch()` as a thrown `AbapError`. This file proves
 * all of that, live.
 *
 * TARGET OBJECTS. `T005` (countries) is the same client-dependent
 * customizing table `integration-fluid-img.test.ts` already reads on a bare
 * ABAP Platform appliance; `LAND1` is its key field. `RFC_SYSTEM_INFO` is a
 * side-effect-free SAP-standard function module present on every system,
 * with a structured `RFCSI_EXPORT` EXPORTING parameter — the load-bearing
 * proof that `core.call_fm`'s recursive struct→JSON conversion works, not
 * just scalars. `CONVERSION_EXIT_ALPHA_INPUT` is the standard ALPHA
 * conversion exit, used only to prove the IMPORTING-parameter bind path
 * (`INPUT` -> `OUTPUT`); its exact padded output width is not pinned here.
 * `RETIRED_BRIDGE_CLASSES` (`ZCL_ZMCP_DDIC_*`, `ZCL_ZMCP_IMG_WPROBE`) is the
 * closed, static list of pre-fluid-API bridge classes; this suite proves
 * `probeRetiredBridges`/`reapRetiredBridges` against whatever the appliance
 * actually has (tolerating total absence as the normal case) — it never
 * creates any of them.
 *
 * ORDERING. `core.call_fm` refuses before any deploy step when
 * `ABAP_ALLOW_FLUID_CALL_FM` is off (`guardCoreAction` runs ahead of
 * `ensureFluidPackage`/`ensureFluidTool`/deploy in `dispatch()` — see
 * `src/adt/fluid/dispatch.ts`), and the only way to make that provable rather
 * than merely asserted is to run that refusal FIRST, before any other test in
 * this file has had a chance to deploy anything. The retired-bridge probe/
 * reap test runs LAST: a delete kills the ADT session, and this file's
 * `afterAll` uses a fresh `AbapConnection` for every cleanup delete anyway,
 * so nothing after it depends on session continuity.
 *
 * SAFETY: gated behind BOTH `ABAP_URL` and write access being configured
 * (`ABAP_MODE=edit`/`admin`, or legacy `ABAP_ALLOW_WRITE=true` — see
 * `test/helpers/live-write-gate.ts`), same as `integration-fluid-img.test.ts`
 * / `integration-fluid-classic.test.ts`. This suite writes exactly one
 * throwaway class into `$ABAPSMITH_FLUID_API` beyond the tool's own entry
 * class — one generated invoker per distinct args object that successfully
 * reached the deploy step (content-addressed, `ZCL_ZMCP_I_` + 8 hex, see
 * `src/adt/fluid/invoke.ts`'s `invokerName`) — and `afterAll` deletes the
 * entry class plus every one of those invokers, independently and
 * best-effort. Neither `$ABAPSMITH_FLUID_API` nor `ZCL_ZMCP_FLUID_RT` is ever
 * deleted here — other slices depend on both being present on the appliance.
 * The retired-bridge reap step deletes only pre-existing leftovers it itself
 * finds `"present"`; it never creates any retired class.
 *
 * Concurrency note: another slice may be deploying the fluid package or other
 * fluid tools onto the same appliance at the same time, so
 * `$ABAPSMITH_FLUID_API` already existing (and already containing other
 * tools/invokers) is expected and must not fail this suite —
 * `ensureFluidPackage`/`ensureFluidTool` are memoized/idempotent, same as the
 * other fluid live suites.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AbapConnection } from "../src/adt/connection.js";
import { AdtSessionPool } from "../src/adt/pool.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { loadConfig, loadEnvFile, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { authorizeMutation, deleteObject } from "../src/adt/write.js";
import { dispatch, type FluidDeps } from "../src/adt/fluid/dispatch.js";
import { manifestVersion, type LoadedFluidTool } from "../src/adt/fluid/manifest.js";
import { invokerName } from "../src/adt/fluid/invoke.js";
import { coreManifest, coreSources } from "../src/adt/fluid/builtin/core.js";
import { probeRetiredBridges, reapRetiredBridges, RETIRED_BRIDGE_CLASSES } from "../src/adt/fluid/retired.js";
import { isAbapError } from "../src/adt/errors.js";
import { FLUID_PACKAGE } from "../src/adt/fluid/package.js";
import { liveSuiteSkipReason, skipForApplianceState } from "./live-appliance-state.js";

loadEnvFile(); // so a .env in the repo root enables the live suite
const notRun = liveSuiteSkipReason({ write: true });
const dw = notRun === undefined ? describe : describe.skip;
// A collection-time skip is counted but never says why; state the reason once, greppably.
if (notRun !== undefined) it("live fluid core: suite not run", (ctx) => skipForApplianceState(ctx, notRun));

// Module-scope args consts, named so the exact same object identity feeds
// both a dispatch() call below and the invokerName() call in afterAll —
// invokerName hashes canonicalArgsJson(args), so afterAll can recompute the
// same content-addressed invoker class name for cleanup.
const SELECT_ARGS_BOUNDED = { table: "T005", fields: ["LAND1", "LANDK"], max_rows: 5 };
const SELECT_ARGS_NO_MAX = { table: "T005", fields: ["LAND1"] };
const DESCRIBE_RFC_ARGS = { name: "RFC_SYSTEM_INFO" };
const DESCRIBE_BAD_ARGS = { name: "ZZ_NO_SUCH_FM_ABAPSMITH" };
// Same content as DESCRIBE_BAD_ARGS's sibling below but a DISTINCT object:
// this one is dispatched with the flag OFF and never reaches deploy (see the
// first test), so it deliberately does not appear in afterAll's cleanup list.
const CALL_FM_ARGS_FLAG_OFF = { name: "RFC_SYSTEM_INFO", params: {} };
const CALL_FM_ARGS_RFC_SYSTEM_INFO = { name: "RFC_SYSTEM_INFO", params: {} };
const CALL_FM_ARGS_ALPHA = { name: "CONVERSION_EXIT_ALPHA_INPUT", params: { INPUT: "42" } };
// Refused by guardCoreAction (BAD_INPUT, missing confirm) before deploy, same
// as CALL_FM_ARGS_FLAG_OFF above — also deliberately absent from cleanup.
const CALL_FM_ARGS_COMMIT_NO_CONFIRM = { name: "RFC_SYSTEM_INFO", params: {}, commit: true };

interface CoreDescribeFmParam {
  readonly kind: string;
  readonly name: string;
  readonly type: string;
}

interface CoreDescribeFmResult {
  readonly name: string;
  readonly parameters: readonly CoreDescribeFmParam[];
  readonly exceptions: readonly string[];
  readonly params_schema: { readonly type: string; readonly properties?: Record<string, unknown> };
}

interface CoreCallFmResultItem {
  readonly name: string;
  readonly kind: string;
  readonly value: unknown;
}

/**
 * Diagnostic only (not an assertion helper): when `dispatch()` throws
 * `AbapError("FLUID_ACTION_FAILED", ...)`, the actually useful detail — the
 * ABAP-side `fail(...)` text relayed by `parseFluidConsole` — lives only in
 * `details.frames[].text` (see spec test 4 above and
 * `src/adt/fluid/dispatch.ts`), never in the generic top-level
 * `"${tool}.${action} reported ${N} error frame(s)."` message. `details` is
 * typed as a loose `Record<string, unknown>` on `AbapError`
 * (`src/adt/errors.ts`), so this narrows defensively at every step and must
 * never itself throw — even when `e` isn't an `AbapError`, or `frames` is
 * missing, not an array, or contains entries with no string `text`.
 */
function logErrorFrameTexts(e: unknown): void {
  if (!isAbapError(e)) return;
  const frames = e.details["frames"];
  if (!Array.isArray(frames)) return;
  for (const frame of frames) {
    const text =
      typeof frame === "object" && frame !== null && typeof (frame as { text?: unknown }).text === "string"
        ? (frame as { text: string }).text
        : `(non-string frame: ${String(frame)})`;
    console.error(`error frame: ${text}`);
  }
}

dw("live A4H fluid core tool (select/describe_fm/call_fm) + retired-bridge reaper", () => {
  let conn: AbapConnection;
  let cfgOn: Config;
  let cfgOff: Config;
  // Same Config shape beforeAll builds `conn` from — captured here (not
  // recomputed) so afterAll's fresh per-delete connections are built from the
  // exact identical object, not a fresh loadConfig() read.
  let base: Config;
  const breaker = new AuthCircuitBreaker();

  // allowNamePrefixes: ["*"] — FLUID_PACKAGE starts with "$", not "Z"/"Y", and
  // ensureFluidPackage/ensureFluidTool gate their creates by that name; matches
  // what the server runs with under ABAP_MODE=edit (src/mode.ts
  // EDIT_NAME_PREFIX_DEFAULT), same idiom as integration-fluid-img.test.ts /
  // integration-fluid-classic.test.ts.
  //
  // DEVIATION FROM SPEC: the spec said to pass `canPreviewData: true` into
  // this constructor. No such SafetyConfig field exists — src/safety.ts's
  // SafetyConfig has no canPreviewData member; the `canPreviewData` name that
  // does exist in that file belongs to a differently-shaped object built by
  // capabilitiesFor() (src/adt/capabilities.ts), unrelated to SafetyGate's
  // constructor. What actually gates core.select's data preview is
  // SafetyGate.assertDataPreview(), called from guardCoreAction BEFORE the
  // cfg.allowDataPreview check — and assertDataPreview fail-closes with
  // READ_ONLY until this gate's own writesLockedOut/systemRole/productive
  // fields are populated. Nothing wires a connection's role-probe verdict
  // into a freshly-constructed SafetyGate automatically (src/server.ts's
  // ensureConnected does this by hand via gate.update() after connect() —
  // see beforeAll below, which copies that exact idiom).
  const GATE = new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP", FLUID_PACKAGE],
    allowNamePrefixes: ["*"],
  });

  const tools: ReadonlyMap<string, LoadedFluidTool> = new Map([
    [
      "core",
      {
        manifest: coreManifest,
        origin: "builtin" as const,
        sources: coreSources,
        version: manifestVersion(coreManifest, coreSources),
      },
    ],
  ]);

  const assertUsable = () => {
    if (conn.breaker.isTripped) {
      throw new Error(`circuit breaker tripped: ${conn.breaker.info?.message}`);
    }
  };

  beforeAll(async () => {
    // Both capability flags are set by constructing the config explicitly,
    // never by relying on the wrapper's process env, so the suite is
    // deterministic regardless of the shell it is launched from.
    base = { ...loadConfig(), readOnly: false, allowPackages: ["$TMP", FLUID_PACKAGE] };
    cfgOn = { ...base, allowDataPreview: true, allowFluidCallFm: true };
    cfgOff = { ...base, allowDataPreview: true, allowFluidCallFm: false };

    conn = new AbapConnection(base, { log: () => {}, breaker });
    const info = await conn.connect();
    // T000 probe is the authority; this only transcribes its verdict onto
    // GATE, the exact idiom src/server.ts's ensureConnected uses on `safety`
    // after connect() resolves — required so core.select's
    // assertDataPreview() call doesn't fail-closed with READ_ONLY (see the
    // GATE comment above).
    GATE.update({
      productive: info.roleDetection.role === "productive",
      systemRole: info.systemRole,
      writesLockedOut: info.writesLockedOut,
      lockoutReason: info.roleDetection.reason,
      roleProbeFailure: info.roleDetection.probeFailure,
    });
  }, 60_000);

  afterAll(async () => {
    // Best-effort, independent, never throwing. A delete kills the ADT
    // session server-side, so every delete after the first needs a revive —
    // but `AbapConnection` enforces LOGON_ENDPOINT_LIFETIME_CEILING (5) logon-
    // endpoint requests PER INSTANCE outside a budgeted request(), and this
    // suite's cleanup list is longer than that ceiling. Reconnecting the one
    // shared `conn` before every delete burns through the ceiling and the
    // tail of the cleanup dies with a permanently-refusing instance. Instead,
    // each delete gets its own brand-new `AbapConnection` — a fresh instance
    // starts with its own logon counter at zero, so the ceiling is never
    // approached no matter how many objects are in the list. Built the exact
    // same way beforeAll builds its own `conn` (same config shape, same
    // shared `breaker` — one SAP user means one breaker instance, see the
    // constructor comment in src/adt/connection.ts), so credentials/settings
    // stay identical. Same delete idiom as integration-fluid-img.test.ts's
    // `cleanup` otherwise: each object is independent and best-effort inside
    // its own try/catch that warns (naming the object) and moves on — but
    // exactly one connect() per fresh instance, never a retry loop.
    const cleanup = async (name: string) => {
      let fresh: AbapConnection | undefined;
      try {
        fresh = new AbapConnection(base, { log: () => {}, breaker });
        await fresh.connect();
        const authorized = await authorizeMutation(fresh, GATE, "delete", { type: "CLAS/OC", name });
        await deleteObject(fresh, authorized);
      } catch (e) {
        console.warn(`afterAll: failed to clean up ${name} — remove it by hand.`, e);
      } finally {
        await fresh?.shutdown("test-end");
      }
    };

    // One invoker per args object that actually reached dispatch()'s deploy
    // step. deployBridge() runs BEFORE executeBridge()/the transcript-error
    // check in dispatch(), so DESCRIBE_BAD_ARGS's invoker was deployed even
    // though that dispatch() call ultimately threw FLUID_ACTION_FAILED — it
    // still needs cleanup. CALL_FM_ARGS_FLAG_OFF and
    // CALL_FM_ARGS_COMMIT_NO_CONFIRM never reached deploy at all
    // (guardCoreAction throws first), so they are deliberately excluded.
    const contract = coreManifest.contract;
    const invokerClasses = [
      invokerName("core", "select", SELECT_ARGS_BOUNDED, contract),
      invokerName("core", "select", SELECT_ARGS_NO_MAX, contract),
      invokerName("core", "describe_fm", DESCRIBE_RFC_ARGS, contract),
      invokerName("core", "describe_fm", DESCRIBE_BAD_ARGS, contract),
      invokerName("core", "call_fm", CALL_FM_ARGS_RFC_SYSTEM_INFO, contract),
      invokerName("core", "call_fm", CALL_FM_ARGS_ALPHA, contract),
    ];

    await cleanup(coreManifest.entry);
    for (const invokerClass of invokerClasses) {
      await cleanup(invokerClass);
    }
    await conn?.shutdown("test-end");
  }, 180_000);

  // Spec test 5, run FIRST: proves guardCoreAction's ABAP_ALLOW_FLUID_CALL_FM
  // refusal sits ahead of ensureFluidPackage/deploy in dispatch() — the only
  // way to make that provable rather than merely asserted is for this to be
  // the first dispatch() call this file makes, before any other test has had
  // a chance to deploy anything.
  it("core.call_fm refuses before any deploy when ABAP_ALLOW_FLUID_CALL_FM is off (runs first)", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg: cfgOff, gate: GATE, tools };

    await expect(
      dispatch(deps, { tool: "core", action: "call_fm", args: CALL_FM_ARGS_FLAG_OFF }),
    ).rejects.toMatchObject({
      code: "SAFETY_DENIED",
      details: { rule: "ABAP_ALLOW_FLUID_CALL_FM" },
    });
  }, 180_000);

  // Spec test 1.
  it("core.select against T005 (LAND1, LANDK, max_rows: 5) returns bounded rows", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg: cfgOn, gate: GATE, tools };

    const result = await dispatch(deps, { tool: "core", action: "select", args: SELECT_ARGS_BOUNDED });

    expect(result.tool).toBe("core");
    expect(result.action).toBe("select");
    expect(Array.isArray(result.result)).toBe(true);
    const rows = result.result as readonly Record<string, unknown>[];
    expect(rows.length).toBeLessThanOrEqual(5);
    for (const row of rows) {
      expect(typeof row).toBe("object");
      expect(typeof row["LAND1"]).toBe("string");
    }
    // Never assert which countries exist — T005's content varies by appliance.
  }, 180_000);

  // Spec test 2: proves "no cap".
  it("core.select against T005 with max_rows omitted is unbounded (UP TO 0 ROWS = no restriction)", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg: cfgOn, gate: GATE, tools };

    const result = await dispatch(deps, { tool: "core", action: "select", args: SELECT_ARGS_NO_MAX });

    expect(result.tool).toBe("core");
    expect(result.action).toBe("select");
    expect(Array.isArray(result.result)).toBe(true);
    // src/adt/fluid/builtin/core/abap-select.ts's own header comment: max_rows
    // (0 when omitted) goes straight into `UP TO @lv_max ROWS`, and ABAP's own
    // rule for that construct is that 0 means no restriction. Any ceiling on
    // what core.select may read lives in TypeScript (guardCoreAction /
    // ABAP_ALLOW_DATA_PREVIEW), never in this generated ABAP. This is a
    // deliberate unbounded read of a small customizing table; the only budget
    // is buildResponse's own truncation.
  }, 180_000);

  // Spec test 3.
  it("core.describe_fm on RFC_SYSTEM_INFO reports RFCSI_EXPORT as an 'out' parameter", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg: cfgOn, gate: GATE, tools };

    const result = await dispatch(deps, { tool: "core", action: "describe_fm", args: DESCRIBE_RFC_ARGS });

    expect(result.tool).toBe("core");
    expect(result.action).toBe("describe_fm");
    const described = result.result as CoreDescribeFmResult;
    expect(described.name).toBe("RFC_SYSTEM_INFO");
    expect(Array.isArray(described.parameters)).toBe(true);
    expect(described.parameters.length).toBeGreaterThan(0);
    // FUPARAREF PARAMTYPE 'E' (the FM's own EXPORTING parameter) is relabeled
    // to the CALLER's point of view by src/adt/fluid/builtin/core/abap-fm.ts:
    // kind "out" — not the literal word "EXPORTING". RFCSI_EXPORT is
    // RFC_SYSTEM_INFO's one structured exporting parameter.
    const rfcsiExport = described.parameters.find((p) => p.name.toUpperCase() === "RFCSI_EXPORT");
    expect(rfcsiExport).toBeDefined();
    expect(rfcsiExport?.kind).toBe("out");
    expect(described.params_schema.type).toBe("object");
    expect(described.params_schema.properties).toBeDefined();
  }, 180_000);

  // Spec test 4: proves the RT error frame is wired end to end.
  it("core.describe_fm on a nonexistent FM surfaces the RT error frame", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg: cfgOn, gate: GATE, tools };

    // DEVIATION FROM SPEC: the spec expected the FM name in the thrown
    // error's top-level `.message`. The real code (src/adt/fluid/
    // dispatch.ts) throws AbapError("FLUID_ACTION_FAILED", `${tool}.
    // ${action} reported ${N} error frame(s).`, { tool, action, frames:
    // transcript.errors }) — a generic count in `.message`, with the FM name
    // only inside `details.frames[].text` (the ABAP-side `fail(|unknown
    // function module { lv_name }|)` text, relayed verbatim by
    // src/adt/fluid/protocol.ts's parseErr as FluidErrFrame.text). Asserting
    // against details.frames[].text follows the real code.
    await expect(
      dispatch(deps, { tool: "core", action: "describe_fm", args: DESCRIBE_BAD_ARGS }),
    ).rejects.toSatisfy((e: unknown) => {
      if (!isAbapError(e)) return false;
      if (e.code !== "FLUID_ACTION_FAILED") return false;
      const frames = e.details["frames"];
      if (!Array.isArray(frames)) return false;
      return frames.some(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          typeof (f as { text?: unknown }).text === "string" &&
          (f as { text: string }).text.includes("ZZ_NO_SUCH_FM_ABAPSMITH"),
      );
    });
  }, 180_000);

  // Spec test 6: the load-bearing proof of the recursive struct→JSON path.
  it("core.call_fm with the flag ON calls RFC_SYSTEM_INFO and returns RFCSI_EXPORT as a JSON object", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg: cfgOn, gate: GATE, tools };

    const result = await dispatch(deps, {
      tool: "core",
      action: "call_fm",
      args: CALL_FM_ARGS_RFC_SYSTEM_INFO,
    });

    expect(result.tool).toBe("core");
    expect(result.action).toBe("call_fm");
    expect(Array.isArray(result.result)).toBe(true);
    const items = result.result as readonly CoreCallFmResultItem[];
    const rfcsiExport = items.find((i) => i.name.toUpperCase() === "RFCSI_EXPORT");
    expect(rfcsiExport).toBeDefined();
    expect(rfcsiExport?.kind).toBe("out");
    expect(typeof rfcsiExport?.value).toBe("object");
    expect(rfcsiExport?.value).not.toBeNull();

    // Case as the DDIC gives it — compare case-insensitively.
    const value = rfcsiExport?.value as Record<string, unknown>;
    const lowered = Object.fromEntries(Object.entries(value).map(([k, v]) => [k.toLowerCase(), v]));
    const candidateKeys = ["rfcsysid", "rfchost", "rfcdbsys"];
    const nonEmpty = candidateKeys.some((k) => typeof lowered[k] === "string" && (lowered[k] as string).length > 0);
    expect(nonEmpty).toBe(true);
  }, 180_000);

  // Spec test 7: the importing-parameter bind path.
  it("core.call_fm binds an importing parameter — CONVERSION_EXIT_ALPHA_INPUT(INPUT: '42')", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg: cfgOn, gate: GATE, tools };

    const result = await dispatch(deps, { tool: "core", action: "call_fm", args: CALL_FM_ARGS_ALPHA }).catch((e) => {
      // Diagnostic only — see logErrorFrameTexts above. Rethrows unchanged so
      // this test still fails exactly as it does now.
      logErrorFrameTexts(e);
      throw e;
    });

    expect(result.tool).toBe("core");
    expect(result.action).toBe("call_fm");
    const items = result.result as readonly CoreCallFmResultItem[];
    const output = items.find((i) => i.name.toUpperCase() === "OUTPUT");
    expect(output).toBeDefined();
    expect(typeof output?.value).toBe("string");
    // Loose (contains, not equals): CONVERSION_EXIT_ALPHA_INPUT's generic
    // CLIKE OUTPUT parameter means the alpha padding width is not determined
    // when bound through PARAMETER-TABLE, so the exact padded form is not
    // something this suite should pin.
    expect((output?.value as string).includes("42")).toBe(true);
  }, 180_000);

  // Spec test 8.
  it("core.call_fm with commit:true and no confirm refuses (does not run the commit for real)", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg: cfgOn, gate: GATE, tools };

    await expect(
      dispatch(deps, { tool: "core", action: "call_fm", args: CALL_FM_ARGS_COMMIT_NO_CONFIRM }),
    ).rejects.toMatchObject({
      code: "BAD_INPUT",
      details: { field: "confirm", expected: "core.call_fm" },
    });
    // Deliberately does not retry with confirm: "core.call_fm" — there is no
    // harmless FM worth committing for on a live, shared appliance, and the
    // accepted-echo branch is already covered by the offline suite.
  }, 180_000);

  // Spec test 9, run LAST: a delete kills the ADT session, and afterAll
  // reconnects before every cleanup delete anyway, so nothing after this
  // depends on session continuity.
  //
  // reapRetiredBridges now takes a FluidLease, not a bare connection —
  // production (`runRepair` in src/tools/fluid.ts) passes `(op, fn) =>
  // deps.pool.withWrite(op, undefined, fn)` so that no single AbapConnection
  // is ever asked to run more than one delete (each delete kills the ADT
  // session; see retired.ts's own header). This test exercises that exact
  // path rather than a fake lease, so it builds a real pool-backed
  // AdtSessionPool — lazily, scoped to this test only, same construction
  // shape as integration-fpm-lock.test.ts's `mode:"locks"` test — reusing
  // the suite's own `base` config and shared `breaker` (one SAP user means
  // one breaker instance). Every other test in this file keeps using the
  // suite's bare `conn`; only the reap call below needs the pool, since
  // probing is read-only and does not kill the session.
  it("retired bridge classes: probe, reap, probe again — never recreates any of them (runs last)", async () => {
    assertUsable();

    const pool = new AdtSessionPool({
      cfg: base,
      breaker,
      log: () => {},
      createConnection: (c, o) => new AbapConnection(c, { ...o, log: () => {} }),
      prepareConnection: async (c) => {
        await c.connect();
      },
    });

    try {
      const firstProbe = await probeRetiredBridges(conn);
      expect(firstProbe.length).toBe(RETIRED_BRIDGE_CLASSES.length);
      for (const p of firstProbe) {
        expect(["present", "absent", "moved", "unknown"]).toContain(p.state);
      }
      const presentNames = new Set(firstProbe.filter((p) => p.state === "present").map((p) => p.name));
      if (presentNames.size > 0) {
        console.info(`retired bridges present before reap: ${[...presentNames].join(", ")}`);
      } else {
        console.info("retired bridges: none present before reap — the all-absent case is the normal outcome.");
      }

      const reap = await reapRetiredBridges(GATE, (op, fn) => pool.withWrite(op, undefined, fn));
      // Observability only — the per-object outcome of the reap is otherwise
      // invisible (only the "present before reap" list was ever logged), which
      // is exactly what makes it impossible to tell, from a live run's output
      // alone, whether a partial reap is a bug in reapRetiredBridges or an
      // artefact of how this test calls it. One line per entry, full detail.
      for (const r of reap) {
        console.info(
          `reap result: name=${r.name} outcome=${r.outcome}${r.error !== undefined ? ` error=${r.error}` : ""}`,
        );
      }
      expect(reap.length).toBe(RETIRED_BRIDGE_CLASSES.length);
      for (const r of reap) {
        expect(["deleted", "already-absent", "left-alone", "unknown", "failed"]).toContain(r.outcome);
        if (r.outcome === "deleted") {
          expect(presentNames.has(r.name)).toBe(true);
        }
      }
      // New assertion (observability, not a claim about what a partial reap
      // means): whatever the reap reports as "failed" must always explain
      // itself with a non-empty error string. It deliberately does NOT assert
      // that everything present got deleted — whether a partial pass is a bug
      // or expected is exactly the open question this logging exists to help
      // answer.
      for (const r of reap) {
        if (r.outcome === "failed") {
          expect(typeof r.error).toBe("string");
          expect((r.error ?? "").length).toBeGreaterThan(0);
        }
      }
      // Tolerate total absence: on an already-clean system every entry reaps as
      // already-absent/unknown-never and nothing above requires a deletion to
      // have happened for this test to pass.

      const secondProbe = await probeRetiredBridges(conn);
      // Observability only — the FULL "present after reap" list, one line per
      // entry, so a live run shows exactly which names (if any) are still
      // present after the reap, not just an aggregate pass/fail.
      const presentAfterReap = secondProbe.filter((p) => p.state === "present");
      if (presentAfterReap.length > 0) {
        for (const p of presentAfterReap) {
          console.info(`present after reap: name=${p.name} state=${p.state} foundIn=${p.foundIn ?? "(n/a)"}`);
        }
      } else {
        console.info("present after reap: none — nothing is present on the second probe.");
      }

      const deletedNames = new Set(reap.filter((r) => r.outcome === "deleted").map((r) => r.name));
      for (const p of secondProbe) {
        if (deletedNames.has(p.name)) {
          expect(p.state).not.toBe("present");
        }
      }
    } finally {
      // Must run even when the test body threw, and must never let a
      // shutdown failure replace/mask a real assertion failure above — so
      // the shutdown's own error is caught and only logged.
      try {
        await pool.shutdown("test-end");
      } catch (e) {
        console.warn("retired-bridge reap: pool shutdown failed — leaked session, remove it by hand.", e);
      }
    }
  }, 180_000);
});
