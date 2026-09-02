/**
 * The DURABLE, CROSS-PROCESS auth latch,
 * implemented in src/adt/circuit-breaker.ts.
 *
 * ## What is under test, and why it is worth a file of its own
 *
 * `TRIPPED_FINGERPRINTS` (D1, tested in test/circuit-breaker.test.ts:263-336)
 * makes N *connections* in ONE process cost one logon. It does nothing at all
 * across processes, and capability (B) means N terminals are N processes:
 * `login/fails_to_user_lock` defaults to 5, so three-to-five terminals sharing a
 * stale password LOCK THE SAP USER — the precise failure D1 exists to prevent,
 * solved one process at a time. `<stateDir>/auth-latch.json` is the fix: N
 * terminals, one logon.
 *
 * ## The security property this file exists to pin
 *
 * A durable latch is a new, readable, on-disk surface derived from a credential
 * rejection, and there is exactly one way to get it catastrophically wrong.
 * `fingerprintCredentials()` is `sha256(INSTALL_SALT ‖ url ‖ user ‖ password)`
 * and is safe ONLY because `INSTALL_SALT` is `randomBytes(16)` regenerated per
 * process. Persisting that value — or persisting the salt — would turn
 * auth-latch.json into an OFFLINE PASSWORD-GUESSING ORACLE against a file the
 * SAP user can read: an attacker with the file could grind candidate passwords
 * locally, at no cost, with no failed logons and no lockout counter to stop
 * them. The design forbids it in as many words, and the implementation answers it by
 * keying the file on `sha256("abapsmith-auth-latch " + url + " " + user)` —
 * non-secret identity that is already in the config, the logs and the README.
 *
 * `test/circuit-breaker.test.ts:308-335` asserts the same non-leak property over
 * the process's observable surfaces (errors, status(), logs), and the design's own
 * review notes it "cannot reach" a durable file. THE HEADLINE TEST below is that
 * missing assertion, made against the real bytes on disk after a real trip.
 *
 * ## House rules for this file
 *
 * `vitest.config.ts` sets `fileParallelism: false`, so a leaked latch directory
 * would poison every suite that runs after this one — hence the unconditional
 * `afterEach`. And `TRIPPED_FINGERPRINTS` can NEVER be cleared (its doc comment
 * forbids an exported clear, and `__resetAuthLatchForTests()` deliberately does
 * not touch it), so every test below uses a URL/user pair unique to itself.
 * Reusing one across two tests here would make the second inherit the first's
 * in-memory latch and quietly assert nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AuthCircuitBreaker,
  fingerprintCredentials,
  lookupTrippedFingerprint,
  __resetAuthLatchForTests,
  __setAuthLatchDirForTests,
  type TripReason,
} from "../src/adt/circuit-breaker.js";

const LATCH_FILE = "auth-latch.json";

/** Every temp directory this file made, torn down unconditionally in `afterEach`. */
const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "abapsmith-latch-"));
  tmpDirs.push(dir);
  return dir;
}

/** Opt this test into the durable latch with a private directory of its own. */
async function installLatchDir(): Promise<{ dir: string; latchPath: string }> {
  const dir = await makeTmpDir();
  __setAuthLatchDirForTests(dir);
  return { dir, latchPath: path.join(dir, LATCH_FILE) };
}

/**
 * Unique, non-colliding credentials per test. `TRIPPED_FINGERPRINTS` is
 * process-wide and unclearable; the durable file is keyed on url+user. A shared
 * pair would cross-talk through BOTH.
 */
function identityFor(testName: string): { url: string; user: string } {
  return {
    url: `http://latch-${testName}.invalid:50000`,
    user: `USER_${testName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
  };
}

/**
 * The durable key, recomputed independently of the implementation. Pinning the
 * preimage here is deliberate: it is the whole security argument in one line —
 * a domain-separated hash of NON-SECRET identity, no salt, no password, no
 * fingerprint.
 */
function latchKey(url: string, user: string): string {
  return createHash("sha256")
    .update("abapsmith-auth-latch " + url + " " + user, "utf8")
    .digest("hex");
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

interface OnDiskEntry {
  url: string;
  user: string;
  reason: TripReason;
  message: string;
  status?: number;
  requestUrl?: string;
  at: string;
}

function readLatch(latchPath: string): { version: number; entries: Record<string, OnDiskEntry> } {
  return JSON.parse(readFileSync(latchPath, "utf8"));
}

function writeLatch(latchPath: string, file: unknown): void {
  writeFileSync(latchPath, JSON.stringify(file, null, 2) + "\n", "utf8");
}

/**
 * A well-formed durable entry, as another terminal's process would have left
 * it. `at` defaults to "just now" — FIX 1 replaced the removed
 * `passwordLength` discriminator with a TTL judged purely from this
 * timestamp, so any test that is not specifically exercising staleness must
 * pass a fresh one or it silently starts failing as the real clock advances
 * past the TTL.
 */
function entryFor(url: string, user: string, over: Partial<OnDiskEntry> = {}): OnDiskEntry {
  return {
    url,
    user,
    reason: "http-401",
    message: "Authentication rejected by the ABAP system (HTTP 401).",
    status: 401,
    requestUrl: "/sap/bc/adt/discovery",
    at: new Date(Date.now() - 1_000).toISOString(),
    ...over,
  };
}

/**
 * A degraded latch warns on stderr exactly once per process. That is correct
 * behaviour, but it is noise in a test log, so the deliberately-broken cases
 * capture it instead of printing it.
 */
function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  return { text: () => chunks.join(""), restore: () => spy.mockRestore() };
}

// ---------------------------------------------------------------------------

afterEach(async () => {
  // BOTH halves are mandatory. `__resetAuthLatchForTests()` un-installs the
  // directory (without which the NEXT suite writes into ours) and clears the
  // identity side channel and the read cache; the `rm` removes the bytes. With
  // `fileParallelism: false` a leak here is not a flake, it is a cascade.
  __resetAuthLatchForTests();
  for (const dir of tmpDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// THE HEADLINE TEST — the password-oracle guarantee.
// ===========================================================================
describe("the durable latch file is not a password oracle", () => {
  it("writes url and user and nothing derived from the password, not even its length", async () => {
    // THE THREAT MODEL, stated once, in full.
    //
    // `fingerprintCredentials(url, user, password)` returns
    //   sha256(INSTALL_SALT + url + user + password).slice(0, 16)
    // and it is safe ONLY because INSTALL_SALT is randomBytes(16) minted fresh
    // in every process. If that salt — or the fingerprint it produces — were
    // ever written to auth-latch.json, anyone who can read that file (the SAP
    // user can; it lives under ABAP_STATE_DIR, default <cwd>/.abapsmith) could
    // grind candidate passwords against it OFFLINE: unlimited guesses, no
    // network, no failed logons, and no login/fails_to_user_lock counter to
    // stop them. The password would be recoverable from a file whose entire
    // purpose is to PROTECT the account. The design calls
    // this out as non-negotiable, which is why the durable key is
    // sha256("abapsmith-auth-latch " + url + " " + user): non-secret identity,
    // unsalted on purpose (a salt would make the key process-local and defeat
    // the cross-process sharing), with nothing in the preimage to protect.
    //
    // This test is the on-disk half of test/circuit-breaker.test.ts:308-335.
    const { latchPath } = await installLatchDir();
    const { url, user } = identityFor("headline-oracle");
    const PASSWORD = "Sw0rdf1sh-oracle-probe-Qz";

    const fingerprint = fingerprintCredentials(url, user, PASSWORD);
    const breaker = new AuthCircuitBreaker({ credentialFingerprint: fingerprint });
    breaker.trip("http-401", "Authentication rejected by the ABAP system (HTTP 401).", {
      status: 401,
      url: "/sap/bc/adt/discovery",
    });

    expect(existsSync(latchPath)).toBe(true);
    const raw = readFileSync(latchPath, "utf8");

    // 1. The password itself.
    expect(raw).not.toContain(PASSWORD);

    // 2. The salted fingerprint. This is the one the design names explicitly.
    expect(raw).not.toContain(fingerprint);

    // 3. No bare 16-hex token of any kind — the same standard
    //    test/circuit-breaker.test.ts:334 applies to the observable surfaces,
    //    extended here to the bytes on disk. The durable key is a FULL 64-char
    //    sha256, which has no 16-char match at a word boundary, so this holds
    //    by construction. If it ever fires, something 16-hex-shaped — i.e.
    //    fingerprint-shaped — reached the file.
    expect(raw).not.toMatch(/\b[0-9a-f]{16}\b/);

    // 4. Unsalted hashes of the password are no better than the salted one:
    //    a durable sha256(password) is a rainbow-table lookup, and a durable
    //    sha256(url+user+password) is the same oracle with a known prefix.
    expect(raw).not.toContain(sha256(PASSWORD));
    expect(raw).not.toContain(sha256(url + user + PASSWORD));

    // 5. FIX 1: not even the password's LENGTH is permitted on disk anymore.
    //    The change discriminator that used to justify it is gone — a
    //    corrected typo now waits out `AUTH_LATCH_TTL_MS` instead (see the
    //    TTL-expiry describe block below) — so there is nothing password-
    //    derived left that this file has any reason to carry.
    const file = readLatch(latchPath);
    const entry = file.entries[latchKey(url, user)];
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("passwordLength");

    // 6. The exact key set. This is a ratchet, not a formality: a future field
    //    that leaks something — a fingerprint, a hash, a token, a header, a
    //    password length — has to come here and change this list
    //    deliberately, in a diff a reviewer will read, rather than sliding in
    //    under a `toMatchObject`.
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      ["at", "message", "reason", "requestUrl", "status", "url", "user"].sort(),
    );

    // …and the key really is the documented non-secret preimage, not something
    // that merely happens to be 64 hex characters.
    expect(Object.keys(file.entries)).toEqual([latchKey(url, user)]);
  });
});

// ===========================================================================
// FIX 2: the file is not merely non-oracle in CONTENT, it must not be
// world/group-readable on a shared host either — it records which SAP user on
// which host has failing credentials, which is worth keeping to the owner
// alone. POSIX modes are a no-op on Windows, so these are skipped there.
// ===========================================================================
describe.skipIf(process.platform === "win32")("the durable latch file is created with restrictive permissions", () => {
  /** Lowest 3 octal digits of a file's mode — the part `chmod`/`mode:` control. */
  function permBits(p: string): number {
    return statSync(p).mode & 0o777;
  }

  it("creates auth-latch.json with mode 0600, not the process umask", async () => {
    const { latchPath } = await installLatchDir();
    const { url, user } = identityFor("perm-mode-0600");

    const fingerprint = fingerprintCredentials(url, user, "pw-perm-check");
    new AuthCircuitBreaker({ credentialFingerprint: fingerprint }).trip("http-401", "rejected", {
      status: 401,
    });

    expect(existsSync(latchPath)).toBe(true);
    expect(permBits(latchPath)).toBe(0o600);
  });

  it("hardens a pre-existing, permissively-moded latch file on the next read", async () => {
    // MIGRATION: a file left behind by a pre-fix version (or written under a
    // permissive umask before atomicWriteFileSync started passing `mode`)
    // must not stay world-readable forever just because nothing ever writes
    // to it again. `readLatchFile` calls `hardenFileModeSync` for exactly
    // this case.
    const { latchPath } = await installLatchDir();
    const { url, user } = identityFor("perm-mode-migration");
    const key = latchKey(url, user);

    writeLatch(latchPath, { version: 1, entries: { [key]: entryFor(url, user) } });
    // Simulate a file that predates this fix: wide open.
    chmodSync(latchPath, 0o644);
    expect(permBits(latchPath)).toBe(0o644);

    const fingerprint = fingerprintCredentials(url, user, "pw-migration-check");
    expect(lookupTrippedFingerprint(fingerprint)).toBeDefined();

    expect(permBits(latchPath)).toBe(0o600);
  });

  // The lock file itself (`auth-latch.json.lock`) is exercised generically —
  // for both the sync and async lock primitives, not just the auth latch's
  // caller of them — in test/state-dir.test.ts, since `withFileLock` /
  // `withFileLockSync` are src/state-dir.ts's primitives and the mode fix
  // lives there, not in circuit-breaker.ts.
});

// ===========================================================================
// The write path.
// ===========================================================================
describe("the durable latch is inert under vitest unless a test opts in", () => {
  it("writes nothing anywhere when no test directory has been installed", async () => {
    // THIS IS WHAT KEEPS THE OTHER ~25 SUITES GREEN. test/circuit-breaker.test.ts
    // isolates its cases by varying the PASSWORD alone against one shared url
    // and user; a latch keyed on url+user would make every case after the first
    // inherit the first's latch — the exact cross-contamination its `cfg(who)`
    // helper exists to avoid, reintroduced one level down. Two dozen further
    // suites build connections with that same url/user, and `resolveStateDir`'s
    // default is cwd-anchored, so an always-on latch would also write into the
    // developer's working tree on every `npm test`.
    const unused = await makeTmpDir(); // created, deliberately NOT installed
    const { url, user } = identityFor("inert-by-default");

    const fingerprint = fingerprintCredentials(url, user, "irrelevant");
    const breaker = new AuthCircuitBreaker({ credentialFingerprint: fingerprint });
    breaker.trip("http-401", "rejected", { status: 401 });

    // The in-memory latch still works — inert means "does not persist", not
    // "does not protect".
    expect(breaker.isTripped).toBe(true);

    expect(await fsp.readdir(unused)).toEqual([]);
    expect(existsSync(path.join(process.cwd(), ".abapsmith", LATCH_FILE))).toBe(false);
    expect(existsSync(path.join(process.cwd(), LATCH_FILE))).toBe(false);
  });
});

describe("a real trip is recorded on disk", () => {
  it("round-trips a tripped breaker to a version-1 file and back", async () => {
    const { latchPath } = await installLatchDir();
    const { url, user } = identityFor("round-trip");
    const password = "round-trip-pw";
    const at = new Date("2026-08-02T10:20:30.000Z");

    const fingerprint = fingerprintCredentials(url, user, password);
    const breaker = new AuthCircuitBreaker({ credentialFingerprint: fingerprint });
    breaker.trip("icf-logon-page", "SAP ICF returned a logon-failure page.", {
      status: 200,
      url: "/sap/bc/adt/discovery",
      at,
    });

    expect(existsSync(latchPath)).toBe(true);
    const raw = readFileSync(latchPath, "utf8");
    const file = readLatch(latchPath);

    expect(file.version).toBe(1);
    expect(file.entries[latchKey(url, user)]).toEqual({
      url,
      user,
      reason: "icf-logon-page",
      message: "SAP ICF returned a logon-failure page.",
      status: 200,
      requestUrl: "/sap/bc/adt/discovery",
      at: at.toISOString(),
    });

    // 2-space indent and a trailing newline: a human is expected to open this
    // file, read it and delete it. That IS the documented remediation, so its
    // legibility is a behaviour, not a formatting preference.
    expect(raw).toBe(JSON.stringify(file, null, 2) + "\n");
  });
});

// ===========================================================================
// The headline BEHAVIOUR: a second process is latched from birth.
// ===========================================================================
describe("a second process is latched from birth by the file alone", () => {
  it("returns the stored TripInfo for credentials that never tripped in this process", async () => {
    // Simulating "a fresh process" honestly. There is deliberately NO way to
    // clear `TRIPPED_FINGERPRINTS` — its doc comment forbids an exported clear
    // and `__resetAuthLatchForTests()` pointedly does not touch it — so adding
    // one to make this test easier is forbidden. Instead this uses a url/user
    // pair that has never tripped in memory ANYWHERE in this process, which is
    // exactly the state a freshly started terminal is in, and hands it a latch
    // file that another terminal left behind.
    const { latchPath } = await installLatchDir();
    const { url, user } = identityFor("second-process");
    const password = "another-terminals-pw";
    // Recent, but not "now" — proves `at` really is read back from disk
    // rather than defaulted, while staying comfortably inside AUTH_LATCH_TTL_MS
    // (15 minutes) so the TTL-expiry logic does not treat this fixture as stale.
    const at = new Date(Date.now() - 30_000).toISOString();

    writeLatch(latchPath, {
      version: 1,
      entries: {
        [latchKey(url, user)]: entryFor(url, user, {
          reason: "http-401",
          message: "Authentication rejected by the ABAP system (HTTP 401).",
          at,
        }),
      },
    });

    const fingerprint = fingerprintCredentials(url, user, password);
    const info = lookupTrippedFingerprint(fingerprint);

    expect(info).toBeDefined();
    expect(info?.reason).toBe("http-401");
    expect(info?.message).toBe("Authentication rejected by the ABAP system (HTTP 401).");
    expect(info?.status).toBe(401);
    expect(info?.url).toBe("/sap/bc/adt/discovery");
    expect(info?.at).toBeInstanceOf(Date);
    expect(info?.at.toISOString()).toBe(at);

    // …and `rm auth-latch.json` clears the block IMMEDIATELY, in this running
    // process, on the very next lookup. That is what the remediation text in
    // `describeState()` promises an operator, and it is only true because a
    // durable hit does NOT seed `TRIPPED_FINGERPRINTS`. Seeding it would pin
    // the latch for the lifetime of the process and make deleting the file a
    // lie — so this deletion is the assertion that the memory map stayed empty.
    await fsp.rm(latchPath);
    expect(lookupTrippedFingerprint(fingerprint)).toBeUndefined();
  });
});

// ===========================================================================
// The automatic clear, and its honest limit.
// ===========================================================================
describe("a stale durable latch expires on its own (FIX 1's TTL replacement)", () => {
  // AUTH_LATCH_TTL_MS in src/adt/circuit-breaker.ts is 15 minutes. Recomputed
  // here rather than imported, per this file's own house rule: the test
  // pins the CONTRACT (15 minutes, judged from `at` alone), not merely
  // whatever the implementation currently does.
  const FIFTEEN_MIN_MS = 15 * 60 * 1000;

  it("drops an entry older than the TTL and does not re-latch on the next lookup", async () => {
    const { latchPath } = await installLatchDir();
    const { url, user } = identityFor("ttl-expired");
    const key = latchKey(url, user);
    const staleAt = new Date(Date.now() - FIFTEEN_MIN_MS - 60_000).toISOString(); // 16 min old

    writeLatch(latchPath, { version: 1, entries: { [key]: entryFor(url, user, { at: staleAt }) } });

    const fingerprint = fingerprintCredentials(url, user, "whatever-the-new-password-is");
    expect(lookupTrippedFingerprint(fingerprint)).toBeUndefined();

    // Not merely ignored — REMOVED, exactly as the removed passwordLength
    // discriminator used to remove a changed-password entry, so a stale block
    // cannot come back to bite a later lookup for the same key.
    expect(readLatch(latchPath).entries[key]).toBeUndefined();
  });

  it("keeps a fresh entry latched — this is unconditional, unlike the old length check", async () => {
    // FIX 1 traded away the old discriminator's one advantage: an entry now
    // stays latched for the FULL TTL even if the credentials genuinely
    // changed in the meantime, because nothing password-derived is left on
    // disk to compare against. This test pins that trade: a one-second-old
    // entry blocks a lookup for BRAND NEW credentials just as it would for
    // the original bad ones.
    const { latchPath } = await installLatchDir();
    const { url, user } = identityFor("ttl-fresh");
    const key = latchKey(url, user);

    writeLatch(latchPath, { version: 1, entries: { [key]: entryFor(url, user) } }); // ~1s old, from entryFor's default

    const fingerprint = fingerprintCredentials(url, user, "a-brand-new-corrected-password");
    expect(lookupTrippedFingerprint(fingerprint)).toBeDefined();
    expect(readLatch(latchPath).entries[key]).toBeDefined();
  });

  it("treats an entry right at the TTL boundary as still fresh", async () => {
    const { latchPath } = await installLatchDir();
    const { url, user } = identityFor("ttl-boundary-fresh");
    const key = latchKey(url, user);
    const almostStaleAt = new Date(Date.now() - FIFTEEN_MIN_MS + 5_000).toISOString(); // 14m55s old

    writeLatch(latchPath, { version: 1, entries: { [key]: entryFor(url, user, { at: almostStaleAt }) } });

    const fingerprint = fingerprintCredentials(url, user, "irrelevant");
    expect(lookupTrippedFingerprint(fingerprint)).toBeDefined();
  });
});

// ===========================================================================
// The key's shape — a documented deviation from the original design.
// ===========================================================================
describe("the durable key is url+user only, deliberately without client", () => {
  it("keys on non-secret identity alone, so one entry blocks the user on every client", async () => {
    // The original design specifies sha256(url|user|client). This implementation keys on
    // url+user and says so: `cfg.client` never crosses the `buildBreaker` seam
    // (connection.ts:492-501 passes url, user and password and nothing else),
    // so this module cannot reach it without a signature change in a file it
    // does not own. Omitting it is strictly MORE conservative — a user rejected
    // on client 001 is also blocked on client 000 of the same host — and
    // over-blocking is the safe direction here: the failure it prevents is a
    // LOCKED SAP USER, and the cost of a false block is one `rm`.
    //
    // The assertion is that the key is FULLY DETERMINED by url and user: it
    // matches the two-argument preimage exactly, leaving no room for a client
    // component to be silently present.
    const { latchPath } = await installLatchDir();
    const { url, user } = identityFor("no-client-in-key");
    const password = "client-agnostic";

    const fingerprint = fingerprintCredentials(url, user, password);
    const breaker = new AuthCircuitBreaker({ credentialFingerprint: fingerprint });
    breaker.trip("http-401", "rejected", { status: 401 });

    const keys = Object.keys(readLatch(latchPath).entries);
    expect(keys).toEqual([latchKey(url, user)]);
    // Belt and braces: no client number is recoverable from, or present in, the
    // stored entry either.
    const entry = readLatch(latchPath).entries[keys[0]!];
    expect(entry).not.toHaveProperty("client");
  });
});

// ===========================================================================
// Robustness. A broken latch must never break a working connection.
// ===========================================================================
describe("a broken latch file degrades to today's per-process behaviour", () => {
  const brokenFiles: { name: string; write: (p: string) => void }[] = [
    { name: "invalid JSON", write: (p) => writeFileSync(p, "{ this is not json", "utf8") },
    { name: "a JSON array, not an object", write: (p) => writeLatch(p, [{ version: 1 }]) },
    { name: "no entries key at all", write: (p) => writeLatch(p, { version: 1 }) },
    {
      name: "a future file version",
      write: (p) => writeLatch(p, { version: 2, entries: {} }),
    },
  ];

  for (const [i, broken] of brokenFiles.entries()) {
    it(`returns undefined and still latches in memory when the file is ${broken.name}`, async () => {
      const stderr = captureStderr();
      try {
        const { latchPath } = await installLatchDir();
        const { url, user } = identityFor(`broken-${i}`);
        broken.write(latchPath);

        const fingerprint = fingerprintCredentials(url, user, "pw-broken");

        // The read path: no throw, no latch, no crash.
        expect(() => lookupTrippedFingerprint(fingerprint)).not.toThrow();
        expect(lookupTrippedFingerprint(fingerprint)).toBeUndefined();

        // The write path: `trip()` sits on a synchronous constructor seam that
        // the whole module promises cannot raise.
        const breaker = new AuthCircuitBreaker({ credentialFingerprint: fingerprint });
        expect(() =>
          breaker.trip("http-401", "rejected", { status: 401 }),
        ).not.toThrow();
        expect(breaker.isTripped).toBe(true);
        expect(breaker.state).toBe("latched");
      } finally {
        stderr.restore();
      }
    });
  }

  it("survives a state directory that is a regular FILE, so every write fails", async () => {
    const stderr = captureStderr();
    try {
      // The nastiest shape: `<dir>/auth-latch.json` cannot be created because
      // `<dir>` is not a directory. Both the lock's mkdir and the atomic
      // write's mkdir fail, and neither may reach the caller.
      const parent = await makeTmpDir();
      const notADir = path.join(parent, "state-dir-is-a-file");
      writeFileSync(notADir, "I am a regular file, not a directory\n", "utf8");
      __setAuthLatchDirForTests(notADir);

      const { url, user } = identityFor("state-dir-is-a-file");
      const fingerprint = fingerprintCredentials(url, user, "pw-notadir");

      expect(lookupTrippedFingerprint(fingerprint)).toBeUndefined();

      const breaker = new AuthCircuitBreaker({ credentialFingerprint: fingerprint });
      expect(() => breaker.trip("http-401", "rejected", { status: 401 })).not.toThrow();
      expect(breaker.isTripped).toBe(true);
      expect(breaker.state).toBe("latched");

      // The file was never turned into a directory or clobbered on the way out.
      expect(readFileSync(notADir, "utf8")).toBe("I am a regular file, not a directory\n");
      // The operator is told once, and told what to do about it.
      expect(stderr.text()).toMatch(/durable auth latch/);
    } finally {
      stderr.restore();
    }
  });
});

// ===========================================================================
// Concurrency.
// ===========================================================================
describe("concurrent writers do not lose each other's entries", () => {
  it("keeps both entries when two different credentials trip in sequence", async () => {
    const { latchPath } = await installLatchDir();
    const a = identityFor("two-writers-a");
    const b = identityFor("two-writers-b");

    for (const id of [a, b]) {
      const fp = fingerprintCredentials(id.url, id.user, "pw-two-writers");
      new AuthCircuitBreaker({ credentialFingerprint: fp }).trip("http-401", "rejected", {
        status: 401,
      });
    }

    const entries = readLatch(latchPath).entries;
    expect(Object.keys(entries).sort()).toEqual(
      [latchKey(a.url, a.user), latchKey(b.url, b.user)].sort(),
    );
  });

  it("writes UNLOCKED rather than dropping the entry when the lock cannot be taken", async () => {
    // THE DOCUMENTED FALLBACK, and it is a real trade rather than an oversight.
    // `mutateLatchFile` runs the read-modify-write anyway when
    // `withFileLockSync` gives up inside its 1-second budget (src/state-dir.ts
    // caps the SYNC wait deliberately: this call stalls the entire process).
    // Skipping the write would mean our latch entry never lands, which means
    // the NEXT terminal burns another real logon against
    // login/fails_to_user_lock — the exact failure this file exists to prevent,
    // traded away to avoid a race that costs at most one lost entry. Because
    // the fallback re-reads the file immediately before writing, the window is
    // microseconds wide and any loss self-heals from the other process's own
    // in-memory latch.
    const stderr = captureStderr();
    try {
      const { latchPath } = await installLatchDir();
      const a = identityFor("contention-a");
      const b = identityFor("contention-b");
      const c = identityFor("contention-c");

      for (const id of [a, b]) {
        const fp = fingerprintCredentials(id.url, id.user, "pw-contention");
        new AuthCircuitBreaker({ credentialFingerprint: fp }).trip("http-401", "rejected", {
          status: 401,
        });
      }

      // A FRESH holder record for a live pid on this host: not hard-stale, not
      // owner-gone, so `withFileLockSync` can never acquire and must time out.
      writeFileSync(
        latchPath + ".lock",
        JSON.stringify({
          pid: process.pid,
          hostname: os.hostname(),
          startedAt: new Date().toISOString(),
        }),
        "utf8",
      );

      const fpC = fingerprintCredentials(c.url, c.user, "pw-contention");
      const breaker = new AuthCircuitBreaker({ credentialFingerprint: fpC });
      expect(() => breaker.trip("http-401", "rejected", { status: 401 })).not.toThrow();

      const entries = readLatch(latchPath).entries;
      // The blocked writer's entry landed anyway…
      expect(entries[latchKey(c.url, c.user)]).toBeDefined();
      // …and it did not trample the two that were already there.
      expect(Object.keys(entries).sort()).toEqual(
        [
          latchKey(a.url, a.user),
          latchKey(b.url, b.user),
          latchKey(c.url, c.user),
        ].sort(),
      );
    } finally {
      stderr.restore();
    }
  });
});

// ===========================================================================
// The replay path must not write back.
// ===========================================================================
describe("a replayed latch does not rewrite the entry it was replayed from", () => {
  it("leaves the file untouched when the breaker carries no credentialFingerprint", async () => {
    // The replay breaker built at connection.ts:496 is constructed WITHOUT a
    // `credentialFingerprint` precisely so that hanging the durable write off
    // that branch makes this impossible by construction. If it ever wrote, a
    // latch read from disk would refresh its own `at` on every process start
    // and the entry would look perpetually fresh — its age is the only clue an
    // operator has about when the credentials actually broke.
    const { latchPath } = await installLatchDir();
    const { url, user } = identityFor("replay-no-rewrite");

    const fingerprint = fingerprintCredentials(url, user, "pw-replay");
    new AuthCircuitBreaker({ credentialFingerprint: fingerprint }).trip("http-401", "rejected", {
      status: 401,
      at: new Date("2026-07-01T00:00:00.000Z"),
    });

    const before = readFileSync(latchPath, "utf8");
    const beforeMtime = statSync(latchPath).mtimeMs;

    // The replay: same failure, same credentials, no fingerprint.
    const replayed = new AuthCircuitBreaker({});
    replayed.trip("http-401", "rejected", { status: 401, at: new Date() });
    expect(replayed.isTripped).toBe(true);

    expect(readFileSync(latchPath, "utf8")).toBe(before);
    expect(statSync(latchPath).mtimeMs).toBe(beforeMtime);
  });
});

// ===========================================================================
// The test hooks are test-only.
// ===========================================================================
describe("the durable-latch test hooks refuse to run outside a test run", () => {
  it("throws from both hooks when VITEST and NODE_ENV are cleared", () => {
    const vitestFlag = process.env.VITEST;
    const nodeEnv = process.env.NODE_ENV;
    try {
      delete process.env.VITEST;
      delete process.env.NODE_ENV;

      expect(() => __setAuthLatchDirForTests(os.tmpdir())).toThrow(/test-only/);
      expect(() => __resetAuthLatchForTests()).toThrow(/test-only/);
    } finally {
      // Non-negotiable: `afterEach` calls `__resetAuthLatchForTests()`, which
      // would itself throw if these were left cleared, and every later suite in
      // this serial run would inherit a production-looking environment.
      if (vitestFlag === undefined) delete process.env.VITEST;
      else process.env.VITEST = vitestFlag;
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
    }
  });
});
