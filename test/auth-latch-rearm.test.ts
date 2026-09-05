/**
 * Operator-triggered recovery for the auth latch: `rearmAuthProbe()` /
 * `allowAuthProbe()` / `authProbeArmed` on `AuthCircuitBreaker`, and the
 * on-disk `auth-rearm` signal in `src/adt/auth-latch.ts`. Before this, a
 * latched breaker had no way back short of killing the process. The fix adds
 * exactly one door, opened only by an explicit operator action — never a
 * timer — admitting exactly one further logon attempt at a time.
 *
 * Same idioms as test/auth-latch.test.ts and test/auth-latch-remediation.test.ts:
 * a unique url/user per test that touches `credentialFingerprint` (
 * `TRIPPED_FINGERPRINTS` is process-wide and has no exported clear), and both
 * halves of teardown in `afterEach` (`__resetAuthLatchForTests()` plus
 * removing the temp directory), since `vitest.config.ts` runs every suite
 * serially.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, promises as fsp, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import {
  AuthCircuitBreaker,
  fingerprintCredentials,
  lookupTrippedFingerprint,
  __resetAuthLatchForTests,
  __setAuthLatchDirForTests,
} from "../src/adt/circuit-breaker.js";
import { authRearmSignalPath, consumeAuthRearmSignal } from "../src/adt/auth-latch.js";
import { GuardedHttpClient } from "../src/adt/http-guard.js";

const tmpDirs: string[] = [];

async function installLatchDir(): Promise<{ dir: string; latchPath: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "abapsmith-latch-rearm-"));
  tmpDirs.push(dir);
  __setAuthLatchDirForTests(dir);
  return { dir, latchPath: path.join(dir, "auth-latch.json") };
}

/** Unique per test: TRIPPED_FINGERPRINTS is process-wide and unclearable. */
function identityFor(testName: string): { url: string; user: string } {
  return {
    url: `http://latch-rearm-${testName}.invalid:50000`,
    user: `USER_${testName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
  };
}

afterEach(async () => {
  __resetAuthLatchForTests();
  for (const dir of tmpDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

describe("the auth latch does not heal on its own, however long we wait", () => {
  it("stays latched, and refuses both allowRequest() and allowAuthProbe(), across 15m/1h/24h/7d with no re-arm ever issued", () => {
    let t = 1_700_000_000_000;
    const b = new AuthCircuitBreaker({ now: () => t });
    b.trip("http-401", "Authentication rejected by the ABAP system (HTTP 401).", { status: 401 });
    expect(b.isTripped).toBe(true);

    for (const deltaMs of [15 * 60_000, 60 * 60_000, 24 * 60 * 60_000, 7 * 24 * 60 * 60_000]) {
      t += deltaMs;
      expect(b.allowRequest()).toBe(false);
      expect(b.allowAuthProbe()).toBe(false);
      expect(b.state).toBe("latched");
      expect(b.isTripped).toBe(true);
    }
  });
});

describe("rearmAuthProbe() admits exactly one further attempt", () => {
  it("lets the first allowAuthProbe() through after a re-arm and refuses the second, with no clock movement", () => {
    const b = new AuthCircuitBreaker();
    b.trip("http-401", "rejected", { status: 401 });

    // The very first re-arm after a trip is free — no cooldown yet.
    expect(b.rearmAuthProbe()).toEqual({ armed: true, outcome: "armed" });

    expect(b.allowAuthProbe()).toBe(true);
    expect(b.allowAuthProbe()).toBe(false);
  });

  it("does nothing on a breaker that was never latched", () => {
    const b = new AuthCircuitBreaker();
    expect(b.rearmAuthProbe()).toEqual({ armed: false, outcome: "not-latched" });
    expect(b.allowAuthProbe()).toBe(false);
  });
});

describe("a successful probe clears the latch entirely", () => {
  it("via a direct recordSuccess(): isTripped/state/allowRequest all return to normal", () => {
    const b = new AuthCircuitBreaker();
    b.trip("http-401", "rejected", { status: 401 });

    b.rearmAuthProbe();
    expect(b.allowAuthProbe()).toBe(true);
    b.recordSuccess();

    expect(b.isTripped).toBe(false);
    expect(b.state).toBe("closed");
    expect(b.allowRequest()).toBe(true);
  });

  it("via inspect() answering the probe with a 200 response", () => {
    const b = new AuthCircuitBreaker();
    b.trip("http-401", "rejected", { status: 401 });

    b.rearmAuthProbe();
    expect(b.allowAuthProbe()).toBe(true);
    b.inspect({ status: 200 });

    expect(b.isTripped).toBe(false);
    expect(b.state).toBe("closed");
    expect(b.allowRequest()).toBe(true);
  });

  it("drops the durable auth-latch.json entry and the in-memory fingerprint entry, not just isTripped", async () => {
    const { latchPath } = await installLatchDir();
    const { url, user } = identityFor("clears-durable");
    const fp = fingerprintCredentials(url, user, "pw-clears-durable");
    const b = new AuthCircuitBreaker({ credentialFingerprint: fp });
    b.trip("http-401", "rejected", { status: 401 });

    expect(lookupTrippedFingerprint(fp)).toBeDefined();
    expect(Object.keys(JSON.parse(readFileSync(latchPath, "utf8")).entries)).toHaveLength(1);

    b.rearmAuthProbe();
    b.allowAuthProbe();
    b.recordSuccess();

    expect(b.isTripped).toBe(false);
    expect(lookupTrippedFingerprint(fp)).toBeUndefined();
    expect(Object.keys(JSON.parse(readFileSync(latchPath, "utf8")).entries)).toHaveLength(0);
  });
});

describe("a failed probe keeps the latch and escalates the re-arm cooldown", () => {
  it("spends the probe on a 401, refuses an immediate re-arm as cooling-down, and admits the next one only once that window elapses", () => {
    let t = 1_700_000_000_000;
    const b = new AuthCircuitBreaker({ now: () => t });
    b.trip("http-401", "rejected", { status: 401 });

    b.rearmAuthProbe();
    expect(b.allowAuthProbe()).toBe(true);
    b.inspect({ status: 401 }); // the probe answers wrong -> failed probe
    expect(b.state).toBe("latched");
    expect(b.allowAuthProbe()).toBe(false);

    const refused = b.rearmAuthProbe();
    expect(refused.armed).toBe(false);
    expect(refused.outcome).toBe("cooling-down");
    expect(refused.msUntilRearm).toBeGreaterThan(0);
    expect(refused.rearmAt).toBeInstanceOf(Date);

    t += refused.msUntilRearm!;
    expect(b.rearmAuthProbe()).toEqual({ armed: true, outcome: "armed" });
  });

  it("makes a second failed probe's cooldown strictly longer than the first (doubling)", () => {
    let t = 1_700_000_000_000;
    const b = new AuthCircuitBreaker({ now: () => t });
    b.trip("http-401", "rejected", { status: 401 });

    b.rearmAuthProbe();
    b.allowAuthProbe();
    b.inspect({ status: 401 });
    const firstCooldown = b.rearmAuthProbe().msUntilRearm!;

    t += firstCooldown;
    b.rearmAuthProbe();
    b.allowAuthProbe();
    b.inspect({ status: 401 });
    const secondCooldown = b.rearmAuthProbe().msUntilRearm!;

    expect(secondCooldown).toBeGreaterThan(firstCooldown);
    expect(firstCooldown).toBe(15 * 60_000);
    expect(secondCooldown).toBe(30 * 60_000);
  });

  it("caps the cooldown at 4 hours and stops growing once the cap is reached", () => {
    let t = 1_700_000_000_000;
    const b = new AuthCircuitBreaker({ now: () => t });
    b.trip("http-401", "rejected", { status: 401 });
    const FOUR_HOURS_MS = 4 * 60 * 60_000;

    const cooldowns: number[] = [];
    for (let i = 0; i < 6; i++) {
      const rearm = b.rearmAuthProbe();
      expect(rearm.outcome).toBe("armed"); // clock was advanced past the prior cooldown each time
      expect(b.allowAuthProbe()).toBe(true);
      b.inspect({ status: 401 });
      const refusal = b.rearmAuthProbe();
      expect(refusal.outcome).toBe("cooling-down");
      cooldowns.push(refusal.msUntilRearm!);
      t += refusal.msUntilRearm!;
    }

    for (let i = 1; i < cooldowns.length; i++) {
      expect(cooldowns[i]).toBeGreaterThanOrEqual(cooldowns[i - 1]);
    }
    expect(cooldowns.every((ms) => ms <= FOUR_HOURS_MS)).toBe(true);
    // Cap actually reached, not just never exceeded: the last two are equal.
    expect(cooldowns.at(-1)).toBe(FOUR_HOURS_MS);
    expect(cooldowns.at(-2)).toBe(FOUR_HOURS_MS);
  });
});

describe("status() on a latched breaker always reports a way forward", () => {
  it("is terminal, with no authRearmAt/msUntilAuthRearm, when no state directory is installed", () => {
    const b = new AuthCircuitBreaker();
    b.trip("http-401", "rejected", { status: 401 });

    const status = b.status();
    expect(status.authTerminal).toBe(true);
    expect(status.authRearmAt).toBeUndefined();
    expect(status.msUntilAuthRearm).toBeUndefined();
  });

  it("reports authRearmAt/msUntilAuthRearm, and never authTerminal, once a state directory is installed", async () => {
    await installLatchDir();
    const { url, user } = identityFor("status-signal");
    const fp = fingerprintCredentials(url, user, "pw-status-signal");
    const b = new AuthCircuitBreaker({ credentialFingerprint: fp });
    b.trip("http-401", "rejected", { status: 401 });

    const status = b.status();
    expect(status.authTerminal).toBeUndefined();
    expect(status.authRearmAt).toBeInstanceOf(Date);
    expect(typeof status.msUntilAuthRearm).toBe("number");
    expect(status.authRearmSignalFile).toBe(authRearmSignalPath());
  });

  it("flips authProbeArmed true right after a re-arm and back to false once the probe is spent", () => {
    const b = new AuthCircuitBreaker();
    b.trip("http-401", "rejected", { status: 401 });

    expect(b.status().authProbeArmed).toBe(false);
    b.rearmAuthProbe();
    expect(b.status().authProbeArmed).toBe(true);
    b.allowAuthProbe();
    expect(b.status().authProbeArmed).toBe(false);
  });
});

describe("the on-disk operator re-arm signal", () => {
  it("arms exactly one probe once the auth-rearm file appears, and is consumed (deleted) the moment it is seen", async () => {
    let t = 1_700_000_000_000;
    const { dir } = await installLatchDir();
    const b = new AuthCircuitBreaker({ now: () => t });
    b.trip("http-401", "rejected", { status: 401 });

    const signalPath = authRearmSignalPath();
    expect(signalPath).toBe(path.join(dir, "auth-rearm"));

    // First read of the poll (consumes the no-throttle initial check) — file
    // doesn't exist yet.
    expect(b.authProbeArmed).toBe(false);

    writeFileSync(signalPath!, "", "utf8");
    t += 1_000; // past AUTH_REARM_POLL_MS, so the next read actually stats the file

    expect(b.authProbeArmed).toBe(true);
    expect(existsSync(signalPath!)).toBe(false);

    expect(b.allowAuthProbe()).toBe(true);
    expect(b.allowAuthProbe()).toBe(false);
  });
});

describe("consumeAuthRearmSignal()", () => {
  it("returns false and never throws when no state directory has been installed at all", () => {
    expect(() => consumeAuthRearmSignal()).not.toThrow();
    expect(consumeAuthRearmSignal()).toBe(false);
  });

  it("returns false and never throws when a state directory is installed but no signal file exists", async () => {
    await installLatchDir();
    expect(() => consumeAuthRearmSignal()).not.toThrow();
    expect(consumeAuthRearmSignal()).toBe(false);
  });
});

describe("the re-arm surface never throws", () => {
  it("on a fresh, non-latched breaker", () => {
    const b = new AuthCircuitBreaker();
    expect(() => b.rearmAuthProbe()).not.toThrow();
    expect(() => b.allowAuthProbe()).not.toThrow();
    expect(() => b.authProbeArmed).not.toThrow();
    expect(() => b.status()).not.toThrow();
  });

  it("on a latched breaker, with and without a durable state directory installed", async () => {
    const b1 = new AuthCircuitBreaker();
    b1.trip("http-401", "rejected", { status: 401 });
    expect(() => b1.rearmAuthProbe()).not.toThrow();
    expect(() => b1.allowAuthProbe()).not.toThrow();
    expect(() => b1.authProbeArmed).not.toThrow();
    expect(() => b1.status()).not.toThrow();

    await installLatchDir();
    const { url, user } = identityFor("never-throws");
    const fp = fingerprintCredentials(url, user, "pw-never-throws");
    const b2 = new AuthCircuitBreaker({ credentialFingerprint: fp });
    b2.trip("http-401", "rejected", { status: 401 });
    expect(() => b2.rearmAuthProbe()).not.toThrow();
    expect(() => b2.allowAuthProbe()).not.toThrow();
    expect(() => b2.authProbeArmed).not.toThrow();
    expect(() => b2.status()).not.toThrow();
  });
});

/** Returns a fixed status on every call; never throws, mirroring a real HttpClient. */
class FakeInnerClient implements HttpClient {
  calls: HttpClientOptions[] = [];
  constructor(private readonly respond: () => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    this.calls.push(o);
    return this.respond();
  }
}

const resp = (status: number): HttpClientResponse =>
  ({ status, statusText: String(status), body: "", headers: {} }) as unknown as HttpClientResponse;

const REQ = { url: "/sap/bc/adt/discovery", method: "GET" } as unknown as HttpClientOptions;

describe("end-to-end recovery through GuardedHttpClient, driven only by observable behaviour", () => {
  it("refuses a second request after a 401 latches the breaker, then admits exactly one request once the operator drops the re-arm signal, and refuses the one after that from the transient gate as usual", async () => {
    let t = 1_700_000_000_000;
    const { dir } = await installLatchDir();
    let nextStatus = 401;
    const inner = new FakeInnerClient(() => resp(nextStatus));
    const guard = new GuardedHttpClient(
      { baseURL: "http://x", inner },
      new AuthCircuitBreaker({ now: () => t }),
    );

    // First request: the ABAP system rejects the credentials.
    await expect(guard.request(REQ)).rejects.toThrow();
    expect(inner.calls).toHaveLength(1);

    // Second request: refused locally — never reaches the inner client.
    await expect(guard.request(REQ)).rejects.toThrow();
    expect(inner.calls).toHaveLength(1);

    // The operator fixes the credentials and drops the re-arm signal on disk.
    writeFileSync(path.join(dir, "auth-rearm"), "", "utf8");
    t += 1_000; // past the poll throttle on the injected clock
    nextStatus = 200;

    await expect(guard.request(REQ)).resolves.toBeDefined();
    expect(inner.calls).toHaveLength(2);

    // An ordinary request again, not a leftover probe admission.
    await expect(guard.request(REQ)).resolves.toBeDefined();
    expect(inner.calls).toHaveLength(3);
  });
});
