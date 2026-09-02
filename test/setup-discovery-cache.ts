/**
 * Global test isolation for the process-lifetime shared discovery inventory
 * cache (`src/adt/discovery-cache.ts`).
 *
 * That cache is deliberately process-scoped and keyed only on
 * `(url, resolved client, user)` — see that module's doc for why. Production
 * code relies on exactly that: one real system behind one identity, for the
 * life of one real process.
 *
 * Test files routinely reuse the SAME literal `(url, client, user)` fixture
 * identity (e.g. `http://sap.invalid:50000` / `001` / `DEVELOPER`) across many
 * unrelated `it()`s, and some of those deliberately answer `/discovery`
 * differently from one test to the next to exercise a different tri-state
 * (loaded/empty/failed) or a different capability set — i.e. within the test
 * suite that one identity stands in for several different *simulated*
 * systems, not one real one. Without a reset, the shared cache would let a
 * `"loaded"` inventory from one test silently leak into a later test that
 * expects its own `/discovery` route to be consulted, which is a test-harness
 * artifact, not anything this cache needs to tolerate in production. Clearing
 * it before every test removes that cross-test coupling without touching the
 * cache's actual (production) contract.
 */
import { beforeEach } from "vitest";
import { clearSharedDiscoveryCacheForTests } from "../src/adt/discovery-cache.js";

beforeEach(() => {
  clearSharedDiscoveryCacheForTests();
});
