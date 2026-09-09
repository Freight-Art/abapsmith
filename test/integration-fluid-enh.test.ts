/**
 * Live integration test for the built-in `enh` fluid tool
 * (`src/adt/fluid/builtin/enh.ts`, entry class `ZCL_ZMCP_FLUID_ENH`) — the
 * classic BAdI-enhancement operations ported from `enhancement-bridge.ts`/
 * `enhancement-templates.ts` onto one static, JSON-driven body class.
 *
 * WHAT IS EXERCISED LIVE, AND WHY. Unlike `ui`/`fpm` (all-read-only) or
 * `classic` (one safe create/delete round trip), every portable `enh`
 * action is a MUTATION — there is no read-only action to fall back on. So
 * this suite creates and deletes a real enhancement spot, on the theory
 * that only a live create/read-back/delete proves the ABAP choreography
 * (`cl_enh_factory`, `save`/`activate`/`unlock`) actually works and that the
 * error arm genuinely reports failure:
 *
 *  1. `create_spot` — dispatched to create ONE new BAdI enhancement spot,
 *     asserted to succeed and schema-valid, then read back independently
 *     over ADT (`readEnhancementSpot`, not trusted from dispatch's own
 *     return) to prove it is really there and really active.
 *  2. `add_badi_def` — dispatched against the very spot `create_spot` just
 *     created, adding a BAdI definition bound to a marker interface this
 *     suite creates first (see below). Asserted to succeed and
 *     schema-valid, then read back independently: the spot's
 *     `badiDefinitions` really carries the new definition, bound to the
 *     right interface, with `singleUse` round-tripped correctly. This
 *     exercises a second action and proves the JSON scanner reads more
 *     than one input field.
 *  3. `add_filter_def` — dispatched against the very BAdI definition
 *     `add_badi_def` just added, attaching one filter declaration to it.
 *     The ABAP body re-derives the definition first (`get_badi_def` /
 *     `delete_badi_def` / `add_badi_def` with the filter appended), so the
 *     independent read-back below also re-confirms the definition's own
 *     fields (interface binding, `singleUse`) survived that round trip
 *     untouched, not just that the filter landed. No new object is created —
 *     this attaches to the same spot `create_spot`/`add_badi_def` already
 *     made and `afterAll` already deletes, so it needs no cleanup of its
 *     own beyond the extra invoker class (see below).
 *  4. An HONEST FAILURE PATH — `add_badi_def` against a spot name that was
 *     never created — asserted to reject with `FLUID_ACTION_FAILED`. This
 *     is the assertion that matters most: a CATCH arm that forgets
 *     `zcl_zmcp_fluid_rt=>err` reads as success at the ABAP layer, and only
 *     a live run catches that.
 *
 * NOT exercised live: `create_impl` and `set_filter_values`. Both need
 * objects (an implementing class for `create_impl`'s `impl_class`, and a
 * pre-existing implementation for `set_filter_values` to mutate) that this
 * suite would then also have to clean up reliably on a SHARED appliance —
 * `create_impl`'s reported `filter_check` and `set_filter_values`'
 * replace-in-place semantics are exactly the kind of interaction another
 * concurrent slice's live run could leave in a state this suite cannot
 * safely unwind. Leaving them out is the honest choice; inventing a
 * throwaway implementing class here would be residue on a system other
 * suites depend on.
 *
 * Also NOT exercised live, deliberately and permanently, not a gap: the
 * legacy (non-fluid) `abap_enh` operation `exercise`. It stays on its own
 * generated `ZCL_ZMCP_ENH_EXEC` classrun bridge — `builtin/enh.ts`'s own
 * comment explains why it cannot move onto this static fluid body (it needs
 * a compile-time `DATA lo_badi TYPE REF TO <badi_name>` built from a runtime
 * string, which is dynamic dispatch and forbidden by `reviewFluidAbap`).
 * There is nothing here to pin: `exercise` never reaches `dispatch()` at
 * all, so it is out of scope for a *fluid* integration suite by
 * construction, not by oversight.
 *
 * PACKAGE PLACEMENT — READ THIS BEFORE CHANGING THE ASSERTIONS BELOW.
 * `package_name` and `corr_nr` are now REQUIRED (not optional) on every
 * mutating action's input schema, matching `classic.ts`'s convention
 * exactly — a declared `targets.transport` pointer was never actually
 * optional in practice, since dispatch's own gate throws BAD_INPUT the
 * moment a caller omits it. The `enh` body class's ABAP source (`ENH_SOURCE`
 * in `builtin/enh.ts`) declares `DATA: lv_pkg TYPE devclass` with no `$TMP`
 * fallback value, and reads `package_name` directly into it before passing
 * it as the `CHANGING devclass` parameter to every `cl_enh_factory`
 * create/save call. This suite explicitly passes `package_name: FLUID_PACKAGE`
 * (and `corr_nr: ""`, since `FLUID_PACKAGE` is `$`-prefixed/local — see
 * classic.ts's own "Empty string for a $ (local) package" convention) on
 * every mutating call it makes, so every enhancement spot/definition it
 * creates lands in `$ABAPSMITH_FLUID_API` — the live appliance is shared,
 * and this run is only permitted to write into `$ABAPSMITH_FLUID_API`. The
 * independent read-back below asserts that REAL package, because asserting
 * the wrong thing would defeat the entire point of a live suite.
 *
 * `add_badi_def` requires a pre-existing marker interface (`INTERFACES
 * if_badi_interface`) — `enh.ts`'s own manifest says so ("Assumes the
 * marker interface... already exists... callers must create it first").
 * This suite creates ONE throwaway interface for that purpose directly
 * (outside `enh`'s own body class, since nothing in `enh`'s action set
 * creates interfaces) into `$ABAPSMITH_FLUID_API`, same as every object the
 * `enh` actions themselves create via `package_name: FLUID_PACKAGE`.
 *
 * SAFETY: gated behind BOTH `ABAP_URL` and write access being configured
 * (`ABAP_MODE=edit`/`admin`, or legacy `ABAP_ALLOW_WRITE=true` — see
 * `test/helpers/live-write-gate.ts`). `afterAll` deletes, best-effort, each
 * on its OWN fresh `AbapConnection` so one failure never blocks the rest:
 * the enhancement spot (`deleteEnhancementObject`, type `ENHS/XS`), the
 * marker interface (`deleteObject`, type `INTF/OI`), every invoker class
 * this suite can compute the name for, and finally the tool's own entry
 * class `ZCL_ZMCP_FLUID_ENH` — same idiom as
 * `test/integration-fluid-ui.test.ts`'s `deleteOnce`/`deleteIfPresent`.
 * Neither `$ABAPSMITH_FLUID_API` nor `ZCL_ZMCP_FLUID_RT` is ever deleted
 * here — other slices depend on both being present on the appliance. A
 * failed cleanup step is `console.warn`ed with enough detail for a human to
 * remove the object by hand.
 *
 * Concurrency note: another slice may be deploying its own fluid tool onto
 * the same appliance at the same time, so `$ABAPSMITH_FLUID_API` already
 * existing (and already holding other tools' objects) is expected — no
 * assertion here may require it to be empty. The spot/interface names below
 * carry a run-unique suffix so concurrent live runs cannot collide.
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
import { enhManifest, enhSources } from "../src/adt/fluid/builtin/enh.js";
import { authorizeMutation, deleteObject, writeObject, NO_JOURNAL } from "../src/adt/write.js";
import { activateObject, assertNoErrors } from "../src/adt/activate.js";
import { deleteEnhancementObject } from "../src/adt/enhancement-write.js";
import { readEnhancementSpot } from "../src/adt/enhancement.js";
import { parsePackageRef } from "../src/adt/package-ref.js";
import { forgetManifest } from "../src/adt/fluid/registry.js";
import { systemKey } from "../src/journal.js";
import { liveSuiteSkipReason, skipForApplianceState } from "./live-appliance-state.js";

loadEnvFile(); // so a .env in the repo root enables the live suite
const notRun = liveSuiteSkipReason({ write: true });
const dw = notRun === undefined ? describe : describe.skip;
// A collection-time skip is counted but never says why; state the reason once, greppably.
if (notRun !== undefined) it("live enh fluid tool: suite not run", (ctx) => skipForApplianceState(ctx, notRun));

const ENH_TOOL_ID = "enh";
const ENH_BODY_CLASS = "ZCL_ZMCP_FLUID_ENH";

// Run-unique suffix so concurrent live runs (another CI shard, another
// developer) never collide on spot/interface/badi names.
const randomSuffix = Math.random().toString(36).slice(2, 8).toUpperCase();
const SPOT_NAME = `ZMCP_ENH_${randomSuffix}`;
// Never created — used only for the honest-failure assertion below.
const NONEXISTENT_SPOT = `ZMCP_ENH_NOPE_${randomSuffix}`;
const BADI_NAME = `ZMCP_BADI_${randomSuffix}`;
const IFACE_NAME = `ZIF_MCP_ENH_${randomSuffix}`;
const FILTER_NAME = `ZMCP_FLT_${randomSuffix}`;
const FILTER_TEXT = "abapsmith S12 live filter def";

// package_name: FLUID_PACKAGE on every mutating call below — the live
// appliance is shared, and this run is only permitted to write into
// $ABAPSMITH_FLUID_API (see this file's header comment). corr_nr: "" —
// package_name and corr_nr are now REQUIRED on every mutating action's
// input schema, and FLUID_PACKAGE is "$"-prefixed (local, transport-free),
// so an empty string is the correct value per classic.ts's own "empty
// string for a $ (local) package" convention.
const CREATE_SPOT_ARGS = {
  spot_name: SPOT_NAME,
  description: "abapsmith S5b live enh test spot",
  package_name: FLUID_PACKAGE,
  corr_nr: "",
};
const ADD_BADI_DEF_ARGS = {
  spot_name: SPOT_NAME,
  badi_name: BADI_NAME,
  interface_name: IFACE_NAME,
  single_use: true,
  short_text: "abapsmith S5b live BAdI def",
  package_name: FLUID_PACKAGE,
  corr_nr: "",
};
const ADD_FILTER_DEF_ARGS = {
  spot_name: SPOT_NAME,
  badi_name: BADI_NAME,
  filter_name: FILTER_NAME,
  filter_type: "C",
  filter_text: FILTER_TEXT,
  package_name: FLUID_PACKAGE,
  corr_nr: "",
};
// spot_name deliberately names a spot this suite never creates: the GET
// inside add_badi_def's ABAP body must miss and be reported as a genuine
// failure, not silently as success.
const BAD_ADD_BADI_DEF_ARGS = {
  spot_name: NONEXISTENT_SPOT,
  badi_name: BADI_NAME,
  interface_name: IFACE_NAME,
  single_use: true,
  short_text: "should fail: spot does not exist",
  package_name: FLUID_PACKAGE,
  corr_nr: "",
};

const IFACE_SOURCE = `INTERFACE ${IFACE_NAME.toLowerCase()} PUBLIC.\n  INTERFACES if_badi_interface.\nENDINTERFACE.\n`;

dw("live A4H enh fluid tool ($ABAPSMITH_FLUID_API, BAdI enhancement spot/implementation operations)", () => {
  let conn: AbapConnection;
  let cfg: Config;
  const breaker = new AuthCircuitBreaker();

  // allowNamePrefixes: ["*"] — FLUID_PACKAGE starts with "$", not "Z"/"Y", same
  // reasoning as test/integration-fluid-img.test.ts's GATE. Every mutating
  // action below now explicitly targets FLUID_PACKAGE (see header comment),
  // so $TMP does not need to be (and is not) in the allowlist: this run is
  // only permitted to write into $ABAPSMITH_FLUID_API.
  const GATE = new SafetyGate({
    readOnly: false,
    allowPackages: [FLUID_PACKAGE],
    allowNamePrefixes: ["*"],
  });

  const enhTool: LoadedFluidTool = {
    manifest: enhManifest,
    origin: "builtin" as const,
    sources: enhSources,
    version: manifestVersion(enhManifest, enhSources),
  };
  const tools: ReadonlyMap<string, LoadedFluidTool> = new Map([[ENH_TOOL_ID, enhTool]]);

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
    cfg = { ...loadConfig(), readOnly: false, allowPackages: [FLUID_PACKAGE] };
    conn = new AbapConnection(cfg, { log: () => {}, breaker });
    await conn.connect();
    // Drop any stale registry entry left by a previous run's afterAll (e.g. a
    // crash before cleanup, or an older suite version that didn't forget the
    // manifest). Without this, ensureFluidTool's on-disk short-circuit would
    // report ZCL_ZMCP_FLUID_ENH as already "present" and skip deploying it,
    // even though this suite's own afterAll deletes that class every run.
    await forgetManifest(cfg, systemKey(conn.cfg), ENH_TOOL_ID);
  }, 60_000);

  afterAll(async () => {
    // Best-effort: delete everything this suite can have created — each on
    // its own fresh AbapConnection (deleting a class or an enhancement
    // object can tear the ABAP session down server-side, so reusing one
    // connection across deletes is not safe), each independently guarded so
    // one failure never blocks the rest — same idiom as
    // test/integration-fluid-ui.test.ts's deleteOnce/deleteIfPresent.
    const freshConn = () => new AbapConnection(cfg, { log: () => {}, breaker: new AuthCircuitBreaker() });

    const deleteClassOnce = async (name: string): Promise<void> => {
      const c = freshConn();
      await c.connect();
      try {
        const authorized = await authorizeMutation(c, GATE, "delete", { type: "CLAS/OC", name });
        await deleteObject(c, authorized);
      } finally {
        await c.shutdown("test-end");
      }
    };
    const deleteClassIfPresent = async (name: string): Promise<void> => {
      try {
        try {
          await deleteClassOnce(name);
        } catch (e) {
          if (isAbapError(e) && e.code === "SESSION_DEAD") {
            await deleteClassOnce(name);
          } else {
            throw e;
          }
        }
      } catch (e) {
        console.warn(`afterAll: failed to clean up class ${name} — remove it by hand.`, e);
      }
    };

    // The suite-level GATE deliberately grants only what the tests exercise;
    // deleting an enhancement spot needs two things GATE doesn't grant.
    // (1) Enhancement authoring (`allowEnhancements`) plus
    // `enhanceTargets: "customer"`: the spot's own `affects` target
    // (FLUID_PACKAGE = $ABAPSMITH_FLUID_API) is a local, non-SAP-namespace,
    // non-SAP-package object, so `SafetyGate`'s ownership resolution
    // (src/safety.ts, enhancementRules step 6) classifies it "customer" and
    // grants outright — `enhanceTargetPackages` is consulted only on the
    // "sap" branch (step 7), so it is not needed and is left unset.
    // (`allowEnhancementDelete` is a `DeleteEnhancementObjectOptions` field
    // passed directly to `deleteEnhancementObject` below, not a
    // `SafetyConfig`/`SafetyGate` field, so it does not belong in this
    // literal.) (2) `sid`: enhancementRules' origin ceiling (step 3, judged
    // by `isLocalOrigin`) refuses an artefact whose `masterSystem` (here the
    // live system's own SID, e.g. A4H) doesn't match `cfg.sid` or
    // `originSystems` — a bare literal has no `sid` at all, so it reads as
    // "SID not configured" and every real spot gets refused as a foreign
    // repair. Spreading the suite's loaded `cfg` (assigned in beforeAll, so
    // available here in afterAll) carries the real connection's `sid` and
    // rest of its identity, same as `src/server.ts`'s cfg -> SafetyConfig
    // mapping; the explicit fields below override it exactly as GATE does.
    const CLEANUP_GATE = new SafetyGate({
      ...cfg,
      readOnly: false,
      allowPackages: [FLUID_PACKAGE],
      allowNamePrefixes: ["*"],
      allowEnhancements: true,
      enhanceTargets: "customer",
    });

    const deleteSpotOnce = async (): Promise<void> => {
      const c = freshConn();
      await c.connect();
      try {
        await deleteEnhancementObject(
          c,
          CLEANUP_GATE,
          { type: "ENHS/XS", name: SPOT_NAME },
          {
            // packageName: FLUID_PACKAGE matches the header comment above —
            // create_spot's ABAP body now lands it in $ABAPSMITH_FLUID_API
            // because CREATE_SPOT_ARGS explicitly passes package_name.
            affects: { name: SPOT_NAME, packageName: FLUID_PACKAGE, spotName: SPOT_NAME },
            allowEnhancementDelete: true,
            onBeforeImage: async () => {},
          },
        );
      } finally {
        await c.shutdown("test-end");
      }
    };
    const deleteSpotIfPresent = async (): Promise<void> => {
      try {
        await deleteSpotOnce();
      } catch (e) {
        console.warn(
          `afterAll: failed to clean up enhancement spot ${SPOT_NAME} (package ${FLUID_PACKAGE}) — remove it by hand.`,
          e,
        );
      }
    };

    const deleteInterfaceOnce = async (): Promise<void> => {
      const c = freshConn();
      await c.connect();
      try {
        const authorized = await authorizeMutation(c, GATE, "delete", { type: "INTF/OI", name: IFACE_NAME });
        await deleteObject(c, authorized);
      } finally {
        await c.shutdown("test-end");
      }
    };
    const deleteInterfaceIfPresent = async (): Promise<void> => {
      try {
        await deleteInterfaceOnce();
      } catch (e) {
        console.warn(`afterAll: failed to clean up interface ${IFACE_NAME} (package ${FLUID_PACKAGE}) — remove it by hand.`, e);
      }
    };

    // Order: the spot first (it references the badi definition bound to the
    // interface), then the interface, then generated invokers, then the
    // entry class last.
    await deleteSpotIfPresent();
    await deleteInterfaceIfPresent();

    const invokerNames = [
      invokerName(ENH_TOOL_ID, "create_spot", CREATE_SPOT_ARGS, enhManifest.contract),
      invokerName(ENH_TOOL_ID, "add_badi_def", ADD_BADI_DEF_ARGS, enhManifest.contract),
      invokerName(ENH_TOOL_ID, "add_filter_def", ADD_FILTER_DEF_ARGS, enhManifest.contract),
      invokerName(ENH_TOOL_ID, "add_badi_def", BAD_ADD_BADI_DEF_ARGS, enhManifest.contract),
    ];
    for (const name of invokerNames) await deleteClassIfPresent(name);
    await deleteClassIfPresent(ENH_BODY_CLASS);

    // Drop the registry entry now that ZCL_ZMCP_FLUID_ENH is actually gone
    // from the appliance: leaving it behind would make the NEXT run's
    // ensureFluidTool trust the stale "present" entry and skip redeploying a
    // class that no longer exists, producing "Type ... is unknown" failures.
    // Best-effort and wrapped so a failure here never masks a real test
    // failure from the block above.
    try {
      await forgetManifest(cfg, systemKey(conn.cfg), ENH_TOOL_ID);
    } catch (e) {
      console.warn(`afterAll: failed to forget registry entry for ${ENH_TOOL_ID} — remove it by hand.`, e);
    }

    await conn?.shutdown("test-end");
  }, 180_000);

  it("deploys the enh body through ensure/dispatch and it is really active in the fluid package", async () => {
    assertUsable();
    const result = await ensureFluidTool(conn, GATE, cfg, enhTool, {
      tool: ENH_TOOL_ID,
      action: "create_spot",
      op: "run",
    });

    expect(result.objects.map((o) => o.state)).toEqual(["present", "present"]);

    const pkg = await readClassPackage(ENH_BODY_CLASS);
    expect(pkg).toBe(FLUID_PACKAGE);
    expect(await readClassIsActive(ENH_BODY_CLASS)).toBe(true);
  }, 120_000);

  it("creates a throwaway marker interface directly (INTF/OI, INTERFACES if_badi_interface) in $ABAPSMITH_FLUID_API for add_badi_def to bind to", async () => {
    assertUsable();
    const authorized = await authorizeMutation(conn, GATE, "write", {
      type: "INTF/OI",
      name: IFACE_NAME,
      packageName: FLUID_PACKAGE,
      description: "abapsmith S5b live enh test marker interface",
    });
    const write = await writeObject(conn, authorized, { source: IFACE_SOURCE, onBeforeImage: NO_JOURNAL });
    const activation = await activateObject(conn, write.target);
    assertNoErrors(activation, { what: `activate marker interface ${IFACE_NAME}`, name: IFACE_NAME });

    // The class-specific endpoint 404s for an interface, so read the package via the interfaces endpoint instead.
    const r = await conn.get(`/sap/bc/adt/oo/interfaces/${IFACE_NAME.toLowerCase()}`, {
      headers: { Accept: "application/*" },
    });
    expect(parsePackageRef(r.body)?.toUpperCase()).toBe(FLUID_PACKAGE);
  }, 120_000);

  it("enh.create_spot creates a new BAdI enhancement spot: dispatch succeeds, output is schema-valid, and an independent ADT read-back confirms it is really there and active", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg, gate: GATE, tools };

    const result = await dispatch(deps, { tool: ENH_TOOL_ID, action: "create_spot", args: CREATE_SPOT_ARGS });

    expect(result.tool).toBe(ENH_TOOL_ID);
    expect(result.action).toBe("create_spot");
    const out = result.result as { created: boolean };
    expect(out.created).toBe(true);

    const spec = enhManifest.actions.find((a) => a.name === "create_spot");
    expect(spec).toBeDefined();
    expect(validateAgainstSchema(out, spec!.output, "result")).toEqual([]);

    // Independent read-back — never trust dispatch's own success report.
    // readEnhancementSpot returns an EnhancementSpotDocument ({ xml, data,
    // etag? }) — the parsed fields live under .data, not on the document
    // itself.
    const spot = await readEnhancementSpot(conn, SPOT_NAME);
    expect(spot.data.name.toUpperCase()).toBe(SPOT_NAME);
    // See this file's header comment: CREATE_SPOT_ARGS passes
    // package_name: FLUID_PACKAGE, so this — not $TMP — is where the spot
    // really lands. Asserting the real value, not the assumed one.
    expect(spot.data.packageRef?.name?.toUpperCase()).toBe(FLUID_PACKAGE);
    expect(spot.data.activationStatus).toBe("active");
  }, 120_000);

  it("enh.add_badi_def adds a BAdI definition to the spot just created: dispatch succeeds, output is schema-valid, and an independent read-back shows the definition bound to the right interface", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg, gate: GATE, tools };

    const result = await dispatch(deps, { tool: ENH_TOOL_ID, action: "add_badi_def", args: ADD_BADI_DEF_ARGS });

    expect(result.tool).toBe(ENH_TOOL_ID);
    expect(result.action).toBe("add_badi_def");
    const out = result.result as { added: boolean };
    expect(out.added).toBe(true);

    const spec = enhManifest.actions.find((a) => a.name === "add_badi_def");
    expect(spec).toBeDefined();
    expect(validateAgainstSchema(out, spec!.output, "result")).toEqual([]);

    // Independent read-back — never trust dispatch's own success report.
    // readEnhancementSpot returns an EnhancementSpotDocument ({ xml, data,
    // etag? }) — the parsed fields live under .data, not on the document
    // itself.
    const spot = await readEnhancementSpot(conn, SPOT_NAME);
    const def = spot.data.badiDefinitions.find((d) => d.name.toUpperCase() === BADI_NAME);
    expect(def).toBeDefined();
    expect(def!.interfaceRef?.name?.toUpperCase()).toBe(IFACE_NAME);
    expect(def!.singleUse).toBe(true);
  }, 120_000);

  it("enh.add_filter_def adds a filter declaration to the BAdI def just added: dispatch succeeds, output is schema-valid, and an independent read-back shows the filter bound to the right definition", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg, gate: GATE, tools };

    const result = await dispatch(deps, { tool: ENH_TOOL_ID, action: "add_filter_def", args: ADD_FILTER_DEF_ARGS });

    expect(result.tool).toBe(ENH_TOOL_ID);
    expect(result.action).toBe("add_filter_def");
    const out = result.result as { added: boolean };
    expect(out.added).toBe(true);

    const spec = enhManifest.actions.find((a) => a.name === "add_filter_def");
    expect(spec).toBeDefined();
    expect(validateAgainstSchema(out, spec!.output, "result")).toEqual([]);

    // Independent read-back — never trust dispatch's own success report. The
    // ABAP body deletes then re-adds the whole BAdI def entry to attach the
    // filter (get_badi_def / delete_badi_def / add_badi_def), so this also
    // re-confirms the definition's own fields survived that round trip, not
    // just that the filter landed.
    const spot = await readEnhancementSpot(conn, SPOT_NAME);
    const def = spot.data.badiDefinitions.find((d) => d.name.toUpperCase() === BADI_NAME);
    expect(def).toBeDefined();
    expect(def!.interfaceRef?.name?.toUpperCase()).toBe(IFACE_NAME);
    expect(def!.singleUse).toBe(true);
    const filter = def!.filters.find((f) => f.filterName?.toUpperCase() === FILTER_NAME);
    expect(filter).toBeDefined();
    expect(filter!.filterType).toBe("C");
    expect(filter!.shorttext).toBe(FILTER_TEXT);
  }, 120_000);

  it("enh.add_badi_def against a spot name that was never created is reported as a genuine failure, not silently as success", async () => {
    assertUsable();
    const deps: FluidDeps = { conn, cfg, gate: GATE, tools };

    await expect(
      dispatch(deps, { tool: ENH_TOOL_ID, action: "add_badi_def", args: BAD_ADD_BADI_DEF_ARGS }),
    ).rejects.toMatchObject({ code: "FLUID_ACTION_FAILED" });
  }, 120_000);
});
