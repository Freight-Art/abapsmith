/**
 * The byte-for-byte equivalence proof for moving
 * `ABAP_CROSS_PROCESS_OBJECT_LOCK` and `ABAP_OBJECT_LOCK_WAIT_MS` into
 * `ConfigSchema`.
 *
 * Both used to be read straight off `process.env` inside
 * `src/adt/object-gate.ts` (`resolveCrossProcessObjectLock`,
 * `resolveObjectLockWaitMs`), bypassing `src/config.ts` entirely: unvalidated,
 * undefaulted by the schema, and — the part that actually bites — absent from
 * `redactConfigSecrets()`'s effective-configuration report. For an ordinary cosmetic
 * flag that is a minor gap. For `ABAP_CROSS_PROCESS_OBJECT_LOCK` it is worse,
 * because the setting gates a CROSS-PROCESS concurrency guard: the failure
 * mode of the gap is a lock that is silently off with no visible trace
 * anywhere an operator would look.
 *
 * The earlier debug-lock migration did exactly this for the two debug-arm-lock equivalents and
 * left `boolishRejectDefaultTrue` / `softBoundedMsSchema` behind for the
 * purpose. This file is the thing that makes reusing them safe rather than
 * merely plausible.
 *
 * WHY THIS FILE EXISTS AT ALL, rather than "the helpers obviously match":
 * this migration is explicit that equivalence here is to be PROVEN, not assumed —
 * the debug side was verified byte-for-byte before/after, and nobody had done
 * that for `object-gate.ts`. So this suite runs BOTH implementations over one
 * shared input matrix and asserts equality per row. It deliberately does not
 * assert the expected value only on the new path: an expectation table written
 * by hand can be wrong in the same direction as the code it checks. Comparing
 * old-vs-new over the same input cannot.
 *
 * The matrix covers every input class the issue named — unset, empty string,
 * whitespace-only, valid, invalid, out-of-range low, out-of-range high, mixed
 * case, surrounding whitespace, and the exact `false`/`0`/`no`/`off` reject
 * set — plus the JS `Number()` traps that a hand-derived truth table gets
 * wrong (`"0x1F4"` is 500, not NaN; `"1_500"` is NaN, not 1500; `"-0"` is not
 * caught by the `n < 0` guard but is caught by the range check one step
 * later).
 *
 * These two functions are kept in lockstep BY THIS TEST, not by one calling
 * the other. `config.ts` is parsed before `src/adt` exists and must not import
 * from it, exactly as it must not import from `src/debug` for the debug pair.
 *
 * Offline only: no wire interaction, no state dir, no SAP system. Nothing here
 * touches locking semantics — this migration is about visibility and validation,
 * and the object gate's own behaviour is explicitly not in scope.
 */
import { describe, it, expect } from "vitest";

import { loadConfig, redactConfigSecrets } from "../src/config.js";
import {
  resolveCrossProcessObjectLock,
  resolveObjectLockWaitMs,
} from "../src/adt/object-gate.js";

/**
 * Minimal env that `loadConfig` accepts, matching the shape
 * `test/config-concurrency.test.ts` uses. `skipDotenv: true` on every call
 * below is load-bearing: without it `loadConfig` reads the repo's real `.env`
 * and the matrix would be testing the developer's machine rather than the
 * input under test.
 */
const baseEnv = (over: Record<string, string> = {}): Record<string, string> => ({
  ABAP_URL: "http://sap.invalid:50000",
  ABAP_USER: "U",
  ABAP_PASSWORD: "p",
  ...over,
});

/**
 * One row's worth of "what does the config layer say". `raw === undefined`
 * means the variable is genuinely absent, which is a different input from the
 * empty string and has to be exercised as such — omitting the key, not setting
 * it to `""`.
 */
function viaSchema(varName: string, raw: string | undefined): ReturnType<typeof loadConfig> {
  const over = raw === undefined ? {} : { [varName]: raw };
  return loadConfig({ env: baseEnv(over), warn: () => {}, skipDotenv: true });
}

/** The same input, fed to the pre-existing `process.env` resolver directly. */
function viaResolverEnv(varName: string, raw: string | undefined): NodeJS.ProcessEnv {
  return (raw === undefined ? {} : { [varName]: raw }) as NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// 1. ABAP_CROSS_PROCESS_OBJECT_LOCK — boolean, reject-list, default true
// ---------------------------------------------------------------------------

/**
 * Every input class this equivalence check must cover, plus the near-misses that a reject-list
 * implemented with `.includes()` on a substring rather than an exact array
 * membership test would get wrong: `"falsey"` is not `"false"`, `"00"` is not
 * `"0"`, `"nope"` is not `"no"`. Those three are the regression this shape of
 * helper is most likely to acquire, so they are pinned explicitly.
 */
const BOOL_INPUTS: (string | undefined)[] = [
  // unset / empty / whitespace-only
  undefined,
  "",
  "   ",
  "\t\n",
  // the exact reject set, lower case
  "false",
  "0",
  "no",
  "off",
  // the exact reject set, mixed and upper case
  "FALSE",
  "False",
  "NO",
  "OFF",
  "OfF",
  "No",
  // reject set with surrounding whitespace (trim must run before the match)
  " false ",
  " 0 ",
  "  no",
  "off  ",
  "\tfalse\n",
  // truthy / accept-shaped values — all stay ON, because this is a REJECT
  // list, not an accept list
  "true",
  "TRUE",
  "1",
  "yes",
  "on",
  // near-misses that must NOT opt out
  "nope",
  "falsey",
  "00",
  "-0",
  "disabled",
  "null",
  "undefined",
  "  ",
];

describe("equivalence: ABAP_CROSS_PROCESS_OBJECT_LOCK — old resolver vs ConfigSchema", () => {
  for (const raw of BOOL_INPUTS) {
    it(`agrees for ${JSON.stringify(raw)}`, () => {
      const old = resolveCrossProcessObjectLock(
        viaResolverEnv("ABAP_CROSS_PROCESS_OBJECT_LOCK", raw),
      );
      const fresh = viaSchema("ABAP_CROSS_PROCESS_OBJECT_LOCK", raw).crossProcessObjectLock;
      // Strict: both the value AND the type. A schema that returned the
      // STRING "false" where the resolver returns the BOOLEAN false would
      // still select the wrong gate in `src/adt/pool.ts`, whose branch is a
      // `=== false` identity test.
      expect(fresh).toBe(old);
      expect(typeof fresh).toBe("boolean");
    });
  }

  it("the shipped default — nothing set — is ON on both paths", () => {
    expect(resolveCrossProcessObjectLock({} as NodeJS.ProcessEnv)).toBe(true);
    expect(viaSchema("ABAP_CROSS_PROCESS_OBJECT_LOCK", undefined).crossProcessObjectLock).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. ABAP_OBJECT_LOCK_WAIT_MS — numeric, soft-bounded, default 1500 / 200…30000
// ---------------------------------------------------------------------------

/**
 * The documented contract (`resolveObjectLockWaitMs`'s doc comment) is:
 * default 1 500 ms, accepted range 200…30 000 ms, and OUT-OF-RANGE FALLS BACK
 * TO THE DEFAULT RATHER THAN CLAMPING — verbatim, "clamping
 * `ABAP_OBJECT_LOCK_WAIT_MS=1` to 200 ms would look like the setting took
 * effect when it did not". That soft-fallback is the reason this pair could
 * not simply reuse `z.coerce.number().int().min().max()` like most numeric
 * fields in the schema, which hard-fail startup; it is why
 * `softBoundedMsSchema` exists. `"1"` below is that exact documented example.
 */
const MS_INPUTS: (string | undefined)[] = [
  // unset / empty / whitespace-only
  undefined,
  "",
  "   ",
  "\t\n",
  // in range, including both edges (inclusive on both ends)
  "200",
  "1500",
  "30000",
  "5000",
  "  2500  ",
  "2500 ",
  // out of range, low — falls back to 1500, NOT clamped up to 200
  "199",
  "199.9",
  "1",
  "0",
  // out of range, high — falls back to 1500, NOT clamped down to 30000
  "30001",
  "99999",
  // negative
  "-1",
  "-500",
  "-0",
  // fractional: floored, then range-checked (order matters — "199.9" floors
  // to 199 and is therefore OUT of range, while "200.5" floors to 200 and is
  // IN)
  "200.5",
  "30000.5",
  "1500.999",
  // unparseable
  "abc",
  "1500abc",
  "NaN",
  "1_500",
  // Number() traps that a hand-written truth table gets wrong
  "0x1F4",
  "1e3",
  "3e3",
  ".5e4",
  "+2000",
  "Infinity",
  "-Infinity",
];

describe("equivalence: ABAP_OBJECT_LOCK_WAIT_MS — old resolver vs ConfigSchema", () => {
  for (const raw of MS_INPUTS) {
    it(`agrees for ${JSON.stringify(raw)}`, () => {
      const old = resolveObjectLockWaitMs(viaResolverEnv("ABAP_OBJECT_LOCK_WAIT_MS", raw));
      const fresh = viaSchema("ABAP_OBJECT_LOCK_WAIT_MS", raw).objectLockWaitMs;
      expect(fresh).toBe(old);
      expect(typeof fresh).toBe("number");
    });
  }

  it("the shipped default — nothing set — is 1500 ms on both paths", () => {
    expect(resolveObjectLockWaitMs({} as NodeJS.ProcessEnv)).toBe(1500);
    expect(viaSchema("ABAP_OBJECT_LOCK_WAIT_MS", undefined).objectLockWaitMs).toBe(1500);
  });

  it("soft-falls-back rather than clamping — the documented ABAP_OBJECT_LOCK_WAIT_MS=1 case", () => {
    // Both paths must answer 1500, not 200. Clamping to the minimum would
    // look like the setting took effect when it did not, which is the whole
    // stated reason this field is soft-bounded instead of `.min()`-validated.
    expect(resolveObjectLockWaitMs({ ABAP_OBJECT_LOCK_WAIT_MS: "1" } as NodeJS.ProcessEnv)).toBe(
      1500,
    );
    expect(viaSchema("ABAP_OBJECT_LOCK_WAIT_MS", "1").objectLockWaitMs).toBe(1500);
  });

  it("does not fail startup on garbage — the opposite of the hard-failing numeric fields", () => {
    // `lockWaitMs` and friends throw here. This one must not: an operator
    // typo in a lock budget should not take the server down.
    expect(() => viaSchema("ABAP_OBJECT_LOCK_WAIT_MS", "abc")).not.toThrow();
    expect(() => viaSchema("ABAP_OBJECT_LOCK_WAIT_MS", "-9")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. redactConfigSecrets — the actual point of this migration
// ---------------------------------------------------------------------------

/**
 * Equivalence alone would only prove the move was harmless. This section
 * proves it was USEFUL: both settings now appear in the effective-configuration
 * report, so "is the cross-process object lock actually on in this process?"
 * is answerable from the config surface instead of requiring someone to guess
 * at an unvalidated env var.
 */
describe("redactConfigSecrets surfaces both object-lock settings", () => {
  it("reports both at their defaults", () => {
    const r = redactConfigSecrets(loadConfig({ env: baseEnv(), warn: () => {}, skipDotenv: true }));
    expect(Object.keys(r)).toContain("crossProcessObjectLock");
    expect(Object.keys(r)).toContain("objectLockWaitMs");
    expect(r.crossProcessObjectLock).toBe(true);
    expect(r.objectLockWaitMs).toBe(1500);
  });

  it("reports both when overridden — the silently-off lock is now visible", () => {
    const r = redactConfigSecrets(
      loadConfig({
        env: baseEnv({
          ABAP_CROSS_PROCESS_OBJECT_LOCK: "off",
          ABAP_OBJECT_LOCK_WAIT_MS: "4000",
        }),
        warn: () => {},
        skipDotenv: true,
      }),
    );
    expect(r.crossProcessObjectLock).toBe(false);
    expect(r.objectLockWaitMs).toBe(4000);
  });

  it("neither is masked — they are not secrets", () => {
    // A boolean switch and a millisecond budget carry nothing sensitive, so
    // they are reported verbatim. If either ever came back as a mask string,
    // the report would be lying about the effective configuration and the
    // original visibility gap would be back, in a form that LOOKS fixed.
    const r = redactConfigSecrets(
      loadConfig({
        env: baseEnv({
          ABAP_CROSS_PROCESS_OBJECT_LOCK: "false",
          ABAP_OBJECT_LOCK_WAIT_MS: "7000",
        }),
        warn: () => {},
        skipDotenv: true,
      }),
    );
    expect(typeof r.crossProcessObjectLock).toBe("boolean");
    expect(typeof r.objectLockWaitMs).toBe("number");
    for (const v of [r.crossProcessObjectLock, r.objectLockWaitMs]) {
      expect(String(v)).not.toMatch(/\*/);
      expect(String(v)).not.toBe("[redacted]");
    }
  });

  /**
   * Found while rebasing this migration onto the type-aware DDIC activation
   * chunking work.
   * `maxDdicActivationBatch`/`maxSafeActivationBatch` DO go through
   * `ConfigSchema` — they never had this migration's `process.env` bypass — but they
   * were not reported by `redactConfigSecrets`, which is the other half of the same
   * defect: a parsed, validated field the operator still cannot see.
   *
   * It matters more than usual for `maxDdicActivationBatch` specifically:
   * that is the knob bounding the server-side async-RFC fan-out which took the
   * appliance down. "What is it actually set to in this process?" is a
   * question someone asks during an incident, and it has to be answerable from
   * the config report rather than by reading the deployment's env.
   */
  it("also reports the DDIC activation batch sizes, which were parsed but unreported", () => {
    const defaults = redactConfigSecrets(
      loadConfig({ env: baseEnv(), warn: () => {}, skipDotenv: true }),
    );
    expect(Object.keys(defaults)).toContain("maxDdicActivationBatch");
    expect(Object.keys(defaults)).toContain("maxSafeActivationBatch");
    expect(defaults.maxDdicActivationBatch).toBe(5);
    expect(defaults.maxSafeActivationBatch).toBe(50);

    const overridden = redactConfigSecrets(
      loadConfig({
        env: baseEnv({
          ABAP_MAX_DDIC_ACTIVATION_BATCH: "3",
          ABAP_MAX_SAFE_ACTIVATION_BATCH: "25",
        }),
        warn: () => {},
        skipDotenv: true,
      }),
    );
    expect(overridden.maxDdicActivationBatch).toBe(3);
    expect(overridden.maxSafeActivationBatch).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// 4. The object and debug switches stay independent
// ---------------------------------------------------------------------------

/**
 * The debug-lock migration pinned that `ABAP_CROSS_PROCESS_DEBUG_LOCK` is a separate switch
 * from `ABAP_CROSS_PROCESS_OBJECT_LOCK` on purpose — a different resource with
 * a different failure mode. Now that BOTH live in the same schema object it
 * would be easy for a future edit to collapse them into one field, so the
 * counterpart assertion is pinned here too.
 */
describe("the object-lock and debug-lock switches are independent", () => {
  it("turning the object lock off leaves the debug lock on", () => {
    const c = loadConfig({
      env: baseEnv({ ABAP_CROSS_PROCESS_OBJECT_LOCK: "false" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.crossProcessObjectLock).toBe(false);
    expect(c.crossProcessDebugLock).toBe(true);
  });

  it("turning the debug lock off leaves the object lock on", () => {
    const c = loadConfig({
      env: baseEnv({ ABAP_CROSS_PROCESS_DEBUG_LOCK: "false" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.crossProcessDebugLock).toBe(false);
    expect(c.crossProcessObjectLock).toBe(true);
  });

  it("the two wait budgets are separate fields with the same default", () => {
    const c = loadConfig({
      env: baseEnv({ ABAP_OBJECT_LOCK_WAIT_MS: "9000" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.objectLockWaitMs).toBe(9000);
    expect(c.debugLockWaitMs).toBe(1500);
  });
});
