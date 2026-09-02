/**
 * Guard: `test/fixtures/bopf/README.md` must name every `*.v4.xml` fixture
 * (and vice versa), and must keep recording the `03-after-put-item-node-and-
 * assoc.v4.xml` question and its resolution rather than silently dropping it
 * while the fixture stays. Enumerates the real
 * directory at runtime rather than a hardcoded list, so the check itself
 * can't drift the same way.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures", "bopf");
const readmePath = join(fixturesDir, "README.md");

function listFixtureFiles(): string[] {
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".v4.xml"))
    .map((e) => e.name)
    .sort();
}

/** Filenames the README's table indexes, matched the way rows write them: in backticks. */
function listIndexedNames(readme: string): Set<string> {
  const names = new Set<string>();
  for (const m of readme.matchAll(/`([\w.-]+\.v4\.xml)`/g)) names.add(m[1]!);
  return names;
}

describe("test/fixtures/bopf/README.md indexes every *.v4.xml fixture", () => {
  const fixtures = listFixtureFiles();
  const readme = readFileSync(readmePath, "utf8");
  const indexed = listIndexedNames(readme);

  it("every fixture on disk has a README row", () => {
    const missing = fixtures.filter((name) => !indexed.has(name));
    expect(
      missing,
      `test/fixtures/bopf/README.md is missing a row for: ${missing.join(", ")}. ` +
        "Add a table row naming its source and what it proves.",
    ).toEqual([]);
  });

  it("every fixture the README names still exists on disk (converse drift)", () => {
    const onDisk = new Set(fixtures);
    const stale = [...indexed].filter((name) => !onDisk.has(name)).sort();
    expect(
      stale,
      `test/fixtures/bopf/README.md names a fixture that no longer exists: ${stale.join(", ")}. ` +
        "Remove its row, or it was renamed/moved without updating the index.",
    ).toEqual([]);
  });

  it("sanity: test/fixtures/bopf/ actually contains fixtures (a guard that scans nothing is worse than no guard)", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it("the 03-after-put-item-node-and-assoc.v4.xml question and its resolution are still recorded", () => {
    expect(readme).toContain("03-after-put-item-node-and-assoc.v4.xml");
    expect(readme).toContain("Resolved: `03`'s `ITEM` ref slots");
    // Pins the substance of the answer, not just a status label — this must
    // keep matching the live section even if the collapsed
    // "Original investigation" details fold above it is later pruned.
    expect(
      readme,
      "README no longer records that a child node gets none of the auto-assigned DDIC ref slots while the root " +
        "gets all three — the finding that 03's ITEM refs came from its own PUT payload, not server " +
        "defaulting. Restore the finding, don't just relabel the section.",
    ).toMatch(/root-only,\s+never\s+child/);
    expect(
      readme,
      "README no longer records that 03's ITEM ref slots came from its own PUT payload rather than server-side " +
        "auto-assignment — restore the finding, don't just relabel the section.",
    ).toMatch(/came\s+from\s+its\s+own\s+PUT\s+payload/);
  });
});
