/**
 * Tool error envelope — translates a thrown value into an MCP payload.
 * Split out of `src/server.ts` (composition root); `buildErrorPayload` and
 * `errorResult` are re-exported from there, which is still where callers import them from.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AbapError,
  type AbapErrorCode,
  describeUnknownError,
  isAbapError,
} from "./adt/errors.js";
import {
  adtExceptionInfo,
  classifySessionFailure,
  isLockConflict,
  isNotFoundError,
} from "./adt/session.js";
import { BODY_DUMP_DIR_ENV } from "./error-capture.js";
import { truncateText } from "./truncate.js";

// ---------------------------------------------------------------------------
// The error envelope
// ---------------------------------------------------------------------------
// Every non-AbapError throw used to flatten to {error:"ADT_ERROR", message},
// discarding HTTP status, exception type, T100 key, lock owner, subType —
// making a lock conflict indistinguishable from a syntax error. This module
// restores that structure, under two rules:
//  1. No raw ADT body, ever — bodies go to ABAPSMITH_BODY_DUMP_DIR (see
//     src/error-capture.ts), never into model context.
//  2. Bounded — capped size, sheds the residual property bag first.
// `message`/`hint` are prose; `adt` is for branching; `summary` is the one
// derived sentence for the single most actionable fact.
// `retryable` is present only when the refusal is permanent; absence is not a claim.

/** Hard ceiling on one serialised error envelope. ~1k tokens, not 40k. */
const MAX_ERROR_ENVELOPE_CHARS = 4_000;
/** Per-property cap. ADT property values are short; anything long is a blob. */
const MAX_PROPERTY_VALUE_CHARS = 300;
/** How many residual properties survive. Real bodies carry ~15. */
const MAX_RESIDUAL_PROPERTIES = 24;
/** Last-resort cap on the prose message, applied only when already over budget. */
const MAX_MESSAGE_CHARS = 500;

/**
 * Property keys lifted out of the flat `<entry key="…">` bag into named fields.
 * Matched as plain strings, not against `abap-adt-api`'s `ExceptionProperties`
 * type, since real bodies carry keys it doesn't declare (e.g. `T100KEY-V1..V4`).
 * Anything unrecognised survives in `properties` rather than being dropped.
 */
const SUBTYPE_KEY = "com.sap.adt.communicationFramework.subType";
const PROMOTED_KEYS = new Set([SUBTYPE_KEY, "ideUser", "conflictText", "URI"]);

interface AdtEnvelope {
  /** HTTP status. Absent for a client-side precondition failure (`err === 0`). */
  status?: number;
  /** `<type id="…"/>`, e.g. `ExceptionResourceNoAccess`, `AdiFailed`. */
  exceptionType?: string;
  /** `<namespace id="…"/>`, e.g. `com.sap.adt`. */
  namespace?: string;
  /** Only when it differs from `message` — otherwise it is pure duplication. */
  localizedMessage?: string;
  /** Transport-level code from an `AdtHttpException`, e.g. `ECONNREFUSED`. */
  code?: string;
  /** SAP message class key: the stable identity of the message, unlike its text. */
  t100?: {
    id?: string;
    no?: string;
    variables?: Record<string, string>;
    /** Derived; never replaces `variables`. See `reassembleSplitT100Variables`. */
    reassembled?: T100Reassembly[];
  };
  /** Which ADT operation the framework was running, e.g. `getStack`. */
  subType?: string;
  /** Enqueue-conflict detail, when the server named the holder. */
  lock?: { ideUser?: string; conflictText?: string; blockingUser?: string };
  transport?: string;
  uri?: string;
  /** Everything not promoted above, bounded. */
  properties?: Record<string, string>;
  /** Set when the bag was shed or clipped to stay inside the budget. */
  omitted?: string;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

/** One reconstructed T100 parameter, spliced back from consecutive MSGV fragments. */
interface T100Reassembly {
  /** Which `variables` keys were concatenated, in order, e.g. `["v1", "v2"]`. */
  from: string[];
  /** The rejoined text — the raw fragments concatenated with no separator. */
  value: string;
}

/**
 * Undo SAP's T100 message-variable splitting: MSGV1..MSGV4 (T100KEY-V1..V4)
 * are fixed-width 50-char fields, so a value longer than 50 chars is chopped
 * with no separator and the remainder spills into the next slot. A variable
 * is treated as a chopped fragment ONLY when it is exactly 50 chars — never
 * shorter — to avoid fabricating a join that never existed. Consecutive
 * 50-char variables chain (v1+v2+v3+v4 max) until a non-50-char remainder
 * or the end of the list. See the git history for the
 * confirmed live example this was built against.
 */
function reassembleSplitT100Variables(vars: Record<string, string>): T100Reassembly[] {
  const order = ["v1", "v2", "v3", "v4"];
  const results: T100Reassembly[] = [];
  const consumed = new Set<string>();

  for (let i = 0; i < order.length; i++) {
    const startKey = order[i] as string;
    if (consumed.has(startKey)) continue;
    const startValue = vars[startKey];
    // Not exactly 50 chars: provably not a chopped fragment.
    if (startValue === undefined || startValue.length !== 50) continue;

    const from = [startKey];
    let value = startValue;
    let previousWasFullWidth = true; // startValue is 50 chars by the check above
    for (let j = i + 1; j < order.length && previousWasFullWidth; j++) {
      const nextKey = order[j] as string;
      const nextValue = vars[nextKey];
      // No next fragment: chain ends rather than inventing a continuation.
      if (nextValue === undefined) break;
      from.push(nextKey);
      value += nextValue;
      consumed.add(nextKey);
      // Full 50-char slot: SAP may have chopped again; anything shorter is the true tail.
      previousWasFullWidth = nextValue.length === 50;
    }

    // Lone 50-char value with no successor: not a detected split.
    if (from.length > 1) results.push({ from, value });
  }

  return results;
}

/** ADT's literal T100 long text for SAP message XT465. See {@link matchXt465ChoppedTemplate}. */
const XT465_TEMPLATE = /^Parameter (.+) not in version (.+) of tp configuration$/s;

/**
 * Fallback for when SAP returns a genuinely empty `<properties/>` bag (no
 * T100KEY-* at all) but the message text still has the XT465 chop shape —
 * confirmed live, see archive. Recognises exactly ONE literal template
 * (SAP message XT465); does not generalise to arbitrary templates, since the
 * rendered text alone can't reliably reveal which message class or chop
 * point produced it. Add a new narrow, fixture-backed sibling for any other
 * template needing this, rather than loosening this regex or the 50-char gate.
 * Verified against both a corrupted (50-char) and a legitimate (3-char, real
 * "LSM" value, test/fixtures/enhancement/543-xt465-tp-config-delete-400.xml)
 * capture — the second confirms the 50-char gate does NOT fire on a genuine
 * short value.
 *
 * Triple-gated by the caller (`withXt465Fallback`): only consulted when
 * `adt.t100` is unset, message must match the literal template, and group 1
 * must be exactly 50 chars.
 */
function matchXt465ChoppedTemplate(message: string): NonNullable<AdtEnvelope["t100"]> | undefined {
  const m = XT465_TEMPLATE.exec(message.trim());
  if (!m) return undefined;
  const v1 = m[1] as string;
  const v2 = m[2] as string;
  // Not exactly 50 chars: same rule as reassembleSplitT100Variables above.
  if (v1.length !== 50) return undefined;
  return {
    id: "XT",
    no: "465",
    variables: { v1, v2 },
    reassembled: [{ from: ["v1", "v2"], value: v1 + v2 }],
  };
}

/**
 * Folds {@link matchXt465ChoppedTemplate} into `adt`, never overwriting
 * existing `t100` data. Creates a bare `adt` object if there was none.
 */
function withXt465Fallback(adt: AdtEnvelope | undefined, message: string): AdtEnvelope | undefined {
  if (adt?.t100) return adt;
  const fallback = matchXt465ChoppedTemplate(message);
  if (!fallback) return adt;
  return { ...(adt ?? {}), t100: fallback };
}

/** Build the `adt` section from a flat ADT `<entry key>` property bag. */
function envelopeFromProperties(props: Record<string, string>): AdtEnvelope {
  const env: AdtEnvelope = {};
  const residual: Record<string, string> = {};
  const t100Vars: Record<string, string> = {};
  let t100Id: string | undefined;
  let t100No: string | undefined;

  for (const [rawKey, rawValue] of Object.entries(props)) {
    // Empty <entry key="x"/> elements arrive as the literal string "undefined"
    // (fromResponse template-stringifies), not "". Drop them — real data else.
    const value = String(rawValue ?? "").trim();
    if (!value || value === "undefined") continue;
    const key = rawKey.trim();

    if (key === "T100KEY-ID") t100Id = value;
    else if (key === "T100KEY-NO") t100No = value;
    else if (/^T100KEY-V\d+$/.test(key)) t100Vars[key.slice(8).toLowerCase()] = value;
    else if (key === SUBTYPE_KEY) env.subType = value;
    else if (key === "ideUser" || key === "conflictText") {
      env.lock = { ...env.lock, [key]: value };
    } else if (key === "URI") env.uri = value;
    else if (/^(TRANSPORT|CORRNR|TRKORR|REQUEST)$/i.test(key)) env.transport = value;
    // `previousNLongText` is the LONGTEXT blob under a different key; drop it.
    // `previousNText` (short text, the ABAP exception chain) is kept.
    else if (/LongText$/i.test(key)) continue;
    // truncateText marks clips visibly; full value is in ABAPSMITH_BODY_DUMP_DIR.
    else residual[key] = truncateText(value, MAX_PROPERTY_VALUE_CHARS);
  }

  if (t100Id || t100No || Object.keys(t100Vars).length) {
    const reassembled = reassembleSplitT100Variables(t100Vars);
    env.t100 = {
      ...(t100Id ? { id: t100Id } : {}),
      ...(t100No ? { no: t100No } : {}),
      ...(Object.keys(t100Vars).length ? { variables: t100Vars } : {}),
      ...(reassembled.length ? { reassembled } : {}),
    };
  }
  const keys = Object.keys(residual);
  if (keys.length > MAX_RESIDUAL_PROPERTIES) {
    // Clipped by count. Stated twice: a marker entry inside `properties` and
    // the named `omitted` field, so neither reader can mistake it as complete.
    const kept = keys.slice(0, MAX_RESIDUAL_PROPERTIES);
    const dropped = keys.length - kept.length;
    env.properties = {
      ...Object.fromEntries(kept.map((k) => [k, residual[k] as string])),
      // Mirrors compact.ts's notice("TRUNCATED", shown, cut) idiom.
      "…": `TRUNCATED: ${kept.length} of ${keys.length} ADT properties shown, ${dropped} cut`,
    };
    env.omitted = `${dropped} further ADT properties (${keys.length} total); the full set is in the ${BODY_DUMP_DIR_ENV} capture if it is enabled`;
  } else if (keys.length) {
    env.properties = residual;
  }
  return env;
}

/**
 * Extract the `adt` section from a RAW `abap-adt-api` throw. Built on
 * `adtExceptionInfo` (duck-typed) rather than the library's own guards, so it
 * handles all runtime shapes plus hand-rolled test throws uniformly.
 */
function adtEnvelopeFromThrown(e: unknown): AdtEnvelope | undefined {
  const info = adtExceptionInfo(e);
  if (!info) return undefined;
  const any = (e ?? {}) as Record<string, unknown>;
  const env = envelopeFromProperties(info.properties);
  // `info.response` is deliberately never read — the only place the raw body survives.
  if (info.status !== undefined) env.status = info.status;
  env.exceptionType ??= info.type;
  env.namespace ??= str(any.namespace);
  env.code ??= str(any.code);
  const localized = str(any.localizedMessage);
  if (localized && localized !== info.message) env.localizedMessage = localized;
  return env;
}

/**
 * Extract the `adt` section from an already-translated `AbapError`.
 * `translateAdtError` scatters these across `details` under its own names;
 * this re-gathers them so translated and raw errors share one `adt` shape.
 */
function adtEnvelopeFromDetails(details: Record<string, unknown>): {
  adt?: AdtEnvelope;
  rest: Record<string, unknown>;
} {
  const rest: Record<string, unknown> = {};
  let env: AdtEnvelope = {};
  let sawAny = false;

  for (const [k, v] of Object.entries(details)) {
    switch (k) {
      case "status":
        if (typeof v === "number") { env.status = v; sawAny = true; } else rest[k] = v;
        break;
      case "adtExceptionType":
        if (str(v)) { env.exceptionType = str(v); sawAny = true; } else rest[k] = v;
        break;
      case "properties":
        if (v && typeof v === "object" && !Array.isArray(v)) {
          env = { ...envelopeFromProperties(v as Record<string, string>), ...env };
          sawAny = true;
        } else rest[k] = v;
        break;
      case "t100":
        if (v && typeof v === "object" && !Array.isArray(v)) {
          env.t100 = { ...env.t100, ...envelopeFromProperties(v as Record<string, string>).t100 };
          sawAny = true;
        } else rest[k] = v;
        break;
      case "blockingUser":
        if (str(v)) { env.lock = { ...env.lock, blockingUser: str(v) }; sawAny = true; } else rest[k] = v;
        break;
      case "transport":
        if (str(v)) { env.transport = str(v); sawAny = true; } else rest[k] = v;
        break;
      default:
        rest[k] = v;
    }
  }
  return { adt: sawAny ? env : undefined, rest };
}

/**
 * The one derived sentence. Only ever states facts already in the envelope —
 * it is a reading aid, not an interpretation, so it stays empty rather than
 * guessing when nothing actionable is known.
 */
function summarise(code: string, adt: AdtEnvelope | undefined): string | undefined {
  if (!adt) return undefined;
  const parts: string[] = [];
  const holder = adt.lock?.blockingUser ?? adt.lock?.ideUser;
  if (code === "LOCKED" || holder) {
    parts.push(holder ? `Held by user ${holder}.` : "Another ADT session holds the lock.");
  }
  if (adt.lock?.conflictText) parts.push(adt.lock.conflictText);
  if (adt.status !== undefined) parts.push(`ADT returned HTTP ${adt.status}.`);
  if (adt.exceptionType) parts.push(`Exception ${adt.exceptionType}.`);
  if (adt.t100?.id && adt.t100.no) parts.push(`SAP message ${adt.t100.id}${adt.t100.no}.`);
  if (adt.subType) parts.push(`Operation ${adt.subType}.`);
  return parts.length ? parts.join(" ") : undefined;
}

/**
 * Guarantee a `NOT_FOUND` message names the object that was actually
 * requested. Measured defect (21-lesson live-SAP campaign, 276 NOT_FOUND
 * responses): 82 (29.7%) didn't name the object — 64 generic, 9 named a
 * different object, 9 empty. `translateAdtError` already passes SAP's text
 * through unchanged on the majority path; this is the backstop for the rest,
 * using `details.name` (already correct in all 82 cases) at the one exit
 * point every AbapError funnels through. See archive for full incident.
 */
function ensureNotFoundNamesObject(message: string, details: Record<string, unknown>): string {
  const name = typeof details.name === "string" ? details.name.trim() : "";
  // No requested name on record: nothing to check or construct against.
  if (!name) return message;

  const trimmed = message.trim();
  if (trimmed && trimmed.toLowerCase().includes(name.toLowerCase())) {
    // Majority path: message already names the object — no-op.
    return message;
  }

  const own = `${name} was not found.`;
  // SAP's text empty/whitespace: our sentence is the whole message.
  if (!trimmed) return own;
  // Generic or names a different object: kept, but attributed to SAP, not us.
  return `${own} SAP said: "${trimmed}"`;
}

/**
 * The raw-throw branch never had a `hint` key at all, so a
 * `LOCKED` result reaching here (the one classification path that never goes
 * through `translateAdtError`) silently lost its "do not retry" hint. Writes
 * its own hint rather than reusing the translated paths' wording, since this
 * branch has none of `translateAdtError`'s extracted fields (blockingUser,
 * confirmed T100 key) to back a more specific claim — only a duck-typed guess.
 * `NOT_FOUND`'s hint is generic enough to reuse verbatim.
 */
function hintForRawThrow(code: AbapErrorCode): string | undefined {
  switch (code) {
    case "SESSION_DEAD":
      // Same wording sessionDeadError (src/adt/session.ts) gives a translated
      // SESSION_DEAD — reused verbatim rather than restated.
      return (
        "Every lock the session held is already released. The connection re-establishes " +
        "a session on the next request — retry the operation once. This is NOT an " +
        "authentication failure and does not count against the logon-attempt budget."
      );
    case "LOCKED":
      return (
        "This lock conflict was classified from the raw HTTP/exception shape only — it was never " +
        "diagnosed beyond that, so no blocking session or object name could be extracted here. Do " +
        "NOT retry in a loop: there is no lock timeout while the holding session lives, so a " +
        "second attempt fails the same way. Close the other session (another terminal, an " +
        "Eclipse/SE80 editor) if you have one open on this object, or work on a different object."
      );
    case "NOT_FOUND":
      return "Check the name with abap_search, or create the object first.";
    default:
      // ADT_ERROR: same "unclassified" shape the normal translation path
      // falls back to, one level further out — this one never even reached
      // that classification step.
      return (
        "This failure was never classified beyond a generic HTTP/exception shape, so nothing " +
        "more specific is known about it. Check the `adt` block in the tool result: " +
        "`adt.localizedMessage` and `adt.t100` (id/no/variables) carry what SAP sent verbatim, " +
        "when present, and are usually more specific than the message above. Do not retry " +
        "unchanged — an unrecognised response will not resolve itself on a second try."
      );
  }
}

/**
 * Pure error-envelope construction: classify `e` and build the plain payload
 * object, with no MCP-shaped types involved. Exported so a non-MCP frontend
 * can reuse the same classification and wrap it in whatever shape it needs.
 */
export function buildErrorPayload(e: unknown): Record<string, unknown> {
  let payload: Record<string, unknown>;

  if (isAbapError(e)) {
    const { adt: adtRaw, rest } = adtEnvelopeFromDetails(e.details);
    const message = e.code === "NOT_FOUND" ? ensureNotFoundNamesObject(e.message, e.details) : e.message;
    const adt = withXt465Fallback(adtRaw, message);
    payload = {
      error: e.code,
      message,
      ...(e.hint ? { hint: e.hint } : {}),
      ...(e.retryable !== undefined ? { retryable: e.retryable } : {}),
      ...(adt ? { adt } : {}),
      ...(Object.keys(rest).length ? { details: rest } : {}),
    };
    const summary = summarise(e.code, adt);
    if (summary) payload.summary = summary;
  } else {
    // Raw abap-adt-api throw that never met translateAdtError; used to arrive
    // as a bare ADT_ERROR message. Classify with the same predicates the adt layer uses.
    const adtRaw = adtEnvelopeFromThrown(e);
    // Session death checked first, same precedence translateAdtError's
    // `wireDeath` check uses (src/adt/session.ts) — the response/HEADER tier
    // only, per that function's comment on why the body/prose tier is not
    // hoisted here too.
    const code: AbapErrorCode = classifySessionFailure(adtExceptionInfo(e)?.response)
      ? "SESSION_DEAD"
      : isLockConflict(e)
        ? "LOCKED"
        : isNotFoundError(e)
          ? "NOT_FOUND"
          : "ADT_ERROR";
    // `describeUnknownError` is typed `: string` but its JSON.stringify(e)
    // fallback returns actual `undefined` for undefined/functions/symbols,
    // dropping `message` entirely. Defended here (not in src/adt/errors.ts,
    // reported upstream) — see archive.
    const described = describeUnknownError(e);
    const message = typeof described === "string" && described ? described : `Unknown failure (${typeof e})`;
    const adt = withXt465Fallback(adtRaw, message);
    const hint = hintForRawThrow(code);
    payload = {
      error: code,
      message,
      ...(hint ? { hint } : {}),
      ...(adt ? { adt } : {}),
    };
    const summary = summarise(code, adt);
    if (summary) payload.summary = summary;
    if (adt && process.env[BODY_DUMP_DIR_ENV]) {
      payload.rawBody = `not included by design; a forensic capture was written to ${BODY_DUMP_DIR_ENV}`;
    }
  }

  return payload;
}

/** Exported for tests: this is the only shape callers ever see for a failure. */
export function errorResult(e: unknown): CallToolResult {
  const payload = buildErrorPayload(e);
  return {
    isError: true,
    content: [{ type: "text", text: fitEnvelope(payload) }],
  };
}

/**
 * Serialise within budget, shedding the residual property bag before any
 * named field (every named field is branched on; the bag is best-effort).
 * `message` is clipped only as a last resort, and always marked when it is.
 *
 * Compact, not pretty-printed — `JSON.stringify(_, null, 2)`
 * broke a live A4H run's `firstLine()`-style report tooling: every
 * failure's "first line" became the single character `{`.
 * Every real consumer parses the payload rather than reading it
 * line-wise, so whitespace buys nothing and costs that.
 */
function fitEnvelope(payload: Record<string, unknown>): string {
  let text = JSON.stringify(payload);
  if (text.length <= MAX_ERROR_ENVELOPE_CHARS) return text;

  const adt = payload.adt as AdtEnvelope | undefined;
  if (adt?.properties) {
    const dropped = Object.keys(adt.properties).length;
    const { properties: _dropped, ...kept } = adt;
    payload = {
      ...payload,
      adt: {
        ...kept,
        omitted: `${dropped} ADT properties dropped to stay inside the response budget`,
      },
    };
    text = JSON.stringify(payload);
    if (text.length <= MAX_ERROR_ENVELOPE_CHARS) return text;
  }
  if (typeof payload.message === "string" && payload.message.length > MAX_MESSAGE_CHARS) {
    payload = { ...payload, message: truncateText(payload.message, MAX_MESSAGE_CHARS) };
    text = JSON.stringify(payload);
    if (text.length <= MAX_ERROR_ENVELOPE_CHARS) return text;
  }
  // Last resort: named structure alone is over budget. Clip and mark it —
  // never let a caller read a truncated envelope as a complete one.
  return truncateText(text, MAX_ERROR_ENVELOPE_CHARS) + `\n(set ${BODY_DUMP_DIR_ENV} to capture the full error)`;
}
