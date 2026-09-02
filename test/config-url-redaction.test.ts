/**
 * URL redaction primitives (`src/config.ts`) and their `loadConfig`
 * integration:
 *
 *   - `stripUrlCredentials` (the former `redactUrl`) strips a userinfo
 *     password but DELIBERATELY leaves the host intact — see
 *     `test/server-errors.test.ts` for its own coverage;
 *   - `describeUrlWithoutHost` is the host-FREE descriptor used in the
 *     plain-HTTP startup warning, because that warning lands in raw
 *     captured output no caller-side sink can rewrite;
 *   - `urlHasEmbeddedPassword` replaces the old `redactUrl(url) !== url`
 *     round-trip predicate, which false-positived on WHATWG host
 *     normalisation (e.g. upper-casing) with no password present at all.
 *
 * Scope: imports only `../src/config.js`, same as `test/config-abap-mode.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  describeUrlWithoutHost,
  loadConfig,
  urlHasEmbeddedPassword,
} from "../src/config.js";

/** Minimal env that satisfies the required fields, same shape as test/config-abap-mode.test.ts. */
const env = (over: Record<string, string> = {}): Record<string, string> => ({
  ABAP_URL: "http://sap.invalid:50000",
  ABAP_USER: "U",
  ABAP_PASSWORD: "p",
  ...over,
});

describe("describeUrlWithoutHost", () => {
  it("keeps scheme and explicit port, drops the path entirely", () => {
    expect(describeUrlWithoutHost("http://sap.invalid:50000/sap/bc/adt")).toBe("http://…:50000");
  });

  it("omits the port when the URL didn't have one", () => {
    expect(describeUrlWithoutHost("http://sap.invalid/sap")).toBe("http://…");
  });

  it("reads an explicit port even when it matches the scheme default", () => {
    // WHATWG URL blanks `u.port` for a default port (:443 on https) — the
    // port has to be read off the raw string, not the parsed URL object.
    expect(describeUrlWithoutHost("https://sap.invalid:443")).toBe("https://…:443");
  });

  it("carries no host and no credential even when the URL embeds userinfo", () => {
    const out = describeUrlWithoutHost("http://DEVELOPER:s3cr3t@sap.invalid:50000");
    expect(out).not.toContain("sap.invalid");
    expect(out).not.toContain("s3cr3t");
    expect(out).not.toContain("DEVELOPER");
    expect(out).toBe("http://…:50000");
  });

  it("degrades to a scheme-only descriptor for a URL the WHATWG parser rejects, without throwing", () => {
    // Space in the host breaks `new URL()`; the regex fallback still must not
    // leak the un-parseable host fragment into the descriptor.
    const malformed = "http://ho st:50000";
    expect(() => describeUrlWithoutHost(malformed)).not.toThrow();
    const out = describeUrlWithoutHost(malformed);
    expect(out).not.toContain("ho st");
    expect(out).not.toContain("st:50000");
    expect(out.startsWith("http://")).toBe(true);
    // The catch-path fallback only ever recovers the scheme, never a port —
    // so this is "http://…" exactly, not "http://…:50000".
    expect(out).toBe("http://…");
  });

  it("falls back to a fixed placeholder when nothing — not even the scheme — is readable", () => {
    expect(() => describeUrlWithoutHost("")).not.toThrow();
    expect(describeUrlWithoutHost("")).toBe("(unparseable URL)");
    expect(describeUrlWithoutHost("not a url at all")).toBe("(unparseable URL)");
  });
});

describe("urlHasEmbeddedPassword", () => {
  it("is true for a URL carrying a userinfo password", () => {
    expect(urlHasEmbeddedPassword("http://u:p@host:50000")).toBe(true);
  });

  it("is false with no userinfo at all", () => {
    expect(urlHasEmbeddedPassword("http://host:50000")).toBe(false);
  });

  it("is false for a username with no password", () => {
    expect(urlHasEmbeddedPassword("http://user@host:50000")).toBe(false);
  });

  it("is false for an upper-cased host with only a username — the false positive this predicate replaces", () => {
    // The old predicate compared `redactUrl(url) !== url`: WHATWG URL
    // lower-cases the host on the round trip, so this URL changed even
    // though it carries no password, and loadConfig wrongly warned "ABAP_URL
    // contains an embedded password". `urlHasEmbeddedPassword` inspects
    // `u.password` directly instead of a string diff, so this stays false.
    expect(urlHasEmbeddedPassword("http://user@HOST:50000")).toBe(false);
  });

  it("is true via the regex fallback for a password-bearing URL the WHATWG parser rejects", () => {
    expect(urlHasEmbeddedPassword("http://user:s3cr3t@ho st:50000")).toBe(true);
  });

  it("is false and does not throw for the empty string or a non-'@' string", () => {
    expect(() => urlHasEmbeddedPassword("")).not.toThrow();
    expect(urlHasEmbeddedPassword("")).toBe(false);
    expect(urlHasEmbeddedPassword("not a url")).toBe(false);
  });
});

describe("loadConfig: the plain-HTTP startup warning is host-free", () => {
  it("names scheme and port but never the host", () => {
    // The warn sink is injectable, but the message text itself is not — a
    // host embedded here reaches every raw capture (stderr, log aggregator,
    // test harness) regardless of what the caller does with the callback.
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_URL: "http://sap.invalid:50000" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    const plainHttp = warnings.find((w) => w.includes("is plain HTTP"));
    expect(plainHttp).toBeDefined();
    expect(plainHttp).not.toContain("sap.invalid");
    expect(plainHttp).toContain("http://…:50000");
  });

  it("carries neither host nor password when ABAP_URL also embeds credentials", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_URL: "http://DEVELOPER:s3cr3t@sap.invalid:50000" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    const plainHttp = warnings.find((w) => w.includes("is plain HTTP"));
    expect(plainHttp).toBeDefined();
    expect(plainHttp).not.toContain("sap.invalid");
    expect(plainHttp).not.toContain("s3cr3t");
    expect(plainHttp).not.toContain("DEVELOPER");
  });

  it("is not emitted at all for an https URL", () => {
    // Guards against the message becoming unconditional.
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_URL: "https://sap.invalid:443" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.some((w) => w.includes("is plain HTTP"))).toBe(false);
  });
});

describe("loadConfig: the embedded-password warning uses urlHasEmbeddedPassword, not a round trip", () => {
  it("fires for a URL that actually carries a password", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_URL: "http://u:p@sap.invalid:50000" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.some((w) => w.includes("contains an embedded password"))).toBe(true);
  });

  it("does not fire for an upper-cased host with only a username — the false positive being fixed", () => {
    // This URL is also plain HTTP, so it still emits the plain-HTTP warning;
    // assert on the specific substring rather than warnings.length.
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_URL: "http://user@HOST:50000" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.some((w) => w.includes("contains an embedded password"))).toBe(false);
  });
});
