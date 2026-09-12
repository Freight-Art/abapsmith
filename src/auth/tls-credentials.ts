import type { Config } from "../config.js";
import type { TlsCredentials } from "../adt/http-guard.js";

/**
 * The one place that turns resolved config into the TLS options both network
 * stacks use (axios via `GuardedHttpClient`, and the debugger's raw
 * `node:https` sockets in `src/debug/transport.ts`). A single function so the
 * two stacks cannot disagree about client certificates the way they once
 * disagreed about `ABAP_INSECURE` — see `test/tls-policy-agreement.test.ts`.
 */
export function tlsCredentialsFromConfig(cfg: Config): TlsCredentials {
  return {
    ...(cfg.insecure !== undefined ? { insecure: cfg.insecure } : {}),
    ...(cfg.caCert?.pem !== undefined ? { ca: cfg.caCert.pem } : {}),
    ...(cfg.clientCert?.cert !== undefined ? { cert: cfg.clientCert.cert } : {}),
    ...(cfg.clientCert?.key !== undefined ? { key: cfg.clientCert.key } : {}),
    ...(cfg.clientCert?.pfx !== undefined ? { pfx: cfg.clientCert.pfx } : {}),
    ...(cfg.clientCert?.passphrase !== undefined ? { passphrase: cfg.clientCert.passphrase } : {}),
  };
}
