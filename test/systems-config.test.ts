/**
 * `loadSystems()` (src/systems/spec.ts) — parsing, validation and
 * defaulting of multi-system configuration (issue #93).
 *
 * Pins:
 *  - the no-config fallthrough (`undefined`, so a caller falls back to
 *    single-system `loadConfig()`),
 *  - both input sources (`ABAP_SYSTEMS` file/inline-JSON, and
 *    `ABAP_SYSTEM_<ALIAS>_<SETTING>` env vars) and that meta-settings
 *    (`default`, `password_env`) never leak into a system's `Config` as a
 *    literal `ABAP_DEFAULT`/`ABAP_PASSWORD_ENV` overlay var,
 *  - secret handling (`password_env`/`secrets` indirection only; a literal
 *    `password`/`passwd`/`pass` key in the file is refused without echoing
 *    the value; a forbidden secret-shaped name under `env` is refused too),
 *  - alias syntax (`[A-Z0-9]{1,16}`, no `_`),
 *  - every defaulting rule (top-level, per-entry, single-entry-implicit,
 *    ambiguous, none-marked),
 *  - that every problem found is aggregated into ONE thrown `Error` rather
 *    than failing on the first one, and
 *  - that a (sid,url,client) collision across two aliases is a WARNING, not
 *    a validation error.
 *
 * All assertions are on structured substrings a human would read (error
 * codes don't exist here — `loadSystems` throws plain `Error`s — so this
 * matches on message substrings), never full-string equality, so the tests
 * survive wording polish that doesn't change meaning.
 */
import { describe, expect, it, vi } from "vitest";
import { loadSystems, isValidAlias } from "../src/systems/spec.js";

/** Minimal env for one system, so `loadConfig` succeeds once overlaid. */
function baseEnv(over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ABAP_URL: "http://sap.invalid:50000",
    ABAP_USER: "TESTUSER",
    ABAP_PASSWORD: "secret",
    ABAP_CLIENT: "001",
    ABAP_SID: "TST",
    ...over,
  };
}

function noWarn() {
  return vi.fn();
}

describe("loadSystems: no-config fallthrough", () => {
  it("returns undefined when neither ABAP_SYSTEMS nor any ABAP_SYSTEM_* var is present", () => {
    const result = loadSystems({ env: {}, skipDotenv: true, warn: noWarn() });
    expect(result).toBeUndefined();
  });

  it("returns undefined for a plain single-system environment (ABAP_URL etc. alone)", () => {
    const result = loadSystems({ env: baseEnv(), skipDotenv: true, warn: noWarn() });
    expect(result).toBeUndefined();
  });
});

describe("loadSystems: file form (ABAP_SYSTEMS path)", () => {
  it("loads a three-entry file, sorted default-first then alphabetically, with per-system mode/allowlists", () => {
    const fileObj = {
      default: "DEV",
      systems: {
        DEV: {
          url: "http://dev.invalid:50000",
          user: "DEVUSER",
          client: "100",
          sid: "DEV",
          mode: "admin",
          allow_packages: ["Z*", "$TMP"],
          password_env: "DEV_PW",
        },
        QAS: {
          url: "http://qas.invalid:50000",
          user: "QASUSER",
          client: "200",
          sid: "QAS",
          mode: "read",
          password_env: "QAS_PW",
        },
        PRD: {
          url: "http://prd.invalid:50000",
          user: "PRDUSER",
          client: "300",
          sid: "PRD",
          allow_transports: ["*"],
          password_env: "PRD_PW",
        },
      },
    };
    const readFile = vi.fn((p: string) => {
      if (p === "/fake/systems.json") return JSON.stringify(fileObj);
      throw new Error(`unexpected read of ${p}`);
    });
    const specs = loadSystems({
      env: { ABAP_SYSTEMS: "/fake/systems.json", DEV_PW: "devpass", QAS_PW: "qaspass", PRD_PW: "prdpass" },
      skipDotenv: true,
      warn: noWarn(),
      readFile,
    });
    expect(specs).toBeDefined();
    expect(specs).toHaveLength(3);
    // Default-first, then alphabetical among the rest: DEV, PRD, QAS.
    expect(specs!.map((s) => s.alias)).toEqual(["DEV", "PRD", "QAS"]);
    expect(specs![0]!.isDefault).toBe(true);
    expect(specs![1]!.isDefault).toBe(false);
    expect(specs![2]!.isDefault).toBe(false);

    const dev = specs!.find((s) => s.alias === "DEV")!;
    expect(dev.cfg.abapMode).toBe("admin");
    expect(dev.cfg.allowPackages).toEqual(["Z*", "$TMP"]);
    expect(dev.cfg.url).toBe("http://dev.invalid:50000");
    expect(dev.cfg.password).toBe("devpass");

    const qas = specs!.find((s) => s.alias === "QAS")!;
    expect(qas.cfg.abapMode).toBe("read");
    expect(qas.cfg.readOnly).toBe(true);

    const prd = specs!.find((s) => s.alias === "PRD")!;
    expect(prd.cfg.allowTransports).toEqual(["*"]);
  });
});

describe("loadSystems: inline JSON", () => {
  it("parses inline JSON given directly in ABAP_SYSTEMS, without calling readFile", () => {
    const inline = JSON.stringify({
      systems: {
        SOLO: { url: "http://solo.invalid:50000", user: "U", client: "001", sid: "SOL", password_env: "SOLO_PW" },
      },
    });
    const readFile = vi.fn(() => {
      throw new Error("readFile must not be called for inline JSON");
    });
    const specs = loadSystems({
      env: { ABAP_SYSTEMS: inline, SOLO_PW: "pw" },
      skipDotenv: true,
      warn: noWarn(),
      readFile,
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(specs).toHaveLength(1);
    expect(specs![0]!.alias).toBe("SOLO");
    expect(specs![0]!.isDefault).toBe(true); // implicit: only entry
  });
});

describe("loadSystems: env-var form (ABAP_SYSTEM_<ALIAS>_<SETTING>)", () => {
  it("builds a system from ABAP_SYSTEM_DEV_* vars, honouring _DEFAULT and _MODE", () => {
    const specs = loadSystems({
      env: {
        ABAP_SYSTEM_DEV_URL: "http://dev.invalid:50000",
        ABAP_SYSTEM_DEV_USER: "DEVUSER",
        ABAP_SYSTEM_DEV_CLIENT: "100",
        ABAP_SYSTEM_DEV_SID: "DEV",
        ABAP_SYSTEM_DEV_MODE: "admin",
        ABAP_SYSTEM_DEV_PASSWORD: "devpass",
        ABAP_SYSTEM_DEV_DEFAULT: "true",
      },
      skipDotenv: true,
      warn: noWarn(),
    });
    expect(specs).toHaveLength(1);
    const dev = specs![0]!;
    expect(dev.alias).toBe("DEV");
    expect(dev.isDefault).toBe(true);
    expect(dev.cfg.abapMode).toBe("admin");
    expect(dev.cfg.password).toBe("devpass");
    expect(dev.source).toBe("env");
  });

  it("does not leak _DEFAULT or _PASSWORD_ENV as literal ABAP_DEFAULT/ABAP_PASSWORD_ENV overlay vars", () => {
    const specs = loadSystems({
      env: {
        ...baseEnv(), // shared base env (not namespaced) — must not interfere
        ABAP_SYSTEM_DEV_URL: "http://dev.invalid:50000",
        ABAP_SYSTEM_DEV_USER: "DEVUSER",
        ABAP_SYSTEM_DEV_CLIENT: "100",
        ABAP_SYSTEM_DEV_SID: "DEV",
        ABAP_SYSTEM_DEV_PASSWORD_ENV: "DEV_PW",
        ABAP_SYSTEM_DEV_DEFAULT: "true",
        DEV_PW: "devpass",
      },
      skipDotenv: true,
      warn: noWarn(),
    });
    expect(specs).toHaveLength(1);
    const dev = specs![0]!;
    // password_env resolved into ABAP_PASSWORD, never surfaced as its own name.
    expect(dev.cfg.password).toBe("devpass");
    expect((dev.env as Record<string, unknown>).ABAP_DEFAULT).toBeUndefined();
    expect((dev.env as Record<string, unknown>).ABAP_PASSWORD_ENV).toBeUndefined();
  });

  it("errors on ABAP_SYSTEM_<ALIAS> with no trailing setting name", () => {
    expect(() =>
      loadSystems({
        env: { ABAP_SYSTEM_DEV: "x" },
        skipDotenv: true,
        warn: noWarn(),
      }),
    ).toThrowError(/ABAP_SYSTEM_DEV has no setting name/);
  });
});

describe("loadSystems: secrets", () => {
  it("resolves password_env to the named environment variable", () => {
    const specs = loadSystems({
      env: {
        ABAP_SYSTEM_DEV_URL: "http://dev.invalid:50000",
        ABAP_SYSTEM_DEV_USER: "DEVUSER",
        ABAP_SYSTEM_DEV_CLIENT: "100",
        ABAP_SYSTEM_DEV_SID: "DEV",
        ABAP_SYSTEM_DEV_PASSWORD_ENV: "MY_DEV_SECRET",
        MY_DEV_SECRET: "s3cr3t",
      },
      skipDotenv: true,
      warn: noWarn(),
    });
    expect(specs![0]!.cfg.password).toBe("s3cr3t");
  });

  it("errors naming both the alias and the missing variable when password_env's var is not set", () => {
    expect(() =>
      loadSystems({
        env: {
          ABAP_SYSTEM_DEV_URL: "http://dev.invalid:50000",
          ABAP_SYSTEM_DEV_USER: "DEVUSER",
          ABAP_SYSTEM_DEV_CLIENT: "100",
          ABAP_SYSTEM_DEV_SID: "DEV",
          ABAP_SYSTEM_DEV_PASSWORD_ENV: "MISSING_VAR",
        },
        skipDotenv: true,
        warn: noWarn(),
      }),
    ).toThrowError(/DEV.*password_env names MISSING_VAR, which is not set/s);
  });

  it("refuses a literal password/passwd/pass key in the systems file without echoing its value", () => {
    const fileObj = {
      systems: {
        DEV: {
          url: "http://dev.invalid:50000",
          user: "DEVUSER",
          client: "100",
          sid: "DEV",
          password: "THIS-SHOULD-NEVER-APPEAR",
        },
      },
    };
    let thrown: unknown;
    try {
      loadSystems({
        env: { ABAP_SYSTEMS: JSON.stringify(fileObj) },
        skipDotenv: true,
        warn: noWarn(),
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/"password" would put a secret in this file/);
    expect(message).not.toContain("THIS-SHOULD-NEVER-APPEAR");
  });

  it("refuses passwd/pass the same way", () => {
    for (const key of ["passwd", "pass"]) {
      const fileObj = { systems: { DEV: { url: "http://dev.invalid:50000", user: "U", client: "1", [key]: "x" } } };
      expect(() =>
        loadSystems({ env: { ABAP_SYSTEMS: JSON.stringify(fileObj) }, skipDotenv: true, warn: noWarn() }),
      ).toThrowError(new RegExp(`"${key}" would put a secret in this file`));
    }
  });

  it("refuses a forbidden secret-shaped name under the file's env map (e.g. env.ABAP_PASSWORD)", () => {
    const fileObj = {
      systems: {
        DEV: {
          url: "http://dev.invalid:50000",
          user: "DEVUSER",
          client: "100",
          env: { ABAP_PASSWORD: "leaked" },
        },
      },
    };
    let thrown: unknown;
    try {
      loadSystems({ env: { ABAP_SYSTEMS: JSON.stringify(fileObj) }, skipDotenv: true, warn: noWarn() });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/"env\.ABAP_PASSWORD" would put a secret in this file/);
    expect(message).not.toContain("leaked");
  });
});

describe("loadSystems: alias validation", () => {
  it("rejects a lowercase alias, naming it", () => {
    const fileObj = { systems: { dev: { url: "http://dev.invalid:50000", user: "U", client: "1" } } };
    expect(() =>
      loadSystems({ env: { ABAP_SYSTEMS: JSON.stringify(fileObj) }, skipDotenv: true, warn: noWarn() }),
    ).toThrowError(/"dev".*alias is invalid/s);
  });

  it("rejects an empty alias", () => {
    const fileObj = { systems: { "": { url: "http://dev.invalid:50000", user: "U", client: "1" } } };
    expect(() =>
      loadSystems({ env: { ABAP_SYSTEMS: JSON.stringify(fileObj) }, skipDotenv: true, warn: noWarn() }),
    ).toThrowError(/alias is invalid/);
  });

  it("rejects an alias longer than 16 characters", () => {
    const longAlias = "A".repeat(17);
    const fileObj = { systems: { [longAlias]: { url: "http://dev.invalid:50000", user: "U", client: "1" } } };
    expect(() =>
      loadSystems({ env: { ABAP_SYSTEMS: JSON.stringify(fileObj) }, skipDotenv: true, warn: noWarn() }),
    ).toThrowError(new RegExp(`"${longAlias}".*alias is invalid`, "s"));
  });

  it("rejects an alias containing an underscore, via the env-var form (splits at the first _)", () => {
    // ABAP_SYSTEM_dev_URL: rest="dev_URL", alias parses as "dev" (lowercase -> invalid).
    // A genuinely underscore-containing *uppercase* alias is unparseable by construction
    // (there is no way to tell where the alias ends), so isValidAlias itself is the pin here.
    expect(isValidAlias("DEV_1")).toBe(false);
    expect(isValidAlias("DEV1")).toBe(true);
    expect(isValidAlias("")).toBe(false);
    expect(isValidAlias("A".repeat(16))).toBe(true);
    expect(isValidAlias("A".repeat(17))).toBe(false);
  });
});

describe("loadSystems: defaulting rules", () => {
  function twoSystemFile(over: Record<string, unknown> = {}) {
    return {
      systems: {
        DEV: { url: "http://dev.invalid:50000", user: "U", client: "1", password_env: "SHARED_PW" },
        QAS: { url: "http://qas.invalid:50000", user: "U", client: "1", password_env: "SHARED_PW" },
      },
      ...over,
    };
  }
  const withPw = (env: NodeJS.ProcessEnv = {}) => ({ SHARED_PW: "secret", ...env });

  it("uses the top-level default", () => {
    const specs = loadSystems({
      env: withPw({ ABAP_SYSTEMS: JSON.stringify(twoSystemFile({ default: "QAS" })) }),
      skipDotenv: true,
      warn: noWarn(),
    });
    expect(specs!.find((s) => s.isDefault)!.alias).toBe("QAS");
  });

  it("uses a per-entry default:true", () => {
    const file = twoSystemFile();
    (file.systems as Record<string, Record<string, unknown>>).QAS.default = true;
    const specs = loadSystems({ env: withPw({ ABAP_SYSTEMS: JSON.stringify(file) }), skipDotenv: true, warn: noWarn() });
    expect(specs!.find((s) => s.isDefault)!.alias).toBe("QAS");
  });

  it("implicitly defaults the only entry when there is exactly one system", () => {
    const file = {
      systems: { SOLO: { url: "http://solo.invalid:50000", user: "U", client: "1", password_env: "SHARED_PW" } },
    };
    const specs = loadSystems({ env: withPw({ ABAP_SYSTEMS: JSON.stringify(file) }), skipDotenv: true, warn: noWarn() });
    expect(specs![0]!.isDefault).toBe(true);
  });

  it("errors when the top-level default and a differing per-entry default disagree", () => {
    const file = twoSystemFile({ default: "DEV" });
    (file.systems as Record<string, Record<string, unknown>>).QAS.default = true;
    expect(() =>
      loadSystems({ env: withPw({ ABAP_SYSTEMS: JSON.stringify(file) }), skipDotenv: true, warn: noWarn() }),
    ).toThrowError(/default system is ambiguous/);
  });

  it("errors when more than one system is marked default", () => {
    const file = twoSystemFile();
    (file.systems as Record<string, Record<string, unknown>>).DEV.default = true;
    (file.systems as Record<string, Record<string, unknown>>).QAS.default = true;
    expect(() =>
      loadSystems({ env: withPw({ ABAP_SYSTEMS: JSON.stringify(file) }), skipDotenv: true, warn: noWarn() }),
    ).toThrowError(/more than one system is marked default/);
  });

  it("errors when no system is marked default and there is more than one", () => {
    expect(() =>
      loadSystems({ env: withPw({ ABAP_SYSTEMS: JSON.stringify(twoSystemFile()) }), skipDotenv: true, warn: noWarn() }),
    ).toThrowError(/no default system is marked/);
  });
});

describe("loadSystems: error aggregation", () => {
  it("collects every problem into one Error, with a counted header and the closing sentence", () => {
    // Three problems: an invalid alias, a missing password_env var on DEV,
    // plus the cascading credential-missing problem loadConfig itself
    // reports for DEV once ABAP_PASSWORD never got set on its overlay —
    // the aggregator does not stop building a spec just because one problem
    // was already found for that alias, so this is the real, expected count.
    const file = {
      default: "QAS",
      systems: {
        bad: { url: "http://a.invalid:50000", user: "U", client: "1", password_env: "SHARED_PW" },
        DEV: { url: "http://dev.invalid:50000", user: "U", client: "1", password_env: "NOPE_VAR" },
        QAS: { url: "http://qas.invalid:50000", user: "U", client: "1", password_env: "SHARED_PW" },
      },
    };
    let thrown: unknown;
    try {
      loadSystems({ env: { ABAP_SYSTEMS: JSON.stringify(file), SHARED_PW: "secret" }, skipDotenv: true, warn: noWarn() });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/^Invalid abapsmith multi-system configuration \(3 problems\):/);
    expect(message).toContain("Every entry is validated at startup");
    expect(message).toMatch(/alias is invalid/);
    expect(message).toMatch(/password_env names NOPE_VAR/);
    // Exactly 3 distinct bullet lines.
    const bulletCount = message.split("\n").filter((l) => l.trim().startsWith("- ")).length;
    expect(bulletCount).toBe(3);
  });

  it("uses singular phrasing for exactly one problem", () => {
    const file = { systems: { bad: { url: "http://a.invalid:50000", user: "U", client: "1" } } };
    expect(() => loadSystems({ env: { ABAP_SYSTEMS: JSON.stringify(file) }, skipDotenv: true, warn: noWarn() })).toThrowError(
      /^Invalid abapsmith multi-system configuration \(1 problem\):/,
    );
  });
});

describe("loadSystems: duplicate (sid, url, client) triples", () => {
  it("warns rather than erroring when two aliases share the same sid/url/client", () => {
    const file = {
      default: "DEV",
      systems: {
        DEV: { url: "http://shared.invalid:50000", user: "U", client: "1", sid: "SAME", password_env: "SHARED_PW" },
        MIRROR: {
          url: "http://shared.invalid:50000",
          user: "U",
          client: "1",
          sid: "SAME",
          password_env: "SHARED_PW",
        },
      },
    };
    const warn = vi.fn();
    const specs = loadSystems({
      env: { ABAP_SYSTEMS: JSON.stringify(file), SHARED_PW: "secret" },
      skipDotenv: true,
      warn,
    });
    expect(specs).toHaveLength(2); // did not throw
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/share the same sid\/url\/client/));
  });
});
