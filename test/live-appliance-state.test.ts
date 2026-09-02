/**
 * Offline unit tests for `classifyApplianceStateFailure` / `underApplianceStateWatch`
 * (the appliance-state self-classification work, remainder). No `AbapConnection`, no `loadConfig()` — constructed
 * `AbapError`s only, so this file stays out of `system-role-probe-guard.test.ts`'s
 * scanned population (it enumerates every `*.test.ts` that builds a connection).
 */
import { describe, expect, it } from "vitest";
import { AbapError, type AbapErrorCode } from "../src/adt/errors.js";
import { classifyApplianceStateFailure, underApplianceStateWatch } from "./live-appliance-state.js";

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
