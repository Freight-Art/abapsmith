/**
 * The shared state directory and the cross-process file lock —
 * "A real cross-process lock".
 *
 * WHY THIS FILE MATTERS
 * ----------------------
 * `withFileLock`/`withFileLockSync` are the ONLY thing standing between four
 * MCP server processes and the corruption catalogued at src/state-dir.ts:8-30
 * (lost appends, a fixed prune tmp-path colliding across processes, a live
 * before-image swept as an orphan, N terminals racing an SAP account lock).
 * The orchestrating requirement is stated at src/state-dir.ts:298-299: **a
 * crashed process must never be able to deadlock the journal.** That is not
 * one property, it is three, and each has its own failure mode if the lock
 * gets it wrong:
 *
 *  - too eager to break a lock  -> two processes both believe they hold it,
 *    and the mutual-exclusion guarantee the whole module exists for is gone;
 *  - too reluctant to break a lock  -> a crashed holder wedges the journal
 *    forever, which is the exact defect this module was written to remove;
 *  - a timeout that does not actually happen  -> an MCP tool call hangs
 *    indefinitely instead of surfacing `JOURNAL_IO`.
 *
 * The suite below pins the config resolvers, then walks the lock state
 * machine from the safe end (mutual exclusion, clean release, error
 * propagation) to the sharp end (dead-pid stale-break vs. live-pid
 * no-break vs. the hard-stale safety valve), and finally proves the
 * headline claim against a REAL crashed process rather than a simulation of
 * one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { AbapError } from "../src/adt/errors.js";
import {
  resolveStateDir,
  resolveLockWaitMs,
  withFileLock,
  withFileLockSync,
  atomicWriteFileSync,
  hardenFileModeSync,
} from "../src/state-dir.js";

/** Lowest 3 octal digits of a file's mode — the part `chmod`/`{ mode }` control. */
const permBits = (p: string): number => statSync(p).mode & 0o777;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "abapsmith-state-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface LockHolderShape {
  pid: number;
  hostname: string;
  startedAt: string;
  nonce?: string;
}

const readHolder = async (lockPath: string): Promise<LockHolderShape> =>
  JSON.parse(await fs.readFile(lockPath, "utf8")) as LockHolderShape;

/**
 * Writes a holder record in the PRE-NONCE shape — `{pid, hostname, startedAt}`
 * and nothing else. That omission is deliberate and load-bearing, not laziness:
 * every stale-break test below therefore also proves that a lock file written
 * by a version that predates the release nonce still parses as a holder and
 * stays breakable by the dead-pid rule. `parseHolder` must keep treating a
 * missing `nonce` the way it treats a missing `startedAt`.
 */
const writeHolder = async (
  lockPath: string,
  holder: { pid: number; hostname: string },
): Promise<void> => {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(
    lockPath,
    JSON.stringify({ pid: holder.pid, hostname: holder.hostname, startedAt: new Date().toISOString() }),
    "utf8",
  );
};

/**
 * The DEFAULT hard-stale formula, copied from `defaultHardStaleMs` in
 * src/state-dir.ts, NOT imported — it is not exported, and re-deriving it here
 * is the point: a test that hardcoded "60000" would silently stop meaning
 * anything the day the constant changes.
 */
const hardStaleMs = (waitMs: number): number => Math.max(10 * waitMs, 60_000);

/**
 * A `now` that runs `aheadMs` in front of the real clock. Staleness is
 * `now() - mtimeMs`, so a lock file written a moment ago reads as `aheadMs`
 * old — no `utimes`, no real sleep. Real time still advances underneath it, so
 * the wait budget (`deadline = now() + waitMs`) expires exactly as it would in
 * production; a frozen clock would loop forever instead of timing out.
 */
const clockAhead = (aheadMs: number): (() => number) => () => Date.now() + aheadMs;

/** Collects everything written to stderr for the duration of `body`. */
const captureStderr = async (body: () => Promise<void> | void): Promise<string> => {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write);
  try {
    await body();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
};

/** What a lock file looks like once ANOTHER process has broken ours and taken
 * its own. Byte-for-byte comparable, so a test can prove it survived untouched. */
const breakerPayload = (): string =>
  JSON.stringify({
    pid: 999_999,
    hostname: "some-other-host",
    startedAt: new Date().toISOString(),
    nonce: "ffffffffffffffffffffffff",
  });

/** Backdate a file's mtime by `ageMs`, so staleness checks see it as old
 * without a real sleep. */
const backdate = async (filePath: string, ageMs: number): Promise<void> => {
  const past = new Date(Date.now() - ageMs);
  await fs.utimes(filePath, past, past);
};

// ---------------------------------------------------------------------------
// resolveStateDir
// ---------------------------------------------------------------------------

describe("resolveStateDir", () => {
  it("defaults to <cwd>/.abapsmith", () => {
    expect(resolveStateDir({}, "/work")).toBe(path.resolve("/work", ".abapsmith"));
  });

  it("an absolute ABAP_STATE_DIR wins outright", () => {
    expect(resolveStateDir({ ABAP_STATE_DIR: "/var/abap-state" }, "/work")).toBe(
      path.resolve("/var/abap-state"),
    );
  });

  it("a relative ABAP_STATE_DIR resolves against the given cwd", () => {
    expect(resolveStateDir({ ABAP_STATE_DIR: "shared-state" }, "/work")).toBe(
      path.resolve("/work", "shared-state"),
    );
    expect(resolveStateDir({ ABAP_STATE_DIR: "../sibling-state" }, "/work/child")).toBe(
      path.resolve("/work/child", "../sibling-state"),
    );
  });

  it("a whitespace-only ABAP_STATE_DIR falls back to the default, not to a garbage path", () => {
    expect(resolveStateDir({ ABAP_STATE_DIR: "   " }, "/work")).toBe(path.resolve("/work", ".abapsmith"));
    expect(resolveStateDir({ ABAP_STATE_DIR: "\t\n" }, "/work")).toBe(path.resolve("/work", ".abapsmith"));
  });
});

// ---------------------------------------------------------------------------
// resolveLockWaitMs
// ---------------------------------------------------------------------------

describe("resolveLockWaitMs", () => {
  it("defaults to 5000 when unset", () => {
    expect(resolveLockWaitMs({})).toBe(5_000);
  });

  it("a valid in-range integer wins", () => {
    expect(resolveLockWaitMs({ ABAP_LOCK_WAIT_MS: "2500" })).toBe(2_500);
    expect(resolveLockWaitMs({ ABAP_LOCK_WAIT_MS: "100" })).toBe(100); // the floor, inclusive
    expect(resolveLockWaitMs({ ABAP_LOCK_WAIT_MS: "120000" })).toBe(120_000); // the ceiling, inclusive
  });

  it("non-numeric junk falls back to 5000, per intFromEnv's forgiving contract", () => {
    expect(resolveLockWaitMs({ ABAP_LOCK_WAIT_MS: "banana" })).toBe(5_000);
  });

  it("a negative value falls back to 5000 (intFromEnv rejects n < 0)", () => {
    expect(resolveLockWaitMs({ ABAP_LOCK_WAIT_MS: "-100" })).toBe(5_000);
  });

  it("zero falls back to 5000 — it parses fine but is below MIN_LOCK_WAIT_MS (100)", () => {
    expect(resolveLockWaitMs({ ABAP_LOCK_WAIT_MS: "0" })).toBe(5_000);
  });

  it("out-of-range values are NOT clamped to the nearest bound — they fall back whole", () => {
    // src/state-dir.ts:179-183: clamping would quietly honour half of a wrong
    // instruction. 99 is one below the floor; 120001 is one above the ceiling.
    expect(resolveLockWaitMs({ ABAP_LOCK_WAIT_MS: "99" })).toBe(5_000);
    expect(resolveLockWaitMs({ ABAP_LOCK_WAIT_MS: "120001" })).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// withFileLock (async) — the journal's path
// ---------------------------------------------------------------------------

describe("withFileLock", () => {
  it("runs fn and returns its value; the lock file does not exist afterwards", async () => {
    const lockPath = path.join(tmp, "test.lock");
    const result = await withFileLock(lockPath, async () => 42);
    expect(result).toBe(42);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("the lock file exists while fn runs, and holds {pid, hostname, startedAt}", async () => {
    const lockPath = path.join(tmp, "test.lock");
    let seenDuring: LockHolderShape | undefined;
    await withFileLock(lockPath, async () => {
      expect(existsSync(lockPath)).toBe(true);
      seenDuring = await readHolder(lockPath);
    });
    expect(seenDuring).toBeDefined();
    expect(seenDuring!.pid).toBe(process.pid);
    expect(seenDuring!.hostname).toBe(os.hostname());
    expect(typeof seenDuring!.startedAt).toBe("string");
  });

  it("releases when fn throws, and the original error propagates unchanged", async () => {
    const lockPath = path.join(tmp, "test.lock");
    const marker = new Error("boom from fn");
    let caught: unknown;
    try {
      await withFileLock(lockPath, async () => {
        throw marker;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(marker); // identity, not just message equality
    expect(existsSync(lockPath)).toBe(false);
  });

  it("mkdirs a missing parent directory", async () => {
    const lockPath = path.join(tmp, "a", "b", "c", "test.lock");
    expect(existsSync(path.join(tmp, "a"))).toBe(false);
    await withFileLock(lockPath, async () => undefined);
    expect(existsSync(path.join(tmp, "a", "b", "c"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "FIX 2: creates the lock file with mode 0600, not the process umask",
    async () => {
      const lockPath = path.join(tmp, "test.lock");
      let modeDuring: number | undefined;
      await withFileLock(lockPath, async () => {
        modeDuring = permBits(lockPath);
      });
      expect(modeDuring).toBe(0o600);
    },
  );

  it("MUTUAL EXCLUSION: two concurrent callers never run their critical sections interleaved", async () => {
    const lockPath = path.join(tmp, "test.lock");
    const order: string[] = [];

    const run = (label: string): Promise<void> =>
      withFileLock(lockPath, async () => {
        order.push(`${label}-in`);
        await sleep(30); // a real await in the middle — the interleave window
        order.push(`${label}-out`);
      });

    await Promise.all([run("a"), run("b")]);

    // Whichever caller wins the race to acquire first, its "-in"/"-out" pair
    // must be contiguous: no other caller's "-in" may land between them.
    expect(order).toHaveLength(4);
    expect(order[0]!.endsWith("-in")).toBe(true);
    expect(order[1]).toBe(order[0]!.replace("-in", "-out"));
    expect(order[2]!.endsWith("-in")).toBe(true);
    expect(order[3]).toBe(order[2]!.replace("-in", "-out"));
    expect(order[0]!.charAt(0)).not.toBe(order[2]!.charAt(0)); // the two labels differ
  });

  it("TIMEOUT: rejects with JOURNAL_IO, naming the lock path and ABAP_LOCK_WAIT_MS, when a fresh live lock is never released", async () => {
    const lockPath = path.join(tmp, "test.lock");
    // A holder naming THIS process, freshly written — not stale by any rule.
    await writeHolder(lockPath, { pid: process.pid, hostname: os.hostname() });

    let caught: unknown;
    try {
      await withFileLock(lockPath, async () => undefined, { waitMs: 150 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AbapError);
    const err = caught as AbapError;
    expect(err.code).toBe("JOURNAL_IO");
    expect(err.message).toContain(lockPath);
    expect(err.hint).toContain("ABAP_LOCK_WAIT_MS");
  });

  it("STALE BREAK BY DEAD PID: a lock naming a certainly-dead pid on this host is broken and acquired", async () => {
    const deadPid = findDeadPid();
    if (deadPid === undefined) {
      // Bounded scan found no gap; do not fail the suite over host noise.
      return;
    }
    const lockPath = path.join(tmp, "test.lock");
    await writeHolder(lockPath, { pid: deadPid, hostname: os.hostname() });
    const waitMs = 200;
    // Older than 2*waitMs (the ownerIsGone check threshold) but well under
    // hardStaleMs(waitMs) — this must be broken by the DEAD-PID rule, not the
    // hard-stale valve, so the valve cannot be the thing quietly making this
    // test pass.
    await backdate(lockPath, 5 * waitMs);
    expect(5 * waitMs).toBeLessThan(hardStaleMs(waitMs));

    let ran = false;
    await withFileLock(
      lockPath,
      async () => {
        ran = true;
      },
      { waitMs },
    );
    expect(ran).toBe(true);
  });

  it("NO BREAK OF A LIVE PID: a lock naming THIS (alive) process is never stolen, even when stale-by-age", async () => {
    const lockPath = path.join(tmp, "test.lock");
    await writeHolder(lockPath, { pid: process.pid, hostname: os.hostname() });
    const waitMs = 200;
    // Stale-by-age (> 2*waitMs) but under the hard-stale valve — pins that
    // `ownerIsGone` (src/state-dir.ts:271-280) is what refuses here, not a
    // coincidental timeout before the age check would even matter.
    await backdate(lockPath, 5 * waitMs);
    expect(5 * waitMs).toBeGreaterThan(2 * waitMs);
    expect(5 * waitMs).toBeLessThan(hardStaleMs(waitMs));

    await expect(
      withFileLock(lockPath, async () => undefined, { waitMs }),
    ).rejects.toMatchObject({ code: "JOURNAL_IO" });
  });

  it("HARD-STALE VALVE: unparseable lock contents past the hard-stale threshold are broken regardless of holder", async () => {
    const lockPath = path.join(tmp, "test.lock");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "not valid json at all {{{", "utf8");
    const waitMs = 200;
    await backdate(lockPath, hardStaleMs(waitMs) + 5_000);

    let ran = false;
    await withFileLock(
      lockPath,
      async () => {
        ran = true;
      },
      { waitMs },
    );
    expect(ran).toBe(true);
  });

  it("HARD-STALE VALVE: a holder on a foreign hostname past the threshold is broken too, though ownerIsGone alone would refuse it", async () => {
    const lockPath = path.join(tmp, "test.lock");
    await writeHolder(lockPath, { pid: process.pid, hostname: "some-other-host" });
    const waitMs = 200;
    await backdate(lockPath, hardStaleMs(waitMs) + 5_000);

    let ran = false;
    await withFileLock(
      lockPath,
      async () => {
        ran = true;
      },
      { waitMs },
    );
    expect(ran).toBe(true);
  });

  it("REAL CROSS-PROCESS: a lock abandoned by a genuinely crashed child process is broken and the journal is not deadlocked", async () => {
    const lockPath = path.join(tmp, "test.lock");

    // The child creates the lock file itself (fs.openSync(p, "wx")), writes a
    // holder record naming ITS OWN pid, and exits WITHOUT releasing —
    // simulating a crash. A single `node -e` one-liner, no build step, no TS
    // loader: this repo has no other child-process idiom in its tests yet.
    const script =
      "const fs=require('node:fs');const os=require('node:os');" +
      "const p=process.argv[1];" +
      "const fd=fs.openSync(p,'wx');" +
      "fs.writeSync(fd,JSON.stringify({pid:process.pid,hostname:os.hostname(),startedAt:new Date().toISOString()}));" +
      "fs.closeSync(fd);";

    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", script, lockPath], { stdio: "ignore" });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`child exited with code ${code}`));
      });
    });

    expect(existsSync(lockPath)).toBe(true);
    const abandoned = await readHolder(lockPath);
    expect(abandoned.hostname).toBe(os.hostname());
    // A real pid, guaranteed dead by now: the child process has already exited.

    const waitMs = 200;
    await backdate(lockPath, hardStaleMs(waitMs) + 5_000);

    let ran = false;
    await withFileLock(
      lockPath,
      async () => {
        ran = true;
      },
      { waitMs },
    );
    expect(ran).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Release ownership — the nonce
// ---------------------------------------------------------------------------
//
// The defect these pin: the release used
// to `unlink(lockPath)` unconditionally. If a contender had already broken our
// lock as stale and taken its own, that unlink deleted a STRANGER'S lock file,
// and `unlinkQuietly` swallowed the `ENOENT` when the file was merely gone. So
// a two-way overlap silently became a three-way one, and nothing anywhere said
// a word: the gate's error path only fires on failure to ACQUIRE.

describe("withFileLock release ownership", () => {
  it("writes a nonce into the holder record, distinct per acquisition", async () => {
    const lockPath = path.join(tmp, "test.lock");
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      await withFileLock(lockPath, async () => {
        seen.push((await readHolder(lockPath)).nonce ?? "");
      });
    }
    expect(seen[0]).toMatch(/^[0-9a-f]{24}$/);
    expect(seen[1]).toMatch(/^[0-9a-f]{24}$/);
    expect(seen[0]).not.toBe(seen[1]); // per acquisition, not per process
  });

  it("BROKEN MID-FLIGHT: does not delete the breaker's lock file on release, and warns", async () => {
    const lockPath = path.join(tmp, "test.lock");
    const breaker = breakerPayload();

    const stderr = await captureStderr(async () => {
      await withFileLock(lockPath, async () => {
        // Exactly what a contender does when it judges our lock stale: unlink
        // ours, then create its own in the same place.
        await fs.unlink(lockPath);
        await fs.writeFile(lockPath, breaker, "utf8");
      });
    });

    // The breaker is still inside its critical section. Its lock file must
    // survive our release byte-for-byte, or a third process walks straight in.
    expect(existsSync(lockPath)).toBe(true);
    expect(await fs.readFile(lockPath, "utf8")).toBe(breaker);
    expect(stderr).toContain("was broken while we still held it");
    expect(stderr).toContain(lockPath);
    expect(stderr).toContain("999999"); // names the process that holds it now
  });

  it("BROKEN MID-FLIGHT: the same holds on the sync path", () => {
    const lockPath = path.join(tmp, "test.lock");
    const breaker = breakerPayload();

    let stderr = "";
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write);
    try {
      withFileLockSync(lockPath, () => {
        unlinkSync(lockPath);
        writeFileSync(lockPath, breaker, "utf8");
      });
    } finally {
      spy.mockRestore();
    }

    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(breaker);
    expect(stderr).toContain("was broken while we still held it");
  });

  it("BROKEN AND GONE: a lock file that simply vanished is reported, not silently swallowed", async () => {
    const lockPath = path.join(tmp, "test.lock");
    const stderr = await captureStderr(async () => {
      await withFileLock(lockPath, async () => {
        await fs.unlink(lockPath);
      });
    });
    // Used to be invisible: `unlinkQuietly` treated ENOENT as success.
    expect(stderr).toContain("was broken while we still held it");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("BROKEN MID-FLIGHT does not mask fn's own error", async () => {
    const lockPath = path.join(tmp, "test.lock");
    const marker = new Error("boom from fn");
    let caught: unknown;
    await captureStderr(async () => {
      try {
        await withFileLock(lockPath, async () => {
          await fs.unlink(lockPath);
          await fs.writeFile(lockPath, breakerPayload(), "utf8");
          throw marker;
        });
      } catch (e) {
        caught = e;
      }
    });
    expect(caught).toBe(marker);
    expect(existsSync(lockPath)).toBe(true); // still the breaker's
  });

  it("an ordinary release is silent — the warning means something really happened", async () => {
    const lockPath = path.join(tmp, "test.lock");
    const stderr = await captureStderr(async () => {
      await withFileLock(lockPath, async () => undefined);
      withFileLockSync(lockPath, () => undefined);
    });
    expect(stderr).toBe("");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("a pre-nonce holder record is still breakable by the dead-pid rule", async () => {
    // src/state-dir.ts's `parseHolder` must treat a missing `nonce` the way it
    // treats a missing `startedAt` — leniently. If it rejected the record, a
    // lock file written by a version shipped before the nonce would become
    // "unknown holder" and could only be broken by the (far slower) hard-stale
    // valve, which is a real regression in crash recovery.
    const deadPid = findDeadPid();
    if (deadPid === undefined) return; // bounded scan found no gap; host noise
    const lockPath = path.join(tmp, "test.lock");
    await writeHolder(lockPath, { pid: deadPid, hostname: os.hostname() }); // no nonce field
    const raw = JSON.parse(await fs.readFile(lockPath, "utf8")) as Record<string, unknown>;
    expect(raw.nonce).toBeUndefined(); // the premise of this test, asserted

    const waitMs = 200;
    await backdate(lockPath, 5 * waitMs); // > 2*waitMs, << hardStaleMs
    expect(5 * waitMs).toBeLessThan(hardStaleMs(waitMs));

    let ran = false;
    await withFileLock(
      lockPath,
      async () => {
        ran = true;
      },
      { waitMs },
    );
    expect(ran).toBe(true);
  });

  it("a foreign, unparseable lock file is never mistaken for ours on release", async () => {
    const lockPath = path.join(tmp, "test.lock");
    const junk = "not valid json at all {{{";
    const stderr = await captureStderr(async () => {
      await withFileLock(lockPath, async () => {
        await fs.writeFile(lockPath, junk, "utf8"); // in place, no unlink
      });
    });
    expect(await fs.readFile(lockPath, "utf8")).toBe(junk);
    expect(stderr).toContain("was broken while we still held it");
  });
});

// ---------------------------------------------------------------------------
// hardStaleMs — the holder's budget, not the contender's
// ---------------------------------------------------------------------------
//
// `waitMs` answers "how long may a CONTENDER wait"; `hardStaleMs` answers "how
// long may the HOLDER legitimately run". The old API conflated them via
// `max(10 * waitMs, 60_000)`, which is right for the journal (a prune is a
// readFile, a readdir and a few unlinks) and wrong for the object gate, whose
// waitMs is deliberately short (1 500 ms, fail fast) while its critical section
// is a whole write + syntax check + activation round trip against ADT.

describe("withFileLock hardStaleMs", () => {
  /** A lock held by a LIVE pid on this host: the dead-pid rule can never break
   * it, so the hard-stale valve is provably the only thing under test. */
  const liveHolder = async (lockPath: string): Promise<void> =>
    writeHolder(lockPath, { pid: process.pid, hostname: os.hostname() });

  it("DEFECT: raising it protects a live holder the default would have evicted", async () => {
    const lockPath = path.join(tmp, "test.lock");
    await liveHolder(lockPath);
    const waitMs = 200; // the object gate's shape: short wait, long critical section
    const ageMs = 70_000; // a 70-second write+activate on a small appliance
    expect(ageMs).toBeGreaterThan(hardStaleMs(waitMs)); // the default WOULD break it

    await expect(
      withFileLock(lockPath, async () => undefined, {
        waitMs,
        hardStaleMs: 600_000,
        now: clockAhead(ageMs),
      }),
    ).rejects.toMatchObject({ code: "JOURNAL_IO" });

    // Not broken: the holder's file is still there, untouched.
    expect(existsSync(lockPath)).toBe(true);
    expect((await readHolder(lockPath)).pid).toBe(process.pid);
  });

  it("omitted, the old threshold still applies — the same lock IS broken", async () => {
    const lockPath = path.join(tmp, "test.lock");
    await liveHolder(lockPath);
    const waitMs = 200;
    const ageMs = 70_000;

    let ran = false;
    await withFileLock(
      lockPath,
      async () => {
        ran = true;
      },
      { waitMs, now: clockAhead(ageMs) },
    );
    expect(ran).toBe(true); // exactly today's behaviour, deliberately unchanged
  });

  it("lowering it breaks a lock the default would still have protected", async () => {
    const lockPath = path.join(tmp, "test.lock");
    await liveHolder(lockPath);
    const waitMs = 200;
    const ageMs = 20_000;
    expect(ageMs).toBeLessThan(hardStaleMs(waitMs)); // the default would NOT break it

    let ran = false;
    await withFileLock(
      lockPath,
      async () => {
        ran = true;
      },
      { waitMs, hardStaleMs: 10_000, now: clockAhead(ageMs) },
    );
    expect(ran).toBe(true);
  });

  it("omitted, that same 20-second-old live lock is NOT broken", async () => {
    const lockPath = path.join(tmp, "test.lock");
    await liveHolder(lockPath);
    await expect(
      withFileLock(lockPath, async () => undefined, { waitMs: 200, now: clockAhead(20_000) }),
    ).rejects.toMatchObject({ code: "JOURNAL_IO" });
  });

  it("is independent of waitMs: raising waitMs alone no longer raises the valve past it", async () => {
    // Pins that the two knobs really are separate. waitMs 200 + hardStaleMs
    // 10 000 breaks at 20 s (above), and waitMs 200 alone does not — so the
    // valve is following the option, not `10 * waitMs`.
    const lockPath = path.join(tmp, "test.lock");
    await liveHolder(lockPath);
    const waitMs = 200;
    // 10 * waitMs = 2 000, below the 60 000 floor, so the default is the floor.
    expect(hardStaleMs(waitMs)).toBe(60_000);
    await expect(
      withFileLock(lockPath, async () => undefined, {
        waitMs,
        hardStaleMs: 30_000,
        now: clockAhead(20_000),
      }),
    ).rejects.toMatchObject({ code: "JOURNAL_IO" });
  });

  it("the sync twin honours it too", () => {
    const lockPath = path.join(tmp, "test.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() }),
      "utf8",
    );
    const waitMs = 200;

    // Raised past the age: not broken, so this times out.
    expect(() =>
      withFileLockSync(lockPath, () => undefined, {
        waitMs,
        hardStaleMs: 600_000,
        now: clockAhead(70_000),
      }),
    ).toThrowError(AbapError);
    expect(existsSync(lockPath)).toBe(true);

    // Lowered below the age: broken and acquired.
    let ran = false;
    withFileLockSync(
      lockPath,
      () => {
        ran = true;
      },
      { waitMs, hardStaleMs: 10_000, now: clockAhead(20_000) },
    );
    expect(ran).toBe(true);
  });
});

/**
 * Probe pids upward from 30000 with `process.kill(p, 0)` until one throws
 * `ESRCH` (no such process). `EPERM` (exists, owned by someone else) and no
 * throw at all (exists, ours) both mean "keep looking" — only `ESRCH` proves
 * absence. Bounded so a saturated pid space cannot hang the suite; the caller
 * skips its assertion if this returns undefined rather than guessing a pid.
 */
function findDeadPid(): number | undefined {
  for (let p = 30_000; p < 30_000 + 4_000; p++) {
    try {
      process.kill(p, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return p;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// withFileLockSync — the auth latch's path, and nothing else
// ---------------------------------------------------------------------------

describe("withFileLockSync", () => {
  // Its default wait budget is deliberately SHORTER than the async form's
  // (min(ABAP_LOCK_WAIT_MS, 1000ms), src/state-dir.ts:695-700): its only
  // caller is `AuthCircuitBreaker.trip()` on a synchronous constructor path,
  // where waiting blocks the entire process, not just one request.

  it("acquires and releases; the holder record is present while fn runs", () => {
    const lockPath = path.join(tmp, "test.lock");
    let seenDuring: LockHolderShape | undefined;
    const result = withFileLockSync(lockPath, () => {
      expect(existsSync(lockPath)).toBe(true);
      seenDuring = JSON.parse(readFileSync(lockPath, "utf8")) as LockHolderShape;
      return "done";
    });
    expect(result).toBe("done");
    expect(existsSync(lockPath)).toBe(false);
    expect(seenDuring!.pid).toBe(process.pid);
    expect(seenDuring!.hostname).toBe(os.hostname());
  });

  it("releases when fn throws", () => {
    const lockPath = path.join(tmp, "test.lock");
    const marker = new Error("boom from sync fn");
    let caught: unknown;
    try {
      withFileLockSync(lockPath, () => {
        throw marker;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(marker);
    expect(existsSync(lockPath)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "FIX 2: creates the lock file with mode 0600, not the process umask",
    () => {
      const lockPath = path.join(tmp, "test.lock");
      let modeDuring: number | undefined;
      withFileLockSync(lockPath, () => {
        modeDuring = permBits(lockPath);
      });
      expect(modeDuring).toBe(0o600);
    },
  );

  it("times out with JOURNAL_IO against a fresh foreign lock", async () => {
    const lockPath = path.join(tmp, "test.lock");
    await writeHolder(lockPath, { pid: process.pid, hostname: os.hostname() });

    let caught: unknown;
    try {
      withFileLockSync(lockPath, () => undefined, { waitMs: 150 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AbapError);
    expect((caught as AbapError).code).toBe("JOURNAL_IO");
  });
});

// ---------------------------------------------------------------------------
// atomicWriteFileSync
// ---------------------------------------------------------------------------

describe("atomicWriteFileSync", () => {
  it("writes the content and creates a missing parent directory", async () => {
    const filePath = path.join(tmp, "nested", "dir", "state.json");
    atomicWriteFileSync(filePath, '{"ok":true}');
    expect(await fs.readFile(filePath, "utf8")).toBe('{"ok":true}');
  });

  it("leaves no *.tmp files behind in the directory afterwards", async () => {
    const filePath = path.join(tmp, "state.json");
    atomicWriteFileSync(filePath, "hello");
    const entries = await fs.readdir(tmp);
    expect(entries).toContain("state.json");
    expect(entries.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("overwrites an existing file", async () => {
    const filePath = path.join(tmp, "state.json");
    atomicWriteFileSync(filePath, "first");
    atomicWriteFileSync(filePath, "second");
    expect(await fs.readFile(filePath, "utf8")).toBe("second");
    const entries = await fs.readdir(tmp);
    expect(entries).toEqual(["state.json"]);
  });

  it.skipIf(process.platform === "win32")(
    "FIX 2: creates the file with mode 0600, not the process umask",
    () => {
      const filePath = path.join(tmp, "state.json");
      atomicWriteFileSync(filePath, "hello");
      expect(permBits(filePath)).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "FIX 2: an overwrite replaces a pre-existing file's permissive mode with 0600 " +
      "(rename(2) moves the SOURCE temp file's mode onto the destination path, " +
      "entirely replacing whatever mode the old destination had)",
    async () => {
      const filePath = path.join(tmp, "state.json");
      atomicWriteFileSync(filePath, "first");
      chmodSync(filePath, 0o644); // simulate a file left permissive by an older version
      expect(permBits(filePath)).toBe(0o644);

      atomicWriteFileSync(filePath, "second");
      expect(permBits(filePath)).toBe(0o600);
    },
  );
});

// ---------------------------------------------------------------------------
// hardenFileModeSync — FIX 2's migration path for a file that predates the
// mode fix and is never rewritten again (so atomicWriteFileSync's own rename-
// based fix never gets a chance to apply).
// ---------------------------------------------------------------------------

describe("hardenFileModeSync", () => {
  it.skipIf(process.platform === "win32")("chmods an existing permissive file down to 0600", async () => {
    const filePath = path.join(tmp, "permissive.json");
    await fs.writeFile(filePath, "{}", { mode: 0o644 });
    expect(permBits(filePath)).toBe(0o644);

    hardenFileModeSync(filePath);
    expect(permBits(filePath)).toBe(0o600);
  });

  it("is a no-op, not a throw, when the file does not exist (ENOENT is swallowed)", () => {
    const filePath = path.join(tmp, "does-not-exist.json");
    expect(() => hardenFileModeSync(filePath)).not.toThrow();
  });

  it("does nothing on win32, even for a file that exists", async () => {
    const filePath = path.join(tmp, "on-windows.json");
    await fs.writeFile(filePath, "{}", { mode: 0o644 });
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(() => hardenFileModeSync(filePath)).not.toThrow();
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
    // Restored to the real platform: on a POSIX host the file's mode was left
    // untouched by the (skipped) chmod, which we can only usefully assert on
    // POSIX, where "untouched" and "0644" coincide.
    if (original !== "win32") {
      expect(permBits(filePath)).toBe(0o644);
    }
  });

  it.skipIf(process.platform === "win32")(
    "propagates a real error (not ENOENT, not win32) rather than swallowing it",
    () => {
      // EPERM/EACCES-shaped failures are exactly what the task's "must not
      // silently swallow errors indicating a real problem" rule is about.
      // Node's ESM export bindings for `node:fs` cannot be spied on
      // (vitest: "Module namespace is not configurable in ESM"), so this
      // reaches a real, deterministic, portable non-ENOENT failure instead: a
      // path containing a NUL byte fails Node's own argument validation
      // before any syscall happens, with a `code` that is neither `ENOENT`
      // nor anything win32-specific — exactly the "real problem" shape this
      // function must not swallow.
      const filePath = path.join(tmp, "real-error\0.json");
      expect(() => hardenFileModeSync(filePath)).toThrow(/null bytes/);
    },
  );
});
