/**
 * Guard: .github/workflows/release.yml holds `contents: write` and runs on
 * every push to main, so a typo'd script path or a floating/third-party
 * action ref would only surface there. No YAML parser is in node_modules
 * (no `yaml`, no `js-yaml`), so this reads the file as text and checks it
 * with targeted regexes instead of adding a dependency.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");

describe(".github/workflows/release.yml", () => {
  it("invokes only node scripts that exist on disk", () => {
    const matches = [...workflow.matchAll(/node\s+(scripts\/[\w./-]+\.mjs)/g)].map((m) => m[1]!);
    expect(matches.length, "the scan found no `node scripts/*.mjs` invocations to check").toBeGreaterThan(0);
    for (const scriptPath of matches) {
      expect(
        existsSync(join(repoRoot, scriptPath)),
        `${scriptPath} does not exist in the repo; the release workflow would only fail on main`,
      ).toBe(true);
    }
  });

  it("uses only first-party actions/* actions pinned to an explicit version", () => {
    const matches = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
    expect(matches.length, "the scan found no `uses:` steps to check").toBeGreaterThan(0);
    for (const ref of matches) {
      expect(
        ref.startsWith("actions/"),
        `${ref} is not a first-party actions/* action; a third-party action gets outside-party ` +
          "write access to this repo's releases, since the workflow holds contents: write",
      ).toBe(true);
      const [, version] = ref.split("@");
      expect(
        version && !["main", "master", "latest", ""].includes(version),
        `${ref} is not pinned to an explicit version; a floating ref gets outside-party write ` +
          "access to this repo's releases, since the workflow holds contents: write",
      ).toBe(true);
    }
  });

  it("grants no more than contents: write", () => {
    expect(workflow, "the permissions block must grant contents: write").toMatch(
      /permissions:\s*\n\s*contents:\s*write/,
    );
    expect(workflow, "write-all grants far more than this workflow needs").not.toMatch(/permissions:\s*write-all/);
    expect(workflow, "an id-token grant is not needed by this workflow").not.toMatch(/id-token:\s*write/);
    expect(workflow, "a packages grant is not needed by this workflow").not.toMatch(/packages:\s*write/);
    expect(workflow, "an actions grant is not needed by this workflow").not.toMatch(/actions:\s*write/);
  });
});
