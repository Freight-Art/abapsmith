/**
 * THE COMPILE-TIME HALF OF THE BREAKER-REQUIRED LAW.
 *
 * Nothing here runs. `omissionsMustNotCompile()` is exported and never called;
 * the assertions in this file are the four `@ts-expect-error` directives, and
 * the thing under test is whether `tsc` agrees with them.
 *
 * WHY A SEPARATE FILE AND A SEPARATE tsconfig. The root tsconfig.json excludes
 * `test/` (`"exclude": ["node_modules", "dist", "test", "scripts"]`), so
 * `npx tsc --noEmit` and `npm run build` never look at the suite — and the
 * suite does not currently type-check clean under `strict` +
 * `noUncheckedIndexedAccess` anyway (107 pre-existing errors, none of them
 * ours). So this ONE file gets its own project (`test/types/tsconfig.json`),
 * and test/breaker-required-types.test.ts runs `tsc` over it as an ordinary
 * vitest assertion. That keeps the compile-time law inside `npx vitest run`
 * without dragging the other 107 errors into scope.
 *
 * WHAT IT LOCKS. Each directive below marks a construction that used to be
 * legal and silently produced an UNSHARED circuit breaker. The appliance counts
 * failed logons per USER (`login/fails_to_user_lock`, five in practice a
 * permanent lock), so a private breaker does not get its own budget — it spends
 * the one budget everybody shares, while reporting a clean state to its owner.
 * If any of these four starts compiling again, `tsc` reports
 * "Unused '@ts-expect-error' directive" and the vitest wrapper goes red.
 */
import { AbapConnection } from "../../src/adt/connection.js";
import { GuardedHttpClient } from "../../src/adt/http-guard.js";
import { fetchCsrfToken } from "../../src/debug/transport.js";
import { AuthCircuitBreaker } from "../../src/adt/circuit-breaker.js";
import { ConfigSchema } from "../../src/config.js";

const cfg = ConfigSchema.parse({
  ABAP_URL: "http://sap.invalid:50000",
  ABAP_USER: "TYPECHECK",
  ABAP_PASSWORD: "never-sent",
  ABAP_CLIENT: "001",
});

export function omissionsMustNotCompile(): void {
  // @ts-expect-error P1 — `ConnectionOptions.breaker` is REQUIRED, so the whole
  // options object can no longer be omitted. This shape used to fall through to
  // `AbapConnection.buildBreaker(cfg)` and mint a private breaker.
  new AbapConnection(cfg);

  // @ts-expect-error P1 — and an options object WITHOUT the key is the same
  // hazard wearing a more convincing disguise: it looks configured.
  new AbapConnection(cfg, {});

  // @ts-expect-error P2 — `GuardedHttpClient`'s second argument used to default
  // to `new AuthCircuitBreaker()`. Forgetting it produced a guard that gated
  // nothing shared while looking, at the call site, exactly like a guarded one.
  new GuardedHttpClient({ baseURL: "http://sap.invalid:50000" });

  // @ts-expect-error P3 — `FetchCsrfTokenOptions.breaker` is REQUIRED. This was
  // the one seam where a request genuinely reached the wire past a LATCHED
  // process: with no breaker the gates in `fetchCsrfToken` were skipped whole
  // and the HEAD to /sap/bc/adt/core/discovery was dispatched anyway.
  void fetchCsrfToken({ baseUrl: "http://sap.invalid:50000" });
}

/**
 * The positive controls. Without these the file would still "pass" if the
 * constructors had been broken in some unrelated way that rejects everything.
 */
export function suppliedBreakersCompile(): void {
  const breaker = AuthCircuitBreaker.forConfig(cfg);
  new AbapConnection(cfg, { breaker });
  new GuardedHttpClient({ baseURL: "http://sap.invalid:50000" }, breaker);
  void fetchCsrfToken({ baseUrl: "http://sap.invalid:50000", breaker });
}
