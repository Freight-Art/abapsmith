/**
 * LIVE acceptance test for issue #147: `method=` after CHECK_FAILED.
 *
 * ###########################################################################
 * ## STATUS: NOT YET RUN against a live system at the time it was written.  ##
 * ## The shared A4H credential's auth circuit breaker was latched by other  ##
 * ## processes for the whole session and was deliberately not re-armed.    ##
 * ## Every claim below is therefore what the code is DESIGNED to do; the   ##
 * ## first green run should replace this box with its date and tip.        ##
 * ###########################################################################
 *
 * WHAT IT IS FOR. Before the fix, a full class write whose syntax check
 * failed left the object saved INACTIVE, and the next `abap_write method=`
 * against it answered NOT_FOUND: the member lookup asked ADT for the ACTIVE
 * component structure, which does not yet know the method (or the class,
 * when the class is new), and `available` listed the class name itself.
 * The only way out was a full re-read and re-write. `classMembersFor`
 * (src/adt/source.ts) now asks for `version=inactive` first and falls back
 * to active; this file is the one place that can prove ADT actually serves
 * that structure for a saved-but-inactive class.
 *
 * GATING. Runs only under `VITEST_LIVE=1`, and only with `ABAP_URL` set and
 * write access configured (`test/helpers/live-write-gate.ts`). The file is
 * also listed in `LIVE_INTEGRATION_TESTS` (vitest.config.ts); the self-gate
 * below is independent of that list on purpose.
 *
 * BUDGET. One object, `ZCL_AS_CHECKFAIL` in `$TMP`, ~12 requests: one
 * create (fails its check), one `method=` write, one activation, one
 * read-back, one delete.
 *
 * CLEANUP is unconditional (`afterAll`), and swallows its own failure so a
 * cleanup problem cannot mask the real one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { AbapError } from "../src/adt/errors.js";
import { loadConfig, loadEnvFile, type Config } from "../src/config.js";
import { abapWrite } from "../src/tools/write.js";
import { abapRead } from "../src/tools/read.js";
import { abapActivate } from "../src/tools/activate.js";
import { SafetyGate } from "../src/safety.js";
import { liveWriteConfigured } from "./helpers/live-write-gate.js";

loadEnvFile();

const liveEnabled = process.env.VITEST_LIVE === "1";
const haveUrl = Boolean(process.env.ABAP_URL);
const allowWrite = liveWriteConfigured();
const d = liveEnabled && haveUrl && allowWrite ? describe : describe.skip;

const NAME = "ZCL_AS_CHECKFAIL";
const MAX = 60_000;

/**
 * The broken class. `rv_out = iv_in * 2` without the period is a genuine
 * syntax error inside DOUBLE, and only there — so the repair is exactly one
 * method, and everything else the check could complain about is absent.
 */
const BROKEN = `CLASS zcl_as_checkfail DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS double IMPORTING iv_in TYPE i RETURNING VALUE(rv_out) TYPE i.
ENDCLASS.

CLASS zcl_as_checkfail IMPLEMENTATION.
  METHOD double.
    rv_out = iv_in * 2
  ENDMETHOD.
ENDCLASS.
`;

const REPAIRED_METHOD = `METHOD double.
    rv_out = iv_in * 2.
  ENDMETHOD.`;

/** Exactly one object, in exactly one package. Nothing wider. */
const GATE = new SafetyGate({
  readOnly: false,
  allowPackages: ["$TMP"],
  allowNamePrefixes: ["ZCL_AS_"],
});

let conn: AbapConnection;
let cfg: Config;

/** Aborts a test rather than spending another logon after the breaker tripped. */
const assertUsable = (): void => {
  if (conn.breaker.isTripped) {
    throw new Error(`circuit breaker tripped: ${conn.breaker.info?.message}`);
  }
};

const errorOf = async (p: Promise<unknown>): Promise<AbapError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!(e instanceof AbapError)) throw new Error(`expected an AbapError, got ${String(e)}`);
  return e;
};

d("live: a CHECK_FAILED class is repaired with one method= write and activated", () => {
  beforeAll(async () => {
    cfg = loadConfig();
    conn = new AbapConnection(cfg, { breaker: new AuthCircuitBreaker() });
    await conn.connect();
  });

  afterAll(async () => {
    if (!conn) return;
    try {
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

  it("full write with a syntax error lands CHECK_FAILED: saved, inactive, offending line quoted", async () => {
    assertUsable();
    const err = await errorOf(
      abapWrite(
        conn,
        { object: NAME, type: "CLAS/OC", source: BROKEN, package: "$TMP", description: "issue #147 probe" } as never,
        MAX,
        GATE,
      ),
    );
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toMatch(/saved INACTIVE/);
    expect(err.details).toMatchObject({ written: true, activated: false });
    // Issue #147 (3): the offending line and its neighbours come from the
    // bytes just sent, not from a re-read.
    const failure = err.details.failure as { details?: { messages?: Array<{ sourceLine?: string }> } };
    const withLine = failure.details?.messages?.find((m) => m.sourceLine !== undefined);
    expect(withLine?.sourceLine, "no message carried its source line").toContain("rv_out = iv_in * 2");
    // Issue #147 (4): the hint names the repair route.
    expect(err.hint ?? "").toMatch(/method="<NAME>"/);
    expect(err.hint ?? "").toMatch(/abap_activate/);
  });

  it("method= replaces the broken method against the INACTIVE version, with no re-read", async () => {
    assertUsable();
    const res = await abapWrite(
      conn,
      { object: NAME, type: "CLAS/OC", method: "DOUBLE", source: REPAIRED_METHOD, activate: false } as never,
      MAX,
      GATE,
    );
    expect(res.text).toMatch(/^changed: true$/m);
    // The member was found in the inactive structure — the exact lookup that
    // used to answer NOT_FOUND with the class name in `available`.
    expect(res.text).toMatch(/resolved against the INACTIVE version/);
  });

  it("activates cleanly afterwards", async () => {
    assertUsable();
    const res = await abapActivate(conn, { object: NAME, type: "CLAS/OC" } as never, MAX, GATE);
    expect(res.text).not.toMatch(/\berror\b/i);
  });

  it("the active source holds the repaired method", async () => {
    assertUsable();
    const back = await abapRead(conn, { object: NAME, method: "DOUBLE", version: "active" } as never, MAX);
    expect(back.text).toContain("rv_out = iv_in * 2.");
    expect(back.text).toMatch(/structureVersion: active/);
  });
});
