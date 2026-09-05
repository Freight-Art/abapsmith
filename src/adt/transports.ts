/**
 * CTS (Change and Transport System) client — deliberately **policy-free**: no safety
 * flags, no journal writes, no human-facing formatting. Just wire XML → TS shapes, and
 * *honest* outcome classification (see notes below on refusing to believe the server).
 *
 * Three server quirks drive the design, each called out at its implementation site:
 *   - "Transport required" is not an error: writing into a transportable package with no
 *     `corrNr` returns 200 with an empty body while the server silently fabricates a
 *     request+task. Only pre-flight (`trRequirement`) catches it.
 *   - The release abort envelope lies: every release is HTTP 200, and an abort report can
 *     accompany a request that actually released (`trRelease` re-reads to check).
 *   - DELETE's 200 proves nothing — deleting a nonexistent request is byte-identical to a
 *     real delete (`trDelete` re-reads to check).
 */

import { XMLParser } from "fast-xml-parser";

import type { AbapConnection } from "./connection.js";
import { AbapError, describeUnknownError, isAbapError } from "./errors.js";
import {
  adtExceptionInfo,
  classifySessionFailure,
  sessionDeadError,
  sessionDeathFromInfo,
} from "./session.js";
import type { AuthorizedTarget } from "../safety.js";

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

const CTS_BASE = "/sap/bc/adt/cts";
const TRANSPORT_REQUESTS = `${CTS_BASE}/transportrequests`;
const TRANSPORT_CHECKS = `${CTS_BASE}/transportchecks`;
const TRANSPORTS = `${CTS_BASE}/transports`;
const SYSTEM_USERS = "/sap/bc/adt/system/users";

/** Accept/Content-Type for the transportchecks (pre-flight) service. */
const CHECK_DATA_TYPE =
  "application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData";
/** Content-Type for creating a correction request. */
const CREATE_REQUEST_TYPE =
  "application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.CreateCorrectionRequest";
const ORGANIZER_TYPE = "application/vnd.sap.adt.transportorganizer.v1+xml";

// ---------------------------------------------------------------------------
// Authorization proofs (compile-time gate enforcement)
// ---------------------------------------------------------------------------
//
// `trCreate` mutates a real object (a package, via `devClass`), so it takes an
// `AuthorizedTarget<"transport", ...>` minted by `SafetyGate.authorize()` (`src/safety.ts`).
//
// `trAddUser`/`trSetOwner`/`trDelete`/`trRelease` carry no ABAP object — only a TRKORR
// (e.g. `A4HK900123`) — so they can't use `AuthorizedTarget`: `SafetyGate`'s unconditional
// name-prefix allowlist (default `["Z","Y"]`) would fail-closed on every call, since no real
// TRKORR starts with "Z"/"Y". `src/tools/transport.ts` already gates these object-lessly on
// purpose (see `ceilingDecision`); traced end to end against `SafetyGate.evaluate()`, not
// assumed — see the git history for the full trace.
//
// So these four take a `TransportCeilingProof` instead: a minimal, object-less capability
// token scoped to the ceiling check (`ABAP_ALLOW_WRITE`, plus `ABAP_ALLOW_TRANSPORT_RELEASE`
// for release) that already governs these calls via `assertCeiling`. Only `authorizeCeiling()`
// (module-private mint symbol, same pattern as `AuthorizedTarget`) can construct one, and it
// stays free of any dependency on `src/safety.ts` — this module stays policy-free — via a
// narrow structural `CeilingGate` interface that the real `SafetyGate` satisfies.

const CEILING_MINT = Symbol("TransportCeilingProof.mint");
type CeilingMintToken = typeof CEILING_MINT;

/**
 * Ops `authorizeCeiling` can mint a proof for. In practice always `"transport"`, even for
 * `trDelete`. `"delete"` exists only because `SafetyGate.evaluate` accepts it as an
 * `Operation`; using it here routes into the deny-all `!obj` fallback and fails closed
 * unconditionally, so it is not actually usable through this function today.
 */
export type CeilingOp = "transport" | "delete";

/**
 * Compile-time proof the transport-management ceiling has been checked for this call — the
 * object-less counterpart to `AuthorizedTarget` for `trAddUser`/`trSetOwner`/`trDelete`/
 * `trRelease` (see the section comment above). Only {@link authorizeCeiling} can construct one.
 */
export class TransportCeilingProof {
  readonly op: CeilingOp;
  constructor(token: CeilingMintToken, op: CeilingOp) {
    if (token !== CEILING_MINT) {
      throw new Error(
        "TransportCeilingProof can only be constructed by authorizeCeiling() (src/adt/transports.ts).",
      );
    }
    this.op = op;
  }
}

/**
 * Minimal slice of `SafetyGate` (`src/safety.ts`) needed to check the transport-management
 * ceiling, without importing the rest of its policy surface. The real `SafetyGate.evaluate`
 * satisfies this structurally.
 */
export interface CeilingGate {
  evaluate(
    op: CeilingOp,
    obj: undefined,
    opts?: { release?: boolean },
  ): { allowed: boolean; reason: string; code?: string; rule?: string };
}

/**
 * Check the transport-management ceiling and mint a {@link TransportCeilingProof}. Calls
 * `gate.evaluate(op, undefined, opts)` — same as `ceilingDecision`/`assertCeiling` in
 * `src/tools/transport.ts` — so behaviour is unchanged; this only adds a compile-time
 * requirement that the check ran first. Throws `AbapError("READ_ONLY", ...)` (or the gate's
 * own `code`) on denial.
 */
export function authorizeCeiling(
  gate: CeilingGate,
  op: CeilingOp,
  opts: { release?: boolean } = {},
): TransportCeilingProof {
  const decision = gate.evaluate(op, undefined, opts);
  if (!decision.allowed) {
    throw new AbapError(
      (decision.code as AbapError["code"]) ?? "READ_ONLY",
      decision.reason,
      { operation: `transport:${op}`, rule: decision.rule },
    );
  }
  return new TransportCeilingProof(CEILING_MINT, op);
}

/**
 * A transport request or task number as this system issues them: `A4HK900121`. Requests and
 * tasks are indistinguishable by shape.
 */
const TRKORR_RE = /^[A-Z][A-Z0-9]{2}K[0-9]{6}$/;

/**
 * `chkrun:status` value that means the release genuinely succeeded. Anything
 * else is an abort report — but see {@link trRelease}: an abort report does
 * not mean the request stayed modifiable.
 */
const RELEASE_OK = "released";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What kind of CTS object a number refers to. `kindRaw` keeps the wire value. */
export type TrKind = "workbench" | "customizing" | "transport-of-copies" | "task" | "unknown";

/** Normalised lifecycle state. `statusRaw` keeps the wire value. */
export type TrStatus = "modifiable" | "released" | "protected" | "unknown";

/** The operation a transport check is being made for. `I` = create/insert. */
export type TrOperation = "I" | "U";

/** Common header fields shared by requests and tasks. */
export interface TrHeader {
  trkorr: string;
  kind: TrKind;
  /** Raw `tm:type` / `TRFUNCTION` as sent (`K`, `S`, `Development/Correction`, ...). */
  kindRaw: string;
  status: TrStatus;
  /** Raw `tm:status` / `TRSTATUS` as sent (`D`, `R`, `L`, ...). */
  statusRaw: string;
  /** Server-rendered status label, e.g. `Modifiable` / `Released`. */
  statusText?: string;
  owner: string;
  description: string;
  /** Transport target. Always `""` on this box — no route configured; treat as normal, not a failure. */
  target?: string;
  targetDescription?: string;
  /** Parent request number, for tasks. Empty on requests. */
  parent?: string;
  client?: string;
  /** `tm:lastchanged_timestamp`, e.g. `20260801133446`. Left as sent. */
  lastChanged?: string;
  uri?: string;
}

/** One object recorded in a request or task. */
export interface TrObject {
  pgmid: string;
  type: string;
  name: string;
  description?: string;
  /** `tm:wbtype`, e.g. `PROG/P`. */
  wbType?: string;
  /** `tm:lock_status === "X"`. */
  locked: boolean;
  uri?: string;
}

/** A task nested under a request. */
export interface TrTask extends TrHeader {
  objects: TrObject[];
}

/** A request with its tasks and the union of objects it records. */
export interface TrRequest extends TrHeader {
  tasks: TrTask[];
  objects: TrObject[];
}

/** A message returned by the transportchecks pre-flight service. */
export interface TrCheckMessage {
  /** `SEVERITY`: `E`, `W`, `I`, ... */
  severity: string;
  /** `ARBGB` — the ABAP message class, e.g. `TO`. */
  messageClass: string;
  /** `MSGNR` — the message number, e.g. `140`. Kept as a string. */
  messageNumber: string;
  text: string;
  variables: string[];
}

/** An object that is already pinned to somebody's request. */
export interface TrLock {
  object: { pgmid: string; type: string; name: string };
  request: TrHeader;
  tasks: TrHeader[];
}

/**
 * Whether writing an object needs a transport, and what happens if `corrNr` is omitted.
 *
 *   - `local` — no transport involved (`$TMP`-style package).
 *   - `transport-required` — `corrNr` needed; omitting it fails.
 *   - `transport-auto-created` — `corrNr` needed, but the server **silently fabricates** a
 *     request+task if omitted, and reports success. Callers must supply `corrNr` or refuse.
 *
 * See {@link trRequirement} for why `RESULT` is not consulted for this.
 */
export type TrRequirement = TrRequirementBase &
  (
    | { kind: "local"; mustSupplyCorrNr: false; serverWouldFabricate: false }
    | { kind: "transport-required"; mustSupplyCorrNr: true; serverWouldFabricate: false }
    | { kind: "transport-auto-created"; mustSupplyCorrNr: true; serverWouldFabricate: true }
  );

/** Fields present on every {@link TrRequirement}, whatever the `kind`. */
export interface TrRequirementBase {
  /** Object URI the check was run for. */
  uri: string;
  pgmid?: string;
  objectType?: string;
  objectName?: string;
  operation: TrOperation;
  devclass?: string;
  /** `PDEVCLASS` — the enclosing/main package. */
  parentDevclass?: string;
  /** `TADIRDEVC` — the package TADIR currently records for the object. */
  tadirDevclass?: string;
  deliveryUnit?: string;
  namespace?: string;
  /** `AS4USER` from the check header, if the server suggests an owner. */
  suggestedOwner?: string;
  /** Requests the server offers as targets for this object. */
  candidates: TrHeader[];
  /** Objects already pinned to an existing request. */
  locks: TrLock[];
  /** Request number holding the first lock, if any. */
  pinnedTo?: string;
  /** Owner of {@link pinnedTo}. */
  pinnedOwner?: string;
  /** Check messages. Present regardless of `kind`. */
  messages: TrCheckMessage[];
  /**
   * `RESULT === "E"`. This means the *check itself* objected (e.g. the package
   * refuses the object), and is orthogonal to whether a transport is needed.
   */
  checkFailed: boolean;
  /** Verbatim discriminator fields, for logging and for tests. */
  raw: { result: string; korrflag: string; recording: string };
}

/** Input for {@link trCreate}. */
export interface TrCreateInput {
  /** Object the request is being created for, e.g. `/sap/bc/adt/programs/programs/zfoo`. */
  objSourceUrl: string;
  description: string;
  devClass: string;
  transportLayer?: string;
  operation?: TrOperation;
}

/** Result of {@link trCreate}. */
export interface TrCreated {
  trkorr: string;
  /** The raw body: a bare relative path such as `/com.sap.cts/object_record/A4HK900121`. */
  path: string;
}

/**
 * Options for {@link trList}.
 *
 * Without `configUri`, this endpoint returns only a canned "Released (From Last 2 Weeks)"
 * view — `tm:modifiable` never appears, regardless of `user`. `configUri` (a persisted,
 * per-user "search configuration" object — see `trSearchConfigurations` /
 * `trCreateSearchConfiguration` below) is the only way to see Modifiable requests.
 * `src/tools/transport.ts`'s `opList` resolves one automatically; this stays a thin wire call.
 */
export interface TrListOptions {
  /** Restrict to one user. Omit for the connected user's default view. Has no effect on which status categories come back — see the warning above. */
  user?: string;
  /** Group by transport target. Defaults to `false` — this box has no targets. */
  targets?: boolean;
  /** Use a saved search configuration instead of `user`/`targets`. The only way to see Modifiable requests. */
  configUri?: string;
}

/** Result of {@link trList}. */
export interface TrList {
  workbench: TrRequest[];
  customizing: TrRequest[];
}

/** Result of {@link trAddUser}. */
export interface TrAddUserResult {
  trkorr: string;
  user: string;
  /** Number of the task created for the user, when the server reports one. */
  task?: string;
}

/** Result of {@link trSetOwner}. */
export interface TrSetOwnerResult {
  trkorr: string;
  owner: string;
}

/** One message inside a release report. */
export interface TrReleaseMessage {
  /** `chkrun:type`, e.g. `E`. */
  type: string;
  /** `chkrun:shortText` — the human-readable line. */
  text: string;
  /**
   * ABAP message class parsed out of the longtext link, e.g. `TR`, `EU`, `PU`,
   * `TK`. The `chkrun:status` values collapse almost everything into
   * `abortrelapifail`, so class/number is the only stable reason code.
   */
  messageClass?: string;
  /** Message number, e.g. `768`. Kept as a string. */
  messageNumber?: string;
  /** `chkrun:uri` — the object or request the message is about. */
  uri?: string;
  longtextUri?: string;
}

/** One `chkrun:checkReport` from a release attempt. */
export interface TrReleaseReport {
  trkorr: string;
  reporter?: string;
  triggeringUri?: string;
  /** Verbatim `chkrun:status`: `released`, `abortrelapifail`, `abortrelinacobj`, ... */
  status: string;
  /** Verbatim `chkrun:statusText`. Boilerplate; prefer the messages. */
  statusText?: string;
  /** `status === "released"` — i.e. what the envelope *claims*. */
  reportedReleased: boolean;
  messages: TrReleaseMessage[];
}

/**
 * Reconciliation of what the release envelope said with what actually
 * happened to the request.
 *
 * - `released`               — report said released.
 * - `released-despite-abort` — report aborted, but the request is Released.
 *   Observed live with `PU/238` ("The release was terminated").
 * - `aborted`                — report aborted and the request is still modifiable.
 * - `unknown`                — report aborted and the re-read could not settle it.
 */
export type TrReleaseOutcome = "released" | "released-despite-abort" | "aborted" | "unknown";

/** Result of {@link trRelease}. */
export interface TrReleaseResult {
  trkorr: string;
  outcome: TrReleaseOutcome;
  /** What the release envelope claimed. Never sufficient on its own. */
  reportedReleased: boolean;
  /** `tm:status` from a fresh read of the request. Undefined if not verified. */
  actualStatus?: TrStatus;
  actualStatusText?: string;
  /** True when the request was re-read successfully after an abort report. */
  verified: boolean;
  /** Why verification could not be done, when it could not. */
  verificationError?: string;
  /** `tm:releasetimestamp`, verbatim. `0` on aborts. */
  releaseTimestamp?: string;
  reports: TrReleaseReport[];
  /** Every report's messages, flattened, in order. */
  messages: TrReleaseMessage[];
  /** The re-read request, when verification ran and succeeded. */
  request?: TrRequest;
}

/**
 * Result of {@link trDelete}.
 *
 * `trkorr` may name a task rather than a request. `deleted`/`existedBefore`/`gone` all judge
 * the NAMED entity (`probe`'s `own`) — never the bare presence of a re-read response, which
 * for a task number is always its parent and proves nothing about the task itself.
 */
export interface TrDeleteResult {
  trkorr: string;
  /** True only when the named entity existed before and is provably gone after. */
  deleted: boolean;
  /** Whether the named entity (request or task) existed when we started. */
  existedBefore: boolean;
  /** Whether the post-delete re-read completed and settled the question. */
  verified: boolean;
  /** True when the named entity is provably absent now (whether or not we deleted it). */
  gone: boolean;
  /** HTTP status of the DELETE itself. Always 200 here; kept for the record. */
  httpStatus?: number;
  verificationError?: string;
  /**
   * The request as re-read after the delete, when the named entity was NOT verified gone. For
   * a task number this is the PARENT request, never the task's own header alone.
   */
  remaining?: TrRequest;
}

/** A user as returned by {@link trUsers}. */
export interface TrUser {
  id: string;
  title: string;
}

/** How a bad `corrNr` failed. See {@link classifyCorrNrError}. */
export type TrCorrNrProblem = "not-found" | "not-a-change-request" | "released" | "unknown";

/** Diagnosis of a `corrNr`-related 403. */
export interface TrCorrNrDiagnosis {
  problem: TrCorrNrProblem;
  /** The offending number, when the free text yielded one. */
  trkorr?: string;
  /** The server's message, verbatim. */
  message: string;
  /** `exc:exception`'s `type id`. Always `ExceptionResourceNoAuthorization`, and misleading. */
  exceptionType?: string;
}

// ---------------------------------------------------------------------------
// XML plumbing
// ---------------------------------------------------------------------------

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

type Node = Record<string, unknown>;

function parse(body: string): Node {
  if (!body || !body.trim()) return {};
  try {
    return (xml.parse(body) ?? {}) as Node;
  } catch {
    return {};
  }
}

function node(value: unknown): Node | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Node) : undefined;
}

/** fast-xml-parser collapses single children; empty elements become `""`. */
function many(value: unknown): Node[] {
  if (Array.isArray(value)) return value.filter((v) => !!node(v)).map((v) => v as Node);
  const one = node(value);
  return one ? [one] : [];
}

/** Attribute value as a trimmed string (namespace prefixes already stripped). */
function attr(n: Node | undefined, name: string): string {
  if (!n) return "";
  const v = n[`@_${name}`];
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

/** Element text, tolerating both bare strings and `{ "#text": ... }` shapes. */
function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  const n = node(value);
  if (n && typeof n["#text"] === "string") return (n["#text"] as string).trim();
  return "";
}

function child(n: Node | undefined, name: string): unknown {
  return n ? n[name] : undefined;
}

function childText(n: Node | undefined, name: string): string {
  return text(child(n, name));
}

function optional(value: string): string | undefined {
  return value ? value : undefined;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

interface WireFailure {
  status?: number;
  /** `exc:exception`'s `type id`, when present. */
  type?: string;
  /** Server message text, preferring the parsed `<message>` element. */
  message: string;
}

/**
 * Normalise a thrown HTTP failure into status + `exc:exception` message.
 *
 * The response body is parsed directly when it is available, because that is
 * the only place the discriminating free text reliably survives.
 */
function wireFailure(e: unknown): WireFailure | undefined {
  const info = adtExceptionInfo(e);
  if (!info) return undefined;
  const body = typeof info.response?.body === "string" ? info.response.body : "";
  const exception = node(child(parse(body), "exception"));
  const fromBody = exception
    ? childText(exception, "message") || childText(exception, "localizedMessage")
    : "";
  const type = exception ? attr(node(child(exception, "type")), "id") : undefined;
  return {
    status: info.status,
    type: optional(type ?? "") ?? info.type,
    message: fromBody || info.message || describeUnknownError(e),
  };
}

/** True when the failure is the server saying this number is unknown to it. */
function isGone(f: WireFailure | undefined): boolean {
  if (!f) return false;
  if (f.type === "ADT_TM_COMMON_EXCEPTION" && /does not exist in system/i.test(f.message)) {
    return true;
  }
  return f.status === 404;
}

function ctsError(e: unknown, operation: string, trkorr?: string): AbapError {
  if (e instanceof AbapError) return e;
  // Classify session death FIRST, ahead of everything below, via the same
  // two-tier check `translateAdtError` (session.ts) uses. Without this, a dead session was
  // misclassified as a bare TRANSPORT_ERROR — invisible to pool.ts's isSessionDeadError, so
  // the caller got a generic error instead of the pool's bounded dead-slot replay. See
  // the git history for the live repro.
  const info = adtExceptionInfo(e);
  const death = classifySessionFailure(info?.response) ?? sessionDeathFromInfo(info);
  if (death) return sessionDeadError(death, { operation });
  const f = wireFailure(e);
  const details: Record<string, unknown> = { operation };
  if (trkorr) details.trkorr = trkorr;
  if (f?.status !== undefined) details.status = f.status;
  if (f?.type) details.exceptionType = f.type;
  const message = f?.message || describeUnknownError(e);

  if (isGone(f)) {
    // This hint must stay narrower than "released" — "does not exist in system"
    // and a bare 404 both just mean "not there" (released, deleted by another user, and a
    // typo all produce the identical shape), so it states only the fact SAP gave plus the
    // one safe next move (list), without guessing a specific cause.
    return new AbapError(
      "TRANSPORT_GONE",
      message,
      details,
      "SAP does not recognise this transport/task number — it is not evidence of a system " +
        "problem, and retrying this same number will not change that. It is usually gone " +
        "because it was already released or deleted, or because the number was mistyped; this " +
        "response does not say which. Run abap_transport with operation \"list\" to see what " +
        "actually exists before acting on this number again.",
    );
  }
  if (/contains locked objects/i.test(message)) {
    // The prior hint ("abapsmith has no call to remove or unlock a locked entry") named a
    // call that did not exist; operation "removeObject" now does, so it leads the exits.
    return new AbapError(
      "TRANSPORT_LOCKED",
      message,
      details,
      "CTS holds this entry's lock until the request is released; deleting the object does " +
        "not clear it. The number above may be a child task, not the one you passed. Real " +
        "exits: abap_transport operation \"removeObject\" with object = the entry's name and " +
        "confirm = the request number (admin mode only) — drops that one entry and its lock " +
        "from an unreleased request/task; release the request (irreversible); or in SE03 run " +
        "\"Unlock Objects (Expert Tool)\" and then handle it by hand in SE09/SE10. abapsmith " +
        "cannot unlock an entry while leaving it on the request — removeObject removes it " +
        "outright.",
    );
  }
  return new AbapError(
    "TRANSPORT_ERROR",
    message,
    details,
    // Reached only for an UNCLASSIFIED CTS response (neither "gone" nor "locked"), so this
    // hint must not imply either. Parameter name is `operation` not `action` —
    // `transportInputSchema`, src/tools/transport.ts. `trkorr` is only populated on
    // some call sites, so the hint picks the verb the caller can actually use.
    trkorr
      ? `This CTS/transport response did not match TRANSPORT_GONE or TRANSPORT_LOCKED, so it has ` +
        `not actually been diagnosed. Check the \`adt\` block in the tool result: ` +
        `\`adt.localizedMessage\` and \`adt.t100\` (id/no/variables) carry what SAP sent verbatim ` +
        `and are usually more specific than the message above. Run abap_transport with ` +
        `operation "show" and transport "${trkorr}" to see this request's real current state — ` +
        `released, reassigned, or never what the caller expected — rather than assuming the ` +
        `operation itself is wrong. Do not retry unchanged — an unrecognised transport response ` +
        `will not resolve itself on a second try.`
      : "This CTS/transport response did not match TRANSPORT_GONE or TRANSPORT_LOCKED, so it has " +
        "not actually been diagnosed. Check the `adt` block in the tool result: " +
        "`adt.localizedMessage` and `adt.t100` (id/no/variables) carry what SAP sent verbatim and " +
        "are usually more specific than the message above. Run abap_transport with " +
        'operation "list" to see the caller\'s actual transport state, rather than assuming this ' +
        "specific operation is wrong. Do not retry unchanged — an unrecognised transport response " +
        "will not resolve itself on a second try.",
  );
}

export function assertTrkorr(value: string, operation: string): string {
  const trkorr = (value ?? "").trim().toUpperCase();
  if (!isTrkorr(trkorr)) {
    throw new AbapError("BAD_INPUT", `Not a transport request/task number: ${value}`, {
      operation,
      value,
    });
  }
  return trkorr;
}

/**
 * Is this a transport request or task number?
 *
 * Matches the shape this system actually issues (`A4HK900121`) rather than the
 * looser pattern in the design doc, which was written before live capture.
 * Requests and tasks are the same shape; only the server can tell them apart.
 */
export function isTrkorr(value: unknown): boolean {
  return typeof value === "string" && TRKORR_RE.test(value.trim().toUpperCase());
}

/**
 * Is this a local (non-transportable) package? SAP's own rule: ANY
 * `$`-prefixed package is local and never enters CTS — not just `$TMP`.
 * `src/safety.ts:1677` and `src/tools/transport.ts:876` already apply this
 * exact rule inline, each with its own copy; neither is changed here
 * (`safety.ts` belongs to another workstream this cycle), so this is one
 * fewer copy, not zero.
 */
export function isLocalPackageName(packageName: string): boolean {
  return packageName.trim().toUpperCase().startsWith("$");
}

/**
 * Classify a 403 raised while passing a `corrNr` to a write — or, for the "already
 * released" message only, the 400 it can also arrive on (`trDelete`'s captured refusal for
 * this exact wording came back on 400, not 403; the write-path status has never been
 * captured live, so both are accepted for that one pattern).
 *
 * Brittle by necessity: not-found and not-a-change-request return byte-identical HTTP 403
 * with the same (misleading) `ExceptionResourceNoAuthorization` type and empty
 * `<properties/>` — only the message text differs, so free-text matching is the only
 * option. Those two stay gated on 403 exactly, as before. An unmatched 403 degrades to
 * `problem: "unknown"` rather than being guessed into a bucket; an unmatched 400 returns
 * `undefined`, since a 400 alone is not evidence of anything else this function
 * classifies. Returns `undefined` when the failure is neither a 403 nor a 400.
 */
export function classifyCorrNrError(e: unknown): TrCorrNrDiagnosis | undefined {
  const f = wireFailure(e);
  if (!f || (f.status !== 403 && f.status !== 400)) return undefined;

  // Matched against untranslated server text; a different logon language breaks this,
  // which is why the fallthrough stays generic instead of guessing.
  if (f.status === 403) {
    const notFound = /^Task\/request (\S+) does not exist in system/.exec(f.message);
    if (notFound) {
      return { problem: "not-found", trkorr: notFound[1], message: f.message, exceptionType: f.type };
    }
  }

  // Disjoint from both patterns above (distinct wording, "already released"), so order
  // relative to them doesn't matter. Both observed spellings ("Request X is already
  // released" / "Request/task X already released (not modifiable)") share this one pattern.
  const released =
    /^(?:Request\/task|Task\/request|Request|Task)\s+(\S+)\s+(?:is\s+)?already released/i.exec(f.message);
  if (released) {
    return { problem: "released", trkorr: released[1], message: f.message, exceptionType: f.type };
  }

  if (f.status !== 403) return undefined;

  const notARequest = /^Request (\S+) is not a change request$/.exec(f.message);
  if (notARequest) {
    return {
      problem: "not-a-change-request",
      trkorr: notARequest[1],
      message: f.message,
      exceptionType: f.type,
    };
  }
  return { problem: "unknown", message: f.message, exceptionType: f.type };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function toKind(raw: string): TrKind {
  const v = (raw ?? "").trim();
  switch (v.toUpperCase()) {
    case "K":
      return "workbench";
    case "W":
      return "customizing";
    case "T":
    case "C":
      return "transport-of-copies";
    case "S":
    case "R":
    case "X":
    case "Q":
    case "M":
    // "Unclassified" is a real wire value for a task's tm:type — structurally a task
    // (tm:parent set) despite naming no category. Exact wire token, not free text.
    case "UNCLASSIFIED":
      return "task";
    default:
      // Details responses spell task types out ("Development/Correction").
      return /task|correction|repair/i.test(v) ? "task" : "unknown";
  }
}

function toStatus(raw: string): TrStatus {
  switch ((raw ?? "").trim().toUpperCase()) {
    case "D":
      return "modifiable";
    case "L":
      return "protected";
    case "R":
    case "N":
      return "released";
    default:
      return "unknown";
  }
}

/** Header from a `tm:request` / `tm:task` element (details and tree responses). */
function headerFromTm(n: Node): TrHeader {
  const kindRaw = attr(n, "type");
  const statusRaw = attr(n, "status");
  return {
    trkorr: attr(n, "number"),
    kind: toKind(kindRaw),
    kindRaw,
    status: toStatus(statusRaw),
    statusRaw,
    statusText: optional(attr(n, "status_text")),
    owner: attr(n, "owner"),
    description: attr(n, "desc"),
    target: attr(n, "target"),
    targetDescription: optional(attr(n, "target_desc")),
    parent: optional(attr(n, "parent")),
    client: optional(attr(n, "source_client")),
    lastChanged: optional(attr(n, "lastchanged_timestamp")),
    uri: optional(attr(n, "uri")),
  };
}

/** Header from a transportchecks `REQ_HEADER` / `CTS_TASK_HEADER` element. */
function headerFromCheck(n: Node): TrHeader {
  const kindRaw = childText(n, "TRFUNCTION");
  const statusRaw = childText(n, "TRSTATUS");
  return {
    trkorr: childText(n, "TRKORR"),
    kind: toKind(kindRaw),
    kindRaw,
    status: toStatus(statusRaw),
    statusRaw,
    owner: childText(n, "AS4USER"),
    description: childText(n, "AS4TEXT"),
    target: childText(n, "TARSYSTEM"),
    client: optional(childText(n, "CLIENT")),
    lastChanged: optional(
      [childText(n, "AS4DATE"), childText(n, "AS4TIME")].filter(Boolean).join(" "),
    ),
  };
}

function objectFromTm(n: Node): TrObject {
  return {
    pgmid: attr(n, "pgmid"),
    type: attr(n, "type"),
    name: attr(n, "name"),
    description: optional(attr(n, "obj_desc")),
    wbType: optional(attr(n, "wbtype")),
    locked: attr(n, "lock_status") === "X",
    uri: optional(attr(n, "dummy_uri")),
  };
}

/**
 * Objects hang off `tm:all_objects` on requests and directly off tasks. A request can list
 * the *same* object both ways at once, which would double-count it if naively unioned — so
 * results are de-duplicated by `pgmid`+`type`+`name` (position numbers aren't stable across
 * the two shapes, but this triple is). A `CORR/RELE` "Comment Entry" pseudo-object exists
 * only directly and survives de-duplication intact.
 */
function objectsOf(n: Node): TrObject[] {
  const wrapped = many(child(node(child(n, "all_objects")), "abap_object"));
  const direct = many(child(n, "abap_object"));
  const seen = new Set<string>();
  const out: TrObject[] = [];
  for (const raw of [...wrapped, ...direct]) {
    const obj = objectFromTm(raw);
    const key = `${obj.pgmid}::${obj.type}::${obj.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(obj);
  }
  return out;
}

function taskFromTm(n: Node): TrTask {
  return { ...headerFromTm(n), objects: objectsOf(n) };
}

function requestFromTm(n: Node): TrRequest {
  return {
    ...headerFromTm(n),
    tasks: many(child(n, "task")).map(taskFromTm),
    objects: objectsOf(n),
  };
}

// ---------------------------------------------------------------------------
// trRequirement — pre-flight transport check
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function checkEnvelope(devclass: string, operation: TrOperation, uri: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>` +
    `<DEVCLASS>${escapeXml(devclass)}</DEVCLASS>` +
    `<OPERATION>${escapeXml(operation)}</OPERATION>` +
    `<URI>${escapeXml(uri)}</URI>` +
    `</DATA></asx:values></asx:abap>`
  );
}

function checkMessages(data: Node): TrCheckMessage[] {
  return many(child(node(child(data, "MESSAGES")), "CTS_MESSAGE")).map((m) => ({
    severity: childText(m, "SEVERITY"),
    messageClass: childText(m, "ARBGB"),
    messageNumber: childText(m, "MSGNR"),
    text: childText(m, "TEXT"),
    variables: many(child(node(child(m, "VARIABLES")), "CTS_VARIABLE"))
      .map((v) => childText(v, "VARIABLE"))
      .filter(Boolean),
  }));
}

function checkCandidates(data: Node): TrHeader[] {
  const out: TrHeader[] = [];
  for (const req of many(child(node(child(data, "REQUESTS")), "CTS_REQUEST"))) {
    const header = node(child(req, "REQ_HEADER"));
    if (header) out.push(headerFromCheck(header));
    for (const task of many(child(node(child(req, "TASK_HEADERS")), "CTS_TASK_HEADER"))) {
      out.push(headerFromCheck(task));
    }
  }
  return out;
}

function checkLocks(data: Node): TrLock[] {
  const out: TrLock[] = [];
  for (const lock of many(child(node(child(data, "LOCKS")), "CTS_OBJECT_LOCK"))) {
    const key = node(child(lock, "OBJECT_KEY"));
    const holder = node(child(lock, "LOCK_HOLDER"));
    const header = node(child(holder, "REQ_HEADER"));
    if (!header) continue;
    out.push({
      object: {
        pgmid: childText(key, "PGMID"),
        type: childText(key, "OBJECT"),
        name: childText(key, "OBJ_NAME"),
      },
      request: headerFromCheck(header),
      tasks: many(child(node(child(holder, "TASK_HEADERS")), "CTS_TASK_HEADER")).map(
        headerFromCheck,
      ),
    });
  }
  return out;
}

/**
 * Ask the server, before writing, whether this object needs a transport.
 *
 * This is the *only* honest way to find out — writing without `corrNr` and seeing whether it
 * fails does not work: the server returns 200 with an empty body while silently fabricating
 * a request+task. There is nothing to catch.
 *
 * Discriminators, in order:
 *   - `KORRFLAG === "X"` — a transport is required. Empty means local.
 *   - `RECORDING === "X"` — omitting `corrNr` will NOT fail; the server fabricates a request
 *     instead. Surfaced as `kind: "transport-auto-created"`.
 *
 * `RESULT` is deliberately **not** used to decide any of this — it is `"S"` for both the
 * local and transportable cases. It is reported separately as
 * {@link TrRequirementBase.checkFailed} (`RESULT === "E"`), a different question (the check
 * objecting to the write at all).
 *
 * Deliberately **not** gated by `AuthorizedTarget`/`TransportCeilingProof`: this is a read
 * that runs unconditionally on every `SessionTransport.resolve()` call
 * (`src/adt/session-transport.ts`), ahead of any decision about whether a write happens.
 * Its tool-facing twin `opCheck` (`src/tools/transport.ts`) is likewise ungated.
 */
export async function trRequirement(
  conn: AbapConnection,
  objSourceUrl: string,
  devClass?: string,
  operation: TrOperation = "I",
): Promise<TrRequirement> {
  let body: string;
  try {
    const resp = await conn.post(TRANSPORT_CHECKS, {
      headers: { Accept: CHECK_DATA_TYPE, "Content-Type": CHECK_DATA_TYPE },
      body: checkEnvelope(devClass ?? "", operation, objSourceUrl),
    });
    body = resp.body;
  } catch (e) {
    throw ctsError(e, "trRequirement");
  }

  const data =
    node(child(node(child(node(child(parse(body), "abap")), "values")), "DATA")) ?? ({} as Node);

  const result = childText(data, "RESULT");
  const korrflag = childText(data, "KORRFLAG");
  const recording = childText(data, "RECORDING");
  const locks = checkLocks(data);

  const base: TrRequirementBase = {
    uri: childText(data, "URI") || objSourceUrl,
    pgmid: optional(childText(data, "PGMID")),
    objectType: optional(childText(data, "OBJECT")),
    objectName: optional(childText(data, "OBJECTNAME")),
    operation,
    devclass: optional(childText(data, "DEVCLASS")),
    parentDevclass: optional(childText(data, "PDEVCLASS")),
    tadirDevclass: optional(childText(data, "TADIRDEVC")),
    deliveryUnit: optional(childText(data, "DLVUNIT")),
    namespace: optional(childText(data, "NAMESPACE")),
    suggestedOwner: optional(childText(data, "AS4USER")),
    candidates: checkCandidates(data),
    locks,
    pinnedTo: locks[0]?.request.trkorr,
    pinnedOwner: locks[0]?.request.owner,
    messages: checkMessages(data),
    checkFailed: result === "E",
    raw: { result, korrflag, recording },
  };

  if (korrflag !== "X") {
    return { ...base, kind: "local", mustSupplyCorrNr: false, serverWouldFabricate: false };
  }
  if (recording === "X") {
    return {
      ...base,
      kind: "transport-auto-created",
      mustSupplyCorrNr: true,
      serverWouldFabricate: true,
    };
  }
  return {
    ...base,
    kind: "transport-required",
    mustSupplyCorrNr: true,
    serverWouldFabricate: false,
  };
}

// ---------------------------------------------------------------------------
// trCreate
// ---------------------------------------------------------------------------

/**
 * Create a transport request.
 *
 * The response is not XML and not a 201: HTTP 200, `text/plain`, body is exactly the
 * relative path `/com.sap.cts/object_record/A4HK900121`, no `Location` header. The number is
 * the last path segment, validated before being handed back.
 *
 * `authorized` must be minted by `SafetyGate.authorize("transport", { name: input.devClass,
 * packageName: input.devClass }, ...)` — the package being created into, not the
 * not-yet-existing transport number. See `opCreate` in `src/tools/transport.ts`.
 */
export async function trCreate(
  conn: AbapConnection,
  input: TrCreateInput,
  authorized: AuthorizedTarget<"transport", { name: string; packageName?: string }>,
): Promise<TrCreated> {
  // Runtime backstop, mirroring `assertAuthorizedMatches` in `src/adt/bopf.ts`: the type
  // system guarantees SOME AuthorizedTarget was minted, not that it matches THIS package.
  // Refuse fail-closed on any mismatch, before the wire call.
  const authName = authorized.target.name.trim().toUpperCase();
  const actualName = input.devClass.trim().toUpperCase();
  if (authName !== actualName) {
    throw new AbapError(
      "SAFETY_DENIED",
      `Internal wiring error in trCreate: the AuthorizedTarget names "${authorized.target.name}", but the ` +
        `request is about to be created for package "${input.devClass}". An AuthorizedTarget minted for one ` +
        "package must never be threaded into a call that creates a request for a different one.",
      { authorizedName: authorized.target.name, actualName: input.devClass },
      "This indicates a bug in the caller — mint a fresh AuthorizedTarget for the actual devClass.",
    );
  }
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>` +
    `<DEVCLASS>${escapeXml(input.devClass)}</DEVCLASS>` +
    `<REQUEST_TEXT>${escapeXml(input.description)}</REQUEST_TEXT>` +
    `<REF>${escapeXml(input.objSourceUrl)}</REF>` +
    `<OPERATION>${escapeXml(input.operation ?? "I")}</OPERATION>` +
    `</DATA></asx:values></asx:abap>`;

  let raw: string;
  try {
    const resp = await conn.post(TRANSPORTS, {
      headers: { Accept: "text/plain", "Content-Type": CREATE_REQUEST_TYPE },
      qs: input.transportLayer ? { transportLayer: input.transportLayer } : undefined,
      body,
    });
    raw = resp.body ?? "";
  } catch (e) {
    throw ctsError(e, "trCreate");
  }

  const path = raw.trim();
  const trkorr = (path.split("/").pop() ?? "").trim().toUpperCase();
  if (!isTrkorr(trkorr)) {
    throw new AbapError(
      "TRANSPORT_ERROR",
      `Transport creation returned an unrecognised response: ${JSON.stringify(path)}`,
      { operation: "trCreate", body: path },
      "Expected a path like /com.sap.cts/object_record/A4HK900121.",
    );
  }
  return { trkorr, path };
}

// ---------------------------------------------------------------------------
// trShow / trList / trUsers
// ---------------------------------------------------------------------------

/**
 * Read one request (or task) with its tasks and objects.
 *
 * **The sibling-task shape.** `GET /cts/transportrequests/<task>` answers with the task's
 * PARENT request, where `<tm:task>` is a **sibling** of `<tm:request>` under `<tm:root>`, not
 * nested inside it as every other captured shape has it. `requestFromTm` only collects
 * nested children, so without the merge below the named task would be silently absent from
 * `.tasks`. The merge only runs when a `<tm:request>` node was found, and is deduped by
 * `trkorr` so a shape that both nests and sibling-lists the same task can't double it up.
 */
export async function trShow(conn: AbapConnection, trkorr: string): Promise<TrRequest> {
  const number = assertTrkorr(trkorr, "trShow");
  let body: string;
  try {
    const resp = await conn.get(`${TRANSPORT_REQUESTS}/${encodeURIComponent(number)}`, {
      headers: { Accept: ORGANIZER_TYPE },
    });
    body = resp.body;
  } catch (e) {
    throw ctsError(e, "trShow", number);
  }
  const root = node(child(parse(body), "root"));
  const requestNode = node(child(root, "request"));
  const request = requestNode ?? node(child(root, "task"));
  if (!request) {
    throw new AbapError("TRANSPORT_ERROR", `No transport request in the response for ${number}`, {
      operation: "trShow",
      trkorr: number,
    });
  }
  const result = requestFromTm(request);
  if (requestNode) {
    const siblingTasks = many(child(root, "task")).map(taskFromTm);
    if (siblingTasks.length > 0) {
      const seen = new Set(result.tasks.map((t) => t.trkorr));
      for (const t of siblingTasks) {
        if (seen.has(t.trkorr)) continue;
        seen.add(t.trkorr);
        result.tasks.push(t);
      }
    }
  }
  return result;
}

/** Which of a request or its tasks actually carries a named entry — see {@link trFindEntryHolder}. */
export interface TrEntryHolder {
  /** The request or task whose own object list carries the entry. */
  trkorr: string;
  /** True when {@link trkorr} is a task of the request `trShow` returned. */
  onTask: boolean;
  /** The number the caller passed, normalised. */
  requested: string;
  /** Every row on {@link trkorr} whose object name matches exactly. */
  rows: TrObject[];
}

/**
 * Find which of a request's own object list, or one of its tasks', actually carries a named
 * entry. `trShow`'s `objects` is the UNION of the request's and all its tasks' rows (its own
 * doc comment above), so an entry that in fact lives on a task would be misreported as living
 * on the request if `req.objects` were consulted first — tasks are checked before the request
 * for exactly this reason. Read-only, one network call.
 */
export async function trFindEntryHolder(
  conn: AbapConnection,
  trkorr: string,
  objectName: string,
): Promise<TrEntryHolder> {
  const number = assertTrkorr(trkorr, "trFindEntryHolder");
  const name = (objectName ?? "").trim().toUpperCase();
  const matches = (objs: TrObject[]): TrObject[] => objs.filter((o) => o.name.toUpperCase() === name);

  const req = await trShow(conn, number);
  for (const task of req.tasks) {
    const rows = matches(task.objects);
    if (rows.length > 0) return { trkorr: task.trkorr, onTask: true, requested: number, rows };
  }
  const rows = matches(req.objects);
  if (rows.length > 0) return { trkorr: req.trkorr, onTask: false, requested: number, rows };

  throw new AbapError(
    "NOT_FOUND",
    `No entry for ${name} on ${number} or its tasks.`,
    { operation: "trFindEntryHolder", trkorr: number, object: name, tasks: req.tasks.map((t) => t.trkorr) },
    `Run abap_transport with operation "show" and transport "${number}" to see what this request actually holds.`,
  );
}

/** Requests directly under a category node and under any of its status groups. */
function collectRequests(category: Node | undefined): TrRequest[] {
  if (!category) return [];
  const out: TrRequest[] = [];
  for (const [key, value] of Object.entries(category)) {
    if (key.startsWith("@_") || key === "#text") continue;
    if (key === "request") {
      out.push(...many(value).map(requestFromTm));
      continue;
    }
    for (const group of many(value)) {
      out.push(...collectRequests(group));
    }
  }
  return out;
}

/**
 * Requests grouped into workbench and customizing.
 *
 * The tree nests `tm:request` under status groups (`tm:modifiable`, `tm:released`) and,
 * when `targets=true`, under target groups too; those groupings are flattened away since
 * per-request status is already on the header. `targets` defaults to `false` — this system
 * has no transport route.
 *
 * `<tm:root>` is not limited to `tm:workbench`/`tm:customizing` (a captured
 * search-configuration response also carries a real `tm:transportofcopies` category), so
 * every direct child of `<tm:root>` is visited generically by name, not just the two known
 * categories — a category the wire adds tomorrow is collected too, not dropped.
 *
 * {@link TrList}'s shape is frozen at `{ workbench, customizing }`, so any other category is
 * appended to `workbench` rather than lost. This is honest, not a mislabel: each request's
 * real classification lives on its own header (`kind`/`kindRaw`, from {@link toKind}),
 * independent of which XML category it was nested under — a caller that cares filters on
 * `kind`, not on which array it landed in.
 */
export async function trList(conn: AbapConnection, opts: TrListOptions = {}): Promise<TrList> {
  const qs: Record<string, string> = { targets: String(opts.targets ?? false) };
  if (opts.configUri) qs.configUri = opts.configUri;
  else if (opts.user) qs.user = opts.user;

  let body: string;
  try {
    const resp = await conn.get(TRANSPORT_REQUESTS, { headers: { Accept: "*/*" }, qs });
    body = resp.body;
  } catch (e) {
    throw ctsError(e, "trList");
  }

  const root = node(child(parse(body), "root"));
  const categories = new Map<string, TrRequest[]>();
  if (root) {
    for (const [key, value] of Object.entries(root)) {
      if (key.startsWith("@_") || key === "#text") continue;
      const category = node(value);
      if (!category) continue;
      categories.set(key, collectRequests(category));
    }
  }

  const workbench = categories.get("workbench") ?? [];
  const customizing = categories.get("customizing") ?? [];
  // Any other category — surfaced in `workbench` rather than dropped (see doc comment above).
  const other = [...categories.entries()]
    .filter(([key]) => key !== "workbench" && key !== "customizing")
    .flatMap(([, requests]) => requests);

  return { workbench: [...workbench, ...other], customizing };
}

// ---------------------------------------------------------------------------
// Search configurations (list precondition)
// ---------------------------------------------------------------------------
//
// `GET .../transportrequests` only returns `tm:modifiable` when called with a `configUri`
// pointing at a persisted, per-user "search configuration" object — see the warning on
// {@link TrListOptions}. No query-param shortcut exists; ADT silently drops unrecognised
// params rather than erroring.
//
// `trSearchConfigurations` is a plain read; `trCreateSearchConfiguration` is a plain write
// taking a `TransportCeilingProof`, like the ceiling-gated functions above. The *decision*
// of whether to create one belongs to the caller (`opList`, src/tools/transport.ts), which
// holds the `SafetyGate`.

const SEARCH_CONFIGURATIONS = `${TRANSPORT_REQUESTS}/searchconfiguration/configurations`;
const CONFIGURATIONS_TYPE = "application/vnd.sap.adt.configurations.v1+xml";
const CONFIGURATION_TYPE = "application/vnd.sap.adt.configuration.v1+xml";

/** One saved CTS search configuration, enough to drive {@link trList} via `configUri`. */
export interface TrSearchConfig {
  /** Absolute path, e.g. `/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/<id>`. Pass as `TrListOptions.configUri`. */
  uri: string;
  /** `configuration:property[key="User"]`, when the entry carries one. */
  user?: string;
}

/**
 * Every `<configuration:configuration>` entry in a response, found generically by its
 * `atom:link[type="<CONFIGURATION_TYPE>"]` rather than a specific wrapper tag or `rel` value.
 * The single-entry and list shapes use two different `rel` values for the same link
 * (`"self"` vs. a categories URL) — matching on `rel="self"` alone silently found zero
 * entries in the list shape, so `rel` is deliberately not inspected at all; only
 * `type="application/vnd.sap.adt.configuration.v1+xml"` (`CONFIGURATION_TYPE`) is checked,
 * since all captured shapes agree on it. See the git history for
 * the fixture-by-fixture trace.
 */
function parseSearchConfigurations(body: string): TrSearchConfig[] {
  const out: TrSearchConfig[] = [];
  walkForConfigEntries(parse(body), out);
  return out;
}

function walkForConfigEntries(value: unknown, out: TrSearchConfig[]): void {
  const n = node(value);
  if (!n) {
    if (Array.isArray(value)) for (const v of value) walkForConfigEntries(v, out);
    return;
  }
  const configLink = many(child(n, "link")).find((l) => attr(l, "type") === CONFIGURATION_TYPE);
  const href = configLink ? attr(configLink, "href") : "";
  if (href) {
    out.push({ uri: href, user: optional(propertyValue(n, "User")) });
    return; // this node is a configuration entry — do not also recurse into it
  }
  for (const [key, v] of Object.entries(n)) {
    if (key.startsWith("@_") || key === "#text") continue;
    for (const item of many(v)) walkForConfigEntries(item, out);
  }
}

/** `<configuration:properties><configuration:property key="User">DEVELOPER</...></...>` → `"DEVELOPER"`. */
function propertyValue(configNode: Node, key: string): string {
  const props = node(child(configNode, "properties"));
  const match = many(child(props, "property")).find((p) => attr(p, "key") === key);
  return match ? text(match) : "";
}

/**
 * List this session's saved CTS search configurations. Pure read — issues a
 * single GET, never a write.
 */
export async function trSearchConfigurations(conn: AbapConnection): Promise<TrSearchConfig[]> {
  let body: string;
  try {
    const resp = await conn.get(SEARCH_CONFIGURATIONS, { headers: { Accept: CONFIGURATIONS_TYPE } });
    body = resp.body;
  } catch (e) {
    throw ctsError(e, "trSearchConfigurations");
  }
  return parseSearchConfigurations(body);
}

/**
 * Create a new saved search configuration for the connected user, using the server's own
 * defaults (empty POST body — confirmed live 201 Created, with `Modifiable`/`Released`/etc.
 * defaulting to `true` and `User` to the connected user). The URI comes from the `Location`
 * header, falling back to the body ({@link parseSearchConfigurations}) if omitted.
 *
 * A genuine, durable write — outlives this call and session on the connected user's account
 * — so it takes a `TransportCeilingProof`, like the ceiling-gated functions above.
 */
export async function trCreateSearchConfiguration(
  conn: AbapConnection,
  proof: TransportCeilingProof,
): Promise<TrSearchConfig> {
  void proof; // proof of authorization; carries no data this function needs
  let resp: { body: string; status: number; headers: Record<string, unknown> };
  try {
    resp = await conn.post(SEARCH_CONFIGURATIONS, { headers: { Accept: CONFIGURATION_TYPE } });
  } catch (e) {
    throw ctsError(e, "trCreateSearchConfiguration");
  }
  const location = resp.headers["location"] ?? resp.headers["Location"];
  if (typeof location === "string" && location.trim() !== "") {
    return { uri: location.trim() };
  }
  const [fromBody] = parseSearchConfigurations(resp.body ?? "");
  if (fromBody) return fromBody;
  throw new AbapError(
    "TRANSPORT_ERROR",
    "Search-configuration creation returned neither a Location header nor a parseable body.",
    { operation: "trCreateSearchConfiguration" },
  );
}

/** Users known to the system, for owner/task assignment. */
export async function trUsers(conn: AbapConnection): Promise<TrUser[]> {
  let body: string;
  try {
    const resp = await conn.get(SYSTEM_USERS, {
      headers: { Accept: "application/atom+xml;type=feed" },
    });
    body = resp.body;
  } catch (e) {
    throw ctsError(e, "trUsers");
  }
  const feed = node(child(parse(body), "feed"));
  return many(child(feed, "entry"))
    .map((entry) => ({ id: childText(entry, "id"), title: childText(entry, "title") }))
    .filter((u) => !!u.id);
}

// ---------------------------------------------------------------------------
// trAddUser / trSetOwner
// ---------------------------------------------------------------------------

function tmAction(trkorr: string, targetUser: string, action: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:number="${escapeXml(trkorr)}" ` +
    `tm:targetuser="${escapeXml(targetUser)}" tm:useraction="${action}"/>`
  );
}

/**
 * Add a user to a request by creating a task for them.
 *
 * `proof` must be minted by `authorizeCeiling(gate, "transport")` — see the
 * "Authorization proofs" section above for why this takes an object-less
 * ceiling proof rather than an `AuthorizedTarget`.
 */
export async function trAddUser(
  conn: AbapConnection,
  trkorr: string,
  user: string,
  proof: TransportCeilingProof,
): Promise<TrAddUserResult> {
  void proof; // proof of authorization; carries no data this function needs
  const number = assertTrkorr(trkorr, "trAddUser");
  const targetUser = (user ?? "").trim().toUpperCase();
  if (!targetUser) {
    throw new AbapError("BAD_INPUT", "A user name is required to add a task", {
      operation: "trAddUser",
      trkorr: number,
    });
  }
  let body: string;
  try {
    const resp = await conn.post(`${TRANSPORT_REQUESTS}/${encodeURIComponent(number)}/tasks`, {
      headers: { Accept: "application/*", "Content-Type": "text/plain" },
      body: tmAction(number, targetUser, "newtask"),
    });
    body = resp.body ?? "";
  } catch (e) {
    throw ctsError(e, "trAddUser", number);
  }
  // No fixture exists for this response, so nothing is assumed about it: the
  // task number is reported only if the server volunteers one.
  const root = node(child(parse(body), "root"));
  const created = attr(node(child(root, "task")), "number") || attr(root, "number");
  return {
    trkorr: number,
    user: targetUser,
    task: created && created !== number ? created : undefined,
  };
}

/**
 * Reassign a request to a different owner.
 *
 * `proof` must be minted by `authorizeCeiling(gate, "transport")`.
 */
export async function trSetOwner(
  conn: AbapConnection,
  trkorr: string,
  user: string,
  proof: TransportCeilingProof,
): Promise<TrSetOwnerResult> {
  void proof; // proof of authorization; carries no data this function needs
  const number = assertTrkorr(trkorr, "trSetOwner");
  const targetUser = (user ?? "").trim().toUpperCase();
  if (!targetUser) {
    throw new AbapError("BAD_INPUT", "A user name is required to change the owner", {
      operation: "trSetOwner",
      trkorr: number,
    });
  }
  try {
    await conn.put(`${TRANSPORT_REQUESTS}/${encodeURIComponent(number)}`, {
      headers: { Accept: "application/*" },
      qs: { targetuser: targetUser },
      body: tmAction(number, targetUser, "changeowner"),
    });
  } catch (e) {
    throw ctsError(e, "trSetOwner", number);
  }
  return { trkorr: number, owner: targetUser };
}

// ---------------------------------------------------------------------------
// trDelete
// ---------------------------------------------------------------------------

/**
 * Read a request, treating "does not exist" as an answer rather than a failure — and resolve
 * `own`, the NAMED entity's own header, separately from `request` (whatever `trShow`
 * actually answered about). For a task, `trShow` answers about its PARENT, so `own` is
 * looked up in `request.tasks`; `trDelete` must judge `own`, since `request`'s mere presence
 * proves nothing about a deleted task.
 */
async function probe(
  conn: AbapConnection,
  trkorr: string,
): Promise<{ request?: TrRequest; own?: TrHeader; error?: AbapError }> {
  try {
    const request = await trShow(conn, trkorr);
    const own = request.trkorr === trkorr ? request : request.tasks.find((t) => t.trkorr === trkorr);
    return { request, own };
  } catch (e) {
    if (e instanceof AbapError && e.code === "TRANSPORT_GONE") return {};
    return { error: e instanceof AbapError ? e : ctsError(e, "trShow", trkorr) };
  }
}

// A status-bearing refusal means SAP answered "no" and deleted nothing; only a
// session death or a response lost before any status was seen may have landed.
function deleteMayHaveLanded(err: unknown): err is AbapError {
  return (
    isAbapError(err) &&
    (err.code === "SESSION_DEAD" || (err.code === "TRANSPORT_ERROR" && err.details.status === undefined))
  );
}

// Re-probes a landed-maybe DELETE and folds the outcome into the error's hint —
// code/message untouched, same shape as discloseBridgeResidue in run.ts.
async function discloseDeleteFailure(err: unknown, conn: AbapConnection, number: string): Promise<unknown> {
  if (!deleteMayHaveLanded(err)) return err;
  const after = await probe(conn, number);
  const residueHint = after.error
    ? "The outcome could not be verified: a post-failure check of the request also failed. " +
      "Do not retry blindly — list or show it first."
    : after.own
      ? "A post-failure check found the request still present — nothing was deleted."
      : "A post-failure check could not find the request anymore — the delete may have landed " +
        "despite the failure. Do not retry blindly; list or show it first.";
  const disclosed = new AbapError(
    err.code,
    err.message,
    { ...err.details, postFailureProbe: after.error ? "failed" : after.own ? "present" : "gone" },
    err.hint ? `${err.hint} ${residueHint}` : residueHint,
  );
  disclosed.stack = err.stack;
  disclosed.cause = err.cause;
  return disclosed;
}

/**
 * Delete a request, then prove it.
 *
 * `DELETE` is not evidence of anything here: deleting a never-existent number and deleting a
 * real one produced byte-identical HTTP 200 empty responses. Only a subsequent `GET`
 * distinguishes them (400 "does not exist in system" once gone).
 *
 * So this reads before and after, judging `own` (the NAMED entity's own header, from
 * {@link probe}) rather than the bare presence of `request` — a task's PARENT can easily
 * still exist after the task itself is gone, so judging `request` alone would render a
 * successfully deleted task a false negative:
 *
 *   - `existedBefore: false` — the number never named anything; `deleted` stays `false`
 *     even though DELETE returned 200.
 *   - `deleted: true` requires both prior existence and provable absence afterwards.
 *   - If the post-read fails for an unrelated reason, `verified` and `deleted` stay `false`.
 *
 * `proof` must be minted by `authorizeCeiling(gate, "transport")` — NOT `"delete"`, which
 * would make this call fail closed unconditionally (see the ceiling section above).
 */
export async function trDelete(
  conn: AbapConnection,
  trkorr: string,
  proof: TransportCeilingProof,
): Promise<TrDeleteResult> {
  void proof; // proof of authorization; carries no data this function needs
  const number = assertTrkorr(trkorr, "trDelete");

  const before = await probe(conn, number);
  if (before.error) throw before.error;

  let httpStatus: number | undefined;
  try {
    const resp = await conn.del(`${TRANSPORT_REQUESTS}/${encodeURIComponent(number)}`, {
      headers: { Accept: "application/*" },
    });
    httpStatus = resp.status;
  } catch (e) {
    // Real refusals do throw: 400 for "already released (not modifiable)" and
    // for "cannot be deleted because it contains locked objects". But the DELETE
    // may have landed anyway before the response was lost — re-probe to disclose
    // what actually happened, same as the byte-identical-200 case below.
    throw await discloseDeleteFailure(ctsError(e, "trDelete", number), conn, number);
  }

  const after = await probe(conn, number);
  const verified = !after.error;
  const gone = verified && !after.own;

  return {
    trkorr: number,
    deleted: Boolean(before.own) && gone,
    existedBefore: Boolean(before.own),
    verified,
    gone,
    httpStatus,
    verificationError: after.error ? after.error.message : undefined,
    remaining: verified && after.own ? after.request : undefined,
  };
}

// ---------------------------------------------------------------------------
// trRelease
// ---------------------------------------------------------------------------

const LONGTEXT_RE = /\/messageclass\/([^/]+)\/messages\/([^/?]+)\//;

function releaseMessages(report: Node): TrReleaseMessage[] {
  const list = node(child(report, "checkMessageList"));
  return many(child(list, "checkMessage")).map((m) => {
    const link = many(child(m, "link")).find((l) => /longtext/i.test(attr(l, "rel")));
    const href = link ? attr(link, "href") : "";
    const parsed = LONGTEXT_RE.exec(href);
    return {
      type: attr(m, "type"),
      text: attr(m, "shortText"),
      messageClass: parsed?.[1],
      messageNumber: parsed?.[2],
      uri: optional(attr(m, "uri")),
      longtextUri: optional(href),
    };
  });
}

/**
 * Release a request, then find out what actually happened to it.
 *
 * Two traps here. First, HTTP status is useless: every captured outcome, success or abort,
 * is HTTP 200. The real discriminator is `chkrun:checkReport`'s `@chkrun:status`, where
 * `"released"` is success and anything else is an abort report.
 *
 * Second, and worse: **an abort report does not mean the release failed, and a `released`
 * report is not proof it succeeded either** — a `PU/238` abort was reproduced live where the
 * request was in fact Released immediately after. So this unconditionally re-reads the
 * request afterwards and reports its real status alongside the envelope's claim via
 * {@link TrReleaseResult.outcome}; `reportedReleased` and `actualStatus` are both returned,
 * separately, and neither is trusted alone.
 *
 * Abort statuses collapse almost everything into `abortrelapifail`; the stable reason code is
 * the ABAP message class/number parsed out of each message's longtext link, which is why
 * {@link TrReleaseMessage} carries them as fields rather than only as prose.
 *
 * No `ignoreLocks`/`ignoreATC` parameter exists — those endpoints are denied structurally by
 * the HTTP guard.
 *
 * `proof` must be minted by `authorizeCeiling(gate, "transport", { release: true })` —
 * release has its own ceiling flag (`ABAP_ALLOW_TRANSPORT_RELEASE`) on top of
 * `ABAP_ALLOW_WRITE`.
 */
export async function trRelease(
  conn: AbapConnection,
  trkorr: string,
  proof: TransportCeilingProof,
): Promise<TrReleaseResult> {
  void proof; // proof of authorization; carries no data this function needs
  const number = assertTrkorr(trkorr, "trRelease");

  let body: string;
  try {
    const resp = await conn.post(
      `${TRANSPORT_REQUESTS}/${encodeURIComponent(number)}/newreleasejobs`,
      { headers: { Accept: "application/*" } },
    );
    body = resp.body ?? "";
  } catch (e) {
    throw ctsError(e, "trRelease", number);
  }

  const root = node(child(parse(body), "root"));
  const reportsNode = node(child(root, "releasereports"));
  const reports: TrReleaseReport[] = many(child(reportsNode, "checkReport")).map((r) => {
    const status = attr(r, "status");
    return {
      trkorr: attr(root, "number") || number,
      reporter: optional(attr(r, "reporter")),
      triggeringUri: optional(attr(r, "triggeringUri")),
      status,
      statusText: optional(attr(r, "statusText")),
      reportedReleased: status === RELEASE_OK,
      messages: releaseMessages(r),
    };
  });

  const messages = reports.flatMap((r) => r.messages);
  // An absent or unparseable report is not success.
  const reportedReleased = reports.length > 0 && reports.every((r) => r.reportedReleased);

  const result: TrReleaseResult = {
    trkorr: number,
    outcome: reportedReleased ? "released" : "unknown",
    reportedReleased,
    verified: false,
    releaseTimestamp: optional(attr(root, "releasetimestamp")),
    reports,
    messages,
  };

  // The envelope is not authoritative in either direction, so the re-read always runs
  // regardless of its claim, and the two claims are reconciled below.
  let request: TrRequest | undefined;
  try {
    request = await trShow(conn, number);
  } catch (e) {
    const verificationError =
      e instanceof AbapError && e.code === "TRANSPORT_GONE"
        ? `Request ${number} could not be re-read because it no longer exists: ${e.message}`
        : e instanceof Error
          ? e.message
          : describeUnknownError(e);

    if (reportedReleased) {
      // Re-read failed after a claimed success — don't downgrade a genuine success to
      // unknown; fall back to the envelope's claim but mark it unverified.
      return { ...result, verificationError };
    }

    // Envelope didn't claim success and the re-read failed — can't settle what happened.
    return { ...result, outcome: "unknown", verified: false, verificationError };
  }

  const outcome: TrReleaseOutcome = reportedReleased
    ? request.status === "released"
      ? "released"
      : "unknown" // contradiction: envelope said released, re-read disagrees
    : request.status === "released"
      ? "released-despite-abort"
      : request.status === "modifiable" || request.status === "protected"
        ? "aborted"
        : "unknown";

  return {
    ...result,
    outcome,
    verified: true,
    actualStatus: request.status,
    actualStatusText: request.statusText,
    request,
  };
}
