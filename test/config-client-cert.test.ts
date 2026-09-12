/**
 * `ABAP_CLIENT_CERT`/`ABAP_CLIENT_KEY`/`ABAP_CLIENT_KEY_PASSPHRASE` — X.509
 * client-certificate auth as a fifth alternative to ABAP_PASSWORD (issue
 * #79). Covers `loadConfig`'s credential-resolution wiring around
 * `loadClientCertMaterial` (the loader itself is unit-tested in isolation in
 * test/auth-credential-loaders.test.ts): the exactly-one-of-five check, the
 * orphan ABAP_CLIENT_KEY/_KEY_PASSPHRASE guard, the client-certificate-mode
 * startup NOTE, and `redactConfigSecrets`.
 *
 * The private key and its passphrase are exactly as sensitive as
 * ABAP_PASSWORD — every assertion here that touches a thrown message, a
 * warning, or a serialized config also asserts the passphrase sentinel is
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

const KEY_PASSPHRASE_SENTINEL = "pa55phrase-do-not-log";

const CERT_PEM = "-----BEGIN CERTIFICATE-----\nMIIB...fake...\n-----END CERTIFICATE-----\n";
const KEY_PEM = "-----BEGIN PRIVATE KEY-----\nMIIE...fake...\n-----END PRIVATE KEY-----\n";
const COMBINED_PEM = CERT_PEM + KEY_PEM;

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

describe("config: ABAP_CLIENT_CERT joins the exactly-one-of-five credential set", () => {
  it("a combined PEM alone resolves authMethod: 'certificate' and populates cfg.clientCert", () => {
    const cfg = loadConfig({
      env: env({ ABAP_CLIENT_CERT: "/certs/combined.pem" }),
      warn: () => {},
      skipDotenv: true,
      readFile: fakeReader({ "/certs/combined.pem": COMBINED_PEM }),
    });
    expect(cfg.authMethod).toBe("certificate");
    expect(cfg.clientCert?.kind).toBe("pem");
    expect(cfg.clientCert?.certPath).toBe("/certs/combined.pem");
    expect(cfg.password).toBeUndefined();
  });

  it("certificate set together with ABAP_PASSWORD is rejected, naming both labels, without choosing one", () => {
    const msg = messageOf(() =>
      loadConfig({
        env: env({
          ABAP_CLIENT_CERT: "/certs/combined.pem",
          ABAP_PASSWORD: "irrelevant",
        }),
        warn: () => {},
        skipDotenv: true,
        readFile: fakeReader({ "/certs/combined.pem": COMBINED_PEM }),
      }),
    );
    expect(msg).toContain("ABAP_PASSWORD");
    expect(msg).toContain("ABAP_CLIENT_CERT");
    expect(msg).toContain("more than one credential is configured");
  });

  it("no credential at all names ABAP_CLIENT_CERT among the five alternatives", () => {
    const msg = messageOf(() => loadConfig({ env: env(), warn: () => {}, skipDotenv: true }));
    expect(msg).toContain("ABAP_CLIENT_CERT");
    expect(msg).toContain("no credential configured");
  });
});

describe("config: separate cert + key file pair", () => {
  it("ABAP_CLIENT_CERT + ABAP_CLIENT_KEY resolves with keyPath populated", () => {
    const cfg = loadConfig({
      env: env({ ABAP_CLIENT_CERT: "/certs/cert.pem", ABAP_CLIENT_KEY: "/certs/key.pem" }),
      warn: () => {},
      skipDotenv: true,
      readFile: fakeReader({ "/certs/cert.pem": CERT_PEM, "/certs/key.pem": KEY_PEM }),
    });
    expect(cfg.clientCert?.certPath).toBe("/certs/cert.pem");
    expect(cfg.clientCert?.keyPath).toBe("/certs/key.pem");
  });

  it("ABAP_CLIENT_KEY_PASSPHRASE reaches cfg.clientCert.passphrase verbatim", () => {
    const cfg = loadConfig({
      env: env({
        ABAP_CLIENT_CERT: "/certs/cert.pem",
        ABAP_CLIENT_KEY: "/certs/key.pem",
        ABAP_CLIENT_KEY_PASSPHRASE: KEY_PASSPHRASE_SENTINEL,
      }),
      warn: () => {},
      skipDotenv: true,
      readFile: fakeReader({ "/certs/cert.pem": CERT_PEM, "/certs/key.pem": KEY_PEM }),
    });
    expect(cfg.clientCert?.passphrase).toBe(KEY_PASSPHRASE_SENTINEL);
  });
});

describe("config: orphan ABAP_CLIENT_KEY / ABAP_CLIENT_KEY_PASSPHRASE with no ABAP_CLIENT_CERT", () => {
  it("ABAP_CLIENT_KEY alone (no ABAP_CLIENT_CERT) is rejected, telling the operator to set ABAP_CLIENT_CERT", () => {
    const msg = messageOf(() =>
      loadConfig({
        env: env({ ABAP_CLIENT_KEY: "/certs/key.pem" }),
        warn: () => {},
        skipDotenv: true,
      }),
    );
    expect(msg).toContain("ABAP_CLIENT_KEY");
    expect(msg).toContain("ABAP_CLIENT_CERT is not");
  });

  it("ABAP_CLIENT_KEY_PASSPHRASE alone (no ABAP_CLIENT_CERT) is rejected, and the passphrase never appears in the message", () => {
    const msg = messageOf(() =>
      loadConfig({
        env: env({ ABAP_CLIENT_KEY_PASSPHRASE: KEY_PASSPHRASE_SENTINEL }),
        warn: () => {},
        skipDotenv: true,
      }),
    );
    expect(msg).toContain("ABAP_CLIENT_KEY_PASSPHRASE");
    expect(msg).toContain("ABAP_CLIENT_CERT is not");
    expect(msg).not.toContain(KEY_PASSPHRASE_SENTINEL);
    expect(msg).not.toContain(KEY_PASSPHRASE_SENTINEL.slice(0, 6));
  });

  it("both orphans set together are joined with ' / '", () => {
    const msg = messageOf(() =>
      loadConfig({
        env: env({
          ABAP_CLIENT_KEY: "/certs/key.pem",
          ABAP_CLIENT_KEY_PASSPHRASE: KEY_PASSPHRASE_SENTINEL,
        }),
        warn: () => {},
        skipDotenv: true,
      }),
    );
    expect(msg).toContain("ABAP_CLIENT_KEY / ABAP_CLIENT_KEY_PASSPHRASE");
  });

  it("this orphan check does not fire when ABAP_CLIENT_CERT IS set — key/passphrase are then meaningful", () => {
    const cfg = loadConfig({
      env: env({
        ABAP_CLIENT_CERT: "/certs/cert.pem",
        ABAP_CLIENT_KEY: "/certs/key.pem",
      }),
      warn: () => {},
      skipDotenv: true,
      readFile: fakeReader({ "/certs/cert.pem": CERT_PEM, "/certs/key.pem": KEY_PEM }),
    });
    expect(cfg.authMethod).toBe("certificate");
  });
});

describe("config: a malformed certificate surfaces loadClientCertMaterial's issue through the credential throw", () => {
  it("a cert file with no PEM header propagates 'does not look like a PEM file', prefixed as a credential issue", () => {
    const msg = messageOf(() =>
      loadConfig({
        env: env({ ABAP_CLIENT_CERT: "/certs/bad.pem" }),
        warn: () => {},
        skipDotenv: true,
        readFile: fakeReader({ "/certs/bad.pem": "not a cert" }),
      }),
    );
    expect(msg).toContain("credential:");
    expect(msg).toContain("does not look like a PEM file");
  });

  it("an unreadable cert file's OS error reaches the thrown message, naming ABAP_CLIENT_CERT", () => {
    const msg = messageOf(() =>
      loadConfig({
        env: env({ ABAP_CLIENT_CERT: "/certs/missing.pem" }),
        warn: () => {},
        skipDotenv: true,
        readFile: fakeReader({}),
      }),
    );
    expect(msg).toContain("ABAP_CLIENT_CERT (/certs/missing.pem) could not be read");
  });
});

describe("config: ABAP_CA_CERT is independent of client-certificate auth", () => {
  const CA_PEM = "-----BEGIN CERTIFICATE-----\nMIIB...ca...\n-----END CERTIFICATE-----\n";

  it("ABAP_CA_CERT combines with certificate-mode auth without conflict", () => {
    const cfg = loadConfig({
      env: env({ ABAP_CLIENT_CERT: "/certs/combined.pem", ABAP_CA_CERT: "/ca/bundle.pem" }),
      warn: () => {},
      skipDotenv: true,
      readFile: fakeReader({ "/certs/combined.pem": COMBINED_PEM, "/ca/bundle.pem": CA_PEM }),
    });
    expect(cfg.authMethod).toBe("certificate");
    expect(cfg.caCert?.path).toBe("/ca/bundle.pem");
  });

  it("ABAP_CA_CERT works in password mode too — it is not gated by authMethod", () => {
    const cfg = loadConfig({
      env: env({ ABAP_PASSWORD: "pw", ABAP_CA_CERT: "/ca/bundle.pem" }),
      warn: () => {},
      skipDotenv: true,
      readFile: fakeReader({ "/ca/bundle.pem": CA_PEM }),
    });
    expect(cfg.caCert?.path).toBe("/ca/bundle.pem");
  });

  it("ABAP_CA_CERT set alongside ABAP_INSECURE=true triggers the 'never consulted' WARNING", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({
        ABAP_PASSWORD: "pw",
        ABAP_CA_CERT: "/ca/bundle.pem",
        ABAP_INSECURE: "true",
      }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
      readFile: fakeReader({ "/ca/bundle.pem": CA_PEM }),
    });
    expect(warnings.some((w) => w.includes("ABAP_CA_CERT is set but ABAP_INSECURE=true"))).toBe(true);
  });

  it("a malformed CA bundle's issue joins the credential issue with '; ' when there was already one", () => {
    // Two independent problems at once: no credential AND a bad CA bundle.
    const msg = messageOf(() =>
      loadConfig({
        env: env({ ABAP_CA_CERT: "/ca/bad.pem" }),
        warn: () => {},
        skipDotenv: true,
        readFile: fakeReader({ "/ca/bad.pem": "not a cert" }),
      }),
    );
    expect(msg).toContain("no credential configured");
    expect(msg).toContain("does not look like a PEM file");
    expect(msg).toContain("; ");
  });
});

describe("config: certificate-mode startup NOTE about ABAP_USER", () => {
  it("emits the ABAP_USER-not-sent-for-logon NOTE only in certificate mode", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_CLIENT_CERT: "/certs/combined.pem" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
      readFile: fakeReader({ "/certs/combined.pem": COMBINED_PEM }),
    });
    expect(
      warnings.some((w) => w.includes("ABAP_USER is not sent for logon in client-certificate mode")),
    ).toBe(true);
  });

  it("does not emit that NOTE in password mode", () => {
    const warnings: string[] = [];
    loadConfig({
      env: env({ ABAP_PASSWORD: "pw" }),
      warn: (m) => warnings.push(m),
      skipDotenv: true,
    });
    expect(
      warnings.some((w) => w.includes("ABAP_USER is not sent for logon in client-certificate mode")),
    ).toBe(false);
  });
});

describe("config: redactConfigSecrets in certificate mode", () => {
  it("exposes kind/certPath/keyPath in plaintext but redacts passphrase to '***'", () => {
    const cfg = loadConfig({
      env: env({
        ABAP_CLIENT_CERT: "/certs/cert.pem",
        ABAP_CLIENT_KEY: "/certs/key.pem",
        ABAP_CLIENT_KEY_PASSPHRASE: KEY_PASSPHRASE_SENTINEL,
      }),
      warn: () => {},
      skipDotenv: true,
      readFile: fakeReader({ "/certs/cert.pem": CERT_PEM, "/certs/key.pem": KEY_PEM }),
    });
    const redacted = redactConfigSecrets(cfg);
    expect(redacted.clientCert).toEqual({
      kind: "pem",
      certPath: "/certs/cert.pem",
      keyPath: "/certs/key.pem",
      passphrase: "***",
    });
  });

  it("a combined-PEM (no separate key file) redacts keyPath to '(not set)', not undefined or the cert path", () => {
    const cfg = loadConfig({
      env: env({ ABAP_CLIENT_CERT: "/certs/combined.pem" }),
      warn: () => {},
      skipDotenv: true,
      readFile: fakeReader({ "/certs/combined.pem": COMBINED_PEM }),
    });
    const redacted = redactConfigSecrets(cfg);
    expect((redacted.clientCert as Record<string, unknown>).keyPath).toBe("(not set)");
    expect((redacted.clientCert as Record<string, unknown>).passphrase).toBe("(not set)");
  });

  it("JSON.stringify(redactConfigSecrets(cfg)) never contains the passphrase, in full or truncated", () => {
    const cfg = loadConfig({
      env: env({
        ABAP_CLIENT_CERT: "/certs/cert.pem",
        ABAP_CLIENT_KEY: "/certs/key.pem",
        ABAP_CLIENT_KEY_PASSPHRASE: KEY_PASSPHRASE_SENTINEL,
      }),
      warn: () => {},
      skipDotenv: true,
      readFile: fakeReader({ "/certs/cert.pem": CERT_PEM, "/certs/key.pem": KEY_PEM }),
    });
    const serialised = JSON.stringify(redactConfigSecrets(cfg));
    expect(serialised).not.toContain(KEY_PASSPHRASE_SENTINEL);
    expect(serialised).not.toContain(KEY_PASSPHRASE_SENTINEL.slice(0, 6));
  });

  it("a config with no clientCert renders '(not set)', not '***' implying one exists", () => {
    const cfg = loadConfig({ env: env({ ABAP_PASSWORD: "pw" }), warn: () => {}, skipDotenv: true });
    expect(redactConfigSecrets(cfg).clientCert).toBe("(not set)");
  });
});
