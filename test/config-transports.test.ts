/**
 * `ABAP_ALLOW_TRANSPORTS` — env string in, resolved allow-list out.
 *
 * The asymmetry is the whole safety property and it is easy to regress into a
 * single `splitList()` call:
 *
 *   - UNSET            ⇒ ["*"]     any caller-named (or server-auto) request is
 *                                   accepted; opt-in, same convention as
 *                                   ABAP_ALLOW_PACKAGES/ABAP_ALLOW_NAME_PREFIXES
 *   - explicitly ""    ⇒ []        deny-all, fail-CLOSED, UNCHANGED
 *
 * `[]` and `["*"]` are both "wide-looking" list values in opposite directions,
 * and a resolver that treats a missing env var the same as an empty one
 * collapses them in the dangerous direction: a deployment that deliberately
 * set `ABAP_ALLOW_TRANSPORTS=""` to deny every transportable write would
 * silently start accepting any transport request instead.
 * `test/safety-transports.test.ts` covers what `SafetyGate` does with an
 * already-resolved list; nothing covered how that list is arrived at. This
 * file is that missing half, and it asserts the DENY direction explicitly.
 *
 * Scope: this suite imports `../src/config.js` and nothing else from src. It
 * never opens a connection — see the config-only exemption in
 * `test/system-role-probe-guard.test.ts`. Keep it that way; if this file ever
 * needs a connection, a server or a SafetyGate, it belongs in another file.
 */
import { describe, expect, it } from "vitest";
import { loadConfig, redactConfigSecrets } from "../src/config.js";

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

/** Resolve `allowTransports` for a given raw env value; omit `raw` to leave it unset. */
const resolve = (raw?: string): string[] =>
  loadConfig({
    env: env(raw === undefined ? {} : { ABAP_ALLOW_TRANSPORTS: raw }),
    warn: () => {},
    skipDotenv: true,
  }).allowTransports;

describe("config: ABAP_ALLOW_TRANSPORTS resolution", () => {
  it('unset defaults to ["*"] so a fresh install can name any transport request', () => {
    expect(resolve()).toEqual(["*"]);
  });

  it("explicitly empty resolves to [] — deny-all, fail-CLOSED, NOT the unset default", () => {
    const denied = resolve("");
    expect(denied).toEqual([]);
    // The point of the assertion above is what it is NOT.
    expect(denied).not.toContain("auto");
    expect(denied).not.toContain("*");
  });

  it("unset and explicitly-empty must never resolve to the same value", () => {
    // The single assertion this whole file exists for. If a refactor makes the
    // resolver treat a missing var and an empty var alike, this fails whichever
    // direction it collapses in.
    expect(resolve()).not.toEqual(resolve(""));
  });

  it("whitespace-only is empty, not a transport named \" \" — and stays deny-all", () => {
    expect(resolve("   ")).toEqual([]);
    expect(resolve("\t")).toEqual([]);
    expect(resolve("\n  \n")).toEqual([]);
  });

  it("separator-only input degrades to deny-all rather than to a list of empty strings", () => {
    expect(resolve(",")).toEqual([]);
    expect(resolve(" , ; , ")).toEqual([]);
  });

  it("a single TRKORR pins the allow-list to exactly that transport", () => {
    expect(resolve("A4HK900001")).toEqual(["A4HK900001"]);
  });

  it("a comma list splits into the individual TRKORRs, dropping empty slots", () => {
    expect(resolve("A4HK900001,A4HK900002")).toEqual(["A4HK900001", "A4HK900002"]);
    expect(resolve("A4HK900001, A4HK900002 ,,A4HK900003")).toEqual([
      "A4HK900001",
      "A4HK900002",
      "A4HK900003",
    ]);
  });

  it("a space list splits the same way, so quoting style does not change the policy", () => {
    expect(resolve("A4HK900001 A4HK900002")).toEqual(["A4HK900001", "A4HK900002"]);
    expect(resolve("  A4HK900001   A4HK900002  ")).toEqual(["A4HK900001", "A4HK900002"]);
    // Semicolons and newlines are separators too — a .env heredoc must not
    // silently become one giant pseudo-TRKORR.
    expect(resolve("A4HK900001;A4HK900002")).toEqual(["A4HK900001", "A4HK900002"]);
    expect(resolve("A4HK900001\nA4HK900002")).toEqual(["A4HK900001", "A4HK900002"]);
  });

  it('"*" survives as a distinct token and is not confused with "auto"', () => {
    expect(resolve("*")).toEqual(["*"]);
    expect(resolve("*")).not.toEqual(["auto"]);
    // Explicitly naming a narrower list (pinned TRKORR, or "auto") must never
    // silently gain "*" back — narrowing is real narrowing.
    expect(resolve("A4HK900001")).not.toContain("*");
    expect(resolve("auto")).not.toContain("*");
  });

  it('"auto" can be combined with pinned TRKORRs and keeps its order', () => {
    expect(resolve("auto,A4HK900001")).toEqual(["auto", "A4HK900001"]);
  });

  it("normalises case at the allowlist boundary — a lowercase or mixed-case TRKORR now matches regardless of how it was typed", () => {
    // Deliberately updated: this test used to document the OLD behaviour
    // (case preserved, so a lowercase pin failed closed silently). isTrkorr
    // (src/adt/transports.ts) already treats "a4hk900121" and "A4HK900121" as
    // the same value — a TRKORR is a canonical uppercase identifier — so the
    // allowlist folding case too is not a widening, it is closing the gap
    // between what the validator accepts and what the allowlist can match.
    expect(resolve("a4hk900001")).toEqual(["A4HK900001"]);
    // "auto"/"*" are magic tokens, not TRKORRs: matched case-insensitively but
    // folded to their canonical literal form, not uppercased.
    expect(resolve("AUTO")).toEqual(["auto"]);
  });

  it("a lowercase TRKORR pin is uppercased so it can match the allowlist", () => {
    expect(resolve("a4hk900121")).toEqual(["A4HK900121"]);
  });

  it("a mixed-case TRKORR pin is uppercased the same way", () => {
    expect(resolve("A4hK900121")).toEqual(["A4HK900121"]);
    expect(resolve("auto,a4hK900121")).toEqual(["auto", "A4HK900121"]);
  });

  it('"auto" and "*" are folded to canonical form, matched case-insensitively, never uppercased', () => {
    expect(resolve("Auto")).toEqual(["auto"]);
    expect(resolve("AUTO")).toEqual(["auto"]);
    expect(resolve("*")).toEqual(["*"]);
  });

  it("warns at startup about an ABAP_ALLOW_TRANSPORTS entry that is neither auto, *, nor a valid TRKORR", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true", ABAP_ALLOW_TRANSPORTS: "not-a-trkorr" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).toMatch(
      /ABAP_ALLOW_TRANSPORTS has entries that are neither "auto", "\*", nor a valid transport request number/,
    );
    // The (uppercased) offending entry is named, not just a generic complaint.
    expect(warnings.join("\n")).toContain("NOT-A-TRKORR");
  });

  it("does not warn when every entry is auto, *, or a valid TRKORR", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true", ABAP_ALLOW_TRANSPORTS: "auto,A4HK900001,*" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).not.toMatch(/entries that are neither/);
  });

  it("warns about an EXPLICIT * and about explicit deny-all only while writes are enabled", () => {
    const widenWarnings: string[] = [];
    loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true", ABAP_ALLOW_TRANSPORTS: "*" }),
      warn: (m) => widenWarnings.push(m),
      skipDotenv: true,
    });
    expect(widenWarnings.join("\n")).toMatch(/WARNING.*ABAP_ALLOW_TRANSPORTS includes "\*"/);

    const denyWarnings: string[] = [];
    loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true", ABAP_ALLOW_TRANSPORTS: "" }),
      warn: (m) => denyWarnings.push(m),
      skipDotenv: true,
    });
    expect(denyWarnings.join("\n")).toMatch(/ABAP_ALLOW_TRANSPORTS is explicitly empty/);

    // Nothing fires while writes stay off.
    const quiet: string[] = [];
    loadConfig({
      env: env({ ABAP_ALLOW_TRANSPORTS: "*" }),
      warn: (m) => quiet.push(m),
      skipDotenv: true,
    });
    expect(quiet.join("\n")).not.toMatch(/ABAP_ALLOW_TRANSPORTS/);
  });

  it('the defaulted case (unset, writes on) gets its own informational NOTE, distinct from the explicit-"*" WARNING', () => {
    const defaulted: string[] = [];
    loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true" }),
      warn: (m) => defaulted.push(m),
      skipDotenv: true,
    });
    const joined = defaulted.join("\n");
    // It DOES now mention the variable — same precedent as the
    // defaultedPackages/defaultedNamePrefixes NOTEs, which also name theirs —
    // but as a NOTE about the default, never the "*"-widen WARNING (that one
    // is reserved for an operator who typed "*" themselves).
    expect(joined).toMatch(/NOTE:.*no ABAP_ALLOW_TRANSPORTS configured/);
    expect(joined).not.toMatch(/WARNING.*ABAP_ALLOW_TRANSPORTS includes "\*"/);

    // Setting it explicitly to "*" gets the WARNING instead, not the NOTE —
    // the two must not both fire for the same run.
    const explicitStar: string[] = [];
    loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true", ABAP_ALLOW_TRANSPORTS: "*" }),
      warn: (m) => explicitStar.push(m),
      skipDotenv: true,
    });
    const joinedStar = explicitStar.join("\n");
    expect(joinedStar).toMatch(/WARNING.*ABAP_ALLOW_TRANSPORTS includes "\*"/);
    expect(joinedStar).not.toMatch(/no ABAP_ALLOW_TRANSPORTS configured/);
  });

  it("carries allowTransports into the redacted projection unchanged", () => {
    const c = loadConfig({
      env: env({ ABAP_ALLOW_TRANSPORTS: "A4HK900123,A4HK900456" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(redactConfigSecrets(c).allowTransports).toEqual(["A4HK900123", "A4HK900456"]);
  });
});

describe("config: ABAP_ALLOW_TRANSPORT_RELEASE resolution — a ceiling, NOT implied by ABAP_ALLOW_WRITE", () => {
  it("defaults to false", () => {
    const c = loadConfig({ env: env(), warn: () => {}, skipDotenv: true });
    expect(c.allowTransportRelease).toBe(false);
  });

  it("stays false when ABAP_ALLOW_WRITE is on but ABAP_ALLOW_TRANSPORT_RELEASE is not set", () => {
    const c = loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.readOnly).toBe(false);
    expect(c.allowTransportRelease).toBe(false);
  });

  it("turns on only with an explicit truthy value, independent of ABAP_ALLOW_WRITE", () => {
    const c = loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true", ABAP_ALLOW_TRANSPORT_RELEASE: "true" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.allowTransportRelease).toBe(true);
  });

  it("accepts the same truthy tokens as every other boolish flag (1/true/yes/on, case-insensitive)", () => {
    for (const token of ["1", "true", "yes", "on", "TRUE", "On"]) {
      const c = loadConfig({
        env: env({ ABAP_ALLOW_TRANSPORT_RELEASE: token }),
        warn: () => {},
        skipDotenv: true,
      });
      expect(c.allowTransportRelease).toBe(true);
    }
  });

  it("setting it true with writes OFF does not itself flip readOnly", () => {
    const c = loadConfig({
      env: env({ ABAP_ALLOW_TRANSPORT_RELEASE: "true" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(c.readOnly).toBe(true);
    expect(c.allowTransportRelease).toBe(true);
  });

  it("warns when enabled, only while writes are also on", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true", ABAP_ALLOW_TRANSPORT_RELEASE: "true" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).toMatch(/ABAP_ALLOW_TRANSPORT_RELEASE=true/);
  });

  it("carries allowTransportRelease into the redacted projection", () => {
    const c = loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true", ABAP_ALLOW_TRANSPORT_RELEASE: "true" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(redactConfigSecrets(c).allowTransportRelease).toBe(true);
  });

  it("never puts the password in the redacted projection even with transports configured", () => {
    const c = loadConfig({
      env: env({
        ABAP_ALLOW_WRITE: "true",
        ABAP_ALLOW_TRANSPORTS: "A4HK900123",
        ABAP_ALLOW_TRANSPORT_RELEASE: "true",
        ABAP_PASSWORD: "s3cr3t-do-not-log",
      }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(JSON.stringify(redactConfigSecrets(c))).not.toContain("s3cr3t-do-not-log");
  });
});
