/**
 * COMPILE-TIME REGRESSION TEST — not a runtime one, and the distinction matters.
 *
 * Three of the four breaker seams this change closed (P1
 * `ConnectionOptions.breaker`, P2 `GuardedHttpClient`'s constructor argument,
 * P3 `FetchCsrfTokenOptions.breaker`) are enforced by the TYPE SYSTEM. There is
 * no runtime behaviour to assert for P1/P2: every production path already
 * converged on one shared breaker, so nothing observable changed. What changed
 * is that the WRONG code no longer compiles — and a law nobody can run is still
 * a law worth locking, because the next caller to omit the argument is the one
 * this exists for.
 *
 * So the assertion is literally "does `tsc` reject the omissions", executed by
 * spawning the compiler over test/types/breaker-required.fixture.ts. See that
 * file for why it needs a project of its own rather than riding along on
 * `npx tsc --noEmit` (short version: the root tsconfig excludes `test/`, and
 * the suite has 107 pre-existing type errors that predate this change).
 *
 * PRE-FIX, this test failed with exactly:
 *   test/types/breaker-required.fixture.ts(14,3): error TS2578: Unused '@ts-expect-error' directive.
 *   ... one per omission.
 * i.e. the compiler cheerfully accepted every breakerless construction.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Measured: ~1.6-2.2s baseline, up to 60.5s (~38x) under synthetic 3x CPU
// oversubscription, and 69.8s under genuine box contention — this bound is a
// hang guard, not a signal, so it's set with headroom well beyond observed
// worst case rather than tuned tight.
const TSC_TIMEOUT_MS = 240_000;

interface TscResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

// Async spawn, not spawnSync: spawnSync freezes this worker thread's event
// loop for the whole run, which starves vitest's own RPC heartbeat and can
// fail the run with "Timeout calling onTaskUpdate" even when tsc itself
// finishes fine within TSC_TIMEOUT_MS — the heartbeat can't get scheduled
// while the thread it runs on is blocked, regardless of how fast tsc is.
function runTsc(): Promise<TscResult> {
  // `process.execPath` + tsc's own entry point rather than `npx`: no network,
  // no PATH assumptions, and it works from any cwd vitest chooses.
  const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsc, "-p", join(repoRoot, "test/types/tsconfig.json")], {
      cwd: repoRoot,
      timeout: TSC_TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => resolve({ stdout, stderr, status: null, signal: null, error }));
    child.on("close", (status, signal) => resolve({ stdout, stderr, status, signal }));
  });
}

describe("the circuit breaker cannot be omitted (compile-time)", () => {
  it(
    "type-checks test/types/breaker-required.fixture.ts with every @ts-expect-error USED",
    async () => {
      const r = await runTsc();

      // Infra failure (spawn error, or killed by the timeout above) names itself
      // here rather than surfacing as an opaque "" vs error-text mismatch below.
      expect(r.error, `tsc failed to run/complete: ${r.error}`).toBeUndefined();
      expect(r.signal, `tsc was killed by signal ${r.signal} (likely the ${TSC_TIMEOUT_MS}ms spawn timeout)`).toBeNull();

      // Asserted on the OUTPUT first, so a failure names the offending line
      // rather than just "expected 2 to be 0". A surviving `@ts-expect-error`
      // means the corresponding breaker argument became optional again.
      expect(`${r.stdout}${r.stderr}`.trim()).toBe("");
      expect(r.status).toBe(0);
    },
    TSC_TIMEOUT_MS + 30_000,
  );
});
