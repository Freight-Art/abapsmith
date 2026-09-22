/**
 * Pins `abapsmith-orient/SKILL.md` as a short ROUTER (issue #158): the
 * per-area content that used to live there was moved into the area skills
 * it routes to, and the writable-type capability table moved into
 * `skills/abapsmith-create-an-object/writable-types.md`. A router that
 * silently regrows past its budget, or that stops naming a skill it should
 * route to, defeats the point of the split — this is a pure filesystem
 * check, same style as `test/skills-diagnostic-coverage.test.ts`.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const skillsDir = join(repoRoot, "skills");
const orientPath = join(skillsDir, "abapsmith-orient", "SKILL.md");

const MAX_BYTES = 6144;

function orientSkillDirs(): string[] {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "abapsmith-orient")
    .filter((e) => existsSync(join(skillsDir, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

describe("abapsmith-orient is a short router", () => {
  it(`is under ${MAX_BYTES} bytes`, () => {
    const size = Buffer.byteLength(readFileSync(orientPath, "utf8"), "utf8");
    expect(
      size,
      `skills/abapsmith-orient/SKILL.md is ${size} bytes, over the ${MAX_BYTES}-byte router budget — ` +
        "move detail out to the area skill it belongs to instead of growing this file.",
    ).toBeLessThan(MAX_BYTES);
  });

  it("names every other skill directory under skills/", () => {
    const text = readFileSync(orientPath, "utf8");
    const missing = orientSkillDirs().filter((name) => !text.includes(name));
    expect(
      missing,
      "abapsmith-orient is the entry point a model reads before any task; every skill must be " +
        "reachable from it by name (e.g. in the 'Where to go next' table) or a model that starts " +
        `at orient has no way to discover it:\n${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("points to the writable-types capability table", () => {
    const text = readFileSync(orientPath, "utf8");
    expect(text).toContain("skills/abapsmith-create-an-object/writable-types.md");
  });
});
