/**
 * `src/debug/arm-lock.ts` — the cross-process guard on the ONE debugger slot a
 * SAP system+client+user has.
 *
 * Like test/pool-cross-process-object-gate.test.ts and unlike the rest of the
 * debug suites, this file is deliberately NOT offline-with-fakes at the
 * filesystem layer: the entire point of `FileLockDebugArmLock` is a real
 * `withFileLock` over a real directory, so a doubled filesystem would prove
 * nothing about the one property that matters — that two independent
 * instances (standing in for two abapsmith PROCESSES) sharing one state dir
 * actually contend on disk. Every test uses a real `mkdtempSync` state dir,
 * removed in `afterEach`. It is still entirely offline as far as SAP is
 * concerned: nothing here opens a socket.
 *
 * `waitMs` is passed explicitly and short (100-300 ms) wherever a lock is
 * meant to be contended, so a failing test fails in well under a second
 * rather than at `ABAP_DEBUG_LOCK_WAIT_MS`'s 1500 ms default.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { AbapError, isAbapError } from "../src/adt/errors.js";
import {
  createDebugArmLock,
  debugArmLockKey,
  debugArmLockPath,
  FileLockDebugArmLock,
  NoopDebugArmLock,
  resolveCrossProcessDebugLock,
  resolveDebugLockWaitMs,
} from "../src/debug/arm-lock.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CFG = { url: "https://a4h.example:44300", client: "001", user: "DEVELOPER" };

const tmpDirs: string[] = [];
function mkStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "abapsmith-debug-arm-lock-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

/** Real fs I/O, so microtask draining does not apply — poll instead. */
async function waitUntil(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * `DebugArmLock.release()` is void-returning on purpose (it lives in
 * `doTerminate()`'s `finally`), so the unlink lands a tick or two later. Tests
 * that care about the FILE, rather than about the in-process ref count, wait
 * for it rather than asserting synchronously.
 */
function gone(lockPath: string): Promise<void> {
  return waitUntil(() => !existsSync(lockPath), `${lockPath} to be unlinked`);
}

/**
 * A pid that is certainly not running here, for the stale-lock tests. Probed
 * upward over a bounded range so a machine with every one of them occupied
 * skips the test rather than asserting against a live process. Mirrors
 * test/pool-cross-process-object-gate.test.ts and
 * test/journal-concurrency.test.ts.
 */
function findDeadPid(): number | undefined {
  for (let p = 30_000; p < 40_000; p++) {
    try {
      process.kill(p, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return p;
    }
  }
  return undefined;
}
const DEAD_PID = findDeadPid();

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

// ---------------------------------------------------------------------------
// a. Key and path derivation
// ---------------------------------------------------------------------------

describe("key and path derivation", () => {
  it("keys on url|client|USER, upper-casing the SAP user", () => {
    expect(debugArmLockKey(CFG)).toBe("https://a4h.example:44300|001|DEVELOPER");
    // SAP user names are case-insensitive and ADT accepts either spelling, so
    // two casings are ONE debugger slot and must not become two locks.
    expect(debugArmLockKey({ ...CFG, user: "developer" })).toBe(debugArmLockKey(CFG));
    expect(debugArmLockPath("/s", { ...CFG, user: "developer" })).toBe(debugArmLockPath("/s", CFG));
  });

  it("separates different users, clients and systems", () => {
    const p = debugArmLockPath("/s", CFG);
    expect(debugArmLockPath("/s", { ...CFG, user: "OTHER" })).not.toBe(p);
    expect(debugArmLockPath("/s", { ...CFG, client: "002" })).not.toBe(p);
    expect(debugArmLockPath("/s", { ...CFG, url: "https://other.example:44300" })).not.toBe(p);
  });

  it("lives in locks/debug, a sibling of the object-lock namespace, under a hashed name", () => {
    const p = debugArmLockPath("/state", CFG);
    expect(p.startsWith(join("/state", "locks", "debug"))).toBe(true);
    // Hashed, not the raw key: the key contains a URL, which is not a legal
    // filename component.
    expect(p).not.toContain("a4h.example");
    expect(p).toMatch(/[0-9a-f]{20}\.lock$/);
  });

  it("treats a missing client the same as an empty one, and trims", () => {
    expect(debugArmLockKey({ url: "u", user: "U" })).toBe("u||U");
    expect(debugArmLockKey({ url: " u ", client: " ", user: " u " })).toBe("u||U");
  });
});

// ---------------------------------------------------------------------------
// b. Settings
// ---------------------------------------------------------------------------

describe("settings", () => {
  it("defaults the wait budget to 1500 ms and rejects out-of-range values back to it", () => {
    expect(resolveDebugLockWaitMs({})).toBe(1_500);
    expect(resolveDebugLockWaitMs({ ABAP_DEBUG_LOCK_WAIT_MS: "" })).toBe(1_500);
    expect(resolveDebugLockWaitMs({ ABAP_DEBUG_LOCK_WAIT_MS: "400" })).toBe(400);
    // Out of range falls BACK to the default rather than clamping: a clamp
    // would look like the setting took effect when it did not.
    expect(resolveDebugLockWaitMs({ ABAP_DEBUG_LOCK_WAIT_MS: "1" })).toBe(1_500);
    expect(resolveDebugLockWaitMs({ ABAP_DEBUG_LOCK_WAIT_MS: "999999" })).toBe(1_500);
    expect(resolveDebugLockWaitMs({ ABAP_DEBUG_LOCK_WAIT_MS: "nonsense" })).toBe(1_500);
  });

  it("is ON unless explicitly opted out", () => {
    expect(resolveCrossProcessDebugLock({})).toBe(true);
    expect(resolveCrossProcessDebugLock({ ABAP_CROSS_PROCESS_DEBUG_LOCK: "" })).toBe(true);
    expect(resolveCrossProcessDebugLock({ ABAP_CROSS_PROCESS_DEBUG_LOCK: "true" })).toBe(true);
    for (const v of ["false", "0", "no", "OFF"]) {
      expect(resolveCrossProcessDebugLock({ ABAP_CROSS_PROCESS_DEBUG_LOCK: v })).toBe(false);
    }
  });

  it("is its own switch — ABAP_CROSS_PROCESS_OBJECT_LOCK must not disable it", () => {
    // Turning off same-object WRITE serialisation must not silently turn off
    // debugger exclusion. This is one of the reasons the debug lock is a
    // sibling abstraction rather than ObjectGate with a synthetic key.
    withEnv("ABAP_CROSS_PROCESS_OBJECT_LOCK", "false", () => {
      expect(resolveCrossProcessDebugLock(process.env)).toBe(true);
      expect(createDebugArmLock({ stateDir: "/s", cfg: CFG })).toBeInstanceOf(FileLockDebugArmLock);
    });
  });

  it("createDebugArmLock honours the opt-out", () => {
    expect(createDebugArmLock({ stateDir: "/s", cfg: CFG, env: {} })).toBeInstanceOf(FileLockDebugArmLock);
    expect(
      createDebugArmLock({ stateDir: "/s", cfg: CFG, env: { ABAP_CROSS_PROCESS_DEBUG_LOCK: "false" } }),
    ).toBeInstanceOf(NoopDebugArmLock);
  });
});

// ---------------------------------------------------------------------------
// c. Cross-process refusal
// ---------------------------------------------------------------------------

describe("cross-process refusal", () => {
  it("refuses a second instance with DEBUG_SESSION_LOCKED_CROSS_PROCESS naming the holder", async () => {
    const stateDir = mkStateDir();
    // Two instances, standing in for two separate abapsmith PROCESSES sharing
    // one state dir — the scenario the in-process `DEBUG_CONCURRENCY = 1`
    // lease cannot see at all, which is the whole reason this lock exists.
    const a = new FileLockDebugArmLock({ stateDir, cfg: CFG, waitMs: 200 });
    const b = new FileLockDebugArmLock({ stateDir, cfg: CFG, waitMs: 200 });

    await a.acquire();
    expect(existsSync(debugArmLockPath(stateDir, CFG))).toBe(true);

    const err: unknown = await b.acquire().catch((e: unknown) => e);
    expect(isAbapError(err)).toBe(true);
    const abapErr = err as AbapError;
    expect(abapErr.code).toBe("DEBUG_SESSION_LOCKED_CROSS_PROCESS");
    expect(b.held).toBe(false);

    // Both "processes" are really this one, so the holder IS this pid and
    // hostname — proving the holder record round-trips into the error rather
    // than merely that SOME error was thrown. The issue asks specifically for
    // pid, hostname and timestamp.
    const holder = abapErr.details.holder as { pid: number; hostname: string; startedAt: string } | undefined;
    expect(holder?.pid).toBe(process.pid);
    expect(holder?.hostname).toBe(os.hostname());
    expect(Number.isNaN(Date.parse(holder!.startedAt))).toBe(false);
    expect(abapErr.message).toContain(`pid ${process.pid}`);
    expect(abapErr.message).toContain(os.hostname());
    expect(abapErr.message).toContain(holder!.startedAt);
    // The remediation must talk about stopping the other DEBUG session, not
    // about a possibly-inconsistent ABAP object (OBJECT_LOCKED_CROSS_PROCESS's
    // wording, which is wrong here).
    expect(abapErr.hint).toContain("abap_debug");

    // And the slot is handed back cleanly once the first holder releases.
    a.release();
    await gone(debugArmLockPath(stateDir, CFG));
    await expect(b.acquire()).resolves.toBeUndefined();
    b.release();
    await gone(debugArmLockPath(stateDir, CFG));
  });

  it("fails fast rather than queueing", async () => {
    const stateDir = mkStateDir();
    const a = new FileLockDebugArmLock({ stateDir, cfg: CFG, waitMs: 200 });
    const b = new FileLockDebugArmLock({ stateDir, cfg: CFG, waitMs: 200 });
    await a.acquire();

    const started = Date.now();
    await b.acquire().catch(() => undefined);
    const elapsed = Date.now() - started;
    // A real debug hold lasts as long as someone keeps stepping, so waiting is
    // hopeless, not merely slow: the budget must be honoured and the call must
    // return, not queue. Generous upper bound — this asserts "bounded by
    // waitMs", not a precise duration.
    expect(elapsed).toBeLessThan(3_000);
    a.release();
    await gone(debugArmLockPath(stateDir, CFG));
  });

  it("does not make different users, clients or systems contend", async () => {
    const stateDir = mkStateDir();
    const mine = new FileLockDebugArmLock({ stateDir, cfg: CFG, waitMs: 200 });
    await mine.acquire();

    for (const other of [
      { ...CFG, user: "SOMEONE_ELSE" },
      { ...CFG, client: "002" },
      { ...CFG, url: "https://other.example:44300" },
    ]) {
      const lock = new FileLockDebugArmLock({ stateDir, cfg: other, waitMs: 200 });
      await expect(lock.acquire(), JSON.stringify(other)).resolves.toBeUndefined();
      lock.release();
      await gone(debugArmLockPath(stateDir, other));
    }
    mine.release();
    await gone(debugArmLockPath(stateDir, CFG));
  });
});

// ---------------------------------------------------------------------------
// d. In-process sharing
// ---------------------------------------------------------------------------

describe("one shared instance per process", () => {
  it("ref-counts, so a second in-process holder cannot free the slot under the first", async () => {
    const stateDir = mkStateDir();
    const shared = new FileLockDebugArmLock({ stateDir, cfg: CFG, waitMs: 200 });
    const lockPath = debugArmLockPath(stateDir, CFG);

    // The real second holder is the `releaseOrphanDebuggee` probe session,
    // which arms a listener of its own at the same identity while a session
    // may already hold the slot. It must not deadlock against itself...
    await shared.acquire();
    await shared.acquire();
    expect(existsSync(lockPath)).toBe(true);

    // ...and must not release the file out from under the first holder.
    shared.release();
    expect(existsSync(lockPath)).toBe(true);
    expect(shared.held).toBe(true);

    shared.release();
    expect(shared.held).toBe(false);
    await gone(lockPath);

    // Idempotent: releasing what is not held is a no-op, not a throw.
    expect(() => shared.release()).not.toThrow();
  });

  it("joins a concurrent in-process acquisition instead of racing it into EEXIST", async () => {
    const stateDir = mkStateDir();
    const shared = new FileLockDebugArmLock({ stateDir, cfg: CFG, waitMs: 200 });
    await Promise.all([shared.acquire(), shared.acquire(), shared.acquire()]);
    expect(shared.held).toBe(true);
    shared.release();
    shared.release();
    expect(existsSync(debugArmLockPath(stateDir, CFG))).toBe(true);
    shared.release();
    await gone(debugArmLockPath(stateDir, CFG));
  });
});

// ---------------------------------------------------------------------------
// e. Stale-lock recovery — a dead debug session must not brick debugging
// ---------------------------------------------------------------------------

describe("stale-lock recovery", () => {
  it.skipIf(DEAD_PID === undefined)(
    "recovers a lock left by a dead pid on this host once it ages past 2*waitMs",
    async () => {
      const stateDir = mkStateDir();
      const waitMs = 100;
      const lockPath = debugArmLockPath(stateDir, CFG);
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: DEAD_PID,
          hostname: os.hostname(),
          startedAt: new Date(Date.now() - 10_000).toISOString(),
        }),
        "utf8",
      );
      // Aged past `2 * waitMs` (state-dir.ts's `breakIfStale`) so the liveness
      // check is consulted at all, and nowhere near the one-hour hard-stale
      // valve — what breaks this lock must be the dead-pid rule, nothing else.
      const aged = new Date(Date.now() - (2 * waitMs + 500));
      utimesSync(lockPath, aged, aged);

      const lock = new FileLockDebugArmLock({ stateDir, cfg: CFG, waitMs });
      await expect(lock.acquire()).resolves.toBeUndefined();
      lock.release();
      await gone(lockPath);
    },
  );

  /**
   * The other side of the same valve. `withFileLock`'s DEFAULT hard-stale
   * window is `max(10 × waitMs, 60_000)` — derived from how long a CONTENDER
   * waits, then used to decide when a HOLDER is abandoned. At a 1500 ms budget
   * that is 60 s, which is far shorter than an ordinary debug session: a human
   * stepping through code for two minutes would have had their debugger slot
   * stolen and a second process would have armed against their live listener.
   * `FileLockDebugArmLock` passes `DEBUG_ARM_LOCK_HARD_STALE_MS` (1 h)
   * explicitly. Fails without that by resolving instead of rejecting.
   */
  it("does not break a 5-minute-old lock whose holder is still alive", async () => {
    const stateDir = mkStateDir();
    const waitMs = 100;
    const lockPath = debugArmLockPath(stateDir, CFG);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        startedAt: new Date(Date.now() - 300_000).toISOString(),
      }),
      "utf8",
    );
    const aged = new Date(Date.now() - 300_000);
    utimesSync(lockPath, aged, aged);

    const lock = new FileLockDebugArmLock({ stateDir, cfg: CFG, waitMs });
    const err = await lock.acquire().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isAbapError(err)).toBe(true);
    expect((err as AbapError).code).toBe("DEBUG_SESSION_LOCKED_CROSS_PROCESS");
    // The holder's file is left exactly as it was — not stolen, not rewritten.
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
  });

  it("breaks a lock older than the hard-stale valve even when the pid looks alive", async () => {
    const stateDir = mkStateDir();
    const waitMs = 100;
    const lockPath = debugArmLockPath(stateDir, CFG);
    mkdirSync(dirname(lockPath), { recursive: true });
    // `process.pid` on this host: the dead-pid rule can NEVER fire for it, so
    // the hard-stale valve is the only thing that can break this lock. That
    // valve is what stops a pid-reuse or foreign-hostname holder record from
    // bricking debugging permanently.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() }),
      "utf8",
    );
    const aged = new Date(Date.now() - 3_600_001);
    utimesSync(lockPath, aged, aged);

    const lock = new FileLockDebugArmLock({ stateDir, cfg: CFG, waitMs });
    await expect(lock.acquire()).resolves.toBeUndefined();
    lock.release();
    await gone(lockPath);
  });
});

// ---------------------------------------------------------------------------
// f. GENUINE cross-process: a crashed debug session must not brick debugging
// ---------------------------------------------------------------------------

/**
 * The one thing two instances in one process cannot simulate: a lock file
 * naming a pid that is REALLY gone. Everything above shares `process.pid`, so
 * the dead-pid rule can never fire for it.
 *
 * A real child takes the lock exactly the way `withFileLock` does — `open(…,
 * "wx")` plus the holder record — and exits without releasing, which is
 * precisely what a killed MCP server mid-debug-session leaves behind.
 * `node:fs` only, no TS loader and no build step, so this cannot go stale
 * against the source tree.
 */
const CHILD_TAKES_LOCK = `
import { mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
mkdirSync(dirname(process.env.LOCK_PATH), { recursive: true });
const fd = openSync(process.env.LOCK_PATH, "wx");
writeSync(fd, JSON.stringify({
  pid: process.pid,
  hostname: hostname(),
  startedAt: new Date().toISOString(),
}));
closeSync(fd);
`;

describe("a crashed debug session cannot brick debugging for everyone", () => {
  it("takes over a lock abandoned by a real child process that exited without releasing", async () => {
    const stateDir = mkStateDir();
    const lockPath = debugArmLockPath(stateDir, CFG);

    await execFileAsync(process.execPath, ["--input-type=module", "-e", CHILD_TAKES_LOCK], {
      env: { ...process.env, LOCK_PATH: lockPath },
    });

    // The child really did hold it, and really is gone.
    expect(existsSync(lockPath)).toBe(true);
    const holder = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; hostname: string };
    expect(holder.pid).not.toBe(process.pid);
    expect(holder.hostname).toBe(os.hostname());
    expect(() => process.kill(holder.pid, 0)).toThrowError(/ESRCH|kill ESRCH/);

    // While the record still looks fresh, the slot is (correctly) refused: a
    // process that armed a listener a moment ago may simply be slow.
    //
    // Freshness is re-stamped here rather than inherited from the child's
    // exit, and `waitMs` is large, because the "fresh" window is `2 * waitMs`
    // wide — under a loaded full-suite run the spawn alone can eat a small
    // one, and the test would then observe a legitimate takeover where it
    // asserts a refusal.
    const now = new Date();
    utimesSync(lockPath, now, now);
    const lock = new FileLockDebugArmLock({ stateDir, cfg: CFG, waitMs: 1_500 });
    const refused = await lock.acquire().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((refused as AbapError | undefined)?.code).toBe("DEBUG_SESSION_LOCKED_CROSS_PROCESS");

    // Aged past `2 * waitMs` so the liveness rule is consulted, and nowhere
    // near the one-hour valve: what recovers the slot here is the dead-pid
    // test on a genuinely foreign pid and nothing else.
    const aged = new Date(Date.now() - 4_000);
    utimesSync(lockPath, aged, aged);

    await expect(lock.acquire()).resolves.toBeUndefined();
    lock.release();
    await gone(lockPath);
  });
});
