/**
 * `circuitOpenError`'s old hint told an operator to "restart the
 * MCP server" to clear the latch. When the trip is backed by a durable
 * `auth-latch.json` entry that is structurally false — a fresh process reads
 * the same file on startup (`AuthCircuitBreaker.forConfig`) and re-latches
 * from the identical `TripInfo`, `trippedAt` included. The reported incident
 * followed that advice on every call and got the same error back every time.
 *
 * This file is the red-then-green proof for the fix in
 * src/adt/http-guard.ts (`circuitOpenError`) and src/adt/circuit-breaker.ts
 * (`durableLatchFile`, `forConfig`, `trip()`), plus the accessor added in
 * src/adt/auth-latch.ts (`durableLatchPathFor`). See test/auth-latch.test.ts
 * for the durable-latch idiom this file borrows: unique url/user per test
 * (TRIPPED_FINGERPRINTS is process-wide and has no exported clear), and both
 * halves of teardown in `afterEach` (`__resetAuthLatchForTests()` plus
 * removing the temp directory) since `vitest.config.ts` runs this suite
 * serially with everything else.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fsp, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import {
  AuthCircuitBreaker,
  fingerprintCredentials,
  __resetAuthLatchForTests,
  __setAuthLatchDirForTests,
} from "../src/adt/circuit-breaker.js";
import { AUTH_LATCH_TTL_MS, durableLatchPathFor } from "../src/adt/auth-latch.js";
import { circuitOpenError } from "../src/adt/http-guard.js";
import { isAbapError } from "../src/adt/errors.js";
import type { Config } from "../src/config.js";

const tmpDirs: string[] = [];

async function installLatchDir(): Promise<{ dir: string; latchPath: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "abapsmith-latch-remediation-"));
  tmpDirs.push(dir);
  __setAuthLatchDirForTests(dir);
  return { dir, latchPath: path.join(dir, "auth-latch.json") };
}

function identityFor(testName: string): { url: string; user: string } {
  return {
    url: `http://latch-remediation-${testName}.invalid:50000`,
    user: `USER_${testName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
  };
}

/**
 * Mirrors test/auth-latch.test.ts's own `latchKey`/`writeLatch` idiom: the
 * durable key recomputed independently of the implementation, so a stale
 * entry can be planted on disk directly, bypassing `trip()`'s write path
 * entirely. Needed for the "TTL has actually passed" case below — `trip()`
 * always confirms its own write succeeded (see src/adt/auth-latch.ts's
 * `persistDurableLatch`), so it can never itself produce an on-disk entry
 * that reads back as already-expired.
 */
function latchKey(url: string, user: string): string {
  return createHash("sha256").update("abapsmith-auth-latch " + url + " " + user, "utf8").digest("hex");
}

function writeLatch(latchPath: string, file: unknown): void {
  writeFileSync(latchPath, JSON.stringify(file, null, 2) + "\n", "utf8");
}

afterEach(async () => {
  __resetAuthLatchForTests();
  for (const dir of tmpDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

describe("circuitOpenError names the durable latch file and drops the restart advice", () => {
  it("names the resolved file, the 15-minute TTL, and states a restart does not clear it", async () => {
    await installLatchDir();
    const { url, user } = identityFor("durable-hint");
    const fingerprint = fingerprintCredentials(url, user, "wrong-password");
    const breaker = new AuthCircuitBreaker({ credentialFingerprint: fingerprint });
    breaker.trip("http-401", "Authentication rejected by the ABAP system (HTTP 401).", { status: 401 });

    expect(breaker.durableLatchFile).toBeDefined();

    const err = circuitOpenError(breaker);
    expect(err.hint).toBeDefined();
    const hint = err.hint ?? "";

    expect(hint).toContain(breaker.durableLatchFile as string);
    expect(hint).toContain("15 minutes");
    expect(hint).toMatch(/restart(ing)? the MCP server (will|does) NOT clear it/i);

    // THE RED PROOF: the old advice told an operator to fix credentials and
    // restart, which cannot work against a durable latch a fresh process
    // replays from disk.
    expect(hint).not.toContain("restart the MCP server");
    expect(hint).not.toMatch(/Fix ABAP_USER \/ ABAP_PASSWORD\s+and restart/);
  });

  it("puts latchFile and expiresAt/msRemaining into details, and keeps trippedAt", async () => {
    await installLatchDir();
    const { url, user } = identityFor("durable-details");
    const fingerprint = fingerprintCredentials(url, user, "wrong-password");
    const breaker = new AuthCircuitBreaker({ credentialFingerprint: fingerprint });
    const at = new Date();
    breaker.trip("http-401", "Authentication rejected by the ABAP system (HTTP 401).", { status: 401, at });

    const err = circuitOpenError(breaker);
    expect(err.details.latchFile).toBe(breaker.durableLatchFile);
    expect(err.details.expiresAt).toBe(new Date(at.getTime() + AUTH_LATCH_TTL_MS).toISOString());
    expect(typeof err.details.msRemaining).toBe("number");
    expect(err.details.trippedAt).toBe(at.toISOString());
    // A caller that only inspects `details` (not the prose)
    // can tell the two latches apart without pattern-matching `hint`.
    expect(err.details.durable).toBe(true);
  });
});

describe("remaining-time rendering is clamped and sane", () => {
  it("reports a plausible remaining figure for a trip a few minutes old", async () => {
    await installLatchDir();
    const { url, user } = identityFor("remaining-fresh");
    const fingerprint = fingerprintCredentials(url, user, "wrong-password");
    const breaker = new AuthCircuitBreaker({ credentialFingerprint: fingerprint });
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
    breaker.trip("http-401", "Authentication rejected by the ABAP system (HTTP 401).", {
      status: 401,
      at: fiveMinAgo,
    });

    const err = circuitOpenError(breaker);
    const remaining = err.details.msRemaining as number;

    // ~10 minutes left out of the 15-minute TTL; allow slack for test runtime.
    expect(remaining).toBeGreaterThan(9 * 60_000);
    expect(remaining).toBeLessThanOrEqual(10 * 60_000);
    expect(err.hint ?? "").toMatch(/about \d+m\d*s? from now|about \d+s from now/);
  });

  it("clamps remaining time to zero rather than going negative near the TTL boundary", async () => {
    await installLatchDir();
    const { url, user } = identityFor("remaining-boundary");
    const fingerprint = fingerprintCredentials(url, user, "wrong-password");
    const breaker = new AuthCircuitBreaker({ credentialFingerprint: fingerprint });
    // Just inside the TTL so lookupDurableLatch does not drop it as stale
    // (that check is `elapsed > AUTH_LATCH_TTL_MS`), but close enough to the
    // boundary that expiresAt-Date.now() may already read negative by the
    // time circuitOpenError runs a few ms later — exactly the case the
    // `Math.max(0, ...)` clamp in http-guard.ts exists for.
    const almostExpired = new Date(Date.now() - AUTH_LATCH_TTL_MS + 25);
    breaker.trip("http-401", "Authentication rejected by the ABAP system (HTTP 401).", {
      status: 401,
      at: almostExpired,
    });

    const err = circuitOpenError(breaker);
    const remaining = err.details.msRemaining as number;

    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(remaining).toBeLessThan(1000);
    expect(err.hint ?? "").not.toMatch(/about -/);
  });

  it("once the TTL has actually passed, a fresh process does not replay the entry and its error falls back to the restart-clears-it advice", async () => {
    // `trip()` always confirms its own write succeeded (persistDurableLatch's
    // return value), so a breaker that trips in THIS process can never itself
    // read back as already-expired — `latchFile` is stamped once, at trip
    // time, and cached from then on (see src/adt/circuit-breaker.ts's
    // `trip()`). The only way an entry is EVER actually TTL-dropped is the
    // read a DIFFERENT process does on startup — AuthCircuitBreaker.forConfig
    // replaying auth-latch.json — so that is what this test exercises: plant
    // an already-16-minutes-old entry directly on disk (bypassing `trip()`
    // entirely, mirroring test/auth-latch.test.ts's own idiom), then act out
    // what a restarted process's forConfig call would see.
    const { latchPath } = await installLatchDir();
    const { url, user } = identityFor("ttl-passed");
    const key = latchKey(url, user);
    const staleAt = new Date(Date.now() - AUTH_LATCH_TTL_MS - 5 * 60_000).toISOString(); // 20 min old

    writeLatch(latchPath, {
      version: 1,
      entries: {
        [key]: {
          url,
          user,
          reason: "http-401",
          message: "Authentication rejected by the ABAP system (HTTP 401).",
          status: 401,
          requestUrl: "/sap/bc/adt/discovery",
          at: staleAt,
        },
      },
    });

    const config = { url, user, password: "whatever-the-new-password-is" } as unknown as Config;
    const replayed = AuthCircuitBreaker.forConfig(config);

    // THE PROPERTY: the TTL, not a restart per se, is what actually clears a
    // durable latch — a genuinely-expired entry is dropped and does not
    // re-latch the next process that reads it.
    expect(replayed.isTripped).toBe(false);
    expect(replayed.durableLatchFile).toBeUndefined();

    const err = circuitOpenError(replayed);
    expect(err.details.latchFile).toBeUndefined();
    expect(err.details.msRemaining).toBeUndefined();
    expect(err.details.durable).toBe(false);
    expect(err.hint ?? "").toMatch(/process itself is restarted/i);
    expect(err.hint ?? "").not.toMatch(/about -/);
  });
});

describe("circuitOpenError without a durable latch keeps process-local, restart-clears advice", () => {
  it("names no file path and says only restarting the MCP server process clears it", () => {
    // No __setAuthLatchDirForTests call: authLatchPath() is undefined under
    // vitest by default, so nothing durable is ever in play here.
    const { url, user } = identityFor("no-durable-latch");
    const fingerprint = fingerprintCredentials(url, user, "wrong-password");
    const breaker = new AuthCircuitBreaker({ credentialFingerprint: fingerprint });
    breaker.trip("http-401", "Authentication rejected by the ABAP system (HTTP 401).", { status: 401 });

    expect(breaker.durableLatchFile).toBeUndefined();

    const err = circuitOpenError(breaker);
    const hint = err.hint ?? "";

    // "recorded in <path>" is the durable-only phrase (see the DURABLE
    // branch above) — this hint may still name auth-latch.json generically
    // (explaining why nothing durable is in play) without naming a file.
    expect(hint).not.toContain("recorded in");
    expect(err.details.latchFile).toBeUndefined();
    expect(err.details.durable).toBe(false);
    expect(hint).toMatch(/process itself is restarted/i);
  });

  // Live incident: a live-test agent hit this exact branch
  // from a tool call running INSIDE the MCP server it would need restarted.
  // The old wording ("restarting the MCP server does clear it") read as an
  // instruction the agent itself could act on, but it cannot restart its own
  // host process — only whoever operates the server can. The hint must say
  // so explicitly rather than merely stating the mechanism.
  it("says restarting is not something a tool call running inside the server can do to its own host", () => {
    const { url, user } = identityFor("no-durable-latch-agency");
    const fingerprint = fingerprintCredentials(url, user, "wrong-password");
    const breaker = new AuthCircuitBreaker({ credentialFingerprint: fingerprint });
    breaker.trip("http-401", "Authentication rejected by the ABAP system (HTTP 401).", { status: 401 });

    const hint = circuitOpenError(breaker).hint ?? "";
    expect(hint).toMatch(/not something a tool call running inside that same server can do/i);
    expect(hint).toMatch(/whoever operates this MCP server/i);
  });
});

describe("circuitOpenError stays defensive when breaker.info is undefined", () => {
  it("returns an AbapError instead of throwing", () => {
    const breaker = new AuthCircuitBreaker();
    expect(breaker.info).toBeUndefined();

    let err: unknown;
    expect(() => {
      err = circuitOpenError(breaker);
    }).not.toThrow();

    expect(isAbapError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("AUTH_CIRCUIT_OPEN");
  });
});

describe("no-regression pins", () => {
  it("keeps code AUTH_CIRCUIT_OPEN and preserves the original trippedAt across a forConfig replay", async () => {
    await installLatchDir();
    const identity = identityFor("replay-pin");
    // AuthCircuitBreaker.forConfig only reads url/user/password; a minimal
    // shape avoids ConfigSchema.parse, which the system-role-probe guard
    // (test/system-role-probe-guard.test.ts) treats as "this suite opens a
    // connection" — this suite never does, it only replays a breaker.
    const config = {
      url: identity.url,
      user: identity.user,
      password: "wrong-password",
    } as unknown as Config;
    // Recent (not `AUTH_LATCH_TTL_MS`-stale) but distinguishable from
    // "restamped to now": a hardcoded far-past date would age out of the
    // durable latch's own TTL and get dropped as stale before replay, which
    // tests staleness handling instead of replay fidelity.
    const originalAt = new Date(Date.now() - 3 * 60_000);

    const fingerprint = fingerprintCredentials(config.url, config.user, config.password);
    new AuthCircuitBreaker({ credentialFingerprint: fingerprint }).trip(
      "http-401",
      "Authentication rejected by the ABAP system (HTTP 401).",
      { status: 401, at: originalAt },
    );

    // A fresh process would build a new AuthCircuitBreaker exactly this way —
    // AuthCircuitBreaker.forConfig replays the stored TripInfo, including its
    // original timestamp, rather than stamping `new Date()`.
    const replayed = AuthCircuitBreaker.forConfig(config);
    expect(replayed.isTripped).toBe(true);
    expect(replayed.info?.at.toISOString()).toBe(originalAt.toISOString());
    expect(replayed.durableLatchFile).toBeDefined();

    const err = circuitOpenError(replayed);
    expect(err.code).toBe("AUTH_CIRCUIT_OPEN");
    expect(err.details.trippedAt).toBe(originalAt.toISOString());
    expect(err.details.durable).toBe(true);
  });
});

describe("durableLatchPathFor", () => {
  it("returns undefined for a fingerprint nobody ever minted", () => {
    expect(durableLatchPathFor("not-a-real-fingerprint")).toBeUndefined();
  });

  it("never throws when the installed state directory is a file, not a directory", async () => {
    const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "abapsmith-latch-remediation-notadir-"));
    tmpDirs.push(parent);
    const notADir = path.join(parent, "state-dir-is-a-file");
    writeFileSync(notADir, "not a directory\n", "utf8");
    __setAuthLatchDirForTests(notADir);

    const { url, user } = identityFor("path-for-notadir");
    const fingerprint = fingerprintCredentials(url, user, "irrelevant");

    expect(() => durableLatchPathFor(fingerprint)).not.toThrow();
    expect(durableLatchPathFor(fingerprint)).toBeUndefined();
  });

  it("returns undefined when no latch directory has been installed at all", () => {
    const { url, user } = identityFor("path-for-no-dir-installed");
    const fingerprint = fingerprintCredentials(url, user, "irrelevant");
    expect(durableLatchPathFor(fingerprint)).toBeUndefined();
  });
});
