/**
 * Structured errors surfaced across the MCP tool boundary.
 *
 * Every error the tools return carries a stable machine-readable `code` so the
 * model can react without string-matching prose.
 */

export type AbapErrorCode =
  | "AUTH_CIRCUIT_OPEN"
  | "CIRCUIT_OPEN_TRANSIENT"
  | "AUTH_FAILED"
  /**
   * 5xx from ABAP during `connect()`'s login — system down/restarting, not
   * a credential problem. Minted only by `classifyConnectFailure`
   * (`src/adt/connect-failure.ts`). Not `AUTH_FAILED` (SAP never got far
   * enough to check a credential) or `ADT_ERROR` (that's the unidentified
   * fallback); distinct from `classifySessionFailure`'s mid-session 500
   * handling. Full rationale: the git history.
   */
  | "SYSTEM_UNAVAILABLE"
  /**
   * `connect()`'s login never reached the ABAP system at all (ECONNREFUSED,
   * ENOTFOUND, ETIMEDOUT, TLS handshake failure — below HTTP). Minted only
   * by `classifyConnectFailure` (`src/adt/connect-failure.ts`).
   * Not `AUTH_FAILED` (nothing was sent to authenticate) and not
   * `TRANSPORT_ERROR` (that name means a SAP CTS transport request here,
   * see `TRANSPORT_LOCKED`/`TRANSPORT_GONE`). Full rationale:
   * the git history.
   */
  | "CONNECT_FAILED"
  | "NOT_CONNECTED"
  | "NOT_FOUND"
  | "AMBIGUOUS"
  | "UNSUPPORTED"
  | "READ_ONLY"
  /**
   * The system-role probe never got an answer — the connection dropped below
   * HTTP before `T000-CCCATEGORY` could be read — so the system is
   * unclassified and the gate stays closed. Not `READ_ONLY`: no capability
   * switch, flag or allowlist is involved and none lifts it. Not
   * `SYSTEM_UNAVAILABLE`/`CONNECT_FAILED`, which are `connect()`'s own logon
   * failing; this probe runs after a successful logon and its failure is
   * swallowed, so `connect()` still resolves. Minted only by `SafetyGate`
   * from `SafetyConfig.roleProbeFailure`. The lockout it reports is the
   * one-way latch described in doc/SAFETY/safety-gate.md, so it clears on a server
   * restart, not on a retried tool call.
   */
  | "ROLE_PROBE_FAILED"
  | "SAFETY_DENIED"
  | "ADT_ERROR"
  | "TRANSPORT_ERROR"
  | "BAD_INPUT"
  // ---- write path ----
  /** Compare-before-write failed: the object changed since the caller read it. */
  | "ETAG_CONFLICT"
  /**
   * A FULL-SOURCE write presented a `partial:`-marked etag (see
   * `PARTIAL_ETAG_PREFIX` in src/compact.ts) — the caller never saw the full
   * text it's about to overwrite, which would silently delete everything past
   * the truncation point. Not `ETAG_CONFLICT` (nothing changed
   * server-side; re-read/re-apply would just repeat the truncation) and not
   * `BAD_INPUT` (the request is well-formed). Full rationale:
   * the git history.
   */
  | "PARTIAL_READ_SOURCE"
  /** Another session (or user) holds the ADT enqueue lock. */
  | "LOCKED"
  /** Activation or syntax check reported errors. Details carry the messages. */
  | "CHECK_FAILED"
  /** The ABAP session died (short dump, `400 Session Timed Out`). NOT an auth failure. */
  | "SESSION_DEAD"
  /** The executed ABAP code short-dumped. */
  | "RUNTIME_DUMP"
  // ---- journal + undo ----
  /**
   * The local write journal could not be read or written — disk full, bad
   * permissions, `ABAP_JOURNAL_DIR` unwritable. Not `SAFETY_DENIED`: this is
   * local disk I/O, not an ABAP-system safety refusal.
   */
  | "JOURNAL_IO"
  // ---- transports ----
  /**
   * The object is pinned to a transport request owned by someone other than
   * the connected user (`trRequirement().pinnedTo`, `pinnedOwner` mismatch).
   * The server will not write through it and will not create a competing
   * request. Message names the TRKORR and the owner.
   */
  | "TRANSPORT_LOCKED"
  /**
   * The session's transport request was released, deleted, or otherwise
   * became unknown to the server, discovered mid-session. Fired exactly once
   * for the TRKORR that died; the connection state moves on (e.g. `gone` ->
   * `idle`) so this is not re-thrown on subsequent operations.
   */
  | "TRANSPORT_GONE"
  /**
   * `GuardedHttpClient` refused a URL or method by policy, checked before any
   * network activity. Should be unreachable in normal operation — seeing it
   * means either a dependency changed its URLs or something tried to reach
   * an unapproved endpoint. Message includes the method and path, but never
   * the query string (it can carry identifiers).
   */
  | "HTTP_PATH_DENIED"
  // ---- BOPF (design-time authoring) ----
  /**
   * A BOPF business object references a class/structure/table that does not
   * exist (or a bare TADIR class with no `IMPLEMENTATION`). Not `NOT_FOUND`:
   * the model is well-formed, the problem is a dangling reference inside it.
   */
  | "BOPF_DANGLING_REF"
  // ---- Enhancements (design-time authoring) ----
  /**
   * `ABAP_ALLOW_ENHANCEMENTS` is unset/false, or `ABAP_ENHANCE_TARGETS=none`
   * (default). Not `READ_ONLY`: can refuse even when `ABAP_ALLOW_WRITE=true`.
   */
  | "ENHANCEMENT_DISABLED"
  /**
   * Target falls outside `ABAP_ENHANCE_TARGETS` / `ABAP_ENHANCE_TARGET_PACKAGES`
   * (empty `allowPackages` is a deliberate deny-all). Not `SAFETY_DENIED`:
   * that code doesn't name which allowlist to widen. Full rationale:
   * the git history.
   */
  | "ENHANCEMENT_TARGET_DENIED"
  /**
   * Non-overridable ceiling on repairing/modifying enhancement-implied
   * behaviour — no allowlist widens this, unlike `SAFETY_DENIED`.
   */
  | "REPAIR_REFUSED"
  /**
   * ADT REST refused to create the enhancement object at the controller
   * itself, not a payload problem — covers `enhoxh`'s "no create handler"
   * 400 and `enhsxs`'s 500 `ASSERTION_FAILED`. Not `ADT_ERROR`: that invites
   * retrying with a fixed payload, which won't fix a controller that can't
   * create anything. Full rationale: the git history.
   */
  | "ENHANCEMENT_CREATE_REFUSED"
  /**
   * The specific 500 (`enhsxs` create `ASSERTION_FAILED` in
   * `CL_ENH_ADT_ENHS_OBJ_PERSIST===CP`) known to destroy the ADT session.
   * Raised immediately at the failing call, unlike `SESSION_DEAD` (raised on
   * the next request, after the fact). Never retried in place.
   */
  | "ENHANCEMENT_SESSION_DESTROYED"
  /**
   * Enhancement activation POST returned 200 with a non-empty
   * `chkl:messages` body — failure despite the status. Stricter than
   * `CHECK_FAILED`: ANY non-empty checklist is a failure here, not only
   * `@type="E"` entries.
   */
  | "ENHANCEMENT_ACTIVATION_FAILED"
  /**
   * BAdI implementation delete refused: a `badiImplementation` entry reports
   * `isActive="true"` or omits `isActive` (unknown treated as active, per
   * `undoBlocker`'s policy in `src/adt/undo.ts`). No override exists — not
   * `SAFETY_DENIED`, which would invite widening a non-existent allowlist.
   */
  | "ENHANCEMENT_ACTIVE_IMPLEMENTATION"
  /**
   * Enhancement document PUT (`enhoxh`/`enhoxhh`/`enhsxs`) refused, pre-lock,
   * because `adtcore:description` is/would-become empty — SAP's PUT handler
   * rejects that unconditionally (400 `ExceptionInvalidData`,
   * `SWB_TOOL19`/`scr_prop_no_decr`), even for writes unrelated to the
   * description; live-confirmed against A4H. Not `BAD_INPUT` (the object's
   * own state, not the request, blocks the write) and not `ADT_ERROR` (fires
   * before any request reaches the server). Full rationale:
   * the git history.
   */
  | "ENHANCEMENT_DESCRIPTION_REQUIRED"
  /**
   * `exercise` got an unbound handle from `GET BADI` — `CALL BADI` was never
   * attempted (a silent no-op on an unbound multi-use handle). Not
   * `CHECK_FAILED`: the implementation can read back fully active while the
   * kernel's runtime dispatch cache stays stale (SAP Note 944559).
   * Live-confirmed via debugger (`objectref -> 0x0`). Full rationale:
   * the git history.
   */
  | "ENHANCEMENT_NOT_DISPATCHING"
  // ---- Cross-process object locking ----
  /**
   * `FileLockObjectGate` (src/adt/pool.ts) could not take the cross-process
   * lock within its wait budget — another process/GUI session genuinely
   * holds it, or the lock file is a not-yet-stale leftover
   * (`withFileLock`'s thresholds, src/state-dir.ts). Not `JOURNAL_IO`: that's
   * local disk, this is contention. Names holder pid/hostname/startedAt when
   * known.
   */
  | "OBJECT_LOCKED_CROSS_PROCESS"
  /**
   * `FileLockDebugArmLock` (src/debug/arm-lock.ts) could not take the
   * cross-process lock for this system+client+user's single debugger slot.
   * Distinct from `OBJECT_LOCKED_CROSS_PROCESS` (no ABAP object involved,
   * remediation is "stop the other debug session") and from the pool's
   * in-process `lease-held` refusal (`DEBUG_CONCURRENCY = 1`, this-process
   * only). Names holder pid/hostname/startedAt when known; dead-pid holders
   * are collected automatically (src/state-dir.ts).
   */
  | "DEBUG_SESSION_LOCKED_CROSS_PROCESS"
  // ---- Debugger ----
  /**
   * `step:"jumpToLine"` refused: `ABAP_ALLOW_DEBUG_JUMP_TO_LINE` unset/false
   * (`Config.allowDebugJumpToLine`), or no matching `confirm` echo. Not
   * `SAFETY_DENIED`/`READ_ONLY`/`BAD_INPUT` — none names the actual gate
   * (mirrors `ENHANCEMENT_DISABLED`). Ordinary stepping never uses this code.
   */
  | "DEBUG_JUMP_DISABLED"
  // ---- Runtime-error dumps (ST22) ----
  /**
   * Variable-contents tier of a runtime-error dump was requested and
   * `ABAP_ALLOW_DUMP_VARIABLES` is unset/false. Tier-1 dump reading (error
   * class, program, line, source, call stack) is never gated. Not
   * `READ_ONLY`: that would point at `ABAP_ALLOW_WRITE`, the opposite of the
   * relevant flag — this ceiling is orthogonal to writes on purpose.
   */
  | "DUMP_VARIABLES_DISABLED"
  // ---- Gate self-defence (abap_activate enhancement-intent fix) ----
  /**
   * The safety gate was called wrong — not a user-facing authorization
   * decision. `evaluate()`'s `phase: "final"` branch requires an
   * `EnhancementIntent` for any enhancement-type target; reaching this with
   * none means a call site resolved the target without building the intent
   * its own type demands (abapsmith's own wiring defect, not a legitimate
   * "no" — `abap_activate` shipped three such call sites deep before this
   * existed). Deliberately not `SAFETY_DENIED`, which would read as normal
   * operation and hide the bug. No flag silences this; fix the call site.
   * Full rationale: the git history.
   */
  | "INTERNAL_GATE_MISUSE"
  // ---- OData service introspection (src/adt/odata.ts, src/adt/edmx.ts) ----
  /**
   * The service binding exists and is activated but its OData service was
   * never **published** to the service runtime, so `$metadata` can't exist
   * yet — the state an agent gets stuck in most often. Not `NOT_FOUND`: the
   * binding name is right; the missing step is a publish action abapsmith
   * deliberately never performs (it mutates the system's runtime surface,
   * outside this feature's read-only scope). The hint carries the publish
   * instruction.
   */
  | "SERVICE_NOT_PUBLISHED"
  /**
   * The service runtime answered 401/403 for `$metadata`. Not `AUTH_FAILED`:
   * the ADT connection/session is fine — this user simply lacks the
   * OData-side authorization (`S_SERVICE`), or the SICF node is inactive.
   * Deliberately kept separate: collapsing this into `AUTH_FAILED` would
   * trip the connection's auth circuit breaker over a per-service
   * authorization problem and take the whole session down with it. Full
   * rationale: the git history.
   */
  | "SERVICE_METADATA_DENIED"
  /**
   * The service runtime answered 404 for a `$metadata` URL that was resolved
   * from a real, published binding. Distinct from `SERVICE_NOT_PUBLISHED`
   * (where the runtime never had the service) and from plain `NOT_FOUND`
   * (which is about repository objects): here the repository is consistent
   * and the *runtime registration* is stale or the ICF path is not active.
   */
  | "SERVICE_METADATA_NOT_FOUND"
  /**
   * Bytes came back but aren't an EDMX document — HTML logon page, ICF
   * error page, JSON, or malformed XML. Never `ADT_ERROR` (this body isn't
   * from ADT); the hint carries an excerpt of what arrived, to avoid a
   * hint-free dead end.
   */
  | "SERVICE_METADATA_UNPARSEABLE";

/**
 * `terminal` — no input the caller can supply satisfies this code.
 * `retryable` — a different argument genuinely would work.
 * `conditional` — depends on circumstances this layer cannot see, so no claim is made.
 */
export type Retryability = "terminal" | "retryable" | "conditional";

/**
 * Every {@link AbapErrorCode} classified once, here, instead of by hand at
 * each throw site. `Record<AbapErrorCode, Retryability>` is the enforcement:
 * adding a code to the union without adding it here is a compile error, and
 * so is a key here that is not in the union. Order mirrors the union above.
 * `terminal`/`retryable` entries carry a one-line reason; `conditional`
 * entries don't — see {@link Retryability}'s doc comment for what that means.
 */
export const RETRYABILITY: Record<AbapErrorCode, Retryability> = {
  AUTH_CIRCUIT_OPEN: "terminal", // circuit only clears on a server restart
  CIRCUIT_OPEN_TRANSIENT: "conditional",
  AUTH_FAILED: "terminal", // trips the circuit breaker; retrying risks locking a shared account
  SYSTEM_UNAVAILABLE: "conditional",
  CONNECT_FAILED: "conditional",
  NOT_CONNECTED: "conditional",
  NOT_FOUND: "retryable", // a different identifier could exist
  AMBIGUOUS: "retryable", // a more specific identifier resolves it
  UNSUPPORTED: "terminal", // no argument changes what the tool implements
  READ_ONLY: "terminal", // ABAP_ALLOW_WRITE gates this, not the call's arguments
  ROLE_PROBE_FAILED: "conditional",
  SAFETY_DENIED: "terminal", // the deny-list/allowlist forbids the object, not the request shape
  ADT_ERROR: "conditional",
  TRANSPORT_ERROR: "conditional",
  BAD_INPUT: "retryable", // a different argument can satisfy validation
  ETAG_CONFLICT: "conditional",
  PARTIAL_READ_SOURCE: "conditional",
  LOCKED: "conditional",
  CHECK_FAILED: "conditional",
  SESSION_DEAD: "conditional",
  RUNTIME_DUMP: "conditional",
  JOURNAL_IO: "conditional",
  TRANSPORT_LOCKED: "conditional",
  TRANSPORT_GONE: "conditional",
  HTTP_PATH_DENIED: "terminal", // policy denial checked before any network activity
  BOPF_DANGLING_REF: "conditional",
  ENHANCEMENT_DISABLED: "terminal", // the flag is off; no payload turns it on
  ENHANCEMENT_TARGET_DENIED: "terminal", // the allowlist excludes the target, not the request
  REPAIR_REFUSED: "terminal", // non-overridable ceiling, no allowlist widens it
  ENHANCEMENT_CREATE_REFUSED: "conditional",
  ENHANCEMENT_SESSION_DESTROYED: "conditional",
  ENHANCEMENT_ACTIVATION_FAILED: "conditional",
  ENHANCEMENT_ACTIVE_IMPLEMENTATION: "conditional",
  ENHANCEMENT_DESCRIPTION_REQUIRED: "retryable", // supplying a description satisfies the PUT
  ENHANCEMENT_NOT_DISPATCHING: "conditional",
  OBJECT_LOCKED_CROSS_PROCESS: "conditional",
  DEBUG_SESSION_LOCKED_CROSS_PROCESS: "conditional",
  DEBUG_JUMP_DISABLED: "terminal", // the flag is off; no argument enables it
  DUMP_VARIABLES_DISABLED: "terminal", // the flag is off; no argument enables it
  INTERNAL_GATE_MISUSE: "terminal", // a call-site wiring bug, not a caller-facing decision
  SERVICE_NOT_PUBLISHED: "conditional",
  SERVICE_METADATA_DENIED: "terminal", // an authorization gap, not a bad argument
  SERVICE_METADATA_NOT_FOUND: "conditional",
  SERVICE_METADATA_UNPARSEABLE: "conditional",
};

/** `undefined` for `conditional` — no claim either way. */
export function defaultRetryable(code: AbapErrorCode): boolean | undefined {
  const r = RETRYABILITY[code];
  return r === "conditional" ? undefined : r === "retryable";
}

/** Options for {@link AbapError} beyond its four positional fields. */
export interface AbapErrorOptions {
  /**
   * Defaults from {@link RETRYABILITY} for `code`; this option is a per-site
   * override for when a site knows more than its code does. `false` ⇒ no
   * input can satisfy this call; `true` ⇒ a different argument would work.
   * The key is omitted from the wire payload only when the code is
   * `conditional` and no site overrides.
   */
  retryable?: boolean;
}

export class AbapError extends Error {
  readonly code: AbapErrorCode;
  readonly details: Record<string, unknown>;
  readonly hint?: string;
  readonly retryable?: boolean;

  constructor(
    code: AbapErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    hint?: string,
    options?: AbapErrorOptions,
  ) {
    super(message);
    this.name = "AbapError";
    this.code = code;
    this.details = details;
    this.hint = hint;
    this.retryable = options?.retryable ?? defaultRetryable(code);
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.retryable !== undefined ? { retryable: this.retryable } : {}),
      ...(Object.keys(this.details).length ? { details: this.details } : {}),
    };
  }
}

export const isAbapError = (e: unknown): e is AbapError => e instanceof AbapError;

/**
 * Names the *kind* of a value, for when nothing better can be extracted from it.
 * Never throws: the input may be a null-prototype object or an exotic proxy.
 */
function kindOf(e: unknown): string {
  if (e === null) return "null";
  const t = typeof e;
  if (t !== "object") return t;
  try {
    const name = (e as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof name === "string" && name.trim() && name !== "Object") return `${name} object`;
  } catch {
    // Null-prototype object, revoked proxy, throwing getter — fall through.
  }
  return "object";
}

/**
 * `String(x)` that cannot throw. `String()` blows up on a null-prototype object
 * (no `toString`), on a symbol reached via interpolation, and on any value with
 * a throwing `toString`. Returns `""` when no string form is obtainable.
 */
function safeToString(e: unknown): string {
  try {
    return String(e);
  } catch {
    return "";
  }
}

/**
 * Best-effort message extraction from anything abap-adt-api / axios throws.
 * Contract: always returns a non-empty string — callers splice this straight
 * into an error envelope's `message`. Every branch is checked for emptiness;
 * the last resort still names what kind of thing was thrown. Full rationale:
 * the git history.
 */
export function describeUnknownError(e: unknown): string {
  // Real errors — but `.message` can be empty, or (untyped input) not a string.
  if (e instanceof Error) {
    const message = typeof e.message === "string" ? e.message : "";
    if (message.trim()) return message;
    const name = typeof e.name === "string" && e.name.trim() ? e.name.trim() : "Error";
    return `${name} was thrown with an empty message`;
  }

  if (typeof e === "string") {
    return e.trim() ? e : "an empty string was thrown as an error";
  }

  // The three values `JSON.stringify` maps to the value `undefined`.
  if (e === undefined) {
    return "`undefined` was thrown as an error (a rejected promise with no reason)";
  }
  if (typeof e === "function") {
    const name = typeof e.name === "string" && e.name.trim() ? e.name.trim() : "";
    return name
      ? `a function (${name}) was thrown as an error`
      : "an anonymous function was thrown as an error";
  }
  if (typeof e === "symbol") {
    // `String(sym)` is legal and yields `Symbol(desc)`; `\`${sym}\`` would throw.
    const text = safeToString(e).trim();
    return text ? `${text} was thrown as an error` : "a symbol was thrown as an error";
  }

  if (e === null) return "`null` was thrown as an error";

  // number / boolean / bigint: `String` is faithful and always non-empty.
  if (typeof e !== "object") {
    const text = safeToString(e).trim();
    return text ? text : `a ${typeof e} value was thrown as an error`;
  }

  // Objects. `JSON.stringify` can throw (BigInt members, circular structures,
  // throwing getters) and can *return* `undefined` (a `toJSON` that yields
  // `undefined`), so neither the value nor the call can be trusted blindly.
  let json: string | undefined;
  let jsonFailure = "";
  try {
    const out = JSON.stringify(e);
    if (typeof out === "string") json = out;
  } catch (inner) {
    jsonFailure =
      inner instanceof Error && typeof inner.message === "string" ? inner.message.trim() : "";
  }
  // `"{}"` is a non-empty string that says nothing — and it is what a
  // cross-realm `Error` serialises to, since `name`/`message` are not
  // enumerable. Keep looking in that case.
  if (json !== undefined && json.trim() && json !== "{}") return json;

  // Error-shaped but not an `Error` (cross-realm throw, axios-ish reject value).
  // The read itself is guarded: `message` may be a throwing getter.
  let duck: unknown;
  try {
    duck = (e as { message?: unknown }).message;
  } catch {
    duck = undefined;
  }
  if (typeof duck === "string" && duck.trim()) return duck;

  const text = safeToString(e).trim();
  if (text && text !== "[object Object]") return text;

  const kind = kindOf(e);
  return jsonFailure
    ? `an undescribable ${kind} was thrown as an error (JSON.stringify failed: ${jsonFailure})`
    : `an undescribable ${kind} was thrown as an error`;
}
