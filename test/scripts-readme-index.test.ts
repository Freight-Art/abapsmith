/**
 * Guard: `scripts/README.md`'s index table must name every script under
 * `scripts/` (and vice versa). An index that can silently fall behind will —
 * 26 of the manual harnesses in `scripts/` once had no row
 * at all. This enumerates the real directory at runtime rather than
 * hardcoding a filename list, so the check itself can't drift the same way.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const scriptsDir = join(repoRoot, "scripts");
const readmePath = join(scriptsDir, "README.md");

/**
 * Top-level `scripts/*.mjs` and `scripts/*.sh` only — `readdirSync` here is
 * not recursive, so `scripts/lib/` (and any other subdirectory) is skipped
 * simply by never being descended into.
 */
function listScriptFiles(): string[] {
  return readdirSync(scriptsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && (e.name.endsWith(".mjs") || e.name.endsWith(".sh")))
    .map((e) => e.name)
    .sort();
}

/** Filenames the README's table indexes, matched the way rows write them: in backticks. */
function listIndexedNames(readme: string): Set<string> {
  const names = new Set<string>();
  for (const m of readme.matchAll(/`([\w.-]+\.(?:mjs|sh))`/g)) names.add(m[1]!);
  return names;
}

describe("scripts/README.md indexes every scripts/*.mjs and scripts/*.sh file", () => {
  const scripts = listScriptFiles();
  const readme = readFileSync(readmePath, "utf8");
  const indexed = listIndexedNames(readme);

  it("every script on disk has a README row", () => {
    const missing = scripts.filter((name) => !indexed.has(name));
    expect(
      missing,
      `scripts/README.md is missing a row for: ${missing.join(", ")}. ` +
        "Add a table row for each, with its Live? and Destructive? status.",
    ).toEqual([]);
  });

  it("every script the README names still exists on disk (converse drift)", () => {
    const onDisk = new Set(scripts);
    const stale = [...indexed].filter((name) => !onDisk.has(name)).sort();
    expect(
      stale,
      `scripts/README.md names a script that no longer exists in scripts/: ${stale.join(", ")}. ` +
        "Remove its row or the script was renamed/moved without updating the index.",
    ).toEqual([]);
  });

  it("sanity: scripts/ actually contains files (a guard that scans nothing is worse than no guard)", () => {
    expect(scripts.length).toBeGreaterThan(0);
  });
});
