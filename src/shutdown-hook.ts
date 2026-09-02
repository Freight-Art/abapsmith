/**
 * Shared process-shutdown hook: ONE process-level listener per signal
 * (SIGINT/SIGTERM/beforeExit), shared by every subscriber, installed lazily
 * and torn down once nobody needs it — avoids the `MaxListenersExceededWarning`
 * from each `AbapConnection` registering its own listeners directly. See
 * the git history.
 *
 * Do not treat the warning as merely cosmetic: releasing an ADT enqueue lock
 * happens ONLY when the holding session's shutdown handler runs — there is no
 * lock timeout on the SAP side, so a dropped or mis-ordered handler is a lock
 * a human must clear by hand in SM12. See archive.
 *
 * CONTRACT for subscribers:
 *   - Subscribers run in REGISTRATION ORDER, synchronously back-to-back
 *     (never awaits one before starting the next).
 *   - A cleanup returning void/undefined is SELF-MANAGED: not memoized, runs
 *     again on every subsequent signal. Do not memoize this case —
 *     `AbapConnection` relies on being reachable on a SECOND SIGINT for its
 *     double-Ctrl-C force-exit escape hatch.
 *   - A cleanup returning a Promise runs AT MOST ONCE ever: a later signal
 *     while it's pending, or after it settled/was abandoned, is a no-op.
 *   - A throwing/rejecting cleanup is caught, logged by name, and never
 *     blocks any other subscriber.
 *
 * BOUNDED, NOT UNKILLABLE: `SHUTDOWN_HOOK_BUDGET_MS` bounds only how long
 * this hook WAITS on a pending promise-returning cleanup — it never cancels
 * the underlying work (see archive for why). Matches `UNLOCK_BUDGET_MS`
 * (src/adt/session.ts) and `AbapConnection`'s own `shutdownDeadlineMs`
 * default, arrived at independently, not derived from one another.
 */

export type ShutdownSignal = "SIGINT" | "SIGTERM" | "beforeExit";

/** Cleanup registered against the shared hook. May be sync or async — see module doc. */
export type ShutdownCleanup = (signal: ShutdownSignal) => void | Promise<void>;

/**
 * Wall-clock budget this hook waits on a single promise-returning cleanup
 * before abandoning it. See module doc for why 5000 matches
 * `UNLOCK_BUDGET_MS` and `AbapConnection`'s `shutdownDeadlineMs`.
 */
export const SHUTDOWN_HOOK_BUDGET_MS = 5_000;

type SubscriberState = "idle" | "running" | "settled" | "abandoned";

interface Subscriber {
  readonly name: string;
  readonly cleanup: ShutdownCleanup;
  state: SubscriberState;
}

let subscribers: Subscriber[] = [];
let sigintListener: (() => void) | undefined;
let sigtermListener: (() => void) | undefined;
let beforeExitListener: (() => void) | undefined;

/** Set on the first signal any shutdown attempt sees; shared by every subscriber's budget. */
let deadline: number | undefined;
let budgetOverrideMs: number | undefined;
let logOverride: ((msg: string) => void) | undefined;

function log(msg: string): void {
  if (logOverride) {
    logOverride(msg);
    return;
  }
  process.stderr.write(msg + "\n");
}

function describeFailure(e: unknown): string {
  if (e instanceof Error) return e.message || e.name || "Error";
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function isPromiseLike(v: unknown): v is Promise<void> {
  return typeof v === "object" && v !== null && typeof (v as { then?: unknown }).then === "function";
}

function budgetMs(): number {
  return budgetOverrideMs ?? SHUTDOWN_HOOK_BUDGET_MS;
}

/** Remaining time in the shared budget, from whenever the FIRST signal of this shutdown attempt arrived. */
function remainingBudgetMs(): number {
  if (deadline === undefined) deadline = Date.now() + budgetMs();
  return Math.max(0, deadline - Date.now());
}

function runSubscriber(sub: Subscriber, signal: ShutdownSignal): void {
  // Don't re-enter concurrently or re-run a settled/abandoned one-shot — see module doc.
  if (sub.state === "running" || sub.state === "settled" || sub.state === "abandoned") return;

  let result: void | Promise<void>;
  try {
    result = sub.cleanup(signal);
  } catch (e) {
    // Sync throw = self-managed style (see module doc): stays "idle",
    // reachable again next signal; failure is only logged, not fatal.
    log(`[abapsmith] shutdown handler "${sub.name}" threw on ${signal}: ${describeFailure(e)}`);
    return;
  }

  if (!isPromiseLike(result)) {
    // Self-managed (see module doc) — not memoized, reachable again next signal.
    return;
  }

  sub.state = "running";
  const remaining = remainingBudgetMs();

  // `setTimeout`'s return type depends on `lib`/`@types` in scope; widen to
  // `unknown` before `.unref` (matches `defaultSleep` in src/adt/session.ts).
  const timer: unknown = setTimeout(() => {
    // Budget elapsed: stop waiting (module doc) and mark abandoned so no
    // later signal starts a second concurrent attempt at a hanging cleanup.
    if (sub.state === "running") {
      sub.state = "abandoned";
      log(
        `[abapsmith] shutdown handler "${sub.name}" did not settle within ` +
          `${budgetMs()}ms of ${signal} — no longer waiting on it (it may still finish in the ` +
          "background; it will not be invoked again).",
      );
    }
  }, remaining);
  (timer as { unref?: () => void })?.unref?.();

  void result
    .then(() => {
      clearTimeout(timer as Parameters<typeof clearTimeout>[0]);
      if (sub.state === "running") sub.state = "settled";
    })
    .catch((e: unknown) => {
      clearTimeout(timer as Parameters<typeof clearTimeout>[0]);
      if (sub.state === "running") sub.state = "settled";
      log(`[abapsmith] shutdown handler "${sub.name}" rejected on ${signal}: ${describeFailure(e)}`);
    });
}

function dispatch(signal: ShutdownSignal): void {
  // Snapshot: a cleanup that unregisters itself (or another subscriber)
  // mid-dispatch must not corrupt this pass's iteration.
  for (const sub of subscribers.slice()) {
    runSubscriber(sub, signal);
  }
}

function ensureInstalled(): void {
  if (sigintListener) return;
  sigintListener = () => dispatch("SIGINT");
  sigtermListener = () => dispatch("SIGTERM");
  beforeExitListener = () => dispatch("beforeExit");
  process.on("SIGINT", sigintListener);
  process.on("SIGTERM", sigtermListener);
  process.on("beforeExit", beforeExitListener);
}

function ensureUninstalledIfIdle(): void {
  if (subscribers.length > 0) return;
  if (sigintListener) {
    process.removeListener("SIGINT", sigintListener);
    sigintListener = undefined;
  }
  if (sigtermListener) {
    process.removeListener("SIGTERM", sigtermListener);
    sigtermListener = undefined;
  }
  if (beforeExitListener) {
    process.removeListener("beforeExit", beforeExitListener);
    beforeExitListener = undefined;
  }
}

/**
 * Register a cleanup for SIGINT/SIGTERM/beforeExit. See module doc for the
 * sync-vs-async contract and ordering/idempotency guarantees.
 *
 * `name` is diagnostics-only and need not be unique.
 *
 * Installs the shared `process` listeners on the first subscriber, removes
 * them when the last `unregister()` fires — listeners never accumulate on
 * the global `process` object across a long test run or a churning session pool.
 */
export function registerShutdownHandler(name: string, cleanup: ShutdownCleanup): () => void {
  const sub: Subscriber = { name, cleanup, state: "idle" };
  subscribers.push(sub);
  ensureInstalled();

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const i = subscribers.indexOf(sub);
    if (i >= 0) subscribers.splice(i, 1);
    ensureUninstalledIfIdle();
  };
}

/** Current subscriber count — test-only introspection, not part of the runtime contract. */
export function __shutdownHandlerCountForTests(): number {
  return subscribers.length;
}

function assertShutdownHookTestOnly(fn: string): void {
  // Same guard as AuthCircuitBreaker.resetForTests() (src/adt/circuit-breaker.ts);
  // vitest sets VITEST in every worker, always false in a real run.
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    throw new Error(`${fn}() is test-only and must never run in production.`);
  }
}

/**
 * Hard reset for test isolation: drops every subscriber without calling
 * cleanup, removes process listeners, clears deadline/overrides. Test-only.
 */
export function __resetShutdownHookForTests(): void {
  assertShutdownHookTestOnly("__resetShutdownHookForTests");
  subscribers = [];
  ensureUninstalledIfIdle();
  deadline = undefined;
  budgetOverrideMs = undefined;
  logOverride = undefined;
}

/** Override `SHUTDOWN_HOOK_BUDGET_MS` for a test. `undefined` restores the default. Test-only. */
export function __setShutdownHookBudgetMsForTests(ms: number | undefined): void {
  assertShutdownHookTestOnly("__setShutdownHookBudgetMsForTests");
  budgetOverrideMs = ms;
}

/** Redirect this module's diagnostic logging away from stderr for a test. Test-only. */
export function __setShutdownHookLogForTests(fn: ((msg: string) => void) | undefined): void {
  assertShutdownHookTestOnly("__setShutdownHookLogForTests");
  logOverride = fn;
}
