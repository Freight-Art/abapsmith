/**
 * Pins the four diagnostic skills added by issue #92:
 * `abapsmith-debug-a-failing-run`, `abapsmith-run-tests-and-fix`,
 * `abapsmith-check-code-quality`, and `abapsmith-explore-a-package`.
 *
 * ## Why these four are pinned
 *
 * Issue #92 added them so a model has a named route from a symptom — "the
 * run dumped", "the test is red", "I do not know this package" — to the
 * right tool sequence, instead of re-deriving that sequence from scratch (or
 * worse, from a half-remembered guess) every time. A skill only does that
 * job if it is actually where the routing table says it is, actually named
 * what the routing table says it is named, and actually mentions the tools
 * it exists to explain. A skill that silently loses its frontmatter, gets
 * renamed, or drops out of `abapsmith-orient`'s routing table is invisible —
 * a model looking for "why did this dump" would never find it, and nothing
 * else in this suite would notice the gap.
 *
 * ## What this file does NOT do
 *
 * This is a structural/reachability check, not a content check. It does not
 * verify that the guidance INSIDE a skill is correct, current, or good
 * advice — only that the four skills exist, are well-formed (frontmatter
 * with the right `name` and a non-empty one-line `description`), mention
 * the tools they are about, and are reachable from `abapsmith-orient`'s
 * "Where to go next" table.
 *
 * It also deliberately does NOT duplicate the "every registered tool is
 * mentioned by some skill" property — that is already pinned, for every
 * skill in the directory (not just these four), by Check D in
 * `test/skills-tool-surface.test.ts`. Re-checking it here would just be a
 * slower, narrower copy of a guard that already exists.
 *
 * This suite is pure filesystem: it reads `SKILL.md` files as text and
 * hand-parses their frontmatter. It never starts an MCP server, never
 * touches `ConfigSchema`, and never talks to a network client — there is no
 * reason a structural skill-shape check needs any of that.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const skillsDir = join(repoRoot, "skills");

const DIAGNOSTIC_SKILLS = [
  "abapsmith-debug-a-failing-run",
  "abapsmith-run-tests-and-fix",
  "abapsmith-check-code-quality",
  "abapsmith-explore-a-package",
] as const;

interface Frontmatter {
  name?: string;
  description?: string;
}

/**
 * Hand-parses the leading `---` … `---` frontmatter block. No yaml
 * dependency exists in this repo, so this only understands the flat
 * `key: value` shape these skill files actually use — good enough for the
 * two keys this suite checks (`name`, `description`), and deliberately not
 * a general YAML parser.
 */
function parseFrontmatter(text: string): Frontmatter | undefined {
  if (!text.startsWith("---\n")) return undefined;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return undefined;
  const block = text.slice(4, end);
  const fm: Frontmatter = {};
  for (const line of block.split("\n")) {
    if (line.trim() === "") continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key === "name") fm.name = value;
    if (key === "description") fm.description = value;
  }
  return fm;
}

function readSkill(skillName: string): string {
  return readFileSync(join(skillsDir, skillName, "SKILL.md"), "utf8");
}

describe("diagnostic skills (issue #92): existence, frontmatter, tool mentions, orient routing", () => {
  describe.each(DIAGNOSTIC_SKILLS)("%s", (skillName) => {
    it("has a SKILL.md with well-formed frontmatter naming itself", () => {
      let text: string;
      try {
        text = readSkill(skillName);
      } catch (err) {
        throw new Error(`skills/${skillName}/SKILL.md does not exist or could not be read: ${String(err)}`);
      }

      expect(
        text.startsWith("---\n"),
        `skills/${skillName}/SKILL.md must open with a frontmatter block ('---') as the very first thing in the file`,
      ).toBe(true);

      const fm = parseFrontmatter(text);
      expect(fm, `skills/${skillName}/SKILL.md: frontmatter block is present but could not be parsed`).toBeDefined();
      if (fm === undefined) return;

      expect(
        fm.name,
        `skills/${skillName}/SKILL.md: frontmatter 'name' must equal the directory name exactly ("${skillName}")`,
      ).toBe(skillName);

      expect(
        fm.description,
        `skills/${skillName}/SKILL.md: frontmatter must have a non-empty 'description'`,
      ).toBeTruthy();
      if (fm.description !== undefined) {
        expect(
          fm.description.includes("\n"),
          `skills/${skillName}/SKILL.md: frontmatter 'description' must be a single line, got: ${JSON.stringify(fm.description)}`,
        ).toBe(false);
      }
    });
  });

  it("each skill mentions the tools it is about", () => {
    // Verified by reading each SKILL.md before writing this table: every name
    // below is actually present in its skill's text as of this writing. If a
    // skill is reworded and stops mentioning one of these, fix the skill's
    // prose (or this table, if the tool genuinely changed), not just the test.
    const toolMentions: Record<(typeof DIAGNOSTIC_SKILLS)[number], readonly string[]> = {
      "abapsmith-debug-a-failing-run": ["abap_dumps", "abap_debug"],
      "abapsmith-run-tests-and-fix": ["abap_test"],
      "abapsmith-check-code-quality": ["abap_atc", "abap_quick_fix"],
      "abapsmith-explore-a-package": ["abap_search", "abap_read"],
    };

    const offenders: string[] = [];
    for (const skillName of DIAGNOSTIC_SKILLS) {
      const text = readSkill(skillName);
      for (const toolName of toolMentions[skillName]) {
        if (!text.includes(toolName)) {
          offenders.push(`skills/${skillName}/SKILL.md: does not mention "${toolName}"`);
        }
      }
    }

    expect(
      offenders,
      "Each diagnostic skill exists to explain a specific tool (or pair of tools); a skill that " +
        "never names the tool it is about has stopped doing that job:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("abapsmith-orient routes to all four diagnostic skills", () => {
    const orientText = readSkill("abapsmith-orient");
    const missing = DIAGNOSTIC_SKILLS.filter((skillName) => !orientText.includes(skillName));

    expect(
      missing,
      "abapsmith-orient is the entry point a model reads before any task; every diagnostic skill " +
        "must be reachable from it (by name, e.g. in the 'Where to go next' table) or a model that " +
        "starts at orient has no way to discover it:\n" + missing.join(", "),
    ).toEqual([]);
  });

  it("every one of the four diagnostic skills mentions abap_read", () => {
    // abap_read is the one tool name registered on both the v1 and v2 tool
    // surfaces (see test/skills-tool-surface.test.ts's Checks B/C). A new
    // skill grounded only in names exclusive to one surface (e.g. only
    // abap_search, a v1-only name) fails Check C the moment it ships, because
    // it has no v2-recognized name anywhere in its text. Mentioning
    // abap_read is the cheap way for a skill to stay honest about both
    // surfaces without having to enumerate every v1/v2 pair by hand.
    const offenders = DIAGNOSTIC_SKILLS.filter((skillName) => !readSkill(skillName).includes("abap_read"));

    expect(
      offenders,
      "Diagnostic skill(s) never mention 'abap_read', the one tool name shared by both the v1 and " +
        "v2 tool surfaces — without it, a skill grounded only in surface-exclusive names risks " +
        "failing Check B or Check C of test/skills-tool-surface.test.ts:\n" + offenders.join(", "),
    ).toEqual([]);
  });
});
