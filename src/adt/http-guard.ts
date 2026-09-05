/**
 * The guarded HTTP client — essentially all of abapsmith's traffic leaves
 * through here. Sits underneath `abap-adt-api`'s `AdtHTTP`, so its 401
 * circuit breaker serves `AdtHTTP.request()`'s single login retry locally
 * instead of letting a second logon attempt reach the server.
 *
 * Not the only socket: `src/debug/transport.ts` opens its own raw
 * `node:http`/`node:https` sockets and hand-rolls the breaker gates, but
 * calls the same exported {@link assertHttpPathAllowed} at its two
 * `requestFn(...)` call sites, so it stays inside the path/query denial
 * below. See the git history for why the assert
 * had to move to those call sites specifically.
 */
import https from "node:https";
import { AxiosHttpClient } from "abap-adt-api/build/AxiosHttpClient.js";
import type {
  HttpClient,
  HttpClientException,
  HttpClientOptions,
  HttpClientResponse,
} from "abap-adt-api/build/AdtHTTP.js";
import { AuthCircuitBreaker } from "./circuit-breaker.js";
import { AUTH_LATCH_TTL_MS } from "./auth-latch.js";
import { AbapError } from "./errors.js";
import { captureErrorBody } from "../error-capture.js";

/** Axios-level timeout when `GuardOptions.timeout` is not supplied. Must stay
 * equal to `src/config.ts`'s `timeoutMs` default — move them together. */
const DEFAULT_HTTP_TIMEOUT_MS = 60_000;

export interface GuardOptions {
  baseURL: string;
  insecure?: boolean;
  timeout?: number;
  /**
   * When false (the default) `sap-client` is stripped from every request,
   * including the library's own login call — on A4H it produces an ICF
   * logon-failure page otherwise.
   */
  sendClientParam?: boolean;
  /** Injected for tests. */
  inner?: HttpClient;
  onRequest?: (o: HttpClientOptions) => void;
  onResponse?: (o: HttpClientOptions, r: HttpClientResponse) => void;
  /**
   * B1 — the session mutex, optional (omitting it behaves as before). When
   * supplied, awaited between the breaker gate and dispatch; the returned
   * {@link Release} runs in a `finally` on every path. `AbapConnection`
   * supplies `SessionLock.acquireImplicit`, per connection, never global.
   *
   * Must be RE-ENTRANT — `AbapConnection` also takes it exclusively around
   * multi-request flows whose own requests arrive back here; `SessionLock`
   * recognises the caller via `AsyncLocalStorage` token. The debug long poll
   * deliberately takes no hold here (see `src/adt/session-lock.ts` header and
   * `src/adt/pool.ts`'s `blockedOnlyByDebugLease`) — see archive for why.
   */
  acquire?: (url: string) => Promise<Release>;
  /**
   * B1b — the ADT session type at dispatch time, re-stamped onto
   * `X-sap-adt-sessiontype` after {@link acquire} resolves, because
   * `AdtHTTP._request()` stamps that header from `this.stateful` *before*
   * this guard is ever entered — a request that parks in `acquire` across a
   * `withStatefulSession` window closing would otherwise go out re-arming a
   * session whose owner has already left. `undefined` leaves the header as
   * the caller built it (every guard without this option). See archive for
   * the full failure mode this closes.
   */
  sessionType?: () => string | undefined;
  /**
   * Static cookie-mode credential, merged into the outgoing `Cookie`
   * header at step 2c below (see {@link mergeInjectedCookies}). A function,
   * like {@link sessionType}, never a plain value: `GuardOptions` can end up
   * inside `JSON.stringify` on a diagnostic path (`HttpClientException` on
   * `.config`), and `JSON.stringify` skips function-valued properties but
   * would happily serialise a string or object. `undefined` (the default)
   * disables injection entirely — password mode never calls this.
   */
  injectedCookies?: () => ReadonlyMap<string, string> | undefined;
}

/** The header `AdtHTTP._request()` stamps from its `stateful` field. */
const SESSION_TYPE_HEADER = "X-sap-adt-sessiontype";

/**
 * Splits a `Cookie:` header string into name -> bare value, preserving
 * encounter order. Each pair is split on the FIRST `=` only, since a cookie
 * value can itself contain `=`. Empty header -> empty map.
 */
function parseCookieHeaderPairs(header: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!header) return map;
  for (const fragment of header.split(";")) {
    const trimmed = fragment.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq).trim();
    if (!name) continue;
    map.set(name, trimmed.slice(eq + 1).trim());
  }
  return map;
}

/**
 * Merge precedence for cookie-mode auth: a jar entry (already present in
 * `jarHeader`, i.e. server-issued) with a non-empty value wins for its name.
 * An empty jar value is a server deletion directive, not a win — the injected
 * value fills it instead. A name the jar lacks is filled from `injected`. A
 * name only in the jar passes through untouched. Exactly one pair per name in
 * the result; `injected` itself is never mutated.
 */
function mergeInjectedCookies(jarHeader: string, injected: ReadonlyMap<string, string>): string {
  const merged = parseCookieHeaderPairs(jarHeader);
  for (const [name, value] of injected) {
    const held = merged.get(name);
    if (held === undefined || held === "") merged.set(name, value);
  }
  return [...merged].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** Releases whatever {@link GuardOptions.acquire} handed out. Must be idempotent. */
export type Release = () => void;

const NOOP_RELEASE: Release = () => {};

/** Renders a clamped millisecond duration as e.g. "14m", "45s", "3m20s". Never negative. */
function formatRemaining(ms: number): string {
  const totalSeconds = Math.round(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m${seconds}s`;
}

/**
 * Same fact restated for both branches below: a 401 here is not proof of a
 * bad password. The gateway can hand back a spurious 401 while degraded, and
 * that looks identical on the wire — a live incident confirmed this (a
 * direct authenticated request succeeded two minutes after the
 * server had latched). The only cheap way to tell the two apart is a request
 * this server does not make, since making one here would itself spend a
 * logon attempt against the same counter.
 */
const CREDENTIAL_CAVEAT =
  "A 401 can mean the wrong ABAP_USER / ABAP_PASSWORD, but it can equally mean a degraded ADT " +
  "gateway returning a spurious one — the cheap way to tell them apart is a single manual " +
  "authenticated request outside this server, not a retry through it, which would spend another " +
  "attempt against login/fails_to_user_lock (defaults to 5).";

export function circuitOpenError(breaker: AuthCircuitBreaker): AbapError {
  // Defensive: `info` is only populated once the *auth* latch has tripped. If a
  // caller reaches here in any other state we must still produce an error
  // rather than crash on a non-null assertion.
  const info = breaker.info;
  const status = breaker.status();
  const message = info?.message ?? status.message;
  const latchFile = breaker.durableLatchFile;

  const details: Record<string, unknown> = info
    ? {
        reason: info.reason,
        status: info.status,
        url: info.url,
        trippedAt: info.at.toISOString(),
      }
    : { state: status.state };
  // Lets a caller that only inspects `details` (not the prose) tell the two
  // latches apart without pattern-matching `hint` — e.g. an agent deciding
  // whether to keep waiting versus surface this to whoever runs the process.
  details.durable = Boolean(latchFile && info);

  // Re-arm path — same for both branches below. Terminal means no state
  // directory is configured, so no operator-reachable signal file exists.
  details.rearmRequired = true;
  let rearmSentence: string;
  if (status.authTerminal) {
    details.terminal = true;
    rearmSentence =
      "No re-arm path exists in this process — no state directory is configured, so there is no " +
      "signal file to create; restarting the process is the only way out.";
  } else {
    details.nextAttemptAt = status.authRearmAt?.toISOString();
    details.msUntilNextAttempt = status.msUntilAuthRearm;
    details.rearmSignalFile = status.authRearmSignalFile;
    if (status.authProbeArmed) {
      details.rearmArmed = true;
      rearmSentence = "A re-arm is already armed: the next ABAP request spends its one logon attempt.";
    } else {
      rearmSentence =
        `To retry without restarting anything: create ${status.authRearmSignalFile} (e.g. \`touch\` it). ` +
        "The next ABAP request then spends exactly ONE logon attempt — one more of the ~5 before " +
        "login/fails_to_user_lock locks the user, if the credentials are still wrong — and the following " +
        `re-arm is refused for ${formatRemaining(status.msUntilAuthRearm ?? 0)} after that.`;
    }
  }

  let hint: string;
  if (latchFile && info) {
    const ttlMinutes = Math.round(AUTH_LATCH_TTL_MS / 60000);
    const expiresAtMs = info.at.getTime() + AUTH_LATCH_TTL_MS;
    const remainingMs = Math.max(0, expiresAtMs - Date.now());
    details.latchFile = latchFile;
    details.expiresAt = new Date(expiresAtMs).toISOString();
    details.msRemaining = remainingMs;
    hint =
      `This latch is DURABLE — recorded in ${latchFile} — and shared by every abapsmith process ` +
      "using these credentials. Restarting the MCP server will NOT clear it: a fresh process reads " +
      "that same file on startup and re-latches immediately. It expires on its own AUTH_LATCH_TTL_MS " +
      `(${ttlMinutes} minutes) after the first failure, about ${formatRemaining(remainingMs)} from now, ` +
      `or delete the file now to clear it for every terminal at once immediately. ${CREDENTIAL_CAVEAT} ` +
      rearmSentence;
  } else {
    hint =
      "This latch is process-local, not durable — no auth-latch.json entry is in play — so it clears " +
      "only when the MCP server process itself is restarted, which is not something a tool call " +
      "running inside that same server can do to its own host; whoever operates this MCP server needs " +
      `to be the one to restart it. ${CREDENTIAL_CAVEAT} ` +
      rearmSentence;
  }

  return new AbapError(
    "AUTH_CIRCUIT_OPEN",
    "ABAP connection disabled: the 401 circuit breaker has tripped. " +
      `First failure: ${message}`,
    details,
    hint,
  );
}

/**
 * Path/method policy, checked before any network activity. Not a general URL
 * allowlist — its one job is making the `abap-adt-api` `transportRelease()`
 * "ignore" variants structurally unreachable regardless of caller flags:
 *
 *   normal release  -> .../cts/transportrequests/{tr}/newreleasejobs   (fine)
 *   ignore locks    -> .../cts/transportrequests/{tr}/relwithignlock   (DENIED)
 *   ignore ATC      -> .../cts/transportrequests/{tr}/relObjigchkatc   (DENIED)
 *
 * These bypass the customer's own quality gates (ATC findings, enqueue lock),
 * so the exclusion is enforced at the one layer every outbound request must
 * pass through, not by a "never pass true" calling convention that a single
 * upstream edit could break. Two independent checks, either denies:
 *
 * A. **Terminal path segment** — the last `/`-segment, matched as a whole
 *    segment against `relwithignlock`/`relobjigchkatc`, after: cutting at the
 *    first `?`/`#`; repeated bounded percent-decoding (re-cutting each round,
 *    tolerating malformed escapes); lowercasing and `\`→`/` folding; dropping
 *    empty segments; and taking the last segment both literally and after
 *    RFC 3986 dot-segment removal. `.../newreleasejobs/relwithignlock` is
 *    still denied — the true final segment wins, never a "contains" allow.
 * B. **Query-parameter name** `ignoreLocks`/`ignoreATC` (case-insensitive),
 *    matched by name only (not value) across the URL, its decoded rounds, and
 *    `options.qs` keys — nothing sends these today, but a future ADT release
 *    could move them into the query.
 *
 * The request BODY is deliberately not matched (ABAP source routinely
 * mentions these words in comments). See
 * the git history for the full matching rationale.
 */
const DENIED_RELEASE_SEGMENTS = ["relwithignlock", "relobjigchkatc"];

/** Lowercased. See rule B above. */
const DENIED_QUERY_PARAMS = ["ignorelocks", "ignoreatc"];

/** Decode rounds for normalizing; 2 covers known stacks, 3 leaves margin.
 * Bounded so a `%25`-chain cannot spin here. */
const MAX_DECODE_ROUNDS = 3;

/** Everything before the first `?` or `#`. */
function cutQueryAndFragment(s: string): string {
  const cut = s.search(/[?#]/);
  return cut === -1 ? s : s.slice(0, cut);
}

/**
 * `s` plus every distinct percent-decoding of it, up to
 * {@link MAX_DECODE_ROUNDS}. Stops early on a malformed escape (must not
 * crash a policy check) or once decoding is a fixed point — see
 * {@link lenientForms} for why that isn't the last word.
 */
function decodeRounds(s: string): string[] {
  const forms = [s];
  let current = s;
  for (let i = 0; i < MAX_DECODE_ROUNDS; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break;
    }
    if (next === current) break;
    forms.push(next);
    current = next;
  }
  return forms;
}

/** A `%` NOT followed by two hex digits — i.e. not a valid escape. */
const INVALID_ESCAPE = /%(?![0-9a-f]{2})/gi;

/**
 * Repairs of `s` for a MALFORMED percent-escape (empty when `s` has no `%`).
 * A raw `decodeURIComponent` failure would leave the stray `%` in the
 * comparison and fail the request OPEN (allowed) instead of denied — the one
 * direction this guard may not fail in — so both plausible repairs are
 * matched too: drop just the stray `%`, and drop the whole broken escape.
 * See archive for the fail-open trace that motivated this.
 */
function lenientForms(s: string): string[] {
  if (!s.includes("%")) return [];
  return [
    s.replace(INVALID_ESCAPE, ""),
    // `%` plus up to two following characters, stopping at a delimiter so a
    // repair can never eat across a segment or query boundary.
    s.replace(/%(?![0-9a-f]{2})[^/?#&;=]{0,2}/gi, ""),
  ];
}

/**
 * Every form of `s` worth comparing: each decoding round, plus the malformed-
 * escape repairs of `s` and of each round, each of those decoded in turn.
 * Bounded by {@link MAX_DECODE_ROUNDS} and by the two repairs.
 */
function decodeVariants(s: string): string[] {
  const out = new Set<string>();
  for (const seed of [s, ...lenientForms(s)]) {
    for (const form of decodeRounds(seed)) {
      out.add(form);
      for (const repaired of lenientForms(form)) {
        for (const f of decodeRounds(repaired)) out.add(f);
      }
    }
  }
  return [...out];
}

/**
 * Trailing whitespace and dots are stripped for COMPARISON only (some proxies
 * and file-system-backed handlers trim them). A segment made purely of dots is
 * left alone — `.` and `..` have to survive to be resolved as dot segments.
 */
function trimSegment(s: string): string {
  const t = s.trim();
  return /^\.+$/.test(t) ? t : t.replace(/[\s.]+$/, "");
}

/**
 * The last path segment under both readings: literal (empty segments dropped,
 * so a trailing slash cannot hide it) and after RFC 3986 dot-segment removal.
 * Both are returned because a server may or may not normalize, and a denial
 * must not depend on guessing which.
 */
function terminalSegments(path: string): string[] {
  const parts = path.split("/").map(trimSegment).filter((p) => p !== "");
  const out: string[] = [];
  const literal = parts[parts.length - 1];
  if (literal !== undefined) out.push(literal);

  const resolved: string[] = [];
  for (const p of parts) {
    if (p === ".") continue;
    if (p === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(p);
  }
  const last = resolved[resolved.length - 1];
  if (last !== undefined) out.push(last);
  return out;
}

/**
 * Every normalized path form of `url` worth matching against. Matching only —
 * never surfaced in an error message.
 */
function candidatePaths(url: string): string[] {
  const forms = new Set<string>();
  for (const round of decodeVariants(cutQueryAndFragment(url))) {
    forms.add(cutQueryAndFragment(round).replace(/\\/g, "/").toLowerCase());
  }
  return [...forms];
}

/** Rule A. The denied terminal segment, or `undefined`. */
function deniedPathSegment(url: string): string | undefined {
  for (const path of candidatePaths(url)) {
    for (const segment of terminalSegments(path)) {
      if (DENIED_RELEASE_SEGMENTS.includes(segment)) return segment;
    }
  }
  return undefined;
}

/** Every parameter NAME `url` and `qs` carry, lowercased. Values are ignored. */
function queryParamNames(url: string, qs: Record<string, unknown> | undefined): Set<string> {
  const names = new Set<string>();
  const addName = (raw: string): void => {
    // Decode `+` (space) before escapes so `%2b` isn't mistaken for it.
    // `decodeVariants`, not `decodeRounds` — a malformed escape in a name must
    // not fail open the way it did in the path (see decodeRounds/lenientForms).
    for (const form of decodeVariants(raw.replace(/\+/g, " "))) {
      names.add(form.trim().toLowerCase());
    }
  };
  const addQueryString = (query: string): void => {
    for (const pair of query.split(/[&;]/)) {
      if (pair === "") continue;
      addName(pair.split("=")[0] ?? "");
    }
  };

  // The URL's own query, plus the query of every decoded round — a `%3f`
  // smuggled into the path becomes a real `?` after decoding.
  for (const form of decodeVariants(url.split("#")[0] ?? "")) {
    const q = form.indexOf("?");
    if (q !== -1) addQueryString(form.slice(q + 1));
  }
  // `options.qs` is a structurally separate field that axios appends to the
  // URL downstream of here; its keys are parameter names just the same.
  for (const key of Object.keys(qs ?? {})) addName(key);
  return names;
}

/** Rule B. The denied parameter name, or `undefined`. */
function deniedQueryParam(url: string, qs: Record<string, unknown> | undefined): string | undefined {
  const present = queryParamNames(url, qs);
  return DENIED_QUERY_PARAMS.find((p) => present.has(p));
}

/**
 * Throws `HTTP_PATH_DENIED` for the transport-release "ignore" endpoints and
 * for an `ignoreLocks`/`ignoreATC` query parameter. See the policy block
 * above for the matching rule. Called at the top of
 * {@link GuardedHttpClient.request}, before any network activity. Exported so
 * other outbound paths (`src/debug/transport.ts`'s raw long poll) can be held
 * to the same rule — the rule is the invariant, not `GuardedHttpClient`.
 */
export function assertHttpPathAllowed(
  method: string | undefined,
  url: string,
  qs?: Record<string, unknown>,
): void {
  const safeUrl = url ?? "";
  const segment = deniedPathSegment(safeUrl);
  const param = segment ? undefined : deniedQueryParam(safeUrl, qs);
  if (!segment && !param) return;

  const safeMethod = (method ?? "GET").toUpperCase();
  // Raw (pre-normalization) URL for readability, but query/fragment-free —
  // never echo back the query string itself.
  const pathOnly = cutQueryAndFragment(safeUrl);
  const because = segment
    ? `the '${segment}' endpoint`
    : `the '${param}' query parameter`;
  throw new AbapError(
    "HTTP_PATH_DENIED",
    `Refused ${safeMethod} ${pathOnly}: ${because} bypasses the transport ` +
      "release quality gate (lock protection or ATC findings) and is excluded " +
      "structurally, with no config or flag able to re-enable it.",
    {
      method: safeMethod,
      path: pathOnly,
      ...(segment ? { deniedSegment: segment } : { deniedParam: param }),
    },
    "Use the normal release endpoint instead (no ignoreLocks / IgnoreATC). " +
      "If a lock or an ATC finding is blocking release, resolve it rather than bypassing it.",
  );
}

/**
 * The *transient* sibling of {@link circuitOpenError}: raised when the breaker
 * sheds load because the remote system is failing (5xx/408/429/network), not
 * because credentials are wrong. Never reads `breaker.info` — during a
 * transient open the auth latch is untouched and `info` is `undefined`.
 */
export function transientOpenError(breaker: AuthCircuitBreaker): AbapError {
  const s = breaker.status();
  const waitMs = s.msUntilNextProbe;
  return new AbapError(
    "CIRCUIT_OPEN_TRANSIENT",
    `ABAP request shed: the transient circuit breaker is ${s.state}. ` +
      `${s.consecutiveFailures} consecutive failure(s) against the server; ` +
      `the request was refused locally instead of piling onto a struggling system. ` +
      `Last failure: ${s.lastFailure ?? s.message}`,
    {
      state: s.state,
      consecutiveFailures: s.consecutiveFailures,
      ...(s.lastFailure ? { lastFailure: s.lastFailure } : {}),
      ...(waitMs !== undefined ? { msUntilNextProbe: waitMs } : {}),
      ...(s.nextProbeAt ? { nextProbeAt: s.nextProbeAt.toISOString() } : {}),
      cooldownMs: s.cooldownMs,
    },
    "The SAP system is struggling or unreachable. This is NOT a credentials " +
      "problem and needs no restart — the breaker probes automatically " +
      `${waitMs !== undefined ? `in ~${waitMs} ms` : "after the cooldown"} and ` +
      "closes again on the first successful response. Retry after that.",
  );
}

/**
 * Single source of truth for this process's TLS-verification policy
 * (`ABAP_INSECURE`). Also called directly by `src/debug/transport.ts`'s raw
 * `node:https` long-poll/CSRF sockets, which cannot share axios's private
 * `httpsAgent` instance — calling this with the same `cfg.insecure` value
 * keeps both stacks on identical logic instead of a second copy that could
 * drift. See `test/http-guard-debug-transport-agreement.test.ts`.
 *
 * Returns `undefined` when falsy — "no agent" (normal verification), not
 * "verification is off."
 */
export function buildInsecureHttpsAgent(insecure: boolean | undefined): https.Agent | undefined {
  return insecure ? new https.Agent({ rejectUnauthorized: false }) : undefined;
}

export class GuardedHttpClient implements HttpClient {
  readonly breaker: AuthCircuitBreaker;
  private readonly inner: HttpClient;
  private readonly opts: GuardOptions;
  /** Number of requests that actually reached the network. */
  requestCount = 0;
  /** Number of requests refused locally because the breaker was open. */
  blockedCount = 0;

  /**
   * `breaker` IS REQUIRED — it used to default to `new AuthCircuitBreaker()`,
   * which silently gated nothing shared (own private breaker/budget) while
   * looking identical to a guarded client at every call site. See archive.
   */
  constructor(opts: GuardOptions, breaker: AuthCircuitBreaker) {
    this.opts = opts;
    this.breaker = breaker;
    const httpsAgent = buildInsecureHttpsAgent(opts.insecure);
    this.inner =
      opts.inner ??
      new AxiosHttpClient(opts.baseURL, {
        timeout: opts.timeout ?? DEFAULT_HTTP_TIMEOUT_MS,
        ...(httpsAgent ? { httpsAgent } : {}),
      });
  }

  async request(options: HttpClientOptions): Promise<HttpClientResponse> {
    // 0. Path/method policy, ahead of everything else so a denial is provably
    //    pre-network. `options.qs` is passed (keys only, never values) because
    //    axios appends it to the URL downstream — checking `options.url` alone
    //    would miss it.
    assertHttpPathAllowed(options.method, options.url, options.qs);

    // 1. Hard stop. Nothing leaves the process once the auth latch has tripped —
    //    except the one probe an explicit re-arm just admitted.
    const authProbe = this.breaker.isTripped && this.breaker.allowAuthProbe();
    if (this.breaker.isTripped && !authProbe) {
      this.blockedCount++;
      throw circuitOpenError(this.breaker);
    }

    // 1b. Transient gate. Skipped for an auth probe — allowRequest() refuses a
    //     latched breaker outright. `state` read and `allowRequest()` MUST stay
    //     adjacent with no `await` between them otherwise, to keep half-open
    //     single-probe admission correct under a concurrent burst.
    let isProbe = false;
    if (!authProbe) {
      const wasHalfOpen = this.breaker.state === "half-open";
      if (!this.breaker.allowRequest()) {
        this.blockedCount++;
        throw transientOpenError(this.breaker);
      }
      isProbe = wasHalfOpen;
    }

    // 1c. Session mutex (B1). AFTER both breaker gates (a shed request must
    //     never queue, and the no-`await` invariant at 1b must not be
    //     perturbed) and BEFORE dispatch, so "one request at a time per ADT
    //     session" is airtight. Do not move this `await` above `allowRequest()`
    //     — see archive for the multi-probe-admission bug that causes, and
    //     test/http-guard.test.ts "admits EXACTLY ONE probe".
    let release: Release;
    try {
      release = this.opts.acquire ? await this.opts.acquire(options.url) : NOOP_RELEASE;
    } catch (e) {
      // Only `dispatch()` normally resolves the probe slot `allowRequest()`
      // consumed at 1b (or the one `allowAuthProbe()` admitted at 1); bailing
      // here without handing it back would wedge the breaker (see archive).
      // `recordTransientFailure`, not `recordSuccess` — nothing left the
      // process, so nothing proves the remote, or the credentials, are good.
      if (authProbe) {
        this.breaker.recordTransientFailure({
          message: (e as Error)?.message,
          url: options.url,
        });
      } else if (isProbe && this.breaker.status().probeInFlight) {
        this.breaker.recordTransientFailure({
          message: (e as Error)?.message,
          url: options.url,
        });
      }
      throw e;
    }
    // `release` is now owned by this call and MUST run exactly once on every
    // path — success, thrown response, or a throw from the breaker itself.
    try {
      return await this.dispatch(options, isProbe);
    } catch (e) {
      // D4 — same probe wedge as the acquire bail-out, one layer further in:
      // three statements outside dispatch()'s own try/catch can still throw
      // (the sessionType re-stamp, onRequest, onResponse) and exit through the
      // `finally` below, which releases only the session mutex. The
      // `probeInFlight` re-read makes this idempotent with dispatch()'s own
      // resolutions. See archive for the full trace.
      if (isProbe && this.breaker.status().probeInFlight) {
        this.breaker.recordTransientFailure({
          message: (e as Error)?.message,
          url: options.url,
        });
      }
      throw e;
    } finally {
      release();
    }
  }

  /** Everything downstream of the breaker + the session mutex. */
  private async dispatch(
    options: HttpClientOptions,
    isProbe: boolean,
  ): Promise<HttpClientResponse> {
    // 2. Strip sap-client unless explicitly opted in.
    const opts: HttpClientOptions = { ...options };
    if (!this.opts.sendClientParam && opts.qs && "sap-client" in opts.qs) {
      const { "sap-client": _dropped, ...rest } = opts.qs;
      opts.qs = rest;
    }

    // 2b. Re-stamp the session type from the live flag (B1b, see GuardOptions
    //     .sessionType) — the first point at which the session is provably
    //     ours. Header map is copied, not mutated: `opts` is a shallow clone,
    //     so writing through `opts.headers` would reach the caller's object.
    const liveSessionType = this.opts.sessionType?.();
    if (liveSessionType !== undefined) {
      const headers = (opts.headers ?? {}) as Record<string, unknown>;
      if (headers[SESSION_TYPE_HEADER] !== liveSessionType) {
        opts.headers = { ...headers, [SESSION_TYPE_HEADER]: liveSessionType };
      }
    }

    // 2c. Inject the cookie-mode credential, if configured. Header map
    //     is copied, never mutated — same rule as 2b. An empty-password Basic
    //     auth attempt would be a real failed logon against SAP's lockout
    //     counter, so `auth` is dropped whenever a cookie is in play.
    const injectedCookies = this.opts.injectedCookies?.();
    if (injectedCookies !== undefined) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      headers["Cookie"] = mergeInjectedCookies(headers["Cookie"] ?? "", injectedCookies);
      opts.headers = headers;
      delete opts.auth;
    }

    this.opts.onRequest?.(opts);

    this.requestCount++;
    let response: HttpClientResponse | undefined;
    try {
      response = await this.inner.request(opts);
    } catch (e) {
      // Forensic capture — no-op unless ABAPSMITH_BODY_DUMP_DIR is set. This is
      // the lowest layer where a response body still exists; `abap-adt-api`'s
      // `AdtException.fromResponse` may later drop it (AdtException.js:145-147).
      captureErrorBody("http-guard", opts.url, e);
      // Axios throws on >= 400; the response is carried on the exception.
      const carried = (e as HttpClientException)?.response;
      if (carried) {
        // `inspect()` drives both machines — don't also call
        // noteFailure()/recordTransientFailure() or failures double-count.
        this.breaker.inspect(carried, opts.url);
      } else {
        // Network error: inspect() never sees it, so feed the transient
        // machine directly here.
        this.breaker.noteFailure(e, opts.url);
      }
      // 4. Probe-wedge guard: inspect() only resolves the probe flag for
      //    2xx/3xx and 5xx/408/429; a plain 4xx or ignored network error would
      //    leave it set forever and wedge half-open.
      if (isProbe && this.breaker.status().probeInFlight) {
        if (carried) {
          // Any HTTP answer, even a 404, proves the remote is alive.
          this.breaker.recordSuccess();
        } else {
          this.breaker.recordTransientFailure({
            message: (e as Error)?.message,
            url: opts.url,
          });
        }
      }
      if (this.breaker.isTripped) throw circuitOpenError(this.breaker);
      throw e;
    }

    this.opts.onResponse?.(opts, response);

    // 3. Inspect EVERY response — a 200 carrying the ICF logon page is still a
    //    failed logon attempt and still counts towards the user lock.
    this.breaker.inspect(response, opts.url);
    if (isProbe && this.breaker.status().probeInFlight) {
      this.breaker.recordSuccess();
    }
    if (this.breaker.isTripped) throw circuitOpenError(this.breaker);

    return response;
  }
}
