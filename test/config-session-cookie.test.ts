/**
 * `ABAP_SESSION_COOKIE` — an alternative to
 * `ABAP_PASSWORD` for SSO-fronted systems that don't accept one. Covers the
 * parser (`parseSessionCookie`), the exactly-one-of-password/cookie startup
 * validation, the session-name warning, and `redactConfigSecrets`.
 *
 * A session cookie authenticates as the user with no password — exactly as
 * sensitive as `ABAP_PASSWORD` — so every assertion here that touches an
 * error or warning message also asserts the cookie VALUE sentinel is absent
 * from it, not just that the test "passes".
 */
import { describe, expect, it } from "vitest";

import { loadConfig, parseSessionCookie, redactConfigSecrets } from "../src/config.js";

/** Minimal env satisfying every required field except the credential pair. */
const env = (over: Record<string, string> = {}): Record<string, string> => ({
  ABAP_URL: "http://sap.invalid:50000",
  ABAP_USER: "U",
  ...over,
});

const PASSWORD_SENTINEL = "s3cr3t-do-not-log";
const COOKIE_SENTINEL = "c00k1e-do-not-log";

describe("parseSessionCookie: splitting and trimming", () => {
  it("splits each pair on the FIRST = only — a sap-usercontext-shaped value survives whole", () => {
    const parsed = parseSessionCookie("sap-usercontext=sap-client=001&sap-language=EN");
    expect(parsed.get("sap-usercontext")).toBe("sap-client=001&sap-language=EN");
  });

  it("trims whitespace around both name and value", () => {
    const parsed = parseSessionCookie("  JSESSIONID  =  abc123  ; other = xyz ");
    expect(parsed.get("JSESSIONID")).toBe("abc123");
    expect(parsed.get("other")).toBe("xyz");
  });

  it("skips fragments with no = and fragments with an empty name, without throwing", () => {
    const parsed = parseSessionCookie("JSESSIONID=abc; Secure; =orphan-value; ;valid=1");
    expect(parsed.get("JSESSIONID")).toBe("abc");
    expect(parsed.get("valid")).toBe("1");
    expect(parsed.size).toBe(2);
  });

  it("drops Path, Domain, Secure, HttpOnly, Expires, Max-Age, SameSite case-insensitively", () => {
    const parsed = parseSessionCookie(
      "JSESSIONID=abc; path=/; DOMAIN=sap.invalid; Secure; HttpOnly; " +
        "expires=Wed, 21 Oct 2015 07:28:00 GMT; Max-Age=3600; SameSite=Lax",
    );
    expect([...parsed.keys()]).toEqual(["JSESSIONID"]);
  });

  it("does not drop an Expires in the past — the cookie survives, expiry is never evaluated", () => {
    const parsed = parseSessionCookie("JSESSIONID=abc; Expires=Wed, 21 Oct 2005 07:28:00 GMT");
    expect(parsed.get("JSESSIONID")).toBe("abc");
  });

  it("later duplicate names win", () => {
    const parsed = parseSessionCookie("JSESSIONID=first; JSESSIONID=second");
    expect(parsed.get("JSESSIONID")).toBe("second");
  });
});

describe("config: exactly one of ABAP_PASSWORD / ABAP_SESSION_COOKIE", () => {
  it("password only is accepted — sessionCookie is undefined", () => {
    const cfg = loadConfig({
      env: env({ ABAP_PASSWORD: PASSWORD_SENTINEL }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.password).toBe(PASSWORD_SENTINEL);
    expect(cfg.sessionCookie).toBeUndefined();
  });

  it("cookie only is accepted — password is undefined, cookie map has the expected entries", () => {
    const cfg = loadConfig({
      env: env({ ABAP_SESSION_COOKIE: `JSESSIONID=${COOKIE_SENTINEL}; other=1` }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.password).toBeUndefined();
    expect(cfg.sessionCookie?.get("JSESSIONID")).toBe(COOKIE_SENTINEL);
    expect(cfg.sessionCookie?.get("other")).toBe("1");
  });

  it("both set is rejected, naming both ABAP_PASSWORD and ABAP_SESSION_COOKIE, without the misleading 'ABAP_PASSWORD is required' text", () => {
    expect(() =>
      loadConfig({
        env: env({
          ABAP_PASSWORD: PASSWORD_SENTINEL,
          ABAP_SESSION_COOKIE: `JSESSIONID=${COOKIE_SENTINEL}`,
        }),
        warn: () => {},
        skipDotenv: true,
      }),
    ).toThrowError(/ABAP_PASSWORD/);
    try {
      loadConfig({
        env: env({
          ABAP_PASSWORD: PASSWORD_SENTINEL,
          ABAP_SESSION_COOKIE: `JSESSIONID=${COOKIE_SENTINEL}`,
        }),
        warn: () => {},
        skipDotenv: true,
      });
      expect.unreachable("loadConfig should have thrown");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain("ABAP_PASSWORD");
      expect(msg).toContain("ABAP_SESSION_COOKIE");
      expect(msg).not.toContain("ABAP_PASSWORD is required");
      expect(msg).not.toContain(PASSWORD_SENTINEL);
      expect(msg).not.toContain(COOKIE_SENTINEL);
    }
  });

  it("neither set is rejected, naming both ABAP_PASSWORD and ABAP_SESSION_COOKIE", () => {
    try {
      loadConfig({ env: env(), warn: () => {}, skipDotenv: true });
      expect.unreachable("loadConfig should have thrown");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain("ABAP_PASSWORD");
      expect(msg).toContain("ABAP_SESSION_COOKIE");
    }
  });

  describe("cookie set but parsing to zero pairs is rejected, naming ABAP_SESSION_COOKIE, not the misleading password message", () => {
    const cases: Record<string, string> = {
      empty: "",
      "whitespace-only": "   ",
      "attributes-only": "Path=/; Secure; HttpOnly",
      "junk-only": ";;; =orphan; nokeyvalue",
    };
    for (const [label, value] of Object.entries(cases)) {
      // "empty"/"whitespace-only" are treated as UNSET (same rule as
      // ABAP_PASSWORD — see passwordIsSet/sessionCookieIsSet in config.ts)
      // and so hit the "neither" branch rather than the zero-pairs branch;
      // both still reject and both still name ABAP_SESSION_COOKIE.
      it(label, () => {
        expect(() =>
          loadConfig({
            env: env({ ABAP_SESSION_COOKIE: value }),
            warn: () => {},
            skipDotenv: true,
          }),
        ).toThrow();
        try {
          loadConfig({
            env: env({ ABAP_SESSION_COOKIE: value }),
            warn: () => {},
            skipDotenv: true,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          expect(msg).toContain("ABAP_SESSION_COOKIE");
          expect(msg).not.toContain("ABAP_PASSWORD is required");
        }
      });
    }
  });
});

describe("config: session-name warning (never a rejection)", () => {
  const warnFor = (cookie: string): string[] => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_SESSION_COOKIE: cookie }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    return warnings;
  };

  it("SAP_SESSIONID_A4H_001 — no warning (prefix match)", () => {
    const warnings = warnFor(`SAP_SESSIONID_A4H_001=${COOKIE_SENTINEL}`);
    expect(warnings.some((w) => w.includes("does not look like") || w.includes("look like a session"))).toBe(false);
  });

  it("MYSAPSSO2 — no warning", () => {
    const warnings = warnFor(`MYSAPSSO2=${COOKIE_SENTINEL}`);
    expect(warnings.some((w) => w.includes("look like a session"))).toBe(false);
  });

  it("JSESSIONID — no warning", () => {
    const warnings = warnFor(`JSESSIONID=${COOKIE_SENTINEL}`);
    expect(warnings.some((w) => w.includes("look like a session"))).toBe(false);
  });

  it("sap-usercontext alone — warning emitted (weak, not proof)", () => {
    const warnings = warnFor(`sap-usercontext=${COOKIE_SENTINEL}`);
    expect(warnings.some((w) => w.includes("look like a session"))).toBe(true);
  });

  it("sap_sessionid_a4h_001 (lower case) alone — warning emitted (case-sensitive match)", () => {
    const warnings = warnFor(`sap_sessionid_a4h_001=${COOKIE_SENTINEL}`);
    expect(warnings.some((w) => w.includes("look like a session"))).toBe(true);
  });

  it("a generic unrelated name alone — warning emitted", () => {
    const warnings = warnFor(`PHPSESSID=${COOKIE_SENTINEL}`);
    expect(warnings.some((w) => w.includes("look like a session"))).toBe(true);
  });

  it("the warning text names the cookie NAME and never any part of the value", () => {
    const warnings = warnFor(`PHPSESSID=${COOKIE_SENTINEL}`);
    const warning = warnings.find((w) => w.includes("look like a session"));
    expect(warning).toBeDefined();
    expect(warning).toContain("PHPSESSID");
    expect(warning).not.toContain(COOKIE_SENTINEL);
  });
});

describe("config: redactConfigSecrets in cookie mode and password mode", () => {
  it("cookie-mode config: JSON.stringify(redactConfigSecrets(cfg)) contains no part of the cookie value", () => {
    const cfg = loadConfig({
      env: env({ ABAP_SESSION_COOKIE: `JSESSIONID=${COOKIE_SENTINEL}` }),
      warn: () => {},
      skipDotenv: true,
    });
    const serialised = JSON.stringify(redactConfigSecrets(cfg));
    expect(serialised).not.toContain(COOKIE_SENTINEL);
    expect(serialised).not.toContain(COOKIE_SENTINEL.slice(0, 6));
    expect(serialised).toContain('"sessionCookie":"***"');
  });

  it("password-mode config: JSON.stringify(redactConfigSecrets(cfg)) contains no part of the password (regression)", () => {
    const cfg = loadConfig({
      env: env({ ABAP_PASSWORD: PASSWORD_SENTINEL }),
      warn: () => {},
      skipDotenv: true,
    });
    const serialised = JSON.stringify(redactConfigSecrets(cfg));
    expect(serialised).not.toContain(PASSWORD_SENTINEL);
    expect(serialised).not.toContain(PASSWORD_SENTINEL.slice(0, 6));
    expect(redactConfigSecrets(cfg).password).toBe("***");
  });

  it("a config with no cookie does not render '***' implying one exists", () => {
    const cfg = loadConfig({
      env: env({ ABAP_PASSWORD: PASSWORD_SENTINEL }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(redactConfigSecrets(cfg).sessionCookie).not.toBe("***");
    expect(redactConfigSecrets(cfg).sessionCookie).toBe("(not set)");
  });

  it("a config with no password does not render '***' for password", () => {
    const cfg = loadConfig({
      env: env({ ABAP_SESSION_COOKIE: `JSESSIONID=${COOKIE_SENTINEL}` }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(redactConfigSecrets(cfg).password).not.toBe("***");
    expect(redactConfigSecrets(cfg).password).toBe("(not set)");
  });
});
