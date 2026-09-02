/**
 * Guard: every captured CTS fixture under `test/fixtures/cts/` is exercised by
 * some test.
 *
 * `listCtsFixtureNames()` (`test/helpers/cts-fixtures.ts`) was written for
 * exactly this check — its doc comment says it "lets a test assert that every
 * captured fixture is exercised, rather than a new capture silently going
 * unused". It then sat with **zero callers**, and the failure mode it was
 * written to prevent duly happened: nine of the 43 fixtures were loaded by no
 * test at all by the time this file was added. This file is that missing
 * caller.
 *
 * The nine are listed below rather than deleted. They are real captured wire
 * from the CTS reconnaissance run, several are cited as evidence elsewhere
 * (see the per-entry notes), and re-capturing them costs a live A4H session.
 * `UNEXERCISED` is a ratchet: it may shrink, never grow. The
 * assertion is an equality, so it fails in both directions — a new capture
 * that no test loads fails here, and so does a listed fixture that a test
 * starts loading (delete its entry when that happens).
 *
 * Detection is deliberately crude: a fixture counts as exercised if its name
 * appears anywhere in any other test source. `loadCtsFixture` is called both
 * with inline literals (`test/transport-tools.test.ts`) and with names pulled
 * from `const` arrays (`test/transports-verify.test.ts:43`,
 * `test/transports-parse.test.ts:593`), so matching only on `loadCtsFixture("…")`
 * would under-count. This file scans itself out of the corpus (it loads no
 * fixture, and its own `UNEXERCISED` literal would otherwise mark every entry
 * as used) — the same self-exclusion `test/system-role-probe-guard.test.ts`
 * does.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { listCtsFixtureNames } from "./helpers/cts-fixtures.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SELF = "cts-fixture-coverage.test.ts";

/**
 * Captured fixtures no test loads today. Each entry says where the capture is
 * still cited, so a later reader can tell "unused" from "unusable".
 *
 * SHRINK THIS LIST. Do not add to it: a fixture worth capturing is a fixture
 * worth asserting against, and an entry here is a live-appliance round trip
 * whose evidence currently only exists as prose.
 */
const UNEXERCISED = [
  // Cited by `src/adt/write.ts` as the shape of a LOCK on a transportable
  // object.
  "lock-transportable-object",
  // Task creation + addUser. `test/transport-tools.test.ts` covers addUser
  // with a hand-built synthetic body instead (see that file's header: "no
  // captured wire fixture"), which is precisely the gap this capture fills.
  "task-create-adduser",
  // Request state after a release that aborted.
  "transport-details-after-aborted-release",
  // trInfo error messages.
  "transport-info-error-messages",
  "transport-info-transportable-new-object",
  "transport-reference",
  // setOwner. Same story as `task-create-adduser`: covered synthetically.
  "transport-setowner",
  "write-error-object-already-locked-in-fabricated-request",
] as const;

/** Every `.ts` under `test/`, except this file and anything under `fixtures/`. */
function testSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "fixtures" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) testSources(full, acc);
    else if (entry.endsWith(".ts") && entry !== SELF) acc.push(full);
  }
  return acc;
}

describe("test/fixtures/cts is fully exercised", () => {
  it("every captured cts fixture is loaded by some test, except the known-unexercised ones", () => {
    const corpus = testSources(TEST_DIR)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const unused = listCtsFixtureNames().filter((name) => !corpus.includes(name));
    expect(unused).toEqual([...UNEXERCISED].sort());
  });

  it("every name in UNEXERCISED is still a fixture that exists on disk", () => {
    // Keeps the ratchet honest in the other direction: a deleted or renamed
    // capture must not survive as a stale allow-list entry.
    const names = new Set(listCtsFixtureNames());
    expect(UNEXERCISED.filter((n) => !names.has(n))).toEqual([]);
  });
});
