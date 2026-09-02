/**
 * The concurrency config surface — `ABAP_IDE_ID`, `ABAP_TERMINAL_ID`'s new
 * validation, `ABAP_LOCK_WAIT_MS`, `ABAP_STATE_DIR`, and the
 * five pool-sizing fields `ABAP_MAX_SESSIONS`, `ABAP_READ_CONCURRENCY`,
 * `ABAP_WRITE_CONCURRENCY`, `ABAP_SESSION_IDLE_MS`, `ABAP_SESSION_WAIT_MS` —
 * env string in, resolved `Config` field out. `ABAP_MAX_RESPONSE_CHARS` (G-36)
 * is appended at the bottom for the same reason `maxSessions` lives here: it
 * is a `.max()`-clamped ceiling, not a pool-sizing field, but this file is
 * where that test shape (accept-at-edge / throw-and-name-the-field above it)
 * already exists — a fourth config-only file would break the
 * `system-role-probe-guard.test.ts` exemption ceiling. Every new field is a two-step
 * addition (a zod field on `ConfigSchema` plus a line in `loadConfig`'s
 * `safeParse` literal) and — a hard constraint — every
 * new field MUST have `.default()` or the other fixture-building test files
 * that call `ConfigSchema.parse({…})` with no concurrency keys all fail at
 * once. This file does not touch that shared risk directly (it is
 * `loadConfig`, not `ConfigSchema.parse`, throughout), but the defaults it
 * asserts below are the same defaults that keep those files green.
 *
 * The five pool-sizing fields default to 5/2/2/300000/10000: maxSessions=5,
 * readConcurrency=2, writeConcurrency=2, sessionIdleMs=300000,
 * sessionWaitMs=10000. The five `maxSessions` slots are accounted for, not
 * slack: 2 read + 2 write + 1 reserved debug lease = 5. The ceiling itself is
 * sized against the A4H reference appliance's `rdisp/wp_no_dia = 7` dialog
 * work processes — live measurement found the queue delay already at
 * 14,075 ms with only 5 of those 7 DIA processes busy — so 5 is deliberately
 * short of the 7-process ceiling rather than pushed up against it.
 * `loadConfig` also carries a
 * warn-only coherence rule (`readConcurrency + writeConcurrency + 1 >
 * maxSessions`) that this file exercises directly below.
 *
 * `ABAP_TERMINAL_ID` previously had NO validation in `config.ts` at all — a
 * malformed value parsed cleanly here and only failed much later, deep in
 * `src/debug/endpoints.ts:801`'s `assertValidTerminalId`, on the first debug
 * call. `ABAP_IDE_ID` is new and gets the identical `/^[0-9A-F]{32}$/`
 * (SYSUUID_C32) check from the start, so both are covered here side by side
 * — the whole point is that they must fail alike, at startup, not at
 * first-use.
 *
 * Scope: this suite imports `../src/config.js` and nothing else from src. It
 * never opens a connection — see the config-only exemption in
 * `test/system-role-probe-guard.test.ts`. Keep it that way; if this file ever
 * needs a connection, a server or a SafetyGate, it belongs in another file.
 */
import { describe, expect, it } from "vitest";
import { ConfigSchema, DEFAULT_MAX_CHARS, loadConfig, redactConfigSecrets } from "../src/config.js";

/**
 * Minimal env that satisfies the required fields. `skipDotenv` keeps the real
 * `.env` out of the picture entirely, and `warn` is silenced so the suite does
 * not depend on log shape.
 */
const env = (over: Record<string, string> = {}): Record<string, string> => ({
  ABAP_URL: "http://sap.invalid:50000",
  ABAP_USER: "U",
  ABAP_PASSWORD: "p",
  ...over,
});

const VALID_IDE_ID = "C".repeat(32);
const OTHER_VALID_IDE_ID = "D".repeat(32);
const VALID_TERMINAL_ID = "A".repeat(32);

describe("config: defaults for the concurrency surface when nothing is set", () => {
  it("ideId and terminalId are undefined, lockWaitMs is 5000, stateDir is .abapsmith", () => {
    const c = loadConfig({ env: env(), warn: () => {}, skipDotenv: true });
    expect(c.ideId).toBeUndefined();
    expect(c.terminalId).toBeUndefined();
    expect(c.lockWaitMs).toBe(5000);
    expect(c.stateDir).toBe(".abapsmith");
  });

  // Shipped defaults: 5/2/2/300000/10000 — 2 read + 2 write + 1
  // reserved debug lease = 5, sized against the A4H appliance's
  // `rdisp/wp_no_dia = 7` (see the file header and `src/config.ts`'s
  // `maxSessions` doc comment for the full derivation).
  it("pool-sizing fields default to maxSessions=5, readConcurrency=2, writeConcurrency=2, sessionIdleMs=300000, sessionWaitMs=10000", () => {
    const c = loadConfig({ env: env(), warn: () => {}, skipDotenv: true });
    expect(c.maxSessions).toBe(5);
    expect(c.readConcurrency).toBe(2);
    expect(c.writeConcurrency).toBe(2);
    expect(c.sessionIdleMs).toBe(300_000);
    expect(c.sessionWaitMs).toBe(10_000);
  });
});

describe("config: pool-sizing surface — ABAP_MAX_SESSIONS / ABAP_READ_CONCURRENCY / ABAP_WRITE_CONCURRENCY / ABAP_SESSION_IDLE_MS / ABAP_SESSION_WAIT_MS", () => {
  it("an explicit numeric string for each coerces to a number, overriding the default", () => {
    const c = loadConfig({
      env: env({
        ABAP_MAX_SESSIONS: "4",
        ABAP_READ_CONCURRENCY: "3",
        ABAP_WRITE_CONCURRENCY: "2",
        ABAP_SESSION_IDLE_MS: "120000",
        ABAP_SESSION_WAIT_MS: "5000",
      }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.maxSessions).toBe(4);
    expect(c.readConcurrency).toBe(3);
    expect(c.writeConcurrency).toBe(2);
    expect(c.sessionIdleMs).toBe(120000);
    expect(c.sessionWaitMs).toBe(5000);
  });

  // Same shape rule as ABAP_LOCK_WAIT_MS (z.coerce.number().int().positive()):
  // zero and negative are fatal, and unparseable input coerces to NaN, which
  // fails .int(). Run once per field rather than five parallel describe
  // blocks — the rule and the failure mode are identical across all five.
  const fields: { envVar: string; label: string }[] = [
    { envVar: "ABAP_MAX_SESSIONS", label: "maxSessions" },
    { envVar: "ABAP_READ_CONCURRENCY", label: "readConcurrency" },
    { envVar: "ABAP_WRITE_CONCURRENCY", label: "writeConcurrency" },
    { envVar: "ABAP_SESSION_IDLE_MS", label: "sessionIdleMs" },
    { envVar: "ABAP_SESSION_WAIT_MS", label: "sessionWaitMs" },
  ];

  for (const { envVar, label } of fields) {
    it(`${envVar}: zero is fatal (.positive() excludes zero)`, () => {
      expect(() =>
        loadConfig({ env: env({ [envVar]: "0" }), warn: () => {}, skipDotenv: true }),
      ).toThrow();
    });

    it(`${envVar}: a negative value is fatal`, () => {
      expect(() =>
        loadConfig({ env: env({ [envVar]: "-1" }), warn: () => {}, skipDotenv: true }),
      ).toThrow();
    });

    it(`${envVar}: a non-numeric value is fatal`, () => {
      expect(() =>
        loadConfig({ env: env({ [envVar]: "not-a-number" }), warn: () => {}, skipDotenv: true }),
      ).toThrow();
    });

    // `loadConfig`'s safeParse literal now passes these fields through bare
    // (no `?? 1`), so zod's `.default()` is the only fallback. That change
    // does not affect an explicitly EMPTY string either way: `??` only ever
    // triggers on `null`/`undefined`, never on `""`, so an empty env value
    // was never rescued by the old fallback and still is not rescued by
    // `.default()` (which likewise only applies to `undefined`). `Number("")`
    // coerces to `0`, which `.positive()` rejects — empty must still fail,
    // not silently become the default.
    it(`${envVar}: an empty string is fatal (does not fall back to the default)`, () => {
      expect(() =>
        loadConfig({ env: env({ [envVar]: "" }), warn: () => {}, skipDotenv: true }),
      ).toThrow();
    });

    it(`${envVar}: does not affect the other four fields' defaults (${label} is set, the rest stay at 5/2/2/300000/10000)`, () => {
      const c = loadConfig({
        env: env({ [envVar]: "7" }),
        warn: () => {},
        skipDotenv: true,
      });
      const expected = { maxSessions: 5, readConcurrency: 2, writeConcurrency: 2, sessionIdleMs: 300_000, sessionWaitMs: 10_000 };
      expected[label as keyof typeof expected] = 7;
      expect(c.maxSessions).toBe(expected.maxSessions);
      expect(c.readConcurrency).toBe(expected.readConcurrency);
      expect(c.writeConcurrency).toBe(expected.writeConcurrency);
      expect(c.sessionIdleMs).toBe(expected.sessionIdleMs);
      expect(c.sessionWaitMs).toBe(expected.sessionWaitMs);
    });
  }
});

describe("config: maxSessions .max(16) clamp — the ceiling is on the pool, not on the lanes", () => {
  it("ABAP_MAX_SESSIONS=16 is accepted (the clamp's upper edge)", () => {
    const c = loadConfig({
      env: env({ ABAP_MAX_SESSIONS: "16" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.maxSessions).toBe(16);
  });

  it("ABAP_MAX_SESSIONS=17 is rejected — loadConfig throws and names the field", () => {
    expect(() =>
      loadConfig({ env: env({ ABAP_MAX_SESSIONS: "17" }), warn: () => {}, skipDotenv: true }),
    ).toThrow(/maxSessions/);
  });

  // The `.max(16)` ceiling lives on `maxSessions` ONLY — `readConcurrency`
  // and `writeConcurrency` are `z.coerce.number().int().positive()` with no
  // upper bound at all (see `src/config.ts`). A generous lane limit is
  // legal even when it dwarfs the pool; the coherence warning below is the
  // only feedback an operator gets, and it never throws.
  it("ABAP_READ_CONCURRENCY=64 is accepted — lane limits have no upper bound", () => {
    const c = loadConfig({
      env: env({ ABAP_READ_CONCURRENCY: "64" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.readConcurrency).toBe(64);
  });
});

describe("config: readConcurrency + writeConcurrency + 1 > maxSessions — warn-only coherence rule", () => {
  it("the shipped defaults satisfy the rule exactly (2 + 2 + 1 === 5) — no warning", () => {
    const warnings: string[] = [];
    const c = loadConfig({ env: env(), warn: (m) => warnings.push(m), skipDotenv: true });
    expect(c.maxSessions).toBe(5);
    expect(c.readConcurrency).toBe(2);
    expect(c.writeConcurrency).toBe(2);
    expect(warnings.join("\n")).not.toContain("reserved debug lease slot");
  });

  it("an explicit config that exactly satisfies the rule (2 + 1 + 1 === 4) does not warn", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({
        ABAP_MAX_SESSIONS: "4",
        ABAP_READ_CONCURRENCY: "2",
        ABAP_WRITE_CONCURRENCY: "1",
      }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).not.toContain("reserved debug lease slot");
  });

  // Warn-only, deliberately not a hard failure: the lane limits are not
  // clamped to the pool size, so over-subscription only degrades to queuing
  // for the smaller number of actual slots — it cannot corrupt anything.
  // Turning this into a `.refine()`/`.superRefine()` throw would convert a
  // survivable misconfiguration into a startup outage over something the
  // server can still run correctly, just more slowly.
  it("a violating config (2 + 2 + 1 = 5 > 2) warns AND still returns a usable config, unchanged and unclamped", () => {
    const warnings: string[] = [];
    const c = loadConfig({
      env: env({
        ABAP_MAX_SESSIONS: "2",
        ABAP_READ_CONCURRENCY: "2",
        ABAP_WRITE_CONCURRENCY: "2",
      }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    // 1. The warning fires.
    expect(warnings.join("\n")).toContain(
      "reserved debug lease slot exceeds maxSessions",
    );
    // 2. It does NOT throw (already implicit in reaching this line without a
    // catch) and the returned config is exactly what was written — not
    // clamped, not rejected, fully usable.
    expect(c.maxSessions).toBe(2);
    expect(c.readConcurrency).toBe(2);
    expect(c.writeConcurrency).toBe(2);
  });

  it("the warning message interpolates the actual offending numbers, not placeholders", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({
        ABAP_MAX_SESSIONS: "2",
        ABAP_READ_CONCURRENCY: "2",
        ABAP_WRITE_CONCURRENCY: "2",
      }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    const joined = warnings.join("\n");
    expect(joined).toContain("readConcurrency (2)");
    expect(joined).toContain("writeConcurrency (2)");
    expect(joined).toContain("maxSessions (2)");
  });
});

describe("config: ABAP_IDE_ID / ABAP_TERMINAL_ID — SYSUUID_C32 validation (endpoints.ts:801)", () => {
  it("a valid 32-uppercase-hex ABAP_IDE_ID is accepted verbatim", () => {
    const c = loadConfig({
      env: env({ ABAP_IDE_ID: VALID_IDE_ID }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.ideId).toBe(VALID_IDE_ID);
  });

  it("a valid 32-uppercase-hex ABAP_TERMINAL_ID is accepted verbatim", () => {
    const c = loadConfig({
      env: env({ ABAP_TERMINAL_ID: VALID_TERMINAL_ID }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.terminalId).toBe(VALID_TERMINAL_ID);
  });

  // Both env vars share the same shape rule, so the same five malformed
  // inputs are run against each — that symmetry is the point: before this
  // change ABAP_TERMINAL_ID silently accepted every one of these and blew up
  // later, deep inside the debug tool, instead of at startup like ABAP_IDE_ID.
  const badValues: { label: string; value: string }[] = [
    { label: "31 chars (one short)", value: "A".repeat(31) },
    { label: "33 chars (one long)", value: "A".repeat(33) },
    { label: "lowercase hex", value: "a".repeat(32) },
    { label: "32 non-hex chars", value: "Z".repeat(32) },
    { label: "empty string", value: "" },
  ];

  for (const { label, value } of badValues) {
    it(`rejects ABAP_IDE_ID: ${label}`, () => {
      expect(() =>
        loadConfig({ env: env({ ABAP_IDE_ID: value }), warn: () => {}, skipDotenv: true }),
      ).toThrow(/ABAP_IDE_ID/);
    });

    it(`rejects ABAP_TERMINAL_ID: ${label}`, () => {
      expect(() =>
        loadConfig({ env: env({ ABAP_TERMINAL_ID: value }), warn: () => {}, skipDotenv: true }),
      ).toThrow(/ABAP_TERMINAL_ID/);
    });
  }
});

describe("config: ABAP_LOCK_WAIT_MS — z.coerce.number().int().positive().default(5_000)", () => {
  it("a valid numeric string coerces to a number", () => {
    const c = loadConfig({
      env: env({ ABAP_LOCK_WAIT_MS: "12345" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.lockWaitMs).toBe(12345);
  });

  // .positive() rejects zero outright — confirmed against the schema, not
  // assumed: "positive" excludes 0, unlike "nonnegative".
  it("zero is fatal (.positive() excludes zero)", () => {
    expect(() =>
      loadConfig({ env: env({ ABAP_LOCK_WAIT_MS: "0" }), warn: () => {}, skipDotenv: true }),
    ).toThrow();
  });

  it("a negative value is fatal", () => {
    expect(() =>
      loadConfig({ env: env({ ABAP_LOCK_WAIT_MS: "-1" }), warn: () => {}, skipDotenv: true }),
    ).toThrow();
  });

  it("a non-numeric value is fatal (z.coerce.number() on unparseable input yields NaN, which fails .int())", () => {
    expect(() =>
      loadConfig({ env: env({ ABAP_LOCK_WAIT_MS: "not-a-number" }), warn: () => {}, skipDotenv: true }),
    ).toThrow();
  });
});

describe("config: ABAP_STATE_DIR — z.string().default(\".abapsmith\")", () => {
  it("an explicit value wins over the default", () => {
    const c = loadConfig({
      env: env({ ABAP_STATE_DIR: "/tmp/my-state" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.stateDir).toBe("/tmp/my-state");
  });

  // NOTE: `config.ts` carries the string exactly as given — resolving it to
  // an absolute path (against cwd, defaulting to `<cwd>/.abapsmith`) is
  // `resolveStateDir` in src/state-dir.ts, not this module. A RELATIVE
  // ABAP_STATE_DIR therefore stays relative here; this file only pins
  // "explicit value wins", not path resolution.
  it("a relative explicit value is carried through unresolved", () => {
    const c = loadConfig({
      env: env({ ABAP_STATE_DIR: "custom-state" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.stateDir).toBe("custom-state");
  });
});

describe("config: redactConfigSecrets — terminalId/ideId/stateDir/lockWaitMs projection", () => {
  it('shows "(derived)" for terminalId and ideId when neither is set', () => {
    const c = loadConfig({ env: env(), warn: () => {}, skipDotenv: true });
    const redacted = redactConfigSecrets(c);
    expect(redacted.terminalId).toBe("(derived)");
    expect(redacted.ideId).toBe("(derived)");
  });

  it("shows the real value for terminalId/ideId when set — SYSUUID_C32 identifiers already sent on the wire, not secrets", () => {
    const c = loadConfig({
      env: env({ ABAP_TERMINAL_ID: VALID_TERMINAL_ID, ABAP_IDE_ID: OTHER_VALID_IDE_ID }),
      warn: () => {},
      skipDotenv: true,
    });
    const redacted = redactConfigSecrets(c);
    expect(redacted.terminalId).toBe(VALID_TERMINAL_ID);
    expect(redacted.ideId).toBe(OTHER_VALID_IDE_ID);
  });

  it("carries stateDir and lockWaitMs into the redacted projection", () => {
    const c = loadConfig({
      env: env({ ABAP_STATE_DIR: "/tmp/my-state", ABAP_LOCK_WAIT_MS: "9999" }),
      warn: () => {},
      skipDotenv: true,
    });
    const redacted = redactConfigSecrets(c);
    expect(redacted.stateDir).toBe("/tmp/my-state");
    expect(redacted.lockWaitMs).toBe(9999);
  });

  it("carries the pool-sizing fields into the redacted projection, defaults and overrides alike", () => {
    const defaults = redactConfigSecrets(loadConfig({ env: env(), warn: () => {}, skipDotenv: true }));
    expect(defaults.maxSessions).toBe(5);
    expect(defaults.readConcurrency).toBe(2);
    expect(defaults.writeConcurrency).toBe(2);
    expect(defaults.sessionIdleMs).toBe(300_000);
    expect(defaults.sessionWaitMs).toBe(10_000);

    const overridden = redactConfigSecrets(
      loadConfig({
        env: env({
          ABAP_MAX_SESSIONS: "4",
          ABAP_READ_CONCURRENCY: "3",
          ABAP_WRITE_CONCURRENCY: "2",
          ABAP_SESSION_IDLE_MS: "120000",
          ABAP_SESSION_WAIT_MS: "5000",
        }),
        warn: () => {},
        skipDotenv: true,
      }),
    );
    expect(overridden.maxSessions).toBe(4);
    expect(overridden.readConcurrency).toBe(3);
    expect(overridden.writeConcurrency).toBe(2);
    expect(overridden.sessionIdleMs).toBe(120000);
    expect(overridden.sessionWaitMs).toBe(5000);
  });

  it("password is still redacted to *** regardless of the new fields", () => {
    const c = loadConfig({
      env: env({
        ABAP_PASSWORD: "s3cr3t-do-not-log",
        ABAP_TERMINAL_ID: VALID_TERMINAL_ID,
        ABAP_IDE_ID: OTHER_VALID_IDE_ID,
      }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(redactConfigSecrets(c).password).toBe("***");
    expect(JSON.stringify(redactConfigSecrets(c))).not.toContain("s3cr3t-do-not-log");
  });
});

describe("config: warns when ABAP_IDE_ID equals ABAP_TERMINAL_ID — defeats the point of overriding either", () => {
  it("fires when both are set to the SAME value", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_IDE_ID: VALID_TERMINAL_ID, ABAP_TERMINAL_ID: VALID_TERMINAL_ID }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).toContain(
      "a second global-scope listener for the same SAP user with a DIFFERENT (terminalId, ideId) pair is rejected server-side",
    );
  });

  it("does not fire when both are unset", () => {
    const warnings: string[] = [];
    loadConfig({ env: env(), warn: (m) => warnings.push(m), skipDotenv: true });
    expect(warnings.join("\n")).not.toContain("ABAP_IDE_ID is set to the same value");
  });

  it("does not fire when they differ", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_IDE_ID: VALID_IDE_ID, ABAP_TERMINAL_ID: VALID_TERMINAL_ID }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).not.toContain("ABAP_IDE_ID is set to the same value");
  });

  it("does not fire when only ABAP_IDE_ID is set (no ABAP_TERMINAL_ID to collide with)", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_IDE_ID: VALID_IDE_ID }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).not.toContain("ABAP_IDE_ID is set to the same value");
  });
});

describe("config: ABAP_DEBUG_DIA_BUDGET — z.coerce.number().int().nonnegative().default(2)", () => {
  // THE CRITICAL ONE. This field MUST stay `.default()`-ed: ~29
  // `ConfigSchema.parse` fixture sites across the suite construct a Config
  // without ever mentioning debugDiaBudget. If this field ever became
  // required (default dropped), every one of those sites would start
  // throwing at once — asserted directly against the schema, not only
  // through loadConfig, so a dropped default fails here first.
  it("ConfigSchema.parse with no debugDiaBudget key still yields 2 (the .default() survives)", () => {
    const parsed = ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "U",
      password: "p",
    });
    expect(parsed.debugDiaBudget).toBe(2);
  });

  it("loadConfig with nothing set yields debugDiaBudget=2", () => {
    const c = loadConfig({ env: env(), warn: () => {}, skipDotenv: true });
    expect(c.debugDiaBudget).toBe(2);
  });

  it("an explicit numeric string coerces to the number 4, not the string", () => {
    const c = loadConfig({
      env: env({ ABAP_DEBUG_DIA_BUDGET: "4" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.debugDiaBudget).toBe(4);
    expect(typeof c.debugDiaBudget).toBe("number");
  });

  // .nonnegative() rather than .positive(): 0 is a legal value and is the
  // kill switch that disables debugging outright, so it must not be a
  // config error. 1 is also below the cost of 2 (also effectively a
  // disable/degrade) but is likewise a plain legal value.
  it("ABAP_DEBUG_DIA_BUDGET=0 parses successfully and yields 0 (the kill switch)", () => {
    const c = loadConfig({
      env: env({ ABAP_DEBUG_DIA_BUDGET: "0" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.debugDiaBudget).toBe(0);
  });

  it("ABAP_DEBUG_DIA_BUDGET=1 parses successfully and yields 1", () => {
    const c = loadConfig({
      env: env({ ABAP_DEBUG_DIA_BUDGET: "1" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.debugDiaBudget).toBe(1);
  });

  it("a negative value is fatal", () => {
    expect(() =>
      loadConfig({ env: env({ ABAP_DEBUG_DIA_BUDGET: "-1" }), warn: () => {}, skipDotenv: true }),
    ).toThrow();
  });

  it("a non-integer value is fatal", () => {
    expect(() =>
      loadConfig({ env: env({ ABAP_DEBUG_DIA_BUDGET: "2.5" }), warn: () => {}, skipDotenv: true }),
    ).toThrow();
  });

  it("a non-numeric value is fatal", () => {
    expect(() =>
      loadConfig({ env: env({ ABAP_DEBUG_DIA_BUDGET: "lots" }), warn: () => {}, skipDotenv: true }),
    ).toThrow();
  });

  it("setting ABAP_DEBUG_DIA_BUDGET does not perturb the other pool defaults", () => {
    const c = loadConfig({
      env: env({ ABAP_DEBUG_DIA_BUDGET: "4" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.maxSessions).toBe(5);
    expect(c.readConcurrency).toBe(2);
    expect(c.writeConcurrency).toBe(2);
    expect(c.sessionIdleMs).toBe(300_000);
    expect(c.sessionWaitMs).toBe(10_000);
  });

  it("setting the other pool vars does not perturb debugDiaBudget's default", () => {
    const c = loadConfig({
      env: env({
        ABAP_MAX_SESSIONS: "4",
        ABAP_READ_CONCURRENCY: "3",
        ABAP_WRITE_CONCURRENCY: "2",
        ABAP_SESSION_IDLE_MS: "120000",
        ABAP_SESSION_WAIT_MS: "5000",
      }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.debugDiaBudget).toBe(2);
  });

  // redactConfigSecrets is an explicit allowlist — omitting the line for
  // debugDiaBudget would make the field silently invisible in diagnostics
  // even though loadConfig resolves it correctly.
  it("redactConfigSecrets carries debugDiaBudget for both the default and an override", () => {
    const defaults = redactConfigSecrets(loadConfig({ env: env(), warn: () => {}, skipDotenv: true }));
    expect(defaults.debugDiaBudget).toBe(2);

    const overridden = redactConfigSecrets(
      loadConfig({
        env: env({ ABAP_DEBUG_DIA_BUDGET: "4" }),
        warn: () => {},
        skipDotenv: true,
      }),
    );
    expect(overridden.debugDiaBudget).toBe(4);
  });

  // Non-regression guard: adding this field must not have disturbed
  // terminalId/ideId defaulting or their redaction.
  it("does not change terminalId/ideId defaulting or redaction", () => {
    const c = loadConfig({ env: env(), warn: () => {}, skipDotenv: true });
    expect(c.terminalId).toBeUndefined();
    expect(c.ideId).toBeUndefined();
    const redacted = redactConfigSecrets(c);
    expect(redacted.terminalId).toBe("(derived)");
    expect(redacted.ideId).toBe("(derived)");
  });
});

// G-36: maxResponseChars's default must be compact.ts's DEFAULT_MAX_CHARS,
// not a second independent literal, and the ceiling must reject values high
// enough to defeat the truncation rule the README promises.
describe("config: maxResponseChars default is compact.ts's DEFAULT_MAX_CHARS, not a second literal", () => {
  it("defaults to exactly DEFAULT_MAX_CHARS when ABAP_MAX_RESPONSE_CHARS is unset", () => {
    const c = loadConfig({ env: env(), warn: () => {}, skipDotenv: true });
    expect(c.maxResponseChars).toBe(DEFAULT_MAX_CHARS);
  });
});

describe("config: maxResponseChars .max(200_000) clamp — G-36", () => {
  it("ABAP_MAX_RESPONSE_CHARS=200000 is accepted (the clamp's upper edge)", () => {
    const c = loadConfig({
      env: env({ ABAP_MAX_RESPONSE_CHARS: "200000" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.maxResponseChars).toBe(200_000);
  });

  it("ABAP_MAX_RESPONSE_CHARS=200001 is rejected — loadConfig throws and names the field", () => {
    expect(() =>
      loadConfig({
        env: env({ ABAP_MAX_RESPONSE_CHARS: "200001" }),
        warn: () => {},
        skipDotenv: true,
      }),
    ).toThrow(/ABAP_MAX_RESPONSE_CHARS/);
  });

  it("ABAP_MAX_RESPONSE_CHARS=999999999 (the disable-truncation case from G-36) is rejected", () => {
    expect(() =>
      loadConfig({
        env: env({ ABAP_MAX_RESPONSE_CHARS: "999999999" }),
        warn: () => {},
        skipDotenv: true,
      }),
    ).toThrow(/ABAP_MAX_RESPONSE_CHARS/);
  });

  it("a normal in-range override is still honoured", () => {
    const c = loadConfig({
      env: env({ ABAP_MAX_RESPONSE_CHARS: "80000" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.maxResponseChars).toBe(80_000);
  });
});

// The plumbing fix here: ABAP_CROSS_PROCESS_DEBUG_LOCK and
// ABAP_DEBUG_LOCK_WAIT_MS used to be read directly off `process.env` by
// `resolveCrossProcessDebugLock`/`resolveDebugLockWaitMs`
// (`src/debug/arm-lock.ts`), bypassing this schema entirely — unvalidated,
// unreported by `redactConfigSecrets`, undiscoverable by anyone reading
// `ConfigSchema`. This section pins that both are now read through the
// config layer with EXACTLY the same truth table those two functions already
// had: this is plumbing, not a behaviour change.
describe("config: ABAP_CROSS_PROCESS_DEBUG_LOCK — read through the config layer, default true", () => {
  it("ConfigSchema.parse with no crossProcessDebugLock key still yields true (the default survives)", () => {
    const parsed = ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "U",
      password: "p",
    });
    expect(parsed.crossProcessDebugLock).toBe(true);
  });

  it("loadConfig with nothing set yields crossProcessDebugLock=true", () => {
    const c = loadConfig({ env: env(), warn: () => {}, skipDotenv: true });
    expect(c.crossProcessDebugLock).toBe(true);
  });

  // Reject-list semantics, matching `resolveCrossProcessDebugLock` verbatim:
  // only these four (case-insensitively, trimmed) opt out. Everything else —
  // including nonsense strings — stays on.
  const offValues = ["false", "0", "no", "off", "FALSE", "Off", " off "];
  for (const v of offValues) {
    it(`ABAP_CROSS_PROCESS_DEBUG_LOCK=${JSON.stringify(v)} resolves to false`, () => {
      const c = loadConfig({
        env: env({ ABAP_CROSS_PROCESS_DEBUG_LOCK: v }),
        warn: () => {},
        skipDotenv: true,
      });
      expect(c.crossProcessDebugLock).toBe(false);
    });
  }

  const onValues = ["true", "1", "yes", "on", "", "anything-else"];
  for (const v of onValues) {
    it(`ABAP_CROSS_PROCESS_DEBUG_LOCK=${JSON.stringify(v)} resolves to true`, () => {
      const c = loadConfig({
        env: env({ ABAP_CROSS_PROCESS_DEBUG_LOCK: v }),
        warn: () => {},
        skipDotenv: true,
      });
      expect(c.crossProcessDebugLock).toBe(true);
    });
  }

  it("redactConfigSecrets surfaces crossProcessDebugLock — the whole point of moving it here", () => {
    const defaults = redactConfigSecrets(loadConfig({ env: env(), warn: () => {}, skipDotenv: true }));
    expect(defaults.crossProcessDebugLock).toBe(true);

    const overridden = redactConfigSecrets(
      loadConfig({
        env: env({ ABAP_CROSS_PROCESS_DEBUG_LOCK: "false" }),
        warn: () => {},
        skipDotenv: true,
      }),
    );
    expect(overridden.crossProcessDebugLock).toBe(false);
  });

  it("does not perturb the pool-sizing or debugDiaBudget defaults", () => {
    const c = loadConfig({
      env: env({ ABAP_CROSS_PROCESS_DEBUG_LOCK: "false" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.maxSessions).toBe(5);
    expect(c.debugDiaBudget).toBe(2);
  });
});

describe("config: ABAP_DEBUG_LOCK_WAIT_MS — read through the config layer, default 1500, soft-fallback out of range", () => {
  it("ConfigSchema.parse with no debugLockWaitMs key still yields 1500 (the default survives)", () => {
    const parsed = ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "U",
      password: "p",
    });
    expect(parsed.debugLockWaitMs).toBe(1500);
  });

  it("loadConfig with nothing set yields debugLockWaitMs=1500", () => {
    const c = loadConfig({ env: env(), warn: () => {}, skipDotenv: true });
    expect(c.debugLockWaitMs).toBe(1500);
  });

  it("an in-range explicit value is honoured", () => {
    const c = loadConfig({
      env: env({ ABAP_DEBUG_LOCK_WAIT_MS: "5000" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.debugLockWaitMs).toBe(5000);
  });

  // Soft fallback, NOT a startup failure — the opposite of ABAP_LOCK_WAIT_MS
  // above. Matches `resolveDebugLockWaitMs`'s own reasoning: clamping a
  // too-small value up to 200 would look like the setting took effect when
  // it did not, so out-of-range/unparseable silently falls back to 1500
  // instead of throwing.
  it("below the 200ms floor falls back to the default rather than throwing or clamping", () => {
    const c = loadConfig({
      env: env({ ABAP_DEBUG_LOCK_WAIT_MS: "50" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.debugLockWaitMs).toBe(1500);
  });

  it("above the 30000ms ceiling falls back to the default rather than throwing or clamping", () => {
    const c = loadConfig({
      env: env({ ABAP_DEBUG_LOCK_WAIT_MS: "60000" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.debugLockWaitMs).toBe(1500);
  });

  it("a non-numeric value falls back to the default rather than throwing", () => {
    const c = loadConfig({
      env: env({ ABAP_DEBUG_LOCK_WAIT_MS: "not-a-number" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.debugLockWaitMs).toBe(1500);
  });

  it("redactConfigSecrets surfaces debugLockWaitMs — the whole point of moving it here", () => {
    const defaults = redactConfigSecrets(loadConfig({ env: env(), warn: () => {}, skipDotenv: true }));
    expect(defaults.debugLockWaitMs).toBe(1500);

    const overridden = redactConfigSecrets(
      loadConfig({
        env: env({ ABAP_DEBUG_LOCK_WAIT_MS: "3000" }),
        warn: () => {},
        skipDotenv: true,
      }),
    );
    expect(overridden.debugLockWaitMs).toBe(3000);
  });
});

// The same plumbing fix, in the exact same shape as the debug-lock fix above:
// ABAP_CROSS_PROCESS_OBJECT_LOCK and ABAP_OBJECT_LOCK_WAIT_MS used to be read
// directly off `process.env` by `resolveCrossProcessObjectLock`/
// `resolveObjectLockWaitMs` (`src/adt/object-gate.ts`), bypassing this schema
// entirely — unvalidated, unreported by `redactConfigSecrets`, undiscoverable by
// anyone reading `ConfigSchema`. This section pins that both are now read
// through the config layer with EXACTLY the same truth table those two
// functions already had — `boolishRejectDefaultTrue` and
// `softBoundedMsSchema(1_500, 200, 30_000)` are the identical helpers the
// debug-lock fields above already use, so this is plumbing, not a behaviour
// change. `resolveCrossProcessObjectLock`/`resolveObjectLockWaitMs` remain the
// resolvers of record for callers that construct the cross-process object
// gate without a fully parsed `Config`; this file and those functions are
// kept in lockstep by `test/object-gate-config-equivalence.test.ts`, not by
// one calling the other.
describe("config: ABAP_CROSS_PROCESS_OBJECT_LOCK — read through the config layer, default true", () => {
  it("ConfigSchema.parse with no crossProcessObjectLock key still yields true (the default survives)", () => {
    const parsed = ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "U",
      password: "p",
    });
    expect(parsed.crossProcessObjectLock).toBe(true);
  });

  it("loadConfig with nothing set yields crossProcessObjectLock=true", () => {
    const c = loadConfig({ env: env(), warn: () => {}, skipDotenv: true });
    expect(c.crossProcessObjectLock).toBe(true);
  });

  // Reject-list semantics, matching `resolveCrossProcessObjectLock` verbatim:
  // only these four (case-insensitively, trimmed) opt out. Everything else —
  // including nonsense strings — stays on.
  const offValues = ["false", "0", "no", "off", "OFF", "False", " off "];
  for (const v of offValues) {
    it(`ABAP_CROSS_PROCESS_OBJECT_LOCK=${JSON.stringify(v)} resolves to false`, () => {
      const c = loadConfig({
        env: env({ ABAP_CROSS_PROCESS_OBJECT_LOCK: v }),
        warn: () => {},
        skipDotenv: true,
      });
      expect(c.crossProcessObjectLock).toBe(false);
    });
  }

  const onValues = ["true", "1", "yes", "on", "", "maybe"];
  for (const v of onValues) {
    it(`ABAP_CROSS_PROCESS_OBJECT_LOCK=${JSON.stringify(v)} resolves to true`, () => {
      const c = loadConfig({
        env: env({ ABAP_CROSS_PROCESS_OBJECT_LOCK: v }),
        warn: () => {},
        skipDotenv: true,
      });
      expect(c.crossProcessObjectLock).toBe(true);
    });
  }

  // The whole point of this fix: this switch used to be invisible to
  // `redactConfigSecrets` entirely, so a cross-process concurrency guard could be
  // silently off with no trace in the config report. It must now show up as
  // the plain boolean itself, not a mask string like "***" — unlike secrets
  // (password, etc.), this is a behavioural switch an operator needs to be
  // able to read at a glance, not a credential to hide.
  it("redactConfigSecrets surfaces crossProcessObjectLock, unmasked, for both the default and an override", () => {
    const defaults = redactConfigSecrets(loadConfig({ env: env(), warn: () => {}, skipDotenv: true }));
    expect(defaults.crossProcessObjectLock).toBe(true);
    expect(typeof defaults.crossProcessObjectLock).toBe("boolean");

    const overridden = redactConfigSecrets(
      loadConfig({
        env: env({ ABAP_CROSS_PROCESS_OBJECT_LOCK: "false" }),
        warn: () => {},
        skipDotenv: true,
      }),
    );
    expect(overridden.crossProcessObjectLock).toBe(false);
    expect(typeof overridden.crossProcessObjectLock).toBe("boolean");
  });

  it("does not perturb the pool-sizing or debugDiaBudget defaults", () => {
    const c = loadConfig({
      env: env({ ABAP_CROSS_PROCESS_OBJECT_LOCK: "false" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.maxSessions).toBe(5);
    expect(c.debugDiaBudget).toBe(2);
  });
});

describe("config: ABAP_OBJECT_LOCK_WAIT_MS — read through the config layer, default 1500, soft-fallback out of range", () => {
  it("ConfigSchema.parse with no objectLockWaitMs key still yields 1500 (the default survives)", () => {
    const parsed = ConfigSchema.parse({
      url: "http://sap.invalid:50000",
      user: "U",
      password: "p",
    });
    expect(parsed.objectLockWaitMs).toBe(1500);
  });

  it("loadConfig with nothing set yields objectLockWaitMs=1500", () => {
    const c = loadConfig({ env: env(), warn: () => {}, skipDotenv: true });
    expect(c.objectLockWaitMs).toBe(1500);
  });

  it("an in-range explicit value is honoured", () => {
    const c = loadConfig({
      env: env({ ABAP_OBJECT_LOCK_WAIT_MS: "5000" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.objectLockWaitMs).toBe(5000);
  });

  // Soft fallback, NOT a startup failure — matches `resolveObjectLockWaitMs`'s
  // own reasoning: clamping a too-small value up to 200 would look like the
  // setting took effect when it did not, so out-of-range/unparseable silently
  // falls back to 1500 instead of throwing. 199 is one below the 200ms floor,
  // the exact boundary `softBoundedMsSchema` rejects.
  it("below the 200ms floor (199) falls back to the default rather than throwing or clamping", () => {
    const c = loadConfig({
      env: env({ ABAP_OBJECT_LOCK_WAIT_MS: "199" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.objectLockWaitMs).toBe(1500);
  });

  // 30001 is one above the 30000ms ceiling, the exact boundary on the other side.
  it("above the 30000ms ceiling (30001) falls back to the default rather than throwing or clamping", () => {
    const c = loadConfig({
      env: env({ ABAP_OBJECT_LOCK_WAIT_MS: "30001" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.objectLockWaitMs).toBe(1500);
  });

  it("a non-numeric value falls back to the default rather than throwing", () => {
    const c = loadConfig({
      env: env({ ABAP_OBJECT_LOCK_WAIT_MS: "abc" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.objectLockWaitMs).toBe(1500);
  });

  it("an empty string falls back to the default rather than throwing", () => {
    const c = loadConfig({
      env: env({ ABAP_OBJECT_LOCK_WAIT_MS: "" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.objectLockWaitMs).toBe(1500);
  });

  it("redactConfigSecrets surfaces objectLockWaitMs, unmasked, for both the default and an override", () => {
    const defaults = redactConfigSecrets(loadConfig({ env: env(), warn: () => {}, skipDotenv: true }));
    expect(defaults.objectLockWaitMs).toBe(1500);

    const overridden = redactConfigSecrets(
      loadConfig({
        env: env({ ABAP_OBJECT_LOCK_WAIT_MS: "3000" }),
        warn: () => {},
        skipDotenv: true,
      }),
    );
    expect(overridden.objectLockWaitMs).toBe(3000);
  });
});

// Counterpart to the debug-lock section's independence from pool sizing
// above: now that both a cross-process object gate and a cross-process debug
// lock switch exist side by side, they must not be wired to the same env var
// or accidentally share resolution state. Setting one must leave the other at
// its own independent default.
describe("config: ABAP_CROSS_PROCESS_OBJECT_LOCK and ABAP_CROSS_PROCESS_DEBUG_LOCK are independent switches", () => {
  it("turning off the object gate leaves the debug lock at its own default (and vice versa is covered above)", () => {
    const c = loadConfig({
      env: env({ ABAP_CROSS_PROCESS_OBJECT_LOCK: "false" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.crossProcessObjectLock).toBe(false);
    expect(c.crossProcessDebugLock).toBe(true);
  });
});
