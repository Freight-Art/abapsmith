/**
 * Live integration test for `src/adt/fpm-lock.ts` — the FPM/FBI
 * config-lock protocol (component/application `WDY_CONFIG_*` enqueue
 * discipline), built against the wire ground truth captured for this module.
 *
 * *** THIS FILE IS THE ONLY PLACE WHERE THE LOCK PROTOCOL IS PROVED AGAINST
 * THE REAL SAP ENQUEUE SERVER. *** The offline unit tests for `fpm-lock.ts`
 * assert against fakes/fixtures and CANNOT prove wire behaviour — in
 * particular they cannot prove that a `DEQUEUE_*` call actually released a
 * lock (its `subrc` is contractually worthless — always `0`, even for a
 * no-op). Test 3 proves the first of those, live, by
 * re-reading `SEQG3` through `ENQUEUE_READ` after the fact. Test 4 does
 * NOT prove that locks generally die at HTTP-request end — that claim was
 * audited and found FALSE: a capture showed 26
 * `E_ABAP_GENPH` locks still held 15-28 minutes after their requests ended.
 * Test 4 is a single observation
 * about one `E_WDY_CONFCOMP` lock, not a lifetime guarantee.
 *
 * SAFETY: gated behind BOTH `ABAP_URL` and write access being configured
 * (`ABAP_MODE=edit`/`admin`, or legacy `ABAP_ALLOW_WRITE=true` — see
 * `test/helpers/live-write-gate.ts`) —
 * this suite takes real `ENQUEUE_E_WDY_CONFCOMP` locks and writes throwaway
 * bridge classes: most into `$TMP`, plus — via the real `runFpmReadTool`
 * path the `mode:"locks"` test drives — some into `FLUID_PACKAGE`. Every
 * artefact this file creates is `ZMCP_`-prefixed; every test releases what
 * it took in a `try/finally`, and `afterAll` runs one more best-effort
 * sweep for any `ZMCP_LK_LIVE*` lock row left behind by an aborted run.
 * Never touch an object this suite did not create.
 *
 * Tests 2 and 4 deliberately reproduce broken/edge-case enqueue shapes
 * (a wildcard landmine, and an intentionally un-released lock).
 * `fpm-lock.ts`'s pinned public API refuses to generate those shapes on
 * purpose (it always passes every X_CONFIG_* flag), so those two tests hand-
 * write the small ABAP classes themselves.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AbapConnection } from "../src/adt/connection.js";
import { AdtSessionPool, type SessionPool } from "../src/adt/pool.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { runFpmReadTool, type FpmToolDeps } from "../src/tools/fpm.js";
import { loadConfig, loadEnvFile } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { authorizeMutation, writeObject } from "../src/adt/write.js";
import { activateObject, assertNoErrors } from "../src/adt/activate.js";
import { runClass } from "../src/adt/run.js";
import { liveSuiteSkipReason, skipForApplianceState } from "./live-appliance-state.js";
import {
  hasWildcardFill,
  parseGarg,
  FPM_LOCK_SCOPE,
} from "../src/adt/fpm-lock.js";
import { FLUID_PACKAGE } from "../src/adt/fluid/package.js";

loadEnvFile(); // so a .env in the repo root enables the live suite
const notRun = liveSuiteSkipReason({ write: true });
const dw = notRun === undefined ? describe : describe.skip;
// A collection-time skip is counted but never says why; state the reason once, greppably.
if (notRun !== undefined) it("live A4H fpm-lock protocol: suite not run", (ctx) => skipForApplianceState(ctx, notRun));

dw("live A4H fpm-lock protocol (write path, $TMP + the fluid package)", () => {
  let conn: AbapConnection;
  const GATE = new SafetyGate({ readOnly: false, allowPackages: ["$TMP", FLUID_PACKAGE] });
  const breaker = new AuthCircuitBreaker();
  /**
   * Built lazily and ONLY for the `mode:"locks"` test, which is the one case
   * that needs a second, independent SAP session (it inspects a lock while
   * another session holds it). Everything else runs on `conn`, so the default
   * path still costs exactly one logon.
   */
  let pool: SessionPool | undefined;

  const assertUsable = () => {
    if (conn.breaker.isTripped) {
      throw new Error(`circuit breaker tripped: ${conn.breaker.info?.message}`);
    }
  };

  beforeAll(async () => {
    const base = loadConfig();
    conn = new AbapConnection(
      { ...base, readOnly: false, allowPackages: ["$TMP"] },
      { log: () => {}, breaker },
    );
    await conn.connect();
  }, 60_000);

  afterAll(async () => {
    await bestEffortSweep("afterAll");
    await pool?.shutdown("test-end");
    await conn?.shutdown("test-end");
  });

  // ---------------------------------------------------------------------
  // Shared plumbing: write + activate + run a $TMP bridge class and hand
  // back its raw classrun console output. Mirrors runFpmRead's own
  // write/activate/execute sequence in src/adt/fpm-runtime.ts (which this
  // module deliberately does not import — fpm-lock.ts is self-contained,
  // and so is this test).
  // ---------------------------------------------------------------------
  /**
   * Write + activate a $TMP bridge class and return the name it is safe to
   * execute under. Split out of `runBridge` so that the contention test can
   * PREPARE a class on this session and then EXECUTE it on a second one:
   * write/activate is slow and would otherwise have to happen inside the
   * narrow window during which another session is holding the lock.
   */
  async function prepareBridge(
    className: string,
    source: string,
    description: string,
  ): Promise<string> {
    const authorized = await authorizeMutation(conn, GATE, "write", {
      type: "CLAS/OC",
      name: className,
      packageName: "$TMP",
      description,
    });
    const write = await writeObject(conn, authorized, { source });
    GATE.assert("activate", {
      name: authorized.target.name,
      packageName: authorized.target.packageName,
      type: authorized.target.type,
    });
    const activation = await activateObject(conn, write.target);
    assertNoErrors(activation, {
      what: "activation of a live fpm-lock test bridge class",
      name: className,
      source,
    });
    const executeAuthorization = GATE.authorize("execute", {
      name: authorized.target.name,
      packageName: authorized.target.packageName,
      type: authorized.target.type,
    });
    return executeAuthorization.target.name;
  }

  async function runBridge(className: string, source: string, description: string): Promise<string> {
    const runnable = await prepareBridge(className, source, description);
    const run = await runClass(conn, runnable);
    return run.output;
  }

  // ---------------------------------------------------------------------
  // Cleanup sweeper. NOT part of fpm-lock.ts's pinned API — this is
  // deliberately hand-written, independent ABAP so that cleanup does not
  // depend on the very protocol under test. It walks BOTH lock objects
  // (component + application) via a wide-open `ENQUEUE_READ` (GUNAME=space,
  // GCLIENT=space — contract §1) and deletes every row whose GARG starts
  // with our `ZMCP_LK_LIVE` config-id prefix via `ENQUE_DELETE`, feeding
  // each SEQG3 row back exactly as read (contract §1: a minimal/reconstructed
  // row deletes nothing).
  // ---------------------------------------------------------------------
  const SWEEP_CLASS = "ZCL_ZMCP_LK_SWEEP";
  const sweepSource = `CLASS zcl_zmcp_lk_sweep DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
ENDCLASS.

CLASS zcl_zmcp_lk_sweep IMPLEMENTATION.
  METHOD if_oo_adt_classrun~main.
    DATA: lt_enq   TYPE STANDARD TABLE OF seqg3,
          lt_del   TYPE STANDARD TABLE OF seqg3,
          ls_row   TYPE seqg3,
          lv_swept TYPE i.

    " --- WDY_CONFIG_DATA (component-scope locks, E_WDY_CONFCOMP) ---
    CLEAR: lt_enq, lt_del.
    CALL FUNCTION 'ENQUEUE_READ'
      EXPORTING
        gname   = 'WDY_CONFIG_DATA'
        guname  = space
        gclient = space
      TABLES
        enq = lt_enq
      EXCEPTIONS
        communication_failure = 1
        system_failure        = 2
        OTHERS                 = 3.
    LOOP AT lt_enq INTO ls_row WHERE garg(12) = 'ZMCP_LK_LIVE'.
      APPEND ls_row TO lt_del.
    ENDLOOP.
    IF lt_del IS NOT INITIAL.
      CALL FUNCTION 'ENQUE_DELETE'
        TABLES
          enq = lt_del.
      lv_swept = lv_swept + lines( lt_del ).
    ENDIF.

    " --- WDY_CONFIG_APPL (application-scope locks, E_WDY_CONFAPPL) ---
    CLEAR: lt_enq, lt_del.
    CALL FUNCTION 'ENQUEUE_READ'
      EXPORTING
        gname   = 'WDY_CONFIG_APPL'
        guname  = space
        gclient = space
      TABLES
        enq = lt_enq
      EXCEPTIONS
        communication_failure = 1
        system_failure        = 2
        OTHERS                 = 3.
    LOOP AT lt_enq INTO ls_row WHERE garg(12) = 'ZMCP_LK_LIVE'.
      APPEND ls_row TO lt_del.
    ENDLOOP.
    IF lt_del IS NOT INITIAL.
      CALL FUNCTION 'ENQUE_DELETE'
        TABLES
          enq = lt_del.
      lv_swept = lv_swept + lines( lt_del ).
    ENDIF.

    out->write( |LCKSWEEP> SWEPT count=[{ lv_swept }]| ).
  ENDMETHOD.
ENDCLASS.
`;

  async function sweepLocks(): Promise<number> {
    const raw = await runBridge(
      SWEEP_CLASS,
      sweepSource,
      // Must stay <= 60 chars; ADT rejects longer class descriptions (OO 653).
      "abapsmith fpm-lock sweeper: ZMCP_LK_LIVE* rows ($TMP)",
    );
    const m = raw.match(/^LCKSWEEP> SWEPT count=\[(\d+)\]$/m);
    return m ? Number(m[1]) : -1; // -1: could not parse the sweeper's own output
  }

  /** Never throws — cleanup must not mask (or replace) a real test failure. */
  async function bestEffortSweep(label: string): Promise<void> {
    try {
      const n = await sweepLocks();
      if (n < 0) {
        process.stderr.write(`[fpm-lock live] ${label}: sweep ran but its output could not be parsed\n`);
      } else if (n > 0) {
        process.stderr.write(`[fpm-lock live] ${label}: swept ${n} surviving ZMCP_LK_LIVE* lock row(s)\n`);
      }
    } catch (e) {
      process.stderr.write(`[fpm-lock live] ${label}: best-effort sweep failed: ${String(e)}\n`);
    }
  }

  // =======================================================================
  // 2. Wildcard detector fires on a deliberately sloppy enqueue
  //    (landmine 2, reproduced on purpose).
  //
  //    fpm-lock.ts's pinned API always passes every X_CONFIG_* flag as 'X'
  //    unconditionally, so it cannot generate the defect shape needed here.
  //    This is hand-written ABAP.
  // =======================================================================
  const WILDCARD_CLASS = "ZCL_ZMCP_LK_WILDCARD";
  const wildcardSource = `CLASS zcl_zmcp_lk_wildcard DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
ENDCLASS.

CLASS zcl_zmcp_lk_wildcard IMPLEMENTATION.
  METHOD if_oo_adt_classrun~main.
    DATA: lt_enq TYPE STANDARD TABLE OF seqg3,
          ls_row TYPE seqg3,
          lv_n1  TYPE i,
          lv_n2  TYPE i.

    " Deliberately reproduced sloppy-enqueue hazard: X_CONFIG_TYPE and
    " X_CONFIG_VAR are OMITTED entirely (not passed as space) -- the live
    " spike proved this fills those GARG segments with U+FFFF (wildcard)
    " rather than real blanks. No MODE_* parameter is passed, per the
    " pinned architecture decision (its default 'E' is correct and the
    " real parameter name for this FM was never confirmed).
    CALL FUNCTION 'ENQUEUE_E_WDY_CONFCOMP'
      EXPORTING
        config_id      = 'ZMCP_LK_LIVE2'
        x_config_id    = 'X'
        _scope         = '${FPM_LOCK_SCOPE}'
      EXCEPTIONS
        foreign_lock   = 1
        system_failure = 2
        OTHERS         = 3.
    out->write( |LCK2> ENQ subrc=[{ sy-subrc }]| ).

    CALL FUNCTION 'ENQUEUE_READ'
      EXPORTING
        gname   = 'WDY_CONFIG_DATA'
        guname  = space
        gclient = space
      TABLES
        enq = lt_enq
      EXCEPTIONS
        communication_failure = 1
        system_failure        = 2
        OTHERS                 = 3.
    LOOP AT lt_enq INTO ls_row WHERE garg(13) = 'ZMCP_LK_LIVE2'.
      lv_n1 = lv_n1 + 1.
      " WIDTH = 150 forces the full fixed-length GARG into the template --
      " without it, string-template embedding of a trailing-blank-padded
      " CHAR field is not guaranteed to keep those trailing blanks, and the
      " 'EOG' sentinel then lets the TS side recover the exact boundary
      " regardless of what got trimmed.
      out->write( |LCK2> ROW garg=[{ ls_row-garg WIDTH = 150 }EOG]| ).
    ENDLOOP.
    out->write( |LCK2> COUNT1 rows=[{ lv_n1 }]| ).

    " Release with a MATCHING sloppy dequeue -- same X-flag shape as the
    " enqueue above (X_CONFIG_ID only). A precise-shaped dequeue cannot
    " release a generic/wildcard lock (contract sec 1); this mirrors the
    " shape that actually does.
    CALL FUNCTION 'DEQUEUE_E_WDY_CONFCOMP'
      EXPORTING
        config_id   = 'ZMCP_LK_LIVE2'
        x_config_id = 'X'
        _scope      = '${FPM_LOCK_SCOPE}'.

    CLEAR lt_enq.
    CALL FUNCTION 'ENQUEUE_READ'
      EXPORTING
        gname   = 'WDY_CONFIG_DATA'
        guname  = space
        gclient = space
      TABLES
        enq = lt_enq
      EXCEPTIONS
        communication_failure = 1
        system_failure        = 2
        OTHERS                 = 3.
    LOOP AT lt_enq INTO ls_row WHERE garg(13) = 'ZMCP_LK_LIVE2'.
      lv_n2 = lv_n2 + 1.
    ENDLOOP.
    out->write( |LCK2> COUNT2 rows=[{ lv_n2 }]| ).
  ENDMETHOD.
ENDCLASS.
`;

  it("wildcard detector fires on a deliberately sloppy enqueue (landmine 2)", async () => {
    assertUsable();
    try {
      const raw = await runBridge(
        WILDCARD_CLASS,
        wildcardSource,
        "abapsmith fpm-lock live wildcard-defect test ($TMP)",
      );

      const enqMatch = raw.match(/^LCK2> ENQ subrc=\[(-?\d+)\]$/m);
      expect(enqMatch?.[1]).toBe("0");

      const count1Match = raw.match(/^LCK2> COUNT1 rows=\[(\d+)\]$/m);
      expect(count1Match?.[1]).toBe("1");

      const rowMatch = raw.match(/^LCK2> ROW garg=\[(.*)EOG\]$/m);
      expect(rowMatch).toBeTruthy();
      const garg = rowMatch![1];

      expect(hasWildcardFill(garg)).toBe(true);
      const view = parseGarg(garg);
      expect(view.isWildcard).toBe(true);
      expect(view.wildcardSegments).toContain("configType");

      // Confirm cleanup: the matching sloppy dequeue actually released it.
      const count2Match = raw.match(/^LCK2> COUNT2 rows=\[(\d+)\]$/m);
      expect(count2Match?.[1]).toBe("0");
    } finally {
      await bestEffortSweep("wildcard-defect test");
    }
  }, 90_000);

  // =======================================================================
  // 4. Single observation, NOT a lock-lifetime guarantee.
  //
  //    It has been established that
  //    "locks do not outlive their HTTP request" is FALSE as a general
  //    claim: a capture found 26 `E_ABAP_GENPH` locks
  //    still held 15-28 minutes after their requests ended. This test does NOT
  //    contradict that finding and does NOT establish the opposite for
  //    this lock type -- it records what happened to exactly one
  //    `E_WDY_CONFCOMP` lock object in one run: one classrun acquires and
  //    does not explicitly release; a second, later classrun re-reads and
  //    (in this observation) sees nothing. The protocol still has to live
  //    in ONE classrun per contract sec 1 / sec 2.2 -- that requirement
  //    does not depend on this test proving a lifetime bound.
  // =======================================================================
  const L4_ACQUIRE_CLASS = "ZCL_ZMCP_LK_L4ACQ";
  const l4AcquireSource = `CLASS zcl_zmcp_lk_l4acq DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
ENDCLASS.

CLASS zcl_zmcp_lk_l4acq IMPLEMENTATION.
  METHOD if_oo_adt_classrun~main.
    " Deliberately acquires and does NOT release. This is a single
    " observation of what happens to one lock object, not proof that locks
    " generally die at HTTP-request end -- a capture found 26
    " E_ABAP_GENPH locks still held 15-28 minutes after their requests
    " ended. If this lock is still held when ZCL_ZMCP_LK_L4READ runs
    " moments later below, the suite's afterAll sweep exists precisely to
    " clean up that failure mode.
    CALL FUNCTION 'ENQUEUE_E_WDY_CONFCOMP'
      EXPORTING
        config_id      = 'ZMCP_LK_LIVE4'
        config_type    = '00'
        config_var     = ''
        x_config_id    = 'X'
        x_config_type  = 'X'
        x_config_var   = 'X'
        _scope         = '${FPM_LOCK_SCOPE}'
      EXCEPTIONS
        foreign_lock   = 1
        system_failure = 2
        OTHERS         = 3.
    out->write( |LCK4> ACQ subrc=[{ sy-subrc }]| ).
  ENDMETHOD.
ENDCLASS.
`;

  const L4_READ_CLASS = "ZCL_ZMCP_LK_L4READ";
  const l4ReadSource = `CLASS zcl_zmcp_lk_l4read DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
ENDCLASS.

CLASS zcl_zmcp_lk_l4read IMPLEMENTATION.
  METHOD if_oo_adt_classrun~main.
    DATA: lt_enq TYPE STANDARD TABLE OF seqg3,
          ls_row TYPE seqg3,
          lv_n   TYPE i.
    CALL FUNCTION 'ENQUEUE_READ'
      EXPORTING
        gname   = 'WDY_CONFIG_DATA'
        guname  = space
        gclient = space
      TABLES
        enq = lt_enq
      EXCEPTIONS
        communication_failure = 1
        system_failure        = 2
        OTHERS                 = 3.
    LOOP AT lt_enq INTO ls_row WHERE garg(13) = 'ZMCP_LK_LIVE4'.
      lv_n = lv_n + 1.
    ENDLOOP.
    out->write( |LCK4> COUNT rows=[{ lv_n }]| ).
  ENDMETHOD.
ENDCLASS.
`;

  // Observation, not a lifetime guarantee: this records what happened to one
  // E_WDY_CONFCOMP lock object that was left open (not explicitly released)
  // by an earlier classrun. It does NOT establish that locks die at request
  // end -- an earlier capture shows 26 E_ABAP_GENPH locks alive
  // 15-28 minutes after their requests ended.
  it("a fresh classrun sees zero rows for one lock left open by an earlier classrun (observation, not a lifetime guarantee)", async () => {
    assertUsable();
    try {
      const acqRaw = await runBridge(
        L4_ACQUIRE_CLASS,
        l4AcquireSource,
        // ADT rejects a class description over 60 characters (OO 653).
        "abapsmith fpm-lock lifetime: acquire-only ($TMP)",
      );
      const acqMatch = acqRaw.match(/^LCK4> ACQ subrc=\[(-?\d+)\]$/m);
      expect(acqMatch?.[1]).toBe("0");

      // A NEW, later classrun execution -- runClass always uses a fresh
      // session (see run.ts), so this genuinely is a separate HTTP round
      // trip, not a continuation of the one above.
      const readRaw = await runBridge(
        L4_READ_CLASS,
        l4ReadSource,
        "abapsmith fpm-lock live lifetime test -- fresh re-read ($TMP)",
      );
      const countMatch = readRaw.match(/^LCK4> COUNT rows=\[(\d+)\]$/m);
      expect(countMatch?.[1]).toBe("0");
    } finally {
      await bestEffortSweep("lock-lifetime test");
    }
  }, 90_000);

  // =======================================================================
  // 7. `mode:"locks"` on abap_fpm_read, end to end, against a FOREIGN lock.
  //
  //    Run through the real tool handler (runFpmReadTool), not
  //    runFpmLockInspect, so the whole path is covered. The foreign lock is
  //    genuine: a SECOND SAP session holds it while the inspect runs. That
  //    matters because both sessions log on as the same SAP user, so GUNAME
  //    is identical on both sides -- the FOREIGN verdict can only come from
  //    GUSR. A single-session test cannot distinguish the two.
  // =======================================================================
  const HOLDER_CLASS = "ZCL_ZMCP_LK_HOLD";
  const HOLD_SECONDS = 20;
  const holderSource = `CLASS zcl_zmcp_lk_hold DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
ENDCLASS.

CLASS zcl_zmcp_lk_hold IMPLEMENTATION.
  METHOD if_oo_adt_classrun~main.
    " Holds a precise lock open across the WAIT so that a DIFFERENT session
    " can observe it, then releases it explicitly. The suite's sweeper is the
    " backstop if this classrun dies before the DEQUEUE.
    CALL FUNCTION 'ENQUEUE_E_WDY_CONFCOMP'
      EXPORTING
        config_id      = 'ZMCP_LK_LIVE6'
        config_type    = '00'
        config_var     = ''
        x_config_id    = 'X'
        x_config_type  = 'X'
        x_config_var   = 'X'
        _scope         = '${FPM_LOCK_SCOPE}'
      EXCEPTIONS
        foreign_lock   = 1
        system_failure = 2
        OTHERS         = 3.
    out->write( |LCK6> ENQ subrc=[{ sy-subrc }]| ).
    WAIT UP TO ${HOLD_SECONDS} SECONDS.
    CALL FUNCTION 'DEQUEUE_E_WDY_CONFCOMP'
      EXPORTING
        config_id     = 'ZMCP_LK_LIVE6'
        config_type   = '00'
        config_var    = ''
        x_config_id   = 'X'
        x_config_type = 'X'
        x_config_var  = 'X'
        _scope        = '${FPM_LOCK_SCOPE}'.
    out->write( |LCK6> DONE| ).
  ENDMETHOD.
ENDCLASS.
`;

  it("mode:\"locks\" renders a foreign lock held by a second session", async () => {
    assertUsable();
    const base = loadConfig();
    const cfg = { ...base, readOnly: false, allowPackages: ["$TMP"] };
    pool ??= new AdtSessionPool({
      cfg,
      breaker,
      log: () => {},
      createConnection: (c, o) => new AbapConnection(c, { ...o, log: () => {} }),
      prepareConnection: async (c) => {
        await c.connect();
      },
    });

    const deps: FpmToolDeps = {
      pool,
      safety: GATE,
      ensureConnected: async () => {},
      errorResult: (e: unknown) => ({
        content: [{ type: "text" as const, text: `ERR ${String(e)}` }],
        isError: true,
      }),
      cfg: { maxResponseChars: 200_000 },
    };

    // Started but NOT awaited: it holds the lock for HOLD_SECONDS while the
    // inspect below runs on a different session.
    const holder = runBridge(HOLDER_CLASS, holderSource, "abapsmith fpm-lock holder ($TMP)");
    holder.catch(() => {}); // never an unhandled rejection; asserted below

    try {
      // Well inside the hold window, and after the holder's write/activate.
      await new Promise((r) => setTimeout(r, 12_000));

      const res = await runFpmReadTool(deps, {
        mode: "locks",
        config_id: "ZMCP_LK_LIVE6",
        config_type: "00",
      });
      const text = (res.content as Array<{ type: string; text?: string }>)
        .map((c) => c.text ?? "")
        .join("\n");

      expect(res.isError).toBeFalsy();
      expect(text).toMatch(/^mode: locks$/m);
      expect(text).toMatch(/^locks: 1$/m);
      // The rendered row: the right lock object, a PRECISE (non-wildcard) key,
      // and -- the point of the test -- FOREIGN ownership.
      expect(text).toMatch(/WDY_CONFIG_DATA\s+ZMCP_LK_LIVE6\s+00\s+precise\s+FOREIGN/);
      // Inspection must never take a lock on the configuration it reports on.
      expect(text).toMatch(/NO lock is taken on this configuration/);

      const holderOut = await holder;
      expect(holderOut).toMatch(/^LCK6> ENQ subrc=\[0\]$/m);
      expect(holderOut).toMatch(/^LCK6> DONE$/m);
    } finally {
      await holder.catch(() => {});
      await bestEffortSweep("foreign-lock mode:locks test");
    }
  }, 240_000);

  // =======================================================================
  // 9. The same sloppy-enqueue hazard on the OTHER lock object.
  //
  //    Test 2 reproduced the sloppy-enqueue wildcard fill on E_WDY_CONFCOMP.
  //    FPM_LOCK_OBJECTS.application's own doc comment lists "the X-flag /
  //    wildcard fill behaviour" as still carried over BY ANALOGY for
  //    E_WDY_CONFAPPL. This closes that gap: same defect shape, other lock
  //    object. Hand-written ABAP, same allowance as test 2 — the pinned API
  //    always passes every X-flag, so it cannot generate this shape.
  // =======================================================================
  const WILDCARD_APPL_CLASS = "ZCL_ZMCP_LK_WILDAPPL";
  const wildcardApplSource = `CLASS zcl_zmcp_lk_wildappl DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
ENDCLASS.

CLASS zcl_zmcp_lk_wildappl IMPLEMENTATION.
  METHOD if_oo_adt_classrun~main.
    DATA: lt_enq TYPE STANDARD TABLE OF seqg3,
          ls_row TYPE seqg3,
          lv_n1  TYPE i,
          lv_n2  TYPE i.

    " X_CONFIG_TYPE and X_CONFIG_VAR OMITTED entirely -- the landmine.
    CALL FUNCTION 'ENQUEUE_E_WDY_CONFAPPL'
      EXPORTING
        config_id      = 'ZMCP_LK_LIVE9'
        x_config_id    = 'X'
        _scope         = '${FPM_LOCK_SCOPE}'
      EXCEPTIONS
        foreign_lock   = 1
        system_failure = 2
        OTHERS         = 3.
    out->write( |LCK9> ENQ subrc=[{ sy-subrc }]| ).

    CALL FUNCTION 'ENQUEUE_READ'
      EXPORTING
        gname   = 'WDY_CONFIG_APPL'
        guname  = space
        gclient = space
      TABLES
        enq = lt_enq
      EXCEPTIONS
        communication_failure = 1
        system_failure        = 2
        OTHERS                 = 3.
    LOOP AT lt_enq INTO ls_row WHERE garg(13) = 'ZMCP_LK_LIVE9'.
      lv_n1 = lv_n1 + 1.
      out->write( |LCK9> ROW garg=[{ ls_row-garg WIDTH = 150 }EOG] gobj=[{ ls_row-gobj }]| ).
    ENDLOOP.
    out->write( |LCK9> COUNT1 rows=[{ lv_n1 }]| ).

    " Matching sloppy dequeue -- a precise-shaped one cannot release a
    " generic lock (contract sec 1).
    CALL FUNCTION 'DEQUEUE_E_WDY_CONFAPPL'
      EXPORTING
        config_id   = 'ZMCP_LK_LIVE9'
        x_config_id = 'X'
        _scope      = '${FPM_LOCK_SCOPE}'.

    CLEAR lt_enq.
    CALL FUNCTION 'ENQUEUE_READ'
      EXPORTING
        gname   = 'WDY_CONFIG_APPL'
        guname  = space
        gclient = space
      TABLES
        enq = lt_enq
      EXCEPTIONS
        communication_failure = 1
        system_failure        = 2
        OTHERS                 = 3.
    LOOP AT lt_enq INTO ls_row WHERE garg(13) = 'ZMCP_LK_LIVE9'.
      lv_n2 = lv_n2 + 1.
    ENDLOOP.
    out->write( |LCK9> COUNT2 rows=[{ lv_n2 }]| ).
  ENDMETHOD.
ENDCLASS.
`;

  it("wildcard detector fires on a sloppy E_WDY_CONFAPPL enqueue too (landmine 2)", async () => {
    assertUsable();
    try {
      const raw = await runBridge(
        WILDCARD_APPL_CLASS,
        wildcardApplSource,
        "abapsmith fpm-lock wildcard defect on CONFAPPL ($TMP)",
      );

      expect(raw.match(/^LCK9> ENQ subrc=\[(-?\d+)\]$/m)?.[1]).toBe("0");
      expect(raw.match(/^LCK9> COUNT1 rows=\[(\d+)\]$/m)?.[1]).toBe("1");

      const rowMatch = raw.match(/^LCK9> ROW garg=\[(.*)EOG\] gobj=\[(\S*)\s*\]$/m);
      expect(rowMatch).toBeTruthy();
      expect(rowMatch![2]).toBe("E_WDY_CONFAPPL");

      const garg = rowMatch![1];
      expect(hasWildcardFill(garg)).toBe(true);
      const view = parseGarg(garg);
      expect(view.isWildcard).toBe(true);
      expect(view.wildcardSegments).toContain("configType");

      expect(raw.match(/^LCK9> COUNT2 rows=\[(\d+)\]$/m)?.[1]).toBe("0");
    } finally {
      await bestEffortSweep("wildcard-defect CONFAPPL test");
    }
  }, 90_000);
});
