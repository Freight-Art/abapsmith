/**
 * Cassette lint — part of the architecture refactor.
 *
 * This is the implementation behind `npm run check:cassettes`
 * (`package.json`). Three independent checks:
 *
 *  1. STALENESS (hard fail) — every committed cassette must be within
 *     `STALENESS_WINDOW_DAYS` of today, per `registry.ts`'s `isStale()`.
 *  2. REGISTRY INTEGRITY / dead-cassette detection (hard fail) — the set of
 *     `*.cassette.json` files actually on disk must exactly match what
 *     `loadAllCassettes()` returned, AND every cassette id must be wired
 *     into `cassette-replay.test.ts`.
 *  3. LEGACY-FAKE COVERAGE (informational only, non-blocking) — how much of
 *     `test/helpers/fake-adt.ts` / `test/helpers/system-role-fake.ts` is
 *     cassette-derived today. See the block below for why this reports
 *     rather than gates.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isStale, loadAllCassettes, STALENESS_WINDOW_DAYS } from "./registry.js";
import type { Cassette } from "./schema.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const CASSETTE_FILE_SUFFIX = ".cassette.json";

/**
 * A SEPARATE, independently-authored walk of `test/cassettes/` — deliberately
 * NOT importing `registry.ts`'s own `collectCassetteFiles`. The entire point
 * of this check is to catch a bug IN that walker (e.g. it silently skips a
 * subdirectory, or a future refactor narrows its glob) by comparing its
 * output against a second implementation that could only agree by
 * coincidence if both were correct.
 */
function walkCassetteFilesIndependently(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      found.push(...walkCassetteFilesIndependently(full));
    } else if (stat.isFile() && entry.endsWith(CASSETTE_FILE_SUFFIX)) {
      found.push(full);
    }
  }
  return found;
}

function slugFromFile(file: string): string {
  const base = basename(file);
  return base.slice(0, base.length - CASSETTE_FILE_SUFFIX.length);
}

const cassettes = loadAllCassettes();

// =============================================================================
// 1. Staleness (hard fail)
// =============================================================================

describe("cassette-lint: staleness (hard fail)", () => {
  it(`every committed cassette is within the ${STALENESS_WINDOW_DAYS}-day staleness window`, () => {
    const stale = cassettes.filter((c) => isStale(c));
    expect(
      stale.map((c) => c.id),
      stale.length > 0
        ? `stale cassette(s) need a fresh live-A4H re-capture: ${stale.map((c) => c.id).join(", ")}`
        : undefined,
    ).toEqual([]);
  });

  /**
   * Proves the staleness MECHANISM itself works — not just that today's real
   * cassettes happen to pass. Both objects below are SYNTHETIC, constructed
   * inline for this one test only: neither is a real capture, neither is
   * written to disk, and neither is ever seen by `loadAllCassettes()`. `now`
   * is passed explicitly (per `isStale`'s own contract — it takes `now` as a
   * parameter precisely so callers do not have to depend on the real system
   * clock), so this test is deterministic regardless of when it runs.
   */
  it("isStale() correctly flags an old synthetic cassette and clears a fresh one (synthetic, test-only — not a real capture)", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");

    // SYNTHETIC — fabricated for this unit test only. Not a real HTTP
    // exchange, not sourced from any capture, never written to disk.
    const syntheticFixedFields = {
      appliance: { sid: "A4H", client: "001" },
      source: {
        type: "live-capture-raw" as const,
        citation: "synthetic/test-only — fabricated for cassette-lint.test.ts, not a real capture",
        notes: "Synthetic object literal constructed inline to unit-test isStale(). Never written to disk.",
      },
      request: { method: "GET" as const, path: "/synthetic/not-a-real-endpoint", headers: {}, body: null },
      response: { status: 200, headers: {}, body: null },
    };

    // 152 days before `now` — well past the 90-day window.
    const oldSyntheticCassette: Cassette = {
      id: "synthetic-old-cassette-test-only",
      recordedAt: "2026-01-01T00:00:00.000Z",
      ...syntheticFixedFields,
    };

    // 5 days before `now` — comfortably inside the 90-day window.
    const freshSyntheticCassette: Cassette = {
      id: "synthetic-fresh-cassette-test-only",
      recordedAt: "2026-05-27T00:00:00.000Z",
      ...syntheticFixedFields,
    };

    expect(isStale(oldSyntheticCassette, now)).toBe(true);
    expect(isStale(freshSyntheticCassette, now)).toBe(false);
  });
});

// =============================================================================
// 2. Registry integrity / dead-cassette detection (hard fail)
// =============================================================================

describe("cassette-lint: registry integrity (dead-cassette detection, hard fail)", () => {
  it("an independent disk walk finds exactly the same cassette files/ids loadAllCassettes() returned", () => {
    const filesOnDisk = walkCassetteFilesIndependently(THIS_DIR);
    const idsOnDisk = filesOnDisk.map(slugFromFile).sort();
    const idsFromRegistry = cassettes.map((c) => c.id).sort();

    expect(filesOnDisk.length, "independent walk found a different FILE COUNT than loadAllCassettes() loaded").toBe(
      cassettes.length,
    );
    expect(idsOnDisk, "independent walk's id set differs from loadAllCassettes()'s id set").toEqual(idsFromRegistry);
  });

  /**
   * `cassette-replay.test.ts` replays every cassette via a generic
   * `it.each(cassettes)` loop, so a NEW cassette file is covered
   * automatically with no per-cassette edit required there. That loop's
   * genericity means cassette ids do not appear as literal strings in that
   * file's source by themselves — which is exactly why that file also
   * maintains an explicit `COVERED_CASSETTE_IDS` manifest (checked there
   * against `loadAllCassettes()` for self-consistency) purely so a literal
   * id string exists for THIS check to find. If a cassette id is missing
   * from that file's source text entirely, either the manifest was never
   * updated for a newly added cassette, or replay coverage genuinely
   * regressed — both are real defects this check exists to catch.
   */
  it("every cassette id is wired into cassette-replay.test.ts (no orphaned cassette)", () => {
    const replaySourcePath = join(THIS_DIR, "cassette-replay.test.ts");
    const replaySource = readFileSync(replaySourcePath, "utf8");

    const orphaned = cassettes.filter((cassette) => !replaySource.includes(cassette.id));
    expect(
      orphaned.map((c) => c.id),
      orphaned.length > 0
        ? `cassette id(s) not found anywhere in ${replaySourcePath}'s source text — added to disk but never wired into replay coverage: ${orphaned
            .map((c) => c.id)
            .join(", ")}`
        : undefined,
    ).toEqual([]);
  });
});

// =============================================================================
// 3. Cassette identity — the loader actually surfaces `appliance`, not just
//    validates it (hard fail)
// =============================================================================

describe("cassette-lint: cassette identity", () => {
  it("loadAllCassettes() surfaces the recorded appliance identity for a real cassette, not just schema-validates it", () => {
    const file = join(THIS_DIR, "classes", "class-lock-post.cassette.json");
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { appliance: { sid: string; client: string } };

    const loaded = cassettes.find((c) => c.id === "class-lock-post");
    expect(loaded).toBeDefined();
    expect(loaded!.appliance.sid).toBe(onDisk.appliance.sid);
    expect(loaded!.appliance.client).toBe(onDisk.appliance.client);
    expect(loaded!.appliance.sid).toBe("A4H");
    expect(loaded!.appliance.client).toBe("001");
  });
});

// =============================================================================
// 4. Legacy-fake coverage report (informational only, NON-blocking)
// =============================================================================

describe("cassette-lint: legacy fake coverage (informational only, non-blocking)", () => {
  /**
   * WHY THIS BLOCK REPORTS INSTEAD OF GATING
   *
   * `test/helpers/fake-adt.ts` is ~2,300 lines of hand-authored, individually
   * live-verified route/response behaviour (see that file's own header for
   * "confirmed vs reconstructed" provenance on each piece). Migrating all of
   * it to be cassette-generated is the eventual destination of this
   * architecture work, but it is explicitly OUT OF SCOPE for now — the job
   * right now is to prove the generation MECHANISM works end to end for the
   * cassettes that exist today (see `generate-fake-routes.ts` and
   * `cassette-replay.test.ts`), not to execute a migration of pre-existing,
   * already-trusted code. Failing `check:cassettes` over a coverage number
   * that is known to be 0% today, on every commit, for the entire duration of
   * that future migration, would be pure noise that trains people to ignore
   * the gate. This block exists for VISIBILITY — so whoever picks up the
   * migration next has a live number to work against — not to block anything.
   *
   * HEURISTIC USED (approximate, documented rather than hidden):
   *  - `fake-adt.ts`: count of definitions typed `FakeRoute` — the exact
   *    shape `generate-fake-routes.ts` also produces (`: FakeRoute {` /
   *    `: FakeRoute =`). This undercounts the file's TOTAL hardcoded
   *    behaviour (the builtin dispatcher's `routeLock`/`routeUnlock`/
   *    `routePut`/`routeBuiltin*` methods hand-roll responses without ever
   *    naming the `FakeRoute` type), but it is the one metric that is
   *    directly comparable to what deliverable 1 actually generates.
   *  - `system-role-fake.ts`: count of `httpResponse(...)` call sites — one
   *    per hardcoded `SystemRoleAnswer` variant.
   */
  it("reports how many legacy fake-adt.ts / system-role-fake.ts definitions are cassette-derived today (does not fail the build)", () => {
    const fakeAdtPath = join(THIS_DIR, "..", "helpers", "fake-adt.ts");
    const systemRoleFakePath = join(THIS_DIR, "..", "helpers", "system-role-fake.ts");
    const fakeAdtSource = readFileSync(fakeAdtPath, "utf8");
    const systemRoleFakeSource = readFileSync(systemRoleFakePath, "utf8");

    const fakeAdtRouteDefinitionCount = (fakeAdtSource.match(/:\s*FakeRoute\b/g) ?? []).length;
    // None of fake-adt.ts's own `FakeRoute`-typed definitions are generated
    // from a cassette — that only happens when a CALLER passes
    // `generateFakeRoutesFromCassettes(...)` into `FakeAdtOptions.routes`,
    // which is code outside fake-adt.ts entirely (by design — see
    // generate-fake-routes.ts's header on why fake-adt.ts is untouched).
    const fakeAdtCassetteDerivedCount = 0;

    const systemRoleResponseDefinitionCount = (systemRoleFakeSource.match(/httpResponse\(/g) ?? []).length;
    const systemRoleCassetteDerivedCount = 0;

    // eslint-disable-next-line no-console -- deliberate: this IS the report.
    console.info(
      `[cassette-lint] legacy fake coverage: ${fakeAdtCassetteDerivedCount} of ${fakeAdtRouteDefinitionCount} FakeRoute-shaped definitions in fake-adt.ts are cassette-derived`,
    );
    // eslint-disable-next-line no-console -- deliberate: this IS the report.
    console.info(
      `[cassette-lint] legacy fake coverage: ${systemRoleCassetteDerivedCount} of ${systemRoleResponseDefinitionCount} hardcoded response definitions in system-role-fake.ts are cassette-derived`,
    );

    // No assertion on the coverage numbers themselves — see the block
    // comment above. This only confirms both files were actually readable,
    // so a broken path fails loudly instead of the report silently logging
    // "0 of 0" forever.
    expect(fakeAdtSource.length).toBeGreaterThan(0);
    expect(systemRoleFakeSource.length).toBeGreaterThan(0);
  });
});
