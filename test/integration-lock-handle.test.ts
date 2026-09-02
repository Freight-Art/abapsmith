/**
 * LIVE test for invariant 1 — a lock handle abap_write hands out must
 * still be valid when abap_write uses it. The competitor MCP server's
 * dominant live failure was `ExceptionResourceInvalidLockHandle` (423): its
 * own LOCK returned a handle and the very next write with THAT SAME HANDLE
 * was rejected. This pins that this server does not do that — including
 * when an unrelated read runs between LOCK and PUT, "where session state
 * most plausibly gets clobbered".
 *
 * There is no lock/unlock TOOL by policy (doc/SAFETY/data-access-and-credentials.md) — locking is
 * internal to abap_write — so this calls `StatefulSession.lock`/`unlock`
 * and `AbapConnection.put` directly, mirroring `putContent` in
 * src/adt/write.ts. GATING matches test/integration-class-includes.test.ts:
 * VITEST_LIVE=1 AND ABAP_URL AND write access configured
 * (`ABAP_MODE=edit`/`admin`, or legacy `ABAP_ALLOW_WRITE=true` — see
 * `test/helpers/live-write-gate.ts`), belt-and-braces with the
 * `LIVE_INTEGRATION_TESTS` entry in vitest.config.ts.
 *
 * BUDGET. One object, `ZMCP_LOCKH_LIVE` (PROG/P) in `$TMP`, ~20 requests:
 * create (~5), same-handle test (lock+PUT+unlock+reread, 4), interleaved-read
 * test (lock+read+PUT+unlock+reread, 5), delete (~5).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { loadConfig, loadEnvFile, type Config } from "../src/config.js";
import { abapWrite } from "../src/tools/write.js";
import { translateAdtError, type LockInfo } from "../src/adt/session.js";
import { SafetyGate } from "../src/safety.js";
import { liveWriteConfigured } from "./helpers/live-write-gate.js";

loadEnvFile();

const liveEnabled = process.env.VITEST_LIVE === "1";
const haveUrl = Boolean(process.env.ABAP_URL);
const allowWrite = liveWriteConfigured();
const d = liveEnabled && haveUrl && allowWrite ? describe : describe.skip;

const NAME = "ZMCP_LOCKH_LIVE";
const URI = "/sap/bc/adt/programs/programs/zmcp_lockh_live";
const SOURCE_URI = `${URI}/source/main`;
const CONTENT_TYPE = "text/plain; charset=utf-8";
const MAX = 60_000;

const V0 = "REPORT zmcp_lockh_live.\nWRITE: / 'v0'.\n";
const V1 = "REPORT zmcp_lockh_live.\nWRITE: / 'v1 same-handle write'.\n";
const V2 = "REPORT zmcp_lockh_live.\nWRITE: / 'v2 interleaved-read write'.\n";

/** Exactly one object, in exactly one package. Nothing wider. */
const GATE = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"], allowNamePrefixes: ["ZMCP_"] });

let conn: AbapConnection;
let cfg: Config;

/** Aborts a test rather than spending another logon after the breaker tripped. */
const assertUsable = (): void => {
  if (conn.breaker.isTripped) {
    throw new Error(`circuit breaker tripped: ${conn.breaker.info?.message}`);
  }
};

/**
 * PUTs `source` with `handle` exactly as `putContent` (src/adt/write.ts)
 * shapes the request, and fails with a message naming the invalid-lock-handle
 * failure mode by name if that — and only that — is what happened.
 */
async function putWithHandle(handle: string, source: string): Promise<void> {
  try {
    await conn.put(SOURCE_URI, {
      body: source,
      headers: { "Content-Type": CONTENT_TYPE },
      qs: { lockHandle: handle },
    });
  } catch (e) {
    const translated = translateAdtError(e, { operation: "write", uri: URI });
    if (translated.details.reason === "INVALID_LOCK_HANDLE") {
      throw new Error(
        `REGRESSION: PUT was rejected as an invalid lock handle (423 ` +
          `ExceptionResourceInvalidLockHandle) using the SAME handle its own LOCK just returned. ` +
          `${translated.message}`,
      );
    }
    throw translated;
  }
}

d("live: a lock handle abap_write hands out is still valid when abap_write uses it", () => {
  beforeAll(async () => {
    cfg = loadConfig();
    conn = new AbapConnection(cfg, { log: () => {}, breaker: new AuthCircuitBreaker() });
    await conn.connect();
    const res = await abapWrite(
      conn,
      { object: NAME, type: "PROG/P", source: V0, package: "$TMP", description: "lock-handle probe" } as never,
      MAX,
      GATE,
    );
    expect(res.text).toMatch(/created|updated/i);
  }, 90_000);

  /** UNCONDITIONAL, and swallows its own failure — see integration-class-includes.test.ts. */
  afterAll(async () => {
    if (!conn) return;
    try {
      await abapWrite(conn, { object: NAME, type: "PROG/P", mode: "delete", confirm: NAME } as never, MAX, GATE);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[lock-handle live] could not delete ${NAME} — it may be left behind in $TMP on a SHARED ` +
          `appliance. Remove it by hand (SE80) if so. Cause: ${String(e)}`,
      );
    }
    await conn.shutdown("test-end");
  }, 90_000);

  it("PUTs with the exact handle its own LOCK just returned, and the write lands", async () => {
    assertUsable();
    await conn.withStatefulSession(async (session) => {
      const lock: LockInfo = await session.lock(URI);
      expect(lock.handle, "LOCK answered with no handle at all — nothing to PUT with").not.toBe("");
      await putWithHandle(lock.handle, V1);
      await session.unlock(URI);
    });
    // Outside the window: a PUT that answered 200 without persisting would
    // otherwise pass the assertion above vacuously.
    const back = await conn.get(SOURCE_URI, { headers: { Accept: "text/plain" } });
    expect(back.body, "the PUT answered success but the new source never landed").toContain(
      "v1 same-handle write",
    );
  }, 120_000);

  it("survives an unrelated read between LOCK and PUT, then PUTs with the same handle", async () => {
    assertUsable();
    await conn.withStatefulSession(async (session) => {
      const lock: LockInfo = await session.lock(URI);
      expect(lock.handle).not.toBe("");
      // Deadlock-safe by construction, not by luck: `conn.get` routes through
      // `acquireImplicit` (src/adt/session-lock.ts), which is re-entrant via
      // the ambient AsyncLocalStorage token this `withStatefulSession` window
      // already holds (I3) — it passes straight through instead of queueing
      // behind itself. `/sap/bc/adt/discovery` is the same endpoint
      // `refreshCsrfToken` uses: stable, cheap, always available, and has
      // nothing to do with this object's lock.
      await conn.get("/sap/bc/adt/discovery");
      await putWithHandle(lock.handle, V2);
      await session.unlock(URI);
    });
    const back = await conn.get(SOURCE_URI, { headers: { Accept: "text/plain" } });
    expect(
      back.body,
      "the PUT answered success but the new source never landed after an interleaved read",
    ).toContain("v2 interleaved-read write");
  }, 120_000);
});
