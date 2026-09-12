/**
 * `ABAP_TOKEN` (static bearer token) and `ABAP_OAUTH_*`/`ABAP_SERVICE_KEY`
 * (OAuth 2.0 client-credentials grant) — the fourth and fifth alternatives to
 * ABAP_PASSWORD (issue #80 stages 1-2). Covers `loadConfig`'s
 * credential-resolution wiring: the exactly-one-of-five check, the
 * both-service-key-and-explicit-vars guard, the incomplete-explicit-group
 * message, token-URL validation, the ABAP_OAUTH_SCOPE-has-no-effect NOTE, the
 * ABAP_TOKEN-never-refreshed NOTE, and `redactConfigSecrets`.
 * (`parseServiceKey` itself is unit-tested in isolation in
 * test/auth-credential-loaders.test.ts — here only the wiring around it.)
 *
 * ABAP_TOKEN and the OAuth client secret are exactly as sensitive as
 * ABAP_PASSWORD — every assertion here that touches a thrown message, a
 * warning, or a serialized config also asserts the relevant sentinel is
 * absent from it, not just that the test "passes".
 */
import { describe, expect, it } from "vitest";

import { loadConfig, redactConfigSecrets, type LoadConfigOptions } from "../src/config.js";

/**
 * Same type as `CredentialFileReader` (src/auth/client-cert.ts), sourced
 * through `LoadConfigOptions` so this suite imports nothing but vitest,
 * node:* and ../src/config.js. That keeps it inside the config-only exemption
 * in test/system-role-probe-guard.test.ts — this suite builds configs and
 * never opens a connection, so it must not look like one that does.
 */
type FakeFileReader = NonNullable<LoadConfigOptions["readFile"]>;

const env = (over: Record<string, string> = {}): Record<string, string> => ({
  ABAP_URL: "http://sap.invalid:50000",
  ABAP_USER: "U",
  ...over,
});

const TOKEN_SENTINEL = "t0ken-do-not-log";
const CLIENT_SECRET_SENTINEL = "cl1entsecret-do-not-log";
const SERVICE_KEY_SECRET_SENTINEL = "svck3y-do-not-log";

/** A fake `CredentialFileReader` backed by an in-memory map — no real disk I/O. */
function fakeReader(files: Record<string, string>): FakeFileReader {
  const map = new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
  return (path: string): Buffer => {
    const buf = map.get(path);
    if (buf === undefined) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
        code: "ENOENT",
      });
    }
    return buf;
  };
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
    throw new Error("expected loadConfig to throw");
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const validServiceKeyJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    url: "https://my-abap-system.example.com",
    uaa: {
      clientid: "sb-clientid-1234",
      clientsecret: SERVICE_KEY_SECRET_SENTINEL,
      url: "https://my-tenant.authentication.eu10.hana.ondemand.com",
      ...over,
    },
  });

// ------------------------------------------------------------- ABAP_TOKEN ---

describe("config: ABAP_TOKEN as a fourth credential method", () => {
  it("ABAP_TOKEN alone resolves authMethod: 'token' and cfg.token", () => {
    const cfg = loadConfig({
      env: env({ ABAP_TOKEN: TOKEN_SENTINEL }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.authMethod).toBe("token");
    expect(cfg.token).toBe(TOKEN_SENTINEL);
    expect(cfg.password).toBeUndefined();
  });

  it("ABAP_TOKEN together with ABAP_PASSWORD is rejected, naming both, choosing neither", () => {
    const msg = messageOf(() =>
      loadConfig({
        env: env({ ABAP_TOKEN: TOKEN_SENTINEL, ABAP_PASSWORD: "pw" }),
        warn: () => {},
        skipDotenv: true,
      }),
    );
    expect(msg).toContain("ABAP_TOKEN");
    expect(msg).toContain("ABAP_PASSWORD");
    expect(msg).toContain("more than one credential is configured");
    expect(msg).not.toContain(TOKEN_SENTINEL);
  });

  it("an empty ABAP_TOKEN counts as unset, same as ABAP_PASSWORD's blank-string rule", () => {
    const msg = messageOf(() => loadConfig({ env: env({ ABAP_TOKEN: "" }), warn: () => {}, skipDotenv: true }));
    expect(msg).toContain("no credential configured");
  });

  it("the token-mode NOTE about AUTH_EXPIRED and no refresh is emitted only in token mode", () => {
    const warnings: string[] = [];
    loadConfig({ env: env({ ABAP_TOKEN: TOKEN_SENTINEL }), warn: (m) => warnings.push(m), skipDotenv: true });
    expect(
      warnings.some((w) => w.includes("ABAP_TOKEN is a static bearer token: it is never refreshed")),
    ).toBe(true);
    // The warning names the mechanism, never the token value.
    expect(warnings.every((w) => !w.includes(TOKEN_SENTINEL))).toBe(true);
  });

  it("does not emit the token NOTE in password mode", () => {
    const warnings: string[] = [];
    loadConfig({ env: env({ ABAP_PASSWORD: "pw" }), warn: (m) => warnings.push(m), skipDotenv: true });
    expect(warnings.some((w) => w.includes("is a static bearer token"))).toBe(false);
  });
});

// -------------------------------------------------------- ABAP_OAUTH_* (explicit) ---

describe("config: explicit ABAP_OAUTH_* client-credentials group", () => {
  const oauthEnv = (over: Record<string, string> = {}) =>
    env({
      ABAP_OAUTH_TOKEN_URL: "https://uaa.example.com/oauth/token",
      ABAP_OAUTH_CLIENT_ID: "my-client-id",
      ABAP_OAUTH_CLIENT_SECRET: CLIENT_SECRET_SENTINEL,
      ...over,
    });

  it("all three vars set resolves authMethod: 'oauth' with source 'env'", () => {
    const cfg = loadConfig({ env: oauthEnv(), warn: () => {}, skipDotenv: true });
    expect(cfg.authMethod).toBe("oauth");
    expect(cfg.oauth).toEqual({
      tokenUrl: "https://uaa.example.com/oauth/token",
      clientId: "my-client-id",
      clientSecret: CLIENT_SECRET_SENTINEL,
      source: "env",
    });
  });

  it("ABAP_OAUTH_SCOPE, when the group is complete, is carried into cfg.oauth.scope", () => {
    const cfg = loadConfig({
      env: oauthEnv({ ABAP_OAUTH_SCOPE: "uaa.resource" }),
      warn: () => {},
      skipDotenv: true,
    });
    expect(cfg.oauth?.scope).toBe("uaa.resource");
  });

  it("missing exactly one of the three names only that one, with 'is' (singular)", () => {
    const msg = messageOf(() =>
      loadConfig({
        env: env({
          ABAP_OAUTH_TOKEN_URL: "https://uaa.example.com/oauth/token",
          ABAP_OAUTH_CLIENT_ID: "id",
        }),
        warn: () => {},
        skipDotenv: true,
      }),
    );
    expect(msg).toContain("ABAP_OAUTH_CLIENT_SECRET");
    expect(msg).toContain("is not set");
    expect(msg).not.toContain("ABAP_OAUTH_TOKEN_URL is not set");
  });

  it("missing two of the three joins them with a comma and uses 'are' (plural)", () => {
    const msg = messageOf(() =>
      loadConfig({
        env: env({ ABAP_OAUTH_CLIENT_ID: "id" }),
        warn: () => {},
        skipDotenv: true,
      }),
    );
    expect(msg).toContain("ABAP_OAUTH_TOKEN_URL, ABAP_OAUTH_CLIENT_SECRET are not set");
  });

  it("an invalid ABAP_OAUTH_TOKEN_URL (not absolute) is rejected without ever echoing the URL", () => {
    const msg = messageOf(() =>
      loadConfig({
        env: oauthEnv({ ABAP_OAUTH_TOKEN_URL: "not-a-url" }),
        warn: () => {},
        skipDotenv: true,
      }),
    );
    expect(msg).toContain("ABAP_OAUTH_TOKEN_URL is not a valid absolute URL.");
    expect(msg).not.toContain("not-a-url");
  });

  it("a non-http(s) scheme (e.g. ftp://) is rejected the same way", () => {
    const msg = messageOf(() =>
      loadConfig({
        env: oauthEnv({ ABAP_OAUTH_TOKEN_URL: "ftp://uaa.example.com/token" }),
        warn: () => {},
        skipDotenv: true,
      }),
    );
    expect(msg).toContain("ABAP_OAUTH_TOKEN_URL is not a valid absolute URL.");
  });

  it("the client secret never appears in a thrown message even when the group is otherwise broken", () => {
    const msg = messageOf(() =>
      loadConfig({
        env: oauthEnv({ ABAP_OAUTH_TOKEN_URL: "not-a-url" }),
        warn: () => {},
        skipDotenv: true,
      }),
    );
    expect(msg).not.toContain(CLIENT_SECRET_SENTINEL);
    expect(msg).not.toContain(CLIENT_SECRET_SENTINEL.slice(0, 6));
  });

  it("oauth set together with ABAP_PASSWORD is rejected as more-than-one-credential", () => {
    const msg = messageOf(() =>
      loadConfig({
        env: oauthEnv({ ABAP_PASSWORD: "pw" }),
        warn: () => {},
        skipDotenv: true,
      }),
    );
    expect(msg).toContain("more than one credential is configured");
    expect(msg).toContain("ABAP_OAUTH_* / ABAP_SERVICE_KEY");
    expect(msg).toContain("ABAP_PASSWORD");
  });
});

// -------------------------------------------------------------- ABAP_SERVICE_KEY ---

describe("config: ABAP_SERVICE_KEY as an alternative OAuth settings source", () => {
  it("a valid service key resolves authMethod: 'oauth' with source 'service-key'", () => {
    const cfg = loadConfig({
      env: env({ ABAP_SERVICE_KEY: "/keys/sk.json" }),
      warn: () => {},
      skipDotenv: true,
      readFile: fakeReader({ "/keys/sk.json": validServiceKeyJson() }),
    });
    expect(cfg.authMethod).toBe("oauth");
    expect(cfg.oauth?.source).toBe("service-key");
    expect(cfg.oauth?.serviceKeyPath).toBe("/keys/sk.json");
    expect(cfg.oauth?.clientSecret).toBe(SERVICE_KEY_SECRET_SENTINEL);
    expect(cfg.oauth?.tokenUrl).toBe(
      "https://my-tenant.authentication.eu10.hana.ondemand.com/oauth/token",
    );
  });

  it("ABAP_OAUTH_SCOPE alongside a service key overrides any scope embedded in the key", () => {
    const cfg = loadConfig({
      env: env({ ABAP_SERVICE_KEY: "/keys/sk.json", ABAP_OAUTH_SCOPE: "override.scope" }),
      warn: () => {},
      skipDotenv: true,
      readFile: fakeReader({ "/keys/sk.json": validServiceKeyJson({ scope: "embedded.scope" }) }),
    });
    expect(cfg.oauth?.scope).toBe("override.scope");
  });

  it("both ABAP_SERVICE_KEY and an explicit ABAP_OAUTH_* var set is rejected, choosing neither", () => {
    const msg = messageOf(() =>
      loadConfig({
        env: env({
          ABAP_SERVICE_KEY: "/keys/sk.json",
          ABAP_OAUTH_CLIENT_ID: "explicit-id",
        }),
        warn: () => {},
        skipDotenv: true,
        readFile: fakeReader({ "/keys/sk.json": validServiceKeyJson() }),
      }),
    );
    expect(msg).toContain("both ABAP_SERVICE_KEY and explicit ABAP_OAUTH_* variables are set");
  });

  it("an unreadable service-key file surfaces the OS error, naming ABAP_SERVICE_KEY and the path", () => {
    const msg = messageOf(() =>
      loadConfig({
        env: env({ ABAP_SERVICE_KEY: "/keys/missing.json" }),
        warn: () => {},
        skipDotenv: true,
        readFile: fakeReader({}),
      }),
    );
    expect(msg).toContain("ABAP_SERVICE_KEY (/keys/missing.json) could not be read");
  });

  it("a malformed service key (missing uaa fields) propagates parseServiceKey's issue through the credential throw", () => {
    const msg = messageOf(() =>
      loadConfig({
        env: env({ ABAP_SERVICE_KEY: "/keys/sk.json" }),
        warn: () => {},
        skipDotenv: true,
        readFile: fakeReader({ "/keys/sk.json": JSON.stringify({}) }),
      }),
    );
    expect(msg).toContain("ABAP_SERVICE_KEY (/keys/sk.json) is missing");
  });

  it("the service key's client secret never appears in a thrown message, even on a downstream failure", () => {
    const msg = messageOf(() =>
      loadConfig({
        env: env({
          ABAP_SERVICE_KEY: "/keys/sk.json",
          ABAP_OAUTH_CLIENT_ID: "explicit-id",
        }),
        warn: () => {},
        skipDotenv: true,
        readFile: fakeReader({ "/keys/sk.json": validServiceKeyJson() }),
      }),
    );
    expect(msg).not.toContain(SERVICE_KEY_SECRET_SENTINEL);
    expect(msg).not.toContain(SERVICE_KEY_SECRET_SENTINEL.slice(0, 6));
  });
});

describe("config: ABAP_OAUTH_SCOPE set with no OAuth configuration at all", () => {
  it("emits the has-no-effect-on-its-own NOTE and does not select oauth as the method", () => {
    const warnings: string[] = [];
    const cfg = loadConfig({
      env: env({ ABAP_PASSWORD: "pw", ABAP_OAUTH_SCOPE: "orphan.scope" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(cfg.authMethod).toBe("password");
    expect(
      warnings.some((w) =>
        w.includes("ABAP_OAUTH_SCOPE is set but no OAuth client-credentials configuration"),
      ),
    ).toBe(true);
  });

  it("does not emit that NOTE once a full OAuth group makes the scope meaningful", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({
        ABAP_OAUTH_TOKEN_URL: "https://uaa.example.com/oauth/token",
        ABAP_OAUTH_CLIENT_ID: "id",
        ABAP_OAUTH_CLIENT_SECRET: CLIENT_SECRET_SENTINEL,
        ABAP_OAUTH_SCOPE: "meaningful.scope",
      }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(warnings.some((w) => w.includes("has no effect on its own"))).toBe(false);
  });
});

// -------------------------------------------------------------- redactConfigSecrets ---

describe("config: redactConfigSecrets for token and oauth modes", () => {
  it("token mode: cfg.token is redacted to '***', and the sentinel never survives JSON.stringify", () => {
    const cfg = loadConfig({
      env: env({ ABAP_TOKEN: TOKEN_SENTINEL }),
      warn: () => {},
      skipDotenv: true,
    });
    const redacted = redactConfigSecrets(cfg);
    expect(redacted.token).toBe("***");
    const serialised = JSON.stringify(redacted);
    expect(serialised).not.toContain(TOKEN_SENTINEL);
    expect(serialised).not.toContain(TOKEN_SENTINEL.slice(0, 6));
  });

  it("a config with no token renders '(not set)', not '***' implying one exists", () => {
    const cfg = loadConfig({ env: env({ ABAP_PASSWORD: "pw" }), warn: () => {}, skipDotenv: true });
    expect(redactConfigSecrets(cfg).token).toBe("(not set)");
  });

  it("oauth mode: clientId and clientSecret are both redacted to '***', tokenUrl and source/scope are plaintext", () => {
    const cfg = loadConfig({
      env: env({
        ABAP_OAUTH_TOKEN_URL: "https://uaa.example.com/oauth/token",
        ABAP_OAUTH_CLIENT_ID: "my-client-id",
        ABAP_OAUTH_CLIENT_SECRET: CLIENT_SECRET_SENTINEL,
        ABAP_OAUTH_SCOPE: "uaa.resource",
      }),
      warn: () => {},
      skipDotenv: true,
    });
    const redacted = redactConfigSecrets(cfg);
    expect(redacted.oauth).toEqual({
      tokenUrl: "https://uaa.example.com/oauth/token",
      clientId: "***",
      clientSecret: "***",
      scope: "uaa.resource",
      source: "env",
      serviceKeyPath: "(not set)",
    });
  });

  it("oauth via service key: serviceKeyPath is plaintext (it's a path, not a secret), clientSecret is redacted", () => {
    const cfg = loadConfig({
      env: env({ ABAP_SERVICE_KEY: "/keys/sk.json" }),
      warn: () => {},
      skipDotenv: true,
      readFile: fakeReader({ "/keys/sk.json": validServiceKeyJson() }),
    });
    const redacted = redactConfigSecrets(cfg);
    expect((redacted.oauth as Record<string, unknown>).serviceKeyPath).toBe("/keys/sk.json");
    expect((redacted.oauth as Record<string, unknown>).clientSecret).toBe("***");
    expect((redacted.oauth as Record<string, unknown>).clientId).toBe("***");
  });

  it("credentials embedded in ABAP_OAUTH_TOKEN_URL's userinfo are stripped from redactConfigSecrets", () => {
    const cfg = loadConfig({
      env: env({
        ABAP_OAUTH_TOKEN_URL: `https://embedded-user:${CLIENT_SECRET_SENTINEL}@uaa.example.com/oauth/token`,
        ABAP_OAUTH_CLIENT_ID: "id",
        ABAP_OAUTH_CLIENT_SECRET: CLIENT_SECRET_SENTINEL,
      }),
      warn: () => {},
      skipDotenv: true,
    });
    const serialised = JSON.stringify(redactConfigSecrets(cfg));
    expect(serialised).not.toContain(CLIENT_SECRET_SENTINEL);
    expect(serialised).not.toContain(CLIENT_SECRET_SENTINEL.slice(0, 6));
  });

  it("JSON.stringify(redactConfigSecrets(cfg)) never contains the OAuth client secret or the service-key secret", () => {
    const cfg = loadConfig({
      env: env({ ABAP_SERVICE_KEY: "/keys/sk.json" }),
      warn: () => {},
      skipDotenv: true,
      readFile: fakeReader({ "/keys/sk.json": validServiceKeyJson() }),
    });
    const serialised = JSON.stringify(redactConfigSecrets(cfg));
    expect(serialised).not.toContain(SERVICE_KEY_SECRET_SENTINEL);
    expect(serialised).not.toContain(SERVICE_KEY_SECRET_SENTINEL.slice(0, 6));
  });

  it("a config with no oauth renders '(not set)', not '***' implying one exists", () => {
    const cfg = loadConfig({ env: env({ ABAP_PASSWORD: "pw" }), warn: () => {}, skipDotenv: true });
    expect(redactConfigSecrets(cfg).oauth).toBe("(not set)");
  });
});
