/**
 * Offline unit tests for `classifyApplianceStateFailure` / `underApplianceStateWatch`
 * (the appliance-state self-classification work, remainder). No `AbapConnection`, no `loadConfig()` — constructed
 * `AbapError`s only, so this file stays out of `system-role-probe-guard.test.ts`'s
 * scanned population (it enumerates every `*.test.ts` that builds a connection).
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AbapError, type AbapErrorCode } from "../src/adt/errors.js";
import {
  classifyApplianceStateFailure,
  liveSuiteSkipReason,
  underApplianceStateWatch,
} from "./live-appliance-state.js";

const err = (code: AbapErrorCode, details: Record<string, unknown> = {}) =>
  new AbapError(code, `${code} for test`, details);

describe("classifyApplianceStateFailure", () => {
  it.each<AbapErrorCode>([
    "SYSTEM_UNAVAILABLE",
    "CONNECT_FAILED",
    "CIRCUIT_OPEN_TRANSIENT",
    "ROLE_PROBE_FAILED",
    "OBJECT_LOCKED_CROSS_PROCESS",
    "DEBUG_SESSION_LOCKED_CROSS_PROCESS",
  ])("matches %s as appliance state with a non-empty reason", (code) => {
    const verdict = classifyApplianceStateFailure(err(code));
    expect(verdict.applianceState).toBe(true);
    if (verdict.applianceState) {
      expect(verdict.reason.length).toBeGreaterThan(0);
      expect(verdict.signature.length).toBeGreaterThan(0);
    }
  });

  it.each<AbapErrorCode>(["AUTH_FAILED", "AUTH_CIRCUIT_OPEN", "SESSION_DEAD", "NOT_FOUND", "LOCKED"])(
    "does NOT match %s — deliberately excluded",
    (code) => {
      expect(classifyApplianceStateFailure(err(code))).toEqual({ applianceState: false });
    },
  );

  it("matches ADT_ERROR only when details.timeout === true", () => {
    expect(classifyApplianceStateFailure(err("ADT_ERROR"))).toEqual({ applianceState: false });
    expect(classifyApplianceStateFailure(err("ADT_ERROR", { timeout: false }))).toEqual({
      applianceState: false,
    });
    const verdict = classifyApplianceStateFailure(err("ADT_ERROR", { timeout: true }));
    expect(verdict.applianceState).toBe(true);
    if (verdict.applianceState) {
      expect(verdict.reason.length).toBeGreaterThan(0);
    }
  });

  it("returns false for non-AbapError values", () => {
    expect(classifyApplianceStateFailure(new Error("plain"))).toEqual({ applianceState: false });
    expect(classifyApplianceStateFailure("a thrown string")).toEqual({ applianceState: false });
    expect(classifyApplianceStateFailure(undefined)).toEqual({ applianceState: false });
    expect(classifyApplianceStateFailure(null)).toEqual({ applianceState: false });
  });
});

describe("underApplianceStateWatch", () => {
  it("passes a value through on success", async () => {
    await expect(underApplianceStateWatch("label", async () => 42)).resolves.toBe(42);
  });

  it("prefixes and preserves cause on an appliance-state error", async () => {
    const original = err("SYSTEM_UNAVAILABLE");
    await expect(
      underApplianceStateWatch("connect", async () => {
        throw original;
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/^APPLIANCE STATE: connect: /),
      cause: original,
    });
  });

  it("rethrows a behavioural error byte-identically (same object identity, unprefixed)", async () => {
    const original = err("CHECK_FAILED");
    let caught: unknown;
    try {
      await underApplianceStateWatch("check", async () => {
        throw original;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original);
    expect((caught as AbapError).message).toBe(original.message);
    expect((caught as AbapError).message.startsWith("APPLIANCE STATE:")).toBe(false);
  });
});

describe("liveSuiteSkipReason", () => {
  it("names ABAP_URL when it is unset, regardless of needs", () => {
    expect(liveSuiteSkipReason({}, {} as NodeJS.ProcessEnv)).toMatch(/ABAP_URL/);
    expect(liveSuiteSkipReason({ write: true }, {} as NodeJS.ProcessEnv)).toMatch(/ABAP_URL/);
  });

  it("treats an empty-string ABAP_URL as not set", () => {
    expect(liveSuiteSkipReason({}, { ABAP_URL: "" } as NodeJS.ProcessEnv)).toMatch(/ABAP_URL/);
  });

  it("runs with ABAP_URL set and no write requirement", () => {
    expect(liveSuiteSkipReason({}, { ABAP_URL: "http://a4h" } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("names ABAP_MODE when write is needed and nothing is configured", () => {
    expect(
      liveSuiteSkipReason({ write: true }, { ABAP_URL: "http://a4h" } as NodeJS.ProcessEnv),
    ).toMatch(/ABAP_MODE/);
  });

  it.each(["edit", "admin"])("runs when write is needed and ABAP_MODE=%s", (mode) => {
    expect(
      liveSuiteSkipReason(
        { write: true },
        { ABAP_URL: "http://a4h", ABAP_MODE: mode } as NodeJS.ProcessEnv,
      ),
    ).toBeUndefined();
  });

  it("still gives a reason when write is needed and ABAP_MODE is read-only", () => {
    expect(
      liveSuiteSkipReason(
        { write: true },
        { ABAP_URL: "http://a4h", ABAP_MODE: "read" } as NodeJS.ProcessEnv,
      ),
    ).toMatch(/ABAP_MODE/);
  });

  it("runs when write is needed, ABAP_MODE is unset and ABAP_ALLOW_WRITE=true", () => {
    expect(
      liveSuiteSkipReason(
        { write: true },
        { ABAP_URL: "http://a4h", ABAP_ALLOW_WRITE: "true" } as NodeJS.ProcessEnv,
      ),
    ).toBeUndefined();
  });

  it("still gives a reason when ABAP_ALLOW_WRITE=true but ABAP_MODE is read-only — ABAP_MODE wins", () => {
    expect(
      liveSuiteSkipReason(
        { write: true },
        { ABAP_URL: "http://a4h", ABAP_MODE: "read", ABAP_ALLOW_WRITE: "true" } as NodeJS.ProcessEnv,
      ),
    ).toMatch(/ABAP_MODE/);
  });
});

/**
 * A bare `describe.skip` says a suite didn't run but never says why, so the
 * tracked surface (`LIVE_INTEGRATION_TESTS`) needs a guard that every live
 * suite states its reason.
 *
 * No `loadConfig(`/`ConfigSchema.parse(`/`new AbapConnection(` literal in
 * this file: `system-role-probe-guard.test.ts` scans every `*.test.ts` for
 * those and would misclassify it.
 */
describe("live suite tracked-surface guard", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  }

  function readLiveIntegrationTests(): string[] {
    const configSource = stripComments(readFileSync(join(ROOT, "vitest.config.ts"), "utf8"));
    const match = configSource.match(/LIVE_INTEGRATION_TESTS\s*=\s*\[([\s\S]*?)\]/);
    if (!match) throw new Error("could not find LIVE_INTEGRATION_TESTS array in vitest.config.ts");
    return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  }

  /**
   * Suites still gated behind a bare `describe.skip` with no stated reason.
   * Shrink-only: delete an entry once it's wired to
   * `liveSuiteSkipReason`/`skipForApplianceState`, never add one.
   */
  const SILENT_SKIP_DEBT: Record<string, string> = {
    "test/integration.test.ts":
      "both its read (`d`) and write (`dw`) describe blocks are gated by a bare " +
      "describe.skip with no stated reason at collection time; the skipForApplianceState " +
      "calls it has are per-case skips that only run once the file is collected",
    "test/integration-debug.test.ts":
      "gated on ABAP_URL alone with no stated reason at collection time; its per-case " +
      "skips carry the prefix once the file is collected",
    "test/integration-class-includes.test.ts":
      "still a bare describe.skip; nothing states why the whole file was skipped",
    "test/integration-lock-handle.test.ts":
      "still a bare describe.skip; nothing states why the whole file was skipped",
  };

  it("LIVE_INTEGRATION_TESTS is non-empty and every named file exists", () => {
    const files = readLiveIntegrationTests();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(existsSync(join(ROOT, f)), `${f} is listed but does not exist`).toBe(true);
    }
  });

  it("every tracked suite not on SILENT_SKIP_DEBT states its skip reason", () => {
    const files = readLiveIntegrationTests();
    for (const f of files) {
      if (f in SILENT_SKIP_DEBT) continue;
      const source = stripComments(readFileSync(join(ROOT, f), "utf8"));
      expect(source, `${f} should call liveSuiteSkipReason(`).toMatch(/liveSuiteSkipReason\(/);
      expect(source, `${f} should call skipForApplianceState(`).toMatch(/skipForApplianceState\(/);
    }
  });

  it("SILENT_SKIP_DEBT entries are all still tracked and still silent", () => {
    const files = readLiveIntegrationTests();
    for (const [f, reason] of Object.entries(SILENT_SKIP_DEBT)) {
      expect(reason.length).toBeGreaterThan(0);
      expect(files, `${f} is in SILENT_SKIP_DEBT but not in LIVE_INTEGRATION_TESTS`).toContain(f);
      const source = stripComments(readFileSync(join(ROOT, f), "utf8"));
      expect(
        source,
        `${f} is in SILENT_SKIP_DEBT but no longer contains describe.skip — its debt is paid, delete the entry`,
      ).toMatch(/describe\.skip/);
    }
  });

  // Ratchet: shrink-only, 4 entries today.
  it("the silent-skip debt has not grown", () => {
    expect(Object.keys(SILENT_SKIP_DEBT).length).toBeLessThanOrEqual(4);
  });
});
