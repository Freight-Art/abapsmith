/**
 * Regression coverage for `scripts/changelog-section.mjs`, the extractor the
 * release workflow uses to build GitHub release notes from CHANGELOG.md.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { changelogSection } from "../scripts/changelog-section.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const FIXTURE = `# Changelog

## [Unreleased]

### Added

- Unreleased feature one.

## [0.3.1] - 2026-09-05

### Added

- Middle bullet one.
- Middle bullet two.

### Fixed

- A fix in the middle section.

## [0.3.0]

### Added

- Oldest bullet.
`;

const LAST_SECTION_FIXTURE = `# Changelog

## [0.2.0]

### Added

- Newer bullet.

## [0.1.0]

### Added

- Trailing bullet one.
- Trailing bullet two.

`;

describe("scripts/changelog-section.mjs", () => {
  it("extracts a middle section and stops at the next ## heading", () => {
    const body = changelogSection(FIXTURE, "0.3.1")!;
    expect(body).toContain("Middle bullet one.");
    expect(body).toContain("Middle bullet two.");
    expect(body).toContain("A fix in the middle section.");
    expect(body).not.toContain("Oldest bullet.");
    expect(body).not.toContain("Unreleased feature one.");
  });

  it("returns null when the version has no section", () => {
    expect(changelogSection(FIXTURE, "9.9.9")).toBeNull();
  });

  it("matches the version literally, not as a regex (a dot must not act as wildcard)", () => {
    expect(changelogSection(FIXTURE, "0x3y1")).toBeNull();
  });

  it("runs to end of file when the section is the last one, and trims the result", () => {
    const body = changelogSection(LAST_SECTION_FIXTURE, "0.1.0")!;
    expect(body).toContain("Trailing bullet one.");
    expect(body).toContain("Trailing bullet two.");
    expect(body.startsWith("\n")).toBe(false);
    expect(body.endsWith("\n")).toBe(false);
  });

  it("matches a dated heading by version alone and leaves the heading line out of the body", () => {
    const body = changelogSection(FIXTURE, "0.3.1")!;
    expect(body).not.toContain("2026-09-05");
    expect(body).not.toContain("## [0.3.1]");
    expect(body.startsWith("### Added")).toBe(true);
  });

  it("keeps a ### subheading inside the section; only a ## heading terminates it", () => {
    const body = changelogSection(FIXTURE, "0.3.1")!;
    expect(body).toContain("### Added");
    expect(body).toContain("### Fixed");
  });

  it("trims leading and trailing blank lines from the returned body", () => {
    const padded = `# Changelog\n\n## [1.0.0]\n\n\n- one bullet\n\n\n## [0.9.0]\n\n- older\n`;
    const body = changelogSection(padded, "1.0.0")!;
    expect(body).toBe("- one bullet");
  });

  it("the real repo CHANGELOG.md is parseable, and reports null for a version that cannot exist", () => {
    const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
    expect(changelogSection(changelog, "0.0.0-does-not-exist")).toBeNull();
  });
});
