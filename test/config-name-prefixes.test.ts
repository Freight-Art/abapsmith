/**
 * `ABAP_ALLOW_NAME_PREFIXES` — env string in, resolved allow-list out, plus the
 * `*` wildcard that turns the object-name rule off.
 *
 * Sibling of `test/config-transports.test.ts`, and it exists for the same
 * reason: the resolution is three lines of `splitList` plus a truthiness check,
 * and the safety property lives entirely in which of those lines fires.
 *
 *   - UNSET            ⇒ ["*"]       no restriction by default
 *   - explicitly ""    ⇒ ["*"]       same as unset — NOT the [Z, Y] fallback
 *   - "*"              ⇒ ["*"]       the name rule is off
 *
 * The default flipped from ["Z", "Y"] to ["*"]: `loadConfig`'s own
 * resolution now defaults open, unconditionally, and warns about it when
 * writes are on. (The zod `ConfigSchema` default is a separate, hand-built
 * `.parse()` path and stays fail-closed at ["Z", "Y"] — out of scope here.)
 *
 * Scope: imports `../src/config.js` and NOTHING else from src — that is what
 * earns the config-only exemption in `test/system-role-probe-guard.test.ts`,
 * and it is why the "does this list read as unrestricted?" half of the wildcard
 * (`isUnrestrictedPrefixList`, which lives in `src/safety.js`) is asserted in
 * `test/safety.test.ts` instead of here. This file's job is the env string →
 * resolved list step, and the banner that reports it.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const env = (over: Record<string, string> = {}): Record<string, string> => ({
  ABAP_URL: "http://sap.invalid:50000",
  ABAP_USER: "U",
  ABAP_PASSWORD: "p",
  ...over,
});

/** Resolve `allowNamePrefixes` for a given raw env value; omit `raw` to leave it unset. */
const resolve = (raw?: string, over: Record<string, string> = {}): string[] => [
  ...loadConfig({
    env: env({ ...(raw === undefined ? {} : { ABAP_ALLOW_NAME_PREFIXES: raw }), ...over }),
    warn: () => {},
    skipDotenv: true,
  }).allowNamePrefixes,
];

describe("ABAP_ALLOW_NAME_PREFIXES resolution", () => {
  it("UNSET yields the ['*'] default — unconditionally, even with writes off", () => {
    expect(resolve()).toEqual(["*"]);
  });

  it("explicitly EMPTY also yields ['*'] — same as unset", () => {
    expect(resolve("")).toEqual(["*"]);
    expect(resolve("   ")).toEqual(["*"]);
    expect(resolve(",,")).toEqual(["*"]);
  });

  it("a list is taken literally and replaces the default", () => {
    expect(resolve("ZMCP_")).toEqual(["ZMCP_"]);
    expect(resolve("ZMCP_, YACME")).toEqual(["ZMCP_", "YACME"]);
  });

  it("'*' survives resolution intact — it is not normalised, split or dropped", () => {
    // The gate reads the token itself, so anything that mangled it here would
    // silently re-enable the rule. `test/safety.test.ts` owns the other half:
    // that `["*"]` is what `isUnrestrictedPrefixList` says yes to.
    expect(resolve("*")).toEqual(["*"]);
    expect(resolve("* ")).toEqual(["*"]);
  });

  it("reaches the same value through ABAP_MODE=edit, whose override replaces the default outright", () => {
    expect(resolve("*", { ABAP_MODE: "edit" })).toEqual(["*"]);
    expect(resolve(undefined, { ABAP_MODE: "edit" })).toEqual(["*"]);
  });

  it("ABAP_MODE=edit/admin plus explicitly EMPTY also folds to ['*'] — capabilitiesForMode now agrees with the legacy fold", () => {
    expect(resolve("", { ABAP_MODE: "edit" })).toEqual(["*"]);
    expect(resolve("", { ABAP_MODE: "admin" })).toEqual(["*"]);
  });

  it("ABAP_MODE=read plus explicitly EMPTY is unaffected — read denies writes structurally before this fold matters", () => {
    expect(resolve("", { ABAP_MODE: "read" })).toEqual([]);
  });
});

describe("startup banner under the wildcard", () => {
  const banner = (over: Record<string, string>): string => {
    const lines: string[] = [];
    loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true", ...over }),
      warn: (m: string) => lines.push(m),
      skipDotenv: true,
    });
    return lines.find((l) => l.includes("ABAP_ALLOW_WRITE=true")) ?? "";
  };

  it("says plainly that the name rule is disabled, instead of printing [*] as if it were a prefix", () => {
    const b = banner({ ABAP_ALLOW_NAME_PREFIXES: "*" });
    expect(b).toContain("ANY object name");
    expect(b).toContain("DISABLED");
    // The operator must not be left thinking SAP objects opened up too.
    expect(b).toMatch(/SAP-owned .* still refused/);
    expect(b).not.toContain("names starting with");
  });

  it("still names the prefixes when there is a real, explicit restriction", () => {
    expect(banner({ ABAP_ALLOW_NAME_PREFIXES: "ZMCP_" })).toContain(
      "names starting with [ZMCP_]",
    );
    expect(banner({ ABAP_ALLOW_NAME_PREFIXES: "Z,Y" })).toContain(
      "names starting with [Z, Y]",
    );
  });

  it("unset also reads as the wildcard now — defaults open, not to [Z, Y]", () => {
    const b = banner({});
    expect(b).toContain("ANY object name");
    expect(b).toContain("DISABLED");
  });

  it("unset fires the NOTE explaining the ['*'] default, only while writes are on", () => {
    const lines: string[] = [];
    loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true" }),
      warn: (m: string) => lines.push(m),
      skipDotenv: true,
    });
    expect(lines.some((l) => l.includes("NOTE: no ABAP_ALLOW_NAME_PREFIXES configured"))).toBe(true);

    const readOnlyLines: string[] = [];
    loadConfig({
      env: env({}),
      warn: (m: string) => readOnlyLines.push(m),
      skipDotenv: true,
    });
    expect(readOnlyLines.some((l) => l.includes("NOTE: no ABAP_ALLOW_NAME_PREFIXES configured"))).toBe(
      false,
    );
  });
});

describe("ABAP_MODE=edit/admin plus an explicitly empty ABAP_ALLOW_NAME_PREFIXES", () => {
  const lines = (mode: string): string[] => {
    const out: string[] = [];
    loadConfig({
      env: env({ ABAP_MODE: mode, ABAP_ALLOW_NAME_PREFIXES: "" }),
      warn: (m: string) => out.push(m),
      skipDotenv: true,
    });
    return out;
  };

  it.each(["edit", "admin"])("%s: cfg.allowNamePrefixes is ['*'], not []", (mode) => {
    const cfg = loadConfig({
      env: env({ ABAP_MODE: mode, ABAP_ALLOW_NAME_PREFIXES: "" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowNamePrefixes).toEqual(["*"]);
  });

  it.each(["edit", "admin"])(
    "%s: the banner names the wildcard/DISABLED wording, never the literal 'names starting with []'",
    (mode) => {
      const b = lines(mode).find((l) => l.includes("writes, deletes, activation and execution are ENABLED")) ?? "";
      expect(b).toContain("ANY object name");
      expect(b).toContain("DISABLED");
      expect(b).not.toContain("names starting with [");
    },
  );

  it.each(["edit", "admin"])(
    "%s: the 'object-name rule is OFF' NOTE fires, quoted as written in src/config.ts",
    (mode) => {
      expect(
        lines(mode).some((l) =>
          l.includes(
            "NOTE: no ABAP_ALLOW_NAME_PREFIXES configured — the object-name rule is OFF: any name outside the SAP namespace may be written, not just Z*/Y*.",
          ),
        ),
      ).toBe(true);
    },
  );

  it("ABAP_MODE=read is entirely unaffected — read early-returns before the fold and the NOTE never fires", () => {
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "read", ABAP_ALLOW_NAME_PREFIXES: "" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowNamePrefixes).toEqual([]);
    expect(lines("read").some((l) => l.includes("NOTE: no ABAP_ALLOW_NAME_PREFIXES configured"))).toBe(
      false,
    );
  });
});
