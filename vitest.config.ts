import { defineConfig, configDefaults } from "vitest/config";

// Live SAP integration suites. They hit a real, shared A4H appliance with
// only 7 dialog work processes, and integration-debug can leave a suspended
// debuggee that wedges the system. They must NEVER be collected by a bare
// `npm test` / `vitest run` — only by the explicitly-named `npm run test:live`
// (VITEST_LIVE=1 below), so running them is always a deliberate act.
const LIVE_INTEGRATION_TESTS = [
  "test/integration.test.ts",
  "test/integration-debug.test.ts",
  "test/integration-undo.test.ts",
  "test/integration-fpm-lock.test.ts",
  // Acceptance case: writes an ABAP Unit test class into a real class's
  // CCAU include, activates, reads back, runs it, cleans up. Listed here so
  // `VITEST_LIVE=1` COLLECTS it — the suite carries its own independent gate
  // (VITEST_LIVE + ABAP_URL + write access configured, see
  // test/helpers/live-write-gate.ts) on purpose, so that neither this
  // list nor that gate alone can put it on the wire.
  "test/integration-class-includes.test.ts",
  // Invariant: a lock handle abap_write hands out must still be valid
  // when abap_write uses it. Same independent-gate convention as the CCAU
  // suite above.
  "test/integration-lock-handle.test.ts",
];

const isLive = process.env.VITEST_LIVE === "1";

export default defineConfig({
  test: {
    include: isLive
      ? LIVE_INTEGRATION_TESTS
      : ["test/**/*.test.ts"],
    // Config-level exclude (not a CLI flag) so it can't be forgotten, and it
    // still applies even if someone names an excluded file explicitly on the
    // command line — see LIVE_INTEGRATION_TESTS above for the live path.
    exclude: isLive
      ? configDefaults.exclude
      : [...configDefaults.exclude, ...LIVE_INTEGRATION_TESTS],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Resets the process-lifetime shared discovery-inventory cache
    // (src/adt/discovery-cache.ts) before every test — see
    // test/setup-discovery-cache.ts for why cross-test leakage of that cache
    // is a harness artifact this suite needs to remove, not something
    // production needs to tolerate.
    setupFiles: ["test/setup-discovery-cache.ts"],
    // Integration tests hit a real SAP system; keep them serial so we never fan
    // out parallel logon attempts. Concurrent failed logons burn through
    // `login/fails_to_user_lock` and lock the technical user.
    fileParallelism: false,
  },
});
