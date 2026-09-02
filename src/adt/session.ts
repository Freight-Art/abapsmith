/**
 * Stateful sessions and locking.
 *
 * Four live-verified facts everything here rests on:
 *  - A lock binds to the `sap-contextid` cookie (the session), not the
 *    credentials. Two ADTClients for the same user conflict with each other;
 *    dropping the session releases every lock it holds.
 *  - You cannot activate while holding your own lock (403
 *    `ExceptionResourceNoAccess`) — order must be `lock → PUT → unlock → activate`.
 *  - `unLock` is idempotent, including on a handle that was never valid
 *    (200, empty body, either way) — so its status carries no information
 *    about whether a real lock was released. See `releaseLock`.
 *  - A short dump (`500 text/html`) destroys the session; every later request
 *    on those cookies gets `400 Session Timed Out`, same as idle expiry
 *    (`rdisp/plugin_auto_logout`, header `x-sap-icm-err-id: ICMENOSESSION`).
 *    Not an auth failure, not retryable as one — see `classifySessionFailure`.
 *
 * LAYERING: must stay below `connection.ts` and must not import
 * `circuit-breaker.ts` (which imports the session-death classifier from here) —
 * a cycle would break the guard against a syntax error tripping the 401 latch.
 *
 * Full incident detail: the git history.
 */
import { isCsrfError, type ADTClient, type AdtLock } from "abap-adt-api";
import type { AbapErrorCode } from "./errors.js";
import { AbapError, describeUnknownError } from "./errors.js";
import { MESSAGE_EXCERPT_MAX, truncateText } from "../truncate.js";
import { classifyAdtMessage, unclassifiedMessageKey } from "./adt-message-rules.js";

export interface LockInfo {
  uri: string;
  handle: string;
  /** `IS_LOCAL = X` ⇒ a `$TMP`/local object: no transport needed. */
  isLocal: boolean;
  corrNr?: string;
  corrUser?: string;
  corrText?: string;
}

export interface SessionLike {
  readonly client: ADTClient;
  lock(uri: string): Promise<LockInfo>;
  unlock(uri: string): Promise<void>;
  unlockAll(): Promise<void>;
  readonly heldLocks: readonly LockInfo[];
}

export type SessionFailureKind = "dump" | "session-timeout";

/** The minimum shape both the breaker and this module can classify. */
export interface SessionResponseLike {
  status: number;
  statusText?: string;
  headers?: Record<string, unknown>;
  body?: string;
}

// ---------------------------------------------------------------------------
// Session-death classification
// ---------------------------------------------------------------------------

function headerValue(headers: Record<string, unknown> | undefined, name: string): string {
  if (!headers) return "";
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  if (!key) return "";
  const v = headers[key];
  return Array.isArray(v) ? v.join(" ") : String(v ?? "");
}

/**
 * Structural fingerprint of the ICM error page (`test/fixtures/live-captured/016-trigger-classrun.xml`):
 * `class="errorTextHeader"` / `id="msgText"` survive localisation since ICM
 * only translates the text inside those elements, never the attributes.
 */
const DUMP_STRUCTURAL_MARKERS = [/class="errorTextHeader"/i, /id="msgText"/i];

/**
 * Prose fallback for bodies truncated past the markup above, or stripped of
 * tags. EN is captured (fixture 016); DE variants are uncaptured
 * translations, kept as a last resort behind the structural markers.
 */
const DUMP_PROSE_MARKERS = [
  /application\s+server\s+error/i,
  /internal\s+server\s+error/i,
  // DE — unverified; see above.
  /interner\s+server[-\s]?fehler/i,
  /fehler\s+des\s+applikationsservers/i,
  /laufzeitfehler/i,
];

/**
 * The dead-session answer: a ~9.6 KB HTML page, or a bare 45-byte
 * `400 Session Timed Out` body on LOCK — body need not be HTML. EN forms are
 * captured (`abap-adt-api` itself keys on `statusText === "Session timed out"`
 * in `isCsrfException`); DE forms are uncaptured translations.
 */
const SESSION_GONE_MARKERS = [
  /session\s+timed\s*-?\s*out/i,
  /session\s+no\s+longer\s+exists/i,
  /session\s+has\s+expired/i,
  // DE — unverified; see above.
  /sitzung\s+.{0,20}?abgelaufen/i,
  /sitzung\s+existiert\s+nicht\s+mehr/i,
  /zeit(?:ü|ue)berschreitung\s+der\s+sitzung/i,
];

/**
 * HEADER tier — live-captured passive-expiry signature. Idle past
 * `rdisp/plugin_auto_logout` (1800s), reuse of `sap-contextid` answers `400
 * Session timed out` with `x-sap-icm-err-id: ICMENOSESSION` (mirrored as
 * `sap-err-id`), and every lock the session held is already gone. The ICM
 * answers before the ABAP stack is even dispatched, so this header alone is
 * the reliable signature and needs no corroboration — see the archive for
 * the full captured envelope and the "death wins" corollary for locks.
 */
const ICM_ERR_ID_HEADERS = ["x-sap-icm-err-id", "sap-err-id"];
const ICM_NO_SESSION = "icmenosession";

/**
 * Byte window {@link classifySessionFailure}'s regexes scan — deliberately
 * larger than `circuit-breaker.ts`'s `AUTH_MARKER_SCAN_BYTES` (8192, not
 * meant to track this one) because a short dump's markup sits further down
 * the page than an ICF logon screen's.
 */
const SESSION_MARKER_SCAN_BYTES = 16_384;

/** Body-shape half of the "is this HTML" test — no content-type required. */
const HTML_BODY_START_RE = /^\s*(<!doctype html|<html)/i;

/**
 * Classify a response that killed the ABAP session:
 *  - `x-sap-icm-err-id: ICMENOSESSION` header → "session-timeout" (any status)
 *  - `500 text/html` from classrun → "dump"
 *  - `400` + "Session Timed Out" body/text → "session-timeout"
 *
 * Evidence is graded: the ICM header and the structural dump marker each
 * stand alone; a prose marker needs the body to look like HTML too. Status
 * alone is never enough — a false positive would mask a real failure and
 * tell `circuit-breaker.ts` to treat a plain 500 as non-transient.
 *
 * Must not be confused with an auth failure (see `classifyAuthFailure`) — a
 * user's syntax mistake must never trip `AuthCircuitBreaker`.
 */
export function classifySessionFailure(
  resp: SessionResponseLike | undefined,
): SessionFailureKind | undefined {
  if (!resp) return undefined;
  const body = resp.body ?? "";
  const statusText = resp.statusText ?? "";
  const head = body.slice(0, SESSION_MARKER_SCAN_BYTES);

  // HEADER tier first, ungated by status, so it's not shadowed by the
  // `return undefined` ending the 500 branch. Case-insensitive on both name
  // and value; `sap-err-id` is the ICM's mirror of the same header.
  const icmErrId = ICM_ERR_ID_HEADERS.map((h) => headerValue(resp.headers, h))
    .join(" ")
    .toLowerCase();
  if (icmErrId.includes(ICM_NO_SESSION)) return "session-timeout";

  if (resp.status === 500) {
    // Structural first: locale-independent, so it survives the appliance
    // answering in the logon language instead of English.
    if (DUMP_STRUCTURAL_MARKERS.some((re) => re.test(head))) return "dump";
    const ctype = headerValue(resp.headers, "content-type").toLowerCase();
    const looksHtml = ctype.includes("html") || HTML_BODY_START_RE.test(body);
    if (looksHtml && DUMP_PROSE_MARKERS.some((re) => re.test(head))) return "dump";
    return undefined;
  }

  if (resp.status === 400) {
    if (SESSION_GONE_MARKERS.some((re) => re.test(head) || re.test(statusText))) {
      return "session-timeout";
    }
  }
  return undefined;
}

/**
 * Convenience predicate for the circuit breaker: "the ABAP session died, this
 * is a re-login situation, NOT an authentication failure".
 */
export function isSessionDeath(resp: SessionResponseLike | undefined): boolean {
  return classifySessionFailure(resp) !== undefined;
}

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/** Tags → newlines, entities decoded, blank lines dropped. */
function htmlToLines(html: string): string[] {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, "\n")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => HTML_ENTITIES[m] ?? m)
    .split("\n")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

/** Boilerplate the ICM page wraps around the two strings we actually want. */
const DUMP_NOISE =
  /^(server time|error code|http|version|url|what happened|note|please|error:|the following error|contact|system|details|© |copyright)/i;

/**
 * Pull the one useful string (e.g. `Division by zero`) out of the ~10 KB ICM
 * error page — no dump ID, no stack, no source position is available.
 *
 * Verified against six live-captured RABAX ICF pages
 * (`test/fixtures/live-captured/701-…`–`706-…`, pinned in `test/session.test.ts`):
 * all six hit step 2 (first meaningful line after the error heading); step 1
 * (an explicit `Error:` label) fired on none of them and is kept only
 * because it costs nothing. All captures are English — a differently
 * localised page is outside what these captures prove.
 *
 * Returns `undefined` rather than guessing if nothing is found.
 */
export function extractDumpShortText(html: string): string | undefined {
  if (!html) return undefined;

  // 1. An explicitly labelled row, if the page has one.
  const labelled = /(?:^|[>\n])\s*(?:Error|Exception|Fehler)\s*:\s*([^<\n]{3,200})/i.exec(html);
  if (labelled?.[1]) {
    const t = labelled[1].replace(/\s+/g, " ").trim();
    if (t && !/^\d{3}\b/.test(t)) return t;
  }

  // 2. First meaningful line after the "500 Internal Server Error" heading.
  const lines = htmlToLines(html);
  const headingIdx = lines.findIndex((l) => /^\d{3}\s+\S/.test(l) || DUMP_PROSE_MARKERS.some((re) => re.test(l)));
  const candidates = headingIdx >= 0 ? lines.slice(headingIdx + 1) : lines;
  for (const line of candidates) {
    if (/^\d{3}\s+\S/.test(line)) continue;
    if (DUMP_PROSE_MARKERS.some((re) => re.test(line))) continue;
    if (DUMP_NOISE.test(line)) continue;
    if (line.length < 3 || line.length > 200) continue;
    return line;
  }
  return undefined;
}

/**
 * The ICF error page never renders `Server time: …` server-side — it emits
 * `var d = "YYYYMMDD"; var t = "HHMMSS";` and composes the string with a
 * client-side `document.write`. Since nothing here runs JS, parse the two
 * literals directly and compose them the same way the browser would.
 */
export function extractDumpServerTime(html: string): string | undefined {
  const d = /var\s+d\s*=\s*"(\d{8})"\s*;/.exec(html)?.[1];
  const t = /var\s+t\s*=\s*"(\d{6})"\s*;/.exec(html)?.[1];
  if (!d || !t) return undefined;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
}

/** Everything worth knowing about an ICM dump page, for `run.ts`. */
export function parseDumpPage(html: string): { shortText?: string; serverTime?: string } {
  return { shortText: extractDumpShortText(html), serverTime: extractDumpServerTime(html) };
}

// ---------------------------------------------------------------------------
// ADT exception → structured AbapError
// ---------------------------------------------------------------------------

export interface AdtExceptionInfo {
  status?: number;
  /** e.g. `ExceptionResourceNoAccess`. */
  type?: string;
  message: string;
  /** `<properties><entry key="…">`, with the LONGTEXT blob already removed. */
  properties: Record<string, string>;
  response?: SessionResponseLike;
}

/**
 * Normalise whatever `abap-adt-api` threw into something we can branch on.
 * `AdtErrorException` carries `.err`/`.type`/`.message`/`.properties`;
 * `AdtHttpException` only `.status` and a parent error. `.response` is
 * usually undefined on the parsed-envelope path (see `pickResponse` below).
 */
/**
 * Recover the raw HTTP response from whatever `abap-adt-api` threw, walking
 * one level into `.parent` where needed.
 *
 * Verified against `node_modules/abap-adt-api/build/AdtException.js`: a
 * parsed `<exc:exception>` envelope builds `AdtErrorException` via the 7-arg
 * constructor (`.response` undefined); the ICM short-dump page fails to
 * parse and falls through to the 8-arg `create(response, {})` (`.response`
 * populated); a transport failure wraps everything in `AdtHttpException`,
 * whose `.parent` carries the original error and the response one level
 * down. Bounded to one hop on purpose.
 */
function pickResponse(any: Record<string, unknown>): SessionResponseLike | undefined {
  const looksLikeResponse = (v: unknown): v is SessionResponseLike =>
    !!v && typeof v === "object" && typeof (v as { status?: unknown }).status === "number";

  if (looksLikeResponse(any.response)) return any.response;
  const parent = any.parent;
  if (parent && typeof parent === "object") {
    const pr = (parent as Record<string, unknown>).response;
    if (looksLikeResponse(pr)) return pr;
  }
  return undefined;
}

/**
 * Axios's own message for a non-2xx response, `"Request failed with status
 * code N"` — manufactured client-side before any body is read. It leaks out
 * whenever `abap-adt-api`'s `fromResponse()` fails to parse an
 * `<exc:exception>` envelope and degrades to `AdtHttpException`, whose
 * `message` is just `this.parent.message`. Names none of what SAP actually
 * sent; treating it as "the diagnostic" caused a live incident where
 * `TRANSPORT_ERROR: "Request failed with status code 400"` reached a caller
 * with nothing else to act on.
 */
const CONTENTLESS_HTTP_MESSAGE_RE = /^request failed with status code \d+$/i;

/**
 * Best-effort scrape for *some* text when the vendor parser already gave up:
 * tries a bare `<message>text</message>` element, then an ICM/ICF HTML page
 * stripped of markup via `htmlToLines`, then falls back to the whole body,
 * whitespace-collapsed and bounded. Returns `undefined` — never `""` — for an
 * empty/whitespace-only body, so the caller's own "no diagnostic body"
 * fallback fires instead.
 */
function scrapeResponseBodyText(body: string | undefined): string | undefined {
  const trimmed = typeof body === "string" ? body.trim() : "";
  if (!trimmed) return undefined;
  const tagged = /<(?:[\w-]+:)?message\b[^>]*>([^<]+)<\/(?:[\w-]+:)?message>/i.exec(trimmed);
  if (tagged?.[1]?.trim()) return tagged[1].trim();
  if (HTML_BODY_START_RE.test(trimmed)) {
    const fromHtml = htmlToLines(trimmed).join(" ").trim();
    if (fromHtml) return truncateText(fromHtml, MESSAGE_EXCERPT_MAX);
  }
  const collapsed = trimmed.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  // Must not cut silently — see the module header on truncateText (src/truncate.ts).
  return truncateText(collapsed, MESSAGE_EXCERPT_MAX);
}

export function adtExceptionInfo(e: unknown): AdtExceptionInfo | undefined {
  if (!e || typeof e !== "object") return undefined;
  const any = e as Record<string, unknown>;
  const hasShape =
    typeof any.err === "number" || typeof any.status === "number" || typeof any.type === "string";
  if (!hasShape) return undefined;

  const status =
    typeof any.err === "number" && any.err > 0
      ? any.err
      : typeof any.status === "number"
        ? any.status
        : undefined;

  // `.properties` is a plain own-enumerable field on `AdtErrorException`
  // (verified against the installed build); any other shape degrades to `{}`
  // rather than producing index-keyed junk from `Object.entries`.
  const propsCandidate: unknown = any.properties;
  const rawProps: Record<string, unknown> =
    typeof propsCandidate === "object" && propsCandidate !== null && !Array.isArray(propsCandidate)
      ? (propsCandidate as Record<string, unknown>)
      : {};
  const properties: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawProps)) {
    // LONGTEXT is a ~700-byte HTML blob — 70% of the payload and it says
    // nothing the short text doesn't. It never leaves this layer.
    if (/^LONGTEXT$/i.test(k)) continue;
    properties[k] = String(v ?? "");
  }

  const response = pickResponse(any);
  const rawMessage = describeUnknownError(e);
  // Only substitution made: a bare axios status-code sentence is swapped for
  // whatever can be scraped from the body, or an honest "no diagnostic body"
  // admission. Everything else passes through unchanged.
  const message = CONTENTLESS_HTTP_MESSAGE_RE.test(rawMessage.trim())
    ? (scrapeResponseBodyText(response?.body) ??
      `The ABAP system returned ${status ?? "an error"} with no diagnostic body.`)
    : rawMessage;

  return {
    status,
    type: typeof any.type === "string" && any.type ? any.type : undefined,
    message,
    properties,
    response,
  };
}

/**
 * ADT `<type id="…"/>` values meaning "the enqueue is held by a session that
 * is not this one", on their own at any status. Exactly one member:
 * `ExceptionResourceNoAccess`, confirmed live across five object types
 * (PROG/CLAS/TABL/DOMA/DTEL, Repository and DDIC) — say "five object types",
 * never "all object types"; INTF, FUGR, includes, CDS/DDLS, behavior
 * definitions and transport-level objects are untested.
 *
 * `ExceptionResourceInvalidLockHandle` deliberately does NOT belong here —
 * see `INVALID_LOCK_HANDLE_TYPE_IDS`.
 *
 * To extend: add a captured type id here only if the capture rules out a
 * genuine `S_DEVELOP` refusal sharing that id; if shared, leave this set
 * alone and let the T100/text tiers carry the case.
 */
const LOCK_CONFLICT_TYPE_IDS = new Set<string>(["ExceptionResourceNoAccess"]);

/**
 * ADT `<type id="…"/>` values meaning "**our own** lock handle is wrong" —
 * the opposite of a conflict. Confirmed live: a PUT with a bogus
 * `lockHandle` returns `423 ExceptionResourceInvalidLockHandle`,
 * `"Resource INCLUDE ZMCPX_P1 is not locked (invalid lock handle: …)"` — the
 * same answer whether the object is unlocked or genuinely locked by someone
 * else, since the server rejected the handle, not the question of who holds it.
 *
 * Must never be classified `LOCKED`: nobody is necessarily holding anything,
 * and the `LOCKED` hint would send the reader hunting a blocker that doesn't
 * exist. Surfaced as `ADT_ERROR` with `details.reason === "INVALID_LOCK_HANDLE"`
 * (see `translateAdtError`), not a new `AbapErrorCode`.
 *
 * The message is a trap twice over — "is **not** locked" reads like the
 * opposite of the truth, and it calls a PROG an `INCLUDE` — which is why the
 * rule here is **match on `T100KEY`, never on prose**, and why this negative
 * check runs before the T100/text tiers.
 */
const INVALID_LOCK_HANDLE_TYPE_IDS = new Set<string>(["ExceptionResourceInvalidLockHandle"]);

/**
 * `CX_SY_CASE_NOT_FOUND` surfacing through ADT: the ABAP handler ran into a
 * `CASE` with no matching `WHEN` and no `WHEN OTHERS`. Live-captured as a 400
 * `ExceptionInvalidData` whose `<message>` was exactly "Unexpected Case in
 * Branch" (`add_alternative_key`; also `test/bopf-trigger-fixes
 * .test.ts`'s determination-category case). Matched on message text — the
 * one string SAP actually sends is not localised in the captures seen so
 * far — with `info.type` containing `CASE_NOT_FOUND` accepted too, for a
 * release that names the exception class instead of the generic ADT prose.
 */
const UNHANDLED_CASE_RE = /unexpected case in branch/i;
const CASE_NOT_FOUND_TYPE_RE = /CASE_NOT_FOUND/i;

/**
 * HTTP statuses on which the corroborated lock tiers (T100 EU-510, or
 * "currently editing" text) are allowed to fire. 403 is the only status a
 * lock conflict has ever been observed with (five-for-five across
 * PROG/CLAS/TABL/DOMA/DTEL).
 *
 * 409/423 are forward-compat slots only: 409 has never been seen; 423 HAS
 * been seen but for `ExceptionResourceInvalidLockHandle`, which is NOT a
 * conflict — `isLockConflict` rejects that type id before any status-gated
 * tier looks at it. Widening this set is safe only because a status never
 * decides anything alone; it just buys the right to be asked for evidence.
 */
const LOCK_CONFLICT_STATUSES = new Set<number>([403, 409, 423]);

/**
 * `403` + `ExceptionResourceNoAccess` (confirmed across five object types,
 * see `LOCK_CONFLICT_TYPE_IDS`) OR a `403` whose message says "is currently
 * editing", regardless of type id.
 *
 * "Lock conflict" means the enqueue is held by a SESSION that is not this
 * request's session — not necessarily another user. Live capture: the
 * envelope was produced by the SAME user's own second session, and
 * re-locking in the SAME session is also not idempotent and returns the
 * identical envelope shape. The status/envelope alone can't distinguish
 * another person, another session of yours, or a lock this session already
 * holds — only our own ledger can, which is why `lock()` answers a re-lock
 * from the ledger rather than asking the server.
 *
 * The text-match branch (last tier, corroborating only — never decides
 * alone) closes a gap where `ExceptionResourceNoAuthorization` with an EMPTY
 * `<properties/>` is ALSO the type id for a genuine missing-authorization
 * refusal; without corroboration this would misreport an auth failure as a
 * lock, or vice versa. Match on `T100KEY`, never on prose — the `423`
 * invalid-handle envelope calls a PROG an `INCLUDE`, so message text is not
 * contractual.
 *
 * INVARIANT: no known type id + no EU/510 + no corroborating text → `false`.
 * A bare 403 is CSRF/authorization, not a lock (see `src/adt/source.ts`,
 * `src/adt/ddic.ts`). Pinned by `test/session.test.ts:841`,
 * `test/source.test.ts:205-218`. Extend via a captured envelope + a table,
 * never by broadening `/currently editing/i`.
 */
export function isLockConflict(e: unknown): boolean {
  const info = adtExceptionInfo(e);
  if (!info) return false;
  // Tier 0, negative, first: an invalid lock handle is not a conflict, at
  // any status — ordered ahead of the T100 tier since it's never been shown
  // what properties (if any) that envelope carries.
  if (info.type && INVALID_LOCK_HANDLE_TYPE_IDS.has(info.type)) return false;
  // Tier 1 — a type id that means "locked" on its own, at any status.
  if (info.type && LOCK_CONFLICT_TYPE_IDS.has(info.type)) return true;
  // A status is a gate, never a verdict: everything below it must corroborate.
  if (info.status === undefined || !LOCK_CONFLICT_STATUSES.has(info.status)) return false;
  // Tier 2 — some releases only give the T100 key (message class EU, number 510).
  if (info.properties["T100KEY-ID"] === "EU" && info.properties["T100KEY-NO"] === "510") {
    return true;
  }
  // Tier 3, last resort: message text is the only signal left on some
  // releases (e.g. ExceptionResourceNoAuthorization with empty
  // <properties/>) — corroborating evidence only, never decided alone. Match
  // on `T100KEY`, never on prose (see doc comment).
  return /currently editing/i.test(info.message);
}

/** `404` + `ExceptionResourceNotFound` — three different messages, one meaning. */
export function isNotFoundError(e: unknown): boolean {
  const info = adtExceptionInfo(e);
  if (!info) return false;
  return info.status === 404 || info.type === "ExceptionResourceNotFound";
}

export interface ErrorContext {
  operation: string;
  uri?: string;
  name?: string;
  type?: string;
}

/**
 * Shared tail of the `LOCKED` hint (both branches, so they can't drift).
 * Every clause matters: the lock binds to a SESSION not a user (so the
 * reader doesn't go hunting a colleague), the "or even this one" clause
 * names the third possibility (re-locking your own held object returns the
 * same envelope), and "do NOT retry in a loop" is absolute — there is no
 * lock timeout while the holding session lives, and no SM12 pointer (that's
 * the lock-LEAK hint in `releaseLock`, not this one).
 */
const LOCK_HINT_TAIL =
  "Locks bind to a session (sap-contextid), not to a user: the holder may be another " +
  "session of yours, or even this one — re-locking an object you already hold returns " +
  "this same envelope. Do NOT retry in a loop; there is no lock timeout — the enqueue " +
  "clears only when the holding session releases it or ends. Close the other session " +
  "(another terminal, an Eclipse/SE80 editor), or work on a different object.";

/**
 * Translate anything `abap-adt-api` throws into a structured `AbapError`.
 * No raw ADT XML, no HTML blob, ever crosses this boundary.
 */
export function translateAdtError(e: unknown, ctx: ErrorContext): AbapError {
  if (e instanceof AbapError) return e;
  const info = adtExceptionInfo(e);

  // TRANSPORT death must be checked FIRST, before any
  // object-level verdict (lock, invalid handle, etc.) below. Two
  // independently-implemented classifiers — this function and
  // `classifySessionFailure` (already run by `AbapConnection.noteWireResponse`
  // on the same wire response) — used to disagree about identical bytes: one
  // called it "a lock", the other "a death". Death wins: `ICMENOSESSION`
  // fires before ABAP is even dispatched, so there is no enqueue to protect,
  // and reporting a dead-session response as a lock/invalid-handle problem
  // hid the death from `pool.ts`'s replay-on-fresh-session path.
  //
  // Bounded blast radius: `423` and `403` (the statuses the lock branches
  // own) can only be pre-empted by the HEADER tier of `classifySessionFailure`
  // (ungated by status), not by its body/prose tiers. `sessionDeathFromInfo`
  // below (body/prose only, no headers) is deliberately NOT hoisted here — it
  // has no header signal, so hoisting it could let lock-error prose steal the
  // verdict before the T100 tier corroborates.
  //
  // Guarded by `test/session-death-oracle.test.ts`, which runs both
  // classifiers over the same corpus and fails loudly on disagreement.
  const wireDeath = classifySessionFailure(info?.response);
  if (wireDeath) return sessionDeadError(wireDeath, ctx);

  // `AdtCsrfException` carries only `message`/`parent` — no `.err`/`.status`/
  // `.type`/`.properties` — so `adtExceptionInfo` returns undefined for it and
  // it would otherwise fall through to the unclassified tail below. The CSRF
  // gate refuses the request before the ABAP handler ever runs.
  if (isCsrfError(e)) {
    return new AbapError(
      "ADT_ERROR",
      `${describeUnknownError(e)} — the request was refused by the CSRF gate before it reached ` +
        `the ABAP handler, so nothing was applied.`,
      {
        operation: ctx.operation,
        uri: ctx.uri,
        name: ctx.name,
        type: ctx.type,
        reason: "csrf-token-rejected",
      },
      "This is a stale CSRF token, not a problem with the object, its name, or your authorisations. " +
        "Retry the same call once, unchanged — a fresh token is fetched automatically before the " +
        "resend. If the identical call fails the same way a second time, the token was not the cause.",
    );
  }

  if (isLockConflict(e) && info) {
    // `blockingUser` (T100 `V1`) names a USER, but since the lock is per
    // session not per user, that user may well be the caller themself —
    // nothing built from it may imply a different person.
    const blockingUser = info.properties["T100KEY-V1"] || undefined;
    const object = info.properties["T100KEY-V2"] || ctx.name;
    return new AbapError(
      "LOCKED",
      info.message ||
        `${object ?? "The object"} is locked by an ADT session` +
          `${blockingUser ? ` logged on as ${blockingUser}` : ""}.`,
      {
        operation: ctx.operation,
        uri: ctx.uri,
        object,
        blockingUser,
        adtExceptionType: info.type,
        t100: t100Key(info.properties),
      },
      // The hint's job is to stop a retry storm, not describe the error: no
      // lock timeout exists while the holding session lives, so no "try
      // again" phrasing, ever, and no SM12 pointer (that's the lock-LEAK
      // hint in `releaseLock`; `test/session.test.ts:533` pins this one
      // never says it). Both branches name a SESSION, never a person, and
      // both carry the third possibility that this very session already
      // holds it. Length is bounded: `test/session.test.ts:535` caps the
      // rendered JSON at 900 chars (measured 859 today — keep clauses short).
      blockingUser
        ? `The ADT enqueue on ${object ?? "this object"} is held by a session logged on as ` +
          `${blockingUser}. ${LOCK_HINT_TAIL}`
        : `The ADT enqueue on ${object ?? "this object"} is held by another session. ` +
          LOCK_HINT_TAIL,
    );
  }

  // 423 + `ExceptionResourceInvalidLockHandle` — confirmed live (two
  // captured instances). Deliberately NOT `LOCKED` (see
  // `INVALID_LOCK_HANDLE_TYPE_IDS`): nobody else need be holding anything.
  // Not a new `AbapErrorCode` either — discrimination lives in
  // `details.reason`, same convention `releaseLock` uses for "lock-leaked".
  if (info && info.type && INVALID_LOCK_HANDLE_TYPE_IDS.has(info.type)) {
    return new AbapError(
      "ADT_ERROR",
      info.message ||
        `The lock handle sent with this request is not valid for ${ctx.uri ?? "the object"}.`,
      {
        operation: ctx.operation,
        uri: ctx.uri,
        name: ctx.name,
        type: ctx.type,
        status: info.status,
        adtExceptionType: info.type,
        reason: "INVALID_LOCK_HANDLE",
        ...(Object.keys(info.properties).length ? { properties: info.properties } : {}),
      },
      "The lock handle is stale or wrong — the server rejected the handle, not the caller, " +
        "so this says nothing about anyone else holding the object. It is a client bug or a " +
        "session that was recycled: a handle is meaningful only inside the session that " +
        "obtained it, and only while that session lives. Retrying with the same handle cannot " +
        "succeed. Take a fresh lock and use the handle that LOCK returns.",
    );
  }

  // The response-based check already ran at the top of this function (see
  // comment there for why `sessionDeathFromInfo` didn't move with it) — this
  // is the body/prose-only fallback for throws with no `.response` at all.
  const death = sessionDeathFromInfo(info);
  if (death) return sessionDeadError(death, ctx);

  if (isNotFoundError(e)) {
    return new AbapError(
      "NOT_FOUND",
      info?.message || `${ctx.name ?? ctx.uri ?? "Object"} does not exist.`,
      { operation: ctx.operation, uri: ctx.uri, name: ctx.name, type: ctx.type },
      "Check the name with abap_search, or create the object first.",
    );
  }

  // `CX_SY_CASE_NOT_FOUND` reaching ADT — not a new `AbapErrorCode`, same
  // convention as `INVALID_LOCK_HANDLE` above: discrimination lives in
  // `details.reason`.
  if (info && (UNHANDLED_CASE_RE.test(info.message) || (info.type && CASE_NOT_FOUND_TYPE_RE.test(info.type)))) {
    return new AbapError(
      "ADT_ERROR",
      info.message || describeUnknownError(e),
      {
        operation: ctx.operation,
        uri: ctx.uri,
        name: ctx.name,
        type: ctx.type,
        status: info.status,
        adtExceptionType: info.type,
        reason: "UNHANDLED_CASE",
        ...(Object.keys(info.properties).length ? { properties: info.properties } : {}),
      },
      "The ABAP handler hit a CASE statement with no matching WHEN and no WHEN OTHERS " +
        "(CX_SY_CASE_NOT_FOUND) — the server could not map a value this request sent. This is " +
        "not a lock, not an authorisation problem and not a missing object, so retrying the " +
        "identical request cannot change the answer. The unmapped value is almost always a " +
        "coded/enum field in the payload: check every closed-enum field of the request against " +
        "the values the object model actually accepts. In BOPF this is typically " +
        "`/BOBF/CL_CONF_MODEL_API_MAP` failing to map a model attribute, where the same " +
        "condition can instead surface as an ASSERTION_FAILED short dump that destroys the session.",
    );
  }

  const unclassifiedMessage = info?.message || describeUnknownError(e);
  const unclassifiedProperties = info?.properties ?? {};

  // `adt-message-rules.ts` names known-shape SAP refusals that reach this
  // catch-all (e.g. TR/462, "may not be assigned to software component") —
  // checked before the generic envelope below is built, so a recognised
  // message gets its own hint instead of the "not diagnosed" admission.
  const classified = classifyAdtMessage(unclassifiedMessage, unclassifiedProperties);
  if (classified) {
    return new AbapError(
      "ADT_ERROR",
      unclassifiedMessage,
      {
        operation: ctx.operation,
        uri: ctx.uri,
        name: ctx.name,
        type: ctx.type,
        status: info?.status,
        adtExceptionType: info?.type,
        ...(Object.keys(unclassifiedProperties).length ? { properties: unclassifiedProperties } : {}),
        classifiedBy: classified.id,
      },
      classified.hint,
    );
  }

  return new AbapError(
    "ADT_ERROR",
    unclassifiedMessage,
    {
      operation: ctx.operation,
      uri: ctx.uri,
      name: ctx.name,
      type: ctx.type,
      status: info?.status,
      adtExceptionType: info?.type,
      ...(Object.keys(unclassifiedProperties).length ? { properties: unclassifiedProperties } : {}),
      // Instrumentation, not diagnosis: makes "how often does this
      // unrecognised branch fire, and on which messages" countable/groupable
      // from a run's recorded tool output (see unclassifiedMessageKey).
      unclassified: true,
      unclassifiedKey: unclassifiedMessageKey(unclassifiedProperties),
    },
    // Catch-all: every named shape (lock, invalid handle, dead session, 404)
    // has already been peeled off above. Reaching here means UNCLASSIFIED,
    // not diagnosed — the hint below points at `adt.localizedMessage`/
    // `adt.t100` in the tool result rather than restating `message` (see
    // `CONTENTLESS_HTTP_MESSAGE_RE` for the live incident this fixes).
    //
    // Deliberately does NOT suggest checking abap_search for a missing
    // object: `test/source.test.ts`'s C1 guard caught an earlier draft doing
    // that, because misreading unrelated failures (500, 401) as "object not
    // there" was exactly the bug being fixed. Only `NOT_FOUND`, which has
    // actually established that, points at abap_search.
    "This ADT response was not recognised by any specific rule here, so nothing about it has " +
      "actually been diagnosed. Check the `adt` block in the tool result: `adt.localizedMessage` " +
      "and `adt.t100` (id/no/variables) carry what SAP sent verbatim and are usually more specific " +
      "than the message above. If they name an authorisation, this is a missing S_DEVELOP-class " +
      "permission, not a bug in the request. Do not retry unchanged — an unrecognised response " +
      "will not resolve itself on a second try.",
  );
}

/** The message-class key, when the server bothered to send one. */
function t100Key(props: Record<string, string>): Record<string, string> | undefined {
  const entries = Object.entries(props).filter(([k]) => k.startsWith("T100KEY-"));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * When the exception carries no response object, `.err` and the short text
 * are enough for the two dead-session shapes — the header tier can't fire
 * here (no headers), so message/marker tiers are the whole classifier
 * (`test/source.test.ts:78`'s shape). Exported so other classifiers
 * built on `adtExceptionInfo` (`ctsError` in transports.ts above all) can run
 * the same two-tier check as `translateAdtError`
 * (`classifySessionFailure(info?.response) ?? sessionDeathFromInfo(info)`)
 * instead of falling through to a session-death-blind generic error.
 */
export function sessionDeathFromInfo(info: AdtExceptionInfo | undefined): SessionFailureKind | undefined {
  if (!info) return undefined;
  return classifySessionFailure({ status: info.status ?? 0, body: info.message });
}

export function sessionDeadError(kind: SessionFailureKind, ctx: ErrorContext): AbapError {
  return new AbapError(
    "SESSION_DEAD",
    kind === "dump"
      ? "The ABAP session was destroyed by a short dump."
      : "The ABAP session no longer exists (400 Session Timed Out).",
    { operation: ctx.operation, uri: ctx.uri, name: ctx.name, kind },
    "Every lock the session held is already released. The connection re-establishes " +
      "a session on the next request — retry the operation once. This is NOT an " +
      "authentication failure and does not count against the logon-attempt budget.",
  );
}

// ---------------------------------------------------------------------------
// The session itself
// ---------------------------------------------------------------------------

export interface StatefulSessionOptions {
  log?: (msg: string) => void;
  /**
   * How many times a failed UNLOCK is retried before the lock is declared
   * leaked. Total attempts = `1 + unlockRetries`. Default 2 (three attempts).
   */
  unlockRetries?: number;
  /** Base backoff between UNLOCK attempts, ms; multiplied by the attempt number. Default {@link UNLOCK_RETRY_DELAY_MS} (150). */
  unlockRetryDelayMs?: number;
  /**
   * Wall-clock ceiling on one `releaseLock()`, backoff included. No NEW unlock
   * attempt starts once it is spent. Default `UNLOCK_BUDGET_MS` (5 s) — see
   * that constant for why an attempt-count budget is not a latency budget.
   */
  unlockBudgetMs?: number;
  /** Injected by tests so the retry backoff costs no wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * D5(a) — true once the auth breaker has permanently latched. Checked at
   * the top of every UNLOCK retry: once tripped, `releaseLock()` stops
   * immediately rather than burning calls the breaker will refuse anyway,
   * and falls through to "lock leaked" escalation as if retries were
   * exhausted. Plain callback, not an `AuthCircuitBreaker` import (see the
   * LAYERING NOTE at the top of this file). Default: always false.
   */
  isBreakerTripped?: () => boolean;
  /**
   * Escalation sink for a lock that could NOT be released — see `unlock`.
   * Invoked once per leaked lock, from BOTH `unlock()` and `unlockAll()`, so a
   * write journal can record the leak even on the cleanup path where
   * `unlockAll()` deliberately does not throw.
   */
  onLockLeak?: (err: AbapError) => void;
}

/**
 * `setTimeout`, but `unref`'d: a pending unlock backoff must never be the
 * reason the process is still alive at shutdown (`connection.ts` gives the
 * whole shutdown 5 s before it forces exit).
 */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const t: unknown = setTimeout(resolve, ms);
    (t as { unref?: () => void })?.unref?.();
  });

/**
 * UNLOCK failures that are NOT a leak — the enqueue is not ours to release
 * any more, so nothing is retried or escalated:
 *  - `SESSION_DEAD` — dropping the session releases every lock it held
 *  - `NOT_FOUND` — the object is gone, so is its enqueue
 *  - `LOCKED` — a DIFFERENT session holds it now; retrying can't change that
 *    (without this, a lock-conflict 403 on UNLOCK burned 3 requests for no
 *    reason — see `connection.ts`'s "ONE POST. NO RETRY" note)
 *
 * Only add a code here if a repeat UNLOCK is provably pointless — anything
 * that might succeed on retry must stay out, or a real leak becomes a log line.
 */
const UNLOCK_NOT_A_LEAK = new Set<AbapErrorCode>(["SESSION_DEAD", "NOT_FOUND", "LOCKED"]);

/**
 * LOCK failures excluded from `suspectedEnqueues`: SAP demonstrably did not
 * hand us an enqueue. `LOCKED` means someone else already holds it; `NOT_FOUND`
 * means there was never an object to enqueue. Every other failure — including
 * a `200` with no `LOCK_HANDLE`, the strongest case, since SAP accepted the
 * request and gave us nothing to release it with — is recorded.
 */
const LOCK_FAILURE_NOT_SUSPECT = new Set<AbapErrorCode>(["LOCKED", "NOT_FOUND"]);

/**
 * Wall-clock ceiling on ONE `releaseLock()`, retries and backoff included.
 *
 * Without this cap, three UNLOCK attempts against an appliance that stopped
 * answering cost `3 × cfg.timeoutMs(60_000) + 150 + 300 = 180_450 ms` (~3
 * minutes) parked in a `finally`, after the write it guarded already
 * succeeded — invisible in tests, which measure ~460 ms against a fake
 * transport that answers instantly. With the budget the worst case becomes
 * one unavoidable attempt + `UNLOCK_BUDGET_MS` ≈ 65 s.
 *
 * The budget gates *starting* another unlock; an in-flight UNLOCK is never
 * abandoned — cutting one short to report a leak would invent a leak that
 * doesn't exist.
 *
 * 5 s is chosen so a healthy system's third attempt (worst case ~3.45 s: 1.5
 * + 0.15 + 1.5 + 0.3) always fits inside it; it only bites when the
 * appliance has actually stopped answering.
 */
const UNLOCK_BUDGET_MS = 5_000;

/**
 * Base backoff between UNLOCK attempts, multiplied by attempt number. Not
 * free-floating: the "450 ms" retry-loop total and the "3.45 s" in
 * {@link UNLOCK_BUDGET_MS} are both computed from this (150×1 + 150×2).
 */
const UNLOCK_RETRY_DELAY_MS = 150;

/**
 * Strip `/source/main`, includes, query and fragment: locks are taken on the
 * *object* URI, never on the source URI. Callers routinely have the latter.
 */
export function objectUriOf(uri: string): string {
  return uri
    .replace(/[?#].*$/, "")
    .replace(/\/source\/main$/, "")
    .replace(/\/+$/, "");
}

/**
 * A stateful ADT session with a lock ledger.
 *
 * Instances are created and torn down exclusively by
 * `AbapConnection.withStatefulSession()`, which guarantees `unlockAll()` on
 * every exit path including process shutdown. Nothing else should construct
 * one — a leaked session leaks ABAP enqueues.
 */
export class StatefulSession implements SessionLike {
  readonly client: ADTClient;
  private readonly locks = new Map<string, LockInfo>();
  /**
   * One in-flight UNLOCK per object URI. This is what makes "never unlock the
   * same handle twice" true *without* deleting the ledger entry up front: a
   * concurrent `unlock()` / `unlockAll()` for the same URI joins the promise
   * that is already running instead of firing a second UNLOCK.
   */
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Locks this session failed to release. See `leakedLocks`. */
  private readonly leaked: AbapError[] = [];
  /** URIs from LOCK attempts that may have taken an enqueue we have no handle for. See `suspectedEnqueues`. */
  private readonly suspected: string[] = [];
  /** LOCK attempts rejected as already-held, with the blocking user named. See `lockConflicts`. */
  private readonly conflicts: { uri: string; blockingUser: string }[] = [];
  private readonly log: (msg: string) => void;
  private readonly unlockRetries: number;
  private readonly unlockRetryDelayMs: number;
  private readonly unlockBudgetMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onLockLeak?: (err: AbapError) => void;
  private readonly isBreakerTripped: () => boolean;
  private ended = false;

  constructor(client: ADTClient, opts: StatefulSessionOptions = {}) {
    this.client = client;
    this.log = opts.log ?? ((m) => process.stderr.write(m + "\n"));
    this.unlockRetries = Math.max(0, opts.unlockRetries ?? 2);
    this.unlockRetryDelayMs = Math.max(0, opts.unlockRetryDelayMs ?? UNLOCK_RETRY_DELAY_MS);
    this.unlockBudgetMs = Math.max(0, opts.unlockBudgetMs ?? UNLOCK_BUDGET_MS);
    this.sleep = opts.sleep ?? defaultSleep;
    this.onLockLeak = opts.onLockLeak;
    this.isBreakerTripped = opts.isBreakerTripped ?? (() => false);
  }

  /** Insertion-ordered; `unlockAll` releases in reverse. */
  get heldLocks(): readonly LockInfo[] {
    return [...this.locks.values()];
  }

  /**
   * Escalations for locks that could not be released, in fail order.
   * `unlockAll()` cannot throw, so this — plus `onLockLeak` and the log — is
   * how a leak becomes visible on the cleanup path. Non-empty means an
   * object stays enqueued until this process exits.
   */
  get leakedLocks(): readonly AbapError[] {
    return [...this.leaked];
  }

  /**
   * Object URIs whose LOCK attempt failed in a way that may still have taken
   * the enqueue server-side, with no local handle to release it. Recording
   * is biased toward over-inclusion on purpose: a false positive costs one
   * extra `dropSession()` on an already-failing call, a false negative
   * strands the enqueue for the life of the process. See `lock()`.
   */
  get suspectedEnqueues(): readonly string[] {
    return [...this.suspected];
  }

  /**
   * LOCK attempts rejected as `LOCKED` where SAP named the blocking user
   * (T100 `V1`). This session deliberately does not know the logged-in
   * username, so it cannot say whether that user is *us* — it only records
   * the fact for `AbapConnection.withStatefulSession()`, which does know,
   * to decide whether ending this session might clear the object's own
   * self-block.
   */
  get lockConflicts(): readonly { uri: string; blockingUser: string }[] {
    return [...this.conflicts];
  }

  /**
   * `POST {uri}?_action=LOCK&accessMode=MODIFY`.
   *
   * Re-locking an object we already hold is answered from the ledger, not
   * the wire — REQUIRED, not an optimisation: live capture shows re-locking
   * the same object in the same session is NOT idempotent, returning `403
   * ExceptionResourceNoAccess` with the same "is currently editing" message
   * a genuine cross-session conflict produces. A status code alone can't
   * tell "I already hold this" from "someone else holds this"; only our own
   * ledger can. (Uncaptured: whether the original handle survives a refused
   * re-lock attempt — code must not assume either way; the ledger
   * short-circuit sidesteps the question by never re-locking over the wire.)
   */
  /**
   * `opts.accept`, when given, overrides the LOCK request's `Accept` header
   * and routes through `this.client.httpClient.request()` instead of the
   * vendor's `lock()` wrapper, which hard-codes lowercase
   * `dataname=com.sap.adt.lock.result`. BOPF's working lock uses capital-R
   * `Result` (untested lowercase, not known-broken). Response fields are
   * parsed by hand (`extractLockField`) since the vendor's parser is
   * internal/unexported. With no `opts.accept`, behavior is byte-identical
   * to before (exercised by `test/session-lock.test.ts`).
   */
  async lock(uri: string, opts?: { accept?: string }): Promise<LockInfo> {
    const objectUri = objectUriOf(uri);
    const held = this.locks.get(objectUri);
    if (held) return held;
    this.assertLive("lock");

    let info: LockInfo;
    try {
      info = opts?.accept
        ? await this.lockWithAccept(objectUri, opts.accept)
        : await this.lockDefault(objectUri);
    } catch (e) {
      if (!(e instanceof AbapError) || !LOCK_FAILURE_NOT_SUSPECT.has(e.code)) {
        this.suspected.push(objectUri);
      }
      if (e instanceof AbapError && e.code === "LOCKED" && typeof e.details.blockingUser === "string") {
        this.conflicts.push({ uri: objectUri, blockingUser: e.details.blockingUser });
      }
      throw e;
    }
    this.locks.set(objectUri, info);
    return info;
  }

  /** The original, untouched path: `this.client.lock()`, lowercase `result` Accept. */
  private async lockDefault(objectUri: string): Promise<LockInfo> {
    let raw: AdtLock;
    try {
      raw = await this.client.lock(objectUri, "MODIFY");
    } catch (e) {
      throw translateAdtError(e, { operation: "lock", uri: objectUri });
    }

    const handle = raw?.LOCK_HANDLE === undefined ? "" : String(raw.LOCK_HANDLE);
    if (!handle) {
      throw new AbapError(
        "ADT_ERROR",
        "The ABAP system accepted the LOCK request but returned no LOCK_HANDLE.",
        { uri: objectUri },
        "Without a handle no source can be written. Retry; if it persists the " +
          "object type may not be lockable on this release.",
      );
    }

    return {
      uri: objectUri,
      handle,
      // `IS_LOCAL = X` ⇒ a $TMP/local object, no transport required.
      isLocal: /^\s*X\s*$/i.test(String(raw.IS_LOCAL ?? "")),
      corrNr: blankToUndefined(raw.CORRNR),
      corrUser: blankToUndefined(raw.CORRUSER),
      corrText: blankToUndefined(raw.CORRTEXT),
    };
  }

  /** The `accept`-override path: same request shape, our own header and body parsing. */
  private async lockWithAccept(objectUri: string, accept: string): Promise<LockInfo> {
    let body: string;
    try {
      const resp = await this.client.httpClient.request(objectUri, {
        method: "POST",
        qs: { _action: "LOCK", accessMode: "MODIFY" },
        headers: { Accept: accept },
      });
      body = resp.body;
    } catch (e) {
      throw translateAdtError(e, { operation: "lock", uri: objectUri });
    }

    const handle = extractLockField(body, "LOCK_HANDLE") ?? "";
    if (!handle) {
      throw new AbapError(
        "ADT_ERROR",
        "The ABAP system accepted the LOCK request but returned no LOCK_HANDLE.",
        { uri: objectUri, accept },
        "Without a handle no source can be written. Retry; if it persists the " +
          "object type may not be lockable on this release.",
      );
    }

    return {
      uri: objectUri,
      handle,
      isLocal: /^\s*X\s*$/i.test(extractLockField(body, "IS_LOCAL") ?? ""),
      corrNr: blankToUndefined(extractLockField(body, "CORRNR")),
      corrUser: blankToUndefined(extractLockField(body, "CORRUSER")),
      corrText: blankToUndefined(extractLockField(body, "CORRTEXT")),
    };
  }

  /**
   * `POST {uri}?_action=UNLOCK&lockHandle=…`.
   *
   * Idempotent (a bogus handle also returns `200`, empty body — see the file
   * header) but **not** non-throwing: a failed UNLOCK is retried
   * (`unlockRetries`) and, if still failing, escalated as `AbapError`.
   *
   * CORRECTED FINDING: UNLOCK's status code carries NO information about
   * whether a real lock was released — this used to be read backwards ("a
   * best-effort UNLOCK in a `finally` cannot mask an error", taken as
   * reassurance). A best-effort UNLOCK in a `finally`/shutdown hook is
   * harmless (cannot fail loudly), but harmless is not safe: nothing here may
   * infer "released" from a `200`. The ledger delete below is correct
   * because the handle sent is always the one THIS session's own LOCK
   * returned for THIS object, not because of the status.
   *
   * `SESSION_DEAD`, `NOT_FOUND` and `LOCKED` are NOT leaks (see
   * `UNLOCK_NOT_A_LEAK`) — in none of them is the enqueue still ours to
   * release, so none is retried or escalated.
   *
   * Swallowing a failed UNLOCK used to be justified by "the lock dies with
   * the session anyway", which is false for a long-lived MCP server: the
   * enqueue would be stranded, locking the object against every other user
   * including SE80, for the life of the process.
   *
   * @throws {AbapError} `ADT_ERROR` with `details.reason === "lock-leaked"`.
   */
  async unlock(uri: string): Promise<void> {
    const objectUri = objectUriOf(uri);
    const pending = this.inFlight.get(objectUri);
    if (pending) return pending;
    const info = this.locks.get(objectUri);
    if (!info) return;
    // NB: the ledger entry stays put until the outcome is known — a retry needs
    // the handle. Double-unlock is prevented by `inFlight`, not by amnesia.
    const run = this.releaseLock(info);
    this.inFlight.set(objectUri, run);
    try {
      await run;
    } finally {
      this.inFlight.delete(objectUri);
    }
  }

  /**
   * Bounded retry around one UNLOCK, then escalation.
   *
   * Termination is guaranteed three times over: the loop is bounded by
   * `unlockRetries`, by `unlockBudgetMs` of wall clock (`UNLOCK_BUDGET_MS` —
   * the attempt count alone bounds *requests*, not *seconds*), and every exit
   * path — success, already-released, leak — deletes the ledger entry, so
   * neither `unlockAll()` nor a caller retrying `unlock()` can spin on the same
   * handle.
   */
  private async releaseLock(info: LockInfo): Promise<void> {
    const attempts = 1 + this.unlockRetries;
    const startedAt = Date.now();
    let last = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (this.isBreakerTripped()) {
        last =
          last ||
          "the auth circuit breaker latched during retry — no further authenticated " +
            "requests are permitted";
        break;
      }
      try {
        await this.client.unLock(info.uri, info.handle);
        // Dropped because THIS handle has now been spent, not because the
        // server said `200` (a garbage handle gets the identical answer) —
        // soundness comes from provenance, never from status.
        this.locks.delete(info.uri);
        return;
      } catch (e) {
        last = describeUnknownError(e);
        const translated = translateAdtError(e, { operation: "unlock", uri: info.uri });
        if (UNLOCK_NOT_A_LEAK.has(translated.code)) {
          this.locks.delete(info.uri);
          // Same disposition, different truths: SESSION_DEAD/NOT_FOUND means
          // the enqueue is gone; LOCKED means it isn't ours, not that it's gone.
          this.log(
            translated.code === "LOCKED"
              ? `[abapsmith] unlock of ${info.uri} was refused (LOCKED) — the enqueue is ` +
                  `held by another session and is not ours to release; not retried, ` +
                  `because a retry cannot change that answer.`
              : `[abapsmith] unlock of ${info.uri} was unnecessary (${translated.code}) — ` +
                  `the enqueue is already gone.`,
          );
          return;
        }
        if (attempt < attempts) {
          // `left` is measured from the first attempt, so a slow UNLOCK —
          // not just a slow backoff — consumes the budget (see `UNLOCK_BUDGET_MS`).
          const left = this.unlockBudgetMs - (Date.now() - startedAt);
          if (left <= 0) {
            last =
              `${last} — gave up after ${attempt} of ${attempts} attempts: the ` +
              `${this.unlockBudgetMs} ms unlock budget was spent, and a further attempt ` +
              `would have made the caller wait longer than it can be worth`;
            break;
          }
          // Never sleep past the deadline either; the clamp is what keeps the
          // ceiling at "budget + one attempt" instead of "budget + backoff + one
          // attempt".
          await this.sleep(Math.min(this.unlockRetryDelayMs * attempt, left));
        }
      }
    }

    this.locks.delete(info.uri);
    const err = new AbapError(
      "ADT_ERROR",
      `Failed to release the ABAP lock on ${info.uri} after ${attempts} attempts. ` +
        `The enqueue is still held by this session: ${last}`,
      {
        operation: "unlock",
        reason: "lock-leaked",
        uri: info.uri,
        lockHandle: info.handle,
        attempts,
        cause: last,
      },
      `abapsmith discards this session's sap-contextid as soon as the stateful call ` +
        `ends, which normally releases the enqueue immediately — no restart needed. If ` +
        `that drop also fails, the object stays locked against every other user (SE80 ` +
        `included) until it is released manually in transaction SM12 or the process exits.`,
    );
    this.leaked.push(err);
    this.log(`[abapsmith] LOCK LEAKED: ${err.message}`);
    // Guarded: a throwing sink must not become a second failure on a path that
    // may be running inside a `finally` or a shutdown hook.
    try {
      this.onLockLeak?.(err);
    } catch {
      /* the sink's problem, not ours */
    }
    throw err;
  }

  /**
   * Release everything still held, newest first. Attempts every lock (one
   * leak doesn't stop the loop) and does NOT throw — deliberately, not just
   * "best effort": `connection.ts` awaits this in a `finally` and as a
   * shutdown hook, and a throw here would replace the caller's real error,
   * skip cleanup (`markEnded()`, clearing `activeSession`, etc., bricking
   * every later `withStatefulSession()` with "nested sessions"), and could
   * block shutdown. Escalation instead goes to `leakedLocks`, `onLockLeak`
   * and the log — see `unlock`, which does throw for callers that can act.
   */
  async unlockAll(): Promise<void> {
    const uris = [...this.locks.keys()].reverse();
    for (const uri of uris) {
      try {
        await this.unlock(uri);
      } catch {
        // Already recorded on `leakedLocks` and pushed to `onLockLeak` by
        // `releaseLock`. Swallowed HERE, and only here, for the reasons above.
      }
    }
  }

  /**
   * Forget a lock without sending UNLOCK — used after a successful DELETE,
   * where the object (and its enqueue) is already gone, so UNLOCK would just
   * be a wasted request against a 404. Symmetric with `releaseLock`'s
   * reading of a `200`: neither sending nor omitting UNLOCK is what frees
   * the enqueue here — the DELETE is.
   *
   * ⚠️ HAZARD, not reachable today: this is the only method that drops a
   * ledger entry without cancelling anything in flight. If a `releaseLock`
   * retry loop for URI U were interleaved with `forgetLock(U)` followed by a
   * fresh `lock(U)`, the retry loop's next attempt would send a spent handle
   * at a live enqueue, and `releaseLock`'s terminal ledger delete would then
   * also delete the fresh lock — the UNTESTED "bogus handle on a genuinely
   * held lock" case from the file header. Not reachable because every
   * `unlock()` is awaited before the next lock/unlock on a session,
   * `inFlight` collapses concurrent unlocks of one URI, and none of the four
   * call sites (`src/adt/write.ts`) re-locks the same URI afterwards. Before
   * adding a lock → forget → re-lock caller, this method must first learn to
   * fence the in-flight release.
   */
  forgetLock(uri: string): void {
    this.locks.delete(objectUriOf(uri));
  }

  /** Called by the connection when the session ends. */
  markEnded(): void {
    this.ended = true;
  }

  private assertLive(operation: string): void {
    if (!this.ended) return;
    throw new AbapError(
      "UNSUPPORTED",
      `Cannot ${operation}: this stateful session has already been closed.`,
      { operation },
      "Run the operation inside AbapConnection.withStatefulSession().",
    );
  }
}

const blankToUndefined = (v: unknown): string | undefined => {
  const s = v === undefined || v === null ? "" : String(v).trim();
  return s.length ? s : undefined;
};

/**
 * Pulls `<TAG>value</TAG>` out of the LOCK response's
 * `<asx:abap><asx:values><DATA>…</DATA></asx:values></asx:abap>` body by
 * hand — used only by `StatefulSession.lockWithAccept`, where the
 * vendor's own (unexported) `parse`/`xmlArray` helpers are not reachable.
 * Handles a self-closing `<TAG/>` (empty value) and a normal
 * `<TAG>…</TAG>` pair; returns `undefined` when the tag is absent. Not a
 * general XML parser — deliberately narrow to this one small, known shape.
 */
function extractLockField(body: string, tag: string): string | undefined {
  const empty = new RegExp(`<${tag}\\s*/>`, "i");
  if (empty.test(body)) return "";
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(body);
  return m ? m[1] : undefined;
}
