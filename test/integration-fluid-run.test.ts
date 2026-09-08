/**
 * Live integration test for the fluid API's bridge package migration in
 * `src/adt/run.ts` / `src/adt/fluid/package.ts` — `BRIDGE_PACKAGE` is now
 * `FLUID_PACKAGE` (`$ABAPSMITH_FLUID_API`), not the legacy `$TMP`, and
 * `deployBridge` relocates a bridge it finds stranded in `$TMP` or
 * `$ZMCP_HELPERS` (delete-then-recreate — ABAP objects cannot change
 * package) whenever the class name starts `ZCL_ZMCP_`/`ZIF_ZMCP_`.
 *
 * The offline suites (test/fluid-bridge-package.test.ts, test/run.test.ts)
 * fake the transport and can only prove the choreography issues the right
 * HTTP verbs against the right URIs. They cannot prove SAP actually accepts
 * a class in `$ABAPSMITH_FLUID_API` (a package that itself has to be
 * created on first use) and runs it, nor that a real DELETE + re-CREATE
 * against a live repository leaves the object active in its new package.
 * This file proves both, live:
 *
 *  1. `runReport` against a non-interactive demo report on this A4H
 *     appliance (see `REPORT` below) produces real list output through a
 *     bridge that lives in `$ABAPSMITH_FLUID_API` — read back independently
 *     over ADT, not just trusted from `deployBridge`'s own return value.
 *  2. A bridge deliberately deployed into `$TMP` is picked up and relocated
 *     into `$ABAPSMITH_FLUID_API` the next time `deployBridge` runs for it —
 *     again confirmed by an independent read-back before and after.
 *
 * Concurrency note: another slice may be deploying the fluid package and a
 * runtime class onto the same appliance at the same time, so
 * `$ABAPSMITH_FLUID_API` already existing (and already containing other
 * bridges) is expected and must not fail this suite — `ensureFluidPackage`
 * is memoized/idempotent and `deployBridge` treats an existing bridge with
 * unchanged source as a no-op write.
 *
 * SAFETY: gated behind BOTH `ABAP_URL` and write access being configured
 * (`ABAP_MODE=edit`/`admin`, or legacy `ABAP_ALLOW_WRITE=true` — see
 * `test/helpers/live-write-gate.ts`). Test 1 writes the standard `abap_run`
 * report bridge for `REPORT`; test 2 writes/deletes exactly one throwaway
 * class, `ZCL_ZMCP_S5A_RELOC` — distinctively named so it cannot collide
 * with another slice's live run. `afterAll` deletes both throwaway classes,
 * each independently and best-effort, since a cleanup failure must not mask
 * a real one and must not be conflated with it either. Nothing outside
 * `$ABAPSMITH_FLUID_API` and `ZCL_ZMCP_*` in `$TMP` is touched;
 * `$ABAPSMITH_FLUID_API` itself is still never deleted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { authorizeMutation, deleteObject } from "../src/adt/write.js";
import { bridgeClassName, deployBridge, runReport } from "../src/adt/run.js";
import { isSessionDeadFailure } from "../src/adt/write-verify.js";
import { FLUID_PACKAGE } from "../src/adt/fluid/package.js";
import { parsePackageRef } from "../src/adt/package-ref.js";
import { liveSuiteSkipReason, skipForApplianceState } from "./live-appliance-state.js";

loadEnvFile(); // so a .env in the repo root enables the live suite
const notRun = liveSuiteSkipReason({ write: true });
const dw = notRun === undefined ? describe : describe.skip;
// A collection-time skip is counted but never says why; state the reason once, greppably.
if (notRun !== undefined) it("live fluid bridge package: suite not run", (ctx) => skipForApplianceState(ctx, notRun));

/**
 * DEMO_LIST_SYSTEM_FIELDS: a SABAPDEMOS demo present on this A4H appliance.
 * Its complete source has no selection screen, no ALV or GUI control, and no
 * `CALL SCREEN` — just a DO loop WRITEing ~100 lines — so `SUBMIT ... AND
 * RETURN EXPORTING LIST TO MEMORY` captures a real classic list; its
 * `AT LINE-SELECTION` blocks are interactive-only and never fire headlessly.
 * RSPARAM was tried first and short-dumped — "Sending of dynpro SAPMSSY0
 * 0120 not possible: No window system type specified", the documented
 * headless limitation (doc/TOOLS/execute-and-test.md: report mode "cannot
 * render interactive lists or ALV grids") — and the dump destroyed the ABAP
 * session too, cascading a SESSION_DEAD into the second test. Verify any
 * replacement report is non-interactive before swapping it in here.
 */
const REPORT = "DEMO_LIST_SYSTEM_FIELDS";

const RELOC_CLASS = "ZCL_ZMCP_S5A_RELOC";

/** A minimal, valid `IF_OO_ADT_CLASSRUN` body — content is irrelevant, only its package matters here. */
const relocSource = `CLASS ${RELOC_CLASS.toLowerCase()} DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
ENDCLASS.

CLASS ${RELOC_CLASS.toLowerCase()} IMPLEMENTATION.
  METHOD if_oo_adt_classrun~main.
  ENDMETHOD.
ENDCLASS.
`;

dw("live A4H fluid bridge package (write path, $ABAPSMITH_FLUID_API + $TMP)", () => {
  let conn: AbapConnection;
  // allowNamePrefixes: ["*"] — FLUID_PACKAGE starts with "$", not "Z"/"Y", and
  // ensureFluidPackage gates its DEVC/K create by that name; matches what the
  // server runs with under ABAP_MODE=edit (src/mode.ts EDIT_NAME_PREFIX_DEFAULT).
  const GATE = new SafetyGate({
    readOnly: false,
    allowPackages: ["$TMP", FLUID_PACKAGE],
    allowNamePrefixes: ["*"],
  });
  const breaker = new AuthCircuitBreaker();

  const assertUsable = () => {
    if (conn.breaker.isTripped) {
      throw new Error(`circuit breaker tripped: ${conn.breaker.info?.message}`);
    }
  };

  /** Independent read-back: whatever `deployBridge`/`runReport` claims, ask the server directly. */
  const readClassPackage = async (className: string): Promise<string | undefined> => {
    const r = await conn.get(`/sap/bc/adt/oo/classes/${className.toLowerCase()}`, {
      headers: { Accept: "application/*" },
    });
    return parsePackageRef(r.body)?.toUpperCase();
  };

  beforeAll(async () => {
    const base = loadConfig();
    conn = new AbapConnection(
      { ...base, readOnly: false, allowPackages: ["$TMP", FLUID_PACKAGE] },
      { log: () => {}, breaker },
    );
    await conn.connect();
  }, 60_000);

  afterAll(async () => {
    // Best-effort: delete both throwaway bridge classes this suite creates —
    // the report bridge for REPORT, and RELOC_CLASS from wherever it ended
    // up (fluid package on the happy path, $TMP if the relocation itself
    // never ran). Each deletion runs independently so one failing doesn't
    // skip the other, and neither throws — a cleanup failure must not mask
    // a real one, and must not be conflated with it either. Deleting a class
    // tears down the ABAP session server-side (see the relocation comment
    // above), so the first cleanup's delete routinely kills the session the
    // second cleanup starts on; one reconnect-and-retry, same idiom as
    // `probeObjectPresence`/`authorizeBridgeTarget`, clears it.
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
    await cleanup(bridgeClassName(REPORT));
    await cleanup(RELOC_CLASS);
    await conn?.shutdown("test-end");
  }, 90_000);

  it("a report runs through a bridge that lives in the fluid package", async () => {
    assertUsable();
    const result = await runReport(conn, REPORT, GATE);

    expect(result.mode).toBe("report");
    expect(result.lines).toBeGreaterThan(0);
    expect(result.output.trim().length).toBeGreaterThan(0);
    // REPORT is longer than the 30-char ABAP limit, so this also exercises bridgeClassName's hashed-name branch.
    expect(result.bridgeClass).toBe(bridgeClassName(REPORT));
    expect(result.bridgeActivationVerified).toBe(true);

    const pkg = await readClassPackage(result.bridgeClass!);
    expect(pkg).toBe(FLUID_PACKAGE);
  }, 120_000);

  it("a bridge stranded in $TMP is relocated into the fluid package on next use", async () => {
    assertUsable();

    // 1. Deliberately deploy the bridge into $TMP, the legacy location.
    await deployBridge(conn, GATE, {
      className: RELOC_CLASS,
      source: relocSource,
      description: "S5a live relocation probe",
      packageName: "$TMP",
      what: "Activation of the relocation probe bridge",
      verify: () => true,
    });

    // 2. Confirm it really is in $TMP — the precondition, not an assumption.
    const before = await readClassPackage(RELOC_CLASS);
    expect(before).toBe("$TMP");

    // 3. Deploy again with no packageName — defaults to the fluid package,
    // which triggers the relocate-in-place (delete from $TMP, recreate here).
    // This step is also the only coverage anywhere for post-delete session
    // revival: relocation's DELETE kills the ABAP session server-side, so
    // the recreate here only works because authorizeBridgeTarget reconnects
    // once and re-issues after the session dies — no offline fake surfaces
    // this. Broken, it fails SESSION_DEAD / 400 Session Timed Out (ICMENOSESSION).
    await deployBridge(conn, GATE, {
      className: RELOC_CLASS,
      source: relocSource,
      description: "S5a live relocation probe",
      what: "Activation of the relocation probe bridge",
      verify: () => true,
    });

    // 4. Confirm the relocation actually happened.
    const after = await readClassPackage(RELOC_CLASS);
    expect(after).toBe(FLUID_PACKAGE);
  }, 180_000);
});
