/**
 * Loads X.509 client-certificate material and a CA bundle off disk at
 * startup, so an unreadable or malformed file is a clean, named startup
 * error (`ABAP_CLIENT_CERT (<path>) could not be read: ...`) rather than an
 * opaque TLS failure on the first request. Key material is read into memory
 * and never written anywhere; only PATHS are ever safe to log — see
 * `ClientCertMaterial.certPath`/`keyPath` and `CaBundle.path`.
 */

export interface ClientCertMaterial {
  /** PEM certificate chain. Set in PEM mode; absent in PFX mode. */
  readonly cert?: Buffer;
  /** PEM private key. Set in PEM mode; absent in PFX mode. */
  readonly key?: Buffer;
  /** PKCS#12 blob. Set in PFX mode; absent in PEM mode. */
  readonly pfx?: Buffer;
  /** ABAP_CLIENT_KEY_PASSPHRASE. Secret — never log, never serialise. */
  readonly passphrase?: string;
  /** "pem" or "pfx". Decided by the ABAP_CLIENT_CERT file extension. */
  readonly kind: "pem" | "pfx";
  /** Safe to log. */
  readonly certPath: string;
  /** Safe to log. Absent in PFX mode and in combined-PEM mode. */
  readonly keyPath?: string;
}

export interface CaBundle {
  readonly pem: Buffer;
  /** Safe to log. */
  readonly path: string;
}

/** Injectable so tests never touch the real filesystem. */
export type CredentialFileReader = (path: string) => Buffer;

type ReadOutcome = { ok: true; buf: Buffer } | { ok: false; issue: string };

/**
 * Reads one named credential file, turning any failure (missing, unreadable,
 * permission-denied, …) into an issue string that names the ENV VAR and the
 * PATH but never any file content — the OS error message can't contain key
 * material, so it's safe to include verbatim.
 */
function readNamedFile(envVar: string, path: string, readFile: CredentialFileReader): ReadOutcome {
  try {
    return { ok: true, buf: readFile(path) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, issue: `${envVar} (${path}) could not be read: ${msg}.` };
  }
}

/**
 * PFX mode iff the path ends (case-insensitively) in `.pfx`/`.p12`.
 * Extension decides — documented and predictable; sniffing the bytes would
 * make a renamed file behave differently from its name.
 */
function isPfxPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".pfx") || lower.endsWith(".p12");
}

/** Exactly one of `material` / `issue` is set. `issue` is a sentence for the startup error list. */
export function loadClientCertMaterial(
  spec: { certPath: string; keyPath?: string; passphrase?: string },
  readFile: CredentialFileReader,
): { material?: ClientCertMaterial; issue?: string } {
  const { certPath, keyPath, passphrase } = spec;

  if (isPfxPath(certPath)) {
    if (keyPath !== undefined) {
      // A PFX already contains the private key — pairing it with a separate
      // key file is a configuration mistake, not something to resolve by
      // preferring one over the other.
      return {
        issue:
          `ABAP_CLIENT_KEY is set but ABAP_CLIENT_CERT points at a PKCS#12 file (${certPath}) — ` +
          "a PFX already contains the private key. Unset ABAP_CLIENT_KEY.",
      };
    }
    const pfxRead = readNamedFile("ABAP_CLIENT_CERT", certPath, readFile);
    if (!pfxRead.ok) return { issue: pfxRead.issue };
    return {
      material: {
        pfx: pfxRead.buf,
        ...(passphrase !== undefined ? { passphrase } : {}),
        kind: "pfx",
        certPath,
      },
    };
  }

  // PEM mode.
  const certRead = readNamedFile("ABAP_CLIENT_CERT", certPath, readFile);
  if (!certRead.ok) return { issue: certRead.issue };
  const certText = certRead.buf.toString("utf8");
  if (!certText.includes("-----BEGIN")) {
    return {
      issue:
        `ABAP_CLIENT_CERT (${certPath}) does not look like a PEM file (no "-----BEGIN" line). ` +
        "Point it at a PEM certificate, or at a .pfx/.p12 for PKCS#12.",
    };
  }

  if (keyPath !== undefined) {
    const keyRead = readNamedFile("ABAP_CLIENT_KEY", keyPath, readFile);
    if (!keyRead.ok) return { issue: keyRead.issue };
    return {
      material: {
        cert: certRead.buf,
        key: keyRead.buf,
        ...(passphrase !== undefined ? { passphrase } : {}),
        kind: "pem",
        certPath,
        keyPath,
      },
    };
  }

  // No separate key file: the standard combined-PEM layout requires the
  // cert file to carry its own private key. Node accepts the same buffer
  // passed as both `cert` and `key` in this shape.
  if (!certText.includes("PRIVATE KEY-----")) {
    return {
      issue:
        `ABAP_CLIENT_CERT (${certPath}) is a PEM certificate with no private key in it and ` +
        "ABAP_CLIENT_KEY is not set — set ABAP_CLIENT_KEY to the PEM private-key file, or point " +
        "ABAP_CLIENT_CERT at a PKCS#12 (.pfx/.p12) file that contains both.",
    };
  }
  return {
    material: {
      cert: certRead.buf,
      key: certRead.buf,
      ...(passphrase !== undefined ? { passphrase } : {}),
      kind: "pem",
      certPath,
    },
  };
}

/** Exactly one of `bundle` / `issue` is set. */
export function loadCaBundle(
  path: string,
  readFile: CredentialFileReader,
): { bundle?: CaBundle; issue?: string } {
  const read = readNamedFile("ABAP_CA_CERT", path, readFile);
  if (!read.ok) return { issue: read.issue };
  if (!read.buf.toString("utf8").includes("-----BEGIN")) {
    return {
      issue:
        `ABAP_CA_CERT (${path}) does not look like a PEM file (no "-----BEGIN" line). Point it ` +
        "at a PEM CA certificate or bundle.",
    };
  }
  return { bundle: { pem: read.buf, path } };
}
