/**
 * Connection layer.
 *
 * Owns the ADT client, the circuit breaker, the CSRF token, the cookie jar, the
 * session model and the shutdown hook. Everything above this file assumes a
 * connected, non-productive, read-only system or a structured error.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { ADTClient } from "abap-adt-api";
import { session_types } from "abap-adt-api";
import type { HttpClient } from "abap-adt-api";
import { isCsrfError } from "abap-adt-api";
import type { Config } from "../config.js";
import { stripUrlCredentials } from "../config.js";
// fingerprintCredentials/lookupTrippedFingerprint moved to AuthCircuitBreaker.forConfig (D1 replay) — this file no longer mints breakers.
import type { AuthCircuitBreaker } from "./circuit-breaker.js";
import { GuardedHttpClient, circuitOpenError } from "./http-guard.js";
import { AbapError, describeUnknownError } from "./errors.js";
import { classifyConnectFailure, credentialsRejectedVerdict } from "./connect-failure.js";
import { Discovery, type DiscoveryState } from "./discovery.js";
import {
  discoveryCacheKey,
  getSharedDiscoveryInventory,
  setSharedDiscoveryInventory,
} from "./discovery-cache.js";
import { StatefulSession, classifySessionFailure } from "./session.js";
import { SessionLock } from "./session-lock.js";
import { registerShutdownHandler, type ShutdownSignal } from "../shutdown-hook.js";
// System-role detection lives in system-role.ts; classifyT000Response/SystemRoleDetection/ProductiveRole are re-exported below for existing import sites.
import { detectSystemRole, type SystemRoleProbes } from "./system-role.js";
import type { SystemRoleDetection } from "./system-role.js";
import {
  DATA_PREVIEW_ACCEPT,
  isAbapTrue,
  normaliseClient,
  logonClientFromCookies,
} from "./wire-values.js";

export { classifyT000Response } from "./system-role.js";
export type { ProductiveRole, SystemRoleDetection } from "./system-role.js";

export type SystemRole = "development" | "test" | "productive" | "unknown";

export interface ConnectionInfo {
  url: string;
  sid: string;
  user: string;
  client: string;
  systemRole: SystemRole;
  /** Full tri-state detection incl. the evidence behind `systemRole`. */
  roleDetection: SystemRoleDetection;
  /** True when writes are refused for a reason the operator cannot override (productive, or not provably non-productive). */
  writesLockedOut: boolean;
  readOnly: boolean;
  readOnlyReason: string;
  connected: boolean;
  circuitOpen: boolean;
  discoveryCollections: number;
  /** A zero count alone is not an answer — check this: `"failed"` (probe threw) and `"empty"` (no collections) both report 0. */
  discoveryState: DiscoveryState;
  /** Error text when `discoveryState === "failed"`, else `undefined`. */
  discoveryError: string | undefined;
  /** Which ABAP session incarnation this is — `+1` per `connect()` attempt, not per session. */
  generation: number;
  /**
   * Death reports discarded as belonging to a superseded generation.
   * `staleDeathReports` is routinely non-zero under concurrency; `staleDeathAnomalies` (deaths
   * dropped for a generation none was ever recorded for) is the one to alert on — expected 0.
   */
  staleDeathReports: number;
  staleDeathAnomalies: number;
  /** Requests dispatched while another was in flight on this connection. Expected 0 outside teardown. */
  overlappingDispatches: number;
}

/** Legacy-union view of a detection, for `safety.ts` / `server.ts`. */
export function toLegacySystemRole(d: SystemRoleDetection): SystemRole {
  switch (d.role) {
    case "productive":
      return "productive";
    case "nonproductive":
      return "development";
    default:
      return "unknown";
  }
}

/** The request PATH (no query string) — a session-lock holder's public label. Stripped because a query string here can carry a live `lockHandle=…`. */
const opOf = (url: string): string => url.split("?")[0] ?? url;

export interface ConnectionOptions {
  /** Injected for tests — replaces the real axios transport. */
  httpClient?: HttpClient;
  /**
   * Required: the process-wide auth circuit breaker. One SAP user means one
   * `login/fails_to_user_lock` counter, so every connection must share ONE
   * breaker instance — mint it once with {@link AuthCircuitBreaker.forConfig}.
   * No default: an optional param here previously let a caller silently mint
   * a private breaker that drew down a counter another connection already spent.
   */
  breaker: AuthCircuitBreaker;
  log?: (msg: string) => void;
  /** Injected for tests — replaces `process.exit`. */
  exit?: (code: number) => void;
  /** Max time (ms) to wait for graceful shutdown before forcing exit. Default 5000. */
  shutdownDeadlineMs?: number;
  /** Injected for tests — the clock behind {@link AbapConnection.lastWireActivityMs} / {@link DeathRecord.atMs}. */
  now?: () => number;
  /**
   * Injected for tests — this connection's session mutex; production builds one sized from `cfg`.
   * ⚠️ Never share one instance between two `AbapConnection`s — that would serialise two SAP sessions against each other.
   */
  sessionLock?: SessionLock;
}

/**
 * What `markDead()` recorded, and when.
 *
 * `heldLockUris` is a snapshot for REPORTING only, not a to-do list of unlocks:
 * measured live, a dead session's enqueues are already gone server-side (see
 * the git history). Do not try to release them.
 */
export interface DeathRecord {
  /** Why this connection was declared dead. First reason wins — `markDead` is idempotent. */
  readonly reason: string;
  /** Epoch ms at which death was recorded. */
  readonly atMs: number;
  /** Object URIs this connection held enqueues for at the moment of death. Reporting only. */
  readonly heldLockUris: readonly string[];
}

/** Options for the raw `get`/`post`/`put`/`del` helpers. */
export interface RawRequestOptions {
  headers?: Record<string, string>;
  qs?: Record<string, string>;
}

export interface RawResponse {
  body: string;
  status: number;
  headers: Record<string, unknown>;
}

/** ADT DDIC data preview — table named by query param, not Open-SQL, so there's nowhere to smuggle a WHERE/JOIN. Only this path (not `freestyle`) is tool-reachable. */
const DATA_PREVIEW_DDIC = "/sap/bc/adt/datapreview/ddic";
/**
 * ⚠️ Live-proven: `ddicEntityName` is concatenated into SQL server-side — see
 * the git history. Real validation lives in
 * `datapreview.ts`; this is a choke-point backstop duplicated on purpose.
 */
const DDIC_ENTITY_CHARS = /^[A-Z0-9_/]{1,61}$/;
/**
 * The ONLY URL shape `serviceRuntimeGet()` puts on the wire (OData `$metadata` under
 * `/sap/opu/odata[4]`). Whitelist of one shape, not a blacklist — the P-40 boundary
 * ("contracts, never rows", see `edmx.ts`): no entity-set read, `$batch`, `$filter`
 * or function-import call can be spelled as a path ending in `$metadata`. Duplicated
 * intentionally alongside `odata.ts`'s own check — the choke point trusts no caller.
 */
const SERVICE_METADATA_PATH = /^\/sap\/opu\/odata4?\/[A-Za-z0-9_\-/]{1,240}\/\$metadata$/;
/** Defined in wire-values.ts (imports nothing, needed by system-role.ts too) and re-exported here so existing import sites resolve unchanged. */
export {
  DATA_PREVIEW_ACCEPT,
  isAbapTrue,
  normaliseClient,
  logonClientFromCookies,
} from "./wire-values.js";

/** `AdtHTTP`'s "no CSRF token" sentinel. Not free to assign: `loggedin` is `csrfToken !== "fetch"`, so it forces a full re-`login()` (session-discarding) unless routed as `refreshCsrfToken()` does. */
const CSRF_FETCH = "fetch";

/**
 * The URL `AdtHTTP.login()` puts on the wire. Named for the endpoint rather than
 * "logons" deliberately: `dropSession()` and the library's keepalive hit it too,
 * so the counter over-counts rather than under-counts — the bug it exists to
 * catch is a logon nobody asked for, and over-counting cannot hide one.
 */
const LOGON_ENDPOINT = "/sap/bc/adt/compatibility/graph";

/**
 * D5(b) — connection-lifetime ceiling on logon-endpoint requests reached OUTSIDE
 * a budgeted `request()` call (`requestContext` has no store): `connect()`'s
 * `client.login()`, `dropSession()`'s re-logon, and direct `conn.adt.*` calls
 * were previously unbounded here. A local pre-wire refusal, mirroring
 * `RequestBudget.exceeded()`. 5 is generous headroom for legitimate
 * dropSession()/keepalive calls over one connection's life, not a trap.
 */
const LOGON_ENDPOINT_LIFETIME_CEILING = 5;

/**
 * Where a stale CSRF token is re-fetched. `X-CSRF-Token: Fetch` on a GET
 * answering with a fresh token is captured only for
 * `/sap/bc/adt/debugger/breakpoints/messagetypes`, not for this endpoint — see
 * the git history. `refreshCsrfToken()` throws loudly
 * if that inference is wrong rather than resending the caller's body without a token.
 */
const CSRF_REFRESH_ENDPOINT = "/sap/bc/adt/discovery";

/**
 * How long `shutdown()` waits for the graceful path before forcing `exit`.
 * Overridable per connection via `ConnectionOptions.shutdownDeadlineMs`.
 */
const DEFAULT_SHUTDOWN_DEADLINE_MS = 5000;

/**
 * Opt-in phase timing for `connect()` (logon → discovery → role probe), behind
 * `ABAP_TIMING_DEBUG` — lets the oft-repeated "reconnection is expensive" claim
 * be checked per-phase instead of asserted. Read from `process.env` at point of
 * use (not module load) so a test/probe script can set it after importing.
 */
function timingDebugEnabled(): boolean {
  const v = process.env.ABAP_TIMING_DEBUG;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** `AdtHTTP._request` — "HTTP request without automated login / retry". */
interface NoRetryTransport {
  _request(url: string, options: Record<string, unknown>): Promise<RawResponse>;
}

/**
 * The spend budget of ONE logical request: at most one logon, at most one
 * resend. Previously this bound was only prose ("exactly ONE logon attempt")
 * while two independent retry layers each honoured it locally and their
 * composition cost three logons for one 403 — an enforced object beats an
 * unchecked promise. Scoped per logical request (constructed in `request()`,
 * dropped when it returns); spent at the wire via `GuardedHttpClient`'s
 * `onRequest` hook so any layer's logon is counted; refuses before dispatch
 * rather than merely reporting after.
 */
export class RequestBudget {
  private logons = 0;
  private resends = 0;

  constructor(private readonly url: string) {}

  /** One logon per logical request. The second one throws instead of flying. */
  spendLogon(): void {
    if (++this.logons > 1) throw this.exceeded("logon attempt", this.logons);
  }

  /** One resend per logical request: a CSRF 403 means the body was never applied, so one resend is recovery — a second is a retry against a system already saying no. */
  spendResend(): void {
    if (++this.resends > 1) throw this.exceeded("resend", this.resends);
  }

  private exceeded(what: string, n: number): AbapError {
    return new AbapError(
      "ADT_ERROR",
      `Refused a ${n}. ${what} for a single request to ${this.url}: one logical ` +
        `request may cost at most one logon and one resend.`,
      { operation: "request", url: this.url, reason: "request-budget-exceeded", limit: 1, attempted: n },
      "This is an abapsmith bug, not a SAP one: some layer retried on top of a " +
        "retry. The request was refused locally rather than spending another " +
        "logon against the 5-attempt user lock.",
    );
  }
}

/**
 * F1 — the identity of ONE session incarnation, carried alongside a single
 * in-flight transport request. A request is stamped with the generation it
 * actually rode; a death report from an older generation is a corpse's late
 * answer and must not kill the current session. Mutable: created before
 * dispatch with a sane pre-dispatch value, overwritten at the true dispatch
 * instant (after the guard's mutex wait, during which a reconnect may have
 * advanced the counter).
 */
interface DispatchTicket {
  generation: number;
  /** Set by `noteWireRequest()` at the dispatch instant, so in-flight accounting only decrements what it incremented — a pre-dispatch refusal never opens the window. */
  dispatched: boolean;
}

/**
 * The typed refusal `assertUsable()` raises once the connection is dead.
 * `SESSION_DEAD` (not `NOT_CONNECTED`) matches existing codebase convention
 * (`sessionDeadError` in `session.ts`) and callers already branch on it; it
 * costs nothing against the SAP logon-attempt budget.
 *
 * Also stamps `details.condemned: true`. This error is synthesized
 * from `this.death`, written by an EARLIER response; it proves the CONNECTION
 * was condemned but nothing about whether THIS call's own operation was ever
 * applied (it may be a cleanup path running after the caller's own request
 * already succeeded). Contrast `sessionDeadError` in `session.ts`, which is
 * raised because THIS request's own response said the session was gone — both
 * share the `SESSION_DEAD` code, but only `sessionDeadError` answers "was this
 * applied?". `pool.ts`'s `isCondemnedConnectionError` reads the `condemned`
 * marker and refuses to replay a WRITE that failed this way, to avoid doubling
 * a mutation that may already have landed.
 */
export function connectionDeadError(death: DeathRecord): AbapError {
  return new AbapError(
    "SESSION_DEAD",
    `This ABAP connection was marked dead at ${new Date(death.atMs).toISOString()}: ${death.reason}`,
    {
      operation: "request",
      reason: death.reason,
      deadSinceMs: death.atMs,
      condemned: true,
      ...(death.heldLockUris.length ? { heldLocks: [...death.heldLockUris] } : {}),
    },
    "Every lock the session held was released when it died — there is nothing to " +
      "clean up on the ABAP side. Call connect() again to establish a new session; " +
      "this is not an authentication failure and does not count against the " +
      "logon-attempt budget.",
  );
}

export class AbapConnection {
  readonly cfg: Config;
  /** NOT reset when a dead connection is revived — the auth latch is one-way and permanent for the process, and a session death never trips it. */
  readonly breaker: AuthCircuitBreaker;
  readonly discovery: Discovery;

  private readonly guard: GuardedHttpClient;
  private readonly client: ADTClient;
  private readonly log: (msg: string) => void;
  /**
   * THE session mutex for THIS connection's ADT session — one request in flight
   * at a time, plus exclusive windows around multi-request flows that mutate
   * session state. Needed because (1) `ADTClient.stateful` is one mutable field
   * sampled per-dispatch, so an unrelated request racing a `withStatefulSession()`
   * window can silently ride out `stateful` or lose its lock binding, and (2)
   * `dropSession()` discards the `sap-contextid` from under any concurrent
   * in-flight request (observed as `400 ICMENOSESSION`, enqueue released).
   * No CSRF-interleaving claim is made — that has not been captured. Per
   * connection, never global — see {@link ConnectionOptions.sessionLock}.
   */
  private readonly lock: SessionLock;

  private connected = false;
  private role: SystemRole = "unknown";
  private detection: SystemRoleDetection = {
    role: "inconclusive",
    client: null,
    ccCategory: null,
    reason: "Not connected yet — nothing has been probed.",
  };
  /**
   * Only ever holds a definitive (productive/nonproductive) answer. NOT reset on
   * revival — it is a property of the SYSTEM, not the session, and clearing it
   * would fail-closed lock writes out of a fine system after an unrelated death.
   */
  private cachedDetection: SystemRoleDetection | undefined;
  /** Writes refused for a reason the operator cannot override. */
  private writesLocked = false;
  /** Error text from the last discovery probe, or `undefined` if it succeeded — kept so a soft degradation is reported by `info()` rather than invisible. */
  private discoveryLoadError: string | undefined;
  /** Set by `applyReadOnlyPolicy()` from (config × detected role) on connect — not a constant. Before connect, `readOnly` is carried entirely by `cfg.readOnly` (default true). */
  private forcedReadOnly = false;
  private forcedReadOnlyReason =
    "Not connected yet — the system role is unknown until connect() has run.";
  private shuttingDown = false;
  private exited = false;
  /** Count of shutdown tasks that threw — `shutdown()` catches and continues, so this is the only channel those failures reach the exit code through. */
  private shutdownFailures = 0;
  private forceExitTimer: NodeJS.Timeout | undefined;
  private readonly exit: (code: number) => void;
  private readonly shutdownDeadlineMs: number;
  /**
   * Registered once with the shared hook (`installShutdownHooks()`). Must stay
   * reachable on EVERY signal including a second SIGINT mid-shutdown — that's
   * `handleSignal`'s own double-Ctrl-C force-exit escape hatch.
   */
  private readonly onSharedShutdownSignal = (signal: ShutdownSignal): void => {
    if (signal === "beforeExit") {
      void this.shutdown("beforeExit");
      return;
    }
    this.handleSignal(signal);
  };
  private unregisterShutdownHook: (() => void) | undefined;
  /** NOT reset on revival: a stale task just costs one swallowed failed request; clearing the list would leak whatever enqueue it was meant to release. */
  private shutdownTasks: Array<() => Promise<void> | void> = [];
  /**
   * The single in-flight stateful session, if any — never more than one. NOT
   * reset on revival; owned by the `withStatefulSession()` frame that opened it.
   * Blanking it here would let a second session open mid-unwind and would erase
   * `heldLockUris()`'s only source of truth about lost enqueues.
   */
  private activeSession: StatefulSession | undefined;
  /**
   * The most recent lock-leak escalation, surviving past
   * `withStatefulSession()`'s outer `finally`, which clears `activeSession`
   * (and thus `session.leakedLocks`) before any caller outside that frame can
   * read it. Visibility only — not consulted by any control-flow decision.
   * Overwritten on each new leak, not accumulated.
   */
  private lastLockLeak: AbapError | undefined;
  /** F1b — the generation a single in-flight transport request is riding. Per-instance, NOT module-scope: a pooled `runOn` callback can nest connection B's dispatch inside connection A's frame. */
  private readonly dispatchContext = new AsyncLocalStorage<DispatchTicket>();
  /**
   * The budget of the logical request currently in flight, if any — set by
   * `request()`, visible to `login()`/`refreshCsrfToken()` inside `attempt()`.
   * Async-scoped rather than a field: `request()` is not serialised, so a plain
   * field let two concurrent requests spend from each other's budget (F1b).
   * Per-instance, NOT module-scope — same reasoning as `dispatchContext`.
   */
  private readonly requestContext = new AsyncLocalStorage<{ budget: RequestBudget }>();
  /**
   * Lifetime count of requests to {@link LOGON_ENDPOINT} that reached the
   * transport, counted in `noteWireRequest()` below every retry layer. Only
   * requests that proceed are charged — a refusal (ceiling or
   * `RequestBudget.spendLogon()`) never reaches the endpoint and must not
   * inflate this count; its ordinal is reported separately as `details.attempted`.
   * LIFETIME, not reset on revival: it IS the bound on how often a connection
   * can be revived ({@link LOGON_ENDPOINT_LIFETIME_CEILING}).
   */
  private logonEndpointRequestCount = 0;
  /**
   * Latched the first time {@link LOGON_ENDPOINT_LIFETIME_CEILING} refuses a
   * request. Never cleared — the ceiling only grows, so once tripped it stays
   * tripped. Exists because since a refused attempt is uncharged, "count ===
   * ceiling" is ambiguous between "5th logon flew, SAP rejected it" and "6th was
   * refused locally" (D5c); `connectUnderLock()`'s catch reads this flag instead.
   */
  private logonCeilingRefused = false;

  /** The clock. Injected only by tests; `Date.now` everywhere else. */
  private readonly now: () => number;
  /**
   * Set by `markDead()`, cleared ONLY by `connectUnderLock()` once a replacement
   * session provably exists — a revival ATTEMPT never clears it. `undefined`
   * means alive. The record is `isDead`/reason/timestamp in one object so the
   * three can never disagree.
   */
  private death: DeathRecord | undefined;
  /**
   * The generation `death` belongs to; meaningless while `death` is `undefined`.
   * Lets the record survive a revival attempt without blocking the attempt's own
   * death from being recorded: a current-generation report overwrites an older
   * leftover, while same-generation reports stay idempotent (first reason wins).
   * A sibling field rather than part of `DeathRecord` because that type is
   * public and asserted structurally by tests.
   */
  private deathGeneration = 0;
  /**
   * A death classified on a response that RESOLVED with a 2xx: the call
   * it rode in on already committed server-side, so the death is information
   * about the NEXT call, not a verdict on this one. Recorded here instead of
   * applied immediately; `applyDeferredDeath()` promotes it at the next request
   * boundary.
   */
  private deferredDeath: { reason: string; generation: number } | undefined;
  /**
   * F1b — which incarnation of the ABAP session this connection is on. Advanced
   * in exactly one place: the top of `connectUnderLock()`, after the
   * already-connected early return and before `login()`. Starts at 0 so a
   * connection that never calls `connect()` (auto-logon via `attempt()`) still
   * has its deaths honoured (`0 < 0` is false). Named apart from the
   * `generation` getter because TS forbids a getter/field name clash.
   *
   * Counts connect ATTEMPTS, not session incarnations — `dropSession()`,
   * `withFreshSession()` and `attempt()`'s auto-logon mint/destroy real sessions
   * without touching this counter, and a refused `connect()` advances it having
   * minted nothing. This is sound anyway, because the only question it answers
   * is "does this response belong to the session live NOW", which can only be
   * got wrong if a session is destroyed/minted *while a request is in flight* —
   * and every dispatch, `dropSession()`/`withFreshSession()`, and auto-logon all
   * run under the same exclusive `SessionLock` hold, so that never happens.
   * Live-tested: 8 concurrent `conn.get()` calls on a never-connected connection
   * against A4H all took the `freshLogon` branch for one memoised
   * `AdtHTTP.login()`; `logonEndpointRequests === 1`, not 8 (see
   * the git history for the full trace, including the
   * `overlappingDispatches` counter that makes the exclusivity measured, not
   * merely asserted).
   */
  private currentGeneration = 0;
  /**
   * Death reports dropped as belonging to a previous generation, split by what
   * the drop means — the split is the point: a signal that fires on healthy
   * traffic is not a signal. `staleDeathDuplicateCount` names a generation
   * already recorded dead (benign, expected, not logged).
   * `staleDeathAnomalyCount` names a generation for which no death was ever
   * recorded — the only shape a genuine death can be swallowed in, so it is the
   * one that gets a log line. Under the `currentGeneration` invariant the
   * anomalous count is structurally unreachable through this class's public
   * API, which is what makes a non-zero value worth alerting on. Both surfaced
   * via `info()` (the `abap://<SID>/system` MCP resource).
   */
  private staleDeathDuplicateCount = 0;
  private staleDeathAnomalyCount = 0;
  /**
   * Highest generation this connection ever recorded a death for, or `-1`.
   * NOT cleared by revival — `death` is a statement about now, this is a
   * historical fact still needed to tell a duplicate drop from an anomalous one
   * after the record itself is gone.
   */
  private lastRecordedDeathGeneration = -1;
  /**
   * D — dispatches between their stamping instant and observed outcome, plus
   * how many times that count exceeded one. The generation stamp is only sound
   * because one connection dispatches one request at a time (see
   * `currentGeneration`); this measures that instead of assuming it. Does not
   * throw on overlap (reachable during teardown; throwing from the transport
   * mid-shutdown would turn a diagnostic into an outage) — counted and reported
   * via `info()` as `overlappingDispatches`.
   */
  private dispatchesInFlight = 0;
  private overlappingDispatchCount = 0;
  /**
   * Epoch ms of the most recent COMPLETED response through the guard — the last
   * moment SAP is known to have answered. 0 until the first response; stamped
   * only on an actual response (a local refusal or bare network error proves
   * nothing about the remote). Exists so nothing ever needs to probe: live
   * testing measured a synthetic request on a session with an outstanding
   * long-poll waiting out the poll's entire remaining timeout, so a health ping
   * would stall rather than check — never add one. NOT reset on revival (a fact
   * about the wire); gated on responding generation so a corpse's late answer
   * cannot fake liveness for the new session.
   */
  private lastWireActivityAtMs = 0;
  /** Subscribers to `onDead()`. NOT reset on revival — subscriptions belong to the subscriber (the pool registers one per connection lifetime), not to a session incarnation. */
  private deathListeners: Array<(record: DeathRecord) => void> = [];

  /**
   * The `HttpClient` handed to `ADTClient` — `this.guard`, plus one observation
   * point that sees BOTH outcomes of every request. Not `GuardOptions.onResponse`:
   * that only fires when `inner.request()` resolves, but the real transport
   * throws `HttpClientException` (response on `.response`) for every status
   * >= 400, and session death (`400 ICMENOSESSION` or a `500` dump page) arrives
   * exclusively on the throw path in production — an `onResponse`-only wiring
   * would pass tests and never fire against a real appliance. Adds no request,
   * header or retry: one `this.guard.request(o)`, rethrown unchanged. Field
   * initializer arrow so `this.guard` is read at call time, after the
   * constructor has assigned it.
   */
  private readonly observedTransport: HttpClient = {
    request: async (o) => {
      // A death deferred off a prior 2xx belongs to THIS request, the
      // next one dispatched since it was learned. Promote before minting a
      // ticket for it.
      if (this.deferredDeath) {
        this.applyDeferredDeath();
        if (this.death) throw connectionDeadError(this.death);
      }
      // F1b. Initialised to the CURRENT generation for a sane pre-dispatch value;
      // noteWireRequest() overwrites it at the true dispatch instant. Read from
      // this closure, never getStore(), so a nested dispatch from another
      // connection can never be mistaken for this one's.
      const ticket: DispatchTicket = { generation: this.currentGeneration, dispatched: false };
      try {
        const response = await this.dispatchContext.run(ticket, () => this.guard.request(o));
        this.noteWireResponse(response, ticket.generation, "resolved");
        return response;
      } catch (e) {
        this.noteWireThrow(e, ticket.generation);
        throw e;
      } finally {
        // Closes the in-flight window from noteWireRequest(); in `finally` because a refusal thrown BY that hook still has to balance the count.
        if (ticket.dispatched) this.dispatchesInFlight--;
      }
    },
  };

  /**
   * `opts` (and `opts.breaker` within it) is REQUIRED. This used to default
   * `opts.breaker` to a freshly-built private breaker when a caller forgot the
   * key — but the appliance counts failed logons per USER, so N private
   * breakers do not each get five attempts, they share five. A caller now has
   * to ask for {@link AuthCircuitBreaker.forConfig} explicitly.
   */
  constructor(cfg: Config, opts: ConnectionOptions) {
    this.cfg = cfg;
    this.log = opts.log ?? ((m) => process.stderr.write(m + "\n"));
    this.breaker = opts.breaker;
    this.breaker.onTrip((info) => {
      this.log(
        `[abapsmith] CIRCUIT BREAKER TRIPPED (${info.reason}): ${info.message} ` +
          "No further requests until an explicit re-arm admits one (see the AUTH_CIRCUIT_OPEN hint).",
      );
    });
    this.exit = opts.exit ?? ((code) => process.exit(code));
    this.shutdownDeadlineMs = opts.shutdownDeadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS;
    this.now = opts.now ?? (() => Date.now());

    // Built BEFORE the guard, whose `acquire` closes over `this.lock` — keeps
    // init order safe by construction. `waitTimeoutMs` is derived, not chosen:
    // SessionLock's own 10s default is smaller than a request's own timeout, so
    // a caller queued behind one healthy request could be refused SESSION_BUSY
    // before that request could finish. Live-measured work-process starvation
    // alone queued 14,075ms — see the git history.
    this.lock =
      opts.sessionLock ??
      new SessionLock({
        waitTimeoutMs: cfg.sessionWaitMs + cfg.timeoutMs,
        log: this.log,
      });

    this.guard = new GuardedHttpClient(
      {
        baseURL: cfg.url,
        insecure: cfg.insecure,
        timeout: cfg.timeoutMs,
        sendClientParam: cfg.sendClientParam,
        // Sits below AdtHTTP, so it observes logons this file never issued itself.
        onRequest: (o) => this.noteWireRequest(o.url),
        // LEVEL A — one dispatch at a time on this ADT session; every outbound
        // request funnels through here, including ones abap-adt-api issues
        // itself. Re-entrant by construction (session-lock I3): a request from
        // inside a `runExclusive` window finds this lock's live token and passes
        // straight through — otherwise LEVEL B below would self-deadlock.
        acquire: (url: string) => this.lock.acquireImplicit(opOf(url)),
        // LEVEL A cont'd. Holding the mutex defers dispatch but not the stamp:
        // AdtHTTP writes X-sap-adt-sessiontype from `this.stateful` before this
        // guard runs, so reading the flag here (once the session is provably
        // ours) is the only reading that isn't a guess. Optional-chained because
        // `this.client` is assigned after this literal is evaluated but before
        // first use; chained on a getter so it's never a stale snapshot.
        sessionType: () => this.client?.stateful as string | undefined,
        // Read at dispatch time (INV-3), never snapshotted here: the
        // config-layer guarantee (exactly one of password/sessionCookie) means
        // this is `undefined` whenever `cfg.password` is set.
        injectedCookies: () => cfg.sessionCookie,
        ...(opts.httpClient ? { inner: opts.httpClient } : {}),
      },
      this.breaker,
    );

    // `client` arg is empty unless opted in: login() would otherwise append
    // `?sap-client=NNN`, which on A4H produces an ICF logon-failure page.
    this.client = new ADTClient(
      this.observedTransport,
      cfg.user,
      // `cfg.password ?? ""` — safe only because we pass an object (not a URL
      // string) as arg 1: AdtHTTP's/ADTClient's own guards are
      // `(password || !isString(baseURLOrClient))`, and `!isString(object)` is
      // already true, so an empty password satisfies them. Cookie mode
      // (`cfg.sessionCookie`) supplies the real credential at the guard seam
      // (`http-guard.ts`'s `injectedCookies`) instead.
      cfg.password ?? "",
      cfg.sendClientParam ? cfg.client : "",
      cfg.language,
      { timeout: cfg.timeoutMs },
    );
    // Stateless for every read. Stateful sessions are a separate concern.
    this.client.stateful = session_types.stateless;

    this.discovery = new Discovery(this.client);
  }

  /** Raw ADT client. Always stateless; stateful work goes through the pool. */
  get adt(): ADTClient {
    this.assertUsable();
    return this.client;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get systemRole(): SystemRole {
    return this.role;
  }

  /** The tri-state decision plus the evidence behind it. */
  get roleDetection(): SystemRoleDetection {
    return this.detection;
  }

  /** True when writes are locked out and `ABAP_ALLOW_WRITE` cannot help: productive, or not provably non-productive. */
  get writesLockedOut(): boolean {
    return this.writesLocked;
  }

  /** `"failed"`/`"empty"`/`"never"` all mean feature questions answer `"unknown"`, never `"unsupported"`. */
  get discoveryState(): DiscoveryState {
    return this.discovery.loadState;
  }

  get readOnly(): boolean {
    return this.cfg.readOnly || this.forcedReadOnly;
  }

  get readOnlyReason(): string {
    return this.forcedReadOnlyReason;
  }

  /** Current cookie jar as a header string — includes `saplb_*`. */
  cookies(): string {
    return this.client.httpClient.ascookies();
  }

  /** Cached CSRF token. "fetch" until the first response supplies one. */
  csrfToken(): string {
    return this.client.httpClient.csrfToken;
  }

  /** Requests actually put on the wire — used by tests and the probe budget. */
  get requestCount(): number {
    return this.guard.requestCount;
  }

  /** Requests to the logon endpoint that reached the transport, lifetime of this connection. The measurement behind every "how many logons?" claim in this file — see {@link LOGON_ENDPOINT}. Refused attempts are not counted. */
  get logonEndpointRequests(): number {
    return this.logonEndpointRequestCount;
  }

  /** Called by the guard for every request past the breaker, before dispatch: counts logons and refuses a second one inside a single logical request. */
  private noteWireRequest(url: string): void {
    // F1b — THE DISPATCH INSTANT; must stay here. GuardedHttpClient.request()
    // awaits opts.acquire(url) (the session mutex) and only then dispatches,
    // firing this hook on the same tick as inner.request() — so this, not the
    // top of observedTransport, is the moment the bytes leave and the
    // generation they ride. Stamping earlier would let a request parked across
    // a legitimate reconnect carry a stale generation, swallowing its genuine
    // death as "a corpse's late answer" — the catastrophic direction. Do not
    // move this back into the wrapper.
    const ticket = this.dispatchContext.getStore();
    if (ticket) {
      ticket.generation = this.currentGeneration;
      // D — the exclusivity the stamp rests on (see `currentGeneration`),
      // measured instead of assumed. Counted, never thrown: known overlaps
      // happen during teardown.
      if (!ticket.dispatched) {
        ticket.dispatched = true;
        this.dispatchesInFlight++;
        if (this.dispatchesInFlight > 1) {
          this.overlappingDispatchCount++;
          // Once — the counter carries the rest.
          if (this.overlappingDispatchCount === 1) {
            this.log(
              `[abapsmith] ${this.dispatchesInFlight} requests are in flight on ONE connection — ` +
                "the session-generation stamp assumes one at a time (see AbapConnection." +
                "currentGeneration). Reported as `overlappingDispatches`.",
            );
          }
        }
      }
    }
    if (!url.includes(LOGON_ENDPOINT)) return;
    const budget = this.requestContext.getStore()?.budget;
    if (budget) {
      budget.spendLogon();
      this.logonEndpointRequestCount++;
      return;
    }
    // D5(b): no active budget to enforce the one-logon rule locally — bound the
    // unbudgeted path instead. See {@link LOGON_ENDPOINT_LIFETIME_CEILING}. The
    // check runs BEFORE the charge: a refused attempt never reaches the
    // endpoint, so charging it would bill traffic that never happened. `>=`
    // rather than `>` keeps the boundary where it was: five may fly, the sixth is refused.
    if (this.logonEndpointRequestCount >= LOGON_ENDPOINT_LIFETIME_CEILING) {
      // Local state the library cannot rewrite — `connectUnderLock()`'s catch needs this after `fromException` destroys the error.
      this.logonCeilingRefused = true;
      throw new AbapError(
        "ADT_ERROR",
        `Refused logon-endpoint request #${this.logonEndpointRequestCount + 1} to ` +
          `${LOGON_ENDPOINT}: this connection may reach the logon endpoint at most ` +
          `${LOGON_ENDPOINT_LIFETIME_CEILING} times outside a budgeted request().`,
        {
          operation: "request",
          url: LOGON_ENDPOINT,
          reason: "logon-ceiling-exceeded",
          limit: LOGON_ENDPOINT_LIFETIME_CEILING,
          // Ordinal of the refused attempt (6th), not the charged count — this one is not charged.
          attempted: this.logonEndpointRequestCount + 1,
        },
        "This is an abapsmith bug, not a SAP one: some path outside the budgeted " +
          "request() wrapper kept logging on. The request was refused locally rather " +
          "than spending another attempt against the 5-attempt user lock.",
      );
    }
    // Charged only now: the request is handed to the transport on the same tick, so this counts requests that flew, not ones merely asked for.
    this.logonEndpointRequestCount++;
  }

  // ------------------------------------------------------------ liveness ---
  // T3. Everything below is inferred from traffic that was going to happen
  // anyway — nothing here issues a request, schedules a timer or arms a
  // heartbeat, and it must stay that way (see `lastWireActivityAtMs`).

  /**
   * Declare this connection's ABAP session gone. Idempotent — first reason
   * wins, since a later caller only knows the consequences, not the cause.
   * Records reason/timestamp/held-lock snapshot for `assertUsable()`, and sets
   * `connected = false` (leaving it true is what made an expired session
   * permanent for the process — see `onDead()` for the other half of that fix).
   * Never issues a request, and does not try to release the locks it just
   * snapshotted: by the time SAP says the session is gone, its enqueues are too.
   */
  markDead(reason: string, generation: number = this.currentGeneration): void {
    // Live-tested (poisoned-cookie corpse injection, real ICMENOSESSION deaths at
    // generation boundaries) against A4H — see the git history.
    // A death belongs to the incarnation whose request produced it. Strictly
    // OLDER is dropped; equal and (unreachable) newer are honoured, so every
    // ambiguity resolves toward RECORDING a death. This guard runs FIRST so a
    // stale report is dropped/counted without ever reaching `connected = false`
    // below — a corpse's late 400 after a successful revival must not
    // disconnect a healthy session. The log line (anomalous drops only) is the
    // only audit trail for the one catastrophic failure mode here — a real
    // death swallowed as stale — do not remove it.
    if (generation < this.currentGeneration) {
      // A report about an already-recorded generation is a duplicate, not a
      // swallowed death. Keyed on `lastRecordedDeathGeneration` rather than
      // `this.death` because a successful revival clears the record while this
      // question must stay answerable.
      if (generation <= this.lastRecordedDeathGeneration) {
        this.staleDeathDuplicateCount++;
        return;
      }
      // Nothing else in this design will ever mention this death again.
      this.staleDeathAnomalyCount++;
      this.log(
        `[abapsmith] ANOMALY: ignored a session-death report from generation ${generation} ` +
          `(current ${this.currentGeneration}) for which no death was ever recorded — this is ` +
          `the one shape in which a genuine death can be swallowed: ${reason}`,
      );
      return;
    }
    // Idempotency stays SECOND so an equal-generation report still reaches it
    // (first reason wins). A record from an EARLIER incarnation is the corpse a
    // revival is replacing and must not swallow a death from the attempt itself.
    if (this.death && this.deathGeneration >= this.currentGeneration) return;
    const record: DeathRecord = {
      reason,
      atMs: this.now(),
      heldLockUris: this.heldLockUris(),
    };
    this.death = record;
    // The CURRENT generation, not the reporting one: reports are only accepted current-or-newer, so this is what's actually dead.
    this.deathGeneration = this.currentGeneration;
    // Historical, monotonic, never cleared — lets a later stale drop know whether it duplicates an already-accounted-for death.
    if (this.currentGeneration > this.lastRecordedDeathGeneration) {
      this.lastRecordedDeathGeneration = this.currentGeneration;
    }
    this.connected = false;
    // Copied before iterating: a listener is allowed to unsubscribe itself.
    for (const fn of [...this.deathListeners]) {
      try {
        fn(record);
      } catch (e) {
        this.log(`[abapsmith] onDead listener threw (ignored): ${describeUnknownError(e)}`);
      }
    }
  }

  /** True once `markDead()` has run and before the next successful `connect()`. */
  get isDead(): boolean {
    return this.death !== undefined;
  }

  /** What `markDead()` recorded, or `undefined` while alive. */
  get deathRecord(): DeathRecord | undefined {
    return this.death;
  }

  /** Which incarnation of the ABAP session this connection is on. `0` until the first `connectUnderLock()` attempt; +1 per attempt, not per success. */
  get generation(): number {
    return this.currentGeneration;
  }

  /** Death reports dropped as belonging to a previous generation, benign and anomalous alike. Non-zero means the corpse-kills-successor race was caught — not by itself a problem; see {@link staleDeathAnomalies}. */
  get staleDeathReports(): number {
    return this.staleDeathDuplicateCount + this.staleDeathAnomalyCount;
  }

  /** The subset of {@link staleDeathReports} for a generation no death was ever recorded for — the only shape a genuine death can be swallowed in. Expected 0 always. */
  get staleDeathAnomalies(): number {
    return this.staleDeathAnomalyCount;
  }

  /** The benign subset of {@link staleDeathReports}: a duplicate of an already-recorded death. Routinely non-zero under concurrency. */
  get staleDeathDuplicates(): number {
    return this.staleDeathDuplicateCount;
  }

  /** Requests dispatched while another was already in flight on this connection. See `currentGeneration` for why the generation stamp assumes this stays 0. */
  get overlappingDispatches(): number {
    return this.overlappingDispatchCount;
  }

  /**
   * Object URIs this connection currently holds ABAP enqueues for. Reads the
   * one existing ledger (`StatefulSession.locks`) — there is never more than
   * one live session, so this is the whole truth. Empty outside a stateful
   * session, which is also correct (locks are bound to the `sap-contextid`).
   * For REPORTING only — never turn this into unlock or re-lock calls;
   * re-locking in the same session is not idempotent (indistinguishable `403`
   * from a genuine cross-session conflict).
   */
  heldLockUris(): string[] {
    return this.activeSession?.heldLocks.map((l) => l.uri) ?? [];
  }

  /** The most recent lock-leak escalation, surviving past the `withStatefulSession()` frame that recorded it (`heldLockUris()` cannot answer this after the fact). */
  get lastLeakedLock(): AbapError | undefined {
    return this.lastLockLeak;
  }

  /** Epoch ms of the most recent completed request/response through the guard; `0` if none yet. */
  get lastWireActivityMs(): number {
    return this.lastWireActivityAtMs;
  }

  /**
   * Subscribe to `markDead()`. Returns an idempotent unsubscribe function.
   *
   * This is the seam `server.ts`'s `ensureConnected()` needs: it memoizes
   * `connection.connect()` and only clears the cache on a non-latched CONNECT
   * failure, so a session that dies mid-life used to leave a resolved promise
   * cached forever while every request below it threw `SESSION_DEAD`.
   * `markDead()` flips `isConnected` false (this file's half); the memoizing
   * owner subscribes here to drop its cached promise (the other half).
   * Re-connect stays something a caller asks for — nothing here reconnects on
   * its own, so no failure mode here can become a logon loop.
   */
  onDead(fn: (record: DeathRecord) => void): () => void {
    this.deathListeners.push(fn);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const i = this.deathListeners.indexOf(fn);
      if (i >= 0) this.deathListeners.splice(i, 1);
    };
  }

  /** Every response that came back, whichever way. Stamps liveness and runs the session-death classifier — the one and only place a death is learned. */
  private noteWireResponse(
    resp: {
      status: number;
      statusText?: string;
      headers?: unknown;
      body?: unknown;
    },
    generation: number = this.currentGeneration,
    settled: "resolved" | "thrown" = "thrown",
  ): void {
    // SAP answered — the liveness signal, but only for the session that asked. A corpse's late answer is not evidence THIS session is alive.
    if (generation >= this.currentGeneration) this.lastWireActivityAtMs = this.now();
    const kind = classifySessionFailure({
      status: resp.status,
      ...(typeof resp.statusText === "string" ? { statusText: resp.statusText } : {}),
      ...(resp.headers && typeof resp.headers === "object"
        ? { headers: resp.headers as Record<string, unknown> }
        : {}),
      ...(typeof resp.body === "string" ? { body: resp.body } : {}),
    });
    if (!kind) return;
    const reason =
      kind === "dump"
        ? `HTTP ${resp.status}: the ABAP session was destroyed by a short dump.`
        : `HTTP ${resp.status}: the ABAP session no longer exists ` +
            "(400 Session Timed Out / x-sap-icm-err-id: ICMENOSESSION).";
    // A death classified on a response that RESOLVED with a 2xx rode in
    // on a call that already committed server-side; defer it to the next
    // request boundary instead of discarding the committed result. A stale
    // (older-generation) report falls straight through to `markDead()` so the
    // stale-death accounting below stays exactly as it was.
    if (settled === "resolved" && resp.status >= 200 && resp.status < 300 && generation >= this.currentGeneration) {
      this.deferredDeath ??= { reason, generation };
      return;
    }
    this.markDead(reason, generation);
  }

  /** The throw half of `noteWireResponse`. Only an exception carrying a response counts — local refusals and bare network errors prove nothing about the session and must not be treated as death. */
  private noteWireThrow(e: unknown, generation: number = this.currentGeneration): void {
    const carried = (e as { response?: unknown } | undefined)?.response;
    if (!carried || typeof carried !== "object") return;
    const resp = carried as { status?: unknown };
    if (typeof resp.status !== "number") return;
    this.noteWireResponse(carried as { status: number }, generation, "thrown");
  }

  /** Re-raise a latched breaker as itself. Every caller is where the guard's own throw is unreachable or rewritten (`noRetryTransport()` bypasses the gate; `AdtHTTP` strips `instanceof AbapError`) — without this the latch would surface as a retryable local failure. An armed re-arm is let through: the guard is the one place that actually spends it. */
  private assertBreakerClosed(): void {
    if (this.breaker.isTripped && !this.breaker.authProbeArmed) throw circuitOpenError(this.breaker);
  }

  private assertUsable(): void {
    // Breaker first: the harder stop, and its message is what an operator must act on.
    this.assertBreakerClosed();
    if (this.death) throw connectionDeadError(this.death);
  }

  /** Promote a death learned on a successful response to a real one. No-op when none is pending. */
  private applyDeferredDeath(): void {
    const pending = this.deferredDeath;
    if (!pending) return;
    this.deferredDeath = undefined;
    this.markDead(pending.reason, pending.generation);
  }

  /**
   * Log on, run the discovery probe, detect the system role.
   *
   * The logon bound: `connect()` logs on exactly once (one `client.login()`, no
   * retry, failure terminal). Every later logical request costs at most one
   * logon, enforced by {@link RequestBudget} spent at the wire in
   * `noteWireRequest()` — a second is refused before dispatch, not merely
   * logged. (This used to be asserted as "exactly one logon ever", which was
   * false: two independent retry layers each honoured it locally, and one
   * persistent CSRF 403 cost three logons against the 5-attempt user lock
   * before the budget existed.) `logonEndpointRequests` is the assertable
   * observable.
   */
  async connect(): Promise<ConnectionInfo> {
    // T3 — `connect()` is the ONE flow that clears the death record, done deep
    // inside `connectUnderLock()` at the moment a replacement session provably
    // exists — NOT here. It used to clear right here, before the lock, purely
    // to get past `assertUsable()`'s death check (F1a): a racing caller was then
    // admitted onto a dead session instead of being told `SESSION_DEAD`. Fix:
    // stop using the clear as a gate — run only the breaker half of
    // `assertUsable()` explicitly and leave the death record alone.
    //
    // This cannot become a reconnect storm: (1) the auth latch is one-strike,
    // permanent for the process, and remembered per credential fingerprint —
    // bad credentials cost at most one logon attempt ever; (2) session death
    // never touches the breaker (`classifyAuthFailure` excludes it); (3) the
    // per-connection {@link LOGON_ENDPOINT_LIFETIME_CEILING} bounds unbudgeted
    // logons locally. Nothing in this class calls `connect()` by itself —
    // reviving is always caller-initiated (see `onDead()`).
    this.assertBreakerClosed();
    // LEVEL B — the whole preamble (logon → discovery → role probe) runs in ONE
    // exclusive window: it is not memoised in this class, and `connected` isn't
    // set until `login()` resolves, so two concurrent callers used to both pass
    // the check and both log on. The `connected` re-check moves INSIDE the hold
    // so the second caller returns `info()` after the wait, having issued zero requests.
    return await this.lock.runExclusive("connect", () => this.connectUnderLock());
  }

  /** The body of {@link connect}, run with the session to itself. */
  private async connectUnderLock(): Promise<ConnectionInfo> {
    if (this.connected) return this.info();
    // F1a — the death record is NOT cleared here. It survives the whole attempt
    // and is cleared in exactly one place: the moment a replacement session
    // provably exists, immediately before `connected = true` below. Until then
    // a concurrent caller's `assertUsable()` correctly refuses with
    // `SESSION_DEAD` instead of being admitted onto a corpse. (The old code
    // cleared it before the lock purely to satisfy `assertUsable()`, which left
    // the whole logon round trip reporting a healthy connection with no
    // session.) Safe only because the death record carries a generation: a
    // death landing DURING this logon is recorded on the current generation
    // rather than swallowed as stale, so the re-check below sees it.
    //
    // F1b — THE ONE AND ONLY generation increment. Here, behind the `connected`
    // early return and before `login()`: behind the guard so it only advances
    // while this connection believes it holds no session; before `login()`
    // because SAP can answer a logon with an ICM `ICMENOSESSION` page while
    // `login()` still resolves, and that death belongs to the NEW generation;
    // at attempt start (not success) so two consecutive `connect()` calls where
    // the first fails still leave the second on a fresh generation.
    this.currentGeneration++;
    // Phase timing (opt-in, `ABAP_TIMING_DEBUG`); unread on any throw below —
    // a failed connect's phase split is not a cost anyone is tracking.
    const timed = timingDebugEnabled();
    const clock = (): number => (timed ? Date.now() : 0);
    const tStart = clock();
    // Whether the auth latch was ALREADY tripped before this attempt sent
    // anything — read here, not in the catch, because this attempt's own 401
    // may latch it by the time the catch runs, and the two cases need opposite
    // diagnoses (see `latchedByThisAttempt` below).
    const latchedBeforeThisAttempt = this.breaker.isTripped;
    try {
      await this.client.login();
    } catch (e) {
      // Re-raise a PRE-EXISTING latch as itself (`assertBreakerClosed()`). But
      // ONLY a pre-existing one: when THIS attempt's own rejected logon set the
      // latch, `AUTH_CIRCUIT_OPEN` names abapsmith's internals instead of the
      // operator's actual problem — worst at the startup probe, where
      // the banner an operator reads named the breaker instead of "fix
      // ABAP_USER/ABAP_PASSWORD". Falling through to the terminal throw below
      // is strictly more informative and just as terminal (the latch is still
      // set; nothing retries).
      //
      // Tested on OUR OWN breaker state, not the error's shape, because
      // `AdtHTTP.fromException` rewrites anything that isn't already an
      // `AdtException` — the guard's own `AbapError` cannot be relied on to
      // survive `client.login()` as itself. The latch's `info` is local state
      // the library cannot rewrite.
      const trip = this.breaker.info;
      const latchedByThisAttempt =
        !latchedBeforeThisAttempt &&
        this.breaker.isTripped &&
        (trip?.status === 401 || trip?.status === 403);
      if (!latchedByThisAttempt) this.assertBreakerClosed();
      // A LOCAL refusal is not an authentication failure. `LOGON_ENDPOINT_LIFETIME_CEILING`
      // refuses the 6th unbudgeted logon-endpoint request before it reaches the
      // wire — nothing sent, no credential rejected, `login/fails_to_user_lock`
      // untouched. Wrapping it as `AUTH_FAILED` told the operator the opposite
      // of the truth (STOP AND DO NOT RETRY vs. "fix the caller that kept
      // logging on"). Live-observed on A4H, 2026-08-03 — see
      // the git history.
      //
      // Tested on our own `logonCeilingRefused` state rather than the error's
      // shape, for the same `fromException`-rewriting reason as above (it used
      // to be `logonEndpointRequestCount > CEILING`, which worked only because
      // a refused attempt was charged — itself the accounting bug).
      if (
        this.logonCeilingRefused ||
        (e instanceof AbapError && e.details.reason === "logon-ceiling-exceeded")
      ) {
        // D3 — close the state discontinuity at its source. Past this point
        // this object can never connect again (the ceiling is a lifetime count
        // no revival resets, and `logonCeilingRefused` is checked first here),
        // so `markDead()` says so — otherwise `isDead` stayed `false` and
        // `AdtSessionPool.isSlotDead` (pool.ts) kept re-seating this corpse as
        // primary forever, bricking the process even after the appliance
        // recovered. `markDead()` (not a new predicate) routes through the
        // existing death machinery (`onDead` -> re-seat, `server.ts`'s
        // `watchPrimary`) unchanged. Placed here rather than at
        // `noteWireRequest` (documented pure accounting, no side effects) —
        // this site runs once `login()` has settled. Costs nothing on the
        // wire: `dropSlot` skips `shutdown()` for an already-dead slot.
        this.markDead(
          `Refused locally by the logon-endpoint lifetime ceiling ` +
            `(${LOGON_ENDPOINT_LIFETIME_CEILING}): this connection can never log on again. ` +
            "Nothing was sent and no credential was rejected.",
        );
        if (e instanceof AbapError && e.details.reason === "logon-ceiling-exceeded") throw e;
        throw new AbapError(
          "ADT_ERROR",
          `Could not connect to ${stripUrlCredentials(this.cfg.url)}: refused locally after ` +
            `${this.logonEndpointRequestCount} logon-endpoint requests (ceiling ` +
            `${LOGON_ENDPOINT_LIFETIME_CEILING}). Nothing was sent; no credential was rejected.`,
          {
            url: stripUrlCredentials(this.cfg.url),
            user: this.cfg.user,
            reason: "logon-ceiling-exceeded",
            limit: LOGON_ENDPOINT_LIFETIME_CEILING,
            // Matches the guard's own refusal ordinal — refusals are free, so
            // the count itself stops at the ceiling.
            attempted: this.logonEndpointRequestCount + 1,
          },
          "This is an abapsmith bug, not a SAP one, and NOT an authentication " +
            "failure: the user lock counter was never touched. Do not treat it as a " +
            "401. Find the path that kept logging on outside a budgeted request().",
        );
      }
      // `cfg.url` may carry userinfo credentials — redact for the message that
      // crosses the tool boundary; only axios' `baseURL` sees the real one.
      //
      // The CODE below is not hardcoded to `AUTH_FAILED`: that used to be
      // returned for every failure here, indistinguishable from a down system
      // or an unreachable host. Live-reproduced during an appliance outage
      // (correct credentials, system refusing everyone) telling the operator
      // to fix their password — backwards, since a genuine auth failure means
      // STOP AND DO NOT RETRY while an outage means STOP AND WAIT.
      // `classifyConnectFailure` (`src/adt/connect-failure.ts`) tells the two
      // apart; see that module for why transport/TLS is inspected before
      // status (a bare 500 is not proof SAP ever answered — abap-adt-api
      // fabricates one from any unrecognised thrown value).
      //
      // When THIS attempt's own logon latched the breaker, the thrown value is
      // the guard's `AUTH_CIRCUIT_OPEN` and no longer carries the real 401's
      // status or prose — classifying it would land in the unclassified bucket
      // and lead with abapsmith's internals instead of the operator's actual
      // problem. The latch's first-failure record supplies the verdict
      // instead.
      const verdict = latchedByThisAttempt
        ? credentialsRejectedVerdict(trip?.status ?? 401)
        : classifyConnectFailure(e);
      throw new AbapError(
        verdict.code,
        `Could not connect to ${stripUrlCredentials(this.cfg.url)}: ` +
          `${latchedByThisAttempt && trip ? trip.message : describeUnknownError(e)}`,
        {
          url: stripUrlCredentials(this.cfg.url),
          user: this.cfg.user,
          reason: verdict.reason,
          ...(verdict.status !== undefined ? { status: verdict.status } : {}),
          ...(verdict.transport !== undefined ? { transport: verdict.transport } : {}),
        },
        verdict.hint,
      );
    }

    // A death that landed WHILE `login()` was in flight must not be clobbered
    // by the assignment below. `this.death` is checked by GENERATION, not
    // presence: a record from an older generation is the corpse being revived
    // from (about to be cleared); one carrying the CURRENT generation can only
    // have been recorded during this attempt's own logon round trip (SAP can
    // answer a logon with the ICM `ICMENOSESSION` page while `login()` still
    // resolves) or by a concurrent `markDead()`. Writing `connected = true`
    // over that used to produce a connection simultaneously `isDead` and
    // `isConnected` — the one state this class must never be in, and one from
    // which no caller could ever recover since `connect()`'s own early-return
    // meant it could never be revived. Failing here is not a dead end: the
    // NEXT `connect()` advances the generation and clears the record on ITS
    // success, bounded as ever by the auth latch and the logon ceiling.
    this.applyDeferredDeath();
    if (this.death && this.deathGeneration >= this.currentGeneration) {
      throw connectionDeadError(this.death);
    }

    // THE ONE PLACE the death record is cleared, and the first instant at
    // which clearing it is true: the logon resolved and nothing killed this
    // generation, so a replacement session demonstrably exists.
    this.death = undefined;
    this.deferredDeath = undefined;
    this.connected = true;
    const tLogon = clock();
    this.installShutdownHooks();

    // Discovery probe — feature-probe, never hardcode release assumptions.
    // NON-FATAL (the server is useful without a capability map) but never
    // SILENT: an empty inventory makes every feature question answer
    // "unsupported", and a confident wrong "no" is worse than an error, so
    // `Discovery.load()` records `failed` before rethrowing and the catch
    // below carries that state out through `info()`. Deliberately `load()` in
    // try/catch rather than `tryLoad()`, which discards the error and
    // conflates `failed`/`empty` into one `false` — the very distinction this
    // site preserves.
    //
    // SHARED-INVENTORY FAST PATH (`discovery-cache.ts`): the probe's result is
    // a property of the SYSTEM, not of this one session — identical for every
    // pool slot, constant for the process lifetime. Keyed on
    // `logonClientFromCookies()`'s RESOLVED client (never `cfg.client` — see
    // `discovery-cache.ts` for why that distinction is load-bearing). A hit
    // adopts the parsed inventory via `loadParsed()`, no round trip; a miss
    // still calls `Discovery.load()` and only a genuinely `"loaded"` outcome
    // is cached (never `"failed"`/`"empty"`, or every later connection would
    // inherit a false negative). When the resolved client can't be determined
    // at all, the cache is skipped entirely (neither read nor write) rather
    // than falling back to `cfg.client`, which would let two different-client
    // sessions collide on one cache entry.
    const resolvedClient = logonClientFromCookies(this.cookies());
    const discoveryKey =
      resolvedClient !== null
        ? discoveryCacheKey({ url: this.cfg.url, client: resolvedClient, user: this.cfg.user })
        : undefined;
    const cachedInventory = discoveryKey ? getSharedDiscoveryInventory(discoveryKey) : undefined;
    try {
      if (cachedInventory) {
        this.discovery.loadParsed(cachedInventory);
      } else {
        await this.discovery.load();
        if (discoveryKey && this.discovery.loadState === "loaded") {
          setSharedDiscoveryInventory(discoveryKey, this.discovery.parsedCollections);
        }
      }
      this.discoveryLoadError = undefined;
    } catch (e) {
      this.discoveryLoadError = describeUnknownError(e);
      this.log(
        "[abapsmith] discovery probe FAILED — connect continues, but the capability " +
          'inventory is UNAVAILABLE: feature questions answer "unknown", never ' +
          `"unsupported". Cause: ${this.discoveryLoadError}`,
      );
    }
    const tDiscovery = clock();

    // Cache only DEFINITIVE answers; an inconclusive one may become definitive
    // once a CSRF token exists, and re-asking costs a single request.
    const roleFromCache = Boolean(this.cachedDetection && this.cachedDetection.role !== "inconclusive");
    this.detection = roleFromCache
      ? (this.cachedDetection as SystemRoleDetection)
      : await detectSystemRole(this.systemRoleProbes(), this.cfg);
    if (this.detection.role !== "inconclusive") this.cachedDetection = this.detection;
    const tRole = clock();
    this.role = toLegacySystemRole(this.detection);
    this.applyReadOnlyPolicy();
    if (timed) {
      // `roleCached` matters: a revived connection's role probe is free, so
      // its number isn't comparable with a fresh slot's.
      this.log(
        `[abapsmith] timing connect gen=${this.currentGeneration} ` +
          `total=${tRole - tStart}ms logon=${tLogon - tStart}ms ` +
          `discovery=${tDiscovery - tLogon}ms role=${tRole - tDiscovery}ms ` +
          `discoveryCached=${Boolean(cachedInventory)} roleCached=${roleFromCache} ` +
          `logonRequests=${this.logonEndpointRequestCount}`,
      );
    }

    // THE CLOSING CHECK, mirroring the one above `death = undefined`: the
    // clear above is only honest if nothing kills this generation before the
    // return, and two multi-request probes run in that window (discovery,
    // role detection). Neither has to THROW to kill the session — a `200`
    // carrying `x-sap-icm-err-id: ICMENOSESSION` is a death recorded via
    // `noteWireResponse` on an outwardly successful response, and both probes
    // swallow failures by design. Measured: with either probe as the victim,
    // `connect()` used to RESOLVE while leaving `isDead=true connected=false`,
    // and `ensureConnected()` (`src/server.ts`) then reported success before
    // the next tool call burned itself on `SESSION_DEAD`.
    //
    // THROWS rather than retrying: (1) matches the identical check after
    // `login()` — one method must not answer the same question two ways; (2)
    // a resolved `connect()` means "there is a session" everywhere it's
    // consumed; (3) nothing in this class reconnects by itself (`onDead()`) —
    // a retry here would be this file's first logon loop against
    // `login/fails_to_user_lock`. Generation-scoped like its sibling, so an
    // older-generation record (already cleared above) cannot fire this.
    this.applyDeferredDeath();
    if (this.death && this.deathGeneration >= this.currentGeneration) {
      throw connectionDeadError(this.death);
    }

    return this.info();
  }

  /**
   * The write gate, derived from (detection × config). **Fail
   * CLOSED**:
   *
   *  - `productive`   ⇒ read-only. `ABAP_ALLOW_WRITE` cannot override it.
   *  - `inconclusive` ⇒ read-only. `ABAP_ALLOW_WRITE` cannot override it
   *                     EITHER. This is the inversion: the previous behaviour
   *                     let an opt-in turn "we could not classify this system"
   *                     into writes-on, i.e. the one case where the server has
   *                     no idea whether it is talking to production was the
   *                     case it granted write access to.
   *  - `nonproductive`⇒ the operator's choice is honoured.
   */
  private applyReadOnlyPolicy(): void {
    const optedIn = this.cfg.readOnly === false;
    // Which input decided `readOnly`: this string is surfaced by
    // `readOnlyReason` and reaches the client via `info()`. It used to say
    // "ABAP_ALLOW_WRITE is not set" unconditionally, even under ABAP_MODE=read
    // — naming a variable the process never reads. `Config.abapMode` tells the
    // two apart.
    const writeLever =
      this.cfg.abapMode !== undefined
        ? `ABAP_MODE=${this.cfg.abapMode}`
        : "ABAP_ALLOW_WRITE is not set";
    const d = this.detection;

    if (d.role === "productive") {
      this.forcedReadOnly = true;
      this.writesLocked = true;
      this.forcedReadOnlyReason =
        `System is PRODUCTIVE — writes are forced off with no override. ${d.reason}`;
      this.log(`[abapsmith] PRODUCTIVE system → writes locked out. ${d.reason}`);
      return;
    }

    if (d.role === "inconclusive") {
      this.forcedReadOnly = true;
      this.writesLocked = true;
      this.forcedReadOnlyReason = d.probeFailure
        ? "The system-role probe never got an answer, so this system is unclassified and " +
          "writes are locked out. The connection dropped before T000-CCCATEGORY could be read, " +
          `which is not a finding about the system's role. ${d.reason}`
        : // Names both levers by token: this ceiling sits above both config
          // layers, so neither lifts it — not that one is "the" mechanism.
          "This system could NOT be proven non-productive, so writes are locked out — " +
          "ABAP_ALLOW_WRITE cannot override this, and no ABAP_MODE value can either. " +
          `${d.reason}`;
      this.log(
        "[abapsmith] system role INCONCLUSIVE → writes locked out (fail-closed)" +
          `${
            optedIn
              ? this.cfg.abapMode !== undefined
                ? `; ABAP_MODE=${this.cfg.abapMode} grants writes but they are NOT honoured here`
                : "; ABAP_ALLOW_WRITE was set but is NOT honoured here"
              : ""
          }. ` +
          d.reason,
      );
      return;
    }

    // nonproductive — and only here does the operator get a say.
    this.forcedReadOnly = false;
    this.writesLocked = false;
    this.forcedReadOnlyReason = optedIn
      ? `Writes enabled: system proven non-productive. ${d.reason}`
      : `Writes are disabled by configuration (${writeLever}) — the read-only default.`;
  }

  info(): ConnectionInfo {
    return {
      // Serialised whole into the `abap://system` MCP resource, so this string
      // reaches the client. A URL-embedded password (`http://USER:pw@host`) is
      // a live credential and must not ride out on it.
      url: stripUrlCredentials(this.cfg.url),
      sid: this.cfg.sid,
      user: this.cfg.user,
      client: this.detection.client ?? (this.cfg.client || "(default)"),
      systemRole: this.role,
      roleDetection: this.detection,
      writesLockedOut: this.writesLocked,
      readOnly: this.readOnly,
      readOnlyReason: this.readOnlyReason,
      connected: this.connected,
      circuitOpen: this.breaker.isTripped,
      discoveryCollections: this.discovery.collectionCount,
      discoveryState: this.discovery.loadState,
      discoveryError:
        this.discovery.loadState === "failed"
          ? (this.discoveryLoadError ?? this.discovery.error ?? "unknown error")
          : undefined,
      // F1b/D — the generation machinery's only consumer: the server's single
      // rendered diagnostic surface (`abap://<SID>/system`), where a swallowed
      // death becomes visible instead of just a stderr line.
      generation: this.currentGeneration,
      staleDeathReports: this.staleDeathReports,
      staleDeathAnomalies: this.staleDeathAnomalyCount,
      overlappingDispatches: this.overlappingDispatchCount,
    };
  }

  /**
   * Raw ADT GET returning the response body. Used for endpoints abap-adt-api
   * does not wrap (DDIC source, ato/settings, …). Goes through the guard.
   */
  async get(
    url: string,
    opts: { headers?: Record<string, string>; qs?: Record<string, string> } = {},
  ): Promise<{ body: string; status: number; headers: Record<string, unknown> }> {
    this.assertUsable();
    const resp = await this.request(url, { method: "GET", ...opts });
    return { body: resp.body, status: resp.status, headers: resp.headers as Record<string, unknown> };
  }

  /**
   * Raw ADT PUT. The write path uses this rather than
   * `ADTClient.setObjectSource()` for two reasons:
   *   1. `setObjectSource()` returns void, and a successful DDIC source PUT
   *      answers `200` with the **server-normalised source in the body** —
   *      worth keeping.
   *   2. it goes through the guard + the CSRF-refresh path below.
   */
  async put(
    url: string,
    opts: RawRequestOptions & { body: string },
  ): Promise<RawResponse> {
    return this.raw("PUT", url, opts);
  }

  /** Raw ADT POST (activation, checkruns, classrun, …). */
  async post(url: string, opts: RawRequestOptions & { body?: string } = {}): Promise<RawResponse> {
    return this.raw("POST", url, opts);
  }

  /** Raw ADT DELETE. Needs a stateful session and a MODIFY lock. */
  async del(url: string, opts: RawRequestOptions = {}): Promise<RawResponse> {
    return this.raw("DELETE", url, opts);
  }

  /**
   * The DDIC data preview request, and the only one. Reads rows from one
   * table or view; parsing lives in `datapreview.ts`.
   *
   * Bypasses `post()`/`raw()`'s `READ_ONLY` guard deliberately: this is a
   * **read** the server happens to expose over POST, and refusing it in
   * read-only mode would deny the one operation that mode exists to permit.
   * The bypass stays narrow (two scalar args, no URL/verb/body) so no
   * argument shape here reaches a mutating endpoint.
   *
   * Not `client.tableContents()`: that library call sends `Accept:
   * application/*` (406 here) and layers its own CSRF retry over ours (the D1
   * bug on `noRetryTransport()` below). Goes through `request()`, so a stale
   * token is refreshed and the read resent once, same as every other POST —
   * `probeT000()` (`system-role.ts`) deliberately does not share this route,
   * since it must fire exactly one POST at T000 with no retry.
   *
   * `rowNumber` sent verbatim: `0`/empty/non-numeric all mean **unlimited** on
   * the wire (a captured `0` pulled 155,924 rows / 8.3 MB), so non-positive
   * values are refused here rather than forwarded.
   */
  async dataPreviewDdic(entityName: string, rowNumber: number): Promise<RawResponse> {
    this.assertUsable();
    if (!DDIC_ENTITY_CHARS.test(entityName)) {
      throw new AbapError(
        "BAD_INPUT",
        `Refusing to preview '${entityName}': the entity name carries characters that ` +
          `reach the server-side SQL.`,
        { entityName },
        "Pass a bare DDIC table or view name — no spaces, quotes, operators or clauses.",
      );
    }
    if (!Number.isInteger(rowNumber) || rowNumber < 1) {
      throw new AbapError(
        "BAD_INPUT",
        `rowNumber must be a positive integer, got ${String(rowNumber)}. ` +
          `On this endpoint 0 and non-numeric values mean UNLIMITED, not "none".`,
        { rowNumber },
        "Ask for a specific positive row count.",
      );
    }
    try {
      return await this.request(DATA_PREVIEW_DDIC, {
        method: "POST",
        qs: { rowNumber: String(rowNumber), ddicEntityName: entityName },
        headers: { Accept: DATA_PREVIEW_ACCEPT, "Content-Type": "text/plain" },
        body: "",
      });
    } catch (e) {
      // Mirrors `probeT000()` (`system-role.ts`): a tripped breaker must not
      // surface as a preview failure the caller would retry.
      this.assertBreakerClosed();
      throw e;
    }
  }

  /**
   * The OData service runtime `$metadata` request, and the only one.
   *
   * Not `get()`: this hits a different ICF hierarchy (`/sap/opu/odata*`) than
   * every other caller's ADT (`/sap/bc/adt/...`), and the difference is
   * structural, not a review promise — the path must match
   * {@link SERVICE_METADATA_PATH} and no headers/body/verb/query string are
   * accepted (parity item P-40: OData contracts, never rows — see `edmx.ts`).
   * `http-guard.ts`'s `assertHttpPathAllowed()` is a deny-list that already
   * permits `/sap/opu/odata*`; this assertion narrows further on top of it,
   * not around it.
   *
   * Cookie jar: `AdtHTTP` keeps one jar for the whole connection, and the
   * OData runtime may hand out its own `SAP_SESSIONID_<SID>_<CLNT>` that would
   * overwrite and strand the ADT stateful session — costly on a
   * limited-work-process appliance. So the jar is snapshotted and
   * restored around the call; safe because the caller holds an exclusive pool
   * lease (`pool.ts`). Whether a cookie was actually set is reported via
   * `cookieJarChanged` rather than assumed.
   */
  async serviceRuntimeGet(path: string): Promise<RawResponse & { cookieJarChanged: boolean }> {
    this.assertUsable();
    if (!SERVICE_METADATA_PATH.test(path)) {
      throw new AbapError(
        "BAD_INPUT",
        `Refusing to request '${path}': this connection will only fetch OData $metadata, ` +
          `never service data. The path must be rooted at /sap/opu/odata or ` +
          `/sap/opu/odata4 and end in /$metadata.`,
        { path },
        "abapsmith reads OData CONTRACTS, never rows (parity item P-40). Entity reads, " +
          "$batch and $filter are out of scope by design and no option enables them — an " +
          "ADT developer session is not an application user session, and reading business " +
          "data through one would escape the authorization concept the operator set. Use a " +
          "real OData client with its own credentials for data.",
      );
    }

    const jar = this.cookieJar();
    const before = jar ? new Map(jar) : undefined;
    try {
      const resp = await this.request(path, {
        method: "GET",
        // The OData runtime content-negotiates. `application/xml` is what
        // returns EDMX; `application/json` returns a JSON metadata document
        // this codebase has no parser for, and `*/*` lets the server pick.
        headers: { Accept: "application/xml" },
      });
      return {
        body: resp.body,
        status: resp.status,
        headers: resp.headers as Record<string, unknown>,
        cookieJarChanged: this.restoreCookieJar(before),
      };
    } catch (e) {
      this.restoreCookieJar(before);
      this.assertBreakerClosed();
      throw e;
    }
  }

  /** The library's private cookie Map, or undefined if its shape ever changes. */
  private cookieJar(): Map<string, string> | undefined {
    const jar = (this.client.httpClient as unknown as { cookie?: unknown }).cookie;
    return jar instanceof Map ? (jar as Map<string, string>) : undefined;
  }

  /**
   * Put the jar back the way it was. Answers whether anything had to be
   * undone, so the caller can report an observed fact ("the runtime set a
   * cookie and it was discarded") instead of a guess.
   */
  private restoreCookieJar(before: Map<string, string> | undefined): boolean {
    const jar = this.cookieJar();
    if (!jar || !before) return false;
    let changed = jar.size !== before.size;
    if (!changed) {
      for (const [k, v] of before) {
        if (jar.get(k) !== v) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      jar.clear();
      for (const [k, v] of before) jar.set(k, v);
    }
    return changed;
  }

  private async raw(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    opts: RawRequestOptions & { body?: string },
  ): Promise<RawResponse> {
    this.assertUsable();
    // Defence in depth, mirroring `withStatefulSession()`'s check: `raw()` is
    // the one choke point behind `put()`/`post()`/`del()`, which used to reach
    // the wire unchecked when called directly. `GET` never reaches `raw()`, so
    // this cannot block reads.
    if (this.readOnly) {
      throw new AbapError(
        "READ_ONLY",
        `${method} requires writes to be enabled. ${this.readOnlyReason}`,
        { method, systemRole: this.role, readOnlyReason: this.readOnlyReason },
        "Writes and deletions are refused while the server is in read-only mode.",
      );
    }
    const resp = await this.request(url, {
      method,
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...(opts.qs ? { qs: opts.qs } : {}),
      ...(opts.body === undefined ? {} : { body: opts.body }),
    });
    return {
      body: resp.body,
      status: resp.status,
      headers: resp.headers as Record<string, unknown>,
    };
  }

  /**
   * `AdtHTTP._request` — the library's "HTTP request without automated login
   * / retry", reached via cast because it's marked private.
   *
   * **This is the only way this class puts a request on the wire — the whole
   * D1 fix.** `AdtHTTP.request()` (public) carries its own CSRF-403 retry;
   * two retry layers that can't see each other multiply — one persistent 403
   * used to cost four body deliveries and three logons. Deleting one layer is
   * the only fix that composes.
   *
   * Deliberately the library's method, not a hand-rolled call: it assembles
   * identical headers to the normal path (bytes on the wire unchanged), still
   * passes through `GuardedHttpClient` (breaker, `requestCount`), and still
   * captures a fresh `x-csrf-token`, which is what lets `refreshCsrfToken()`
   * work without a logon.
   */
  private noRetryTransport(): NoRetryTransport {
    return this.client.httpClient as unknown as NoRetryTransport;
  }

  /**
   * Low-level request with CSRF recovery on `403 CSRF token validation failed`.
   *
   * A CSRF 403 means the server rejected the request at the CSRF gate before
   * the handler ran — the body was never applied — so one resend is correct
   * recovery, not a duplicate mutation. Three defects that used to accompany
   * this are each fixed at a specific site: D1 retry-stacking
   * (`noRetryTransport()` + {@link RequestBudget} cap), D2 logon burn on token
   * refresh (`refreshCsrfToken()`, never calls `login()`), D3 session
   * destruction under a held lock (`refuseCsrfRecoveryInStatefulSession()`,
   * not recovered from at all).
   */
  private async request(url: string, config: Record<string, unknown>) {
    // Promote before the check below: `attempt()` may call
    // `this.client.login()`, and `AdtHTTP.fromException` rewrites anything not
    // already an `AdtException`, which would destroy the SESSION_DEAD/condemned
    // shape of an error raised inside `login()`.
    this.applyDeferredDeath();
    this.assertUsable();
    const budget = new RequestBudget(url);
    // Async-scoped, not save/restore on a field. `request()` is NOT
    // serialised: two concurrent logical requests each ran the save/restore
    // dance on one shared field, so whichever assigned last owned the field and
    // the other request's logon was spent from the wrong budget. The store
    // binds the budget to exactly this call's async subtree, which is the
    // lifetime the budget already modelled. Scope is unchanged: `attempt()`'s
    // `login()` and `refreshCsrfToken()` are inside and stay budgeted;
    // `connect()`'s `login()`, `probeT000()`, `dropSession()` and direct
    // `conn.adt.*` are outside and stay unbudgeted.
    return await this.requestContext.run({ budget }, () => this.attempt(url, config, budget));
  }

  /** One logical request: optional autologin, one send, at most one recovery. */
  private async attempt(
    url: string,
    config: Record<string, unknown>,
    budget: RequestBudget,
  ): Promise<RawResponse> {
    const http = this.client.httpClient;

    // The one service `AdtHTTP.request()` performed that's worth keeping: log
    // on if we hold no token. Reproduced here rather than inherited, since
    // inheriting means inheriting the retry bolted to it too.
    const freshLogon = !http.loggedin;
    if (freshLogon) await this.client.login();

    try {
      return await this.noRetryTransport()._request(url, config);
    } catch (e) {
      if (!isCsrfError(e) || this.breaker.isTripped) throw e;

      // A token minted milliseconds ago and immediately refused is not stale —
      // the refusal is structural (ICF node off, missing authorisation, an
      // endpoint that refuses this verb). Fetching another identical token
      // changes nothing, so this is the answer, not a transient. Mirrors the
      // library's own `!autologin` guard, and keeps the logon bound at one.
      if (freshLogon) throw e;

      this.refuseCsrfRecoveryInStatefulSession(url, e);

      budget.spendResend();
      await this.refreshCsrfToken(url);
      return await this.noRetryTransport()._request(url, config);
    }
  }

  /**
   * D3 — the most serious of the three CSRF defects, and the one that is
   * refused rather than repaired.
   *
   * A stale-token recovery inside a stateful session would be a second life
   * for a request whose session may no longer exist: an ADT enqueue is bound
   * to the `sap-contextid` (the session), not the credentials, so anything
   * that discards the session discards the caller's lock. The old code did
   * exactly that: `csrfToken = "fetch"` → `loggedin === false` → next
   * `request()` calls `login()` → `login()` clears the cookie jar, killing
   * the session — the replayed PUT then carried a lock handle from a session
   * already thrown away, and the caller was told the write succeeded.
   *
   * Even with the logon removed, replaying here would still be guessing about
   * session state we cannot observe — a wrong confident success is worse than
   * an error. The body was rejected at the CSRF gate, so nothing was applied
   * and there's nothing to undo; the caller redoes the whole
   * lock → PUT → unlock sequence.
   */
  private refuseCsrfRecoveryInStatefulSession(url: string, cause: unknown): void {
    if (this.activeSession === undefined && !this.client.httpClient.isStateful) return;
    const heldLocks = this.heldLockUris();
    throw new AbapError(
      "ADT_ERROR",
      `The ABAP system rejected ${url} with a stale CSRF token while a stateful ` +
        "session was in flight. The request was REFUSED by the server, so nothing " +
        "was written; abapsmith will not refresh the token and replay it, because a " +
        "token refresh can cost the SAP session the session's object locks are " +
        `bound to. Cause: ${describeUnknownError(cause)}`,
      {
        operation: "request",
        url,
        reason: "csrf-stale-in-stateful-session",
        ...(heldLocks.length ? { heldLocks } : {}),
      },
      "Retry the whole operation. It starts a fresh session and re-takes the lock, " +
        "which is safe; replaying the request inside this one would not be — a lock " +
        "handle is only valid in the sap-contextid that minted it.",
    );
  }

  /**
   * Re-fetch the CSRF token **without spending a logon** — the D2 fix.
   *
   * The coupling that made a refresh cost a session, all inside `AdtHTTP`:
   *
   *     set csrfToken("fetch")  →  get loggedin() === false
   *     AdtHTTP.request()       →  if (!loggedin) await login()
   *     login()                 →  this.cookie.clear()   ← session dies here
   *
   * Broken by going through `_request` instead of `request`: it never reads
   * `loggedin`/calls `login()`, but still captures a fresh token off the
   * response when `csrfToken === "fetch"` — the only part actually wanted.
   *
   * On failure the token is left as `"fetch"` rather than restored — not
   * worth putting back a token the server just refused. Cost: the next
   * logical request autologs on, inside its own budget.
   */
  private async refreshCsrfToken(forUrl: string): Promise<void> {
    const http = this.client.httpClient;
    http.csrfToken = CSRF_FETCH;
    try {
      await this.noRetryTransport()._request(CSRF_REFRESH_ENDPOINT, {
        method: "GET",
        headers: { "x-csrf-token": CSRF_FETCH },
      });
    } catch (e) {
      throw new AbapError(
        "ADT_ERROR",
        `Could not refresh the CSRF token after ${forUrl} was rejected: ` +
          describeUnknownError(e),
        { operation: "csrf-refresh", url: CSRF_REFRESH_ENDPOINT, reason: "csrf-refresh-failed" },
        "The original request was refused by the server and was NOT resent. Retry it.",
      );
    }
    if (http.csrfToken === CSRF_FETCH) {
      // See CSRF_REFRESH_ENDPOINT: the inference failing out loud, rather than
      // resending with `x-csrf-token: fetch` (guaranteed refused again).
      throw new AbapError(
        "ADT_ERROR",
        `The CSRF refresh (GET ${CSRF_REFRESH_ENDPOINT}) answered without an ` +
          "x-csrf-token header, so there is no fresh token to resend " +
          `${forUrl} with. The request was NOT resent.`,
        { operation: "csrf-refresh", url: CSRF_REFRESH_ENDPOINT, reason: "csrf-refresh-no-token" },
        `This release may not issue a token on ${CSRF_REFRESH_ENDPOINT}; the ` +
          "captured endpoint that does is GET /sap/bc/adt/debugger/breakpoints/" +
          "messagetypes. Retry the operation — it re-logs-on and mints a token.",
      );
    }
  }

  /**
   * Run `fn` inside a stateful ADT session. Contract, in order of importance:
   * (1) `unlockAll()` runs on EVERY exit path (return, throw, shutdown) — a
   * stranded ADT enqueue is only released when the session dies, and a
   * long-lived MCP server's session doesn't; (2) session type is restored to
   * `stateless` afterwards; (3) not re-entrant — a nested call throws instead
   * of sharing the lock ledger, since two callers releasing each other's
   * locks is exactly the bug that leaves a half-written object locked. `fn`
   * gets the session, not the raw client, so the lock handle can't escape
   * (see `write.ts` — activation while holding your own lock is a 403).
   */
  async withStatefulSession<T>(fn: (session: StatefulSession) => Promise<T>): Promise<T> {
    this.assertUsable();
    if (!this.connected) {
      throw new AbapError(
        "NOT_CONNECTED",
        "A stateful ADT session requires a connected client.",
        {},
        "Call connect() first.",
      );
    }
    if (this.readOnly) {
      // Defence in depth: the safety gate checks this too, but a lock is
      // a server-side state change and must never happen on a read-only system.
      throw new AbapError(
        "READ_ONLY",
        `Stateful sessions (object locks) require writes to be enabled. ${this.readOnlyReason}`,
        { systemRole: this.role, readOnlyReason: this.readOnlyReason },
        "Locks, edits and deletions are refused while the server is in read-only mode.",
      );
    }
    if (this.activeSession) {
      throw new AbapError(
        "UNSUPPORTED",
        "A stateful ADT session is already active — nested sessions are not supported.",
        {
          heldLocks: this.heldLockUris(),
        },
        "Locks are bound to one sap-contextid; a nested session would corrupt the " +
          "lock ledger. Do the whole lock → PUT → unlock sequence in one call.",
      );
    }

    const session = new StatefulSession(this.client, {
      log: this.log,
      // D5(a): stop retrying UNLOCK once the breaker has latched — see
      // `StatefulSessionOptions.isBreakerTripped`'s doc comment.
      isBreakerTripped: () => this.breaker.isTripped,
      // Previously a leak was only visible on stderr and reached
      // nothing a caller could inspect afterwards (`session`/`activeSession`
      // both go away once this method returns). `lastLockLeak` is the
      // survivor. This callback does NOT decide anything — the escalation
      // below reads `session.leakedLocks` itself.
      onLockLeak: (err) => {
        this.lastLockLeak = err;
      },
    });
    const cleanup = () => session.unlockAll();
    // The check-and-claim above and this assignment must stay adjacent with NO
    // `await` between them — the TOCTOU guard on `activeSession`.
    this.activeSession = session;
    this.onShutdown(cleanup);

    try {
      // LEVEL B — the mutex is held for the whole stateful window, not merely
      // per-request: `client.stateful` is one mutable field on the shared
      // `ADTClient`, sampled per dispatch, so an unrelated request between the
      // set and the reset would ride out with the wrong session type, and a
      // request from this flow dispatched after the reset would lose the
      // `sap-contextid` its lock is bound to. Per-request serialisation
      // cannot fix that — the corruption happens BETWEEN requests.
      //
      // Deadlock-free only because `acquireImplicit` is re-entrant through the
      // ambient token set (session-lock I3): every request `fn` issues finds
      // this hold's own token and passes straight through.
      return await this.lock.runExclusive("withStatefulSession", async () => {
        this.client.stateful = session_types.stateful;
        try {
          return await fn(session);
        } finally {
          // Order matters: release the enqueues while the session is still
          // alive, THEN tear it down. Both stay inside the hold.
          await session.unlockAll();
          // `unlockAll()` swallows every leak it records (never
          // throws), so a genuine UNLOCK failure against a still-LIVE session
          // falls through here with the ABAP enqueue still held server-side.
          // `pool.ts` has no leak guard of its own to catch it (`stillHoldsLocks()`
          // used to read `heldLockUris()` through
          // `activeSession`, which this method's own outer `finally` has
          // already cleared by the time `releaseSlot()` could run, so the
          // check was dead in production and was removed rather than kept as
          // a decoy). Dropping the session here is what actually releases the
          // enqueue (an ADT lock lives and dies with its `sap-contextid`);
          // this also covers a leak on the pinned primary slot, which the
          // pool's staleness sweep exempts unconditionally.
          //
          // The `dropSession()` call is wrapped even though it already
          // swallows its own wire-call failure: its first line is
          // `assertUsable()`, unswallowed, which throws `SESSION_DEAD` if
          // `this.death` is already set by an independent classifier
          // (`classifySessionFailure`) that isn't provably in sync with the
          // one that decided this UNLOCK counted as a leak
          // (`UNLOCK_NOT_A_LEAK`, `session.ts`). An unwrapped throw here would
          // override whatever `fn(session)` returned — including a successful
          // write — with a manufactured session-dead error, and `pool.ts`'s
          // `runOnAttempt` would replay it once on a fresh slot,
          // doubling the write. Swallowing costs nothing here: if
          // `this.death` is set the ABAP session (and every lock it held) is
          // already gone, so the enqueue-release goal is already met; any
          // other escape (e.g. breaker trip) surfaces on the next call via
          // `assertUsable()` anyway.
          //
          // This local swallow is no longer the only defence.
          // `pool.ts` closes the class structurally — `connectionDeadError()`
          // stamps `details.condemned: true`, and the write-replay gate in
          // `runOnAttempt()` refuses to replay any write that fails this way,
          // from whichever call site throws it, without depending on the two
          // classifiers agreeing. `test/session-death-oracle.test.ts` asserts
          // that. The try/catch below already closes this specific site;
          // the pool gate is defence in depth for future cleanup
          // paths that might forget the same wrap. See
          // the git history for the full incident
          // history.
          //
          // A failed LOCK can strand an enqueue with no ledger
          // entry for `unlockAll()` to find, so `session.suspectedEnqueues`
          // routes those here too — see `LOCK_FAILURE_NOT_SUSPECT` (session.ts)
          // for which failures qualify. The `blockingUser`-vs-`this.cfg.user`
          // check lives here rather than in `StatefulSession` because only
          // this class knows the configured user. Not a force-unlock: dropping
          // our own `sap-contextid` can only release enqueues bound to *this*
          // session, so `doc/SAFETY/data-access-and-credentials.md`'s "no lock or unlock tools" promise holds.
          const selfConflicts = session.lockConflicts.filter(
            (c) => c.blockingUser.toLowerCase() === this.cfg.user.toLowerCase(),
          );
          if (session.leakedLocks.length > 0 || session.suspectedEnqueues.length > 0 || selfConflicts.length > 0) {
            if (session.suspectedEnqueues.length > 0) {
              this.log(
                `[abapsmith] dropping session over suspected unreleased LOCK(s): ` +
                  session.suspectedEnqueues.join(", "),
              );
            }
            if (selfConflicts.length > 0) {
              this.log(
                `[abapsmith] dropping session: blocked by our own earlier session (${this.cfg.user}) on ` +
                  selfConflicts.map((c) => c.uri).join(", "),
              );
            }
            try {
              await this.dropSession();
            } catch (e) {
              this.log(
                `[abapsmith] post-leak dropSession() itself failed (ignored — a genuine ` +
                  `session death here means the enqueue is already gone regardless): ` +
                  describeUnknownError(e),
              );
            }
          }
          this.client.stateful = session_types.stateless;
        }
      });
    } finally {
      // Purely local bookkeeping — zero requests — so it is correct (and
      // deliberate) that it runs outside the hold.
      session.markEnded();
      this.offShutdown(cleanup);
      this.activeSession = undefined;
    }
  }

  /**
   * Drop the ABAP session: reset to stateless and discard the `sap-contextid`.
   *
   * Costs one request. Releases every lock the session held — which is
   * why `withStatefulSession` unlocks explicitly first rather than relying on
   * this.
   *
   * Failures are logged and swallowed on purpose: the only ways this call can
   * fail are (a) the session is already dead, in which case the goal is already
   * achieved, or (b) the network is down, in which case the next request fails
   * anyway and reports itself properly.
   */
  async dropSession(): Promise<void> {
    this.assertUsable();
    // LEVEL B — the flag flip and the drop are one atomic window. This is the
    // one failure mode with a captured wire record: a request that is in flight
    // when the `sap-contextid` is discarded answers `400` with
    // `x-sap-icm-err-id: ICMENOSESSION`, and any enqueue it was holding is gone.
    //
    // Re-entrant when called from inside `withFreshSession` (which holds the
    // same lock), a real hold when called standalone.
    await this.lock.runExclusive("dropSession", async () => {
      this.client.stateful = session_types.stateless;
      try {
        await this.client.dropSession();
      } catch (e) {
        this.assertBreakerClosed();
        this.log(
          `[abapsmith] dropSession failed (ignored — the ABAP session is gone either way): ` +
            describeUnknownError(e),
        );
      }
    });
  }

  /**
   * Run `fn` with a **guaranteed-fresh ABAP session**: any existing session is
   * dropped BEFORE `fn` is invoked.
   *
   * ⚠️ THIS IS NOT AN OPTIMISATION, IT IS A CORRECTNESS REQUIREMENT. ⚠️
   *
   * The single most dangerous finding of live write testing:
   * `POST /sap/bc/adt/oo/classrun/{CLASS}` executes the version of the class
   * already in the ABAP internal session's program buffer. After PUT +
   * activate in the SAME stateful session, running the class returned
   * **byte-identical output from the previous implementation** — HTTP 200,
   * plausible output, wrong code. A fresh session ran the new version
   * immediately.
   *
   * Any "edit then run" flow MUST route its execution through here. Dropping
   * the session afterwards would be too late — the drop must happen before
   * the buffer is consulted, i.e. before `fn`.
   */
  async withFreshSession<T>(fn: (client: ADTClient) => Promise<T>): Promise<T> {
    this.assertUsable();
    if (this.activeSession) {
      throw new AbapError(
        "UNSUPPORTED",
        "Cannot start a fresh session while a stateful session holds locks — " +
          "dropping the session would silently release them.",
        { heldLocks: this.heldLockUris() },
        "Finish (and unlock) the edit before running code: lock → PUT → unlock → " +
          "activate → run, with the run in its own session.",
      );
    }
    // LEVEL B — the hold spans BOTH the drop and `fn`. Splitting them would
    // leave a window in which the `sap-contextid` has just been discarded and a
    // stranger's request can be dispatched onto it; and it would also let a
    // stranger establish a *new* session between the drop and `fn`, which is
    // precisely the program-buffer staleness this method exists to
    // prevent. `dropSession()` takes the same lock and passes straight through
    // by re-entrancy.
    return await this.lock.runExclusive("withFreshSession", async () => {
      await this.dropSession();
      return await fn(this.client);
    });
  }

  /**
   * The collaborators `detectSystemRole()` (`system-role.ts`) needs from this
   * connection. `probeT000` is wired to `noRetryTransport()._request`, not
   * `post()`/`request()`, because that's the point of the "ONE POST, NO
   * RETRY" invariant on `probeT000()` in `system-role.ts` — CSRF-resend here
   * would turn one POST into two against a system that may lock the account
   * on the second. `getAtoSettings` is `this.get()` on purpose: an ordinary
   * read gets the ordinary guarded/retried treatment.
   */
  private systemRoleProbes(): SystemRoleProbes {
    return {
      probeT000: (url, opts) => this.noRetryTransport()._request(url, opts),
      getAtoSettings: (url, opts) => this.get(url, opts),
      cookies: () => this.cookies(),
      assertBreakerClosed: () => this.assertBreakerClosed(),
      log: (msg) => this.log(msg),
    };
  }

  /**
   * Release everything on SIGINT/SIGTERM.
   *
   * Graceful: the first signal starts `shutdown()` and only calls `exit()`
   * once it settles — exiting mid-cleanup can abort an in-flight debuggee
   * terminate call and strand a dialog work process on a sandbox with only 7
   * of them. A bounded deadline (`shutdownDeadlineMs`, default 5s) guards
   * against a hung cleanup; a second signal during shutdown forces an
   * immediate exit (double-Ctrl-C).
   *
   * The `process.on`/`once` calls live in the shared hook
   * (`src/shutdown-hook.ts`); this just subscribes one callback to it. Each
   * `AbapConnection` used to install its own 3 listeners directly, which
   * turned into a `MaxListenersExceededWarning` once a handful of connections
   * were alive at once — centralizing keeps `process` at 3 listeners total
   * regardless of connection count.
   */
  private installShutdownHooks(): void {
    if (this.unregisterShutdownHook) return;
    this.unregisterShutdownHook = registerShutdownHandler(
      `AbapConnection(${this.cfg.sid})`,
      this.onSharedShutdownSignal,
    );
  }

  /**
   * Unsubscribe from the shared shutdown hook and cancel any pending
   * force-exit timer. Without this, every connecting `AbapConnection` leaks a
   * subscription for the life of the process — harmless for one long-lived
   * server instance, unbounded for anything creating many (e.g. a test
   * suite). Safe to call more than once or before `connect()` has run.
   */
  dispose(): void {
    if (this.unregisterShutdownHook) {
      this.unregisterShutdownHook();
      this.unregisterShutdownHook = undefined;
    }
    if (this.forceExitTimer) {
      clearTimeout(this.forceExitTimer);
      this.forceExitTimer = undefined;
    }
    this.shuttingDown = false;
    this.exited = false;
  }

  /**
   * Exit exactly once. Under a real `process.exit` the first call never
   * returns, but the injected test double does — and a second `exit(0)`
   * arriving after a `exit(1)` would report success for a failed shutdown.
   */
  private exitOnce(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.exit(code);
  }

  /**
   * Signal → graceful shutdown → exit.
   *
   * The exit code is the OS-visible truth about whether cleanup worked, and
   * is derived, never assumed: 0 only on a clean shutdown with every task
   * succeeding; 1 on a rejected `shutdown()`, any caught-and-counted task
   * failure, a deadline expiry, or a second signal. A stranded ADT enqueue or
   * live debuggee left behind is exactly what a supervisor needs to see;
   * exiting 0 there would hide it.
   */
  private handleSignal(signal: string): void {
    if (this.shuttingDown) {
      this.log(
        `[abapsmith] second ${signal} received during shutdown — forcing immediate exit.`,
      );
      this.exitOnce(1);
      return;
    }
    this.shuttingDown = true;
    let timedOut = false;
    this.forceExitTimer = setTimeout(() => {
      timedOut = true;
      this.log(
        `[abapsmith] shutdown did not complete within ${this.shutdownDeadlineMs}ms — forcing exit.`,
      );
      this.exitOnce(1);
    }, this.shutdownDeadlineMs);
    this.forceExitTimer.unref?.();
    let rejected = false;
    const failuresBefore = this.shutdownFailures;
    void this.shutdown(signal)
      .catch((e) => {
        rejected = true;
        this.log(`[abapsmith] shutdown failed (${signal}): ${describeUnknownError(e)}`);
      })
      .finally(() => {
        if (this.forceExitTimer) {
          clearTimeout(this.forceExitTimer);
          this.forceExitTimer = undefined;
        }
        const taskFailures = this.shutdownFailures - failuresBefore;
        const failed = rejected || timedOut || taskFailures > 0;
        if (failed && !timedOut) {
          this.log(
            `[abapsmith] shutdown (${signal}) did not complete cleanly ` +
              `(${taskFailures} task failure(s)${rejected ? ", shutdown rejected" : ""}) — exiting 1.`,
          );
        }
        this.exitOnce(failed ? 1 : 0);
      });
  }

  /** Register work that must happen before the process dies (locks, debuggees). */
  onShutdown(fn: () => Promise<void> | void): void {
    this.shutdownTasks.push(fn);
  }

  /**
   * Deregister a shutdown task. `withStatefulSession` uses this so a long-lived
   * server does not accumulate one dead unlock hook per edit.
   */
  offShutdown(fn: () => Promise<void> | void): void {
    const i = this.shutdownTasks.indexOf(fn);
    if (i >= 0) this.shutdownTasks.splice(i, 1);
  }

  /**
   * Release everything, then drop the session. The ordering matters: unlock
   * tasks run first and while the session is still alive, because a lock only
   * dies with its `sap-contextid`.
   */
  async shutdown(reason = "shutdown"): Promise<void> {
    // THE ONE PLACE THE MUTEX IS DELIBERATELY ABANDONED.
    //
    // `withStatefulSession` registers its unlock cleanup on this chain while
    // still holding the lock, and a signal fires that cleanup from OUTSIDE
    // the holder's async context — not re-entrant, so it would queue behind
    // `handleSignal`'s 5s force-exit timer and the enqueue would leak until
    // the session itself died. `forceRelease` drops the hold and REJECTS
    // every parked waiter instead: a rejected waiter reports itself, while a
    // stranded enqueue is invisible and outlives the process. No TTL exists
    // on an exclusive hold (leases self-heal, exclusive holds don't), so this
    // is the only recovery mechanism there is, and it costs zero requests.
    this.lock.forceRelease(reason);
    const tasks = this.shutdownTasks;
    this.shutdownTasks = [];
    for (const t of tasks) {
      try {
        await t();
      } catch (e) {
        // Counted, not rethrown: the remaining tasks still have to run, but the
        // failure must still be visible to `handleSignal`'s exit code.
        this.shutdownFailures++;
        this.log(`[abapsmith] shutdown task failed (${reason}): ${describeUnknownError(e)}`);
      }
    }
    if (this.connected && !this.breaker.isTripped) {
      try {
        await this.client.dropSession();
      } catch {
        /* best effort — never block process exit on a network call */
      }
    }
    this.connected = false;
  }
}
