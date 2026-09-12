/**
 * Unit tests for the three on-disk credential loaders behind X.509
 * client-certificate auth and OAuth 2.0 client-credentials auth:
 * `loadClientCertMaterial`/`loadCaBundle` (src/auth/client-cert.ts) and
 * `parseServiceKey` (src/auth/service-key.ts).
 *
 * These are the lowest layer: no `Config`, no `GuardedHttpClient`, no real
 * filesystem access anywhere in this file. Every "file" is an entry in a
 * `Map<string, Buffer>` behind a fake `CredentialFileReader`, and a read
 * "failure" is just a path absent from that map. That's deliberate — the real
 * `readFileSync`-backed reader is exercised for us by
 * `test/config-client-cert.test.ts`/`test/config-bearer-oauth.test.ts`, which
 * inject their own fake reader into `loadConfig` the same way.
 *
 * THE OVERRIDING RULE: every issue string these functions can produce is
 * checked to never contain the secret material it is describing (a
 * passphrase, or a service-key client secret) — only paths, env var names,
 * and OS-level error text, none of which can carry key material.
 */
import { describe, expect, it } from "vitest";

import {
  loadCaBundle,
  loadClientCertMaterial,
  type CredentialFileReader,
} from "../src/auth/client-cert.js";
import { parseServiceKey } from "../src/auth/service-key.js";

const KEY_PASSPHRASE_SENTINEL = "pa55phrase-do-not-log";
const SERVICE_KEY_SECRET_SENTINEL = "svck3y-do-not-log";

/** A fake `CredentialFileReader` backed by an in-memory map — no real disk I/O. */
function makeReader(files: Map<string, Buffer>): CredentialFileReader {
  return (path: string): Buffer => {
    const buf = files.get(path);
    if (buf === undefined) {
      // Mimics Node's real ENOENT message shape closely enough that a test
      // asserting the OS-level text is echoed verbatim still makes sense.
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
        code: "ENOENT",
      });
    }
    return buf;
  };
}

const CERT_PEM = "-----BEGIN CERTIFICATE-----\nMIIB...fake...\n-----END CERTIFICATE-----\n";
const KEY_PEM = "-----BEGIN PRIVATE KEY-----\nMIIE...fake...\n-----END PRIVATE KEY-----\n";
const COMBINED_PEM = CERT_PEM + KEY_PEM;

// --------------------------------------------------------------- client-cert ---

describe("loadClientCertMaterial: PEM mode", () => {
  it("a combined PEM (cert + key in one file, no ABAP_CLIENT_KEY) loads with cert === key and no keyPath", () => {
    const files = new Map([["/certs/combined.pem", Buffer.from(COMBINED_PEM)]]);
    const { material, issue } = loadClientCertMaterial(
      { certPath: "/certs/combined.pem" },
      makeReader(files),
    );
    expect(issue).toBeUndefined();
    expect(material?.kind).toBe("pem");
    expect(material?.certPath).toBe("/certs/combined.pem");
    expect(material?.keyPath).toBeUndefined();
    expect(material?.cert?.toString("utf8")).toBe(COMBINED_PEM);
    // Node accepts the same buffer for both `cert` and `key` in this shape.
    expect(material?.key).toBe(material?.cert);
  });

  it("a separate cert + key file pair loads with distinct buffers and keyPath set", () => {
    const files = new Map([
      ["/certs/cert.pem", Buffer.from(CERT_PEM)],
      ["/certs/key.pem", Buffer.from(KEY_PEM)],
    ]);
    const { material, issue } = loadClientCertMaterial(
      { certPath: "/certs/cert.pem", keyPath: "/certs/key.pem" },
      makeReader(files),
    );
    expect(issue).toBeUndefined();
    expect(material?.kind).toBe("pem");
    expect(material?.certPath).toBe("/certs/cert.pem");
    expect(material?.keyPath).toBe("/certs/key.pem");
    expect(material?.cert?.toString("utf8")).toBe(CERT_PEM);
    expect(material?.key?.toString("utf8")).toBe(KEY_PEM);
  });

  it("carries the passphrase through into the material when supplied", () => {
    const files = new Map([
      ["/certs/cert.pem", Buffer.from(CERT_PEM)],
      ["/certs/key.pem", Buffer.from(KEY_PEM)],
    ]);
    const { material } = loadClientCertMaterial(
      { certPath: "/certs/cert.pem", keyPath: "/certs/key.pem", passphrase: KEY_PASSPHRASE_SENTINEL },
      makeReader(files),
    );
    expect(material?.passphrase).toBe(KEY_PASSPHRASE_SENTINEL);
  });

  it("omits passphrase from the material entirely when not supplied (not even undefined-but-present)", () => {
    const files = new Map([["/certs/combined.pem", Buffer.from(COMBINED_PEM)]]);
    const { material } = loadClientCertMaterial(
      { certPath: "/certs/combined.pem" },
      makeReader(files),
    );
    expect("passphrase" in (material ?? {})).toBe(false);
  });

  it("a cert file with no '-----BEGIN' line is rejected as not-PEM, naming ABAP_CLIENT_CERT and the path", () => {
    const files = new Map([["/certs/cert.pem", Buffer.from("not a certificate at all")]]);
    const { material, issue } = loadClientCertMaterial(
      { certPath: "/certs/cert.pem" },
      makeReader(files),
    );
    expect(material).toBeUndefined();
    expect(issue).toContain("ABAP_CLIENT_CERT");
    expect(issue).toContain("/certs/cert.pem");
    expect(issue).toContain("does not look like a PEM file");
  });

  it("a combined-PEM cert with no private key and no ABAP_CLIENT_KEY is rejected, telling the operator both remedies", () => {
    const files = new Map([["/certs/cert.pem", Buffer.from(CERT_PEM)]]);
    const { material, issue } = loadClientCertMaterial(
      { certPath: "/certs/cert.pem" },
      makeReader(files),
    );
    expect(material).toBeUndefined();
    expect(issue).toContain("ABAP_CLIENT_KEY is not set");
    expect(issue).toContain("PKCS#12");
  });

  it("a missing cert file surfaces the OS error text, naming ABAP_CLIENT_CERT and the path, never file content", () => {
    const { material, issue } = loadClientCertMaterial(
      { certPath: "/certs/missing.pem" },
      makeReader(new Map()),
    );
    expect(material).toBeUndefined();
    expect(issue).toContain("ABAP_CLIENT_CERT (/certs/missing.pem) could not be read");
    expect(issue).toContain("ENOENT");
  });

  it("a missing separate key file surfaces the OS error text naming ABAP_CLIENT_KEY, not ABAP_CLIENT_CERT", () => {
    const files = new Map([["/certs/cert.pem", Buffer.from(CERT_PEM)]]);
    const { material, issue } = loadClientCertMaterial(
      { certPath: "/certs/cert.pem", keyPath: "/certs/missing-key.pem" },
      makeReader(files),
    );
    expect(material).toBeUndefined();
    expect(issue).toContain("ABAP_CLIENT_KEY (/certs/missing-key.pem) could not be read");
    expect(issue).not.toContain("ABAP_CLIENT_CERT (");
  });

  it("no issue message from a bad cert ever contains the cert file's own content", () => {
    // The file "content" here doubles as a secret-shaped string so a
    // regression that echoed file content back would be caught either way.
    const files = new Map([["/certs/cert.pem", Buffer.from(`garbage-${KEY_PASSPHRASE_SENTINEL}`)]]);
    const { issue } = loadClientCertMaterial({ certPath: "/certs/cert.pem" }, makeReader(files));
    expect(issue).not.toContain(KEY_PASSPHRASE_SENTINEL);
    expect(issue).not.toContain(KEY_PASSPHRASE_SENTINEL.slice(0, 6));
  });
});

describe("loadClientCertMaterial: PFX/PKCS#12 mode", () => {
  it("a .pfx path with no ABAP_CLIENT_KEY loads as kind 'pfx' with the raw blob as pfx", () => {
    const blob = Buffer.from([0x30, 0x82, 0x01, 0x02]); // arbitrary bytes; PFX is never PEM-sniffed
    const files = new Map([["/certs/bundle.pfx", blob]]);
    const { material, issue } = loadClientCertMaterial(
      { certPath: "/certs/bundle.pfx" },
      makeReader(files),
    );
    expect(issue).toBeUndefined();
    expect(material?.kind).toBe("pfx");
    expect(material?.pfx).toBe(blob);
    expect(material?.cert).toBeUndefined();
    expect(material?.key).toBeUndefined();
    expect(material?.certPath).toBe("/certs/bundle.pfx");
  });

  it("a .p12 extension is treated the same as .pfx", () => {
    const blob = Buffer.from([0x01, 0x02]);
    const files = new Map([["/certs/bundle.p12", blob]]);
    const { material } = loadClientCertMaterial({ certPath: "/certs/bundle.p12" }, makeReader(files));
    expect(material?.kind).toBe("pfx");
  });

  it("the .pfx/.p12 extension match is case-insensitive", () => {
    const blob = Buffer.from([0x01]);
    const files = new Map([["/certs/BUNDLE.PFX", blob]]);
    const { material } = loadClientCertMaterial({ certPath: "/certs/BUNDLE.PFX" }, makeReader(files));
    expect(material?.kind).toBe("pfx");
  });

  it("carries the passphrase through for a PFX exactly as for PEM", () => {
    const files = new Map([["/certs/bundle.pfx", Buffer.from([0x01])]]);
    const { material } = loadClientCertMaterial(
      { certPath: "/certs/bundle.pfx", passphrase: KEY_PASSPHRASE_SENTINEL },
      makeReader(files),
    );
    expect(material?.passphrase).toBe(KEY_PASSPHRASE_SENTINEL);
  });

  it("ABAP_CLIENT_KEY set alongside a .pfx ABAP_CLIENT_CERT is rejected — a PFX already contains the key", () => {
    const files = new Map([["/certs/bundle.pfx", Buffer.from([0x01])]]);
    const { material, issue } = loadClientCertMaterial(
      { certPath: "/certs/bundle.pfx", keyPath: "/certs/key.pem" },
      makeReader(files),
    );
    expect(material).toBeUndefined();
    expect(issue).toContain("ABAP_CLIENT_KEY is set but ABAP_CLIENT_CERT points at a PKCS#12 file");
    expect(issue).toContain("/certs/bundle.pfx");
    // Never even attempts to read the key file when rejecting up front.
    expect(issue).not.toContain("/certs/key.pem");
  });

  it("a missing .pfx file surfaces the OS error naming ABAP_CLIENT_CERT", () => {
    const { material, issue } = loadClientCertMaterial(
      { certPath: "/certs/missing.pfx" },
      makeReader(new Map()),
    );
    expect(material).toBeUndefined();
    expect(issue).toContain("ABAP_CLIENT_CERT (/certs/missing.pfx) could not be read");
  });
});

// -------------------------------------------------------------------- CA bundle ---

describe("loadCaBundle", () => {
  it("loads a valid PEM CA bundle, keeping the path alongside the raw bytes", () => {
    const files = new Map([["/ca/bundle.pem", Buffer.from(CERT_PEM)]]);
    const { bundle, issue } = loadCaBundle("/ca/bundle.pem", makeReader(files));
    expect(issue).toBeUndefined();
    expect(bundle?.path).toBe("/ca/bundle.pem");
    expect(bundle?.pem.toString("utf8")).toBe(CERT_PEM);
  });

  it("rejects a non-PEM file, naming ABAP_CA_CERT and the path", () => {
    const files = new Map([["/ca/bundle.pem", Buffer.from("definitely not a cert")]]);
    const { bundle, issue } = loadCaBundle("/ca/bundle.pem", makeReader(files));
    expect(bundle).toBeUndefined();
    expect(issue).toContain("ABAP_CA_CERT (/ca/bundle.pem)");
    expect(issue).toContain("does not look like a PEM file");
  });

  it("a missing CA file surfaces the OS error text naming ABAP_CA_CERT, never file content", () => {
    const { bundle, issue } = loadCaBundle("/ca/missing.pem", makeReader(new Map()));
    expect(bundle).toBeUndefined();
    expect(issue).toContain("ABAP_CA_CERT (/ca/missing.pem) could not be read");
    expect(issue).toContain("ENOENT");
  });
});

// ------------------------------------------------------------------ service key ---

const validServiceKey = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    url: "https://my-abap-system.example.com",
    uaa: {
      clientid: "sb-clientid-1234",
      clientsecret: SERVICE_KEY_SECRET_SENTINEL,
      url: "https://my-tenant.authentication.eu10.hana.ondemand.com",
      ...over,
    },
  });

describe("parseServiceKey: success shapes", () => {
  it("derives the token URL by appending /oauth/token to uaa.url", () => {
    const { settings, issue } = parseServiceKey("/keys/sk.json", validServiceKey());
    expect(issue).toBeUndefined();
    expect(settings?.tokenUrl).toBe(
      "https://my-tenant.authentication.eu10.hana.ondemand.com/oauth/token",
    );
    expect(settings?.clientId).toBe("sb-clientid-1234");
    expect(settings?.clientSecret).toBe(SERVICE_KEY_SECRET_SENTINEL);
    expect(settings?.source).toBe("service-key");
    expect(settings?.serviceKeyPath).toBe("/keys/sk.json");
  });

  it("strips a trailing slash from uaa.url before appending /oauth/token", () => {
    const { settings } = parseServiceKey(
      "/keys/sk.json",
      validServiceKey({ url: "https://tenant.example.com/" }),
    );
    expect(settings?.tokenUrl).toBe("https://tenant.example.com/oauth/token");
  });

  it("uses uaa.url as-is when it already ends in /oauth/token, rather than doubling the suffix", () => {
    const { settings } = parseServiceKey(
      "/keys/sk.json",
      validServiceKey({ url: "https://tenant.example.com/oauth/token" }),
    );
    expect(settings?.tokenUrl).toBe("https://tenant.example.com/oauth/token");
  });

  it("carries uaa.scope through when it is a non-empty string", () => {
    const { settings } = parseServiceKey("/keys/sk.json", validServiceKey({ scope: "uaa.resource" }));
    expect(settings?.scope).toBe("uaa.resource");
  });

  it("omits scope entirely when uaa.scope is absent", () => {
    const { settings } = parseServiceKey("/keys/sk.json", validServiceKey());
    expect("scope" in (settings ?? {})).toBe(false);
  });

  it("omits scope when uaa.scope is present but an empty string", () => {
    const { settings } = parseServiceKey("/keys/sk.json", validServiceKey({ scope: "" }));
    expect("scope" in (settings ?? {})).toBe(false);
  });
});

describe("parseServiceKey: validation failures", () => {
  it("invalid JSON is rejected, naming ABAP_SERVICE_KEY and the path, and never echoes the raw text", () => {
    const raw = `{not valid json, secret=${SERVICE_KEY_SECRET_SENTINEL}`;
    const { settings, issue } = parseServiceKey("/keys/sk.json", raw);
    expect(settings).toBeUndefined();
    expect(issue).toContain("ABAP_SERVICE_KEY (/keys/sk.json) is not valid JSON");
    expect(issue).not.toContain(SERVICE_KEY_SECRET_SENTINEL);
    expect(issue).not.toContain(SERVICE_KEY_SECRET_SENTINEL.slice(0, 6));
  });

  it("a single missing field is named alone", () => {
    const { settings, issue } = parseServiceKey(
      "/keys/sk.json",
      JSON.stringify({ uaa: { clientid: "id", clientsecret: SERVICE_KEY_SECRET_SENTINEL } }),
    );
    expect(settings).toBeUndefined();
    expect(issue).toContain("ABAP_SERVICE_KEY (/keys/sk.json) is missing uaa.url");
    expect(issue).not.toContain("uaa.clientid");
    expect(issue).not.toContain("uaa.clientsecret");
  });

  it("two missing fields are joined with 'and', no Oxford comma", () => {
    const { issue } = parseServiceKey("/keys/sk.json", JSON.stringify({ uaa: { clientid: "id" } }));
    expect(issue).toContain("uaa.clientsecret and uaa.url");
  });

  it("all three missing fields are joined with commas and a trailing 'and'", () => {
    const { issue } = parseServiceKey("/keys/sk.json", JSON.stringify({}));
    expect(issue).toContain("uaa.clientid, uaa.clientsecret, and uaa.url");
    expect(issue).toContain("does not look like an SAP BTP ABAP-environment service key");
  });

  it("never echoes an actual field VALUE from the key, only field NAMES, even when a value is present but wrong-typed", () => {
    const { issue } = parseServiceKey(
      "/keys/sk.json",
      JSON.stringify({ uaa: { clientid: 12345, clientsecret: SERVICE_KEY_SECRET_SENTINEL, url: "" } }),
    );
    // clientid: number (wrong type) -> counts as missing; url: "" is a string,
    // so it does NOT count as missing (only `typeof === "string"` is checked) —
    // pins that url="" alone reaches parseServiceKey's success path here and
    // is only rejected, if at all, by a LATER stage (not this function's job).
    expect(issue).toContain("uaa.clientid");
    expect(issue).not.toContain("12345");
    expect(issue).not.toContain(SERVICE_KEY_SECRET_SENTINEL);
  });

  it("a null uaa object is treated the same as a completely missing one", () => {
    const { issue } = parseServiceKey("/keys/sk.json", JSON.stringify({ uaa: null }));
    expect(issue).toContain("uaa.clientid, uaa.clientsecret, and uaa.url");
  });
});
