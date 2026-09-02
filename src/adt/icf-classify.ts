/**
 * ICF/ADT response classification — pure, stateless sniffing of HTTP response
 * bodies for the auth circuit breaker: does a response look like an ICF
 * logon-failure page, an ICF password-change page, or a benign ABAP debugger
 * exception? No module-level mutable state, no `fs`, no `crypto`.
 *
 * Split out of `src/adt/circuit-breaker.ts`, which still re-exports every
 * symbol this file exports, so no import site elsewhere needed to change.
 * Split history: the git history.
 */
import { isSessionDeath } from "./session.js";
import type { ResponseLike, TripReason } from "./circuit-breaker.js";

/**
 * ICF logon-failure HTML page markers, tiered by how much weight the evidence
 * carries ALONE. Tier A trips by itself; Tier B (loose prose) needs a second
 * witness, see {@link hasCorroboratingEvidence} — it's translated copy that
 * can legitimately appear inside an ADT payload, and a false positive here
 * permanently disables the process.
 *
 * The field-name markers are reasoned from SAP's documented ICF form field
 * names, UNVERIFIED against a live capture (provoking one is forbidden — it
 * burns one of five attempts toward an account lock); kept because a false
 * NEGATIVE here is the expensive direction. The title-anchored prose marker
 * IS verified against a live capture. Full reasoning and fixture references:
 * the git history.
 */
const ICF_LOGON_MARKERS_TIER_A: RegExp[] = [
  // Logon-form field names — UNVERIFIED, see comment above.
  /sap-system-login/i,
  /name="sap-user"/i,
  /name="sap-password"/i,
  // Title-anchored prose — verified against a live capture (DE); EN variants untested.
  /<title>[^<]*anmeldung\s+fehlgeschlagen[^<]*<\/title>/i,
  /<title>[^<]*logon\s+fail(?:ed|ure)[^<]*<\/title>/i,
  /<title>[^<]*logon\s+error\s+message[^<]*<\/title>/i,
];

const ICF_LOGON_MARKERS_TIER_B: RegExp[] = [
  /anmeldung\s+fehlgeschlagen/i,
  /logon\s+failed/i,
  /logon\s+error\s+message/i,
  /authentication\s+failed/i,
];

/**
 * ICF "password must be changed" page markers — same Tier A/B rule as above.
 * JUDGMENT CALL, NOT LIVE-VERIFIED: no capture of this page exists (the
 * appliance's `DEVELOPER` user has never been forced through a password
 * change). Field names and prose are SAP's documented/standard wording, not
 * measured. See the git history.
 */
const ICF_PASSWORD_CHANGE_MARKERS_TIER_A: RegExp[] = [
  /name="sap-new-password1"/i,
  /name="sap-new-password2"/i,
];

const ICF_PASSWORD_CHANGE_MARKERS_TIER_B: RegExp[] = [
  /password\s+must\s+be\s+changed/i,
  /kennwort\s+muss\s+geändert\s+werden/i,
];

function headerValue(headers: Record<string, unknown> | undefined, name: string): string {
  if (!headers) return "";
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  if (!key) return "";
  const v = headers[key];
  return Array.isArray(v) ? v.join(" ") : String(v ?? "");
}

function looksLikeHtml(resp: ResponseLike, body: string): boolean {
  const ctype = headerValue(resp.headers, "content-type").toLowerCase();
  return ctype.includes("html") || /^\s*(<!doctype html|<html)/i.test(body);
}

/**
 * The second witness a Tier B prose match needs before it may latch anything:
 * a `<form` tag, or a `WWW-Authenticate` response header (both verified
 * against live captures — see archive).
 *
 * Known gap: both can be absent at once (e.g. an ICF logon problem arriving
 * as HTTP 200, which carries no `WWW-Authenticate`). If so, only loose prose
 * remains and this deliberately still returns false — latching the whole
 * process isn't justified on that evidence alone. Tier A's title anchor is
 * meant to carry those cases instead. See archive for the full reasoning.
 */
function hasCorroboratingEvidence(head: string, resp: ResponseLike): boolean {
  return /<form/i.test(head) || headerValue(resp.headers, "www-authenticate") !== "";
}

/**
 * Bytes of body scanned by the tiered markers — enough for `<head>` plus
 * error banner, bounded so classification can't become a full-body scan.
 * Deliberately independent of `session.ts`'s own (larger) death-marker window.
 */
const AUTH_MARKER_SCAN_BYTES = 8192;

/**
 * Tiered marker evaluation shared by the logon-failure and password-change
 * classifiers below; looks only at {@link AUTH_MARKER_SCAN_BYTES} bytes.
 */
function matchesTieredMarkers(
  resp: ResponseLike,
  body: string,
  tierA: RegExp[],
  tierB: RegExp[],
): boolean {
  const head = body.slice(0, AUTH_MARKER_SCAN_BYTES);
  if (tierA.some((re) => re.test(head))) return true;
  if (tierB.some((re) => re.test(head))) return hasCorroboratingEvidence(head, resp);
  return false;
}

/**
 * Does this response look like the ICF logon-failed HTML page? Must be HTML
 * (ADT source/XML payloads never are) and carry a marker. A false positive
 * costs a wedged process; a false negative costs a locked account.
 */
export function isIcfLogonFailure(resp: ResponseLike): boolean {
  const body = resp.body ?? "";
  if (!body) return false;
  if (!looksLikeHtml(resp, body)) return false;
  return matchesTieredMarkers(resp, body, ICF_LOGON_MARKERS_TIER_A, ICF_LOGON_MARKERS_TIER_B);
}

/**
 * Does this response look like the ICF "password must be changed" page? Same
 * conservatism as {@link isIcfLogonFailure}; markers are unverified, see
 * {@link ICF_PASSWORD_CHANGE_MARKERS_TIER_A}.
 */
export function isIcfPasswordChangePage(resp: ResponseLike): boolean {
  const body = resp.body ?? "";
  if (!body) return false;
  if (!looksLikeHtml(resp, body)) return false;
  return matchesTieredMarkers(
    resp,
    body,
    ICF_PASSWORD_CHANGE_MARKERS_TIER_A,
    ICF_PASSWORD_CHANGE_MARKERS_TIER_B,
  );
}

/**
 * Is this response an authentication failure of any shape?
 *
 * The session-death guard runs FIRST and always wins: it can't be defeated
 * by a future marker overlap between the ICF logon page and the ICM dump
 * page, and it costs nothing here since session death is only ever 400/500,
 * never 401, never a 200 carrying the logon form, never a 403 challenge.
 */
export function classifyAuthFailure(resp: ResponseLike): TripReason | undefined {
  if (isSessionDeath(resp)) return undefined;
  if (resp.status === 401) return "http-401";
  if (isIcfPasswordChangePage(resp)) return "icf-password-change";
  if (isIcfLogonFailure(resp)) return "icf-logon-page";
  // 403 with a WWW-Authenticate challenge is an auth failure, not authorisation.
  if (resp.status === 403 && headerValue(resp.headers, "www-authenticate")) {
    return "http-403-auth";
  }
  return undefined;
}

/**
 * ABAP exception classes whose HTTP 500 is a normal debugger outcome, not a
 * remote failure — counting them as transient would open the breaker after
 * three ordinary debug calls and wedge the debugger for a full cooldown.
 * Names are taken verbatim from bodies captured off the appliance, never
 * from the generic `<message>` prose ("An exception was raised" for all of
 * them). Per-class reasoning and fixture captures:
 * the git history.
 */
export const BENIGN_DEBUG_EXCEPTION_CLASSES: readonly string[] = [
  "CX_TPDA_SYS_COMM_DBGSESSIONEND",
  "CX_TPDA_SYS_COMM_SLAVENOTCONN",
];

/**
 * ADT communication-framework subtypes meaning the same as the classes
 * above, matched on the machine-readable `subType`, never on prose.
 * `noSessionAttached` has no corresponding `CX_*` class — the subtype IS the
 * identifier for that case. See archive for fixture references.
 */
export const BENIGN_DEBUG_SUBTYPES: readonly string[] = [
  "terminateDebuggee",
  "noSessionAttached",
];

/** `<entry key="...">value</entry>` — the ADT exception envelope's property shape. */
const ADT_ENTRY_SOURCE = String.raw`<entry\s+key\s*=\s*(?:"([^"]*)"|'([^']*)')\s*>([^<]*)</entry>`;
/** `previous1ExceptionClassName`, `previous2ExceptionClassName`, … */
const EXCEPTION_CLASS_KEY = /^previous\d*ExceptionClassName$/i;
const SUBTYPE_KEY = "com.sap.adt.communicationframework.subtype";

/**
 * Is this 5xx one of the debugger's normal/success shapes? Structural only —
 * reads `<entry key="…">` properties and compares against the captured lists
 * above; never matches on `<message>` prose (identical across success and
 * failure). A `true` must be counted as SUCCESS and never reach the auth
 * classifier.
 */
export function isBenignDebugFailure(resp: ResponseLike): boolean {
  const body = resp.body;
  if (!body || !body.includes("<entry")) return false;
  // A fresh regex per call: a shared /g/ literal carries `lastIndex` between
  // calls and would silently skip matches.
  const re = new RegExp(ADT_ENTRY_SOURCE, "gi");
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const key = (m[1] ?? m[2] ?? "").trim();
    const value = (m[3] ?? "").trim();
    if (EXCEPTION_CLASS_KEY.test(key)) {
      if (BENIGN_DEBUG_EXCEPTION_CLASSES.some((c) => c === value.toUpperCase())) return true;
    } else if (key.toLowerCase() === SUBTYPE_KEY) {
      if (BENIGN_DEBUG_SUBTYPES.some((s) => s.toLowerCase() === value.toLowerCase())) return true;
    }
  }
  return false;
}
