/**
 * `ABAP_VERIFY_WRITES` — the posture knob for how hard abapsmith works to
 * prove a write landed (`src/config.ts`, `verifyWrites` schema field).
 * `"speculative"` (default) treats a create/activate that returned without
 * error as sufficient; `"verified"` reads the object back and confirms it
 * after a successful write. Orthogonal to `ABAP_MODE`, same shape as
 * `toolSurface` — see `test/config-abap-mode.test.ts` for the sibling knob
 * this mirrors.
 */
import { describe, expect, it } from "vitest";
import { loadConfig, redactConfigSecrets } from "../src/config.js";

/** Minimal env that satisfies the required fields, same helper shape as `test/config-abap-mode.test.ts`. */
const env = (over: Record<string, string> = {}): Record<string, string> => ({
  ABAP_URL: "http://sap.invalid:50000",
  ABAP_USER: "U",
  ABAP_PASSWORD: "p",
  ...over,
});

describe("config: ABAP_VERIFY_WRITES", () => {
  it("defaults to 'speculative' when unset", () => {
    const cfg = loadConfig({ env: env(), warn: () => {}, skipDotenv: true });
    expect(cfg.verifyWrites).toBe("speculative");
  });

  it("resolves to 'verified' when set", () => {
    const cfg = loadConfig({
      env: env({ ABAP_VERIFY_WRITES: "verified" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.verifyWrites).toBe("verified");
  });

  it("resolves to 'speculative' when set explicitly", () => {
    const cfg = loadConfig({
      env: env({ ABAP_VERIFY_WRITES: "speculative" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.verifyWrites).toBe("speculative");
  });

  it("an invalid value throws through the same 'Invalid abapsmith configuration' issue-list mechanism, naming the field", () => {
    try {
      loadConfig({
        env: env({ ABAP_VERIFY_WRITES: "paranoid" }),
        warn: () => {},
        skipDotenv: true,
      });
      expect.unreachable("loadConfig should have thrown");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).toContain("Invalid abapsmith configuration:");
      expect(message).toContain("verifyWrites");
      expect(message).toMatch(/"speculative"/);
      expect(message).toMatch(/"verified"/);
    }
  });

  it("appears in the redacted projection (a permission-adjacent posture flag, nothing sensitive)", () => {
    const cfg = loadConfig({
      env: env({ ABAP_VERIFY_WRITES: "verified" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(redactConfigSecrets(cfg).verifyWrites).toBe("verified");
  });

  it("is independent of ABAP_MODE — unset stays 'speculative' under read, and admin does not force 'verified'", () => {
    const readCfg = loadConfig({
      env: env({ ABAP_MODE: "read" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(readCfg.verifyWrites).toBe("speculative");

    const adminCfg = loadConfig({
      env: env({ ABAP_MODE: "admin" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(adminCfg.verifyWrites).toBe("speculative");
  });
});
