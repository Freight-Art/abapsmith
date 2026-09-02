/**
 * Pure, synchronous, pre-network validation chain for `abap_adt` — no ADT
 * connection, `SafetyGate`, or filesystem touched. `handlers/adt.ts` runs
 * these checks before `deps.ensureConnected()`/`deps.pool.withRead(...)`, so
 * a malformed call is refused at zero network cost (`test/v2-adt.test.ts`
 * proves this with a client stub that throws on any real request).
 *
 * `abap_adt` is GET-only; mutating verbs are refused upstream in
 * `handlers/adt.ts`, before path/header validation runs.
 */

/**
 * The only prefix `abap_adt` accepts — matches the full ADT-rooted path
 * convention every real caller already passes to `AbapConnection.get`/`post`/
 * `put`/`del` (e.g. `src/adt/transports.ts`'s `CTS_BASE`); not an invented
 * restriction. `baseURL` on the underlying client is scheme+host only, so
 * paths must be full and ADT-rooted, not relative to some other base.
 */
export const ADT_PATH_PREFIX = "/sap/bc/adt/";

/**
 * Headers `abap_adt` refuses to let a caller set (case-insensitive) — all are
 * session-owned by `AbapConnection`/`GuardedHttpClient` (cookies, CSRF,
 * connection framing); a caller override would desync that state. The whole
 * call is refused rather than the header silently stripped, so the caller
 * fails fast instead of hitting a confusing downstream 403/session-death.
 */
export const DENIED_ADT_HEADERS: readonly string[] = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-csrf-token",
  "host",
  "content-length",
  "connection",
];

/** Uppercases `method`, defaulting to `"GET"` when absent — matches the schema's documented default. */
export function normalizeAdtMethod(method: string | undefined): string {
  return (method ?? "GET").toUpperCase();
}

export type AdtPathValidation = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly message: string };

/**
 * All pre-network, all synchronous, checked in this exact order:
 * non-empty, not an absolute URL, not protocol-relative, no `..`
 * segment, must live under {@link ADT_PATH_PREFIX}.
 */
export function validateAdtPath(path: string | undefined): AdtPathValidation {
  if (path === undefined || path === "") {
    return { ok: false, message: "abap_adt requires a non-empty path." };
  }
  if (path.includes("://")) {
    return {
      ok: false,
      message: `abap_adt path must be relative to the connected system, not an absolute URL: "${path}".`,
    };
  }
  if (path.startsWith("//")) {
    return {
      ok: false,
      message: `abap_adt path must not start with "//" (protocol-relative URL): "${path}".`,
    };
  }
  // Strip query/fragment before segment-checking ".." (mirrors http-guard.ts's cutQueryAndFragment).
  const pathOnly = (path.split("#")[0] ?? path).split("?")[0] ?? path;
  if (pathOnly.split("/").includes("..")) {
    return { ok: false, message: `abap_adt path must not contain ".." segments: "${path}".` };
  }
  if (!pathOnly.startsWith(ADT_PATH_PREFIX)) {
    return {
      ok: false,
      message: `abap_adt path must start with "${ADT_PATH_PREFIX}": "${path}".`,
    };
  }
  return { ok: true, path };
}

/**
 * The first caller-supplied header key (original casing, for the error
 * message) that matches {@link DENIED_ADT_HEADERS} case-insensitively, or
 * `undefined` when none does.
 */
export function findDeniedAdtHeader(headers: Record<string, string> | undefined): string | undefined {
  if (headers === undefined) return undefined;
  for (const key of Object.keys(headers)) {
    if (DENIED_ADT_HEADERS.includes(key.toLowerCase())) return key;
  }
  return undefined;
}
