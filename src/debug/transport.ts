/**
 * Debugger transport.
 *
 * Wraps `AbapConnection` (`src/adt/connection.ts`) for debugger use: raw
 * debugger requests, the retry ladder, error translation, and the separate
 * long-poll client for `POST /debugger/listeners`.
 *
 * Two fragments are ported behaviour, not original: the CSRF `HEAD` recipe in
 * `fetchCsrfToken()` and the retry ladder's CSRF-retry-once branch.
 *
 * LAYERING (read before changing this file): the 401 circuit breaker sits
 * *beneath* `abap-adt-api`'s `HttpClient` (`src/adt/http-guard.ts`), never
 * above — `AdtHTTP.request()` retries once on a login error by design, and
 * only a breaker underneath can intercept that retry.
 *
 *  1. Ordinary debugger requests go through `AbapConnection.get/post/put/del()`,
 *     which already sits under the breaker and does CSRF-refresh-and-retry-once.
 *  2. The long-poll (`DebugLongPollClient`) and its CSRF `HEAD` can't use that
 *     path — `AbapConnection`'s client has a fixed timeout baked in (see
 *     `assertLongPollTimeoutSafe`) — so they talk to SAP directly over
 *     `node:http`/`node:https`, sharing the session but not the HTTP client,
 *     and re-implement only what `GuardedHttpClient` gives for free: breaker
 *     awareness via the SAME shared `AuthCircuitBreaker`; one capped
 *     CSRF-stale-token retry; and `assertHttpPathAllowed`, asserted at both
 *     `requestFn(...)` call sites since `requestFn` is injectable.
 *
 * Full rationale: the git history.
 */
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { session_types } from "abap-adt-api";
import type { AbapConnection, RawResponse as ConnRawResponse } from "../adt/connection.js";
import type { AuthCircuitBreaker } from "../adt/circuit-breaker.js";
import { assertHttpPathAllowed, circuitOpenError, transientOpenError } from "../adt/http-guard.js";
import { planProxyRequest, type ProxyRequestPlan } from "./proxy.js";
import { adtExceptionInfo } from "../adt/session.js";
import { AbapError, describeUnknownError } from "../adt/errors.js";
import type { AuthorizedTarget, SafetyGate, SafetyTarget } from "../safety.js";
import { explainDeniedCapability } from "../mode.js";
import {
  collectExceptionClassNames,
  isConflict,
  isDebuggeeEnded,
  isNoSessionAttached,
  isSessionExpired,
  parseAdtError,
} from "./xml-response.js";
import type { AdtError, RawResponse } from "./types.js";
import { truncateDiagnosticBody } from "../truncate.js";
import { captureErrorBody } from "../error-capture.js";

// `isConflict`/`isSessionExpired`/`isNoSessionAttached` live in `xml-response.ts`
// (re-exported below); see its doc comments for behaviour differences from an
// earlier duplicate implementation here.

// ---------------------------------------------------------------------------
// The real lifetime numbers. Named and cited so nobody re-derives (or
// mis-derives) them later.
// ---------------------------------------------------------------------------

/**
 * `rdisp/max_debug_attach_wait_time` — the window between a breakpoint being hit
 * and the client attaching to it, after which the debuggee resumes on its own.
 * 30 seconds.
 */
export const DEBUG_ATTACH_WAIT_TIME_MS = 30_000;

/**
 * `rdisp/max_debug_lazy_time` — how long an attached-but-idle debug session
 * survives before SAP kills it. 600 seconds (10 minutes). The real constraint on
 * an agent-driven debugger: an LLM that thinks for ten minutes between steps
 * loses the session.
 */
export const DEBUG_LAZY_TIME_MS = 600_000;

/**
 * The server-side long-poll ceiling for `POST /sap/bc/adt/debugger/listeners`,
 * hardcoded in `CL_TPDA_ADT_RES_LISTENERS` (`IF l_timeout IS INITIAL. l_timeout =
 * 240.`) and confirmed reachable via the `timeout` query parameter in this
 * system's own discovery document. Tunable system-wide only via the SAP memory
 * parameter `TPDA_ADT_LIS_TIMEOUT` — not a profile parameter, and this module
 * never assumes a caller has raised it.
 */
export const LISTENER_SERVER_TIMEOUT_MS = 240_000;

/**
 * The minimum safety margin `assertLongPollTimeoutSafe` requires between a
 * requested listener timeout and the long-poll client's own timeout ceiling.
 */
export const LONGPOLL_TIMEOUT_MARGIN_MS = 60_000;

/**
 * Named/cited so nobody re-derives these numbers. An earlier implementation's `DebuggerListen` hit
 * exactly this trap: a per-call context timeout composed on top of a
 * process-wide `http.Client{Timeout: 60s}` cannot raise that ceiling, so every
 * listen over 60s died as an opaque transport error instead of a clean
 * timeout. Node's global `fetch()` has the identical trap one layer down, in
 * undici's default dispatcher (`headersTimeout` 300s) — `AbortSignal.timeout()`
 * doesn't raise it either. `defaultRawHttpRequest` below sidesteps both by using
 * `node:http`/`node:https` directly with no dispatcher and no hidden ceiling;
 * the only timeout the long-poll is subject to is the explicit
 * `AbortController` composed in `DebugLongPollClient.listen()`.
 *
 * `assertLongPollTimeoutSafe` makes a `clientTimeoutMs` that isn't comfortably
 * larger than `listenTimeoutMs` a hard constructor-time failure. `serverHoldMs`
 * MUST be the actual server-side hold sent on the wire, not a client-side knob
 * — see test/debug-transport.test.ts for the exact boundary. Full incident
 * writeup: the git history.
 */
export function assertLongPollTimeoutSafe(serverHoldMs: number, clientTimeoutMs: number): void {
  if (!(serverHoldMs + LONGPOLL_TIMEOUT_MARGIN_MS < clientTimeoutMs)) {
    throw new Error(
      `Unsafe long-poll timeout configuration: serverHoldMs (${serverHoldMs}ms) + ` +
        `${LONGPOLL_TIMEOUT_MARGIN_MS}ms safety margin must be LESS than clientTimeoutMs ` +
        `(${clientTimeoutMs}ms), but it is not (serverHoldMs=${serverHoldMs}, margin=` +
        `${LONGPOLL_TIMEOUT_MARGIN_MS}, clientTimeoutMs=${clientTimeoutMs}). This is exactly the ` +
        "class of bug that cost an earlier implementation its long-poll: a " +
        "client-side timeout ceiling at or below the server's own listener timeout turns every " +
        "long poll into a hard transport error instead of a clean timeout. Raise clientTimeoutMs " +
        "or lower the server-side hold — do not remove this check.",
    );
  }
}

/**
 * Converts a server-side listener hold given in SECONDS (the units the `timeout`
 * query parameter is actually sent in — see `DebugSession.listenerTimeoutSeconds`
 * in session.ts) to ms and delegates to `assertLongPollTimeoutSafe`. Callers
 * building the launch URL should call this with the exact seconds value placed
 * on the wire, not a separate client-side timeout knob.
 */
export function assertServerHoldSafe(serverHoldSeconds: number, clientAbortMs: number): void {
  try {
    assertLongPollTimeoutSafe(serverHoldSeconds * 1000, clientAbortMs);
  } catch {
    throw new Error(
      `Unsafe long-poll timeout configuration: listenerTimeoutSeconds (server hold, ` +
        `${serverHoldSeconds}s = ${serverHoldSeconds * 1000}ms) and listenTimeoutSeconds/` +
        `clientTimeoutMs (client abort, ${clientAbortMs}ms) have drifted — the server-side hold ` +
        `plus the ${LONGPOLL_TIMEOUT_MARGIN_MS}ms safety margin must be LESS than the client's ` +
        "abort deadline. Raise the client abort deadline or lower listenerTimeoutSeconds.",
    );
  }
}

// ---------------------------------------------------------------------------
// The narrow raw-HTTP primitive the long-poll client (and CSRF fetch) run on.
// Deliberately NOT axios/fetch — see assertLongPollTimeoutSafe's doc comment.
// ---------------------------------------------------------------------------

export interface RawHttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /**
   * Opt-in for a request that will sit idle for tens of seconds and must not
   * reuse a pooled socket. Without this, a stale keep-alive socket from an
   * earlier request can carry an inherited 5000ms `socket.setTimeout()` that
   * persists across pool reuse, killing the poll locally at ~5s with an
   * ECONNRESET that looks like a server fault — wire-confirmed with
   * `NODE_DEBUG=http,net`. Set on exactly one call site: the long-poll POST in
   * `DebugLongPollClient.listen`; ordinary requests (the CSRF `HEAD`) must
   * leave it unset. Full trace: the git history.
   */
  longPoll?: boolean;
}

/**
 * Injectable so `test/debug-transport.test.ts` runs with zero live calls.
 * Injection does not opt out of the transport-release denial: both call sites
 * assert `assertHttpPathAllowed` on the URL themselves before reaching this fn
 * (see the file's layering note).
 */
export type RawHttpRequestFn = (req: RawHttpRequest) => Promise<RawResponse>;

/** Thrown/reported when a request is cancelled via its `AbortSignal`. */
export class LongPollAborted extends Error {
  constructor(message = "Long-poll request aborted.") {
    super(message);
    this.name = "AbortError";
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

function normalizeNodeHeaders(h: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

/**
 * Options for {@link createRawHttpRequestFn}. Bakes the TLS-verification
 * policy (`ABAP_INSECURE`) into a closure at construction instead of
 * threading it through every `RawHttpRequest` call site.
 */
export interface RawHttpRequestFnOptions {
  /**
   * Built by `buildInsecureHttpsAgent` (`src/adt/http-guard.ts`) from the SAME
   * `conn.cfg.insecure` the ADT/axios stack uses — never re-derived locally.
   * Only `rejectUnauthorized` is reused, not the socket pool (see `agent:
   * false` below): this shares the TLS policy, not the pool.
   */
  httpsAgent?: https.Agent;
}

/**
 * Builds a `RawHttpRequestFn`: a bare `node:http`/`node:https` request with no
 * default timeout of any kind — the only way it ends early is the caller's
 * `AbortSignal`. Asserts the transport-release denial as a last line of
 * defence (both call sites assert it themselves, earlier — see the file's
 * layering note).
 */
export function createRawHttpRequestFn(opts: RawHttpRequestFnOptions = {}): RawHttpRequestFn {
  const { httpsAgent } = opts;
  return (req) =>
    new Promise<RawResponse>((resolve, reject) => {
      // Structural denial, ahead of every line below — no socket opened yet.
      // Rejects (not throws) since we're already inside the executor. Full
      // `req.url` including query string, since a raw request has no `qs`.
      try {
        assertHttpPathAllowed(req.method, req.url);
      } catch (e) {
        reject(e);
        return;
      }

      let url: URL;
      try {
        url = new URL(req.url);
      } catch (e) {
        reject(e);
        return;
      }
      const isHttps = url.protocol === "https:";

      // Proxy policy (the proxy half of that two-part feature — TLS is
      // handled below/by `httpsAgent`). `undefined` when no `HTTP_PROXY`/`HTTPS_PROXY`/
      // `ALL_PROXY`/`NO_PROXY` combination applies to this URL; see
      // `planProxyRequest`'s doc comment for the CONNECT-tunnel-vs-forward-
      // proxy split and why it never reintroduces agent pooling into the
      // long-poll path.
      let proxyPlan: ProxyRequestPlan | undefined;
      try {
        proxyPlan = planProxyRequest(url, req.headers);
      } catch (e) {
        reject(e);
        return;
      }
      const transport = proxyPlan?.transport ?? (isHttps ? https : http);

      // TLS policy: only for `https:` — an https.Agent on an http:
      // request is a protocol mismatch, not a no-op. Passed as a plain
      // per-request option (not `agent: httpsAgent`) on the long-poll branch
      // so the override survives without adopting the shared Agent's pool
      // (confirmed empirically against a live system).
      // Applies equally when tunnelling through a proxy: `rejectUnauthorized`
      // governs the TLS handshake with the ORIGIN server at the far end of
      // the `CONNECT` tunnel, not the (plaintext, by convention) hop to the
      // proxy itself.
      const insecureOverride =
        isHttps && httpsAgent?.options.rejectUnauthorized === false
          ? { rejectUnauthorized: false as const }
          : {};

      let options: http.RequestOptions;
      if (proxyPlan && isHttps) {
        // CONNECT-tunnel: a dedicated, never-shared Agent built fresh for
        // THIS request (see `planProxyRequest`'s doc comment) stands in for
        // both the long-poll's `agent: false` and the ordinary shared
        // `httpsAgent` — tunnelling through a proxy has no agent-less path;
        // only a custom `Agent.connect()` can route a socket through
        // `CONNECT`. Freshness per call is what keeps this from reintroducing
        // the pooled-socket hazard `agent: false` exists to avoid.
        options = {
          method: req.method,
          headers: req.headers,
          agent: proxyPlan.agent,
          ...insecureOverride,
        };
      } else if (proxyPlan) {
        // Forward-proxy (HTTP target): `proxyPlan.options` already retargets
        // hostname/port/path at the proxy and folds in the Host/
        // Proxy-Authorization headers — no Agent involved at all, so
        // `agent: false` for the long-poll case is exactly as untouched as
        // it was before proxy support existed.
        options = req.longPoll
          ? { method: req.method, ...proxyPlan.options, agent: false }
          : { method: req.method, ...proxyPlan.options };
      } else {
        // `agent: false` (not a dedicated Agent): forces Node to build a
        // fresh per-request Agent with zero inherited socket state, for both
        // http and https via the shared `transport`. Absent (not `undefined`)
        // for ordinary requests so existing globalAgent behaviour is
        // untouched, unless a shared `httpsAgent` was supplied — safe
        // to reuse directly for short-lived CSRF HEADs, no keep-alive hazard
        // there.
        options = req.longPoll
          ? { method: req.method, headers: req.headers, agent: false, ...insecureOverride }
          : {
              method: req.method,
              headers: req.headers,
              ...(isHttps && httpsAgent ? { agent: httpsAgent } : {}),
            };
      }

      const request = transport.request(
        url,
        options,
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: normalizeNodeHeaders(res.headers),
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
          res.on("error", (e) => reject(e));
        },
      );
      if (req.longPoll) {
        // Belt: clear any idle timeout on this request.
        request.setTimeout(0);
        // Braces: neutralise a stale timer if a socket is somehow reused.
        request.on("socket", (s) => s.setTimeout(0));
      }

      request.on("error", (e) => reject(e));

      if (req.signal) {
        if (req.signal.aborted) {
          request.destroy(new LongPollAborted());
        } else {
          req.signal.addEventListener("abort", () => request.destroy(new LongPollAborted()), {
            once: true,
          });
        }
      }

      if (req.body !== undefined) request.write(req.body);
      request.end();
    });
}

/** Default `RawHttpRequestFn`: `createRawHttpRequestFn()` with no shared TLS agent. */
export const defaultRawHttpRequest: RawHttpRequestFn = createRawHttpRequestFn();

function headerValue(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return "";
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] ?? "" : "";
}

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

/**
 * `HEAD /sap/bc/adt/core/discovery` — ~25ms vs ~56s for GET, per vsp's
 * `fetchCSRFToken` (`http.go:286`), Copyright (c) 2025-2026 Alice Vinogradova
 * and contributors, MIT (THIRD-PARTY-NOTICES.md). Lighter than the `GET
 * /sap/bc/adt/discovery` `AbapConnection` itself uses; exists only for the
 * long-poll client, which has no access to that path.
 *
 * Do not check `resp.ok`/`status < 400` before reading the header: a `HEAD`
 * can legitimately answer 400 and still carry a fresh, valid `x-csrf-token`.
 */
export interface FetchCsrfTokenOptions {
  baseUrl: string;
  cookieHeader?: string;
  requestFn?: RawHttpRequestFn;
  signal?: AbortSignal;
  /**
   * SHARED `AuthCircuitBreaker` (never a second instance), REQUIRED. Used to
   * be optional for compile-compat, which let this HEAD dispatch even while
   * the breaker had latched — and since an expired SSO session here lands on
   * the ICF logon page (SAP counts that as a failed logon) yet threw a plain
   * `Error` leaving the breaker CLOSED, `listen()` retried it unboundedly,
   * risking a real account lockout. With the breaker required, an auth
   * failure here latches permanently and surfaces as `AUTH_CIRCUIT_OPEN`.
   */
  breaker: AuthCircuitBreaker;
  /**
   * Called with the raw response after the breaker verdict, before the token
   * check, so a caller can harvest a rotated `set-cookie`. Must not throw.
   */
  onResponse?: (raw: RawResponse) => void;
}

export async function fetchCsrfToken(opts: FetchCsrfTokenOptions): Promise<string> {
  const requestFn = opts.requestFn ?? defaultRawHttpRequest;
  const url = joinUrl(opts.baseUrl, "/sap/bc/adt/core/discovery");
  const headers: Record<string, string> = {
    "x-csrf-token": "fetch",
    // Same header/casing as every other debugger call — without it SAP mints
    // a fresh stateless session for this HEAD.
    "X-sap-adt-sessiontype": "stateful",
  };
  if (opts.cookieHeader) headers.cookie = opts.cookieHeader;

  // STRUCTURAL DENIAL FIRST — before the breaker gates, before `requestFn`,
  // before any socket. Same function/ordering as `GuardedHttpClient.request()`.
  // Asserted here (not only inside `defaultRawHttpRequest`) because `requestFn`
  // is injectable. `url` passed whole, query included.
  assertHttpPathAllowed("HEAD", url);

  // ASK THE BREAKER BEFORE SPENDING A REQUEST. This call used to feed the
  // breaker without ever being stopped by it — it could push the breaker open
  // for every other caller and then sail through it itself. Same two-stage
  // gate and order as `GuardedHttpClient.request()`: permanent auth latch
  // first, then the transient machine. `state`/`allowRequest()` adjacent with
  // no `await` between, so the half-open single-probe property survives a burst.
  const breaker = opts.breaker;
  if (breaker.isTripped) throw circuitOpenError(breaker);
  const wasHalfOpen = breaker.state === "half-open";
  if (!breaker.allowRequest()) throw transientOpenError(breaker);
  const isProbe = wasHalfOpen;

  let resp: RawResponse;
  try {
    resp = await requestFn({ method: "HEAD", url, headers, signal: opts.signal });
  } catch (e) {
    // We claimed the half-open probe slot above; nothing else resolves it, so
    // a throw here must, or the breaker wedges half-open forever.
    if (isProbe && breaker.status().probeInFlight) {
      breaker.recordTransientFailure({ url, message: describeUnknownError(e) });
    }
    throw e;
  }

  // Feed the shared breaker before the token check, so an auth failure
  // surfaces as AUTH_CIRCUIT_OPEN, not a generic error that left it closed.
  // `inspect()` resolves the probe only for 2xx/3xx/5xx/408/429; a plain 4xx
  // would leave it wedged, so resolve it explicitly below.
  breaker.inspect(resp, url);
  if (isProbe && breaker.status().probeInFlight) breaker.recordSuccess();
  if (breaker.isTripped) throw circuitOpenError(breaker);
  opts.onResponse?.(resp);

  // Deliberately no status check before this line — see doc comment above.
  const token = headerValue(resp.headers, "x-csrf-token");
  if (!token || token.toLowerCase() === "required") {
    throw new Error(
      `CSRF token fetch (HEAD ${url}) did not return a usable token (HTTP ${resp.status}).`,
    );
  }
  return token;
}

/**
 * Split a `set-cookie` header into individual cookies. Node may hand this as
 * an array or already `", "`-joined by `normalizeNodeHeaders`. Splitting a
 * joined value on bare `","` is wrong (`Expires=Wed, 21 Oct...` contains one),
 * so we only split where a comma is followed by a cookie-name token and `=`.
 */
const SET_COOKIE_SPLIT = /,\s*(?=[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*=)/;

function splitSetCookie(value: string | string[]): string[] {
  const parts = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const part of parts) {
    for (const piece of String(part).split(SET_COOKIE_SPLIT)) {
      const trimmed = piece.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

/** Reads `set-cookie` off a response tolerating both the array and joined-string shapes. */
function setCookieOf(headers: Record<string, string> | undefined): string | string[] | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === "set-cookie");
  if (key === undefined) return undefined;
  const v: unknown = (headers as Record<string, unknown>)[key];
  if (Array.isArray(v)) return v.length ? (v as string[]) : undefined;
  return typeof v === "string" && v.length ? v : undefined;
}

/**
 * Merge `set-cookie` values into a `Cookie:` header by name — new value wins,
 * unmentioned cookies preserved. Only `name=value` matters; attributes
 * dropped. Exported for testability.
 */
export function mergeCookieHeader(
  existing: string,
  setCookie: string | string[] | undefined,
): string {
  const jar = new Map<string, string>();
  for (const pair of (existing || "").split(";")) {
    const trimmed = pair.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    jar.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  if (setCookie !== undefined) {
    for (const cookie of splitSetCookie(setCookie)) {
      const nameValue = (cookie.split(";", 1)[0] ?? "").trim();
      const eq = nameValue.indexOf("=");
      if (eq <= 0) continue;
      const name = nameValue.slice(0, eq).trim();
      if (!name) continue;
      jar.set(name, nameValue.slice(eq + 1).trim());
    }
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return base + p;
}

function buildUrlWithQuery(baseUrl: string, path: string, qs?: Record<string, string>): string {
  const url = joinUrl(baseUrl, path);
  if (!qs || Object.keys(qs).length === 0) return url;
  const search = new URLSearchParams(qs).toString();
  return `${url}?${search}`;
}

// ---------------------------------------------------------------------------
// AdtError construction — two sources, one shape.
// ---------------------------------------------------------------------------

/**
 * Build an `AdtError` from whatever `abap-adt-api` threw, via
 * `DebugTransport.request()`. Reuses `adtExceptionInfo` (`src/adt/session.ts`)
 * rather than re-parsing raw XML.
 */
export function adtErrorFromException(e: unknown, path: string): AdtError {
  // Forensic capture — no-op unless ABAPSMITH_BODY_DUMP_DIR is set. Takes the
  // raw thrown object since everything below has already discarded it.
  captureErrorBody("adtErrorFromException", path, e);
  const info = adtExceptionInfo(e);
  const message = info?.message || describeUnknownError(e);
  const rawBody = info?.response?.body ?? "";
  // GROUND TRUTH (live capture, 2026-07): a `getStack` on a released debug
  // session throws `AdtErrorException` (not `AdtHttpException`), status 500,
  // with a populated `.properties` (so `exceptionClassNames` below DOES fire)
  // but no `.response` — `rawBody` is "" and `bodyExcerpt` degrades to the
  // generic "An exception was raised" message; no predicate may key on
  // `bodyExcerpt` for this path. On the OTHER exception shape
  // (`AdtHttpException`), `adtExceptionInfo` recovers the response one level
  // down via `.parent`, so `rawBody`/`bodyExcerpt` ARE populated there — same
  // field, different exception shape. `truncateDiagnosticBody` keeps it
  // bounded (full bytes to ABAPSMITH_BODY_DUMP_DIR); pinned by
  // test/error-capture.test.ts. Full investigation, including why this used
  // to misclassify as `ADT_ERROR`: the git history.
  const exceptionClassNames = collectExceptionClassNames(info?.properties);
  return {
    status: info?.status ?? 0,
    subtype: info?.properties["com.sap.adt.communicationFramework.subType"] || undefined,
    abapType: info?.type,
    message,
    path,
    bodyExcerpt: truncateDiagnosticBody(rawBody || message),
    ...(exceptionClassNames.length ? { exceptionClassNames } : {}),
  };
}

// ---------------------------------------------------------------------------
// Discrimination predicates: structural (status/subtype/abapType), never
// `.includes()` on `.message`. Defined once in `xml-response.ts`, re-exported
// here for existing `from "./transport.js"` import sites.
// ---------------------------------------------------------------------------
export { isConflict, isNoSessionAttached, isSessionExpired };

// ---------------------------------------------------------------------------
// Error translation — reuses the EXISTING AbapErrorCode union (src/adt/errors.ts)
// per the note left on AdtError in types.ts. No rival error-code type.
// ---------------------------------------------------------------------------

/**
 * `subtype` is a discriminator callers switch on (e.g. `DebugSession.attach()`
 * recognises "Debuggee already attached" via `details.subtype ===
 * "invalidDebuggee"`), not decoration — it must survive into `details`
 * whichever branch below classifies the error. Spread-conditionally so the
 * key is absent, not `undefined`, when there is no subtype.
 */
const withSubtype = (err: AdtError): { subtype?: string } =>
  err.subtype ? { subtype: err.subtype } : {};

// `ExceptionResourceNoAccess` is two different problems wearing one code.

/**
 * The ABAP exception class SAP puts on a refused workbench operation. Structural
 * (`<type id="…"/>`), so it is the same string in every logon language — unlike
 * the message beside it.
 */
export const RESOURCE_NO_ACCESS_TYPE = "ExceptionResourceNoAccess";

/** `<type id="ExceptionResourceNoAccess"/>` — see `resourceNoAccessError`. */
export const isResourceNoAccess = (err: AdtError): boolean =>
  err.abapType === RESOURCE_NO_ACCESS_TYPE;

/**
 * T100 `EU`/`510` as this appliance renders it in EN: "User DEVELOPER is
 * currently editing ZMCP_DBG_DEMO" (test/fixtures/live-captured/
 * 095-np-activate.xml and its twin 108-np-activate-restore.xml, HTTP 403).
 *
 * Positive-only, not a classifier: a match is evidence of the lock meaning; a
 * non-match proves nothing (this appliance answers in the logon language, so
 * other languages won't match). Can only promote the lock reading, never
 * demote the authorisation reading. The language-independent discriminator
 * SAP does supply (`T100KEY-ID`/`T100KEY-NO`, same pair `isLockConflict` in
 * src/adt/session.ts keys on) isn't reachable here — `AdtError` drops the
 * property map. See `resourceNoAccessError` for what would fix that.
 */
const EU510_LOCK_TEXT = /\bis currently editing\b/i;

/**
 * Build the answer for `ExceptionResourceNoAccess`.
 *
 * Not `AUTH_FAILED`: a missing `S_DEVELOP` authorisation and a lock conflict
 * arrive as the same exception class and HTTP 403 — routing both to
 * `AUTH_FAILED` told users to check their password for a problem that often
 * wasn't one.
 *
 * Not resolved to a single code either: the live corpus has exactly one
 * `ExceptionResourceNoAccess` capture (095-np-activate.xml /
 * 108-np-activate-restore.xml) and it's the LOCK case — activation issued
 * while the caller held its own MODIFY lock (T100 EU/510). There is no
 * captured missing-authorisation instance, so nothing establishes what
 * separates the two; `AMBIGUOUS` names both meanings rather than guessing.
 *
 * To make this a real classification: (1) have `AdtError` carry
 * `T100KEY-ID`/`T100KEY-NO` (already extracted by `adtExceptionInfo` in
 * src/adt/session.ts, just dropped by `AdtError`) so `EU`/`510` means "lock"
 * language-independently; (2) capture a genuine `S_DEVELOP` refusal to see
 * how it actually differs. Until then this branch is a deliberate hedge.
 */
function resourceNoAccessError(err: AdtError): AbapError {
  const lockTextSeen = EU510_LOCK_TEXT.test(err.message ?? "");
  return new AbapError(
    "AMBIGUOUS",
    `${err.message || "The ABAP system refused access to this resource (HTTP 403)."} ` +
      `— SAP reports \`${RESOURCE_NO_ACCESS_TYPE}\`, which on this system means EITHER (a) the ` +
      `object is LOCKED (an ENQUEUE lock — possibly one THIS session is holding itself), OR ` +
      `(b) the user lacks the AUTHORISATION (typically \`S_DEVELOP\`) for this object. ` +
      `The wire gives no signal that separates the two.` +
      (lockTextSeen
        ? " The message text matches the captured lock refusal (T100 EU/510, \"is currently " +
          "editing\"), so (a) is the more likely of the two here — but that text is localised, " +
          "so it is a hint, not proof."
        : ""),
    {
      status: err.status,
      abapType: err.abapType,
      ...withSubtype(err),
      path: err.path,
      // Machine-readable form of the hedge, so a caller can branch on the pair
      // rather than parsing the prose above.
      possibleCauses: ["lock-conflict", "missing-authorization"],
      ...(lockTextSeen ? { likelyCause: "lock-conflict", evidence: "t100-eu510-message-text" } : {}),
      ...(err.exceptionClassNames?.length ? { exceptionClassNames: err.exceptionClassNames } : {}),
    },
    "Two fixes, one per meaning — try them in this order. " +
      "(a) LOCK: release the lock you hold before the operation that needs it — the proven ADT " +
      "order is lock → PUT → UNLOCK → activate, and activating while still holding your own " +
      "lock handle returns exactly this 403 every time (live-proven, " +
      "test/fixtures/live-captured/INDEX.md). If the lock is someone else's, wait, or clear a " +
      "stale ENQUEUE in SM12. " +
      "(b) AUTHORISATION: this is NOT a credentials problem and NOT a stale CSRF token — the " +
      "logon succeeded. Do not change ABAP_PASSWORD and do not retry: repeated logons lock the " +
      "SAP user. Have the user's `S_DEVELOP` authorisation for this object type/package/activity " +
      "checked (SU53 right after the failure shows the exact missing field).",
  );
}

export function translateDebugError(err: AdtError): AbapError {
  if (isNoSessionAttached(err)) {
    return new AbapError(
      "NOT_CONNECTED",
      err.message || "No debug session is attached yet.",
      { status: err.status, subtype: err.subtype, abapType: err.abapType, path: err.path },
      "Often the normal pre-attach state, not a real failure — " +
        "attach before any stack/variable/step call.",
    );
  }

  if (isConflict(err)) {
    return new AbapError(
      "LOCKED",
      err.message || "Another debug listener/session conflicts with this one.",
      { status: err.status, subtype: err.subtype, path: err.path },
      "Another IDE user or terminal already owns this listener/breakpoint scope. " +
        "Stop it there, or use a distinct terminalId.",
    );
  }

  if (isSessionExpired(err)) {
    // ARCH-09 §5.5/P6. `isSessionExpired` already covers `debuggeeEnded`; what
    // was missing was the WORDING — the wire message here is the generic ADI
    // wrapper text ("An exception was raised"), which reads like a crash for a
    // normal program end. Say what the subtype already told us instead.
    if (isDebuggeeEnded(err)) {
      return new AbapError(
        "SESSION_DEAD",
        "The debuggee ran to completion. The program finished running, and the debug session " +
          "that was attached to it is over.",
        { status: err.status, ...withSubtype(err), path: err.path },
        "This is a normal end, not a failure — nothing crashed. Start a new debug session " +
          "(set a breakpoint and attach again) to debug another run.",
      );
    }
    return new AbapError(
      "SESSION_DEAD",
      err.message || "The ABAP debug session no longer exists.",
      {
        status: err.status,
        ...withSubtype(err),
        path: err.path,
        // This branch used to drop `exceptionClassNames`/`bodyExcerpt` that the
        // fallback ADT_ERROR branch keeps — the evidence for which of the known
        // session-gone shapes fired. Present only when non-empty/defined so the
        // existing detail shape for other errors is unchanged.
        ...(err.exceptionClassNames?.length ? { exceptionClassNames: err.exceptionClassNames } : {}),
        ...(err.bodyExcerpt ? { bodyExcerpt: err.bodyExcerpt } : {}),
      },
      "NOT an authentication failure. Recovery is manual and complete: re-login if needed, " +
        "re-set breakpoints, re-listen, re-attach — everything after attach is invalidated.",
    );
  }

  if (err.status === 401) {
    return new AbapError(
      "AUTH_FAILED",
      err.message || "Authentication rejected by the ABAP system.",
      { status: 401, ...withSubtype(err), path: err.path },
      "Not retried — the same hard rule applies to debugger requests as to every other " +
        "ADT call.",
    );
  }

  if (isResourceNoAccess(err)) {
    return resourceNoAccessError(err);
  }

  if (err.status === 403) {
    return new AbapError(
      "AUTH_FAILED",
      err.message || "Authorization refused (HTTP 403).",
      { status: 403, subtype: err.subtype, abapType: err.abapType, path: err.path },
      "Treated as a genuine authorization failure, not a stale CSRF token: the transport " +
        "already retries the one 403 shape that looks like a stale token " +
        "(`x-csrf-token: Required`) before this translation ever runs, and only once " +
        "(an earlier blanket 403 retry masked real " +
        "authorization failures and produced a misleading 'DEPRECATED: 403 CSRF' comment).",
    );
  }

  if (err.status === 404 || err.abapType === "ExceptionResourceNotFound") {
    return new AbapError(
      "NOT_FOUND",
      err.message || `${err.path} does not exist.`,
      { path: err.path, ...withSubtype(err), abapType: err.abapType },
    );
  }

  return new AbapError(
    "ADT_ERROR",
    err.message || `Debugger request to ${err.path} failed (HTTP ${err.status}).`,
    {
      status: err.status,
      subtype: err.subtype,
      abapType: err.abapType,
      path: err.path,
      bodyExcerpt: err.bodyExcerpt,
      // Spread conditionally so subtype-less/class-name-less errors keep their existing detail
      // shape. Present because its ABSENCE here once got read as "the extractor never ran" —
      // it had run; this hand-built object was simply dropping the field.
      ...(err.exceptionClassNames?.length
        ? { exceptionClassNames: err.exceptionClassNames }
        : {}),
    },
  );
}

// Ordinary (non-long-poll) debugger requests — reuses AbapConnection wholesale.

export interface DebugRequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  headers?: Record<string, string>;
  qs?: Record<string, string>;
  body?: string;
}

/**
 * `DebugRequestOptions` narrowed to the three mutating verbs. `dispatchMutation`
 * takes one of these plus an `AuthorizedTarget` — the type system makes it a
 * compile error to reach `connection.post/put/del` without going through
 * `SafetyGate.authorize()` first.
 */
type MutatingDebugRequestOptions = DebugRequestOptions & { method: "POST" | "PUT" | "DELETE" };

/**
 * Synthetic `SafetyTarget` for a `DebugTransport` constructed with a `safety`
 * gate but no `target` — no real call chain does this (`abap_debug`'s
 * `handleStart` always resolves a target first), so this is a defensive
 * fallback for hand-built/test transports. A customer-namespace name with no
 * package clears `evaluate()`'s default checks, reproducing this layer's
 * prior behaviour of enforcing only the object-independent rules when the
 * object isn't known yet. Does not reproduce a non-default
 * `ABAP_ALLOW_NAME_PREFIXES` that excludes "Z" — accepted since no production
 * path reaches this fallback.
 */
const UNRESOLVED_DEBUG_TARGET: SafetyTarget = { name: "ZDEBUG_TRANSPORT_UNRESOLVED_TARGET" };

/** See `DebugTransport.authorizeMutation`. */
export interface DebugTransportOptions {
  /**
   * The process-wide `SafetyGate` (src/safety.ts), REQUIRED even for a
   * GET-only transport — an optional gate would just move the "no gate"
   * hole into the `undefined` branch. `authorizeMutation` still refuses at
   * runtime for defence in depth, but a mutating-capable transport with no
   * gate is no longer constructible at all.
   */
  safety: SafetyGate;
  /**
   * The debuggee, when known. Unlocks the object-scoped allowlist rules
   * (package / namespace / name prefix); without it only the
   * object-independent read-only rules can be decided here (see
   * `UNRESOLVED_DEBUG_TARGET`).
   */
  target?: SafetyTarget;
}

function toDebugRawResponse(r: ConnRawResponse): RawResponse {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) {
    headers[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
  }
  return { status: r.status, headers, body: r.body };
}

/**
 * Issues every debugger request except the long-poll through the existing
 * `AbapConnection` — same breaker, same CSRF handling, same cookie jar (see
 * the file's layering note).
 */
export class DebugTransport {
  private readonly safety: SafetyGate;
  private readonly target: SafetyTarget | undefined;

  constructor(
    private readonly connection: AbapConnection,
    opts: DebugTransportOptions,
  ) {
    this.safety = opts.safety;
    this.target = opts.target;
  }

  /**
   * Every mutating debugger verb passes this before `dispatchMutation` can be
   * reached — mints the `AuthorizedTarget` proof required to call
   * `connection.post/put/del`.
   *
   * Closes two defects: (1) `AbapConnection`'s raw verbs only enforce the
   * circuit breaker, not the write policy, so attach/step/breakpoint-set/
   * terminate — real server-side state changes — went out even on a
   * read-only-by-default server; (2) when `this.safety` was `undefined` the
   * whole gate was skipped, so `ABAP_ALLOW_WRITE=true` with no gate wired in
   * meant zero object-scoped checking. Now: no gate is a hard throw, not a
   * silent skip.
   *
   * Enforced here: the object-independent read-only rules
   * (`ABAP_ALLOW_WRITE`, forced read-only on a productive system). Not
   * enforced here: object-scoped allowlists (`ABAP_ALLOW_PACKAGES`,
   * `ABAP_ALLOW_NAME_PREFIXES`, SAP-namespace) — a debugger URL names no
   * object, so when `this.target` is unknown this falls back to
   * `UNRESOLVED_DEBUG_TARGET`. Where the object IS known (`abap_debug`'s
   * handler in server.ts), those rules already run one layer up; this gate
   * closes the hole underneath, it doesn't replace that check.
   *
   * GET is never gated (reads always allowed, see `MUTATING_OPS` in
   * src/safety.ts). A refused call costs zero network requests and never
   * flips the shared connection to stateful — why this runs first in
   * `request()`.
   */
  private authorizeMutation(
    opts: MutatingDebugRequestOptions,
  ): AuthorizedTarget<"execute", SafetyTarget> {
    // 1. The process-wide gate is now MANDATORY for any mutation. `authorize()`
    //    calls `assert()` internally, so a refusal throws with the exact same
    //    error shape, code and hint as every other refused mutation in the repo,
    //    and a success mints the `AuthorizedTarget` `dispatchMutation` requires.
    if (!this.safety) {
      throw new AbapError(
        "SAFETY_DENIED",
        `A debugger ${opts.method} changes state on the ABAP system and must be authorized by a ` +
          "SafetyGate before it can be dispatched, but this DebugTransport was constructed with " +
          "no safety gate at all.",
        { operation: "execute", method: opts.method, path: opts.path },
        "Construct DebugTransport with { safety: <the process-wide SafetyGate> }. A mutating " +
          "debugger request can no longer reach the wire without one (AuthorizedTarget).",
      );
    }
    const target: SafetyTarget = this.target ?? UNRESOLVED_DEBUG_TARGET;
    const authorized = this.safety.authorize("execute", target, { phase: "preflight" });

    // 2. The connection's OWN policy — always, gate or no gate. This is the same
    //    `cfg.readOnly` (`ABAP_ALLOW_WRITE`) the gate reads, ORed with the
    //    `forcedReadOnly` the connect probe sets when the system reports itself
    //    productive. It is what makes this fix effective on the real wiring:
    //    `createDebugClientForConnection` (src/debug/session.ts) constructs this
    //    class with a connection and nothing else, so without this clause the
    //    check would be a no-op in production until that file is changed.
    if (this.connection.readOnly) {
      throw new AbapError(
        "READ_ONLY",
        `A debugger ${opts.method} changes state on the ABAP system and is refused while the ` +
          `server is read-only. ${this.connection.readOnlyReason}`,
        {
          operation: "execute",
          method: opts.method,
          path: opts.path,
          readOnlyReason: this.connection.readOnlyReason,
        },
        "Attaching to, stepping and terminating a debuggee suspend and resume real work " +
          "processes on the target system — same opt-in as writes. " +
          `${explainDeniedCapability("allowWrite", this.connection.cfg.abapMode).remediation}`,
      );
    }

    return authorized;
  }

  async request(opts: DebugRequestOptions): Promise<RawResponse> {
    // FIRST, before any request and before the shared connection is switched
    // to stateful below: a refused mutation must cost nothing. GET is never
    // gated (see `authorizeMutation`).
    const authorized: AuthorizedTarget<"execute", SafetyTarget> | undefined =
      opts.method === "GET"
        ? undefined
        : this.authorizeMutation(opts as MutatingDebugRequestOptions);

    // Every debugger call must carry `X-sap-adt-sessiontype: stateful`, merged
    // in unconditionally. Setting `opts.headers` alone is not sufficient:
    // `abap-adt-api`'s `AdtHTTP._request()` overwrites it from
    // `connection.adt.stateful` AFTER spreading caller headers, so that
    // property must be set too — it's the one abap-adt-api actually honours.
    //
    // SAVE/RESTORE, INLINE. `connection.adt` is the ONE shared `ADTClient` for
    // the whole process. Before this existed, nothing ever restored the flag,
    // so the first debugger call in a process left `stateful` latched on and
    // every later ordinary read rode out as stateful for the rest of the
    // process lifetime — the opposite of what
    // `AbapConnection.withStatefulSession` (connection.ts:591) promises.
    //
    // Restored to its PREVIOUS value, not hard-coded to `stateless`: (a)
    // nesting safety — concurrent debugger requests each save what they
    // found, so the flag is correct regardless of interleaving; forcing
    // `stateless` would let an inner request clear it out from under an outer
    // one still in flight; (b) a debugger call issued inside a real
    // `withStatefulSession()` block must not tear down that block's session
    // type on exit.
    // Captured ONCE, before dispatch, and reused for the restore below.
    // `connection.adt` is a getter that asserts the connection usable — two
    // concurrent debugger requests share this one connection (see above), so
    // a death recorded by EITHER while this call is in flight must not turn
    // the restore into a throw that masks a result already back from SAP.
    const client = this.connection.adt;
    const previousSessionType = client.stateful;
    client.stateful = session_types.stateful;
    const merged: DebugRequestOptions = {
      ...opts,
      headers: { ...opts.headers, "X-sap-adt-sessiontype": "stateful" },
    };
    try {
      const raw = await this.dispatch(merged, authorized);
      return toDebugRawResponse(raw);
    } catch (e) {
      // `abap-adt-api`'s `AdtHTTP` re-wraps whatever the injected `HttpClient`
      // throws, so an `AbapError` from the guard (e.g. `circuitOpenError`)
      // does not survive as `instanceof AbapError` — only its message does.
      // Check the breaker's own state instead, same fix as
      // `AbapConnection.connect()`/`dropSession()`.
      if (this.connection.breaker.isTripped) throw circuitOpenError(this.connection.breaker);
      if (e instanceof AbapError) throw e; // already structured, and not a breaker trip
      throw translateDebugError(adtErrorFromException(e, opts.path));
    } finally {
      client.stateful = previousSessionType;
    }
  }

  /**
   * `authorized` is `undefined` for GET, a real `AuthorizedTarget` otherwise
   * (from `authorizeMutation`, which throws or returns one). The
   * `if (!authorized)` branch below is an unreachable structural backstop —
   * `dispatchMutation`'s signature makes it a compile error to skip it.
   */
  private dispatch(
    opts: DebugRequestOptions,
    authorized: AuthorizedTarget<"execute", SafetyTarget> | undefined,
  ): Promise<ConnRawResponse> {
    if (opts.method === "GET") {
      return this.connection.get(opts.path, { headers: opts.headers, qs: opts.qs });
    }
    if (!authorized) {
      // Unreachable: request() always authorizes before dispatch(). See the
      // doc comment above.
      throw new Error(
        `BUG: DebugTransport.dispatch reached the ${opts.method} branch with no AuthorizedTarget ` +
          "— every mutating request() call must authorize before dispatching.",
      );
    }
    // Already narrowed to non-GET by the guard above; TS doesn't propagate
    // that through the union-typed property access, hence the assertion.
    return this.dispatchMutation(opts as MutatingDebugRequestOptions, authorized);
  }

  private dispatchMutation(
    opts: MutatingDebugRequestOptions,
    authorized: AuthorizedTarget<"execute", SafetyTarget>,
  ): Promise<ConnRawResponse> {
    // `authorized` isn't read for its payload — that this method can't be
    // called without one IS the guarantee; the gate already ran inside
    // `SafetyGate.authorize()`.
    void authorized;
    switch (opts.method) {
      case "POST":
        return this.connection.post(opts.path, {
          headers: opts.headers,
          qs: opts.qs,
          body: opts.body,
        });
      case "PUT":
        return this.connection.put(opts.path, {
          headers: opts.headers ?? {},
          qs: opts.qs,
          body: opts.body ?? "",
        });
      case "DELETE":
        return this.connection.del(opts.path, { headers: opts.headers, qs: opts.qs });
      /* istanbul ignore next -- exhaustiveness guard, not a reachable branch */
      default: {
        const _exhaustive: never = opts.method;
        throw new Error(`Unhandled debugger request method: ${String(_exhaustive)}`);
      }
    }
  }
}

// The long-poll client.

/**
 * Return of `DebugLongPollClient.listen()`. Splits "request dispatched"
 * (`armed`) from "request settled" (`result`) — see `armed`'s doc comment for
 * exactly what the first signal does and doesn't guarantee.
 */
export interface LongPollHandle {
  /**
   * Always settles, never rejects: resolves once the request has been handed
   * to the transport (or failed before reaching that point — tripped breaker,
   * sync throw). Means "stop waiting," not "it worked" — consult `result`.
   *
   * NOT confirmation SAP registered the listener (no such HTTP-layer signal
   * exists; that needs a separate `GET /debugger/listeners?checkConflict=…`).
   * What this fixes: an earlier implementation used a `time.Sleep(100ms)` guess to sequence "arm the
   * listener" before "fire the trigger," which could fire before the POST even
   * left the process. Awaiting `armed` guarantees the request is in flight.
   */
  armed: Promise<void>;
  /** Resolves with the raw response (including a 200/empty-body timeout), or rejects with a structured `AbapError`. Always settles. */
  result: Promise<RawResponse>;
  /** Idempotent. Cancels the in-flight request (if any) and guarantees `result` settles ("the listener goroutine is leaked... still holding a server-side registration"). */
  abort: () => void;
  readonly aborted: boolean;
}

/**
 * What `DebugLongPollAuth.acquireSession` hands back — deliberately the
 * smallest shape, one idempotent `release`. Not `src/adt/session-lock.ts`'s
 * `SessionLease` (see `acquireSession`'s doc comment for why that dependency
 * is refused, not postponed); a future owner of the real lock can implement
 * this two-line interface and inject it.
 */
export interface DebugSessionLease {
  /** Idempotent. Called exactly once, from `run()`'s `finally`, on every exit path. */
  release: () => void;
}

/** A no-op lease: hold nothing, release nothing. */
const NO_SESSION_LEASE: DebugSessionLease = { release: () => {} };

/**
 * Explicit opt-out for `DebugLongPollAuth.acquireSession`. That field used to
 * be optional and silently default to `NO_SESSION_LEASE` — indistinguishable
 * from a caller who forgot it. Now required: every `DebugLongPollAuth` must
 * say which it means, via this constant or a real implementation.
 */
export const ACQUIRE_NO_SESSION_LEASE: NonNullable<DebugLongPollAuth["acquireSession"]> =
  async () => NO_SESSION_LEASE;

/** Operation label handed to an injected provider, for its diagnostics. */
const LONGPOLL_LEASE_OP = "debug-long-poll";

export interface DebugLongPollAuth {
  cookieHeader: () => string;
  csrfToken: () => string;
  /**
   * OPTIONAL: hand a `set-cookie` from the CSRF-refresh HEAD back to whoever
   * owns the real cookie jar. This module owns none — cookies arrive as an
   * opaque string via `cookieHeader()` — so without this hook a rotated
   * `SAP_SESSIONID` is only honoured for the current `run()`.
   */
  updateCookies?: (setCookieHeader: string | string[]) => void;
  /**
   * REQUIRED (pass `ACQUIRE_NO_SESSION_LEASE` for the explicit no-op). Take
   * the caller's session hold for one long poll's lifetime, released in
   * `run()`'s `finally` on every exit path.
   *
   * THE LAW this serves: a second request on the same stateful ADT session
   * does not complete until an outstanding long poll settles (observed; the
   * enforcing mechanism is unconfirmed — a client-side socket pin would
   * produce identical numbers). The poll itself is never cancelled and times
   * out as an empty 200. `inFlight` below stops this client racing itself; it
   * can't stop an ordinary `DebugTransport` request going out on the same
   * session while a poll is parked for minutes — only the session's owner can
   * serialise that, hence injection rather than building it here.
   *
   * Must resolve from in-process state only — a confirmation round-trip to
   * SAP here would BE the second request the law forbids.
   *
   * Deliberately not `src/adt/session-lock.ts`'s `SessionLease`: that module
   * has zero callers in `src/` today, and its header and code disagree on the
   * re-entrancy mechanism the debugger would depend on (see
   * the git history for the detail). Injection
   * keeps the seam open at zero cost until that's settled.
   */
  acquireSession: (op: string) => Promise<DebugSessionLease>;
}

export interface DebugLongPollOptions {
  baseUrl: string;
  /** The MAIN connection's breaker — reused, never a second instance (see layering note at top of file). */
  breaker: AuthCircuitBreaker;
  auth: DebugLongPollAuth;
  /** Requested server-side listener timeout. Defaults to `LISTENER_SERVER_TIMEOUT_MS` (240s). */
  listenTimeoutMs?: number;
  /**
   * This client's own timeout ceiling. Defaults to `listenTimeoutMs +
   * LONGPOLL_TIMEOUT_MARGIN_MS + 60_000` (comfortably past the required margin).
   * Always validated by `assertLongPollTimeoutSafe` regardless of where it came
   * from.
   */
  clientTimeoutMs?: number;
  /**
   * Overrides `requestFn` construction entirely — if supplied, `httpsAgent`
   * below is ignored. Only `test/debug-transport.test.ts` sets this, to run
   * with zero live calls.
   */
  requestFn?: RawHttpRequestFn;
  /**
   * TLS-verification agent, built by `buildInsecureHttpsAgent`
   * (`src/adt/http-guard.ts`) from the same `ABAP_INSECURE` the ADT/axios
   * stack uses. Ignored if `requestFn` is also supplied. `undefined`
   * preserves the original behaviour: ordinary Node TLS verification.
   *
   * Proxy awareness (`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`) is
   * unconditional and independent of this option — `createRawHttpRequestFn`
   * resolves it per request via `planProxyRequest` (`src/debug/proxy.ts`),
   * the same `proxy-from-env` resolution the ADT/axios stack uses, so it
   * cannot be disabled here and does not need wiring through this field.
   */
  httpsAgent?: https.Agent;
}

export class DebugLongPollClient {
  private readonly baseUrl: string;
  private readonly breaker: AuthCircuitBreaker;
  private readonly auth: DebugLongPollAuth;
  private readonly listenTimeoutMs: number;
  private readonly clientTimeoutMs: number;
  private readonly requestFn: RawHttpRequestFn;
  /**
   * The one mutable field on this class. One instance fronts one stateful ADT
   * session and cookie jar; a second concurrent long-poll does NOT make SAP
   * cancel the outstanding one. Live capture of a same-identity double-listen
   * found SAP accepts both, and the pair can then wedge for minutes with no
   * established recovery (one trial blocked ~1,045,869ms against a 15s
   * requested timeout — observed, not established behaviour, 1 of 2 trials).
   * Rejecting the second call synchronously avoids gambling on that hazard.
   */
  private inFlight = false;

  constructor(opts: DebugLongPollOptions) {
    this.baseUrl = opts.baseUrl;
    this.breaker = opts.breaker;
    this.auth = opts.auth;
    this.listenTimeoutMs = opts.listenTimeoutMs ?? LISTENER_SERVER_TIMEOUT_MS;
    this.clientTimeoutMs =
      opts.clientTimeoutMs ?? this.listenTimeoutMs + LONGPOLL_TIMEOUT_MARGIN_MS + 60_000;
    assertLongPollTimeoutSafe(this.listenTimeoutMs, this.clientTimeoutMs);
    this.requestFn = opts.requestFn ?? createRawHttpRequestFn({ httpsAgent: opts.httpsAgent });
  }

  /**
   * The effective client-side abort deadline (ms) applied in `listen()` via
   * `setTimeout(abort, this.clientTimeoutMs)`. Exposed so callers that build the
   * server-side `timeout` query parameter (e.g. `DebugSession`) can validate it
   * against what is actually sent on the wire, via `assertServerHoldSafe`.
   */
  get clientAbortTimeoutMs(): number {
    return this.clientTimeoutMs;
  }

  /**
   * `POST {path}` (normally `/sap/bc/adt/debugger/listeners`), held open
   * until SAP answers or the caller aborts. Retried only for exactly one
   * CSRF-stale-token retry (see the file's layering note); a 401 or ICF
   * logon-failure body trips the shared breaker instead.
   */
  listen(
    path: string,
    opts: { qs?: Record<string, string>; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): LongPollHandle {
    // In-flight guard. `run()` is private and reachable only from here, so
    // guarding `listen()` guards both. Throws synchronously, before any
    // `armed` promise exists, so it can't strand `armed`. `LOCKED` because
    // that's already this file's code for "someone else owns this listener
    // scope" — same failure, caught locally before SAP has to produce it.
    if (this.inFlight) {
      throw new AbapError(
        "LOCKED",
        "A long-poll is already in flight on this DebugLongPollClient; concurrent listen() " +
          "calls on one client would share (and corrupt) a single stateful ADT session.",
        { path },
        // Deliberately not "…or use a separate terminalId": SAP rejects a
        // second global-scope listener for the same identity with
        // 409/conflictDetected, keyed on (terminalId, ideId); switching to
        // `debuggingMode=terminal` avoids the conflict but never catches a
        // debuggee. A separate client only polls a different endpoint, not a
        // second debug session.
        "Await or abort() the outstanding LongPollHandle first, or use a separate " +
          "DebugLongPollClient for a different endpoint — a second concurrent poll with the " +
          "SAME identity is " +
          "not cancelled by SAP, it is accepted and can wedge both polls for many minutes with " +
          "no established recovery, so refusing it here rather than risking that is safer.",
      );
    }

    const url = buildUrlWithQuery(this.baseUrl, path, opts.qs);
    const controller = new AbortController();
    let aborted = false;
    const abort = (): void => {
      if (aborted) return;
      aborted = true;
      controller.abort();
    };

    if (opts.signal) {
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener("abort", abort, { once: true });
    }

    // The ONE timeout this client is subject to — see assertLongPollTimeoutSafe.
    const timer = setTimeout(abort, this.clientTimeoutMs);
    if (typeof timer.unref) timer.unref();

    let resolveArmed!: () => void;
    const armed = new Promise<void>((res) => {
      resolveArmed = res;
    });

    // Assigning a boolean can't throw, so this is safe inside the one region
    // where a throw would strand `armed`. Cleared in run()'s finally.
    this.inFlight = true;
    const result = this.run(url, opts.headers, controller.signal, path, resolveArmed).finally(() =>
      clearTimeout(timer),
    );
    // `result` is often awaited only minutes later (arm -> trigger -> attach),
    // or never, if the caller aborts. Attach an inert handler at creation so a
    // background rejection can't reach Node's unhandledRejection path.
    void result.catch(() => {});

    return {
      armed,
      result,
      abort,
      get aborted() {
        return aborted;
      },
    };
  }

  private async run(
    url: string,
    extraHeaders: Record<string, string> | undefined,
    signal: AbortSignal,
    path: string,
    resolveArmed: () => void,
  ): Promise<RawResponse> {
    let armedSignalled = false;
    // Set when this call claimed the breaker's half-open probe slot below;
    // every exit path must resolve it (see finally).
    let isProbe = false;
    let sawResponse = false;
    // The injected session hold, if any; declared here so finally can release it.
    let lease: DebugSessionLease | undefined;
    // Every exit path — pre-flight throw, sync throw from auth/requestFn, an
    // abort, an HTTP error, or a clean return — must leave `armed` settled, or
    // a consumer awaiting it (session.ts) hangs forever. The success path
    // signals early, from inside the loop; this `finally` is the backstop.
    // `armed` never rejects — the outcome lives on `result`.
    try {
      // STRUCTURAL DENIAL FIRST, same ordering as `GuardedHttpClient.request()`
      // — ahead of the breaker gates, the session lease, and `requestFn`.
      // Asserted here (not only inside `defaultRawHttpRequest`) because
      // `this.requestFn` is injectable. `url` is already fully composed
      // (`buildUrlWithQuery` folded in `opts.qs`), passed whole. Inside the
      // `try`, not `listen()`, so a denial rejects `result` like the breaker
      // refusals next to it, instead of stranding a consumer awaiting `armed`.
      assertHttpPathAllowed("POST", url);

      // BOTH machines are asked, not just the auth latch — this path already
      // feeds the shared breaker (via `inspect()` below and the CSRF-refresh
      // HEAD), so a failing long-poll could push it open for every caller and
      // then keep re-issuing 240s polls straight through it. A long-poll pins
      // a dialog work process (the sandbox has seven) — the last request that
      // should dodge load shedding. Same order as the canonical gate: latch
      // first, then transient. Gated once here, not per loop iteration — the
      // loop's second pass is the one documented CSRF retry of an already-
      // authorised request.
      if (this.breaker.isTripped) {
        throw circuitOpenError(this.breaker);
      }
      const wasHalfOpen = this.breaker.state === "half-open";
      if (!this.breaker.allowRequest()) {
        throw transientOpenError(this.breaker);
      }
      isProbe = wasHalfOpen;

      // Taken after the breaker gate (a refused call must not hold a session
      // another caller is waiting on) and before anything else touches the
      // session (csrfToken() and the CSRF-refresh HEAD ride this lease).
      // No try/catch: a provider refusal (SESSION_BUSY) is a legitimate
      // outcome that must reach `result` unchanged; `finally` still settles
      // `armed`/`inFlight`/the probe slot. Known wrinkle: a refusal while the
      // breaker was half-open resolves the probe slot as a transient failure
      // (unresolved would wedge the breaker half-open forever) — same as abort.
      lease = await this.auth.acquireSession(LONGPOLL_LEASE_OP);

      let csrfToken = this.auth.csrfToken();
      let csrfRetried = false;
      // Set by the CSRF-refresh HEAD if SAP rotated the session cookie; merged
      // over auth.cookieHeader() (never replacing it) so the retry POST sends
      // the new SAP_SESSIONID with the new token — a mismatch is a permanent 403.
      let rotatedCookies: string | string[] | undefined;
      const currentCookieHeader = (): string =>
        rotatedCookies === undefined
          ? this.auth.cookieHeader()
          : mergeCookieHeader(this.auth.cookieHeader(), rotatedCookies);

      for (;;) {
        const headers: Record<string, string> = {
          cookie: currentCookieHeader(),
          "x-csrf-token": csrfToken,
          ...extraHeaders,
          // Must never be overridden by extraHeaders, so it's last.
          "X-sap-adt-sessiontype": "stateful",
        };

        let raw: RawResponse;
        try {
          const pending = this.requestFn({ method: "POST", url, headers, signal, longPoll: true });
          if (!armedSignalled) {
            armedSignalled = true;
            resolveArmed(); // dispatched — see LongPollHandle.armed's doc comment
          }
          raw = await pending;
          sawResponse = true;
        } catch (e) {
          // `signal.aborted` is checked alongside `isAbortError(e)` because not
          // every RawHttpRequestFn (real or injected) rejects with a named
          // AbortError — the signal firing is the ground truth for "we cancelled."
          if (signal.aborted || isAbortError(e)) {
            throw new AbapError(
              "TRANSPORT_ERROR",
              "Long-poll cancelled before it produced a result.",
              { path },
              "Expected on deliberate abort(); if unexpected, check the caller's own timeout.",
            );
          }
          throw e;
        }

        // Same shared breaker every response feeds — a 401 or ICF logon page
        // here must disable the whole connection, not just this call.
        this.breaker.inspect(raw, url);
        if (this.breaker.isTripped) {
          throw circuitOpenError(this.breaker);
        }

        if (isStaleCsrfChallenge(raw) && !csrfRetried) {
          // Exactly one retry, only on the header-confirmed stale-token signal.
          csrfRetried = true;
          // `onResponse` is documented "must not throw", but caller-supplied
          // `updateCookies` can anyway. Stash rather than let it unwind: unwound,
          // it would be flattened into the abort mapping below (masking the real
          // cause) and escape `result` as a bare Error instead of an AbapError.
          const cookieFailure: { thrown?: unknown } = {};
          const cancelled = () =>
            new AbapError(
              "TRANSPORT_ERROR",
              "Long-poll cancelled before it produced a result.",
              { path },
              "Cancelled while refreshing the CSRF token. Expected on deliberate abort(); " +
                "if unexpected, check the caller's own timeout.",
            );
          try {
            csrfToken = await fetchCsrfToken({
              baseUrl: this.baseUrl,
              cookieHeader: currentCookieHeader(),
              requestFn: this.requestFn,
              // Without this the HEAD inherits no timeout (see
              // defaultRawHttpRequest) and a silent partition here would make
              // abort() a no-op and `result` never settle.
              signal,
              // Never let this HEAD be the one unguarded request.
              breaker: this.breaker,
              onResponse: (headResp) => {
                const sc = setCookieOf(headResp.headers);
                if (sc === undefined) return;
                rotatedCookies = sc;
                try {
                  this.auth.updateCookies?.(sc);
                } catch (err) {
                  cookieFailure.thrown = err;
                }
              },
            });
          } catch (e) {
            // A tripped breaker must never be masked by the abort mapping.
            if (e instanceof AbapError) throw e;
            // A real failure outranks a coinciding abort.
            if ("thrown" in cookieFailure) {
              throw translateDebugError(adtErrorFromException(cookieFailure.thrown, path));
            }
            if (signal.aborted || isAbortError(e)) throw cancelled();
            // Same idiom as DebugTransport.request(): unstructured errors become
            // an AbapError so `result` never rejects with a bare Error.
            throw translateDebugError(adtErrorFromException(e, path));
          }
          // Checked before the abort re-check so abort can't swallow it.
          if ("thrown" in cookieFailure) {
            throw translateDebugError(adtErrorFromException(cookieFailure.thrown, path));
          }
          // The signal can fire *during* the await; re-check rather than assume.
          if (signal.aborted) throw cancelled();
          continue;
        }

        if (raw.status >= 400) {
          // The long-poll used to have its own narrow regex error extractor;
          // use the real parser (parseAdtError) instead.
          throw translateDebugError(parseAdtError(raw.body, raw.status, path));
        }

        return raw;
      }
    } finally {
      // Release the in-flight guard on every exit path; a boolean assignment
      // can't throw, so it can't block the resolveArmed() backstop below.
      this.inFlight = false;
      if (!armedSignalled) {
        armedSignalled = true;
        resolveArmed(); // failed before dispatch — `armed` still settles
      }
      // Resolve the half-open probe slot on every exit path. `inspect()`
      // resolves it for 2xx/3xx/5xx/408/429; a plain 4xx, abort, or network
      // error would otherwise leave `probeInFlight` set and wedge the breaker
      // half-open forever. After resolveArmed() and defensively wrapped: armed
      // must settle even if the breaker misbehaves.
      try {
        if (isProbe && this.breaker.status().probeInFlight) {
          if (sawResponse) this.breaker.recordSuccess();
          else this.breaker.recordTransientFailure({ url, message: "long-poll produced no response" });
        }
      } catch {
        /* a breaker bookkeeping failure must never replace the real outcome */
      }
      // Release the injected session hold on every exit path — a poll that kept
      // its hold would wedge the session for the caller's whole TTL. Last and
      // defensively wrapped: `release` is caller-supplied and must not replace
      // the real outcome, strand `armed`, or leave `inFlight` set.
      try {
        if (typeof lease?.release === "function") lease.release();
      } catch {
        /* a lease-release failure must never replace the real outcome */
      }
    }
  }
}

/**
 * The one CSRF-retry condition this module allows: 403 plus the header SAP
 * uses to say "your token is stale," `x-csrf-token: Required` — a structural
 * signal, not a guess from response prose. A bare 403 without it is not
 * retried; it reaches translateDebugError as AUTH_FAILED.
 */
export function isStaleCsrfChallenge(resp: { status: number; headers?: Record<string, string> }): boolean {
  return resp.status === 403 && headerValue(resp.headers, "x-csrf-token").toLowerCase() === "required";
}
