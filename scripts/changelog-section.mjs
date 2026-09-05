#!/usr/bin/env node
// Extracts one version's section body from CHANGELOG.md.
// Called by `.github/workflows/release.yml` to build the GitHub release notes.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Body of the `## [version]` section (anything may follow on the heading
 * line, e.g. a date), up to the next `## ` heading or end of file. Returns
 * null when no such heading exists.
 * @param {string} markdown
 * @param {string} version
 * @returns {string | null}
 */
export function changelogSection(markdown, version) {
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\].*$`, "m");
  const start = markdown.match(heading);
  if (start === null) return null;
  const bodyStart = start.index + start[0].length;
  const rest = markdown.slice(bodyStart);
  const next = rest.match(/^## .*$/m);
  const body = next === null ? rest : rest.slice(0, next.index);
  return body.trim();
}

function main() {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: node scripts/changelog-section.mjs <version>");
    process.exit(1);
  }
  const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
  const section = changelogSection(changelog, version);
  if (section === null) {
    console.error(`changelog-section: no "## [${version}]" section found in CHANGELOG.md`);
    process.exit(1);
  }
  // Refuse an empty section rather than shipping it as empty release notes.
  if (section === "") {
    console.error(`changelog-section: "## [${version}]" section exists but has no entries`);
    process.exit(1);
  }
  console.log(section);
}

const isEntryPoint =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isEntryPoint) main();
