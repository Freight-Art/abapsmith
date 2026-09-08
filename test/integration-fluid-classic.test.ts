/**
 * Live integration test for the builtin `classic` fluid tool
 * (`src/adt/fluid/builtin/classic.ts`) — the consolidated DDIC/CTS bridge
 * that replaced the old per-operation classrun bridges for views,
 * transactions, indexes, packages and transport-entry removal.
 *
 * The offline suite (test/fluid-classic.test.ts) fakes the transport and can
 * only prove the choreography issues the right HTTP verbs against the right
 * URIs, with canned console transcripts. It cannot prove SAP actually
 * accepts `ZCL_ZMCP_FLUID_CLASSIC` in `$ABAPSMITH_FLUID_API`, activates it,
 * and really executes the DDIC/CTS function modules behind each action. This
 * file proves both, live:
 *
 *  1. `ensureFluidTool` deploys and activates `ZCL_ZMCP_FLUID_RT` and
 *     `ZCL_ZMCP_FLUID_CLASSIC` into `$ABAPSMITH_FLUID_API` — read back
 *     independently over ADT, not just trusted from `ensureFluidTool`'s own
 *     return value.
 *  2. The `exists` action really executes on the server: a throwaway `$TMP`
 *     transaction, `ZMCP_S3_<random>`, is created then deleted through the
 *     classic tool, and `exists` is asked before, between and after —
 *     ABSENT -> EXISTS -> ABSENT — with the create/delete transcript tags
 *     asserted at each step too.
 *  3. `create_view`'s `RS_CORR_INSERT` DICT-key construction is exercised at
 *     its widest case: a throwaway `$TMP` view named with the full
 *     30-character `DD25L-VIEWNAME` ceiling — a name of 27+ chars is exactly
 *     what a CHAR30 `ddobjname` key would truncate, surfacing as SAP message
 *     TK103 — is created, proven EXISTS, then deleted, ABSENT again. The
 *     view's own delete runs on a fresh connection (see afterAll's comment on
 *     why).
 *
 * Concurrency note: another slice may be deploying its own fluid tool onto
 * the same appliance at the same time, so `$ABAPSMITH_FLUID_API` already
 * existing (and already holding other tools' objects) is expected — no
 * assertion here may require it to be empty. `$ABAPSMITH_FLUID_API` itself
 * is never deleted.
 *
 * SAFETY: gated behind BOTH `ABAP_URL` and write access being configured
 * (`ABAP_MODE=edit`/`admin`, or legacy `ABAP_ALLOW_WRITE=true` — see
 * `test/helpers/live-write-gate.ts`). No transport is ever created — the
 * round-trip transaction lives in `$TMP` with no correction number. `afterAll`
 * deletes the throwaway transaction if it is still present, best-effort,
 * `console.warn`ing on failure and reconnecting once on `isSessionDeadFailure`
 * before retrying. Nothing outside `$ABAPSMITH_FLUID_API` and `ZMCP_S3_*` /
 * `ZCL_ZMCP_*` objects in `$TMP` is touched.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { loadConfig, loadEnvFile, type Config } from "../src/config.js";
import { SafetyGate } from "../src/safety.js";
import { isSessionDeadFailure } from "../src/adt/write-verify.js";
import { dispatch } from "../src/adt/fluid/dispatch.js";
import { ensureFluidTool } from "../src/adt/fluid/ensure.js";
import { FLUID_PACKAGE } from "../src/adt/fluid/package.js";
import { CLASSIC_TOOL_ID, CLASSIC_BODY_CLASS, classicTool } from "../src/adt/fluid/builtin/classic.js";
import { createTransaction } from "../src/adt/tran-create.js";
import { deleteTransactionViaBridge } from "../src/adt/tran-delete.js";
import { createClassicView } from "../src/adt/view-create.js";
import { deleteClassicViewViaBridge } from "../src/adt/view-delete.js";
import { serverPackage } from "../src/adt/resolved-package.js";
import { parsePackageRef } from "../src/adt/package-ref.js";
import { liveSuiteSkipReason, skipForApplianceState } from "./live-appliance-state.js";

loadEnvFile(); // so a .env in the repo root enables the live suite
const notRun = liveSuiteSkipReason({ write: true });
const dw = notRun === undefined ? describe : describe.skip;
// A collection-time skip is counted but never says why; state the reason once, greppably.
if (notRun !== undefined) it("live classic fluid tool: suite not run", (ctx) => skipForApplianceState(ctx, notRun));

const randomSuffix = Math.random().toString(36).slice(2, 8).toUpperCase();
const TCODE = `ZMCP_S3_${randomSuffix}`;

/**
 * DEMO_LIST_SYSTEM_FIELDS: a SABAPDEMOS report confirmed present on this A4H
 * appliance (see test/integration-fluid-run.test.ts's REPORT constant) — a
 * safe, always-there program to point the throwaway transaction at.
 */
const PROGRAM = "DEMO_LIST_SYSTEM_FIELDS";

// Exactly 30 chars (DD25L-VIEWNAME's ceiling — see VIEW_NAME_MAX in
// src/adt/view-create.ts) so this pins the RS_CORR_INSERT DICT-key width
// fix: a CHAR30 ddobjname key would truncate a name this long and SAP would
// answer TK103. "S11" plus a random tail keeps it from colliding with
// another slice's live suite, or a rerun of this one, on the same appliance.
const viewRandomSuffix = (Math.random().toString(36) + Math.random().toString(36) + Math.random().toString(36))
  .replace(/[^a-z0-9]/g, "")
  .slice(0, 19)
  .padEnd(19, "0")
  .toUpperCase();
const VIEW_NAME = `ZMCP_S11_V_${viewRandomSuffix}`;

/** SFLIGHT: confirmed present on this A4H appliance (see test/integration.test.ts). */
const VIEW_BASE_TABLE = "SFLIGHT";
const VIEW_FIELDS = ["MANDT", "CARRID"] as const;

dw("live A4H classic fluid tool ($ABAPSMITH_FLUID_API + $TMP)", () => {
  let cfg: Config;
  let conn: AbapConnection;
  let tcodeCreated = false;
  let viewCreated = false;
  // allowNamePrefixes: ["*"] — FLUID_PACKAGE starts with "$", not "Z"/"Y", same
  // reasoning as test/integration-fluid-run.test.ts's GATE.
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

  const classicExists = async (kind: "transaction" | "view", name: string): Promise<string> => {
    const result = await dispatch(
      { conn, cfg: conn.cfg, gate: GATE, tools: new Map([[CLASSIC_TOOL_ID, classicTool]]) },
      { tool: CLASSIC_TOOL_ID, action: "exists", args: { kind, name } },
    );
    return (result.result as string[])[0]!;
  };

  const currentServerPackage = (name: string) =>
    serverPackage({ status: "confirmed", uri: `fixture://live/${name}`, via: "read-back", packageName: name })!;

  // A view delete runs DD_OBJ_DEL twice plus TR_TADIR_INTERFACE and can tear
  // the ABAP session down server-side the same way a class delete can — same
  // idiom as test/integration-fluid-enh.test.ts's freshConn: never reuse a
  // connection that already did other work across a delete like this one.
  const freshConn = () => new AbapConnection(cfg, { log: () => {}, breaker: new AuthCircuitBreaker() });

  beforeAll(async () => {
    const base = loadConfig();
    cfg = { ...base, readOnly: false, allowPackages: ["$TMP", FLUID_PACKAGE] };
    conn = new AbapConnection(cfg, { log: () => {}, breaker });
    await conn.connect();
  }, 60_000);

  afterAll(async () => {
    // Best-effort: remove the throwaway transaction if the round-trip test
    // left it behind (e.g. an assertion failed between create and delete).
    // Deleting a transaction is far less disruptive than deleting a class,
    // but the reconnect-once idiom is cheap insurance and matches every
    // other live suite's cleanup here.
    const cleanup = async () => {
      if (!tcodeCreated) return;
      const doDelete = async () => {
        await deleteTransactionViaBridge(conn, GATE, { tcode: TCODE, packageName: currentServerPackage("$TMP") });
      };
      try {
        if (conn?.isConnected && !conn.breaker.isTripped) {
          try {
            await doDelete();
          } catch (e) {
            if (!isSessionDeadFailure(e)) throw e;
            await conn.connect();
            await doDelete();
          }
        }
      } catch (e) {
        console.warn(`afterAll: failed to clean up transaction ${TCODE} — remove it by hand.`, e);
      }
    };

    // Same best-effort shape as the transaction cleanup above, but on its
    // own fresh connection — see the freshConn comment above for why.
    const cleanupView = async () => {
      if (!viewCreated) return;
      const doDelete = async () => {
        const c = freshConn();
        await c.connect();
        try {
          await deleteClassicViewViaBridge(c, GATE, { viewName: VIEW_NAME, packageName: currentServerPackage("$TMP") });
        } finally {
          await c.shutdown("test-end");
        }
      };
      try {
        await doDelete();
      } catch (e) {
        console.warn(`afterAll: failed to clean up view ${VIEW_NAME} — remove it by hand.`, e);
      }
    };

    await cleanup();
    await cleanupView();
    await conn?.shutdown("test-end");
  }, 90_000);

  it("deploys the classic body through ensure/dispatch and it is really active in the fluid package", async () => {
    assertUsable();
    const result = await ensureFluidTool(conn, GATE, conn.cfg, classicTool, {
      tool: CLASSIC_TOOL_ID,
      action: "exists",
      op: "run",
    });

    expect(result.objects.map((o) => o.state)).toEqual(["present", "present"]);

    const pkg = await readClassPackage(CLASSIC_BODY_CLASS);
    expect(pkg).toBe(FLUID_PACKAGE);
    expect(await readClassIsActive(CLASSIC_BODY_CLASS)).toBe(true);
  }, 120_000);

  it("exists flips ABSENT -> EXISTS -> ABSENT across a create/delete round trip on a throwaway $TMP transaction", async () => {
    assertUsable();

    expect(await classicExists("transaction", TCODE)).toBe("ABSENT");

    const created = await createTransaction(conn, GATE, {
      tcode: TCODE,
      program: PROGRAM,
      description: "S3 classic live round trip",
      packageName: "$TMP",
    });
    // arm cleanup before asserting: the transaction may already exist server-side once the call returns
    tcodeCreated = true;
    expect(created.transcript.tags).toEqual(["TRAN-CREATED"]);

    expect(await classicExists("transaction", TCODE)).toBe("EXISTS");

    const deleted = await deleteTransactionViaBridge(conn, GATE, {
      tcode: TCODE,
      packageName: currentServerPackage("$TMP"),
    });
    expect(deleted.transcript.tags).toEqual(["TRAN-DELETED", "TRAN-GONE"]);
    tcodeCreated = false;

    expect(await classicExists("transaction", TCODE)).toBe("ABSENT");
  }, 180_000);

  it("exists flips ABSENT -> EXISTS -> ABSENT across a create/delete round trip on a full-30-char $TMP view (TK103 pin)", async () => {
    assertUsable();
    expect(VIEW_NAME.length).toBe(30);

    expect(await classicExists("view", VIEW_NAME)).toBe("ABSENT");

    const created = await createClassicView(conn, GATE, {
      viewName: VIEW_NAME,
      baseTable: VIEW_BASE_TABLE,
      fields: [...VIEW_FIELDS],
      description: "S11 classic live round trip",
      packageName: "$TMP",
    });
    // arm cleanup before asserting: the view may already exist server-side once the call returns
    viewCreated = true;
    expect(created.transcript.tags).toEqual(["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"]);

    expect(await classicExists("view", VIEW_NAME)).toBe("EXISTS");

    const deleteConn = freshConn();
    await deleteConn.connect();
    try {
      const deleted = await deleteClassicViewViaBridge(deleteConn, GATE, {
        viewName: VIEW_NAME,
        packageName: currentServerPackage("$TMP"),
      });
      expect(deleted.transcript.tags).toEqual(["VIEW-DELETED", "VIEW-GONE"]);
    } finally {
      await deleteConn.shutdown("test-end");
    }
    viewCreated = false;

    expect(await classicExists("view", VIEW_NAME)).toBe("ABSENT");
  }, 180_000);
});
