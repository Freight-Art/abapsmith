/**
 * 401 circuit breaker.
 *
 * `login/fails_to_user_lock` defaults to 5 — a retry loop on a stale password
 * locks the technical user. Rule: on the FIRST auth failure, stop and never
 * send another authenticated request for the life of the process.
 *
 * Lives below `abap-adt-api`'s `AdtHTTP.request()`, which itself retries once
 * on a login error — otherwise that retry reaches the network as a second
 * logon attempt. Must also trip on a 200 OK ICF "Logon failed" HTML page, not
 * just a real 401 — see the git history.
 * Conversely, a short dump (500 text/html, destroys the session -> subsequent
 * `400 Session Timed Out`) is a user's ABAP mistake and must NEVER trip the
 * breaker; `isSessionDeath()` filters it out first.
 *
 * Two independent machines, never sharing state:
 *  A. AUTH LATCH — permanent, one-way, no cooldown/recovery. `trip()` /
 *     `isTripped` / `info` / `onTrip()`.
 *  B. TRANSIENT MACHINE — closed -> open -> half-open -> closed, recoverable.
 *     `allowRequest()`, `recordSuccess()`, `recordTransientFailure()`,
 *     observed via `state` / `status()`.
 *
 * `isTripped` is ONLY the auth latch, never set by a transient failure —
 * `server.ts` and `connection.ts` depend on that exact meaning (see archive).
 * `state === "latched"` outranks every transient state.
 *
 * No `setTimeout`/`setInterval` anywhere: all timing is a comparison against
 * an injectable `now()`, checked lazily on the next call. Nothing here may
 * throw — `debug/transport.ts` makes pre-flight decisions off this object
 * inside a `try/finally`; listener exceptions are swallowed.
 */
import { isSessionDeath } from "./session.js";
import type { Config } from "../config.js";

// The credential-fingerprint registry, auth latch, and ICF/HTML classifier
// used to live here (this file was 4 modules in ~1700 lines). Now in
// auth-latch.ts / icf-classify.ts, re-exported below since every existing
// import site still imports them from circuit-breaker.js.
import {
  __resetAuthLatchForTests,
  __setAuthLatchDirForTests,
  AUTH_LATCH_TTL_MS,
  durableLatchPathFor,
  fingerprintCredentials,
  lookupTrippedFingerprint,
  recordTrippedFingerprint,
} from "./auth-latch.js";
export {
  __resetAuthLatchForTests,
  __setAuthLatchDirForTests,
  fingerprintCredentials,
  lookupTrippedFingerprint,
};
import {
  BENIGN_DEBUG_EXCEPTION_CLASSES,
  BENIGN_DEBUG_SUBTYPES,
  classifyAuthFailure,
  isBenignDebugFailure,
  isIcfLogonFailure,
  isIcfPasswordChangePage,
} from "./icf-classify.js";
export {
  BENIGN_DEBUG_EXCEPTION_CLASSES,
  BENIGN_DEBUG_SUBTYPES,
  classifyAuthFailure,
  isBenignDebugFailure,
  isIcfLogonFailure,
  isIcfPasswordChangePage,
};

export type TripReason =
  | "http-401"
  | "http-403-auth"
  | "icf-logon-page"
  | "icf-password-change"
  | "manual";

export interface TripInfo {
  reason: TripReason;
  message: string;
  status?: number;
  url?: string;
  at: Date;
}

export interface ResponseLike {
  status: number;
  headers?: Record<string, unknown>;
  body?: string;
}

/**
 * The externally visible state of the breaker.
 *
 * - `"closed"`    — normal operation, requests flow.
 * - `"open"`      — too many transient failures; requests are refused until the
 *                   cooldown elapses. Temporary and self-healing.
 * - `"half-open"` — the cooldown elapsed; exactly ONE probe request is allowed
 *                   through to find out whether the system recovered.
 * - `"latched"`   — the permanent auth latch. Outranks every other state.
 */
export type BreakerState = "closed" | "open" | "half-open" | "latched";

/**
 * What a failure means to the breaker.
 *
 * - `"ignored"`   — session death (short dump / session timeout). A user's ABAP
 *                   mistake. Trips nothing, counts for nothing.
 * - `"auth"`      — a credential problem. Latches permanently.
 * - `"transient"` — everything else. Feeds the cooldown machine.
 */
export type FailureClass = "auth" | "transient" | "ignored";

/** An immutable snapshot of both machines, safe to log or return to a tool. */
export interface BreakerStatus {
  state: BreakerState;
  /** True iff the permanent auth latch is set — i.e. exactly `isTripped`. */
  latched: boolean;
  /** Present iff `latched`. */
  authReason?: TripReason;
  /** Human-readable and actionable; deliberately distinct wording when latched. */
  message: string;
  consecutiveFailures: number;
  /** Short description of the most recent transient failure, if any. */
  lastFailure?: string;
  openedAt?: Date;
  /** Only when `state === "open"`. */
  nextProbeAt?: Date;
  /** Only when `state === "open"`; clamped at >= 0. */
  msUntilNextProbe?: number;
  /** True while a half-open probe is outstanding. */
  probeInFlight: boolean;
  /** The cooldown currently in force (grows on repeated probe failures). */
  cooldownMs: number;
}

export interface BreakerOptions {
  /** Base cooldown applied when the breaker first opens. Default 30_000. */
  cooldownMs?: number;
  /** Ceiling for the doubling backoff. Default 300_000. */
  maxCooldownMs?: number;
  /** Consecutive transient failures needed to open from closed. Default 3. */
  failureThreshold?: number;
  /** Injectable clock. Default `() => Date.now()`. */
  now?: () => number;
  /**
   * Set only by `AbapConnection`'s constructor (when no explicit `breaker`
   * was given). A real trip is then also recorded process-wide keyed on this
   * fingerprint, so a second connection with the same rejected credentials
   * never issues a network call — see `lookupTrippedFingerprint()`. Opaque:
   * used only as a Map key, never surfaced via `info`/`status()`/errors.
   */
  credentialFingerprint?: string;
}

const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_MAX_COOLDOWN_MS = 300_000;
const DEFAULT_FAILURE_THRESHOLD = 3;

/**
 * Fed to `fingerprintCredentials` in place of a password when `cfg.password`
 * is `undefined` (cookie auth). A fixed string literal — never derived
 * from `cfg.sessionCookie` in any way, so no cookie name, value, hash or
 * length can reach the fingerprint that `INSTALL_SALT` (`auth-latch.ts`)
 * hashes onto disk. Its only job is keeping password-auth and cookie-auth
 * off the same durable auth-latch entry.
 */
const NO_PASSWORD_CREDENTIAL_DISCRIMINATOR = " session-cookie-auth";



/** `isResponseLike` as a narrowing cast: the value if it is response-shaped, else `undefined`. */
function asResponseLike(input: unknown): ResponseLike | undefined {
  return isResponseLike(input) ? input : undefined;
}

/** Structural test for "this thing is response-shaped", i.e. has a numeric status. */
function isResponseLike(input: unknown): input is ResponseLike {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { status?: unknown }).status === "number"
  );
}

/**
 * Classify an arbitrary failure — response, `Error`, or garbage. Order
 * mirrors `classifyAuthFailure`: session death -> `"ignored"` (never trips
 * anything), auth shape -> `"auth"`, else -> `"transient"`. A non-response
 * input (bare `Error`, network failure) can never classify as `"auth"` — that
 * requires wire evidence (401, 403+WWW-Authenticate, or ICF logon HTML); a
 * DNS failure says nothing about credentials.
 */
export function classifyFailure(input: ResponseLike | Error | unknown): FailureClass {
  if (isResponseLike(input)) {
    if (input.status >= 500 && isBenignDebugFailure(input)) return "ignored";
    if (isSessionDeath(input)) return "ignored";
    if (classifyAuthFailure(input)) return "auth";
    return "transient";
  }
  return "transient";
}

function describeFailure(input: ResponseLike | Error | unknown): string {
  if (isResponseLike(input)) return `HTTP ${input.status}`;
  if (input instanceof Error) {
    const code = (input as NodeJS.ErrnoException).code;
    return code ? `${code}: ${input.message}` : input.message || input.name;
  }
  if (typeof input === "string" && input) return input;
  return "unknown failure";
}

/**
 * Thrown by `AuthCircuitBreaker.guardedRequest()` when the breaker refuses to
 * admit a call. `code` matches the codes `GuardedHttpClient` already raises, so a
 * caller can treat both paths identically.
 */
export class BreakerOpenError extends Error {
  readonly code: "AUTH_CIRCUIT_OPEN" | "CIRCUIT_OPEN_TRANSIENT";
  readonly breakerStatus: BreakerStatus;
  constructor(status: BreakerStatus) {
    super(status.message);
    this.name = "BreakerOpenError";
    this.code = status.latched ? "AUTH_CIRCUIT_OPEN" : "CIRCUIT_OPEN_TRANSIENT";
    this.breakerStatus = status;
  }
}

/**
 * The breaker.
 *
 * The auth half is a one-way latch: once tripped it stays tripped for the
 * lifetime of the process, and there is intentionally no `reset()` on the public
 * path (only `resetForTests`). The transient half is an ordinary
 * closed/open/half-open circuit breaker with an exponential cooldown, and it
 * recovers on its own.
 */
export class AuthCircuitBreaker {
  private tripped: TripInfo | undefined;
  private readonly listeners: Array<(info: TripInfo) => void> = [];

  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly failureThreshold: number;
  private readonly now: () => number;

  /** Transient phase only. The auth latch is tracked separately in `tripped`. */
  private phase: "closed" | "open" | "half-open" = "closed";
  private probing = false;
  private consecutiveFailures = 0;
  private currentCooldownMs: number;
  private openedAtMs: number | undefined;
  private nextProbeAtMs: number | undefined;
  private lastFailureDesc: string | undefined;
  /** See `BreakerOptions.credentialFingerprint`. Never exposed. */
  private readonly credentialFingerprint: string | undefined;
  /** Resolved path of the durable latch entry backing this trip, if any —
   * set by `trip()` and by `forConfig`'s replay branch. See
   * {@link durableLatchFile}. */
  private latchFile: string | undefined;

  constructor(opts: BreakerOptions = {}) {
    const base = opts.cooldownMs;
    const max = opts.maxCooldownMs;
    const threshold = opts.failureThreshold;
    this.baseCooldownMs = typeof base === "number" && base >= 0 ? base : DEFAULT_COOLDOWN_MS;
    this.maxCooldownMs =
      typeof max === "number" && max >= 0
        ? Math.max(max, this.baseCooldownMs)
        : Math.max(DEFAULT_MAX_COOLDOWN_MS, this.baseCooldownMs);
    this.failureThreshold =
      typeof threshold === "number" && threshold >= 1 ? Math.floor(threshold) : DEFAULT_FAILURE_THRESHOLD;
    this.now = typeof opts.now === "function" ? opts.now : () => Date.now();
    this.currentCooldownMs = this.baseCooldownMs;
    this.credentialFingerprint = opts.credentialFingerprint;
  }

  /**
   * THE ONE PLACE A BREAKER IS MINTED FROM CONFIG — replaces `AbapConnection`'s
   * former private `buildBreaker`. `ConnectionOptions.breaker` is now required
   * so nothing falls in here implicitly; a composition root must ask for it
   * explicitly (see archive for the bug this fixes: an omitted key used to
   * produce a private breaker against a lockout counter shared process-wide).
   *
   * On a fingerprint hit, returns an already-latched breaker (replaying the
   * stored `TripInfo`) — zero network calls, zero SAP-side lockout cost. On a
   * miss, returns a clean breaker tagged with this fingerprint so a real trip
   * is remembered for the next process using the same credentials.
   */
  static forConfig(cfg: Config): AuthCircuitBreaker {
    const fingerprint = fingerprintCredentials(
      cfg.url,
      cfg.user,
      cfg.password ?? NO_PASSWORD_CREDENTIAL_DISCRIMINATOR,
    );
    const prior = lookupTrippedFingerprint(fingerprint);
    if (prior) {
      const breaker = new AuthCircuitBreaker();
      breaker.trip(prior.reason, prior.message, { status: prior.status, url: prior.url, at: prior.at });
      // The replay breaker above carries no `credentialFingerprint` (see
      // `trip()`'s own branch below), so it never looks this up on its own —
      // do it here, keyed on the fingerprint `forConfig` actually minted.
      breaker.latchFile = durableLatchPathFor(fingerprint);
      return breaker;
    }
    return new AuthCircuitBreaker({ credentialFingerprint: fingerprint });
  }

  // ---------------------------------------------------------------- auth latch

  /**
   * The PERMANENT auth latch — and only that. Never true because of a transient
   * failure. Callers may treat it as "this process will never authenticate
   * again; do not retry, do not re-connect, do not clear caches to try harder".
   */
  get isTripped(): boolean {
    return this.tripped !== undefined;
  }

  /** Always defined whenever `isTripped` is true; callers non-null-assert it. */
  get info(): TripInfo | undefined {
    return this.tripped;
  }

  /**
   * Resolved path of the durable `auth-latch.json` entry this trip is backed
   * by, or `undefined` when this trip lives only in this process (durable
   * latch disabled, or the write/read of the entry did not succeed). Read
   * this instead of re-deriving it: it reflects a real read-after-write
   * check at trip time, not merely whether persistence is configured.
   */
  get durableLatchFile(): string | undefined {
    return this.latchFile;
  }

  onTrip(fn: (info: TripInfo) => void): void {
    this.listeners.push(fn);
  }

  /**
   * Trip the breaker. Idempotent — the first reason wins.
   *
   * `ctx.at` lets `forConfig`'s fingerprint replay preserve the ORIGINAL trip
   * timestamp instead of stamping `new Date()`. Every other caller omits it.
   */
  trip(
    reason: TripReason,
    message: string,
    ctx: { status?: number; url?: string; at?: Date } = {},
  ): TripInfo {
    if (this.tripped) return this.tripped;
    this.tripped = { reason, message, status: ctx.status, url: ctx.url, at: ctx.at ?? new Date() };
    // Record process-wide only for a breaker that was given a fingerprint —
    // i.e. only from AbapConnection's constructor, never from a replay.
    if (this.credentialFingerprint) {
      // Bridges to auth-latch.ts, which now owns TRIPPED_FINGERPRINTS /
      // persistDurableLatch. Cannot throw. Its return value IS the
      // confirmation that the write landed — using it directly (rather than
      // re-deriving the path with the staleness-aware durableLatchPathFor)
      // avoids re-running that lookup's TTL-drop side effect against the
      // entry that was just written, which would self-delete it whenever
      // `ctx.at` is already older than AUTH_LATCH_TTL_MS.
      this.latchFile = recordTrippedFingerprint(this.credentialFingerprint, this.tripped);
    }
    for (const l of this.listeners) {
      try {
        l(this.tripped);
      } catch {
        /* a listener must never keep the breaker from latching */
      }
    }
    return this.tripped;
  }

  // ----------------------------------------------------------- transient machine

  /** `"latched"` outranks everything; otherwise the transient phase. */
  get state(): BreakerState {
    if (this.tripped) return "latched";
    this.syncPhase();
    return this.phase;
  }

  /** Immutable snapshot of both machines. Never throws. */
  status(): BreakerStatus {
    this.syncPhase();
    return this.snapshot();
  }

  /**
   * May a request go out right now? latched -> `false` forever; closed ->
   * `true`; open (still cooling) -> `false`; open (cooldown elapsed) ->
   * transition to half-open and return `true` EXACTLY ONCE — every further
   * call returns `false` until that single probe resolves via
   * `recordSuccess()` / `recordTransientFailure()`. A burst of "recovery"
   * requests against a sandbox with few dialog work processes would be worse
   * than the outage.
   */
  allowRequest(): boolean {
    if (this.tripped) return false;
    this.syncPhase();
    if (this.phase === "closed") return true;
    if (this.phase === "open") return false;
    // half-open: one probe, and one only.
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  /**
   * A request succeeded. No-op while latched (a success cannot un-reject
   * credentials — and nothing should be in flight anyway).
   */
  recordSuccess(): void {
    if (this.tripped) return;
    this.syncPhase();
    if (this.phase === "half-open") {
      if (!this.probing) {
        // Straggler from before we opened, not the probe — must not resolve it.
        this.consecutiveFailures = 0;
        return;
      }
      // The probe came back healthy: fully recover and forget the backoff.
      this.phase = "closed";
      this.probing = false;
      this.consecutiveFailures = 0;
      this.currentCooldownMs = this.baseCooldownMs;
      this.openedAtMs = undefined;
      this.nextProbeAtMs = undefined;
      return;
    }
    // Closed (or the should-not-happen open case): a success just breaks a
    // failure run; it doesn't reopen the gate for an unauthorised request.
    this.consecutiveFailures = 0;
  }

  /**
   * A failure that is NOT a credential problem.
   * half-open (probe failed): re-open immediately, DOUBLE the cooldown
   * (capped at `maxCooldownMs`) — one failed probe is enough.
   * closed: count it; at `failureThreshold` consecutive failures, open with
   * the base cooldown.
   */
  recordTransientFailure(detail: { message?: string; status?: number; url?: string } = {}): void {
    if (this.tripped) return;
    this.syncPhase();
    this.lastFailureDesc = this.describeDetail(detail);
    if (this.phase === "half-open") {
      // Same invariant as recordSuccess(): only the admitted probe may resolve this.
      if (!this.probing) return;
      this.currentCooldownMs = Math.min(this.currentCooldownMs * 2, this.maxCooldownMs);
      this.open(this.currentCooldownMs);
      return;
    }
    if (this.phase === "open") return; // already cooling down; nothing to escalate.
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.currentCooldownMs = this.baseCooldownMs;
      this.open(this.currentCooldownMs);
    }
  }

  /**
   * Unified failure entry point: classify, then record on the right machine.
   * Returns the class so the caller can decide how to surface the error.
   */
  noteFailure(input: ResponseLike | Error | unknown, url?: string): FailureClass {
    // A benign debugger 500 is the remote answering correctly — count as success.
    if (isResponseLike(input) && input.status >= 500 && isBenignDebugFailure(input)) {
      this.recordSuccess();
      return "ignored";
    }
    const cls = classifyFailure(input);
    if (cls === "ignored") return cls;
    if (cls === "auth" && isResponseLike(input)) {
      const reason = classifyAuthFailure(input);
      if (reason) {
        this.tripForAuth(reason, input.status, url);
        return "auth";
      }
      // Unreachable in practice; degrade to transient rather than lose the event.
    }
    this.recordTransientFailure({
      message: describeFailure(input),
      status: isResponseLike(input) ? input.status : undefined,
      url,
    });
    return "transient";
  }

  /** Instance form of the module-level `classifyFailure`. */
  classifyFailure(input: ResponseLike | Error | unknown): FailureClass {
    return classifyFailure(input);
  }

  // ------------------------------------------------------------------- inspect

  /**
   * Inspect a response; trips and returns info if it's an auth failure.
   * Called on EVERY response, including ones the caller treats as success:
   * auth latches; session death is ignored; 5xx/408/429 count as transient
   * failures; 2xx/3xx counts as success; ordinary 4xx (404/400) moves neither
   * counter. A benign debugger 500 (`isBenignDebugFailure`) counts as success.
   *
   * OBSERVATION ONLY — feeds the machines but does NOT gate. Calling this
   * without `allowRequest()` gives you a breaker that can OPEN but never
   * refuses a request: all cost, no protection. Outside `GuardedHttpClient`,
   * call `guardedRequest()` instead, which gates first and then inspects.
   */
  inspect(resp: ResponseLike, url?: string): TripInfo | undefined {
    // Ahead of every classifier: a debugger 500 that's really a success, not an auth failure.
    if (resp.status >= 500 && isBenignDebugFailure(resp)) {
      this.recordSuccess();
      return undefined;
    }
    const reason = classifyAuthFailure(resp);
    if (reason) return this.tripForAuth(reason, resp.status, url);
    if (isSessionDeath(resp)) return undefined;
    const s = resp.status;
    if (s >= 500 || s === 408 || s === 429) {
      this.recordTransientFailure({ status: s, url, message: `HTTP ${s}` });
    } else if (s >= 200 && s < 400) {
      this.recordSuccess();
    }
    return undefined;
  }

  /**
   * Gate, send, observe — the whole breaker contract in one call. Prefer this
   * over hand-rolling `allowRequest()`/`inspect()` outside `GuardedHttpClient`
   * (calling `inspect()` alone can OPEN the breaker while never being refused
   * by it):
   *   1. refuses up front (throws `BreakerOpenError`) if latched or the
   *      transient machine is open/already probing;
   *   2. runs `send()`;
   *   3. feeds the result back — `inspect()` on a response, `noteFailure()` on
   *      a throw — always resolving an outstanding probe so half-open can
   *      never wedge;
   *   4. rethrows whatever `send()` threw, unchanged.
   *
   * No `await` between the `state` read and `allowRequest()`, so "exactly one
   * probe" survives a concurrent burst.
   *
   * @param send performs the call.
   * @param opts.url for diagnostics only.
   * @param opts.toResponse maps the return value to a `ResponseLike`; omit it
   *   when the value already is one. Return `undefined` for a value with no
   *   HTTP status — treated as a plain success.
   */
  async guardedRequest<T>(
    send: () => Promise<T>,
    opts: { url?: string; toResponse?: (value: T) => ResponseLike | undefined } = {},
  ): Promise<T> {
    // No `await` between this read and allowRequest() — see GuardedHttpClient.request().
    const wasHalfOpen = this.state === "half-open";
    if (!this.allowRequest()) throw new BreakerOpenError(this.status());
    const isProbe = wasHalfOpen;

    try {
      const value = await send();
      const resp = opts.toResponse ? opts.toResponse(value) : asResponseLike(value);
      if (resp) this.inspect(resp, opts.url);
      else this.recordSuccess();
      if (isProbe && this.status().probeInFlight) this.recordSuccess();
      return value;
    } catch (e) {
      // Axios-shaped throws carry the response; anything else is a network error.
      const carried = asResponseLike((e as { response?: unknown } | undefined)?.response);
      if (carried) this.inspect(carried, opts.url);
      else this.noteFailure(e, opts.url);
      if (isProbe && this.status().probeInFlight) {
        // Any HTTP answer (even 404) proves the remote is alive; no answer = failed probe.
        if (carried) this.recordSuccess();
        else this.recordTransientFailure({ message: (e as Error)?.message, url: opts.url });
      }
      throw e;
    }
  }

  /**
   * Reset the TRANSIENT machine only. Tests only — throws outside a test run.
   * Deliberately does NOT clear the auth latch: on this appliance every logon
   * attempt burns one of the DEVELOPER user's remaining tries, so the latch
   * must survive anything short of a new process. Need an unlatched breaker
   * in a test? `new AuthCircuitBreaker(opts)` — one line, can't leak into prod.
   */
  resetForTests(): void {
    // vitest sets VITEST for every worker; a production process can't reach here.
    if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
      throw new Error(
        "AuthCircuitBreaker.resetForTests() is test-only and must never run in production. " +
          "Construct a new AuthCircuitBreaker instead.",
      );
    }
    this.phase = "closed";
    this.probing = false;
    this.consecutiveFailures = 0;
    this.currentCooldownMs = this.baseCooldownMs;
    this.openedAtMs = undefined;
    this.nextProbeAtMs = undefined;
    this.lastFailureDesc = undefined;
  }

  // ------------------------------------------------------------------ internals

  /** Shared auth-trip path for `inspect()` and `noteFailure()`. */
  private tripForAuth(reason: TripReason, status: number, url?: string): TripInfo {
    const message =
      reason === "icf-logon-page"
        ? "SAP ICF returned a logon-failure page. This counts as a failed logon attempt."
        : reason === "icf-password-change"
          ? "SAP ICF returned a password-change page. This counts as a failed logon " +
            "attempt against the same lockout counter and must not be retried automatically."
          : `Authentication rejected by the ABAP system (HTTP ${status}).`;
    return this.trip(reason, message, { status, url });
  }

  /**
   * Lazy, side-effecting clock check: the ONLY way `open` becomes `half-open`.
   * Called from `allowRequest()`, `state` and `status()`. No timers exist.
   */
  private syncPhase(): void {
    if (this.phase !== "open") return;
    if (this.nextProbeAtMs === undefined || this.now() >= this.nextProbeAtMs) {
      this.phase = "half-open";
      this.probing = false;
    }
  }

  private open(cooldownMs: number): void {
    const t = this.now();
    this.phase = "open";
    this.probing = false;
    this.openedAtMs = t;
    this.nextProbeAtMs = t + cooldownMs;
  }

  private describeDetail(detail: { message?: string; status?: number; url?: string }): string {
    if (detail.message) return detail.message;
    if (typeof detail.status === "number") return `HTTP ${detail.status}`;
    return "unknown failure";
  }

  /** Snapshot WITHOUT syncing — the caller has already synced. */
  private snapshot(): BreakerStatus {
    const latched = this.tripped !== undefined;
    const state: BreakerState = latched ? "latched" : this.phase;
    const out: BreakerStatus = {
      state,
      latched,
      message: this.describeState(state),
      consecutiveFailures: this.consecutiveFailures,
      probeInFlight: this.probing,
      cooldownMs: this.currentCooldownMs,
    };
    if (latched && this.tripped) out.authReason = this.tripped.reason;
    if (this.lastFailureDesc) out.lastFailure = this.lastFailureDesc;
    if (this.openedAtMs !== undefined) out.openedAt = new Date(this.openedAtMs);
    if (state === "open" && this.nextProbeAtMs !== undefined) {
      out.nextProbeAt = new Date(this.nextProbeAtMs);
      out.msUntilNextProbe = Math.max(0, this.nextProbeAtMs - this.now());
    }
    return out;
  }

  private describeState(state: BreakerState): string {
    if (state === "latched") {
      const info = this.tripped;
      const detail = info ? `${info.reason}: ${info.message}` : "authentication failure";
      const ttlMinutes = Math.round(AUTH_LATCH_TTL_MS / 60000);
      return (
        `Authentication is permanently disabled for the lifetime of this process (${detail}). ` +
        "The ABAP system rejected these credentials; retrying would spend another logon attempt and " +
        "can lock the SAP user (login/fails_to_user_lock defaults to 5). This process's own latch does " +
        "NOT expire — only exiting the process clears it. It is ALSO recorded in auth-latch.json under " +
        "the state directory (ABAP_STATE_DIR, default <cwd>/.abapsmith), so it holds across every " +
        `terminal sharing these credentials; that durable entry expires on its own ${ttlMinutes} minutes ` +
        "after the first failure, or delete auth-latch.json now, which clears it for every terminal at " +
        "once immediately."
      );
    }
    if (state === "open") {
      const ms =
        this.nextProbeAtMs === undefined ? 0 : Math.max(0, this.nextProbeAtMs - this.now());
      return (
        `Temporarily refusing requests after ${this.consecutiveFailures} consecutive failures ` +
        `(last: ${this.lastFailureDesc ?? "unknown"}). This is NOT a credential problem and it clears ` +
        `itself: the next single probe request is allowed in ${Math.round(ms / 1000)}s ` +
        `(cooldown ${Math.round(this.currentCooldownMs / 1000)}s).`
      );
    }
    if (state === "half-open") {
      return this.probing
        ? "Recovery probe in flight; all other requests are held until it reports back."
        : "Cooldown elapsed; the next request is allowed through as a single recovery probe.";
    }
    return "Closed — requests are flowing normally.";
  }
}
