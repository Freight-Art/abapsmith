/**
 * Tracks which configured system the in-flight tool call was routed to.
 *
 * An `AsyncLocalStorage` rather than an explicit parameter threaded through
 * every call site: ~25 tool registrars and hundreds of handler call sites
 * would each need a new argument otherwise, for a decision (which system a
 * given request targets) that is made once per request, at the routing
 * layer (`src/systems/route.ts`), not once per registration. ALS is the
 * right tool for exactly this shape of problem — a value that needs to
 * follow one logical request through arbitrarily deep async continuations
 * without being passed explicitly at every hop.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<string>();

/**
 * The alias the in-flight tool call was routed to, or `undefined` outside a
 * routed call. A single-system server never calls {@link runInSystem} at
 * all (`installSystemRouting` is a no-op when only one system is
 * configured), so every existing call path keeps returning `undefined`
 * exactly as it always has — this function's addition changes nothing for
 * a single-system deployment.
 */
export function currentSystemAlias(): string | undefined {
  return storage.getStore();
}

/**
 * Runs `fn` with `alias` as the current system for the duration of its
 * execution, including every asynchronous continuation `fn` schedules —
 * `AsyncLocalStorage` follows `await`, so a handler's nested async work
 * (a pool lease, a nested tool call, a `.then()` chain) stays attributed to
 * the right system even after control has returned to the event loop.
 */
export function runInSystem<T>(alias: string, fn: () => T): T {
  return storage.run(alias, fn);
}
