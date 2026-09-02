/**
 * Live integration test. Skipped unless ABAP_URL is set.
 *
 * SAFETY:
 *  - ONE connection is shared by the whole file; `fileParallelism: false` in
 *    vitest.config.ts keeps logons serialised.
 *  - Every test aborts if the circuit breaker has tripped, so a bad password
 *    costs one logon attempt, not one per test.
 *  - Fixtures are T000 / SFLIGHT. MARA / VBAK / KNA1 / MARC 404 on this box.
 *    ZOTH_T_NOTE_K (table type) is also expected present; the case that reads
 *    it skips with an APPLIANCE STATE note rather than failing when it isn't.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AbapConnection, toLegacySystemRole } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { loadConfig, loadEnvFile, type Config } from "../src/config.js";
import { abapRead } from "../src/tools/read.js";
import { abapSearch } from "../src/tools/search.js";
import { resolveObject } from "../src/adt/resolve.js";
import { authorizeMutation, resolveWriteTarget, writeObject } from "../src/adt/write.js";
import { activateObject, checkSource } from "../src/adt/activate.js";
import { runClass } from "../src/adt/run.js";
import { SafetyGate } from "../src/safety.js";
import { probeObjectExists, skipForApplianceState, underApplianceStateWatch } from "./live-appliance-state.js";
import { liveWriteConfigured } from "./helpers/live-write-gate.js";

loadEnvFile(); // so a .env in the repo root enables the live suite
const live = Boolean(process.env.ABAP_URL);
const d = live ? describe : describe.skip;

let conn: AbapConnection;
let cfg: Config;
const MAX = 60_000;

const assertUsable = () => {
  if (conn.breaker.isTripped) {
    throw new Error(`circuit breaker tripped: ${conn.breaker.info?.message}`);
  }
};

d("live A4H integration", () => {
  beforeAll(async () => {
    cfg = loadConfig();
    conn = new AbapConnection(cfg, { log: () => {}, breaker: new AuthCircuitBreaker() });
    await underApplianceStateWatch("integration beforeAll connect", () => conn.connect());
  }, 60_000);

  afterAll(async () => {
    await conn?.shutdown("test-end");
  });

  it("connects with exactly one logon and no sap-client parameter", (ctx) => {
    expect(conn.isConnected).toBe(true);
    expect(conn.breaker.isTripped).toBe(false);
    // An earlier version asserted `readOnly === true` unconditionally. That stopped
    // being an invariant once ABAP_ALLOW_WRITE was introduced: read-only is still
    // the default, but ABAP_ALLOW_WRITE turns it off, and this suite is run both
    // ways. What must ALWAYS hold is
    // that the connection agrees with the configured policy.
    //
    // Role probe is tri-state; "development" and "unknown" are both
    // legitimate — pinning one hardcodes an appliance-specific answer,
    // not the contract. "test" is excluded because `toLegacySystemRole`
    // never produces it; "productive" is excluded deliberately — this suite
    // must never point at a productive box, so that outcome fails hard.
    expect(conn.systemRole).toBe(toLegacySystemRole(conn.roleDetection));
    expect(["development", "unknown"]).toContain(conn.systemRole);
    if (conn.systemRole === "unknown") {
      skipForApplianceState(ctx, `system role probed inconclusive — ${conn.roleDetection.reason}`);
    }
    // Server-derived, not defaulted: proven by the assertions below
    // (no probeFailure, a real ccCategory, reason naming it).
    expect(conn.roleDetection.probeFailure).toBeUndefined();
    expect(conn.roleDetection.ccCategory?.trim()).toBeTruthy();
    expect(conn.roleDetection.reason).toMatch(/CCCATEGORY/);
    expect(conn.readOnly).toBe(cfg.readOnly);
    if (!liveWrite) expect(conn.readOnly).toBe(true);
  });

  it("runs the discovery probe and feature-probes real collections", () => {
    assertUsable();
    const s = conn.discovery.summary();
    expect(s.collections).toBeGreaterThan(100);
    expect(conn.discovery.supports("repository.search")).toBe(true);
    expect(conn.discovery.supports("ddic.tables.source")).toBe(true);
    expect(conn.discovery.supports("usage.references")).toBe(true);
    expect(conn.discovery.supports("debugger")).toBe(true);
  });

  it("keeps the full cookie jar", () => {
    assertUsable();
    const jar = conn.cookies();
    // What is ALWAYS present on A4H: sap-usercontext — this is how client 001
    // is selected without ever sending ?sap-client=, so it is load-bearing —
    // plus the session id (SAP_SESSIONID_A4H_001) and MYSAPSSO2.
    //
    // `sap-XSRF_*` is CONDITIONAL. An earlier version asserted it as a fact; a later
    // run came back without it while CSRF-protected POSTs kept working, so it is not
    // required for CSRF health on this system and must not be asserted. The real
    // check is the next test, which proves a CSRF-requiring POST actually
    // succeeds instead of using a cookie's presence as a proxy for it.
    expect(jar).toContain("sap-usercontext=sap-client=001");
    expect(jar.split("; ").length).toBeGreaterThanOrEqual(2);
    // Logged, not asserted — if it comes back we want to notice.
    process.stderr.write(
      `sap-XSRF_* cookie ${/sap-XSRF_/.test(jar) ? "PRESENT" : "ABSENT"}; ` +
        `jar keys: ${jar
          .split("; ")
          .map((c) => c.split("=")[0])
          .join(",")}\n`,
    );
  });

  it("proves CSRF is healthy with a real token-requiring POST (replaces the cookie proxy)", async () => {
    assertUsable();
    // `checkruns` is the cheapest CSRF-protected POST there is: no lock, no
    // write, no state change, 80–250 ms. If the token were
    // missing or stale this would come back 403 "CSRF token validation failed".
    const target = await resolveWriteTarget(conn, { name: "ZDEMO1", type: "PROG/P" });
    const outcome = await checkSource(conn, target, "REPORT zdemo1.\nWRITE: / 'csrf ok'.\n");
    expect(outcome.errors).toBe(0);
    expect(conn.breaker.isTripped).toBe(false);
  });

  it("resolves a fuzzy reference server-side", async () => {
    assertUsable();
    const obj = await resolveObject(conn, "ZCL_DEMO_D_CALC_AMOUNT");
    expect(obj.type).toBe("CLAS/OC");
    expect(obj.uri).toBe("/sap/bc/adt/oo/classes/zcl_demo_d_calc_amount");
    expect(obj.packageName).toBe("$DEMO_SOI_DRAFT");
  });

  it("reads class source and emits an etag", async () => {
    assertUsable();
    const r = await abapRead(conn, { object: "class ZCL_DEMO_D_CALC_AMOUNT" }, MAX);
    expect(r.etag).toMatch(/^sha256:/);
    expect(r.text).toContain("CLASS zcl_demo_d_calc_amount DEFINITION");
    expect(r.text).toContain("--- SOURCE ---");
    expect(r.truncated).toBe(false);

    // Same object read twice → same etag.
    const again = await abapRead(conn, { object: "ZCL_DEMO_D_CALC_AMOUNT" }, MAX);
    expect(again.etag).toBe(r.etag);
  });

  it("reads a single method instead of the whole class", async () => {
    assertUsable();
    const whole = await abapRead(conn, { object: "class ZCL_DEMO_D_CALC_AMOUNT" }, MAX);
    const one = await abapRead(
      conn,
      { object: "class ZCL_DEMO_D_CALC_AMOUNT", method: "EXECUTE" },
      MAX,
    );
    expect(one.text).toContain("METHOD SOURCE");
    expect(one.text.length).toBeLessThan(whole.text.length);
  });

  it("returns a class outline", async () => {
    assertUsable();
    const r = await abapRead(conn, { object: "ZCL_DEMO_D_CALC_AMOUNT", outline: true }, MAX);
    expect(r.text).toContain("--- OUTLINE ---");
    expect(r.text).toContain("EXECUTE");
  });

  it("reads program source", async () => {
    assertUsable();
    const r = await abapRead(conn, { object: "program ZDEMO1" }, MAX);
    expect(r.text).toContain("REPORT ZDEMO1");
  });

  it("reads CDS/DDLS source", async () => {
    assertUsable();
    const r = await abapRead(conn, { object: "cds ZDEMO_C_SALESORDER_TP_D" }, MAX);
    expect(r.text.toLowerCase()).toContain("define view");
  });

  it("renders a table as pseudo-DDL with keys and foreign keys, never XML", async () => {
    assertUsable();
    const r = await abapRead(conn, { object: "table SFLIGHT" }, MAX);
    expect(r.text).toContain("--- PSEUDO-DDL ---");
    expect(r.text).toContain("define table sflight");
    expect(r.text).toContain("with foreign key");
    expect(r.text).toContain("keyFields: MANDT, CARRID, CONNID, FLDATE");
    expect(r.text).toContain("FIELD DIGEST");
    expect(r.text).not.toContain("<?xml");
    expect(r.etag).toMatch(/^sha256:/);
  });

  it("reads T000 (the other table fixture that works on this box)", async () => {
    assertUsable();
    const r = await abapRead(conn, { object: "table T000" }, MAX);
    expect(r.text).toContain("define table t000");
    expect(r.text).not.toContain("<?xml");
  });

  it("renders a domain with its fixed values", async () => {
    assertUsable();
    const r = await abapRead(conn, { object: "domain XFELD" }, MAX);
    expect(r.text).toContain("define domain xfeld");
    expect(r.text).toContain("FIXED VALUES");
    expect(r.text).not.toContain("<?xml");
  });

  it("renders a data element with its domain and value table", async () => {
    assertUsable();
    const r = await abapRead(conn, { object: "data element S_CARR_ID" }, MAX);
    expect(r.text).toContain("domain     : S_CARR_ID");
    expect(r.text).toContain("value table: SCARR");
    expect(r.text).not.toContain("<?xml");
  });

  it("renders a table type from XML-only metadata", async (ctx) => {
    assertUsable();
    const existence = await probeObjectExists(conn, "table type ZOTH_T_NOTE_K");
    if (!existence.present) {
      skipForApplianceState(
        ctx,
        `table type ZOTH_T_NOTE_K is not on this appliance (${existence.reason}). ` +
          "Create it, or point this test at a table type that exists on this system.",
      );
    }
    const r = await abapRead(conn, { object: "table type ZOTH_T_NOTE_K" }, MAX);
    expect(r.text).toContain("define table type");
    expect(r.text).not.toContain("<?xml");
    expect(r.text).not.toContain("valueHelp");
  });

  it("renders a structure as DDL", async () => {
    assertUsable();
    const r = await abapRead(conn, { object: "structure BAPIRET2" }, MAX);
    expect(r.text).toContain("define structure bapiret2");
  });

  it("searches the repository", async () => {
    assertUsable();
    const r = await abapSearch(conn, { query: "ZCL_DEMO_*", type: "CLAS" }, MAX);
    expect(r.text).toContain("ZCL_DEMO_D_CALC_AMOUNT");
    expect(r.text).toContain("--- RESULTS ---");
  });

  it("answers where-used", async () => {
    assertUsable();
    const r = await abapSearch(
      conn,
      { query: "class ZCL_DEMO_D_CALC_AMOUNT", mode: "where_used" },
      MAX,
    );
    expect(r.text).toContain("--- USED BY ---");
    expect(r.text).toContain("static-analysis blind spots");
  });

  it("enforces the ~15k-token cap on a large real object", async () => {
    assertUsable();
    const r = await abapRead(conn, { object: "class CL_ABAP_TYPEDESCR" }, 4000);
    expect(r.text.length).toBeLessThanOrEqual(4000);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("--- TRUNCATED ---");
    expect(r.text).toMatch(/offset=\d+/);
  });

  it("returns a structured NOT_FOUND rather than throwing raw ADT noise", async () => {
    assertUsable();
    await expect(
      abapRead(conn, { object: "class ZCL_DOES_NOT_EXIST_ANYWHERE" }, MAX),
    ).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|ADT_ERROR/) });
  });
});

/**
 * Live write path. Gated on BOTH `ABAP_URL` and write access being
 * configured (`ABAP_MODE=edit`/`admin`, or legacy `ABAP_ALLOW_WRITE=true` —
 * see `test/helpers/live-write-gate.ts`), so a plain `npm test` on a
 * machine with credentials never writes to the system.
 *
 * Everything here lives in `$TMP` and is named `ZMCP_*`.
 */
const liveWrite = live && liveWriteConfigured();
const dw = liveWrite ? describe : describe.skip;

dw("live A4H write path", () => {
  let wconn: AbapConnection;
  const PROBE_CLASS = "ZCL_ZMCP_STALE_PROBE";

  const probeSource = (marker: string) => `CLASS zcl_zmcp_stale_probe DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
ENDCLASS.

CLASS zcl_zmcp_stale_probe IMPLEMENTATION.
  METHOD if_oo_adt_classrun~main.
    out->write( |MARKER=${marker}| ).
  ENDMETHOD.
ENDCLASS.
`;

  // `writeObject` now requires a real gate-minted `AuthorizedTarget`.
  // Everything here lives in `$TMP` and is named
  // `ZMCP_*` (see the file header), so one permissive-but-real gate covers the
  // whole describe block.
  const GATE = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
  const authWrite = (target: { name: string; type?: string }) =>
    authorizeMutation(wconn, GATE, "write", target);

  beforeAll(async () => {
    const base = loadConfig();
    wconn = new AbapConnection(
      { ...base, readOnly: false, allowPackages: ["$TMP"] },
      { log: () => {}, breaker: new AuthCircuitBreaker() },
    );
    await wconn.connect();
  }, 60_000);

  afterAll(async () => {
    await wconn?.shutdown("test-end");
  });

  const assertWritable = () => {
    if (wconn.breaker.isTripped) {
      throw new Error(`circuit breaker tripped: ${wconn.breaker.info?.message}`);
    }
  };

  it("enables writes on a non-productive system via explicit opt-in", (ctx) => {
    assertWritable();
    expect(wconn.isConnected).toBe(true);
    // "unknown" is a legitimate probe outcome and still fails closed here.
    // "productive" is excluded deliberately (fails hard, not skipped);
    // "test" is excluded because `toLegacySystemRole` never produces it.
    expect(wconn.systemRole).toBe(toLegacySystemRole(wconn.roleDetection));
    expect(["development", "unknown"]).toContain(wconn.systemRole);
    if (wconn.systemRole === "unknown") {
      // Assert fail-closed BEFORE skipping — proves the opt-in doesn't
      // leak through even when this appliance can't exercise it.
      expect(wconn.writesLockedOut).toBe(true);
      expect(wconn.readOnly).toBe(true);
      skipForApplianceState(ctx, `system role probed inconclusive — ${wconn.roleDetection.reason}`);
    }
    // Server-derived, not defaulted — see the sibling check above.
    expect(wconn.roleDetection.probeFailure).toBeUndefined();
    expect(wconn.roleDetection.ccCategory?.trim()).toBeTruthy();
    expect(wconn.writesLockedOut).toBe(false);
    expect(wconn.readOnly).toBe(false);
  });

  /**
   * THE STALE-CLASS-TRAP REGRESSION TEST.
   *
   * Prior investigation proved "same session ⇒ stale code, fresh logon ⇒ new code" but
   * never isolated whether `dropSession()` (which drops the sap-contextid while
   * KEEPING the cookie jar) is enough, or whether a full re-logon is required.
   * A structural assertion cannot settle that — only running changed code can.
   *
   * If this test ever fails, `withFreshSession()` is not actually giving us a
   * fresh program buffer and every "edit then run" result is suspect.
   */
  it("runs NEW code after an edit — dropSession() really does defeat the stale-class trap", async () => {
    assertWritable();
    const markerA = `A${Date.now()}`;
    const markerB = `B${Date.now()}`;

    const target = await resolveWriteTarget(wconn, {
      name: PROBE_CLASS,
      type: "CLAS/OC",
      packageName: "$TMP",
      description: "abapsmith stale-classrun probe",
    });

    await writeObject(wconn, await authWrite(target), { source: probeSource(markerA) });
    const actA = await activateObject(wconn, target);
    expect(actA.activated).toBe(true);
    const runA = await runClass(wconn, PROBE_CLASS);
    expect(runA.output).toContain(`MARKER=${markerA}`);

    // Now change the code and re-run through the same code path.
    await writeObject(wconn, await authWrite(target), { source: probeSource(markerB) });
    const actB = await activateObject(wconn, target);
    expect(actB.activated).toBe(true);
    const runB = await runClass(wconn, PROBE_CLASS);

    expect(runB.output).toContain(`MARKER=${markerB}`);
    expect(runB.output).not.toContain(`MARKER=${markerA}`);
  }, 180_000);

  it("skips the PUT entirely when the source is unchanged (compare-before-write)", async () => {
    assertWritable();
    const target = await resolveWriteTarget(wconn, { name: PROBE_CLASS, type: "CLAS/OC" });
    const current = await writeObject(wconn, await authWrite(target), { source: probeSource("NOOP") });
    const again = await writeObject(wconn, await authWrite(target), { source: probeSource("NOOP") });
    expect(again.changed).toBe(false);
    expect(again.etag).toBe(current.etag);
  }, 120_000);

  it("rejects a stale etag before taking any lock", async () => {
    assertWritable();
    const target = await resolveWriteTarget(wconn, { name: PROBE_CLASS, type: "CLAS/OC" });
    await expect(
      writeObject(wconn, await authWrite(target), {
        source: probeSource("SHOULD_NOT_LAND"),
        expectEtag: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      }),
    ).rejects.toMatchObject({ code: "ETAG_CONFLICT" });
  }, 60_000);

  it("reports a syntax error with the REAL source line, not the message ordinal", async () => {
    assertWritable();
    const target = await resolveWriteTarget(wconn, { name: PROBE_CLASS, type: "CLAS/OC" });
    // Line 10 is the `out->write(...)` line; break it deliberately.
    const broken = probeSource("X").replace("out->write( |MARKER=X| ).", "WRIT 'oops'.");
    const outcome = await checkSource(wconn, target, broken);
    expect(outcome.ok).toBe(false);
    expect(outcome.errors).toBeGreaterThan(0);
    // The offending statement is on line 10 of the generated source. The naive
    // renderer would print the ordinal 1 here.
    const lines = outcome.messages.map((m) => m.line);
    expect(lines.some((l) => l !== undefined && l >= 8)).toBe(true);
    expect(wconn.breaker.isTripped).toBe(false);
  }, 60_000);
});
