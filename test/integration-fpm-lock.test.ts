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
 * `$TMP` bridge classes. Every artefact this file creates is `ZMCP_`-
 * prefixed and lives in `$TMP`; every test releases what it took in a
 * `try/finally`, and `afterAll` runs one more best-effort sweep for any
 * `ZMCP_LK_LIVE*` lock row left behind by an aborted run. Never touch an
 * object this suite did not create.
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
  fpmLockKey,
  buildLockedOperationSource,
  fpmLockBridgeClassName,
  parseLockTranscript,
  hasWildcardFill,
  parseGarg,
  FPM_LOCK_SCOPE,
  type FpmLockedOperation,
} from "../src/adt/fpm-lock.js";

loadEnvFile(); // so a .env in the repo root enables the live suite
const notRun = liveSuiteSkipReason({ write: true });
const dw = notRun === undefined ? describe : describe.skip;
// A collection-time skip is counted but never says why; state the reason once, greppably.
if (notRun !== undefined) it("live A4H fpm-lock protocol: suite not run", (ctx) => skipForApplianceState(ctx, notRun));

dw("live A4H fpm-lock protocol (write path, $TMP only)", () => {
  let conn: AbapConnection;
  const GATE = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
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

  /** Runs the pinned `buildLockedOperationSource` protocol end to end and parses its transcript. */
  async function runLockedOperation(op: FpmLockedOperation) {
    const className = fpmLockBridgeClassName(op);
    const source = buildLockedOperationSource(op, className);
    const raw = await runBridge(className, source, `abapsmith fpm-lock live protocol test (${op.bodyLabel})`);
    return parseLockTranscript(raw);
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
  // 1. Full protocol round trip
  // =======================================================================
  it("full protocol round trip: acquire -> verify -> body -> release, live", async () => {
    assertUsable();
    const key = fpmLockKey({ configId: "ZMCP_LK_LIVE1", configType: "00" });
    const op: FpmLockedOperation = {
      key,
      // Trivial, side-effect-free body — NOT a real config save. The
      // surrounding generated protocol supplies `mo_out` (fpm-lock.ts
      // mirrors fpm-runtime.ts's bridge-class structure, which exposes the
      // classrun's out-writer to generated statements under that name).
      // NB: the body may not contain the `LCK> ` transcript prefix (it must not
      // be able to forge protocol lines) nor any of the control-flow tokens in
      // FORBIDDEN_BODY_TOKENS — hence the `BODY>` prefix and the token-free
      // marker text. Both restrictions are asserted offline in fpm-lock.test.ts.
      body: `mo_out->write( |BODY> BODYECHO marker=[ROUNDTRIP1-OK]| ).`,
      bodyLabel: "roundtrip1",
    };

    try {
      const transcript = await runLockedOperation(op);

      expect(transcript.selfOwnerId).toBeTruthy();
      expect(transcript.acquire?.subrc).toBe(0);
      expect(transcript.acquire?.foreignLock).toBe(false);
      expect(transcript.acquire?.systemFailure).toBe(false);

      const afterAcquire = transcript.phases.find((p) => p.phase === "after-acquire");
      expect(afterAcquire?.rows).toHaveLength(1);
      const row = afterAcquire!.rows[0];
      expect(row.garg_view.configId).toBe(key.configId);
      expect(row.garg_view.configType).toBe(key.configType);
      expect(row.garg_view.configVar).toBe(key.configVar);
      expect(row.garg_view.isWildcard).toBe(false);

      expect(transcript.preSaveVerify?.passed).toBe(true);
      expect(transcript.preSaveVerify?.mine).toBe(true);
      expect(transcript.preSaveVerify?.wildcard).toBe(false);
      expect(transcript.saveReached).toBe(true);
      expect(transcript.release?.status).toBe("released");
      expect(transcript.wildcardDetected).toBe(false);
      expect(transcript.aborts).toHaveLength(0);

      // ...and the release is verified by a re-read in THIS SAME classrun, not
      // inferred from DEQUEUE's subrc (which is 0 even for a no-op). The
      // `after-release` phase must be PRESENT with zero rows: present proves
      // the re-read ran, zero proves the lock is gone. A missing phase is not
      // the same as an empty one, which is why `reportedRows` is asserted too —
      // it is the count SAP itself printed, independent of ROW-line survival.
      const afterRelease = transcript.phases.find((p) => p.phase === "after-release");
      expect(afterRelease).toBeDefined();
      expect(afterRelease?.rows).toHaveLength(0);
      expect(afterRelease?.reportedRows).toBe(0);

      // One classrun, one lock lifetime: acquire, verify, body and release all
      // appear in a single transcript, in order.
      expect(transcript.phases.map((p) => p.phase)).toEqual([
        "after-acquire",
        "postbody",
        "after-release",
      ]);
    } finally {
      await bestEffortSweep("round-trip test");
    }
  }, 90_000);

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
  // 3. Release verification is real.
  //
  //    This is the one assertion the offline fake CANNOT make: it proves a
  //    real re-read of SAP's own SEQG3 enqueue table came back empty after
  //    DEQUEUE -- not merely that the code called DEQUEUE and trusted its
  //    subrc, which the spike proved is worthless (0 for a real delete, 0
  //    for a no-op, 0 for an empty table -- contract sec 1). A fake has no
  //    real SEQG3 table behind it, so it cannot fail this check even if the
  //    release logic were completely broken. Only a live re-read can.
  // =======================================================================
  it("release verification is real: a live re-read after release shows zero rows", async () => {
    assertUsable();
    const key = fpmLockKey({ configId: "ZMCP_LK_LIVE3", configType: "00" });
    const op: FpmLockedOperation = {
      key,
      // "RELEASE-CHECK" would trip the `\bCHECK\b` guard; "CHECK" is a forbidden
      // body token because a failing CHECK exits the block and skips the release.
      body: `mo_out->write( |BODY> BODYECHO marker=[RELEASE-VERIFY]| ).`,
      bodyLabel: "releasecheck",
    };

    try {
      const transcript = await runLockedOperation(op);
      expect(transcript.release?.status).toBe("released");

      const afterRelease = transcript.phases.find((p) => p.phase === "after-release");
      expect(afterRelease).toBeDefined();
      expect(afterRelease?.rows).toHaveLength(0);
    } finally {
      await bestEffortSweep("release-verification test");
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
  // 5. THE EXCEPTION PATH — the single most important test in this file.
  //
  //    An earlier cut of buildLockedOperationSource let an exception raised
  //    by the caller's body unwind straight past the DEQUEUE, leaking the
  //    lock: a fail-open, and the worst kind, because the happy path stayed
  //    green and the leak only appeared when a save went wrong. The inner
  //    TRY/CATCH turns that unwind into a fall-through so the release below
  //    it is reached on EVERY path.
  //
  //    Only the wire can prove this: a fake has no ABAP runtime, so it can
  //    neither raise CX_SY_ZERODIVIDE nor fail to run a DEQUEUE.
  // =======================================================================
  it("a body that raises still releases the lock (inner TRY/CATCH, no fail-open)", async () => {
    assertUsable();
    const key = fpmLockKey({ configId: "ZMCP_LK_LIVE5", configType: "00" });
    const op: FpmLockedOperation = {
      key,
      // Divide by a variable zero: a genuine, unavoidable ABAP runtime
      // exception (CX_SY_ZERODIVIDE). Deliberately NOT `RAISE EXCEPTION` --
      // this is the shape a real save failure takes. The literal `1 / 0`
      // would be caught at compile time instead.
      body: [
        `DATA lv_zero TYPE i VALUE 0.`,
        `DATA lv_boom TYPE i.`,
        `mo_out->write( |BODY> about to raise| ).`,
        `lv_boom = 1 / lv_zero.`,
        `mo_out->write( |BODY> UNREACHABLE { lv_boom }| ).`,
      ].join("\n"),
      bodyLabel: "excpath",
    };

    try {
      const transcript = await runLockedOperation(op);

      // The body was entered and then blew up...
      expect(transcript.saveReached).toBe(true);
      expect(transcript.aborts.join(" | ")).toMatch(/body-exception/);
      expect(transcript.aborts.join(" | ")).toMatch(/CX_SY_ZERODIVIDE/);

      // ...and the lock was STILL released, verified by re-read, not subrc.
      expect(transcript.release?.status).toBe("released");
      const afterRelease = transcript.phases.find((p) => p.phase === "after-release");
      expect(afterRelease).toBeDefined();
      expect(afterRelease?.rows).toHaveLength(0);
      expect(afterRelease?.reportedRows).toBe(0);
    } finally {
      await bestEffortSweep("exception-path test");
    }
  }, 90_000);

  // =======================================================================
  // 6. E_WDY_CONFAPPL — the application-scope lock object.
  //
  //    FPM_LOCK_OBJECTS.application was carried over from the component lock
  //    object BY ANALOGY: the spike never enqueued, dequeued or read it, and
  //    in particular never captured a GARG, so the 0/32/34 segment layout was
  //    an assumption. This test exercises it for real.
  // =======================================================================
  it("E_WDY_CONFAPPL: config_type 02 locks WDY_CONFIG_APPL with the assumed GARG layout", async () => {
    assertUsable();
    const key = fpmLockKey({ configId: "ZMCP_LK_LIVE7", configType: "02" });
    const op: FpmLockedOperation = {
      key,
      body: `mo_out->write( |BODY> BODYECHO marker=[APPL-OK]| ).`,
      bodyLabel: "appl1",
    };

    try {
      const transcript = await runLockedOperation(op);

      expect(transcript.acquire?.subrc).toBe(0);
      expect(transcript.acquire?.foreignLock).toBe(false);

      const afterAcquire = transcript.phases.find((p) => p.phase === "after-acquire");
      expect(afterAcquire?.rows).toHaveLength(1);
      const row = afterAcquire!.rows[0];

      // The routing decision: config_type "02" must land on the APPLICATION
      // lock object, not the component one.
      expect(row.gname).toBe("WDY_CONFIG_APPL");
      expect(row.gobj).toBe("E_WDY_CONFAPPL");

      // The inferred GARG layout, now checked against a real row: config_id in
      // [0,32), config_type in [32,34). If SAP laid this table out differently
      // these slices would come back as something other than what we locked.
      expect(row.garg_view.configId).toBe(key.configId);
      expect(row.garg_view.configType).toBe("02");
      expect(row.garg_view.isWildcard).toBe(false);

      // Owner discrimination works on this lock object too.
      expect(row.ownership).toBe("MINE");

      expect(transcript.saveReached).toBe(true);
      expect(transcript.release?.status).toBe("released");
      const afterRelease = transcript.phases.find((p) => p.phase === "after-release");
      expect(afterRelease?.reportedRows).toBe(0);
      expect(transcript.aborts).toHaveLength(0);
    } finally {
      await bestEffortSweep("application-lock test");
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
  // 8. CONTENTION — the real collision scenario, not just observing one.
  //
  //    The defect this guards against is not "a foreign lock can be
  //    observed". It is: SAVE_COMP_
  //    CONFIG_TO_DB committed a write even though the writing session's OWN
  //    enqueue had been REFUSED with FOREIGN_LOCK (subrc=1). Test 7 above
  //    OBSERVES a foreign lock from a third-party inspect; it never COLLIDES
  //    with one. This test collides.
  //
  //    Session A holds a precise lock on ZMCP_LK_LIVE8. Session B then runs
  //    the SHIPPED generated protocol (buildLockedOperationSource — not
  //    hand-written ABAP) against the SAME key, so the code path under test
  //    is exactly the one that ships.
  //
  //    The body carries an observable side effect: it writes a distinctive
  //    marker. "The body did not run" is therefore proved three ways —
  //    the marker is ABSENT from the raw output, no `BODY state=[begin]`
  //    line exists, and the protocol emits an explicit
  //    `GUARD reason=[enqueue-refused]` saying so in words.
  //
  //    Both classes are write+activated BEFORE the hold window opens
  //    (prepareBridge), so the only thing that has to fit inside the window
  //    is a bare classrun.
  // =======================================================================
  const HOLD8_CLASS = "ZCL_ZMCP_LK_HOLD8";
  const HOLD8_SECONDS = 45;
  const CONTENTION_ID = "ZMCP_LK_LIVE8";
  /** Must not appear anywhere in session B's output. Its absence IS the assertion. */
  const BODY8_MARKER = "CONTENTION8-BODY-RAN";
  const hold8Source = `CLASS zcl_zmcp_lk_hold8 DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
ENDCLASS.

CLASS zcl_zmcp_lk_hold8 IMPLEMENTATION.
  METHOD if_oo_adt_classrun~main.
    " Session A. Takes a PRECISE lock (every X-flag set, exactly the shape
    " fpm-lock.ts itself generates) on the key session B is about to ask for,
    " and holds it across the WAIT so that B's ENQUEUE is genuinely refused
    " rather than merely observed. Released explicitly below; the suite's
    " sweeper is the backstop if this classrun dies before the DEQUEUE.
    CALL FUNCTION 'ENQUEUE_E_WDY_CONFCOMP'
      EXPORTING
        config_id      = '${CONTENTION_ID}'
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
    out->write( |LCK8> ENQ subrc=[{ sy-subrc }]| ).
    WAIT UP TO ${HOLD8_SECONDS} SECONDS.
    CALL FUNCTION 'DEQUEUE_E_WDY_CONFCOMP'
      EXPORTING
        config_id     = '${CONTENTION_ID}'
        config_type   = '00'
        config_var    = ''
        x_config_id   = 'X'
        x_config_type = 'X'
        x_config_var  = 'X'
        _scope        = '${FPM_LOCK_SCOPE}'.
    out->write( |LCK8> DONE| ).
  ENDMETHOD.
ENDCLASS.
`;

  it("contention: a REFUSED enqueue stops the protocol before the body", async () => {
    assertUsable();
    const base = loadConfig();
    const cfg = { ...base, readOnly: false, allowPackages: ["$TMP"] };

    const key = fpmLockKey({ configId: CONTENTION_ID, configType: "00" });
    const op: FpmLockedOperation = {
      key,
      // An observable side effect. If the protocol ever runs the body despite
      // a refused enqueue, this marker lands in the classrun output and the
      // `not.toContain` below fails loudly. `BODY>` (not `LCK> `) because the
      // body may not forge protocol lines.
      body: `mo_out->write( |BODY> BODYECHO marker=[${BODY8_MARKER}]| ).`,
      bodyLabel: "contention8",
    };
    const bClassName = fpmLockBridgeClassName(op);
    const bSource = buildLockedOperationSource(op, bClassName);

    // Sanity, offline: the marker really is in the source we are about to run,
    // so its absence from the OUTPUT means "not executed" and not "not there".
    expect(bSource).toContain(BODY8_MARKER);

    // Prepared up front: write+activate must not eat into the hold window.
    const holderRunnable = await prepareBridge(
      HOLD8_CLASS,
      hold8Source,
      "abapsmith fpm-lock contention holder ($TMP)",
    );
    const bRunnable = await prepareBridge(
      bClassName,
      bSource,
      "abapsmith fpm-lock contention victim ($TMP)",
    );

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

    // Session B: a genuinely separate SAP session. Both sessions log on as the
    // same SAP user, so the refusal can only come from enqueue OWNERSHIP, not
    // from a user-name mismatch.
    const connB = new AbapConnection(cfg, { log: () => {}, breaker });
    await connB.connect();

    // Started but NOT awaited: session A holds the lock for HOLD8_SECONDS.
    const holder = runClass(conn, holderRunnable);
    holder.catch(() => {}); // never an unhandled rejection; awaited below

    try {
      // Well inside the window: the holder classrun only has to reach its
      // ENQUEUE, which is its first statement.
      await new Promise((r) => setTimeout(r, 6_000));

      const runB = await runClass(connB, bRunnable);
      const rawB = runB.output;

      // ---- 1. our own enqueue was REFUSED ------------------------------
      expect(rawB).toMatch(
        /^LCK> ENQ fm=\[ENQUEUE_E_WDY_CONFCOMP\] subrc=\[1\] exc=\[foreign_lock\] scope=\[1\]$/m,
      );

      // ---- 2. the body did NOT run -------------------------------------
      // (a) the side effect never happened...
      expect(rawB).not.toContain(BODY8_MARKER);
      // (b) ...and the protocol never even announced the body.
      expect(rawB).not.toMatch(/^LCK> BODY /m);
      // (c) nor did it reach the verify, the release or any row phase: on a
      //     refused enqueue there is nothing held, so nothing to read back or
      //     give back. A DEQ line here would mean we tried to release someone
      //     else's lock.
      expect(rawB).not.toMatch(/^LCK> VERIFY /m);
      expect(rawB).not.toMatch(/^LCK> DEQ /m);
      expect(rawB).not.toMatch(/^LCK> RELEASE /m);
      expect(rawB).not.toMatch(/^LCK> ROW /m);
      expect(rawB).not.toMatch(/^LCK> COUNT /m);

      // ---- 3. it said so, in words, on the wire ------------------------
      expect(rawB).toMatch(
        /^LCK> GUARD reason=\[enqueue-refused\] detail=\[ENQUEUE_E_WDY_CONFCOMP subrc=1 \(foreign_lock\) - the body was not run and nothing was released\]$/m,
      );

      // ---- 4. and it reports the contention honestly to the caller ------
      const transcript = parseLockTranscript(rawB);
      expect(transcript.acquire?.subrc).toBe(1);
      expect(transcript.acquire?.foreignLock).toBe(true);
      expect(transcript.acquire?.systemFailure).toBe(false);
      expect(transcript.saveReached).toBe(false);
      expect(transcript.preSaveVerify).toBeUndefined();
      expect(transcript.release).toBeUndefined();
      expect(transcript.phases).toHaveLength(0);
      expect(transcript.wildcardDetected).toBe(false);
      expect(transcript.aborts).toEqual([
        "enqueue-refused: ENQUEUE_E_WDY_CONFCOMP subrc=1 (foreign_lock) - the body was not run and nothing was released",
      ]);
      // The session was healthy and identified itself — it was refused THIS
      // key, not broken. Without this, `saveReached: false` could just mean
      // the classrun blew up before it got anywhere.
      expect(transcript.selfOwnerId).toBeTruthy();

      // ---- 5. B left no lock behind ------------------------------------
      // Inspected from a THIRD session while A is still holding: exactly one
      // row on this key. If B had acquired (or leaked) anything there would
      // be two, and if B had somehow stolen it the owner would be B's.
      const res = await runFpmReadTool(deps, {
        mode: "locks",
        config_id: CONTENTION_ID,
        config_type: "00",
      });
      const text = (res.content as Array<{ type: string; text?: string }>)
        .map((c) => c.text ?? "")
        .join("\n");
      expect(res.isError).toBeFalsy();
      expect(text).toMatch(/^locks: 1$/m);
      expect(text).toMatch(/WDY_CONFIG_DATA\s+ZMCP_LK_LIVE8\s+00\s+precise\s+FOREIGN/);

      // ---- 6. session A was, in fact, the holder ------------------------
      const holderOut = (await holder).output;
      expect(holderOut).toMatch(/^LCK8> ENQ subrc=\[0\]$/m);
      expect(holderOut).toMatch(/^LCK8> DONE$/m);

      // ---- 7. nothing survives once A releases -------------------------
      // A dedicated sweep, asserted rather than best-effort: zero rows means
      // neither session left anything on either lock object.
      expect(await sweepLocks()).toBe(0);
    } finally {
      await holder.catch(() => {});
      await connB.shutdown("test-end").catch(() => {});
      await bestEffortSweep("contention test");
    }
  }, 300_000);

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
