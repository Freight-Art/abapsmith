/**
 * LIVE acceptance test for writing an ABAP Unit test class into CCAU.
 *
 * ###########################################################################
 * ## STATUS: RUN, 6/6 GREEN on A4H, 2026-08-18, at the branch tip that      ##
 * ## carries the `POST …/includes` fix. Teardown verified by re-reading     ##
 * ## until not-found: no object left behind.                                ##
 * ##                                                                        ##
 * ## Its two original unknowns were settled LIVE on the same day, by a      ##
 * ## separate probe (a manual script, not shipped in this release) running  ##
 * ## the same sequence against a throwaway class:                          ##
 * ##                                                                       ##
 * ##  1. LOCKING — ANSWERED. One lock on the CLASS object                  ##
 * ##     (`/oo/classes/<c>`) covers a CCAU PUT exactly as it covers a main ##
 * ##     PUT. A PUT with no lock handle was refused; the class lock was    ##
 * ##     accepted. (The include is ALSO lockable in its own right, but     ##
 * ##     this repo deliberately does not use that — see `lockUri` in       ##
 * ##     src/adt/write.ts for why.)                                        ##
 * ##  2. ACTIVATION — ANSWERED. Activating the CLASS is sufficient. After  ##
 * ##     one `activateObject` on the class URI, ABAP Unit compiled and ran ##
 * ##     the freshly written test class, reporting a line number inside    ##
 * ##     `<…================CCAU>`. No include-level activation was sent.  ##
 * ##                                                                       ##
 * ## What that probe ALSO found is why this file failed its first run      ##
 * ## (3 of 6, on tip c0b81e5, which predates the fix): CCAU does not exist ##
 * ## as a document until something creates it, and PUT does not create it  ##
 * ## — the server answers "<class>================CCAU does not have any   ##
 * ## inactive version". `src/adt/write.ts` now issues `POST …/includes`    ##
 * ## under the class lock first. A failure here carrying that same message ##
 * ## means that step regressed.                                            ##
 * ##                                                                       ##
 * ## Its SECOND run failed 2 of 6 on this file's own bugs, not the         ##
 * ## product's: it demanded the include be named in the write report (it   ##
 * ## was not — `abap_write` now emits an `include:` line, which is a real  ##
 * ## fix this run earned), and it matched `/\bfailed\b/` against a report  ##
 * ## whose own field label is `failed: 0`. Both corrected here.            ##
 * ##                                                                       ##
 * ## Everything above is a real capture and may be cited.                  ##
 * ###########################################################################
 *
 * WHAT IT IS FOR. The whole point is that ABAP Unit tests were unwritable:
 * `abap_write` could only reach a class's main include, and unit tests live in
 * CCAU. Every other test for this fix in this repo is offline and pins URI
 * construction and refusals. Only this one can answer the question that
 * actually matters — does SAP accept it, and does the test then RUN.
 *
 * GATING. Runs only under `VITEST_LIVE=1`, and only with `ABAP_URL` set and
 * write access configured (`ABAP_MODE=edit`/`admin`, or legacy
 * `ABAP_ALLOW_WRITE=true` — see `test/helpers/live-write-gate.ts`).
 * The `VITEST_LIVE` check below is belt and braces:
 * `vitest.config.ts` collects live files by exact path from its
 * `LIVE_INTEGRATION_TESTS` array, and this file IS in that array — the
 * self-gate below is deliberately independent of the config anyway, so that
 * neither mistake alone can reach the network.
 *
 * BUDGET. One object, `ZMCP_CCAU_LIVE` in `$TMP`, ~12 requests. The appliance
 * has 7 dialog work processes and is shared; this file creates one class,
 * writes two includes of it, activates once, reads twice, runs the unit test
 * once, and deletes the class.
 *
 * CLEANUP is unconditional. `afterAll` deletes the class whatever happened
 * above it, including when an assertion threw mid-file, and swallows its own
 * failure so a cleanup problem cannot mask the real one. A leaked `$TMP` class
 * on a shared box is somebody else's confusing afternoon.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { loadConfig, loadEnvFile, type Config } from "../src/config.js";
import { abapWrite } from "../src/tools/write.js";
import { abapRead } from "../src/tools/read.js";
import { abapActivate } from "../src/tools/activate.js";
import { abapTest } from "../src/tools/test.js";
import { SafetyGate } from "../src/safety.js";
import { liveWriteConfigured } from "./helpers/live-write-gate.js";

loadEnvFile();

const liveEnabled = process.env.VITEST_LIVE === "1";
const haveUrl = Boolean(process.env.ABAP_URL);
const allowWrite = liveWriteConfigured();
const d = liveEnabled && haveUrl && allowWrite ? describe : describe.skip;

const NAME = "ZMCP_CCAU_LIVE";
const URI = "/sap/bc/adt/oo/classes/zmcp_ccau_live";
const MAX = 60_000;

/**
 * The class under test. Deliberately trivial and deliberately NOT empty: a
 * method with a return value gives the CCAU include something to assert
 * against, so "the test ran" and "the test passed" are distinguishable
 * outcomes rather than the same vacuous green.
 */
const MAIN = `CLASS zmcp_ccau_live DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS double IMPORTING iv_in TYPE i RETURNING VALUE(rv_out) TYPE i.
ENDCLASS.

CLASS zmcp_ccau_live IMPLEMENTATION.
  METHOD double.
    rv_out = iv_in * 2.
  ENDMETHOD.
ENDCLASS.
`;

/**
 * The local test class, as it must appear in CCAU. Note it references
 * `zmcp_ccau_live` directly — a local test class in a global class's CCAU
 * include is a friend of it, which is the entire reason ABAP Unit tests live
 * there and not in a separate object.
 */
const TESTS = `CLASS ltcl_double DEFINITION FINAL FOR TESTING
  DURATION SHORT
  RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    METHODS doubles_a_positive FOR TESTING.
ENDCLASS.

CLASS ltcl_double IMPLEMENTATION.
  METHOD doubles_a_positive.
    DATA(lo_cut) = NEW zmcp_ccau_live( ).
    cl_abap_unit_assert=>assert_equals(
      act = lo_cut->double( 21 )
      exp = 42
      msg = 'double( 21 ) must be 42' ).
  ENDMETHOD.
ENDCLASS.
`;

/** Exactly one object, in exactly one package. Nothing wider. */
const GATE = new SafetyGate({
  readOnly: false,
  allowPackages: ["$TMP"],
  allowNamePrefixes: ["ZMCP_"],
});

let conn: AbapConnection;
let cfg: Config;

/** Aborts a test rather than spending another logon after the breaker tripped. */
const assertUsable = (): void => {
  if (conn.breaker.isTripped) {
    throw new Error(`circuit breaker tripped: ${conn.breaker.info?.message}`);
  }
};

d("live: an ABAP Unit test class can be written into CCAU and run", () => {
  beforeAll(async () => {
    cfg = loadConfig();
    conn = new AbapConnection(cfg, { breaker: new AuthCircuitBreaker() });
    await conn.connect();
  });

  /**
   * UNCONDITIONAL. Runs after a passing file, a failing file, and a file that
   * threw in `beforeAll` — and reports what it could not clean rather than
   * failing the run, because a cleanup error thrown here would replace the
   * assertion failure that is the actual news.
   */
  afterAll(async () => {
    if (!conn) return;
    try {
      // Delete the CLASS. There is no such thing as deleting an include: the
      // four sub-includes are parts of the object and go with it. Deleting in
      // reverse order of creation therefore means exactly one delete.
      await abapWrite(conn, { object: NAME, type: "CLAS/OC", mode: "delete", confirm: NAME } as never, MAX, GATE);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[live] could not delete ${NAME} — it may be left behind in $TMP on a SHARED ` +
          `appliance. Remove it by hand (SE24) if so. Cause: ${String(e)}`,
      );
    } finally {
      await conn.close?.().catch?.(() => undefined);
    }
  });

  it("creates the class with only its main include", async () => {
    assertUsable();
    const res = await abapWrite(
      conn,
      { object: NAME, type: "CLAS/OC", source: MAIN, package: "$TMP", description: "CCAU write probe" } as never,
      MAX,
      GATE,
    );
    expect(res.text).toMatch(/created|updated/i);
  });

  it("writes the test class into CCAU — the write this file exists to prove works", async () => {
    assertUsable();
    const res = await abapWrite(
      conn,
      { object: NAME, type: "CLAS/OC", include: "testclasses", source: TESTS } as never,
      MAX,
      GATE,
    );
    // LIVE 2026-08-18: the first run of this file failed HERE, and the write
    // itself was fine — the report simply did not name the include, so a CCAU
    // write and a main write read identically. `abap_write` now emits an
    // `include:` header line for a sub-include, which is what this pins.
    expect(res.text).toMatch(/^include: testclasses$/m);
    expect(res.text).toMatch(/^changed: true$/m);
  });

  it("activates the class, and the test include with it", async () => {
    assertUsable();
    const res = await abapActivate(conn, { object: NAME, type: "CLAS/OC" } as never, MAX, GATE);
    // A syntax error in the CCAU include surfaces HERE, not at the write: the
    // PUT is accepted for inactive source. If this fails, read the messages
    // before touching anything else — they are about the ABAP above, not
    // about the write path.
    expect(res.text).not.toMatch(/\berror\b/i);
  });

  it("reads the CCAU include back, and gets the TEST class — not the main source", async () => {
    assertUsable();
    const back = await abapRead(conn, { object: NAME, include: "testclasses" } as never, MAX);
    // The single most important assertion in the file. A silent downgrade to
    // the main include is the exact defect this file exists to catch, and it would look
    // like success everywhere except right here.
    expect(back.text).toContain("ltcl_double");
    expect(back.text).toContain("cl_abap_unit_assert");
    expect(
      back.text,
      "reading the testclasses include answered with the MAIN source. The write may have gone " +
        "to the wrong document, or the read did — either way CCAU write support is not fixed.",
    ).not.toContain("METHOD double.");
  });

  it("reads the main include back, and gets the CLASS — the CCAU write did not overwrite it", async () => {
    assertUsable();
    const back = await abapRead(conn, { object: NAME } as never, MAX);
    expect(back.text).toContain("METHOD double.");
    expect(
      back.text,
      "the class body now holds the test class. A write aimed at CCAU landed on /source/main.",
    ).not.toContain("ltcl_double");
  });

  it("RUNS the unit test — the end-to-end point of this file", async () => {
    assertUsable();
    const res = await abapTest(conn, { object: NAME, type: "CLAS/OC" } as never, MAX, GATE);
    // Two distinct failures hide behind one another here, so both are named:
    //   - "no tests found" means the CCAU include never reached the runner;
    //   - a reported failure means the test ran and the assertion is wrong.
    //
    // Do NOT read "no tests found" as an activation problem on its own. This
    // assertion cannot see whether the earlier tests passed, so it must not
    // claim they did: if the read-back test above also failed, nothing was ever
    // written to CCAU and activation is not the suspect. Check that test first.
    expect(
      res.text,
      "ABAP Unit found no tests in " +
        NAME +
        ". Read the read-back test above before blaming activation: if IT failed too, the write " +
        "never reached CCAU. Only if the read-back passed — the bytes are in CCAU — is activation " +
        "of the include the thing to suspect.",
    ).toMatch(/ltcl_double|doubles_a_positive/i);
    // `/\bfailed\b/` was wrong and cost a run: the report's own FIELD LABEL is
    // `failed: 0`, so the bare word matches on a completely clean pass. Match
    // the COUNT, not the label.
    expect(res.text).toMatch(/^outcome: PASSED$/m);
    expect(res.text).toMatch(/^failed: 0$/m);
  });
});
