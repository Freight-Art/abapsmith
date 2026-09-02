/**
 * COMPILE-TIME REGRESSION TEST for `ServerPackage`'s brand — not a runtime
 * one, and the distinction matters (see `test/breaker-required-types.test.ts`,
 * whose mechanism this mirrors exactly).
 *
 * `src/adt/resolved-package.ts`'s whole point is that a caller cannot
 * fabricate a `ServerPackage` — a compile-time property enforced by a
 * module-private `Symbol`, never a runtime check on its own. There is no
 * runtime behaviour to assert for "a bare string cannot be branded"; what
 * changed is that the WRONG code no longer compiles. A law nobody can run
 * as a `expect(...).toThrow()` is still a law worth locking, because the
 * day someone exports the symbol, or loosens `ServerPackage` back to a
 * `{ name, source: "server" }`-style string discriminant, every other test
 * in this suite keeps passing while the safety property silently evaporates.
 *
 * So the assertion is literally "does `tsc` reject the negative cases in
 * `test/types/resolved-package.fixture.ts`", via its own project
 * (`test/types/tsconfig.resolved-package.json` — a sibling of
 * `test/types/tsconfig.json`, not an extension of it: the breaker fixture
 * and this one must not share a failure domain, see that config's own
 * comment) run the same way `test/breaker-required-types.test.ts` already
 * proved out: `process.execPath` + `node_modules/typescript/bin/tsc`
 * directly (no `npx`, no PATH assumptions), async `spawn` rather than
 * `spawnSync` (a synchronous child process freezes this worker's event loop
 * and can starve vitest's own RPC heartbeat).
 *
 * PRE-FIX (brand weakened to an exported symbol / plain string field), this
 * fails with one `TS2578: Unused '@ts-expect-error' directive` per
 * newly-legal construction in the fixture — i.e. the compiler cheerfully
 * accepts every forgery.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Same hang-guard budget as test/breaker-required-types.test.ts, for the same
// reason: a bound set with headroom well beyond observed worst case, not a
// tuned-tight signal.
const TSC_TIMEOUT_MS = 240_000;

interface TscResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

function runTsc(): Promise<TscResult> {
  const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsc, "-p", join(repoRoot, "test/types/tsconfig.resolved-package.json")], {
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

describe("the ServerPackage brand cannot be forged (compile-time)", () => {
  it(
    "type-checks test/types/resolved-package.fixture.ts with every @ts-expect-error USED",
    async () => {
      const r = await runTsc();

      expect(r.error, `tsc failed to run/complete: ${r.error}`).toBeUndefined();
      expect(r.signal, `tsc was killed by signal ${r.signal} (likely the ${TSC_TIMEOUT_MS}ms spawn timeout)`).toBeNull();

      // Asserted on the OUTPUT first, so a failure names the offending line
      // rather than just "expected 2 to be 0". A surviving `@ts-expect-error`
      // means the corresponding forgery became legal again.
      expect(`${r.stdout}${r.stderr}`.trim()).toBe("");
      expect(r.status).toBe(0);
    },
    TSC_TIMEOUT_MS + 30_000,
  );
});
