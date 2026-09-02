/**
 * Classifies why `AdtHTTP#login()` failed, for the terminal fallback in
 * `AbapConnection.connectUnderLock()` (`src/adt/connection.ts`, right after
 * the logon-ceiling branch). Previously every such failure was
 * hardcoded to `AUTH_FAILED` with no inspection of cause — live-reproduced
 * during an appliance outage where SAP was refusing everyone with a 500 and
 * the tool still told the operator to fix the password. Full incident and
 * the verified walk of abap-adt-api's lossy error-rewrite (`AdtException.js`)
 * that this classifier works around: the git history.
 *
 * `client.login()` never lets a raw error escape — it always rethrows one of
 * `AdtErrorException` / `AdtHttpException` / `AdtCsrfException`, and two
 * branches in the vendor rewrite fabricate a bare 500 for anything that
 * isn't already one of those, discarding the real cause. A transport/TLS
 * `.code`, when present, is the one signal that rewrite never fabricates,
 * so it is checked FIRST here, unconditionally, before status is read.
 *
 * Classification order (load-bearing — do not reorder):
 *  1. transport/TLS code anywhere in the error/`.parent`/`.cause` chain →
 *     `CONNECT_FAILED`. Host never reached; says nothing about credentials.
 *  2. status 401/403 → `AUTH_FAILED`.
 *  3. status 500-599 → `SYSTEM_UNAVAILABLE` (system answered but is down/
 *     overloaded, refusing everyone; no credential was rejected).
 *  4/5. any other status, or nothing identifiable → `ADT_ERROR`,
 *     unclassified — deliberately NOT `AUTH_FAILED`; that was the old bug.
 *
 * Deliberately NOT `TRANSPORT_ERROR` for step 1: that name already means a
 * SAP CTS transport request elsewhere (`src/adt/errors.ts`) — reusing it
 * would collide for any caller expecting a TRKORR.
 *
 * NOT a widening of `classifySessionFailure` (`src/adt/session.ts:223-259`):
 * that classifies MID-SESSION failures via one narrow, corroborated signal
 * (an ABAP dump/ICM-error page). This is the connect-time counterpart, not
 * a replacement — the two are not to be merged.
 */

import { type AbapErrorCode } from "./errors.js";

/** The five `details.reason` strings this classifier can produce. */
export type ConnectFailureReason =
  | "unreachable"
  | "tls"
  | "credentials-rejected"
  | "system-down"
  | "connect-failed";

/** Single source of truth for `classifyConnectFailure`'s `details.reason` values — `src/adt/pool.ts`'s `isConnectFailureClassError` keys off this set. */
export const CONNECT_FAILURE_REASONS: ReadonlySet<ConnectFailureReason> = new Set([
  "unreachable",
  "tls",
  "credentials-rejected",
  "system-down",
  "connect-failed",
]);

export interface ConnectFailureVerdict {
  readonly code: Extract<
    AbapErrorCode,
    "AUTH_FAILED" | "SYSTEM_UNAVAILABLE" | "CONNECT_FAILED" | "ADT_ERROR"
  >;
  readonly reason: ConnectFailureReason;
  /** The HTTP status this verdict was decided on, when one was found. */
  readonly status?: number;
  /** The raw transport/TLS code (e.g. `"ECONNREFUSED"`), when one was found. */
  readonly transport?: string;
  /** Prose for a human — required content is fixed by the design, wording is not. */
  readonly hint: string;
}

/**
 * Network-layer codes for a connection that never completed. Not exhaustive
 * of every Node errno — an unrecognised `.code` still counts as "found" for
 * step 1 but rides along in `details.transport` without a confident
 * `unreachable`-vs-`tls` guess.
 */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNABORTED",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

/** Exact TLS/certificate codes named by the design, beyond the prefix rules below. */
const TLS_CODES: ReadonlySet<string> = new Set([
  "EPROTO",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** Node's TLS/OpenSSL error codes are not a closed enum; the design says "at minimum" these prefixes. */
function isTlsCode(code: string): boolean {
  return (
    TLS_CODES.has(code) ||
    code.startsWith("ERR_TLS_") ||
    code.startsWith("UNABLE_TO_") ||
    code.startsWith("CERT_")
  );
}

/**
 * Walks `.code` then `.parent`/`.cause` for a transport code. Depth-bounded
 * and cycle-guarded against a malformed/adversarial chain — the real chain
 * is one hop (`AdtHttpException.code` → `HttpClientException`).
 */
const MAX_CHAIN_DEPTH = 8;

function findTransportCode(e: unknown): string | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = e;
  for (let i = 0; i < MAX_CHAIN_DEPTH; i++) {
    if (!cur || typeof cur !== "object" || seen.has(cur)) return undefined;
    seen.add(cur);
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
    const parent = (cur as { parent?: unknown }).parent;
    const cause = (cur as { cause?: unknown }).cause;
    cur = parent ?? cause;
  }
  return undefined;
}

/**
 * Reads whatever status abap-adt-api exposes. Checks `.err` first —
 * `AdtErrorException`'s status property is named `err`, not `status`
 * (`AdtException.d.ts`). `.status` covers `AdtHttpException` (delegates to
 * `.parent.status`, 0 when no response arrived); 0 is treated as "no status".
 */
function findStatus(e: unknown): number | undefined {
  if (!e || typeof e !== "object") return undefined;
  const err = (e as { err?: unknown }).err;
  if (typeof err === "number" && Number.isFinite(err) && err > 0) return err;
  const status = (e as { status?: unknown }).status;
  if (typeof status === "number" && Number.isFinite(status) && status > 0) return status;
  return undefined;
}

const AUTH_HINT =
  "Credentials were rejected by the ABAP system and were NOT retried " +
  "(repeated logon attempts lock the SAP user; login/fails_to_user_lock " +
  "defaults to 5). Fix ABAP_USER / ABAP_PASSWORD.";

function systemDownHint(status: number): string {
  return (
    `The ABAP system answered (HTTP ${status}) but is down or overloaded and ` +
    "is refusing everyone — no credential was rejected, so do NOT change the " +
    "password. Retrying will not help until the system recovers; check it " +
    "with the Basis team, SM21, or the appliance console."
  );
}

function unreachableHint(code: string): string {
  return (
    `The host was never reached (${code}) — this says nothing about the ` +
    "credentials. Check ABAP_URL, DNS, the VPN, and the port."
  );
}

function tlsHint(code: string): string {
  return (
    `The TLS handshake to the host failed (${code}) — this says nothing ` +
    "about the credentials. Check the server certificate, or ABAP_INSECURE " +
    "if this is a self-signed/internal-CA sandbox."
  );
}

const UNCLASSIFIED_HINT =
  "The cause of this connect failure could not be classified. Credentials " +
  "were NOT retried. Both reachability and credentials are candidates — " +
  "check ABAP_URL/DNS/VPN as well as ABAP_USER/ABAP_PASSWORD.";

/**
 * The step-2 verdict, reachable without an error to classify. The auth
 * circuit breaker latches on 401 inside the HTTP guard and replaces it with
 * its own error before `client.login()` rejects, so `connect()` reads the
 * breaker's trip record directly and builds the verdict here instead of
 * duplicating it at the call site.
 */
export function credentialsRejectedVerdict(status: number): ConnectFailureVerdict {
  return { code: "AUTH_FAILED", reason: "credentials-rejected", status, hint: AUTH_HINT };
}

/**
 * Classifies a `client.login()` failure for `connectUnderLock()`'s terminal
 * fallback.
 * See the module header for the verified vendor-rewrite hazard and the
 * (load-bearing, ordered) classification rules.
 */
export function classifyConnectFailure(e: unknown): ConnectFailureVerdict {
  const transport = findTransportCode(e);

  // Step 1 — transport/TLS, before status is even read.
  if (transport && isTlsCode(transport)) {
    return { code: "CONNECT_FAILED", reason: "tls", transport, hint: tlsHint(transport) };
  }
  if (transport && NETWORK_CODES.has(transport)) {
    return {
      code: "CONNECT_FAILED",
      reason: "unreachable",
      transport,
      hint: unreachableHint(transport),
    };
  }
  // An unrecognised `.code` is real evidence but not enough to guess
  // unreachable vs. tls; it rides along as `details.transport` while
  // classification falls through to status.

  const status = findStatus(e);

  // Step 2.
  if (status === 401 || status === 403) {
    return { code: "AUTH_FAILED", reason: "credentials-rejected", status, transport, hint: AUTH_HINT };
  }

  // Step 3.
  if (status !== undefined && status >= 500 && status <= 599) {
    return {
      code: "SYSTEM_UNAVAILABLE",
      reason: "system-down",
      status,
      transport,
      hint: systemDownHint(status),
    };
  }

  // Steps 4 and 5 — deliberately NOT `AUTH_FAILED`. See module header.
  return { code: "ADT_ERROR", reason: "connect-failed", status, transport, hint: UNCLASSIFIED_HINT };
}
