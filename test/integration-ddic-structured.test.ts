/**
 * LIVE acceptance test for the `ddic` structured shortcut of `abap_write`
 * (src/adt/ddic-payload.ts) — #144 (DTEL field labels) and #145 (DOMA fixed
 * values, value table, output length).
 *
 * ###########################################################################
 * ## STATUS: see the `LIVE` notes inside each test for the run that pinned ##
 * ## it. Every object goes through the real builder, the real write path   ##
 * ## (lock, PUT, read-back fidelity gate, activation) and a raw read-back. ##
 * ###########################################################################
 *
 * WHAT IT IS FOR. Offline tests pin the bytes the builder emits; only a real
 * system can answer whether SAP keeps them. #144 was exactly a case where
 * the PUT was accepted and the labels silently discarded, so "accepted" is
 * not the bar here — "activated, and the read-back holds every value sent"
 * is.
 *
 * GATING. Runs only under `VITEST_LIVE=1`, and only with `ABAP_URL` set and
 * write access configured (`liveSuiteSkipReason({ write: true })` in
 * test/live-appliance-state.ts, which states the reason for a skip). The
 * `VITEST_LIVE` check below is belt and braces: vitest.config.ts collects
 * live files by exact path from its `LIVE_INTEGRATION_TESTS` array, and this
 * file IS in that array — the self-gate is independent of it on purpose, so
 * that neither mistake alone can reach the network.
 *
 * BUDGET. Three objects in `$TMP` — `ZAS_DTEL_LBL`, `ZAS_DOMA_ST`,
 * `ZAS_DOMA_AMT` — each created, activated, read back once and deleted.
 *
 * CLEANUP is unconditional. `afterAll` deletes all three whatever happened
 * above it and reports what it could not clean rather than failing the run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { loadConfig, loadEnvFile, type Config } from "../src/config.js";
import { abapWrite } from "../src/tools/write.js";
import { abapRead } from "../src/tools/read.js";
import { SafetyGate } from "../src/safety.js";
import { liveSuiteSkipReason, skipForApplianceState } from "./live-appliance-state.js";

loadEnvFile();

const notRun =
  process.env.VITEST_LIVE === "1"
    ? liveSuiteSkipReason({ write: true })
    : "VITEST_LIVE is not 1 — live suites run only under the live config";
const d = notRun === undefined ? describe : describe.skip;
// A collection-time skip is counted but never says why; state the reason once, greppably.
if (notRun !== undefined) it("live ddic structured: suite not run", (ctx) => skipForApplianceState(ctx, notRun));

const DTEL = "ZAS_DTEL_LBL";
const DOMA_ST = "ZAS_DOMA_ST";
const DOMA_AMT = "ZAS_DOMA_AMT";
const MAX = 90_000;

/** Exactly these objects, in exactly one package. Nothing wider. */
const GATE = new SafetyGate({
  readOnly: false,
  allowPackages: ["$TMP"],
  allowNamePrefixes: ["ZAS_"],
});

let conn: AbapConnection;
let cfg: Config;

/** Aborts a test rather than spending another logon after the breaker tripped. */
const assertUsable = (): void => {
  if (conn.breaker.isTripped) {
    throw new Error(`circuit breaker tripped: ${conn.breaker.info?.message}`);
  }
};

const readRaw = async (object: string, type: string): Promise<string> =>
  (await abapRead(conn, { object, type, format: "raw" } as never, MAX)).text;

/** `activated: true`, and nothing in the report that reads as a warning. */
const expectCleanActivation = (text: string): void => {
  expect(text).toMatch(/\bactivated"?:\s*true/);
  expect(text).not.toMatch(/\bwarning\b/i);
  expect(text).not.toMatch(/VALUE_DISCARDED/);
};

d("live: the ddic structured shortcut creates DTEL/DE and DOMA/DD objects that activate and read back intact", () => {
  beforeAll(async () => {
    cfg = loadConfig();
    conn = new AbapConnection(cfg, { breaker: new AuthCircuitBreaker() });
    await conn.connect();
  });

  afterAll(async () => {
    if (!cfg) return;
    await conn?.close?.().catch?.(() => undefined);
    // One FRESH connection per delete, unlike the other live suites (which
    // delete a single object): on A4H the request after a successful DOMA/DD
    // delete on the same session fails with `400 Session Timed Out /
    // ICMENOSESSION` (seen on both 2026-09-16 runs), which left the second
    // and third object behind. Reverse order of creation, as everywhere else.
    for (const [object, type] of [
      [DOMA_AMT, "DOMA/DD"],
      [DOMA_ST, "DOMA/DD"],
      [DTEL, "DTEL/DE"],
    ] as const) {
      const c = new AbapConnection(cfg, { breaker: new AuthCircuitBreaker() });
      try {
        await c.connect();
        await abapWrite(c, { object, type, mode: "delete", confirm: object } as never, MAX, GATE);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[live] could not delete ${type} ${object} — it may be left behind in $TMP on a SHARED ` +
            `appliance. Remove it by hand (SE11) if so. Cause: ${String(e)}`,
        );
      } finally {
        await c.close?.().catch?.(() => undefined);
      }
    }
  });

  it("DTEL/DE with four field labels activates and the read-back holds every label and width (#144)", async () => {
    assertUsable();
    const res = await abapWrite(
      conn,
      {
        object: DTEL,
        type: "DTEL/DE",
        package: "$TMP",
        description: "abapsmith ddic label probe",
        ddic: {
          dataType: "CHAR",
          length: 1,
          shortLabel: "Status",
          mediumLabel: "Order status",
          longLabel: "Status of the order",
          headingLabel: "St.",
          headingLength: 3,
        },
      } as never,
      MAX,
      GATE,
    );
    expectCleanActivation(res.text);

    const raw = await readRaw(DTEL, "DTEL/DE");
    expect(raw).toContain("<dtel:shortFieldLabel>Status</dtel:shortFieldLabel><dtel:shortFieldLength>10</dtel:shortFieldLength>");
    expect(raw).toContain("<dtel:mediumFieldLabel>Order status</dtel:mediumFieldLabel><dtel:mediumFieldLength>20</dtel:mediumFieldLength>");
    expect(raw).toContain("<dtel:longFieldLabel>Status of the order</dtel:longFieldLabel><dtel:longFieldLength>40</dtel:longFieldLength>");
    expect(raw).toContain("<dtel:headingFieldLabel>St.</dtel:headingFieldLabel><dtel:headingFieldLength>03</dtel:headingFieldLength>");
    expect(raw).toMatch(/adtcore:version="active"/);
  });

  it("DOMA/DD CHAR 1 with three fixed values activates and the read-back holds all three rows in order (#145)", async () => {
    assertUsable();
    const res = await abapWrite(
      conn,
      {
        object: DOMA_ST,
        type: "DOMA/DD",
        package: "$TMP",
        description: "abapsmith ddic status probe",
        ddic: {
          dataType: "CHAR",
          length: 1,
          fixedValues: [
            { low: "N", text: "New" },
            { low: "P", text: "In progress" },
            { low: "D", text: "Done" },
          ],
        },
      } as never,
      MAX,
      GATE,
    );
    expectCleanActivation(res.text);

    const raw = await readRaw(DOMA_ST, "DOMA/DD");
    expect(raw).toMatch(/adtcore:version="active"/);
    expect(raw).toContain("<doma:outputInformation><doma:length>000001</doma:length>");
    // The server numbers the rows; the builder sent none.
    expect(raw).toContain("<doma:position>0001</doma:position><doma:low>N</doma:low><doma:high/><doma:text>New</doma:text>");
    expect(raw).toContain("<doma:position>0002</doma:position><doma:low>P</doma:low><doma:high/><doma:text>In progress</doma:text>");
    expect(raw).toContain("<doma:position>0003</doma:position><doma:low>D</doma:low><doma:high/><doma:text>Done</doma:text>");
  });

  it("DOMA/DD DEC 13,3 activates with the computed output length 15 (#145)", async () => {
    assertUsable();
    const res = await abapWrite(
      conn,
      {
        object: DOMA_AMT,
        type: "DOMA/DD",
        package: "$TMP",
        description: "abapsmith ddic amount probe",
        ddic: { dataType: "DEC", length: 13, decimals: 3, signExists: true },
      } as never,
      MAX,
      GATE,
    );
    expectCleanActivation(res.text);

    const raw = await readRaw(DOMA_AMT, "DOMA/DD");
    expect(raw).toMatch(/adtcore:version="active"/);
    expect(raw).toContain("<doma:typeInformation><doma:datatype>DEC</doma:datatype><doma:length>000013</doma:length><doma:decimals>000003</doma:decimals></doma:typeInformation>");
    expect(raw).toContain("<doma:outputInformation><doma:length>000015</doma:length>");
    expect(raw).toContain("<doma:signExists>true</doma:signExists>");
  });
});
