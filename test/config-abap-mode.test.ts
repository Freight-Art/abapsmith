/**
 * `ABAP_MODE` — the single-env-var permission tier wired into `loadConfig`
 * (Layer 1). `src/mode.ts` owns the pure `parseAbapMode()` /
 * `capabilitiesForMode()` logic and is covered by its own unit tests; this
 * file covers the INTEGRATION seam in `src/config.ts`:
 *
 *   - when `ABAP_MODE` is set, it is authoritative over every
 *     permission-shaped `Config` field, and the five list-shaped legacy vars
 *     (still) narrow within it while the other five are ignored with a
 *     deprecation warning;
 *   - when `ABAP_MODE` is unset, every existing flag parses exactly as it
 *     did before this integration (the "cheap compat shim"), plus one
 *     informational migration NOTE;
 *   - an invalid `ABAP_MODE` value surfaces through the SAME
 *     "Invalid abapsmith configuration" issue list as every other bad env
 *     var, not as a differently-shaped uncaught exception.
 *
 * Scope: imports only `../src/config.js`, same as `test/config-transports.js`
 * — no connection, no server, no mode.ts internals asserted directly.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadConfig,
  RECOGNISED_ABAP_ALLOW_ENV_VARS,
  redactConfigSecrets,
  resolveStaticCapabilities,
} from "../src/config.js";

/** Minimal env that satisfies the required fields, same helper shape as `test/config-transports.test.ts`. */
const env = (over: Record<string, string> = {}): Record<string, string> => ({
  ABAP_URL: "http://sap.invalid:50000",
  ABAP_USER: "U",
  ABAP_PASSWORD: "p",
  ...over,
});

describe("config: ABAP_MODE=read is authoritative over legacy flags", () => {
  it("ABAP_ALLOW_WRITE=true is overridden — readOnly stays true", () => {
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "read", ABAP_ALLOW_WRITE: "true" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.readOnly).toBe(true);
    expect(cfg.abapMode).toBe("read");
  });

  it("resolves the fixed, all-deny capability set regardless of other legacy flags", () => {
    const cfg = loadConfig({
      env: env({
        ABAP_MODE: "read",
        ABAP_ALLOW_WRITE: "true",
        ABAP_ALLOW_TRANSPORT_RELEASE: "true",
        ABAP_ALLOW_SOURCE_PLUGINS: "true",
        ABAP_ALLOW_ENHANCEMENTS: "true",
      }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.readOnly).toBe(true);
    expect(cfg.allowTransportRelease).toBe(false);
    expect(cfg.allowSourcePlugins).toBe(false);
    expect(cfg.allowEnhancements).toBe(false);
    expect(cfg.allowTransports).toEqual([]);
    expect(cfg.capabilities?.mode).toBe("read");
  });

  it("allowTransportDelete and allowCascadeDelete are both denied under read, regardless of legacy flags", () => {
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "read", ABAP_ALLOW_WRITE: "true" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowTransportDelete).toBe(false);
    expect(cfg.allowCascadeDelete).toBe(false);
  });

  it("the permissive ['*'] edit/admin default never leaks into read — allowPackages stays [], even when everything tries to widen it", () => {
    // READ_CAPABILITIES (src/mode.ts) is an override-free all-deny.
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "read", ABAP_ALLOW_PACKAGES: "*", ABAP_ALLOW_WRITE: "true" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowPackages).toEqual([]);
    expect(cfg.readOnly).toBe(true);
  });

  it("all seven AbapModeBooleanOverrides vars set to true still resolve to fully denying, and each fires the read-ignores-overrides warning", () => {
    const warnings: string[] = [];
    const cfg = loadConfig({
      env: env({
        ABAP_MODE: "read",
        ABAP_ALLOW_TRANSPORT_RELEASE: "true",
        ABAP_ALLOW_TRANSPORT_DELETE: "true",
        ABAP_ALLOW_CASCADE_DELETE: "true",
        ABAP_ALLOW_RAW_ADT_WRITES: "true",
        ABAP_ALLOW_ENHANCEMENTS: "true",
        ABAP_ALLOW_SOURCE_PLUGINS: "true",
        ABAP_ALLOW_ENHANCEMENT_DELETE: "true",
      }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(cfg.allowTransportRelease).toBe(false);
    expect(cfg.allowTransportDelete).toBe(false);
    expect(cfg.allowCascadeDelete).toBe(false);
    expect(cfg.allowEnhancements).toBe(false);
    expect(cfg.allowSourcePlugins).toBe(false);
    expect(cfg.capabilities?.allowRawAdtWrites).toBe(false);
    expect(cfg.capabilities?.allowEnhancementDelete).toBe(false);
    expect(cfg.readOnly).toBe(true);

    const joined = warnings.join("\n");
    for (const name of [
      "ABAP_ALLOW_TRANSPORT_RELEASE",
      "ABAP_ALLOW_TRANSPORT_DELETE",
      "ABAP_ALLOW_CASCADE_DELETE",
      "ABAP_ALLOW_RAW_ADT_WRITES",
      "ABAP_ALLOW_ENHANCEMENTS",
      "ABAP_ALLOW_SOURCE_PLUGINS",
      "ABAP_ALLOW_ENHANCEMENT_DELETE",
    ]) {
      expect(joined).toMatch(
        new RegExp(`${name} is set but ignored — ABAP_MODE=read resolves to a fixed`),
      );
    }
  });

  it("ABAP_ENHANCE_TARGETS=sap cannot lift read's floor — enhanceTargets stays 'none'", () => {
    // capabilitiesForMode's read branch early-returns before consulting
    // `overrides` at all — the one ceiling that must survive regardless of
    // the widen/narrow behaviour added for every other mode.
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "read", ABAP_ENHANCE_TARGETS: "sap" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.enhanceTargets).toBe("none");
    expect(cfg.capabilities?.enhanceTargets).toBe("none");
  });
});

describe("config: ABAP_MODE=edit with no legacy overrides", () => {
  it("yields the edit-mode defaults", () => {
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "edit" }),
      warn: () => {},
      skipDotenv: true,
    });
    // EDIT_PACKAGE_DEFAULT in src/mode.ts: an unset ABAP_ALLOW_PACKAGES
    // now defaults to permissive (["*"]), not the old ["$TMP"] guardrail.
    expect(cfg.allowPackages).toEqual(["*"]);
    expect(cfg.readOnly).toBe(false);
    expect(cfg.allowTransportRelease).toBe(false);
    // EDIT_NAME_PREFIX_DEFAULT (src/mode.ts): defaults to ["*"], not ["Z", "Y"].
    expect(cfg.allowNamePrefixes).toEqual(["*"]);
    // EDIT_TRANSPORT_DEFAULT (src/mode.ts): defaults to ["*"], any
    // caller-named request — not ["auto"], auto-select/auto-create only.
    expect(cfg.allowTransports).toEqual(["*"]);
    expect(cfg.allowEnhancements).toBe(true);
    expect(cfg.enhanceTargets).toBe("customer");
    // allowSourcePlugins used
    // to be admin-only, a blanket ceiling with no regard for which host object
    // it targeted. The host object's OWN package is already independently
    // judged by enhanceTargets ("customer" here), the same as every other
    // enhancement write, so requiring admin on top added no protection against
    // an SAP-owned target (already refused) and only blocked the harmless
    // case — creating a hook on an object the caller owns. Now the same tier
    // as allowEnhancements. See src/mode.ts's doc comment on
    // AbapCapabilities.allowSourcePlugins.
    expect(cfg.allowSourcePlugins).toBe(true);
    expect(cfg.abapMode).toBe("edit");
    expect(cfg.capabilities?.mode).toBe("edit");
  });

  it("allowTransportDelete and allowCascadeDelete both stay denied under edit — admin-only ceilings", () => {
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "edit" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowTransportDelete).toBe(false);
    expect(cfg.allowCascadeDelete).toBe(false);
  });

  it("an unset ABAP_ALLOW_PACKAGES resolves to ['*'] — match-anything, not a listing convenience", () => {
    // packagePattern (src/safety.ts) expands "*" to ".*".
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "edit" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowPackages).toEqual(["*"]);
  });
});

describe("config: ABAP_MODE=admin", () => {
  it("unlocks release and source plugins", () => {
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "admin" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowTransportRelease).toBe(true);
    expect(cfg.allowSourcePlugins).toBe(true);
    expect(cfg.readOnly).toBe(false);
    expect(cfg.enhanceTargets).toBe("sap");
    expect(cfg.abapMode).toBe("admin");
  });

  it("unlocks allowTransportDelete and allowCascadeDelete too — the two admin-only ceilings this change closes the gap for", () => {
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "admin" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowTransportDelete).toBe(true);
    expect(cfg.allowCascadeDelete).toBe(true);
  });

  it("an unset ABAP_ALLOW_PACKAGES resolves to ['*'] here too — the default is per-EDIT_PACKAGE_DEFAULT, not per-mode", () => {
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "admin" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowPackages).toEqual(["*"]);
  });
});

describe("config: ABAP_MODE=edit narrowed by a legacy list-shaped override", () => {
  it("ABAP_ALLOW_PACKAGES alongside ABAP_MODE=edit REPLACES the default outright — it does not union $TMP back in", () => {
    // resolvePackages (src/mode.ts) no longer unions $TMP into an override.
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "edit", ABAP_ALLOW_PACKAGES: "Z_CUSTOM" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowPackages).toEqual(["Z_CUSTOM"]);
    expect(cfg.allowPackages).not.toContain("$TMP");
  });

  it("ABAP_ALLOW_TRANSPORTS replaces the mode's ['*'] default outright — a pinned TRKORR is honoured", () => {
    // resolveTransports (src/mode.ts) no longer intersects with a ceiling.
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "edit", ABAP_ALLOW_TRANSPORTS: "A4HK900001" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowTransports).toEqual(["A4HK900001"]);
  });

  it("ABAP_ALLOW_TRANSPORTS=auto alongside ABAP_MODE=edit stays ['auto']", () => {
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "edit", ABAP_ALLOW_TRANSPORTS: "auto" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowTransports).toEqual(["auto"]);
  });

  it("ABAP_ALLOW_TRANSPORTS='*' alongside a mode is taken literally, not folded into 'auto'", () => {
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "edit", ABAP_ALLOW_TRANSPORTS: "*" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowTransports).toEqual(["*"]);
  });

  it("ABAP_ALLOW_TRANSPORTS explicitly empty under a mode is a deny-all, not the ['*'] default", () => {
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "edit", ABAP_ALLOW_TRANSPORTS: "" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowTransports).toEqual([]);
  });

  it("an explicitly empty ABAP_ALLOW_PACKAGES= is a deny-all, not the ['*'] default", () => {
    // Unset vs. explicitly empty is decided from the raw env var.
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "edit", ABAP_ALLOW_PACKAGES: "" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowPackages).toEqual([]);
  });
});

describe("config: ABAP_ENHANCE_TARGETS overrides ABAP_MODE's default in either direction", () => {
  it("WIDEN: ABAP_MODE=edit + ABAP_ENHANCE_TARGETS=sap reaches 'sap' even though edit's own default is 'customer'", () => {
    // Before this fix this override was silently discarded — see the
    // 'set but ignored' regression test below. A mode is a default, not
    // a ceiling, same as every other list-shaped field.
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "edit", ABAP_ENHANCE_TARGETS: "sap" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.enhanceTargets).toBe("sap");
  });

  it("NARROW: ABAP_MODE=admin + ABAP_ENHANCE_TARGETS=customer replaces admin's own 'sap' default", () => {
    // The sharper half: narrowing an admin operator's own default was
    // impossible before this fix (the value was discarded, not floored).
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "admin", ABAP_ENHANCE_TARGETS: "customer" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.enhanceTargets).toBe("customer");
  });

  it("NARROW to deny-all: ABAP_MODE=admin + ABAP_ENHANCE_TARGETS=none replaces admin's own 'sap' default", () => {
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "admin", ABAP_ENHANCE_TARGETS: "none" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.enhanceTargets).toBe("none");
  });

  it("an unset ABAP_ENHANCE_TARGETS still floors to the mode's own default — customer for edit, sap for admin", () => {
    const editCfg = loadConfig({
      env: env({ ABAP_MODE: "edit" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(editCfg.enhanceTargets).toBe("customer");

    const adminCfg = loadConfig({
      env: env({ ABAP_MODE: "admin" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(adminCfg.enhanceTargets).toBe("sap");
  });
});

describe("config: AbapModeBooleanOverrides two-way overrides under a set ABAP_MODE", () => {
  it("ABAP_MODE=admin + ABAP_ALLOW_CASCADE_DELETE=false narrows admin's own grant to false", () => {
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "admin", ABAP_ALLOW_CASCADE_DELETE: "false" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowCascadeDelete).toBe(false);
  });

  it("ABAP_MODE=admin + ABAP_ALLOW_TRANSPORT_DELETE=false narrows admin's own grant to false", () => {
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "admin", ABAP_ALLOW_TRANSPORT_DELETE: "false" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowTransportDelete).toBe(false);
  });

  it("ABAP_MODE=admin + ABAP_ALLOW_TRANSPORT_RELEASE=false narrows admin's own grant to false", () => {
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "admin", ABAP_ALLOW_TRANSPORT_RELEASE: "false" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowTransportRelease).toBe(false);
  });

  it("ABAP_MODE=edit + ABAP_ALLOW_TRANSPORT_RELEASE=true widens edit's own default (false) to true", () => {
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "edit", ABAP_ALLOW_TRANSPORT_RELEASE: "true" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowTransportRelease).toBe(true);
  });

  it("ABAP_ALLOW_ENHANCEMENTS='' (explicitly empty) under ABAP_MODE=edit is an explicit false, not unset", () => {
    // boolOverrideFromEnv: undefined only when the var itself is unset; any
    // set-but-not-truthy value, including "", is an explicit false — it does
    // NOT fall through to edit's own default (which would be true).
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "edit", ABAP_ALLOW_ENHANCEMENTS: "" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowEnhancements).toBe(false);
  });
});

describe("config: ABAP_MODE unset — legacy-only behaviour is unchanged (regression)", () => {
  it("ABAP_ALLOW_WRITE=true alone still yields readOnly:false with ABAP_MODE unset", () => {
    const cfg = loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.readOnly).toBe(false);
    // Package default moved to ["*"] here too.
    expect(cfg.allowPackages).toEqual(["*"]);
    expect(cfg.abapMode).toBeUndefined();
    expect(cfg.capabilities).toBeUndefined();
  });

  it("defaults to fully read-only with nothing set, same as before this change", () => {
    const cfg = loadConfig({ env: env(), warn: () => {}, skipDotenv: true });
    expect(cfg.readOnly).toBe(true);
    // Unconditional default — ["*"], not ["auto"], even read-only
    // (readOnly gates the write opt-in; it does not change what the
    // transport allowlist itself resolves to).
    expect(cfg.allowTransports).toEqual(["*"]);
    // Unconditional default — ["*"], not ["Z", "Y"], even read-only.
    expect(cfg.allowNamePrefixes).toEqual(["*"]);
  });

  it("ABAP_ALLOW_TRANSPORTS explicitly empty still fails closed with ABAP_MODE unset", () => {
    const cfg = loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true", ABAP_ALLOW_TRANSPORTS: "" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowTransports).toEqual([]);
  });

  it("allowTransportDelete/allowCascadeDelete default to false under legacy config when their own vars are unset", () => {
    // ABAP_ALLOW_TRANSPORT_DELETE / ABAP_ALLOW_CASCADE_DELETE are now
    // read directly under the legacy (mode-unset) path too — see the sibling
    // test below. Neither is implied by ABAP_ALLOW_WRITE or any other
    // write-adjacent flag, so leaving them unset stays a hard false.
    const cfg = loadConfig({
      env: env({
        ABAP_ALLOW_WRITE: "true",
        ABAP_ALLOW_TRANSPORT_RELEASE: "true",
        ABAP_ALLOW_ENHANCEMENTS: "true",
        ABAP_ALLOW_SOURCE_PLUGINS: "true",
      }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowTransportDelete).toBe(false);
    expect(cfg.allowCascadeDelete).toBe(false);
    expect(cfg.abapMode).toBeUndefined();
  });

  it("ABAP_ALLOW_PACKAGES= explicitly empty is a deny-all under the legacy path too", () => {
    const cfg = loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true", ABAP_ALLOW_PACKAGES: "" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowPackages).toEqual([]);
  });

  it("ABAP_ALLOW_TRANSPORT_DELETE now has a legacy env var of its own — true when set, false when unset", () => {
    const on = loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true", ABAP_ALLOW_TRANSPORT_DELETE: "true" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(on.allowTransportDelete).toBe(true);

    const off = loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(off.allowTransportDelete).toBe(false);
  });

  it("ABAP_ALLOW_CASCADE_DELETE now has a legacy env var of its own — true when set, false when unset", () => {
    const on = loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true", ABAP_ALLOW_CASCADE_DELETE: "true" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(on.allowCascadeDelete).toBe(true);

    const off = loadConfig({
      env: env({ ABAP_ALLOW_WRITE: "true" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(off.allowCascadeDelete).toBe(false);
  });
});

describe("config: ABAP_MODE=bogus surfaces a config error, not a bare exception", () => {
  it("throws through the same 'Invalid abapsmith configuration' issue-list mechanism", () => {
    expect(() =>
      loadConfig({ env: env({ ABAP_MODE: "bogus" }), warn: () => {}, skipDotenv: true }),
    ).toThrowError(/Invalid abapsmith configuration:/);
  });

  it("names the bad value and the field", () => {
    try {
      loadConfig({ env: env({ ABAP_MODE: "bogus" }), warn: () => {}, skipDotenv: true });
      expect.unreachable("loadConfig should have thrown");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).toContain("abapMode");
      expect(message).toContain("bogus");
    }
  });

  it("combines with an independently-invalid field (missing ABAP_URL) in one thrown error", () => {
    try {
      loadConfig({
        env: { ABAP_USER: "U", ABAP_PASSWORD: "p", ABAP_MODE: "bogus" },
        warn: () => {},
        skipDotenv: true,
      });
      expect.unreachable("loadConfig should have thrown");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).toContain("abapMode");
      expect(message).toMatch(/url/i);
    }
  });
});

describe("config: ABAP_ENHANCE_TARGETS='' is a config-time rejection, not a silent alias for 'none'", () => {
  // Unlike the other list-shaped overrides, "" already has an explicit
  // spelling for deny-all ("none"), so an empty string here is treated as a
  // typo'd config rather than a second way to spell it — same shape of
  // decision as ABAP_MODE=bogus above, reusing the same combined issue list.
  it("throws through the same 'Invalid abapsmith configuration' issue-list mechanism, naming the three legal values", () => {
    try {
      loadConfig({
        env: env({ ABAP_MODE: "edit", ABAP_ENHANCE_TARGETS: "" }),
        warn: () => {},
        skipDotenv: true,
      });
      expect.unreachable("loadConfig should have thrown");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).toContain("Invalid abapsmith configuration:");
      expect(message).toContain("enhanceTargets");
      expect(message).toMatch(/"none"/);
      expect(message).toMatch(/"customer"/);
      expect(message).toMatch(/"sap"/);
    }
  });

  it("also rejects a bogus (non-empty) value the same way", () => {
    try {
      loadConfig({
        env: env({ ABAP_MODE: "edit", ABAP_ENHANCE_TARGETS: "everything" }),
        warn: () => {},
        skipDotenv: true,
      });
      expect.unreachable("loadConfig should have thrown");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).toContain("enhanceTargets");
      expect(message).toContain("everything");
    }
  });

  it("combines with an independently-invalid field (bogus ABAP_MODE) in one thrown error", () => {
    try {
      loadConfig({
        env: env({ ABAP_MODE: "bogus", ABAP_ENHANCE_TARGETS: "" }),
        warn: () => {},
        skipDotenv: true,
      });
      expect.unreachable("loadConfig should have thrown");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).toContain("abapMode");
      expect(message).toContain("enhanceTargets");
    }
  });

  it("is also rejected with ABAP_MODE unset — the legacy path gets the same treatment", () => {
    try {
      loadConfig({
        env: env({ ABAP_ENHANCE_TARGETS: "" }),
        warn: () => {},
        skipDotenv: true,
      });
      expect.unreachable("loadConfig should have thrown");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).toContain("enhanceTargets");
    }
  });
});

describe("config: deprecation warning when a legacy flag is set alongside ABAP_MODE", () => {
  it("warns once for ABAP_ALLOW_WRITE set alongside ABAP_MODE", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_MODE: "edit", ABAP_ALLOW_WRITE: "true" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).toMatch(
      /ABAP_ALLOW_WRITE is set but ignored — ABAP_MODE is set and is now the source of truth/,
    );
  });

  it("warns for the one non-overridable legacy flag — down from five, down from two", () => {
    // MODE_GOVERNED_LEGACY_ENV_VARS (src/mode.ts) now derives to only the
    // single capability with no override slot at all: allowWrite.
    // enhanceTargets joined the other seven as a live override — see the
    // "does NOT warn" test below.
    const warnings: string[] = [];
    loadConfig({
      env: env({
        ABAP_MODE: "admin",
        ABAP_ALLOW_WRITE: "true",
      }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    const joined = warnings.join("\n");
    expect(joined).toContain("ABAP_ALLOW_WRITE is set but ignored");
    expect(joined).not.toContain("ABAP_ENHANCE_TARGETS is set but ignored");
  });

  it("does NOT warn for the eight now-overridable flags — they take effect instead of being ignored, enhanceTargets included", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({
        ABAP_MODE: "admin",
        ABAP_ALLOW_TRANSPORT_RELEASE: "true",
        ABAP_ALLOW_TRANSPORT_DELETE: "true",
        ABAP_ALLOW_CASCADE_DELETE: "true",
        ABAP_ALLOW_RAW_ADT_WRITES: "true",
        ABAP_ALLOW_ENHANCEMENTS: "true",
        ABAP_ALLOW_SOURCE_PLUGINS: "true",
        ABAP_ALLOW_ENHANCEMENT_DELETE: "true",
        ABAP_ENHANCE_TARGETS: "sap",
      }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    const joined = warnings.join("\n");
    for (const name of [
      "ABAP_ALLOW_TRANSPORT_RELEASE",
      "ABAP_ALLOW_TRANSPORT_DELETE",
      "ABAP_ALLOW_CASCADE_DELETE",
      "ABAP_ALLOW_RAW_ADT_WRITES",
      "ABAP_ALLOW_ENHANCEMENTS",
      "ABAP_ALLOW_SOURCE_PLUGINS",
      "ABAP_ALLOW_ENHANCEMENT_DELETE",
      "ABAP_ENHANCE_TARGETS",
    ]) {
      expect(joined).not.toContain(`${name} is set but ignored`);
    }
  });

  it("does not warn about a legacy flag that was not set", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_MODE: "edit" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).not.toMatch(/is set but ignored/);
  });

  it("a list-shaped override var (ABAP_ALLOW_PACKAGES) does NOT trigger the ignored-flag warning — it narrows instead", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_MODE: "edit", ABAP_ALLOW_PACKAGES: "Z_CUSTOM" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).not.toMatch(/ABAP_ALLOW_PACKAGES is set but ignored/);
  });

  it("emits an informational migration NOTE when ABAP_MODE is unset", () => {
    const warnings: string[] = [];
    loadConfig({ env: env(), warn: (m) => warnings.push(m), skipDotenv: true });
    expect(warnings.join("\n")).toMatch(
      /Configured via legacy per-flag env vars\. Consider migrating to a single ABAP_MODE=read\|edit\|admin/,
    );
  });

  it("does not emit the migration NOTE when ABAP_MODE is set", () => {
    const warnings: string[] = [];
    loadConfig({ env: env({ ABAP_MODE: "edit" }), warn: (m) => warnings.push(m), skipDotenv: true });
    expect(warnings.join("\n")).not.toMatch(/Consider migrating/);
  });

  it("warns about the permissive ['*'] default when ABAP_MODE=edit leaves ABAP_ALLOW_PACKAGES unset", () => {
    // defaultedPackages (src/config.ts) fires only when the allowlist
    // was silently defaulted, not whenever writes are on.
    const warnings: string[] = [];
    loadConfig({ env: env({ ABAP_MODE: "edit" }), warn: (m) => warnings.push(m), skipDotenv: true });
    const joined = warnings.join("\n");
    expect(joined).toMatch(/no ABAP_ALLOW_PACKAGES configured/);
    expect(joined).toMatch(/\[\*\]/);
    expect(joined).toMatch(/EVERY customer package/i);
    // Must not claim the old $TMP-only guardrail is still in force.
    expect(joined).not.toMatch(/Local objects only/);
  });

  it("does not warn about a defaulted allowlist when ABAP_ALLOW_PACKAGES is set alongside ABAP_MODE=edit", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_MODE: "edit", ABAP_ALLOW_PACKAGES: "ZFOO" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).not.toMatch(/no ABAP_ALLOW_PACKAGES configured/);
  });
});

describe("config: the enhancement-targets startup line names its source honestly across all three shapes", () => {
  it("ABAP_MODE unset: names the legacy var directly — 'ABAP_ENHANCE_TARGETS=<value>'", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_ALLOW_ENHANCEMENTS: "true", ABAP_ENHANCE_TARGETS: "customer" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).toContain("ABAP_ENHANCE_TARGETS=customer");
  });

  it("ABAP_MODE set, no override: names the mode as the source — 'targets=<value>, from ABAP_MODE=<mode>'", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_MODE: "admin", ABAP_ALLOW_ENHANCEMENTS: "true" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).toContain("targets=sap, from ABAP_MODE=admin");
  });

  it("ABAP_MODE set AND overridden: names the override as replacing the mode's default", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_MODE: "edit", ABAP_ALLOW_ENHANCEMENTS: "true", ABAP_ENHANCE_TARGETS: "sap" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).toContain(
      "targets=sap, from ABAP_ENHANCE_TARGETS (overriding ABAP_MODE=edit's default)",
    );
  });
});

describe("config: the empty-ABAP_ENHANCE_TARGET_PACKAGES NOTE still fires when 'sap' is reached by widening under a non-admin mode", () => {
  it("ABAP_MODE=edit + ABAP_ENHANCE_TARGETS=sap with no target packages still warns — the widened value is not exempt", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_MODE: "edit", ABAP_ALLOW_ENHANCEMENTS: "true", ABAP_ENHANCE_TARGETS: "sap" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).toMatch(
      /enhancement targets are 'sap' but ABAP_ENHANCE_TARGET_PACKAGES is\s+empty/,
    );
  });

  it("the same warning does NOT fire once ABAP_ENHANCE_TARGET_PACKAGES names a package", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({
        ABAP_MODE: "edit",
        ABAP_ALLOW_ENHANCEMENTS: "true",
        ABAP_ENHANCE_TARGETS: "sap",
        ABAP_ENHANCE_TARGET_PACKAGES: "ZFOO",
      }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).not.toMatch(/ABAP_ENHANCE_TARGET_PACKAGES is\s+empty/);
  });
});

describe("config: redactConfigSecrets carries abapMode/capabilities plainly (nothing sensitive in either)", () => {
  it("includes the resolved mode and capability set when ABAP_MODE is set", () => {
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "admin" }),
      warn: () => {},
      skipDotenv: true,
    });
    const redacted = redactConfigSecrets(cfg);
    expect(redacted.abapMode).toBe("admin");
    expect((redacted.capabilities as { mode: string } | undefined)?.mode).toBe("admin");
  });

  it("shows a legacy-config placeholder when ABAP_MODE is unset", () => {
    const cfg = loadConfig({ env: env(), warn: () => {}, skipDotenv: true });
    const redacted = redactConfigSecrets(cfg);
    expect(redacted.abapMode).toBe("(unset — legacy per-flag config)");
    expect(redacted.capabilities).toBeUndefined();
  });

  it("never puts the password in the redacted projection under ABAP_MODE either", () => {
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "admin", ABAP_PASSWORD: "s3cr3t-do-not-log" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(JSON.stringify(redactConfigSecrets(cfg))).not.toContain("s3cr3t-do-not-log");
  });
});

/**
 * `ABAP_ALLOW_DUMP_VARIABLES` — the tier-2 gate for runtime-error dump reads.
 * Lives in this file because the property
 * that matters most about it is a `loadConfig` INTEGRATION property, the same
 * seam every other test here covers: the flag must survive `ABAP_MODE`
 * untouched in both directions, and must never be derived from `readOnly`.
 *
 * Tier 1 (error class, program, include, line, source extract, call stack) has
 * no flag and therefore nothing to test here — that absence is deliberate and
 * is asserted in `test/safety.test.ts` instead, where `evaluate("read")` is
 * shown to stay allowed.
 */
const dumpCaps = (over: Record<string, string> = {}) =>
  resolveStaticCapabilities(loadConfig({ env: env(over), warn: () => {}, skipDotenv: true }));

describe("config: ABAP_ALLOW_DUMP_VARIABLES parsing", () => {
  it("defaults OFF with nothing set", () => {
    const cfg = loadConfig({ env: env(), warn: () => {}, skipDotenv: true });
    expect(cfg.allowDumpVariables).toBe(false);
    expect(resolveStaticCapabilities(cfg).canReadDumpVariables).toBe(false);
  });

  it("accepts the same truthy spellings as every other ABAP_ALLOW_* flag", () => {
    // `boolFromEnv` in src/config.ts: 1/true/yes/on, trimmed, case-insensitive.
    for (const v of ["1", "true", "TRUE", "True", "yes", "YES", "on", "ON", "  true  "]) {
      const cfg = loadConfig({
        env: env({ ABAP_ALLOW_DUMP_VARIABLES: v }),
        warn: () => {},
        skipDotenv: true,
      });
      expect(cfg.allowDumpVariables, `spelling ${JSON.stringify(v)}`).toBe(true);
    }
  });

  it("treats every other value — including plausible-looking ones — as OFF, exactly like ABAP_ALLOW_DATA_PREVIEW", () => {
    // Same rejection shape as its neighbour flag, asserted side by side so the
    // two cannot drift: an unrecognised value is not an error and is not
    // truthy, it is simply off. `enabled`/`y`/`2` are here because they are
    // what an operator actually mistypes.
    for (const v of ["", " ", "0", "false", "FALSE", "no", "off", "maybe", "enabled", "y", "2"]) {
      const cfg = loadConfig({
        env: env({ ABAP_ALLOW_DUMP_VARIABLES: v, ABAP_ALLOW_DATA_PREVIEW: v }),
        warn: () => {},
        skipDotenv: true,
      });
      expect(cfg.allowDumpVariables, `spelling ${JSON.stringify(v)}`).toBe(false);
      expect(cfg.allowDataPreview, `spelling ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("warns loudly on stderr when it is on, and says nothing when it is off", () => {
    const on: string[] = [];
    loadConfig({
      env: env({ ABAP_ALLOW_DUMP_VARIABLES: "true" }),
      warn: (m) => on.push(m),
      skipDotenv: true,
    });
    expect(on.join("\n")).toMatch(/ABAP_ALLOW_DUMP_VARIABLES=true/);
    expect(on.join("\n")).toMatch(/personal data/);

    const off: string[] = [];
    loadConfig({ env: env(), warn: (m) => off.push(m), skipDotenv: true });
    expect(off.join("\n")).not.toMatch(/ABAP_ALLOW_DUMP_VARIABLES/);
  });

  it("appears in the redacted projection (a permission boolean, nothing sensitive)", () => {
    const cfg = loadConfig({
      env: env({ ABAP_ALLOW_DUMP_VARIABLES: "true" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(redactConfigSecrets(cfg).allowDumpVariables).toBe(true);
  });
});

describe("config: canReadDumpVariables is orthogonal to write capability", () => {
  it("THE PROPERTY: true when the flag is on AND the server is read-only", () => {
    // The single most important assertion in this file's dump coverage. A dump
    // read is a READ, so the read-only server — the configuration an operator
    // picks precisely because they are being careful on a system that matters —
    // must be able to hold this capability. If `canReadDumpVariables` ever
    // grows an `&& canWrite`, this is the test that fails, and the bug it
    // catches is an INVERTED control: read-only would then mean "no dump
    // variables" while a write-enabled sandbox got them.
    const cfg = loadConfig({
      env: env({ ABAP_ALLOW_DUMP_VARIABLES: "true" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.readOnly).toBe(true);
    const caps = resolveStaticCapabilities(cfg);
    expect(caps.canWrite).toBe(false);
    expect(caps.canReadDumpVariables).toBe(true);
  });

  it("the same holds under the explicit ABAP_MODE=read ceiling", () => {
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "read", ABAP_ALLOW_DUMP_VARIABLES: "true" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.abapMode).toBe("read");
    expect(cfg.readOnly).toBe(true);
    expect(cfg.allowDumpVariables).toBe(true);
    expect(resolveStaticCapabilities(cfg).canReadDumpVariables).toBe(true);
  });

  it("ABAP_ALLOW_WRITE=true alone does NOT buy dump variables", () => {
    const caps = dumpCaps({ ABAP_ALLOW_WRITE: "true" });
    expect(caps.canWrite).toBe(true);
    expect(caps.canReadDumpVariables).toBe(false);
  });

  it("ABAP_ALLOW_DUMP_VARIABLES=true alone does NOT buy writes", () => {
    const caps = dumpCaps({ ABAP_ALLOW_DUMP_VARIABLES: "true" });
    expect(caps.canReadDumpVariables).toBe(true);
    expect(caps.canWrite).toBe(false);
    expect(caps.canReleaseTransport).toBe(false);
    expect(caps.canEnhance).toBe(false);
  });

  it("no ABAP_MODE grants it — not even admin", () => {
    for (const mode of ["read", "edit", "admin"]) {
      expect(dumpCaps({ ABAP_MODE: mode }).canReadDumpVariables, mode).toBe(false);
      expect(
        dumpCaps({ ABAP_MODE: mode, ABAP_ALLOW_DUMP_VARIABLES: "true" }).canReadDumpVariables,
        mode,
      ).toBe(true);
    }
  });

  it("it is not part of AbapCapabilities at all — the mode layer never sees it", () => {
    // Unlike `allowDataPreview`, which is fed through `capabilitiesForMode` as
    // a grant, this flag has no capability field: `loadConfig` reads it from
    // the env var and writes it straight onto `Config`, the
    // `allowDebugJumpToLine` shape. Asserted so a later "tidy-up" that folds it
    // into the mode layer has to change a test that says why it should not.
    const cfg = loadConfig({
      env: env({ ABAP_MODE: "admin", ABAP_ALLOW_DUMP_VARIABLES: "true" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.allowDumpVariables).toBe(true);
    expect(cfg.capabilities).toBeDefined();
    expect(Object.keys(cfg.capabilities ?? {})).not.toContain("allowDumpVariables");
  });

  it("setting it alongside ABAP_MODE is NOT deprecated — it is the only way to turn it on", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_MODE: "read", ABAP_ALLOW_DUMP_VARIABLES: "true" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).not.toMatch(/ABAP_ALLOW_DUMP_VARIABLES is set but ignored/);
  });
});

// ---------------------------------------------------------------------------
// Unrecognised ABAP_ALLOW_* names: an operator typo of an
// ABAP_ALLOW_* flag must be reported, not silently ignored — see the live
// incident in RECOGNISED_ABAP_ALLOW_ENV_VARS's doc comment (src/config.ts).
// ---------------------------------------------------------------------------

/**
 * Comment stripper, same single-pass scanner as test/journal-contract.test.ts
 * and friends: blanks `//` and `/* *\/` comments while keeping string/template
 * bodies intact, so a doc comment or warn() message that happens to contain
 * `env.ABAP_ALLOW_X` text can't be mistaken for a real read.
 */
function stripComments(text: string): string {
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  let mode: Mode = "code";
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (mode === "code") {
      if (c === "/" && d === "*") {
        mode = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "/" && d === "/") {
        mode = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === '"') mode = "double";
      else if (c === "'") mode = "single";
      else if (c === "`") mode = "template";
      out += c;
      i += 1;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") mode = "code";
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && d === "/") {
        mode = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    // Inside a string or template literal: copy through, honouring escapes.
    if (c === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (
      (mode === "double" && c === '"') ||
      (mode === "single" && c === "'") ||
      (mode === "template" && c === "`")
    ) {
      mode = "code";
    }
    out += c;
    i += 1;
  }
  return out;
}

const CONFIG_SRC_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "config.ts");
const CONFIG_SRC_CODE = stripComments(readFileSync(CONFIG_SRC_PATH, "utf8"));

/**
 * `env.NAME` reads (the form used throughout), plus `env["NAME"]` so a
 * future switch to bracket access doesn't fall outside this guard. `code`
 * has comments already stripped, so prose mentions don't count as reads.
 */
function extractReadAllowVars(code: string): Set<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(/\benv\.(ABAP_ALLOW_[A-Z_]+)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\benv\[["'](ABAP_ALLOW_[A-Z_]+)["']\]/g)) names.add(m[1]);
  return names;
}

describe("RECOGNISED_ABAP_ALLOW_ENV_VARS stays in lockstep with the real reads", () => {
  it("equals the set of ABAP_ALLOW_* names src/config.ts actually reads off env", () => {
    const actual = [...extractReadAllowVars(CONFIG_SRC_CODE)].sort();
    const declared = [...RECOGNISED_ABAP_ALLOW_ENV_VARS].sort();
    // Two-directional by construction (toEqual on sorted arrays): a 16th
    // ABAP_ALLOW_* read added to config.ts without a matching list entry
    // fails here, and so does a stale list entry nothing reads anymore.
    expect(actual).toEqual(declared);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(RECOGNISED_ABAP_ALLOW_ENV_VARS)).toBe(true);
  });
});

describe("config: unrecognised ABAP_ALLOW_* names warn", () => {
  it("a misspelled name produces the warning and names the offending variable", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_ALLOW_TRANSPORTS_DELETE: "true" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    const joined = warnings.join("\n");
    expect(joined).toContain("ABAP_ALLOW_TRANSPORTS_DELETE");
    expect(joined).toMatch(/not a setting this server reads/);
    expect(joined).toMatch(/typo/i);
  });

  it("every one of the 15 recognised names, set together, produces no unrecognised-name warning", () => {
    const warnings: string[] = [];
    const allSet = Object.fromEntries(RECOGNISED_ABAP_ALLOW_ENV_VARS.map((n) => [n, "true"]));
    loadConfig({
      env: env(allSet),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).not.toMatch(/not a setting this server reads/);
  });

  it("fires under ABAP_MODE=read too", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_MODE: "read", ABAP_ALLOW_ENHANCEMENT_DELETES: "true" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).toContain("ABAP_ALLOW_ENHANCEMENT_DELETES");
  });

  it("an empty value still warns — presence is the signal, not truthiness", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_ALLOW_BOGUS: "" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).toContain("ABAP_ALLOW_BOGUS");
  });

  it("never fires for a non-ABAP_ALLOW_ variable, however ABAP_-shaped or unrelated", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_TIMEOUT_MS: "60000", PATH: "/usr/bin" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.join("\n")).not.toMatch(/not a setting this server reads/);
  });

  it("sorts multiple unrecognised names deterministically", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_ALLOW_ZEBRA: "true", ABAP_ALLOW_AARDVARK: "true" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    const joined = warnings.join("\n");
    expect(joined.indexOf("ABAP_ALLOW_AARDVARK")).toBeLessThan(joined.indexOf("ABAP_ALLOW_ZEBRA"));
  });
});
