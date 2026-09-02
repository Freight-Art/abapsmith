/**
 * Wire-value helpers shared by connection.ts and system-role.ts, pulled out
 * to avoid an import cycle between them. Add here only if both need it —
 * connection.ts re-exports all four so existing imports keep working.
 */

// Accept header must be exactly this — application/xml returns 406 here (live-proven, pinned by
// test). Also used by probeT000() in system-role.ts. See the git history.
export const DATA_PREVIEW_ACCEPT = "application/vnd.sap.adt.datapreview.table.v1+xml";

// ABAP CHAR1 booleans arrive space-padded ("X ") or as abap_true/true/1; old /^(true|x|yes)$/i missed some.
const ABAP_TRUE_VALUES = new Set(["true", "x", "yes", "y", "on", "1", "abap_true"]);

export function isAbapTrue(value: string | null | undefined): boolean {
  return value != null && ABAP_TRUE_VALUES.has(value.trim().toLowerCase());
}

// Clients are 3-char; "1" and "001" are the same client. Shared with classifyT000Response() in system-role.ts.
export const normaliseClient = (c: string): string =>
  /^\d+$/.test(c.trim()) ? c.trim().padStart(3, "0") : c.trim();

// Reads client from the sap-usercontext cookie (sap-client=001; fixture p3b-sap-usercontext.txt).
// Null means inconclusive, never a guess.
export function logonClientFromCookies(cookies: string | null | undefined): string | null {
  if (!cookies) return null;
  const ctx = /sap-usercontext=([^;]*)/i.exec(cookies)?.[1];
  const from = (s: string | undefined): string | null => {
    const m = s ? /sap-client=(\d{1,3})/i.exec(decodeURIComponent(s)) : null;
    return m ? normaliseClient(m[1]!) : null;
  };
  return from(ctx) ?? from(cookies);
}
